/**
 * Proposals on the original pull request that a native suggestion alone does
 * not cover: an edit made by hand in the review body (`edits: review-body`),
 * a group made by hand (`groupedEdits: manual-group`, and `fileOperations:
 * manual` for a group with a whole-file creation or deletion, the mixed
 * manual group), and a native batch of a fix with several changes or of a
 * group member whose fix makes several. Preparation is exercised whole,
 * against an in-memory reviewed repository, with the resolved delivery
 * policy it receives from publication.
 *
 * Every expected value is written by hand from the contracts: each body
 * section, inline comment, obstacle sentence and size message is the
 * grammar of docs/delivery-policy-contract.md §8.8 and §8.10 applied to the
 * fixture, with findings, finding sections and file sections as
 * docs/review-presentation-contract.md §2, §5 and
 * docs/file-operation-publication-contract.md §2 present them. Nothing is
 * captured from program output.
 *
 * @see ../docs/delivery-policy-contract.md
 * @see ../docs/review-presentation-contract.md
 * @see ../docs/file-operation-publication-contract.md
 * @see https://github.github.com/gfm/#fenced-code-blocks
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html#_Toc141790906
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveDeliveryPolicy } from '../dist/delivery-policy.cjs';
import type { IDeliveryPolicyLayer } from '../dist/delivery-policy.cjs';
import { prepareReview } from '../dist/prepare-review.cjs';
import type { IBlockedOutcome, IReadyOutcome, PrepareReviewOutcome } from '../dist/prepare-review.cjs';
import { composedProblem, fenceProblem, loadMarkdownParser } from '../dist/presentation/markdown-tree.cjs';
import type { IManualEditPresentationContext } from '../dist/public-api.cjs';

await loadMarkdownParser();

// ---------------------------------------------------------------------------
// The reviewed repository: acme/widgets#7 at R. The pull request adds README
// lines 2-4, so only they can carry native suggestions; every other file is
// outside the reviewed diff.

const BASE = '1111111111111111111111111111111111111111';
const R = '2222222222222222222222222222222222222222';
const SHORT = '2222222';
const SEP = '\n\n---\n\n';
const ATTRIBUTION = '<sub>— T</sub>';
const SAMPLE_MARKER = '<!-- sarif-to-comment:review:00000000-0000-4000-8000-000000000000 -->';

const UNCHANGED: Readonly<Record<string, string>> = {
  'src/app.ts': 'a\nb\nc\nd\n',
  'crlf.txt': 'one\r\ntwo\r\n',
  'tail.txt': 'first\nlast',
  'crlf-tail.txt': 'one\r\ntwo',
  'bom.txt': '\uFEFFtitle\nbody\n',
  'obsolete.txt': 'old\n',
  ' lead.txt': 'x\n',
  'odd\u200Ename.txt': 'x\n',
};
const SNAPSHOTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [R]: { 'README.md': '# Widgets\nTeh widget client.\nRecieve updates.\nLicence: MIT.\n', ...UNCHANGED },
  [BASE]: { 'README.md': '# Widgets\n', ...UNCHANGED },
};
const CONTEXT = {
  owner: 'acme',
  repo: 'widgets',
  pullNumber: 7,
  reviewedCommit: R,
  diff: { baseCommit: BASE, headCommit: R, files: [{ path: 'README.md', patch: '@@ -1 +1,4 @@\n # Widgets\n+Teh widget client.\n+Recieve updates.\n+Licence: MIT.' }] },
};
const GUIDE = '# Guide\n\nUse the client.\n';

function snapshot(commit: string): Readonly<Record<string, string>> {
  const files = SNAPSHOTS[commit];
  if (files === undefined) throw new Error(`unknown commit ${commit}`);
  return files;
}

/** Preparation of `sarif` under the caller's delivery settings (the defaults when absent). */
function prepareOutcome(sarif: Json, caller?: IDeliveryPolicyLayer, options: Json = {}): Promise<PrepareReviewOutcome> {
  return prepareReview({
    sarif,
    context: CONTEXT,
    readSource: (commit: string, filePath: string) => Promise.resolve(snapshot(commit)[filePath] ?? null),
    fileExists: (commit: string, filePath: string) => Promise.resolve(Object.hasOwn(snapshot(commit), filePath)),
    options: { delivery: { policy: resolveDeliveryPolicy(caller === undefined ? {} : { caller }) }, ...options },
  });
}

async function ready(sarif: Json, caller?: IDeliveryPolicyLayer, options?: Json): Promise<IReadyOutcome> {
  const outcome = await prepareOutcome(sarif, caller, options);
  assert.equal(outcome.status, 'ready', outcome.markdown);
  return outcome;
}

async function blocked(sarif: Json, caller?: IDeliveryPolicyLayer, options?: Json): Promise<IBlockedOutcome> {
  const outcome = await prepareOutcome(sarif, caller, options);
  assert.equal(outcome.status, 'blocked', outcome.markdown);
  return outcome;
}

/**
 * A body the core built for proposals made by hand: the composed-text
 * checkpoint finds nothing open and no `suggestion` code block, and no line
 * of it could even open one (delivery policy §8.10).
 */
function assertNoSuggestion(body: string): void {
  assert.equal(composedProblem(`${body}\n\n${SAMPLE_MARKER}`, { marker: SAMPLE_MARKER }), null, body);
  assert.equal(fenceProblem(body), null, body);
}

// ---------------------------------------------------------------------------
// SARIF

type Json = Record<string, unknown>;

interface IResultSpec {
  readonly location?: Json;
  readonly fix?: Json;
  readonly group?: string;
  readonly operation?: Json;
}

function result(text: string, { location, fix, group, operation }: IResultSpec = {}): Json {
  const owned: Json = {
    ...(group === undefined ? {} : { suggestionGroup: group }),
    ...(operation === undefined ? {} : { proposedFileChanges: [operation] }),
  };
  return {
    message: { text },
    ...(location === undefined ? {} : { locations: [{ physicalLocation: location }] }),
    ...(fix === undefined ? {} : { fixes: [fix] }),
    ...(Object.keys(owned).length === 0 ? {} : { properties: { sarifToComment: owned } }),
  };
}

function document(results: readonly Json[], artifacts: readonly Json[] = []): Json {
  return {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'T' } },
      columnKind: 'utf16CodeUnits',
      versionControlProvenance: [{ repositoryUri: 'https://github.com/acme/widgets', revisionId: R }],
      artifacts,
      results,
    }],
  };
}

const at = (uri: string, startLine?: number): Json => ({ artifactLocation: { uri }, ...(startLine === undefined ? {} : { region: { startLine } }) });
/** One fix replacing the text (not the terminator) of each given line of `uri`. */
const linesFix = (uri: string, lines: Readonly<Record<number, string>>): Json => ({
  artifactChanges: [{ artifactLocation: { uri }, replacements: Object.entries(lines).map(([line, text]) => ({ deletedRegion: { startLine: Number(line) }, insertedContent: { text } })) }],
});
/** One fix with one replacement of `region`. */
const regionFix = (uri: string, region: Json, text: string): Json => ({
  artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion: region, insertedContent: { text } }] }],
});

/** The permalink of a path (percent-encoded by the caller) at the reviewed commit (review presentation contract §5). */
const permalink = (encodedPath: string, anchor = ''): string => `https://github.com/acme/widgets/blob/${R}/${encodedPath}${anchor}`;

/** A finding section with its source link and the quoted reviewed line (review presentation contract §5). */
function sectionAt(path: string, line: number, quoted: string, message: string): string {
  return [`**Source:** [${path} line ${String(line)} at ${SHORT}](${permalink(path, `?plain=1#L${String(line)}`)})`, '', '```', quoted, '```', '', message, '', ATTRIBUTION].join('\n');
}

/** A manual edit section (§8.10) replacing one line of `path` with `shown` (its LF block text). */
function manualEdit(path: string, line: number, shown: string, findings: string, details = ''): string {
  return `**Proposed edit, to make by hand:** replace [${path} line ${String(line)} at ${SHORT}](${permalink(path, `?plain=1#L${String(line)}`)}) with${details === '' ? '' : ` (${details})`}:\n\n\`\`\`\n${shown}\n\`\`\`\n\n${findings}`;
}

/** The first paragraph of a manual group's guidance (§8.10). */
const groupGuidance = (label: string, count: number): string =>
  `**${label}:** apply these ${String(count)} changes together, by hand, in one commit: make every change below in a local copy of the pull request's branch, then commit them together. They are not offered as suggestions, and nothing checks that they are applied together.`;

const NOTE = (label: string, owner: 'group' | 'fix'): string => `**${label}:** apply this suggestion together with the ${owner}'s other suggestions, listed in the review body.`;
const BATCH_GUIDANCE = (label: string, count: number): string =>
  `**${label}:** apply these ${String(count)} suggestions together, in one commit: add each of them to one batch of suggestions on the pull request, then commit the batch. Nothing checks that they are applied together.`;

/** The message and first remedy of the one `delivery-unavailable` a blocked outcome carries. */
function unavailable(outcome: IBlockedOutcome): { readonly message: string; readonly remedy: string | undefined } {
  assert.deepEqual(outcome.diagnostics.map((d) => d.code), ['delivery-unavailable'], outcome.markdown);
  const [diagnostic] = outcome.diagnostics;
  assert.ok(diagnostic);
  return { message: diagnostic.message, remedy: diagnostic.remedies?.[0] };
}

const CALLER_EDITS = 'set by the caller (`--edits`, `delivery.edits`)';
const NOT_INLINE = (path: string, line: number): string => `Lines ${String(line)}-${String(line)} of ${path} cannot carry a native suggestion (file-not-in-diff).`;

// ---------------------------------------------------------------------------

describe('an edit made by hand in the review body (`edits: review-body`, §8.10)', () => {
  const USE_B = result('Use B.', { location: at('src/app.ts', 2), fix: linesFix('src/app.ts', { 2: 'B' }) });

  test('an edit outside the diff is one body section: the exact replacement, linked to the replaced line, then its finding; no inline comment', async () => {
    const outcome = await ready(document([USE_B]), { edits: ['review-body'] });
    assert.equal(outcome.review.body, manualEdit('src/app.ts', 2, 'B', sectionAt('src/app.ts', 2, 'b', 'Use B.')));
    assert.deepEqual(outcome.review.comments, []);
    assert.deepEqual(outcome.warnings, [], 'the first listed mechanism: no fallback');
    assertNoSuggestion(outcome.review.body);
  });

  test('listed first, it is used even for an edit that could be a native suggestion', async () => {
    const typo = result('Fix the typo.', { location: at('README.md', 2), fix: linesFix('README.md', { 2: 'The widget client.' }) });
    const outcome = await ready(document([typo]), { edits: ['review-body', 'native'] });
    assert.equal(outcome.review.body, manualEdit('README.md', 2, 'The widget client.', sectionAt('README.md', 2, 'Teh widget client.', 'Fix the typo.')));
    assert.deepEqual(outcome.review.comments, []);
  });

  test('after `native`, it is an announced fallback for an edit that cannot be native', async () => {
    const outcome = await ready(document([USE_B]), { edits: ['native', 'review-body'] });
    assert.deepEqual(outcome.warnings.map((w) => [w.code, w.message]), [[
      'delivery-fallback',
      `The edit of \`src/app.ts\` line 2 is delivered as \`review-body\`. \`edits\` is \`[native, review-body]\`, ${CALLER_EDITS}, and the mechanisms listed before it are unavailable:\n\n- \`native\`: ${NOT_INLINE('src/app.ts', 2)}`,
    ]]);
    assert.equal(outcome.review.body, manualEdit('src/app.ts', 2, 'B', sectionAt('src/app.ts', 2, 'b', 'Use B.')));
  });

  test('`review-body` is never a default; under the defaults an edit outside the diff is blocked naming only `native`', async () => {
    const { message } = unavailable(await blocked(document([USE_B])));
    assert.equal(message, `The edit of \`src/app.ts\` line 2 cannot be delivered. \`edits\` is \`[native]\`, the default, and no mechanism it lists is available:\n\n- \`native\`: ${NOT_INLINE('src/app.ts', 2)}`);
  });

  test('a replacement that GitHub would apply wrongly as a suggestion (a nested ``` line) is shown exactly in a longer fence', async () => {
    const fenced = result('Show the language.', { location: at('README.md', 2), fix: linesFix('README.md', { 2: 'Use ```js' }) });
    const outcome = await ready(document([fenced]), { edits: ['native', 'review-body'] });
    assert.deepEqual(outcome.warnings.map((w) => w.code), ['delivery-fallback']);
    assert.ok(outcome.warnings[0]?.message.includes('- `native`: GitHub applied a nested ``` suggestion as a deletion; this replacement cannot be a native suggestion.'));
    assert.equal(outcome.review.body, `**Proposed edit, to make by hand:** replace [README.md line 2 at ${SHORT}](${permalink('README.md', '?plain=1#L2')}) with:\n\n\`\`\`\`\nUse \`\`\`js\n\`\`\`\`\n\n${sectionAt('README.md', 2, 'Teh widget client.', 'Show the language.')}`);
    assertNoSuggestion(outcome.review.body);
  });
});

describe('the block and its details determine the replacement\'s exact bytes (§8.10)', () => {
  const editOf = async (path: string, region: Json, text: string): Promise<string> => {
    const sarif = document([result('Change it.', { fix: regionFix(path, region, text) })]);
    return (await ready(sarif, { edits: ['review-body'] })).review.body;
  };
  const sectionFor = (replacement: string): string => `**Proposed edit, to make by hand:** ${replacement}\n\nChange it.\n\n${ATTRIBUTION}`;

  test('a CRLF file: the block shows LF breaks, and CRLF is stated', async () => {
    assert.equal(await editOf('crlf.txt', { startLine: 2 }, 'TWO'),
      sectionFor(`replace [crlf.txt line 2 at ${SHORT}](${permalink('crlf.txt', '?plain=1#L2')}) with (CRLF line endings):\n\n\`\`\`\nTWO\n\`\`\``));
  });

  test('a last line without a newline is stated', async () => {
    assert.equal(await editOf('tail.txt', { startLine: 2 }, 'LAST'),
      sectionFor(`replace [tail.txt line 2 at ${SHORT}](${permalink('tail.txt', '?plain=1#L2')}) with (no newline at end of file):\n\n\`\`\`\nLAST\n\`\`\``));
  });

  test('both details, in order', async () => {
    assert.equal(await editOf('crlf-tail.txt', { startLine: 2 }, 'X\r\nY'),
      sectionFor(`replace [crlf-tail.txt line 2 at ${SHORT}](${permalink('crlf-tail.txt', '?plain=1#L2')}) with (CRLF line endings, no newline at end of file):\n\n\`\`\`\nX\nY\n\`\`\``));
  });

  test('the file\'s own byte-order mark, kept by a replacement of line 1, is not shown', async () => {
    assert.equal(await editOf('bom.txt', { startLine: 1 }, 'Title'),
      sectionFor(`replace [bom.txt line 1 at ${SHORT}](${permalink('bom.txt', '?plain=1#L1')}) with:\n\n\`\`\`\nTitle\n\`\`\``));
  });

  test('removed lines are "delete", with no block; a line emptied is a block of one empty line', async () => {
    assert.equal(await editOf('src/app.ts', { startLine: 2, startColumn: 1, endLine: 4, endColumn: 1 }, ''),
      sectionFor(`delete [src/app.ts lines 2-3 at ${SHORT}](${permalink('src/app.ts', '?plain=1#L2-L3')}).`));
    assert.equal(await editOf('src/app.ts', { startLine: 3 }, ''),
      sectionFor(`replace [src/app.ts line 3 at ${SHORT}](${permalink('src/app.ts', '?plain=1#L3')}) with:\n\n\`\`\`\n\n\`\`\``));
  });
});

describe('a replacement that cannot be shown exactly is an obstacle, not a refusal (§8.10)', () => {
  const cases: readonly (readonly [label: string, uri: string, path: string, text: string, reason: string])[] = [
    ['an invisible formatting character', 'src/app.ts', 'src/app.ts', '\u200Eb', 'replacement line 1 contains U+200E, which a code block does not show'],
    ['a bidirectional control on a later line', 'src/app.ts', 'src/app.ts', 'ok\nbad\u202E', 'replacement line 2 contains U+202E, which a code block does not show'],
    // Every format character (Unicode category Cf) and U+00A0 (regression, independent review of "shown exactly").
    ['a zero-width space', 'src/app.ts', 'src/app.ts', 'b\u200Bb', 'replacement line 1 contains U+200B, which a code block does not show'],
    ['a word joiner', 'src/app.ts', 'src/app.ts', 'b\u2060b', 'replacement line 1 contains U+2060, which a code block does not show'],
    ['a soft hyphen', 'src/app.ts', 'src/app.ts', 'b\u00ADb', 'replacement line 1 contains U+00AD, which a code block does not show'],
    ['a tag character', 'src/app.ts', 'src/app.ts', 'b\u{E0001}b', 'replacement line 1 contains U+E0001, which a code block does not show'],
    ['a no-break space, which renders as a space', 'src/app.ts', 'src/app.ts', 'b\u00A0b', 'replacement line 1 contains U+00A0, which a code block does not show'],
    ['an unpaired surrogate', 'src/app.ts', 'src/app.ts', 'x\uD800', 'replacement line 1 contains an unpaired surrogate, which is not UTF-8 text'],
    ['a carriage return inside a line', 'src/app.ts', 'src/app.ts', 'a\rb', 'replacement line 1 contains a carriage return that does not end a line'],
    ['mixed line endings', 'src/app.ts', 'src/app.ts', 'X\r\nY', 'it mixes CRLF and LF line endings, and only one style can be stated'],
    ['a line that could open a suggestion block', 'src/app.ts', 'src/app.ts', '```suggestion\nx\n```', 'a line of it could open a suggestion block, which a proposal made by hand never shows'],
    ['a path with leading whitespace', '%20lead.txt', ' lead.txt', 'y', 'the file path begins or ends with whitespace, which Markdown does not show'],
    ['a path with an invisible character', 'odd%E2%80%8Ename.txt', 'odd\u200Ename.txt', 'y', 'the file path contains U+200E, which cannot be shown exactly'],
  ];
  for (const [label, uri, path, text, reason] of cases) {
    test(`${label}: blocked under a strict list, with its reason and the remedy to change the replacement`, async () => {
      const sarif = document([result('Change it.', { fix: regionFix(uri, { startLine: path === 'src/app.ts' ? 2 : 1 }, text) })]);
      const line = path === 'src/app.ts' ? 2 : 1;
      const { message, remedy } = unavailable(await blocked(sarif, { edits: ['review-body'] }));
      assert.equal(message, `The edit of \`${path}\` line ${String(line)} cannot be delivered. \`edits\` is \`[review-body]\`, ${CALLER_EDITS}, and no mechanism it lists is available:\n\n`
        + `- \`review-body\`: The replacement of \`${path}\` line ${String(line)} cannot be shown exactly in the review body: ${reason}.`);
      assert.equal(remedy, 'Change the replacement.');
    });
  }

  test('a later listed mechanism delivers the edit instead, announcing the obstacle', async () => {
    const sarif = document([result('Mark it.', { location: at('README.md', 2), fix: linesFix('README.md', { 2: 'The widget\u200E client.' }) })]);
    const outcome = await ready(sarif, { edits: ['review-body', 'native'] });
    assert.deepEqual(outcome.warnings.map((w) => [w.code, w.message]), [[
      'delivery-fallback',
      `The edit of \`README.md\` line 2 is delivered as \`native\`. \`edits\` is \`[review-body, native]\`, ${CALLER_EDITS}, and the mechanisms listed before it are unavailable:\n\n`
        + '- `review-body`: The replacement of `README.md` line 2 cannot be shown exactly in the review body: replacement line 1 contains U+200E, which a code block does not show.',
    ]]);
    assert.equal(outcome.review.comments.length, 1);
    assert.equal(outcome.review.body, '');
  });

  test('a group names each change that cannot be shown, in order, under one bullet', async () => {
    const sarif = document([
      result('First.', { group: 'g', fix: regionFix('src/app.ts', { startLine: 2 }, '\u200Eb') }),
      result('Second.', { group: 'g', fix: regionFix('src/app.ts', { startLine: 3 }, 'C') }),
      result('Third.', { group: 'g', fix: regionFix('src/app.ts', { startLine: 4 }, 'a\rd') }),
    ]);
    const { message } = unavailable(await blocked(sarif, { groupedEdits: ['manual-group'] }));
    assert.equal(message, 'The group `g` cannot be delivered. `groupedEdits` is `[manual-group]`, set by the caller (`--grouped-edits`, `delivery.groupedEdits`), and no mechanism it lists is available:\n\n'
      + '- `manual-group`: The replacement of `src/app.ts` line 2 cannot be shown exactly in the review body: replacement line 1 contains U+200E, which a code block does not show. '
      + 'The replacement of `src/app.ts` line 4 cannot be shown exactly in the review body: replacement line 1 contains a carriage return that does not end a line.');
  });
});

describe('a group made by hand (`groupedEdits: manual-group`; §8.10)', () => {
  const BOTH = result('Fix both.', { location: at('src/app.ts', 2), fix: linesFix('src/app.ts', { 2: 'B', 4: 'D' }) });
  const BOTH_SECTION = sectionAt('src/app.ts', 2, 'b', 'Fix both.');

  test('a fix with several changes: the guidance lists each change, then each change with the finding that carries it', async () => {
    const outcome = await ready(document([BOTH]), { groupedEdits: ['manual-group'] });
    const label = 'Fix with 2 changes';
    assert.equal(outcome.review.body, [
      `${groupGuidance(label, 2)}\n\n- \`src/app.ts\` line 2\n- \`src/app.ts\` line 4`,
      `**${label} — change 1 of 2**\n\n${manualEdit('src/app.ts', 2, 'B', BOTH_SECTION)}`,
      `**${label} — change 2 of 2**\n\n${manualEdit('src/app.ts', 4, 'D', BOTH_SECTION)}`,
    ].join(SEP));
    assert.deepEqual(outcome.review.comments, []);
    assertNoSuggestion(outcome.review.body);
  });

  test('an explicit group lists its changes in the order they first appear: a member\'s several changes, then the next member\'s', async () => {
    const sarif = document([
      result('Fix both.', { group: 'pair', location: at('src/app.ts', 2), fix: linesFix('src/app.ts', { 2: 'B', 4: 'D' }) }),
      result('Fix three.', { group: 'pair', location: at('src/app.ts', 3), fix: linesFix('src/app.ts', { 3: 'C' }) }),
    ]);
    const outcome = await ready(sarif, { groupedEdits: ['manual-group'] });
    const label = 'Suggestion group `pair`';
    assert.equal(outcome.review.body, [
      `${groupGuidance(label, 3)}\n\n- \`src/app.ts\` line 2\n- \`src/app.ts\` line 4\n- \`src/app.ts\` line 3`,
      `**${label} — change 1 of 3**\n\n${manualEdit('src/app.ts', 2, 'B', BOTH_SECTION)}`,
      `**${label} — change 2 of 3**\n\n${manualEdit('src/app.ts', 4, 'D', BOTH_SECTION)}`,
      `**${label} — change 3 of 3**\n\n${manualEdit('src/app.ts', 3, 'C', sectionAt('src/app.ts', 3, 'c', 'Fix three.'))}`,
    ].join(SEP));
    assertNoSuggestion(outcome.review.body);
  });

  test('it holds the group\'s place among the body sections: at its first finding, in SARIF order', async () => {
    const sarif = document([
      result('General remark.'),
      result('Fix both.', { group: 'pair', location: at('src/app.ts', 2), fix: linesFix('src/app.ts', { 2: 'B' }) }),
      result('Later remark.'),
      result('Fix four.', { group: 'pair', location: at('src/app.ts', 4), fix: linesFix('src/app.ts', { 4: 'D' }) }),
    ]);
    const outcome = await ready(sarif, { groupedEdits: ['manual-group'] });
    const sections = outcome.review.body.split(SEP);
    assert.equal(sections[0], `General remark.\n\n${ATTRIBUTION}`);
    assert.ok(sections[1]?.startsWith(groupGuidance('Suggestion group `pair`', 2)));
    assert.equal(sections.at(-1), `Later remark.\n\n${ATTRIBUTION}`);
  });
});

describe('the mixed manual group (`fileOperations: manual` for a group with a whole-file operation; D49, D51)', () => {
  const GUIDE_FINDING = result('Add a guide.', { group: 'helper', location: at('docs/guide.md', 1), operation: { operation: 'create', artifactIndex: 0 } });
  const USE_HELPER = result('Use the helper.', { group: 'helper', location: at('src/app.ts', 2), fix: linesFix('src/app.ts', { 2: 'B' }) });
  const REMOVE = result('Remove it.', { group: 'helper', location: at('obsolete.txt'), operation: { operation: 'delete', artifactIndex: 1 } });
  const LICENSE = result('Use the American spelling.', { location: at('README.md', 4), fix: linesFix('README.md', { 4: 'License: MIT.' }) });
  const ARTIFACTS = [{ location: { uri: 'docs/guide.md' }, contents: { text: GUIDE }, encoding: 'utf-8' }, { location: { uri: 'obsolete.txt' } }];
  const label = 'Suggestion group `helper`';
  const CREATION = [
    '**Proposed new file:** `docs/guide.md`',
    '',
    '**File details:** 25 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
    '',
    '```',
    '# Guide',
    '',
    'Use the client.',
    '```',
    '',
    '**Location:** line 1 of the proposed file',
    '',
    'Add a guide.',
    '',
    ATTRIBUTION,
  ].join('\n');
  const DELETION = `**Proposed file deletion:** [obsolete.txt at ${SHORT}](${permalink('obsolete.txt')})\n\nThe whole file is removed; this is not a proposal to empty it.\n\nRemove it.\n\n${ATTRIBUTION}`;
  const MIXED = [
    `${groupGuidance(label, 3)}\n\n- \`docs/guide.md\`: new file\n- \`src/app.ts\` line 2\n- \`obsolete.txt\`: file deletion`,
    `**${label} — change 1 of 3**\n\n${CREATION}`,
    `**${label} — change 2 of 3**\n\n${manualEdit('src/app.ts', 2, 'B', sectionAt('src/app.ts', 2, 'b', 'Use the helper.'))}`,
    `**${label} — change 3 of 3**\n\n${DELETION}`,
  ].join(SEP);

  test('under the defaults: one section holds every member — the creation, the edit and the deletion — and an unrelated edit stays native', async () => {
    const outcome = await ready(document([GUIDE_FINDING, USE_HELPER, LICENSE, REMOVE], ARTIFACTS));
    assert.equal(outcome.review.body, MIXED);
    assert.deepEqual(outcome.warnings, []);
    assert.equal(outcome.review.comments.length, 1, 'only the unrelated edit is inline');
    assert.deepEqual([outcome.review.comments[0]?.path, outcome.review.comments[0]?.line], ['README.md', 4]);
    assert.ok(outcome.review.comments[0]?.body.endsWith('```suggestion\nLicense: MIT.\n```'));
    assertNoSuggestion(outcome.review.body);
  });

  test('its edits are made by hand even when each could be a native suggestion (D51: the group follows the file operation)', async () => {
    const typo = result('Fix the typo.', { group: 'helper', location: at('README.md', 2), fix: linesFix('README.md', { 2: 'The widget client.' }) });
    const outcome = await ready(document([GUIDE_FINDING, typo], ARTIFACTS.slice(0, 1)), { groupedEdits: ['native-batch'] });
    assert.deepEqual(outcome.review.comments, []);
    assert.equal(outcome.review.body, [
      `${groupGuidance(label, 2)}\n\n- \`docs/guide.md\`: new file\n- \`README.md\` line 2`,
      `**${label} — change 1 of 2**\n\n${CREATION}`,
      `**${label} — change 2 of 2**\n\n${manualEdit('README.md', 2, 'The widget client.', sectionAt('README.md', 2, 'Teh widget client.', 'Fix the typo.'))}`,
    ].join(SEP));
  });

  test('an edit of the group that cannot be shown exactly makes `manual` unavailable for the whole group', async () => {
    const hidden = result('Hidden.', { group: 'helper', fix: regionFix('src/app.ts', { startLine: 2 }, '\u2028') });
    const { message } = unavailable(await blocked(document([GUIDE_FINDING, hidden], ARTIFACTS.slice(0, 1))));
    assert.equal(message, 'The group `helper` cannot be delivered. `fileOperations` is `[manual]`, the default, and no mechanism it lists is available:\n\n'
      + '- `manual`: The replacement of `src/app.ts` line 2 cannot be shown exactly in the review body: replacement line 1 contains U+2028, which a code block does not show.');
  });
});

describe('a native batch of a fix with several changes, or of a member whose fix makes several (§8.3, §8.8)', () => {
  const comment = (line: number, findings: string, note: string, payload: string): Json => ({
    path: 'README.md', side: 'RIGHT', line, body: `${findings}\n\n${note}\n\n\`\`\`suggestion\n${payload}\n\`\`\``,
  });

  test('D-A23: under the defaults, each change is a native suggestion holding the finding, with the fix\'s note, and the body lists them', async () => {
    const sarif = document([result('Fix both lines.', { location: at('README.md', 2), fix: linesFix('README.md', { 2: 'The widget client.', 3: 'Receive updates.' }) })]);
    const outcome = await ready(sarif);
    const label = 'Fix with 2 changes';
    const finding = `Fix both lines.\n\n${ATTRIBUTION}`;
    assert.deepEqual(outcome.review.comments, [
      comment(2, finding, NOTE(label, 'fix'), 'The widget client.'),
      comment(3, finding, NOTE(label, 'fix'), 'Receive updates.'),
    ]);
    assert.equal(outcome.review.body, `${BATCH_GUIDANCE(label, 2)}\n\n- \`README.md\` line 2\n- \`README.md\` line 3`);
    assert.deepEqual(outcome.warnings, []);
  });

  test('D-A24: a group member\'s several changes are each a member of the batch, in order', async () => {
    const sarif = document([
      result('Fix both lines.', { group: 'pair', location: at('README.md', 2), fix: linesFix('README.md', { 2: 'The widget client.', 3: 'Receive updates.' }) }),
      result('Use the American spelling.', { group: 'pair', location: at('README.md', 4), fix: linesFix('README.md', { 4: 'License: MIT.' }) }),
    ]);
    const outcome = await ready(sarif);
    const label = 'Suggestion group `pair`';
    const both = `Fix both lines.\n\n${ATTRIBUTION}`;
    assert.deepEqual(outcome.review.comments, [
      comment(2, both, NOTE(label, 'group'), 'The widget client.'),
      comment(3, both, NOTE(label, 'group'), 'Receive updates.'),
      comment(4, `Use the American spelling.\n\n${ATTRIBUTION}`, NOTE(label, 'group'), 'License: MIT.'),
    ]);
    assert.equal(outcome.review.body, `${BATCH_GUIDANCE(label, 3)}\n\n- \`README.md\` line 2\n- \`README.md\` line 3\n- \`README.md\` line 4`);
  });

  test('a change that cannot be a native suggestion keeps the whole fix out of the batch, naming that change', async () => {
    const sarif = document([result('Fix both.', { location: at('README.md', 2), fix: {
      artifactChanges: [
        { artifactLocation: { uri: 'README.md' }, replacements: [{ deletedRegion: { startLine: 2 }, insertedContent: { text: 'The widget client.' } }] },
        { artifactLocation: { uri: 'src/app.ts' }, replacements: [{ deletedRegion: { startLine: 2 }, insertedContent: { text: 'B' } }] },
      ],
    } })]);
    const { message } = unavailable(await blocked(sarif));
    assert.equal(message, 'The fix with 2 changes at `/runs/0/results/0` cannot be delivered. `groupedEdits` is `[native-batch]`, the default, and no mechanism it lists is available:\n\n'
      + `- \`native-batch\`: The edit of \`src/app.ts\` line 2: ${NOT_INLINE('src/app.ts', 2)}`);
  });
});

describe('size limits (§8.10): a manual section over the body limit blocks; nothing is split', () => {
  test('a manual group is named with its section\'s length', async () => {
    const sarif = document([result('Fix both.', { location: at('src/app.ts', 2), fix: linesFix('src/app.ts', { 2: 'B', 4: 'D' }) })]);
    const fits = await ready(sarif, { groupedEdits: ['manual-group'] });
    const length = fits.review.body.length;
    const outcome = await blocked(sarif, { groupedEdits: ['manual-group'] }, { maxCommentBodyChars: length - 1 });
    assert.deepEqual(outcome.diagnostics.map((d) => [d.code, d.message]), [[
      'body-too-large',
      `The review body is ${String(length)} characters; the limit is ${String(length - 1)}. Proposals to make by hand in the body: the fix with 2 changes at \`/runs/0/results/0\` (${String(length)} characters). Nothing is truncated or split.`,
    ]]);
  });

  test('an edit by hand is named after the whole-file proposals of the body', async () => {
    const sarif = document([
      result('Add a guide.', { location: at('docs/guide.md', 1), operation: { operation: 'create', artifactIndex: 0 } }),
      result('Use B.', { location: at('src/app.ts', 2), fix: linesFix('src/app.ts', { 2: 'B' }) }),
    ], [{ location: { uri: 'docs/guide.md' }, contents: { text: GUIDE }, encoding: 'utf-8' }]);
    const fits = await ready(sarif, { edits: ['review-body'] });
    const [creation, edit] = fits.review.body.split(SEP);
    assert.ok(creation !== undefined && edit !== undefined);
    assert.equal(edit, manualEdit('src/app.ts', 2, 'B', sectionAt('src/app.ts', 2, 'b', 'Use B.')));
    const length = fits.review.body.length;
    const outcome = await blocked(sarif, { edits: ['review-body'] }, { maxCommentBodyChars: length - 1 });
    assert.deepEqual(outcome.diagnostics.map((d) => d.message), [
      `The review body is ${String(length)} characters; the limit is ${String(length - 1)}. Whole-file proposals in the body: docs/guide.md (${String(creation.length)} characters). `
        + `Proposals to make by hand in the body: the edit of \`src/app.ts\` line 2 (${String(edit.length)} characters). Nothing is truncated or split.`,
    ]);
  });

  test('a mixed manual group is named as its group; its file operations are not listed separately', async () => {
    const sarif = document([
      result('Add a guide.', { group: 'helper', location: at('docs/guide.md', 1), operation: { operation: 'create', artifactIndex: 0 } }),
      result('Use B.', { group: 'helper', location: at('src/app.ts', 2), fix: linesFix('src/app.ts', { 2: 'B' }) }),
    ], [{ location: { uri: 'docs/guide.md' }, contents: { text: GUIDE }, encoding: 'utf-8' }]);
    const length = (await ready(sarif)).review.body.length;
    const outcome = await blocked(sarif, undefined, { maxCommentBodyChars: length - 1 });
    assert.deepEqual(outcome.diagnostics.map((d) => d.message), [
      `The review body is ${String(length)} characters; the limit is ${String(length - 1)}. Proposals to make by hand in the body: the group \`helper\` (${String(length)} characters). Nothing is truncated or split.`,
    ]);
  });
});

describe('the manual edit component is customizable; the group\'s guidance and labels are the core\'s (§8.10; review presentation contract §7)', () => {
  const USE_B = result('Use B.', { location: at('src/app.ts', 2), fix: linesFix('src/app.ts', { 2: 'B' }) });
  const URL = permalink('src/app.ts', '?plain=1#L2');
  const LOCATION = `[src/app.ts line 2 at ${SHORT}](${URL})`;
  const FINDINGS = sectionAt('src/app.ts', 2, 'b', 'Use B.');

  test('the callback receives the edit, its location link, block and findings, and the built-in Markdown, with the required fragments', async () => {
    const seen: IManualEditPresentationContext[] = [];
    const outcome = await ready(document([USE_B]), { edits: ['review-body'] }, {
      presentation: {
        manualEdit: (c: IManualEditPresentationContext) => {
          seen.push(c);
          return `### Edit ${c.location} by hand\n\n${c.replacement ?? ''}\n\n${c.findings}`;
        },
      },
    });
    assert.equal(outcome.review.body, `### Edit ${LOCATION} by hand\n\n\`\`\`\nB\n\`\`\`\n\n${FINDINGS}`);
    assert.deepEqual(seen, [{
      path: 'src/app.ts', startLine: 2, endLine: 2, commit: R, url: permalink('src/app.ts', '?plain=1#L2'),
      location: LOCATION, replacement: '```\nB\n```', findings: FINDINGS,
      markdown: manualEdit('src/app.ts', 2, 'B', FINDINGS),
      required: [LOCATION, URL, '```\nB\n```', FINDINGS],
    }]);
  });

  test('details are required when there are any; a deletion has no block', async () => {
    const seen: IManualEditPresentationContext[] = [];
    const capture = { presentation: { manualEdit: (c: IManualEditPresentationContext) => { seen.push(c); return c.markdown; } } };
    await ready(document([result('Change it.', { fix: regionFix('crlf.txt', { startLine: 2 }, 'TWO') })]), { edits: ['review-body'] }, capture);
    await ready(document([result('Drop them.', { fix: regionFix('src/app.ts', { startLine: 2, startColumn: 1, endLine: 4, endColumn: 1 }, '') })]), { edits: ['review-body'] }, capture);
    const [crlf, deletion] = seen;
    assert.ok(crlf && deletion);
    assert.equal(crlf.details, 'CRLF line endings');
    assert.deepEqual(crlf.required, [`[crlf.txt line 2 at ${SHORT}](${permalink('crlf.txt', '?plain=1#L2')})`, permalink('crlf.txt', '?plain=1#L2'), '```\nTWO\n```', 'CRLF line endings', `Change it.\n\n${ATTRIBUTION}`]);
    assert.equal(Object.hasOwn(deletion, 'replacement'), false, 'absent, not undefined');
    assert.deepEqual(deletion.required, [`[src/app.ts lines 2-3 at ${SHORT}](${permalink('src/app.ts', '?plain=1#L2-L3')})`, permalink('src/app.ts', '?plain=1#L2-L3'), `Drop them.\n\n${ATTRIBUTION}`]);
  });

  test('in a group, each edit is the callback\'s, and the guidance and labels around it are kept', async () => {
    const sarif = document([result('Fix both.', { location: at('src/app.ts', 2), fix: linesFix('src/app.ts', { 2: 'B', 4: 'D' }) })]);
    const outcome = await ready(sarif, { groupedEdits: ['manual-group'] }, {
      presentation: { manualEdit: (c: IManualEditPresentationContext) => `Edit ${c.location}:\n\n${c.replacement ?? ''}\n\n${c.findings}` },
    });
    const label = 'Fix with 2 changes';
    const edit = (line: number, shown: string): string => `Edit [src/app.ts line ${String(line)} at ${SHORT}](${permalink('src/app.ts', `?plain=1#L${String(line)}`)}):\n\n\`\`\`\n${shown}\n\`\`\`\n\n${sectionAt('src/app.ts', 2, 'b', 'Fix both.')}`;
    assert.equal(outcome.review.body, [
      `${groupGuidance(label, 2)}\n\n- \`src/app.ts\` line 2\n- \`src/app.ts\` line 4`,
      `**${label} — change 1 of 2**\n\n${edit(2, 'B')}`,
      `**${label} — change 2 of 2**\n\n${edit(4, 'D')}`,
    ].join(SEP));
  });

  // A finding without a location: its section has no source link, so only the edit's own link shows the location.
  const UNLOCATED = result('Use B.', { fix: linesFix('src/app.ts', { 2: 'B' }) });
  // USE_B's finding is on the edited line, so its section's source link is byte-identical to the location
  // link: it must not stand in for the location (regression, independent review of the manual edit callback).
  const EVIL = `[src/app.ts line 2 at ${SHORT}](https://evil.example/)`;
  const SPOOF = /links the text "src\/app\.ts line 2 at 2222222" to "https:\/\/evil\.example\/" rather than its permalink/;
  const refusals: readonly (readonly [label: string, finding: Json, callback: (c: IManualEditPresentationContext) => string, rule: RegExp])[] = [
    ['drops the replacement block', UNLOCATED, (c) => `${c.location}\n\n${c.findings}`, /omits a required fragment, which must appear verbatim: "```\\nB\\n```"/],
    ['re-points the location link', UNLOCATED, (c) => `${EVIL}\n\n${c.replacement ?? ''}\n\n${c.findings}`, /omits a required fragment|links the text/],
    ['hides the location inside code', UNLOCATED, (c) => `\`${c.location}\`\n\n${c.replacement ?? ''}\n\n${c.findings}`, /hides a required fragment/],
    ['turns the replacement into a suggestion', UNLOCATED, (c) => `${c.location}\n\n\`\`\`suggestion\nB\n\`\`\`\n\n${c.replacement ?? ''}\n\n${c.findings}`, /could open a suggestion block/],
    ['re-points the location link while the finding on the edited line shows the same link', USE_B, (c) => `${EVIL}\n\n${c.replacement ?? ''}\n\n${c.findings}`,
      /shows a required fragment only inside another required fragment|links the text "src\/app\.ts line 2 at 2222222" to "https:\/\/evil\.example\/"/],
    ['drops the location while the finding on the edited line shows the same link', USE_B, (c) => `Replace line 9 with:\n\n${c.replacement ?? ''}\n\n${c.findings}`,
      /shows a required fragment only inside another required fragment, but each must be shown on its own: "\[src\/app\.ts line 2/],
    ['adds a second link with the location\'s text to another destination', UNLOCATED, (c) => `${c.location} (or ${EVIL})\n\n${c.replacement ?? ''}\n\n${c.findings}`, SPOOF],
    // Text that reads as the location's (regression, re-check of the identity-link rule): an invisible character, a
    // no-break space, a trailing or doubled space.
    ['spoofs the location text with a zero-width space', UNLOCATED, (c) => `${c.location} (or [src/app.ts line 2 at 222​2222](https://evil.example/))\n\n${c.replacement ?? ''}\n\n${c.findings}`,
      /contains U\+200B, an invisible character, outside the content it presents/],
    ['spoofs the location text with a no-break space', UNLOCATED, (c) => `${c.location} (or [src/app.ts line 2 at 2222222](https://evil.example/))\n\n${c.replacement ?? ''}\n\n${c.findings}`,
      /contains U\+00A0, an invisible character, outside the content it presents/],
    ['spoofs the location text with a trailing space', UNLOCATED, (c) => `${c.location} (or [src/app.ts line 2 at 2222222 ](https://evil.example/))\n\n${c.replacement ?? ''}\n\n${c.findings}`,
      /links the text "src\/app\.ts line 2 at 2222222 ?" to "https:\/\/evil\.example\/" rather than its permalink/],
    ['spoofs the location text with a doubled space', UNLOCATED, (c) => `${c.location} (or [src/app.ts line 2  at 2222222](https://evil.example/))\n\n${c.replacement ?? ''}\n\n${c.findings}`,
      /links the text "src\/app\.ts line 2  at 2222222" to "https:\/\/evil\.example\/" rather than its permalink/],
    ['points the text of its finding\'s source link elsewhere', USE_B, (c) => `${c.location}\n\n${c.replacement ?? ''}\n\n${c.findings}\n\nSee also [src/app.ts line 2 at 2222222](https://evil.example/).`, SPOOF],
    ['shows the permalink only as the text of a link elsewhere', UNLOCATED, (c) => `[${c.url}](https://evil.example/)\n\n${c.replacement ?? ''}\n\n${c.findings}`, /omits a required fragment|hides a required fragment/],
  ];
  test('no false refusal: a callback may present a producer message that holds a no-break space, and may link elsewhere with text of its own', async () => {
    const message = result('Use B, as the style guide says.', { fix: linesFix('src/app.ts', { 2: 'B' }) });
    const outcome = await ready(document([message]), { edits: ['review-body'] }, {
      presentation: { manualEdit: (c: IManualEditPresentationContext) => `${c.markdown}\n\nSee [the style guide](https://example.com/style).` },
    });
    assert.ok(outcome.review.body.endsWith('See [the style guide](https://example.com/style).'));
  });

  for (const [label, finding, callback, rule] of refusals) {
    test(`a callback that ${label} is refused before anything is written`, async () => {
      await assert.rejects(prepareOutcome(document([finding]), { edits: ['review-body'] }, { presentation: { manualEdit: callback } }), (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /^Invalid presentation: options\.presentation\.manualEdit returned Markdown that /);
        assert.match(error.message, rule);
        return true;
      });
    });
  }
});
