/**
 * Publish a ready SARIF 2.1.0 document as one GitHub draft pull request review.
 *
 * @remarks
 * The package exports a single operation, {@link publishSarifReview}. The
 * `sarif-to-comment` command-line interface calls the same operation. These
 * declarations describe the CommonJS runtime in `src/index.cjs`; they are
 * written by hand, checked by API Extractor and compiled against CommonJS and
 * ES module consumers by the package tests.
 *
 * @packageDocumentation
 */

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
export declare function publishSarifReview(input: IPublishSarifReviewInput): Promise<PublishSarifReviewOutcome>;
