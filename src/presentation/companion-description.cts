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
 * A bundle (docs/delivery-policy-contract.md §9) holds several proposals,
 * each a unit the delivery policy routed to `companion`: its description
 * says that merging applies all of them and that bundling them does not mean
 * they depend on one another (D52), and gives each its own section with its
 * own change list and findings.
 *
 * Rendering:
 *
 *   description = "Suggested in a review of #PULL at commit REVIEWED.\n\n" [ re-applied ]
 *                 merging (subject "this pull request") "\n\n" change list "\n\n" lifecycle note
 *                 "\n\n---\n\n" findings "\n\n" marker
 *   bundle      = "Suggested in a review of #PULL at commit REVIEWED.\n\n" [ re-applied ]
 *                 "This pull request bundles M proposals, each in its own section below. Merging it into "
 *                 code span of head ref " applies all of them; bundling them does not mean they depend on one another.\n\n"
 *                 lifecycle note { "\n\n---\n\n" section } "\n\n" marker
 *   section     = "**Proposal K of M:** " ( "this change" | "these J changes together" ) ":\n\n" change list "\n\n" findings
 */

import { mergeSentence, reappliedParagraph } from './companion-changes.cjs';
import type { ICompanionContent, ICompanionTarget } from './companion-changes.cjs';
import { SEPARATOR, codeSpan } from './markdown.cjs';

/** The companion pull request's body, ending with its marker line. */
export function renderCompanionDescription(companion: ICompanionContent, target: ICompanionTarget, lifecycleNote: string, marker: string): string {
  return `Suggested in a review of #${String(target.pullNumber)} at commit ${target.reviewedCommit}.`
    + `\n\n${reappliedParagraph(target, 'that commit')}${mergeSentence(companion.changeCount, 'this pull request', target.headRef)}\n\n${companion.changeLines}\n\n${lifecycleNote}`
    + `${SEPARATOR}${companion.items}\n\n${marker}`;
}

/** What one proposal of a bundle applies: "this change" or "these J changes together". */
function proposalChanges(changeCount: number): string {
  return changeCount === 1 ? 'this change' : `these ${String(changeCount)} changes together`;
}

/**
 * A bundle's body (docs/delivery-policy-contract.md §9), ending with its
 * marker line: every proposal it holds, one section each, in order. A
 * bundle of one proposal is described exactly as a companion of its own.
 */
export function renderCompanionBundleDescription(
  sections: readonly ICompanionContent[],
  target: ICompanionTarget,
  lifecycleNote: string,
  marker: string,
): string {
  const [only] = sections;
  if (sections.length === 1 && only !== undefined) return renderCompanionDescription(only, target, lifecycleNote, marker);
  const count = String(sections.length);
  const parts = sections.map((section, i) =>
    `**Proposal ${String(i + 1)} of ${count}:** ${proposalChanges(section.changeCount)}:\n\n${section.changeLines}\n\n${section.items}`);
  return `Suggested in a review of #${String(target.pullNumber)} at commit ${target.reviewedCommit}.`
    + `\n\n${reappliedParagraph(target, 'that commit')}This pull request bundles ${count} proposals, each in its own section below. `
    + `Merging it into ${codeSpan(target.headRef)} applies all of them; bundling them does not mean they depend on one another.\n\n${lifecycleNote}`
    + `${SEPARATOR}${parts.join(SEPARATOR)}\n\n${marker}`;
}
