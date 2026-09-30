/**
 * Outcome tests for readiness assessment's check for a pending review of the
 * authenticated account (docs/readiness-assessment-contract.md, "Pending
 * review of this account").
 *
 * GitHub lets an account hold one pending review per pull request, and it
 * refuses to create another one, draft or submitted, while it exists (HTTP
 * 422). Assessment therefore reads every review of the exact destination pull
 * request and compares each review author's stable numeric user id with the
 * authenticated account's:
 * - `blocked` only for a `PENDING` review by that same account, naming it;
 * - pending reviews by other accounts, and submitted reviews by every
 *   account, are ignored;
 * - a review list that cannot be read completely is `incomplete`, never
 *   `ready` or `blocked`;
 * - host data that leaves it undecidable whether the account has a pending
 *   review (a review listed twice with different facts, an unknown state or
 *   author for a review that could be the account's pending one) is
 *   `incomplete`; one unambiguous pending review of the account is `blocked`.
 * Assessment stays stateless: it writes nothing to GitHub or to disk, and it
 * never adopts a review because it carries a publication marker.
 *
 * Expected verdicts come from the contract and from hand-written review
 * lists, never from program output. Three layers are exercised: the private
 * client seam with the file-backed host double, the real GitHub client over
 * HTTP (fake-http-github.mts, with a hand-written paginated review list where
 * a test needs one), and the real CLI over that HTTP composition. The
 * installed-package check is in test/installed-workflow.test.mts.
 *
 * @see https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://docs.github.com/en/rest/users/users#get-the-authenticated-user
 * @see https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
 * @see docs/native-suggestion-fidelity-experiment.md (the live 422 for a second pending review)
 * @see docs/submitted-review-e2e-evidence.md (step 3: the refusal applies to a submitted create too)
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { GitHubError, createGitHubClient } from '../dist/github.cjs';
import type { ICreateGitHubClientOptions, IGitHubClient } from '../dist/github.cjs';
import library from '../dist/index.cjs';
import type { IPublishSarifReviewInput, PublishSarifReviewOutcome } from '../dist/publish-sarif-review.cjs';
import { FakeHttpGitHub, REPOSITORY as HTTP_REPOSITORY, USER as HTTP_USER } from './fixtures/composition/fake-http-github.mts';
import { DEFAULT_USER, FakeGitHubRemote } from './fixtures/publication/fake-github.mts';
import type { IFakeRemoteConfig, IStoredReview } from './fixtures/publication/fake-github.mts';
import { REPOSITORY, createFakeClientFactory } from './fixtures/public-api/fake-adapter.mts';
import { asArray, asRecord, asString, parseJson, readJson } from './support/runtime-types.mts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBLIC_API = path.join(import.meta.dirname, 'fixtures', 'public-api');
const READY = asRecord(readJson(path.join(PUBLIC_API, 'ready.sarif.json')), 'ready.sarif.json');
const INVALID = asRecord(readJson(path.join(PUBLIC_API, 'invalid.sarif.json')), 'invalid.sarif.json');

const DESTINATION = REPOSITORY.destination;
const WHERE = `${DESTINATION.owner}/${DESTINATION.repo}#${String(DESTINATION.pullNumber)}`;
const HEAD = REPOSITORY.commits.head;
const TOKEN = 'ghp_PENDING_REVIEW_SENTINEL_token_86420';

/** The authenticated account of the host double (stable id 7001001). */
const ME = DEFAULT_USER;
/** Another account. Its login is the authenticated account's, so only the stable id can tell them apart. */
const OTHER = { id: 8002002, login: ME.login };

/** Every submitted review state GitHub reports; none of them is a pending review. */
const SUBMITTED_STATES = ['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'] as const;

// ---------------------------------------------------------------------------
// Outcome reading
// ---------------------------------------------------------------------------

interface IProblemView {
  readonly message: string;
  readonly pointer?: string;
}

interface IAssessment {
  readonly status: string;
  readonly markdown: string;
  readonly problems?: readonly IProblemView[];
  readonly keys: readonly string[];
}

function asAssessment(value: unknown): IAssessment {
  const record = asRecord(value, 'an assessment outcome');
  const problems =
    record['problems'] === undefined
      ? undefined
      : asArray(record['problems'], 'problems').map((p): IProblemView => {
          const problem = asRecord(p, 'a problem');
          const pointer = problem['pointer'];
          const message = asString(problem['message'], 'a problem message');
          return pointer === undefined ? { message } : { message, pointer: asString(pointer, 'a problem pointer') };
        });
  return {
    status: asString(record['status'], 'status'),
    markdown: asString(record['markdown'], 'markdown'),
    ...(problems === undefined ? {} : { problems }),
    keys: Object.keys(record),
  };
}

/** The problems of a blocked outcome (the assertion fails for any other status). */
function problemsOf(outcome: IAssessment): readonly IProblemView[] {
  assert.equal(outcome.status, 'blocked', outcome.markdown);
  assert.ok(outcome.problems !== undefined, 'a blocked outcome has problems');
  return outcome.problems;
}

/**
 * The contract's blocker for one pending review of the account: it names the
 * pull request, the review's id and URL, why GitHub would refuse, and what to
 * do, and has no pointer (it is not in the document).
 */
function assertNamesPendingReview(outcome: IAssessment, review: { readonly id: number; readonly htmlUrl: string }, where = WHERE): void {
  const problems = problemsOf(outcome);
  const problem = problems.find((p) => p.message.includes(`review ${String(review.id)}`));
  assert.ok(problem !== undefined, `a problem names review ${String(review.id)}: ${JSON.stringify(problems)}`);
  assert.equal(problem.pointer, undefined, 'the obstacle is not in the document');
  assert.ok(problem.message.includes(where), 'the pull request is named');
  assert.ok(problem.message.includes(review.htmlUrl), 'the review URL is named');
  assert.match(problem.message, /already has a pending review/);
  assert.match(problem.message, /one pending review per account/);
  assert.match(problem.message, /as a draft or as a submitted comment review/);
  assert.match(problem.message, /Submit or delete that pending review on GitHub/);
  assert.match(problem.message, /state path/, 'an earlier publication is recovered by publish, not adopted here');
  assert.match(outcome.markdown, /^## Review blocked\n\nNothing was published and no publication state was written\./);
  for (const p of problems) assert.ok(outcome.markdown.includes(p.message), 'every problem appears in the Markdown');
  assert.equal(outcome.markdown.includes(TOKEN), false, 'the token never appears');
  assert.deepEqual(outcome.keys, ['status', 'problems', 'markdown'], 'the documented blocked fields, in order');
}

function assertIncomplete(outcome: IAssessment, mentions: RegExp): void {
  assert.equal(outcome.status, 'incomplete', outcome.markdown);
  assert.deepEqual(outcome.keys, ['status', 'markdown']);
  assert.match(outcome.markdown, /^## Readiness could not be assessed\n/);
  assert.match(outcome.markdown, mentions, 'the cause is named');
  assert.match(outcome.markdown, /not a verdict/i);
  assert.equal(outcome.markdown.includes(TOKEN), false, 'the token never appears');
}

function assertReady(outcome: IAssessment): void {
  assert.equal(outcome.status, 'ready', outcome.markdown);
  assert.deepEqual(outcome.keys, ['status', 'markdown']);
}

// ---------------------------------------------------------------------------
// The private client seam with the file-backed host double
// ---------------------------------------------------------------------------

/** A createGitHubClient for the private seam; the product checks every answer itself. */
type ClientFactory = (options: ICreateGitHubClientOptions) => object;

interface IWorld {
  readonly root: string;
  readonly statePath: string;
  readonly remote: FakeGitHubRemote;
  readonly createGitHubClient: ClientFactory;
}

function makeWorld(config: Partial<IFakeRemoteConfig> = {}): IWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'validate-pending-')));
  const remote = FakeGitHubRemote.create(path.join(root, 'remote'), config);
  return { root, statePath: path.join(root, 'review.publication.json'), remote, createGitHubClient: createFakeClientFactory(remote.dir) };
}

/** A review another actor (or an earlier run) left on the destination pull request. */
function seed(world: IWorld, author: { readonly id: number; readonly login?: string }, state: string, body = 'Earlier feedback.'): IStoredReview {
  return world.remote.seedReview({ ...DESTINATION, authorId: author.id, authorLogin: author.login, commitId: HEAD, body, state });
}

function input(sarif: Record<string, unknown> = READY, options?: Record<string, unknown>): Record<string, unknown> {
  return {
    sarif: structuredClone(sarif),
    destination: { ...DESTINATION },
    reviewedCommit: HEAD,
    token: TOKEN,
    ...(options === undefined ? {} : { options }),
  };
}

/** The public validateSarifReview, with a client injected through the private seam it honours at runtime. */
async function validate(factory: ClientFactory, value: unknown): Promise<IAssessment> {
  const validateSarifReview: unknown = Reflect.get(library, 'validateSarifReview');
  if (typeof validateSarifReview !== 'function') throw new assert.AssertionError({ message: 'the package exports validateSarifReview' });
  const outcome: unknown = await Reflect.apply(validateSarifReview, undefined, [value, { createGitHubClient: factory }]);
  return asAssessment(outcome);
}

function publish(world: IWorld, options?: { readonly submit: boolean }, sarif: Record<string, unknown> = READY): Promise<PublishSarifReviewOutcome> {
  const publication: IPublishSarifReviewInput = {
    sarif: structuredClone(sarif),
    destination: { ...DESTINATION },
    reviewedCommit: HEAD,
    statePath: world.statePath,
    token: TOKEN,
    ...(options === undefined ? {} : { options }),
  };
  return library.publishSarifReview(
    publication,
    // @ts-expect-error -- the private internals seam is deliberately absent from the public declaration; this suite injects the fake client through the seam the public entry honours at runtime
    { createGitHubClient: world.createGitHubClient },
  );
}

/** Every file below the world root other than the host double's own directory. */
function localFiles(world: IWorld): string[] {
  return fs
    .readdirSync(world.root, { recursive: true, encoding: 'utf8' })
    .filter((name) => !name.startsWith('remote'))
    .sort();
}

/**
 * Zero remote writes and zero local publication state (contract:
 * Guarantees): the host holds exactly the reviews it held before, and no
 * file appeared.
 */
function assertNothingWritten(world: IWorld, reviewsBefore: readonly IStoredReview[], filesBefore: readonly string[] = []): void {
  assert.deepEqual(world.remote.writeCalls(), [], 'no remote write');
  assert.deepEqual(world.remote.reviews(), reviewsBefore, 'the host holds exactly the reviews it held before');
  assert.deepEqual(localFiles(world), filesBefore, 'no file was written');
}

/** A recorded read of the scripted review list. */
interface IListCall {
  readonly owner: unknown;
  readonly repo: unknown;
  readonly pullNumber: unknown;
  readonly cursor: unknown;
}

/**
 * The world's client with `listReviews` answering from hand-written pages
 * (page i is read with cursor null for i = 0, else `page-<i>`), or failing
 * with `fail(i)` when that returns an error. Every other method is the host
 * double's.
 */
function scriptedReviews(
  world: IWorld,
  pages: readonly (readonly unknown[])[],
  fail: (page: number) => Error | undefined = () => undefined,
): { readonly factory: ClientFactory; readonly calls: IListCall[] } {
  const calls: IListCall[] = [];
  const factory: ClientFactory = (options) => ({
    ...world.createGitHubClient(options),
    // eslint-disable-next-line @typescript-eslint/require-await -- the client contract is asynchronous: a failure reaches the caller as a rejection
    listReviews: async ({ owner, repo, pullNumber, cursor }: IListCall): Promise<unknown> => {
      calls.push({ owner, repo, pullNumber, cursor });
      const index = typeof cursor === 'string' ? Number(cursor.replace('page-', '')) : 0;
      const failure = fail(index);
      if (failure !== undefined) throw failure;
      const reviews = pages[index];
      if (reviews === undefined) throw new Error(`test harness: no page ${String(index)}`);
      return { reviews, nextCursor: index + 1 < pages.length ? `page-${String(index + 1)}` : null };
    },
  });
  return { factory, calls };
}

/** A review summary as the client reports one (src/github.cts listReviews). */
function summary(id: number, authorId: unknown, state: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    htmlUrl: `https://github.com/acme/gizmos/pull/7#pullrequestreview-${String(id)}`,
    authorId,
    authorLogin: 'whoever',
    commitId: HEAD,
    state,
    body: 'Feedback.',
    ...extra,
  };
}

describe('a pending review of the authenticated account blocks; nothing else about reviews does', () => {
  test('a pending review by the same account is blocked, naming the review, with nothing written', async () => {
    const world = makeWorld();
    const pending = seed(world, ME, 'PENDING');
    const before = world.remote.reviews();
    const outcome = await validate(world.createGitHubClient, input());
    assertNamesPendingReview(outcome, pending);
    assert.equal(problemsOf(outcome).length, 1, 'one pending review, one problem');
    assertNothingWritten(world, before);
  });

  test('the account is recognized by its stable id, not its login: a renamed account is still blocked', async () => {
    const world = makeWorld();
    const pending = seed(world, { id: ME.id, login: 'old-login-before-rename' }, 'PENDING');
    assertNamesPendingReview(await validate(world.createGitHubClient, input()), pending);
  });

  test('a pending review by another account is ignored, even when that account shows the same login', async () => {
    const world = makeWorld();
    seed(world, OTHER, 'PENDING');
    const before = world.remote.reviews();
    assertReady(await validate(world.createGitHubClient, input()));
    assertNothingWritten(world, before);
  });

  for (const state of SUBMITTED_STATES) {
    test(`a submitted (${state}) review by the same account is ignored`, async () => {
      const world = makeWorld();
      seed(world, ME, state);
      seed(world, OTHER, state);
      const before = world.remote.reviews();
      assertReady(await validate(world.createGitHubClient, input()));
      assertNothingWritten(world, before);
    });
  }

  test('submitted mode is blocked by the same pending review: GitHub refuses a submitted create too', async () => {
    const world = makeWorld();
    const pending = seed(world, ME, 'PENDING');
    const before = world.remote.reviews();
    assertNamesPendingReview(await validate(world.createGitHubClient, input(READY, { submit: true })), pending);
    assertNothingWritten(world, before);
  });

  test('the review list read is for exactly the destination pull request, after the authenticated user', async () => {
    const world = makeWorld();
    assertReady(await validate(world.createGitHubClient, input()));
    const methods = world.remote.calls().map((c) => c.method);
    assert.deepEqual(
      methods.filter((m) => m !== 'adapter:create' && m !== 'adapter:fetchContext'),
      ['getAuthenticatedUser', 'listReviews'],
      'one user lookup, then one review page; no readback of any review',
    );
    const [list] = world.remote.calls('listReviews');
    assert.deepEqual(list?.args, { ...DESTINATION, cursor: null });
  });

  test('a document publication would block is reported exactly as publication reports it; reviews are not read', async () => {
    const world = makeWorld();
    seed(world, ME, 'PENDING');
    const before = world.remote.reviews();
    const outcome = await validate(world.createGitHubClient, input(INVALID));
    assert.equal(outcome.status, 'blocked');
    assert.equal(world.remote.calls('listReviews').length, 0, 'publication blocks before it would reach GitHub');
    assert.equal(outcome.markdown.includes('pending review'), false, 'only the document problems are reported');
    const publication = await publish(makeWorld(), undefined, INVALID);
    assert.equal(publication.status, 'blocked');
    assert.equal(outcome.markdown, publication.markdown, 'the publisher’s own blocked explanation');
    assertNothingWritten(world, before);
  });

  test('a pending review this tool published earlier is still blocked: assessment never adopts a marked review', async () => {
    const world = makeWorld();
    const first = await publish(world);
    assert.equal(first.status, 'published', first.markdown);
    const [earlier] = world.remote.reviews();
    assert.ok(earlier !== undefined && earlier.state === 'PENDING', 'the earlier publication is a pending draft');
    assert.match(earlier.body, /<!-- sarif-to-comment:review:[0-9a-f-]{36} -->/, 'it carries the publication marker');
    const stateBefore = fs.readFileSync(world.statePath);
    const before = world.remote.reviews();
    const filesBefore = localFiles(world);

    const outcome = await validate(world.createGitHubClient, input());
    assertNamesPendingReview(outcome, earlier);
    assert.equal(world.remote.calls('listReviewComments').length, 0, 'no review is read back or matched against a publication');
    assert.deepEqual(fs.readFileSync(world.statePath), stateBefore, 'the earlier publication state is untouched');
    assertNothingWritten(world, before, filesBefore);
  });

  test('two pending reviews of the account (host data GitHub should not produce) are both named', async () => {
    const world = makeWorld();
    const a = seed(world, ME, 'PENDING');
    const b = seed(world, ME, 'PENDING');
    const outcome = await validate(world.createGitHubClient, input());
    assertNamesPendingReview(outcome, a);
    assertNamesPendingReview(outcome, b);
    assert.equal(problemsOf(outcome).length, 2);
  });
});

describe('parity with publication on the same remote', () => {
  test('a pending review of the account: assessment is blocked, and GitHub refuses publication in both modes', async () => {
    for (const options of [undefined, { submit: true }]) {
      const assessed = makeWorld();
      seed(assessed, ME, 'PENDING');
      assert.equal((await validate(assessed.createGitHubClient, input(READY, options))).status, 'blocked');

      const published = makeWorld();
      seed(published, ME, 'PENDING');
      const publication = await publish(published, options);
      assert.equal(publication.status, 'rejected', publication.markdown);
      assert.match(publication.markdown, /one pending review/i, 'GitHub’s 422 names the same obstacle');
    }
  });

  test('another account’s pending review and the account’s submitted review: assessment is ready, and publication publishes', async () => {
    const assessed = makeWorld();
    seed(assessed, OTHER, 'PENDING');
    seed(assessed, ME, 'COMMENTED');
    assertReady(await validate(assessed.createGitHubClient, input()));

    const published = makeWorld();
    seed(published, OTHER, 'PENDING');
    seed(published, ME, 'COMMENTED');
    const publication = await publish(published);
    assert.equal(publication.status, 'published', publication.markdown);
  });

  test('a ready assessment is not a stamp: a pending review started afterwards makes publication refuse', async () => {
    const world = makeWorld();
    assertReady(await validate(world.createGitHubClient, input()));
    seed(world, ME, 'PENDING');
    const publication = await publish(world);
    assert.equal(publication.status, 'rejected', publication.markdown);
    assert.equal(world.remote.calls('createReview').length, 1, 'publication checked with its own create request');
  });
});

describe('pagination: every page of the review list is read before any verdict', () => {
  test('a pending review of the account on the last of three pages is blocked', async () => {
    const world = makeWorld({ pageSize: 2 });
    seed(world, OTHER, 'PENDING');
    seed(world, OTHER, 'COMMENTED');
    seed(world, ME, 'APPROVED');
    seed(world, ME, 'COMMENTED');
    const pending = seed(world, ME, 'PENDING');
    const outcome = await validate(world.createGitHubClient, input());
    assertNamesPendingReview(outcome, pending);
    assert.deepEqual(world.remote.calls('listReviews').map((c) => c.args['cursor']), [null, '2', '4'], 'three pages, in order');
  });

  test('three pages without a pending review of the account are ready, after reading all three', async () => {
    const world = makeWorld({ pageSize: 2 });
    seed(world, OTHER, 'PENDING');
    seed(world, OTHER, 'COMMENTED');
    seed(world, ME, 'APPROVED');
    seed(world, ME, 'COMMENTED');
    seed(world, OTHER, 'PENDING');
    assertReady(await validate(world.createGitHubClient, input()));
    assert.equal(world.remote.calls('listReviews').length, 3);
  });

  test('an empty review list is ready', async () => {
    const world = makeWorld();
    assertReady(await validate(world.createGitHubClient, input()));
  });
});

describe('a review list that cannot be read completely is incomplete, never ready or blocked', () => {
  test('a page that fails after a page with no pending review is incomplete, not ready', async () => {
    const world = makeWorld({ pageSize: 2, failListPageAt: 1 });
    seed(world, OTHER, 'COMMENTED');
    seed(world, OTHER, 'PENDING');
    seed(world, ME, 'PENDING');
    const before = world.remote.reviews();
    const outcome = await validate(world.createGitHubClient, input());
    assertIncomplete(outcome, /timeout fetching review page 1/);
    assertNothingWritten(world, before);
  });

  test('a page that fails after a page showing the account’s pending review is incomplete, not blocked', async () => {
    const world = makeWorld({ pageSize: 2, failListPageAt: 1 });
    seed(world, ME, 'PENDING');
    seed(world, OTHER, 'COMMENTED');
    seed(world, OTHER, 'PENDING');
    assertIncomplete(await validate(world.createGitHubClient, input()), /timeout fetching review page 1/);
  });

  test('a first page that fails is incomplete', async () => {
    const world = makeWorld({ failListPageAt: 0 });
    assertIncomplete(await validate(world.createGitHubClient, input()), /timeout fetching review page 0/);
  });

  test('a malformed page is incomplete', async () => {
    const world = makeWorld({ malformedReviewPage: true });
    assertIncomplete(await validate(world.createGitHubClient, input()), /malformed page/);
  });

  test('pagination that repeats a cursor is incomplete, not an endless read', async () => {
    const world = makeWorld({ reviewCursorMode: 'cycle' });
    seed(world, ME, 'PENDING');
    assertIncomplete(await validate(world.createGitHubClient, input()), /repeated a pagination cursor/);
  });

  test('a refused review-list read (HTTP 403) is incomplete and names the refusal', async () => {
    const world = makeWorld();
    const refused = new GitHubError('http-status', 'GitHub answered HTTP 403 (Resource not accessible by personal access token) for the review list.', { status: 403 });
    const { factory } = scriptedReviews(world, [[]], () => refused);
    const outcome = await validate(factory, input());
    assertIncomplete(outcome, /HTTP 403/);
    assertNothingWritten(world, []);
  });

  test('a review-list failure that quotes the token is incomplete and redacted', async () => {
    const world = makeWorld();
    const { factory } = scriptedReviews(world, [[]], () => new Error(`GET reviews failed; Authorization: Bearer ${TOKEN}`));
    const outcome = await validate(factory, input());
    assertIncomplete(outcome, /\[redacted\]/);
  });
});

describe('duplicate or ambiguous host data is decided conservatively', () => {
  const pendingOfMine = summary(501, ME.id, 'PENDING');

  test('the same pending review listed on two pages is one review, named once', async () => {
    const { factory, calls } = scriptedReviews(makeWorld(), [[pendingOfMine, summary(502, OTHER.id, 'COMMENTED')], [pendingOfMine]]);
    const outcome = await validate(factory, input());
    assert.equal(problemsOf(outcome).length, 1);
    assertNamesPendingReview(outcome, { id: 501, htmlUrl: 'https://github.com/acme/gizmos/pull/7#pullrequestreview-501' });
    assert.deepEqual(calls.map((c) => c.cursor), [null, 'page-1']);
    assert.deepEqual(calls.map((c) => [c.owner, c.repo, c.pullNumber]), [[DESTINATION.owner, DESTINATION.repo, DESTINATION.pullNumber], [DESTINATION.owner, DESTINATION.repo, DESTINATION.pullNumber]]);
  });

  test('one review listed as pending and again as submitted is incomplete: which is true cannot be decided', async () => {
    const { factory } = scriptedReviews(makeWorld(), [[pendingOfMine], [summary(501, ME.id, 'COMMENTED')]]);
    assertIncomplete(await validate(factory, input()), /review 501 is listed more than once with different authors or states/);
  });

  test('one review listed under two different authors is incomplete', async () => {
    const { factory } = scriptedReviews(makeWorld(), [[pendingOfMine, summary(501, OTHER.id, 'PENDING')]]);
    assertIncomplete(await validate(factory, input()), /review 501 is listed more than once/);
  });

  test('a pending review without a numeric author id is incomplete: it could be the account’s', async () => {
    for (const author of [null, String(ME.id), 0, 1.5]) {
      const { factory } = scriptedReviews(makeWorld(), [[summary(601, author, 'PENDING')]]);
      assertIncomplete(await validate(factory, input()), /review 601 has no numeric author id/);
    }
  });

  test('a submitted review without a numeric author id (for example a deleted account) is ignored', async () => {
    const { factory } = scriptedReviews(makeWorld(), [[summary(602, null, 'COMMENTED'), summary(603, null, 'DISMISSED')]]);
    assertReady(await validate(factory, input()));
  });

  test('a review of the account in a state GitHub does not document is incomplete', async () => {
    for (const state of ['pending', 'DRAFT', null, undefined, 3]) {
      const { factory } = scriptedReviews(makeWorld(), [[summary(701, ME.id, state)]]);
      assertIncomplete(await validate(factory, input()), /review 701 of this account has an unknown state/);
    }
  });

  test('a review of another account in an undocumented state is ignored', async () => {
    const { factory } = scriptedReviews(makeWorld(), [[summary(702, OTHER.id, 'DRAFT'), summary(703, OTHER.id, null)]]);
    assertReady(await validate(factory, input()));
  });

  test('a listed review without a numeric id is incomplete', async () => {
    const { factory } = scriptedReviews(makeWorld(), [[{ ...summary(1, ME.id, 'PENDING'), id: 'PRR_1' }]]);
    assertIncomplete(await validate(factory, input()), /a listed review has no numeric id/);
  });

  test('an unambiguous pending review of the account is blocked even beside an ambiguous entry', async () => {
    const { factory } = scriptedReviews(makeWorld(), [[summary(801, null, 'PENDING'), pendingOfMine]]);
    const outcome = await validate(factory, input());
    assertNamesPendingReview(outcome, { id: 501, htmlUrl: 'https://github.com/acme/gizmos/pull/7#pullrequestreview-501' });
    assert.equal(problemsOf(outcome).length, 1, 'the ambiguous entry is not reported as a pending review');
  });

  test('a pending review of the account without a URL is still named by its id', async () => {
    const { factory } = scriptedReviews(makeWorld(), [[summary(901, ME.id, 'PENDING', { htmlUrl: null })]]);
    const problems = problemsOf(await validate(factory, input()));
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.message ?? '', /already has a pending review on acme\/gizmos#7: review 901\. /);
  });
});

// ---------------------------------------------------------------------------
// The real GitHub client over HTTP, and the real CLI over it
// ---------------------------------------------------------------------------

const COMPOSITION = path.join(import.meta.dirname, 'fixtures', 'composition');
const HTTP_SARIF = asRecord(readJson(path.join(COMPOSITION, 'review.sarif.json')), 'the composition SARIF');
const HTTP_CLI = path.join(COMPOSITION, 'cli-with-fake-http.mts');
const HTTP_DESTINATION = HTTP_REPOSITORY.destination;
const HTTP_WHERE = `${HTTP_DESTINATION.owner}/${HTTP_DESTINATION.repo}#${String(HTTP_DESTINATION.pullNumber)}`;
const HTTP_HEAD = HTTP_REPOSITORY.commits.head;
const REVIEWS_PATH = `/repos/${HTTP_DESTINATION.owner}/${HTTP_DESTINATION.repo}/pulls/${String(HTTP_DESTINATION.pullNumber)}/reviews`;
const API = 'https://api.github.com';

interface IHttpWorld {
  readonly root: string;
  readonly host: FakeHttpGitHub;
}

function httpWorld(): IHttpWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'validate-pending-http-')));
  FakeHttpGitHub.create(path.join(root, 'host'));
  return { root, host: new FakeHttpGitHub(path.join(root, 'host'), TOKEN) };
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function httpInput(options?: Record<string, unknown>): Record<string, unknown> {
  return {
    sarif: structuredClone(HTTP_SARIF),
    destination: { ...HTTP_DESTINATION },
    reviewedCommit: HTTP_HEAD,
    token: TOKEN,
    ...(options === undefined ? {} : { options }),
  };
}

function httpPublication(statePath: string): IPublishSarifReviewInput {
  return { sarif: structuredClone(HTTP_SARIF), destination: { ...HTTP_DESTINATION }, reviewedCommit: HTTP_HEAD, statePath, token: TOKEN };
}

function realClient(fetch: Fetch): (options: ICreateGitHubClientOptions) => IGitHubClient {
  return (options) => createGitHubClient({ ...options, fetch });
}

async function validateOver(fetch: Fetch, options?: Record<string, unknown>): Promise<IAssessment> {
  return validate(realClient(fetch), httpInput(options));
}

/** A review as GitHub's REST list returns it. */
function wireReview(id: number, user: { readonly id: number; readonly login: string } | null, state: string): Record<string, unknown> {
  return {
    id,
    user,
    body: 'Feedback.',
    state,
    html_url: `https://github.com/${HTTP_DESTINATION.owner}/${HTTP_DESTINATION.repo}/pull/${String(HTTP_DESTINATION.pullNumber)}#pullrequestreview-${String(id)}`,
    commit_id: HTTP_HEAD,
  };
}

function jsonResponse(body: unknown, status: number, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * The host's fetch, with GET of the review list answered from hand-written
 * pages linked by rel="next" (as GitHub paginates), or with `status` when a
 * page is a number. Every list request URL is recorded.
 */
function paginatedReviews(world: IHttpWorld, pages: readonly (readonly unknown[] | number)[]): { readonly fetch: Fetch; readonly urls: string[] } {
  const urls: string[] = [];
  const fetch: Fetch = (target, init = {}) => {
    const url = new URL(target instanceof Request ? target.url : target);
    if ((init.method ?? 'GET') !== 'GET' || url.pathname !== REVIEWS_PATH) return world.host.fetch(target, init);
    urls.push(url.pathname + url.search);
    const page = Number(url.searchParams.get('page') ?? '1');
    const answer = pages[page - 1];
    if (answer === undefined) return Promise.resolve(jsonResponse({ message: 'Not Found' }, 404));
    if (typeof answer === 'number') return Promise.resolve(jsonResponse({ message: 'Refused' }, answer));
    const link = page < pages.length ? { link: `<${API}${REVIEWS_PATH}?per_page=100&page=${String(page + 1)}>; rel="next"` } : {};
    return Promise.resolve(jsonResponse(answer, 200, link));
  };
  return { fetch, urls };
}

const NOBODY = { id: 99_001, login: HTTP_USER.login };

describe('the real GitHub client over HTTP', () => {
  test('after a draft publication, assessment is blocked naming that draft, in both modes, using only GET requests', async () => {
    const world = httpWorld();
    const published = asRecord(
      await library.publishSarifReview(
        httpPublication(path.join(world.root, 'state.json')),
        // @ts-expect-error -- the private internals seam is deliberately absent from the public declaration
        { createGitHubClient: realClient(world.host.fetch) },
      ),
      'the publication outcome',
    );
    assert.equal(published['status'], 'published', asString(published['markdown']));
    const [draft] = world.host.reviews();
    assert.ok(draft !== undefined && draft.state === 'PENDING');
    const requestsBefore = world.host.log().length;
    const filesBefore = fs.readdirSync(world.root).sort();

    for (const options of [undefined, { submit: true }]) {
      const outcome = await validateOver(world.host.fetch, options);
      assertNamesPendingReview(
        outcome,
        { id: draft.id, htmlUrl: `https://github.com/${HTTP_DESTINATION.owner}/${HTTP_DESTINATION.repo}/pull/${String(HTTP_DESTINATION.pullNumber)}#pullrequestreview-${String(draft.id)}` },
        HTTP_WHERE,
      );
    }
    const since = world.host.log().slice(requestsBefore);
    assert.deepEqual([...new Set(since.map((r) => r.method))], ['GET'], 'assessment issued only GET requests');
    assert.ok(since.some((r) => r.path === REVIEWS_PATH), 'the review list was read');
    assert.equal(world.host.reviews().length, 1, 'no review was created, submitted or deleted');
    assert.deepEqual(fs.readdirSync(world.root).sort(), filesBefore, 'no file was written');
  });

  test('a pending review of the account on the third linked page is blocked; every page is requested in order', async () => {
    const world = httpWorld();
    const { fetch, urls } = paginatedReviews(world, [
      [wireReview(11, NOBODY, 'PENDING'), wireReview(12, NOBODY, 'COMMENTED')],
      [wireReview(13, HTTP_USER, 'COMMENTED'), wireReview(14, HTTP_USER, 'APPROVED'), wireReview(15, null, 'DISMISSED')],
      [wireReview(16, HTTP_USER, 'PENDING')],
    ]);
    const outcome = await validateOver(fetch);
    assertNamesPendingReview(outcome, { id: 16, htmlUrl: asString(wireReview(16, HTTP_USER, 'PENDING')['html_url']) }, HTTP_WHERE);
    assert.equal(problemsOf(outcome).length, 1);
    assert.deepEqual(urls, [
      `${REVIEWS_PATH}?per_page=100&page=1`,
      `${REVIEWS_PATH}?per_page=100&page=2`,
      `${REVIEWS_PATH}?per_page=100&page=3`,
    ]);
    assert.deepEqual(world.host.reviews(), []);
  });

  test('linked pages with only other accounts’ pending reviews and submitted reviews are ready', async () => {
    const world = httpWorld();
    const { fetch, urls } = paginatedReviews(world, [
      [wireReview(21, NOBODY, 'PENDING')],
      [wireReview(22, HTTP_USER, 'CHANGES_REQUESTED'), wireReview(23, HTTP_USER, 'DISMISSED')],
    ]);
    assertReady(await validateOver(fetch));
    assert.equal(urls.length, 2);
  });

  test('a refused later page is incomplete even though an earlier page showed the account’s pending review', async () => {
    const world = httpWorld();
    const { fetch } = paginatedReviews(world, [[wireReview(31, HTTP_USER, 'PENDING')], 403]);
    assertIncomplete(await validateOver(fetch), /403/);
  });

  test('a review list GitHub answers with a server error is incomplete', async () => {
    const world = httpWorld();
    const { fetch } = paginatedReviews(world, [502]);
    assertIncomplete(await validateOver(fetch), /502/);
  });

  test('a review list page that is not a list is incomplete', async () => {
    const world = httpWorld();
    const broken: Fetch = (target, init = {}) => {
      const url = new URL(target instanceof Request ? target.url : target);
      if (url.pathname === REVIEWS_PATH && (init.method ?? 'GET') === 'GET') return Promise.resolve(jsonResponse({ reviews: [] }, 200));
      return world.host.fetch(target, init);
    };
    assertIncomplete(await validateOver(broken), /not a list/);
  });
});

describe('the real CLI over HTTP: human and JSON output, exit status 2', () => {
  function cli(world: IHttpWorld, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
    const sarifPath = path.join(world.root, 'review.sarif');
    fs.writeFileSync(sarifPath, JSON.stringify(HTTP_SARIF));
    const result = spawnSync(
      process.execPath,
      [HTTP_CLI, 'validate', '--sarif', sarifPath, '--repo', `${HTTP_DESTINATION.owner}/${HTTP_DESTINATION.repo}`, '--pull', String(HTTP_DESTINATION.pullNumber), '--commit', HTTP_HEAD, ...args],
      { cwd: world.root, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env['PATH'], GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: world.host.dir } },
    );
    fs.rmSync(sarifPath);
    for (const text of [result.stdout, result.stderr]) assert.equal(text.includes(TOKEN), false, 'the token never appears');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  test('a pending review of the account: exit 2 in both formats, carrying the library problems and Markdown exactly', async () => {
    const world = httpWorld();
    const statePath = path.join(world.root, 'state.json');
    const published = asRecord(
      await library.publishSarifReview(
        httpPublication(statePath),
        // @ts-expect-error -- the private internals seam is deliberately absent from the public declaration
        { createGitHubClient: realClient(world.host.fetch) },
      ),
      'the publication outcome',
    );
    assert.equal(published['status'], 'published');
    const libraryOutcome = await validateOver(world.host.fetch);
    assert.equal(libraryOutcome.status, 'blocked');
    const posts = (): number => world.host.log().filter((r) => r.method === 'POST').length;
    const postsBefore = posts();

    const json = cli(world, ['--format', 'json']);
    assert.equal(json.status, 2, json.stdout + json.stderr);
    assert.equal(json.stderr, '');
    const doc = asRecord(parseJson(json.stdout), 'the JSON document');
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'problems', 'message']);
    assert.equal(doc['command'], 'validate');
    assert.equal(doc['status'], 'blocked');
    assert.deepEqual(doc['problems'], libraryOutcome.problems, 'the CLI carries the library problems');
    assert.equal(doc['message'], libraryOutcome.markdown, 'the CLI carries the library Markdown');

    const human = cli(world, []);
    assert.equal(human.status, 2, human.stdout + human.stderr);
    assert.equal(human.stderr, '');
    assert.equal(human.stdout, `${libraryOutcome.markdown}\n`);

    assert.equal(posts(), postsBefore, 'the CLI wrote nothing to GitHub');
    assert.equal(world.host.reviews().length, 1);
    assert.deepEqual(fs.readdirSync(world.root).sort(), ['host', 'state.json'], 'no file beyond the earlier publication state');
  });

  test('no pending review: exit 0 in JSON, as before', () => {
    const world = httpWorld();
    const json = cli(world, ['--format', 'json']);
    assert.equal(json.status, 0, json.stdout + json.stderr);
    const doc = asRecord(parseJson(json.stdout), 'the JSON document');
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'message']);
    assert.equal(doc['status'], 'ready');
    assert.ok(world.host.log().some((r) => r.method === 'GET' && r.path === REVIEWS_PATH), 'the review list was read');
  });
});
