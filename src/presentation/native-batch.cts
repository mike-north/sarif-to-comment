/**
 * The native-batch component (private internal module; D49, D60;
 * docs/delivery-policy-contract.md §8.8).
 *
 * A native batch delivers an explicit group of edits on the original pull
 * request: every change of the group is a native suggestion in the same
 * review, and the author applies them together by adding all of them to one
 * GitHub suggestion batch, which commits them in one commit. GitHub does not
 * enforce that the members are applied together; these texts communicate
 * it. The guidance in the review body lists every member by path and line;
 * the note in each member's inline comment points to it. Neither decides
 * which changes form a group or whether a batch is possible, and neither is
 * customizable.
 *
 * Rendering:
 *
 *   guidance = "**Suggestion group " code span of name ":** apply these " K " suggestions together, in one commit: "
 *              "add each of them to one batch of suggestions on the pull request, then commit the batch.\n\n"
 *              member lines joined by "\n"
 *   member   = "- " code span of path " " lines              (in the order the changes first appear)
 *   note     = "**Suggestion group " code span of name ":** apply this suggestion together with the group's other "
 *              "suggestions, listed in the review body."
 *
 * @see https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/incorporating-feedback-in-your-pull-request#applying-suggested-changes
 */

import { codeSpan, lineSpan } from './markdown.cjs';

/** One member of a native batch: the lines of the reviewed file its suggestion replaces. */
export interface INativeBatchMember {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** The review body's guidance for a native batch of `members`, in order. */
export function renderNativeBatchGuidance(group: string, members: readonly INativeBatchMember[]): string {
  const lines = members.map((m) => `- ${codeSpan(m.path)} ${lineSpan(m.startLine, m.endLine)}`);
  return `**Suggestion group ${codeSpan(group)}:** apply these ${String(members.length)} suggestions together, in one commit: `
    + `add each of them to one batch of suggestions on the pull request, then commit the batch.\n\n${lines.join('\n')}`;
}

/** The note in each member's inline comment, before its suggestion block. */
export function renderNativeBatchMemberNote(group: string): string {
  return `**Suggestion group ${codeSpan(group)}:** apply this suggestion together with the group's other suggestions, listed in the review body.`;
}
