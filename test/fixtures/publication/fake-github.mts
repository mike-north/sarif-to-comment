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
 * Private transport contract modelled here (what src/publication.cts may call):
 *
 *   getAuthenticatedUser() -> Promise<{ id: number, login?: string }>
 *     The numeric id is the stable author identity; login is mutable.
 *   createReview({ owner, repo, pullNumber, commitId, body, comments })
 *       -> Promise<{ id, htmlUrl }>
 *     `comments` items: { path, side, line, startSide?, startLine?, body };
 *     start fields are omitted for single-line comments. No `event` key
 *     leaves the review as a draft (PENDING); `event: 'COMMENT'` stores it
 *     already submitted (COMMENTED), as GitHub does.
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
  isShape,
  isString,
  readJson,
} from '../../support/runtime-types.mts';
import type { Guard, UnknownRecord } from '../../support/runtime-types.mts';

/** An authenticated reviewer identity: the numeric id is stable, the login mutable. */
export interface IFakeUser {
  readonly id: number;
  readonly login?: string | undefined;
}

/** Placeholder credential; tests assert it never reaches publication state. */
export const SENTINEL_TOKEN = 'ghs_TESTONLY_SENTINEL_credential_do_not_persist_7f3a';

/** Numeric identity of the default authenticated reviewer in tests. */
export const DEFAULT_USER: Readonly<{ id: number; login: string }> = Object.freeze({ id: 7001001, login: 'reviewer-bot' });

/** How createReview behaves (see DEFAULT_CONFIG). */
export type CreateMode =
  | 'ok'
  | 'lose-response'
  | 'malformed-response'
  | 'fail-before-persist'
  | 'reject'
  | 'crash-before-persist'
  | 'crash-after-persist'
  | 'wrong-id-response';

/** How list cursors behave: well-formed offsets, or two cursors cycling over the first page. */
export type CursorMode = 'offset' | 'cycle';

/** Host behavior, persisted in config.json (see DEFAULT_CONFIG for each field). */
export interface IFakeRemoteConfig {
  readonly create: CreateMode;
  readonly singlePendingPerAuthor: boolean;
  readonly visibilityDelay: number;
  readonly dropCommentIndexesOnPersist: readonly number[];
  readonly alterCommentIndexesOnPersist: readonly number[];
  readonly normalizeLineEndings: boolean;
  readonly pageSize: number;
  readonly commentPageSize: number;
  readonly failListPageAt: number | null;
  readonly reviewCursorMode: CursorMode;
  readonly commentCursorMode: CursorMode;
  readonly malformedReviewPage: boolean;
}

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
 *     docs/evidence/native-fidelity-probe/pending-second-response.json). The
 *     refusal is modelled for a submitted create too
 *     (docs/submitted-review-contract.md §2.6). On by default. seedReview bypasses it: seeds that give one author several
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
export const DEFAULT_CONFIG: Readonly<IFakeRemoteConfig> = Object.freeze({
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

/** Transport methods that mutate the host; the publisher may call only createReview. */
export const WRITE_METHODS: readonly string[] = Object.freeze([
  'createReview',
  'updateReview',
  'submitReview',
  'deleteReview',
  'createReviewComment',
  'updateReviewComment',
  'deleteReviewComment',
]);

/** One inline comment as requested and as the host stores it. */
export interface IStoredComment {
  readonly path: string;
  readonly side: string;
  readonly line: number;
  readonly startSide?: string | undefined;
  readonly startLine?: number | undefined;
  readonly body: string;
}

/** A review as persisted by the host (one JSON file per review). Human changes mutate it. */
export interface IStoredReview {
  owner: string;
  repo: string;
  pullNumber: number;
  authorId: number;
  authorLogin?: string | undefined;
  commitId: string;
  body: string;
  comments: IStoredComment[];
  state: string;
  visibilityDelay: number;
  createdAtEnumeration: number;
  id: number;
  htmlUrl: string;
}

/** The fields of a review to store; the host assigns id and htmlUrl. */
export interface IReviewFields {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly authorId: number;
  readonly authorLogin?: string | undefined;
  readonly commitId: string;
  readonly body: string;
  readonly comments: IStoredComment[];
  readonly state?: string;
  readonly visibilityDelay?: number;
  readonly createdAtEnumeration?: number;
}

/** A review some other actor created earlier (see seedReview). */
export interface ISeedReview {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly authorId: number;
  readonly authorLogin?: string | undefined;
  readonly commitId: string;
  readonly body: string;
  readonly comments?: IStoredComment[] | undefined;
  readonly state?: string | undefined;
}

/** One recorded transport call: method name, calling process and the call's arguments. */
export interface IRecordedCall {
  readonly method: string;
  readonly pid: number;
  readonly args: UnknownRecord;
}

/** A pull request the transport addresses. */
export interface IFakeDestination {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
}

/** createReview's request. `event` is absent (a draft) or 'COMMENT' (submitted); any value is observed, not refused. */
export interface IFakeCreateReviewRequest extends IFakeDestination {
  readonly commitId: string;
  readonly body: string;
  readonly comments: readonly IStoredComment[];
  readonly event?: unknown;
}

/** createReview's result: an identity, or `{}` for 'malformed-response'. */
export type FakeCreatedReview = { readonly id: number; readonly htmlUrl: string } | Readonly<Record<string, never>>;

/** listReviews' request; `cursor` null or absent starts an enumeration. */
export interface IFakeListReviewsRequest extends IFakeDestination {
  readonly cursor?: string | null | undefined;
}

/** A review as listReviews summarizes it. */
export interface IFakeReviewSummary {
  readonly id: number;
  readonly htmlUrl: string;
  readonly authorId: number;
  readonly authorLogin: string | undefined;
  readonly commitId: string;
  readonly state: string;
  readonly body: string;
}

/** One page of reviews; `reviews` is a string only for 'malformedReviewPage'. */
export interface IFakeReviewPage {
  readonly reviews: readonly IFakeReviewSummary[] | string;
  readonly nextCursor: string | null;
}

/** listReviewComments' request. */
export interface IFakeListReviewCommentsRequest extends IFakeDestination {
  readonly reviewId: number;
  readonly cursor?: string | null | undefined;
}

/** One page of a review's comments. */
export interface IFakeCommentPage {
  readonly comments: readonly IStoredComment[];
  readonly nextCursor: string | null;
}

/** Receives ordering markers ({ op }) from the transport; an array works. */
export interface ITransportEventSink {
  push(event: { readonly op: string }): unknown;
}

/** transport() options: the authenticated user and an optional event sink. */
export interface ITransportOptions {
  readonly user?: IFakeUser | undefined;
  readonly events?: ITransportEventSink | null | undefined;
}

/**
 * The transport a publisher receives. Methods are properties so a test can
 * wrap or replace one on a transport it holds.
 */
export interface IFakeTransport {
  authToken: string;
  getAuthenticatedUser: () => Promise<IFakeUser>;
  createReview: (request: IFakeCreateReviewRequest) => Promise<FakeCreatedReview>;
  listReviews: (request: IFakeListReviewsRequest) => Promise<IFakeReviewPage>;
  listReviewComments: (request: IFakeListReviewCommentsRequest) => Promise<IFakeCommentPage>;
  // Writes the publisher must never issue (recorded, no effect).
  updateReview: (args: UnknownRecord) => Promise<void>;
  submitReview: (args: UnknownRecord) => Promise<void>;
  deleteReview: (args: UnknownRecord) => Promise<void>;
  createReviewComment: (args: UnknownRecord) => Promise<void>;
  updateReviewComment: (args: UnknownRecord) => Promise<void>;
  deleteReviewComment: (args: UnknownRecord) => Promise<void>;
}

const isCursorMode: Guard<CursorMode> = isOneOf('offset', 'cycle');

const isRemoteConfig: Guard<IFakeRemoteConfig> = isShape({
  create: isOneOf(
    'ok',
    'lose-response',
    'malformed-response',
    'fail-before-persist',
    'reject',
    'crash-before-persist',
    'crash-after-persist',
    'wrong-id-response',
  ),
  singlePendingPerAuthor: isBoolean,
  visibilityDelay: isNumber,
  dropCommentIndexesOnPersist: isArrayOf(isNumber),
  alterCommentIndexesOnPersist: isArrayOf(isNumber),
  normalizeLineEndings: isBoolean,
  pageSize: isNumber,
  commentPageSize: isNumber,
  failListPageAt: isEither(isNumber, isNull),
  reviewCursorMode: isCursorMode,
  commentCursorMode: isCursorMode,
  malformedReviewPage: isBoolean,
});

const isStoredComment: Guard<IStoredComment> = isShape({
  path: isString,
  side: isString,
  line: isNumber,
  startSide: isOptional(isString),
  startLine: isOptional(isNumber),
  body: isString,
});

const isStoredReview: Guard<IStoredReview> = isShape({
  owner: isString,
  repo: isString,
  pullNumber: isNumber,
  authorId: isNumber,
  authorLogin: isOptional(isString),
  commitId: isString,
  body: isString,
  comments: isArrayOf(isStoredComment),
  state: isString,
  visibilityDelay: isNumber,
  createdAtEnumeration: isNumber,
  id: isNumber,
  htmlUrl: isString,
});

const isRecordedCall: Guard<IRecordedCall> = isShape({ method: isString, pid: isNumber, args: isRecord });

/** Per-process sequence for unique file names and in-process call ordering. */
let sequence = 0;
function uniqueSuffix(): string {
  sequence += 1;
  return `${String(process.pid).padStart(8, '0')}-${String(sequence).padStart(10, '0')}-${crypto
    .randomBytes(4)
    .toString('hex')}`;
}

/** Reads a JSON document this double wrote, checking it has the shape it was written with. */
function readJsonAs<T>(file: string, guard: Guard<T>, what: string): T {
  return expectType(readJson(file), guard, `${what} in ${file}`);
}

export class IndeterminateNetworkError extends Error {
  declare readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = 'IndeterminateNetworkError';
    this.code = 'ECONNRESET';
  }
}

export class HostRejectedError extends Error {
  declare readonly hostRejected: true;
  declare readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HostRejectedError';
    this.hostRejected = true;
    this.status = status;
  }
}

export class FakeGitHubRemote {
  /** Create a fresh remote rooted at `dir` (which must not already hold one). */
  static create(dir: string, config: Partial<IFakeRemoteConfig> = {}): FakeGitHubRemote {
    for (const sub of ['reviews', 'ids', 'enumerations', 'calls', 'tmp']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
    const remote = new FakeGitHubRemote(dir);
    remote.writeJsonAtomic(path.join(dir, 'config.json'), { ...DEFAULT_CONFIG, ...config });
    return remote;
  }

  readonly dir: string;

  /** Attach to an existing remote directory (e.g. from a child process). */
  constructor(dir: string) {
    this.dir = dir;
  }

  /** Publish a complete JSON document at `file` via temp file + rename. */
  writeJsonAtomic(file: string, value: unknown): void {
    const tmp = path.join(this.dir, 'tmp', uniqueSuffix());
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  }

  config(): IFakeRemoteConfig {
    return readJsonAs(path.join(this.dir, 'config.json'), isRemoteConfig, 'fake remote config');
  }

  setConfig(patch: Partial<IFakeRemoteConfig>): void {
    this.writeJsonAtomic(path.join(this.dir, 'config.json'), { ...this.config(), ...patch });
  }

  /** Record one call as its own atomically published file. */
  logCall(method: string, args: object): void {
    const name = `${String(Date.now()).padStart(15, '0')}-${uniqueSuffix()}.json`;
    this.writeJsonAtomic(path.join(this.dir, 'calls', name), { method, pid: process.pid, args });
  }

  /** Every recorded transport call in order, optionally filtered by method. */
  calls(method?: string): IRecordedCall[] {
    const dir = path.join(this.dir, 'calls');
    const all = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => readJsonAs(path.join(dir, f), isRecordedCall, 'recorded call'));
    return method ? all.filter((c) => c.method === method) : all;
  }

  /** Recorded calls to any method that mutates the host. */
  writeCalls(): IRecordedCall[] {
    return this.calls().filter((c) => WRITE_METHODS.includes(c.method));
  }

  /** All persisted reviews (visible or not), in id order. */
  reviews(): IStoredReview[] {
    const dir = path.join(this.dir, 'reviews');
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJsonAs(path.join(dir, f), isStoredReview, 'stored review'))
      .sort((a, b) => a.id - b.id);
  }

  review(id: number): IStoredReview {
    return readJsonAs(this.reviewFile(id), isStoredReview, 'stored review');
  }

  reviewFile(id: number): string {
    return path.join(this.dir, 'reviews', `${String(id).padStart(8, '0')}.json`);
  }

  /** Monotonic count of review enumerations started so far (all processes). */
  enumerationCount(): number {
    return fs.readdirSync(path.join(this.dir, 'enumerations')).length;
  }

  startEnumeration(): void {
    fs.closeSync(fs.openSync(path.join(this.dir, 'enumerations', uniqueSuffix()), 'wx'));
  }

  /** Store a complete review under a freshly reserved id. */
  persistReview(fields: IReviewFields): IStoredReview {
    let id = fs.readdirSync(path.join(this.dir, 'ids')).length + 1001;
    for (; ; id += 1) {
      try {
        fs.closeSync(fs.openSync(path.join(this.dir, 'ids', String(id)), 'wx'));
        break;
      } catch (err) {
        if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
      }
    }
    const review: IStoredReview = {
      state: 'PENDING',
      visibilityDelay: 0,
      createdAtEnumeration: this.enumerationCount(),
      ...fields,
      id,
      htmlUrl: `https://github.com/${fields.owner}/${fields.repo}/pull/${String(fields.pullNumber)}#pullrequestreview-${String(id)}`,
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
  }: ISeedReview): IStoredReview {
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
  humanChange(id: number, change: (review: IStoredReview) => unknown): void {
    const review = this.review(id);
    change(review);
    this.writeJsonAtomic(this.reviewFile(id), review);
  }

  humanEditBody(id: number, body: string): void {
    this.humanChange(id, (r) => (r.body = body));
  }

  humanDeleteComment(id: number, index: number): void {
    this.humanChange(id, (r) => r.comments.splice(index, 1));
  }

  humanSubmit(id: number): void {
    this.humanChange(id, (r) => (r.state = 'COMMENTED'));
  }

  /** A human deletes a pending draft directly on the host. */
  humanDeleteReview(id: number): void {
    fs.unlinkSync(this.reviewFile(id));
  }

  /**
   * A transport bound to this remote, authenticated as `user`. `events`, when
   * given, receives { op: 'createReview' } / { op: 'createReview:returned' }
   * markers so tests can order remote sends against local file operations.
   */
  transport({ user = DEFAULT_USER, events = null }: ITransportOptions = {}): IFakeTransport {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the transport's methods are plain functions a test may detach or replace; they reach the remote through this binding
    const remote = this;
    const push = (op: string): void => {
      if (events) events.push({ op });
    };
    const destinationReviews = ({ owner, repo, pullNumber }: IFakeDestination): IStoredReview[] =>
      remote
        .reviews()
        .filter((r) => r.owner === owner && r.repo === repo && r.pullNumber === pullNumber);
    const nextOf = (
      mode: CursorMode,
      cursor: string | null | undefined,
      offset: number,
      size: number,
      total: number,
    ): string | null => {
      if (mode === 'cycle') return cursor === 'c1' ? 'c2' : 'c1';
      return offset + size < total ? String(offset + size) : null;
    };
    const offsetOf = (mode: CursorMode, cursor: string | null | undefined): number =>
      mode === 'cycle' || !cursor ? 0 : Number(cursor);

    /* eslint-disable @typescript-eslint/require-await -- every transport method is async by contract: results and failures, including synchronous throws, reach the caller as promises */
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
        const persist = (): IStoredReview => {
          const drop = new Set(config.dropCommentIndexesOnPersist);
          const alter = new Set(config.alterCommentIndexesOnPersist);
          const text = (s: string): string => (config.normalizeLineEndings ? s.replace(/\r\n/g, '\n') : s);
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
            state: request.event === 'COMMENT' ? 'COMMENTED' : request.event === undefined ? 'PENDING' : 'SUBMITTED',
            visibilityDelay: config.visibilityDelay,
          });
        };
        const persists: readonly CreateMode[] = ['ok', 'lose-response', 'malformed-response', 'crash-after-persist', 'wrong-id-response'];
        const hasPending = destinationReviews(request).some(
          (r) => r.authorId === user.id && r.state === 'PENDING',
        );
        if (config.singlePendingPerAuthor && persists.includes(config.create) && hasPending) {
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
            return new Promise<never>(() => {});
          case 'crash-after-persist':
            persist();
            process.kill(process.pid, 'SIGKILL');
            return new Promise<never>(() => {});
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
          throw new IndeterminateNetworkError(`timeout fetching review page ${String(pageIndex)}`);
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
    /* eslint-enable @typescript-eslint/require-await */
  }
}
