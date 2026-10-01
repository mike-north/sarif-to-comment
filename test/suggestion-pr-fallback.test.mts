/**
 * What happens when a companion suggestion pull request cannot be made:
 * after a rewritten history, when its projection onto the head is unfaithful
 * (it would bring back content the rewrite removed, or its change cannot be
 * expressed at the head, or the projection cannot decide); for a pull
 * request from a fork or into a base that is not the default branch; and for
 * a change too large for one. A suggestion pull request projected to
 * conflict, and nothing worse, is still made, with a warning.
 * Through the production composition: the real public library and CLI with
 * the real GitHub client (src/github.cts), talking HTTP to the fake GitHub
 * host of test/fixtures/rewritten-history. Only `fetch` is replaced.
 *
 * Under the delivery policy (docs/delivery-policy-contract.md), each such
 * case is an obstacle of `companion` for that unit (companion contract
 * §2.5.1), and the unit is delivered by the next mechanism its list names,
 * or the review is blocked. These tests use the lists that do what the
 * removed `allowSuggestionPullRequests: true` did (issue #37):
 *
 * | Change                                | List                         | Behaviour                                                  |
 * | ------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
 * | whole-file creation or deletion       | `fileOperations: [companion, manual]` | the review-body proposal; published with a `delivery-fallback` warning |
 * | explicit group, or a multi-change fix | `groupedEdits: [companion]`  | blocked with `delivery-unavailable` before any write       |
 *
 * Each message names the unit, its list, where the list was set, and every
 * obstacle (§10.1, §10.2). A published or ready outcome with warnings states
 * them directly under its heading, and carries them in `diagnostics`
 * (library, JSON, TOON) and as blocks on stderr (human CLI); a blocked one
 * carries no fallback warning. `validate` reports exactly what `publish`
 * would do, before anything is written.
 *
 * Expected texts are written by hand from the contracts; the review body of
 * a fallback is additionally compared with the body the same document gets
 * under the default policy, which is what `manual` is. Each projection's
 * verdict follows the contract's table for the world's heads: every
 * suggestion pull request stays on the reviewed commit C1, so it also
 * carries C1's own change of lines 5 and 6 of docs/sample.md, which each
 * head kept (C1′), changed again (C1″), dropped (D) or kept moved (E).
 *
 * @see https://github.com/mike-north/sarif-to-comment/issues/37
 * @see docs/delivery-policy-contract.md §10
 * @see docs/companion-suggestion-pr-contract.md §2.5.1
 * @see docs/file-operation-publication-contract.md
 * @see docs/diagnostics.md
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { decode } from '@toon-format/toon';

import {
  AMENDED, ATTRIBUTION, CLI, DROPPED, MOVED, NEW_MESSAGE, NOT_TEXT, OBSOLETE_MESSAGE, OVERSIZE, OWNER, PULL, REMARK, REPO, REVIEWED, REVIEW_MARKER,
  REWRITTEN, SHORT, TOKEN, blob, call, documentWith, jointFixDocument, makeWorld, markdown, proposalCommit, pullUrl, reviewDocument, status, writes,
} from './fixtures/rewritten-history/world.mts';
import type { DocumentPart, IWorld, Json } from './fixtures/rewritten-history/world.mts';
import { assertDiagnostics } from './support/diagnostics.mts';
import { asArray, asRecord, asString, parseJson } from './support/runtime-types.mts';

// ---------------------------------------------------------------------------
// Expected texts, written from docs/delivery-policy-contract.md §10 and the
// companion contract's obstacles (§2.5.1)

const FALLBACK_TITLE = 'A proposal is delivered by a later mechanism of its delivery list';
const FALLBACK_REMEDIES = [
  'To use an earlier mechanism, remove the obstacle the message names, then publish again.',
  'To refuse rather than fall back, list only the mechanism you require.',
];
const REFUSAL_TITLE = 'No delivery mechanism the policy lists is available for a proposal';
const REFUSAL_REMEDIES = [
  'Remove the obstacle the message names, then publish again.',
  'Or list a mechanism that is available for this kind of proposal (`--edits`, `--grouped-edits`, `--file-operations`, the `delivery` option, or `.github/sarif-to-comment.json`).',
];
/** The remedies the companion obstacles carry (delivery policy §8.9), first among a diagnostic's remedies. */
const REVIEW_AGAIN = "Review the pull request's current head again, and publish that review.";
const FILE_OPERATIONS = '`fileOperations` is `[companion, manual]`, set by the caller (`--file-operations`, `delivery.fileOperations`)';
const GROUPED_EDITS = '`groupedEdits` is `[companion]`, set by the caller (`--grouped-edits`, `delivery.groupedEdits`)';

/** How the policy names a whole-file change. */
const CREATION = 'The creation of `docs/new.md`';
const DELETION = 'The deletion of `obsolete.txt`';

/** The obstacle of an unfaithful projection onto `head` (companion contract §2.5.1), its reasons in path order. */
function rewritten(head: string, reasons: readonly string[]): string {
  return `The history of #7 was rewritten after the reviewed commit, and projected onto its head \`${head}\`, merging its suggestion pull request would not apply exactly its own changes: ${reasons.join('; ')}.`;
}

/** The obstacle of a projection onto `head` that cannot decide (§2.5.1). */
function unprojectable(head: string, limits: readonly string[]): string {
  return `The history of #7 was rewritten after the reviewed commit, and whether merging its suggestion pull request into the head \`${head}\` would apply exactly its own changes cannot be projected: ${limits.join('; ')}.`;
}

/** The projection's reasons (§2.5.1). */
const RESTORES_SAMPLE = '`docs/sample.md` would bring back content the head no longer has';
const RESTORES_SAMPLE_BESIDE_CONFLICT = '`docs/sample.md` would bring back content the head no longer has, beside a conflict';
const CONFLICT_TITLE = 'A suggestion pull request is projected to conflict with the pull request\'s head';

/** Delivery policy §10.3: the warning for a suggestion pull request projected to conflict. */
function conflictWarning(head: string, unit: string, paths: readonly string[], pointer = '/runs/0/results/0'): Json {
  return {
    severity: 'warning',
    code: 'companion-conflicts-at-head',
    title: CONFLICT_TITLE,
    message: `Projected onto the head \`${head}\` of #7, merging the suggestion pull request for ${unit} would conflict in ${paths.map((p) => `\`${p}\``).join(' and ')}. `
      + 'It is created on the reviewed commit, as planned; GitHub shows the conflict to whoever merges it.',
    location: { pointer },
    remedies: ['Review the pull request\'s current head again, and publish that review.', 'Or resolve the conflict when merging the suggestion pull request.'],
  };
}

/** The fallback warning's message: the unit, the mechanism used, its list and the companion's obstacles. */
function fallbackFor(change: string, ...obstacles: readonly string[]): string {
  return `${change} is delivered as \`manual\`. ${FILE_OPERATIONS}, and the mechanisms listed before it are unavailable:\n\n- \`companion\`: ${obstacles.join(' ')}`;
}

/** The fallback warning as a diagnostic, after a rewritten history. */
function fallback(pointer: string, change: string, head: string, reasons: readonly string[]): Json {
  return fallbackDiagnostic(pointer, fallbackFor(change, rewritten(head, reasons)), [REVIEW_AGAIN]);
}

/** A fallback warning with its message. */
function fallbackDiagnostic(pointer: string, message: string, specific: readonly string[] = []): Json {
  return { severity: 'warning', code: 'delivery-fallback', title: FALLBACK_TITLE, message, location: { pointer }, remedies: [...specific, ...FALLBACK_REMEDIES] };
}

/** The block of the group `reword` for any obstacle of its companion. */
function groupRefusalFor(...obstacles: readonly string[]): string {
  return `The group \`reword\` cannot be delivered. ${GROUPED_EDITS}, and no mechanism it lists is available:\n\n- \`companion\`: ${obstacles.join(' ')}`;
}

/** The block of the group `reword` after a rewritten history. */
function groupRefusalMessage(head: string, reasons: readonly string[]): string {
  return groupRefusalFor(rewritten(head, reasons));
}

/** The block of a fix with two changes, in the same terms. */
function fixRefusalMessage(head: string, reasons: readonly string[]): string {
  return `The fix with 2 changes at \`/runs/0/results/0\` cannot be delivered. ${GROUPED_EDITS}, and no mechanism it lists is available:\n\n`
    + `- \`companion\`: ${rewritten(head, reasons)}`;
}

function refusal(message: string, specific: readonly string[] = [], pointer = '/runs/0/results/0'): Json {
  return { severity: 'error', code: 'delivery-unavailable', title: REFUSAL_TITLE, message, location: { pointer }, remedies: [...specific, ...REFUSAL_REMEDIES] };
}

/** The paragraph a block after the plan ends with when a fallback put `change` in the review body (§10.1). */
const bodyFallbackCause = (change: string): string => `\n\nThis includes a proposal delivered by a fallback: ${change.charAt(0).toLowerCase()}${change.slice(1)} is delivered as \`manual\`, `
  + 'because `fileOperations` is `[companion, manual]` and the mechanisms listed before it (`companion`) are unavailable.';

/** The diagnostics of a block under the default policy, with the fallback's paragraph added to each error (§10.1). */
const withFallbackCause = (outcome: Json, change: string): unknown[] => diagnosticsOf(outcome).map((d) => {
  const diagnostic = asRecord(d);
  return diagnostic['severity'] === 'error' ? { ...diagnostic, message: `${asString(diagnostic['message'])}${bodyFallbackCause(change)}` } : diagnostic;
});

/** The headline under a published outcome's heading for `count` fallbacks and nothing else. */
function publishedHeadline(count: number): string {
  return count === 1
    ? `**Published with 1 warning:** ${FALLBACK_TITLE}.`
    : `**Published with ${String(count)} warnings:** ${FALLBACK_TITLE} (${String(count)} times).`;
}

/** The same headline under `validate`'s "Ready to publish". */
function readyHeadline(count: number): string {
  return count === 1
    ? `**Ready to publish with 1 warning:** ${FALLBACK_TITLE}.`
    : `**Ready to publish with ${String(count)} warnings:** ${FALLBACK_TITLE} (${String(count)} times).`;
}

/** The problem line blocked Markdown lists for a diagnostic (its code, pointer and message). */
/** Review presentation contract §6: a diagnostic's line, its message's later lines indented two spaces under its item. */
const problemLine = (d: Json): string =>
  `- \`${asString(d['code'])}\` at \`${asString(asRecord(d['location'])['pointer'])}\`: ${asString(d['message']).replace(/\n(?=[^\n])/g, '\n  ')}`;

// Review-body proposals exactly as without suggestion pull requests
// (docs/file-operation-publication-contract.md; the grammar in src/prepare-review.cts's header).

const DELETION_PROPOSAL = [
  `**Proposed file deletion:** [obsolete.txt at ${SHORT}](${blob('obsolete.txt')})`,
  '',
  'The whole file is removed; this is not a proposal to empty it.',
  '',
  OBSOLETE_MESSAGE, '', ATTRIBUTION,
].join('\n');
const CREATION_PROPOSAL = [
  '**Proposed new file:** `docs/new.md`',
  '',
  '**File details:** 6 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
  '',
  '```', '# New', '```',
  '',
  '**Location:** line 1 of the proposed file',
  '',
  NEW_MESSAGE, '', ATTRIBUTION,
].join('\n');
const REMARK_SECTION = [REMARK, '', ATTRIBUTION].join('\n');
const SEPARATOR = '\n\n---\n\n';

// ---------------------------------------------------------------------------
// Harness

const publishDoc = (world: IWorld, sarif: Json): Promise<Json> => call('publishSarifReview', world, sarif);
const validateDoc = (world: IWorld, sarif: Json): Promise<Json> => call('validateSarifReview', world, sarif);

/** The body of the only review `world` received, without its hidden marker. */
function reviewBodyOf(world: IWorld): string {
  const reviews = world.host.reviews();
  assert.equal(reviews.length, 1, 'exactly one review');
  const [review] = reviews;
  assert.ok(review);
  return review.request.body.replace(REVIEW_MARKER, '');
}

/** The review body the same document gets on the same head with suggestion pull requests disallowed. */
async function disallowedBody(head: string, sarif: Json): Promise<string> {
  const world = makeWorld(head);
  const outcome = await call('publishSarifReview', world, sarif, false);
  assert.equal(status(outcome), 'published', markdown(outcome));
  return reviewBodyOf(world);
}

const diagnosticsOf = (outcome: Json): unknown[] => asArray(outcome['diagnostics'], 'outcome diagnostics');

/**
 * Asserts that an outcome's `diagnostics` are exactly `expected`, and that
 * they are schema-valid, ordered, and carry the severity and title the
 * documented catalog (docs/diagnostics.md) gives their codes.
 */
function assertExactDiagnostics(outcome: Json, expected: readonly Json[]): void {
  assertDiagnostics(outcome['diagnostics'], expected.map((e) => ({
    code: asString(e['code']),
    location: asRecord(e['location']),
    remedies: e['remedies'] === undefined ? [] : asArray(e['remedies']).map((r) => asString(r)),
  })));
  assert.deepEqual(diagnosticsOf(outcome), expected);
}

/** Nothing reached GitHub and no publication state exists. */
function assertNothingWritten(world: IWorld): void {
  assert.deepEqual(writes(world), [], 'no write reached GitHub');
  assert.equal(fs.existsSync(world.statePath), false, 'no publication state');
  assert.deepEqual(world.host.pulls(), []);
  assert.deepEqual(world.host.reviews(), []);
}

/** A published outcome: heading, then the headline, then the sentence that names the draft. */
function assertPublishedHeadline(outcome: Json, headline: string): void {
  const text = markdown(outcome);
  assert.ok(text.startsWith(`## Draft review published\n\n${headline}\n\nCreated the draft [review `), text);
}

/** A ready outcome: heading, then the headline, then the sentence that says it can be published. */
function assertReadyHeadline(outcome: Json, headline: string): void {
  const text = markdown(outcome);
  assert.ok(text.startsWith(`## Ready to publish\n\n${headline}\n\nThe complete document can be published faithfully to ${OWNER}/${REPO}#${String(PULL)}`), text);
}

// ---------------------------------------------------------------------------

describe('a whole-file creation whose projection is unfaithful falls back to the review-body proposal (#37, table row 1)', () => {
  const parts: readonly DocumentPart[] = ['create', 'remark'];

  for (const [head, reason] of [
    // D dropped C1's lines 5 and 6, which the suggestion pull request, on C1, would bring back.
    [DROPPED, RESTORES_SAMPLE],
    // E has a directory where the new file would go.
    [MOVED, '`docs/new.md` would be both a file and a directory'],
  ] as const) {
    test(`publish: no suggestion pull request; the review proposes the new file exactly as without suggestion pull requests (${reason})`, async () => {
      const world = makeWorld(head);
      const outcome = await publishDoc(world, documentWith(parts));
      assert.equal(status(outcome), 'published', markdown(outcome));
      assert.deepEqual(world.host.pulls(), []);
      assert.equal(outcome['suggestions'], undefined);
      assert.deepEqual(writes(world), [`/pulls/${String(PULL)}/reviews`], 'only the review is written: no branch, pull request or label');
      assert.equal(reviewBodyOf(world), [CREATION_PROPOSAL, REMARK_SECTION].join(SEPARATOR));
      assert.equal(reviewBodyOf(world), await disallowedBody(head, documentWith(parts)));
      assertExactDiagnostics(outcome, [fallback('/runs/0/results/0', CREATION, head, [reason])]);
      assertPublishedHeadline(outcome, publishedHeadline(1));
    });

    test(`validate reports the same outcome and warning, and writes nothing (${reason})`, async () => {
      const world = makeWorld(head);
      const assessed = await validateDoc(world, documentWith(parts));
      assert.equal(status(assessed), 'ready', markdown(assessed));
      assertExactDiagnostics(assessed, [fallback('/runs/0/results/0', CREATION, head, [reason])]);
      assertReadyHeadline(assessed, readyHeadline(1));
      assert.doesNotMatch(markdown(assessed), /Publication would also create/);
      assertNothingWritten(world);
    });
  }
});

describe('a whole-file deletion whose projection is unfaithful falls back to the review-body proposal (#37, table row 1)', () => {
  const parts: readonly DocumentPart[] = ['delete', 'remark'];

  for (const [head, reason] of [
    // C1″ changed the file the suggestion deletes.
    [REWRITTEN, 'its change to `obsolete.txt` cannot be expressed at the head'],
    [DROPPED, RESTORES_SAMPLE],
  ] as const) {
    test(`publish and validate: the deletion is proposed in the review body, with a structured warning (${reason})`, async () => {
      const assessedWorld = makeWorld(head);
      const assessed = await validateDoc(assessedWorld, documentWith(parts));
      assertNothingWritten(assessedWorld);
      const world = makeWorld(head);
      const outcome = await publishDoc(world, documentWith(parts));
      assert.equal(status(outcome), 'published', markdown(outcome));
      assert.deepEqual(world.host.pulls(), []);
      assert.equal(reviewBodyOf(world), [DELETION_PROPOSAL, REMARK_SECTION].join(SEPARATOR));
      assert.equal(reviewBodyOf(world), await disallowedBody(head, documentWith(parts)));
      const expected = [fallback('/runs/0/results/0', DELETION, head, [reason])];
      assertExactDiagnostics(outcome, expected);
      assertExactDiagnostics(assessed, expected);
      assertPublishedHeadline(outcome, publishedHeadline(1));
      assertReadyHeadline(assessed, readyHeadline(1));
    });
  }

  test('a creation and a deletion that both fall back are counted together in the headline', async () => {
    const world = makeWorld(DROPPED);
    const outcome = await publishDoc(world, documentWith(['create', 'delete']));
    assert.equal(status(outcome), 'published', markdown(outcome));
    assertExactDiagnostics(outcome, [
      fallback('/runs/0/results/0', CREATION, DROPPED, [RESTORES_SAMPLE]),
      fallback('/runs/0/results/1', DELETION, DROPPED, [RESTORES_SAMPLE]),
    ]);
    assertPublishedHeadline(outcome, publishedHeadline(2));
    assert.equal(reviewBodyOf(world), [CREATION_PROPOSAL, DELETION_PROPOSAL].join(SEPARATOR));
    assert.equal(asRecord(parseJson(fs.readFileSync(world.statePath, 'utf8')))['format'], 'sarif-to-comment.publication-state',
      'published like a review without suggestion pull requests: the version-1 review record');
    const assessed = await validateDoc(makeWorld(DROPPED), documentWith(['create', 'delete']));
    assertReadyHeadline(assessed, readyHeadline(2));
  });
});

describe('an explicit group whose projection is unfaithful refuses the whole review before any write (#37, table row 2)', () => {
  for (const [head, obstacle] of [
    // D dropped lines 5 and 6 and edited line 10, which the group edits too: line 10
    // conflicts, and lines 5 and 6 would come back beside the conflict.
    [DROPPED, rewritten(DROPPED, [RESTORES_SAMPLE_BESIDE_CONFLICT])],
    // The head's file is larger than the projection reads.
    [OVERSIZE, unprojectable(OVERSIZE, ['`docs/sample.md` is larger than the 1,000,000-byte read limit'])],
  ] as const) {
    test(`publish is blocked and validate reports blocked, naming the reason and both ways forward (${obstacle})`, async () => {
      const expected = refusal(groupRefusalFor(obstacle), [REVIEW_AGAIN]);
      const world = makeWorld(head);
      const outcome = await publishDoc(world, documentWith(['reword', 'remark']));
      assert.equal(status(outcome), 'blocked', markdown(outcome));
      assertExactDiagnostics(outcome, [expected]);
      assertNothingWritten(world);
      assert.ok(markdown(outcome).includes(`**Review blocked:** 1 problem must be resolved before publication; nothing was published.\n\n${problemLine(expected)}`), markdown(outcome));

      const assessedWorld = makeWorld(head);
      const assessed = await validateDoc(assessedWorld, documentWith(['reword', 'remark']));
      assert.equal(status(assessed), 'blocked', markdown(assessed));
      assertExactDiagnostics(assessed, [expected]);
      assert.deepEqual(asArray(assessed['problems']), [{ message: expected['message'], pointer: '/runs/0/results/0', ...expected }]);
      assertNothingWritten(assessedWorld);
    });
  }

  test('regression (#37): a group is never published as text in the review body after a rewritten history', async () => {
    const world = makeWorld(DROPPED);
    const outcome = await publishDoc(world, documentWith(['reword', 'remark']));
    assert.equal(status(outcome), 'blocked');
    assert.doesNotMatch(markdown(outcome), /suggestion-pr-not-reapplied|Suggestion pull request not created/);
  });
});

describe('a group projected to conflict, and nothing worse, is created on the reviewed commit with a warning, even under a strict list', () => {
  // C1″ changed line 6 again; the head with a non-UTF-8 line 15 kept lines 5 and 6.
  // Either way the group's line-6 edit conflicts with the head (Git conflicts on
  // changes that touch unless identical), and nothing would come back.
  for (const head of [REWRITTEN, NOT_TEXT]) {
    test(`published, with \`companion-conflicts-at-head\` (head ${head.slice(0, 7)})`, async () => {
      const world = makeWorld(head);
      const outcome = await publishDoc(world, documentWith(['reword', 'remark']));
      assert.equal(status(outcome), 'published', markdown(outcome));
      const [pull, ...others] = world.host.pulls();
      assert.ok(pull && others.length === 0);
      assert.deepEqual(proposalCommit(world, pull.head).parents, [REVIEWED]);
      assertExactDiagnostics(outcome, [conflictWarning(head, 'the group `reword`', ['docs/sample.md'])]);
      const assessed = await validateDoc(makeWorld(head), documentWith(['reword', 'remark']));
      assert.equal(status(assessed), 'ready', markdown(assessed));
      assertExactDiagnostics(assessed, [conflictWarning(head, 'the group `reword`', ['docs/sample.md'])]);
    });
  }
});

describe('a fix with several changes whose projection is unfaithful refuses the whole review before any write (#37, table row 2)', () => {
  test('publish is blocked, validate reports blocked, and the problem names the fix, the reason and the ways forward', async () => {
    const expected = refusal(fixRefusalMessage(DROPPED, [RESTORES_SAMPLE_BESIDE_CONFLICT]), [REVIEW_AGAIN]);
    const world = makeWorld(DROPPED);
    const outcome = await publishDoc(world, jointFixDocument());
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    assertExactDiagnostics(outcome, [expected]);
    assertNothingWritten(world);
    const assessedWorld = makeWorld(DROPPED);
    const assessed = await validateDoc(assessedWorld, jointFixDocument());
    assert.equal(status(assessed), 'blocked', markdown(assessed));
    assertExactDiagnostics(assessed, [expected]);
    assertNothingWritten(assessedWorld);
  });
});

describe('mixed documents (#37)', () => {
  test('an unfaithful group with file operations that would fall back: the whole review is refused, and nothing is created', async () => {
    const world = makeWorld(DROPPED);
    const outcome = await publishDoc(world, reviewDocument());
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    // Blocked: nothing is delivered, so the file operations' fallbacks are not announced (delivery policy §10.1).
    assertExactDiagnostics(outcome, [refusal(groupRefusalMessage(DROPPED, [RESTORES_SAMPLE_BESIDE_CONFLICT]), [REVIEW_AGAIN])]);
    assertNothingWritten(world);
    const assessedWorld = makeWorld(DROPPED);
    const assessed = await validateDoc(assessedWorld, reviewDocument());
    assert.equal(status(assessed), 'blocked', markdown(assessed));
    assert.deepEqual(diagnosticsOf(assessed), diagnosticsOf(outcome));
    assertNothingWritten(assessedWorld);
  });

  test('a creation projected to conflict and a deletion that cannot be expressed: one is created with its warning, the other proposed in the body', async () => {
    const world = makeWorld(REWRITTEN);
    const outcome = await publishDoc(world, documentWith(['create', 'delete', 'remark']));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const [pull, ...others] = world.host.pulls();
    assert.ok(pull && others.length === 0, 'exactly one suggestion pull request: the creation');
    assert.equal(pull.title, 'Suggestion for #7: create docs/new.md');
    assert.deepEqual(proposalCommit(world, pull.head).parents, [REVIEWED]);
    assert.deepEqual(outcome['suggestions'], [{ number: pull.number, url: pullUrl(pull.number), branch: pull.head, mergeable: 'unknown' }]);
    assert.equal(reviewBodyOf(world), [
      // Companion contract §2.13.3: the index lists the created one only; the fallback is a body section.
      `**Companion pull requests of this review:**\n\n- [#${String(pull.number)}](${pullUrl(pull.number)}): \`Suggestion for #7: create docs/new.md\` — created with this review`,
      [
        `**Suggestion pull request:** [#${String(pull.number)}](${pullUrl(pull.number)})`, '',
        'Merging it into `feature/retry` applies this change:', '',
        '- New file `docs/new.md`: 6 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644', '',
        '**Location:** line 1 of the proposed file', '', NEW_MESSAGE, '', ATTRIBUTION,
      ].join('\n'),
      DELETION_PROPOSAL,
      REMARK_SECTION,
    ].join(SEPARATOR));
    const expected = [
      fallback('/runs/0/results/1', DELETION, REWRITTEN, ['its change to `obsolete.txt` cannot be expressed at the head']),
      conflictWarning(REWRITTEN, 'the creation of `docs/new.md`', ['docs/sample.md']),
    ];
    assertExactDiagnostics(outcome, expected);
    assertPublishedHeadline(outcome, `**Published with 2 warnings:** ${FALLBACK_TITLE}. ${CONFLICT_TITLE}.`);

    const assessed = await validateDoc(makeWorld(REWRITTEN), documentWith(['create', 'delete', 'remark']));
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assertExactDiagnostics(assessed, expected);
    assertReadyHeadline(assessed, `**Ready to publish with 2 warnings:** ${FALLBACK_TITLE}. ${CONFLICT_TITLE}.`);
    assert.ok(markdown(assessed).includes(
      'Publication would also create 1 draft suggestion pull request into `feature/retry`, labeled `suggestion-pr`. The history of #7 was rewritten after the reviewed commit, '
      + `so it is proposed on that commit and was projected onto the head \`${REWRITTEN}\`: merging it would conflict.`,
    ), markdown(assessed));
  });
});

describe('faithful suggestions publish as before: no warning, no headline (#37)', () => {
  test('a creation and a deletion projected faithful onto the amended head publish with no diagnostics', async () => {
    const world = makeWorld(AMENDED);
    const outcome = await publishDoc(world, documentWith(['create', 'delete', 'remark']));
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.equal(world.host.pulls().length, 2);
    assertExactDiagnostics(outcome, []);
    assert.ok(markdown(outcome).startsWith('## Draft review published\n\nCreated the draft [review '), markdown(outcome));
    const assessed = await validateDoc(makeWorld(AMENDED), documentWith(['create', 'delete', 'remark']));
    assertExactDiagnostics(assessed, []);
    assert.ok(markdown(assessed).startsWith('## Ready to publish\n\nThe complete document can be published faithfully'), markdown(assessed));
  });

  test('a small edit published as a native suggestion is intended presentation, never a fallback', async () => {
    const document = documentWith(['reword']);
    const run = asRecord(asArray(document['runs'])[0]);
    const [line6] = asArray(run['results']);
    run['results'] = [{ ...asRecord(line6), properties: {} }];
    const world = makeWorld(REVIEWED);
    const outcome = await publishDoc(world, document);
    assert.equal(status(outcome), 'published', markdown(outcome));
    assertExactDiagnostics(outcome, []);
    assert.deepEqual(world.host.pulls(), []);
  });
});

describe('the headline states every warning, not only fallbacks (#37, "Warnings must never be mysterious")', () => {
  test('a fallback and unreferenced artifact contents: both counted, each named, in the order found', async () => {
    const world = makeWorld(DROPPED);
    const outcome = await publishDoc(world, documentWith(['delete', 'remark'], { keepUnreferencedContents: true }));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const codes = diagnosticsOf(outcome).map((d) => asRecord(d)['code']);
    assert.deepEqual(codes, ['context-artifact-uninterpreted', 'delivery-fallback']);
    assertPublishedHeadline(outcome, `**Published with 2 warnings:** Artifact contents are treated as context only. ${FALLBACK_TITLE}.`);
    const assessed = await validateDoc(makeWorld(DROPPED), documentWith(['delete', 'remark'], { keepUnreferencedContents: true }));
    assertReadyHeadline(assessed, `**Ready to publish with 2 warnings:** Artifact contents are treated as context only. ${FALLBACK_TITLE}.`);
  });
});

// ---------------------------------------------------------------------------
// CLI

interface IRun { readonly status: number | null; readonly stdout: string; readonly stderr: string }

function cli(world: IWorld, args: readonly string[]): IRun {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: world.root, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env['PATH'], GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: world.host.dir },
  });
  for (const text of [result.stdout, result.stderr]) assert.equal(text.includes(TOKEN), false, 'the token never appears');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The CLI's review flags for `sarif` written into `world`. */
function target(world: IWorld, sarif: Json): string[] {
  const file = path.join(world.root, 'review.sarif');
  fs.writeFileSync(file, JSON.stringify(sarif));
  return ['--sarif', file, '--repo', `${OWNER}/${REPO}`, '--pull', String(PULL), '--commit', REVIEWED, '--grouped-edits', 'companion', '--file-operations', 'companion,manual'];
}

/** A diagnostic's human block (docs/diagnostics.md, "--format human"), uncolored and unwrapped. */
function humanBlock(d: Json): string {
  const location = asRecord(d['location']);
  const where = [location['path'], location['pointer']].filter((part): part is string => typeof part === 'string').join(' · ');
  const badge = d['severity'] === 'error' ? '✖ error' : '▲ warning';
  return [
    `${badge}  ${asString(d['title'])}  [${asString(d['code'])}]`,
    `  ${where}`,
    ...asString(d['message']).split('\n').map((line) => (line === '' ? '' : `  ${line}`)),
    ...(d['remedies'] === undefined ? [] : asArray(d['remedies'])).map((r) => `  → ${asString(r)}`),
  ].join('\n');
}

describe('CLI (#37): the same outcome and warnings in every format', () => {
  const head = DROPPED;
  const parts: readonly DocumentPart[] = ['delete', 'remark'];
  const warning = fallback('/runs/0/results/0', DELETION, head, [RESTORES_SAMPLE]);

  test('human: the headline under the heading on stdout, the warning once as a block on stderr, exit 0', () => {
    const world = makeWorld(head);
    const flags = target(world, documentWith(parts));
    const checked = cli(world, ['validate', ...flags]);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.ok(checked.stdout.startsWith(`## Ready to publish\n\n${readyHeadline(1)}\n\n`), checked.stdout);
    const published = cli(world, ['publish', ...flags, '--state', world.statePath]);
    assert.equal(published.status, 0, published.stdout + published.stderr);
    assert.ok(published.stdout.startsWith(`## Draft review published\n\n${publishedHeadline(1)}\n\nCreated the draft [review `), published.stdout);
    for (const run of [checked, published]) {
      assert.equal(run.stderr, `${humanBlock(warning)}\n\n1 warning\n`);
      assert.equal(run.stdout.includes(asString(warning['message'])), false, 'the warning is not repeated on stdout');
    }
  });

  test('json and toon: the headline in the message and the warning in diagnostics, for validate and publish (exit 0)', () => {
    for (const command of ['validate', 'publish'] as const) {
      const world = makeWorld(head);
      const flags = [...target(world, documentWith(parts)), ...(command === 'publish' ? ['--state', world.statePath] : [])];
      const json = cli(world, [command, ...flags, '--format', 'json']);
      assert.equal(json.status, 0, json.stdout + json.stderr);
      assert.equal(json.stderr, '');
      const doc = asRecord(parseJson(json.stdout));
      assert.equal(doc['status'], command === 'validate' ? 'ready' : 'published');
      assert.deepEqual(doc['diagnostics'], [warning]);
      assert.ok(asString(doc['message']).includes(command === 'validate' ? readyHeadline(1) : publishedHeadline(1)), asString(doc['message']));

      const toonWorld = makeWorld(head);
      const toonFlags = [...target(toonWorld, documentWith(parts)), ...(command === 'publish' ? ['--state', toonWorld.statePath] : [])];
      const toon = cli(toonWorld, [command, ...toonFlags, '--format', 'toon']);
      assert.equal(toon.status, 0, toon.stdout + toon.stderr);
      const decoded = asRecord(decode(toon.stdout));
      assert.deepEqual(decoded['diagnostics'], [warning], 'TOON carries the same structured warning');
    }
  });

  test('a refused group: blocked (exit 2), the problem once as a block on stderr with both remedies, and nothing written', () => {
    const world = makeWorld(DROPPED);
    const flags = target(world, documentWith(['reword', 'remark']));
    const expected = refusal(groupRefusalMessage(DROPPED, [RESTORES_SAMPLE_BESIDE_CONFLICT]), [REVIEW_AGAIN]);
    const checked = cli(world, ['validate', ...flags]);
    const published = cli(world, ['publish', ...flags, '--state', world.statePath]);
    for (const run of [checked, published]) {
      assert.equal(run.status, 2, run.stdout + run.stderr);
      assert.equal(run.stderr, `${humanBlock(expected)}\n\n1 error\n`);
    }
    const json = cli(world, ['publish', ...flags, '--state', world.statePath, '--format', 'json']);
    assert.equal(json.status, 2);
    assert.deepEqual(asRecord(parseJson(json.stdout))['diagnostics'], [expected]);
    assertNothingWritten(world);
  });
});

describe('a fallback is held to the limits of the mechanism that delivers it, not to those of a suggestion pull request', () => {
  test('a creation over the suggestion file limit, whose projection is unfaithful too, is judged exactly as under the default policy', async () => {
    const big = documentWith(['create']);
    const run = asRecord(asArray(big['runs'])[0]);
    const [page] = asArray(run['artifacts']);
    asRecord(asRecord(page)['contents'])['text'] = `${'x'.repeat(1_000_001)}\n`;
    const allowed = await publishDoc(makeWorld(DROPPED), big);
    const disallowed = await call('publishSarifReview', makeWorld(DROPPED), big, false);
    assert.equal(status(allowed), 'blocked', markdown(allowed));
    // Blocked by the review body's limit: the same problems, naming the fallback, and no fallback warning (delivery policy §10.1).
    assert.deepEqual(diagnosticsOf(allowed), withFallbackCause(disallowed, CREATION));
  });
});

// ---------------------------------------------------------------------------
// Wherever a suggestion pull request cannot be made (the owner's decision on
// #37 of September 30, 2026): not only after a rewritten history, but also
// for a pull request from a fork or whose head repository was deleted, one
// whose base is not the default branch (neither yet supported), and a created
// file over the suggestion pull request size limit.

const FORK_REASON = "The pull request's head branch `feature/retry` is in the fork fork-owner/widgets, and suggestion pull requests are not yet supported for a pull request from a fork.";
const DELETED_REASON = "The pull request's head repository was deleted, so there is no branch to propose it into.";
const BASE_REASON = 'The pull request merges into `release`, which is not the default branch `main` of octo/widgets, and suggestion pull requests are not yet supported for such a pull request.';

describe('a pull request suggestion pull requests do not support yet: `companion` is unavailable for every unit (#37)', () => {
  const targets = [
    ['a fork', { pull: { headRef: 'feature/retry', baseRef: 'main', headRepo: 'fork-owner/widgets' } }, FORK_REASON],
    ['a deleted head repository', { pull: { headRef: 'feature/retry', baseRef: 'main', headRepo: null } }, DELETED_REASON],
    ['a base that is not the default branch', { pull: { headRef: 'feature/retry', baseRef: 'release' } }, BASE_REASON],
  ] as const;

  for (const [what, repository, reason] of targets) {
    for (const [parts, change] of [
      [['create', 'remark'], CREATION],
      [['delete', 'remark'], DELETION],
    ] as const) {
      test(`${what}: ${change} is proposed in the review body with a fallback warning; validate agrees`, async () => {
        const expected = [fallbackDiagnostic('/runs/0/results/0', fallbackFor(change, reason))];
        const assessedWorld = makeWorld(REVIEWED, {}, repository);
        const assessed = await validateDoc(assessedWorld, documentWith(parts));
        assert.equal(status(assessed), 'ready', markdown(assessed));
        assertExactDiagnostics(assessed, expected);
        assertReadyHeadline(assessed, readyHeadline(1));
        assertNothingWritten(assessedWorld);
        const world = makeWorld(REVIEWED, {}, repository);
        const outcome = await publishDoc(world, documentWith(parts));
        assert.equal(status(outcome), 'published', markdown(outcome));
        assert.deepEqual(world.host.pulls(), []);
        assert.deepEqual(writes(world), [`/pulls/${String(PULL)}/reviews`], 'only the review is written');
        assert.equal(reviewBodyOf(world), await disallowedBody(REVIEWED, documentWith(parts)));
        assertExactDiagnostics(outcome, expected);
        assertPublishedHeadline(outcome, publishedHeadline(1));
      });
    }

    test(`${what}: a group refuses the whole review, naming the reason; nothing is written`, async () => {
      const expected = refusal(groupRefusalFor(reason));
      for (const operation of [validateDoc, publishDoc]) {
        const world = makeWorld(REVIEWED, {}, repository);
        const outcome = await operation(world, documentWith(['reword', 'create', 'remark']));
        assert.equal(status(outcome), 'blocked', markdown(outcome));
        assertExactDiagnostics(outcome, [expected]);
        assertNothingWritten(world);
      }
    });
  }

  test('a fork whose base is not the default branch either: both reasons, and neither labels nor push permission are needed', async () => {
    const world = makeWorld(REVIEWED, {}, { pull: { headRef: 'feature/retry', baseRef: 'release', headRepo: 'fork-owner/widgets' }, labels: [], push: false });
    const outcome = await publishDoc(world, documentWith(['create']));
    assert.equal(status(outcome), 'published', markdown(outcome));
    assertExactDiagnostics(outcome, [fallbackDiagnostic('/runs/0/results/0', fallbackFor(CREATION, FORK_REASON, BASE_REASON))]);
  });
});

describe('a change too large for a suggestion pull request: `companion` is unavailable, naming the limit (#37)', () => {
  /** `parts` with the new page's content replaced by `text`. */
  function withPage(parts: readonly DocumentPart[], text: string): Json {
    const document = documentWith(parts);
    const [page] = asArray(asRecord(asArray(document['runs'])[0])['artifacts']);
    asRecord(asRecord(page)['contents'])['text'] = text;
    return document;
  }

  test('a creation over 1,000,000 bytes falls back, and is then judged exactly as under the default policy (here, too large for the review body)', async () => {
    const big = withPage(['create'], `${'x'.repeat(1_000_000)}\n`);
    const allowed = await publishDoc(makeWorld(REVIEWED), big);
    const disallowed = await call('publishSarifReview', makeWorld(REVIEWED), big, false);
    assert.equal(status(disallowed), 'blocked', markdown(disallowed));
    assert.equal(status(allowed), 'blocked', markdown(allowed));
    assert.deepEqual(diagnosticsOf(allowed), withFallbackCause(disallowed, CREATION), 'the refusal under the default policy, naming the fallback, and no fallback warning');
    const assessed = await validateDoc(makeWorld(REVIEWED), big);
    assert.deepEqual(diagnosticsOf(assessed), diagnosticsOf(allowed));
  });

  test('a creation whose suggestion pull request description would be too long falls back, and is judged as under the default policy', async () => {
    const document = documentWith(['create']);
    const [result] = asArray(asRecord(asArray(document['runs'])[0])['results']);
    asRecord(asRecord(result)['message'])['text'] = 'Long. '.repeat(10_500);
    const allowed = await publishDoc(makeWorld(REVIEWED), document);
    const disallowed = await call('publishSarifReview', makeWorld(REVIEWED), document, false);
    assert.equal(status(allowed), status(disallowed), markdown(allowed));
    assert.deepEqual(diagnosticsOf(allowed), withFallbackCause(disallowed, CREATION));
  });

  test('a group holding a creation over 1,000,000 bytes falls back as a whole to the mixed manual group, and is then judged as under the default policy', async () => {
    const document = withPage(['reword', 'create'], `${'x'.repeat(1_000_000)}\n`);
    const results = asArray(asRecord(asArray(document['runs'])[0])['results']);
    asRecord(asRecord(results[2])['properties'])['sarifToComment'] = { proposedFileChanges: [{ operation: 'create', artifactIndex: 0 }], suggestionGroup: 'reword' };
    // Delivery policy §8.5, §8.10, §10.1: `companion` is unavailable for the whole group (the
    // size), so `manual` delivers it whole in the review body, which is then too large; the
    // block names that fallback, with no fallback warning, and nothing is written.
    const allowed = await publishDoc(makeWorld(REVIEWED), document);
    const disallowed = await call('publishSarifReview', makeWorld(REVIEWED), document, false);
    assert.equal(status(disallowed), 'blocked', markdown(disallowed));
    assert.equal(status(allowed), 'blocked', markdown(allowed));
    assert.ok(diagnosticsOf(disallowed).some((d) => asString(asRecord(d)['message']).includes('Proposals to make by hand in the body: the group `reword` (')), markdown(disallowed));
    assert.deepEqual(diagnosticsOf(allowed), withFallbackCause(disallowed, 'The group `reword`'));
    for (const operation of [validateDoc, publishDoc]) {
      const world = makeWorld(REVIEWED);
      assert.deepEqual(diagnosticsOf(await operation(world, document)), diagnosticsOf(allowed));
      assertNothingWritten(world);
    }
  });
});

describe('CLI (#37): a base that is not the default branch, in every format', () => {
  const repository = { pull: { headRef: 'feature/retry', baseRef: 'release' } };
  const warning = fallbackDiagnostic('/runs/0/results/0', fallbackFor(DELETION, BASE_REASON));

  test('human, json and toon, for validate and publish (exit 0)', () => {
    for (const command of ['validate', 'publish'] as const) {
      for (const format of ['human', 'json', 'toon'] as const) {
        const world = makeWorld(REVIEWED, {}, repository);
        const flags = [...target(world, documentWith(['delete', 'remark'])), ...(command === 'publish' ? ['--state', world.statePath] : []), '--format', format];
        const run = cli(world, [command, ...flags]);
        assert.equal(run.status, 0, run.stdout + run.stderr);
        if (format === 'human') {
          const heading = command === 'validate' ? `## Ready to publish\n\n${readyHeadline(1)}\n\n` : `## Draft review published\n\n${publishedHeadline(1)}\n\n`;
          assert.ok(run.stdout.startsWith(heading), run.stdout);
          assert.equal(run.stderr, `${humanBlock(warning)}\n\n1 warning\n`);
        } else {
          const doc = asRecord(format === 'json' ? parseJson(run.stdout) : decode(run.stdout));
          assert.deepEqual(doc['diagnostics'], [warning]);
          assert.equal(run.stderr, '');
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Retries (issue #42)

/**
 * The warnings section a published or uncertain outcome's full Markdown
 * carries for preparation's warnings (docs/diagnostics.md, "Warnings on
 * every call for a publication"): each warning's code, pointer and message.
 */
const warningsSection = (warnings: readonly Json[]): string => `**Warnings:**\n\n${warnings.map(problemLine).join('\n')}`;

/** The review a published outcome names. */
function reviewOf(outcome: Json): { readonly id: number; readonly url: string } {
  const review = asRecord(outcome['review']);
  const { id, url } = review;
  assert.ok(typeof id === 'number' && typeof url === 'string', 'a published outcome names its review');
  return { id, url };
}

/** The contract's sentences for the review of `outcome` (§2.7 of the submitted-review contract; README "Publishing"). */
function sentences(outcome: Json, statePath: string): { readonly created: string; readonly receipt: string; readonly recovered: string } {
  const { id, url } = reviewOf(outcome);
  const link = `[review ${String(id)}](${url})`;
  const where = `${OWNER}/${REPO}#${String(PULL)} at commit \`${REVIEWED}\``;
  return {
    created: `Created the draft ${link} on ${where}. It stays a draft until someone submits it on GitHub.`,
    receipt: `The draft ${link} on ${where} was already published; its completion is recorded at \`${statePath}\`. Nothing was sent.`,
    recovered: `The draft ${link} on ${where} was confirmed on GitHub for this publication; nothing was resent.`,
  };
}

describe('every later call for a publication reports the warnings the first call reported (#42)', () => {
  const repository = { pull: { headRef: 'feature/retry', baseRef: 'release' } };
  const warning = fallbackDiagnostic('/runs/0/results/0', fallbackFor(DELETION, BASE_REASON));

  test('regression (#42): a retry that finds the completion recorded keeps the warning, the headline and the warnings section', async () => {
    const world = makeWorld(REVIEWED, {}, repository);
    const first = await publishDoc(world, documentWith(['delete', 'remark']));
    assert.equal(status(first), 'published', markdown(first));
    assertExactDiagnostics(first, [warning]);
    assertPublishedHeadline(first, publishedHeadline(1));
    assert.ok(markdown(first).endsWith(`\n\n${warningsSection([warning])}`), markdown(first));
    const sent = writes(world);

    for (let retry = 1; retry <= 2; retry += 1) {
      const again = await publishDoc(world, documentWith(['delete', 'remark']));
      assert.equal(status(again), 'published', markdown(again));
      assert.deepEqual(again['review'], first['review']);
      assertExactDiagnostics(again, [warning]);
      const { created, receipt } = sentences(first, world.statePath);
      assert.equal(markdown(again), markdown(first).replace(created, receipt), 'the same report, but for the sentence that says the review was already published');
    }
    assert.deepEqual(writes(world), sent, 'nothing is sent again');
  });

  test('regression (#42): an uncertain delivery carries the warning, and the retry that confirms it reports it again', async () => {
    const world = makeWorld(REVIEWED, { shiftThreadLine: 0 }, repository);
    const document = documentWith(['delete', 'remark']);
    const [line6] = asArray(asRecord(asArray(reviewDocument()['runs'])[0])['results']);
    asArray(asRecord(asArray(document['runs'])[0])['results']).push({ ...asRecord(line6), properties: {} });

    const uncertain = await publishDoc(world, document);
    assert.equal(status(uncertain), 'uncertain', markdown(uncertain));
    const diagnostics = diagnosticsOf(uncertain).map((d) => asRecord(d));
    assert.deepEqual(diagnostics.map((d) => d['code']), ['delivery-fallback', 'delivery-unconfirmed'], 'the warning first, as it was found first');
    assert.deepEqual(diagnostics[0], warning);
    assert.ok(markdown(uncertain).endsWith(`\n\n${warningsSection([warning])}`), markdown(uncertain));

    world.host.setConfig({ shiftThreadLine: null });
    const confirmed = await publishDoc(world, document);
    assert.equal(status(confirmed), 'published', markdown(confirmed));
    assertExactDiagnostics(confirmed, [warning]);
    const { recovered, receipt } = sentences(confirmed, world.statePath);
    assert.equal(markdown(confirmed), `## Draft review published\n\n${publishedHeadline(1)}\n\n${recovered}\n\n${warningsSection([warning])}`);
    const recorded = await publishDoc(world, document);
    assertExactDiagnostics(recorded, [warning]);
    assert.equal(markdown(recorded), `## Draft review published\n\n${publishedHeadline(1)}\n\n${receipt}\n\n${warningsSection([warning])}`);
    assert.equal(world.host.reviews().length, 1, 'one review, never resent');
  });

  test('regression (#42): with suggestion pull requests, a retry reports the planned warnings again', async () => {
    const world = makeWorld(REWRITTEN);
    const expected = [
      fallback('/runs/0/results/1', DELETION, REWRITTEN, ['its change to `obsolete.txt` cannot be expressed at the head']),
      conflictWarning(REWRITTEN, 'the creation of `docs/new.md`', ['docs/sample.md']),
    ];
    const first = await publishDoc(world, documentWith(['create', 'delete', 'remark']));
    assert.equal(status(first), 'published', markdown(first));
    assertExactDiagnostics(first, expected);
    assert.ok(markdown(first).includes(`\n\n${warningsSection(expected)}\n\n`), markdown(first));
    const again = await publishDoc(world, documentWith(['create', 'delete', 'remark']));
    assert.equal(status(again), 'published', markdown(again));
    assert.deepEqual(again['suggestions'], first['suggestions']);
    assertExactDiagnostics(again, expected);
    const { created, receipt } = sentences(first, world.statePath);
    assert.equal(markdown(again), markdown(first).replace(created, receipt));
    assert.equal(world.host.pulls().length, 1);
    assert.equal(world.host.reviews().length, 1);

    // The plan records the warnings (contract §2.9), bound by its fingerprint: an edited warning is corrupt state, never re-rendered.
    const plan = asRecord(parseJson(fs.readFileSync(world.statePath, 'utf8')));
    assert.equal(plan['format'], 'sarif-to-comment.companion-publication-state');
    assert.deepEqual(plan['warnings'], expected);
    fs.writeFileSync(world.statePath, JSON.stringify({ ...plan, warnings: [{ ...expected[0], message: 'Edited.' }] }));
    await assert.rejects(publishDoc(world, documentWith(['create', 'delete', 'remark'])), /not a valid record \(the plan does not match its fingerprint\)/);
  });

  test('a plan without warnings records none', async () => {
    const world = makeWorld(AMENDED);
    const document = documentWith(['create', 'delete', 'remark']);
    const outcome = await publishDoc(world, document);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const plan = asRecord(parseJson(fs.readFileSync(world.statePath, 'utf8')));
    assert.equal(plan['format'], 'sarif-to-comment.companion-publication-state');
    assert.equal(Object.hasOwn(plan, 'warnings'), false);
    assertExactDiagnostics(await publishDoc(world, document), []);
  });

  test('regression (#42): CLI retries report the same warning in every format (exit 0)', () => {
    const world = makeWorld(REVIEWED, {}, repository);
    const flags = [...target(world, documentWith(['delete', 'remark'])), '--state', world.statePath];
    const first = cli(world, ['publish', ...flags, '--format', 'json']);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const firstDoc = asRecord(parseJson(first.stdout));
    assert.deepEqual(firstDoc['diagnostics'], [warning]);

    const human = cli(world, ['publish', ...flags]);
    assert.equal(human.status, 0, human.stdout + human.stderr);
    assert.ok(human.stdout.startsWith(`## Draft review published\n\n${publishedHeadline(1)}\n\nThe draft [review `), human.stdout);
    assert.equal(human.stderr, `${humanBlock(warning)}\n\n1 warning\n`);
    assert.equal(human.stdout.includes(asString(warning['message'])), false, 'the warning is not repeated on stdout');

    for (const format of ['json', 'toon'] as const) {
      const run = cli(world, ['publish', ...flags, '--format', format]);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(run.stderr, '');
      const doc = asRecord(format === 'json' ? parseJson(run.stdout) : decode(run.stdout));
      assert.equal(doc['status'], 'published');
      assert.deepEqual(doc['diagnostics'], [warning]);
      assert.ok(asString(doc['message']).startsWith(`## Draft review published\n\n${publishedHeadline(1)}\n\n`), asString(doc['message']));
    }
    assert.equal(world.host.reviews().length, 1);
  });
});
