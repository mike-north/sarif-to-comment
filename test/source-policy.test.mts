/**
 * Repository policy for owned sources: every ESLint suppression states why.
 *
 * A disable directive without a reason hides a finding with no record of the
 * judgement behind it, and the next reader cannot tell whether it is still
 * justified. ESLint accepts a description after ` -- ` in any directive
 * comment; this test requires one on every `eslint-disable`,
 * `eslint-disable-line` and `eslint-disable-next-line` in the JavaScript and
 * TypeScript this repository owns. (Directives that no longer suppress
 * anything are reported by ESLint itself: reportUnusedDisableDirectives.)
 *
 * @see https://eslint.org/docs/latest/use/configure/rules#comment-descriptions
 * @see https://eslint.org/docs/latest/use/configure/rules#disabling-rules
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Owned source locations; generated output (dist/) and third-party code are not owned. */
const OWNED_DIRS: readonly string[] = ['src', 'scripts', 'test', 'types'];
const SOURCE_FILE = /\.([cm]?js|[cm]?ts)$/;

/** Project-relative paths of every owned JavaScript or TypeScript file. */
function ownedSources(): string[] {
  const files = fs.readdirSync(ROOT).filter((f) => SOURCE_FILE.test(f) && fs.statSync(path.join(ROOT, f)).isFile());
  for (const dir of OWNED_DIRS) {
    if (!fs.existsSync(path.join(ROOT, dir))) continue;
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })) {
      if (SOURCE_FILE.test(entry)) files.push(path.join(dir, entry));
    }
  }
  return files.sort();
}

// Built from fragments so this file's own source holds no directive text.
const KEYWORD = ['eslint', 'disable'].join('-');
const DIRECTIVE = new RegExp(`(?:\\/\\/|\\/\\*)\\s*(${KEYWORD}(?:-next-line|-line)?)(?![\\w-])([^\\n]*)`, 'g');

/** Directives in `text` that carry no ` -- reason`, as "line: comment". */
function unexplainedDirectives(text: string): string[] {
  const problems: string[] = [];
  for (const match of text.matchAll(DIRECTIVE)) {
    const rest = (match[2] ?? '').replace(/\*\/.*$/, '');
    const reason = /\s--\s+(\S.*)$/.exec(rest);
    if (!reason) {
      const line = text.slice(0, match.index).split('\n').length;
      problems.push(`${String(line)}: ${match[0].trim()}`);
    }
  }
  return problems;
}

describe('ESLint suppressions carry a reason', () => {
  test('control: a bare directive is reported and an explained one is accepted', () => {
    const bare = `const a = [1, , 3]; // ${KEYWORD}-line no-sparse-arrays\n`;
    const explained = `const a = [1, , 3]; // ${KEYWORD}-line no-sparse-arrays -- the hole is the input under test\n`;
    const block = `/* ${KEYWORD} no-var */\n/* ${KEYWORD}-next-line eqeqeq -- loose equality is the documented intent */\n`;
    assert.deepEqual(unexplainedDirectives(bare), [`1: // ${KEYWORD}-line no-sparse-arrays`]);
    assert.deepEqual(unexplainedDirectives(explained), []);
    assert.deepEqual(unexplainedDirectives(block), [`1: /* ${KEYWORD} no-var */`]);
  });

  test('every directive in owned sources explains itself', () => {
    const files = ownedSources();
    assert.ok(files.some((f) => f.startsWith('src/')), 'the scan covers the runtime sources');
    assert.ok(files.some((f) => f.startsWith('test/')), 'the scan covers the tests');
    assert.ok(files.some((f) => /^scripts\/.*\.mts$/.test(f)), 'the scan covers TypeScript tooling');
    const problems = files.flatMap((file) =>
      unexplainedDirectives(fs.readFileSync(path.join(ROOT, file), 'utf8')).map((p) => `${file}:${p}`),
    );
    assert.deepEqual(problems, []);
  });
});
