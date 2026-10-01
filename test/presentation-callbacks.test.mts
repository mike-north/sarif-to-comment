/**
 * Library presentation callbacks (`options.presentation`, D60
 * "Customization"; src/presentation/customization.cts): a caller replaces the
 * Markdown of named components, and the core keeps — independent of any
 * callback — publication and suggestion markers, native suggestion blocks,
 * the exact bytes of proposed content, required provenance and source
 * association, and the size limits.
 *
 * Layers:
 *   - unit: the enforcement (`present`) and option capture;
 *   - preparation: every component customized through whole-review
 *     preparation, with the core's composition around it;
 *   - integration: publish and validate through the real GitHub client
 *     against the fake HTTP host, including a companion suggestion pull
 *     request whose lifecycle note is customized;
 *   - negative: callbacks that would remove or forge a marker or a
 *     suggestion block, drop required content or break limits are refused
 *     before anything is written.
 *
 * Expected Markdown is written by hand: the callbacks' own text, composed
 * with the core's parts as docs/review-presentation-contract.md and the
 * contracts it cites define them.
 *
 * @see ../docs/design-decisions.md (D60)
 * @see ../docs/review-presentation-contract.md (§2–§5, §7 customization)
 * @see ../docs/companion-suggestion-pr-contract.md (§2.7 marker, §2.11 presentation)
 * @see ../docs/file-operation-publication-contract.md (§2 presentation)
 * @see https://github.github.com/gfm/#fenced-code-blocks
 * @see https://github.github.com/gfm/#raw-html
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { describe, test } from 'node:test';

import { capturePresentation, present, presentationOptionProblem } from '../dist/presentation/customization.cjs';
import { loadMarkdownParser } from '../dist/presentation/markdown-tree.cjs';
import type {
  IAlternativesPresentationContext,
  IAttributionPresentationContext,
  IFileAdditionPresentationContext,
  IFileDeletionPresentationContext,
  IFindingPresentationContext,
  ILifecycleNotePresentationContext,
  IReviewPresentation,
} from '../dist/public-api.cjs';
import {
  GUIDE_DOCUMENT, HEAD, R, SHORT, SUGGESTION_MARKER,
  at, carrying, hostDocument, hostWorld, lineFix, log, permalink, prepare, prepareOutcome, publish, reviewBodyWithoutMarker, run, validate,
} from './support/presentation-fixtures.mts';
import type { IHostWorld, Json } from './support/presentation-fixtures.mts';

/** The refusal every broken callback result gets, naming the component. */
const refusedBy = (component: string, rule: RegExp): ((error: unknown) => boolean) => (error) => {
  assert.ok(error instanceof TypeError, 'a TypeError');
  assert.match(error.message, new RegExp(`^Invalid presentation: options\\.presentation\\.${component} returned Markdown that `));
  assert.match(error.message, rule);
  return true;
};

// ---------------------------------------------------------------------------
// Unit: enforcement

await loadMarkdownParser();

describe('present: the core\'s enforcement of a callback result', () => {
  const context = { markdown: 'BUILT-IN', required: ['KEEP'] } as const;

  test('without a callback the built-in Markdown is used', () => {
    assert.equal(present('finding', undefined, context), 'BUILT-IN');
  });

  test('a callback receives a frozen context with the built-in Markdown and required fragments, and its valid result is used', () => {
    let seen: unknown;
    const result = present('finding', (c) => {
      seen = c;
      return `> KEEP and more ${c.markdown}`;
    }, context);
    assert.equal(result, '> KEEP and more BUILT-IN');
    assert.ok(Object.isFrozen(seen));
    assert.deepEqual(seen, { markdown: 'BUILT-IN', required: ['KEEP'] });
  });

  const refusals: readonly (readonly [label: string, result: unknown, rule: RegExp])[] = [
    ['a non-string', 42, /is not a string \(it returned number\)/],
    ['null', null, /is not a string \(it returned null\)/],
    ['blank Markdown', ' \n\t', /is blank/],
    ['a dropped required fragment', 'something else', /omits a required fragment, which must appear verbatim: "KEEP"/],
    ['a forged suggestion block', 'KEEP\n\n```suggestion\nx\n```', /could open a suggestion block/],
    ['a suggestion opener inside a list or quote', 'KEEP\n\n> - ~~~~ Suggestion', /could open a suggestion block/],
    ['an unclosed fence that would swallow a following suggestion block', 'KEEP\n\n````', /leaves a code fence open/],
    ['an HTML comment block that would hide a following marker', 'KEEP\n\n<!-- hide the rest', /leaves an HTML <!-- construct open/],
    ['an unclosed element', '<details>KEEP', /leaves a <details> element open/],
    ['raw HTML the built-in Markdown does not carry', 'KEEP <kbd>x</kbd>', /adds raw HTML of its own \("<kbd>"\)/],
    ['a forged review marker', 'KEEP\n\n<!-- sarif-to-comment:review:00000000-0000-4000-8000-000000000000 -->', /reads as a publication or suggestion marker/],
    ['a forged suggestion marker', 'KEEP\n\n<!-- suggestion-pr {"version":1} -->', /reads as a publication or suggestion marker/],
  ];
  for (const [label, result, rule] of refusals) {
    test(`refuses ${label}`, () => {
      assert.throws(() => present('finding', () => result, context), refusedBy('finding', rule));
    });
  }

  test('an inline component (attribution) must stay on one line', () => {
    assert.throws(() => present('attribution', () => 'KEEP\nsecond line', context), refusedBy('attribution', /spans more than one line/));
    assert.equal(present('finding', () => 'KEEP\nsecond line', context), 'KEEP\nsecond line', 'a block component may span lines');
  });

  test('a callback\'s own exception propagates unchanged', () => {
    const failure = new RangeError('caller bug');
    assert.throws(() => present('finding', () => { throw failure; }, context), (error) => error === failure);
  });
});

describe('the presentation option value', () => {
  test('a plain object of known component callbacks, any omitted, is accepted', () => {
    assert.equal(presentationOptionProblem({}), null);
    assert.equal(presentationOptionProblem({ finding: () => 'x', lifecycleNote: undefined }), null);
    assert.equal(presentationOptionProblem(Object.assign(Object.create(null), { attribution: () => 'x' })), null);
  });

  test('anything else is refused, naming the problem, and a getter never runs', () => {
    let ran = false;
    const accessor = Object.defineProperty({}, 'finding', { enumerable: true, get: () => { ran = true; return () => 'x'; } });
    for (const [value, rule] of [
      [null, /must be an object/],
      [[() => 'x'], /must be an object/],
      [new Map([['finding', () => 'x']]), /must be a plain object/],
      [{ title: () => 'x' }, /unknown component title; the components are finding, attribution, alternatives, fileAddition, fileDeletion, manualEdit, lifecycleNote/],
      [{ finding: '**x**' }, /\.finding must be a function returning Markdown/],
      [accessor, /\.finding is an accessor property/],
    ] as const) {
      assert.match(presentationOptionProblem(value) ?? '', rule);
    }
    assert.equal(ran, false, 'the getter never ran');
  });

  test('capture snapshots the callbacks: replacing one on the caller\'s object later has no effect', () => {
    const callbacks: { finding: () => string } = { finding: () => 'first' };
    const captured = capturePresentation(callbacks, (message) => new TypeError(message));
    callbacks.finding = () => 'second';
    assert.equal(captured.finding?.({ markdown: '', required: [], message: '', attribution: '' }), 'first');
    assert.ok(Object.isFrozen(captured));
    assert.throws(() => capturePresentation({ finding: 1 }, (message) => new TypeError(`Invalid x input: ${message}`)),
      /^TypeError: Invalid x input: options\.presentation\.finding must be a function returning Markdown$/);
  });
});

// ---------------------------------------------------------------------------
// Preparation: every component customized

const LINT = { driver: { name: 'Lint', version: '1.2.3' }, extensions: [{ name: 'style-pack', version: '0.4' }] };

/** A general finding defined by an extension's rule, and a native suggestion with one alternative. */
const FINDINGS = log(run(LINT, [
  {
    ruleId: 'no-x',
    rule: { id: 'no-x', toolComponent: { index: 0 } },
    level: 'warning',
    message: { text: 'Second and third disagree.' },
    locations: [at('docs/notes.md', { startLine: 2, endLine: 3 }, 'Here.')],
  },
  {
    ruleId: 'case',
    level: 'error',
    message: { text: 'Use uppercase.' },
    locations: [at('src/app.js', { startLine: 2 })],
    fixes: [lineFix('src/app.js', 2, 'C', 'Uppercase it.'), lineFix('docs/notes.md', 1, 'First', 'Fix the notes too.')],
  },
]));

/** A caller's presentation: a compact finding, a prose attribution, and alternatives as a short numbered list. */
const COMPACT: IReviewPresentation = {
  attribution: (c: IAttributionPresentationContext) => `produced by ${c.required.join(' and ')}${c.ruleId === undefined ? '' : `, rule ${c.ruleId}`}`,
  finding: (c: IFindingPresentationContext) => [c.level === undefined ? '' : `[${c.level}]`, c.message, c.alternatives ?? '', `<sub>${c.attribution}</sub>`]
    .filter((part) => part !== '').join('\n\n'),
  alternatives: (c: IAlternativesPresentationContext) =>
    `**${String(c.alternatives.length)} other fix:**\n\n${c.alternatives.map((a) => `${String(a.number)}. ${a.description ?? ''}\n\n${a.changes}`).join('\n\n')}`,
};

describe('preparation with presentation callbacks', () => {
  test('a customized finding keeps the core\'s source link and quote in the body', async () => {
    const ready = await prepare(FINDINGS, { presentation: COMPACT });
    assert.equal(ready.review.body, [
      `**Source:** [docs/notes.md lines 2-3 at ${SHORT}](${permalink('docs/notes.md', '?plain=1#L2-L3')})`,
      '',
      '```',
      'second',
      'third',
      '```',
      '',
      '[warning]',
      '',
      'Second and third disagree.',
      '',
      '<sub>produced by Lint and style-pack, rule no-x</sub>',
    ].join('\n'));
  });

  test('a customized finding and alternatives keep the core\'s native suggestion block exactly, after them', async () => {
    const ready = await prepare(FINDINGS, { presentation: COMPACT });
    const [comment] = ready.review.comments;
    assert.ok(comment);
    assert.equal(comment.body, [
      '[error]',
      '',
      'Use uppercase.',
      '',
      '**1 other fix:**',
      '',
      '1. Fix the notes too.',
      '',
      'Replace line 1 of `docs/notes.md` with:',
      '',
      '```',
      'First',
      '```',
      '',
      '<sub>produced by Lint, rule case</sub>',
      '',
      '```suggestion',
      'C',
      '```',
    ].join('\n'));
  });

  test('every context carries the element\'s data, its built-in Markdown and its required fragments', async () => {
    const seen: Record<string, unknown[]> = { finding: [], attribution: [], alternatives: [] };
    const record = (name: string) => (c: { readonly markdown: string }): string => {
      seen[name]?.push(c);
      return c.markdown;
    };
    const ready = await prepare(FINDINGS, { presentation: { finding: record('finding'), attribution: record('attribution'), alternatives: record('alternatives') } });
    assert.equal(ready.review.comments[0]?.body.endsWith('```suggestion\nC\n```'), true, 'returning the built-in Markdown keeps the default');
    assert.deepEqual(seen['attribution'], [
      { tool: 'Lint', version: '1.2.3', component: { name: 'style-pack', version: '0.4' }, ruleId: 'no-x', markdown: 'Lint 1.2.3 · style-pack 0.4 · rule `no-x`', required: ['Lint', 'style-pack'] },
      { tool: 'Lint', version: '1.2.3', ruleId: 'case', markdown: 'Lint 1.2.3 · rule `case`', required: ['Lint'] },
    ]);
    const changes = 'Replace line 1 of `docs/notes.md` with:\n\n```\nFirst\n```';
    const alternatives = `**Alternatives to consider:**\n\n(1) Fix the notes too.\n\n${changes}`;
    assert.deepEqual(seen['alternatives'], [{
      alternatives: [{ number: 1, description: 'Fix the notes too.', changes, markdown: `(1) Fix the notes too.\n\n${changes}` }],
      markdown: alternatives,
      required: [changes],
    }]);
    assert.deepEqual(seen['finding']?.[1], {
      level: 'error',
      message: 'Use uppercase.',
      fixDescription: 'Uppercase it.',
      alternatives,
      attribution: 'Lint 1.2.3 · rule `case`',
      markdown: `**Level:** error\n\nUse uppercase.\n\n**Fix:** Uppercase it.\n\n${alternatives}\n\n<sub>— Lint 1.2.3 · rule \`case\`</sub>`,
      required: ['Lint 1.2.3 · rule `case`', alternatives],
    });
  });

  test('a context is a deeply frozen copy: nested component and alternatives cannot be changed', async () => {
    const frozen: boolean[] = [];
    const ready = await prepare(FINDINGS, {
      presentation: {
        attribution: (c: IAttributionPresentationContext) => {
          if (c.component !== undefined) {
            frozen.push(Object.isFrozen(c.component));
            assert.equal(Reflect.set(c.component, 'name', 'someone else'), false, 'a frozen object refuses the write');
          }
          return c.markdown;
        },
        alternatives: (c: IAlternativesPresentationContext) => {
          frozen.push(Object.isFrozen(c.alternatives), ...c.alternatives.map((a) => Object.isFrozen(a)));
          return c.markdown;
        },
      },
    });
    assert.deepEqual(frozen, [true, true, true]);
    assert.match(ready.review.body, /style-pack 0\.4/, 'the attribution still names the real component');
  });

  const T = { driver: { name: 'T' } };
  const PROPOSALS = log(run(T, [
    carrying('Document the new option.', [{ operation: 'create', artifactIndex: 0 }], at('docs/guide.md', { startLine: 1 })),
    carrying('This module is obsolete.', [{ operation: 'delete', artifactIndex: 1 }], at('obsolete.txt', { startLine: 2 })),
  ], [
    { location: { uri: 'docs/guide.md' }, contents: { text: '# Guide\n\nUse `x`.\n' }, encoding: 'utf-8' },
    { location: { uri: 'obsolete.txt' } },
  ]));

  test('customized file addition and deletion keep the exact content, details, permalink and findings', async () => {
    const additions: IFileAdditionPresentationContext[] = [];
    const deletions: IFileDeletionPresentationContext[] = [];
    const ready = await prepare(PROPOSALS, {
      presentation: {
        fileAddition: (c: IFileAdditionPresentationContext) => {
          additions.push(c);
          return c.markdown.replace('**Proposed new file:**', '### New file');
        },
        fileDeletion: (c: IFileDeletionPresentationContext) => {
          deletions.push(c);
          return `### Delete [${c.path}](${c.url})\n\n${c.findings}`;
        },
      },
    });
    const addition = [
      '### New file `docs/guide.md`',
      '',
      '**File details:** 18 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
      '',
      '```',
      '# Guide',
      '',
      'Use `x`.',
      '```',
      '',
      '**Location:** line 1 of the proposed file',
      '',
      'Document the new option.',
      '',
      '<sub>— T</sub>',
    ].join('\n');
    const deletionFindings = [
      `**Source:** [obsolete.txt line 2 at ${SHORT}](${permalink('obsolete.txt', '?plain=1#L2')})`,
      '',
      '```',
      'second line',
      '```',
      '',
      'This module is obsolete.',
      '',
      '<sub>— T</sub>',
    ].join('\n');
    assert.equal(ready.review.body, `${addition}\n\n---\n\n### Delete [obsolete.txt](${permalink('obsolete.txt')})\n\n${deletionFindings}`);
    const [added] = additions;
    assert.ok(added);
    assert.deepEqual(
      { path: added.path, fileMode: added.fileMode, byteLength: added.byteLength, details: added.details, content: added.content },
      { path: 'docs/guide.md', fileMode: '100644', byteLength: 18, details: '18 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644', content: '```\n# Guide\n\nUse `x`.\n```' },
    );
    assert.deepEqual(added.required, ['`docs/guide.md`', added.details, added.content, added.findings]);
    assert.deepEqual(deletions.map((d) => ({ path: d.path, commit: d.commit, url: d.url, required: d.required })),
      [{ path: 'obsolete.txt', commit: R, url: permalink('obsolete.txt'), required: [permalink('obsolete.txt'), deletionFindings] }]);
  });

  test('a file addition that hides the proposed content is refused', async () => {
    await assert.rejects(prepareOutcome(PROPOSALS, {
      presentation: { fileAddition: (c: IFileAdditionPresentationContext) => c.markdown.replace(c.content ?? '', '(content omitted)') },
    }), refusedBy('fileAddition', /omits a required fragment, which must appear verbatim: "```\\n# Guide/));
  });

  test('a file deletion that drops its source association (the permalink) is refused', async () => {
    const unlocated = log(run(T, [carrying('Remove it.', [{ operation: 'delete', artifactIndex: 0 }])], [{ location: { uri: 'obsolete.txt' } }]));
    await assert.rejects(prepareOutcome(unlocated, {
      presentation: { fileDeletion: (c: IFileDeletionPresentationContext) => `Delete ${c.path}.\n\n${c.findings}` },
    }), refusedBy('fileDeletion', /omits a required fragment/));
  });

  test('regression: a file addition that shows its path only inside a finding is refused (each required fragment counts once)', async () => {
    const creation = { ...carrying('x', [{ operation: 'create', artifactIndex: 0 }], at('docs/guide.md', { startLine: 1 })), message: { text: 'Add docs/guide.md.', markdown: 'Add `docs/guide.md`.' } };
    const sarif = log(run(T, [creation], [{ location: { uri: 'docs/guide.md' }, contents: { text: '# Guide\n' }, encoding: 'utf-8' }]));
    await prepare(sarif, { presentation: { fileAddition: (c: IFileAdditionPresentationContext) => c.markdown } });
    await assert.rejects(prepareOutcome(sarif, {
      presentation: { fileAddition: (c: IFileAdditionPresentationContext) => c.markdown.replace('**Proposed new file:** `docs/guide.md`', '**Proposed new file**') },
    }), refusedBy('fileAddition', /shows a required fragment only inside another required fragment, but each must be shown on its own: "`docs\/guide\.md`"/));
  });

  test('regression: a file deletion that links its text to another destination is refused, even with its permalink shown', async () => {
    const unlocated = log(run(T, [carrying('Remove it.', [{ operation: 'delete', artifactIndex: 0 }])], [{ location: { uri: 'obsolete.txt' } }]));
    await assert.rejects(prepareOutcome(unlocated, {
      presentation: { fileDeletion: (c: IFileDeletionPresentationContext) => `### Delete [obsolete.txt at ${SHORT}](https://evil.example/)\n\n<${c.url}>\n\n${c.findings}` },
    }), refusedBy('fileDeletion', /links the text "obsolete\.txt at 2222222" to "https:\/\/evil\.example\/" rather than its permalink/));
  });

  test('regression: a file deletion that spoofs its link text with a zero-width space is refused', async () => {
    const unlocated = log(run(T, [carrying('Remove it.', [{ operation: 'delete', artifactIndex: 0 }])], [{ location: { uri: 'obsolete.txt' } }]));
    await assert.rejects(prepareOutcome(unlocated, {
      presentation: { fileDeletion: (c: IFileDeletionPresentationContext) => `### Delete [obsolete.txt at 222​2222](https://evil.example/)\n\n<${c.url}>\n\n${c.findings}` },
    }), refusedBy('fileDeletion', /contains U\+200B, an invisible character, outside the content it presents/));
  });

  test('regression: a file deletion that points the text of a finding\'s source link elsewhere is refused', async () => {
    await assert.rejects(prepareOutcome(PROPOSALS, {
      presentation: { fileDeletion: (c: IFileDeletionPresentationContext) => `${c.markdown}\n\nSee [obsolete.txt line 2 at ${SHORT}](https://evil.example/).` },
    }), refusedBy('fileDeletion', /links the text "obsolete\.txt line 2 at 2222222" to "https:\/\/evil\.example\/" rather than its permalink/));
  });

  test('regression: a finding that points the text of the source link before it elsewhere is refused', async () => {
    await assert.rejects(prepareOutcome(FINDINGS, {
      presentation: { finding: (c: IFindingPresentationContext) => `${c.markdown}\n\nSee [docs/notes.md lines 2-3 at ${SHORT}](https://evil.example/)` },
    }), refusedBy('finding', /links the text "docs\/notes\.md lines 2-3 at 2222222" to "https:\/\/evil\.example\/" rather than its permalink/));
  });

  test('no false refusal: a finding may present a producer message holding a no-break space, and add a link of its own', async () => {
    const sarif = log(run(T, [{ message: { text: 'Use this.' }, locations: [at('docs/notes.md', { startLine: 2 })] }]));
    const ready = await prepare(sarif, { presentation: { finding: (c: IFindingPresentationContext) => `> ${c.message}\n\n[More](https://example.com/more)\n\n${c.attribution}` } });
    assert.ok(ready.review.body.includes('> Use this.'), ready.review.body);
  });

  test('an attribution that drops the producer is refused', async () => {
    await assert.rejects(prepareOutcome(FINDINGS, { presentation: { attribution: () => 'a helpful bot' } }),
      refusedBy('attribution', /omits a required fragment, which must appear verbatim: "Lint"/));
  });

  test('a finding that drops its attribution is refused', async () => {
    await assert.rejects(prepareOutcome(FINDINGS, { presentation: { finding: (c: IFindingPresentationContext) => c.message } }),
      refusedBy('finding', /omits a required fragment, which must appear verbatim: "Lint 1\.2\.3 · style-pack 0\.4 · rule `no-x`"/));
  });

  test('alternatives that drop one alternative\'s exact changes are refused', async () => {
    await assert.rejects(prepareOutcome(FINDINGS, { presentation: { alternatives: () => 'There are other fixes.' } }),
      refusedBy('alternatives', /omits a required fragment/));
  });

  test('a finding that would swallow the suggestion block with an unclosed fence is refused', async () => {
    await assert.rejects(prepareOutcome(FINDINGS, { presentation: { finding: (c: IFindingPresentationContext) => `${c.markdown}\n\n~~~` } }),
      refusedBy('finding', /leaves a code fence open/));
  });

  test('a finding that forges its own suggestion block is refused', async () => {
    await assert.rejects(prepareOutcome(FINDINGS, { presentation: { finding: (c: IFindingPresentationContext) => `${c.markdown}\n\n\`\`\`suggestion\nevil\n\`\`\`` } }),
      refusedBy('finding', /could open a suggestion block/));
  });

  test('size limits count the customized Markdown: nothing is truncated', async () => {
    const outcome = await prepareOutcome(FINDINGS, {
      maxCommentBodyChars: 1000,
      presentation: { finding: (c: IFindingPresentationContext) => `${c.markdown}\n\n${'padding '.repeat(200)}` },
    });
    assert.equal(outcome.status, 'blocked');
    assert.deepEqual(outcome.diagnostics.map((d) => d.code), ['comment-too-large', 'body-too-large']);
  });
});

// ---------------------------------------------------------------------------
// Integration: publish and validate through the real client and the fake host

/** The caller's lifecycle note and finding for a companion suggestion pull request. */
const COMPANION_PRESENTATION: IReviewPresentation = {
  lifecycleNote: (c: ILifecycleNotePresentationContext) => `**Accepting:** a ${c.ready ? 'ready' : 'draft'} proposal into \`${c.headRef}\` for #${String(c.pullNumber)}.`,
  finding: (c: IFindingPresentationContext) => `${c.message} (${c.attribution})`,
};

const GUIDE_CHANGE = '- New file `docs/guide.md`: 25 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644';
const GUIDE_ITEMS = '**Location:** line 1 of the proposed file\n\nAdd a guide. (Review bot 1.0.0)';

/** Every write the host received (POST, PATCH or PUT), other than GraphQL reads. */
const writes = (world: IHostWorld): string[] => world.host.log().filter((r) => r.method !== 'GET' && r.path !== '/graphql').map((r) => `${r.method} ${r.path}`);

describe('publication with presentation callbacks (fake GitHub host)', () => {
  test('a companion suggestion pull request carries the customized lifecycle note and findings, and keeps its marker', async () => {
    const world = hostWorld();
    const outcome = await publish(world, GUIDE_DOCUMENT, { delivery: { groupedEdits: ['companion'], fileOperations: ['companion', 'manual'] }, presentation: COMPANION_PRESENTATION });
    assert.equal(outcome.status, 'published', outcome.markdown);
    const [pull] = world.host.pulls();
    assert.ok(pull);
    const marker = SUGGESTION_MARKER.exec(pull.body);
    assert.ok(marker, 'the body still ends with the structured marker');
    assert.equal(pull.body, [
      `Suggested in a review of #7 at commit ${HEAD}.`,
      '',
      'Merging this pull request into `feature/retry` applies this change:',
      '',
      GUIDE_CHANGE,
      '',
      '**Accepting:** a draft proposal into `feature/retry` for #7.',
      '',
      '---',
      '',
      GUIDE_ITEMS,
      '',
      marker[1],
    ].join('\n'));
    const number = String(pull.number);
    assert.equal(reviewBodyWithoutMarker(world), [
      `**Suggestion pull request:** [#${number}](https://github.com/octo/widgets/pull/${number})`,
      '',
      'Merging it into `feature/retry` applies this change:',
      '',
      GUIDE_CHANGE,
      '',
      GUIDE_ITEMS,
    ].join('\n'));
  });

  test('a plain review keeps its publication marker after customized findings', async () => {
    const world = hostWorld();
    const sarif = hostDocument([{ message: { text: 'Docs need an index.' }, locations: [at('docs/index.md', { startLine: 1 })] }]);
    const outcome = await publish(world, sarif, { presentation: COMPANION_PRESENTATION });
    assert.equal(outcome.status, 'published', outcome.markdown);
    assert.equal(reviewBodyWithoutMarker(world), [
      `**Source:** [docs/index.md line 1 at feedfee](https://github.com/octo/widgets/blob/${HEAD}/docs/index.md?plain=1#L1)`,
      '',
      '```',
      '# Docs',
      '```',
      '',
      'Docs need an index. (Review bot 1.0.0)',
    ].join('\n'));
  });

  test('validate assesses the review with the same callbacks', async () => {
    const world = hostWorld();
    const ready = await validate(world, GUIDE_DOCUMENT, { delivery: { groupedEdits: ['companion'], fileOperations: ['companion', 'manual'] }, presentation: COMPANION_PRESENTATION });
    assert.equal(ready.status, 'ready', ready.markdown);
    await assert.rejects(validate(world, GUIDE_DOCUMENT, { delivery: { groupedEdits: ['companion'], fileOperations: ['companion', 'manual'] }, presentation: { lifecycleNote: () => '' } }),
      refusedBy('lifecycleNote', /is blank/));
    assert.deepEqual(writes(world), [], 'validation never writes');
  });

  const hostile: readonly (readonly [label: string, presentation: IReviewPresentation, component: string, rule: RegExp])[] = [
    ['a lifecycle note that would comment out the suggestion marker', { lifecycleNote: () => 'Accept it.\n\n<!--' }, 'lifecycleNote', /leaves an HTML <!-- construct open/],
    ['a lifecycle note that forges a second suggestion marker',
      { lifecycleNote: () => '<!-- suggestion-pr {"version":1,"original":{"owner":"octo","repo":"widgets","pullNumber":7}} -->' }, 'lifecycleNote', /reads as a publication or suggestion marker/],
    ['a finding that opens a fence to swallow what follows', { finding: (c: IFindingPresentationContext) => `${c.attribution}\n\n\`\`\`\`` }, 'finding', /leaves a code fence open/],
  ];
  for (const [label, presentation, component, rule] of hostile) {
    test(`refuses ${label}: the call rejects and nothing is written to GitHub or to the state path`, async () => {
      const world = hostWorld();
      await assert.rejects(publish(world, GUIDE_DOCUMENT, { delivery: { groupedEdits: ['companion'], fileOperations: ['companion', 'manual'] }, presentation }), refusedBy(component, rule));
      assert.deepEqual(writes(world), []);
      assert.equal(world.host.pulls().length, 0);
      assert.equal(world.host.reviews().length, 0);
      assert.equal(fs.existsSync(world.statePath), false, 'no publication state was written');
    });
  }

  test('an invalid presentation option is refused as input, before any request', async () => {
    const world = hostWorld();
    let ran = false;
    const accessor = Object.defineProperty({}, 'finding', { enumerable: true, get: () => { ran = true; return () => 'x'; } });
    for (const [presentation, rule] of [
      ['**x**', /^Invalid publishSarifReview input: options\.presentation must be an object of presentation callbacks$/],
      [{ header: () => 'x' }, /^Invalid publishSarifReview input: options\.presentation has an unknown component header;/],
      [{ finding: '**x**' }, /^Invalid publishSarifReview input: options\.presentation\.finding must be a function returning Markdown$/],
      [accessor, /^Invalid publishSarifReview input: options\.presentation\.finding is an accessor property/],
    ] as const) {
      await assert.rejects(publish(world, GUIDE_DOCUMENT, { presentation }), (error: unknown) => error instanceof TypeError && rule.test(error.message));
    }
    const options = Object.defineProperty({}, 'presentation', { enumerable: true, get: () => { ran = true; return {}; } });
    await assert.rejects(publish(world, GUIDE_DOCUMENT, options), /^TypeError: Invalid publishSarifReview input: options\.presentation is an accessor property/);
    assert.equal(ran, false, 'no getter ran');
    assert.deepEqual(world.host.log(), [], 'nothing was requested');
  });

  test('the other options are still captured as JSON next to the callbacks', async () => {
    const world = hostWorld();
    await assert.rejects(publish(world, GUIDE_DOCUMENT, { presentation: {}, submit: 'yes' }), /options\.submit must be a boolean/);
    await assert.rejects(publish(world, GUIDE_DOCUMENT, { presentation: {}, colour: true }), /unknown option colour/);
    const sarif: Json = GUIDE_DOCUMENT;
    const outcome = await publish(world, sarif, { presentation: {}, submit: true });
    assert.equal(outcome.status, 'published', outcome.markdown);
    assert.equal(world.host.reviews()[0]?.request.event, 'COMMENT');
  });
});
