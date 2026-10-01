/**
 * The manual edit component (private internal module; D49, D60;
 * docs/delivery-policy-contract.md §8.10).
 *
 * One edit of a reviewed file that the author makes by hand, presented in the
 * review body of the original pull request: an ungrouped edit delivered by
 * `edits: review-body`, or one change of a group made by hand. It states the
 * edit as its exact whole-line replacement — a permalink to the replaced
 * lines at the reviewed commit, a code block of the new lines, and the
 * details the block cannot show (CRLF line endings, a missing final newline)
 * — so the block and details together determine the replacement's bytes.
 * Then come the findings that carry it. It is never a suggestion: nothing in
 * it is a `suggestion` code block, so no part of it can be applied through
 * GitHub's suggestion feature, alone or in a batch.
 *
 * Preparation decides which lines are shown, whether they can be shown
 * exactly, and where the section goes; this component decides only how it
 * reads.
 *
 * Rendering:
 *
 *   edit        = "**Proposed edit, to make by hand:** " replacement "\n\n" findings
 *   replacement = "replace " location " with" [ " (" details ")" ] ":\n\n" block
 *               | "delete " location "."                     (the lines are removed)
 *   location    = "[" path " " lines " at " short commit "](" permalink ")"
 *   block       = fence "\n" replacement lines, LF-separated, without the last line's
 *                 terminator or the file's own byte-order mark "\n" fence
 *   details     = "CRLF line endings" and/or "no newline at end of file", joined by ", "
 *
 * @see https://github.github.com/gfm/#fenced-code-blocks
 * @see https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet
 */

import { escapePlainInline, fenced, lineSpan } from './markdown.cjs';

/** The new lines of an edit, as the block shows them and the details state what it cannot. */
export interface IManualReplacement {
  /** The replacement lines with LF line breaks, without the last line's terminator or the file's own byte-order mark. */
  readonly shownText: string;
  /** Whether the replacement's lines end with CRLF. */
  readonly crlf: boolean;
  /** Whether the replacement's last line ends with a line terminator (only a replacement that ends the file can lack one). */
  readonly finalNewline: boolean;
}

/** One edit made by hand: the replaced lines of a reviewed file, their permalink, and the new lines (none when they are removed). */
export interface IManualEdit {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** The reviewed commit the lines are read at. */
  readonly commit: string;
  /** The permalink to the replaced lines at that commit. */
  readonly url: string;
  readonly replacement: IManualReplacement | undefined;
}

/** The link to the replaced lines at the reviewed commit, naming the file and lines as literal text. */
export function manualEditLocation(edit: IManualEdit): string {
  return `[${escapePlainInline(edit.path)} ${lineSpan(edit.startLine, edit.endLine)} at ${edit.commit.slice(0, 7)}](${edit.url})`;
}

/** The code block of the new lines, or undefined when the lines are removed. */
export function manualEditBlock(edit: IManualEdit): string | undefined {
  return edit.replacement === undefined ? undefined : fenced(edit.replacement.shownText);
}

/** What the block cannot show about the new lines, or undefined when there is nothing to state. */
export function manualEditDetails(edit: IManualEdit): string | undefined {
  const { replacement } = edit;
  if (replacement === undefined) return undefined;
  const details = [
    ...(replacement.crlf ? ['CRLF line endings'] : []),
    ...(replacement.finalNewline ? [] : ['no newline at end of file']),
  ];
  return details.length === 0 ? undefined : details.join(', ');
}

/** The edit as its exact replacement: "replace … with …:" and the block, or "delete … .". */
export function renderManualReplacement(edit: IManualEdit): string {
  const location = manualEditLocation(edit);
  const block = manualEditBlock(edit);
  if (block === undefined) return `delete ${location}.`;
  const details = manualEditDetails(edit);
  return `replace ${location} with${details === undefined ? '' : ` (${details})`}:\n\n${block}`;
}

/** The manual edit section: the replacement once, then `findings` (its rendered findings, joined). */
export function renderManualEdit(edit: IManualEdit, findings: string): string {
  return `**Proposed edit, to make by hand:** ${renderManualReplacement(edit)}\n\n${findings}`;
}
