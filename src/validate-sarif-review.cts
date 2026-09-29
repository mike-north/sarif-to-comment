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
 *      prepared review's shape and the authenticated account's numeric id.
 * It computes no publication identity, reads or writes no state, and sends
 * nothing: GitHub is only read, and no file is written.
 *
 * A `ready` outcome is information, never authority. It carries nothing
 * publication accepts, and publication repeats every check itself against
 * the pull request as it is then. It is also not a delivery promise: GitHub
 * can still refuse the create request (for example, an existing pending
 * review by the same account), which only publication discovers.
 *
 * ---------------------------------------------------------------------------
 * validateSarifReview(input, internals?) -> Promise<Outcome>
 *
 * input: publishSarifReview's input without `statePath` (which is refused as
 *   an unknown field), captured and validated identically; a TypeError
 *   rejects before any request.
 *
 * Outcome (status plus Markdown is the contract; internal codes are not, D13):
 *   { status: 'ready', markdown }
 *   { status: 'blocked', problems: [{ message, pointer? }], markdown }
 *       // markdown is publication's own blocked explanation
 *   { status: 'incomplete', markdown }
 *       // an operational failure: anything the GitHub client reports (HTTP,
 *       // network, authentication, source reads), its answer that the account
 *       // has no numeric id, or context for another pull request or commit.
 *       // Never a verdict.
 * Any other failure after capture is a defect in this package or its client
 * boundary (an internal invariant, a client answer outside its contract). It
 * rejects, as publication does, rather than being disguised as a transient
 * condition with retry advice.
 * The token never appears in an outcome.
 *
 * internals (private seam, not caller API):
 *   createGitHubClient({ token, fetch }) -> client with fetchContext and
 *     getAuthenticatedUser. Defaults to src/github.cts.
 */

import { createGitHubClient as defaultCreateGitHubClient } from './github.cjs';
import type { ICreateGitHubClientOptions } from './github.cjs';
import type { IDiagnostic, IReadyOutcome } from './prepare-review.cjs';
import { authenticatedUserId, validatePreparedReview } from './publication.cjs';
import type { IPublishSarifReviewOptions, IPullRequestDestination } from './publish-sarif-review.cjs';
import type { IProblem } from './public-types.cjs';
import {
  ReviewContextMismatchError,
  blockedReviewMarkdown,
  captureReviewInput,
  destinationLabel,
  messageChain,
  prepareForDestination,
  redact,
  withoutCredential,
} from './review-preflight.cjs';
import type { ICapturedReview, IContextClient, IReviewInputSpec } from './review-preflight.cjs';

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
 * request. Nothing was published and nothing was written.
 *
 * @remarks
 * This is not an approval and not a delivery promise: publication repeats
 * every check against the pull request as it is then, and GitHub can still
 * refuse the review (for example when the account already has a pending
 * review on the pull request).
 *
 * @public
 */
export interface IReadyAssessment {
  /** Discriminant: the complete document can be published faithfully. */
  readonly status: 'ready';
  /** What publication would create, and what this result does not promise. */
  readonly markdown: string;
}

/**
 * Publication of this document would be blocked. Nothing was published and
 * nothing was written.
 *
 * @public
 */
export interface IBlockedAssessment {
  /** Discriminant: the document cannot be published faithfully. */
  readonly status: 'blocked';
  /** Every blocking problem, with a pointer into the SARIF document where it has one. */
  readonly problems: readonly IProblem[];
  /** The explanation publication itself gives for this document. */
  readonly markdown: string;
}

/**
 * The assessment could not be completed (for example a refused credential, a
 * network failure, a failed source read or a pull request that does not match
 * the request). This is no verdict on the document; publication would refuse
 * at the same point without writing. Nothing was published and nothing was
 * written.
 *
 * @public
 */
export interface IIncompleteAssessment {
  /** Discriminant: no verdict could be reached. */
  readonly status: 'incomplete';
  /** What failed (with the token redacted) and what to do next. */
  readonly markdown: string;
}

/**
 * Every outcome of {@link validateSarifReview}, discriminated by `status`.
 *
 * @public
 */
export type ValidateSarifReviewOutcome = IReadyAssessment | IBlockedAssessment | IIncompleteAssessment;

// ---------------------------------------------------------------------------
// Private seam

/** What assessment needs from a GitHub client: the preflight's context plus the authenticated user. */
interface IAssessingClient extends IContextClient {
  readonly getAuthenticatedUser: () => Promise<unknown>;
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

function readyMarkdown(prepared: IReadyOutcome, captured: ICapturedReview): string {
  return [
    '## Ready to publish',
    '',
    `The complete document can be published faithfully to ${destinationLabel(captured)} at commit ${code(captured.reviewedCommit)}.`,
    '',
    prepared.markdown.trim(),
    '',
    NOTHING_WRITTEN,
    '',
    'This is not an approval: publication repeats every check against the pull request as it is then. GitHub can still refuse the review, for example when this account already has a pending review on the pull request.',
  ].join('\n');
}

function incompleteMarkdown(err: unknown): string {
  return [
    '## Readiness could not be assessed',
    '',
    messageChain(err),
    '',
    `This is not a verdict on the document. ${NOTHING_WRITTEN}`,
    '',
    'Resolve the cause (for example the credential, network access, or access to the pull request and its source) and validate again.',
  ].join('\n');
}

/** A preparation diagnostic as a public problem: its message and pointer, never its internal code. */
function problemOf(diagnostic: IDiagnostic): IProblem {
  return diagnostic.pointer === undefined ? { message: diagnostic.message } : { message: diagnostic.message, pointer: diagnostic.pointer };
}

/** `outcome` with the credential removed from everything a caller can read. */
function redacted(outcome: ValidateSarifReviewOutcome, token: string): ValidateSarifReviewOutcome {
  if (outcome.status !== 'blocked') return { ...outcome, markdown: redact(outcome.markdown, token) };
  return {
    status: 'blocked',
    problems: outcome.problems.map((p) => ({ ...p, message: redact(p.message, token) })),
    markdown: redact(outcome.markdown, token),
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
        return { context: fetched.context, readSource: this.observeReader(fetched.readSource) };
      },
      getAuthenticatedUser: async () => {
        try {
          return await client.getAuthenticatedUser();
        } catch (err) {
          throw this.record(err);
        }
      },
    };
  }

  /**
   * The source reader with its failures recorded. A reader that is not a
   * function is passed on unchanged, for preparation to refuse as the
   * contract violation it is.
   */
  private observeReader(readSource: unknown): unknown {
    if (typeof readSource !== 'function') return readSource;
    return async (...args: readonly unknown[]): Promise<unknown> => {
      try {
        const text: unknown = await Reflect.apply(readSource, undefined, args);
        return text;
      } catch (err) {
        throw this.record(err);
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Entry point

async function assess(captured: ICapturedReview, createGitHubClient: (options: ICreateGitHubClientOptions) => IAssessingClient): Promise<ValidateSarifReviewOutcome> {
  const operational = new OperationalFailures();
  let ready: IReadyOutcome;
  try {
    const client = operational.observe(createGitHubClient({ token: captured.token, fetch: globalThis.fetch }));
    const prepared = await prepareForDestination(captured, client);
    if (prepared.status === 'blocked') {
      return { status: 'blocked', problems: prepared.diagnostics.map(problemOf), markdown: blockedReviewMarkdown(prepared) };
    }
    validatePreparedReview({ body: prepared.review.body, comments: prepared.review.comments });
    try {
      await authenticatedUserId(client);
    } catch (err) {
      // The client's failure, or its answer that the account has no numeric
      // id (not user/PAT authentication): both are the host's, not a defect.
      throw operational.record(err);
    }
    ready = prepared;
  } catch (err) {
    if (!operational.has(err) && !(err instanceof ReviewContextMismatchError)) throw withoutCredential(err, captured.token);
    return { status: 'incomplete', markdown: incompleteMarkdown(withoutCredential(err, captured.token)) };
  }
  return { status: 'ready', markdown: readyMarkdown(ready, captured) };
}

/**
 * Checks whether a complete SARIF document can be published faithfully as
 * one draft review of a pull request, without publishing anything.
 *
 * @remarks
 * Runs the same checks as `publishSarifReview` — the SARIF schema, approval
 * holds, source consistency against the reviewed commit, supported
 * representation, placement and suggestion eligibility, product limits and
 * the authenticated account — reading GitHub but never writing to it, and
 * writing no file. It is optional: publication never requires it, and a
 * `ready` result grants nothing, because publication performs every check
 * again against the pull request as it is then.
 *
 * @param input - The document, intended pull request, reviewed commit and
 * credential (no state path).
 * @returns `ready`, `blocked` with its problems, or `incomplete` when the
 * assessment itself could not be completed. `status` plus `markdown` (and
 * `problems`) is the stable contract.
 * @throws `TypeError` for invalid input, before any network request; an
 * `Error` for a defect in this package (an internal invariant failure), as
 * `publishSarifReview` does. Operational failures (GitHub, network,
 * authentication, source reads) are reported as `incomplete`, never thrown.
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
  const captured = captureReviewInput(input, VALIDATE_INPUT);
  const createGitHubClient = internals.createGitHubClient || defaultCreateGitHubClient;
  return redacted(await assess(captured, createGitHubClient), captured.token);
}
