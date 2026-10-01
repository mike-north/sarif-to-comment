/**
 * Contract tests for publishing a finding that offers alternative fixes, at
 * the preparation boundary (src/prepare-review.cts), and for inspecting it.
 *
 * The owner's decision of September 29, 2026 (issue #30), which these tests
 * restate:
 * - When a SARIF result carries several entries in `fixes[]`, the first one
 *   is the result's suggested change, presented exactly as a single fix is
 *   (a native suggestion where eligible). The producer's order decides; the
 *   tool makes no semantic judgment, so an ineligible first fix is never
 *   replaced by an eligible later one.
 * - Every further fix is listed in the same comment, alongside the finding's
 *   prose, under "Alternatives to consider:", numbered (1), (2), … in the
 *   producer's order. Each is shown in a fence one backtick longer than the
 *   longest backtick run in its content (never shorter than three), and names
 *   its file when that differs from the first fix's file.
 * - Alternatives are never applied, unioned or grouped: they take no part in
 *   the overlap and conflict checks that govern applied changes.
 * - Alternatives count toward the comment size limit; if they do not fit, the
 *   whole review is refused and nothing is truncated.
 * - `inspect` still lists every fix.
 *
 * Every expected body below is written by hand from those rules and from the
 * review presentation contract (docs/review-presentation-contract.md §2 and
 * §4: the finding and its alternatives). None is captured from the implementation. The
 * whole-line ranges and replacement lines come from the SARIF region rules
 * (a region with only startLine covers that line's text, not its newline).
 *
 * @see ../docs/review-presentation-contract.md
 * @see https://github.com/mike-north/sarif-to-comment/issues/30
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html (3.27.30 fixes, 3.55 fix, 3.56 artifactChange, 3.57 replacement, 3.30 region)
 * @see https://github.github.com/gfm/#fenced-code-blocks
 * @see https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/incorporating-feedback-in-your-pull-request
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveDeliveryPolicy } from '../dist/delivery-policy.cjs';
import { prepareReview } from '../dist/prepare-review.cjs';
import type { IBlockedOutcome, IReadyOutcome, PrepareReviewOutcome } from '../dist/prepare-review.cjs';
import { inspectSarif, renderInspectionText } from '../dist/sarif-inspection.cjs';

const BASE = '1111111111111111111111111111111111111111';
const R = '2222222222222222222222222222222222222222';
const SEP = '\n\n---\n\n';
const ATTRIBUTION = '<sub>— T</sub>';
const POINTER = '/runs/0/results/0';

/** Preparation's delivery option for groups delivered by a companion pull request into `feature` (delivery policy §12). */
const COMPANION_GROUPS = {
  delivery: {
    policy: resolveDeliveryPolicy({ caller: { groupedEdits: ['companion'] } }),
    companionTarget: () => Promise.resolve({ headRef: 'feature', ready: false }),
  },
};

/** The reviewed snapshot: the pull request changed line 2 of src/app.js; src/other.js is outside the diff. */
const SNAPSHOT: Readonly<Record<string, string>> = {
  'src/app.js': 'const a = 1;\nconst b = parseA(input);\nconst c = 3;\n',
  'src/other.js': 'export const parse = parseA;\n',
  // A file whose path Markdown cannot show exactly (it begins with a space).
  ' odd.js': 'odd\n',
  // A file with CRLF line endings, outside the diff.
  'src/crlf.js': 'one\r\ntwo\r\n',
};
const BASE_SNAPSHOT: Readonly<Record<string, string>> = {
  'src/app.js': 'const a = 1;\nconst b = oldParse(input);\nconst c = 3;\n',
  'src/other.js': 'export const parse = parseA;\n',
};

const CONTEXT = {
  owner: 'acme',
  repo: 'widgets',
  pullNumber: 7,
  reviewedCommit: R,
  diff: {
    baseCommit: BASE,
    headCommit: R,
    files: [{ path: 'src/app.js', patch: '@@ -1,3 +1,3 @@\n const a = 1;\n-const b = oldParse(input);\n+const b = parseA(input);\n const c = 3;' }],
  },
};

function readSource(commit: string, filePath: string): Promise<string | null> {
  const snapshot = commit === R ? SNAPSHOT : commit === BASE ? BASE_SNAPSHOT : undefined;
  if (snapshot === undefined) return Promise.reject(new Error(`unknown commit ${commit}`));
  return Promise.resolve(Object.hasOwn(snapshot, filePath) ? snapshot[filePath] ?? null : null);
}

function prepare(sarif: unknown, options?: object): Promise<PrepareReviewOutcome> {
  return prepareReview({ sarif, context: CONTEXT, readSource, ...(options === undefined ? {} : { options }) });
}

// ---------------------------------------------------------------------------
// SARIF authoring

type Json = Record<string, unknown>;

/** A fix replacing the text of one line (its newline is kept, SARIF 3.30.x: an omitted endColumn ends before it). */
function lineFix(uri: string, line: number, text: string, description?: string): Json {
  return {
    ...(description === undefined ? {} : { description: { text: description } }),
    artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion: { startLine: line }, insertedContent: { text } }] }],
  };
}

/** A finding at one line of a file, carrying `fixes` in the producer's order. */
function finding(fixes: readonly Json[], text = 'Parsing with parseA is slow.', uri = 'src/app.js', line = 2): Json {
  return { message: { text }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }], fixes };
}

function log(results: readonly Json[]): Json {
  return {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'T' } },
      columnKind: 'utf16CodeUnits',
      versionControlProvenance: [{ repositoryUri: 'https://github.com/acme/widgets', revisionId: R }],
      results,
    }],
  };
}

const PRIMARY = lineFix('src/app.js', 2, 'const b = parseB(input);', 'Use parseB.');
const CACHED = lineFix('src/app.js', 2, 'const b = cachedParse(input);', 'Cache the parse.');
const OTHER_FILE = lineFix('src/other.js', 1, 'export const parse = parseB;');

// ---------------------------------------------------------------------------
// Expected Markdown (the module's rendering grammar, written by hand)

/** The native suggestion for PRIMARY: line 2 of src/app.js becomes its text. */
const PRIMARY_SUGGESTION = ['```suggestion', 'const b = parseB(input);', '```'].join('\n');

/** An item: the finding's message, its first fix's description, its alternatives, then its attribution. */
function item(alternatives: readonly string[], message = 'Parsing with parseA is slow.', fixDescription: string | null = 'Use parseB.'): string {
  const parts = [message];
  if (fixDescription !== null) parts.push(`**Fix:** ${fixDescription}`);
  if (alternatives.length > 0) parts.push('**Alternatives to consider:**', ...alternatives);
  parts.push(ATTRIBUTION);
  return parts.join('\n\n');
}

/** A comment carrying items and the native suggestion. */
const suggestionComment = (...items: readonly string[]): string => `${items.join(SEP)}\n\n${PRIMARY_SUGGESTION}`;

const CACHED_ALTERNATIVE = (n: number): string => [
  `(${String(n)}) Cache the parse.`,
  '',
  'Replace line 2 with:',
  '',
  '```',
  'const b = cachedParse(input);',
  '```',
].join('\n');

const OTHER_FILE_ALTERNATIVE = (n: number): string => [
  `(${String(n)}) Replace line 1 of \`src/other.js\` with:`,
  '',
  '```',
  'export const parse = parseB;',
  '```',
].join('\n');

function assertReady(outcome: PrepareReviewOutcome): asserts outcome is IReadyOutcome {
  assert.equal(outcome.status, 'ready', outcome.markdown);
}

function assertBlocked(outcome: PrepareReviewOutcome, expected: readonly (readonly [code: string, pointer: string | undefined])[]): asserts outcome is IBlockedOutcome {
  if (outcome.status !== 'blocked') throw new assert.AssertionError({ message: `expected blocked, got ready: ${JSON.stringify(outcome.review)}` });
  assert.deepEqual(outcome.diagnostics.map((d) => [d.code, d.location?.pointer]), expected.map(([code, pointer]) => [code, pointer]), outcome.markdown);
  // Review presentation contract §6: a message's later lines are indented two spaces under its list item.
  for (const d of outcome.diagnostics) assert.ok(outcome.markdown.includes(d.message.replace(/\n(?=[^\n])/g, '\n  ')), 'every problem is in the explanation');
}

/**
 * An independent reading of one GFM fenced code block (GFM §4.5): the text
 * after `opening`'s line, up to the first later line that is a backtick run at
 * least as long as the opening fence with nothing else on it.
 */
function fencedBlockAfter(markdown: string, lead: string): { fence: string; content: string } {
  const start = markdown.indexOf(`${lead}\n\n`);
  assert.notEqual(start, -1, `the Markdown has "${lead}"`);
  const lines = markdown.slice(start + lead.length + 2).split('\n');
  const opening = /^(`{3,})$/.exec(lines[0] ?? '');
  assert.ok(opening?.[1], 'a backtick fence opens right after the lead');
  const fence = opening[1];
  const close = lines.findIndex((line, i) => i > 0 && /^`+[ \t]*$/.test(line) && line.trim().length >= fence.length);
  assert.ok(close > 0, 'the fence is closed');
  return { fence, content: lines.slice(1, close).join('\n') };
}

// ---------------------------------------------------------------------------

describe('the first fix is the suggested change; every further fix is listed as an alternative', () => {
  test('two fixes: the first is the native suggestion, the second is listed as alternative (1)', async () => {
    const outcome = await prepare(log([finding([PRIMARY, CACHED])]));
    assertReady(outcome);
    assert.equal(outcome.review.body, '');
    assert.deepEqual(outcome.review.comments, [{ path: 'src/app.js', side: 'RIGHT', line: 2, body: suggestionComment(item([CACHED_ALTERNATIVE(1)])) }]);
    const [evidence] = outcome.evidence;
    assert.ok(evidence?.treatment === 'suggestion');
    // The suggestion is the first fix's exact replacement, never the alternative's.
    assert.deepEqual(evidence.replacement, {
      startLine: 2, endLine: 2, originalText: 'const b = parseA(input);\n', replacementText: 'const b = parseB(input);\n',
    });
    assert.deepEqual(evidence.alternatives, [{
      fix: 1,
      changes: [{
        path: 'src/app.js',
        replacement: { startLine: 2, endLine: 2, originalText: 'const b = parseA(input);\n', replacementText: 'const b = cachedParse(input);\n' },
      }],
    }]);
  });

  test('three fixes: the two alternatives are numbered in the producer\'s order, and the one on another file names it', async () => {
    const outcome = await prepare(log([finding([PRIMARY, CACHED, OTHER_FILE])]));
    assertReady(outcome);
    assert.equal(outcome.review.comments.length, 1);
    assert.equal(outcome.review.comments[0]?.body, suggestionComment(item([CACHED_ALTERNATIVE(1), OTHER_FILE_ALTERNATIVE(2)])));
  });

  test('the producer\'s order decides: reordering the fixes changes which one is suggested', async () => {
    const outcome = await prepare(log([finding([CACHED, PRIMARY])]));
    assertReady(outcome);
    const body = [
      'Parsing with parseA is slow.',
      '',
      '**Fix:** Cache the parse.',
      '',
      '**Alternatives to consider:**',
      '',
      '(1) Use parseB.',
      '',
      'Replace line 2 with:',
      '',
      '```',
      'const b = parseB(input);',
      '```',
      '',
      ATTRIBUTION,
      '',
      '```suggestion',
      'const b = cachedParse(input);',
      '```',
    ].join('\n');
    assert.equal(outcome.review.comments[0]?.body, body);
  });

  test('an alternative on a different file names its path; its lines are that file\'s lines at the reviewed commit', async () => {
    const outcome = await prepare(log([finding([PRIMARY, OTHER_FILE])]));
    assertReady(outcome);
    assert.equal(outcome.review.comments[0]?.body, suggestionComment(item([OTHER_FILE_ALTERNATIVE(1)])));
    const [evidence] = outcome.evidence;
    assert.deepEqual(evidence?.alternatives, [{
      fix: 1,
      changes: [{
        path: 'src/other.js',
        replacement: { startLine: 1, endLine: 1, originalText: 'export const parse = parseA;\n', replacementText: 'export const parse = parseB;\n' },
      }],
    }]);
  });

  test('an alternative whose content contains backtick runs is fenced one backtick longer than its longest run', async () => {
    // Lines 2 becomes three lines; the longest backtick run inside is four.
    const fenced = lineFix('src/app.js', 2, 'const b = md`\n````\n`;');
    const outcome = await prepare(log([finding([PRIMARY, fenced])]));
    assertReady(outcome);
    const alternative = [
      '(1) Replace line 2 with:',
      '',
      '`````',
      'const b = md`',
      '````',
      '`;',
      '`````',
    ].join('\n');
    const body = present(outcome.review.comments[0]?.body);
    assert.equal(body, suggestionComment(item([alternative])));
    // Independently: the block a GFM reader sees holds exactly the replacement lines.
    assert.deepEqual(fencedBlockAfter(body, '(1) Replace line 2 with:'), { fence: '`````', content: 'const b = md`\n````\n`;' });
  });

  test('a triple-backtick run needs a four-backtick fence; content without backticks keeps the minimum of three', async () => {
    const triple = lineFix('src/app.js', 2, 'const b = "```";');
    const outcome = await prepare(log([finding([PRIMARY, triple, CACHED])]));
    assertReady(outcome);
    const body = present(outcome.review.comments[0]?.body);
    assert.equal(body, suggestionComment(item([
      ['(1) Replace line 2 with:', '', '````', 'const b = "```";', '````'].join('\n'),
      CACHED_ALTERNATIVE(2),
    ])));
    assert.deepEqual(fencedBlockAfter(body, '(1) Replace line 2 with:'), { fence: '````', content: 'const b = "```";' });
  });

  test('an alternative that deletes lines says so, with no code block', async () => {
    // Deleting line 2 with its newline: the region ends at line 3, column 1.
    const deletion: Json = {
      artifactChanges: [{ artifactLocation: { uri: 'src/app.js' }, replacements: [{ deletedRegion: { startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 } }] }],
    };
    const outcome = await prepare(log([finding([PRIMARY, deletion])]));
    assertReady(outcome);
    assert.equal(outcome.review.comments[0]?.body, suggestionComment(item(['(1) Delete line 2.'])));
  });

  test('an alternative spanning several lines names the range', async () => {
    const twoLines: Json = {
      artifactChanges: [{ artifactLocation: { uri: 'src/app.js' }, replacements: [{
        deletedRegion: { startLine: 2, startColumn: 11, endLine: 3, endColumn: 13 }, insertedContent: { text: 'parseAll(input);' },
      }] }],
    };
    const outcome = await prepare(log([finding([PRIMARY, twoLines])]));
    assertReady(outcome);
    assert.equal(outcome.review.comments[0]?.body, suggestionComment(item([
      ['(1) Replace lines 2-3 with:', '', '```', 'const b = parseAll(input);', '```'].join('\n'),
    ])));
  });

  test('R8: findings sharing the same first fix share one suggestion, and each keeps its own alternatives', async () => {
    const outcome = await prepare(log([
      finding([PRIMARY, CACHED]),
      finding([PRIMARY, OTHER_FILE], 'Also slow on large inputs.'),
    ]));
    assertReady(outcome);
    assert.equal(outcome.review.comments.length, 1);
    assert.equal(outcome.review.comments[0]?.body, suggestionComment(
      item([CACHED_ALTERNATIVE(1)]),
      item([OTHER_FILE_ALTERNATIVE(1)], 'Also slow on large inputs.'),
    ));
  });

  test('alternatives are never applied: one overlapping another finding\'s suggestion does not conflict with it', async () => {
    const lineThree = lineFix('src/app.js', 3, 'const c = 4;');
    const outcome = await prepare(log([
      finding([PRIMARY, lineThree]),
      finding([lineFix('src/app.js', 3, 'const c = 5;')], 'Wrong constant.', 'src/app.js', 3),
    ]));
    assertReady(outcome);
    assert.deepEqual(outcome.review.comments.map((c) => [c.path, c.line]), [['src/app.js', 2], ['src/app.js', 3]]);
    assert.equal(outcome.review.comments[1]?.body, ['Wrong constant.', '', ATTRIBUTION, '', '```suggestion', 'const c = 5;', '```'].join('\n'));
  });

  test('a finding with one fix is rendered exactly as before: no alternatives heading', async () => {
    const outcome = await prepare(log([finding([PRIMARY])]));
    assertReady(outcome);
    assert.equal(outcome.review.comments[0]?.body, suggestionComment(item([])));
    assert.equal(outcome.evidence[0]?.alternatives, undefined);
  });
});

describe('no semantic judgment: the first fix is presented as a single fix would be', () => {
  test('an ineligible first fix blocks as it would alone; an eligible later fix is never promoted', async () => {
    // src/other.js is outside the diff, so its first fix cannot be a native suggestion (delivery policy §8.9).
    const outcome = await prepare(log([finding([OTHER_FILE, PRIMARY], 'Parse elsewhere.', 'src/other.js', 1)]));
    assertBlocked(outcome, [['delivery-unavailable', POINTER]]);
    assert.ok(outcome.diagnostics[0]?.message.includes('The edit of `src/other.js` line 1 cannot be delivered.'), outcome.markdown);
  });

  test('regression: a failed first fix adds no spurious path refusal for an alternative on the same file', async () => {
    // ' odd.js' is outside the diff, so the first fix cannot be native; its alternative on the same file names no path.
    const outcome = await prepare(log([finding([lineFix('%20odd.js', 1, 'even'), lineFix('%20odd.js', 1, 'odder')], 'Odd.', '%20odd.js', 1)]));
    assertBlocked(outcome, [['delivery-unavailable', POINTER]]);
    assert.equal(outcome.diagnostics.length, 1);
  });

  test('every alternative\'s problems are reported at once; the first fix\'s delivery is judged once the document is valid', async () => {
    const outcome = await prepare(log([finding([
      lineFix('src/app.js', 2, 'const b = "```";'),
      lineFix('src/app.js', 40, 'x'),
    ])]));
    assertBlocked(outcome, [['replacement-invalid', `${POINTER}/fixes/1`]]);
    const valid = await prepare(log([finding([lineFix('src/app.js', 2, 'const b = "```";'), CACHED])]));
    assertBlocked(valid, [['delivery-unavailable', POINTER]]);
    assert.ok(valid.diagnostics[0]?.message.endsWith('- `native`: GitHub applied a nested ``` suggestion as a deletion; this replacement cannot be a native suggestion.'), valid.markdown);
  });
});

describe('an alternative that cannot be listed faithfully refuses the whole review, at its own pointer', () => {
  const blocked = (name: string, alternative: Json, code: string, index = 1) => {
    test(name, async () => {
      const fixes = index === 1 ? [PRIMARY, alternative] : [PRIMARY, CACHED, alternative];
      const outcome = await prepare(log([finding(fixes)]));
      assertBlocked(outcome, [[code, `${POINTER}/fixes/${String(index)}`]]);
    });
  };

  blocked('an alternative whose two replacements overlap, so their combined effect is not defined', {
    artifactChanges: [{ artifactLocation: { uri: 'src/app.js' }, replacements: [
      { deletedRegion: { startLine: 2, startColumn: 1, endColumn: 10 }, insertedContent: { text: 'let b =' } },
      { deletedRegion: { startLine: 2, startColumn: 7, endColumn: 17 }, insertedContent: { text: 'b = parseB' } },
    ] }],
  }, 'fix-replacements-overlap');
  blocked('a part of a multi-file alternative on a file the reviewed commit does not have', {
    artifactChanges: [
      { artifactLocation: { uri: 'src/app.js' }, replacements: [{ deletedRegion: { startLine: 2 }, insertedContent: { text: 'x' } }] },
      { artifactLocation: { uri: 'src/missing.js' }, replacements: [{ deletedRegion: { startLine: 1 }, insertedContent: { text: 'y' } }] },
    ],
  }, 'source-file-missing');
  blocked('a part of a multi-file alternative whose path Markdown cannot show exactly', {
    artifactChanges: [
      { artifactLocation: { uri: 'src/app.js' }, replacements: [{ deletedRegion: { startLine: 2 }, insertedContent: { text: 'x' } }] },
      { artifactLocation: { uri: '%20odd.js' }, replacements: [{ deletedRegion: { startLine: 1 }, insertedContent: { text: 'y' } }] },
    ],
  }, 'alternative-path-unrepresentable');
  blocked('an alternative mixing CRLF and LF line endings, which one stated style cannot describe',
    lineFix('src/crlf.js', 2, 'deux\ntrois'), 'alternative-content-unrepresentable');
  blocked('an alternative inserting binary content', {
    artifactChanges: [{ artifactLocation: { uri: 'src/app.js' }, replacements: [{ deletedRegion: { startLine: 2 }, insertedContent: { binary: 'AAAA' } }] }],
  }, 'fix-binary-unsupported');
  blocked('the third fix naming a line the reviewed file does not have', lineFix('src/app.js', 40, 'x'), 'replacement-invalid', 2);
  blocked('an alternative on a file the reviewed commit does not have', lineFix('src/missing.js', 1, 'x'), 'source-file-missing');
  blocked('an alternative whose content could open a suggestion block', lineFix('src/app.js', 2, 'const b = md`\n```suggestion\n`;'), 'alternative-suggestion-fence');
  blocked('an alternative whose content hides a bidirectional override', lineFix('src/app.js', 2, 'const b = parseB(input); // ‮'), 'alternative-content-unrepresentable');
  blocked('an alternative on another file whose path Markdown cannot show exactly', lineFix('%20odd.js', 1, 'even'), 'alternative-path-unrepresentable');
  blocked('an alternative whose content has a carriage return that does not end a line', lineFix('src/app.js', 2, 'const b = 1;\rconst d = 2;'), 'alternative-content-unrepresentable');
  // Format characters (Unicode category Cf) and U+00A0 cannot be shown exactly either (review presentation contract §4).
  blocked('an alternative whose content holds a zero-width space', lineFix('src/app.js', 2, 'const b\u200B = 1;'), 'alternative-content-unrepresentable');
  blocked('an alternative whose content holds a soft hyphen', lineFix('src/app.js', 2, 'const b\u00AD = 1;'), 'alternative-content-unrepresentable');
  blocked('an alternative whose content holds a no-break space', lineFix('src/app.js', 2, 'const b\u00A0= 1;'), 'alternative-content-unrepresentable');
  test('a tag character is named by its full code point', async () => {
    const outcome = await prepare(log([finding([PRIMARY, lineFix('src/app.js', 2, 'const b = 1; // \u{E0041}')])]));
    assertBlocked(outcome, [['alternative-content-unrepresentable', `${POINTER}/fixes/1`]]);
    assert.equal(outcome.diagnostics[0]?.message, 'Alternative fix (1) cannot be shown exactly: replacement line 1 contains U+E0041, which a code block does not show.');
  });

  test('the refusal names the alternative and what it would need', async () => {
    const outcome = await prepare(log([finding([PRIMARY, lineFix('src/app.js', 2, 'const b = parseB(input); // ‮')])]));
    assertBlocked(outcome, [['alternative-content-unrepresentable', `${POINTER}/fixes/1`]]);
    assert.equal(outcome.diagnostics[0]?.message,
      'Alternative fix (1) cannot be shown exactly: replacement line 1 contains U+202E, which a code block does not show.');
  });
});

describe('an alternative with several parts is listed as one alternative with labelled parts', () => {
  test('an alternative changing two files lists each file\'s part, in the producer\'s order', async () => {
    const both: Json = {
      description: { text: 'Switch both.' },
      artifactChanges: [
        { artifactLocation: { uri: 'src/app.js' }, replacements: [{ deletedRegion: { startLine: 2 }, insertedContent: { text: 'const b = parseAll(input);' } }] },
        { artifactLocation: { uri: 'src/other.js' }, replacements: [{ deletedRegion: { startLine: 1 }, insertedContent: { text: 'export const parse = parseAll;' } }] },
      ],
    };
    const outcome = await prepare(log([finding([PRIMARY, both])]));
    assertReady(outcome);
    assert.equal(outcome.review.comments[0]?.body, suggestionComment(item([[
      '(1) Switch both.',
      '',
      'Changes 2 files together:',
      '',
      '`src/app.js` — replace line 2 with:',
      '',
      '```',
      'const b = parseAll(input);',
      '```',
      '',
      '`src/other.js` — replace line 1 with:',
      '',
      '```',
      'export const parse = parseAll;',
      '```',
    ].join('\n')])));
    assert.deepEqual(outcome.evidence[0]?.alternatives, [{
      fix: 1,
      changes: [
        { path: 'src/app.js', replacement: { startLine: 2, endLine: 2, originalText: 'const b = parseA(input);\n', replacementText: 'const b = parseAll(input);\n' } },
        { path: 'src/other.js', replacement: { startLine: 1, endLine: 1, originalText: 'export const parse = parseA;\n', replacementText: 'export const parse = parseAll;\n' } },
      ],
    }]);
  });

  test('an alternative with several replacements in one file lists each replacement, a deletion without a block', async () => {
    const two: Json = {
      artifactChanges: [{ artifactLocation: { uri: 'src/app.js' }, replacements: [
        { deletedRegion: { startLine: 1 }, insertedContent: { text: 'const a = 2;' } },
        // Deleting line 3 with its newline: the region ends at the end-of-file position (line 4, column 1).
        { deletedRegion: { startLine: 3, startColumn: 1, endLine: 4, endColumn: 1 } },
      ] }],
    };
    const outcome = await prepare(log([finding([PRIMARY, two])]));
    assertReady(outcome);
    assert.equal(outcome.review.comments[0]?.body, suggestionComment(item([[
      '(1) Makes 2 changes together:',
      '',
      '`src/app.js` — replace line 1 with:',
      '',
      '```',
      'const a = 2;',
      '```',
      '',
      '`src/app.js` — delete line 3.',
    ].join('\n')])));
  });
});

describe('an alternative\'s replacements are read as a fix with several changes is', () => {
  test('two replacements on the same line are one whole-line change, shown as a one-part alternative', async () => {
    // SARIF 3.57: both regions are in the unmodified line; applied together, line 2 becomes one line.
    const sameLine: Json = {
      artifactChanges: [{ artifactLocation: { uri: 'src/app.js' }, replacements: [
        { deletedRegion: { startLine: 2, startColumn: 1, endColumn: 6 }, insertedContent: { text: 'let' } },
        { deletedRegion: { startLine: 2, startColumn: 11, endColumn: 17 }, insertedContent: { text: 'parseB' } },
      ] }],
    };
    const outcome = await prepare(log([finding([PRIMARY, sameLine])]));
    assertReady(outcome);
    assert.equal(outcome.review.comments[0]?.body, suggestionComment(item([
      ['(1) Replace line 2 with:', '', '```', 'let b = parseB(input);', '```'].join('\n'),
    ])));
    assert.deepEqual(outcome.evidence[0]?.alternatives, [{
      fix: 1,
      changes: [{ path: 'src/app.js', replacement: { startLine: 2, endLine: 2, originalText: 'const b = parseA(input);\n', replacementText: 'let b = parseB(input);\n' } }],
    }]);
  });
  test('the heading counts changes, not replacements: three replacements, two on one line, make two changes', async () => {
    const three: Json = {
      artifactChanges: [{ artifactLocation: { uri: 'src/app.js' }, replacements: [
        { deletedRegion: { startLine: 2, startColumn: 1, endColumn: 6 }, insertedContent: { text: 'let' } },
        { deletedRegion: { startLine: 2, startColumn: 11, endColumn: 17 }, insertedContent: { text: 'parseB' } },
        { deletedRegion: { startLine: 3 }, insertedContent: { text: 'const c = 4;' } },
      ] }],
    };
    const outcome = await prepare(log([finding([PRIMARY, three])]));
    assertReady(outcome);
    assert.equal(outcome.review.comments[0]?.body, suggestionComment(item([[
      '(1) Makes 2 changes together:',
      '',
      '`src/app.js` — replace line 2 with:',
      '',
      '```',
      'let b = parseB(input);',
      '```',
      '',
      '`src/app.js` — replace line 3 with:',
      '',
      '```',
      'const c = 4;',
      '```',
    ].join('\n')])));
  });
});

describe('a first fix with several changes (issue #29) keeps its alternatives', () => {
  // The first fix changes lines 2 and 3 together; the finding on line 2 lies within one of them.
  const joint: Json = {
    description: { text: 'Use parseB and its limit.' },
    artifactChanges: [{ artifactLocation: { uri: 'src/app.js' }, replacements: [
      { deletedRegion: { startLine: 2 }, insertedContent: { text: 'const b = parseB(input);' } },
      { deletedRegion: { startLine: 3 }, insertedContent: { text: 'const c = 4;' } },
    ] }],
  };

  test('under the default policy the first fix is a native batch, each change a suggestion; its alternatives are listed with the finding, never applied', async () => {
    // Delivery policy §8.8: lines 2 and 3 are in the reviewed diff's hunk, so each change can be a
    // native suggestion; each change's comment holds the finding, alternatives included.
    const outcome = await prepare(log([finding([joint, CACHED])]));
    assertReady(outcome);
    const listed = item([CACHED_ALTERNATIVE(1)], 'Parsing with parseA is slow.', 'Use parseB and its limit.');
    const note = '**Fix with 2 changes:** apply this suggestion together with the fix\'s other suggestions, listed in the review body.';
    assert.deepEqual(outcome.review.comments.map((c) => [c.line, c.body]), [
      [2, `${listed}\n\n${note}\n\n\`\`\`suggestion\nconst b = parseB(input);\n\`\`\``],
      [3, `${listed}\n\n${note}\n\n\`\`\`suggestion\nconst c = 4;\n\`\`\``],
    ]);
    assert.equal(outcome.review.body, '**Fix with 2 changes:** apply these 2 suggestions together, in one commit: add each of them to one batch of suggestions on the pull request, then commit the batch. Nothing checks that they are applied together.\n\n- `src/app.js` line 2\n- `src/app.js` line 3');
  });

  test('delivered by a companion, only the first fix is committed, and the alternatives are listed with the finding', async () => {
    const outcome = await prepare(log([finding([joint, CACHED])]), COMPANION_GROUPS);
    assertReady(outcome);
    assert.deepEqual(outcome.review.comments, []);
    const [companion] = outcome.suggestions?.companions ?? [];
    assert.ok(companion);
    assert.deepEqual(companion.changes, [{ operation: 'edit', path: 'src/app.js', text: 'const a = 1;\nconst b = parseB(input);\nconst c = 4;\n' }]);
    assert.equal(companion.sections[0]?.items, [
      `**Source:** [src/app.js line 2 at 2222222](https://github.com/acme/widgets/blob/${R}/src/app.js?plain=1#L2)`,
      '',
      '```',
      'const b = parseA(input);',
      '```',
      '',
      // The first fix changes one file, so the alternative on it names no file.
      item([CACHED_ALTERNATIVE(1)], 'Parsing with parseA is slow.', 'Use parseB and its limit.'),
    ].join('\n'));
  });

  test('when the first fix changes several files, a one-part alternative names its file', async () => {
    const twoFiles: Json = {
      artifactChanges: [
        { artifactLocation: { uri: 'src/app.js' }, replacements: [{ deletedRegion: { startLine: 2 }, insertedContent: { text: 'const b = parseB(input);' } }] },
        { artifactLocation: { uri: 'src/other.js' }, replacements: [{ deletedRegion: { startLine: 1 }, insertedContent: { text: 'export const parse = parseB;' } }] },
      ],
    };
    const outcome = await prepare(log([finding([twoFiles, CACHED])]), COMPANION_GROUPS);
    assertReady(outcome);
    const items = present(outcome.suggestions?.companions[0]?.sections[0]?.items);
    assert.ok(items.includes(['(1) Cache the parse.', '', 'Replace line 2 of `src/app.js` with:'].join('\n')), items);
  });
});

describe('CRLF alternatives: the line-ending style is stated, and the block holds the lines', () => {
  test('a CRLF replacement is shown with LF line breaks and "CRLF line endings" stated; no carriage return reaches the body', async () => {
    const outcome = await prepare(log([finding([PRIMARY, lineFix('src/crlf.js', 2, 'deux\r\ntrois')])]));
    assertReady(outcome);
    const body = present(outcome.review.comments[0]?.body);
    assert.equal(body, suggestionComment(item([[
      '(1) Replace line 2 of `src/crlf.js` with (CRLF line endings):',
      '',
      '```',
      'deux',
      'trois',
      '```',
    ].join('\n')])));
    assert.equal(body.includes('\r'), false);
    // The evidence keeps the exact replacement, terminators included.
    assert.deepEqual(outcome.evidence[0]?.alternatives?.[0]?.changes[0]?.replacement,
      { startLine: 2, endLine: 2, originalText: 'two\r\n', replacementText: 'deux\r\ntrois\r\n' });
  });

  test('a one-line CRLF replacement states the style of the terminator it keeps', async () => {
    const outcome = await prepare(log([finding([PRIMARY, lineFix('src/crlf.js', 1, 'uno')])]));
    assertReady(outcome);
    assert.equal(outcome.review.comments[0]?.body, suggestionComment(item([
      ['(1) Replace line 1 of `src/crlf.js` with (CRLF line endings):', '', '```', 'uno', '```'].join('\n'),
    ])));
  });
});

describe('alternatives count toward the size limit; nothing is truncated', () => {
  const sarif = log([finding([PRIMARY, CACHED])]);
  const expected = suggestionComment(item([CACHED_ALTERNATIVE(1)]));
  const withoutAlternatives = suggestionComment(item([]));

  test('a comment exactly at the limit, alternatives included, is ready', async () => {
    const outcome = await prepare(sarif, { maxCommentBodyChars: expected.length });
    assertReady(outcome);
    assert.equal(outcome.review.comments[0]?.body, expected);
  });

  test('one character over the limit refuses the whole review, although the finding alone would fit', async () => {
    const limit = expected.length - 1;
    assert.ok(withoutAlternatives.length <= limit, 'only the alternatives take the comment over the limit');
    assertReady(await prepare(log([finding([PRIMARY])]), { maxCommentBodyChars: limit }));
    const outcome = await prepare(sarif, { maxCommentBodyChars: limit });
    assertBlocked(outcome, [['comment-too-large', undefined]]);
    assert.ok(outcome.markdown.includes(`Inline comment 0 is ${String(expected.length)} characters; the limit is ${String(limit)}.`), outcome.markdown);
  });
});

describe('inspect lists every fix of a finding with alternatives', () => {
  test('the view and the text list all three fixes, in order', () => {
    const outcome = inspectSarif(log([finding([PRIMARY, CACHED, OTHER_FILE])]));
    if (outcome.status !== 'inspected') throw new assert.AssertionError({ message: `SARIF refused: ${outcome.markdown}` });
    const { view } = outcome;
    assert.equal(view.summary.fixes, 3);
    assert.deepEqual(view.findings[0]?.fixes.map((f) => [f.ref, f.description, f.changes.map((c) => c.path)]), [
      [`${POINTER}/fixes/0`, 'Use parseB.', ['src/app.js']],
      [`${POINTER}/fixes/1`, 'Cache the parse.', ['src/app.js']],
      [`${POINTER}/fixes/2`, undefined, ['src/other.js']],
    ]);
    const text = renderInspectionText(view);
    for (const line of [
      `Fix 1 of 3 (${POINTER}/fixes/0): Use parseB.`,
      `Fix 2 of 3 (${POINTER}/fixes/1): Cache the parse.`,
      `Fix 3 of 3 (${POINTER}/fixes/2)`,
    ]) assert.ok(text.split('\n').includes(line), `inspection shows "${line}":\n${text}`);
  });
});

/** A value the preceding assertions establish is present. */
function present<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
