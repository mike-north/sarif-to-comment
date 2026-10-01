/**
 * User acceptance of whole-file proposals through the *installed* package
 * (the tarball `npm pack` produces, installed into a clean consumer by
 * test/fixtures/package/installed-package.mts). Only public surfaces are
 * used: the linked `sarif-to-comment` executable and `import … from
 * 'sarif-to-comment'`.
 *
 * A real local Git repository stages every kind of whole-file change next to
 * an ordinary edit: a created page with fences and HTML, an empty file, an
 * executable script, the deletion of a text file (explained by a finding on
 * its line 2) and the deletion of a binary file. Both the CLI and the library
 * run init → add-comment → add-staged-changes → inspect → validate → publish
 * against a fake GitHub that speaks HTTP to the product's real client (the
 * preload replaces only `fetch`).
 *
 * The expected review body is written by hand from
 * docs/file-operation-publication-contract.md and the staged bytes below; the
 * neutral results' wording comes from the extraction contract
 * (docs/second-milestone-contract-proposal.md §4.8).
 *
 * @see https://git-scm.com/docs/git-update-index#Documentation/git-update-index.txt---chmod-x
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://github.github.com/gfm/#fenced-code-blocks
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
import { PKG, ROOT, installIntoConsumer, packProject } from './fixtures/package/installed-package.mts';
import { asRecord, isShape, isUnknown, expectType, parseJson } from './support/runtime-types.mts';

const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'docs', 'fake-fetch-preload.mts');
const TOKEN = 'ghp_FILE_OPERATIONS_installed_0123456789';
const DESTINATION = { owner: 'octo', repo: 'review-files', pullNumber: 44 } as const;
const MARKER = /\n\n<!-- sarif-to-comment:review:[0-9a-f-]{36} -->$/;

const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
const GUIDE = '# Guide\n\n````md\n```js\nx\n```\n````\n\n<script>alert(1)</script> {{ x }} @octocat\n';
const TOOL = '#!/bin/sh\necho hi\n';
const GUIDE_MESSAGE = 'Add a guide for the new option.';
const OBSOLETE_MESSAGE = 'This module is obsolete; remove it.';

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

/**
 * A repository whose reviewed commit adds a line to README.md, and whose
 * index stages: the README edit, three creations and two deletions.
 */
function world(label: string): IWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'empty-gitconfig'), '');
  const gitEnv: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'], HOME: home, GIT_CONFIG_GLOBAL: path.join(home, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-09-28T10:00:00Z', GIT_COMMITTER_DATE: '2026-09-28T10:00:00Z',
  };
  const dir = path.join(root, 'repo');
  const write = (file: string, content: string | Buffer): void => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  fs.mkdirSync(dir);
  git(dir, gitEnv, ['init', '-q', '-b', 'main']);
  write('README.md', '# Widgets\n');
  write('obsolete.txt', 'first line\nsecond line\n');
  write('assets/logo.png', LOGO);
  git(dir, gitEnv, ['add', '.']);
  git(dir, gitEnv, ['commit', '-q', '-m', 'base']);
  const base = git(dir, gitEnv, ['rev-parse', 'HEAD']).trim();
  write('README.md', '# Widgets\nMore.\n');
  git(dir, gitEnv, ['commit', '-q', '-am', 'reviewed']);
  const head = git(dir, gitEnv, ['rev-parse', 'HEAD']).trim();

  write('README.md', '# Widgets\nMuch more.\n');
  write('docs/guide.md', GUIDE);
  write('empty.txt', '');
  write('tool.sh', TOOL);
  git(dir, gitEnv, ['add', 'README.md', 'docs/guide.md', 'empty.txt', 'tool.sh']);
  git(dir, gitEnv, ['update-index', '--chmod=+x', 'tool.sh']);
  git(dir, gitEnv, ['rm', '-q', '--cached', 'obsolete.txt', 'assets/logo.png']);
  assert.equal(git(dir, gitEnv, ['ls-files', '-s', 'tool.sh']).slice(0, 6), '100755');

  const unchanged = { 'obsolete.txt': ['first line\n', 'second line\n'] };
  const repository: IHttpRepository = {
    destination: DESTINATION,
    commits: { base, head },
    snapshots: {
      [base]: { 'README.md': ['# Widgets\n'], ...unchanged },
      [head]: { 'README.md': ['# Widgets\n', 'More.\n'], ...unchanged },
    },
    rawFiles: {
      [base]: { 'assets/logo.png': { base64: LOGO.toString('base64') } },
      [head]: { 'assets/logo.png': { base64: LOGO.toString('base64') } },
    },
    pullFiles: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: ['@@ -1 +1,2 @@\n', ' # Widgets\n', '+More.'] }],
  };
  const hostDir = path.join(root, 'host');
  FakeHttpGitHub.create(hostDir, {}, repository);
  const env = { ...gitEnv, GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: hostDir, NODE_OPTIONS: `--require=${PRELOAD}` };
  return { root, dir, head, host: new FakeHttpGitHub(hostDir, TOKEN), env };
}

/** The review body the contract requires for this world's staged changes (written by hand). */
function expectedBody(head: string): string {
  const short = head.slice(0, 7);
  const blob = (file: string, anchor = ''): string => `https://github.com/octo/review-files/blob/${head}/${file}${anchor}`;
  const neutral = `<sub>— sarif-to-comment ${PKG.version} · rule \`staged-change\`</sub>`;
  const tail = 'No supplied finding was associated with this change.';
  return [
    '**Proposed new file:** `docs/guide.md`',
    '',
    '**File details:** 77 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
    '',
    '`````',
    GUIDE.slice(0, -1),
    '`````',
    '',
    '**Location:** line 1 of the proposed file',
    '',
    GUIDE_MESSAGE,
    '',
    '<sub>— Review agent</sub>',
    '',
    '---',
    '',
    `**Proposed file deletion:** [obsolete.txt at ${short}](${blob('obsolete.txt')})`,
    '',
    'The whole file is removed; this is not a proposal to empty it.',
    '',
    `**Source:** [obsolete.txt line 2 at ${short}](${blob('obsolete.txt', '?plain=1#L2')})`,
    '',
    '```',
    'second line',
    '```',
    '',
    OBSOLETE_MESSAGE,
    '',
    '<sub>— Review agent</sub>',
    '',
    '---',
    '',
    `**Proposed file deletion:** [assets/logo.png at ${short}](${blob('assets/logo.png')})`,
    '',
    'The whole file is removed; this is not a proposal to empty it.',
    '',
    `Staged deletion of \\\`assets/logo.png\\\`. ${tail}`,
    '',
    neutral,
    '',
    '---',
    '',
    '**Proposed new file:** `empty.txt`',
    '',
    '**File details:** empty file (0 bytes) · mode 100644',
    '',
    `Staged creation of \\\`empty.txt\\\`. ${tail}`,
    '',
    neutral,
    '',
    '---',
    '',
    '**Proposed new file:** `tool.sh`',
    '',
    '**File details:** 18 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100755 (executable)',
    '',
    '```',
    TOOL.slice(0, -1),
    '```',
    '',
    `Staged creation of \\\`tool.sh\\\`. ${tail}`,
    '',
    neutral,
  ].join('\n');
}

/** The one stored review: a draft on the reviewed commit, with the exact body and the README suggestion. */
function assertPublished(w: IWorld): void {
  const reviews = w.host.reviews();
  assert.equal(reviews.length, 1);
  const [stored] = reviews;
  assert.ok(stored);
  assert.equal(stored.state, 'PENDING');
  assert.equal(stored.request.commit_id, w.head);
  assert.match(stored.request.body, MARKER);
  assert.equal(stored.request.body.replace(MARKER, ''), expectedBody(w.head));
  assert.equal(stored.request.comments.length, 1, 'the README edit is a native suggestion');
  const [comment] = stored.request.comments;
  assert.ok(comment);
  assert.deepEqual([comment.path, comment.side, comment.line], ['README.md', 'RIGHT', 2]);
  assert.ok(comment.body.endsWith('```suggestion\nMuch more.\n```'), comment.body);
  assert.ok(w.host.log().every((r) => r.authorized));
}

describe('the installed package publishes whole-file proposals', () => {
  const skip = packProject().error || false;

  test('CLI: author, add staged changes, inspect, validate and publish', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const w = world('installed-file-ops-cli');
    const authored = path.join(w.root, 'review.sarif');
    const enriched = path.join(w.root, 'enriched.sarif');
    const repoFlag = `${DESTINATION.owner}/${DESTINATION.repo}`;
    const cli = (args: readonly string[], expectedExit = 0): unknown => {
      const result: SpawnSyncReturns<string> = spawnSync(bin, [...args, '--format', 'json'], { cwd: consumer, env: w.env, encoding: 'utf8', timeout: 120_000 });
      for (const text of [result.stdout, result.stderr]) assert.ok(!text.includes(TOKEN), 'the token never appears');
      assert.equal(result.status, expectedExit, result.stdout + result.stderr);
      return parseJson(result.stdout);
    };
    cli(['init', '--output', authored, '--tool-name', 'Review agent', '--repo', repoFlag, '--commit', w.head]);
    cli(['add-comment', '--sarif', authored, '--file', 'docs/guide.md', '--line', '1', '--message', GUIDE_MESSAGE]);
    cli(['add-comment', '--sarif', authored, '--file', 'obsolete.txt', '--line', '2', '--message', OBSOLETE_MESSAGE]);
    cli(['add-staged-changes', '--sarif', authored, '--output', enriched, '--worktree', w.dir, '--repo', repoFlag, '--commit', w.head]);

    const inspected = expectType(cli(['inspect', '--sarif', enriched]), isShape({ view: isShape({ summary: isShape({ fileProposals: isUnknown }) }) }), 'inspection');
    assert.equal(inspected.view.summary.fileProposals, 5);

    const flags = ['--sarif', enriched, '--repo', repoFlag, '--pull', String(DESTINATION.pullNumber), '--commit', w.head];
    assert.equal(asRecord(cli(['validate', ...flags]), 'validate')['status'], 'ready');
    assert.equal(w.host.reviews().length, 0);
    assert.equal(asRecord(cli(['publish', ...flags, '--state', path.join(w.root, 'state.json')]), 'publish')['status'], 'published');
    assertPublished(w);
  });

  test('library: the same workflow in memory through the installed functions', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const w = world('installed-file-ops-library');
    const js = String.raw;
    const script = js`
      import assert from 'node:assert/strict';
      import { createSarifDocument, addSarifComment, addStagedChangesToSarif, inspectSarif, validateSarifReview, publishSarifReview } from 'sarif-to-comment';
      const [owner, repo] = ['octo', 'review-files'];
      const reviewedCommit = process.env.REVIEW_COMMIT;
      let sarif = createSarifDocument({ tool: { name: 'Review agent' }, source: { owner, repo, commit: reviewedCommit } });
      sarif = addSarifComment(sarif, { file: 'docs/guide.md', line: 1, message: process.env.GUIDE_MESSAGE }).sarif;
      sarif = addSarifComment(sarif, { file: 'obsolete.txt', line: 2, message: process.env.OBSOLETE_MESSAGE }).sarif;
      const staged = await addStagedChangesToSarif({ sarif, worktree: process.env.WORKTREE, reviewedCommit, repository: { owner, repo } });
      assert.equal(staged.status, 'added', staged.markdown);
      assert.equal(inspectSarif(staged.sarif).view.summary.fileProposals, 5);
      const input = { sarif: staged.sarif, destination: { owner, repo, pullNumber: 44 }, reviewedCommit, token: process.env.GH_TOKEN };
      const assessed = await validateSarifReview(input);
      assert.equal(assessed.status, 'ready', assessed.markdown);
      const outcome = await publishSarifReview({ ...input, statePath: process.env.REVIEW_STATE });
      assert.equal(outcome.status, 'published', outcome.markdown);
      process.stdout.write(JSON.stringify({ status: outcome.status }));
    `;
    const file = path.join(consumer, 'file-operations-library.mjs');
    fs.writeFileSync(file, script);
    const env = {
      ...w.env, REVIEW_COMMIT: w.head, WORKTREE: w.dir, REVIEW_STATE: path.join(w.root, 'library-state.json'),
      GUIDE_MESSAGE, OBSOLETE_MESSAGE,
    };
    const result = spawnSync(process.execPath, [file], { cwd: consumer, env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN));
    assertPublished(w);
  });
});
