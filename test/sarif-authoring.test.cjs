'use strict';

/**
 * Contract tests for optional, freestanding SARIF authoring
 * (src/sarif-authoring.cjs): createSarifDocument and addSarifComment.
 *
 * Expected documents are written by hand from the accepted contract (§3.1,
 * §3.2). Authoring is pure: no source, Git, GitHub or file access. Inputs are
 * never mutated, every existing finding, attribution and metadata is
 * preserved, and the output is ordinary schema-valid SARIF that the unchanged
 * publisher accepts directly.
 *
 * @see docs/second-milestone-contract-proposal.md §1, §3.1, §3.2, §8 (tests 1-2)
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 * @see https://www.rfc-editor.org/rfc/rfc3986#section-2.1
 */

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSarifDocument, addSarifComment } = require('../src/sarif-authoring.cjs');
const { validateSarif } = require('../src/sarif-common.cjs');
const { prepareReview } = require('../src/prepare-review.cjs');

const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
const SCHEMA_URI = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';
const HEAD = 'c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de';
const BASE = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e';
const UPSTREAM = path.join(__dirname, 'fixtures', 'sarif-inspection', 'upstream.sarif.json');
const loadUpstream = () => JSON.parse(fs.readFileSync(UPSTREAM, 'utf8'));

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Every object/array reachable from a value. */
function objectsOf(value, into = new Set()) {
  if (value && typeof value === 'object') {
    into.add(value);
    Object.values(value).forEach((v) => objectsOf(v, into));
  }
  return into;
}

function assertSharesNothing(output, input) {
  const inputs = objectsOf(input);
  for (const o of objectsOf(output)) assert.ok(!inputs.has(o), 'the output shares an object with the input');
}

describe('createSarifDocument', () => {
  test('default document: exactly the contract shape, attributed to this package at its runtime version', () => {
    const expected = `{"$schema":"${SCHEMA_URI}","version":"2.1.0","runs":[{"tool":{"driver":{"name":"sarif-to-comment","version":"${PACKAGE_VERSION}"}},"columnKind":"utf16CodeUnits","results":[]}]}`;
    assert.equal(JSON.stringify(createSarifDocument()), expected);
    assert.equal(JSON.stringify(createSarifDocument({})), expected);
  });

  test('a caller-named tool without a version never borrows this package\'s version', () => {
    assert.deepStrictEqual(createSarifDocument({ tool: { name: 'Claude review agent' } }).runs[0].tool,
      { driver: { name: 'Claude review agent' } });
  });

  test('a caller-named tool with a version keeps both', () => {
    assert.deepStrictEqual(createSarifDocument({ tool: { name: 'Review agent', version: '2.0' } }).runs[0].tool,
      { driver: { name: 'Review agent', version: '2.0' } });
  });

  test('a source binding writes exactly one provenance entry for the repository and commit', () => {
    const doc = createSarifDocument({ tool: { name: 'Review agent' }, source: { owner: 'acme', repo: 'widgets', commit: HEAD } });
    assert.equal(JSON.stringify(doc),
      `{"$schema":"${SCHEMA_URI}","version":"2.1.0","runs":[{"tool":{"driver":{"name":"Review agent"}},"columnKind":"utf16CodeUnits","versionControlProvenance":[{"repositoryUri":"https://github.com/acme/widgets","revisionId":"${HEAD}"}],"results":[]}]}`);
  });

  test('documents are schema-valid and independent of one another', () => {
    const a = createSarifDocument();
    const b = createSarifDocument();
    assert.equal(validateSarif(a), null);
    assert.equal(validateSarif(createSarifDocument({ source: { owner: 'acme', repo: 'widgets', commit: HEAD } })), null);
    a.runs[0].results.push({ message: { text: 'x' } });
    assert.deepStrictEqual(b.runs[0].results, []);
  });

  const malformed = {
    'non-object options': 'tool',
    'unknown option': { toolName: 'x' },
    'tool without name': { tool: { version: '1' } },
    'empty tool name': { tool: { name: '' } },
    'non-string tool version': { tool: { name: 'x', version: 2 } },
    'unknown tool key': { tool: { name: 'x', uri: 'y' } },
    'partial source': { source: { owner: 'acme', repo: 'widgets' } },
    'abbreviated commit': { source: { owner: 'acme', repo: 'widgets', commit: HEAD.slice(0, 7) } },
    'uppercase commit': { source: { owner: 'acme', repo: 'widgets', commit: HEAD.toUpperCase() } },
    'invalid owner': { source: { owner: '-acme', repo: 'widgets', commit: HEAD } },
    'invalid repo': { source: { owner: 'acme', repo: 'wid/gets', commit: HEAD } },
    'unknown source key': { source: { owner: 'acme', repo: 'widgets', commit: HEAD, branch: 'main' } },
  };
  for (const [name, options] of Object.entries(malformed)) {
    test(`malformed options are a TypeError: ${name}`, () => {
      assert.throws(() => createSarifDocument(options), TypeError);
    });
  }
});

describe('addSarifComment: the appended result', () => {
  const base = () => createSarifDocument({ tool: { name: 'Review agent' } });

  test('a single-line text comment appends exactly the contract result', () => {
    const outcome = addSarifComment(base(), { file: 'src/app.js', line: 7, message: 'Cap the limit.' });
    assert.equal(outcome.status, 'added');
    assert.equal(JSON.stringify(outcome.sarif.runs[0].results),
      '[{"message":{"text":"Cap the limit."},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"src/app.js"},"region":{"startLine":7}}}]}]');
    assert.deepStrictEqual(outcome.finding, { ref: '/runs/0/results/0', runIndex: 0, resultIndex: 0, tool: 'Review agent' });
  });

  test('a range, rule, level and Markdown message map onto their SARIF fields in order', () => {
    const outcome = addSarifComment(base(), {
      file: 'src/app.js', line: 16, endLine: 18, message: 'Guard **empty** input.', messageFormat: 'markdown', ruleId: 'R7', level: 'warning',
    });
    assert.equal(JSON.stringify(outcome.sarif.runs[0].results[0]),
      '{"ruleId":"R7","level":"warning","message":{"text":"Guard **empty** input.","markdown":"Guard **empty** input."},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"src/app.js"},"region":{"startLine":16,"endLine":18}}}]}');
  });

  test('an explicit endLine equal to line is kept as written', () => {
    const outcome = addSarifComment(base(), { file: 'a.js', line: 2, endLine: 2, message: 'x' });
    assert.deepStrictEqual(outcome.sarif.runs[0].results[0].locations[0].physicalLocation.region, { startLine: 2, endLine: 2 });
  });

  test('paths are written as RFC 3986 percent-encoded URI references', () => {
    const uri = (file) => addSarifComment(base(), { file, line: 1, message: 'x' }).sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    assert.equal(uri('docs/guide notes/Überblick.md'), 'docs/guide%20notes/%C3%9Cberblick.md');
    assert.equal(uri('a#b?%.txt'), 'a%23b%3F%25.txt');
  });

  test('comments append in order and report their own references', () => {
    const first = addSarifComment(base(), { file: 'a.js', line: 1, message: 'one' });
    const second = addSarifComment(first.sarif, { file: 'b.js', line: 2, message: 'two' });
    assert.deepStrictEqual(second.sarif.runs[0].results.map((r) => r.message.text), ['one', 'two']);
    assert.equal(second.finding.ref, '/runs/0/results/1');
    assert.equal(validateSarif(second.sarif), null);
  });

  test('the caller\'s document is untouched and the result shares no objects with it', () => {
    const input = deepFreeze(base());
    const snapshot = JSON.stringify(input);
    const outcome = addSarifComment(input, { file: 'a.js', line: 1, message: 'x' });
    assert.equal(JSON.stringify(input), snapshot);
    assertSharesNothing(outcome.sarif, input);
  });

  test('upstream SARIF keeps every existing finding, attribution and metadata exactly', () => {
    const input = deepFreeze(loadUpstream());
    const outcome = addSarifComment(input, { file: 'src/parse.js', line: 4, message: 'Also here.', run: 1 });
    const expected = loadUpstream();
    expected.runs[1].results.push({ message: { text: 'Also here.' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'src/parse.js' }, region: { startLine: 4 } } }] });
    assert.deepStrictEqual(outcome.sarif, expected);
    assert.deepStrictEqual(outcome.finding, { ref: '/runs/1/results/1', runIndex: 1, resultIndex: 1, tool: 'Review agent' });
  });

  test('a run without a results array gains one', () => {
    const sarif = { version: '2.1.0', runs: [{ tool: { driver: { name: 'T' } } }] };
    assert.deepStrictEqual(addSarifComment(sarif, { file: 'a.js', line: 1, message: 'x' }).sarif.runs[0].results,
      [{ message: { text: 'x' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'a.js' }, region: { startLine: 1 } } }] }]);
  });
});

describe('addSarifComment: run selection (attribution, D5)', () => {
  const twoRuns = () => loadUpstream();
  const comment = { file: 'a.js', line: 1, message: 'x' };

  test('several runs without a selection is a TypeError asking the caller to choose', () => {
    assert.throws(() => addSarifComment(twoRuns(), comment), (e) => e instanceof TypeError && /run/.test(e.message));
  });

  test('run: n selects run n', () => {
    const outcome = addSarifComment(twoRuns(), { ...comment, run: 0 });
    assert.equal(outcome.sarif.runs[0].results.length, 7);
    assert.deepStrictEqual(outcome.finding, { ref: '/runs/0/results/6', runIndex: 0, resultIndex: 6, tool: 'ESLint' });
  });

  for (const run of [2, -1, 1.5, '0', null]) {
    test(`an invalid run selection is a TypeError: ${JSON.stringify(run)}`, () => {
      assert.throws(() => addSarifComment(twoRuns(), { ...comment, run }), TypeError);
    });
  }

  test('run: { toolName } appends a new run so the upstream tool is not credited', () => {
    const outcome = addSarifComment(twoRuns(), { ...comment, run: { toolName: 'Reviewer' } });
    assert.equal(outcome.sarif.runs.length, 3);
    assert.equal(JSON.stringify(outcome.sarif.runs[2]),
      '{"tool":{"driver":{"name":"Reviewer"}},"columnKind":"utf16CodeUnits","results":[{"message":{"text":"x"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"a.js"},"region":{"startLine":1}}}]}]}');
    assert.deepStrictEqual(outcome.finding, { ref: '/runs/2/results/0', runIndex: 2, resultIndex: 0, tool: 'Reviewer' });
  });

  test('a new run can carry a version and a source binding', () => {
    const outcome = addSarifComment(twoRuns(), { ...comment,
      run: { toolName: 'Reviewer', toolVersion: '1.2', source: { owner: 'acme', repo: 'widgets', commit: HEAD } } });
    assert.deepStrictEqual(outcome.sarif.runs[2].tool, { driver: { name: 'Reviewer', version: '1.2' } });
    assert.deepStrictEqual(outcome.sarif.runs[2].versionControlProvenance,
      [{ repositoryUri: 'https://github.com/acme/widgets', revisionId: HEAD }]);
  });

  test('a new run can be added to a log with no runs', () => {
    const outcome = addSarifComment({ version: '2.1.0', runs: [] }, { ...comment, run: { toolName: 'Reviewer' } });
    assert.equal(outcome.status, 'added');
    assert.equal(outcome.finding.ref, '/runs/0/results/0');
  });

  test('a log with no runs and no selection is invalid, not an exception', () => {
    const outcome = addSarifComment({ version: '2.1.0', runs: [] }, comment);
    assert.equal(outcome.status, 'invalid');
    assert.ok(outcome.problems.length > 0 && outcome.markdown.length > 0);
    assert.equal(outcome.sarif, undefined);
  });

  for (const run of [{ toolName: '' }, { toolName: 'R', extra: 1 }, { toolName: 'R', source: { owner: 'acme', repo: 'widgets' } }, { toolName: 'R', toolVersion: 1 }]) {
    test(`a malformed new-run selection is a TypeError: ${JSON.stringify(run)}`, () => {
      assert.throws(() => addSarifComment(twoRuns(), { ...comment, run }), TypeError);
    });
  }
});

describe('addSarifComment: refusals', () => {
  test('schema-invalid SARIF is refused as invalid, with problems and Markdown', () => {
    const outcome = addSarifComment({ version: '2.1.0', runs: [{ tool: { driver: { name: 'T' } }, results: [{ ruleId: 'R' }] }] },
      { file: 'a.js', line: 1, message: 'x' });
    assert.equal(outcome.status, 'invalid');
    assert.ok(outcome.problems.some((p) => p.pointer === '/runs/0/results/0'));
    assert.equal(typeof outcome.markdown, 'string');
  });

  test('non-JSON SARIF is a TypeError and caller getters never run', () => {
    let ran = false;
    const sarif = { version: '2.1.0' };
    Object.defineProperty(sarif, 'runs', { enumerable: true, get() { ran = true; return []; } });
    assert.throws(() => addSarifComment(sarif, { file: 'a.js', line: 1, message: 'x' }), TypeError);
    assert.equal(ran, false);
  });

  for (const sarif of [null, 'text', 42, JSON.stringify({ version: '2.1.0', runs: [] })]) {
    test(`a non-object SARIF argument is a TypeError: ${JSON.stringify(sarif).slice(0, 30)}`, () => {
      assert.throws(() => addSarifComment(sarif, { file: 'a.js', line: 1, message: 'x' }), TypeError);
    });
  }

  const bad = {
    'empty path': { file: '', line: 1, message: 'x' },
    'leading slash': { file: '/a.js', line: 1, message: 'x' },
    'dot segment': { file: 'a/./b.js', line: 1, message: 'x' },
    'dot-dot segment': { file: 'a/../b.js', line: 1, message: 'x' },
    'empty segment': { file: 'a//b.js', line: 1, message: 'x' },
    backslash: { file: 'a\\b.js', line: 1, message: 'x' },
    'line zero': { file: 'a.js', line: 0, message: 'x' },
    'fractional line': { file: 'a.js', line: 1.5, message: 'x' },
    'endLine before line': { file: 'a.js', line: 3, endLine: 2, message: 'x' },
    'empty message': { file: 'a.js', line: 1, message: '' },
    'non-string message': { file: 'a.js', line: 1, message: 7 },
    'unknown format': { file: 'a.js', line: 1, message: 'x', messageFormat: 'html' },
    'unknown level': { file: 'a.js', line: 1, message: 'x', level: 'fatal' },
    'empty rule id': { file: 'a.js', line: 1, message: 'x', ruleId: '' },
    'unknown key': { file: 'a.js', line: 1, message: 'x', column: 3 },
    'missing line': { file: 'a.js', message: 'x' },
  };
  for (const [name, comment] of Object.entries(bad)) {
    test(`a malformed comment is a TypeError: ${name}`, () => {
      assert.throws(() => addSarifComment(createSarifDocument(), comment), TypeError);
    });
  }
});

describe('authored SARIF publishes through the unchanged publisher', () => {
  // repository.json (prepare-review fixture) holds src/app.js at HEAD; its line 7 is in the diff.
  const repository = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'prepare-review', 'repository.json'), 'utf8'));
  const context = {
    owner: 'acme', repo: 'widgets', pullNumber: 42, reviewedCommit: HEAD,
    diff: { baseCommit: repository.diff.baseCommit, headCommit: repository.diff.headCommit,
      files: repository.diff.files.map((f) => ({ path: f.path, patch: f.patch.join('') })) },
  };
  const readSource = async (commit, p) => {
    const snapshot = repository.snapshots[commit];
    return snapshot && Object.hasOwn(snapshot, p) ? snapshot[p].join('') : null;
  };

  test('an authored, bound comment becomes one inline comment attributed to the named author', async () => {
    assert.equal(BASE, repository.commits.base);
    const doc = createSarifDocument({ tool: { name: 'Review agent' }, source: { owner: 'acme', repo: 'widgets', commit: HEAD } });
    const { sarif } = addSarifComment(doc, { file: 'src/app.js', line: 7, message: 'Cap the limit.' });
    const outcome = await prepareReview({ sarif, context, readSource });
    assert.equal(outcome.status, 'ready', JSON.stringify(outcome.diagnostics));
    assert.deepStrictEqual(outcome.review.comments, [
      { path: 'src/app.js', side: 'RIGHT', line: 7, body: 'Cap the limit.\n\n<sub>— Review agent</sub>' },
    ]);
  });
});
