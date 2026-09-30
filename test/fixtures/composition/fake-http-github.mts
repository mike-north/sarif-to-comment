/**
 * A fake GitHub at the HTTP level, for testing the production composition:
 * the real public library (src/index.cts) with the real GitHub client
 * (src/github.cts), whose `fetch` is this host's `fetch`. Nothing above HTTP is
 * replaced, so request construction, pagination, source reads, patch
 * verification, create-review wire format and readback normalization are all
 * the product's own.
 *
 * The host serves the hand-authored repository in repository.json:
 *   GET  /user
 *   GET  /repos/{o}/{r}/pulls/{n}                  head/base/changed_files
 *   GET  /repos/{o}/{r}/pulls/{n}/files            the authored patch
 *   GET  /repos/{o}/{r}/compare/{base}...{head}    merge base = base commit; status
 *                                                  `ahead`
 *   GET  /repos/{o}/{r}/compare/{a}...{b}          any two snapshot commits, related
 *                                                  by the repository's `parents`:
 *                                                  status identical | ahead | behind |
 *                                                  diverged and their merge base, as
 *                                                  GitHub reports them (404 for a
 *                                                  commit the host does not have)
 *   GET  /repos/{o}/{r}/git/commits|trees|blobs/*  real git object ids (blob
 *                                                  SHA-1 over "blob <n>\0")
 *   POST /repos/{o}/{r}/pulls/{n}/reviews          stores a pending review, or a
 *                                                  COMMENTED one for event COMMENT
 *   GET  /repos/{o}/{r}/pulls/{n}/reviews          review list
 *   GET  /repos/{o}/{r}/pulls/{n}/reviews/{id}/comments
 *                                                  pending comments: like the
 *                                                  live probe, line/side null;
 *                                                  submitted: with REST anchors
 *   POST /graphql                                  reviewThreads with the
 *                                                  original anchors
 * and the branches, pull requests and labels of companion suggestion pull
 * requests (fake-http-companion.mts), and the labeled listing, pull request
 * reads and closes and GraphQL cross-references that suggestion cleanup uses
 * (fake-http-cleanup.mts; pull requests are seeded with seedPulls). The pull
 * request under review is open and unmerged. The pull request reports its head
 * branch (`pull.headRef`, default `feature`), base branch and repositories;
 * the repository reports its default branch (default `main`, pointing at the
 * snapshot `defaultBranchCommit`, default the base commit, whose files include
 * any `.github/suggestion-prs.json`), the account's push permission (`push`,
 * default true) and its labels (`labels`, default `suggestion-pr`).
 * Like GitHub, it refuses a second pending review by one author on one pull
 * request with 422 (docs/native-suggestion-fidelity-experiment.md), and
 * refuses a submitted create the same way while a pending review exists.
 *
 * A host serves repository.json by default. `create(dir, config, repository)`
 * may give it a different repository of the same shape (for example one whose
 * commits are real local Git commits); it is stored in the host directory so a
 * child process attached to that directory serves the same repository.
 *
 * State (reviews, request log, behavior) lives in files under `dir`, written
 * atomically, so a CLI child process and the test share one host. The log
 * records method, path and whether the Authorization header carried exactly
 * the expected credential — never the credential itself.
 *
 * Behavior (config.json):
 *   create: 'ok' | 'lose-response'   lose-response stores the review, then
 *                                    fails the fetch as a network error
 *   shiftThreadLine: null | index    readback reports that comment one line
 *                                    lower than stored (an unfaithful host)
 *   onlyCredential?: string          answer 401 Bad credentials, as GitHub
 *                                    does, to any request whose Authorization
 *                                    is not exactly "Bearer <onlyCredential>"
 *                                    (independent of the credential the host
 *                                    object records, so a child process
 *                                    attached with another token is refused)
 *   failBlobReads?: boolean          answer 502 to every Git blob read (an
 *                                    operational source-read failure)
 *   failAncestryCompare?: number     answer this status to every comparison
 *                                    that is not the pull request's own
 *                                    base...head (an ancestry read that fails)
 *   failTreeReads?: boolean          answer 502 to every Git tree read (an
 *                                    operational failure of any source read
 *                                    or existence check)
 *   companion?: see fake-http-companion.mts
 *
 * Every document the host reads back (its repository, config, reviews, log
 * and the create-review request body) is checked against the shape it was
 * written with, so a malformed document fails loudly as a harness defect.
 *
 * This models documented and probed GitHub behavior; it is not evidence of
 * live GitHub behavior.
 *
 * @see https://docs.github.com/en/rest/pulls/reviews
 * @see https://docs.github.com/en/rest/git/trees
 * @see https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  expectType,
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
  isUnknown,
  parseJson,
  readJson,
} from '../../support/runtime-types.mts';
import type { Guard, UnknownRecord } from '../../support/runtime-types.mts';
import { cleanupRoute, timelineQuery } from './fake-http-cleanup.mts';
import {
  EMPTY_COMPANION_STATE,
  companionRoute,
  fileOnBranch,
  filesOnBranch,
  isCompanionConfig,
  isCompanionState,
} from './fake-http-companion.mts';
import type { ICompanionConfig, ICompanionHost, ICompanionRepository, ICompanionState, IStoredPull } from './fake-http-companion.mts';

/** A pull request by owner, repository and number. */
export interface IHttpDestination {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
}

/** One changed file of the pull request, as GET .../pulls/{n}/files returns it, with `patch` split into lines. */
export interface IHttpPullFile {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  /** The file's patch as lines with terminators kept; served joined. */
  readonly patch: readonly string[];
}

/** The repository a host serves (the shape of repository.json). */
export interface IHttpRepository {
  readonly description?: string | undefined;
  readonly destination: IHttpDestination;
  readonly commits: { readonly base: string; readonly head: string };
  /** File text by commit, then by path, split into lines (terminators kept). */
  readonly snapshots: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  /**
   * Files given as exact bytes (base64) by commit, then by path, with an
   * optional Git mode (default 100644): binary, non-UTF-8 or executable files.
   */
  readonly rawFiles?: Readonly<Record<string, Readonly<Record<string, IHttpRawFile>>>> | undefined;
  readonly pullFiles: readonly IHttpPullFile[];
  /** The pull request's branches and repositories (defaults: head `feature`, base `main`, same repository). */
  readonly pull?: IHttpPullBranches | undefined;
  /** The repository's default branch (default `main`). */
  readonly defaultBranch?: string | undefined;
  /** The snapshot commit the default branch points at (default: `commits.base`). */
  readonly defaultBranchCommit?: string | undefined;
  /** Whether the authenticated account may push (default true). */
  readonly push?: boolean | undefined;
  /** The repository's labels (default: `suggestion-pr`). */
  readonly labels?: readonly string[] | undefined;
  /**
   * Each snapshot commit's parents, for comparisons of any two commits
   * (issue #28: ancestry after a force-push). Without it, only the pull
   * request's own base...head comparison is served.
   */
  readonly parents?: Readonly<Record<string, readonly string[]>> | undefined;
  /** Hand-authored expectations for tests (repository.json only); the host does not read them. */
  readonly expected?: unknown;
}

/** The pull request's branches; `headRepo` null models a deleted fork. */
export interface IHttpPullBranches {
  readonly headRef?: string | undefined;
  readonly baseRef?: string | undefined;
  readonly headRepo?: string | null | undefined;
}

/** A file given as exact bytes. */
export interface IHttpRawFile {
  readonly base64: string;
  readonly mode?: string | undefined;
}

/** Host behavior (config.json). */
export interface IHttpHostConfig {
  readonly create: 'ok' | 'lose-response';
  readonly shiftThreadLine: number | null;
  readonly onlyCredential?: string | undefined;
  readonly failBlobReads?: boolean | undefined;
  readonly failTreeReads?: boolean | undefined;
  readonly failAncestryCompare?: number | undefined;
  readonly companion?: ICompanionConfig | undefined;
}

/** One inline comment of a create-review request body (GitHub's wire format). */
export interface IWireComment {
  readonly path: string;
  readonly body: string;
  readonly line: number;
  readonly side: string;
  readonly start_line?: number | undefined;
  readonly start_side?: string | undefined;
}

/** A create-review request body (GitHub's wire format). */
export interface IWireReviewRequest {
  readonly commit_id: string;
  readonly body: string;
  readonly event?: unknown;
  readonly comments: readonly IWireComment[];
}

/** A stored review: its id, the wire request that created it, its body and state. */
export interface IStoredHttpReview {
  readonly id: number;
  readonly request: IWireReviewRequest;
  readonly body: string;
  readonly state: string;
}

/** One received request: method, path and whether it carried exactly the expected credential. */
export interface IHttpLogEntry {
  readonly method: string;
  readonly path: string;
  readonly authorized: boolean;
}

/** The WHATWG fetch signature the host implements. */
export type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** One entry of a Git tree object. */
interface ITreeEntry {
  readonly mode: string;
  readonly type: 'tree' | 'blob';
  readonly sha: string;
  readonly size?: number;
}

/** Git objects for every snapshot (see buildObjects). */
interface IGitObjects {
  readonly commits: Record<string, string>;
  readonly trees: Record<string, ({ readonly path: string } & ITreeEntry)[]>;
  readonly blobs: Record<string, Buffer>;
}

/** The repository a host serves and its Git objects. */
interface IServed {
  readonly repository: IHttpRepository;
  readonly objects: IGitObjects;
}

const isHttpRepository: Guard<IHttpRepository> = isShape({
  description: isOptional(isString),
  destination: isShape({ owner: isString, repo: isString, pullNumber: isNumber }),
  commits: isShape({ base: isString, head: isString }),
  snapshots: isRecordOf(isRecordOf(isArrayOf(isString))),
  rawFiles: isOptional(isRecordOf(isRecordOf(isShape({ base64: isString, mode: isOptional(isString) })))),
  pullFiles: isArrayOf(
    isShape({ filename: isString, status: isString, additions: isNumber, deletions: isNumber, patch: isArrayOf(isString) }),
  ),
  pull: isOptional(isShape({ headRef: isOptional(isString), baseRef: isOptional(isString), headRepo: isOptional(isEither(isString, isNull)) })),
  defaultBranch: isOptional(isString),
  defaultBranchCommit: isOptional(isString),
  push: isOptional(isBoolean),
  labels: isOptional(isArrayOf(isString)),
  parents: isOptional(isRecordOf(isArrayOf(isString))),
  expected: isUnknown,
});

const isHostConfig: Guard<IHttpHostConfig> = isShape({
  create: isOneOf('ok', 'lose-response'),
  shiftThreadLine: isEither(isNumber, isNull),
  onlyCredential: isOptional(isString),
  failBlobReads: isOptional(isBoolean),
  failTreeReads: isOptional(isBoolean),
  failAncestryCompare: isOptional(isNumber),
  companion: isOptional(isCompanionConfig),
});

const isWireReviewRequest: Guard<IWireReviewRequest> = isShape({
  commit_id: isString,
  body: isString,
  event: isUnknown,
  comments: isArrayOf(
    isShape({
      path: isString,
      body: isString,
      line: isNumber,
      side: isString,
      start_line: isOptional(isNumber),
      start_side: isOptional(isString),
    }),
  ),
});

const isStoredHttpReview: Guard<IStoredHttpReview> = isShape({
  id: isNumber,
  request: isWireReviewRequest,
  body: isString,
  state: isString,
});

const isLogEntry: Guard<IHttpLogEntry> = isShape({ method: isString, path: isString, authorized: isBoolean });

export const REPOSITORY: IHttpRepository = expectType(
  readJson(path.join(import.meta.dirname, 'repository.json')),
  isHttpRepository,
  'the composition fixture repository',
);
const API = 'https://api.github.com';
export const USER: Readonly<{ id: number; login: string }> = Object.freeze({ id: 4242, login: 'review-bot' });

/** Git's blob object id: SHA-1 of "blob <size>\0" followed by the bytes. */
export function gitBlobSha(bytes: Buffer): string {
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${String(bytes.length)}\0`), bytes])).digest('hex');
}

/** A deterministic 40-hex id for a synthetic tree. */
function treeId(label: string): string {
  return crypto.createHash('sha1').update(`tree:${label}`).digest('hex');
}

/**
 * Git objects for every snapshot: commit -> root tree, tree -> entries,
 * blob id -> bytes. Directories become nested trees.
 */
function buildObjects(repository: IHttpRepository): IGitObjects {
  const commits: IGitObjects['commits'] = {};
  const trees: IGitObjects['trees'] = {};
  const blobs: IGitObjects['blobs'] = {};
  const commitIds = new Set([...Object.keys(repository.snapshots), ...Object.keys(repository.rawFiles ?? {})]);
  for (const commit of commitIds) {
    const files: [string, Buffer, string][] = [
      ...Object.entries(repository.snapshots[commit] ?? {}).map(([p, lines]): [string, Buffer, string] => [p, Buffer.from(lines.join(''), 'utf8'), '100644']),
      ...Object.entries(repository.rawFiles?.[commit] ?? {}).map(([p, raw]): [string, Buffer, string] => [p, Buffer.from(raw.base64, 'base64'), raw.mode ?? '100644']),
    ];
    const dirs = new Map<string, Map<string, ITreeEntry>>([['', new Map()]]);
    /** The entries of a directory already recorded in `dirs`. */
    const entriesOf = (dir: string): Map<string, ITreeEntry> => {
      const entries = dirs.get(dir);
      if (!entries) throw new Error(`fake host: directory ${dir} was not recorded`);
      return entries;
    };
    for (const [filePath, bytes, mode] of files) {
      const sha = gitBlobSha(bytes);
      blobs[sha] = bytes;
      const parts = filePath.split('/');
      let dir = '';
      for (const part of parts.slice(0, -1)) {
        const child = dir ? `${dir}/${part}` : part;
        if (!dirs.has(child)) {
          dirs.set(child, new Map());
          entriesOf(dir).set(part, { mode: '040000', type: 'tree', sha: treeId(`${commit}:${child}`) });
        }
        dir = child;
      }
      const name = parts[parts.length - 1];
      if (name === undefined) throw new Error(`fake host: empty path in snapshot ${commit}`);
      entriesOf(dir).set(name, { mode, type: 'blob', sha, size: bytes.length });
    }
    for (const [dir, entries] of dirs) {
      trees[treeId(`${commit}:${dir}`)] = [...entries].map(([name, e]) => ({ path: name, ...e }));
    }
    commits[commit] = treeId(`${commit}:`);
  }
  return { commits, trees, blobs };
}

/** The text of a request body; the real client always sends a string. */
function bodyText(init: RequestInit): string {
  if (typeof init.body !== 'string') throw new TypeError('fake host: expected a string request body');
  return init.body;
}

/** The first capture group of a route match (every route pattern has one). */
function captured(match: RegExpExecArray): string {
  const group = match[1];
  if (group === undefined) throw new Error('fake host: route pattern without a capture group');
  return group;
}

export class FakeHttpGitHub {
  /** Creates a host rooted at a fresh directory, serving `repository` (default repository.json). */
  static create(dir: string, config: Partial<IHttpHostConfig> = {}, repository: IHttpRepository | null = null): FakeHttpGitHub {
    fs.mkdirSync(dir, { recursive: true });
    const host = new FakeHttpGitHub(dir);
    if (repository !== null) host.write('repository.json', repository);
    host.write('config.json', { create: 'ok', shiftThreadLine: null, ...config });
    host.write('reviews.json', []);
    host.write('log.json', []);
    host.write('companion.json', EMPTY_COMPANION_STATE);
    return host;
  }

  readonly dir: string;
  readonly expectedToken: string | null;
  /** The WHATWG fetch the real client is constructed with (bound: it may be passed around alone). */
  readonly fetch: FakeFetch;
  private cached: IServed | undefined;

  /** Attaches to an existing host directory (e.g. from a child process). */
  constructor(dir: string, expectedToken: string | null = null) {
    this.dir = dir;
    this.expectedToken = expectedToken;
    this.fetch = this.receive.bind(this);
  }

  read(name: string): unknown {
    return readJson(path.join(this.dir, name));
  }

  /** The repository this host serves, and its Git objects (computed once per host object). */
  served(): IServed {
    if (!this.cached) {
      const own = path.join(this.dir, 'repository.json');
      const repository = fs.existsSync(own)
        ? expectType(this.read('repository.json'), isHttpRepository, `the repository in ${own}`)
        : REPOSITORY;
      this.cached = { repository, objects: buildObjects(repository) };
    }
    return this.cached;
  }

  write(name: string, value: unknown): void {
    const tmp = path.join(this.dir, `.${name}.${String(process.pid)}.${crypto.randomUUID()}`);
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, path.join(this.dir, name));
  }

  config(): IHttpHostConfig {
    return expectType(this.read('config.json'), isHostConfig, `the host config in ${this.dir}`);
  }

  setConfig(patch: Partial<IHttpHostConfig>): void {
    this.write('config.json', { ...this.config(), ...patch });
  }

  /** Stored reviews: { id, request (the wire body), body, state }. */
  reviews(): IStoredHttpReview[] {
    return expectType(this.read('reviews.json'), isArrayOf(isStoredHttpReview), `the stored reviews in ${this.dir}`);
  }

  /** Every request received: { method, path, authorized }. */
  log(): IHttpLogEntry[] {
    return expectType(this.read('log.json'), isArrayOf(isLogEntry), `the request log in ${this.dir}`);
  }

  /** Handles one fetch call (exposed as the bound `fetch`). A Request input is read by its URL. */
  // eslint-disable-next-line @typescript-eslint/require-await -- fetch is async by contract: a failure, including a synchronous throw, reaches the client as a rejection
  async receive(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const u = new URL(input instanceof Request ? input.url : input);
    const method = init.method || 'GET';
    const auth = new Headers(init.headers).get('authorization');
    const authorized = this.expectedToken === null ? auth !== null : auth === `Bearer ${this.expectedToken}`;
    this.write('log.json', [...this.log(), { method, path: u.pathname, authorized }]);
    if (u.origin !== API) throw new Error(`fake host: unexpected origin ${u.origin}`);
    const onlyCredential = this.config().onlyCredential;
    if (onlyCredential !== undefined && auth !== `Bearer ${onlyCredential}`) {
      return new Response(JSON.stringify({ message: 'Bad credentials', status: '401' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    return this.route(method, u, init);
  }

  route(method: string, u: URL, init: RequestInit): Response {
    const { repository, objects } = this.served();
    const { owner, repo, pullNumber } = repository.destination;
    const { base, head } = repository.commits;
    const repoPath = `/repos/${owner}/${repo}`;
    const pull = `${repoPath}/pulls/${String(pullNumber)}`;
    const p = u.pathname;
    const json = (body: unknown, status = 200, headers: Readonly<Record<string, string>> = {}): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    let m: RegExpExecArray | null;

    if (method === 'GET' && p === '/user') return json(USER);
    // A test may seed a stored pull request under this number (for example the
    // original, once merged, for cleanup); the stored one is then served.
    if (method === 'GET' && p === pull && !this.companion().pulls.some((pr) => pr.number === pullNumber)) {
      const branches = repository.pull ?? {};
      const fullName = `${owner}/${repo}`;
      const headRepo = branches.headRepo === undefined ? fullName : branches.headRepo;
      return json({
        number: pullNumber,
        html_url: `https://github.com/${fullName}/pull/${String(pullNumber)}`,
        state: 'open',
        merged: false,
        body: null,
        labels: [],
        head: { sha: head, ref: branches.headRef ?? 'feature', repo: headRepo === null ? null : { full_name: headRepo } },
        base: { sha: base, ref: branches.baseRef ?? 'main', repo: { full_name: fullName } },
        changed_files: repository.pullFiles.length,
      });
    }
    if (method === 'GET' && p === `${pull}/files`) {
      return json(repository.pullFiles.map((f) => ({ ...f, patch: f.patch.join('') })));
    }
    if (method === 'GET' && p === `${repoPath}/compare/${base}...${head}` && repository.parents === undefined) {
      return json({ status: 'ahead', merge_base_commit: { sha: base } });
    }
    if (method === 'GET' && (m = new RegExp(`^${repoPath}/compare/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})$`).exec(p))) {
      const failure = this.config().failAncestryCompare;
      if (failure !== undefined && captured(m) !== base) return json({ message: 'Not Found' }, failure);
      return this.compare(captured(m), m[2] ?? '', json);
    }
    if (method === 'GET' && (m = new RegExp(`^${repoPath}/git/commits/([0-9a-f]{40})$`).exec(p))) {
      const sha = captured(m);
      const tree = objects.commits[sha];
      if (tree) return json({ sha, tree: { sha: tree } });
      const created = this.companion().commits[sha];
      return created
        ? json({ sha, tree: { sha: created.tree }, parents: created.parents.map((s) => ({ sha: s })), message: created.message })
        : json({ message: 'Not Found' }, 404);
    }
    if (method === 'GET' && (m = new RegExp(`^${repoPath}/git/trees/([0-9a-f]{40})$`).exec(p))) {
      if (this.config().failTreeReads === true) return json({ message: 'Server Error' }, 502);
      const sha = captured(m);
      const tree = objects.trees[sha] ?? this.companion().trees[sha];
      return tree ? json({ sha, truncated: false, tree }) : json({ message: 'Not Found' }, 404);
    }
    if (method === 'GET' && (m = new RegExp(`^${repoPath}/git/blobs/([0-9a-f]{40})$`).exec(p))) {
      if (this.config().failBlobReads === true) return json({ message: 'Server Error' }, 502);
      const sha = captured(m);
      const createdBlob = this.companion().blobs[sha];
      const bytes = objects.blobs[sha] ?? (createdBlob === undefined ? undefined : Buffer.from(createdBlob, 'base64'));
      if (!bytes) return json({ message: 'Not Found' }, 404);
      return json({ sha, encoding: 'base64', content: bytes.toString('base64'), size: bytes.length });
    }
    if (method === 'POST' && p === `${pull}/reviews`) {
      const request = expectType(parseJson(bodyText(init)), isWireReviewRequest, 'a create-review request body');
      return this.createReview(request, json);
    }
    if (method === 'GET' && p === `${pull}/reviews`) {
      return json(
        this.reviews().map((r) => ({
          id: r.id,
          html_url: `https://github.com/${owner}/${repo}/pull/${String(pullNumber)}#pullrequestreview-${String(r.id)}`,
          user: USER,
          commit_id: r.request.commit_id,
          state: r.state,
          body: r.body,
        })),
      );
    }
    if (method === 'GET' && (m = new RegExp(`^${pull}/reviews/(\\d+)/comments$`).exec(p))) {
      const reviewId = Number(captured(m));
      const review = this.reviews().find((r) => r.id === reviewId);
      if (!review) return json({ message: 'Not Found' }, 404);
      return json(
        review.request.comments.map((c, i) => ({
          id: review.id * 100 + i,
          pull_request_review_id: review.id,
          path: c.path,
          body: c.body,
          original_commit_id: review.request.commit_id,
          // Pending comments read back without an anchor (as probed live);
          // a submitted review's comments carry their REST anchor.
          ...(review.state === 'PENDING'
            ? { line: null, side: null }
            : {
                line: c.line,
                side: c.side,
                original_line: c.line,
                ...(c.start_line === undefined ? {} : { start_line: c.start_line, original_start_line: c.start_line, start_side: c.start_side }),
              }),
        })),
      );
    }
    if (method === 'POST' && p === '/graphql') {
      const query = parseJson(bodyText(init));
      return timelineQuery(this.companionHost(), query, json) ?? this.reviewThreads(query, json);
    }
    const cleanup = cleanupRoute(this.companionHost(), method, u, () => bodyText(init), json);
    if (cleanup) return cleanup;
    const companion = companionRoute(this.companionHost(), method, u, () => bodyText(init), json);
    if (companion) return companion;
    return json({ message: `fake host: no route for ${method} ${p}` }, 404);
  }

  /** Everything the companion routes have stored (companion.json). */
  companion(): ICompanionState {
    return expectType(this.read('companion.json'), isCompanionState, `the companion state in ${this.dir}`);
  }

  /** Created suggestion pull requests, in creation order. */
  pulls(): readonly IStoredPull[] {
    return this.companion().pulls;
  }

  /** The repository facts companion routes answer with. */
  companionRepository(): ICompanionRepository {
    const { repository, objects } = this.served();
    return {
      owner: repository.destination.owner,
      repo: repository.destination.repo,
      defaultBranch: repository.defaultBranch ?? 'main',
      defaultBranchCommit: repository.defaultBranchCommit ?? repository.commits.base,
      headRef: repository.pull?.headRef ?? 'feature',
      push: repository.push ?? true,
      labels: repository.labels ?? ['suggestion-pr'],
      snapshotCommits: objects.commits,
      snapshotTrees: objects.trees,
      snapshotBlobs: objects.blobs,
    };
  }

  /** The exact bytes of a file on a branch, or null when the branch's commit has no such file. */
  fileOnBranch(branch: string, filePath: string): Buffer | null {
    return fileOnBranch(this.companionRepository(), this.companion(), branch, filePath);
  }

  /** Every file on a branch: path -> mode. */
  filesOnBranch(branch: string): Map<string, string> {
    return filesOnBranch(this.companionRepository(), this.companion(), branch);
  }

  /** A person moves (sha) or deletes (null) a branch. */
  setRef(branch: string, sha: string | null): void {
    const state = this.companion();
    const refs = Object.fromEntries(Object.entries(state.refs).filter(([name]) => name !== branch));
    this.write('companion.json', { ...state, refs: sha === null ? refs : { ...refs, [branch]: sha } });
  }

  /**
   * The author force-pushes or pushes: from now on the host serves `repository`
   * (for example the same pull request at another head). A child process
   * attached to this host directory reads it too.
   */
  replaceRepository(repository: IHttpRepository): void {
    this.write('repository.json', repository);
    this.cached = undefined;
  }

  /**
   * GitHub's three-dot comparison of two snapshot commits through the
   * repository's `parents`: identical, ahead (a is an ancestor of b), behind
   * (b is an ancestor of a) or diverged, with their nearest common ancestor.
   */
  compare(a: string, b: string, json: (body: unknown, status?: number) => Response): Response {
    const { repository, objects } = this.served();
    const parents = repository.parents ?? {};
    if (objects.commits[a] === undefined || objects.commits[b] === undefined) return json({ message: 'Not Found' }, 404);
    /** Every commit reachable from `start`, itself included, nearest first. */
    const ancestry = (start: string): string[] => {
      const order: string[] = [];
      const queue = [start];
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (order.includes(next)) continue;
        order.push(next);
        queue.push(...(parents[next] ?? []));
      }
      return order;
    };
    const ofA = ancestry(a);
    const ofB = ancestry(b);
    const mergeBase = ofB.find((c) => ofA.includes(c));
    const status = a === b ? 'identical' : ofB.includes(a) ? 'ahead' : ofA.includes(b) ? 'behind' : 'diverged';
    return json({
      status,
      ahead_by: ofB.filter((c) => !ofA.includes(c)).length,
      behind_by: ofA.filter((c) => !ofB.includes(c)).length,
      ...(mergeBase === undefined ? {} : { merge_base_commit: { sha: mergeBase } }),
    });
  }

  /** Adds pull requests (originals, suggestions, ordinary pull requests or issues) as if people had opened them. */
  seedPulls(pulls: readonly IStoredPull[]): void {
    const state = this.companion();
    this.write('companion.json', { ...state, pulls: [...state.pulls, ...pulls] });
  }

  /** A person edits, closes or merges a suggestion pull request. */
  editPull(number: number, change: Partial<Pick<IStoredPull, 'title' | 'body' | 'state' | 'merged' | 'head' | 'headRepo' | 'labels'>>): void {
    const state = this.companion();
    if (!state.pulls.some((pr) => pr.number === number)) throw new Error(`fake host: no pull request ${String(number)}`);
    this.write('companion.json', { ...state, pulls: state.pulls.map((pr) => (pr.number === number ? { ...pr, ...change } : pr)) });
  }

  /** A person removes a label from a suggestion pull request. */
  removeLabel(number: number, name: string): void {
    const state = this.companion();
    this.write('companion.json', {
      ...state,
      pulls: state.pulls.map((pr) => (pr.number === number ? { ...pr, labels: pr.labels.filter((l) => l !== name) } : pr)),
    });
  }

  /** Delayed visibility: the next N reads of branches, pull request listings or labels see nothing new. */
  hide(counts: Partial<ICompanionState['hidden']>): void {
    const state = this.companion();
    this.write('companion.json', { ...state, hidden: { ...state.hidden, ...counts } });
  }

  /** The host facade the companion routes use. */
  private companionHost(): ICompanionHost {
    return {
      user: USER,
      config: () => this.config().companion ?? {},
      state: () => this.companion(),
      save: (state) => {
        this.write('companion.json', state);
      },
      repository: () => this.companionRepository(),
    };
  }

  createReview(request: IWireReviewRequest, json: (body: unknown, status?: number) => Response): Response {
    const config = this.config();
    const reviews = this.reviews();
    if (reviews.some((r) => r.state === 'PENDING')) {
      return json({ message: 'Unprocessable Entity', errors: ['User can only have one pending review per pull request'] }, 422);
    }
    const id = 5000 + reviews.length;
    const { owner, repo, pullNumber } = this.served().repository.destination;
    this.write('reviews.json', [...reviews, { id, request, body: request.body, state: request.event ? 'COMMENTED' : 'PENDING' }]);
    if (config.create === 'lose-response') throw new TypeError('fetch failed: socket hang up');
    return json({ id, html_url: `https://github.com/${owner}/${repo}/pull/${String(pullNumber)}#pullrequestreview-${String(id)}` });
  }

  reviewThreads(query: unknown, json: (body: unknown, status?: number) => Response): Response {
    const { owner, repo, pullNumber } = this.served().repository.destination;
    const vars: UnknownRecord = isRecord(query) && isRecord(query['variables']) ? query['variables'] : {};
    if (vars['owner'] !== owner || vars['repo'] !== repo || vars['number'] !== pullNumber) {
      return json({ errors: [{ type: 'NOT_FOUND', message: 'no such pull request' }] });
    }
    const shift = this.config().shiftThreadLine;
    const nodes = this.reviews().flatMap((r) =>
      r.request.comments.map((c, i) => ({
        path: c.path,
        subjectType: 'LINE',
        diffSide: c.side,
        startDiffSide: c.start_side ?? null,
        originalLine: shift === i ? c.line + 1 : c.line,
        originalStartLine: c.start_line ?? null,
        comments: {
          nodes: [{ databaseId: r.id * 100 + i, pullRequestReview: { databaseId: r.id }, originalCommit: { oid: r.request.commit_id } }],
        },
      })),
    );
    return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } });
  }
}
