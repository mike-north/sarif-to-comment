/**
 * The fake GitHub host's model of the objects a companion suggestion pull
 * request needs (docs/companion-suggestion-pr-contract.md §2.6–§2.10), served
 * by FakeHttpGitHub (fake-http-github.mts) at the HTTP level:
 *
 *   GET  /repos/{o}/{r}                           default_branch, permissions
 *   GET  /repos/{o}/{r}/labels/{name}             a label, found case-insensitively
 *   POST /repos/{o}/{r}/git/blobs                 { content, encoding: 'base64' }
 *   POST /repos/{o}/{r}/git/trees                 { base_tree, tree: [{ path, mode, type, sha }] }
 *   POST /repos/{o}/{r}/git/commits               { message, tree, parents }
 *   POST /repos/{o}/{r}/git/refs                  { ref: 'refs/heads/…', sha }
 *   GET  /repos/{o}/{r}/git/ref/heads/{branch}    one branch (404 when absent); the
 *                                                 default branch names the repository's
 *                                                 `defaultBranchCommit`, whose snapshot
 *                                                 holds the repository configuration
 *                                                 (docs/suggestion-pr-convention.md §4)
 *   POST /repos/{o}/{r}/pulls                     { title, head, base, body, draft }
 *   GET  /repos/{o}/{r}/pulls?head=o:b&state=all  pull requests from one branch
 *   POST /repos/{o}/{r}/issues/{n}/labels         { labels: [name, …] }
 *   GET  /repos/{o}/{r}/issues/{n}/labels         labels of one pull request
 *
 * Object ids: blobs are real Git blob ids; created trees and commits get
 * deterministic SHA-1 ids over their content, so the same content always
 * gets the same id, as in Git. A created tree is materialized from its base
 * tree's complete file list, so trees read back exactly like snapshot trees.
 *
 * Like GitHub, the host refuses a second branch of one name (422), a pull
 * request whose head or base branch does not exist (422), a second open pull
 * request for one head and base (422), and a label the repository does not
 * have (422). (Live GitHub is reported to create such a label instead; the fake refuses it
 * so that a product that ever sent one fails loudly.) Request bodies must have exactly the documented keys: anything
 * else is a harness failure that answers 400, so a wire-format regression in
 * the client fails loudly.
 *
 * Behavior (config.json `companion`):
 *   loseResponse:    keys ('blob' | 'tree' | 'commit' | 'ref' | 'pull' |
 *                    'label') whose write is stored and then fails as a network
 *                    error, as a lost response would
 *   failBeforeStore: keys whose write answers 502 without storing anything
 *   refuse:          key -> status: the write is refused with that status and
 *                    stores nothing (a definitive host refusal)
 *   failRepositoryRead: the repository read (default branch, permissions)
 *                    answers 502
 *   failRefReadsAfter: branch reads after this many (counted from the host's
 *                    creation) answer 502; 0 fails every branch read. Reads of
 *                    the default branch are neither counted nor failed.
 *   defaultBranchRead: 'server-error' | 'forbidden' | 'network': the read of the
 *                    default branch's reference (the first read of the
 *                    repository configuration) fails that way
 *
 * Delayed visibility is set with the host's hide({ refs, pulls, labels }):
 * the next N reads of a branch, of a branch's pull requests, or of a pull
 * request's labels answer as if nothing had been created yet; each read
 * consumes one. People's later changes are modelled by the host's setRef,
 * editPull and removeLabel.
 *
 * This models documented GitHub behavior; it is not evidence of live GitHub
 * behavior (see docs/companion-suggestion-pr-e2e-evidence.md).
 *
 * @see https://docs.github.com/en/rest/git/blobs#create-a-blob
 * @see https://docs.github.com/en/rest/git/trees#create-a-tree
 * @see https://docs.github.com/en/rest/git/commits#create-a-commit
 * @see https://docs.github.com/en/rest/git/refs#create-a-reference
 * @see https://docs.github.com/en/rest/git/refs#get-a-reference
 * @see https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/pulls#list-pull-requests
 * @see https://docs.github.com/en/rest/issues/labels#add-labels-to-an-issue
 * @see https://docs.github.com/en/rest/issues/labels#get-a-label
 * @see https://docs.github.com/en/rest/repos/repos#get-a-repository
 */

import * as crypto from 'node:crypto';

import {
  isArrayOf,
  isBoolean,
  isEither,
  isNull,
  isNumber,
  isOneOf,
  isOptional,
  isRecord,
  isRecordOf,
  isShape,
  isString,
} from '../../support/runtime-types.mts';
import type { Guard, UnknownRecord } from '../../support/runtime-types.mts';

/** The writes whose behavior a test can change. */
export type CompanionWrite = 'blob' | 'tree' | 'commit' | 'ref' | 'pull' | 'label';

/** How the host answers a read of one pull request instead of serving it (cleanup, fake-http-cleanup.mts). */
export type PullReadFailure = 'forbidden' | 'not-found' | 'server-error' | 'malformed';

/** How the host answers a close of one pull request instead of closing it (cleanup, fake-http-cleanup.mts). */
export type CloseFailure = 'forbidden' | 'not-found' | 'rate-limited' | 'secondary-rate-limit' | 'too-many-requests' | 'server-error' | 'lose-response';

/** Companion behavior (config.json `companion`). */
export interface ICompanionConfig {
  readonly loseResponse?: readonly CompanionWrite[] | undefined;
  readonly failBeforeStore?: readonly CompanionWrite[] | undefined;
  readonly refuse?: Readonly<Partial<Record<CompanionWrite, number>>> | undefined;
  readonly failRefReadsAfter?: number | undefined;
  readonly failRepositoryRead?: boolean | undefined;
  /** How the read of the default branch's reference fails, instead of answering. */
  readonly defaultBranchRead?: 'server-error' | 'forbidden' | 'network' | undefined;
  /** Pull request number -> how its GET pulls/{n} fails. */
  readonly pullReads?: Readonly<Record<string, PullReadFailure>> | undefined;
  /** Pull request number -> how its close (PATCH) fails. A lost response closes it first. */
  readonly closes?: Readonly<Record<string, CloseFailure>> | undefined;
  /** The sweep queries (branch prefix and label) answer with a GraphQL `errors` array. */
  readonly failSweep?: boolean | undefined;
  /** Items per sweep page at most, whatever the query asks for (default: what it asks for). */
  readonly sweepPageSize?: number | undefined;
  /**
   * Each sweep page after the first repeats the previous page's last node
   * first, as when an item is added ahead of it while the listing is read.
   */
  readonly repeatSweepNode?: boolean | undefined;
  /** Cross-reference events per GraphQL timeline page (default 100, the page size the client asks for). */
  readonly timelinePageSize?: number | undefined;
  /** The GraphQL timeline query answers with an `errors` array. */
  readonly failTimeline?: boolean | undefined;
  /**
   * Pull request number -> its `mergeable`, as GET pulls/{n} answers it
   * (fake-http-cleanup.mts): GitHub answers null while it computes it in the
   * background, so the first `pendingReads` reads (default 1) answer null and
   * later ones `value`. A pull request with no entry always answers null.
   */
  readonly mergeable?: Readonly<Record<string, { readonly value: boolean | null; readonly pendingReads?: number | undefined }>> | undefined;
}

/** One entry of a Git tree, as the trees API lists it. */
export interface ICompanionTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: 'tree' | 'blob' | 'commit';
  readonly sha: string;
  readonly size?: number | undefined;
}

/** A created commit. */
export interface ICreatedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

/**
 * A created pull request, or one a test seeded (seedPulls): an original, a
 * suggestion, an ordinary pull request, an issue sharing the number space
 * (`isIssue`), or a pull request in another repository that references this
 * one (`repository`).
 */
export interface IStoredPull {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
  readonly draft: boolean;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly labels: readonly string[];
  readonly authorId: number;
  /** The head branch's repository (`owner/repo`); default this repository; null when it was deleted. */
  readonly headRepo?: string | null | undefined;
  /** The repository holding this pull request (`owner/repo`); default this repository. */
  readonly repository?: string | undefined;
  /** An issue, not a pull request: listed without `pull_request`, never served as a pull request. */
  readonly isIssue?: boolean | undefined;
  /** How many cross-reference events each reference in the body produces on the original's timeline (default 1). */
  readonly referenceEvents?: number | undefined;
}

/** Everything the companion routes store (companion.json). */
export interface ICompanionState {
  readonly blobs: Readonly<Record<string, string>>;
  readonly trees: Readonly<Record<string, readonly ICompanionTreeEntry[]>>;
  readonly commits: Readonly<Record<string, ICreatedCommit>>;
  readonly refs: Readonly<Record<string, string>>;
  readonly pulls: readonly IStoredPull[];
  /** Remaining hidden reads (delayed visibility), consumed as reads happen. */
  readonly hidden: { readonly refs: number; readonly pulls: number; readonly labels: number };
  /** Branch reads answered so far. */
  readonly refReads: number;
  /** Pull request number -> reads of its `mergeable` answered so far. */
  readonly mergeableReads?: Readonly<Record<string, number>> | undefined;
}

/** The repository facts the companion routes answer with. */
export interface ICompanionRepository {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string;
  /** The snapshot commit the default branch points at. */
  readonly defaultBranchCommit: string;
  readonly headRef: string;
  readonly push: boolean;
  readonly labels: readonly string[];
  /** Snapshot commits (commit -> root tree) and every snapshot tree. */
  readonly snapshotCommits: Readonly<Record<string, string>>;
  readonly snapshotTrees: Readonly<Record<string, readonly ICompanionTreeEntry[]>>;
  readonly snapshotBlobs: Readonly<Record<string, Buffer>>;
}

/** What a companion route needs from the host. */
export interface ICompanionHost {
  readonly user: { readonly id: number; readonly login: string };
  config(): ICompanionConfig;
  state(): ICompanionState;
  save(state: ICompanionState): void;
  repository(): ICompanionRepository;
}

type Json = (body: unknown, status?: number) => Response;

const WRITES: readonly CompanionWrite[] = ['blob', 'tree', 'commit', 'ref', 'pull', 'label'];

export const isCompanionConfig: Guard<ICompanionConfig> = isShape({
  loseResponse: isOptional(isArrayOf(isOneOf(...WRITES))),
  failBeforeStore: isOptional(isArrayOf(isOneOf(...WRITES))),
  refuse: isOptional(isRecordOf(isNumber)),
  failRefReadsAfter: isOptional(isNumber),
  failRepositoryRead: isOptional(isBoolean),
  defaultBranchRead: isOptional(isOneOf('server-error', 'forbidden', 'network')),
  pullReads: isOptional(isRecordOf(isOneOf('forbidden', 'not-found', 'server-error', 'malformed'))),
  closes: isOptional(isRecordOf(isOneOf('forbidden', 'not-found', 'rate-limited', 'secondary-rate-limit', 'too-many-requests', 'server-error', 'lose-response'))),
  failSweep: isOptional(isBoolean),
  sweepPageSize: isOptional(isNumber),
  repeatSweepNode: isOptional(isBoolean),
  timelinePageSize: isOptional(isNumber),
  failTimeline: isOptional(isBoolean),
  mergeable: isOptional(isRecordOf(isShape({ value: isEither(isBoolean, isNull), pendingReads: isOptional(isNumber) }))),
});

const isTreeEntry: Guard<ICompanionTreeEntry> = isShape({
  path: isString,
  mode: isString,
  type: isOneOf('tree', 'blob', 'commit'),
  sha: isString,
  size: isOptional(isNumber),
});

export const isCompanionState: Guard<ICompanionState> = isShape({
  blobs: isRecordOf(isString),
  trees: isRecordOf(isArrayOf(isTreeEntry)),
  commits: isRecordOf(isShape({ tree: isString, parents: isArrayOf(isString), message: isString })),
  refs: isRecordOf(isString),
  pulls: isArrayOf(
    isShape({
      number: isNumber,
      title: isString,
      body: isString,
      head: isString,
      base: isString,
      draft: isBoolean,
      state: isOneOf('open', 'closed'),
      merged: isBoolean,
      labels: isArrayOf(isString),
      authorId: isNumber,
      headRepo: isOptional(isEither(isString, isNull)),
      repository: isOptional(isString),
      isIssue: isOptional(isBoolean),
      referenceEvents: isOptional(isNumber),
    }),
  ),
  hidden: isShape({ refs: isNumber, pulls: isNumber, labels: isNumber }),
  refReads: isNumber,
  mergeableReads: isOptional(isRecordOf(isNumber)),
});

export const EMPTY_COMPANION_STATE: ICompanionState = Object.freeze({
  blobs: {},
  trees: {},
  commits: {},
  refs: {},
  pulls: [],
  hidden: { refs: 0, pulls: 0, labels: 0 },
  refReads: 0,
});

/** The first pull request number the host assigns, far from any original's number. */
const FIRST_PULL = 101;

/** Whether `value` has exactly `keys` (sorted comparison). */
function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

/** A deterministic 40-hex id over a labelled JSON value. */
function contentId(kind: string, value: unknown): string {
  return crypto.createHash('sha1').update(`${kind}:${JSON.stringify(value)}`).digest('hex');
}

/** Git's blob object id. */
function blobId(bytes: Buffer): string {
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${String(bytes.length)}\0`), bytes])).digest('hex');
}

/** A thrown network failure, as fetch reports a lost response. */
function lostResponse(): never {
  throw new TypeError('fetch failed: socket hang up');
}

/** Every tree the host knows: snapshot trees and created ones. */
function treeOf(repository: ICompanionRepository, state: ICompanionState, sha: string): readonly ICompanionTreeEntry[] | undefined {
  return repository.snapshotTrees[sha] ?? state.trees[sha];
}

/** The complete file list (path -> entry) of a tree, walking nested trees. */
function flatten(repository: ICompanionRepository, state: ICompanionState, sha: string, prefix = ''): Map<string, ICompanionTreeEntry> {
  const files = new Map<string, ICompanionTreeEntry>();
  const entries = treeOf(repository, state, sha);
  if (entries === undefined) throw new Error(`fake host: unknown tree ${sha}`);
  for (const entry of entries) {
    const full = prefix === '' ? entry.path : `${prefix}/${entry.path}`;
    if (entry.type === 'tree') {
      for (const [p, e] of flatten(repository, state, entry.sha, full)) files.set(p, e);
    } else {
      files.set(full, { ...entry, path: full });
    }
  }
  return files;
}

/** Builds nested trees for a complete file list; returns the root id and every tree created. */
function buildTrees(files: ReadonlyMap<string, ICompanionTreeEntry>): { root: string; trees: Record<string, ICompanionTreeEntry[]> } {
  const trees: Record<string, ICompanionTreeEntry[]> = {};
  const build = (dir: string): string => {
    const names = new Map<string, ICompanionTreeEntry>();
    const children = new Set<string>();
    for (const [p, entry] of files) {
      if (dir !== '' && !p.startsWith(`${dir}/`)) continue;
      const rest = dir === '' ? p : p.slice(dir.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) names.set(rest, { ...entry, path: rest });
      else children.add(rest.slice(0, slash));
    }
    for (const child of children) {
      const sha = build(dir === '' ? child : `${dir}/${child}`);
      names.set(child, { path: child, mode: '040000', type: 'tree', sha });
    }
    const entries = [...names.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const sha = contentId('tree', entries);
    trees[sha] = entries;
    return sha;
  };
  return { root: build(''), trees };
}

/** The companion route for one request, or null when the path is not a companion route. */
export function companionRoute(host: ICompanionHost, method: string, u: URL, bodyText: () => string, json: Json): Response | null {
  const repository = host.repository();
  const repoPath = `/repos/${repository.owner}/${repository.repo}`;
  const p = u.pathname;
  const config = host.config();
  const body = (): UnknownRecord => {
    const parsed: unknown = JSON.parse(bodyText());
    if (!isRecord(parsed)) throw new Error('fake host: a companion request body is not an object');
    return parsed;
  };
  /** Applies loseResponse / failBeforeStore / refuse to one write; returns the early answer, if any. */
  const before = (write: CompanionWrite): Response | null => {
    const refusal = config.refuse?.[write];
    if (refusal !== undefined) return json({ message: `Refused by the fake host (${write})`, errors: [`${write} refused`] }, refusal);
    if (config.failBeforeStore?.includes(write) === true) return json({ message: 'Server Error' }, 502);
    return null;
  };
  const after = (write: CompanionWrite, answer: Response): Response => {
    if (config.loseResponse?.includes(write) === true) lostResponse();
    return answer;
  };
  let m: RegExpExecArray | null;

  if (method === 'GET' && p === repoPath) {
    if (config.failRepositoryRead === true) return json({ message: 'Server Error' }, 502);
    return json({
      full_name: `${repository.owner}/${repository.repo}`,
      default_branch: repository.defaultBranch,
      permissions: { admin: false, maintain: false, push: repository.push, triage: repository.push, pull: true },
    });
  }
  if (method === 'GET' && (m = new RegExp(`^${repoPath}/labels/([^/]+)$`).exec(p))) {
    const wanted = decodeURIComponent(m[1] ?? '');
    const found = repository.labels.find((l) => l.toLowerCase() === wanted.toLowerCase());
    return found === undefined ? json({ message: 'Not Found' }, 404) : json({ name: found, color: 'ededed' });
  }
  if (method === 'POST' && p === `${repoPath}/git/blobs`) {
    const request = body();
    if (!hasExactKeys(request, ['content', 'encoding']) || request['encoding'] !== 'base64' || typeof request['content'] !== 'string') {
      return json({ message: 'fake host: malformed blob request' }, 400);
    }
    const early = before('blob');
    if (early) return early;
    const bytes = Buffer.from(request['content'], 'base64');
    if (bytes.toString('base64') !== request['content']) return json({ message: 'fake host: non-canonical base64' }, 400);
    const sha = blobId(bytes);
    const state = host.state();
    host.save({ ...state, blobs: { ...state.blobs, [sha]: request['content'] } });
    return after('blob', json({ sha, url: `https://api.github.com${repoPath}/git/blobs/${sha}` }, 201));
  }
  if (method === 'POST' && p === `${repoPath}/git/trees`) {
    const request = body();
    const entries = request['tree'];
    const baseTree = request['base_tree'];
    const isEntry = isShape({ path: isString, mode: isOneOf('100644', '100755'), type: isOneOf('blob'), sha: isEither(isString, isNull) });
    if (
      !hasExactKeys(request, ['base_tree', 'tree']) ||
      typeof baseTree !== 'string' ||
      !Array.isArray(entries) ||
      !entries.every((e) => isRecord(e) && hasExactKeys(e, ['path', 'mode', 'type', 'sha']) && isEntry(e))
    ) {
      return json({ message: 'fake host: malformed tree request' }, 400);
    }
    const early = before('tree');
    if (early) return early;
    const state = host.state();
    if (treeOf(repository, state, baseTree) === undefined) return json({ message: 'base_tree is not a tree' }, 422);
    const files = flatten(repository, state, baseTree);
    for (const entry of entries) {
      if (!isEntry(entry)) return json({ message: 'fake host: malformed tree entry' }, 400);
      if (entry.sha === null) {
        if (!files.delete(entry.path)) return json({ message: `${entry.path} is not in base_tree` }, 422);
        continue;
      }
      const content = state.blobs[entry.sha] ?? repository.snapshotBlobs[entry.sha]?.toString('base64');
      if (content === undefined) return json({ message: `blob ${entry.sha} does not exist` }, 422);
      files.set(entry.path, { path: entry.path, mode: entry.mode, type: 'blob', sha: entry.sha, size: Buffer.from(content, 'base64').length });
    }
    const built = buildTrees(files);
    host.save({ ...state, trees: { ...state.trees, ...built.trees } });
    return after('tree', json({ sha: built.root, truncated: false, tree: built.trees[built.root] }, 201));
  }
  if (method === 'POST' && p === `${repoPath}/git/commits`) {
    const request = body();
    const parents = request['parents'];
    if (
      !hasExactKeys(request, ['message', 'tree', 'parents']) ||
      typeof request['message'] !== 'string' ||
      typeof request['tree'] !== 'string' ||
      !isArrayOf(isString)(parents)
    ) {
      return json({ message: 'fake host: malformed commit request' }, 400);
    }
    const early = before('commit');
    if (early) return early;
    const state = host.state();
    if (treeOf(repository, state, request['tree']) === undefined) return json({ message: 'tree does not exist' }, 422);
    const known = (sha: string): boolean => repository.snapshotCommits[sha] !== undefined || state.commits[sha] !== undefined;
    if (!parents.every(known)) return json({ message: 'parent does not exist' }, 422);
    const commit: ICreatedCommit = { tree: request['tree'], parents, message: request['message'] };
    const sha = contentId('commit', commit);
    host.save({ ...host.state(), commits: { ...state.commits, [sha]: commit } });
    return after('commit', json({ sha, tree: { sha: commit.tree }, parents: parents.map((s) => ({ sha: s })), message: commit.message }, 201));
  }
  if (method === 'POST' && p === `${repoPath}/git/refs`) {
    const request = body();
    const ref = request['ref'];
    const sha = request['sha'];
    if (!hasExactKeys(request, ['ref', 'sha']) || typeof ref !== 'string' || typeof sha !== 'string' || !ref.startsWith('refs/heads/')) {
      return json({ message: 'fake host: malformed ref request' }, 400);
    }
    const early = before('ref');
    if (early) return early;
    const state = host.state();
    const branch = ref.slice('refs/heads/'.length);
    if (state.refs[branch] !== undefined || branch === repository.headRef || branch === repository.defaultBranch) {
      return json({ message: 'Reference already exists' }, 422);
    }
    if (state.commits[sha] === undefined && repository.snapshotCommits[sha] === undefined) return json({ message: 'Object does not exist' }, 422);
    host.save({ ...state, refs: { ...state.refs, [branch]: sha } });
    return after('ref', json({ ref, object: { sha, type: 'commit' } }, 201));
  }
  if (method === 'GET' && p.startsWith(`${repoPath}/git/ref/heads/`)) {
    const branch = p.slice(`${repoPath}/git/ref/heads/`.length).split('/').map(decodeURIComponent).join('/');
    if (branch === repository.defaultBranch) {
      if (config.defaultBranchRead === 'network') lostResponse();
      if (config.defaultBranchRead === 'forbidden') return json({ message: 'Resource not accessible by personal access token' }, 403);
      if (config.defaultBranchRead === 'server-error') return json({ message: 'Server Error' }, 502);
      return json({ ref: `refs/heads/${branch}`, object: { sha: repository.defaultBranchCommit, type: 'commit' } });
    }
    const counted = { ...host.state(), refReads: host.state().refReads + 1 };
    host.save(counted);
    if (config.failRefReadsAfter !== undefined && counted.refReads > config.failRefReadsAfter) return json({ message: 'Server Error' }, 502);
    const state = host.state();
    if (state.hidden.refs > 0) {
      host.save({ ...state, hidden: { ...state.hidden, refs: state.hidden.refs - 1 } });
      return json({ message: 'Not Found' }, 404);
    }
    const sha = state.refs[branch];
    return sha === undefined ? json({ message: 'Not Found' }, 404) : json({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
  }
  if (method === 'POST' && p === `${repoPath}/pulls`) {
    const request = body();
    const { title, head, base, body: text, draft } = request;
    if (
      !hasExactKeys(request, ['title', 'head', 'base', 'body', 'draft']) ||
      typeof title !== 'string' ||
      typeof head !== 'string' ||
      typeof base !== 'string' ||
      typeof text !== 'string' ||
      typeof draft !== 'boolean'
    ) {
      return json({ message: 'fake host: malformed pull request request' }, 400);
    }
    const early = before('pull');
    if (early) return early;
    const state = host.state();
    const exists = (branch: string): boolean =>
      state.refs[branch] !== undefined || branch === repository.headRef || branch === repository.defaultBranch;
    if (!exists(head) || !exists(base)) return json({ message: 'Validation Failed', errors: [{ field: exists(head) ? 'base' : 'head', code: 'invalid' }] }, 422);
    if (state.pulls.some((pr) => pr.head === head && pr.base === base && pr.state === 'open')) {
      return json({ message: 'Validation Failed', errors: [{ message: `A pull request already exists for ${repository.owner}:${head}.` }] }, 422);
    }
    const pull: IStoredPull = {
      number: FIRST_PULL + state.pulls.length,
      title,
      body: text,
      head,
      base,
      draft,
      state: 'open',
      merged: false,
      labels: [],
      authorId: host.user.id,
    };
    host.save({ ...state, pulls: [...state.pulls, pull] });
    return after('pull', json(pullJson(repository, host.user, pull), 201));
  }
  if (method === 'GET' && p === `${repoPath}/pulls`) {
    const params = [...u.searchParams.keys()].sort().join(',');
    const head = u.searchParams.get('head');
    if (params !== 'head,page,per_page,state' || u.searchParams.get('state') !== 'all' || head === null || !head.startsWith(`${repository.owner}:`)) {
      return json({ message: `fake host: unexpected pull listing ${u.search}` }, 400);
    }
    const state = host.state();
    if (state.hidden.pulls > 0) {
      host.save({ ...state, hidden: { ...state.hidden, pulls: state.hidden.pulls - 1 } });
      return json([]);
    }
    const branch = head.slice(repository.owner.length + 1);
    return json(state.pulls.filter((pr) => pr.head === branch).map((pr) => pullJson(repository, host.user, pr)));
  }
  if ((m = new RegExp(`^${repoPath}/issues/(\\d+)/labels$`).exec(p))) {
    const number = Number(m[1]);
    const state = host.state();
    const index = state.pulls.findIndex((pr) => pr.number === number);
    const pull = state.pulls[index];
    if (pull === undefined) return json({ message: 'Not Found' }, 404);
    if (method === 'GET') {
      if (state.hidden.labels > 0) {
        host.save({ ...state, hidden: { ...state.hidden, labels: state.hidden.labels - 1 } });
        return json([]);
      }
      return json(pull.labels.map((name) => ({ name })));
    }
    if (method === 'POST') {
      const request = body();
      const labels = request['labels'];
      if (!hasExactKeys(request, ['labels']) || !isArrayOf(isString)(labels) || labels.length === 0) {
        return json({ message: 'fake host: malformed label request' }, 400);
      }
      const early = before('label');
      if (early) return early;
      if (!labels.every((name) => repository.labels.includes(name))) return json({ message: 'Validation Failed', errors: [{ field: 'labels', code: 'invalid' }] }, 422);
      const labelled: IStoredPull = { ...pull, labels: [...pull.labels, ...labels.filter((name, i) => !pull.labels.includes(name) && labels.indexOf(name) === i)] };
      host.save({ ...state, pulls: state.pulls.map((pr, i) => (i === index ? labelled : pr)) });
      return after('label', json(labelled.labels.map((n) => ({ name: n }))));
    }
  }
  return null;
}

/** A pull request as the REST API answers it (the fields the client reads, and a few more). */
export function pullJson(repository: ICompanionRepository, user: { readonly id: number; readonly login: string }, pull: IStoredPull): UnknownRecord {
  const fullName = pull.repository ?? `${repository.owner}/${repository.repo}`;
  const headRepo = pull.headRepo === undefined ? fullName : pull.headRepo;
  return {
    number: pull.number,
    html_url: `https://github.com/${fullName}/pull/${String(pull.number)}`,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    draft: pull.draft,
    merged: pull.merged,
    merged_at: pull.merged ? '2026-09-29T00:00:00Z' : null,
    user: { id: pull.authorId, login: pull.authorId === user.id ? user.login : 'someone-else' },
    head: { ref: pull.head, repo: headRepo === null ? null : { full_name: headRepo } },
    base: { ref: pull.base, repo: { full_name: fullName } },
    labels: pull.labels.map((name) => ({ name })),
  };
}

/** The exact bytes of `filePath` in the commit a branch points at, or null (a test's readback). */
export function fileOnBranch(repository: ICompanionRepository, state: ICompanionState, branch: string, filePath: string): Buffer | null {
  const commit = state.refs[branch];
  if (commit === undefined) throw new Error(`fake host: no branch ${branch}`);
  const created = state.commits[commit];
  const root = created ? created.tree : repository.snapshotCommits[commit];
  if (root === undefined) throw new Error(`fake host: unknown commit ${commit}`);
  const entry = flatten(repository, state, root).get(filePath);
  if (entry === undefined) return null;
  const content = state.blobs[entry.sha];
  return content === undefined ? (repository.snapshotBlobs[entry.sha] ?? null) : Buffer.from(content, 'base64');
}

/** The complete file list of a branch's commit: path -> mode. */
export function filesOnBranch(repository: ICompanionRepository, state: ICompanionState, branch: string): Map<string, string> {
  const commit = state.refs[branch];
  if (commit === undefined) throw new Error(`fake host: no branch ${branch}`);
  const created = state.commits[commit];
  const root = created ? created.tree : repository.snapshotCommits[commit];
  if (root === undefined) throw new Error(`fake host: unknown commit ${commit}`);
  return new Map([...flatten(repository, state, root)].map(([p, e]) => [p, e.mode]));
}

/** A created commit's tree listing, for a GET git/trees answer. */
export function createdTree(state: ICompanionState, sha: string): readonly ICompanionTreeEntry[] | undefined {
  return state.trees[sha];
}
