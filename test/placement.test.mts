/**
 * Contract tests for exact source placement (src/placement.cts).
 *
 * Placement is the milestone's release gate: feedback must land on exactly the
 * reviewed source it concerns, or not be placed inline at all. Two identities
 * are kept distinct throughout:
 *
 * - Source identity: the reviewed commit, path, line range and literal text the
 *   feedback is about. It is never rewritten by placement.
 * - Host anchor: where GitHub can attach that feedback. GitHub documents LEFT
 *   as the side for deletions and RIGHT for additions or unchanged context, so
 *   unchanged base-source context is anchored RIGHT in head numbering.
 *
 * Expected placements come from hand-authored fixtures (test/fixtures/placement).
 * Source files are arrays of physical lines with explicit terminators; each diff
 * entry carries a hand-authored `surface` of display rows [baseLine, headLine].
 * The oracle checks every expectation against those authored arrays, never
 * against the mapper under test. The surface is itself checked by regenerating
 * each patch body from it. Each git-reproducible patch's hunks (not its file
 * headers) are checked against `git diff --no-index`; separately, every primary
 * case is re-run against complete `git diff --cached` output, file headers
 * included, from a scratch repository. Negative controls prove the oracle
 * rejects a shifted line, the wrong diff side, a base-context line anchored
 * LEFT, separated deletions anchored as one LEFT range, and the wrong file.
 *
 * Local fixtures do not establish GitHub's actual placement behavior, nor the
 * provenance of a caller's diff; those require separate real-host evidence.
 *
 * @see https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://www.gnu.org/software/diffutils/manual/html_node/Detailed-Unified.html
 * @see https://git-scm.com/docs/git-diff#_generating_patch_text_with_p
 * @see https://git-scm.com/docs/git-config#Documentation/git-config.txt-corequotePath
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { classifyPlacement } from '../dist/placement.cjs';
import {
  asString,
  expectType,
  isArray,
  isArrayOf,
  isBoolean,
  isEither,
  isNull,
  isNumber,
  isOptional,
  isRecordOf,
  isShape,
  isString,
  readJson,
} from './support/runtime-types.mts';
import type { Guard } from './support/runtime-types.mts';

/** One display row of an authored diff surface: [baseLine, headLine], null on the side a line is absent from. */
type SurfaceRow = readonly [number | null, number | null];

const isSurfaceRow: Guard<SurfaceRow> = (value): value is SurfaceRow =>
  isArray(value) && value.length === 2 && value.every((n) => n === null || typeof n === 'number');

const isAuthoredDiff = isShape({
  baseCommit: isString,
  headCommit: isString,
  files: isArrayOf(isShape({
    path: isString,
    patch: isArrayOf(isString),
    surface: isArrayOf(isArrayOf(isSurfaceRow)),
    context: isOptional(isNumber),
    gitReproducible: isOptional(isBoolean),
  })),
});

const isExpectation = isShape({
  kind: isString,
  text: isOptional(isEither(isString, isNull)),
  reason: isOptional(isString),
  anchor: isOptional(isShape({ side: isString, line: isNumber, start_line: isOptional(isNumber) })),
});

const isRange = isShape({ start: isNumber, end: isNumber });

const isCase = isShape({ id: isString, commit: isString, path: isString, range: isRange, expect: isExpectation, diff: isOptional(isString) });

/** Where a case's source is: what a classifier request is built from. */
interface ICaseSource {
  readonly commit: string;
  readonly path: string;
  readonly range: { readonly start: number; readonly end: number };
  readonly diff?: string | undefined;
}

/** A hand-authored case, or a deliberately altered copy of one. */
interface ICase extends ICaseSource {
  readonly id: string;
  readonly expect: {
    readonly kind: string;
    readonly text?: string | null | undefined;
    readonly reason?: string | undefined;
    readonly anchor?: { readonly side: string; readonly line: number; readonly start_line?: number | undefined } | undefined;
  };
}

/** A classifier request as the tests build and then deliberately alter it. */
interface IRequest {
  source: { commit: string; path: string; text: string | Buffer };
  range: { startLine: number; endLine: number };
  diff: IDiff;
}

interface IDiff {
  baseCommit: string;
  headCommit: string;
  files: IDiffFile[];
}

interface IDiffFile {
  path: string;
  patch?: string;
  previousPath?: string;
}

/** An expected classifier outcome, or a deliberately misplaced copy of one. */
interface IExpectedOutcome {
  readonly kind: string;
  readonly reason?: string | undefined;
  readonly source: {
    readonly commit: string;
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly text: string | null | undefined;
  };
  readonly anchor?: IExpectedAnchor;
}

interface IExpectedAnchor {
  commit_id: string;
  path: string;
  side: string;
  line: number;
  start_line?: number;
  start_side?: string;
}

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'placement');
const fixture = expectType(
  readJson(path.join(FIXTURE_DIR, 'pr-basic.json')),
  isShape({
    commits: isShape({ base: isString, head: isString, advancedBase: isString, advancedHead: isString }),
    snapshots: isRecordOf(isRecordOf(isArrayOf(isString))),
    diffs: isRecordOf(isAuthoredDiff),
  }),
  'the placement repository fixture',
);
const { cases, suggestionGroups } = expectType(
  readJson(path.join(FIXTURE_DIR, 'placement-cases.json')),
  isShape({
    cases: isArrayOf(isCase),
    suggestionGroups: isArrayOf(isShape({
      id: isString,
      members: isArrayOf(isShape({ role: isString, commit: isString, path: isString, range: isRange, expect: isExpectation })),
    })),
  }),
  'the placement cases fixture',
);

const BASE = fixture.commits.base;
const HEAD = fixture.commits.head;
const ADVANCED_BASE = fixture.commits.advancedBase;
const ADVANCED_HEAD = fixture.commits.advancedHead;

/** Matches the numeric part of a unified-diff hunk header. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/**
 * A value the test data guarantees (a TypeError otherwise, as dereferencing
 * the missing value would be; negative controls expect only AssertionErrors).
 */
function present<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new TypeError(`${what} is missing`);
  return value;
}

/** items[index], which the surrounding logic guarantees exists. */
function at<T>(items: readonly T[], index: number): T {
  return present(items[index], `item ${String(index)}`);
}

/** Authored physical lines (each with its own terminator) of a file at a commit. */
function authoredLines(commit: string, filePath: string): string[] {
  const snapshot = fixture.snapshots[commit];
  const lines = snapshot && hasOwn(snapshot, filePath) ? snapshot[filePath] : undefined;
  if (!lines) {
    throw new assert.AssertionError({ message: `fixture has no ${filePath} at ${commit}` });
  }
  return lines;
}

/** Exact file text at a commit, as the mapper receives it. */
function sourceText(commit: string, filePath: string): string {
  return authoredLines(commit, filePath).join('');
}

/** The authored diff a case is evaluated against. */
function authoredDiff(diffId = 'primary') {
  const diff = fixture.diffs[diffId];
  assert.ok(diff, `no fixture diff ${diffId}`);
  return diff;
}

/** Authored patch lines for a primary diff entry. */
function authoredPatchLines(filePath: string): string[] {
  return present(authoredDiff().files.find((f) => f.path === filePath), `primary diff entry ${filePath}`).patch;
}

/** A fresh mapper diff context equivalent to an authored diff (no oracle data). */
function fixtureDiff(diffId = 'primary'): IDiff {
  const diff = authoredDiff(diffId);
  return {
    baseCommit: diff.baseCommit,
    headCommit: diff.headCommit,
    files: diff.files.map((f) => ({ path: f.path, patch: f.patch.join('') })),
  };
}

/** Builds a classifier request for a fixture case, optionally overriding parts. */
function requestFor(c: ICaseSource, overrides: { text?: string; diff?: IDiff } = {}): IRequest {
  return {
    source: {
      commit: c.commit,
      path: c.path,
      text: overrides.text !== undefined ? overrides.text : sourceText(c.commit, c.path),
    },
    range: { startLine: c.range.start, endLine: c.range.end },
    diff: overrides.diff ?? fixtureDiff(c.diff),
  };
}

/**
 * Oracle: the literal text an author means by an inclusive line range, read
 * from the authored line array rather than computed by any line splitter.
 * The final line's terminator is excluded; inner terminators are kept.
 */
function oracleText(commit: string, filePath: string, start: number, end: number): string {
  const lines = authoredLines(commit, filePath);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > lines.length || start > end) {
    throw new assert.AssertionError({ message: `range ${String(start)}-${String(end)} is not within ${filePath}@${commit}` });
  }
  return lines.slice(start - 1, end).join('').replace(/\r?\n$/, '');
}

/** Inclusive integer sequence. */
function span(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

/**
 * Oracle: proves an expectation names real source and an allowed host anchor.
 *
 * The stated text must be the authored text at the stated source range. An
 * inline anchor must cover rows of one hunk of the authored surface: LEFT only
 * deleted base rows of that exact base range; RIGHT the head source's own
 * range, or, for base source, exactly the consecutive unchanged-context rows of
 * that base range in head numbering. The host-side text at the anchor must be
 * the same literal text.
 */
function verifyExpectation(c: ICase): void {
  const { expect } = c;
  if (expect.text !== undefined) {
    assert.equal(oracleText(c.commit, c.path, c.range.start, c.range.end), expect.text,
      `${c.id}: stated text is not the authored source at ${c.path}:${String(c.range.start)}-${String(c.range.end)}`);
  }
  if (expect.kind !== 'inline') {
    assert.equal(expect.anchor, undefined, `${c.id}: a non-inline expectation names an anchor`);
    return;
  }

  const diff = authoredDiff(c.diff);
  const { side, line, start_line: startLine } = present(expect.anchor, `${c.id}: the inline anchor`);
  assert.ok(side === 'LEFT' || side === 'RIGHT', `${c.id}: unknown side ${side}`);
  if (startLine !== undefined) {
    assert.ok(startLine < line, `${c.id}: start_line must precede line when present`);
  }
  const anchorLines = span(startLine === undefined ? line : startLine, line);
  const entry = diff.files.find((f) => f.path === c.path);
  assert.ok(entry, `${c.id}: an inline anchor needs the file in the diff`);

  const coordinate = side === 'LEFT' ? 0 : 1;
  const hunk = entry.surface.find((rows) => rows.some((row) => row[coordinate] === anchorLines[0]));
  assert.ok(hunk, `${c.id}: anchor line ${String(anchorLines[0])} ${side} is not on the diff surface`);
  const anchorRows = anchorLines.map((n) => hunk.find((row) => row[coordinate] === n));
  assert.ok(anchorRows.every(Boolean), `${c.id}: anchor ${side} ${anchorLines.join(',')} is not within one hunk`);

  if (side === 'LEFT') {
    assert.equal(c.commit, diff.baseCommit, `${c.id}: LEFT anchors only base source`);
    assert.ok(anchorRows.every((row) => present(row, 'anchor row')[1] === null), `${c.id}: LEFT anchor covers a line that is not a deletion`);
    const rowIndices = anchorRows.map((row) => hunk.indexOf(present(row, 'anchor row')));
    assert.ok(rowIndices.every((i, k) => k === 0 || i === at(rowIndices, k - 1) + 1),
      `${c.id}: LEFT anchor deletions are separated by other diff rows`);
    assert.deepEqual(anchorLines, span(c.range.start, c.range.end), `${c.id}: LEFT anchor is not the source range`);
  } else if (c.commit === diff.headCommit) {
    assert.deepEqual(anchorLines, span(c.range.start, c.range.end), `${c.id}: RIGHT anchor is not the head source range`);
  } else {
    assert.equal(c.commit, diff.baseCommit, `${c.id}: inline source must be a diff side`);
    const sourceRows = span(c.range.start, c.range.end).map((n) => hunk.findIndex((row) => row[0] === n));
    assert.ok(sourceRows.every((i) => i >= 0), `${c.id}: base source range is not within the anchor's hunk`);
    assert.ok(sourceRows.every((i, k) => k === 0 || i === at(sourceRows, k - 1) + 1),
      `${c.id}: base source range is interrupted by other diff rows`);
    assert.ok(sourceRows.every((i) => at(hunk, i)[1] !== null), `${c.id}: base source range includes a deletion`);
    assert.deepEqual(sourceRows.map((i) => at(hunk, i)[1]), anchorLines,
      `${c.id}: RIGHT anchor is not the head numbering of the base context range`);
  }

  const hostCommit = side === 'LEFT' ? diff.baseCommit : diff.headCommit;
  assert.equal(oracleText(hostCommit, c.path, at(anchorLines, 0), line), expect.text,
    `${c.id}: host text at the anchor differs from the source text`);
}

/** The complete outcome a correct classifier must return for a verified case. */
function expectedOutcome(c: ICase): IExpectedOutcome {
  const { expect } = c;
  const source = {
    commit: c.commit,
    path: c.path,
    startLine: c.range.start,
    endLine: c.range.end,
    text: expect.text,
  };
  if (expect.kind === 'inline') {
    const { side, line, start_line: startLine } = present(expect.anchor, `${c.id}: the inline anchor`);
    const anchor: IExpectedAnchor = { commit_id: authoredDiff(c.diff).headCommit, path: c.path, side, line };
    if (startLine !== undefined) {
      anchor.start_line = startLine;
      anchor.start_side = side;
    }
    return { kind: 'inline', source, anchor };
  }
  if (expect.kind === 'general' || expect.kind === 'unsupported') {
    return { kind: expect.kind, reason: expect.reason, source };
  }
  throw new Error(`expectedOutcome does not describe ${expect.kind}`);
}

/** Asserts a rejection with its reason and a human-readable message, and nothing placeable. */
function assertRejected(result: object, reason: string | undefined): void {
  const { kind, reason: actualReason, message }: { kind?: unknown; reason?: unknown; message?: unknown } = result;
  assert.equal(kind, 'rejected', `expected rejection, got ${JSON.stringify(result)}`);
  assert.equal(actualReason, reason);
  assert.equal(typeof message, 'string');
  assert.ok(asString(message).length > 0, 'rejection message is empty');
  assert.deepEqual(Object.keys(result).sort(), ['kind', 'message', 'reason']);
}

/** Asserts a classifier outcome for a fixture case exactly. */
function assertCaseOutcome(result: object, c: ICase): void {
  if (c.expect.kind === 'rejected') {
    assertRejected(result, c.expect.reason);
  } else {
    assert.deepStrictEqual(result, expectedOutcome(c));
  }
}

function caseById(id: string): ICase {
  const c = cases.find((x) => x.id === id);
  assert.ok(c, `no fixture case ${id}`);
  return c;
}

/** A copy of a case with selected fields replaced (anchor replaced wholesale when given). */
function withChanges(
  c: ICase,
  changes: { commit?: string; path?: string; range?: Partial<ICase['range']>; expect?: Partial<ICase['expect']> },
): ICase {
  return {
    ...c,
    ...changes,
    range: { ...c.range, ...(changes.range ?? {}) },
    expect: { ...c.expect, ...(changes.expect ?? {}) },
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** A primary diff whose entry for `filePath` has the given patch text (or no patch if undefined). */
function diffWithPatch(filePath: string, patch: string | undefined, entryOverrides: Partial<IDiffFile> = {}): IDiff {
  const diff = fixtureDiff();
  const entry = present(diff.files.find((f) => f.path === filePath), `diff entry ${filePath}`);
  if (patch === undefined) delete entry.patch;
  else entry.patch = patch;
  Object.assign(entry, entryOverrides);
  return diff;
}

describe('fixture oracle', () => {
  for (const c of cases) {
    test(`expectation is authored source and an allowed anchor: ${c.id}`, () => {
      verifyExpectation(c);
    });
  }
  for (const group of suggestionGroups) {
    for (const m of group.members) {
      test(`expectation is authored source and an allowed anchor: ${group.id}/${m.role}`, () => {
        verifyExpectation({ ...m, id: `${group.id}/${m.role}` });
      });
    }
  }

  test('negative control: a line shifted by one is detected', () => {
    const c = caseById('right-replacement-addition');
    const shifted = withChanges(c, { range: { start: 11, end: 11 }, expect: { anchor: { side: 'RIGHT', line: 11 } } });
    assert.throws(() => { verifyExpectation(shifted); }, assert.AssertionError);
    const anchorOnlyShifted = withChanges(c, { expect: { anchor: { side: 'RIGHT', line: 11 } } });
    assert.throws(() => { verifyExpectation(anchorOnlyShifted); }, assert.AssertionError);
  });

  test('negative control: a deletion anchored RIGHT is detected', () => {
    const c = caseById('left-replaced-deletion');
    assert.throws(() => { verifyExpectation(withChanges(c, { expect: { anchor: { side: 'RIGHT', line: 8 } } })); },
      assert.AssertionError);
    const sameNumberOtherSide = withChanges(c, { commit: HEAD, expect: { anchor: { side: 'RIGHT', line: 8 } } });
    assert.throws(() => { verifyExpectation(sameNumberOtherSide); }, assert.AssertionError);
  });

  test('negative control: base-source context anchored LEFT is detected (source side is not host side)', () => {
    const c = caseById('base-first-line-context-anchors-right');
    assert.throws(() => { verifyExpectation(withChanges(c, { expect: { anchor: { side: 'LEFT', line: 1 } } })); },
      assert.AssertionError);
    const shifted = caseById('base-context-shifted-by-insertion-anchors-right');
    assert.throws(() => { verifyExpectation(withChanges(shifted, { expect: { anchor: { side: 'LEFT', line: 4 } } })); },
      assert.AssertionError);
  });

  test('negative control: base-source context anchored RIGHT at its base number is detected', () => {
    const c = caseById('base-context-shifted-by-insertion-anchors-right');
    assert.throws(() => { verifyExpectation(withChanges(c, { expect: { anchor: { side: 'RIGHT', line: 4 } } })); },
      assert.AssertionError);
    const multi = caseById('base-multiline-context-shifted-anchors-right');
    assert.throws(() => { verifyExpectation(withChanges(multi, {
      expect: { anchor: { side: 'RIGHT', start_line: 9, line: 11 } },
    })); }, assert.AssertionError);
  });

  test('negative control: a mixed deletion/context base range forced inline is detected', () => {
    const c = caseById('general-base-deletions-then-context');
    for (const anchor of [{ side: 'LEFT', start_line: 24, line: 26 }, { side: 'RIGHT', start_line: 23, line: 24 }]) {
      assert.throws(() => { verifyExpectation(withChanges(c, { expect: { kind: 'inline', reason: undefined, anchor } })); },
        assert.AssertionError);
    }
  });

  test('negative control: base context interrupted by additions forced onto the widened RIGHT range is detected', () => {
    const c = caseById('general-base-context-interrupted-by-additions');
    const widened = withChanges(c, { expect: { kind: 'inline', reason: undefined, anchor: { side: 'RIGHT', start_line: 3, line: 6 } } });
    assert.throws(() => { verifyExpectation(widened); }, assert.AssertionError);
  });

  test('negative control: deletions separated by an addition anchored as one LEFT range are detected', () => {
    const c = caseById('general-reordered-deletions-interrupted-by-addition');
    const forced = withChanges(c, { expect: { kind: 'inline', reason: undefined, anchor: { side: 'LEFT', start_line: 3, line: 4 } } });
    assert.throws(() => { verifyExpectation(forced); }, /separated by other diff rows/);
  });

  test('negative control: head source anchored LEFT is detected', () => {
    const c = caseById('right-context-shifted-by-insertion');
    assert.throws(() => { verifyExpectation(withChanges(c, { expect: { anchor: { side: 'LEFT', line: 6 } } })); },
      assert.AssertionError);
  });

  test('negative control: the wrong file is detected', () => {
    const c = caseById('right-crlf-multiline-preserves-inner-terminator');
    assert.throws(() => { verifyExpectation(withChanges(c, { path: 'src/calc.js' })); }, assert.AssertionError);
  });

  test('negative control: the wrong commit for the stated text is detected', () => {
    const c = caseById('right-context-shifted-by-insertion');
    assert.throws(() => { verifyExpectation(withChanges(c, { commit: BASE })); }, assert.AssertionError);
  });

  test('negative control: outcome comparison rejects a plausibly misplaced anchor or altered source', () => {
    const c = caseById('base-context-shifted-by-insertion-anchors-right');
    const correct = expectedOutcome(c);
    const misplaced = [
      { ...correct, anchor: { ...correct.anchor, line: 4 } },
      { ...correct, anchor: { ...correct.anchor, line: 7 } },
      { ...correct, anchor: { ...correct.anchor, side: 'LEFT' } },
      { ...correct, anchor: { ...correct.anchor, path: 'docs/notes.md' } },
      { ...correct, anchor: { ...correct.anchor, commit_id: BASE } },
      { ...correct, anchor: { ...correct.anchor, start_line: 5, start_side: 'RIGHT' } },
      { ...correct, source: { ...correct.source, commit: HEAD, startLine: 6, endLine: 6 } },
    ];
    assert.doesNotThrow(() => { assertCaseOutcome(correct, c); });
    for (const wrong of misplaced) {
      assert.throws(() => { assertCaseOutcome(wrong, c); }, assert.AssertionError);
    }
  });
});

describe('authored surfaces regenerate the authored patch bodies', () => {
  /** One display line of a patch body for an authored source line, with its no-newline marker. */
  const bodyLine = (prefix: string, text: string) => (text.endsWith('\n')
    ? `${prefix}${text}`
    : `${prefix}${text}\n\\ No newline at end of file\n`);

  for (const [diffId, diff] of Object.entries(fixture.diffs)) {
    for (const entry of diff.files) {
      test(`${diffId}: surface of ${entry.path} matches its patch`, () => {
        const lines = entry.patch.slice(entry.patch.findIndex((l) => l.startsWith('@@')));
        const hunks: { header: string; body: string[] }[] = [];
        for (const l of lines) {
          if (l.startsWith('@@')) hunks.push({ header: l, body: [] });
          else at(hunks, hunks.length - 1).body.push(l);
        }
        assert.equal(hunks.length, entry.surface.length, 'hunk count');

        hunks.forEach((hunk, i) => {
          const rows = at(entry.surface, i);
          const [, oldStart, oldCount = '1', newStart, newCount = '1'] = present(HUNK_HEADER.exec(hunk.header), `hunk ${String(i)} header`);
          const olds = rows.map((r) => r[0]).filter((n) => n !== null);
          const news = rows.map((r) => r[1]).filter((n) => n !== null);
          assert.equal(olds.length, Number(oldCount), `hunk ${String(i)} old count`);
          assert.equal(news.length, Number(newCount), `hunk ${String(i)} new count`);
          if (olds.length) assert.deepEqual(olds, span(Number(oldStart), Number(oldStart) + olds.length - 1));
          if (news.length) assert.deepEqual(news, span(Number(newStart), Number(newStart) + news.length - 1));

          const generated = rows.map(([b, h]) => {
            if (h === null) return bodyLine('-', at(authoredLines(diff.baseCommit, entry.path), present(b, 'base line') - 1));
            if (b === null) return bodyLine('+', at(authoredLines(diff.headCommit, entry.path), h - 1));
            const baseText = at(authoredLines(diff.baseCommit, entry.path), b - 1);
            assert.equal(authoredLines(diff.headCommit, entry.path)[h - 1], baseText, `context row ${String(b)}/${String(h)} differs`);
            return bodyLine(' ', baseText);
          });
          assert.equal(generated.join(''), hunk.body.join(''), `hunk ${String(i)} body`);
        });
      });
    }
  }
});

describe('authored patches agree with an independent diff generator', () => {
  const gitEnvHome = fs.mkdtempSync(path.join(os.tmpdir(), 'placement-git-home-'));
  const env = {
    PATH: process.env['PATH'],
    HOME: gitEnvHome,
    XDG_CONFIG_HOME: gitEnvHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    LC_ALL: 'C',
  };
  const probe = spawnSync('git', ['--version'], { env, encoding: 'utf8' });

  /** Patch text from the first hunk header onward, discarding file headers. */
  const hunksOnly = (patch: string) => patch.slice(patch.indexOf('@@'));

  // Hand-authored orderings git never emits (gitReproducible: false) are not
  // enumerated here; the surface regeneration check and oracle cover them.
  for (const [diffId, diff] of Object.entries(fixture.diffs)) {
    for (const entry of diff.files.filter((f) => f.gitReproducible !== false)) {
      test(`${diffId}: git diff reproduces the authored hunks for ${entry.path}`, (t) => {
        if (probe.error || probe.status !== 0) {
          t.skip('git is unavailable');
          return;
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'placement-diff-'));
        const sides: Partial<Record<'base' | 'head', string>> = {};
        for (const [side, commit] of [['base', diff.baseCommit], ['head', diff.headCommit]] as const) {
          const snapshot = present(fixture.snapshots[commit], `snapshot ${commit}`);
          if (hasOwn(snapshot, entry.path)) {
            const file = path.join(dir, side, path.basename(entry.path));
            sides[side] = file;
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, present(snapshot[entry.path], entry.path).join(''));
          } else {
            sides[side] = '/dev/null';
          }
        }
        const run = spawnSync('git', [
          '-c', 'core.quotepath=false',
          'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv',
          `-U${String(entry.context === undefined ? 3 : entry.context)}`, '--diff-algorithm=myers', '--indent-heuristic',
          present(sides.base, 'base side'), present(sides.head, 'head side'),
        ], { env, cwd: dir, encoding: 'utf8' });
        assert.equal(run.status, 1, `git diff did not report a difference: ${run.stderr}`);
        assert.equal(hunksOnly(entry.patch.join('')), hunksOnly(run.stdout));
      });
    }
  }
});

describe('classifyPlacement: hand-authored expected placements', () => {
  for (const c of cases) {
    test(`${c.expect.kind}${c.expect.reason ? ` (${c.expect.reason})` : ''}: ${c.id}`, () => {
      assertCaseOutcome(classifyPlacement(requestFor(c)), c);
    });
  }
});

describe('classifyPlacement: suggestion ranges stay separate from feedback ranges', () => {
  for (const group of suggestionGroups) {
    const members = group.members.map((m) => ({ ...m, id: `${group.id}/${m.role}` }));

    for (const m of members) {
      test(`${m.id} is classified at exactly its own range`, () => {
        assertCaseOutcome(classifyPlacement(requestFor(m)), m);
      });
    }

    test(`${group.id}: outcomes do not depend on classification order`, () => {
      const diff = deepFreeze(fixtureDiff());
      const forward = members.map((m) => classifyPlacement(requestFor(m, { diff })));
      const backward = [...members].reverse().map((m) => classifyPlacement(requestFor(m, { diff }))).reverse();
      assert.deepStrictEqual(backward, forward);
      members.forEach((m, i) => {
        assertCaseOutcome(at(forward, i), m);
      });
    });
  }
});

describe('classifyPlacement: diff-side provenance is exact', () => {
  test('an advanced base branch tip labelled as the diff base is not accepted as the old patch\'s LEFT source', () => {
    const c = { commit: ADVANCED_BASE, path: 'src/calc.js', range: { start: 9, end: 9 } };
    const diff = fixtureDiff();
    diff.baseCommit = ADVANCED_BASE;
    assertRejected(classifyPlacement(requestFor(c, { diff })), 'patch-source-mismatch');
  });

  test('an advanced head labelled as the diff head is not accepted as the old patch\'s RIGHT source', () => {
    const c = { commit: ADVANCED_HEAD, path: 'src/calc.js', range: { start: 24, end: 24 } };
    const diff = fixtureDiff();
    diff.headCommit = ADVANCED_HEAD;
    assertRejected(classifyPlacement(requestFor(c, { diff })), 'patch-source-mismatch');
  });

  test('base-context source anchored RIGHT keeps its base identity and the review commit is the diff head', () => {
    const c = caseById('base-multiline-context-shifted-anchors-right');
    const result = classifyPlacement(requestFor(c));
    assert.deepStrictEqual('source' in result ? result.source : undefined, {
      commit: BASE, path: 'src/calc.js', startLine: 9, endLine: 11, text: '}\n\n// helpers',
    });
    assert.equal('anchor' in result ? result.anchor.commit_id : undefined, HEAD);
  });

  test('the review commit of a LEFT anchor is the diff head, while source identity stays the base', () => {
    const c = caseById('left-replaced-deletion');
    const result = classifyPlacement(requestFor(c));
    assert.equal('anchor' in result ? result.anchor.commit_id : undefined, HEAD);
    assert.equal('source' in result ? result.source.commit : undefined, BASE);
  });
});

describe('classifyPlacement: untrusted source text or patch is rejected, never relocated', () => {
  const calcAddition = caseById('right-first-inserted-line');

  test('head commit claimed for base text (wrong commit) is rejected', () => {
    const result = classifyPlacement(requestFor(calcAddition, { text: sourceText(BASE, 'src/calc.js') }));
    assertRejected(result, 'patch-source-mismatch');
  });

  test('another file\'s text under this path (wrong file) is rejected', () => {
    const c = withChanges(calcAddition, { range: { start: 1, end: 1 } });
    const result = classifyPlacement(requestFor(c, { text: sourceText(HEAD, 'docs/notes.md') }));
    assertRejected(result, 'patch-source-mismatch');
  });

  test('a patch line that disagrees with the source anywhere in the file is rejected', () => {
    const patch = authoredPatchLines('src/calc.js').join('').replace('+  return x * 2;\n', '+  return x * 3;\n');
    const result = classifyPlacement(requestFor(calcAddition, { diff: diffWithPatch('src/calc.js', patch) }));
    assertRejected(result, 'patch-source-mismatch');
  });

  test('a patch without CR bytes for a CRLF source is rejected', () => {
    const c = caseById('left-crlf-deletion');
    const patch = authoredPatchLines('win/config.ini').join('').replace(/\r/g, '');
    const result = classifyPlacement(requestFor(c, { diff: diffWithPatch('win/config.ini', patch) }));
    assertRejected(result, 'patch-source-mismatch');
  });

  test('a head-side missing-newline marker contradicting the source is rejected', () => {
    const c = caseById('right-non-ascii-first-line');
    const result = classifyPlacement(requestFor(c, { text: `${sourceText(HEAD, 'docs/notes.md')}\n` }));
    assertRejected(result, 'patch-source-mismatch');
  });

  test('a base-side missing-newline marker contradicting the source is rejected', () => {
    const c = caseById('left-base-side-no-newline-marker');
    const result = classifyPlacement(requestFor(c, { text: 'a\nb\n' }));
    assertRejected(result, 'patch-source-mismatch');
  });

  test('a single-line base source whose newline contradicts the marker is rejected', () => {
    const c = caseById('left-single-line-without-terminal-newline');
    const result = classifyPlacement(requestFor(c, { text: 'alpha\n' }));
    assertRejected(result, 'patch-source-mismatch');
  });

  test('a source final line without newline but no patch marker is rejected', () => {
    const c = caseById('right-line-that-gained-terminal-newline');
    const result = classifyPlacement(requestFor(c, { text: 'a\nb' }));
    assertRejected(result, 'patch-source-mismatch');
  });

  test('a hunk claiming more lines than the source has is rejected', () => {
    const c = caseById('right-added-file-whole');
    const patch = authoredPatchLines('src/new.js').join('')
      .replace('@@ -0,0 +1,2 @@', '@@ -0,0 +1,3 @@')
      .concat('+export const z = 3;\n');
    const result = classifyPlacement(requestFor(c, { diff: diffWithPatch('src/new.js', patch) }));
    assertRejected(result, 'patch-source-mismatch');
  });

  test('base commit claimed for a file the patch creates is rejected', () => {
    const c = { commit: BASE, path: 'src/new.js', range: { start: 1, end: 1 } };
    const result = classifyPlacement(requestFor(c, { text: 'export const x = 1;\n' }));
    assertRejected(result, 'patch-source-mismatch');
  });

  test('head commit claimed for a file the patch deletes is rejected', () => {
    const c = { commit: HEAD, path: 'src/old.js', range: { start: 1, end: 1 } };
    const result = classifyPlacement(requestFor(c, { text: 'module.exports = 1;\n' }));
    assertRejected(result, 'patch-source-mismatch');
  });

  test('a truncated patch is rejected even for a line in an intact hunk', () => {
    const patch = authoredPatchLines('src/calc.js').slice(0, -1).join('');
    const result = classifyPlacement(requestFor(calcAddition, { diff: diffWithPatch('src/calc.js', patch) }));
    assertRejected(result, 'malformed-patch');
  });

  test('a hunk body longer than its header counts is rejected', () => {
    const patch = `${authoredPatchLines('src/calc.js').join('')} extra context\n`;
    const result = classifyPlacement(requestFor(calcAddition, { diff: diffWithPatch('src/calc.js', patch) }));
    assertRejected(result, 'malformed-patch');
  });

  test('an unparseable hunk header is rejected', () => {
    const patch = authoredPatchLines('src/calc.js').join('').replace('@@ -1,11 +1,13 @@', '@@ -1,x +1,13 @@');
    const result = classifyPlacement(requestFor(calcAddition, { diff: diffWithPatch('src/calc.js', patch) }));
    assertRejected(result, 'malformed-patch');
  });

  test('a body line without a unified-diff prefix is rejected', () => {
    const lines = [...authoredPatchLines('src/calc.js')];
    assert.equal(lines[7], ' }\n');
    lines[7] = '}\n';
    const result = classifyPlacement(requestFor(calcAddition, { diff: diffWithPatch('src/calc.js', lines.join('')) }));
    assertRejected(result, 'malformed-patch');
  });

  test('hunks out of order are rejected', () => {
    const lines = authoredPatchLines('src/calc.js');
    const second = lines.findIndex((l, i) => i > 0 && l.startsWith('@@'));
    const patch = [...lines.slice(second), ...lines.slice(0, second)].join('');
    const result = classifyPlacement(requestFor(calcAddition, { diff: diffWithPatch('src/calc.js', patch) }));
    assertRejected(result, 'malformed-patch');
  });

  test('a later hunk whose line offset contradicts earlier hunks is rejected', () => {
    const patch = authoredPatchLines('src/calc.js').join('')
      .replace('@@ -18,11 +20,7 @@', '@@ -18,11 +21,7 @@');
    const result = classifyPlacement(requestFor(calcAddition, { diff: diffWithPatch('src/calc.js', patch) }));
    assertRejected(result, 'malformed-patch');
  });

  test('a zero-count hunk whose position contradicts the offset is rejected', () => {
    const c = caseById('left-zero-context-deletion');
    const patch = authoredPatchLines('zero.txt').join('').replace('@@ -5 +5,0 @@', '@@ -5 +4,0 @@');
    const result = classifyPlacement(requestFor(c, { diff: diffWithPatch('zero.txt', patch) }));
    assertRejected(result, 'malformed-patch');
  });

  test('patch file headers naming a different path than the diff entry are rejected', () => {
    const c = { commit: HEAD, path: 'src/other.js', range: { start: 1, end: 1 } };
    const diff = fixtureDiff();
    present(diff.files.find((f) => f.path === 'src/new.js'), 'diff entry src/new.js').path = 'src/other.js';
    const result = classifyPlacement(requestFor(c, { text: sourceText(HEAD, 'src/new.js'), diff }));
    assertRejected(result, 'diff-path-mismatch');
  });

  test('a GitHub-style patch without a trailing newline is still verified and placed', () => {
    const c = caseById('right-second-hunk-addition');
    const patch = authoredPatchLines('src/calc.js').join('').replace(/\n$/, '');
    const result = classifyPlacement(requestFor(c, { diff: diffWithPatch('src/calc.js', patch) }));
    assertCaseOutcome(result, c);
  });
});

describe('classifyPlacement: patch file headers with spaced and non-ASCII paths', () => {
  const spaced = caseById('right-spaced-non-ascii-path');
  const hunks = authoredPatchLines('docs/my notes/café.md').join('');

  test('git-quoted octal-escaped paths are decoded and accepted', () => {
    const patch = '--- "a/docs/my notes/caf\\303\\251.md"\n+++ "b/docs/my notes/caf\\303\\251.md"\n' + hunks;
    const result = classifyPlacement(requestFor(spaced, { diff: diffWithPatch('docs/my notes/café.md', patch) }));
    assertCaseOutcome(result, spaced);
  });

  test('unquoted UTF-8 paths with spaces are accepted', () => {
    const patch = '--- a/docs/my notes/café.md\n+++ b/docs/my notes/café.md\n' + hunks;
    const result = classifyPlacement(requestFor(spaced, { diff: diffWithPatch('docs/my notes/café.md', patch) }));
    assertCaseOutcome(result, spaced);
  });

  test('a quoted path that decodes to a different file is rejected', () => {
    const patch = '--- "a/docs/my notes/caf\\303\\250.md"\n+++ "b/docs/my notes/caf\\303\\250.md"\n' + hunks;
    const result = classifyPlacement(requestFor(spaced, { diff: diffWithPatch('docs/my notes/café.md', patch) }));
    assertRejected(result, 'diff-path-mismatch');
  });

  // Git terminates a ---/+++ label containing a space with a TAB, quoted or not.
  test('regression: a quoted spaced path followed by Git\'s separator TAB is accepted', () => {
    const patch = '--- "a/docs/my notes/caf\\303\\251.md"\t\n+++ "b/docs/my notes/caf\\303\\251.md"\t\n' + hunks;
    const result = classifyPlacement(requestFor(spaced, { diff: diffWithPatch('docs/my notes/café.md', patch) }));
    assertCaseOutcome(result, spaced);
  });

  test('regression: an unquoted spaced path followed by Git\'s separator TAB is accepted', () => {
    const patch = '--- a/docs/my notes/café.md\t\n+++ b/docs/my notes/café.md\t\n' + hunks;
    const result = classifyPlacement(requestFor(spaced, { diff: diffWithPatch('docs/my notes/café.md', patch) }));
    assertCaseOutcome(result, spaced);
  });

  test('a quoted path followed by anything other than the separator TAB is rejected', () => {
    const patch = '--- "a/docs/my notes/caf\\303\\251.md"x\n+++ "b/docs/my notes/caf\\303\\251.md"\n' + hunks;
    const result = classifyPlacement(requestFor(spaced, { diff: diffWithPatch('docs/my notes/café.md', patch) }));
    assertRejected(result, 'malformed-patch');
  });

  test('regression: a literal astral character inside a quoted path decodes as one code point', () => {
    const astralPath = 'docs/🎉 "notes".md';
    const c = { commit: HEAD, path: astralPath, range: { start: 1, end: 1 } };
    const patch = '--- "a/docs/🎉 \\"notes\\".md"\t\n+++ "b/docs/🎉 \\"notes\\".md"\t\n' + hunks;
    const diff = diffWithPatch('docs/my notes/café.md', patch, { path: astralPath });
    const result = classifyPlacement(requestFor(c, { text: sourceText(HEAD, 'docs/my notes/café.md'), diff }));
    assert.deepStrictEqual(result, {
      kind: 'inline',
      source: { commit: HEAD, path: astralPath, startLine: 1, endLine: 1, text: 'Grüße aus Köln!' },
      anchor: { commit_id: HEAD, path: astralPath, side: 'RIGHT', line: 1 },
    });
  });
});

describe('classifyPlacement: every primary case holds with complete Git output, headers included', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'placement-repo-home-'));
  const env = {
    PATH: process.env['PATH'], HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  const available = !spawnSync('git', ['--version'], { env }).error;

  /** A scratch repository whose index holds the head snapshot over a committed base snapshot. */
  function stagedRepository() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'placement-repo-'));
    const write = (snapshot: Record<string, string[]>) => {
      for (const [p, lines] of Object.entries(snapshot)) {
        fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
        fs.writeFileSync(path.join(dir, p), lines.join(''));
      }
    };
    assert.equal(git(dir, ['init', '-q']).status, 0);
    write(present(fixture.snapshots[BASE], 'base snapshot'));
    assert.equal(git(dir, ['add', '-A']).status, 0);
    assert.equal(git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base']).status, 0);
    for (const p of Object.keys(present(fixture.snapshots[BASE], 'base snapshot'))) {
      if (!hasOwn(present(fixture.snapshots[HEAD], 'head snapshot'), p)) fs.unlinkSync(path.join(dir, p));
    }
    write(present(fixture.snapshots[HEAD], 'head snapshot'));
    assert.equal(git(dir, ['add', '-A']).status, 0);
    return dir;
  }

  for (const quotePath of ['true', 'false']) {
    test(`core.quotepath=${quotePath}`, (t) => {
      if (!available) {
        t.skip('git is unavailable');
        return;
      }
      const dir = stagedRepository();
      const diff = fixtureDiff();
      for (const entry of diff.files) {
        const authored = present(authoredDiff().files.find((f) => f.path === entry.path), `authored entry ${entry.path}`);
        const run = git(dir, ['-c', `core.quotepath=${quotePath}`, 'diff', '--cached', '--no-color', '--no-ext-diff',
          '--no-textconv', '--no-renames', `-U${String(authored.context === undefined ? 3 : authored.context)}`,
          '--diff-algorithm=myers', '--indent-heuristic', '--', entry.path]);
        assert.equal(run.status, 0, run.stderr);
        assert.ok(run.stdout.startsWith('diff --git '), `no full Git patch for ${entry.path}`);
        entry.patch = run.stdout;
      }
      for (const c of cases.filter((x) => (x.diff ?? 'primary') === 'primary')) {
        assertCaseOutcome(classifyPlacement(requestFor(c, { diff })), c);
      }
    });
  }
});

describe('classifyPlacement: whole-file creation and deletion patches must cover the source', () => {
  test('regression: a creation patch shorter than the head source is rejected', () => {
    const patch = '--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1,2 @@\n+x\n+y\n';
    for (const line of [1, 3]) {
      const c = { commit: HEAD, path: 'src/new.js', range: { start: line, end: line } };
      const result = classifyPlacement(requestFor(c, { text: 'x\ny\nz\n', diff: diffWithPatch('src/new.js', patch) }));
      assertRejected(result, 'patch-source-mismatch');
    }
  });

  test('regression: a deletion patch shorter than the base source is rejected', () => {
    const patch = '--- a/src/old.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n';
    const c = { commit: BASE, path: 'src/old.js', range: { start: 1, end: 1 } };
    const result = classifyPlacement(requestFor(c, { text: 'x\ny\nz\n', diff: diffWithPatch('src/old.js', patch) }));
    assertRejected(result, 'patch-source-mismatch');
  });

  test('regression: a new-file header contradicting an old-side hunk count is malformed', () => {
    const patch = 'new file mode 100644\n--- /dev/null\n+++ b/src/new.js\n@@ -1 +1 @@\n-x\n+export const x = 1;\n';
    const c = caseById('right-added-file-whole');
    const result = classifyPlacement(requestFor(c, { diff: diffWithPatch('src/new.js', patch) }));
    assertRejected(result, 'malformed-patch');
  });

  test('regression: a deleted-file header contradicting a new-side hunk count is malformed', () => {
    const patch = 'deleted file mode 100644\n--- a/src/old.js\n+++ /dev/null\n@@ -1 +1 @@\n-module.exports = 1;\n+y\n';
    const c = caseById('left-deleted-file');
    const result = classifyPlacement(requestFor(c, { diff: diffWithPatch('src/old.js', patch) }));
    assertRejected(result, 'malformed-patch');
  });

  test('a creation patch split across hunks is malformed', () => {
    const patch = '--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1 @@\n+export const x = 1;\n@@ -0,0 +2 @@\n+export const y = 2;\n';
    const c = caseById('right-added-file-whole');
    const result = classifyPlacement(requestFor(c, { diff: diffWithPatch('src/new.js', patch) }));
    assertRejected(result, 'malformed-patch');
  });
});

describe('classifyPlacement: hunk header edge cases', () => {
  const calcAddition = caseById('right-first-inserted-line');

  test('regression: a hunk that changes nothing on either side is malformed', () => {
    const patch = `${authoredPatchLines('src/calc.js').join('')}@@ -30,0 +28,0 @@\n`;
    const result = classifyPlacement(requestFor(calcAddition, { diff: diffWithPatch('src/calc.js', patch) }));
    assertRejected(result, 'malformed-patch');
  });

  for (const [name, separator] of [['CR', '\r'], ['U+2028', ' '], ['U+2029', ' ']] as const) {
    test(`regression: a hunk section heading containing ${name} is accepted`, () => {
      const patch = authoredPatchLines('src/calc.js').join('')
        .replace('@@ -18,11 +20,7 @@ function noop() {', `@@ -18,11 +20,7 @@ function${separator} noop() {`);
      const c = caseById('right-second-hunk-addition');
      assertCaseOutcome(classifyPlacement(requestFor(c, { diff: diffWithPatch('src/calc.js', patch) })), c);
    });
  }
});

describe('classifyPlacement: explicit unsupported outcomes', () => {
  const renamedHead = { commit: HEAD, path: 'src/calc2.js', range: { start: 23, end: 23 } };
  const renamedSource = {
    commit: HEAD, path: 'src/calc2.js', startLine: 23, endLine: 23, text: '  return x * 2;',
  };

  test('a rename identified by patch headers is unsupported, not guessed', () => {
    const patch = [
      'diff --git a/src/calc.js b/src/calc2.js\n',
      'similarity index 90%\n',
      'rename from src/calc.js\n',
      'rename to src/calc2.js\n',
      '--- a/src/calc.js\n',
      '+++ b/src/calc2.js\n',
      ...authoredPatchLines('src/calc.js'),
    ].join('');
    const diff = diffWithPatch('src/calc.js', patch, { path: 'src/calc2.js' });
    const result = classifyPlacement(requestFor(renamedHead, { text: sourceText(HEAD, 'src/calc.js'), diff }));
    assert.deepStrictEqual(result, { kind: 'unsupported', reason: 'rename-unsupported', source: renamedSource });
  });

  test('a rename identified by previousPath is unsupported, not guessed', () => {
    const diff = diffWithPatch('src/calc.js', authoredPatchLines('src/calc.js').join(''), {
      path: 'src/calc2.js', previousPath: 'src/calc.js',
    });
    const result = classifyPlacement(requestFor(renamedHead, { text: sourceText(HEAD, 'src/calc.js'), diff }));
    assert.deepStrictEqual(result, { kind: 'unsupported', reason: 'rename-unsupported', source: renamedSource });
  });

  test('base source at a renamed file\'s previous path is unsupported, not treated as unchanged', () => {
    const c = { commit: BASE, path: 'src/calc.js', range: { start: 21, end: 21 } };
    const diff = diffWithPatch('src/calc.js', authoredPatchLines('src/calc.js').join(''), {
      path: 'src/calc2.js', previousPath: 'src/calc.js',
    });
    const result = classifyPlacement(requestFor(c, { diff }));
    assert.deepStrictEqual(result, {
      kind: 'unsupported',
      reason: 'rename-unsupported',
      source: { commit: BASE, path: 'src/calc.js', startLine: 21, endLine: 21, text: '  return x;' },
    });
  });

  const unavailable = {
    kind: 'unsupported',
    reason: 'patch-unavailable',
    source: { commit: HEAD, path: 'src/calc.js', startLine: 23, endLine: 23, text: '  return x * 2;' },
  };

  test('a changed file without an available patch is unsupported rather than assumed unchanged', () => {
    const c = caseById('right-second-hunk-addition');
    const result = classifyPlacement(requestFor(c, { diff: diffWithPatch('src/calc.js', undefined) }));
    assert.deepStrictEqual(result, unavailable);
  });

  for (const [name, patch] of [
    ['binary', 'diff --git a/src/calc.js b/src/calc.js\nindex 1111111..2222222 100644\nBinary files a/src/calc.js and b/src/calc.js differ\n'],
    ['mode-only', 'diff --git a/src/calc.js b/src/calc.js\nold mode 100644\nnew mode 100755\n'],
    ['header-only', '--- a/src/calc.js\n+++ b/src/calc.js\n'],
  ] as const) {
    test(`a ${name} patch without hunks is unsupported rather than assumed unchanged`, () => {
      const c = caseById('right-second-hunk-addition');
      const result = classifyPlacement(requestFor(c, { diff: diffWithPatch('src/calc.js', patch) }));
      assert.deepStrictEqual(result, unavailable);
    });
  }

  test('base source at a path named only by another entry\'s rename-from header is unsupported', () => {
    const patch = [
      'diff --git a/src/calc.js b/src/calc2.js\n', 'similarity index 90%\n',
      'rename from src/calc.js\n', 'rename to src/calc2.js\n',
      '--- a/src/calc.js\n', '+++ b/src/calc2.js\n', ...authoredPatchLines('src/calc.js'),
    ].join('');
    const c = { commit: BASE, path: 'src/calc.js', range: { start: 21, end: 21 } };
    const diff = diffWithPatch('src/calc.js', patch, { path: 'src/calc2.js' });
    assert.deepStrictEqual(classifyPlacement(requestFor(c, { diff })), {
      kind: 'unsupported',
      reason: 'rename-unsupported',
      source: { commit: BASE, path: 'src/calc.js', startLine: 21, endLine: 21, text: '  return x;' },
    });
  });

  test('a changed file with an empty patch is unsupported rather than assumed unchanged', () => {
    const c = caseById('right-second-hunk-addition');
    const result = classifyPlacement(requestFor(c, { diff: diffWithPatch('src/calc.js', '') }));
    assert.deepStrictEqual(result, unavailable);
  });
});

describe('classifyPlacement: identity inputs are validated exactly', () => {
  const c = caseById('right-first-inserted-line');

  test('an abbreviated commit is rejected rather than prefix-matched to the head', () => {
    const request = requestFor(c);
    request.source.commit = HEAD.slice(0, 7);
    assertRejected(classifyPlacement(request), 'invalid-input');
  });

  test('a non-canonical uppercase commit is rejected', () => {
    const request = requestFor(c);
    request.source.commit = HEAD.toUpperCase();
    assertRejected(classifyPlacement(request), 'invalid-input');
  });

  for (const badPath of ['', './src/calc.js', '/src/calc.js', 'src\\calc.js', 'src/../src/calc.js', 'src//calc.js', 'src/calc.js/']) {
    test(`a non-normalized source path is rejected: ${JSON.stringify(badPath)}`, () => {
      const request = requestFor(c);
      request.source.path = badPath;
      assertRejected(classifyPlacement(request), 'invalid-input');
    });
  }

  test('non-string source text is rejected', () => {
    const request = requestFor(c);
    request.source.text = Buffer.from(asString(request.source.text));
    assertRejected(classifyPlacement(request), 'invalid-input');
  });

  test('a missing range is rejected', () => {
    const request = requestFor(c);
    Reflect.deleteProperty(request, 'range');
    assertRejected(classifyPlacement(request), 'invalid-input');
  });

  test('a missing diff context is rejected', () => {
    const request = requestFor(c);
    Reflect.deleteProperty(request, 'diff');
    assertRejected(classifyPlacement(request), 'invalid-input');
  });

  test('an abbreviated diff head commit is rejected', () => {
    const request = requestFor(c);
    request.diff.headCommit = HEAD.slice(0, 12);
    assertRejected(classifyPlacement(request), 'invalid-input');
  });

  test('a diff whose base and head are the same commit is rejected', () => {
    const request = requestFor(c);
    request.diff.baseCommit = HEAD;
    assertRejected(classifyPlacement(request), 'invalid-diff');
  });

  test('a diff listing the same path twice is rejected', () => {
    const request = requestFor(c);
    request.diff.files.push({ ...at(request.diff.files, 0) });
    assertRejected(classifyPlacement(request), 'invalid-diff');
  });
});

describe('classifyPlacement: boundary behavior', () => {
  test('does not mutate its input and is deterministic', () => {
    const c = caseById('base-multiline-context-shifted-anchors-right');
    const request = deepFreeze(requestFor(c));
    const first = classifyPlacement(request);
    const second = classifyPlacement(request);
    assert.deepStrictEqual(second, first);
    assertCaseOutcome(first, c);
  });
});
