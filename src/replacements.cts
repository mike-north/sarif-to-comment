/**
 * Exact application of one SARIF existing-file text replacement, and its
 * minimal closed whole-line candidate (private internal module).
 *
 * Applies a single SARIF `replacement` (a `deletedRegion` plus inserted text)
 * to the complete original text of one existing file, reproducing the literal
 * edit the SARIF producer intended. Separately, it describes the smallest
 * closed range of whole source lines whose exact replacement reproduces that
 * edit, preserving any untouched prefix and suffix on those lines.
 *
 * This module never decides which feedback belongs to a replacement, never
 * enlarges a range to collect nearby feedback, never groups or merges several
 * replacements, and never decides how a host renders the candidate or whether
 * a host may apply it. It performs no I/O, does not parse SARIF documents, is
 * deterministic, and does not mutate its input.
 *
 * Region semantics (SARIF 2.1.0 sections 3.30.5-3.30.13, 3.57, and schema):
 *   - Lines and columns are 1-based. An absent startColumn is 1 and an absent
 *     endLine equals startLine. endColumn is exclusive; an absent endColumn
 *     ends the region at the end of endLine *before* its newline sequence, so
 *     a line-only region never consumes a newline. Equal start and end
 *     positions denote an insertion.
 *   - Columns count UTF-16 code units or Unicode code points according to the
 *     required `columnKind`; SARIF gives it no normative default.
 *   - Region values never depend on a leading byte-order mark: line 1 column 1
 *     and charOffset 0 both address the first character after it. The raw mark
 *     is never deleted by a coordinate and stays in editedText and in line 1's
 *     originalText and replacementText.
 *   - charOffset/charLength is an independent zero-based form. charOffset -1
 *     (its default) means unset; charLength defaults to 0. Offsets count every
 *     newline character. SARIF does not
 *     fix whether offsets count UTF-16 code units or code points, and
 *     `columnKind` governs columns only, so an offset span whose two readings
 *     differ is unsupported unless `charOffsetKind` states the unit.
 *   - When both forms are present they must denote the same span.
 *
 * Lines are physical lines under the default SARIF newline sequences (CRLF,
 * then LF); a lone CR is ordinary line content. A terminal newline creates no
 * addressable line, but the position just after it (line count + 1, column 1)
 * is a valid insertion point or region end; an empty source's only position
 * is (1, 1). That same end-of-file position may also be written as the column
 * on the terminated last line that counts its terminator's characters (SARIF
 * 3.30.2, Example 8); a column inside a terminal CRLF is unsupported, and an
 * omitted endColumn still ends before the terminator.
 *
 * Output (one of):
 *   { kind: 'replacement', editedText, startLine, endLine, originalText,
 *     replacementText, replacementLines, endsWithNewline }
 *       editedText is the exact edited file. startLine..endLine (1-based,
 *       inclusive) are existing source lines; originalText is exactly those
 *       lines including each line's terminator, and replacementText is the
 *       exact text that replaces originalText to yield editedText, including
 *       every terminator it intends. replacementLines is replacementText as a
 *       sequence of lines, each keeping its terminator: [] is zero lines and
 *       ['\n'] one blank line. endsWithNewline { original, edited } reports
 *       whether each file ends with a newline sequence, exposing any change
 *       for later host-eligibility policy.
 *   { kind: 'unanchored', reason: 'empty-source', message, editedText }
 *       A valid edit of an empty source, which has no line to anchor.
 *   { kind: 'invalid', reason, message }
 *       The request cannot denote a literal edit of sourceText.
 *   { kind: 'unsupported', reason, message }
 *       The request may be valid SARIF but lies outside the verified profile
 *       (an active byteOffset or non-zero byteLength, non-default newline
 *       sequences, ambiguous offsets, a non-zero charLength without an
 *       active charOffset, a column inside a terminal CRLF). Serialized
 *       schema defaults (charOffset/byteOffset -1, charLength/byteLength 0)
 *       mean "absent" and never change a line/column region.
 */

/** A SARIF unit for counting text positions (columnKind, and the caller-declared charOffsetKind). */
export type ColumnKind = 'utf16CodeUnits' | 'unicodeCodePoints';

/** Reasons a request cannot denote a literal edit of the source. */
export type InvalidReplacementReason =
  | 'invalid-request'
  | 'invalid-source-text'
  | 'invalid-inserted-text'
  | 'missing-column-kind'
  | 'unknown-column-kind'
  | 'unknown-char-offset-kind'
  | 'invalid-newline-sequences'
  | 'invalid-region'
  | 'out-of-bounds'
  | 'splits-surrogate-pair'
  | 'inverted-region'
  | 'coordinate-disagreement';

/** Reasons a possibly valid SARIF request lies outside the verified profile. */
export type UnsupportedReplacementReason =
  | 'newline-sequences'
  | 'column-within-terminator'
  | 'ambiguous-char-offset'
  | 'byte-region'
  | 'char-length-without-offset';

/**
 * A SARIF region as `applyReplacement` reads it. Every property is optional
 * and checked at runtime; see the module documentation for its semantics.
 */
export interface IReplacementRegion {
  readonly startLine?: number;
  readonly startColumn?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly charOffset?: number;
  readonly charLength?: number;
  readonly byteOffset?: number;
  readonly byteLength?: number;
}

/**
 * One replacement request as `applyReplacement` accepts it. The function
 * itself takes `unknown`: every field is checked at runtime and an invalid
 * request is an `invalid` outcome.
 */
export interface IReplacementRequest {
  /** Complete original file text, exact characters. */
  readonly sourceText: string;
  /** SARIF region (startLine, startColumn, endLine, endColumn, charOffset, charLength). */
  readonly deletedRegion: IReplacementRegion;
  /** Literal inserted text ('' for pure deletion). */
  readonly insertedText: string;
  /** Unit of columns. */
  readonly columnKind: ColumnKind;
  /** Unit of charOffset/charLength when it matters. */
  readonly charOffsetKind?: ColumnKind | undefined;
  /** Declared SARIF newline sequences. */
  readonly newlineSequences?: readonly string[] | undefined;
}

/** The exact edited file and its minimal closed whole-line candidate. */
export interface IAppliedReplacement {
  readonly kind: 'replacement';
  readonly editedText: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly originalText: string;
  readonly replacementText: string;
  readonly replacementLines: readonly string[];
  readonly endsWithNewline: { readonly original: boolean; readonly edited: boolean };
}

/** A valid edit of an empty source, which has no line to anchor. */
export interface IUnanchoredReplacement {
  readonly kind: 'unanchored';
  readonly reason: 'empty-source';
  readonly message: string;
  readonly editedText: string;
}

/** The request cannot denote a literal edit of sourceText. */
export interface IInvalidReplacement {
  readonly kind: 'invalid';
  readonly reason: InvalidReplacementReason;
  readonly message: string;
}

/** The request may be valid SARIF but lies outside the verified profile. */
export interface IUnsupportedReplacement {
  readonly kind: 'unsupported';
  readonly reason: UnsupportedReplacementReason;
  readonly message: string;
}

/** A diagnostic outcome: the request was not applied. */
export type ReplacementDiagnostic = IInvalidReplacement | IUnsupportedReplacement;

/** One outcome of `applyReplacement`. */
export type ReplacementOutcome = IAppliedReplacement | IUnanchoredReplacement | ReplacementDiagnostic;

/** A resolved [start, end) UTF-16 span of the source. */
interface ISpan {
  readonly start: number;
  readonly end: number;
}

/** A source line as UTF-16 index spans (see lineSpans). */
interface ILineSpan {
  readonly start: number;
  readonly columnStart: number;
  readonly contentEnd: number;
  readonly end: number;
}

/** A region object whose properties have not been checked yet. */
type UncheckedRegion = Readonly<Record<string, unknown>>;

/** The line/column form of a region after its fields are checked as positive integers. */
interface ILineRegion {
  readonly startLine: number;
  readonly startColumn?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

/**
 * The request fields `applyReplacement` uses once checkRequest has accepted
 * them. The region's properties are checked later, by resolveRegion.
 */
interface IAcceptedRequest {
  readonly kind: 'accepted';
  readonly sourceText: string;
  readonly insertedText: string;
  readonly columnKind: ColumnKind;
  readonly charOffsetKind: ColumnKind | undefined;
  readonly deletedRegion: UncheckedRegion;
}

/**
 * The two SARIF units for counting text positions: columnKind values, and the
 * caller-declared charOffsetKind convention for offsets.
 */
const UNIT_KINDS: ReadonlySet<unknown> = new Set<ColumnKind>(['utf16CodeUnits', 'unicodeCodePoints']);

/**
 * SARIF's default run.newlineSequences, the only line delimiters this module
 * supports. Greedy matching in either order splits text identically: CRLF
 * cannot start at an LF, and an LF alone never matches CRLF.
 */
const DEFAULT_NEWLINE_SEQUENCES: readonly string[] = ['\r\n', '\n'];

/**
 * A leading U+FEFF, which region coordinates skip but edits never remove.
 * Built from its code point because the character itself is invisible and
 * an editor or formatter could silently strip a literal copy.
 */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** Region properties of the line/column coordinate form; startLine anchors the others. */
const LINE_FIELDS = ['startLine', 'startColumn', 'endLine', 'endColumn'] as const;

/** A request that cannot denote a literal edit of the source. */
function invalid(reason: InvalidReplacementReason, message: string): IInvalidReplacement {
  return { kind: 'invalid', reason, message };
}

/** A request that may be valid SARIF but lies outside the verified profile. */
function unsupported(reason: UnsupportedReplacementReason, message: string): IUnsupportedReplacement {
  return { kind: 'unsupported', reason, message };
}

/** Whether a resolution step produced a diagnostic outcome instead of a value. */
function isDiagnostic(value: unknown): value is ReplacementDiagnostic {
  return value !== null && typeof value === 'object' && 'kind' in value && typeof value.kind === 'string';
}

/** Whether a value can be a request or SARIF region: a non-null, non-array object. */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `Array.isArray` narrowed to a read-only array of unchecked elements. */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Whether a value is one of the two SARIF units. */
function isUnitKind(value: unknown): value is ColumnKind {
  return UNIT_KINDS.has(value);
}

/** Whether a value is an integer of at least `minimum` (false for every non-number, as Number.isInteger is). */
function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= minimum;
}

/**
 * The element at `index` of a list whose bounds the caller has already
 * established. Reaching the throw means an internal invariant was broken.
 */
function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Internal error: index ${String(index)} is outside a list of ${String(items.length)}.`);
  return item;
}

/** Whether a UTF-16 code unit is the first half of a supplementary-plane character. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Whether a UTF-16 code unit is the second half of a supplementary-plane character. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Whether a UTF-16 index falls between the two halves of one surrogate pair. */
function splitsSurrogatePair(text: string, index: number): boolean {
  return (
    index > 0 &&
    index < text.length &&
    isHighSurrogate(text.charCodeAt(index - 1)) &&
    isLowSurrogate(text.charCodeAt(index))
  );
}

/**
 * Physical lines under the default newline sequences, each string keeping its
 * own terminator. A lone CR is content; a terminal newline adds no line.
 */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Source lines as UTF-16 index spans: `start` (the raw line start),
 * `columnStart` (where column 1 lies: after a leading byte-order mark on line
 * 1, otherwise the line start), `contentEnd` (before the terminator) and `end`
 * (after it).
 */
function lineSpans(sourceText: string): ILineSpan[] {
  const spans: ILineSpan[] = [];
  let start = 0;
  for (const line of splitLines(sourceText)) {
    const terminator = line.endsWith('\r\n') ? 2 : line.endsWith('\n') ? 1 : 0;
    const end = start + line.length;
    const columnStart = start === 0 && line.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK.length : start;
    spans.push({ start, columnStart, contentEnd: end - terminator, end });
    start = end;
  }
  return spans;
}

/**
 * UTF-16 index reached by advancing `count` units of `kind` from `from` in
 * `text`, or a diagnostic when that runs past `limit` or lands inside a
 * surrogate pair.
 */
function advanceUnits(text: string, from: number, count: number, kind: ColumnKind, limit: number): number | IInvalidReplacement {
  if (kind === 'utf16CodeUnits') {
    const index = from + count;
    if (index > limit) {
      return invalid('out-of-bounds', `A coordinate lies ${String(index - limit)} UTF-16 code unit(s) beyond the addressed text.`);
    }
    if (splitsSurrogatePair(text, index)) {
      return invalid('splits-surrogate-pair', `A UTF-16 coordinate at index ${String(index)} falls inside a surrogate pair.`);
    }
    return index;
  }
  let index = from;
  for (let n = 0; n < count; n += 1) {
    if (index >= limit) {
      return invalid('out-of-bounds', 'A code-point coordinate lies beyond the addressed text.');
    }
    // index < limit <= text.length, so a code point exists here.
    const code = text.codePointAt(index);
    index += code !== undefined && code > 0xffff ? 2 : 1;
  }
  return index > limit ? invalid('out-of-bounds', 'A code-point coordinate lies beyond the addressed text.') : index;
}

/**
 * Validates the request shape and profile-level declarations, returning the
 * accepted fields or the first diagnostic.
 */
function checkRequest(request: unknown): IAcceptedRequest | ReplacementDiagnostic {
  if (!isPlainObject(request)) {
    return invalid('invalid-request', 'The replacement request must be an object.');
  }
  const { sourceText, insertedText, columnKind, charOffsetKind, newlineSequences, deletedRegion } = request;
  if (typeof sourceText !== 'string') {
    return invalid('invalid-source-text', 'sourceText must be the complete original file text as a string.');
  }
  if (typeof insertedText !== 'string') {
    return invalid(
      'invalid-inserted-text',
      "insertedText must be a string; pass '' for a replacement whose insertedContent is absent.",
    );
  }
  if (columnKind === undefined) {
    return invalid(
      'missing-column-kind',
      "columnKind is required ('utf16CodeUnits' or 'unicodeCodePoints'); SARIF defines no default for it.",
    );
  }
  if (!isUnitKind(columnKind)) {
    return invalid('unknown-column-kind', `columnKind ${JSON.stringify(columnKind)} is not a SARIF column kind.`);
  }
  if (charOffsetKind !== undefined && !isUnitKind(charOffsetKind)) {
    return invalid(
      'unknown-char-offset-kind',
      `charOffsetKind ${JSON.stringify(charOffsetKind)} must be 'utf16CodeUnits' or 'unicodeCodePoints'.`,
    );
  }
  if (newlineSequences !== undefined) {
    if (!isArray(newlineSequences) || !newlineSequences.every((s) => typeof s === 'string')) {
      return invalid('invalid-newline-sequences', 'newlineSequences must be an array of strings.');
    }
    const isDefaultSet =
      newlineSequences.length === DEFAULT_NEWLINE_SEQUENCES.length &&
      DEFAULT_NEWLINE_SEQUENCES.every((s) => newlineSequences.includes(s));
    if (!isDefaultSet) {
      return unsupported(
        'newline-sequences',
        `Only the default SARIF newline sequences (CRLF, LF) are supported; got ${JSON.stringify(newlineSequences)}.`,
      );
    }
  }
  if (!isPlainObject(deletedRegion)) {
    return invalid('invalid-region', 'deletedRegion must be a SARIF region object.');
  }
  return { kind: 'accepted', sourceText, insertedText, columnKind, charOffsetKind, deletedRegion };
}

/** Resolves a line/column position to a UTF-16 index, or a diagnostic. */
function linePosition(
  sourceText: string,
  lines: readonly ILineSpan[],
  line: number,
  column: number,
  columnKind: ColumnKind,
): number | ReplacementDiagnostic {
  const atEndOfFile = sourceText === '' || sourceText.endsWith('\n');
  if (line === lines.length + 1 && atEndOfFile) {
    return column === 1
      ? sourceText.length
      : invalid('out-of-bounds', `Line ${String(line)} is the end-of-file position and has only column 1.`);
  }
  if (line > lines.length) {
    return invalid('out-of-bounds', `Line ${String(line)} does not exist; the source has ${String(lines.length)} line(s).`);
  }
  const span = itemAt(lines, line - 1);
  // SARIF 3.30.2 (Example 8): a region may end at the end of the file with a
  // column on the last line that counts its terminator's characters. Only a
  // terminated last line gains columns past its content, and only the column
  // landing exactly at the end of the file is taken to address a position.
  const reachesEndOfFile = line === lines.length && span.end > span.contentEnd;
  const limit = reachesEndOfFile ? span.end : span.contentEnd;
  const index = advanceUnits(sourceText, span.columnStart, column - 1, columnKind, limit);
  if (isDiagnostic(index) && index.reason === 'out-of-bounds') {
    return invalid('out-of-bounds', `Column ${String(column)} lies beyond the end of line ${String(line)} (columns are ${columnKind}).`);
  }
  if (!isDiagnostic(index) && index > span.contentEnd && index < span.end) {
    return unsupported(
      'column-within-terminator',
      `Column ${String(column)} of line ${String(line)} falls inside its CRLF terminator; only the end-of-file column past a terminal newline is supported.`,
    );
  }
  return index;
}

/** Resolves the line/column form of a region to a UTF-16 span, or a diagnostic. */
function resolveLineForm(
  sourceText: string,
  lines: readonly ILineSpan[],
  region: ILineRegion,
  columnKind: ColumnKind,
): ISpan | ReplacementDiagnostic {
  const startLine = region.startLine;
  const startColumn = region.startColumn ?? 1;
  const endLine = region.endLine ?? startLine;
  const endColumn = region.endColumn;
  if (endLine < startLine || (endLine === startLine && endColumn !== undefined && endColumn < startColumn)) {
    return invalid('inverted-region', 'The region ends before it starts.');
  }
  const start = linePosition(sourceText, lines, startLine, startColumn, columnKind);
  if (isDiagnostic(start)) return start;
  let end: number;
  if (endColumn === undefined) {
    if (endLine > lines.length) {
      return invalid('out-of-bounds', `Line ${String(endLine)} does not exist; the source has ${String(lines.length)} line(s).`);
    }
    end = itemAt(lines, endLine - 1).contentEnd;
  } else {
    const position = linePosition(sourceText, lines, endLine, endColumn, columnKind);
    if (isDiagnostic(position)) return position;
    end = position;
  }
  if (end < start) {
    return invalid('inverted-region', 'The region ends before it starts.');
  }
  return { start, end };
}

/** The UTF-16 span a charOffset/charLength pair denotes when counted in `kind`, or a diagnostic. */
function offsetSpan(sourceText: string, charOffset: number, charLength: number, kind: ColumnKind): ISpan | ReplacementDiagnostic {
  const base = sourceText.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK.length : 0;
  const start = advanceUnits(sourceText, base, charOffset, kind, sourceText.length);
  if (isDiagnostic(start)) return start;
  const end = advanceUnits(sourceText, start, charLength, kind, sourceText.length);
  if (isDiagnostic(end)) return end;
  return { start, end };
}

/**
 * Whether two coordinate resolutions are equivalent: the same UTF-16 span, or
 * the same diagnostic kind and reason. Used both for form agreement and for
 * deciding whether two offset-unit readings actually differ.
 */
function sameResolution(a: ISpan | ReplacementDiagnostic, b: ISpan | ReplacementDiagnostic): boolean {
  return isDiagnostic(a) || isDiagnostic(b)
    ? isDiagnostic(a) && isDiagnostic(b) && a.kind === b.kind && a.reason === b.reason
    : a.start === b.start && a.end === b.end;
}

/** Resolves the character form of a region to a UTF-16 span, or a diagnostic. */
function resolveOffsetForm(
  sourceText: string,
  charOffset: number,
  charLength: number,
  charOffsetKind: ColumnKind | undefined,
): ISpan | ReplacementDiagnostic {
  if (charOffsetKind !== undefined) {
    return offsetSpan(sourceText, charOffset, charLength, charOffsetKind);
  }
  const asCodeUnits = offsetSpan(sourceText, charOffset, charLength, 'utf16CodeUnits');
  const asCodePoints = offsetSpan(sourceText, charOffset, charLength, 'unicodeCodePoints');
  if (!sameResolution(asCodeUnits, asCodePoints)) {
    return unsupported(
      'ambiguous-char-offset',
      'charOffset/charLength denote different text when counted as UTF-16 code units and as code points; ' +
        'supply charOffsetKind to state the producer convention.',
    );
  }
  return asCodeUnits;
}

/** Resolves a SARIF region to one UTF-16 span of sourceText, or a diagnostic. */
function resolveRegion(
  sourceText: string,
  lines: readonly ILineSpan[],
  region: UncheckedRegion,
  columnKind: ColumnKind,
  charOffsetKind: ColumnKind | undefined,
): ISpan | ReplacementDiagnostic {
  const { byteOffset, byteLength } = region;
  if (byteOffset !== undefined && !isIntegerAtLeast(byteOffset, -1)) {
    return invalid('invalid-region', `byteOffset must be an integer of at least -1; got ${JSON.stringify(byteOffset)}.`);
  }
  if (byteLength !== undefined && !isIntegerAtLeast(byteLength, 0)) {
    return invalid('invalid-region', `byteLength must be a non-negative integer; got ${JSON.stringify(byteLength)}.`);
  }
  // byteOffset -1 and byteLength 0 are the schema defaults meaning "no byte
  // form"; a producer that serializes them states nothing about bytes. Any
  // active offset, or a non-zero length, is a byte form this module cannot
  // resolve and must not silently ignore.
  if ((byteOffset ?? -1) !== -1 || (byteLength ?? 0) !== 0) {
    return unsupported('byte-region', 'Byte offsets are not supported; express the region with lines/columns or characters.');
  }
  // The checked line/column fields, collected as they are validated.
  const lineFields: { -readonly [K in keyof ILineRegion]?: number } = {};
  for (const field of LINE_FIELDS) {
    const value = region[field];
    if (value === undefined) continue;
    if (!isIntegerAtLeast(value, 1)) {
      return invalid('invalid-region', `${field} must be a positive integer; got ${JSON.stringify(value)}.`);
    }
    lineFields[field] = value;
  }
  const { charOffset, charLength } = region;
  if (charOffset !== undefined && !isIntegerAtLeast(charOffset, -1)) {
    return invalid('invalid-region', `charOffset must be an integer of at least -1; got ${JSON.stringify(charOffset)}.`);
  }
  if (charLength !== undefined && !isIntegerAtLeast(charLength, 0)) {
    return invalid('invalid-region', `charLength must be a non-negative integer; got ${JSON.stringify(charLength)}.`);
  }
  const { startLine } = lineFields;
  const hasLineForm = startLine !== undefined;
  const hasOffsetForm = charOffset !== undefined && charOffset !== -1;
  if (!hasLineForm && LINE_FIELDS.some((field) => region[field] !== undefined)) {
    return invalid('invalid-region', 'A region with line or column properties requires startLine.');
  }
  // charLength 0 is its schema default and carries no meaning without an
  // active charOffset; a non-zero length there would be silently lost.
  if ((charLength ?? 0) !== 0 && !hasOffsetForm) {
    return unsupported('char-length-without-offset', 'charLength is present without an effective charOffset.');
  }
  if (!hasLineForm && !hasOffsetForm) {
    return invalid('invalid-region', 'The region has neither startLine nor charOffset.');
  }
  const lineSpan = hasLineForm ? resolveLineForm(sourceText, lines, { ...lineFields, startLine }, columnKind) : null;
  if (isDiagnostic(lineSpan)) return lineSpan;
  const offsetSpanResult = hasOffsetForm ? resolveOffsetForm(sourceText, charOffset, charLength ?? 0, charOffsetKind) : null;
  if (isDiagnostic(offsetSpanResult)) return offsetSpanResult;
  if (lineSpan && offsetSpanResult && !sameResolution(lineSpan, offsetSpanResult)) {
    return invalid('coordinate-disagreement', 'The line/column and charOffset/charLength coordinates denote different text.');
  }
  const span = lineSpan ?? offsetSpanResult;
  // At least one form is present (checked above), so one of them resolved.
  if (span === null) throw new Error('Internal error: a region with a coordinate form resolved to no span.');
  return span;
}

/** Index of the line containing a UTF-16 index that addresses a source character. */
function lineIndexOf(lines: readonly ILineSpan[], index: number): number {
  return lines.findIndex((span) => span.start <= index && index < span.end);
}

/**
 * The minimal closed line range reproducing the edit of [start, end): lines
 * the edit touches, plus the following line only when replacement content
 * would otherwise run into it.
 */
function candidateRange(
  sourceText: string,
  lines: readonly ILineSpan[],
  start: number,
  end: number,
  insertedText: string,
): { readonly first: number; readonly last: number } {
  const last = lines.length - 1;
  // The end-of-file position addresses no character, so an insertion there
  // (after a terminal newline, or after an unterminated last line) is
  // anchored on the last existing line, which the replacement preserves.
  const first = start === sourceText.length ? last : lineIndexOf(lines, start);
  if (end === start) return { first, last: first };
  const endLine = lineIndexOf(lines, end - 1);
  if (end === itemAt(lines, endLine).end) {
    const lead = sourceText.slice(itemAt(lines, first).start, start) + insertedText;
    const joinsNextLine = lead !== '' && !lead.endsWith('\n') && endLine < last;
    return { first, last: joinsNextLine ? endLine + 1 : endLine };
  }
  return { first, last: endLine };
}

/**
 * Applies one SARIF text replacement to one existing file's text.
 *
 * @param request - an {@link IReplacementRequest}: `sourceText` (complete
 *   original file text, exact characters), `deletedRegion` (SARIF region:
 *   startLine, startColumn, endLine, endColumn, charOffset, charLength),
 *   `insertedText` (literal inserted text, '' for pure deletion), `columnKind`
 *   ('utf16CodeUnits' or 'unicodeCodePoints', the unit of columns), optional
 *   `charOffsetKind` (unit of charOffset/charLength when it matters) and
 *   optional `newlineSequences` (declared SARIF newline sequences)
 * @returns one outcome: replacement, unanchored, invalid or unsupported
 */
export function applyReplacement(request: unknown): ReplacementOutcome {
  const accepted = checkRequest(request);
  if (accepted.kind !== 'accepted') return accepted;
  const { sourceText, deletedRegion, insertedText, columnKind, charOffsetKind } = accepted;
  const lines = lineSpans(sourceText);
  const span = resolveRegion(sourceText, lines, deletedRegion, columnKind, charOffsetKind);
  if (isDiagnostic(span)) return span;

  const editedText = sourceText.slice(0, span.start) + insertedText + sourceText.slice(span.end);
  if (lines.length === 0) {
    return {
      kind: 'unanchored',
      reason: 'empty-source',
      message: 'The source is empty, so no existing line can anchor a whole-line candidate.',
      editedText,
    };
  }

  const range = candidateRange(sourceText, lines, span.start, span.end, insertedText);
  const rangeStart = itemAt(lines, range.first).start;
  const rangeEnd = itemAt(lines, range.last).end;
  const replacementText =
    sourceText.slice(rangeStart, span.start) + insertedText + sourceText.slice(span.end, rangeEnd);
  return {
    kind: 'replacement',
    editedText,
    startLine: range.first + 1,
    endLine: range.last + 1,
    originalText: sourceText.slice(rangeStart, rangeEnd),
    replacementText,
    replacementLines: splitLines(replacementText),
    endsWithNewline: { original: sourceText.endsWith('\n'), edited: editedText.endsWith('\n') },
  };
}
