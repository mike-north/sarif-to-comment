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
import { composedProblem, linksIn, loadMarkdownParser, showsAsItself } from '../dist/presentation/markdown-tree.cjs';
import { renderReviewBody } from '../dist/prepare-review.cjs';
import { present } from '../dist/presentation/customization.cjs';

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
      `${HEADING}\n\n- [#101](${url(101)}): \`Suggestion for #7: create docs/guide.md\` — created with this review`,
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
        `- [#97](${url(97)}): \`Suggestion for #7: edit README.md\` — reused; it was open when this review was prepared`,
        `- [#98](${url(98)}): \`Suggestion for #7: edit README.md\` — reused; it was a draft when this review was prepared`,
        `- [#99](${url(99)}): \`Suggestion for #7: delete obsolete.txt\` — reused; it was closed when this review was prepared`,
        `- [#100](${url(100)}): \`Suggestion for #7: create docs/a.md\` — reused; it was merged when this review was prepared`,
      ].join('\n'),
    );
  });

  test('entries keep the order they are given: the component never reorders', () => {
    const text = renderCompanionIndex([existing(97, 'B', 'open'), created(101, 'A')]);
    assert.ok(text.indexOf('[#97]') < text.indexOf('[#101]'), text);
  });

  test('a title is a code span: nothing in it is Markdown, a mention or a link, and a line break is a space', () => {
    assert.equal(
      renderCompanionIndex([existing(97, 'Fix *all* [links] for @octocat\nnow', 'open')]),
      `${HEADING}\n\n- [#97](${url(97)}): \`Fix *all* [links] for @octocat now\` — reused; it was open when this review was prepared`,
    );
    assert.equal(renderCompanionIndex([created(101, 'a `b` c')]), `${HEADING}\n\n- [#101](${url(101)}): \`\`a \`b\` c\`\` — created with this review`);
  });

  test('a title cannot mimic the origin: the true origin always follows its code span', () => {
    const text = renderCompanionIndex([existing(97, 'x — created with this review', 'merged')]);
    assert.equal(text, `${HEADING}\n\n- [#97](${url(97)}): \`x — created with this review\` — reused; it was merged when this review was prepared`);
    assert.deepEqual(linksIn(text).map((l) => l.url), [url(97)]);
  });

  test('invisible and bidirectional characters in a title are shown as visible escapes, never dropped', () => {
    assert.equal(
      renderCompanionIndex([existing(97, 'ab\u202Ecd\u200Bef\u00A0g\uFEFF', 'open')]),
      `${HEADING}\n\n- [#97](${url(97)}): \`ab{U+202E}cd{U+200B}ef{U+00A0}g{U+FEFF}\` — reused; it was open when this review was prepared`,
    );
  });

  test('a zero-width joiner inside an emoji sequence is kept; anywhere else it is escaped', () => {
    const family = '\u{1F469}\u200D\u{1F4BB}';
    const heart = '\u2764\uFE0F\u200D\u{1F525}';
    assert.ok(renderCompanionIndex([created(101, `Ship ${family} ${heart}`)]).includes(`\`Ship ${family} ${heart}\``));
    assert.ok(renderCompanionIndex([created(101, 'a\u200Db')]).includes('`a{U+200D}b`'));
    assert.ok(renderCompanionIndex([created(101, '\u{1F469}\u200D')]).includes('`\u{1F469}{U+200D}`'));
  });

  test('an index of no companion is never rendered', () => {
    assert.throws(() => renderCompanionIndex([]), /Internal error/);
  });
});

describe('every entry\'s link is an identity link (D60; companion contract §2.13.3)', () => {
  const hostile = [
    'See https://evil.example/pull/1',
    'www.evil.example/x',
    'a@b.example',
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
      assert.deepEqual(linksIn(text).map((l) => l.url), [url(101), url(97)], 'no link but the two identity links');
      assert.equal(/<!--\s*suggestion-pr/.test(text.replace(/`[^`]*`/g, '')), false, 'no marker text outside a code span');
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
      `- [#101](${url(101)}): \`Suggestion for #7: create docs/guide.md\` — created with this review`,
      `- [#97](${url(97)}): \`Earlier\` — reused; it was closed when this review was prepared`,
      '',
      '---',
      '',
      `**Suggestion pull request:** [#101](${url(101)})`,
    ].join('\n')), body);
  });
});

describe('companion callbacks: checks the adversarial re-check pinned (review presentation contract §7)', () => {
  const entries: ICompanionIndexEntry[] = [
    created(101, 'Suggestion for #7: retry-with-test (2 changes)'),
    existing(97, 'Suggestion for #7: edit README.md', 'draft'),
  ];
  /** The index callback's context and identity links for `list`, as preparation builds them. */
  function indexContext(list: readonly ICompanionIndexEntry[]) {
    const companions = list.map((e) => ({
      number: e.number, url: e.url, title: e.title, origin: e.origin === 'created' ? 'created' : 'reused',
      ...(e.origin === 'existing' ? { state: e.state } : {}), link: `[#${String(e.number)}](${e.url})`,
    }));
    return {
      context: { pullNumber: 7, companions, markdown: renderCompanionIndex(list), required: companions.map((c) => c.link) },
      identity: companions.map((c) => ({ text: `#${String(c.number)}`, url: c.url })),
    };
  }
  const run = (list: readonly ICompanionIndexEntry[], callback: (context: { readonly markdown: string }) => string): string => {
    const { context, identity } = indexContext(list);
    return present('companionIndex', callback, context, identity);
  };
  const refused = (rule: RegExp) => (err: unknown): boolean => err instanceof TypeError && rule.test(err.message);

  // The probe's exact titles (scratch/u6-probe.mjs): a suggestionGroup name or a GitHub title may hold marker-like text.
  for (const title of ['<!-- sarif-to-comment:x', '<!-- suggestion-pr {}']) {
    test(`regression: a title ${JSON.stringify(title)} does not block an identity callback, created or reused`, () => {
      const list = [created(101, title), existing(97, title, 'open')];
      assert.equal(run(list, (c) => c.markdown), renderCompanionIndex(list));
    });
  }

  test('a callback that adds a real marker is still refused, and so is one that shows a marker-like title outside code', () => {
    assert.throws(() => run(entries, (c) => `${c.markdown}\n\n<!-- suggestion-pr {"version":1} -->`), refused(/reads as a publication or suggestion marker/));
    assert.throws(() => run(entries, (c) => `${c.markdown}\n\n<!-- sarif-to-comment:review:x -->`), refused(/reads as a publication or suggestion marker/));
    const list = [created(101, '<!-- suggestion-pr {}')];
    assert.throws(() => run(list, () => `- [#101](${url(101)}): <!-- suggestion-pr {}`), refused(/reads as a publication or suggestion marker/));
  });

  const lookAlikes: readonly (readonly [string, string])[] = [
    ['a fullwidth number sign', `[＃101](${url(97)})`],
    ['a fullwidth number sign, linking elsewhere', '[＃101](https://evil.example)'],
    ['a fullwidth digit', `[#１01](${url(97)})`],
  ];
  for (const [what, link] of lookAlikes) {
    test(`a link text with ${what} reads as the companion's number (NFKC), so it may not lead elsewhere`, () => {
      assert.throws(() => run(entries, (c) => `${c.markdown}\n\n${link}`), refused(/links the text/));
    });
  }

  test('documented limit: a visibly different look-alike (the letter O for zero) is not recognized as the number', () => {
    assert.ok(run(entries, (c) => `${c.markdown}\n\n[#1O1](${url(97)})`).endsWith(`[#1O1](${url(97)})`));
  });

  test('an image is refused: it fetches from elsewhere, and its alt text could read as a number', () => {
    assert.throws(() => run(entries, (c) => `${c.markdown}\n\n![](https://evil.example/pixel.png)`), refused(/adds an image/));
    assert.throws(() => run(entries, (c) => `${c.markdown}\n\n[![#101](https://evil.example/101.png)](${url(97)})`), refused(/links the text "#101"|adds an image/));
  });

  test('an image link\'s alt text is its text', () => {
    assert.deepEqual(linksIn(`[![#101](https://x.example/a.png)](${url(97)})`).map((l) => l.text), ['#101']);
  });
});
