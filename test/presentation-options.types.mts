/**
 * Compile-time checks of the public presentation callbacks
 * (`options.presentation`, IReviewPresentation). This file is type-checked by
 * `pnpm run check:types` and never executed.
 *
 * Each named component takes its own context and returns Markdown; unknown
 * components, non-function values and callbacks that return anything but a
 * string are compile errors, as they are runtime refusals. The option is
 * shared by publication and readiness assessment.
 */
import type {
  IAlternativesPresentationContext,
  IAttributionPresentationContext,
  IFileAdditionPresentationContext,
  IFindingPresentationContext,
  IPresentationContext,
  IPublishSarifReviewOptions,
  IReviewPresentation,
  IValidateSarifReviewInput,
} from '../dist/public-api.cjs';

/** True exactly when `A` and `B` are assignable to each other. */
type IsMutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const shapes: readonly true[] = [
  true satisfies IsMutuallyAssignable<IPublishSarifReviewOptions['presentation'], IReviewPresentation | undefined>,
  true satisfies IsMutuallyAssignable<NonNullable<IValidateSarifReviewInput['options']>['presentation'], IReviewPresentation | undefined>,
  true satisfies IsMutuallyAssignable<Parameters<NonNullable<IReviewPresentation['finding']>>[0], IFindingPresentationContext>,
  true satisfies IsMutuallyAssignable<ReturnType<NonNullable<IReviewPresentation['attribution']>>, string>,
  true satisfies IsMutuallyAssignable<IFileAdditionPresentationContext['content'], string | undefined>,
  true satisfies IsMutuallyAssignable<IPresentationContext['required'], readonly string[]>,
];

export const none: IReviewPresentation = {};
export const empty: IPublishSarifReviewOptions = { presentation: {} };
export const some: IPublishSarifReviewOptions = {
  presentation: {
    finding: (c) => `${c.message}\n\n${c.attribution}`,
    attribution: (c: IAttributionPresentationContext) => `by ${c.tool}`,
    alternatives: (c: IAlternativesPresentationContext) => c.alternatives.map((a) => a.changes).join('\n\n'),
    fileAddition: (c) => c.markdown,
    fileDeletion: (c) => `${c.url}\n\n${c.findings}`,
    lifecycleNote: (c) => (c.ready ? 'ready' : 'draft'),
  },
};

// @ts-expect-error -- not a component: presentation names semantic elements only
export const unknownComponent: IReviewPresentation = { header: () => 'x' };
// @ts-expect-error -- a callback, not a Markdown string
export const notAFunction: IReviewPresentation = { finding: '**x**' };
// @ts-expect-error -- a callback returns Markdown text
export const notMarkdown: IReviewPresentation = { finding: () => 42 };
// @ts-expect-error -- each component receives its own context
export const wrongContext: IReviewPresentation = { lifecycleNote: (c: IFindingPresentationContext) => c.message };
// @ts-expect-error -- contexts are read-only
export const mutate: IReviewPresentation = { finding: (c) => { c.message = 'x'; return c.markdown; } };
