/**
 * The file-deletion component (private internal module; D60;
 * docs/file-operation-publication-contract.md §2).
 *
 * A proposal to remove a whole file that exists at the reviewed commit,
 * presented in the review body: an exact-revision link to the file, the
 * statement that the whole file is removed (which distinguishes deletion
 * from emptying it or from an edit), and then every finding that carries the
 * proposal. The file's content is never shown or narrowed: a finding's
 * quoted lines only explain the proposal.
 *
 * Rendering:
 *
 *   deletion = "**Proposed file deletion:** [" path " at " short commit "](" permalink ")\n\n"
 *              "The whole file is removed; this is not a proposal to empty it.\n\n" findings
 *
 * @see https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet
 */

import { escapePlainInline } from './markdown.cjs';

/** A proposed deletion: the file's repository path, the reviewed commit it exists at, and its permalink there. */
export interface IFileDeletion {
  readonly path: string;
  readonly commit: string;
  readonly url: string;
}

/** The deletion section: the proposal once, then `findings` (its rendered findings, joined). */
export function renderFileDeletion(deletion: IFileDeletion, findings: string): string {
  return `**Proposed file deletion:** [${escapePlainInline(deletion.path)} at ${deletion.commit.slice(0, 7)}](${deletion.url})\n\n`
    + `The whole file is removed; this is not a proposal to empty it.\n\n${findings}`;
}
