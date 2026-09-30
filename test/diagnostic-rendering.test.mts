/**
 * The human rendering of diagnostics (docs/diagnostics.md, "--format human"):
 * one block per diagnostic, a summary line, wrapping to the terminal's width,
 * and color decided by `--color`, `FORCE_COLOR`, `NO_COLOR` and the terminal.
 *
 * Expected text is written by hand from the documented layout. Colors are
 * checked as ECMA-48 SGR sequences: bold 1, dim 2 (both closed by 22), red
 * 31, green 32, yellow 33, blue 34, cyan 36 (closed by 39).
 *
 * @see https://ecma-international.org/publications-and-standards/standards/ecma-48/
 * @see https://no-color.org/
 * @see https://nodejs.org/api/cli.html#force_color1-2-3
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PLAIN_STYLE, loadColorStyle, renderDiagnostics, shouldUseColor } from '../dist/diagnostic-rendering.cjs';
import { createDiagnostic } from '../dist/diagnostics.cjs';
import type { IDiagnostic } from '../dist/diagnostics.cjs';

const ESC = '\u001b';
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

/** The texts wrapped in SGR `open`...`close` in `text`. */
function styled(text: string, open: number, close: number): string[] {
  const spans: string[] = [];
  const re = new RegExp(`\\u001b\\[${String(open)}m(.*?)\\u001b\\[${String(close)}m`, 'g');
  for (const match of text.matchAll(re)) spans.push(stripAnsi(match[1] ?? ''));
  return spans;
}

const SCHEMA_ERROR = createDiagnostic('sarif-schema-invalid', "`/runs/0/results/0` must have required property 'message'.", {
  location: { pointer: '/runs/0/results/0' },
});

describe('block layout (plain)', () => {
  test('the documented example: badge, title, code, location, message, remedy, summary', () => {
    assert.equal(
      renderDiagnostics([SCHEMA_ERROR], { style: PLAIN_STYLE }),
      [
        '✖ error  The document is not valid SARIF 2.1.0  [sarif-schema-invalid]',
        '  /runs/0/results/0',
        "  `/runs/0/results/0` must have required property 'message'.",
        '  → Correct the document so that it conforms to the SARIF 2.1.0 schema.',
        '',
        '1 error',
        '',
      ].join('\n'),
    );
  });

  test('no diagnostics render as nothing at all', () => {
    assert.equal(renderDiagnostics([], { style: PLAIN_STYLE }), '');
  });

  test('each severity has its badge; blocks are ordered errors, warnings, notes and separated by one blank line', () => {
    const note = createDiagnostic('suggestion-branch-moved', 'Moved.');
    const warning = createDiagnostic('taxa-uninterpreted', 'Kept.', { location: { pointer: '/runs/0/results/2' } });
    const text = renderDiagnostics([note, warning, SCHEMA_ERROR], { style: PLAIN_STYLE });
    const headers = text.split('\n').filter((line) => /^[✖▲ℹ] /.test(line));
    assert.deepEqual(headers, [
      '✖ error  The document is not valid SARIF 2.1.0  [sarif-schema-invalid]',
      '▲ warning  Taxonomy classifications are not shown  [taxa-uninterpreted]',
      'ℹ note  The branch changed since the suggestions were planned  [suggestion-branch-moved]',
    ]);
    assert.match(text, /\n\n▲ warning /);
    assert.match(text, /\n\nℹ note /);
    assert.ok(text.endsWith('\n\n1 error, 1 warning, 1 note\n'), text);
    assert.equal(text.includes('→'), true, 'the error has its remedy');
  });

  test('the summary counts each severity present, in the plural where needed', () => {
    const w = (n: string): IDiagnostic => createDiagnostic('tool-reported-errors', n);
    const e = (n: string): IDiagnostic => createDiagnostic('approval-hold', n);
    const last = (list: readonly IDiagnostic[]): string => renderDiagnostics(list, { style: PLAIN_STYLE }).trimEnd().split('\n').at(-1) ?? '';
    assert.equal(last([e('a'), w('b'), w('c')]), '1 error, 2 warnings');
    assert.equal(last([e('a'), e('b')]), '2 errors');
    assert.equal(last([w('a')]), '1 warning');
    assert.equal(last([createDiagnostic('suggestion-pr-not-conforming', 'x'), createDiagnostic('suggestion-branch-moved', 'y')]), '2 notes');
  });

  const locations: readonly (readonly [string, Parameters<typeof createDiagnostic>[2], string | null])[] = [
    ['a path with a line range, a pointer and a subject', { location: { path: 'src/a.ts', startLine: 3, endLine: 5, pointer: '/runs/0/results/1' }, subject: 'acme/widgets#42' }, '  src/a.ts:3-5 · /runs/0/results/1 · acme/widgets#42'],
    ['a path with one line', { location: { path: 'src/a.ts', startLine: 3, endLine: 3 } }, '  src/a.ts:3'],
    ['a path with a start line only', { location: { path: 'src/a.ts', startLine: 7 } }, '  src/a.ts:7'],
    ['a path alone', { location: { path: 'src/a.ts' } }, '  src/a.ts'],
    ['a subject alone', { subject: 'acme/widgets#40' }, '  acme/widgets#40'],
    ['the document root pointer', { location: { pointer: '' } }, null],
    ['nothing', {}, null],
  ];
  for (const [what, details, line] of locations) {
    test(`the location line for ${what}`, () => {
      const lines = renderDiagnostics([createDiagnostic('usage-error', 'Message.', details)], { style: PLAIN_STYLE }).split('\n');
      if (line === null) assert.equal(lines[1], '  Message.', 'no location line');
      else assert.equal(lines[1], line);
    });
  }
});

describe('wrapping to the terminal width', () => {
  const words = 'The quick brown fox jumps over the lazy dog and keeps running across the wide field until evening falls.';

  test('the message is wrapped at word boundaries within the width, indented, and loses no word', () => {
    const text = renderDiagnostics([createDiagnostic('operation-failed', words)], { style: PLAIN_STYLE, width: 40 });
    const message = text.split('\n').slice(1).filter((l) => l.startsWith('  ') && !l.startsWith('  →') && !l.startsWith('    '));
    assert.ok(message.length > 1, `wrapped: ${JSON.stringify(message)}`);
    for (const line of message) assert.ok(line.length <= 40, `${JSON.stringify(line)} fits 40 columns`);
    assert.equal(message.map((l) => l.trim()).join(' '), words);
  });

  test('a remedy is wrapped with a hanging indent under its arrow', () => {
    const d = createDiagnostic('operation-failed', 'Short.', { remedies: [words] });
    const lines = renderDiagnostics([d], { style: PLAIN_STYLE, width: 40 }).split('\n');
    const first = lines.findIndex((l) => l.startsWith('  → '));
    assert.ok(first !== -1);
    const continuation = lines.slice(first + 1).filter((l) => l.startsWith('    ') && l.trim() !== '');
    assert.ok(continuation.length > 0, 'the remedy continues on indented lines');
    for (const line of [lines[first] ?? '', ...continuation]) assert.ok(line.length <= 40, line);
    assert.equal([lines[first]?.slice(4), ...continuation.map((l) => l.trim())].join(' '), words);
  });

  test('a word longer than the width is kept whole', () => {
    const long = 'x'.repeat(60);
    const lines = renderDiagnostics([createDiagnostic('operation-failed', `before ${long} after`)], { style: PLAIN_STYLE, width: 30 }).split('\n');
    assert.ok(lines.includes(`  ${long}`), JSON.stringify(lines));
  });

  test('lines inside a fenced code block are never wrapped', () => {
    const code = `const answer = ${'1 + '.repeat(20)}1;`;
    const message = `Replace it:\n\n\`\`\`js\n${code}\n\`\`\`\n\nThen retry.`;
    const lines = renderDiagnostics([createDiagnostic('operation-failed', message)], { style: PLAIN_STYLE, width: 30 }).split('\n');
    assert.ok(lines.includes(`  ${code}`), 'the code line is whole');
    assert.ok(lines.includes('  ```js') && lines.includes('  ```'));
    assert.ok(lines.includes(''), 'the blank line between paragraphs is kept, without trailing spaces');
    for (const line of lines) assert.doesNotMatch(line, / $/, 'no trailing whitespace');
  });

  test('wide characters count two columns: CJK words wrap by display width', () => {
    // Each word is four CJK ideographs: 8 columns, although its UTF-16 length is 4.
    const lines = renderDiagnostics([createDiagnostic('operation-failed', '漢字漢字 漢字漢字 漢字漢字')], { style: PLAIN_STYLE, width: 12 }).split('\n');
    assert.deepEqual(lines.slice(1, 4), ['  漢字漢字', '  漢字漢字', '  漢字漢字']);
  });

  test('an emoji with a skin-tone modifier is one two-column grapheme, not four columns', () => {
    // "  👍🏽👍🏽 👍🏽👍🏽" is 2 + 4 + 1 + 4 = 11 columns; its UTF-16 length is 19.
    const lines = renderDiagnostics([createDiagnostic('operation-failed', '👍🏽👍🏽 👍🏽👍🏽')], { style: PLAIN_STYLE, width: 11 }).split('\n');
    assert.equal(lines[1], '  👍🏽👍🏽 👍🏽👍🏽');
    const narrower = renderDiagnostics([createDiagnostic('operation-failed', '👍🏽👍🏽 👍🏽👍🏽')], { style: PLAIN_STYLE, width: 10 }).split('\n');
    assert.deepEqual(narrower.slice(1, 3), ['  👍🏽👍🏽', '  👍🏽👍🏽']);
  });

  test('a combining mark adds no column', () => {
    // "e" + U+0301 is one column; ten of them make a 10-column word.
    const word = 'e\u0301'.repeat(10);
    const lines = renderDiagnostics([createDiagnostic('operation-failed', `${word} ${word}`)], { style: PLAIN_STYLE, width: 23 }).split('\n');
    assert.equal(lines[1], `  ${word} ${word}`);
  });

  test('without a width nothing is wrapped', () => {
    const long = `${words} ${words}`;
    const lines = renderDiagnostics([createDiagnostic('operation-failed', long)], { style: PLAIN_STYLE }).split('\n');
    assert.ok(lines.includes(`  ${long}`));
  });
});

describe('color', () => {
  const list = [
    createDiagnostic('approval-hold', 'Held.', { location: { pointer: '/runs/0' } }),
    createDiagnostic('taxa-uninterpreted', 'Kept.'),
    createDiagnostic('suggestion-branch-moved', 'Moved.'),
  ];

  test('plain output has no escape sequences', () => {
    assert.equal(renderDiagnostics(list, { style: PLAIN_STYLE }).includes(ESC), false);
  });

  test('colored output has the same layout once the escapes are removed', async () => {
    const style = await loadColorStyle();
    const colored = renderDiagnostics(list, { style, width: 60 });
    assert.ok(colored.includes(ESC));
    assert.equal(stripAnsi(colored), renderDiagnostics(list, { style: PLAIN_STYLE, width: 60 }));
  });

  test('badges are red, yellow and blue; titles bold; codes dim; locations cyan; arrows green', async () => {
    const colored = renderDiagnostics(list, { style: await loadColorStyle() });
    assert.ok(styled(colored, 31, 39).some((s) => s.includes('✖ error')), 'error badge red');
    assert.ok(styled(colored, 33, 39).some((s) => s.includes('▲ warning')), 'warning badge yellow');
    assert.ok(styled(colored, 34, 39).some((s) => s.includes('ℹ note')), 'note badge blue');
    assert.ok(styled(colored, 1, 22).some((s) => s.includes('The review is held for approval')), 'title bold');
    assert.ok(styled(colored, 2, 22).some((s) => s.includes('[approval-hold]')), 'code dim');
    assert.ok(styled(colored, 36, 39).some((s) => s.includes('/runs/0')), 'location cyan');
    assert.ok(styled(colored, 32, 39).some((s) => s.includes('→')), 'arrow green');
    assert.ok(styled(colored, 31, 39).some((s) => s.includes('1 error')), 'the summary count takes its color');
  });
});

describe('shouldUseColor: --color, FORCE_COLOR, NO_COLOR, then the terminal', () => {
  const cases: readonly (readonly [string, 'auto' | 'always' | 'never', Readonly<Record<string, string>>, boolean, boolean])[] = [
    ['auto on a terminal', 'auto', {}, true, true],
    ['auto off a terminal', 'auto', {}, false, false],
    ['auto on a dumb terminal', 'auto', { TERM: 'dumb' }, true, false],
    ['always off a terminal', 'always', {}, false, true],
    ['always despite NO_COLOR', 'always', { NO_COLOR: '1' }, false, true],
    ['always despite FORCE_COLOR=0', 'always', { FORCE_COLOR: '0' }, false, true],
    ['never on a terminal', 'never', {}, true, false],
    ['never despite FORCE_COLOR', 'never', { FORCE_COLOR: '1' }, true, false],
    ['NO_COLOR on a terminal', 'auto', { NO_COLOR: '1' }, true, false],
    ['an empty NO_COLOR is ignored', 'auto', { NO_COLOR: '' }, true, true],
    ['FORCE_COLOR off a terminal', 'auto', { FORCE_COLOR: '1' }, false, true],
    ['an empty FORCE_COLOR turns color on', 'auto', { FORCE_COLOR: '' }, false, true],
    ['FORCE_COLOR=3', 'auto', { FORCE_COLOR: '3' }, false, true],
    ['FORCE_COLOR=true', 'auto', { FORCE_COLOR: 'true' }, false, true],
    ['FORCE_COLOR=0 on a terminal', 'auto', { FORCE_COLOR: '0' }, true, false],
    ['FORCE_COLOR=false on a terminal', 'auto', { FORCE_COLOR: 'false' }, true, false],
    ['FORCE_COLOR over NO_COLOR, as in Node.js', 'auto', { FORCE_COLOR: '1', NO_COLOR: '1' }, false, true],
    ['FORCE_COLOR on a dumb terminal', 'auto', { FORCE_COLOR: '1', TERM: 'dumb' }, false, true],
  ];
  for (const [what, choice, env, isTTY, expected] of cases) {
    test(what, () => {
      assert.equal(shouldUseColor(choice, env, isTTY), expected);
    });
  }
});
