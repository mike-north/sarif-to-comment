'use strict';

/**
 * Contract tests for the GitHub host adapter (src/github.cjs).
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

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const { createGitHubClient, GitHubError } = require('../src/github.cjs');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'github');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
const PR = load('pull-request.json');
const RV = load('reviews.json');

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

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * A routing table standing in for api.github.com. Each route matches method
 * and exact URL (and optionally a predicate on the request) and answers with
 * one response per call, in order. Every request is recorded as the adapter
 * sent it.
 */
class FakeHost {
  constructor() {
    this.routes = [];
    this.requests = [];
    this.fetch = this.fetch.bind(this);
  }

  /** Adds a route answered by `responders` in order (a function or a list of them). */
  on(method, url, responders, when) {
    this.routes.push({ method, url, when, queue: [].concat(responders) });
    return this;
  }

  async fetch(input, init = {}) {
    const request = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: String(init.method ?? 'GET').toUpperCase(),
      headers: new Headers(init.headers),
      body: init.body === undefined || init.body === null ? undefined : String(init.body),
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
    const respond = route.queue.length > 1 ? route.queue.shift() : route.queue[0];
    return respond(request);
  }

  urls() {
    return this.requests.map((r) => r.url);
  }
}

/**
 * Invariants of every exchange: nothing unrouted, only the API origin, manual
 * redirects, the bearer token on every request, documented REST headers, and
 * no write except the single review creation and GraphQL queries.
 */
function assertHttpDiscipline(host) {
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
        const { query } = JSON.parse(r.body);
        assert.doesNotMatch(query, /\bmutation\b/, 'GraphQL requests are read-only queries');
      } else {
        assert.match(r.url, /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/);
      }
    } else {
      assert.equal(r.method, 'GET');
    }
  }
}

function client(host, extra = {}) {
  return createGitHubClient({ token: TOKEN, fetch: host.fetch, ...extra });
}

/** Deep, hidden-property rendering used to prove a value carries no token. */
function assertNoToken(value, label) {
  const rendered = [
    util.inspect(value, { depth: 20, showHidden: true, getters: true }),
    value instanceof Error ? String(value.stack) : '',
  ].join('\n');
  assert.ok(!rendered.includes(TOKEN), `${label} exposes the token`);
}

async function rejectsWith(promise, code, extra = {}) {
  const err = await promise.then(
    () => assert.fail(`expected GitHubError ${code}`),
    (e) => e,
  );
  assert.ok(err instanceof GitHubError, `expected GitHubError, got ${err && err.name}: ${err && err.message}`);
  assert.equal(err.code, code, err.message);
  for (const [key, value] of Object.entries(extra)) assert.equal(err[key], value, key);
  assertNoToken(err, `error ${code}`);
  return err;
}

// ---------------------------------------------------------------------------
// Pull-request scenario routes
// ---------------------------------------------------------------------------

/** Git object id: SHA-1 of "<type> <size>\0" followed by the object bytes. */
function gitObjectSha(type, bytes) {
  return crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`, 'utf8'), bytes]))
    .digest('hex');
}

/** Git blob object id of raw bytes. */
function blobSha(bytes) {
  return gitObjectSha('blob', bytes);
}

function entryBytes(entry) {
  return entry.bytesHex !== undefined ? Buffer.from(entry.bytesHex, 'hex') : Buffer.from(entry.text, 'utf8');
}

const REPO_API = `${API}/repos/acme/widgets`;
const commitUrl = (sha) => `${REPO_API}/git/commits/${sha}`;
const treeUrl = (sha) => `${REPO_API}/git/trees/${sha}`;
const blobUrl = (sha) => `${REPO_API}/git/blobs/${sha}`;

/** Every raw tree entry authored for one commit, minus `omit`ted paths. */
function authoredEntries(commit, omit = []) {
  const entries = [];
  for (const c of PR.contents) {
    if (c.commit === commit && !c.absent && !omit.includes(c.path)) {
      entries.push({ path: c.path, mode: c.mode ?? '100644', bytes: entryBytes(c) });
    }
  }
  for (const s of PR.specialEntries.entries) {
    if (s.commit !== commit || omit.includes(s.path)) continue;
    entries.push(
      s.mode === '160000'
        ? { path: s.path, mode: s.mode, commitSha: s.submoduleCommit }
        : { path: s.path, mode: s.mode, bytes: Buffer.from(s.target ?? s.text, 'utf8') },
    );
  }
  return entries;
}

/**
 * The Git objects of one snapshot: each directory as GitHub's non-recursive
 * tree listing (trees report mode "040000"), keyed by directory path, with a
 * real Git tree id; every blob by id; and each file's blob id by path.
 */
function buildSnapshot(entries) {
  const newDir = () => ({ dirs: new Map(), leaves: new Map() });
  const root = newDir();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      if (!dir.dirs.has(part)) dir.dirs.set(part, newDir());
      dir = dir.dirs.get(part);
    }
    dir.leaves.set(parts.at(-1), entry);
  }
  const trees = new Map();
  const blobs = new Map();
  const files = new Map();
  const build = (dir, dirPath) => {
    const listing = [];
    for (const [name, sub] of dir.dirs) {
      const sha = build(sub, dirPath ? `${dirPath}/${name}` : name);
      listing.push({ name, gitMode: '40000', mode: '040000', type: 'tree', sha });
    }
    for (const [name, entry] of dir.leaves) {
      if (entry.mode === '160000') {
        listing.push({ name, gitMode: '160000', mode: '160000', type: 'commit', sha: entry.commitSha });
      } else {
        const sha = blobSha(entry.bytes);
        blobs.set(sha, entry.bytes);
        files.set(entry.path, sha);
        listing.push({ name, gitMode: entry.mode, mode: entry.mode, type: 'blob', sha, size: entry.bytes.length });
      }
    }
    // Git orders tree entries bytewise by name, comparing subtrees as "name/".
    const key = (x) => Buffer.from(x.type === 'tree' ? `${x.name}/` : x.name, 'utf8');
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
function blobBody(sha, bytes, overrides = {}) {
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
function replaceRoute(host, url, responder) {
  host.routes = host.routes.filter((r) => r.url !== url);
  host.on('GET', url, responder);
}

/** A contents-API file body as GitHub encodes it (base64 wrapped at 60 columns). */
function contentsBody(entry, overrides = {}) {
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

function contentsEntry(commit, filePath, optional = false) {
  const entry = PR.contents.find((c) => c.commit === commit && c.path === filePath);
  if (optional) return entry;
  assert.ok(entry, `fixture has no contents for ${filePath} at ${commit}`);
  return entry;
}

function routeContents(host, entry, override) {
  const responder = override ?? (() => (entry.absent ? jsonResponse(404, NOT_FOUND) : jsonResponse(200, contentsBody(entry))));
  host.on('GET', entry.url, responder);
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
} = {}) {
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
      const target = contentsEntry(special.commit, answer.servesFileOf, true) ?? {
        path: special.path,
        text: special.text,
      };
      return jsonResponse(200, contentsBody(target, { name: path.posix.basename(answer.requestedPath), path: answer.requestedPath }));
    });
  }
  return host;
}

/** The blob id of an authored file at a commit, from the scenario's snapshot. */
function fileBlob(host, commit, filePath) {
  const sha = host.git[commit].files.get(filePath);
  assert.ok(sha, `snapshot has no ${filePath} at ${commit}`);
  return sha;
}

/** The scenario's tree listing for a directory at a commit. */
function treeAt(host, commit, dirPath) {
  const tree = host.git[commit].trees.get(dirPath);
  assert.ok(tree, `snapshot has no directory ${dirPath || '(root)'} at ${commit}`);
  return tree;
}

function withFilePatch(filename, change) {
  const pages = structuredClone(PR.filesPages);
  for (const page of pages) {
    for (const file of page.body) if (file.filename === filename) change(file);
  }
  return pages;
}

async function contextFor(host, request = {}) {
  return client(host).fetchContext({ destination: DESTINATION, reviewedCommit: HEAD, ...request });
}

// ---------------------------------------------------------------------------
// Review readback routes
// ---------------------------------------------------------------------------

function reviewCommentsScenario(change = () => {}) {
  const fixture = structuredClone(RV.reviewComments);
  change(fixture);
  const host = new FakeHost();
  for (const page of fixture.restPages) {
    host.on('GET', page.url, () => jsonResponse(200, page.body, page.link ? { link: page.link } : {}));
  }
  for (const page of fixture.graphqlPages) {
    host.on('POST', fixture.graphqlUrl, () => jsonResponse(200, page.response), (req) => {
      const { variables } = JSON.parse(req.body);
      return variables && variables.after === page.after;
    });
  }
  return host;
}

function threadNodes(fixture, pageIndex) {
  return fixture.graphqlPages[pageIndex].response.data.repository.pullRequest.reviewThreads.nodes;
}

function threadOf(fixture, databaseId) {
  for (const page of fixture.graphqlPages) {
    for (const node of page.response.data.repository.pullRequest.reviewThreads.nodes) {
      if (node.comments.nodes[0].databaseId === databaseId) return node;
    }
  }
  throw new Error(`no thread rooted at ${databaseId}`);
}

function restCommentOf(fixture, id) {
  for (const page of fixture.restPages) for (const c of page.body) if (c.id === id) return c;
  throw new Error(`no REST comment ${id}`);
}

async function readComments(host) {
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
          if (line.startsWith('+')) assert.ok(head.text.includes(line.slice(1)), `${file.filename}: ${line}`);
          if (line.startsWith('-')) assert.ok(base.text.includes(line.slice(1)), `${file.filename}: ${line}`);
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
      assert.throws(() => createGitHubClient({ token: TOKEN, fetch: host.fetch, apiOrigin }), TypeError, apiOrigin);
    }
    assert.equal(host.requests.length, 0);
  });

  test('requires a token; fetch defaults to the global implementation but must be a function', () => {
    const host = new FakeHost();
    assert.throws(() => createGitHubClient({ fetch: host.fetch }), TypeError);
    assert.throws(() => createGitHubClient({ token: '', fetch: host.fetch }), TypeError);
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
      const value = c[key];
      if (typeof value === 'string') assert.notEqual(value, TOKEN, String(key));
    }
  });

  test('nothing is written to the console, including on failures', async () => {
    const captured = [];
    const names = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
    const saved = names.map((n) => console[n]);
    names.forEach((n) => (console[n] = (...args) => captured.push(args)));
    try {
      const host = new FakeHost()
        .on('GET', RV.user.url, () => jsonResponse(401, { message: 'Bad credentials' }))
        .on('POST', RV.createReview.url, () => jsonResponse(500, { message: 'Server Error' }));
      const c = client(host);
      await c.getAuthenticatedUser().catch(() => {});
      await c.createReview(structuredClone(RV.createReview.request)).catch(() => {});
    } finally {
      names.forEach((n, i) => (console[n] = saved[i]));
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
    assert.equal(err.cause.message, 'socket hang up');
    assert.equal(err.cause.code, 'ECONNRESET');
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
    const sent = JSON.parse(host.requests[0].body);
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
    test(`an understood ${status} refusal is definitive and sent once`, async () => {
      const host = new FakeHost().on('POST', url, () => jsonResponse(status, { message: 'refused' }));
      await rejectsWith(client(host).createReview(structuredClone(request)), 'http-status', {
        status,
        hostRejected: true,
      });
      assert.equal(host.requests.length, 1);
    });
  }

  for (const status of [408, 499, 500, 502, 503, 504]) {
    test(`a ${status} answer is indeterminate and never retried`, async () => {
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
    await assert.rejects(client(host).createReview({ ...structuredClone(request), event: 'COMMENT' }), TypeError);
    const withPosition = structuredClone(request);
    withPosition.comments[0].position = 5;
    await assert.rejects(client(host).createReview(withPosition), TypeError);
    assert.equal(host.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Review listing
// ---------------------------------------------------------------------------

describe('listReviews', () => {
  function reviewsHost(pages = RV.reviewPages) {
    const host = new FakeHost();
    for (const page of pages) host.on('GET', page.url, () => jsonResponse(200, page.body, page.link ? { link: page.link } : {}));
    return host;
  }

  test('follows a validated Link (including the /repositories/{id} form) one page per call', async () => {
    const host = reviewsHost();
    const c = client(host);
    const first = await c.listReviews({ ...DESTINATION, cursor: null });
    assert.deepEqual(first.reviews, RV.reviewPages[0].expected);
    assert.equal(typeof first.nextCursor, 'string');
    assert.ok(first.nextCursor.length > 0);
    const second = await c.listReviews({ ...DESTINATION, cursor: first.nextCursor });
    assert.deepEqual(second, { reviews: RV.reviewPages[1].expected, nextCursor: null });
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
  ]) {
    test(`a next link to ${label} is refused without being fetched`, async () => {
      const pages = structuredClone(RV.reviewPages);
      pages[0].link = link;
      const host = reviewsHost(pages);
      await rejectsWith(client(host).listReviews({ ...DESTINATION, cursor: null }), code);
      assert.deepEqual(host.urls(), [RV.reviewPages[0].url]);
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
      graphql.map((r) => JSON.parse(r.body).variables),
      [
        { owner: 'acme', repo: 'widgets', number: 42, after: null },
        { owner: 'acme', repo: 'widgets', number: 42, after: 'Y3Vyc29yOjM=' },
      ],
    );
    for (const r of graphql) {
      const { query } = JSON.parse(r.body);
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
        return JSON.parse(req.body).variables.after === page.after;
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

  const failures = [
    ['a REST comment with no thread', 'anchor-unavailable', (f) => threadNodes(f, 1).splice(0, 1)],
    ['two threads rooted at one comment', 'anchor-ambiguous', (f) => threadNodes(f, 1).push(structuredClone(threadOf(f, 101)))],
    [
      'a thread of this review whose root REST does not list',
      'anchor-ambiguous',
      (f) => {
        const extra = structuredClone(threadOf(f, 103));
        extra.comments.nodes[0].databaseId = 106;
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
      (f) => (threadOf(f, 102).comments.nodes[0].originalCommit.oid = MERGE_BASE),
    ],
    ['a REST comment from another review', 'malformed-response', (f) => (restCommentOf(f, 103).pull_request_review_id = 8000)],
    [
      'GraphQL errors',
      'graphql-errors',
      (f) => (f.graphqlPages[1].response = { data: null, errors: [{ type: 'RATE_LIMITED', message: 'rate limited' }] }),
    ],
    [
      'a next page without a cursor',
      'pagination',
      (f) => (f.graphqlPages[0].response.data.repository.pullRequest.reviewThreads.pageInfo.endCursor = null),
    ],
    [
      'a repeated cursor',
      'pagination',
      (f) =>
        (f.graphqlPages[1].response.data.repository.pullRequest.reviewThreads.pageInfo = {
          hasNextPage: true,
          endCursor: 'Y3Vyc29yOjM=',
        }),
    ],
    [
      'a REST next link to another origin',
      'unsafe-link',
      (f) => (f.restPages[0].link = '<https://evil.example/repos/acme/widgets/pulls/42/reviews/9001/comments?per_page=100&page=2>; rel="next"'),
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
    pages[1].body.push(structuredClone(pages[0].body[0]));
    await rejectsWith(contextFor(pullScenario({ pull: { changed_files: 8 }, filesPages: pages })), 'duplicate-file');
  });

  test('a files next link to another origin is refused without being fetched', async () => {
    const pages = structuredClone(PR.filesPages);
    pages[0].link = '<https://evil.example/repos/acme/widgets/pulls/42/files?per_page=100&page=2>; rel="next"';
    const host = pullScenario({ filesPages: pages });
    await rejectsWith(contextFor(host), 'unsafe-link');
    assertHttpDiscipline(host);
  });

  test('a patch whose counts disagree with the entry is treated as truncated and dropped', async () => {
    const pages = withFilePatch('src/app.js', (file) => {
      file.patch = file.patch.slice(0, file.patch.indexOf('\n@@ -8,7'));
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
  async function prepared(options = {}) {
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
    const count = (url) => host.urls().filter((u) => u === url).length;
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
      file.patch = file.patch.replace('-three\n\\ No newline at end of file\n', '-three\n');
    });
    const { readSource } = await prepared({ filesPages: pages });
    await rejectsWith(readSource(MERGE_BASE, 'docs/crlf.txt'), 'old-source-unverified');
  });

  test('a patch missing a new-side no-newline marker is incompatible', async () => {
    const pages = withFilePatch('docs/crlf.txt', (file) => {
      file.patch = file.patch.replace(/\n\\ No newline at end of file$/, '');
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
      file.patch = file.patch.slice(0, file.patch.indexOf('\n@@ -8,7'));
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
  ];
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

  const objectFailures = [
    [
      'a missing commit (HTTP 404), which is not evidence of absence',
      'http-status',
      (host) => replaceRoute(host, commitUrl(HEAD), () => jsonResponse(404, NOT_FOUND)),
    ],
    [
      'a missing tree (HTTP 404)',
      'http-status',
      (host) => replaceRoute(host, treeUrl(treeAt(host, HEAD, 'src').sha), () => jsonResponse(404, NOT_FOUND)),
    ],
    [
      'a missing blob (HTTP 404)',
      'http-status',
      (host) => replaceRoute(host, blobUrl(fileBlob(host, HEAD, 'src/app.js')), () => jsonResponse(404, NOT_FOUND)),
    ],
    [
      'a commit answering for another commit',
      'blob-integrity',
      (host) =>
        replaceRoute(host, commitUrl(HEAD), () =>
          jsonResponse(200, { sha: MERGE_BASE, tree: { sha: host.git[MERGE_BASE].rootSha } }),
        ),
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
        body.tree.push(structuredClone(body.tree.find((e) => e.path === 'app.js')));
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
        body.tree.find((e) => e.path === 'app.js').mode = '100664';
        replaceRoute(host, treeUrl(tree.sha), () => jsonResponse(200, body));
      },
    ],
    [
      'an entry whose mode and type disagree',
      'malformed-response',
      (host) => {
        const tree = treeAt(host, HEAD, 'src');
        const body = structuredClone(tree.body);
        body.tree.find((e) => e.path === 'app.js').type = 'tree';
        replaceRoute(host, treeUrl(tree.sha), () => jsonResponse(200, body));
      },
    ],
    [
      'a self-consistent blob of other content served for the requested blob id',
      'blob-integrity',
      (host) => {
        const other = Buffer.from(contentsEntry(HEAD, 'src/same.js').text, 'utf8');
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
        const bytes = Buffer.from(host.git[HEAD].blobs.get(sha));
        bytes[0] = bytes[0] === 0x78 ? 0x79 : 0x78;
        replaceRoute(host, blobUrl(sha), () => jsonResponse(200, blobBody(sha, bytes)));
      },
    ],
    [
      'a blob size that disagrees with its content',
      'blob-integrity',
      (host) => {
        const sha = fileBlob(host, HEAD, 'src/app.js');
        const bytes = host.git[HEAD].blobs.get(sha);
        replaceRoute(host, blobUrl(sha), () => jsonResponse(200, blobBody(sha, bytes, { size: bytes.length + 1 })));
      },
    ],
    [
      'blob content that is not strict base64',
      'malformed-response',
      (host) => {
        const sha = fileBlob(host, HEAD, 'src/app.js');
        const bytes = host.git[HEAD].blobs.get(sha);
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
