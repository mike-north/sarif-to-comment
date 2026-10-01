/**
 * The delivery policy end to end: the real public library with the real
 * GitHub client, talking HTTP to the fake GitHub host, with the repository's
 * delivery configuration read from the default branch through Git objects.
 * Each test is one of the contract's acceptance examples (D-A1 to D-A26) or
 * one of its rules, and every expected value is written by hand from
 * docs/delivery-policy-contract.md and docs/companion-suggestion-pr-contract.md:
 * which mechanism delivers each proposal, the exact `delivery-unavailable`,
 * `delivery-fallback`, `delivery-configuration-invalid` and
 * `companion-options-unused` messages, what is written (nothing, when
 * blocked), and the policy recorded with the publication.
 *
 * Only the host's pull request numbers and the random suggestion and
 * publication ids are read back.
 *
 * @see docs/delivery-policy-contract.md
 * @see docs/companion-suggestion-pr-contract.md
 * @see https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/incorporating-feedback-in-your-pull-request#applying-suggested-changes
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { describe, test } from 'node:test';

import {
  ATTRIBUTION, CONFIGURATION_PATH, FORK_OBSTACLE, GUIDE, HEAD, HELPER, LICENSE, NOTE, OWNER, PULL, README, REPO,
  RETRY, RETRY_NOT_INLINE, SHORT, SPELLING, TYPO, UNAVAILABLE_REMEDIES,
  assertBlockedEverywhere, at, blobUrl, coded, create, created, deleted, diagnostics, document, lineFix, linesFix,
  makeWorld, markdown, onlyReview, publish, pullUrl, readBlobOf, remove, repository, result, stateRecord, status, validate, writes,
} from './support/delivery-world.mts';
import type { IWorld, Json } from './support/delivery-world.mts';
import { asArray, asRecord } from './support/runtime-types.mts';
import { composedProblem, fenceProblem, loadMarkdownParser } from '../dist/presentation/markdown-tree.cjs';

await loadMarkdownParser();

// ---------------------------------------------------------------------------
// Hand-written expectations (contract §10.1, §10.2, §8.8)

/** How a message names where a list came from (§10.1's table). */
const CALLER = (flag: string, dimension: string): string => `set by the caller (\`${flag}\`, \`delivery.${dimension}\`)`;
const CALLER_PRESET = (preset: string): string => `set by the caller's preset \`${preset}\` (\`--delivery\`, \`delivery.preset\`)`;
const CONFIGURATION = (dimension: string): string => `set by \`.github/sarif-to-comment.json\` on the default branch (\`delivery.${dimension}\`)`;
const DEFAULT = 'the default';

/** The first paragraph of a group's guidance when it is made by hand (§8.10), for `label` (§8.8's LABEL). */
const MANUAL_GUIDANCE = (label: string, count: number): string =>
  `**${label}:** apply these ${String(count)} changes together, by hand, in one commit: make every change below in a local copy of the pull request's branch, then commit them together. They are not offered as suggestions, and nothing checks that they are applied together.`;
/** A change's label in a group made by hand (§8.10). */
const PART = (label: string, n: number, count: number): string => `**${label} — change ${String(n)} of ${String(count)}**`;
/** An edit made by hand (§8.10): its exact replacement of one line, linked at the reviewed commit, then its findings. */
const MANUAL_EDIT = (file: string, line: number, shown: string, findings: string): string =>
  `**Proposed edit, to make by hand:** replace [${file} line ${String(line)} at ${SHORT}](${blobUrl(file, `?plain=1#L${String(line)}`)}) with:\n\n\`\`\`\n${shown}\n\`\`\`\n\n${findings}`;

const HEADLINE_FALLBACK = '**Published with 1 warning:** A proposal is delivered by a later mechanism of its delivery list.';

const DRAFT_NOTE = '**How this suggestion is accepted:** it is a draft pull request into `feature/retry`, the branch of #7. A draft cannot be merged: someone with write access first marks it ready for review. The author of #7 then decides whether to merge it, and #7 carries the change to its base. Once #7 is merged or closed, this pull request can be closed.';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SUGGESTION_MARKER = new RegExp(`\\n\\n<!-- suggestion-pr \\{"version":1,"original":\\{"owner":"${OWNER}","repo":"${REPO}","pullNumber":${String(PULL)}\\},"reviewedCommit":"${HEAD}","id":"${UUID}","batch":"${UUID}"\\} -->$`);

/** The recorded form of one resolved setting (§13). */
const recorded = (value: unknown, source: string, preset?: string): Json => ({ value, source, ...(preset === undefined ? {} : { preset }) });
const DEFAULTS: Json = {
  edits: recorded(['native'], 'default'),
  groupedEdits: recorded(['native-batch'], 'default'),
  fileOperations: recorded(['manual'], 'default'),
  companionBundle: recorded('per-unit', 'default'),
};

/** The README after edits of its lines 2-4 (`edited` names the lines a proposal changes). */
function readmeWith(edited: Readonly<Record<number, string>>): string {
  return README.map((line, i) => (edited[i + 1] === undefined ? line : `${String(edited[i + 1])}\n`)).join('');
}

/** A finding section of the README at line `line` (§2.11 ITEMS), quoting the reviewed line. */
function readmeItem(line: number, message: string): string {
  return [`**Source:** [README.md line ${String(line)} at ${SHORT}](${blobUrl('README.md', `?plain=1#L${String(line)}`)})`, '', '```', String(README[line - 1]).replace(/\n$/, ''), '```', '', message, '', ATTRIBUTION].join('\n');
}

/** A creation or deletion section, as the file-operation contract presents a whole-file proposal. */
const GUIDE_SECTION = [
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

const GUIDE_RESULT = (group?: string): Json => result({ text: 'Add a guide.', ...(group === undefined ? {} : { group }), location: at('docs/guide.md', 1), operation: create(0) });
const OBSOLETE_RESULT = (artifactIndex = 0): Json => result({ text: 'Remove the obsolete file.', location: at('obsolete.txt'), operation: remove(artifactIndex) });

/** Two README edits grouped as `pair`: both can be native suggestions. */
const eligiblePair = (): Json => document([TYPO('pair'), SPELLING('pair')]);
/** A README edit and a src/client.ts edit grouped as `pair`: the second cannot be a native suggestion. */
const mixedPair = (): Json => document([TYPO('pair'), RETRY('pair')]);
/** D-A7: an explicit group of a new helper file and two edits that use it, and an unrelated ungrouped edit. */
const helperGroup = (): Json => document([
  result({ text: 'Add the helper.', group: 'helper', location: at('src/helper.ts', 1), operation: create(0) }),
  TYPO('helper'),
  SPELLING('helper'),
  LICENSE(),
], [created('src/helper.ts', HELPER)]);

/** The plan or record's recorded policy (§13). */
const recordedPolicy = (world: IWorld): unknown => stateRecord(world)['delivery'];

/** The created pull requests, in creation order. */
const pulls = (world: IWorld): readonly ReturnType<IWorld['host']['pulls']>[number][] => world.host.pulls();

function onlyPull(world: IWorld): ReturnType<IWorld['host']['pulls']>[number] {
  const created = pulls(world);
  assert.equal(created.length, 1, 'exactly one companion pull request');
  const [pull] = created;
  assert.ok(pull);
  return pull;
}

/**
 * The published review body, read back from the host with its publication
 * marker, passes the composed-text checkpoint (review presentation contract
 * §7): nothing open, the marker its own final node, and no `suggestion` code
 * block; and no line of it could open one (delivery policy §8.10).
 */
function assertNoSuggestionInBody(world: IWorld): void {
  const [review] = world.host.reviews();
  assert.ok(review);
  const marker = /<!-- sarif-to-comment:review:[0-9a-f-]{36} -->$/.exec(review.request.body)?.[0];
  assert.ok(marker !== undefined, 'the body ends with its publication marker');
  assert.equal(composedProblem(review.request.body, { marker }), null, review.request.body);
  assert.equal(fenceProblem(review.request.body), null, 'no line could open a suggestion block');
}

/** A README finding's section in a group made by hand: its edit of `line` made by hand, with the finding. */
const readmeEdit = (line: number, shown: string, message: string): string => MANUAL_EDIT('README.md', line, shown, readmeItem(line, message));

/** D-A8: the helper group made by hand, as §8.10 presents it. */
const HELPER_SECTION = [
  `${MANUAL_GUIDANCE('Suggestion group `helper`', 3)}\n\n- \`src/helper.ts\`: new file\n- \`README.md\` line 2\n- \`README.md\` line 3`,
  [
    PART('Suggestion group `helper`', 1, 3),
    '',
    '**Proposed new file:** `src/helper.ts`',
    '',
    '**File details:** 26 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
    '',
    '```',
    'export const retries = 1;',
    '```',
    '',
    '**Location:** line 1 of the proposed file',
    '',
    'Add the helper.',
    '',
    ATTRIBUTION,
  ].join('\n'),
  `${PART('Suggestion group `helper`', 2, 3)}\n\n${readmeEdit(2, 'The widget client.', 'Fix the typo.')}`,
  `${PART('Suggestion group `helper`', 3, 3)}\n\n${readmeEdit(3, 'Receive updates.', 'Fix the spelling.')}`,
].join('\n\n---\n\n');

// ---------------------------------------------------------------------------

describe('precedence and recording (§7, §13)', () => {
  test('D-A1: an explicit grouped-edits choice wins over the configuration, and the group goes to one companion with no warning', async () => {
    const world = makeWorld(repository({ configuration: '{"delivery":{"groupedEdits":["native-batch"]}}' }));
    const outcome = await publish(world, eligiblePair(), { delivery: { groupedEdits: ['companion'] } });
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(diagnostics(outcome), []);
    const pull = onlyPull(world);
    assert.equal(pull.title, 'Suggestion for #7: pair (2 changes)');
    assert.deepEqual(world.host.fileOnBranch(pull.head, 'README.md'), Buffer.from(readmeWith({ 2: 'The widget client.', 3: 'Receive updates.' })));
    assert.deepEqual(onlyReview(world).comments, [], 'neither member is a native suggestion');
    assert.deepEqual(asRecord(recordedPolicy(world))['groupedEdits'], recorded(['companion'], 'caller'));
  });

  test('D-A2: a caller preset wins per dimension; the bundle setting it leaves comes from the configuration', async () => {
    const world = makeWorld(repository({ configuration: '{"delivery":{"preset":"original-pr","companionBundle":"single"}}' }));
    const outcome = await publish(world, document([TYPO(), GUIDE_RESULT()], [created('docs/guide.md', GUIDE)]), { delivery: { preset: 'companion' } });
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(recordedPolicy(world), {
      edits: recorded(['companion'], 'caller-preset', 'companion'),
      groupedEdits: recorded(['companion'], 'caller-preset', 'companion'),
      fileOperations: recorded(['companion'], 'caller-preset', 'companion'),
      companionBundle: recorded('single', 'configuration'),
    });
    const pull = onlyPull(world);
    assert.equal(pull.title, 'Suggestion for #7: 2 proposals (2 changes)', 'one bundle with both proposals');
  });

  test('D-A14: within the caller layer, a specific list wins over the preset; the preset still sets the rest', async () => {
    const world = makeWorld();
    const outcome = await publish(world, document([GUIDE_RESULT()], [created('docs/guide.md', GUIDE)]), {
      delivery: { preset: 'companion', fileOperations: ['companion', 'manual'] },
    });
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(recordedPolicy(world), {
      edits: recorded(['companion'], 'caller-preset', 'companion'),
      groupedEdits: recorded(['companion'], 'caller-preset', 'companion'),
      fileOperations: recorded(['companion', 'manual'], 'caller'),
      companionBundle: recorded('per-unit', 'default'),
    });
  });

  test('D-A15: within the configuration, a specific list wins over its preset', async () => {
    const world = makeWorld(repository({ configuration: '{"delivery":{"preset":"companion","groupedEdits":["native-batch","companion"]}}' }));
    const outcome = await publish(world, eligiblePair());
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(recordedPolicy(world), {
      edits: recorded(['companion'], 'configuration-preset', 'companion'),
      groupedEdits: recorded(['native-batch', 'companion'], 'configuration'),
      fileOperations: recorded(['companion'], 'configuration-preset', 'companion'),
      companionBundle: recorded('per-unit', 'default'),
    });
    assert.deepEqual(pulls(world), [], 'the group is a native batch: the first listed mechanism is available');
    assert.equal(onlyReview(world).comments.length, 2);
  });

  test('D-A4: with nothing set, every value is the default; a review without companions is a version-3 record holding the policy', async () => {
    const world = makeWorld();
    const outcome = await publish(world, document([TYPO(), GUIDE_RESULT()], [created('docs/guide.md', GUIDE)]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(diagnostics(outcome), []);
    const record = stateRecord(world);
    assert.equal(record['format'], 'sarif-to-comment.publication-state');
    assert.equal(record['version'], 3);
    assert.deepEqual(record['delivery'], DEFAULTS);
    assert.deepEqual(Object.keys(asRecord(record['delivery'])), ['edits', 'groupedEdits', 'fileOperations', 'companionBundle'], '§13 order');
    assert.deepEqual(pulls(world), [], 'the defaults never create a companion');
    const review = onlyReview(world);
    assert.equal(review.body, GUIDE_SECTION, 'the creation is its review-body section');
    assert.equal(review.comments.length, 1);
    assert.ok(review.comments[0]?.body.endsWith('```suggestion\nThe widget client.\n```'), 'the edit is a native suggestion');
    assert.equal(world.host.log().some((r) => r.path.includes('/labels')), false, 'no label is read without a companion');
  });

  test('D-A4: with nothing set, an edit that cannot be a native suggestion is blocked, naming the default list', async () => {
    const world = makeWorld();
    await assertBlockedEverywhere(world, document([RETRY()]), undefined, [
      `- \`delivery-unavailable\` at \`/runs/0/results/0\`: The edit of \`src/client.ts\` line 2 cannot be delivered. \`edits\` is \`[native]\`, ${DEFAULT}, and no mechanism it lists is available:\n\n- \`native\`: ${RETRY_NOT_INLINE}`,
    ]);
  });

  test('D-A3: an explicit native choice with no configuration: an eligible edit is native; an ineligible one is blocked, never moved', async () => {
    const delivered = makeWorld();
    const outcome = await publish(delivered, document([TYPO()]), { delivery: { edits: ['native'] } });
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.equal(onlyReview(delivered).comments.length, 1);

    const world = makeWorld();
    const blocked = await assertBlockedEverywhere(world, document([RETRY()]), { delivery: { edits: ['native'] } }, [
      `- \`delivery-unavailable\` at \`/runs/0/results/0\`: The edit of \`src/client.ts\` line 2 cannot be delivered. \`edits\` is \`[native]\`, ${CALLER('--edits', 'edits')}, and no mechanism it lists is available:\n\n- \`native\`: ${RETRY_NOT_INLINE}`,
    ]);
    const [problem] = diagnostics(blocked);
    assert.ok(problem);
    assert.equal(problem['severity'], 'error');
    assert.equal(problem['title'], 'No delivery mechanism the policy lists is available for a proposal');
    assert.deepEqual(problem['location'], { pointer: '/runs/0/results/0' });
    // §8.9: the retired `suggestion-not-inline`'s specific remedy comes first, then the catalogued ones.
    assert.deepEqual(problem['remedies'], ['Remove the fix.', ...UNAVAILABLE_REMEDIES]);
  });

  test('a retry with the same state path never reads the configuration again and continues the recorded resolution', async () => {
    for (const [sarif, configuration] of [
      [document([TYPO()]), '{"delivery":{"edits":["native"]}}'],
      [document([GUIDE_RESULT()], [created('docs/guide.md', GUIDE)]), '{"delivery":{"fileOperations":["companion"]}}'],
    ] as const) {
      const world = makeWorld(repository({ configuration }));
      const first = await publish(world, sarif);
      assert.equal(status(first), 'published', markdown(first));
      const planned = recordedPolicy(world);
      // The repository now holds a configuration that would block the review.
      world.host.replaceRepository(repository({ configuration: '{"delivery":{"edits":[]}}' }));
      const before = world.host.log().length;
      const retried = await publish(world, sarif);
      assert.equal(status(retried), 'published', markdown(retried));
      assert.deepEqual(diagnostics(retried), diagnostics(first));
      assert.equal(world.host.log().slice(before).some((r) => r.path.includes('/git/ref/heads/main') || r.path.includes('/git/blobs/')), false, 'no configuration read');
      assert.deepEqual(recordedPolicy(world), planned, 'the record keeps the planned resolution');
    }
  });

  test('the caller\'s delivery settings are part of the publication identity: a retry with other settings is refused before any request', async () => {
    const world = makeWorld();
    const first = await publish(world, document([TYPO()]), { delivery: { edits: ['native'] } });
    assert.equal(status(first), 'published', markdown(first));
    const before = world.host.log().length;
    await assert.rejects(publish(world, document([TYPO()])), /belongs to a different original input/);
    await assert.rejects(publish(world, document([TYPO()]), { delivery: { edits: ['native', 'companion'] } }), /belongs to a different original input/);
    assert.equal(world.host.log().length, before, 'refused locally');
    const again = await publish(world, document([TYPO()]), { delivery: { edits: ['native'] } });
    assert.equal(status(again), 'published', markdown(again));
  });

  test('companion options with an effect are part of the identity; given without an effect, they are not', async () => {
    const world = makeWorld();
    const first = await publish(world, document([TYPO()]), { pullRequestLabels: [], markSuggestionPullRequestsReady: false });
    assert.equal(status(first), 'published', markdown(first));
    const same = await publish(world, document([TYPO()]));
    assert.equal(status(same), 'published', 'the same publication as omitting them');
    await assert.rejects(publish(world, document([TYPO()]), { pullRequestLabels: ['team-a'] }), /belongs to a different original input/);
  });
});

describe('groups stay whole (D49, D51; §8.3–§8.5, §8.8)', () => {
  test('D-A5: an explicit group of two eligible edits is one native batch: both suggestions, each noting the group, and the guidance in the body', async () => {
    const world = makeWorld();
    const assessed = await validate(world, eligiblePair());
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.deepEqual(diagnostics(assessed), []);
    const outcome = await publish(world, eligiblePair());
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(diagnostics(outcome), [], 'the requested delivery, not a fallback');
    const note = '**Suggestion group `pair`:** apply this suggestion together with the group\'s other suggestions, listed in the review body.';
    const review = onlyReview(world);
    assert.deepEqual(review.comments, [
      { path: 'README.md', line: 2, side: 'RIGHT', body: ['Fix the typo.', '', ATTRIBUTION, '', note, '', '```suggestion', 'The widget client.', '```'].join('\n') },
      { path: 'README.md', line: 3, side: 'RIGHT', body: ['Fix the spelling.', '', ATTRIBUTION, '', note, '', '```suggestion', 'Receive updates.', '```'].join('\n') },
    ]);
    assert.equal(review.body, [
      '**Suggestion group `pair`:** apply these 2 suggestions together, in one commit: add each of them to one batch of suggestions on the pull request, then commit the batch. Nothing checks that they are applied together.',
      '',
      '- `README.md` line 2',
      '- `README.md` line 3',
    ].join('\n'));
    assert.deepEqual(pulls(world), []);
  });

  test('D-A6: never one native and one companion; with [native-batch, companion] the whole group goes to one companion, announced', async () => {
    const blocked = makeWorld();
    await assertBlockedEverywhere(blocked, mixedPair(), undefined, [
      `- \`delivery-unavailable\` at \`/runs/0/results/0\`: The group \`pair\` cannot be delivered. \`groupedEdits\` is \`[native-batch]\`, ${DEFAULT}, and no mechanism it lists is available:\n\n- \`native-batch\`: The edit of \`src/client.ts\` line 2: ${RETRY_NOT_INLINE}`,
    ]);

    const world = makeWorld();
    const options = { delivery: { groupedEdits: ['native-batch', 'companion'] } };
    const assessed = await validate(world, mixedPair(), options);
    const outcome = await publish(world, mixedPair(), options);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const fallback = `The group \`pair\` is delivered as \`companion\`. \`groupedEdits\` is \`[native-batch, companion]\`, ${CALLER('--grouped-edits', 'groupedEdits')}, and the mechanisms listed before it are unavailable:\n\n- \`native-batch\`: The edit of \`src/client.ts\` line 2: ${RETRY_NOT_INLINE}`;
    assert.deepEqual(coded(outcome), [['delivery-fallback', fallback]]);
    assert.deepEqual(diagnostics(assessed), diagnostics(outcome), 'validate reports what publish does');
    assert.ok(markdown(outcome).startsWith(`## Draft review published\n\n${HEADLINE_FALLBACK}\n\n`), markdown(outcome));
    const pull = onlyPull(world);
    assert.equal(pull.title, 'Suggestion for #7: pair (2 changes)');
    assert.deepEqual(world.host.fileOnBranch(pull.head, 'README.md'), Buffer.from(readmeWith({ 2: 'The widget client.' })));
    assert.deepEqual(world.host.fileOnBranch(pull.head, 'src/client.ts'), Buffer.from(['export async function fetchWidget(id: string) {\n', '  const response = await request(id).catch(() => request(id));\n', '  return response.body;\n', '}\n'].join('')));
    assert.deepEqual(onlyReview(world).comments, [], 'neither member is a native suggestion');
  });

  test('D-A7: a group with a whole-file creation follows fileOperations as a whole; an unrelated edit keeps its own setting', async () => {
    const world = makeWorld();
    const outcome = await publish(world, helperGroup(), { delivery: { fileOperations: ['companion'] } });
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(diagnostics(outcome), []);
    const pull = onlyPull(world);
    assert.equal(pull.title, 'Suggestion for #7: helper (3 changes)');
    assert.deepEqual(world.host.fileOnBranch(pull.head, 'src/helper.ts'), Buffer.from(HELPER));
    assert.deepEqual(world.host.fileOnBranch(pull.head, 'README.md'), Buffer.from(readmeWith({ 2: 'The widget client.', 3: 'Receive updates.' })), 'both edits, even though each could be native');
    const { comments } = onlyReview(world);
    assert.equal(comments.length, 1, 'only the unrelated edit is a native suggestion');
    assert.deepEqual([comments[0]?.path, comments[0]?.line], ['README.md', 4]);
    assert.ok(comments[0]?.body.endsWith('```suggestion\nLicense: MIT.\n```'));
  });

  test('D-A8: under the defaults, a group with a whole-file operation is delivered whole as the mixed manual group; no companion, no warning', async () => {
    const world = makeWorld();
    const assessed = await validate(world, helperGroup());
    assert.equal(status(assessed), 'ready', markdown(assessed));
    const outcome = await publish(world, helperGroup());
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(diagnostics(outcome), [], 'the first listed mechanism: no fallback');
    assert.deepEqual(diagnostics(assessed), diagnostics(outcome));
    assert.deepEqual(pulls(world), [], 'the no-companion workflow (D51)');
    const review = onlyReview(world);
    assert.equal(review.body, HELPER_SECTION, 'every member, in order of first appearance, made by hand');
    assert.equal(review.comments.length, 1, 'only the unrelated edit is an inline comment');
    assert.deepEqual([review.comments[0]?.path, review.comments[0]?.line], ['README.md', 4]);
    assert.ok(review.comments[0]?.body.endsWith('```suggestion\nLicense: MIT.\n```'));
    assertNoSuggestionInBody(world);
    assert.deepEqual(asRecord(recordedPolicy(world))['fileOperations'], recorded(['manual'], 'default'));
  });

  test('D-A8: groupedEdits never governs a group with a whole-file operation, even when its edits could be a native batch', async () => {
    for (const groupedEdits of [['native-batch'], ['companion']]) {
      const world = makeWorld();
      const outcome = await publish(world, helperGroup(), { delivery: { groupedEdits } });
      assert.equal(status(outcome), 'published', markdown(outcome));
      assert.equal(onlyReview(world).body, HELPER_SECTION);
      assert.deepEqual(pulls(world), []);
    }
  });

  test('the mixed manual group presents a deletion with the file-operation section, as one of its changes', async () => {
    const world = makeWorld();
    const sarif = document([TYPO('cleanup'), result({ text: 'Remove the obsolete file.', group: 'cleanup', location: at('obsolete.txt'), operation: remove(0) })], [deleted('obsolete.txt')]);
    const outcome = await publish(world, sarif);
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.equal(onlyReview(world).body, [
      `${MANUAL_GUIDANCE('Suggestion group `cleanup`', 2)}\n\n- \`README.md\` line 2\n- \`obsolete.txt\`: file deletion`,
      `${PART('Suggestion group `cleanup`', 1, 2)}\n\n${readmeEdit(2, 'The widget client.', 'Fix the typo.')}`,
      `${PART('Suggestion group `cleanup`', 2, 2)}\n\n**Proposed file deletion:** [obsolete.txt at ${SHORT}](${blobUrl('obsolete.txt')})\n\nThe whole file is removed; this is not a proposal to empty it.\n\nRemove the obsolete file.\n\n${ATTRIBUTION}`,
    ].join('\n\n---\n\n'));
    assert.deepEqual(onlyReview(world).comments, []);
    assertNoSuggestionInBody(world);
  });

  test('D-A11: the manual group is used only when listed; the original-pr preset lists it, announced as a fallback', async () => {
    await assertBlockedEverywhere(makeWorld(), mixedPair(), undefined, [
      `- \`delivery-unavailable\` at \`/runs/0/results/0\`: The group \`pair\` cannot be delivered. \`groupedEdits\` is \`[native-batch]\`, ${DEFAULT}, and no mechanism it lists is available:\n\n- \`native-batch\`: The edit of \`src/client.ts\` line 2: ${RETRY_NOT_INLINE}`,
    ]);
    const world = makeWorld();
    const options = { delivery: { preset: 'original-pr' } };
    const assessed = await validate(world, mixedPair(), options);
    const outcome = await publish(world, mixedPair(), options);
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(coded(outcome), [[
      'delivery-fallback',
      `The group \`pair\` is delivered as \`manual-group\`. \`groupedEdits\` is \`[native-batch, manual-group]\`, ${CALLER_PRESET('original-pr')}, and the mechanisms listed before it are unavailable:\n\n- \`native-batch\`: The edit of \`src/client.ts\` line 2: ${RETRY_NOT_INLINE}`,
    ]]);
    assert.deepEqual(diagnostics(assessed), diagnostics(outcome), 'validate reports what publish does');
    assert.ok(markdown(outcome).startsWith(`## Draft review published\n\n${HEADLINE_FALLBACK}\n\n`), markdown(outcome));
    const retryItem = [`**Source:** [src/client.ts line 2 at ${SHORT}](${blobUrl('src/client.ts', '?plain=1#L2')})`, '', '```', '  const response = await request(id);', '```', '', 'Retry once on timeout.', '', ATTRIBUTION].join('\n');
    const review = onlyReview(world);
    assert.equal(review.body, [
      `${MANUAL_GUIDANCE('Suggestion group `pair`', 2)}\n\n- \`README.md\` line 2\n- \`src/client.ts\` line 2`,
      `${PART('Suggestion group `pair`', 1, 2)}\n\n${readmeEdit(2, 'The widget client.', 'Fix the typo.')}`,
      `${PART('Suggestion group `pair`', 2, 2)}\n\n${MANUAL_EDIT('src/client.ts', 2, '  const response = await request(id).catch(() => request(id));', retryItem)}`,
    ].join('\n\n---\n\n'));
    assert.deepEqual(review.comments, [], 'neither member is an inline comment, though the first could be a native suggestion');
    assert.deepEqual(pulls(world), []);
    assertNoSuggestionInBody(world);
  });

  test('D-A23: under the defaults, a fix with several changes is a native batch: each change a suggestion holding the finding, with the fix\'s note', async () => {
    const joint = document([result({ text: 'Fix both lines.', location: at('README.md', 2), fixes: [linesFix('README.md', { 2: 'The widget client.', 3: 'Receive updates.' })] })]);
    const world = makeWorld();
    const outcome = await publish(world, joint);
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(diagnostics(outcome), []);
    const note = '**Fix with 2 changes:** apply this suggestion together with the fix\'s other suggestions, listed in the review body.';
    const review = onlyReview(world);
    assert.deepEqual(review.comments, [
      { path: 'README.md', line: 2, side: 'RIGHT', body: ['Fix both lines.', '', ATTRIBUTION, '', note, '', '```suggestion', 'The widget client.', '```'].join('\n') },
      { path: 'README.md', line: 3, side: 'RIGHT', body: ['Fix both lines.', '', ATTRIBUTION, '', note, '', '```suggestion', 'Receive updates.', '```'].join('\n') },
    ]);
    assert.equal(review.body, [
      '**Fix with 2 changes:** apply these 2 suggestions together, in one commit: add each of them to one batch of suggestions on the pull request, then commit the batch. Nothing checks that they are applied together.',
      '',
      '- `README.md` line 2',
      '- `README.md` line 3',
    ].join('\n'));
    assert.deepEqual(pulls(world), []);

    const companion = makeWorld();
    const sent = await publish(companion, joint, { delivery: { groupedEdits: ['companion'] } });
    assert.equal(status(sent), 'published', markdown(sent));
    assert.equal(onlyPull(companion).title, 'Suggestion for #7: edit README.md');
  });

  test('D-A23: a fix with a change outside the diff is not a native batch; under the defaults it is blocked, naming that change', async () => {
    const joint = document([result({ text: 'Fix both.', location: at('README.md', 2), fixes: [{ artifactChanges: [
      { artifactLocation: { uri: 'README.md' }, replacements: [{ deletedRegion: { startLine: 2 }, insertedContent: { text: 'The widget client.' } }] },
      { artifactLocation: { uri: 'src/client.ts' }, replacements: [{ deletedRegion: { startLine: 2 }, insertedContent: { text: '  const response = await request(id).catch(() => request(id));' } }] },
    ] }] })]);
    await assertBlockedEverywhere(makeWorld(), joint, undefined, [
      `- \`delivery-unavailable\` at \`/runs/0/results/0\`: The fix with 2 changes at \`/runs/0/results/0\` cannot be delivered. \`groupedEdits\` is \`[native-batch]\`, ${DEFAULT}, and no mechanism it lists is available:\n\n- \`native-batch\`: The edit of \`src/client.ts\` line 2: ${RETRY_NOT_INLINE}`,
    ]);
    // Listed, the manual group delivers it whole by hand: both changes, the finding with each.
    const world = makeWorld();
    const outcome = await publish(world, joint, { delivery: { groupedEdits: ['manual-group'] } });
    assert.equal(status(outcome), 'published', markdown(outcome));
    const item = readmeItem(2, 'Fix both.');
    assert.equal(onlyReview(world).body, [
      `${MANUAL_GUIDANCE('Fix with 2 changes', 2)}\n\n- \`README.md\` line 2\n- \`src/client.ts\` line 2`,
      `${PART('Fix with 2 changes', 1, 2)}\n\n${MANUAL_EDIT('README.md', 2, 'The widget client.', item)}`,
      `${PART('Fix with 2 changes', 2, 2)}\n\n${MANUAL_EDIT('src/client.ts', 2, '  const response = await request(id).catch(() => request(id));', item)}`,
    ].join('\n\n---\n\n'));
    assertNoSuggestionInBody(world);
  });

  test('D-A24: a group member whose fix makes several changes contributes each of them to the native batch, in order', async () => {
    const sarif = document([
      result({ text: 'Fix both lines.', group: 'pair', location: at('README.md', 2), fixes: [linesFix('README.md', { 2: 'The widget client.', 3: 'Receive updates.' })] }),
      LICENSE('pair'),
    ]);
    const world = makeWorld();
    const outcome = await publish(world, sarif);
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(diagnostics(outcome), []);
    const note = '**Suggestion group `pair`:** apply this suggestion together with the group\'s other suggestions, listed in the review body.';
    const review = onlyReview(world);
    assert.deepEqual(review.comments.map((c) => [c.line, c.body]), [
      [2, ['Fix both lines.', '', ATTRIBUTION, '', note, '', '```suggestion', 'The widget client.', '```'].join('\n')],
      [3, ['Fix both lines.', '', ATTRIBUTION, '', note, '', '```suggestion', 'Receive updates.', '```'].join('\n')],
      [4, ['Use the American spelling.', '', ATTRIBUTION, '', note, '', '```suggestion', 'License: MIT.', '```'].join('\n')],
    ]);
    assert.equal(review.body, [
      '**Suggestion group `pair`:** apply these 3 suggestions together, in one commit: add each of them to one batch of suggestions on the pull request, then commit the batch. Nothing checks that they are applied together.',
      '',
      '- `README.md` line 2',
      '- `README.md` line 3',
      '- `README.md` line 4',
    ].join('\n'));
  });
});

describe('strict lists and announced fallback (D55; §10)', () => {
  test('D-A9: a strict companion list on a pull request from a fork blocks before any write', async () => {
    const world = makeWorld(repository({ fork: true }));
    await assertBlockedEverywhere(world, document([OBSOLETE_RESULT()], [deleted('obsolete.txt')]), { delivery: { fileOperations: ['companion'] } }, [
      `- \`delivery-unavailable\` at \`/runs/0/results/0\`: The deletion of \`obsolete.txt\` cannot be delivered. \`fileOperations\` is \`[companion]\`, ${CALLER('--file-operations', 'fileOperations')}, and no mechanism it lists is available:\n\n- \`companion\`: ${FORK_OBSTACLE}`,
    ]);
    assert.deepEqual(pulls(world), []);
    // A fork has no remedy of its own (§8.9): only the catalogued remedies.
    assert.deepEqual(diagnostics(await validate(world, document([OBSOLETE_RESULT()], [deleted('obsolete.txt')]), { delivery: { fileOperations: ['companion'] } }))[0]?.['remedies'], UNAVAILABLE_REMEDIES);
  });

  test('D-A10: a configured [companion, manual] list falls back to the body section, announced, and every later call reports the same warning', async () => {
    const world = makeWorld(repository({ fork: true, configuration: '{"delivery":{"fileOperations":["companion","manual"]}}' }));
    const sarif = document([GUIDE_RESULT()], [created('docs/guide.md', GUIDE)]);
    const assessed = await validate(world, sarif);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    const outcome = await publish(world, sarif);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const fallback = `The creation of \`docs/guide.md\` is delivered as \`manual\`. \`fileOperations\` is \`[companion, manual]\`, ${CONFIGURATION('fileOperations')}, and the mechanisms listed before it are unavailable:\n\n- \`companion\`: ${FORK_OBSTACLE}`;
    assert.deepEqual(coded(outcome), [['delivery-fallback', fallback]]);
    assert.deepEqual(diagnostics(outcome)[0]?.['location'], { pointer: '/runs/0/results/0' });
    assert.deepEqual(diagnostics(assessed), diagnostics(outcome));
    assert.ok(markdown(outcome).startsWith(`## Draft review published\n\n${HEADLINE_FALLBACK}\n\n`), markdown(outcome));
    assert.equal(onlyReview(world).body, GUIDE_SECTION);
    assert.deepEqual(pulls(world), []);

    const retried = await publish(world, sarif);
    assert.equal(status(retried), 'published');
    assert.deepEqual(diagnostics(retried), diagnostics(outcome), 'issue #42: recorded with the publication');
    assert.equal(world.host.reviews().length, 1);
  });

  test('an edit list [native, companion] gives an ineligible edit a companion of its own, announced', async () => {
    const world = makeWorld();
    const outcome = await publish(world, document([TYPO(), RETRY()]), { delivery: { edits: ['native', 'companion'] } });
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(coded(outcome), [[
      'delivery-fallback',
      `The edit of \`src/client.ts\` line 2 is delivered as \`companion\`. \`edits\` is \`[native, companion]\`, ${CALLER('--edits', 'edits')}, and the mechanisms listed before it are unavailable:\n\n- \`native\`: ${RETRY_NOT_INLINE}`,
    ]]);
    assert.equal(onlyPull(world).title, 'Suggestion for #7: edit src/client.ts');
    assert.equal(onlyReview(world).comments.length, 1, 'the eligible edit stays native');
  });

  test('D-A22: an edit is put in the review body only when listed; after `native`, it is an announced fallback', async () => {
    const world = makeWorld();
    const options = { delivery: { edits: ['native', 'review-body'] } };
    const assessed = await validate(world, document([TYPO(), RETRY()]), options);
    const outcome = await publish(world, document([TYPO(), RETRY()]), options);
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(coded(outcome), [[
      'delivery-fallback',
      `The edit of \`src/client.ts\` line 2 is delivered as \`review-body\`. \`edits\` is \`[native, review-body]\`, ${CALLER('--edits', 'edits')}, and the mechanisms listed before it are unavailable:\n\n- \`native\`: ${RETRY_NOT_INLINE}`,
    ]]);
    assert.deepEqual(diagnostics(assessed), diagnostics(outcome));
    const retryItem = [`**Source:** [src/client.ts line 2 at ${SHORT}](${blobUrl('src/client.ts', '?plain=1#L2')})`, '', '```', '  const response = await request(id);', '```', '', 'Retry once on timeout.', '', ATTRIBUTION].join('\n');
    const review = onlyReview(world);
    assert.equal(review.body, MANUAL_EDIT('src/client.ts', 2, '  const response = await request(id).catch(() => request(id));', retryItem));
    assert.equal(review.comments.length, 1, 'the eligible edit stays a native suggestion');
    assertNoSuggestionInBody(world);

    // Listed alone, it is the requested delivery, even for an edit that could be native: no warning.
    const only = makeWorld();
    const requested = await publish(only, document([TYPO()]), { delivery: { edits: ['review-body'] } });
    assert.equal(status(requested), 'published', markdown(requested));
    assert.deepEqual(diagnostics(requested), []);
    assert.equal(onlyReview(only).body, readmeEdit(2, 'The widget client.', 'Fix the typo.'));
    assert.deepEqual(onlyReview(only).comments, []);
  });

  test('D-A25: a replacement that cannot be shown exactly makes `review-body` unavailable, with its reason and remedy', async () => {
    const hidden = result({ text: 'Mark the direction.', location: at('notes.txt', 2), fixes: [lineFix('notes.txt', 2, 'Note 2,\u200E revised.')] });
    const blocked = await assertBlockedEverywhere(makeWorld(), document([hidden]), { delivery: { edits: ['review-body'] } }, [
      `- \`delivery-unavailable\` at \`/runs/0/results/0\`: The edit of \`notes.txt\` line 2 cannot be delivered. \`edits\` is \`[review-body]\`, ${CALLER('--edits', 'edits')}, and no mechanism it lists is available:\n\n`
        + '- `review-body`: The replacement of `notes.txt` line 2 cannot be shown exactly in the review body: replacement line 1 contains U+200E, which a code block does not show.',
    ]);
    assert.deepEqual(diagnostics(blocked)[0]?.['remedies'], ['Change the replacement.', ...UNAVAILABLE_REMEDIES]);
  });

  test('D-A26: a group made by hand that makes the body too large is blocked whole, naming the group; nothing is written', async () => {
    const big = 'x'.repeat(31_000);
    const sarif = document([
      result({ text: 'First half.', group: 'big', location: at('notes.txt', 1), fixes: [lineFix('notes.txt', 1, big)] }),
      result({ text: 'Second half.', group: 'big', location: at('notes.txt', 2), fixes: [lineFix('notes.txt', 2, big)] }),
    ]);
    const options = { delivery: { groupedEdits: ['manual-group'] } };
    const world = makeWorld();
    const published = await publish(world, sarif, options);
    assert.equal(status(published), 'blocked', markdown(published));
    const [problem, ...rest] = diagnostics(published);
    assert.deepEqual(rest, []);
    assert.ok(problem);
    assert.equal(problem['code'], 'body-too-large');
    assert.match(String(problem['message']), /^The review body is (\d+) characters; the limit is 60000\. Proposals to make by hand in the body: the group `big` \(\1 characters\)\. Nothing is truncated or split\.$/);
    assert.deepEqual(writes(world), [], 'no write of any kind: no member is published');
    assert.deepEqual(diagnostics(await validate(world, sarif, options)), diagnostics(published));
  });
});

describe('companion bundles (D52; §9)', () => {
  const threeUnits = (): Json => document([
    TYPO('g1'), SPELLING('g1'),
    GUIDE_RESULT(),
    NOTE(1, 'g2'), NOTE(2, 'g2'),
  ], [created('docs/guide.md', GUIDE)]);

  test('D-A12: a single bundle holds every companion-delivered unit, one section each, in document order; per-unit gives one each', async () => {
    const bundled = makeWorld();
    const outcome = await publish(bundled, threeUnits(), { delivery: { preset: 'companion', companionBundle: 'single' } });
    assert.equal(status(outcome), 'published', markdown(outcome));
    const pull = onlyPull(bundled);
    assert.equal(pull.title, 'Suggestion for #7: 3 proposals (5 changes)');
    const order = ['**Proposal 1 of 3:** these 2 changes together:', '**Proposal 2 of 3:** this change:', '**Proposal 3 of 3:** these 2 changes together:'].map((lead) => pull.body.indexOf(lead));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0))), pull.body);
    assert.deepEqual(asArray(outcome['suggestions']).length, 1);

    const separate = makeWorld();
    const each = await publish(separate, threeUnits(), { delivery: { preset: 'companion' } });
    assert.equal(status(each), 'published', markdown(each));
    assert.deepEqual(pulls(separate).map((p) => p.title), ['Suggestion for #7: g1 (2 changes)', 'Suggestion for #7: create docs/guide.md', 'Suggestion for #7: g2 (2 changes)']);
  });

  test('D-A18: every proposed change in one companion: an edit, a group and a deletion, three sections, no native suggestion', async () => {
    const world = makeWorld();
    const sarif = document([LICENSE(), TYPO('g1'), SPELLING('g1'), OBSOLETE_RESULT()], [deleted('obsolete.txt')]);
    const outcome = await publish(world, sarif, { delivery: { preset: 'companion', companionBundle: 'single' } });
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(diagnostics(outcome), []);
    const pull = onlyPull(world);
    assert.equal(pull.title, 'Suggestion for #7: 3 proposals (4 changes)');
    // A deletion finding without a region has no source line: the change list already names the file (file-operation contract §2).
    const obsoleteItem = ['Remove the obsolete file.', '', ATTRIBUTION].join('\n');
    const sections = [
      ['- Edited [README.md line 4 at feedfee](' + blobUrl('README.md', '?plain=1#L4') + ')', readmeItem(4, 'Use the American spelling.')],
      ['- Edited [README.md line 2 at feedfee](' + blobUrl('README.md', '?plain=1#L2') + ')\n- Edited [README.md line 3 at feedfee](' + blobUrl('README.md', '?plain=1#L3') + ')',
        `${readmeItem(2, 'Fix the typo.')}\n\n---\n\n${readmeItem(3, 'Fix the spelling.')}`],
      [`- Deleted file [obsolete.txt at feedfee](${blobUrl('obsolete.txt')}): the whole file is removed`, obsoleteItem],
    ] as const;
    const expectedBody = [
      `Suggested in a review of #7 at commit ${HEAD}.`,
      '',
      'This pull request bundles 3 proposals, each in its own section below. Merging it into `feature/retry` applies all of them; bundling them does not mean they depend on one another.',
      '',
      DRAFT_NOTE,
      '',
      '---',
      '',
      '**Proposal 1 of 3:** this change:',
      '',
      sections[0][0],
      '',
      sections[0][1],
      '',
      '---',
      '',
      '**Proposal 2 of 3:** these 2 changes together:',
      '',
      sections[1][0],
      '',
      sections[1][1],
      '',
      '---',
      '',
      '**Proposal 3 of 3:** this change:',
      '',
      sections[2][0],
      '',
      sections[2][1],
    ].join('\n');
    assert.equal(pull.body.replace(SUGGESTION_MARKER, ''), expectedBody);
    assert.ok(SUGGESTION_MARKER.test(pull.body), 'the body ends with the convention\'s marker');
    assert.deepEqual(world.host.fileOnBranch(pull.head, 'README.md'), Buffer.from(readmeWith({ 2: 'The widget client.', 3: 'Receive updates.', 4: 'License: MIT.' })));
    assert.equal(world.host.fileOnBranch(pull.head, 'obsolete.txt'), null);

    const review = onlyReview(world);
    assert.deepEqual(review.comments, [], 'no native suggestion');
    const link = `**Suggestion pull request:** [#${String(pull.number)}](${pullUrl(pull.number)})`;
    assert.equal(review.body, [
      `${link}, proposal 1 of 3\n\nMerging it into \`feature/retry\` applies this change, with the 2 other proposals it bundles:\n\n${sections[0][0]}\n\n${sections[0][1]}`,
      `${link}, proposal 2 of 3\n\nMerging it into \`feature/retry\` applies these 2 changes together, with the 2 other proposals it bundles:\n\n${sections[1][0]}\n\n${sections[1][1]}`,
      `${link}, proposal 3 of 3\n\nMerging it into \`feature/retry\` applies this change, with the 2 other proposals it bundles:\n\n${sections[2][0]}\n\n${sections[2][1]}`,
    ].join('\n\n---\n\n'));
  });

  test('D-A13: alternatives are never in a bundle or committed; they are listed with their finding', async () => {
    const world = makeWorld();
    const withAlternatives = result({
      text: 'Fix the typo.', group: 'g1', location: at('README.md', 2),
      fixes: [lineFix('README.md', 2, 'The widget client.'), lineFix('README.md', 2, 'Our widget client.'), lineFix('README.md', 2, 'This widget client.')],
    });
    const outcome = await publish(world, document([withAlternatives, SPELLING('g1')]), { delivery: { preset: 'companion', companionBundle: 'single' } });
    assert.equal(status(outcome), 'published', markdown(outcome));
    const pull = onlyPull(world);
    assert.deepEqual(world.host.fileOnBranch(pull.head, 'README.md'), Buffer.from(readmeWith({ 2: 'The widget client.', 3: 'Receive updates.' })), 'only the primary fix is committed');
    assert.ok(onlyReview(world).body.includes('**Alternatives to consider:**'), 'listed with the finding');
    assert.equal(world.host.pulls().length, 1, 'no companion for an alternative');
  });

  test('D-A19: the limit of 10 companions blocks per-unit delivery and names the single bundle; single delivers all eleven in one', async () => {
    const eleven = document(Array.from({ length: 11 }, (_, i) => NOTE(i + 1)));
    const world = makeWorld();
    const blocked = await assertBlockedEverywhere(world, eleven, { delivery: { preset: 'companion' } }, [
      '- `too-many-suggestion-prs`: The review needs 11 suggestion pull requests; the limit is 10. Nothing is split or dropped.',
    ]);
    const [problem] = diagnostics(blocked);
    assert.deepEqual(problem?.['remedies'], [
      'Bundle them into one companion pull request (`--companion-bundle single`, `delivery.companionBundle: \'single\'`).',
      'Publish fewer proposals in one review, or group related changes.',
    ]);

    const bundled = makeWorld();
    const outcome = await publish(bundled, eleven, { delivery: { preset: 'companion', companionBundle: 'single' } });
    assert.equal(status(outcome), 'published', markdown(outcome));
    const pull = onlyPull(bundled);
    assert.equal(pull.title, 'Suggestion for #7: 11 proposals (11 changes)');
    assert.ok(pull.body.includes('**Proposal 11 of 11:** this change:'));
  });
});

describe('the configuration file (§11) and caller settings (§12)', () => {
  test('D-A16: an invalid configuration blocks with one diagnostic per problem, in file order, and nothing is taken from it', async () => {
    const world = makeWorld(repository({ configuration: '{"delivery":{"edits":["native","native"],"bundle":"single"}}' }));
    const blocked = await assertBlockedEverywhere(world, document([TYPO()]), undefined, [
      '- `delivery-configuration-invalid`: `.github/sarif-to-comment.json` on the default branch `main` cannot be used: `/delivery/edits/1` repeats `native`.',
      '- `delivery-configuration-invalid`: `.github/sarif-to-comment.json` on the default branch `main` cannot be used: `/delivery/bundle` is not a known setting.',
    ]);
    assert.deepEqual(diagnostics(blocked).map((d) => d['remedies']), [['Fix `.github/sarif-to-comment.json` on the default branch.'], ['Fix `.github/sarif-to-comment.json` on the default branch.']]);
  });

  test('D-A17: an invalid caller setting is a TypeError before anything is read', async () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [{ fileOperations: [] }, 'options.delivery.fileOperations must list at least one mechanism'],
      [{ edits: ['native', 'native'] }, 'options.delivery.edits[1] repeats `native`'],
      [{ groupedEdits: ['batch'] }, 'options.delivery.groupedEdits[0] is not one of `native-batch`, `companion`, `manual-group`'],
      [{ fileOperations: 'companion' }, 'options.delivery.fileOperations must be a list of mechanisms'],
      [{ preset: 'all' }, 'options.delivery.preset is not one of `original-pr`, `companion`'],
      [{ companionBundle: 'many' }, 'options.delivery.companionBundle is not one of `per-unit`, `single`'],
      [{ bundle: 'single' }, 'options.delivery.bundle is not a known setting'],
      [['companion'], 'options.delivery must be an object'],
    ];
    for (const [delivery, detail] of cases) {
      const world = makeWorld();
      for (const run of [publish, validate]) {
        await assert.rejects(run(world, document([TYPO()]), { delivery }), (err: unknown) => {
          assert.ok(err instanceof TypeError, String(err));
          assert.match(err.message, /^Invalid (publishSarifReview|validateSarifReview) input: /);
          assert.ok(err.message.endsWith(detail), err.message);
          return true;
        });
      }
      assert.deepEqual(world.host.log(), [], 'nothing was read');
    }
  });

  test('the removed allowSuggestionPullRequests option is refused as unknown', async () => {
    const world = makeWorld();
    await assert.rejects(publish(world, document([TYPO()]), { allowSuggestionPullRequests: true }), (err: unknown) =>
      err instanceof TypeError && err.message === 'Invalid publishSarifReview input: unknown option allowSuggestionPullRequests');
    assert.deepEqual(world.host.log(), []);
  });

  test('D-A21: when the caller decides every setting, the file is not read and its content has no effect', async () => {
    const invalid = '{"delivery":{"edits":"oops"}}';
    const world = makeWorld(repository({ configuration: invalid }));
    const outcome = await publish(world, document([TYPO()]), { delivery: { preset: 'companion', companionBundle: 'per-unit' } });
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.equal(readBlobOf(world, invalid), false, 'the configuration was not read');
    assert.equal(onlyPull(world).title, 'Suggestion for #7: edit README.md');

    for (const delivery of [{ preset: 'companion' }, { preset: 'original-pr' }, { edits: ['native'] }]) {
      const read = makeWorld(repository({ configuration: invalid }));
      await assertBlockedEverywhere(read, document([TYPO()]), { delivery }, [
        '- `delivery-configuration-invalid`: `.github/sarif-to-comment.json` on the default branch `main` cannot be used: `/delivery/edits` must be a list of mechanisms.',
      ]);
      assert.equal(readBlobOf(read, invalid), true, `read for ${JSON.stringify(delivery)}`);
    }
  });

  test('L15: a failed configuration read is operational: validate is incomplete and publish rejects, never a silent default', async () => {
    const world = makeWorld(repository(), { companion: { defaultBranchRead: 'server-error' } });
    const assessed = await validate(world, document([TYPO()]));
    assert.equal(status(assessed), 'incomplete', markdown(assessed));
    assert.deepEqual(diagnostics(assessed).map((d) => d['code']), ['assessment-incomplete']);
    await assert.rejects(publish(world, document([TYPO()])));
    assert.deepEqual(writes(world), []);
    assert.equal(fs.existsSync(world.statePath), false);

    // A caller that decides every setting does not depend on the read.
    const decided = await publish(world, document([TYPO()]), { delivery: { preset: 'original-pr', companionBundle: 'per-unit' } });
    assert.equal(status(decided), 'published', markdown(decided));
  });

  test(`the configuration lives at ${CONFIGURATION_PATH} on the default branch, never on the pull request's branch`, async () => {
    // The pull request's head has no configuration; the default branch's is the one that counts.
    const world = makeWorld(repository({ configuration: '{"delivery":{"preset":"companion"}}' }));
    const outcome = await publish(world, document([TYPO()]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.equal(onlyPull(world).title, 'Suggestion for #7: edit README.md');
  });

  test('D-A20: companion options with no companion planned give one note, recorded with the publication; with companions, none', async () => {
    const world = makeWorld();
    const options = { pullRequestLabels: ['team-a'], markSuggestionPullRequestsReady: true };
    const outcome = await publish(world, document([TYPO()]), options);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const note = 'No companion pull request is planned, so these options have no effect: `--pr-labels` (`pullRequestLabels`), `--mark-suggestion-prs-ready` (`markSuggestionPullRequestsReady`).';
    assert.deepEqual(coded(outcome), [['companion-options-unused', note]]);
    assert.equal(diagnostics(outcome)[0]?.['severity'], 'note');
    assert.equal(markdown(outcome).includes('**Published with'), false, 'a note is not a warning: no headline');
    const retried = await publish(world, document([TYPO()]), options);
    assert.deepEqual(diagnostics(retried), diagnostics(outcome), 'every later call reports it');

    const labelsOnly = makeWorld();
    const labelled = await validate(labelsOnly, document([TYPO()]), { pullRequestLabels: ['team-a'] });
    assert.deepEqual(coded(labelled), [['companion-options-unused', 'No companion pull request is planned, so these options have no effect: `--pr-labels` (`pullRequestLabels`).']]);

    const companions = makeWorld();
    const delivered = await publish(companions, document([TYPO()]), { ...options, delivery: { preset: 'companion' } });
    assert.equal(status(delivered), 'published', markdown(delivered));
    assert.deepEqual(diagnostics(delivered), []);
    const pull = onlyPull(companions);
    assert.equal(pull.draft, false);
    assert.deepEqual(pull.labels, ['suggestion-pr', 'team-a']);
  });

  test('a blocked publication carries no companion-options-unused note and no fallback warning', async () => {
    const world = makeWorld();
    const blocked = await assertBlockedEverywhere(world, document([RETRY(), GUIDE_RESULT()], [created('docs/guide.md', GUIDE)]), { pullRequestLabels: ['team-a'] }, [
      `- \`delivery-unavailable\` at \`/runs/0/results/0\`: The edit of \`src/client.ts\` line 2 cannot be delivered. \`edits\` is \`[native]\`, ${DEFAULT}, and no mechanism it lists is available:\n\n- \`native\`: ${RETRY_NOT_INLINE}`,
    ]);
    assert.deepEqual(diagnostics(blocked).map((d) => d['code']), ['delivery-unavailable']);
  });

});

describe('a block after a fallback names the fallback that contributed to it (§10.1)', () => {
  const BIG = `${'x'.repeat(1_000_000)}\n`;
  const bigCreation = (): Json => document([result({ text: 'Add a big file.', operation: create(0) })], [created('docs/big.md', BIG)]);
  const paragraph = (unit: string, mechanism: string, dimension: string, list: string, earlier: string): string =>
    `\n\nThis includes a proposal delivered by a fallback: ${unit} is delivered as \`${mechanism}\`, because \`${dimension}\` is \`[${list}]\` and the mechanisms listed before it (${earlier}) are unavailable.`;

  test('a file too large for a companion falls back into the body, which is then too large: body-too-large names the fallback; no warning', async () => {
    const world = makeWorld();
    const outcome = await publish(world, bigCreation(), { delivery: { fileOperations: ['companion', 'manual'] } });
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    // The file in the body also puts the review over the payload limit; both limits name the fallback.
    assert.deepEqual(diagnostics(outcome).map((d) => [d['severity'], d['code']]), [['error', 'body-too-large'], ['error', 'payload-too-large']],
      'no delivery-fallback warning: nothing is delivered');
    for (const blocking of diagnostics(outcome)) {
      assert.ok(String(blocking['message']).endsWith(`Nothing is truncated or split.${paragraph('the creation of `docs/big.md`', 'manual', 'fileOperations', 'companion, manual', '`companion`')}`),
        String(blocking['message']));
    }
    assert.deepEqual(diagnostics(await validate(world, bigCreation(), { delivery: { fileOperations: ['companion', 'manual'] } })), diagnostics(outcome));
    assert.deepEqual(writes(world), []);
  });

  test('without a fallback, the same block names none', async () => {
    const outcome = await publish(makeWorld(), bigCreation());
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    const [tooLarge] = diagnostics(outcome);
    assert.equal(tooLarge?.['code'], 'body-too-large');
    assert.ok(String(tooLarge['message']).endsWith('Nothing is truncated or split.'), String(tooLarge['message']));
  });

  test('a fallback to a companion that a repository check then refuses: the check names the fallback', async () => {
    const world = makeWorld(repository({ push: false }));
    const outcome = await publish(world, document([TYPO(), RETRY()]), { delivery: { edits: ['native', 'companion'] } });
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    const [refused, ...others] = diagnostics(outcome);
    assert.deepEqual(others, []);
    assert.equal(refused?.['code'], 'suggestion-pr-permission-missing');
    assert.equal(refused['message'], `The authenticated account cannot push to ${OWNER}/${REPO}, which creating proposal branches requires.`
      + paragraph('the edit of `src/client.ts` line 2', 'companion', 'edits', 'native, companion', '`native`'));
    assert.deepEqual(writes(world), []);
  });

  test('a companion that was the first choice is no fallback: the repository check names none', async () => {
    const world = makeWorld(repository({ push: false }));
    const outcome = await publish(world, document([RETRY()]), { delivery: { edits: ['companion'] } });
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    assert.equal(diagnostics(outcome)[0]?.['message'], `The authenticated account cannot push to ${OWNER}/${REPO}, which creating proposal branches requires.`);
  });
});
