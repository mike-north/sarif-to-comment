/**
 * User-acceptance tests of diagnostics in the CLI (docs/diagnostics.md,
 * "Output formats"; D45): `--format human|json|toon`, `--color
 * auto|always|never`, `NO_COLOR` and `FORCE_COLOR`, the streams each part of
 * the output goes to, and exit statuses that do not depend on the format.
 *
 * The shipped executable runs as a child process (stdout and stderr are
 * pipes, so not terminals); the GitHub-reading commands run through the
 * wrapper that injects the fake GitHub client. Terminal behavior (automatic
 * color and wrapping to the width) is exercised by calling the CLI's `main`
 * in process with streams that report themselves as terminals.
 *
 * The examples in docs/diagnostics.md are run here and compared byte for
 * byte, so the documentation cannot drift from the output.
 *
 * @see https://toonformat.dev
 * @see https://no-color.org/
 * @see https://nodejs.org/api/cli.html#force_color1-2-3
 * @see https://nodejs.org/api/tty.html#writestreamcolumns
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { decode } from '@toon-format/toon';

import { main } from '../dist/cli.cjs';
import { FakeGitHubRemote } from './fixtures/publication/fake-github.mts';
import { REPOSITORY } from './fixtures/public-api/fake-adapter.mts';
import { DIAGNOSTICS_DOC, assertDiagnostics } from './support/diagnostics.mts';
import { asArray, asRecord, parseJson, readJson } from './support/runtime-types.mts';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'dist', 'sarif-to-comment.cjs');
const WRAPPER = path.join(import.meta.dirname, 'fixtures', 'public-api', 'cli-with-fake-github.mts');
const PUBLIC_API = path.join(import.meta.dirname, 'fixtures', 'public-api');
const TOKEN = 'ghp_CLI_DIAGNOSTICS_token_1122334455';
const ESC = '\u001b';
const FORMATS = ['human', 'json', 'toon'] as const;

/** A document whose only result has no message, as in the documented examples. */
const BROKEN = { version: '2.1.0', runs: [{ tool: { driver: { name: 'demo' } }, results: [{ ruleId: 'x' }] }] };

interface IRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function workDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diagnostics-')));
}

function write(dir: string, name: string, value: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

/** Runs the shipped executable in `cwd` with only PATH and `env` in its environment. */
function run(argv: readonly string[], { cwd = ROOT, env = {} }: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> } = {}): IRun {
  const result = spawnSync(process.execPath, [BIN, ...argv], { cwd, encoding: 'utf8', timeout: 30_000, env: { PATH: process.env['PATH'], ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs the CLI with the fake GitHub client, as the shipped executable would run it. */
function runWithGitHub(remoteDir: string, argv: readonly string[], env: Readonly<Record<string, string>> = {}): IRun {
  const result = spawnSync(process.execPath, [WRAPPER, ...argv], {
    encoding: 'utf8', timeout: 30_000, env: { PATH: process.env['PATH'], FAKE_GITHUB_DIR: remoteDir, GH_TOKEN: TOKEN, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The fenced block after `<!-- diagnostics-example: name -->` in docs/diagnostics.md, with a final newline. */
function documented(name: string): string {
  const match = new RegExp(`<!-- diagnostics-example: ${name} -->\\n\`\`\`\\w+\\n([\\s\\S]*?)\\n\`\`\``).exec(DIAGNOSTICS_DOC);
  assert.ok(match, `docs/diagnostics.md has the ${name} example`);
  return `${match[1] ?? ''}\n`;
}

/** The JSON document a run printed. */
function jsonOf(result: IRun): Record<string, unknown> {
  return asRecord(parseJson(result.stdout), 'the JSON document');
}

// ---------------------------------------------------------------------------

describe('the documented examples are the real output (inspect of a document whose result has no message)', () => {
  const dir = workDir();
  const sarif = write(dir, 'broken.sarif.json', BROKEN);
  const argv = (format: string): string[] => ['inspect', '--sarif', 'broken.sarif.json', '--format', format];

  test('--format json prints the documented document on stdout and nothing on stderr (exit 2)', () => {
    const result = run(argv('json'), { cwd: dir });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, documented('json'));
    assert.equal(result.stderr, '');
    assertDiagnostics(jsonOf(result)['diagnostics'], [{ code: 'sarif-schema-invalid', location: { pointer: '/runs/0/results/0' } }]);
  });

  test('--format toon prints the documented TOON, which decodes to exactly the JSON document (exit 2)', () => {
    const result = run(argv('toon'), { cwd: dir });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, documented('toon'));
    assert.equal(result.stderr, '');
    assert.deepEqual(decode(result.stdout), jsonOf(run(argv('json'), { cwd: dir })));
  });

  test('--format human writes the documented block to stderr and nothing to stdout (exit 2)', () => {
    const result = run(argv('human'), { cwd: dir });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, documented('human'));
    assert.equal(run(['inspect', '--sarif', sarif], { cwd: dir }).stderr, result.stderr, 'human is the default');
  });
});

describe('--format toon carries exactly the JSON document for every kind of outcome', () => {
  const dir = workDir();
  write(dir, 'ready.sarif.json', readJson(path.join(PUBLIC_API, 'ready.sarif.json')));
  write(dir, 'invalid.sarif.json', readJson(path.join(PUBLIC_API, 'invalid.sarif.json')));
  const cases: readonly (readonly [string, readonly string[], number])[] = [
    ['a success (inspect)', ['inspect', '--sarif', 'ready.sarif.json'], 0],
    ['a refusal (add-comment on invalid SARIF)', ['add-comment', '--sarif', 'invalid.sarif.json', '--file', 'a.ts', '--line', '1', '--message', 'M'], 2],
    ['help', ['inspect', '--help'], 0],
    ['a usage error', ['inspect', '--sarif', 'ready.sarif.json', '--bogus'], 1],
    ['an operational error (a missing file)', ['inspect', '--sarif', 'missing.sarif.json'], 1],
    ['an unknown command', ['frobnicate'], 1],
  ];
  for (const [what, argv, status] of cases) {
    test(what, () => {
      const json = run([...argv, '--format', 'json'], { cwd: dir });
      const toon = run([...argv, '--format', 'toon'], { cwd: dir });
      assert.equal(json.status, status);
      assert.equal(toon.status, status, 'the exit status does not depend on the format');
      assert.equal(toon.stderr, '');
      assert.deepEqual(decode(toon.stdout), jsonOf(json));
      assert.equal(toon.stdout.includes(ESC), false);
    });
  }
});

describe('diagnostics in every CLI document', () => {
  const dir = workDir();
  write(dir, 'ready.sarif.json', readJson(path.join(PUBLIC_API, 'ready.sarif.json')));

  test('help and a success carry an empty diagnostics array, appended last', () => {
    for (const argv of [['--help'], ['inspect', '--help'], ['inspect', '--sarif', 'ready.sarif.json'], ['init', '--output', 'new.sarif.json']]) {
      const doc = jsonOf(run([...argv, '--format', 'json'], { cwd: dir }));
      assert.equal(Object.keys(doc).at(-1), 'diagnostics', argv.join(' '));
      assertDiagnostics(doc['diagnostics'], []);
    }
  });

  test('a usage error is usage-error, after the 0.2.x keys', () => {
    const doc = jsonOf(run(['inspect', '--format', 'json'], { cwd: dir }));
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'message', 'usage', 'diagnostics']);
    assert.equal(doc['status'], 'usage-error');
    assertDiagnostics(doc['diagnostics'], [{ code: 'usage-error', subject: 'inspect', message: /missing required option --sarif/ }]);
  });

  fs.writeFileSync(path.join(dir, 'not-json.txt'), 'not json');
  const errors: readonly (readonly [string, readonly string[], string, string, RegExp])[] = [
    ['a missing file', ['inspect', '--sarif', 'missing.sarif.json'], 'file-unreadable', 'missing.sarif.json', /cannot read SARIF file/],
    ['a file that is not JSON', ['inspect', '--sarif', 'not-json.txt'], 'file-not-json', 'not-json.txt', /is not valid JSON/],
    ['an existing output', ['init', '--output', 'ready.sarif.json'], 'output-exists', 'ready.sarif.json', /already exists/],
  ];
  for (const [what, argv, code, file, message] of errors) {
    test(`${what} is ${code}, about the file`, () => {
      const result = run([...argv, '--format', 'json'], { cwd: dir });
      assert.equal(result.status, 1);
      const doc = jsonOf(result);
      assert.equal(doc['status'], 'error');
      assert.equal(Object.keys(doc).at(-1), 'diagnostics');
      assertDiagnostics(doc['diagnostics'], [{ code, subject: path.join(dir, file), message }]);
    });
  }

  test('a missing token is github-token-missing (exit 1)', () => {
    const result = run(['validate', '--sarif', 'ready.sarif.json', '--repo', 'acme/gizmos', '--pull', '7', '--commit', REPOSITORY.commits.head, '--format', 'json'], { cwd: dir });
    assert.equal(result.status, 1);
    assertDiagnostics(jsonOf(result)['diagnostics'], [{ code: 'github-token-missing' }]);
  });
});

describe('human output: the primary result on stdout, diagnostics on stderr', () => {
  const dir = workDir();
  write(dir, 'invalid.sarif.json', readJson(path.join(PUBLIC_API, 'invalid.sarif.json')));

  test('a refused in-place edit: the file note on stdout, the diagnostic block and summary on stderr', () => {
    const result = run(['add-comment', '--sarif', 'invalid.sarif.json', '--file', 'a.ts', '--line', '1', '--message', 'M'], { cwd: dir });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, `${path.join(dir, 'invalid.sarif.json')} was not changed.\n`);
    assert.equal(
      result.stderr,
      [
        '✖ error  The document is not valid SARIF 2.1.0  [sarif-schema-invalid]',
        '  /runs/0',
        "  `/runs/0` must have required property 'tool'.",
        '  → Correct the document so that it conforms to the SARIF 2.1.0 schema.',
        '',
        '1 error',
        '',
      ].join('\n'),
    );
  });

  test('a usage error is a block on stderr, with nothing on stdout (exit 1)', () => {
    const result = run(['inspect'], { cwd: dir });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^✖ error {2}The command line is not valid {2}\[usage-error\]\n {2}inspect\n {2}missing required option --sarif\n/);
    assert.ok(result.stderr.endsWith('\n1 error\n'));
  });

  test('a success without diagnostics writes nothing to stderr', () => {
    const result = run(['init', '--output', 'fresh.sarif.json'], { cwd: dir });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Created /);
    assert.equal(result.stderr, '');
  });

  test('validate: the Markdown report on stdout as before, and each problem as a block on stderr (exit 2)', () => {
    const remote = FakeGitHubRemote.create(path.join(workDir(), 'remote'));
    const held = write(dir, 'held.sarif.json', readJson(path.join(PUBLIC_API, 'held.sarif.json')));
    const argv = ['validate', '--sarif', held, '--repo', 'acme/gizmos', '--pull', '7', '--commit', REPOSITORY.commits.head];
    const result = runWithGitHub(remote.dir, argv);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /^## Review blocked\n/);
    assert.match(result.stderr, /^✖ error {2}The review is held for approval {2}\[approval-hold\]\n {2}\/runs\/0\/results\/0\n/);
    assert.ok(result.stderr.endsWith('\n1 error\n'));
    const json = runWithGitHub(remote.dir, [...argv, '--format', 'json']);
    assert.equal(json.status, 2);
    assert.equal(json.stderr, '');
    assert.equal(jsonOf(json)['message'], result.stdout.replace(/\n$/, ''), 'stdout is the Markdown the JSON message carries');
  });
});

describe('--format and --color values', () => {
  const dir = workDir();
  write(dir, 'invalid.sarif.json', readJson(path.join(PUBLIC_API, 'invalid.sarif.json')));
  const refused = ['inspect', '--sarif', 'invalid.sarif.json'];

  test('an unknown --format is a human usage error naming the three formats', () => {
    const result = run([...refused, '--format', 'yaml'], { cwd: dir });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--format must be human, json or toon, not "yaml"/);
  });

  test('an unknown, missing or repeated --color is a usage error', () => {
    for (const argv of [['--color', 'sometimes'], ['--color'], ['--color', 'always', '--color=never']]) {
      const result = run([...refused, ...argv], { cwd: dir });
      assert.equal(result.status, 1, argv.join(' '));
      assert.match(result.stderr, /--color (must be auto, always or never|requires a value|was given more than once)/);
    }
  });

  test('--color is accepted in both forms and with every format', () => {
    assert.equal(run([...refused, '--color=never'], { cwd: dir }).status, 2);
    for (const format of FORMATS) assert.equal(run([...refused, '--format', format, '--color', 'always'], { cwd: dir }).status, 2, format);
  });

  test('the help lists --format human|json|toon and --color auto|always|never', () => {
    const help = run(['inspect', '--help']).stdout;
    assert.match(help, /--format human\|json\|toon/);
    assert.match(help, /--color auto\|always\|never/);
  });
});

describe('color off a terminal: plain by default, --color always and FORCE_COLOR turn it on, never for JSON or TOON', () => {
  const dir = workDir();
  write(dir, 'invalid.sarif.json', readJson(path.join(PUBLIC_API, 'invalid.sarif.json')));
  const refused = ['inspect', '--sarif', 'invalid.sarif.json'];
  const cases: readonly (readonly [string, readonly string[], Readonly<Record<string, string>>, boolean])[] = [
    ['default (not a terminal)', [], {}, false],
    ['--color auto', ['--color', 'auto'], {}, false],
    ['--color always', ['--color', 'always'], {}, true],
    ['FORCE_COLOR=1', [], { FORCE_COLOR: '1' }, true],
    ['FORCE_COLOR=0 with --color always', ['--color', 'always'], { FORCE_COLOR: '0' }, true],
    ['NO_COLOR with FORCE_COLOR', [], { NO_COLOR: '1', FORCE_COLOR: '1' }, true],
    ['--color never with FORCE_COLOR', ['--color', 'never'], { FORCE_COLOR: '1' }, false],
    ['NO_COLOR', [], { NO_COLOR: '1' }, false],
  ];
  for (const [what, argv, env, colored] of cases) {
    test(`${what}: ${colored ? 'colored' : 'plain'}`, () => {
      const result = run([...refused, ...argv], { cwd: dir, env });
      assert.equal(result.status, 2);
      assert.equal(result.stderr.includes(ESC), colored);
      assert.equal(result.stdout.includes(ESC), false, 'the primary result is never colored');
      assert.equal(result.stderr.replace(/\u001b\[[0-9;]*m/g, ''), run(refused, { cwd: dir }).stderr, 'the same text either way');
    });
  }

  for (const format of ['json', 'toon'] as const) {
    test(`--format ${format} never writes escape sequences, even with --color always and FORCE_COLOR`, () => {
      const result = run([...refused, '--format', format, '--color', 'always'], { cwd: dir, env: { FORCE_COLOR: '3' } });
      assert.equal(result.stdout.includes(ESC), false);
      assert.equal(result.stderr, '');
    });
  }
});

// ---------------------------------------------------------------------------
// On a terminal (in process)

/** A captured output stream that reports itself as a terminal of `columns` columns, or not. */
class Capture {
  text = '';
  readonly isTTY: boolean;
  readonly columns: number | undefined;
  constructor(isTTY: boolean, columns?: number) {
    this.isTTY = isTTY;
    this.columns = columns;
  }
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

async function inProcess(argv: readonly string[], stderr: Capture, env: Readonly<Record<string, string>> = {}, cwd = ROOT): Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }> {
  const stdout = new Capture(stderr.isTTY, stderr.columns);
  const status = await main({ argv, env, stdout, stderr, cwd });
  return { status, stdout: stdout.text, stderr: stderr.text };
}

describe('on a terminal', () => {
  const dir = workDir();
  const sarif = { version: '2.1.0', runs: [{ tool: { driver: { name: 'demo' } }, results: [{ message: { id: 'missing' } }] }] };
  write(dir, 'warned.sarif.json', sarif);
  write(dir, 'invalid.sarif.json', readJson(path.join(PUBLIC_API, 'invalid.sarif.json')));

  test('--color auto colors stderr on a terminal; NO_COLOR, --color never and TERM=dumb do not', async () => {
    const argv = ['inspect', '--sarif', 'invalid.sarif.json'];
    assert.ok((await inProcess(argv, new Capture(true, 100), {}, dir)).stderr.includes(ESC));
    assert.equal((await inProcess(argv, new Capture(true, 100), { NO_COLOR: '1' }, dir)).stderr.includes(ESC), false);
    assert.equal((await inProcess([...argv, '--color', 'never'], new Capture(true, 100), {}, dir)).stderr.includes(ESC), false);
    assert.equal((await inProcess(argv, new Capture(true, 100), { TERM: 'dumb' }, dir)).stderr.includes(ESC), false);
    assert.equal((await inProcess(argv, new Capture(false), {}, dir)).stderr.includes(ESC), false);
  });

  test('messages are wrapped to the terminal width; off a terminal they are not wrapped', async () => {
    const argv = ['add-comment', '--sarif', 'invalid.sarif.json', '--file', 'a.ts', '--line', '1', '--message', 'M', '--color', 'never'];
    const narrow = await inProcess(argv, new Capture(true, 30), {}, dir);
    const remedy = 'Correct the document so that it conforms to the SARIF 2.1.0 schema.';
    for (const line of narrow.stderr.split('\n')) assert.ok(line.length <= 30, `${JSON.stringify(line)} fits 30 columns`);
    assert.equal(narrow.stderr.includes(remedy), false, 'the remedy was wrapped');
    const pipe = await inProcess(argv, new Capture(false), {}, dir);
    assert.ok(pipe.stderr.includes(`  → ${remedy}\n`), 'not wrapped off a terminal');
    assert.equal(narrow.status, pipe.status);
  });

  test('a successful inspection with a warning: the view on stdout without a Warnings section, the warning on stderr', async () => {
    const result = await inProcess(['inspect', '--sarif', 'warned.sarif.json', '--color', 'never'], new Capture(false), {}, dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^SARIF inspection: 1 run\(s\), 1 finding\(s\)/);
    assert.equal(result.stdout.includes('Warnings:'), false);
    assert.match(result.stderr, /^▲ warning {2}A message could not be resolved {2}\[uninterpreted-message\]\n {2}\/runs\/0\/results\/0\/message\n/);
    assert.ok(result.stderr.endsWith('\n1 warning\n'));
    const json = await inProcess(['inspect', '--sarif', 'warned.sarif.json', '--format', 'json'], new Capture(false), {}, dir);
    const doc = asRecord(parseJson(json.stdout));
    assert.equal(asArray(doc['diagnostics']).length, 1);
    assert.equal(json.stderr, '');
  });
});
