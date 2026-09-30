/**
 * The human output of `validate`, `publish` and `close-suggestion-prs`
 * (docs/diagnostics.md, "Streams"; owner decision of September 30, 2026):
 * the diagnostic blocks on stderr are the single human rendering of
 * problems and warnings, and stdout keeps the outcome text (heading, links,
 * state path, next steps) without repeating them. JSON, TOON and the
 * library's `markdown` are unchanged: they remain the full report.
 *
 * Every expected stdout and stderr below is written by hand from the
 * documented wording of each report and the diagnostic catalog.
 *
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { FakeHttpGitHub } from './fixtures/composition/fake-http-github.mts';
import type { IHttpRepository } from './fixtures/composition/fake-http-github.mts';
import type { ICompanionConfig, IStoredPull } from './fixtures/composition/fake-http-companion.mts';
import { FakeGitHubRemote } from './fixtures/publication/fake-github.mts';
import { REPOSITORY } from './fixtures/public-api/fake-adapter.mts';
import { asArray, asRecord, asString, parseJson, readJson } from './support/runtime-types.mts';

const PUBLIC_API = path.join(import.meta.dirname, 'fixtures', 'public-api');
const WRAPPER = path.join(PUBLIC_API, 'cli-with-fake-github.mts');
const HTTP_CLI = path.join(import.meta.dirname, 'fixtures', 'composition', 'cli-with-fake-http.mts');
const TOKEN = 'ghp_HUMAN_REPORTS_token_97531';
const HEAD = REPOSITORY.commits.head;
const READY = asRecord(readJson(path.join(PUBLIC_API, 'ready.sarif.json')));
const HELD = asRecord(readJson(path.join(PUBLIC_API, 'held.sarif.json')));

/** READY with a taxonomy classification on its second result: a taxa-uninterpreted warning. */
const WARNED = (() => {
  const copy = structuredClone(READY);
  asRecord(asArray(asRecord(asArray(copy['runs'])[0])['results'])[1])['taxa'] = [{ id: 'CWE-20' }];
  return copy;
})();

interface IRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface IWorld {
  readonly root: string;
  readonly remote: FakeGitHubRemote;
}

function world(): IWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'human-reports-')));
  return { root, remote: FakeGitHubRemote.create(path.join(root, 'remote')) };
}

/** Runs `command` on `sarif` against the pull request of the fake host, in human form. */
function run(w: IWorld, command: 'validate' | 'publish', sarif: object, extra: readonly string[] = []): IRun {
  const file = path.join(w.root, 'review.sarif.json');
  fs.writeFileSync(file, JSON.stringify(sarif));
  const state = command === 'publish' ? ['--state', path.join(w.root, 'state.json')] : [];
  const result = spawnSync(process.execPath, [WRAPPER, command, '--sarif', file, '--repo', 'acme/gizmos', '--pull', '7', '--commit', HEAD, ...state, ...extra], {
    encoding: 'utf8', timeout: 30_000, env: { PATH: process.env['PATH'], FAKE_GITHUB_DIR: w.remote.dir, GH_TOKEN: TOKEN },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const NOTHING_WRITTEN = 'Nothing was published and no publication state was written.';
const PREPARED = `**Review prepared:** 1 inline comment(s) and 1 general section(s) for commit \`${HEAD}\`.`;

const READY_STDOUT = [
  '## Ready to publish',
  '',
  `The complete document can be published faithfully to acme/gizmos#7 at commit \`${HEAD}\`.`,
  '',
  PREPARED,
  '',
  NOTHING_WRITTEN,
  '',
  'No pending review of this account was found on the pull request. This is not an approval: publication repeats every check against the pull request as it is then. GitHub can still refuse the review, for example if this account starts a pending review on the pull request before publication.',
  '',
].join('\n');

/**
 * READY_STDOUT for WARNED: the headline under the heading states the warning's
 * count and nature, by its catalog title (issue #37, "Warnings must never be
 * mysterious"); the warning itself is on stderr only.
 */
const WARNED_READY_STDOUT = READY_STDOUT.replace(
  '## Ready to publish\n\n',
  '## Ready to publish\n\n**Ready to publish with 1 warning:** Taxonomy classifications are not shown.\n\n',
);

const BLOCKED_STDOUT = ['## Review blocked', '', `${NOTHING_WRITTEN} 1 problem must be resolved before publication.`, ''].join('\n');

const HOLD_STDERR = [
  '✖ error  The review is held for approval  [approval-hold]',
  '  /runs/0/results/0',
  '  Awaiting approval: the whole review is held. Resolve the hold or use the explicit override.',
  '  → Resolve the hold in the SARIF.',
  '  → Or publish deliberately despite it with `--ignore-approval-hold` (`ignoreApprovalHold`).',
  '',
  '1 error',
  '',
].join('\n');

const TAXA_STDERR = [
  '▲ warning  Taxonomy classifications are not shown  [taxa-uninterpreted]',
  '  /runs/0/results/1',
  '  Taxonomy classifications are retained in evidence but not rendered in the review.',
  '',
  '1 warning',
  '',
].join('\n');

describe('validate: stdout is the outcome, stderr the diagnostics', () => {
  test('ready without warnings: the report on stdout, nothing on stderr (exit 0)', () => {
    const result = run(world(), 'validate', READY);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, READY_STDOUT);
    assert.equal(result.stderr, '');
  });

  test('ready with a warning: the same report with its headline and without a warnings list; the warning on stderr (exit 0)', () => {
    const result = run(world(), 'validate', WARNED);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, WARNED_READY_STDOUT);
    assert.equal(result.stderr, TAXA_STDERR);
  });

  test('blocked: the heading and the count on stdout, the problem only on stderr (exit 2)', () => {
    const result = run(world(), 'validate', HELD);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, BLOCKED_STDOUT);
    assert.equal(result.stderr, HOLD_STDERR);
  });

  test('JSON keeps the full Markdown report in message', () => {
    const w = world();
    const doc = asRecord(parseJson(run(w, 'validate', WARNED, ['--format', 'json']).stdout));
    assert.match(asString(doc['message']), /\*\*Warnings:\*\*\n\n- `taxa-uninterpreted` at `\/runs\/0\/results\/1`/);
  });
});

describe('publish: stdout is the outcome, stderr the diagnostics', () => {
  /** The published report; `headline` is the line a warning adds under the heading (issue #37). */
  function published(w: IWorld, headline?: string): string {
    const review = w.remote.reviews()[0];
    assert.ok(review !== undefined, 'a review was created');
    return [
      '## Draft review published',
      '',
      ...(headline === undefined ? [] : [headline, '']),
      `Created the draft [review ${String(review.id)}](${review.htmlUrl}) on acme/gizmos#7 at commit \`${HEAD}\`. It stays a draft until someone submits it on GitHub.`,
      '',
    ].join('\n');
  }

  test('published without warnings: the link on stdout, nothing on stderr (exit 0)', () => {
    const w = world();
    const result = run(w, 'publish', READY);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, published(w));
    assert.equal(result.stderr, '');
  });

  test('published with a warning: the same outcome text with its headline, the warning only on stderr (exit 0)', () => {
    const w = world();
    const result = run(w, 'publish', WARNED);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, published(w, '**Published with 1 warning:** Taxonomy classifications are not shown.'));
    assert.equal(result.stderr, TAXA_STDERR);
  });

  test('blocked: the heading and the count on stdout, the problem only on stderr (exit 2)', () => {
    const result = run(world(), 'publish', HELD);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, BLOCKED_STDOUT);
    assert.equal(result.stderr, HOLD_STDERR);
  });

  test('JSON keeps the full Markdown report in message', () => {
    const doc = asRecord(parseJson(run(world(), 'publish', WARNED, ['--format', 'json']).stdout));
    assert.match(asString(doc['message']), /\*\*Warnings:\*\*/);
  });
});

describe('close-suggestion-prs: stdout lists what was done, stderr what was not', () => {
  const OWNER = 'octo';
  const REPO = 'widgets';
  const BASE = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e';
  const TIP = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
  const idOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const marker = (n: number): string =>
    `<!-- suggestion-pr {"version":1,"original":{"owner":"${OWNER}","repo":"${REPO}","pullNumber":37},"reviewedCommit":"${TIP}","id":"${idOf(n)}","batch":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"} -->`;
  const suggestion = (n: number, body = `Suggested.\n\n${marker(n)}`): IStoredPull => ({
    number: n, title: 'Suggestion', body, head: `suggestion-pr/37/${idOf(n)}`, base: 'feature-37', draft: true, state: 'open', merged: false, labels: ['suggestion-pr'], authorId: 4242,
  });
  const ORIGINAL: IStoredPull = { number: 37, title: 'Original', body: 'Work.', head: 'feature-37', base: 'main', draft: false, state: 'closed', merged: true, labels: [], authorId: 1 };

  function cleanup(pulls: readonly IStoredPull[], companion: ICompanionConfig = {}): IRun {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'human-cleanup-')));
    const repository: IHttpRepository = {
      destination: { owner: OWNER, repo: REPO, pullNumber: 7 },
      commits: { base: BASE, head: TIP },
      snapshots: { [BASE]: { 'README.md': ['# Widgets\n'] }, [TIP]: { 'README.md': ['# Widgets\n'] } },
      pullFiles: [],
      labels: ['suggestion-pr'],
    };
    FakeHttpGitHub.create(path.join(root, 'host'), { companion }, repository);
    new FakeHttpGitHub(path.join(root, 'host'), TOKEN).seedPulls(pulls);
    const result = spawnSync(process.execPath, [HTTP_CLI, 'close-suggestion-prs', '--repo', `${OWNER}/${REPO}`], {
      encoding: 'utf8', timeout: 30_000, env: { PATH: process.env['PATH'], GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: path.join(root, 'host') },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  const SCOPE = 'Checked the open pull requests labeled `suggestion-pr` in octo/widgets (the default suggestion label).';
  const BRANCHES = 'Closing never deletes a branch: each proposal branch is left in place.';

  test('complete: the whole report on stdout, nothing on stderr (exit 0)', () => {
    const result = cleanup([ORIGINAL, suggestion(40)]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, [
      '## Suggestion pull request cleanup complete', '', SCOPE, '',
      'Original pull requests:', '', '- #37: merged', '',
      'Suggestion pull requests:', '', '- #40 (for #37): closed', '',
      BRANCHES, '',
    ].join('\n'));
    assert.equal(result.stderr, '');
  });

  test('permission-limited: the refused close and the non-conforming pull request are only on stderr (exit 2)', () => {
    const result = cleanup([ORIGINAL, suggestion(40), suggestion(41), suggestion(42, 'No marker.')], { closes: { '41': 'forbidden' } });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, [
      '## Suggestion pull request cleanup limited by permissions', '', SCOPE, '',
      'Original pull requests:', '', '- #37: merged', '',
      'Suggestion pull requests:', '', '- #40 (for #37): closed', '',
      'Someone allowed to close the pull requests left open can finish, for example by running this cleanup with their own token.', '',
      BRANCHES, '',
    ].join('\n'));
    assert.match(result.stderr, /^▲ warning {2}GitHub did not allow this account to close a suggestion pull request {2}\[suggestion-pr-close-not-permitted\]\n {2}octo\/widgets#41\n/);
    assert.match(result.stderr, /\n\nℹ note {2}A pull request does not follow the suggestion pull request convention {2}\[suggestion-pr-not-conforming\]\n {2}octo\/widgets#42\n/);
    assert.ok(result.stderr.endsWith('\n1 warning, 1 note\n'), result.stderr);
  });
});
