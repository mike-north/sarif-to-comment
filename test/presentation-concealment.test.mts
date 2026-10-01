/**
 * Presentation callbacks cannot conceal a required fragment that the result
 * still "contains" (src/presentation/customization.cts): every required
 * fragment must be shown as itself — not inside an HTML comment, CDATA
 * section, processing instruction or declaration, a link reference
 * definition, a code span or fence it does not open itself, a tag, a link
 * destination or title, an image description, or an element GitHub does not
 * display — and a callback may not add comments, CDATA sections, processing
 * instructions, declarations or link reference definitions of its own (one
 * the presented content carries may pass through).
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

import { present } from '../dist/presentation/customization.cjs';
import type {
  IAttributionPresentationContext,
  IFileAdditionPresentationContext,
  IFileDeletionPresentationContext,
  IFindingPresentationContext,
} from '../dist/public-api.cjs';
import { at, carrying, log, prepare, prepareOutcome, run } from './support/presentation-fixtures.mts';

/** Matches the refusal of a callback result for `component`, whose message matches `rule`. */
const refusedBy = (component: string, rule: RegExp): ((error: unknown) => boolean) => (error) => {
  assert.ok(error instanceof TypeError, 'a TypeError');
  assert.match(error.message, new RegExp(`^Invalid presentation: options\\.presentation\\.${component} returned Markdown that `));
  assert.match(error.message, rule);
  return true;
};

const ESLINT = { driver: { name: 'eslint', version: '9.0.0' } };
/** One general finding by eslint and one creation with a finding on its line 1. */
const DOCUMENT = log(run(ESLINT, [
  { ruleId: 'no-x', message: { text: 'Second and third disagree.' }, locations: [at('docs/notes.md', { startLine: 2, endLine: 3 })] },
  carrying('Document the new option.', [{ operation: 'create', artifactIndex: 0 }], at('docs/guide.md', { startLine: 1 })),
], [{ location: { uri: 'docs/guide.md' }, contents: { text: '# Guide\n\nUse `x`.\n' }, encoding: 'utf-8' }]));

describe('callbacks cannot hide a required fragment that is still "contained"', () => {
  test('the review\'s three examples are refused', async () => {
    await assert.rejects(prepareOutcome(DOCUMENT, { presentation: { attribution: () => '<!-- eslint 9.0.0 --> nobody' } }),
      refusedBy('attribution', /adds an HTML comment/));
    await assert.rejects(prepareOutcome(DOCUMENT, {
      presentation: { fileAddition: (c: IFileAdditionPresentationContext) => `<![CDATA[ ${c.markdown} ]]> see attached` },
    }), refusedBy('fileAddition', /adds a CDATA section/));
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
    ['in a tag\'s attribute', '<abbr title="eslint">a linter</abbr>'],
    ['in an element with the hidden attribute', '<span hidden>eslint</span> a linter'],
    ['in an element with a style attribute', '<span style="display:none">eslint</span> a linter'],
    ['in an element GitHub does not display', '<template>eslint</template> a linter'],
  ];
  for (const [label, attribution] of hidden) {
    test(`the producer's name ${label} is hidden`, async () => {
      await assert.rejects(prepareOutcome(DOCUMENT, { presentation: { attribution: () => attribution } }),
        refusedBy('attribution', /hides a required fragment, which must be shown as itself: "eslint"/));
    });
  }

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
});

