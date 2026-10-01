/**
 * Unit tests for the line-based three-way merge (src/three-way-merge.cts),
 * which the companion fidelity projection uses for text files both sides
 * changed (docs/companion-suggestion-pr-contract.md §2.5.1).
 *
 * The specification is Git's own content merge: merge-ort's ll_merge over
 * xdiff's `xdl_merge` with histogram diffs, at level ZEALOUS. Every expected
 * value below is Git's answer, recorded from Git 2.54.0 (the version the
 * projection follows): `git merge-file -p --diff-algorithm=histogram OURS
 * BASE THEIRS` for the clean result and the conflict count (its exit
 * status), and the same with `--ours` for the text a conflicting merge keeps
 * on the head's side. None was produced by this module.
 *
 * - The rules xdiff's merge documents: changes that overlap or touch
 *   conflict, identical changes do not, a line ending is part of its line.
 * - Cases where a longest-common-subsequence diff3 (for example node-diff3)
 *   answers differently from Git, which is why the module ports xdiff.
 * - The text files of the rewritten-history scenarios the projection was
 *   assessed on (E1, E1b, a single-base E8, S1–S6): each scenario's merge
 *   over the merge base, its target over the reviewed commit, and its probe
 *   (the reviewed commit merged over the merge base), recorded from the
 *   scenario repositories with `git merge-file`.
 * - When this machine's Git is new enough to agree on a canary case, a
 *   seeded differential run against the live `git merge-file`.
 *
 * @see https://github.com/git/git/blob/master/xdiff/xmerge.c
 * @see https://github.com/git/git/blob/master/xdiff/xhistogram.c
 * @see https://github.com/git/git/blob/master/xdiff/xdiffi.c
 * @see https://git-scm.com/docs/git-merge-file
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { diffHunks, isBinaryContent, mergeText, splitLines } from '../dist/three-way-merge.cjs';

/** Merges three byte strings and answers the conflict count and the text as a string. */
function merge(base: string, ours: string, theirs: string): { readonly conflicts: number; readonly text: string } {
  const result = mergeText(Buffer.from(base, 'latin1'), Buffer.from(ours, 'latin1'), Buffer.from(theirs, 'latin1'));
  return { conflicts: result.conflicts, text: result.text.toString('latin1') };
}

/** Git's answer for one case: clean with its result, or conflicting with the head's side of each conflict kept (`--ours`). */
type GitAnswer = { readonly clean: string } | { readonly conflicting: string };

function assertGit(base: string, ours: string, theirs: string, git: GitAnswer): void {
  const result = merge(base, ours, theirs);
  if ('clean' in git) {
    assert.equal(result.conflicts, 0, 'Git merges it cleanly');
    assert.equal(result.text, git.clean);
  } else {
    assert.ok(result.conflicts > 0, 'Git reports a conflict');
    assert.equal(result.text, git.conflicting);
  }
}

describe('the merge rules xdiff documents', () => {
  const cases: readonly (readonly [string, string, string, string, GitAnswer])[] = [
    ['changes that touch (one ends where the other starts) conflict', 'a\nb\nc\nd\n', 'a\nB\nc\nd\n', 'a\nb\nC\nd\n', { conflicting: 'a\nB\nc\nd\n' }],
    ['changes one unchanged line apart merge', 'a\nb\nc\nd\ne\n', 'a\nB\nc\nd\ne\n', 'a\nb\nc\nD\ne\n', { clean: 'a\nB\nc\nD\ne\n' }],
    ['identical changes merge', 'a\nb\nc\n', 'a\nX\nc\n', 'a\nX\nc\n', { clean: 'a\nX\nc\n' }],
    ['different insertions at one point conflict', 'a\nb\n', 'a\nX\nb\n', 'a\nY\nb\n', { conflicting: 'a\nX\nb\n' }],
    ['identical insertions at one point merge', 'a\nb\n', 'a\nX\nb\n', 'a\nX\nb\n', { clean: 'a\nX\nb\n' }],
    ['a final newline is part of its line', 'a\nb\n', 'a\nb', 'a\nb\nc\n', { conflicting: 'a\nb' }],
    ['an empty base: different additions conflict', '', 'x\n', 'y\n', { conflicting: 'x\n' }],
  ];
  for (const [name, base, ours, theirs, git] of cases) {
    test(name, () => {
      assertGit(base, ours, theirs, git);
    });
  }

  test('a side equal to the base takes the other side, byte for byte', () => {
    assert.deepEqual(merge('a\r\nb', 'a\r\nb', 'x\r\n'), { conflicts: 0, text: 'x\r\n' });
    assert.deepEqual(merge('a\n', 'z\n', 'a\n'), { conflicts: 0, text: 'z\n' });
  });

  test('bytes that are not UTF-8 round-trip exactly', () => {
    const base = Buffer.from([0x61, 0x0a, 0xff, 0x0a, 0x62, 0x0a]);
    const ours = Buffer.from([0x41, 0x0a, 0xff, 0x0a, 0x62, 0x0a]);
    const theirs = Buffer.from([0x61, 0x0a, 0xff, 0x0a, 0x42, 0x0a]);
    const result = mergeText(base, ours, theirs);
    assert.equal(result.conflicts, 0);
    assert.deepEqual([...result.text], [0x41, 0x0a, 0xff, 0x0a, 0x42, 0x0a]);
  });
});

describe('cases where a longest-common-subsequence diff3 disagrees with Git', () => {
  // Found by fuzzing node-diff3 against `git merge-file`; Git's answers recorded.
  const cases: readonly (readonly [string, string, string, string, GitAnswer])[] = [
    ['LCS merges it cleanly; Git conflicts', 'e\ne\na\nd\n', 'e\nc\ne\na\nd\n', 'e\nc\ne\ne\nd\n', { conflicting: 'e\nc\ne\nd\n' }],
    ['LCS conflicts; Git merges it cleanly', 'e\nb\ne\ne\ne\ne\n', 'e\nb\ne\ne\ne\nd\ne\n', 'a\ne\nb\nc\ne\nd\ne\ne\n', { clean: 'a\ne\nb\nc\ne\nd\ne\nd\ne\n' }],
    ['repeated lines placed differently', 'c\nb\ne\ne\ne\nd\n', 'c\nb\ne\nb\ne\nd\n', 'c\nb\ne\ne\nd\na\n', { conflicting: 'c\nb\ne\nb\ne\nd\na\n' }],
    ['a deletion beside a repeated line', 'c\nc\nb\nb\n', 'd\nb\n', 'c\nc\nb\n', { conflicting: 'd\nb\n' }],
    ['LCS conflicts; Git merges it cleanly (2)', 'e\na\nb\nc\ne\n', 'e\na\nb\ne\ne\n', 'e\na\nb\nc\ne\ne\na\n', { clean: 'e\na\nb\ne\ne\ne\na\n' }],
    ['a group compaction moved is diffed again (Git re-diffs shifted histogram groups)', 'c\nb\nc\nb\nb\nc\nd\ne\n', 'e\nc\nb\nc\nb\nb\nb\nc\ne\n', 'c\nb\nb\nc\nb\nc\nd\ne\n', { clean: 'e\nc\nb\nb\nc\nb\nb\nc\ne\n' }],
  ];
  for (const [name, base, ours, theirs, git] of cases) {
    test(name, () => {
      assertGit(base, ours, theirs, git);
    });
  }
});

/** The 20-line file of the S scenarios (`seq 1 20 | sed 's/^/line /'`), with some lines replaced. */
function lines(replaced: Readonly<Record<number, string>> = {}): string {
  return Array.from({ length: 20 }, (_, i) => `${replaced[i + 1] ?? `line ${String(i + 1)}`}\n`).join('');
}

describe('the text files of the assessed rewritten-history scenarios', () => {
  // Each scenario's merge (base M, ours H, theirs P), target (base R) and
  // probe (base M, theirs R), as `git merge-file` answered them.
  const scenarios: readonly (readonly [string, string, string, string, GitAnswer])[] = [
    ['E1 merge: the proposal edits the line the pull request changed', 'a\nx\ny\n', 'b\nx\ny\n', 'c\nx\ny\n', { conflicting: 'b\nx\ny\n' }],
    ['E1 target', 'b\nx\ny\n', 'b\nx\ny\n', 'c\nx\ny\n', { clean: 'c\nx\ny\n' }],
    ['E1b merge: the proposal edits a line far from the pull request\'s change', 'a\n1\n2\n3\n4\ny\n', 'b\n1\n2\n3\n4\ny\n', 'b\n1\n2\n3\n4\nz\n', { clean: 'b\n1\n2\n3\n4\nz\n' }],
    ['E8 (one merge base) merge: both sides append, differently', 'L1\nl2\nL3\n', 'L1\nl2\nL3\nr\n', 'L1\nl2\nL3\nr\nprop\n', { conflicting: 'L1\nl2\nL3\nr\n' }],
    ['S1 merge: an amend that also changed another file', lines(), lines({ 5: 'line 5 R' }), lines({ 5: 'line 5 R', 15: 'line 15 prop' }), { clean: lines({ 5: 'line 5 R', 15: 'line 15 prop' }) }],
    ['S2 merge: a rebase onto a moved base', lines(), lines({ 5: 'line 5 R', 18: 'line 18 base' }), lines({ 5: 'line 5 R', 10: 'line 10 prop' }),
      { clean: lines({ 5: 'line 5 R', 10: 'line 10 prop', 18: 'line 18 base' }) }],
    ['S2 target', lines({ 5: 'line 5 R' }), lines({ 5: 'line 5 R', 18: 'line 18 base' }), lines({ 5: 'line 5 R', 10: 'line 10 prop' }),
      { clean: lines({ 5: 'line 5 R', 10: 'line 10 prop', 18: 'line 18 base' }) }],
    ['S3 merge: a dropped commit comes back', lines({ 5: 'line 5 C1' }), lines({ 5: 'line 5 C1' }), lines({ 5: 'line 5 C1', 6: 'line 6 C2', 10: 'line 10 prop' }),
      { clean: lines({ 5: 'line 5 C1', 6: 'line 6 C2', 10: 'line 10 prop' }) }],
    ['S3 target', lines({ 5: 'line 5 C1', 6: 'line 6 C2' }), lines({ 5: 'line 5 C1' }), lines({ 5: 'line 5 C1', 6: 'line 6 C2', 10: 'line 10 prop' }),
      { clean: lines({ 5: 'line 5 C1', 10: 'line 10 prop' }) }],
    ['S4 merge: adjacent to a pull request change the amend changed again', lines(), lines({ 5: 'line 5 amended' }), lines({ 5: 'line 5 R', 6: 'line 6 prop' }),
      { conflicting: lines({ 5: 'line 5 amended' }) }],
    ['S4 target: the adjacency conflicts over the reviewed commit too', lines({ 5: 'line 5 R' }), lines({ 5: 'line 5 amended' }), lines({ 5: 'line 5 R', 6: 'line 6 prop' }),
      { conflicting: lines({ 5: 'line 5 amended' }) }],
    ['S4b merge: adjacent to a pull request change kept identical', lines(), lines({ 5: 'line 5 R' }), lines({ 5: 'line 5 R', 6: 'line 6 prop' }),
      { conflicting: lines({ 5: 'line 5 R' }) }],
    ['S4b target: over the reviewed commit the change applies', lines({ 5: 'line 5 R' }), lines({ 5: 'line 5 R' }), lines({ 5: 'line 5 R', 6: 'line 6 prop' }),
      { clean: lines({ 5: 'line 5 R', 6: 'line 6 prop' }) }],
    ['S5 merge: the pull request\'s own change amended at the head', lines(), lines({ 5: 'line 5 amended' }), lines({ 5: 'line 5 R' }), { conflicting: lines({ 5: 'line 5 amended' }) }],
    ['S6 merge: a dropped commit two lines away comes back', lines({ 5: 'line 5 C1' }), lines({ 5: 'line 5 C1' }), lines({ 5: 'line 5 C1', 6: 'line 6 C2', 8: 'line 8 prop' }),
      { clean: lines({ 5: 'line 5 C1', 6: 'line 6 C2', 8: 'line 8 prop' }) }],
    ['S6 target', lines({ 5: 'line 5 C1', 6: 'line 6 C2' }), lines({ 5: 'line 5 C1' }), lines({ 5: 'line 5 C1', 6: 'line 6 C2', 8: 'line 8 prop' }),
      { clean: lines({ 5: 'line 5 C1', 8: 'line 8 prop' }) }],
  ];
  for (const [name, base, ours, theirs, git] of scenarios) {
    test(name, () => {
      assertGit(base, ours, theirs, git);
    });
  }
});

describe('splitLines and isBinaryContent', () => {
  test('lines keep their terminators; a last line may have none', () => {
    assert.deepEqual(splitLines('a\nb\r\nc'), ['a\n', 'b\r\n', 'c']);
    assert.deepEqual(splitLines(''), []);
    assert.deepEqual(splitLines('\n\n'), ['\n', '\n']);
  });

  test("Git's binary test: a NUL byte within the first 8000 bytes, and only there", () => {
    assert.equal(isBinaryContent(Buffer.from('text\n')), false);
    assert.equal(isBinaryContent(Buffer.from([0x61, 0x00, 0x62])), true);
    const late = Buffer.alloc(8001, 0x61);
    late[8000] = 0;
    assert.equal(isBinaryContent(late), false, 'byte 8001 is not inspected');
    late[7999] = 0;
    assert.equal(isBinaryContent(late), true);
    assert.equal(isBinaryContent(Buffer.from([0xff, 0xfe])), false, 'invalid UTF-8 is not binary');
  });
});

describe('diffHunks: unified hunks of a proposal\'s own changes', () => {
  test('changes within twice the context share a hunk, numbered as Git numbers them', () => {
    const before = Array.from({ length: 20 }, (_, i) => `Line ${String(i + 1)}.\n`).join('');
    const after = before.replace('Line 6.\n', 'Line 6, suggested.\n').replace('Line 10.\n', 'Line 10, suggested.\n');
    const [hunk, ...more] = diffHunks(before, after);
    assert.ok(hunk && more.length === 0, 'one hunk: the changes are 3 lines apart');
    assert.deepEqual({ ...hunk, lines: hunk.lines.map((l) => l.text) }, {
      oldStart: 3, oldLines: 11, newStart: 3, newLines: 11,
      lines: ['Line 3.', 'Line 4.', 'Line 5.', '-Line 6.', '+Line 6, suggested.', 'Line 7.', 'Line 8.', 'Line 9.', '-Line 10.', '+Line 10, suggested.', 'Line 11.', 'Line 12.', 'Line 13.']
        .map((l) => (l.startsWith('-') || l.startsWith('+') ? l : ` ${l}`)),
    });
  });

  test('changes farther apart get their own hunks; a missing final newline is marked', () => {
    const before = Array.from({ length: 20 }, (_, i) => `${String(i + 1)}\n`).join('');
    const after = before.replace('2\n', 'two\n').replace(/20\n$/, '20');
    const hunks = diffHunks(before, after);
    assert.deepEqual(hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines]), [[1, 5, 1, 5], [17, 4, 17, 4]]);
    const last = hunks[1]?.lines.at(-1);
    assert.deepEqual(last, { text: '+20', noNewline: true });
  });

  test('a pure insertion names the line before it; identical texts have no hunk', () => {
    assert.deepEqual(diffHunks('a\n', 'a\n'), []);
    const [hunk] = diffHunks('', 'x\n');
    assert.deepEqual(hunk && [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines], [0, 0, 1, 1]);
  });
});

/** Whether this machine's `git merge-file` supports histogram and re-diffs shifted groups as Git 2.54 does. */
function gitAgreesOnCanary(dir: string): boolean {
  const write = (name: string, text: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  };
  const result = spawnSync('git', ['merge-file', '-p', '--diff-algorithm=histogram',
    write('a', 'e\nc\nb\nc\nb\nb\nb\nc\ne\n'), write('o', 'c\nb\nc\nb\nb\nc\nd\ne\n'), write('b', 'c\nb\nb\nc\nb\nc\nd\ne\n')],
  { encoding: 'latin1', env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } });
  return result.status === 0 && result.stdout === 'e\nc\nb\nb\nc\nb\nb\nc\ne\n';
}

describe('a seeded differential run against the live `git merge-file`', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-way-merge-'));
  const available = gitAgreesOnCanary(dir);

  test('300 random merges agree with Git on conflicts, clean results and --ours text', { skip: available ? false : 'git merge-file here does not follow the Git version the projection follows' }, () => {
    let seed = 20261001;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = ['a', 'b', 'c', '', '}', '  x'];
    const pick = (): string => alphabet[Math.floor(random() * alphabet.length)] ?? 'a';
    const mutate = (base: readonly string[]): string[] => {
      const out = [...base];
      for (let k = 1 + Math.floor(random() * 4); k > 0; k--) {
        const at = Math.floor(random() * (out.length + 1));
        const op = random();
        if (op < 0.33) out.splice(at, 0, pick());
        else if (op < 0.66) out.splice(at, 1);
        else out[at] = pick();
      }
      return out;
    };
    const text = (ls: readonly string[]): string => ls.map((l) => `${l}\n`).join('');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
    for (let n = 0; n < 300; n++) {
      const base = Array.from({ length: 2 + Math.floor(random() * 14) }, pick);
      const [o, a, b] = [text(base), text(mutate(base)), text(mutate(base))];
      const files = (['a', 'o', 'b'] as const).map((name, i) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, [a, o, b][i] ?? '');
        return file;
      });
      const git = spawnSync('git', ['merge-file', '-p', '--diff-algorithm=histogram', ...files], { encoding: 'latin1', env });
      const ours = spawnSync('git', ['merge-file', '-p', '--ours', '--diff-algorithm=histogram', ...files], { encoding: 'latin1', env });
      const mine = merge(o, a, b);
      const label = JSON.stringify({ o, a, b });
      assert.equal(mine.conflicts > 0, git.status !== 0, `conflict decision: ${label}`);
      assert.equal(mine.text, git.status === 0 ? git.stdout : ours.stdout, `merged text: ${label}`);
    }
  });
});
