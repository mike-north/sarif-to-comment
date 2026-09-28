/**
 * Independent oracle: applies SARIF text replacements to exact file text.
 *
 * Written from SARIF 2.1.0 §3.30 directly, deliberately sharing no code with
 * src/staged-changes.cts or src/replacements.cts, so tests can check that
 * extracted edits reproduce independently authored staged bytes (contract
 * §4.3, "Independent R2 oracle").
 *
 * Interpretation:
 *   - Lines are physical lines split after each LF (a CRLF line keeps its CR;
 *     a lone CR is content). A terminal newline creates no further line.
 *   - A leading U+FEFF is excluded from coordinates and never replaced.
 *   - startColumn defaults to 1, endLine to startLine; an omitted endColumn
 *     ends before endLine's terminator.
 *   - Columns count UTF-16 code units or Unicode code points per columnKind.
 *     A column may address the position just after the final line's
 *     terminator (SARIF §3.30.2 Example 8).
 *   - charOffset/charLength count UTF-16 code units after any BOM.
 */

const BOM = '﻿';

/** How SARIF columns count: UTF-16 code units or Unicode code points (the SARIF run's columnKind). */
export type ColumnKind = 'utf16CodeUnits' | 'unicodeCodePoints';

/** A SARIF region (§3.30): line/column coordinates, or a character offset and length. */
export interface IOracleRegion {
  readonly startLine?: number | undefined;
  readonly startColumn?: number | undefined;
  readonly endLine?: number | undefined;
  readonly endColumn?: number | undefined;
  readonly charOffset?: number | undefined;
  readonly charLength?: number | undefined;
}

/** One replacement: the region to delete and the exact text inserted in its place. */
export interface IOracleReplacement {
  readonly deletedRegion: IOracleRegion;
  readonly insertedText: string;
}

/** One physical line: where it starts, its content, and its terminator ('\r\n', '\n' or ''). */
export interface IOracleLine {
  readonly start: number;
  readonly body: string;
  readonly terminator: string;
}

export function linesOf(content: string): IOracleLine[] {
  const lines: IOracleLine[] = [];
  let start = 0;
  while (start < content.length) {
    const lf = content.indexOf('\n', start);
    const end = lf === -1 ? content.length : lf + 1;
    const raw = content.slice(start, end);
    const terminator = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
    lines.push({ start, body: raw.slice(0, raw.length - terminator.length), terminator });
    start = end;
  }
  return lines;
}

/** UTF-16 index reached after `count` units of `kind` within `text`. */
function advance(text: string, count: number, kind: ColumnKind): number {
  if (kind === 'utf16CodeUnits') {
    if (count > text.length) throw new Error(`column beyond line (${String(count)} > ${String(text.length)})`);
    return count;
  }
  let index = 0;
  for (let n = 0; n < count; n += 1) {
    if (index >= text.length) throw new Error('column beyond line');
    // index < text.length, so a code point exists at index.
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }
  return index;
}

/** The [start, end) UTF-16 span of a region within BOM-stripped content. */
function spanOf(content: string, region: IOracleRegion, columnKind: ColumnKind | undefined): [number, number] {
  if (region.startLine === undefined) {
    if (region.charOffset === undefined) throw new Error('region has no coordinates');
    return [region.charOffset, region.charOffset + (region.charLength ?? 0)];
  }
  if (!columnKind) throw new Error('oracle requires an explicit columnKind for line regions');
  const lines = linesOf(content);
  const position = (line: number, column: number): number => {
    const l = lines[line - 1];
    if (!l) throw new Error(`line ${String(line)} does not exist`);
    return l.start + advance(l.body + l.terminator, column - 1, columnKind);
  };
  const endLine = region.endLine ?? region.startLine;
  const start = position(region.startLine, region.startColumn ?? 1);
  const lineEnd = (line: number): number => {
    const l = lines[line - 1];
    if (!l) throw new Error(`line ${String(line)} does not exist`);
    return l.start + l.body.length;
  };
  const end = region.endColumn === undefined ? lineEnd(endLine) : position(endLine, region.endColumn);
  if (end < start) throw new Error('inverted region');
  return [start, end];
}

/**
 * Applies non-overlapping replacements [{ deletedRegion, insertedText }] to
 * `text` and returns the edited text.
 */
export function applyReplacements(
  text: string,
  replacements: readonly IOracleReplacement[],
  columnKind?: ColumnKind,
): string {
  const hasBom = text.startsWith(BOM);
  let content = hasBom ? text.slice(1) : text;
  const spans = replacements
    .map((r) => ({ span: spanOf(content, r.deletedRegion, columnKind), inserted: r.insertedText }))
    .sort((a, b) => b.span[0] - a.span[0]);
  for (const [i, current] of spans.entries()) {
    const previous = spans[i - 1];
    if (previous && current.span[1] > previous.span[0]) throw new Error('overlapping replacements');
  }
  for (const { span, inserted } of spans) {
    content = content.slice(0, span[0]) + inserted + content.slice(span[1]);
  }
  return (hasBom ? BOM : '') + content;
}
