'use strict';

/**
 * A fake GitHub at the HTTP level, for testing the production composition:
 * the real public library (src/index.cjs) with the real GitHub client
 * (src/github.cjs), whose `fetch` is this host's `fetch`. Nothing above HTTP is
 * replaced, so request construction, pagination, source reads, patch
 * verification, create-review wire format and readback normalization are all
 * the product's own.
 *
 * The host serves the hand-authored repository in repository.json:
 *   GET  /user
 *   GET  /repos/{o}/{r}/pulls/{n}                  head/base/changed_files
 *   GET  /repos/{o}/{r}/pulls/{n}/files            the authored patch
 *   GET  /repos/{o}/{r}/compare/{base}...{head}    merge base = base commit
 *   GET  /repos/{o}/{r}/git/commits|trees|blobs/*  real git object ids (blob
 *                                                  SHA-1 over "blob <n>\0")
 *   POST /repos/{o}/{r}/pulls/{n}/reviews          stores a pending review
 *   GET  /repos/{o}/{r}/pulls/{n}/reviews          review list
 *   GET  /repos/{o}/{r}/pulls/{n}/reviews/{id}/comments
 *                                                  pending comments: like the
 *                                                  live probe, line/side null
 *   POST /graphql                                  reviewThreads with the
 *                                                  original anchors
 * Like GitHub, it refuses a second pending review by one author on one pull
 * request with 422 (docs/native-suggestion-fidelity-experiment.md).
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
 *
 * This models documented and probed GitHub behavior; it is not evidence of
 * live GitHub behavior.
 *
 * @see https://docs.github.com/en/rest/pulls/reviews
 * @see https://docs.github.com/en/rest/git/trees
 * @see https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY = JSON.parse(fs.readFileSync(path.join(__dirname, 'repository.json'), 'utf8'));
const API = 'https://api.github.com';
const USER = Object.freeze({ id: 4242, login: 'review-bot' });

/** Git's blob object id: SHA-1 of "blob <size>\0" followed by the bytes. */
function gitBlobSha(bytes) {
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
}

/** A deterministic 40-hex id for a synthetic tree. */
function treeId(label) {
  return crypto.createHash('sha1').update(`tree:${label}`).digest('hex');
}

/**
 * Git objects for every snapshot: commit -> root tree, tree -> entries,
 * blob id -> bytes. Directories become nested trees.
 */
function buildObjects() {
  const commits = {};
  const trees = {};
  const blobs = {};
  for (const [commit, files] of Object.entries(REPOSITORY.snapshots)) {
    const dirs = new Map([['', new Map()]]);
    for (const [filePath, lines] of Object.entries(files)) {
      const bytes = Buffer.from(lines.join(''), 'utf8');
      const sha = gitBlobSha(bytes);
      blobs[sha] = bytes;
      const parts = filePath.split('/');
      let dir = '';
      for (const part of parts.slice(0, -1)) {
        const child = dir ? `${dir}/${part}` : part;
        if (!dirs.has(child)) {
          dirs.set(child, new Map());
          dirs.get(dir).set(part, { mode: '040000', type: 'tree', sha: treeId(`${commit}:${child}`) });
        }
        dir = child;
      }
      dirs.get(dir).set(parts.at(-1), { mode: '100644', type: 'blob', sha, size: bytes.length });
    }
    for (const [dir, entries] of dirs) {
      trees[treeId(`${commit}:${dir}`)] = [...entries].map(([name, e]) => ({ path: name, ...e }));
    }
    commits[commit] = treeId(`${commit}:`);
  }
  return { commits, trees, blobs };
}

const OBJECTS = buildObjects();

class FakeHttpGitHub {
  /** Creates a host rooted at a fresh directory. */
  static create(dir, config = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const host = new FakeHttpGitHub(dir);
    host.write('config.json', { create: 'ok', shiftThreadLine: null, ...config });
    host.write('reviews.json', []);
    host.write('log.json', []);
    return host;
  }

  /** Attaches to an existing host directory (e.g. from a child process). */
  constructor(dir, expectedToken = null) {
    this.dir = dir;
    this.expectedToken = expectedToken;
    this.fetch = this.fetch.bind(this);
  }

  read(name) {
    return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
  }

  write(name, value) {
    const tmp = path.join(this.dir, `.${name}.${process.pid}.${crypto.randomUUID()}`);
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, path.join(this.dir, name));
  }

  config() {
    return this.read('config.json');
  }

  setConfig(patch) {
    this.write('config.json', { ...this.config(), ...patch });
  }

  /** Stored reviews: { id, request (the wire body), body, state }. */
  reviews() {
    return this.read('reviews.json');
  }

  /** Every request received: { method, path, authorized }. */
  log() {
    return this.read('log.json');
  }

  /** The WHATWG fetch the real client is constructed with. */
  async fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method || 'GET';
    const auth = new Headers(init.headers).get('authorization');
    const authorized = this.expectedToken === null ? auth !== null : auth === `Bearer ${this.expectedToken}`;
    this.write('log.json', [...this.log(), { method, path: u.pathname, authorized }]);
    if (u.origin !== API) throw new Error(`fake host: unexpected origin ${u.origin}`);
    return this.route(method, u, init);
  }

  route(method, u, init) {
    const { owner, repo, pullNumber } = REPOSITORY.destination;
    const { base, head } = REPOSITORY.commits;
    const repoPath = `/repos/${owner}/${repo}`;
    const pull = `${repoPath}/pulls/${pullNumber}`;
    const p = u.pathname;
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    let m;

    if (method === 'GET' && p === '/user') return json(USER);
    if (method === 'GET' && p === pull) {
      return json({ number: pullNumber, head: { sha: head }, base: { sha: base }, changed_files: REPOSITORY.pullFiles.length });
    }
    if (method === 'GET' && p === `${pull}/files`) {
      return json(REPOSITORY.pullFiles.map((f) => ({ ...f, patch: f.patch.join('') })));
    }
    if (method === 'GET' && p === `${repoPath}/compare/${base}...${head}`) return json({ merge_base_commit: { sha: base } });
    if (method === 'GET' && (m = new RegExp(`^${repoPath}/git/commits/([0-9a-f]{40})$`).exec(p))) {
      const tree = OBJECTS.commits[m[1]];
      return tree ? json({ sha: m[1], tree: { sha: tree } }) : json({ message: 'Not Found' }, 404);
    }
    if (method === 'GET' && (m = new RegExp(`^${repoPath}/git/trees/([0-9a-f]{40})$`).exec(p))) {
      const tree = OBJECTS.trees[m[1]];
      return tree ? json({ sha: m[1], truncated: false, tree }) : json({ message: 'Not Found' }, 404);
    }
    if (method === 'GET' && (m = new RegExp(`^${repoPath}/git/blobs/([0-9a-f]{40})$`).exec(p))) {
      const bytes = OBJECTS.blobs[m[1]];
      if (!bytes) return json({ message: 'Not Found' }, 404);
      return json({ sha: m[1], encoding: 'base64', content: bytes.toString('base64'), size: bytes.length });
    }
    if (method === 'POST' && p === `${pull}/reviews`) return this.createReview(JSON.parse(init.body), json);
    if (method === 'GET' && p === `${pull}/reviews`) {
      return json(
        this.reviews().map((r) => ({
          id: r.id,
          html_url: `https://github.com/${owner}/${repo}/pull/${pullNumber}#pullrequestreview-${r.id}`,
          user: USER,
          commit_id: r.request.commit_id,
          state: r.state,
          body: r.body,
        })),
      );
    }
    if (method === 'GET' && (m = new RegExp(`^${pull}/reviews/(\\d+)/comments$`).exec(p))) {
      const review = this.reviews().find((r) => r.id === Number(m[1]));
      if (!review) return json({ message: 'Not Found' }, 404);
      return json(
        review.request.comments.map((c, i) => ({
          id: review.id * 100 + i,
          pull_request_review_id: review.id,
          path: c.path,
          body: c.body,
          original_commit_id: review.request.commit_id,
          line: null,
          side: null,
        })),
      );
    }
    if (method === 'POST' && p === '/graphql') return this.reviewThreads(JSON.parse(init.body), json);
    return json({ message: `fake host: no route for ${method} ${p}` }, 404);
  }

  createReview(request, json) {
    const config = this.config();
    const reviews = this.reviews();
    if (reviews.some((r) => r.state === 'PENDING')) {
      return json({ message: 'Unprocessable Entity', errors: ['User can only have one pending review per pull request'] }, 422);
    }
    const id = 5000 + reviews.length;
    const { owner, repo, pullNumber } = REPOSITORY.destination;
    this.write('reviews.json', [...reviews, { id, request, body: request.body, state: request.event ? 'COMMENTED' : 'PENDING' }]);
    if (config.create === 'lose-response') throw new TypeError('fetch failed: socket hang up');
    return json({ id, html_url: `https://github.com/${owner}/${repo}/pull/${pullNumber}#pullrequestreview-${id}` });
  }

  reviewThreads(query, json) {
    const { owner, repo, pullNumber } = REPOSITORY.destination;
    const vars = query.variables || {};
    if (vars.owner !== owner || vars.repo !== repo || vars.number !== pullNumber) {
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

module.exports = { FakeHttpGitHub, REPOSITORY, USER, gitBlobSha };
