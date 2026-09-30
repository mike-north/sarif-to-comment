/**
 * Falling back as if suggestion pull requests were not allowed when one
 * cannot be re-applied after a rewritten history (issue #37), through the
 * production composition: the real public library and CLI with the real
 * GitHub client (src/github.cts), talking HTTP to the fake GitHub host of
 * test/fixtures/rewritten-history. Only `fetch` is replaced.
 *
 * The decision read literally: `allowSuggestionPullRequests` means "use a
 * suggestion pull request where one is needed and can be made; otherwise
 * behave, for that change, exactly as if suggestion pull requests were not
 * allowed". So, when a suggestion cannot be re-applied onto the rewritten head:
 *
 * | Change                             | Behaviour                                                        |
 * | ---------------------------------- | ---------------------------------------------------------------- |
 * | whole-file creation or deletion    | the review-body proposal; published with a fallback warning      |
 * | explicit group, or a multi-change fix | the whole review is refused before any write                  |
 *
 * Every fallback is a `suggestion-pr-fallback` warning naming the change,
 * the reason and the disallowed-mode handling; the refusal is a
 * `suggestion-group-not-reapplied` error stating that suggestion pull
 * requests are allowed, why this change cannot become one, that a group
 * cannot be published without one, and the two ways forward. A published or
 * ready outcome with warnings states their count and nature directly under
 * its heading, and carries them in `diagnostics` (library, JSON, TOON) and as
 * blocks on stderr (human CLI). `validate` reports exactly what `publish`
 * would do, before anything is written.
 *
 * Expected texts are written by hand from the decision and from the
 * presentation contracts; the review body of a fallback is additionally
 * compared with the body the same document gets with suggestion pull requests
 * disallowed, which is what the decision defines it to be.
 *
 * @see https://github.com/mike-north/sarif-to-comment/issues/37
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
  REWRITTEN, SHORT, TOKEN, blob, call, documentWith, jointFixDocument, makeWorld, markdown, pullUrl, reviewDocument, status, writes,
} from './fixtures/rewritten-history/world.mts';
import type { DocumentPart, IWorld, Json } from './fixtures/rewritten-history/world.mts';
import { assertDiagnostics } from './support/diagnostics.mts';
import { asArray, asRecord, asString, parseJson } from './support/runtime-types.mts';

// ---------------------------------------------------------------------------
// Expected texts, written from the decision (issue #37)

const FALLBACK_TITLE = 'A change is handled as if suggestion pull requests were not allowed';
const FALLBACK_REMEDY = "To propose the change as a suggestion pull request, review the pull request's current head again and publish that review.";
const REFUSAL_TITLE = 'A group cannot be re-applied after a rewritten history';
const REVIEW_AGAIN = "Review the pull request's current head again, and publish that review.";
const GROUP_REMEDIES = [REVIEW_AGAIN, 'Or remove the group (`ungroup-fixes`), so that its changes are published on their own.'];
const FIX_REMEDIES = [REVIEW_AGAIN, 'Or split the fix into separate findings, one change each, so that its changes are published on their own.'];

/** How the decision names a whole-file change. */
const CREATION = 'creation of `docs/new.md`';
const DELETION = 'deletion of `obsolete.txt`';

/** The fallback warning's message: the change, the reason, and the disallowed-mode handling. */
function fallbackMessage(change: string, head: string, reasons: readonly string[]): string {
  return `Suggestion pull requests are allowed, but the ${change} is not proposed as one: the history of #7 was rewritten after the reviewed commit, `
    + `and it cannot be re-applied onto commit \`${head}\` because ${reasons.join('; ')}. `
    + 'It is handled as if suggestion pull requests were not allowed: the review body proposes it, with its findings.';
}

/** The fallback warning as a diagnostic. */
function fallback(pointer: string, filePath: string, change: string, head: string, reasons: readonly string[]): Json {
  return {
    severity: 'warning',
    code: 'suggestion-pr-fallback',
    title: FALLBACK_TITLE,
    message: fallbackMessage(change, head, reasons),
    location: { pointer, path: filePath },
    remedies: [FALLBACK_REMEDY],
  };
}

/** The refusal of the group `reword`: suggestion pull requests are allowed, why it cannot be one, and that a group then cannot be published. */
function groupRefusalMessage(head: string, reasons: readonly string[]): string {
  return 'Suggestion pull requests are allowed, but suggestion group "reword" cannot become one: the history of #7 was rewritten after the reviewed commit, '
    + `and its 2 changes cannot be re-applied onto commit \`${head}\` because ${reasons.join('; ')}. `
    + 'Without a suggestion pull request, a group cannot be published: its changes are accepted together or not at all, and are never split or published in part.';
}

/** The refusal of a fix with two changes, in the same terms. */
function fixRefusalMessage(head: string, reasons: readonly string[]): string {
  return 'Suggestion pull requests are allowed, but the fix with 2 changes cannot become one: the history of #7 was rewritten after the reviewed commit, '
    + `and its 2 changes cannot be re-applied onto commit \`${head}\` because ${reasons.join('; ')}. `
    + 'Without a suggestion pull request, a fix with several changes cannot be published: its changes are accepted together or not at all, and are never split or published in part.';
}

function refusal(message: string, remedies: readonly string[], pointer = '/runs/0/results/0'): Json {
  return { severity: 'error', code: 'suggestion-group-not-reapplied', title: REFUSAL_TITLE, message, location: { pointer }, remedies };
}

/** The headline under a published outcome's heading for `count` fallbacks and nothing else. */
function publishedHeadline(count: number): string {
  return count === 1
    ? '**Published with 1 warning:** 1 suggestion pull request was not created; its change is shown in the review.'
    : `**Published with ${String(count)} warnings:** ${String(count)} suggestion pull requests were not created; their changes are shown in the review.`;
}

/** The same headline under `validate`'s "Ready to publish". */
function readyHeadline(count: number): string {
  return count === 1
    ? '**Ready to publish with 1 warning:** 1 suggestion pull request would not be created; its change would be shown in the review.'
    : `**Ready to publish with ${String(count)} warnings:** ${String(count)} suggestion pull requests would not be created; their changes would be shown in the review.`;
}

/** The problem line blocked Markdown lists for a diagnostic (its code, pointer and message). */
const problemLine = (d: Json): string =>
  `- \`${asString(d['code'])}\` at \`${asString(asRecord(d['location'])['pointer'])}\`: ${asString(d['message'])}`;

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
    remedies: asArray(e['remedies']).map((r) => asString(r)),
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

describe('a whole-file creation that cannot be re-applied falls back to the review-body proposal (#37, table row 1)', () => {
  const parts: readonly DocumentPart[] = ['create', 'remark'];

  for (const [head, reason] of [
    [DROPPED, '`docs/new.md` already exists'],
    [MOVED, '`docs/new.md` is a directory'],
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
      assertExactDiagnostics(outcome, [fallback('/runs/0/results/0', 'docs/new.md', CREATION, head, [reason])]);
      assertPublishedHeadline(outcome, publishedHeadline(1));
    });

    test(`validate reports the same outcome and warning, and writes nothing (${reason})`, async () => {
      const world = makeWorld(head);
      const assessed = await validateDoc(world, documentWith(parts));
      assert.equal(status(assessed), 'ready', markdown(assessed));
      assertExactDiagnostics(assessed, [fallback('/runs/0/results/0', 'docs/new.md', CREATION, head, [reason])]);
      assertReadyHeadline(assessed, readyHeadline(1));
      assert.doesNotMatch(markdown(assessed), /Publication would also create/);
      assertNothingWritten(world);
    });
  }
});

describe('a whole-file deletion that cannot be re-applied falls back to the review-body proposal (#37, table row 1)', () => {
  const parts: readonly DocumentPart[] = ['delete', 'remark'];

  for (const [head, reason] of [
    [REWRITTEN, '`obsolete.txt` differs from the reviewed file'],
    [DROPPED, '`obsolete.txt` no longer exists'],
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
      const expected = [fallback('/runs/0/results/0', 'obsolete.txt', DELETION, head, [reason])];
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
      fallback('/runs/0/results/0', 'docs/new.md', CREATION, DROPPED, ['`docs/new.md` already exists']),
      fallback('/runs/0/results/1', 'obsolete.txt', DELETION, DROPPED, ['`obsolete.txt` no longer exists']),
    ]);
    assertPublishedHeadline(outcome, publishedHeadline(2));
    assert.equal(reviewBodyOf(world), [CREATION_PROPOSAL, DELETION_PROPOSAL].join(SEPARATOR));
    assert.equal(asRecord(parseJson(fs.readFileSync(world.statePath, 'utf8')))['format'], 'sarif-to-comment.publication-state',
      'published like a review without suggestion pull requests: the version-1 review record');
    const assessed = await validateDoc(makeWorld(DROPPED), documentWith(['create', 'delete']));
    assertReadyHeadline(assessed, readyHeadline(2));
  });
});

describe('an explicit group that cannot be re-applied refuses the whole review before any write (#37, table row 2)', () => {
  for (const [head, reasons] of [
    [REWRITTEN, ['`docs/sample.md` line 6 differs from the reviewed text']],
    [DROPPED, ['`docs/sample.md` line 6 differs from the reviewed text', '`docs/sample.md` line 10 differs from the reviewed text']],
    [NOT_TEXT, ['`docs/sample.md` is not UTF-8 text at the head']],
    [OVERSIZE, ['`docs/sample.md` exceeds the source-read limit']],
  ] as const) {
    test(`publish is blocked and validate reports blocked, naming the reason and both ways forward (${reasons.join('; ')})`, async () => {
      const expected = refusal(groupRefusalMessage(head, reasons), GROUP_REMEDIES);
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

  test('regression (#37): a group is no longer published as text in the review body after a rewritten history', async () => {
    const world = makeWorld(REWRITTEN);
    const outcome = await publishDoc(world, documentWith(['reword', 'remark']));
    assert.notEqual(status(outcome), 'published');
    assert.doesNotMatch(markdown(outcome), /suggestion-pr-not-reapplied|Suggestion pull request not created/);
  });
});

describe('a fix with several changes that cannot be re-applied refuses the whole review before any write (#37, table row 2)', () => {
  test('publish is blocked, validate reports blocked, and the problem names the fix, the reason and the ways forward', async () => {
    const expected = refusal(fixRefusalMessage(REWRITTEN, ['`docs/sample.md` line 6 differs from the reviewed text']), FIX_REMEDIES);
    const world = makeWorld(REWRITTEN);
    const outcome = await publishDoc(world, jointFixDocument());
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    assertExactDiagnostics(outcome, [expected]);
    assertNothingWritten(world);
    const assessedWorld = makeWorld(REWRITTEN);
    const assessed = await validateDoc(assessedWorld, jointFixDocument());
    assert.equal(status(assessed), 'blocked', markdown(assessed));
    assertExactDiagnostics(assessed, [expected]);
    assertNothingWritten(assessedWorld);
  });
});

describe('mixed documents (#37)', () => {
  test('a re-appliable suggestion with a group that cannot be re-applied: the whole review is refused, and nothing is created', async () => {
    // At REWRITTEN the new page is still absent (re-appliable), line 6 of the
    // group changed, and the obsolete note changed (a deletion that falls back).
    const world = makeWorld(REWRITTEN);
    const outcome = await publishDoc(world, reviewDocument());
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    assertExactDiagnostics(outcome, [
      refusal(groupRefusalMessage(REWRITTEN, ['`docs/sample.md` line 6 differs from the reviewed text']), GROUP_REMEDIES),
      fallback('/runs/0/results/3', 'obsolete.txt', DELETION, REWRITTEN, ['`obsolete.txt` differs from the reviewed file']),
    ]);
    assertNothingWritten(world);
    const assessedWorld = makeWorld(REWRITTEN);
    const assessed = await validateDoc(assessedWorld, reviewDocument());
    assert.equal(status(assessed), 'blocked', markdown(assessed));
    assert.deepEqual(diagnosticsOf(assessed), diagnosticsOf(outcome));
    assertNothingWritten(assessedWorld);
  });

  test('a re-appliable suggestion with a file operation that cannot be re-applied: it publishes, re-applying one and proposing the other in the body', async () => {
    const world = makeWorld(REWRITTEN);
    const outcome = await publishDoc(world, documentWith(['create', 'delete', 'remark']));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const [pull, ...others] = world.host.pulls();
    assert.ok(pull && others.length === 0, 'exactly one suggestion pull request: the creation');
    assert.equal(pull.title, 'Suggestion for #7: create docs/new.md');
    assert.deepEqual(outcome['suggestions'], [{ number: pull.number, url: pullUrl(pull.number), branch: pull.head }]);
    const reapplied = `The history of #7 was rewritten after the reviewed commit, so this change is re-applied onto commit ${REWRITTEN}, the head of #7 when it was proposed, where everything it changes is still exactly as reviewed.`;
    assert.equal(reviewBodyOf(world), [
      [
        `**Suggestion pull request:** [#${String(pull.number)}](${pullUrl(pull.number)})`, '', reapplied, '',
        'Merging it into `feature/retry` applies this change:', '',
        '- New file `docs/new.md`: 6 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644', '',
        '**Location:** line 1 of the proposed file', '', NEW_MESSAGE, '', ATTRIBUTION,
      ].join('\n'),
      DELETION_PROPOSAL,
      REMARK_SECTION,
    ].join(SEPARATOR));
    const expected = [fallback('/runs/0/results/1', 'obsolete.txt', DELETION, REWRITTEN, ['`obsolete.txt` differs from the reviewed file'])];
    assertExactDiagnostics(outcome, expected);
    assertPublishedHeadline(outcome, publishedHeadline(1));

    const assessed = await validateDoc(makeWorld(REWRITTEN), documentWith(['create', 'delete', 'remark']));
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assertExactDiagnostics(assessed, expected);
    assertReadyHeadline(assessed, readyHeadline(1));
    assert.ok(markdown(assessed).includes(
      `Publication would also create 1 draft suggestion pull request into \`feature/retry\`, labeled \`suggestion-pr\`. The history of #7 was rewritten after the reviewed commit, so it is re-applied onto commit \`${REWRITTEN}\`, where everything it changes is still exactly as reviewed.`,
    ), markdown(assessed));
  });
});

describe('suggestions that can be re-applied behave as before: no warning, no headline (#37)', () => {
  test('every suggestion re-applied onto the amended head publishes with no diagnostics', async () => {
    const world = makeWorld(AMENDED);
    const outcome = await publishDoc(world, reviewDocument());
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.equal(world.host.pulls().length, 3);
    assertExactDiagnostics(outcome, []);
    assert.ok(markdown(outcome).startsWith('## Draft review published\n\nCreated the draft [review '), markdown(outcome));
    const assessed = await validateDoc(makeWorld(AMENDED), reviewDocument());
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
    assert.deepEqual(codes, ['context-artifact-uninterpreted', 'suggestion-pr-fallback']);
    assertPublishedHeadline(outcome,
      '**Published with 2 warnings:** Artifact contents are treated as context only. 1 suggestion pull request was not created; its change is shown in the review.');
    const assessed = await validateDoc(makeWorld(DROPPED), documentWith(['delete', 'remark'], { keepUnreferencedContents: true }));
    assertReadyHeadline(assessed,
      '**Ready to publish with 2 warnings:** Artifact contents are treated as context only. 1 suggestion pull request would not be created; its change would be shown in the review.');
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
  return ['--sarif', file, '--repo', `${OWNER}/${REPO}`, '--pull', String(PULL), '--commit', REVIEWED, '--allow-suggestion-prs'];
}

/** A diagnostic's human block (docs/diagnostics.md, "--format human"), uncolored and unwrapped. */
function humanBlock(d: Json): string {
  const location = asRecord(d['location']);
  const where = [location['path'], location['pointer']].filter((part): part is string => typeof part === 'string').join(' · ');
  const badge = d['severity'] === 'error' ? '✖ error' : '▲ warning';
  return [
    `${badge}  ${asString(d['title'])}  [${asString(d['code'])}]`,
    `  ${where}`,
    `  ${asString(d['message'])}`,
    ...asArray(d['remedies']).map((r) => `  → ${asString(r)}`),
  ].join('\n');
}

describe('CLI (#37): the same outcome and warnings in every format', () => {
  const head = DROPPED;
  const parts: readonly DocumentPart[] = ['delete', 'remark'];
  const warning = fallback('/runs/0/results/0', 'obsolete.txt', DELETION, head, ['`obsolete.txt` no longer exists']);

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
    const world = makeWorld(REWRITTEN);
    const flags = target(world, documentWith(['reword', 'remark']));
    const expected = refusal(groupRefusalMessage(REWRITTEN, ['`docs/sample.md` line 6 differs from the reviewed text']), GROUP_REMEDIES);
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

describe('a fallback is held to the limits of publication without suggestion pull requests, not to those of a suggestion pull request (#37)', () => {
  test('a creation over the suggestion file limit that cannot be re-applied is judged exactly as without suggestion pull requests', async () => {
    const big = documentWith(['create']);
    const run = asRecord(asArray(big['runs'])[0]);
    const [page] = asArray(run['artifacts']);
    asRecord(asRecord(page)['contents'])['text'] = `${'x'.repeat(1_000_001)}\n`;
    const allowed = await publishDoc(makeWorld(DROPPED), big);
    const disallowed = await call('publishSarifReview', makeWorld(DROPPED), big, false);
    const codes = (outcome: Json): unknown[] => diagnosticsOf(outcome).map((d) => asRecord(d)['code']);
    assert.equal(status(allowed), status(disallowed), markdown(allowed));
    assert.deepEqual(codes(allowed).filter((c) => c !== 'suggestion-pr-fallback'), codes(disallowed));
    assert.equal(codes(allowed).includes('suggestion-file-too-large'), false, 'no suggestion pull request carries the file');
    assert.ok(codes(allowed).includes('suggestion-pr-fallback'));
  });
});
