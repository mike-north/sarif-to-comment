/**
 * The conservative reading of Markdown structure (src/presentation/markdown.cts)
 * that guards everything appended after producer or caller Markdown: the
 * attribution, later findings, a native suggestion block and a marker.
 *
 * A code span cannot hide raw HTML across a blank line or a line that ends
 * its paragraph, and an escaped backtick opens none; a fence is closed only by
 * a closing fence CommonMark accepts (at most three columns of indentation,
 * in the same block quote and list item), and ends with its block quote or
 * list item. Anything else left open is refused rather than allowed to
 * swallow what follows. Producer Markdown in SARIF messages is held to the
 * same reading, so these are also regression tests for publication: each
 * refused case was accepted before, although GitHub renders the rest of the
 * comment inside the open fence or element.
 *
 * @see https://spec.commonmark.org/0.31.2/#code-spans
 * @see https://spec.commonmark.org/0.31.2/#backslash-escapes
 * @see https://spec.commonmark.org/0.31.2/#fenced-code-blocks
 * @see https://spec.commonmark.org/0.31.2/#block-quotes
 * @see https://spec.commonmark.org/0.31.2/#list-items
 * @see https://spec.commonmark.org/0.31.2/#html-blocks
 * @see https://spec.commonmark.org/0.31.2/#paragraphs
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { fenceProblem, unbalancedHtml } from '../dist/presentation/markdown.cjs';
import { at, lineFix, log, prepareOutcome, run } from './support/presentation-fixtures.mts';

const ESLINT = { driver: { name: 'eslint', version: '9.0.0' } };

describe('the structure scanner: code spans and fences as CommonMark reads them', () => {
  test('a code span cannot span a blank line, so the <details> it seemed to hide is open', () => {
    assert.equal(unbalancedHtml('`<details>\n\n` rest'), 'a <details> element');
  });

  // Further bypasses of the same kind: where a code span may not occur.
  const notCode: readonly (readonly [label: string, markdown: string])[] = [
    ['an escaped backtick opens no code span', '\\`<details>` rest'],
    ['an HTML block line interrupts the paragraph, so the span ends there', '`x\n<details>\n` rest'],
    ['a heading line interrupts the paragraph', '`x\n# <details>\n` rest'],
    ['a block quote line interrupts the paragraph', '`x\n> <details>\n` rest'],
    ['a list item interrupts the paragraph', '`x\n- <details>\n` rest'],
    ['a thematic break interrupts the paragraph', '`x\n***\n<details> `'],
  ];
  for (const [label, markdown] of notCode) {
    test(label, () => {
      assert.equal(unbalancedHtml(markdown), 'a <details> element');
    });
  }

  test('a code span on several lines of one paragraph still hides what it contains', () => {
    assert.equal(unbalancedHtml('`a\nb <details>` rest'), null);
  });

  const unclosed: readonly (readonly [label: string, markdown: string])[] = [
    ['a closing fence indented four spaces does not close', '```\nx\n    ```\nrest'],
    ['a block quote\'s fence ends with the block quote, so a later fence opens', '> ```\n> x\n\n```\nrest'],
    ['a list item\'s fence ends with the item, so a later fence opens', '- ```\n  x\nnot in the item\n```\nrest'],
    ['an opening fence indented four spaces opens nothing, so the later one opens', '    ```\nx\n```\nrest'],
  ];
  for (const [label, markdown] of unclosed) {
    test(label, () => {
      assert.equal(fenceProblem(markdown), 'unclosed-fence');
    });
  }

  test('fences that CommonMark closes are still balanced', () => {
    assert.equal(fenceProblem('```\nx\n   ```'), null);
    assert.equal(fenceProblem('> ```\n> x\n> ```'), null);
    assert.equal(fenceProblem('- ```\n  x\n  ```'), null);
    assert.equal(fenceProblem('> ```\n> x\n\nafter the block quote'), null, 'the block quote ended, and its fence with it');
  });
});

describe('producer Markdown: the same reading guards the attribution and the suggestion block', () => {
  const producer = (markdown: string): Record<string, unknown> => log(run(ESLINT, [{
    message: { text: 'Plain.', markdown },
    locations: [at('src/app.js', { startLine: 2 })],
    fixes: [lineFix('src/app.js', 2, 'C', 'Uppercase it.')],
  }]));

  for (const [label, markdown, code] of [
    ['a code span across a blank line that seems to close <details>', '`<details>\n\n` hidden', 'producer-html-unbalanced'],
    ['an escaped backtick before <details>', '\\`<details>` hidden', 'producer-html-unbalanced'],
    ['a closing fence indented four spaces', '```\nx\n    ```', 'producer-fence-unclosed'],
    ['a fence after a block quote\'s fence', '> ```\n> x\n\n```', 'producer-fence-unclosed'],
  ] as const) {
    test(`${label} is refused (${code}), since it would swallow or hide the suggestion block`, async () => {
      const outcome = await prepareOutcome(producer(markdown));
      assert.equal(outcome.status, 'blocked');
      assert.deepEqual(outcome.diagnostics.map((d) => d.code), [code]);
    });
  }
});
