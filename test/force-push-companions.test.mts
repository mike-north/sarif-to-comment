/**
 * Suggestion pull requests on a branch that moved, or whose history was
 * rewritten, after the review (issue #28; D58, D59), through the production
 * composition: the real public library with the real GitHub client
 * (src/github.cts), talking HTTP to the fake GitHub host
 * (test/fixtures/composition), which models ancestry through each commit's
 * parents, recursive trees, and `mergeable` as GitHub documents it (null
 * while computed). Only `fetch`, and the wait between reads of `mergeable`,
 * are replaced.
 *
 * Every expected value is written by hand from
 * docs/companion-suggestion-pr-contract.md (§2.5, §2.5.1, §2.8–§2.11),
 * docs/suggestion-pr-convention.md (§5.1, §7) and
 * docs/delivery-policy-contract.md (§10.3): every suggestion pull request is
 * proposed on the reviewed commit and never re-applied; after a rewritten
 * history each is projected onto the head before it is created, and the
 * projection's verdict, its description's projection section, its warning,
 * the observed `mergeable`, the plan's version 3 record, the reads it makes
 * and what a retry reports follow. Only the random suggestion and
 * publication ids are read back and substituted. What happens to a
 * suggestion whose projection is unfaithful (a fallback its list authorizes,
 * or a block) is specified in test/suggestion-pr-fallback.test.mts.
 *
 * The scenario mirrors the live experiment (docs/force-push-experiment.md):
 * C0 adds a 20-line file, the reviewed commit C1 changes its lines 5 and 6,
 * and the pull request's branch then moves forward (C2), is amended (C1′,
 * which keeps lines 5 and 6 and changes line 15), or is rewritten further.
 * At C1′ the suggestion editing lines 6 and 10 conflicts with the head:
 * line 6 touches the reviewed commit's own change, which C1′ made again (Git
 * conflicts on changes that touch unless identical), and the creation and
 * the deletion are faithful.
 *
 * The host models documented GitHub behavior; it is not evidence of live
 * GitHub behavior (see docs/evidence/companion-fidelity/README.md).
 *
 * @see https://docs.github.com/en/rest/commits/commits#compare-two-commits
 * @see https://docs.github.com/en/rest/git/trees#get-a-tree
 * @see https://docs.github.com/en/rest/git/blobs#get-a-blob
 * @see https://docs.github.com/en/rest/git/commits#create-a-commit
 * @see https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 */

import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { describe, test } from 'node:test';

import { findSuggestionMarker } from '../dist/suggestion-marker.cjs';
import type { IStoredPull } from './fixtures/composition/fake-http-companion.mts';
import {
  ADVANCED, AMENDED, AMENDED_LATER, ATTRIBUTION, BASE, DROPPED, HEAD_REF, LINE10_MESSAGE, LINE6_MESSAGE, NEW_MESSAGE, NEW_PAGE,
  OBSOLETE_MESSAGE, OWNER, PULL, REMARK, REPO, REVIEWED, REVIEWED_LINES, REVIEW_MARKER, SHORT, SNAPSHOTS, TOKEN,
  blob, blobReads, call, compareReads, documentWith, idsOf, jointFixDocument, makeWorld, markdown, proposalCommit, publish, publishWith, pullReads, pullUrl,
  recursiveTreeReads, repositoryAt, reviewDocument, sample, status, validate, validateWith, writes,
} from './fixtures/rewritten-history/world.mts';
import type { IWorld, Json } from './fixtures/rewritten-history/world.mts';
import { asArray, asRecord, parseJson } from './support/runtime-types.mts';

const DRAFT_NOTE = '**How this suggestion is accepted:** it is a draft pull request into `feature/retry`, the branch of #7. A draft cannot be merged: someone with write access first marks it ready for review. The author of #7 then decides whether to merge it, and #7 carries the change to its base. Once #7 is merged or closed, this pull request can be closed.';

/** One suggestion as §2.11 renders it: its title, change list, merge sentence tail and findings. */
interface IUnit {
  readonly title: string;
  readonly what: string;
  readonly changes: readonly string[];
  readonly items: readonly string[];
}

const REWORD: IUnit = {
  title: 'Suggestion for #7: reword (2 changes)',
  what: 'these 2 changes together:',
  changes: [
    `- Edited [docs/sample.md line 6 at ${SHORT}](${blob('docs/sample.md', '?plain=1#L6')})`,
    `- Edited [docs/sample.md line 10 at ${SHORT}](${blob('docs/sample.md', '?plain=1#L10')})`,
  ],
  items: [
    `**Source:** [docs/sample.md line 6 at ${SHORT}](${blob('docs/sample.md', '?plain=1#L6')})`, '', '```', 'Line 6, reviewed.', '```', '', LINE6_MESSAGE, '', ATTRIBUTION,
    '', '---', '',
    `**Source:** [docs/sample.md line 10 at ${SHORT}](${blob('docs/sample.md', '?plain=1#L10')})`, '', '```', 'Line 10.', '```', '', LINE10_MESSAGE, '', ATTRIBUTION,
  ],
};
const CREATE: IUnit = {
  title: 'Suggestion for #7: create docs/new.md',
  what: 'this change:',
  changes: ['- New file `docs/new.md`: 6 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644'],
  items: ['**Location:** line 1 of the proposed file', '', NEW_MESSAGE, '', ATTRIBUTION],
};
const DELETE: IUnit = {
  title: 'Suggestion for #7: delete obsolete.txt',
  what: 'this change:',
  changes: [`- Deleted file [obsolete.txt at ${SHORT}](${blob('obsolete.txt')}): the whole file is removed`],
  items: [OBSOLETE_MESSAGE, '', ATTRIBUTION],
};
const REMARK_SECTION = [REMARK, '', ATTRIBUTION];

/** The rewording's own changes, from the reviewed file (§2.11: three lines of context; the two changes share one hunk). */
const REWORD_DIFF = [
  '--- a/docs/sample.md',
  '+++ b/docs/sample.md',
  '@@ -3,11 +3,11 @@',
  ' Line 3.', ' Line 4.', ' Line 5, reviewed.',
  '-Line 6, reviewed.', '+Line 6, suggested.',
  ' Line 7.', ' Line 8.', ' Line 9.',
  '-Line 10.', '+Line 10, suggested.',
  ' Line 11.', ' Line 12.', ' Line 13.',
];

/** §2.11: the projection section of a suggestion projected onto `head`, faithful or conflicting in `conflicts`. */
function projection(head: string, conflicts: readonly string[], diff?: readonly string[]): string[] {
  const shown = diff === undefined ? 'listed below.' : 'these:';
  const verdict = conflicts.length === 0
    ? `applies only its own changes, which are ${shown}`
    : `conflicts in ${conflicts.map((p) => `\`${p}\``).join(' and ')}; its own changes are ${shown}`;
  const lead = `**The reviewed commit is not part of the branch of #7:** the branch was rewritten after commit ${REVIEWED} (its head was ${head} when this was proposed). `
    + 'GitHub shows this pull request\'s changes from an older merge base, so they also list changes of the reviewed commit itself. '
    + `Projected onto that head before this pull request was created, merging it ${verdict}`;
  return diff === undefined ? [lead] : [lead, '', '```diff', ...diff, '```'];
}

/** Convention §7: version 1, or version 2 naming the commit an unreleased build re-applied onto. */
function marker(id: string, batch: string, reappliedOnto?: string): string {
  const original = `"original":{"owner":"${OWNER}","repo":"${REPO}","pullNumber":${String(PULL)}}`;
  return reappliedOnto === undefined
    ? `<!-- suggestion-pr {"version":1,${original},"reviewedCommit":"${REVIEWED}","id":"${id}","batch":"${batch}"} -->`
    : `<!-- suggestion-pr {"version":2,${original},"reviewedCommit":"${REVIEWED}","reappliedOnto":"${reappliedOnto}","id":"${id}","batch":"${batch}"} -->`;
}

/** §2.11: a suggestion pull request's whole body, with its projection section when it was projected. */
function pullBody(unit: IUnit, ids: { readonly id: string; readonly batch: string }, projected?: readonly string[]): string {
  return [
    `Suggested in a review of #7 at commit ${REVIEWED}.`,
    '',
    ...(projected === undefined ? [] : [...projected, '']),
    `Merging this pull request into \`feature/retry\` applies ${unit.what}`,
    '',
    ...unit.changes,
    '',
    DRAFT_NOTE,
    '',
    '---',
    '',
    ...unit.items,
    '',
    marker(ids.id, ids.batch),
  ].join('\n');
}

/** §2.11: a version-2 plan's review section paragraph, kept as planned. */
const reappliedInReview = (head: string): string =>
  `The history of #7 was rewritten after the reviewed commit, so this change is re-applied onto commit ${head}, the head of #7 when it was proposed, where everything it changes is still exactly as reviewed.`;

/** §2.11: a created suggestion's section of the review body (with a version-2 plan's paragraph when given). */
function createdSection(unit: IUnit, number: number, reappliedOnto?: string): string[] {
  return [
    `**Suggestion pull request:** [#${String(number)}](${pullUrl(number)})`,
    '',
    ...(reappliedOnto === undefined ? [] : [reappliedInReview(reappliedOnto), '']),
    `Merging it into \`feature/retry\` applies ${unit.what}`,
    '',
    ...unit.changes,
    '',
    ...unit.items,
  ];
}

/**
 * §2.13.3: the companion index a review that creates these suggestion pull
 * requests begins with; a title is shown as a code span.
 */
function companionIndex(...created: readonly (readonly [unit: IUnit, number: number])[]): string[] {
  return [
    '**Companion pull requests of this review:**',
    '',
    ...created.map(([unit, n]) => `- [#${String(n)}](${pullUrl(n)}): \`${unit.title}\` — created with this review`),
  ];
}

/** §2.11: the review body's sections, joined as every review body's sections are. */
const reviewBody = (...sections: readonly (readonly string[])[]): string => sections.map((s) => s.join('\n')).join('\n\n---\n\n');

/** Contract §2.10: the retry paragraph for a plan on its base when the branch no longer contains it. */
function changedSincePlanned(base: string, head: string): string {
  return `**The branch of #7 changed since these suggestions were planned:** they are based on commit \`${base}\`, which is no longer part of it `
    + `(its head is now \`${head}\`). The suggestion pull requests still to be created are created on that commit, as planned; nothing is re-decided.`;
}

/** Contract §2.10: the retry paragraph for a projected plan whose head moved since. */
function changedSinceProjected(projectedHead: string, head: string): string {
  return `**The head of #7 changed since these suggestions were projected:** they were projected onto commit \`${projectedHead}\`, and the head is now \`${head}\`, `
    + 'so that projection no longer applies. The suggestion pull requests still to be created are created on the reviewed commit, as planned; nothing is re-decided or projected again.';
}

/** Delivery policy §10.3: the warning for a suggestion pull request projected to conflict. */
function conflictWarning(head: string, unit: string, paths: readonly string[], pointer = '/runs/0/results/0'): Json {
  return {
    severity: 'warning',
    code: 'companion-conflicts-at-head',
    title: 'A suggestion pull request is projected to conflict with the pull request\'s head',
    message: `Projected onto the head \`${head}\` of #7, merging the suggestion pull request for ${unit} would conflict in ${paths.map((p) => `\`${p}\``).join(' and ')}. `
      + 'It is created on the reviewed commit, as planned; GitHub shows the conflict to whoever merges it.',
    location: { pointer },
    remedies: ['Review the pull request\'s current head again, and publish that review.', 'Or resolve the conflict when merging the suggestion pull request.'],
  };
}

const CONFLICT_HEADLINE = '**Published with 1 warning:** A suggestion pull request is projected to conflict with the pull request\'s head.';
const REVIEWED_SAMPLE = sample(REVIEWED_LINES);

/** docs/sample.md on a proposal branch: `lines` with lines 6 and 10 replaced as suggested. */
function suggestedSample(lines: readonly string[]): Buffer {
  const edited = [...lines];
  edited[5] = 'Line 6, suggested.\n';
  edited[9] = 'Line 10, suggested.\n';
  return Buffer.from(edited.join(''));
}

/** The three created suggestions in order, with their ids, after asserting there are exactly three. */
function threePulls(world: IWorld): readonly [IStoredPull, IStoredPull, IStoredPull] {
  const [a, b, c, ...rest] = world.host.pulls();
  assert.ok(a && b && c && rest.length === 0, `exactly three suggestion pull requests: ${String(world.host.pulls().length)}`);
  return [a, b, c];
}

/** The plan at `world`'s state path. */
const planOf = (world: IWorld): Record<string, unknown> => asRecord(parseJson(fs.readFileSync(world.statePath, 'utf8')), 'the plan');

/** Every suggestion is created as before, on the reviewed commit, with version 1 markers and no projection. */
function assertProposedOnReviewed(world: IWorld, outcome: Json): void {
  assert.equal(status(outcome), 'published', markdown(outcome));
  const pulls = threePulls(world);
  for (const [pull, unit] of [[pulls[0], REWORD], [pulls[1], CREATE], [pulls[2], DELETE]] as const) {
    assert.equal(pull.title, unit.title);
    assert.equal(pull.body, pullBody(unit, idsOf(pull)));
    assert.deepEqual(proposalCommit(world, pull.head).parents, [REVIEWED]);
  }
  assert.deepEqual(world.host.fileOnBranch(pulls[0].head, 'docs/sample.md'), suggestedSample(REVIEWED_SAMPLE));
  assert.equal(proposalCommit(world, pulls[0].head).message,
    `Suggestion for #7: reword (2 changes)\n\nSuggested in a review of ${OWNER}/${REPO} pull request 7 at commit ${REVIEWED}.`);
  const [review] = world.host.reviews();
  assert.ok(review);
  assert.equal(review.request.commit_id, REVIEWED);
  assert.equal(review.request.body.replace(REVIEW_MARKER, ''), reviewBody(
    companionIndex([REWORD, pulls[0].number], [CREATE, pulls[1].number], [DELETE, pulls[2].number]),
    createdSection(REWORD, pulls[0].number), createdSection(CREATE, pulls[1].number), createdSection(DELETE, pulls[2].number), REMARK_SECTION,
  ));
  assert.ok(markdown(outcome).includes('Suggestion pull requests (drafts into `feature/retry`, labeled `suggestion-pr`):'), markdown(outcome));
  assert.doesNotMatch(markdown(outcome), /re-applied|projected|Warnings/);
  assert.equal(planOf(world)['version'], 1, 'a plan with nothing projected stays version 1');
  assert.deepEqual(recursiveTreeReads(world), [], 'nothing is projected');
}

// ---------------------------------------------------------------------------

describe('harness controls', () => {
  test('the fixture relates the commits as the experiment did', async () => {
    const world = makeWorld(ADVANCED);
    const comparison = async (a: string, b: string): Promise<Record<string, unknown>> =>
      asRecord(await (await world.host.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/compare/${a}...${b}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json());
    assert.equal((await comparison(REVIEWED, ADVANCED))['status'], 'ahead');
    assert.equal((await comparison(REVIEWED, AMENDED))['status'], 'diverged');
    assert.deepEqual((await comparison(REVIEWED, AMENDED))['merge_base_commit'], { sha: BASE }, 'GitHub names C0 as their merge base');
    assert.equal((await comparison(REVIEWED, BASE))['status'], 'behind');
    assert.equal((await comparison(REVIEWED, REVIEWED))['status'], 'identical');
  });

  test('the amended head keeps lines 5 and 6 as reviewed and changes line 15', () => {
    const at = (commit: string, line: number): string | undefined => SNAPSHOTS[commit]?.['docs/sample.md']?.[line - 1];
    for (const line of [5, 6, 10]) assert.equal(at(AMENDED, line), at(REVIEWED, line));
    assert.notEqual(at(AMENDED, 15), at(REVIEWED, 15));
  });
});

describe('the reviewed commit is still the head', () => {
  test('suggestions are proposed on it; no comparison beyond the review context, and nothing projected', async () => {
    const world = makeWorld(REVIEWED);
    assertProposedOnReviewed(world, await publish(world));
    assert.deepEqual(compareReads(world), [`${BASE}...${REVIEWED}`], 'only the merge-base comparison of the review context');
  });
});

describe('the branch moved forward: the reviewed commit is an ancestor of the head (§2.5)', () => {
  test('publication proceeds on the reviewed commit, exactly as for the head, with version 1 markers, and nothing is projected', async () => {
    const world = makeWorld(ADVANCED);
    assertProposedOnReviewed(world, await publish(world));
    assert.deepEqual(compareReads(world).filter((c) => c === `${REVIEWED}...${ADVANCED}`), [`${REVIEWED}...${ADVANCED}`],
      'the association and the ancestry share one comparison');
  });

  test('validate says what would be created, with no mention of a projection, and writes nothing', async () => {
    const world = makeWorld(ADVANCED);
    const assessed = await validate(world);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.ok(markdown(assessed).includes('Publication would also create 3 draft suggestion pull requests into `feature/retry`, labeled `suggestion-pr`.\n'), markdown(assessed));
    assert.doesNotMatch(markdown(assessed), /re-applied|projected|Warnings/);
    assert.deepEqual(writes(world), []);
  });
});

describe('a rewritten history: every suggestion stays on the reviewed commit and is projected onto the head first (§2.5.1)', () => {
  const MERGEABLE_CONFLICTING = { companion: { mergeable: { '101': { value: false } } } };

  test('faithful ones and one projected to conflict are all created on the reviewed commit; the conflict is warned of and GitHub\'s mergeable read back', async () => {
    const world = makeWorld(AMENDED, MERGEABLE_CONFLICTING);
    const outcome = await publish(world);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const pulls = threePulls(world);
    const projected = [projection(AMENDED, ['docs/sample.md'], REWORD_DIFF), projection(AMENDED, []), projection(AMENDED, [])];
    for (const [i, [pull, unit]] of ([[pulls[0], REWORD], [pulls[1], CREATE], [pulls[2], DELETE]] as const).entries()) {
      assert.equal(pull.title, unit.title);
      assert.equal(pull.base, HEAD_REF);
      assert.equal(pull.draft, true);
      assert.deepEqual(pull.labels, ['suggestion-pr']);
      assert.equal(pull.body, pullBody(unit, idsOf(pull), projected[i]));
      assert.deepEqual(proposalCommit(world, pull.head).parents, [REVIEWED], 'never re-applied onto the head');
      const reading = findSuggestionMarker(pull.body);
      assert.equal(reading.kind, 'marker');
      assert.equal(reading.fields.reappliedOnto, undefined, 'a version 1 marker');
    }
    // The edit is applied to the reviewed file: the head's line 15 is not in the proposal.
    assert.deepEqual(world.host.fileOnBranch(pulls[0].head, 'docs/sample.md'), suggestedSample(REVIEWED_SAMPLE));
    assert.deepEqual(world.host.fileOnBranch(pulls[1].head, 'docs/new.md'), Buffer.from(NEW_PAGE));
    assert.equal(world.host.fileOnBranch(pulls[2].head, 'obsolete.txt'), null);
    assert.equal(proposalCommit(world, pulls[0].head).message,
      `Suggestion for #7: reword (2 changes)\n\nSuggested in a review of ${OWNER}/${REPO} pull request 7 at commit ${REVIEWED}.`);

    const [review] = world.host.reviews();
    assert.ok(review);
    assert.equal(review.request.commit_id, REVIEWED, 'the review stays pinned to the reviewed commit');
    assert.equal(review.request.body.replace(REVIEW_MARKER, ''), reviewBody(
      companionIndex([REWORD, pulls[0].number], [CREATE, pulls[1].number], [DELETE, pulls[2].number]),
      createdSection(REWORD, pulls[0].number), createdSection(CREATE, pulls[1].number), createdSection(DELETE, pulls[2].number), REMARK_SECTION,
    ), 'the projection is in each suggestion pull request\'s own description, not in the review');

    assert.deepEqual(outcome['diagnostics'], [conflictWarning(AMENDED, 'the group `reword`', ['docs/sample.md'])]);
    assert.ok(markdown(outcome).startsWith(`## Draft review published\n\n${CONFLICT_HEADLINE}\n\n`), markdown(outcome));
    assert.deepEqual(outcome['suggestions'], [
      { number: pulls[0].number, url: pullUrl(pulls[0].number), branch: pulls[0].head, mergeable: 'conflicting' },
      { number: pulls[1].number, url: pullUrl(pulls[1].number), branch: pulls[1].head },
      { number: pulls[2].number, url: pullUrl(pulls[2].number), branch: pulls[2].head },
    ]);
    assert.ok(markdown(outcome).includes([
      `Suggestion pull requests (drafts into \`feature/retry\`, labeled \`suggestion-pr\`, proposed on the reviewed commit and projected onto the head \`${AMENDED}\`):`,
      '',
      `- [#${String(pulls[0].number)}](${pullUrl(pulls[0].number)}) from \`${pulls[0].head}\`: projected to conflict; GitHub reports it as conflicting.`,
      `- [#${String(pulls[1].number)}](${pullUrl(pulls[1].number)}) from \`${pulls[1].head}\``,
      `- [#${String(pulls[2].number)}](${pullUrl(pulls[2].number)}) from \`${pulls[2].head}\``,
    ].join('\n')), markdown(outcome));
    // GitHub answered null (computing) first, then false; one wait of 2 seconds in between.
    assert.equal(pullReads(world, pulls[0].number), 2);
    assert.deepEqual(world.waits, [2000]);
    assert.equal(pullReads(world, pulls[1].number), 0, 'a faithful suggestion\'s mergeability is not read');
  });

  test('the plan records the projection once, as version 3 (§2.9)', async () => {
    const world = makeWorld(AMENDED, MERGEABLE_CONFLICTING);
    await publish(world);
    const plan = planOf(world);
    assert.equal(plan['version'], 3);
    assert.deepEqual(plan['projection'], {
      head: AMENDED,
      mergeBase: BASE,
      suggestions: [
        { verdict: 'conflicts', conflicts: ['docs/sample.md'] },
        { verdict: 'faithful', conflicts: [] },
        { verdict: 'faithful', conflicts: [] },
      ],
    });
    assert.equal(Object.hasOwn(plan, 'reappliedOnto'), false);
  });

  test('what the projection reads, once per publication: one comparison shared with the association, three recursive trees, and three blobs', async () => {
    const world = makeWorld(AMENDED, MERGEABLE_CONFLICTING);
    await publish(world);
    assert.deepEqual(compareReads(world).filter((c) => c === `${REVIEWED}...${AMENDED}`), [`${REVIEWED}...${AMENDED}`]);
    assert.equal(recursiveTreeReads(world).length, 3, 'the trees of C0, C1 and C1′');
    assert.equal(new Set(recursiveTreeReads(world)).size, 3);
    // docs/sample.md is the only file both sides changed differently: its blobs at C0, C1 and C1′, each once.
    assert.equal(blobReads(world).length, 3, JSON.stringify(blobReads(world)));
    assert.equal(new Set(blobReads(world)).size, 3);
  });

  test('validate reports the same verdicts, labelled a projection, and writes nothing', async () => {
    const world = makeWorld(AMENDED);
    const assessed = await validate(world);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.ok(markdown(assessed).includes(
      'Publication would also create 3 draft suggestion pull requests into `feature/retry`, labeled `suggestion-pr`. The history of #7 was rewritten after the reviewed commit, '
      + `so the 3 suggestion pull requests are proposed on that commit and were projected onto the head \`${AMENDED}\`: merging 2 applies only their own changes, and merging 1 would conflict.`,
    ), markdown(assessed));
    assert.ok(markdown(assessed).startsWith('## Ready to publish\n\n**Ready to publish with 1 warning:** A suggestion pull request is projected to conflict with the pull request\'s head.\n'), markdown(assessed));
    assert.deepEqual(assessed['diagnostics'], [conflictWarning(AMENDED, 'the group `reword`', ['docs/sample.md'])]);
    assert.deepEqual(writes(world), []);
  });

  test('only faithful suggestions: no warning, and validate says each applies only its own changes', async () => {
    const world = makeWorld(AMENDED);
    const outcome = await publishWith(world, documentWith(['create', 'delete', 'remark']));
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(outcome['diagnostics'], []);
    assert.equal(world.host.pulls().length, 2);
    assert.deepEqual(world.waits, [], 'nothing projected to conflict, so mergeability is not read');
    const assessed = await validateWith(makeWorld(AMENDED), documentWith(['create', 'delete', 'remark']));
    assert.ok(markdown(assessed).includes(
      `so the 2 suggestion pull requests are proposed on that commit and were projected onto the head \`${AMENDED}\`: merging 2 applies only their own changes.`,
    ), markdown(assessed));
    const one = await validateWith(makeWorld(AMENDED), documentWith(['create']));
    assert.ok(markdown(one).includes(
      `Publication would also create 1 draft suggestion pull request into \`feature/retry\`, labeled \`suggestion-pr\`. The history of #7 was rewritten after the reviewed commit, so it is proposed on that commit and was projected onto the head \`${AMENDED}\`: merging it applies only its own changes.`,
    ), markdown(one));
  });

  test('GitHub\'s mergeable is reported as observed: mergeable, or unknown when it never computed it after the bounded wait', async () => {
    const mergeable = makeWorld(AMENDED, { companion: { mergeable: { '101': { value: true, pendingReads: 2 } } } });
    const reported = await publish(mergeable);
    assert.equal(asRecord(asArray(reported['suggestions'])[0])['mergeable'], 'mergeable');
    assert.ok(markdown(reported).includes(': projected to conflict; GitHub reports it as mergeable.'), markdown(reported));
    assert.deepEqual(mergeable.waits, [2000, 3000]);

    const unknown = makeWorld(AMENDED);
    const unread = await publish(unknown);
    assert.equal(status(unread), 'published', markdown(unread));
    assert.equal(asRecord(asArray(unread['suggestions'])[0])['mergeable'], 'unknown');
    assert.ok(markdown(unread).includes(': projected to conflict; GitHub has not reported whether it can be merged.'), markdown(unread));
    assert.deepEqual(unknown.waits, [2000, 3000, 5000], 'four reads at most, waiting 2, 3 and 5 seconds');
    assert.equal(pullReads(unknown, 101), 4);
  });

  test('a failed read of mergeable is an unknown observation, never a failure', async () => {
    const world = makeWorld(AMENDED, { companion: { pullReads: { '101': 'server-error' } } });
    const outcome = await publish(world);
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.equal(asRecord(asArray(outcome['suggestions'])[0])['mergeable'], 'unknown');
  });

  test('a truncated tree listing cannot be projected: a strict group is blocked naming the commit, and nothing is written', async () => {
    const world = makeWorld(AMENDED, { truncatedTrees: [AMENDED] });
    const outcome = await publishWith(world, documentWith(['reword', 'remark']));
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    const [diagnostic] = asArray(outcome['diagnostics']).map((d) => asRecord(d));
    assert.ok(diagnostic);
    assert.equal(diagnostic['code'], 'delivery-unavailable');
    assert.ok(String(diagnostic['message']).endsWith(
      `- \`companion\`: The history of #7 was rewritten after the reviewed commit, and whether merging its suggestion pull request into the head \`${AMENDED}\` `
      + `would apply exactly its own changes cannot be projected: GitHub listed the tree of commit \`${AMENDED}\` as truncated.`,
    ), String(diagnostic['message']));
    assert.deepEqual(writes(world), []);
  });
});

describe('merge attributes, a deletion applied again, and a head that already has a suggestion (§2.5.1)', () => {
  /** The snapshots with `.gitattributes` holding `attributes` at the base, the reviewed commit and the amended head. */
  const withAttributes = (attributes: string): typeof SNAPSHOTS => Object.fromEntries(Object.entries(SNAPSHOTS).map(([commit, files]) => [
    commit, [BASE, REVIEWED, AMENDED].includes(commit) ? { ...files, '.gitattributes': [attributes] } : files,
  ]));

  test('regression: a `merge=union` driver on the conflicting file cannot be projected: a strict group is blocked naming it, and nothing is written', async () => {
    const world = makeWorld(AMENDED, {}, { snapshots: withAttributes('*.md merge=union\n') });
    const outcome = await publishWith(world, documentWith(['reword', 'remark']));
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    const [diagnostic] = asArray(outcome['diagnostics']).map((d) => asRecord(d));
    assert.ok(diagnostic);
    assert.equal(diagnostic['code'], 'delivery-unavailable');
    assert.ok(String(diagnostic['message']).endsWith(
      `- \`companion\`: The history of #7 was rewritten after the reviewed commit, and whether merging its suggestion pull request into the head \`${AMENDED}\` `
      + 'would apply exactly its own changes cannot be projected: a merge attribute (`merge=union`) applies to `docs/sample.md`; its merge cannot be projected.',
    ), String(diagnostic['message']));
    assert.deepEqual(writes(world), []);
  });

  test('the text merge named in `.gitattributes` projects as without it: the group is created, projected to conflict', async () => {
    const world = makeWorld(AMENDED, { companion: { mergeable: { '101': { value: false } } } }, { snapshots: withAttributes('*.md merge=text\n') });
    const outcome = await publishWith(world, documentWith(['reword', 'remark']));
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(outcome['diagnostics'], [conflictWarning(AMENDED, 'the group `reword`', ['docs/sample.md'])]);
  });

  test('a deletion the rewrite dropped would be applied again: the group is blocked, naming the file the head would lose', async () => {
    // The reviewed commit deleted legacy.txt; the amended head kept it, so a
    // merge over the base would delete it again.
    const snapshots = { ...SNAPSHOTS, [BASE]: { ...SNAPSHOTS[BASE], 'legacy.txt': ['old\n'] }, [AMENDED]: { ...SNAPSHOTS[AMENDED], 'legacy.txt': ['old\n'] } };
    const world = makeWorld(AMENDED, {}, { snapshots });
    const outcome = await publishWith(world, documentWith(['reword', 'remark']));
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    const [diagnostic] = asArray(outcome['diagnostics']).map((d) => asRecord(d));
    assert.ok(diagnostic);
    assert.ok(String(diagnostic['message']).endsWith(
      `- \`companion\`: The history of #7 was rewritten after the reviewed commit, and projected onto its head \`${AMENDED}\`, merging its suggestion pull request `
      + 'would not apply exactly its own changes: `legacy.txt` would be removed from the head.',
    ), String(diagnostic['message']));
    assert.deepEqual(writes(world), []);
  });

  test('a head that already has the suggestion\'s changes: created, and its description says merging it changes nothing', async () => {
    const already = sample({ ...REVIEWED_LINES, 6: 'Line 6, suggested.', 10: 'Line 10, suggested.', 15: 'Line 15, later.' });
    const world = makeWorld(AMENDED, {}, { snapshots: { ...SNAPSHOTS, [AMENDED]: { ...SNAPSHOTS[AMENDED], 'docs/sample.md': already } } });
    const outcome = await publishWith(world, documentWith(['reword', 'remark']));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const [pull, ...rest] = world.host.pulls();
    assert.ok(pull && rest.length === 0);
    const lead = `**The reviewed commit is not part of the branch of #7:** the branch was rewritten after commit ${REVIEWED} (its head was ${AMENDED} when this was proposed). `
      + 'GitHub shows this pull request\'s changes from an older merge base, so they also list changes of the reviewed commit itself. '
      + 'Projected onto that head before this pull request was created, merging it changes nothing, because the head already has its own changes, which are these:';
    assert.equal(pull.body, pullBody(REWORD, idsOf(pull), [lead, '', '```diff', ...REWORD_DIFF, '```']));
    assert.deepEqual(outcome['diagnostics'], []);
  });

  test('validate says so for a head that already has the suggestion\'s changes, and writes nothing', async () => {
    const already = sample({ ...REVIEWED_LINES, 6: 'Line 6, suggested.', 10: 'Line 10, suggested.', 15: 'Line 15, later.' });
    const world = makeWorld(AMENDED, {}, { snapshots: { ...SNAPSHOTS, [AMENDED]: { ...SNAPSHOTS[AMENDED], 'docs/sample.md': already } } });
    const outcome = await validateWith(world, documentWith(['reword', 'remark']));
    assert.ok(markdown(outcome).includes(
      `The history of #7 was rewritten after the reviewed commit, so it is proposed on that commit and was projected onto the head \`${AMENDED}\`: `
      + 'merging it changes nothing, because the head already has its own changes.',
    ), markdown(outcome));
    assert.deepEqual(writes(world), []);
  });
});

describe('a single bundle after a rewritten history (delivery policy §9)', () => {
  test('the bundle as planned is projected: one suggestion pull request, its projection section once, and the warning names the bundle', async () => {
    const world = makeWorld(AMENDED);
    const outcome = await call('publishSarifReview', world, reviewDocument(), { groupedEdits: ['companion'], fileOperations: ['companion'], companionBundle: 'single' });
    assert.equal(status(outcome), 'published', markdown(outcome));
    const [pull, ...others] = world.host.pulls();
    assert.ok(pull && others.length === 0, 'one bundle');
    assert.deepEqual(proposalCommit(world, pull.head).parents, [REVIEWED]);
    assert.ok(pull.body.startsWith(`Suggested in a review of #7 at commit ${REVIEWED}.\n\n${projection(AMENDED, ['docs/sample.md'], REWORD_DIFF).join('\n')}\n\nThis pull request bundles 3 proposals`), pull.body);
    // §10.3: a bundle of several proposals is named as the bundle, not by one unit.
    const expected = {
      ...conflictWarning(AMENDED, 'unused', ['docs/sample.md']),
      message: `Projected onto the head \`${AMENDED}\` of #7, merging the suggestion pull request bundling 3 proposals would conflict in \`docs/sample.md\`. `
        + 'It is created on the reviewed commit, as planned; GitHub shows the conflict to whoever merges it.',
    };
    assert.deepEqual(outcome['diagnostics'], [expected]);
    assert.deepEqual(asRecord(planOf(world)['projection'])['suggestions'], [{ verdict: 'conflicts', conflicts: ['docs/sample.md'] }]);
  });
});

describe('a fix with several changes (issue #29) after a rewritten history (§2.3, §2.5.1)', () => {
  test('one suggestion pull request on the reviewed commit, projected to conflict, with its own changes shown', async () => {
    const world = makeWorld(AMENDED);
    const outcome = await publishWith(world, jointFixDocument());
    assert.equal(status(outcome), 'published', markdown(outcome));
    const [pull, ...others] = world.host.pulls();
    assert.ok(pull && others.length === 0, 'exactly one suggestion pull request');
    assert.equal(pull.title, 'Suggestion for #7: edit docs/sample.md');
    assert.ok(pull.body.includes(projection(AMENDED, ['docs/sample.md'], REWORD_DIFF).join('\n')), pull.body);
    assert.deepEqual(proposalCommit(world, pull.head).parents, [REVIEWED]);
    assert.equal(proposalCommit(world, pull.head).message,
      `Suggestion for #7: edit docs/sample.md\n\nSuggested in a review of ${OWNER}/${REPO} pull request 7 at commit ${REVIEWED}.`);
    assert.deepEqual(world.host.fileOnBranch(pull.head, 'docs/sample.md'), suggestedSample(REVIEWED_SAMPLE));
    assert.deepEqual(outcome['diagnostics'], [conflictWarning(AMENDED, 'the fix with 2 changes at `/runs/0/results/0`', ['docs/sample.md'])]);
  });
});

describe('recovery and retry of a projected plan (§2.9, §2.10)', () => {
  test('a lost pull request response is rediscovered by its version 1 marker, never resent', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    const first = await publish(world);
    assert.equal(status(first), 'uncertain', markdown(first));
    world.host.setConfig({ companion: {} });
    const second = await publish(world);
    assert.equal(status(second), 'published', markdown(second));
    const pulls = threePulls(world);
    const projected = [projection(AMENDED, ['docs/sample.md'], REWORD_DIFF), projection(AMENDED, []), projection(AMENDED, [])];
    for (const [i, unit] of [REWORD, CREATE, DELETE].entries()) {
      const pull = pulls[i];
      assert.ok(pull);
      assert.equal(pull.body, pullBody(unit, idsOf(pull), projected[i]));
    }
    assert.equal(writes(world).filter((w) => w === '/pulls').length, 3, 'one create per suggestion');
    assert.equal(world.host.reviews().length, 1);
  });

  test('a retry never re-decides or projects again: the head rewritten again in between changes nothing planned, and the outcome says the projection no longer applies', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    const before = world.host.log().length;
    // The author force-pushes again.
    world.host.replaceRepository(repositoryAt(DROPPED));
    world.host.setConfig({ companion: {} });
    const retried = await publish(world);
    assert.equal(status(retried), 'published', markdown(retried));
    const retry = world.host.log().slice(before);
    assert.equal(retry.filter((r) => r.path.includes('/compare/')).length, 0, 'no comparison: a projected plan compares heads');
    assert.equal(retry.filter((r) => r.query === 'recursive=1').length, 0, 'nothing is projected again');
    assert.equal(retry.filter((r) => r.method === 'GET' && r.path === `/repos/${OWNER}/${REPO}/pulls/${String(PULL)}`).length, 3,
      'the head is read again before each of the three suggestions still to be created');
    for (const pull of threePulls(world)) assert.deepEqual(proposalCommit(world, pull.head).parents, [REVIEWED], 'still on the reviewed commit');
    assert.ok(markdown(retried).includes(changedSinceProjected(AMENDED, DROPPED)), markdown(retried));
    assert.ok(markdown(retried).includes(`proposed on the reviewed commit and projected onto the head \`${AMENDED}\`):`), markdown(retried));
    const note = asArray(retried['diagnostics']).map((d) => asRecord(d)).find((d) => d['code'] === 'suggestion-branch-moved');
    assert.ok(note, 'the change is a note');
    assert.equal(note['message'], changedSinceProjected(AMENDED, DROPPED).replace(/^\*\*(.*?):\*\* /, '$1: '));
  });

  test('a retry whose head is still the projected one says nothing about it', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.setConfig({ companion: {} });
    const retried = await publish(world);
    assert.equal(status(retried), 'published', markdown(retried));
    assert.doesNotMatch(markdown(retried), /changed since these suggestions were/);
  });

  test('a plan on the reviewed commit (version 1) still reports a branch rewritten after planning, and re-decides nothing', async () => {
    const world = makeWorld(ADVANCED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.replaceRepository(repositoryAt(AMENDED));
    world.host.setConfig({ companion: {} });
    const retried = await publish(world);
    assert.equal(status(retried), 'published', markdown(retried));
    for (const pull of threePulls(world)) assert.deepEqual(proposalCommit(world, pull.head).parents, [REVIEWED]);
    assert.ok(markdown(retried).includes(changedSincePlanned(REVIEWED, AMENDED)), markdown(retried));
    assert.equal(planOf(world)['version'], 1);
  });

  test('a version 1 plan whose branch only moved forward from its base gives no paragraph', async () => {
    const world = makeWorld(ADVANCED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.replaceRepository({ ...repositoryAt(AMENDED_LATER), parents: { ...repositoryAt(AMENDED_LATER).parents, [AMENDED_LATER]: [ADVANCED] } });
    world.host.setConfig({ companion: {} });
    const retried = await publish(world);
    assert.equal(status(retried), 'published', markdown(retried));
    assert.doesNotMatch(markdown(retried), /changed since these suggestions were/);
  });

  test('an uncertain retry carries the paragraph as well', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.replaceRepository(repositoryAt(DROPPED));
    world.host.hide({ pulls: 1 });
    const retried = await publish(world);
    assert.equal(status(retried), 'uncertain', markdown(retried));
    assert.ok(markdown(retried).includes(changedSinceProjected(AMENDED, DROPPED)), markdown(retried));
  });

  test('a retry whose head cannot be read says so, and still publishes as planned', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.setConfig({ companion: { pullReads: { [String(PULL)]: 'server-error' } } });
    const retried = await publish(world);
    assert.equal(status(retried), 'published', markdown(retried));
    const text = markdown(retried);
    const start = `**Whether the branch of #7 changed since these suggestions were planned is not known:** they were projected onto commit \`${AMENDED}\`, and the branch could not be read (`;
    const at = text.indexOf(start);
    assert.ok(at >= 0, text);
    const paragraph = text.slice(at).split('\n')[0] ?? '';
    assert.match(paragraph, /502/);
    assert.ok(paragraph.endsWith('). Nothing is re-decided.'), paragraph);
    assert.ok(text.indexOf(paragraph) < text.indexOf('Suggestion pull requests ('), 'before the list');
    assert.ok(asArray(retried['diagnostics']).some((d) => asRecord(d)['code'] === 'suggestion-branch-unreadable'));
    for (const pull of threePulls(world)) assert.deepEqual(proposalCommit(world, pull.head).parents, [REVIEWED]);
  });

  test('a retry refused by GitHub carries the paragraph after its refusal', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.replaceRepository(repositoryAt(DROPPED));
    world.host.setConfig({ companion: { refuse: { ref: 422 } } });
    const retried = await publish(world);
    assert.equal(status(retried), 'rejected', markdown(retried));
    const text = markdown(retried);
    assert.ok(text.includes(changedSinceProjected(AMENDED, DROPPED)), text);
    assert.ok(text.indexOf('It is never resent') < text.indexOf(changedSinceProjected(AMENDED, DROPPED)), 'after the refusal');
    assert.deepEqual(world.host.reviews(), [], 'the review is not published');
  });

  test('a completed publication is reported from its receipts: nothing written, nothing compared or projected; GitHub\'s mergeable is read again for the one projected to conflict', async () => {
    const world = makeWorld(AMENDED, { companion: { mergeable: { '101': { value: false } } } });
    assert.equal(status(await publish(world)), 'published');
    const sent = writes(world).length;
    const before = world.host.log().length;
    world.host.replaceRepository(repositoryAt(DROPPED));
    const again = await publish(world);
    assert.equal(status(again), 'published', markdown(again));
    assert.equal(writes(world).length, sent);
    const retry = world.host.log().slice(before);
    assert.equal(retry.filter((r) => r.path.includes('/compare/') || r.query === 'recursive=1').length, 0);
    assert.equal(retry.filter((r) => r.path === `/repos/${OWNER}/${REPO}/pulls/${String(PULL)}`).length, 0, 'nothing is left to create, so the head is not read');
    assert.equal(retry.filter((r) => r.path === `/repos/${OWNER}/${REPO}/pulls/101`).length, 1);
    assert.equal(asRecord(asArray(again['suggestions'])[0])['mergeable'], 'conflicting');
    assert.doesNotMatch(markdown(again), /changed since these suggestions were/);
  });
});

/** Canonical JSON (sorted keys), as the plan's fingerprint is computed over it (contract §2.9). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(Reflect.get(value, k))}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

describe('a plan of version 2, written by unreleased builds that re-applied suggestions, is still read and continued as planned (§2.9)', () => {
  /**
   * The version-2 plan such a build wrote for the creation and the deletion
   * at C1′: plans this publication on C1′, stopping before any step (its
   * first Git write fails), then rewrites the plan as that build wrote it:
   * version 2, `reappliedOnto` C1′, no projection, version 2 markers.
   */
  async function versionTwoPlan(world: IWorld): Promise<void> {
    world.host.setConfig({ companion: { failBeforeStore: ['blob'] } });
    await assert.rejects(publishWith(world, documentWith(['create', 'delete'])), /502/);
    const plan = planOf(world);
    delete plan['planFingerprint'];
    delete plan['projection'];
    const suggestions = asArray(plan['suggestions']).map((s) => {
      const suggestion = asRecord(s);
      const body = String(suggestion['body']);
      const reading = findSuggestionMarker(body);
      assert.equal(reading.kind, 'marker');
      const v1 = marker(reading.fields.id, reading.fields.batch);
      return { ...suggestion, body: body.replace(v1, marker(reading.fields.id, reading.fields.batch, AMENDED)) };
    });
    const legacy = { ...plan, version: 2, reappliedOnto: AMENDED, suggestions };
    const fingerprint = `sha256:${crypto.createHash('sha256').update(canonicalJson(legacy), 'utf8').digest('hex')}`;
    fs.writeFileSync(world.statePath, JSON.stringify({ ...legacy, planFingerprint: fingerprint }, null, 2));
    world.host.setConfig({ companion: {} });
  }

  test('its suggestions are created on its `reappliedOnto`, with version 2 markers, and its review keeps the paragraph it was planned with', async () => {
    const world = makeWorld(AMENDED);
    await versionTwoPlan(world);
    const outcome = await publishWith(world, documentWith(['create', 'delete']));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const [creation, deletion, ...rest] = world.host.pulls();
    assert.ok(creation && deletion && rest.length === 0);
    for (const pull of [creation, deletion]) {
      assert.deepEqual(proposalCommit(world, pull.head).parents, [AMENDED]);
      const reading = findSuggestionMarker(pull.body);
      assert.ok(reading.kind === 'marker' && reading.fields.reappliedOnto === AMENDED, pull.body);
    }
    const [review] = world.host.reviews();
    assert.ok(review);
    assert.equal(review.request.body.replace(REVIEW_MARKER, ''), reviewBody(
      // The plan was written with the companion index, which the version-2 rewrite keeps.
      companionIndex([CREATE, creation.number], [DELETE, deletion.number]),
      createdSection(CREATE, creation.number, AMENDED), createdSection(DELETE, deletion.number, AMENDED),
    ));
    assert.ok(markdown(outcome).includes(`labeled \`suggestion-pr\`, re-applied onto commit \`${AMENDED}\`):`), markdown(outcome));
  });

  test('a lost pull request response is rediscovered by its version 2 marker, never resent', async () => {
    const world = makeWorld(AMENDED);
    await versionTwoPlan(world);
    world.host.setConfig({ companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    const first = await publishWith(world, documentWith(['create', 'delete']));
    assert.equal(status(first), 'uncertain', markdown(first));
    world.host.setConfig({ companion: {} });
    const second = await publishWith(world, documentWith(['create', 'delete']));
    assert.equal(status(second), 'published', markdown(second));
    assert.equal(writes(world).filter((w) => w === '/pulls').length, 2, 'one create per suggestion');
  });
});

describe('the projection is read only when a suggestion pull request could be created (§2.5, §2.8)', () => {
  const remarkOnly = (): Json => {
    const doc = reviewDocument();
    const [run] = asArray(doc['runs']);
    const results = asArray(asRecord(run)['results']);
    return { ...doc, runs: [{ ...asRecord(run), results: results.slice(4) }] };
  };

  test('a review that creates no suggestion pull request makes no read beyond the association of its reviewed commit', async () => {
    const world = makeWorld(AMENDED);
    const assessed = await validateWith(world, remarkOnly());
    assert.equal(status(assessed), 'ready', markdown(assessed));
    const outcome = await publishWith(world, remarkOnly());
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(compareReads(world).filter((c) => !c.startsWith(`${BASE}...`)), [`${REVIEWED}...${AMENDED}`, `${REVIEWED}...${AMENDED}`],
      'one association comparison per operation');
    assert.deepEqual(recursiveTreeReads(world), [], 'nothing is projected');
  });

  test('when one is needed, a failed read is operational: validate is incomplete, publish rejects, and nothing is written', async () => {
    const world = makeWorld(AMENDED, { failAncestryCompare: 404 });
    const assessed = await validate(world);
    assert.equal(status(assessed), 'incomplete', markdown(assessed));
    assert.match(markdown(assessed), /404/);
    await assert.rejects(publish(world), /404/);
    assert.deepEqual(writes(world), []);
    assert.equal(fs.existsSync(world.statePath), false);
  });
});

describe('every problem is reported together after a rewritten history too (§2.8)', () => {
  const pages = (): Json => {
    const artifacts = Array.from({ length: 11 }, (_, i) => ({ location: { uri: `docs/p${String(i)}.md` }, contents: { text: `# ${String(i)}\n` }, encoding: 'utf-8' }));
    const results = artifacts.map((_, i) => ({
      message: { text: `Page ${String(i)}.` },
      properties: { sarifToComment: { proposedFileChanges: [{ operation: 'create', artifactIndex: i }], ...(i === 0 ? { suggestionGroup: 'solo' } : {}) } },
    }));
    const [run] = asArray(reviewDocument()['runs']);
    return { ...reviewDocument(), runs: [{ ...asRecord(run), artifacts, results }] };
  };
  const problems = [
    '- `suggestion-group-single-change` at `/runs/0/results/0`: Suggestion group "solo" holds only one distinct change; a group needs at least two changes to accept together. Remove the group, and the change is published on its own.',
    '- `too-many-suggestion-prs`: The review needs 11 suggestion pull requests; the limit is 10. Nothing is split or dropped.',
  ];

  for (const head of [REVIEWED, AMENDED]) {
    test(`the limit is reported with the other problems (${head === REVIEWED ? 'head is the reviewed commit' : 'rewritten history'})`, async () => {
      const world = makeWorld(head);
      const assessed = await validateWith(world, pages());
      assert.equal(status(assessed), 'blocked', markdown(assessed));
      for (const line of problems) assert.ok(markdown(assessed).includes(line), markdown(assessed));
      assert.ok(markdown(assessed).includes('**Review blocked:** 2 problems must be resolved'), markdown(assessed));
    });
  }
});
