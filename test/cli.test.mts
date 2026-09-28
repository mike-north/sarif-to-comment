'use strict';

/**
 * User-acceptance tests for the thin CLI (bin/sarif-to-comment.cjs).
 *
 * Each test runs the real CLI entry point in a child process through
 * test/fixtures/public-api/cli-with-fake-github.mts, which injects only the
 * GitHub adapter (a file-backed host double shared with the parent through
 * FAKE_GITHUB_DIR). Parsing, file reading, credential selection, the library
 * call, Markdown output and exit status are the real CLI's. Delegation to the
 * library is checked by comparing CLI output and sent requests with an
 * in-process publishSarifReview run on an identical fresh host.
 *
 * Exit status contract: 0 published, 2 blocked, 3 uncertain, 1 usage error,
 * unreadable input file, operational failure, state refusal or host rejection.
 * No test needs a network or a localhost server; none establishes real GitHub
 * behavior.
 *
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://cli.github.com/manual/gh_help_environment (GH_TOKEN / GITHUB_TOKEN precedence)
 * @see https://www.rfc-editor.org/rfc/rfc8089 (file URI scheme)
 * @see https://www.rfc-editor.org/rfc/rfc8259#section-8.1 (JSON text is UTF-8; a parser MAY ignore a BOM)
 * @see https://encoding.spec.whatwg.org/#utf-8-decode (BOM handling and fatal decoding)
 */

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { publishSarifReview } = require('../dist/index.cjs');
const { FakeGitHubRemote } = require('./fixtures/publication/fake-github.mts');
const {
  REPOSITORY,
  createFakeClientFactory,
  setAdapterConfig,
} = require('./fixtures/public-api/fake-adapter.mts');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'public-api');
const WRAPPER = path.join(FIXTURE_DIR, 'cli-with-fake-github.mts');
const loadSarif = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
const READY = loadSarif('ready.sarif.json');
const HELD = loadSarif('held.sarif.json');
const INVALID = loadSarif('invalid.sarif.json');

const HEAD = REPOSITORY.commits.head;
const BASE = REPOSITORY.commits.base;
const REPO_FLAG = `${REPOSITORY.destination.owner}/${REPOSITORY.destination.repo}`;
const PULL_FLAG = String(REPOSITORY.destination.pullNumber);
const TOKEN = 'ghp_CLI_SENTINEL_token_value_9876543210';
const OTHER_TOKEN = 'ghp_CLI_SECONDARY_token_value_1357924680';
const FLAGS = [
  '--sarif',
  '--repo',
  '--pull',
  '--commit',
  '--state',
  '--source-root',
  '--old-source-commit',
  '--ignore-approval-hold',
];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function expectedInputFingerprint(sarif, { sourceRootUri = null, oldSourceCommit = null } = {}) {
  const identity = { format: 'sarif-to-comment.input', version: 1, sarif, sourceRootUri, oldSourceCommit };
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// World and child-process helpers
// ---------------------------------------------------------------------------

function makeWorld(hostConfig = {}, sarif = READY) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  const remote = FakeGitHubRemote.create(path.join(root, 'remote'), hostConfig);
  const sarifPath = path.join(root, 'input.sarif.json');
  fs.writeFileSync(sarifPath, JSON.stringify(sarif, null, 2));
  return { root, stateDir, statePath: path.join(stateDir, 'review.publication.json'), remote, sarifPath };
}

function standardArgs(world, overrides = {}) {
  const values = {
    '--sarif': world.sarifPath,
    '--repo': REPO_FLAG,
    '--pull': PULL_FLAG,
    '--commit': HEAD,
    '--state': world.statePath,
    ...overrides,
  };
  return Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .flatMap(([flag, v]) => [flag, v]);
}

/**
 * Runs the CLI wrapper with a controlled environment: only PATH, the fake
 * remote location and explicitly supplied variables (never the developer's
 * own GitHub credentials).
 */
function runCli(world, argv, env = { GH_TOKEN: TOKEN }) {
  const result = spawnSync(process.execPath, [WRAPPER, ...argv], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH, FAKE_GITHUB_DIR: world.remote.dir, ...env },
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

function adapterCreated(world) {
  return world.remote.calls('adapter:create');
}

function stateFiles(world) {
  return fs.readdirSync(world.stateDir);
}

function assertNoToken(world, run) {
  for (const [name, text] of [
    ['stdout', run.stdout],
    ['stderr', run.stderr],
    ...stateFiles(world).map((f) => [f, fs.readFileSync(path.join(world.stateDir, f), 'utf8')]),
  ]) {
    assert.equal(text.includes(TOKEN), false, `token appeared in ${name}`);
    assert.equal(text.includes(OTHER_TOKEN), false, `secondary token appeared in ${name}`);
  }
}

/** The same operation through the library, on a fresh identical host. */
async function libraryOutcome(sarif, { hostConfig = {}, options, sourceRootUri, oldSourceCommit } = {}) {
  const world = makeWorld(hostConfig, sarif);
  const input = {
    sarif: structuredClone(sarif),
    destination: { ...REPOSITORY.destination },
    reviewedCommit: HEAD,
    statePath: world.statePath,
    token: TOKEN,
  };
  if (options) input.options = options;
  if (sourceRootUri) input.sourceRootUri = sourceRootUri;
  if (oldSourceCommit) input.oldSourceCommit = oldSourceCommit;
  const outcome = await publishSarifReview(input, { createGitHubClient: createFakeClientFactory(world.remote.dir) });
  return { world, outcome };
}

function withoutStatePath(markdown, statePath) {
  return markdown.split(statePath).join('<STATE>');
}

// ===========================================================================
// Tests
// ===========================================================================

describe('help needs no token and no network', () => {
  test('--help documents every flag, the credential variables and exit statuses', () => {
    const world = makeWorld();
    const run = runCli(world, ['--help'], {});
    assert.equal(run.status, 0, run.stderr);
    for (const flag of FLAGS) assert.ok(run.stdout.includes(flag), `help omits ${flag}`);
    assert.ok(run.stdout.includes('GH_TOKEN'));
    assert.ok(run.stdout.includes('GITHUB_TOKEN'));
    for (const code of ['0', '1', '2', '3']) assert.match(run.stdout, new RegExp(`\\b${code}\\b`));
    assert.equal(run.stdout.includes('--token'), false, 'there is no token flag');
    assert.equal(run.stderr, '');
    assert.deepEqual(adapterCreated(world), []);
    assert.deepEqual(world.remote.calls(), []);
  });
});

describe('usage errors are exact, actionable and make no remote call', () => {
  const cases = [
    ['unknown flag', (w) => [...standardArgs(w), '--bogus', 'x'], '--bogus'],
    ['token flag is not supported', (w) => [...standardArgs(w), '--token', TOKEN], '--token'],
    ['missing --sarif', (w) => standardArgs(w, { '--sarif': undefined }), '--sarif'],
    ['missing --repo', (w) => standardArgs(w, { '--repo': undefined }), '--repo'],
    ['missing --pull', (w) => standardArgs(w, { '--pull': undefined }), '--pull'],
    ['missing --commit', (w) => standardArgs(w, { '--commit': undefined }), '--commit'],
    ['missing --state', (w) => standardArgs(w, { '--state': undefined }), '--state'],
    ['duplicate --pull', (w) => [...standardArgs(w), '--pull', PULL_FLAG], '--pull'],
    ['conflicting duplicate --state', (w) => [...standardArgs(w), `--state=${w.statePath}.other`], '--state'],
    ['positional argument', (w) => [...standardArgs(w), 'extra-argument'], 'extra-argument'],
    ['flag without a value', (w) => [...standardArgs(w, { '--state': undefined }), '--state'], '--state'],
    ['non-numeric pull', (w) => standardArgs(w, { '--pull': 'seven' }), '--pull'],
    ['zero pull', (w) => standardArgs(w, { '--pull': '0' }), '--pull'],
    ['repo without owner', (w) => standardArgs(w, { '--repo': 'gizmos' }), '--repo'],
    ['repo with extra segment', (w) => standardArgs(w, { '--repo': 'acme/gizmos/extra' }), '--repo'],
    ['abbreviated commit', (w) => standardArgs(w, { '--commit': HEAD.slice(0, 12) }), '--commit'],
    ['relative state path', (w) => standardArgs(w, { '--state': 'state/review.json' }), '--state'],
    ['non-file source root', (w) => [...standardArgs(w), '--source-root', 'https://example.com/gizmos/'], '--source-root'],
    ['valued boolean flag', (w) => [...standardArgs(w), '--ignore-approval-hold=yes'], '--ignore-approval-hold'],
    ['abbreviated old-source commit', (w) => [...standardArgs(w), '--old-source-commit', BASE.slice(0, 7)], '--old-source-commit'],
    ['duplicate boolean flag', (w) => [...standardArgs(w), '--ignore-approval-hold', '--ignore-approval-hold'], '--ignore-approval-hold'],
    ['unknown flag alone', () => ['--bogus'], '--bogus'],
  ];

  for (const [label, argv, mention] of cases) {
    test(`${label}: exit 1, names ${mention}`, () => {
      const world = makeWorld();
      const run = runCli(world, argv(world));
      assert.equal(run.status, 1, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
      assert.ok(run.stderr.includes(mention), `stderr must name ${mention}: ${run.stderr}`);
      assert.equal(run.stdout, '');
      assert.deepEqual(adapterCreated(world), []);
      assert.deepEqual(stateFiles(world), []);
      assertNoToken(world, run);
    });
  }

  test('missing credentials name both supported variables and make no remote call', () => {
    const world = makeWorld();
    const run = runCli(world, standardArgs(world), { GH_TOKEN: '', GITHUB_TOKEN: '' });
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes('GH_TOKEN'));
    assert.ok(run.stderr.includes('GITHUB_TOKEN'));
    assert.deepEqual(adapterCreated(world), []);
  });

  test('an unreadable SARIF file is an input error naming the file', () => {
    const world = makeWorld();
    const missing = path.join(world.root, 'absent.sarif.json');
    const run = runCli(world, standardArgs(world, { '--sarif': missing }));
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes(missing));
    assert.deepEqual(adapterCreated(world), []);
  });

  test('an unparsable SARIF file is an input error naming the file', () => {
    const world = makeWorld();
    fs.writeFileSync(world.sarifPath, '{"version": "2.1.0", "runs": [');
    const run = runCli(world, standardArgs(world));
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes(world.sarifPath));
    assert.deepEqual(adapterCreated(world), []);
    assert.deepEqual(stateFiles(world), []);
  });
});

describe('outcomes delegate to the library and map to exit statuses', () => {
  test('published: exit 0 with the library Markdown and the same single request', async () => {
    const world = makeWorld();
    const run = runCli(world, standardArgs(world));
    assert.equal(run.status, 0, run.stderr);
    const creates = world.remote.calls('createReview');
    assert.equal(creates.length, 1);
    const [stored] = world.remote.reviews();
    assert.ok(run.stdout.includes(stored.htmlUrl));

    const library = await libraryOutcome(READY);
    assert.equal(library.outcome.status, 'published');
    assert.equal(
      withoutStatePath(run.stdout.trimEnd(), world.statePath),
      withoutStatePath(library.outcome.markdown.trimEnd(), library.world.statePath),
    );
    const [libraryCreate] = library.world.remote.calls('createReview');
    assert.deepEqual(creates[0].args.comments, libraryCreate.args.comments);
    const strip = (body) => body.replace(/<!-- sarif-to-comment:review:[0-9a-f-]{36} -->$/, '');
    assert.equal(strip(creates[0].args.body), strip(libraryCreate.args.body));
    assert.equal(creates[0].args.commitId, HEAD);
    assertNoToken(world, run);
  });

  test('--flag=value forms are accepted', () => {
    const world = makeWorld();
    const run = runCli(world, [
      `--sarif=${world.sarifPath}`,
      `--repo=${REPO_FLAG}`,
      `--pull=${PULL_FLAG}`,
      `--commit=${HEAD}`,
      `--state=${world.statePath}`,
    ]);
    assert.equal(run.status, 0, run.stderr);
  });

  test('--source-root reaches the library identity', () => {
    const world = makeWorld();
    const sourceRootUri = 'file:///work/gizmos/';
    const run = runCli(world, [...standardArgs(world), '--source-root', sourceRootUri]);
    assert.equal(run.status, 0, run.stderr);
    const record = JSON.parse(fs.readFileSync(world.statePath, 'utf8'));
    assert.equal(record.inputFingerprint, expectedInputFingerprint(READY, { sourceRootUri }));
  });

  test('--old-source-commit is a candidate passed to GitHub and part of the identity, like the library', async () => {
    const world = makeWorld();
    const run = runCli(world, [...standardArgs(world), '--old-source-commit', BASE]);
    assert.equal(run.status, 0, run.stderr);
    const [fetch] = world.remote.calls('adapter:fetchContext');
    assert.equal(fetch.args.oldSourceCommit, BASE);
    const record = JSON.parse(fs.readFileSync(world.statePath, 'utf8'));
    assert.equal(record.inputFingerprint, expectedInputFingerprint(READY, { oldSourceCommit: BASE }));

    const library = await libraryOutcome(READY, { oldSourceCommit: BASE });
    assert.equal(
      withoutStatePath(run.stdout.trimEnd(), world.statePath),
      withoutStatePath(library.outcome.markdown.trimEnd(), library.world.statePath),
    );

    const changed = runCli(world, standardArgs(world));
    assert.equal(changed.status, 1, 'dropping the candidate changes the identity under the same state path');
    assert.ok(changed.stderr.includes(world.statePath));
    assert.equal(world.remote.calls('createReview').length, 1);
  });

  test('blocked: exit 2 with the library Markdown, no remote write and no state', async () => {
    const world = makeWorld({}, INVALID);
    const run = runCli(world, standardArgs(world));
    assert.equal(run.status, 2, run.stderr);
    const library = await libraryOutcome(INVALID);
    assert.equal(library.outcome.status, 'blocked');
    assert.equal(run.stdout.trimEnd(), library.outcome.markdown.trimEnd());
    assert.deepEqual(world.remote.writeCalls(), []);
    assert.deepEqual(stateFiles(world), []);
  });

  test('approval hold: exit 2; --ignore-approval-hold publishes with exit 0', () => {
    const held = makeWorld({}, HELD);
    const blocked = runCli(held, standardArgs(held));
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.deepEqual(held.remote.writeCalls(), []);

    const overridden = makeWorld({}, HELD);
    const published = runCli(overridden, [...standardArgs(overridden), '--ignore-approval-hold']);
    assert.equal(published.status, 0, published.stderr);
    assert.equal(overridden.remote.calls('createReview').length, 1);
  });

  test('uncertain: exit 3 with preserved state guidance; retries never resend and later recover', () => {
    const world = makeWorld({ create: 'lose-response', visibilityDelay: 4 });
    const first = runCli(world, standardArgs(world));
    assert.equal(first.status, 3, first.stderr);
    assert.ok(first.stdout.includes(world.statePath));
    assert.match(first.stdout, /same state path/i);
    assert.match(first.stdout, /do not delete/i);

    setAdapterConfig(world.remote.dir, { context: 'throw' });
    let last = first;
    for (let i = 0; i < 10 && last.status === 3; i += 1) last = runCli(world, standardArgs(world));
    assert.equal(last.status, 0, last.stdout + last.stderr);
    assert.equal(world.remote.calls('createReview').length, 1);
    assert.equal(world.remote.calls('adapter:fetchContext').length, 1);
  });

  test('host rejection: exit 1 with the rejection Markdown, remembered without network, never resent', () => {
    const world = makeWorld({ create: 'reject' });
    const run = runCli(world, standardArgs(world));
    assert.equal(run.status, 1);
    assert.ok(run.stdout.includes(world.statePath));
    assert.match(run.stdout, /never resent/i);
    world.remote.setConfig({ create: 'ok' });
    setAdapterConfig(world.remote.dir, { network: 'down' });
    const again = runCli(world, standardArgs(world));
    assert.equal(again.status, 1);
    assert.match(again.stdout, /never resent/i);
    assert.equal(world.remote.calls('createReview').length, 1);
    assert.deepEqual(world.remote.calls('adapter:network-attempt'), []);
  });

  test('reusing a state path for a different SARIF file is refused with exit 1', () => {
    const world = makeWorld();
    assert.equal(runCli(world, standardArgs(world)).status, 0);
    const changed = structuredClone(READY);
    changed.runs[0].results[0].message.text = 'A different finding.';
    fs.writeFileSync(world.sarifPath, JSON.stringify(changed));
    const run = runCli(world, standardArgs(world));
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes(world.statePath));
    assert.equal(run.stdout, '');
    assert.equal(world.remote.calls('createReview').length, 1);
  });

  test('a completed receipt exits 0 with no network', () => {
    const world = makeWorld();
    const first = runCli(world, standardArgs(world));
    assert.equal(first.status, 0, first.stderr);
    setAdapterConfig(world.remote.dir, { network: 'down', context: 'throw' });
    const again = runCli(world, standardArgs(world));
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(world.remote.calls('adapter:network-attempt'), []);
    assert.ok(again.stdout.includes(world.remote.reviews()[0].htmlUrl));
  });
});

describe('SARIF file decoding is faithful UTF-8', () => {
  // SARIF files are UTF-8 JSON (SARIF 2.1.0 §3.1; RFC 8259 §8.1). A leading
  // UTF-8 byte-order mark is an encoding signature, not content, and is ignored
  // (RFC 8259 permits it). Bytes that are not valid UTF-8 cannot be decoded
  // faithfully and must be refused before anything is fingerprinted or sent,
  // never replaced with U+FFFD.
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

  test('a UTF-8 byte-order mark is ignored: same publication identity as the library given the parsed document', async () => {
    const world = makeWorld();
    fs.writeFileSync(world.sarifPath, Buffer.concat([BOM, Buffer.from(JSON.stringify(READY), 'utf8')]));
    const run = runCli(world, standardArgs(world));
    assert.equal(run.status, 0, run.stderr);
    const record = JSON.parse(fs.readFileSync(world.statePath, 'utf8'));
    assert.equal(record.inputFingerprint, expectedInputFingerprint(READY));
    assert.equal(world.remote.calls('createReview').length, 1);
  });

  test('non-ASCII text survives decoding exactly into the sent review', () => {
    const world = makeWorld();
    const sarif = structuredClone(READY);
    const text = 'Überprüfe die Grenze — 限界を確認 😀';
    sarif.runs[0].results[0].message.text = text;
    fs.writeFileSync(world.sarifPath, Buffer.concat([BOM, Buffer.from(JSON.stringify(sarif), 'utf8')]));
    const run = runCli(world, standardArgs(world));
    assert.equal(run.status, 0, run.stderr);
    const [create] = world.remote.calls('createReview');
    assert.ok(create.args.body.includes(text), 'the message text must reach the review unaltered');
    const record = JSON.parse(fs.readFileSync(world.statePath, 'utf8'));
    assert.equal(record.inputFingerprint, expectedInputFingerprint(sarif));
  });

  for (const [label, bytes] of [
    ['an invalid UTF-8 byte inside a string', (json) => Buffer.concat([json.subarray(0, 40), Buffer.from([0xff]), json.subarray(40)])],
    ['a truncated multi-byte sequence', (json) => Buffer.concat([json.subarray(0, 40), Buffer.from([0xe6, 0x97]), json.subarray(40)])],
    ['an encoded surrogate (CESU-8)', (json) => Buffer.concat([json.subarray(0, 40), Buffer.from([0xed, 0xa0, 0x80]), json.subarray(40)])],
    ['a UTF-16 file with its byte-order mark', () => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(READY), 'utf16le')])],
  ]) {
    test(`${label} is refused naming the file, before any remote work or state`, () => {
      const world = makeWorld();
      const json = Buffer.from(JSON.stringify(READY), 'utf8');
      // Byte 40 falls inside the "$schema" string value, so a lenient decoder
      // would still produce parseable JSON with U+FFFD substituted.
      assert.equal(json.subarray(0, 40).toString('utf8').split('"').length % 2, 0, 'control: offset 40 is inside a string');
      fs.writeFileSync(world.sarifPath, bytes(json));
      const run = runCli(world, standardArgs(world));
      assert.equal(run.status, 1, run.stdout);
      assert.ok(run.stderr.includes(world.sarifPath), run.stderr);
      assert.match(run.stderr, /UTF-8/);
      assert.equal(run.stdout, '');
      assert.deepEqual(world.remote.calls(), [], 'no client may be created and no request made');
      assert.deepEqual(stateFiles(world), []);
    });
  }

  test('control: a lenient decoder would have published the altered text', () => {
    const json = Buffer.from(JSON.stringify(READY), 'utf8');
    const corrupted = Buffer.concat([json.subarray(0, 40), Buffer.from([0xff]), json.subarray(40)]);
    const lenient = JSON.parse(corrupted.toString('utf8'));
    assert.ok(JSON.stringify(lenient).includes('\uFFFD'), 'lenient decoding silently substitutes U+FFFD');
  });
});

describe('credentials', () => {
  test('GH_TOKEN takes precedence over GITHUB_TOKEN', () => {
    const world = makeWorld();
    const run = runCli(world, standardArgs(world), { GH_TOKEN: TOKEN, GITHUB_TOKEN: OTHER_TOKEN });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(adapterCreated(world).map((c) => c.args.token), [TOKEN]);
    assertNoToken(world, run);
  });

  test('GITHUB_TOKEN is used when GH_TOKEN is unset or empty', () => {
    for (const env of [{ GITHUB_TOKEN: OTHER_TOKEN }, { GH_TOKEN: '', GITHUB_TOKEN: OTHER_TOKEN }]) {
      const world = makeWorld();
      const run = runCli(world, standardArgs(world), env);
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(adapterCreated(world).map((c) => c.args.token), [OTHER_TOKEN]);
    }
  });

  for (const mode of ['throw-with-token', 'throw-with-token-cause']) {
    test(`an operational error carrying the token (${mode}) is reported without it`, () => {
      const world = makeWorld();
      setAdapterConfig(world.remote.dir, { context: mode });
      const run = runCli(world, standardArgs(world));
      assert.equal(run.status, 1);
      assert.ok(run.stderr.includes('GET /repos/acme/gizmos/pulls/7 failed'), 'the operational cause must remain visible');
      assertNoToken(world, run);
      assert.deepEqual(stateFiles(world), []);
    });
  }
});
