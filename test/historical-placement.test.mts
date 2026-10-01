/**
 * Historical placement, native suggestions at the reviewed commit, and the
 * reviewed commit's association with its pull request, through the real
 * public library and CLI with the real GitHub client against the fake HTTP
 * host (test/fixtures/historical-placement), which resolves each comment's
 * line on the diff of its `commit_id` as GitHub did (GH-16) and refuses a
 * line outside it with HTTP 422.
 *
 * Every expectation is derived from the contract and the recorded host
 * behavior, never from the program's output:
 * - docs/specification.md R13.1: the review and its comments are at the
 *   reviewed commit R, anchored on the reviewed diff (the pull request's diff
 *   base to R); a line outside it keeps R7's fallback (general feedback with
 *   an exact link); native suggestions need only a valid anchor there.
 * - docs/specification.md R17: R must be the head, within it, or within a head
 *   a force-push replaced; otherwise the review is blocked before anything is
 *   prepared or written, and an undecided lookup is a note.
 * - GH-16 (docs/evidence/realignment/e1-e3-readme.md): the cases mirror its
 *   #44 (ancestor), #41 (discarded by an amend) and #42 (rebased onto an
 *   advanced base) fixtures: lines 5 and 6 inline, line 2 only in the reviewed
 *   diff, line 15 only in the head's diff, LEFT on a deleted line.
 * - GH-19 (docs/evidence/realignment/e2-readme.md): GitHub, not the tool,
 *   refuses applying a suggestion on a line the head changed, so the tool
 *   offers it there too and never consults `outdated`.
 *
 * @see docs/specification.md (R7, R13.1, R17)
 * @see docs/evidence/realignment/e1-e3-readme.md
 * @see docs/evidence/realignment/e2-readme.md
 * @see docs/evidence/realignment/e0-readme.md
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { createGitHubClient } from '../dist/github.cjs';
import type { IStoredHttpReview } from './fixtures/composition/fake-http-github.mts';
import {
  ADVANCED_BASE,
  ANCESTOR_HEAD,
  ANCESTOR_R,
  BASE,
  DISCARDED_HEAD,
  DISCARDED_R,
  DISCARDED_R0,
  LATER_BASE,
  MOVED_HEAD,
  MOVED_R,
  TIP_NOTES,
  NOTES,
  OWNER,
  PULL,
  REBASED_R,
  REPO,
  SAMPLE,
  SNAPSHOTS,
  TIP_INSERTED,
  TIP_PICKED,
  TOKEN,
  UNRELATED,
  document,
  finding,
  lineFix,
  makeWorld,
  markdown,
  publish,
  reads,
  status,
  validate,
  writes,
} from './fixtures/historical-placement/world.mts';
import type { IWorld, Json } from './fixtures/historical-placement/world.mts';
import { asArray, asRecord, asString, parseJson } from './support/runtime-types.mts';

const CLI = path.join(import.meta.dirname, 'fixtures', 'composition', 'cli-with-fake-http.mts');
const LABEL = `${OWNER}/${REPO}#${String(PULL)}`;

/** The one review the host stored. */
function theReview(world: IWorld): IStoredHttpReview {
  const reviews = world.host.reviews();
  assert.equal(reviews.length, 1, 'exactly one review was created');
  const [review] = reviews;
  assert.ok(review);
  return review;
}

/** Each inline comment as [path, side, line]. */
function anchors(review: IStoredHttpReview): [string, string, number][] {
  return review.request.comments.map((c) => [c.path, c.side, c.line]);
}

/** An exact link to whole line `n` of a file at a commit (src/github-urls.cts). */
function permalink(commit: string, filePath: string, n: number): string {
  return `https://github.com/${OWNER}/${REPO}/blob/${commit}/${filePath}#L${String(n)}`;
}

/** The outcome's diagnostics as [severity, code]. */
function codes(outcome: Json): [string, string][] {
  return asArray(outcome['diagnostics']).map((d) => [asString(asRecord(d)['severity']), asString(asRecord(d)['code'])]);
}

/** The reads made before the create request. */
function readsBeforeCreate(world: IWorld): readonly string[] {
  const log = world.host.log();
  const create = log.findIndex((r) => r.method === 'POST' && r.path.endsWith('/reviews'));
  const before = create === -1 ? log : log.slice(0, create);
  return before.filter((r) => r.method === 'GET' || r.path === '/graphql').map((r) => (r.path === '/graphql' ? 'graphql' : r.path.replace(`/repos/${OWNER}/${REPO}`, '')));
}

describe('the fake host resolves lines as GitHub did (GH-16), so an accepted review is evidence of a valid anchor', () => {
  const client = (world: IWorld) => createGitHubClient({ token: TOKEN, fetch: world.host.fetch });
  const create = (world: IWorld, commitId: string, comment: { readonly line: number; readonly side: 'LEFT' | 'RIGHT' }) =>
    client(world).createReview({ owner: OWNER, repo: REPO, pullNumber: PULL, commitId, body: 'Fixture.', event: 'COMMENT', comments: [{ path: SAMPLE, body: 'x', ...comment }] });

  test('a line only the head\'s diff contains is refused at the reviewed commit with 422, and nothing is created (41-d-head-only-right15)', async () => {
    const world = makeWorld('discarded');
    await assert.rejects(create(world, DISCARDED_R, { line: 15, side: 'RIGHT' }), { code: 'http-status', status: 422, hostRejected: true });
    assert.deepEqual(world.host.reviews(), []);
  });

  test('a line outside every diff is refused (41-e-outside-right11); a line only the reviewed diff contains is accepted (41-d-reviewed-only-right2)', async () => {
    const world = makeWorld('discarded');
    await assert.rejects(create(world, DISCARDED_R, { line: 11, side: 'RIGHT' }), { status: 422 });
    await create(world, DISCARDED_R, { line: 2, side: 'RIGHT' });
    assert.equal(world.host.reviews().length, 1);
  });
});

describe('findings are placed on the reviewed diff, at the reviewed commit (R13.1; GH-16)', () => {
  test('an ancestor of the head: its changed lines are inline at it, and a line only the head changed is in the body', async () => {
    const world = makeWorld('ancestor');
    const outcome = await publish(world, ANCESTOR_R, document([
      finding('Line 6 reads oddly.', SAMPLE, 6),
      finding('Line 5 too.', SAMPLE, 5),
      finding('Line 15 was changed later.', SAMPLE, 15),
    ]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const review = theReview(world);
    assert.equal(review.request.commit_id, ANCESTOR_R, 'the review is created at the reviewed commit, never the head');
    assert.deepEqual(anchors(review), [[SAMPLE, 'RIGHT', 6], [SAMPLE, 'RIGHT', 5]]);
    // Line 15 is outside the reviewed diff (only the later push changed it): R7's fallback, linked to R.
    assert.ok(review.body.includes(permalink(ANCESTOR_R, SAMPLE, 15)), review.body);
    assert.ok(review.body.includes('Line 15 was changed later.'), review.body);
    assert.deepEqual(codes(outcome), [], 'a line outside the diff is ordinary general feedback, with no warning');
    // The reviewed diff came from a comparison, not the pull request's file list.
    assert.ok(reads(world).includes(`/compare/${BASE}...${ANCESTOR_R}`));
    assert.ok(!reads(world).includes(`/pulls/${String(PULL)}/files`));
  });

  test('a discarded commit: a line only its diff contains is inline, a line only the head changed is in the body, and a line the head dropped stays inline', async () => {
    const world = makeWorld('discarded');
    const outcome = await publish(world, DISCARDED_R, document([
      finding('Line 2 context.', SAMPLE, 2),
      finding('Line 15 was amended later.', SAMPLE, 15),
      finding('Line 5 was dropped by the amend.', SAMPLE, 5),
    ]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const review = theReview(world);
    assert.equal(review.request.commit_id, DISCARDED_R);
    // GH-16 41-d-reviewed-only-right2 and 41-b-right5 were accepted; 41-d-head-only-right15 was refused.
    assert.deepEqual(anchors(review), [[SAMPLE, 'RIGHT', 2], [SAMPLE, 'RIGHT', 5]]);
    assert.ok(review.body.includes(permalink(DISCARDED_R, SAMPLE, 15)), review.body);
  });

  test('a deleted line of the diff base is anchored LEFT, at the reviewed commit', async () => {
    const world = makeWorld('discarded');
    // Base-side source: the run's revision is the diff base (GH-16 41-c-left5).
    const outcome = await publish(world, DISCARDED_R, document([finding('The original line 5.', SAMPLE, 5)], BASE));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const review = theReview(world);
    assert.equal(review.request.commit_id, DISCARDED_R);
    assert.deepEqual(anchors(review), [[SAMPLE, 'LEFT', 5]]);
  });

  test('after a rebase onto an advanced base, a file the base also changed keeps the fallback, with a warning; another file is inline', async () => {
    const world = makeWorld('rebased');
    const outcome = await publish(world, REBASED_R, document([
      finding('Line 5 of the sample.', SAMPLE, 5),
      finding('The first note.', NOTES, 2),
    ]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const review = theReview(world);
    assert.equal(review.request.commit_id, REBASED_R);
    assert.deepEqual(anchors(review), [[NOTES, 'RIGHT', 2]]);
    assert.ok(review.body.includes(permalink(REBASED_R, SAMPLE, 5)), review.body);
    assert.deepEqual(codes(outcome), [['warning', 'inline-placement-unavailable']]);
    const [warning] = asArray(outcome['diagnostics']).map((d) => asRecord(d));
    assert.deepEqual(asRecord(warning?.['location']), { pointer: '/runs/0/results/0' });
  });

  test('at the head nothing changes: the pull request\'s own files are read, and no association read is needed', async () => {
    const world = makeWorld('ancestor');
    const outcome = await publish(world, ANCESTOR_HEAD, document([finding('Line 15.', SAMPLE, 15)]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(anchors(theReview(world)), [[SAMPLE, 'RIGHT', 15]]);
    const before = readsBeforeCreate(world);
    assert.ok(before.includes(`/pulls/${String(PULL)}/files`));
    assert.equal(before.filter((r) => r.startsWith(`/compare/${ANCESTOR_HEAD}...`)).length, 0);
    assert.equal(before.filter((r) => r === 'graphql').length, 0);
  });
});

describe('a base branch that moved on without the pull request: base.sha is not the diff base (R13.1)', () => {
  // GitHub resolves a line at R against base.sha..R (GH-16). Where the base's
  // tip changed a file since the diff base, that diff can differ from the one
  // the tool can read; findings on such a file keep R7's fallback, with a
  // warning, and every other file is placed inline as usual.

  test('the harness: GitHub would refuse RIGHT 5 at R, because the tip cherry-picked those lines', async () => {
    const world = makeWorld('moved-picked');
    const create = createGitHubClient({ token: TOKEN, fetch: world.host.fetch }).createReview({
      owner: OWNER, repo: REPO, pullNumber: PULL, commitId: MOVED_R, body: 'Fixture.', event: 'COMMENT', comments: [{ path: SAMPLE, body: 'x', line: 5, side: 'RIGHT' }],
    });
    await assert.rejects(create, { status: 422 });
  });

  test('regression: lines the tip already has are not placed inline, so the review is not refused (RIGHT)', async () => {
    const world = makeWorld('moved-picked');
    const outcome = await publish(world, MOVED_R, document([finding('Line 5.', SAMPLE, 5), finding('The first note.', NOTES, 2)]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const review = theReview(world);
    assert.equal(review.request.commit_id, MOVED_R);
    assert.deepEqual(anchors(review), [[NOTES, 'RIGHT', 2]], 'the notes, which the tip left alone, stay inline');
    assert.ok(review.body.includes(permalink(MOVED_R, SAMPLE, 5)), review.body);
    assert.deepEqual(codes(outcome), [['warning', 'inline-placement-unavailable']]);
  });

  test('regression: a deleted line is not anchored LEFT on a tip whose line numbers moved, so it is never misplaced (LEFT)', async () => {
    // The fixture's fact: the tip's line 5 is another line than the diff base's.
    assert.notEqual(SNAPSHOTS[TIP_INSERTED]?.[SAMPLE]?.[4], SNAPSHOTS[BASE]?.[SAMPLE]?.[4]);
    const world = makeWorld('moved-inserted');
    const outcome = await publish(world, MOVED_R, document([finding('The original line 5.', SAMPLE, 5), finding('The original first note.', NOTES, 2)], BASE));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const review = theReview(world);
    assert.deepEqual(anchors(review), [[NOTES, 'LEFT', 2]]);
    assert.ok(review.body.includes(permalink(BASE, SAMPLE, 5)), review.body);
    assert.deepEqual(codes(outcome), [['warning', 'inline-placement-unavailable']]);
  });

  test('one more comparison, of the diff base with the tip, finds what the tip changed', async () => {
    const world = makeWorld('moved-picked');
    await validate(world, MOVED_R, document([finding('Line 5.', SAMPLE, 5)]));
    assert.ok(reads(world).includes(`/compare/${BASE}...${TIP_PICKED}`), reads(world).join('\n'));
  });

  test('regression: a base-side finding on a file only the moved tip changed goes to the body; the run is not rejected', async () => {
    // B = BASE, T = TIP_NOTES (only notes line 3), R = ANCESTOR_R (only the sample). The finding reads the notes at B.
    const world = makeWorld('tip-notes');
    const outcome = await publish(world, ANCESTOR_R, document([finding('The first note, as the base had it.', NOTES, 2)], BASE));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const review = theReview(world);
    assert.equal(review.request.commit_id, ANCESTOR_R);
    assert.deepEqual(anchors(review), []);
    assert.ok(review.body.includes(permalink(BASE, NOTES, 2)), review.body);
    assert.ok(review.body.includes('First note.'), 'the text quoted is the diff base\'s');
    assert.deepEqual(codes(outcome), [['warning', 'inline-placement-unavailable']]);
  });

  test('regression: after a rebase, a base-side finding on a file only the base changed goes to the body; the run is not rejected', async () => {
    // B = T = TIP_NOTES, onto which the head was rebased; R = ANCESTOR_R, replaced by the force-push. Only the base changed the notes.
    const world = makeWorld('rebased-notes');
    const outcome = await publish(world, ANCESTOR_R, document([finding('The second note, as the base has it.', NOTES, 3)], TIP_NOTES));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const review = theReview(world);
    assert.deepEqual(anchors(review), []);
    assert.ok(review.body.includes(permalink(TIP_NOTES, NOTES, 3)), review.body);
    assert.ok(review.body.includes('Second note, on the base.'), 'the text quoted is the diff base\'s');
    assert.deepEqual(codes(outcome), [['warning', 'inline-placement-unavailable']]);
  });

  test('at the head, the pull request\'s own diff is used as before', async () => {
    const world = makeWorld('moved-picked');
    const outcome = await publish(world, MOVED_HEAD, document([finding('Line 15.', SAMPLE, 15)]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(anchors(theReview(world)), [[SAMPLE, 'RIGHT', 15]]);
  });
});

describe('native suggestions at a reviewed commit that is not the head (R13.1; GH-19)', () => {
  const suggestion = (n: number, text: string): Json => finding(`Reword line ${String(n)}.`, SAMPLE, n, { fixes: [lineFix(SAMPLE, n, text)] });

  test('a fix on a line the head left unchanged is a native suggestion at the reviewed commit', async () => {
    const world = makeWorld('ancestor');
    const sarif = document([suggestion(6, 'Line 06: suggested.')]);
    const assessed = await validate(world, ANCESTOR_R, sarif);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    const outcome = await publish(world, ANCESTOR_R, sarif);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const review = theReview(world);
    assert.equal(review.request.commit_id, ANCESTOR_R);
    assert.deepEqual(anchors(review), [[SAMPLE, 'RIGHT', 6]]);
    assert.ok(review.request.comments[0]?.body.endsWith('\n\n```suggestion\nLine 06: suggested.\n```'), review.request.comments[0]?.body);
  });

  test('a fix on a line the head changed is still offered: GitHub, not the tool, refuses applying it there', async () => {
    // The amended head dropped line 5's change (GH-19: such a suggestion is shown outdated and cannot be applied).
    const world = makeWorld('discarded');
    const outcome = await publish(world, DISCARDED_R, document([suggestion(5, 'Line 05: suggested.')]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const review = theReview(world);
    assert.equal(review.request.commit_id, DISCARDED_R);
    assert.deepEqual(anchors(review), [[SAMPLE, 'RIGHT', 5]]);
    assert.ok(review.request.comments[0]?.body.includes('```suggestion\nLine 05: suggested.\n```'));
    assert.deepEqual(codes(outcome), [], 'no warning: whether GitHub lets it be applied is GitHub\'s');
  });

  test('applicability is never predicted from GitHub\'s comment state: nothing about comments is read before the create', async () => {
    const world = makeWorld('discarded');
    await publish(world, DISCARDED_R, document([suggestion(5, 'Line 05: suggested.')]));
    const before = readsBeforeCreate(world);
    assert.deepEqual(before.filter((r) => r.includes('/comments') || r.includes('/reviews')), []);
    assert.equal(before.filter((r) => r === 'graphql').length, 1, 'only the force-push events');
  });

  test('a fix on a line outside the reviewed diff cannot be a native suggestion, and the review is blocked', async () => {
    const world = makeWorld('discarded');
    const outcome = await publish(world, DISCARDED_R, document([suggestion(15, 'Line 15: suggested.')]));
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    // Delivery policy §8.9: the lines' placement is the obstacle of `native`,
    // the default `edits` list's only mechanism, so the edit is undeliverable.
    assert.deepEqual(codes(outcome), [['error', 'delivery-unavailable']]);
    assert.match(markdown(outcome), /- `native`: Lines 15-15 of \S+ cannot carry a native suggestion \(/);
    assert.deepEqual(writes(world), []);
  });

  test('the retired head-equality refusal is gone from every outcome', async () => {
    const world = makeWorld('ancestor');
    const outcome = await validate(world, ANCESTOR_R, document([suggestion(6, 'Line 06: suggested.')]));
    assert.doesNotMatch(JSON.stringify(outcome), /suggestion-reviewed-commit-not-head/);
  });
});

describe('the reviewed commit must belong to the pull request (R17)', () => {
  const remark = (): Json => document([finding('Line 5.', SAMPLE, 5)]);
  const associationReads = (world: IWorld): readonly string[] =>
    readsBeforeCreate(world).filter((r) => r === 'graphql' || (r.startsWith('/compare/') && !r.startsWith(`/compare/${BASE}...`) && !r.startsWith(`/compare/${ADVANCED_BASE}...`)));

  test('an ancestor of the head: one comparison, and no force-push history', async () => {
    const world = makeWorld('ancestor');
    assert.equal(status(await publish(world, ANCESTOR_R, remark())), 'published');
    assert.deepEqual(associationReads(world), [`/compare/${ANCESTOR_R}...${ANCESTOR_HEAD}`]);
  });

  test('a head a force-push replaced: the comparison with the head, then the force-push events, which name it', async () => {
    const world = makeWorld('discarded');
    const outcome = await publish(world, DISCARDED_R, remark());
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(codes(outcome), []);
    assert.deepEqual(associationReads(world), [`/compare/${DISCARDED_R}...${DISCARDED_HEAD}`, 'graphql']);
  });

  test('an ancestor of a replaced head: compared with that head, which contains it', async () => {
    const world = makeWorld('discarded');
    const outcome = await publish(world, DISCARDED_R0, remark());
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.equal(theReview(world).request.commit_id, DISCARDED_R0);
    assert.deepEqual(associationReads(world), [`/compare/${DISCARDED_R0}...${DISCARDED_HEAD}`, 'graphql', `/compare/${DISCARDED_R0}...${DISCARDED_R}`]);
  });

  /** The blocking problem for a commit outside the pull request whose head is `head`. */
  const outsideMessage = (commit: string, head: string): string =>
    `Commit ${commit} is not part of ${LABEL}: it is not the pull request's head ${head} or an ancestor of it, `
    + "and no force-push of the pull request's branch replaced a head that contains it. "
    + 'GitHub would accept a review at that commit, so nothing was prepared or written.';

  test('a commit of another branch is blocked before anything is prepared or written, by publish and validate alike', async () => {
    const world = makeWorld('discarded');
    const published = await publish(world, UNRELATED, remark());
    assert.equal(status(published), 'blocked', markdown(published));
    const [problem, ...rest] = asArray(published['diagnostics']).map((d) => asRecord(d));
    assert.equal(rest.length, 0, 'the association is reported alone');
    assert.deepEqual(problem, {
      severity: 'error',
      code: 'reviewed-commit-not-in-pull-request',
      title: 'The reviewed commit does not belong to the pull request',
      message: outsideMessage(UNRELATED, DISCARDED_HEAD),
      subject: LABEL,
      remedies: ['Check the reviewed commit: review a commit of this pull request.', 'Check the pull request number.'],
    });
    assert.deepEqual(writes(world), [], 'nothing was written to GitHub');
    assert.equal(fs.existsSync(world.statePath), false, 'no publication state');
    assert.equal(reads(world).filter((r) => r.includes('/git/')).length, 0, 'no source was read: nothing was prepared');

    const assessed = await validate(world, UNRELATED, remark());
    assert.equal(status(assessed), 'blocked');
    assert.equal(markdown(assessed), markdown(published), 'the same explanation');
  });

  test('a commit on the base branch that no head of the pull request contained is not associated', async () => {
    const world = makeWorld('rebased');
    const outcome = await publish(world, LATER_BASE, document([finding('Line 20.', SAMPLE, 20)]));
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    assert.deepEqual(codes(outcome), [['error', 'reviewed-commit-not-in-pull-request']]);
    assert.deepEqual(writes(world), []);
  });

  test('the base commit itself, which the head contains, is associated', async () => {
    const world = makeWorld('rebased');
    const outcome = await validate(world, ADVANCED_BASE, document([]));
    assert.equal(status(outcome), 'ready', markdown(outcome));
  });

  test('an event that names no earlier head leaves association unknown: a note, and the review is published and reported with it again on retry', async () => {
    const world = makeWorld('discarded', {}, [null]);
    const assessed = await validate(world, UNRELATED, remark());
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.deepEqual(codes(assessed), [['note', 'reviewed-commit-association-unknown']]);

    const outcome = await publish(world, UNRELATED, remark());
    assert.equal(status(outcome), 'published', markdown(outcome));
    const [note] = asArray(outcome['diagnostics']).map((d) => asRecord(d));
    assert.deepEqual(note, {
      severity: 'note',
      code: 'reviewed-commit-association-unknown',
      title: 'Whether the reviewed commit belongs to the pull request is not known',
      message: `Whether commit ${UNRELATED} belongs to ${LABEL} is not known: it is not the pull request's head ${DISCARDED_HEAD} or an ancestor of it, `
        + 'and a force-push event names no earlier head. '
        + 'A lookup that cannot see every replaced head does not show that the commit is outside the pull request, so the review is prepared at that commit.',
      subject: LABEL,
    });
    assert.equal(theReview(world).request.commit_id, UNRELATED);

    const before = world.host.log().length;
    const retried = await publish(world, UNRELATED, remark());
    assert.equal(status(retried), 'published');
    assert.deepEqual(codes(retried), [['note', 'reviewed-commit-association-unknown']], 'recorded with the publication');
    assert.equal(world.host.log().slice(before).filter((r) => r.path.includes('/compare/') || r.path === '/graphql').length, 0, 'a retry never checks again');
  });

  test('a failed force-push read is operational: validate is incomplete, publish rejects, and nothing is written', async () => {
    const world = makeWorld('discarded', { failForcePushes: true });
    const assessed = await validate(world, DISCARDED_R, remark());
    assert.equal(status(assessed), 'incomplete', markdown(assessed));
    await assert.rejects(publish(world, DISCARDED_R, remark()), /force-push query/);
    assert.deepEqual(writes(world), []);
    assert.equal(fs.existsSync(world.statePath), false);
  });
});

describe('the CLI (R13.1, R17)', () => {
  /** Runs the in-repository CLI against `world`'s host. */
  function cli(world: IWorld, args: readonly string[]): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: world.root, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env['PATH'], GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: world.host.dir },
    });
    for (const text of [result.stdout, result.stderr]) assert.equal(text.includes(TOKEN), false, 'the token never appears');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }
  function flags(world: IWorld, commit: string, sarif: Json): string[] {
    const file = path.join(world.root, 'review.sarif');
    fs.writeFileSync(file, JSON.stringify(sarif));
    return ['--sarif', file, '--repo', `${OWNER}/${REPO}`, '--pull', String(PULL), '--commit', commit];
  }

  test('publish at a discarded commit places the finding and the suggestion inline at that commit, exit 0', () => {
    const world = makeWorld('discarded');
    const sarif = document([finding('Line 2 context.', SAMPLE, 2), finding('Reword line 6.', SAMPLE, 6, { fixes: [lineFix(SAMPLE, 6, 'Line 06: suggested.')] })]);
    const result = cli(world, ['publish', ...flags(world, DISCARDED_R, sarif), '--state', world.statePath, '--format', 'json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const doc = asRecord(parseJson(result.stdout));
    assert.equal(doc['status'], 'published');
    assert.deepEqual(doc['diagnostics'], []);
    const review = theReview(world);
    assert.equal(review.request.commit_id, DISCARDED_R);
    assert.deepEqual(anchors(review), [[SAMPLE, 'RIGHT', 2], [SAMPLE, 'RIGHT', 6]]);
  });

  test('a commit outside the pull request: blocked, exit 2, the problem on stderr, nothing written', () => {
    const world = makeWorld('discarded');
    const result = cli(world, ['publish', ...flags(world, UNRELATED, document([finding('Line 5.', SAMPLE, 5)])), '--state', world.statePath]);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.ok(result.stderr.includes('[reviewed-commit-not-in-pull-request]'), result.stderr);
    assert.ok(result.stderr.includes(UNRELATED), result.stderr);
    assert.deepEqual(writes(world), []);
    assert.equal(fs.existsSync(world.statePath), false);

    const json = cli(world, ['validate', ...flags(world, UNRELATED, document([finding('Line 5.', SAMPLE, 5)])), '--format', 'json']);
    assert.equal(json.status, 2);
    const doc = asRecord(parseJson(json.stdout));
    assert.equal(doc['status'], 'blocked');
    assert.deepEqual(asArray(doc['diagnostics']).map((d) => asRecord(d)['code']), ['reviewed-commit-not-in-pull-request']);
  });

  test('an undecided association is a note on stderr; validate still exits 0', () => {
    const world = makeWorld('discarded', {}, [null]);
    const result = cli(world, ['validate', ...flags(world, UNRELATED, document([finding('Line 5.', SAMPLE, 5)]))]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stderr.includes('[reviewed-commit-association-unknown]'), result.stderr);
  });
});
