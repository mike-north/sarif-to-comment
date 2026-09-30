/**
 * Author, inspect and extend SARIF 2.1.0, and publish it as one GitHub draft
 * pull request review.
 *
 * @remarks
 * Nine operations work on ordinary in-memory SARIF values, and one cleans
 * up after publication:
 *
 * - {@link createSarifDocument} and {@link addSarifComment} optionally author
 *   SARIF for your own findings, on lines or line ranges, and
 *   {@link removeSarifComment} removes a finding selected through inspection,
 *   so a finding can be corrected by removing it and adding it again.
 *
 * - {@link groupSarifFixes} declares that fixes of several findings must be
 *   accepted together, published as one suggestion pull request, and
 *   {@link ungroupSarifFixes} undoes it.
 *
 * - {@link inspectSarif} shows every finding, location and fix in any SARIF.
 *
 * - {@link addStagedChangesToSarif} adds the changes staged in a Git index as
 *   SARIF fixes.
 *
 * - {@link validateSarifReview} optionally checks, without publishing, that a
 *   complete document can be published faithfully to its pull request.
 *
 * - {@link publishSarifReview} publishes a ready document as one draft review.
 *
 * - {@link closeSuggestionPullRequests} closes the companion suggestion pull
 *   requests publication created once their original pull request has merged
 *   or closed.
 *
 * Authoring is optional: SARIF from any producer can be inspected, extended
 * and published directly, and no operation depends on how a document was
 * made. There is no builder, session or private format; each operation that
 * changes a document returns a new one and leaves its input untouched.
 *
 * The `sarif-to-comment` command-line interface provides the same operations
 * for files (`init`, `add-comment`, `remove-comment`, `group-fixes`,
 * `ungroup-fixes`, `inspect`, `add-staged-changes`, `validate`, `publish`),
 * and `close-suggestion-prs`.
 * These declarations describe the package's CommonJS runtime
 * entry; they are generated from its TypeScript implementation, checked by API
 * Extractor and compiled against CommonJS and ES module consumers by the
 * package tests.
 *
 * @packageDocumentation
 */

// The declaration entry (API Extractor's mainEntryPointFilePath is its
// emitted declaration, dist/public-api.d.cts): exactly the public API, as ES
// named exports of the ten operations and every public type, each carrying
// its public documentation where it is implemented. The runtime entry is
// src/index.cts, which proves at compile time that it exports exactly these
// values; this module's own compiled JavaScript is never shipped or loaded.

export { publishSarifReview } from './publish-sarif-review.cjs';
export type {
  IPullRequestDestination,
  IPublishSarifReviewOptions,
  IPublishSarifReviewInput,
  IPublishedReview,
  IPublishedSuggestion,
  IPublishedOutcome,
  IBlockedOutcome,
  IUncertainOutcome,
  IRejectedOutcome,
  PublishSarifReviewOutcome,
} from './publish-sarif-review.cjs';

export { validateSarifReview } from './validate-sarif-review.cjs';
export type {
  IValidateSarifReviewInput,
  IReadyAssessment,
  IBlockedAssessment,
  IIncompleteAssessment,
  ValidateSarifReviewOutcome,
} from './validate-sarif-review.cjs';

export { closeSuggestionPullRequests } from './close-suggestion-pull-requests.cjs';
export type {
  ICloseSuggestionPullRequestsInput,
  OriginalPullRequestState,
  IOriginalPullRequest,
  SuggestionCleanupResult,
  ICheckedSuggestionPullRequest,
  CloseSuggestionPullRequestsStatus,
  ICloseSuggestionPullRequestsOutcome,
} from './close-suggestion-pull-requests.cjs';

export type { ISarifLog, IProblem, IInvalidSarifOutcome, IGitHubRepository, ISarifSourceBinding } from './public-types.cjs';

export { createSarifDocument, addSarifComment, removeSarifComment } from './sarif-authoring.cjs';
export type {
  ISarifToolIdentity,
  ICreateSarifDocumentOptions,
  INewSarifRun,
  ISarifComment,
  IAddedFinding,
  IAddedSarifCommentOutcome,
  AddSarifCommentOutcome,
  IRemovedFinding,
  IRemovedSarifCommentOutcome,
  IStaleSarifSelectorOutcome,
  RemoveSarifCommentOutcome,
} from './sarif-authoring.cjs';

export { groupSarifFixes, ungroupSarifFixes } from './suggestion-groups.cjs';
export type {
  IGroupSarifFixesOptions,
  IUngroupSarifFixesOptions,
  IGroupedFinding,
  IGroupedSarifFixesOutcome,
  IRefusedSuggestionGroupOutcome,
  GroupSarifFixesOutcome,
  IUngroupedFinding,
  IUngroupedSarifFixesOutcome,
  UngroupSarifFixesOutcome,
} from './suggestion-groups.cjs';

export { inspectSarif } from './sarif-inspection.cjs';
export type {
  IInspectSarifOptions,
  IInspectionPreview,
  IInspectionLocation,
  IInspectionReplacement,
  IInspectionArtifactChange,
  IInspectionFix,
  IInspectionFileProposal,
  IInspectionMessage,
  IInspectionFinding,
  IInspectionRun,
  IInspectionDiagnostic,
  IInspectionExternalProperties,
  ISarifInspection,
  IInspectedOutcome,
  InspectSarifOutcome,
} from './sarif-inspection.cjs';

export { addStagedChangesToSarif } from './staged-changes.cjs';
export type {
  IAddStagedChangesInput,
  IStagedReplacementReceipt,
  IStagedChangeReceipt,
  IStagedChangesReceipt,
  IAddedStagedChangesOutcome,
  IFailedStagedChangesOutcome,
  AddStagedChangesOutcome,
} from './staged-changes.cjs';
