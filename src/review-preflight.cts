/**
 * The review preflight: everything that decides whether a SARIF document can
 * be published faithfully to one pull request, before any publication
 * identity or write exists (private internal module).
 *
 * Publication (src/publish-sarif-review.cts) and readiness assessment
 * (src/validate-sarif-review.cts) both run exactly this code, so the two can
 * never disagree about a readiness rule: a rule added here applies to both.
 * It holds no rule of its own beyond composing:
 *   - input validation and capture of the fields both operations share;
 *   - the GitHub client's review context, verified to be for exactly the
 *     requested pull request and reviewed commit;
 *   - whole-review preparation (src/prepare-review.cts), and the check that a
 *     ready preparation is a review of the reviewed commit;
 *   - the blocked explanation, and credential redaction for anything shown.
 *
 * Nothing here computes a publication identity, reads or writes publication
 * state, or writes to GitHub; that belongs to publication alone.
 *
 * ---------------------------------------------------------------------------
 * captureReviewInput(input, spec) -> captured fields (synchronous)
 *   Shared fields (unknown keys are refused; spec.ownKeys adds more):
 *     sarif, destination { owner, repo, pullNumber }, reviewedCommit, token,
 *     sourceRootUri?, oldSourceCommit?, options? { ignoreApprovalHold? }
 *   The SARIF, destination and options are deep JSON copies of own data
 *   properties only: caller getters never run, and cycles and non-JSON values
 *   are refused rather than dropped or coerced. Fields are checked in a fixed
 *   order; spec.captureOwn checks the operation's own fields after the commits
 *   and before the token. Every refusal is a TypeError whose message begins
 *   "Invalid <spec.operation> input: ".
 *
 * prepareForDestination(captured, client) -> Promise<ready | blocked>
 *   One fetchContext, verifyContext, then prepareReview with the context's
 *   source reader and existence check. Operational failures (GitHub,
 *   network, source reads, existence checks, a context for another pull
 *   request or commit) reject.
 */

import * as util from 'node:util';

import type { IFetchContextRequest } from './github.cjs';
import { prepareReview } from './prepare-review.cjs';
import type { PrepareReviewOutcome } from './prepare-review.cjs';
import type { IJsonObject, IPlainObject, JsonValue } from './sarif-common.cjs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A validated pull-request destination (structurally the public IPullRequestDestination). */
export interface ICapturedDestination {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
}

/** The fields publication and assessment share, captured and validated before the first await. */
export interface ICapturedReview {
  readonly sarif: IJsonObject;
  readonly destination: ICapturedDestination;
  readonly reviewedCommit: string;
  readonly oldSourceCommit: string | undefined;
  readonly token: string;
  readonly sourceRootUri: string | undefined;
  readonly ignoreApprovalHold: boolean | undefined;
}

/**
 * How one operation extends the shared input: the name its refusals carry,
 * the extra top-level fields it accepts, and how it captures them.
 */
export interface IReviewInputSpec<Own extends object> {
  /** The public function name, used in every refusal message. */
  readonly operation: string;
  /** Top-level fields accepted in addition to the shared ones. */
  readonly ownKeys: readonly string[];
  /**
   * Captures and validates the operation's own fields. `field` reads an own
   * data property of the input (refusing accessors); `invalid` builds the
   * operation's refusal.
   */
  readonly captureOwn: (field: (key: string) => unknown, invalid: (message: string) => TypeError) => Own;
}

/**
 * What the preflight needs from a GitHub client: the review context, its
 * source reader and, optionally, its existence check (preparation falls back
 * to the source reader without one). The answers are checked where they are
 * used (verifyContext here, the caller boundary of prepareReview), so they are
 * `unknown` until then.
 */
export interface IContextClient {
  readonly fetchContext: (
    request: IFetchContextRequest,
  ) => Promise<{ readonly context: unknown; readonly readSource: unknown; readonly fileExists?: unknown }>;
}

/** Every accepted shared top-level input field. */
const SHARED_KEYS: readonly string[] = ['sarif', 'destination', 'reviewedCommit', 'token', 'sourceRootUri', 'oldSourceCommit', 'options'];

/** Every accepted option. Only the approval-hold override exists. */
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

function isPlainObject(value: unknown): value is IPlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A value interpolated into a message exactly as a template literal converts
 * it, including values of any type returned by an injected client.
 */
export function templateText(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- reproduces template-literal string conversion of an arbitrary host-supplied value in an error message; String() would differ for symbols
  return `${value}`;
}

/** Refusals of one operation's input, all prefixed with its name. */
class InputRefusals {
  readonly operation: string;

  constructor(operation: string) {
    this.operation = operation;
  }

  invalid(message: string): TypeError {
    return new TypeError(`Invalid ${this.operation} input: ${message}`);
  }

  /** An own data property's value, refusing accessors (whose getters are never run). */
  dataValue(object: object, key: string, where: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return undefined;
    if (!Object.hasOwn(descriptor, 'value')) throw this.invalid(`${where} is an accessor property; only plain JSON data is accepted`);
    return descriptor.value;
  }

  /**
   * A deep copy of `value` restricted to what JSON represents faithfully:
   * plain objects with enumerable string-keyed data properties, dense arrays,
   * strings, finite numbers (not -0), booleans and null. Anything else —
   * cycles, accessors, symbols, undefined, functions, BigInt, class
   * instances, holes — is refused rather than dropped or coerced, so what is
   * checked and what is published can only ever describe the same document.
   */
  captureJson(value: unknown, where: string, ancestors: Set<object> = new Set(), depth = 0): JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) throw this.invalid(`${where} is not a finite JSON number`);
      return value;
    }
    if (typeof value !== 'object') throw this.invalid(`${where} is a ${typeof value}, which JSON cannot represent`);
    if (depth > MAX_JSON_DEPTH) throw this.invalid(`${where} is nested more than ${String(MAX_JSON_DEPTH)} levels deep`);
    if (ancestors.has(value)) throw this.invalid(`${where} contains a cycle`);
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) throw this.invalid(`${where} is not a plain array`);
        const keys = Reflect.ownKeys(value);
        const length = this.dataValue(value, 'length', `${where}.length`);
        // An array's own `length` is always a number; the typeof test only
        // lets the comparison below be typed.
        if (typeof length !== 'number' || keys.length !== length + 1) throw this.invalid(`${where} has holes or extra properties`);
        const copy = new Array<JsonValue>(length);
        for (let i = 0; i < length; i += 1) {
          if (!Object.hasOwn(value, i)) throw this.invalid(`${where}[${String(i)}] is a hole`);
          copy[i] = this.captureJson(this.dataValue(value, String(i), `${where}[${String(i)}]`), `${where}[${String(i)}]`, ancestors, depth + 1);
        }
        return copy;
      }
      return this.captureObject(value, where, ancestors, depth);
    } finally {
      ancestors.delete(value);
    }
  }

  /**
   * The object step of {@link captureJson}: `value` is already on the
   * ancestor path at `depth`. Separate only so that a capture known to start
   * at a plain object (captureRoot) is typed as producing an object.
   */
  captureObject(value: object, where: string, ancestors: Set<object>, depth: number): IJsonObject {
    if (!isPlainObject(value)) throw this.invalid(`${where} is not a plain JSON object`);
    const copy: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') throw this.invalid(`${where} has a symbol-keyed property`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      // A key reported by Reflect.ownKeys always has a descriptor.
      if (!descriptor?.enumerable) throw this.invalid(`${where}.${key} is not enumerable`);
      const item = this.captureJson(this.dataValue(value, key, `${where}.${key}`), `${where}.${key}`, ancestors, depth + 1);
      Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
    }
    return copy;
  }

  /**
   * {@link captureJson} of a top-level plain object: the same checks in the
   * same order (at depth 0 with no ancestors, only the object step can refuse
   * it), typed as the JSON object it produces.
   */
  captureRoot(value: IPlainObject, where: string): IJsonObject {
    return this.captureObject(value, where, new Set<object>([value]), 0);
  }
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
 * operation will use: the shared fields plus the operation's own. Runs
 * synchronously, before the first await.
 */
export function captureReviewInput<Own extends object>(input: unknown, spec: IReviewInputSpec<Own>): ICapturedReview & Own {
  const refusals = new InputRefusals(spec.operation);
  const invalid = (message: string): TypeError => refusals.invalid(message);
  if (!isPlainObject(input)) throw invalid('input must be a plain object');
  const accepted = new Set([...SHARED_KEYS, ...spec.ownKeys]);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === 'symbol' || !accepted.has(key)) throw invalid(`unknown field ${String(key)}`);
  }
  const field = (key: string): unknown => refusals.dataValue(input, key, key);

  const sarifValue = field('sarif');
  if (!isPlainObject(sarifValue)) throw invalid('sarif must be a parsed SARIF object (not text or an array)');
  const sarif = refusals.captureRoot(sarifValue, 'sarif');

  const destinationValue = field('destination');
  if (!isPlainObject(destinationValue)) throw invalid('destination must be { owner, repo, pullNumber }');
  const destination = refusals.captureRoot(destinationValue, 'destination');
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

  const own = spec.captureOwn(field, invalid);

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
    const options = refusals.captureRoot(optionsValue, 'options');
    for (const key of Object.keys(options)) if (!OPTION_KEYS.has(key)) throw invalid(`unknown option ${key}`);
    const ignoreHold = options['ignoreApprovalHold'];
    if (ignoreHold !== undefined && typeof ignoreHold !== 'boolean') {
      throw invalid('options.ignoreApprovalHold must be a boolean');
    }
    ignoreApprovalHold = ignoreHold;
  }

  const shared: ICapturedReview = { sarif, destination, reviewedCommit, oldSourceCommit, token, sourceRootUri, ignoreApprovalHold };
  return { ...own, ...shared };
}

// ---------------------------------------------------------------------------
// Context verification and preparation
// ---------------------------------------------------------------------------

/** `owner/repo#number` of the requested pull request. */
export function destinationLabel(captured: ICapturedReview): string {
  const { owner, repo, pullNumber } = captured.destination;
  return `${owner}/${repo}#${String(pullNumber)}`;
}

/**
 * GitHub answered with review context for another pull request or reviewed
 * commit. This is the host's answer, not a defect in this package, so
 * readiness assessment reports it as incomplete; publication rejects with it.
 * The name stays `Error`, as publication's rejection always was.
 */
export class ReviewContextMismatchError extends Error {}

/**
 * Refuses a context that is not for exactly the requested pull request and
 * reviewed commit. The review is never retargeted to another pull request or
 * to the pull request's current head.
 */
function verifyContext(context: unknown, captured: ICapturedReview): asserts context is IPlainObject {
  const { owner, repo, pullNumber } = captured.destination;
  const wanted = destinationLabel(captured);
  if (!isPlainObject(context)) throw new Error(`GitHub returned no usable review context for ${wanted}.`);
  const sameName = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  if (!sameName(context['owner'], owner) || !sameName(context['repo'], repo) || context['pullNumber'] !== pullNumber) {
    throw new ReviewContextMismatchError(
      `GitHub returned review context for pull request ${templateText(context['owner'])}/${templateText(context['repo'])}#${templateText(context['pullNumber'])}, not the requested pull request ${wanted}.`,
    );
  }
  if (context['reviewedCommit'] !== captured.reviewedCommit) {
    throw new ReviewContextMismatchError(
      `GitHub returned review context for reviewed commit ${templateText(context['reviewedCommit'])}, not the requested reviewed commit ${captured.reviewedCommit}. A review is never retargeted to another commit.`,
    );
  }
}

/**
 * Fetches the review context once, verifies it is for exactly this pull
 * request and reviewed commit, and prepares the whole review against it.
 * Returns the preparation's `ready` or `blocked` outcome; rejects for an
 * operational failure or an unexpected preparation, never writing anything.
 */
export async function prepareForDestination(captured: ICapturedReview, client: IContextClient): Promise<PrepareReviewOutcome> {
  const contextRequest: IFetchContextRequest = {
    destination: captured.destination,
    reviewedCommit: captured.reviewedCommit,
    ...(captured.oldSourceCommit === undefined ? {} : { oldSourceCommit: captured.oldSourceCommit }),
  };
  const { context, readSource, fileExists } = await client.fetchContext(contextRequest);
  verifyContext(context, captured);

  const prepareInput = {
    sarif: captured.sarif,
    context: captured.sourceRootUri === undefined ? context : { ...context, sourceRootUri: captured.sourceRootUri },
    readSource,
    ...(fileExists === undefined ? {} : { fileExists }),
    ...(captured.ignoreApprovalHold === undefined ? {} : { options: { ignoreApprovalHold: captured.ignoreApprovalHold } }),
  };
  const prepared = await prepareReview(prepareInput);
  if (prepared.status === 'blocked') return prepared;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the typed core returns only 'ready' here; the status test is kept as the durable refusal to publish any other outcome
  if (prepared.status !== 'ready' || prepared.review.commitId !== captured.reviewedCommit) {
    throw new Error('Review preparation returned an unexpected outcome; nothing was published.');
  }
  return prepared;
}

/** The explanation of a blocked review, shown identically by publication and assessment. */
export function blockedReviewMarkdown(prepared: { readonly markdown: string }): string {
  return ['## Review blocked', '', 'Nothing was published and no publication state was written.', '', prepared.markdown.trim()].join(
    '\n',
  );
}

// ---------------------------------------------------------------------------
// Credential safety
// ---------------------------------------------------------------------------

/** `text` with every occurrence of the credential replaced. */
export function redact(text: string, token: string): string {
  return text.split(token).join(REDACTED);
}

/** The message of `err` followed by its cause chain, as plain text. */
export function messageChain(err: unknown): string {
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
export function withoutCredential(err: unknown, token: string): unknown {
  const inspected = util.inspect(err, { depth: null, showHidden: true });
  if (!inspected.includes(token)) return err;
  const safe = new Error(redact(messageChain(err), token));
  safe.name = err instanceof Error ? err.name : 'Error';
  return safe;
}
