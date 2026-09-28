'use strict';

/**
 * Durable initial publication of one prepared review (private internal module).
 *
 * Scope (D14, D26, D29, R14): take a wholly validated, trusted prepared
 * contribution and create exactly one GitHub draft review from it — body plus
 * every inline comment in a single create-review request against an explicit
 * reviewed commit, with no submission event. SARIF/schema/source validation,
 * placement and rendering belong to the separate core that calls this module;
 * nothing here re-validates source, repairs, reassembles, submits, restores, or
 * maintains a review. Publication is one-way: once a completed receipt exists
 * locally, later human changes to the draft are not inspected.
 *
 * Delivery identity. Each caller-chosen `statePath` is one logical
 * publication, identified by destination + reviewed commit + the caller's
 * `inputFingerprint` (identity of the original SARIF artifact and options).
 * Before any remote write the coordinator publishes a complete intent record
 * at `statePath` — already declaring that sending may have begun, and holding
 * the complete intended request with its marker — by writing and flushing a
 * sibling temp file, hard-linking it into place (exclusive: fails if the path
 * exists), and flushing the parent directory. Only the invocation whose link
 * succeeded may send, and it sends at most once. Every invocation that finds
 * an existing record can only (a) return its completed receipt, or (b)
 * investigate the host for the record's marker using the saved request; it
 * never sends again, even when lookup misses, and it never incorporates a
 * later preparation. A new deliberate review of the same PR uses a new
 * `statePath`.
 *
 * Host constraint. GitHub lets an author hold only one pending (draft) review
 * per pull request and refuses a second create with HTTP 422 (observed live,
 * docs/native-suggestion-fidelity-experiment.md). A new state path therefore
 * publishes only after the account's earlier draft on that pull request has
 * been submitted or deleted by a person; this module never submits, edits or
 * deletes an existing draft to make room.
 *
 * Definitive refusal. When the transport reports a host rejection with a 4xx
 * refusal status other than 408, the record is atomically replaced by a
 * terminal 'rejected' record holding only that status and a bounded message.
 * Later publish/recover calls report the known rejection without any
 * transport call. If that replacement cannot be persisted, the saved sending
 * intent remains, later calls investigate conservatively, and nothing is ever
 * resent. A rejection claim with any other status is treated as
 * indeterminate. This does not claim the host is atomic under failures; it
 * only records the host's own definitive answer.
 *
 * Delivery evidence. A create response is not proof of delivery. Completion is
 * recorded only after one complete investigation finds exactly one review
 * carrying the exact marker, authored by the same numeric user id, against the
 * reviewed commit, whose body equals the saved body exactly and whose comments
 * equal the saved comments as a multiset (all review and comment pages read,
 * with bounded, cycle-checked pagination). Anything else is an explicit
 * uncertain outcome; nothing is repaired or retried.
 *
 * ---------------------------------------------------------------------------
 * publishPreparedReview(input, internals?) -> Promise<Outcome>
 * recoverPublication(identity, internals?) -> Promise<Outcome | Missing>
 *
 * identity:
 *   destination:      { owner: string, repo: string, pullNumber: number }
 *   reviewedCommit:   string  // full lowercase 40-hex commit; sent as commitId
 *   inputFingerprint: string  // 'sha256:<64 hex>' identity of the original
 *                             // SARIF artifact plus options, from the caller
 *   statePath:        string  // absolute, caller-chosen durable state file
 *   transport:        see test/fixtures/publication/fake-github.cjs for the
 *                     private contract (getAuthenticatedUser -> {id, login?},
 *                     createReview, listReviews, listReviewComments; host
 *                     rejections carry `hostRejected: true` and `status`).
 *                     The numeric-id lookup presumes user/PAT authentication.
 * input (publish only) additionally:
 *   preparedReview:   { body: string, comments: Comment[] }
 *     Comment: { path, side: 'LEFT'|'RIGHT', line, startSide?, startLine?, body }
 *     (start fields together or not at all; omitted for single-line comments)
 *
 * recoverPublication never creates. It is for callers that must learn whether
 * an identity already exists before doing branch-dependent preparation.
 *
 * internals (private test seam, not caller API):
 *   fs: object providing node:fs synchronous functions. All state-file I/O
 *       goes through it so tests can order durability steps against the send.
 *
 * The create request is exactly:
 *   { owner, repo, pullNumber, commitId: reviewedCommit,
 *     body: preparedReview.body + '\n\n' + marker, comments }
 * with no `event` key (draft). marker is
 *   `<!-- sarif-to-comment:review:<uuid v4> -->`
 * generated once per statePath and never regenerated. It is hidden in normal
 * rendering and is not a secret.
 *
 * Outcome (private; not a public diagnostic schema, D13):
 *   { status: 'published', via: 'created'|'recovered'|'receipt',
 *     review: { id, htmlUrl }, marker, statePath, receiptPersisted: boolean,
 *     cause? }   // cause present only when the receipt could not be persisted
 *   { status: 'uncertain', reason, marker, statePath, detail, cause?, candidates? }
 *     reason: 'not-found'          no visible review carries the marker (may be
 *                                  delayed visibility or a pre-send crash)
 *             'lookup-failed'      enumeration or readback did not complete
 *                                  (transport error, malformed or cyclic pages)
 *             'ambiguous'          more than one review carries the marker
 *             'candidate-mismatch' the marker is on a review with another
 *                                  author id or reviewed commit, or the create
 *                                  response named a different review
 *             'candidate-differs'  the marker is found, but body/comments are
 *                                  not the complete initial contribution
 *                                  (partial persistence or human change)
 *   { status: 'rejected', via: 'response'|'record', httpStatus, marker,
 *     statePath, detail, rejectionPersisted: boolean, cause? }
 *     the host definitively rejected the single create; never resent. 'response'
 *     is the call that received the refusal (with its cause); 'record' reports
 *     a previously persisted refusal without contacting the host.
 *   Missing (recover only): { status: 'missing', statePath }
 *
 * Thrown (local refusals; no remote write occurs):
 *   TypeError                                   malformed input shape, or an
 *                                               authenticated user without a
 *                                               numeric id
 *   PublicationStateError code 'state-corrupt'  existing record unreadable,
 *                                               partial, inconsistent, or not a
 *                                               known form
 *   PublicationStateError code 'state-mismatch' existing record is for another
 *                                               destination, commit, original
 *                                               input or author id
 *   PublicationStateError code 'state-io'       local I/O failed before sending
 *   Transport errors from read-only context (getAuthenticatedUser) propagate
 *   unchanged.
 *
 * State record v1 (JSON, created mode 0600, never contains credentials):
 *   { format: 'sarif-to-comment.publication-state', version: 1,
 *     phase: 'sending' | 'completed' | 'rejected', marker, destination,
 *     reviewedCommit, inputFingerprint, authorId, request, requestFingerprint,
 *     receipt?: { reviewId, htmlUrl, via: 'created'|'recovered' },
 *     rejection?: { status, message } }
 *   `receipt` is present exactly when phase is 'completed'; `rejection` exactly
 *   when phase is 'rejected' (status: integer 400-499 except 408; message: at
 *   most 1000 characters). The version stays 1 while the format is unreleased;
 *   any shape other than these is corrupt. requestFingerprint
 *   is 'sha256:' + hex SHA-256 of the request as canonical JSON (object keys
 *   sorted recursively, no insignificant whitespace, UTF-8).
 */

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');

/** Identifies a file as this module's publication state (never guessed from content). */
const STATE_FORMAT = 'sarif-to-comment.publication-state';

/** The only record version read or written; any other version is corrupt state. */
const STATE_VERSION = 1;

/** Owner-only permissions for state files: they hold review content, not credentials. */
const STATE_FILE_MODE = 0o600;

/** The hidden per-publication marker: one HTML comment carrying a v4 UUID. */
const MARKER_PATTERN =
  /^<!-- sarif-to-comment:review:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} -->$/;

/** A full, immutable, lowercase Git commit id (abbreviations are never accepted). */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** The 'sha256:<hex>' form used for both the input and the request fingerprints. */
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Diff sides a GitHub review comment can anchor to. */
const SIDES = new Set(['LEFT', 'RIGHT']);

/** Every field an inline comment may carry; anything else is refused, never sent. */
const COMMENT_KEYS = new Set(['path', 'side', 'line', 'startSide', 'startLine', 'body']);

/** Exact field set of the saved create-review request (sorted for comparison). */
const REQUEST_KEYS = ['body', 'comments', 'commitId', 'owner', 'pullNumber', 'repo'];

/** Upper bound on the persisted host refusal message; longer text is truncated. */
const MAX_REJECTION_MESSAGE = 1000;

/** Exact field set of a persisted host refusal: only its status and message. */
const REJECTION_KEYS = ['message', 'status'];

/**
 * Exact field set of a sending intent (sorted). The completed and rejected
 * phases add exactly one field each, so a record's phase fixes its shape.
 */
const SENDING_KEYS = [
  'authorId',
  'destination',
  'format',
  'inputFingerprint',
  'marker',
  'phase',
  'request',
  'requestFingerprint',
  'reviewedCommit',
  'version',
];
const COMPLETED_KEYS = [...SENDING_KEYS, 'receipt'].sort();
const REJECTED_KEYS = [...SENDING_KEYS, 'rejection'].sort();

/** Exact field set of a completed receipt. */
const RECEIPT_KEYS = ['htmlUrl', 'reviewId', 'via'];

/**
 * Whether `status` is a definitive host refusal of the create request: a 4xx
 * answer other than 408 Request Timeout, which says nothing about whether the
 * request took effect. Anything else is treated as indeterminate.
 */
function isRefusalStatus(status) {
  return Number.isInteger(status) && status >= 400 && status <= 499 && status !== 408;
}

/**
 * Upper bound on pages read in one enumeration. It turns a host that never
 * terminates pagination into a lookup failure instead of an endless loop.
 */
const MAX_PAGES = 1000;

/**
 * A local publication-state refusal. `code` distinguishes corrupt state,
 * mismatched reuse of an existing identity, and local I/O failure. Never used
 * for uncertain remote delivery, which is a returned outcome instead.
 */
class PublicationStateError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'PublicationStateError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Shape predicates shared by input validation and state-record validation
// ---------------------------------------------------------------------------

/** A non-null, non-array object (JSON object shape). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** A positive integer that JSON round-trips exactly (ids, line numbers, pull numbers). */
function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/** Whether `object` has exactly the (sorted) `keys` — no missing and no extra fields. */
function hasExactKeys(object, keys) {
  const actual = Object.keys(object).sort();
  return actual.length === keys.length && actual.every((k, i) => k === keys[i]);
}

/** Why `destination` is not a valid pull-request destination, or null. */
function destinationProblem(destination) {
  if (!isPlainObject(destination)) return 'destination must be an object';
  if (!isNonEmptyString(destination.owner)) return 'destination.owner must be a non-empty string';
  if (!isNonEmptyString(destination.repo)) return 'destination.repo must be a non-empty string';
  if (!isPositiveInteger(destination.pullNumber)) return 'destination.pullNumber must be a positive integer';
  return null;
}

/**
 * Why `comment` is not a create-review inline comment in the private shape,
 * or null. Placement correctness is the preparing core's responsibility; this
 * only guarantees the request and its readback comparison are well defined.
 */
function commentProblem(comment) {
  if (!isPlainObject(comment)) return 'comment must be an object';
  for (const key of Object.keys(comment)) {
    if (!COMMENT_KEYS.has(key)) return `comment has unsupported field ${key}`;
  }
  if (!isNonEmptyString(comment.path)) return 'comment.path must be a non-empty string';
  if (!SIDES.has(comment.side)) return 'comment.side must be LEFT or RIGHT';
  if (!isPositiveInteger(comment.line)) return 'comment.line must be a positive integer';
  if (typeof comment.body !== 'string') return 'comment.body must be a string';
  const hasStartSide = Object.hasOwn(comment, 'startSide');
  const hasStartLine = Object.hasOwn(comment, 'startLine');
  if (hasStartSide !== hasStartLine) return 'comment.startSide and comment.startLine go together';
  if (hasStartSide && !SIDES.has(comment.startSide)) return 'comment.startSide must be LEFT or RIGHT';
  if (hasStartLine && !isPositiveInteger(comment.startLine)) return 'comment.startLine must be a positive integer';
  return null;
}

// ---------------------------------------------------------------------------
// Input validation (TypeError before any I/O)
// ---------------------------------------------------------------------------

function requireInput(condition, message) {
  if (!condition) throw new TypeError(`Invalid publication input: ${message}`);
}

/** Validates the identity fields shared by publish and recover. */
function validateIdentity(input) {
  requireInput(isPlainObject(input), 'input must be an object');
  const problem = destinationProblem(input.destination);
  requireInput(problem === null, problem);
  requireInput(
    typeof input.reviewedCommit === 'string' && COMMIT_PATTERN.test(input.reviewedCommit),
    'reviewedCommit must be a full lowercase 40-hex commit',
  );
  requireInput(
    typeof input.inputFingerprint === 'string' && FINGERPRINT_PATTERN.test(input.inputFingerprint),
    "inputFingerprint must be 'sha256:' followed by 64 lowercase hex digits",
  );
  requireInput(
    isNonEmptyString(input.statePath) && path.isAbsolute(input.statePath),
    'statePath must be an absolute path chosen by the caller',
  );
  const t = input.transport;
  requireInput(
    isPlainObject(t) &&
      ['getAuthenticatedUser', 'createReview', 'listReviews', 'listReviewComments'].every(
        (m) => typeof t[m] === 'function',
      ),
    'transport must provide getAuthenticatedUser, createReview, listReviews and listReviewComments',
  );
}

function validatePreparedReview(prepared) {
  requireInput(isPlainObject(prepared), 'preparedReview must be an object');
  requireInput(typeof prepared.body === 'string', 'preparedReview.body must be a string');
  requireInput(Array.isArray(prepared.comments), 'preparedReview.comments must be an array');
  prepared.comments.forEach((comment, i) => {
    const problem = commentProblem(comment);
    requireInput(problem === null, `preparedReview.comments[${i}]: ${problem}`);
  });
}

// ---------------------------------------------------------------------------
// Canonical fingerprint and marker
// ---------------------------------------------------------------------------

/** JSON with recursively sorted object keys and no insignificant whitespace. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprintOf(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function newMarker() {
  return `<!-- sarif-to-comment:review:${crypto.randomUUID()} -->`;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    count += 1;
  }
  return count;
}

/** A comment reduced to exactly its request fields (start fields only when present). */
function copyComment(comment) {
  const copy = { path: comment.path, side: comment.side, line: comment.line };
  if (Object.hasOwn(comment, 'startSide')) {
    copy.startSide = comment.startSide;
    copy.startLine = comment.startLine;
  }
  copy.body = comment.body;
  return copy;
}

/** The single create-review request for a prepared review under `marker`. */
function buildRequest(destination, reviewedCommit, preparedReview, marker) {
  return {
    owner: destination.owner,
    repo: destination.repo,
    pullNumber: destination.pullNumber,
    commitId: reviewedCommit,
    body: `${preparedReview.body}\n\n${marker}`,
    comments: preparedReview.comments.map(copyComment),
  };
}

// ---------------------------------------------------------------------------
// State record parsing (fail closed)
// ---------------------------------------------------------------------------

/** Why a parsed value is not a consistent v1 state record, or null. */
function recordProblem(record) {
  if (!isPlainObject(record)) return 'record is not a JSON object';
  if (record.format !== STATE_FORMAT) return 'unknown record format';
  if (record.version !== STATE_VERSION) return 'unsupported record version';
  const keysByPhase = { sending: SENDING_KEYS, completed: COMPLETED_KEYS, rejected: REJECTED_KEYS };
  if (!Object.hasOwn(keysByPhase, record.phase)) return 'unknown record phase';
  if (!hasExactKeys(record, keysByPhase[record.phase])) return 'record fields do not match its phase';
  if (typeof record.marker !== 'string' || !MARKER_PATTERN.test(record.marker)) return 'malformed marker';
  const destProblem = destinationProblem(record.destination);
  if (destProblem) return destProblem;
  if (!hasExactKeys(record.destination, ['owner', 'pullNumber', 'repo'])) return 'destination has extra fields';
  if (typeof record.reviewedCommit !== 'string' || !COMMIT_PATTERN.test(record.reviewedCommit)) {
    return 'malformed reviewedCommit';
  }
  if (typeof record.inputFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(record.inputFingerprint)) {
    return 'malformed inputFingerprint';
  }
  if (!isPositiveInteger(record.authorId)) return 'malformed authorId';

  const request = record.request;
  if (!isPlainObject(request) || !hasExactKeys(request, REQUEST_KEYS)) return 'malformed saved request';
  if (
    request.owner !== record.destination.owner ||
    request.repo !== record.destination.repo ||
    request.pullNumber !== record.destination.pullNumber
  ) {
    return 'saved request destination is inconsistent';
  }
  if (request.commitId !== record.reviewedCommit) return 'saved request commit is inconsistent';
  if (typeof request.body !== 'string') return 'saved request body is not a string';
  if (!request.body.endsWith(`\n\n${record.marker}`) || countOccurrences(request.body, record.marker) !== 1) {
    return 'saved request body does not end with exactly one marker';
  }
  if (!Array.isArray(request.comments)) return 'saved request comments are not a list';
  for (const comment of request.comments) {
    const problem = commentProblem(comment);
    if (problem) return `saved request ${problem}`;
  }
  if (typeof record.requestFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(record.requestFingerprint)) {
    return 'malformed requestFingerprint';
  }
  if (record.requestFingerprint !== fingerprintOf(request)) return 'saved request does not match its fingerprint';

  if (record.phase === 'completed') {
    const receipt = record.receipt;
    if (!isPlainObject(receipt) || !hasExactKeys(receipt, RECEIPT_KEYS)) return 'malformed receipt';
    if (!isPositiveInteger(receipt.reviewId)) return 'malformed receipt reviewId';
    if (!isNonEmptyString(receipt.htmlUrl)) return 'malformed receipt htmlUrl';
    if (receipt.via !== 'created' && receipt.via !== 'recovered') return 'malformed receipt via';
  }
  if (record.phase === 'rejected') {
    const rejection = record.rejection;
    if (!isPlainObject(rejection) || !hasExactKeys(rejection, REJECTION_KEYS)) return 'malformed rejection';
    if (!isRefusalStatus(rejection.status)) return 'rejection status is not a definitive refusal';
    if (typeof rejection.message !== 'string' || rejection.message.length > MAX_REJECTION_MESSAGE) {
      return 'malformed rejection message';
    }
  }
  return null;
}

/**
 * The record at `statePath`, or null only when no file exists there. Every
 * other condition — empty, truncated, unparsable, inconsistent — is corrupt
 * and must never be mistaken for absence.
 */
function readState(fs, statePath) {
  let text;
  try {
    text = fs.readFileSync(statePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new PublicationStateError('state-io', `Cannot read publication state at ${statePath}.`, { cause: err });
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch (err) {
    throw new PublicationStateError(
      'state-corrupt',
      `Publication state at ${statePath} is not complete JSON; it is not treated as absent.`,
      { cause: err },
    );
  }
  const problem = recordProblem(record);
  if (problem) {
    throw new PublicationStateError(
      'state-corrupt',
      `Publication state at ${statePath} is not a valid record (${problem}); it is not treated as absent.`,
    );
  }
  return record;
}

// ---------------------------------------------------------------------------
// Durable state writes
// ---------------------------------------------------------------------------

/** Makes directory-entry changes (link, rename) in `dir` durable. */
function flushDirectory(fs, dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Best-effort removal of this module's own temp file. */
function removeQuietly(fs, file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // A leftover temp file is harmless: it is never read as state.
  }
}

/**
 * Writes `text` to a new owner-only temp file beside `statePath` and flushes
 * it. The temp name is unique, so concurrent writers never share one.
 */
function writeFlushedSibling(fs, statePath, text) {
  const tmp = path.join(
    path.dirname(statePath),
    `.${path.basename(statePath)}.${crypto.randomUUID()}.tmp`,
  );
  const fd = fs.openSync(tmp, 'wx', STATE_FILE_MODE);
  try {
    const bytes = Buffer.from(text, 'utf8');
    for (let offset = 0; offset < bytes.length; ) {
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    removeQuietly(fs, tmp);
    throw err;
  }
  fs.closeSync(fd);
  return tmp;
}

/** The on-disk text of a record: indented JSON with a terminal newline. */
function serialize(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Exclusively publishes a complete intent record at `statePath`. Returns true
 * when this call created it (and may therefore send), false when a record
 * already existed. Hard-linking a flushed temp file makes the claim exclusive
 * and means no reader can ever observe a partially written record. A failure
 * after the link leaves the record in place: sending may be considered begun,
 * so later invocations only investigate.
 */
function claimIntent(fs, statePath, record) {
  let tmp;
  try {
    tmp = writeFlushedSibling(fs, statePath, serialize(record));
  } catch (err) {
    throw new PublicationStateError('state-io', `Cannot write publication intent beside ${statePath}.`, {
      cause: err,
    });
  }
  try {
    fs.linkSync(tmp, statePath);
  } catch (err) {
    removeQuietly(fs, tmp);
    if (err && err.code === 'EEXIST') return false;
    throw new PublicationStateError('state-io', `Cannot publish publication intent at ${statePath}.`, {
      cause: err,
    });
  }
  removeQuietly(fs, tmp);
  try {
    flushDirectory(fs, path.dirname(statePath));
  } catch (err) {
    throw new PublicationStateError(
      'state-io',
      `Publication intent at ${statePath} could not be made durable; nothing was sent, and this state path will not send.`,
      { cause: err },
    );
  }
  return true;
}

/**
 * Atomically and durably replaces the record with a terminal form (completed
 * receipt or persisted rejection): flushed sibling, rename, directory flush.
 * A failure leaves the previous record intact.
 */
function replaceRecord(fs, statePath, nextRecord) {
  const tmp = writeFlushedSibling(fs, statePath, serialize(nextRecord));
  try {
    fs.renameSync(tmp, statePath);
  } catch (err) {
    removeQuietly(fs, tmp);
    throw err;
  }
  flushDirectory(fs, path.dirname(statePath));
}

// ---------------------------------------------------------------------------
// Host reads (bounded, complete, never write)
// ---------------------------------------------------------------------------

/** An incomplete or untrustworthy host read; it proves neither presence nor absence. */
class LookupFailure extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'LookupFailure';
  }
}

/**
 * Reads every page of a cursor-paginated listing. A page that is malformed,
 * a cursor that repeats within the enumeration, or more than MAX_PAGES pages
 * is a LookupFailure: an incomplete enumeration can prove neither absence nor
 * uniqueness.
 */
async function readAllPages(fetchPage, itemsKey) {
  const items = [];
  const seen = new Set();
  let cursor = null;
  for (let pages = 1; ; pages += 1) {
    if (pages > MAX_PAGES) throw new LookupFailure(`pagination exceeded ${MAX_PAGES} pages`);
    let page;
    try {
      page = await fetchPage(cursor);
    } catch (err) {
      throw new LookupFailure('a page could not be read', { cause: err });
    }
    if (!isPlainObject(page) || !Array.isArray(page[itemsKey])) {
      throw new LookupFailure('the host returned a malformed page');
    }
    items.push(...page[itemsKey]);
    const next = page.nextCursor;
    if (next === null) return items;
    if (!isNonEmptyString(next)) throw new LookupFailure('the host returned a malformed cursor');
    if (seen.has(next)) throw new LookupFailure('the host repeated a pagination cursor');
    seen.add(next);
    cursor = next;
  }
}

/** Canonical comparison key for a comment's anchor and text. */
function commentKey(comment) {
  if (!isPlainObject(comment)) return 'invalid';
  return canonicalJson({
    path: comment.path ?? null,
    side: comment.side ?? null,
    line: comment.line ?? null,
    startSide: comment.startSide ?? null,
    startLine: comment.startLine ?? null,
    body: comment.body ?? null,
  });
}

/** Whether two comment lists are equal as multisets (cardinality matters). */
function sameCommentMultiset(expected, actual) {
  if (expected.length !== actual.length) return false;
  const counts = new Map();
  for (const c of expected) counts.set(commentKey(c), (counts.get(commentKey(c)) || 0) + 1);
  for (const c of actual) {
    const key = commentKey(c);
    const remaining = counts.get(key) || 0;
    if (remaining === 0) return false;
    counts.set(key, remaining - 1);
  }
  return true;
}

/** The identifiers of a host review that outcomes may expose. */
function reviewRef(summary) {
  return { id: summary.id, htmlUrl: summary.htmlUrl };
}

/**
 * Establishes, read-only, whether the host holds exactly this publication's
 * complete initial contribution. Returns { complete: true, review } or
 * { complete: false, reason, detail, cause?, candidates? }.
 */
async function investigate(transport, record) {
  const { owner, repo, pullNumber } = record.destination;
  let reviews;
  try {
    reviews = await readAllPages(
      (cursor) => transport.listReviews({ owner, repo, pullNumber, cursor }),
      'reviews',
    );
  } catch (err) {
    return lookupFailed(err);
  }
  const byId = new Map();
  for (const review of reviews) {
    if (!isPlainObject(review) || !isPositiveInteger(review.id) || typeof review.body !== 'string') {
      return lookupFailed(new LookupFailure('the host returned a malformed review summary'));
    }
    if (review.body.includes(record.marker) && !byId.has(review.id)) byId.set(review.id, review);
  }
  const candidates = [...byId.values()];
  if (candidates.length === 0) {
    return {
      complete: false,
      reason: 'not-found',
      detail:
        'No review on the destination currently carries this publication marker. The review may not be visible yet, the create may not have reached the host, or the marker may have been removed. This state path will never send again; retry later to recheck, or use a new state path only if a separate review is intended.',
    };
  }
  if (candidates.length > 1) {
    return {
      complete: false,
      reason: 'ambiguous',
      detail: 'More than one review carries this publication marker; none is chosen automatically.',
      candidates: candidates.map(reviewRef),
    };
  }
  const [candidate] = candidates;
  if (candidate.authorId !== record.authorId || candidate.commitId !== record.reviewedCommit) {
    return {
      complete: false,
      reason: 'candidate-mismatch',
      detail: 'The review carrying this marker has a different author or reviewed commit than this publication.',
      candidates: [reviewRef(candidate)],
    };
  }
  if (candidate.body !== record.request.body) {
    return differs(candidate, 'body');
  }
  let comments;
  try {
    comments = await readAllPages(
      (cursor) => transport.listReviewComments({ owner, repo, pullNumber, reviewId: candidate.id, cursor }),
      'comments',
    );
  } catch (err) {
    return lookupFailed(err);
  }
  if (!sameCommentMultiset(record.request.comments, comments)) return differs(candidate, 'inline comments');
  if (!isNonEmptyString(candidate.htmlUrl)) {
    return lookupFailed(new LookupFailure('the matching review has no URL'));
  }
  return { complete: true, review: reviewRef(candidate) };
}

/** Verdict for an enumeration or readback that did not complete. */
function lookupFailed(err) {
  return {
    complete: false,
    reason: 'lookup-failed',
    detail: `Could not completely enumerate the destination's reviews or the matching review's comments (${err.message}). Nothing is concluded from a partial lookup.`,
    cause: err,
  };
}

/** Verdict for the sole marker candidate whose content is not the initial contribution. */
function differs(candidate, what) {
  return {
    complete: false,
    reason: 'candidate-differs',
    detail: `The review carrying this marker does not hold the complete initial contribution (its ${what} differ). It is neither repaired nor restored; inspect it on the host.`,
    candidates: [reviewRef(candidate)],
  };
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** A published outcome; `cause` is present only when the receipt could not be saved. */
function publishedOutcome(record, statePath, review, via, receiptPersisted, cause) {
  const outcome = {
    status: 'published',
    via,
    review: { id: review.id, htmlUrl: review.htmlUrl },
    marker: record.marker,
    statePath,
    receiptPersisted,
  };
  if (cause !== undefined) outcome.cause = cause;
  return outcome;
}

/** An uncertain outcome; an indeterminate send error takes precedence as its cause. */
function uncertainOutcome(record, statePath, verdict, sendCause) {
  const outcome = {
    status: 'uncertain',
    reason: verdict.reason,
    marker: record.marker,
    statePath,
    detail: verdict.detail,
  };
  const cause = sendCause !== undefined ? sendCause : verdict.cause;
  if (cause !== undefined) outcome.cause = cause;
  if (verdict.candidates) outcome.candidates = verdict.candidates;
  return outcome;
}

/** The outcome of a completed receipt, reported without contacting the host. */
function receiptOutcome(record, statePath) {
  const { reviewId, htmlUrl } = record.receipt;
  return publishedOutcome(record, statePath, { id: reviewId, htmlUrl }, 'receipt', true);
}

/** Explanation of a definitive refusal, quoting the host's (bounded) message. */
function rejectionDetail(status, message) {
  return `GitHub refused the create-review request (HTTP ${status}): ${message} It is never resent; this state path now records the refusal. Resolve the cause, then publish under a new state path.`;
}

/** The outcome of a persisted refusal, reported without contacting the host. */
function knownRejectionOutcome(record, statePath) {
  const { status, message } = record.rejection;
  return {
    status: 'rejected',
    via: 'record',
    httpStatus: status,
    marker: record.marker,
    statePath,
    detail: rejectionDetail(status, message),
    rejectionPersisted: true,
  };
}

/**
 * Records a definitive host refusal of the single create. Only the status and
 * a bounded message are kept: transport errors may carry request details that
 * must never reach state. If the terminal record cannot be saved, the sending
 * intent remains and later calls investigate conservatively; nothing is resent.
 */
function settleRejection(fs, statePath, record, err) {
  const message = String(err.message ?? '').slice(0, MAX_REJECTION_MESSAGE);
  const rejected = { ...record, phase: 'rejected', rejection: { status: err.status, message } };
  let rejectionPersisted = true;
  try {
    replaceRecord(fs, statePath, rejected);
  } catch {
    rejectionPersisted = false;
  }
  return {
    status: 'rejected',
    via: 'response',
    httpStatus: err.status,
    marker: record.marker,
    statePath,
    detail: rejectionPersisted
      ? rejectionDetail(err.status, message)
      : `GitHub refused the create-review request (HTTP ${err.status}): ${message} The refusal could not be saved at ${statePath}; later calls on this state path will report uncertain delivery, and nothing is ever resent.`,
    rejectionPersisted,
    cause: err,
  };
}

/**
 * Investigates once and, only for verified complete delivery, persists the
 * completed receipt. `responseId` is the id a create response named, if any;
 * `sendCause` is an indeterminate create error, if any.
 */
async function settle(fs, statePath, record, transport, { responseId, sendCause } = {}) {
  const verdict = await investigate(transport, record);
  if (!verdict.complete) return uncertainOutcome(record, statePath, verdict, sendCause);
  if (responseId !== undefined && responseId !== verdict.review.id) {
    return uncertainOutcome(record, statePath, {
      reason: 'candidate-mismatch',
      detail: 'The create response named a different review than the single review carrying this marker.',
      candidates: [verdict.review],
    });
  }
  const via = responseId !== undefined ? 'created' : 'recovered';
  const completed = {
    ...record,
    phase: 'completed',
    receipt: { reviewId: verdict.review.id, htmlUrl: verdict.review.htmlUrl, via },
  };
  try {
    replaceRecord(fs, statePath, completed);
  } catch (err) {
    const cause = new PublicationStateError(
      'state-io',
      `The review was verified on the host, but its completed receipt could not be saved at ${statePath} (${err.message}). The saved intent remains; a later call will recover it without sending.`,
      { cause: err },
    );
    return publishedOutcome(record, statePath, verdict.review, via, false, cause);
  }
  return publishedOutcome(record, statePath, verdict.review, via, true);
}

// ---------------------------------------------------------------------------
// Identity checks
// ---------------------------------------------------------------------------

/** The authenticated user's stable numeric id (login is mutable and unused). */
async function authenticatedUserId(transport) {
  const user = await transport.getAuthenticatedUser();
  if (!isPlainObject(user) || !isPositiveInteger(user.id)) {
    throw new TypeError('The transport did not report a numeric authenticated user id.');
  }
  return user.id;
}

/** Refusal to reuse an existing identity for different input. */
function mismatch(statePath, what) {
  return new PublicationStateError(
    'state-mismatch',
    `Publication state at ${statePath} belongs to a different ${what}. An existing publication identity cannot take changed input; use a new state path for a separate review.`,
  );
}

/** Throws state-mismatch unless the record belongs to this destination, commit and original input. */
function assertSameIdentity(record, input) {
  const d = input.destination;
  if (
    record.destination.owner !== d.owner ||
    record.destination.repo !== d.repo ||
    record.destination.pullNumber !== d.pullNumber
  ) {
    throw mismatch(input.statePath, 'destination');
  }
  if (record.reviewedCommit !== input.reviewedCommit) throw mismatch(input.statePath, 'reviewed commit');
  if (record.inputFingerprint !== input.inputFingerprint) throw mismatch(input.statePath, 'original input');
}

/**
 * Continues an existing publication identity without ever sending: a
 * completed receipt or a persisted refusal returns immediately with no
 * transport call; a sending intent is investigated using its saved request.
 */
async function continueExisting(fs, record, input) {
  assertSameIdentity(record, input);
  if (record.phase === 'completed') return receiptOutcome(record, input.statePath);
  if (record.phase === 'rejected') return knownRejectionOutcome(record, input.statePath);
  const userId = await authenticatedUserId(input.transport);
  if (userId !== record.authorId) throw mismatch(input.statePath, 'authenticated author');
  return settle(fs, input.statePath, record, input.transport);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Publishes a prepared review under a new identity at `statePath`, or — when
 * a record already exists there — continues that identity without sending.
 */
async function publishPreparedReview(input, internals = {}) {
  validateIdentity(input);
  validatePreparedReview(input.preparedReview);
  const fs = internals.fs || nodeFs;
  const { statePath, transport } = input;

  const existing = readState(fs, statePath);
  if (existing) return continueExisting(fs, existing, input);

  const authorId = await authenticatedUserId(transport);
  const marker = newMarker();
  const request = buildRequest(input.destination, input.reviewedCommit, input.preparedReview, marker);
  const record = {
    format: STATE_FORMAT,
    version: STATE_VERSION,
    phase: 'sending',
    marker,
    destination: {
      owner: input.destination.owner,
      repo: input.destination.repo,
      pullNumber: input.destination.pullNumber,
    },
    reviewedCommit: input.reviewedCommit,
    inputFingerprint: input.inputFingerprint,
    authorId,
    request,
    requestFingerprint: fingerprintOf(request),
  };

  if (!claimIntent(fs, statePath, record)) {
    // Another invocation claimed this identity first; only its sender may send.
    const claimed = readState(fs, statePath);
    if (!claimed) {
      throw new PublicationStateError('state-io', `Publication state at ${statePath} vanished after a concurrent claim.`);
    }
    return continueExisting(fs, claimed, input);
  }

  let response;
  try {
    response = await transport.createReview(structuredClone(request));
  } catch (err) {
    if (err && err.hostRejected === true && isRefusalStatus(err.status)) {
      return settleRejection(fs, statePath, record, err);
    }
    return settle(fs, statePath, record, transport, { sendCause: err });
  }
  const responseId = isPlainObject(response) && isPositiveInteger(response.id) ? response.id : undefined;
  return settle(fs, statePath, record, transport, { responseId });
}

/**
 * Reports an existing publication identity without ever creating: 'missing'
 * when no record exists, otherwise the receipt, a verified recovery, or an
 * uncertain outcome. Safe to call before any branch-dependent preparation.
 */
async function recoverPublication(input, internals = {}) {
  validateIdentity(input);
  const fs = internals.fs || nodeFs;
  const existing = readState(fs, input.statePath);
  if (!existing) return { status: 'missing', statePath: input.statePath };
  return continueExisting(fs, existing, input);
}

module.exports = { publishPreparedReview, recoverPublication, PublicationStateError };
