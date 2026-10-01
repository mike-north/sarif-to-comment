/**
 * Contract tests of the GitHub client's reviewed diff and force-push history
 * (src/github.cts fetchContext and listHeadRefForcePushes), from
 * docs/specification.md R13.1 and R17.
 *
 * The client is exercised through the fake HTTP host of the historical
 * placement worlds (test/fixtures/historical-placement), whose comparisons,
 * Git objects and force-push timeline follow GitHub's documented shapes and
 * the recorded evidence; a test that needs an answer the host would not give
 * (a truncated list, a malformed page) replaces only that one response.
 * Expected requests, diffs and lists are hand-authored: the reviewed patch
 * below is the hunk GitHub recorded for GH-16's #41 (`diff_hunk` in
 * docs/evidence/realignment/e1-41-after-pull-comments.json).
 *
 * @see docs/specification.md (R13.1, R17)
 * @see docs/evidence/realignment/e0-readme.md
 * @see docs/evidence/realignment/e1-e3-readme.md
 * @see https://docs.github.com/en/rest/commits/commits#compare-two-commits
 * @see https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files
 * @see https://docs.github.com/en/graphql/reference/objects#headrefforcepushedevent
 * @see https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createGitHubClient } from '../dist/github.cjs';
import type { IGitHubClient } from '../dist/github.cjs';
import {
  ADVANCED_BASE,
  ANCESTOR_HEAD,
  ANCESTOR_R,
  BASE,
  DISCARDED_HEAD,
  DISCARDED_R,
  NOTES,
  OWNER,
  PULL,
  REBASED_HEAD,
  REBASED_R,
  REPO,
  SAMPLE,
  TOKEN,
  makeWorld,
  reads,
  sample,
} from './fixtures/historical-placement/world.mts';
import type { IWorld, WorldName } from './fixtures/historical-placement/world.mts';
import { asRecord, parseJson } from './support/runtime-types.mts';

const DESTINATION = { owner: OWNER, repo: REPO, pullNumber: PULL };

/** Answers one request instead of the host: a response, or undefined to let the host answer. */
type Override = (url: URL, body: unknown) => Response | undefined;

/** A JSON response as GitHub sends one. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A world and a client for it; `override` may answer chosen requests, and every GraphQL request body is kept. */
function clientFor(name: WorldName, options: { readonly override?: Override; readonly maxPages?: number; readonly config?: Parameters<typeof makeWorld>[1]; readonly forcePushes?: readonly (string | null)[] } = {}): {
  readonly world: IWorld;
  readonly client: IGitHubClient;
  readonly graphql: unknown[];
} {
  const world = makeWorld(name, options.config ?? {}, options.forcePushes);
  const graphql: unknown[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const body: unknown = typeof init.body === 'string' ? parseJson(init.body) : undefined;
    if (url.pathname === '/graphql') graphql.push(body);
    const answer = options.override?.(url, body);
    if (answer !== undefined) {
      world.host.write('log.json', [...world.host.log(), { method: init.method ?? 'GET', path: url.pathname, authorized: true }]);
      return answer;
    }
    return world.host.fetch(input, init);
  };
  const client = createGitHubClient({ token: TOKEN, fetch, ...(options.maxPages === undefined ? {} : { limits: { maxPages: options.maxPages } }) });
  return { world, client, graphql };
}

/** GH-16 #41's reviewed hunk: lines 5 and 6 changed, three lines of context (e1-41-after-pull-comments.json). */
const REVIEWED_HUNK = [
  '@@ -2,8 +2,8 @@',
  ' Line 02: stable filler text for the experiment.',
  ' Line 03: stable filler text for the experiment.',
  ' Line 04: stable filler text for the experiment.',
  '-Line 05: original text.',
  '-Line 06: original text.',
  '+Line 05: reviewed change one (added by C1).',
  '+Line 06: reviewed change two (added by C1).',
  ' Line 07: stable filler text for the experiment.',
  ' Line 08: stable filler text for the experiment.',
  ' Line 09: stable filler text for the experiment.',
].join('\n');

/** A comparison answer listing `count` modified files with usable patches. */
function manyFiles(count: number, status = 'ahead'): Record<string, unknown> {
  return {
    status,
    merge_base_commit: { sha: BASE },
    files: Array.from({ length: count }, (_, i) => ({ filename: `f/${String(i)}.md`, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' })),
  };
}

describe('fetchContext returns the reviewed diff (specification R13.1)', () => {
  test('at the head, the pull request\'s own diff is read from its file list, as before', async () => {
    const { world, client } = clientFor('ancestor');
    const { context } = await client.fetchContext({ destination: DESTINATION, reviewedCommit: ANCESTOR_HEAD });
    assert.deepEqual(reads(world), [`/pulls/${String(PULL)}`, `/pulls/${String(PULL)}/files`, `/pulls/${String(PULL)}`, `/compare/${BASE}...${ANCESTOR_HEAD}`]);
    assert.equal(context.diff.headCommit, ANCESTOR_HEAD);
    assert.equal(context.diff.baseCommit, BASE);
    assert.equal(context.pullHead, ANCESTOR_HEAD);
  });

  test('an ancestor of the head: one comparison from the diff base gives the two-dot diff, and the file list is not read', async () => {
    const { world, client } = clientFor('ancestor');
    const { context } = await client.fetchContext({ destination: DESTINATION, reviewedCommit: ANCESTOR_R });
    assert.deepEqual(reads(world), [`/pulls/${String(PULL)}`, `/compare/${BASE}...${ANCESTOR_HEAD}`, `/compare/${BASE}...${ANCESTOR_R}`]);
    assert.deepEqual(context.diff, { baseCommit: BASE, headCommit: ANCESTOR_R, files: [{ path: SAMPLE, patch: REVIEWED_HUNK }] });
    assert.equal(context.pullHead, ANCESTOR_HEAD, 'the head is still reported');
    assert.equal(context.reviewedCommit, ANCESTOR_R);
    assert.deepEqual(context.fileDiagnostics, []);
  });

  test('a discarded commit gets its own diff, not the head\'s (GH-16 #41)', async () => {
    const { client } = clientFor('discarded');
    const { context } = await client.fetchContext({ destination: DESTINATION, reviewedCommit: DISCARDED_R });
    assert.deepEqual(context.diff, { baseCommit: BASE, headCommit: DISCARDED_R, files: [{ path: SAMPLE, patch: REVIEWED_HUNK }] });
  });

  test('an old-source commit replaces the merge-base comparison', async () => {
    const { world, client } = clientFor('ancestor');
    const { context } = await client.fetchContext({ destination: DESTINATION, reviewedCommit: ANCESTOR_R, oldSourceCommit: BASE });
    assert.deepEqual(reads(world), [`/pulls/${String(PULL)}`, `/compare/${BASE}...${ANCESTOR_R}`]);
    assert.equal(context.diff.baseCommit, BASE);
  });

  test('after a rebase onto an advanced base, files the base side changed are listed without a patch; the others keep theirs', async () => {
    const { world, client } = clientFor('rebased');
    const { context } = await client.fetchContext({ destination: DESTINATION, reviewedCommit: REBASED_R });
    assert.deepEqual(reads(world), [
      `/pulls/${String(PULL)}`,
      `/compare/${ADVANCED_BASE}...${REBASED_HEAD}`,
      `/compare/${ADVANCED_BASE}...${REBASED_R}`,
      `/compare/${REBASED_R}...${ADVANCED_BASE}`,
    ]);
    assert.deepEqual(context.diff, {
      baseCommit: ADVANCED_BASE,
      headCommit: REBASED_R,
      files: [
        { path: NOTES, patch: ['@@ -1,3 +1,3 @@', ' # Notes', '-First note.', '+First note, reviewed.', ' Second note.'].join('\n') },
        { path: SAMPLE },
      ],
    });
    assert.deepEqual(context.fileDiagnostics, [{ path: SAMPLE, reason: 'base-changed' }]);
  });

  test('a file only the base side changed is listed without a patch, under each of its names', async () => {
    const { client } = clientFor('rebased', {
      override: (url) => {
        if (url.pathname.endsWith(`/compare/${REBASED_R}...${ADVANCED_BASE}`)) {
          return json({ status: 'diverged', merge_base_commit: { sha: BASE }, files: [
            { filename: 'docs/renamed.md', previous_filename: 'docs/original.md', status: 'renamed', additions: 0, deletions: 0 },
          ] });
        }
        return undefined;
      },
    });
    const { context } = await client.fetchContext({ destination: DESTINATION, reviewedCommit: REBASED_R });
    assert.deepEqual(context.diff.files.map((f) => [f.path, f.patch === undefined]), [
      [NOTES, false], [SAMPLE, false], ['docs/renamed.md', true], ['docs/original.md', true],
    ]);
    assert.deepEqual(context.fileDiagnostics, [{ path: 'docs/renamed.md', reason: 'base-changed' }, { path: 'docs/original.md', reason: 'base-changed' }]);
  });

  test('a reviewed commit the base already contains (`behind`): the base side\'s files, none with a patch', async () => {
    const { client } = clientFor('rebased', {
      override: (url) => {
        if (url.pathname.endsWith(`/compare/${ADVANCED_BASE}...${REBASED_R}`)) return json({ status: 'behind', merge_base_commit: { sha: REBASED_R }, files: [] });
        if (url.pathname.endsWith(`/compare/${REBASED_R}...${ADVANCED_BASE}`)) {
          return json({ status: 'ahead', merge_base_commit: { sha: REBASED_R }, files: [{ filename: SAMPLE, status: 'modified', additions: 1, deletions: 1, patch: '@@ -18 +18 @@\n-a\n+b' }] });
        }
        return undefined;
      },
    });
    const { context } = await client.fetchContext({ destination: DESTINATION, reviewedCommit: REBASED_R });
    assert.deepEqual(context.diff.files, [{ path: SAMPLE }]);
  });

  test('a reviewed diff of 300 files may be incomplete, so it is refused', async () => {
    const { client } = clientFor('ancestor', {
      override: (url) => (url.pathname.endsWith(`/compare/${BASE}...${ANCESTOR_R}`) ? json(manyFiles(300)) : undefined),
    });
    await assert.rejects(client.fetchContext({ destination: DESTINATION, reviewedCommit: ANCESTOR_R }), { code: 'files-incomplete' });
  });

  test('299 files are complete', async () => {
    const { client } = clientFor('ancestor', {
      override: (url) => (url.pathname.endsWith(`/compare/${BASE}...${ANCESTOR_R}`) ? json(manyFiles(299)) : undefined),
    });
    const { context } = await client.fetchContext({ destination: DESTINATION, reviewedCommit: ANCESTOR_R });
    assert.equal(context.diff.files.length, 299);
    assert.ok(context.diff.files.every((f) => f.patch !== undefined));
  });

  test('a base-side list of 300 files may be incomplete, so no file keeps a patch', async () => {
    const { client } = clientFor('rebased', {
      override: (url) => (url.pathname.endsWith(`/compare/${REBASED_R}...${ADVANCED_BASE}`) ? json(manyFiles(300, 'diverged')) : undefined),
    });
    const { context } = await client.fetchContext({ destination: DESTINATION, reviewedCommit: REBASED_R });
    assert.equal(context.diff.files.length, 302);
    assert.ok(context.diff.files.every((f) => f.patch === undefined));
    assert.ok(context.fileDiagnostics.every((d) => d.reason === 'base-changed'));
  });

  test('a comparison without its files or a known status is malformed, never an empty diff', async () => {
    for (const answer of [{ status: 'ahead', merge_base_commit: { sha: BASE } }, { status: 'sideways', files: [] }]) {
      const { client } = clientFor('ancestor', {
        override: (url) => (url.pathname.endsWith(`/compare/${BASE}...${ANCESTOR_R}`) ? json(answer) : undefined),
      });
      await assert.rejects(client.fetchContext({ destination: DESTINATION, reviewedCommit: ANCESTOR_R }), { code: 'malformed-response' });
    }
  });

  test('a refused comparison is operational', async () => {
    const { client } = clientFor('ancestor', {
      override: (url) => (url.pathname.endsWith(`/compare/${BASE}...${ANCESTOR_R}`) ? json({ message: 'Not Found' }, 404) : undefined),
    });
    await assert.rejects(client.fetchContext({ destination: DESTINATION, reviewedCommit: ANCESTOR_R }), { code: 'http-status', status: 404 });
  });

  test('old-side reads are verified against the reviewed commit\'s file, not the head\'s', async () => {
    const { world, client } = clientFor('discarded');
    const { readSource } = await client.fetchContext({ destination: DESTINATION, reviewedCommit: DISCARDED_R });
    const before = world.host.log().length;
    assert.equal(await readSource(BASE, SAMPLE), sample().join(''));
    const objectReads = world.host.log().slice(before).map((r) => r.path);
    assert.ok(objectReads.includes(`/repos/${OWNER}/${REPO}/git/commits/${DISCARDED_R}`), 'the reviewed commit\'s file is read');
    assert.ok(!objectReads.includes(`/repos/${OWNER}/${REPO}/git/commits/${DISCARDED_HEAD}`), 'the head is never read');
  });

  test('an old-side read of a file without a reviewed patch is refused', async () => {
    const { client } = clientFor('rebased');
    const { readSource } = await client.fetchContext({ destination: DESTINATION, reviewedCommit: REBASED_R });
    await assert.rejects(readSource(ADVANCED_BASE, SAMPLE), { code: 'patch-unavailable' });
  });
});

describe('listHeadRefForcePushes (specification R17)', () => {
  const first = '1'.repeat(40);
  const second = '2'.repeat(40);

  test('one query of the force-push events, counted by filteredCount', async () => {
    const { client, graphql } = clientFor('discarded');
    assert.deepEqual(await client.listHeadRefForcePushes(DESTINATION), { beforeCommits: [DISCARDED_R], complete: true });
    assert.equal(graphql.length, 1);
    const query = asRecord(graphql[0]);
    assert.deepEqual(query['variables'], { owner: OWNER, repo: REPO, number: PULL, after: null });
    const text = String(query['query']);
    assert.ok(text.startsWith('query'), 'a query, never a mutation');
    for (const part of ['first: 100', 'itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]', 'filteredCount', 'pageInfo { hasNextPage endCursor }', 'beforeCommit { oid }']) {
      assert.ok(text.includes(part), part);
    }
  });

  test('every page is read; a null beforeCommit is kept as null', async () => {
    const { client, graphql } = clientFor('discarded', { config: { forcePushPageSize: 1 }, forcePushes: [first, null, second] });
    assert.deepEqual(await client.listHeadRefForcePushes(DESTINATION), { beforeCommits: [first, null, second], complete: true });
    assert.deepEqual(graphql.map((q) => asRecord(asRecord(q)['variables'])['after']), [null, 'cursor:1', 'cursor:2']);
  });

  test('no event: an empty, complete list', async () => {
    const { client } = clientFor('ancestor');
    assert.deepEqual(await client.listHeadRefForcePushes(DESTINATION), { beforeCommits: [], complete: true });
  });

  test('fewer events listed than filteredCount counts is incomplete', async () => {
    const { client } = clientFor('discarded', {
      override: (url) => (url.pathname === '/graphql' ? json({ data: { repository: { pullRequest: { timelineItems: {
        filteredCount: 2, pageInfo: { hasNextPage: false, endCursor: 'c1' }, nodes: [{ __typename: 'HeadRefForcePushedEvent', beforeCommit: { oid: first } }],
      } } } } }) : undefined),
    });
    assert.deepEqual(await client.listHeadRefForcePushes(DESTINATION), { beforeCommits: [first], complete: false });
  });

  test('past the page limit the list is incomplete, and no further page is read', async () => {
    const { client, graphql } = clientFor('discarded', { maxPages: 1, config: { forcePushPageSize: 1 }, forcePushes: [first, second] });
    assert.deepEqual(await client.listHeadRefForcePushes(DESTINATION), { beforeCommits: [first], complete: false });
    assert.equal(graphql.length, 1);
  });

  test('a repeated or missing cursor is a pagination failure', async () => {
    for (const pageInfo of [{ hasNextPage: true, endCursor: null }, { hasNextPage: true, endCursor: '' }]) {
      const { client } = clientFor('discarded', {
        override: (url) => (url.pathname === '/graphql' ? json({ data: { repository: { pullRequest: { timelineItems: { filteredCount: 5, pageInfo, nodes: [] } } } } }) : undefined),
      });
      await assert.rejects(client.listHeadRefForcePushes(DESTINATION), { code: 'pagination' });
    }
    const { client } = clientFor('discarded', {
      override: (url) => (url.pathname === '/graphql' ? json({ data: { repository: { pullRequest: { timelineItems: {
        filteredCount: 5, pageInfo: { hasNextPage: true, endCursor: 'same' }, nodes: [],
      } } } } }) : undefined),
    });
    await assert.rejects(client.listHeadRefForcePushes(DESTINATION), { code: 'pagination' });
  });

  test('an item that is not a force-push event, an abbreviated oid or a missing count is malformed', async () => {
    const answers = [
      { filteredCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ __typename: 'PullRequestCommit' }] },
      { filteredCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ __typename: 'HeadRefForcePushedEvent', beforeCommit: { oid: 'd1d1d1d' } }] },
      { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    ];
    for (const timelineItems of answers) {
      const { client } = clientFor('discarded', {
        override: (url) => (url.pathname === '/graphql' ? json({ data: { repository: { pullRequest: { timelineItems } } } }) : undefined),
      });
      await assert.rejects(client.listHeadRefForcePushes(DESTINATION), { code: 'malformed-response' }, JSON.stringify(timelineItems));
    }
  });

  test('GraphQL errors are reported, never read as no events', async () => {
    const { client } = clientFor('discarded', {
      override: (url) => (url.pathname === '/graphql' ? json({ data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest.' }] }) : undefined),
    });
    await assert.rejects(client.listHeadRefForcePushes(DESTINATION), { code: 'graphql-errors' });
  });

  test('a malformed destination is a TypeError before any request', async () => {
    const { client, graphql } = clientFor('discarded');
    await assert.rejects(client.listHeadRefForcePushes({ owner: OWNER, repo: REPO, pullNumber: 0 }), TypeError);
    assert.equal(graphql.length, 0);
  });
});
