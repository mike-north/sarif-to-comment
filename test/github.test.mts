/**
 * Contract tests for the GitHub host adapter (src/github.cts).
 *
 * The adapter is exercised only through an injected WHATWG `fetch`, so every
 * test observes the raw HTTP it would send — URL, method, headers, redirect
 * mode, body — and answers with raw `Response` objects shaped like GitHub's
 * documented responses. No higher-level mock bypasses the adapter's own
 * request building, pagination, decoding or normalization.
 *
 * Expected requests and results are hand-authored in test/fixtures/github.
 * The only values the harness derives are transport encodings of authored
 * file text: base64 with GitHub's 60-character line wrapping, and the git blob
 * SHA-1 ("blob <size>\0" + bytes) computed with node:crypto, independently of
 * the adapter.
 *
 * Out of scope here: whether GitHub itself behaves as these documented shapes
 * describe (Link forms, pending-review field nullness, GraphQL thread
 * semantics). Those are real-host facts requiring live evidence.
 *
 * @see https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api
 * @see https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
 * @see https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files
 * @see https://docs.github.com/en/rest/commits/commits#compare-two-commits
 * @see https://docs.github.com/en/rest/repos/contents#get-repository-content
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/reviews#list-comments-for-a-pull-request-review
 * @see https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread
 * @see https://git-scm.com/book/en/v2/Git-Internals-Git-Objects (blob object hashing)
 */

import { AssertionError } from 'node:assert';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as util from 'node:util';

import { createGitHubClient, GitHubError } from '../dist/github.cjs';
import type {
  ICreateGitHubClientOptions,
  IFetchContextRequest,
  IFetchedContext,
  IGitHubClient,
  IReviewCommentDraft,
  IReviewCommentPage,
} from '../dist/github.cjs';
import {
  asRecord,
  asString,
  expectType,
  isArray,
  isArrayOf,
  isBoolean,
  isEither,
  isNull,
  isNumber,
  isOneOf,
  isOptional,
  isRecord,
  isShape,
  isString,
  parseJson,
  readJson,
} from './support/runtime-types.mts';
import type { Guard } from './support/runtime-types.mts';

// ---------------------------------------------------------------------------
// Fixture shapes (checked when loaded; tests change clones of the documents)
// ---------------------------------------------------------------------------

/** The type a guard narrows to. */
type Guarded<G> = G extends Guard<infer T> ? T : never;

/** Returns `value`, or fails naming `what` was missing (an absent element, map entry or optional member). */
function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new AssertionError({ message: `expected ${what}, got undefined`, operator: 'defined' });
  return value;
}

/** The element at `index`, which must exist. */
function at<T>(list: readonly T[], index: number, what: string): T {
  return defined(list[index], `${what}[${String(index)}]`);
}

const isNullableString = isEither(isString, isNull);
const isNullableNumber = isEither(isNumber, isNull);
const isReviewSide = isOneOf('LEFT', 'RIGHT');

const isContentsEntry = isShape({
  commit: isString,
  path: isString,
  url: isString,
  text: isOptional(isString),
  bytesHex: isOptional(isString),
  absent: isOptional(isBoolean),
  mode: isOptional(isString),
});
type ContentsEntry = Guarded<typeof isContentsEntry>;

const isPullFile = isShape({
  filename: isString,
  status: isString,
  additions: isNumber,
  deletions: isNumber,
  patch: isOptional(isString),
  previous_filename: isOptional(isString),
});
type PullFile = Guarded<typeof isPullFile>;

const isFilesPage = isShape({ url: isString, link: isOptional(isNullableString), body: isArrayOf(isPullFile) });
type FilesPage = Guarded<typeof isFilesPage>;

const isSpecialEntry = isShape({
  commit: isString,
  path: isString,
  mode: isString,
  target: isOptional(isString),
  text: isOptional(isString),
  submoduleCommit: isOptional(isString),
  contents: isShape({
    requestedPath: isString,
    url: isString,
    servesFileOf: isOptional(isString),
    notFound: isOptional(isBoolean),
  }),
});

const isPullRequestFixture = isShape({
  destination: isShape({ owner: isString, repo: isString, pullNumber: isNumber }),
  commits: isShape({
    head: isString,
    mergeBase: isString,
    advancedBaseTip: isString,
    racedHead: isString,
    historical: isString,
  }),
  pullUrl: isString,
  pull: isRecord,
  filesPages: isArrayOf(isFilesPage),
  compareUrl: isString,
  compare: isRecord,
  advancedCompareUrl: isString,
  expectedContext: isRecord,
  contents: isArrayOf(isContentsEntry),
  specialEntries: isShape({ entries: isArrayOf(isSpecialEntry) }),
});

const isCommentDraftShape = isShape({
  path: isString,
  side: isReviewSide,
  line: isNumber,
  startSide: isOptional(isReviewSide),
  startLine: isOptional(isNumber),
  body: isString,
});

/** A create-review comment: the draft shape, with its optional members absent rather than undefined. */
function isReviewCommentDraft(value: unknown): value is IReviewCommentDraft {
  return isCommentDraftShape(value) && Object.values(value).every((member) => member !== undefined);
}

const isCreateReviewRequest = isShape({
  owner: isString,
  repo: isString,
  pullNumber: isNumber,
  commitId: isString,
  body: isString,
  comments: isArrayOf(isReviewCommentDraft),
});

const isThreadNode = isShape({
  path: isString,
  subjectType: isString,
  diffSide: isNullableString,
  startDiffSide: isNullableString,
  startLine: isNullableNumber,
  originalLine: isNullableNumber,
  originalStartLine: isNullableNumber,
  comments: isShape({
    nodes: isArrayOf(isShape({ databaseId: isNumber, originalCommit: isShape({ oid: isString }) })),
  }),
});
type ThreadNode = Guarded<typeof isThreadNode>;
type ThreadComment = ThreadNode['comments']['nodes'][number];

const isReviewThreads = isShape({
  pageInfo: isShape({ hasNextPage: isBoolean, endCursor: isNullableString }),
  nodes: isArrayOf(isThreadNode),
});
type ReviewThreads = Guarded<typeof isReviewThreads>;

const isGraphqlPage = isShape({
  after: isNullableString,
  response: isShape({
    data: isEither(isNull, isShape({ repository: isShape({ pullRequest: isShape({ reviewThreads: isReviewThreads }) }) })),
    errors: isOptional(isArray),
  }),
});
type GraphqlPage = Guarded<typeof isGraphqlPage>;

const isRestComment = isShape({
  id: isNumber,
  pull_request_review_id: isNumber,
  line: isOptional(isNullableNumber),
  side: isOptional(isNullableString),
  original_line: isOptional(isNullableNumber),
});
type RestComment = Guarded<typeof isRestComment>;

const isReviewCommentsFixture = isShape({
  reviewId: isNumber,
  restPages: isArrayOf(isShape({ url: isString, link: isOptional(isNullableString), body: isArrayOf(isRestComment) })),
  graphqlUrl: isString,
  graphqlPages: isArrayOf(isGraphqlPage),
  expected: isArray,
});
type ReviewCommentsFixture = Guarded<typeof isReviewCommentsFixture>;

const isReviewsPage = isShape({ url: isString, link: isOptional(isNullableString), body: isArray, expected: isArray });
type ReviewsPage = Guarded<typeof isReviewsPage>;

const isReviewsFixture = isShape({
  user: isShape({ url: isString, body: isRecord, expected: isRecord }),
  createReview: isShape({
    url: isString,
    request: isCreateReviewRequest,
    expectedPostBody: isRecord,
    response: isRecord,
    expected: isRecord,
  }),
  reviewPages: isArrayOf(isReviewsPage),
  reviewComments: isReviewCommentsFixture,
});

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'github');
const load = (name: string): unknown => readJson(path.join(FIXTURE_DIR, name));
const PR = expectType(load('pull-request.json'), isPullRequestFixture, 'the pull-request fixture');
const RV = expectType(load('reviews.json'), isReviewsFixture, 'the reviews fixture');

/** Placeholder credential; every test that can leak it asserts that it does not. */
const TOKEN = 'ghp_TESTONLY_github_adapter_token_never_log_91c2';
const API = 'https://api.github.com';
const { head: HEAD, mergeBase: MERGE_BASE, advancedBaseTip: ADVANCED, racedHead: RACED, historical: HISTORICAL } =
  PR.commits;
const DESTINATION = PR.destination;

// ---------------------------------------------------------------------------
// Raw HTTP double
// ---------------------------------------------------------------------------

/** Marks a request no route answered; the adapter must never issue one. */
class UnroutedRequest extends Error {}

function jsonResponse(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** One request as the adapter sent it. */
interface IRecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
  readonly redirect: RequestInit['redirect'];
  unrouted?: boolean;
}

/** Answers one routed request (or throws, as a failing fetch does). */
type Responder = (request: IRecordedRequest) => Response;

/** A route: method, exact URL, optional request predicate and its queue of responders. */
interface IRoute {
  readonly method: string;
  readonly url: string;
  readonly when: ((request: IRecordedRequest) => boolean) | undefined;
  readonly queue: Responder[];
}

/** The WHATWG fetch signature the host implements. */
type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A request body as text; the adapter only ever sends JSON strings. */
function bodyText(body: RequestInit['body']): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'string') throw new TypeError('fake host: the request body is not a string');
  return body;
}

/**
 * A routing table standing in for api.github.com. Each route matches method
 * and exact URL (and optionally a predicate on the request) and answers with
 * one response per call, in order. Every request is recorded as the adapter
 * sent it.
 */
class FakeHost {
  routes: IRoute[];
  readonly requests: IRecordedRequest[];
  /** The fetch the client is constructed with (bound: it is passed around alone). */
  readonly fetch: FakeFetch;
  /** Each snapshot of a pull scenario by commit (see pullScenario). */
  git: Record<string, ISnapshot>;

  constructor() {
    this.routes = [];
    this.requests = [];
    this.git = {};
    this.fetch = this.receive.bind(this);
  }

  /** Adds a route answered by `responders` in order (a function or a list of them). */
  on(method: string, url: string, responders: Responder | readonly Responder[], when?: (request: IRecordedRequest) => boolean): this {
    this.routes.push({ method, url, when, queue: typeof responders === 'function' ? [responders] : [...responders] });
    return this;
  }

  /** Handles one fetch call (exposed as the bound `fetch`). */
  // eslint-disable-next-line @typescript-eslint/require-await -- fetch is async by contract: a failure, including a synchronous throw, reaches the client as a rejection
  async receive(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const request: IRecordedRequest = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers: new Headers(init.headers),
      body: bodyText(init.body),
      redirect: init.redirect,
    };
    this.requests.push(request);
    const route = this.routes.find(
      (r) => r.method === request.method && r.url === request.url && r.queue.length > 0 && (!r.when || r.when(request)),
    );
    if (!route) {
      request.unrouted = true;
      throw new UnroutedRequest(`unrouted ${request.method} ${request.url}`);
    }
    const respond = defined(route.queue.length > 1 ? route.queue.shift() : route.queue[0], 'a queued responder');
    return respond(request);
  }

  urls(): string[] {
    return this.requests.map((r) => r.url);
  }
}

/** The JSON body of a recorded request. */
function requestJson(request: IRecordedRequest): unknown {
  return parseJson(defined(request.body, `a body on ${request.method} ${request.url}`));
}

/** The JSON body of a recorded GraphQL request: a query document and its variables. */
function graphqlBody(request: IRecordedRequest): { query: string; variables: Record<string, unknown> } {
  return expectType(requestJson(request), isShape({ query: isString, variables: isRecord }), 'a GraphQL request body');
}

/**
 * Invariants of every exchange: nothing unrouted, only the API origin, manual
 * redirects, the bearer token on every request, documented REST headers, and
 * no write except the single review creation and GraphQL queries.
 */
function assertHttpDiscipline(host: FakeHost): void {
  for (const r of host.requests) {
    assert.ok(!r.unrouted, `adapter issued an unexpected request: ${r.method} ${r.url}`);
    assert.ok(!new URL(r.url).pathname.includes('/contents/'), `the dereferencing Contents API is never trusted: ${r.url}`);
    assert.equal(new URL(r.url).origin, API, `request left the API origin: ${r.url}`);
    assert.ok(r.redirect === 'manual' || r.redirect === 'error', `redirects must not be followed (${r.url})`);
    assert.equal(r.headers.get('authorization'), `Bearer ${TOKEN}`);
    const isGraphql = r.url === `${API}/graphql`;
    if (!isGraphql) {
      assert.equal(r.headers.get('accept'), 'application/vnd.github+json');
      assert.equal(r.headers.get('x-github-api-version'), '2022-11-28');
    }
    if (r.method === 'POST') {
      assert.equal(r.headers.get('content-type')?.split(';')[0], 'application/json');
      if (isGraphql) {
        const { query } = graphqlBody(r);
        assert.doesNotMatch(query, /\bmutation\b/, 'GraphQL requests are read-only queries');
      } else {
        assert.match(r.url, /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/);
      }
    } else {
      assert.equal(r.method, 'GET');
    }
  }
}

function client(host: FakeHost, extra: Partial<ICreateGitHubClientOptions> = {}): IGitHubClient {
  return createGitHubClient({ token: TOKEN, fetch: host.fetch, ...extra });
}

/** Deep, hidden-property rendering used to prove a value carries no token. */
function assertNoToken(value: unknown, label: string): void {
  const rendered = [
    util.inspect(value, { depth: 20, showHidden: true, getters: true }),
    value instanceof Error ? String(value.stack) : '',
  ].join('\n');
  assert.ok(!rendered.includes(TOKEN), `${label} exposes the token`);
}

/** `value && value[key]` over an unknown thrown value (a primitive has no name or message). */
function memberOf(value: unknown, key: string): unknown {
  if (!value) return value;
  return typeof value === 'object' || typeof value === 'function' ? Reflect.get(value, key) : undefined;
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<GitHubError> {
  const err = await promise.then(
    () => assert.fail(`expected GitHubError ${code}`),
    (e: unknown) => e,
  );
  assert.ok(err instanceof GitHubError, `expected GitHubError, got ${String(memberOf(err, 'name'))}: ${String(memberOf(err, 'message'))}`);
  assert.equal(err.code, code, err.message);
  for (const [key, value] of Object.entries(extra)) {
    const actual: unknown = Reflect.get(err, key);
    assert.equal(actual, value, key);
  }
  assertNoToken(err, `error ${code}`);
  return err;
}

/** The redacted cause description a GitHubError carries: an Error that may have a `code`. */
function causeOf(err: GitHubError): Error & { readonly code?: unknown } {
  const { cause } = err;
  if (!(cause instanceof Error)) {
    throw new AssertionError({ message: `expected an Error cause, got ${String(cause)}`, operator: 'causeOf' });
  }
  return cause;
}

// ---------------------------------------------------------------------------
// Pull-request scenario routes
// ---------------------------------------------------------------------------

/** Git object id: SHA-1 of "<type> <size>\0" followed by the object bytes. */
function gitObjectSha(type: string, bytes: Buffer): string {
  return crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from(`${type} ${String(bytes.length)}\0`, 'utf8'), bytes]))
    .digest('hex');
}

/** Git blob object id of raw bytes. */
function blobSha(bytes: Buffer): string {
  return gitObjectSha('blob', bytes);
}

/** Authored file text (or raw bytes as hex) and the path it is served under. */
interface ISourceEntry {
  readonly path: string;
  readonly text?: string | undefined;
  readonly bytesHex?: string | undefined;
}

/** The authored text of an entry, which must exist and have text. */
function textOf(entry: ISourceEntry | undefined, what: string): string {
  return defined(defined(entry, what).text, `the text of ${what}`);
}

function entryBytes(entry: ISourceEntry): Buffer {
  return entry.bytesHex !== undefined ? Buffer.from(entry.bytesHex, 'hex') : Buffer.from(textOf(entry, entry.path), 'utf8');
}

const REPO_API = `${API}/repos/acme/widgets`;
const commitUrl = (sha: string): string => `${REPO_API}/git/commits/${sha}`;
const treeUrl = (sha: string): string => `${REPO_API}/git/trees/${sha}`;
const blobUrl = (sha: string): string => `${REPO_API}/git/blobs/${sha}`;

/** One raw tree entry of a snapshot: a submodule's commit (mode 160000) or file bytes. */
interface ITreeEntrySpec {
  readonly path: string;
  readonly mode: string;
  readonly commitSha?: string;
  readonly bytes?: Buffer;
}

/** Every raw tree entry authored for one commit, minus `omit`ted paths. */
function authoredEntries(commit: string, omit: readonly string[] = []): ITreeEntrySpec[] {
  const entries: ITreeEntrySpec[] = [];
  for (const c of PR.contents) {
    if (c.commit === commit && !c.absent && !omit.includes(c.path)) {
      entries.push({ path: c.path, mode: c.mode ?? '100644', bytes: entryBytes(c) });
    }
  }
  for (const s of PR.specialEntries.entries) {
    if (s.commit !== commit || omit.includes(s.path)) continue;
    entries.push(
      s.mode === '160000'
        ? { path: s.path, mode: s.mode, commitSha: defined(s.submoduleCommit, `the submodule commit of ${s.path}`) }
        : { path: s.path, mode: s.mode, bytes: Buffer.from(defined(s.target ?? s.text, `the target or text of ${s.path}`), 'utf8') },
    );
  }
  return entries;
}

/** One entry of a GitHub non-recursive tree listing. */
interface ITreeItem {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number | undefined;
  url?: string;
}

/** A GitHub git tree API body. */
interface ITreeBody {
  sha: string;
  url: string;
  truncated: boolean;
  tree: ITreeItem[];
}

/** A directory's tree id and the listing GitHub serves for it. */
interface ITreeRecord {
  readonly sha: string;
  readonly body: ITreeBody;
}

/** The Git objects of one snapshot (see buildSnapshot). */
interface ISnapshot {
  readonly rootSha: string;
  readonly trees: Map<string, ITreeRecord>;
  readonly blobs: Map<string, Buffer>;
  readonly files: Map<string, string>;
}

interface IDirectory {
  readonly dirs: Map<string, IDirectory>;
  readonly leaves: Map<string, ITreeEntrySpec>;
}

interface IListingEntry {
  readonly name: string;
  readonly gitMode: string;
  readonly mode: string;
  readonly type: 'tree' | 'commit' | 'blob';
  readonly sha: string;
  readonly size?: number;
}

/**
 * The Git objects of one snapshot: each directory as GitHub's non-recursive
 * tree listing (trees report mode "040000"), keyed by directory path, with a
 * real Git tree id; every blob by id; and each file's blob id by path.
 */
function buildSnapshot(entries: readonly ITreeEntrySpec[]): ISnapshot {
  const newDir = (): IDirectory => ({ dirs: new Map(), leaves: new Map() });
  const root = newDir();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      if (!dir.dirs.has(part)) dir.dirs.set(part, newDir());
      dir = defined(dir.dirs.get(part), `the directory ${part}`);
    }
    dir.leaves.set(defined(parts.at(-1), `a name in ${entry.path}`), entry);
  }
  const trees = new Map<string, ITreeRecord>();
  const blobs = new Map<string, Buffer>();
  const files = new Map<string, string>();
  const build = (dir: IDirectory, dirPath: string): string => {
    const listing: IListingEntry[] = [];
    for (const [name, sub] of dir.dirs) {
      const sha = build(sub, dirPath ? `${dirPath}/${name}` : name);
      listing.push({ name, gitMode: '40000', mode: '040000', type: 'tree', sha });
    }
    for (const [name, entry] of dir.leaves) {
      if (entry.mode === '160000') {
        listing.push({ name, gitMode: '160000', mode: '160000', type: 'commit', sha: defined(entry.commitSha, `the commit of ${entry.path}`) });
      } else {
        const bytes = defined(entry.bytes, `the bytes of ${entry.path}`);
        const sha = blobSha(bytes);
        blobs.set(sha, bytes);
        files.set(entry.path, sha);
        listing.push({ name, gitMode: entry.mode, mode: entry.mode, type: 'blob', sha, size: bytes.length });
      }
    }
    // Git orders tree entries bytewise by name, comparing subtrees as "name/".
    const key = (x: IListingEntry): Buffer => Buffer.from(x.type === 'tree' ? `${x.name}/` : x.name, 'utf8');
    listing.sort((a, b) => Buffer.compare(key(a), key(b)));
    const serialized = Buffer.concat(
      listing.map((x) => Buffer.concat([Buffer.from(`${x.gitMode} ${x.name}\0`, 'utf8'), Buffer.from(x.sha, 'hex')])),
    );
    const sha = gitObjectSha('tree', serialized);
    trees.set(dirPath, {
      sha,
      body: {
        sha,
        url: treeUrl(sha),
        truncated: false,
        tree: listing.map((x) => ({
          path: x.name,
          mode: x.mode,
          type: x.type,
          sha: x.sha,
          ...(x.type === 'blob' ? { size: x.size, url: blobUrl(x.sha) } : {}),
          ...(x.type === 'tree' ? { url: treeUrl(x.sha) } : {}),
        })),
      },
    });
    return sha;
  };
  return { rootSha: build(root, ''), trees, blobs, files };
}

/** A git blob API body as GitHub encodes it (base64 wrapped at 60 columns). */
function blobBody(sha: string, bytes: Buffer, overrides: { readonly size?: number } = {}): Record<string, unknown> & { content: string } {
  return {
    sha,
    node_id: `B_${sha.slice(0, 12)}`,
    size: bytes.length,
    url: blobUrl(sha),
    content: bytes.toString('base64').replace(/.{1,60}/g, (line) => `${line}\n`),
    encoding: 'base64',
    ...overrides,
  };
}

/** Replaces every route for `url` with a single responder. */
function replaceRoute(host: FakeHost, url: string, responder: Responder): void {
  host.routes = host.routes.filter((r) => r.url !== url);
  host.on('GET', url, responder);
}

/** A contents-API file body as GitHub encodes it (base64 wrapped at 60 columns). */
function contentsBody(entry: ISourceEntry, overrides: { readonly name?: string; readonly path?: string } = {}): Record<string, unknown> {
  const bytes = entryBytes(entry);
  return {
    type: 'file',
    encoding: 'base64',
    size: bytes.length,
    name: path.posix.basename(entry.path),
    path: entry.path,
    sha: blobSha(bytes),
    content: bytes.toString('base64').replace(/.{1,60}/g, (line) => `${line}\n`),
    ...overrides,
  };
}

const NOT_FOUND = { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' };

function contentsEntry(commit: string, filePath: string): ContentsEntry;
function contentsEntry(commit: string, filePath: string, optional: true): ContentsEntry | undefined;
function contentsEntry(commit: string, filePath: string, optional = false): ContentsEntry | undefined {
  const entry = PR.contents.find((c) => c.commit === commit && c.path === filePath);
  if (optional) return entry;
  assert.ok(entry, `fixture has no contents for ${filePath} at ${commit}`);
  return entry;
}

function routeContents(host: FakeHost, entry: ContentsEntry, override?: Responder): void {
  const responder = override ?? (() => (entry.absent ? jsonResponse(404, NOT_FOUND) : jsonResponse(200, contentsBody(entry))));
  host.on('GET', entry.url, responder);
}

/** Changes to the pull-request exchange (see pullScenario); `request` is the fetchContext request `prepared` sends. */
interface IPullScenarioOptions {
  readonly pull?: Readonly<Record<string, unknown>>;
  readonly secondPull?: Readonly<Record<string, unknown>>;
  readonly filesPages?: readonly FilesPage[];
  readonly compareUrl?: string;
  readonly compare?: unknown;
  readonly omit?: Readonly<Record<string, readonly string[]>>;
  readonly request?: Partial<IFetchContextRequest>;
}

/**
 * Registers the pull-request exchange with optional changes:
 *   pull / secondPull: body overrides for the first and second pull reads;
 *   filesPages: replacement page list; compareUrl / compare: compare exchange;
 *   omit: { [commit]: paths } removed from that commit's tree.
 * Source is served as Git objects (host.git[commit] exposes each snapshot),
 * and the Contents API is served with GitHub's documented dereferencing of
 * symlinks, so that trusting it is an observable defect.
 */
function pullScenario({
  pull = {},
  secondPull,
  filesPages = PR.filesPages,
  compareUrl = PR.compareUrl,
  compare = PR.compare,
  omit = {},
}: IPullScenarioOptions = {}): FakeHost {
  const host = new FakeHost();
  const first = structuredClone({ ...PR.pull, ...pull });
  const second = structuredClone({ ...first, ...(secondPull ?? {}) });
  host.on('GET', PR.pullUrl, [() => jsonResponse(200, first), () => jsonResponse(200, second)]);
  for (const page of filesPages) {
    host.on('GET', page.url, () => jsonResponse(200, page.body, page.link ? { link: page.link } : {}));
  }
  host.on('GET', compareUrl, () => jsonResponse(200, compare));
  host.git = {};
  for (const commit of [HEAD, MERGE_BASE, ADVANCED, HISTORICAL]) {
    const snapshot = buildSnapshot(authoredEntries(commit, omit[commit] ?? []));
    host.git[commit] = snapshot;
    host.on('GET', commitUrl(commit), () =>
      jsonResponse(200, {
        sha: commit,
        node_id: `C_${commit.slice(0, 12)}`,
        url: commitUrl(commit),
        message: 'fixture snapshot',
        tree: { sha: snapshot.rootSha, url: treeUrl(snapshot.rootSha) },
        parents: [],
      }),
    );
    for (const tree of snapshot.trees.values()) host.on('GET', treeUrl(tree.sha), () => jsonResponse(200, structuredClone(tree.body)));
    for (const [sha, bytes] of snapshot.blobs) host.on('GET', blobUrl(sha), () => jsonResponse(200, blobBody(sha, bytes)));
  }
  for (const entry of PR.contents) routeContents(host, entry);
  for (const special of PR.specialEntries.entries) {
    const answer = special.contents;
    host.on('GET', answer.url, () => {
      if (answer.notFound) return jsonResponse(404, NOT_FOUND);
      const served = answer.servesFileOf === undefined ? undefined : contentsEntry(special.commit, answer.servesFileOf, true);
      const target = served ?? {
        path: special.path,
        text: special.text,
      };
      return jsonResponse(200, contentsBody(target, { name: path.posix.basename(answer.requestedPath), path: answer.requestedPath }));
    });
  }
  return host;
}

/** The scenario's snapshot at a commit. */
function snapshotOf(host: FakeHost, commit: string): ISnapshot {
  return defined(host.git[commit], `a snapshot at ${commit}`);
}

/** The blob id of an authored file at a commit, from the scenario's snapshot. */
function fileBlob(host: FakeHost, commit: string, filePath: string): string {
  const sha = snapshotOf(host, commit).files.get(filePath);
  assert.ok(sha, `snapshot has no ${filePath} at ${commit}`);
  return sha;
}

/** The scenario's tree listing for a directory at a commit. */
function treeAt(host: FakeHost, commit: string, dirPath: string): ITreeRecord {
  const tree = snapshotOf(host, commit).trees.get(dirPath);
  assert.ok(tree, `snapshot has no directory ${dirPath || '(root)'} at ${commit}`);
  return tree;
}

function withFilePatch(filename: string, change: (file: PullFile) => void): FilesPage[] {
  const pages = structuredClone(PR.filesPages);
  for (const page of pages) {
    for (const file of page.body) if (file.filename === filename) change(file);
  }
  return pages;
}

/** The authored patch of a listed file, which must have one. */
function patchOf(file: PullFile): string {
  return defined(file.patch, `a patch of ${file.filename}`);
}

async function contextFor(host: FakeHost, request: Partial<IFetchContextRequest> = {}): Promise<IFetchedContext> {
  return client(host).fetchContext({ destination: DESTINATION, reviewedCommit: HEAD, ...request });
}

// ---------------------------------------------------------------------------
// Review readback routes
// ---------------------------------------------------------------------------

function reviewCommentsScenario(change: (fixture: ReviewCommentsFixture) => unknown = () => {}): FakeHost {
  const fixture = structuredClone(RV.reviewComments);
  change(fixture);
  const host = new FakeHost();
  for (const page of fixture.restPages) {
    host.on('GET', page.url, () => jsonResponse(200, page.body, page.link ? { link: page.link } : {}));
  }
  for (const page of fixture.graphqlPages) {
    host.on('POST', fixture.graphqlUrl, () => jsonResponse(200, page.response), (req) => {
      const { variables } = graphqlBody(req);
      return variables['after'] === page.after;
    });
  }
  return host;
}

/** A GraphQL page of a readback fixture. */
function graphqlPage(fixture: ReviewCommentsFixture, pageIndex: number): GraphqlPage {
  return at(fixture.graphqlPages, pageIndex, 'graphqlPages');
}

/** The reviewThreads connection of a GraphQL page, which must carry data. */
function reviewThreadsOf(page: GraphqlPage): ReviewThreads {
  const { data } = page.response;
  if (data === null) {
    throw new AssertionError({ message: 'expected a GraphQL page with data, got data: null', operator: 'reviewThreadsOf' });
  }
  return data.repository.pullRequest.reviewThreads;
}

function threadNodes(fixture: ReviewCommentsFixture, pageIndex: number): ThreadNode[] {
  return reviewThreadsOf(graphqlPage(fixture, pageIndex)).nodes;
}

/** The first comment of a thread: its root. */
function rootOf(node: ThreadNode): ThreadComment {
  return at(node.comments.nodes, 0, `the comments of a thread on ${node.path}`);
}

function threadOf(fixture: ReviewCommentsFixture, databaseId: number): ThreadNode {
  for (const page of fixture.graphqlPages) {
    for (const node of reviewThreadsOf(page).nodes) {
      if (rootOf(node).databaseId === databaseId) return node;
    }
  }
  throw new Error(`no thread rooted at ${String(databaseId)}`);
}

function restCommentOf(fixture: ReviewCommentsFixture, id: number): RestComment {
  for (const page of fixture.restPages) for (const c of page.body) if (c.id === id) return c;
  throw new Error(`no REST comment ${String(id)}`);
}

async function readComments(host: FakeHost): Promise<IReviewCommentPage> {
  return client(host).listReviewComments({ ...DESTINATION, reviewId: RV.reviewComments.reviewId, cursor: null });
}

// ---------------------------------------------------------------------------
// Fixture and harness integrity (no adapter involved)
// ---------------------------------------------------------------------------

describe('fixture integrity', () => {
  test('blob hashing matches git for a known object', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    assert.equal(blobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  });

  test('every authored contents URL pins its full commit and stays on the API origin', () => {
    for (const entry of PR.contents) {
      const url = new URL(entry.url);
      assert.equal(url.origin, API);
      assert.equal(url.searchParams.get('ref'), entry.commit);
      assert.match(entry.commit, /^[0-9a-f]{40}$/);
    }
  });

  test('authored patches agree line-by-line with authored head and base texts', () => {
    for (const page of PR.filesPages) {
      for (const file of page.body) {
        if (!file.patch || file.previous_filename) continue;
        const head = PR.contents.find((c) => c.commit === HEAD && c.path === file.filename);
        const base = PR.contents.find((c) => c.commit === MERGE_BASE && c.path === file.filename);
        for (const line of file.patch.split('\n')) {
          if (line.startsWith('+')) assert.ok(textOf(head, `${file.filename} at the head`).includes(line.slice(1)), `${file.filename}: ${line}`);
          if (line.startsWith('-')) assert.ok(textOf(base, `${file.filename} at the base`).includes(line.slice(1)), `${file.filename}: ${line}`);
        }
        const plus = file.patch.split('\n').filter((l) => l.startsWith('+')).length;
        const minus = file.patch.split('\n').filter((l) => l.startsWith('-')).length;
        assert.deepEqual([plus, minus], [file.additions, file.deletions], file.filename);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Construction and credential handling
// ---------------------------------------------------------------------------

describe('client construction', () => {
  test('refuses any API origin other than https://api.github.com', () => {
    const host = new FakeHost();
    for (const apiOrigin of ['http://api.github.com', 'https://github.example.com/api/v3', 'https://api.github.com.evil.example']) {
      // @ts-expect-error -- deliberately invalid: proves runtime validation of the API origin (only https://api.github.com is typed or accepted)
      assert.throws(() => createGitHubClient({ token: TOKEN, fetch: host.fetch, apiOrigin }), TypeError, apiOrigin);
    }
    assert.equal(host.requests.length, 0);
  });

  test('requires a token; fetch defaults to the global implementation but must be a function', () => {
    const host = new FakeHost();
    // @ts-expect-error -- deliberately invalid: proves runtime validation of a missing token
    assert.throws(() => createGitHubClient({ fetch: host.fetch }), TypeError);
    assert.throws(() => createGitHubClient({ token: '', fetch: host.fetch }), TypeError);
    // @ts-expect-error -- deliberately invalid: proves runtime validation that fetch is a function
    assert.throws(() => createGitHubClient({ token: TOKEN, fetch: 'https://api.github.com' }), TypeError);
    assert.equal(typeof createGitHubClient({ token: TOKEN }).getAuthenticatedUser, 'function');
  });

  test('the client exposes exactly the transport methods and fetchContext', () => {
    const c = client(new FakeHost());
    assert.deepEqual(Object.keys(c).sort(), [
      'createReview',
      'fetchContext',
      'getAuthenticatedUser',
      'listReviewComments',
      'listReviews',
    ]);
  });

  test('the client object never exposes the token, even to deep inspection', () => {
    const c = client(new FakeHost());
    assertNoToken(c, 'client');
    assert.ok(!JSON.stringify(c).includes(TOKEN));
    for (const key of Reflect.ownKeys(c)) {
      const value: unknown = Reflect.get(c, key);
      if (typeof value === 'string') assert.notEqual(value, TOKEN, String(key));
    }
  });

  test('nothing is written to the console, including on failures', async () => {
    const captured: unknown[][] = [];
    const names = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original methods are only kept to be restored verbatim, never called detached
    const saved = names.map((n) => console[n]);
    names.forEach((n) => (console[n] = (...args: unknown[]) => captured.push(args)));
    try {
      const host = new FakeHost()
        .on('GET', RV.user.url, () => jsonResponse(401, { message: 'Bad credentials' }))
        .on('POST', RV.createReview.url, () => jsonResponse(500, { message: 'Server Error' }));
      const c = client(host);
      await c.getAuthenticatedUser().catch(() => {});
      await c.createReview(structuredClone(RV.createReview.request)).catch(() => {});
    } finally {
      names.forEach((n, i) => (console[n] = at(saved, i, 'saved console methods')));
    }
    assert.deepEqual(captured, []);
  });
});

// ---------------------------------------------------------------------------
// Authenticated user and generic HTTP failures
// ---------------------------------------------------------------------------

describe('getAuthenticatedUser', () => {
  test('one GET /user with documented headers yields the numeric id and login', async () => {
    const host = new FakeHost().on('GET', RV.user.url, () => jsonResponse(200, RV.user.body));
    assert.deepEqual(await client(host).getAuthenticatedUser(), RV.user.expected);
    assert.deepEqual(host.urls(), [RV.user.url]);
    assertHttpDiscipline(host);
  });

  test('a token without user identity (e.g. an installation token) is an HTTP failure, not a user', async () => {
    const host = new FakeHost().on('GET', RV.user.url, () =>
      jsonResponse(403, { message: 'Resource not accessible by integration' }),
    );
    await rejectsWith(client(host).getAuthenticatedUser(), 'http-status', { status: 403, hostRejected: false });
    assertHttpDiscipline(host);
  });

  test('a user body without a numeric id is malformed', async () => {
    const host = new FakeHost().on('GET', RV.user.url, () => jsonResponse(200, { login: 'reviewer-bot', id: '7001001' }));
    await rejectsWith(client(host).getAuthenticatedUser(), 'malformed-response');
  });

  test('a redirect is refused, not followed, and credentials go nowhere else', async () => {
    const host = new FakeHost().on('GET', RV.user.url, () =>
      new Response(null, { status: 301, headers: { location: 'https://evil.example/user' } }),
    );
    await rejectsWith(client(host).getAuthenticatedUser(), 'redirect');
    assert.deepEqual(host.urls(), [RV.user.url]);
    assertHttpDiscipline(host);
  });

  test('a network failure keeps a redacted description of its cause', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const host = new FakeHost().on('GET', RV.user.url, () => {
      throw reset;
    });
    const err = await rejectsWith(client(host).getAuthenticatedUser(), 'network', { hostRejected: false });
    assert.equal(causeOf(err).message, 'socket hang up');
    assert.equal(causeOf(err).code, 'ECONNRESET');
  });

  test('a hostile fetch error echoing credentials cannot leak them through the public error', async () => {
    const inner = Object.assign(new Error(`upstream said Authorization: Bearer ${TOKEN}`), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const hostile = Object.assign(new Error(`request failed with token ${TOKEN}`, { cause: inner }), {
      code: 'EHOSTILE',
      config: { token: TOKEN, headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const host = new FakeHost().on('GET', RV.user.url, () => {
      throw hostile;
    });
    await rejectsWith(client(host).getAuthenticatedUser(), 'network');
  });

  test('a response body echoing credentials cannot leak them through the public error', async () => {
    const host = new FakeHost().on('GET', RV.user.url, () =>
      jsonResponse(500, { message: `internal error for Bearer ${TOKEN}` }),
    );
    await rejectsWith(client(host).getAuthenticatedUser(), 'http-status', { status: 500 });
  });
});

// ---------------------------------------------------------------------------
// Single create-review request
// ---------------------------------------------------------------------------

describe('createReview', () => {
  const { url, request, expectedPostBody, response, expected } = RV.createReview;

  test('sends exactly one POST with body and every comment, no event, bodies byte-exact', async () => {
    const host = new FakeHost().on('POST', url, () => jsonResponse(200, response));
    assert.deepEqual(await client(host).createReview(structuredClone(request)), expected);
    assert.equal(host.requests.length, 1);
    const sent = asRecord(requestJson(at(host.requests, 0, 'requests')), 'the create-review request body');
    assert.deepEqual(sent, expectedPostBody);
    assert.ok(!Object.hasOwn(sent, 'event'), 'a pending draft carries no event');
    assertHttpDiscipline(host);
  });

  test('a 422 refusal is definitive, sent once, and keeps the host explanation', async () => {
    // Observed on the real host: a second pending review by the same author on
    // one pull request is refused with 422 (docs/native-suggestion-fidelity-experiment.md).
    const host = new FakeHost().on('POST', url, () =>
      jsonResponse(422, {
        message: 'Unprocessable Entity',
        errors: ['User can only have one pending review per pull request'],
      }),
    );
    const err = await rejectsWith(client(host).createReview(structuredClone(request)), 'http-status', {
      status: 422,
      hostRejected: true,
    });
    assert.match(err.message, /one pending review per pull request/);
    assert.equal(host.requests.length, 1);
  });

  for (const status of [400, 401, 403, 404, 409, 429]) {
    test(`an understood ${String(status)} refusal is definitive and sent once`, async () => {
      const host = new FakeHost().on('POST', url, () => jsonResponse(status, { message: 'refused' }));
      await rejectsWith(client(host).createReview(structuredClone(request)), 'http-status', {
        status,
        hostRejected: true,
      });
      assert.equal(host.requests.length, 1);
    });
  }

  for (const status of [408, 499, 500, 502, 503, 504]) {
    test(`a ${String(status)} answer is indeterminate and never retried`, async () => {
      const host = new FakeHost().on('POST', url, () => jsonResponse(status, { message: 'no verdict' }));
      await rejectsWith(client(host).createReview(structuredClone(request)), 'http-status', {
        status,
        hostRejected: false,
      });
      assert.equal(host.requests.length, 1);
    });
  }

  test('a refusal echoing credentials does not leak them', async () => {
    const host = new FakeHost().on('POST', url, () =>
      jsonResponse(422, { message: `Validation failed for Bearer ${TOKEN}`, errors: [TOKEN] }),
    );
    await rejectsWith(client(host).createReview(structuredClone(request)), 'http-status', { hostRejected: true });
  });

  test('a network failure is indeterminate and never retried', async () => {
    const host = new FakeHost().on('POST', url, () => {
      throw new TypeError('fetch failed');
    });
    await rejectsWith(client(host).createReview(structuredClone(request)), 'network', { hostRejected: false });
    assert.equal(host.requests.length, 1);
  });

  test('a redirect is indeterminate and not followed', async () => {
    const host = new FakeHost().on('POST', url, () =>
      new Response(null, { status: 307, headers: { location: `${API}/repositories/123456/pulls/42/reviews` } }),
    );
    await rejectsWith(client(host).createReview(structuredClone(request)), 'redirect', { hostRejected: false });
    assert.equal(host.requests.length, 1);
  });

  test('a success without a review identity is indeterminate', async () => {
    const host = new FakeHost().on('POST', url, () => jsonResponse(200, { state: 'PENDING' }));
    await rejectsWith(client(host).createReview(structuredClone(request)), 'malformed-response', {
      hostRejected: false,
    });
    assert.equal(host.requests.length, 1);
  });

  test('a request carrying a submission event or unknown comment fields is refused before sending', async () => {
    const host = new FakeHost();
    // @ts-expect-error -- deliberately invalid: proves runtime refusal of a submission event on a create-review request
    await assert.rejects(client(host).createReview({ ...structuredClone(request), event: 'COMMENT' }), TypeError);
    const withPosition = structuredClone(request);
    // @ts-expect-error -- deliberately invalid: proves runtime refusal of an unknown comment field (position)
    at(withPosition.comments, 0, 'comments').position = 5;
    await assert.rejects(client(host).createReview(withPosition), TypeError);
    assert.equal(host.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Review listing
// ---------------------------------------------------------------------------

describe('listReviews', () => {
  function reviewsHost(pages: readonly ReviewsPage[] = RV.reviewPages): FakeHost {
    const host = new FakeHost();
    for (const page of pages) host.on('GET', page.url, () => jsonResponse(200, page.body, page.link ? { link: page.link } : {}));
    return host;
  }

  test('follows a validated Link (including the /repositories/{id} form) one page per call', async () => {
    const host = reviewsHost();
    const c = client(host);
    const first = await c.listReviews({ ...DESTINATION, cursor: null });
    assert.deepEqual(first.reviews, at(RV.reviewPages, 0, 'reviewPages').expected);
    assert.equal(typeof first.nextCursor, 'string');
    assert.ok(asString(first.nextCursor, 'a next-page cursor').length > 0);
    const second = await c.listReviews({ ...DESTINATION, cursor: first.nextCursor });
    assert.deepEqual(second, { reviews: at(RV.reviewPages, 1, 'reviewPages').expected, nextCursor: null });
    assert.deepEqual(host.urls(), RV.reviewPages.map((p) => p.url));
    assertHttpDiscipline(host);
  });

  for (const [label, link, code] of [
    ['another origin', '<https://evil.example/repos/acme/widgets/pulls/42/reviews?per_page=100&page=2>; rel="next"', 'unsafe-link'],
    ['another endpoint', `<${API}/repos/acme/widgets/pulls/43/reviews?per_page=100&page=2>; rel="next"`, 'unsafe-link'],
    ['a skipped page', `<${API}/repos/acme/widgets/pulls/42/reviews?per_page=100&page=3>; rel="next"`, 'pagination'],
    [
      'embedded credentials',
      '<https://someone:secret@api.github.com/repos/acme/widgets/pulls/42/reviews?per_page=100&page=2>; rel="next"',
      'unsafe-link',
    ],
    [
      'an extra query credential',
      `<${API}/repos/acme/widgets/pulls/42/reviews?per_page=100&page=2&access_token=abc>; rel="next"`,
      'unsafe-link',
    ],
  ] as const) {
    test(`a next link to ${label} is refused without being fetched`, async () => {
      const pages = structuredClone(RV.reviewPages);
      at(pages, 0, 'reviewPages').link = link;
      const host = reviewsHost(pages);
      await rejectsWith(client(host).listReviews({ ...DESTINATION, cursor: null }), code);
      assert.deepEqual(host.urls(), [at(RV.reviewPages, 0, 'reviewPages').url]);
      assertHttpDiscipline(host);
    });
  }

  test('a cursor the adapter did not issue is refused before any request', async () => {
    const host = reviewsHost();
    await assert.rejects(
      client(host).listReviews({ ...DESTINATION, cursor: 'https://evil.example/repos/acme/widgets/pulls/42/reviews?page=2' }),
      TypeError,
    );
    assert.equal(host.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Pending-review comment readback
// ---------------------------------------------------------------------------

describe('listReviewComments', () => {
  test('recovers original anchors from GraphQL threads when REST anchors are null or absent', async () => {
    const host = reviewCommentsScenario();
    assert.deepEqual(await readComments(host), { comments: RV.reviewComments.expected, nextCursor: null });
    const restUrls = RV.reviewComments.restPages.map((p) => p.url);
    assert.deepEqual(
      host.urls().filter((u) => u !== RV.reviewComments.graphqlUrl),
      restUrls,
      'every REST page, canonical URLs',
    );
    const graphql = host.requests.filter((r) => r.url === RV.reviewComments.graphqlUrl);
    assert.deepEqual(
      graphql.map((r) => graphqlBody(r).variables),
      [
        { owner: 'acme', repo: 'widgets', number: 42, after: null },
        { owner: 'acme', repo: 'widgets', number: 42, after: 'Y3Vyc29yOjM=' },
      ],
    );
    for (const r of graphql) {
      const { query } = graphqlBody(r);
      for (const field of [
        'reviewThreads',
        'pageInfo',
        'hasNextPage',
        'endCursor',
        'path',
        'subjectType',
        'diffSide',
        'startDiffSide',
        'originalLine',
        'originalStartLine',
        'databaseId',
        'pullRequestReview',
        'originalCommit',
      ]) {
        assert.match(query, new RegExp(`\\b${field}\\b`), `query selects ${field}`);
      }
    }
    assertHttpDiscipline(host);
  });

  test('duplicate identical comments keep their cardinality', async () => {
    const { comments } = await readComments(reviewCommentsScenario());
    assert.equal(comments.filter((c) => c.body === 'Same text.').length, 2);
  });

  test('a body-only review reads back as no comments without needing any thread of its own', async () => {
    const fixture = RV.reviewComments;
    const host = new FakeHost().on(
      'GET',
      'https://api.github.com/repos/acme/widgets/pulls/42/reviews/9002/comments?per_page=100&page=1',
      () => jsonResponse(200, []),
    );
    for (const page of fixture.graphqlPages) {
      host.on('POST', fixture.graphqlUrl, () => jsonResponse(200, page.response), (req) => {
        return graphqlBody(req).variables['after'] === page.after;
      });
    }
    assert.deepEqual(await client(host).listReviewComments({ ...DESTINATION, reviewId: 9002, cursor: null }), {
      comments: [],
      nextCursor: null,
    });
    assertHttpDiscipline(host);
  });

  test("another review's threads never fail this review, however they are shaped", async () => {
    const host = reviewCommentsScenario((f) => {
      Object.assign(threadOf(f, 555), { originalLine: null, subjectType: 'FILE', diffSide: null });
      threadNodes(f, 1).push(structuredClone(threadOf(f, 555)));
    });
    assert.deepEqual((await readComments(host)).comments, RV.reviewComments.expected);
  });

  test('multi-line anchors use the original start line, not the current one', async () => {
    const multi = threadOf(RV.reviewComments, 105);
    assert.notEqual(multi.startLine, multi.originalStartLine, 'fixture shifts the current start');
    const { comments } = await readComments(reviewCommentsScenario());
    assert.deepEqual(comments.at(-1), { path: 'src/app.js', side: 'RIGHT', line: 13, startSide: 'RIGHT', startLine: 9, body: 'Multi-line.' });
  });

  test('non-null REST anchor fields that agree with the thread are accepted', async () => {
    const host = reviewCommentsScenario((f) => {
      Object.assign(restCommentOf(f, 102), { line: 11, side: 'LEFT', original_line: 11 });
    });
    assert.deepEqual((await readComments(host)).comments, RV.reviewComments.expected);
  });

  const failures: readonly (readonly [string, string, (f: ReviewCommentsFixture) => unknown])[] = [
    ['a REST comment with no thread', 'anchor-unavailable', (f) => threadNodes(f, 1).splice(0, 1)],
    ['two threads rooted at one comment', 'anchor-ambiguous', (f) => threadNodes(f, 1).push(structuredClone(threadOf(f, 101)))],
    [
      'a thread of this review whose root REST does not list',
      'anchor-ambiguous',
      (f) => {
        const extra = structuredClone(threadOf(f, 103));
        rootOf(extra).databaseId = 106;
        threadNodes(f, 1).push(extra);
      },
    ],
    ['a thread without an original line', 'anchor-malformed', (f) => (threadOf(f, 103).originalLine = null)],
    ['a thread with an unknown side', 'anchor-malformed', (f) => (threadOf(f, 103).diffSide = 'MIDDLE')],
    [
      'a start line without a start side',
      'anchor-malformed',
      (f) => Object.assign(threadOf(f, 101), { originalStartLine: 4, startDiffSide: null }),
    ],
    ['a file-level thread', 'anchor-malformed', (f) => (threadOf(f, 102).subjectType = 'FILE')],
    ['a REST original line that disagrees', 'anchor-ambiguous', (f) => (restCommentOf(f, 101).original_line = 7)],
    ['a REST side that disagrees', 'anchor-ambiguous', (f) => (restCommentOf(f, 101).side = 'LEFT')],
    ['a thread on another path', 'anchor-ambiguous', (f) => (threadOf(f, 102).path = 'src/other.js')],
    [
      'a thread from another original commit',
      'anchor-ambiguous',
      (f) => (rootOf(threadOf(f, 102)).originalCommit.oid = MERGE_BASE),
    ],
    ['a REST comment from another review', 'malformed-response', (f) => (restCommentOf(f, 103).pull_request_review_id = 8000)],
    [
      'GraphQL errors',
      'graphql-errors',
      (f) => (graphqlPage(f, 1).response = { data: null, errors: [{ type: 'RATE_LIMITED', message: 'rate limited' }] }),
    ],
    [
      'a next page without a cursor',
      'pagination',
      (f) => (reviewThreadsOf(graphqlPage(f, 0)).pageInfo.endCursor = null),
    ],
    [
      'a repeated cursor',
      'pagination',
      (f) =>
        (reviewThreadsOf(graphqlPage(f, 1)).pageInfo = {
          hasNextPage: true,
          endCursor: 'Y3Vyc29yOjM=',
        }),
    ],
    [
      'a REST next link to another origin',
      'unsafe-link',
      (f) => (at(f.restPages, 0, 'restPages').link = '<https://evil.example/repos/acme/widgets/pulls/42/reviews/9001/comments?per_page=100&page=2>; rel="next"'),
    ],
  ];
  for (const [label, code, change] of failures) {
    test(`fails closed on ${label}`, async () => {
      const host = reviewCommentsScenario(change);
      await rejectsWith(readComments(host), code);
      assertHttpDiscipline(host);
    });
  }

  test('a continuation cursor is refused: readback is always one complete enumeration', async () => {
    const host = reviewCommentsScenario();
    await assert.rejects(
      // @ts-expect-error -- deliberately invalid: proves runtime refusal of a continuation cursor (readback accepts only null)
      client(host).listReviewComments({ ...DESTINATION, reviewId: 9001, cursor: '2' }),
      TypeError,
    );
    assert.equal(host.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Review context
// ---------------------------------------------------------------------------

describe('fetchContext', () => {
  test('pins the head, reads every files page, rereads the head, and takes a merge-base candidate', async () => {
    const host = pullScenario();
    const { context, readSource } = await contextFor(host);
    assert.deepEqual(context, PR.expectedContext);
    assert.equal(typeof readSource, 'function');
    assert.deepEqual(host.urls(), [PR.pullUrl, ...PR.filesPages.map((p) => p.url), PR.pullUrl, PR.compareUrl]);
    assertHttpDiscipline(host);
  });

  test('a head that moves between the two pull reads is a race, not a context', async () => {
    const host = pullScenario({ secondPull: { head: { sha: RACED, ref: 'feature/limits' } } });
    await rejectsWith(contextFor(host), 'head-race');
  });

  test('a historical reviewed commit keeps the actual current pull diff and its candidate', async () => {
    const host = pullScenario();
    const { context } = await contextFor(host, { reviewedCommit: HISTORICAL });
    assert.deepEqual(context, { ...PR.expectedContext, reviewedCommit: HISTORICAL });
    assert.deepEqual(host.urls(), [PR.pullUrl, ...PR.filesPages.map((p) => p.url), PR.pullUrl, PR.compareUrl]);
  });

  test('an explicit old-source commit is the candidate and replaces the compare request', async () => {
    const host = pullScenario();
    const { context } = await contextFor(host, { oldSourceCommit: MERGE_BASE });
    assert.equal(context.diff.baseCommit, MERGE_BASE);
    assert.ok(!host.urls().includes(PR.compareUrl));
  });

  test('an advanced base tip is reported but never used as old-side provenance', async () => {
    const host = pullScenario({ pull: { base: { sha: ADVANCED, ref: 'main' } }, compareUrl: PR.advancedCompareUrl });
    const { context, readSource } = await contextFor(host);
    assert.equal(context.currentBaseTip, ADVANCED);
    assert.equal(context.diff.baseCommit, MERGE_BASE);
    assert.equal(await readSource(MERGE_BASE, 'src/app.js'), contentsEntry(MERGE_BASE, 'src/app.js').text);
    assert.ok(!host.urls().includes(commitUrl(ADVANCED)), 'no source read at the advanced tip');
    assertHttpDiscipline(host);
  });

  test('a listed file count that disagrees with changed_files is incomplete', async () => {
    await rejectsWith(contextFor(pullScenario({ pull: { changed_files: 8 } })), 'files-incomplete');
  });

  test('more files than the host can list is incomplete, never truncated', async () => {
    await rejectsWith(contextFor(pullScenario({ pull: { changed_files: 3001 } })), 'files-incomplete');
  });

  test('a filename listed twice is refused', async () => {
    const pages = structuredClone(PR.filesPages);
    at(pages, 1, 'filesPages').body.push(structuredClone(at(at(pages, 0, 'filesPages').body, 0, 'the first page body')));
    await rejectsWith(contextFor(pullScenario({ pull: { changed_files: 8 }, filesPages: pages })), 'duplicate-file');
  });

  test('a files next link to another origin is refused without being fetched', async () => {
    const pages = structuredClone(PR.filesPages);
    at(pages, 0, 'filesPages').link = '<https://evil.example/repos/acme/widgets/pulls/42/files?per_page=100&page=2>; rel="next"';
    const host = pullScenario({ filesPages: pages });
    await rejectsWith(contextFor(host), 'unsafe-link');
    assertHttpDiscipline(host);
  });

  test('a patch whose counts disagree with the entry is treated as truncated and dropped', async () => {
    const pages = withFilePatch('src/app.js', (file) => {
      file.patch = patchOf(file).slice(0, patchOf(file).indexOf('\n@@ -8,7'));
    });
    const { context } = await contextFor(pullScenario({ filesPages: pages }));
    assert.deepEqual(context.diff.files[0], { path: 'src/app.js' });
    assert.deepEqual(context.fileDiagnostics, [
      { path: 'src/app.js', reason: 'patch-inconsistent' },
      { path: 'assets/logo.png', reason: 'patch-omitted' },
    ]);
  });

  test('malformed destination or commit is refused before any request', async () => {
    const host = pullScenario();
    const c = client(host);
    await assert.rejects(c.fetchContext({ destination: DESTINATION, reviewedCommit: HEAD.slice(0, 12) }), TypeError);
    await assert.rejects(
      c.fetchContext({ destination: { ...DESTINATION, owner: 'acme/../x' }, reviewedCommit: HEAD }),
      TypeError,
    );
    await assert.rejects(
      c.fetchContext({ destination: DESTINATION, reviewedCommit: HEAD, oldSourceCommit: 'main' }),
      TypeError,
    );
    assert.equal(host.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Source snapshots
// ---------------------------------------------------------------------------

describe('readSource', () => {
  async function prepared(options: IPullScenarioOptions = {}): Promise<{ host: FakeHost; readSource: IFetchedContext['readSource'] }> {
    const host = pullScenario(options);
    const { readSource } = await contextFor(host, options.request);
    host.requests.length = 0;
    return { host, readSource };
  }

  test('reads a pinned file through its commit, each tree on the path, and its blob', async () => {
    const { host, readSource } = await prepared();
    const filePath = 'docs/guide notes/Überblick.md';
    assert.equal(await readSource(HEAD, filePath), contentsEntry(HEAD, filePath).text);
    assert.deepEqual(host.urls(), [
      commitUrl(HEAD),
      treeUrl(treeAt(host, HEAD, '').sha),
      treeUrl(treeAt(host, HEAD, 'docs').sha),
      treeUrl(treeAt(host, HEAD, 'docs/guide notes').sha),
      blobUrl(fileBlob(host, HEAD, filePath)),
    ]);
    assertHttpDiscipline(host);
  });

  test('commits and trees are immutable and read once per client', async () => {
    const { host, readSource } = await prepared();
    await readSource(HEAD, 'src/app.js');
    await readSource(HEAD, 'src/same.js');
    const count = (url: string): number => host.urls().filter((u) => u === url).length;
    assert.equal(count(commitUrl(HEAD)), 1);
    assert.equal(count(treeUrl(treeAt(host, HEAD, '').sha)), 1);
    assert.equal(count(treeUrl(treeAt(host, HEAD, 'src').sha)), 1);
  });

  test('preserves CRLF, a missing final newline, first and last lines, and a leading BOM', async () => {
    const { host, readSource } = await prepared();
    for (const filePath of ['docs/crlf.txt', 'src/same.js', 'src/bom.txt']) {
      assert.equal(await readSource(HEAD, filePath), contentsEntry(HEAD, filePath).text, filePath);
    }
    assertHttpDiscipline(host);
  });

  test('an executable regular file (mode 100755) is source', async () => {
    const { host, readSource } = await prepared();
    assert.equal(await readSource(HEAD, 'bin/run.sh'), '#!/bin/sh\necho run\n');
    assertHttpDiscipline(host);
  });

  test('a historical commit is read directly, without diff verification', async () => {
    const { host, readSource } = await prepared();
    assert.equal(await readSource(HISTORICAL, 'src/app.js'), contentsEntry(HISTORICAL, 'src/app.js').text);
    assert.ok(!host.urls().includes(commitUrl(HEAD)), 'no head read for a historical source');
    assertHttpDiscipline(host);
  });

  for (const filePath of ['src/app.js', 'docs/crlf.txt', 'docs/guide notes/Überblick.md', 'src/same.js']) {
    test(`a base read of ${filePath} is verified against the reverse-applied head`, async () => {
      const { host, readSource } = await prepared();
      assert.equal(await readSource(MERGE_BASE, filePath), contentsEntry(MERGE_BASE, filePath).text);
      const urls = host.urls();
      assert.ok(urls.includes(commitUrl(HEAD)), 'head snapshot read');
      assert.ok(urls.includes(commitUrl(MERGE_BASE)), 'candidate snapshot read');
      assertHttpDiscipline(host);
    });
  }

  test('an added file is legitimately absent at the base, which is confirmed', async () => {
    const { host, readSource } = await prepared();
    assert.equal(await readSource(MERGE_BASE, 'src/new.js'), null);
    assert.ok(host.urls().includes(treeUrl(treeAt(host, MERGE_BASE, 'src').sha)), 'the base directory was listed');
    assertHttpDiscipline(host);
  });

  test('a removed file is legitimately absent at the head and verified at the base', async () => {
    const { readSource } = await prepared();
    assert.equal(await readSource(MERGE_BASE, 'src/old.js'), 'gone\n');
    assert.equal(await readSource(HEAD, 'src/old.js'), null);
  });

  test('a candidate whose text the patch does not reproduce is unverified', async () => {
    const { readSource } = await prepared({ request: { oldSourceCommit: ADVANCED } });
    await rejectsWith(readSource(ADVANCED, 'src/app.js'), 'old-source-unverified');
  });

  test('a compare merge base that disagrees with the patches is unverified', async () => {
    const { readSource } = await prepared({ compare: { status: 'diverged', merge_base_commit: { sha: ADVANCED } } });
    await rejectsWith(readSource(ADVANCED, 'src/app.js'), 'old-source-unverified');
  });

  test('a patch missing an old-side no-newline marker is incompatible', async () => {
    const pages = withFilePatch('docs/crlf.txt', (file) => {
      file.patch = patchOf(file).replace('-three\n\\ No newline at end of file\n', '-three\n');
    });
    const { readSource } = await prepared({ filesPages: pages });
    await rejectsWith(readSource(MERGE_BASE, 'docs/crlf.txt'), 'old-source-unverified');
  });

  test('a patch missing a new-side no-newline marker is incompatible', async () => {
    const pages = withFilePatch('docs/crlf.txt', (file) => {
      file.patch = patchOf(file).replace(/\n\\ No newline at end of file$/, '');
    });
    const { readSource } = await prepared({ filesPages: pages });
    await rejectsWith(readSource(MERGE_BASE, 'docs/crlf.txt'), 'old-source-unverified');
  });

  test('renamed files refuse old-side reads under either name', async () => {
    const { host, readSource } = await prepared();
    await rejectsWith(readSource(MERGE_BASE, 'src/moved.js'), 'rename-unsupported');
    await rejectsWith(readSource(MERGE_BASE, 'src/orig.js'), 'rename-unsupported');
    assertHttpDiscipline(host);
  });

  test('a file without a usable patch refuses old-side reads', async () => {
    const { readSource } = await prepared();
    await rejectsWith(readSource(MERGE_BASE, 'assets/logo.png'), 'patch-unavailable');
    const pages = withFilePatch('src/app.js', (file) => {
      file.patch = patchOf(file).slice(0, patchOf(file).indexOf('\n@@ -8,7'));
    });
    const truncated = await prepared({ filesPages: pages });
    await rejectsWith(truncated.readSource(MERGE_BASE, 'src/app.js'), 'patch-unavailable');
  });

  test('a changed file missing at the head is inconsistent', async () => {
    const { readSource } = await prepared({ omit: { [HEAD]: ['src/app.js'] } });
    await rejectsWith(readSource(MERGE_BASE, 'src/app.js'), 'source-inconsistent');
  });

  test('invalid UTF-8 is refused rather than replaced', async () => {
    const { readSource } = await prepared();
    await rejectsWith(readSource(HEAD, 'src/latin1.txt'), 'undecodable-source');
  });

  test('sources beyond the size limit are refused before their blob is read, never truncated', async () => {
    const host = pullScenario();
    const { readSource } = await client(host, { limits: { maxSourceBytes: 16 } }).fetchContext({
      destination: DESTINATION,
      reviewedCommit: HEAD,
    });
    await rejectsWith(readSource(HEAD, 'src/big.txt'), 'source-too-large');
    assert.ok(!host.urls().includes(blobUrl(fileBlob(host, HEAD, 'src/big.txt'))), 'oversized blob not downloaded');
  });

  // Path kinds. Only regular files (100644, 100755) are source. Every refusal
  // here is decided from the requested commit's own tree entries, even though
  // the dereferencing Contents API would answer with a self-consistent file.
  const pathKinds = [
    ['a symlink to an in-repository file', 'links/app-link.js', 'not-a-file'],
    ['a path below a symlinked directory', 'linkdir/app.js', 'not-a-file'],
    ['a path inside a submodule', 'vendor/lib/index.js', 'not-a-file'],
    ['a submodule itself', 'vendor/lib', 'not-a-file'],
    ['a directory', 'src', 'not-a-file'],
  ] as const;
  for (const [label, filePath, code] of pathKinds) {
    test(`refuses ${label} instead of reading another path's text`, async () => {
      const { host, readSource } = await prepared();
      await rejectsWith(readSource(HEAD, filePath), code);
      assertHttpDiscipline(host);
    });
  }

  test('a path absent from a complete tree is absent', async () => {
    const { host, readSource } = await prepared();
    assert.equal(await readSource(HEAD, 'src/missing.js'), null);
    assert.equal(await readSource(HEAD, 'nowhere/missing.js'), null);
    assert.equal(await readSource(HEAD, 'src/app.js/child'), null);
    assertHttpDiscipline(host);
  });

  test('a symlinked old-side path is refused at the base as at the head', async () => {
    const { readSource } = await prepared({ request: { oldSourceCommit: HEAD } });
    await rejectsWith(readSource(HEAD, 'links/app-link.js'), 'not-a-file');
  });

  const objectFailures: readonly (readonly [string, string, (host: FakeHost) => void])[] = [
    [
      'a missing commit (HTTP 404), which is not evidence of absence',
      'http-status',
      (host) => {
        replaceRoute(host, commitUrl(HEAD), () => jsonResponse(404, NOT_FOUND));
      },
    ],
    [
      'a missing tree (HTTP 404)',
      'http-status',
      (host) => {
        replaceRoute(host, treeUrl(treeAt(host, HEAD, 'src').sha), () => jsonResponse(404, NOT_FOUND));
      },
    ],
    [
      'a missing blob (HTTP 404)',
      'http-status',
      (host) => {
        replaceRoute(host, blobUrl(fileBlob(host, HEAD, 'src/app.js')), () => jsonResponse(404, NOT_FOUND));
      },
    ],
    [
      'a commit answering for another commit',
      'blob-integrity',
      (host) => {
        replaceRoute(host, commitUrl(HEAD), () =>
          jsonResponse(200, { sha: MERGE_BASE, tree: { sha: snapshotOf(host, MERGE_BASE).rootSha } }),
        );
      },
    ],
    [
      'a truncated tree listing',
      'malformed-response',
      (host) => {
        const tree = treeAt(host, HEAD, 'src');
        replaceRoute(host, treeUrl(tree.sha), () => jsonResponse(200, { ...structuredClone(tree.body), truncated: true }));
      },
    ],
    [
      'a tree listing an entry twice',
      'malformed-response',
      (host) => {
        const tree = treeAt(host, HEAD, 'src');
        const body = structuredClone(tree.body);
        body.tree.push(structuredClone(defined(body.tree.find((e) => e.path === 'app.js'), 'the app.js entry')));
        replaceRoute(host, treeUrl(tree.sha), () => jsonResponse(200, body));
      },
    ],
    [
      'a tree answering for another tree',
      'blob-integrity',
      (host) => {
        const tree = treeAt(host, HEAD, 'src');
        replaceRoute(host, treeUrl(tree.sha), () => jsonResponse(200, { ...structuredClone(tree.body), sha: '1'.repeat(40) }));
      },
    ],
    [
      'an entry with an unknown mode',
      'malformed-response',
      (host) => {
        const tree = treeAt(host, HEAD, 'src');
        const body = structuredClone(tree.body);
        defined(body.tree.find((e) => e.path === 'app.js'), 'the app.js entry').mode = '100664';
        replaceRoute(host, treeUrl(tree.sha), () => jsonResponse(200, body));
      },
    ],
    [
      'an entry whose mode and type disagree',
      'malformed-response',
      (host) => {
        const tree = treeAt(host, HEAD, 'src');
        const body = structuredClone(tree.body);
        defined(body.tree.find((e) => e.path === 'app.js'), 'the app.js entry').type = 'tree';
        replaceRoute(host, treeUrl(tree.sha), () => jsonResponse(200, body));
      },
    ],
    [
      'a self-consistent blob of other content served for the requested blob id',
      'blob-integrity',
      (host) => {
        const other = Buffer.from(textOf(contentsEntry(HEAD, 'src/same.js'), 'src/same.js at the head'), 'utf8');
        replaceRoute(host, blobUrl(fileBlob(host, HEAD, 'src/app.js')), () =>
          jsonResponse(200, blobBody(blobSha(other), other)),
        );
      },
    ],
    [
      'a blob whose content does not hash to the requested id',
      'blob-integrity',
      (host) => {
        const sha = fileBlob(host, HEAD, 'src/app.js');
        const other = Buffer.from('tampered\n', 'utf8');
        replaceRoute(host, blobUrl(sha), () => jsonResponse(200, blobBody(sha, other)));
      },
    ],
    [
      'same-size blob content that does not hash to the requested id',
      'blob-integrity',
      (host) => {
        const sha = fileBlob(host, HEAD, 'src/app.js');
        const bytes = Buffer.from(defined(snapshotOf(host, HEAD).blobs.get(sha), 'the src/app.js blob'));
        bytes[0] = bytes[0] === 0x78 ? 0x79 : 0x78;
        replaceRoute(host, blobUrl(sha), () => jsonResponse(200, blobBody(sha, bytes)));
      },
    ],
    [
      'a blob size that disagrees with its content',
      'blob-integrity',
      (host) => {
        const sha = fileBlob(host, HEAD, 'src/app.js');
        const bytes = defined(snapshotOf(host, HEAD).blobs.get(sha), 'the src/app.js blob');
        replaceRoute(host, blobUrl(sha), () => jsonResponse(200, blobBody(sha, bytes, { size: bytes.length + 1 })));
      },
    ],
    [
      'blob content that is not strict base64',
      'malformed-response',
      (host) => {
        const sha = fileBlob(host, HEAD, 'src/app.js');
        const bytes = defined(snapshotOf(host, HEAD).blobs.get(sha), 'the src/app.js blob');
        const body = blobBody(sha, bytes);
        replaceRoute(host, blobUrl(sha), () => jsonResponse(200, { ...body, content: `*${body.content}` }));
      },
    ],
  ];
  for (const [label, code, breakHost] of objectFailures) {
    test(`refuses ${label}`, async () => {
      const host = pullScenario();
      const { readSource } = await contextFor(host);
      breakHost(host);
      await rejectsWith(readSource(HEAD, 'src/app.js'), code);
      assertHttpDiscipline(host);
    });
  }

  test('refuses traversal and malformed paths or commits before any request', async () => {
    const { host, readSource } = await prepared();
    for (const bad of ['', '/src/app.js', '../etc/passwd', 'src/../app.js', 'src/./app.js', 'src//app.js', 'src\\app.js', 'src/app.js\0']) {
      await assert.rejects(readSource(HEAD, bad), TypeError, JSON.stringify(bad));
    }
    await assert.rejects(readSource(HEAD.slice(0, 7), 'src/app.js'), TypeError);
    await assert.rejects(readSource(HEAD.toUpperCase(), 'src/app.js'), TypeError);
    assert.equal(host.requests.length, 0);
  });

  test('a historical review still verifies old-side reads against the current pull head', async () => {
    const { host, readSource } = await prepared({ request: { reviewedCommit: HISTORICAL } });
    assert.equal(await readSource(MERGE_BASE, 'src/app.js'), contentsEntry(MERGE_BASE, 'src/app.js').text);
    assert.ok(host.urls().includes(commitUrl(HEAD)), 'reverse-applied from the pinned head');
    assert.equal(await readSource(HISTORICAL, 'src/app.js'), contentsEntry(HISTORICAL, 'src/app.js').text);
    assertHttpDiscipline(host);
  });
});

// ---------------------------------------------------------------------------
// Runtime shape of the adapter's values
//
// These pin runtime facts that no type declaration expresses, so a change of
// implementation language or class-field semantics cannot alter them silently.
// ---------------------------------------------------------------------------

describe('GitHubError and client object runtime shape', () => {
  test('a GitHubError without a status has no own status key; code and hostRejected are always present', () => {
    // src/github.cts documents `status` as set only when the host answered;
    // callers (publication, credential redaction) enumerate own properties,
    // so "absent" must not become an own key holding undefined. The key
    // order is characterization of 0.2.0 (it is what util.inspect and
    // JSON.stringify of the error show).
    const err = new GitHubError('network', 'GET /repos/acme/widgets failed');
    assert.ok(err instanceof GitHubError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'GitHubError');
    assert.equal(err.message, 'GET /repos/acme/widgets failed');
    assert.equal(err.code, 'network');
    assert.equal(err.hostRejected, false);
    assert.equal(Object.hasOwn(err, 'status'), false, 'an unknown status is absent, not undefined');
    assert.equal(Object.hasOwn(err, 'cause'), false, 'no cause was given');
    assert.deepEqual(Object.keys(err), ['name', 'code', 'hostRejected']);
    assert.equal(JSON.stringify(err), '{"name":"GitHubError","code":"network","hostRejected":false}');
  });

  test('a GitHubError with a status and cause carries them, in 0.2.0 key order', () => {
    const cause = new Error('socket hang up');
    // @ts-expect-error -- 'create-refused' is not a GitHubErrorCode; kept as authored, since this test asserts only status, hostRejected, cause and key order, which the constructor sets independently of the code
    const err = new GitHubError('create-refused', 'Unprocessable Entity', { status: 422, hostRejected: true, cause });
    assert.equal(err.status, 422);
    assert.equal(err.hostRejected, true);
    assert.equal(err.cause, cause);
    // A standard Error cause: own, but not enumerable (ECMAScript InstallErrorCause).
    assert.equal(defined(Object.getOwnPropertyDescriptor(err, 'cause'), 'an own cause descriptor').enumerable, false);
    assert.deepEqual(Object.keys(err), ['name', 'code', 'status', 'hostRejected']);
  });

  test('an explicitly undefined cause installs no cause property', () => {
    const err = new GitHubError('network', 'failed', { cause: undefined });
    assert.equal(Object.hasOwn(err, 'cause'), false);
    assert.equal('cause' in err, false);
  });

  test('the client object is frozen: callers cannot replace or add transport methods', () => {
    // createGitHubClient returns Object.freeze(...); a compile-time readonly
    // type would not stop a JavaScript caller from swapping a method.
    const c = client(new FakeHost());
    assert.equal(Object.isFrozen(c), true);
    assert.throws(() => {
      // @ts-expect-error -- deliberately invalid: proves the frozen client refuses a replaced method at runtime (the property is readonly in the type)
      c.createReview = async () => ({}); // eslint-disable-line @typescript-eslint/require-await -- the replacement is never called: the assignment itself must throw
    }, TypeError);
    assert.throws(() => {
      // @ts-expect-error -- deliberately invalid: proves the frozen client refuses a new property at runtime
      c.extra = 1;
    }, TypeError);
  });
});
