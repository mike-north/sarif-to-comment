/**
 * publishSarifReview: publishes a ready SARIF document as one GitHub draft
 * review (the fifth public operation; the package entry re-exports it).
 *
 * Publication composes private cores: the GitHub client (src/github.cts),
 * the review preflight shared with readiness assessment
 * (src/review-preflight.cts: input capture, context verification and
 * whole-review preparation) and durable initial publication
 * (src/publication.cts). It adds no rendering, placement or delivery logic
 * of its own; it only sequences, identifies and explains.
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
 * Sequence (steps 1 and 4 up to preparation are the review preflight,
 * src/review-preflight.cts, which readiness assessment runs unchanged):
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
 *     src/github.cts.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { createGitHubClient as defaultCreateGitHubClient } from './github.cjs';
import type { ICreateGitHubClientOptions } from './github.cjs';
import type { IReadyOutcome } from './prepare-review.cjs';
import { publishPreparedReview, recoverPublication } from './publication.cjs';
import {
  blockedReviewMarkdown,
  captureReviewInput,
  destinationLabel,
  prepareForDestination,
  redact,
  templateText,
  withoutCredential,
} from './review-preflight.cjs';
import type { ICapturedReview, IContextClient, IReviewInputSpec } from './review-preflight.cjs';
import type { IJsonObject, JsonValue } from './sarif-common.cjs';

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
 * Creates the GitHub client for one publication; src/github.cts by default.
 * Beyond the review context the preflight uses, the client is the
 * publication transport, which src/publication.cts validates itself.
 */
type CreatePublishingClient = (options: ICreateGitHubClientOptions) => IContextClient;

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
interface ICapturedInput extends ICapturedReview {
  readonly statePath: string;
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

/**
 * Publication's input: the shared review fields (src/review-preflight.cts)
 * plus the durable state path, checked where it always was (after the
 * commits, before the token).
 */
const PUBLISH_INPUT: IReviewInputSpec<{ readonly statePath: string }> = {
  operation: 'publishSarifReview',
  ownKeys: ['statePath'],
  captureOwn: (field, invalid) => {
    const statePath = field('statePath');
    if (typeof statePath !== 'string' || !path.isAbsolute(statePath)) {
      throw invalid('statePath must be an absolute file path chosen by the caller');
    }
    return { statePath };
  },
};

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
// Markdown presentation
// ---------------------------------------------------------------------------

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
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

  const prepared = await prepareForDestination(captured, client);
  if (prepared.status === 'blocked') return { status: 'blocked', markdown: blockedReviewMarkdown(prepared) };

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
  const captured = captureReviewInput(input, PUBLISH_INPUT);
  const createGitHubClient = internals.createGitHubClient || defaultCreateGitHubClient;
  let outcome: PublishSarifReviewOutcome;
  try {
    outcome = await run(captured, createGitHubClient);
  } catch (err) {
    throw withoutCredential(err, captured.token);
  }
  return { ...outcome, markdown: redact(outcome.markdown, captured.token) };
}
