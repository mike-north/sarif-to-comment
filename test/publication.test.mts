'use strict';

/**
 * Contract tests for durable initial publication (src/publication.cjs).
 *
 * The coordinator receives a wholly validated prepared review and must create
 * exactly one GitHub draft review from it: body plus every inline comment in
 * one create-review request against the explicit reviewed commit, with no
 * submission event. Its delivery identity is a caller-chosen state file whose
 * complete intent record — original-input identity plus the complete intended
 * request — is exclusively created and durably flushed (file and parent
 * directory) before the single send. Any later invocation that finds that
 * record may only return a completed receipt or investigate the host for the
 * record's marker using the saved request; it never sends again. Delivery,
 * including after a positive create response, is complete only when the host
 * reads back the exact body and every comment anchor. Completed publication is
 * final (D29): human changes are neither inspected nor restored.
 *
 * Remote behavior comes from a file-backed double whose persistence is
 * independent of local state (test/fixtures/publication/fake-github.mts).
 * Expected request values are hand-authored in prepared-review.json separately
 * from the input, and the record's request fingerprint is recomputed here with
 * an independent canonicalizer. Oracles for "exactly one create", "no other
 * writes", "durable intent before send" and "atomic durable receipt" are each
 * shown to reject a deliberately faulty publisher and accept a correct
 * reference sequence, so passing tests cannot be vacuous.
 *
 * These doubles do not establish GitHub behavior (atomicity, readback shape,
 * visibility timing); that requires separate real-host evidence.
 *
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/reviews#list-comments-for-a-pull-request-review
 * @see https://docs.github.com/en/rest/users/users#get-the-authenticated-user
 * @see https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html (O_CREAT|O_EXCL)
 * @see https://pubs.opengroup.org/onlinepubs/9799919799/functions/link.html
 * @see https://pubs.opengroup.org/onlinepubs/9799919799/functions/fsync.html
 * @see https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html
 */

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  publishPreparedReview,
  recoverPublication,
  PublicationStateError,
} = require('../dist/publication.cjs');
const { FakeGitHubRemote, DEFAULT_USER, SENTINEL_TOKEN } = require('./fixtures/publication/fake-github.mts');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'publication');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'prepared-review.json'), 'utf8'));
const EXPECTED = FIXTURE.expectedRequest;
const CHILD = path.join(FIXTURE_DIR, 'child-publish.mts');

/** Proposed marker form: one hidden HTML comment carrying a v4 UUID. */
const MARKER_SOURCE =
  '<!-- sarif-to-comment:review:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} -->';
const MARKER_ANY = new RegExp(MARKER_SOURCE, 'g');
const MARKER_EXACT = new RegExp(`^${MARKER_SOURCE}$`);
const STATE_FORMAT = 'sarif-to-comment.publication-state';
/** A syntactically valid marker belonging to no publication under test. */
const FOREIGN_MARKER = '<!-- sarif-to-comment:review:0b6f2e1c-5a4d-4e3f-9c2b-1a0f9e8d7c6b -->';
const OTHER_FINGERPRINT = `sha256:${'e'.repeat(64)}`;

// ---------------------------------------------------------------------------
// Independent canonical fingerprint (spec: sha256 over JSON with recursively
// sorted object keys and no insignificant whitespace, UTF-8 encoded)
// ---------------------------------------------------------------------------

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprintOf(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// World construction
// ---------------------------------------------------------------------------

/**
 * A fresh isolated world: a publication state directory and an independent
 * fake remote, both on disk under one temp root.
 */
function makeWorld(config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  const remote = FakeGitHubRemote.create(path.join(root, 'remote'), config);
  return { root, stateDir, statePath: path.join(stateDir, 'review.publication.json'), remote };
}

/** Publication input for `world`; `mutate` edits a deep copy of the fixture input. */
function makeInput(world, { statePath = world.statePath, user, events, mutate } = {}) {
  const base = structuredClone(FIXTURE.input);
  if (mutate) mutate(base);
  return {
    destination: base.destination,
    reviewedCommit: base.reviewedCommit,
    inputFingerprint: base.inputFingerprint,
    preparedReview: base.preparedReview,
    statePath,
    transport: world.remote.transport({ user, events }),
  };
}

function publish(world, options) {
  return publishPreparedReview(makeInput(world, options));
}

/** Recovery input: the same identity, but no prepared review at all. */
function recover(world, options) {
  const { preparedReview: _unused, ...input } = makeInput(world, options);
  return recoverPublication(input);
}

function readRecord(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

/** The single marker in a body; fails if there is not exactly one. */
function extractMarker(body) {
  const found = body.match(MARKER_ANY) || [];
  assert.equal(found.length, 1, `expected exactly one publication marker in body, found ${found.length}`);
  return found[0];
}

/** The hand-authored request this publication must send, given its marker. */
function expectedRequest(marker) {
  return {
    owner: EXPECTED.owner,
    repo: EXPECTED.repo,
    pullNumber: EXPECTED.pullNumber,
    commitId: EXPECTED.commitId,
    body: `${EXPECTED.bodyBeforeMarker}\n\n${marker}`,
    comments: EXPECTED.comments,
  };
}

/** The marker the coordinator sent in its (single) create attempt. */
function sentMarker(remote) {
  const [create] = remote.calls('createReview');
  assert.ok(create, 'no create-review attempt was recorded');
  return extractMarker(create.args.body);
}

/** A complete, consistent sending intent built only from the spec. */
function handBuiltIntent(marker = '<!-- sarif-to-comment:review:1c9a7e52-3b4d-4f6a-8e1d-2c3b4a5f6e7d -->') {
  const request = expectedRequest(marker);
  return {
    format: STATE_FORMAT,
    version: 1,
    phase: 'sending',
    marker,
    destination: { owner: 'octo-org', repo: 'widgets', pullNumber: 42 },
    reviewedCommit: EXPECTED.commitId,
    inputFingerprint: FIXTURE.input.inputFingerprint,
    authorId: DEFAULT_USER.id,
    request,
    requestFingerprint: fingerprintOf(request),
  };
}

/** Copy of a record whose request was edited and whose fingerprint was recomputed to match. */
function rehashed(record, editRequest) {
  const copy = structuredClone(record);
  editRequest(copy.request);
  copy.requestFingerprint = fingerprintOf(copy.request);
  return copy;
}

// ---------------------------------------------------------------------------
// Oracles (each validated against faulty and reference publishers below)
// ---------------------------------------------------------------------------

function assertExactlyOneCreateAttempt(remote) {
  const creates = remote.calls('createReview');
  assert.equal(creates.length, 1, `expected exactly one create-review attempt, saw ${creates.length}`);
}

function assertNoCreateAttempt(remote) {
  assert.equal(remote.calls('createReview').length, 0, 'a create-review attempt was made');
}

function assertNoWriteOtherThanCreate(remote) {
  const others = remote.writeCalls().filter((c) => c.method !== 'createReview');
  assert.deepEqual(
    others.map((c) => c.method),
    [],
    'publisher issued a remote write other than the single create-review',
  );
}

function findLastIndex(list, predicate, before = list.length) {
  for (let i = before - 1; i >= 0; i -= 1) if (predicate(list[i])) return i;
  return -1;
}

/**
 * The state record's directory entry was created, its contents were written
 * and flushed, and its parent directory was flushed after the entry existed —
 * all before the first create-review request.
 */
function assertDurableIntentBeforeSend(events, statePath) {
  const target = path.resolve(statePath);
  const dir = path.dirname(target);
  const sendIdx = events.findIndex((e) => e.op === 'createReview');
  assert.ok(sendIdx >= 0, 'no create-review request was sent');

  let entryIdx = -1;
  let dataPath = target;
  for (let i = 0; i < sendIdx; i += 1) {
    const e = events[i];
    if ((e.op === 'link' || e.op === 'rename') && e.path === target) {
      entryIdx = i;
      dataPath = e.from;
    } else if (e.op === 'open' && e.path === target && e.created) {
      entryIdx = i;
      dataPath = target;
    }
  }
  assert.ok(entryIdx >= 0, 'state record entry was not created before the create-review request');

  const holders = new Set([dataPath, target]);
  const lastWrite = findLastIndex(events, (e) => e.op === 'write' && holders.has(e.path), sendIdx);
  assert.ok(lastWrite >= 0, 'state record contents were not written before the send');
  const fileFlush = events.findIndex(
    (e, i) => i > lastWrite && i < sendIdx && e.op === 'fsync' && holders.has(e.path),
  );
  assert.ok(fileFlush >= 0, 'state record contents were not flushed after their last write and before the send');
  const dirFlush = events.findIndex(
    (e, i) => i > entryIdx && i < sendIdx && e.op === 'fsync' && e.path === dir,
  );
  assert.ok(dirFlush >= 0, 'parent directory was not flushed after the state entry was created and before the send');
}

/**
 * After the create returned, the completed receipt replaced the state record
 * only via rename of a flushed sibling file, followed by a directory flush;
 * the live state record was never opened for writing in place.
 */
function assertAtomicDurableReceipt(events, statePath) {
  assertAtomicDurableReplacement(events, statePath, 'createReview:returned');
}

/** The same atomic, durable replacement discipline for a persisted host rejection. */
function assertAtomicDurableRejection(events, statePath) {
  assertAtomicDurableReplacement(events, statePath, 'createReview:rejected');
}

/**
 * After the transport event `startOp`, the state record was replaced only via
 * rename of a flushed sibling file followed by a directory flush, and was never
 * opened for writing in place.
 */
function assertAtomicDurableReplacement(events, statePath, startOp) {
  const target = path.resolve(statePath);
  const dir = path.dirname(target);
  const start = events.findIndex((e) => e.op === startOp);
  assert.ok(start >= 0, `transport event ${startOp} never happened`);
  const after = events.slice(start + 1);
  const inPlace = after.filter((e) => (e.op === 'write' || e.op === 'open') && e.path === target);
  assert.deepEqual(inPlace, [], 'state record was rewritten in place after sending');
  const renameIdx = findLastIndex(after, (e) => e.op === 'rename' && e.path === target);
  assert.ok(renameIdx >= 0, 'receipt was not atomically renamed onto the state path');
  const tmp = after[renameIdx].from;
  assert.equal(path.dirname(tmp), dir, 'receipt temp file must live beside the state record');
  const lastWrite = findLastIndex(after, (e) => e.op === 'write' && e.path === tmp, renameIdx);
  assert.ok(lastWrite >= 0, 'receipt contents were never written');
  const fileFlush = after.findIndex(
    (e, i) => i > lastWrite && i < renameIdx && e.op === 'fsync' && e.path === tmp,
  );
  assert.ok(fileFlush >= 0, 'receipt contents were not flushed before rename');
  const dirFlush = after.findIndex((e, i) => i > renameIdx && e.op === 'fsync' && e.path === dir);
  assert.ok(dirFlush >= 0, 'parent directory was not flushed after the receipt rename');
}

/**
 * node:fs wrapped to record state-file operations into `events`, in order,
 * alongside the transport's send markers. `faults` may throw from fsync or
 * rename to simulate local I/O failure.
 */
function recordingFs(events, faults = {}) {
  const fdPaths = new Map();
  const abs = (p) => path.resolve(String(p));
  const wrapped = {
    openSync(p, flags, mode) {
      const existed = fs.existsSync(p);
      const fd = fs.openSync(p, flags, mode);
      fdPaths.set(fd, abs(p));
      events.push({ op: 'open', path: abs(p), created: !existed });
      return fd;
    },
    writeSync(fd, ...rest) {
      const n = fs.writeSync(fd, ...rest);
      events.push({ op: 'write', path: fdPaths.get(fd) });
      return n;
    },
    writeFileSync(target, ...rest) {
      const p = typeof target === 'number' ? fdPaths.get(target) : abs(target);
      const existed = typeof target === 'number' || fs.existsSync(target);
      fs.writeFileSync(target, ...rest);
      events.push({ op: 'open', path: p, created: !existed });
      events.push({ op: 'write', path: p });
    },
    appendFileSync(target, ...rest) {
      const p = typeof target === 'number' ? fdPaths.get(target) : abs(target);
      const existed = typeof target === 'number' || fs.existsSync(target);
      fs.appendFileSync(target, ...rest);
      events.push({ op: 'open', path: p, created: !existed });
      events.push({ op: 'write', path: p });
    },
    ftruncateSync(fd, len) {
      fs.ftruncateSync(fd, len);
      events.push({ op: 'write', path: fdPaths.get(fd) });
    },
    fsyncSync(fd) {
      if (faults.fsync) faults.fsync(fdPaths.get(fd));
      fs.fsyncSync(fd);
      events.push({ op: 'fsync', path: fdPaths.get(fd) });
    },
    fdatasyncSync(fd) {
      if (faults.fsync) faults.fsync(fdPaths.get(fd));
      fs.fdatasyncSync(fd);
      events.push({ op: 'fsync', path: fdPaths.get(fd) });
    },
    closeSync(fd) {
      fs.closeSync(fd);
      events.push({ op: 'close', path: fdPaths.get(fd) });
      fdPaths.delete(fd);
    },
    linkSync(from, to) {
      fs.linkSync(from, to);
      events.push({ op: 'link', from: abs(from), path: abs(to) });
    },
    renameSync(from, to) {
      if (faults.rename) faults.rename(abs(from), abs(to));
      fs.renameSync(from, to);
      events.push({ op: 'rename', from: abs(from), path: abs(to) });
    },
  };
  return new Proxy(fs, { get: (t, k) => (Object.hasOwn(wrapped, k) ? wrapped[k] : t[k]) });
}

function ioError(message) {
  return Object.assign(new Error(`EIO: ${message}`), { code: 'EIO' });
}

function isStateError(code) {
  return (err) => err instanceof PublicationStateError && err.code === code;
}

// ---------------------------------------------------------------------------
// Child processes (restart and cross-process concurrency)
// ---------------------------------------------------------------------------

function parseChildOutput(stdout) {
  const lines = stdout.trim().split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

function runChild(world, extra = {}) {
  const args = { statePath: world.statePath, remoteDir: world.remote.dir, ...extra };
  const run = spawnSync(process.execPath, [CHILD, JSON.stringify(args)], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { signal: run.signal, status: run.status, stderr: run.stderr, out: parseChildOutput(run.stdout) };
}

function startChild(world, extra = {}) {
  const args = { statePath: world.statePath, remoteDir: world.remote.dir, ...extra };
  const child = spawn(process.execPath, [CHILD, JSON.stringify(args)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  return new Promise((resolve) => {
    child.on('close', (status, signal) => resolve({ status, signal, stderr, out: parseChildOutput(stdout) }));
  });
}

// ---------------------------------------------------------------------------
// Test-local publishers used only to prove the oracles discriminate
// ---------------------------------------------------------------------------

const CONTROL_MARKER = '<!-- sarif-to-comment:review:5d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a -->';

function requestFor(input, marker) {
  return {
    ...input.destination,
    commitId: input.reviewedCommit,
    body: `${input.preparedReview.body}\n\n${marker}`,
    comments: input.preparedReview.comments,
  };
}

function writeFlushed(fsImpl, file, text, flags) {
  const fd = fsImpl.openSync(file, flags, 0o600);
  fsImpl.writeSync(fd, text);
  fsImpl.fsyncSync(fd);
  fsImpl.closeSync(fd);
}

function flushDir(fsImpl, dir) {
  const fd = fsImpl.openSync(dir, 'r');
  fsImpl.fsyncSync(fd);
  fsImpl.closeSync(fd);
}

/** Correct reference: exclusive create, flush file and directory, then send. */
async function referenceIntentThenSend(input, fsImpl) {
  writeFlushed(fsImpl, input.statePath, '{"phase":"sending"}', 'wx');
  flushDir(fsImpl, path.dirname(input.statePath));
  return input.transport.createReview(requestFor(input, CONTROL_MARKER));
}

/** Faulty: sends before any durable intent exists. */
async function faultySendBeforePersist(input, fsImpl) {
  await input.transport.createReview(requestFor(input, CONTROL_MARKER));
  writeFlushed(fsImpl, input.statePath, '{"phase":"sending"}', 'wx');
  flushDir(fsImpl, path.dirname(input.statePath));
}

/** Faulty: flushes the file but never the directory entry before sending. */
async function faultyNoDirectoryFlush(input, fsImpl) {
  writeFlushed(fsImpl, input.statePath, '{"phase":"sending"}', 'wx');
  return input.transport.createReview(requestFor(input, CONTROL_MARKER));
}

/** Correct reference receipt: flushed sibling, rename, directory flush. */
function referenceAtomicReceipt(input, fsImpl) {
  const tmp = `${input.statePath}.receipt-tmp`;
  writeFlushed(fsImpl, tmp, '{"phase":"completed"}', 'wx');
  fsImpl.renameSync(tmp, input.statePath);
  flushDir(fsImpl, path.dirname(input.statePath));
}

/** Faulty receipt: truncates and rewrites the live record in place. */
function faultyInPlaceReceipt(input, fsImpl) {
  writeFlushed(fsImpl, input.statePath, '{"phase":"completed"}', 'w');
  flushDir(fsImpl, path.dirname(input.statePath));
}

/** Faulty: treats a lookup miss after a lost response as permission to resend. */
async function faultyRetryOnMiss(input) {
  const request = requestFor(input, CONTROL_MARKER);
  try {
    return await input.transport.createReview(request);
  } catch {
    const page = await input.transport.listReviews({ ...input.destination, cursor: null });
    if (!page.reviews.some((r) => r.body.includes(CONTROL_MARKER))) {
      // The resend's own response may be lost too; the duplicate still lands.
      return input.transport.createReview(request).catch(() => null);
    }
  }
  return null;
}

/** Faulty: "repairs" a marker candidate by adding the comments it lacks. */
async function faultyRepairMissingComments(input) {
  try {
    await input.transport.createReview(requestFor(input, CONTROL_MARKER));
  } catch {
    const page = await input.transport.listReviews({ ...input.destination, cursor: null });
    const found = page.reviews.find((r) => r.body.includes(CONTROL_MARKER));
    const { comments } = await input.transport.listReviewComments({
      ...input.destination,
      reviewId: found.id,
      cursor: null,
    });
    for (const wanted of input.preparedReview.comments.slice(comments.length)) {
      await input.transport.createReviewComment({ reviewId: found.id, ...wanted });
    }
  }
}

/** Faulty: check-then-write claim instead of exclusive creation. */
async function faultyNonExclusiveClaim(input) {
  if (fs.existsSync(input.statePath)) return null;
  await input.transport.getAuthenticatedUser();
  fs.writeFileSync(input.statePath, '{"phase":"sending"}');
  return input.transport.createReview(requestFor(input, CONTROL_MARKER));
}

// ===========================================================================
// Tests
// ===========================================================================

describe('oracles discriminate faulty publishers (negative and positive controls)', () => {
  test('durable-intent oracle accepts exclusive create + file flush + directory flush before send', async () => {
    const world = makeWorld();
    const events = [];
    await referenceIntentThenSend(makeInput(world, { events }), recordingFs(events));
    assertDurableIntentBeforeSend(events, world.statePath);
  });

  test('durable-intent oracle detects a premature send', async () => {
    const world = makeWorld();
    const events = [];
    await faultySendBeforePersist(makeInput(world, { events }), recordingFs(events));
    assert.throws(() => assertDurableIntentBeforeSend(events, world.statePath), /not created before/);
  });

  test('durable-intent oracle detects a missing parent-directory flush', async () => {
    const world = makeWorld();
    const events = [];
    await faultyNoDirectoryFlush(makeInput(world, { events }), recordingFs(events));
    assert.throws(() => assertDurableIntentBeforeSend(events, world.statePath), /parent directory/);
  });

  test('receipt oracle accepts rename of a flushed sibling and rejects in-place rewrite', async () => {
    for (const [writer, shouldPass] of [
      [referenceAtomicReceipt, true],
      [faultyInPlaceReceipt, false],
    ]) {
      const world = makeWorld();
      const events = [];
      const fsImpl = recordingFs(events);
      const input = makeInput(world, { events });
      await referenceIntentThenSend(input, fsImpl);
      writer(input, fsImpl);
      if (shouldPass) assertAtomicDurableReceipt(events, world.statePath);
      else assert.throws(() => assertAtomicDurableReceipt(events, world.statePath), /in place/);
    }
  });

  test('single-create oracle detects a resend after a lookup miss', async () => {
    const world = makeWorld({ create: 'lose-response', visibilityDelay: 5 });
    await faultyRetryOnMiss(makeInput(world));
    // The host refuses this particular resend because the first draft is still
    // pending; once a human submits or deletes that draft, the same resend
    // would land as a duplicate review. The oracle judges attempts, not luck.
    assert.equal(world.remote.calls('createReview').length, 2, 'control must actually resend');
    assert.throws(() => assertExactlyOneCreateAttempt(world.remote), /exactly one create-review attempt, saw 2/);
  });

  test('no-other-writes oracle detects repair of a partially persisted review', async () => {
    const world = makeWorld({ create: 'lose-response', dropCommentIndexesOnPersist: [1, 2] });
    await faultyRepairMissingComments(makeInput(world));
    assert.throws(() => assertNoWriteOtherThanCreate(world.remote), /other than the single create-review/);
  });

  test('single-create oracle detects a non-exclusive concurrent claim', async () => {
    const world = makeWorld();
    // Four of the five creates are refused by the host's one-pending-review rule;
    // the claim is still faulty because it attempted to send five times.
    await Promise.allSettled(Array.from({ length: 5 }, () => faultyNonExclusiveClaim(makeInput(world))));
    assert.throws(() => assertExactlyOneCreateAttempt(world.remote), /exactly one create-review attempt, saw 5/);
  });
});

describe('one draft create-review request carries the complete contribution', () => {
  test('body, every inline comment and the explicit reviewed commit are sent together, without an event', async () => {
    const world = makeWorld();
    const input = makeInput(world);
    const untouched = structuredClone(input.preparedReview);

    const result = await publishPreparedReview(input);

    assertExactlyOneCreateAttempt(world.remote);
    assertNoWriteOtherThanCreate(world.remote);
    const [create] = world.remote.calls('createReview');
    assert.equal(Object.hasOwn(create.args, 'event'), false, 'draft review must omit the submission event');
    const marker = extractMarker(create.args.body);
    assert.match(marker, MARKER_EXACT);
    assert.deepEqual(create.args, expectedRequest(marker));

    const [stored] = world.remote.reviews();
    assert.equal(stored.state, 'PENDING');
    assert.deepEqual(stored.comments, EXPECTED.comments);

    assert.deepEqual(result, {
      status: 'published',
      via: 'created',
      review: { id: stored.id, htmlUrl: stored.htmlUrl },
      marker,
      statePath: world.statePath,
      receiptPersisted: true,
    });
    assert.deepEqual(input.preparedReview, untouched, 'prepared review must not be mutated');
  });

  test('a positive create is verified by reading back the created review and all its comments', async () => {
    const world = makeWorld();
    const result = await publish(world);
    const calls = world.remote.calls().map((c) => c.method);
    const createAt = calls.indexOf('createReview');
    assert.ok(calls.indexOf('listReviews', createAt) > createAt, 'reviews were not read back after create');
    const commentReads = world.remote.calls('listReviewComments');
    assert.ok(commentReads.some((c) => c.args.reviewId === result.review.id), 'comments were not read back');
  });

  test('completed state record binds original identity, complete request and receipt', async () => {
    const world = makeWorld();
    const result = await publish(world);
    const record = readRecord(world.statePath);
    assert.deepEqual(Object.keys(record).sort(), [
      'authorId',
      'destination',
      'format',
      'inputFingerprint',
      'marker',
      'phase',
      'receipt',
      'request',
      'requestFingerprint',
      'reviewedCommit',
      'version',
    ]);
    assert.equal(record.format, STATE_FORMAT);
    assert.equal(record.version, 1);
    assert.equal(record.phase, 'completed');
    assert.equal(record.marker, result.marker);
    assert.deepEqual(record.destination, { owner: 'octo-org', repo: 'widgets', pullNumber: 42 });
    assert.equal(record.reviewedCommit, '3f9c2a7b1e4d5c6f708192a3b4c5d6e7f8091a2b');
    assert.equal(record.inputFingerprint, FIXTURE.input.inputFingerprint);
    assert.equal(record.authorId, 7001001);
    assert.deepEqual(record.request, expectedRequest(result.marker));
    assert.equal(record.requestFingerprint, fingerprintOf(expectedRequest(result.marker)));
    const [stored] = world.remote.reviews();
    assert.deepEqual(record.receipt, { reviewId: stored.id, htmlUrl: stored.htmlUrl, via: 'created' });
  });

  test('malformed input is refused before any transport call or state write', async () => {
    const world = makeWorld();
    const cases = [
      (i) => delete i.statePath,
      (i) => (i.statePath = 'relative/review.publication.json'),
      (i) => (i.reviewedCommit = '3f9c2a7'),
      (i) => delete i.inputFingerprint,
      (i) => (i.inputFingerprint = 'md5:abc'),
      (i) => (i.preparedReview = { body: 'x' }),
      (i) => (i.preparedReview.comments[0].side = 'MIDDLE'),
      (i) => delete i.preparedReview.comments[1].startSide,
      (i) => (i.destination = { owner: 'octo-org', repo: 'widgets' }),
    ];
    for (const breakIt of cases) {
      const input = makeInput(world);
      breakIt(input);
      await assert.rejects(publishPreparedReview(input), TypeError);
    }
    const { preparedReview: _p, ...recovery } = makeInput(world);
    delete recovery.inputFingerprint;
    await assert.rejects(recoverPublication(recovery), TypeError);
    assert.deepEqual(world.remote.calls(), []);
    assert.deepEqual(fs.readdirSync(world.stateDir), []);
  });
});

describe('intent is complete and durable before the single send', () => {
  test('at send time the on-disk record is a complete sending intent holding the exact request', async () => {
    const world = makeWorld();
    const input = makeInput(world);
    const send = input.transport.createReview;
    let atSend = null;
    input.transport.createReview = async (request) => {
      atSend = { raw: fs.readFileSync(world.statePath, 'utf8'), request: structuredClone(request) };
      return send(request);
    };

    await publishPreparedReview(input);

    assert.ok(atSend, 'create-review was never sent');
    const record = JSON.parse(atSend.raw);
    const marker = extractMarker(atSend.request.body);
    assert.equal(record.phase, 'sending');
    assert.equal(record.marker, marker);
    assert.deepEqual(record.request, atSend.request);
    assert.deepEqual(record.request, expectedRequest(marker));
    assert.equal(record.requestFingerprint, fingerprintOf(atSend.request));
    assert.equal(record.inputFingerprint, FIXTURE.input.inputFingerprint);
    assert.equal(record.authorId, DEFAULT_USER.id);
    assert.equal(Object.hasOwn(record, 'receipt'), false);
  });

  test('file contents and parent directory are flushed before the send; receipt is atomic and durable', async () => {
    const world = makeWorld();
    const events = [];
    await publishPreparedReview(makeInput(world, { events }), { fs: recordingFs(events) });
    assertDurableIntentBeforeSend(events, world.statePath);
    assertAtomicDurableReceipt(events, world.statePath);
  });

  test('state is private to the owner and never holds credentials', async () => {
    const world = makeWorld();
    await publish(world);
    const mode = fs.statSync(world.statePath).mode & 0o777;
    assert.equal(mode & 0o077, 0, `state file mode ${mode.toString(8)} exposes it to group/other`);
    for (const name of fs.readdirSync(world.stateDir)) {
      const text = fs.readFileSync(path.join(world.stateDir, name), 'utf8');
      assert.equal(text.includes(SENTINEL_TOKEN), false, `${name} contains the transport credential`);
    }
  });

  test('failed read-only context stops before any state or send, preserving the cause', async () => {
    const world = makeWorld();
    const input = makeInput(world);
    const cause = Object.assign(new Error('401 Bad credentials'), { status: 401 });
    input.transport.getAuthenticatedUser = async () => {
      throw cause;
    };
    await assert.rejects(publishPreparedReview(input), (err) => err === cause || err.cause === cause);
    assertNoCreateAttempt(world.remote);
    assert.deepEqual(fs.readdirSync(world.stateDir), []);
  });

  test('an authenticated user without a numeric id stops before any state or send', async () => {
    const world = makeWorld();
    const input = makeInput(world);
    let asked = false;
    input.transport.getAuthenticatedUser = async () => {
      asked = true;
      return { login: 'reviewer-bot' };
    };
    await assert.rejects(publishPreparedReview(input), /numeric/);
    assert.equal(asked, true, 'refusal must come from the authenticated identity check');
    assertNoCreateAttempt(world.remote);
    assert.deepEqual(fs.readdirSync(world.stateDir), []);
  });

  test('directory flush failure before send is a local error with no send, and later calls still never send', async () => {
    const world = makeWorld();
    const events = [];
    const failing = recordingFs(events, {
      fsync: (p) => {
        if (p === world.stateDir) throw ioError('directory fsync failed');
      },
    });
    await assert.rejects(publishPreparedReview(makeInput(world, { events }), { fs: failing }), isStateError('state-io'));
    assertNoCreateAttempt(world.remote);

    const later = await publish(world);
    assert.equal(later.status, 'uncertain');
    assert.equal(later.reason, 'not-found');
    assertNoCreateAttempt(world.remote);
  });

  test('missing state directory is a local error with no send and nothing created', async () => {
    const world = makeWorld();
    const statePath = path.join(world.root, 'absent-dir', 'review.publication.json');
    await assert.rejects(publish(world, { statePath }), isStateError('state-io'));
    assertNoCreateAttempt(world.remote);
    assert.equal(fs.existsSync(path.dirname(statePath)), false);
  });
});

describe('a positive create response is verified before completion', () => {
  test('host dropped a comment despite a positive response: uncertain, no receipt, no repair', async () => {
    const world = makeWorld({ dropCommentIndexesOnPersist: [2] });
    const result = await publish(world);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'candidate-differs');
    assert.equal(readRecord(world.statePath).phase, 'sending');
    for (const again of [await publish(world), await recover(world)]) {
      assert.equal(again.status, 'uncertain');
      assert.equal(again.reason, 'candidate-differs');
    }
    assertExactlyOneCreateAttempt(world.remote);
    assertNoWriteOtherThanCreate(world.remote);
    assert.equal(world.remote.reviews()[0].comments.length, 2);
  });

  test('host stored a comment on a different line despite a positive response: uncertain', async () => {
    const world = makeWorld({ alterCommentIndexesOnPersist: [0] });
    const result = await publish(world);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'candidate-differs');
    assert.equal(readRecord(world.statePath).phase, 'sending');
    assertExactlyOneCreateAttempt(world.remote);
  });

  test('duplicate identical comments are compared as a multiset', async () => {
    const duplicate = (i) => {
      const [first, second] = i.preparedReview.comments;
      i.preparedReview.comments = [first, structuredClone(first), second];
    };
    const complete = makeWorld();
    const ok = await publish(complete, { mutate: duplicate });
    assert.equal(ok.status, 'published');
    assert.equal(ok.via, 'created');

    const missingOne = makeWorld({ dropCommentIndexesOnPersist: [1] });
    const result = await publish(missingOne, { mutate: duplicate });
    // Control: the host holds each distinct comment, so a set comparison would pass.
    const stored = missingOne.remote.reviews()[0].comments;
    assert.equal(new Set(stored.map((c) => JSON.stringify(c))).size, 2);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'candidate-differs');
  });

  test('line endings are compared exactly; a normalizing host is not silently accepted', async () => {
    const crlf = (i) => (i.preparedReview.body = 'First line.\r\nSecond line.');
    const exact = makeWorld();
    const ok = await publish(exact, { mutate: crlf });
    assert.equal(ok.status, 'published');

    const normalizing = makeWorld({ normalizeLineEndings: true });
    const result = await publish(normalizing, { mutate: crlf });
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'candidate-differs');
  });

  test('a positive response whose review is not yet visible stays uncertain until found', async () => {
    const world = makeWorld({ visibilityDelay: 2 });
    const first = await publish(world);
    assert.equal(first.status, 'uncertain');
    assert.equal(first.reason, 'not-found');
    assert.equal(readRecord(world.statePath).phase, 'sending');
    let later = first;
    for (let i = 0; i < 5 && later.status === 'uncertain'; i += 1) later = await publish(world);
    assert.equal(later.status, 'published');
    assert.equal(later.via, 'recovered');
    assertExactlyOneCreateAttempt(world.remote);
  });
});

describe('lost or failed create outcomes never produce a second create', () => {
  test('lost response: the same marker is rediscovered and the created review is returned', async () => {
    const world = makeWorld({ create: 'lose-response' });
    const result = await publish(world);
    assertExactlyOneCreateAttempt(world.remote);
    assertNoWriteOtherThanCreate(world.remote);
    const [stored] = world.remote.reviews();
    assert.equal(result.status, 'published');
    assert.equal(result.via, 'recovered');
    assert.deepEqual(result.review, { id: stored.id, htmlUrl: stored.htmlUrl });
    assert.equal(result.marker, sentMarker(world.remote));
    const record = readRecord(world.statePath);
    assert.equal(record.phase, 'completed');
    assert.deepEqual(record.receipt, { reviewId: stored.id, htmlUrl: stored.htmlUrl, via: 'recovered' });
  });

  test('response without identity is recovered by marker, not resent', async () => {
    const world = makeWorld({ create: 'malformed-response' });
    const result = await publish(world);
    assertExactlyOneCreateAttempt(world.remote);
    assert.equal(result.status, 'published');
    assert.equal(result.via, 'recovered');
    assert.equal(result.review.id, world.remote.reviews()[0].id);
  });

  test('indeterminate failure with nothing persisted stays uncertain on every retry', async () => {
    const world = makeWorld({ create: 'fail-before-persist' });
    const first = await publish(world);
    assert.equal(first.status, 'uncertain');
    assert.equal(first.reason, 'not-found');
    assert.match(String(first.cause && first.cause.message), /connection reset/);
    world.remote.setConfig({ create: 'ok' });
    for (let i = 0; i < 3; i += 1) {
      const again = await publish(world);
      assert.equal(again.status, 'uncertain');
      assert.equal(again.reason, 'not-found');
      assert.equal(again.marker, first.marker);
    }
    assertExactlyOneCreateAttempt(world.remote);
    assert.equal(world.remote.reviews().length, 0);
    assert.equal(readRecord(world.statePath).phase, 'sending');
  });

  test('host-confirmed rejection is persisted atomically and durably, then reported without transport (regression: was later reported as not-found)', async () => {
    const world = makeWorld({ create: 'reject' });
    const events = [];
    const result = await publishPreparedReview(makeInput(world, { events }), { fs: recordingFs(events) });
    assert.equal(result.status, 'rejected');
    assert.equal(result.via, 'response');
    assert.equal(result.httpStatus, 422);
    assert.equal(result.rejectionPersisted, true);
    assert.equal(result.cause.hostRejected, true);
    assert.match(result.marker, MARKER_EXACT);
    assert.match(result.detail, /line must be part of the diff/);
    assertAtomicDurableRejection(events, world.statePath);

    const record = readRecord(world.statePath);
    assert.equal(record.phase, 'rejected');
    assert.deepEqual(record.rejection, {
      status: 422,
      message: 'Unprocessable Entity: line must be part of the diff',
    });
    assert.equal(Object.hasOwn(record, 'receipt'), false);

    world.remote.setConfig({ create: 'ok' });
    const callsBefore = world.remote.calls().length;
    for (const again of [await publish(world), await recover(world)]) {
      assert.equal(again.status, 'rejected', JSON.stringify(again));
      assert.equal(again.via, 'record');
      assert.equal(again.httpStatus, 422);
      assert.equal(again.marker, result.marker);
      assert.match(again.detail, /line must be part of the diff/);
      assert.equal(Object.hasOwn(again, 'cause'), false);
    }
    assert.equal(world.remote.calls().length, callsBefore, 'a known rejection needs no transport call');
    assertExactlyOneCreateAttempt(world.remote);
    assert.equal(world.remote.reviews().length, 0);
  });

  test('failure to persist a rejection is reported now, stays conservative later, and never resends', async () => {
    const world = makeWorld({ create: 'reject' });
    const target = path.resolve(world.statePath);
    const failing = recordingFs([], {
      rename: (_from, to) => {
        if (to === target) throw ioError('rename failed');
      },
    });
    const first = await publishPreparedReview(makeInput(world), { fs: failing });
    assert.equal(first.status, 'rejected');
    assert.equal(first.rejectionPersisted, false);
    assert.equal(readRecord(world.statePath).phase, 'sending');

    world.remote.setConfig({ create: 'ok' });
    const later = await publish(world);
    assert.equal(later.status, 'uncertain');
    assert.equal(later.reason, 'not-found');
    assertExactlyOneCreateAttempt(world.remote);
  });

  test('only the refusal status and a bounded message are persisted from a rejection', async () => {
    const world = makeWorld();
    const input = makeInput(world);
    input.transport.createReview = async () => {
      throw Object.assign(new Error(`Validation Failed: ${'x'.repeat(5000)}`), {
        hostRejected: true,
        status: 422,
        request: { headers: { authorization: `token ${SENTINEL_TOKEN}` } },
        cause: new Error(`upstream detail ${SENTINEL_TOKEN}`),
      });
    };
    const result = await publishPreparedReview(input);
    assert.equal(result.status, 'rejected');
    const text = fs.readFileSync(world.statePath, 'utf8');
    assert.equal(text.includes(SENTINEL_TOKEN), false, 'rejection details beyond status and message were persisted');
    const { rejection } = JSON.parse(text);
    assert.deepEqual(Object.keys(rejection).sort(), ['message', 'status']);
    assert.ok(rejection.message.startsWith('Validation Failed: xxx'));
    assert.ok(rejection.message.length <= 1000, `persisted message is ${rejection.message.length} characters`);
  });

  for (const [label, status] of [
    ['request timeout 408', 408],
    ['server error 500', 500],
    ['a missing status', undefined],
  ]) {
    test(`a claimed rejection with ${label} is indeterminate, investigated and not persisted as rejected`, async () => {
      const world = makeWorld();
      const input = makeInput(world);
      input.transport.createReview = async () => {
        throw Object.assign(new Error('refused?'), { hostRejected: true, status });
      };
      const result = await publishPreparedReview(input);
      assert.equal(result.status, 'uncertain');
      assert.equal(result.reason, 'not-found');
      assert.equal(readRecord(world.statePath).phase, 'sending');
    });
  }

  test('a create response naming a different review than the sole complete candidate is a candidate mismatch', async () => {
    const world = makeWorld({ create: 'wrong-id-response' });
    const result = await publish(world);
    const [stored] = world.remote.reviews();
    assert.equal(stored.comments.length, EXPECTED.comments.length, 'control: the host holds the complete review');
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'candidate-mismatch');
    assert.equal(readRecord(world.statePath).phase, 'sending');
    assertExactlyOneCreateAttempt(world.remote);
    assertNoWriteOtherThanCreate(world.remote);
  });

  test('receipt persistence failure after verified completion reports the review and leaves a recoverable intent', async () => {
    const world = makeWorld();
    const target = path.resolve(world.statePath);
    const events = [];
    const failing = recordingFs(events, {
      rename: (_from, to) => {
        if (to === target) throw ioError('rename failed');
      },
    });
    const first = await publishPreparedReview(makeInput(world, { events }), { fs: failing });
    const [stored] = world.remote.reviews();
    assert.equal(first.status, 'published');
    assert.equal(first.via, 'created');
    assert.equal(first.receiptPersisted, false);
    assert.match(String(first.cause && first.cause.message), /rename failed/);
    assert.deepEqual(first.review, { id: stored.id, htmlUrl: stored.htmlUrl });

    const intent = readRecord(world.statePath);
    assert.equal(intent.phase, 'sending');
    assert.equal(intent.marker, first.marker);

    const second = await publish(world);
    assert.equal(second.status, 'published');
    assert.equal(second.via, 'recovered');
    assert.equal(second.review.id, stored.id);
    assert.equal(second.receiptPersisted, true);
    assert.equal(readRecord(world.statePath).phase, 'completed');
    assertExactlyOneCreateAttempt(world.remote);
  });
});

describe('delayed visibility remains uncertain across successive retries', () => {
  test('retries only investigate until the review becomes visible, then finish with a receipt', async () => {
    const world = makeWorld({ create: 'lose-response', visibilityDelay: 6 });
    const outcomes = [];
    for (let i = 0; i < 20; i += 1) {
      const r = await publish(world);
      outcomes.push(r);
      if (r.status !== 'uncertain') break;
    }
    const final = outcomes[outcomes.length - 1];
    const waiting = outcomes.slice(0, -1);
    const [stored] = world.remote.reviews();

    assert.ok(waiting.length >= 1, 'the first attempt must not see a review hidden by delayed visibility');
    for (const w of waiting) {
      assert.equal(w.status, 'uncertain');
      assert.equal(w.reason, 'not-found');
      assert.equal(w.marker, final.marker, 'identity must be stable across retries');
    }
    assert.equal(final.status, 'published');
    assert.equal(final.via, 'recovered');
    assert.equal(final.review.id, stored.id);
    assertExactlyOneCreateAttempt(world.remote);
    assertNoWriteOtherThanCreate(world.remote);

    const callsBefore = world.remote.calls().length;
    const afterReceipt = await publish(world);
    assert.equal(afterReceipt.via, 'receipt');
    assert.equal(world.remote.calls().length, callsBefore, 'a receipt ends all remote interaction');
  });
});

describe('candidate enumeration is complete and bounded', () => {
  /**
   * Earlier reviews by other publications and people. Our own account's earlier
   * reviews are submitted, as the host allows it at most one pending draft.
   */
  function seedForeign(world, count, { marker = null } = {}) {
    for (let i = 0; i < count; i += 1) {
      const ours = i % 2 === 1;
      world.remote.seedReview({
        ...FIXTURE.input.destination,
        authorId: ours ? DEFAULT_USER.id : 5550001,
        authorLogin: ours ? DEFAULT_USER.login : 'human-colleague',
        commitId: FIXTURE.input.reviewedCommit,
        body: marker ? `Earlier automated review ${i}\n\n${marker}` : `Human review ${i}`,
        state: ours ? 'COMMENTED' : 'PENDING',
      });
    }
  }

  test('a candidate on the last of many pages is found by following every cursor', async () => {
    const world = makeWorld({ create: 'lose-response', pageSize: 10 });
    seedForeign(world, 95, { marker: FOREIGN_MARKER });
    const result = await publish(world);
    assert.equal(result.status, 'published');
    assert.equal(result.via, 'recovered');
    const ours = world.remote.reviews().at(-1);
    assert.equal(result.review.id, ours.id);
    const cursors = world.remote.calls('listReviews').map((c) => c.args.cursor);
    const lastStart = cursors.lastIndexOf(null);
    assert.deepEqual(cursors.slice(lastStart), [null, '10', '20', '30', '40', '50', '60', '70', '80', '90']);
    assertExactlyOneCreateAttempt(world.remote);
  });

  // Adversarial/corruption fixture: seeding bypasses the host, which would never
  // hold two pending reviews by one author on one pull request. The coordinator
  // must still refuse to choose between copies of its marker (for example after
  // a human submitted one copy and something else created another).
  test('a second marker candidate on a later page makes the outcome ambiguous', async () => {
    const world = makeWorld({ create: 'fail-before-persist', pageSize: 10 });
    seedForeign(world, 4);
    const first = await publish(world);
    assert.equal(first.status, 'uncertain');
    const marker = sentMarker(world.remote);
    const copy = {
      ...FIXTURE.input.destination,
      authorId: DEFAULT_USER.id,
      authorLogin: DEFAULT_USER.login,
      commitId: FIXTURE.input.reviewedCommit,
      body: `${EXPECTED.bodyBeforeMarker}\n\n${marker}`,
      comments: EXPECTED.comments,
    };
    world.remote.seedReview(copy);
    seedForeign(world, 30);
    world.remote.seedReview(copy);

    const result = await publish(world);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'ambiguous');
    assertExactlyOneCreateAttempt(world.remote);
    assertNoWriteOtherThanCreate(world.remote);
    assert.equal(readRecord(world.statePath).phase, 'sending');
  });

  test('a failed later page is lookup failure even when a match was already seen', async () => {
    const world = makeWorld({ create: 'lose-response', pageSize: 10, visibilityDelay: 1 });
    const first = await publish(world);
    assert.equal(first.status, 'uncertain');
    seedForeign(world, 35);
    world.remote.setConfig({ failListPageAt: 2 });
    const result = await publish(world);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'lookup-failed');
    assertExactlyOneCreateAttempt(world.remote);
    assert.equal(readRecord(world.statePath).phase, 'sending');
  });

  test('comment readback follows every page before judging completeness', async () => {
    const world = makeWorld({ create: 'lose-response', commentPageSize: 1 });
    const result = await publish(world);
    assert.equal(result.status, 'published');
    assert.equal(result.via, 'recovered');
    const cursors = world.remote.calls('listReviewComments').map((c) => c.args.cursor);
    assert.deepEqual(cursors, [null, '1', '2']);
  });

  test('a cyclic review cursor is lookup failure, never a hang or a completed enumeration', { timeout: 5000 }, async () => {
    const world = makeWorld({ create: 'lose-response', reviewCursorMode: 'cycle' });
    const result = await publish(world);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'lookup-failed');
    assert.ok(world.remote.calls('listReviews').length <= 4);
    assertExactlyOneCreateAttempt(world.remote);
    assert.equal(readRecord(world.statePath).phase, 'sending');
  });

  test('a cyclic comment cursor is lookup failure, never a hang or a completed readback', { timeout: 5000 }, async () => {
    const world = makeWorld({ create: 'lose-response', commentCursorMode: 'cycle', commentPageSize: 1 });
    const result = await publish(world);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'lookup-failed');
    assert.ok(world.remote.calls('listReviewComments').length <= 4);
    assert.equal(readRecord(world.statePath).phase, 'sending');
  });

  test('a malformed review page is lookup failure', { timeout: 5000 }, async () => {
    const world = makeWorld({ create: 'lose-response', malformedReviewPage: true });
    const result = await publish(world);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'lookup-failed');
    assertExactlyOneCreateAttempt(world.remote);
  });

  test('reviews carrying another publication marker are not candidates', async () => {
    const world = makeWorld({ create: 'fail-before-persist' });
    seedForeign(world, 3, { marker: FOREIGN_MARKER });
    const result = await publish(world);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'not-found');
    assert.notEqual(result.marker, FOREIGN_MARKER);
  });
});

describe('candidate verification never repairs (D29)', () => {
  /** Publish once with nothing persisted remotely, then seed a marker-bearing review. */
  async function seedMarkedCandidate(overrides) {
    const world = makeWorld({ create: 'fail-before-persist' });
    await publish(world);
    const marker = sentMarker(world.remote);
    world.remote.seedReview({
      ...FIXTURE.input.destination,
      authorId: DEFAULT_USER.id,
      authorLogin: DEFAULT_USER.login,
      commitId: FIXTURE.input.reviewedCommit,
      body: `${EXPECTED.bodyBeforeMarker}\n\n${marker}`,
      comments: EXPECTED.comments,
      ...overrides,
    });
    return world;
  }

  test('control: a seeded complete candidate by the same author id is recovered', async () => {
    const world = await seedMarkedCandidate({});
    const result = await publish(world);
    assert.equal(result.status, 'published');
    assert.equal(result.via, 'recovered');
  });

  test('marker on a review by a different author id with the same login is a candidate mismatch', async () => {
    const world = await seedMarkedCandidate({ authorId: 6660666, authorLogin: DEFAULT_USER.login });
    const result = await publish(world);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'candidate-mismatch');
    assertExactlyOneCreateAttempt(world.remote);
    assertNoWriteOtherThanCreate(world.remote);
  });

  test('marker on a review for a different commit is a candidate mismatch', async () => {
    const world = await seedMarkedCandidate({ commitId: 'a'.repeat(40) });
    const result = await publish(world);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'candidate-mismatch');
    assertExactlyOneCreateAttempt(world.remote);
  });

  test('a renamed login with the same author id still recovers', async () => {
    const world = makeWorld({ create: 'lose-response', visibilityDelay: 1 });
    assert.equal((await publish(world)).status, 'uncertain');
    const result = await publish(world, { user: { id: DEFAULT_USER.id, login: 'renamed-bot' } });
    assert.equal(result.status, 'published');
    assert.equal(result.via, 'recovered');
  });

  test('marker alone is not proof: a candidate missing initial comments stays uncertain without writes', async () => {
    const world = makeWorld({ create: 'lose-response', dropCommentIndexesOnPersist: [1, 2] });
    const result = await publish(world);
    const [stored] = world.remote.reviews();
    // Control: the host really holds our marker, so marker-only recovery would have "succeeded".
    assert.equal(stored.body.includes(sentMarker(world.remote)), true);
    assert.equal(stored.comments.length, 1);

    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'candidate-differs');
    assertExactlyOneCreateAttempt(world.remote);
    assertNoWriteOtherThanCreate(world.remote);
    assert.equal(world.remote.review(stored.id).comments.length, 1, 'missing comments must not be restored');
    assert.equal(readRecord(world.statePath).phase, 'sending');
  });

  test('human deletion or edit during uncertain delivery is reported, never restored', async () => {
    const edits = [
      (remote, id) => remote.humanDeleteComment(id, 0),
      (remote, id) => remote.humanEditBody(id, `${remote.review(id).body}\n\nEdited by a human.`),
    ];
    for (const edit of edits) {
      const world = makeWorld({ create: 'lose-response', visibilityDelay: 1 });
      const first = await publish(world);
      assert.equal(first.status, 'uncertain');
      const [stored] = world.remote.reviews();
      edit(world.remote, stored.id);
      const humanVersion = world.remote.review(stored.id);

      const result = await publish(world);
      assert.equal(result.status, 'uncertain');
      assert.equal(result.reason, 'candidate-differs');
      assertExactlyOneCreateAttempt(world.remote);
      assertNoWriteOtherThanCreate(world.remote);
      assert.deepEqual(world.remote.review(stored.id), humanVersion);
    }
  });

  test('human removal of the marker during uncertain delivery leaves it not-found, never a new create', async () => {
    const world = makeWorld({ create: 'lose-response', visibilityDelay: 1 });
    await publish(world);
    const [stored] = world.remote.reviews();
    world.remote.humanEditBody(stored.id, 'A human rewrote this draft.');
    const result = await publish(world);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'not-found');
    assertExactlyOneCreateAttempt(world.remote);
  });

  test('a human-submitted review with unchanged content still counts as the initial delivery', async () => {
    const world = makeWorld({ create: 'lose-response', visibilityDelay: 1 });
    await publish(world);
    const [stored] = world.remote.reviews();
    world.remote.humanSubmit(stored.id);
    const result = await publish(world);
    assert.equal(result.status, 'published');
    assert.equal(result.via, 'recovered');
    assertNoWriteOtherThanCreate(world.remote);
    assert.equal(world.remote.review(stored.id).state, 'COMMENTED');
  });
});

describe('a completed receipt is final (D29)', () => {
  test('later human edits and deletions are neither inspected nor restored', async () => {
    const world = makeWorld();
    const first = await publish(world);
    const [stored] = world.remote.reviews();
    world.remote.humanEditBody(stored.id, 'Rewritten by a human; marker removed.');
    world.remote.humanDeleteComment(stored.id, 2);
    world.remote.humanDeleteComment(stored.id, 0);
    const callsBefore = world.remote.calls().length;
    const humanVersion = world.remote.review(stored.id);

    const again = await publish(world);
    assert.deepEqual(again, { ...first, via: 'receipt' });
    const recovered = await recover(world);
    assert.deepEqual(recovered, { ...first, via: 'receipt' });
    assert.equal(world.remote.calls().length, callsBefore, 'receipt path must not call the transport at all');
    assert.deepEqual(world.remote.review(stored.id), humanVersion);
  });

  for (const [label, humanAction] of [
    ['submits', (remote, id) => remote.humanSubmit(id)],
    ['deletes', (remote, id) => remote.humanDeleteReview(id)],
  ]) {
    test(`after a human ${label} the first draft, a new state path creates a separate review`, async () => {
      const world = makeWorld();
      const first = await publish(world);
      humanAction(world.remote, first.review.id);
      const second = await publish(world, { statePath: path.join(world.stateDir, 'second.publication.json') });

      assert.equal(second.status, 'published');
      assert.equal(second.via, 'created');
      assert.notEqual(second.review.id, first.review.id);
      assert.notEqual(second.marker, first.marker);
      assert.equal(world.remote.calls('createReview').length, 2);
      assertNoWriteOtherThanCreate(world.remote);
    });
  }
});

describe('the host allows one pending review per author per pull request', () => {
  test('control: the host double refuses a second pending create like GitHub (HTTP 422)', async () => {
    const world = makeWorld();
    const transport = world.remote.transport();
    const request = { ...FIXTURE.input.destination, commitId: EXPECTED.commitId, body: 'first', comments: [] };
    await transport.createReview(request);
    await assert.rejects(transport.createReview({ ...request, body: 'second' }), (err) => {
      assert.equal(err.hostRejected, true);
      assert.equal(err.status, 422);
      assert.match(err.message, /one pending review per pull request/);
      return true;
    });
    assert.equal(world.remote.reviews().length, 1);
  });

  test('a second state path while the first draft is pending is refused by the host, remembered, and alters nothing', async () => {
    const world = makeWorld();
    const first = await publish(world);
    const earlier = world.remote.review(first.review.id);
    const secondPath = path.join(world.stateDir, 'second.publication.json');

    const second = await publish(world, { statePath: secondPath });
    assert.equal(second.status, 'rejected');
    assert.equal(second.httpStatus, 422);
    assert.match(second.detail, /one pending review per pull request/);
    assert.equal(readRecord(secondPath).phase, 'rejected');

    const again = await publish(world, { statePath: secondPath });
    assert.equal(again.status, 'rejected');
    assert.equal(again.via, 'record');
    assert.equal(world.remote.calls('createReview').length, 2, 'the rejected identity is never resent');
    assert.equal(world.remote.reviews().length, 1);
    assert.deepEqual(world.remote.review(first.review.id), earlier);
    assertNoWriteOtherThanCreate(world.remote);
  });

  test("a pre-existing human draft on the same account is neither altered nor used; publication is refused", async () => {
    const world = makeWorld();
    const human = world.remote.seedReview({
      ...FIXTURE.input.destination,
      authorId: DEFAULT_USER.id,
      authorLogin: DEFAULT_USER.login,
      commitId: EXPECTED.commitId,
      body: 'My own notes, not finished yet.',
      comments: [{ path: 'src/parser.js', side: 'RIGHT', line: 3, body: 'todo' }],
    });
    const result = await publish(world);
    assert.equal(result.status, 'rejected');
    assert.equal(result.httpStatus, 422);
    assertExactlyOneCreateAttempt(world.remote);
    assertNoWriteOtherThanCreate(world.remote);
    assert.deepEqual(world.remote.review(human.id), human);
    assert.equal(world.remote.reviews().length, 1);
  });
});

describe('original-input identity governs reuse of a state path', () => {
  /** Re-preparation after the author's branch advanced: different eligible comments and wording. */
  const reprepared = (i) => {
    i.preparedReview.body = 'Re-rendered against a newer head; should never be sent.';
    i.preparedReview.comments = i.preparedReview.comments.slice(0, 1);
  };

  /** Model of the public wrapper: recover first, prepare only when no identity exists. */
  async function wrapper(world, prepare) {
    const recovered = await recover(world);
    if (recovered.status !== 'missing') return { outcome: recovered, prepared: false };
    const input = makeInput(world);
    input.preparedReview = prepare();
    return { outcome: await publishPreparedReview(input), prepared: true };
  }

  test('recovery does not need preparation: a throwing preparation is never reached', async () => {
    const world = makeWorld({ create: 'lose-response', visibilityDelay: 1 });
    assert.equal((await publish(world)).status, 'uncertain');
    const { outcome, prepared } = await wrapper(world, () => {
      throw new Error('source at the advanced head no longer supports this placement');
    });
    assert.equal(prepared, false);
    assert.equal(outcome.status, 'published');
    assert.equal(outcome.via, 'recovered');
    assertExactlyOneCreateAttempt(world.remote);
    assert.equal(readRecord(world.statePath).phase, 'completed');
  });

  test('with no record, recovery reports missing without transport calls or files, then preparation publishes', async () => {
    const world = makeWorld();
    const missing = await recover(world);
    assert.deepEqual(missing, { status: 'missing', statePath: world.statePath });
    assert.deepEqual(world.remote.calls(), []);
    assert.deepEqual(fs.readdirSync(world.stateDir), []);
    const { outcome, prepared } = await wrapper(world, () => structuredClone(FIXTURE.input.preparedReview));
    assert.equal(prepared, true);
    assert.equal(outcome.via, 'created');
  });

  test('a re-prepared request under the same identity recovers the saved request and is never sent', async () => {
    const world = makeWorld({ create: 'lose-response', visibilityDelay: 1 });
    const first = await publish(world);
    assert.equal(first.status, 'uncertain');
    const result = await publish(world, { mutate: reprepared });
    assert.equal(result.status, 'published');
    assert.equal(result.via, 'recovered');
    assertExactlyOneCreateAttempt(world.remote);
    assert.deepEqual(world.remote.reviews()[0].comments, EXPECTED.comments);
    assert.deepEqual(readRecord(world.statePath).request, expectedRequest(first.marker));
  });

  test('a re-prepared request against a completed record returns the receipt without transport calls', async () => {
    const world = makeWorld();
    const first = await publish(world);
    const callsBefore = world.remote.calls().length;
    const again = await publish(world, { mutate: reprepared });
    assert.deepEqual(again, { ...first, via: 'receipt' });
    assert.equal(world.remote.calls().length, callsBefore);
  });

  test('recoverPublication never creates, even after a pre-send crash or lookup miss', async () => {
    const world = makeWorld({ create: 'fail-before-persist' });
    await publish(world);
    world.remote.setConfig({ create: 'ok' });
    for (let i = 0; i < 3; i += 1) {
      const r = await recover(world);
      assert.equal(r.status, 'uncertain');
      assert.equal(r.reason, 'not-found');
    }
    assertExactlyOneCreateAttempt(world.remote);
  });

  test('recoverPublication completes a lost-response publication with a durable receipt', async () => {
    const world = makeWorld({ create: 'lose-response', visibilityDelay: 1 });
    await publish(world);
    const r = await recover(world);
    assert.equal(r.status, 'published');
    assert.equal(r.via, 'recovered');
    assert.equal(readRecord(world.statePath).phase, 'completed');
    assertExactlyOneCreateAttempt(world.remote);
  });

  const identityChanges = {
    'different original input fingerprint': (i) => (i.inputFingerprint = OTHER_FINGERPRINT),
    'different pull request': (i) => (i.destination.pullNumber = 43),
    'different repository': (i) => (i.destination.repo = 'gadgets'),
    'different reviewed commit': (i) => (i.reviewedCommit = 'b'.repeat(40)),
  };

  for (const [label, mutate] of Object.entries(identityChanges)) {
    for (const [phase, config] of [
      ['completed', {}],
      ['sending', { create: 'fail-before-persist' }],
    ]) {
      for (const [op, run] of [
        ['publish', publish],
        ['recover', recover],
      ]) {
        test(`${label} against a ${phase} record is refused by ${op} without lookup or send`, async () => {
          const world = makeWorld(config);
          await publish(world);
          const before = fs.readFileSync(world.statePath, 'utf8');
          const creates = world.remote.calls('createReview').length;
          const lists = world.remote.calls('listReviews').length;
          await assert.rejects(run(world, { mutate }), isStateError('state-mismatch'));
          assert.equal(world.remote.calls('createReview').length, creates);
          assert.equal(world.remote.calls('listReviews').length, lists);
          assert.equal(fs.readFileSync(world.statePath, 'utf8'), before);
        });
      }
    }
  }

  for (const [op, run] of [
    ['publish', publish],
    ['recover', recover],
  ]) {
    test(`a different author id with the same login cannot ${op} under an existing intent`, async () => {
      const world = makeWorld({ create: 'fail-before-persist' });
      await publish(world);
      const lists = world.remote.calls('listReviews').length;
      await assert.rejects(
        run(world, { user: { id: 8008008, login: DEFAULT_USER.login } }),
        isStateError('state-mismatch'),
      );
      assert.equal(world.remote.calls('listReviews').length, lists);
      assertExactlyOneCreateAttempt(world.remote);
    });
  }
});

describe('existing state is authoritative and fails closed', () => {
  test('control: a hand-built consistent intent is accepted and investigated', async () => {
    const world = makeWorld();
    fs.writeFileSync(world.statePath, JSON.stringify(handBuiltIntent()), { mode: 0o600 });
    const result = await recover(world);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'not-found');
    assertNoCreateAttempt(world.remote);
  });

  test('control: a hand-built consistent rejected record is reported without any transport call', async () => {
    const world = makeWorld();
    const record = { ...handBuiltIntent(), phase: 'rejected', rejection: { status: 422, message: 'Validation Failed' } };
    fs.writeFileSync(world.statePath, JSON.stringify(record), { mode: 0o600 });
    for (const result of [await recover(world), await publish(world)]) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.via, 'record');
      assert.equal(result.httpStatus, 422);
      assert.equal(result.rejectionPersisted, true);
    }
    assert.deepEqual(world.remote.calls(), []);
  });

  const valid = handBuiltIntent();
  const rejectedRecord = { ...valid, phase: 'rejected', rejection: { status: 422, message: 'Validation Failed' } };
  const without = (key) => {
    const copy = structuredClone(valid);
    delete copy[key];
    return copy;
  };
  const variants = {
    'empty file (exclusive create then crash)': '',
    'truncated JSON': JSON.stringify(valid).slice(0, 57),
    'JSON null': 'null',
    'JSON array': '[]',
    'unknown version': JSON.stringify({ ...valid, version: 2 }),
    'unknown format': JSON.stringify({ ...valid, format: 'something-else' }),
    'unknown phase': JSON.stringify({ ...valid, phase: 'mystery' }),
    'unknown extra field': JSON.stringify({ ...valid, note: 'unexpected' }),
    'missing marker': JSON.stringify(without('marker')),
    'malformed marker': JSON.stringify({ ...valid, marker: '<!-- not ours -->' }),
    'missing input fingerprint': JSON.stringify(without('inputFingerprint')),
    'missing saved request': JSON.stringify(without('request')),
    'string author id': JSON.stringify({ ...valid, authorId: String(valid.authorId) }),
    'completed without receipt': JSON.stringify({ ...valid, phase: 'completed' }),
    'sending with receipt': JSON.stringify({ ...valid, receipt: { reviewId: 1, htmlUrl: 'x', via: 'created' } }),
    'saved body tampered (hash mismatch)': JSON.stringify({
      ...valid,
      request: { ...valid.request, body: valid.request.body.replace('Three', 'Four') },
    }),
    'saved comment tampered (hash mismatch)': JSON.stringify({
      ...valid,
      request: { ...valid.request, comments: valid.request.comments.slice(1) },
    }),
    'request fingerprint wrong': JSON.stringify({ ...valid, requestFingerprint: OTHER_FINGERPRINT }),
    'saved commit inconsistent (rehashed)': JSON.stringify(rehashed(valid, (r) => (r.commitId = 'c'.repeat(40)))),
    'saved destination inconsistent (rehashed)': JSON.stringify(rehashed(valid, (r) => (r.pullNumber = 7))),
    'saved body missing marker (rehashed)': JSON.stringify(
      rehashed(valid, (r) => (r.body = EXPECTED.bodyBeforeMarker)),
    ),
    'saved body with a second marker (rehashed)': JSON.stringify(
      rehashed(valid, (r) => (r.body = `${valid.marker}\n${r.body}`)),
    ),
    'saved comment malformed (rehashed)': JSON.stringify(rehashed(valid, (r) => (r.comments[0].line = -1))),
    'rejected without rejection details': JSON.stringify({ ...valid, phase: 'rejected' }),
    'rejection with an extra field': JSON.stringify({
      ...rejectedRecord,
      rejection: { ...rejectedRecord.rejection, headers: {} },
    }),
    'rejection with a success status': JSON.stringify({ ...rejectedRecord, rejection: { status: 201, message: 'x' } }),
    'rejection with a non-refusal status 408': JSON.stringify({
      ...rejectedRecord,
      rejection: { status: 408, message: 'x' },
    }),
    'rejection with a non-integer status': JSON.stringify({
      ...rejectedRecord,
      rejection: { status: '422', message: 'x' },
    }),
    'rejection with a non-string message': JSON.stringify({
      ...rejectedRecord,
      rejection: { status: 422, message: 42 },
    }),
    'rejection with an oversized message': JSON.stringify({
      ...rejectedRecord,
      rejection: { status: 422, message: 'x'.repeat(1001) },
    }),
    'rejected with a receipt': JSON.stringify({
      ...rejectedRecord,
      receipt: { reviewId: 1, htmlUrl: 'x', via: 'created' },
    }),
    'sending with rejection details': JSON.stringify({ ...valid, rejection: rejectedRecord.rejection }),
    'completed with rejection details': JSON.stringify({
      ...valid,
      phase: 'completed',
      receipt: { reviewId: 1, htmlUrl: 'https://example.test/r/1', via: 'created' },
      rejection: rejectedRecord.rejection,
    }),
  };

  for (const [label, contents] of Object.entries(variants)) {
    for (const [op, run] of [
      ['publish', publish],
      ['recover', recover],
    ]) {
      test(`${label} is corrupt state for ${op}, never absence`, async () => {
        const world = makeWorld();
        fs.writeFileSync(world.statePath, contents, { mode: 0o600 });
        await assert.rejects(run(world), isStateError('state-corrupt'));
        assert.deepEqual(world.remote.calls(), []);
        assert.equal(fs.readFileSync(world.statePath, 'utf8'), contents);
        assert.deepEqual(fs.readdirSync(world.stateDir), [path.basename(world.statePath)]);
      });
    }
  }

  test('a state path that is a directory is a local I/O refusal', async () => {
    const world = makeWorld();
    fs.mkdirSync(world.statePath);
    await assert.rejects(publish(world), isStateError('state-io'));
    await assert.rejects(recover(world), isStateError('state-io'));
    assertNoCreateAttempt(world.remote);
  });
});

describe('restart and concurrency use on-disk state and fresh processes', () => {
  test('crash after intent but before send is uncertain in every later process', () => {
    const world = makeWorld({ create: 'crash-before-persist' });
    const crashed = runChild(world);
    assert.equal(crashed.signal, 'SIGKILL', `child did not crash at the send boundary: ${JSON.stringify(crashed.out)}`);
    const intent = readRecord(world.statePath);
    assert.equal(intent.phase, 'sending');
    assert.equal(world.remote.reviews().length, 0);

    world.remote.setConfig({ create: 'ok' });
    for (const operation of ['publish', 'recover', 'publish']) {
      const later = runChild(world, { operation });
      assert.equal(later.status, 0, later.stderr);
      assert.equal(later.out.result.status, 'uncertain', JSON.stringify(later.out));
      assert.equal(later.out.result.reason, 'not-found');
      assert.equal(later.out.result.marker, intent.marker);
    }
    assertExactlyOneCreateAttempt(world.remote);
    assert.equal(world.remote.reviews().length, 0);
  });

  test('crash after the host persisted the review is recovered by a fresh process', () => {
    const world = makeWorld({ create: 'crash-after-persist' });
    const crashed = runChild(world);
    assert.equal(crashed.signal, 'SIGKILL', `child did not crash after sending: ${JSON.stringify(crashed.out)}`);
    world.remote.setConfig({ create: 'ok' });

    const later = runChild(world, { operation: 'recover' });
    assert.equal(later.status, 0, later.stderr);
    const [stored] = world.remote.reviews();
    assert.equal(later.out.result.status, 'published', JSON.stringify(later.out));
    assert.equal(later.out.result.via, 'recovered');
    assert.equal(later.out.result.review.id, stored.id);
    assertExactlyOneCreateAttempt(world.remote);
    assert.equal(readRecord(world.statePath).phase, 'completed');
  });

  test('concurrent in-process callers on one state path send exactly once', async () => {
    const world = makeWorld();
    const settled = await Promise.allSettled(Array.from({ length: 12 }, () => publish(world)));
    assertOneWinner(
      world,
      settled.map((s) => (s.status === 'fulfilled' ? { result: s.value } : { thrown: String(s.reason) })),
    );
  });

  for (let round = 1; round <= 3; round += 1) {
    test(`concurrent separate processes on one state path send exactly once (round ${round})`, async () => {
      const world = makeWorld();
      const barrierPath = path.join(world.root, 'go');
      const running = Array.from({ length: 6 }, () => startChild(world, { barrierPath }));
      fs.writeFileSync(barrierPath, '');
      const finished = await Promise.all(running);
      for (const f of finished) assert.equal(f.status, 0, f.stderr);
      assertOneWinner(world, finished.map((f) => f.out));
    });
  }

  function assertOneWinner(world, outs) {
    const thrown = outs.filter((o) => o.thrown);
    assert.deepEqual(thrown, [], 'a concurrent caller must never see partial state or fail');
    assertExactlyOneCreateAttempt(world.remote);
    assertNoWriteOtherThanCreate(world.remote);
    const results = outs.map((o) => o.result);
    const created = results.filter((r) => r.status === 'published' && r.via === 'created');
    assert.equal(created.length, 1, 'exactly one caller is the sender');
    for (const r of results) {
      const allowed =
        (r.status === 'published' && ['created', 'recovered', 'receipt'].includes(r.via)) ||
        (r.status === 'uncertain' && r.reason === 'not-found');
      assert.ok(allowed, `unexpected concurrent outcome ${JSON.stringify(r)}`);
      assert.equal(r.marker, created[0].marker);
    }
    assert.equal(readRecord(world.statePath).phase, 'completed');
  }
});

// ---------------------------------------------------------------------------
// Runtime shape of PublicationStateError
//
// publishSarifReview passes a state error through to its caller unchanged
// unless it mentions the token, so the error's own properties are observable.
// These pin facts no type declaration expresses (own keys, cause handling).
// ---------------------------------------------------------------------------

describe('PublicationStateError runtime shape', () => {
  test('carries name and code as its only own enumerable keys; cause only when given', () => {
    const bare = new PublicationStateError('state-corrupt', 'not a valid record');
    assert.ok(bare instanceof PublicationStateError);
    assert.ok(bare instanceof Error);
    assert.equal(bare.name, 'PublicationStateError');
    assert.equal(bare.message, 'not a valid record');
    assert.equal(bare.code, 'state-corrupt');
    // Characterization of 0.2.0 key order (visible through util.inspect/JSON).
    assert.deepEqual(Object.keys(bare), ['name', 'code']);
    assert.equal(Object.hasOwn(bare, 'cause'), false);

    const cause = new Error('EIO');
    const caused = new PublicationStateError('state-io', 'cannot read', { cause });
    assert.equal(caused.cause, cause);
    assert.deepEqual(Object.keys(caused), ['name', 'code']);
  });

  test('a corrupt state file rejects with exactly that shape, keeping the parse error as cause', async () => {
    const world = makeWorld();
    fs.writeFileSync(world.statePath, '{"format":', { mode: 0o600 });
    const err = await recover(world).then(
      () => assert.fail('expected a state error'),
      (e) => e,
    );
    assert.ok(err instanceof PublicationStateError);
    assert.equal(err.code, 'state-corrupt');
    assert.deepEqual(Object.keys(err), ['name', 'code']);
    assert.ok(err.cause instanceof SyntaxError, 'the JSON parse failure is the cause');
    assertNoCreateAttempt(world.remote);
  });
});
