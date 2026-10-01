/**
 * Cleanup that requires an abandoned original (`requireAbandonedOriginal`,
 * `--if-abandoned`) through the production composition: the real public
 * library and CLI with the real GitHub client, talking HTTP to the fake
 * GitHub host (test/fixtures/composition). Only `fetch` is replaced.
 *
 * Every expected value is written by hand from
 * docs/suggestion-cleanup-contract.md §2.12 and its acceptance examples
 * (§2.12.1), which these tests follow by number:
 *
 * - the guard reads the exact original before anything is listed, classified
 *   or closed, and the account is not read first;
 * - closed and unmerged: targeted cleanup proceeds, unchanged;
 * - open (reopened), merged or not found: skipped, status
 *   `original-not-abandoned`, exit 0, one note naming the state, nothing
 *   listed or written;
 * - a read that fails: an operational failure, nothing listed or written;
 * - the guard without an original: invalid input before any request.
 *
 * The note's severity, title and remedies come from the documented catalog
 * (docs/diagnostics.md) through test/support/diagnostics.mts.
 *
 * The host models documented GitHub behavior; it is not evidence of live
 * GitHub behavior (see docs/evidence/abandonment-cleanup/README.md).
 *
 * @see https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request
 * @see https://docs.github.com/en/graphql/reference/objects#crossreferencedevent
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  OWNER,
  REPO,
  cleanup,
  cli,
  closes,
  makeWorld,
  markdown,
  original,
  originals,
  pullReads,
  results,
  stateOf,
  suggestion,
  writes,
} from './fixtures/composition/cleanup-world.mts';
import type { IWorld, Json } from './fixtures/composition/cleanup-world.mts';
import type { ICompanionConfig } from './fixtures/composition/fake-http-companion.mts';
import { assertDiagnostics, catalogEntry } from './support/diagnostics.mts';
import { asArray, asRecord, asString, parseJson } from './support/runtime-types.mts';

// ---------------------------------------------------------------------------
// Expected values, written by hand from §2.12

const NOTE = 'original-pull-request-not-abandoned';
const SKIPPED_TITLE = '## Suggestion pull request cleanup skipped: the original is not closed without merging';
const ZERO_COUNTS = { candidates: 0, checked: 0, labeled: 0, conforming: 0 };

/** The note's message for each skipped state (§2.12, "A skip is not a failure"). */
const SKIP_MESSAGES = {
  open: '#37 is open, not closed without merging, so nothing was checked or closed.',
  merged: '#37 was merged, not closed without merging, so nothing was checked or closed.',
  'not-found': 'octo/widgets has no pull request #99 that this account can read, so nothing was checked or closed.',
} as const;

/** A guarded, targeted cleanup of `originalPullNumber` (§2.12). */
function guarded(world: IWorld, originalPullNumber: number, extra: Json = {}): Promise<Json> {
  return cleanup(world, { originalPullNumber, requireAbandonedOriginal: true, ...extra });
}

/** Every request the host received, as `METHOD path`. */
function requests(world: IWorld): string[] {
  return world.host.log().map((r) => `${r.method} ${r.path}`);
}

const ORIGINAL_READ = (n: number): string => `GET /repos/${OWNER}/${REPO}/pulls/${String(n)}`;

/**
 * Asserts the guard's order (§2.12, "Read first, then act"): before the
 * original's read there is only the label resolution's reading of the
 * repository and its configuration file; no listing (GraphQL), no account
 * read, no other pull request and no write. Returns what came after it.
 */
function assertOriginalReadFirst(world: IWorld, n: number): string[] {
  const log = requests(world);
  const at = log.indexOf(ORIGINAL_READ(n));
  assert.ok(at !== -1, `the original #${String(n)} is read: ${JSON.stringify(log)}`);
  const before = log.slice(0, at);
  assert.ok(before.length > 0, 'the label is resolved first, which proves the repository exists (§2.2.1)');
  for (const request of before) {
    assert.ok(request.startsWith(`GET /repos/${OWNER}/${REPO}`), `only repository and configuration reads precede the original: ${request}`);
    assert.equal(/\/pulls(\/|$)/.test(request), false, `no pull request is read before the original: ${request}`);
  }
  return log.slice(at + 1);
}

/** The outcome of a skipped run (§2.12): everything but the Markdown and diagnostics, which tests check separately. */
function assertSkipped(outcome: Json, n: number, state: 'open' | 'merged' | 'not-found', dryRun = false): void {
  assert.equal(outcome['status'], 'original-not-abandoned');
  assert.equal(outcome['dryRun'], dryRun);
  assert.equal(outcome['owner'], 'me');
  assert.deepEqual(outcome['originals'], [{ number: n, state }]);
  assert.deepEqual(outcome['suggestions'], []);
  assert.deepEqual(outcome['counts'], ZERO_COUNTS);
  assert.equal(markdown(outcome), [SKIPPED_TITLE, '', SKIP_MESSAGES[state]].join('\n'));
  assertDiagnostics(outcome['diagnostics'], [{ code: NOTE, subject: `${OWNER}/${REPO}#${String(n)}` }]);
  assert.equal(asRecord(asArray(outcome['diagnostics'])[0])['message'], SKIP_MESSAGES[state]);
}

// ---------------------------------------------------------------------------

describe('the documented note (docs/diagnostics.md)', () => {
  test('original-pull-request-not-abandoned is a note with no remedy: a skip is not a problem', () => {
    const entry = catalogEntry(NOTE);
    assert.equal(entry.severity, 'note');
    assert.equal(entry.title, 'The original pull request is not closed without merging');
    assert.deepEqual(entry.remedies, []);
  });
});

describe('acceptance examples (§2.12.1)', () => {
  test('1. closed and unmerged: the original is read first, then targeted cleanup proceeds unchanged', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    const outcome = await guarded(world, 37);
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(originals(outcome), [[37, 'closed']]);
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
    assert.deepEqual(outcome['diagnostics'], []);
    assert.ok(markdown(outcome).includes('- #37: closed without merging'), markdown(outcome));
    const after = assertOriginalReadFirst(world, 37);
    assert.ok(after.includes('POST /graphql'), 'the backlinks are listed after the original is read');
    assert.deepEqual(pullReads(world), [37, 40], 'the original is read once (no second read), the suggestion again before its close');
    assert.deepEqual(writes(world), closes(40));
    assert.equal(stateOf(world, 40).state, 'closed');
  });

  test('1. (identity) the outcome is the same as targeted cleanup without the guard', async () => {
    const seeds = [original(37, 'closed'), suggestion(40, 37), suggestion(41, 37, { labels: [] })];
    const withGuard = await guarded(makeWorld(seeds), 37);
    const without = await cleanup(makeWorld(seeds), { originalPullNumber: 37 });
    assert.deepEqual(withGuard, without);
  });

  test('2. reopened (open when read): skipped with a note, exit 0; nothing listed, the account not read, nothing written', async () => {
    // A close followed by a reopen leaves the original open; the guard reads only its current state.
    const world = makeWorld([original(37, 'open'), suggestion(40, 37)]);
    const outcome = await guarded(world, 37);
    assertSkipped(outcome, 37, 'open');
    assert.deepEqual(assertOriginalReadFirst(world, 37), [], 'nothing is requested after the original');
    assert.deepEqual(writes(world), []);
    assert.equal(stateOf(world, 40).state, 'open');
  });

  test('2. a draft original counts as open and skips too', async () => {
    const world = makeWorld([{ ...original(37, 'open'), draft: true }, suggestion(40, 37)]);
    assertSkipped(await guarded(world, 37), 37, 'open');
    assert.deepEqual(writes(world), []);
  });

  test('3. merged: skipped, although unguarded targeted cleanup would close its suggestion', async () => {
    const world = makeWorld([original(37, 'merged'), suggestion(40, 37)]);
    const outcome = await guarded(world, 37);
    assertSkipped(outcome, 37, 'merged');
    assert.deepEqual(assertOriginalReadFirst(world, 37), []);
    assert.deepEqual(writes(world), []);
    assert.equal(stateOf(world, 40).state, 'open');

    const unguarded = makeWorld([original(37, 'merged'), suggestion(40, 37)]);
    assert.deepEqual(results(await cleanup(unguarded, { originalPullNumber: 37 })), [[40, 37, 'closed']], 'the control: a merged original ends its suggestions');
  });

  test('4. not found (404): skipped with the note alone, never the not-found warning; nothing listed', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    const outcome = await guarded(world, 99);
    assertSkipped(outcome, 99, 'not-found');
    assert.deepEqual(assertOriginalReadFirst(world, 99), []);
    assert.deepEqual(writes(world), []);
    // The same answer every time: a 404 is definitive (§2.7).
    assert.deepEqual(await guarded(world, 99), outcome);
  });

  const unreadable: readonly (readonly [string, ICompanionConfig, RegExp])[] = [
    ['answers 403', { pullReads: { '37': 'forbidden' } }, /HTTP 403/],
    ['answers 502', { pullReads: { '37': 'server-error' } }, /HTTP 502/],
    ['answers with an unknown state', { pullReads: { '37': 'malformed' } }, /state/],
  ];
  for (const [what, config, reason] of unreadable) {
    test(`5. an original whose read ${what}: an operational failure, nothing listed and nothing closed`, async () => {
      const world = makeWorld([original(37, 'closed'), suggestion(40, 37)], config);
      await assert.rejects(guarded(world, 37), (err: unknown) => {
        assert.ok(err instanceof Error && !(err instanceof TypeError), String(err));
        assert.ok(err.message.startsWith(`Pull request ${OWNER}/${REPO}#37 could not be read (`), err.message);
        assert.match(err.message, reason);
        assert.match(err.message, /nothing was checked or closed\.$/);
        return true;
      });
      assert.deepEqual(assertOriginalReadFirst(world, 37), [], 'nothing is requested after the failed read');
      assert.deepEqual(writes(world), []);
      assert.equal(stateOf(world, 40).state, 'open');
    });
  }

  test('5. (control) without the guard the same failed read is unverified and incomplete, as before', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)], { pullReads: { '37': 'server-error' } });
    const outcome = await cleanup(world, { originalPullNumber: 37 });
    assert.equal(outcome['status'], 'incomplete');
    assert.deepEqual(originals(outcome), [[37, 'unverified']]);
  });

  const invalid: readonly (readonly [string, Json, RegExp])[] = [
    ['the guard without an original', { requireAbandonedOriginal: true }, /requireAbandonedOriginal applies only to targeted cleanup, so it requires originalPullNumber/],
    ['the guard with a label sweep', { requireAbandonedOriginal: true, label: 'suggestion-pr' }, /requires originalPullNumber/],
    ['a guard that is not a boolean', { requireAbandonedOriginal: 'yes', originalPullNumber: 37 }, /requireAbandonedOriginal must be a boolean/],
  ];
  for (const [what, change, pattern] of invalid) {
    test(`6. ${what} is a TypeError before any request`, async () => {
      const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
      await assert.rejects(cleanup(world, change), (err: unknown) => err instanceof TypeError && /^Invalid closeSuggestionPullRequests input: /.test(err.message) && pattern.test(err.message));
      assert.deepEqual(world.host.log(), []);
    });
  }

  test('6. requireAbandonedOriginal: false asks for nothing: accepted, and cleanup is unguarded', async () => {
    const sweep = await cleanup(makeWorld([original(37, 'merged'), suggestion(40, 37)]), { requireAbandonedOriginal: false });
    assert.deepEqual(results(sweep), [[40, 37, 'closed']]);
    const targeted = await cleanup(makeWorld([original(37, 'merged'), suggestion(40, 37)]), { originalPullNumber: 37, requireAbandonedOriginal: false });
    assert.deepEqual(results(targeted), [[40, 37, 'closed']]);
  });

  test('7. a dry run makes the same reads and writes nothing; an open original skips identically', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    const outcome = await guarded(world, 37, { dryRun: true });
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(results(outcome), [[40, 37, 'would-close']]);
    assert.deepEqual(pullReads(world), [37, 40]);
    assert.deepEqual(writes(world), []);

    const open = makeWorld([original(37, 'open'), suggestion(40, 37)]);
    assertSkipped(await guarded(open, 37, { dryRun: true }), 37, 'open', true);
    assert.deepEqual(writes(open), []);
  });

  test('8. a repeat run proceeds again and reports the closed suggestion already-closed; nothing more is written', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    await guarded(world, 37);
    const again = await guarded(world, 37);
    assert.equal(again['status'], 'complete');
    assert.deepEqual(results(again), [[40, 37, 'already-closed']]);
    assert.deepEqual(writes(world), closes(40));
  });
});

describe('what the guard keeps (§2.12)', () => {
  test('every positive identification still applies: unlabeled, other-owner and not-conforming suggestions of an abandoned original stay open', async () => {
    const world = makeWorld([
      original(37, 'closed'),
      suggestion(40, 37),
      suggestion(41, 37, { labels: [] }),
      suggestion(42, 37, { authorId: 99 }),
      suggestion(43, 37, { head: 'feature-elsewhere' }),
    ]);
    const outcome = await guarded(world, 37);
    assert.deepEqual(results(outcome), [[40, 37, 'closed'], [41, 37, 'unlabeled'], [42, 37, 'other-owner'], [43, 37, 'not-conforming']]);
    assert.deepEqual(writes(world), closes(40));
  });

  test('with a label override, the repository is read first, then the original, before any listing', async () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    const outcome = await guarded(world, 37, { label: 'suggestion-pr' });
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
    assert.deepEqual(requests(world).slice(0, 2), [`GET /repos/${OWNER}/${REPO}`, ORIGINAL_READ(37)]);
  });

  test('a guarded skip writes nothing at all: no close, no reopen, no branch change', async () => {
    const world = makeWorld([original(37, 'open'), suggestion(40, 37, { state: 'closed' })]);
    assertSkipped(await guarded(world, 37), 37, 'open');
    assert.deepEqual(writes(world), []);
    assert.equal(stateOf(world, 40).state, 'closed', 'a closed suggestion of a reopened original is not reopened');
  });
});

describe('CLI: --if-abandoned (§2.10, §2.12)', () => {
  const ARGS = ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--original', '37', '--if-abandoned'];

  test('a skip prints the title and "Nothing was checked or closed." on stdout, the note on stderr, and exits 0', () => {
    const world = makeWorld([original(37, 'open'), suggestion(40, 37)]);
    const result = cli(world, ARGS);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, `${SKIPPED_TITLE}\n\nNothing was checked or closed.\n`);
    assert.match(result.stderr, /^ℹ note {2}The original pull request is not closed without merging {2}\[original-pull-request-not-abandoned\]\n {2}octo\/widgets#37\n/);
    assert.ok(result.stderr.includes(SKIP_MESSAGES.open), result.stderr);
    assert.ok(result.stderr.endsWith('\n1 note\n'), result.stderr);
    assert.deepEqual(writes(world), []);
  });

  test('JSON: one document with status original-not-abandoned, the original\'s state and the note', () => {
    const world = makeWorld([original(37, 'merged'), suggestion(40, 37)]);
    const result = cli(world, [...ARGS, '--format', 'json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    const doc = asRecord(parseJson(result.stdout));
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'dryRun', 'owner', 'originals', 'suggestions', 'counts', 'message', 'diagnostics']);
    assert.equal(doc['status'], 'original-not-abandoned');
    assert.deepEqual(doc['originals'], [{ number: 37, state: 'merged' }]);
    assert.deepEqual(doc['suggestions'], []);
    assert.deepEqual(doc['counts'], ZERO_COUNTS);
    assert.equal(doc['message'], [SKIPPED_TITLE, '', SKIP_MESSAGES.merged].join('\n'));
    assertDiagnostics(doc['diagnostics'], [{ code: NOTE, subject: 'octo/widgets#37', message: /^#37 was merged, not closed without merging/ }]);
  });

  test('an original that does not exist: exit 0 with the note, not the not-found warning', () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    const result = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--original', '99', '--if-abandoned']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(SKIP_MESSAGES['not-found']), result.stderr);
    assert.equal(result.stderr.includes('[original-pull-request-not-found]'), false, result.stderr);
  });

  test('closed and unmerged: cleanup proceeds and closes the suggestion (exit 0)', () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
    const result = cli(world, ARGS);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.startsWith('## Suggestion pull request cleanup complete\n'), result.stdout);
    assert.ok(result.stdout.includes('- #37: closed without merging\n'), result.stdout);
    assert.ok(result.stdout.includes('- #40 (for #37): closed\n'), result.stdout);
    assert.deepEqual(writes(world), closes(40));
  });

  test('an original that cannot be read: an operational error (exit 1), nothing closed', () => {
    const world = makeWorld([original(37, 'closed'), suggestion(40, 37)], { pullReads: { '37': 'server-error' } });
    const result = cli(world, ARGS);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, 'Nothing was closed.\n');
    assert.match(result.stderr, /\[operation-failed\]/);
    assert.ok(result.stderr.includes('Pull request octo/widgets#37 could not be read ('), result.stderr);
    assert.deepEqual(writes(world), []);
    const json = cli(world, [...ARGS, '--format', 'json']);
    assert.equal(json.status, 1);
    const doc = asRecord(parseJson(json.stdout));
    assert.equal(doc['status'], 'error');
    assertDiagnostics(doc['diagnostics'], [{ code: 'operation-failed', message: /^Pull request octo\/widgets#37 could not be read \(/ }]);
  });

  const usage: readonly (readonly [string, readonly string[], RegExp])[] = [
    ['--if-abandoned without --original', ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--if-abandoned'], /--if-abandoned requires --original/],
    ['--if-abandoned with a --label sweep', ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--label', 'suggestion-pr', '--if-abandoned'], /--if-abandoned requires --original/],
    ['a value for --if-abandoned', [...ARGS.slice(0, -1), '--if-abandoned=yes'], /--if-abandoned takes no value/],
  ];
  for (const [what, args, pattern] of usage) {
    test(`${what} is a usage error (exit 1) and nothing is requested`, () => {
      const world = makeWorld([original(37, 'closed'), suggestion(40, 37)]);
      const result = cli(world, args);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, pattern);
      assert.match(result.stderr, /sarif-to-comment close-suggestion-prs --help/);
      assert.deepEqual(world.host.log(), []);
    });
  }

  test('--help documents --if-abandoned, the skip status and its exit status, and needs no token', () => {
    const world = makeWorld([]);
    const result = cli(world, ['close-suggestion-prs', '--help'], {});
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('--if-abandoned'), result.stdout);
    assert.match(result.stdout, /\[--if-abandoned\]/, 'the targeted synopsis names the option');
    assert.match(asString(result.stdout), /closed without\s+merging/);
    assert.deepEqual(world.host.log(), []);
  });
});
