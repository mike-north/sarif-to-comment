/**
 * Who a cleanup acts for, and what a sweep may cost, through the production
 * composition: the real public library and CLI with the real GitHub client,
 * talking HTTP to the fake GitHub host (test/fixtures/composition). Only
 * `fetch` is replaced.
 *
 * Every expected value is written by hand from
 * docs/suggestion-cleanup-contract.md and the owner's decisions on issue #44:
 *
 * - the owner scope (§2.2, §2.6): `owner` / `--owner` names who opened the
 *   suggestion pull request; `me` (the default) closes only the
 *   authenticated account's, `all` any conforming one; someone else's is
 *   `other-owner`, read no further and never closed;
 * - branch-prefix discovery (§2.4): the default sweep lists the branches
 *   under `suggestion-pr/` with their open pull requests, page by page; the
 *   canonical label only confirms;
 * - the candidate limit (§2.4.1): the first page's total count is compared
 *   with `maxCandidates` / `--max-candidates` (default 500) before anything
 *   is evaluated;
 * - the early exit (§2.4.2): a label sweep whose first 20 pull requests show
 *   no suggestion marker and no `suggestion-pr/` branch stops, unless
 *   `force` / `--force`; it is decided before the limit, from the same first
 *   page, and `force` bypasses only it;
 * - options that would change nothing are refused (§2.2): `force` outside a
 *   label sweep, `maxCandidates` in targeted mode;
 * - the counts reported (§2.10), and the CLI's statuses and exit codes.
 *
 * Request counts come from the host's request log, which records every
 * request it receives.
 *
 * The host models documented GitHub behavior; it is not evidence of live
 * GitHub behavior (see docs/suggestion-cleanup-e2e-evidence.md).
 *
 * @see https://github.com/mike-north/sarif-to-comment/issues/44
 * @see https://docs.github.com/en/graphql/reference/objects#ref
 * @see https://docs.github.com/en/graphql/reference/objects#pullrequestconnection
 * @see https://docs.github.com/en/rest/users/users#get-the-authenticated-user
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createGitHubClient } from '../dist/github.cjs';
import type { ICreateGitHubClientOptions } from '../dist/github.cjs';
import {
  BASE,
  OWNER,
  REPO,
  TOKEN,
  cleanup,
  cli,
  closeOperation,
  closes,
  entry,
  makeWorld,
  markdown,
  original,
  originals,
  pullReads,
  results,
  suggestion,
  writes,
} from './fixtures/composition/cleanup-world.mts';
import type { IWorld, Json } from './fixtures/composition/cleanup-world.mts';
import type { IStoredPull } from './fixtures/composition/fake-http-companion.mts';
import { asArray, asRecord, asString, parseJson } from './support/runtime-types.mts';

/** Someone other than the authenticated account (the host's user is 4242). */
const SOMEONE_ELSE = 99;

/** An ordinary pull request: no marker, not on a suggestion branch. */
function ordinary(number: number, labels: readonly string[] = ['bug']): IStoredPull {
  return {
    number, title: `Fix ${String(number)}`, body: `Fixes a bug (${String(number)}).`, head: `fix/${String(number)}`, base: 'main',
    draft: false, state: 'open', merged: false, labels, authorId: SOMEONE_ELSE,
  };
}

/** `count` ordinary pull requests numbered from `from`, each labeled `labels`. */
function ordinaries(from: number, count: number, labels: readonly string[] = ['bug']): IStoredPull[] {
  return Array.from({ length: count }, (_, i) => ordinary(from + i, labels));
}

/** `count` suggestion branches without an open pull request (their suggestions were closed; closing never deletes a branch). */
function staleBranches(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `suggestion-pr/1/stale-${String(i).padStart(4, '0')}`);
}

/** Every request the host received, as `METHOD path`. */
function requests(world: IWorld): string[] {
  return world.host.log().map((r) => `${r.method} ${r.path}`);
}

/** How many times the authenticated account was read. */
function accountReads(world: IWorld): number {
  return requests(world).filter((r) => r === 'GET /user').length;
}

const COUNTS_NONE = { checked: 0, labeled: 0, conforming: 0 };

// ---------------------------------------------------------------------------

describe('owner scope: who opened the suggestion pull request (§2.2, §2.6)', () => {
  const mixed = (): IStoredPull[] => [original(37, 'closed'), suggestion(40, 37), suggestion(41, 37, { authorId: SOMEONE_ELSE })];

  test('the default is me: a suggestion someone else opened is other-owner, read no further and never closed', async () => {
    const world = makeWorld(mixed());
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'complete');
    assert.equal(outcome['owner'], 'me');
    assert.deepEqual(results(outcome), [[40, 37, 'closed'], [41, 37, 'other-owner']]);
    assert.equal(entry(outcome, 41)['reason'], undefined, 'other-owner needs no reason: it is the scope, not a problem');
    assert.deepEqual(writes(world), closes(40));
    assert.equal(accountReads(world), 1, 'the account is read once');
    assert.deepEqual(pullReads(world), [37, 40], 'the original once, then only our suggestion again');
    assert.deepEqual(outcome['diagnostics'], [], 'someone else\'s suggestion is not a problem');
    const text = markdown(outcome);
    assert.ok(text.includes('Only suggestion pull requests opened by this account are closed.'), text);
    assert.ok(text.includes('- #41 (for #37): left open, because someone else opened it'), text);
  });

  test("owner 'me', given explicitly, is the default", async () => {
    const world = makeWorld(mixed());
    const outcome = await cleanup(world, { owner: 'me' });
    assert.equal(outcome['owner'], 'me');
    assert.deepEqual(results(outcome), [[40, 37, 'closed'], [41, 37, 'other-owner']]);
  });

  test("owner 'all' closes a conforming suggestion whoever opened it, without reading the account", async () => {
    const world = makeWorld(mixed());
    const outcome = await cleanup(world, { owner: 'all' });
    assert.equal(outcome['status'], 'complete');
    assert.equal(outcome['owner'], 'all');
    assert.deepEqual(results(outcome), [[40, 37, 'closed'], [41, 37, 'closed']]);
    assert.deepEqual(writes(world), closes(40, 41));
    assert.equal(accountReads(world), 0);
    assert.ok(markdown(outcome).includes('Suggestion pull requests are closed whoever opened them.'), markdown(outcome));
  });

  test('mixed ownership across originals: someone else\'s suggestion of an open original is other-owner, and that original is never read', async () => {
    const world = makeWorld([...mixed(), original(36, 'open'), suggestion(38, 36, { authorId: SOMEONE_ELSE }), suggestion(39, 36)]);
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[38, 36, 'other-owner'], [39, 36, 'left-open'], [40, 37, 'closed'], [41, 37, 'other-owner']]);
    assert.deepEqual(originals(outcome), [[36, 'open'], [37, 'closed']]);
    const onlyTheirs = makeWorld([original(36, 'open'), suggestion(38, 36, { authorId: SOMEONE_ELSE })]);
    assert.deepEqual(results(await cleanup(onlyTheirs)), [[38, 36, 'other-owner']]);
    assert.deepEqual(pullReads(onlyTheirs), [], 'no original is read for someone else\'s suggestions');
  });

  for (const [owner, expected] of [['me', [[40, 37, 'would-close'], [41, 37, 'other-owner']]], ['all', [[40, 37, 'would-close'], [41, 37, 'would-close']]]] as const) {
    test(`a dry run with owner '${owner}' reports what it would close and writes nothing`, async () => {
      const world = makeWorld(mixed());
      const outcome = await cleanup(world, { owner, dryRun: true });
      assert.equal(outcome['status'], 'complete');
      assert.deepEqual(results(outcome), expected);
      assert.deepEqual(writes(world), []);
    });
  }

  test('conformance and the label come before the owner: someone else\'s non-conforming or unlabeled pull request is reported as such', async () => {
    const world = makeWorld([
      original(37, 'closed'),
      suggestion(40, 37, { authorId: SOMEONE_ELSE, body: 'No marker any more.' }),
      suggestion(41, 37, { authorId: SOMEONE_ELSE, labels: [] }),
    ]);
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, null, 'not-conforming'], [41, 37, 'unlabeled']]);
    assert.equal(accountReads(world), 0, 'the account is read only when an owner decides something');
  });

  test('the owner scope applies to targeted discovery too', async () => {
    const world = makeWorld(mixed());
    const outcome = await cleanup(world, { originalPullNumber: 37 });
    assert.deepEqual(results(outcome), [[40, 37, 'closed'], [41, 37, 'other-owner']]);
    assert.deepEqual(writes(world), closes(40));
  });

  test('an account that cannot be read rejects before anything is closed', async () => {
    const world = makeWorld(mixed());
    const failing: typeof world.host.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname === '/user') return new Response(JSON.stringify({ message: 'Server Error' }), { status: 502 });
      return world.host.fetch(input, init);
    };
    await assert.rejects(
      closeOperation()(
        { repository: { owner: OWNER, repo: REPO }, token: TOKEN },
        { createGitHubClient: (options: ICreateGitHubClientOptions) => createGitHubClient({ ...options, fetch: failing }) },
      ),
      (err: unknown) => err instanceof Error && /HTTP 502/.test(err.message),
    );
    assert.deepEqual(writes(world), []);
  });

  test('CLI: --owner all and --owner=me, reported in the JSON document', () => {
    const all = makeWorld(mixed());
    const allRun = cli(all, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--owner', 'all', '--format', 'json']);
    assert.equal(allRun.status, 0, allRun.stdout + allRun.stderr);
    const allDoc = asRecord(parseJson(allRun.stdout));
    assert.equal(allDoc['owner'], 'all');
    assert.deepEqual(writes(all), closes(40, 41));
    const me = makeWorld(mixed());
    const meRun = cli(me, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--owner=me', '--format', 'json']);
    assert.equal(meRun.status, 0, meRun.stdout + meRun.stderr);
    const meDoc = asRecord(parseJson(meRun.stdout));
    assert.equal(meDoc['owner'], 'me');
    assert.deepEqual(asArray(meDoc['suggestions']).map((s) => asRecord(s)['result']), ['closed', 'other-owner']);
  });
});

// ---------------------------------------------------------------------------

describe('branch-prefix discovery (§2.4)', () => {
  // Live defect of October 1, 2026 (docs/suggestion-cleanup-e2e-evidence.md):
  // in mike-north/doc-linter the default sweep counted the 18 suggestion
  // branches but found none of the 17 open pull requests on them, because
  // GitHub answers no associated pull request for a ref listed under
  // `refs/heads/suggestion-pr/` (evidence 25, 26). The host answers as GitHub
  // was observed to, so a client relying on that listing finds nothing here.
  test('live defect of October 1, 2026: the default sweep finds the open pull requests on suggestion branches, as GitHub lists them', async () => {
    const world = makeWorld([original(37, 'closed'), original(38, 'open'), suggestion(40, 37), suggestion(41, 37), suggestion(42, 38), suggestion(43, 37, { state: 'closed' })]);
    const outcome = await cleanup(world, { dryRun: true });
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(results(outcome), [[40, 37, 'would-close'], [41, 37, 'would-close'], [42, 38, 'left-open']]);
    assert.deepEqual(outcome['counts'], { candidates: 4, checked: 3, labeled: 3, conforming: 3 }, 'four branches; their three open pull requests checked');
    assert.equal(requests(world).filter((r) => r === 'POST /graphql').length, 1, 'one listing request for four branches');
    assert.deepEqual(writes(world), []);
  });

  test('a branch whose name contains `suggestion-pr/` without starting with it is neither counted nor a candidate', async () => {
    // GitHub's ref name filter matches anywhere in a name, ignoring case
    // (evidence 30, 31), so such branches are listed; only the namespace is read.
    const world = makeWorld([
      original(37, 'closed'),
      suggestion(40, 37),
      suggestion(60, 37, { head: 'backport/suggestion-pr/37/x' }),
      suggestion(61, 37, { head: 'Suggestion-PR/37/y' }),
      suggestion(62, 37, { head: 'suggestion-pr-old/37/z' }),
    ], { sweepPageSize: 2 });
    const outcome = await cleanup(world, { dryRun: true });
    assert.deepEqual(results(outcome), [[40, 37, 'would-close']]);
    assert.deepEqual(outcome['counts'], { candidates: 1, checked: 1, labeled: 1, conforming: 1 }, 'only the branch under suggestion-pr/ counts');
    assert.equal(requests(world).filter((r) => r === 'POST /graphql').length, 2, 'the listing pages through the three branches the name filter matches, two per page');
  });

  test('pages through every suggestion branch, including branches whose pull requests are gone, and counts them', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37), suggestion(41, 37, { state: 'closed' }), suggestion(42, 37)], { sweepPageSize: 2 });
    world.host.seedBranches(staleBranches(3), BASE);
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(results(outcome), [[40, 37, 'closed'], [42, 37, 'closed']]);
    assert.deepEqual(outcome['counts'], { candidates: 6, checked: 2, labeled: 2, conforming: 2 }, 'six branches; two open pull requests checked');
    assert.equal(requests(world).filter((r) => r === 'POST /graphql').length, 3, 'six branches, two per page');
    assert.deepEqual(writes(world), closes(40, 42));
  });

  test('the label only confirms: a conforming suggestion without it is found and reported unlabeled, never closed', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37, { labels: [] }), suggestion(41, 37)]);
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, 37, 'unlabeled'], [41, 37, 'closed']]);
    assert.deepEqual(outcome['counts'], { candidates: 2, checked: 2, labeled: 1, conforming: 2 });
    assert.deepEqual(writes(world), closes(41));
  });

  test('an open pull request labeled as a suggestion but not on a suggestion branch is not a candidate of the default sweep', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37), ordinary(50, ['suggestion-pr'])]);
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
  });

  test('the default sweep never stops early: suggestion branches without markers are checked and reported', async () => {
    const pulls = [original(37, 'closed'), ...Array.from({ length: 25 }, (_, i) => suggestion(100 + i, 37, { body: 'Opened by hand, no marker.' }))];
    const world = makeWorld(pulls);
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'complete');
    assert.equal(results(outcome).length, 25);
    assert.ok(results(outcome).every(([, , result]) => result === 'not-conforming'));
  });
});

// ---------------------------------------------------------------------------

describe('the candidate limit (§2.4.1)', () => {
  /** A default sweep's world with `branches` suggestion branches in all: one eligible suggestion and stale branches. */
  function branchWorld(branches: number): IWorld {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    world.host.seedBranches(staleBranches(branches - 1), BASE);
    return world;
  }

  test('501 suggestion branches exceed the default limit of 500: refused after one request, nothing evaluated', async () => {
    const world = branchWorld(501);
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'too-many-candidates');
    assert.deepEqual(outcome['originals'], []);
    assert.deepEqual(outcome['suggestions'], []);
    assert.deepEqual(outcome['counts'], { candidates: 501, ...COUNTS_NONE });
    assert.deepEqual(requests(world), ['POST /graphql'], 'the first page only: no configuration, account or pull request read');
    const [diagnostic, ...others] = asArray(outcome['diagnostics']).map((d) => asRecord(d));
    assert.deepEqual(others, []);
    assert.ok(diagnostic);
    assert.equal(diagnostic['severity'], 'error');
    assert.equal(diagnostic['code'], 'suggestion-pr-candidates-over-limit');
    assert.equal(diagnostic['subject'], `${OWNER}/${REPO}`);
    const message = asString(diagnostic['message']);
    assert.match(message, /501 branches under `suggestion-pr\/`/, 'the count');
    assert.match(message, /limit of 500/, 'the limit');
    const remedies = asArray(diagnostic['remedies']).map((r) => asString(r)).join('\n');
    assert.match(remedies, /--original/, 'how to narrow');
    assert.match(remedies, /--max-candidates/, 'how to raise the limit');
    assert.match(remedies, /include those of suggestions already closed, because cleanup never deletes a branch/, 'why an active repository reaches the limit (§2.4.1, known limitation)');
    assert.equal(
      markdown(outcome),
      ['## Suggestion pull request cleanup stopped: too many candidates', '', message].join('\n'),
    );
  });

  test('exactly 500 is within the limit', async () => {
    const world = branchWorld(500);
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
  });

  test('maxCandidates raises the limit, and lowers it', async () => {
    const raised = branchWorld(501);
    const outcome = await cleanup(raised, { maxCandidates: 501 });
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(writes(raised), closes(40));
    const lowered = makeWorld([original(37, 'closed'), suggestion(40, 37), suggestion(41, 37), suggestion(42, 37)]);
    const refused = await cleanup(lowered, { maxCandidates: 2 });
    assert.equal(refused['status'], 'too-many-candidates');
    assert.match(asString(asRecord(asArray(refused['diagnostics'])[0])['message']), /3 branches .*limit of 2/);
    assert.deepEqual(writes(lowered), []);
  });

  test('a label sweep over the limit, whose first page shows a suggestion, is refused after one request, before the second page, the account or any pull request', async () => {
    // The first page passes the early exit (§2.4.2: #40 carries a marker), so the limit decides (§2.4.1).
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37, { labels: ['bug'] }), ...ordinaries(1000, 500)]);
    const outcome = await cleanup(world, { label: 'bug' });
    assert.equal(outcome['status'], 'too-many-candidates');
    assert.deepEqual(outcome['counts'], { candidates: 501, ...COUNTS_NONE });
    assert.deepEqual(requests(world), ['POST /graphql']);
    assert.match(asString(asRecord(asArray(outcome['diagnostics'])[0])['message']), /501 open pull requests labeled `bug`/);
  });

  test('a dry run is refused the same way', async () => {
    const world = branchWorld(501);
    const outcome = await cleanup(world, { dryRun: true });
    assert.equal(outcome['status'], 'too-many-candidates');
    assert.deepEqual(requests(world), ['POST /graphql']);
  });

  for (const [what, value] of [['zero', 0], ['negative', -1], ['fractional', 1.5], ['a string', '500'], ['not a number', Number.NaN]] as const) {
    test(`a limit that is ${what} is a TypeError before any request`, async () => {
      const world = makeWorld([]);
      await assert.rejects(cleanup(world, { maxCandidates: value }), (err: unknown) => err instanceof TypeError && /maxCandidates must be a positive integer/.test(err.message));
      assert.deepEqual(world.host.log(), []);
    });
  }

  test('CLI: exit 1 with the error diagnostic; --max-candidates lets it run', () => {
    const world = branchWorld(501);
    const refused = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`]);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.equal(refused.stdout, '## Suggestion pull request cleanup stopped: too many candidates\n\nNothing was checked or closed.\n');
    assert.match(refused.stderr, /^✖ error {2}.* {2}\[suggestion-pr-candidates-over-limit\]\n/);
    assert.match(refused.stderr, /501 branches/);
    const json = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--format', 'json']);
    assert.equal(json.status, 1);
    const doc = asRecord(parseJson(json.stdout));
    assert.equal(doc['status'], 'too-many-candidates');
    assert.deepEqual(doc['counts'], { candidates: 501, ...COUNTS_NONE });
    assert.deepEqual(asArray(doc['diagnostics']).map((d) => asRecord(d)['code']), ['suggestion-pr-candidates-over-limit']);
    assert.deepEqual(writes(world), []);
    const allowed = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--max-candidates', '600']);
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    assert.deepEqual(writes(world), closes(40));
  });
});

// ---------------------------------------------------------------------------

describe('the early exit of a label sweep (§2.4.2)', () => {
  /** An eligible suggestion carrying `bug`, numbered after `count` ordinary pull requests labeled `bug`. */
  const buggy = (count: number): IStoredPull[] => [original(37, 'closed'), ...ordinaries(100, count), suggestion(100 + count, 37, { labels: ['bug'] })];

  test('the first 20 of 25 pull requests show no marker and no suggestion branch: stopped after one request, nothing evaluated', async () => {
    const world = makeWorld(ordinaries(100, 25));
    const outcome = await cleanup(world, { label: 'bug' });
    assert.equal(outcome['status'], 'label-not-suggestion-prs');
    assert.deepEqual(outcome['originals'], []);
    assert.deepEqual(outcome['suggestions'], []);
    assert.deepEqual(outcome['counts'], { candidates: 25, ...COUNTS_NONE });
    assert.deepEqual(requests(world), ['POST /graphql'], 'only the listing: no per-pull-request read');
    const [diagnostic, ...others] = asArray(outcome['diagnostics']).map((d) => asRecord(d));
    assert.deepEqual(others, []);
    assert.ok(diagnostic);
    assert.equal(diagnostic['severity'], 'warning');
    assert.equal(diagnostic['code'], 'label-not-suggestion-prs');
    const message = asString(diagnostic['message']);
    assert.match(message, /first 20 of the 25 open pull requests labeled `bug`/);
    assert.match(asArray(diagnostic['remedies']).map((r) => asString(r)).join('\n'), /--force/);
    assert.equal(markdown(outcome), ['## Suggestion pull request cleanup stopped: the label does not mark suggestion pull requests', '', message].join('\n'));
  });

  test('only the first page is inspected: a suggestion at the 21st pull request does not prevent the stop', async () => {
    const world = makeWorld(buggy(20));
    const outcome = await cleanup(world, { label: 'bug' });
    assert.equal(outcome['status'], 'label-not-suggestion-prs');
    assert.deepEqual(writes(world), []);
  });

  test('a marker on the first page lets the sweep continue', async () => {
    const world = makeWorld(buggy(19));
    const outcome = await cleanup(world, { label: 'bug' });
    assert.equal(outcome['status'], 'complete');
    assert.equal(results(outcome).length, 20);
    assert.deepEqual(results(outcome).filter(([, , r]) => r !== 'not-conforming'), [[119, 37, 'closed']]);
    assert.deepEqual(outcome['counts'], { candidates: 20, checked: 20, labeled: 20, conforming: 1 });
  });

  test('a suggestion-pr/ branch on the first page lets the sweep continue, even without a marker', async () => {
    const world = makeWorld([...ordinaries(100, 19), ordinary(119, ['bug'])].map((pr) => (pr.number === 119 ? { ...pr, head: 'suggestion-pr/37/by-hand' } : pr)));
    const outcome = await cleanup(world, { label: 'bug' });
    assert.equal(outcome['status'], 'complete');
    assert.equal(results(outcome).length, 20);
  });

  test('force evaluates anyway: the ordinary pull requests are not conforming, and the suggestion is closed', async () => {
    const world = makeWorld(buggy(20));
    const outcome = await cleanup(world, { label: 'bug', force: true });
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(results(outcome).filter(([, , r]) => r !== 'not-conforming'), [[120, 37, 'closed']]);
    assert.equal(results(outcome).length, 21);
    assert.deepEqual(writes(world), closes(120));
  });

  test('a dry run stops the same way, and with force reports what it would close', async () => {
    const stopped = makeWorld(buggy(20));
    assert.equal((await cleanup(stopped, { label: 'bug', dryRun: true }))['status'], 'label-not-suggestion-prs');
    const forced = makeWorld(buggy(20));
    const outcome = await cleanup(forced, { label: 'bug', dryRun: true, force: true });
    assert.deepEqual(results(outcome).filter(([, , r]) => r !== 'not-conforming'), [[120, 37, 'would-close']]);
    assert.deepEqual(writes(stopped), []);
    assert.deepEqual(writes(forced), []);
  });

  test('a label no open pull request carries is not stopped: nothing to check, one request', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    const outcome = await cleanup(world, { label: 'no-such-label' });
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(outcome['suggestions'], []);
    assert.deepEqual(requests(world), ['POST /graphql']);
  });

  test('force that is not a boolean is a TypeError before any request', async () => {
    const world = makeWorld([]);
    await assert.rejects(cleanup(world, { label: 'bug', force: 'yes' }), (err: unknown) => err instanceof TypeError && /force must be a boolean/.test(err.message));
    assert.deepEqual(world.host.log(), []);
  });

  test('CLI: exit 2 with the warning; --force evaluates (exit 0)', () => {
    const world = makeWorld(buggy(20));
    const stopped = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--label', 'bug']);
    assert.equal(stopped.status, 2, stopped.stdout + stopped.stderr);
    assert.equal(stopped.stdout, '## Suggestion pull request cleanup stopped: the label does not mark suggestion pull requests\n\nNothing was checked or closed.\n');
    assert.match(stopped.stderr, /^▲ warning {2}.* {2}\[label-not-suggestion-prs\]\n/);
    const doc = asRecord(parseJson(cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--label', 'bug', '--format', 'json']).stdout));
    assert.equal(doc['status'], 'label-not-suggestion-prs');
    assert.deepEqual(writes(world), []);
    const forced = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--label', 'bug', '--force', '--format', 'json']);
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
    assert.equal(asRecord(parseJson(forced.stdout))['status'], 'complete');
    assert.deepEqual(writes(world), closes(120));
  });
});

// ---------------------------------------------------------------------------

describe('the early exit comes before the limit (§2.4.1, §2.4.2)', () => {
  // Both checks read the same first page, so a wrong broad label is refused
  // as a wrong label (exit 2), however many pull requests carry it, and
  // still after exactly one request.
  for (const count of [30, 600]) {
    test(`a wrong label on ${String(count)} pull requests is label-not-suggestion-prs after exactly one request, not too-many-candidates`, async () => {
      const world = makeWorld(ordinaries(1000, count));
      const outcome = await cleanup(world, { label: 'bug' });
      assert.equal(outcome['status'], 'label-not-suggestion-prs');
      assert.deepEqual(outcome['counts'], { candidates: count, ...COUNTS_NONE });
      assert.deepEqual(asArray(outcome['diagnostics']).map((d) => asRecord(d)['code']), ['label-not-suggestion-prs']);
      assert.match(asString(asRecord(asArray(outcome['diagnostics'])[0])['message']), new RegExp(`first 20 of the ${String(count)} open pull requests labeled \`bug\``));
      assert.deepEqual(requests(world), ['POST /graphql'], 'exactly one request before the refusal');
    });
  }

  test('force bypasses only the early exit: the limit still applies after it, still after exactly one request', async () => {
    const world = makeWorld(ordinaries(1000, 600));
    const outcome = await cleanup(world, { label: 'bug', force: true });
    assert.equal(outcome['status'], 'too-many-candidates');
    assert.deepEqual(outcome['counts'], { candidates: 600, ...COUNTS_NONE });
    const [diagnostic, ...others] = asArray(outcome['diagnostics']).map((d) => asRecord(d));
    assert.deepEqual(others, []);
    assert.ok(diagnostic);
    assert.equal(diagnostic['code'], 'suggestion-pr-candidates-over-limit');
    assert.match(asString(diagnostic['message']), /600 open pull requests labeled `bug` .*limit of 500/);
    assert.deepEqual(requests(world), ['POST /graphql']);
  });

  test('force within the limit evaluates every pull request', async () => {
    const world = makeWorld(ordinaries(1000, 30));
    const outcome = await cleanup(world, { label: 'bug', force: true, dryRun: true });
    assert.equal(outcome['status'], 'complete');
    assert.equal(results(outcome).length, 30);
    assert.ok(results(outcome).every(([, , result]) => result === 'not-conforming'));
  });

  test('CLI: a wrong broad label exits 2, and with --force exits 1 over the limit; one request each', () => {
    const world = makeWorld(ordinaries(1000, 600));
    const wrong = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--label', 'bug', '--format', 'json']);
    assert.equal(wrong.status, 2, wrong.stdout + wrong.stderr);
    assert.equal(asRecord(parseJson(wrong.stdout))['status'], 'label-not-suggestion-prs');
    assert.deepEqual(requests(world), ['POST /graphql']);
    const forced = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--label', 'bug', '--force', '--format', 'json']);
    assert.equal(forced.status, 1, forced.stdout + forced.stderr);
    const doc = asRecord(parseJson(forced.stdout));
    assert.equal(doc['status'], 'too-many-candidates');
    assert.deepEqual(asArray(doc['diagnostics']).map((d) => asRecord(d)['code']), ['suggestion-pr-candidates-over-limit']);
    assert.deepEqual(requests(world), ['POST /graphql', 'POST /graphql']);
    assert.deepEqual(writes(world), []);
  });
});

// ---------------------------------------------------------------------------

describe('an option that would change nothing is refused, never ignored (§2.2)', () => {
  // Only a label sweep stops early, so force means something only there; and
  // targeted discovery has no candidate limit (§2.4.1, §2.4.2).
  const refusals: readonly (readonly [string, Json, RegExp])[] = [
    ['force without label', { force: true }, /force applies only to a label sweep, so it requires label/],
    ['force in targeted mode', { label: 'bug', originalPullNumber: 37, force: true }, /force applies only to a label sweep, so it cannot be combined with originalPullNumber/],
    ['maxCandidates in targeted mode', { originalPullNumber: 37, maxCandidates: 10 }, /maxCandidates limits a sweep, so it cannot be combined with originalPullNumber/],
    ['maxCandidates in targeted mode with a label', { label: 'bug', originalPullNumber: 37, maxCandidates: 10 }, /maxCandidates limits a sweep, so it cannot be combined with originalPullNumber/],
  ];
  for (const [what, extra, pattern] of refusals) {
    test(`library: ${what} is a TypeError before any request`, async () => {
      const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
      await assert.rejects(
        cleanup(world, extra),
        (err: unknown) => err instanceof TypeError && err.message.startsWith('Invalid closeSuggestionPullRequests input: ') && pattern.test(err.message),
      );
      assert.deepEqual(world.host.log(), []);
    });
  }

  test('library: force: false asks for nothing, so it is accepted without a label', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    const outcome = await cleanup(world, { force: false });
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(writes(world), closes(40));
  });

  const usage: readonly (readonly [string, readonly string[], string])[] = [
    ['--force without --label', ['--force'], '--force requires --label (only a --label sweep stops early)'],
    ['--force with --original', ['--label', 'bug', '--original', '37', '--force'], '--force cannot be combined with --original (only a --label sweep stops early)'],
    ['--max-candidates with --original', ['--original', '37', '--max-candidates', '10'], '--max-candidates cannot be combined with --original (only a sweep has a candidate limit)'],
  ];
  for (const [what, args, message] of usage) {
    test(`CLI: ${what} is a usage error (exit 1) before any request, even without a token`, () => {
      const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
      const human = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, ...args], {});
      assert.equal(human.status, 1, human.stdout + human.stderr);
      assert.equal(human.stdout, '');
      assert.ok(human.stderr.includes(message), human.stderr);
      assert.ok(human.stderr.includes('Run `sarif-to-comment close-suggestion-prs --help` for usage.'), human.stderr);
      const json = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, ...args, '--format', 'json']);
      assert.equal(json.status, 1, json.stdout + json.stderr);
      const doc = asRecord(parseJson(json.stdout));
      assert.equal(doc['command'], 'close-suggestion-prs');
      assert.equal(doc['status'], 'usage-error');
      assert.equal(doc['message'], message);
      const [diagnostic, ...others] = asArray(doc['diagnostics']).map((d) => asRecord(d));
      assert.deepEqual(others, []);
      assert.ok(diagnostic);
      assert.equal(diagnostic['code'], 'usage-error');
      assert.equal(diagnostic['subject'], 'close-suggestion-prs');
      assert.deepEqual(diagnostic['remedies'], ['Run `sarif-to-comment close-suggestion-prs --help` for usage.']);
      assert.deepEqual(world.host.log(), []);
    });
  }
});

// ---------------------------------------------------------------------------

describe('counts (§2.10)', () => {
  test('the pull requests checked, how many carried the label and how many conform', async () => {
    const world = makeWorld([
      original(37, 'closed'),
      suggestion(40, 37),
      suggestion(41, 37, { labels: [] }),
      suggestion(42, 37, { body: 'No marker.' }),
      suggestion(43, 37, { authorId: SOMEONE_ELSE }),
    ]);
    const outcome: Json = await cleanup(world, { dryRun: true });
    assert.deepEqual(outcome['counts'], { candidates: 4, checked: 4, labeled: 3, conforming: 3 });
    assert.ok(markdown(outcome).includes('\n\nPull requests checked: 4 (3 labeled, 3 conforming).\n\n'), markdown(outcome));
  });
});
