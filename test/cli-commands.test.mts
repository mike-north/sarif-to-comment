/**
 * User-acceptance tests for the command CLI: `init`, `add-comment`,
 * `inspect`, `add-staged-changes`, `validate` and `publish`, in human and
 * JSON formats.
 *
 * Every test runs the real executable (dist/sarif-to-comment.cjs) in a child
 * process. Publication tests run it through the existing wrapper that replaces
 * only the GitHub adapter (test/fixtures/public-api/cli-with-fake-github.mts).
 * Staged-change tests use a real local Git repository built from the parent's
 * independent source oracle (test/fixtures/authoring-workflow/git-world.mts),
 * whose index and working tree deliberately differ.
 *
 * Expected values come from the accepted contract
 * (docs/second-milestone-contract-proposal.md, cited as "§n") and the oracle,
 * not from program output. Where the contract requires the CLI to carry the
 * library's result unchanged (inspection views, extraction receipts, SARIF
 * written by add-comment), the CLI is compared with the public library entry
 * point on the same input: that comparison proves delegation, while the
 * independent assertions prove the content.
 *
 * Exit statuses (§5): 0 success, 1 usage or operational error, 2 content
 * refusal (`invalid` / `failed`); `publish` keeps 0/1/2/3. `validate`
 * follows docs/readiness-assessment-contract.md: 0 ready, 2 blocked, 1
 * incomplete or error.
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 * @see https://www.rfc-editor.org/rfc/rfc6901 (JSON Pointer, used for finding refs)
 * @see https://git-scm.com/docs/git-update-index (index versus working tree)
 */

import * as assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import library from '../dist/index.cjs';
import { FakeGitHubRemote } from './fixtures/publication/fake-github.mts';
import type { IFakeRemoteConfig } from './fixtures/publication/fake-github.mts';
import { REPOSITORY, createFakeClientFactory, setAdapterConfig } from './fixtures/public-api/fake-adapter.mts';
import {
  ORACLE,
  UPSTREAM_SARIF_PATH,
  SENTINEL,
  createGitWorld,
  applyReplacements,
  replacementsFor,
  distinctReplacements,
} from './fixtures/authoring-workflow/git-world.mts';
import type { IGitWorld } from './fixtures/authoring-workflow/git-world.mts';
import {
  asArray,
  asRecord,
  asString,
  expectType,
  isShape,
  isString,
  isUnknown,
  readJson,
} from './support/runtime-types.mts';
import type { Guard } from './support/runtime-types.mts';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'dist', 'sarif-to-comment.cjs');
const WRAPPER = path.join(ROOT, 'test', 'fixtures', 'public-api', 'cli-with-fake-github.mts');
const PKG = expectType(readJson(path.join(ROOT, 'package.json')), isShape({ version: isString }), 'package.json with a version');
const SCHEMA_URI = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';
const COMMIT = 'c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de';
const TOKEN = 'ghp_COMMANDS_SENTINEL_token_value_2468013579';
const UPSTREAM = asRecord(readJson(UPSTREAM_SARIF_PATH), 'the upstream SARIF document');
const READY = asRecord(readJson(path.join(ROOT, 'test', 'fixtures', 'public-api', 'ready.sarif.json')), 'ready.sarif.json');
const INVALID_PUBLICATION = asRecord(
  readJson(path.join(ROOT, 'test', 'fixtures', 'public-api', 'invalid.sarif.json')),
  'invalid.sarif.json',
);
/** Valid JSON but not schema-valid SARIF: a run must have a tool (SARIF §3.14.6). */
const NOT_SARIF = { version: '2.1.0', runs: [{ results: [] }] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A finished child process of the executable. */
interface IRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** How run() starts the executable. */
interface IRunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

/**
 * A JSON-mode document: the envelope and the fields commands add. Each field
 * is narrowed where a test reads it.
 */
const isCliDocument = isShape({
  command: isUnknown,
  status: isUnknown,
  message: isUnknown,
  usage: isUnknown,
  output: isUnknown,
  archived: isUnknown,
  receipt: isUnknown,
  view: isUnknown,
  problems: isUnknown,
  finding: isUnknown,
  sarif: isUnknown,
  review: isUnknown,
  statePath: isUnknown,
  diagnostics: isUnknown,
});

type CliDocument = typeof isCliDocument extends Guard<infer T> ? T : never;

/**
 * Reads a nested value of a JSON document by object keys and array indexes;
 * a missing container fails with an AssertionError naming where.
 */
function at(value: unknown, ...keys: readonly (string | number)[]): unknown {
  let current = value;
  for (const [depth, key] of keys.entries()) {
    const where = `a container at /${keys.slice(0, depth).join('/')}`;
    current = typeof key === 'number' ? asArray(current, where)[key] : asRecord(current, where)[key];
  }
  return current;
}

/** The element at `index`, failing with an AssertionError when there is none. */
function item<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new AssertionError({ message: `expected an element at index ${String(index)} of ${String(items.length)}` });
  return value;
}

function tempDir(label = 'commands'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`)));
}

/** Runs the real executable with only PATH (plus `env`) — never the developer's credentials. */
function run(argv: readonly string[], { cwd = ROOT, env = {}, input }: IRunOptions = {}): IRun {
  const result = spawnSync(process.execPath, [BIN, ...argv], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env['PATH'], ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** stdout must be exactly one JSON document, with nothing on stderr (§6.2). */
function json(result: IRun): CliDocument {
  assert.equal(result.stderr, '', `JSON mode wrote to stderr: ${result.stderr}`);
  assert.ok(result.stdout.endsWith('\n'), 'the document ends with a newline');
  let doc: unknown;
  assert.doesNotThrow(() => {
    doc = JSON.parse(result.stdout);
  }, `stdout is not one JSON document: ${result.stdout}`);
  assert.equal(typeof doc, 'object');
  return expectType(doc, isCliDocument, 'a JSON document object');
}

const bytesOf = (file: string): Buffer => fs.readFileSync(file);
const writeJson = (file: string, value: unknown): void => {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** A new SARIF file created through `init` (JSON mode), bound or not. */
function initFile(dir: string, name = 'review.sarif', extra: readonly string[] = []): string {
  const output = path.join(dir, name);
  const result = run(['init', '--output', output, '--format', 'json', ...extra]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return output;
}

/** The archive name §6.4 requires for a file, from its birth time (or modification time). */
function expectedArchiveStamp(file: string): { stamp: string; timeSource: string } {
  const stat = fs.statSync(file);
  const birth = stat.birthtimeMs > 0;
  const stamp = new Date(birth ? stat.birthtimeMs : stat.mtimeMs).toISOString().replace(/:/g, '-');
  return { stamp, timeSource: birth ? 'birth' : 'modified' };
}

/** Files in `dir` other than those listed. */
function othersIn(dir: string, known: readonly string[]): string[] {
  return fs.readdirSync(dir).filter((name) => !known.includes(name));
}

// ---------------------------------------------------------------------------
// Dispatch, help and format resolution (§6.1, §6.2)
// ---------------------------------------------------------------------------

describe('command dispatch and help', () => {
  test('top-level help lists every command and keeps the flag-only publisher documented', () => {
    const result = run(['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    for (const command of ['init', 'add-comment', 'remove-comment', 'inspect', 'add-staged-changes', 'validate', 'publish', 'close-suggestion-prs']) {
      assert.match(result.stdout, new RegExp(`\\b${command}\\b`), `help omits ${command}`);
    }
    assert.match(result.stdout, /--format human\|json/);
    assert.match(result.stdout, /--sarif FILE --repo OWNER\/REPO --pull N --commit FULLSHA/);
  });

  const commands: readonly (readonly [string, readonly string[]])[] = [
    ['init', ['--output', '--tool-name', '--tool-version', '--repo', '--commit', '--format']],
    [
      'add-comment',
      ['--sarif', '--file', '--line', '--end-line', '--message', '--message-file', '--markdown', '--rule-id', '--level', '--run', '--new-run-tool', '--new-run-tool-version', '--repo', '--commit', '--format'],
    ],
    ['remove-comment', ['--sarif', '--finding', '--format']],
    ['inspect', ['--sarif', '--preview-lines', '--preview-chars', '--source-root', '--format']],
    ['add-staged-changes', ['--sarif', '--output', '--worktree', '--repo', '--commit', '--source-root', '--format']],
    ['validate', ['--sarif', '--repo', '--pull', '--commit', '--source-root', '--old-source-commit', '--ignore-approval-hold', '--submit', '--allow-suggestion-prs', '--pr-labels', '--mark-suggestion-prs-ready', '--format']],
    ['publish', ['--sarif', '--repo', '--pull', '--commit', '--state', '--source-root', '--old-source-commit', '--ignore-approval-hold', '--submit', '--allow-suggestion-prs', '--pr-labels', '--mark-suggestion-prs-ready', '--format']],
    ['close-suggestion-prs', ['--repo', '--label', '--original', '--owner', '--max-candidates', '--force', '--dry-run', '--format']],
  ];
  for (const [command, flags] of commands) {
    test(`${command} --help documents its options and needs no token`, () => {
      const result = run([command, '--help']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      for (const flag of flags) assert.ok(result.stdout.includes(flag), `${command} help omits ${flag}`);
    });
  }

  test('remove-comment help states exactly what removal removes', () => {
    // The selected help sentence (docs/second-milestone-interface-design.md, removal semantics).
    const result = run(['remove-comment', '--help']);
    assert.ok(result.stdout.includes('Remove a finding and its attached fixes from the SARIF document.'), result.stdout);
    assert.match(result.stdout, /inspect/, 'the help says where selectors come from');
  });

  test('the staged command says what it does and does not do', () => {
    const result = run(['add-staged-changes', '--help']);
    assert.match(result.stdout, /Add proposed changes from the Git index to a SARIF document\./);
  });

  test('help in JSON mode is one document carrying the usage text', () => {
    const doc = json(run(['inspect', '--help', '--format', 'json']));
    assert.equal(doc.command, 'inspect');
    assert.equal(doc.status, 'help');
    assert.match(asString(doc.usage), /--preview-lines/);
  });

  test('an unknown command is a usage error in either format', () => {
    const human = run(['frobnicate']);
    assert.equal(human.status, 1);
    assert.equal(human.stdout, '');
    assert.match(human.stderr, /unknown command frobnicate/);
    assert.match(human.stderr, /--help/);

    const machine = run(['frobnicate', '--format', 'json']);
    assert.equal(machine.status, 1);
    const doc = json(machine);
    assert.deepEqual(Object.keys(doc).sort(), ['command', 'diagnostics', 'message', 'status', 'usage']);
    assert.equal(doc.command, null);
    assert.equal(doc.status, 'usage-error');
    assert.match(asString(doc.message), /unknown command frobnicate/);
  });

  test('a JSON usage error for a known command names the command and its usage', () => {
    const doc = json(run(['init', '--format', 'json']));
    assert.equal(doc.command, 'init');
    assert.equal(doc.status, 'usage-error');
    assert.match(asString(doc.message), /--output/);
    assert.match(asString(doc.usage), /init --output FILE/);
  });
});

describe('help layout (#43)', () => {
  /** The width help text is wrapped to: the width of its option and prose columns. */
  const HELP_WIDTH = 80;
  const topics: readonly (readonly string[])[] = [
    [], ['init'], ['add-comment'], ['remove-comment'], ['group-fixes'], ['ungroup-fixes'], ['inspect'], ['add-staged-changes'],
    ['validate'], ['publish'], ['close-suggestion-prs'],
  ];
  const firstWord = (line: string): string => line.trimStart().split(' ')[0] ?? '';
  for (const topic of topics) {
    const name = ['sarif-to-comment', ...topic, '--help'].join(' ');
    test(`regression (#43): ${name} is wrapped to ${String(HELP_WIDTH)} columns, with filled prose and a lowercase title`, () => {
      const result = run([...topic, '--help']);
      assert.equal(result.status, 0, result.stderr);
      const lines = result.stdout.split('\n');
      for (const line of lines) assert.ok(line.length <= HELP_WIDTH, `${String(line.length)} columns: ${JSON.stringify(line)}`);

      // The title names the command and says what it does in lowercase, as a
      // phrase rather than a sentence.
      const title = lines[0] ?? '';
      assert.match(title, new RegExp(`^${['sarif-to-comment', ...topic].join(' ')} — [a-z]`), title);
      assert.equal(title.endsWith('.'), false, title);

      // A paragraph of prose (unindented lines, or the continuation lines of
      // an option's description) is filled: no line ends where the next
      // line's first word would still have fit. Synopses (the Usage: block)
      // are laid out by option group instead.
      let synopsis = false;
      for (let i = 1; i + 1 < lines.length; i += 1) {
        const line = lines[i] ?? '';
        const next = lines[i + 1] ?? '';
        if (line === 'Usage:') synopsis = true;
        else if (line === '') synopsis = false;
        const prose = !line.startsWith(' ') && !next.startsWith(' ') && !line.endsWith(':');
        const continuation = /^ {33}\S/.test(next) && /^ {2}\S.{29} \S|^ {33}\S/.test(line);
        if (synopsis || line === '' || next === '' || !(prose || continuation)) continue;
        assert.ok(line.length + 1 + firstWord(next).length > HELP_WIDTH, `"${firstWord(next)}" fits after ${JSON.stringify(line)}`);
      }
    });
  }
});

describe('--version (#43)', () => {
  // The version is the package's own, read from package.json when the
  // command runs; every expectation compares with package.json itself.
  test('prints the version from package.json and nothing else, needing no token', () => {
    const result = run(['--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${PKG.version}\n`);
    assert.equal(result.stderr, '');
  });

  test('in JSON it is one document with the version, and TOON carries the same', () => {
    const result = run(['--version', '--format', 'json']);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    const doc = asRecord(JSON.parse(result.stdout), 'the version document');
    assert.deepEqual(doc, { command: null, status: 'version', version: PKG.version, diagnostics: [] });
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'version', 'diagnostics']);
    const toon = run(['--format', 'toon', '--version']);
    assert.equal(toon.status, 0);
    assert.equal(toon.stdout, `command: null\nstatus: version\nversion: ${PKG.version}\ndiagnostics: []\n`);
  });

  test('after a command it is still the package version, and the command is not run', () => {
    const dir = tempDir('version');
    const output = path.join(dir, 'never.sarif');
    const result = run(['init', '--output', output, '--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${PKG.version}\n`);
    assert.equal(fs.existsSync(output), false, 'init did not run');
    assert.equal(asRecord(JSON.parse(run(['inspect', '--version', '--format', 'json']).stdout))['command'], 'inspect');
  });

  test('it is read when the command runs: the same executable beside another package.json reports that version', () => {
    const copy = tempDir('version-copy');
    fs.cpSync(path.join(ROOT, 'dist'), path.join(copy, 'dist'), { recursive: true });
    for (const dir of ['node_modules', 'vendor']) fs.symlinkSync(path.join(ROOT, dir), path.join(copy, dir), 'dir');
    writeJson(path.join(copy, 'package.json'), { name: 'sarif-to-comment', version: '9.8.7-copy.1', type: 'commonjs' });
    const result = spawnSync(process.execPath, [path.join(copy, 'dist', 'sarif-to-comment.cjs'), '--version'], {
      encoding: 'utf8', timeout: 60_000, env: { PATH: process.env['PATH'] },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '9.8.7-copy.1\n');
  });

  test('the top-level help documents it', () => {
    const help = run(['--help']).stdout;
    assert.ok(help.includes('  sarif-to-comment --version\n'), help);
    assert.match(help, /^ {2}--version {2,}Show the package version\./m);
  });
});

describe('JSON documents: the envelope comes first and field order is stable', () => {
  // Module doc (src/cli.cts): "The envelope is { command, status, ... }".
  // The remaining order of each document is the contract's listing where it
  // gives one (§3.1, §3.2, §3.5) and otherwise characterization of 0.2.0;
  // JSON output is read by people and diffed by scripts, so it must not
  // drift with a change of implementation language.
  test('help, unknown-command and usage-error documents', () => {
    assert.deepEqual(Object.keys(json(run(['inspect', '--help', '--format', 'json']))), ['command', 'status', 'usage', 'diagnostics']);
    assert.deepEqual(Object.keys(json(run(['frobnicate', '--format', 'json']))), ['command', 'status', 'message', 'usage', 'diagnostics']);
    assert.deepEqual(Object.keys(json(run(['init', '--format', 'json']))), ['command', 'status', 'message', 'usage', 'diagnostics']);
  });

  test('init prints exactly the two-space indented receipt and writes the document in contract order', () => {
    const dir = tempDir('init-bytes');
    const output = path.join(dir, 'review.sarif');
    const result = run(['init', '--output', output, '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      `{\n  "command": "init",\n  "status": "created",\n  "output": {\n    "path": ${JSON.stringify(output)},\n    "written": true\n  },\n  "runIndex": 0,\n  "diagnostics": []\n}\n`,
    );
    // §3.1 document shape, in its order, as two-space JSON with a final newline.
    const expected = [
      '{',
      `  "$schema": "${SCHEMA_URI}",`,
      '  "version": "2.1.0",',
      '  "runs": [',
      '    {',
      '      "tool": {',
      '        "driver": {',
      '          "name": "sarif-to-comment",',
      `          "version": "${PKG.version}"`,
      '        }',
      '      },',
      '      "columnKind": "utf16CodeUnits",',
      '      "results": []',
      '    }',
      '  ]',
      '}',
      '',
    ].join('\n');
    assert.equal(fs.readFileSync(output, 'utf8'), expected);
  });
});

describe('--format is resolved first and fails as a human usage error', () => {
  const dir = tempDir('format');
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['an unsupported value', ['init', '--output', path.join(dir, 'a.sarif'), '--format', 'xml']],
    ['a missing value', ['init', '--output', path.join(dir, 'b.sarif'), '--format']],
    ['a repeated option', ['init', '--output', path.join(dir, 'c.sarif'), '--format', 'json', '--format=json']],
    ['an empty value', ['init', '--output', path.join(dir, 'd.sarif'), '--format=']],
    ['an unsupported value on the flag-only route', ['--format', 'yaml', '--sarif', 'x']],
    ['an unsupported value for an unknown command', ['frobnicate', '--format', 'xml']],
  ];
  for (const [label, argv] of cases) {
    test(label, () => {
      const result = run(argv);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '', 'nothing on stdout');
      assert.match(result.stderr, /--format/);
      assert.deepEqual(fs.readdirSync(dir), [], 'nothing was written');
    });
  }

  test('--format=json and --format json are equivalent', () => {
    const out = tempDir('format-eq');
    const a = json(run(['init', `--output=${path.join(out, 'a.sarif')}`, '--format=json']));
    const b = json(run(['init', '--output', path.join(out, 'b.sarif'), '--format', 'json']));
    assert.equal(a.status, 'created');
    assert.equal(b.status, 'created');
  });

  test('the default is human regardless of terminal', () => {
    const out = tempDir('format-default');
    const result = run(['init', '--output', path.join(out, 'a.sarif')]);
    assert.equal(result.status, 0, result.stderr);
    assert.throws(() => JSON.parse(result.stdout), 'human output is not JSON');
    assert.ok(result.stdout.includes(path.join(out, 'a.sarif')));
  });
});

// ---------------------------------------------------------------------------
// init (§3.1)
// ---------------------------------------------------------------------------

describe('init', () => {
  test('creates exactly the contract document attributed to this package', () => {
    const dir = tempDir('init');
    const output = path.join(dir, 'review.sarif');
    const doc = json(run(['init', '--output', output, '--format', 'json']));
    assert.deepEqual(doc, { command: 'init', status: 'created', output: { path: output, written: true }, runIndex: 0, diagnostics: [] });
    assert.deepEqual(readJson(output), {
      $schema: SCHEMA_URI,
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'sarif-to-comment', version: PKG.version } },
          columnKind: 'utf16CodeUnits',
          results: [],
        },
      ],
    });
    assert.deepEqual(readJson(output), library.createSarifDocument(), 'the CLI writes the library document');
  });

  test('a caller tool and a source binding; no package version is attributed to another author', () => {
    const dir = tempDir('init-bound');
    const output = path.join(dir, 'review.sarif');
    const doc = json(
      run(['init', '--output', output, '--tool-name', 'Review agent', '--repo', 'acme/widgets', '--commit', COMMIT, '--format', 'json']),
    );
    assert.deepEqual(doc, {
      command: 'init',
      status: 'created',
      output: { path: output, written: true },
      runIndex: 0,
      source: { repositoryUri: 'https://github.com/acme/widgets', commit: COMMIT },
      diagnostics: [],
    });
    assert.deepEqual(readJson(output), {
      $schema: SCHEMA_URI,
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'Review agent' } },
          columnKind: 'utf16CodeUnits',
          versionControlProvenance: [{ repositoryUri: 'https://github.com/acme/widgets', revisionId: COMMIT }],
          results: [],
        },
      ],
    });
  });

  test('a caller tool version is written with the caller tool name', () => {
    const dir = tempDir('init-version');
    const output = path.join(dir, 'review.sarif');
    json(run(['init', '--output', output, '--tool-name', 'Review agent', '--tool-version', '3.1.4', '--format', 'json']));
    assert.deepEqual(at(readJson(output), 'runs', 0, 'tool'), { driver: { name: 'Review agent', version: '3.1.4' } });
  });

  test('human output names the created file and the binding', () => {
    const dir = tempDir('init-human');
    const output = path.join(dir, 'review.sarif');
    const result = run(['init', '--output', output, '--repo', 'acme/widgets', '--commit', COMMIT]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.includes(output));
    assert.ok(result.stdout.includes(COMMIT));
  });

  test('a relative --output is resolved against the working directory', () => {
    const dir = tempDir('init-relative');
    const doc = json(run(['init', '--output', 'relative.sarif', '--format', 'json'], { cwd: dir }));
    assert.equal(at(doc.output, 'path'), path.join(dir, 'relative.sarif'));
    assert.ok(fs.existsSync(path.join(dir, 'relative.sarif')));
  });

  test('an existing output is refused and left byte-identical', () => {
    const dir = tempDir('init-exists');
    const output = path.join(dir, 'review.sarif');
    fs.writeFileSync(output, 'precious');
    const human = run(['init', '--output', output]);
    assert.equal(human.status, 1);
    assert.equal(human.stdout, '');
    assert.ok(human.stderr.includes(output));
    const doc = json(run(['init', '--output', output, '--format', 'json']));
    assert.equal(doc.status, 'error');
    assert.equal(doc.command, 'init');
    assert.ok(asString(doc.message).includes(output));
    assert.deepEqual(doc.output, { path: output, written: false });
    assert.equal(fs.readFileSync(output, 'utf8'), 'precious');
    assert.deepEqual(fs.readdirSync(dir), ['review.sarif'], 'no temporary file is left behind');
  });

  const usageCases: readonly (readonly [string, readonly string[], string])[] = [
    ['--repo without --commit', ['--repo', 'acme/widgets'], '--commit'],
    ['--commit without --repo', ['--commit', COMMIT], '--repo'],
    ['an abbreviated commit', ['--repo', 'acme/widgets', '--commit', 'c0dec0d'], '--commit'],
    ['a malformed repository', ['--repo', 'acme', '--commit', COMMIT], '--repo'],
    ['--tool-version without --tool-name', ['--tool-version', '1.0.0'], '--tool-name'],
    ['an unknown option', ['--frobnicate', 'x'], '--frobnicate'],
    ['a positional argument', ['stray'], 'stray'],
  ];
  for (const [label, extra, mention] of usageCases) {
    test(`usage error: ${label}`, () => {
      const dir = tempDir('init-usage');
      const output = path.join(dir, 'review.sarif');
      const doc = json(run(['init', '--output', output, ...extra, '--format', 'json']));
      assert.equal(doc.status, 'usage-error');
      assert.ok(asString(doc.message).includes(mention), asString(doc.message));
      assert.deepEqual(fs.readdirSync(dir), []);
      const human = run(['init', '--output', output, ...extra]);
      assert.equal(human.status, 1);
      assert.equal(human.stdout, '');
      assert.ok(human.stderr.includes(mention), human.stderr);
    });
  }
});

// ---------------------------------------------------------------------------
// add-comment (§3.2)
// ---------------------------------------------------------------------------

describe('add-comment edits the SARIF file in place', () => {
  test('a single-line comment: exact appended result, receipt and library equivalence', () => {
    const dir = tempDir('comment');
    const file = initFile(dir, 'review.sarif', ['--tool-name', 'Review agent']);
    const before = asRecord(readJson(file));
    const doc = json(
      run(['add-comment', '--sarif', file, '--file', 'src/parse.js', '--line', '2', '--message', 'Handle the empty-input case.', '--format', 'json']),
    );
    assert.deepEqual(doc, {
      command: 'add-comment',
      status: 'added',
      sarif: { path: file, written: true },
      finding: { ref: '/runs/0/results/0', path: 'src/parse.js', line: 2, endLine: 2, tool: 'Review agent' },
      diagnostics: [],
    });
    const after = readJson(file);
    assert.deepEqual(at(after, 'runs', 0, 'results'), [
      {
        message: { text: 'Handle the empty-input case.' },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'src/parse.js' }, region: { startLine: 2 } } }],
      },
    ]);
    const expected = library.addSarifComment(before, { file: 'src/parse.js', line: 2, message: 'Handle the empty-input case.' });
    assert.equal(expected.status, 'added');
    assert.deepEqual(after, expected.sarif, 'the CLI writes what the library returns');
    assert.deepEqual(fs.readdirSync(dir), ['review.sarif'], 'no lock or temporary file remains');
  });

  test('the JSON receipt keeps contract order and the file is the library document, byte for byte', () => {
    const dir = tempDir('comment-order');
    const file = initFile(dir, 'review.sarif', ['--tool-name', 'Review agent']);
    const before = asRecord(readJson(file));
    const comment = { file: 'src/parse.js', line: 2, endLine: 3, message: 'Guard it.', ruleId: 'R1', level: 'warning' } as const;
    const doc = json(run([
      'add-comment', '--sarif', file, '--file', comment.file, '--line', '2', '--end-line', '3', '--message', comment.message,
      '--rule-id', comment.ruleId, '--level', comment.level, '--format', 'json',
    ]));
    assert.equal(doc.status, 'added', JSON.stringify(doc));
    // §3.2: { command, status: "added", sarif: { path, written: true }, finding: { ref, path, line, endLine, tool } }
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'sarif', 'finding', 'diagnostics']);
    assert.deepEqual(Object.keys(asRecord(doc.sarif)), ['path', 'written']);
    assert.deepEqual(Object.keys(asRecord(doc.finding)), ['ref', 'path', 'line', 'endLine', 'tool']);
    const expected = library.addSarifComment(before, comment);
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(at(expected, 'sarif'), null, 2)}\n`);
  });

  test('a Markdown range comment with rule and level', () => {
    const dir = tempDir('comment-range');
    const file = initFile(dir);
    const doc = json(
      run([
        'add-comment', '--sarif', file, '--file', 'fixture/review.txt', '--line', '5', '--end-line', '6',
        '--message', 'Combine **these** entries.', '--markdown', '--rule-id', 'COMBINE', '--level', 'warning', '--format', 'json',
      ]),
    );
    assert.deepEqual(doc.finding, { ref: '/runs/0/results/0', path: 'fixture/review.txt', line: 5, endLine: 6, tool: 'sarif-to-comment' });
    assert.deepEqual(at(readJson(file), 'runs', 0, 'results', 0), {
      ruleId: 'COMBINE',
      level: 'warning',
      message: { text: 'Combine **these** entries.', markdown: 'Combine **these** entries.' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'fixture/review.txt' }, region: { startLine: 5, endLine: 6 } } }],
    });
  });

  test('messages from a file and from standard input keep the caller text exactly', () => {
    const dir = tempDir('comment-file');
    const file = initFile(dir);
    const text = 'First line — with “quotes”.\n\nSecond paragraph.\n';
    const messageFile = path.join(dir, 'message.md');
    fs.writeFileSync(messageFile, text);
    json(run(['add-comment', '--sarif', file, '--file', 'a.txt', '--line', '1', '--message-file', messageFile, '--format', 'json']));
    json(run(['add-comment', '--sarif', file, '--file', 'a.txt', '--line', '2', '--message-file', '-', '--format', 'json'], { input: text }));
    const results = at(readJson(file), 'runs', 0, 'results');
    assert.equal(at(results, 0, 'message', 'text'), text);
    assert.equal(at(results, 1, 'message', 'text'), text);
  });

  test('a message file that is not UTF-8 is refused and the SARIF is untouched', () => {
    const dir = tempDir('comment-bad-utf8');
    const file = initFile(dir);
    const before = bytesOf(file);
    const messageFile = path.join(dir, 'message.txt');
    fs.writeFileSync(messageFile, Buffer.from([0x66, 0xff, 0x6f]));
    const result = run(['add-comment', '--sarif', file, '--file', 'a.txt', '--line', '1', '--message-file', messageFile, '--format', 'json']);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.status, 'error');
    assert.match(asString(doc.message), /UTF-8/);
    assert.deepEqual(bytesOf(file), before);
  });

  test('--new-run-tool adds the caller feedback to upstream SARIF without crediting the upstream tool', () => {
    const dir = tempDir('comment-upstream');
    const file = path.join(dir, 'upstream.sarif');
    fs.copyFileSync(UPSTREAM_SARIF_PATH, file);
    const doc = json(
      run([
        'add-comment', '--sarif', file, '--file', 'fixture/review.txt', '--line', '9', '--message', 'Reviewer note.',
        '--new-run-tool', 'Reviewer', '--new-run-tool-version', '2.0.0', '--format', 'json',
      ]),
    );
    assert.deepEqual(doc.finding, { ref: '/runs/1/results/0', path: 'fixture/review.txt', line: 9, endLine: 9, tool: 'Reviewer' });
    const after = readJson(file);
    assert.deepEqual(at(after, 'runs', 0), at(UPSTREAM, 'runs', 0), 'the upstream run is unchanged');
    assert.deepEqual(at(after, 'properties'), UPSTREAM['properties']);
    assert.deepEqual(at(after, 'runs', 1, 'tool'), { driver: { name: 'Reviewer', version: '2.0.0' } });
    assert.equal(at(after, 'runs', 1, 'results', 0, 'message', 'text'), 'Reviewer note.');
  });

  test('several runs without a selection is a usage error; the file is untouched', () => {
    const dir = tempDir('comment-ambiguous');
    const file = path.join(dir, 'two-runs.sarif');
    const twoRuns = library.createSarifDocument();
    twoRuns.runs.push(structuredClone(item(twoRuns.runs, 0)));
    writeJson(file, twoRuns);
    const before = bytesOf(file);
    const result = run(['add-comment', '--sarif', file, '--file', 'a.txt', '--line', '1', '--message', 'x', '--format', 'json']);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.status, 'usage-error');
    assert.match(asString(doc.message), /run/);
    assert.deepEqual(bytesOf(file), before);

    const chosen = json(run(['add-comment', '--sarif', file, '--file', 'a.txt', '--line', '1', '--message', 'x', '--run', '1', '--format', 'json']));
    assert.equal(at(chosen.finding, 'ref'), '/runs/1/results/0');
  });

  test('schema-invalid SARIF: exit 2, problems, nothing written', () => {
    const dir = tempDir('comment-invalid');
    const file = path.join(dir, 'bad.sarif');
    writeJson(file, NOT_SARIF);
    const before = bytesOf(file);
    const result = run(['add-comment', '--sarif', file, '--file', 'a.txt', '--line', '1', '--message', 'x', '--format', 'json']);
    assert.equal(result.status, 2);
    const doc = json(result);
    assert.equal(doc.command, 'add-comment');
    assert.equal(doc.status, 'invalid');
    assert.deepEqual(doc.sarif, { path: file, written: false });
    assert.ok(Array.isArray(doc.problems) && doc.problems.length > 0);
    for (const problem of asArray(doc.problems)) assert.equal(typeof at(problem, 'message'), 'string');
    const expected = library.addSarifComment(NOT_SARIF, { file: 'a.txt', line: 1, message: 'x' });
    assert.deepEqual(doc.problems, at(expected, 'problems'), 'the CLI reports the library problems');
    assert.deepEqual(bytesOf(file), before);

    const human = run(['add-comment', '--sarif', file, '--file', 'a.txt', '--line', '1', '--message', 'x']);
    assert.equal(human.status, 2);
    // Human form (docs/diagnostics.md): what happened to the file on stdout, the problems as diagnostics on stderr.
    assert.equal(human.stdout, `${file} was not changed.\n`);
    assert.ok(human.stderr.includes(item(asString(at(expected, 'problems', 0, 'message')).split('\n'), 0)), human.stderr);
    assert.deepEqual(doc.diagnostics, at(expected, 'diagnostics'), 'the CLI reports the library diagnostics');
  });

  const commentUsageCases: readonly (readonly [string, readonly string[], string])[] = [
    ['no message', ['--file', 'a.txt', '--line', '1'], '--message'],
    ['both message sources', ['--file', 'a.txt', '--line', '1', '--message', 'x', '--message-file', '-'], '--message'],
    ['a zero line', ['--file', 'a.txt', '--line', '0', '--message', 'x'], '--line'],
    ['an end line before the line', ['--file', 'a.txt', '--line', '3', '--end-line', '2', '--message', 'x'], '--end-line'],
    ['an unknown level', ['--file', 'a.txt', '--line', '1', '--message', 'x', '--level', 'fatal'], '--level'],
    ['--run with --new-run-tool', ['--file', 'a.txt', '--line', '1', '--message', 'x', '--run', '0', '--new-run-tool', 'R'], '--run'],
    ['--repo without --new-run-tool', ['--file', 'a.txt', '--line', '1', '--message', 'x', '--repo', 'a/b', '--commit', COMMIT], '--new-run-tool'],
    ['an absolute --file', ['--file', '/etc/passwd', '--line', '1', '--message', 'x'], '--file'],
    ['a --file with ..', ['--file', 'src/../secret', '--line', '1', '--message', 'x'], '--file'],
    ['a --file with a backslash', ['--file', 'src\\a.js', '--line', '1', '--message', 'x'], '--file'],
  ];
  for (const [label, args, mention] of commentUsageCases) {
    test(`usage error: ${label}`, () => {
      const dir = tempDir('comment-usage');
      const file = initFile(dir);
      const before = bytesOf(file);
      const result = run(['add-comment', '--sarif', file, ...args, '--format', 'json']);
      assert.equal(result.status, 1, result.stdout);
      const doc = json(result);
      assert.equal(doc.status, 'usage-error');
      assert.ok(asString(doc.message).includes(mention), asString(doc.message));
      assert.deepEqual(bytesOf(file), before);
      assert.deepEqual(fs.readdirSync(dir), ['review.sarif']);
    });
  }

  test('a missing SARIF file is an operational error', () => {
    const dir = tempDir('comment-missing');
    const file = path.join(dir, 'absent.sarif');
    const result = run(['add-comment', '--sarif', file, '--file', 'a.txt', '--line', '1', '--message', 'x', '--format', 'json']);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.status, 'error');
    assert.ok(asString(doc.message).includes(file));
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('a symbolic link is followed: the target is edited and the link survives', () => {
    const dir = tempDir('comment-link');
    const target = initFile(dir, 'real.sarif');
    const link = path.join(dir, 'link.sarif');
    fs.symlinkSync(target, link);
    json(run(['add-comment', '--sarif', link, '--file', 'a.txt', '--line', '1', '--message', 'x', '--format', 'json']));
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(asArray(at(readJson(target), 'runs', 0, 'results')).length, 1);
  });

  test('another cooperating writer\'s ownership marker causes a refusal, never a takeover', () => {
    const dir = tempDir('comment-owned');
    const file = initFile(dir);
    const before = bytesOf(file);
    // The documented ownership marker: `.<name>.sarif-to-comment-lock` beside the file.
    const marker = path.join(dir, '.review.sarif.sarif-to-comment-lock');
    fs.writeFileSync(marker, 'held by another command');
    const result = run(['add-comment', '--sarif', file, '--file', 'a.txt', '--line', '1', '--message', 'x', '--format', 'json']);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.status, 'error');
    assert.ok(asString(doc.message).includes(marker), 'the refusal names the marker so a stale one can be removed deliberately');
    assert.deepEqual(doc.sarif, { path: file, written: false });
    assert.deepEqual(bytesOf(file), before);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'held by another command', 'the marker is not taken over');

    fs.unlinkSync(marker);
    const retry = json(run(['add-comment', '--sarif', file, '--file', 'a.txt', '--line', '1', '--message', 'x', '--format', 'json']));
    assert.equal(retry.status, 'added');
    assert.deepEqual(fs.readdirSync(dir), ['review.sarif'], 'the marker is released after completion');
  });
});

// ---------------------------------------------------------------------------
// remove-comment (docs/finding-removal-contract.md §4)
// ---------------------------------------------------------------------------

describe('remove-comment edits the SARIF file in place', () => {
  /** The selector `inspect --format json` gives the finding at `ref` in `file`. */
  function selectorFor(file: string, ref: string): string {
    const doc = json(run(['inspect', '--sarif', file, '--format', 'json']));
    const finding = asArray(at(doc.view, 'findings')).find((f) => at(f, 'ref') === ref);
    assert.ok(finding !== undefined, `inspection has no finding ${ref}`);
    return asString(at(finding, 'selector'));
  }

  /** A file with two authored findings (lines 3 and 5 of src/parse.js), the first carrying one fix. */
  function twoFindings(dir: string): string {
    const file = initFile(dir, 'review.sarif', ['--tool-name', 'Review agent']);
    json(run(['add-comment', '--sarif', file, '--file', 'src/parse.js', '--line', '3', '--message', 'Wrong line.', '--format', 'json']));
    json(run(['add-comment', '--sarif', file, '--file', 'src/parse.js', '--line', '5', '--message', 'Keep me.', '--format', 'json']));
    const sarif = asRecord(readJson(file));
    asRecord(at(sarif, 'runs', 0, 'results', 0))['fixes'] = [
      { artifactChanges: [{ artifactLocation: { uri: 'src/parse.js' }, replacements: [{ deletedRegion: { startLine: 3 }, insertedContent: { text: 'x\n' } }] }] },
    ];
    writeJson(file, sarif);
    return file;
  }

  test('removal by an inspected selector: exact receipt, file is the library document, nothing left behind', () => {
    const dir = tempDir('remove');
    const file = twoFindings(dir);
    const before = asRecord(readJson(file));
    const selector = selectorFor(file, '/runs/0/results/0');
    const result = run(['remove-comment', '--sarif', file, '--finding', selector, '--format', 'json']);
    assert.equal(result.status, 0, result.stdout);
    const doc = json(result);
    assert.deepEqual(doc, {
      command: 'remove-comment',
      status: 'removed',
      sarif: { path: file, written: true },
      finding: { ref: '/runs/0/results/0', runIndex: 0, resultIndex: 0, tool: 'Review agent', fixes: 1, fileProposals: 0 },
      diagnostics: [],
    });
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'sarif', 'finding', 'diagnostics']);
    const after = readJson(file);
    const expected = structuredClone(before);
    asArray(at(expected, 'runs', 0, 'results')).splice(0, 1);
    assert.deepEqual(after, expected, 'exactly the selected result is gone');
    const expectedOutcome = library.removeSarifComment(before, selector);
    assert.equal(expectedOutcome.status, 'removed');
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(at(expectedOutcome, 'sarif'), null, 2)}\n`, 'the CLI writes what the library returns');
    assert.deepEqual(fs.readdirSync(dir), ['review.sarif'], 'no lock or temporary file remains');
  });

  test('identical findings in different runs: removing one by its selector keeps the other', () => {
    const dir = tempDir('remove-identical');
    const file = initFile(dir, 'review.sarif', ['--tool-name', 'Review agent']);
    const same = ['--file', 'src/parse.js', '--line', '2', '--message', 'Handle the empty-input case.', '--format', 'json'];
    json(run(['add-comment', '--sarif', file, ...same]));
    json(run(['add-comment', '--sarif', file, ...same, '--new-run-tool', 'Review agent']));
    const before = asRecord(readJson(file));
    const first = selectorFor(file, '/runs/0/results/0');
    const second = selectorFor(file, '/runs/1/results/0');
    assert.notEqual(first, second);
    const doc = json(run(['remove-comment', '--sarif', file, '--finding', second, '--format', 'json']));
    assert.equal(at(doc.finding, 'ref'), '/runs/1/results/0');
    const after = readJson(file);
    assert.deepEqual(at(after, 'runs', 0), at(before, 'runs', 0), 'the identical finding in run 0 is untouched');
    assert.deepEqual(at(after, 'runs', 1, 'results'), []);
  });

  test('a stale selector is refused with exit 2 in both formats and the file is untouched', () => {
    const dir = tempDir('remove-stale');
    const file = twoFindings(dir);
    const first = selectorFor(file, '/runs/0/results/0');
    const second = selectorFor(file, '/runs/0/results/1');
    json(run(['remove-comment', '--sarif', file, '--finding', first, '--format', 'json']));
    const before = bytesOf(file);
    for (const selector of [first, second]) {
      const result = run(['remove-comment', '--sarif', file, '--finding', selector, '--format', 'json']);
      assert.equal(result.status, 2, result.stdout);
      const doc = json(result);
      assert.equal(doc.command, 'remove-comment');
      assert.equal(doc.status, 'stale');
      assert.deepEqual(doc.sarif, { path: file, written: false });
      assert.ok(asArray(doc.problems).length > 0);
      assert.match(asString(at(doc.problems, 0, 'message')), /inspect/i);
      assert.deepEqual(bytesOf(file), before, 'the finding now at the old position survives');
    }
    const human = run(['remove-comment', '--sarif', file, '--finding', first]);
    assert.equal(human.status, 2);
    assert.match(human.stderr, /\[finding-selector-stale\][\s\S]*inspect/i, 'the refusal is a diagnostic on stderr');
    assert.equal(human.stdout, `${file} was not changed.\n`);
    assert.deepEqual(bytesOf(file), before);
    assert.deepEqual(fs.readdirSync(dir), ['review.sarif']);
  });

  test('human output names what was removed, how many fixes went with it, and the file', () => {
    const dir = tempDir('remove-human');
    const file = twoFindings(dir);
    const result = run(['remove-comment', '--sarif', file, '--finding', selectorFor(file, '/runs/0/results/0')]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.includes('/runs/0/results/0'), result.stdout);
    assert.ok(result.stdout.includes('Review agent'), result.stdout);
    assert.match(result.stdout, /\b1 attached fix/);
    assert.ok(result.stdout.includes(file), result.stdout);
    assert.match(result.stdout, /inspect/i, 'it says to inspect again for new selectors');
  });

  const removeUsageCases: readonly (readonly [string, readonly string[], string])[] = [
    ['no --finding', [], '--finding'],
    ['a bare ref instead of a selector', ['--finding', '/runs/0/results/0'], 'inspect'],
    ['a guessed message', ['--finding', 'Wrong line.'], 'inspect'],
    ['an unknown option', ['--finding', '/runs/0/results/0@0123456789abcdef', '--line', '3'], '--line'],
  ];
  for (const [label, args, mention] of removeUsageCases) {
    test(`usage error: ${label}; the file is untouched`, () => {
      const dir = tempDir('remove-usage');
      const file = twoFindings(dir);
      const before = bytesOf(file);
      const result = run(['remove-comment', '--sarif', file, ...args, '--format', 'json']);
      assert.equal(result.status, 1, result.stdout);
      const doc = json(result);
      assert.equal(doc.status, 'usage-error');
      assert.ok(asString(doc.message).includes(mention), asString(doc.message));
      assert.deepEqual(bytesOf(file), before);
      assert.deepEqual(fs.readdirSync(dir), ['review.sarif']);
    });
  }

  test('schema-invalid SARIF: exit 2, the library problems, nothing written', () => {
    const dir = tempDir('remove-invalid');
    const file = path.join(dir, 'bad.sarif');
    writeJson(file, NOT_SARIF);
    const before = bytesOf(file);
    const selector = '/runs/0/results/0@0123456789abcdef';
    const result = run(['remove-comment', '--sarif', file, '--finding', selector, '--format', 'json']);
    assert.equal(result.status, 2);
    const doc = json(result);
    assert.equal(doc.status, 'invalid');
    assert.deepEqual(doc.sarif, { path: file, written: false });
    assert.deepEqual(doc.problems, at(library.removeSarifComment(NOT_SARIF, selector), 'problems'));
    assert.deepEqual(bytesOf(file), before);
  });

  test('a missing SARIF file is an operational error', () => {
    const dir = tempDir('remove-missing');
    const file = path.join(dir, 'absent.sarif');
    const result = run(['remove-comment', '--sarif', file, '--finding', '/runs/0/results/0@0123456789abcdef', '--format', 'json']);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.status, 'error');
    assert.ok(asString(doc.message).includes(file));
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('another cooperating writer\'s ownership marker causes a refusal, never a takeover', () => {
    const dir = tempDir('remove-owned');
    const file = twoFindings(dir);
    const selector = selectorFor(file, '/runs/0/results/0');
    const before = bytesOf(file);
    const marker = path.join(dir, '.review.sarif.sarif-to-comment-lock');
    fs.writeFileSync(marker, 'held by another command');
    const result = run(['remove-comment', '--sarif', file, '--finding', selector, '--format', 'json']);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.status, 'error');
    assert.ok(asString(doc.message).includes(marker));
    assert.deepEqual(doc.sarif, { path: file, written: false });
    assert.deepEqual(bytesOf(file), before);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'held by another command');
  });

  test('a symbolic link is followed: the target is edited and the link survives', () => {
    const dir = tempDir('remove-link');
    const target = twoFindings(dir);
    const link = path.join(dir, 'link.sarif');
    fs.symlinkSync(target, link);
    json(run(['remove-comment', '--sarif', link, '--finding', selectorFor(link, '/runs/0/results/0'), '--format', 'json']));
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.deepEqual(asArray(at(readJson(target), 'runs', 0, 'results')).map((r) => at(r, 'message', 'text')), ['Keep me.']);
  });

  test('human inspection shows each finding\'s selector', () => {
    const dir = tempDir('remove-inspect-human');
    const file = twoFindings(dir);
    const human = run(['inspect', '--sarif', file]);
    assert.equal(human.status, 0, human.stderr);
    for (const ref of ['/runs/0/results/0', '/runs/0/results/1']) {
      assert.ok(human.stdout.includes(`Selector: ${selectorFor(file, ref)}`), human.stdout);
    }
  });
});

// ---------------------------------------------------------------------------
// inspect (§3.3)
// ---------------------------------------------------------------------------

describe('inspect', () => {
  /** SARIF with a long multi-line fix, a general finding and a second run. */
  function inspectionInput() {
    const sarif = library.createSarifDocument({ tool: { name: 'Review agent' } });
    const inserted = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)}\n`).join('');
    asArray(at(sarif, 'runs', 0, 'results')).push(
      {
        message: { text: 'Rewrite this block.\nIt is long.' },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.js' }, region: { startLine: 3, endLine: 4 } } }],
        fixes: [
          {
            description: { text: 'Replace the block.' },
            artifactChanges: [
              {
                artifactLocation: { uri: 'src/a.js' },
                replacements: [{ deletedRegion: { startLine: 3, startColumn: 1, endLine: 5, endColumn: 1 }, insertedContent: { text: inserted } }],
              },
            ],
          },
        ],
      },
      { message: { text: 'A general remark with no location.' } },
    );
    sarif.runs.push({ tool: { driver: { name: 'Other tool', version: '9.9.9' } }, results: [{ message: { text: 'Other run finding.' } }] });
    return { sarif, inserted };
  }

  test('JSON output is the library view; the SARIF file is byte-identical afterwards', () => {
    const dir = tempDir('inspect');
    const { sarif } = inspectionInput();
    const file = path.join(dir, 'review.sarif');
    writeJson(file, sarif);
    const before = bytesOf(file);
    const result = run(['inspect', '--sarif', file, '--preview-lines', '5', '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    const doc = json(result);
    assert.deepEqual(Object.keys(doc).sort(), ['command', 'diagnostics', 'status', 'view']);
    assert.equal(doc.command, 'inspect');
    assert.equal(doc.status, 'inspected');
    const expected = library.inspectSarif(sarif, { previewLines: 5 });
    assert.equal(expected.status, 'inspected');
    assert.deepEqual(doc.view, expected.view);
    // Independent content checks (§3.3): full messages, every run, truncated preview counts.
    assert.equal(at(doc.view, 'format'), 'sarif-to-comment.inspection');
    assert.equal(asArray(at(doc.view, 'findings')).length, 3);
    assert.equal(at(doc.view, 'findings', 0, 'message', 'text'), 'Rewrite this block.\nIt is long.');
    const preview = at(doc.view, 'findings', 0, 'fixes', 0, 'changes', 0, 'replacements', 0, 'inserted');
    assert.equal(at(preview, 'state'), 'truncated');
    assert.equal(at(preview, 'totalLines'), 30);
    assert.equal(at(preview, 'shownLines'), 5);
    assert.equal(at(preview, 'text'), 'line 1\nline 2\nline 3\nline 4\nline 5\n');
    assert.deepEqual(bytesOf(file), before);
  });

  test('JSON output carries the library view with its field order intact', () => {
    const dir = tempDir('inspect-order');
    const { sarif } = inspectionInput();
    const file = path.join(dir, 'review.sarif');
    writeJson(file, sarif);
    const result = run(['inspect', '--sarif', file, '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    const doc = json(result);
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'view', 'diagnostics']);
    // Field order of the view itself is pinned against the contract in
    // test/sarif-inspection.test.mts; here the CLI must not reorder it.
    assert.equal(JSON.stringify(doc.view), JSON.stringify(at(library.inspectSarif(sarif), 'view')));
  });

  test('human output renders every finding, location and fix preview with visible truncation', () => {
    const dir = tempDir('inspect-human');
    const { sarif } = inspectionInput();
    const file = path.join(dir, 'review.sarif');
    writeJson(file, sarif);
    const result = run(['inspect', '--sarif', file, '--preview-lines', '5']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const out = result.stdout;
    for (const text of ['Rewrite this block.\nIt is long.', 'A general remark with no location.', 'Other run finding.']) {
      assert.ok(out.includes(text), `human inspection omits ${JSON.stringify(text)}`);
    }
    for (const ref of ['/runs/0/results/0', '/runs/0/results/1', '/runs/1/results/0']) assert.ok(out.includes(ref));
    assert.ok(out.includes('Review agent') && out.includes('Other tool'));
    assert.ok(out.includes('src/a.js:3-4'));
    assert.match(out, /general/i);
    assert.ok(out.includes('line 5\n'));
    assert.ok(!out.includes('line 6\n'), 'truncated preview stops at the limit');
    assert.match(out, /\(truncated: 5 of 30 lines shown\)/);
  });

  test('--preview-lines all shows complete previews', () => {
    const dir = tempDir('inspect-all');
    const { sarif, inserted } = inspectionInput();
    const file = path.join(dir, 'review.sarif');
    writeJson(file, sarif);
    const doc = json(run(['inspect', '--sarif', file, '--preview-lines', 'all', '--preview-chars', 'all', '--format', 'json']));
    const preview = at(doc.view, 'findings', 0, 'fixes', 0, 'changes', 0, 'replacements', 0, 'inserted');
    assert.equal(at(preview, 'state'), 'complete');
    assert.equal(at(preview, 'text'), inserted);
    assert.deepEqual(doc.view, at(library.inspectSarif(sarif, { previewLines: null, previewChars: null }), 'view'));
  });

  test('upstream SARIF is inspected without initialization', () => {
    const doc = json(run(['inspect', '--sarif', UPSTREAM_SARIF_PATH, '--format', 'json']));
    assert.equal(doc.status, 'inspected');
    assert.deepEqual(
      asArray(at(doc.view, 'findings')).map((f) => [at(f, 'ref'), at(f, 'ruleId'), at(f, 'level'), at(f, 'message', 'text')]),
      [
        ['/runs/0/results/0', 'VALUE', 'note', 'Use the corrected second value.'],
        ['/runs/0/results/1', 'COMBINE', 'warning', 'Combine these two entries without changing the following entries.'],
      ],
    );
  });

  test('log-level, inline external and inserted-content evidence appear in both formats', () => {
    // The inspection author's fixture: log properties, inlineExternalProperties with embedded results,
    // and insertedContent carrying properties/rendered alongside its text.
    const file = path.join(ROOT, 'test', 'fixtures', 'sarif-inspection', 'log-evidence.sarif.json');
    const sarif = asRecord(readJson(file));
    const doc = json(run(['inspect', '--sarif', file, '--format', 'json']));
    assert.deepEqual(doc.view, at(library.inspectSarif(sarif), 'view'));
    assert.deepEqual(at(doc.view, 'log'), { otherContent: { properties: sarif['properties'] } });
    assert.equal(asArray(at(doc.view, 'externalProperties')).length, asArray(sarif['inlineExternalProperties']).length);
    assert.equal(
      at(doc.view, 'summary', 'externalFindings'),
      asArray(sarif['inlineExternalProperties']).reduce((n: number, e) => n + asArray(at(e, 'results') ?? []).length, 0),
    );
    const human = run(['inspect', '--sarif', file]);
    assert.equal(human.status, 0, human.stderr);
    for (const needle of ['producerRunId', '/inlineExternalProperties/0', 'rendered form', 'rationale']) {
      assert.ok(human.stdout.includes(needle), `human inspection omits ${needle}`);
    }
  });

  test('schema-invalid SARIF: exit 2 with the library problems', () => {
    const dir = tempDir('inspect-invalid');
    const file = path.join(dir, 'bad.sarif');
    writeJson(file, NOT_SARIF);
    const result = run(['inspect', '--sarif', file, '--format', 'json']);
    assert.equal(result.status, 2);
    const doc = json(result);
    assert.equal(doc.status, 'invalid');
    assert.deepEqual(doc.problems, at(library.inspectSarif(NOT_SARIF), 'problems'));
  });

  const inspectUsageCases: readonly (readonly [string, readonly string[], string])[] = [
    ['a negative preview limit', ['--preview-lines', '-1'], '--preview-lines'],
    ['a non-numeric preview limit', ['--preview-chars', 'lots'], '--preview-chars'],
    ['a relative source root', ['--source-root', 'work/'], '--source-root'],
  ];
  for (const [label, extra, mention] of inspectUsageCases) {
    test(`usage error: ${label}`, () => {
      const doc = json(run(['inspect', '--sarif', UPSTREAM_SARIF_PATH, ...extra, '--format', 'json']));
      assert.equal(doc.status, 'usage-error');
      assert.ok(asString(doc.message).includes(mention), asString(doc.message));
    });
  }

  test('a file that is not JSON is an operational error in either format', () => {
    const dir = tempDir('inspect-notjson');
    const file = path.join(dir, 'broken.sarif');
    fs.writeFileSync(file, '{ not json');
    const machine = run(['inspect', '--sarif', file, '--format', 'json']);
    assert.equal(machine.status, 1);
    assert.equal(json(machine).status, 'error');
    const human = run(['inspect', '--sarif', file]);
    assert.equal(human.status, 1);
    assert.equal(human.stdout, '');
    assert.ok(human.stderr.includes(file));
  });
});

// ---------------------------------------------------------------------------
// add-staged-changes (§3.4, §4, §6.4)
// ---------------------------------------------------------------------------

describe('add-staged-changes', () => {
  function stagedArgs(world: IGitWorld, input: string, output: string, extra: readonly string[] = []): string[] {
    return [
      'add-staged-changes', '--sarif', input, '--output', output, '--worktree', world.dir,
      '--repo', `${world.repository.destination.owner}/${world.repository.destination.repo}`, '--commit', world.head, ...extra,
    ];
  }

  test('upstream SARIF gains the staged edits, not the working tree; the receipt is the library receipt', async () => {
    const world = createGitWorld('staged-upstream');
    const out = tempDir('staged-out');
    const output = path.join(out, 'enriched.sarif');
    const result = run([...stagedArgs(world, UPSTREAM_SARIF_PATH, output), '--format', 'json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const doc = json(result);
    assert.equal(doc.command, 'add-staged-changes');
    assert.equal(doc.status, 'added');
    assert.deepEqual(doc.output, { path: output, written: true });
    assert.equal(doc.archived, null);

    const enriched = readJson(output);
    const text = fs.readFileSync(output, 'utf8');
    assert.ok(!text.includes(SENTINEL), 'unstaged content never enters the SARIF');
    // Independent R2 oracle: applying the extracted edits to H gives T exactly.
    const edits = distinctReplacements(replacementsFor(enriched, ORACLE.path));
    assert.equal(applyReplacements(ORACLE.reviewed, edits), ORACLE.staged);
    // Feedback, attribution and producer metadata survive; each finding carries its own edit.
    const a = at(enriched, 'runs', 0, 'results', 0);
    const b = at(enriched, 'runs', 0, 'results', 1);
    assert.equal(at(a, 'message', 'text'), item(ORACLE.findings, 0).message);
    assert.equal(at(b, 'message', 'text'), item(ORACLE.findings, 1).message);
    assert.deepEqual(at(a, 'properties'), at(UPSTREAM, 'runs', 0, 'results', 0, 'properties'));
    assert.deepEqual(at(enriched, 'runs', 0, 'tool'), at(UPSTREAM, 'runs', 0, 'tool'));
    assert.equal(applyReplacements(ORACLE.reviewed, replacementsFor({ runs: [{ results: [a] }] }, ORACLE.path)).split('\n')[1], 'corrected two');
    assert.deepEqual(at(enriched, 'runs', 0, 'versionControlProvenance'), [
      { repositoryUri: `https://github.com/${world.repository.destination.owner}/${world.repository.destination.repo}`, revisionId: world.head },
    ]);
    assert.deepEqual(at(doc.receipt, 'changes'), [
      {
        path: ORACLE.path,
        operation: 'edit',
        replacements: [
          { startLine: 2, endLine: 2, associated: ['/runs/0/results/0'], explainedBy: 'finding' },
          { startLine: 5, endLine: 6, associated: ['/runs/0/results/1'], explainedBy: 'finding' },
        ],
      },
    ]);
    assert.deepEqual(at(doc.receipt, 'boundRuns'), [0]);
    assert.equal(at(doc.receipt, 'addedRun'), null);

    const outcome = await library.addStagedChangesToSarif({
      sarif: UPSTREAM,
      worktree: world.dir,
      reviewedCommit: world.head,
      repository: { owner: world.repository.destination.owner, repo: world.repository.destination.repo },
    });
    assert.equal(outcome.status, 'added');
    assert.deepEqual(doc.receipt, outcome.receipt);
    assert.deepEqual(enriched, outcome.sarif, 'the CLI writes what the library returns');
  });

  test('the JSON receipt and the written SARIF keep the library field order', async () => {
    const world = createGitWorld('staged-order');
    const output = path.join(tempDir('staged-order-out'), 'enriched.sarif');
    const result = run([...stagedArgs(world, UPSTREAM_SARIF_PATH, output), '--format', 'json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const doc = json(result);
    // Characterization of 0.2.0: the receipt envelope order.
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'output', 'archived', 'receipt', 'diagnostics']);
    assert.deepEqual(Object.keys(asRecord(doc.output)), ['path', 'written']);
    const outcome = await library.addStagedChangesToSarif({
      sarif: UPSTREAM,
      worktree: world.dir,
      reviewedCommit: world.head,
      repository: { owner: world.repository.destination.owner, repo: world.repository.destination.repo },
    });
    assert.equal(JSON.stringify(doc.receipt), JSON.stringify(at(outcome, 'receipt')));
    assert.equal(fs.readFileSync(output, 'utf8'), `${JSON.stringify(at(outcome, 'sarif'), null, 2)}\n`, 'two-space JSON with a final newline');
  });

  test('human output reports the written file and each change', () => {
    const world = createGitWorld('staged-human');
    const out = tempDir('staged-human-out');
    const output = path.join(out, 'enriched.sarif');
    const result = run(stagedArgs(world, UPSTREAM_SARIF_PATH, output));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.includes(output));
    assert.ok(result.stdout.includes(ORACLE.path));
    assert.match(result.stdout, /\/runs\/0\/results\/0/);
  });

  test('an existing output is archived under its birth-time name before any other work (§6.4)', () => {
    const world = createGitWorld('staged-archive');
    const out = tempDir('staged-archive-out');
    const output = path.join(out, 'enriched.sarif');
    fs.writeFileSync(output, 'previous output');
    const { stamp, timeSource } = expectedArchiveStamp(output);
    const doc = json(run([...stagedArgs(world, UPSTREAM_SARIF_PATH, output), '--format', 'json']));
    assert.equal(doc.status, 'added');
    const archive = path.join(out, `${stamp}.old.enriched.sarif`);
    assert.deepEqual(doc.archived, { path: archive, from: output, timeSource });
    assert.equal(fs.readFileSync(archive, 'utf8'), 'previous output');
    assert.deepEqual(fs.readdirSync(out).sort(), [path.basename(archive), 'enriched.sarif'].sort());
  });

  test('an archive name collision takes the next numbered suffix', () => {
    const world = createGitWorld('staged-collision');
    const out = tempDir('staged-collision-out');
    const output = path.join(out, 'enriched.sarif');
    fs.writeFileSync(output, 'previous output');
    const { stamp } = expectedArchiveStamp(output);
    fs.writeFileSync(path.join(out, `${stamp}.old.enriched.sarif`), 'older archive');
    const doc = json(run([...stagedArgs(world, UPSTREAM_SARIF_PATH, output), '--format', 'json']));
    assert.equal(at(doc.archived, 'path'), path.join(out, `${stamp}-2.old.enriched.sarif`));
    assert.equal(fs.readFileSync(path.join(out, `${stamp}.old.enriched.sarif`), 'utf8'), 'older archive');
    assert.equal(fs.readFileSync(asString(at(doc.archived, 'path')), 'utf8'), 'previous output');
  });

  test('a strict extraction failure: exit 2, no normal output, the archive is reported (W6/W8)', () => {
    const world = createGitWorld('staged-mode');
    fs.chmodSync(world.file, 0o755);
    const add = spawnSync('git', ['add', ORACLE.path], { cwd: world.dir, env: world.env, encoding: 'utf8' });
    assert.equal(add.status, 0, add.stderr);
    const out = tempDir('staged-mode-out');
    const output = path.join(out, 'enriched.sarif');
    fs.writeFileSync(output, 'previous output');
    const { stamp, timeSource } = expectedArchiveStamp(output);
    const result = run([...stagedArgs(world, UPSTREAM_SARIF_PATH, output), '--format', 'json']);
    assert.equal(result.status, 2, result.stdout);
    const doc = json(result);
    assert.equal(doc.status, 'failed');
    assert.deepEqual(doc.output, { path: output, written: false });
    assert.deepEqual(doc.archived, { path: path.join(out, `${stamp}.old.enriched.sarif`), from: output, timeSource });
    assert.ok(asArray(doc.problems).some((p) => at(p, 'path') === ORACLE.path || asString(at(p, 'message')).includes(ORACLE.path)), 'the failure names the path');
    assert.equal(fs.existsSync(output), false, 'no normal output after a failure');
    assert.deepEqual(othersIn(out, []), [`${stamp}.old.enriched.sarif`], 'no error artifact and no temporary file');

    const human = run(stagedArgs(world, UPSTREAM_SARIF_PATH, output));
    assert.equal(human.status, 2);
    assert.ok(human.stderr.includes(ORACLE.path), 'the problem, naming the path, is a diagnostic on stderr');
    assert.ok(human.stdout.includes(`${output} was not written.`), 'what happened to the output is on stdout');
  });

  test('schema-invalid input: exit 2 invalid, with archive effects reported', () => {
    const world = createGitWorld('staged-invalid');
    const out = tempDir('staged-invalid-out');
    const input = path.join(out, 'bad.sarif');
    writeJson(input, NOT_SARIF);
    const output = path.join(out, 'enriched.sarif');
    const doc = json(run([...stagedArgs(world, input, output), '--format', 'json']));
    assert.equal(doc.status, 'invalid');
    assert.deepEqual(doc.output, { path: output, written: false });
    assert.equal(doc.archived, null);
    assert.ok(asArray(doc.problems).length > 0);
  });

  test('an operational failure after start is a JSON error with its artifact effects', () => {
    const out = tempDir('staged-notrepo');
    const notRepo = tempDir('staged-notrepo-dir');
    const output = path.join(out, 'enriched.sarif');
    fs.writeFileSync(output, 'previous output');
    const result = run([
      'add-staged-changes', '--sarif', UPSTREAM_SARIF_PATH, '--output', output, '--worktree', notRepo,
      '--repo', 'octo/review-fixture', '--commit', COMMIT, '--format', 'json',
    ]);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.status, 'error');
    assert.equal(typeof doc.message, 'string');
    assert.deepEqual(doc.output, { path: output, written: false });
    assert.equal(at(doc.archived, 'from'), output);
    assert.equal(fs.existsSync(output), false);
  });

  test('usage errors move and write nothing, even with an existing output', () => {
    const world = createGitWorld('staged-usage');
    const out = tempDir('staged-usage-out');
    const output = path.join(out, 'enriched.sarif');
    fs.writeFileSync(output, 'previous output');
    const cases: readonly (readonly [readonly string[], string])[] = [
      [['add-staged-changes', '--sarif', UPSTREAM_SARIF_PATH, '--output', output, '--worktree', world.dir, '--repo', 'octo/review-fixture'], '--commit'],
      [stagedArgs(world, output, output), '--output'],
      [stagedArgs(world, UPSTREAM_SARIF_PATH, path.join(out, 'missing-dir', 'x.sarif')), 'directory'],
      [['add-staged-changes', '--sarif', UPSTREAM_SARIF_PATH, '--output', output, '--worktree', world.dir, '--repo', 'octo/review-fixture', '--commit', 'abc'], '--commit'],
    ];
    for (const [argv, mention] of cases) {
      const result = run([...argv, '--format', 'json']);
      assert.equal(result.status, 1, result.stdout);
      const doc = json(result);
      assert.equal(doc.status, 'usage-error');
      assert.ok(asString(doc.message).includes(mention), asString(doc.message));
      assert.deepEqual(fs.readdirSync(out), ['enriched.sarif']);
      assert.equal(fs.readFileSync(output, 'utf8'), 'previous output');
    }
  });

  test('an output that is a hard link to the input is refused as the same file', () => {
    const world = createGitWorld('staged-hardlink');
    const out = tempDir('staged-hardlink-out');
    const input = path.join(out, 'input.sarif');
    fs.copyFileSync(UPSTREAM_SARIF_PATH, input);
    const alias = path.join(out, 'alias.sarif');
    fs.linkSync(input, alias);
    const doc = json(run([...stagedArgs(world, input, alias), '--format', 'json']));
    assert.equal(doc.status, 'usage-error');
    assert.match(asString(doc.message), /same file/);
    assert.deepEqual(fs.readdirSync(out).sort(), ['alias.sarif', 'input.sarif']);
  });

  test('another writer owning the output causes a refusal before anything is moved', () => {
    const world = createGitWorld('staged-owned');
    const out = tempDir('staged-owned-out');
    const output = path.join(out, 'enriched.sarif');
    fs.writeFileSync(output, 'previous output');
    const marker = path.join(out, '.enriched.sarif.sarif-to-comment-lock');
    fs.writeFileSync(marker, 'held');
    const result = run([...stagedArgs(world, UPSTREAM_SARIF_PATH, output), '--format', 'json']);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.status, 'error');
    assert.ok(asString(doc.message).includes(marker));
    assert.deepEqual(doc.output, { path: output, written: false });
    assert.equal(doc.archived, null);
    assert.deepEqual(fs.readdirSync(out).sort(), ['.enriched.sarif.sarif-to-comment-lock', 'enriched.sarif']);
    assert.equal(fs.readFileSync(output, 'utf8'), 'previous output');
  });

  test('pure insertions are reported as insertions, never as a change to the unchanged neighbouring line', () => {
    // Reviewed three lines; the index inserts a line after line 2 and appends one at the end.
    const world = createGitWorld('staged-insertion', {
      path: 'src/list.txt',
      base: 'zero\n',
      reviewed: 'one\ntwo\nthree\n',
      staged: 'one\ntwo\ninserted\nthree\nfour\n',
      workingTree: 'one\ntwo\ninserted\nthree\nfour\n',
    });
    const out = tempDir('staged-insertion-out');
    const machine = run([...stagedArgs(world, UPSTREAM_SARIF_PATH, path.join(out, 'a.sarif')), '--format', 'json']);
    assert.equal(machine.status, 0, machine.stdout);
    const receipt = json(machine).receipt;
    assert.deepEqual(
      asArray(at(receipt, 'changes', 0, 'replacements')).map((r) => [at(r, 'insertion'), at(r, 'startLine'), at(r, 'endLine'), at(r, 'associated'), at(r, 'explainedBy')]),
      [
        [true, 3, 2, [], 'neutral'], // before reviewed line 3: an empty range, no reviewed line changed
        [true, 4, 3, [], 'neutral'], // at the end of the three-line file
      ],
    );
    const human = run(stagedArgs(world, UPSTREAM_SARIF_PATH, path.join(out, 'b.sarif')));
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /insertion after line 2 \(no reviewed line changed\)/);
    assert.match(human.stdout, /insertion after line 3 \(no reviewed line changed\)/);
    assert.doesNotMatch(human.stdout, /lines 3(-3)?:|lines 4(-4)?:/, 'no unchanged line is presented as changed');
  });

  test('no staged change writes the output unchanged (§4.9)', () => {
    const world = createGitWorld('staged-none');
    const reset = spawnSync('git', ['reset', '-q', '--', ORACLE.path], { cwd: world.dir, env: world.env, encoding: 'utf8' });
    assert.equal(reset.status, 0, reset.stderr);
    const out = tempDir('staged-none-out');
    const output = path.join(out, 'enriched.sarif');
    const doc = json(run([...stagedArgs(world, UPSTREAM_SARIF_PATH, output), '--format', 'json']));
    assert.equal(doc.status, 'added');
    assert.deepEqual(at(doc.receipt, 'changes'), []);
    assert.deepEqual(readJson(output), UPSTREAM);
  });
});

// ---------------------------------------------------------------------------
// publish (§3.5)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Commands that read GitHub: publish and validate
// ---------------------------------------------------------------------------

/** A world for a command that reads GitHub: a fake remote, the input file and the state path. */
interface IPublishWorld {
  readonly root: string;
  readonly remote: FakeGitHubRemote;
  readonly sarifPath: string;
  readonly statePath: string;
}

function publishWorld(sarif: unknown = READY, hostConfig: Partial<IFakeRemoteConfig> = {}): IPublishWorld {
  const root = tempDir('publish');
  const remote = FakeGitHubRemote.create(path.join(root, 'remote'), hostConfig);
  const sarifPath = path.join(root, 'input.sarif.json');
  writeJson(sarifPath, sarif);
  return { root, remote, sarifPath, statePath: path.join(root, 'review.publication.json') };
}

/** The destination flags shared by publish and validate (no --state). */
function destinationFlags(world: IPublishWorld): string[] {
  const { owner, repo, pullNumber } = REPOSITORY.destination;
  return ['--sarif', world.sarifPath, '--repo', `${owner}/${repo}`, '--pull', String(pullNumber), '--commit', REPOSITORY.commits.head];
}

/** Runs the real CLI through the wrapper that replaces only the GitHub adapter; the token never appears. */
function runPublish(world: IPublishWorld, argv: readonly string[], env: Readonly<Record<string, string>> = { GH_TOKEN: TOKEN }): IRun {
  const result = spawnSync(process.execPath, [WRAPPER, ...argv], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env['PATH'], FAKE_GITHUB_DIR: world.remote.dir, ...env },
  });
  for (const text of [result.stdout, result.stderr]) assert.equal(text.includes(TOKEN), false, 'the token never appears');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('publish', () => {
  function flags(world: IPublishWorld): string[] {
    return [...destinationFlags(world), '--state', world.statePath];
  }

  const normalize = (text: string, world: IPublishWorld): string => text.split(world.statePath).join('<STATE>');

  test('`publish` in human format is the flag-only publisher exactly', () => {
    const legacyWorld = publishWorld();
    const legacy = runPublish(legacyWorld, flags(legacyWorld));
    for (const form of [['publish'], ['publish', '--format', 'human']]) {
      const world = publishWorld();
      const routed = runPublish(world, [...form, ...flags(world)]);
      assert.equal(routed.status, legacy.status);
      assert.equal(routed.stderr, legacy.stderr);
      assert.equal(normalize(routed.stdout, world), normalize(legacy.stdout, legacyWorld));
      assert.equal(world.remote.calls('createReview').length, 1);
    }
  });

  test('published in JSON: review, state path and the library Markdown; exit 0', () => {
    const world = publishWorld();
    const result = runPublish(world, ['publish', ...flags(world), '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    const doc = json(result);
    const stored = item(world.remote.reviews(), 0);
    assert.deepEqual(Object.keys(doc).sort(), ['command', 'diagnostics', 'message', 'review', 'statePath', 'status']);
    assert.equal(doc.command, 'publish');
    assert.equal(doc.status, 'published');
    assert.equal(doc.statePath, world.statePath);
    assert.equal(at(doc.review, 'url'), stored.htmlUrl);
    assert.equal(typeof at(doc.review, 'id'), 'number');
    assert.ok(asString(doc.message).includes(stored.htmlUrl));

    const again = json(runPublish(world, ['publish', ...flags(world), '--format', 'json']));
    assert.deepEqual(again.review, doc.review, 'the retry reports the recorded receipt');
    assert.equal(world.remote.calls('createReview').length, 1);
  });

  test('published, blocked and error documents keep the contract field order', () => {
    // §3.5: { command: "publish", status, review?: { id, url }, statePath?, message }
    const published = publishWorld();
    const doc = json(runPublish(published, ['publish', ...flags(published), '--format', 'json']));
    assert.equal(doc.status, 'published');
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'review', 'statePath', 'message', 'diagnostics']);
    assert.deepEqual(Object.keys(asRecord(doc.review)), ['id', 'url']);

    const blocked = publishWorld(INVALID_PUBLICATION);
    const blockedDoc = json(runPublish(blocked, ['publish', ...flags(blocked), '--format', 'json']));
    assert.equal(blockedDoc.status, 'blocked');
    assert.deepEqual(Object.keys(blockedDoc), ['command', 'status', 'message', 'diagnostics']);

    const noToken = publishWorld();
    const errorDoc = json(runPublish(noToken, ['publish', ...flags(noToken), '--format', 'json'], {}));
    assert.equal(errorDoc.status, 'error');
    assert.deepEqual(Object.keys(errorDoc), ['command', 'status', 'message', 'diagnostics']);
  });

  test('the flag-only route accepts --format json too', () => {
    const world = publishWorld();
    const doc = json(runPublish(world, [...flags(world), '--format', 'json']));
    assert.equal(doc.command, 'publish');
    assert.equal(doc.status, 'published');
  });

  test('blocked in JSON: exit 2, no review, no state file, nothing written remotely', () => {
    const world = publishWorld(INVALID_PUBLICATION);
    const result = runPublish(world, ['publish', ...flags(world), '--format', 'json']);
    assert.equal(result.status, 2);
    const doc = json(result);
    assert.deepEqual(Object.keys(doc).sort(), ['command', 'diagnostics', 'message', 'status']);
    assert.equal(doc.status, 'blocked');
    assert.deepEqual(world.remote.writeCalls(), []);
    assert.equal(fs.existsSync(world.statePath), false);
  });

  test('uncertain in JSON: exit 3 with the preserved state path and retry guidance', () => {
    const world = publishWorld(READY, { create: 'lose-response', visibilityDelay: 4 });
    const result = runPublish(world, ['publish', ...flags(world), '--format', 'json']);
    assert.equal(result.status, 3);
    const doc = json(result);
    assert.equal(doc.status, 'uncertain');
    assert.equal(doc.statePath, world.statePath);
    assert.match(asString(doc.message), /same state path/i);
    assert.ok(fs.existsSync(world.statePath));
  });

  test('a missing token in JSON is an error document naming the variables', () => {
    const world = publishWorld();
    const result = runPublish(world, ['publish', ...flags(world), '--format', 'json'], {});
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.status, 'error');
    assert.match(asString(doc.message), /GH_TOKEN/);
  });

  test('a usage error in JSON names publish and makes no request', () => {
    const world = publishWorld();
    const result = runPublish(world, ['publish', '--sarif', world.sarifPath, '--format', 'json']);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.command, 'publish');
    assert.equal(doc.status, 'usage-error');
    assert.match(asString(doc.message), /missing required option/);
    assert.deepEqual(world.remote.calls('adapter:create'), []);
  });

  test('an operational failure mentioning the token is redacted in JSON', () => {
    const world = publishWorld();
    setAdapterConfig(world.remote.dir, { context: 'throw-with-token' });
    const result = runPublish(world, ['publish', ...flags(world), '--format', 'json']);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.status, 'error');
    assert.match(asString(doc.message), /\[redacted\]/);
  });
});

describe('validate', () => {
  /** Files in a world other than the fake remote's own directory. */
  const localFiles = (world: IPublishWorld): string[] => fs.readdirSync(world.root).filter((name) => name !== 'remote').sort();

  /** Zero remote writes and nothing new on disk (contract: Guarantees). */
  function assertNothingWritten(world: IPublishWorld): void {
    assert.deepEqual(world.remote.writeCalls(), [], 'no remote write');
    assert.deepEqual(world.remote.reviews(), [], 'no review');
    assert.equal(fs.existsSync(world.statePath), false, 'no publication state');
    assert.deepEqual(localFiles(world), ['input.sarif.json'], 'only the input file exists');
  }

  test('--help documents the publish flags without --state, needs no token and names the exit statuses', () => {
    const result = run(['validate', '--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('--state'), false, 'assessment has no state path');
    assert.match(result.stdout, /0\s+ready/);
    assert.match(result.stdout, /2\s+blocked/);
    assert.match(result.stdout, /1\s+incomplete/);
  });

  test('ready in human form: exit 0, the library Markdown on stdout, nothing written', async () => {
    const world = publishWorld();
    const result = runPublish(world, ['validate', ...destinationFlags(world)]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /1 inline comment/);
    assert.match(result.stdout, /repeats every check/i);
    assertNothingWritten(world);
    // Delegation: the human output is the library outcome's Markdown for the same input and remote.
    const direct = publishWorld();
    const validateSarifReview: unknown = Reflect.get(library, 'validateSarifReview');
    if (typeof validateSarifReview !== 'function') throw new AssertionError({ message: 'the package exports validateSarifReview' });
    const outcome = asRecord(
      await Reflect.apply(validateSarifReview, undefined, [
        { sarif: READY, destination: { ...REPOSITORY.destination }, reviewedCommit: REPOSITORY.commits.head, token: TOKEN },
        { createGitHubClient: createFakeClientFactory(direct.remote.dir) },
      ]),
      'the library outcome',
    );
    assert.equal(result.stdout, `${asString(outcome['markdown'])}\n`);
  });

  test('ready in JSON: exit 0 and { command, status, message } in that order', () => {
    const world = publishWorld();
    const result = runPublish(world, ['validate', ...destinationFlags(world), '--format', 'json']);
    assert.equal(result.status, 0, result.stdout);
    const doc = json(result);
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'message', 'diagnostics']);
    assert.equal(doc.command, 'validate');
    assert.equal(doc.status, 'ready');
    assertNothingWritten(world);
  });

  test('blocked in JSON: exit 2 with the problems and the message, nothing written', () => {
    const world = publishWorld(INVALID_PUBLICATION);
    const result = runPublish(world, ['validate', ...destinationFlags(world), '--format', 'json']);
    assert.equal(result.status, 2, result.stdout);
    const doc = json(result);
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'problems', 'message', 'diagnostics']);
    assert.equal(doc.status, 'blocked');
    const problems = asArray(doc.problems, 'problems');
    assert.ok(problems.length > 0);
    for (const problem of problems) assert.ok(asString(doc.message).includes(asString(asRecord(problem)['message'])));
    assertNothingWritten(world);
  });

  test('blocked in human form prints exactly what publish prints for the same input', () => {
    const assessed = publishWorld(INVALID_PUBLICATION);
    const validated = runPublish(assessed, ['validate', ...destinationFlags(assessed)]);
    const published = publishWorld(INVALID_PUBLICATION);
    const publication = runPublish(published, ['publish', ...destinationFlags(published), '--state', published.statePath]);
    assert.equal(validated.status, 2);
    assert.equal(publication.status, 2);
    assert.equal(validated.stdout, publication.stdout, 'the same blocked explanation');
    assert.equal(validated.stderr, publication.stderr, 'the same diagnostics');
    assert.match(validated.stderr, /^✖ error {2}The document is not valid SARIF 2\.1\.0 {2}\[sarif-schema-invalid\]\n/);
    assertNothingWritten(assessed);
  });

  test('an approval hold is blocked; --ignore-approval-hold makes it ready', () => {
    const held = asRecord(readJson(path.join(ROOT, 'test', 'fixtures', 'public-api', 'held.sarif.json')), 'held.sarif.json');
    const world = publishWorld(held);
    assert.equal(json(runPublish(world, ['validate', ...destinationFlags(world), '--format', 'json'])).status, 'blocked');
    const overridden = json(runPublish(world, ['validate', ...destinationFlags(world), '--ignore-approval-hold', '--format', 'json']));
    assert.equal(overridden.status, 'ready');
    assertNothingWritten(world);
  });

  test('incomplete in JSON: exit 1, the cause (redacted), and no verdict', () => {
    const world = publishWorld();
    setAdapterConfig(world.remote.dir, { context: 'throw-with-token' });
    const result = runPublish(world, ['validate', ...destinationFlags(world), '--format', 'json']);
    assert.equal(result.status, 1, result.stdout);
    const doc = json(result);
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'message', 'diagnostics']);
    assert.equal(doc.status, 'incomplete');
    assert.match(asString(doc.message), /\[redacted\]/);
    assert.match(asString(doc.message), /not a verdict/i);
    assertNothingWritten(world);
  });

  test('a source-read failure in human form: exit 1, what to do on stdout, the cause as a diagnostic on stderr', () => {
    const world = publishWorld();
    setAdapterConfig(world.remote.dir, { context: 'source-read-fails' });
    const result = runPublish(world, ['validate', ...destinationFlags(world)]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /502/, 'the cause is rendered once, on stderr');
    assert.match(result.stdout, /not a verdict/i);
    assert.match(result.stderr, /^✖ error {2}Readiness could not be assessed {2}\[assessment-incomplete\]\n[\s\S]*502/);
    assertNothingWritten(world);
  });

  test('--state is refused as a usage error before any request', () => {
    const world = publishWorld();
    const result = runPublish(world, ['validate', ...destinationFlags(world), '--state', world.statePath, '--format', 'json']);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.command, 'validate');
    assert.equal(doc.status, 'usage-error');
    assert.match(asString(doc.message), /unknown option --state/);
    assert.deepEqual(world.remote.calls('adapter:create'), []);
    assertNothingWritten(world);
  });

  test('a missing token is an error document naming the variables', () => {
    const world = publishWorld();
    const result = runPublish(world, ['validate', ...destinationFlags(world), '--format', 'json'], {});
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.status, 'error');
    assert.match(asString(doc.message), /GH_TOKEN/);
    assert.deepEqual(world.remote.calls('adapter:create'), []);
  });

  test('an unreadable SARIF file is an error, and nothing is contacted', () => {
    const world = publishWorld();
    fs.writeFileSync(world.sarifPath, '{ not json');
    const result = runPublish(world, ['validate', ...destinationFlags(world), '--format', 'json']);
    assert.equal(result.status, 1);
    assert.equal(json(result).status, 'error');
    assert.deepEqual(world.remote.calls('adapter:create'), []);
  });

  test('a later publish still checks: the pull request advanced after a ready assessment', () => {
    const world = publishWorld();
    assert.equal(json(runPublish(world, ['validate', ...destinationFlags(world), '--format', 'json'])).status, 'ready');
    setAdapterConfig(world.remote.dir, { context: 'wrong-commit' });
    const result = runPublish(world, ['publish', ...destinationFlags(world), '--state', world.statePath, '--format', 'json']);
    assert.equal(result.status, 1);
    assert.equal(json(result).status, 'error');
    assert.equal(world.remote.calls('adapter:fetchContext').length, 2, 'publication fetched the context itself');
    assert.deepEqual(world.remote.writeCalls(), []);
    assert.equal(fs.existsSync(world.statePath), false);
  });
});

describe('--submit: an explicitly submitted comment review (docs/submitted-review-contract.md)', () => {
  function flags(world: IPublishWorld): string[] {
    return [...destinationFlags(world), '--state', world.statePath];
  }

  test('publish --submit: one COMMENT create, exit 0, the submitted explanation in human form', () => {
    const world = publishWorld();
    const result = runPublish(world, ['publish', ...flags(world), '--submit']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    const creates = world.remote.calls('createReview');
    assert.equal(creates.length, 1);
    assert.equal(item(creates, 0).args['event'], 'COMMENT');
    const stored = item(world.remote.reviews(), 0);
    assert.equal(stored.state, 'COMMENTED');
    assert.match(result.stdout, /^## Review submitted\n\nCreated and submitted the comment \[review \d+\]\(/);
    assert.ok(result.stdout.includes(stored.htmlUrl));
  });

  test('publish --submit in JSON: the same document shape as a draft; exit 0', () => {
    const world = publishWorld();
    const doc = json(runPublish(world, ['publish', ...flags(world), '--submit', '--format', 'json']));
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'review', 'statePath', 'message', 'diagnostics']);
    assert.equal(doc.status, 'published');
    assert.match(asString(doc.message), /^## Review submitted\n/);
  });

  test('the flag-only publisher accepts --submit as well', () => {
    const world = publishWorld();
    const result = runPublish(world, [...flags(world), '--submit']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(item(world.remote.reviews(), 0).state, 'COMMENTED');
  });

  test('without --submit the request carries no event and the review stays a draft', () => {
    const world = publishWorld();
    const result = runPublish(world, ['publish', ...flags(world)]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Object.hasOwn(item(world.remote.calls('createReview'), 0).args, 'event'), false);
    assert.equal(item(world.remote.reviews(), 0).state, 'PENDING');
    assert.match(result.stdout, /^## Draft review published\n/);
  });

  test('retrying a draft state path with --submit is an operational error (exit 1) naming the mode; nothing is sent', () => {
    const world = publishWorld();
    assert.equal(runPublish(world, ['publish', ...flags(world)]).status, 0);
    const human = runPublish(world, ['publish', ...flags(world), '--submit']);
    assert.equal(human.status, 1);
    assert.equal(human.stdout, '');
    assert.match(human.stderr, /records a draft review, but a submitted review was requested/);
    const doc = json(runPublish(world, ['publish', ...flags(world), '--submit', '--format', 'json']));
    assert.equal(doc.status, 'error');
    assert.match(asString(doc.message), /records a draft review, but a submitted review was requested/);
    assert.equal(world.remote.calls('createReview').length, 1);
  });

  test('validate --submit: ready for a submitted comment review, nothing written; exit 0', () => {
    const world = publishWorld();
    const result = runPublish(world, ['validate', ...destinationFlags(world), '--submit']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, / as a submitted comment review\./);
    assert.deepEqual(world.remote.writeCalls(), []);
    assert.equal(fs.existsSync(world.statePath), false);
    const doc = json(runPublish(world, ['validate', ...destinationFlags(world), '--submit', '--format', 'json']));
    assert.equal(doc.status, 'ready');
  });

  for (const [command, extra] of [
    ['publish', ['--state', '/tmp/unused-state.json']],
    ['validate', []],
  ] as const) {
    test(`${command}: a valued or repeated --submit is a usage error (exit 1) with no request`, () => {
      const world = publishWorld();
      for (const bad of [['--submit=yes'], ['--submit', '--submit']]) {
        const result = runPublish(world, [command, ...destinationFlags(world), ...extra, ...bad]);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /--submit/);
      }
      assert.deepEqual(world.remote.calls(), []);
    });
  }
});
