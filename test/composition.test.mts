/**
 * Production-composition tests: the real public library (src/index.cts) and
 * the real CLI, composed with the real GitHub client (src/github.cts), talking
 * HTTP to a fake GitHub (test/fixtures/composition/fake-http-github.mts).
 * Only `fetch` is replaced. The other API/CLI suites replace the whole client;
 * these tests cover what they cannot: source reads through git objects, patch
 * reverse-verification of old-side source, the create-review wire format,
 * pending-comment readback normalized from review threads, and delivery
 * confirmation over that readback.
 *
 * Expectations are hand-authored in test/fixtures/composition/repository.json
 * from the snapshots and the SARIF, never captured from program output. An
 * oracle checks every expected anchor's literal source text against the
 * authored snapshots, and negative controls prove it rejects a shifted line, a
 * wrong side and a wrong file. The patch is checked to reproduce both
 * snapshots. Rendering details owned by preparation (attribution, separators)
 * are asserted only through message inclusion; anchors, suggestion text and
 * permalinks are asserted exactly.
 *
 * This is local evidence of the composition. It is not evidence of live
 * GitHub behavior, which is verified separately.
 *
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread
 * @see https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet
 * @see https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/incorporating-feedback-in-your-pull-request
 * @see https://www.gnu.org/software/diffutils/manual/html_node/Detailed-Unified.html
 */

import * as assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { createGitHubClient } from '../dist/github.cjs';
import { publishSarifReview } from '../dist/index.cjs';
import type {
  IPublishedReview,
  IPublishSarifReviewInput,
  IPublishSarifReviewInternals,
  PublishSarifReviewOutcome,
} from '../dist/publish-sarif-review.cjs';
import { FakeHttpGitHub, REPOSITORY } from './fixtures/composition/fake-http-github.mts';
import type { IHttpHostConfig, IHttpLogEntry, IWireComment } from './fixtures/composition/fake-http-github.mts';
import {
  asRecord,
  expectType,
  isArrayOf,
  isEither,
  isNull,
  isNumber,
  isOptional,
  isShape,
  isString,
  readJson,
} from './support/runtime-types.mts';
import type { Guard } from './support/runtime-types.mts';

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'composition');
const SARIF = asRecord(readJson(path.join(FIXTURE_DIR, 'review.sarif.json')), 'the composition SARIF');
const CLI = path.join(FIXTURE_DIR, 'cli-with-fake-http.mts');
const { base: BASE, head: HEAD } = REPOSITORY.commits;
const { owner: OWNER, repo: REPO, pullNumber: PULL } = REPOSITORY.destination;
const TOKEN = 'ghp_COMPOSITION_SENTINEL_0123456789abcdef';
const MARKER = /\n\n<!-- sarif-to-comment:review:[0-9a-f-]{36} -->$/;

// ---------------------------------------------------------------------------
// Typing of the authored data (runtime-checked; see test/support/runtime-types.mts)
// ---------------------------------------------------------------------------

/** The type a guard checks. */
type Guarded<G> = G extends Guard<infer T> ? T : never;

/** One authored inline expectation (repository.json `expected.inline`). */
const isExpectedInline = isShape({
  message: isString,
  path: isString,
  side: isString,
  line: isNumber,
  startSide: isOptional(isString),
  startLine: isOptional(isNumber),
  hostText: isString,
  suggestion: isOptional(isString),
});
type ExpectedInline = Guarded<typeof isExpectedInline>;

/** One authored general-feedback expectation (repository.json `expected.general`). */
const isExpectedGeneral = isShape({
  message: isString,
  sourceLink: isEither(isString, isNull),
  sourceText: isOptional(isString),
});

/** The authored expectations; the fixture module leaves them unchecked. */
const EXPECTED = expectType(
  REPOSITORY.expected,
  isShape({ inline: isArrayOf(isExpectedInline), general: isArrayOf(isExpectedGeneral) }),
  'the authored expectations in test/fixtures/composition/repository.json',
);

/** The publication state fields these tests read (the full format is src/publication.cts's). */
const isStateRecord = isShape({ phase: isString, receipt: isOptional(isShape({ via: isString })) });
type StateRecord = Guarded<typeof isStateRecord>;

/** Element `index` of `items`; fails (AssertionError) when there is none. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new AssertionError({ message: `expected an element at index ${String(index)}`, actual: items });
  return item;
}

/** Own entry `key` of `record`; fails (AssertionError) when there is none. */
function entry<T>(record: Readonly<Record<string, T>>, key: string): T {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  if (value === undefined) throw new AssertionError({ message: `expected an entry ${JSON.stringify(key)}`, actual: Object.keys(record) });
  return value;
}

// ---------------------------------------------------------------------------
// Oracle over the authored snapshots
// ---------------------------------------------------------------------------

/** Literal text of inclusive lines [start, end] of a file at a commit, final terminator excluded. */
function oracleText(commit: string, filePath: string, start: number, end: number): string {
  const lines = REPOSITORY.snapshots[commit]?.[filePath];
  if (!lines || start < 1 || end > lines.length || start > end) {
    throw new assert.AssertionError({ message: `no lines ${String(start)}-${String(end)} of ${filePath} at ${commit}` });
  }
  return lines.slice(start - 1, end).join('').replace(/\n$/, '');
}

/** Asserts an expected anchor's stated text is exactly the source it covers on its side. */
function verifyAnchor(expected: ExpectedInline): void {
  const commit = expected.side === 'LEFT' ? BASE : expected.side === 'RIGHT' ? HEAD : null;
  assert.ok(commit, `unknown side ${expected.side}`);
  const start = expected.startLine ?? expected.line;
  assert.equal(oracleText(commit, expected.path, start, expected.line), expected.hostText);
}

/** A REST inline-comment anchor (the create-review comment without its body). */
interface IWireAnchor {
  path: string;
  side: string;
  line: number;
  start_line?: number | undefined;
  start_side?: string | undefined;
}

/** The wire (REST) form of an expected inline comment's anchor. */
function wireAnchor(expected: ExpectedInline): IWireAnchor {
  const anchor: IWireAnchor = { path: expected.path, side: expected.side, line: expected.line };
  if (expected.startLine !== undefined) {
    anchor.start_line = expected.startLine;
    anchor.start_side = expected.startSide;
  }
  return anchor;
}

/** A stored wire comment without its body: its anchor, whatever other keys it carries. */
function anchorOf(comment: IWireComment): Omit<IWireComment, 'body'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the rest copy omits the body; the omitted binding is intentionally unused
  const { body: _body, ...anchor } = comment;
  return anchor;
}

/** Order-independent comparison key for an anchor (object keys sorted). */
const sortKey = (value: object): string => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

interface IWorld {
  readonly root: string;
  readonly stateDir: string;
  readonly statePath: string;
  readonly host: FakeHttpGitHub;
}

function makeWorld(hostConfig: Partial<IHttpHostConfig> = {}): IWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'composition-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  FakeHttpGitHub.create(path.join(root, 'host'), hostConfig);
  const host = new FakeHttpGitHub(path.join(root, 'host'), TOKEN);
  return { root, stateDir, statePath: path.join(stateDir, 'review.json'), host };
}

function run(world: IWorld, overrides: Partial<IPublishSarifReviewInput> = {}): Promise<PublishSarifReviewOutcome> {
  const internals: IPublishSarifReviewInternals = {
    createGitHubClient: (options) => createGitHubClient({ ...options, fetch: world.host.fetch }),
  };
  return publishSarifReview(
    {
      sarif: structuredClone(SARIF),
      destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
      reviewedCommit: HEAD,
      statePath: world.statePath,
      token: TOKEN,
      ...overrides,
    },
    // @ts-expect-error -- the private internals seam is deliberately absent from the public declaration; this suite drives the public entry and injects the HTTP-backed real client through the seam it honours at runtime
    internals,
  );
}

/** `outcome.review`: the review of a published outcome, undefined for any other status. */
function reviewOf(outcome: PublishSarifReviewOutcome): IPublishedReview | undefined {
  return outcome.status === 'published' ? outcome.review : undefined;
}

function posts(world: IWorld): IHttpLogEntry[] {
  return world.host.log().filter((r) => r.method === 'POST' && r.path === `/repos/${OWNER}/${REPO}/pulls/${String(PULL)}/reviews`);
}

function readState(world: IWorld): StateRecord {
  return expectType(readJson(world.statePath), isStateRecord, `the publication state in ${world.statePath}`);
}

/** Checks the one stored review against the authored expectations. */
function assertExpectedReview(world: IWorld): void {
  const reviews = world.host.reviews();
  assert.equal(reviews.length, 1);
  const wire = at(reviews, 0).request;
  assert.deepEqual(Object.keys(wire).sort(), ['body', 'comment' + 's', 'commit_id'].sort(), 'no event: the review stays a draft');
  assert.equal(wire.commit_id, HEAD);

  const expected = EXPECTED;
  const actualAnchors = wire.comments.map(anchorOf).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const wantedAnchors = expected.inline.map(wireAnchor).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  assert.deepEqual(actualAnchors, wantedAnchors, 'inline anchors must be exactly the authored ones');

  for (const want of expected.inline) {
    const matches = wire.comments.filter((c) => c.body.includes(want.message));
    assert.equal(matches.length, 1, `exactly one comment carries "${want.message}"`);
    const match = at(matches, 0);
    assert.deepEqual(wireAnchor({ ...want }), anchorOf(match), `"${want.message}" is on its authored anchor`);
    if (want.suggestion !== undefined) {
      assert.ok(match.body.includes(`\`\`\`suggestion\n${want.suggestion}\`\`\``), 'exact native suggestion text');
    } else {
      assert.equal(match.body.includes('```suggestion'), false);
    }
  }

  assert.match(wire.body, MARKER);
  for (const general of expected.general) {
    assert.ok(wire.body.includes(general.message), `body carries "${general.message}"`);
    if (general.sourceLink) {
      assert.ok(wire.body.includes(`(${general.sourceLink})`), `body links ${general.sourceLink}`);
      // String() is the coercion includes() applies itself; the authored data pairs every link with its text.
      assert.ok(wire.body.includes(String(general.sourceText)), 'body quotes the linked source text');
    }
    for (const c of wire.comments) assert.equal(c.body.includes(general.message), false, 'general feedback is not inline');
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe('harness controls: authored expectations are independent and discriminating', () => {
  test('every expected anchor states exactly the source text it covers', () => {
    for (const expected of EXPECTED.inline) verifyAnchor(expected);
  });

  test('the oracle rejects a shifted line, the wrong side and the wrong file', () => {
    const sample = at(EXPECTED.inline, 0);
    assert.throws(() => {
      verifyAnchor({ ...sample, line: sample.line + 1 });
    });
    assert.throws(() => {
      verifyAnchor({ ...sample, side: 'LEFT' });
    });
    assert.throws(() => {
      verifyAnchor({ ...sample, path: 'docs/notes.md' });
    });
  });

  test('the authored patch reproduces both snapshots', () => {
    const file = at(REPOSITORY.pullFiles, 0);
    const lines = file.patch.join('').split('\n');
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(at(lines, 0));
    assert.ok(header);
    const body = lines.slice(1);
    // String(l[0]) is the coercion includes() applies itself (an empty line has no l[0]).
    const side = (keep: string): string[] => body.filter((l) => keep.includes(String(l[0]))).map((l) => l.slice(1));
    const oldLines = entry(entry(REPOSITORY.snapshots, BASE), file.filename).map((l) => l.replace(/\n$/, ''));
    const newLines = entry(entry(REPOSITORY.snapshots, HEAD), file.filename).map((l) => l.replace(/\n$/, ''));
    assert.deepEqual(side(' -'), oldLines.slice(Number(header[1]) - 1, Number(header[1]) - 1 + Number(header[2])));
    assert.deepEqual(side(' +'), newLines.slice(Number(header[3]) - 1, Number(header[3]) - 1 + Number(header[4])));
    assert.deepEqual(oldLines.slice(0, 3), newLines.slice(0, 3), 'lines before the hunk are unchanged');
  });
});

describe('library + real GitHub client over HTTP', () => {
  test('publishes one draft whose anchors, suggestion and general feedback are exactly the authored ones, confirmed by readback', async () => {
    const world = makeWorld();
    const outcome = await run(world);
    assert.equal(outcome.status, 'published', outcome.markdown);
    assert.equal(posts(world).length, 1);
    assertExpectedReview(world);

    const stored = at(world.host.reviews(), 0);
    assert.deepEqual(outcome.review, { id: stored.id, url: `https://github.com/${OWNER}/${REPO}/pull/${String(PULL)}#pullrequestreview-${String(stored.id)}` });

    const log = world.host.log();
    const postAt = log.findIndex((r) => r.method === 'POST' && r.path.endsWith('/reviews'));
    const after = log.slice(postAt + 1).map((r) => `${r.method} ${r.path}`);
    assert.ok(after.includes(`GET /repos/${OWNER}/${REPO}/pulls/${String(PULL)}/reviews`), 'reviews are read back after the create');
    assert.ok(after.includes(`GET /repos/${OWNER}/${REPO}/pulls/${String(PULL)}/reviews/${String(stored.id)}/comments`), 'comments are read back');
    assert.ok(after.includes('POST /graphql'), 'original anchors are read from review threads');
    assert.ok(log.every((r) => r.authorized), 'every request carries exactly the caller token');

    const record = readState(world);
    assert.equal(record.phase, 'completed');
    assert.deepEqual(record.receipt, { reviewId: stored.id, htmlUrl: outcome.review.url, via: 'created' });
    assert.equal(fs.readFileSync(world.statePath, 'utf8').includes(TOKEN), false);
    assert.equal(JSON.stringify(outcome).includes(TOKEN), false);
  });

  test('old-side source reads use the comparison and immutable git objects instead of the contents API', async () => {
    const world = makeWorld();
    await run(world);
    const paths = world.host.log().map((r) => r.path);
    assert.ok(paths.some((p) => p.includes(`/compare/${BASE}...${HEAD}`)), 'the merge base comes from the comparison');
    assert.ok(paths.some((p) => p.endsWith(`/git/commits/${BASE}`)), 'old-side source is read at the verified base');
    assert.equal(paths.some((p) => p.includes('/contents/')), false, 'the contents API is never used');
  });

  test('an explicit old-source commit replaces the comparison and yields the same review', async () => {
    const world = makeWorld();
    const outcome = await run(world, { oldSourceCommit: BASE });
    assert.equal(outcome.status, 'published', outcome.markdown);
    assert.equal(world.host.log().some((r) => r.path.includes('/compare/')), false);
    assertExpectedReview(world);
  });

  test('a retry with the same state path makes no HTTP request at all', async () => {
    const world = makeWorld();
    const first = await run(world);
    const before = world.host.log().length;
    const again = await run(world);
    assert.equal(again.status, 'published');
    assert.deepEqual(again.review, reviewOf(first));
    assert.equal(world.host.log().length, before);
  });

  test('a lost create response is recovered through the real readback without a second create', async () => {
    const world = makeWorld({ create: 'lose-response' });
    const outcome = await run(world);
    assert.equal(outcome.status, 'published', outcome.markdown);
    assert.equal(posts(world).length, 1);
    assertExpectedReview(world);
    assert.equal(readState(world).receipt?.via, 'recovered');
  });

  test('readback that reports a comment on a different line is uncertain, never completed or resent', async () => {
    const world = makeWorld({ shiftThreadLine: 0 });
    const outcome = await run(world);
    assert.equal(outcome.status, 'uncertain', outcome.markdown);
    assert.equal(readState(world).phase, 'sending');
    const again = await run(world);
    assert.equal(again.status, 'uncertain');
    assert.equal(posts(world).length, 1);
  });

  test("the host's one-pending-review refusal reaches the caller and is remembered", async () => {
    const world = makeWorld();
    assert.equal((await run(world)).status, 'published');
    const secondPath = path.join(world.stateDir, 'second.json');
    const second = await run(world, { statePath: secondPath });
    assert.equal(second.status, 'rejected', second.markdown);
    assert.match(second.markdown, /one pending review per pull request/);
    const before = world.host.log().length;
    assert.equal((await run(world, { statePath: secondPath })).status, 'rejected');
    assert.equal(world.host.log().length, before, 'a remembered refusal needs no request');
    assert.equal(world.host.reviews().length, 1);
  });
});

describe('CLI + real GitHub client over HTTP', () => {
  test('the installed-style CLI publishes the same authored review from a SARIF file', () => {
    const world = makeWorld();
    const sarifPath = path.join(world.root, 'review.sarif');
    fs.writeFileSync(sarifPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(SARIF))]));
    const result = spawnSync(
      process.execPath,
      [CLI, '--sarif', sarifPath, '--repo', `${OWNER}/${REPO}`, '--pull', String(PULL), '--commit', HEAD, '--state', world.statePath],
      { encoding: 'utf8', timeout: 60_000, env: { PATH: process.env['PATH'], GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: world.host.dir } },
    );
    assert.equal(result.status, 0, result.stderr);
    assertExpectedReview(world);
    const stored = at(world.host.reviews(), 0);
    assert.ok(result.stdout.includes(`#pullrequestreview-${String(stored.id)}`));
    assert.equal(result.stdout.includes(TOKEN), false);
    assert.equal(result.stderr.includes(TOKEN), false);
    assert.ok(world.host.log().every((r) => r.authorized));
  });
});
