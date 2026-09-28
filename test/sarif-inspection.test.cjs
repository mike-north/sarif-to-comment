'use strict';

/**
 * Contract tests for complete, read-only SARIF inspection
 * (src/sarif-inspection.cjs).
 *
 * Inspection simplifies structure without discarding evidence:
 * - every finding, its full message, every location and every included fix
 *   and file proposal appear, including ones the publisher cannot accept;
 * - only fix and proposal previews may shorten, and when they do the
 *   shortening is explicit;
 * - the input SARIF is never changed;
 * - nothing in the view claims publication readiness.
 *
 * Expected views are written by hand from the contract (§3.3) and the fixture
 * (test/fixtures/sarif-inspection/upstream.sarif.json), never captured from
 * the implementation.
 *
 * @see docs/second-milestone-contract-proposal.md §3.3, §8 (test 4)
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 */

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { inspectSarif, renderInspectionText } = require('../dist/sarif-inspection.cjs');
const { createSarifDocument, addSarifComment } = require('../dist/sarif-authoring.cjs');
const { prepareReview } = require('../dist/prepare-review.cjs');

const UPSTREAM = path.join(__dirname, 'fixtures', 'sarif-inspection', 'upstream.sarif.json');
const loadUpstream = () => JSON.parse(fs.readFileSync(UPSTREAM, 'utf8'));
const HEAD = 'c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de';
const ROOT = 'file:///work/app/';

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** A complete preview of a text: every line and character shown. */
function complete(text, lines) {
  return { state: 'complete', text, totalLines: lines, totalChars: text.length, shownLines: lines, shownChars: text.length };
}

/** The run's evidence other than the named fields, as the contract requires it be retained. */
function runOther(run) {
  const { results, columnKind, versionControlProvenance, ...rest } = run;
  return rest;
}

const upstream = loadUpstream();

// ---------------------------------------------------------------------------
// Hand-authored expected findings for the upstream fixture with a source root.

const EXPECTED_FINDINGS = [
  {
    ref: '/runs/0/results/0', runIndex: 0, resultIndex: 0, ruleId: 'no-unused-vars',
    message: { id: 'unused', text: "'x' is defined but never used.", resolved: true },
    locations: [{
      path: 'src/app.js', artifactLocation: { uri: 'app.js', uriBaseId: 'SRC' }, uri: 'app.js', uriBaseId: 'SRC',
      startLine: 3, startColumn: 7, endColumn: 8, snippet: 'x',
    }],
    relatedLocations: [],
    otherContent: { partialFingerprints: { primaryLocationLineHash: 'abc123:1' } },
    fixes: [{
      ref: '/runs/0/results/0/fixes/0', description: 'Remove x',
      changes: [{
        path: 'src/app.js', uri: 'app.js', artifactLocation: { uri: 'app.js', uriBaseId: 'SRC' },
        replacements: [{ deletedRegion: { startLine: 3, startColumn: 1, endLine: 4, endColumn: 1 }, inserted: complete('', 0) }],
      }],
    }],
    fileProposals: [],
  },
  {
    ref: '/runs/0/results/1', runIndex: 0, resultIndex: 1, ruleId: 'eqeqeq', level: 'error', kind: 'fail',
    approval: 'awaiting-approval',
    message: { text: 'Prefer ===.', resolved: true },
    locations: [],
    relatedLocations: [],
    otherContent: { properties: { sarifToComment: { approval: 'awaiting-approval' } } },
    fixes: ['===', '!=='].map((text, k) => ({
      ref: `/runs/0/results/1/fixes/${k}`,
      changes: [{
        path: 'lib/util.js', uri: 'lib/util.js', artifactLocation: { index: 0 },
        replacements: [{ deletedRegion: { startLine: 5, startColumn: 9, endColumn: 11 }, inserted: complete(text, 1) }],
      }],
    })),
    fileProposals: [],
  },
  {
    ref: '/runs/0/results/2', runIndex: 0, resultIndex: 2, ruleId: 'SEC1', baselineState: 'new',
    message: { id: 'm', text: 'Tainted input.', markdown: 'Tainted **input**.', resolved: true },
    locations: [
      { path: 'lib/util.js', artifactLocation: { index: 0 }, uri: 'lib/util.js', startLine: 10, endLine: 12,
        message: 'sink', logical: [{ fullyQualifiedName: 'util.run' }] },
      { path: 'lib/util.js', artifactLocation: { uri: 'lib/util.js' }, uri: 'lib/util.js', startLine: 20,
        otherContent: { physicalLocation: { contextRegion: { startLine: 18, endLine: 22 } } } },
    ],
    relatedLocations: [
      { path: 'lib/source.js', artifactLocation: { uri: 'lib/source.js' }, uri: 'lib/source.js', startLine: 2,
        message: 'source', otherContent: { location: { id: 1 } } },
    ],
    otherContent: {
      rule: { id: 'SEC1', toolComponent: { index: 0 } },
      codeFlows: upstream.runs[0].results[2].codeFlows,
      suppressions: [{ kind: 'inSource' }],
    },
    fixes: [],
    fileProposals: [],
  },
  {
    ref: '/runs/0/results/3', runIndex: 0, resultIndex: 3,
    message: { text: 'Update both files.', resolved: true },
    locations: [],
    relatedLocations: [],
    otherContent: {},
    fixes: [{
      ref: '/runs/0/results/3/fixes/0',
      changes: [
        { path: 'lib/a.js', uri: 'lib/a.js', artifactLocation: { uri: 'lib/a.js' },
          replacements: [{ deletedRegion: { startLine: 1 }, inserted: complete('a\n', 1) }] },
        { path: 'assets/logo.png', uri: 'assets/logo.png', artifactLocation: { uri: 'assets/logo.png' },
          replacements: [{ deletedRegion: { byteOffset: 0, byteLength: 4 }, inserted: { state: 'unavailable', byteLength: 8 } }] },
      ],
    }],
    fileProposals: [],
  },
  {
    ref: '/runs/0/results/4', runIndex: 0, resultIndex: 4,
    message: { text: 'Add docs page and drop old file.', resolved: true },
    locations: [],
    relatedLocations: [],
    otherContent: { properties: upstream.runs[0].results[4].properties },
    fixes: [],
    fileProposals: [
      { ref: '/runs/0/results/4/properties/sarifToComment/proposedFileChanges/0', operation: 'create', artifactIndex: 1,
        path: 'docs/new.md', fileMode: '100644', content: complete('# New\n\nBody\n', 3) },
      { ref: '/runs/0/results/4/properties/sarifToComment/proposedFileChanges/1', operation: 'delete', artifactIndex: 2, path: 'old.txt' },
      { ref: '/runs/0/results/4/properties/sarifToComment/proposedFileChanges/2', operation: 'transmogrify', artifactIndex: 3,
        path: 'assets/logo.png', otherContent: { extra: 'x' } },
    ],
  },
  {
    ref: '/runs/0/results/5', runIndex: 0, resultIndex: 5,
    message: { id: 'missing', resolved: false },
    locations: [{ path: null, artifactLocation: { uri: 'file:///elsewhere/x.js' }, uri: 'file:///elsewhere/x.js', startLine: 1 }],
    relatedLocations: [],
    otherContent: {},
    fixes: [],
    fileProposals: [],
  },
  {
    ref: '/runs/1/results/0', runIndex: 1, resultIndex: 0, level: 'warning',
    message: { text: 'Handle the empty-input case.\n\nSecond paragraph.', resolved: true },
    locations: [{ path: 'src/parse.js', artifactLocation: { uri: 'src/parse.js' }, uri: 'src/parse.js', startLine: 2, endLine: 3 }],
    relatedLocations: [],
    otherContent: {},
    fixes: [],
    fileProposals: [],
  },
];

const EXPECTED_RUNS = [
  { index: 0, ref: '/runs/0', tool: { name: 'ESLint', version: '9.1.0' }, source: { state: 'unbound', provenance: [] },
    columnKind: 'utf16CodeUnits', approval: 'ready', otherContent: runOther(upstream.runs[0]) },
  { index: 1, ref: '/runs/1', tool: { name: 'Review agent' },
    source: { state: 'declared', provenance: upstream.runs[1].versionControlProvenance },
    columnKind: 'utf16CodeUnits', otherContent: runOther(upstream.runs[1]) },
];

describe('inspectSarif: a complete view of upstream SARIF', () => {
  const inspect = () => inspectSarif(loadUpstream(), { sourceRootUri: ROOT });

  test('the outcome is an inspection with exactly the contract\'s top-level fields', () => {
    const outcome = inspect();
    assert.equal(outcome.status, 'inspected');
    assert.deepStrictEqual(Object.keys(outcome).sort(), ['status', 'view']);
    assert.deepStrictEqual(Object.keys(outcome.view).sort(), ['diagnostics', 'findings', 'format', 'runs', 'summary', 'version']);
    assert.equal(outcome.view.format, 'sarif-to-comment.inspection');
    assert.equal(outcome.view.version, 1);
  });

  test('view fields serialize in a stable order', () => {
    // The view is printed as-is by `inspect --format json`, so its field
    // order is user-visible. The outcome, view, summary, run and finding
    // orders are the contract's (§3.3 SarifInspection); optional fields sit
    // in their contract position only when present. The nested orders below
    // (message, location, fix, preview, file proposal) are characterization
    // of 0.2.0, which the contract does not fix.
    const outcome = inspect();
    const { view } = outcome;
    assert.deepStrictEqual(Object.keys(outcome), ['status', 'view']);
    assert.deepStrictEqual(Object.keys(view), ['format', 'version', 'summary', 'runs', 'findings', 'diagnostics']);
    assert.deepStrictEqual(Object.keys(view.summary), ['runs', 'findings', 'fixes', 'fileProposals', 'truncatedPreviews']);
    assert.deepStrictEqual(Object.keys(view.runs[0]), ['index', 'ref', 'tool', 'source', 'columnKind', 'approval', 'otherContent']);
    assert.deepStrictEqual(Object.keys(view.runs[1]), ['index', 'ref', 'tool', 'source', 'columnKind', 'otherContent']);
    assert.deepStrictEqual(Object.keys(view.findings[1]), [
      'ref', 'runIndex', 'resultIndex', 'ruleId', 'level', 'kind', 'approval',
      'message', 'locations', 'relatedLocations', 'otherContent', 'fixes', 'fileProposals',
    ]);
    assert.deepStrictEqual(Object.keys(view.findings[3]), [
      'ref', 'runIndex', 'resultIndex', 'message', 'locations', 'relatedLocations', 'otherContent', 'fixes', 'fileProposals',
    ], 'absent optional fields are omitted, not present as undefined');
    assert.deepStrictEqual(Object.keys(view.findings[2].message), ['id', 'text', 'markdown', 'resolved']);
    assert.deepStrictEqual(Object.keys(view.findings[0].locations[0]),
      ['path', 'artifactLocation', 'uri', 'uriBaseId', 'startLine', 'startColumn', 'endColumn', 'snippet']);
    assert.deepStrictEqual(Object.keys(view.findings[2].locations[0]),
      ['path', 'artifactLocation', 'uri', 'startLine', 'endLine', 'message', 'logical']);
    const [fix] = view.findings[0].fixes;
    assert.deepStrictEqual(Object.keys(fix), ['ref', 'description', 'changes']);
    assert.deepStrictEqual(Object.keys(fix.changes[0]), ['path', 'uri', 'artifactLocation', 'replacements']);
    assert.deepStrictEqual(Object.keys(fix.changes[0].replacements[0]), ['deletedRegion', 'inserted']);
    assert.deepStrictEqual(Object.keys(fix.changes[0].replacements[0].inserted),
      ['state', 'text', 'totalLines', 'totalChars', 'shownLines', 'shownChars']);
    assert.deepStrictEqual(view.findings[4].fileProposals.map((p) => Object.keys(p)), [
      ['ref', 'operation', 'artifactIndex', 'path', 'fileMode', 'content'],
      ['ref', 'operation', 'artifactIndex', 'path'],
      ['ref', 'operation', 'artifactIndex', 'path', 'otherContent'],
    ]);
    assert.deepStrictEqual(Object.keys(view.diagnostics[0]), ['severity', 'message', 'pointer']);
    // The refusal outcome, in contract order (§3.3 InspectOutcome).
    assert.deepStrictEqual(Object.keys(inspectSarif({ version: '2.1.0', runs: [{ results: [] }] })), ['status', 'problems', 'markdown']);
  });

  test('summary counts every run, finding, fix and file proposal', () => {
    assert.deepStrictEqual(inspect().view.summary, { runs: 2, findings: 7, fixes: 4, fileProposals: 3, truncatedPreviews: 0 });
  });

  test('runs report tool, declared provenance facts, column kind, approval and all other run content', () => {
    assert.deepStrictEqual(inspect().view.runs, EXPECTED_RUNS);
  });

  EXPECTED_FINDINGS.forEach((expected, i) => {
    test(`finding ${expected.ref} is complete`, () => {
      assert.deepStrictEqual(inspect().view.findings[i], expected);
    });
  });

  test('unresolvable messages and paths and unknown owned operations are warnings with pointers', () => {
    const { diagnostics } = inspect().view;
    for (const d of diagnostics) {
      assert.equal(d.severity, 'warning');
      assert.ok(typeof d.message === 'string' && d.message.length > 0);
    }
    assert.deepStrictEqual(diagnostics.map((d) => d.pointer).sort(), [
      '/runs/0/results/4/properties/sarifToComment/proposedFileChanges/2',
      '/runs/0/results/5/locations/0',
      '/runs/0/results/5/message',
    ]);
  });

  test('without a source root, root-relative references stay unresolved but are kept whole', () => {
    const { view } = inspectSarif(loadUpstream());
    assert.deepStrictEqual(view.findings[0].locations[0],
      { path: null, artifactLocation: { uri: 'app.js', uriBaseId: 'SRC' }, uri: 'app.js', uriBaseId: 'SRC', startLine: 3, startColumn: 7, endColumn: 8, snippet: 'x' });
    assert.equal(view.findings[0].fixes[0].changes[0].path, null);
    assert.ok(view.diagnostics.some((d) => d.pointer === '/runs/0/results/0/locations/0'));
    assert.ok(view.diagnostics.some((d) => d.pointer === '/runs/0/results/0/fixes/0/artifactChanges/0'));
  });

  test('the input SARIF is untouched and the view is plain JSON', () => {
    const input = deepFreeze(loadUpstream());
    const before = JSON.stringify(input);
    const { view } = inspectSarif(input, { sourceRootUri: ROOT });
    assert.equal(JSON.stringify(input), before);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(view)), view);
  });

  test('the view makes no readiness or publication claim of its own (producer content aside)', () => {
    const keys = new Set();
    const walk = (value) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (Array.isArray(value)) { walk(child); continue; }
        keys.add(key);
        if (key !== 'otherContent' && key !== 'provenance' && key !== 'deletedRegion') walk(child);
      }
    };
    walk(inspect().view);
    for (const key of keys) assert.ok(!/ready|publish|blocked|eligible|status|valid/i.test(key), `view key ${key}`);
  });
});

describe('inspectSarif: previews shorten only fix content, visibly', () => {
  const thirtyLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join('');
  const withInserted = (text) => ({
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'T' } }, results: [{ message: { text: 'm' }, fixes: [{ artifactChanges: [{
      artifactLocation: { uri: 'a.txt' }, replacements: [{ deletedRegion: { startLine: 1 }, insertedContent: { text } }] }] }] }] }],
  });
  const preview = (text, options) => inspectSarif(withInserted(text), options).view.findings[0].fixes[0].changes[0].replacements[0].inserted;

  test('the default 20-line limit shows whole lines and exact counts', () => {
    const shown = thirtyLines.split('\n').slice(0, 20).join('\n') + '\n';
    assert.deepStrictEqual(preview(thirtyLines),
      { state: 'truncated', text: shown, totalLines: 30, totalChars: thirtyLines.length, shownLines: 20, shownChars: shown.length });
  });

  test('a truncated preview is counted in the summary, and the SARIF keeps the full text', () => {
    const sarif = deepFreeze(withInserted(thirtyLines));
    const { view } = inspectSarif(sarif);
    assert.equal(view.summary.truncatedPreviews, 1);
    assert.equal(sarif.runs[0].results[0].fixes[0].artifactChanges[0].replacements[0].insertedContent.text, thirtyLines);
  });

  test('null limits show everything', () => {
    assert.deepStrictEqual(preview(thirtyLines, { previewLines: null, previewChars: null }), complete(thirtyLines, 30));
  });

  test('a character limit keeps whole lines when a whole line fits', () => {
    assert.deepStrictEqual(preview('abc\ndef\nghi\n', { previewChars: 9 }),
      { state: 'truncated', text: 'abc\ndef\n', totalLines: 3, totalChars: 12, shownLines: 2, shownChars: 8 });
  });

  test('a first line longer than the character limit is cut within it, never splitting a surrogate pair', () => {
    assert.deepStrictEqual(preview('ab🎉cd\n', { previewChars: 3 }),
      { state: 'truncated', text: 'ab', totalLines: 1, totalChars: 7, shownLines: 1, shownChars: 2 });
    assert.deepStrictEqual(preview('abcdef\n', { previewChars: 4 }),
      { state: 'truncated', text: 'abcd', totalLines: 1, totalChars: 7, shownLines: 1, shownChars: 4 });
  });

  test('a final line without a newline counts as a line', () => {
    assert.deepStrictEqual(preview('a\nb', { previewLines: 1 }),
      { state: 'truncated', text: 'a\n', totalLines: 2, totalChars: 3, shownLines: 1, shownChars: 2 });
    assert.deepStrictEqual(preview('a\nb'), complete('a\nb', 2));
  });

  test('messages are never shortened, however long', () => {
    const long = 'word '.repeat(5000);
    const sarif = { version: '2.1.0', runs: [{ tool: { driver: { name: 'T' } }, results: [{ message: { text: long } }] }] };
    assert.equal(inspectSarif(sarif, { previewChars: 10 }).view.findings[0].message.text, long);
  });

  test('file-proposal content previews follow the same limits', () => {
    const sarif = { version: '2.1.0', runs: [{ tool: { driver: { name: 'T' } },
      artifacts: [{ location: { uri: 'new.txt' }, contents: { text: thirtyLines } }],
      results: [{ message: { text: 'm' }, properties: { sarifToComment: { proposedFileChanges: [{ operation: 'create', artifactIndex: 0 }] } } }] }] };
    const { view } = inspectSarif(sarif, { previewLines: 5 });
    assert.equal(view.findings[0].fileProposals[0].content.state, 'truncated');
    assert.equal(view.findings[0].fileProposals[0].content.shownLines, 5);
    assert.equal(view.summary.truncatedPreviews, 1);
  });

  for (const options of [{ previewLines: 0 }, { previewLines: -1 }, { previewLines: 1.5 }, { previewLines: 'all' }, { previewChars: 0 },
    { sourceRootUri: 'work/app/' }, { sourceRootUri: 'file:///work/app' }, { depth: 2 }, 'x']) {
    test(`malformed options are a TypeError: ${JSON.stringify(options)}`, () => {
      assert.throws(() => inspectSarif(withInserted('x'), options), TypeError);
    });
  }
});

describe('inspectSarif: refusals', () => {
  test('schema-invalid SARIF is refused as invalid, not interpreted best-effort', () => {
    const outcome = inspectSarif({ version: '2.1.0', runs: [{ tool: { driver: { name: 'T' } }, results: [{ ruleId: 'R' }] }] });
    assert.equal(outcome.status, 'invalid');
    assert.ok(outcome.problems.length > 0 && typeof outcome.markdown === 'string');
    assert.equal(outcome.view, undefined);
  });

  test('non-object or non-JSON SARIF is a TypeError', () => {
    assert.throws(() => inspectSarif('{}'), TypeError);
    assert.throws(() => inspectSarif(null), TypeError);
    const cyclic = { version: '2.1.0', runs: [] };
    cyclic.self = cyclic;
    assert.throws(() => inspectSarif(cyclic), TypeError);
  });
});

describe('inspectSarif: authored and upstream SARIF alike', () => {
  test('an authored single-line and range comment round-trip with full text', () => {
    let doc = createSarifDocument({ tool: { name: 'Review agent' }, source: { owner: 'acme', repo: 'widgets', commit: HEAD } });
    doc = addSarifComment(doc, { file: 'docs/guide notes/Überblick.md', line: 2, message: 'First.' }).sarif;
    doc = addSarifComment(doc, { file: 'src/app.js', line: 16, endLine: 18, message: 'Use **bold**.', messageFormat: 'markdown', level: 'note' }).sarif;
    const { view } = inspectSarif(doc);
    assert.deepStrictEqual(view.findings.map((f) => ({ message: f.message, locations: f.locations.map((l) => [l.path, l.startLine, l.endLine]), level: f.level })), [
      { message: { text: 'First.', resolved: true }, locations: [['docs/guide notes/Überblick.md', 2, undefined]], level: undefined },
      { message: { text: 'Use **bold**.', markdown: 'Use **bold**.', resolved: true }, locations: [['src/app.js', 16, 18]], level: 'note' },
    ]);
    assert.deepStrictEqual(view.runs[0].source, { state: 'declared', provenance: [{ repositoryUri: 'https://github.com/acme/widgets', revisionId: HEAD }] });
  });

  test('located paths agree with where the publisher reads source', async () => {
    const sarif = {
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'T' } },
        originalUriBaseIds: { ROOT: { uri: ROOT }, SRC: { uri: 'src/', uriBaseId: 'ROOT' } },
        artifacts: [{ location: { uri: 'lib/util.js' } }],
        results: [
          { message: { text: 'a' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'app.js', uriBaseId: 'SRC' }, region: { startLine: 1 } } }] },
          { message: { text: 'b' }, locations: [{ physicalLocation: { artifactLocation: { index: 0 }, region: { startLine: 2 } } }] },
          { message: { text: 'c' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'docs/guide%20notes/%C3%9Cberblick.md' }, region: { startLine: 1 } } }] },
        ],
      }],
    };
    const reads = [];
    const outcome = await prepareReview({
      sarif,
      context: { owner: 'acme', repo: 'widgets', pullNumber: 1, reviewedCommit: HEAD, sourceRootUri: ROOT,
        diff: { baseCommit: 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e', headCommit: HEAD, files: [] } },
      readSource: async (commit, p) => { reads.push(p); return 'one\ntwo\n'; },
    });
    assert.equal(outcome.status, 'ready', JSON.stringify(outcome.diagnostics));
    const { view } = inspectSarif(sarif, { sourceRootUri: ROOT });
    assert.deepStrictEqual(view.findings.map((f) => f.locations[0].path), reads);
    assert.deepStrictEqual(outcome.evidence.map((e) => [e.source.path, e.source.startLine]),
      view.findings.map((f) => [f.locations[0].path, f.locations[0].startLine]));
  });
});

describe('renderInspectionText: one human rendering of the same view', () => {
  test('shows full text, tool, locations or "general", and grouped fixes with explicit truncation markers', () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const sarif = loadUpstream();
    sarif.runs[0].results[3].fixes[0].artifactChanges[0].replacements[0].insertedContent.text = long;
    const { view } = inspectSarif(sarif, { sourceRootUri: ROOT });
    const text = renderInspectionText(view);
    assert.equal(typeof text, 'string');
    for (const expected of [
      'Handle the empty-input case.\n\nSecond paragraph.',
      "'x' is defined but never used.",
      'ESLint 9.1.0',
      'Review agent',
      'general',
      'src/parse.js:2-3',
      'src/app.js:3',
      '(truncated: 20 of 30 lines shown)',
      'binary content, 8 bytes, not shown',
      'transmogrify',
      'docs/new.md',
    ]) {
      assert.ok(text.includes(expected), `human rendering lacks ${JSON.stringify(expected)}`);
    }
    assert.ok(text.includes('approval: ready'), 'the declared approval state is shown as declared');
    assert.ok(!/ready to publish|publishable|will publish/i.test(text), 'no readiness claim');
  });
});

// ---------------------------------------------------------------------------
// Evidence-fidelity regressions: no message alternative, argument, metadata
// or nested evidence may be lost from the JSON view or the human rendering.

const EVIDENCE = path.join(__dirname, 'fixtures', 'sarif-inspection', 'evidence.sarif.json');
const loadEvidence = () => JSON.parse(fs.readFileSync(EVIDENCE, 'utf8'));

/** Every string leaf of a value, with the pointer where it occurs. */
function stringLeaves(value, pointer = '', into = []) {
  if (typeof value === 'string') into.push([pointer, value]);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) stringLeaves(child, `${pointer}/${key}`, into);
  }
  return into;
}

/**
 * Whether the human text shows a string: verbatim, JSON-escaped (inside a
 * rendered JSON block), or line by line (inside a prefixed preview or block).
 */
function shows(text, value) {
  if (text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1))) return true;
  const lines = value.split('\n').filter((line) => line.trim() !== '');
  return lines.length > 0 && lines.every((line) => text.includes(line));
}

/** View fields that are rendering vocabulary rather than SARIF evidence. */
const VOCABULARY = new Set(['/format', 'state', 'severity']);

function assertHumanShowsEveryString(view) {
  const text = renderInspectionText(view);
  const missing = stringLeaves(view).filter(([pointer, value]) => {
    const key = pointer.slice(pointer.lastIndexOf('/') + 1);
    if (VOCABULARY.has(pointer) || VOCABULARY.has(key)) return false;
    return !shows(text, value);
  });
  assert.deepStrictEqual(missing, [], 'the human rendering omits evidence that the JSON view holds');
  return text;
}

describe('regression: message alternatives, arguments and metadata are never discarded', () => {
  const inspect = () => inspectSarif(loadEvidence()).view;

  test('a location message keeps its string and gains its Markdown alternative', () => {
    const location = inspect().findings[0].locations[0];
    assert.equal(location.message, 'short label');
    assert.deepStrictEqual(location.messageContent,
      { text: 'short label', markdown: 'Read **critical alternate explanation**', resolved: true });
  });

  test('a fix description keeps its string and gains its Markdown alternative', () => {
    const fix = inspect().findings[0].fixes[0];
    assert.equal(fix.description, 'short fix');
    assert.deepStrictEqual(fix.descriptionContent,
      { text: 'short fix', markdown: 'Retain **critical alternative rationale**', resolved: true });
  });

  test('a plain resolved location message adds no redundant content object', () => {
    const { view } = inspectSarif(loadUpstream(), { sourceRootUri: ROOT });
    assert.equal(view.findings[2].locations[0].message, 'sink');
    assert.equal(view.findings[2].locations[0].messageContent, undefined);
  });

  test('an unresolved message id keeps its arguments', () => {
    assert.deepStrictEqual(inspect().findings[1].message, { id: 'nope', arguments: ['arg-alpha', 'arg-beta'], resolved: false });
  });

  test('an unresolved location message id keeps its id and arguments', () => {
    const location = inspect().findings[1].locations[0];
    assert.equal(location.message, undefined);
    assert.deepStrictEqual(location.messageContent, { id: 'location-nope', arguments: ['loc-arg'], resolved: false });
  });

  test('a message with a missing argument keeps its template and the supplied arguments', () => {
    assert.deepStrictEqual(inspect().findings[2].message,
      { text: 'Needs only-one and {1}', arguments: ['only-one'], resolved: false });
  });

  test('message metadata is retained', () => {
    assert.deepStrictEqual(inspect().findings[3].message,
      { text: 'Message with metadata.', resolved: true, otherContent: { properties: { 'acme/tag': 'message-property-value' } } });
  });

  test('an unknown owned operation keeps every detail', () => {
    assert.deepStrictEqual(inspect().findings[4].fileProposals, [{
      ref: '/runs/0/results/4/properties/sarifToComment/proposedFileChanges/0', operation: 'rename', artifactIndex: 0,
      path: 'lib/old.js', otherContent: { targetUri: 'new/place.js', reason: 'moved-for-layering' },
    }]);
  });
});

describe('regression: the human rendering shows the same evidence as the JSON view', () => {
  test('every string in the evidence fixture\'s view appears in the human text', () => {
    const text = assertHumanShowsEveryString(inspectSarif(loadEvidence()).view);
    for (const expected of [
      'Read **critical alternate explanation**', 'Retain **critical alternative rationale**',
      '?run@util@@YAXXZ', 'kind: function', 'context snippet text', 'flow step message', 'fingerprint-value',
      'arg-alpha', 'arg-beta', 'loc-arg', 'new/place.js', 'moved-for-layering', 'high-confidence-value',
      'change-property-value', 'replacement-property-value', 'artifact description text', 'notification text here',
      'rule short description', 'message-property-value',
    ]) {
      assert.ok(text.includes(expected), `human rendering lacks ${JSON.stringify(expected)}`);
    }
  });

  test('every string in the upstream fixture\'s view appears in the human text', () => {
    assertHumanShowsEveryString(inspectSarif(loadUpstream(), { sourceRootUri: ROOT }).view);
    assertHumanShowsEveryString(inspectSarif(loadUpstream()).view);
  });

  test('the human rendering never dumps whole runs or findings as raw SARIF', () => {
    const text = renderInspectionText(inspectSarif(loadEvidence()).view);
    // Nested evidence such as code flows legitimately contains locations, so
    // only markers of a whole result or run being dumped are forbidden.
    for (const raw of ['"results"', '"ruleId"', '"fixes"', '"artifactChanges"']) {
      assert.ok(!text.includes(raw), `human rendering dumps ${raw}`);
    }
  });
});

test('regression: an unknown operation\'s details are shown with its proposal, not only in raw properties', () => {
  const text = renderInspectionText(inspectSarif(loadEvidence()).view);
  const proposal = text.indexOf('File proposal (/runs/0/results/4/properties/sarifToComment/proposedFileChanges/0): rename lib/old.js');
  assert.ok(proposal !== -1, text);
  const block = text.slice(proposal, text.indexOf('Other finding evidence', proposal));
  assert.ok(block.includes('Other proposal details') && block.includes('"targetUri": "new/place.js"') && block.includes('moved-for-layering'), block);
});

// ---------------------------------------------------------------------------
// Log-level and content-level evidence must remain visible without inventing
// relationships between embedded properties and the normalized findings.

const LOG_EVIDENCE = path.join(__dirname, 'fixtures', 'sarif-inspection', 'log-evidence.sarif.json');
const loadLogEvidence = () => JSON.parse(fs.readFileSync(LOG_EVIDENCE, 'utf8'));

describe('regression: log-level evidence is retained', () => {
  const inspect = () => inspectSarif(loadLogEvidence()).view;

  test('log properties appear in the view', () => {
    assert.deepStrictEqual(inspect().log, { otherContent: { properties: { producerRunId: 'ci-42', note: 'log-level metadata' } } });
  });

  test('inline external properties are kept verbatim, without inventing a run association', () => {
    const source = loadLogEvidence().inlineExternalProperties;
    assert.deepStrictEqual(inspect().externalProperties, [
      { ref: '/inlineExternalProperties/0', results: 2, content: source[0] },
      { ref: '/inlineExternalProperties/1', results: 0, content: source[1] },
    ]);
  });

  test('the summary counts embedded findings separately, so it never implies they are absent', () => {
    assert.deepStrictEqual(inspect().summary,
      { runs: 1, findings: 2, fixes: 1, fileProposals: 1, truncatedPreviews: 0, externalFindings: 2 });
    assert.ok(inspect().findings.every((f) => f.message.text !== 'a finding kept in external properties'));
  });

  test('embedded results and unloaded external property files are explained as warnings', () => {
    const pointers = inspect().diagnostics.map((d) => d.pointer).sort();
    assert.deepStrictEqual(pointers, ['/inlineExternalProperties/0', '/runs/0/externalPropertyFileReferences']);
  });

  test('a declared external run association is preserved without claiming it is absent', () => {
    const source = loadLogEvidence();
    const runGuid = '12345678-1234-4234-8234-123456789abc';
    source.runs[0].automationDetails = { guid: runGuid };
    source.inlineExternalProperties[0].runGuid = runGuid;
    const outcome = inspectSarif(source);
    assert.equal(outcome.status, 'inspected');
    assert.equal(outcome.view.externalProperties[0].content.runGuid, runGuid);
    const diagnostic = outcome.view.diagnostics.find((item) => item.pointer === '/inlineExternalProperties/0');
    assert.doesNotMatch(diagnostic.message, /no run association|belong to no run/);
    assert.match(diagnostic.message, /does not merge/);
    assert.ok(renderInspectionText(outcome.view).includes(runGuid));
  });

  test('a log with no log-level evidence gains no new fields', () => {
    const { view } = inspectSarif(loadUpstream(), { sourceRootUri: ROOT });
    assert.equal(view.log, undefined);
    assert.equal(view.externalProperties, undefined);
    assert.equal(view.summary.externalFindings, undefined);
  });
});

describe('regression: artifact-content metadata is retained', () => {
  const replacements = () => inspectSarif(loadLogEvidence()).view.findings[0].fixes[0].changes[0].replacements;

  test('insertedContent properties and rendered form accompany the text preview', () => {
    assert.deepStrictEqual(replacements()[0].inserted, {
      state: 'complete', text: 'new\n', totalLines: 1, totalChars: 4, shownLines: 1, shownChars: 4,
      otherContent: { properties: { rationale: 'kept?' }, rendered: { text: 'rendered form' } },
    });
  });

  test('a binary alternative is kept when the text is previewed', () => {
    assert.deepStrictEqual(replacements()[1].inserted.otherContent, { binary: 'Ym90aAo=' });
  });

  test('proposed file content keeps its rendered form', () => {
    const [proposal] = inspectSarif(loadLogEvidence()).view.findings[1].fileProposals;
    assert.deepStrictEqual(proposal.content.otherContent, { rendered: { text: 'rendered artifact form' } });
  });

  test('plain text content gains no otherContent', () => {
    const { view } = inspectSarif(loadUpstream(), { sourceRootUri: ROOT });
    assert.equal(view.findings[1].fixes[0].changes[0].replacements[0].inserted.otherContent, undefined);
  });
});

describe('regression: the human rendering shows log-level and content evidence', () => {
  test('every string in the view appears in the human text, and embedded findings are called out', () => {
    const text = assertHumanShowsEveryString(inspectSarif(loadLogEvidence()).view);
    for (const expected of ['ci-42', 'log-level metadata', 'a finding kept in external properties', 'a second embedded finding',
      'kept?', 'rendered form', 'rendered artifact form', 'Ym90aAo=', 'results.sarif-external-properties.json']) {
      assert.ok(text.includes(expected), `human rendering lacks ${JSON.stringify(expected)}`);
    }
    assert.ok(text.includes('2 embedded finding(s) in inline external properties'), text.split('\n')[0]);
  });
});
