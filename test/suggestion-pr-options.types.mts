/**
 * Compile-time checks of the public delivery and companion pull request
 * options (docs/delivery-policy-contract.md §12;
 * docs/companion-suggestion-pr-contract.md §2.2). This file is type-checked
 * by `pnpm run check:types` and never executed.
 *
 * The delivery settings are ordered lists of each dimension's own
 * mechanisms, a preset and a bundle setting; the companion options are a
 * switch and a list of label names, valid with any policy. The removed and
 * renamed options no longer exist, so passing them is a compile error, as it
 * is a runtime `TypeError`.
 */
import type {
  CompanionBundle,
  DeliveryPreset,
  EditDeliveryMechanism,
  FileOperationDeliveryMechanism,
  GroupedEditDeliveryMechanism,
  IDeliveryOptions,
  IPublishSarifReviewOptions,
  IValidateSarifReviewInput,
} from '../dist/public-api.cjs';
import type {
  CompanionBundle as PolicyBundle,
  DeliveryPreset as PolicyPreset,
  EditMechanism,
  FileOperationMechanism,
  GroupedEditMechanism,
} from '../dist/delivery-policy.cjs';

/** True exactly when `A` and `B` are assignable to each other. */
type IsMutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const shapes: readonly true[] = [
  true satisfies IsMutuallyAssignable<IPublishSarifReviewOptions['delivery'], IDeliveryOptions | undefined>,
  true satisfies IsMutuallyAssignable<IPublishSarifReviewOptions['markSuggestionPullRequestsReady'], boolean | undefined>,
  true satisfies IsMutuallyAssignable<IPublishSarifReviewOptions['pullRequestLabels'], readonly string[] | undefined>,
  true satisfies IsMutuallyAssignable<NonNullable<IValidateSarifReviewInput['options']>, IPublishSarifReviewOptions>,
  // The public vocabularies are exactly the policy's (§3, §6).
  true satisfies IsMutuallyAssignable<EditDeliveryMechanism, EditMechanism>,
  true satisfies IsMutuallyAssignable<GroupedEditDeliveryMechanism, GroupedEditMechanism>,
  true satisfies IsMutuallyAssignable<FileOperationDeliveryMechanism, FileOperationMechanism>,
  true satisfies IsMutuallyAssignable<DeliveryPreset, PolicyPreset>,
  true satisfies IsMutuallyAssignable<CompanionBundle, PolicyBundle>,
];

export const none: IPublishSarifReviewOptions = {};
export const empty: IDeliveryOptions = {};
export const all: IPublishSarifReviewOptions = {
  delivery: {
    preset: 'companion',
    edits: ['native', 'review-body', 'companion'],
    groupedEdits: ['native-batch', 'companion', 'manual-group'],
    fileOperations: ['companion', 'manual'],
    companionBundle: 'single',
  },
  pullRequestLabels: ['team-a', 'campaign'],
  markSuggestionPullRequestsReady: true,
};
const edits: readonly EditDeliveryMechanism[] = ['native'];
export const readonlyLists: IPublishSarifReviewOptions = { delivery: { edits }, pullRequestLabels: ['team-a'] as const };
// Companion options are valid without any delivery setting (§12).
export const labelsAlone: IPublishSarifReviewOptions = { pullRequestLabels: ['team-a'], markSuggestionPullRequestsReady: true };

// @ts-expect-error -- removed: a companion pull request is requested by listing `companion`
export const oldOptIn: IPublishSarifReviewOptions = { allowSuggestionPullRequests: true };
// @ts-expect-error -- renamed long ago: suggestionPullRequests
export const oldSwitch: IPublishSarifReviewOptions = { suggestionPullRequests: true };
// @ts-expect-error -- removed: the canonical label is a repository-wide convention, not a per-call option
export const oldLabel: IPublishSarifReviewOptions = { suggestionLabel: 'suggestion' };
// @ts-expect-error -- a list of label names, not one comma-separated string
export const commaString: IPublishSarifReviewOptions = { pullRequestLabels: 'a,b' };
// @ts-expect-error -- a switch, not a string
export const readyString: IPublishSarifReviewOptions = { markSuggestionPullRequestsReady: 'yes' };
// @ts-expect-error -- `native-batch` delivers groups, not ungrouped edits
export const wrongDimension: IDeliveryOptions = { edits: ['native-batch'] };
// @ts-expect-error -- `manual` is the file-operation mechanism; edits name `review-body`
export const wrongEdit: IDeliveryOptions = { edits: ['manual'] };
// @ts-expect-error -- a list, not one mechanism
export const notAList: IDeliveryOptions = { fileOperations: 'companion' };
// @ts-expect-error -- the bundle setting is one value, not a list
export const bundleList: IDeliveryOptions = { companionBundle: ['single'] };
// @ts-expect-error -- an unknown preset
export const unknownPreset: IDeliveryOptions = { preset: 'everything' };
// @ts-expect-error -- an unknown setting
export const unknownSetting: IDeliveryOptions = { bundle: 'single' };
