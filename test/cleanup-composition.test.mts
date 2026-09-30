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
 * the CLI's output and exit statuses. The default sweep discovers suggestions
 * by their `suggestion-pr/` branches (§2.4); owner scope and bounded
 * discovery are tested in test/cleanup-scope.test.mts. Suggestion markers and branches are
 * written out by hand from the suggestion pull request convention's templates
 * (docs/suggestion-pr-convention.md §5, §7), never produced by the code under
 * test. The repository has no configuration file, so the canonical label is
 * the default `suggestion-pr`; configured labels are tested in
 * test/suggestion-pr-convention.test.mts.
 *
 * The host models documented GitHub behavior; it is not evidence of live
 * GitHub behavior (see docs/suggestion-cleanup-e2e-evidence.md).
 *
 * @see https://docs.github.com/en/graphql/reference/objects#ref
 * @see https://docs.github.com/en/graphql/reference/objects#pullrequestconnection
 * @see https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request
 * @see https://docs.github.com/en/graphql/reference/objects#crossreferencedevent
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createGitHubClient } from '../dist/github.cjs';
import type { ICreateGitHubClientOptions } from '../dist/github.cjs';
import {
  BASE,
  BATCH,
  HEAD,
  OWNER,
  REPO,
  TOKEN,
  cleanup,
  cli,
  closeOperation,
  closes,
  entry,
  idOf,
  makeWorld,
  markdown,
  markerLine,
  original,
  originals,
  pullReads,
  pullUrl,
  results,
  stateOf,
  suggestion,
  suggestionBody,
  writes,
} from './fixtures/composition/cleanup-world.mts';
import type { IWorld, Json } from './fixtures/composition/cleanup-world.mts';
import type { ICompanionConfig, IStoredPull } from './fixtures/composition/fake-http-companion.mts';
import { assertDiagnostics } from './support/diagnostics.mts';
import { asArray, asRecord, asString, parseJson } from './support/runtime-types.mts';

// ---------------------------------------------------------------------------

describe('harness controls', () => {
  test('the hand-written marker names the suggestion, and the seeded suggestion uses its branch', () => {
    assert.equal(
      markerLine(40, 37),
      '<!-- suggestion-pr {"version":1,"original":{"owner":"octo","repo":"widgets","pullNumber":37},"reviewedCommit":"feedfeedfeedfeedfeedfeedfeedfeedfeedfeed","id":"00000000-0000-4000-8000-000000000040","batch":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"} -->',
    );
    assert.equal(suggestion(40, 37).head, 'suggestion-pr/37/00000000-0000-4000-8000-000000000040');
  });

  test('the host closes only with the documented body, and lists the open pull requests of suggestion branches', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37), suggestion(41, 37, { state: 'closed' }), suggestion(42, 37, { labels: [] })]);
    const query = 'query ($owner: String!, $repo: String!, $prefix: String!, $first: Int!, $after: String) { repository(owner: $owner, name: $repo) { refs(refPrefix: $prefix, first: $first, after: $after) { totalCount nodes { name associatedPullRequests(states: OPEN, first: 10) { nodes { number } } } } } }';
    const listing = await world.host.fetch('https://api.github.com/graphql', {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ query, variables: { owner: OWNER, repo: REPO, prefix: 'refs/heads/suggestion-pr/', first: 100, after: null } }),
    });
    const refs = asRecord(asRecord(asRecord(asRecord(await listing.json())['data'])['repository'])['refs']);
    assert.equal(refs['totalCount'], 3, 'a closed pull request\'s branch is still a branch');
    assert.deepEqual(
      asArray(refs['nodes']).map((n) => asArray(asRecord(asRecord(n)['associatedPullRequests'])['nodes']).map((pr) => asRecord(pr)['number'])),
      [[40], [], [42]],
    );
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
    { ...suggestion(41, 37), title: 'Opened by hand', body: 'A pull request someone opened by hand on a suggestion branch, without a marker.', head: 'suggestion-pr/37/by-hand' },
  ];

  const header = [
    'Checked the open pull requests on `suggestion-pr/` branches in octo/widgets; the suggestion label is `suggestion-pr` (the default suggestion label). Only suggestion pull requests opened by this account are closed.',
    '',
    'Pull requests checked: 4 (4 labeled, 3 conforming).',
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
  const notConforming = '- #41: skipped, not a conforming suggestion pull request: its branch is under `suggestion-pr/`, but it has no suggestion marker';
  const branches = 'Closing never deletes a branch: each proposal branch is left in place.';

  test('a dry run reads everything, reports what would be closed and writes nothing', async () => {
    const world = makeWorld(seeded());
    const outcome = await cleanup(world, { dryRun: true });
    assert.equal(outcome['status'], 'complete');
    assert.equal(outcome['dryRun'], true);
    assert.deepEqual(originals(outcome), [[36, 'open'], [37, 'closed']]);
    assert.deepEqual(results(outcome), [[38, 36, 'left-open'], [39, 36, 'left-open'], [40, 37, 'would-close'], [41, null, 'not-conforming']]);
    assert.equal(outcome['owner'], 'me');
    assert.deepEqual(outcome['counts'], { candidates: 4, checked: 4, labeled: 4, conforming: 3 });
    assert.equal(
      markdown(outcome),
      ['## Suggestion pull request cleanup: dry run', '', ...header, '- #40 (for #37): would be closed', notConforming, '', 'This was a dry run: nothing was closed.', '', branches].join('\n'),
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
    assert.deepEqual(results(outcome), [[38, 36, 'left-open'], [39, 36, 'left-open'], [40, 37, 'closed'], [41, null, 'not-conforming']]);
    assert.deepEqual(entry(outcome, 40), { number: 40, url: pullUrl(40), original: 37, result: 'closed' });
    assert.equal(
      markdown(outcome),
      ['## Suggestion pull request cleanup complete', '', ...header, '- #40 (for #37): closed', notConforming, '', branches].join('\n'),
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
    assert.deepEqual(results(again), [[38, 36, 'left-open'], [39, 36, 'left-open'], [41, null, 'not-conforming']]);
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

  // Contract §2.7: a 404 is a definitive answer (the repository, which was
  // just listed, has no such pull request), so it is `not-found`, below;
  // every other failed lookup is `unverified`.
  const inaccessible: readonly (readonly [string, ICompanionConfig, RegExp])[] = [
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

  test('regression (#43): a marker naming a pull request that does not exist (404) is not-conforming, and the cleanup is complete rather than retried forever', async () => {
    const world = makeWorld([original(36, 'open'), suggestion(38, 36), suggestion(40, 37)], { pullReads: { '37': 'not-found' } });
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(originals(outcome), [[36, 'open'], [37, 'not-found']]);
    assert.deepEqual(asArray(outcome['originals']).map((o) => Object.keys(asRecord(o))), [['number', 'state'], ['number', 'state']], 'a not-found original has no reason');
    assert.deepEqual(results(outcome), [[38, 36, 'left-open'], [40, 37, 'not-conforming']]);
    assert.equal(entry(outcome, 40)['reason'], 'its marker names #37, which is not a pull request in octo/widgets');
    assert.deepEqual(writes(world), []);
    assert.equal(stateOf(world, 40).state, 'open');
    const text = markdown(outcome);
    assert.ok(text.startsWith('## Suggestion pull request cleanup complete\n'), text);
    assert.ok(text.includes('- #37: not found (octo/widgets has no pull request #37 that this account can read)\n'), text);
    assert.ok(text.includes('- #40 (for #37): skipped, not a conforming suggestion pull request: its marker names #37, which is not a pull request in octo/widgets\n'), text);
    assert.equal(text.includes('Running the cleanup again is safe'), false, text);
    // The suggestion's note says it; the original needs no warning of its own.
    assertDiagnostics(outcome['diagnostics'], [{ code: 'suggestion-pr-not-conforming', subject: 'octo/widgets#40' }]);
  });
});

describe('pagination and duplicate references (A31)', () => {
  test('every page of more than 200 suggestion branches is read; nothing is skipped', async () => {
    const pulls = [original(36, 'open'), original(37, 'merged')];
    for (let n = 100; n < 305; n += 1) pulls.push(suggestion(n, 36));
    pulls.push(suggestion(305, 37));
    const world = makeWorld(pulls);
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'complete');
    assert.equal(results(outcome).length, 206);
    assert.deepEqual(results(outcome).filter(([, , r]) => r !== 'left-open'), [[305, 37, 'closed']]);
    const listings = world.host.log().filter((r) => r.path === '/graphql');
    assert.equal(listings.length, 3, 'three pages of 100 branches');
    assert.deepEqual(pullReads(world).sort((a, b) => a - b), [36, 37, 305], 'one read per original, and only the ended one\'s suggestion');
  });

  test('a pull request into another repository from a suggestion branch here (a fork\'s pull request into its upstream) is left out', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37), { ...suggestion(41, 37), repository: 'upstream/widgets', headRepo: `${OWNER}/${REPO}` }]);
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
    assert.deepEqual(writes(world), closes(40));
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
    assert.deepEqual(results(outcome), [[40, 37, 'not-conforming'], [41, 37, 'not-conforming']]);
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

  // A fork's branch, or a branch outside suggestion-pr/, is never among this
  // repository's suggestion branches, so those cases are found by a label sweep.
  const bySuggestionLabel: Json = { label: 'suggestion-pr' };
  const skipped: readonly (readonly [string, IStoredPull, RegExp, number | null, Json])[] = [
    ['the marker was removed', suggestion(40, 37, { body: 'Suggested in a review of #37.' }), /no suggestion marker/, null, {}],
    ['the marker was changed', suggestion(40, 37, { body: suggestionBody(40, 37).replace('"version":1', '"version": 1') }), /canonical/, null, {}],
    ['the marker is quoted twice', suggestion(40, 37, { body: `${suggestionBody(40, 37)}\n\n> ${markerLine(40, 37)}\n${markerLine(40, 37)}` }), /more than one/, null, {}],
    ['the marker names another repository', suggestion(40, 37, { body: `Moved.\n\n${markerLine(40, 37, '"owner":"elsewhere","repo":"widgets","pullNumber":37')}` }), /another repository \(elsewhere\/widgets\)/, null, {}],
    ['its head is in a fork', suggestion(40, 37, { headRepo: 'someone/widgets' }), /someone\/widgets/, 37, bySuggestionLabel],
    ['its head branch is not the marker\'s branch', suggestion(40, 37, { head: 'suggestion-pr/37/other' }), /suggestion-pr\/37\/other/, 37, {}],
    ['its head branch is the unreleased tool-branded form', suggestion(40, 37, { head: `sarif-to-comment/suggestions/37/${idOf(40)}` }), /sarif-to-comment\/suggestions\/37/, 37, bySuggestionLabel],
  ];
  for (const [what, pull, reason, originalNumber, mode] of skipped) {
    test(`not a conforming suggestion, never closed: ${what}`, async () => {
      const world = makeWorld(ended(pull));
      const outcome = await cleanup(world, mode);
      assert.equal(outcome['status'], 'complete');
      assert.deepEqual(results(outcome), [[40, originalNumber, 'not-conforming']]);
      assert.match(asString(entry(outcome, 40)['reason']), reason);
      assert.deepEqual(writes(world), []);
    });
  }

  test('owner and repository in the marker are compared case-insensitively, as GitHub names are', async () => {
    const world = makeWorld(ended(suggestion(40, 37, { body: `Text.\n\n${markerLine(40, 37, '"owner":"Octo","repo":"Widgets","pullNumber":37')}` })));
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
  });

  test('a suggestion re-applied after a rewritten history (a version 2 marker, convention §7; issue #28) is closed like any other', async () => {
    const reapplied = `<!-- suggestion-pr {"version":2,"original":{"owner":"${OWNER}","repo":"${REPO}","pullNumber":37},"reviewedCommit":"${HEAD}","reappliedOnto":"${BASE}","id":"${idOf(40)}","batch":"${BATCH}"} -->`;
    const world = makeWorld(ended(suggestion(40, 37, { body: `Suggested in a review of #37 at commit ${HEAD}.\n\nRe-applied.\n\n${reapplied}` })));
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
    assert.deepEqual(writes(world), closes(40));
  });

  test('a version 2 marker without reappliedOnto is not conforming, and is never closed', async () => {
    const broken = markerLine(40, 37).replace('"version":1', '"version":2');
    const world = makeWorld(ended(suggestion(40, 37, { body: `Text.\n\n${broken}` })));
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, null, 'not-conforming']]);
    assert.deepEqual(writes(world), []);
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

  /** Cleanup where a person acts right after the sweep is answered; the fresh read sees it. */
  async function cleanupWithChangeAfterListing(world: IWorld, change: () => void): Promise<Json> {
    const host = world.host.fetch.bind(world.host);
    const people: typeof world.host.fetch = async (input, init) => {
      const response = await host(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/graphql')) change();
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
      assert.deepEqual(results(outcome), [[40, 37, 'not-conforming']]);
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

  test('an issue carrying the label is not a pull request and is ignored by a label sweep', async () => {
    const world = makeWorld(ended(suggestion(40, 37), { ...suggestion(41, 37), isIssue: true }));
    const outcome = await cleanup(world, bySuggestionLabel);
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
  });

  test('no suggestion branches: complete, with nothing to report', async () => {
    const world = makeWorld([original(37, 'closed')]);
    const outcome = await cleanup(world);
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(outcome['originals'], []);
    assert.deepEqual(outcome['suggestions'], []);
    assert.equal(
      markdown(outcome),
      [
        '## Suggestion pull request cleanup complete', '',
        'Checked the open pull requests on `suggestion-pr/` branches in octo/widgets; the suggestion label is `suggestion-pr` (the default suggestion label). Only suggestion pull requests opened by this account are closed.', '',
        'No suggestion pull requests were found.', '',
        'Closing never deletes a branch: each proposal branch is left in place.',
      ].join('\n'),
    );
    assert.deepEqual(outcome['counts'], { candidates: 0, checked: 0, labeled: 0, conforming: 0 });
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
    assert.deepEqual(results(outcome), [[40, 37, 'closed'], [46, 36, 'not-conforming'], [47, 37, 'already-closed']]);
    assert.match(asString(entry(outcome, 46)['reason']), /names #36, not #37/);
    assert.deepEqual(writes(world), closes(40));
    assert.ok(markdown(outcome).includes('Checked the pull requests that reference #37 in octo/widgets; the suggestion label is `suggestion-pr` (the default suggestion label).'), markdown(outcome));
    assert.equal(world.host.log().filter((r) => r.path === '/graphql').length, 1, 'one backlink query and no sweep');
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

  // With a label override the configuration is not read, so nothing else
  // proves the repository exists: a 404 for the original would otherwise be
  // taken as "no such pull request" in a repository that is itself mistyped
  // or invisible to the token (GitHub answers 404 for both).
  const unreadableRepository: readonly (readonly [string, string, ICompanionConfig, RegExp])[] = [
    ['a mistyped repository', 'widgts', {}, /HTTP 404/],
    ['a repository whose read fails', REPO, { failRepositoryRead: true }, /HTTP 502/],
  ];
  for (const [what, repo, config, reason] of unreadableRepository) {
    test(`regression (#43): ${what} with a label override is an operational failure, never a not-found original`, async () => {
      const world = makeWorld([original(37, 'closed'), suggestion(40, 37)], config);
      const name = `${OWNER}/${repo}`;
      const input = { repository: { owner: OWNER, repo }, label: 'suggestion-pr', originalPullNumber: 37 };
      await assert.rejects(cleanup(world, input), (err: unknown) => {
        assert.ok(err instanceof Error && !(err instanceof TypeError), String(err));
        assert.ok(err.message.startsWith(`The repository ${name} could not be read (`), err.message);
        assert.match(err.message, reason);
        return true;
      });
      assert.equal(world.host.log().some((r) => r.path.includes('/pulls/')), false, 'no original is read before the repository is');
      assert.deepEqual(writes(world), []);
    });
  }

  test('the repository is read once where nothing else proves it exists, and never by a label sweep, whose first page does', async () => {
    // The configuration read begins by reading the repository; a label
    // sweep's first listing fails on a missing repository, so only the label
    // override in targeted mode reads it on its own (§2.2.1).
    const repositoryReads = (world: IWorld): number => world.host.log().filter((r) => r.method === 'GET' && r.path === `/repos/${OWNER}/${REPO}`).length;
    const cases: readonly (readonly [Json, number])[] = [
      [{}, 1],
      [{ label: 'suggestion-pr' }, 0],
      [{ originalPullNumber: 37 }, 1],
      [{ originalPullNumber: 37, label: 'suggestion-pr' }, 1],
    ];
    for (const [extra, reads] of cases) {
      const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
      const outcome = await cleanup(world, extra);
      assert.equal(outcome['status'], 'complete', JSON.stringify(extra));
      assert.equal(repositoryReads(world), reads, JSON.stringify(extra));
    }
  });

  test('a label sweep of a mistyped repository rejects on its first listing, never a not-found original', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    await assert.rejects(cleanup(world, { repository: { owner: OWNER, repo: 'widgts' }, label: 'suggestion-pr' }), (err: unknown) => err instanceof Error && !(err instanceof TypeError));
    assert.deepEqual(world.host.log().map((r) => `${r.method} ${r.path}`), ['POST /graphql'], 'one request, and no original is read');
    assert.deepEqual(writes(world), []);
  });

  test('with a label override, an original that does not exist in a repository that does is still not-found', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    const outcome = await cleanup(world, { label: 'suggestion-pr', originalPullNumber: 99 });
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(outcome['originals'], [{ number: 99, state: 'not-found' }]);
    assertDiagnostics(outcome['diagnostics'], [{ code: 'original-pull-request-not-found', subject: 'octo/widgets#99' }]);
  });

  test('regression (#43): an original that does not exist (a typo in the number) is a definitive, complete outcome with a warning, never an endless retry', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    const outcome = await cleanup(world, { originalPullNumber: 99 });
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(outcome['originals'], [{ number: 99, state: 'not-found' }]);
    assert.deepEqual(outcome['suggestions'], []);
    assert.equal(world.host.log().some((r) => r.path === '/graphql'), false, 'no backlink query: nothing can reference it');
    assert.deepEqual(writes(world), []);
    assert.equal(
      markdown(outcome),
      [
        '## Suggestion pull request cleanup complete',
        '',
        'Checked the pull requests that reference #99 in octo/widgets; the suggestion label is `suggestion-pr` (the default suggestion label). Only suggestion pull requests opened by this account are closed.',
        '',
        'Original pull requests:',
        '',
        '- #99: not found (octo/widgets has no pull request #99 that this account can read)',
        '',
        'No suggestion pull requests were found.',
        '',
        'Closing never deletes a branch: each proposal branch is left in place.',
      ].join('\n'),
    );
    assertDiagnostics(outcome['diagnostics'], [{
      code: 'original-pull-request-not-found',
      subject: 'octo/widgets#99',
      message: /^octo\/widgets has no pull request #99 that this account can read, so no suggestion pull request can reference it\.$/,
    }]);
    // The same answer every time: running it again changes nothing.
    const again = await cleanup(world, { originalPullNumber: 99 });
    assert.deepEqual(again, outcome);
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
  test('a failing sweep rejects before any write; the token never appears', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)], { failSweep: true });
    await assert.rejects(cleanup(world), (err: unknown) => err instanceof Error && /SERVICE_UNAVAILABLE/.test(err.message) && !err.message.includes(TOKEN));
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
    ['an owner scope that is not me or all', { owner: 'octo' }, /owner must be 'me' or 'all'/],
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
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'dryRun', 'owner', 'originals', 'suggestions', 'counts', 'message', 'diagnostics']);
    assert.equal(doc['command'], 'close-suggestion-prs');
    assert.equal(doc['status'], 'complete');
    assert.equal(doc['dryRun'], false);
    assert.equal(doc['owner'], 'me');
    assert.deepEqual(doc['counts'], { candidates: 1, checked: 1, labeled: 1, conforming: 1 });
    assert.deepEqual(doc['originals'], [{ number: 37, state: 'closed' }]);
    assert.deepEqual(doc['suggestions'], [{ number: 40, url: pullUrl(40), original: 37, result: 'closed' }]);
    assert.ok(asString(doc['message']).startsWith('## Suggestion pull request cleanup complete'));
  });

  test('exit 2 when only permission limits remain, 3 when incomplete', () => {
    const limited = makeWorld(worked(), { closes: { '40': 'forbidden' } });
    assert.equal(cli(limited, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`]).status, 2);
    const incomplete = makeWorld(worked(), { pullReads: { '37': 'server-error' } });
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
    ['an owner scope that is not me or all', ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--owner', 'octo'], /--owner must be me or all/],
    ['a candidate limit that is not a positive whole number', ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--max-candidates', '0'], /--max-candidates must be a positive/],
    ['a value for --force', ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--force=yes'], /--force takes no value/],
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
    const world = makeWorld(worked(), { failSweep: true });
    const result = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SERVICE_UNAVAILABLE/);
    assert.match(result.stdout, /Nothing was closed/);
    assert.match(result.stderr, /\[operation-failed\]/);
    assert.deepEqual(writes(world), []);
  });

  test('regression (#43): a mistyped --repo with --label and --original exits 1 naming the repository, never a not-found success', () => {
    const world = makeWorld(worked());
    const human = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/widgts`, '--label', 'suggestion-pr', '--original', '37']);
    assert.equal(human.status, 1, human.stdout + human.stderr);
    assert.equal(human.stdout, 'Nothing was closed.\n');
    assert.match(human.stderr, /\[operation-failed\]/);
    assert.ok(human.stderr.includes('The repository octo/widgts could not be read ('), human.stderr);
    assert.equal(/not-found|has no pull request/.test(human.stderr), false, human.stderr);
    const json = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/widgts`, '--label', 'suggestion-pr', '--original', '37', '--format', 'json']);
    assert.equal(json.status, 1);
    const doc = asRecord(parseJson(json.stdout));
    assert.equal(doc['status'], 'error');
    assertDiagnostics(doc['diagnostics'], [{ code: 'operation-failed', message: /^The repository octo\/widgts could not be read \(/ }]);
    assert.deepEqual(writes(world), []);
  });

  test('regression (#43): --original naming a pull request that does not exist exits 0 with a warning, every time', () => {
    const world = makeWorld(worked());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--original', '99']);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(
        result.stdout,
        [
          '## Suggestion pull request cleanup complete',
          '',
          'Checked the pull requests that reference #99 in octo/widgets; the suggestion label is `suggestion-pr` (the default suggestion label). Only suggestion pull requests opened by this account are closed.',
          '',
          'No suggestion pull requests were found.',
          '',
          'Closing never deletes a branch: each proposal branch is left in place.',
          '',
        ].join('\n'),
      );
      assert.match(result.stderr, /\[original-pull-request-not-found\]/);
      assert.match(result.stderr, /octo\/widgets has no pull request #99 that this account can read/);
      assert.match(result.stderr, /→ Check the pull request number\./);
      assert.equal(result.stderr.includes('again later'), false, 'no retry is suggested');
    }
    const json = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--original', '99', '--format', 'json']);
    assert.equal(json.status, 0);
    const doc = asRecord(parseJson(json.stdout));
    assert.equal(doc['status'], 'complete');
    assert.deepEqual(doc['originals'], [{ number: 99, state: 'not-found' }]);
    assert.deepEqual(writes(world), []);
  });

  test('--help documents every option and needs no token', () => {
    const world = makeWorld([]);
    const result = cli(world, ['close-suggestion-prs', '--help'], {});
    assert.equal(result.status, 0);
    for (const flag of ['--repo', '--label', '--original', '--owner', '--max-candidates', '--force', '--dry-run', '--format', 'GH_TOKEN']) assert.ok(result.stdout.includes(flag), `help omits ${flag}`);
    assert.match(result.stdout, /never deletes/);
    assert.deepEqual(world.host.log(), []);
  });
});
