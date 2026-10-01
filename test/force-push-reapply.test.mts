/**
 * Suggestion pull requests on a branch that moved, or whose history was
 * rewritten, after the review (issue #28), through the production
 * composition: the real public library and CLI with the real GitHub client
 * (src/github.cts), talking HTTP to the fake GitHub host
 * (test/fixtures/composition), which models ancestry through each commit's
 * parents. Only `fetch` is replaced.
 *
 * Every expected value is written by hand from
 * docs/companion-suggestion-pr-contract.md (§2.5, §2.5.1, §2.8–§2.11) and
 * docs/suggestion-pr-convention.md (§5.1, §7): which suggestions are created,
 * each proposal commit's parent and exact file bytes, the version 1 and 2
 * markers, the suggestion pull request bodies, the review body and the
 * outcome sentences of `validate` and `publish`. Only the random suggestion
 * and publication ids are read back and substituted. What happens to a
 * suggestion that cannot be re-applied (issue #37: a fallback as if
 * suggestion pull requests were not allowed, or the refusal of a group) is
 * specified in test/suggestion-pr-fallback.test.mts.
 *
 * The scenario mirrors the live experiment (docs/force-push-experiment.md):
 * C0 adds a 20-line file, the reviewed commit C1 changes its lines 5 and 6,
 * and the pull request's branch then moves forward (C2), is amended (C1′),
 * or is rewritten so that what the suggestions touch has changed.
 *
 * The host models documented GitHub behavior; it is not evidence of live
 * GitHub behavior (see docs/force-push-reapply-e2e-evidence.md).
 *
 * @see https://docs.github.com/en/rest/commits/commits#compare-two-commits
 * @see https://docs.github.com/en/rest/git/trees#get-a-tree
 * @see https://docs.github.com/en/rest/git/commits#create-a-commit
 * @see https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { describe, test } from 'node:test';

import { findSuggestionMarker } from '../dist/suggestion-marker.cjs';
import type { IStoredPull } from './fixtures/composition/fake-http-companion.mts';
import {
  ADVANCED, AMENDED, AMENDED_LATER, ATTRIBUTION, BASE, DROPPED, HEAD_REF, LINE10_MESSAGE, LINE6_MESSAGE, MOVED, NEW_MESSAGE, NEW_PAGE,
  OBSOLETE_MESSAGE, OWNER, PULL, REMARK, REPO, REVIEWED, REVIEWED_LINES, REVIEW_MARKER, REWRITTEN, SHORT, SNAPSHOTS, TOKEN,
  blob, compareReads, documentWith, idsOf, jointFixDocument, makeWorld, markdown, proposalCommit, publish, publishWith, pullUrl, repositoryAt, reviewDocument, sample, status,
  validate, validateWith, writes,
} from './fixtures/rewritten-history/world.mts';
import type { IWorld, Json } from './fixtures/rewritten-history/world.mts';
import { asArray, asRecord } from './support/runtime-types.mts';

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
    `- Edited [docs/sample.md line 6 at ${SHORT}](${blob('docs/sample.md', '#L6')})`,
    `- Edited [docs/sample.md line 10 at ${SHORT}](${blob('docs/sample.md', '#L10')})`,
  ],
  items: [
    `**Source:** [docs/sample.md line 6 at ${SHORT}](${blob('docs/sample.md', '#L6')})`, '', '```', 'Line 6, reviewed.', '```', '', LINE6_MESSAGE, '', ATTRIBUTION,
    '', '---', '',
    `**Source:** [docs/sample.md line 10 at ${SHORT}](${blob('docs/sample.md', '#L10')})`, '', '```', 'Line 10.', '```', '', LINE10_MESSAGE, '', ATTRIBUTION,
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

/** §2.11: the paragraph a re-applied suggestion's body carries after its first line. */
const reappliedInBody = (head: string): string =>
  `The history of #7 was rewritten after that commit, so this change is re-applied onto commit ${head}, the head of #7 when it was proposed, where everything it changes is still exactly as reviewed.`;
/** §2.11: the paragraph a re-applied suggestion's review section carries after its link. */
const reappliedInReview = (head: string): string =>
  `The history of #7 was rewritten after the reviewed commit, so this change is re-applied onto commit ${head}, the head of #7 when it was proposed, where everything it changes is still exactly as reviewed.`;

/** Convention §7: version 1, or version 2 naming the commit it was re-applied onto. */
function marker(id: string, batch: string, reappliedOnto?: string): string {
  const original = `"original":{"owner":"${OWNER}","repo":"${REPO}","pullNumber":${String(PULL)}}`;
  return reappliedOnto === undefined
    ? `<!-- suggestion-pr {"version":1,${original},"reviewedCommit":"${REVIEWED}","id":"${id}","batch":"${batch}"} -->`
    : `<!-- suggestion-pr {"version":2,${original},"reviewedCommit":"${REVIEWED}","reappliedOnto":"${reappliedOnto}","id":"${id}","batch":"${batch}"} -->`;
}

/** §2.11: a suggestion pull request's whole body. */
function pullBody(unit: IUnit, ids: { readonly id: string; readonly batch: string }, reappliedOnto?: string): string {
  return [
    `Suggested in a review of #7 at commit ${REVIEWED}.`,
    '',
    ...(reappliedOnto === undefined ? [] : [reappliedInBody(reappliedOnto), '']),
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
    marker(ids.id, ids.batch, reappliedOnto),
  ].join('\n');
}

/** §2.11: a created suggestion's section of the review body. */
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

/** §2.11: the review body's sections, joined as every review body's sections are. */
const reviewBody = (...sections: readonly (readonly string[])[]): string => sections.map((s) => s.join('\n')).join('\n\n---\n\n');

/** Contract §2.10: the retry warning when the branch changed after the suggestions were planned. */
function changedSincePlanned(base: string, head: string): string {
  return `**The branch of #7 changed since these suggestions were planned:** they are based on commit \`${base}\`, which is no longer part of it `
    + `(its head is now \`${head}\`). The suggestion pull requests still to be created are created on that commit, as planned; nothing is re-decided.`;
}

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

/** Every suggestion is created as before, on the reviewed commit, with version 1 markers. */
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
    createdSection(REWORD, pulls[0].number), createdSection(CREATE, pulls[1].number), createdSection(DELETE, pulls[2].number), REMARK_SECTION,
  ));
  assert.ok(markdown(outcome).includes('Suggestion pull requests (drafts into `feature/retry`, labeled `suggestion-pr`):'), markdown(outcome));
  assert.doesNotMatch(markdown(outcome), /re-applied|Warnings/);
}

// ---------------------------------------------------------------------------

describe('harness controls', () => {
  test('the fixture relates the commits as the experiment did', async () => {
    const world = makeWorld(ADVANCED);
    const statusOf = async (a: string, b: string): Promise<unknown> =>
      asRecord(await (await world.host.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/compare/${a}...${b}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json())['status'];
    assert.equal(await statusOf(REVIEWED, ADVANCED), 'ahead');
    assert.equal(await statusOf(REVIEWED, AMENDED), 'diverged');
    assert.equal(await statusOf(REVIEWED, BASE), 'behind');
    assert.equal(await statusOf(REVIEWED, REVIEWED), 'identical');
  });

  test('the amended head keeps every line the suggestions touch; the rewritten ones do not', () => {
    const at = (commit: string, line: number): string | undefined => SNAPSHOTS[commit]?.['docs/sample.md']?.[line - 1];
    for (const line of [6, 10]) assert.equal(at(AMENDED, line), at(REVIEWED, line));
    assert.notEqual(at(REWRITTEN, 6), at(REVIEWED, 6));
    assert.equal(at(REWRITTEN, 10), at(REVIEWED, 10));
    assert.notEqual(at(MOVED, 6), at(REVIEWED, 6));
  });
});

describe('the reviewed commit is still the head', () => {
  test('suggestions are proposed on it, and no comparison is read', async () => {
    const world = makeWorld(REVIEWED);
    assertProposedOnReviewed(world, await publish(world));
    assert.deepEqual(compareReads(world), [`${BASE}...${REVIEWED}`], 'only the merge-base comparison of the review context');
  });
});

describe('the branch moved forward: the reviewed commit is an ancestor of the head (§2.5)', () => {
  test('publication proceeds on the reviewed commit, exactly as for the head, with version 1 markers', async () => {
    const world = makeWorld(ADVANCED);
    assertProposedOnReviewed(world, await publish(world));
    assert.ok(compareReads(world).includes(`${REVIEWED}...${ADVANCED}`), 'the ancestry was read');
  });

  test('validate says what would be created, with no mention of re-application, and writes nothing', async () => {
    const world = makeWorld(ADVANCED);
    const assessed = await validate(world);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.ok(markdown(assessed).includes('Publication would also create 3 draft suggestion pull requests into `feature/retry`, labeled `suggestion-pr`.\n'), markdown(assessed));
    assert.doesNotMatch(markdown(assessed), /re-applied|Warnings/);
    assert.deepEqual(writes(world), []);
  });

  test('regression: an advanced head is no longer refused as historical', async () => {
    const world = makeWorld(ADVANCED);
    const assessed = await validate(world);
    assert.doesNotMatch(markdown(assessed), /suggestion-pr-historical-unsupported|no longer the pull request's head/);
  });
});

describe('rewritten history, and everything the suggestions touch is unchanged: re-applied onto the head (§2.5.1)', () => {
  test('each suggestion is re-applied onto the amended head, with version 2 markers and the re-application stated', async () => {
    const world = makeWorld(AMENDED);
    const outcome = await publish(world);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const pulls = threePulls(world);
    for (const [pull, unit] of [[pulls[0], REWORD], [pulls[1], CREATE], [pulls[2], DELETE]] as const) {
      assert.equal(pull.title, unit.title);
      assert.equal(pull.base, HEAD_REF);
      assert.equal(pull.draft, true);
      assert.deepEqual(pull.labels, ['suggestion-pr']);
      assert.equal(pull.body, pullBody(unit, idsOf(pull), AMENDED));
      assert.deepEqual(proposalCommit(world, pull.head).parents, [AMENDED], 'never the discarded reviewed commit');
    }
    // The edit is applied to the head's file: the amendment's line 15 is kept.
    assert.deepEqual(world.host.fileOnBranch(pulls[0].head, 'docs/sample.md'), suggestedSample(SNAPSHOTS[AMENDED]?.['docs/sample.md'] ?? []));
    assert.deepEqual(world.host.fileOnBranch(pulls[1].head, 'docs/new.md'), Buffer.from(NEW_PAGE));
    assert.equal(world.host.fileOnBranch(pulls[2].head, 'obsolete.txt'), null);
    assert.equal(proposalCommit(world, pulls[0].head).message,
      `Suggestion for #7: reword (2 changes)\n\nSuggested in a review of ${OWNER}/${REPO} pull request 7 at commit ${REVIEWED}, and re-applied onto commit ${AMENDED} after the pull request's history was rewritten.`);

    const [review] = world.host.reviews();
    assert.ok(review);
    assert.equal(review.request.commit_id, REVIEWED, 'the review stays pinned to the reviewed commit');
    assert.equal(review.request.body.replace(REVIEW_MARKER, ''), reviewBody(
      createdSection(REWORD, pulls[0].number, AMENDED),
      createdSection(CREATE, pulls[1].number, AMENDED),
      createdSection(DELETE, pulls[2].number, AMENDED),
      REMARK_SECTION,
    ));
    assert.ok(markdown(outcome).includes([
      `Suggestion pull requests (drafts into \`feature/retry\`, labeled \`suggestion-pr\`, re-applied onto commit \`${AMENDED}\`):`,
      '',
      ...pulls.map((p) => `- [#${String(p.number)}](${pullUrl(p.number)}) from \`${p.head}\``),
    ].join('\n')), markdown(outcome));
  });

  test('validate reports the same: three re-applied suggestions, and nothing written', async () => {
    const world = makeWorld(AMENDED);
    const assessed = await validate(world);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.ok(markdown(assessed).includes(
      `Publication would also create 3 draft suggestion pull requests into \`feature/retry\`, labeled \`suggestion-pr\`. The history of #7 was rewritten after the reviewed commit, so they are re-applied onto commit \`${AMENDED}\`, where everything they change is still exactly as reviewed.`,
    ), markdown(assessed));
    assert.doesNotMatch(markdown(assessed), /Warnings/);
    assert.deepEqual(writes(world), []);
  });

  test('the version 2 marker is recognized by cleanup\'s reader (convention §7)', async () => {
    const world = makeWorld(AMENDED);
    await publish(world);
    for (const pull of threePulls(world)) {
      const reading = findSuggestionMarker(pull.body);
      assert.equal(reading.kind, 'marker');
      assert.equal(reading.fields.reappliedOnto, AMENDED);
      assert.equal(reading.fields.reviewedCommit, REVIEWED);
    }
  });
});

describe('recovery and retry after a re-application (§2.9, §2.10)', () => {
  test('a lost pull request response is rediscovered by its version 2 marker, never resent', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    const first = await publish(world);
    assert.equal(status(first), 'uncertain', markdown(first));
    world.host.setConfig({ companion: {} });
    const second = await publish(world);
    assert.equal(status(second), 'published', markdown(second));
    const pulls = threePulls(world);
    for (const pull of pulls) assert.equal(pull.body, pullBody([REWORD, CREATE, DELETE][pulls.indexOf(pull)] ?? REWORD, idsOf(pull), AMENDED));
    assert.equal(writes(world).filter((w) => w === '/pulls').length, 3, 'one create per suggestion');
    assert.equal(world.host.reviews().length, 1);
  });

  test('a retry never re-decides: the head rewritten again in between changes nothing already planned, and the outcome says so', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    const compares = compareReads(world).length;
    // The author force-pushes again, dropping everything the suggestions touch.
    world.host.replaceRepository(repositoryAt(DROPPED));
    world.host.setConfig({ companion: {} });
    const retried = await publish(world);
    assert.equal(status(retried), 'published', markdown(retried));
    assert.deepEqual(compareReads(world).slice(compares), [`${AMENDED}...${DROPPED}`], 'only the planned base against the head, to warn; nothing is re-decided');
    for (const pull of threePulls(world)) assert.deepEqual(proposalCommit(world, pull.head).parents, [AMENDED], 'still re-applied onto the head it was planned on');
    assert.ok(markdown(retried).includes(`re-applied onto commit \`${AMENDED}\`):`), markdown(retried));
    assert.ok(markdown(retried).includes(changedSincePlanned(AMENDED, DROPPED)), markdown(retried));
  });

  test('a retry after the branch only moved forward from the planned base gives no warning', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.replaceRepository(repositoryAt(AMENDED_LATER));
    world.host.setConfig({ companion: {} });
    const retried = await publish(world);
    assert.equal(status(retried), 'published', markdown(retried));
    assert.doesNotMatch(markdown(retried), /changed since these suggestions were planned/);
  });

  test('a plan on the reviewed commit warns too when the branch was rewritten after planning (no re-decision)', async () => {
    const world = makeWorld(ADVANCED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.replaceRepository(repositoryAt(AMENDED));
    world.host.setConfig({ companion: {} });
    const retried = await publish(world);
    assert.equal(status(retried), 'published', markdown(retried));
    for (const pull of threePulls(world)) assert.deepEqual(proposalCommit(world, pull.head).parents, [REVIEWED]);
    assert.ok(markdown(retried).includes(changedSincePlanned(REVIEWED, AMENDED)), markdown(retried));
  });

  test('an uncertain retry carries the warning as well', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.replaceRepository(repositoryAt(DROPPED));
    world.host.hide({ pulls: 1 });
    const retried = await publish(world);
    assert.equal(status(retried), 'uncertain', markdown(retried));
    assert.ok(markdown(retried).includes(changedSincePlanned(AMENDED, DROPPED)), markdown(retried));
  });

  test('a retry whose branch check cannot be read says so, and still publishes as planned', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.replaceRepository(repositoryAt(DROPPED));
    world.host.setConfig({ companion: {}, failAncestryCompare: 404 });
    const retried = await publish(world);
    assert.equal(status(retried), 'published', markdown(retried));
    const text = markdown(retried);
    const start = `**Whether the branch of #7 changed since these suggestions were planned is not known:** they are based on commit \`${AMENDED}\`, and the branch could not be read (`;
    const at = text.indexOf(start);
    assert.ok(at >= 0, text);
    const paragraph = text.slice(at).split('\n')[0] ?? '';
    assert.match(paragraph, /404/);
    assert.ok(paragraph.endsWith('). Nothing is re-decided.'), paragraph);
    assert.ok(text.indexOf(paragraph) < text.indexOf('Suggestion pull requests ('), 'before the list');
    assert.doesNotMatch(text, /changed since these suggestions were planned:\*\* they are based/);
    for (const pull of threePulls(world)) assert.deepEqual(proposalCommit(world, pull.head).parents, [AMENDED]);
  });

  test('a retry refused by GitHub carries the warning with its refusal', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.replaceRepository(repositoryAt(DROPPED));
    world.host.setConfig({ companion: { refuse: { ref: 422 } } });
    const retried = await publish(world);
    assert.equal(status(retried), 'rejected', markdown(retried));
    const text = markdown(retried);
    assert.ok(text.includes(changedSincePlanned(AMENDED, DROPPED)), text);
    assert.ok(text.indexOf('It is never resent') < text.indexOf(changedSincePlanned(AMENDED, DROPPED)), 'after the refusal');
    assert.deepEqual(world.host.reviews(), [], 'the review is not published');
  });

  test('a completed publication is reported from its receipts, with no request that writes and no ancestry read', async () => {
    const world = makeWorld(AMENDED);
    assert.equal(status(await publish(world)), 'published');
    const before = writes(world).length;
    const compares = compareReads(world).length;
    world.host.replaceRepository(repositoryAt(DROPPED));
    const again = await publish(world);
    assert.equal(status(again), 'published', markdown(again));
    assert.equal(writes(world).length, before);
    assert.equal(compareReads(world).length, compares, 'nothing is left to create, so the branch is not checked');
    assert.ok(markdown(again).includes(`re-applied onto commit \`${AMENDED}\`):`), markdown(again));
    assert.doesNotMatch(markdown(again), /changed since these suggestions were planned/);
  });

  test('when nothing is re-applied, a lost review response is rediscovered and never resent, as for any review', async () => {
    // Only whole-file proposals, neither of which can be re-applied onto
    // DROPPED: both fall back to the review body (issue #37), so no
    // suggestion pull request is created.
    const world = makeWorld(DROPPED, { create: 'lose-response' });
    const first = await publishWith(world, documentWith(['create', 'delete', 'remark']));
    assert.equal(status(first), 'published', markdown(first));
    assert.ok(markdown(first).includes('was confirmed on GitHub for this publication; nothing was resent.'), markdown(first));
    world.host.setConfig({ create: 'ok' });
    const before = writes(world).length;
    const retried = await publishWith(world, documentWith(['create', 'delete', 'remark']));
    assert.equal(status(retried), 'published', markdown(retried));
    assert.equal(writes(world).length, before, 'the retry is answered from the receipt');
    assert.equal(world.host.reviews().length, 1);
    assert.deepEqual(world.host.pulls(), []);
  });
});

describe('the ancestry read is made only when a suggestion pull request could be created (§2.5, §2.8)', () => {
  const remarkOnly = (): Json => {
    const doc = reviewDocument();
    const [run] = asArray(doc['runs']);
    const results = asArray(asRecord(run)['results']);
    return { ...doc, runs: [{ ...asRecord(run), results: results.slice(4) }] };
  };

  test('a review that creates no suggestion pull request makes no ancestry read beyond the association of its reviewed commit', async () => {
    // Since docs/specification.md R17, every review of a commit that is not
    // the head compares it with the head once, to associate it with the pull
    // request; that comparison fails like any read (the next test). Ancestry
    // for suggestion pull requests is still read only when one could be made.
    const world = makeWorld(AMENDED);
    const assessed = await validateWith(world, remarkOnly());
    assert.equal(status(assessed), 'ready', markdown(assessed));
    const outcome = await publishWith(world, remarkOnly());
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(compareReads(world).filter((c) => !c.startsWith(`${BASE}...`)), [`${REVIEWED}...${AMENDED}`, `${REVIEWED}...${AMENDED}`],
      'one association comparison per operation, and no ancestry read');
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

describe('a fix with several changes (issue #29) after a rewritten history (§2.3, §2.5.1)', () => {
  const TITLE = 'Suggestion for #7: edit docs/sample.md';

  test('re-applied onto the amended head as one suggestion pull request, keeping the amendment', async () => {
    const world = makeWorld(AMENDED);
    const outcome = await publishWith(world, jointFixDocument());
    assert.equal(status(outcome), 'published', markdown(outcome));
    const [pull, ...others] = world.host.pulls();
    assert.ok(pull && others.length === 0, 'exactly one suggestion pull request');
    assert.equal(pull.title, TITLE);
    assert.ok(pull.body.includes(REWORD.changes.join('\n')), pull.body);
    assert.deepEqual(proposalCommit(world, pull.head).parents, [AMENDED], 'never the discarded reviewed commit');
    assert.equal(proposalCommit(world, pull.head).message,
      `${TITLE}\n\nSuggested in a review of ${OWNER}/${REPO} pull request 7 at commit ${REVIEWED}, and re-applied onto commit ${AMENDED} after the pull request's history was rewritten.`);
    assert.deepEqual(world.host.fileOnBranch(pull.head, 'docs/sample.md'), suggestedSample(SNAPSHOTS[AMENDED]?.['docs/sample.md'] ?? []));
    const reading = findSuggestionMarker(pull.body);
    assert.equal(reading.kind, 'marker');
    assert.equal(reading.fields.reappliedOnto, AMENDED);
  });
});
