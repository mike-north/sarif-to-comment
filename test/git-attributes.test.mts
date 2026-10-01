/**
 * Unit tests for which merge driver `.gitattributes` files assign to a path
 * (src/git-attributes.cts; docs/companion-suggestion-pr-contract.md §2.5.1).
 *
 * Each expectation follows gitattributes(5) and the pattern rules it adopts
 * from gitignore(5), Git's attr.c for line syntax, precedence and macros, and
 * wildmatch.c for patterns; every case here agrees with `git check-attr` on
 * the same files with `core.ignorecase` off (as on GitHub's Linux hosts).
 *
 * @see https://git-scm.com/docs/gitattributes
 * @see https://git-scm.com/docs/gitignore#_pattern_format
 * @see https://github.com/git/git/blob/master/attr.c
 * @see https://github.com/git/git/blob/master/wildmatch.c
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { couldAssignMerge, mergeDriverOf, parseAttributes, patternMatches } from '../dist/git-attributes.cjs';
import type { MergeDriver } from '../dist/git-attributes.cjs';

/** The driver `files` (text by directory, '' for the root) assign to `path`. */
function driver(path: string, files: Readonly<Record<string, string>>): MergeDriver {
  return mergeDriverOf(path, new Map(Object.entries(files).map(([dir, text]) => [dir, parseAttributes(text)])));
}

const TEXT: MergeDriver = { kind: 'text' };
const other = (attribute: string): MergeDriver => ({ kind: 'other', attribute });

describe('patternMatches: gitignore pattern rules, relative to the attributes file', () => {
  test('a pattern without a slash matches the last segment at any depth below its directory', () => {
    assert.equal(patternMatches('*.md', '', 'README.md'), true);
    assert.equal(patternMatches('*.md', '', 'docs/guide/a.md'), true);
    assert.equal(patternMatches('*.md', 'docs', 'docs/a.md'), true);
    assert.equal(patternMatches('*.md', 'docs', 'other/a.md'), false);
    assert.equal(patternMatches('f', '', 'd/f'), true);
  });

  test('a leading slash anchors the pattern to its own directory', () => {
    assert.equal(patternMatches('/f', '', 'f'), true);
    assert.equal(patternMatches('/f', '', 'd/f'), false);
    assert.equal(patternMatches('/f', 'd', 'd/f'), true);
    assert.equal(patternMatches('/f', 'd', 'd/e/f'), false);
  });

  test('a slash in the middle anchors too, and `*` does not cross a slash', () => {
    assert.equal(patternMatches('d/f', '', 'd/f'), true);
    assert.equal(patternMatches('d/f', '', 'x/d/f'), false);
    assert.equal(patternMatches('d/*.md', '', 'd/a.md'), true);
    assert.equal(patternMatches('d/*.md', '', 'd/e/a.md'), false);
    assert.equal(patternMatches('d/?', '', 'd/a'), true);
    assert.equal(patternMatches('d?e', '', 'd/e'), false);
  });

  test('`**` matches across directories at the start, the end, or between slashes', () => {
    assert.equal(patternMatches('**/f', '', 'f'), true);
    assert.equal(patternMatches('**/f', '', 'a/b/f'), true);
    assert.equal(patternMatches('docs/**', '', 'docs/a'), true);
    assert.equal(patternMatches('docs/**', '', 'docs/x/y'), true);
    assert.equal(patternMatches('docs/**', '', 'other/docs/a'), false);
    assert.equal(patternMatches('a/**/b', '', 'a/b'), true);
    assert.equal(patternMatches('a/**/b', '', 'a/x/y/b'), true);
    assert.equal(patternMatches('a/**/b', '', 'a/x/c'), false);
  });

  test('a pattern ending in a slash matches a directory, so never a file or what is inside it', () => {
    assert.equal(patternMatches('d/', '', 'd/x'), false);
    assert.equal(patternMatches('d/', '', 'd'), false);
  });

  test('character classes, negated classes and escapes', () => {
    assert.equal(patternMatches('[ab].txt', '', 'a.txt'), true);
    assert.equal(patternMatches('[!ab].txt', '', 'a.txt'), false);
    assert.equal(patternMatches('[!ab].txt', '', 'c.txt'), true);
    assert.equal(patternMatches('\\*.txt', '', '*.txt'), true);
    assert.equal(patternMatches('\\*.txt', '', 'a.txt'), false);
    assert.equal(patternMatches('d[!x]e', '', 'd/e'), false);
  });
});

describe('mergeDriverOf: the merge driver in effect', () => {
  test('no attributes, `merge` set, `merge=text` and `!merge` leave the text merge', () => {
    assert.deepEqual(driver('f', {}), TEXT);
    assert.deepEqual(driver('f', { '': 'f merge\n' }), TEXT);
    assert.deepEqual(driver('f', { '': 'f merge=text\n' }), TEXT);
    assert.deepEqual(driver('f', { '': '* merge=union\nf !merge\n' }), TEXT);
  });

  test('`merge=union`, a custom driver and `-merge` are other drivers, named as written', () => {
    assert.deepEqual(driver('f', { '': 'f merge=union\n' }), other('merge=union'));
    assert.deepEqual(driver('f', { '': '*.txt merge=ours\n' }), TEXT);
    assert.deepEqual(driver('a.txt', { '': '*.txt merge=ours\n' }), other('merge=ours'));
    assert.deepEqual(driver('f', { '': 'f -merge\n' }), other('-merge'));
  });

  test('a later line overrides an earlier one, and a later attribute on a line an earlier one', () => {
    assert.deepEqual(driver('f', { '': '* merge=union\nf merge=text\n' }), TEXT);
    assert.deepEqual(driver('f', { '': 'f merge=text\n* merge=union\n' }), other('merge=union'));
    assert.deepEqual(driver('f', { '': 'f merge=union merge=text\n' }), TEXT);
  });

  test('a deeper attributes file overrides one nearer the root, both ways', () => {
    const files = { '': '* merge=union\n', d: '* merge=text\n' };
    assert.deepEqual(driver('d/f', files), TEXT);
    assert.deepEqual(driver('f', files), other('merge=union'));
    assert.deepEqual(driver('d/e/f', { '': '* merge=text\n', 'd/e': 'f merge=union\n' }), other('merge=union'));
  });

  test('the built-in `binary` macro unsets merge; unsetting the macro contributes nothing', () => {
    assert.deepEqual(driver('f', { '': 'f binary\n' }), other('binary'));
    assert.deepEqual(driver('f', { '': 'f -binary\n' }), TEXT);
    assert.deepEqual(driver('f', { '': 'f binary\nf -binary\n' }), TEXT);
    // A merge attribute after the macro on the same line wins, and one before it loses.
    assert.deepEqual(driver('f', { '': 'f binary merge=text\n' }), TEXT);
    assert.deepEqual(driver('f', { '': 'f merge=text binary\n' }), other('binary'));
  });

  test('macros the root file defines apply everywhere; definitions elsewhere are ignored', () => {
    assert.deepEqual(driver('d/f', { '': '[attr]mine merge=union\n', d: 'f mine\n' }), other('mine'));
    assert.deepEqual(driver('d/f', { d: '[attr]mine merge=union\nf mine\n' }), TEXT);
    assert.deepEqual(driver('f', { '': '[attr]binary -diff\nf binary\n' }), TEXT);
  });

  test('negative patterns are ignored; `\\!` is a literal leading `!`', () => {
    assert.deepEqual(driver('f', { '': '!f merge=union\n' }), TEXT);
    assert.deepEqual(driver('!x', { '': '\\!x merge=union\n' }), other('merge=union'));
  });

  test('a C-style quoted pattern is unquoted before it is matched', () => {
    assert.deepEqual(driver('a b', { '': '"a b" merge=union\n' }), other('merge=union'));
    assert.deepEqual(driver('f', { '': '"\\146" merge=union\n' }), other('merge=union'));
    assert.deepEqual(driver('a', { '': '"a b" merge=union\n' }), TEXT);
  });

  test('comments, blank lines, indentation and CRLF line endings', () => {
    assert.deepEqual(driver('f', { '': '# f merge=union\n\n   f merge=union\r\n' }), other('merge=union'));
  });

  test('a pattern in an attributes file off the path\'s way does not apply', () => {
    assert.deepEqual(driver('f', { other: '* merge=union\n' }), TEXT);
  });
});

describe('lines Git discards are discarded (attr.c parse_attr_line)', () => {
  test('regression: a `#` after attributes is an attribute name, which is invalid, so the whole line is discarded', () => {
    assert.deepEqual(driver('h', { '': '* merge=union\nh merge=text # c\n' }), other('merge=union'));
  });

  test('regression: any invalid attribute name discards the whole line', () => {
    assert.deepEqual(driver('f', { '': '* merge=union\nf merge=text bad@name\n' }), other('merge=union'));
    // Names may not start with `-`, and the `builtin_` prefix is reserved.
    assert.deepEqual(driver('f', { '': '* merge=union\nf merge=text --x\n' }), other('merge=union'));
    assert.deepEqual(driver('f', { '': '* merge=union\nf merge=text builtin_x\n' }), other('merge=union'));
    assert.deepEqual(driver('f', { '': '* merge=union\nf merge=text =x\n' }), other('merge=union'));
    // Names use letters, digits, `_`, `.` and `-`.
    assert.deepEqual(driver('f', { '': '* merge=union\nf merge=text a.b_c-D9\n' }), TEXT);
  });

  test('regression: a line of 2,048 bytes or more is ignored; one byte shorter is read', () => {
    const line = (bytes: number): string => `*${' '.repeat(bytes - '*merge=text'.length)}merge=text`;
    assert.equal(line(2048).length, 2048);
    assert.deepEqual(driver('f', { '': `* merge=union\n${line(2048)}\n` }), other('merge=union'));
    assert.deepEqual(driver('f', { '': `* merge=union\n${line(2047)}\n` }), TEXT);
    // The length is counted in bytes, not characters.
    const wide = `* merge=union\nf${' '.repeat(2030)}merge=text x=${'é'.repeat(8)}\n`;
    assert.deepEqual(driver('f', { '': wide }), other('merge=union'));
  });

  test('a NUL byte ends the file, as Git reads it', () => {
    assert.deepEqual(driver('f', { '': '* merge=union\n\u0000f merge=text\n' }), other('merge=union'));
  });

  test('a `[attr]` line outside the root file is discarded, not read as a pattern', () => {
    assert.deepEqual(driver('d/[attr]u', { d: '[attr]u merge=union\n' }), TEXT);
  });

  test('an invalid macro name discards the definition', () => {
    assert.deepEqual(driver('a', { '': '[attr]bad@u merge=union\na bad@u\n' }), TEXT);
  });
});

describe('attribute and macro syntax (attr.c parse_attr)', () => {
  test('regression: `-name=value` unsets and `!name=value` unspecifies; the value is ignored', () => {
    assert.deepEqual(driver('f', { '': 'f -merge=x\n' }), other('-merge=x'));
    assert.deepEqual(driver('g', { '': '* merge=union\ng !merge=x\n' }), TEXT);
  });

  test('regression: a quoted `[attr]` definition is a macro', () => {
    assert.deepEqual(driver('a', { '': '"[attr]u" merge=union\na u\n' }), other('u'));
    assert.deepEqual(driver('a', { '': '"[attr] u" merge=union\na u\n' }), other('u'));
  });

  test('`[attr]` alone is a pattern, not a macro: a class of the letters a, t and r', () => {
    assert.deepEqual(driver('t', { '': '"[attr]" merge=union\n' }), other('merge=union'));
    assert.deepEqual(driver('[attr]', { '': '"[attr]" merge=union\n' }), TEXT);
  });
});

describe('bracket expressions as wildmatch reads them', () => {
  test('regression: a `]` first in a class is a member', () => {
    assert.deepEqual(driver(']', { '': '[]x] merge=union\n' }), other('merge=union'));
    assert.deepEqual(driver('x', { '': '[]x] merge=union\n' }), other('merge=union'));
    assert.deepEqual(driver('y', { '': '[]x] merge=union\n' }), TEXT);
    assert.equal(patternMatches('[!]x]', '', ']'), false);
    assert.equal(patternMatches('[!]x]', '', 'y'), true);
  });

  test('ranges, escapes and POSIX classes inside a class', () => {
    assert.equal(patternMatches('[a-c]q', '', 'bq'), true);
    assert.equal(patternMatches('[a-c]q', '', 'dq'), false);
    assert.equal(patternMatches('[a-]', '', '-'), true);
    assert.equal(patternMatches('[\\]]', '', ']'), true);
    assert.equal(patternMatches('[[:digit:]x]', '', '7'), true);
    assert.equal(patternMatches('[[:digit:]x]', '', 'x'), true);
    assert.equal(patternMatches('[[:digit:]x]', '', 'y'), false);
    assert.equal(patternMatches('[[:upper:]]', '', 'A'), true);
    assert.equal(patternMatches('[[:upper:]]', '', 'a'), false);
    assert.equal(patternMatches('[^/]', '', 'a'), true);
  });

  test('a pattern Git cannot complete matches nothing: an unclosed class, an unknown POSIX class, a trailing backslash', () => {
    assert.equal(patternMatches('[ab', '', '[ab'), false);
    assert.equal(patternMatches('[[:nope:]]', '', 'a'), false);
    assert.equal(patternMatches('a\\', '', 'a\\'), false);
  });

  test('a class matches one byte, as wildmatch does, never a slash', () => {
    assert.equal(patternMatches('d[!x]e', '', 'd/e'), false);
    assert.equal(patternMatches('?', '', 'é'), false, 'é is two bytes');
    assert.equal(patternMatches('??', '', 'é'), true);
  });
});

describe('couldAssignMerge: whether a version of a changed attributes file matters', () => {
  test('a file that sets no merge attribute and no macro touching merge cannot', () => {
    assert.equal(couldAssignMerge(parseAttributes('*.png -diff\n*.sh text eol=lf\n'), []), false);
    // A line Git discards assigns nothing.
    assert.equal(couldAssignMerge(parseAttributes('f merge=union bad@name\n'), []), false);
  });

  test('a merge attribute in any state, the built-in macro, or a macro that sets merge can', () => {
    assert.equal(couldAssignMerge(parseAttributes('f merge=text\n'), []), true);
    assert.equal(couldAssignMerge(parseAttributes('f -merge=x\n'), []), true);
    assert.equal(couldAssignMerge(parseAttributes('"[attr]u" merge=union\n'), []), true);
    assert.equal(couldAssignMerge(parseAttributes('f !merge\n'), []), true);
    assert.equal(couldAssignMerge(parseAttributes('*.png binary\n'), []), true);
    assert.equal(couldAssignMerge(parseAttributes('f mine\n'), [parseAttributes('[attr]mine merge=union\n').macros]), true);
    assert.equal(couldAssignMerge(parseAttributes('[attr]mine merge=union\n'), []), true);
  });
});
