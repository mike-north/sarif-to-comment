/**
 * User acceptance of suggestion pull request cleanup through the *installed*
 * package (the tarball `npm pack` produces, installed into a clean consumer by
 * test/fixtures/package/installed-package.mts). Only public surfaces are
 * used: the linked `sarif-to-comment` executable and
 * `import … from 'sarif-to-comment'`, against a fake GitHub that speaks HTTP
 * to the product's real client (the preload replaces only `fetch`).
 *
 * The repository holds the worked example of
 * docs/suggestion-cleanup-contract.md §3: an open original with two
 * suggestions and a closed original with one. Expected results are written by
 * hand from that contract, including the owner scope, the early exit of a label
 * sweep before the candidate limit, and options that would change nothing
 * refused as usage errors (§2.2, §2.4.1, §2.4.2).
 *
 * @see https://docs.github.com/en/graphql/reference/objects#ref
 * @see https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { FakeHttpGitHub } from './fixtures/composition/fake-http-github.mts';
import type { IHttpRepository } from './fixtures/composition/fake-http-github.mts';
import type { IStoredPull } from './fixtures/composition/fake-http-companion.mts';
import { ROOT, installIntoConsumer, packProject } from './fixtures/package/installed-package.mts';
import { asArray, asRecord, parseJson } from './support/runtime-types.mts';

const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'docs', 'fake-fetch-preload.mts');
const TOKEN = 'ghp_CLEANUP_installed_0123456789';
const OWNER = 'octo';
const REPO = 'cleanup-uat';
const HEAD = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
const BATCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** The repository's own canonical label, set on its default branch (docs/suggestion-pr-convention.md §4). */
const LABEL = 'uat-suggestion';

const idOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function suggestion(n: number, original: number, authorId = 4242): IStoredPull {
  const marker = `<!-- suggestion-pr {"version":1,"original":{"owner":"${OWNER}","repo":"${REPO}","pullNumber":${String(original)}},"reviewedCommit":"${HEAD}","id":"${idOf(n)}","batch":"${BATCH}"} -->`;
  return {
    number: n, title: `Suggestion for #${String(original)}`, body: `Suggested in a review of #${String(original)} at commit ${HEAD}.\n\n${marker}`,
    head: `suggestion-pr/${String(original)}/${idOf(n)}`, base: `feature-${String(original)}`,
    draft: true, state: 'open', merged: false, labels: [LABEL], authorId,
  };
}

/** An ordinary pull request labeled `bug`: no marker, not on a suggestion branch. */
function ordinary(number: number): IStoredPull {
  return { number, title: `Fix ${String(number)}`, body: 'Fixes a bug.', head: `fix/${String(number)}`, base: 'main', draft: false, state: 'open', merged: false, labels: ['bug'], authorId: 99 };
}

function original(number: number, state: 'open' | 'closed'): IStoredPull {
  return { number, title: `Original ${String(number)}`, body: '', head: `feature-${String(number)}`, base: 'main', draft: false, state, merged: false, labels: [], authorId: 1 };
}

interface IWorld {
  readonly host: FakeHttpGitHub;
  readonly env: NodeJS.ProcessEnv;
}

function world(label: string, extra: readonly IStoredPull[] = []): IWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const repository: IHttpRepository = {
    destination: { owner: OWNER, repo: REPO, pullNumber: 1 },
    commits: { base: HEAD, head: HEAD },
    snapshots: { [HEAD]: { 'README.md': ['# Cleanup\n'], '.github/suggestion-prs.json': [`{ "label": "${LABEL}" }\n`] } },
    pullFiles: [],
    labels: [LABEL],
  };
  const hostDir = path.join(root, 'host');
  FakeHttpGitHub.create(hostDir, {}, repository);
  const host = new FakeHttpGitHub(hostDir, TOKEN);
  host.seedPulls([original(36, 'open'), original(37, 'closed'), suggestion(38, 36), suggestion(39, 36), suggestion(40, 37), ...extra]);
  return { host, env: { PATH: process.env['PATH'], GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: hostDir, NODE_OPTIONS: `--require=${PRELOAD}` } };
}

const states = (w: IWorld): Record<string, string> => Object.fromEntries(w.host.pulls().map((p) => [String(p.number), p.state]));
const OPEN_ALL = { '36': 'open', '37': 'closed', '38': 'open', '39': 'open', '40': 'open' };

describe('the installed package closes suggestion pull requests whose original ended', () => {
  const skip = packProject().error || false;

  test('CLI: a dry run, then cleanup, then an idempotent rerun and a targeted check', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const w = world('installed-cleanup-cli');
    const cli = (args: readonly string[], expectedExit = 0): Record<string, unknown> => {
      const result: SpawnSyncReturns<string> = spawnSync(bin, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, ...args, '--format', 'json'], {
        cwd: consumer, env: w.env, encoding: 'utf8', timeout: 120_000,
      });
      for (const text of [result.stdout, result.stderr]) assert.ok(!text.includes(TOKEN), 'the token never appears');
      assert.equal(result.status, expectedExit, result.stdout + result.stderr);
      return asRecord(parseJson(result.stdout));
    };
    const suggestionsOf = (doc: Record<string, unknown>): unknown => doc['suggestions'];
    const url = (n: number): string => `https://github.com/${OWNER}/${REPO}/pull/${String(n)}`;

    const dry = cli(['--dry-run']);
    assert.equal(dry['status'], 'complete');
    assert.deepEqual(suggestionsOf(dry), [
      { number: 38, url: url(38), original: 36, result: 'left-open' },
      { number: 39, url: url(39), original: 36, result: 'left-open' },
      { number: 40, url: url(40), original: 37, result: 'would-close' },
    ]);
    assert.deepEqual(states(w), OPEN_ALL);

    const real = cli([]);
    assert.deepEqual(real['originals'], [{ number: 36, state: 'open' }, { number: 37, state: 'closed' }]);
    assert.deepEqual(suggestionsOf(real), [
      { number: 38, url: url(38), original: 36, result: 'left-open' },
      { number: 39, url: url(39), original: 36, result: 'left-open' },
      { number: 40, url: url(40), original: 37, result: 'closed' },
    ]);
    assert.deepEqual(states(w), { ...OPEN_ALL, '40': 'closed' });

    const again = cli([]);
    assert.equal(again['status'], 'complete');
    assert.deepEqual(suggestionsOf(again), [
      { number: 38, url: url(38), original: 36, result: 'left-open' },
      { number: 39, url: url(39), original: 36, result: 'left-open' },
    ]);
    const targeted = cli(['--original', '37']);
    assert.deepEqual(suggestionsOf(targeted), [{ number: 40, url: url(40), original: 37, result: 'already-closed' }]);
    assert.equal(w.host.log().filter((r) => r.method === 'PATCH').length, 1, 'one close in all four runs');
    assert.ok(w.host.log().every((r) => r.authorized));
  });

  test('CLI: only this account\'s suggestions by default, all with --owner all; a wrong label stopped after one request', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const ordinaries = Array.from({ length: 25 }, (_, i) => ordinary(100 + i));
    const w = world('installed-cleanup-scope', [suggestion(41, 37, 99), ...ordinaries]);
    const cli = (args: readonly string[], expectedExit: number): Record<string, unknown> => {
      const result: SpawnSyncReturns<string> = spawnSync(bin, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, ...args, '--format', 'json'], {
        cwd: consumer, env: w.env, encoding: 'utf8', timeout: 120_000,
      });
      for (const text of [result.stdout, result.stderr]) assert.ok(!text.includes(TOKEN), 'the token never appears');
      assert.equal(result.status, expectedExit, result.stdout + result.stderr);
      return asRecord(parseJson(result.stdout));
    };
    const resultsOf = (doc: Record<string, unknown>): unknown[] => asArray(doc['suggestions']).map((s) => [asRecord(s)['number'], asRecord(s)['result']]);

    const mine = cli(['--dry-run'], 0);
    assert.equal(mine['owner'], 'me');
    assert.deepEqual(resultsOf(mine), [[38, 'left-open'], [39, 'left-open'], [40, 'would-close'], [41, 'other-owner']]);
    assert.deepEqual(mine['counts'], { candidates: 4, checked: 4, labeled: 4, conforming: 4 });
    const all = cli(['--dry-run', '--owner', 'all'], 0);
    assert.deepEqual(resultsOf(all), [[38, 'left-open'], [39, 'left-open'], [40, 'would-close'], [41, 'would-close']]);

    const before = w.host.log().length;
    const wrong = cli(['--label', 'bug'], 2);
    assert.equal(wrong['status'], 'label-not-suggestion-prs');
    assert.deepEqual(asArray(wrong['diagnostics']).map((d) => asRecord(d)['code']), ['label-not-suggestion-prs']);
    assert.equal(w.host.log().length - before, 1, 'one request before the refusal');
    const lowered = w.host.log().length;
    const stillWrong = cli(['--label', 'bug', '--max-candidates', '10'], 2);
    assert.equal(stillWrong['status'], 'label-not-suggestion-prs', 'the early exit is decided before the limit');
    assert.equal(w.host.log().length - lowered, 1, 'one request before the refusal');
    const capped = cli(['--label', 'bug', '--force', '--max-candidates', '10'], 1);
    assert.equal(capped['status'], 'too-many-candidates', '--force bypasses only the early exit');
    assert.deepEqual(capped['counts'], { candidates: 25, checked: 0, labeled: 0, conforming: 0 });
    const misuse = w.host.log().length;
    const ignored = cli(['--force'], 1);
    assert.equal(ignored['status'], 'usage-error');
    assert.equal(ignored['message'], '--force requires --label (only a --label sweep stops early)');
    assert.equal(w.host.log().length, misuse, 'a usage error makes no request');
    assert.deepEqual(states(w), { ...OPEN_ALL, '41': 'open', ...Object.fromEntries(ordinaries.map((p) => [String(p.number), 'open'])) }, 'nothing was closed');
  });

  test('library: the same cleanup in memory through the installed function', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const w = world('installed-cleanup-library');
    const js = String.raw;
    const script = js`
      import assert from 'node:assert/strict';
      import { closeSuggestionPullRequests } from 'sarif-to-comment';
      const input = { repository: { owner: 'octo', repo: 'cleanup-uat' }, token: process.env.GH_TOKEN };
      const dry = await closeSuggestionPullRequests({ ...input, dryRun: true });
      assert.equal(dry.status, 'complete', dry.markdown);
      assert.deepEqual(dry.suggestions.map((s) => [s.number, s.result]), [[38, 'left-open'], [39, 'left-open'], [40, 'would-close']]);
      const outcome = await closeSuggestionPullRequests(input);
      assert.equal(outcome.status, 'complete', outcome.markdown);
      assert.deepEqual(outcome.suggestions.map((s) => [s.number, s.result]), [[38, 'left-open'], [39, 'left-open'], [40, 'closed']]);
      assert.match(outcome.markdown, /Closing never deletes a branch/);
      assert.match(outcome.markdown, /the suggestion label is \x60uat-suggestion\x60 \(the suggestion label set in \x60\.github\/suggestion-prs\.json\x60 on \x60main\x60\)/);
      assert.equal(outcome.owner, 'me');
      assert.deepEqual(outcome.counts, { candidates: 3, checked: 3, labeled: 3, conforming: 3 });
      await assert.rejects(closeSuggestionPullRequests({ ...input, label: 'a,b' }), TypeError);
      await assert.rejects(closeSuggestionPullRequests({ ...input, force: true }), /force applies only to a label sweep, so it requires label/);
      await assert.rejects(closeSuggestionPullRequests({ ...input, originalPullNumber: 37, maxCandidates: 10 }), TypeError);
      process.stdout.write(JSON.stringify({ status: outcome.status }));
    `;
    const file = path.join(consumer, 'cleanup-library.mjs');
    fs.writeFileSync(file, script);
    const result = spawnSync(process.execPath, [file], { cwd: consumer, env: w.env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN));
    assert.deepEqual(states(w), { ...OPEN_ALL, '40': 'closed' });
  });
});
