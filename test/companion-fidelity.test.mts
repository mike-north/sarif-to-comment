/**
 * Unit tests for the companion fidelity projection (src/companion-fidelity.cts;
 * docs/companion-suggestion-pr-contract.md §2.5.1).
 *
 * Each scenario mirrors one of the bounded assessment's local repositories
 * (rewritten history: H the head, R the reviewed commit, M their merge base,
 * P = R plus the proposal), built here as in-memory trees with real Git
 * object ids. The expected verdicts come from the contract's verdict table,
 * and agree with the assessment's oracle, `git merge-tree` with renames off
 * (merge = merge-tree(H, P); target = merge-tree --merge-base=R H P;
 * faithful when the merge is clean and equal to the target), except where
 * the contract decides otherwise, each noted at its test:
 *
 * | Scenario | Oracle (run4)               | Projection                                         |
 * | -------- | --------------------------- | -------------------------------------------------- |
 * | E1       | conflict at f               | conflicts: f                                       |
 * | E1b      | faithful                    | faithful                                           |
 * | E2       | unfaithful: added would-lose| unfaithful: added loses its change                 |
 * | E3       | conflict at other           | unfaithful: dropped would come back (beside it)    |
 * | E4       | unfaithful: f (mode)        | unfaithful: f brings back content                  |
 * | E5       | target undefined at b       | unfaithful: a would be removed; b not expressible  |
 * | E6       | faithful (renames off)      | unfaithful: directory-rename trigger d/ (a limit)  |
 * | E7       | target undefined (x)        | unfaithful: x removed, x/y comes back; x/z file and directory|
 * | E8       | faithful (two merge bases)  | faithful, from either merge base                   |
 * | E9       | unfaithful: sub would-restore| unfaithful: sub brings back content               |
 * | S1, S2   | faithful                    | faithful                                           |
 * | S3, S6   | unfaithful: f               | unfaithful: f brings back content                  |
 * | S4, S4b, S5 | conflict at f            | conflicts: f                                       |
 *
 * The merge-attribute scenarios reproduce a `git merge-tree` result too:
 * with `f merge=union` at every commit, the reviewer's case below merges
 * cleanly and brings back the reviewed commit's line 10, where the same
 * history without the attribute conflicts.
 *
 * @see docs/companion-suggestion-pr-contract.md
 * @see https://git-scm.com/docs/git-merge-tree
 * @see https://git-scm.com/docs/gitattributes#_performing_a_three_way_merge
 */

import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { describe, test } from 'node:test';

import { gitBlobId, projectCompanion } from '../dist/companion-fidelity.cjs';
import type { CompanionProjection, IProjectedEntry, ProjectedChange } from '../dist/companion-fidelity.cjs';

// ---------------------------------------------------------------------------
// In-memory commits

/** A file's content: text (mode 100644), or an explicit mode and bytes, or a submodule's commit. */
type Content = string | { readonly mode: '100644' | '100755' | '120000'; readonly text: string } | { readonly submodule: string };

/** A commit's files by path. */
type Files = Readonly<Record<string, Content>>;

/** Fake commit ids for the scenario's commits. */
const COMMIT = { M: 'a'.repeat(40), R: 'b'.repeat(40), H: 'c'.repeat(40), M2: 'd'.repeat(40) } as const;

interface IWorld {
  readonly trees: Map<string, Map<string, IProjectedEntry>>;
  readonly blobs: Map<string, Uint8Array>;
  readonly treeReads: string[];
  readonly blobReads: string[];
  truncated: Set<string>;
}

function entryOf(content: Content, blobs: Map<string, Uint8Array>): IProjectedEntry {
  if (typeof content !== 'string' && 'submodule' in content) return { mode: '160000', oid: content.submodule };
  const text = typeof content === 'string' ? content : content.text;
  const mode = typeof content === 'string' ? '100644' : content.mode;
  const bytes = Buffer.from(text, 'utf8');
  const oid = gitBlobId(bytes);
  blobs.set(oid, bytes);
  return { mode, oid, size: bytes.length };
}

/** A world of commits (by id) holding `files`. */
function world(commits: Readonly<Record<string, Files>>): IWorld {
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, Map<string, IProjectedEntry>>();
  for (const [commit, files] of Object.entries(commits)) {
    trees.set(commit, new Map(Object.entries(files).map(([path, content]) => [path, entryOf(content, blobs)])));
  }
  return { trees, blobs, treeReads: [], blobReads: [], truncated: new Set() };
}

/** Projects `changes` onto H in `w`, from the merge base `mergeBase` (default M). */
async function project(w: IWorld, changes: readonly ProjectedChange[], mergeBase: string | null = COMMIT.M, maxBlobBytes = 1_000_000): Promise<CompanionProjection> {
  return projectCompanion({
    reviewed: COMMIT.R,
    head: COMMIT.H,
    mergeBase,
    maxBlobBytes,
    sources: {
      tree: (commit) => {
        w.treeReads.push(commit);
        const entries = w.trees.get(commit);
        if (entries === undefined) return Promise.reject(new Error(`no commit ${commit}`));
        return Promise.resolve({ truncated: w.truncated.has(commit), entries });
      },
      blob: (oid) => {
        w.blobReads.push(oid);
        const bytes = w.blobs.get(oid);
        if (bytes === undefined) return Promise.reject(new Error(`no blob ${oid}`));
        return Promise.resolve(bytes);
      },
    },
  }, changes);
}

const edit = (path: string, text: string): ProjectedChange => ({ operation: 'edit', path, text });
const create = (path: string, text: string, fileMode: '100644' | '100755' = '100644'): ProjectedChange => ({ operation: 'create', path, text, fileMode });
const remove = (path: string): ProjectedChange => ({ operation: 'delete', path });

const FAITHFUL: CompanionProjection = { verdict: 'faithful' };
const conflicts = (...paths: string[]): CompanionProjection => ({ verdict: 'conflicts', conflicts: paths });

/** The 20-line file of the S scenarios (`seq 1 20 | sed 's/^/line /'`), with some lines replaced. */
function lines(replaced: Readonly<Record<number, string>> = {}): string {
  return Array.from({ length: 20 }, (_, i) => `${replaced[i + 1] ?? `line ${String(i + 1)}`}\n`).join('');
}

const gitlink = (label: string): Content => ({ submodule: crypto.createHash('sha1').update(label).digest('hex') });

// ---------------------------------------------------------------------------

describe('E1–E9: what a blob- or ancestry-level rule gets wrong', () => {
  test('E1: the proposal edits the line the pull request changed, and the head kept it: conflicts', async () => {
    const w = world({ [COMMIT.M]: { f: 'a\nx\ny\n' }, [COMMIT.R]: { f: 'b\nx\ny\n' }, [COMMIT.H]: { f: 'b\nx\ny\n', other: 'h\n' } });
    assert.deepEqual(await project(w, [edit('f', 'c\nx\ny\n')]), conflicts('f'));
  });

  test('E1b: the proposal edits a line far from the pull request\'s change: faithful', async () => {
    const w = world({ [COMMIT.M]: { f: 'a\n1\n2\n3\n4\ny\n' }, [COMMIT.R]: { f: 'b\n1\n2\n3\n4\ny\n' }, [COMMIT.H]: { f: 'b\n1\n2\n3\n4\ny\n', other: 'h\n' } });
    assert.deepEqual(await project(w, [edit('f', 'b\n1\n2\n3\n4\nz\n')]), FAITHFUL);
  });

  test('E2: the proposal deletes a file the pull request added: the merge would keep it, so it loses its change', async () => {
    const w = world({ [COMMIT.M]: { keep: 'base\n' }, [COMMIT.R]: { keep: 'base\n', added: 'new\n' }, [COMMIT.H]: { keep: 'base\n', added: 'new\n', other: 'h\n' } });
    assert.deepEqual(await project(w, [remove('added')]), { verdict: 'unfaithful', reasons: [{ path: 'added', reason: 'loses' }], limits: [] });
  });

  test('E3: a file the rewrite dropped would come back; the proposal\'s own file conflicts, which does not excuse it', async () => {
    // The oracle classifies E3 as a conflict (its merge conflicts at `other`).
    // The contract judges each path: `dropped` merges cleanly back into the
    // head, which brings back content the head no longer has, so the
    // suggestion pull request is not created.
    const w = world({ [COMMIT.M]: { other: 'base\n' }, [COMMIT.R]: { other: 'base2\n', dropped: 'dropped\n' }, [COMMIT.H]: { other: 'base2\n' } });
    assert.deepEqual(await project(w, [edit('other', 'prop\n')]), { verdict: 'unfaithful', reasons: [{ path: 'dropped', reason: 'restores' }], limits: [] });
  });

  test('E4: a mode-only change the rewrite dropped would come back (same blob, different mode)', async () => {
    const w = world({ [COMMIT.M]: { f: 'a\n' }, [COMMIT.R]: { f: { mode: '100755', text: 'a\n' } }, [COMMIT.H]: { f: 'a\n', other: 'h\n' } });
    assert.deepEqual(await project(w, [edit('f', 'a\nprop\n')]), { verdict: 'unfaithful', reasons: [{ path: 'f', reason: 'restores' }], limits: [] });
  });

  test('E5: a rename the rewrite dropped: the old name would go and the edited new name cannot be expressed at the head', async () => {
    const w = world({ [COMMIT.M]: { a: 'a\n' }, [COMMIT.R]: { b: 'a\n' }, [COMMIT.H]: { a: 'a\n', other: 'h\n' } });
    assert.deepEqual(await project(w, [edit('b', 'a\nprop\n')]), {
      verdict: 'unfaithful', reasons: [{ path: 'a', reason: 'removes' }, { path: 'b', reason: 'not-expressible' }], limits: [],
    });
  });

  test('E6: a directory the head renamed receives the proposal\'s new file: a directory-rename trigger, which the projection cannot decide', async () => {
    // With renames off the oracle finds E6 faithful; Git's merge, which
    // detects directory renames, would move or conflict on d/new. The
    // contract lists the trigger as a limit.
    const w = world({
      [COMMIT.M]: { 'd/x': 'x\n', 'd/y': 'y\n', other: 'o\n' },
      [COMMIT.R]: { 'd/x': 'x\n', 'd/y': 'y\n', other: 'o2\n' },
      [COMMIT.H]: { 'e/x': 'x\n', 'e/y': 'y\n', other: 'o2\n' },
    });
    assert.deepEqual(await project(w, [create('d/new', 'new\n')]), { verdict: 'unfaithful', reasons: [], limits: [{ kind: 'directory-rename', directory: 'd' }] });
  });

  test('E7: the pull request turned a file into a directory; the head kept the file: x would be removed, x/y comes back, and x/z would be a file under a file', async () => {
    const w = world({ [COMMIT.M]: { x: 'x\n' }, [COMMIT.R]: { 'x/y': 'y\n' }, [COMMIT.H]: { x: 'x\n', other: 'h\n' } });
    assert.deepEqual(await project(w, [create('x/z', 'z\n')]), {
      verdict: 'unfaithful',
      reasons: [{ path: 'x', reason: 'removes' }, { path: 'x/y', reason: 'restores' }, { path: 'x/z', reason: 'file-and-directory' }],
      limits: [],
    });
  });

  test('E8: a criss-cross history with two merge bases projects faithful from either one, as Git\'s recursive base does', async () => {
    // s1 and s2 changed lines 1 and 3 of f; R and H each merged both and
    // made the same change to g. GitHub names one merge base; the result
    // must not depend on which.
    const s1 = { f: 'L1\nl2\nl3\n', g: 'g\n' };
    const s2 = { f: 'l1\nl2\nL3\n', g: 'g\n' };
    const w = world({ [COMMIT.M]: s1, [COMMIT.M2]: s2, [COMMIT.R]: { f: 'L1\nl2\nL3\n', g: 'gR\n' }, [COMMIT.H]: { f: 'L1\nl2\nL3\n', g: 'gR\n' } });
    assert.deepEqual(await project(w, [create('prop.txt', 'prop\n')], COMMIT.M), FAITHFUL);
    assert.deepEqual(await project(w, [create('prop.txt', 'prop\n')], COMMIT.M2), FAITHFUL);
  });

  test('E9: a submodule bump the rewrite dropped would come back', async () => {
    const w = world({ [COMMIT.M]: { other: 'o\n', sub: gitlink('x') }, [COMMIT.R]: { other: 'o\n', sub: gitlink('y') }, [COMMIT.H]: { other: 'o\n', sub: gitlink('x'), h: 'h\n' } });
    assert.deepEqual(await project(w, [edit('other', 'prop\n')]), { verdict: 'unfaithful', reasons: [{ path: 'sub', reason: 'restores' }], limits: [] });
  });
});

describe('S1–S6: realistic rewrites of a 20-line file', () => {
  test('S1: an amend that also changed another file: faithful', async () => {
    const w = world({ [COMMIT.M]: { f: lines(), g: lines() }, [COMMIT.R]: { f: lines({ 5: 'line 5 R' }), g: lines() }, [COMMIT.H]: { f: lines({ 5: 'line 5 R' }), g: lines({ 3: 'line 3 amended' }) } });
    assert.deepEqual(await project(w, [edit('f', lines({ 5: 'line 5 R', 15: 'line 15 prop' }))]), FAITHFUL);
  });

  test('S2: a rebase onto a moved base: faithful', async () => {
    const w = world({
      [COMMIT.M]: { f: lines() },
      [COMMIT.R]: { f: lines({ 5: 'line 5 R' }) },
      [COMMIT.H]: { f: lines({ 5: 'line 5 R', 18: 'line 18 base' }), newbase: 'n\n' },
    });
    assert.deepEqual(await project(w, [edit('f', lines({ 5: 'line 5 R', 10: 'line 10 prop' }))]), FAITHFUL);
  });

  test('S3: a dropped commit\'s line would come back beside the proposal', async () => {
    // The head is C1 (it dropped C2), so the merge base is C1 itself.
    const c1 = { f: lines({ 5: 'line 5 C1' }) };
    const w = world({ [COMMIT.M]: c1, [COMMIT.R]: { f: lines({ 5: 'line 5 C1', 6: 'line 6 C2' }) }, [COMMIT.H]: { ...c1, other: 'h\n' } });
    assert.deepEqual(await project(w, [edit('f', lines({ 5: 'line 5 C1', 6: 'line 6 C2', 10: 'line 10 prop' }))]),
      { verdict: 'unfaithful', reasons: [{ path: 'f', reason: 'restores' }], limits: [] });
  });

  test('S4: adjacent to a pull request change the amend changed again: conflicts', async () => {
    const w = world({ [COMMIT.M]: { f: lines() }, [COMMIT.R]: { f: lines({ 5: 'line 5 R' }) }, [COMMIT.H]: { f: lines({ 5: 'line 5 amended' }) } });
    assert.deepEqual(await project(w, [edit('f', lines({ 5: 'line 5 R', 6: 'line 6 prop' }))]), conflicts('f'));
  });

  test('S4b: adjacent to a pull request change the head kept identical: Git still conflicts on the touching change', async () => {
    const w = world({ [COMMIT.M]: { f: lines() }, [COMMIT.R]: { f: lines({ 5: 'line 5 R' }) }, [COMMIT.H]: { f: lines({ 5: 'line 5 R' }), other: 'h\n' } });
    assert.deepEqual(await project(w, [edit('f', lines({ 5: 'line 5 R', 6: 'line 6 prop' }))]), conflicts('f'));
  });

  test('S5: the proposal edits an untouched file, but the pull request\'s own file was amended at the head: conflicts there', async () => {
    const w = world({ [COMMIT.M]: { f: lines(), u: lines() }, [COMMIT.R]: { f: lines({ 5: 'line 5 R' }), u: lines() }, [COMMIT.H]: { f: lines({ 5: 'line 5 amended' }), u: lines() } });
    assert.deepEqual(await project(w, [edit('u', lines({ 7: 'line 7 prop' }))]), conflicts('f'));
  });

  test('S6: a dropped commit two lines from the proposal would come back', async () => {
    const c1 = { f: lines({ 5: 'line 5 C1' }) };
    const w = world({ [COMMIT.M]: c1, [COMMIT.R]: { f: lines({ 5: 'line 5 C1', 6: 'line 6 C2' }) }, [COMMIT.H]: c1 });
    assert.deepEqual(await project(w, [edit('f', lines({ 5: 'line 5 C1', 6: 'line 6 C2', 8: 'line 8 prop' }))]),
      { verdict: 'unfaithful', reasons: [{ path: 'f', reason: 'restores' }], limits: [] });
  });
});

describe('restoration around a conflict is not hidden by the conflict', () => {
  test('a conflict and, elsewhere in the same file, a dropped line that would come back: unfaithful', async () => {
    // R changed lines 5 and 15; the rewrite amended line 5 differently and
    // dropped line 15. The proposal edits line 6. The merge conflicts at
    // 5–6, and line 15 would come back cleanly outside the conflict.
    const w = world({
      [COMMIT.M]: { f: lines() },
      [COMMIT.R]: { f: lines({ 5: 'line 5 R', 15: 'line 15 R' }) },
      [COMMIT.H]: { f: lines({ 5: 'line 5 amended' }) },
    });
    assert.deepEqual(await project(w, [edit('f', lines({ 5: 'line 5 R', 6: 'line 6 prop', 15: 'line 15 R' }))]),
      { verdict: 'unfaithful', reasons: [{ path: 'f', reason: 'restores-beside-conflict' }], limits: [] });
  });

  test('the head deleted a file the proposal edits: the change cannot be expressed at the head', async () => {
    const w = world({ [COMMIT.M]: { f: 'a\n' }, [COMMIT.R]: { f: 'a\n' }, [COMMIT.H]: { other: 'h\n' } });
    assert.deepEqual(await project(w, [edit('f', 'b\n')]), { verdict: 'unfaithful', reasons: [{ path: 'f', reason: 'not-expressible' }], limits: [] });
  });

  test('the head deleted a file the pull request changed and the proposal leaves alone: a conflict GitHub shows, nothing brought back silently', async () => {
    const w = world({ [COMMIT.M]: { f: 'a\n', g: 'g\n' }, [COMMIT.R]: { f: 'b\n', g: 'g\n' }, [COMMIT.H]: { g: 'g\n' } });
    assert.deepEqual(await project(w, [edit('g', 'G\n')]), conflicts('f'));
  });

  test('both sides added the same path differently: the add/add conflicts', async () => {
    const w = world({ [COMMIT.M]: { a: 'a\n' }, [COMMIT.R]: { a: 'a\n' }, [COMMIT.H]: { a: 'a\n', n: 'theirs\n' } });
    assert.deepEqual(await project(w, [create('n', 'mine\n')]), conflicts('n'));
  });
});

describe('what the merge would change at the head', () => {
  test('a deletion the rewrite dropped would be applied again: the head\'s file would be removed', async () => {
    // The pull request deleted f; the rewrite kept it. Merging over M deletes
    // f again, which is not the suggestion's own change.
    const w = world({ [COMMIT.M]: { f: 'f\n', g: 'g\n' }, [COMMIT.R]: { g: 'g\n' }, [COMMIT.H]: { f: 'f\n', g: 'g\n', h: 'h\n' } });
    assert.deepEqual(await project(w, [edit('g', 'G\n')]), { verdict: 'unfaithful', reasons: [{ path: 'f', reason: 'removes' }], limits: [] });
  });

  test('a head that already has the suggestion\'s changes: faithful, and the merge changes nothing', async () => {
    const w = world({ [COMMIT.M]: { f: 'a\n' }, [COMMIT.R]: { f: 'b\n' }, [COMMIT.H]: { f: 'b\nc\n', other: 'h\n' } });
    assert.deepEqual(await project(w, [edit('f', 'b\nc\n')]), { verdict: 'faithful', headUnchanged: true });
  });

  test('a head that has only some of the suggestion\'s changes: faithful, and the merge changes the head', async () => {
    const w = world({ [COMMIT.M]: { f: 'a\n', g: 'g\n' }, [COMMIT.R]: { f: 'b\n', g: 'g\n' }, [COMMIT.H]: { f: 'b\nc\n', g: 'g\n' } });
    assert.deepEqual(await project(w, [edit('f', 'b\nc\n'), edit('g', 'G\n')]), FAITHFUL);
  });
});

/** The reviewer's case: R changed lines 10 and 11 (the rewrite dropped that), H changed line 10, and the proposal keeps R's line 10 and edits line 11. */
function reviewersCase(attributes: Readonly<Record<string, Content>> = {}, headAttributes = attributes): { readonly w: IWorld; readonly change: ProjectedChange } {
  const w = world({
    [COMMIT.M]: { f: lines(), ...attributes },
    [COMMIT.R]: { f: lines({ 10: 'line 10 R', 11: 'line 11 R' }), ...attributes },
    [COMMIT.H]: { f: lines({ 10: 'line 10 H' }), ...headAttributes },
  });
  return { w, change: edit('f', lines({ 10: 'line 10 R', 11: 'line 11 prop' })) };
}

const mergeAttribute = (path: string, attribute: string): CompanionProjection => ({ verdict: 'unfaithful', reasons: [], limits: [{ kind: 'merge-attribute', path, attribute }] });

describe('merge attributes: a driver other than the text merge is a limit', () => {
  test('regression: `merge=union` would turn the conflict into a clean merge that brings back line 10, so it cannot be projected', async () => {
    const { w, change } = reviewersCase({ '.gitattributes': 'f merge=union\n' });
    assert.deepEqual(await project(w, [change]), mergeAttribute('f', 'merge=union'));
  });

  test('regression: the text merge named on a line that ends in a comment-like word is discarded with that line, as Git discards it', async () => {
    const { w, change } = reviewersCase({ '.gitattributes': '* merge=union\nf merge=text # keep the text merge\n' });
    assert.deepEqual(await project(w, [change]), mergeAttribute('f', 'merge=union'));
  });

  test('the same history without attributes, or with the text merge named, conflicts', async () => {
    for (const attributes of [{}, { '.gitattributes': 'f merge=text\n' }, { '.gitattributes': 'f merge\n' }, { '.gitattributes': '* merge=union\nf !merge\n' }]) {
      const { w, change } = reviewersCase(attributes);
      assert.deepEqual(await project(w, [change]), conflicts('f'), JSON.stringify(attributes));
    }
  });

  test('`-merge` and the `binary` macro are other drivers, named as written', async () => {
    assert.deepEqual(await project(reviewersCase({ '.gitattributes': 'f -merge\n' }).w, [reviewersCase().change]), mergeAttribute('f', '-merge'));
    assert.deepEqual(await project(reviewersCase({ '.gitattributes': 'f binary\n' }).w, [reviewersCase().change]), mergeAttribute('f', 'binary'));
  });

  test('a driver applies to a file merged line by line even where that merge is clean', async () => {
    const w = world({
      [COMMIT.M]: { f: 'a\n1\n2\n3\n4\ny\n', '.gitattributes': '*.txt -diff\nf merge=union\n' },
      [COMMIT.R]: { f: 'b\n1\n2\n3\n4\ny\n', '.gitattributes': '*.txt -diff\nf merge=union\n' },
      [COMMIT.H]: { f: 'b\n1\n2\n3\n4\ny\n', other: 'h\n', '.gitattributes': '*.txt -diff\nf merge=union\n' },
    });
    assert.deepEqual(await project(w, [edit('f', 'b\n1\n2\n3\n4\nz\n')]), mergeAttribute('f', 'merge=union'));
  });

  test('a driver on a file no line merge involves is never consulted, and the attributes file is not read', async () => {
    const attributes = { '.gitattributes': '* merge=union\n' };
    const w = world({ [COMMIT.M]: { f: 'f\n', g: 'g\n', ...attributes }, [COMMIT.R]: { f: 'F\n', g: 'g\n', ...attributes }, [COMMIT.H]: { f: 'F\n', g: 'g\n', h: 'h\n', ...attributes } });
    assert.deepEqual(await project(w, [edit('g', 'G\n')]), FAITHFUL);
    assert.deepEqual(w.blobReads, []);
  });

  test('patterns are matched relative to the attributes file that holds them', async () => {
    const at = (path: string, attributes: Readonly<Record<string, Content>>): { readonly w: IWorld; readonly change: ProjectedChange } => {
      const w = world({
        [COMMIT.M]: { [path]: lines(), ...attributes },
        [COMMIT.R]: { [path]: lines({ 10: 'line 10 R', 11: 'line 11 R' }), ...attributes },
        [COMMIT.H]: { [path]: lines({ 10: 'line 10 H' }), ...attributes },
      });
      return { w, change: edit(path, lines({ 10: 'line 10 R', 11: 'line 11 prop' })) };
    };
    const cases: readonly [string, Readonly<Record<string, Content>>, CompanionProjection][] = [
      ['d/f', { 'd/.gitattributes': '/f merge=union\n' }, mergeAttribute('d/f', 'merge=union')],
      ['d/f', { '.gitattributes': '/f merge=union\n' }, conflicts('d/f')],
      ['docs/a.md', { '.gitattributes': '*.md merge=union\n' }, mergeAttribute('docs/a.md', 'merge=union')],
      ['docs/x/a', { '.gitattributes': 'docs/** merge=union\n' }, mergeAttribute('docs/x/a', 'merge=union')],
      ['a/b/f', { '.gitattributes': '**/f merge=union\n' }, mergeAttribute('a/b/f', 'merge=union')],
      ['d/f', { '.gitattributes': 'd/ merge=union\n' }, conflicts('d/f')],
      ['d/f', { '.gitattributes': '!f merge=union\n' }, conflicts('d/f')],
      ['d/f', { '.gitattributes': '* merge=union\n', 'd/.gitattributes': '* merge=text\n' }, conflicts('d/f')],
      ['d/f', { '.gitattributes': '* merge=text\n', 'd/.gitattributes': 'f merge=union\n' }, mergeAttribute('d/f', 'merge=union')],
      ['d/f', { '.gitattributes': '[attr]keep merge=union\n', 'd/.gitattributes': 'f keep\n' }, mergeAttribute('d/f', 'keep')],
    ];
    for (const [path, attributes, expected] of cases) {
      const { w, change } = at(path, attributes);
      assert.deepEqual(await project(w, [change]), expected, `${path} with ${JSON.stringify(attributes)}`);
    }
  });

  test('each attributes file is read once, however many paths need it', async () => {
    const attributes = { '.gitattributes': '* merge=text\n' };
    const w = world({
      [COMMIT.M]: { f: lines(), g: lines(), ...attributes },
      [COMMIT.R]: { f: lines({ 10: 'line 10 R' }), g: lines({ 10: 'line 10 R' }), ...attributes },
      [COMMIT.H]: { f: lines({ 10: 'line 10 H' }), g: lines({ 10: 'line 10 H' }), ...attributes },
    });
    assert.deepEqual(await project(w, [edit('f', lines({ 10: 'line 10 P' })), edit('g', lines({ 10: 'line 10 P' }))]), conflicts('f', 'g'));
    const oid = w.trees.get(COMMIT.H)?.get('.gitattributes')?.oid;
    assert.equal(w.blobReads.filter((read) => read === oid).length, 1);
  });

  test('an attributes file on the way that is not a regular file, or is listed without its size, cannot be read: stated once', async () => {
    const link: Content = { mode: '120000', text: 'elsewhere' };
    const { w, change } = reviewersCase({ '.gitattributes': link });
    assert.deepEqual(await project(w, [change]), { verdict: 'unfaithful', reasons: [], limits: [{ kind: 'attributes-unreadable', path: '.gitattributes' }] });

    const unsized = reviewersCase({ '.gitattributes': 'f merge=text\n' });
    for (const tree of unsized.w.trees.values()) {
      const entry = tree.get('.gitattributes');
      if (entry !== undefined) tree.set('.gitattributes', { mode: entry.mode, oid: entry.oid });
    }
    assert.deepEqual(await project(unsized.w, [unsized.change]), { verdict: 'unfaithful', reasons: [], limits: [{ kind: 'size-unknown', path: '.gitattributes' }] });
  });
});

describe('attributes files that differ between the commits', () => {
  test('one the head added that could assign a merge driver is a limit, beside the driver it assigns', async () => {
    const { w, change } = reviewersCase({}, { '.gitattributes': 'f merge=union\n' });
    assert.deepEqual(await project(w, [change]), {
      verdict: 'unfaithful', reasons: [], limits: [{ kind: 'attributes-changed', path: '.gitattributes' }, { kind: 'merge-attribute', path: 'f', attribute: 'merge=union' }],
    });
  });

  test('one that sets no merge attribute in any version is safe', async () => {
    const { w, change } = reviewersCase({ '.gitattributes': '*.png -diff\n' }, { '.gitattributes': '*.png -diff\n*.sh text eol=lf\n' });
    assert.deepEqual(await project(w, [change]), conflicts('f'));
  });

  test('one that uses a macro the root file defines to set a merge driver is a limit, even off the merged paths\' way', async () => {
    const w = world({
      [COMMIT.M]: { '.gitattributes': '[attr]keep merge=union\n', g: 'g\n' },
      [COMMIT.R]: { '.gitattributes': '[attr]keep merge=union\n', g: 'g\n' },
      [COMMIT.H]: { '.gitattributes': '[attr]keep merge=union\n', 'd/.gitattributes': 'x keep\n', g: 'g\n' },
    });
    assert.deepEqual(await project(w, [edit('g', 'G\n')]), { verdict: 'unfaithful', reasons: [], limits: [{ kind: 'attributes-changed', path: 'd/.gitattributes' }] });
  });

  test('regression: one that unsets merge with a value (`-merge=x`) could assign a driver, so it is a limit', async () => {
    const w = world({ [COMMIT.M]: { '.gitattributes': '*.png -diff\n', g: 'g\n' }, [COMMIT.R]: { '.gitattributes': '*.png -diff\n', g: 'g\n' }, [COMMIT.H]: { '.gitattributes': '*.png -diff\nx -merge=x\n', g: 'g\n' } });
    assert.deepEqual(await project(w, [edit('g', 'G\n')]), { verdict: 'unfaithful', reasons: [], limits: [{ kind: 'attributes-changed', path: '.gitattributes' }] });
  });

  test('a proposal that changes an attributes file to set a merge driver is a limit', async () => {
    const w = world({ [COMMIT.M]: { '.gitattributes': '*.png -diff\n' }, [COMMIT.R]: { '.gitattributes': '*.png -diff\n' }, [COMMIT.H]: { '.gitattributes': '*.png -diff\n', h: 'h\n' } });
    assert.deepEqual(await project(w, [edit('.gitattributes', '*.png -diff\n*.md merge=union\n')]), {
      verdict: 'unfaithful', reasons: [], limits: [{ kind: 'attributes-changed', path: '.gitattributes' }],
    });
  });
});

describe('limits: what the projection cannot decide, and says so', () => {
  test('a file that would have to be merged but is listed without its size is never read', async () => {
    const w = world({ [COMMIT.M]: { f: lines() }, [COMMIT.R]: { f: lines() }, [COMMIT.H]: { f: lines({ 1: 'line 1 H' }) } });
    const entry = w.trees.get(COMMIT.H)?.get('f');
    assert.ok(entry !== undefined);
    w.trees.get(COMMIT.H)?.set('f', { mode: entry.mode, oid: entry.oid });
    assert.deepEqual(await project(w, [edit('f', lines({ 20: 'prop' }))]), { verdict: 'unfaithful', reasons: [], limits: [{ kind: 'size-unknown', path: 'f' }] });
    assert.deepEqual(w.blobReads, []);
  });

  test('a truncated tree listing: nothing else is read, and the commit is named', async () => {
    const w = world({ [COMMIT.M]: { f: 'a\n' }, [COMMIT.R]: { f: 'b\n' }, [COMMIT.H]: { f: 'c\n' } });
    w.truncated = new Set([COMMIT.H]);
    assert.deepEqual(await project(w, [edit('f', 'd\n')]), { verdict: 'unfaithful', reasons: [], limits: [{ kind: 'truncated', commit: COMMIT.H }] });
    assert.deepEqual(w.blobReads, []);
  });

  test('no merge base: nothing is read', async () => {
    const w = world({ [COMMIT.R]: { f: 'b\n' }, [COMMIT.H]: { f: 'c\n' } });
    assert.deepEqual(await project(w, [edit('f', 'd\n')], null), { verdict: 'unfaithful', reasons: [], limits: [{ kind: 'no-merge-base' }] });
    assert.deepEqual(w.treeReads, []);
  });

  test('a binary file changed differently on both sides', async () => {
    const w = world({ [COMMIT.M]: { b: 'a\u0000\n1\n' }, [COMMIT.R]: { b: 'a\u0000\n1\n' }, [COMMIT.H]: { b: 'H\u0000\n1\n' } });
    assert.deepEqual(await project(w, [edit('b', 'a\u0000\n2\n')]), { verdict: 'unfaithful', reasons: [], limits: [{ kind: 'binary', path: 'b' }] });
  });

  test('a symbolic link and a submodule changed differently on both sides', async () => {
    const link = (target: string): Content => ({ mode: '120000', text: target });
    const w = world({
      [COMMIT.M]: { l: link('a'), s: gitlink('1'), f: 'f\n' },
      [COMMIT.R]: { l: link('b'), s: gitlink('2'), f: 'f\n' },
      [COMMIT.H]: { l: link('c'), s: gitlink('3'), f: 'f\n' },
    });
    assert.deepEqual(await project(w, [edit('f', 'g\n')]), {
      verdict: 'unfaithful', reasons: [], limits: [{ kind: 'symlink', path: 'l' }, { kind: 'submodule', path: 's' }],
    });
  });

  test('a file one side turned into a symbolic link while the other changed it', async () => {
    const w = world({ [COMMIT.M]: { f: 'a\n' }, [COMMIT.R]: { f: 'a\n' }, [COMMIT.H]: { f: { mode: '120000', text: 'elsewhere' } } });
    assert.deepEqual(await project(w, [edit('f', 'b\n')]), { verdict: 'unfaithful', reasons: [], limits: [{ kind: 'kind-change', path: 'f' }] });
  });

  test('a file that would have to be merged but is larger than the read limit is never read', async () => {
    const w = world({ [COMMIT.M]: { f: lines() }, [COMMIT.R]: { f: lines() }, [COMMIT.H]: { f: lines({ 1: 'x'.repeat(200) }) } });
    assert.deepEqual(await project(w, [edit('f', lines({ 20: 'prop' }))], COMMIT.M, 100), { verdict: 'unfaithful', reasons: [], limits: [{ kind: 'too-large', path: 'f' }] });
    assert.deepEqual(w.blobReads, []);
  });

  test('a file the head added under a directory the pull request removed: a directory-rename trigger too', async () => {
    const w = world({
      [COMMIT.M]: { 'd/x': 'x\n', f: 'f\n' },
      [COMMIT.R]: { 'e/x': 'x\n', f: 'f\n' },
      [COMMIT.H]: { 'd/x': 'x\n', 'd/new': 'new\n', f: 'f\n' },
    });
    const projected = await project(w, [edit('f', 'g\n')]);
    assert.equal(projected.verdict, 'unfaithful');
    assert.ok(projected.limits.some((l) => l.kind === 'directory-rename' && l.directory === 'd'), JSON.stringify(projected));
  });
});

describe('what the projection reads', () => {
  test('the trees of the merge base, the reviewed commit and the head, in that order, and only the blobs of files merged line by line', async () => {
    const w = world({
      [COMMIT.M]: { f: lines(), same: 'same\n' },
      [COMMIT.R]: { f: lines({ 5: 'line 5 R' }), same: 'same\n' },
      [COMMIT.H]: { f: lines({ 5: 'line 5 R', 18: 'line 18 base' }), same: 'same\n', added: 'h\n' },
    });
    assert.deepEqual(await project(w, [edit('f', lines({ 5: 'line 5 R', 10: 'line 10 prop' })), create('n', 'new\n')]), FAITHFUL);
    assert.deepEqual(w.treeReads, [COMMIT.M, COMMIT.R, COMMIT.H]);
    const blobOf = (commit: string, path: string): string | undefined => w.trees.get(commit)?.get(path)?.oid;
    assert.deepEqual(new Set(w.blobReads), new Set([blobOf(COMMIT.M, 'f'), blobOf(COMMIT.R, 'f'), blobOf(COMMIT.H, 'f')]),
      'f\'s blobs at M, R and H; never `same`, `added` or the proposal\'s own bytes');
  });

  test('a path neither side changed relative to the merge base and the reviewed commit is not examined', async () => {
    const w = world({ [COMMIT.M]: { a: 'a\n' }, [COMMIT.R]: { a: 'a\n' }, [COMMIT.H]: { a: 'changed at the head\n' } });
    assert.deepEqual(await project(w, [create('b', 'b\n')]), FAITHFUL);
    assert.deepEqual(w.blobReads, []);
  });

  test('a proposal that edits a path that is not a regular file at the reviewed commit is caller misuse', async () => {
    const w = world({ [COMMIT.M]: {}, [COMMIT.R]: {}, [COMMIT.H]: {} });
    await assert.rejects(project(w, [edit('missing', 'x\n')]), TypeError);
  });
});
