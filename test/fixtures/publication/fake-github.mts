'use strict';

/**
 * File-backed double of the GitHub pull-request review host, for publication tests.
 *
 * Remote persistence here is deliberately independent of the publisher's local
 * state: every review the "host" stores lives in this double's own directory,
 * so a create can succeed remotely while its response is lost, a process can
 * die after the host persisted a review, and a fresh process (or a concurrent
 * one) sees exactly what the host holds — not what any local cache believes.
 * All state is on disk, so separate Node processes share one remote.
 *
 * Concurrency discipline (so that product failures are not harness races):
 * - Every JSON document is written to a unique temp file and published with
 *   rename, so a reader in any process sees a complete document or none.
 * - Review ids are allocated by exclusive creation of an empty reservation
 *   file; the review itself is then published atomically.
 * - The enumeration clock that models delayed visibility is the number of
 *   uniquely named marker files in one directory: increments cannot be lost
 *   and observations are monotonic.
 * - Every transport call is its own atomically published log file, recorded
 *   before the call has any remote effect. Names sort by wall-clock
 *   millisecond, pid, then a per-process counter, so in-process order is exact
 *   and cross-process counts are complete.
 * Readers never retry or tolerate JSON parse errors; one would be a harness
 * defect and must surface.
 *
 * The log is the oracle for "exactly one create attempt" and "no write other
 * than the single create", which is why the transport also exposes write
 * methods the publisher must never call (update, submit, delete, per-comment
 * create): a faulty publisher that tries to repair or maintain a review is
 * observed rather than merely failing to compile.
 *
 * Private transport contract modelled here (what src/publication.cjs may call):
 *
 *   getAuthenticatedUser() -> Promise<{ id: number, login?: string }>
 *     The numeric id is the stable author identity; login is mutable.
 *   createReview({ owner, repo, pullNumber, commitId, body, comments })
 *       -> Promise<{ id, htmlUrl }>
 *     `comments` items: { path, side, line, startSide?, startLine?, body };
 *     start fields are omitted for single-line comments. No `event` key:
 *     omitting it leaves the review as a draft (pending).
 *   listReviews({ owner, repo, pullNumber, cursor })
 *       -> Promise<{ reviews: ReviewSummary[], nextCursor: string | null }>
 *     ReviewSummary: { id, htmlUrl, authorId, authorLogin, commitId, state, body }.
 *     `cursor: null` starts an enumeration; `nextCursor: null` ends it.
 *   listReviewComments({ owner, repo, pullNumber, reviewId, cursor })
 *       -> Promise<{ comments: NormalizedComment[], nextCursor: string | null }>
 *     NormalizedComment has the request comment shape. A real transport must
 *     normalize host readback (e.g. review-thread original anchors) into it.
 *
 * Errors: a rejection the host definitively returned (e.g. HTTP 422 validation)
 * is signalled by `error.hostRejected === true` with `error.status`. Every
 * other thrown error is indeterminate: the request may or may not have taken
 * effect remotely.
 *
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/reviews#list-comments-for-a-pull-request-review
 * @see https://docs.github.com/en/rest/users/users#get-the-authenticated-user
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Placeholder credential; tests assert it never reaches publication state. */
const SENTINEL_TOKEN = 'ghs_TESTONLY_SENTINEL_credential_do_not_persist_7f3a';

/** Numeric identity of the default authenticated reviewer in tests. */
const DEFAULT_USER = Object.freeze({ id: 7001001, login: 'reviewer-bot' });

/**
 * Behaviors controllable per test (persisted in config.json so child
 * processes observe the same host behavior):
 *
 *   create: how createReview behaves.
 *     'ok'                    persist and return { id, htmlUrl }.
 *     'lose-response'         persist, then throw an indeterminate network error.
 *     'malformed-response'    persist, then resolve {} (no identity).
 *     'fail-before-persist'   throw an indeterminate error without persisting.
 *     'reject'                throw hostRejected (422) without persisting.
 *     'crash-before-persist'  SIGKILL the calling process before persisting.
 *     'crash-after-persist'   persist, then SIGKILL the calling process.
 *     'wrong-id-response'     persist, then return an identity naming a
 *                             different review id (a host/transport defect).
 *   singlePendingPerAuthor: GitHub allows an author only one pending review
 *     per pull request; a second create is refused with HTTP 422 and nothing
 *     is stored (observed live: docs/native-suggestion-fidelity-experiment.md,
 *     docs/evidence/native-fidelity-probe/pending-second-response.json). On by
 *     default. seedReview bypasses it: seeds that give one author several
 *     pending reviews model states the host itself cannot produce and are
 *     adversarial/corruption fixtures only.
 *   visibilityDelay: number of *later* review enumerations (listReviews with
 *     cursor null) that do not yet show a newly created review.
 *   dropCommentIndexesOnPersist: request comment indexes the host fails to store.
 *   alterCommentIndexesOnPersist: request comment indexes stored one line lower.
 *   normalizeLineEndings: host stores CRLF as LF in body and comment bodies.
 *   pageSize / commentPageSize: pagination sizes.
 *   failListPageAt: zero-based review page index whose fetch throws.
 *   reviewCursorMode / commentCursorMode: 'offset' (well-formed) or 'cycle'
 *     (returns the first page forever under two alternating cursors).
 *   malformedReviewPage: listReviews returns a page whose `reviews` is not a list.
 */
const DEFAULT_CONFIG = Object.freeze({
  create: 'ok',
  singlePendingPerAuthor: true,
  visibilityDelay: 0,
  dropCommentIndexesOnPersist: [],
  alterCommentIndexesOnPersist: [],
  normalizeLineEndings: false,
  pageSize: 30,
  commentPageSize: 30,
  failListPageAt: null,
  reviewCursorMode: 'offset',
  commentCursorMode: 'offset',
  malformedReviewPage: false,
});

const WRITE_METHODS = Object.freeze([
  'createReview',
  'updateReview',
  'submitReview',
  'deleteReview',
  'createReviewComment',
  'updateReviewComment',
  'deleteReviewComment',
]);

/** Per-process sequence for unique file names and in-process call ordering. */
let sequence = 0;
function uniqueSuffix() {
  sequence += 1;
  return `${String(process.pid).padStart(8, '0')}-${String(sequence).padStart(10, '0')}-${crypto
    .randomBytes(4)
    .toString('hex')}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

class IndeterminateNetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IndeterminateNetworkError';
    this.code = 'ECONNRESET';
  }
}

class HostRejectedError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HostRejectedError';
    this.hostRejected = true;
    this.status = status;
  }
}

class FakeGitHubRemote {
  /** Create a fresh remote rooted at `dir` (which must not already hold one). */
  static create(dir, config = {}) {
    for (const sub of ['reviews', 'ids', 'enumerations', 'calls', 'tmp']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
    const remote = new FakeGitHubRemote(dir);
    remote.writeJsonAtomic(path.join(dir, 'config.json'), { ...DEFAULT_CONFIG, ...config });
    return remote;
  }

  /** Attach to an existing remote directory (e.g. from a child process). */
  constructor(dir) {
    this.dir = dir;
  }

  /** Publish a complete JSON document at `file` via temp file + rename. */
  writeJsonAtomic(file, value) {
    const tmp = path.join(this.dir, 'tmp', uniqueSuffix());
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  }

  config() {
    return readJson(path.join(this.dir, 'config.json'));
  }

  setConfig(patch) {
    this.writeJsonAtomic(path.join(this.dir, 'config.json'), { ...this.config(), ...patch });
  }

  /** Record one call as its own atomically published file. */
  logCall(method, args) {
    const name = `${String(Date.now()).padStart(15, '0')}-${uniqueSuffix()}.json`;
    this.writeJsonAtomic(path.join(this.dir, 'calls', name), { method, pid: process.pid, args });
  }

  /** Every recorded transport call in order, optionally filtered by method. */
  calls(method) {
    const dir = path.join(this.dir, 'calls');
    const all = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => readJson(path.join(dir, f)));
    return method ? all.filter((c) => c.method === method) : all;
  }

  /** Recorded calls to any method that mutates the host. */
  writeCalls() {
    return this.calls().filter((c) => WRITE_METHODS.includes(c.method));
  }

  /** All persisted reviews (visible or not), in id order. */
  reviews() {
    const dir = path.join(this.dir, 'reviews');
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(dir, f)))
      .sort((a, b) => a.id - b.id);
  }

  review(id) {
    return readJson(this.reviewFile(id));
  }

  reviewFile(id) {
    return path.join(this.dir, 'reviews', `${String(id).padStart(8, '0')}.json`);
  }

  /** Monotonic count of review enumerations started so far (all processes). */
  enumerationCount() {
    return fs.readdirSync(path.join(this.dir, 'enumerations')).length;
  }

  startEnumeration() {
    fs.closeSync(fs.openSync(path.join(this.dir, 'enumerations', uniqueSuffix()), 'wx'));
  }

  /** Store a complete review under a freshly reserved id. */
  persistReview(fields) {
    let id = fs.readdirSync(path.join(this.dir, 'ids')).length + 1001;
    for (; ; id += 1) {
      try {
        fs.closeSync(fs.openSync(path.join(this.dir, 'ids', String(id)), 'wx'));
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    const review = {
      state: 'PENDING',
      visibilityDelay: 0,
      createdAtEnumeration: this.enumerationCount(),
      ...fields,
      id,
      htmlUrl: `https://github.com/${fields.owner}/${fields.repo}/pull/${fields.pullNumber}#pullrequestreview-${id}`,
    };
    this.writeJsonAtomic(this.reviewFile(id), review);
    return review;
  }

  /** Seed a review that some other actor created earlier (visible at once). */
  seedReview({
    owner,
    repo,
    pullNumber,
    authorId,
    authorLogin,
    commitId,
    body,
    comments = [],
    state = 'PENDING',
  }) {
    return this.persistReview({
      owner,
      repo,
      pullNumber,
      authorId,
      authorLogin,
      commitId,
      body,
      comments,
      state,
      createdAtEnumeration: -1_000_000,
    });
  }

  /** Apply a human change directly on the host (not via the transport). */
  humanChange(id, change) {
    const review = this.review(id);
    change(review);
    this.writeJsonAtomic(this.reviewFile(id), review);
  }

  humanEditBody(id, body) {
    this.humanChange(id, (r) => (r.body = body));
  }

  humanDeleteComment(id, index) {
    this.humanChange(id, (r) => r.comments.splice(index, 1));
  }

  humanSubmit(id) {
    this.humanChange(id, (r) => (r.state = 'COMMENTED'));
  }

  /** A human deletes a pending draft directly on the host. */
  humanDeleteReview(id) {
    fs.unlinkSync(this.reviewFile(id));
  }

  /**
   * A transport bound to this remote, authenticated as `user`. `events`, when
   * given, receives { op: 'createReview' } / { op: 'createReview:returned' }
   * markers so tests can order remote sends against local file operations.
   */
  transport({ user = DEFAULT_USER, events = null } = {}) {
    const remote = this;
    const push = (op) => {
      if (events) events.push({ op });
    };
    const destinationReviews = ({ owner, repo, pullNumber }) =>
      remote
        .reviews()
        .filter((r) => r.owner === owner && r.repo === repo && r.pullNumber === pullNumber);
    const nextOf = (mode, cursor, offset, size, total) => {
      if (mode === 'cycle') return cursor === 'c1' ? 'c2' : 'c1';
      return offset + size < total ? String(offset + size) : null;
    };
    const offsetOf = (mode, cursor) => (mode === 'cycle' || !cursor ? 0 : Number(cursor));

    return {
      authToken: SENTINEL_TOKEN,

      async getAuthenticatedUser() {
        remote.logCall('getAuthenticatedUser', {});
        return { ...user };
      },

      async createReview(request) {
        remote.logCall('createReview', request);
        push('createReview');
        const config = remote.config();
        const persist = () => {
          const drop = new Set(config.dropCommentIndexesOnPersist);
          const alter = new Set(config.alterCommentIndexesOnPersist);
          const text = (s) => (config.normalizeLineEndings ? s.replace(/\r\n/g, '\n') : s);
          return remote.persistReview({
            owner: request.owner,
            repo: request.repo,
            pullNumber: request.pullNumber,
            authorId: user.id,
            authorLogin: user.login,
            commitId: request.commitId,
            body: text(request.body),
            comments: request.comments
              .map((c, i) => ({ ...c, body: text(c.body), ...(alter.has(i) ? { line: c.line + 1 } : {}) }))
              .filter((_, i) => !drop.has(i)),
            state: request.event ? 'SUBMITTED' : 'PENDING',
            visibilityDelay: config.visibilityDelay,
          });
        };
        const persists = ['ok', 'lose-response', 'malformed-response', 'crash-after-persist', 'wrong-id-response'];
        const hasPending = destinationReviews(request).some(
          (r) => r.authorId === user.id && r.state === 'PENDING',
        );
        if (config.singlePendingPerAuthor && persists.includes(config.create) && !request.event && hasPending) {
          push('createReview:rejected');
          throw new HostRejectedError(422, 'Unprocessable Entity: User can only have one pending review per pull request');
        }
        switch (config.create) {
          case 'ok': {
            const review = persist();
            push('createReview:returned');
            return { id: review.id, htmlUrl: review.htmlUrl };
          }
          case 'wrong-id-response': {
            const review = persist();
            push('createReview:returned');
            return { id: review.id + 999, htmlUrl: `${review.htmlUrl}999` };
          }
          case 'lose-response':
            persist();
            throw new IndeterminateNetworkError('socket hang up after request was sent');
          case 'malformed-response':
            persist();
            push('createReview:returned');
            return {};
          case 'fail-before-persist':
            throw new IndeterminateNetworkError('connection reset before response');
          case 'reject':
            push('createReview:rejected');
            throw new HostRejectedError(422, 'Unprocessable Entity: line must be part of the diff');
          case 'crash-before-persist':
            process.kill(process.pid, 'SIGKILL');
            return new Promise(() => {});
          case 'crash-after-persist':
            persist();
            process.kill(process.pid, 'SIGKILL');
            return new Promise(() => {});
          default:
            throw new Error(`unknown create mode ${config.create}`);
        }
      },

      async listReviews({ owner, repo, pullNumber, cursor }) {
        remote.logCall('listReviews', { owner, repo, pullNumber, cursor });
        const config = remote.config();
        if (cursor === null || cursor === undefined) remote.startEnumeration();
        if (config.malformedReviewPage) return { reviews: 'not-a-list', nextCursor: null };
        const now = remote.enumerationCount();
        const offset = offsetOf(config.reviewCursorMode, cursor);
        const pageIndex = Math.floor(offset / config.pageSize);
        if (config.failListPageAt === pageIndex) {
          throw new IndeterminateNetworkError(`timeout fetching review page ${pageIndex}`);
        }
        const visible = destinationReviews({ owner, repo, pullNumber }).filter(
          (r) => now - r.createdAtEnumeration > r.visibilityDelay,
        );
        return {
          reviews: visible.slice(offset, offset + config.pageSize).map((r) => ({
            id: r.id,
            htmlUrl: r.htmlUrl,
            authorId: r.authorId,
            authorLogin: r.authorLogin,
            commitId: r.commitId,
            state: r.state,
            body: r.body,
          })),
          nextCursor: nextOf(config.reviewCursorMode, cursor, offset, config.pageSize, visible.length),
        };
      },

      async listReviewComments({ owner, repo, pullNumber, reviewId, cursor }) {
        remote.logCall('listReviewComments', { owner, repo, pullNumber, reviewId, cursor });
        const config = remote.config();
        const review = remote.review(reviewId);
        const offset = offsetOf(config.commentCursorMode, cursor);
        return {
          comments: review.comments.slice(offset, offset + config.commentPageSize).map((c) => ({ ...c })),
          nextCursor: nextOf(
            config.commentCursorMode,
            cursor,
            offset,
            config.commentPageSize,
            review.comments.length,
          ),
        };
      },

      // Writes the publisher must never issue. Recorded so misuse is observable.
      async updateReview(args) {
        remote.logCall('updateReview', args);
      },
      async submitReview(args) {
        remote.logCall('submitReview', args);
      },
      async deleteReview(args) {
        remote.logCall('deleteReview', args);
      },
      async createReviewComment(args) {
        remote.logCall('createReviewComment', args);
      },
      async updateReviewComment(args) {
        remote.logCall('updateReviewComment', args);
      },
      async deleteReviewComment(args) {
        remote.logCall('deleteReviewComment', args);
      },
    };
  }
}

module.exports = {
  DEFAULT_USER,
  FakeGitHubRemote,
  HostRejectedError,
  IndeterminateNetworkError,
  SENTINEL_TOKEN,
  WRITE_METHODS,
};
