/**
 * publishSarifReview: publishes a ready SARIF document as one GitHub draft
 * review (the fifth public operation; the package entry re-exports it).
 *
 * Publication composes private cores: the GitHub client (src/github.cjs),
 * whole-review preparation (src/prepare-review.cjs) and durable initial
 * publication (src/publication.cjs). It adds no rendering, placement or
 * delivery logic of its own; it only validates, captures, sequences and
 * explains.
 *
 * ---------------------------------------------------------------------------
 * publishSarifReview(input, internals?) -> Promise<Outcome>
 *
 * input (unknown keys are refused):
 *   sarif:            plain JSON value (object) — the SARIF 2.1.0 log
 *   destination:      { owner: string, repo: string, pullNumber: number }
 *   reviewedCommit:   string  // full lowercase 40-hex commit the review is
 *                             // about; the review stays pinned to it even
 *                             // when the pull request has since advanced
 *   statePath:        string  // absolute file path; the durable identity of
 *                             // this publication. Retry with the same path;
 *                             // a new path means a deliberately separate review
 *   token:            string  // GitHub user/PAT credential; used only by the
 *                             // GitHub client; never persisted, fingerprinted,
 *                             // rendered or exposed in a rejection
 *   sourceRootUri?:   string  // absolute file: URI ending in "/", the
 *                             // repository root in the producer's filesystem
 *   oldSourceCommit?: string  // full 40-hex commit: a candidate for the diff's
 *                             // old side, used only when GitHub's own compare
 *                             // cannot establish it; still verified file by
 *                             // file against the pull request's patches
 *   options?: { ignoreApprovalHold?: boolean }  // bypasses only an approval hold
 *
 * Outcome — the consumer contract is `status` plus human-readable `markdown`
 * (and the listed identifiers). Internal reason codes, evidence and diagnostics
 * are deliberately not part of it (D13).
 *   { status: 'published', review: { id, url }, statePath, markdown }
 *   { status: 'blocked', markdown }        // nothing was written anywhere
 *   { status: 'uncertain', statePath, markdown }
 *       // delivery could not be confirmed; markdown names the preserved
 *       // state path, says to retry with the same path and not to delete it,
 *       // and that a new path would create a separate review
 *   { status: 'rejected', statePath, markdown }
 *       // GitHub definitively refused the single create; never resent
 * Rejects (promise) for invalid input (TypeError, before any remote read),
 * local state problems (corrupt state, reuse of a state path for different
 * input), and operational failures (GitHub context, network). A rejection
 * never exposes the token: an error that mentions it anywhere (message,
 * causes, extra properties) is replaced by a redacted error without cause.
 *
 * Sequence:
 *   1. Validate input and synchronously capture a deep JSON copy of `sarif`
 *      from own data properties only — caller getters never run — refusing
 *      cycles and non-JSON values rather than dropping or coercing them, so
 *      later caller mutation cannot change what is fingerprinted or rendered.
 *   2. inputFingerprint = 'sha256:' + hex SHA-256 of canonical JSON (object
 *      keys sorted recursively, no insignificant whitespace, UTF-8) of
 *        { format: 'sarif-to-comment.input', version: 1, sarif: <copy>,
 *          sourceRootUri: <string or null>, oldSourceCommit: <string or null> }
 *      Excludes the token, statePath, destination and reviewedCommit (the
 *      latter two are checked separately by publication state) and the
 *      approval-hold override (it authorizes, but does not change, content).
 *   3. recoverPublication with only that identity — before any branch or
 *      source work. A completed receipt or a known refusal returns without
 *      network; an existing sending intent is investigated with its saved
 *      request and is never re-prepared or re-sent.
 *   4. Only when no state exists: fetch the review context, verify it is for
 *      exactly this pull request and reviewed commit, prepare the whole
 *      review, and return `blocked` (no remote write, no state file) or call
 *      publishPreparedReview exactly once.
 *
 * internals (private seam, not caller API):
 *   createGitHubClient({ token, fetch }) -> client with the publication
 *     transport methods and fetchContext({ destination, reviewedCommit,
 *     oldSourceCommit? }) -> { context, readSource }. Defaults to
 *     src/github.cjs.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as util from 'node:util';

import { createGitHubClient as defaultCreateGitHubClient } from './github.cjs';
import type { ICreateGitHubClientOptions, IFetchContextRequest } from './github.cjs';
import { prepareReview } from './prepare-review.cjs';
import type { IReadyOutcome } from './prepare-review.cjs';
import { publishPreparedReview, recoverPublication } from './publication.cjs';
import type { IJsonObject, IPlainObject, JsonValue } from './sarif-common.cjs';

// ---------------------------------------------------------------------------
// Public types
//
// These are the shapes the package documents for publication. Their names
// and documentation are the public ones, so declarations generated from this
// module read exactly as the published API.

/**
 * The pull request that receives the review.
 *
 * @public
 */
export interface IPullRequestDestination {
  /** Account or organization that owns the repository, for example `acme`. */
  readonly owner: string;
  /** Repository name, for example `widgets`. */
  readonly repo: string;
  /** Pull request number (a positive integer). */
  readonly pullNumber: number;
}

/**
 * Options that change how a ready document is judged. Unknown options are
 * refused.
 *
 * @public
 */
export interface IPublishSarifReviewOptions {
  /**
   * Publish despite an approval hold declared in the SARIF
   * (`properties.sarifToComment.approval: "awaiting-approval"`). Bypasses only
   * the hold, never validation, and is not part of the publication identity.
   */
  readonly ignoreApprovalHold?: boolean | undefined;
}

/**
 * Input to {@link publishSarifReview}. Unknown fields are refused.
 *
 * @public
 */
export interface IPublishSarifReviewInput {
  /**
   * The SARIF 2.1.0 log as a parsed JSON object (not text). It is copied
   * when the call starts; later changes to your object have no effect. Values
   * JSON cannot represent (cycles, functions, `undefined`, `NaN`, class
   * instances, accessors) are refused rather than dropped.
   */
  readonly sarif: object;
  /** The pull request that receives the review. */
  readonly destination: IPullRequestDestination;
  /**
   * Full 40-character lowercase commit SHA the review is about. The review
   * stays pinned to it even if the pull request has since advanced; findings
   * that cannot be anchored there become exact links in the review body.
   */
  readonly reviewedCommit: string;
  /**
   * Absolute path of the durable publication state file: the identity of
   * this publication. Retry with the same path; never delete it after an
   * `uncertain` outcome. A new path starts a new, separate review.
   */
  readonly statePath: string;
  /**
   * GitHub personal access token (or user token) used to read the pull
   * request and create the draft review. GitHub App installation tokens,
   * including the automatic Actions `GITHUB_TOKEN`, are not supported. Never
   * persisted, fingerprinted, rendered or included in a rejection.
   */
  readonly token: string;
  /**
   * Absolute `file:` URI (ending in `/`) of the repository root in the SARIF
   * producer's file system, so absolute artifact URIs resolve to repository
   * paths.
   */
  readonly sourceRootUri?: string | undefined;
  /**
   * Full commit SHA to use as the diff's old side when GitHub's own
   * comparison cannot establish it. Only a candidate: every old-side file is
   * verified against the pull request's patches.
   */
  readonly oldSourceCommit?: string | undefined;
  /** Options; see {@link IPublishSarifReviewOptions}. */
  readonly options?: IPublishSarifReviewOptions | undefined;
}

/**
 * The draft review on GitHub.
 *
 * @public
 */
export interface IPublishedReview {
  /** GitHub's numeric review id. */
  readonly id: number;
  /** Web URL of the review. */
  readonly url: string;
}

/**
 * The publication is complete: the draft review was created and confirmed
 * now, confirmed after an earlier uncertain attempt, or recorded as complete
 * in the state file by an earlier call.
 *
 * @remarks
 * A completed record is returned without contacting GitHub. Publication is
 * one-way: the review may since have been submitted, edited or deleted by a
 * person, and the tool does not check.
 *
 * @public
 */
export interface IPublishedOutcome {
  /** Discriminant: The publication is complete. */
  readonly status: 'published';
  /** The review as it was when the publication completed. */
  readonly review: IPublishedReview;
  /** The state file recording this publication. */
  readonly statePath: string;
  /** Human-readable explanation, including the review link. */
  readonly markdown: string;
}

/**
 * The document cannot be published faithfully. Nothing was written to GitHub
 * and no state file was created.
 *
 * @public
 */
export interface IBlockedOutcome {
  /** Discriminant: Nothing was published. */
  readonly status: 'blocked';
  /** Every problem, with a pointer into the SARIF document. */
  readonly markdown: string;
}

/**
 * Delivery could not be confirmed. Retry later with the same state path; it
 * only checks GitHub and never sends the review again. Do not delete the
 * state file.
 *
 * @public
 */
export interface IUncertainOutcome {
  /** Discriminant: Delivery could not be confirmed. */
  readonly status: 'uncertain';
  /** The preserved state file to retry with. */
  readonly statePath: string;
  /** What is known and what to do next. */
  readonly markdown: string;
}

/**
 * GitHub definitively refused the create-review request (for example because
 * the account already has a pending review on the pull request). It is never
 * resent; publish again with a new state path after resolving the cause.
 *
 * @public
 */
export interface IRejectedOutcome {
  /** Discriminant: GitHub refused the request. */
  readonly status: 'rejected';
  /** The state file that records the refusal. */
  readonly statePath: string;
  /** GitHub's reason and what to do next. */
  readonly markdown: string;
}

/**
 * Every outcome of {@link publishSarifReview}, discriminated by `status`.
 *
 * @public
 */
export type PublishSarifReviewOutcome = IPublishedOutcome | IBlockedOutcome | IUncertainOutcome | IRejectedOutcome;

// ---------------------------------------------------------------------------
// Private seam and internal types

/**
 * What the publication sequence needs from a GitHub client besides the
 * publication transport (which src/publication.cjs validates itself): the
 * review context and its source reader. Both answers are checked where they
 * are used (verifyContext here, the caller boundary of prepareReview), so
 * they are `unknown` until then.
 */
interface IPublishingClient {
  readonly fetchContext: (request: IFetchContextRequest) => Promise<{ readonly context: unknown; readonly readSource: unknown }>;
}

/** Creates the GitHub client for one publication; src/github.cjs by default. */
type CreatePublishingClient = (options: ICreateGitHubClientOptions) => IPublishingClient;

/**
 * The private test seam of {@link publishSarifReview}: tests (including the
 * installed-package tests and the shipped executable's test wrapper) inject a
 * fake GitHub client through it. It is not a supported contract, which is why
 * the public declaration of publishSarifReview has no second parameter.
 */
export interface IPublishSarifReviewInternals {
  readonly createGitHubClient?: CreatePublishingClient | undefined;
}

/** Everything the operation uses, captured and validated before the first await. */
interface ICapturedInput {
  readonly sarif: IJsonObject;
  readonly destination: IPullRequestDestination;
  readonly reviewedCommit: string;
  readonly oldSourceCommit: string | undefined;
  readonly statePath: string;
  readonly token: string;
  readonly sourceRootUri: string | undefined;
  readonly ignoreApprovalHold: boolean | undefined;
}

/** Every outcome of the publication core (publish, or a recover that found a record). */
type PublicationResult = Awaited<ReturnType<typeof publishPreparedReview>>;

/** The publication core's verified delivery. */
type PublishedResult = Extract<PublicationResult, { readonly status: 'published' }>;

/** The publication core's unverified delivery. */
type UncertainResult = Extract<PublicationResult, { readonly status: 'uncertain' }>;

/** The publication core's definitive host refusal. */
type RejectedResult = Extract<PublicationResult, { readonly status: 'rejected' }>;

/** Identity-document format of the original input, fixed by the fingerprint spec. */
const INPUT_FORMAT = 'sarif-to-comment.input';
const INPUT_VERSION = 1;

/** Every accepted top-level input field; anything else is a caller mistake. */
const INPUT_KEYS: ReadonlySet<string> = new Set([
  'sarif',
  'destination',
  'reviewedCommit',
  'statePath',
  'token',
  'sourceRootUri',
  'oldSourceCommit',
  'options',
]);

/** Every accepted option. Only the approval-hold override exists in this milestone. */
const OPTION_KEYS: ReadonlySet<string> = new Set(['ignoreApprovalHold']);

/** A full, immutable, lowercase Git commit id. */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** GitHub account names: alphanumerics and single interior hyphens. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** GitHub repository names: letters, digits, '.', '_' and '-' (never '.' or '..'). */
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Nesting bound for captured JSON, so hostile depth fails as input, not a stack overflow. */
const MAX_JSON_DEPTH = 512;

/** Replacement text for a credential found in anything shown to a person. */
const REDACTED = '[redacted]';

// ---------------------------------------------------------------------------
// Input validation and capture (synchronous, before any remote read)
// ---------------------------------------------------------------------------

function invalid(message: string): TypeError {
  return new TypeError(`Invalid publishSarifReview input: ${message}`);
}

function isPlainObject(value: unknown): value is IPlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A value interpolated into a message exactly as a template literal converts
 * it, including values of any type returned by an injected client.
 */
function templateText(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- reproduces template-literal string conversion of an arbitrary host-supplied value in an error message; String() would differ for symbols
  return `${value}`;
}

/** An own data property's value, refusing accessors (whose getters are never run). */
function dataValue(object: object, key: string, where: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw invalid(`${where} is an accessor property; only plain JSON data is accepted`);
  return descriptor.value;
}

/**
 * A deep copy of `value` restricted to what JSON represents faithfully:
 * plain objects with enumerable string-keyed data properties, dense arrays,
 * strings, finite numbers (not -0), booleans and null. Anything else — cycles,
 * accessors, symbols, undefined, functions, BigInt, class instances, holes —
 * is refused rather than dropped or coerced, so the fingerprint and the
 * rendered review can only ever describe the same document.
 */
function captureJson(value: unknown, where: string, ancestors: Set<object> = new Set(), depth = 0): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw invalid(`${where} is not a finite JSON number`);
    return value;
  }
  if (typeof value !== 'object') throw invalid(`${where} is a ${typeof value}, which JSON cannot represent`);
  if (depth > MAX_JSON_DEPTH) throw invalid(`${where} is nested more than ${String(MAX_JSON_DEPTH)} levels deep`);
  if (ancestors.has(value)) throw invalid(`${where} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw invalid(`${where} is not a plain array`);
      const keys = Reflect.ownKeys(value);
      const length = dataValue(value, 'length', `${where}.length`);
      // An array's own `length` is always a number; the typeof test only
      // lets the comparison below be typed.
      if (typeof length !== 'number' || keys.length !== length + 1) throw invalid(`${where} has holes or extra properties`);
      const copy = new Array<JsonValue>(length);
      for (let i = 0; i < length; i += 1) {
        if (!Object.hasOwn(value, i)) throw invalid(`${where}[${String(i)}] is a hole`);
        copy[i] = captureJson(dataValue(value, String(i), `${where}[${String(i)}]`), `${where}[${String(i)}]`, ancestors, depth + 1);
      }
      return copy;
    }
    return captureObject(value, where, ancestors, depth);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * The object step of {@link captureJson}: `value` is already on the
 * ancestor path at `depth`. Separate only so that a capture known to start
 * at a plain object (captureRoot) is typed as producing an object.
 */
function captureObject(value: object, where: string, ancestors: Set<object>, depth: number): IJsonObject {
  if (!isPlainObject(value)) throw invalid(`${where} is not a plain JSON object`);
  const copy: Record<string, JsonValue> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw invalid(`${where} has a symbol-keyed property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // A key reported by Reflect.ownKeys always has a descriptor.
    if (!descriptor?.enumerable) throw invalid(`${where}.${key} is not enumerable`);
    const item = captureJson(dataValue(value, key, `${where}.${key}`), `${where}.${key}`, ancestors, depth + 1);
    Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  return copy;
}

/**
 * {@link captureJson} of a top-level plain object: the same checks in the
 * same order (at depth 0 with no ancestors, only the object step can refuse
 * it), typed as the JSON object it produces.
 */
function captureRoot(value: IPlainObject, where: string): IJsonObject {
  return captureObject(value, where, new Set<object>([value]), 0);
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_PATTERN.test(value);
}

/** Whether `value` is an absolute file: URI naming a directory (ending in "/"). */
function isFileRootUri(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('file:') || !value.endsWith('/')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'file:' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

/** Whether a captured destination names a GitHub account as its owner. */
function hasOwner(destination: IJsonObject): destination is IJsonObject & { readonly owner: string } {
  const owner = destination['owner'];
  return typeof owner === 'string' && OWNER_PATTERN.test(owner);
}

/** Whether a captured destination names a GitHub repository (never '.' or '..'). */
function hasRepo(destination: IJsonObject): destination is IJsonObject & { readonly repo: string } {
  const repo = destination['repo'];
  return typeof repo === 'string' && REPO_PATTERN.test(repo) && !/^\.\.?$/.test(repo);
}

/** Whether a captured destination's pull request number is a positive safe integer. */
function hasPullNumber(destination: IJsonObject): destination is IJsonObject & { readonly pullNumber: number } {
  const pullNumber = destination['pullNumber'];
  return typeof pullNumber === 'number' && Number.isSafeInteger(pullNumber) && pullNumber >= 1;
}

/**
 * Validates `input` and returns an independent snapshot of everything the
 * operation will use. Runs synchronously, before the first await.
 */
function captureInput(input: unknown): ICapturedInput {
  if (!isPlainObject(input)) throw invalid('input must be a plain object');
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === 'symbol' || !INPUT_KEYS.has(key)) throw invalid(`unknown field ${String(key)}`);
  }
  const field = (key: string): unknown => dataValue(input, key, key);

  const sarifValue = field('sarif');
  if (!isPlainObject(sarifValue)) throw invalid('sarif must be a parsed SARIF object (not text or an array)');
  const sarif = captureRoot(sarifValue, 'sarif');

  const destinationValue = field('destination');
  if (!isPlainObject(destinationValue)) throw invalid('destination must be { owner, repo, pullNumber }');
  const destination = captureRoot(destinationValue, 'destination');
  const destinationKeys = Object.keys(destination).sort().join(',');
  if (destinationKeys !== 'owner,pullNumber,repo') throw invalid('destination must have exactly owner, repo and pullNumber');
  if (!hasOwner(destination)) {
    throw invalid('destination.owner must be a GitHub account name');
  }
  if (!hasRepo(destination)) {
    throw invalid('destination.repo must be a GitHub repository name');
  }
  if (!hasPullNumber(destination)) {
    throw invalid('destination.pullNumber must be a positive integer');
  }

  const reviewedCommit = field('reviewedCommit');
  if (!isCommit(reviewedCommit)) throw invalid('reviewedCommit must be a full 40-character lowercase commit SHA');

  const oldSourceCommit = field('oldSourceCommit');
  if (oldSourceCommit !== undefined && !isCommit(oldSourceCommit)) {
    throw invalid('oldSourceCommit must be a full 40-character lowercase commit SHA');
  }

  const statePath = field('statePath');
  if (typeof statePath !== 'string' || !path.isAbsolute(statePath)) {
    throw invalid('statePath must be an absolute file path chosen by the caller');
  }

  const token = field('token');
  if (typeof token !== 'string' || token.length === 0) throw invalid('token must be a non-empty string');

  const sourceRootUri = field('sourceRootUri');
  if (sourceRootUri !== undefined && !isFileRootUri(sourceRootUri)) {
    throw invalid('sourceRootUri must be an absolute file: URI ending in "/"');
  }

  const optionsValue = field('options');
  let ignoreApprovalHold: boolean | undefined;
  if (optionsValue !== undefined) {
    if (!isPlainObject(optionsValue)) throw invalid('options must be a plain object');
    const options = captureRoot(optionsValue, 'options');
    for (const key of Object.keys(options)) if (!OPTION_KEYS.has(key)) throw invalid(`unknown option ${key}`);
    const ignoreHold = options['ignoreApprovalHold'];
    if (ignoreHold !== undefined && typeof ignoreHold !== 'boolean') {
      throw invalid('options.ignoreApprovalHold must be a boolean');
    }
    ignoreApprovalHold = ignoreHold;
  }

  return { sarif, destination, reviewedCommit, oldSourceCommit, statePath, token, sourceRootUri, ignoreApprovalHold };
}

// ---------------------------------------------------------------------------
// Original-input identity
// ---------------------------------------------------------------------------

/** JSON with recursively sorted object keys and no insignificant whitespace. */
function canonicalJson(value: JsonValue): string {
  if (isJsonArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(jsonMember(value, key))}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Whether a JSON value is an array (Array.isArray, typed for read-only arrays). */
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/**
 * A member of a captured JSON object by one of its own keys. Captured
 * objects are dense, so the key is always present; the fallback only lets
 * the lookup be typed and never applies.
 */
function jsonMember(object: IJsonObject, key: string): JsonValue {
  return object[key] ?? null;
}

/** Fingerprint of everything that determines the prepared content (see module doc). */
function inputFingerprintOf(captured: ICapturedInput): string {
  const identity: IJsonObject = {
    format: INPUT_FORMAT,
    version: INPUT_VERSION,
    sarif: captured.sarif,
    sourceRootUri: captured.sourceRootUri ?? null,
    oldSourceCommit: captured.oldSourceCommit ?? null,
  };
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Credential safety
// ---------------------------------------------------------------------------

/** `text` with every occurrence of the credential replaced. */
function redact(text: string, token: string): string {
  return text.split(token).join(REDACTED);
}

/** The message of `err` followed by its cause chain, as plain text. */
function messageChain(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (!(current instanceof Error)) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a thrown non-Error of any type is described by String(), the deliberate total coercion
      parts.push(String(current));
      break;
    }
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(' (caused by: ') + ')'.repeat(parts.length - 1);
}

/**
 * `err` unchanged when nothing inspectable about it mentions the token;
 * otherwise a new error of the same name carrying only the redacted message
 * chain and no cause or extra properties.
 */
function withoutCredential(err: unknown, token: string): unknown {
  const inspected = util.inspect(err, { depth: null, showHidden: true });
  if (!inspected.includes(token)) return err;
  const safe = new Error(redact(messageChain(err), token));
  safe.name = err instanceof Error ? err.name : 'Error';
  return safe;
}

// ---------------------------------------------------------------------------
// Context verification
// ---------------------------------------------------------------------------

/**
 * Refuses a context that is not for exactly the requested pull request and
 * reviewed commit. The review is never retargeted to another pull request or
 * to the pull request's current head.
 */
function verifyContext(context: unknown, captured: ICapturedInput): asserts context is IPlainObject {
  const { owner, repo, pullNumber } = captured.destination;
  const wanted = `${owner}/${repo}#${String(pullNumber)}`;
  if (!isPlainObject(context)) throw new Error(`GitHub returned no usable review context for ${wanted}.`);
  const sameName = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  if (!sameName(context['owner'], owner) || !sameName(context['repo'], repo) || context['pullNumber'] !== pullNumber) {
    throw new Error(
      `GitHub returned review context for pull request ${templateText(context['owner'])}/${templateText(context['repo'])}#${templateText(context['pullNumber'])}, not the requested pull request ${wanted}.`,
    );
  }
  if (context['reviewedCommit'] !== captured.reviewedCommit) {
    throw new Error(
      `GitHub returned review context for reviewed commit ${templateText(context['reviewedCommit'])}, not the requested reviewed commit ${captured.reviewedCommit}. A review is never retargeted to another commit.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Markdown presentation
// ---------------------------------------------------------------------------

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

function destinationLabel(captured: ICapturedInput): string {
  const { owner, repo, pullNumber } = captured.destination;
  return `${owner}/${repo}#${String(pullNumber)}`;
}

function publishedMarkdown(result: PublishedResult, captured: ICapturedInput, prepared: IReadyOutcome | undefined): string {
  const link = `[review ${String(result.review.id)}](${result.review.htmlUrl})`;
  const where = `${destinationLabel(captured)} at commit ${code(captured.reviewedCommit)}`;
  const lines = ['## Draft review published', ''];
  if (result.via === 'receipt') {
    lines.push(`The draft ${link} on ${where} was already published; its completion is recorded at ${code(captured.statePath)}. Nothing was sent.`);
  } else if (result.via === 'recovered') {
    lines.push(`The draft ${link} on ${where} was confirmed on GitHub for this publication; nothing was resent.`);
  } else {
    lines.push(`Created the draft ${link} on ${where}. It stays a draft until someone submits it on GitHub.`);
  }
  if (!result.receiptPersisted) {
    lines.push(
      '',
      `Completion could not be recorded at ${code(captured.statePath)}. Keep that file: a later run with the same state path confirms the review without sending it again.`,
    );
  }
  if (prepared && prepared.warnings.length > 0 && prepared.markdown) lines.push('', prepared.markdown.trim());
  return lines.join('\n');
}

function uncertainMarkdown(result: UncertainResult, captured: ICapturedInput): string {
  return [
    '## Delivery could not be confirmed',
    '',
    result.detail,
    '',
    `The publication state is preserved at ${code(captured.statePath)}.`,
    '',
    '- Retry later with the same state path: it only checks GitHub for this review and never sends it again.',
    '- Do not delete that file: it is the only record that this review may already exist.',
    '- A new state path starts a new, separate review; use one only if you intend a separate review.',
  ].join('\n');
}

function rejectedMarkdown(result: RejectedResult, captured: ICapturedInput): string {
  const lines = [
    '## GitHub refused the review',
    '',
    result.detail,
    '',
    `The request is never resent. The refusal is tied to the state path ${code(captured.statePath)}.`,
  ];
  if (/one pending review/i.test(result.detail)) {
    lines.push(
      '',
      'This account already has a pending draft review on this pull request, and GitHub allows only one. This tool never submits, edits or deletes it: submit or delete that draft on GitHub yourself.',
    );
  }
  lines.push('', 'After resolving the cause, publish again with a new state path.');
  return lines.join('\n');
}

function blockedMarkdown(prepared: { readonly markdown: string }): string {
  return ['## Review blocked', '', 'Nothing was published and no publication state was written.', '', prepared.markdown.trim()].join(
    '\n',
  );
}

/** The public outcome for a publication-core result. */
function present(result: PublicationResult, captured: ICapturedInput, prepared?: IReadyOutcome): PublishSarifReviewOutcome {
  const { statePath } = captured;
  switch (result.status) {
    case 'published':
      return {
        status: 'published',
        review: { id: result.review.id, url: result.review.htmlUrl },
        statePath,
        markdown: publishedMarkdown(result, captured, prepared),
      };
    case 'uncertain':
      return { status: 'uncertain', statePath, markdown: uncertainMarkdown(result, captured) };
    case 'rejected':
      return { status: 'rejected', statePath, markdown: rejectedMarkdown(result, captured) };
    default: {
      // Unreachable for the typed publication core; kept as the durable
      // refusal to present a status this module does not know.
      const unexpected: { readonly status: unknown } = result;
      throw new Error(`Unexpected publication status ${templateText(unexpected.status)}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run(captured: ICapturedInput, createGitHubClient: CreatePublishingClient): Promise<PublishSarifReviewOutcome> {
  const client = createGitHubClient({ token: captured.token, fetch: globalThis.fetch });
  const identity = {
    destination: captured.destination,
    reviewedCommit: captured.reviewedCommit,
    inputFingerprint: inputFingerprintOf(captured),
    statePath: captured.statePath,
    transport: client,
  };

  const existing = await recoverPublication(identity);
  if (existing.status !== 'missing') return present(existing, captured);

  const contextRequest: IFetchContextRequest = {
    destination: captured.destination,
    reviewedCommit: captured.reviewedCommit,
    ...(captured.oldSourceCommit === undefined ? {} : { oldSourceCommit: captured.oldSourceCommit }),
  };
  const { context, readSource } = await client.fetchContext(contextRequest);
  verifyContext(context, captured);

  const prepareInput = {
    sarif: captured.sarif,
    context: captured.sourceRootUri === undefined ? context : { ...context, sourceRootUri: captured.sourceRootUri },
    readSource,
    ...(captured.ignoreApprovalHold === undefined ? {} : { options: { ignoreApprovalHold: captured.ignoreApprovalHold } }),
  };
  const prepared = await prepareReview(prepareInput);
  if (prepared.status === 'blocked') return { status: 'blocked', markdown: blockedMarkdown(prepared) };
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the typed core returns only 'ready' here; the status test is kept as the durable refusal to publish any other outcome
  if (prepared.status !== 'ready' || prepared.review.commitId !== captured.reviewedCommit) {
    throw new Error('Review preparation returned an unexpected outcome; nothing was published.');
  }

  const result = await publishPreparedReview({
    ...identity,
    preparedReview: { body: prepared.review.body, comments: prepared.review.comments },
  });
  return present(result, captured, prepared);
}

/**
 * Publishes a ready SARIF document as one GitHub draft review — or explains
 * why it is blocked, uncertain or refused.
 *
 * @remarks
 * The whole document is validated before anything is written: if any finding
 * cannot be published faithfully, nothing is published. Publication is
 * one-way and draft-only: the tool never submits, updates, restores or
 * deletes a review. Retrying with the same `statePath` never creates a second
 * review; an existing record is honoured before any GitHub request for the
 * pull request's source.
 *
 * @param input - The document, destination, reviewed commit, state path and
 * credential.
 * @returns The outcome. `status` plus `markdown` is the stable contract;
 * internal diagnostic codes are not part of it.
 * @throws `TypeError` for invalid input (before any network request); an
 * `Error` for a corrupt state file, a state path reused for different input,
 * or an operational failure (for example the network). A rejection never
 * contains the token.
 *
 * @example
 * ```ts
 * import { publishSarifReview } from 'sarif-to-comment';
 *
 * const outcome = await publishSarifReview({
 *   sarif,
 *   destination: { owner: 'acme', repo: 'widgets', pullNumber: 42 },
 *   reviewedCommit: 'c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de',
 *   statePath: '/var/lib/my-linter/acme-widgets-42.json',
 *   token: process.env.GH_TOKEN!,
 * });
 * if (outcome.status === 'published') console.log(outcome.review.url);
 * ```
 *
 * @public
 */
export function publishSarifReview(input: IPublishSarifReviewInput): Promise<PublishSarifReviewOutcome>;
// Implementation signature, never emitted to the declarations: the input is
// `unknown` because JavaScript callers are unconstrained (captureInput checks
// everything), and a second argument is still honoured at runtime as the
// private test seam (IPublishSarifReviewInternals). In-package callers that
// inject use publishSarifReviewWithInternals instead. The default keeps the
// function's length (1) what it always was.
export async function publishSarifReview(input: unknown, internals: IPublishSarifReviewInternals = {}): Promise<PublishSarifReviewOutcome> {
  return publishSarifReviewWithInternals(input, internals);
}

/**
 * {@link publishSarifReview} with its private test seam typed. Internal: the
 * CLI and tests reach the seam through it; it is not part of the public API.
 */
export async function publishSarifReviewWithInternals(
  input: unknown,
  internals: IPublishSarifReviewInternals = {},
): Promise<PublishSarifReviewOutcome> {
  const captured = captureInput(input);
  const createGitHubClient = internals.createGitHubClient || defaultCreateGitHubClient;
  let outcome: PublishSarifReviewOutcome;
  try {
    outcome = await run(captured, createGitHubClient);
  } catch (err) {
    throw withoutCredential(err, captured.token);
  }
  return { ...outcome, markdown: redact(outcome.markdown, captured.token) };
}
