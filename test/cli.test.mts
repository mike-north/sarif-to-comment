/**
 * User-acceptance tests for the thin CLI (dist/sarif-to-comment.cjs).
 *
 * Each test runs the real CLI entry point in a child process through
 * test/fixtures/public-api/cli-with-fake-github.mts, which injects only the
 * GitHub adapter (a file-backed host double shared with the parent through
 * FAKE_GITHUB_DIR). Parsing, file reading, credential selection, the library
 * call, Markdown output and exit status are the real CLI's. Delegation to the
 * library is checked by comparing CLI output and sent requests with an
 * in-process publishSarifReview run on an identical fresh host (through
 * publishSarifReviewWithInternals, which injects the same fake client).
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

import * as assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { publishSarifReviewWithInternals } from '../dist/publish-sarif-review.cjs';
import type { PublishSarifReviewOutcome } from '../dist/publish-sarif-review.cjs';
import { FakeGitHubRemote } from './fixtures/publication/fake-github.mts';
import type { IFakeRemoteConfig } from './fixtures/publication/fake-github.mts';
import {
  REPOSITORY,
  createFakeClientFactory,
  setAdapterConfig,
} from './fixtures/public-api/fake-adapter.mts';
import { asArray, asRecord, asString, readJson } from './support/runtime-types.mts';
import type { UnknownRecord } from './support/runtime-types.mts';

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'public-api');
const WRAPPER = path.join(FIXTURE_DIR, 'cli-with-fake-github.mts');
const loadSarif = (name: string): UnknownRecord => asRecord(readJson(path.join(FIXTURE_DIR, name)), name);
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
  '--submit',
];

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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = asRecord(value);
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
      .join(',')}}`;
  }
  return asString(JSON.stringify(value), 'a JSON value');
}

/** The optional publication identity inputs (null when absent, as the library records them). */
interface IIdentityOptions {
  readonly sourceRootUri?: string | null;
  readonly oldSourceCommit?: string | null;
}

function expectedInputFingerprint(sarif: unknown, { sourceRootUri = null, oldSourceCommit = null }: IIdentityOptions = {}): string {
  const identity = { format: 'sarif-to-comment.input', version: 1, sarif, sourceRootUri, oldSourceCommit };
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// World and child-process helpers
// ---------------------------------------------------------------------------

/** A temporary publication world: a fake remote, a state directory and the input file. */
interface IWorld {
  readonly root: string;
  readonly stateDir: string;
  readonly statePath: string;
  readonly remote: FakeGitHubRemote;
  readonly sarifPath: string;
}

/** A finished CLI child process. */
interface ICliRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function makeWorld(hostConfig: Partial<IFakeRemoteConfig> = {}, sarif: unknown = READY): IWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  const remote = FakeGitHubRemote.create(path.join(root, 'remote'), hostConfig);
  const sarifPath = path.join(root, 'input.sarif.json');
  fs.writeFileSync(sarifPath, JSON.stringify(sarif, null, 2));
  return { root, stateDir, statePath: path.join(stateDir, 'review.publication.json'), remote, sarifPath };
}

function standardArgs(world: IWorld, overrides: Readonly<Record<string, string | undefined>> = {}): string[] {
  const values: Record<string, string | undefined> = {
    '--sarif': world.sarifPath,
    '--repo': REPO_FLAG,
    '--pull': PULL_FLAG,
    '--commit': HEAD,
    '--state': world.statePath,
    ...overrides,
  };
  return Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .flatMap(([flag, v]) => [flag, v]);
}

/**
 * Runs the CLI wrapper with a controlled environment: only PATH, the fake
 * remote location and explicitly supplied variables (never the developer's
 * own GitHub credentials).
 */
function runCli(world: IWorld, argv: readonly string[], env: Readonly<Record<string, string>> = { GH_TOKEN: TOKEN }): ICliRun {
  const result = spawnSync(process.execPath, [WRAPPER, ...argv], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env['PATH'], FAKE_GITHUB_DIR: world.remote.dir, ...env },
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

function adapterCreated(world: IWorld): ReturnType<FakeGitHubRemote['calls']> {
  return world.remote.calls('adapter:create');
}

function stateFiles(world: IWorld): string[] {
  return fs.readdirSync(world.stateDir);
}

function assertNoToken(world: IWorld, run: ICliRun): void {
  const texts: [string, string][] = [
    ['stdout', run.stdout],
    ['stderr', run.stderr],
    ...stateFiles(world).map((f): [string, string] => [f, fs.readFileSync(path.join(world.stateDir, f), 'utf8')]),
  ];
  for (const [name, text] of texts) {
    assert.equal(text.includes(TOKEN), false, `token appeared in ${name}`);
    assert.equal(text.includes(OTHER_TOKEN), false, `secondary token appeared in ${name}`);
  }
}

/** The same operation through the library, on a fresh identical host. */
/** What libraryOutcome varies: the host and the optional publication inputs. */
interface ILibraryOptions {
  readonly hostConfig?: Partial<IFakeRemoteConfig>;
  readonly options?: object;
  readonly sourceRootUri?: string;
  readonly oldSourceCommit?: string;
}

async function libraryOutcome(
  sarif: unknown,
  { hostConfig = {}, options, sourceRootUri, oldSourceCommit }: ILibraryOptions = {},
): Promise<{ world: IWorld; outcome: PublishSarifReviewOutcome }> {
  const world = makeWorld(hostConfig, sarif);
  const input: Record<string, unknown> = {
    sarif: structuredClone(sarif),
    destination: { ...REPOSITORY.destination },
    reviewedCommit: HEAD,
    statePath: world.statePath,
    token: TOKEN,
  };
  if (options) input['options'] = options;
  if (sourceRootUri) input['sourceRootUri'] = sourceRootUri;
  if (oldSourceCommit) input['oldSourceCommit'] = oldSourceCommit;
  const outcome = await publishSarifReviewWithInternals(input, { createGitHubClient: createFakeClientFactory(world.remote.dir) });
  return { world, outcome };
}

function withoutStatePath(markdown: string, statePath: string): string {
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
  const cases: readonly (readonly [string, (w: IWorld) => string[], string])[] = [
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
    ['valued --submit', (w) => [...standardArgs(w), '--submit=true'], '--submit'],
    ['duplicate --submit', (w) => [...standardArgs(w), '--submit', '--submit'], '--submit'],
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
    const stored = item(world.remote.reviews(), 0);
    assert.ok(run.stdout.includes(stored.htmlUrl));

    const library = await libraryOutcome(READY);
    assert.equal(library.outcome.status, 'published');
    assert.equal(
      withoutStatePath(run.stdout.trimEnd(), world.statePath),
      withoutStatePath(library.outcome.markdown.trimEnd(), library.world.statePath),
    );
    const libraryCreate = item(library.world.remote.calls('createReview'), 0);
    assert.deepEqual(at(creates, 0, 'args', 'comments'), libraryCreate.args['comments']);
    const strip = (body: unknown): string => asString(body).replace(/<!-- sarif-to-comment:review:[0-9a-f-]{36} -->$/, '');
    assert.equal(strip(at(creates, 0, 'args', 'body')), strip(libraryCreate.args['body']));
    assert.equal(at(creates, 0, 'args', 'commitId'), HEAD);
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
    const record = readJson(world.statePath);
    assert.equal(at(record, 'inputFingerprint'), expectedInputFingerprint(READY, { sourceRootUri }));
  });

  test('--old-source-commit is a candidate passed to GitHub and part of the identity, like the library', async () => {
    const world = makeWorld();
    const run = runCli(world, [...standardArgs(world), '--old-source-commit', BASE]);
    assert.equal(run.status, 0, run.stderr);
    const fetch = item(world.remote.calls('adapter:fetchContext'), 0);
    assert.equal(fetch.args['oldSourceCommit'], BASE);
    const record = readJson(world.statePath);
    assert.equal(at(record, 'inputFingerprint'), expectedInputFingerprint(READY, { oldSourceCommit: BASE }));

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

  test('blocked: exit 2, the report on stdout and each problem once on stderr, no remote write and no state', async () => {
    const world = makeWorld({}, INVALID);
    const run = runCli(world, standardArgs(world));
    assert.equal(run.status, 2, run.stderr);
    const library = await libraryOutcome(INVALID);
    assert.equal(library.outcome.status, 'blocked');
    // docs/diagnostics.md "Streams": the problem lists are diagnostics on stderr, not repeated on stdout.
    assert.equal(run.stdout, '## Review blocked\n\nNothing was published and no publication state was written. 1 problem must be resolved before publication.\n');
    assert.match(run.stderr, /^✖ error {2}The document is not valid SARIF 2\.1\.0 {2}\[sarif-schema-invalid\]\n/);
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
    asRecord(at(changed, 'runs', 0, 'results', 0, 'message'))['text'] = 'A different finding.';
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
    assert.ok(again.stdout.includes(item(world.remote.reviews(), 0).htmlUrl));
  });
});

describe('SARIF file decoding is faithful UTF-8', () => {
  // SARIF files are UTF-8 JSON (SARIF 2.1.0 §3.1; RFC 8259 §8.1). A leading
  // UTF-8 byte-order mark is an encoding signature, not content, and is ignored
  // (RFC 8259 permits it). Bytes that are not valid UTF-8 cannot be decoded
  // faithfully and must be refused before anything is fingerprinted or sent,
  // never replaced with U+FFFD.
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

  test('a UTF-8 byte-order mark is ignored: same publication identity as the library given the parsed document', () => {
    const world = makeWorld();
    fs.writeFileSync(world.sarifPath, Buffer.concat([BOM, Buffer.from(JSON.stringify(READY), 'utf8')]));
    const run = runCli(world, standardArgs(world));
    assert.equal(run.status, 0, run.stderr);
    const record = readJson(world.statePath);
    assert.equal(at(record, 'inputFingerprint'), expectedInputFingerprint(READY));
    assert.equal(world.remote.calls('createReview').length, 1);
  });

  test('non-ASCII text survives decoding exactly into the sent review', () => {
    const world = makeWorld();
    const sarif = structuredClone(READY);
    const text = 'Überprüfe die Grenze — 限界を確認 😀';
    asRecord(at(sarif, 'runs', 0, 'results', 0, 'message'))['text'] = text;
    fs.writeFileSync(world.sarifPath, Buffer.concat([BOM, Buffer.from(JSON.stringify(sarif), 'utf8')]));
    const run = runCli(world, standardArgs(world));
    assert.equal(run.status, 0, run.stderr);
    const create = item(world.remote.calls('createReview'), 0);
    assert.ok(asString(create.args['body']).includes(text), 'the message text must reach the review unaltered');
    const record = readJson(world.statePath);
    assert.equal(at(record, 'inputFingerprint'), expectedInputFingerprint(sarif));
  });

  const encodings: readonly (readonly [string, (json: Buffer) => Buffer])[] = [
    ['an invalid UTF-8 byte inside a string', (json) => Buffer.concat([json.subarray(0, 40), Buffer.from([0xff]), json.subarray(40)])],
    ['a truncated multi-byte sequence', (json) => Buffer.concat([json.subarray(0, 40), Buffer.from([0xe6, 0x97]), json.subarray(40)])],
    ['an encoded surrogate (CESU-8)', (json) => Buffer.concat([json.subarray(0, 40), Buffer.from([0xed, 0xa0, 0x80]), json.subarray(40)])],
    ['a UTF-16 file with its byte-order mark', () => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(READY), 'utf16le')])],
  ];
  for (const [label, bytes] of encodings) {
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
    const lenient: unknown = JSON.parse(corrupted.toString('utf8'));
    assert.ok(JSON.stringify(lenient).includes('\uFFFD'), 'lenient decoding silently substitutes U+FFFD');
  });
});

describe('credentials', () => {
  test('GH_TOKEN takes precedence over GITHUB_TOKEN', () => {
    const world = makeWorld();
    const run = runCli(world, standardArgs(world), { GH_TOKEN: TOKEN, GITHUB_TOKEN: OTHER_TOKEN });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(adapterCreated(world).map((c) => c.args['token']), [TOKEN]);
    assertNoToken(world, run);
  });

  test('GITHUB_TOKEN is used when GH_TOKEN is unset or empty', () => {
    for (const env of [{ GITHUB_TOKEN: OTHER_TOKEN }, { GH_TOKEN: '', GITHUB_TOKEN: OTHER_TOKEN }]) {
      const world = makeWorld();
      const run = runCli(world, standardArgs(world), env);
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(adapterCreated(world).map((c) => c.args['token']), [OTHER_TOKEN]);
    }
  });

  for (const mode of ['throw-with-token', 'throw-with-token-cause'] as const) {
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
