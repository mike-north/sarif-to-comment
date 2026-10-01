/**
 * How a group of changes delivered on the original pull request is named
 * (private internal module; D49, D60; docs/delivery-policy-contract.md §8.8).
 *
 * A group is either an explicit group the producer or an authoring step named
 * (`suggestionGroup`), or a single SARIF fix with several changes, which has
 * no name of its own and is named by how many changes it makes. Both the
 * native batch and the group made by hand open their guidance, notes and
 * labels with this label, so the reader can match every piece of one group.
 * The label never decides what a group holds.
 *
 * Rendering:
 *
 *   label = "Suggestion group " code span of name     (an explicit group)
 *         | "Fix with " K " changes"                   (a fix with several changes in no group)
 *   owner = "group" | "fix"                            (as a note names the group's other members)
 */

import { codeSpan } from './markdown.cjs';

/** The identity a group of changes is presented under: its explicit name, or the size of the one fix it is. */
export type GroupLabel =
  | { readonly kind: 'group'; readonly name: string }
  | { readonly kind: 'fix'; readonly changeCount: number };

/** The group's label, as its guidance, notes and change labels begin. */
export function renderGroupLabel(label: GroupLabel): string {
  return label.kind === 'group' ? `Suggestion group ${codeSpan(label.name)}` : `Fix with ${String(label.changeCount)} changes`;
}

/** What a note calls the whole the change belongs to: the group, or the fix. */
export function groupOwner(label: GroupLabel): 'group' | 'fix' {
  return label.kind === 'group' ? 'group' : 'fix';
}
