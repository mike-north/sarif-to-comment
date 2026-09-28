/**
 * Author, inspect and extend SARIF 2.1.0, and publish it as one GitHub draft
 * pull request review.
 *
 * @remarks
 * Five operations work on ordinary in-memory SARIF values:
 *
 * - {@link createSarifDocument} and {@link addSarifComment} optionally author
 *   SARIF for your own findings, on lines or line ranges.
 *
 * - {@link inspectSarif} shows every finding, location and fix in any SARIF.
 *
 * - {@link addStagedChangesToSarif} adds the changes staged in a Git index as
 *   SARIF fixes.
 *
 * - {@link publishSarifReview} publishes a ready document as one draft review.
 *
 * Authoring is optional: SARIF from any producer can be inspected, extended
 * and published directly, and no operation depends on how a document was
 * made. There is no builder, session or private format; each operation that
 * changes a document returns a new one and leaves its input untouched.
 *
 * The `sarif-to-comment` command-line interface provides the same operations
 * for files (`init`, `add-comment`, `inspect`, `add-staged-changes`,
 * `publish`). These declarations describe the CommonJS runtime in
 * `src/index.cjs`; they are written by hand, checked by API Extractor and
 * compiled against CommonJS and ES module consumers by the package tests.
 *
 * @packageDocumentation
 */

// The declaration entry (API Extractor's mainEntryPointFilePath is its
// emitted declaration, dist/public-api.d.cts): exactly the public API, as ES
// named exports of the five operations and every public type, each carrying
// its public documentation where it is implemented. The runtime entry is
// src/index.cts, which proves at compile time that it exports exactly these
// values; this module's own compiled JavaScript is never shipped or loaded.

export { publishSarifReview } from './publish-sarif-review.cjs';
export type {
  IPullRequestDestination,
  IPublishSarifReviewOptions,
  IPublishSarifReviewInput,
  IPublishedReview,
  IPublishedOutcome,
  IBlockedOutcome,
  IUncertainOutcome,
  IRejectedOutcome,
  PublishSarifReviewOutcome,
} from './publish-sarif-review.cjs';

export type { ISarifLog, IProblem, IInvalidSarifOutcome, IGitHubRepository, ISarifSourceBinding } from './public-types.cjs';

export { createSarifDocument, addSarifComment } from './sarif-authoring.cjs';
export type {
  ISarifToolIdentity,
  ICreateSarifDocumentOptions,
  INewSarifRun,
  ISarifComment,
  IAddedFinding,
  IAddedSarifCommentOutcome,
  AddSarifCommentOutcome,
} from './sarif-authoring.cjs';

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
