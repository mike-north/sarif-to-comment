/**
 * validateSarifReview: optional whole-review readiness assessment (the sixth
 * public operation; the package entry re-exports it). Contract:
 * docs/readiness-assessment-contract.md.
 *
 * Assessment answers whether a complete SARIF document can be published
 * faithfully to one pull request at one reviewed commit, by running the
 * publisher's own checks and stopping before anything publication-specific:
 *   1. the review preflight (src/review-preflight.cts), exactly as
 *      publishSarifReview runs it — input capture, the verified review
 *      context, whole-review preparation;
 *   2. the publication core's own pre-send checks (src/publication.cts) — the
 *      prepared review's shape and the authenticated account's numeric id;
 *   3. the pending-review check: every page of the destination pull request's
 *      reviews is read, and a PENDING review whose author has the
 *      authenticated account's numeric id blocks, because GitHub refuses to
 *      create another review, draft or submitted, while one exists. Other
 *      accounts' pending reviews and every submitted review are ignored. A
 *      list that cannot be read completely, or whose data leaves the answer
 *      undecided, is incomplete. Publication has no such read: it meets the
 *      same condition as GitHub's refusal of its create request.
 * It computes no publication identity, reads or writes no state, adopts no
 * review by its marker, and sends nothing: GitHub is only read, and no file
 * is written.
 *
 * A `ready` outcome is information, never authority. It carries nothing
 * publication accepts, and publication repeats every check itself against
 * the pull request as it is then. It is also not a delivery promise: the pull
 * request can change before publication (a pending review can be started),
 * and GitHub can refuse the create request for reasons only the write reveals.
 *
 * ---------------------------------------------------------------------------
 * validateSarifReview(input, internals?) -> Promise<Outcome>
 *
 * input: publishSarifReview's input without `statePath` (which is refused as
 *   an unknown field), captured and validated identically; a TypeError
 *   rejects before any request.
 *
 * With suggestion pull requests enabled (docs/companion-suggestion-pr-contract.md
 * §2.8), the preflight's repository and label reads apply unchanged, and a
 * ready assessment says how many draft suggestion pull requests publication
 * would create, into which branch and with which label.
 *
 * Outcome (status, Markdown and the diagnostics are the contract, D45):
 *   { status: 'ready', markdown, diagnostics }      // preparation's warnings
 *   { status: 'blocked', problems, markdown, diagnostics }
 *       // problems: [{ message, pointer?, ...diagnostic fields }], the
 *       // blocking errors; diagnostics: those errors, then the warnings.
 *       // markdown is publication's own blocked explanation; for a pending
 *       // review of the account, the same presentation naming that review
 *   { status: 'incomplete', markdown, diagnostics }  // assessment-incomplete
 *       // an operational failure: anything the GitHub client reports (HTTP,
 *       // network, authentication, source reads, the review list), its
 *       // answer that the account has no numeric id, context for another
 *       // pull request or commit, or a review list that is incomplete or
 *       // undecidable. Never a verdict.
 * Any other failure after capture is a defect in this package or its client
 * boundary (an internal invariant, a client answer outside its contract). It
 * rejects, as publication does, rather than being disguised as a transient
 * condition with retry advice.
 * The token never appears in an outcome.
 *
 * internals (private seam, not caller API):
 *   createGitHubClient({ token, fetch }) -> client with fetchContext,
 *     getAuthenticatedUser and listReviews. Defaults to src/github.cts.
 */

import { createGitHubClient as defaultCreateGitHubClient } from './github.cjs';
import type { ICreateGitHubClientOptions, IListReviewsRequest } from './github.cjs';
import { blockedBy, withoutWarnings } from './prepare-review.cjs';
import { createDiagnostic, mapDiagnosticText, orderDiagnostics, problemOfDiagnostic } from './diagnostics.cjs';
import type { IDiagnostic } from './diagnostics.cjs';
import { authenticatedUserId, readAllPages, validatePreparedReview } from './publication.cjs';
import type { IPublishSarifReviewOptions, IPullRequestDestination } from './publish-sarif-review.cjs';
import type { IProblem } from './public-types.cjs';
import { isPlainObject } from './sarif-common.cjs';
import {
  ReviewContextMismatchError,
  blockedReviewMarkdown,
  blockedReviewReport,
  captureReviewInput,
  destinationLabel,
  labelList,
  messageChain,
  prepareForDestination,
  redact,
  warningsHeadline,
  withoutCredential,
} from './review-preflight.cjs';
import type { ICapturedReview, IContextClient, IDestinationReady, IReadySuggestionPullRequests, IReported, IReviewInputSpec } from './review-preflight.cjs';

// ---------------------------------------------------------------------------
// Public types

/**
 * Input to {@link validateSarifReview}: the input of `publishSarifReview`
 * without a state path. Unknown fields, including `statePath`, are refused.
 *
 * @public
 */
export interface IValidateSarifReviewInput {
  /**
   * The SARIF 2.1.0 log as a parsed JSON object (not text). It is copied when
   * the call starts; later changes to your object have no effect. Values JSON
   * cannot represent are refused rather than dropped.
   */
  readonly sarif: object;
  /** The pull request the review is intended for. */
  readonly destination: IPullRequestDestination;
  /** Full 40-character lowercase commit SHA the review is about. */
  readonly reviewedCommit: string;
  /**
   * GitHub personal access token (or user token) used to read the pull
   * request, its source and the authenticated user. Never included in an
   * outcome or a rejection.
   */
  readonly token: string;
  /** Absolute `file:` URI (ending in `/`) of the repository root in the SARIF producer's file system. */
  readonly sourceRootUri?: string | undefined;
  /** Full commit SHA to use as the diff's old side when GitHub's own comparison cannot establish it; verified, never trusted. */
  readonly oldSourceCommit?: string | undefined;
  /** The same options publication would be given; see {@link IPublishSarifReviewOptions}. */
  readonly options?: IPublishSarifReviewOptions | undefined;
}

/**
 * Publication of this document would proceed to its single create-review
 * request, and the account had no pending review on the pull request.
 * Nothing was published and nothing was written.
 *
 * @remarks
 * This is not an approval and not a delivery promise: publication repeats
 * every check against the pull request as it is then, and GitHub can still
 * refuse the review (for example when the account starts a pending review on
 * the pull request before publication).
 *
 * @public
 */
export interface IReadyAssessment {
  /** Discriminant: the complete document can be published faithfully. */
  readonly status: 'ready';
  /** What publication would create, and what this result does not promise. */
  readonly markdown: string;
  /** Preparation's warnings, if any; a ready assessment has no errors. */
  readonly diagnostics: readonly IDiagnostic[];
}

/**
 * Publication of this document would be blocked, or GitHub would refuse it
 * because the account already has a pending review on the pull request.
 * Nothing was published and nothing was written.
 *
 * @public
 */
export interface IBlockedAssessment {
  /** Discriminant: the document cannot be published faithfully. */
  readonly status: 'blocked';
  /** Every blocking problem, with a pointer into the SARIF document where it has one. */
  readonly problems: readonly IProblem[];
  /** The explanation publication itself gives for this document, or the pending review that stands in the way. */
  readonly markdown: string;
  /** The blocking problems, then preparation's warnings. */
  readonly diagnostics: readonly IDiagnostic[];
}

/**
 * The assessment could not be completed (for example a refused credential, a
 * network failure, a failed source read, a pull request that does not match
 * the request, or a review list that could not be read completely). This is
 * no verdict on the document. Nothing was published and nothing was written.
 *
 * @public
 */
export interface IIncompleteAssessment {
  /** Discriminant: no verdict could be reached. */
  readonly status: 'incomplete';
  /** What failed (with the token redacted) and what to do next. */
  readonly markdown: string;
  /** One `assessment-incomplete` error naming the cause. */
  readonly diagnostics: readonly IDiagnostic[];
}

/**
 * Every outcome of {@link validateSarifReview}, discriminated by `status`.
 *
 * @public
 */
export type ValidateSarifReviewOutcome = IReadyAssessment | IBlockedAssessment | IIncompleteAssessment;

// ---------------------------------------------------------------------------
// Private seam

/**
 * What assessment needs from a GitHub client: the preflight's context, the
 * authenticated user, and the pull request's reviews one page at a time.
 */
interface IAssessingClient extends IContextClient {
  readonly getAuthenticatedUser: () => Promise<unknown>;
  readonly listReviews: (request: IListReviewsRequest) => Promise<unknown>;
}

/**
 * The private test seam of {@link validateSarifReview}, shaped like
 * publication's so one injected client serves both. Not a supported
 * contract, which is why the public declaration has no second parameter.
 */
export interface IValidateSarifReviewInternals {
  readonly createGitHubClient?: ((options: ICreateGitHubClientOptions) => IAssessingClient) | undefined;
}

/** Assessment's input: exactly the shared review fields; no state path. */
const VALIDATE_INPUT: IReviewInputSpec<object> = {
  operation: 'validateSarifReview',
  ownKeys: [],
  captureOwn: () => ({}),
};

// ---------------------------------------------------------------------------
// Presentation

const NOTHING_WRITTEN = 'Nothing was published and no publication state was written.';

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

/**
 * The ready report. `summary` is the preparation's Markdown: complete (with
 * its warnings) for the outcome, without its warnings for the CLI's report.
 */
function readyMarkdown(prepared: IDestinationReady, captured: ICapturedReview, summary: string = prepared.markdown): string {
  // The mode changes no check (docs/submitted-review-contract.md §2.6); a
  // submitted assessment only says what publication would create.
  const as = captured.submit === true ? ' as a submitted comment review' : '';
  const count = prepared.suggestions?.companions.length ?? 0;
  const target = prepared.suggestionPullRequests;
  const plural = count === 1 ? '' : 's';
  const created = target?.ready === true
    ? `${String(count)} suggestion pull request${plural}, ready for review, into`
    : `${String(count)} draft suggestion pull request${plural} into`;
  const suggestions = count === 0 || target === undefined ? [] : [
    `Publication would also create ${created} ${code(target.headRef)}, labeled ${labelList(target.labels)}.${reappliedSentence(target, captured, count)}`,
    '',
  ];
  const headline = warningsHeadline(prepared.warnings, 'ready');
  return [
    '## Ready to publish',
    '',
    ...(headline === undefined ? [] : [headline, '']),
    `The complete document can be published faithfully to ${destinationLabel(captured)} at commit ${code(captured.reviewedCommit)}${as}.`,
    '',
    ...suggestions,
    summary.trim(),
    '',
    NOTHING_WRITTEN,
    '',
    'No pending review of this account was found on the pull request. This is not an approval: publication repeats every check against the pull request as it is then. GitHub can still refuse the review, for example if this account starts a pending review on the pull request before publication.',
  ].join('\n');
}

/**
 * After a rewritten history, the sentence that says the suggestion pull
 * requests are re-applied onto the head (contract §2.8, §2.5.1); empty
 * otherwise.
 */
function reappliedSentence(target: IReadySuggestionPullRequests, captured: ICapturedReview, count: number): string {
  if (target.reappliedOnto === undefined) return '';
  const [they, change] = count === 1 ? ['it is', 'it changes'] : ['they are', 'they change'];
  return ` The history of #${String(captured.destination.pullNumber)} was rewritten after the reviewed commit, so ${they} re-applied onto commit ${code(target.reappliedOnto)}, where everything ${change} is still exactly as reviewed.`;
}

/** The incomplete report; the CLI's report leaves out the cause, which is its diagnostic. */
function incompleteMarkdown(err: unknown, withCause = true): string {
  return [
    '## Readiness could not be assessed',
    '',
    ...(withCause ? [messageChain(err), ''] : []),
    `This is not a verdict on the document. ${NOTHING_WRITTEN}`,
    '',
    'Resolve the cause (for example the credential, network access, or access to the pull request and its source) and validate again.',
  ].join('\n');
}

/** `reported` with the credential removed from everything a caller can read. */
function redacted({ outcome, report }: IReported<ValidateSarifReviewOutcome>, token: string): IReported<ValidateSarifReviewOutcome> {
  return { outcome: redactedOutcome(outcome, token), report: redact(report, token) };
}

/** `outcome` with the credential removed from everything a caller can read. */
function redactedOutcome(outcome: ValidateSarifReviewOutcome, token: string): ValidateSarifReviewOutcome {
  const clean = (text: string): string => redact(text, token);
  const diagnostics = outcome.diagnostics.map((d) => mapDiagnosticText(d, clean));
  if (outcome.status !== 'blocked') return { ...outcome, markdown: clean(outcome.markdown), diagnostics };
  return {
    status: 'blocked',
    problems: outcome.problems.map((p) => mapDiagnosticText(p, clean)),
    markdown: clean(outcome.markdown),
    diagnostics,
  };
}

/** A blocked assessment: its errors as problems, then every diagnostic, errors first. */
function blockedAssessment(prepared: { readonly diagnostics: readonly IDiagnostic[]; readonly warnings: readonly IDiagnostic[]; readonly markdown: string }): IReported<IBlockedAssessment> {
  return {
    outcome: {
      status: 'blocked',
      problems: prepared.diagnostics.map(problemOfDiagnostic),
      markdown: blockedReviewMarkdown(prepared),
      diagnostics: orderDiagnostics([...prepared.diagnostics, ...prepared.warnings]),
    },
    report: blockedReviewReport(prepared),
  };
}

// ---------------------------------------------------------------------------
// Operational failures

/**
 * The failures assessment reports as `incomplete`: those raised by the GitHub
 * client itself (its context fetch, its source reader and its user lookup),
 * recorded by identity as they pass through. Anything else that reaches the
 * caller is this package's own defect and is rethrown.
 */
class OperationalFailures {
  private readonly seen = new Set<unknown>();

  /** Records `err` as operational and returns it for rethrowing. */
  record(err: unknown): unknown {
    this.seen.add(err);
    return err;
  }

  has(err: unknown): boolean {
    return this.seen.has(err);
  }

  /** `client` with every failure of its calls recorded as operational. */
  observe(client: IAssessingClient): IAssessingClient {
    return {
      fetchContext: async (request) => {
        let fetched;
        try {
          fetched = await client.fetchContext(request);
        } catch (err) {
          throw this.record(err);
        }
        return {
          context: fetched.context,
          readSource: this.observeReader(fetched.readSource),
          ...(fetched.fileExists === undefined ? {} : { fileExists: this.observeReader(fetched.fileExists) }),
          ...(fetched.readEntry === undefined ? {} : { readEntry: this.observeReader(fetched.readEntry) }),
        };
      },
      getAuthenticatedUser: async () => {
        try {
          return await client.getAuthenticatedUser();
        } catch (err) {
          throw this.record(err);
        }
      },
      listReviews: this.observeCall(client.listReviews),
      ...(client.readSuggestionTarget === undefined ? {} : { readSuggestionTarget: this.observeCall(client.readSuggestionTarget) }),
      ...(client.compareCommits === undefined ? {} : { compareCommits: this.observeCall(client.compareCommits) }),
      ...(client.findLabel === undefined ? {} : { findLabel: this.observeCall(client.findLabel) }),
      ...(client.readDefaultBranchFile === undefined ? {} : { readDefaultBranchFile: this.observeCall(client.readDefaultBranchFile) }),
    };
  }

  /** A client read with its failures recorded as operational. */
  private observeCall<A, R>(call: (argument: A) => Promise<R>): (argument: A) => Promise<R> {
    return async (argument) => {
      try {
        return await call(argument);
      } catch (err) {
        throw this.record(err);
      }
    };
  }

  /**
   * A snapshot reader (the source reader or the existence check) with its
   * failures recorded. A reader that is not a function is passed on
   * unchanged, for preparation to refuse as the contract violation it is.
   */
  private observeReader(readSource: unknown): unknown {
    if (typeof readSource !== 'function') return readSource;
    return async (...args: readonly unknown[]): Promise<unknown> => {
      try {
        const answer: unknown = await Reflect.apply(readSource, undefined, args);
        return answer;
      } catch (err) {
        throw this.record(err);
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Pending review of this account (contract: "Pending review of this account")

/** GitHub's review state for a review its author has not submitted. */
const PENDING_STATE = 'PENDING';

/** GitHub's documented states of a submitted review; none of them is pending. */
const SUBMITTED_STATES: ReadonlySet<unknown> = new Set(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/**
 * GitHub's review list leaves undecided whether this account has a pending
 * review on the pull request. This is the host's answer, not a defect in this
 * package, so assessment reports it as incomplete.
 */
class UndecidedReviewsError extends Error {}

/** A pending review of the authenticated account, as the host listed it. */
interface IPendingReview {
  readonly id: number;
  readonly htmlUrl: string | undefined;
}

/** The facts of one listed review that the check depends on. */
interface IReviewFacts {
  readonly authorId: unknown;
  readonly state: unknown;
  readonly htmlUrl: unknown;
}

/** What the complete review list says: the account's pending reviews, or why that cannot be decided. */
type PendingReviewsAnswer = { readonly pending: readonly IPendingReview[] } | { readonly undecided: string };

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * The pending reviews of the account with numeric id `userId` among a
 * complete review list. Authors are compared only by numeric id; logins are
 * mutable and never compared. A review listed more than once must be listed
 * with the same author and state each time, or the list is undecided. A
 * review that could be the account's pending one but cannot be shown to be
 * (no numeric author id, or the account's own review in an undocumented
 * state) makes the list undecided unless the account has an unambiguous
 * pending review, which blocks either way.
 */
function pendingReviewsOf(reviews: readonly unknown[], userId: number, where: string): PendingReviewsAnswer {
  const undecided = (why: string): PendingReviewsAnswer => ({
    undecided: `GitHub's review list for ${where} leaves undecided whether this account has a pending review there: ${why}.`,
  });
  const byId = new Map<number, IReviewFacts>();
  for (const review of reviews) {
    if (!isPlainObject(review) || !isPositiveInteger(review['id'])) return undecided('a listed review has no numeric id');
    const id = review['id'];
    const facts: IReviewFacts = { authorId: review['authorId'], state: review['state'], htmlUrl: review['htmlUrl'] };
    const earlier = byId.get(id);
    if (earlier === undefined) {
      byId.set(id, facts);
    } else if (!Object.is(earlier.authorId, facts.authorId) || !Object.is(earlier.state, facts.state)) {
      return undecided(`review ${String(id)} is listed more than once with different authors or states`);
    }
  }
  const pending: IPendingReview[] = [];
  const unknown: string[] = [];
  for (const [id, { authorId, state, htmlUrl }] of byId) {
    const submitted = SUBMITTED_STATES.has(state);
    if (!isPositiveInteger(authorId)) {
      if (!submitted) unknown.push(`review ${String(id)} has no numeric author id`);
    } else if (authorId === userId) {
      if (state === PENDING_STATE) pending.push({ id, htmlUrl: typeof htmlUrl === 'string' && htmlUrl.length > 0 ? htmlUrl : undefined });
      else if (!submitted) unknown.push(`review ${String(id)} of this account has an unknown state`);
    }
  }
  if (pending.length === 0 && unknown.length > 0) return undecided(unknown.join('; '));
  return { pending };
}

/** The blocker for one pending review of the account: which review, why GitHub would refuse, and what to do. */
function pendingReviewProblem(review: IPendingReview, where: string): IDiagnostic {
  const named = review.htmlUrl === undefined ? `review ${String(review.id)}` : `review ${String(review.id)} (${review.htmlUrl})`;
  return createDiagnostic(
    'pending-review-exists',
    `This account already has a pending review on ${where}: ${named}. ` +
      'GitHub allows one pending review per account on a pull request, so it would refuse this review, as a draft or as a submitted comment review. ' +
      'Submit or delete that pending review on GitHub, then validate again; this tool never submits, edits or deletes an existing review. ' +
      "If it is this tool's own earlier publication, retry publish with that publication's state path rather than a new one.",
    { subject: where },
  );
}

/**
 * Reads every page of the destination's reviews and answers with the
 * account's pending reviews. An enumeration that cannot be completed, or a
 * list that leaves the answer undecided, rejects with a failure recorded as
 * operational: it is never read as ready or blocked.
 */
async function pendingReviews(
  client: IAssessingClient,
  captured: ICapturedReview,
  userId: number,
  operational: OperationalFailures,
): Promise<readonly IPendingReview[]> {
  const { owner, repo, pullNumber } = captured.destination;
  let reviews: unknown[];
  try {
    reviews = await readAllPages((cursor) => client.listReviews({ owner, repo, pullNumber, cursor }), 'reviews');
  } catch (err) {
    throw operational.record(err);
  }
  const answer = pendingReviewsOf(reviews, userId, destinationLabel(captured));
  if ('undecided' in answer) throw operational.record(new UndecidedReviewsError(answer.undecided));
  return answer.pending;
}

// ---------------------------------------------------------------------------
// Entry point

async function assess(
  captured: ICapturedReview,
  createGitHubClient: (options: ICreateGitHubClientOptions) => IAssessingClient,
): Promise<IReported<ValidateSarifReviewOutcome>> {
  const operational = new OperationalFailures();
  let ready: IDestinationReady;
  try {
    const client = operational.observe(createGitHubClient({ token: captured.token, fetch: globalThis.fetch }));
    const prepared = await prepareForDestination(captured, client);
    if (prepared.status === 'blocked') {
      return blockedAssessment(prepared);
    }
    validatePreparedReview({ body: prepared.review.body, comments: prepared.review.comments });
    let userId: number;
    try {
      userId = await authenticatedUserId(client);
    } catch (err) {
      // The client's failure, or its answer that the account has no numeric
      // id (not user/PAT authentication): both are the host's, not a defect.
      throw operational.record(err);
    }
    const pending = await pendingReviews(client, captured, userId, operational);
    if (pending.length > 0) {
      const where = destinationLabel(captured);
      const blocked = blockedBy(pending.map((review) => pendingReviewProblem(review, where)), prepared.warnings);
      return blockedAssessment(blocked);
    }
    ready = prepared;
  } catch (err) {
    if (!operational.has(err) && !(err instanceof ReviewContextMismatchError)) throw withoutCredential(err, captured.token);
    const cause = withoutCredential(err, captured.token);
    return {
      outcome: {
        status: 'incomplete',
        markdown: incompleteMarkdown(cause),
        diagnostics: [createDiagnostic('assessment-incomplete', messageChain(cause), { subject: destinationLabel(captured) })],
      },
      report: incompleteMarkdown(cause, false),
    };
  }
  return {
    outcome: { status: 'ready', markdown: readyMarkdown(ready, captured), diagnostics: ready.warnings },
    report: readyMarkdown(ready, captured, withoutWarnings(ready)),
  };
}

/**
 * Checks whether a complete SARIF document can be published faithfully as
 * one review of a pull request (a draft, or a submitted comment review with
 * `options.submit`), without publishing anything.
 *
 * @remarks
 * Runs the same checks as `publishSarifReview` — the SARIF schema, approval
 * holds, source consistency against the reviewed commit, supported
 * representation, placement and suggestion eligibility, product limits and
 * the authenticated account — reading GitHub but never writing to it, and
 * writing no file. It also reads the pull request's reviews: a pending review
 * of the authenticated account there is reported as `blocked`, because
 * GitHub refuses to create another review, draft or submitted, while it
 * exists. It is optional: publication never requires it, and a `ready`
 * result grants nothing, because publication performs every check again
 * against the pull request as it is then.
 *
 * @param input - The document, intended pull request, reviewed commit and
 * credential (no state path).
 * @returns `ready`, `blocked` with its problems, or `incomplete` when the
 * assessment itself could not be completed. `status`, `markdown`,
 * `diagnostics` (and `problems`) are the stable contract.
 * @throws `TypeError` for invalid input, before any network request; an
 * `Error` for a defect in this package (an internal invariant failure), as
 * `publishSarifReview` does. Operational failures (GitHub, network,
 * authentication, source reads, a review list that cannot be read
 * completely) are reported as `incomplete`, never thrown.
 * Neither a result nor a rejection contains the token.
 *
 * @example
 * ```ts
 * import { validateSarifReview } from 'sarif-to-comment';
 *
 * const assessment = await validateSarifReview({
 *   sarif,
 *   destination: { owner: 'acme', repo: 'widgets', pullNumber: 42 },
 *   reviewedCommit: 'c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de',
 *   token: process.env.GH_TOKEN!,
 * });
 * if (assessment.status === 'blocked') for (const p of assessment.problems) console.log(p.pointer, p.message);
 * ```
 *
 * @public
 */
export function validateSarifReview(input: IValidateSarifReviewInput): Promise<ValidateSarifReviewOutcome>;
// Implementation signature, never emitted to the declarations: the input is
// `unknown` because JavaScript callers are unconstrained (the preflight
// checks everything), and a second argument is honoured at runtime as the
// private test seam (IValidateSarifReviewInternals). In-package callers that
// inject use validateSarifReviewWithInternals. The default keeps the
// function's length 1, like publishSarifReview's.
export async function validateSarifReview(input: unknown, internals: IValidateSarifReviewInternals = {}): Promise<ValidateSarifReviewOutcome> {
  return validateSarifReviewWithInternals(input, internals);
}

/**
 * {@link validateSarifReview} with its private test seam typed. Internal: the
 * CLI and tests reach the seam through it; it is not part of the public API.
 */
export async function validateSarifReviewWithInternals(
  input: unknown,
  internals: IValidateSarifReviewInternals = {},
): Promise<ValidateSarifReviewOutcome> {
  return (await validateSarifReviewReported(input, internals)).outcome;
}

/**
 * {@link validateSarifReview} with the CLI's human report of the outcome
 * (see IReported). Internal: the CLI prints the report in human form.
 */
export async function validateSarifReviewReported(
  input: unknown,
  internals: IValidateSarifReviewInternals = {},
): Promise<IReported<ValidateSarifReviewOutcome>> {
  const captured = captureReviewInput(input, VALIDATE_INPUT);
  const createGitHubClient = internals.createGitHubClient || defaultCreateGitHubClient;
  return redacted(await assess(captured, createGitHubClient), captured.token);
}
