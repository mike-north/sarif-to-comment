/**
 * The file-addition component (private internal module; D60;
 * docs/file-operation-publication-contract.md §2).
 *
 * A proposal to add a new file to the repository, presented in the review
 * body: its destination path, details that together with the displayed
 * content determine the file's exact bytes, the content itself in a code
 * block no line of it can close, and then every finding that carries the
 * proposal. A finding located in the new file names its lines of the
 * proposed content (never lines of the reviewed snapshot, where the file does
 * not exist). Addition is distinct from editing an existing file and from
 * deletion; this component presents only the addition.
 *
 * Rendering:
 *
 *   addition = "**Proposed new file:** " code span of path "\n\n**File details:** " details
 *              [ "\n\n" fence "\n" content "\n" fence ] "\n\n" findings
 *   details  = facts joined by " · " (see fileDetails)
 *   content  = the text without a leading byte-order mark and without exactly
 *              one final line terminator; no block for an empty file or one
 *              holding only a byte-order mark
 *   finding in the new file = [ "**Location:** " lines " of the proposed file\n\n" ] finding
 *
 * @see https://github.github.com/gfm/#fenced-code-blocks
 */

import { codeSpan, fenced, lineSpan } from './markdown.cjs';

/** The Git modes a proposed new file may have. */
export type ProposedFileMode = '100644' | '100755';

/** Byte-order mark: kept in a proposed file, stated in its details rather than shown. */
const BOM = '﻿';

/** A proposed new file: its repository path, exact text and mode. */
export interface IFileAddition {
  readonly path: string;
  readonly text: string;
  readonly fileMode: ProposedFileMode;
}

/** The text a proposed file's block shows, and the parts of its bytes the block cannot show. */
function displayed(text: string): { readonly hasBom: boolean; readonly body: string; readonly finalTerminator: string; readonly shown: string } {
  const hasBom = text.startsWith(BOM);
  const body = hasBom ? text.slice(BOM.length) : text;
  const finalTerminator = body.endsWith('\r\n') ? '\r\n' : body.endsWith('\n') ? '\n' : '';
  return { hasBom, body, finalTerminator, shown: body.slice(0, body.length - finalTerminator.length) };
}

/**
 * The details of a proposed new file that, with its displayed content,
 * determine its exact bytes (contract §2, "Content and facts").
 */
export function fileDetails(text: string, fileMode: ProposedFileMode): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  const { hasBom, body, finalTerminator } = displayed(text);
  const facts: string[] = [];
  if (bytes === 0) {
    facts.push('empty file (0 bytes)');
  } else {
    facts.push(`${String(bytes)} byte${bytes === 1 ? '' : 's'} of UTF-8 text`);
    if (hasBom) facts.push('begins with a byte-order mark');
    if (body === '') {
      facts.push('no content after the byte-order mark');
    } else {
      facts.push(body.includes('\r\n') ? 'CRLF line endings' : body.includes('\n') ? 'LF line endings' : 'no line breaks');
      facts.push(finalTerminator === '' ? 'no newline at end of file' : 'ends with a newline');
    }
  }
  facts.push(fileMode === '100755' ? 'mode 100755 (executable)' : 'mode 100644');
  return facts.join(' · ');
}

/** The code block showing a proposed file's content, or undefined when there is no content to show. */
export function proposedContentBlock(text: string): string | undefined {
  const { body, shown } = displayed(text);
  return body === '' ? undefined : fenced(shown);
}

/** A rendered finding carried by a proposed new file, after the lines of the proposed content it names, if any. */
export function renderProposedFileFinding(lines: { readonly startLine: number; readonly endLine: number } | null, finding: string): string {
  if (!lines) return finding;
  return `**Location:** ${lineSpan(lines.startLine, lines.endLine)} of the proposed file\n\n${finding}`;
}

/** The addition section: the proposal once, then `findings` (its rendered findings, joined). */
export function renderFileAddition(addition: IFileAddition, findings: string): string {
  const block = proposedContentBlock(addition.text);
  return `**Proposed new file:** ${codeSpan(addition.path)}\n\n**File details:** ${fileDetails(addition.text, addition.fileMode)}`
    + `${block === undefined ? '' : `\n\n${block}`}\n\n${findings}`;
}
