/**
 * User acceptance of companion suggestion pull requests through the
 * *installed* package (the tarball `npm pack` produces, installed into a clean
 * consumer by test/fixtures/package/installed-package.mts). Only public
 * surfaces are used: the linked `sarif-to-comment` executable and
 * `import … from 'sarif-to-comment'`.
 *
 * A real local Git repository stages a code edit and a new test file. The
 * reviewer comments on both, adds the staged changes as SARIF, and then, as
 * an agent would, inspects the document, picks the findings that carry a
 * change and groups them for joint acceptance with `group-fixes` /
 * `groupSarifFixes` (docs/companion-suggestion-pr-contract.md §2.3, §2.12),
 * never by editing SARIF by hand. It publishes with suggestion pull requests
 * enabled against a fake
 * GitHub that speaks HTTP to the product's real client (the preload replaces
 * only `fetch`). Without the setting the same document is refused, naming it.
 * The repository names its own canonical label in `.github/suggestion-prs.json`
 * on its default branch (docs/suggestion-pr-convention.md §4); the CLI adds an
 * extra label and asks for a ready pull request, the library keeps the draft
 * default.
 *
 * Expected bytes, titles, labels and bodies are written by hand from the
 * contract and the convention.
 *
 * @see https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request
 * @see https://docs.github.com/en/rest/git/trees#create-a-tree
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
import { ROOT, installIntoConsumer, packProject } from './fixtures/package/installed-package.mts';
import { asArray, asRecord, asString, parseJson, readJson } from './support/runtime-types.mts';

const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'docs', 'fake-fetch-preload.mts');
const TOKEN = 'ghp_COMPANION_installed_0123456789';
const DESTINATION = { owner: 'octo', repo: 'companion-uat', pullNumber: 45 } as const;
const HEAD_REF = 'feature/retry';

const CLIENT = 'export async function fetchWidget(id: string) {\n  const response = await request(id);\n  return response.body;\n}\n';
const EDITED = 'export async function fetchWidget(id: string) {\n  const response = await request(id).catch(() => request(id));\n  return response.body;\n}\n';
const TEST_FILE = "import { fetchWidget } from '../src/client';\n\ntest('retries once', async () => {\n  await fetchWidget('w1');\n});\n";
const RETRY_MESSAGE = 'Retry once on timeout.';
const CONFIG_PATH = '.github/suggestion-prs.json';
const CONFIG = '{ "label": "uat-suggestion" }\n';
const COVER_MESSAGE = 'Cover the retry.';

interface IWorld {
  readonly root: string;
  readonly dir: string;
  readonly head: string;
  readonly host: FakeHttpGitHub;
  readonly env: NodeJS.ProcessEnv;
}

function git(cwd: string, env: NodeJS.ProcessEnv, args: readonly string[]): string {
  const run = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout;
}

/** A repository whose reviewed commit edits README.md, with a code edit and a new test file staged. */
function world(label: string): IWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'empty-gitconfig'), '');
  const gitEnv: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'], HOME: home, GIT_CONFIG_GLOBAL: path.join(home, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-09-29T10:00:00Z', GIT_COMMITTER_DATE: '2026-09-29T10:00:00Z',
  };
  const dir = path.join(root, 'repo');
  const write = (file: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  fs.mkdirSync(dir);
  git(dir, gitEnv, ['init', '-q', '-b', 'main']);
  write('README.md', '# Widgets\n');
  write('src/client.ts', CLIENT);
  git(dir, gitEnv, ['add', '.']);
  git(dir, gitEnv, ['commit', '-q', '-m', 'base']);
  const base = git(dir, gitEnv, ['rev-parse', 'HEAD']).trim();
  write('README.md', '# Widgets\nMore.\n');
  git(dir, gitEnv, ['commit', '-q', '-am', 'reviewed']);
  const head = git(dir, gitEnv, ['rev-parse', 'HEAD']).trim();

  write('src/client.ts', EDITED);
  write('test/client.test.ts', TEST_FILE);
  git(dir, gitEnv, ['add', 'src/client.ts', 'test/client.test.ts']);

  const lines = (text: string): string[] => text.match(/[^\n]*\n/g) ?? [];
  const repository: IHttpRepository = {
    destination: DESTINATION,
    commits: { base, head },
    snapshots: {
      [base]: { 'README.md': ['# Widgets\n'], 'src/client.ts': lines(CLIENT), [CONFIG_PATH]: [CONFIG] },
      [head]: { 'README.md': ['# Widgets\n', 'More.\n'], 'src/client.ts': lines(CLIENT), [CONFIG_PATH]: [CONFIG] },
    },
    labels: ['uat-suggestion', 'team-a'],
    pullFiles: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: ['@@ -1 +1,2 @@\n', ' # Widgets\n', '+More.'] }],
    pull: { headRef: HEAD_REF, baseRef: 'main' },
  };
  const hostDir = path.join(root, 'host');
  FakeHttpGitHub.create(hostDir, {}, repository);
  const env = { ...gitEnv, GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: hostDir, NODE_OPTIONS: `--require=${PRELOAD}` };
  return { root, dir, head, host: new FakeHttpGitHub(hostDir, TOKEN), env };
}

/** The selectors of the findings an inspection view shows carrying a change: a fix or a file proposal. */
function selectorsWithChanges(view: unknown): string[] {
  return asArray(asRecord(view, 'the inspection view')['findings'])
    .map((finding) => asRecord(finding))
    .filter((finding) => asArray(finding['fixes']).length > 0 || asArray(finding['fileProposals']).length > 0)
    .map((finding) => asString(finding['selector']));
}

/** One labelled pull request into the head branch with both exact files, and one review linking it. */
function assertPublished(w: IWorld, expected: { readonly draft: boolean; readonly labels: readonly string[] }): void {
  const pulls = w.host.pulls();
  assert.equal(pulls.length, 1);
  const [pull] = pulls;
  assert.ok(pull);
  assert.equal(pull.title, 'Suggestion for #45: retry-with-test (2 changes)');
  assert.equal(pull.base, HEAD_REF);
  assert.equal(pull.draft, expected.draft);
  assert.deepEqual(pull.labels, expected.labels);
  assert.match(pull.head, /^suggestion-pr\/45\/[0-9a-f-]{36}$/);
  assert.match(pull.body, /\n<!-- suggestion-pr \{"version":1,"original":\{"owner":"octo","repo":"companion-uat","pullNumber":45\},"reviewedCommit":"[0-9a-f]{40}","id":"[0-9a-f-]{36}","batch":"[0-9a-f-]{36}"\} -->$/);
  assert.ok(pull.body.includes(expected.draft ? 'it is a draft pull request into `feature/retry`, the branch of #45.' : 'it is a pull request into `feature/retry`, the branch of #45.'), pull.body);
  assert.ok(pull.body.startsWith(`Suggested in a review of #45 at commit ${w.head}.\n\nMerging this pull request into \`feature/retry\` applies these 2 changes together:`), pull.body);
  assert.ok(pull.body.includes(RETRY_MESSAGE) && pull.body.includes(COVER_MESSAGE));
  assert.deepEqual(w.host.fileOnBranch(pull.head, 'src/client.ts'), Buffer.from(EDITED));
  assert.deepEqual(w.host.fileOnBranch(pull.head, 'test/client.test.ts'), Buffer.from(TEST_FILE));
  const reviews = w.host.reviews();
  assert.equal(reviews.length, 1);
  const [review] = reviews;
  assert.ok(review);
  assert.ok(review.request.body.startsWith(`**Suggestion pull request:** [#${String(pull.number)}](https://github.com/octo/companion-uat/pull/${String(pull.number)})`), review.request.body);
  assert.deepEqual(review.request.comments, [], 'both changes travel in the suggestion pull request');
  assert.ok(w.host.log().every((r) => r.authorized));
}

describe('the installed package publishes grouped changes as a companion suggestion pull request', () => {
  const skip = packProject().error || false;

  test('CLI: author, add staged changes, inspect, group, validate and publish', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const w = world('installed-companion-cli');
    const authored = path.join(w.root, 'review.sarif');
    const enriched = path.join(w.root, 'enriched.sarif');
    const repoFlag = `${DESTINATION.owner}/${DESTINATION.repo}`;
    const cli = (args: readonly string[], expectedExit = 0): Record<string, unknown> => {
      const result: SpawnSyncReturns<string> = spawnSync(bin, [...args, '--format', 'json'], { cwd: consumer, env: w.env, encoding: 'utf8', timeout: 120_000 });
      for (const text of [result.stdout, result.stderr]) assert.ok(!text.includes(TOKEN), 'the token never appears');
      assert.equal(result.status, expectedExit, result.stdout + result.stderr);
      return asRecord(parseJson(result.stdout));
    };
    cli(['init', '--output', authored, '--tool-name', 'Review agent', '--repo', repoFlag, '--commit', w.head]);
    cli(['add-comment', '--sarif', authored, '--file', 'src/client.ts', '--line', '2', '--message', RETRY_MESSAGE]);
    cli(['add-comment', '--sarif', authored, '--file', 'test/client.test.ts', '--line', '3', '--message', COVER_MESSAGE]);
    cli(['add-staged-changes', '--sarif', authored, '--output', enriched, '--worktree', w.dir, '--repo', repoFlag, '--commit', w.head]);
    const selectors = selectorsWithChanges(cli(['inspect', '--sarif', enriched])['view']);
    assert.equal(selectors.length, 2, 'the code edit and the new test file');
    const groupedReceipt = cli(['group-fixes', '--sarif', enriched, ...selectors.flatMap((s) => ['--finding', s]), '--group', 'retry-with-test']);
    assert.equal(groupedReceipt['status'], 'grouped');
    assert.equal(groupedReceipt['changes'], 2);
    const view = asRecord(cli(['inspect', '--sarif', enriched])['view']);
    assert.deepEqual(asArray(view['findings']).map((f) => asRecord(f)['suggestionGroup']), ['retry-with-test', 'retry-with-test']);

    const flags = ['--sarif', enriched, '--repo', repoFlag, '--pull', String(DESTINATION.pullNumber), '--commit', w.head];
    const refused = cli(['validate', ...flags], 2);
    assert.match(asString(refused['message']), /suggestion-group-requires-suggestion-prs/);
    assert.match(asString(refused['message']), /--allow-suggestion-prs/);
    const suggestionFlags = ['--allow-suggestion-prs', '--pr-labels', 'team-a', '--mark-suggestion-prs-ready'];
    const ready = cli(['validate', ...flags, ...suggestionFlags]);
    assert.equal(ready['status'], 'ready');
    assert.ok(asString(ready['message']).includes('Publication would also create 1 suggestion pull request, ready for review, into `feature/retry`, labeled `uat-suggestion` and `team-a`.'), asString(ready['message']));
    assert.equal(w.host.pulls().length, 0);
    const published = cli(['publish', ...flags, '--state', path.join(w.root, 'state.json'), ...suggestionFlags]);
    assert.equal(published['status'], 'published');
    assert.equal(asArray(published['suggestions']).length, 1);
    assertPublished(w, { draft: false, labels: ['uat-suggestion', 'team-a'] });
  });

  test('library: the same inspect-then-group workflow in memory through the installed functions', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const w = world('installed-companion-library');
    const js = String.raw;
    const script = js`
      import assert from 'node:assert/strict';
      import { createSarifDocument, addSarifComment, addStagedChangesToSarif, inspectSarif, groupSarifFixes, validateSarifReview, publishSarifReview } from 'sarif-to-comment';
      const [owner, repo] = ['octo', 'companion-uat'];
      const reviewedCommit = process.env.REVIEW_COMMIT;
      let sarif = createSarifDocument({ tool: { name: 'Review agent' }, source: { owner, repo, commit: reviewedCommit } });
      sarif = addSarifComment(sarif, { file: 'src/client.ts', line: 2, message: process.env.RETRY_MESSAGE }).sarif;
      sarif = addSarifComment(sarif, { file: 'test/client.test.ts', line: 3, message: process.env.COVER_MESSAGE }).sarif;
      const staged = await addStagedChangesToSarif({ sarif, worktree: process.env.WORKTREE, reviewedCommit, repository: { owner, repo } });
      assert.equal(staged.status, 'added', staged.markdown);
      const inspected = inspectSarif(staged.sarif);
      assert.equal(inspected.status, 'inspected');
      const findings = inspected.view.findings.filter((f) => f.fixes.length > 0 || f.fileProposals.length > 0).map((f) => f.selector);
      const grouped = groupSarifFixes(staged.sarif, { findings, group: 'retry-with-test' });
      assert.equal(grouped.status, 'grouped', grouped.markdown);
      assert.equal(grouped.changes, 2);
      const input = { sarif: grouped.sarif, destination: { owner, repo, pullNumber: 45 }, reviewedCommit, token: process.env.GH_TOKEN };
      const refused = await validateSarifReview(input);
      assert.equal(refused.status, 'blocked', refused.markdown);
      const options = { allowSuggestionPullRequests: true, pullRequestLabels: ['team-a'] };
      const assessed = await validateSarifReview({ ...input, options });
      assert.equal(assessed.status, 'ready', assessed.markdown);
      const outcome = await publishSarifReview({ ...input, options, statePath: process.env.REVIEW_STATE });
      assert.equal(outcome.status, 'published', outcome.markdown);
      assert.equal(outcome.suggestions.length, 1);
      const again = await publishSarifReview({ ...input, options, statePath: process.env.REVIEW_STATE });
      assert.deepEqual(again.suggestions, outcome.suggestions);
      process.stdout.write(JSON.stringify({ status: outcome.status }));
    `;
    const file = path.join(consumer, 'companion-library.mjs');
    fs.writeFileSync(file, script);
    const env = {
      ...w.env, REVIEW_COMMIT: w.head, WORKTREE: w.dir, REVIEW_STATE: path.join(w.root, 'library-state.json'), RETRY_MESSAGE, COVER_MESSAGE,
    };
    const result = spawnSync(process.execPath, [file], { cwd: consumer, env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN));
    assertPublished(w, { draft: true, labels: ['uat-suggestion', 'team-a'] });
  });
});

describe('the installed package publishes a native multi-change fix as one suggestion pull request', () => {
  const skip = packProject().error || false;

  test('CLI: an upstream fix editing two files is refused without the setting, and is one pull request with it', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const w = world('installed-native-group');
    const repoFlag = `${DESTINATION.owner}/${DESTINATION.repo}`;
    const cli = (args: readonly string[], expectedExit = 0): Record<string, unknown> => {
      const result: SpawnSyncReturns<string> = spawnSync(bin, [...args, '--format', 'json'], { cwd: consumer, env: w.env, encoding: 'utf8', timeout: 120_000 });
      for (const text of [result.stdout, result.stderr]) assert.ok(!text.includes(TOKEN), 'the token never appears');
      assert.equal(result.status, expectedExit, result.stdout + result.stderr);
      return asRecord(parseJson(result.stdout));
    };
    // As an upstream producer writes it: one fix whose two artifact changes apply together (SARIF 3.55).
    const upstream = path.join(w.root, 'upstream.sarif');
    const replace = (uri: string, line: number, text: string): unknown => ({ artifactLocation: { uri }, replacements: [{ deletedRegion: { startLine: line }, insertedContent: { text } }] });
    fs.writeFileSync(upstream, JSON.stringify({
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'Upstream linter' } },
        columnKind: 'utf16CodeUnits',
        versionControlProvenance: [{ repositoryUri: `https://github.com/${repoFlag}`, revisionId: w.head }],
        results: [{
          message: { text: RETRY_MESSAGE },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'src/client.ts' }, region: { startLine: 2 } } }],
          fixes: [{ artifactChanges: [
            replace('src/client.ts', 2, '  const response = await request(id).catch(() => request(id));'),
            replace('README.md', 2, 'More, with retries.'),
          ] }],
        }],
      }],
    }, null, 2));
    const written = fs.readFileSync(upstream);
    const inspected = asArray(asRecord(cli(['inspect', '--sarif', upstream])['view'])['findings']);
    assert.equal(asArray(asRecord(asArray(asRecord(inspected[0])['fixes'])[0])['changes']).length, 2, 'inspection shows the one fix with both file changes');

    const flags = ['--sarif', upstream, '--repo', repoFlag, '--pull', String(DESTINATION.pullNumber), '--commit', w.head];
    const refused = cli(['validate', ...flags], 2);
    assert.match(asString(refused['message']), /fix-changes-require-suggestion-prs/);
    assert.match(asString(refused['message']), /--allow-suggestion-prs/);
    const published = cli(['publish', ...flags, '--state', path.join(w.root, 'native-state.json'), '--allow-suggestion-prs']);
    assert.equal(published['status'], 'published');
    const pulls = w.host.pulls();
    assert.equal(pulls.length, 1);
    const [pull] = pulls;
    assert.ok(pull);
    assert.equal(pull.title, 'Suggestion for #45: 2 changes');
    assert.equal(pull.draft, true);
    assert.deepEqual(pull.labels, ['uat-suggestion']);
    assert.deepEqual(w.host.fileOnBranch(pull.head, 'src/client.ts'), Buffer.from(EDITED));
    assert.deepEqual(w.host.fileOnBranch(pull.head, 'README.md'), Buffer.from('# Widgets\nMore, with retries.\n'));
    assert.deepEqual(fs.readFileSync(upstream), written, 'publication never edits the SARIF file');
    assert.equal(asArray(asRecord(readJson(upstream))['runs']).length, 1);
  });
});
