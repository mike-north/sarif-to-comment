/**
 * publishSarifReview: publishes a ready SARIF document as one GitHub review —
 * a draft by default, or, on explicit request, a submitted comment review
 * (docs/submitted-review-contract.md) — (the fifth public operation; the
 * package entry re-exports it).
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
 *   options?: { ignoreApprovalHold?: boolean,  // bypasses only an approval hold
 *               submit?: boolean,              // true: create the review
 *                                              // submitted, event COMMENT;
 *                                              // part of the publication
 *                                              // identity (never inferred)
 *               allowSuggestionPullRequests?: boolean,     // suggestion pull
 *               pullRequestLabels?: string[],              // requests (docs/
 *               markSuggestionPullRequestsReady?: boolean, // companion-
 *                                              // suggestion-pr-contract.md §2.2)
 *               presentation?: { finding?, attribution?, alternatives?,
 *                 fileAddition?, fileDeletion?, lifecycleNote? } }
 *                                              // Markdown callbacks of named
 *                                              // presentation components
 *                                              // (src/presentation/
 *                                              // customization.cts); not part
 *                                              // of the publication identity
 *
 * Outcome — the consumer contract is `status`, human-readable `markdown`, the
 * listed identifiers and `diagnostics` (D45): every outcome lists its errors,
 * warnings and notes in that order. Evidence is not part of it.
 *   { status: 'published', review: { id, url }, suggestions?, statePath, markdown, diagnostics }
 *       // suggestions: [{ number, url, branch }], only when suggestion pull
 *       // requests were created
 *   { status: 'blocked', markdown }        // nothing was written anywhere
 *   { status: 'uncertain', statePath, markdown }
 *       // delivery could not be confirmed; markdown names the preserved
 *       // state path, says to retry with the same path and not to delete it,
 *       // and that a new path would create a separate review
 *   Preparation's warnings are recorded with the publication (in its state)
 *   and reported by every published or uncertain outcome for it, on the call
 *   that planned it and on every later call alike (issue #42).
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
 *      With suggestion pull requests enabled, the document also holds
 *      suggestionPullRequests: { markReady, pullRequestLabels } (the extra
 *      labels deduplicated, in the order given); disabled, it is exactly as
 *      above.
 *   3. When the state path holds a companion publication plan
 *      (src/companion-publication.cts), continue it: identity checks, then
 *      only the steps it still lacks. Otherwise recoverPublication with only
 *      that identity — before any branch or source work. A completed receipt
 *      or a known refusal returns without network; an existing sending
 *      intent is investigated with its saved request and is never
 *      re-prepared or re-sent.
 *   4. Only when no state exists: fetch the review context, verify it is for
 *      exactly this pull request and reviewed commit, prepare the whole
 *      review, and return `blocked` (no remote write, no state file), call
 *      publishPreparedReview exactly once, or — when the review needs
 *      suggestion pull requests — start the companion publication.
 *
 * internals (private seam, not caller API):
 *   createGitHubClient({ token, fetch }) -> client with the publication
 *     transport methods and fetchContext({ destination, reviewedCommit,
 *     oldSourceCommit? }) -> { context, readSource, fileExists }, and — for
 *     suggestion pull requests — the companion transport of src/github.cts.
 *     Defaults to src/github.cts.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { continueCompanionPublication, hasCompanionPlan, startCompanionPublication } from './companion-publication.cjs';
import type { BaseCheck, CompanionOutcome, ICompanionTransport, IEstablished } from './companion-publication.cjs';
import { createGitHubClient as defaultCreateGitHubClient } from './github.cjs';
import type { ICreateGitHubClientOptions } from './github.cjs';
import { listWarnings } from './prepare-review.cjs';
import type { IReviewPresentation } from './presentation/customization.cjs';
import { publishPreparedReview, recoverPublication } from './publication.cjs';
import {
  blockedReviewMarkdown,
  blockedReviewReport,
  captureReviewInput,
  destinationLabel,
  labelList,
  prepareForDestination,
  redact,
  templateText,
  warningsHeadline,
  withoutCredential,
} from './review-preflight.cjs';
import type { ICapturedReview, IContextClient, IReported, IReviewInputSpec } from './review-preflight.cjs';
import type { IJsonObject, JsonValue } from './sarif-common.cjs';
import { createDiagnostic, mapDiagnosticText, orderDiagnostics } from './diagnostics.cjs';
import type { IDiagnostic } from './diagnostics.cjs';

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
 * Options that change how a document is judged or published. Unknown options
 * are refused.
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
  /**
   * Create the review already submitted, as a comment review (GitHub's
   * `COMMENT` event), instead of leaving a draft. Omitted or `false` leaves a
   * draft. It never approves or requests changes, and nothing is inferred
   * from finding severity. Every readiness check and approval hold applies
   * unchanged. The mode is part of the publication identity: a state path is
   * always retried with the mode it started with.
   */
  readonly submit?: boolean | undefined;
  /**
   * Allow suggestion pull requests: whole-file creations and deletions, a
   * fix with several changes, and explicitly grouped changes
   * (`properties.sarifToComment.suggestionGroup`, written by
   * {@link groupSarifFixes}) are proposed as pull requests into the pull
   * request's head branch, which the review links. They follow the
   * tool-neutral suggestion pull request convention and carry the
   * repository's canonical label: the `label` of `.github/suggestion-prs.json`
   * on the default branch, otherwise `suggestion-pr`. Omitted or `false`:
   * disabled; creations and deletions are shown in the review body, and a
   * grouped document or a fix with several changes is refused, naming this
   * option. Small edits stay native suggestions either way. Part of the
   * publication identity.
   */
  readonly allowSuggestionPullRequests?: boolean | undefined;
  /**
   * Extra labels every suggestion pull request carries in addition to the
   * canonical label, for example a team or campaign tag. Deduplicated
   * case-insensitively, so listing the canonical label is harmless. Each
   * must already exist (a missing one blocks the review; labels are never
   * created) and be 1-50 characters without commas, control or invisible
   * formatting characters or surrounding whitespace. Allowed only with
   * `allowSuggestionPullRequests: true`. Part of the publication identity.
   */
  readonly pullRequestLabels?: readonly string[] | undefined;
  /**
   * Create suggestion pull requests ready for review instead of as drafts
   * (the default). A draft cannot be merged until someone with write access
   * marks it ready. Allowed only with `allowSuggestionPullRequests: true`.
   * Part of the publication identity.
   */
  readonly markSuggestionPullRequestsReady?: boolean | undefined;
  /**
   * Your own Markdown for named review elements: a finding, its attribution
   * and alternatives, a proposed new file or file deletion, and a suggestion
   * pull request's lifecycle note. Each callback receives the element's data,
   * its built-in Markdown and the fragments your result must keep; omitted
   * elements keep the built-in presentation. See {@link IReviewPresentation}
   * for what the tool keeps regardless (markers, suggestion blocks, exact
   * proposed content, provenance, size limits) and when a result is refused.
   * Not part of the publication identity, and not available on the command
   * line.
   */
  readonly presentation?: IReviewPresentation | undefined;
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
   * request and create the review. GitHub App installation tokens,
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
 * The review on GitHub.
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
 * A companion suggestion pull request the publication created.
 *
 * @public
 */
export interface IPublishedSuggestion {
  /** The pull request's number. */
  readonly number: number;
  /** Web URL of the pull request. */
  readonly url: string;
  /** Its proposal branch, which targets the reviewed pull request's head branch. */
  readonly branch: string;
}

/**
 * The publication is complete: the review (a draft, or a submitted comment
 * review when `options.submit` was set) was created and confirmed now,
 * confirmed after an earlier uncertain attempt, or recorded as complete in
 * the state file by an earlier call.
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
  /**
   * The suggestion pull requests created with the review, in the order the
   * review presents them. Present only when there are any.
   */
  readonly suggestions?: readonly IPublishedSuggestion[];
  /** The state file recording this publication. */
  readonly statePath: string;
  /** Human-readable explanation, including the review link. */
  readonly markdown: string;
  /**
   * Warnings and notes about this publication: preparation's warnings (for
   * example a finding published in the review body, or a whole-file
   * proposal presented in the body because no suggestion pull request could
   * be made for it), a completion that could not be recorded, and a branch
   * that moved while suggestions were created. Preparation's warnings are
   * recorded with the publication, so every call with the same `statePath`
   * reports the same ones. The `markdown` states every warning in a headline
   * under its heading.
   */
  readonly diagnostics: readonly IDiagnostic[];
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
  /** Every blocking problem, then preparation's warnings. */
  readonly diagnostics: readonly IDiagnostic[];
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
  /**
   * Preparation's warnings (recorded with the publication, as for a
   * published outcome), a `delivery-unconfirmed` warning, and any note about
   * the branch.
   */
  readonly diagnostics: readonly IDiagnostic[];
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
  /** A `review-refused` or `suggestion-pr-step-refused` error, and any note about the branch. */
  readonly diagnostics: readonly IDiagnostic[];
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

/**
 * Fingerprint of everything that determines the prepared content (see module
 * doc). Enabled suggestion pull requests, their extra labels and their ready
 * setting change what is published, so they are part of it; disabled, the
 * identity document is exactly what it always was.
 */
function inputFingerprintOf(captured: ICapturedInput): string {
  const identity: IJsonObject = {
    format: INPUT_FORMAT,
    version: INPUT_VERSION,
    sarif: captured.sarif,
    sourceRootUri: captured.sourceRootUri ?? null,
    oldSourceCommit: captured.oldSourceCommit ?? null,
    ...(captured.suggestionPullRequests === undefined
      ? {}
      : {
          suggestionPullRequests: {
            markReady: captured.suggestionPullRequests.markReady,
            pullRequestLabels: [...captured.suggestionPullRequests.pullRequestLabels],
          },
        }),
  };
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Markdown presentation
// ---------------------------------------------------------------------------

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

/** How the published explanation names each publication mode (contract §2.7). */
interface IModeWording {
  readonly heading: string;
  /** The review's description in the recovered and receipt sentences. */
  readonly noun: string;
  /** The sentence for a review created now. */
  readonly created: (link: string, where: string) => string;
}

const MODE_WORDING: Readonly<Record<'draft' | 'submitted', IModeWording>> = {
  draft: {
    heading: '## Draft review published',
    noun: 'draft',
    created: (link, where) => `Created the draft ${link} on ${where}. It stays a draft until someone submits it on GitHub.`,
  },
  submitted: {
    heading: '## Review submitted',
    noun: 'submitted comment',
    created: (link, where) => `Created and submitted the comment ${link} on ${where}. It is visible on the pull request now.`,
  },
};

/** What the published explanation needs from a verified delivery. */
type DeliveredReview = Pick<PublishedResult, 'via' | 'receiptPersisted'> & { readonly review: { readonly id: number; readonly htmlUrl: string } };

// Each report is rendered in full for the outcome's `markdown` and, with
// `full` false, as the CLI's human report (IReported): the same text without
// what the outcome's diagnostics already say (problems, warnings, the detail
// of a failure), which the CLI renders once, on stderr.

/**
 * The section a full report ends with for preparation's warnings, as Markdown
 * lines; none without warnings. The same on every call for a publication.
 */
function warningsMarkdown(warnings: readonly IDiagnostic[]): string[] {
  return warnings.length === 0 ? [] : ['', listWarnings(warnings)];
}

function publishedMarkdown(
  result: DeliveredReview,
  captured: ICapturedInput,
  warnings: readonly IDiagnostic[],
  diagnostics: readonly IDiagnostic[],
  full = true,
): string {
  const link = `[review ${String(result.review.id)}](${result.review.htmlUrl})`;
  const where = `${destinationLabel(captured)} at commit ${code(captured.reviewedCommit)}`;
  // A record is only ever continued in the mode it was started with, so the
  // requested mode is the mode of the review being reported.
  const wording = MODE_WORDING[captured.submit === true ? 'submitted' : 'draft'];
  const headline = warningsHeadline(diagnostics, 'published');
  const lines = [wording.heading, '', ...(headline === undefined ? [] : [headline, ''])];
  if (result.via === 'receipt') {
    lines.push(`The ${wording.noun} ${link} on ${where} was already published; its completion is recorded at ${code(captured.statePath)}. Nothing was sent.`);
  } else if (result.via === 'recovered') {
    lines.push(`The ${wording.noun} ${link} on ${where} was confirmed on GitHub for this publication; nothing was resent.`);
  } else {
    lines.push(wording.created(link, where));
  }
  if (full && !result.receiptPersisted) {
    lines.push(
      '',
      `Completion could not be recorded at ${code(captured.statePath)}. Keep that file: a later run with the same state path confirms the review without sending it again.`,
    );
  }
  if (full) lines.push(...warningsMarkdown(warnings));
  return lines.join('\n');
}

function uncertainMarkdown(result: UncertainResult, captured: ICapturedInput, full = true): string {
  return [
    '## Delivery could not be confirmed',
    '',
    ...(full ? [result.detail, ''] : []),
    `The publication state is preserved at ${code(captured.statePath)}.`,
    '',
    '- Retry later with the same state path: it only checks GitHub for this review and never sends it again.',
    '- Do not delete that file: it is the only record that this review may already exist.',
    '- A new state path starts a new, separate review; use one only if you intend a separate review.',
    ...(full ? warningsMarkdown(result.warnings) : []),
  ].join('\n');
}

function rejectedMarkdown(result: RejectedResult, captured: ICapturedInput, full = true): string {
  const lines = [
    '## GitHub refused the review',
    '',
    ...(full ? [result.detail, ''] : []),
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

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * A published outcome's diagnostics: preparation's warnings (recorded with
 * the publication, so the same on every call for it; issue #42), a
 * completion that could not be recorded, and what a retry found about the
 * branch.
 */
function publishedDiagnostics(
  result: Pick<PublishedResult, 'receiptPersisted' | 'warnings'>,
  captured: ICapturedInput,
  baseCheck?: BaseCheck,
): IDiagnostic[] {
  const unrecorded = result.receiptPersisted
    ? []
    : [createDiagnostic('publication-receipt-not-recorded', `Completion could not be recorded at ${code(captured.statePath)}.`, { subject: captured.statePath })];
  return orderDiagnostics([...result.warnings, ...unrecorded, ...baseCheckDiagnostics(baseCheck, captured)]);
}

/**
 * An uncertain outcome's diagnostics: preparation's warnings (the review may
 * exist, and they describe it), then the delivery that could not be
 * confirmed, as a warning about the pull request, and any note about the
 * branch.
 */
function uncertainDiagnostics(
  warnings: readonly IDiagnostic[],
  detail: string,
  captured: ICapturedInput,
  baseCheck?: BaseCheck,
): IDiagnostic[] {
  const unconfirmed = createDiagnostic('delivery-unconfirmed', detail, { subject: destinationLabel(captured) });
  return orderDiagnostics([...warnings, unconfirmed, ...baseCheckDiagnostics(baseCheck, captured)]);
}

/** GitHub's definitive refusal of the review or of a suggestion pull request step, as an error about the pull request. */
function rejectedDiagnostics(detail: string, step: 'review' | 'suggestion', captured: ICapturedInput, baseCheck?: BaseCheck): IDiagnostic[] {
  const refused = createDiagnostic(step === 'review' ? 'review-refused' : 'suggestion-pr-step-refused', detail, { subject: destinationLabel(captured) });
  return orderDiagnostics([refused, ...baseCheckDiagnostics(baseCheck, captured)]);
}

/**
 * The public outcome for a publication-core result. Preparation's warnings
 * come from the result, which reads them from the record, so every call for
 * a publication reports the same ones.
 */
function present(result: PublicationResult, captured: ICapturedInput): IReported<PublishSarifReviewOutcome> {
  const { statePath } = captured;
  switch (result.status) {
    case 'published': {
      const diagnostics = publishedDiagnostics(result, captured);
      return {
        outcome: {
          status: 'published',
          review: { id: result.review.id, url: result.review.htmlUrl },
          statePath,
          markdown: publishedMarkdown(result, captured, result.warnings, diagnostics),
          diagnostics,
        },
        report: publishedMarkdown(result, captured, result.warnings, diagnostics, false),
      };
    }
    case 'uncertain':
      return {
        outcome: {
          status: 'uncertain',
          statePath,
          markdown: uncertainMarkdown(result, captured),
          diagnostics: uncertainDiagnostics(result.warnings, result.detail, captured),
        },
        report: uncertainMarkdown(result, captured, false),
      };
    case 'rejected':
      return {
        outcome: { status: 'rejected', statePath, markdown: rejectedMarkdown(result, captured), diagnostics: rejectedDiagnostics(result.detail, 'review', captured) },
        report: rejectedMarkdown(result, captured, false),
      };
    default: {
      // Unreachable for the typed publication core; kept as the durable
      // refusal to present a status this module does not know.
      const unexpected: { readonly status: unknown } = result;
      throw new Error(`Unexpected publication status ${templateText(unexpected.status)}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Companion suggestion pull requests (docs/companion-suggestion-pr-contract.md)
// ---------------------------------------------------------------------------

/** The client methods a companion publication calls, beyond the review context. */
const COMPANION_METHODS: readonly string[] = [
  'getAuthenticatedUser', 'createReview', 'listReviews', 'listReviewComments', 'createProposalCommit', 'getBranch',
  'createBranch', 'createPullRequest', 'listBranchPullRequests', 'addLabels', 'listLabels',
];

/**
 * Whether a client provides every companion method. Only their presence can
 * be checked; each answer is validated where it is used.
 */
function isCompanionTransport(client: object): client is ICompanionTransport {
  return COMPANION_METHODS.every((method) => typeof Reflect.get(client, method) === 'function');
}

function companionTransport(client: object): ICompanionTransport {
  if (!isCompanionTransport(client)) throw new Error('This GitHub client cannot publish suggestion pull requests.');
  return client;
}

/** What is already on GitHub when a companion publication stops, as Markdown lines. */
function establishedMarkdown(established: readonly IEstablished[]): string[] {
  const lines = established.flatMap((e) => {
    if (e.pull !== null) return [`- Suggestion ${String(e.suggestion)}: [pull request #${String(e.pull.number)}](${e.pull.htmlUrl}) from ${code(e.branch ?? '')}`];
    if (e.branch !== null) return [`- Suggestion ${String(e.suggestion)}: proposal branch ${code(e.branch)} (no pull request yet)`];
    return [];
  });
  return lines.length === 0 ? [] : ['Already on GitHub for this publication:', '', ...lines, ''];
}

/**
 * On a retry, the paragraph saying the branch changed since the suggestions
 * were planned, or that this could not be read (contract §2.10), as Markdown
 * lines; none otherwise.
 */
function baseCheckMarkdown(check: BaseCheck | undefined, captured: ICapturedInput): string[] {
  if (check === undefined) return [];
  const [lead, rest] = baseCheckText(check, captured);
  return [`**${lead}:** ${rest}`, ''];
}

/** The lead and the rest of the base-check paragraph (contract §2.10). */
function baseCheckText(check: BaseCheck, captured: ICapturedInput): readonly [lead: string, rest: string] {
  const pull = `#${String(captured.destination.pullNumber)}`;
  return check.kind === 'changed'
    ? [`The branch of ${pull} changed since these suggestions were planned`, `they are based on commit ${code(check.base)}, which is no longer part of it `
      + `(its head is now ${code(check.head)}). The suggestion pull requests still to be created are created on that commit, as planned; nothing is re-decided.`]
    : [`Whether the branch of ${pull} changed since these suggestions were planned is not known`, `they are based on commit ${code(check.base)}, `
      + `and the branch could not be read (${check.detail}). Nothing is re-decided.`];
}

/** The base-check paragraph as a diagnostic: a note that the branch moved, or a warning that it could not be read. */
function baseCheckDiagnostics(check: BaseCheck | undefined, captured: ICapturedInput): IDiagnostic[] {
  if (check === undefined) return [];
  const [lead, rest] = baseCheckText(check, captured);
  const message = `${lead}: ${rest}`;
  const subject = destinationLabel(captured);
  return [createDiagnostic(check.kind === 'changed' ? 'suggestion-branch-moved' : 'suggestion-branch-unreadable', message, { subject })];
}

function presentCompanion(outcome: CompanionOutcome, captured: ICapturedInput): IReported<PublishSarifReviewOutcome> {
  const { statePath } = captured;
  switch (outcome.status) {
    case 'published': {
      const suggestions = outcome.suggestions.map((s) => ({ number: s.number, url: s.htmlUrl, branch: s.branch }));
      const listed = suggestions.map((s) => `- [#${String(s.number)}](${s.url}) from ${code(s.branch)}`);
      const form = outcome.ready ? `ready for review, into ${code(outcome.headRef)}` : `drafts into ${code(outcome.headRef)}`;
      const reapplied = outcome.reappliedOnto === undefined ? '' : `, re-applied onto commit ${code(outcome.reappliedOnto)}`;
      const diagnostics = publishedDiagnostics(outcome, captured, outcome.baseCheck);
      const text = (full: boolean): string => [
        publishedMarkdown(outcome, captured, outcome.warnings, diagnostics, full),
        '',
        ...(full ? baseCheckMarkdown(outcome.baseCheck, captured) : []),
        `Suggestion pull requests (${form}, labeled ${labelList(outcome.labels)}${reapplied}):`,
        '',
        ...listed,
      ].join('\n');
      return {
        outcome: {
        status: 'published',
        review: { id: outcome.review.id, url: outcome.review.htmlUrl },
        suggestions,
        statePath,
        markdown: text(true),
        diagnostics,
        },
        report: text(false),
      };
    }
    case 'uncertain': {
      const text = (full: boolean): string => [
        '## Delivery could not be confirmed',
        '',
        ...(full ? [outcome.detail, '', ...baseCheckMarkdown(outcome.baseCheck, captured)] : []),
        ...establishedMarkdown(outcome.established),
        `The publication state is preserved at ${code(statePath)} and in the files beside it that share its name.`,
        '',
        '- Retry later with the same state path: it only checks GitHub for work that may already have been sent, never sends it again, and continues with work that was never sent.',
        '- Do not delete those files: they are the only record of what may already exist.',
        '- A new state path starts a new, separate publication; use one only if you intend a separate review.',
        ...(full ? warningsMarkdown(outcome.warnings) : []),
      ].join('\n');
      return {
        outcome: {
          status: 'uncertain',
          statePath,
          markdown: text(true),
          diagnostics: uncertainDiagnostics(outcome.warnings, outcome.detail, captured, outcome.baseCheck),
        },
        report: text(false),
      };
    }
    case 'rejected': {
      const review = outcome.step === 'review';
      const text = (full: boolean): string => [
        review ? '## GitHub refused the review' : '## GitHub refused a suggestion pull request step',
        '',
        ...(full ? [outcome.detail, ''] : []),
        review
          ? `The request is never resent. The refusal is tied to the state path ${code(statePath)}.`
          : `It is never resent, and the review was not published: it would link a suggestion that does not exist. The refusal is tied to the state path ${code(statePath)}.`,
        '',
        ...(full ? baseCheckMarkdown(outcome.baseCheck, captured) : []),
        ...establishedMarkdown(outcome.established),
        'After resolving the cause, publish again with a new state path. Anything already created is left as it is.',
      ].join('\n');
      return {
        outcome: {
          status: 'rejected',
          statePath,
          markdown: text(true),
          diagnostics: rejectedDiagnostics(outcome.detail, review ? 'review' : 'suggestion', captured, outcome.baseCheck),
        },
        report: text(false),
      };
    }
    default: {
      // Unreachable for the typed companion core; kept as the durable
      // refusal to present a status this module does not know.
      const unexpected: { readonly status: unknown } = outcome;
      throw new Error(`Unexpected publication status ${templateText(unexpected.status)}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run(captured: ICapturedInput, createGitHubClient: CreatePublishingClient): Promise<IReported<PublishSarifReviewOutcome>> {
  const client = createGitHubClient({ token: captured.token, fetch: globalThis.fetch });
  const identity = {
    destination: captured.destination,
    reviewedCommit: captured.reviewedCommit,
    inputFingerprint: inputFingerprintOf(captured),
    statePath: captured.statePath,
    transport: client,
    submit: captured.submit === true,
  };

  // A companion plan is continued before anything else: its own identity
  // checks, then only the steps it still lacks.
  if (hasCompanionPlan(captured.statePath)) {
    return presentCompanion(await continueCompanionPublication({ ...identity, transport: companionTransport(client) }), captured);
  }
  const existing = await recoverPublication(identity);
  if (existing.status !== 'missing') return present(existing, captured);

  const prepared = await prepareForDestination(captured, client);
  if (prepared.status === 'blocked') {
    return {
      outcome: { status: 'blocked', markdown: blockedReviewMarkdown(prepared), diagnostics: orderDiagnostics([...prepared.diagnostics, ...prepared.warnings]) },
      report: blockedReviewReport(prepared),
    };
  }

  // Preparation's warnings are recorded with the publication, so that every
  // later call reports them (issue #42); state never holds the credential.
  const warnings = prepared.warnings.map((w) => mapDiagnosticText(w, (text) => redact(text, captured.token)));
  if (prepared.suggestions !== undefined && prepared.suggestionPullRequests !== undefined) {
    const outcome = await startCompanionPublication({
      ...identity,
      transport: companionTransport(client),
      suggestions: prepared.suggestions,
      comments: prepared.review.comments,
      headRef: prepared.suggestionPullRequests.headRef,
      labels: prepared.suggestionPullRequests.labels,
      ready: prepared.suggestionPullRequests.ready,
      ...(prepared.suggestionPullRequests.reappliedOnto === undefined ? {} : { reappliedOnto: prepared.suggestionPullRequests.reappliedOnto }),
      warnings,
    });
    return presentCompanion(outcome, captured);
  }

  const result = await publishPreparedReview({
    ...identity,
    preparedReview: { body: prepared.review.body, comments: prepared.review.comments },
    warnings,
  });
  return present(result, captured);
}

/**
 * Publishes a ready SARIF document as one GitHub review — a draft unless
 * `options.submit` asks for a submitted comment review — or explains why it
 * is blocked, uncertain or refused.
 *
 * @remarks
 * The whole document is validated before anything is written: if any finding
 * cannot be published faithfully, nothing is published. Publication is
 * one-way: the tool never submits an existing draft, and never updates,
 * restores or deletes a review. Retrying with the same `statePath` never creates a second
 * review; an existing record is honoured before any GitHub request for the
 * pull request's source.
 *
 * @param input - The document, destination, reviewed commit, state path and
 * credential.
 * @returns The outcome. `status`, `markdown` and `diagnostics` are the stable
 * contract; each diagnostic's `code` is listed in the package's
 * `docs/diagnostics.md`.
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
  return (await publishSarifReviewReported(input, internals)).outcome;
}

/**
 * {@link publishSarifReview} with the CLI's human report of the outcome
 * (see IReported). Internal: the CLI prints the report in human form.
 */
export async function publishSarifReviewReported(
  input: unknown,
  internals: IPublishSarifReviewInternals = {},
): Promise<IReported<PublishSarifReviewOutcome>> {
  const captured = captureReviewInput(input, PUBLISH_INPUT);
  const createGitHubClient = internals.createGitHubClient || defaultCreateGitHubClient;
  let reported: IReported<PublishSarifReviewOutcome>;
  try {
    reported = await run(captured, createGitHubClient);
  } catch (err) {
    throw withoutCredential(err, captured.token);
  }
  const clean = (text: string): string => redact(text, captured.token);
  const { outcome, report } = reported;
  return {
    outcome: { ...outcome, markdown: clean(outcome.markdown), diagnostics: outcome.diagnostics.map((d) => mapDiagnosticText(d, clean)) },
    report: clean(report),
  };
}
