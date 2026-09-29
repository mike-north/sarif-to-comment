/**
 * The fake GitHub host's routes for suggestion pull request cleanup
 * (docs/suggestion-cleanup-contract.md §2.4–§2.9), served by FakeHttpGitHub
 * (fake-http-github.mts) over the same stored pull requests as the companion
 * routes (fake-http-companion.mts):
 *
 *   GET   /repos/{o}/{r}/issues?labels=L&state=open&per_page=P&page=N
 *         open issues and pull requests of this repository carrying label L
 *         (case-insensitively), newest first, P per page, with a
 *         `Link` header naming the next and last pages in GitHub's
 *         /repositories/{id}/issues form. A pull request carries a
 *         `pull_request` object; an issue does not.
 *   GET   /repos/{o}/{r}/pulls/{n}   one pull request with state, merged,
 *         body, head and base repositories and labels (404 for an issue or a
 *         number no pull request has)
 *   PATCH /repos/{o}/{r}/pulls/{n}   exactly { "state": "closed" }: closes it
 *   POST  /graphql                   (a query selecting timelineItems) the
 *         original's CROSS_REFERENCED_EVENT items: one per pull request or
 *         issue, in any repository, whose body mentions `#n` (this repository)
 *         or `owner/repo#n`, repeated `referenceEvents` times, in number order,
 *         paginated by `timelinePageSize` with opaque cursors. Each source
 *         carries at most 100 labels, with `hasNextPage` beyond that.
 *
 * Behavior (config.json `companion`, see ICompanionConfig): per pull request
 * read and close failures, a failing or shifting issues listing, the timeline
 * page size and a failing timeline query. A lost close response closes the
 * pull request and then fails as a network error, as a lost response would.
 * Request bodies and query strings must be exactly as documented: anything
 * else answers 400, so a wire-format regression fails loudly.
 *
 * This models documented GitHub behavior; it is not evidence of live GitHub
 * behavior (see docs/suggestion-cleanup-e2e-evidence.md).
 *
 * @see https://docs.github.com/en/rest/issues/issues#list-repository-issues
 * @see https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
 * @see https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request
 * @see https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 * @see https://docs.github.com/en/graphql/reference/objects#crossreferencedevent
 * @see https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
 */

import { isRecord } from '../../support/runtime-types.mts';
import type { UnknownRecord } from '../../support/runtime-types.mts';
import { pullJson } from './fake-http-companion.mts';
import type { ICompanionHost, IStoredPull } from './fake-http-companion.mts';

type Json = (body: unknown, status?: number, headers?: Readonly<Record<string, string>>) => Response;

/** The numeric repository id GitHub's pagination links use (any fixed value). */
const REPOSITORY_ID = 424242;

/** The page size the timeline serves when the test does not choose one (the size the client asks for). */
const TIMELINE_PAGE = 100;

/** GitHub answers at most this many labels in one `labels(first: 100)` connection. */
const LABELS_PER_SOURCE = 100;

/** A thrown network failure, as fetch reports a lost response. */
function lostResponse(): never {
  throw new TypeError('fetch failed: socket hang up');
}

/** The full name of the repository a stored pull request belongs to. */
function repositoryOf(host: ICompanionHost, pull: IStoredPull): string {
  const { owner, repo } = host.repository();
  return pull.repository ?? `${owner}/${repo}`;
}

/** Whether a stored entry is a pull request of this repository. */
function isLocalPull(host: ICompanionHost, pull: IStoredPull): boolean {
  const { owner, repo } = host.repository();
  return pull.isIssue !== true && repositoryOf(host, pull) === `${owner}/${repo}`;
}

/** Whether `body`, of an item in `from`, mentions this repository's pull request `number`. */
function mentions(host: ICompanionHost, from: string, body: string, number: number): boolean {
  const { owner, repo } = host.repository();
  const local = `${owner}/${repo}`;
  const qualified = new RegExp(`(^|[^\\w/.-])${local.replace(/[.]/g, '\\.')}#${String(number)}(?!\\d)`, 'i');
  const bare = new RegExp(`(^|[^\\w/])#${String(number)}(?!\\d)`);
  return qualified.test(body) || (from === local && bare.test(body));
}

/** The cleanup route for one request, or null when the request is not a cleanup route. */
export function cleanupRoute(host: ICompanionHost, method: string, u: URL, bodyText: () => string, json: Json): Response | null {
  const { owner, repo } = host.repository();
  const repoPath = `/repos/${owner}/${repo}`;
  const config = host.config();
  const p = u.pathname;

  if (method === 'GET' && p === `${repoPath}/issues`) {
    const params = [...u.searchParams.keys()].sort().join(',');
    const label = u.searchParams.get('labels');
    const perPage = Number(u.searchParams.get('per_page'));
    const page = Number(u.searchParams.get('page'));
    if (params !== 'labels,page,per_page,state' || u.searchParams.get('state') !== 'open' || label === null || label === '' || !(perPage >= 1) || !(page >= 1)) {
      return json({ message: `fake host: unexpected issue listing ${u.search}` }, 400);
    }
    if (config.failIssueListing === true) return json({ message: 'Server Error' }, 502);
    // GitHub's `labels` is a comma-separated list, every one required.
    const wanted = label.split(',').map((l) => l.toLowerCase());
    const listed = host.state().pulls
      .filter((pr) => repositoryOf(host, pr) === `${owner}/${repo}` && pr.state === 'open')
      .filter((pr) => wanted.every((w) => pr.labels.some((l) => l.toLowerCase() === w)))
      .sort((a, b) => b.number - a.number);
    // A pull request opened after the first page was read sits in front of
    // every later page, so each of them starts one entry earlier.
    const shift = config.shiftIssueListing === true ? 1 : 0;
    const offset = page > 1 ? shift : 0;
    const items = listed.slice((page - 1) * perPage - offset, page * perPage - offset);
    const last = Math.max(1, Math.ceil((listed.length + shift) / perPage));
    const link = (n: number): string =>
      `<https://api.github.com/repositories/${String(REPOSITORY_ID)}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=${String(perPage)}&page=${String(n)}>`;
    const headers: Record<string, string> = page < last ? { link: `${link(page + 1)}; rel="next", ${link(last)}; rel="last"` } : {};
    return json(items.map((pr) => issueJson(host, pr)), 200, headers);
  }

  const single = new RegExp(`^${repoPath}/pulls/(\\d+)$`).exec(p);
  if (single && (method === 'GET' || method === 'PATCH')) {
    const number = Number(single[1]);
    const index = host.state().pulls.findIndex((pr) => pr.number === number && isLocalPull(host, pr));
    const pull = host.state().pulls[index];
    if (method === 'GET') {
      const failure = config.pullReads?.[String(number)];
      if (failure === 'forbidden') return json({ message: 'Resource not accessible by personal access token' }, 403);
      if (failure === 'not-found' || pull === undefined) return json({ message: 'Not Found' }, 404);
      if (failure === 'server-error') return json({ message: 'Server Error' }, 502);
      if (failure === 'malformed') return json({ ...pullJson(host.repository(), host.user, pull), state: 'reopened' });
      return json(pullJson(host.repository(), host.user, pull));
    }
    let request: unknown;
    try {
      request = JSON.parse(bodyText());
    } catch {
      request = null;
    }
    if (!isRecord(request) || Object.keys(request).join(',') !== 'state' || request['state'] !== 'closed') {
      return json({ message: 'fake host: a close request must be exactly {"state":"closed"}' }, 400);
    }
    const failure = config.closes?.[String(number)];
    if (failure === 'forbidden') return json({ message: 'Resource not accessible by personal access token' }, 403);
    if (failure === 'not-found' || pull === undefined) return json({ message: 'Not Found' }, 404);
    if (failure === 'rate-limited') {
      return json({ message: 'API rate limit exceeded for user ID 4242.' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' });
    }
    if (failure === 'secondary-rate-limit') {
      return json({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }, 403, { 'retry-after': '60' });
    }
    if (failure === 'too-many-requests') return json({ message: 'Too Many Requests' }, 429, { 'retry-after': '60' });
    if (failure === 'server-error') return json({ message: 'Server Error' }, 502);
    const closed: IStoredPull = { ...pull, state: 'closed' };
    const state = host.state();
    host.save({ ...state, pulls: state.pulls.map((pr, i) => (i === index ? closed : pr)) });
    if (failure === 'lose-response') lostResponse();
    return json(pullJson(host.repository(), host.user, closed));
  }
  return null;
}

/** An issues-listing entry for a stored pull request or issue. */
function issueJson(host: ICompanionHost, pr: IStoredPull): UnknownRecord {
  const full = repositoryOf(host, pr);
  const kind = pr.isIssue === true ? 'issues' : 'pull';
  return {
    number: pr.number,
    html_url: `https://github.com/${full}/${kind}/${String(pr.number)}`,
    title: pr.title,
    body: pr.body === '' ? null : pr.body,
    state: pr.state,
    labels: pr.labels.map((name) => ({ name })),
    ...(pr.isIssue === true ? {} : {
      pull_request: {
        url: `https://api.github.com/repos/${full}/pulls/${String(pr.number)}`,
        html_url: `https://github.com/${full}/pull/${String(pr.number)}`,
      },
    }),
  };
}

/**
 * The answer to a GraphQL timeline query, or null when the query is not one.
 * Variables must be exactly { owner, repo, number, after }.
 */
export function timelineQuery(host: ICompanionHost, request: unknown, json: Json): Response | null {
  if (!isRecord(request) || typeof request['query'] !== 'string' || !request['query'].includes('timelineItems')) return null;
  const query = request['query'];
  const vars = request['variables'];
  const { owner, repo } = host.repository();
  if (!query.startsWith('query') || !query.includes('itemTypes: [CROSS_REFERENCED_EVENT]') || !isRecord(vars) || Object.keys(vars).sort().join(',') !== 'after,number,owner,repo') {
    return json({ message: 'fake host: unexpected timeline query' }, 400);
  }
  const config = host.config();
  if (config.failTimeline === true) return json({ data: null, errors: [{ type: 'SERVICE_UNAVAILABLE', message: 'Something went wrong' }] });
  const number = vars['number'];
  const pulls = host.state().pulls;
  const original = pulls.find((pr) => pr.number === number && isLocalPull(host, pr));
  if (vars['owner'] !== owner || vars['repo'] !== repo || typeof number !== 'number' || original === undefined) {
    return json({ data: { repository: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'], message: `Could not resolve to a PullRequest with the number of ${String(number)}.` }] });
  }
  const events = pulls
    .filter((pr) => pr !== original && mentions(host, repositoryOf(host, pr), pr.body, number))
    .sort((a, b) => a.number - b.number)
    .flatMap((pr) => Array.from({ length: pr.referenceEvents ?? 1 }, () => ({ source: sourceJson(host, pr) })));
  const size = config.timelinePageSize ?? TIMELINE_PAGE;
  const after = vars['after'];
  const start = typeof after === 'string' ? Number(after.replace(/^cursor:/, '')) : 0;
  const nodes = events.slice(start, start + size);
  const end = start + nodes.length;
  return json({
    data: {
      repository: {
        pullRequest: {
          timelineItems: { pageInfo: { hasNextPage: end < events.length, endCursor: nodes.length === 0 ? null : `cursor:${String(end)}` }, nodes },
        },
      },
    },
  });
}

/** A cross-reference event's source: a PullRequest with the fields the client selects, or an Issue. */
function sourceJson(host: ICompanionHost, pr: IStoredPull): UnknownRecord {
  const full = repositoryOf(host, pr);
  if (pr.isIssue === true) return { __typename: 'Issue', number: pr.number };
  return {
    __typename: 'PullRequest',
    number: pr.number,
    url: `https://github.com/${full}/pull/${String(pr.number)}`,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state.toUpperCase(),
    repository: { nameWithOwner: full },
    labels: {
      pageInfo: { hasNextPage: pr.labels.length > LABELS_PER_SOURCE },
      nodes: pr.labels.slice(0, LABELS_PER_SOURCE).map((name) => ({ name })),
    },
  };
}
