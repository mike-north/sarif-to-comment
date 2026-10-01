/**
 * Unit tests of the reviewed commit's association with its pull request
 * (src/reviewed-commit-association.cts), from docs/specification.md R17,
 * with a recording client in place of GitHub.
 *
 * Hand-authored expectations: which commits associate the reviewed commit
 * (the head, its ancestors, a head a force-push replaced and its ancestors),
 * the order and number of reads, and when the answer is unknown rather than
 * "not associated". Why the check exists and what GitHub records come from
 * GH-16 (GitHub accepts reviews at commits outside the pull request) and E0
 * (force-push events name the replaced heads).
 *
 * @see docs/specification.md (R17)
 * @see docs/evidence/realignment/e0-readme.md
 * @see docs/evidence/realignment/e1-e3-readme.md
 * @see https://docs.github.com/en/graphql/reference/objects#headrefforcepushedevent
 * @see https://docs.github.com/en/rest/commits/commits#compare-two-commits
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GitHubError } from '../dist/github.cjs';
import type { CommitComparison, IHeadRefForcePushes } from '../dist/github.cjs';
import {
  MAX_EARLIER_HEAD_COMPARISONS,
  associateReviewedCommit,
  associationDiagnostic,
} from '../dist/reviewed-commit-association.cjs';
import type { IAssociationRequest, ReviewedCommitAssociation } from '../dist/reviewed-commit-association.cjs';

const DESTINATION: { readonly owner: string; readonly repo: string; readonly pullNumber: number } = { owner: 'octo', repo: 'gadgets', pullNumber: 12 };
const R = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';

/** A distinct full commit id for a test's earlier heads. */
function commit(n: number): string {
  return n.toString(16).padStart(40, 'a');
}

/** One comparison the client answers: `compare/{base}...{head}` -> status, or a thrown error. */
type Answer = CommitComparison | Error;

/** A client whose comparisons and force-push history are scripted, recording every call in order. */
function scripted(comparisons: Readonly<Record<string, Answer>>, pushes: IHeadRefForcePushes = { beforeCommits: [], complete: true }) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      compareCommits: async ({ base, head }: { readonly owner: string; readonly repo: string; readonly base: string; readonly head: string }): Promise<CommitComparison> => {
        calls.push(`compare ${base}...${head}`);
        await Promise.resolve();
        const answer = comparisons[`${base}...${head}`];
        if (answer === undefined) throw new Error(`unscripted comparison ${base}...${head}`);
        if (answer instanceof Error) throw answer;
        return answer;
      },
      listHeadRefForcePushes: async (destination: typeof DESTINATION): Promise<IHeadRefForcePushes> => {
        assert.deepEqual(destination, DESTINATION);
        calls.push('force-pushes');
        await Promise.resolve();
        return pushes;
      },
    },
  };
}

const request: IAssociationRequest = { destination: DESTINATION, reviewedCommit: R, head: HEAD };
const notFound = (): GitHubError => new GitHubError('http-status', 'GitHub answered HTTP 404 (Not Found) for the commit comparison.', { status: 404 });

describe('associateReviewedCommit (specification R17)', () => {
  test('the head itself is associated without any read', async () => {
    const { client, calls } = scripted({});
    assert.deepEqual(await associateReviewedCommit({ ...request, reviewedCommit: HEAD }, client), { kind: 'associated', via: 'head' });
    assert.deepEqual(calls, []);
  });

  test('an ancestor of the head is associated by one comparison, without the force-push history', async () => {
    const { client, calls } = scripted({ [`${R}...${HEAD}`]: 'ahead' });
    assert.deepEqual(await associateReviewedCommit(request, client), { kind: 'associated', via: 'ancestor-of-head' });
    assert.deepEqual(calls, [`compare ${R}...${HEAD}`]);
  });

  test('a head a force-push replaced is associated by its event alone, with no comparison against it', async () => {
    const { client, calls } = scripted({ [`${R}...${HEAD}`]: 'diverged' }, { beforeCommits: [commit(1), R], complete: true });
    assert.deepEqual(await associateReviewedCommit(request, client), { kind: 'associated', via: 'replaced-head' });
    assert.deepEqual(calls, [`compare ${R}...${HEAD}`, 'force-pushes']);
  });

  test('an ancestor of a replaced head is associated; earlier heads are compared newest first, stopping at the first that contains it', async () => {
    const { client, calls } = scripted(
      { [`${R}...${HEAD}`]: 'diverged', [`${R}...${commit(3)}`]: 'diverged', [`${R}...${commit(2)}`]: 'ahead', [`${R}...${commit(1)}`]: 'ahead' },
      { beforeCommits: [commit(1), commit(2), commit(3)], complete: true },
    );
    assert.deepEqual(await associateReviewedCommit(request, client), { kind: 'associated', via: 'ancestor-of-replaced-head' });
    assert.deepEqual(calls, [`compare ${R}...${HEAD}`, 'force-pushes', `compare ${R}...${commit(3)}`, `compare ${R}...${commit(2)}`]);
  });

  test('a commit no head ever contained is not associated, once every replaced head was seen and compared', async () => {
    const { client, calls } = scripted(
      { [`${R}...${HEAD}`]: 'diverged', [`${R}...${commit(1)}`]: 'diverged', [`${R}...${commit(2)}`]: 'behind' },
      { beforeCommits: [commit(1), commit(2), commit(1)], complete: true },
    );
    assert.deepEqual(await associateReviewedCommit(request, client), { kind: 'not-associated' });
    // Newest event first, and a head replaced twice is compared once: the newest event names commit(1) again.
    assert.deepEqual(calls, [`compare ${R}...${HEAD}`, 'force-pushes', `compare ${R}...${commit(1)}`, `compare ${R}...${commit(2)}`]);
  });

  test('without any force-push, a commit outside the head is not associated, even if the base branch contains it', async () => {
    // `behind`: the reviewed commit is a descendant of the head, for example on the base branch after a merge.
    const { client } = scripted({ [`${R}...${HEAD}`]: 'behind' });
    assert.deepEqual(await associateReviewedCommit(request, client), { kind: 'not-associated' });
  });

  test('an event that names no earlier head leaves the answer unknown, not "not associated"', async () => {
    const { client, calls } = scripted({ [`${R}...${HEAD}`]: 'diverged', [`${R}...${commit(1)}`]: 'diverged' }, { beforeCommits: [null, commit(1)], complete: true });
    assert.deepEqual(await associateReviewedCommit(request, client), { kind: 'unknown', reasons: ['before-commit-missing'] });
    assert.deepEqual(calls, [`compare ${R}...${HEAD}`, 'force-pushes', `compare ${R}...${commit(1)}`]);
  });

  test('an event that names no earlier head does not stop another from associating the commit', async () => {
    const { client } = scripted({ [`${R}...${HEAD}`]: 'diverged', [`${R}...${commit(1)}`]: 'ahead' }, { beforeCommits: [commit(1), null], complete: true });
    assert.deepEqual(await associateReviewedCommit(request, client), { kind: 'associated', via: 'ancestor-of-replaced-head' });
  });

  test('force-push events that could not all be listed leave the answer unknown', async () => {
    const { client } = scripted({ [`${R}...${HEAD}`]: 'diverged' }, { beforeCommits: [], complete: false });
    assert.deepEqual(await associateReviewedCommit(request, client), { kind: 'unknown', reasons: ['events-incomplete'] });
  });

  test('an earlier head GitHub cannot compare (404) leaves the answer unknown, and the next one is still compared', async () => {
    const { client, calls } = scripted(
      { [`${R}...${HEAD}`]: 'diverged', [`${R}...${commit(2)}`]: notFound(), [`${R}...${commit(1)}`]: 'diverged' },
      { beforeCommits: [commit(1), commit(2)], complete: true },
    );
    assert.deepEqual(await associateReviewedCommit(request, client), { kind: 'unknown', reasons: ['earlier-head-unreadable'] });
    assert.deepEqual(calls.slice(-2), [`compare ${R}...${commit(2)}`, `compare ${R}...${commit(1)}`]);
  });

  test(`more than ${String(MAX_EARLIER_HEAD_COMPARISONS)} earlier heads: that many are compared, and the answer is unknown`, async () => {
    const earlier = Array.from({ length: MAX_EARLIER_HEAD_COMPARISONS + 1 }, (_, i) => commit(i + 1));
    const comparisons: Record<string, Answer> = { [`${R}...${HEAD}`]: 'diverged' };
    for (const c of earlier) comparisons[`${R}...${c}`] = 'diverged';
    const { client, calls } = scripted(comparisons, { beforeCommits: earlier, complete: true });
    assert.equal(MAX_EARLIER_HEAD_COMPARISONS, 10, 'the bound the specification states');
    assert.deepEqual(await associateReviewedCommit(request, client), { kind: 'unknown', reasons: ['comparison-limit'] });
    assert.equal(calls.filter((c) => c.startsWith('compare') && !c.endsWith(HEAD)).length, MAX_EARLIER_HEAD_COMPARISONS);
  });

  test('several unknown reasons are reported together, in a fixed order', async () => {
    const { client } = scripted(
      { [`${R}...${HEAD}`]: 'diverged', [`${R}...${commit(1)}`]: notFound() },
      { beforeCommits: [commit(1), null], complete: false },
    );
    assert.deepEqual(await associateReviewedCommit(request, client), {
      kind: 'unknown', reasons: ['before-commit-missing', 'events-incomplete', 'earlier-head-unreadable'],
    });
  });

  test('any other failed comparison is operational and rejects', async () => {
    const serverError = new GitHubError('http-status', 'GitHub answered HTTP 502 (Bad Gateway) for the commit comparison.', { status: 502 });
    const earlier = scripted({ [`${R}...${HEAD}`]: 'diverged', [`${R}...${commit(1)}`]: serverError }, { beforeCommits: [commit(1)], complete: true });
    await assert.rejects(associateReviewedCommit(request, earlier.client), /502/);
    // The comparison with the head is never taken as unknown: a 404 there is operational too.
    const head = scripted({ [`${R}...${HEAD}`]: notFound() });
    await assert.rejects(associateReviewedCommit(request, head.client), /404/);
  });

  test('a failed force-push read is operational and rejects', async () => {
    const { client } = scripted({ [`${R}...${HEAD}`]: 'diverged' });
    const failing = { ...client, listHeadRefForcePushes: () => Promise.reject(new GitHubError('graphql-errors', 'The force-push query returned errors: INTERNAL')) };
    await assert.rejects(associateReviewedCommit(request, failing), /force-push query/);
  });

  test('a client without the reads refuses rather than guessing', async () => {
    await assert.rejects(associateReviewedCommit(request, {}), /cannot check that the reviewed commit belongs to the pull request/);
    // The head itself needs no read, so any client answers it.
    assert.deepEqual(await associateReviewedCommit({ ...request, reviewedCommit: HEAD }, {}), { kind: 'associated', via: 'head' });
  });
});

describe('associationDiagnostic (specification R17; docs/diagnostics.md)', () => {
  const diagnosticOf = (association: ReviewedCommitAssociation) => associationDiagnostic(association, request);

  test('an associated commit has no diagnostic', () => {
    for (const via of ['head', 'ancestor-of-head', 'replaced-head', 'ancestor-of-replaced-head'] as const) {
      assert.equal(diagnosticOf({ kind: 'associated', via }), undefined);
    }
  });

  test('a commit outside the pull request is the blocking error, naming the commit and the pull request', () => {
    assert.deepEqual(diagnosticOf({ kind: 'not-associated' }), {
      severity: 'error',
      code: 'reviewed-commit-not-in-pull-request',
      title: 'The reviewed commit does not belong to the pull request',
      message: `Commit ${R} is not part of octo/gadgets#12: it is not the pull request's head ${HEAD} or an ancestor of it, `
        + "and no force-push of the pull request's branch replaced a head that contains it. "
        + 'GitHub would accept a review at that commit, so nothing was prepared or written.',
      subject: 'octo/gadgets#12',
      remedies: ['Check the reviewed commit: review a commit of this pull request.', 'Check the pull request number.'],
    });
  });

  test('an unknown answer is a note naming every reason', () => {
    const note = diagnosticOf({ kind: 'unknown', reasons: ['before-commit-missing', 'comparison-limit'] });
    assert.deepEqual(note, {
      severity: 'note',
      code: 'reviewed-commit-association-unknown',
      title: 'Whether the reviewed commit belongs to the pull request is not known',
      message: `Whether commit ${R} belongs to octo/gadgets#12 is not known: it is not the pull request's head ${HEAD} or an ancestor of it, `
        + 'and a force-push event names no earlier head; more than 10 earlier heads would need comparing. '
        + 'A lookup that cannot see every replaced head does not show that the commit is outside the pull request, so the review is prepared at that commit.',
      subject: 'octo/gadgets#12',
    });
  });
});
