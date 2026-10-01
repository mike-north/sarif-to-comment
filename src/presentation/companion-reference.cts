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
 * Rendering:
 *
 *   reference = "**Suggestion pull request:** [#N](" pull request URL ")\n\n" [ re-applied ]
 *               merging (subject "it") "\n\n" change list "\n\n" findings
 */

import { mergeSentence, reappliedParagraph } from './companion-changes.cjs';
import type { ICompanionContent, ICompanionTarget } from './companion-changes.cjs';

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
