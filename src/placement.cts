/**
 * Exact source placement for review feedback (private internal module).
 *
 * Decides whether a trusted reviewed-source association can be anchored inline
 * on a pull request's diff surface, must be presented as general feedback with
 * an exact-revision link, is explicitly unsupported, or is inconsistent and
 * rejected. Placement is never approximated: a source association is either
 * anchored to exactly the same lines of text on a verified diff side or not
 * anchored at all. Choosing how to present a non-inline outcome belongs to
 * caller policy (D3), not to this module.
 *
 * Two identities stay distinct:
 * - Source identity (`result.source`): the reviewed commit, path, inclusive
 *   line range and literal text. Placement never rewrites it.
 * - Host anchor (`result.anchor`): GitHub's review-comment coordinates. LEFT
 *   addresses deleted base lines; RIGHT addresses added or unchanged-context
 *   lines in head numbering. Unchanged base-source context is therefore
 *   anchored RIGHT. The anchor's `commit_id` is always the diff head.
 *
 * Input:
 *   {
 *     source: {
 *       commit: string,  // full 40-hex lowercase commit of the reviewed snapshot
 *       path: string,    // normalized repository-relative path ("/" separators)
 *       text: string,    // complete file text at that commit, exact characters
 *     },
 *     range: { startLine: number, endLine: number }, // inclusive, 1-based, absolute in source
 *     diff: {
 *       baseCommit: string, // verified commit whose text is the patch's old side
 *                           // (for a GitHub pull request, its diff base)
 *       headCommit: string, // reviewed commit whose text is the patch's new side:
 *                           // the reviewed diff (docs/specification.md R13.1),
 *                           // whether or not it is the pull request's head
 *       files: Array<{ path: string, previousPath?: string, patch?: string }>,
 *     },
 *   }
 *
 * The caller is responsible for the provenance of `diff`: this module checks
 * that a patch agrees with the supplied source text, not that the patch is the
 * one the host displays.
 *
 * A line is one physical line of `source.text`; a terminal newline does not
 * create an additional addressable line. `text` in results is the exact source
 * substring of the range without the final line's terminator, so inner CRLF
 * terminators and non-ASCII characters are preserved.
 *
 * Output (one of):
 *   { kind: 'inline', source: SourceRange,
 *     anchor: { commit_id, path, side: 'LEFT'|'RIGHT', line, start_line?, start_side? } }
 *   { kind: 'general', reason, source: SourceRange }
 *   { kind: 'unsupported', reason, source: SourceRange }
 *   { kind: 'rejected', reason, message }
 * where SourceRange = { commit, path, startLine, endLine, text }.
 *
 * Reasons:
 *   general     outside-diff-hunks          range not wholly inside one hunk on its side
 *               file-not-in-diff            file unchanged by the diff
 *               source-commit-not-diff-side source commit is neither diff side (a provenance
 *                                           revision other than the reviewed commit
 *                                           and the diff base)
 *               no-single-side-anchor       base range mixes deletions and context, or is
 *                                           interrupted by other diff rows
 *   unsupported rename-unsupported          file renamed by the diff
 *               patch-unavailable           changed file has no usable hunks (absent, empty,
 *                                           binary or header-only patch)
 *   rejected    invalid-input               request shape, commit or path format
 *               invalid-diff                diff identity is self-contradictory
 *               invalid-range               range is not a positive ascending integer pair
 *               range-out-of-bounds         range exceeds the source's addressable lines
 *               malformed-patch             patch structure is not a consistent unified diff
 *               diff-path-mismatch          patch file headers name another path
 *               patch-source-mismatch       patch disagrees with the source text or existence
 */


/** Which side of a unified diff a source snapshot is: the base (old) or the head (new). */
type PatchSide = 'old' | 'new';

/** GitHub's review-comment side: LEFT is deleted base lines, RIGHT is head lines. */
export type PlacementAnchorSide = 'LEFT' | 'RIGHT';

/** Reasons a valid range is presented as general feedback rather than anchored inline. */
export type PlacementGeneralReason =
  | 'outside-diff-hunks'
  | 'file-not-in-diff'
  | 'source-commit-not-diff-side'
  | 'no-single-side-anchor';

/** Reasons inline placement is explicitly unsupported for a changed file. */
export type PlacementUnsupportedReason = 'rename-unsupported' | 'patch-unavailable';

/** Reasons a request is inconsistent and rejected outright. */
export type PlacementRejectedReason =
  | 'invalid-input'
  | 'invalid-diff'
  | 'invalid-range'
  | 'range-out-of-bounds'
  | 'malformed-patch'
  | 'diff-path-mismatch'
  | 'patch-source-mismatch';

/** The reviewed snapshot a range addresses: commit, normalized path and complete file text. */
export interface IPlacementSource {
  readonly commit: string;
  readonly path: string;
  readonly text: string;
}

/** An inclusive, 1-based line range, absolute in the source. */
export interface IPlacementRange {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * One changed file of the diff. `previousPath` and `patch` may be absent or
 * explicitly undefined; both mean "not supplied".
 */
export interface IPlacementDiffFile {
  readonly path: string;
  readonly previousPath?: string | undefined;
  readonly patch?: string | undefined;
}

/** The pull request diff: its verified base and head commits and changed files. */
export interface IPlacementDiff {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly files: readonly IPlacementDiffFile[];
}

/**
 * A placement request as `classifyPlacement` accepts it after validation (see
 * the module documentation). The function itself takes `unknown`: every field
 * is checked at runtime and an invalid request is a `rejected` outcome.
 */
export interface IPlacementRequest {
  readonly source: IPlacementSource;
  readonly range: IPlacementRange;
  readonly diff: IPlacementDiff;
}

/** The exact validated source range every non-rejected outcome carries unchanged. */
export interface IPlacementSourceRange {
  readonly commit: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

/**
 * GitHub review-comment coordinates. `start_line` and `start_side` are
 * present only for a multi-line anchor, and `commit_id` is always the diff head.
 */
export interface IPlacementAnchor {
  readonly commit_id: string;
  readonly path: string;
  readonly side: PlacementAnchorSide;
  readonly line: number;
  readonly start_line?: number;
  readonly start_side?: PlacementAnchorSide;
}

/** The range is anchored inline at exactly the same lines of text. */
export interface IInlinePlacement {
  readonly kind: 'inline';
  readonly source: IPlacementSourceRange;
  readonly anchor: IPlacementAnchor;
}

/** The range is valid but belongs in general feedback with an exact-revision link. */
export interface IGeneralPlacement {
  readonly kind: 'general';
  readonly reason: PlacementGeneralReason;
  readonly source: IPlacementSourceRange;
}

/** Inline placement is explicitly unsupported for this file. */
export interface IUnsupportedPlacement {
  readonly kind: 'unsupported';
  readonly reason: PlacementUnsupportedReason;
  readonly source: IPlacementSourceRange;
}

/** The request or its diff is inconsistent; no source range is trusted. */
export interface IRejectedPlacement {
  readonly kind: 'rejected';
  readonly reason: PlacementRejectedReason;
  readonly message: string;
}

/** One placement outcome; never a relocated range. */
export type PlacementOutcome = IInlinePlacement | IGeneralPlacement | IUnsupportedPlacement | IRejectedPlacement;

/**
 * The request after its shape and identity formats are validated. The range
 * is still unchecked here: it is validated against the source's line count.
 */
interface IShapedRequest {
  readonly source: IPlacementSource;
  readonly range: Readonly<Record<string, unknown>>;
  readonly diff: IPlacementDiff;
}

/** One physical source line: its start index, its body without "\n" (any "\r" kept), and whether "\n" ends it. */
interface ISourceLine {
  readonly start: number;
  readonly body: string;
  readonly hasNewline: boolean;
}

/**
 * One display row of a hunk, with absolute line numbers on the sides it
 * occupies (the other side is absent). `noNewline` is set once a
 * "\ No newline at end of file" marker follows the row.
 */
interface IPatchRowBase {
  readonly text: string;
  noNewline: boolean;
}
interface IContextRow extends IPatchRowBase {
  readonly kind: 'context';
  readonly old: number;
  readonly new: number;
}
interface IDeletedRow extends IPatchRowBase {
  readonly kind: 'deleted';
  readonly old: number;
  readonly new?: undefined;
}
interface IAddedRow extends IPatchRowBase {
  readonly kind: 'added';
  readonly old?: undefined;
  readonly new: number;
}
type PatchRow = IContextRow | IDeletedRow | IAddedRow;

/** One hunk: its header counts and its rows in display order. */
interface IHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly rows: readonly PatchRow[];
}

/**
 * Placement-relevant header facts. A path is undefined when its header is
 * absent and null when it names /dev/null.
 */
interface IPatchHeaders {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  oldAbsent: boolean;
  newAbsent: boolean;
  rename: boolean;
}

/** A structurally validated patch: header facts and hunks. */
interface IParsedPatch extends Readonly<IPatchHeaders> {
  readonly hunks: readonly IHunk[];
}

/** A faithful single-side host range, or why none exists. */
type SideAnchor =
  | { readonly reason?: undefined; readonly side: PlacementAnchorSide; readonly start: number; readonly end: number }
  | { readonly reason: PlacementGeneralReason };

/** Throws on a structural defect; typed `never` so control flow ends at each call. */
type Fail = (message: string) => never;

/** A full, canonical (lowercase) Git object name. Abbreviations are never prefix-matched. */
const FULL_COMMIT = /^[0-9a-f]{40}$/;

/**
 * Unified hunk header; omitted counts mean 1. A trailing section heading is
 * ignored and may contain any character except the line-ending LF (including
 * CR, U+2028 and U+2029, which `.` would not match).
 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: [^\n]*)?$/;

/** Git extended header lines that carry no placement-relevant meaning. */
const IGNORED_HEADER_PREFIXES: readonly string[] = [
  'diff --git ', 'index ', 'old mode ', 'new mode ', 'similarity index ', 'dissimilarity index ',
  'copy from ', 'copy to ',
];

/** Single-character escapes in Git's C-style quoted paths. */
const QUOTED_PATH_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 } as const;

/** Internal control flow for a rejection; converted to a result at the module boundary. */
class Rejection extends Error {
  // Assigned in the constructor, not a class field, so the instance's own
  // properties stay exactly those the constructor sets.
  declare readonly reason: PlacementRejectedReason;

  constructor(reason: PlacementRejectedReason, message: string) {
    super(message);
    this.reason = reason;
  }
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

/**
 * A value interpolated into a message exactly as a template literal converts
 * it, including values of any type supplied by an untyped caller.
 */
function templateText(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- reproduces template-literal string conversion of an arbitrary caller-supplied value in a diagnostic message; String() would differ for symbols
  return `${value}`;
}

/**
 * Classifies one requested source range against a pull request diff.
 *
 * @param request - see module documentation for the exact shape
 * @returns one placement outcome; never a relocated range
 */
export function classifyPlacement(request: unknown): PlacementOutcome {
  try {
    return classify(request);
  } catch (error) {
    if (error instanceof Rejection) {
      return { kind: 'rejected', reason: error.reason, message: error.message };
    }
    throw error;
  }
}

/**
 * Ordered decision: input validity, diff identity, source range, diff side,
 * file membership, rename/patch availability, patch structure, patch/source
 * agreement, and finally the host anchor. Every non-inline outcome after
 * range validation carries the exact validated source range.
 */
function classify(request: unknown): PlacementOutcome {
  validateRequest(request);
  const { source, range, diff } = request;
  validateDiffIdentity(diff);

  const lines = indexLines(source.text);
  validateRange(range, lines.length, source);
  const sourceRange: IPlacementSourceRange = {
    commit: source.commit,
    path: source.path,
    startLine: range.startLine,
    endLine: range.endLine,
    text: rangeText(source.text, lines, range.startLine, range.endLine),
  };

  let side: PatchSide;
  if (source.commit === diff.headCommit) side = 'new';
  else if (source.commit === diff.baseCommit) side = 'old';
  else return { kind: 'general', reason: 'source-commit-not-diff-side', source: sourceRange };

  const entry = diff.files.find((file) => file.path === source.path);
  if (!entry) {
    if (side === 'old' && isRenameSource(diff.files, source.path)) {
      return { kind: 'unsupported', reason: 'rename-unsupported', source: sourceRange };
    }
    return { kind: 'general', reason: 'file-not-in-diff', source: sourceRange };
  }
  if (entry.previousPath !== undefined && entry.previousPath !== entry.path) {
    return { kind: 'unsupported', reason: 'rename-unsupported', source: sourceRange };
  }
  if (entry.patch === undefined || entry.patch === '') {
    return { kind: 'unsupported', reason: 'patch-unavailable', source: sourceRange };
  }

  const patch = parsePatch(entry.patch);
  if (patch.rename) {
    return { kind: 'unsupported', reason: 'rename-unsupported', source: sourceRange };
  }
  validateHeaderPaths(patch, entry.path);
  if (patch.hunks.length === 0) {
    return { kind: 'unsupported', reason: 'patch-unavailable', source: sourceRange };
  }
  verifySourceAgainstPatch(patch, side, lines, source);

  const anchor = side === 'new'
    ? anchorHeadSource(patch.hunks, range)
    : anchorBaseSource(patch.hunks, range);
  if (anchor.reason) {
    return { kind: 'general', reason: anchor.reason, source: sourceRange };
  }
  return {
    kind: 'inline',
    source: sourceRange,
    anchor: hostAnchor(diff.headCommit, source.path, anchor.side, anchor.start, anchor.end),
  };
}

/** Rejects requests whose shape or identity formats cannot be trusted as written. */
function validateRequest(request: unknown): asserts request is IShapedRequest {
  const invalid: Fail = (message) => { throw new Rejection('invalid-input', message); };
  if (!isObject(request)) invalid('Placement request must be an object.');

  const { source, range, diff } = request;
  if (!isObject(source)) invalid('`source` must be an object.');
  if (!isFullCommit(source['commit'])) invalid('`source.commit` must be a full 40-character lowercase commit.');
  if (!isNormalizedPath(source['path'])) invalid('`source.path` must be a normalized repository-relative path.');
  if (typeof source['text'] !== 'string') invalid('`source.text` must be a string.');
  if (!isObject(range)) invalid('`range` must be an object with `startLine` and `endLine`.');

  if (!isObject(diff)) invalid('`diff` must be an object.');
  if (!isFullCommit(diff['baseCommit'])) invalid('`diff.baseCommit` must be a full 40-character lowercase commit.');
  if (!isFullCommit(diff['headCommit'])) invalid('`diff.headCommit` must be a full 40-character lowercase commit.');
  const files = diff['files'];
  if (!isArray(files)) invalid('`diff.files` must be an array.');
  for (const file of files) {
    if (!isObject(file) || !isNormalizedPath(file['path'])) {
      invalid('Every `diff.files` entry needs a normalized repository-relative `path`.');
    }
    if (file['previousPath'] !== undefined && !isNormalizedPath(file['previousPath'])) {
      invalid(`\`previousPath\` of ${file['path']} must be a normalized repository-relative path.`);
    }
    if (file['patch'] !== undefined && typeof file['patch'] !== 'string') {
      invalid(`\`patch\` of ${file['path']} must be a string when present.`);
    }
  }
}

/** Rejects a diff whose own identity is contradictory. */
function validateDiffIdentity(diff: IPlacementDiff): void {
  if (diff.baseCommit === diff.headCommit) {
    throw new Rejection('invalid-diff', 'Diff base and head are the same commit.');
  }
  const seen = new Set<string>();
  for (const file of diff.files) {
    if (seen.has(file.path)) {
      throw new Rejection('invalid-diff', `Diff lists ${file.path} more than once.`);
    }
    seen.add(file.path);
  }
}

/** Validates the requested range against the source's addressable lines, without clipping. */
function validateRange(
  range: Readonly<Record<string, unknown>>,
  lineCount: number,
  source: IPlacementSource,
): asserts range is Readonly<Record<string, unknown>> & IPlacementRange {
  const { startLine, endLine } = range;
  if (!isWholeNumber(startLine) || !isWholeNumber(endLine) || startLine < 1 || startLine > endLine) {
    throw new Rejection('invalid-range',
      `Range ${templateText(startLine)}-${templateText(endLine)} is not an ascending pair of positive whole line numbers.`);
  }
  if (endLine > lineCount) {
    throw new Rejection('range-out-of-bounds',
      `Range ${String(startLine)}-${String(endLine)} exceeds the ${String(lineCount)} line(s) of ${source.path} at ${source.commit}.`);
  }
}

/** Whether a value is a non-null, non-array object whose properties can be read by name. */
function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `Array.isArray` narrowed to a read-only array of unchecked elements. */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** `Number.isInteger` as a type guard; it is false for every non-number. */
function isWholeNumber(value: unknown): value is number {
  return Number.isInteger(value);
}

function isFullCommit(value: unknown): value is string {
  return typeof value === 'string' && FULL_COMMIT.test(value);
}

/**
 * A normalized repository-relative path: "/"-separated, no empty, "." or ".."
 * segments, no leading or trailing separator, no backslash or NUL. Spaces and
 * non-ASCII characters are ordinary path characters.
 */
function isNormalizedPath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Physical lines of a text. `body` excludes the "\n" but keeps any "\r", so a
 * CRLF source compares byte-for-byte with its patch lines. A final segment
 * without a newline is a line; an empty final segment is not.
 */
function indexLines(text: string): ISourceLine[] {
  const lines: ISourceLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ start, body: text.slice(start), hasNewline: false });
      break;
    }
    lines.push({ start, body: text.slice(start, newline), hasNewline: true });
    start = newline + 1;
  }
  return lines;
}

/** Exact source text of an inclusive line range, excluding only the last line's terminator. */
function rangeText(text: string, lines: readonly ISourceLine[], startLine: number, endLine: number): string {
  const last = itemAt(lines, endLine - 1);
  let end = last.start + last.body.length;
  if (last.hasNewline && last.body.endsWith('\r')) end -= 1;
  return text.slice(itemAt(lines, startLine - 1).start, end);
}

/**
 * Whether a base-side path is the old name of a renamed file, by structured
 * `previousPath` or by a `rename from` header in any file's patch.
 */
function isRenameSource(files: readonly IPlacementDiffFile[], basePath: string): boolean {
  return files.some((file) => {
    if (file.previousPath === basePath) return true;
    if (typeof file.patch !== 'string') return false;
    for (const line of file.patch.split('\n')) {
      if (line.startsWith('@@')) break;
      if (line.startsWith('rename from ')) {
        try {
          if (decodeHeaderPath(line.slice('rename from '.length)) === basePath) return true;
        } catch (error) {
          if (!(error instanceof Rejection)) throw error;
        }
      }
    }
    return false;
  });
}

/**
 * Parses one file's unified diff into header facts and hunks of display rows.
 *
 * Each row is { kind: 'context'|'deleted'|'added', old?, new?, text, noNewline }
 * with absolute line numbers on the sides it occupies. Structure is fully
 * validated here: header syntax, hunk counts against bodies, line prefixes,
 * no-newline markers only on each side's final line, and hunk order and
 * cumulative offsets. Any inconsistency rejects the whole patch; a truncated
 * or malformed patch is never evidence about lines it happens to contain.
 */
function parsePatch(patchText: string): IParsedPatch {
  const malformed: Fail = (message) => { throw new Rejection('malformed-patch', message); };
  const body = patchText.endsWith('\n') ? patchText.slice(0, -1) : patchText;
  const lines = body.split('\n');
  const headers: IPatchHeaders = { oldPath: undefined, newPath: undefined, oldAbsent: false, newAbsent: false, rename: false };

  let i = 0;
  for (; i < lines.length && !itemAt(lines, i).startsWith('@@'); i += 1) {
    parseHeaderLine(itemAt(lines, i), headers, malformed);
  }

  const hunks: IHunk[] = [];
  const markedSides = { old: false, new: false };
  let delta = 0;
  let oldConsumed = 0;
  while (i < lines.length) {
    const header = itemAt(lines, i);
    const match = HUNK_HEADER.exec(header);
    if (!match) malformed(`Unrecognized hunk header or trailing line: ${JSON.stringify(header)}.`);
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    if ((oldCount > 0 && oldStart === 0) || (newCount > 0 && newStart === 0)) {
      malformed(`Hunk ${header} addresses line 0.`);
    }
    if (oldCount === 0 && newCount === 0) malformed(`Hunk ${header} changes nothing on either side.`);

    // A zero-count side's start names the line after which the hunk sits.
    const oldBefore = oldCount === 0 ? oldStart : oldStart - 1;
    const newBefore = newCount === 0 ? newStart : newStart - 1;
    if (oldBefore < oldConsumed) malformed(`Hunk ${header} overlaps or precedes an earlier hunk.`);
    if (newBefore !== oldBefore + delta) malformed(`Hunk ${header} contradicts the offset of earlier hunks.`);
    i += 1;

    const rows: PatchRow[] = [];
    let oldLine = oldStart;
    let newLine = newStart;
    let oldLeft = oldCount;
    let newLeft = newCount;
    const markLast = (): void => {
      const row = rows[rows.length - 1];
      if (!row || row.noNewline) malformed('Misplaced "\\ No newline at end of file" marker.');
      row.noNewline = true;
      if (row.old !== undefined) markedSides.old = true;
      if (row.new !== undefined) markedSides.new = true;
    };
    const occupy = (row: PatchRow): void => {
      if ((row.old !== undefined && markedSides.old) || (row.new !== undefined && markedSides.new)) {
        malformed('A line follows the final line of its side.');
      }
      rows.push(row);
    };

    while (oldLeft > 0 || newLeft > 0) {
      if (i >= lines.length) malformed('Patch ends before its hunk counts are satisfied.');
      const line = itemAt(lines, i);
      const text = line.slice(1);
      if (line.startsWith(' ') && oldLeft > 0 && newLeft > 0) {
        occupy({ kind: 'context', old: oldLine, new: newLine, text, noNewline: false });
        oldLine += 1; newLine += 1; oldLeft -= 1; newLeft -= 1;
      } else if (line.startsWith('-') && oldLeft > 0) {
        occupy({ kind: 'deleted', old: oldLine, text, noNewline: false });
        oldLine += 1; oldLeft -= 1;
      } else if (line.startsWith('+') && newLeft > 0) {
        occupy({ kind: 'added', new: newLine, text, noNewline: false });
        newLine += 1; newLeft -= 1;
      } else if (line.startsWith('\\')) {
        markLast();
      } else {
        malformed(`Hunk body line does not fit its header counts: ${JSON.stringify(line)}.`);
      }
      i += 1;
    }
    while (i < lines.length && itemAt(lines, i).startsWith('\\')) {
      markLast();
      i += 1;
    }

    hunks.push({ oldStart, oldCount, newStart, newCount, rows });
    oldConsumed = oldBefore + oldCount;
    delta += newCount - oldCount;
  }

  validateWholeFileShape(headers, hunks, malformed);
  return { ...headers, hunks };
}

/**
 * A creation (old side absent) or deletion (new side absent) describes the
 * whole file on its present side: at most one hunk, whose absent side is the
 * empty `0,0` range and whose present side starts at line 1. Headers that
 * contradict the counts are structurally inconsistent.
 */
function validateWholeFileShape(headers: Readonly<IPatchHeaders>, hunks: readonly IHunk[], malformed: Fail): void {
  if (headers.oldAbsent && headers.newAbsent) malformed('Patch says the file exists on neither side.');
  for (const [absent, present, name] of [['old', 'new', 'created'], ['new', 'old', 'deleted']] as const) {
    if (!headers[`${absent}Absent` as const]) continue;
    if (hunks.length > 1) malformed(`A ${name} file's patch has more than one hunk.`);
    for (const hunk of hunks) {
      if (hunk[`${absent}Start` as const] !== 0 || hunk[`${absent}Count` as const] !== 0) {
        malformed(`A ${name} file's hunk addresses lines on its absent side.`);
      }
      if (hunk[`${present}Start` as const] !== 1) malformed(`A ${name} file's hunk does not start at line 1.`);
    }
  }
}

/** Records the placement-relevant meaning of one patch header line. */
function parseHeaderLine(line: string, headers: IPatchHeaders, malformed: Fail): void {
  if (line.startsWith('--- ')) {
    headers.oldPath = decodeHeaderPath(line.slice(4));
    if (headers.oldPath === null) headers.oldAbsent = true;
  } else if (line.startsWith('+++ ')) {
    headers.newPath = decodeHeaderPath(line.slice(4));
    if (headers.newPath === null) headers.newAbsent = true;
  } else if (line.startsWith('new file mode ')) {
    headers.oldAbsent = true;
  } else if (line.startsWith('deleted file mode ')) {
    headers.newAbsent = true;
  } else if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
    headers.rename = true;
  } else if (line.startsWith('Binary files ')) {
    // Binary changes have no line hunks; the absence of hunks is reported by the caller.
  } else if (!IGNORED_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) {
    malformed(`Unrecognized patch header line: ${JSON.stringify(line)}.`);
  }
}

/** Whether a character after a backslash is one of Git's single-character path escapes. */
function isQuotedPathEscape(char: string): char is keyof typeof QUOTED_PATH_ESCAPES {
  return Object.prototype.hasOwnProperty.call(QUOTED_PATH_ESCAPES, char);
}

/**
 * Decodes a `---`/`+++`/`rename` header path: `/dev/null` is null; a Git
 * C-style quoted path has its escapes (including octal UTF-8 bytes) decoded
 * and literal characters taken as whole code points; an unquoted path ends at
 * a tab. Git terminates a label containing a space with a TAB whether or not
 * it is quoted, so a TAB (and anything a traditional diff appends after it)
 * may follow the closing quote; nothing else may.
 */
function decodeHeaderPath(raw: string): string | null {
  if (raw === '/dev/null') return null;
  if (!raw.startsWith('"')) {
    const tab = raw.indexOf('\t');
    return tab === -1 ? raw : raw.slice(0, tab);
  }
  const malformed = (): never => { throw new Rejection('malformed-patch', `Invalid quoted patch path: ${raw}.`); };
  const bytes: number[] = [];
  const chars = Array.from(raw);
  let i = 1;
  for (; i < chars.length && chars[i] !== '"'; i += 1) {
    const char = itemAt(chars, i);
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    i += 1;
    const octal = chars.slice(i, i + 3).join('');
    // A backslash that ends the path leaves no escape character; it is malformed.
    const escape = chars[i];
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else if (escape !== undefined && isQuotedPathEscape(escape)) {
      bytes.push(QUOTED_PATH_ESCAPES[escape]);
    } else {
      malformed();
    }
  }
  if (i >= chars.length) malformed();
  if (i !== chars.length - 1 && chars[i + 1] !== '\t') malformed();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return malformed();
  }
}

/** Rejects file headers that name a path other than the diff entry, using Git's a/ and b/ prefixes. */
function validateHeaderPaths(patch: IParsedPatch, entryPath: string): void {
  const mismatch = (header: string, value: string): never => {
    throw new Rejection('diff-path-mismatch',
      `Patch ${header} header names ${JSON.stringify(value)}, not the diff entry ${entryPath}.`);
  };
  if (typeof patch.oldPath === 'string' && patch.oldPath !== `a/${entryPath}`) mismatch('---', patch.oldPath);
  if (typeof patch.newPath === 'string' && patch.newPath !== `b/${entryPath}`) mismatch('+++', patch.newPath);
}

/**
 * Verifies that the patch describes the supplied source: the file exists on
 * that side, every patch line on that side equals the source line at the
 * same absolute number, no hunk extends past the source, and final-newline
 * markers agree with the source's actual final line.
 */
function verifySourceAgainstPatch(
  patch: IParsedPatch,
  side: PatchSide,
  lines: readonly ISourceLine[],
  source: IPlacementSource,
): void {
  const mismatch: Fail = (message) => {
    throw new Rejection('patch-source-mismatch', `${source.path} at ${source.commit}: ${message}`);
  };
  if (side === 'old' ? patch.oldAbsent : patch.newAbsent) {
    mismatch(`the patch says the file does not exist on the ${side === 'old' ? 'base' : 'head'} side.`);
  }
  if (side === 'old' ? patch.newAbsent : patch.oldAbsent) {
    const firstHunk = patch.hunks[0];
    const covered = firstHunk === undefined ? 0 : firstHunk[side === 'old' ? 'oldCount' : 'newCount'];
    if (covered !== lines.length) {
      mismatch(`the patch ${side === 'old' ? 'deletes' : 'creates'} ${String(covered)} line(s) but the source has ${String(lines.length)}.`);
    }
  }
  for (const hunk of patch.hunks) {
    const start = side === 'old' ? hunk.oldStart : hunk.newStart;
    const count = side === 'old' ? hunk.oldCount : hunk.newCount;
    const lastAddressed = count === 0 ? start : start + count - 1;
    if (lastAddressed > lines.length) {
      mismatch(`a hunk addresses line ${String(lastAddressed)} beyond the source's ${String(lines.length)} line(s).`);
    }
    for (const row of hunk.rows) {
      const number = row[side];
      if (number === undefined) continue;
      const line = itemAt(lines, number - 1);
      if (line.body !== row.text) mismatch(`line ${String(number)} differs from the patch.`);
      const isFinal = number === lines.length;
      if (row.noNewline && !isFinal) mismatch(`the patch marks line ${String(number)} as final without a newline.`);
      if (isFinal && row.noNewline === line.hasNewline) {
        mismatch(`the patch and source disagree about a newline after final line ${String(number)}.`);
      }
    }
  }
}

/** Head source anchors RIGHT at its own lines when wholly inside one hunk. */
function anchorHeadSource(hunks: readonly IHunk[], range: IPlacementRange): SideAnchor {
  const rows = rowsCoveringRange(hunks, 'new', range);
  if (!rows) return { reason: 'outside-diff-hunks' };
  return { side: 'RIGHT', start: range.startLine, end: range.endLine };
}

/**
 * Base source anchors LEFT when it is exactly an uninterrupted run of deleted
 * rows, or RIGHT at the corresponding head lines when it is exactly an
 * uninterrupted run of unchanged context. Anything else has no single faithful
 * host range and is left to general presentation.
 */
function anchorBaseSource(hunks: readonly IHunk[], range: IPlacementRange): SideAnchor {
  const covered = rowsCoveringRange(hunks, 'old', range);
  if (!covered) return { reason: 'outside-diff-hunks' };
  const { rows, indices } = covered;
  const uninterrupted = indices.every((index, k) => k === 0 || index === itemAt(indices, k - 1) + 1);
  if (uninterrupted && rows.every((row) => row.kind === 'deleted')) {
    return { side: 'LEFT', start: range.startLine, end: range.endLine };
  }
  if (uninterrupted && rows.every((row): row is IContextRow => row.kind === 'context')) {
    return { side: 'RIGHT', start: itemAt(rows, 0).new, end: itemAt(rows, rows.length - 1).new };
  }
  return { reason: 'no-single-side-anchor' };
}

/** The rows (and their positions) of one hunk covering every line of the range on a side, or null. */
function rowsCoveringRange(
  hunks: readonly IHunk[],
  side: PatchSide,
  range: IPlacementRange,
): { readonly rows: readonly PatchRow[]; readonly indices: readonly number[] } | null {
  for (const hunk of hunks) {
    const indices: number[] = [];
    hunk.rows.forEach((row, index) => {
      const number = row[side];
      if (number !== undefined && number >= range.startLine && number <= range.endLine) indices.push(index);
    });
    if (indices.length === 0) continue;
    if (indices.length !== range.endLine - range.startLine + 1) return null;
    return { rows: indices.map((index) => itemAt(hunk.rows, index)), indices };
  }
  return null;
}

/** GitHub review-comment coordinates; multi-line anchors name their start on the same side. */
function hostAnchor(
  headCommit: string,
  filePath: string,
  side: PlacementAnchorSide,
  start: number,
  end: number,
): IPlacementAnchor {
  const anchor: { -readonly [K in keyof IPlacementAnchor]: IPlacementAnchor[K] } = {
    commit_id: headCommit, path: filePath, side, line: end,
  };
  if (start !== end) {
    anchor.start_line = start;
    anchor.start_side = side;
  }
  return anchor;
}
