/**
 * Contract tests for the public library operation publishSarifReview
 * (src/index.cts).
 *
 * The operation takes an in-memory SARIF value and composes the same private
 * cores as the CLI: whole-review preparation, the GitHub client, and durable
 * initial publication. These tests prove the composition, not the cores
 * themselves (those have their own suites):
 * - input is validated and deeply captured before any remote read, without
 *   running caller getters, so caller mutation cannot change what is
 *   fingerprinted or rendered;
 * - the original-input fingerprint covers the SARIF, the source root and the
 *   optional old-source commit candidate, excludes the token, state path and
 *   approval-hold override, and is recomputed here by an independent
 *   canonicalizer;
 * - existing state is honoured before any branch/source preparation: a
 *   completed receipt or a known refusal needs no network, and a sending
 *   intent is investigated with its saved request without fetching context or
 *   preparing again;
 * - new publications fetch context, verify it names exactly this destination
 *   and reviewed commit (never the current pull head), prepare once, and
 *   either block with no write and no state file or publish exactly once;
 * - the consumer contract is status plus Markdown (and review/state
 *   identifiers), with no internal codes, and the token never reaches state,
 *   fingerprint, Markdown or a rejection (including its causes).
 *
 * Delegation is checked by comparing the sent request and blocked Markdown with
 * what prepareReview itself produces for the same SARIF and context, plus
 * independent facts from the fixture (which line the inline comment is on,
 * which text is general feedback). The GitHub client is a private seam backed
 * by a file-backed host double shaped like src/github.cts; mocks are not
 * evidence of GitHub behavior.
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://www.rfc-editor.org/rfc/rfc8259 (JSON values)
 * @see https://www.rfc-editor.org/rfc/rfc8089 (file URI scheme)
 */

import * as assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as util from 'node:util';

import { GitHubError } from '../dist/github.cjs';
import { publishSarifReview } from '../dist/index.cjs';
import { prepareReview } from '../dist/prepare-review.cjs';
import type { IPreparedReview, PrepareReviewOutcome } from '../dist/prepare-review.cjs';
import type {
  IPublishSarifReviewInput,
  IPublishSarifReviewInternals,
  IPullRequestDestination,
  PublishSarifReviewOutcome,
} from '../dist/publish-sarif-review.cjs';
import { FakeGitHubRemote, DEFAULT_USER } from './fixtures/publication/fake-github.mts';
import type { IFakeRemoteConfig, IRecordedCall } from './fixtures/publication/fake-github.mts';
import {
  REPOSITORY,
  createFakeClientFactory,
  readSource,
  setAdapterConfig,
  trustedContext,
} from './fixtures/public-api/fake-adapter.mts';
import type { FakeClientFactory, ITrustedContext } from './fixtures/public-api/fake-adapter.mts';
import { expectType, isArrayOf, isNumber, isShape, isString, isUnknown, readJson } from './support/runtime-types.mts';
import type { Guard } from './support/runtime-types.mts';

// ---------------------------------------------------------------------------
// Typing of fixture and state data (runtime-checked; see test/support/runtime-types.mts)
// ---------------------------------------------------------------------------

/** The type a guard checks. */
type Guarded<G> = G extends Guard<infer T> ? T : never;

/**
 * The part of a SARIF log these tests read or change: every result's message
 * text and each run's properties. Other members are kept, unchecked.
 */
const isTestSarif = isShape({
  runs: isArrayOf(isShape({ results: isArrayOf(isShape({ message: isShape({ text: isString }) })), properties: isUnknown })),
});
type TestSarif = Guarded<typeof isTestSarif>;

/** The create-review request fields these tests read (as the fake transport records it). */
const isSentRequest = isShape({
  owner: isString,
  repo: isString,
  pullNumber: isNumber,
  commitId: isString,
  body: isString,
  comments: isArrayOf(isShape({ path: isString, side: isString, line: isNumber, body: isString })),
});

/** The publication state field these tests read (the full format is src/publication.cts's). */
const isStateRecord = isShape({ inputFingerprint: isString });

/** `T` with its properties writable. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * A publishSarifReview input the tests may change in place: the public input
 * type, writable, with the SARIF typed as far as the tests reach into it.
 * Changes the public types refuse are marked where they are made.
 */
type TestInput = Omit<Mutable<IPublishSarifReviewInput>, 'sarif' | 'destination'> & {
  sarif: TestSarif;
  destination: Mutable<IPullRequestDestination>;
};

/** Element `index` of `items`; fails (AssertionError) when there is none. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new AssertionError({ message: `expected an element at index ${String(index)}`, actual: items });
  return item;
}

/** Own entry `key` of `record`; fails (AssertionError) when there is none. */
function entry<T>(record: Readonly<Record<string, T>>, key: string): T {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  if (value === undefined) throw new AssertionError({ message: `expected an entry ${JSON.stringify(key)}`, actual: Object.keys(record) });
  return value;
}

/** `err && err[key]`: a property of a rejection value, or the value itself when it is falsy. */
function errorField(err: unknown, key: 'name' | 'message'): unknown {
  if (!err) return err;
  const value: unknown = Reflect.get(Object(err), key);
  return value;
}

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'public-api');
const loadSarif = (name: string): TestSarif => expectType(readJson(path.join(FIXTURE_DIR, name)), isTestSarif, `the SARIF fixture ${name}`);
const READY = loadSarif('ready.sarif.json');
const HELD = loadSarif('held.sarif.json');
const INVALID = loadSarif('invalid.sarif.json');

const DESTINATION = REPOSITORY.destination;
const HEAD = REPOSITORY.commits.head;
const BASE = REPOSITORY.commits.base;
const TOKEN = 'ghp_PUBLICAPI_SENTINEL_token_value_0123456789';
const MARKER = /\n\n<!-- sarif-to-comment:review:[0-9a-f-]{36} -->$/;

// ---------------------------------------------------------------------------
// Independent fingerprint (spec in src/publish-sarif-review.cts: sha256 over canonical JSON
// with recursively sorted keys, no insignificant whitespace, UTF-8)
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const members = new Map<string, unknown>(Object.entries(value));
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(members.get(k))}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function expectedInputFingerprint(
  sarif: unknown,
  { sourceRootUri = null, oldSourceCommit = null }: { sourceRootUri?: string | null; oldSourceCommit?: string | null } = {},
): string {
  const identity = { format: 'sarif-to-comment.input', version: 1, sarif, sourceRootUri, oldSourceCommit };
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex')}`;
}

/** Deep copy with object keys in reverse order at every level. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') {
    const members = new Map<string, unknown>(Object.entries(value));
    return Object.fromEntries(Object.keys(value).reverse().map((k) => [k, reverseKeys(members.get(k))]));
  }
  return value;
}

// ---------------------------------------------------------------------------
// World and helpers
// ---------------------------------------------------------------------------

interface IWorld {
  readonly root: string;
  readonly stateDir: string;
  readonly statePath: string;
  readonly remote: FakeGitHubRemote;
  readonly createGitHubClient: FakeClientFactory;
}

function makeWorld(hostConfig: Partial<IFakeRemoteConfig> = {}): IWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-api-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  const remote = FakeGitHubRemote.create(path.join(root, 'remote'), hostConfig);
  return {
    root,
    stateDir,
    statePath: path.join(stateDir, 'review.publication.json'),
    remote,
    createGitHubClient: createFakeClientFactory(remote.dir),
  };
}

function baseInput(world: IWorld, overrides: Partial<TestInput> = {}): TestInput {
  return {
    sarif: structuredClone(READY),
    destination: { ...DESTINATION },
    reviewedCommit: HEAD,
    statePath: world.statePath,
    token: TOKEN,
    ...overrides,
  };
}

function run(world: IWorld, input: TestInput = baseInput(world)): Promise<PublishSarifReviewOutcome> {
  const internals: IPublishSarifReviewInternals = { createGitHubClient: world.createGitHubClient };
  return publishSarifReview(
    input,
    // @ts-expect-error -- the private internals seam is deliberately absent from the public declaration; this suite proves the public entry honours it at runtime
    internals,
  );
}

function calls(world: IWorld, method: string): IRecordedCall[] {
  return world.remote.calls(method);
}

function assertNoRemoteWrites(world: IWorld): void {
  assert.deepEqual(world.remote.writeCalls().map((c) => c.method), [], 'no remote write may occur');
}

function assertStateDirEmpty(world: IWorld): void {
  assert.deepEqual(fs.readdirSync(world.stateDir), [], 'no publication state may be written');
}

function stateText(world: IWorld): string {
  return fs
    .readdirSync(world.stateDir)
    .map((name) => fs.readFileSync(path.join(world.stateDir, name), 'utf8'))
    .join('\n');
}

function assertTokenAbsent(world: IWorld, outcome?: PublishSarifReviewOutcome): void {
  assert.equal(stateText(world).includes(TOKEN), false, 'token reached publication state');
  if (outcome) assert.equal(JSON.stringify(outcome).includes(TOKEN), false, 'token reached the outcome');
}

/** Everything an inspecting caller could see of a rejection, including causes and hidden properties. */
function inspectDeep(err: unknown): string {
  return util.inspect(err, { depth: null, showHidden: true });
}

/** Exact public shape per status: no internal codes, evidence or diagnostics. */
function assertPublicShape<S extends PublishSarifReviewOutcome['status']>(
  outcome: PublishSarifReviewOutcome,
  status: S,
): asserts outcome is Extract<PublishSarifReviewOutcome, { status: S }> {
  assert.equal(outcome.status, status, `expected ${status}, got ${JSON.stringify(outcome)}`);
  const keys = {
    published: ['markdown', 'review', 'statePath', 'status'],
    blocked: ['markdown', 'status'],
    uncertain: ['markdown', 'statePath', 'status'],
    rejected: ['markdown', 'statePath', 'status'],
  }[status];
  assert.deepEqual(Object.keys(outcome).sort(), keys);
  // Field order is the documented outcome order (src/publish-sarif-review.cts module doc,
  // contract §3.5): status first, markdown last. It is what JSON.stringify of
  // an outcome shows a caller, so it must not drift.
  const ordered = {
    published: ['status', 'review', 'statePath', 'markdown'],
    blocked: ['status', 'markdown'],
    uncertain: ['status', 'statePath', 'markdown'],
    rejected: ['status', 'statePath', 'markdown'],
  }[status];
  assert.deepEqual(Object.keys(outcome), ordered, 'outcome fields in documented order');
  assert.equal(typeof outcome.markdown, 'string');
  assert.ok(outcome.markdown.length > 0);
  // The status was asserted equal above; comparing the outcome's own status narrows its type.
  if (outcome.status === 'published') {
    assert.deepEqual(Object.keys(outcome.review), ['id', 'url']);
    assert.ok(outcome.markdown.includes(outcome.review.url), 'published Markdown must link the review');
  }
}

/** Guidance for uncertain delivery: keep and reuse the state path; never resend. */
function assertUncertainGuidance(outcome: PublishSarifReviewOutcome, statePath: string): void {
  assert.ok(outcome.markdown.includes(statePath), 'Markdown must name the preserved state path');
  assert.match(outcome.markdown, /same state path/i);
  assert.match(outcome.markdown, /do not delete/i);
  assert.match(outcome.markdown, /new state path[^.]*separate review/i);
}

/** Guidance for a definitive refusal: named state path, never resent, new path after fixing. */
function assertRejectedGuidance(outcome: PublishSarifReviewOutcome, statePath: string): void {
  assert.ok(outcome.markdown.includes(statePath));
  assert.match(outcome.markdown, /never resent/i);
  assert.match(outcome.markdown, /new state path/i);
}

/** What prepareReview itself produces for this SARIF and the fixture context. */
async function preparedDirectly(
  sarif: TestSarif,
  {
    ignoreApprovalHold,
    sourceRootUri,
    historical,
    oldSourceCommit,
  }: { ignoreApprovalHold?: boolean; sourceRootUri?: string; historical?: boolean; oldSourceCommit?: string } = {},
): Promise<PrepareReviewOutcome> {
  const context: ITrustedContext & { sourceRootUri?: string } = trustedContext({ historical, oldSourceCommit });
  if (sourceRootUri !== undefined) context.sourceRootUri = sourceRootUri;
  const input: { sarif: TestSarif; context: typeof context; readSource: typeof readSource; options?: { ignoreApprovalHold: boolean } } = {
    sarif: structuredClone(sarif),
    context,
    readSource,
  };
  if (ignoreApprovalHold !== undefined) input.options = { ignoreApprovalHold };
  return prepareReview(input);
}

/** `prepared.review`: the review of a ready outcome, undefined for a blocked one. */
function readyReviewOf(prepared: PrepareReviewOutcome): IPreparedReview | undefined {
  return prepared.status === 'ready' ? prepared.review : undefined;
}

function sentRequest(world: IWorld): Guarded<typeof isSentRequest> {
  const creates = calls(world, 'createReview');
  assert.equal(creates.length, 1, `expected exactly one create-review attempt, saw ${String(creates.length)}`);
  return expectType(at(creates, 0).args, isSentRequest, 'the create-review request');
}

function readState(world: IWorld): Guarded<typeof isStateRecord> {
  return expectType(readJson(world.statePath), isStateRecord, `the publication state in ${world.statePath}`);
}

// ===========================================================================
// Tests
// ===========================================================================

describe('harness control: the injected context is coherent', () => {
  for (const [label, diff, head] of [
    ['reviewed head', REPOSITORY.diff, HEAD],
    ['advanced head', REPOSITORY.advancedDiff, REPOSITORY.commits.advanced],
  ] as const) {
    test(`the authored patch reproduces both authored snapshots exactly (${label})`, () => {
      const file = at(diff.files, 0);
      const body = file.patch.slice(1); // one hunk covering the whole file
      // String(l[0]) is the coercion includes() applies itself (an empty line has no l[0]).
      const side = (keep: string): string => body.filter((l) => keep.includes(String(l[0]))).map((l) => l.slice(1)).join('');
      assert.equal(side(' -'), entry(entry(REPOSITORY.snapshots, BASE), file.path).join(''));
      assert.equal(side(' +'), entry(entry(REPOSITORY.snapshots, head), file.path).join(''));
      assert.equal(diff.headCommit, head);
    });
  }

  test('the fake client serves the fixture context, logs calls and honours its modes', async () => {
    const world = makeWorld();
    const client = world.createGitHubClient({ token: TOKEN, fetch: globalThis.fetch });
    const { context, readSource: reader } = await client.fetchContext({ destination: DESTINATION, reviewedCommit: HEAD });
    assert.equal(context.reviewedCommit, HEAD);
    assert.equal(context.diff.headCommit, HEAD);
    assert.equal(await reader(HEAD, 'src/app.js'), entry(entry(REPOSITORY.snapshots, HEAD), 'src/app.js').join(''));
    assert.equal(await reader(HEAD, 'absent.js'), null);
    assert.deepEqual(calls(world, 'adapter:create').map((c) => c.args['token']), [TOKEN]);

    setAdapterConfig(world.remote.dir, { network: 'down' });
    const offline = world.createGitHubClient({ token: TOKEN, fetch: globalThis.fetch });
    await assert.rejects(offline.listReviews({ ...DESTINATION, cursor: null }), /ENOTFOUND/);
    assert.equal(calls(world, 'adapter:network-attempt').length, 1);
  });
});

describe('input is validated and captured before any remote read', () => {
  const inRun = (value: unknown) => (i: TestInput) => {
    at(i.sarif.runs, 0).properties = { probe: value };
  };
  class Custom {
    x: number;
    constructor() {
      this.x = 1;
    }
  }
  const cyclic = (i: TestInput) => {
    const node: { name: string; self?: unknown } = { name: 'loop' };
    node.self = node;
    at(i.sarif.runs, 0).properties = { node };
  };
  const invalid: Record<string, (i: TestInput) => unknown> = {
    // @ts-expect-error -- deliberately invalid: proves runtime validation of a missing sarif
    'missing sarif': (i) => delete i.sarif,
    // @ts-expect-error -- deliberately invalid: proves runtime validation of a null sarif
    'null sarif': (i) => (i.sarif = null),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of an array sarif
    'array sarif': (i) => (i.sarif = [READY]),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of unparsed SARIF text
    'string sarif (not parsed)': (i) => (i.sarif = JSON.stringify(READY)),
    'cyclic sarif': cyclic,
    'function value': inRun(() => 1),
    'undefined property value': inRun(undefined),
    'undefined array element': inRun([1, undefined]),
    'sparse array hole': inRun([1, , 3]), // the array hole is the input under test (no-sparse-arrays is not enabled for TypeScript)
    'NaN': inRun(Number.NaN),
    'Infinity': inRun(Number.POSITIVE_INFINITY),
    'negative zero': inRun(-0),
    'BigInt': inRun(10n),
    'Date object': inRun(new Date('2026-09-27T00:00:00.000Z')),
    'Map object': inRun(new Map([['a', 1]])),
    'class instance': inRun(new Custom()),
    'symbol-keyed property': inRun({ [Symbol('hidden')]: 1 }),
    'accessor property': inRun(Object.defineProperty({}, 'computed', { enumerable: true, get: () => 'varies' })),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of a missing destination
    'missing destination': (i) => delete i.destination,
    'owner containing a slash': (i) => (i.destination.owner = 'acme/other'),
    'zero pull number': (i) => (i.destination.pullNumber = 0),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of a string pull number
    'string pull number': (i) => (i.destination.pullNumber = '7'),
    'short reviewed commit': (i) => (i.reviewedCommit = HEAD.slice(0, 12)),
    'uppercase reviewed commit': (i) => (i.reviewedCommit = 'A'.repeat(40)),
    'short old-source commit': (i) => (i.oldSourceCommit = BASE.slice(0, 7)),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of a non-string old-source commit
    'non-string old-source commit': (i) => (i.oldSourceCommit = 1234),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of a missing state path
    'missing state path': (i) => delete i.statePath,
    'relative state path': (i) => (i.statePath = 'state/review.publication.json'),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of a missing token
    'missing token': (i) => delete i.token,
    'empty token': (i) => (i.token = ''),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of a non-string token
    'non-string token': (i) => (i.token = 12345),
    'relative source root': (i) => (i.sourceRootUri = 'work/gizmos/'),
    'non-file source root': (i) => (i.sourceRootUri = 'https://example.com/gizmos/'),
    'source root without trailing slash': (i) => (i.sourceRootUri = 'file:///work/gizmos'),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of an unknown option
    'unknown option': (i) => (i.options = { ignoreApprovalHolds: true }),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of a non-boolean override
    'non-boolean override': (i) => (i.options = { ignoreApprovalHold: 'yes' }),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of array options
    'array options': (i) => (i.options = []),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of a non-boolean submit option
    'non-boolean submit': (i) => (i.options = { submit: 'yes' }),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of a verdict passed as the submit option
    'verdict as submit': (i) => (i.options = { submit: 'APPROVE' }),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of a null submit option
    'null submit': (i) => (i.options = { submit: null }),
    // @ts-expect-error -- deliberately invalid: proves there is no event option (the event is never caller-chosen beyond submit)
    'event option': (i) => (i.options = { submit: true, event: 'APPROVE' }),
    // @ts-expect-error -- deliberately invalid: proves runtime validation of an unknown top-level field
    'unknown top-level field': (i) => (i.reviewCommit = HEAD),
  };

  for (const [label, breakIt] of Object.entries(invalid)) {
    test(`${label} is refused with TypeError before any client or state use`, async () => {
      const world = makeWorld();
      const input = baseInput(world);
      breakIt(input);
      await assert.rejects(run(world, input), (err) => {
        assert.ok(err instanceof TypeError, `expected TypeError, got ${String(errorField(err, 'name'))}: ${String(errorField(err, 'message'))}`);
        assert.equal(inspectDeep(err).includes(TOKEN), false, 'error leaked the token');
        return true;
      });
      assert.deepEqual(world.remote.calls(), [], 'no client, transport or context call may occur');
      assertStateDirEmpty(world);
    });
  }

  test('capture never executes a caller getter', async () => {
    const world = makeWorld();
    const input = baseInput(world);
    let reads = 0;
    Object.defineProperty(at(input.sarif.runs, 0), 'properties', {
      enumerable: true,
      get() {
        reads += 1;
        return { probe: 1 };
      },
    });
    await assert.rejects(run(world, input), TypeError);
    assert.equal(reads, 0, 'the getter ran during capture');
  });

  test('caller mutation after the call cannot change what is fingerprinted or rendered', async () => {
    const world = makeWorld();
    const input = baseInput(world);
    const pending = run(world, input);
    at(at(input.sarif.runs, 0).results, 0).message.text = 'MUTATED AFTER CALL';
    at(input.sarif.runs, 0).results.push({ message: { text: 'late addition' } });
    input.destination.pullNumber = 99;
    const outcome = await pending;

    assertPublicShape(outcome, 'published');
    const request = sentRequest(world);
    assert.equal(request.pullNumber, DESTINATION.pullNumber);
    assert.equal(request.body.includes('MUTATED'), false);
    assert.equal(request.body.includes('late addition'), false);
    assert.equal(readState(world).inputFingerprint, expectedInputFingerprint(READY));
  });
});

describe('original-input identity', () => {
  test('state binds the independently computed input fingerprint and never the token', async () => {
    const world = makeWorld();
    const outcome = await run(world);
    assertPublicShape(outcome, 'published');
    assert.equal(readState(world).inputFingerprint, expectedInputFingerprint(READY));
    assertTokenAbsent(world, outcome);
  });

  test('the source root and the old-source commit candidate are part of the identity', async () => {
    const world = makeWorld();
    const sourceRootUri = 'file:///work/gizmos/';
    const outcome = await run(world, baseInput(world, { sourceRootUri, oldSourceCommit: BASE }));
    assertPublicShape(outcome, 'published');
    assert.equal(
      readState(world).inputFingerprint,
      expectedInputFingerprint(READY, { sourceRootUri, oldSourceCommit: BASE }),
    );
  });

  test('key order, a different token and the hold override do not change identity', async () => {
    const world = makeWorld();
    const first = await run(world);
    assertPublicShape(first, 'published');
    setAdapterConfig(world.remote.dir, { network: 'down' });
    for (const overrides of [
      { sarif: expectType(reverseKeys(READY), isTestSarif, 'the key-reversed SARIF') },
      { token: 'ghp_a_different_but_valid_token_value' },
      { options: { ignoreApprovalHold: true } },
    ]) {
      const again = await run(world, baseInput(world, overrides));
      assertPublicShape(again, 'published');
      assert.deepEqual(again.review, first.review);
    }
    assert.equal(calls(world, 'adapter:network-attempt').length, 0);
    assert.equal(calls(world, 'createReview').length, 1);
  });

  const changedIdentity: Record<string, (i: TestInput) => unknown> = {
    'different SARIF': (i) => (at(at(i.sarif.runs, 0).results, 0).message.text = 'A different finding.'),
    'different source root': (i) => (i.sourceRootUri = 'file:///elsewhere/gizmos/'),
    'an added old-source commit candidate': (i) => (i.oldSourceCommit = BASE),
    'different pull request': (i) => (i.destination.pullNumber = 8),
    'different reviewed commit': (i) => (i.reviewedCommit = REPOSITORY.commits.advanced),
  };
  for (const [label, change] of Object.entries(changedIdentity)) {
    test(`${label} under an existing state path is refused without context fetch or send`, async () => {
      const world = makeWorld();
      await run(world);
      const fetches = calls(world, 'adapter:fetchContext').length;
      const input = baseInput(world);
      change(input);
      await assert.rejects(run(world, input), (err) => {
        assert.ok(String(errorField(err, 'message')).includes(world.statePath), 'refusal must name the state path');
        assert.match(String(errorField(err, 'message')), /new state path/i);
        return true;
      });
      assert.equal(calls(world, 'adapter:fetchContext').length, fetches);
      assert.equal(calls(world, 'createReview').length, 1);
    });
  }
});

describe('a new publication prepares once and publishes once', () => {
  test('the single create request is exactly the prepared review under the reviewed commit', async () => {
    const world = makeWorld();
    const outcome = await run(world);
    assertPublicShape(outcome, 'published');

    const request = sentRequest(world);
    const prepared = await preparedDirectly(READY);
    assert.equal(prepared.status, 'ready');
    assert.equal(Object.hasOwn(request, 'event'), false, 'draft review must omit the submission event');
    assert.equal(request.owner, DESTINATION.owner);
    assert.equal(request.repo, DESTINATION.repo);
    assert.equal(request.pullNumber, DESTINATION.pullNumber);
    assert.equal(request.commitId, HEAD);
    assert.match(request.body, MARKER);
    assert.equal(request.body.replace(MARKER, ''), prepared.review.body);
    assert.deepEqual(request.comments, prepared.review.comments);

    // Independent facts from the fixture: one inline comment on the added
    // `const MAX = 100;` (new line 4); the location-free result is general.
    assert.equal(request.comments.length, 1);
    assert.equal(request.comments[0]?.path, 'src/app.js');
    assert.equal(request.comments[0].side, 'RIGHT');
    assert.equal(request.comments[0].line, 4);
    assert.ok(request.comments[0].body.includes('MAX is exported but never validated.'));
    assert.ok(request.body.includes('Consider documenting the new limits in the changelog.'));

    const stored = at(world.remote.reviews(), 0);
    assert.deepEqual(outcome.review, { id: stored.id, url: stored.htmlUrl });
    assert.equal(outcome.statePath, world.statePath);
    assertTokenAbsent(world, outcome);
  });

  test('the client receives the token and fetch; context is fetched once for exactly this identity', async () => {
    const world = makeWorld();
    await run(world);
    const creates = calls(world, 'adapter:create');
    assert.equal(creates.length, 1);
    assert.equal(creates[0]?.args['token'], TOKEN);
    assert.equal(creates[0].args['fetchProvided'], true);
    const fetches = calls(world, 'adapter:fetchContext');
    assert.equal(fetches.length, 1);
    assert.deepEqual(fetches[0]?.args, { destination: DESTINATION, reviewedCommit: HEAD });
  });

  test('an explicit old-source commit is only passed to the client as a candidate', async () => {
    const world = makeWorld();
    const outcome = await run(world, baseInput(world, { oldSourceCommit: BASE }));
    assertPublicShape(outcome, 'published');
    const [fetch] = calls(world, 'adapter:fetchContext');
    assert.deepEqual(fetch?.args, { destination: DESTINATION, reviewedCommit: HEAD, oldSourceCommit: BASE });
    const prepared = await preparedDirectly(READY, { oldSourceCommit: BASE });
    assert.deepEqual(sentRequest(world).comments, readyReviewOf(prepared)?.comments);
  });

  test('a historical reviewed commit stays the review commit while the pull request has advanced', async () => {
    const world = makeWorld();
    setAdapterConfig(world.remote.dir, { context: 'historical' });
    const outcome = await run(world);
    assertPublicShape(outcome, 'published');
    const request = sentRequest(world);
    const prepared = await preparedDirectly(READY, { historical: true });
    assert.equal(prepared.status, 'ready');
    assert.equal(request.commitId, HEAD, 'the review must stay pinned to the reviewed commit');
    assert.deepEqual(request.comments, prepared.review.comments);
    // Independent facts: the advanced diff cannot anchor at the reviewed
    // commit, so the located finding is general feedback linked to it.
    assert.equal(request.comments.length, 0);
    assert.ok(request.body.includes(`/blob/${HEAD}/src/app.js`));
    assert.ok(request.body.includes('MAX is exported but never validated.'));
  });

  test('invalid SARIF is blocked with the core diagnostics, no remote write and no state', async () => {
    const world = makeWorld();
    const outcome = await run(world, baseInput(world, { sarif: structuredClone(INVALID) }));
    assertPublicShape(outcome, 'blocked');
    const prepared = await preparedDirectly(INVALID);
    assert.equal(prepared.status, 'blocked');
    assert.ok(outcome.markdown.includes(prepared.markdown), 'blocked Markdown must carry the core diagnostics');
    assertNoRemoteWrites(world);
    assert.equal(calls(world, 'listReviews').length, 0);
    assertStateDirEmpty(world);
  });

  test('an approval hold blocks; the explicit override publishes', async () => {
    const held = makeWorld();
    const blocked = await run(held, baseInput(held, { sarif: structuredClone(HELD) }));
    assertPublicShape(blocked, 'blocked');
    assertNoRemoteWrites(held);
    assertStateDirEmpty(held);

    const overridden = makeWorld();
    const published = await run(
      overridden,
      baseInput(overridden, { sarif: structuredClone(HELD), options: { ignoreApprovalHold: true } }),
    );
    assertPublicShape(published, 'published');
    const prepared = await preparedDirectly(HELD, { ignoreApprovalHold: true });
    assert.deepEqual(sentRequest(overridden).comments, readyReviewOf(prepared)?.comments);
  });

  for (const [mode, label, mention] of [
    ['wrong-commit', 'a context for another commit (no silent substitution of the current head)', /reviewed commit/i],
    ['wrong-pull', 'a context for another pull request', /pull request/i],
  ] as const) {
    test(`${label} is refused before preparation or state`, async () => {
      const world = makeWorld();
      setAdapterConfig(world.remote.dir, { context: mode });
      await assert.rejects(run(world), mention);
      assert.equal(calls(world, 'adapter:fetchContext').length, 1, 'refusal must follow the context fetch');
      assertNoRemoteWrites(world);
      assertStateDirEmpty(world);
    });
  }

  test('a context fetch failure rejects with its cause and leaves no state', async () => {
    const world = makeWorld();
    setAdapterConfig(world.remote.dir, { context: 'throw' });
    await assert.rejects(run(world), /head branch no longer exists/);
    assertNoRemoteWrites(world);
    assertStateDirEmpty(world);
  });

  for (const mode of ['throw-with-token', 'throw-with-token-cause'] as const) {
    test(`an operational error carrying the token (${mode}) rejects without exposing it`, async () => {
      const world = makeWorld();
      setAdapterConfig(world.remote.dir, { context: mode });
      await assert.rejects(run(world), (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /GET \/repos\/acme\/gizmos\/pulls\/7 failed/);
        assert.equal(inspectDeep(err).includes(TOKEN), false, 'the rejection exposes the token');
        return true;
      });
      assertStateDirEmpty(world);
    });
  }

  /** The fake client for `world`, except that fetchContext throws `error`. */
  function contextThrowing(world: IWorld, error: unknown): NonNullable<IPublishSarifReviewInternals['createGitHubClient']> {
    // eslint-disable-next-line @typescript-eslint/require-await -- fetchContext is async by contract: its failure reaches the caller as a rejection
    return (args) => ({ ...world.createGitHubClient(args), fetchContext: async () => { throw error; } });
  }

  test('a redacted rejection keeps the error name and carries only the redacted message chain', async () => {
    // Module doc: an error mentioning the token "is replaced by a redacted
    // error without cause"; withoutCredential keeps the name and drops cause
    // and extra properties. The source error here has no status: whether an
    // absent status is an own undefined key must not change the replacement.
    const world = makeWorld();
    const thrown = new GitHubError('network', 'GET /repos/acme/gizmos/pulls/7 failed', { cause: new Error(`bearer ${TOKEN}`) });
    const err = await publishSarifReview(
      baseInput(world),
      // @ts-expect-error -- the private internals seam is deliberately absent from the public declaration; this test proves the public entry honours it at runtime
      { createGitHubClient: contextThrowing(world, thrown) },
    ).then(
      () => assert.fail('expected a rejection'),
      (e: unknown) => e,
    );
    assert.notEqual(err, thrown, 'an error mentioning the token is replaced');
    assert.ok(err instanceof Error);
    assert.equal(err instanceof GitHubError, false);
    assert.equal(err.name, 'GitHubError');
    assert.equal(err.message, 'GET /repos/acme/gizmos/pulls/7 failed (caused by: bearer [redacted])');
    assert.equal(Object.hasOwn(err, 'cause'), false, 'no cause survives redaction');
    // Characterization of 0.2.0: `name` is assigned, so it is the only own
    // enumerable key; code, status and hostRejected are not carried over.
    assert.deepEqual(Object.keys(err), ['name']);
    assert.equal(inspectDeep(err).includes(TOKEN), false);
    assertStateDirEmpty(world);
  });

  test('an operational error that never mentions the token rejects as the same error, own keys unchanged', async () => {
    const world = makeWorld();
    const thrown = new GitHubError('network', 'GET /repos/acme/gizmos/pulls/7 failed');
    const err = await publishSarifReview(
      baseInput(world),
      // @ts-expect-error -- the private internals seam is deliberately absent from the public declaration; this test proves the public entry honours it at runtime
      { createGitHubClient: contextThrowing(world, thrown) },
    ).then(
      () => assert.fail('expected a rejection'),
      (e: unknown) => e,
    );
    assert.equal(err, thrown, 'a token-free error is passed through, not rebuilt');
    assert.equal(Object.hasOwn(err, 'status'), false, 'an unknown status stays absent');
    assert.deepEqual(Object.keys(err), ['name', 'code', 'hostRejected']);
    assertStateDirEmpty(world);
  });

  test('concurrent calls on one fresh state path send exactly once', async () => {
    const world = makeWorld();
    const outcomes = await Promise.all([run(world), run(world), run(world)]);
    assert.equal(calls(world, 'createReview').length, 1);
    for (const outcome of outcomes) {
      assert.ok(['published', 'uncertain'].includes(outcome.status), JSON.stringify(outcome));
    }
    assert.ok(outcomes.some((o) => o.status === 'published'));
  });
});

describe('existing state is honoured before any branch or source preparation', () => {
  test('a completed receipt returns with no network even when the branch is gone', async () => {
    const world = makeWorld();
    const first = await run(world);
    assertPublicShape(first, 'published');
    const before = world.remote.calls().length;
    setAdapterConfig(world.remote.dir, { network: 'down', context: 'throw' });

    const again = await run(world);
    assertPublicShape(again, 'published');
    assert.deepEqual(again.review, first.review);
    const after = world.remote.calls().slice(before).map((c) => c.method);
    assert.equal(after.includes('adapter:network-attempt'), false);
    assert.equal(after.includes('adapter:fetchContext'), false);
  });

  test('uncertain delivery keeps the saved request, never re-prepares or re-sends, and later recovers', async () => {
    const world = makeWorld({ create: 'lose-response', visibilityDelay: 4 });
    const first = await run(world);
    assertPublicShape(first, 'uncertain');
    assert.equal(first.statePath, world.statePath);
    assertUncertainGuidance(first, world.statePath);
    const fetches = calls(world, 'adapter:fetchContext').length;
    assert.equal(fetches, 1);

    // The branch has since changed: preparing again would fail, and must not happen.
    setAdapterConfig(world.remote.dir, { context: 'throw' });
    let outcome: PublishSarifReviewOutcome = first;
    for (let i = 0; i < 10 && outcome.status === 'uncertain'; i += 1) {
      outcome = await run(world);
      if (outcome.status === 'uncertain') assertUncertainGuidance(outcome, world.statePath);
    }
    assertPublicShape(outcome, 'published');
    assert.equal(outcome.review.id, at(world.remote.reviews(), 0).id);
    assert.equal(calls(world, 'adapter:fetchContext').length, fetches, 'context must not be refetched');
    assert.equal(calls(world, 'createReview').length, 1);
  });

  test('corrupt state rejects without context fetch or send', async () => {
    const world = makeWorld();
    fs.writeFileSync(world.statePath, '{"format":"sarif-to-comment.publication-state","vers', { mode: 0o600 });
    await assert.rejects(run(world), (err) => String(errorField(err, 'message')).includes(world.statePath));
    assert.equal(calls(world, 'adapter:fetchContext').length, 0);
    assert.equal(calls(world, 'createReview').length, 0);
  });

  test('a host rejection is reported, remembered without network, and never resent', async () => {
    const world = makeWorld({ create: 'reject' });
    const outcome = await run(world);
    assertPublicShape(outcome, 'rejected');
    assertRejectedGuidance(outcome, world.statePath);
    world.remote.setConfig({ create: 'ok' });
    setAdapterConfig(world.remote.dir, { network: 'down', context: 'throw' });
    const again = await run(world);
    assertPublicShape(again, 'rejected');
    assertRejectedGuidance(again, world.statePath);
    assert.equal(calls(world, 'createReview').length, 1);
    assert.equal(calls(world, 'adapter:fetchContext').length, 1);
    assert.equal(calls(world, 'adapter:network-attempt').length, 0);
  });

  test("an existing draft by the same account is left for a human; the refusal says so", async () => {
    const world = makeWorld();
    const human = world.remote.seedReview({
      ...DESTINATION,
      authorId: DEFAULT_USER.id,
      authorLogin: DEFAULT_USER.login,
      commitId: HEAD,
      body: 'My unfinished notes.',
      comments: [],
    });
    const outcome = await run(world);
    assertPublicShape(outcome, 'rejected');
    assert.match(outcome.markdown, /one pending review per pull request/);
    assert.match(outcome.markdown, /submit or delete/i);
    assert.deepEqual(world.remote.review(human.id), human);
    assert.deepEqual(world.remote.writeCalls().map((c) => c.method), ['createReview'], 'only the refused create');
  });
});

// ---------------------------------------------------------------------------
// Immediately submitted publication (docs/submitted-review-contract.md)
// ---------------------------------------------------------------------------

/** `input` publishing an immediately submitted review. */
function submitted(input: TestInput): TestInput {
  return { ...input, options: { ...input.options, submit: true } };
}

/** The Markdown link GitHub's review URL is shown with (contract §2.7). */
function reviewLink(outcome: Extract<PublishSarifReviewOutcome, { status: 'published' }>): string {
  return `[review ${String(outcome.review.id)}](${outcome.review.url})`;
}

const WHERE = `${DESTINATION.owner}/${DESTINATION.repo}#${String(DESTINATION.pullNumber)} at commit \`${HEAD}\``;

describe('submitted publication: explicit mode selection (contract §2.1–§2.3, §2.7)', () => {
  test('options.submit publishes the same prepared review as one COMMENT create pinned to the reviewed commit', async () => {
    const world = makeWorld();
    const outcome = await run(world, submitted(baseInput(world)));
    assertPublicShape(outcome, 'published');
    const creates = calls(world, 'createReview');
    assert.equal(creates.length, 1);
    const args = at(creates, 0).args;
    assert.equal(args['event'], 'COMMENT');
    const request = sentRequest(world);
    const prepared = await preparedDirectly(READY);
    assert.equal(prepared.status, 'ready');
    assert.equal(request.commitId, HEAD);
    assert.equal(request.body.replace(MARKER, ''), prepared.review.body);
    assert.deepEqual(request.comments, prepared.review.comments);
    assert.deepEqual(Object.keys(args).sort(), ['body', 'comments', 'commitId', 'event', 'owner', 'pullNumber', 'repo']);

    const stored = at(world.remote.reviews(), 0);
    assert.equal(stored.state, 'COMMENTED');
    assert.deepEqual(outcome.review, { id: stored.id, url: stored.htmlUrl });
    assert.equal(
      outcome.markdown,
      `## Review submitted\n\nCreated and submitted the comment ${reviewLink(outcome)} on ${WHERE}. It is visible on the pull request now.`,
    );
    assertTokenAbsent(world, outcome);
  });

  for (const [label, options] of [
    ['omitted options', undefined],
    ['submit: false', { submit: false }],
  ] as const) {
    test(`draft stays the default (${label}): no event, a pending review and the draft explanation`, async () => {
      const world = makeWorld();
      const input = baseInput(world);
      if (options !== undefined) input.options = options;
      const outcome = await run(world, input);
      assertPublicShape(outcome, 'published');
      assert.equal(Object.hasOwn(at(calls(world, 'createReview'), 0).args, 'event'), false);
      assert.equal(at(world.remote.reviews(), 0).state, 'PENDING');
      assert.equal(
        outcome.markdown,
        `## Draft review published\n\nCreated the draft ${reviewLink(outcome)} on ${WHERE}. It stays a draft until someone submits it on GitHub.`,
      );
    });
  }

  test('the mode is not part of the input fingerprint (it is bound through the saved request)', async () => {
    const draft = makeWorld();
    await run(draft);
    const sub = makeWorld();
    await run(sub, submitted(baseInput(sub)));
    assert.equal(readState(sub).inputFingerprint, readState(draft).inputFingerprint);
  });
});

describe('submitted publication: readiness and targeting apply unchanged (contract §1)', () => {
  test('a historical reviewed commit stays the review commit when submitting', async () => {
    const world = makeWorld();
    setAdapterConfig(world.remote.dir, { context: 'historical' });
    const outcome = await run(world, submitted(baseInput(world)));
    assertPublicShape(outcome, 'published');
    const request = sentRequest(world);
    assert.equal(request.commitId, HEAD, 'the submitted review must stay pinned to the reviewed commit');
    assert.equal(request.comments.length, 0);
    assert.ok(request.body.includes(`/blob/${HEAD}/src/app.js`));
    assert.equal(at(world.remote.reviews(), 0).state, 'COMMENTED');
  });

  test('invalid SARIF is blocked when submitting: no remote write and no state', async () => {
    const world = makeWorld();
    const outcome = await run(world, submitted(baseInput(world, { sarif: structuredClone(INVALID) })));
    assertPublicShape(outcome, 'blocked');
    const prepared = await preparedDirectly(INVALID);
    assert.ok(outcome.markdown.includes(prepared.markdown));
    assertNoRemoteWrites(world);
    assertStateDirEmpty(world);
  });

  test('an approval hold blocks a submitted publication; the explicit override submits it', async () => {
    const held = makeWorld();
    const blocked = await run(held, submitted(baseInput(held, { sarif: structuredClone(HELD) })));
    assertPublicShape(blocked, 'blocked');
    assertNoRemoteWrites(held);
    assertStateDirEmpty(held);

    const overridden = makeWorld();
    const outcome = await run(
      overridden,
      baseInput(overridden, { sarif: structuredClone(HELD), options: { ignoreApprovalHold: true, submit: true } }),
    );
    assertPublicShape(outcome, 'published');
    assert.equal(at(calls(overridden, 'createReview'), 0).args['event'], 'COMMENT');
    const prepared = await preparedDirectly(HELD, { ignoreApprovalHold: true });
    assert.deepEqual(sentRequest(overridden).comments, readyReviewOf(prepared)?.comments);
  });
});

describe('submitted publication: durable identity and retries (contract §2.4, §2.5)', () => {
  test('a lost response is confirmed by readback and never resent; later calls answer from the receipt', async () => {
    const world = makeWorld({ create: 'lose-response' });
    const outcome = await run(world, submitted(baseInput(world)));
    assertPublicShape(outcome, 'published');
    assert.equal(
      outcome.markdown,
      `## Review submitted\n\nThe submitted comment ${reviewLink(outcome)} on ${WHERE} was confirmed on GitHub for this publication; nothing was resent.`,
    );
    setAdapterConfig(world.remote.dir, { network: 'down', context: 'throw' });
    const again = await run(world, submitted(baseInput(world)));
    assertPublicShape(again, 'published');
    assert.equal(
      again.markdown,
      `## Review submitted\n\nThe submitted comment ${reviewLink(again)} on ${WHERE} was already published; its completion is recorded at \`${world.statePath}\`. Nothing was sent.`,
    );
    assert.equal(calls(world, 'createReview').length, 1);
    assert.equal(world.remote.reviews().length, 1);
  });

  for (const [first, second] of [
    ['draft', 'submitted'],
    ['submitted', 'draft'],
  ] as const) {
    test(`a ${first} state path reused for a ${second} publication is refused before any context fetch or send`, async () => {
      const world = makeWorld();
      const firstInput = baseInput(world);
      assertPublicShape(await run(world, first === 'submitted' ? submitted(firstInput) : firstInput), 'published');
      const secondInput = baseInput(world);
      await assert.rejects(run(world, second === 'submitted' ? submitted(secondInput) : secondInput), (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, new RegExp(`records a ${first} review, but a ${second} review was requested`));
        assert.equal(inspectDeep(err).includes(TOKEN), false);
        return true;
      });
      assert.equal(calls(world, 'adapter:fetchContext').length, 1, 'only the first publication fetched context');
      assert.equal(calls(world, 'createReview').length, 1);
    });
  }

  test("an existing draft by the same account refuses the submitted create too; the refusal says so", async () => {
    const world = makeWorld();
    const human = world.remote.seedReview({
      ...DESTINATION,
      authorId: DEFAULT_USER.id,
      authorLogin: DEFAULT_USER.login,
      commitId: HEAD,
      body: 'My unfinished notes.',
      comments: [],
    });
    const outcome = await run(world, submitted(baseInput(world)));
    assertPublicShape(outcome, 'rejected');
    assertRejectedGuidance(outcome, world.statePath);
    assert.match(outcome.markdown, /one pending review per pull request/);
    assert.match(outcome.markdown, /submit or delete/i);
    assert.deepEqual(world.remote.review(human.id), human);
  });
});
