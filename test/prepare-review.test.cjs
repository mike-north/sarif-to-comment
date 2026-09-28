'use strict';

/**
 * Contract tests for whole-review preparation (src/prepare-review.cjs).
 *
 * Preparation turns a ready SARIF document into the complete body and inline
 * comments of one draft review, or blocks the whole review before any write.
 * Expectations are hand-authored in test/fixtures/prepare-review from the
 * authored repository snapshots, the SARIF 2.1.0 specification and the
 * rendering rules documented in the module; none is captured from the
 * implementation. An independent oracle checks every expected inline
 * coordinate against the authored snapshots, and negative controls prove the
 * oracle rejects a shifted line, the wrong side and the wrong file.
 *
 * For fix tests the replacement module is injected as a boundary whose
 * responses are authored in replacements.json; integration tests run the real
 * module and must reach the same authored reviews. Source-region coordinates
 * (columns, character offsets, BOM, non-BMP text) follow the replacement
 * module's SARIF region semantics, with no default columnKind: a region is
 * accepted without columnKind only when both SARIF units denote the same text.
 * The accepted placement module is used as is. Tests do not establish GitHub
 * rendering or placement; real-host evidence is a separate obligation.
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet
 * @see https://spec.commonmark.org/0.31.2/#backslash-escapes
 * @see https://spec.commonmark.org/0.31.2/#fenced-code-blocks
 * @see https://www.rfc-editor.org/rfc/rfc3986
 * @see https://www.rfc-editor.org/rfc/rfc6901
 */

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { prepareReview, PRODUCT_LIMITS } = require('../src/prepare-review.cjs');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'prepare-review');
const loadJson = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));

const repository = loadJson('repository.json');
const replacementTable = loadJson('replacements.json');
const completeExpected = loadJson('complete-review.expected.json');

const { base: BASE, head: HEAD, earlierHead: EARLIER, otherRepository: OTHER } = repository.commits;
const { owner: OWNER, repo: REPO, pullNumber: PULL } = repository.destination;
const SEP = '\n\n---\n\n';

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** Authored physical lines of a file at a commit, or undefined when absent. */
function authoredLines(commit, filePath) {
  const snapshot = repository.snapshots[commit];
  return snapshot && hasOwn(snapshot, filePath) ? snapshot[filePath] : undefined;
}

function snapshotText(commit, filePath) {
  const lines = authoredLines(commit, filePath);
  assert.ok(lines, `fixture has no ${filePath} at ${commit}`);
  return lines.join('');
}

/** Oracle: literal text of an inclusive authored line range, final terminator excluded. */
function oracleText(commit, filePath, start, end) {
  const lines = authoredLines(commit, filePath);
  if (!lines || start < 1 || end > lines.length || start > end) {
    throw new assert.AssertionError({ message: `no lines ${start}-${end} of ${filePath} at ${commit}` });
  }
  return lines.slice(start - 1, end).join('').replace(/\r?\n$/, '');
}

/** Oracle: an expected inline comment's host-side text is exactly its stated text. */
function verifyExpectedComment(comment) {
  const commit = comment.side === 'LEFT' ? BASE : comment.side === 'RIGHT' ? HEAD : undefined;
  assert.ok(commit, `unknown side ${comment.side}`);
  if (comment.startLine !== undefined) assert.equal(comment.startSide, comment.side);
  const start = comment.startLine === undefined ? comment.line : comment.startLine;
  assert.equal(oracleText(commit, comment.path, start, comment.line), comment.hostText,
    `${comment.path} ${comment.side} ${start}-${comment.line} is not the stated host text`);
}

/** The trusted diff context, as a transport would supply it. */
function trustedDiff() {
  return {
    baseCommit: repository.diff.baseCommit,
    headCommit: repository.diff.headCommit,
    files: repository.diff.files.map((f) => ({ path: f.path, patch: f.patch.join('') })),
  };
}

function reviewContext(overrides = {}) {
  return { owner: OWNER, repo: REPO, pullNumber: PULL, reviewedCommit: HEAD, diff: trustedDiff(), ...overrides };
}

/** A trusted snapshot reader over the authored repository that records every call. */
function snapshotReader() {
  const calls = [];
  const readSource = async (commit, filePath) => {
    calls.push([commit, filePath]);
    if (!hasOwn(repository.snapshots, commit)) throw new Error(`unknown commit ${commit}`);
    const lines = authoredLines(commit, filePath);
    return lines === undefined ? null : lines.join('');
  };
  return { readSource, calls };
}

/**
 * The injected replacement boundary. It answers only the exact requests
 * authored in replacements.json and fails the test on any other request.
 */
function replacementBoundary() {
  const calls = [];
  const entries = replacementTable.entries.map((entry) => {
    const request = {
      sourceText: snapshotText(...entry.request.source),
      deletedRegion: entry.request.deletedRegion,
      insertedText: entry.request.insertedText,
    };
    if (hasOwn(entry.request, 'columnKind')) request.columnKind = entry.request.columnKind;
    const { editedTextLines, ...response } = entry.response;
    if (editedTextLines !== undefined) response.editedText = editedTextLines.join('');
    return { id: entry.id, request, response };
  });
  const applyReplacement = (request) => {
    calls.push(request);
    const normalized = { ...request };
    if (normalized.columnKind === undefined) delete normalized.columnKind;
    const match = entries.find((entry) => {
      try {
        assert.deepStrictEqual(normalized, entry.request);
        return true;
      } catch {
        return false;
      }
    });
    if (!match) throw new assert.AssertionError({ message: `unexpected replacement request ${JSON.stringify(request)}` });
    return structuredClone(match.response);
  };
  return { applyReplacement, calls };
}

/**
 * Runs preparation with the authored repository. Fixes use the authored
 * replacement boundary unless `realReplacement` selects the production module.
 */
async function prepare(sarif, {
  context = reviewContext(), options, reader = snapshotReader(), replacements = replacementBoundary(), realReplacement = false,
} = {}) {
  const input = { sarif, context, readSource: reader.readSource };
  if (options !== undefined) input.options = options;
  const internals = realReplacement ? undefined : { applyReplacement: replacements.applyReplacement };
  const outcome = await prepareReview(input, internals);
  return { outcome, reader, replacements };
}

/** A minimal SARIF log with one run; run properties given as undefined are omitted. */
function sarifLog(results, run = {}) {
  const merged = { tool: { driver: { name: 'T' } }, columnKind: 'utf16CodeUnits', ...run, results };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return { version: '2.1.0', runs: [merged] };
}

/** A physical location on a repository-relative URI. */
function at(uri, region, artifactExtras = {}) {
  const physicalLocation = { artifactLocation: { uri, ...artifactExtras } };
  if (region !== undefined) physicalLocation.region = region;
  return [{ physicalLocation }];
}

function result(text, locations, extras = {}) {
  const r = { message: { text }, ...extras };
  if (locations !== undefined) r.locations = locations;
  return r;
}

/** A fix with one replacement on the authored head of src/app.js. */
function fix(deletedRegion, insertedText, uri = 'src/app.js') {
  return {
    artifactChanges: [{
      artifactLocation: { uri },
      replacements: [{ deletedRegion, insertedContent: { text: insertedText } }],
    }],
  };
}

const author = (tool, rule) => `<sub>— ${tool}${rule ? ` · rule \`${rule}\`` : ''}</sub>`;

function assertReady(outcome, commitId = HEAD) {
  assert.equal(outcome.status, 'ready',
    `expected ready, got ${outcome.status}: ${JSON.stringify(outcome.diagnostics || outcome)}`);
  assert.ok(outcome.review && typeof outcome.review.body === 'string' && Array.isArray(outcome.review.comments));
  assert.equal(outcome.review.commitId, commitId);
}

/**
 * Asserts a whole-review block: no review is produced, every expected code is
 * diagnosed (at the expected pointer when given), each diagnostic is
 * actionable, and the Markdown report names each diagnostic's pointer.
 */
function assertBlocked(outcome, expected) {
  assert.equal(outcome.status, 'blocked', `expected blocked, got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.review, undefined, 'a blocked outcome must not carry a review');
  assert.ok(Array.isArray(outcome.diagnostics) && outcome.diagnostics.length > 0);
  for (const d of outcome.diagnostics) {
    assert.equal(typeof d.code, 'string');
    assert.ok(typeof d.message === 'string' && d.message.length > 0, `diagnostic ${d.code} has no message`);
    assert.ok(typeof outcome.markdown === 'string' && outcome.markdown.includes(d.code),
      `markdown report omits ${d.code}`);
    if (d.pointer !== undefined) assert.ok(outcome.markdown.includes(d.pointer), `markdown report omits ${d.pointer}`);
  }
  for (const e of expected) {
    const [code, pointer] = Array.isArray(e) ? e : [e];
    assert.ok(outcome.diagnostics.some((d) => d.code === code && (pointer === undefined || d.pointer === pointer)),
      `missing diagnostic ${code}${pointer ? ` at ${pointer}` : ''}: ${JSON.stringify(outcome.diagnostics)}`);
  }
}

const codes = (list) => (list || []).map((d) => d.code);

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const permalink = (commit, filePath, start, end) => `https://github.com/acme/widgets/blob/${commit}/${
  filePath.split('/').map(encodeURIComponent).join('/')}${start === undefined ? '' : `#L${start}${end && end !== start ? `-L${end}` : ''}`}`;

// ---------------------------------------------------------------------------

describe('fixture oracle', () => {
  for (const [i, comment] of completeExpected.comments.entries()) {
    test(`expected comment ${i} names its authored host text`, () => {
      verifyExpectedComment(comment);
    });
  }

  for (const item of completeExpected.evidence.filter((e) => e.source)) {
    test(`expected evidence source for ${item.pointer} is authored text`, () => {
      const { commit, path: p, startLine, endLine, text } = item.source;
      assert.equal(oracleText(commit, p, startLine, endLine), text);
    });
  }

  test('expected replacement evidence restates the authored replacement boundary exactly', () => {
    for (const item of completeExpected.evidence.filter((e) => e.replacement)) {
      const entry = replacementTable.entries.find((x) => x.response.startLine === item.replacement.startLine
        && x.response.replacementText === item.replacement.replacementText);
      assert.ok(entry, `no authored replacement for ${item.pointer}`);
      assert.equal(item.replacement.originalText,
        authoredLines(HEAD, 'src/app.js').slice(item.replacement.startLine - 1, item.replacement.endLine).join(''));
    }
  });

  test('authored replacement edits change only their stated lines', () => {
    for (const entry of replacementTable.entries.filter((x) => x.response.kind === 'replacement'
      && x.response.editedTextLines.length > 0)) {
      const original = authoredLines(...entry.request.source).join('');
      const { startLine, endLine, originalText, replacementText, editedTextLines } = entry.response;
      const lines = authoredLines(...entry.request.source);
      assert.equal(lines.slice(startLine - 1, endLine).join(''), originalText, entry.id);
      const prefix = lines.slice(0, startLine - 1).join('');
      assert.equal(editedTextLines.join(''), prefix + replacementText + original.slice(prefix.length + originalText.length), entry.id);
    }
  });

  test('negative control: a shifted line is detected', () => {
    const c = completeExpected.comments[1];
    assert.throws(() => verifyExpectedComment({ ...c, line: c.line + 1 }), assert.AssertionError);
  });

  test('negative control: the wrong side is detected', () => {
    const left = completeExpected.comments.find((c) => c.side === 'LEFT' && c.path === 'src/app.js');
    assert.throws(() => verifyExpectedComment({ ...left, side: 'RIGHT' }), assert.AssertionError);
  });

  test('negative control: the wrong file is detected', () => {
    const c = completeExpected.comments[5];
    assert.throws(() => verifyExpectedComment({ ...c, path: 'src/app.js' }), assert.AssertionError);
  });
});

describe('authored patches agree with git diff', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-git-home-'));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C',
  };
  const probe = spawnSync('git', ['--version'], { env, encoding: 'utf8' });
  for (const entry of repository.diff.files) {
    test(`git diff reproduces ${entry.path}`, (t) => {
      if (probe.error || probe.status !== 0) {
        t.skip('git is unavailable');
        return;
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-diff-'));
      const sides = {};
      for (const [side, commit] of [['base', BASE], ['head', HEAD]]) {
        const lines = authoredLines(commit, entry.path);
        if (lines === undefined) {
          sides[side] = '/dev/null';
        } else {
          sides[side] = path.join(dir, side, path.basename(entry.path));
          fs.mkdirSync(path.dirname(sides[side]), { recursive: true });
          fs.writeFileSync(sides[side], lines.join(''));
        }
      }
      const run = spawnSync('git', ['-c', 'core.quotepath=false', 'diff', '--no-index', '--no-color', '--no-ext-diff',
        '--no-textconv', '-U3', '--diff-algorithm=myers', '--indent-heuristic', sides.base, sides.head],
      { env, cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 1, run.stderr);
      const hunks = (p) => p.slice(p.indexOf('@@'));
      assert.equal(hunks(entry.patch.join('')), hunks(run.stdout));
    });
  }
});

describe('complete review from several runs', () => {
  test('prepares one review: body plus every inline comment, exactly as authored', async () => {
    const { outcome, reader } = await prepare(loadJson('complete-review.sarif.json'));
    assertReady(outcome);
    const expectedComments = completeExpected.comments.map(({ hostText, ...comment }) => comment);
    assert.deepStrictEqual(outcome.review.comments, expectedComments);
    assert.equal(outcome.review.body, completeExpected.bodySections.join(SEP));
    assert.deepStrictEqual(outcome.warnings, []);

    const readSet = new Set(reader.calls.map((c) => JSON.stringify(c)));
    assert.deepStrictEqual(readSet, new Set(completeExpected.readSourceCalls.map((c) => JSON.stringify(c))));
  });

  test('integration: the production replacement module yields the same authored review', async () => {
    const { outcome } = await prepare(loadJson('complete-review.sarif.json'), { realReplacement: true });
    assertReady(outcome);
    assert.deepStrictEqual(outcome.review.comments, completeExpected.comments.map(({ hostText, ...comment }) => comment));
    assert.equal(outcome.review.body, completeExpected.bodySections.join(SEP));
    for (const expected of completeExpected.evidence.filter((e) => e.replacement)) {
      assert.deepStrictEqual(outcome.evidence.find((e) => e.pointer === expected.pointer).replacement, expected.replacement);
    }
  });

  test('evidence maps every SARIF result to its treatment, exact source and replacement', async () => {
    const { outcome } = await prepare(loadJson('complete-review.sarif.json'));
    assertReady(outcome);
    assert.deepStrictEqual(outcome.evidence.map((e) => e.pointer), completeExpected.evidence.map((e) => e.pointer));
    for (const expected of completeExpected.evidence) {
      const actual = outcome.evidence.find((e) => e.pointer === expected.pointer);
      for (const key of ['treatment', 'commentIndex', 'bodySectionIndex', 'source', 'replacement']) {
        assert.deepStrictEqual(actual[key], expected[key], `${expected.pointer} ${key}`);
      }
    }
  });

  test('evidence retains driver identity, version and rule attribution per run', async () => {
    const { outcome } = await prepare(loadJson('complete-review.sarif.json'));
    assertReady(outcome);
    const byPointer = (p) => outcome.evidence.find((e) => e.pointer === p).attribution;
    assert.deepStrictEqual(byPointer('/runs/0/results/0'), { tool: 'LintBot', version: '2.3.1', ruleId: 'LB001' });
    assert.deepStrictEqual(byPointer('/runs/0/results/2'), { tool: 'LintBot', version: '2.3.1' });
    assert.deepStrictEqual(byPointer('/runs/1/results/0'), { tool: 'StyleBot', version: '0.9.0', ruleId: 'SB-7' });
    assert.deepStrictEqual(byPointer('/runs/2/results/0'), { tool: 'HistoryBot' });
  });

  test('input SARIF is not mutated and preparation is deterministic', async () => {
    const sarif = deepFreeze(loadJson('complete-review.sarif.json'));
    const first = (await prepare(sarif)).outcome;
    const second = (await prepare(sarif)).outcome;
    assertReady(first);
    assert.deepStrictEqual(second, first);
  });
});

describe('ordinary feedback-only SARIF', () => {
  test('one located result with no rules, fixes, provenance or properties becomes one inline comment', async () => {
    const sarif = { version: '2.1.0', runs: [{ tool: { driver: { name: 'Plain' } }, results: [
      result('Looks off.', at('src/app.js', { startLine: 7 })),
    ] }] };
    const { outcome } = await prepare(sarif);
    assertReady(outcome);
    assert.deepStrictEqual(outcome.review.comments, [
      { path: 'src/app.js', side: 'RIGHT', line: 7, body: `Looks off.\n\n${author('Plain')}` },
    ]);
    assert.equal(outcome.review.body, '');
    assert.equal(outcome.evidence[0].approval, 'none');
  });

  test('a result without locations becomes general body feedback', async () => {
    const { outcome } = await prepare(sarifLog([result('Please add tests.')]));
    assertReady(outcome);
    assert.deepStrictEqual(outcome.review.comments, []);
    assert.equal(outcome.review.body, `Please add tests.\n\n${author('T')}`);
  });

  test('a location without a region is whole-file general feedback with an exact file link', async () => {
    const { outcome } = await prepare(sarifLog([result('Consider splitting this module.', at('src/util.js'))]));
    assertReady(outcome);
    assert.equal(outcome.review.body,
      `**Source:** [src/util.js at c0dec0d](${permalink(HEAD, 'src/util.js')})\n\nConsider splitting this module.\n\n${author('T')}`);
  });

  test('a region ending at column 1 excludes that later line', async () => {
    const { outcome } = await prepare(sarifLog([result('Span.', at('src/app.js', { startLine: 6, endLine: 8, endColumn: 1 }))]));
    assertReady(outcome);
    assert.deepStrictEqual(outcome.review.comments.map(({ body, ...c }) => c), [
      { path: 'src/app.js', side: 'RIGHT', startSide: 'RIGHT', startLine: 6, line: 7 },
    ]);
  });
});

describe('message resolution and literal rendering', () => {
  const bodyOf = async (sarif) => {
    const { outcome } = await prepare(sarif);
    assertReady(outcome);
    return outcome.review.body;
  };

  test('plain text is escaped so Markdown syntax renders literally', async () => {
    const body = await bodyOf(sarifLog([result('Use *stars*, _under_, [x](y), <b>, # hash, `tick`, a|b, ~s~ & \\.')]));
    assert.equal(body, `Use \\*stars\\*, \\_under\\_, \\[x\\](y), \\<b\\>, \\# hash, \\\`tick\\\`, a\\|b, \\~s\\~ \\& \\\\.\n\n${author('T')}`);
  });

  test('plain-text line breaks and paragraphs survive and line-start markers are neutralized', async () => {
    const body = await bodyOf(sarifLog([result('- item\n1. one\n\n+ next')]));
    assert.equal(body, `\\- item\\\n1\\. one\n\n\\+ next\n\n${author('T')}`);
  });

  test('markdown is preferred over text and used verbatim', async () => {
    const body = await bodyOf(sarifLog([{ message: { text: 'plain', markdown: 'Use **bold** `code`' } }]));
    assert.equal(body, `Use **bold** \`code\`\n\n${author('T')}`);
  });

  test('message.id resolves from the rule named by ruleId, with arguments and doubled braces', async () => {
    const body = await bodyOf(sarifLog([{ ruleId: 'R1', message: { id: 'm', arguments: ['5'] } }], {
      tool: { driver: { name: 'T', rules: [{ id: 'R1', messageStrings: { m: { text: 'Value {{literal}} is {0}' } } }] } },
    }));
    assert.equal(body, `Value \\{literal\\} is 5\n\n${author('T', 'R1')}`);
  });

  test('message.id resolves from the rule named by ruleIndex', async () => {
    const body = await bodyOf(sarifLog([{ ruleIndex: 1, message: { id: 'm', arguments: [] } }], {
      tool: { driver: { name: 'T', rules: [{ id: 'R0' }, { id: 'R1', messageStrings: { m: { text: 'From index' } } }] } },
    }));
    assert.equal(body, `From index\n\n${author('T', 'R1')}`);
  });

  test('message.id falls back to driver globalMessageStrings', async () => {
    const body = await bodyOf(sarifLog([{ message: { id: 'g', arguments: ['x'] } }], {
      tool: { driver: { name: 'T', globalMessageStrings: { g: { text: 'Global {0}' } } } },
    }));
    assert.equal(body, `Global x\n\n${author('T')}`);
  });

  test('a markdown template is preferred and its arguments are inserted as literal text', async () => {
    const body = await bodyOf(sarifLog([{ ruleId: 'R1', message: { id: 'm', arguments: ['a*b'] } }], {
      tool: { driver: { name: 'T', rules: [{ id: 'R1', messageStrings: { m: { text: 'Use {0}', markdown: 'Use **{0}**' } } }] } },
    }));
    assert.equal(body, `Use **a\\*b**\n\n${author('T', 'R1')}`);
  });

  test('an unresolvable message id blocks rather than dropping the finding', async () => {
    const { outcome } = await prepare(sarifLog([result('ok'), { message: { id: 'missing' } }]));
    assertBlocked(outcome, [['message-unresolved', '/runs/0/results/1']]);
  });

  test('a placeholder without its argument blocks', async () => {
    const { outcome } = await prepare(sarifLog([{ message: { id: 'g', arguments: [] } }], {
      tool: { driver: { name: 'T', globalMessageStrings: { g: { text: 'Needs {0}' } } } },
    }));
    assertBlocked(outcome, [['message-argument-missing', '/runs/0/results/0']]);
  });

  test('ruleIndex and ruleId naming different rules blocks', async () => {
    const { outcome } = await prepare(sarifLog([{ ruleId: 'R2', ruleIndex: 0, message: { text: 'x' } }], {
      tool: { driver: { name: 'T', rules: [{ id: 'R1' }] } },
    }));
    assertBlocked(outcome, [['rule-reference-conflict', '/runs/0/results/0']]);
  });

  test('a general source quote keeps literal contents inside a longer fence', async () => {
    const { outcome } = await prepare(sarifLog([result('Quote.', at('docs/README.md', { startLine: 3, endLine: 5 }))]));
    assertReady(outcome);
    assert.equal(outcome.review.body, `**Source:** [docs/README.md lines 3-5 at c0dec0d](${permalink(HEAD, 'docs/README.md', 3, 5)})`
      + `\n\n\`\`\`\`\n\`\`\`js\nrun();\n\`\`\`\n\`\`\`\`\n\nQuote.\n\n${author('T')}`);
  });
});

describe('artifact locations and URI resolution', () => {
  const inlinePath = async (sarif, context) => {
    const { outcome } = await prepare(sarif, context ? { context } : undefined);
    assertReady(outcome);
    assert.equal(outcome.review.comments.length, 1);
    return outcome.review.comments[0];
  };

  const blockedWithoutReads = async (sarif, code, context) => {
    const reader = snapshotReader();
    const { outcome } = await prepare(sarif, { reader, ...(context ? { context } : {}) });
    assertBlocked(outcome, [[code, '/runs/0/results/0']]);
    assert.deepStrictEqual(reader.calls, [], 'an unresolved location must never reach the snapshot reader');
  };

  test('an ordinary relative URI is repository-relative', async () => {
    const c = await inlinePath(sarifLog([result('x', at('src/app.js', { startLine: 7 }))]));
    assert.deepStrictEqual([c.path, c.side, c.line], ['src/app.js', 'RIGHT', 7]);
  });

  test('an artifact index resolves through run.artifacts', async () => {
    const sarif = sarifLog([{ message: { text: 'x' }, locations: [{ physicalLocation: {
      artifactLocation: { index: 1 }, region: { startLine: 7 } } }] }], {
      artifacts: [{ location: { uri: 'src/util.js' } }, { location: { uri: 'src/app.js' } }],
    });
    assert.equal((await inlinePath(sarif)).path, 'src/app.js');
  });

  test('an artifact index with a consistent URI is accepted', async () => {
    const sarif = sarifLog([result('x', at('src/app.js', { startLine: 7 }, { index: 0 }))], {
      artifacts: [{ location: { uri: 'src/app.js' } }],
    });
    assert.equal((await inlinePath(sarif)).path, 'src/app.js');
  });

  test('an artifact index contradicting its URI blocks', async () => {
    await blockedWithoutReads(sarifLog([result('x', at('src/app.js', { startLine: 7 }, { index: 0 }))], {
      artifacts: [{ location: { uri: 'src/util.js' } }],
    }), 'artifact-index-conflict');
  });

  test('an artifact index outside run.artifacts blocks', async () => {
    await blockedWithoutReads(sarifLog([{ message: { text: 'x' }, locations: [{ physicalLocation: {
      artifactLocation: { index: 3 }, region: { startLine: 7 } } }] }], {
      artifacts: [{ location: { uri: 'src/app.js' } }],
    }), 'artifact-index-invalid');
  });

  test('a chained uriBaseId resolves through originalUriBaseIds to the caller-declared source root', async () => {
    const sarif = sarifLog([result('x', at('app.js', { startLine: 7 }, { uriBaseId: 'SRC' }))], {
      originalUriBaseIds: { ROOT: { uri: 'file:///work/widgets/' }, SRC: { uri: 'src/', uriBaseId: 'ROOT' } },
    });
    const c = await inlinePath(sarif, reviewContext({ sourceRootUri: 'file:///work/widgets/' }));
    assert.equal(c.path, 'src/app.js');
  });

  test('percent-encoded spaces and Unicode decode to the repository path', async () => {
    const c = await inlinePath(sarifLog([result('x', at('docs/guide%20notes/%C3%9Cberblick.md', { startLine: 3 }))]));
    assert.deepStrictEqual([c.path, c.line], ['docs/guide notes/Überblick.md', 3]);
  });

  test('an absolute file URI under the caller-declared source root is accepted', async () => {
    const c = await inlinePath(sarifLog([result('x', at('file:///work/widgets/src/app.js', { startLine: 7 }))]),
      reviewContext({ sourceRootUri: 'file:///work/widgets/' }));
    assert.equal(c.path, 'src/app.js');
  });

  test('an absolute file URI under the matching provenance mappedTo root is accepted', async () => {
    const sarif = sarifLog([result('x', at('file:///build/widgets/src/app.js', { startLine: 7 }))], {
      versionControlProvenance: [{ repositoryUri: 'https://github.com/acme/widgets', mappedTo: { uri: 'file:///build/widgets/' } }],
    });
    assert.equal((await inlinePath(sarif)).path, 'src/app.js');
  });

  test('an absolute file URI with no known repository root blocks', async () => {
    await blockedWithoutReads(sarifLog([result('x', at('file:///work/widgets/src/app.js', { startLine: 7 }))]),
      'uri-outside-repository');
  });

  test('an absolute file URI outside the repository root blocks', async () => {
    await blockedWithoutReads(sarifLog([result('x', at('file:///etc/passwd', { startLine: 1 }))]),
      'uri-outside-repository', reviewContext({ sourceRootUri: 'file:///work/widgets/' }));
  });

  for (const uri of ['https://github.com/acme/widgets/blob/main/src/app.js', 'data:text/plain,hello', 'ftp://host/src/app.js']) {
    test(`an unsupported URI scheme blocks: ${uri}`, async () => {
      await blockedWithoutReads(sarifLog([result('x', at(uri, { startLine: 1 }))]), 'uri-scheme-unsupported');
    });
  }

  for (const uri of ['src/../src/app.js', '../widgets/src/app.js', 'src/%2e%2e/src/app.js', './src/app.js']) {
    test(`a dot-segment path blocks: ${uri}`, async () => {
      await blockedWithoutReads(sarifLog([result('x', at(uri, { startLine: 1 }))]), 'uri-traversal');
    });
  }

  for (const uri of ['src%2Fapp.js', 'src%5Capp.js']) {
    test(`an encoded path separator blocks: ${uri}`, async () => {
      await blockedWithoutReads(sarifLog([result('x', at(uri, { startLine: 1 }))]), 'uri-encoded-separator');
    });
  }

  for (const uri of ['', 'src/app.js?x=1', 'src/app.js#L1', '/src/app.js', 'src/%E0%A4.js', 'src//app.js']) {
    test(`a malformed or ambiguous URI blocks: ${JSON.stringify(uri)}`, async () => {
      await blockedWithoutReads(sarifLog([result('x', at(uri, { startLine: 1 }))]), 'uri-invalid');
    });
  }

  test('a backslash in a URI blocks, whether as a schema format violation or a policy check', async () => {
    const reader = snapshotReader();
    const { outcome } = await prepare(sarifLog([result('x', at('src\\app.js', { startLine: 1 }))]), { reader });
    assert.equal(outcome.status, 'blocked');
    assert.ok(codes(outcome.diagnostics).some((c) => c === 'uri-invalid' || c === 'sarif-schema-invalid'),
      JSON.stringify(outcome.diagnostics));
    assert.deepStrictEqual(reader.calls, []);
  });

  test('an undefined uriBaseId blocks', async () => {
    await blockedWithoutReads(sarifLog([result('x', at('app.js', { startLine: 1 }, { uriBaseId: 'NOPE' }))]),
      'uri-base-unresolved');
  });

  test('a cyclic uriBaseId chain blocks', async () => {
    await blockedWithoutReads(sarifLog([result('x', at('app.js', { startLine: 1 }, { uriBaseId: 'A' }))], {
      originalUriBaseIds: { A: { uri: 'x/', uriBaseId: 'B' }, B: { uri: 'y/', uriBaseId: 'A' } },
    }), 'uri-base-unresolved');
  });

  test('a base URI without a trailing slash blocks', async () => {
    await blockedWithoutReads(sarifLog([result('x', at('app.js', { startLine: 1 }, { uriBaseId: 'SRC' }))], {
      originalUriBaseIds: { SRC: { uri: 'src' } },
    }), 'uri-base-invalid');
  });

  test('nested artifacts (parentIndex) are explicitly unsupported', async () => {
    await blockedWithoutReads(sarifLog([{ message: { text: 'x' }, locations: [{ physicalLocation: {
      artifactLocation: { index: 1 }, region: { startLine: 1 } } }] }], {
      artifacts: [{ location: { uri: 'bundle.zip' } }, { location: { uri: 'inner.js' }, parentIndex: 0 }],
    }), 'nested-artifact-unsupported');
  });
});

describe('source revision binding', () => {
  test('provenance naming another repository blocks located results without reading source', async () => {
    const reader = snapshotReader();
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', { startLine: 7 }))], {
      versionControlProvenance: [{ repositoryUri: 'https://github.com/other/thing', revisionId: OTHER }],
    }), { reader });
    assertBlocked(outcome, [['repository-mismatch', '/runs/0/results/0']]);
    assert.deepStrictEqual(reader.calls, []);
  });

  test('an abbreviated provenance revision blocks rather than prefix-matching', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', { startLine: 7 }))], {
      versionControlProvenance: [{ repositoryUri: 'https://github.com/acme/widgets', revisionId: HEAD.slice(0, 7) }],
    }));
    assertBlocked(outcome, ['provenance-revision-invalid']);
  });

  test('conflicting revisions for this repository block', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', { startLine: 7 }))], {
      versionControlProvenance: [
        { repositoryUri: 'https://github.com/acme/widgets', revisionId: HEAD },
        { repositoryUri: 'https://github.com/acme/widgets.git', revisionId: BASE },
      ],
    }));
    assertBlocked(outcome, ['provenance-conflict']);
  });

  test('an ssh repository URI for the same repository is recognized', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', { startLine: 7 }))], {
      versionControlProvenance: [{ repositoryUri: 'ssh://git@github.com/acme/widgets.git', revisionId: HEAD }],
    }));
    assertReady(outcome);
    assert.equal(outcome.review.comments[0].line, 7);
  });

  test('an earlier reviewed revision after branch advance becomes pinned general feedback, never retargeted', async () => {
    const reader = snapshotReader();
    const { outcome } = await prepare(sarifLog([result('Still capped?', at('src/app.js', { startLine: 7 }))], {
      versionControlProvenance: [{ repositoryUri: 'https://github.com/acme/widgets', revisionId: EARLIER }],
    }), { reader });
    assertReady(outcome);
    assert.deepStrictEqual(outcome.review.comments, []);
    assert.equal(outcome.review.body, `**Source:** [src/app.js line 7 at ea71ea7](${permalink(EARLIER, 'src/app.js', 7)})`
      + `\n\n\`\`\`\n  return items.slice(0, limit).map((item) => item.id);\n\`\`\`\n\nStill capped?\n\n${author('T')}`);
    assert.deepStrictEqual(outcome.evidence[0].source,
      { commit: EARLIER, path: 'src/app.js', startLine: 7, endLine: 7, text: '  return items.slice(0, limit).map((item) => item.id);' });
    assert.ok(reader.calls.every(([commit]) => commit === EARLIER));
  });

  test('a suggestion on an earlier revision blocks before any replacement is computed', async () => {
    const replacements = replacementBoundary();
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', { startLine: 3 }), {
      fixes: [fix({ startLine: 3, startColumn: 23, endColumn: 25 }, '20')],
    })], { versionControlProvenance: [{ repositoryUri: 'https://github.com/acme/widgets', revisionId: EARLIER }] }),
    { replacements });
    assertBlocked(outcome, [['suggestion-source-not-reviewed', '/runs/0/results/0']]);
    assert.deepStrictEqual(replacements.calls, []);
  });

  test('a suggestion on base-side source blocks', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', { startLine: 3 }), {
      fixes: [fix({ startLine: 3, startColumn: 23, endColumn: 25 }, '20')],
    })], { versionControlProvenance: [{ repositoryUri: 'https://github.com/acme/widgets', revisionId: BASE }] }));
    assertBlocked(outcome, [['suggestion-source-not-reviewed', '/runs/0/results/0']]);
  });

  test('without base provenance a deleted file is not reinterpreted from the reviewed head', async () => {
    const reader = snapshotReader();
    const { outcome } = await prepare(sarifLog([result('x', at('lib/legacy.js', { startLine: 1 }))]), { reader });
    assertBlocked(outcome, [['source-file-missing', '/runs/0/results/0']]);
    assert.deepStrictEqual(reader.calls, [[HEAD, 'lib/legacy.js']]);
  });

  const earlierReview = () => reviewContext({ reviewedCommit: EARLIER });

  test('an explicit earlier reviewed commit with the current diff yields exact historical general feedback', async () => {
    const reader = snapshotReader();
    const { outcome } = await prepare(sarifLog([result('Still capped?', at('src/app.js', { startLine: 7 }))]),
      { context: earlierReview(), reader });
    assertReady(outcome, EARLIER);
    assert.deepStrictEqual(outcome.review.comments, []);
    assert.equal(outcome.review.body, `**Source:** [src/app.js line 7 at ea71ea7](${permalink(EARLIER, 'src/app.js', 7)})`
      + `\n\n\`\`\`\n  return items.slice(0, limit).map((item) => item.id);\n\`\`\`\n\nStill capped?\n\n${author('T')}`);
    assert.deepStrictEqual(reader.calls, [[EARLIER, 'src/app.js']]);
  });

  test('under an earlier reviewed commit, current-diff anchors are never mixed into the review', async () => {
    const { outcome } = await prepare(sarifLog([result('Removed.', at('lib/legacy.js', { startLine: 1 }))], {
      versionControlProvenance: [{ repositoryUri: 'https://github.com/acme/widgets', revisionId: BASE }],
    }), { context: earlierReview() });
    assertReady(outcome, EARLIER);
    assert.deepStrictEqual(outcome.review.comments, []);
    assert.equal(outcome.evidence[0].treatment, 'general');
    assert.deepStrictEqual(outcome.evidence[0].source,
      { commit: BASE, path: 'lib/legacy.js', startLine: 1, endLine: 1, text: "module.exports = 'legacy';" });
  });

  test('an explicit earlier reviewed commit cannot carry a native suggestion', async () => {
    const replacements = replacementBoundary();
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', { startLine: 3 }), {
      fixes: [fix({ startLine: 3, startColumn: 23, endColumn: 25 }, '20')],
    })]), { context: earlierReview(), replacements });
    assertBlocked(outcome, [['suggestion-historical-unsupported', '/runs/0/results/0']]);
    assert.deepStrictEqual(replacements.calls, []);
  });

  test('an abbreviated reviewed commit is a caller error', async () => {
    await assert.rejects(prepare(sarifLog([result('x')]), { context: reviewContext({ reviewedCommit: HEAD.slice(0, 12) }) }),
      TypeError);
  });

  test('a relative source root is a caller error', async () => {
    await assert.rejects(prepare(sarifLog([result('x')]), { context: reviewContext({ sourceRootUri: 'work/widgets/' }) }),
      TypeError);
  });
});

describe('source validation blocks the whole review', () => {
  test('a nonexistent line blocks every otherwise valid finding', async () => {
    const { outcome } = await prepare(sarifLog([
      result('valid', at('src/app.js', { startLine: 7 })),
      result('beyond the end', at('src/app.js', { startLine: 21 })),
    ]));
    assertBlocked(outcome, [['source-range-invalid', '/runs/0/results/1']]);
  });

  test('a file absent at the source revision blocks', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/missing.js', { startLine: 1 }))]));
    assertBlocked(outcome, [['source-file-missing', '/runs/0/results/0']]);
  });

  test('a matching region snippet is accepted', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', {
      startLine: 7, snippet: { text: '  return items.slice(0, limit).map((item) => item.id);' },
    }))]));
    assertReady(outcome);
  });

  test('a region snippet that is not the source text blocks rather than retargeting', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', {
      startLine: 7, snippet: { text: '  return items.map((item) => item.id);' },
    }))]));
    assertBlocked(outcome, [['snippet-mismatch', '/runs/0/results/0']]);
  });

  test('a byte-offset region is explicitly unsupported', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', { byteOffset: 10, byteLength: 5 }))]));
    assertBlocked(outcome, [['region-unsupported', '/runs/0/results/0']]);
  });
});

describe('source region coordinates (SARIF 3.30, shared with the replacement module)', () => {
  // Head src/app.js line 7 is "  return items.slice(0, limit).map((item) => item.id);".
  // Its column 10 is "i" of "items"; lines 1-6 hold 115 UTF-16 code units, so
  // line 7 column 10 is charOffset 124, and "items.slice(0, limit)" is 21 units.
  const LINE_7_SPAN = 'items.slice(0, limit)';
  const readyLines = async (sarif, expected) => {
    const { outcome } = await prepare(sarif);
    assertReady(outcome);
    assert.deepStrictEqual(outcome.review.comments.map(({ body, ...c }) => c), [expected]);
  };
  const line7 = { path: 'src/app.js', side: 'RIGHT', line: 7 };

  test('a column snippet that is exactly the region substring is accepted', async () => {
    await readyLines(sarifLog([result('x', at('src/app.js', {
      startLine: 7, startColumn: 10, endColumn: 31, snippet: { text: LINE_7_SPAN } }))]), line7);
  });

  test('a column snippet that differs from the region substring blocks', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', {
      startLine: 7, startColumn: 10, endColumn: 31, snippet: { text: 'items.slice(0, limit' } }))]));
    assertBlocked(outcome, [['snippet-mismatch', '/runs/0/results/0']]);
  });

  test('agreeing line/column and charOffset forms are accepted', async () => {
    await readyLines(sarifLog([result('x', at('src/app.js', {
      startLine: 7, startColumn: 10, endColumn: 31, charOffset: 124, charLength: 21 }))]), line7);
  });

  test('disagreeing line/column and charOffset forms block rather than choosing one', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', {
      startLine: 7, startColumn: 10, endColumn: 31, charOffset: 125, charLength: 21 }))]));
    assertBlocked(outcome, [['source-coordinates-inconsistent', '/runs/0/results/0']]);
  });

  test('a BMP-unambiguous charOffset-only region is placed on the lines it covers', async () => {
    await readyLines(sarifLog([result('x', at('src/app.js', { charOffset: 124, charLength: 21, snippet: { text: LINE_7_SPAN } }))]),
      line7);
  });

  for (const [name, region] of [
    ['a column beyond the line', { startLine: 7, startColumn: 60 }],
    ['an end line before the start line', { startLine: 7, endLine: 6 }],
    ['an end column before the start column', { startLine: 7, startColumn: 20, endColumn: 10 }],
    ['an offset beyond the file', { charOffset: 5000, charLength: 1 }],
  ]) {
    test(`${name} blocks`, async () => {
      const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', region))]));
      assertBlocked(outcome, [['source-range-invalid', '/runs/0/results/0']]);
    });
  }

  // Head src/labels.js line 2 is "export const PARTY = '🎉 party';". The emoji
  // starts at column 23 in both units; "party" is UTF-16 columns 26-30 and
  // code-point columns 25-29; line 1 holds 26 code units, so "party" is
  // UTF-16 charOffset 51 and code-point charOffset 50.
  test('without columnKind, columns that mean different text in the two units block', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/labels.js', { startLine: 2, startColumn: 26, endColumn: 31 }))],
      { columnKind: undefined }));
    assertBlocked(outcome, [['column-kind-required', '/runs/0/results/0']]);
  });

  test('without columnKind, columns before any non-BMP character are unambiguous and accepted', async () => {
    await readyLines(sarifLog([result('x', at('src/labels.js', {
      startLine: 2, startColumn: 14, endColumn: 19, snippet: { text: 'PARTY' } }))], { columnKind: undefined }),
    { path: 'src/labels.js', side: 'RIGHT', line: 2 });
  });

  for (const [columnKind, startColumn] of [['utf16CodeUnits', 26], ['unicodeCodePoints', 25]]) {
    test(`an explicit ${columnKind} column after a non-BMP character selects the stated text`, async () => {
      await readyLines(sarifLog([result('x', at('src/labels.js', {
        startLine: 2, startColumn, endColumn: startColumn + 5, snippet: { text: 'party' } }))], { columnKind }),
      { path: 'src/labels.js', side: 'RIGHT', line: 2 });
    });
  }

  test('a charOffset whose two unit readings differ is explicitly unsupported', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/labels.js', { charOffset: 51, charLength: 5 }))]));
    assertBlocked(outcome, [['region-unsupported', '/runs/0/results/0']]);
  });

  test('coordinates exclude a leading byte-order mark', async () => {
    for (const region of [{ startLine: 1, startColumn: 1, endColumn: 6 }, { charOffset: 0, charLength: 5 }]) {
      const { outcome } = await prepare(sarifLog([result('x', at('docs/bom.txt', { ...region, snippet: { text: 'hello' } }))]));
      assertReady(outcome);
    }
  });

  test('a snippet that includes the byte-order mark does not match', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('docs/bom.txt', {
      startLine: 1, startColumn: 1, endColumn: 6, snippet: { text: '﻿hello' } }))]));
    assertBlocked(outcome, [['snippet-mismatch', '/runs/0/results/0']]);
  });

  test('an operational snapshot failure propagates with its cause instead of becoming a diagnostic', async () => {
    const failure = new Error('snapshot store unavailable');
    const reader = { calls: [], readSource: async () => { throw failure; } };
    await assert.rejects(prepare(sarifLog([result('x', at('src/app.js', { startLine: 7 }))]), { reader }),
      (error) => error === failure);
  });
});

describe('native suggestions from standard fixes', () => {
  test('a pure line deletion renders an empty suggestion block at its exact line', async () => {
    const { outcome } = await prepare(sarifLog([result('Drop this.', at('src/app.js', { startLine: 7 }), {
      fixes: [fix({ startLine: 7, startColumn: 1, endLine: 8, endColumn: 1 }, '')],
    })]));
    assertReady(outcome);
    assert.deepStrictEqual(outcome.review.comments, [{
      path: 'src/app.js', side: 'RIGHT', line: 7,
      body: `Drop this.\n\n${author('T')}\n\n\`\`\`suggestion\n\`\`\``,
    }]);
  });

  test('fixes are computed through the injected applyReplacement seam when one is given', async () => {
    // Private test seam (module doc "internals"): the replacement-module
    // boundary used for fixes is replaceable. The package's own tests and the
    // conversion's frozen oracle depend on it being honored, not ignored.
    const { outcome, replacements } = await prepare(sarifLog([result('Drop this.', at('src/app.js', { startLine: 7 }), {
      fixes: [fix({ startLine: 7, startColumn: 1, endLine: 8, endColumn: 1 }, '')],
    })]));
    assertReady(outcome);
    assert.equal(replacements.calls.length, 1, 'the injected boundary computed the fix');
    assert.equal(replacements.calls[0].insertedText, '');
    assert.deepStrictEqual(replacements.calls[0].deletedRegion, { startLine: 7, startColumn: 1, endLine: 8, endColumn: 1 });
  });

  test('different replacements on overlapping lines block', async () => {
    const { outcome } = await prepare(sarifLog([
      result('guard', at('src/app.js', { startLine: 16, endLine: 18 }), {
        fixes: [fix({ startLine: 16, startColumn: 1, endLine: 18, endColumn: 2 },
          "function average(values) {\n  if (values.length === 0) return 0;\n  return total(values) / values.length;\n}")],
      }),
      result('paren', at('src/app.js', { startLine: 17 }), {
        fixes: [fix({ startLine: 17, startColumn: 3, endColumn: 9 }, 'return (')],
      }),
    ]));
    assertBlocked(outcome, ['overlapping-replacements']);
  });

  test('different replacements of exactly the same lines block rather than merging', async () => {
    const { outcome } = await prepare(sarifLog([
      result('twenty', at('src/app.js', { startLine: 3 }), { fixes: [fix({ startLine: 3, startColumn: 23, endColumn: 25 }, '20')] }),
      result('thirty', at('src/app.js', { startLine: 3 }), { fixes: [fix({ startLine: 3, startColumn: 23, endColumn: 25 }, '30')] }),
    ]));
    assertBlocked(outcome, [['overlapping-replacements', '/runs/0/results/1']]);
  });

  const blockedFix = (name, fixes, code, run) => test(name, async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', { startLine: 3 }), { fixes })], run));
    assertBlocked(outcome, [[code, '/runs/0/results/0']]);
  });

  const limitFix = fix({ startLine: 3, startColumn: 23, endColumn: 25 }, '20');

  // SARIF's schema requires distinct fixes (uniqueItems), so the alternatives differ.
  blockedFix('alternative fixes are not silently chosen between',
    [limitFix, fix({ startLine: 3, startColumn: 23, endColumn: 25 }, '30')], 'fix-alternatives-unsupported');
  blockedFix('a fix changing several files is unsupported', [{ artifactChanges: [
    limitFix.artifactChanges[0], { ...limitFix.artifactChanges[0], artifactLocation: { uri: 'src/util.js' } },
  ] }], 'fix-multiple-files-unsupported');
  blockedFix('a fix with several replacements is unsupported', [{ artifactChanges: [{
    artifactLocation: { uri: 'src/app.js' },
    replacements: [limitFix.artifactChanges[0].replacements[0], {
      deletedRegion: { startLine: 17, startColumn: 3, endColumn: 9 }, insertedContent: { text: 'return (' } }],
  }] }], 'fix-multiple-replacements-unsupported');
  blockedFix('a binary replacement is unsupported', [{ artifactChanges: [{
    artifactLocation: { uri: 'src/app.js' },
    replacements: [{ deletedRegion: { startLine: 3 }, insertedContent: { binary: 'AAAA' } }],
  }] }], 'fix-binary-unsupported');
  blockedFix('a replacement the replacement module finds invalid blocks',
    [fix({ startLine: 3, startColumn: 23, endColumn: 40 }, '20')], 'replacement-invalid');
  blockedFix('a replacement outside the replacement module\'s profile blocks',
    [fix({ byteOffset: 60, byteLength: 2 }, '20')], 'replacement-unsupported');
  blockedFix('an edit changing whether the file ends with a newline is unsupported pending host verification',
    [fix({ startLine: 20, startColumn: 47, endLine: 21, endColumn: 1 }, '')], 'suggestion-final-newline-unverified');
  blockedFix('suggestion text containing a fence is unsupported pending host verification',
    [fix({ startLine: 17, startColumn: 1, endLine: 17, endColumn: 40 }, '  // ```\n  return total(values) / values.length;')],
    'suggestion-fence-unverified');
  blockedFix('suggestion text containing CR is unsupported pending host verification',
    [fix({ startLine: 7, startColumn: 1, endLine: 7, endColumn: 55 },
      '  // capped\r\n  return items.slice(0, limit).map((item) => item.id);')], 'suggestion-crlf-unverified');
  blockedFix('a suggestion outside the inline diff surface blocks rather than becoming non-applicable text',
    [fix({ startLine: 4, startColumn: 10, endColumn: 18 }, 'Math.max', 'src/util.js')], 'suggestion-not-inline');

  test('the replacement module\'s reason is reported', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', { startLine: 3 }), {
      fixes: [fix({ startLine: 3, startColumn: 23, endColumn: 40 }, '20')] })]));
    assertBlocked(outcome, ['replacement-invalid']);
    assert.ok(outcome.diagnostics.find((d) => d.code === 'replacement-invalid').message.includes('out-of-bounds'));
  });

  test('integration: without columnKind a BMP-unambiguous fix is prepared by the production module', async () => {
    const { outcome } = await prepare(sarifLog([result('Tighter default.', at('src/app.js', { startLine: 3 }), {
      fixes: [limitFix] })], { columnKind: undefined }), { realReplacement: true });
    assertReady(outcome);
    assert.deepStrictEqual(outcome.review.comments, [{
      path: 'src/app.js', side: 'RIGHT', line: 3,
      body: `Tighter default.\n\n${author('T')}\n\n\`\`\`suggestion\nconst DEFAULT_LIMIT = 20;\n\`\`\``,
    }]);
  });

  test('integration: without columnKind a fix whose columns differ by unit blocks', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/labels.js', { startLine: 2 }), {
      fixes: [fix({ startLine: 2, startColumn: 26, endColumn: 31 }, 'fiesta', 'src/labels.js')] })],
    { columnKind: undefined }), { realReplacement: true });
    assertBlocked(outcome, [['column-kind-required', '/runs/0/results/0']]);
  });

  test('integration: an explicit code-point fix after a non-BMP character replaces exactly the stated text', async () => {
    const { outcome } = await prepare(sarifLog([result('Livelier.', at('src/labels.js', { startLine: 2 }), {
      fixes: [fix({ startLine: 2, startColumn: 25, endColumn: 30 }, 'fiesta', 'src/labels.js')] })],
    { columnKind: 'unicodeCodePoints' }), { realReplacement: true });
    assertReady(outcome);
    assert.deepStrictEqual(outcome.review.comments, [{
      path: 'src/labels.js', side: 'RIGHT', line: 2,
      body: `Livelier.\n\n${author('T')}\n\n\`\`\`suggestion\nexport const PARTY = '🎉 fiesta';\n\`\`\``,
    }]);
  });
});

describe('proposed file operations and artifacts (D23)', () => {
  test('a proposed file creation is explicitly unsupported in this milestone', async () => {
    const sarif = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'examples', 'proposed-documentation.sarif.json'), 'utf8'));
    const { outcome } = await prepare(sarif);
    assertBlocked(outcome, [['file-operation-unsupported', '/runs/0/results/0']]);
  });

  test('an unknown proposed operation blocks', async () => {
    const { outcome } = await prepare(sarifLog([result('x', undefined, {
      properties: { sarifToComment: { proposedFileChanges: [{ operation: 'transmogrify', artifactIndex: 0 }] } },
    })], { artifacts: [{ location: { uri: 'src/app.js' } }] }));
    assertBlocked(outcome, [['file-operation-unknown', '/runs/0/results/0']]);
  });

  test('an artifact with contents never implies creation', async () => {
    const { outcome } = await prepare(sarifLog([result('About the new page.', at('docs/new.md', { startLine: 1 }))], {
      artifacts: [{ location: { uri: 'docs/new.md' }, contents: { text: '# New\n' } }],
    }));
    assertBlocked(outcome, [['source-file-missing', '/runs/0/results/0']]);
  });

  test('context artifacts with contents are retained with an explicit warning', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', { startLine: 7 }))], {
      artifacts: [{ location: { uri: 'notes/context.txt' }, contents: { text: 'analysis context' } }],
    }));
    assertReady(outcome);
    assert.ok(codes(outcome.warnings).includes('context-artifact-uninterpreted'));
    assert.ok(outcome.markdown.includes('context-artifact-uninterpreted'));
  });
});

describe('approval convention', () => {
  const held = (where) => {
    const property = { sarifToComment: { approval: 'awaiting-approval' } };
    return where === 'run'
      ? sarifLog([result('x', at('src/app.js', { startLine: 7 }))], { properties: property })
      : sarifLog([result('x', at('src/app.js', { startLine: 7 }), { properties: property })]);
  };

  test('a held result blocks the whole review', async () => {
    const { outcome } = await prepare(held('result'));
    assertBlocked(outcome, [['approval-hold', '/runs/0/results/0']]);
  });

  test('a held run blocks the whole review', async () => {
    const { outcome } = await prepare(held('run'));
    assertBlocked(outcome, [['approval-hold', '/runs/0']]);
  });

  test('the explicit override bypasses only the hold and is reported', async () => {
    const { outcome } = await prepare(held('result'), { options: { ignoreApprovalHold: true } });
    assertReady(outcome);
    assert.ok(codes(outcome.warnings).includes('approval-hold-overridden'));
    assert.equal(outcome.evidence[0].approval, 'hold-overridden');
  });

  test('the override never bypasses a mechanical error', async () => {
    const sarif = held('result');
    sarif.runs[0].results.push(result('beyond', at('src/app.js', { startLine: 99 })));
    const { outcome } = await prepare(sarif, { options: { ignoreApprovalHold: true } });
    assertBlocked(outcome, [['source-range-invalid', '/runs/0/results/1']]);
    assert.ok(!codes(outcome.diagnostics).includes('approval-hold'));
  });

  test('without the override a hold and a mechanical error are both reported', async () => {
    const sarif = held('result');
    sarif.runs[0].results.push(result('beyond', at('src/app.js', { startLine: 99 })));
    const { outcome } = await prepare(sarif);
    assertBlocked(outcome, [['approval-hold', '/runs/0/results/0'], ['source-range-invalid', '/runs/0/results/1']]);
  });

  test('a declared ready state is recorded as declared, not verified', async () => {
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', { startLine: 7 }), {
      properties: { sarifToComment: { approval: 'ready' } },
    })]));
    assertReady(outcome);
    assert.equal(outcome.evidence[0].approval, 'declared-ready');
  });

  for (const value of ['approved', 42, null]) {
    test(`an unknown approval state blocks even with the override: ${JSON.stringify(value)}`, async () => {
      const { outcome } = await prepare(sarifLog([result('x', undefined, {
        properties: { sarifToComment: { approval: value } },
      })]), { options: { ignoreApprovalHold: true } });
      assertBlocked(outcome, [['approval-state-invalid', '/runs/0/results/0']]);
    });
  }

  test('an unknown key in the owned namespace blocks', async () => {
    const { outcome } = await prepare(sarifLog([result('x', undefined, {
      properties: { sarifToComment: { approvalState: 'ready' } },
    })]));
    assertBlocked(outcome, [['owned-property-invalid', '/runs/0/results/0']]);
  });

  test('a non-object owned namespace blocks', async () => {
    const { outcome } = await prepare(sarifLog([result('x')], { properties: { sarifToComment: 'ready' } }));
    assertBlocked(outcome, [['owned-property-invalid', '/runs/0']]);
  });

  test('other producer properties are retained as uninterpreted metadata', async () => {
    const properties = { tags: ['security'], 'acme/score': 3 };
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', { startLine: 7 }), { properties })]));
    assertReady(outcome);
    assert.deepStrictEqual(outcome.evidence[0].uninterpretedProperties, properties);
  });
});

describe('meaningful SARIF features outside the profile are diagnosed, never omitted', () => {
  const located = at('src/app.js', { startLine: 7 });
  const unsupported = {
    'code-flows-unsupported': { codeFlows: [{ threadFlows: [{ locations: [{ location: located[0] }] }] }] },
    'related-locations-unsupported': { relatedLocations: [{ id: 1, ...located[0] }] },
    'graphs-unsupported': { graphs: [{ nodes: [{ id: 'n' }] }] },
    'stacks-unsupported': { stacks: [{ frames: [{ location: located[0] }] }] },
    'attachments-unsupported': { attachments: [{ artifactLocation: { uri: 'shot.png' } }] },
    'suppressed-result-unsupported': { suppressions: [{ kind: 'inSource' }] },
  };
  for (const [code, extras] of Object.entries(unsupported)) {
    test(`${code}`, async () => {
      const { outcome } = await prepare(sarifLog([result('x', located, extras)]));
      assertBlocked(outcome, [[code, '/runs/0/results/0']]);
    });
  }

  test('multiple locations are explicitly unsupported', async () => {
    const { outcome } = await prepare(sarifLog([result('x', [...located, ...at('src/app.js', { startLine: 20 })])]));
    assertBlocked(outcome, [['multiple-locations-unsupported', '/runs/0/results/0']]);
  });

  test('a logical-only location is explicitly unsupported', async () => {
    const { outcome } = await prepare(sarifLog([result('x', [{ logicalLocations: [{ fullyQualifiedName: 'app.fetchAll' }] }])]));
    assertBlocked(outcome, [['location-without-physical-source', '/runs/0/results/0']]);
  });

  test('independent problems in different results are all reported', async () => {
    const { outcome } = await prepare(sarifLog([
      result('x', located, unsupported['code-flows-unsupported']),
      result('y', at('src/app.js', { startLine: 99 })),
      { message: { id: 'nope' } },
    ]));
    assertBlocked(outcome, [
      ['code-flows-unsupported', '/runs/0/results/0'],
      ['source-range-invalid', '/runs/0/results/1'],
      ['message-unresolved', '/runs/0/results/2'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Regressions for release-blocking review findings. Each was written before
// its repair; see logs/opus/core-regressions-red.txt.

const limit20 = () => fix({ startLine: 3, startColumn: 23, endColumn: 25 }, '20');
const averageGuard = () => fix({ startLine: 16, startColumn: 1, endLine: 18, endColumn: 2 },
  "function average(values) {\n  if (values.length === 0) return 0;\n  return total(values) / values.length;\n}");
/** No line of a rendered body may open a native suggestion block. */
const EXECUTABLE_FENCE = /^[ \t>*+\-\d.)]*(`{3,}|~{3,})[ \t]*suggestion/im;

describe('regression: a fix never moves its result\'s own feedback or source (D3, D4)', () => {
  test('a location in another file than its fix blocks instead of moving the feedback', async () => {
    const { outcome } = await prepare(sarifLog([result('Feedback refers to util line 4.',
      at('src/util.js', { startLine: 4 }), { fixes: [limit20()] })]));
    assertBlocked(outcome, [['fix-association-unsupported', '/runs/0/results/0']]);
    const diagnostic = outcome.diagnostics.find((item) => item.code === 'fix-association-unsupported');
    assert.match(diagnostic.message, /Keep the correct result location/);
    assert.doesNotMatch(diagnostic.message, /Place the result inside/);
  });

  test('a distant location in the fix\'s own file blocks', async () => {
    const { outcome } = await prepare(sarifLog([result('About the exports.',
      at('src/app.js', { startLine: 20 }), { fixes: [limit20()] })]));
    assertBlocked(outcome, [['fix-association-unsupported', '/runs/0/results/0']]);
  });

  test('a location only partly inside the fix range blocks without enlarging the fix', async () => {
    const { outcome } = await prepare(sarifLog([result('Spans the boundary.',
      at('src/app.js', { startLine: 15, endLine: 17 }), { fixes: [averageGuard()] })]));
    assertBlocked(outcome, [['fix-association-unsupported', '/runs/0/results/0']]);
  });

  test('a location contained in the fix range accompanies the suggestion and keeps its own source', async () => {
    const { outcome } = await prepare(sarifLog([result('Divides by zero here.',
      at('src/app.js', { startLine: 17 }), { fixes: [averageGuard()] })]));
    assertReady(outcome);
    assert.deepStrictEqual(outcome.review.comments.map(({ body, ...c }) => c),
      [{ path: 'src/app.js', side: 'RIGHT', startSide: 'RIGHT', startLine: 16, line: 18 }]);
    assert.ok(outcome.review.comments[0].body.startsWith(`Divides by zero here.\n\n${author('T')}\n\n\`\`\`suggestion\n`));
    assert.deepStrictEqual(outcome.evidence[0].source,
      { commit: HEAD, path: 'src/app.js', startLine: 17, endLine: 17, text: '  return total(values) / values.length;' });
    assert.equal(outcome.evidence[0].replacement.startLine, 16);
    assert.equal(outcome.evidence[0].replacement.endLine, 18);
  });

  test('a result without a location explains its fix without inventing a source', async () => {
    const { outcome } = await prepare(sarifLog([result('Tighter default.', undefined, { fixes: [limit20()] })]));
    assertReady(outcome);
    assert.deepStrictEqual(outcome.review.comments, [{ path: 'src/app.js', side: 'RIGHT', line: 3,
      body: `Tighter default.\n\n${author('T')}\n\n\`\`\`suggestion\nconst DEFAULT_LIMIT = 20;\n\`\`\`` }]);
    assert.equal(outcome.evidence[0].source, undefined);
  });
});

describe('regression: producer Markdown can never create an executable suggestion', () => {
  const blockedAt = async (sarif, code) => {
    const { outcome } = await prepare(sarif);
    assertBlocked(outcome, [[code, '/runs/0/results/0']]);
  };

  for (const markdown of [
    '```suggestion\ninjected\n```',
    '~~~suggestion\ninjected\n~~~',
    '````Suggestion\ninjected\n````',
    'Look:\n\n   ```suggestion\ninjected\n   ```',
    '> ```suggestion\n> injected\n> ```',
    '- item\n  ```suggestion\n  injected\n  ```',
    '1. ```suggestion\n   injected\n   ```',
  ]) {
    test(`message markdown opening a suggestion block blocks: ${JSON.stringify(markdown)}`, async () => {
      await blockedAt(sarifLog([{ message: { text: 'ordinary', markdown }, locations: at('src/app.js', { startLine: 3 }) }]),
        'producer-suggestion-fence');
    });
  }

  test('a rule markdown template opening a suggestion block blocks', async () => {
    await blockedAt(sarifLog([{ ruleId: 'R1', message: { id: 'm' }, locations: at('src/app.js', { startLine: 3 }) }], {
      tool: { driver: { name: 'T', rules: [{ id: 'R1', messageStrings: { m: { text: 'x', markdown: '```suggestion\nx\n```' } } }] } },
    }), 'producer-suggestion-fence');
  });

  test('a global markdown template opening a suggestion block blocks', async () => {
    await blockedAt(sarifLog([{ message: { id: 'g' }, locations: at('src/app.js', { startLine: 3 }) }], {
      tool: { driver: { name: 'T', globalMessageStrings: { g: { text: 'x', markdown: '~~~ suggestion\nx\n~~~' } } } },
    }), 'producer-suggestion-fence');
  });

  test('a fix description in Markdown opening a suggestion block blocks', async () => {
    const f = limit20();
    f.description = { text: 'x', markdown: '```suggestion\nconst DEFAULT_LIMIT = 99;\n```' };
    await blockedAt(sarifLog([result('x', at('src/app.js', { startLine: 3 }), { fixes: [f] })]), 'producer-suggestion-fence');
  });

  test('an unclosed producer fence blocks because it would swallow attribution and fixes', async () => {
    await blockedAt(sarifLog([{ message: { text: 'x', markdown: 'See:\n```js\nconst x = 1;' }, locations: at('src/app.js', { startLine: 3 }) }]),
      'producer-fence-unclosed');
  });

  test('a longer opening fence is not closed by a shorter one', async () => {
    await blockedAt(sarifLog([{ message: { text: 'x', markdown: '````\n```\ninner' }, locations: at('src/app.js', { startLine: 3 }) }]),
      'producer-fence-unclosed');
  });

  for (const markdown of ['```js\nconst x = 1;\n```', '~~~\n```\nnot a close\n~~~', '```\nopen\n````', '````\n```\ninner\n````',
    '````md\n```suggestion\ninert\n```\n````']) {
    test(`a balanced ordinary fence is kept verbatim: ${JSON.stringify(markdown)}`, async () => {
      const { outcome } = await prepare(sarifLog([{ message: { text: 'x', markdown }, locations: at('src/app.js', { startLine: 7 }) }]));
      if (markdown.includes('suggestion')) {
        // A nested suggestion line inside a longer fence is inert Markdown, but
        // the conservative profile does not rely on renderer fence nesting.
        assertBlocked(outcome, [['producer-suggestion-fence', '/runs/0/results/0']]);
        return;
      }
      assertReady(outcome);
      assert.equal(outcome.review.comments[0].body, `${markdown}\n\n${author('T')}`);
    });
  }

  test('fence-shaped plain text stays inert', async () => {
    const { outcome } = await prepare(sarifLog([result('```suggestion\ninjected\n```', at('src/app.js', { startLine: 7 }))]));
    assertReady(outcome);
    assert.doesNotMatch(outcome.review.comments[0].body, EXECUTABLE_FENCE);
  });

  test('fence-shaped arguments inserted into templates stay inert', async () => {
    const sarif = sarifLog([
      { ruleId: 'R1', message: { id: 'md', arguments: ['\n```suggestion\ninjected\n```\n'] }, locations: at('src/app.js', { startLine: 7 }) },
      { ruleId: 'R1', message: { id: 'txt', arguments: ['\n```suggestion\ninjected\n```\n'] }, locations: at('src/app.js', { startLine: 20 }) },
    ], { tool: { driver: { name: 'T', rules: [{ id: 'R1', messageStrings: {
      md: { text: 'See {0}', markdown: 'See {0}' }, txt: { text: 'See {0}' } } }] } } });
    const { outcome } = await prepare(sarif);
    assertReady(outcome);
    for (const comment of outcome.review.comments) assert.doesNotMatch(comment.body, EXECUTABLE_FENCE);
  });
});

describe('regression: direct messages substitute their arguments (SARIF 3.11.5, 3.11.11)', () => {
  const bodyOf = async (message) => {
    const { outcome } = await prepare(sarifLog([{ message }]));
    assertReady(outcome);
    return outcome.review.body;
  };

  test('direct text with arguments', async () => {
    assert.equal(await bodyOf({ text: 'Variable {0} is uninitialized.', arguments: ['pBuffer'] }),
      `Variable pBuffer is uninitialized.\n\n${author('T')}`);
  });

  test('direct markdown with arguments inserts them as literal text', async () => {
    assert.equal(await bodyOf({ text: 'Use {0}', markdown: 'Use **{0}**', arguments: ['a*b'] }),
      `Use **a\\*b**\n\n${author('T')}`);
  });

  test('doubled braces in direct text are literal braces', async () => {
    assert.equal(await bodyOf({ text: 'Set {{x}} to {0}', arguments: ['1'] }), `Set \\{x\\} to 1\n\n${author('T')}`);
  });

  test('a direct placeholder without its argument blocks', async () => {
    const { outcome } = await prepare(sarifLog([{ message: { text: 'Needs {1}', arguments: ['x'] } }]));
    assertBlocked(outcome, [['message-argument-missing', '/runs/0/results/0']]);
  });

  test('a fix description substitutes its arguments', async () => {
    const f = limit20();
    f.description = { text: 'Use {0}.', arguments: ['20'] };
    const { outcome } = await prepare(sarifLog([result('Tighter default.', at('src/app.js', { startLine: 3 }), { fixes: [f] })]));
    assertReady(outcome);
    assert.ok(outcome.review.comments[0].body.includes('**Fix:** Use 20.'));
  });
});

describe('regression: native suggestions are emitted only where the observed host application is exact', () => {
  // GitHub application evidence: docs/native-suggestion-fidelity-experiment.md.
  // The probe records payloads, intended files and applied files; the head
  // files below are reconstructed with an "old" placeholder in the replaced
  // lines, which the observed application does not depend on.
  const probeDir = path.join(__dirname, '..', 'docs', 'evidence', 'native-fidelity-probe');
  const probeRequest = JSON.parse(fs.readFileSync(path.join(probeDir, 'request.json'), 'utf8'));
  const probeApplied = JSON.parse(fs.readFileSync(path.join(probeDir, 'applied-files.json'), 'utf8')).results;
  const probeDirName = 'sarif-native-fidelity';
  const PROBE_HEAD = '9e0d9e0d9e0d9e0d9e0d9e0d9e0d9e0d9e0d9e0d';
  const PROBE_BASE = '9ba59ba59ba59ba59ba59ba59ba59ba59ba59ba5';
  const heads = {
    'lf.txt': 'before\nold\nafter\n',
    'crlf-lf.txt': 'before\r\nold\r\nafter\r\n',
    'no-final-newline.txt': 'before\nold',
    'delete-last-line.txt': 'before\nold\n',
    'blank-last-line.txt': 'before\nold\n',
    'fences.md': 'before\nold\nafter\n',
    'delete-no-final-newline.txt': 'before\nold',
    'multiline.txt': 'before\nold one\nold two\nafter\n',
    'crlf-mixed.txt': 'before\r\nold\r\nafter\r\n',
  };
  /** A creation patch for a head text: every line is an addition. */
  const creationPatch = (p, text) => {
    const lines = text.match(/[^\n]*\n|[^\n]+$/g);
    return `--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${lines.length} @@\n${lines
      .map((l) => (l.endsWith('\n') ? `+${l}` : `+${l}\n\\ No newline at end of file\n`)).join('')}`;
  };
  const probeContext = () => ({
    owner: OWNER, repo: REPO, pullNumber: PULL, reviewedCommit: PROBE_HEAD,
    diff: { baseCommit: PROBE_BASE, headCommit: PROBE_HEAD,
      files: Object.entries(heads).map(([name, text]) => ({ path: `${probeDirName}/${name}`, patch: creationPatch(`${probeDirName}/${name}`, text) })) },
  });
  const probeReader = () => ({ calls: [], readSource: async (commit, p) => (commit === PROBE_HEAD && p.startsWith(`${probeDirName}/`)
    ? heads[p.slice(probeDirName.length + 1)] ?? null : null) });

  const cases = [
    ['lf.txt', { startLine: 2 }, 'new', 'ready'],
    ['crlf-lf.txt', { startLine: 2 }, 'new', 'ready'],
    ['no-final-newline.txt', { startLine: 2 }, 'new', 'ready'],
    ['delete-last-line.txt', { startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 }, '', 'ready'],
    ['multiline.txt', { startLine: 2, endLine: 3 }, 'new one\nnew two', 'ready'],
    ['blank-last-line.txt', { startLine: 2 }, '', 'suggestion-blank-only-unverified'],
    ['fences.md', { startLine: 2 }, '```js\ncode\n```\ntrailing', 'suggestion-fence-unverified'],
    ['delete-no-final-newline.txt', { startLine: 2, startColumn: 1, endColumn: 4 }, '', 'suggestion-final-newline-unverified'],
  ];

  for (const [name, region, inserted, expected] of cases) {
    test(`${name}: ${expected}`, async () => {
      const p = `${probeDirName}/${name}`;
      const probe = probeApplied.find((r) => r.path === p);
      const { applyReplacement } = require('../src/replacements.cjs');
      const intended = applyReplacement({ sourceText: heads[name], deletedRegion: region, insertedText: inserted, columnKind: 'utf16CodeUnits' });
      assert.equal(intended.editedText, probe.expected, 'the fixture edit must intend the probe\'s expected file');

      const lines = { startLine: region.startLine, ...(region.endLine && region.endColumn === undefined ? { endLine: region.endLine } : {}) };
      const sarif = sarifLog([result('probe', at(p, lines), { fixes: [fix(region, inserted, p)] })]);
      const { outcome } = await prepare(sarif, { context: probeContext(), reader: probeReader(), realReplacement: true });
      if (expected !== 'ready') {
        assertBlocked(outcome, [[expected, '/runs/0/results/0']]);
        assert.equal(probe.matches, false, 'blocked only where the host was observed to misapply');
        return;
      }
      assertReady(outcome, PROBE_HEAD);
      assert.equal(probe.matches, true, 'emitted only where the host was observed to apply exactly');
      const body = outcome.review.comments[0].body;
      const probeBody = probeRequest.comments.find((c) => c.path === p).body;
      assert.equal(body.slice(body.indexOf('```suggestion')), probeBody.slice(probeBody.indexOf('```suggestion')));
      assert.ok(!body.includes('\r'), 'a raw CR is never emitted');
    });
  }

  test('the observed CRLF payload doubled its CR, so a CR payload is never emitted', () => {
    const crlf = probeRequest.comments.find((c) => c.path === `${probeDirName}/crlf-crlf.txt`);
    assert.ok(crlf.body.includes('\r'));
    assert.equal(probeApplied.find((r) => r.path === crlf.path).matches, false);
  });

  test('a replacement mixing LF into a CRLF source is not emitted', async () => {
    const p = `${probeDirName}/crlf-mixed.txt`;
    const sarif = sarifLog([result('probe', at(p, { startLine: 2 }), { fixes: [fix({ startLine: 2 }, 'new\nextra', p)] })]);
    const { outcome } = await prepare(sarif, { context: probeContext(), reader: probeReader(), realReplacement: true });
    assertBlocked(outcome, [['suggestion-crlf-unverified', '/runs/0/results/0']]);
  });
});

describe('regression: the source-region bridge needs no source-dependent sentinel', () => {
  test('a source containing every private-use character still resolves the exact span', async () => {
    let privateUse = '';
    for (let code = 0xe000; code <= 0xf8ff; code += 1) privateUse += String.fromCharCode(code);
    const text = `${privateUse}\ntarget line\n`;
    const reader = { calls: [], readSource: async (commit, p) => (p === 'docs/private.txt' ? text : snapshotReader().readSource(commit, p)) };
    const { outcome } = await prepare(sarifLog([result('x', at('docs/private.txt', {
      startLine: 2, startColumn: 1, endColumn: 7, snippet: { text: 'target' } }))]), { reader });
    assertReady(outcome);
    assert.deepStrictEqual(outcome.evidence[0].source,
      { commit: HEAD, path: 'docs/private.txt', startLine: 2, endLine: 2, text: 'target line' });
  });
});

// ---------------------------------------------------------------------------
// Profile-boundary regressions: producer newline semantics, external findings
// and component-qualified rules. Written before repair; see
// logs/opus/profile-boundary-red.txt.

describe('regression: declared newline sequences (SARIF 3.14.20) never change the source association', () => {
  const located = (run) => sarifLog([result('x', at('src/app.js', { startLine: 7 }))], run);

  test('a non-default newline sequence blocks located feedback instead of reading lines as CRLF/LF', async () => {
    const reader = snapshotReader();
    const { outcome } = await prepare(located({ newlineSequences: ['|'] }), { reader });
    assertBlocked(outcome, [['newline-sequences-unsupported', '/runs/0/results/0']]);
    assert.deepStrictEqual(reader.calls, []);
  });

  test('an extended newline set (default plus another) blocks', async () => {
    const { outcome } = await prepare(located({ newlineSequences: ['\r\n', '\n', ' '] }));
    assertBlocked(outcome, [['newline-sequences-unsupported', '/runs/0/results/0']]);
  });

  test('a non-default newline sequence blocks a fix', async () => {
    const { outcome } = await prepare(sarifLog([result('x', undefined, {
      fixes: [fix({ startLine: 3, startColumn: 23, endColumn: 25 }, '20')] })], { newlineSequences: ['\n'] }));
    assertBlocked(outcome, [['newline-sequences-unsupported', '/runs/0/results/0']]);
  });

  for (const newlineSequences of [['\r\n', '\n'], ['\n', '\r\n']]) {
    test(`the default newline set is accepted in any order: ${JSON.stringify(newlineSequences)}`, async () => {
      const { outcome } = await prepare(located({ newlineSequences }));
      assertReady(outcome);
      assert.deepStrictEqual(outcome.review.comments.map(({ body, ...c }) => c), [{ path: 'src/app.js', side: 'RIGHT', line: 7 }]);
    });
  }

  test('a result without source coordinates is unaffected by declared newline sequences', async () => {
    const { outcome } = await prepare(sarifLog([result('General note.')], { newlineSequences: ['|'] }));
    assertReady(outcome);
    assert.equal(outcome.review.body, `General note.\n\n${author('T')}`);
  });
});

describe('regression: findings held in external property files are never lost', () => {
  const externalRef = { location: { uri: 'results.sarif-external-properties.json' }, itemCount: 10 };

  test('external results with no inline results block instead of producing an empty review', async () => {
    const { outcome } = await prepare(sarifLog([], { externalPropertyFileReferences: { results: [externalRef] } }));
    assertBlocked(outcome, [['external-properties-unsupported', '/runs/0/externalPropertyFileReferences']]);
  });

  test('external results alongside inline results block the whole review', async () => {
    const { outcome } = await prepare(sarifLog([result('inline')], { externalPropertyFileReferences: { results: [externalRef] } }));
    assertBlocked(outcome, ['external-properties-unsupported']);
  });

  test('any other external property file also blocks, since it can carry meaning for findings', async () => {
    const { outcome } = await prepare(sarifLog([result('inline')], { externalPropertyFileReferences: { extensions: [externalRef] } }));
    assertBlocked(outcome, [['external-properties-unsupported', '/runs/0/externalPropertyFileReferences']]);
  });

  test('log-level inline external properties block', async () => {
    const sarif = sarifLog([result('inline')]);
    sarif.inlineExternalProperties = [{ results: [{ message: { text: 'hidden' } }] }];
    const { outcome } = await prepare(sarif);
    assertBlocked(outcome, [['external-properties-unsupported', '/inlineExternalProperties']]);
  });
});

describe('regression: rules in tool extensions keep their component identity (SARIF 3.52.4, 3.54)', () => {
  const EXT_GUID = '9b3c1c2e-4d5f-4a6b-8c7d-0e1f2a3b4c5d';
  const tool = {
    driver: { name: 'CoreAnalyzer', version: '5.0.0', rules: [{ id: 'CORE1', messageStrings: { m: { text: 'Core says {0}' } } }] },
    extensions: [{ name: 'ext-pack', version: '1.2.0', guid: EXT_GUID,
      globalMessageStrings: { g: { text: 'Extension global {0}' } },
      rules: [{ id: 'EXT1', messageStrings: { m: { text: 'Extension says {0}' } } }] }],
  };
  const extensionAuthor = '<sub>— CoreAnalyzer 5.0.0 · ext-pack 1.2.0 · rule `EXT1`</sub>';
  const run = (r) => sarifLog([r], { tool });

  const ready = async (r) => {
    const { outcome } = await prepare(run(r));
    assertReady(outcome);
    return outcome;
  };

  test('rule.toolComponent.index names the extension; its rule, message strings and identity are kept', async () => {
    const outcome = await ready({ rule: { id: 'EXT1', index: 0, toolComponent: { index: 0 } }, message: { id: 'm', arguments: ['hi'] } });
    assert.equal(outcome.review.body, `Extension says hi\n\n${extensionAuthor}`);
    assert.deepStrictEqual(outcome.evidence[0].attribution,
      { tool: 'CoreAnalyzer', version: '5.0.0', component: { name: 'ext-pack', version: '1.2.0' }, ruleId: 'EXT1' });
  });

  test('ruleId plus rule.toolComponent resolves the rule inside the extension, not the driver', async () => {
    const outcome = await ready({ ruleId: 'EXT1', rule: { id: 'EXT1', toolComponent: { index: 0 } }, message: { id: 'm', arguments: ['x'] } });
    assert.equal(outcome.review.body, `Extension says x\n\n${extensionAuthor}`);
  });

  test('ruleIndex is interpreted within the referenced extension', async () => {
    const outcome = await ready({ ruleIndex: 0, rule: { index: 0, toolComponent: { index: 0 } }, message: { id: 'm', arguments: ['y'] } });
    assert.equal(outcome.review.body, `Extension says y\n\n${extensionAuthor}`);
  });

  test('a component referenced by guid is found among the extensions', async () => {
    const outcome = await ready({ rule: { id: 'EXT1', toolComponent: { guid: EXT_GUID } }, message: { text: 'Plain.' } });
    assert.equal(outcome.review.body, `Plain.\n\n${extensionAuthor}`);
  });

  test('message.id falls back to the extension\'s own global message strings', async () => {
    const outcome = await ready({ rule: { id: 'EXT1', toolComponent: { index: 0 } }, message: { id: 'g', arguments: ['z'] } });
    assert.equal(outcome.review.body, `Extension global z\n\n${extensionAuthor}`);
  });

  test('a driver rule without a component reference keeps driver attribution', async () => {
    const outcome = await ready({ ruleId: 'CORE1', message: { id: 'm', arguments: ['d'] } });
    assert.equal(outcome.review.body, 'Core says d\n\n<sub>— CoreAnalyzer 5.0.0 · rule `CORE1`</sub>');
    assert.deepStrictEqual(outcome.evidence[0].attribution, { tool: 'CoreAnalyzer', version: '5.0.0', ruleId: 'CORE1' });
  });

  for (const [name, toolComponent] of [['an extension index out of range', { index: 3 }],
    ['an unknown component guid', { guid: '1b3c1c2e-4d5f-4a6b-8c7d-0e1f2a3b4c5d' }], ['an unknown component name', { name: 'nope' }]]) {
    test(`${name} blocks instead of falling back to the driver`, async () => {
      const { outcome } = await prepare(run({ rule: { id: 'EXT1', toolComponent }, message: { text: 'x' } }));
      assertBlocked(outcome, [['rule-component-unresolved', '/runs/0/results/0']]);
    });
  }

  test('an extension rule index naming a different rule id blocks', async () => {
    const { outcome } = await prepare(run({ rule: { id: 'OTHER', index: 0, toolComponent: { index: 0 } }, message: { text: 'x' } }));
    assertBlocked(outcome, [['rule-reference-conflict', '/runs/0/results/0']]);
  });

  test('an extension message id that does not exist blocks', async () => {
    const { outcome } = await prepare(run({ rule: { id: 'EXT1', toolComponent: { index: 0 } }, message: { id: 'missing' } }));
    assertBlocked(outcome, [['message-unresolved', '/runs/0/results/0']]);
  });

  test('result taxa referencing components are reported rather than silently dropped', async () => {
    const outcome = await ready({ ruleId: 'CORE1', message: { text: 'x' }, taxa: [{ id: 'CWE-89', toolComponent: { name: 'CWE' } }] });
    assert.ok(codes(outcome.warnings).includes('taxa-uninterpreted'));
    assert.deepStrictEqual(outcome.evidence[0].taxa, [{ id: 'CWE-89', toolComponent: { name: 'CWE' } }]);
  });
});

// ---------------------------------------------------------------------------
// Assembled-review fidelity regressions (logs/opus/assembled-review-03).
// Written before repair; see logs/opus/fidelity-red.txt.

describe('regression: result classification is rendered, never discarded (SARIF 3.27.9-3.27.10, 3.27.24)', () => {
  const inlineBody = async (r, run) => {
    const { outcome } = await prepare(sarifLog([{ locations: at('src/app.js', { startLine: 7 }), ...r }], run));
    assertReady(outcome);
    return outcome.review.comments[0].body;
  };

  test('explicit error and note levels render differently', async () => {
    assert.equal(await inlineBody({ level: 'error', message: { text: 'same' } }), `**Level:** error\n\nsame\n\n${author('T')}`);
    assert.equal(await inlineBody({ level: 'note', message: { text: 'same' } }), `**Level:** note\n\nsame\n\n${author('T')}`);
  });

  test('a passing result says it passed instead of reading as a problem', async () => {
    assert.equal(await inlineBody({ kind: 'pass', level: 'none', message: { text: 'Rule R1 passed' } }),
      `**Level:** none · **Kind:** pass\n\nRule R1 passed\n\n${author('T')}`);
  });

  for (const state of ['new', 'unchanged', 'updated']) {
    test(`baselineState ${state} is rendered`, async () => {
      assert.equal(await inlineBody({ baselineState: state, message: { text: 'x' } }), `**Baseline:** ${state}\n\nx\n\n${author('T')}`);
    });
  }

  test('an absent baseline result blocks: it describes a baseline run whose source revision is not established', async () => {
    const { outcome } = await prepare(sarifLog([{ baselineState: 'absent', message: { text: 'fixed already' }, locations: at('src/app.js', { startLine: 7 }) }]));
    assertBlocked(outcome, [['baseline-absent-unsupported', '/runs/0/results/0']]);
  });

  test('the rule\'s default level applies when the result states none, and the result\'s own level wins', async () => {
    const run = { tool: { driver: { name: 'T', rules: [{ id: 'R1', defaultConfiguration: { level: 'error' } }] } } };
    assert.equal(await inlineBody({ ruleId: 'R1', message: { text: 'x' } }, run), `**Level:** error\n\nx\n\n${author('T', 'R1')}`);
    assert.equal(await inlineBody({ ruleId: 'R1', level: 'note', message: { text: 'x' } }, run), `**Level:** note\n\nx\n\n${author('T', 'R1')}`);
  });

  test('classification is kept in evidence', async () => {
    const { outcome } = await prepare(sarifLog([{ kind: 'review', level: 'warning', baselineState: 'new', message: { text: 'x' } }]));
    assertReady(outcome);
    assert.deepStrictEqual(outcome.evidence[0].classification, { kind: 'review', level: 'warning', baselineState: 'new' });
  });
});

describe('regression: a location\'s own message is rendered (SARIF 3.28.5)', () => {
  test('location.message follows the result message', async () => {
    const { outcome } = await prepare(sarifLog([{ message: { text: 'SQL injection.' }, locations: [{
      message: { text: 'tainted value reaches the query here' }, physicalLocation: { artifactLocation: { uri: 'src/app.js' }, region: { startLine: 7 } } }] }]));
    assertReady(outcome);
    assert.equal(outcome.review.comments[0].body,
      `SQL injection.\n\n**At this location:** tainted value reaches the query here\n\n${author('T')}`);
    assert.equal(outcome.evidence[0].locationMessage, 'tainted value reaches the query here');
  });

  test('a location message is subject to the producer suggestion-fence guard', async () => {
    const { outcome } = await prepare(sarifLog([{ message: { text: 'x' }, locations: [{
      message: { text: 'x', markdown: '```suggestion\ninjected\n```' }, physicalLocation: { artifactLocation: { uri: 'src/app.js' }, region: { startLine: 7 } } }] }]));
    assertBlocked(outcome, [['producer-suggestion-fence', '/runs/0/results/0']]);
  });

  test('region annotations on a location are explicitly unsupported', async () => {
    const { outcome } = await prepare(sarifLog([{ message: { text: 'x' }, locations: [{
      physicalLocation: { artifactLocation: { uri: 'src/app.js' }, region: { startLine: 7 } },
      annotations: [{ startLine: 6, message: { text: 'source' } }] }] }]));
    assertBlocked(outcome, [['location-annotations-unsupported', '/runs/0/results/0']]);
  });
});

describe('regression: a failed analysis is never presented as a complete review (SARIF 3.20)', () => {
  test('an unsuccessful invocation blocks and quotes its error notifications', async () => {
    const { outcome } = await prepare(sarifLog([result('partial')], { invocations: [{ executionSuccessful: false,
      toolExecutionNotifications: [{ level: 'error', message: { text: 'analyzer crashed on 40 files' } }] }] }));
    assertBlocked(outcome, [['invocation-failed', '/runs/0/invocations/0']]);
    assert.ok(outcome.diagnostics.find((d) => d.code === 'invocation-failed').message.includes('analyzer crashed on 40 files'));
  });

  test('error notifications in a successful invocation are reported as warnings', async () => {
    const { outcome } = await prepare(sarifLog([result('ok')], { invocations: [{ executionSuccessful: true,
      toolConfigurationNotifications: [{ level: 'error', message: { text: 'rule R9 disabled: bad config' } }] }] }));
    assertReady(outcome);
    const warning = outcome.warnings.find((w) => w.code === 'tool-notification-error');
    assert.ok(warning && warning.message.includes('rule R9 disabled: bad config'));
  });

  test('a successful invocation without error notifications changes nothing', async () => {
    const { outcome } = await prepare(sarifLog([result('ok')], { invocations: [{ executionSuccessful: true }] }));
    assertReady(outcome);
    assert.deepStrictEqual(outcome.warnings, []);
  });
});

describe('regression: producer HTML can never hide later content', () => {
  const md = (markdown, locations) => ({ message: { text: 'x', markdown }, ...(locations ? { locations } : {}) });

  test('an unterminated HTML comment in the body blocks instead of hiding the next finding', async () => {
    const { outcome } = await prepare(sarifLog([md('First finding <!-- unterminated'), result('Second finding: SQL injection')]));
    assertBlocked(outcome, [['producer-html-unbalanced', '/runs/0/results/0']]);
  });

  test('an unterminated comment before a validated suggestion blocks', async () => {
    const { outcome } = await prepare(sarifLog([{ message: { text: 'x', markdown: 'Please apply <!--' },
      locations: at('src/app.js', { startLine: 3 }), fixes: [limit20()] }]));
    assertBlocked(outcome, [['producer-html-unbalanced', '/runs/0/results/0']]);
  });

  for (const markdown of ['<pre>\nsee', '<details>\n<summary>more</summary>', 'text </sub> more', '<?php echo 1;', '<![CDATA[ x', 'a <span>b']) {
    test(`unbalanced producer HTML blocks: ${JSON.stringify(markdown)}`, async () => {
      const { outcome } = await prepare(sarifLog([md(markdown)]));
      assertBlocked(outcome, [['producer-html-unbalanced', '/runs/0/results/0']]);
    });
  }

  for (const markdown of ['<details><summary>More</summary>\n\nHidden detail.\n</details>', 'Line<br>break <img src="x.png" alt="y"/>',
    'if a < b and c > d', 'See <https://example.com/x> and <a@example.com>', 'Code `<!-- not html` stays', '```html\n<div>\n```',
    '<!-- complete comment --> visible']) {
    test(`balanced or non-HTML producer Markdown is kept verbatim: ${JSON.stringify(markdown)}`, async () => {
      const { outcome } = await prepare(sarifLog([md(markdown)]));
      assertReady(outcome);
      assert.equal(outcome.review.body, `${markdown}\n\n${author('T')}`);
    });
  }

  test('a fix description with unbalanced HTML blocks', async () => {
    const f = limit20();
    f.description = { text: 'x', markdown: 'Apply <details>' };
    const { outcome } = await prepare(sarifLog([result('x', at('src/app.js', { startLine: 3 }), { fixes: [f] })]));
    assertBlocked(outcome, [['producer-html-unbalanced', '/runs/0/results/0']]);
  });

  test('HTML-shaped plain text stays inert', async () => {
    const { outcome } = await prepare(sarifLog([result('First <!-- still text')]));
    assertReady(outcome);
    assert.equal(outcome.review.body, `First \\<\\!-- still text\n\n${author('T')}`);
  });
});

describe('regression: plain-text @mentions are rendered literally, not as notifications', () => {
  const bodyOf = async (sarif) => {
    const { outcome } = await prepare(sarif);
    assertReady(outcome);
    return outcome.review.body;
  };

  test('user and team mentions in plain text keep their exact characters inside code spans', async () => {
    assert.equal(await bodyOf(sarifLog([result('Ask @octo-org/security or @alice.')])),
      `Ask \`@octo-org/security\` or \`@alice\`.\n\n${author('T')}`);
  });

  test('an email address is not treated as a mention', async () => {
    assert.equal(await bodyOf(sarifLog([result('Mail a@example.com')])), `Mail a@example.com\n\n${author('T')}`);
  });

  test('a mention at the start of a line is neutralized as well', async () => {
    assert.equal(await bodyOf(sarifLog([result('@bob should look')])), `\`@bob\` should look\n\n${author('T')}`);
  });

  test('literal arguments inserted into a Markdown template are neutralized', async () => {
    assert.equal(await bodyOf(sarifLog([{ ruleId: 'R1', message: { id: 'm', arguments: ['@carol'] } }], {
      tool: { driver: { name: 'T', rules: [{ id: 'R1', messageStrings: { m: { text: 'x', markdown: 'Owner: **{0}**' } } }] } },
    })), `Owner: **\`@carol\`**\n\n${author('T', 'R1')}`);
  });

  test('a tool name in the attribution line is neutralized', async () => {
    assert.equal(await bodyOf(sarifLog([result('x')], { tool: { driver: { name: '@bot-scanner' } } })), 'x\n\n<sub>— `@bot-scanner`</sub>');
  });

  test('producer Markdown keeps its own mentions and links verbatim (the producer chose Markdown semantics)', async () => {
    const markdown = 'Ping @dave and see [the guide](https://example.com/guide)';
    assert.equal(await bodyOf(sarifLog([{ message: { text: 'x', markdown } }])), `${markdown}\n\n${author('T')}`);
  });

  test('plain-text URLs are left as ordinary text', async () => {
    assert.equal(await bodyOf(sarifLog([result('See https://example.com/docs')])), `See https://example.com/docs\n\n${author('T')}`);
  });
});

describe('complete payload bounds', () => {
  const twoComments = () => sarifLog([
    result('first', at('src/app.js', { startLine: 7 })),
    result('second', at('src/app.js', { startLine: 20 })),
  ]);

  test('within bounds the review is prepared whole', async () => {
    const { outcome } = await prepare(twoComments(), { options: { maxComments: 2, maxPayloadBytes: 100000, maxCommentBodyChars: 1000 } });
    assertReady(outcome);
    assert.equal(outcome.review.comments.length, 2);
  });

  test('more inline comments than the bound blocks without splitting', async () => {
    const { outcome } = await prepare(twoComments(), { options: { maxComments: 1 } });
    assertBlocked(outcome, ['too-many-comments']);
  });

  test('a payload over the byte bound blocks without truncation', async () => {
    const { outcome } = await prepare(twoComments(), { options: { maxPayloadBytes: 50 } });
    assertBlocked(outcome, ['payload-too-large']);
  });

  test('a comment body over the character bound blocks', async () => {
    const { outcome } = await prepare(twoComments(), { options: { maxCommentBodyChars: 10 } });
    assertBlocked(outcome, ['comment-too-large']);
  });

  test('the default bounds accept the complete fixture review', async () => {
    const { outcome } = await prepare(loadJson('complete-review.sarif.json'), { options: {} });
    assertReady(outcome);
  });

  // Default product limits (not claims about GitHub maxima): 100 inline
  // comments, 60000 UTF-16 code units per comment body or review body, and
  // 1,000,000 bytes of UTF-8 JSON for { body, comments }.
  const onLine7 = (text) => result(text, at('src/app.js', { startLine: 7 }));

  test('default: 100 inline comments are accepted and 101 block', async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => onLine7(`note ${i}`));
    assertReady((await prepare(sarifLog(hundred))).outcome);
    const { outcome } = await prepare(sarifLog([...hundred, onLine7('one more')]));
    assertBlocked(outcome, ['too-many-comments']);
  });

  test('default: a 60000-unit comment body is accepted and a longer one blocks', async () => {
    const suffix = `\n\n${author('T')}`;
    const exact = 'x'.repeat(60000 - suffix.length);
    assertReady((await prepare(sarifLog([onLine7(exact)]))).outcome);
    const { outcome } = await prepare(sarifLog([onLine7(`${exact}x`)]));
    assertBlocked(outcome, ['comment-too-large']);
  });

  test('default: a review body over 60000 units blocks', async () => {
    const { outcome } = await prepare(sarifLog([result('x'.repeat(30000)), result('y'.repeat(30000))]));
    assertBlocked(outcome, ['body-too-large']);
  });

  test('default: a payload over 1,000,000 bytes blocks without truncation or splitting', async () => {
    const { outcome } = await prepare(sarifLog(Array.from({ length: 20 }, (_, i) => onLine7(`${i}${'z'.repeat(59000)}`))));
    assertBlocked(outcome, ['payload-too-large']);
  });
});

describe('SARIF structural validation', () => {
  test('an unsupported SARIF version blocks before reading any source', async () => {
    const reader = snapshotReader();
    const sarif = sarifLog([result('x', at('src/app.js', { startLine: 7 }))]);
    sarif.version = '2.0.0';
    const { outcome } = await prepare(sarif, { reader });
    assertBlocked(outcome, ['sarif-schema-invalid']);
    assert.deepStrictEqual(reader.calls, []);
  });

  test('a result without a message is structurally invalid', async () => {
    const { outcome } = await prepare(sarifLog([{ locations: at('src/app.js', { startLine: 7 }) }]));
    assertBlocked(outcome, ['sarif-schema-invalid']);
  });

  test('SARIF must be supplied as an in-memory object, not serialized text', async () => {
    await assert.rejects(prepare(JSON.stringify(sarifLog([result('x')]))), TypeError);
  });
});

describe('product limits', () => {
  test('the default limits are the documented values and cannot be changed at run time', () => {
    // Module doc: defaults of 100 inline comments, 60000 UTF-16 units per
    // body and 1,000,000 bytes of payload. The exported object is frozen, so
    // no caller can loosen them for every later preparation in the process.
    assert.deepStrictEqual({ ...PRODUCT_LIMITS }, { maxComments: 100, maxCommentBodyChars: 60000, maxPayloadBytes: 1000000 });
    assert.equal(Object.isFrozen(PRODUCT_LIMITS), true);
    assert.throws(() => {
      PRODUCT_LIMITS.maxComments = 1000;
    }, TypeError);
    assert.equal(PRODUCT_LIMITS.maxComments, 100);
  });
});
