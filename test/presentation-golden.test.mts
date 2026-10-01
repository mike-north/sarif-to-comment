/**
 * Byte-exact pins of every review presentation the tool renders today: a
 * finding's general-body section with its quoted source, its attribution
 * (tool, extension component and rule), an inline finding, a native
 * suggestion comment with its fix description and listed alternatives,
 * whole-file creation and deletion sections, the review body with its hidden
 * publication marker, and a companion suggestion pull request's reference in
 * the review together with its own body and lifecycle note (draft and ready).
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
 * @see ../src/prepare-review.cts (the rendering grammar in the module documentation)
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 * @see https://github.github.com/gfm/#fenced-code-blocks
 * @see https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { createGitHubClient } from '../dist/github.cjs';
import { prepareReview } from '../dist/prepare-review.cjs';
import type { IReadyOutcome, PrepareReviewOutcome } from '../dist/prepare-review.cjs';
import { publishSarifReviewWithInternals } from '../dist/publish-sarif-review.cjs';
import type { PublishSarifReviewOutcome } from '../dist/publish-sarif-review.cjs';
import { FakeHttpGitHub } from './fixtures/composition/fake-http-github.mts';
import type { IHttpRepository } from './fixtures/composition/fake-http-github.mts';
import { asRecord, asString, parseJson } from './support/runtime-types.mts';

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Preparation boundary: an in-memory reviewed repository

const BASE = '1111111111111111111111111111111111111111';
const R = '2222222222222222222222222222222222222222';
const SHORT = '2222222';
/** The separator between findings and between sections (rendering grammar). */
const SEP = '\n\n---\n\n';

const SNAPSHOT: Readonly<Record<string, string>> = {
  'src/app.js': 'a\nc\nd\n',
  'docs/notes.md': 'first\nsecond\nthird\n',
  'obsolete.txt': 'first line\nsecond line\n',
  'odd dir/a(1).txt': 'odd\n',
};
const BASE_SNAPSHOT: Readonly<Record<string, string>> = { 'src/app.js': 'a\nb\nd\n' };

const CONTEXT = {
  owner: 'acme',
  repo: 'widgets',
  pullNumber: 7,
  reviewedCommit: R,
  diff: { baseCommit: BASE, headCommit: R, files: [{ path: 'src/app.js', patch: '@@ -1,3 +1,3 @@\n a\n-b\n+c\n d' }] },
};

function snapshotAt(commit: string): Readonly<Record<string, string>> {
  if (commit === R) return SNAPSHOT;
  if (commit === BASE) return BASE_SNAPSHOT;
  throw new Error(`unknown commit ${commit}`);
}

async function prepare(sarif: Json, options?: Json): Promise<IReadyOutcome> {
  const outcome: PrepareReviewOutcome = await prepareReview({
    sarif,
    context: CONTEXT,
    readSource: (commit: string, filePath: string) => Promise.resolve(snapshotAt(commit)[filePath] ?? null),
    fileExists: (commit: string, filePath: string) => Promise.resolve(Object.hasOwn(snapshotAt(commit), filePath)),
    ...(options === undefined ? {} : { options }),
  });
  assert.equal(outcome.status, 'ready', outcome.markdown);
  return outcome;
}

/** A permalink to a file at the reviewed commit (file-operation contract §2: PERMALINK). */
const permalink = (encodedPath: string, anchor = ''): string => `https://github.com/acme/widgets/blob/${R}/${encodedPath}${anchor}`;

/** One run bound to the reviewed commit of acme/widgets (versionControlProvenance, SARIF 3.14.15). */
function run(tool: Json, results: readonly Json[], artifacts: readonly Json[] = []): Json {
  return {
    tool,
    columnKind: 'utf16CodeUnits',
    versionControlProvenance: [{ repositoryUri: 'https://github.com/acme/widgets', revisionId: R }],
    artifacts,
    results,
  };
}

const log = (...runs: readonly Json[]): Json => ({ version: '2.1.0', runs });

const at = (uri: string, region?: Json, message?: string): Json => ({
  physicalLocation: { artifactLocation: { uri }, ...(region === undefined ? {} : { region }) },
  ...(message === undefined ? {} : { message: { text: message } }),
});

const lineFix = (uri: string, line: number, text: string, description: string): Json => ({
  description: { text: description },
  artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion: { startLine: line }, insertedContent: { text } }] }],
});

/** A result carrying whole-file proposals (the owned `proposedFileChanges` property). */
function carrying(text: string, operations: readonly Json[], location?: Json): Json {
  return {
    message: { text },
    ...(location === undefined ? {} : { locations: [location] }),
    properties: { sarifToComment: { proposedFileChanges: operations } },
  };
}

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

const HEAD_BASE = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e';
const HEAD = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
const TOKEN = 'ghp_PRESENTATION_GOLDEN_0123456789';
const DESTINATION = { owner: 'octo', repo: 'widgets', pullNumber: 7 } as const;
const GUIDE = '# Guide\n\nUse the client.\n';
/** The hidden per-publication marker the publication core appends (publication.cts MARKER_PATTERN). */
const REVIEW_MARKER = /\n\n<!-- sarif-to-comment:review:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} -->$/;
/** The structured suggestion marker line (convention §7), captured with its JSON. */
const SUGGESTION_MARKER = /\n\n(<!-- suggestion-pr (\{[^\n]*\}) -->)$/;

const HOST_REPOSITORY: IHttpRepository = {
  destination: DESTINATION,
  commits: { base: HEAD_BASE, head: HEAD },
  snapshots: {
    [HEAD_BASE]: { 'README.md': ['# Widgets\n'], 'docs/index.md': ['# Docs\n'] },
    [HEAD]: { 'README.md': ['# Widgets\n', 'More.\n'], 'docs/index.md': ['# Docs\n'] },
  },
  pullFiles: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: ['@@ -1 +1,2 @@\n', ' # Widgets\n', '+More.'] }],
  pull: { headRef: 'feature/retry', baseRef: 'main' },
  defaultBranch: 'main',
  labels: ['suggestion-pr'],
};

/** A run of "Review bot 1.0.0" bound to the reviewed head of octo/widgets. */
function hostDocument(results: readonly Json[], artifacts: readonly Json[] = []): Json {
  return {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Review bot', version: '1.0.0' } },
      columnKind: 'utf16CodeUnits',
      versionControlProvenance: [{ repositoryUri: 'https://github.com/octo/widgets', revisionId: HEAD }],
      artifacts,
      results,
    }],
  };
}

/** A standalone creation of docs/guide.md with a finding on its line 1. */
const GUIDE_DOCUMENT = hostDocument(
  [carrying('Add a guide.', [{ operation: 'create', artifactIndex: 0 }], at('docs/guide.md', { startLine: 1 }))],
  [{ location: { uri: 'docs/guide.md' }, contents: { text: GUIDE }, encoding: 'utf-8' }],
);

interface IHostWorld {
  readonly host: FakeHttpGitHub;
  readonly statePath: string;
}

function hostWorld(): IHostWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-golden-')));
  FakeHttpGitHub.create(path.join(root, 'host'), {}, HOST_REPOSITORY);
  return { host: new FakeHttpGitHub(path.join(root, 'host'), TOKEN), statePath: path.join(root, 'review.json') };
}

function publish(world: IHostWorld, sarif: Json, options?: Json): Promise<PublishSarifReviewOutcome> {
  return publishSarifReviewWithInternals(
    { sarif, destination: DESTINATION, reviewedCommit: HEAD, statePath: world.statePath, token: TOKEN, ...(options === undefined ? {} : { options }) },
    { createGitHubClient: (options) => createGitHubClient({ ...options, fetch: world.host.fetch }) },
  );
}

/** The one stored review's body, with its trailing publication marker checked and removed. */
function reviewBodyWithoutMarker(world: IHostWorld): string {
  const reviews = world.host.reviews();
  assert.equal(reviews.length, 1);
  const body = reviews[0]?.request.body ?? '';
  assert.match(body, REVIEW_MARKER);
  return body.replace(REVIEW_MARKER, '');
}

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
