'use strict';

/**
 * Behavioral tests for staged-change incorporation (addStagedChangesToSarif).
 *
 * Every repository is a real local Git fixture whose reviewed commit, index
 * and working tree are authored independently (test/fixtures/staged-changes
 * /git-fixture.cjs). Expected regions, inserted text, operations, receipts
 * and staged bytes are written by hand from those bytes and the accepted
 * contract; none is derived from the implementation. The R2 oracle
 * (apply-oracle.cjs) independently re-applies extracted edits to the
 * reviewed bytes and must reproduce the staged bytes exactly.
 *
 * @see ../docs/second-milestone-contract-proposal.md §3.4 and §4
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html (3.30 region, 3.55 fix, 3.57 replacement)
 * @see https://git-scm.com/docs/index-format (intent-to-add and extended flags)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { addStagedChangesToSarif } = require('../src/staged-changes.cjs');
const { MODE } = require('../src/staged-git.cjs');
const {
  addConflict,
  addIntentToAdd,
  addRawPathEntry,
  createFixtureRepo,
  removeFixtureRepo,
} = require('./fixtures/staged-changes/git-fixture.cjs');
const { applyReplacements } = require('./fixtures/staged-changes/apply-oracle.cjs');

const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
const REPOSITORY = { owner: 'acme', repo: 'widgets' };
const REPOSITORY_URI = 'https://github.com/acme/widgets';
const NEUTRAL_TAIL = 'No supplied finding was associated with this change.';

const repos = [];
function fixture(spec) {
  const repo = createFixtureRepo(spec);
  repos.push(repo);
  return repo;
}
test.after(() => repos.forEach(removeFixtureRepo));

function extract(repo, sarif, extra = {}) {
  return addStagedChangesToSarif({
    sarif,
    worktree: repo.dir,
    reviewedCommit: repo.reviewedCommit,
    repository: REPOSITORY,
    ...extra,
  });
}

/** An ordinary one-run SARIF document; results default to none. */
function sarifWith(results = [], runExtra = {}) {
  return {
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'Reviewer', version: '1.0.0' } }, results, ...runExtra }],
  };
}

function finding(uri, region, text = 'Finding.') {
  return { message: { text }, locations: [{ physicalLocation: { artifactLocation: { uri }, region } }] };
}

function textFix(uri, deletedRegion, text) {
  return { artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion, insertedContent: { text } }] }] };
}

/** The neutral run extraction appends when a change is unexplained (contract §4.8). */
function neutralRun(reviewedCommit, results, artifacts) {
  const run = {
    tool: { driver: { name: 'sarif-to-comment', version: PACKAGE_VERSION, rules: [{ id: 'staged-change' }] } },
    columnKind: 'utf16CodeUnits',
    versionControlProvenance: [{ repositoryUri: REPOSITORY_URI, revisionId: reviewedCommit }],
    results,
  };
  if (artifacts) run.artifacts = artifacts;
  return run;
}

function neutralEdit(uri, startLine, endLine, deletedRegion, text) {
  return {
    ruleId: 'staged-change',
    message: { text: `Staged change to lines ${startLine}–${endLine} of \`${uri}\`. ${NEUTRAL_TAIL}` },
    locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine, endLine } } }],
    fixes: [textFix(uri, deletedRegion, text)],
  };
}

/**
 * A neutral result for a pure insertion. An
 * insertion before line N is located at that zero-length insertion point; an
 * insertion at the end of the file has no reviewed line to point at and no
 * location. Neither claims that a reviewed line changed.
 */
function neutralInsertion(uri, where, deletedRegion, text) {
  const result = {
    ruleId: 'staged-change',
    message: { text: `Staged insertion ${where} of \`${uri}\`. ${NEUTRAL_TAIL}` },
    fixes: [textFix(uri, deletedRegion, text)],
  };
  const before = /^before line (\d+)$/.exec(where);
  if (before) {
    const line = Number(before[1]);
    result.locations = [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line, startColumn: 1, endLine: line, endColumn: 1 } } }];
  }
  return result;
}

function neutralFileOperation(uri, verb, operation) {
  return {
    ruleId: 'staged-change',
    message: { text: `Staged ${verb} of \`${uri}\`. ${NEUTRAL_TAIL}` },
    locations: [{ physicalLocation: { artifactLocation: { uri } } }],
    properties: { sarifToComment: { proposedFileChanges: [operation] } },
  };
}

/** Every distinct replacement for `uri` carried by fixes anywhere in `sarif`, with its run's columnKind. */
function replacementsFor(sarif, uri) {
  const seen = new Map();
  for (const run of sarif.runs) {
    for (const result of run.results || []) {
      for (const fix of result.fixes || []) {
        for (const change of fix.artifactChanges) {
          if (change.artifactLocation.uri !== uri) continue;
          for (const r of change.replacements) {
            const entry = { deletedRegion: r.deletedRegion, insertedText: r.insertedContent.text, columnKind: run.columnKind };
            seen.set(JSON.stringify(entry), entry);
          }
        }
      }
    }
  }
  return [...seen.values()];
}

/** R2 oracle: extracted replacements applied to reviewed bytes reproduce staged bytes. */
function assertReproduces(sarif, uri, reviewedText, stagedText) {
  const reps = replacementsFor(sarif, uri);
  const kinds = new Set(reps.map((r) => r.columnKind));
  assert.equal(kinds.size <= 1, true, 'one column convention per file in these fixtures');
  const applied = applyReplacements(reviewedText, reps, [...kinds][0] || 'utf16CodeUnits');
  assert.equal(applied, stagedText, `independent application must reproduce the staged bytes of ${uri}`);
}

// ---------------------------------------------------------------------------
// Selected path: the parent's independent source oracle and upstream input
// ---------------------------------------------------------------------------

const ORACLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'docs', 'evidence', 'second-milestone', 'source-oracle.json'), 'utf8'),
);
const UPSTREAM = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'docs', 'evidence', 'second-milestone', 'upstream-input.sarif.json'), 'utf8'),
);

test('selected path: upstream findings gain exactly the staged fixes; unstaged bytes never appear', async () => {
  const repo = fixture({
    before: { [ORACLE.path]: ORACLE.base },
    reviewed: { [ORACLE.path]: ORACLE.reviewed },
    staged: { [ORACLE.path]: ORACLE.staged },
    workTree: { [ORACLE.path]: ORACLE.workingTree },
  });
  const input = structuredClone(UPSTREAM);
  const outcome = await extract(repo, input);
  assert.equal(outcome.status, 'added', JSON.stringify(outcome.problems));
  assert.deepEqual(input, UPSTREAM, 'the caller input is not mutated');

  // Independently authored: finding A (line 2) and B (lines 5-6) each receive
  // their own exact replacement; the run is bound to the reviewed commit.
  const expected = structuredClone(UPSTREAM);
  expected.runs[0].versionControlProvenance = [{ repositoryUri: REPOSITORY_URI, revisionId: repo.reviewedCommit }];
  expected.runs[0].results[0].fixes = [
    textFix('fixture/review.txt', { startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 }, 'corrected two\n'),
  ];
  expected.runs[0].results[1].fixes = [
    textFix('fixture/review.txt', { startLine: 5, startColumn: 1, endLine: 7, endColumn: 1 }, 'corrected five and six\n'),
  ];
  assert.deepEqual(outcome.sarif, expected);
  assert.deepEqual(outcome.receipt, {
    reviewedCommit: repo.reviewedCommit,
    changes: [
      {
        path: 'fixture/review.txt',
        operation: 'edit',
        replacements: [
          { startLine: 2, endLine: 2, associated: ['/runs/0/results/0'], explainedBy: 'finding' },
          { startLine: 5, endLine: 6, associated: ['/runs/0/results/1'], explainedBy: 'finding' },
        ],
      },
    ],
    boundRuns: [0],
    addedRun: null,
    warnings: [],
  });
  assert.ok(!JSON.stringify(outcome.sarif).includes('UNSTAGED'), 'no unstaged content');
  assertReproduces(outcome.sarif, 'fixture/review.txt', ORACLE.reviewed, ORACLE.staged);
});

test('selected path: outcome, receipt and SARIF additions keep their field order', async () => {
  // Outcome and receipt fields follow the contract's order (§3.4:
  // status, sarif, receipt; reviewedCommit, changes, boundRuns, addedRun,
  // warnings). For the SARIF itself, the placement of added fields is
  // characterization of 0.2.0: caller content keeps its own order and what
  // extraction adds is appended, so the file add-staged-changes writes
  // differs from its input only by additions.
  const repo = fixture({
    before: { [ORACLE.path]: ORACLE.base },
    reviewed: { [ORACLE.path]: ORACLE.reviewed },
    staged: { [ORACLE.path]: ORACLE.staged },
    workTree: { [ORACLE.path]: ORACLE.workingTree },
  });
  const outcome = await extract(repo, structuredClone(UPSTREAM));
  assert.equal(outcome.status, 'added', JSON.stringify(outcome.problems));
  assert.deepEqual(Object.keys(outcome), ['status', 'sarif', 'receipt']);
  assert.deepEqual(Object.keys(outcome.receipt), ['reviewedCommit', 'changes', 'boundRuns', 'addedRun', 'warnings']);
  assert.deepEqual(Object.keys(outcome.receipt.changes[0]), ['path', 'operation', 'replacements']);
  assert.deepEqual(Object.keys(outcome.receipt.changes[0].replacements[0]), ['startLine', 'endLine', 'associated', 'explainedBy']);

  const [run] = outcome.sarif.runs;
  assert.deepEqual(Object.keys(run), [...Object.keys(UPSTREAM.runs[0]), 'versionControlProvenance']);
  assert.deepEqual(Object.keys(run.results[0]), [...Object.keys(UPSTREAM.runs[0].results[0]), 'fixes']);
  assert.equal(
    JSON.stringify(run.results[0].fixes),
    '[{"artifactChanges":[{"artifactLocation":{"uri":"fixture/review.txt"},"replacements":[{"deletedRegion":{"startLine":2,"startColumn":1,"endLine":3,"endColumn":1},"insertedContent":{"text":"corrected two\\n"}}]}]}]',
  );
  assert.equal(JSON.stringify(run.versionControlProvenance), `[{"repositoryUri":"${REPOSITORY_URI}","revisionId":"${repo.reviewedCommit}"}]`);
});

test('a schema-invalid document is refused with fields in contract order', async () => {
  const repo = fixture({ reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'b\n' } });
  const outcome = await extract(repo, { version: '2.1.0', runs: [{ results: [] }] });
  assert.equal(outcome.status, 'invalid');
  assert.deepEqual(Object.keys(outcome), ['status', 'problems', 'markdown']);
});

test('selected path output is accepted by the unchanged publisher preparation as two native suggestions', async () => {
  const { prepareReview } = require('../src/prepare-review.cjs');
  const repo = fixture({
    before: { [ORACLE.path]: ORACLE.base },
    reviewed: { [ORACLE.path]: ORACLE.reviewed },
    staged: { [ORACLE.path]: ORACLE.staged },
    workTree: { [ORACLE.path]: ORACLE.workingTree },
  });
  const outcome = await extract(repo, structuredClone(UPSTREAM));
  const diff = repo.git(['diff', '--no-color', '-U3', repo.parentCommit, repo.reviewedCommit, '--', ORACLE.path]).toString('utf8');
  const patch = diff.slice(diff.indexOf('@@'));
  const prepared = await prepareReview({
    sarif: outcome.sarif,
    context: {
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 1,
      reviewedCommit: repo.reviewedCommit,
      diff: { baseCommit: repo.parentCommit, headCommit: repo.reviewedCommit, files: [{ path: ORACLE.path, patch }] },
    },
    readSource: async (commit, p) => {
      try {
        return repo.git(['show', `${commit}:${p}`]).toString('utf8');
      } catch {
        return null;
      }
    },
  });
  assert.equal(prepared.status, 'ready', prepared.markdown);
  const bodies = prepared.review.comments.map((c) => [c.side, c.startLine ?? c.line, c.line, c.body]);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies.map((b) => b.slice(0, 3)), [['RIGHT', 2, 2], ['RIGHT', 5, 6]]);
  assert.ok(bodies[0][3].includes('```suggestion\ncorrected two\n```'));
  assert.ok(bodies[1][3].includes('```suggestion\ncorrected five and six\n```'));
});

test('capture before await: mutating the caller input during extraction has no effect', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\nb\nc\n' }, staged: { 'f.txt': 'a\nB\nc\n' }, workTree: { 'f.txt': 'a\nUNSTAGED\nc\n' } });
  const input = sarifWith([finding('f.txt', { startLine: 2 }, 'Capitalize.')]);
  const pending = extract(repo, input);
  input.runs[0].results[0].message.text = 'MUTATED';
  input.runs[0].results[0].locations[0].physicalLocation.region.startLine = 1;
  const outcome = await pending;
  assert.equal(outcome.status, 'added');
  assert.equal(outcome.sarif.runs[0].results[0].message.text, 'Capitalize.');
  assert.deepEqual(outcome.sarif.runs[0].results[0].fixes, [
    textFix('f.txt', { startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 }, 'B\n'),
  ]);
  assert.ok(!JSON.stringify(outcome.sarif).includes('UNSTAGED'));
});

// ---------------------------------------------------------------------------
// Coordinates, newlines and encodings (neutral results: no supplied findings)
// ---------------------------------------------------------------------------

const EDIT_CASES = [
  {
    name: 'CRLF middle line',
    reviewed: 'a\r\nb\r\nc\r\n',
    staged: 'a\r\nB\r\nc\r\n',
    results: (u) => [neutralEdit(u, 2, 2, { startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 }, 'B\r\n')],
  },
  {
    name: 'adding a missing final newline',
    reviewed: 'a\nb',
    staged: 'a\nb\n',
    results: (u) => [neutralEdit(u, 2, 2, { startLine: 2, endLine: 2 }, 'b\n')],
  },
  {
    name: 'removing the final newline ends at the final line, never an invented line 3',
    reviewed: 'a\nb\n',
    staged: 'a\nb',
    results: (u) => [neutralEdit(u, 2, 2, { startLine: 2, startColumn: 1, endLine: 2, endColumn: 3 }, 'b')],
  },
  {
    name: 'deleting the last line',
    reviewed: 'a\nb\n',
    staged: 'a\n',
    results: (u) => [neutralEdit(u, 2, 2, { startLine: 2, startColumn: 1, endLine: 2, endColumn: 3 }, '')],
  },
  {
    name: 'deleting a middle line',
    reviewed: 'a\nb\nc\n',
    staged: 'a\nc\n',
    results: (u) => [neutralEdit(u, 2, 2, { startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 }, '')],
  },
  {
    name: 'one line to three',
    reviewed: 'x\ny\nz\n',
    staged: 'x\n1\n2\n3\nz\n',
    results: (u) => [neutralEdit(u, 2, 2, { startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 }, '1\n2\n3\n')],
  },
  {
    name: 'two lines to one',
    reviewed: 'p\nq\nr\ns\n',
    staged: 'p\nQR\ns\n',
    results: (u) => [neutralEdit(u, 2, 3, { startLine: 2, startColumn: 1, endLine: 4, endColumn: 1 }, 'QR\n')],
  },
  {
    name: 'emptying a file is an edit, not a deletion',
    reviewed: 'a\nb\n',
    staged: '',
    results: (u) => [neutralEdit(u, 1, 2, { startLine: 1, startColumn: 1, endLine: 2, endColumn: 3 }, '')],
  },
  {
    name: 'two separated changes are two replacements',
    reviewed: '1\n2\n3\n4\n5\n',
    staged: 'one\n2\n3\n4\nfive\n',
    results: (u) => [
      neutralEdit(u, 1, 1, { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 }, 'one\n'),
      neutralEdit(u, 5, 5, { startLine: 5, startColumn: 1, endLine: 5, endColumn: 3 }, 'five\n'),
    ],
  },
  {
    name: 'BOM retained on both sides; line 1 coordinates exclude it',
    reviewed: '﻿a\nb\n',
    staged: '﻿A\nb\n',
    results: (u) => [neutralEdit(u, 1, 1, { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 }, 'A\n')],
  },
  {
    name: 'supplementary-plane final line in UTF-16 units (generated run convention)',
    reviewed: 'x\n\u{1F600}\n',
    staged: 'x\n\u{1F600}',
    results: (u) => [neutralEdit(u, 2, 2, { startLine: 2, startColumn: 1, endLine: 2, endColumn: 4 }, '\u{1F600}')],
  },
  {
    name: 'pure insertion between lines associates no line',
    reviewed: 'a\nc\n',
    staged: 'a\nb\nc\n',
    results: (u) => [neutralInsertion(u, 'before line 2', { startLine: 2, startColumn: 1, endLine: 2, endColumn: 1 }, 'b\n')],
  },
  {
    name: 'appending after the terminal newline',
    reviewed: 'a\n',
    staged: 'a\nb\n',
    results: (u) => [neutralInsertion(u, 'at the end', { startLine: 1, startColumn: 3, endLine: 1, endColumn: 3 }, 'b\n')],
  },
  {
    name: 'writing into an empty file uses an offset, never a fabricated line',
    reviewed: '',
    staged: 'hello\n',
    results: (u) => [neutralInsertion(u, 'at the end', { charOffset: 0, charLength: 0 }, 'hello\n')],
  },
];

for (const c of EDIT_CASES) {
  test(`edit envelope: ${c.name}`, async () => {
    const uri = 'dir/file.txt';
    const repo = fixture({ reviewed: { [uri]: c.reviewed }, staged: { [uri]: c.staged }, workTree: { [uri]: 'UNSTAGED\n' } });
    const outcome = await extract(repo, sarifWith());
    assert.equal(outcome.status, 'added', JSON.stringify(outcome.problems));
    assert.deepEqual(outcome.sarif.runs[1], neutralRun(repo.reviewedCommit, c.results(uri)));
    assert.equal(outcome.receipt.addedRun, 1);
    assert.deepEqual(outcome.receipt.boundRuns, []);
    assert.equal(outcome.receipt.changes.length, 1);
    assert.equal(outcome.receipt.changes[0].operation, 'edit');
    assert.ok(outcome.receipt.changes[0].replacements.every((r) => r.explainedBy === 'neutral' && r.associated.length === 0));
    assertReproduces(outcome.sarif, uri, c.reviewed, c.staged);
  });
}

test('repeated identical lines: any single insertion that reproduces the staged bytes is valid', async () => {
  const repo = fixture({ reviewed: { 'r.txt': 'x\nx\n' }, staged: { 'r.txt': 'x\nx\nx\n' } });
  const outcome = await extract(repo, sarifWith());
  const reps = replacementsFor(outcome.sarif, 'r.txt');
  assert.equal(reps.length, 1);
  assert.equal(reps[0].insertedText, 'x\n');
  assertReproduces(outcome.sarif, 'r.txt', 'x\nx\n', 'x\nx\nx\n');
});

test('a BOM added or removed by the index is an explicit failure, never silently dropped', async () => {
  for (const [reviewed, staged] of [['a\n', '﻿a\n'], ['﻿a\n', 'a\n']]) {
    const repo = fixture({ reviewed: { 'b.txt': reviewed }, staged: { 'b.txt': staged } });
    const outcome = await extract(repo, sarifWith());
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.markdown, /b\.txt/);
    assert.match(outcome.markdown, /byte-order mark/i);
  }
});

// ---------------------------------------------------------------------------
// Association
// ---------------------------------------------------------------------------

test('contained finding receives the replacement; partial overlap stays separate with a warning', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\nb\nc\nd\n' }, staged: { 'f.txt': 'a\nB\nc\nd\n' } });
  const contained = finding('f.txt', { startLine: 2 }, 'Contained.');
  const partial = finding('f.txt', { startLine: 2, endLine: 3 }, 'Partial.');
  const adjacent = finding('f.txt', { startLine: 3 }, 'Adjacent.');
  const input = sarifWith([contained, partial, adjacent]);
  const outcome = await extract(repo, input);
  assert.equal(outcome.status, 'added');
  const fix = textFix('f.txt', { startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 }, 'B\n');
  assert.deepEqual(outcome.sarif.runs[0].results, [{ ...contained, fixes: [fix] }, partial, adjacent]);
  assert.equal(outcome.sarif.runs.length, 1, 'no neutral run: the change is explained');
  assert.deepEqual(outcome.receipt.changes[0].replacements, [
    { startLine: 2, endLine: 2, associated: ['/runs/0/results/0'], explainedBy: 'finding' },
  ]);
  assert.equal(outcome.receipt.warnings.length, 1);
  assert.equal(outcome.receipt.warnings[0].pointer, '/runs/0/results/1');
  assert.match(outcome.receipt.warnings[0].message, /partially overlaps/);
});

test('partial overlap alone leaves the change unexplained (neutral) and the finding untouched', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\nb\nc\n' }, staged: { 'f.txt': 'a\nB\nc\n' } });
  const partial = finding('f.txt', { startLine: 2, endLine: 3 }, 'Partial.');
  const outcome = await extract(repo, sarifWith([partial]));
  assert.deepEqual(outcome.sarif.runs[0].results, [partial]);
  assert.deepEqual(outcome.sarif.runs[1], neutralRun(repo.reviewedCommit, [
    neutralEdit('f.txt', 2, 2, { startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 }, 'B\n'),
  ]));
  assert.deepEqual(outcome.receipt.boundRuns, [], 'a run that received nothing is not bound');
});

test('findings in two runs share one replacement; each keeps its own text and origin', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\nb\nc\n' }, staged: { 'f.txt': 'a\nB\nc\n' } });
  const input = {
    version: '2.1.0',
    runs: [
      { tool: { driver: { name: 'Agent A' } }, results: [finding('f.txt', { startLine: 2 }, 'From A.')] },
      { tool: { driver: { name: 'Agent B' } }, results: [finding('f.txt', { startLine: 2 }, 'From B.')] },
    ],
  };
  const outcome = await extract(repo, input);
  const fix = textFix('f.txt', { startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 }, 'B\n');
  assert.deepEqual(outcome.sarif.runs[0].results[0].fixes, [fix]);
  assert.deepEqual(outcome.sarif.runs[1].results[0].fixes, [fix]);
  assert.equal(outcome.sarif.runs[0].results[0].message.text, 'From A.');
  assert.equal(outcome.sarif.runs[1].results[0].message.text, 'From B.');
  assert.deepEqual(outcome.receipt.changes[0].replacements[0].associated, ['/runs/0/results/0', '/runs/1/results/0']);
  assert.deepEqual(outcome.receipt.boundRuns, [0, 1]);
});

test('a pure insertion never auto-associates a finding on the neighbouring line', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\nc\n' }, staged: { 'f.txt': 'a\nb\nc\n' } });
  const near = finding('f.txt', { startLine: 2 }, 'Near.');
  const outcome = await extract(repo, sarifWith([near]));
  assert.deepEqual(outcome.sarif.runs[0].results, [near]);
  assert.equal(outcome.receipt.changes[0].replacements[0].explainedBy, 'neutral');
});

test('a run bound to another commit is never associated or rebound', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\nb\nc\n' }, staged: { 'f.txt': 'a\nB\nc\n' } });
  const historical = {
    tool: { driver: { name: 'Old' } },
    versionControlProvenance: [{ repositoryUri: REPOSITORY_URI, revisionId: 'a'.repeat(40) }],
    results: [finding('f.txt', { startLine: 2 }, 'Historical.')],
  };
  const outcome = await extract(repo, { version: '2.1.0', runs: [historical] });
  assert.deepEqual(outcome.sarif.runs[0], historical);
  assert.equal(outcome.receipt.changes[0].replacements[0].explainedBy, 'neutral');
});

test('a matching provenance entry without a revision gains it; other provenance is preserved', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\nb\n' }, staged: { 'f.txt': 'A\nb\n' } });
  const provenance = [
    { repositoryUri: 'https://example.com/elsewhere/lib', revisionId: 'b'.repeat(40) },
    { repositoryUri: 'git@github.com:Acme/Widgets.git'.replace('git@github.com:', 'ssh://git@github.com/'), branch: 'main' },
  ];
  const input = sarifWith([finding('f.txt', { startLine: 1 })], { versionControlProvenance: provenance });
  const outcome = await extract(repo, input);
  assert.deepEqual(outcome.sarif.runs[0].versionControlProvenance, [
    provenance[0],
    { ...provenance[1], revisionId: repo.reviewedCommit },
  ]);
  assert.deepEqual(outcome.receipt.boundRuns, [0]);
});

test('an equal supplied fix explains the change; re-extracting the output is idempotent', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\nb\nc\nd\ne\n' }, staged: { 'f.txt': 'a\nB\nc\nd\nE\n' } });
  const first = await extract(repo, sarifWith([finding('f.txt', { startLine: 2 })]));
  assert.equal(first.status, 'added');
  const second = await extract(repo, first.sarif);
  assert.equal(second.status, 'added');
  assert.deepEqual(second.sarif, first.sarif, 'no duplicate fixes or neutral results');
  assert.deepEqual(second.receipt.changes[0].replacements.map((r) => r.explainedBy), ['existing-fix', 'existing-fix']);
  assert.deepEqual(second.receipt.boundRuns, []);
  assert.equal(second.receipt.addedRun, null);
});

test('a supplied fix with a different effect on the same lines is a mechanical conflict', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\nb\nc\n' }, staged: { 'f.txt': 'a\nB\nc\n' } });
  const supplied = {
    ...finding('f.txt', { startLine: 2 }),
    fixes: [textFix('f.txt', { startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 }, 'bee\n')],
  };
  const outcome = await extract(repo, sarifWith([supplied]));
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /\/runs\/0\/results\/0/);
  assert.match(outcome.markdown, /conflict/i);
});

test('a contained finding that already has a non-overlapping fix is left untouched', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\nb\nc\nd\n' }, staged: { 'f.txt': 'a\nB\nc\nd\n' } });
  const supplied = {
    ...finding('f.txt', { startLine: 2 }),
    fixes: [textFix('f.txt', { startLine: 4, startColumn: 1, endLine: 4, endColumn: 3 }, 'D\n')],
  };
  const outcome = await extract(repo, sarifWith([supplied]));
  assert.equal(outcome.status, 'added');
  assert.deepEqual(outcome.sarif.runs[0].results[0], supplied);
  assert.equal(outcome.receipt.changes[0].replacements[0].explainedBy, 'neutral');
});

test('a finding beyond the reviewed file on a changed path fails rather than being reduced', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\nb\n' }, staged: { 'f.txt': 'a\nB\n' } });
  const outcome = await extract(repo, sarifWith([finding('f.txt', { startLine: 9 })]));
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /f\.txt/);
});

test('a finding on an unchanged path is neither validated nor modified', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\n', 'g.txt': 'g\n' }, staged: { 'f.txt': 'A\n', 'g.txt': 'g\n' } });
  const elsewhere = finding('g.txt', { startLine: 50 }, 'Publisher will judge this.');
  const outcome = await extract(repo, sarifWith([elsewhere]));
  assert.equal(outcome.status, 'added');
  assert.deepEqual(outcome.sarif.runs[0].results[0], elsewhere);
});

test('a run without columnKind cannot take an end-of-file column that differs by unit; the finding stays separate', async () => {
  const repo = fixture({ reviewed: { 'e.txt': 'x\n\u{1F600}\n' }, staged: { 'e.txt': 'x\n\u{1F600}' } });
  const f = finding('e.txt', { startLine: 2 });
  const outcome = await extract(repo, sarifWith([f]));
  assert.equal(outcome.status, 'added');
  assert.deepEqual(outcome.sarif.runs[0].results[0], f, 'no columnKind stamped, no fix attached');
  assert.deepEqual(outcome.sarif.runs[1].results, [
    neutralEdit('e.txt', 2, 2, { startLine: 2, startColumn: 1, endLine: 2, endColumn: 4 }, '\u{1F600}'),
  ]);
  assert.ok(outcome.receipt.warnings.some((w) => /columnKind/.test(w.message)));
});

test('a run declaring unicodeCodePoints receives code-point columns', async () => {
  const repo = fixture({ reviewed: { 'e.txt': 'x\n\u{1F600}\n' }, staged: { 'e.txt': 'x\n\u{1F600}' } });
  const outcome = await extract(repo, sarifWith([finding('e.txt', { startLine: 2 })], { columnKind: 'unicodeCodePoints' }));
  assert.deepEqual(outcome.sarif.runs[0].results[0].fixes, [
    textFix('e.txt', { startLine: 2, startColumn: 1, endLine: 2, endColumn: 3 }, '\u{1F600}'),
  ]);
  assert.equal(outcome.sarif.runs[0].columnKind, 'unicodeCodePoints');
});

// ---------------------------------------------------------------------------
// Whole-file operations
// ---------------------------------------------------------------------------

test('creation: a finding on a real proposed line carries the create operation and full content', async () => {
  const repo = fixture({ reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'a\n', 'docs/new.md': '# New\n\nBody.\n' } });
  const f = finding('docs/new.md', { startLine: 1 }, 'Here is the missing page.');
  const outcome = await extract(repo, sarifWith([f]));
  assert.equal(outcome.status, 'added', JSON.stringify(outcome.problems));
  assert.deepEqual(outcome.sarif.runs[0].artifacts, [
    { location: { uri: 'docs/new.md' }, contents: { text: '# New\n\nBody.\n' }, encoding: 'utf-8' },
  ]);
  assert.deepEqual(outcome.sarif.runs[0].results[0], {
    ...f,
    properties: { sarifToComment: { proposedFileChanges: [{ operation: 'create', artifactIndex: 0, fileMode: '100644' }] } },
  });
  assert.deepEqual(outcome.receipt.changes, [
    { path: 'docs/new.md', operation: 'create', associated: ['/runs/0/results/0'], explainedBy: 'finding' },
  ]);
  assert.ok(outcome.receipt.warnings.some((w) => /does not publish|publisher/i.test(w.message)));
});

test('creation: a finding beyond the proposed file fails (A25)', async () => {
  const repo = fixture({ reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'a\n', 'new.md': '1\n2\n3\n4\n5\n' } });
  const outcome = await extract(repo, sarifWith([finding('new.md', { startLine: 12 })]));
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /new\.md/);
});

test('creation, deletion and emptying stay distinct operations', async () => {
  const repo = fixture({
    reviewed: { 'keep.txt': 'k\n', 'gone.txt': 'old\n', 'empty-me.txt': 'x\n' },
    staged: { 'keep.txt': 'k\n', 'empty-me.txt': '', 'blank.txt': '', 'tool.sh': { bytes: '#!/bin/sh\n', mode: '100755' } },
  });
  const outcome = await extract(repo, sarifWith());
  assert.equal(outcome.status, 'added', JSON.stringify(outcome.problems));
  const neutral = outcome.sarif.runs[1];
  assert.deepEqual(neutral.artifacts, [
    { location: { uri: 'blank.txt' }, contents: { text: '' }, encoding: 'utf-8' },
    { location: { uri: 'gone.txt' } },
    { location: { uri: 'tool.sh' }, contents: { text: '#!/bin/sh\n' }, encoding: 'utf-8' },
  ]);
  assert.deepEqual(neutral.results, [
    neutralFileOperation('blank.txt', 'creation', { operation: 'create', artifactIndex: 0, fileMode: '100644' }),
    neutralEdit('empty-me.txt', 1, 1, { startLine: 1, startColumn: 1, endLine: 1, endColumn: 3 }, ''),
    neutralFileOperation('gone.txt', 'deletion', { operation: 'delete', artifactIndex: 1 }),
    neutralFileOperation('tool.sh', 'creation', { operation: 'create', artifactIndex: 2, fileMode: '100755' }),
  ]);
  assert.deepEqual(
    outcome.receipt.changes.map((c) => [c.path, c.operation]),
    [['blank.txt', 'create'], ['empty-me.txt', 'edit'], ['gone.txt', 'delete'], ['tool.sh', 'create']],
  );
});

test('deletion: a finding on the reviewed file carries the delete operation; its line does not narrow it', async () => {
  const repo = fixture({ reviewed: { 'old.test.js': 'one\ntwo\nthree\n' }, staged: {} });
  const f = finding('old.test.js', { startLine: 2 }, 'Obsolete test module.');
  const outcome = await extract(repo, sarifWith([f]));
  assert.deepEqual(outcome.sarif.runs[0].artifacts, [{ location: { uri: 'old.test.js' } }]);
  assert.deepEqual(outcome.sarif.runs[0].results[0].properties, {
    sarifToComment: { proposedFileChanges: [{ operation: 'delete', artifactIndex: 0 }] },
  });
  assert.equal(outcome.sarif.runs.length, 1);
});

test('a moved file is a deletion plus a creation; no rename is inferred', async () => {
  const repo = fixture({ reviewed: { 'from.txt': 'same\n' }, staged: { 'to.txt': 'same\n' } });
  const outcome = await extract(repo, sarifWith());
  assert.deepEqual(outcome.receipt.changes.map((c) => [c.path, c.operation]), [['from.txt', 'delete'], ['to.txt', 'create']]);
});

test('deleting a non-UTF-8 file is allowed; its content is not needed', async () => {
  const repo = fixture({ reviewed: { 'blob.bin': Buffer.from([0xff, 0x00, 0xfe]) }, staged: {} });
  const outcome = await extract(repo, sarifWith());
  assert.equal(outcome.status, 'added', JSON.stringify(outcome.problems));
  assert.deepEqual(outcome.receipt.changes, [{ path: 'blob.bin', operation: 'delete', associated: [], explainedBy: 'neutral' }]);
});

test('paths are written as percent-encoded URIs and matched after decoding', async () => {
  const p = 'docs/guide notes/Überblick.md';
  const uri = 'docs/guide%20notes/%C3%9Cberblick.md';
  const repo = fixture({ reviewed: { [p]: 'alt\n' }, staged: { [p]: 'neu\n' } });
  const outcome = await extract(repo, sarifWith([finding(uri, { startLine: 1 })]));
  assert.deepEqual(outcome.sarif.runs[0].results[0].fixes, [
    textFix(uri, { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 }, 'neu\n'),
  ]);
  assert.equal(outcome.receipt.changes[0].path, p);
});

// ---------------------------------------------------------------------------
// Strict failure envelope
// ---------------------------------------------------------------------------

const FAILURES = [
  ['mode change', { reviewed: { 's.sh': 'x\n' }, staged: { 's.sh': { bytes: 'x\n', mode: '100755' } } }, /s\.sh/, /mode/i],
  ['mode and content change', { reviewed: { 's.sh': 'x\n' }, staged: { 's.sh': { bytes: 'y\n', mode: '100755' } } }, /s\.sh/, /mode/i],
  ['symlink', { reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'a\n', link: { bytes: 'a.txt', mode: '120000' } } }, /link/, /symbolic link/i],
  ['type change file to symlink', { reviewed: { t: 't\n' }, staged: { t: { bytes: 'a.txt', mode: '120000' } } }, /\bt\b/, /symbolic link/i],
  ['submodule', { reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'a\n', vendor: { mode: '160000', commit: 'c'.repeat(40) } } }, /vendor/, /submodule/i],
  ['non-UTF-8 edit', { reviewed: { 'l.txt': 'caf\n' }, staged: { 'l.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) } }, /l\.txt/, /UTF-8/],
  ['binary creation', { reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'a\n', 'n.bin': Buffer.from([0x61, 0x00, 0x62]) } }, /n\.bin/, /binary/i],
  ['over the size limit', { reviewed: { 'big.txt': 'a\n' }, staged: { 'big.txt': `${'x'.repeat(1_000_001)}\n` } }, /big\.txt/, /1,?000,?000/],
];
for (const [name, spec, pathPattern, reasonPattern] of FAILURES) {
  test(`strict failure: ${name}`, async () => {
    const repo = fixture(spec);
    const outcome = await extract(repo, sarifWith());
    assert.equal(outcome.status, 'failed');
    assert.ok(Array.isArray(outcome.problems) && outcome.problems.length > 0);
    assert.match(outcome.markdown, pathPattern);
    assert.match(outcome.markdown, reasonPattern);
    assert.equal(outcome.sarif, undefined, 'strict failure withholds SARIF');
  });
}

test('strict failure: unmerged index entries', async () => {
  const repo = fixture({ reviewed: { 'c.txt': 'base\n' }, staged: { 'c.txt': 'base\n' } });
  addConflict(repo, 'c.txt', { base: 'base\n', ours: 'ours\n', theirs: 'theirs\n' });
  const outcome = await extract(repo, sarifWith());
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /c\.txt/);
  assert.match(outcome.markdown, /conflict|unmerged/i);
});

test('strict failure: intent-to-add is distinguished from an intentionally staged empty file', async () => {
  const repo = fixture({ reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'a\n', 'really-empty.txt': '' } });
  addIntentToAdd(repo, 'later.txt');
  const outcome = await extract(repo, sarifWith());
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /later\.txt/);
  assert.match(outcome.markdown, /intent-to-add/i);
  assert.doesNotMatch(outcome.markdown, /really-empty/);
});

test('strict failure: a changed path that is not valid UTF-8', async () => {
  const repo = fixture({ reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'a\n' } });
  addRawPathEntry(repo, Buffer.from([0x62, 0xff, 0x2e, 0x74]), 'x\n');
  const outcome = await extract(repo, sarifWith());
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /UTF-8/);
});

test('no staged changes: the SARIF is returned unchanged with an empty receipt', async () => {
  const repo = fixture({ reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'a\n' }, workTree: { 'a.txt': 'UNSTAGED\n' } });
  const input = sarifWith([finding('a.txt', { startLine: 1 })]);
  const outcome = await extract(repo, input);
  assert.deepEqual(outcome, {
    status: 'added',
    sarif: input,
    receipt: { reviewedCommit: repo.reviewedCommit, changes: [], boundRuns: [], addedRun: null, warnings: [] },
  });
  assert.notEqual(outcome.sarif, input, 'a fresh value, never the caller object');
});

test('GIT_INDEX_FILE selects the intended index, as Git itself does', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\n' }, staged: { 'f.txt': 'a\n' } });
  const alternate = path.join(repo.dir, '.git', 'alternate-index');
  const env = { ...process.env, GIT_INDEX_FILE: alternate };
  const { execFileSync } = require('node:child_process');
  execFileSync('git', ['read-tree', repo.reviewedCommit], { cwd: repo.dir, env });
  const oid = execFileSync('git', ['hash-object', '-w', '--no-filters', '--stdin'], { cwd: repo.dir, env, input: 'ALT\n' })
    .toString().trim();
  execFileSync('git', ['update-index', '--cacheinfo', `100644,${oid},f.txt`], { cwd: repo.dir, env });
  const saved = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = alternate;
  try {
    const outcome = await extract(repo, sarifWith());
    assert.deepEqual(replacementsFor(outcome.sarif, 'f.txt').map((r) => r.insertedText), ['ALT\n']);
  } finally {
    if (saved === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = saved;
  }
});

// ---------------------------------------------------------------------------
// Inputs and errors
// ---------------------------------------------------------------------------

test('schema-invalid SARIF is refused as invalid before any Git work', async () => {
  const outcome = await addStagedChangesToSarif({
    sarif: { version: '2.1.0', runs: 'not runs' },
    worktree: '/nonexistent/worktree',
    reviewedCommit: 'a'.repeat(40),
    repository: REPOSITORY,
  });
  assert.equal(outcome.status, 'invalid');
  assert.ok(outcome.problems.length > 0);
});

test('malformed input is a TypeError', async () => {
  const base = { sarif: sarifWith(), worktree: '/tmp', reviewedCommit: 'a'.repeat(40), repository: REPOSITORY };
  for (const bad of [
    { ...base, extra: 1 },
    { ...base, worktree: 'relative/path' },
    { ...base, reviewedCommit: 'abc123' },
    { ...base, reviewedCommit: 'A'.repeat(40) },
    { ...base, repository: { owner: 'acme' } },
    { ...base, sourceRootUri: 'https://example.com/' },
  ]) {
    await assert.rejects(addStagedChangesToSarif(bad), TypeError, JSON.stringify(Object.keys(bad)));
  }
});

test('environment failures reject with actionable errors', async () => {
  const repo = fixture({ reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'a\n' } });
  await assert.rejects(extract(repo, sarifWith(), { reviewedCommit: 'd'.repeat(40) }), (err) => {
    assert.ok(!(err instanceof TypeError));
    assert.match(err.message, /d{40}/);
    return true;
  });
  const notRepo = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sarif-norepo-'));
  try {
    await assert.rejects(
      addStagedChangesToSarif({ sarif: sarifWith(), worktree: notRepo, reviewedCommit: repo.reviewedCommit, repository: REPOSITORY }),
      /Git working tree/,
    );
  } finally {
    fs.rmSync(notRepo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Additional coverage (added after the first implementation run)
// ---------------------------------------------------------------------------

test('index format v4 (path-compressed) is read exactly', async () => {
  const repo = fixture({
    reviewed: { 'dir/aaa.txt': 'a\n', 'dir/aab.txt': 'b\n', 'dir/abc.txt': 'c\n' },
    staged: { 'dir/aaa.txt': 'a\n', 'dir/aab.txt': 'B\n', 'dir/abc.txt': 'c\n' },
  });
  repo.git(['update-index', '--index-version', '4']);
  const outcome = await extract(repo, sarifWith());
  assert.equal(outcome.status, 'added');
  assert.deepEqual(outcome.receipt.changes.map((c) => c.path), ['dir/aab.txt']);
  assertReproduces(outcome.sarif, 'dir/aab.txt', 'b\n', 'B\n');
});

test('an index written without a trailing checksum (index.skipHash) is accepted', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\n' }, staged: { 'f.txt': 'a\n' } });
  const oid = repo.text(['hash-object', '-w', '--no-filters', '--stdin'], 'A\n');
  repo.git(['-c', 'index.skipHash=true', 'update-index', '--cacheinfo', `100644,${oid},f.txt`]);
  const outcome = await extract(repo, sarifWith());
  assert.deepEqual(replacementsFor(outcome.sarif, 'f.txt').map((r) => r.insertedText), ['A\n']);
});

test('a corrupted index is an operational error, never an empty snapshot', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\n' }, staged: { 'f.txt': 'A\n' } });
  const indexPath = path.join(repo.dir, '.git', 'index');
  const bytes = fs.readFileSync(indexPath);
  bytes[bytes.length - 30] ^= 0xff;
  fs.writeFileSync(indexPath, bytes);
  await assert.rejects(extract(repo, sarifWith()), /index/);
});

test('strict failure: sparse-index directory entries', async (t) => {
  const repo = fixture({
    reviewed: { 'in/a.txt': 'a\n', 'out/b.txt': 'b\n' },
    staged: { 'in/a.txt': 'A\n', 'out/b.txt': 'b\n' },
  });
  repo.git(['config', 'index.sparse', 'true']);
  repo.git(['sparse-checkout', 'init', '--cone']);
  repo.git(['sparse-checkout', 'set', 'in']);
  const listed = repo.git(['ls-files', '--sparse', '--stage']).toString('utf8');
  if (!/^040000 /m.test(listed)) {
    t.skip('this Git did not write sparse-directory entries');
    return;
  }
  const outcome = await extract(repo, sarifWith());
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /sparse/i);
});

test('strict failure: a split index', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\n' }, staged: { 'f.txt': 'A\n' } });
  repo.git(['update-index', '--split-index']);
  const outcome = await extract(repo, sarifWith());
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /split index/i);
});

test('an equal supplied creation proposal explains the staged creation', async () => {
  const repo = fixture({ reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'a\n', 'n.md': 'new\n' } });
  const first = await extract(repo, sarifWith([finding('n.md', { startLine: 1 })]));
  const second = await extract(repo, first.sarif);
  assert.deepEqual(second.sarif, first.sarif);
  assert.deepEqual(second.receipt.changes, [{ path: 'n.md', operation: 'create', associated: [], explainedBy: 'existing-proposal' }]);
});

test('a supplied creation with different content, or a text fix on a created file, conflicts', async () => {
  const repo = fixture({ reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'a\n', 'n.md': 'new\n' } });
  const differing = sarifWith(
    [{ ...finding('n.md', { startLine: 1 }), properties: { sarifToComment: { proposedFileChanges: [{ operation: 'create', artifactIndex: 0 }] } } }],
    { artifacts: [{ location: { uri: 'n.md' }, contents: { text: 'other\n' } }] },
  );
  const a = await extract(repo, differing);
  assert.equal(a.status, 'failed');
  assert.match(a.markdown, /conflicts/);
  const textFixOnCreated = sarifWith([
    { ...finding('a.txt', { startLine: 1 }), fixes: [textFix('n.md', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, 'x')] },
  ]);
  const b = await extract(repo, textFixOnCreated);
  assert.equal(b.status, 'failed');
  assert.match(b.markdown, /n\.md/);
});

test('findings in one run on a created file share one artifact; region-less findings associate too', async () => {
  const repo = fixture({ reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'a\n', 'n.md': 'one\ntwo\n' } });
  const whole = { message: { text: 'Whole file.' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'n.md' } } }] };
  const outcome = await extract(repo, sarifWith([whole, finding('n.md', { startLine: 2 })]));
  assert.equal(outcome.sarif.runs[0].artifacts.length, 1);
  for (const r of outcome.sarif.runs[0].results) {
    assert.deepEqual(r.properties.sarifToComment.proposedFileChanges, [{ operation: 'create', artifactIndex: 0, fileMode: '100644' }]);
  }
});

test('a region-less finding on an edited file is not associated with a text change', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\n' }, staged: { 'f.txt': 'A\n' } });
  const whole = { message: { text: 'About the file.' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'f.txt' } } }] };
  const outcome = await extract(repo, sarifWith([whole]));
  assert.deepEqual(outcome.sarif.runs[0].results[0], whole);
  assert.equal(outcome.receipt.changes[0].replacements[0].explainedBy, 'neutral');
});

test('an absolute file: location resolves through sourceRootUri; an unresolvable one fails', async () => {
  const repo = fixture({ reviewed: { 'src/f.txt': 'a\n' }, staged: { 'src/f.txt': 'A\n' } });
  const located = sarifWith([finding('file:///build/checkout/src/f.txt', { startLine: 1 })]);
  const ok = await extract(repo, located, { sourceRootUri: 'file:///build/checkout/' });
  assert.equal(ok.status, 'added', JSON.stringify(ok.problems));
  assert.deepEqual(ok.receipt.changes[0].replacements[0].associated, ['/runs/0/results/0']);
  const missing = await extract(repo, located);
  assert.equal(missing.status, 'failed');
  assert.match(missing.markdown, /\/runs\/0\/results\/0/);
});

test('a foreign run (provenance names only another repository) is untouched', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\n' }, staged: { 'f.txt': 'A\n' } });
  const foreign = {
    tool: { driver: { name: 'Elsewhere' } },
    versionControlProvenance: [{ repositoryUri: 'https://github.com/other/project', revisionId: repo.reviewedCommit }],
    results: [finding('f.txt', { startLine: 1 })],
  };
  const outcome = await extract(repo, { version: '2.1.0', runs: [foreign] });
  assert.deepEqual(outcome.sarif.runs[0], foreign);
  assert.equal(outcome.receipt.changes[0].replacements[0].explainedBy, 'neutral');
});

test('strict failure: an eligible finding whose run declares non-default newline sequences', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'a\n' }, staged: { 'f.txt': 'A\n' } });
  const outcome = await extract(repo, sarifWith([finding('f.txt', { startLine: 1 })], { newlineSequences: ['\n'] }));
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /newline sequences/);
});

test('strict failure: a region snippet that is not the reviewed text', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'abc\n' }, staged: { 'f.txt': 'ABC\n' } });
  const outcome = await extract(repo, sarifWith([finding('f.txt', { startLine: 1, snippet: { text: 'xyz' } })]));
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.markdown, /snippet/);
});

test('a finding with columns inside the changed line is contained by its line', async () => {
  const repo = fixture({ reviewed: { 'f.txt': 'let a = 1;\nnext\n' }, staged: { 'f.txt': 'let a = 2;\nnext\n' } });
  const outcome = await extract(repo, sarifWith(
    [finding('f.txt', { startLine: 1, startColumn: 9, endColumn: 10, snippet: { text: '1' } })],
    { columnKind: 'utf16CodeUnits' },
  ));
  assert.deepEqual(outcome.receipt.changes[0].replacements[0].associated, ['/runs/0/results/0']);
});

test('findings on an edited file use reviewed coordinates, never staged ones', async () => {
  // Line 3 exists only in the reviewed file; the index deletes lines 1-2.
  const repo = fixture({ reviewed: { 'f.txt': 'a\nb\nc\n' }, staged: { 'f.txt': 'c\n' } });
  const onReviewedLine3 = finding('f.txt', { startLine: 3, snippet: { text: 'c' } });
  const outcome = await extract(repo, sarifWith([onReviewedLine3]));
  assert.equal(outcome.status, 'added', JSON.stringify(outcome.problems));
  assert.deepEqual(outcome.sarif.runs[0].results[0], onReviewedLine3, 'unchanged line 3 is not part of the change');
  assert.deepEqual(outcome.receipt.changes[0].replacements, [{ startLine: 1, endLine: 2, associated: [], explainedBy: 'neutral' }]);
});

test('the Git file-mode table is frozen with the index-format values', () => {
  // git index-format: 0100644 regular, 0100755 executable, 0120000 symbolic
  // link, 0160000 gitlink; 040000 is a tree. Extraction classifies every
  // change by this shared table, so no caller may alter it at run time.
  assert.deepStrictEqual({ ...MODE }, { REGULAR: 0o100644, EXECUTABLE: 0o100755, SYMLINK: 0o120000, GITLINK: 0o160000, DIRECTORY: 0o040000 });
  assert.equal(Object.isFrozen(MODE), true);
  assert.throws(() => {
    MODE.REGULAR = 0;
  }, TypeError);
});
