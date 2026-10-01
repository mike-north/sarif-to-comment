/**
 * The reading of Markdown (src/presentation/markdown-tree.cts) that guards
 * everything appended after producer or caller Markdown: the attribution,
 * later findings, a native suggestion block and a marker. It parses with a
 * conformant CommonMark 0.31 + GFM parser (micromark), so code spans, fences,
 * HTML blocks, list items and block quotes are what CommonMark says they are,
 * and raw HTML is checked for balance only where the parser finds raw HTML.
 *
 * Each refused case below would leave a fence, an HTML block or an element
 * open, so that GitHub renders the rest of the comment inside it; each was
 * accepted by an earlier hand-written reading. Each accepted case is one
 * CommonMark reads as harmless, and an earlier reading refused. Producer
 * Markdown in SARIF messages is held to the same reading, so these are also
 * regression tests for publication.
 *
 * Expected readings follow the CommonMark spec sections cited below. Where
 * GitHub's cmark-gfm follows an older rule for HTML comments, the comment is
 * refused under either reading (docs/review-presentation-contract.md §7).
 *
 * @see https://spec.commonmark.org/0.31.2/#code-spans
 * @see https://spec.commonmark.org/0.31.2/#backslash-escapes
 * @see https://spec.commonmark.org/0.31.2/#fenced-code-blocks
 * @see https://spec.commonmark.org/0.31.2/#block-quotes
 * @see https://spec.commonmark.org/0.31.2/#list-items
 * @see https://spec.commonmark.org/0.31.2/#html-blocks
 * @see https://spec.commonmark.org/0.31.2/#paragraphs
 * @see https://spec.commonmark.org/0.31.2/#raw-html
 * @see https://spec.commonmark.org/0.29/#html-comment
 * @see ../docs/review-presentation-contract.md
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { fenceProblem, loadMarkdownParser, unbalancedHtml } from '../dist/presentation/markdown-tree.cjs';
import { at, lineFix, log, prepareOutcome, run } from './support/presentation-fixtures.mts';

const ESLINT = { driver: { name: 'eslint', version: '9.0.0' } };

await loadMarkdownParser();

describe('code spans and fences as CommonMark reads them', () => {
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

describe('HTML blocks, attributes and containers (regressions of the hand-written reading)', () => {
  // HTML blocks: a <span> block (type 7) holds the fence and <details> as raw HTML.
  test('a fence inside an HTML block is raw HTML, so the <details> beside it is still open at </span>', () => {
    assert.equal(unbalancedHtml('<span>\n```\n<details>\n```\n</span>'), 'an unmatched </span> tag');
  });

  test('a <div> block (type 6) holds the content\'s fences, so the fence after its blank line opens and swallows the rest', () => {
    assert.equal(fenceProblem('<div>\n```\n# Guide\n```\n</div>\n\nUse `x`.\n\n```\n'), 'unclosed-fence');
  });

  test('a <pre> block (type 1) runs to its </pre>, so a later fence opens and swallows the rest', () => {
    assert.equal(fenceProblem('<pre>\n```\n</pre>\n\n```\n</pre>'), 'unclosed-fence');
  });

  test('a <!-- block (type 2) runs to the end of the input without -->', () => {
    assert.equal(unbalancedHtml('<!--\n```\n-- >\n```\nrest'), 'an HTML <!-- construct');
    assert.equal(unbalancedHtml('<!--\n```\n-->\n```\nrest'), null, 'closed by -->');
    assert.equal(fenceProblem('<!--\n```\n-->\n```\nrest'), 'unclosed-fence', 'the fence after the comment block opens');
  });

  test('a backtick in a tag attribute opens no code span: the tag wins, and its element is unbalanced', () => {
    assert.equal(unbalancedHtml('<details title="`">x`</details>`y`</details>`'), 'an unmatched </details> tag');
  });

  test('a line indented four spaces in a list item is the item\'s content and can interrupt its paragraph', () => {
    assert.equal(unbalancedHtml('- `<details>\n    # x`'), 'a <details> element');
    assert.equal(unbalancedHtml('- `<details>\n    > x`'), 'a <details> element');
  });

  test('a line holding only a no-break space is not blank to CommonMark', () => {
    assert.notEqual(fenceProblem('- ```\n\u00a0\n  ```\n<details>\n'), null);
    assert.equal(unbalancedHtml('`<details>\n\u00a0\n` rest'), null, 'the code span continues across a line that is not blank');
  });

  test('a <div> block holding a fence line is balanced; a <details> after it in the same block is still open', () => {
    assert.equal(unbalancedHtml('<div>\n```\n</div>\n'), null);
    assert.equal(fenceProblem('<div>\n```\n</div>\n'), null);
    assert.equal(unbalancedHtml('<div>\n```\n</div>\n<details>\n```\n'), 'a <details> element');
  });

  test('a code span on several lines whose next line starts with a < that is no complete tag hides it', () => {
    assert.equal(unbalancedHtml('`a\n<b` c'), null);
    assert.equal(unbalancedHtml('`a\n<b <details>` c'), null);
  });

  test('an unterminated tag inside an HTML block would consume what follows, so it is refused', () => {
    assert.equal(unbalancedHtml('<details\n'), 'a <details> tag');
  });

  test('an unterminated tag in a paragraph is text, which GitHub escapes', () => {
    assert.equal(unbalancedHtml('x <details'), null);
  });

  test('comments: a comment cmark-gfm may not read as one is refused under either reading', () => {
    // CommonMark 0.31 reads `<!-->` and `<!-- a -- b -->` as comments; 0.29 (cmark-gfm) did not.
    assert.equal(unbalancedHtml('x <!-- a -- <details> -->'), 'an HTML <!-- construct');
    assert.equal(unbalancedHtml('x <!--> <details> -->'), 'an HTML <!-- construct');
    assert.equal(unbalancedHtml('x <!-- fine --> y'), null);
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
    ['a fence and <details> inside an HTML block', '<span>\n```\n<details>\n```\n</span>', 'producer-html-unbalanced'],
    ['an HTML comment block left open', '<!--\n```\n-- >\n```', 'producer-html-unbalanced'],
    ['a backtick inside a tag attribute', '<details title="`">x`</details>`y`</details>`', 'producer-html-unbalanced'],
    ['a four-space line interrupting a list item', '- `<details>\n    # x`', 'producer-html-unbalanced'],
  ] as const) {
    test(`${label} is refused (${code}), since it would swallow or hide the suggestion block`, async () => {
      const outcome = await prepareOutcome(producer(markdown));
      assert.equal(outcome.status, 'blocked');
      assert.deepEqual(outcome.diagnostics.map((d) => d.code), [code]);
    });
  }

  for (const [label, markdown] of [
    ['a code span on two lines whose second line starts with <', '`a\n<b` c'],
    ['an HTML block holding a fence line, closed', '<div>\n```\n</div>'],
  ] as const) {
    test(`${label} is accepted, as CommonMark reads it as harmless`, async () => {
      const outcome = await prepareOutcome(producer(markdown));
      assert.equal(outcome.status, 'ready', outcome.markdown);
    });
  }
});
