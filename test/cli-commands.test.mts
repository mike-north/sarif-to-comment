'use strict';

/**
 * User-acceptance tests for the command CLI: `init`, `add-comment`,
 * `inspect`, `add-staged-changes` and `publish`, in human and JSON formats.
 *
 * Every test runs the real executable (bin/sarif-to-comment.cjs) in a child
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
 * refusal (`invalid` / `failed`); `publish` keeps 0/1/2/3.
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 * @see https://www.rfc-editor.org/rfc/rfc6901 (JSON Pointer, used for finding refs)
 * @see https://git-scm.com/docs/git-update-index (index versus working tree)
 */

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const library = require('../dist/index.cjs');
const { FakeGitHubRemote } = require('./fixtures/publication/fake-github.mts');
const { REPOSITORY, setAdapterConfig } = require('./fixtures/public-api/fake-adapter.mts');
const {
  ORACLE,
  UPSTREAM_SARIF_PATH,
  SENTINEL,
  createGitWorld,
  applyReplacements,
  replacementsFor,
  distinctReplacements,
} = require('./fixtures/authoring-workflow/git-world.mts');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'dist', 'sarif-to-comment.cjs');
const WRAPPER = path.join(ROOT, 'test', 'fixtures', 'public-api', 'cli-with-fake-github.mts');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SCHEMA_URI = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';
const COMMIT = 'c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de';
const TOKEN = 'ghp_COMMANDS_SENTINEL_token_value_2468013579';
const UPSTREAM = JSON.parse(fs.readFileSync(UPSTREAM_SARIF_PATH, 'utf8'));
const READY = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'public-api', 'ready.sarif.json'), 'utf8'));
const INVALID_PUBLICATION = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'public-api', 'invalid.sarif.json'), 'utf8'),
);
/** Valid JSON but not schema-valid SARIF: a run must have a tool (SARIF §3.14.6). */
const NOT_SARIF = { version: '2.1.0', runs: [{ results: [] }] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(label = 'commands') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`)));
}

/** Runs the real executable with only PATH (plus `env`) — never the developer's credentials. */
function run(argv, { cwd = ROOT, env = {}, input } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...argv], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env.PATH, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** stdout must be exactly one JSON document, with nothing on stderr (§6.2). */
function json(result) {
  assert.equal(result.stderr, '', `JSON mode wrote to stderr: ${result.stderr}`);
  assert.ok(result.stdout.endsWith('\n'), 'the document ends with a newline');
  let doc;
  assert.doesNotThrow(() => {
    doc = JSON.parse(result.stdout);
  }, `stdout is not one JSON document: ${result.stdout}`);
  assert.equal(typeof doc, 'object');
  return doc;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const bytesOf = (file) => fs.readFileSync(file);
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** A new SARIF file created through `init` (JSON mode), bound or not. */
function initFile(dir, name = 'review.sarif', extra = []) {
  const output = path.join(dir, name);
  const result = run(['init', '--output', output, '--format', 'json', ...extra]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return output;
}

/** The archive name §6.4 requires for a file, from its birth time (or modification time). */
function expectedArchiveStamp(file) {
  const stat = fs.statSync(file);
  const birth = stat.birthtimeMs > 0;
  const stamp = new Date(birth ? stat.birthtimeMs : stat.mtimeMs).toISOString().replace(/:/g, '-');
  return { stamp, timeSource: birth ? 'birth' : 'modified' };
}

/** Files in `dir` other than those listed. */
function othersIn(dir, known) {
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
    for (const command of ['init', 'add-comment', 'inspect', 'add-staged-changes', 'publish']) {
      assert.match(result.stdout, new RegExp(`\\b${command}\\b`), `help omits ${command}`);
    }
    assert.match(result.stdout, /--format human\|json/);
    assert.match(result.stdout, /--sarif FILE --repo OWNER\/REPO --pull N --commit FULLSHA/);
  });

  for (const [command, flags] of [
    ['init', ['--output', '--tool-name', '--tool-version', '--repo', '--commit', '--format']],
    [
      'add-comment',
      ['--sarif', '--file', '--line', '--end-line', '--message', '--message-file', '--markdown', '--rule-id', '--level', '--run', '--new-run-tool', '--new-run-tool-version', '--repo', '--commit', '--format'],
    ],
    ['inspect', ['--sarif', '--preview-lines', '--preview-chars', '--source-root', '--format']],
    ['add-staged-changes', ['--sarif', '--output', '--worktree', '--repo', '--commit', '--source-root', '--format']],
    ['publish', ['--sarif', '--repo', '--pull', '--commit', '--state', '--source-root', '--old-source-commit', '--ignore-approval-hold', '--format']],
  ]) {
    test(`${command} --help documents its options and needs no token`, () => {
      const result = run([command, '--help']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      for (const flag of flags) assert.ok(result.stdout.includes(flag), `${command} help omits ${flag}`);
    });
  }

  test('the staged command says what it does and does not do', () => {
    const result = run(['add-staged-changes', '--help']);
    assert.match(result.stdout, /Add proposed changes from the Git index to a SARIF document\./);
  });

  test('help in JSON mode is one document carrying the usage text', () => {
    const doc = json(run(['inspect', '--help', '--format', 'json']));
    assert.equal(doc.command, 'inspect');
    assert.equal(doc.status, 'help');
    assert.match(doc.usage, /--preview-lines/);
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
    assert.deepEqual(Object.keys(doc).sort(), ['command', 'message', 'status', 'usage']);
    assert.equal(doc.command, null);
    assert.equal(doc.status, 'usage-error');
    assert.match(doc.message, /unknown command frobnicate/);
  });

  test('a JSON usage error for a known command names the command and its usage', () => {
    const doc = json(run(['init', '--format', 'json']));
    assert.equal(doc.command, 'init');
    assert.equal(doc.status, 'usage-error');
    assert.match(doc.message, /--output/);
    assert.match(doc.usage, /init --output FILE/);
  });
});

describe('JSON documents: the envelope comes first and field order is stable', () => {
  // Module doc (src/cli.cjs): "The envelope is { command, status, ... }".
  // The remaining order of each document is the contract's listing where it
  // gives one (§3.1, §3.2, §3.5) and otherwise characterization of 0.2.0;
  // JSON output is read by people and diffed by scripts, so it must not
  // drift with a change of implementation language.
  test('help, unknown-command and usage-error documents', () => {
    assert.deepEqual(Object.keys(json(run(['inspect', '--help', '--format', 'json']))), ['command', 'status', 'usage']);
    assert.deepEqual(Object.keys(json(run(['frobnicate', '--format', 'json']))), ['command', 'status', 'message', 'usage']);
    assert.deepEqual(Object.keys(json(run(['init', '--format', 'json']))), ['command', 'status', 'message', 'usage']);
  });

  test('init prints exactly the two-space indented receipt and writes the document in contract order', () => {
    const dir = tempDir('init-bytes');
    const output = path.join(dir, 'review.sarif');
    const result = run(['init', '--output', output, '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      `{\n  "command": "init",\n  "status": "created",\n  "output": {\n    "path": ${JSON.stringify(output)},\n    "written": true\n  },\n  "runIndex": 0\n}\n`,
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
  const cases = [
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
    assert.deepEqual(doc, { command: 'init', status: 'created', output: { path: output, written: true }, runIndex: 0 });
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
    assert.deepEqual(readJson(output).runs[0].tool, { driver: { name: 'Review agent', version: '3.1.4' } });
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
    assert.equal(doc.output.path, path.join(dir, 'relative.sarif'));
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
    assert.ok(doc.message.includes(output));
    assert.deepEqual(doc.output, { path: output, written: false });
    assert.equal(fs.readFileSync(output, 'utf8'), 'precious');
    assert.deepEqual(fs.readdirSync(dir), ['review.sarif'], 'no temporary file is left behind');
  });

  for (const [label, extra, mention] of [
    ['--repo without --commit', ['--repo', 'acme/widgets'], '--commit'],
    ['--commit without --repo', ['--commit', COMMIT], '--repo'],
    ['an abbreviated commit', ['--repo', 'acme/widgets', '--commit', 'c0dec0d'], '--commit'],
    ['a malformed repository', ['--repo', 'acme', '--commit', COMMIT], '--repo'],
    ['--tool-version without --tool-name', ['--tool-version', '1.0.0'], '--tool-name'],
    ['an unknown option', ['--frobnicate', 'x'], '--frobnicate'],
    ['a positional argument', ['stray'], 'stray'],
  ]) {
    test(`usage error: ${label}`, () => {
      const dir = tempDir('init-usage');
      const output = path.join(dir, 'review.sarif');
      const doc = json(run(['init', '--output', output, ...extra, '--format', 'json']));
      assert.equal(doc.status, 'usage-error');
      assert.ok(doc.message.includes(mention), doc.message);
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
    const before = readJson(file);
    const doc = json(
      run(['add-comment', '--sarif', file, '--file', 'src/parse.js', '--line', '2', '--message', 'Handle the empty-input case.', '--format', 'json']),
    );
    assert.deepEqual(doc, {
      command: 'add-comment',
      status: 'added',
      sarif: { path: file, written: true },
      finding: { ref: '/runs/0/results/0', path: 'src/parse.js', line: 2, endLine: 2, tool: 'Review agent' },
    });
    const after = readJson(file);
    assert.deepEqual(after.runs[0].results, [
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
    const before = readJson(file);
    const comment = { file: 'src/parse.js', line: 2, endLine: 3, message: 'Guard it.', ruleId: 'R1', level: 'warning' };
    const doc = json(run([
      'add-comment', '--sarif', file, '--file', comment.file, '--line', '2', '--end-line', '3', '--message', comment.message,
      '--rule-id', comment.ruleId, '--level', comment.level, '--format', 'json',
    ]));
    assert.equal(doc.status, 'added', JSON.stringify(doc));
    // §3.2: { command, status: "added", sarif: { path, written: true }, finding: { ref, path, line, endLine, tool } }
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'sarif', 'finding']);
    assert.deepEqual(Object.keys(doc.sarif), ['path', 'written']);
    assert.deepEqual(Object.keys(doc.finding), ['ref', 'path', 'line', 'endLine', 'tool']);
    const expected = library.addSarifComment(before, comment);
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(expected.sarif, null, 2)}\n`);
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
    assert.deepEqual(readJson(file).runs[0].results[0], {
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
    const results = readJson(file).runs[0].results;
    assert.equal(results[0].message.text, text);
    assert.equal(results[1].message.text, text);
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
    assert.match(doc.message, /UTF-8/);
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
    assert.deepEqual(after.runs[0], UPSTREAM.runs[0], 'the upstream run is unchanged');
    assert.deepEqual(after.properties, UPSTREAM.properties);
    assert.deepEqual(after.runs[1].tool, { driver: { name: 'Reviewer', version: '2.0.0' } });
    assert.equal(after.runs[1].results[0].message.text, 'Reviewer note.');
  });

  test('several runs without a selection is a usage error; the file is untouched', () => {
    const dir = tempDir('comment-ambiguous');
    const file = path.join(dir, 'two-runs.sarif');
    const twoRuns = library.createSarifDocument();
    twoRuns.runs.push(structuredClone(twoRuns.runs[0]));
    writeJson(file, twoRuns);
    const before = bytesOf(file);
    const result = run(['add-comment', '--sarif', file, '--file', 'a.txt', '--line', '1', '--message', 'x', '--format', 'json']);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.status, 'usage-error');
    assert.match(doc.message, /run/);
    assert.deepEqual(bytesOf(file), before);

    const chosen = json(run(['add-comment', '--sarif', file, '--file', 'a.txt', '--line', '1', '--message', 'x', '--run', '1', '--format', 'json']));
    assert.equal(chosen.finding.ref, '/runs/1/results/0');
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
    for (const problem of doc.problems) assert.equal(typeof problem.message, 'string');
    const expected = library.addSarifComment(NOT_SARIF, { file: 'a.txt', line: 1, message: 'x' });
    assert.deepEqual(doc.problems, expected.problems, 'the CLI reports the library problems');
    assert.deepEqual(bytesOf(file), before);

    const human = run(['add-comment', '--sarif', file, '--file', 'a.txt', '--line', '1', '--message', 'x']);
    assert.equal(human.status, 2);
    assert.ok(human.stdout.includes(expected.problems[0].message.split('\n')[0]), human.stdout);
  });

  for (const [label, args, mention] of [
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
  ]) {
    test(`usage error: ${label}`, () => {
      const dir = tempDir('comment-usage');
      const file = initFile(dir);
      const before = bytesOf(file);
      const result = run(['add-comment', '--sarif', file, ...args, '--format', 'json']);
      assert.equal(result.status, 1, result.stdout);
      const doc = json(result);
      assert.equal(doc.status, 'usage-error');
      assert.ok(doc.message.includes(mention), doc.message);
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
    assert.ok(doc.message.includes(file));
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('a symbolic link is followed: the target is edited and the link survives', () => {
    const dir = tempDir('comment-link');
    const target = initFile(dir, 'real.sarif');
    const link = path.join(dir, 'link.sarif');
    fs.symlinkSync(target, link);
    json(run(['add-comment', '--sarif', link, '--file', 'a.txt', '--line', '1', '--message', 'x', '--format', 'json']));
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(readJson(target).runs[0].results.length, 1);
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
    assert.ok(doc.message.includes(marker), 'the refusal names the marker so a stale one can be removed deliberately');
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
// inspect (§3.3)
// ---------------------------------------------------------------------------

describe('inspect', () => {
  /** SARIF with a long multi-line fix, a general finding and a second run. */
  function inspectionInput() {
    const sarif = library.createSarifDocument({ tool: { name: 'Review agent' } });
    const inserted = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join('');
    sarif.runs[0].results.push(
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
    assert.deepEqual(Object.keys(doc).sort(), ['command', 'status', 'view']);
    assert.equal(doc.command, 'inspect');
    assert.equal(doc.status, 'inspected');
    const expected = library.inspectSarif(sarif, { previewLines: 5 });
    assert.equal(expected.status, 'inspected');
    assert.deepEqual(doc.view, expected.view);
    // Independent content checks (§3.3): full messages, every run, truncated preview counts.
    assert.equal(doc.view.format, 'sarif-to-comment.inspection');
    assert.equal(doc.view.findings.length, 3);
    assert.equal(doc.view.findings[0].message.text, 'Rewrite this block.\nIt is long.');
    const preview = doc.view.findings[0].fixes[0].changes[0].replacements[0].inserted;
    assert.equal(preview.state, 'truncated');
    assert.equal(preview.totalLines, 30);
    assert.equal(preview.shownLines, 5);
    assert.equal(preview.text, 'line 1\nline 2\nline 3\nline 4\nline 5\n');
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
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'view']);
    // Field order of the view itself is pinned against the contract in
    // test/sarif-inspection.test.cjs; here the CLI must not reorder it.
    assert.equal(JSON.stringify(doc.view), JSON.stringify(library.inspectSarif(sarif).view));
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
    const preview = doc.view.findings[0].fixes[0].changes[0].replacements[0].inserted;
    assert.equal(preview.state, 'complete');
    assert.equal(preview.text, inserted);
    assert.deepEqual(doc.view, library.inspectSarif(sarif, { previewLines: null, previewChars: null }).view);
  });

  test('upstream SARIF is inspected without initialization', () => {
    const doc = json(run(['inspect', '--sarif', UPSTREAM_SARIF_PATH, '--format', 'json']));
    assert.equal(doc.status, 'inspected');
    assert.deepEqual(
      doc.view.findings.map((f) => [f.ref, f.ruleId, f.level, f.message.text]),
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
    const sarif = readJson(file);
    const doc = json(run(['inspect', '--sarif', file, '--format', 'json']));
    assert.deepEqual(doc.view, library.inspectSarif(sarif).view);
    assert.deepEqual(doc.view.log, { otherContent: { properties: sarif.properties } });
    assert.equal(doc.view.externalProperties.length, sarif.inlineExternalProperties.length);
    assert.equal(doc.view.summary.externalFindings, sarif.inlineExternalProperties.reduce((n, e) => n + (e.results ?? []).length, 0));
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
    assert.deepEqual(doc.problems, library.inspectSarif(NOT_SARIF).problems);
  });

  for (const [label, extra, mention] of [
    ['a negative preview limit', ['--preview-lines', '-1'], '--preview-lines'],
    ['a non-numeric preview limit', ['--preview-chars', 'lots'], '--preview-chars'],
    ['a relative source root', ['--source-root', 'work/'], '--source-root'],
  ]) {
    test(`usage error: ${label}`, () => {
      const doc = json(run(['inspect', '--sarif', UPSTREAM_SARIF_PATH, ...extra, '--format', 'json']));
      assert.equal(doc.status, 'usage-error');
      assert.ok(doc.message.includes(mention), doc.message);
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
  function stagedArgs(world, input, output, extra = []) {
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
    const [a, b] = enriched.runs[0].results;
    assert.equal(a.message.text, ORACLE.findings[0].message);
    assert.equal(b.message.text, ORACLE.findings[1].message);
    assert.deepEqual(a.properties, UPSTREAM.runs[0].results[0].properties);
    assert.deepEqual(enriched.runs[0].tool, UPSTREAM.runs[0].tool);
    assert.equal(applyReplacements(ORACLE.reviewed, replacementsFor({ runs: [{ results: [a] }] }, ORACLE.path)).split('\n')[1], 'corrected two');
    assert.deepEqual(enriched.runs[0].versionControlProvenance, [
      { repositoryUri: `https://github.com/${world.repository.destination.owner}/${world.repository.destination.repo}`, revisionId: world.head },
    ]);
    assert.deepEqual(doc.receipt.changes, [
      {
        path: ORACLE.path,
        operation: 'edit',
        replacements: [
          { startLine: 2, endLine: 2, associated: ['/runs/0/results/0'], explainedBy: 'finding' },
          { startLine: 5, endLine: 6, associated: ['/runs/0/results/1'], explainedBy: 'finding' },
        ],
      },
    ]);
    assert.deepEqual(doc.receipt.boundRuns, [0]);
    assert.equal(doc.receipt.addedRun, null);

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
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'output', 'archived', 'receipt']);
    assert.deepEqual(Object.keys(doc.output), ['path', 'written']);
    const outcome = await library.addStagedChangesToSarif({
      sarif: UPSTREAM,
      worktree: world.dir,
      reviewedCommit: world.head,
      repository: { owner: world.repository.destination.owner, repo: world.repository.destination.repo },
    });
    assert.equal(JSON.stringify(doc.receipt), JSON.stringify(outcome.receipt));
    assert.equal(fs.readFileSync(output, 'utf8'), `${JSON.stringify(outcome.sarif, null, 2)}\n`, 'two-space JSON with a final newline');
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
    assert.equal(doc.archived.path, path.join(out, `${stamp}-2.old.enriched.sarif`));
    assert.equal(fs.readFileSync(path.join(out, `${stamp}.old.enriched.sarif`), 'utf8'), 'older archive');
    assert.equal(fs.readFileSync(doc.archived.path, 'utf8'), 'previous output');
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
    assert.ok(doc.problems.some((p) => p.path === ORACLE.path || p.message.includes(ORACLE.path)), 'the failure names the path');
    assert.equal(fs.existsSync(output), false, 'no normal output after a failure');
    assert.deepEqual(othersIn(out, []), [`${stamp}.old.enriched.sarif`], 'no error artifact and no temporary file');

    const human = run(stagedArgs(world, UPSTREAM_SARIF_PATH, output));
    assert.equal(human.status, 2);
    assert.ok(human.stdout.includes(ORACLE.path));
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
    assert.ok(doc.problems.length > 0);
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
    assert.equal(doc.archived.from, output);
    assert.equal(fs.existsSync(output), false);
  });

  test('usage errors move and write nothing, even with an existing output', () => {
    const world = createGitWorld('staged-usage');
    const out = tempDir('staged-usage-out');
    const output = path.join(out, 'enriched.sarif');
    fs.writeFileSync(output, 'previous output');
    const cases = [
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
      assert.ok(doc.message.includes(mention), doc.message);
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
    assert.match(doc.message, /same file/);
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
    assert.ok(doc.message.includes(marker));
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
      receipt.changes[0].replacements.map((r) => [r.insertion, r.startLine, r.endLine, r.associated, r.explainedBy]),
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
    assert.deepEqual(doc.receipt.changes, []);
    assert.deepEqual(readJson(output), UPSTREAM);
  });
});

// ---------------------------------------------------------------------------
// publish (§3.5)
// ---------------------------------------------------------------------------

describe('publish', () => {
  function publishWorld(sarif = READY, hostConfig = {}) {
    const root = tempDir('publish');
    const remote = FakeGitHubRemote.create(path.join(root, 'remote'), hostConfig);
    const sarifPath = path.join(root, 'input.sarif.json');
    writeJson(sarifPath, sarif);
    return { root, remote, sarifPath, statePath: path.join(root, 'review.publication.json') };
  }

  function flags(world) {
    const { owner, repo, pullNumber } = REPOSITORY.destination;
    return ['--sarif', world.sarifPath, '--repo', `${owner}/${repo}`, '--pull', String(pullNumber), '--commit', REPOSITORY.commits.head, '--state', world.statePath];
  }

  function runPublish(world, argv, env = { GH_TOKEN: TOKEN }) {
    const result = spawnSync(process.execPath, [WRAPPER, ...argv], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH, FAKE_GITHUB_DIR: world.remote.dir, ...env },
    });
    for (const text of [result.stdout, result.stderr]) assert.equal(text.includes(TOKEN), false, 'the token never appears');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  const normalize = (text, world) => text.split(world.statePath).join('<STATE>');

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
    const [stored] = world.remote.reviews();
    assert.deepEqual(Object.keys(doc).sort(), ['command', 'message', 'review', 'statePath', 'status']);
    assert.equal(doc.command, 'publish');
    assert.equal(doc.status, 'published');
    assert.equal(doc.statePath, world.statePath);
    assert.equal(doc.review.url, stored.htmlUrl);
    assert.equal(typeof doc.review.id, 'number');
    assert.ok(doc.message.includes(stored.htmlUrl));

    const again = json(runPublish(world, ['publish', ...flags(world), '--format', 'json']));
    assert.deepEqual(again.review, doc.review, 'the retry reports the recorded receipt');
    assert.equal(world.remote.calls('createReview').length, 1);
  });

  test('published, blocked and error documents keep the contract field order', () => {
    // §3.5: { command: "publish", status, review?: { id, url }, statePath?, message }
    const published = publishWorld();
    const doc = json(runPublish(published, ['publish', ...flags(published), '--format', 'json']));
    assert.equal(doc.status, 'published');
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'review', 'statePath', 'message']);
    assert.deepEqual(Object.keys(doc.review), ['id', 'url']);

    const blocked = publishWorld(INVALID_PUBLICATION);
    const blockedDoc = json(runPublish(blocked, ['publish', ...flags(blocked), '--format', 'json']));
    assert.equal(blockedDoc.status, 'blocked');
    assert.deepEqual(Object.keys(blockedDoc), ['command', 'status', 'message']);

    const noToken = publishWorld();
    const errorDoc = json(runPublish(noToken, ['publish', ...flags(noToken), '--format', 'json'], {}));
    assert.equal(errorDoc.status, 'error');
    assert.deepEqual(Object.keys(errorDoc), ['command', 'status', 'message']);
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
    assert.deepEqual(Object.keys(doc).sort(), ['command', 'message', 'status']);
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
    assert.match(doc.message, /same state path/i);
    assert.ok(fs.existsSync(world.statePath));
  });

  test('a missing token in JSON is an error document naming the variables', () => {
    const world = publishWorld();
    const result = runPublish(world, ['publish', ...flags(world), '--format', 'json'], {});
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.status, 'error');
    assert.match(doc.message, /GH_TOKEN/);
  });

  test('a usage error in JSON names publish and makes no request', () => {
    const world = publishWorld();
    const result = runPublish(world, ['publish', '--sarif', world.sarifPath, '--format', 'json']);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.command, 'publish');
    assert.equal(doc.status, 'usage-error');
    assert.match(doc.message, /missing required option/);
    assert.deepEqual(world.remote.calls('adapter:create'), []);
  });

  test('an operational failure mentioning the token is redacted in JSON', () => {
    const world = publishWorld();
    setAdapterConfig(world.remote.dir, { context: 'throw-with-token' });
    const result = runPublish(world, ['publish', ...flags(world), '--format', 'json']);
    assert.equal(result.status, 1);
    const doc = json(result);
    assert.equal(doc.status, 'error');
    assert.match(doc.message, /\[redacted\]/);
  });
});
