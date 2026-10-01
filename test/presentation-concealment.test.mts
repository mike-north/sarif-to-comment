/**
 * Presentation callbacks cannot conceal a required fragment that the result
 * still "contains" (src/presentation/customization.cts), as a conformant
 * CommonMark + GFM parse reads the result (src/presentation/markdown-tree.cts).
 * Every required fragment must be shown as itself: not inside raw HTML, a
 * code span or block it does not open itself, an image, a definition, or an
 * element GitHub does not display, and a permalink not as an image source or
 * the text of a link to somewhere else. A callback may add no raw HTML and no
 * link reference definition of its own; a node whose exact source the
 * built-in Markdown also has as a node may pass through.
 *
 * Each negative case keeps the fragment verbatim and states why GitHub would
 * not show it as itself, following the CommonMark and GFM rules cited below.
 *
 * @see ../docs/review-presentation-contract.md
 * @see https://spec.commonmark.org/0.31.2/#raw-html
 * @see https://spec.commonmark.org/0.31.2/#link-reference-definitions
 * @see https://spec.commonmark.org/0.31.2/#links
 * @see https://spec.commonmark.org/0.31.2/#images
 * @see https://spec.commonmark.org/0.31.2/#code-spans
 * @see https://spec.commonmark.org/0.31.2/#indented-code-blocks
 * @see https://github.github.com/gfm/#disallowed-raw-html-extension-
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveDeliveryPolicy } from '../dist/delivery-policy.cjs';
import { present } from '../dist/presentation/customization.cjs';
import { loadMarkdownParser } from '../dist/presentation/markdown-tree.cjs';
import type {
  IAttributionPresentationContext,
  IFileAdditionPresentationContext,
  IFileDeletionPresentationContext,
  IFindingPresentationContext,
} from '../dist/public-api.cjs';
import type { IReadyOutcome } from '../dist/prepare-review.cjs';
import { at, carrying, lineFix, log, prepare, prepareOutcome, run } from './support/presentation-fixtures.mts';

/** Matches the refusal of a callback result for `component`, whose message matches `rule`. */
const refusedBy = (component: string, rule: RegExp): ((error: unknown) => boolean) => (error) => {
  assert.ok(error instanceof TypeError, 'a TypeError');
  assert.match(error.message, new RegExp(`^Invalid presentation: options\\.presentation\\.${component} returned Markdown that `));
  assert.match(error.message, rule);
  return true;
};

await loadMarkdownParser();

const ESLINT = { driver: { name: 'eslint', version: '9.0.0' } };
/** One general finding by eslint and one creation with a finding on its line 1. */
const DOCUMENT = log(run(ESLINT, [
  { ruleId: 'no-x', message: { text: 'Second and third disagree.' }, locations: [at('docs/notes.md', { startLine: 2, endLine: 3 })] },
  carrying('Document the new option.', [{ operation: 'create', artifactIndex: 0 }], at('docs/guide.md', { startLine: 1 })),
], [{ location: { uri: 'docs/guide.md' }, contents: { text: '# Guide\n\nUse `x`.\n' }, encoding: 'utf-8' }]));

describe('callbacks cannot hide a required fragment that is still "contained"', () => {
  test('the review\'s three examples are refused', async () => {
    await assert.rejects(prepareOutcome(DOCUMENT, { presentation: { attribution: () => '<!-- eslint 9.0.0 --> nobody' } }),
      refusedBy('attribution', /adds raw HTML of its own \("<!-- eslint 9\.0\.0 --> nobody"\)/));
    await assert.rejects(prepareOutcome(DOCUMENT, {
      presentation: { fileAddition: (c: IFileAdditionPresentationContext) => `<![CDATA[ ${c.markdown} ]]> see attached` },
    }), refusedBy('fileAddition', /adds raw HTML of its own \("<!\[CDATA\[/));
    await assert.rejects(prepareOutcome(DOCUMENT, {
      presentation: { finding: (c: IFindingPresentationContext) => `Looks fine.\n\n[//]: # (${c.attribution})` },
    }), refusedBy('finding', /adds a link reference definition/));
  });

  // Each result keeps the fragment verbatim, but GitHub would not show it as itself.
  const hidden: readonly (readonly [label: string, attribution: string])[] = [
    ['in a code span, where it reads as code', '`eslint` said so'],
    ['in a fence it does not open', '```\neslint\n```'],
    ['in an indented code block', 'Reported.\n\n    eslint'],
    ['in a link destination', '[a linter](https://example.com/eslint)'],
    ['in a link title', '[a linter](https://example.com "eslint")'],
    ['in an image description', '![eslint](https://example.com/logo.png)'],
  ];
  for (const [label, attribution] of hidden) {
    test(`the producer's name ${label} is hidden`, async () => {
      await assert.rejects(prepareOutcome(DOCUMENT, { presentation: { attribution: () => attribution } }),
        refusedBy('attribution', /hides a required fragment, which must be shown as itself: "eslint"/));
    });
  }

  // A callback may add no raw HTML of its own, so no tag, attribute or element can hide a fragment.
  const raw: readonly (readonly [label: string, attribution: string])[] = [
    ['in a tag\'s attribute', '<abbr title="eslint">a linter</abbr>'],
    ['in an element with the hidden attribute', '<span hidden>eslint</span> a linter'],
    ['in an element with a style attribute', '<span style="display:none">eslint</span> a linter'],
    ['in an element GitHub does not display', '<template>eslint</template> a linter'],
    ['in a <textarea>', '<textarea>eslint</textarea>'],
    ['in a <details> summary', '<details><summary>eslint</summary>x</details>'],
  ];
  for (const [label, attribution] of raw) {
    test(`the producer's name ${label} is refused as raw HTML the callback adds`, async () => {
      await assert.rejects(prepareOutcome(DOCUMENT, { presentation: { attribution: () => attribution } }),
        refusedBy('attribution', /adds raw HTML of its own/));
    });
  }

  test('a link reference definition over several lines is refused, wherever its label and title are', () => {
    const context = { markdown: 'eslint', required: ['eslint'] };
    assert.throws(() => present('finding', () => '[\neslint\n]: https://x\n\nhello', context), refusedBy('finding', /adds a link reference definition of its own/));
  });

  test('pass-through is decided per whole node: a carried definition or comment cannot be extended to hide a fragment', () => {
    const carried = { markdown: 'See [g][g].\n\n[g]: https://example.com/guide', required: ['eslint'] };
    assert.throws(() => present('finding', () => 'See [g][g].\n\n[g]: https://example.com/guide\n   "eslint"', carried),
      refusedBy('finding', /adds a link reference definition of its own/));
    assert.throws(() => present('finding', () => 'See [g][g].\n\n[g]:\nhttps://x/eslint', { ...carried, markdown: 'See [g][g].\n\n[g]:\nhttps://example.com/guide' }),
      refusedBy('finding', /adds a link reference definition of its own/));
    assert.throws(() => present('finding', () => '<!-- lint:disable -->eslint', { markdown: 'x <!-- lint:disable -->', required: ['eslint'] }),
      refusedBy('finding', /adds raw HTML of its own/));
  });

  test('a backtick in a tag attribute cannot make an open element look closed', () => {
    const context = { markdown: 'eslint', required: ['eslint'] };
    assert.throws(() => present('finding', () => 'eslint <details title="`">x`</details>`y`</details>`', context), refusedBy('finding', /leaves a <details> element open/));
  });

  test('a permalink as an image source, or as the text of a link to somewhere else, is not its source association', async () => {
    const deletion = log(run(ESLINT, [carrying('Remove it.', [{ operation: 'delete', artifactIndex: 0 }])], [{ location: { uri: 'obsolete.txt' } }]));
    await assert.rejects(prepareOutcome(deletion, { presentation: { fileDeletion: (c: IFileDeletionPresentationContext) => `![file](${c.url})\n\n${c.findings}` } }),
      refusedBy('fileDeletion', /hides a required fragment/));
    await assert.rejects(prepareOutcome(deletion, { presentation: { fileDeletion: (c: IFileDeletionPresentationContext) => `[${c.url}](https://example.com/elsewhere)\n\n${c.findings}` } }),
      refusedBy('fileDeletion', /hides a required fragment/));
    const bare = await prepare(deletion, { presentation: { fileDeletion: (c: IFileDeletionPresentationContext) => `Remove ${c.url}\n\n${c.findings}` } });
    assert.match(bare.review.body, /^Remove https:\/\/github\.com\//, 'a bare permalink, which GitHub links to itself, is fine');
  });

  test('proposed content wrapped in a longer fence, or in a block quote, is no longer shown as its own code block', async () => {
    await assert.rejects(prepareOutcome(DOCUMENT, {
      presentation: { fileAddition: (c: IFileAdditionPresentationContext) => `\`\`\`\`\`\n${c.markdown}\n\`\`\`\`\`` },
    }), refusedBy('fileAddition', /hides a required fragment/));
    // "> " before the opening fence: the block quote, and the fence in it,
    // ends at the next line without ">", so the content renders as Markdown
    // and the content's own closing fence opens a fence that swallows the rest.
    await assert.rejects(prepareOutcome(DOCUMENT, {
      presentation: { fileAddition: (c: IFileAdditionPresentationContext) => c.markdown.replace(c.content ?? '', `> ${c.content ?? ''}`) },
    }), refusedBy('fileAddition', /leaves a code fence open/));
  });

  test('a backtick before a fragment that pairs with one inside it is refused', async () => {
    await assert.rejects(prepareOutcome(DOCUMENT, {
      presentation: { fileAddition: (c: IFileAdditionPresentationContext) => c.markdown.replace('**Proposed new file:** ', '**Proposed new file:** ``x` ') },
    }), refusedBy('fileAddition', /hides a required fragment/));
  });

  test('allowed: code that is the fragment itself, a permalink as a link destination, and constructs the presented content carries', async () => {
    const deletion = log(run(ESLINT, [carrying('Remove it.', [{ operation: 'delete', artifactIndex: 0 }])], [{ location: { uri: 'obsolete.txt' } }]));
    const deleted = await prepare(deletion, { presentation: { fileDeletion: (c: IFileDeletionPresentationContext) => `[Remove this file](${c.url})\n\n${c.findings}` } });
    assert.match(deleted.review.body, /^\[Remove this file\]\(https:\/\/github\.com\/acme\/widgets\/blob\/2{40}\/obsolete\.txt\)\n\nRemove it\./);
    const added = await prepare(DOCUMENT, { presentation: { fileAddition: (c: IFileAdditionPresentationContext) => c.markdown.replace('**Proposed new file:**', '### New file') } });
    assert.match(added.review.body, /### New file `docs\/guide\.md`/);
    // A producer's own comment and reference definition pass through a callback that keeps the message.
    const commented = log(run(ESLINT, [{
      message: { text: 'See the guide.', markdown: 'See [the guide][g]. <!-- lint:disable -->\n\n[g]: https://example.com/guide' },
      locations: [at('docs/notes.md', { startLine: 1 })],
    }]));
    const kept = await prepare(commented, { presentation: { finding: (c: IFindingPresentationContext) => `> ${c.attribution}\n\n${c.message}` } });
    assert.match(kept.review.body, /<!-- lint:disable -->/);
  });

  test('an attribution callback that keeps the names visible is accepted', () => {
    const context: IAttributionPresentationContext = { tool: 'eslint', markdown: 'eslint', required: ['eslint'] };
    assert.equal(present('attribution', (c) => `reported by **${c.tool}**`, context), 'reported by **eslint**');
  });

  test('a permalink inside a carried <a href> that goes elsewhere is not its source association', () => {
    const url = 'https://github.com/acme/widgets/blob/2222222222222222222222222222222222222222/obsolete.txt';
    const builtIn = `[x](${url})\n\nsee <a href="https://example.com/elsewhere">docs</a> F`;
    assert.throws(() => present('fileDeletion', () => `<a href="https://example.com/elsewhere">${url}</a>\n\nF`, { markdown: builtIn, required: [url, 'F'] }),
      refusedBy('fileDeletion', /hides a required fragment, which must be shown as itself: "https:/));
  });

  // GitHub renders $…$ and $$…$$ as TeX, where \phantom{} hides text. (Math rendering is not live-checked.)
  for (const [label, attribution] of [
    ['inline math', 'reported by $\\phantom{eslint}$'],
    ['block math', '$$\n\\phantom{eslint}\n$$'],
    ['math that a later $ closes', 'eslint said $5 then $'],
  ] as const) {
    test(`the producer's name in ${label} is not shown`, () => {
      assert.throws(() => present('finding', () => attribution, { markdown: 'eslint', required: ['eslint'] }), refusedBy('finding', /hides a required fragment/));
    });
  }

  test('a $ in code, or escaped, cannot make math', () => {
    assert.equal(present('finding', () => 'eslint costs `$5` and \\$6', { markdown: 'eslint', required: ['eslint'] }), 'eslint costs `$5` and \\$6');
  });
});

describe('the composed-text checkpoint blames a callback when the built-in layout composes cleanly', () => {
  // `eslint\` passes every check on its own, but composed into `<sub>— …</sub>`
  // its trailing backslash escapes the `<` of `</sub>`, leaving <sub> open over
  // the suggestion block (or the marker). The built-in attribution composes
  // cleanly, so the callback is blamed.
  const trailingBackslash = { attribution: (c: IAttributionPresentationContext) => `${c.tool}\\` };
  const composedRefusal = (where: RegExp): ((error: unknown) => boolean) => (error) => {
    assert.ok(error instanceof TypeError, 'a TypeError');
    assert.match(error.message, /^Invalid presentation: options\.presentation returned Markdown that, composed into /);
    assert.match(error.message, where);
    return true;
  };

  test('in an inline comment', async () => {
    const sarif = log(run(ESLINT, [{ message: { text: 'Plain.' }, locations: [at('src/app.js', { startLine: 2 })], fixes: [lineFix('src/app.js', 2, 'C', 'd')] }]));
    await assert.rejects(prepareOutcome(sarif, { presentation: trailingBackslash }), composedRefusal(/composed into inline comment 1, leaves a <sub> element open/));
  });

  test('in a suggestion pull request\'s description', async () => {
    const sarif = log(run(ESLINT, [{
      message: { text: 'Plain.' }, locations: [at('src/app.js', { startLine: 2 })],
      fixes: [{ description: { text: 'Both.' }, artifactChanges: [
        { artifactLocation: { uri: 'src/app.js' }, replacements: [{ deletedRegion: { startLine: 2 }, insertedContent: { text: 'C' } }] },
        { artifactLocation: { uri: 'docs/notes.md' }, replacements: [{ deletedRegion: { startLine: 1 }, insertedContent: { text: 'F' } }] },
      ] }],
    }]));
    // A fix with several changes is a grouped edit, delivered here by a companion pull request (delivery policy §12).
    const delivery = {
      policy: resolveDeliveryPolicy({ caller: { groupedEdits: ['companion'] } }),
      companionTarget: () => Promise.resolve({ headRef: 'feature/x', ready: false }),
    };
    await assert.rejects(prepareOutcome(sarif, { delivery, presentation: trailingBackslash }),
      composedRefusal(/composed into the description of the suggestion pull request for unit 1, leaves a <sub> element open/));
  });

  /** A finding whose one fix makes two changes: a grouped edit. */
  const jointFix = (message: string, appLine: number, notesLine: number): Record<string, unknown> => ({
    message: { text: message }, locations: [at('src/app.js', { startLine: appLine })],
    fixes: [{ description: { text: 'Both.' }, artifactChanges: [
      { artifactLocation: { uri: 'src/app.js' }, replacements: [{ deletedRegion: { startLine: appLine }, insertedContent: { text: 'X' } }] },
      { artifactLocation: { uri: 'docs/notes.md' }, replacements: [{ deletedRegion: { startLine: notesLine }, insertedContent: { text: 'Y' } }] },
    ] }],
  });

  test('in the description of a suggestion pull request bundling several proposals', async () => {
    // Delivery policy §9: under a `single` bundle, one companion holds every
    // unit it delivers, and its one description is read composed.
    const delivery = {
      policy: resolveDeliveryPolicy({ caller: { groupedEdits: ['companion'], companionBundle: 'single' } }),
      companionTarget: () => Promise.resolve({ headRef: 'feature/x', ready: false }),
    };
    const sarif = log(run(ESLINT, [jointFix('First.', 1, 1), jointFix('Second.', 3, 3)]));
    await assert.rejects(prepareOutcome(sarif, { delivery, presentation: trailingBackslash }),
      composedRefusal(/composed into the description of the suggestion pull request for units 1, 2, leaves a <sub> element open/));
  });

  test('in a native batch member\'s inline comment, whose group note precedes its suggestion block', async () => {
    // Delivery policy §8.8: each member of a native batch carries the group's
    // note between its findings and its suggestion block.
    const member = (text: string, line: number, replacement: string): Record<string, unknown> => ({
      message: { text }, locations: [at('src/app.js', { startLine: line })],
      fixes: [lineFix('src/app.js', line, replacement, text)],
      properties: { sarifToComment: { suggestionGroup: 'g' } },
    });
    const sarif = log(run(ESLINT, [member('First.', 1, 'A'), member('Third.', 3, 'D')]));
    const builtIn = await prepare(sarif);
    assert.match(itemAtComment(builtIn, 0), /\*\*Suggestion group `g`:\*\* apply this suggestion together/);
    await assert.rejects(prepareOutcome(sarif, { presentation: trailingBackslash }),
      composedRefusal(/composed into inline comment 1, leaves a <sub> element open/));
  });
});

/** The body of inline comment `index` of a ready outcome. */
function itemAtComment(outcome: IReadyOutcome, index: number): string {
  const comment = outcome.review.comments[index];
  assert.ok(comment !== undefined, `inline comment ${String(index + 1)}`);
  return comment.body;
}

