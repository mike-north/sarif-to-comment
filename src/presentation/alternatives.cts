/**
 * The alternatives component (private internal module; D60, issue #30).
 *
 * A finding's further SARIF fixes, listed with it as alternatives the reader
 * may consider, in the producer's order. Nothing is chosen, applied, grouped
 * or unioned: the finding's first fix is its suggested change, presented by
 * its own component, and each alternative only shows the exact whole-line
 * changes of reviewed files it would make. The replacement lines appear in
 * code blocks that no content can close, with a CRLF line-ending style stated
 * beside the block (the block itself shows LF breaks).
 *
 * Rendering (docs/review-presentation-contract.md §4):
 *
 *   alternatives = "**Alternatives to consider:**" { "\n\n" alternative }
 *   alternative  = "(" n ") " [ description "\n\n" ] changes     (n = 1, 2, …)
 *   changes      = "Replace " lines [ " of " code span of path ] " with" crlf ":\n\n" block
 *                | "Delete " lines [ " of " code span of path ] "."
 *                    (one change; the path is named only when it differs from
 *                    the first fix's file)
 *                | ( "Changes " N " files together:" | "Makes " N " changes together:" )
 *                  { "\n\n" code span of path " — " ( "replace " lines " with" crlf ":\n\n" block
 *                    | "delete " lines "." ) }
 *   crlf         = " (CRLF line endings)" when the replacement's lines end with CRLF, else ""
 *
 * @see https://github.com/mike-north/sarif-to-comment/issues/30
 * @see https://github.github.com/gfm/#fenced-code-blocks
 */

import { codeSpan, fenced, lineSpan } from './markdown.cjs';

/** One change an alternative makes: an exact whole-line replacement (or deletion) of lines of one reviewed file. */
export interface IAlternativeChange {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** The exact replacement lines; empty for a deletion of the lines. */
  readonly replacementText: string;
  /** The replacement lines as the code block shows them: LF line breaks, without the final terminator. */
  readonly shownText: string;
  /** Whether the replacement's lines end with CRLF, which is then stated beside the block. */
  readonly crlf: boolean;
}

/** One listed alternative: its Markdown description, if the fix has one, and its changes in the fix's order. */
export interface IAlternative {
  readonly description: string | undefined;
  readonly changes: readonly IAlternativeChange[];
}

/**
 * The heading and every alternative of one finding, or undefined when it
 * has none. `primaryPath` is the first fix's single file, if it has one.
 */
export function renderAlternatives(alternatives: readonly IAlternative[], primaryPath: string | undefined): string | undefined {
  if (alternatives.length === 0) return undefined;
  return `**Alternatives to consider:**${alternatives.map((a, i) => `\n\n${renderAlternative(a, i + 1, primaryPath)}`).join('')}`;
}

/** One alternative: its number, its description, and its changes. */
export function renderAlternative(alternative: IAlternative, number: number, primaryPath: string | undefined): string {
  const { description } = alternative;
  return `(${String(number)}) ${description === undefined ? '' : `${description}\n\n`}${renderAlternativeChanges(alternative, primaryPath)}`;
}

/**
 * The changes an alternative makes, exactly as listed. A one-change
 * alternative names its file only when it is not the first fix's; each change
 * of a several-change alternative is labelled with its file.
 */
export function renderAlternativeChanges({ changes }: IAlternative, primaryPath: string | undefined): string {
  const [only] = changes;
  if (changes.length === 1 && only !== undefined) {
    const lines = lineSpan(only.startLine, only.endLine);
    const where = only.path === primaryPath ? lines : `${lines} of ${codeSpan(only.path)}`;
    return only.replacementText === '' ? `Delete ${where}.` : `Replace ${where} with${changeBlock(only)}`;
  }
  const files = new Set(changes.map((c) => c.path)).size;
  const heading = files > 1 ? `Changes ${String(files)} files together:` : `Makes ${String(changes.length)} changes together:`;
  const labelled = changes.map((c) => {
    const lines = lineSpan(c.startLine, c.endLine);
    return `${codeSpan(c.path)} — ${c.replacementText === '' ? `delete ${lines}.` : `replace ${lines} with${changeBlock(c)}`}`;
  });
  return `${heading}${labelled.map((part) => `\n\n${part}`).join('')}`;
}

/** The end of "replace … with": the stated line-ending style, if CRLF, and the fenced lines. */
function changeBlock(change: IAlternativeChange): string {
  return `${change.crlf ? ' (CRLF line endings)' : ''}:\n\n${fenced(change.shownText)}`;
}
