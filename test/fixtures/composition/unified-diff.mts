/**
 * Unified diffs of two file versions, shaped as GitHub's REST API serves a
 * changed file's `patch` (pull request files and comparisons): no file
 * headers, hunks with three lines of context as Git produces by default, a
 * count omitted when it is 1, `-N,0` / `+N,0` for an empty side, and
 * `\ No newline at end of file` after a side's final line when it has none.
 *
 * The line matching is a longest-common-subsequence diff. Git's default Myers
 * algorithm finds the same edit for the fixtures here (each changes a few
 * distinct lines); where hunk boundaries must match recorded GitHub output
 * exactly, a fixture authors the patch instead. This models the documented
 * patch format; it is not evidence of how GitHub computes a diff.
 *
 * @see https://git-scm.com/docs/diff-format
 * @see https://docs.github.com/en/rest/commits/commits#compare-two-commits
 */

/** A changed file as GitHub lists it (pull request files, comparison files), with `patch` split into lines. */
export interface IDiffFile {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  /** The patch as lines with terminators kept; the last line has none. */
  readonly patch: readonly string[];
}

/** One row of a line diff: a line kept, deleted (old side only) or added (new side only). */
type Row =
  | { readonly kind: ' '; readonly old: number; readonly new: number }
  | { readonly kind: '-'; readonly old: number }
  | { readonly kind: '+'; readonly new: number };

/** Lines of context Git shows around each change. */
const CONTEXT = 3;

/** A file's physical lines with their terminators (the last may have none). */
function linesOf(text: string): string[] {
  return text === '' ? [] : (text.match(/[^\n]*\n|[^\n]+$/g) ?? []);
}

/** The rows of a longest-common-subsequence diff of two line lists, in order. */
function diffRows(before: readonly string[], after: readonly string[]): Row[] {
  const n = before.length;
  const m = after.length;
  // lcs(i, j): length of the longest common subsequence of before[i..] and after[j..].
  const table = new Array<number>((n + 1) * (m + 1)).fill(0);
  const lcs = (i: number, j: number): number => table[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * (m + 1) + j] = before[i] === after[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
    }
  }
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      rows.push({ kind: ' ', old: i, new: j });
      i += 1;
      j += 1;
    } else if (i < n && (j === m || lcs(i + 1, j) >= lcs(i, j + 1))) {
      // Deletions before additions, as Git orders a replaced run.
      rows.push({ kind: '-', old: i });
      i += 1;
    } else {
      rows.push({ kind: '+', new: j });
      j += 1;
    }
  }
  return rows;
}

/** A hunk header range: the start and, unless it is 1, the count; an empty side names the line before it. */
function range(first: number | undefined, count: number, before: number): string {
  if (count === 0) return `${String(before)},0`;
  const start = String((first ?? 0) + 1);
  return count === 1 ? start : `${start},${String(count)}`;
}

/**
 * The patch lines of a change from `before` to `after` (either may be null
 * for an absent file), or null when nothing changed.
 */
export function unifiedPatch(before: string | null, after: string | null): string[] | null {
  const old = linesOf(before ?? '');
  const now = linesOf(after ?? '');
  const rows = diffRows(old, now);
  const changed = rows.flatMap((row, index) => (row.kind === ' ' ? [] : [index]));
  if (changed.length === 0) return null;

  // Group changed rows whose context would touch or overlap into one hunk.
  const hunks: [number, number][] = [];
  for (const index of changed) {
    const last = hunks[hunks.length - 1];
    if (last !== undefined && index - last[1] <= 2 * CONTEXT + 1) last[1] = index;
    else hunks.push([index, index]);
  }

  const out: string[] = [];
  for (const [firstChange, lastChange] of hunks) {
    const start = Math.max(0, firstChange - CONTEXT);
    const end = Math.min(rows.length - 1, lastChange + CONTEXT);
    const slice = rows.slice(start, end + 1);
    const oldLines = slice.flatMap((r) => (r.kind === '+' ? [] : [r.old]));
    const newLines = slice.flatMap((r) => (r.kind === '-' ? [] : [r.new]));
    // The line before a hunk, on each side, for an empty side's header.
    const before = rows.slice(0, start);
    const oldBefore = before.filter((r) => r.kind !== '+').length;
    const newBefore = before.filter((r) => r.kind !== '-').length;
    out.push(`@@ -${range(oldLines[0], oldLines.length, oldBefore)} +${range(newLines[0], newLines.length, newBefore)} @@\n`);
    for (const row of slice) {
      const line = row.kind === '+' ? now[row.new] : old[row.old];
      if (line === undefined) throw new Error('unified diff: a row names a missing line');
      out.push(`${row.kind}${line.endsWith('\n') ? line : `${line}\n`}`);
      if (!line.endsWith('\n')) out.push('\\ No newline at end of file\n');
    }
  }
  const lastIndex = out.length - 1;
  out[lastIndex] = (out[lastIndex] ?? '').replace(/\n$/, '');
  return out;
}

/**
 * Every changed file between two snapshots (path -> text), in path order, as
 * GitHub lists them. Renames are not detected: a moved file is a removal and
 * an addition.
 */
export function diffFiles(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): IDiffFile[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const files: IDiffFile[] = [];
  for (const filename of paths) {
    const old = Object.hasOwn(before, filename) ? before[filename] ?? null : null;
    const now = Object.hasOwn(after, filename) ? after[filename] ?? null : null;
    const patch = unifiedPatch(old, now);
    if (patch === null) continue;
    files.push({
      filename,
      status: old === null ? 'added' : now === null ? 'removed' : 'modified',
      additions: patch.filter((l) => l.startsWith('+')).length,
      deletions: patch.filter((l) => l.startsWith('-')).length,
      patch,
    });
  }
  return files;
}

/**
 * The lines of each side a patch's hunks cover: GitHub resolves a review
 * comment's `line` on its `side` against these (GH-16).
 */
export function hunkLines(patch: readonly string[]): { readonly left: ReadonlySet<number>; readonly right: ReadonlySet<number> } {
  const left = new Set<number>();
  const right = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      continue;
    }
    if (line.startsWith('\\')) continue;
    if (line.startsWith('-')) {
      left.add(oldLine);
      oldLine += 1;
    } else if (line.startsWith('+')) {
      right.add(newLine);
      newLine += 1;
    } else {
      left.add(oldLine);
      right.add(newLine);
      oldLine += 1;
      newLine += 1;
    }
  }
  return { left, right };
}
