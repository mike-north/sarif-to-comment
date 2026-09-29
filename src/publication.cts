/**
 * Durable initial publication of one prepared review (private internal module).
 *
 * Scope (D14, D16, D26, D29, R14): take a wholly validated, trusted prepared
 * contribution and create exactly one GitHub review from it — body plus every
 * inline comment in a single create-review request against an explicit
 * reviewed commit. The review is a draft (no submission event) unless the
 * caller explicitly asked for it to be submitted, in which case the same
 * request carries `event: 'COMMENT'` (docs/submitted-review-contract.md). SARIF/schema/source validation,
 * placement and rendering belong to the separate core that calls this module;
 * nothing here re-validates source, repairs, reassembles, submits, restores, or
 * maintains a review. Publication is one-way: once a completed receipt exists
 * locally, later human changes to the draft are not inspected.
 *
 * Delivery identity. Each caller-chosen `statePath` is one logical
 * publication, identified by destination + reviewed commit + the caller's
 * `inputFingerprint` (identity of the original SARIF artifact and options) +
 * the publication mode (draft or submitted), which the saved request records.
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
 * with bounded, cycle-checked pagination). A submitted publication's review
 * must also be COMMENTED; a draft's state is not compared, so a draft a
 * person has since submitted still confirms its initial delivery. Anything else is an explicit
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
 *   submit?:          boolean // true: create the review already submitted
 *                             // (event COMMENT); absent or false: a draft
 *   transport:        see test/fixtures/publication/fake-github.mts for the
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
 * with no `event` key for a draft, and with `event: 'COMMENT'` added for a
 * submitted publication. marker is
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
 *                                               destination, commit, publication
 *                                               mode, original input or author
 *                                               id
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
 *   `request` has an `event` key exactly for a submitted publication, and its
 *   only value is 'COMMENT'; a request without it is a draft's, so every
 *   record written before submitted publication existed reads as a draft.
 *   `receipt` is present exactly when phase is 'completed'; `rejection` exactly
 *   when phase is 'rejected' (status: integer 400-499 except 408; message: at
 *   most 1000 characters). The version stays 1 while the format is unreleased;
 *   any shape other than these is corrupt. As in 0.2.0, a phase that is a
 *   JSON array whose string form names a phase (['sending'], [['rejected']])
 *   is also read: its record must carry that phase's field set, its receipt or
 *   rejection value is never validated or answered from, and it is
 *   investigated like an intent (see ParsedPhase). requestFingerprint
 *   is 'sha256:' + hex SHA-256 of the request as canonical JSON (object keys
 *   sorted recursively, no insignificant whitespace, UTF-8).
 */

import * as crypto from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Domain types (private to this module; the transport contract is structural
// so the GitHub adapter can satisfy it without this module depending on it)
// ---------------------------------------------------------------------------

/** Diff side a GitHub review comment anchors to. */
type ReviewSide = 'LEFT' | 'RIGHT';

/** The pull request a publication targets. */
interface IPublicationDestination {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
}

/** A single-line inline comment exactly as sent: no start fields at all. */
interface ISingleLineRequestComment {
  readonly path: string;
  readonly side: ReviewSide;
  readonly line: number;
  readonly body: string;
}

/** A multi-line inline comment: the start fields are present together. */
interface IMultiLineRequestComment extends ISingleLineRequestComment {
  readonly startSide: ReviewSide;
  readonly startLine: number;
}

/**
 * One inline comment exactly as sent in the create-review request. The start
 * fields are present together or omitted, never present as undefined.
 */
type ReviewRequestComment = ISingleLineRequestComment | IMultiLineRequestComment;

/** The caller's prepared contribution: review body plus inline comments. */
interface IPreparedReview {
  readonly body: string;
  readonly comments: readonly ReviewRequestComment[];
}

/** The only submission event this module sends: a comment review, never a verdict. */
type SubmitEvent = 'COMMENT';

/** The single create-review request of a draft: no `event` key. */
interface IDraftReviewRequest {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly commitId: string;
  readonly body: string;
  readonly comments: readonly ReviewRequestComment[];
}

/** The single create-review request of a submitted publication. */
interface ISubmittedReviewRequest extends IDraftReviewRequest {
  readonly event: SubmitEvent;
}

/** The single create-review request; `event` is present exactly when submitting. */
type ICreateReviewRequest = IDraftReviewRequest | ISubmittedReviewRequest;

/** How the review is published: left as a draft, or submitted as a comment review. */
type PublicationMode = 'draft' | 'submitted';

/** Query for one page of the pull request's reviews; `cursor: null` starts. */
interface IReviewListQuery {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly cursor: string | null;
}

/** Query for one page of a review's inline comments; `cursor: null` starts. */
interface IReviewCommentListQuery extends IReviewListQuery {
  readonly reviewId: number;
}

/**
 * The private host transport this module calls (the full contract is
 * documented in test/fixtures/publication/fake-github.mts). Every result is
 * `unknown`: host answers are validated here before anything relies on them,
 * and a thrown error is only a definitive refusal when it carries
 * `hostRejected: true` with a refusal status.
 */
interface IPublicationTransport {
  getAuthenticatedUser(): Promise<unknown>;
  createReview(request: ICreateReviewRequest): Promise<unknown>;
  listReviews(query: IReviewListQuery): Promise<unknown>;
  listReviewComments(query: IReviewCommentListQuery): Promise<unknown>;
}

/** The identity fields shared by publish and recover, once validated. */
interface IPublicationIdentity {
  readonly destination: IPublicationDestination;
  readonly reviewedCommit: string;
  readonly inputFingerprint: string;
  readonly statePath: string;
  readonly transport: IPublicationTransport;
  readonly submit?: boolean | undefined;
}

/**
 * Exactly the synchronous node:fs functions state-file I/O uses. node:fs
 * satisfies it; the private test seam substitutes wrappers that record or
 * fail individual durability steps.
 */
interface IPublicationFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  openSync(path: string, flags: string, mode?: number): number;
  writeSync(fd: number, buffer: Buffer, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  linkSync(existingPath: string, newPath: string): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
}

/** The private test seam (see the module comment); not caller API. */
interface IPublicationInternals {
  readonly fs?: IPublicationFs;
}

/** Codes distinguishing the local refusals a PublicationStateError reports. */
type PublicationStateErrorCode = 'state-corrupt' | 'state-mismatch' | 'state-io';

/** The phase of a state record; it fixes the record's exact field set. */
type RecordPhase = 'sending' | 'completed' | 'rejected';

/** How a completed receipt was established. */
type ReceiptVia = 'created' | 'recovered';

/** The completed receipt of a verified delivery. */
interface IReceipt {
  readonly reviewId: number;
  readonly htmlUrl: string;
  readonly via: ReceiptVia;
}

/** A persisted definitive host refusal: only its status and bounded message. */
interface IRejection {
  readonly status: number;
  readonly message: string;
}

/** Fields every v1 state record carries, whatever its phase. */
interface IStateRecordBase {
  readonly format: typeof STATE_FORMAT;
  readonly version: typeof STATE_VERSION;
  readonly marker: string;
  readonly destination: IPublicationDestination;
  readonly reviewedCommit: string;
  readonly inputFingerprint: string;
  readonly authorId: number;
  readonly request: ICreateReviewRequest;
  readonly requestFingerprint: string;
}

/** An intent record: sending may have begun; only investigation may follow. */
interface ISendingRecord extends IStateRecordBase {
  readonly phase: 'sending';
}

/** A terminal record holding the verified receipt. */
interface ICompletedRecord extends IStateRecordBase {
  readonly phase: 'completed';
  readonly receipt: IReceipt;
}

/** A terminal record holding the host's definitive refusal. */
interface IRejectedRecord extends IStateRecordBase {
  readonly phase: 'rejected';
  readonly rejection: IRejection;
}

/** A state record this module writes: its phase fixes its exact field set. */
type StateRecord = ISendingRecord | ICompletedRecord | IRejectedRecord;

/**
 * A non-string phase that state validation accepts: a one-element JSON array
 * holding a phase name or, recursively, another such array. 0.2.0 looked a
 * record's phase up as a property key, and property-key coercion turns these
 * arrays (and only these, among JSON values) into a phase name, so state files
 * with them were accepted. Parsing keeps accepting them so that every state
 * file keeps its 0.2.0 handling; this module never writes one.
 */
type CoercedPhase = readonly [ParsedPhase];

/** A phase value as parsed from a state file (see CoercedPhase). */
type ParsedPhase = RecordPhase | CoercedPhase;

/**
 * A parsed record whose phase is a CoercedPhase. Validation matched its field
 * set to the coerced phase name, so it holds a `receipt` when that name is
 * 'completed' and a `rejection` when it is 'rejected', but it checked their
 * contents only for a string phase. They are therefore unknown here, and such
 * a record is never answered from them: only a string phase selects the
 * receipt or rejection branch, so this record is investigated like an intent.
 */
interface ICoercedPhaseRecord extends IStateRecordBase {
  readonly phase: CoercedPhase;
  readonly receipt?: unknown;
  readonly rejection?: unknown;
}

/**
 * A state record that passed every consistency check in recordProblem. It is
 * wider than StateRecord only by the historical coerced-phase forms.
 */
type ParsedStateRecord = StateRecord | ICoercedPhaseRecord;

/** A parsed record that continueExisting investigates rather than answering from. */
type InvestigatedRecord = ISendingRecord | ICoercedPhaseRecord;

/** A review the host verifiably holds for this publication. */
interface IReviewRef {
  readonly id: number;
  readonly htmlUrl: string;
}

/**
 * A review an uncertain outcome points at. Its URL is reported as the host
 * gave it: only the single verified review has a checked URL.
 */
interface ICandidateRef {
  readonly id: number;
  readonly htmlUrl: unknown;
}

/**
 * A host review summary after the checks investigate relies on (positive
 * integer id, string body). Other fields are compared, never trusted.
 */
interface IHostReviewSummary {
  readonly id: number;
  readonly body: string;
  readonly htmlUrl?: unknown;
  readonly authorId?: unknown;
  readonly commitId?: unknown;
  readonly state?: unknown;
}

/** Why delivery could not be verified (see the module comment). */
type UncertainReason = 'not-found' | 'lookup-failed' | 'ambiguous' | 'candidate-mismatch' | 'candidate-differs';

/** What an uncertain outcome reports about an unverified delivery. */
interface IUncertainFinding {
  readonly reason: UncertainReason;
  readonly detail: string;
  readonly cause?: unknown;
  readonly candidates?: readonly ICandidateRef[];
}

/** Result of one read-only investigation of the host. */
type Verdict =
  | { readonly complete: true; readonly review: IReviewRef }
  | (IUncertainFinding & { readonly complete: false });

/** Verified delivery; `cause` is present only when the receipt was not saved. */
interface IPublishedOutcome {
  readonly status: 'published';
  readonly via: ReceiptVia | 'receipt';
  readonly review: IReviewRef;
  readonly marker: string;
  readonly statePath: string;
  readonly receiptPersisted: boolean;
  readonly cause?: unknown;
}

/** Delivery that could not be verified; nothing was repaired or resent. */
interface IUncertainOutcome {
  readonly status: 'uncertain';
  readonly reason: UncertainReason;
  readonly marker: string;
  readonly statePath: string;
  readonly detail: string;
  readonly cause?: unknown;
  readonly candidates?: readonly ICandidateRef[];
}

/** The host definitively refused the single create; it is never resent. */
interface IRejectedOutcome {
  readonly status: 'rejected';
  readonly via: 'response' | 'record';
  readonly httpStatus: number;
  readonly marker: string;
  readonly statePath: string;
  readonly detail: string;
  readonly rejectionPersisted: boolean;
  readonly cause?: unknown;
}

/** Recover only: no record exists at the state path. */
interface IMissingOutcome {
  readonly status: 'missing';
  readonly statePath: string;
}

/** Every outcome of a publish (and of a recover that found a record). */
type PublicationOutcome = IPublishedOutcome | IUncertainOutcome | IRejectedOutcome;

/**
 * A thrown value marking a definitive host refusal of the create request:
 * `hostRejected: true` with a refusal status. Its message is untrusted text.
 */
interface IHostRejection {
  readonly hostRejected: true;
  readonly status: number;
  readonly message?: unknown;
}

/** A JSON-object-shaped value whose fields are not yet validated. */
type UnknownObject = Readonly<Record<string, unknown>>;

/** A mutable view used only while an outcome's optional fields are assigned. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

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
const SIDES: ReadonlySet<unknown> = new Set(['LEFT', 'RIGHT']);

/** Every field an inline comment may carry; anything else is refused, never sent. */
const COMMENT_KEYS: ReadonlySet<string> = new Set(['path', 'side', 'line', 'startSide', 'startLine', 'body']);

/** Exact field set of a draft's saved create-review request (sorted for comparison). */
const REQUEST_KEYS: readonly string[] = ['body', 'comments', 'commitId', 'owner', 'pullNumber', 'repo'];

/** Exact field set of a submitted publication's saved request: the draft's plus `event`. */
const SUBMITTED_REQUEST_KEYS: readonly string[] = [...REQUEST_KEYS, 'event'].sort();

/** The submission event of a submitted publication (docs/submitted-review-contract.md §2.1). */
const SUBMIT_EVENT: SubmitEvent = 'COMMENT';

/** The host state of a review created with SUBMIT_EVENT. */
const SUBMITTED_STATE = 'COMMENTED';

/** Upper bound on the persisted host refusal message; longer text is truncated. */
const MAX_REJECTION_MESSAGE = 1000;

/** Exact field set of a persisted host refusal: only its status and message. */
const REJECTION_KEYS: readonly string[] = ['message', 'status'];

/**
 * Exact field set of a sending intent (sorted). The completed and rejected
 * phases add exactly one field each, so a record's phase fixes its shape.
 */
const SENDING_KEYS: readonly string[] = [
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
const COMPLETED_KEYS: readonly string[] = [...SENDING_KEYS, 'receipt'].sort();
const REJECTED_KEYS: readonly string[] = [...SENDING_KEYS, 'rejection'].sort();

/** Exact field set of a completed receipt. */
const RECEIPT_KEYS: readonly string[] = ['htmlUrl', 'reviewId', 'via'];

/**
 * Whether `status` is a definitive host refusal of the create request: a 4xx
 * answer other than 408 Request Timeout, which says nothing about whether the
 * request took effect. Anything else is treated as indeterminate.
 */
function isRefusalStatus(status: unknown): status is number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 499 && status !== 408;
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
  // `declare` keeps `code` an own property created by the constructor
  // assignment below, after `name`, so the enumerable keys stay
  // ['name', 'code'] (a class field would be defined first).
  declare readonly code: PublicationStateErrorCode;

  constructor(code: PublicationStateErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublicationStateError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Shape predicates shared by input validation and state-record validation
// ---------------------------------------------------------------------------

/** A non-null, non-array object (JSON object shape). */
function isPlainObject(value: unknown): value is UnknownObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An array whose items are not yet validated. */
function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** A positive integer that JSON round-trips exactly (ids, line numbers, pull numbers). */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Whether `object` has exactly the (sorted) `keys` — no missing and no extra fields. */
function hasExactKeys(object: object, keys: readonly string[]): boolean {
  const actual = Object.keys(object).sort();
  return actual.length === keys.length && actual.every((k, i) => k === keys[i]);
}

/**
 * The value of `err.code` for a thrown value of any type, as the property
 * access `err && err.code` would read it (primitives have no such field).
 */
function thrownCode(err: unknown): unknown {
  return (typeof err === 'object' || typeof err === 'function') && err !== null && 'code' in err
    ? err.code
    : undefined;
}

/**
 * The value of `err.message` for a thrown value of any type (primitives have
 * no such field). Only the private fs seam or the host transport can throw a
 * non-Error; node:fs and this module always throw Error instances.
 */
function thrownMessage(err: unknown): unknown {
  return (typeof err === 'object' || typeof err === 'function') && err !== null && 'message' in err
    ? err.message
    : undefined;
}

/** Why `destination` is not a valid pull-request destination, or null. */
function destinationProblem(destination: unknown): string | null {
  if (!isPlainObject(destination)) return 'destination must be an object';
  if (!isNonEmptyString(destination['owner'])) return 'destination.owner must be a non-empty string';
  if (!isNonEmptyString(destination['repo'])) return 'destination.repo must be a non-empty string';
  if (!isPositiveInteger(destination['pullNumber'])) return 'destination.pullNumber must be a positive integer';
  return null;
}

/**
 * Why `comment` is not a create-review inline comment in the private shape,
 * or null. Placement correctness is the preparing core's responsibility; this
 * only guarantees the request and its readback comparison are well defined.
 */
function commentProblem(comment: unknown): string | null {
  if (!isPlainObject(comment)) return 'comment must be an object';
  for (const key of Object.keys(comment)) {
    if (!COMMENT_KEYS.has(key)) return `comment has unsupported field ${key}`;
  }
  if (!isNonEmptyString(comment['path'])) return 'comment.path must be a non-empty string';
  if (!SIDES.has(comment['side'])) return 'comment.side must be LEFT or RIGHT';
  if (!isPositiveInteger(comment['line'])) return 'comment.line must be a positive integer';
  if (typeof comment['body'] !== 'string') return 'comment.body must be a string';
  const hasStartSide = Object.hasOwn(comment, 'startSide');
  const hasStartLine = Object.hasOwn(comment, 'startLine');
  if (hasStartSide !== hasStartLine) return 'comment.startSide and comment.startLine go together';
  if (hasStartSide && !SIDES.has(comment['startSide'])) return 'comment.startSide must be LEFT or RIGHT';
  if (hasStartLine && !isPositiveInteger(comment['startLine'])) return 'comment.startLine must be a positive integer';
  return null;
}

/**
 * Whether a validated comment carries the start fields. commentProblem
 * guarantees an own startSide comes with a valid startLine.
 */
function hasStartFields(comment: ReviewRequestComment): comment is IMultiLineRequestComment {
  return Object.hasOwn(comment, 'startSide');
}

// ---------------------------------------------------------------------------
// Input validation (TypeError before any I/O)
// ---------------------------------------------------------------------------

function requireInput(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid publication input: ${message}`);
}

/**
 * Validates the identity fields shared by publish and recover. Fields other
 * than the identity stay unvalidated (publish checks its preparedReview next).
 */
function validateIdentity(input: unknown): asserts input is IPublicationIdentity & UnknownObject {
  requireInput(isPlainObject(input), 'input must be an object');
  const problem = destinationProblem(input['destination']);
  if (problem !== null) requireInput(false, problem);
  requireInput(
    typeof input['reviewedCommit'] === 'string' && COMMIT_PATTERN.test(input['reviewedCommit']),
    'reviewedCommit must be a full lowercase 40-hex commit',
  );
  requireInput(
    typeof input['inputFingerprint'] === 'string' && FINGERPRINT_PATTERN.test(input['inputFingerprint']),
    "inputFingerprint must be 'sha256:' followed by 64 lowercase hex digits",
  );
  requireInput(
    isNonEmptyString(input['statePath']) && path.isAbsolute(input['statePath']),
    'statePath must be an absolute path chosen by the caller',
  );
  const t = input['transport'];
  requireInput(
    isPlainObject(t) &&
      ['getAuthenticatedUser', 'createReview', 'listReviews', 'listReviewComments'].every(
        (m) => typeof t[m] === 'function',
      ),
    'transport must provide getAuthenticatedUser, createReview, listReviews and listReviewComments',
  );
  const submit = input['submit'];
  requireInput(submit === undefined || typeof submit === 'boolean', 'submit must be a boolean when present');
}

/** The mode a validated identity asks for: submitted only when `submit` is exactly true. */
function requestedMode(identity: IPublicationIdentity): PublicationMode {
  return identity.submit === true ? 'submitted' : 'draft';
}

/** The mode a saved request records: submitted exactly when it carries an event. */
function recordedMode(request: ICreateReviewRequest): PublicationMode {
  return 'event' in request ? 'submitted' : 'draft';
}

/**
 * Refuses a prepared review publication could not send (TypeError). Also run
 * by readiness assessment, so the shape publication checks before claiming an
 * identity is checked there too.
 */
function validatePreparedReview(prepared: unknown): asserts prepared is IPreparedReview {
  requireInput(isPlainObject(prepared), 'preparedReview must be an object');
  requireInput(typeof prepared['body'] === 'string', 'preparedReview.body must be a string');
  requireInput(isList(prepared['comments']), 'preparedReview.comments must be an array');
  prepared['comments'].forEach((comment, i) => {
    const problem = commentProblem(comment);
    if (problem !== null) requireInput(false, `preparedReview.comments[${String(i)}]: ${problem}`);
  });
}

// ---------------------------------------------------------------------------
// Canonical fingerprint and marker
// ---------------------------------------------------------------------------

/**
 * JSON with recursively sorted object keys and no insignificant whitespace.
 * A JSON object always has a canonical form; only undefined, functions and
 * symbols have none (JSON.stringify yields undefined for them).
 */
function canonicalJson(value: UnknownObject | ICreateReviewRequest): string;
function canonicalJson(value: unknown): string | undefined;
function canonicalJson(value: unknown): string | undefined {
  if (isList(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${String(canonicalJson(value[k]))}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprintOf(value: UnknownObject | ICreateReviewRequest): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function newMarker(): string {
  return `<!-- sarif-to-comment:review:${crypto.randomUUID()} -->`;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    count += 1;
  }
  return count;
}

/** A comment reduced to exactly its request fields (start fields only when present). */
function copyComment(comment: ReviewRequestComment): ReviewRequestComment {
  if (hasStartFields(comment)) {
    return {
      path: comment.path,
      side: comment.side,
      line: comment.line,
      startSide: comment.startSide,
      startLine: comment.startLine,
      body: comment.body,
    };
  }
  return { path: comment.path, side: comment.side, line: comment.line, body: comment.body };
}

/**
 * The single create-review request for a prepared review under `marker`: a
 * draft's has no `event` key at all (byte for byte what drafts always sent),
 * a submitted publication's adds `event: 'COMMENT'`.
 */
function buildRequest(
  destination: IPublicationDestination,
  reviewedCommit: string,
  preparedReview: IPreparedReview,
  marker: string,
  mode: PublicationMode,
): ICreateReviewRequest {
  const draft: IDraftReviewRequest = {
    owner: destination.owner,
    repo: destination.repo,
    pullNumber: destination.pullNumber,
    commitId: reviewedCommit,
    body: `${preparedReview.body}\n\n${marker}`,
    comments: preparedReview.comments.map(copyComment),
  };
  return mode === 'submitted' ? { ...draft, event: SUBMIT_EVENT } : draft;
}

// ---------------------------------------------------------------------------
// State record parsing (fail closed)
// ---------------------------------------------------------------------------

/** Whether a record's (property-key-coerced) phase names a known phase. */
function isRecordPhase(phase: string): phase is RecordPhase {
  return phase === 'sending' || phase === 'completed' || phase === 'rejected';
}

/**
 * Whether `phase` has the shape of a CoercedPhase: nested one-element arrays
 * around a phase name. Unwrapped iteratively, so nesting depth costs no stack.
 */
function isCoercedPhase(phase: unknown): phase is CoercedPhase {
  let inner: unknown = phase;
  if (!isList(inner)) return false;
  while (isList(inner)) {
    if (inner.length !== 1) return false;
    inner = inner[0];
  }
  return typeof inner === 'string' && isRecordPhase(inner);
}

/** Why a parsed value is not a consistent v1 state record, or null. */
function recordProblem(record: unknown): string | null {
  if (!isPlainObject(record)) return 'record is not a JSON object';
  if (record['format'] !== STATE_FORMAT) return 'unknown record format';
  if (record['version'] !== STATE_VERSION) return 'unsupported record version';
  const keysByPhase: Readonly<Record<RecordPhase, readonly string[]>> = {
    sending: SENDING_KEYS,
    completed: COMPLETED_KEYS,
    rejected: REJECTED_KEYS,
  };
  // The phase is looked up as a property key, which coerces a parsed JSON
  // value to its string form (0.2.0 behavior, kept for existing state files).
  const phase = record['phase'];
  const phaseKey = String(phase);
  if (!isRecordPhase(phaseKey)) return 'unknown record phase';
  // Among JSON values only a CoercedPhase coerces to a phase name, so this
  // refuses nothing JSON.parse can produce; it establishes the parsed phase
  // type from the value itself rather than from its coercion.
  if (typeof phase !== 'string' && !isCoercedPhase(phase)) return 'unknown record phase';
  if (!hasExactKeys(record, keysByPhase[phaseKey])) return 'record fields do not match its phase';
  const marker = record['marker'];
  if (typeof marker !== 'string' || !MARKER_PATTERN.test(marker)) return 'malformed marker';
  const destination = record['destination'];
  const destProblem = destinationProblem(destination);
  if (destProblem) return destProblem;
  if (!isPlainObject(destination) || !hasExactKeys(destination, ['owner', 'pullNumber', 'repo'])) {
    return 'destination has extra fields';
  }
  const reviewedCommit = record['reviewedCommit'];
  if (typeof reviewedCommit !== 'string' || !COMMIT_PATTERN.test(reviewedCommit)) {
    return 'malformed reviewedCommit';
  }
  const inputFingerprint = record['inputFingerprint'];
  if (typeof inputFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(inputFingerprint)) {
    return 'malformed inputFingerprint';
  }
  if (!isPositiveInteger(record['authorId'])) return 'malformed authorId';

  const request = record['request'];
  if (!isPlainObject(request)) return 'malformed saved request';
  if (Object.hasOwn(request, 'event')) {
    if (!hasExactKeys(request, SUBMITTED_REQUEST_KEYS)) return 'malformed saved request';
    if (request['event'] !== SUBMIT_EVENT) return 'saved request event is not COMMENT';
  } else if (!hasExactKeys(request, REQUEST_KEYS)) {
    return 'malformed saved request';
  }
  if (
    request['owner'] !== destination['owner'] ||
    request['repo'] !== destination['repo'] ||
    request['pullNumber'] !== destination['pullNumber']
  ) {
    return 'saved request destination is inconsistent';
  }
  if (request['commitId'] !== reviewedCommit) return 'saved request commit is inconsistent';
  const body = request['body'];
  if (typeof body !== 'string') return 'saved request body is not a string';
  if (!body.endsWith(`\n\n${marker}`) || countOccurrences(body, marker) !== 1) {
    return 'saved request body does not end with exactly one marker';
  }
  const comments = request['comments'];
  if (!isList(comments)) return 'saved request comments are not a list';
  for (const comment of comments) {
    const problem = commentProblem(comment);
    if (problem) return `saved request ${problem}`;
  }
  const requestFingerprint = record['requestFingerprint'];
  if (typeof requestFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(requestFingerprint)) {
    return 'malformed requestFingerprint';
  }
  if (requestFingerprint !== fingerprintOf(request)) return 'saved request does not match its fingerprint';

  // Receipt and rejection contents are checked for a string phase only, and
  // only a string phase is ever answered from them (see ICoercedPhaseRecord).
  if (phase === 'completed') {
    const receipt = record['receipt'];
    if (!isPlainObject(receipt) || !hasExactKeys(receipt, RECEIPT_KEYS)) return 'malformed receipt';
    if (!isPositiveInteger(receipt['reviewId'])) return 'malformed receipt reviewId';
    if (!isNonEmptyString(receipt['htmlUrl'])) return 'malformed receipt htmlUrl';
    if (receipt['via'] !== 'created' && receipt['via'] !== 'recovered') return 'malformed receipt via';
  }
  if (phase === 'rejected') {
    const rejection = record['rejection'];
    if (!isPlainObject(rejection) || !hasExactKeys(rejection, REJECTION_KEYS)) return 'malformed rejection';
    if (!isRefusalStatus(rejection['status'])) return 'rejection status is not a definitive refusal';
    const message = rejection['message'];
    if (typeof message !== 'string' || message.length > MAX_REJECTION_MESSAGE) {
      return 'malformed rejection message';
    }
  }
  return null;
}

/** Whether a parsed value is a consistent v1 state record (see recordProblem). */
function isStateRecord(record: unknown): record is ParsedStateRecord {
  return recordProblem(record) === null;
}

/**
 * The record at `statePath`, or null only when no file exists there. Every
 * other condition — empty, truncated, unparsable, inconsistent — is corrupt
 * and must never be mistaken for absence.
 */
function readState(fs: IPublicationFs, statePath: string): ParsedStateRecord | null {
  let text: string;
  try {
    text = fs.readFileSync(statePath, 'utf8');
  } catch (err) {
    if (thrownCode(err) === 'ENOENT') return null;
    throw new PublicationStateError('state-io', `Cannot read publication state at ${statePath}.`, { cause: err });
  }
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch (err) {
    throw new PublicationStateError(
      'state-corrupt',
      `Publication state at ${statePath} is not complete JSON; it is not treated as absent.`,
      { cause: err },
    );
  }
  if (!isStateRecord(record)) {
    throw new PublicationStateError(
      'state-corrupt',
      `Publication state at ${statePath} is not a valid record (${String(recordProblem(record))}); it is not treated as absent.`,
    );
  }
  return record;
}

// ---------------------------------------------------------------------------
// Durable state writes
// ---------------------------------------------------------------------------

/** Makes directory-entry changes (link, rename) in `dir` durable. */
function flushDirectory(fs: IPublicationFs, dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Best-effort removal of this module's own temp file. */
function removeQuietly(fs: IPublicationFs, file: string): void {
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
function writeFlushedSibling(fs: IPublicationFs, statePath: string, text: string): string {
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
function serialize(record: StateRecord): string {
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
function claimIntent(fs: IPublicationFs, statePath: string, record: ISendingRecord): boolean {
  let tmp: string;
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
    if (thrownCode(err) === 'EEXIST') return false;
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
 * Exclusively creates `filePath` holding `text`, with the discipline of
 * claimIntent: a flushed owner-only sibling, hard-linked into place, then the
 * directory flushed. Returns false when the file already existed. Used for
 * the companion publication's plan and step records
 * (src/companion-publication.cts). `what` names the record in errors.
 */
function claimNewFile(fs: IPublicationFs, filePath: string, text: string, what: string): boolean {
  let tmp: string;
  try {
    tmp = writeFlushedSibling(fs, filePath, text);
  } catch (err) {
    throw new PublicationStateError('state-io', `Cannot write ${what} beside ${filePath}.`, { cause: err });
  }
  try {
    fs.linkSync(tmp, filePath);
  } catch (err) {
    removeQuietly(fs, tmp);
    if (thrownCode(err) === 'EEXIST') return false;
    throw new PublicationStateError('state-io', `Cannot publish ${what} at ${filePath}.`, { cause: err });
  }
  removeQuietly(fs, tmp);
  try {
    flushDirectory(fs, path.dirname(filePath));
  } catch (err) {
    throw new PublicationStateError('state-io', `${what} at ${filePath} could not be made durable; nothing was sent for it.`, { cause: err });
  }
  return true;
}

/**
 * Atomically and durably replaces `filePath` with `text` (flushed sibling,
 * rename, directory flush), as replaceRecord does; a failure leaves the
 * previous file intact and is a state-io PublicationStateError.
 */
function replaceFileDurably(fs: IPublicationFs, filePath: string, text: string, what: string): void {
  try {
    const tmp = writeFlushedSibling(fs, filePath, text);
    try {
      fs.renameSync(tmp, filePath);
    } catch (err) {
      removeQuietly(fs, tmp);
      throw err;
    }
    flushDirectory(fs, path.dirname(filePath));
  } catch (err) {
    throw new PublicationStateError('state-io', `Cannot record ${what} at ${filePath}.`, { cause: err });
  }
}

/**
 * Atomically and durably replaces the record with a terminal form (completed
 * receipt or persisted rejection): flushed sibling, rename, directory flush.
 * A failure leaves the previous record intact.
 */
function replaceRecord(fs: IPublicationFs, statePath: string, nextRecord: ICompletedRecord | IRejectedRecord): void {
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
  constructor(message: string, options?: ErrorOptions) {
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
async function readAllPages(
  fetchPage: (cursor: string | null) => Promise<unknown>,
  itemsKey: 'reviews' | 'comments',
): Promise<unknown[]> {
  const items: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let pages = 1; ; pages += 1) {
    if (pages > MAX_PAGES) throw new LookupFailure(`pagination exceeded ${String(MAX_PAGES)} pages`);
    let page: unknown;
    try {
      page = await fetchPage(cursor);
    } catch (err) {
      throw new LookupFailure('a page could not be read', { cause: err });
    }
    if (!isPlainObject(page) || !isList(page[itemsKey])) {
      throw new LookupFailure('the host returned a malformed page');
    }
    items.push(...page[itemsKey]);
    const next = page['nextCursor'];
    if (next === null) return items;
    if (!isNonEmptyString(next)) throw new LookupFailure('the host returned a malformed cursor');
    if (seen.has(next)) throw new LookupFailure('the host repeated a pagination cursor');
    seen.add(next);
    cursor = next;
  }
}

/** Canonical comparison key for a comment's anchor and text. */
function commentKey(comment: unknown): string {
  if (!isPlainObject(comment)) return 'invalid';
  return canonicalJson({
    path: comment['path'] ?? null,
    side: comment['side'] ?? null,
    line: comment['line'] ?? null,
    startSide: comment['startSide'] ?? null,
    startLine: comment['startLine'] ?? null,
    body: comment['body'] ?? null,
  });
}

/** Whether two comment lists are equal as multisets (cardinality matters). */
function sameCommentMultiset(expected: readonly unknown[], actual: readonly unknown[]): boolean {
  if (expected.length !== actual.length) return false;
  const counts = new Map<string, number>();
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
function reviewRef(summary: IHostReviewSummary): ICandidateRef {
  return { id: summary.id, htmlUrl: summary.htmlUrl };
}

/** Whether a listed review has the fields investigate relies on. */
function isHostReviewSummary(review: unknown): review is IHostReviewSummary {
  return isPlainObject(review) && isPositiveInteger(review['id']) && typeof review['body'] === 'string';
}

/**
 * Establishes, read-only, whether the host holds exactly this publication's
 * complete initial contribution. Returns { complete: true, review } or
 * { complete: false, reason, detail, cause?, candidates? }.
 */
async function investigate(transport: IPublicationTransport, record: IStateRecordBase): Promise<Verdict> {
  const { owner, repo, pullNumber } = record.destination;
  let reviews: unknown[];
  try {
    reviews = await readAllPages(
      (cursor) => transport.listReviews({ owner, repo, pullNumber, cursor }),
      'reviews',
    );
  } catch (err) {
    return lookupFailed(err);
  }
  const byId = new Map<number, IHostReviewSummary>();
  for (const review of reviews) {
    if (!isHostReviewSummary(review)) {
      return lookupFailed(new LookupFailure('the host returned a malformed review summary'));
    }
    if (review.body.includes(record.marker) && !byId.has(review.id)) byId.set(review.id, review);
  }
  const candidates = [...byId.values()];
  const [candidate] = candidates;
  if (candidate === undefined) {
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
  if (candidate.authorId !== record.authorId || candidate.commitId !== record.reviewedCommit) {
    return {
      complete: false,
      reason: 'candidate-mismatch',
      detail: 'The review carrying this marker has a different author or reviewed commit than this publication.',
      candidates: [reviewRef(candidate)],
    };
  }
  if (recordedMode(record.request) === 'submitted' && candidate.state !== SUBMITTED_STATE) {
    return {
      complete: false,
      reason: 'candidate-mismatch',
      detail: `The review carrying this marker is not a submitted comment review (its state is ${String(candidate.state)}). It is neither submitted nor repaired; inspect it on the host.`,
      candidates: [reviewRef(candidate)],
    };
  }
  if (candidate.body !== record.request.body) {
    return differs(candidate, 'body');
  }
  let comments: unknown[];
  try {
    comments = await readAllPages(
      (cursor) => transport.listReviewComments({ owner, repo, pullNumber, reviewId: candidate.id, cursor }),
      'comments',
    );
  } catch (err) {
    return lookupFailed(err);
  }
  if (!sameCommentMultiset(record.request.comments, comments)) return differs(candidate, 'inline comments');
  const htmlUrl = candidate.htmlUrl;
  if (!isNonEmptyString(htmlUrl)) {
    return lookupFailed(new LookupFailure('the matching review has no URL'));
  }
  // Same fields as reviewRef, with the URL now verified.
  return { complete: true, review: { id: candidate.id, htmlUrl } };
}

/** Verdict for an enumeration or readback that did not complete. */
function lookupFailed(err: unknown): Verdict {
  return {
    complete: false,
    reason: 'lookup-failed',
    detail: `Could not completely enumerate the destination's reviews or the matching review's comments (${String(thrownMessage(err))}). Nothing is concluded from a partial lookup.`,
    cause: err,
  };
}

/** Verdict for the sole marker candidate whose content is not the initial contribution. */
function differs(candidate: IHostReviewSummary, what: string): Verdict {
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
function publishedOutcome(
  record: IStateRecordBase,
  statePath: string,
  review: IReviewRef,
  via: IPublishedOutcome['via'],
  receiptPersisted: boolean,
  cause?: unknown,
): IPublishedOutcome {
  const outcome: Writable<IPublishedOutcome> = {
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
function uncertainOutcome(
  record: IStateRecordBase,
  statePath: string,
  verdict: IUncertainFinding,
  sendCause?: unknown,
): IUncertainOutcome {
  const outcome: Writable<IUncertainOutcome> = {
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
function receiptOutcome(record: ICompletedRecord, statePath: string): IPublishedOutcome {
  const { reviewId, htmlUrl } = record.receipt;
  return publishedOutcome(record, statePath, { id: reviewId, htmlUrl }, 'receipt', true);
}

/** Explanation of a definitive refusal, quoting the host's (bounded) message. */
function rejectionDetail(status: number, message: string): string {
  return `GitHub refused the create-review request (HTTP ${String(status)}): ${message} It is never resent; this state path now records the refusal. Resolve the cause, then publish under a new state path.`;
}

/** The outcome of a persisted refusal, reported without contacting the host. */
function knownRejectionOutcome(record: IRejectedRecord, statePath: string): IRejectedOutcome {
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

/** Whether a thrown create error is the host's definitive refusal (see IHostRejection). */
function isHostRejection(err: unknown): err is IHostRejection {
  return (
    (typeof err === 'object' || typeof err === 'function') &&
    err !== null &&
    'hostRejected' in err &&
    err.hostRejected === true &&
    'status' in err &&
    isRefusalStatus(err.status)
  );
}

/**
 * Records a definitive host refusal of the single create. Only the status and
 * a bounded message are kept: transport errors may carry request details that
 * must never reach state. If the terminal record cannot be saved, the sending
 * intent remains and later calls investigate conservatively; nothing is resent.
 */
function settleRejection(
  fs: IPublicationFs,
  statePath: string,
  record: ISendingRecord,
  err: IHostRejection,
): IRejectedOutcome {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the host's refusal message is untrusted text of any type; String() is the deliberate, total coercion before bounding it (an Error's message is already a string)
  const message = String(err.message ?? '').slice(0, MAX_REJECTION_MESSAGE);
  const rejected: IRejectedRecord = { ...record, phase: 'rejected', rejection: { status: err.status, message } };
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
      : `GitHub refused the create-review request (HTTP ${String(err.status)}): ${message} The refusal could not be saved at ${statePath}; later calls on this state path will report uncertain delivery, and nothing is ever resent.`,
    rejectionPersisted,
    cause: err,
  };
}

/** What a create attempt contributes to settling: the response's review id or an indeterminate error. */
interface ISettleContext {
  readonly responseId?: number | undefined;
  readonly sendCause?: unknown;
}

/**
 * Investigates once and, only for verified complete delivery, persists the
 * completed receipt. `responseId` is the id a create response named, if any;
 * `sendCause` is an indeterminate create error, if any.
 */
async function settle(
  fs: IPublicationFs,
  statePath: string,
  record: InvestigatedRecord,
  transport: IPublicationTransport,
  { responseId, sendCause }: ISettleContext = {},
): Promise<IPublishedOutcome | IUncertainOutcome> {
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
  // Every other field is copied, as 0.2.0 did: a coerced-phase record's
  // unvalidated `rejection` therefore survives beside the new receipt, and
  // that record fails the exact-field check when it is next read.
  const completed: ICompletedRecord = {
    ...record,
    phase: 'completed',
    receipt: { reviewId: verdict.review.id, htmlUrl: verdict.review.htmlUrl, via },
  };
  try {
    replaceRecord(fs, statePath, completed);
  } catch (err) {
    const cause = new PublicationStateError(
      'state-io',
      `The review was verified on the host, but its completed receipt could not be saved at ${statePath} (${String(thrownMessage(err))}). The saved intent remains; a later call will recover it without sending.`,
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
/**
 * The authenticated account's numeric id, which the state record binds and
 * delivery evidence compares. Also run by readiness assessment, so an account
 * publication would refuse (no numeric id: not user/PAT authentication) is
 * never assessed as ready.
 */
async function authenticatedUserId(transport: Pick<IPublicationTransport, 'getAuthenticatedUser'>): Promise<number> {
  const user = await transport.getAuthenticatedUser();
  if (!isPlainObject(user) || !isPositiveInteger(user['id'])) {
    throw new TypeError('The transport did not report a numeric authenticated user id.');
  }
  return user['id'];
}

/** Refusal to reuse an existing identity for different input. */
function mismatch(statePath: string, what: string): PublicationStateError {
  return new PublicationStateError(
    'state-mismatch',
    `Publication state at ${statePath} belongs to a different ${what}. An existing publication identity cannot take changed input; use a new state path for a separate review.`,
  );
}

/**
 * Refusal to continue a publication in the other mode. A publication's mode is
 * fixed when its intent is claimed; neither direction is ever converted.
 */
function modeMismatch(statePath: string, recorded: PublicationMode, requested: PublicationMode): PublicationStateError {
  return new PublicationStateError(
    'state-mismatch',
    `Publication state at ${statePath} records a ${recorded} review, but a ${requested} review was requested. A publication's mode is fixed when it starts: retry with the mode it started with, or use a new state path for a separate review.`,
  );
}

/** Throws state-mismatch unless the record belongs to this destination, commit, mode and original input. */
function assertSameIdentity(record: IStateRecordBase, input: IPublicationIdentity): void {
  const d = input.destination;
  if (
    record.destination.owner !== d.owner ||
    record.destination.repo !== d.repo ||
    record.destination.pullNumber !== d.pullNumber
  ) {
    throw mismatch(input.statePath, 'destination');
  }
  if (record.reviewedCommit !== input.reviewedCommit) throw mismatch(input.statePath, 'reviewed commit');
  const recorded = recordedMode(record.request);
  const requested = requestedMode(input);
  if (recorded !== requested) throw modeMismatch(input.statePath, recorded, requested);
  if (record.inputFingerprint !== input.inputFingerprint) throw mismatch(input.statePath, 'original input');
}

/**
 * Continues an existing publication identity without ever sending: a
 * completed receipt or a persisted refusal returns immediately with no
 * transport call; a sending intent is investigated using its saved request.
 * The branches compare the phase strictly, so a record with a coerced
 * (array) phase is investigated like an intent whatever phase it names.
 */
async function continueExisting(
  fs: IPublicationFs,
  record: ParsedStateRecord,
  input: IPublicationIdentity,
): Promise<PublicationOutcome> {
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
 * `input` is validated here (TypeError before any I/O), so it is `unknown`.
 */
async function publishPreparedReview(
  input: unknown,
  internals: IPublicationInternals = {},
): Promise<PublicationOutcome> {
  validateIdentity(input);
  validatePreparedReview(input['preparedReview']);
  const fs: IPublicationFs = internals.fs || nodeFs;
  const { statePath, transport } = input;

  const existing = readState(fs, statePath);
  if (existing) return continueExisting(fs, existing, input);

  const authorId = await authenticatedUserId(transport);
  const marker = newMarker();
  const request = buildRequest(input.destination, input.reviewedCommit, input['preparedReview'], marker, requestedMode(input));
  const record: ISendingRecord = {
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

  let response: unknown;
  try {
    response = await transport.createReview(structuredClone(request));
  } catch (err) {
    if (isHostRejection(err)) {
      return settleRejection(fs, statePath, record, err);
    }
    return settle(fs, statePath, record, transport, { sendCause: err });
  }
  const responseId = isPlainObject(response) && isPositiveInteger(response['id']) ? response['id'] : undefined;
  return settle(fs, statePath, record, transport, { responseId });
}

/**
 * Reports an existing publication identity without ever creating: 'missing'
 * when no record exists, otherwise the receipt, a verified recovery, or an
 * uncertain outcome. Safe to call before any branch-dependent preparation.
 * `input` is validated here (TypeError before any I/O), so it is `unknown`.
 */
async function recoverPublication(
  input: unknown,
  internals: IPublicationInternals = {},
): Promise<PublicationOutcome | IMissingOutcome> {
  validateIdentity(input);
  const fs: IPublicationFs = internals.fs || nodeFs;
  const existing = readState(fs, input.statePath);
  if (!existing) return { status: 'missing', statePath: input.statePath };
  return continueExisting(fs, existing, input);
}

export { publishPreparedReview, recoverPublication, PublicationStateError };
// Shared with the companion publication (src/companion-publication.cts), which
// keeps its plan and step records with the same durability, identity and
// refusal rules; not part of the package's public API.
export {
  claimNewFile,
  fingerprintOf,
  isHostRejection,
  isRefusalStatus,
  mismatch,
  modeMismatch,
  replaceFileDurably,
  thrownMessage,
  MAX_REJECTION_MESSAGE,
  STATE_FORMAT,
};
export type { IPublicationFs, IPublicationInternals, PublicationMode };
// The pre-send checks that readiness assessment runs unchanged
// (src/validate-sarif-review.cts); not part of the package's public API.
export { authenticatedUserId, validatePreparedReview };
// For compile-time checks of state parsing (test/publication-state.types.mts);
// not part of the package's public API.
export type { ParsedStateRecord };
