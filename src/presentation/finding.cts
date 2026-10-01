/**
 * The finding component and its source-associated section (private internal
 * module; D60).
 *
 * A finding is one SARIF result as a reader meets it: the producer's stated
 * classification, its explanation, an optional message about its location,
 * the description of its suggested fix, its listed alternatives, and its
 * attribution. It is the unit every other presentation composes — an inline
 * comment shows findings, a native suggestion follows them, a whole-file
 * proposal section lists them, and a companion pull request repeats them.
 * The component never decides where a finding is published or what change
 * accompanies it; it only says what the finding is.
 *
 * A finding section places a finding in the review body with its source
 * association: an exact-revision link to the file (and lines) it concerns
 * and, for a line range, a literal quote of those lines, so feedback that
 * cannot be anchored inline still points at exactly what it is about.
 *
 * Rendering (the module grammar of src/prepare-review.cts):
 *
 *   finding = [ status "\n\n" ] message [ "\n\n**At this location:** " location message ]
 *             [ "\n\n**Fix:** " fix description ] [ "\n\n" alternatives ]
 *             "\n\n<sub>— " attribution "</sub>"
 *   status  = "**Level:** " level, "**Kind:** " kind and "**Baseline:** " state,
 *             those stated, joined by " · "
 *   section = [ "**Source:** [" path " " lines " at " short commit "](" permalink ")\n\n"
 *               fence "\n" source text "\n" fence "\n\n" ] finding
 *             (a whole-file source has no lines and no quote)
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html (3.27.9 kind, 3.27.10 level, 3.27.24 baselineState)
 * @see https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet
 */

import { escapePlainInline, fenced, lineSpan } from './markdown.cjs';

/** The producer's explicit classification of a result; only stated fields are present. */
export interface IFindingClassification {
  readonly level?: string;
  readonly kind?: string;
  readonly baselineState?: string;
}

/** What one finding presents, each text already Markdown. */
export interface IFindingContent {
  readonly classification: IFindingClassification | undefined;
  /** The finding's explanation. */
  readonly message: string;
  /** The message of the finding's one location, when it has one. */
  readonly locationMessage: string | undefined;
  /** The description of the finding's suggested (first) fix, when it has one. */
  readonly fixDescription: string | undefined;
  /** The rendered alternatives component, or undefined when the finding has none. */
  readonly alternatives: string | undefined;
  /** The rendered attribution component. */
  readonly attribution: string;
}

/**
 * The exact source a finding section quotes: a file at a commit, its
 * permalink, and — for a line range — the lines and their literal text.
 */
export type QuotedSource =
  | { readonly path: string; readonly commit: string; readonly url: string; readonly lines?: undefined }
  | { readonly path: string; readonly commit: string; readonly url: string; readonly lines: { readonly startLine: number; readonly endLine: number; readonly text: string } };

/** One finding (see the module documentation). */
export function renderFinding(finding: IFindingContent): string {
  const c: IFindingClassification = finding.classification || {};
  const stated: readonly (readonly [label: string, value: string | undefined])[] = [['Level', c.level], ['Kind', c.kind], ['Baseline', c.baselineState]];
  const status = stated
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined).map(([label, value]) => `**${label}:** ${value}`).join(' · ');
  const location = finding.locationMessage === undefined ? '' : `\n\n**At this location:** ${finding.locationMessage}`;
  const fix = finding.fixDescription === undefined ? '' : `\n\n**Fix:** ${finding.fixDescription}`;
  const alternatives = finding.alternatives === undefined ? '' : `\n\n${finding.alternatives}`;
  return `${status === '' ? '' : `${status}\n\n`}${finding.message}${location}${fix}${alternatives}\n\n<sub>— ${finding.attribution}</sub>`;
}

/**
 * A rendered finding in the review body with its source association, when
 * it has a source: the exact-revision link and, for lines, their literal quote.
 */
export function renderFindingSection(finding: string, source: QuotedSource | undefined): string {
  if (source === undefined) return finding;
  const short = source.commit.slice(0, 7);
  if (source.lines === undefined) {
    return `**Source:** [${escapePlainInline(source.path)} at ${short}](${source.url})\n\n${finding}`;
  }
  const { startLine, endLine, text } = source.lines;
  return `**Source:** [${escapePlainInline(source.path)} ${lineSpan(startLine, endLine)} at ${short}](${source.url})\n\n${fenced(text)}\n\n${finding}`;
}
