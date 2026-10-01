/**
 * A line-based three-way text merge whose clean/conflict decisions and clean
 * results follow Git's xdiff (private internal module;
 * docs/companion-suggestion-pr-contract.md §2.5.1).
 *
 * Purpose: the companion fidelity projection (src/companion-fidelity.cts)
 * must decide, before a companion pull request is created, what merging it
 * into the pull request's head would do to each text file both sides
 * changed. GitHub merges with Git's merge-ort, whose content merge is
 * xdiff's `xdl_merge` over histogram diffs (Git's default for merges), so
 * this module ports exactly that path rather than using a general-purpose
 * diff3: an LCS-based diff3 places ambiguous hunks differently and so
 * disagrees with Git about which adjacent changes conflict.
 *
 * What is ported, from Git's xdiff (xdiff/xhistogram.c, xdiffi.c,
 * xprepare.c, xmerge.c), with the same constants:
 *   - lines are records ending at and including '\n' (a last line may lack
 *     it), compared byte for byte, so "x" and "x\n" differ;
 *   - the histogram diff, which falls back to the classic Myers diff (with
 *     its record trimming, multimatch discarding, split heuristics and cost
 *     limit) for a range whose common lines all occur more than 64 times;
 *   - change compaction without the indent heuristic (merges do not use it),
 *     sliding each group of changes as far down as possible, then back up to
 *     align with a group of the other file when one is reachable;
 *   - the merge: changes of the two sides that overlap or touch (one ending
 *     where the other starts) conflict unless they are identical, and
 *     conflicts whose two sides are identical after refinement are not
 *     conflicts (level ZEALOUS, as merge-ort's ll_merge uses).
 *
 * Boundary: this decides text merges only. Binary content (a NUL byte in
 * the first 8000 bytes, Git's test) is never merged here; callers treat it
 * as their own limit. Repository attributes (merge drivers, `text`/`eol`
 * normalization), whitespace options and `diff.algorithm` configuration are
 * not modelled: the module reproduces Git's defaults. The result is a
 * projection, not an observation of GitHub's merge.
 *
 * Bytes are carried as 'latin1' strings, which map each byte to one UTF-16
 * code unit and back, so any byte sequence round-trips exactly.
 *
 * @see https://github.com/git/git/blob/master/xdiff/xmerge.c
 * @see https://github.com/git/git/blob/master/xdiff/xhistogram.c
 * @see https://github.com/git/git/blob/master/xdiff/xdiffi.c
 * @see https://github.com/git/git/blob/master/xdiff/xprepare.c
 */

// ---------------------------------------------------------------------------
// Public shapes

/** The result of merging two sides of a text file over their common base. */
export interface ITextMergeResult {
  /** The number of conflicting regions; 0 for a clean merge. */
  readonly conflicts: number;
  /**
   * The merged bytes: exactly Git's result when `conflicts` is 0. With
   * conflicts, every conflicting region holds side 1's ("ours") text, as
   * Git's `--ours` resolution would.
   */
  readonly text: Buffer;
}

/** One hunk of a unified diff, with its lines prefixed ' ', '-' or '+'. */
export interface IDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Each line with its prefix and without its terminator; `noNewline` marks a last line that had none. */
  readonly lines: readonly { readonly text: string; readonly noNewline: boolean }[];
}

// ---------------------------------------------------------------------------
// Constants (xdiff/xdiffi.c, xprepare.c, xhistogram.c, xutils.c)

/** Git's binary test: a NUL byte within the first 8000 bytes (xdiff-interface.c buffer_is_binary). */
const FIRST_FEW_BYTES = 8000;
const XDL_MAX_COST_MIN = 256;
const XDL_HEUR_MIN_COST = 256;
const XDL_SNAKE_CNT = 20;
const XDL_K_HEUR = 4;
const XDL_MAX_EQLIMIT = 1024;
const XDL_SIMSCAN_WINDOW = 100;
const XDL_KPDIS_RUN = 4;
const XDL_LINE_MAX = Number.MAX_SAFE_INTEGER;
/** Lines occurring more often than this are never histogram anchors (xhistogram.c max_chain_length). */
const HISTOGRAM_MAX_CHAIN = 64;

// ---------------------------------------------------------------------------
// Checked typed-array access (the port indexes heavily; an out-of-range
// read is a defect, never a silent zero)

function at(array: ArrayLike<number>, index: number): number {
  const value = array[index];
  if (value === undefined) throw new RangeError(`Internal error: index ${String(index)} is outside the merge's arrays.`);
  return value;
}

// ---------------------------------------------------------------------------
// Records

/** Interns lines so that equal lines share one class id, as xdiff's classifier does. */
class Classifier {
  readonly #ids = new Map<string, number>();

  classes(lines: readonly string[]): Int32Array {
    const out = new Int32Array(lines.length);
    for (const [i, line] of lines.entries()) {
      let id = this.#ids.get(line);
      if (id === undefined) {
        id = this.#ids.size;
        this.#ids.set(line, id);
      }
      out[i] = id;
    }
    return out;
  }
}

/** A byte string's lines, each with its '\n' (a last line may have none). */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const end = text.indexOf('\n', start);
    if (end === -1) break;
    lines.push(text.slice(start, end + 1));
    start = end + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Whether Git treats the bytes as binary: a NUL within the first 8000 bytes. */
export function isBinaryContent(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, FIRST_FEW_BYTES);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * One file's records and change marks. `rchg` is offset by one so that the
 * sentinels xdiff keeps at -1 and n read as unchanged.
 */
class Side {
  readonly recs: Int32Array;
  readonly n: number;
  readonly rchg: Uint8Array;

  constructor(recs: Int32Array) {
    this.recs = recs;
    this.n = recs.length;
    this.rchg = new Uint8Array(recs.length + 2);
  }

  changed(i: number): boolean {
    return at(this.rchg, i + 1) !== 0;
  }

  mark(i: number, value: boolean): void {
    this.rchg[i + 1] = value ? 1 : 0;
  }
}

/** One change of an edit script (xdchange_t): `chg1` records of file 1 at `i1` became `chg2` records of file 2 at `i2`. */
interface IChange {
  readonly i1: number;
  readonly i2: number;
  readonly chg1: number;
  readonly chg2: number;
}

// ---------------------------------------------------------------------------
// The classic diff (xdl_do_diff without an algorithm flag)

function bogosqrt(n: number): number {
  let i = 1;
  for (let m = n; m > 0; m = Math.floor(m / 4)) i *= 2;
  return i;
}

/** xdl_clean_mmatch: whether a multimatch line sits in a run dominated by unmatched lines. */
function cleanMmatch(dis: Uint8Array, i: number, s0: number, e0: number): boolean {
  const s = i - s0 > XDL_SIMSCAN_WINDOW ? i - XDL_SIMSCAN_WINDOW : s0;
  const e = e0 - i > XDL_SIMSCAN_WINDOW ? i + XDL_SIMSCAN_WINDOW : e0;
  let rdis0 = 0;
  let rpdis0 = 1;
  for (let r = 1; i - r >= s; r++) {
    const d = at(dis, i - r);
    if (d === 0) rdis0++;
    else if (d === 2) rpdis0++;
    else break;
  }
  if (rdis0 === 0) return false;
  let rdis1 = 0;
  let rpdis1 = 1;
  for (let r = 1; i + r <= e; r++) {
    const d = at(dis, i + r);
    if (d === 0) rdis1++;
    else if (d === 2) rpdis1++;
    else break;
  }
  if (rdis1 === 0) return false;
  rdis1 += rdis0;
  rpdis1 += rpdis0;
  return rpdis1 * XDL_KPDIS_RUN < rpdis1 + rdis1;
}

/** The records kept for the Myers search after trimming and discarding (xdl_optimize_ctxs). */
interface IReduced {
  readonly ha: Int32Array;
  readonly rindex: Int32Array;
}

/** The search box of xdl_split and the split it answers. */
interface ISplit {
  i1: number;
  i2: number;
  minLo: boolean;
  minHi: boolean;
}

/** The K vectors of the Myers search, shared by the whole recursion as in xdiff. */
interface IKVectors {
  readonly kvd: number[];
  readonly f: number;
  readonly b: number;
  readonly mxcost: number;
}

function xdlSplit(ha1: Int32Array, off1: number, lim1: number, ha2: Int32Array, off2: number, lim2: number, k: IKVectors, needMin: boolean, spl: ISplit): void {
  const { kvd } = k;
  const kf = (d: number): number => at(kvd, k.f + d);
  const kb = (d: number): number => at(kvd, k.b + d);
  const setF = (d: number, v: number): void => { kvd[k.f + d] = v; };
  const setB = (d: number, v: number): void => { kvd[k.b + d] = v; };
  const dmin = off1 - lim2;
  const dmax = lim1 - off2;
  const fmid = off1 - off2;
  const bmid = lim1 - lim2;
  const odd = ((fmid - bmid) & 1) !== 0;
  let fmin = fmid;
  let fmax = fmid;
  let bmin = bmid;
  let bmax = bmid;
  setF(fmid, off1);
  setB(bmid, lim1);

  for (let ec = 1; ; ec++) {
    let gotSnake = false;
    if (fmin > dmin) setF(--fmin - 1, -1);
    else ++fmin;
    if (fmax < dmax) setF(++fmax + 1, -1);
    else --fmax;

    for (let d = fmax; d >= fmin; d -= 2) {
      let i1 = kf(d - 1) >= kf(d + 1) ? kf(d - 1) + 1 : kf(d + 1);
      const prev1 = i1;
      let i2 = i1 - d;
      for (; i1 < lim1 && i2 < lim2 && at(ha1, i1) === at(ha2, i2); i1++, i2++);
      if (i1 - prev1 > XDL_SNAKE_CNT) gotSnake = true;
      setF(d, i1);
      if (odd && bmin <= d && d <= bmax && kb(d) <= i1) {
        spl.i1 = i1;
        spl.i2 = i2;
        spl.minLo = spl.minHi = true;
        return;
      }
    }

    if (bmin > dmin) setB(--bmin - 1, XDL_LINE_MAX);
    else ++bmin;
    if (bmax < dmax) setB(++bmax + 1, XDL_LINE_MAX);
    else --bmax;

    for (let d = bmax; d >= bmin; d -= 2) {
      let i1 = kb(d - 1) < kb(d + 1) ? kb(d - 1) : kb(d + 1) - 1;
      const prev1 = i1;
      let i2 = i1 - d;
      for (; i1 > off1 && i2 > off2 && at(ha1, i1 - 1) === at(ha2, i2 - 1); i1--, i2--);
      if (prev1 - i1 > XDL_SNAKE_CNT) gotSnake = true;
      setB(d, i1);
      if (!odd && fmin <= d && d <= fmax && i1 <= kf(d)) {
        spl.i1 = i1;
        spl.i2 = i2;
        spl.minLo = spl.minHi = true;
        return;
      }
    }

    if (needMin) continue;

    if (gotSnake && ec > XDL_HEUR_MIN_COST) {
      let best = 0;
      for (let d = fmax; d >= fmin; d -= 2) {
        const dd = d > fmid ? d - fmid : fmid - d;
        const i1 = kf(d);
        const i2 = i1 - d;
        const v = i1 - off1 + (i2 - off2) - dd;
        if (v > XDL_K_HEUR * ec && v > best && off1 + XDL_SNAKE_CNT <= i1 && i1 < lim1 && off2 + XDL_SNAKE_CNT <= i2 && i2 < lim2) {
          for (let n = 1; at(ha1, i1 - n) === at(ha2, i2 - n); n++) {
            if (n === XDL_SNAKE_CNT) {
              best = v;
              spl.i1 = i1;
              spl.i2 = i2;
              break;
            }
          }
        }
      }
      if (best > 0) {
        spl.minLo = true;
        spl.minHi = false;
        return;
      }
      best = 0;
      for (let d = bmax; d >= bmin; d -= 2) {
        const dd = d > bmid ? d - bmid : bmid - d;
        const i1 = kb(d);
        const i2 = i1 - d;
        const v = lim1 - i1 + (lim2 - i2) - dd;
        if (v > XDL_K_HEUR * ec && v > best && off1 < i1 && i1 <= lim1 - XDL_SNAKE_CNT && off2 < i2 && i2 <= lim2 - XDL_SNAKE_CNT) {
          for (let n = 0; at(ha1, i1 + n) === at(ha2, i2 + n); n++) {
            if (n === XDL_SNAKE_CNT - 1) {
              best = v;
              spl.i1 = i1;
              spl.i2 = i2;
              break;
            }
          }
        }
      }
      if (best > 0) {
        spl.minLo = false;
        spl.minHi = true;
        return;
      }
    }

    if (ec >= k.mxcost) {
      let fbest = -1;
      let fbest1 = -1;
      for (let d = fmax; d >= fmin; d -= 2) {
        let i1 = Math.min(kf(d), lim1);
        let i2 = i1 - d;
        if (lim2 < i2) {
          i1 = lim2 + d;
          i2 = lim2;
        }
        if (fbest < i1 + i2) {
          fbest = i1 + i2;
          fbest1 = i1;
        }
      }
      let bbest = XDL_LINE_MAX;
      let bbest1 = XDL_LINE_MAX;
      for (let d = bmax; d >= bmin; d -= 2) {
        let i1 = Math.max(off1, kb(d));
        let i2 = i1 - d;
        if (i2 < off2) {
          i1 = off2 + d;
          i2 = off2;
        }
        if (i1 + i2 < bbest) {
          bbest = i1 + i2;
          bbest1 = i1;
        }
      }
      if (lim1 + lim2 - bbest < fbest - (off1 + off2)) {
        spl.i1 = fbest1;
        spl.i2 = fbest - fbest1;
        spl.minLo = true;
        spl.minHi = false;
      } else {
        spl.i1 = bbest1;
        spl.i2 = bbest - bbest1;
        spl.minLo = false;
        spl.minHi = true;
      }
      return;
    }
  }
}

function xdlRecsCmp(s1: Side, r1: IReduced, off1In: number, lim1In: number, s2: Side, r2: IReduced, off2In: number, lim2In: number, k: IKVectors, needMin: boolean): void {
  let off1 = off1In;
  let lim1 = lim1In;
  let off2 = off2In;
  let lim2 = lim2In;
  const ha1 = r1.ha;
  const ha2 = r2.ha;
  for (; off1 < lim1 && off2 < lim2 && at(ha1, off1) === at(ha2, off2); off1++, off2++);
  for (; off1 < lim1 && off2 < lim2 && at(ha1, lim1 - 1) === at(ha2, lim2 - 1); lim1--, lim2--);
  if (off1 === lim1) {
    for (; off2 < lim2; off2++) s2.mark(at(r2.rindex, off2), true);
  } else if (off2 === lim2) {
    for (; off1 < lim1; off1++) s1.mark(at(r1.rindex, off1), true);
  } else {
    const spl: ISplit = { i1: 0, i2: 0, minLo: false, minHi: false };
    xdlSplit(ha1, off1, lim1, ha2, off2, lim2, k, needMin, spl);
    xdlRecsCmp(s1, r1, off1, spl.i1, s2, r2, off2, spl.i2, k, spl.minLo);
    xdlRecsCmp(s1, r1, spl.i1, lim1, s2, r2, spl.i2, lim2, k, spl.minHi);
  }
}

/** Counts of each class in a file (the classifier's len1/len2). */
function classCounts(recs: Int32Array): Map<number, number> {
  const counts = new Map<number, number>();
  for (const id of recs) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/** The classic diff of two whole files (xdl_do_diff with no algorithm flag), marking `s1` and `s2`. */
function classicDiff(s1: Side, s2: Side): void {
  const a = s1.recs;
  const b = s2.recs;
  // xdl_trim_ends
  const lim = Math.min(s1.n, s2.n);
  let dstart = 0;
  for (; dstart < lim; dstart++) if (at(a, dstart) !== at(b, dstart)) break;
  let tail = 0;
  for (const rest = lim - dstart; tail < rest; tail++) if (at(a, s1.n - 1 - tail) !== at(b, s2.n - 1 - tail)) break;
  const dend1 = s1.n - tail - 1;
  const dend2 = s2.n - tail - 1;
  // xdl_cleanup_records
  const len1 = classCounts(a);
  const len2 = classCounts(b);
  const reduce = (side: Side, dend: number, others: Map<number, number>): IReduced => {
    const dis = new Uint8Array(side.n + 1);
    const mlim = Math.min(bogosqrt(side.n), XDL_MAX_EQLIMIT);
    for (let i = dstart; i <= dend; i++) {
      const nm = others.get(at(side.recs, i)) ?? 0;
      dis[i] = nm === 0 ? 0 : nm >= mlim ? 2 : 1;
    }
    const ha: number[] = [];
    const rindex: number[] = [];
    for (let i = dstart; i <= dend; i++) {
      const d = at(dis, i);
      if (d === 1 || (d === 2 && !cleanMmatch(dis, i, dstart, dend))) {
        rindex.push(i);
        ha.push(at(side.recs, i));
      } else {
        side.mark(i, true);
      }
    }
    return { ha: Int32Array.from(ha), rindex: Int32Array.from(rindex) };
  };
  const r1 = reduce(s1, dend1, len2);
  const r2 = reduce(s2, dend2, len1);
  const nreff1 = r1.ha.length;
  const nreff2 = r2.ha.length;
  const ndiags = nreff1 + nreff2 + 3;
  const kvd = new Array<number>(2 * ndiags + 2).fill(0);
  const k: IKVectors = { kvd, f: nreff2 + 1, b: ndiags + nreff2 + 1, mxcost: Math.max(bogosqrt(ndiags), XDL_MAX_COST_MIN) };
  xdlRecsCmp(s1, r1, 0, nreff1, s2, r2, 0, nreff2, k, false);
}

// ---------------------------------------------------------------------------
// The histogram diff (xhistogram.c)

/** One class's occurrences in the scanned range: its first line and how many there are. */
interface IHistogramRecord {
  ptr: number;
  cnt: number;
}

/** The longest common region find_lcs settles on (1-based lines; begin1 0 when none). */
interface IRegion {
  begin1: number;
  end1: number;
  begin2: number;
  end2: number;
}

function histogramDiff(s1: Side, s2: Side): void {
  histogramRange(s1, s2, 1, s1.n, 1, s2.n);
}

/** Marks lines `line..line+count-1` (1-based) of a side as changed. */
function markRange(side: Side, line: number, count: number): void {
  for (let i = 0; i < count; i++) side.mark(line - 1 + i, true);
}

function histogramRange(s1: Side, s2: Side, line1In: number, count1In: number, line2In: number, count2In: number): void {
  let line1 = line1In;
  let count1 = count1In;
  let line2 = line2In;
  let count2 = count2In;
  for (;;) {
    if (count1 <= 0 && count2 <= 0) return;
    if (count1 === 0) {
      markRange(s2, line2, count2);
      return;
    }
    if (count2 === 0) {
      markRange(s1, line1, count1);
      return;
    }
    const lcs: IRegion = { begin1: 0, end1: 0, begin2: 0, end2: 0 };
    if (findLcs(s1.recs, s2.recs, lcs, line1, count1, line2, count2)) {
      fallBackToClassic(s1, s2, line1, count1, line2, count2);
      return;
    }
    if (lcs.begin1 === 0 && lcs.begin2 === 0) {
      markRange(s1, line1, count1);
      markRange(s2, line2, count2);
      return;
    }
    histogramRange(s1, s2, line1, lcs.begin1 - line1, line2, lcs.begin2 - line2);
    const end1 = line1 + count1 - 1;
    const end2 = line2 + count2 - 1;
    count1 = end1 - lcs.end1;
    line1 = lcs.end1 + 1;
    count2 = end2 - lcs.end2;
    line2 = lcs.end2 + 1;
  }
}

/** The classic diff of one range, its marks copied back (xdl_fall_back_diff). */
function fallBackToClassic(s1: Side, s2: Side, line1: number, count1: number, line2: number, count2: number): void {
  const sub1 = new Side(s1.recs.slice(line1 - 1, line1 - 1 + count1));
  const sub2 = new Side(s2.recs.slice(line2 - 1, line2 - 1 + count2));
  classicDiff(sub1, sub2);
  for (let i = 0; i < count1; i++) s1.mark(line1 - 1 + i, sub1.changed(i));
  for (let i = 0; i < count2; i++) s2.mark(line2 - 1 + i, sub2.changed(i));
}

/**
 * find_lcs: fills `lcs` with the region the histogram anchors on. Answers
 * true when the range has common lines but every one occurs more than 64
 * times, which falls back to the classic diff.
 */
function findLcs(a: Int32Array, b: Int32Array, lcs: IRegion, line1: number, count1: number, line2: number, count2: number): boolean {
  const end1 = line1 + count1 - 1;
  const end2 = line2 + count2 - 1;
  const records = new Map<number, IHistogramRecord>();
  const lineMap: IHistogramRecord[] = new Array<IHistogramRecord>(count1);
  const nextPtrs = new Int32Array(count1);
  for (let ptr = end1; line1 <= ptr; ptr--) {
    const cls = at(a, ptr - 1);
    const rec = records.get(cls);
    if (rec === undefined) {
      const fresh = { ptr, cnt: 1 };
      records.set(cls, fresh);
      lineMap[ptr - line1] = fresh;
    } else {
      nextPtrs[ptr - line1] = rec.ptr;
      rec.ptr = ptr;
      rec.cnt += 1;
      lineMap[ptr - line1] = rec;
    }
  }
  const countAt = (ptr: number): number => {
    const rec = lineMap[ptr - line1];
    if (rec === undefined) throw new RangeError('Internal error: a histogram line has no record.');
    return rec.cnt;
  };
  let cnt = HISTOGRAM_MAX_CHAIN + 1;
  let hasCommon = false;
  for (let bPtr = line2; bPtr <= end2;) {
    let bNext = bPtr + 1;
    const rec = records.get(at(b, bPtr - 1));
    if (rec !== undefined) {
      if (rec.cnt > cnt) {
        hasCommon = true;
      } else {
        let as = rec.ptr;
        hasCommon = true;
        for (;;) {
          let np = at(nextPtrs, as - line1);
          let bs = bPtr;
          let ae = as;
          let be = bs;
          let rc = rec.cnt;
          while (line1 < as && line2 < bs && at(a, as - 2) === at(b, bs - 2)) {
            as--;
            bs--;
            if (rc > 1) rc = Math.min(rc, countAt(as));
          }
          while (ae < end1 && be < end2 && at(a, ae) === at(b, be)) {
            ae++;
            be++;
            if (rc > 1) rc = Math.min(rc, countAt(ae));
          }
          if (bNext <= be) bNext = be + 1;
          if (lcs.end1 - lcs.begin1 < ae - as || rc < cnt) {
            lcs.begin1 = as;
            lcs.begin2 = bs;
            lcs.end1 = ae;
            lcs.end2 = be;
            cnt = rc;
          }
          if (np === 0) break;
          let exhausted = false;
          while (np <= ae) {
            np = at(nextPtrs, np - line1);
            if (np === 0) {
              exhausted = true;
              break;
            }
          }
          if (exhausted) break;
          as = np;
        }
      }
    }
    bPtr = bNext;
  }
  return hasCommon && HISTOGRAM_MAX_CHAIN < cnt;
}

// ---------------------------------------------------------------------------
// Compaction and the edit script (xdiffi.c)

/** A group of changed lines [start, end) in one side (struct xdlgroup). */
interface IGroup {
  start: number;
  end: number;
}

function groupInit(side: Side): IGroup {
  const g = { start: 0, end: 0 };
  while (side.changed(g.end)) g.end++;
  return g;
}

/** group_next: false when already at the end of the file. */
function groupNext(side: Side, g: IGroup): boolean {
  if (g.end === side.n) return false;
  g.start = g.end + 1;
  for (g.end = g.start; side.changed(g.end); g.end++);
  return true;
}

/** group_previous: false when already at the start of the file. */
function groupPrevious(side: Side, g: IGroup): boolean {
  if (g.start === 0) return false;
  g.end = g.start - 1;
  for (g.start = g.end; side.changed(g.start - 1); g.start--);
  return true;
}

/** group_slide_down: false when the group cannot slide. */
function groupSlideDown(side: Side, g: IGroup): boolean {
  if (g.end < side.n && at(side.recs, g.start) === at(side.recs, g.end)) {
    side.mark(g.start++, false);
    side.mark(g.end++, true);
    while (side.changed(g.end)) g.end++;
    return true;
  }
  return false;
}

/** group_slide_up: false when the group cannot slide. */
function groupSlideUp(side: Side, g: IGroup): boolean {
  if (g.start > 0 && at(side.recs, g.start - 1) === at(side.recs, g.end - 1)) {
    side.mark(--g.start, true);
    side.mark(--g.end, false);
    while (side.changed(g.start - 1)) g.start--;
    return true;
  }
  return false;
}

function syncBroken(): never {
  throw new Error('Internal error: the diff groups of the two files fell out of step.');
}

/**
 * xdl_change_compact without the indent heuristic, which merges do not use.
 * For a histogram diff, a group that compaction moved and that faces a
 * changed group of the other file is diffed again with the classic
 * algorithm (Git's re-diff of shifted groups).
 */
function changeCompact(side: Side, other: Side, histogram: boolean): void {
  const g = groupInit(side);
  const go = groupInit(other);
  for (;;) {
    if (g.end !== g.start) {
      const original = { start: g.start, end: g.end };
      let earliestEnd: number;
      let endMatchingOther: number;
      let groupSize: number;
      do {
        groupSize = g.end - g.start;
        endMatchingOther = -1;
        while (groupSlideUp(side, g)) if (!groupPrevious(other, go)) syncBroken();
        earliestEnd = g.end;
        if (go.end > go.start) endMatchingOther = g.end;
        for (;;) {
          if (!groupSlideDown(side, g)) break;
          if (!groupNext(other, go)) syncBroken();
          if (go.end > go.start) endMatchingOther = g.end;
        }
      } while (groupSize !== g.end - g.start);
      if (g.end !== earliestEnd && endMatchingOther !== -1) {
        while (go.end === go.start) {
          if (!groupSlideUp(side, g)) syncBroken();
          if (!groupPrevious(other, go)) syncBroken();
        }
      }
      if (histogram && go.end !== go.start && (g.start !== original.start || g.end !== original.end)) {
        fallBackToClassic(side, other, g.start + 1, g.end - g.start, go.start + 1, go.end - go.start);
      }
    }
    if (!groupNext(side, g)) break;
    if (!groupNext(other, go)) syncBroken();
  }
}

/** xdl_build_script: the changes, in file order. */
function buildScript(s1: Side, s2: Side): IChange[] {
  const changes: IChange[] = [];
  for (let i1 = s1.n, i2 = s2.n; i1 >= 0 || i2 >= 0; i1--, i2--) {
    if (s1.changed(i1 - 1) || s2.changed(i2 - 1)) {
      const l1 = i1;
      const l2 = i2;
      for (; s1.changed(i1 - 1); i1--);
      for (; s2.changed(i2 - 1); i2--);
      changes.push({ i1, i2, chg1: l1 - i1, chg2: l2 - i2 });
    }
  }
  return changes.reverse();
}

/** The compacted histogram edit script from `a` to `b`, as xdl_merge computes each side's. */
function editScript(a: Int32Array, b: Int32Array): IChange[] {
  const s1 = new Side(a);
  const s2 = new Side(b);
  histogramDiff(s1, s2);
  changeCompact(s1, s2, true);
  changeCompact(s2, s1, true);
  return buildScript(s1, s2);
}

// ---------------------------------------------------------------------------
// The merge (xmerge.c, level ZEALOUS, no favor)

/** One merge region (xdmerge_t): mode 1 side 1 only, 2 side 2 only, 0 conflict, 4 identical after refinement. */
interface IMergeRegion {
  mode: number;
  i0: number;
  chg0: number;
  i1: number;
  chg1: number;
  i2: number;
  chg2: number;
}

/** xdl_append_merge: a region touching the previous one in either side joins it, and becomes a conflict if their modes differ. */
function appendMerge(regions: IMergeRegion[], mode: number, i0: number, chg0: number, i1: number, chg1: number, i2: number, chg2: number): void {
  const m = regions.at(-1);
  if (m !== undefined && (i1 <= m.i1 + m.chg1 || i2 <= m.i2 + m.chg2)) {
    if (mode !== m.mode) m.mode = 0;
    m.chg0 = i0 + chg0 - m.i0;
    m.chg1 = i1 + chg1 - m.i1;
    m.chg2 = i2 + chg2 - m.i2;
  } else {
    regions.push({ mode, i0, chg0, i1, chg1, i2, chg2 });
  }
}

function sameLines(a: Int32Array, i: number, b: Int32Array, j: number, count: number): boolean {
  for (let n = 0; n < count; n++) if (at(a, i + n) !== at(b, j + n)) return false;
  return true;
}

/**
 * xdl_refine_conflicts: each conflict is narrowed to where its two sides
 * differ (a diff of side 1's text against side 2's); one whose sides are
 * identical is no conflict.
 */
function refineConflicts(regions: IMergeRegion[], side1: Int32Array, side2: Int32Array): IMergeRegion[] {
  const refined: IMergeRegion[] = [];
  for (const m of regions) {
    if (m.mode !== 0 || m.chg1 === 0 || m.chg2 === 0) {
      refined.push(m);
      continue;
    }
    const script = editScript(side1.slice(m.i1, m.i1 + m.chg1), side2.slice(m.i2, m.i2 + m.chg2));
    if (script.length === 0) {
      refined.push({ ...m, mode: 4 });
      continue;
    }
    for (const x of script) refined.push({ mode: 0, i0: m.i0, chg0: m.chg0, i1: x.i1 + m.i1, chg1: x.chg1, i2: x.i2 + m.i2, chg2: x.chg2 });
  }
  return refined;
}

/** xdl_do_merge's regions for base `o` and sides `a` (ours) and `b` (theirs). */
function mergeRegions(o: Int32Array, a: Int32Array, b: Int32Array): IMergeRegion[] {
  const script1 = editScript(o, a);
  const script2 = editScript(o, b);
  const regions: IMergeRegion[] = [];
  let x1 = 0;
  let x2 = 0;
  for (;;) {
    const c1 = script1[x1];
    const c2 = script2[x2];
    if (c1 === undefined || c2 === undefined) break;
    if (c1.i1 + c1.chg1 < c2.i1) {
      appendMerge(regions, 1, c1.i1, c1.chg1, c1.i2, c1.chg2, c2.i2 - c2.i1 + c1.i1, c1.chg1);
      x1++;
      continue;
    }
    if (c2.i1 + c2.chg1 < c1.i1) {
      appendMerge(regions, 2, c2.i1, c2.chg1, c1.i2 - c1.i1 + c2.i1, c2.chg1, c2.i2, c2.chg2);
      x2++;
      continue;
    }
    if (c1.i1 !== c2.i1 || c1.chg1 !== c2.chg1 || c1.chg2 !== c2.chg2 || !sameLines(a, c1.i2, b, c2.i2, c1.chg2)) {
      const off = c1.i1 - c2.i1;
      const ffo = off + c1.chg1 - c2.chg1;
      let i0 = c1.i1;
      let i1 = c1.i2;
      let i2 = c2.i2;
      if (off > 0) {
        i0 -= off;
        i1 -= off;
      } else {
        i2 += off;
      }
      let chg0 = c1.i1 + c1.chg1 - i0;
      let chg1 = c1.i2 + c1.chg2 - i1;
      let chg2 = c2.i2 + c2.chg2 - i2;
      if (ffo < 0) {
        chg0 -= ffo;
        chg1 -= ffo;
      } else {
        chg2 += ffo;
      }
      appendMerge(regions, 0, i0, chg0, i1, chg1, i2, chg2);
    }
    const end1 = c1.i1 + c1.chg1;
    const end2 = c2.i1 + c2.chg1;
    if (end1 >= end2) x2++;
    if (end2 >= end1) x1++;
  }
  for (let c1 = script1[x1]; c1 !== undefined; c1 = script1[++x1]) {
    appendMerge(regions, 1, c1.i1, c1.chg1, c1.i2, c1.chg2, c1.i1 + b.length - o.length, c1.chg1);
  }
  for (let c2 = script2[x2]; c2 !== undefined; c2 = script2[++x2]) {
    appendMerge(regions, 2, c2.i1, c2.chg1, c2.i1 + a.length - o.length, c2.chg1, c2.i2, c2.chg2);
  }
  return refineConflicts(regions, a, b);
}

/**
 * Merges `ours` and `theirs` over `base`, line by line, as Git's content
 * merge does (see the module documentation). All three are byte strings.
 */
export function mergeText(base: Buffer, ours: Buffer, theirs: Buffer): ITextMergeResult {
  if (ours.equals(theirs) || base.equals(theirs)) return { conflicts: 0, text: ours };
  if (base.equals(ours)) return { conflicts: 0, text: theirs };
  const classifier = new Classifier();
  const oLines = splitLines(base.toString('latin1'));
  const aLines = splitLines(ours.toString('latin1'));
  const bLines = splitLines(theirs.toString('latin1'));
  const o = classifier.classes(oLines);
  const a = classifier.classes(aLines);
  const b = classifier.classes(bLines);
  const regions = mergeRegions(o, a, b);
  // xdl_fill_merge_buffer: side 1's text, with side 2's own regions spliced in;
  // a conflict keeps side 1's text (only its count matters to the caller).
  const out: string[] = [];
  let i = 0;
  let conflicts = 0;
  for (const m of regions) {
    if (m.mode === 0) conflicts++;
    if (m.mode !== 2) continue;
    for (; i < m.i1; i++) out.push(lineAt(aLines, i));
    for (let n = 0; n < m.chg2; n++) out.push(lineAt(bLines, m.i2 + n));
    i = m.i1 + m.chg1;
  }
  for (; i < aLines.length; i++) out.push(lineAt(aLines, i));
  return { conflicts, text: Buffer.from(out.join(''), 'latin1') };
}

function lineAt(lines: readonly string[], index: number): string {
  const line = lines[index];
  if (line === undefined) throw new RangeError(`Internal error: line ${String(index)} is outside the merged file.`);
  return line;
}

// ---------------------------------------------------------------------------
// Unified hunks, for presenting a proposal's own changes

/**
 * The unified-diff hunks from `before` to `after` (byte strings), with
 * `context` unchanged lines around each change and changes closer than twice
 * that joined, from the same compacted histogram diff the merge uses.
 */
export function diffHunks(before: string, after: string, context = 3): IDiffHunk[] {
  const classifier = new Classifier();
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const script = editScript(classifier.classes(oldLines), classifier.classes(newLines));
  const hunks: IDiffHunk[] = [];
  let index = 0;
  while (index < script.length) {
    const first = script[index];
    if (first === undefined) break;
    let last = first;
    let next = index + 1;
    for (let c = script[next]; c !== undefined && c.i1 - (last.i1 + last.chg1) <= 2 * context; c = script[++next]) last = c;
    const start1 = Math.max(0, first.i1 - context);
    const start2 = first.i2 - (first.i1 - start1);
    const end1 = Math.min(oldLines.length, last.i1 + last.chg1 + context);
    const end2 = last.i2 + last.chg2 + (end1 - (last.i1 + last.chg1));
    const lines: { text: string; noNewline: boolean }[] = [];
    const push = (prefix: string, line: string): void => {
      const noNewline = !line.endsWith('\n');
      lines.push({ text: `${prefix}${noNewline ? line : line.slice(0, -1)}`, noNewline });
    };
    let p1 = start1;
    let p2 = start2;
    for (let c = index; c < next; c++) {
      const change = script[c];
      if (change === undefined) break;
      for (; p1 < change.i1; p1++, p2++) push(' ', lineAt(oldLines, p1));
      for (let n = 0; n < change.chg1; n++) push('-', lineAt(oldLines, change.i1 + n));
      for (let n = 0; n < change.chg2; n++) push('+', lineAt(newLines, change.i2 + n));
      p1 = change.i1 + change.chg1;
      p2 = change.i2 + change.chg2;
    }
    for (; p1 < end1; p1++, p2++) push(' ', lineAt(oldLines, p1));
    const oldCount = end1 - start1;
    const newCount = end2 - start2;
    hunks.push({
      // Unified diff numbering: a range of no lines names the line before it.
      oldStart: oldCount === 0 ? start1 : start1 + 1,
      oldLines: oldCount,
      newStart: newCount === 0 ? start2 : start2 + 1,
      newLines: newCount,
      lines,
    });
    index = next;
  }
  return hunks;
}
