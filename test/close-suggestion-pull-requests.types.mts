/**
 * Compile-time checks of the public declaration of closeSuggestionPullRequests
 * (docs/suggestion-cleanup-contract.md §2.2, §2.10). This file is
 * type-checked by `pnpm run check:types` and never executed.
 *
 * The input requires the repository and the token and nothing else; the
 * outcome's status and each suggestion's result are exactly the contract's
 * closed vocabularies, so a consumer's exhaustive switch keeps compiling only
 * while they are unchanged.
 */
import type {
  CloseSuggestionPullRequestsStatus,
  ICloseSuggestionPullRequestsInput,
  ICloseSuggestionPullRequestsOutcome,
  OriginalPullRequestState,
  SuggestionCleanupResult,
  closeSuggestionPullRequests,
} from '../dist/public-api.cjs';

/** True exactly when `A` and `B` are assignable to each other. */
type IsMutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const vocabularies: readonly true[] = [
  true satisfies IsMutuallyAssignable<CloseSuggestionPullRequestsStatus, 'complete' | 'permission-limited' | 'incomplete'>,
  true satisfies IsMutuallyAssignable<OriginalPullRequestState, 'open' | 'merged' | 'closed' | 'unverified'>,
  true satisfies IsMutuallyAssignable<
    SuggestionCleanupResult,
    'closed' | 'would-close' | 'already-closed' | 'left-open' | 'unverified' | 'permission-limited' | 'failed' | 'not-ours' | 'unlabeled'
  >,
  true satisfies IsMutuallyAssignable<ICloseSuggestionPullRequestsOutcome['status'], CloseSuggestionPullRequestsStatus>,
  true satisfies IsMutuallyAssignable<ICloseSuggestionPullRequestsOutcome['suggestions'][number]['result'], SuggestionCleanupResult>,
  true satisfies IsMutuallyAssignable<ICloseSuggestionPullRequestsOutcome['suggestions'][number]['original'], number | null>,
  true satisfies IsMutuallyAssignable<Awaited<ReturnType<typeof closeSuggestionPullRequests>>, ICloseSuggestionPullRequestsOutcome>,
];

export const minimal: ICloseSuggestionPullRequestsInput = { repository: { owner: 'octo', repo: 'widgets' }, token: 't' };
export const full: ICloseSuggestionPullRequestsInput = {
  repository: { owner: 'octo', repo: 'widgets' },
  token: 't',
  label: 'suggestion',
  originalPullNumber: 37,
  dryRun: true,
};

// @ts-expect-error -- the token is required
export const noToken: ICloseSuggestionPullRequestsInput = { repository: { owner: 'octo', repo: 'widgets' } };
// @ts-expect-error -- the repository is required
export const noRepository: ICloseSuggestionPullRequestsInput = { token: 't' };
// @ts-expect-error -- the original is a pull request number, not a string
export const stringOriginal: ICloseSuggestionPullRequestsInput = { repository: { owner: 'octo', repo: 'widgets' }, token: 't', originalPullNumber: '37' };
// @ts-expect-error -- publication's state path is not cleanup input
export const statePath: ICloseSuggestionPullRequestsInput = { repository: { owner: 'octo', repo: 'widgets' }, token: 't', statePath: '/tmp/x' };
