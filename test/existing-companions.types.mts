/**
 * Compile-time checks of the public `existingCompanions` option
 * (docs/companion-suggestion-pr-contract.md §2.13.1). This file is
 * type-checked by `pnpm run check:types` and never executed.
 *
 * The option is a read-only list of pull request numbers, taken by
 * publication and readiness assessment alike; anything else is a compile
 * error, as it is a runtime `TypeError`.
 */
import type {
  ICompanionIndexPresentationContext,
  ICompanionPresentation,
  ICompanionReferencePresentationContext,
  IPublishSarifReviewOptions,
  IReviewPresentation,
  IValidateSarifReviewInput,
} from '../dist/public-api.cjs';

/** True exactly when `A` and `B` are assignable to each other. */
type IsMutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const shapes: readonly true[] = [
  true satisfies IsMutuallyAssignable<IPublishSarifReviewOptions['existingCompanions'], readonly number[] | undefined>,
  true satisfies IsMutuallyAssignable<NonNullable<IValidateSarifReviewInput['options']>['existingCompanions'], readonly number[] | undefined>,
];

export const none: IPublishSarifReviewOptions = { existingCompanions: [] };
export const some: IPublishSarifReviewOptions = { existingCompanions: [97, 98] };
const frozen: readonly number[] = Object.freeze([97]);
export const readOnly: IPublishSarifReviewOptions = { existingCompanions: frozen };

// @ts-expect-error -- a pull request is named by its number, not by a reference string.
export const reference: IPublishSarifReviewOptions = { existingCompanions: ['#97'] };
// @ts-expect-error -- a list, never a single number.
export const single: IPublishSarifReviewOptions = { existingCompanions: 97 };

// The companion index and each companion's section are customizable (D60;
// docs/review-presentation-contract.md §7): their contexts name every
// companion with its number, link, title, origin and, for a reused one, state.
export const indexCallback: IReviewPresentation['companionIndex'] = (context: ICompanionIndexPresentationContext) =>
  context.companions.map((companion: ICompanionPresentation) => `${companion.link} ${companion.origin === 'reused' ? companion.state ?? '' : ''}`).join('\n');
export const referenceCallback: IReviewPresentation['companionReference'] = (context: ICompanionReferencePresentationContext) =>
  `${context.companion.link} (${String(context.proposal)}/${String(context.proposals)})\n\n${context.changes}\n\n${context.findings}`;
export const origins: readonly true[] = [
  true satisfies IsMutuallyAssignable<ICompanionPresentation['origin'], 'created' | 'reused'>,
  true satisfies IsMutuallyAssignable<ICompanionPresentation['state'], 'open' | 'draft' | 'closed' | 'merged' | undefined>,
];
// @ts-expect-error -- a callback returns Markdown, not the context.
export const wrongReturn: IReviewPresentation['companionIndex'] = (context: ICompanionIndexPresentationContext) => context;
