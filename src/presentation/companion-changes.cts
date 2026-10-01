/**
 * What a companion suggestion pull request changes, as both its own
 * description and the review's reference to it state it (private internal
 * module; D60; docs/companion-suggestion-pr-contract.md §2.11).
 *
 * A companion suggestion pull request carries changes that cannot be offered
 * as native suggestions — whole-file proposals, a fix with several changes,
 * an explicit group — as one proposal into the reviewed pull request's head
 * branch. These shared pieces say what merging it applies: the change list
 * (one line per change, in order of first appearance), the sentence that
 * introduces it, and, when the proposal was re-applied onto a rewritten
 * head, the paragraph that says so. They never decide what a companion holds.
 *
 * Rendering:
 *
 *   change   = "- Edited [" path " " lines " at " short "](" permalink ")"
 *            | "- New file " code span of path ": " file details
 *            | "- Deleted file [" path " at " short "](" permalink "): the whole file is removed"
 *   merging  = "Merging " subject " into " code span of head ref " applies "
 *              ( "this change" | "these " K " changes together" ) ":"
 *   re-applied = "The history of #PULL was rewritten after " after ", so this change is re-applied onto commit "
 *                H ", the head of #PULL when it was proposed, where everything it changes is still exactly as reviewed.\n\n"
 */

import { fileDetails } from './file-addition.cjs';
import type { ProposedFileMode } from './file-addition.cjs';
import { codeSpan, escapePlainInline, lineSpan } from './markdown.cjs';

/** The reviewed pull request a companion proposes into, as its texts name it. */
export interface ICompanionTarget {
  readonly pullNumber: number;
  readonly reviewedCommit: string;
  /** The original pull request's head branch, which the companion targets. */
  readonly headRef: string;
  /** Whether the companion is created ready for review instead of as a draft. */
  readonly ready: boolean;
  /** The commit the companion is re-applied onto after a rewritten history, when it is (contract §2.5.1). */
  readonly reappliedOnto?: string;
}

/** A companion's rendered content: how many changes it lists, the change list, and its findings. */
export interface ICompanionContent {
  readonly changeCount: number;
  /** The rendered change list ("- …" lines). */
  readonly changeLines: string;
  /** The rendered findings carrying these changes. */
  readonly items: string;
}

/** One change a companion makes, with the permalink an edit or deletion links to. */
export type CompanionChange =
  | { readonly kind: 'edit'; readonly path: string; readonly startLine: number; readonly endLine: number; readonly commit: string; readonly url: string }
  | { readonly kind: 'create'; readonly path: string; readonly text: string; readonly fileMode: ProposedFileMode }
  | { readonly kind: 'delete'; readonly path: string; readonly commit: string; readonly url: string };

/** One line of a companion's change list. */
export function renderCompanionChange(change: CompanionChange): string {
  switch (change.kind) {
    case 'edit':
      return `- Edited [${escapePlainInline(change.path)} ${lineSpan(change.startLine, change.endLine)} at ${change.commit.slice(0, 7)}](${change.url})`;
    case 'create':
      return `- New file ${codeSpan(change.path)}: ${fileDetails(change.text, change.fileMode)}`;
    case 'delete':
      return `- Deleted file [${escapePlainInline(change.path)} at ${change.commit.slice(0, 7)}](${change.url}): the whole file is removed`;
  }
}

/** "Merging SUBJECT into `HEAD` applies this change:" or "… these K changes together:". */
export function mergeSentence(changeCount: number, subject: string, headRef: string): string {
  const what = changeCount === 1 ? 'this change' : `these ${String(changeCount)} changes together`;
  return `Merging ${subject} into ${codeSpan(headRef)} applies ${what}:`;
}

/**
 * The paragraph that says a companion was re-applied onto a rewritten head
 * (contract §2.11), naming what it was rewritten after: "that commit" in the
 * companion's own description, whose first line names it, "the reviewed
 * commit" in the review. Empty when it was not re-applied.
 */
export function reappliedParagraph(target: Pick<ICompanionTarget, 'pullNumber' | 'reappliedOnto'>, after: string): string {
  if (target.reappliedOnto === undefined) return '';
  const pull = `#${String(target.pullNumber)}`;
  return `The history of ${pull} was rewritten after ${after}, so this change is re-applied onto commit ${target.reappliedOnto}, `
    + `the head of ${pull} when it was proposed, where everything it changes is still exactly as reviewed.\n\n`;
}
