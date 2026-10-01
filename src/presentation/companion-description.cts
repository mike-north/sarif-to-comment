/**
 * A companion suggestion pull request's description (private internal
 * module; D60; docs/companion-suggestion-pr-contract.md §2.7, §2.11).
 *
 * The body of the companion pull request itself: the ordinary reference to
 * the reviewed pull request and commit (which creates GitHub's backlink), the
 * re-application paragraph when it applies, what merging it applies, its
 * lifecycle note, the findings that carry its changes, and — last, on its own
 * line — the structured marker that relates it to the original pull request
 * (docs/suggestion-pr-convention.md §7). The marker is supplied by the caller
 * and placed verbatim; this module never builds or alters it.
 *
 * Rendering:
 *
 *   description = "Suggested in a review of #PULL at commit REVIEWED.\n\n" [ re-applied ]
 *                 merging (subject "this pull request") "\n\n" change list "\n\n" lifecycle note
 *                 "\n\n---\n\n" findings "\n\n" marker
 */

import { mergeSentence, reappliedParagraph } from './companion-changes.cjs';
import type { ICompanionContent, ICompanionTarget } from './companion-changes.cjs';
import { SEPARATOR } from './markdown.cjs';

/** The companion pull request's body, ending with its marker line. */
export function renderCompanionDescription(companion: ICompanionContent, target: ICompanionTarget, lifecycleNote: string, marker: string): string {
  return `Suggested in a review of #${String(target.pullNumber)} at commit ${target.reviewedCommit}.`
    + `\n\n${reappliedParagraph(target, 'that commit')}${mergeSentence(companion.changeCount, 'this pull request', target.headRef)}\n\n${companion.changeLines}\n\n${lifecycleNote}`
    + `${SEPARATOR}${companion.items}\n\n${marker}`;
}
