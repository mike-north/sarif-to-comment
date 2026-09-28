'use strict';

/**
 * Extraction integration contracts:
 *   pure insertions must compose with the unchanged publisher;
 *   a byte-order mark alone is empty visible reviewed content;
 *   receipts must not describe a borrowed unchanged line as changed;
 *   supplied file proposals are compared by meaning (encoding, content,
 *   uninterpreted operation fields), with benign metadata preserved.
 *
 * Expected suggestion payloads, anchors, regions and receipts are written
 * by hand from the fixture bytes and the accepted contract (§4.3, §4.7,
 * §4.8). Composition tests run extraction output through the unchanged
 * publisher preparation; they are local evidence, not GitHub proof.
 *
 * @see ../docs/second-milestone-contract-proposal.md
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html (3.24 artifact, 3.3 artifactContent, 3.14.24 defaultEncoding)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { addStagedChangesToSarif } = require('../dist/staged-changes.cjs');
const { prepareReview } = require('../dist/prepare-review.cjs');
const { createFixtureRepo, removeFixtureRepo } = require('./fixtures/staged-changes/git-fixture.cjs');
const { applyReplacements } = require('./fixtures/staged-changes/apply-oracle.cjs');

const REPOSITORY = { owner: 'acme', repo: 'widgets' };
const repos = [];
test.after(() => repos.forEach(removeFixtureRepo));

function fixture(spec) {
  const repo = createFixtureRepo(spec);
  repos.push(repo);
  return repo;
}

function run(results = [], extra = {}) {
  return { version: '2.1.0', runs: [{ tool: { driver: { name: 'Reviewer' } }, ...extra, results }] };
}

function extract(repo, sarif) {
  return addStagedChangesToSarif({ sarif, worktree: repo.dir, reviewedCommit: repo.reviewedCommit, repository: REPOSITORY });
}

/** Prepares extraction output with the unchanged publisher against the PR diff parent -> reviewed. */
async function prepare(repo, sarif, filePath) {
  const diff = repo.git(['diff', '--no-color', '-U3', repo.parentCommit, repo.reviewedCommit, '--', filePath]).toString('utf8');
  return prepareReview({
    sarif,
    context: {
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 1,
      reviewedCommit: repo.reviewedCommit,
      diff: { baseCommit: repo.parentCommit, headCommit: repo.reviewedCommit, files: [{ path: filePath, patch: diff.slice(diff.indexOf('@@')) }] },
    },
    readSource: async (commit, p) => {
      try {
        return repo.git(['show', `${commit}:${p}`]).toString('utf8');
      } catch {
        return null;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// C1: pure insertions compose with the unchanged publisher
// ---------------------------------------------------------------------------

const PARSE_BASE = "function parse(input) {\n  const parts = input.split(',');\n  return parts.map(Number);\n}\n";
const PARSE_REVIEWED = "function parse(input) {\n  const parts = input.split(';');\n  return parts.map(Number);\n}\n";
const PARSE_STAGED = "function parse(input) {\n  const parts = input.split(';');\n  if (parts.length === 0) return [];\n  return parts.map(Number);\n}\n";

test('C1: a middle insertion publishes as one native suggestion on the line it is inserted before', async () => {
  const repo = fixture({ before: { 'src/parse.js': PARSE_BASE }, reviewed: { 'src/parse.js': PARSE_REVIEWED }, staged: { 'src/parse.js': PARSE_STAGED } });
  const outcome = await extract(repo, run());
  assert.equal(outcome.status, 'added', outcome.markdown);
  // The carrying result names the insertion point itself (zero-length), never line 3's content.
  assert.deepEqual(outcome.sarif.runs[1].results[0].locations, [
    { physicalLocation: { artifactLocation: { uri: 'src/parse.js' }, region: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 1 } } },
  ]);
  const prepared = await prepare(repo, outcome.sarif, 'src/parse.js');
  assert.equal(prepared.status, 'ready', prepared.markdown);
  assert.equal(prepared.review.comments.length, 1);
  const [comment] = prepared.review.comments;
  assert.deepEqual([comment.path, comment.side, comment.startLine, comment.line], ['src/parse.js', 'RIGHT', undefined, 3]);
  assert.ok(comment.body.includes('Staged insertion before line 3 of'), comment.body);
  assert.ok(comment.body.includes("```suggestion\n  if (parts.length === 0) return [];\n  return parts.map(Number);\n```"), comment.body);
  assert.equal(prepared.review.body, '', 'nothing becomes general feedback');
});

test('C1: an end-of-file append publishes as one native suggestion on the final line', async () => {
  const repo = fixture({
    before: { 'list.txt': 'one\ntwo\nthree\n' },
    reviewed: { 'list.txt': 'one\nTWO\nthree\n' },
    staged: { 'list.txt': 'one\nTWO\nthree\nfour\n' },
  });
  const outcome = await extract(repo, run());
  assert.equal(outcome.status, 'added', outcome.markdown);
  // The end-of-file point follows the last line's terminator and has no
  // reviewed line, so the carrying result has no location; its fix names the file.
  assert.equal(outcome.sarif.runs[1].results[0].locations, undefined);
  assert.deepEqual(outcome.sarif.runs[1].results[0].fixes[0].artifactChanges[0].replacements, [
    { deletedRegion: { startLine: 3, startColumn: 7, endLine: 3, endColumn: 7 }, insertedContent: { text: 'four\n' } },
  ]);
  const prepared = await prepare(repo, outcome.sarif, 'list.txt');
  assert.equal(prepared.status, 'ready', prepared.markdown);
  const [comment] = prepared.review.comments;
  assert.deepEqual([comment.side, comment.startLine, comment.line], ['RIGHT', undefined, 3]);
  assert.ok(comment.body.includes('Staged insertion at the end of'), comment.body);
  assert.ok(comment.body.includes('```suggestion\nthree\nfour\n```'), comment.body);
});

test('C1: feedback on the borrowed line stays separate and publishes without the insertion', async () => {
  const repo = fixture({ before: { 'src/parse.js': PARSE_BASE }, reviewed: { 'src/parse.js': PARSE_REVIEWED }, staged: { 'src/parse.js': PARSE_STAGED } });
  const onLine3 = {
    message: { text: 'Mapping to Number drops NaN handling.' },
    locations: [{ physicalLocation: { artifactLocation: { uri: 'src/parse.js' }, region: { startLine: 3 } } }],
  };
  const outcome = await extract(repo, run([onLine3]));
  assert.deepEqual(outcome.sarif.runs[0].results[0], onLine3, 'never associated with the insertion');
  const prepared = await prepare(repo, outcome.sarif, 'src/parse.js');
  assert.equal(prepared.status, 'ready', prepared.markdown);
  const bodies = prepared.review.comments.map((c) => c.body);
  assert.equal(bodies.length, 2);
  assert.equal(bodies.filter((b) => b.includes('```suggestion')).length, 1);
  const feedback = bodies.find((b) => b.includes('drops NaN'));
  assert.ok(!feedback.includes('```suggestion'), 'the finding does not carry the insertion');
});

// ---------------------------------------------------------------------------
// C5: truthful receipts for pure insertions
// ---------------------------------------------------------------------------

test('C5: insertion receipts carry an empty changed range at the insertion point, marked as insertions', async () => {
  const middle = await extract(fixture({ reviewed: { 'f.txt': 'a\nc\n' }, staged: { 'f.txt': 'a\nb\nc\n' } }), run());
  assert.deepEqual(middle.receipt.changes[0].replacements, [
    { startLine: 2, endLine: 1, insertion: true, associated: [], explainedBy: 'neutral' },
  ]);
  const append = await extract(fixture({ reviewed: { 'f.txt': 'one\nTWO\nthree\n' }, staged: { 'f.txt': 'one\nTWO\nthree\nfour\n' } }), run());
  assert.deepEqual(append.receipt.changes[0].replacements, [
    { startLine: 4, endLine: 3, insertion: true, associated: [], explainedBy: 'neutral' },
  ]);
  const empty = await extract(fixture({ reviewed: { 'f.txt': '' }, staged: { 'f.txt': 'hello\n' } }), run());
  assert.deepEqual(empty.receipt.changes[0].replacements, [
    { startLine: 1, endLine: 0, insertion: true, associated: [], explainedBy: 'neutral' },
  ]);
});

test('C5: replacements of existing lines keep their exact changed lines and no insertion marker', async () => {
  const outcome = await extract(fixture({ reviewed: { 'f.txt': 'a\nb\nc\n' }, staged: { 'f.txt': 'a\nB\nc\n' } }), run());
  assert.deepEqual(outcome.receipt.changes[0].replacements, [{ startLine: 2, endLine: 2, associated: [], explainedBy: 'neutral' }]);
});

// ---------------------------------------------------------------------------
// C3: byte-order-mark-only reviewed files
// ---------------------------------------------------------------------------

const BOM = '﻿';

test('C3: text staged into a file that is only a byte-order mark is a faithful insertion after the mark', async () => {
  const repo = fixture({ reviewed: { 'b.txt': BOM }, staged: { 'b.txt': `${BOM}z\n` } });
  const outcome = await extract(repo, run());
  assert.equal(outcome.status, 'added', outcome.markdown);
  const [replacement] = outcome.sarif.runs[1].results[0].fixes[0].artifactChanges[0].replacements;
  assert.deepEqual(replacement, { deletedRegion: { charOffset: 0, charLength: 0 }, insertedContent: { text: 'z\n' } });
  assert.equal(applyReplacements(BOM, [{ deletedRegion: replacement.deletedRegion, insertedText: 'z\n' }]), `${BOM}z\n`);
  assert.deepEqual(outcome.receipt.changes[0].replacements, [
    { startLine: 1, endLine: 0, insertion: true, associated: [], explainedBy: 'neutral' },
  ]);
});

test('C3: emptying a file down to its byte-order mark keeps the mark', async () => {
  const repo = fixture({ reviewed: { 'b.txt': `${BOM}z\n` }, staged: { 'b.txt': BOM } });
  const outcome = await extract(repo, run());
  assert.equal(outcome.status, 'added', outcome.markdown);
  const [replacement] = outcome.sarif.runs[1].results[0].fixes[0].artifactChanges[0].replacements;
  assert.deepEqual(replacement, { deletedRegion: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 3 }, insertedContent: { text: '' } });
  assert.equal(applyReplacements(`${BOM}z\n`, [{ deletedRegion: replacement.deletedRegion, insertedText: '' }], 'utf16CodeUnits'), BOM);
});

test('C3: an unchanged byte-order-mark-only file is not a change, and adding or removing the mark still fails', async () => {
  const same = await extract(fixture({ reviewed: { 'b.txt': BOM, 'x.txt': 'x\n' }, staged: { 'b.txt': BOM, 'x.txt': 'X\n' } }), run());
  assert.deepEqual(same.receipt.changes.map((c) => c.path), ['x.txt']);
  for (const [reviewed, staged] of [[BOM, ''], ['', BOM], [BOM, 'z\n']]) {
    const outcome = await extract(fixture({ reviewed: { 'b.txt': reviewed }, staged: { 'b.txt': staged } }), run());
    assert.equal(outcome.status, 'failed', JSON.stringify([reviewed, staged]));
    assert.match(outcome.markdown, /byte-order mark/);
  }
});

// ---------------------------------------------------------------------------
// Supplied file proposals: equality by meaning, metadata preserved
// ---------------------------------------------------------------------------

/** A document whose one finding on `n.md` carries a supplied create operation. */
function suppliedCreate({ operation = {}, artifact = {}, runExtra = {} } = {}) {
  return run(
    [
      {
        message: { text: 'Here is the page.' },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'n.md' }, region: { startLine: 1 } } }],
        properties: { sarifToComment: { proposedFileChanges: [{ operation: 'create', artifactIndex: 0, fileMode: '100644', ...operation }] } },
      },
    ],
    { artifacts: [{ location: { uri: 'n.md' }, contents: { text: 'new\n' }, ...artifact }], ...runExtra },
  );
}

function createFixture() {
  return fixture({ reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'a\n', 'n.md': 'new\n' } });
}

async function assertExplainedAndPreserved(sarif) {
  const input = structuredClone(sarif);
  const outcome = await extract(createFixture(), sarif);
  assert.equal(outcome.status, 'added', outcome.markdown);
  assert.deepEqual(outcome.receipt.changes, [{ path: 'n.md', operation: 'create', associated: [], explainedBy: 'existing-proposal' }]);
  assert.deepEqual(outcome.sarif, input, 'the supplied proposal and its metadata are preserved exactly');
}

async function assertConflict(sarif, pattern) {
  const outcome = await extract(createFixture(), sarif);
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /\/runs\/0\/results\/0/);
  assert.match(outcome.markdown, pattern);
}

test('file proposals: equal UTF-8 text with benign metadata explains the creation and is preserved', async () => {
  await assertExplainedAndPreserved(suppliedCreate({
    artifact: {
      encoding: 'UTF-8',
      mimeType: 'text/markdown',
      sourceLanguage: 'markdown',
      description: { text: 'Proposed page' },
      properties: { producer: 'docs-agent' },
      length: 4,
      hashes: { 'sha-256': crypto.createHash('sha256').update('new\n').digest('hex') },
    },
  }));
});

test('file proposals: base64 contents equal to the staged bytes explain the creation', async () => {
  await assertExplainedAndPreserved(suppliedCreate({ artifact: { contents: { binary: Buffer.from('new\n').toString('base64') } } }));
});

test('file proposals: a non-UTF-8 artifact encoding means different intended bytes, a conflict', async () => {
  await assertConflict(suppliedCreate({ artifact: { encoding: 'utf-16le' } }), /encoding/);
});

test("file proposals: the run's default encoding applies when the artifact declares none", async () => {
  await assertConflict(suppliedCreate({ runExtra: { defaultEncoding: 'utf-16' } }), /encoding/);
});

test('file proposals: base64 contents that differ from the staged bytes are a conflict', async () => {
  await assertConflict(suppliedCreate({ artifact: { contents: { binary: Buffer.from('other\n').toString('base64') } } }), /content/);
});

test('file proposals: missing contents cannot establish equality', async () => {
  const withoutContents = suppliedCreate();
  delete withoutContents.runs[0].artifacts[0].contents;
  await assertConflict(withoutContents, /content/);
});

test('file proposals: a declared length or hash that disagrees with the staged bytes is a conflict', async () => {
  await assertConflict(suppliedCreate({ artifact: { length: 99 } }), /length/);
  await assertConflict(suppliedCreate({ artifact: { hashes: { 'sha-256': '0'.repeat(64) } } }), /hash/);
});

test('file proposals: an operation field this version does not interpret is never judged equal', async () => {
  await assertConflict(suppliedCreate({ operation: { overwrite: true } }), /overwrite/);
});

test('file proposals: a supplied executable mode differs from a regular staged file', async () => {
  await assertConflict(suppliedCreate({ operation: { fileMode: '100755' } }), /mode/);
});
