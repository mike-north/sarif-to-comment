/**
 * The companion-reference component (private internal module; D60;
 * docs/companion-suggestion-pr-contract.md §2.11).
 *
 * The review body's section for one companion suggestion pull request: a
 * link to it by number, the re-application paragraph when it applies, what
 * merging it applies, and the findings that carry its changes. It is how a
 * review explicitly identifies a proposal associated with it (D56). It is
 * rendered only once the pull request exists, because it names its number.
 *
 * A proposal in a bundle of M ≥ 2 (docs/delivery-policy-contract.md §9)
 * keeps its own section at its own position; its link names which proposal
 * of the bundle it is, and its merge sentence says that merging also applies
 * the bundle's other proposals.
 *
 * Rendering:
 *
 *   reference = "**Suggestion pull request:** [#N](" pull request URL ")\n\n" [ re-applied ]
 *               merging (subject "it") "\n\n" change list "\n\n" findings
 *   bundled   = "**Suggestion pull request:** [#N](" pull request URL "), proposal K of M\n\n" [ re-applied ]
 *               "Merging it into " code span of head ref " applies " ( "this change" | "these J changes together" )
 *               ", with the " M-1 " other proposal(s) it bundles:\n\n" change list "\n\n" findings
 */

import { mergeSentence, reappliedParagraph } from './companion-changes.cjs';
import type { ICompanionContent, ICompanionTarget } from './companion-changes.cjs';
import { codeSpan } from './markdown.cjs';

/** A created companion suggestion pull request: its number and web URL. */
export interface ICompanionPullRequest {
  readonly number: number;
  readonly url: string;
}

/** The review body's section for one companion (see the module documentation). */
export function renderCompanionReference(companion: ICompanionContent, pull: ICompanionPullRequest, target: ICompanionTarget): string {
  return `**Suggestion pull request:** [#${String(pull.number)}](${pull.url})\n\n${reappliedParagraph(target, 'the reviewed commit')}`
    + `${mergeSentence(companion.changeCount, 'it', target.headRef)}\n\n${companion.changeLines}\n\n${companion.items}`;
}

/**
 * The review body's section for one proposal of a bundle (see the module
 * documentation): proposal `index` (1-based) of `count`. A bundle of one is
 * referenced exactly as a companion of its own.
 */
export function renderBundledCompanionReference(
  companion: ICompanionContent,
  pull: ICompanionPullRequest,
  target: ICompanionTarget,
  index: number,
  count: number,
): string {
  if (count === 1) return renderCompanionReference(companion, pull, target);
  const what = companion.changeCount === 1 ? 'this change' : `these ${String(companion.changeCount)} changes together`;
  const others = count - 1;
  return `**Suggestion pull request:** [#${String(pull.number)}](${pull.url}), proposal ${String(index)} of ${String(count)}\n\n`
    + `${reappliedParagraph(target, 'the reviewed commit')}Merging it into ${codeSpan(target.headRef)} applies ${what}, `
    + `with the ${String(others)} other proposal${others === 1 ? '' : 's'} it bundles:\n\n${companion.changeLines}\n\n${companion.items}`;
}
