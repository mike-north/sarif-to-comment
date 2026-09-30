/**
 * The GitHub client's suggestion cleanup transport (src/github.cts,
 * docs/suggestion-cleanup-contract.md §2.4–§2.9) at the HTTP boundary: exact
 * request URLs, bodies and GraphQL variables, pagination, answer validation,
 * the classification of close answers (permission refusals apart from rate
 * limits), and input refused before any request.
 *
 * Every answer is scripted per request; an unscripted request fails the test.
 * Expected requests and answers are written by hand from the GitHub REST and
 * GraphQL documentation.
 *
 * @see https://docs.github.com/en/graphql/reference/objects#repository
 * @see https://docs.github.com/en/graphql/reference/objects#ref
 * @see https://docs.github.com/en/graphql/reference/objects#pullrequestconnection
 * @see https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
 * @see https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request
 * @see https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 * @see https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#rate-limit-errors
 * @see https://docs.github.com/en/graphql/reference/objects#crossreferencedevent
 * @see https://docs.github.com/en/graphql/reference/objects#pullrequesttimelineitemsconnection
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GitHubError, createGitHubClient } from '../dist/github.cjs';
import type { IGitHubClient } from '../dist/github.cjs';
import { asRecord, asString, parseJson } from './support/runtime-types.mts';

const API = 'https://api.github.com';
const TOKEN = 'ghp_CLEANUP_TRANSPORT_0123456789';
const REPO = `${API}/repos/octo/widgets`;

interface ISent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

type Answer = () => Response;

/** A scripted host: each `METHOD url` answers from its queue, in order. */
class Script {
  readonly sent: ISent[] = [];
  private readonly answers = new Map<string, Answer[]>();

  on(method: string, url: string, ...answers: Answer[]): this {
    this.answers.set(`${method} ${url}`, [...(this.answers.get(`${method} ${url}`) ?? []), ...answers]);
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- fetch is async by contract
  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init.method ?? 'GET';
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${TOKEN}`);
    this.sent.push({ method, url, body: typeof init.body === 'string' ? parseJson(init.body) : undefined });
    const queue = this.answers.get(`${method} ${url}`);
    const next = queue?.shift();
    if (next === undefined) throw new assert.AssertionError({ message: `unscripted request ${method} ${url}` });
    return next();
  };

  client(): IGitHubClient {
    return createGitHubClient({ token: TOKEN, fetch: this.fetch });
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Answer =>
  () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Rejects with a GitHubError of `code` (and `status`, when given). */
async function rejectsWith(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof GitHubError, String(err));
    assert.equal(err.code, code, err.message);
    if (status !== undefined) assert.equal(err.status, status, err.message);
    assert.equal(err.message.includes(TOKEN), false);
    return true;
  });
}

/** Rejects with a TypeError and sends nothing. */
async function refusesInput(script: Script, promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof TypeError && pattern.test(err.message));
  assert.deepEqual(script.sent, []);
}

// ---------------------------------------------------------------------------
// Sweeps: open pull requests by branch prefix and by label (§2.4)

const GRAPHQL = `${API}/graphql`;

/** A pull request node as both sweep queries and the backlink query select it. */
const listedNode = (number: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  url: `https://github.com/octo/widgets/pull/${String(number)}`,
  body: `Body of ${String(number)}`,
  headRefName: `suggestion-pr/37/s${String(number)}`,
  headRepository: { nameWithOwner: 'octo/widgets' },
  repository: { nameWithOwner: 'octo/widgets' },
  author: { login: 'review-bot' },
  labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'suggestion' }] },
  ...extra,
});

/** A pull request as the client answers `listedNode(number)`. */
const listed = (number: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  htmlUrl: `https://github.com/octo/widgets/pull/${String(number)}`,
  body: `Body of ${String(number)}`,
  headRef: `suggestion-pr/37/s${String(number)}`,
  headRepository: 'octo/widgets',
  author: 'review-bot',
  labels: ['suggestion'],
  ...extra,
});

const refsAnswer = (totalCount: number, refs: readonly unknown[], hasNextPage: boolean, endCursor: string | null): Answer =>
  json({ data: { repository: { refs: { totalCount, pageInfo: { hasNextPage, endCursor }, nodes: refs } } } });
const ref = (name: string, pulls: readonly unknown[], more = false): Record<string, unknown> => ({
  name,
  associatedPullRequests: { pageInfo: { hasNextPage: more }, nodes: pulls },
});
const labeledAnswer = (totalCount: number, pulls: readonly unknown[], hasNextPage: boolean, endCursor: string | null): Answer =>
  json({ data: { repository: { pullRequests: { totalCount, pageInfo: { hasNextPage, endCursor }, nodes: pulls } } } });

describe('listOpenPullRequestsByBranchPrefix', () => {
  const request = { owner: 'octo', repo: 'widgets', branchPrefix: 'suggestion-pr/', first: 100, after: null };

  test('one GraphQL page of the branches under the prefix, each with its open pull requests of this repository, and the branch count', async () => {
    const script = new Script().on('POST', GRAPHQL, refsAnswer(3, [
      ref('37/s40', [listedNode(40), listedNode(90, { repository: { nameWithOwner: 'upstream/widgets' } })]),
      ref('37/stale', []),
      ref('38/s41', [listedNode(41, { headRefName: 'suggestion-pr/38/s41', body: null, author: null, headRepository: null, labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'Suggestion' }, { name: 'bug' }] } })]),
    ], true, 'Y3Vyc29yOjM='));
    const page = await script.client().listOpenPullRequestsByBranchPrefix(request);
    assert.deepEqual(page, {
      totalCount: 3,
      itemCount: 3,
      pullRequests: [listed(40), listed(41, { headRef: 'suggestion-pr/38/s41', body: '', author: null, headRepository: null, labels: ['Suggestion', 'bug'] })],
      nextCursor: 'Y3Vyc29yOjM=',
    });
    assert.equal(script.sent.length, 1);
    const [sent] = script.sent;
    assert.ok(sent);
    const body = asRecord(sent.body);
    const query = asString(body['query']);
    assert.match(query, /^query /, 'a query, never a mutation');
    assert.match(query, /refs\(refPrefix: \$prefix, first: \$first, after: \$after, orderBy: \{field: ALPHABETICAL, direction: ASC\}\)/);
    assert.match(query, /totalCount/);
    assert.match(query, /associatedPullRequests\(states: OPEN, first: 10\)/);
    assert.match(query, /author \{ login \}/);
    assert.deepEqual(body['variables'], { owner: 'octo', repo: 'widgets', prefix: 'refs/heads/suggestion-pr/', first: 100, after: null });
  });

  test('the last page has no next cursor, and a later page is asked for by its cursor', async () => {
    const script = new Script().on('POST', GRAPHQL, refsAnswer(1, [ref('37/s40', [listedNode(40)])], false, 'Y3Vyc29yOjE='));
    const page = await script.client().listOpenPullRequestsByBranchPrefix({ ...request, first: 20, after: 'Y3Vyc29yOjA=' });
    assert.equal(page.nextCursor, null);
    assert.deepEqual(asRecord(script.sent[0]?.body)['variables'], { owner: 'octo', repo: 'widgets', prefix: 'refs/heads/suggestion-pr/', first: 20, after: 'Y3Vyc29yOjA=' });
  });

  test('a pull request with more than 100 labels has its labels read in full from the REST listing', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `label-${String(i)}` }));
    const script = new Script()
      .on('POST', GRAPHQL, refsAnswer(1, [ref('37/s40', [listedNode(40, { labels: { pageInfo: { hasNextPage: true }, nodes: many } })])], false, null))
      .on('GET', `${REPO}/issues/40/labels?per_page=100&page=1`, json([...many, { name: 'suggestion' }]));
    const page = await script.client().listOpenPullRequestsByBranchPrefix(request);
    assert.equal(page.pullRequests[0]?.labels.length, 101);
  });

  const malformed: readonly (readonly [string, Answer, string])[] = [
    ['GraphQL errors', json({ data: null, errors: [{ type: 'SERVICE_UNAVAILABLE', message: 'Something went wrong' }] }), 'graphql-errors'],
    ['no refs connection', json({ data: { repository: {} } }), 'malformed-response'],
    ['no total count', json({ data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }), 'malformed-response'],
    ['a negative total count', refsAnswer(-1, [], false, null), 'malformed-response'],
    ['a next page without a cursor', refsAnswer(2, [ref('37/s40', [])], true, null), 'pagination'],
    ['more open pull requests on one branch than one page holds', refsAnswer(1, [ref('37/s40', [listedNode(40)], true)], false, null), 'pagination'],
    ['a pull request without a number', refsAnswer(1, [ref('37/s40', [listedNode(40, { number: 'forty' })])], false, null), 'malformed-response'],
    ['a pull request without a head branch', refsAnswer(1, [ref('37/s40', [listedNode(40, { headRefName: null })])], false, null), 'malformed-response'],
    ['a pull request whose author has no login', refsAnswer(1, [ref('37/s40', [listedNode(40, { author: {} })])], false, null), 'malformed-response'],
  ];
  for (const [what, answer, code] of malformed) {
    test(`an answer with ${what} is refused (${code})`, async () => {
      const script = new Script().on('POST', GRAPHQL, answer);
      await rejectsWith(script.client().listOpenPullRequestsByBranchPrefix(request), code);
    });
  }

  test('a failed query is an http-status error', async () => {
    const script = new Script().on('POST', GRAPHQL, json({ message: 'Server Error' }, 502));
    await rejectsWith(script.client().listOpenPullRequestsByBranchPrefix(request), 'http-status', 502);
  });

  test('a prefix that is not a branch path ending in "/", or a page size outside 1-100, is refused before any request', async () => {
    const script = new Script();
    for (const branchPrefix of ['', 'suggestion-pr', '/suggestion-pr/', 'a//b/', 'refs/heads/../x/']) {
      await refusesInput(script, script.client().listOpenPullRequestsByBranchPrefix({ ...request, branchPrefix }), /branchPrefix/);
    }
    for (const first of [0, 101, 1.5]) {
      await refusesInput(script, script.client().listOpenPullRequestsByBranchPrefix({ ...request, first }), /first/);
    }
    await refusesInput(script, script.client().listOpenPullRequestsByBranchPrefix({ ...request, after: '' }), /after/);
  });
});

describe('listOpenPullRequestsByLabel', () => {
  const request = { owner: 'octo', repo: 'widgets', label: 'needs review, bot', first: 20, after: null };

  test('one GraphQL page of the open pull requests with the label, oldest first, and their count', async () => {
    const script = new Script().on('POST', GRAPHQL, labeledAnswer(250, [listedNode(40), listedNode(41, { headRefName: 'feature/x', author: { login: 'someone' } })], true, 'Y3Vyc29yOjI='));
    const page = await script.client().listOpenPullRequestsByLabel(request);
    assert.deepEqual(page, {
      totalCount: 250,
      itemCount: 2,
      pullRequests: [listed(40), listed(41, { headRef: 'feature/x', author: 'someone' })],
      nextCursor: 'Y3Vyc29yOjI=',
    });
    const body = asRecord(script.sent[0]?.body);
    const query = asString(body['query']);
    assert.match(query, /^query /, 'a query, never a mutation');
    assert.match(query, /pullRequests\(labels: \[\$label\], states: OPEN, first: \$first, after: \$after, orderBy: \{field: CREATED_AT, direction: ASC\}\)/);
    assert.match(query, /totalCount/);
    // The label is a GraphQL list element, so a comma in it is never read as a list of labels.
    assert.deepEqual(body['variables'], { owner: 'octo', repo: 'widgets', label: 'needs review, bot', first: 20, after: null });
  });

  test('GraphQL errors and a missing connection are refused', async () => {
    const errors = new Script().on('POST', GRAPHQL, json({ data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }));
    await rejectsWith(errors.client().listOpenPullRequestsByLabel(request), 'graphql-errors');
    const missing = new Script().on('POST', GRAPHQL, json({ data: { repository: { pullRequests: null } } }));
    await rejectsWith(missing.client().listOpenPullRequestsByLabel(request), 'malformed-response');
  });

  test('an empty label is refused before any request', async () => {
    const script = new Script();
    await refusesInput(script, script.client().listOpenPullRequestsByLabel({ ...request, label: '' }), /label/);
  });
});

// ---------------------------------------------------------------------------
// Reading one pull request (§2.7, §2.8)

const pull = (number: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  html_url: `https://github.com/octo/widgets/pull/${String(number)}`,
  state: 'open',
  merged: false,
  body: 'text',
  head: { ref: `sarif-to-comment/suggestions/37/x`, repo: { full_name: 'octo/widgets' } },
  base: { ref: 'feature', repo: { full_name: 'octo/widgets' } },
  labels: [{ name: 'suggestion' }],
  ...extra,
});

describe('getPullRequest', () => {
  test('answers the state, merge, body, branches, repositories and labels', async () => {
    const script = new Script()
      .on('GET', `${REPO}/pulls/37`, json(pull(37, { state: 'closed', merged: true, body: null, head: { ref: 'feature', repo: null }, labels: [] })))
      .on('GET', `${REPO}/pulls/40`, json(pull(40)));
    const client = script.client();
    assert.deepEqual(await client.getPullRequest({ owner: 'octo', repo: 'widgets', pullNumber: 37 }), {
      number: 37,
      htmlUrl: 'https://github.com/octo/widgets/pull/37',
      state: 'closed',
      merged: true,
      body: '',
      headRef: 'feature',
      headRepository: null,
      baseRepository: 'octo/widgets',
      labels: [],
    });
    assert.deepEqual(await client.getPullRequest({ owner: 'octo', repo: 'widgets', pullNumber: 40 }), {
      number: 40,
      htmlUrl: 'https://github.com/octo/widgets/pull/40',
      state: 'open',
      merged: false,
      body: 'text',
      headRef: 'sarif-to-comment/suggestions/37/x',
      headRepository: 'octo/widgets',
      baseRepository: 'octo/widgets',
      labels: ['suggestion'],
    });
  });

  const malformed: readonly (readonly [string, Record<string, unknown>])[] = [
    ['another pull request', pull(41)],
    ['an unknown state', pull(40, { state: 'reopened' })],
    ['no merged flag', pull(40, { merged: undefined })],
    ['merged while open', pull(40, { merged: true })],
    ['no head branch', pull(40, { head: { repo: { full_name: 'octo/widgets' } } })],
    ['no base repository', pull(40, { base: { ref: 'feature', repo: null } })],
    ['a label without a name', pull(40, { labels: [{ color: 'ededed' }] })],
  ];
  for (const [what, answer] of malformed) {
    test(`an answer with ${what} is malformed, never guessed`, async () => {
      const script = new Script().on('GET', `${REPO}/pulls/40`, json(answer));
      await rejectsWith(script.client().getPullRequest({ owner: 'octo', repo: 'widgets', pullNumber: 40 }), 'malformed-response');
    });
  }

  test('a refusal keeps its status', async () => {
    for (const status of [403, 404, 502]) {
      const script = new Script().on('GET', `${REPO}/pulls/40`, json({ message: 'no' }, status));
      await rejectsWith(script.client().getPullRequest({ owner: 'octo', repo: 'widgets', pullNumber: 40 }), 'http-status', status);
    }
  });
});

// ---------------------------------------------------------------------------
// Reading the repository (§2.2.1: with a label override, the only proof the
// repository exists before an original's 404 is trusted)

describe('readRepository', () => {
  test('answers the repository as GitHub names it and its default branch', async () => {
    const script = new Script().on('GET', REPO, json({ full_name: 'Octo/Widgets', default_branch: 'trunk', private: true }));
    assert.deepEqual(await script.client().readRepository({ owner: 'octo', repo: 'widgets' }), { fullName: 'Octo/Widgets', defaultBranch: 'trunk' });
    assert.deepEqual(script.sent.map((r) => `${r.method} ${r.url}`), [`GET ${REPO}`]);
  });

  const malformed: readonly (readonly [string, Record<string, unknown>])[] = [
    ['another repository', { full_name: 'octo/gadgets', default_branch: 'main' }],
    ['no name', { default_branch: 'main' }],
    ['no default branch', { full_name: 'octo/widgets' }],
  ];
  for (const [what, answer] of malformed) {
    test(`an answer with ${what} is malformed, never guessed`, async () => {
      const script = new Script().on('GET', REPO, json(answer));
      await rejectsWith(script.client().readRepository({ owner: 'octo', repo: 'widgets' }), 'malformed-response');
    });
  }

  test('a refusal keeps its status (404 for a repository that does not exist or that the token cannot see)', async () => {
    for (const status of [403, 404, 502]) {
      const script = new Script().on('GET', REPO, json({ message: 'Not Found' }, status));
      await rejectsWith(script.client().readRepository({ owner: 'octo', repo: 'widgets' }), 'http-status', status);
    }
  });

  test('input that is not a repository is refused before any request', async () => {
    const script = new Script();
    // @ts-expect-error -- deliberately invalid: proves runtime validation of the repository name
    await refusesInput(script, script.client().readRepository({ owner: 'octo' }), /owner and repo/);
  });
});

// ---------------------------------------------------------------------------
// Closing one pull request (§2.9)

describe('closePullRequest', () => {
  test('sends exactly PATCH pulls/{n} with {"state":"closed"} and accepts the closed answer', async () => {
    const script = new Script().on('PATCH', `${REPO}/pulls/40`, json(pull(40, { state: 'closed' })));
    await script.client().closePullRequest({ owner: 'octo', repo: 'widgets', pullNumber: 40 });
    assert.deepEqual(script.sent, [{ method: 'PATCH', url: `${REPO}/pulls/40`, body: { state: 'closed' } }]);
  });

  test('an answer that does not show this pull request closed is malformed', async () => {
    for (const answer of [pull(40), pull(41, { state: 'closed' }), { message: 'ok' }]) {
      const script = new Script().on('PATCH', `${REPO}/pulls/40`, json(answer));
      await rejectsWith(script.client().closePullRequest({ owner: 'octo', repo: 'widgets', pullNumber: 40 }), 'malformed-response');
    }
  });

  test('403 and 404 without a rate-limit signal are http-status refusals', async () => {
    for (const status of [403, 404]) {
      const script = new Script().on('PATCH', `${REPO}/pulls/40`, json({ message: 'Resource not accessible by personal access token' }, status));
      await rejectsWith(script.client().closePullRequest({ owner: 'octo', repo: 'widgets', pullNumber: 40 }), 'http-status', status);
    }
  });

  const limited: readonly (readonly [string, number, Record<string, unknown>, Record<string, string>])[] = [
    ['the primary rate limit (x-ratelimit-remaining: 0)', 403, { message: 'API rate limit exceeded for user ID 1.' }, { 'x-ratelimit-remaining': '0' }],
    ['a secondary rate limit (retry-after)', 403, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '60' }],
    ['a secondary rate limit named only in the message', 403, { message: 'You have exceeded a secondary rate limit.' }, {}],
    ['429 Too Many Requests', 429, { message: 'Too Many Requests' }, {}],
  ];
  for (const [what, status, body, headers] of limited) {
    test(`${what} is rate-limited, not a permission refusal`, async () => {
      const script = new Script().on('PATCH', `${REPO}/pulls/40`, json(body, status, headers));
      await rejectsWith(script.client().closePullRequest({ owner: 'octo', repo: 'widgets', pullNumber: 40 }), 'rate-limited', status);
    });
  }

  test('a network failure is a network error', async () => {
    const script = new Script().on('PATCH', `${REPO}/pulls/40`, () => {
      throw new TypeError('fetch failed');
    });
    await rejectsWith(script.client().closePullRequest({ owner: 'octo', repo: 'widgets', pullNumber: 40 }), 'network');
  });

  test('an invalid number is refused before any request', async () => {
    const script = new Script();
    await refusesInput(script, script.client().closePullRequest({ owner: 'octo', repo: 'widgets', pullNumber: 0 }), /pullNumber/);
  });
});

// ---------------------------------------------------------------------------
// Cross-referencing pull requests (§2.4, targeted; D21)

const source = (number: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: {
    __typename: 'PullRequest',
    ...listedNode(number, { body: `Suggested in a review of #37 (${String(number)}).` }),
    state: 'OPEN',
    ...extra,
  },
});
/** A cross-referencing pull request as the client answers `source(number)`. */
const crossReferencing = (number: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...listed(number, { body: `Suggested in a review of #37 (${String(number)}).` }),
  repository: 'octo/widgets',
  state: 'open',
  ...extra,
});
const timeline = (nodes: readonly unknown[], hasNextPage: boolean, endCursor: string | null): Answer =>
  json({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage, endCursor }, nodes } } } } });

describe('listCrossReferencingPullRequests', () => {
  test('pages through CROSS_REFERENCED_EVENT timeline items and answers each pull request source of this repository', async () => {
    const script = new Script().on(
      'POST',
      GRAPHQL,
      timeline([source(40), { source: { __typename: 'Issue', number: 12 } }, {}], true, 'Y3Vyc29yOjE='),
      timeline([source(41, { state: 'MERGED', repository: { nameWithOwner: 'Octo/Widgets' }, body: null }), source(42, { state: 'CLOSED' }), source(7, { repository: { nameWithOwner: 'someone/fork' } })], false, 'Y3Vyc29yOjI='),
    );
    const found = await script.client().listCrossReferencingPullRequests({ owner: 'octo', repo: 'widgets', pullNumber: 37 });
    assert.deepEqual(found, [
      crossReferencing(40),
      crossReferencing(41, { repository: 'Octo/Widgets', state: 'merged', body: '' }),
      crossReferencing(42, { state: 'closed' }),
    ]);
    assert.equal(script.sent.length, 2);
    const [first, second] = script.sent.map((s) => asRecord(s.body));
    assert.ok(first && second);
    const query = asString(first['query']);
    assert.match(query, /^query /, 'a query, never a mutation');
    assert.match(query, /timelineItems\(first: 100, after: \$after, itemTypes: \[CROSS_REFERENCED_EVENT\]\)/);
    assert.match(query, /\.\.\. on CrossReferencedEvent/);
    assert.match(query, /\.\.\. on PullRequest/);
    assert.match(query, /headRefName/, 'the head branch and author are read with each source');
    assert.match(query, /author \{ login \}/);
    assert.deepEqual(first['variables'], { owner: 'octo', repo: 'widgets', number: 37, after: null });
    assert.deepEqual(second['variables'], { owner: 'octo', repo: 'widgets', number: 37, after: 'Y3Vyc29yOjE=' });
  });

  test('a source with more than 100 labels has its labels read in full from the REST listing', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `label-${String(i)}` }));
    const script = new Script()
      .on('POST', GRAPHQL, timeline([source(40, { labels: { pageInfo: { hasNextPage: true }, nodes: many } })], false, 'Y3Vyc29yOjE='))
      .on('GET', `${REPO}/issues/40/labels?per_page=100&page=1`, json(many, 200, { link: `<${REPO}/issues/40/labels?per_page=100&page=2>; rel="next"` }))
      .on('GET', `${REPO}/issues/40/labels?per_page=100&page=2`, json([{ name: 'suggestion' }]));
    const [found] = await script.client().listCrossReferencingPullRequests({ owner: 'octo', repo: 'widgets', pullNumber: 37 });
    assert.ok(found);
    assert.equal(found.labels.length, 101);
    assert.equal(found.labels.at(-1), 'suggestion');
  });

  test('regression: a source in another repository is left out before its labels are read, however many or malformed they are', async () => {
    // A private foreign repository answers its REST label listing with 403,
    // and its label connection may be null; neither may stop discovery of
    // this repository's sources (unscripted requests fail the test).
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `label-${String(i)}` }));
    const script = new Script().on('POST', GRAPHQL, timeline([
      source(45, { repository: { nameWithOwner: 'someone/private' }, labels: { pageInfo: { hasNextPage: true }, nodes: many } }),
      source(46, { repository: { nameWithOwner: 'someone/private' }, labels: null }),
      source(40),
    ], false, null));
    const found = await script.client().listCrossReferencingPullRequests({ owner: 'octo', repo: 'widgets', pullNumber: 37 });
    assert.deepEqual(found.map((f) => f.number), [40]);
    assert.deepEqual(script.sent.map((s) => s.method), ['POST'], 'no label listing in the foreign repository');
  });

  test('GraphQL errors, a missing connection and a repeated cursor are refused', async () => {
    const errors = new Script().on('POST', GRAPHQL, json({ data: { repository: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }));
    await rejectsWith(errors.client().listCrossReferencingPullRequests({ owner: 'octo', repo: 'widgets', pullNumber: 37 }), 'graphql-errors');
    const missing = new Script().on('POST', GRAPHQL, json({ data: { repository: { pullRequest: {} } } }));
    await rejectsWith(missing.client().listCrossReferencingPullRequests({ owner: 'octo', repo: 'widgets', pullNumber: 37 }), 'malformed-response');
    const repeated = new Script().on('POST', GRAPHQL, timeline([source(40)], true, 'Y3Vyc29yOjE='), timeline([source(41)], true, 'Y3Vyc29yOjE='));
    await rejectsWith(repeated.client().listCrossReferencingPullRequests({ owner: 'octo', repo: 'widgets', pullNumber: 37 }), 'pagination');
  });

  test('a pull request source without a number, state or repository is malformed', async () => {
    for (const broken of [{ number: 'x' }, { state: 'DRAFT' }, { repository: null }, { labels: null }]) {
      const script = new Script().on('POST', GRAPHQL, timeline([source(40, broken)], false, null));
      await rejectsWith(script.client().listCrossReferencingPullRequests({ owner: 'octo', repo: 'widgets', pullNumber: 37 }), 'malformed-response');
    }
  });
});
