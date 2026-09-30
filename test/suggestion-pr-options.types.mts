/**
 * Compile-time checks of the public suggestion pull request options
 * (docs/companion-suggestion-pr-contract.md §2.2). This file is type-checked
 * by `pnpm run check:types` and never executed.
 *
 * The flag names reveal their value types: two switches and a list of label
 * names. The removed and renamed options no longer exist, so passing them is
 * a compile error, as it is a runtime `TypeError`.
 */
import type { IPublishSarifReviewOptions, IValidateSarifReviewInput } from '../dist/public-api.cjs';

/** True exactly when `A` and `B` are assignable to each other. */
type IsMutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const shapes: readonly true[] = [
  true satisfies IsMutuallyAssignable<IPublishSarifReviewOptions['allowSuggestionPullRequests'], boolean | undefined>,
  true satisfies IsMutuallyAssignable<IPublishSarifReviewOptions['markSuggestionPullRequestsReady'], boolean | undefined>,
  true satisfies IsMutuallyAssignable<IPublishSarifReviewOptions['pullRequestLabels'], readonly string[] | undefined>,
  true satisfies IsMutuallyAssignable<NonNullable<IValidateSarifReviewInput['options']>, IPublishSarifReviewOptions>,
];

export const none: IPublishSarifReviewOptions = {};
export const all: IPublishSarifReviewOptions = {
  allowSuggestionPullRequests: true,
  pullRequestLabels: ['team-a', 'campaign'],
  markSuggestionPullRequestsReady: true,
};
const labels: readonly string[] = ['team-a'];
export const readonlyLabels: IPublishSarifReviewOptions = { allowSuggestionPullRequests: true, pullRequestLabels: labels };

// @ts-expect-error -- renamed: allowSuggestionPullRequests
export const oldSwitch: IPublishSarifReviewOptions = { suggestionPullRequests: true };
// @ts-expect-error -- removed: the canonical label is a repository-wide convention, not a per-call option
export const oldLabel: IPublishSarifReviewOptions = { allowSuggestionPullRequests: true, suggestionLabel: 'suggestion' };
// @ts-expect-error -- a list of label names, not one comma-separated string
export const commaString: IPublishSarifReviewOptions = { allowSuggestionPullRequests: true, pullRequestLabels: 'a,b' };
// @ts-expect-error -- a switch, not a string
export const readyString: IPublishSarifReviewOptions = { allowSuggestionPullRequests: true, markSuggestionPullRequestsReady: 'yes' };
