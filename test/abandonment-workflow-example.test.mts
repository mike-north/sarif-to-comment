/**
 * The example abandonment-cleanup workflow
 * (docs/examples/abandonment-cleanup.workflow.yml) and the page that explains
 * it (docs/examples/abandonment-cleanup.md), checked against the cleanup
 * contract's §2.12 and the owner's D54. The workflow is documentation only:
 * it is never installed in this repository, and these tests never run it.
 *
 * What is checked, by hand from those sources:
 *
 * - it parses as YAML, and lives where GitHub never runs a workflow;
 * - it triggers only on `pull_request` `closed`, never `pull_request_target`;
 * - its job runs only when the event says the pull request was not merged;
 * - it waits two minutes (`sleep 120`) before cleanup, and the tool's own
 *   fresh read decides afterwards (`--if-abandoned`);
 * - its permissions are the narrow ones cleanup needs (they scope the
 *   workflow's own token, should a caller switch to it), and its credential
 *   is the supported one: a personal access token from a repository secret
 *   (`GH_TOKEN: ${{ secrets.SARIF_TO_COMMENT_TOKEN }}`), never the
 *   workflow's own token, whose support is not yet established;
 * - it checks out no code, interpolates only the repository and the pull
 *   request number into its script, and pins an exact package version;
 * - the command it runs exists, with every option it uses, in the built
 *   CLI's help;
 * - the explanatory page covers the security trade-offs of `pull_request`
 *   and `pull_request_target`, forks, repeat runs, the fresh read and the
 *   accepted manual reopening of companions.
 *
 * `actionlint` is used when it is on the PATH; otherwise the parse and the
 * key assertions stand alone.
 *
 * @see https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
 * @see https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request
 * @see https://docs.github.com/en/actions/reference/security/secure-use
 * @see https://yaml.org/spec/1.2.2/
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { parse } from 'yaml';

import { asArray, asRecord, asString } from './support/runtime-types.mts';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'docs', 'examples', 'abandonment-cleanup.workflow.yml');
const PAGE_PATH = path.join(ROOT, 'docs', 'examples', 'abandonment-cleanup.md');
const BIN = path.join(ROOT, 'dist', 'sarif-to-comment.cjs');

/** The first release that has `--if-abandoned` (contract §2.12; the pending 0.3.0 release). */
const FIRST_RELEASE_WITH_GUARD = [0, 3, 0] as const;

/** The only GitHub expressions the cleanup script may interpolate: values that cannot carry shell syntax. */
const SAFE_EXPRESSIONS: ReadonlySet<string> = new Set(['github.repository', 'github.event.pull_request.number']);

const TEXT = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const WORKFLOW = asRecord(parse(TEXT, { strict: true, uniqueKeys: true }), 'the example workflow');
const JOBS = Object.entries(asRecord(WORKFLOW['jobs'], 'jobs'));
const [, JOB] = JOBS[0] ?? ['', {}];
const STEPS = asArray(asRecord(JOB, 'the job')['steps'], 'steps').map((s) => asRecord(s, 'a step'));

/** The step whose script runs cleanup. */
function cleanupStep(): Record<string, unknown> {
  const found = STEPS.filter((s) => typeof s['run'] === 'string' && s['run'].includes('close-suggestion-prs'));
  assert.equal(found.length, 1, 'exactly one step runs cleanup');
  return found[0] ?? {};
}

/** The cleanup script's words, with each `${{ … }}` expression kept as one word. */
function words(script: string): string[] {
  const expressions: string[] = [];
  const masked = script.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expression: string) => {
    expressions.push(expression);
    return `\u0000${String(expressions.length - 1)}\u0000`;
  });
  return masked
    .replace(/\\\n/g, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')
    .map((w) => w.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `\${{ ${expressions[Number(i)] ?? ''} }}`));
}

describe('the example workflow file', () => {
  test('parses as YAML and lives where GitHub never runs it, with no installed copy in this repository', () => {
    assert.equal(path.relative(ROOT, WORKFLOW_PATH).split(path.sep).includes('.github'), false);
    assert.match(path.basename(WORKFLOW_PATH), /\.workflow\.yml$/, 'named so it reads as an example, not an active workflow');
    assert.match(TEXT, /^# EXAMPLE ONLY/m, 'its header says it is an example');
    const installed = fs.readdirSync(path.join(ROOT, '.github', 'workflows'));
    for (const name of installed) {
      assert.equal(fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8').includes('--if-abandoned'), false, `${name} is not an installed copy`);
    }
  });

  test('triggers only on a pull request being closed, never on pull_request_target', () => {
    const on = asRecord(WORKFLOW['on'], 'on');
    assert.deepEqual(Object.keys(on), ['pull_request']);
    assert.deepEqual(asRecord(on['pull_request'])['types'], ['closed']);
    assert.equal(TEXT.includes('pull_request_target:'), false);
  });

  test('has one job, which runs only when the event says the pull request was not merged', () => {
    assert.equal(JOBS.length, 1);
    assert.equal(asRecord(JOB)['if'], 'github.event.pull_request.merged == false');
  });

  test('cancels an earlier waiting run for the same pull request, so a quick close, reopen and close checks once', () => {
    const concurrency = asRecord(asRecord(JOB)['concurrency'] ?? WORKFLOW['concurrency'], 'concurrency');
    assert.match(asString(concurrency['group']), /\$\{\{ github\.event\.pull_request\.number \}\}/);
    assert.equal(concurrency['cancel-in-progress'], true);
  });

  test('grants only the permissions cleanup needs: closing pull requests, and reading contents and issues', () => {
    assert.deepEqual(WORKFLOW['permissions'], { 'pull-requests': 'write', contents: 'read', issues: 'read' });
    assert.equal(Object.hasOwn(asRecord(JOB), 'permissions'), false, 'the job does not widen them');
  });

  test('waits two minutes, then runs cleanup with a personal access token from a repository secret', () => {
    const sleeps = STEPS.findIndex((s) => typeof s['run'] === 'string' && /^sleep 120$/m.test(s['run']));
    const step = cleanupStep();
    assert.ok(sleeps !== -1, 'a step sleeps 120 seconds');
    assert.ok(sleeps < STEPS.indexOf(step), 'the wait comes before cleanup');
    assert.deepEqual(step['env'], { GH_TOKEN: '${{ secrets.SARIF_TO_COMMENT_TOKEN }}' });
  });

  test('offers the workflow\'s own token only as a commented alternative, never as the credential in use', () => {
    const credentials = STEPS.flatMap((s) => Object.values(asRecord(s['env'] ?? {})));
    assert.equal(credentials.some((value) => String(value).includes('github.token')), false);
    assert.match(TEXT, /^ *# Alternative, not yet established: GH_TOKEN: \$\{\{ github\.token \}\}/m);
  });

  test('checks out no code: nothing from the pull request\'s branch is run', () => {
    for (const s of STEPS) {
      assert.equal(typeof s['uses'] === 'string' && s['uses'].startsWith('actions/checkout'), false, 'no checkout');
    }
    const uses = STEPS.map((s) => s['uses']).filter((u): u is string => typeof u === 'string');
    for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/, `${action} is pinned to a full commit`);
  });

  test('runs exactly the guarded, targeted cleanup of the closed pull request, interpolating nothing else', () => {
    const script = asString(cleanupStep()['run']);
    for (const [, expression] of script.matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)) {
      assert.ok(SAFE_EXPRESSIONS.has(expression ?? ''), `the script interpolates only safe values, not ${String(expression)}`);
    }
    const w = words(script);
    const at = w.indexOf('close-suggestion-prs');
    assert.ok(at > 0, w.join(' '));
    assert.deepEqual(w.slice(0, at - 1), ['npx', '--yes']);
    const pinned = /^sarif-to-comment@(\d+)\.(\d+)\.(\d+)$/.exec(w[at - 1] ?? '');
    assert.ok(pinned, `an exact version is pinned: ${String(w[at - 1])}`);
    const version = pinned.slice(1).map(Number);
    const [major = 0, minor = 0, patch = 0] = version;
    const [gMajor, gMinor, gPatch] = FIRST_RELEASE_WITH_GUARD;
    assert.ok(major > gMajor || (major === gMajor && (minor > gMinor || (minor === gMinor && patch >= gPatch))), `the pinned version has --if-abandoned: ${version.join('.')}`);
    assert.deepEqual(w.slice(at + 1), [
      '--repo', '${{ github.repository }}',
      '--original', '${{ github.event.pull_request.number }}',
      '--if-abandoned',
      '--owner', 'all',
    ]);
  });

  test('the command it runs, and every option it uses, are in the built CLI\'s help', () => {
    const run = (args: readonly string[]): string => {
      const result = spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env['PATH'] } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    assert.match(run(['--help']), /^ {2}close-suggestion-prs /m);
    const help = run(['close-suggestion-prs', '--help']);
    const w = words(asString(cleanupStep()['run']));
    for (const option of w.filter((x) => x.startsWith('--') && !x.startsWith('--yes'))) {
      assert.match(help, new RegExp(`^ {2}${option}\\b`, 'm'), `the help documents ${option}`);
    }
    assert.match(help, /--owner me\|all/);
  });

  const actionlint = spawnSync('actionlint', ['-version'], { encoding: 'utf8' });
  test('actionlint accepts it', { skip: actionlint.status === 0 ? false : 'actionlint is not on the PATH' }, () => {
    const result = spawnSync('actionlint', ['-no-color', WORKFLOW_PATH], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

describe('the page that explains the example', () => {
  const page = fs.readFileSync(PAGE_PATH, 'utf8');

  test('links the workflow file and the cleanup contract', () => {
    assert.ok(page.includes('(abandonment-cleanup.workflow.yml)'), 'links the workflow');
    assert.ok(page.includes('suggestion-cleanup-contract.md#212-requiring-an-abandoned-original-requireabandonedoriginal---if-abandoned'), 'links §2.12');
  });

  const topics: readonly (readonly [string, RegExp])[] = [
    ['that the grace period is the workflow\'s, not the tool\'s', /grace period belongs to the workflow/i],
    ['that the fresh check is the tool\'s own read of the original', /the tool's own read/i],
    ['pull_request against pull_request_target', /`pull_request_target`/],
    ['code from the pull request\'s branch', /pull request's branch/i],
    ['the token on forks', /fork/i],
    ['that forks are unsupported anyway', /forks are not supported/i],
    ['repeat runs', /repeat runs/i],
    ['the accepted trade-off of reopening companions by hand', /reopen[^.]*by hand/i],
    ['that it is never installed or run here', /never installed/i],
    ['why it uses --owner all', /`--owner all`/],
    ['the supported credential, a personal access token in a secret', /`SARIF_TO_COMMENT_TOKEN`/],
    ['that the workflow\'s own token is an alternative not yet established', /`github\.token`[^\n]*not yet established/],
    ['that the permissions still matter with the workflow\'s own token', /permissions[^\n]*still matter/i],
    ['that the pinned release resolves only once 0.3.0 is published', /resolves only once 0\.3\.0 is published/],
  ];
  for (const [what, pattern] of topics) {
    test(`explains ${what}`, () => {
      assert.match(page, pattern);
    });
  }
});
