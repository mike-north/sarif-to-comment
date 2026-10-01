/**
 * The manual group component (private internal module; D49, D50, D51, D60;
 * docs/delivery-policy-contract.md §8.10).
 *
 * A group kept whole on the original pull request for the author to assemble
 * by hand and commit once: an edit group delivered by `groupedEdits:
 * manual-group`, or a group with a whole-file creation or deletion delivered
 * by `fileOperations: manual` (the mixed manual group). One review-body
 * section holds the group's guidance — what to do, and that nothing checks
 * it is done — with every change named by path (and lines, for an edit), and
 * then every change, each labelled with the group and its place and
 * presented by its own component (src/presentation/manual-edit.cts, or the
 * file addition and deletion components) with the findings that carry it.
 *
 * The guidance, the member lines and the labels carry the group's identity
 * and complete membership, so they are the core's and not customizable,
 * like a native batch's guidance. The guidance never claims that GitHub or
 * the tool applies the changes together (D49): it is a proposal to make by
 * hand, and none of it is a suggestion.
 *
 * Rendering:
 *
 *   section  = guidance { "\n\n---\n\n" part-label "\n\n" part }
 *   guidance = "**" label ":** apply these " K " changes together, by hand, in one commit: "
 *              "make every change below in a local copy of the pull request's branch, then commit them together. "
 *              "They are not offered as suggestions, and nothing checks that they are applied together.\n\n"
 *              member lines joined by "\n"
 *   member   = "- " code span of path " " lines            (an edit)
 *            | "- " code span of path ": new file"          (a creation)
 *            | "- " code span of path ": file deletion"     (a deletion)
 *   part-label = "**" label " — change " I " of " K "**"
 *
 * one member line and one part per change, in the order the changes first
 * appear, where label is src/presentation/group-label.cts's.
 */

import { renderGroupLabel } from './group-label.cjs';
import type { GroupLabel } from './group-label.cjs';
import { codeSpan, lineSpan, SEPARATOR } from './markdown.cjs';

/** One change of a group made by hand, as its guidance names it. */
export type ManualGroupMember =
  | { readonly kind: 'edit'; readonly path: string; readonly startLine: number; readonly endLine: number }
  | { readonly kind: 'create'; readonly path: string }
  | { readonly kind: 'delete'; readonly path: string };

/** A change of the group with its presented part (the change and the findings that carry it). */
export interface IManualGroupPart {
  readonly member: ManualGroupMember;
  readonly part: string;
}

function memberLine(member: ManualGroupMember): string {
  switch (member.kind) {
    case 'edit': return `- ${codeSpan(member.path)} ${lineSpan(member.startLine, member.endLine)}`;
    case 'create': return `- ${codeSpan(member.path)}: new file`;
    case 'delete': return `- ${codeSpan(member.path)}: file deletion`;
  }
}

/** The group's guidance: what the author does with the `members` (its changes, in order), and the list of them. */
export function renderManualGroupGuidance(label: GroupLabel, members: readonly ManualGroupMember[]): string {
  return `**${renderGroupLabel(label)}:** apply these ${String(members.length)} changes together, by hand, in one commit: `
    + 'make every change below in a local copy of the pull request\'s branch, then commit them together. '
    + `They are not offered as suggestions, and nothing checks that they are applied together.\n\n${members.map(memberLine).join('\n')}`;
}

/** The label of change `number` of `count`, before its part. */
export function renderManualGroupPartLabel(label: GroupLabel, number: number, count: number): string {
  return `**${renderGroupLabel(label)} — change ${String(number)} of ${String(count)}**`;
}

/** The whole section: the guidance, then each change's part under its label. */
export function renderManualGroup(label: GroupLabel, parts: readonly IManualGroupPart[]): string {
  const guidance = renderManualGroupGuidance(label, parts.map((p) => p.member));
  return [guidance, ...parts.map((p, i) => `${renderManualGroupPartLabel(label, i + 1, parts.length)}\n\n${p.part}`)].join(SEPARATOR);
}
