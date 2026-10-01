/**
 * Byte-exact pins of every review presentation the tool renders today: a
 * finding's general-body section with its quoted source, its attribution
 * (tool, extension component and rule), an inline finding, a native
 * suggestion comment with its fix description and listed alternatives,
 * whole-file creation and deletion sections, the review body with its hidden
 * publication marker, a companion suggestion pull request's reference in
 * the review together with its own body and lifecycle note (draft and ready),
 * and the reports around them: preparation's warnings list, the warnings a
 * publication reports on its first and every later call (issue #42), and the
 * refusal of a change shared with a suggestion group.
 *
 * These tests guard the refactoring of the renderers into presentation
 * components: they exercise only stable boundaries (whole-review preparation,
 * and publication through the real GitHub client against the fake HTTP host),
 * so they hold unchanged before and after the extraction. Every expected
 * string is written by hand from the contract it cites, never captured from
 * program output; the only values read back are the random publication and
 * suggestion ids and the host's pull request number.
 *
 * @see ../docs/file-operation-publication-contract.md (§2 presentation, §4 worked examples)
 * @see ../docs/companion-suggestion-pr-contract.md (§2.7 marker, §2.11 presentation)
 * @see ../docs/suggestion-pr-convention.md (§7 marker, §8 lifecycle)
 * @see ../docs/diagnostics.md ("Headline", "Warnings on every call for a publication", the catalog)
 * @see https://github.com/mike-north/sarif-to-comment/issues/42
 * @see ../src/prepare-review.cts (the rendering grammar in the module documentation)
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 * @see https://github.github.com/gfm/#fenced-code-blocks
 * @see https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  GUIDE_DOCUMENT, HEAD, SEP, SHORT, SUGGESTION_MARKER,
  at, carrying, hostDocument, hostWorld, lineFix, log, permalink, prepare, prepareOutcome, publish, reviewBodyWithoutMarker, run,
} from './support/presentation-fixtures.mts';
import { asRecord, asString, parseJson } from './support/runtime-types.mts';

const LINT = { driver: { name: 'Lint', version: '1.2.3' }, extensions: [{ name: 'style-pack', version: '0.4' }] };

/** One run holding a general finding, an inline finding and a suggestion with alternatives. */
const FINDINGS = log(run(LINT, [
  {
    ruleId: 'no-x',
    rule: { id: 'no-x', toolComponent: { index: 0 } },
    level: 'warning',
    kind: 'fail',
    baselineState: 'new',
    message: { text: 'Second and third disagree.' },
    locations: [at('docs/notes.md', { startLine: 2, endLine: 3 }, 'Here.')],
  },
  {
    message: { text: 'Inline note.' },
    locations: [at('src/app.js', { startLine: 2 })],
  },
  {
    ruleId: 'case',
    level: 'error',
    message: { text: 'Use uppercase.' },
    locations: [at('src/app.js', { startLine: 2 })],
    fixes: [
      lineFix('src/app.js', 2, 'C', 'Uppercase it.'),
      lineFix('src/app.js', 2, 'c ``` c', 'Double it.'),
      lineFix('docs/notes.md', 1, 'First', 'Fix the notes too.'),
      {
        description: { text: 'Change both.' },
        artifactChanges: [
          { artifactLocation: { uri: 'src/app.js' }, replacements: [{ deletedRegion: { startLine: 1 }, insertedContent: { text: 'A' } }] },
          { artifactLocation: { uri: 'docs/notes.md' }, replacements: [{ deletedRegion: { startLine: 3 }, insertedContent: { text: 'Third' } }] },
        ],
      },
    ],
  },
]));

describe('golden presentation: findings, attribution, suggestions and alternatives', () => {
  test('a general finding: source link, quoted lines, status, location message and full attribution', async () => {
    const ready = await prepare(FINDINGS);
    // Rendering grammar `section`: "**Source:** [PATH lines A-B at SHORT](PERMALINK#LA-LB)",
    // a fence of the quoted lines, then the item: status (Level · Kind ·
    // Baseline, SARIF 3.27.10/3.27.9/3.27.24), message, "**At this
    // location:**", and the attribution "tool version · extension version ·
    // rule `id`" (SARIF 3.19, 3.27.5).
    assert.equal(ready.review.body, [
      `**Source:** [docs/notes.md lines 2-3 at ${SHORT}](${permalink('docs/notes.md', '#L2-L3')})`,
      '',
      '```',
      'second',
      'third',
      '```',
      '',
      '**Level:** warning · **Kind:** fail · **Baseline:** new',
      '',
      'Second and third disagree.',
      '',
      '**At this location:** Here.',
      '',
      '<sub>— Lint 1.2.3 · style-pack 0.4 · rule `no-x`</sub>',
    ].join('\n'));
  });

  test('an inline finding: the item alone, attributed to the driver', async () => {
    const ready = await prepare(FINDINGS);
    const [inline] = ready.review.comments;
    assert.ok(inline);
    assert.deepEqual([inline.path, inline.side, inline.line], ['src/app.js', 'RIGHT', 2]);
    assert.equal(inline.body, 'Inline note.\n\n<sub>— Lint 1.2.3</sub>');
  });

  test('a native suggestion: fix description, alternatives in the producer\'s order, attribution, then the suggestion block', async () => {
    const ready = await prepare(FINDINGS);
    const suggestion = ready.review.comments[1];
    assert.ok(suggestion);
    assert.deepEqual([suggestion.path, suggestion.side, suggestion.line], ['src/app.js', 'RIGHT', 2]);
    // Rendering grammar `item` and `alternative`: alternatives are numbered
    // from 1; one on the first fix's file names only its lines, one on another
    // file names the file; each fence is one longer than the longest backtick
    // run inside and at least three (GFM fenced code blocks). The comment
    // ends with the validated suggestion block of the first fix's payload.
    assert.equal(suggestion.body, [
      '**Level:** error',
      '',
      'Use uppercase.',
      '',
      '**Fix:** Uppercase it.',
      '',
      '**Alternatives to consider:**',
      '',
      '(1) Double it.',
      '',
      'Replace line 2 with:',
      '',
      '````',
      'c ``` c',
      '````',
      '',
      '(2) Fix the notes too.',
      '',
      'Replace line 1 of `docs/notes.md` with:',
      '',
      '```',
      'First',
      '```',
      '',
      // `parts`: a several-file alternative labels each change with its file.
      '(3) Change both.',
      '',
      'Changes 2 files together:',
      '',
      '`src/app.js` — replace line 1 with:',
      '',
      '```',
      'A',
      '```',
      '',
      '`docs/notes.md` — replace line 3 with:',
      '',
      '```',
      'Third',
      '```',
      '',
      '<sub>— Lint 1.2.3 · rule `case`</sub>',
      '',
      '```suggestion',
      'C',
      '```',
    ].join('\n'));
  });
});

describe('golden presentation: whole-file proposals', () => {
  const T = { driver: { name: 'T' } };

  test('creations: the contract\'s worked example, an empty file and an executable without a final newline', async () => {
    const sarif = log(run(T, [
      carrying('Document the new option.', [{ operation: 'create', artifactIndex: 0 }], at('docs/guide.md', { startLine: 1 })),
      carrying('Keep the guide short.', [{ operation: 'create', artifactIndex: 0 }]),
      carrying('Add a placeholder.', [{ operation: 'create', artifactIndex: 1 }]),
      carrying('Add the tool.', [{ operation: 'create', artifactIndex: 2, fileMode: '100755' }]),
    ], [
      { location: { uri: 'docs/guide.md' }, contents: { text: '# Guide\n\nUse `x`.\n' }, encoding: 'utf-8' },
      { location: { uri: 'empty.txt' }, contents: { text: '' }, encoding: 'utf-8' },
      { location: { uri: 'bin/tool.sh' }, contents: { text: '#!/bin/sh\necho hi' }, encoding: 'utf-8' },
    ]));
    const ready = await prepare(sarif);
    assert.equal(ready.review.comments.length, 0);
    // File-operation contract §4 example 1, verbatim; a second finding on the
    // same proposal joins its section without a location line (§2 ITEMS).
    const guide = [
      '**Proposed new file:** `docs/guide.md`',
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
      '',
      '---',
      '',
      'Keep the guide short.',
      '',
      '<sub>— T</sub>',
    ].join('\n');
    // §2 "Content and facts": the empty file has no block.
    const empty = '**Proposed new file:** `empty.txt`\n\n**File details:** empty file (0 bytes) · mode 100644\n\nAdd a placeholder.\n\n<sub>— T</sub>';
    // §2 facts 1, 3, 4 and 5: 17 bytes ("#!/bin/sh" 9 + LF 1 + "echo hi" 7).
    const tool = [
      '**Proposed new file:** `bin/tool.sh`',
      '',
      '**File details:** 17 bytes of UTF-8 text · LF line endings · no newline at end of file · mode 100755 (executable)',
      '',
      '```',
      '#!/bin/sh',
      'echo hi',
      '```',
      '',
      'Add the tool.',
      '',
      '<sub>— T</sub>',
    ].join('\n');
    assert.equal(ready.review.body, [guide, empty, tool].join(SEP));
  });

  test('deletions: the whole-file statement, a quoted finding line, and a percent-encoded permalink', async () => {
    const sarif = log(run(T, [
      carrying('This module is obsolete.', [{ operation: 'delete', artifactIndex: 0 }], at('obsolete.txt', { startLine: 2 })),
      carrying('Remove it.', [{ operation: 'delete', artifactIndex: 1 }]),
    ], [{ location: { uri: 'obsolete.txt' } }, { location: { uri: 'odd%20dir/a(1).txt' } }]));
    const ready = await prepare(sarif);
    // File-operation contract §2: the deletion section, its finding quoted as
    // general feedback; PERMALINK percent-encodes each segment including
    // "(" and ")" and keeps "/".
    const obsolete = [
      `**Proposed file deletion:** [obsolete.txt at ${SHORT}](${permalink('obsolete.txt')})`,
      '',
      'The whole file is removed; this is not a proposal to empty it.',
      '',
      `**Source:** [obsolete.txt line 2 at ${SHORT}](${permalink('obsolete.txt', '#L2')})`,
      '',
      '```',
      'second line',
      '```',
      '',
      'This module is obsolete.',
      '',
      '<sub>— T</sub>',
    ].join('\n');
    const odd = [
      `**Proposed file deletion:** [odd dir/a(1).txt at ${SHORT}](${permalink('odd%20dir/a%281%29.txt')})`,
      '',
      'The whole file is removed; this is not a proposal to empty it.',
      '',
      'Remove it.',
      '',
      '<sub>— T</sub>',
    ].join('\n');
    assert.equal(ready.review.body, [obsolete, odd].join(SEP));
  });
});

// ---------------------------------------------------------------------------
// Publication boundary: the real client against the fake HTTP host

/** Companion contract §2.11, change list: a creation names its path and its file-operation facts. */
const GUIDE_CHANGE = '- New file `docs/guide.md`: 25 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644';
/** §2.11 ITEMS: a located finding on a created file follows its location line. */
const GUIDE_ITEMS = '**Location:** line 1 of the proposed file\n\nAdd a guide.\n\n<sub>— Review bot 1.0.0</sub>';

/** The draft and ready lifecycle notes of companion contract §2.11, verbatim. */
const DRAFT_NOTE = '**How this suggestion is accepted:** it is a draft pull request into `feature/retry`, the branch of #7. A draft cannot be merged: someone with write access first marks it ready for review. The author of #7 then decides whether to merge it, and #7 carries the change to its base. Once #7 is merged or closed, this pull request can be closed.';
const READY_NOTE = '**How this suggestion is accepted:** it is a pull request into `feature/retry`, the branch of #7. The author of #7 decides whether to merge it, and #7 carries the change to its base. Once #7 is merged or closed, this pull request can be closed.';

describe('golden presentation: the published review and its companions', () => {
  test('the review body is the prepared body, a blank line and exactly one hidden publication marker', async () => {
    const world = hostWorld();
    const outcome = await publish(world, hostDocument([{ message: { text: 'Docs need an index.' }, locations: [at('docs/index.md', { startLine: 1 })] }]));
    assert.equal(outcome.status, 'published', outcome.markdown);
    const body = world.host.reviews()[0]?.request.body ?? '';
    assert.equal(body.split('<!-- sarif-to-comment:review:').length, 2, 'exactly one marker');
    assert.equal(reviewBodyWithoutMarker(world), [
      `**Source:** [docs/index.md line 1 at feedfee](https://github.com/octo/widgets/blob/${HEAD}/docs/index.md#L1)`,
      '',
      '```',
      '# Docs',
      '```',
      '',
      'Docs need an index.',
      '',
      '<sub>— Review bot 1.0.0</sub>',
    ].join('\n'));
  });

  for (const [mode, options, note, draft] of [
    ['draft', { allowSuggestionPullRequests: true }, DRAFT_NOTE, true],
    ['ready', { allowSuggestionPullRequests: true, markSuggestionPullRequestsReady: true }, READY_NOTE, false],
  ] as const) {
    test(`a ${mode} companion: its body (reference, change list, lifecycle note, findings, marker) and the review's companion reference`, async () => {
      const world = hostWorld();
      const outcome = await publish(world, GUIDE_DOCUMENT, options);
      assert.equal(outcome.status, 'published', outcome.markdown);
      const [pull] = world.host.pulls();
      assert.ok(pull);
      assert.equal(pull.draft, draft);
      assert.equal(pull.title, 'Suggestion for #7: create docs/guide.md');
      const marker = SUGGESTION_MARKER.exec(pull.body);
      assert.ok(marker, 'the body ends with the structured marker');
      const fields = asRecord(parseJson(marker[2] ?? ''), 'the marker JSON');
      // Convention §7: the canonical marker line, exactly these members in this order.
      assert.equal(marker[1], `<!-- suggestion-pr {"version":1,"original":{"owner":"octo","repo":"widgets","pullNumber":7},"reviewedCommit":"${HEAD}",`
        + `"id":"${asString(fields['id'])}","batch":"${asString(fields['batch'])}"} -->`);
      // Companion contract §2.11, suggestion pull request body.
      assert.equal(pull.body, [
        `Suggested in a review of #7 at commit ${HEAD}.`,
        '',
        'Merging this pull request into `feature/retry` applies this change:',
        '',
        GUIDE_CHANGE,
        '',
        note,
        '',
        '---',
        '',
        GUIDE_ITEMS,
        '',
        marker[1],
      ].join('\n'));
      // Companion contract §2.11, review body: the companion reference section.
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
  }
});

// ---------------------------------------------------------------------------
// Reports: preparation's warnings, publication warnings on every call, and a
// change shared with a suggestion group (issue #42)

/**
 * diagnostics.md catalog: `taxa-uninterpreted` (warning), "Taxonomy
 * classifications are not shown"; a result's taxa are retained in evidence
 * but not rendered in the review.
 */
const TAXA_LINE = '- `taxa-uninterpreted` at `/runs/0/results/0`: Taxonomy classifications are retained in evidence but not rendered in the review.';

/** One inline finding on the changed README line, with a taxonomy reference the review does not show. */
const TAXA_DOCUMENT = hostDocument([{
  message: { text: 'Explain more.' },
  locations: [at('README.md', { startLine: 2 })],
  taxa: [{ id: 'CWE-1059' }],
}]);

describe('golden presentation: warnings and refusals in the reports', () => {
  test('a prepared review states its size, then lists each warning with its code, pointer and message', async () => {
    const sarif = log(run({ driver: { name: 'T' } }, [{ message: { text: 'Note.' }, locations: [at('src/app.js', { startLine: 2 })], taxa: [{ id: 'CWE-1059' }] }]));
    const ready = await prepare(sarif);
    // The prepared summary, then diagnostics.md's "**Warnings:**" list:
    // "- `CODE` at `POINTER`: MESSAGE" per warning.
    assert.equal(ready.markdown, [
      `**Review prepared:** 1 inline comment(s) and 0 general section(s) for commit \`${'2'.repeat(40)}\`.`,
      '',
      '**Warnings:**',
      '',
      TAXA_LINE,
    ].join('\n'));
  });

  test('a published outcome with warnings: the headline under the heading, the warnings list last, no prepared summary; a retry says the same', async () => {
    const world = hostWorld();
    const first = await publish(world, TAXA_DOCUMENT);
    assert.equal(first.status, 'published', first.markdown);
    const link = `[review ${String(first.review.id)}](${first.review.url})`;
    const where = `octo/widgets#7 at commit \`${HEAD}\``;
    // diagnostics.md "Headline": "**Published with N warning(s):**", then a
    // sentence per code — for an ordinary code, its catalog title.
    const headline = '**Published with 1 warning:** Taxonomy classifications are not shown.';
    assert.equal(first.markdown, [
      '## Draft review published',
      '',
      headline,
      '',
      `Created the draft ${link} on ${where}. It stays a draft until someone submits it on GitHub.`,
      '',
      '**Warnings:**',
      '',
      TAXA_LINE,
    ].join('\n'));
    assert.ok(!first.markdown.includes('**Review prepared:**'), 'the prepared summary is not part of a published outcome');
    // "Warnings on every call for a publication": a retry that finds the
    // completion recorded reports them again, identically.
    const retry = await publish(world, TAXA_DOCUMENT);
    assert.equal(retry.status, 'published', retry.markdown);
    assert.equal(retry.markdown, [
      '## Draft review published',
      '',
      headline,
      '',
      `The draft ${link} on ${where} was already published; its completion is recorded at \`${world.statePath}\`. Nothing was sent.`,
      '',
      '**Warnings:**',
      '',
      TAXA_LINE,
    ].join('\n'));
    assert.deepEqual(retry.diagnostics, first.diagnostics);
  });

  /** A group of two edits, and a third result outside it that carries the group's first edit too. */
  const shared = (secondGroup: string | undefined): Record<string, unknown> => {
    const member = (text: string, uri: string, line: number, replacement: string, group: string | undefined): Record<string, unknown> => ({
      message: { text },
      locations: [at(uri, { startLine: line })],
      fixes: [lineFix(uri, line, replacement, text)],
      ...(group === undefined ? {} : { properties: { sarifToComment: { suggestionGroup: group } } }),
    });
    return log(run({ driver: { name: 'T' } }, [
      member('Uppercase.', 'src/app.js', 2, 'C', 'a'),
      member('Capitalize.', 'docs/notes.md', 1, 'First', 'a'),
      member('Uppercase too.', 'src/app.js', 2, 'C', secondGroup),
      ...(secondGroup === undefined ? [] : [member('Capitalize more.', 'docs/notes.md', 3, 'Third', secondGroup)]),
    ]));
  };
  const SUGGESTION_PRS = { suggestionPullRequests: { headRef: 'feature', ready: false } };

  test('a group\'s change also carried outside the group blocks the review, naming the group, both findings and the change', async () => {
    const outcome = await prepareOutcome(shared(undefined), SUGGESTION_PRS);
    assert.equal(outcome.status, 'blocked');
    // Companion contract §2.3 "A change is carried by one group or by none";
    // diagnostics.md catalog `suggestion-group-change-shared`.
    assert.equal(outcome.markdown, [
      '**Review blocked:** 1 problem must be resolved before publication; nothing was published.',
      '',
      '- `suggestion-group-change-shared` at `/runs/0/results/2`: The replacement of `src/app.js` line 2 is proposed both by '
        + 'suggestion group "a" (`/runs/0/results/0`) and by `/runs/0/results/2`, which is not in the group; '
        + 'one change cannot be accepted both as part of the group and on its own.',
    ].join('\n'));
  });

  test('a change carried by two groups blocks the review, naming both groups: groups are never joined', async () => {
    const outcome = await prepareOutcome(shared('b'), SUGGESTION_PRS);
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.markdown, [
      '**Review blocked:** 1 problem must be resolved before publication; nothing was published.',
      '',
      '- `suggestion-group-change-shared` at `/runs/0/results/2`: The replacement of `src/app.js` line 2 is proposed both by '
        + 'suggestion group "a" (`/runs/0/results/0`) and by suggestion group "b" (`/runs/0/results/2`); '
        + 'one change cannot be accepted as part of two groups, and groups are never joined.',
    ].join('\n'));
  });
});
