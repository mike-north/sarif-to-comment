'use strict';

/**
 * Independent oracle: applies SARIF text replacements to exact file text.
 *
 * Written from SARIF 2.1.0 §3.30 directly, deliberately sharing no code with
 * src/staged-changes.cjs or src/replacements.cjs, so tests can check that
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

function linesOf(content) {
  const lines = [];
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
function advance(text, count, kind) {
  if (kind === 'utf16CodeUnits') {
    if (count > text.length) throw new Error(`column beyond line (${count} > ${text.length})`);
    return count;
  }
  let index = 0;
  for (let n = 0; n < count; n += 1) {
    if (index >= text.length) throw new Error('column beyond line');
    index += text.codePointAt(index) > 0xffff ? 2 : 1;
  }
  return index;
}

/** The [start, end) UTF-16 span of a region within BOM-stripped content. */
function spanOf(content, region, columnKind) {
  if (region.startLine === undefined) {
    if (region.charOffset === undefined) throw new Error('region has no coordinates');
    return [region.charOffset, region.charOffset + (region.charLength ?? 0)];
  }
  if (!columnKind) throw new Error('oracle requires an explicit columnKind for line regions');
  const lines = linesOf(content);
  const position = (line, column) => {
    const l = lines[line - 1];
    if (!l) throw new Error(`line ${line} does not exist`);
    return l.start + advance(l.body + l.terminator, column - 1, columnKind);
  };
  const endLine = region.endLine ?? region.startLine;
  const start = position(region.startLine, region.startColumn ?? 1);
  const end =
    region.endColumn === undefined
      ? lines[endLine - 1].start + lines[endLine - 1].body.length
      : position(endLine, region.endColumn);
  if (end < start) throw new Error('inverted region');
  return [start, end];
}

/**
 * Applies non-overlapping replacements [{ deletedRegion, insertedText }] to
 * `text` and returns the edited text.
 */
function applyReplacements(text, replacements, columnKind) {
  const hasBom = text.startsWith(BOM);
  let content = hasBom ? text.slice(1) : text;
  const spans = replacements
    .map((r) => ({ span: spanOf(content, r.deletedRegion, columnKind), inserted: r.insertedText }))
    .sort((a, b) => b.span[0] - a.span[0]);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].span[1] > spans[i - 1].span[0]) throw new Error('overlapping replacements');
  }
  for (const { span, inserted } of spans) {
    content = content.slice(0, span[0]) + inserted + content.slice(span[1]);
  }
  return (hasBom ? BOM : '') + content;
}

module.exports = { applyReplacements, linesOf };
