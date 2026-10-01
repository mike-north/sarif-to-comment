/**
 * Unit tests for the companion-index component
 * (src/presentation/companion-index.cts): the review body's list of the
 * companion pull requests that belong to one review (D56).
 *
 * Every expected text is written by hand from
 * docs/companion-suggestion-pr-contract.md §2.13.3. The link of each entry is
 * an identity link, so the tests also read the Markdown back with the
 * CommonMark + GFM reader the composed-text checkpoint uses, and check that
 * each `[#N](URL)` is shown as itself whatever the title says.
 *
 * @see ../docs/companion-suggestion-pr-contract.md
 * @see ../docs/design-decisions.md (D56)
 * @see https://spec.commonmark.org/0.31.2/#links
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { renderCompanionIndex } from '../dist/presentation/companion-index.cjs';
import type { ICompanionIndexEntry } from '../dist/presentation/companion-index.cjs';
import { composedProblem, loadMarkdownParser, showsAsItself } from '../dist/presentation/markdown-tree.cjs';
import { renderReviewBody } from '../dist/prepare-review.cjs';

await loadMarkdownParser();

const url = (n: number): string => `https://github.com/octo/widgets/pull/${String(n)}`;
const created = (number: number, title: string): ICompanionIndexEntry => ({ number, url: url(number), title, origin: 'created' });
const existing = (number: number, title: string, state: 'open' | 'draft' | 'closed' | 'merged'): ICompanionIndexEntry =>
  ({ number, url: url(number), title, origin: 'existing', state });

const HEADING = '**Companion pull requests of this review:**';

describe('the companion index (companion contract §2.13.3)', () => {
  test('one created companion: the heading, then its link, title and origin', () => {
    assert.equal(
      renderCompanionIndex([created(101, 'Suggestion for #7: create docs/guide.md')]),
      `${HEADING}\n\n- [#101](${url(101)}): Suggestion for \\#7: create docs/guide.md — created with this review`,
    );
  });

  test('existing companions state what they were when the review was prepared, in each of the four states', () => {
    assert.equal(
      renderCompanionIndex([
        existing(97, 'Suggestion for #7: edit README.md', 'open'),
        existing(98, 'Suggestion for #7: edit README.md', 'draft'),
        existing(99, 'Suggestion for #7: delete obsolete.txt', 'closed'),
        existing(100, 'Suggestion for #7: create docs/a.md', 'merged'),
      ]),
      [
        HEADING,
        '',
        `- [#97](${url(97)}): Suggestion for \\#7: edit README.md — reused; it was open when this review was prepared`,
        `- [#98](${url(98)}): Suggestion for \\#7: edit README.md — reused; it was a draft when this review was prepared`,
        `- [#99](${url(99)}): Suggestion for \\#7: delete obsolete.txt — reused; it was closed when this review was prepared`,
        `- [#100](${url(100)}): Suggestion for \\#7: create docs/a.md — reused; it was merged when this review was prepared`,
      ].join('\n'),
    );
  });

  test('entries keep the order they are given: the component never reorders', () => {
    const text = renderCompanionIndex([existing(97, 'B', 'open'), created(101, 'A')]);
    assert.ok(text.indexOf('[#97]') < text.indexOf('[#101]'), text);
  });

  test('a title is plain text: Markdown is escaped, a mention is a code span, a line break is a space', () => {
    assert.equal(
      renderCompanionIndex([existing(97, 'Fix *all* [links] for @octocat\nnow', 'open')]),
      `${HEADING}\n\n- [#97](${url(97)}): Fix \\*all\\* \\[links\\] for \`@octocat\` now — reused; it was open when this review was prepared`,
    );
  });

  test('an index of no companion is never rendered', () => {
    assert.throws(() => renderCompanionIndex([]), /Internal error/);
  });
});

describe('every entry\'s link is an identity link (D60; companion contract §2.13.3)', () => {
  const hostile = [
    'x](https://evil.example/pull/1) [#1',
    '<details><summary>open',
    '```suggestion',
    '<!-- suggestion-pr {"version":1} -->',
    '`unclosed code',
    '$\\phantom{x}$',
  ];
  for (const title of hostile) {
    test(`a title ${JSON.stringify(title)} cannot re-point, hide or swallow a link`, () => {
      const text = renderCompanionIndex([created(101, title), existing(97, title, 'open')]);
      for (const n of [101, 97]) assert.ok(showsAsItself(text, `[#${String(n)}](${url(n)})`), `[#${String(n)}] is shown as itself:\n${text}`);
      assert.equal(composedProblem(text, {}), null, text);
      assert.equal(text.includes('<!-- suggestion-pr'), false, 'no marker text survives unescaped');
    });
  }
});

describe('a plan without an index section renders without one (companion contract §2.13.4)', () => {
  const target = { owner: 'octo', repo: 'widgets', pullNumber: 7, reviewedCommit: '2222222222222222222222222222222222222222', headRef: 'feature/retry', ready: false };
  const companion = {
    title: 'Suggestion for #7: create docs/guide.md',
    commitMessage: 'm',
    changes: [],
    sections: [{ changeCount: 1, changeLines: '- New file `docs/guide.md`: details', items: 'Add a guide.' }],
  };

  test('sections planned before the index existed are rendered exactly as planned', () => {
    const body = renderReviewBody({ companions: [companion], sections: ['A finding.', { companion: 0, section: 0 }] }, [101], target);
    assert.equal(body.includes(HEADING), false, body);
    assert.ok(body.startsWith('A finding.\n\n---\n\n**Suggestion pull request:** [#101]'), body);
  });

  test('an index section lists the created companions by their numbers, then the existing ones as recorded', () => {
    const body = renderReviewBody({
      companions: [companion],
      sections: [{ companionIndex: { existing: [{ number: 97, title: 'Earlier', state: 'closed' }] } }, { companion: 0, section: 0 }],
    }, [101], target);
    assert.ok(body.startsWith([
      HEADING,
      '',
      `- [#101](${url(101)}): Suggestion for \\#7: create docs/guide.md — created with this review`,
      `- [#97](${url(97)}): Earlier — reused; it was closed when this review was prepared`,
      '',
      '---',
      '',
      `**Suggestion pull request:** [#101](${url(101)})`,
    ].join('\n')), body);
  });
});
