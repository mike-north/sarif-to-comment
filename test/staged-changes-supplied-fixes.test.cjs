'use strict';

/**
 * Regression tests: supplied fixes with several replacements are compared
 * with staged changes by their combined effect (contract §4.5).
 *
 * SARIF 2.1.0 errata01 §3.57.1: every deletedRegion in one artifactChange is
 * located in the unmodified artifact, and the replacements take effect as if
 * performed in array order. An upstream fix that groups independent edits in
 * one artifactChange therefore has a well-defined effect. Where that effect
 * equals the staged edits it touches, those staged changes are explained by
 * the supplied fix: nothing is duplicated and the supplied fix is preserved
 * exactly. A genuinely different effect is a conflict, and an effect that
 * cannot be established (overlapping or order-ambiguous replacements,
 * binary content) fails honestly.
 *
 * Every expected outcome is hand-authored from the fixture bytes and the
 * region rules (an omitted endColumn ends before the line's newline).
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html (3.30 region, 3.56 artifactChange, 3.57 replacement)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { addStagedChangesToSarif } = require('../src/staged-changes.cjs');
const { createFixtureRepo, removeFixtureRepo } = require('./fixtures/staged-changes/git-fixture.cjs');

const REPOSITORY = { owner: 'acme', repo: 'widgets' };
const repos = [];
test.after(() => repos.forEach(removeFixtureRepo));

function fixture(reviewed, staged) {
  const repo = createFixtureRepo({ reviewed: { 'a.txt': reviewed }, staged: { 'a.txt': staged }, workTree: { 'a.txt': 'UNSTAGED\n' } });
  repos.push(repo);
  return repo;
}

/** An upstream document whose one result carries one fix with the given replacements. */
function groupedFix(replacements, runExtra = {}) {
  return {
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'upstream', version: '3.1.4' } },
        ...runExtra,
        results: [
          {
            ruleId: 'U1',
            message: { text: 'Keep these corrections together.' },
            properties: { producerMarker: 'preserve' },
            fixes: [
              {
                description: { text: 'Grouped correction' },
                artifactChanges: [{ artifactLocation: { uri: 'a.txt' }, replacements }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function extract(repo, sarif) {
  return addStagedChangesToSarif({ sarif, worktree: repo.dir, reviewedCommit: repo.reviewedCommit, repository: REPOSITORY });
}

/** Asserts the supplied fix explains every staged change and the document is returned unchanged. */
async function assertExplained(repo, sarif, expectedRanges) {
  const input = structuredClone(sarif);
  const outcome = await extract(repo, sarif);
  assert.equal(outcome.status, 'added', outcome.markdown);
  assert.deepEqual(outcome.sarif, input, 'the supplied fix and its metadata are preserved exactly; nothing is added');
  assert.deepEqual(outcome.receipt.changes, [
    {
      path: 'a.txt',
      operation: 'edit',
      replacements: expectedRanges.map(([startLine, endLine]) => ({ startLine, endLine, associated: [], explainedBy: 'existing-fix' })),
    },
  ]);
  assert.equal(outcome.receipt.addedRun, null, 'no duplicate neutral edit');
  assert.deepEqual(outcome.receipt.boundRuns, []);
}

const FIVE_LINES = 'one\ntwo\nthree\nfour\nfive\n';
const FIVE_LINES_STAGED = 'ONE\ntwo\nthree\nfour\nFIVE\n';

test('grouped independent line-content edits equal to two separate staged hunks explain both', async () => {
  // Line-only regions end before the newline, so the inserted text omits it.
  await assertExplained(
    fixture(FIVE_LINES, FIVE_LINES_STAGED),
    groupedFix([
      { deletedRegion: { startLine: 1 }, insertedContent: { text: 'ONE' } },
      { deletedRegion: { startLine: 5 }, insertedContent: { text: 'FIVE' } },
    ]),
    [[1, 1], [5, 5]],
  );
});

test('grouped whole-line edits (including terminators) equal to two staged hunks explain both', async () => {
  await assertExplained(
    fixture(FIVE_LINES, FIVE_LINES_STAGED),
    groupedFix([
      { deletedRegion: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 }, insertedContent: { text: 'ONE\n' } },
      { deletedRegion: { startLine: 5, startColumn: 1, endLine: 5, endColumn: 6 }, insertedContent: { text: 'FIVE\n' } },
    ]),
    [[1, 1], [5, 5]],
  );
});

test('array order does not matter for disjoint replacements in unmodified coordinates', async () => {
  await assertExplained(
    fixture(FIVE_LINES, FIVE_LINES_STAGED),
    groupedFix([
      { deletedRegion: { startLine: 5 }, insertedContent: { text: 'FIVE' } },
      { deletedRegion: { startLine: 1 }, insertedContent: { text: 'ONE' } },
    ]),
    [[1, 1], [5, 5]],
  );
});

test('column edits on two adjacent lines whose combined effect equals one staged hunk explain it', async () => {
  await assertExplained(
    fixture('let a = 1;\nlet b = 2;\nrest\n', 'let a = 10;\nlet b = 20;\nrest\n'),
    groupedFix(
      [
        { deletedRegion: { startLine: 1, startColumn: 9, endColumn: 10 }, insertedContent: { text: '10' } },
        { deletedRegion: { startLine: 2, startColumn: 9, endColumn: 10 }, insertedContent: { text: '20' } },
      ],
      { columnKind: 'utf16CodeUnits' },
    ),
    [[1, 2]],
  );
});

test('two column edits on one line whose combined effect equals the staged line explain it', async () => {
  await assertExplained(
    fixture('f(a, b)\nnext\n', 'f(x, y)\nnext\n'),
    groupedFix(
      [
        { deletedRegion: { startLine: 1, startColumn: 3, endColumn: 4 }, insertedContent: { text: 'x' } },
        { deletedRegion: { startLine: 1, startColumn: 6, endColumn: 7 }, insertedContent: { text: 'y' } },
      ],
      { columnKind: 'utf16CodeUnits' },
    ),
    [[1, 1]],
  );
});

test('touching whole-line replacements on adjacent lines equal one staged hunk', async () => {
  await assertExplained(
    fixture('a\nb\nc\nd\n', 'a\nB\nC\nd\n'),
    groupedFix([
      { deletedRegion: { startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 }, insertedContent: { text: 'B\n' } },
      { deletedRegion: { startLine: 3, startColumn: 1, endLine: 4, endColumn: 1 }, insertedContent: { text: 'C\n' } },
    ]),
    [[2, 3]],
  );
});

test('a grouped replacement that touches no staged change is preserved as another proposal', async () => {
  // Line 1 is staged and equal; the line 3 edit is a supplied proposal the index does not contain.
  await assertExplained(
    fixture('one\ntwo\nthree\n', 'ONE\ntwo\nthree\n'),
    groupedFix([
      { deletedRegion: { startLine: 1 }, insertedContent: { text: 'ONE' } },
      { deletedRegion: { startLine: 3 }, insertedContent: { text: 'THREE' } },
    ]),
    [[1, 1]],
  );
});

test("the lead's exact probe input fails because its effect genuinely differs, not because it cannot be compared", async () => {
  // Inserting "ONE\n" in place of the content of line 1 (newline kept) yields
  // "ONE\n\ntwo…", which is not the staged "ONE\ntwo…".
  const outcome = await extract(
    fixture(FIVE_LINES, FIVE_LINES_STAGED),
    groupedFix([
      { deletedRegion: { startLine: 1 }, insertedContent: { text: 'ONE\n' } },
      { deletedRegion: { startLine: 5 }, insertedContent: { text: 'FIVE\n' } },
    ]),
  );
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.problems.length, 1, 'one conflict for the one supplied change');
  assert.match(outcome.markdown, /different effect/);
  assert.doesNotMatch(outcome.markdown, /cannot be compared/);
});

test('a group with one equal and one different edit is a conflict naming the differing lines', async () => {
  const outcome = await extract(
    fixture(FIVE_LINES, FIVE_LINES_STAGED),
    groupedFix([
      { deletedRegion: { startLine: 1 }, insertedContent: { text: 'ONE' } },
      { deletedRegion: { startLine: 5 }, insertedContent: { text: 'Five' } },
    ]),
  );
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /lines 5-5/);
  assert.doesNotMatch(outcome.markdown, /lines 1-1/);
});

test('overlapping replacements in one change cannot establish an effect and fail honestly', async () => {
  const outcome = await extract(
    fixture('abcdef\n', 'aXYf\n'),
    groupedFix(
      [
        { deletedRegion: { startLine: 1, startColumn: 2, endColumn: 5 }, insertedContent: { text: 'X' } },
        { deletedRegion: { startLine: 1, startColumn: 4, endColumn: 6 }, insertedContent: { text: 'Y' } },
      ],
      { columnKind: 'utf16CodeUnits' },
    ),
  );
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /overlap/);
});

test('two insertions at the same point have no defined order and fail honestly', async () => {
  const outcome = await extract(
    fixture('a\nb\n', 'a\nX\nY\nb\n'),
    groupedFix([
      { deletedRegion: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 1 }, insertedContent: { text: 'X\n' } },
      { deletedRegion: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 1 }, insertedContent: { text: 'Y\n' } },
    ]),
  );
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /same position/);
});

test('binary content in a group touching a staged change fails honestly', async () => {
  const outcome = await extract(
    fixture(FIVE_LINES, FIVE_LINES_STAGED),
    groupedFix([
      { deletedRegion: { startLine: 1 }, insertedContent: { text: 'ONE' } },
      { deletedRegion: { startLine: 5 }, insertedContent: { binary: 'RklWRQ==' } },
    ]),
  );
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /binary/i);
});
