/**
 * Compile-time checks of the public declaration of closeSuggestionPullRequests
 * (docs/suggestion-cleanup-contract.md §2.2, §2.10, §2.12). This file is
 * type-checked by `pnpm run check:types` and never executed.
 *
 * The input requires the repository and the token and nothing else; the
 * outcome's status, each suggestion's result and the owner scope are exactly
 * the contract's closed vocabularies, so a consumer's exhaustive switch keeps
 * compiling only while they are unchanged.
 */
import type {
  CloseSuggestionPullRequestsStatus,
  ICloseSuggestionPullRequestsInput,
  ICloseSuggestionPullRequestsOutcome,
  ISuggestionCleanupCounts,
  OriginalPullRequestState,
  SuggestionCleanupResult,
  SuggestionOwnerScope,
  closeSuggestionPullRequests,
} from '../dist/public-api.cjs';

/** True exactly when `A` and `B` are assignable to each other. */
type IsMutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const vocabularies: readonly true[] = [
  true satisfies IsMutuallyAssignable<
    CloseSuggestionPullRequestsStatus,
    'complete' | 'permission-limited' | 'incomplete' | 'too-many-candidates' | 'label-not-suggestion-prs' | 'original-not-abandoned'
  >,
  true satisfies IsMutuallyAssignable<SuggestionOwnerScope, 'me' | 'all'>,
  true satisfies IsMutuallyAssignable<OriginalPullRequestState, 'open' | 'merged' | 'closed' | 'not-found' | 'unverified'>,
  true satisfies IsMutuallyAssignable<
    SuggestionCleanupResult,
    | 'closed'
    | 'would-close'
    | 'already-closed'
    | 'left-open'
    | 'unverified'
    | 'permission-limited'
    | 'failed'
    | 'not-conforming'
    | 'other-owner'
    | 'unlabeled'
  >,
  true satisfies IsMutuallyAssignable<ICloseSuggestionPullRequestsOutcome['status'], CloseSuggestionPullRequestsStatus>,
  true satisfies IsMutuallyAssignable<ICloseSuggestionPullRequestsOutcome['suggestions'][number]['result'], SuggestionCleanupResult>,
  true satisfies IsMutuallyAssignable<ICloseSuggestionPullRequestsOutcome['suggestions'][number]['original'], number | null>,
  true satisfies IsMutuallyAssignable<Awaited<ReturnType<typeof closeSuggestionPullRequests>>, ICloseSuggestionPullRequestsOutcome>,
  true satisfies IsMutuallyAssignable<ICloseSuggestionPullRequestsOutcome['owner'], SuggestionOwnerScope>,
  true satisfies IsMutuallyAssignable<ICloseSuggestionPullRequestsOutcome['counts'], ISuggestionCleanupCounts>,
  true satisfies IsMutuallyAssignable<ISuggestionCleanupCounts, { readonly candidates: number; readonly checked: number; readonly labeled: number; readonly conforming: number }>,
];

export const minimal: ICloseSuggestionPullRequestsInput = { repository: { owner: 'octo', repo: 'widgets' }, token: 't' };
export const full: ICloseSuggestionPullRequestsInput = {
  repository: { owner: 'octo', repo: 'widgets' },
  token: 't',
  label: 'suggestion',
  originalPullNumber: 37,
  dryRun: true,
  owner: 'all',
  maxCandidates: 1000,
  force: true,
  requireAbandonedOriginal: true,
};

// @ts-expect-error -- the token is required
export const noToken: ICloseSuggestionPullRequestsInput = { repository: { owner: 'octo', repo: 'widgets' } };
// @ts-expect-error -- the repository is required
export const noRepository: ICloseSuggestionPullRequestsInput = { token: 't' };
// @ts-expect-error -- the original is a pull request number, not a string
export const stringOriginal: ICloseSuggestionPullRequestsInput = { repository: { owner: 'octo', repo: 'widgets' }, token: 't', originalPullNumber: '37' };
// @ts-expect-error -- publication's state path is not cleanup input
export const statePath: ICloseSuggestionPullRequestsInput = { repository: { owner: 'octo', repo: 'widgets' }, token: 't', statePath: '/tmp/x' };
// @ts-expect-error -- the owner scope is who opened the suggestion: 'me' or 'all', not an account name
export const namedOwner: ICloseSuggestionPullRequestsInput = { repository: { owner: 'octo', repo: 'widgets' }, token: 't', owner: 'octo' };
// @ts-expect-error -- the candidate limit is a number
export const stringLimit: ICloseSuggestionPullRequestsInput = { repository: { owner: 'octo', repo: 'widgets' }, token: 't', maxCandidates: '500' };
// @ts-expect-error -- requiring an abandoned original is a boolean (contract §2.12)
export const stringGuard: ICloseSuggestionPullRequestsInput = { repository: { owner: 'octo', repo: 'widgets' }, token: 't', originalPullNumber: 37, requireAbandonedOriginal: 'yes' };
// @ts-expect-error -- force is a boolean
export const stringForce: ICloseSuggestionPullRequestsInput = { repository: { owner: 'octo', repo: 'widgets' }, token: 't', force: 'yes' };
