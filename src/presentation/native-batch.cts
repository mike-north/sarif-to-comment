/**
 * The native-batch component (private internal module; D49, D60;
 * docs/delivery-policy-contract.md §8.8).
 *
 * A native batch delivers a group of edits on the original pull request — an
 * explicit group, or a single fix with several changes — as native
 * suggestions in the same review, one per change. The author applies them
 * together by adding all of them to one GitHub suggestion batch, which
 * commits them in one commit. GitHub does not enforce that the changes are
 * applied together; these texts communicate it. The guidance in the review
 * body lists every change by path and line; the note in each change's inline
 * comment points to it. Neither decides which changes form a group or
 * whether a batch is possible, and neither is customizable.
 *
 * Rendering:
 *
 *   guidance = "**" label ":** apply these " K " suggestions together, in one commit: "
 *              "add each of them to one batch of suggestions on the pull request, then commit the batch. "
 *              "Nothing checks that they are applied together.\n\n"
 *              member lines joined by "\n"
 *   member   = "- " code span of path " " lines              (in the order the changes first appear)
 *   note     = "**" label ":** apply this suggestion together with the " owner "'s other "
 *              "suggestions, listed in the review body."
 *
 * where label and owner are src/presentation/group-label.cts's.
 *
 * @see https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/incorporating-feedback-in-your-pull-request#applying-suggested-changes
 */

import { groupOwner, renderGroupLabel } from './group-label.cjs';
import type { GroupLabel } from './group-label.cjs';
import { codeSpan, lineSpan } from './markdown.cjs';

/** One change of a native batch: the lines of the reviewed file its suggestion replaces. */
export interface INativeBatchMember {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** The review body's guidance for a native batch of `members` (its changes), in order. */
export function renderNativeBatchGuidance(label: GroupLabel, members: readonly INativeBatchMember[]): string {
  const lines = members.map((m) => `- ${codeSpan(m.path)} ${lineSpan(m.startLine, m.endLine)}`);
  return `**${renderGroupLabel(label)}:** apply these ${String(members.length)} suggestions together, in one commit: `
    + `add each of them to one batch of suggestions on the pull request, then commit the batch. Nothing checks that they are applied together.\n\n${lines.join('\n')}`;
}

/** The note in each change's inline comment, before its suggestion block. */
export function renderNativeBatchMemberNote(label: GroupLabel): string {
  return `**${renderGroupLabel(label)}:** apply this suggestion together with the ${groupOwner(label)}'s other suggestions, listed in the review body.`;
}
