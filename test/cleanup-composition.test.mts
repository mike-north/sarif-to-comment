/**
 * Suggestion pull request cleanup through the production composition: the
 * real public library and CLI with the real GitHub client (src/github.cts),
 * talking HTTP to the fake GitHub host (test/fixtures/composition). Only
 * `fetch` is replaced.
 *
 * Every expected value is written by hand from
 * docs/suggestion-cleanup-contract.md: which pull requests are closed and
 * which are left alone, each result and original state, the status, the
 * Markdown of the worked example (§3), the requests sent (reads before any
 * write; exactly one PATCH per closed suggestion; nothing else written), and
 * the CLI's output and exit statuses. Suggestion markers and branches are
 * written out by hand from the suggestion pull request convention's templates
 * (docs/suggestion-pr-convention.md §5, §7), never produced by the code under
 * test. The repository has no configuration file, so the canonical label is
 * the default `suggestion-pr`; configured labels are tested in
 * test/suggestion-pr-convention.test.mts.
 *
 * The host models documented GitHub behavior; it is not evidence of live
 * GitHub behavior (see docs/suggestion-cleanup-e2e-evidence.md).
 *
 * @see https://docs.github.com/en/rest/issues/issues#list-repository-issues
 * @see https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request
 * @see https://docs.github.com/en/graphql/reference/objects#crossreferencedevent
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { createGitHubClient } from '../dist/github.cjs';
import library from '../dist/index.cjs';
import type { ICreateGitHubClientOptions, IGitHubClient } from '../dist/github.cjs';
import { FakeHttpGitHub } from './fixtures/composition/fake-http-github.mts';
import type { IHttpHostConfig, IHttpRepository } from './fixtures/composition/fake-http-github.mts';
import type { ICompanionConfig, IStoredPull } from './fixtures/composition/fake-http-companion.mts';
import { asArray, asRecord, asString, parseJson } from './support/runtime-types.mts';

const CLI = path.join(import.meta.dirname, 'fixtures', 'composition', 'cli-with-fake-http.mts');
const OWNER = 'octo';
const REPO = 'widgets';
const TOKEN = 'ghp_CLEANUP_COMPOSITION_0123456789';
const BASE = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e';
const HEAD = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
const BATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function repository(): IHttpRepository {
  return {
    destination: { owner: OWNER, repo: REPO, pullNumber: 7 },
    commits: { base: BASE, head: HEAD },
    snapshots: { [BASE]: { 'README.md': ['# Widgets\n'] }, [HEAD]: { 'README.md': ['# Widgets\n'] } },
    pullFiles: [],
    labels: ['suggestion-pr'],
  };
}

// ---------------------------------------------------------------------------
// Seeded pull requests

/** The suggestion id a test gives suggestion pull request `n` (a v4 UUID). */
const idOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The marker line of convention §7, written out from its template. */
function markerLine(n: number, original: number, where = `"owner":"${OWNER}","repo":"${REPO}","pullNumber":${String(original)}`): string {
  return `<!-- suggestion-pr {"version":1,"original":{${where}},"reviewedCommit":"${HEAD}","id":"${idOf(n)}","batch":"${BATCH}"} -->`;
}

/** A suggestion body as the publisher writes it: the reference first, the marker last. */
function suggestionBody(n: number, original: number): string {
  return `Suggested in a review of #${String(original)} at commit ${HEAD}.\n\nMerging this pull request into \`feature-${String(original)}\` applies this change:\n\n- New file \`docs/${String(n)}.md\`\n\n---\n\nAdd the page.\n\n${markerLine(n, original)}`;
}

function original(number: number, state: 'open' | 'merged' | 'closed'): IStoredPull {
  return {
    number, title: `Original ${String(number)}`, body: 'The original work.', head: `feature-${String(number)}`, base: 'main',
    draft: false, state: state === 'open' ? 'open' : 'closed', merged: state === 'merged', labels: [], authorId: 1,
  };
}

function suggestion(n: number, originalNumber: number, change: Partial<IStoredPull> = {}): IStoredPull {
  return {
    number: n,
    title: `Suggestion for #${String(originalNumber)}: create docs/${String(n)}.md`,
    body: suggestionBody(n, originalNumber),
    head: `suggestion-pr/${String(originalNumber)}/${idOf(n)}`,
    base: `feature-${String(originalNumber)}`,
    draft: true,
    state: 'open',
    merged: false,
    labels: ['suggestion-pr'],
    authorId: 4242,
    ...change,
  };
}

// ---------------------------------------------------------------------------
// Harness

interface IWorld {
  readonly root: string;
  readonly host: FakeHttpGitHub;
}

function makeWorld(pulls: readonly IStoredPull[], companion: ICompanionConfig = {}): IWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-composition-')));
  const config: Partial<IHttpHostConfig> = { companion };
  FakeHttpGitHub.create(path.join(root, 'host'), config, repository());
  const host = new FakeHttpGitHub(path.join(root, 'host'), TOKEN);
  host.seedPulls(pulls);
  return { root, host };
}

function internalsFor(world: IWorld): { readonly createGitHubClient: (options: ICreateGitHubClientOptions) => IGitHubClient } {
  return { createGitHubClient: (options) => createGitHubClient({ ...options, fetch: world.host.fetch }) };
}

type Json = Record<string, unknown>;

function closeOperation(): (input: unknown, internals: unknown) => Promise<unknown> {
  const operation: unknown = Reflect.get(library, 'closeSuggestionPullRequests');
  if (typeof operation !== 'function') throw new assert.AssertionError({ message: 'the package exports closeSuggestionPullRequests' });
  return async (input, internals) => {
    const outcome: unknown = await Reflect.apply(operation, undefined, [input, internals]);
    return outcome;
  };
}

async function cleanup(world: IWorld, extra: Json = {}): Promise<Json> {
  const outcome = await closeOperation()({ repository: { owner: OWNER, repo: REPO }, token: TOKEN, ...extra }, internalsFor(world));
  return asRecord(outcome, 'the cleanup outcome');
}

/** Each reported suggestion as [number, original, result]. */
function results(outcome: Json): (readonly [unknown, unknown, unknown])[] {
  return asArray(outcome['suggestions']).map((s) => {
    const entry = asRecord(s);
    return [entry['number'], entry['original'], entry['result']] as const;
  });
}

/** The reported entry for suggestion `n`. */
function entry(outcome: Json, n: number): Json {
  const found = asArray(outcome['suggestions']).map((s) => asRecord(s)).find((s) => s['number'] === n);
  assert.ok(found, `suggestion #${String(n)} is reported`);
  return found;
}

/** Each resolved original as [number, state]. */
function originals(outcome: Json): (readonly [unknown, unknown])[] {
  return asArray(outcome['originals']).map((o) => [asRecord(o)['number'], asRecord(o)['state']] as const);
}

function markdown(outcome: Json): string {
  return asString(outcome['markdown'], 'the cleanup Markdown');
}

const pullUrl = (n: number): string => `https://github.com/${OWNER}/${REPO}/pull/${String(n)}`;
const PULL_PATH = new RegExp(`^/repos/${OWNER}/${REPO}/pulls/(\\d+)$`);

/** Every request that is not a read: a PATCH (close) or any other write; GraphQL queries are reads. */
function writes(world: IWorld): readonly string[] {
  return world.host.log().filter((r) => r.method !== 'GET' && !(r.method === 'POST' && r.path === '/graphql')).map((r) => `${r.method} ${r.path}`);
}

/** Pull request numbers read with GET pulls/{n}, in order. */
function pullReads(world: IWorld): number[] {
  return world.host.log().filter((r) => r.method === 'GET').map((r) => PULL_PATH.exec(r.path)?.[1]).filter((n) => n !== undefined).map(Number);
}

const closes = (...numbers: readonly number[]): string[] => numbers.map((n) => `PATCH /repos/${OWNER}/${REPO}/pulls/${String(n)}`);

function stateOf(world: IWorld, n: number): { state: string; merged: boolean; head: string } {
  const pull = world.host.pulls().find((p) => p.number === n);
  assert.ok(pull, `pull request #${String(n)} exists`);
  return { state: pull.state, merged: pull.merged, head: pull.head };
}

// ---------------------------------------------------------------------------

describe('harness controls', () => {
  test('the hand-written marker names the suggestion, and the seeded suggestion uses its branch', () => {
    assert.equal(
      markerLine(40, 37),
      '<!-- suggestion-pr {"version":1,"original":{"owner":"octo","repo":"widgets","pullNumber":37},"reviewedCommit":"feedfeedfeedfeedfeedfeedfeedfeedfeedfeed","id":"00000000-0000-4000-8000-000000000040","batch":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"} -->',
    );
    assert.equal(suggestion(40, 37).head, 'suggestion-pr/37/00000000-0000-4000-8000-000000000040');
  });

  test('the host closes only with the documented body, and lists only open labeled pull requests', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37), suggestion(41, 37, { state: 'closed' }), suggestion(42, 37, { labels: [] })]);
    const listing = await world.host.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/issues?labels=suggestion-pr&state=open&per_page=100&page=1`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.deepEqual(asArray(await listing.json()).map((i) => asRecord(i)['number']), [40]);
    const wrong = await world.host.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/40`, {
      method: 'PATCH', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ state: 'closed', title: 'x' }),
    });
    assert.equal(wrong.status, 400);
    assert.equal(stateOf(world, 40).state, 'open');
  });
});

describe('the worked example (§3)', () => {
  const seeded = (): IStoredPull[] => [
    original(36, 'open'),
    original(37, 'closed'),
    suggestion(38, 36),
    suggestion(39, 36),
    suggestion(40, 37),
    { ...suggestion(41, 37), title: 'Labeled by hand', body: 'A pull request someone labeled without a marker.', head: 'someone/idea' },
  ];

  const header = [
    'Checked the open pull requests labeled `suggestion-pr` in octo/widgets (the default suggestion label).',
    '',
    'Original pull requests:',
    '',
    '- #36: open',
    '- #37: closed without merging',
    '',
    'Suggestion pull requests:',
    '',
    '- #38 (for #36): left open, because the original is still open',
    '- #39 (for #36): left open, because the original is still open',
  ];
  const notOurs = '- #41: skipped, not a conforming suggestion pull request: it has the label but no suggestion marker';
  const branches = 'Closing never deletes a branch: each proposal branch is left in place.';

  test('a dry run reads everything, reports what would be closed and writes nothing', async () => {
    const world = makeWorld(seeded());
    const outcome = await cleanup(world, { dryRun: true });
    assert.equal(outcome['status'], 'complete');
    assert.equal(outcome['dryRun'], true);
    assert.deepEqual(originals(outcome), [[36, 'open'], [37, 'closed']]);
    assert.deepEqual(results(outcome), [[38, 36, 'left-open'], [39, 36, 'left-open'], [40, 37, 'would-close'], [41, null, 'not-ours']]);
    assert.equal(
      markdown(outcome),
      ['## Suggestion pull request cleanup: dry run', '', ...header, '- #40 (for #37): would be closed', notOurs, '', 'This was a dry run: nothing was closed.', '', branches].join('\n'),
    );
    assert.deepEqual(writes(world), []);
    assert.equal(stateOf(world, 40).state, 'open');
  });

  test('cleanup closes only the suggestion whose original ended, with one PATCH, and changes nothing else', async () => {
    const world = makeWorld(seeded());
    const before = world.host.pulls();
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'complete');
    assert.equal(outcome['dryRun'], false);
    assert.deepEqual(results(outcome), [[38, 36, 'left-open'], [39, 36, 'left-open'], [40, 37, 'closed'], [41, null, 'not-ours']]);
    assert.deepEqual(entry(outcome, 40), { number: 40, url: pullUrl(40), original: 37, result: 'closed' });
    assert.equal(
      markdown(outcome),
      ['## Suggestion pull request cleanup complete', '', ...header, '- #40 (for #37): closed', notOurs, '', branches].join('\n'),
    );
    assert.deepEqual(writes(world), closes(40));
    // Only #40's state changed: its branch, body, title, labels and every other pull request are as they were.
    assert.deepEqual(world.host.pulls(), before.map((p) => (p.number === 40 ? { ...p, state: 'closed' } : p)));
  });

  test('every read happens before the first close, and each original is read once', async () => {
    const world = makeWorld([...seeded(), suggestion(42, 37), suggestion(43, 36)]);
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome).filter(([, , r]) => r === 'closed').map(([n]) => n), [40, 42]);
    const log = world.host.log();
    const firstWrite = log.findIndex((r) => r.method === 'PATCH');
    assert.ok(firstWrite > 0);
    assert.ok(log.slice(firstWrite).every((r) => r.method === 'PATCH'), 'nothing is read after the first close');
    assert.deepEqual(writes(world), closes(40, 42), 'closed in ascending order');
    assert.deepEqual(pullReads(world).filter((n) => n === 36 || n === 37).sort(), [36, 37], 'one read per original');
  });

  test('a rerun tolerates the closed suggestion: nothing more to close', async () => {
    const world = makeWorld(seeded());
    await cleanup(world);
    const before = world.host.log().length;
    const again = await cleanup(world);
    assert.equal(again['status'], 'complete');
    assert.deepEqual(results(again), [[38, 36, 'left-open'], [39, 36, 'left-open'], [41, null, 'not-ours']]);
    assert.deepEqual(world.host.log().slice(before).filter((r) => r.method === 'PATCH'), []);
  });
});

describe('original states (A36)', () => {
  for (const [state, described] of [['merged', 'merged'], ['closed', 'closed without merging']] as const) {
    test(`a ${described} original: its open suggestion is closed`, async () => {
      const world = makeWorld([original(37, state), suggestion(40, 37)]);
      const outcome = await cleanup(world);
      assert.equal(outcome['status'], 'complete');
      assert.deepEqual(originals(outcome), [[37, state]]);
      assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
      assert.ok(markdown(outcome).includes(`- #37: ${described}`), markdown(outcome));
      assert.deepEqual(writes(world), closes(40));
      assert.deepEqual(stateOf(world, 40), { state: 'closed', merged: false, head: `suggestion-pr/37/${idOf(40)}` });
    });
  }

  test('an open original (a draft counts as open): its suggestion is left open and nothing is written', async () => {
    const world = makeWorld([{ ...original(36, 'open'), draft: true }, suggestion(38, 36)]);
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(originals(outcome), [[36, 'open']]);
    assert.deepEqual(results(outcome), [[38, 36, 'left-open']]);
    assert.deepEqual(writes(world), []);
  });

  const inaccessible: readonly (readonly [string, ICompanionConfig, RegExp])[] = [
    ['answers 404', { pullReads: { '37': 'not-found' } }, /HTTP 404/],
    ['answers 403', { pullReads: { '37': 'forbidden' } }, /HTTP 403/],
    ['answers 502', { pullReads: { '37': 'server-error' } }, /HTTP 502/],
    ['answers with an unknown state', { pullReads: { '37': 'malformed' } }, /state/],
  ];
  for (const [what, config, reason] of inaccessible) {
    test(`an original whose lookup ${what} is unverified: never treated as ended, nothing closed, incomplete`, async () => {
      const world = makeWorld([original(37, 'closed'), suggestion(40, 37), original(36, 'open'), suggestion(38, 36)], config);
      const outcome = await cleanup(world);
      assert.equal(outcome['status'], 'incomplete');
      assert.deepEqual(originals(outcome), [[36, 'open'], [37, 'unverified']]);
      const reported = asRecord(asArray(outcome['originals'])[1]);
      assert.match(asString(reported['reason']), reason);
      assert.deepEqual(results(outcome), [[38, 36, 'left-open'], [40, 37, 'unverified']]);
      assert.match(asString(entry(outcome, 40)['reason']), reason);
      assert.deepEqual(writes(world), []);
      assert.equal(stateOf(world, 40).state, 'open');
      const text = markdown(outcome);
      assert.ok(text.startsWith('## Suggestion pull request cleanup incomplete\n'), text);
      assert.ok(text.includes('- #37: could not be verified ('), text);
      assert.ok(text.includes('- #40 (for #37): left open, because the original could not be verified'), text);
      assert.ok(text.includes('Running the cleanup again is safe'), text);
    });
  }
});

describe('pagination and duplicate references (A31)', () => {
  test('every page of more than 200 labeled pull requests is read; nothing is skipped', async () => {
    const pulls = [original(36, 'open'), original(37, 'merged')];
    for (let n = 100; n < 305; n += 1) pulls.push(suggestion(n, 36));
    pulls.push(suggestion(305, 37));
    const world = makeWorld(pulls);
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'complete');
    assert.equal(results(outcome).length, 206);
    assert.deepEqual(results(outcome).filter(([, , r]) => r !== 'left-open'), [[305, 37, 'closed']]);
    const listings = world.host.log().filter((r) => r.path === `/repos/${OWNER}/${REPO}/issues`);
    assert.equal(listings.length, 3, 'three pages of 100');
    assert.deepEqual(pullReads(world).sort((a, b) => a - b), [36, 37, 305], 'one read per original, and only the ended one\'s suggestion');
  });

  test('a pull request listed on two pages (the listing shifted while being read) counts once', async () => {
    const pulls = [original(36, 'open'), original(37, 'closed')];
    for (let n = 100; n < 201; n += 1) pulls.push(suggestion(n, 36));
    pulls.push(suggestion(201, 37));
    const world = makeWorld(pulls, { shiftIssueListing: true });
    const outcome = await cleanup(world);
    const numbers = results(outcome).map(([n]) => n);
    assert.equal(numbers.length, 102);
    assert.equal(new Set(numbers).size, 102, 'no pull request is reported twice');
    assert.deepEqual(writes(world), closes(201), 'and none is closed twice');
  });

  test('several suggestions of one original resolve it once', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37), suggestion(41, 37), suggestion(42, 37)]);
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, 37, 'closed'], [41, 37, 'closed'], [42, 37, 'closed']]);
    assert.equal(pullReads(world).filter((n) => n === 37).length, 1);
  });

  test('two open pull requests claiming the same suggestion are both skipped, never closed', async () => {
    const copy = { ...suggestion(41, 37), body: suggestionBody(40, 37), head: `suggestion-pr/37/${idOf(40)}`, base: 'main' };
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37), copy]);
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(results(outcome), [[40, 37, 'not-ours'], [41, 37, 'not-ours']]);
    assert.match(asString(entry(outcome, 40)['reason']), /#41.*same suggestion/);
    assert.match(asString(entry(outcome, 41)['reason']), /#40.*same suggestion/);
    assert.deepEqual(writes(world), []);
  });

  test('a changed title does not matter: the marker is the relationship', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37, { title: 'Please take this instead' })]);
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
  });

  test('a title that names another original does not matter either', async () => {
    const world = makeWorld([original(36, 'open'), original(37, 'closed'), suggestion(40, 36, { title: 'Suggestion for #37: create docs/40.md' })]);
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, 36, 'left-open']]);
    assert.deepEqual(writes(world), []);
  });
});

describe('recognition and verification (§2.5–§2.8)', () => {
  const ended = (...pulls: readonly IStoredPull[]): IStoredPull[] => [original(37, 'closed'), ...pulls];

  const skipped: readonly (readonly [string, IStoredPull, RegExp, number | null])[] = [
    ['the marker was removed', suggestion(40, 37, { body: 'Suggested in a review of #37.' }), /no suggestion marker/, null],
    ['the marker was changed', suggestion(40, 37, { body: suggestionBody(40, 37).replace('"version":1', '"version": 1') }), /canonical/, null],
    ['the marker is quoted twice', suggestion(40, 37, { body: `${suggestionBody(40, 37)}\n\n> ${markerLine(40, 37)}\n${markerLine(40, 37)}` }), /more than one/, null],
    ['the marker names another repository', suggestion(40, 37, { body: `Moved.\n\n${markerLine(40, 37, '"owner":"elsewhere","repo":"widgets","pullNumber":37')}` }), /another repository \(elsewhere\/widgets\)/, null],
    ['its head is in a fork', suggestion(40, 37, { headRepo: 'someone/widgets' }), /someone\/widgets/, 37],
    ['its head branch is not the marker\'s branch', suggestion(40, 37, { head: 'suggestion-pr/37/other' }), /suggestion-pr\/37\/other/, 37],
    ['its head branch is the unreleased tool-branded form', suggestion(40, 37, { head: `sarif-to-comment/suggestions/37/${idOf(40)}` }), /sarif-to-comment\/suggestions\/37/, 37],
  ];
  for (const [what, pull, reason, originalNumber] of skipped) {
    test(`not a conforming suggestion, never closed: ${what}`, async () => {
      const world = makeWorld(ended(pull));
      const outcome = await cleanup(world);
      assert.equal(outcome['status'], 'complete');
      assert.deepEqual(results(outcome), [[40, originalNumber, 'not-ours']]);
      assert.match(asString(entry(outcome, 40)['reason']), reason);
      assert.deepEqual(writes(world), []);
    });
  }

  test('owner and repository in the marker are compared case-insensitively, as GitHub names are', async () => {
    const world = makeWorld(ended(suggestion(40, 37, { body: `Text.\n\n${markerLine(40, 37, '"owner":"Octo","repo":"Widgets","pullNumber":37')}` })));
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
  });

  test('a CRLF body and text after the marker are still recognized', async () => {
    const world = makeWorld(ended(suggestion(40, 37, { body: `${suggestionBody(40, 37).replace(/\n/g, '\r\n')}\r\n\r\nThanks!` })));
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
  });

  test('a suggestion retargeted to another base branch is still closed: the base is never checked', async () => {
    const world = makeWorld(ended(suggestion(40, 37, { base: 'main' })));
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
  });

  /** Cleanup where a person acts right after the labeled listing is answered; the fresh read sees it. */
  async function cleanupWithChangeAfterListing(world: IWorld, change: () => void): Promise<Json> {
    const host = world.host.fetch.bind(world.host);
    const people: typeof world.host.fetch = async (input, init) => {
      const response = await host(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/issues?')) change();
      return response;
    };
    const outcome: unknown = await closeOperation()(
      { repository: { owner: OWNER, repo: REPO }, token: TOKEN },
      { createGitHubClient: (options: ICreateGitHubClientOptions) => createGitHubClient({ ...options, fetch: people }) },
    );
    return asRecord(outcome);
  }

  test('a suggestion someone closed after the listing is reported already-closed and not closed again', async () => {
    const world = makeWorld(ended(suggestion(40, 37)));
    const outcome = await cleanupWithChangeAfterListing(world, () => {
      world.host.editPull(40, { state: 'closed' });
    });
    assert.deepEqual(results(outcome), [[40, 37, 'already-closed']]);
    assert.deepEqual(writes(world), []);
  });

  test('a suggestion whose label was removed after the listing is reported unlabeled and not closed', async () => {
    const world = makeWorld(ended(suggestion(40, 37)));
    const outcome = await cleanupWithChangeAfterListing(world, () => {
      world.host.removeLabel(40, 'suggestion-pr');
    });
    assert.deepEqual(results(outcome), [[40, 37, 'unlabeled']]);
    assert.deepEqual(writes(world), []);
  });

  for (const [what, body] of [
    ['removed', 'Rewritten without the marker.'],
    ['replaced by another batch\'s marker for the same branch', suggestionBody(40, 37).replace(BATCH, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')],
  ] as const) {
    test(`a suggestion whose marker was ${what} after the listing is not closed`, async () => {
      const world = makeWorld(ended(suggestion(40, 37)));
      const outcome = await cleanupWithChangeAfterListing(world, () => {
        world.host.editPull(40, { body });
      });
      assert.deepEqual(results(outcome), [[40, 37, 'not-ours']]);
      assert.match(asString(entry(outcome, 40)['reason']), /changed while it was being checked/);
      assert.deepEqual(writes(world), []);
    });
  }

  test('a suggestion that cannot be re-read is failed, not closed', async () => {
    const world = makeWorld(ended(suggestion(40, 37)), { pullReads: { '40': 'server-error' } });
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'incomplete');
    assert.deepEqual(results(outcome), [[40, 37, 'failed']]);
    assert.match(asString(entry(outcome, 40)['reason']), /HTTP 502/);
    assert.deepEqual(writes(world), []);
  });

  test('a label matched case-insensitively, and a label the caller names as a migration override', async () => {
    const world = makeWorld(ended(suggestion(40, 37, { labels: ['Proposal'] }), suggestion(41, 37)));
    const outcome = await cleanup(world, { label: 'proposal' });
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
    assert.ok(markdown(outcome).includes('Checked the open pull requests labeled `proposal` in octo/widgets (a label given in place of the repository\'s suggestion label).'), markdown(outcome));
  });

  test('an issue carrying the label is not a pull request and is ignored', async () => {
    const world = makeWorld(ended(suggestion(40, 37), { ...suggestion(41, 37), isIssue: true }));
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
  });

  test('nothing labeled: complete, with nothing to report', async () => {
    const world = makeWorld([original(37, 'closed')]);
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(outcome['originals'], []);
    assert.deepEqual(outcome['suggestions'], []);
    assert.equal(
      markdown(outcome),
      ['## Suggestion pull request cleanup complete', '', 'Checked the open pull requests labeled `suggestion-pr` in octo/widgets (the default suggestion label).', '', 'No suggestion pull requests were found.', '', 'Closing never deletes a branch: each proposal branch is left in place.'].join('\n'),
    );
  });
});

describe('closing: permissions apart from failures (§2.9, A34, A36)', () => {
  const world3 = (closesConfig: ICompanionConfig['closes']): IWorld =>
    makeWorld([original(37, 'closed'), suggestion(40, 37), suggestion(41, 37), suggestion(42, 37)], { closes: closesConfig });

  for (const [refusal, status] of [['forbidden', 403], ['not-found', 404]] as const) {
    test(`a close refused with ${String(status)} is permission-limited; the others are closed (exit status 2)`, async () => {
      const world = world3({ '41': refusal });
      const outcome = await cleanup(world);
      assert.equal(outcome['status'], 'permission-limited');
      assert.deepEqual(results(outcome), [[40, 37, 'closed'], [41, 37, 'permission-limited'], [42, 37, 'closed']]);
      assert.match(asString(entry(outcome, 41)['reason']), new RegExp(`HTTP ${String(status)}`));
      assert.deepEqual(writes(world), closes(40, 41, 42));
      assert.equal(stateOf(world, 41).state, 'open');
      const text = markdown(outcome);
      assert.ok(text.startsWith('## Suggestion pull request cleanup limited by permissions\n'), text);
      assert.ok(text.includes('- #41 (for #37): left open, not permitted to close it: '), text);
      assert.ok(text.includes('Someone allowed to close the pull requests left open can finish'), text);
      assert.equal(text.includes('Running the cleanup again is safe'), false, 'no completion is claimed and no retry is suggested for a permission limit');
    });
  }

  for (const failure of ['rate-limited', 'secondary-rate-limit', 'too-many-requests', 'server-error'] as const) {
    test(`a close that fails (${failure}) is failed, not permission-limited: incomplete`, async () => {
      const world = world3({ '41': failure });
      const outcome = await cleanup(world);
      assert.equal(outcome['status'], 'incomplete');
      assert.deepEqual(results(outcome), [[40, 37, 'closed'], [41, 37, 'failed'], [42, 37, 'closed']]);
      assert.ok(markdown(outcome).includes('- #41 (for #37): not closed, the close failed: '), markdown(outcome));
    });
  }

  test('a permission limit and a failure together: both reported, each as itself; incomplete wins', async () => {
    const world = world3({ '40': 'forbidden', '42': 'server-error' });
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'incomplete');
    assert.deepEqual(results(outcome), [[40, 37, 'permission-limited'], [41, 37, 'closed'], [42, 37, 'failed']]);
  });

  test('a lost close response is failed, never claimed; the rerun finds it closed and has nothing to do', async () => {
    const world = world3({ '41': 'lose-response' });
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'incomplete');
    assert.deepEqual(results(outcome), [[40, 37, 'closed'], [41, 37, 'failed'], [42, 37, 'closed']]);
    world.host.setConfig({ companion: {} });
    const again = await cleanup(world);
    assert.equal(again['status'], 'complete');
    assert.deepEqual(results(again), []);
  });
});

describe('targeted discovery from one original (§2.4, D21)', () => {
  test('backlinks of a closed original find its suggestions; ordinary references, issues, other repositories and other originals\' suggestions are not closed', async () => {
    const world = makeWorld([
      original(36, 'open'),
      original(37, 'closed'),
      suggestion(40, 37),
      { ...original(43, 'open'), body: 'Follow-up to #37.' },
      { ...original(44, 'open'), body: 'Also see #37.', isIssue: true },
      { ...suggestion(45, 37), repository: 'someone/widgets', body: `See octo/widgets#37.\n\n${markerLine(45, 37)}` },
      suggestion(46, 36, { body: `${suggestionBody(46, 36)}\n\nRelated to #37.` }),
      suggestion(47, 37, { state: 'closed' }),
    ]);
    const outcome = await cleanup(world, { originalPullNumber: 37 });
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(originals(outcome), [[37, 'closed']]);
    assert.deepEqual(results(outcome), [[40, 37, 'closed'], [46, 36, 'not-ours'], [47, 37, 'already-closed']]);
    assert.match(asString(entry(outcome, 46)['reason']), /names #36, not #37/);
    assert.deepEqual(writes(world), closes(40));
    assert.ok(markdown(outcome).includes('Checked the pull requests that reference #37 in octo/widgets; the suggestion label is `suggestion-pr` (the default suggestion label).'), markdown(outcome));
    assert.equal(world.host.log().filter((r) => r.path.endsWith('/issues')).length, 0, 'the labeled listing is not used');
  });

  test('regression: a foreign pull request with more than 100 labels in an inaccessible repository does not stop targeted discovery', async () => {
    const labels = Array.from({ length: 101 }, (_, i) => `label-${String(i)}`);
    const world = makeWorld([
      original(37, 'closed'),
      suggestion(40, 37),
      { ...suggestion(45, 37), repository: 'someone/private', labels, body: `See octo/widgets#37.\n\n${markerLine(45, 37)}` },
    ]);
    const outcome = await cleanup(world, { originalPullNumber: 37 });
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
    assert.equal(world.host.log().some((r) => r.path.startsWith('/repos/someone/')), false, 'nothing is read in the foreign repository');
    assert.deepEqual(writes(world), closes(40));
  });

  test('a suggestion found through backlinks without the label is reported unlabeled and never closed', async () => {
    const world = makeWorld([original(37, 'merged'), suggestion(40, 37, { labels: [] }), suggestion(41, 37)]);
    const outcome = await cleanup(world, { originalPullNumber: 37 });
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(results(outcome), [[40, 37, 'unlabeled'], [41, 37, 'closed']]);
    assert.ok(markdown(outcome).includes('- #40 (for #37): skipped, it does not carry the label `suggestion-pr`'), markdown(outcome));
    assert.deepEqual(writes(world), closes(41));
  });

  test('an open original: its suggestions are reported left open', async () => {
    const world = makeWorld([original(36, 'open'), suggestion(38, 36), suggestion(39, 36)]);
    const outcome = await cleanup(world, { originalPullNumber: 36 });
    assert.deepEqual(originals(outcome), [[36, 'open']]);
    assert.deepEqual(results(outcome), [[38, 36, 'left-open'], [39, 36, 'left-open']]);
    assert.deepEqual(writes(world), []);
  });

  test('an original that cannot be verified: discovery stops there, incomplete', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)], { pullReads: { '37': 'forbidden' } });
    const outcome = await cleanup(world, { originalPullNumber: 37 });
    assert.equal(outcome['status'], 'incomplete');
    assert.deepEqual(originals(outcome), [[37, 'unverified']]);
    assert.deepEqual(outcome['suggestions'], []);
    assert.equal(world.host.log().some((r) => r.path === '/graphql'), false, 'no backlink query');
    assert.deepEqual(writes(world), []);
  });

  test('every timeline page is read, and a pull request referenced several times counts once', async () => {
    const world = makeWorld(
      [original(37, 'closed'), suggestion(40, 37, { referenceEvents: 3 }), suggestion(41, 37), suggestion(42, 37), suggestion(43, 37, { referenceEvents: 2 })],
      { timelinePageSize: 2 },
    );
    const outcome = await cleanup(world, { originalPullNumber: 37 });
    assert.deepEqual(results(outcome), [[40, 37, 'closed'], [41, 37, 'closed'], [42, 37, 'closed'], [43, 37, 'closed']]);
    assert.equal(world.host.log().filter((r) => r.path === '/graphql').length, 4, 'seven events, two per page');
    assert.deepEqual(writes(world), closes(40, 41, 42, 43));
  });

  test('a rerun reports the closed suggestion already-closed', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    await cleanup(world, { originalPullNumber: 37 });
    const again = await cleanup(world, { originalPullNumber: 37 });
    assert.equal(again['status'], 'complete');
    assert.deepEqual(results(again), [[40, 37, 'already-closed']]);
    assert.deepEqual(writes(world), closes(40));
  });

  test('a targeted dry run writes nothing', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    const outcome = await cleanup(world, { originalPullNumber: 37, dryRun: true });
    assert.deepEqual(results(outcome), [[40, 37, 'would-close']]);
    assert.deepEqual(writes(world), []);
  });
});

describe('operational failures and input (§2.2, §2.4)', () => {
  test('a failing listing rejects before any write; the token never appears', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)], { failIssueListing: true });
    await assert.rejects(cleanup(world), (err: unknown) => err instanceof Error && /HTTP 502/.test(err.message) && !err.message.includes(TOKEN));
    assert.deepEqual(writes(world), []);
  });

  test('a failing backlink query rejects before any write', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)], { failTimeline: true });
    await assert.rejects(cleanup(world, { originalPullNumber: 37 }), (err: unknown) => err instanceof Error && /errors/.test(err.message));
    assert.deepEqual(writes(world), []);
  });

  const invalid: readonly (readonly [string, Json, RegExp])[] = [
    ['a label with a comma', { label: 'a,b' }, /label/],
    ['a label with surrounding whitespace', { label: ' suggestion' }, /label/],
    ['an empty label', { label: '' }, /label/],
    ['an original that is not a positive integer', { originalPullNumber: 0 }, /originalPullNumber/],
    ['a dry-run flag that is not a boolean', { dryRun: 'yes' }, /dryRun/],
    ['an unknown field', { statePath: '/tmp/x' }, /unknown field statePath/],
    ['a repository without a name', { repository: { owner: OWNER } }, /repository/],
    ['a repository with an extra key', { repository: { owner: OWNER, repo: REPO, pullNumber: 1 } }, /repository/],
    ['no token', { token: '' }, /token/],
  ];
  for (const [what, change, pattern] of invalid) {
    test(`${what} is a TypeError before any request`, async () => {
      const world = makeWorld([]);
      await assert.rejects(cleanup(world, change), (err: unknown) => err instanceof TypeError && /^Invalid closeSuggestionPullRequests input: /.test(err.message) && pattern.test(err.message));
      assert.deepEqual(world.host.log(), []);
    });
  }
});

describe('CLI + real GitHub client over HTTP', () => {
  function cli(world: IWorld, args: readonly string[], env: Record<string, string> = { GH_TOKEN: TOKEN }): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: world.root, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env['PATH'], FAKE_HTTP_GITHUB_DIR: world.host.dir, ...env },
    });
    for (const text of [result.stdout, result.stderr]) assert.equal(text.includes(TOKEN), false, 'the token never appears');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }
  const worked = (): IStoredPull[] => [original(36, 'open'), original(37, 'closed'), suggestion(38, 36), suggestion(40, 37)];

  test('human output is the Markdown; a dry run and then a real run exit 0', () => {
    const world = makeWorld(worked());
    const dry = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--dry-run']);
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.equal(dry.stderr, '');
    assert.ok(dry.stdout.startsWith('## Suggestion pull request cleanup: dry run\n'), dry.stdout);
    assert.ok(dry.stdout.includes('- #40 (for #37): would be closed\n'), dry.stdout);
    assert.deepEqual(writes(world), []);
    const real = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`]);
    assert.equal(real.status, 0, real.stdout + real.stderr);
    assert.ok(real.stdout.includes('- #40 (for #37): closed\n'), real.stdout);
    assert.ok(real.stdout.endsWith('Closing never deletes a branch: each proposal branch is left in place.\n'), real.stdout);
    assert.deepEqual(writes(world), closes(40));
  });

  test('JSON is one document with the envelope first', () => {
    const world = makeWorld(worked());
    const result = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--original', '37', '--format', 'json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    const doc = asRecord(parseJson(result.stdout));
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'dryRun', 'originals', 'suggestions', 'message']);
    assert.equal(doc['command'], 'close-suggestion-prs');
    assert.equal(doc['status'], 'complete');
    assert.equal(doc['dryRun'], false);
    assert.deepEqual(doc['originals'], [{ number: 37, state: 'closed' }]);
    assert.deepEqual(doc['suggestions'], [{ number: 40, url: pullUrl(40), original: 37, result: 'closed' }]);
    assert.ok(asString(doc['message']).startsWith('## Suggestion pull request cleanup complete'));
  });

  test('exit 2 when only permission limits remain, 3 when incomplete', () => {
    const limited = makeWorld(worked(), { closes: { '40': 'forbidden' } });
    assert.equal(cli(limited, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`]).status, 2);
    const incomplete = makeWorld(worked(), { pullReads: { '37': 'not-found' } });
    const result = cli(incomplete, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--format', 'json']);
    assert.equal(result.status, 3, result.stdout);
    assert.equal(asRecord(parseJson(result.stdout))['status'], 'incomplete');
  });

  test('--label names the label', () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37, { labels: ['proposal'] })]);
    const result = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--label', 'proposal']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(writes(world), closes(40));
  });

  const usage: readonly (readonly [string, readonly string[], RegExp])[] = [
    ['no --repo', ['close-suggestion-prs'], /missing required option --repo/],
    ['a malformed --repo', ['close-suggestion-prs', '--repo', 'octo'], /--repo must be OWNER\/REPO/],
    ['a label with a comma', ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--label', 'a,b'], /--label .*comma/],
    ['a non-numeric --original', ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--original', 'x'], /--original must be a positive/],
    ['a value for --dry-run', ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--dry-run=yes'], /--dry-run takes no value/],
    ['an unknown option', ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--delete-branches'], /unknown option --delete-branches/],
  ];
  for (const [what, args, pattern] of usage) {
    test(`${what} is a usage error (exit 1) and nothing is requested`, () => {
      const world = makeWorld(worked());
      const result = cli(world, args);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, pattern);
      assert.match(result.stderr, /sarif-to-comment close-suggestion-prs --help/);
      assert.deepEqual(world.host.log(), []);
    });
  }

  test('without a token: an error (exit 1) naming the variables, and nothing requested', () => {
    const world = makeWorld(worked());
    const result = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--format', 'json'], {});
    assert.equal(result.status, 1);
    const doc = asRecord(parseJson(result.stdout));
    assert.equal(doc['status'], 'error');
    assert.match(asString(doc['message']), /GH_TOKEN/);
    assert.deepEqual(world.host.log(), []);
  });

  test('an operational failure is an error (exit 1) and nothing is closed', () => {
    const world = makeWorld(worked(), { failIssueListing: true });
    const result = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /HTTP 502/);
    assert.match(result.stderr, /Nothing was closed/);
    assert.deepEqual(writes(world), []);
  });

  test('--help documents every option and needs no token', () => {
    const world = makeWorld([]);
    const result = cli(world, ['close-suggestion-prs', '--help'], {});
    assert.equal(result.status, 0);
    for (const flag of ['--repo', '--label', '--original', '--dry-run', '--format', 'GH_TOKEN']) assert.ok(result.stdout.includes(flag), `help omits ${flag}`);
    assert.match(result.stdout, /never deletes/);
    assert.deepEqual(world.host.log(), []);
  });
});
