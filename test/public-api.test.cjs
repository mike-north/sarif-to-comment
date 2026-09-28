'use strict';

/**
 * Contract tests for the public library operation publishSarifReview
 * (src/index.cjs).
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
 * by a file-backed host double shaped like src/github.cjs; mocks are not
 * evidence of GitHub behavior.
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://www.rfc-editor.org/rfc/rfc8259 (JSON values)
 * @see https://www.rfc-editor.org/rfc/rfc8089 (file URI scheme)
 */

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');

const { publishSarifReview } = require('../dist/index.cjs');
const { GitHubError } = require('../dist/github.cjs');
const { prepareReview } = require('../dist/prepare-review.cjs');
const { FakeGitHubRemote, DEFAULT_USER } = require('./fixtures/publication/fake-github.cjs');
const {
  REPOSITORY,
  createFakeClientFactory,
  readSource,
  setAdapterConfig,
  trustedContext,
} = require('./fixtures/public-api/fake-adapter.cjs');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'public-api');
const loadSarif = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
const READY = loadSarif('ready.sarif.json');
const HELD = loadSarif('held.sarif.json');
const INVALID = loadSarif('invalid.sarif.json');

const DESTINATION = REPOSITORY.destination;
const HEAD = REPOSITORY.commits.head;
const BASE = REPOSITORY.commits.base;
const TOKEN = 'ghp_PUBLICAPI_SENTINEL_token_value_0123456789';
const MARKER = /\n\n<!-- sarif-to-comment:review:[0-9a-f-]{36} -->$/;

// ---------------------------------------------------------------------------
// Independent fingerprint (spec in src/index.cjs: sha256 over canonical JSON
// with recursively sorted keys, no insignificant whitespace, UTF-8)
// ---------------------------------------------------------------------------

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

/** Deep copy with object keys in reverse order at every level. */
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).reverse().map((k) => [k, reverseKeys(value[k])]));
  }
  return value;
}

// ---------------------------------------------------------------------------
// World and helpers
// ---------------------------------------------------------------------------

function makeWorld(hostConfig = {}) {
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

function baseInput(world, overrides = {}) {
  return {
    sarif: structuredClone(READY),
    destination: { ...DESTINATION },
    reviewedCommit: HEAD,
    statePath: world.statePath,
    token: TOKEN,
    ...overrides,
  };
}

function run(world, input = baseInput(world)) {
  return publishSarifReview(input, { createGitHubClient: world.createGitHubClient });
}

function calls(world, method) {
  return world.remote.calls(method);
}

function assertNoRemoteWrites(world) {
  assert.deepEqual(world.remote.writeCalls().map((c) => c.method), [], 'no remote write may occur');
}

function assertStateDirEmpty(world) {
  assert.deepEqual(fs.readdirSync(world.stateDir), [], 'no publication state may be written');
}

function stateText(world) {
  return fs
    .readdirSync(world.stateDir)
    .map((name) => fs.readFileSync(path.join(world.stateDir, name), 'utf8'))
    .join('\n');
}

function assertTokenAbsent(world, outcome) {
  assert.equal(stateText(world).includes(TOKEN), false, 'token reached publication state');
  if (outcome) assert.equal(JSON.stringify(outcome).includes(TOKEN), false, 'token reached the outcome');
}

/** Everything an inspecting caller could see of a rejection, including causes and hidden properties. */
function inspectDeep(err) {
  return util.inspect(err, { depth: null, showHidden: true });
}

/** Exact public shape per status: no internal codes, evidence or diagnostics. */
function assertPublicShape(outcome, status) {
  assert.equal(outcome.status, status, `expected ${status}, got ${JSON.stringify(outcome)}`);
  const keys = {
    published: ['markdown', 'review', 'statePath', 'status'],
    blocked: ['markdown', 'status'],
    uncertain: ['markdown', 'statePath', 'status'],
    rejected: ['markdown', 'statePath', 'status'],
  }[status];
  assert.deepEqual(Object.keys(outcome).sort(), keys);
  // Field order is the documented outcome order (src/index.cjs module doc,
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
  if (status === 'published') {
    assert.deepEqual(Object.keys(outcome.review), ['id', 'url']);
    assert.ok(outcome.markdown.includes(outcome.review.url), 'published Markdown must link the review');
  }
}

/** Guidance for uncertain delivery: keep and reuse the state path; never resend. */
function assertUncertainGuidance(outcome, statePath) {
  assert.ok(outcome.markdown.includes(statePath), 'Markdown must name the preserved state path');
  assert.match(outcome.markdown, /same state path/i);
  assert.match(outcome.markdown, /do not delete/i);
  assert.match(outcome.markdown, /new state path[^.]*separate review/i);
}

/** Guidance for a definitive refusal: named state path, never resent, new path after fixing. */
function assertRejectedGuidance(outcome, statePath) {
  assert.ok(outcome.markdown.includes(statePath));
  assert.match(outcome.markdown, /never resent/i);
  assert.match(outcome.markdown, /new state path/i);
}

/** What prepareReview itself produces for this SARIF and the fixture context. */
async function preparedDirectly(sarif, { ignoreApprovalHold, sourceRootUri, historical, oldSourceCommit } = {}) {
  const context = trustedContext({ historical, oldSourceCommit });
  if (sourceRootUri !== undefined) context.sourceRootUri = sourceRootUri;
  const input = { sarif: structuredClone(sarif), context, readSource };
  if (ignoreApprovalHold !== undefined) input.options = { ignoreApprovalHold };
  return prepareReview(input);
}

function sentRequest(world) {
  const creates = calls(world, 'createReview');
  assert.equal(creates.length, 1, `expected exactly one create-review attempt, saw ${creates.length}`);
  return creates[0].args;
}

function readState(world) {
  return JSON.parse(fs.readFileSync(world.statePath, 'utf8'));
}

// ===========================================================================
// Tests
// ===========================================================================

describe('harness control: the injected context is coherent', () => {
  for (const [label, diff, head] of [
    ['reviewed head', REPOSITORY.diff, HEAD],
    ['advanced head', REPOSITORY.advancedDiff, REPOSITORY.commits.advanced],
  ]) {
    test(`the authored patch reproduces both authored snapshots exactly (${label})`, () => {
      const [file] = diff.files;
      const body = file.patch.slice(1); // one hunk covering the whole file
      const side = (keep) => body.filter((l) => keep.includes(l[0])).map((l) => l.slice(1)).join('');
      assert.equal(side(' -'), REPOSITORY.snapshots[BASE][file.path].join(''));
      assert.equal(side(' +'), REPOSITORY.snapshots[head][file.path].join(''));
      assert.equal(diff.headCommit, head);
    });
  }

  test('the fake client serves the fixture context, logs calls and honours its modes', async () => {
    const world = makeWorld();
    const client = world.createGitHubClient({ token: TOKEN, fetch: globalThis.fetch });
    const { context, readSource: reader } = await client.fetchContext({ destination: DESTINATION, reviewedCommit: HEAD });
    assert.equal(context.reviewedCommit, HEAD);
    assert.equal(context.diff.headCommit, HEAD);
    assert.equal(await reader(HEAD, 'src/app.js'), REPOSITORY.snapshots[HEAD]['src/app.js'].join(''));
    assert.equal(await reader(HEAD, 'absent.js'), null);
    assert.deepEqual(calls(world, 'adapter:create').map((c) => c.args.token), [TOKEN]);

    setAdapterConfig(world.remote.dir, { network: 'down' });
    const offline = world.createGitHubClient({ token: TOKEN, fetch: globalThis.fetch });
    await assert.rejects(offline.listReviews({ ...DESTINATION, cursor: null }), /ENOTFOUND/);
    assert.equal(calls(world, 'adapter:network-attempt').length, 1);
  });
});

describe('input is validated and captured before any remote read', () => {
  const inRun = (value) => (i) => {
    i.sarif.runs[0].properties = { probe: value };
  };
  class Custom {
    constructor() {
      this.x = 1;
    }
  }
  const cyclic = (i) => {
    const node = { name: 'loop' };
    node.self = node;
    i.sarif.runs[0].properties = { node };
  };
  const invalid = {
    'missing sarif': (i) => delete i.sarif,
    'null sarif': (i) => (i.sarif = null),
    'array sarif': (i) => (i.sarif = [READY]),
    'string sarif (not parsed)': (i) => (i.sarif = JSON.stringify(READY)),
    'cyclic sarif': cyclic,
    'function value': inRun(() => 1),
    'undefined property value': inRun(undefined),
    'undefined array element': inRun([1, undefined]),
    'sparse array hole': inRun([1, , 3]), // eslint-disable-line no-sparse-arrays -- the array hole is the input under test
    'NaN': inRun(Number.NaN),
    'Infinity': inRun(Number.POSITIVE_INFINITY),
    'negative zero': inRun(-0),
    'BigInt': inRun(10n),
    'Date object': inRun(new Date('2026-09-27T00:00:00.000Z')),
    'Map object': inRun(new Map([['a', 1]])),
    'class instance': inRun(new Custom()),
    'symbol-keyed property': inRun({ [Symbol('hidden')]: 1 }),
    'accessor property': inRun(Object.defineProperty({}, 'computed', { enumerable: true, get: () => 'varies' })),
    'missing destination': (i) => delete i.destination,
    'owner containing a slash': (i) => (i.destination.owner = 'acme/other'),
    'zero pull number': (i) => (i.destination.pullNumber = 0),
    'string pull number': (i) => (i.destination.pullNumber = '7'),
    'short reviewed commit': (i) => (i.reviewedCommit = HEAD.slice(0, 12)),
    'uppercase reviewed commit': (i) => (i.reviewedCommit = 'A'.repeat(40)),
    'short old-source commit': (i) => (i.oldSourceCommit = BASE.slice(0, 7)),
    'non-string old-source commit': (i) => (i.oldSourceCommit = 1234),
    'missing state path': (i) => delete i.statePath,
    'relative state path': (i) => (i.statePath = 'state/review.publication.json'),
    'missing token': (i) => delete i.token,
    'empty token': (i) => (i.token = ''),
    'non-string token': (i) => (i.token = 12345),
    'relative source root': (i) => (i.sourceRootUri = 'work/gizmos/'),
    'non-file source root': (i) => (i.sourceRootUri = 'https://example.com/gizmos/'),
    'source root without trailing slash': (i) => (i.sourceRootUri = 'file:///work/gizmos'),
    'unknown option': (i) => (i.options = { ignoreApprovalHolds: true }),
    'non-boolean override': (i) => (i.options = { ignoreApprovalHold: 'yes' }),
    'array options': (i) => (i.options = []),
    'unknown top-level field': (i) => (i.reviewCommit = HEAD),
  };

  for (const [label, breakIt] of Object.entries(invalid)) {
    test(`${label} is refused with TypeError before any client or state use`, async () => {
      const world = makeWorld();
      const input = baseInput(world);
      breakIt(input);
      await assert.rejects(run(world, input), (err) => {
        assert.ok(err instanceof TypeError, `expected TypeError, got ${err && err.name}: ${err && err.message}`);
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
    Object.defineProperty(input.sarif.runs[0], 'properties', {
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
    input.sarif.runs[0].results[0].message.text = 'MUTATED AFTER CALL';
    input.sarif.runs[0].results.push({ message: { text: 'late addition' } });
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
      { sarif: reverseKeys(READY) },
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

  const changedIdentity = {
    'different SARIF': (i) => (i.sarif.runs[0].results[0].message.text = 'A different finding.'),
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
        assert.ok(String(err.message).includes(world.statePath), 'refusal must name the state path');
        assert.match(String(err.message), /new state path/i);
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
    assert.equal(request.comments[0].path, 'src/app.js');
    assert.equal(request.comments[0].side, 'RIGHT');
    assert.equal(request.comments[0].line, 4);
    assert.ok(request.comments[0].body.includes('MAX is exported but never validated.'));
    assert.ok(request.body.includes('Consider documenting the new limits in the changelog.'));

    const [stored] = world.remote.reviews();
    assert.deepEqual(outcome.review, { id: stored.id, url: stored.htmlUrl });
    assert.equal(outcome.statePath, world.statePath);
    assertTokenAbsent(world, outcome);
  });

  test('the client receives the token and fetch; context is fetched once for exactly this identity', async () => {
    const world = makeWorld();
    await run(world);
    const creates = calls(world, 'adapter:create');
    assert.equal(creates.length, 1);
    assert.equal(creates[0].args.token, TOKEN);
    assert.equal(creates[0].args.fetchProvided, true);
    const fetches = calls(world, 'adapter:fetchContext');
    assert.equal(fetches.length, 1);
    assert.deepEqual(fetches[0].args, { destination: DESTINATION, reviewedCommit: HEAD });
  });

  test('an explicit old-source commit is only passed to the client as a candidate', async () => {
    const world = makeWorld();
    const outcome = await run(world, baseInput(world, { oldSourceCommit: BASE }));
    assertPublicShape(outcome, 'published');
    const [fetch] = calls(world, 'adapter:fetchContext');
    assert.deepEqual(fetch.args, { destination: DESTINATION, reviewedCommit: HEAD, oldSourceCommit: BASE });
    const prepared = await preparedDirectly(READY, { oldSourceCommit: BASE });
    assert.deepEqual(sentRequest(world).comments, prepared.review.comments);
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
    assert.deepEqual(sentRequest(overridden).comments, prepared.review.comments);
  });

  for (const [mode, label, mention] of [
    ['wrong-commit', 'a context for another commit (no silent substitution of the current head)', /reviewed commit/i],
    ['wrong-pull', 'a context for another pull request', /pull request/i],
  ]) {
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

  for (const mode of ['throw-with-token', 'throw-with-token-cause']) {
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
  function contextThrowing(world, error) {
    return (args) => ({ ...world.createGitHubClient(args), fetchContext: async () => { throw error; } });
  }

  test('a redacted rejection keeps the error name and carries only the redacted message chain', async () => {
    // Module doc: an error mentioning the token "is replaced by a redacted
    // error without cause"; withoutCredential keeps the name and drops cause
    // and extra properties. The source error here has no status: whether an
    // absent status is an own undefined key must not change the replacement.
    const world = makeWorld();
    const thrown = new GitHubError('network', 'GET /repos/acme/gizmos/pulls/7 failed', { cause: new Error(`bearer ${TOKEN}`) });
    const err = await publishSarifReview(baseInput(world), { createGitHubClient: contextThrowing(world, thrown) }).then(
      () => assert.fail('expected a rejection'),
      (e) => e,
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
    const err = await publishSarifReview(baseInput(world), { createGitHubClient: contextThrowing(world, thrown) }).then(
      () => assert.fail('expected a rejection'),
      (e) => e,
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
    let outcome = first;
    for (let i = 0; i < 10 && outcome.status === 'uncertain'; i += 1) {
      outcome = await run(world);
      if (outcome.status === 'uncertain') assertUncertainGuidance(outcome, world.statePath);
    }
    assertPublicShape(outcome, 'published');
    assert.equal(outcome.review.id, world.remote.reviews()[0].id);
    assert.equal(calls(world, 'adapter:fetchContext').length, fetches, 'context must not be refetched');
    assert.equal(calls(world, 'createReview').length, 1);
  });

  test('corrupt state rejects without context fetch or send', async () => {
    const world = makeWorld();
    fs.writeFileSync(world.statePath, '{"format":"sarif-to-comment.publication-state","vers', { mode: 0o600 });
    await assert.rejects(run(world), (err) => String(err.message).includes(world.statePath));
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
