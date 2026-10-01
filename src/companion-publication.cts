/**
 * Durable publication of a review together with its companion suggestion
 * pull requests (private internal module;
 * docs/companion-suggestion-pr-contract.md §2.6–§2.10).
 *
 * Scope: take a wholly validated preparation that needs suggestion pull
 * requests and create, exactly once each, every remote object it implies —
 * per suggestion a proposal commit, its branch, its pull request (a draft
 * unless the plan says ready) and its labels, all under the tool-neutral
 * convention (docs/suggestion-pr-convention.md) — and then the review, which
 * links every suggestion by number. It
 * never updates, force-pushes, closes, reopens, relabels or deletes anything,
 * and recovery never restores what a person changed (D29).
 *
 * State. The caller's `statePath` holds the **plan**, written exclusively
 * before any write and never changed: format
 * 'sarif-to-comment.companion-publication-state', version 1, with the
 * destination, reviewed commit, input fingerprint, author id, mode, head
 * branch, labels (the canonical label first, as GitHub names them), whether
 * the pull requests are created ready for review, the publication id (the
 * markers' `batch`), every suggestion (id, branch, title, body, commit
 * message, exact changes, rendered section parts), the review's body
 * sections and inline comments, and preparation's warnings when there are
 * any (`warnings`, a non-empty list of diagnostics that are not errors, in
 * either version; issue #42), bound by a fingerprint over all of it.
 * Version 2 adds `reappliedOnto`: the commit every proposal is based on
 * instead of the reviewed commit, because the pull request's history was
 * rewritten (docs/companion-suggestion-pr-contract.md §2.5.1); its markers
 * are then version 2 of the convention. It is decided once, when planned,
 * and never again.
 * Each step that a person could see has its own record beside it,
 * `<statePath>.suggestion-<n>-branch|pull|labels` (format
 * 'sarif-to-comment.companion-step', version 1), claimed exclusively
 * (hard link) with its intent before its write is sent, and later replaced
 * atomically by its receipt or by the host's definitive refusal. The review
 * is the existing version-1 publication record at `<statePath>.review`,
 * written by src/publication.cts. Every file is owner-only.
 *
 * Rules:
 *   - A claimed step is never sent again by any invocation; it is only
 *     investigated, read-only. Absence is never proof that nothing was
 *     created, and pull requests are found by their unique proposal branch
 *     and verified by their exact marker line, never by a label.
 *   - Only the Git objects of a proposal commit are created without a
 *     claim: they are content-addressed and invisible until a branch names
 *     them, so creating them again creates nothing a person can see.
 *   - Before a pull request is created, its branch must still point at the
 *     proposal commit; otherwise nothing is created ('branch-changed').
 *   - A definitive refusal stops the publication before the review.
 *   - Every investigation and send requires the plan's author id.
 *
 * ---------------------------------------------------------------------------
 * startCompanionPublication(input, internals?) -> Promise<Outcome>
 *   input: identity (destination, reviewedCommit, inputFingerprint,
 *   statePath, submit), the ready preparation's `suggestions` and review
 *   comments, the head branch, the labels (as GitHub names them), whether to
 *   create the pull requests ready for review, and the transport
 *   (src/github.cts's client).
 * continueCompanionPublication(identity, internals?) -> Promise<Outcome>
 *   For an existing plan: identity mismatches are refused locally
 *   (PublicationStateError 'state-mismatch') before any request. When a
 *   suggestion's steps are not all complete, the pull request's head is read
 *   (read-only) and compared with the plan's base (reappliedOnto, else the
 *   reviewed commit): a base that is no longer part of the branch is
 *   reported as `baseCheck` on the outcome, and nothing is re-decided
 *   (docs/companion-suggestion-pr-contract.md §2.10). A failed read is
 *   reported the same way, as unknown, never as a failure.
 * hasCompanionPlan(statePath, internals?) -> boolean
 *   Whether the file at the state path is a plan (never guessed further:
 *   anything else is for the version-1 reader to accept or refuse).
 *
 * Outcome (private; presented by src/publish-sarif-review.cts), each with
 * the plan's `warnings` ([] when it records none), on the call that planned
 * the publication and on every later call alike:
 *   { status: 'published', review, via, receiptPersisted, suggestions }
 *   { status: 'uncertain', step, suggestion?, detail, established, cause? }
 *   { status: 'rejected', step, suggestion?, httpStatus, detail, established,
 *     via: 'response' | 'record' }
 * Thrown: PublicationStateError for local state problems (corrupt, mismatch,
 * I/O); operational transport errors (reads, and the invisible Git object
 * writes) propagate unchanged, with every claimed step preserved.
 */

import * as crypto from 'node:crypto';
import * as nodeFs from 'node:fs';

import type { IBranchPullRequest, ProposalChange } from './github.cjs';
import type { IDiagnostic } from './public-types.cjs';
import type { IPreparedCompanion, IPreparedSuggestions, ISuggestionContext, PreparedComment } from './prepare-review.cjs';
import { renderReviewBody, renderSuggestionPullBody } from './prepare-review.cjs';
import {
  PublicationStateError,
  boundedRejectionMessage,
  claimNewFile,
  fingerprintOf,
  isHostRejection,
  isRefusalStatus,
  mismatch,
  modeMismatch,
  publishPreparedReview,
  recoverPublication,
  refusalSentence,
  replaceFileDurably,
  thrownMessage,
  warningsProblem,
  MAX_REJECTION_MESSAGE,
} from './publication.cjs';
import type { IPublicationFs, IPublicationInternals, PublicationMode } from './publication.cjs';
import { formatSuggestionMarker } from './suggestion-marker.cjs';
import { suggestionPrBranch } from './suggestion-pr-convention.cjs';

// ---------------------------------------------------------------------------
// Types

/** The pull request a publication targets. */
interface IDestination {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
}

/** What the companion steps call on GitHub (src/github.cts's client), plus the review transport. */
export interface ICompanionTransport {
  getAuthenticatedUser(): Promise<unknown>;
  createReview(request: never): Promise<unknown>;
  listReviews(query: never): Promise<unknown>;
  listReviewComments(query: never): Promise<unknown>;
  createProposalCommit(request: {
    readonly owner: string;
    readonly repo: string;
    readonly parent: string;
    readonly message: string;
    readonly changes: readonly ProposalChange[];
  }): Promise<{ readonly commit: string }>;
  getBranch(request: { readonly owner: string; readonly repo: string; readonly branch: string }): Promise<string | null>;
  createBranch(request: { readonly owner: string; readonly repo: string; readonly branch: string; readonly commit: string }): Promise<void>;
  createPullRequest(request: {
    readonly owner: string;
    readonly repo: string;
    readonly title: string;
    readonly head: string;
    readonly base: string;
    readonly body: string;
    readonly draft: boolean;
  }): Promise<{ readonly number: number; readonly htmlUrl: string }>;
  listBranchPullRequests(request: { readonly owner: string; readonly repo: string; readonly branch: string }): Promise<readonly IBranchPullRequest[]>;
  addLabels(request: { readonly owner: string; readonly repo: string; readonly number: number; readonly labels: readonly string[] }): Promise<void>;
  listLabels(request: { readonly owner: string; readonly repo: string; readonly number: number }): Promise<readonly string[]>;
  /** Read only on a retry with work left, to say whether the branch changed since planning. */
  readSuggestionTarget?(request: { readonly owner: string; readonly repo: string; readonly pullNumber: number }): Promise<{ readonly headSha: string }>;
  /** Read only on a retry with work left, when the head is not the plan's base. */
  compareCommits?(request: { readonly owner: string; readonly repo: string; readonly base: string; readonly head: string }): Promise<string>;
}

/**
 * On a retry, whether the plan's base is still part of the pull request's
 * branch: `changed` when it is not (its current head named), `unknown` when
 * that could not be read. Absent when the base is still part of it, or when
 * nothing is left to create.
 */
export type BaseCheck =
  | { readonly kind: 'changed'; readonly base: string; readonly head: string }
  | { readonly kind: 'unknown'; readonly base: string; readonly detail: string };

/** The identity every call is checked against. */
export interface ICompanionIdentity {
  readonly destination: IDestination;
  readonly reviewedCommit: string;
  readonly inputFingerprint: string;
  readonly statePath: string;
  readonly submit: boolean;
  readonly transport: ICompanionTransport;
}

/** A new publication's input. */
export interface IStartCompanionInput extends ICompanionIdentity {
  readonly suggestions: IPreparedSuggestions;
  readonly comments: readonly PreparedComment[];
  readonly headRef: string;
  /** Every label, as GitHub names it: the canonical label first. */
  readonly labels: readonly string[];
  /** Whether the pull requests are created ready for review instead of as drafts. */
  readonly ready: boolean;
  /** The commit the suggestions are re-applied onto after a rewritten history; absent when they are based on the reviewed commit. */
  readonly reappliedOnto?: string;
  /** Preparation's warnings, recorded with the plan and reported by every call for this state path. */
  readonly warnings: readonly IDiagnostic[];
}

/** One planned suggestion: its prepared texts plus the identity chosen for it. */
interface IPlanSuggestion extends IPreparedCompanion {
  readonly id: string;
  readonly branch: string;
  readonly body: string;
}

/** The plan record (see the module documentation). */
interface IPlanRecord {
  readonly format: typeof PLAN_FORMAT;
  /** 1, or 2 exactly when `reappliedOnto` is present. */
  readonly version: typeof RECORD_VERSION | typeof REAPPLIED_PLAN_VERSION;
  readonly publication: string;
  readonly destination: IDestination;
  readonly reviewedCommit: string;
  readonly inputFingerprint: string;
  readonly authorId: number;
  readonly submit: boolean;
  readonly headRef: string;
  readonly labels: readonly string[];
  readonly ready: boolean;
  /** The commit every proposal is based on after a rewritten history (version 2 only). */
  readonly reappliedOnto?: string;
  readonly suggestions: readonly IPlanSuggestion[];
  readonly review: { readonly sections: readonly (string | number)[]; readonly comments: readonly PreparedComment[] };
  /** Preparation's warnings; present exactly when there are any. */
  readonly warnings?: readonly IDiagnostic[];
  readonly planFingerprint: string;
}

/** The three steps a person can see, per suggestion. */
type StepName = 'branch' | 'pull' | 'labels';

/** A persisted definitive refusal: only its status and bounded message. */
interface IStepRejection {
  readonly status: number;
  readonly message: string;
}

/** Fields every step record carries. */
interface IStepBase {
  readonly format: typeof STEP_FORMAT;
  readonly version: typeof RECORD_VERSION;
  readonly publication: string;
  readonly suggestion: string;
}

/** A branch step: the proposal commit it names. */
interface IBranchStep extends IStepBase {
  readonly step: 'branch';
  readonly commit: string;
  readonly phase: 'sending' | 'completed' | 'rejected';
  readonly rejection?: IStepRejection;
}

/** A pull request step: its receipt once verified. */
interface IPullStep extends IStepBase {
  readonly step: 'pull';
  readonly phase: 'sending' | 'completed' | 'rejected';
  readonly receipt?: { readonly number: number; readonly htmlUrl: string };
  readonly rejection?: IStepRejection;
}

/** A labels step: the pull request it labels. */
interface ILabelsStep extends IStepBase {
  readonly step: 'labels';
  readonly number: number;
  readonly phase: 'sending' | 'completed' | 'rejected';
  readonly rejection?: IStepRejection;
}

type StepRecord = IBranchStep | IPullStep | ILabelsStep;

/** A created suggestion pull request, as outcomes report it. */
export interface ICompanionSuggestionRef {
  readonly number: number;
  readonly htmlUrl: string;
  readonly branch: string;
}

/** What is already established when a publication stops: per suggestion, its branch and pull request if known. */
export interface IEstablished {
  readonly suggestion: number;
  readonly branch: string | null;
  readonly pull: { readonly number: number; readonly htmlUrl: string } | null;
}

/** The step an outcome concerns: a suggestion step, or the review. */
export type CompanionStep = StepName | 'review';

export interface ICompanionPublished {
  readonly status: 'published';
  readonly review: { readonly id: number; readonly htmlUrl: string };
  readonly via: 'created' | 'recovered' | 'receipt';
  readonly receiptPersisted: boolean;
  readonly suggestions: readonly ICompanionSuggestionRef[];
  readonly headRef: string;
  readonly labels: readonly string[];
  readonly ready: boolean;
  /** The commit the suggestions were re-applied onto, when they were. */
  readonly reappliedOnto?: string;
  readonly baseCheck?: BaseCheck;
}

export interface ICompanionUncertain {
  readonly status: 'uncertain';
  readonly step: CompanionStep;
  readonly suggestion?: number;
  readonly detail: string;
  readonly established: readonly IEstablished[];
  readonly cause?: unknown;
  readonly baseCheck?: BaseCheck;
}

export interface ICompanionRejected {
  readonly status: 'rejected';
  readonly step: CompanionStep;
  readonly suggestion?: number;
  readonly httpStatus: number;
  readonly via: 'response' | 'record';
  readonly detail: string;
  readonly established: readonly IEstablished[];
  readonly baseCheck?: BaseCheck;
}

/** What the steps conclude, before the plan's warnings are added. */
type StepsOutcome = ICompanionPublished | ICompanionUncertain | ICompanionRejected;

/** Every outcome, with the plan's warnings ([] when it records none). */
export type CompanionOutcome = StepsOutcome & { readonly warnings: readonly IDiagnostic[] };

/** A step's settled state: done (with its value), or the outcome that stops the publication. */
type Settled<T> = { readonly done: true; readonly value: T } | { readonly done: false; readonly outcome: ICompanionUncertain | ICompanionRejected };

/** A JSON-object-shaped value whose fields are not yet validated. */
type UnknownObject = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Constants

const PLAN_FORMAT = 'sarif-to-comment.companion-publication-state';
const STEP_FORMAT = 'sarif-to-comment.companion-step';
const RECORD_VERSION = 1;
/** The plan version whose suggestions are re-applied onto a rewritten head. */
const REAPPLIED_PLAN_VERSION = 2;

const FULL_SHA = /^[0-9a-f]{40}$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const PLAN_KEYS: readonly string[] = [
  'authorId', 'destination', 'format', 'headRef', 'inputFingerprint', 'labels', 'planFingerprint', 'publication',
  'ready', 'review', 'reviewedCommit', 'submit', 'suggestions', 'version',
];
const SUGGESTION_KEYS: readonly string[] = ['body', 'branch', 'changeCount', 'changeLines', 'changes', 'commitMessage', 'id', 'items', 'title'];
const COMMENT_KEYS: ReadonlySet<string> = new Set(['path', 'side', 'line', 'startSide', 'startLine', 'body']);

// ---------------------------------------------------------------------------
// Shape checks (fail closed)

function isPlainObject(value: unknown): value is UnknownObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasExactKeys(object: object, keys: readonly string[]): boolean {
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

function isProposalChange(value: unknown): value is ProposalChange {
  if (!isPlainObject(value) || !isNonEmptyString(value['path'])) return false;
  switch (value['operation']) {
    case 'delete':
      return hasExactKeys(value, ['operation', 'path']);
    case 'edit':
      return hasExactKeys(value, ['operation', 'path', 'text']) && typeof value['text'] === 'string';
    case 'create':
      return hasExactKeys(value, ['fileMode', 'operation', 'path', 'text']) && typeof value['text'] === 'string'
        && (value['fileMode'] === '100644' || value['fileMode'] === '100755');
    default:
      return false;
  }
}

function isPreparedComment(value: unknown): value is PreparedComment {
  if (!isPlainObject(value) || !Object.keys(value).every((k) => COMMENT_KEYS.has(k))) return false;
  const sides = new Set(['LEFT', 'RIGHT']);
  const start = Object.hasOwn(value, 'startSide');
  return isNonEmptyString(value['path']) && sides.has(String(value['side'])) && isPositiveInteger(value['line'])
    && typeof value['body'] === 'string' && start === Object.hasOwn(value, 'startLine')
    && (!start || (sides.has(String(value['startSide'])) && isPositiveInteger(value['startLine'])));
}

/** Why a parsed value is not a consistent plan, or null. */
function planProblem(record: unknown): string | null {
  if (!isPlainObject(record) || record['format'] !== PLAN_FORMAT) return 'not a companion publication plan';
  const version = record['version'];
  if (version !== RECORD_VERSION && version !== REAPPLIED_PLAN_VERSION) return 'unsupported plan version';
  const keys = [...(version === RECORD_VERSION ? PLAN_KEYS : [...PLAN_KEYS, 'reappliedOnto']), ...(Object.hasOwn(record, 'warnings') ? ['warnings'] : [])];
  if (!hasExactKeys(record, keys)) return 'plan fields are not the expected set';
  const destination = record['destination'];
  if (!isPlainObject(destination) || !hasExactKeys(destination, ['owner', 'pullNumber', 'repo'])
    || !isNonEmptyString(destination['owner']) || !isNonEmptyString(destination['repo']) || !isPositiveInteger(destination['pullNumber'])) {
    return 'malformed destination';
  }
  if (typeof record['publication'] !== 'string' || !UUID.test(record['publication'])) return 'malformed publication id';
  if (typeof record['reviewedCommit'] !== 'string' || !FULL_SHA.test(record['reviewedCommit'])) return 'malformed reviewedCommit';
  const reappliedOnto = record['reappliedOnto'];
  if (version === REAPPLIED_PLAN_VERSION && (typeof reappliedOnto !== 'string' || !FULL_SHA.test(reappliedOnto) || reappliedOnto === record['reviewedCommit'])) {
    return 'malformed reappliedOnto';
  }
  if (typeof record['inputFingerprint'] !== 'string' || !FINGERPRINT.test(record['inputFingerprint'])) return 'malformed inputFingerprint';
  if (!isPositiveInteger(record['authorId'])) return 'malformed authorId';
  if (typeof record['submit'] !== 'boolean') return 'malformed mode';
  if (!isNonEmptyString(record['headRef'])) return 'malformed head branch';
  const labels = record['labels'];
  if (!isList(labels) || labels.length === 0 || !labels.every(isNonEmptyString)) return 'malformed labels';
  if (typeof record['ready'] !== 'boolean') return 'malformed ready setting';
  const suggestions = record['suggestions'];
  if (!isList(suggestions) || suggestions.length === 0) return 'no suggestions';
  for (const [i, s] of suggestions.entries()) {
    if (!isPlainObject(s) || !hasExactKeys(s, SUGGESTION_KEYS)) return `suggestion ${String(i + 1)} fields are not the expected set`;
    const id = s['id'];
    if (typeof id !== 'string' || !UUID.test(id)) return `suggestion ${String(i + 1)} has a malformed id`;
    if (s['branch'] !== suggestionPrBranch(destination['pullNumber'], id)) return `suggestion ${String(i + 1)} has another branch`;
    for (const key of ['title', 'body', 'commitMessage', 'changeLines', 'items']) {
      if (!isNonEmptyString(s[key])) return `suggestion ${String(i + 1)} has a malformed ${key}`;
    }
    if (!isPositiveInteger(s['changeCount'])) return `suggestion ${String(i + 1)} has a malformed change count`;
    const changes = s['changes'];
    if (!isList(changes) || changes.length === 0 || !changes.every(isProposalChange)) return `suggestion ${String(i + 1)} has malformed changes`;
  }
  const review = record['review'];
  if (!isPlainObject(review) || !hasExactKeys(review, ['comments', 'sections'])) return 'malformed review';
  const sections = review['sections'];
  if (!isList(sections) || !sections.every((p) => typeof p === 'string' || (typeof p === 'number' && Number.isInteger(p) && p >= 0 && p < suggestions.length))) {
    return 'malformed review sections';
  }
  if (!isList(review['comments']) || !review['comments'].every(isPreparedComment)) return 'malformed review comments';
  if (Object.hasOwn(record, 'warnings')) {
    const warnings = record['warnings'];
    const problem = warningsProblem(warnings);
    if (problem !== null) return `malformed warnings (${problem})`;
    if (isList(warnings) && warnings.length === 0) return 'malformed warnings (present, but empty)';
  }
  const { planFingerprint, ...rest } = record;
  if (typeof planFingerprint !== 'string' || planFingerprint !== fingerprintOf(rest)) return 'the plan does not match its fingerprint';
  return null;
}

/** Why a parsed value is not a consistent step record of `step` for this plan's suggestion `id`, or null. */
function stepProblem(record: unknown, plan: IPlanRecord, id: string, step: StepName): string | null {
  if (!isPlainObject(record) || record['format'] !== STEP_FORMAT) return 'not a companion step record';
  if (record['version'] !== RECORD_VERSION) return 'unsupported step version';
  if (record['publication'] !== plan.publication || record['suggestion'] !== id || record['step'] !== step) {
    return 'the step belongs to another publication, suggestion or step';
  }
  const phase = record['phase'];
  if (phase !== 'sending' && phase !== 'completed' && phase !== 'rejected') return 'unknown step phase';
  const base = ['format', 'phase', 'publication', 'step', 'suggestion', 'version'];
  const own = step === 'branch' ? ['commit'] : step === 'labels' ? ['number'] : [];
  const terminal = phase === 'rejected' ? ['rejection'] : phase === 'completed' && step === 'pull' ? ['receipt'] : [];
  if (!hasExactKeys(record, [...base, ...own, ...terminal])) return 'step fields do not match its phase';
  if (step === 'branch' && (typeof record['commit'] !== 'string' || !FULL_SHA.test(record['commit']))) return 'malformed commit';
  if (step === 'labels' && !isPositiveInteger(record['number'])) return 'malformed pull request number';
  if (phase === 'completed' && step === 'pull') {
    const receipt = record['receipt'];
    if (!isPlainObject(receipt) || !hasExactKeys(receipt, ['htmlUrl', 'number']) || !isPositiveInteger(receipt['number']) || !isNonEmptyString(receipt['htmlUrl'])) {
      return 'malformed receipt';
    }
  }
  if (phase === 'rejected') {
    const rejection = record['rejection'];
    if (!isPlainObject(rejection) || !hasExactKeys(rejection, ['message', 'status']) || !isRefusalStatus(rejection['status'])
      || typeof rejection['message'] !== 'string' || rejection['message'].length > MAX_REJECTION_MESSAGE) {
      return 'malformed rejection';
    }
  }
  return null;
}

function isPlan(record: unknown): record is IPlanRecord {
  return planProblem(record) === null;
}

function isStep<S extends StepRecord>(record: unknown, plan: IPlanRecord, id: string, step: S['step']): record is S {
  return stepProblem(record, plan, id, step) === null;
}

// ---------------------------------------------------------------------------
// Files

/** The parsed JSON at `filePath`, or undefined only when no file exists there. */
function readJsonFile(fs: IPublicationFs, filePath: string, what: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return undefined;
    throw new PublicationStateError('state-io', `Cannot read ${what} at ${filePath}.`, { cause: err });
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (err) {
    throw new PublicationStateError('state-corrupt', `${what} at ${filePath} is not complete JSON; it is not treated as absent.`, { cause: err });
  }
}

function serialize(record: object): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Reads the plan at `statePath`; anything but a consistent plan is corrupt. */
function readPlan(fs: IPublicationFs, statePath: string): IPlanRecord {
  const record = readJsonFile(fs, statePath, 'The publication plan');
  if (record === undefined) throw new PublicationStateError('state-io', `The publication plan at ${statePath} vanished.`);
  if (!isPlan(record)) {
    throw new PublicationStateError('state-corrupt', `Publication state at ${statePath} is not a valid record (${String(planProblem(record))}); it is not treated as absent.`);
  }
  return record;
}

function stepPath(statePath: string, index: number, step: StepName): string {
  return `${statePath}.suggestion-${String(index + 1)}-${step}`;
}

// ---------------------------------------------------------------------------
// Entry points

/** Whether the file at `statePath` is a companion publication plan (see the module documentation). */
export function hasCompanionPlan(statePath: string, internals: IPublicationInternals = {}): boolean {
  const fs = internals.fs || nodeFs;
  let text: string;
  try {
    text = fs.readFileSync(statePath, 'utf8');
  } catch {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) && parsed['format'] === PLAN_FORMAT;
  } catch {
    return false;
  }
}

/** Starts a new publication under `statePath`, or continues the plan another invocation claimed first. */
export async function startCompanionPublication(input: IStartCompanionInput, internals: IPublicationInternals = {}): Promise<CompanionOutcome> {
  const fs = internals.fs || nodeFs;
  const authorId = await authenticatedUserId(input.transport);
  const publication = crypto.randomUUID();
  const { owner, repo, pullNumber } = input.destination;
  const reapplied = input.reappliedOnto === undefined ? {} : { reappliedOnto: input.reappliedOnto };
  const target: ISuggestionContext = { owner, repo, pullNumber, reviewedCommit: input.reviewedCommit, headRef: input.headRef, ready: input.ready, ...reapplied };
  const suggestions = input.suggestions.companions.map((companion): IPlanSuggestion => {
    const id = crypto.randomUUID();
    const marker = formatSuggestionMarker({ id, batch: publication, owner, repo, pullNumber, reviewedCommit: input.reviewedCommit, ...reapplied });
    return {
      title: companion.title,
      commitMessage: companion.commitMessage,
      changes: companion.changes,
      changeCount: companion.changeCount,
      changeLines: companion.changeLines,
      items: companion.items,
      id,
      branch: suggestionPrBranch(pullNumber, id),
      body: renderSuggestionPullBody(companion, marker, target),
    };
  });
  const unsigned = {
    format: PLAN_FORMAT,
    version: input.reappliedOnto === undefined ? RECORD_VERSION : REAPPLIED_PLAN_VERSION,
    publication,
    destination: { owner, repo, pullNumber },
    reviewedCommit: input.reviewedCommit,
    inputFingerprint: input.inputFingerprint,
    authorId,
    submit: input.submit,
    headRef: input.headRef,
    labels: [...input.labels],
    ready: input.ready,
    ...reapplied,
    suggestions,
    review: { sections: input.suggestions.sections, comments: input.comments },
    ...(input.warnings.length === 0 ? {} : { warnings: structuredClone(input.warnings) }),
  } as const;
  const plan: IPlanRecord = { ...unsigned, planFingerprint: fingerprintOf(structuredClone(unsigned)) };
  if (!claimNewFile(fs, input.statePath, serialize(plan), 'publication plan')) {
    // Another invocation claimed this identity first; continue its plan.
    return continueCompanionPublication(input, internals);
  }
  return withPlanWarnings(plan, await drive(new Publication(fs, input, plan, authorId)));
}

/**
 * `outcome` with the plan's warnings: every call reports the warnings the
 * plan records, whatever this call's own preparation found (issue #42).
 */
function withPlanWarnings(plan: IPlanRecord, outcome: StepsOutcome): CompanionOutcome {
  return { ...outcome, warnings: plan.warnings === undefined ? [] : structuredClone(plan.warnings) };
}

/** Continues the plan at `statePath` (see the module documentation). */
export async function continueCompanionPublication(identity: ICompanionIdentity, internals: IPublicationInternals = {}): Promise<CompanionOutcome> {
  const fs = internals.fs || nodeFs;
  const plan = readPlan(fs, identity.statePath);
  assertSameIdentity(plan, identity);
  const publication = new Publication(fs, identity, plan, null);
  const baseCheck = publication.hasSuggestionWorkLeft() ? await checkPlannedBase(plan, identity.transport) : undefined;
  const outcome = await drive(publication);
  return withPlanWarnings(plan, baseCheck === undefined ? outcome : { ...outcome, baseCheck });
}

/**
 * Whether the plan's base (reappliedOnto, else the reviewed commit) is still
 * part of the pull request's branch; read-only, and never a reason to stop:
 * a failed read is reported as unknown. Nothing is re-decided either way.
 */
async function checkPlannedBase(plan: IPlanRecord, transport: ICompanionTransport): Promise<BaseCheck | undefined> {
  const base = plan.reappliedOnto ?? plan.reviewedCommit;
  const { owner, repo, pullNumber } = plan.destination;
  if (transport.readSuggestionTarget === undefined || transport.compareCommits === undefined) return undefined;
  try {
    const { headSha: head } = await transport.readSuggestionTarget({ owner, repo, pullNumber });
    if (head === base) return undefined;
    const comparison = await transport.compareCommits({ owner, repo, base, head });
    return comparison === 'ahead' || comparison === 'identical' ? undefined : { kind: 'changed', base, head };
  } catch (err) {
    return { kind: 'unknown', base, detail: String(thrownMessage(err)) };
  }
}

/** Refuses a plan for another destination, commit, mode or original input (the version-1 wording). */
function assertSameIdentity(plan: IPlanRecord, identity: ICompanionIdentity): void {
  const d = identity.destination;
  if (plan.destination.owner !== d.owner || plan.destination.repo !== d.repo || plan.destination.pullNumber !== d.pullNumber) {
    throw mismatch(identity.statePath, 'destination');
  }
  if (plan.reviewedCommit !== identity.reviewedCommit) throw mismatch(identity.statePath, 'reviewed commit');
  const recorded: PublicationMode = plan.submit ? 'submitted' : 'draft';
  const requested: PublicationMode = identity.submit ? 'submitted' : 'draft';
  if (recorded !== requested) throw modeMismatch(identity.statePath, recorded, requested);
  if (plan.inputFingerprint !== identity.inputFingerprint) throw mismatch(identity.statePath, 'original input');
}

/** The authenticated account's numeric id (user/PAT authentication). */
async function authenticatedUserId(transport: ICompanionTransport): Promise<number> {
  const user = await transport.getAuthenticatedUser();
  if (!isPlainObject(user) || !isPositiveInteger(user['id'])) throw new TypeError('The transport did not report a numeric authenticated user id.');
  return user['id'];
}

// ---------------------------------------------------------------------------
// The steps

/** One invocation's work on one plan. */
class Publication {
  private readonly fs: IPublicationFs;
  private readonly identity: ICompanionIdentity;
  readonly plan: IPlanRecord;
  private author: number | null;
  readonly established: IEstablished[];

  constructor(fs: IPublicationFs, identity: ICompanionIdentity, plan: IPlanRecord, author: number | null) {
    this.fs = fs;
    this.identity = identity;
    this.plan = plan;
    this.author = author;
    this.established = plan.suggestions.map((_, i) => ({ suggestion: i + 1, branch: null, pull: null }));
  }

  get transport(): ICompanionTransport {
    return this.identity.transport;
  }

  /** The caller's state path: the plan's own file. */
  get statePath(): string {
    return this.identity.statePath;
  }

  get where(): { readonly owner: string; readonly repo: string } {
    return { owner: this.plan.destination.owner, repo: this.plan.destination.repo };
  }

  /** Requires the plan's author before the first request that sends or investigates. */
  async requireAuthor(): Promise<void> {
    if (this.author === null) this.author = await authenticatedUserId(this.transport);
    if (this.author !== this.plan.authorId) throw mismatch(this.identity.statePath, 'authenticated author');
  }

  suggestion(index: number): IPlanSuggestion {
    const s = this.plan.suggestions[index];
    if (s === undefined) throw new Error(`Internal error: the plan has no suggestion ${String(index + 1)}.`);
    return s;
  }

  readStep<S extends StepRecord>(index: number, step: S['step']): S | undefined {
    const filePath = stepPath(this.identity.statePath, index, step);
    const record = readJsonFile(this.fs, filePath, 'The step record');
    if (record === undefined) return undefined;
    const id = this.suggestion(index).id;
    if (!isStep<S>(record, this.plan, id, step)) {
      throw new PublicationStateError('state-corrupt',
        `Publication state at ${filePath} is not a valid record (${String(stepProblem(record, this.plan, id, step))}); it is not treated as absent.`);
    }
    return record;
  }

  /** Claims a step exclusively with its intent; false when another invocation claimed it first. */
  claim(index: number, record: StepRecord): boolean {
    return claimNewFile(this.fs, stepPath(this.identity.statePath, index, record.step), serialize(record), 'step intent');
  }

  settle(index: number, record: StepRecord): void {
    replaceFileDurably(this.fs, stepPath(this.identity.statePath, index, record.step), serialize(record), 'step receipt');
  }

  /**
   * Whether this call may still create something for a suggestion: some
   * suggestion's steps are not all complete, and no step was refused (a
   * recorded refusal ends the publication). Read from the local records only.
   */
  hasSuggestionWorkLeft(): boolean {
    const steps: readonly StepName[] = ['branch', 'pull', 'labels'];
    const refused = this.plan.suggestions.some((_, index) => steps.some((step) => this.readStep(index, step)?.phase === 'rejected'));
    return !refused && this.plan.suggestions.some((_, index) => this.readStep<ILabelsStep>(index, 'labels')?.phase !== 'completed');
  }

  base(index: number): IStepBase {
    return { format: STEP_FORMAT, version: RECORD_VERSION, publication: this.plan.publication, suggestion: this.suggestion(index).id };
  }

  /** A record of the host's refusal, and the outcome that stops the publication. */
  rejected(index: number, record: StepRecord, err: { readonly status: number; readonly message?: unknown }, what: string): Settled<never> {
    const message = boundedRejectionMessage(err);
    this.settle(index, { ...record, phase: 'rejected', rejection: { status: err.status, message } });
    return { done: false, outcome: this.rejectedOutcome(record.step, index, err.status, message, what, 'response') };
  }

  rejectedOutcome(step: StepName, index: number, status: number, message: string, what: string, via: 'response' | 'record'): ICompanionRejected {
    return {
      status: 'rejected',
      step,
      suggestion: index + 1,
      httpStatus: status,
      via,
      detail: refusalSentence(`GitHub refused to ${what}`, status, message),
      established: this.established,
    };
  }

  uncertain(step: CompanionStep, index: number, detail: string, cause?: unknown): Settled<never> {
    return {
      done: false,
      outcome: { status: 'uncertain', step, suggestion: index + 1, detail, established: this.established, ...(cause === undefined ? {} : { cause }) },
    };
  }

  lookupFailed(step: StepName, index: number, what: string, err: unknown): Settled<never> {
    return this.uncertain(step, index,
      `Could not read ${what} (${String(thrownMessage(err))}). Nothing is concluded from a failed lookup; this state path never sends that step again.`, err);
  }

  // -------------------------------------------------------------------------

  /** The proposal branch, created once and verified at its commit. */
  async branch(index: number): Promise<Settled<string>> {
    const s = this.suggestion(index);
    const what = `the proposal branch \`${s.branch}\` for suggestion ${String(index + 1)}`;
    let record = this.readStep<IBranchStep>(index, 'branch');
    let sendCause: unknown;
    if (record === undefined) {
      await this.requireAuthor();
      const { commit } = await this.transport.createProposalCommit({
        ...this.where, parent: this.plan.reappliedOnto ?? this.plan.reviewedCommit, message: s.commitMessage, changes: s.changes,
      });
      const intent: IBranchStep = { ...this.base(index), step: 'branch', commit, phase: 'sending' };
      if (this.claim(index, intent)) {
        try {
          await this.transport.createBranch({ ...this.where, branch: s.branch, commit });
        } catch (err) {
          if (isHostRejection(err)) return this.rejected(index, intent, err, `create ${what}`);
          sendCause = err;
        }
      }
      record = this.readStep<IBranchStep>(index, 'branch');
      if (record === undefined) throw new PublicationStateError('state-io', `The branch step of suggestion ${String(index + 1)} vanished.`);
    }
    if (record.phase === 'completed') {
      this.established[index] = { suggestion: index + 1, branch: s.branch, pull: null };
      return { done: true, value: record.commit };
    }
    if (record.phase === 'rejected') {
      const { status, message } = record.rejection ?? { status: 0, message: '' };
      return { done: false, outcome: this.rejectedOutcome('branch', index, status, message, `create ${what}`, 'record') };
    }
    await this.requireAuthor();
    let head: string | null;
    try {
      head = await this.transport.getBranch({ ...this.where, branch: s.branch });
    } catch (err) {
      return this.lookupFailed('branch', index, what, err);
    }
    if (head === null) {
      return this.uncertain('branch', index,
        `${capitalize(what)} is not visible on GitHub. Its creation may not have reached GitHub or may not be visible yet, or a person may have deleted it. This state path never creates it again.`,
        sendCause);
    }
    if (head !== record.commit) {
      return this.uncertain('branch', index,
        `${capitalize(what)} points at ${head}, not at the proposal commit ${record.commit}; a person may have changed it. It is never overwritten.`, sendCause);
    }
    this.settle(index, { ...record, phase: 'completed' });
    this.established[index] = { suggestion: index + 1, branch: s.branch, pull: null };
    return { done: true, value: record.commit };
  }

  /** The suggestion pull request, created once from an unchanged branch and verified by its marker. */
  async pull(index: number, commit: string): Promise<Settled<{ readonly number: number; readonly htmlUrl: string }>> {
    const s = this.suggestion(index);
    const label = `suggestion ${String(index + 1)}`;
    let record = this.readStep<IPullStep>(index, 'pull');
    let sendCause: unknown;
    let responseNumber: number | undefined;
    if (record === undefined) {
      await this.requireAuthor();
      const head = await this.transport.getBranch({ ...this.where, branch: s.branch });
      if (head !== commit) {
        return this.uncertain('pull', index,
          `The proposal branch \`${s.branch}\` for ${label} no longer points at the proposed commit ${commit} (a person may have changed or deleted it). `
          + 'No suggestion pull request is created from it, and it is never recreated, reset or force-pushed.');
      }
      const intent: IPullStep = { ...this.base(index), step: 'pull', phase: 'sending' };
      if (this.claim(index, intent)) {
        try {
          responseNumber = (await this.transport.createPullRequest({
            ...this.where, title: s.title, head: s.branch, base: this.plan.headRef, body: s.body, draft: !this.plan.ready,
          })).number;
        } catch (err) {
          if (isHostRejection(err)) return this.rejected(index, intent, err, `create the suggestion pull request for ${label} from \`${s.branch}\``);
          sendCause = err;
        }
      }
      record = this.readStep<IPullStep>(index, 'pull');
      if (record === undefined) throw new PublicationStateError('state-io', `The pull request step of ${label} vanished.`);
    }
    if (record.phase === 'completed' && record.receipt) {
      this.established[index] = { suggestion: index + 1, branch: s.branch, pull: record.receipt };
      return { done: true, value: record.receipt };
    }
    if (record.phase === 'rejected') {
      const { status, message } = record.rejection ?? { status: 0, message: '' };
      return { done: false, outcome: this.rejectedOutcome('pull', index, status, message, `create the suggestion pull request for ${label} from \`${s.branch}\``, 'record') };
    }
    await this.requireAuthor();
    let listed: readonly IBranchPullRequest[];
    try {
      listed = await this.transport.listBranchPullRequests({ ...this.where, branch: s.branch });
    } catch (err) {
      return this.lookupFailed('pull', index, `the pull requests from \`${s.branch}\``, err);
    }
    const marker = formatSuggestionMarker({
      ...this.where, pullNumber: this.plan.destination.pullNumber, id: s.id, batch: this.plan.publication, reviewedCommit: this.plan.reviewedCommit,
      ...(this.plan.reappliedOnto === undefined ? {} : { reappliedOnto: this.plan.reappliedOnto }),
    });
    const byNumber = new Map<number, IBranchPullRequest>();
    for (const pr of listed) {
      if (typeof pr.body === 'string' && pr.body.split(/\r?\n/).includes(marker)) byNumber.set(pr.number, pr);
    }
    const candidates = [...byNumber.values()];
    const [candidate] = candidates;
    if (candidate === undefined) {
      return this.uncertain('pull', index,
        `No pull request from the proposal branch \`${s.branch}\` carries ${label}'s marker. The suggestion pull request may not be visible yet, its creation may not have reached GitHub, or a person may have removed the marker. This state path never creates it again.`,
        sendCause);
    }
    if (candidates.length > 1) {
      return this.uncertain('pull', index, `More than one pull request carries ${label}'s marker (${candidates.map((c) => `#${String(c.number)}`).join(', ')}); none is chosen automatically.`);
    }
    const sameRepository = typeof candidate.headRepository === 'string'
      && candidate.headRepository.toLowerCase() === `${this.where.owner}/${this.where.repo}`.toLowerCase();
    if (candidate.authorId !== this.plan.authorId || candidate.headRef !== s.branch || !sameRepository || candidate.baseRef !== this.plan.headRef
      || (responseNumber !== undefined && responseNumber !== candidate.number)) {
      return this.uncertain('pull', index,
        `Pull request #${String(candidate.number)} carries ${label}'s marker but has another author, head or base than this publication created, or the create response named another pull request. It is neither used nor repaired; inspect it on GitHub.`);
    }
    if (!isNonEmptyString(candidate.htmlUrl)) return this.lookupFailed('pull', index, `pull request #${String(candidate.number)}`, new Error('it has no URL'));
    const receipt = { number: candidate.number, htmlUrl: candidate.htmlUrl };
    this.settle(index, { ...record, phase: 'completed', receipt });
    this.established[index] = { suggestion: index + 1, branch: s.branch, pull: receipt };
    return { done: true, value: receipt };
  }

  /** Every planned label on the suggestion pull request, added once in one request and verified. */
  async labels(index: number, number: number): Promise<Settled<null>> {
    const names = this.plan.labels.map((label) => `\`${label}\``).join(', ');
    const what = `label${this.plan.labels.length === 1 ? '' : 's'} ${names} on suggestion pull request #${String(number)}`;
    let record = this.readStep<ILabelsStep>(index, 'labels');
    let sendCause: unknown;
    if (record === undefined) {
      await this.requireAuthor();
      const intent: ILabelsStep = { ...this.base(index), step: 'labels', number, phase: 'sending' };
      if (this.claim(index, intent)) {
        try {
          await this.transport.addLabels({ ...this.where, number, labels: this.plan.labels });
        } catch (err) {
          if (isHostRejection(err)) return this.rejected(index, intent, err, `add the ${what}`);
          sendCause = err;
        }
      }
      record = this.readStep<ILabelsStep>(index, 'labels');
      if (record === undefined) throw new PublicationStateError('state-io', `The labels step of suggestion ${String(index + 1)} vanished.`);
    }
    if (record.phase === 'completed') return { done: true, value: null };
    if (record.phase === 'rejected') {
      const { status, message } = record.rejection ?? { status: 0, message: '' };
      return { done: false, outcome: this.rejectedOutcome('labels', index, status, message, `add the ${what}`, 'record') };
    }
    await this.requireAuthor();
    let present: readonly string[];
    try {
      present = await this.transport.listLabels({ ...this.where, number: record.number });
    } catch (err) {
      return this.lookupFailed('labels', index, `the labels of suggestion pull request #${String(record.number)}`, err);
    }
    // GitHub label names are unique case-insensitively.
    const carried = new Set(present.map((name) => name.toLowerCase()));
    const missing = this.plan.labels.filter((label) => !carried.has(label.toLowerCase()));
    if (missing.length > 0) {
      const list = missing.map((label) => `\`${label}\``).join(', ');
      return this.uncertain('labels', index,
        `Suggestion pull request #${String(record.number)} does not carry the label${missing.length === 1 ? '' : 's'} ${list}. Their application may not be visible yet or may not have reached GitHub, or a person may have removed them. This state path never applies them again.`,
        sendCause);
    }
    this.settle(index, { ...record, phase: 'completed' });
    return { done: true, value: null };
  }
}

/** Runs every step in order: per suggestion its branch, pull request and labels; then the review. */
async function drive(publication: Publication): Promise<StepsOutcome> {
  const pulls: { readonly number: number; readonly htmlUrl: string }[] = [];
  for (const index of publication.plan.suggestions.keys()) {
    const branch = await publication.branch(index);
    if (!branch.done) return branch.outcome;
    const pull = await publication.pull(index, branch.value);
    if (!pull.done) return pull.outcome;
    const labelled = await publication.labels(index, pull.value.number);
    if (!labelled.done) return labelled.outcome;
    pulls.push(pull.value);
  }
  return review(publication, pulls);
}

/** The review, published by the version-1 core at `<statePath>.review` once every suggestion exists. */
async function review(publication: Publication, pulls: readonly { readonly number: number; readonly htmlUrl: string }[]): Promise<StepsOutcome> {
  const { plan } = publication;
  const identity = {
    destination: plan.destination,
    reviewedCommit: plan.reviewedCommit,
    inputFingerprint: plan.inputFingerprint,
    statePath: `${publication.statePath}.review`,
    transport: publication.transport,
    submit: plan.submit,
  };
  let result = await recoverPublication(identity);
  if (result.status === 'missing') {
    const target: ISuggestionContext = {
      ...plan.destination, reviewedCommit: plan.reviewedCommit, headRef: plan.headRef, ready: plan.ready,
      ...(plan.reappliedOnto === undefined ? {} : { reappliedOnto: plan.reappliedOnto }),
    };
    const body = renderReviewBody({ companions: plan.suggestions, sections: plan.review.sections }, pulls.map((p) => p.number), target);
    result = await publishPreparedReview({ ...identity, preparedReview: { body, comments: plan.review.comments } });
  }
  const suggestions = plan.suggestions.map((s, i) => {
    const pull = pulls[i];
    if (pull === undefined) throw new Error(`Internal error: suggestion ${String(i + 1)} has no pull request.`);
    return { number: pull.number, htmlUrl: pull.htmlUrl, branch: s.branch };
  });
  switch (result.status) {
    case 'published':
      return {
        status: 'published', review: result.review, via: result.via, receiptPersisted: result.receiptPersisted, suggestions,
        headRef: plan.headRef, labels: plan.labels, ready: plan.ready, ...(plan.reappliedOnto === undefined ? {} : { reappliedOnto: plan.reappliedOnto }),
      };
    case 'uncertain':
      return { status: 'uncertain', step: 'review', detail: result.detail, established: publication.established, ...(result.cause === undefined ? {} : { cause: result.cause }) };
    case 'rejected':
      return { status: 'rejected', step: 'review', httpStatus: result.httpStatus, via: result.via, detail: result.detail, established: publication.established };
  }
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
