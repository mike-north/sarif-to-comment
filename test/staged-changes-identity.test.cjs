'use strict';

/**
 * Regression tests: extraction reads the immutable objects its inputs name.
 *
 * The reviewed commit, its trees and blobs, and the index's staged blobs are
 * identified by object id. Git replacement refs (`git replace`) make ordinary
 * Git reads return other content under those ids, and a corrupted object
 * store can do the same. Extraction must either read the actual named
 * objects or fail honestly; it must never report success with substituted
 * content attributed to the requested source (contract §4.1, R2).
 *
 * Every expectation is hand-authored from the fixture bytes.
 *
 * @see https://git-scm.com/docs/git-replace
 * @see https://git-scm.com/docs/git#Documentation/git.txt---no-replace-objects
 * @see https://git-scm.com/book/en/v2/Git-Internals-Git-Objects
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { addStagedChangesToSarif } = require('../dist/staged-changes.cjs');
const {
  corruptLooseObject,
  createFixtureRepo,
  objectAt,
  removeFixtureRepo,
  replaceObject,
} = require('./fixtures/staged-changes/git-fixture.mts');
const { applyReplacements } = require('./fixtures/staged-changes/apply-oracle.mts');

const REPOSITORY = { owner: 'acme', repo: 'widgets' };
const REVIEWED = 'original one\noriginal two\n';
const STAGED = 'corrected one\noriginal two\n';
const DECOY = 'DECOY replacement content\n';

const repos = [];
test.after(() => repos.forEach(removeFixtureRepo));

/** Reviewed `dir/a.txt` edited in the index; `other.txt` unchanged. */
function editFixture() {
  const repo = createFixtureRepo({
    reviewed: { 'dir/a.txt': REVIEWED, 'other.txt': 'other\n' },
    staged: { 'dir/a.txt': STAGED, 'other.txt': 'other\n' },
    workTree: { 'dir/a.txt': 'UNSTAGED\n' },
  });
  repos.push(repo);
  return repo;
}

function extract(repo) {
  return addStagedChangesToSarif({
    sarif: { version: '2.1.0', runs: [{ tool: { driver: { name: 'probe' } }, results: [] }] },
    worktree: repo.dir,
    reviewedCommit: repo.reviewedCommit,
    repository: REPOSITORY,
  });
}

/**
 * The one exact replacement the actual objects imply: line 1 of the reviewed
 * file becomes `corrected one`, carried by a neutral result.
 */
function assertActualEdit(outcome) {
  assert.equal(outcome.status, 'added', JSON.stringify(outcome.problems));
  assert.deepEqual(outcome.receipt.changes, [
    { path: 'dir/a.txt', operation: 'edit', replacements: [{ startLine: 1, endLine: 1, associated: [], explainedBy: 'neutral' }] },
  ]);
  const [result] = outcome.sarif.runs[1].results;
  const [replacement] = result.fixes[0].artifactChanges[0].replacements;
  assert.deepEqual(replacement, {
    deletedRegion: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 },
    insertedContent: { text: 'corrected one\n' },
  });
  const edited = applyReplacements(REVIEWED, [{ deletedRegion: replacement.deletedRegion, insertedText: 'corrected one\n' }], 'utf16CodeUnits');
  assert.equal(edited, STAGED, 'the extracted edit reproduces the actual staged bytes');
  const serialized = JSON.stringify(outcome.sarif);
  assert.ok(!serialized.includes('DECOY'), 'no replacement content appears');
  assert.ok(!serialized.includes('UNSTAGED'), 'no working-tree content appears');
}

test('control: without replacement refs the actual edit is extracted', async () => {
  assertActualEdit(await extract(editFixture()));
});

test('a replacement ref on the reviewed blob does not hide the edit (lead reproduction)', async () => {
  const repo = editFixture();
  const reviewedBlob = objectAt(repo, repo.reviewedCommit, 'dir/a.txt');
  const stagedBlob = repo.text(['rev-parse', ':dir/a.txt']);
  replaceObject(repo, reviewedBlob, stagedBlob);
  assertActualEdit(await extract(repo));
});

test('a replacement ref on the staged blob does not substitute proposed content', async () => {
  const repo = editFixture();
  const stagedBlob = repo.text(['rev-parse', ':dir/a.txt']);
  const decoy = repo.text(['hash-object', '-w', '--no-filters', '--stdin'], DECOY);
  replaceObject(repo, stagedBlob, decoy);
  assertActualEdit(await extract(repo));
});

test('a replacement ref on the reviewed commit does not swap the reviewed tree', async () => {
  const repo = editFixture();
  const stagedTree = repo.text(['write-tree']);
  const impostor = repo.text(['commit-tree', stagedTree, '-m', 'impostor']);
  replaceObject(repo, repo.reviewedCommit, impostor);
  assertActualEdit(await extract(repo));
});

test('a replacement ref on a reviewed subtree does not swap its entries', async () => {
  const repo = editFixture();
  const stagedDir = repo.text(['rev-parse', `${repo.text(['write-tree'])}:dir`]);
  replaceObject(repo, objectAt(repo, repo.reviewedCommit, 'dir'), stagedDir);
  assertActualEdit(await extract(repo));
});

test('a replacement ref on the reviewed root tree does not swap it', async () => {
  const repo = editFixture();
  const reviewedRoot = repo.text(['rev-parse', `${repo.reviewedCommit}^{tree}`]);
  replaceObject(repo, reviewedRoot, repo.text(['write-tree']));
  assertActualEdit(await extract(repo));
});

test('a replacement ref on a created file\'s staged blob does not substitute its proposed content', async () => {
  const repo = createFixtureRepo({ reviewed: { 'keep.txt': 'k\n' }, staged: { 'keep.txt': 'k\n', 'new.md': 'real page\n' } });
  repos.push(repo);
  const decoy = repo.text(['hash-object', '-w', '--no-filters', '--stdin'], DECOY);
  replaceObject(repo, repo.text(['rev-parse', ':new.md']), decoy);
  const outcome = await extract(repo);
  assert.equal(outcome.status, 'added');
  assert.deepEqual(outcome.sarif.runs[1].artifacts, [
    { location: { uri: 'new.md' }, contents: { text: 'real page\n' }, encoding: 'utf-8' },
  ]);
});

test('a corrupted reviewed blob is an honest failure, never success with other bytes', async () => {
  const repo = editFixture();
  const reviewedBlob = objectAt(repo, repo.reviewedCommit, 'dir/a.txt');
  corruptLooseObject(repo, reviewedBlob, 'blob', STAGED);
  await assert.rejects(extract(repo), (err) => {
    assert.ok(!(err instanceof TypeError));
    assert.match(err.message, new RegExp(reviewedBlob));
    return true;
  });
});

test('a corrupted staged blob is an honest failure', async () => {
  const repo = editFixture();
  const stagedBlob = repo.text(['rev-parse', ':dir/a.txt']);
  corruptLooseObject(repo, stagedBlob, 'blob', DECOY);
  await assert.rejects(extract(repo), new RegExp(stagedBlob));
});

test('a corrupted reviewed tree is an honest failure', async () => {
  const repo = editFixture();
  const reviewedDir = objectAt(repo, repo.reviewedCommit, 'dir');
  const otherTree = repo.text(['rev-parse', `${repo.text(['write-tree'])}:dir`]);
  const otherBytes = repo.git(['cat-file', 'tree', otherTree]);
  corruptLooseObject(repo, reviewedDir, 'tree', otherBytes);
  await assert.rejects(extract(repo), new RegExp(reviewedDir));
});

test('a corrupted reviewed commit is an honest failure', async () => {
  const repo = editFixture();
  const impostor = repo.git(['cat-file', 'commit', repo.reviewedCommit]).toString('utf8').replace('reviewed', 'tampered');
  corruptLooseObject(repo, repo.reviewedCommit, 'commit', impostor);
  await assert.rejects(extract(repo), new RegExp(repo.reviewedCommit));
});

test('a tree entry naming a blob as a directory is an honest failure (added after the repair)', async () => {
  const repo = editFixture();
  const blob = repo.text(['hash-object', '-w', '--no-filters', '--stdin'], 'not a tree\n');
  const rawTree = Buffer.concat([Buffer.from('40000 sub\0'), Buffer.from(blob, 'hex')]);
  const badTree = repo.text(['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'], rawTree);
  const badCommit = repo.text(['commit-tree', badTree, '-m', 'malformed']);
  await assert.rejects(
    addStagedChangesToSarif({
      sarif: { version: '2.1.0', runs: [{ tool: { driver: { name: 'probe' } }, results: [] }] },
      worktree: repo.dir,
      reviewedCommit: badCommit,
      repository: REPOSITORY,
    }),
    new RegExp(`${blob}.*blob, not the expected tree`),
  );
});
