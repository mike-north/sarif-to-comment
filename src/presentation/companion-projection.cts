/**
 * The projection section of a companion suggestion pull request's description
 * (private internal module; D59, D60; docs/companion-suggestion-pr-contract.md
 * §2.5.1, §2.11).
 *
 * A suggestion pull request is always proposed on the reviewed commit. When a
 * force-push, amend or rebase left that commit out of the original's branch,
 * GitHub shows the suggestion from an older merge base, so its displayed diff
 * also lists the reviewed commit's own changes. This section says so, names
 * the head the suggestion was projected onto, states the projection's verdict
 * (it applies only its own changes, changes nothing because the head already
 * has them, or it conflicts, and where), and shows
 * the suggestion's own changes as a unified diff, separately from GitHub's.
 * It is a fixed part of the description: not customizable, because it is what
 * keeps the proposal's meaning exact.
 *
 * The diff is held to the rule that content is shown exactly. The commit
 * carries the exact bytes, so a character a code block would not show as
 * itself (src/presentation/markdown.cts, visibleCodeLine) is not a reason to
 * withhold the suggestion: it is written as a visible escape, `{U+XXXX}`, and
 * a note after the diff says what the escapes mean.
 *
 * Rendering:
 *
 *   section  = "**The reviewed commit is not part of the branch of #PULL:** the branch was rewritten after commit "
 *              REVIEWED " (its head was " HEAD " when this was proposed). GitHub shows this pull request's changes from an "
 *              "older merge base, so they also list changes of the reviewed commit itself. Projected onto that head before "
 *              "this pull request was created, merging it " verdict [ "\n\n" diff [ "\n\n" escapes ] ]
 *   verdict  = "applies only its own changes, which are " ( "these:" | "listed below." )
 *            | "changes nothing, because the head already has its own changes, which are " ( "these:" | "listed below." )
 *            | "conflicts in " paths "; its own changes are " ( "these:" | "listed below." )
 *   diff     = fence "diff\n" { "--- a/" PATH "\n+++ b/" PATH "\n" { hunk } } fence
 *   hunk     = "@@ -" A [ "," B ] " +" C [ "," D ] " @@\n" { ( " " | "-" | "+" ) line "\n" [ "\ No newline at end of file\n" ] }
 *   escapes  = "In this diff, each `{U+XXXX}` stands for the character with that code point, written visibly; "
 *              "this pull request's commit has the exact bytes."      (only when the diff holds an escape)
 *
 * PATH and every line are written by visibleCodeLine.
 */

import { codeSpan, fenced, visibleCodeLine } from './markdown.cjs';

/** One hunk of a file's own changes (the three-way-merge module's unified hunks). */
export interface IOwnHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly { readonly text: string; readonly noNewline: boolean }[];
}

/** What the projection section states for one suggestion pull request. */
export interface ICompanionProjectionView {
  /** The head the suggestion was projected onto. */
  readonly head: string;
  readonly verdict: 'faithful' | 'conflicts';
  /** Set when faithful and the head already has the suggestion's changes, so merging it changes nothing. */
  readonly alreadyAtHead?: true;
  /** The paths the projection found conflicting, in path order (empty when faithful). */
  readonly conflicts: readonly string[];
  /** Each edited file's hunks from the reviewed file to the proposed one, in change-list order. */
  readonly files: readonly { readonly path: string; readonly hunks: readonly IOwnHunk[] }[];
}

/** Code spans joined like `a`; `a` and `b`; `a`, `b` and `c`. */
function pathList(paths: readonly string[]): string {
  const spans = paths.map(codeSpan);
  const last = spans.at(-1) ?? '';
  return spans.length <= 1 ? last : `${spans.slice(0, -1).join(', ')} and ${last}`;
}

/** "-A,B" or "+C,D": a unified-diff range, with the count left out when it is one. */
function range(sign: string, start: number, count: number): string {
  return count === 1 ? `${sign}${String(start)}` : `${sign}${String(start)},${String(count)}`;
}

/** What follows a diff that holds a visible escape. */
const ESCAPES_NOTE = 'In this diff, each `{U+XXXX}` stands for the character with that code point, written visibly; '
  + 'this pull request\'s commit has the exact bytes.';

/**
 * The suggestion's own changes as one unified diff (without its fence), and
 * whether any character in it is written as a visible escape.
 */
function ownDiff(files: ICompanionProjectionView['files']): { readonly text: string; readonly escaped: boolean } {
  const lines: string[] = [];
  let escaped = false;
  const visible = (value: string): string => {
    const shown = visibleCodeLine(value);
    if (shown !== value) escaped = true;
    return shown;
  };
  for (const file of files) {
    const path = visible(file.path);
    lines.push(`--- a/${path}`, `+++ b/${path}`);
    for (const hunk of file.hunks) {
      lines.push(`@@ ${range('-', hunk.oldStart, hunk.oldLines)} ${range('+', hunk.newStart, hunk.newLines)} @@`);
      for (const line of hunk.lines) {
        // A carriage return before the newline belongs to the line ending, which the diff does not show.
        lines.push(visible(line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text));
        if (line.noNewline) lines.push('\\ No newline at end of file');
      }
    }
  }
  return { text: lines.join('\n'), escaped };
}

/** The projection section (see the module documentation), without a trailing separator. */
export function renderCompanionProjection(view: ICompanionProjectionView, target: { readonly pullNumber: number; readonly reviewedCommit: string }): string {
  const pull = `#${String(target.pullNumber)}`;
  const shown = view.files.length > 0;
  const which = shown ? 'these:' : 'listed below.';
  const verdict = view.verdict === 'conflicts'
    ? `conflicts in ${pathList(view.conflicts)}; its own changes are ${which}`
    : view.alreadyAtHead === true
      ? `changes nothing, because the head already has its own changes, which are ${which}`
      : `applies only its own changes, which are ${which}`;
  const lead = `**The reviewed commit is not part of the branch of ${pull}:** the branch was rewritten after commit ${target.reviewedCommit} `
    + `(its head was ${view.head} when this was proposed). GitHub shows this pull request's changes from an older merge base, `
    + `so they also list changes of the reviewed commit itself. Projected onto that head before this pull request was created, merging it ${verdict}`;
  if (!shown) return lead;
  const diff = ownDiff(view.files);
  const section = `${lead}\n\n${fenced(diff.text, 'diff')}`;
  return diff.escaped ? `${section}\n\n${ESCAPES_NOTE}` : section;
}
