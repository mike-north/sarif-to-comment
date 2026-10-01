/**
 * User-acceptance tests for `group-fixes` and `ungroup-fixes`, and for
 * `inspect` showing each finding's group, in human and JSON formats.
 *
 * Every test runs the real executable (dist/sarif-to-comment.cjs) in a child
 * process. Receipts, messages and exit statuses are written by hand from the
 * contract (docs/companion-suggestion-pr-contract.md §2.12, which follows
 * the in-place conventions of docs/finding-removal-contract.md §4). Where the
 * CLI must write exactly what the library returns, the file is compared with
 * the public library's result on the same input: that proves delegation,
 * while the library tests prove the content.
 *
 * Exit statuses: 0 grouped or ungrouped; 2 refused, stale or invalid (the
 * file is unchanged); 1 usage or operational error (the file is unchanged).
 *
 * @see https://github.com/mike-north/sarif-to-comment/issues/29
 * @see docs/companion-suggestion-pr-contract.md
 * @see docs/finding-removal-contract.md
 */

import { AssertionError } from 'node:assert';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import library from '../dist/index.cjs';
import { asArray, asRecord, asString, parseJson, readJson } from './support/runtime-types.mts';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'dist', 'sarif-to-comment.cjs');
const TOOL = 'Review agent';

interface IRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(argv: readonly string[]): IRun {
  const result = spawnSync(process.execPath, [BIN, ...argv], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env['PATH'] } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** stdout must be exactly one JSON document, with nothing on stderr. */
function json(result: IRun): Record<string, unknown> {
  assert.equal(result.stderr, '', `JSON mode wrote to stderr: ${result.stderr}`);
  assert.ok(result.stdout.endsWith('\n'), 'the document ends with a newline');
  return asRecord(parseJson(result.stdout), 'one JSON document');
}

function dig(value: unknown, ...keys: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of keys) current = typeof key === 'number' ? asArray(current)[key] : asRecord(current)[key];
  return current;
}

function tempDir(label: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`)));
}

const bytesOf = (file: string): Buffer => fs.readFileSync(file);
const serialized = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The selectors `inspect --format json` gives the findings at `refs` in `file`. */
function selectorsFor(file: string, ...refs: readonly string[]): string[] {
  const doc = json(run(['inspect', '--sarif', file, '--format', 'json']));
  const findings = asArray(dig(doc, 'view', 'findings'));
  return refs.map((ref) => {
    const found = findings.find((f) => dig(f, 'ref') === ref);
    if (found === undefined) throw new AssertionError({ message: `inspection has no finding ${ref}` });
    return asString(dig(found, 'selector'));
  });
}

const findingFlags = (selectors: readonly string[]): string[] => selectors.flatMap((s) => ['--finding', s]);

const lineFix = (uri: string, line: number, text: string): Record<string, unknown> => ({
  artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion: { startLine: line }, insertedContent: { text } }] }],
});

/**
 * A SARIF file with three authored findings: a code edit (line 2 of
 * src/client.ts), a test file creation, and a finding without a change.
 */
function reviewFile(dir: string, name = 'review.sarif'): string {
  const file = path.join(dir, name);
  const location = (uri: string, line: number): unknown => [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }];
  fs.writeFileSync(file, serialized({
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: TOOL } },
      columnKind: 'utf16CodeUnits',
      artifacts: [{ location: { uri: 'test/client.test.ts' }, contents: { text: 'test\n' } }],
      results: [
        { message: { text: 'Retry once on timeout.' }, locations: location('src/client.ts', 2), fixes: [lineFix('src/client.ts', 2, 'retry')] },
        { message: { text: 'Cover the retry.' }, locations: location('test/client.test.ts', 3),
          properties: { sarifToComment: { proposedFileChanges: [{ operation: 'create', artifactIndex: 0 }] } } },
        { message: { text: 'Just a remark.' }, locations: location('README.md', 1) },
      ],
    }],
  }));
  return file;
}

// ---------------------------------------------------------------------------

describe('help', () => {
  test('top-level help lists both commands with their one-line purpose', () => {
    const result = run(['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('  group-fixes          Group fixes of several findings to be accepted together.\n'), result.stdout);
    assert.ok(result.stdout.includes('  ungroup-fixes        Remove findings from their suggestion groups.\n'), result.stdout);
    assert.ok(result.stdout.includes('  sarif-to-comment group-fixes --sarif FILE --finding SELECTOR [...]\n                   --group NAME [options]\n'), result.stdout);
    assert.ok(result.stdout.includes('  sarif-to-comment ungroup-fixes --sarif FILE --finding SELECTOR [...] [options]\n'), result.stdout);
  });

  for (const [command, flags] of [
    ['group-fixes', ['--sarif FILE', '--finding SELECTOR', '--group NAME', '--output FILE', '--format human|json']],
    ['ungroup-fixes', ['--sarif FILE', '--finding SELECTOR', '--output FILE', '--format human|json']],
  ] as const) {
    test(`${command} --help documents its options`, () => {
      const result = run([command, '--help']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      for (const flag of flags) assert.ok(result.stdout.includes(flag), `${command} help omits ${flag}`);
      assert.match(result.stdout, /inspect/, 'the help says where selectors come from');
    });
  }
});

describe('group-fixes edits the SARIF file in place', () => {
  test('exact JSON receipt; the file is the library document; nothing left behind', () => {
    const dir = tempDir('group');
    const file = reviewFile(dir);
    const before = asRecord(readJson(file));
    const selectors = selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1');
    const result = run(['group-fixes', '--sarif', file, ...findingFlags(selectors), '--group', 'retry-with-test', '--format', 'json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const doc = json(result);
    assert.deepEqual(doc, {
      command: 'group-fixes',
      status: 'grouped',
      sarif: { path: file, written: true },
      group: 'retry-with-test',
      extended: false,
      findings: [
        { ref: '/runs/0/results/0', runIndex: 0, resultIndex: 0, tool: TOOL, changes: 1 },
        { ref: '/runs/0/results/1', runIndex: 0, resultIndex: 1, tool: TOOL, changes: 1 },
      ],
      changes: 2,
      diagnostics: [],
    });
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'sarif', 'group', 'extended', 'findings', 'changes', 'diagnostics']);
    const expected = library.groupSarifFixes(before, { findings: selectors, group: 'retry-with-test' });
    assert.equal(expected.status, 'grouped');
    assert.equal(fs.readFileSync(file, 'utf8'), serialized(dig(expected, 'sarif')), 'the CLI writes what the library returns');
    assert.equal(dig(readJson(file), 'runs', 0, 'results', 0, 'properties', 'sarifToComment', 'suggestionGroup'), 'retry-with-test');
    assert.deepEqual(fs.readdirSync(dir), ['review.sarif'], 'no lock or temporary file remains');
  });

  test('human output names the group, each member and what to do next', () => {
    const dir = tempDir('group-human');
    const file = reviewFile(dir);
    const result = run(['group-fixes', '--sarif', file, ...findingFlags(selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1')), '--group', 'retry-with-test']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, [
      `Grouped 2 findings in ${file} as suggestion group "retry-with-test": 2 distinct changes to accept together.`,
      `  /runs/0/results/0 (tool "${TOOL}"): 1 change`,
      `  /runs/0/results/1 (tool "${TOOL}"): 1 change`,
      'Publishing with --allow-suggestion-prs proposes the group as one suggestion pull request; without it, publication refuses the group.',
      'Selectors from earlier inspections no longer apply; inspect the file again before another edit.',
      '',
    ].join('\n'));
  });

  test('a single --finding extends an existing group; human output says so', () => {
    const dir = tempDir('group-extend');
    const file = reviewFile(dir);
    json(run(['group-fixes', '--sarif', file, ...findingFlags(selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1')), '--group', 'retry-with-test', '--format', 'json']));
    const doc = json(run(['group-fixes', '--sarif', file, ...findingFlags(selectorsFor(file, '/runs/0/results/0')), '--group', 'retry-with-test', '--format', 'json']));
    assert.equal(doc['status'], 'grouped');
    assert.equal(doc['extended'], true);
    const more = asRecord(readJson(file));
    asArray(dig(more, 'runs', 0, 'results')).push({ message: { text: 'And the index.' }, fixes: [lineFix('docs/index.md', 1, '# Index')] });
    fs.writeFileSync(file, serialized(more));
    const human = run(['group-fixes', '--sarif', file, ...findingFlags(selectorsFor(file, '/runs/0/results/3')), '--group', 'retry-with-test']);
    assert.equal(human.status, 0, human.stdout + human.stderr);
    assert.equal(human.stdout.split('\n')[0], `Added 1 finding in ${file} to suggestion group "retry-with-test": 3 distinct changes to accept together.`);
  });

  test('a single --finding for a new group is refused (exit 2), not a usage error', () => {
    const dir = tempDir('group-single');
    const file = reviewFile(dir);
    const before = bytesOf(file);
    const result = run(['group-fixes', '--sarif', file, ...findingFlags(selectorsFor(file, '/runs/0/results/0')), '--group', 'g', '--format', 'json']);
    assert.equal(result.status, 2, result.stdout);
    assert.equal(json(result)['status'], 'refused');
    assert.deepEqual(bytesOf(file), before);
  });

  test('--output writes a new file and leaves the input byte-for-byte unchanged', () => {
    const dir = tempDir('group-output');
    const file = reviewFile(dir);
    const output = path.join(dir, 'grouped.sarif');
    const before = bytesOf(file);
    const selectors = selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1');
    const doc = json(run(['group-fixes', '--sarif', file, ...findingFlags(selectors), '--group', 'g', '--output', output, '--format', 'json']));
    assert.deepEqual(doc, {
      command: 'group-fixes',
      status: 'grouped',
      sarif: { path: file, written: false },
      output: { path: output, written: true },
      group: 'g',
      extended: false,
      findings: [
        { ref: '/runs/0/results/0', runIndex: 0, resultIndex: 0, tool: TOOL, changes: 1 },
        { ref: '/runs/0/results/1', runIndex: 0, resultIndex: 1, tool: TOOL, changes: 1 },
      ],
      changes: 2,
      diagnostics: [],
    });
    assert.deepEqual(bytesOf(file), before);
    assert.equal(fs.readFileSync(output, 'utf8'), serialized(dig(library.groupSarifFixes(asRecord(readJson(file)), { findings: selectors, group: 'g' }), 'sarif')));
    assert.deepEqual(fs.readdirSync(dir).sort(), ['grouped.sarif', 'review.sarif']);

    const human = run(['group-fixes', '--sarif', file, ...findingFlags(selectors), '--group', 'g', '--output', path.join(dir, 'second.sarif')]);
    assert.equal(human.status, 0, human.stderr);
    assert.ok(human.stdout.startsWith(`Grouped 2 findings as suggestion group "g": 2 distinct changes to accept together. Wrote ${path.join(dir, 'second.sarif')}; ${file} was not changed.\n`), human.stdout);
    assert.ok(human.stdout.endsWith(`Inspect ${path.join(dir, 'second.sarif')} for its selectors before editing it.\n`), human.stdout);
  });

  test('--output refuses an existing file (exit 1), and both files are unchanged', () => {
    const dir = tempDir('group-output-exists');
    const file = reviewFile(dir);
    const output = path.join(dir, 'taken.sarif');
    fs.writeFileSync(output, 'already here');
    const before = bytesOf(file);
    const result = run(['group-fixes', '--sarif', file, ...findingFlags(selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1')), '--group', 'g', '--output', output, '--format', 'json']);
    assert.equal(result.status, 1, result.stdout);
    const doc = json(result);
    assert.equal(doc['status'], 'error');
    assert.deepEqual(doc['sarif'], { path: file, written: false });
    assert.deepEqual(doc['output'], { path: output, written: false });
    assert.match(asString(doc['message']), /already exists/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'already here');
    assert.deepEqual(bytesOf(file), before);
  });

  test('refused content exits 2 in both formats; the file is untouched', () => {
    const dir = tempDir('group-refused');
    const file = reviewFile(dir);
    const before = bytesOf(file);
    const selectors = selectorsFor(file, '/runs/0/results/0', '/runs/0/results/2');
    const result = run(['group-fixes', '--sarif', file, ...findingFlags(selectors), '--group', 'g', '--format', 'json']);
    assert.equal(result.status, 2, result.stdout);
    const doc = json(result);
    const expected = library.groupSarifFixes(asRecord(readJson(file)), { findings: selectors, group: 'g' });
    assert.equal(expected.status, 'refused');
    assert.deepEqual(doc, {
      command: 'group-fixes',
      status: 'refused',
      sarif: { path: file, written: false },
      problems: dig(expected, 'problems'),
      diagnostics: dig(expected, 'diagnostics'),
    });
    assert.deepEqual(bytesOf(file), before);

    const human = run(['group-fixes', '--sarif', file, ...findingFlags(selectors), '--group', 'g']);
    assert.equal(human.status, 2);
    // docs/diagnostics.md: what happened to the file on stdout; each problem as a diagnostic on stderr.
    assert.equal(human.stdout, `${file} was not changed.\n`);
    assert.match(human.stderr, /^✖ error {2}A grouped finding proposes no change {2}\[suggestion-group-member-without-change\]\n/);
    assert.ok(human.stderr.endsWith('\n2 errors\n'), human.stderr);
    assert.deepEqual(bytesOf(file), before);
    assert.deepEqual(fs.readdirSync(dir), ['review.sarif']);
  });

  test('a stale selector exits 2; with --output nothing is written', () => {
    const dir = tempDir('group-stale');
    const file = reviewFile(dir);
    const selectors = selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1');
    json(run(['add-comment', '--sarif', file, '--file', 'README.md', '--line', '1', '--message', 'Later.', '--format', 'json']));
    const before = bytesOf(file);
    const output = path.join(dir, 'grouped.sarif');
    const result = run(['group-fixes', '--sarif', file, ...findingFlags(selectors), '--group', 'g', '--output', output, '--format', 'json']);
    assert.equal(result.status, 2, result.stdout);
    const doc = json(result);
    assert.equal(doc['status'], 'stale');
    assert.deepEqual(doc['sarif'], { path: file, written: false });
    assert.deepEqual(doc['output'], { path: output, written: false });
    assert.match(asString(dig(doc, 'problems', 0, 'message')), /Inspect the document again/);
    assert.deepEqual(bytesOf(file), before);
    assert.equal(fs.existsSync(output), false);
  });

  test('schema-invalid SARIF exits 2 with the library problems', () => {
    const dir = tempDir('group-invalid');
    const file = path.join(dir, 'bad.sarif');
    fs.writeFileSync(file, serialized({ version: '2.1.0', runs: [{ results: [] }] }));
    const selectors = ['/runs/0/results/0@0123456789abcdef', '/runs/0/results/1@0123456789abcdef'];
    const doc = json(run(['group-fixes', '--sarif', file, ...findingFlags(selectors), '--group', 'g', '--format', 'json']));
    assert.equal(doc['status'], 'invalid');
    assert.deepEqual(doc['problems'], dig(library.groupSarifFixes({ version: '2.1.0', runs: [{ results: [] }] }, { findings: selectors, group: 'g' }), 'problems'));
  });

  const usage: readonly (readonly [string, (file: string, dir: string) => string[], string])[] = [
    ['no --group', (file) => findingFlags(selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1')), '--group'],
    ['an invalid group name', (file) => [...findingFlags(selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1')), '--group', 'g '], '1-100 characters'],
    ['a bare position', (file) => ['--finding', '/runs/0/results/0', ...findingFlags(selectorsFor(file, '/runs/0/results/1')), '--group', 'g'], 'inspect'],
    ['the same selector twice', (file) => [...findingFlags(selectorsFor(file, '/runs/0/results/0', '/runs/0/results/0')), '--group', 'g'], 'twice'],
    ['--group twice', (file) => [...findingFlags(selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1')), '--group', 'g', '--group', 'h'], 'more than once'],
    ['--output naming the input', (file) => [...findingFlags(selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1')), '--group', 'g', '--output', file], '--output'],
    ['--output in a missing directory', (file, dir) => [...findingFlags(selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1')), '--group', 'g', '--output', path.join(dir, 'missing', 'x.sarif')], 'does not exist'],
    ['an unknown option', (file) => [...findingFlags(selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1')), '--group', 'g', '--label', 'x'], '--label'],
  ];
  for (const [label, args, mention] of usage) {
    test(`usage error (exit 1): ${label}; the file is untouched`, () => {
      const dir = tempDir('group-usage');
      const file = reviewFile(dir);
      const before = bytesOf(file);
      const result = run(['group-fixes', '--sarif', file, ...args(file, dir), '--format', 'json']);
      assert.equal(result.status, 1, result.stdout);
      const doc = json(result);
      assert.equal(doc['status'], 'usage-error');
      assert.ok(asString(doc['message']).includes(mention), asString(doc['message']));
      assert.deepEqual(bytesOf(file), before);
      assert.deepEqual(fs.readdirSync(dir), ['review.sarif']);
    });
  }

  test('another writer\'s ownership marker causes a refusal, never a takeover', () => {
    const dir = tempDir('group-owned');
    const file = reviewFile(dir);
    const selectors = selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1');
    const before = bytesOf(file);
    const marker = path.join(dir, '.review.sarif.sarif-to-comment-lock');
    fs.writeFileSync(marker, 'held by another command');
    const result = run(['group-fixes', '--sarif', file, ...findingFlags(selectors), '--group', 'g', '--format', 'json']);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc['status'], 'error');
    assert.ok(asString(doc['message']).includes(marker));
    assert.deepEqual(bytesOf(file), before);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'held by another command');
  });

  test('a symbolic link is followed: the target is edited and the link survives', () => {
    const dir = tempDir('group-link');
    const target = reviewFile(dir);
    const link = path.join(dir, 'link.sarif');
    fs.symlinkSync(target, link);
    json(run(['group-fixes', '--sarif', link, ...findingFlags(selectorsFor(link, '/runs/0/results/0', '/runs/0/results/1')), '--group', 'g', '--format', 'json']));
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(dig(readJson(target), 'runs', 0, 'results', 1, 'properties', 'sarifToComment', 'suggestionGroup'), 'g');
  });
});

describe('ungroup-fixes', () => {
  function groupedFile(dir: string): string {
    const file = reviewFile(dir);
    json(run(['group-fixes', '--sarif', file, ...findingFlags(selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1')), '--group', 'retry-with-test', '--format', 'json']));
    return file;
  }

  test('in place: exact receipt, and the file returns to its ungrouped content', () => {
    const dir = tempDir('ungroup');
    const original = fs.readFileSync(reviewFile(tempDir('ungroup-original')), 'utf8');
    const file = groupedFile(dir);
    const selectors = selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1');
    const doc = json(run(['ungroup-fixes', '--sarif', file, ...findingFlags(selectors), '--format', 'json']));
    assert.deepEqual(doc, {
      command: 'ungroup-fixes',
      status: 'ungrouped',
      sarif: { path: file, written: true },
      findings: [
        { ref: '/runs/0/results/0', runIndex: 0, resultIndex: 0, tool: TOOL, group: 'retry-with-test' },
        { ref: '/runs/0/results/1', runIndex: 0, resultIndex: 1, tool: TOOL, group: 'retry-with-test' },
      ],
      diagnostics: [],
    });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(dir), ['review.sarif']);
  });

  test('human output, and --output leaves the input unchanged', () => {
    const dir = tempDir('ungroup-human');
    const file = groupedFile(dir);
    const before = bytesOf(file);
    const selectors = selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1');
    const output = path.join(dir, 'ungrouped.sarif');
    const result = run(['ungroup-fixes', '--sarif', file, ...findingFlags(selectors), '--output', output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, [
      `Ungrouped 2 findings. Wrote ${output}; ${file} was not changed.`,
      `  /runs/0/results/0 (tool "${TOOL}"): was in suggestion group "retry-with-test"`,
      `  /runs/0/results/1 (tool "${TOOL}"): was in suggestion group "retry-with-test"`,
      `Inspect ${output} for its selectors before editing it.`,
      '',
    ].join('\n'));
    assert.deepEqual(bytesOf(file), before);
    const inPlace = run(['ungroup-fixes', '--sarif', file, ...findingFlags(selectors)]);
    assert.equal(inPlace.stdout.split('\n')[0], `Ungrouped 2 findings in ${file}.`);
    assert.ok(inPlace.stdout.endsWith('Selectors from earlier inspections no longer apply; inspect the file again before another edit.\n'), inPlace.stdout);
  });

  test('refused: ungrouping a finding in no group exits 2; the file is untouched', () => {
    const dir = tempDir('ungroup-refused');
    const file = reviewFile(dir);
    const before = bytesOf(file);
    const result = run(['ungroup-fixes', '--sarif', file, ...findingFlags(selectorsFor(file, '/runs/0/results/2')), '--format', 'json']);
    assert.equal(result.status, 2, result.stdout);
    assert.equal(json(result)['status'], 'refused');
    assert.deepEqual(bytesOf(file), before);
  });

  test('usage error: no --finding', () => {
    const dir = tempDir('ungroup-usage');
    const file = groupedFile(dir);
    const result = run(['ungroup-fixes', '--sarif', file, '--format', 'json']);
    assert.equal(result.status, 1);
    assert.match(asString(json(result)['message']), /--finding/);
  });
});

describe('inspect shows each finding\'s group', () => {
  test('JSON view and human text', () => {
    const dir = tempDir('group-inspect');
    const file = reviewFile(dir);
    json(run(['group-fixes', '--sarif', file, ...findingFlags(selectorsFor(file, '/runs/0/results/0', '/runs/0/results/1')), '--group', 'retry-with-test', '--format', 'json']));
    const doc = json(run(['inspect', '--sarif', file, '--format', 'json']));
    assert.deepEqual(asArray(dig(doc, 'view', 'findings')).map((f) => dig(f, 'suggestionGroup')), ['retry-with-test', 'retry-with-test', undefined]);
    const human = run(['inspect', '--sarif', file]);
    assert.equal(human.status, 0, human.stderr);
    assert.ok(human.stdout.includes(`Finding /runs/0/results/0 — ${TOOL} · suggestionGroup: retry-with-test\n`), human.stdout);
    assert.ok(human.stdout.includes(`Finding /runs/0/results/2 — ${TOOL}\n`), human.stdout);
  });
});
