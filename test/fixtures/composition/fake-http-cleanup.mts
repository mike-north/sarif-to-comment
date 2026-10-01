/**
 * The fake GitHub host's routes for suggestion pull request cleanup
 * (docs/suggestion-cleanup-contract.md §2.4–§2.9), served by FakeHttpGitHub
 * (fake-http-github.mts) over the same stored pull requests as the companion
 * routes (fake-http-companion.mts):
 *
 *   GET   /repos/{o}/{r}/pulls/{n}   one pull request with state, merged,
 *         body, head and base repositories and labels (404 for an issue or a
 *         number no pull request has)
 *   PATCH /repos/{o}/{r}/pulls/{n}   exactly { "state": "closed" }: closes it
 *   POST  /graphql                   three read-only queries:
 *     - a query of one or more `refs(refPrefix: …)` connections, each
 *       optionally aliased (the default sweep), answered as GitHub was
 *       observed to answer them (docs/evidence/suggestion-cleanup/25-34):
 *       this repository's branches under `refPrefix`, in name order, each
 *       `name` relative to `refPrefix`. `query` keeps the branches whose
 *       relative name contains it, ignoring case (a substring match, never
 *       anchored or fuzzy). `totalCount` counts what is kept; `first: 0`
 *       answers the count with no branch. Each branch carries its open
 *       associated pull requests (`associatedPullRequests(states: OPEN)`):
 *       under exactly `refs/heads/`, every open pull request, in any
 *       repository, whose head is that branch of this repository; under any
 *       deeper prefix, none at all, as GitHub answers. A branch exists while
 *       a stored pull request of this repository has it as its head
 *       (whatever that pull request's state: closing never deletes a branch)
 *       or the companion state records it (created or seeded with
 *       seedBranches).
 *     - a `pullRequests(labels: […], states: OPEN)` query (a `--label`
 *       sweep): this repository's open pull requests carrying the label
 *       (case-insensitively), in creation (number) order; issues never.
 *       `totalCount` counts them.
 *     - a `timelineItems` query (targeted discovery): the original's
 *       CROSS_REFERENCED_EVENT items: one per pull request or issue, in any
 *       repository, whose body mentions `#n` (this repository) or
 *       `owner/repo#n`, repeated `referenceEvents` times, in number order,
 *       paginated by `timelinePageSize` with opaque cursors.
 *     Every pull request answered carries its head branch and repository,
 *     its author's login (the authenticated user's for `authorId` equal to
 *     its id, otherwise `someone-else`) and at most 100 labels, with
 *     `hasNextPage` beyond that. Sweeps page by the query's `first`, capped
 *     by `sweepPageSize`, with opaque cursors; with `repeatSweepNode`, each
 *     later page first repeats the previous page's last node.
 *
 * Behavior (config.json `companion`, see ICompanionConfig): per pull request
 * read and close failures, failing sweeps, the sweep and timeline page sizes
 * and a failing timeline query. A lost close response closes the pull
 * request and then fails as a network error, as a lost response would.
 * Request bodies, query shapes and variables must be exactly as documented:
 * anything else answers 400, so a wire-format regression fails loudly.
 *
 * This models documented GitHub behavior, and the ref listing as GitHub was
 * observed to answer it; it is not evidence of live GitHub behavior (see
 * docs/suggestion-cleanup-e2e-evidence.md).
 *
 * @see https://docs.github.com/en/graphql/reference/objects#repository
 * @see https://docs.github.com/en/graphql/reference/objects#ref
 * @see https://docs.github.com/en/graphql/reference/objects#pullrequestconnection
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
  if (pr.isIssue === true) return { __typename: 'Issue', number: pr.number };
  return { __typename: 'PullRequest', ...pullNode(host, pr), state: pr.merged ? 'MERGED' : pr.state.toUpperCase() };
}

/** The head branch's repository of a stored pull request: its own repository unless it names another; null when deleted. */
function headRepositoryOf(host: ICompanionHost, pr: IStoredPull): string | null {
  return pr.headRepo === undefined ? repositoryOf(host, pr) : pr.headRepo;
}

/** A pull request with the fields every discovery query selects. */
function pullNode(host: ICompanionHost, pr: IStoredPull): UnknownRecord {
  const full = repositoryOf(host, pr);
  const head = headRepositoryOf(host, pr);
  return {
    number: pr.number,
    url: `https://github.com/${full}/pull/${String(pr.number)}`,
    body: pr.body,
    headRefName: pr.head,
    headRepository: head === null ? null : { nameWithOwner: head },
    repository: { nameWithOwner: full },
    author: { login: pr.authorId === host.user.id ? host.user.login : 'someone-else' },
    labels: {
      pageInfo: { hasNextPage: pr.labels.length > LABELS_PER_SOURCE },
      nodes: pr.labels.slice(0, LABELS_PER_SOURCE).map((name) => ({ name })),
    },
  };
}

/** The greatest `first` GitHub accepts on a connection. */
const MAX_FIRST = 100;

/**
 * One page of `items` from an offset cursor, with GitHub's pageInfo. With
 * `repeat`, each page after the first starts with the previous page's last
 * item, as when an item is added ahead of it while the listing is read; the
 * page then holds one new item fewer.
 */
function page<T>(
  items: readonly T[],
  first: number,
  after: unknown,
  size: number | undefined,
  tag: string,
  repeat: boolean,
): { readonly nodes: T[]; readonly pageInfo: UnknownRecord } {
  const start = typeof after === 'string' ? Number(after.slice(tag.length + 1)) : 0;
  const limit = Math.min(first, size ?? first);
  const previous = repeat && start > 0 ? items.slice(start - 1, start) : [];
  const fresh = items.slice(start, start + limit - previous.length);
  const end = start + fresh.length;
  return { nodes: [...previous, ...fresh], pageInfo: { hasNextPage: end < items.length, endCursor: fresh.length === 0 ? null : `${tag}:${String(end)}` } };
}

/** This repository's branches: every stored pull request's head branch here, and every branch the companion state records. */
function branchesOf(host: ICompanionHost): string[] {
  const { owner, repo } = host.repository();
  const local = `${owner}/${repo}`;
  const heads = host.state().pulls.filter((pr) => pr.isIssue !== true && headRepositoryOf(host, pr) === local).map((pr) => pr.head);
  return [...new Set([...Object.keys(host.state().refs), ...heads])].sort();
}

/**
 * A GraphQL argument as a query passes it: a `$variable` resolved from
 * `vars`, a string or integer literal, `null`, or undefined when absent.
 */
function argumentOf(args: string, name: string, vars: UnknownRecord): unknown {
  const match = new RegExp(`\\b${name}: (\\$\\w+|"[^"]*"|\\d+|null)`).exec(args);
  const value = match?.[1];
  if (value === undefined) return undefined;
  if (value.startsWith('$')) return vars[value.slice(1)];
  if (value.startsWith('"')) return value.slice(1, -1);
  return value === 'null' ? null : Number(value);
}

/** The names of the variables a query declares (`query ($owner: String!, …)`), sorted and comma-joined. */
function declaredVariables(query: string): string {
  const header = /^query \(([^)]*)\)/.exec(query)?.[1] ?? '';
  return [...header.matchAll(/\$(\w+):/g)].map((m) => m[1]).sort().join(',');
}

/**
 * One `refs(…)` connection as GitHub was observed to answer it
 * (docs/evidence/suggestion-cleanup/25-34), or the Response refusing
 * arguments GitHub would not accept.
 */
function refsConnection(host: ICompanionHost, args: string, vars: UnknownRecord, json: Json): UnknownRecord | Response {
  const { owner, repo } = host.repository();
  const local = `${owner}/${repo}`;
  const refPrefix = argumentOf(args, 'refPrefix', vars);
  const filter = argumentOf(args, 'query', vars);
  const first = argumentOf(args, 'first', vars);
  const after = argumentOf(args, 'after', vars) ?? null;
  if (typeof refPrefix !== 'string' || !refPrefix.startsWith('refs/heads/') || !refPrefix.endsWith('/')) {
    return json({ message: 'fake host: unexpected ref prefix' }, 400);
  }
  if (filter !== undefined && (typeof filter !== 'string' || filter === '')) return json({ message: 'fake host: unexpected ref query' }, 400);
  if (typeof first !== 'number' || !Number.isInteger(first) || first < 0 || first > MAX_FIRST || !(after === null || typeof after === 'string')) {
    return json({ errors: [{ type: 'INVALID_ARGUMENTS', message: 'fake host: first must be 0-100 and after a cursor or null' }] });
  }
  const under = refPrefix.slice('refs/heads/'.length);
  const names = branchesOf(host)
    .filter((branch) => branch.startsWith(under))
    .map((branch) => branch.slice(under.length))
    .filter((name) => filter === undefined || name.toLowerCase().includes(filter.toLowerCase()));
  if (first === 0) return { totalCount: names.length, pageInfo: { hasNextPage: names.length > 0, endCursor: null }, nodes: [] };
  const config = host.config();
  const { nodes, pageInfo } = page(names, first, after, config.sweepPageSize, 'refs', config.repeatSweepNode === true);
  const pulls = host.state().pulls;
  return {
    totalCount: names.length,
    pageInfo,
    nodes: nodes.map((name) => ({
      name,
      associatedPullRequests: {
        pageInfo: { hasNextPage: false },
        // Observed live: a ref listed under a prefix deeper than refs/heads/
        // answers no associated pull request, whatever pull requests its
        // branch heads (evidence 25, 26 and 29).
        nodes: under === ''
          ? pulls.filter((pr) => pr.isIssue !== true && pr.state === 'open' && pr.head === name && headRepositoryOf(host, pr) === local).map((pr) => pullNode(host, pr))
          : [],
      },
    })),
  };
}

/**
 * The answer to a sweep query (a query of `refs(refPrefix: …)` connections
 * or a `pullRequests(labels: …)` query), or null when the query is neither.
 * A ref query's variables must be exactly those it declares, among them
 * owner and repo; a label query's exactly { owner, repo, label, first, after }.
 */
export function sweepQuery(host: ICompanionHost, request: unknown, json: Json): Response | null {
  if (!isRecord(request) || typeof request['query'] !== 'string') return null;
  const query = request['query'];
  const byBranch = query.includes('refs(refPrefix: ');
  const byLabel = query.includes('pullRequests(labels: [$label]');
  if (!byBranch && !byLabel) return null;
  const vars = request['variables'];
  const { owner, repo } = host.repository();
  const keys = byBranch ? declaredVariables(query) : 'after,first,label,owner,repo';
  const shapeOk = byBranch
    ? query.includes('associatedPullRequests(states: OPEN') && keys.split(',').includes('owner') && keys.split(',').includes('repo')
    : query.includes('states: OPEN') && query.includes('orderBy: {field: CREATED_AT, direction: ASC}');
  if (!query.startsWith('query') || !shapeOk || !isRecord(vars) || Object.keys(vars).sort().join(',') !== keys) {
    return json({ message: 'fake host: unexpected sweep query' }, 400);
  }
  const config = host.config();
  if (byBranch) {
    if (config.failSweep === true) return json({ data: null, errors: [{ type: 'SERVICE_UNAVAILABLE', message: 'Something went wrong' }] });
    if (vars['owner'] !== owner || vars['repo'] !== repo) return repositoryNotFound(json);
    const repository: UnknownRecord = {};
    for (const [, alias, args] of query.matchAll(/(?:(\w+): )?refs\(([^)]*)\)/g)) {
      const connection = refsConnection(host, args ?? '', vars, json);
      if (connection instanceof Response) return connection;
      repository[alias ?? 'refs'] = connection;
    }
    return json({ data: { repository } });
  }
  const first = vars['first'];
  const after = vars['after'];
  if (typeof first !== 'number' || !Number.isInteger(first) || first < 1 || first > MAX_FIRST || !(after === null || typeof after === 'string')) {
    return json({ errors: [{ type: 'INVALID_ARGUMENTS', message: 'fake host: first must be 1-100 and after a cursor or null' }] });
  }
  if (config.failSweep === true) return json({ data: null, errors: [{ type: 'SERVICE_UNAVAILABLE', message: 'Something went wrong' }] });
  if (vars['owner'] !== owner || vars['repo'] !== repo) return repositoryNotFound(json);
  const label = vars['label'];
  if (typeof label !== 'string' || label === '') return json({ message: 'fake host: unexpected label' }, 400);
  const labeled = host.state().pulls
    .filter((pr) => isLocalPull(host, pr) && pr.state === 'open' && pr.labels.some((l) => l.toLowerCase() === label.toLowerCase()))
    .sort((a, b) => a.number - b.number);
  const { nodes, pageInfo } = page(labeled, first, after, config.sweepPageSize, 'pulls', config.repeatSweepNode === true);
  return json({ data: { repository: { pullRequests: { totalCount: labeled.length, pageInfo, nodes: nodes.map((pr) => pullNode(host, pr)) } } } });
}

/** GitHub's answer to a query of a repository that does not exist or that the token cannot see. */
function repositoryNotFound(json: Json): Response {
  return json({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'], message: 'Could not resolve to a Repository.' }] });
}
