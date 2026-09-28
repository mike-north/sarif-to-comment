'use strict';

/**
 * End-to-end acceptance of the complete workflow through the *installed*
 * package: the tarball `npm pack` produces, installed by npm into a clean
 * consumer (test/fixtures/package/installed-package.cjs). Only public
 * surfaces are used — the linked `sarif-to-comment` executable and
 * `import … from 'sarif-to-comment'` — never repository modules or
 * hand-built SARIF scaffolding for the authored path.
 *
 * Three flows, each ending in a draft review on a fake GitHub that speaks
 * HTTP to the product's real GitHub client (the preload in
 * test/fixtures/docs replaces only `fetch`):
 *   1. CLI authoring: init → add-comment ×2 → inspect → add-staged-changes →
 *      inspect → publish (JSON mode throughout, with a human spot check).
 *   2. Library authoring: the same with the installed functions, in memory.
 *   3. Upstream SARIF with no initialization: inspect → add-staged-changes →
 *      publish; plus direct publication of ready upstream SARIF.
 *
 * The expectations come from the parent's independent source oracle
 * (docs/evidence/second-milestone/source-oracle.json and
 * upstream-input.sarif.json): the reviewed text H, the staged text T, the
 * working text W with an unstaged sentinel, two findings (line 2; lines 5–6)
 * and their intended replacement lines. Applying the extracted replacements
 * to H with an independent applier must give T exactly. What a real GitHub
 * renders or applies is not established here; that is the parent's live
 * acceptance.
 *
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-and-highlighting-code-blocks
 * @see https://docs.npmjs.com/cli/v11/commands/npm-install
 */

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ROOT, packProject, installIntoConsumer } = require('./fixtures/package/installed-package.cjs');
const { FakeHttpGitHub } = require('./fixtures/composition/fake-http-github.cjs');
const {
  ORACLE,
  UPSTREAM_SARIF_PATH,
  SENTINEL,
  createGitWorld,
  applyReplacements,
  replacementsFor,
  distinctReplacements,
} = require('./fixtures/authoring-workflow/git-world.cjs');

const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'docs', 'fake-fetch-preload.cjs');
const TOKEN = 'ghp_WORKFLOW_token_for_installed_tests_0123456789';
const UPSTREAM = JSON.parse(fs.readFileSync(UPSTREAM_SARIF_PATH, 'utf8'));
const [FINDING_A, FINDING_B] = ORACLE.findings;

/** A Git world plus a fake GitHub serving its commits, and the environment for installed commands. */
function world(label) {
  const git = createGitWorld(label);
  const hostDir = path.join(git.root, 'host');
  FakeHttpGitHub.create(hostDir, {}, git.repository);
  const host = new FakeHttpGitHub(hostDir, TOKEN);
  const env = {
    ...git.env,
    GH_TOKEN: TOKEN,
    FAKE_HTTP_GITHUB_DIR: hostDir,
    NODE_OPTIONS: `--require=${PRELOAD}`,
  };
  const { owner, repo, pullNumber } = git.repository.destination;
  return { ...git, host, env, repoFlag: `${owner}/${repo}`, pull: String(pullNumber) };
}

const createPosts = (host) => host.log().filter((r) => r.method === 'POST' && r.path.endsWith('/reviews')).length;

/** The exact inline comments a faithful publication of findings A and B creates (from the oracle). */
function assertOracleReview(host, w, { messages = [FINDING_A.message, FINDING_B.message] } = {}) {
  const reviews = host.reviews();
  assert.equal(reviews.length, 1, 'exactly one review');
  const [stored] = reviews;
  assert.equal(stored.state, 'PENDING', 'a draft');
  assert.equal(Object.hasOwn(stored.request, 'event'), false, 'never submitted');
  assert.equal(stored.request.commit_id, w.head);
  const comments = [...stored.request.comments].sort((x, y) => x.line - y.line);
  assert.equal(comments.length, 2, JSON.stringify(stored.request.comments, null, 2));
  const [a, b] = comments;
  assert.equal(a.path, ORACLE.path);
  assert.equal(a.side, 'RIGHT');
  assert.equal(a.line, FINDING_A.line);
  assert.equal(a.start_line, undefined, 'a single-line comment');
  assert.ok(a.body.includes(messages[0]), a.body);
  assert.ok(a.body.endsWith(`\`\`\`suggestion\n${FINDING_A.replacementLines.join('\n')}\n\`\`\``), a.body);
  assert.equal(b.path, ORACLE.path);
  assert.equal(b.side, 'RIGHT');
  assert.equal(b.start_line, FINDING_B.line);
  assert.equal(b.start_side, 'RIGHT');
  assert.equal(b.line, FINDING_B.endLine);
  assert.ok(b.body.includes(messages[1]), b.body);
  assert.ok(b.body.endsWith(`\`\`\`suggestion\n${FINDING_B.replacementLines.join('\n')}\n\`\`\``), b.body);
  for (const comment of comments) assert.ok(!comment.body.includes(SENTINEL));
  assert.ok(host.log().every((r) => r.authorized), 'every request carried the token');
}

/** The enriched SARIF reproduces T from H and contains no unstaged content. */
function assertStagedFidelity(sarifText) {
  assert.ok(!sarifText.includes(SENTINEL), 'unstaged working-tree content never enters the SARIF');
  const edits = distinctReplacements(replacementsFor(JSON.parse(sarifText), ORACLE.path));
  assert.equal(applyReplacements(ORACLE.reviewed, edits), ORACLE.staged);
}

describe('the installed package runs the complete workflow', () => {
  const skip = packProject().error || false;

  test('CLI authoring: init, two comments, inspect, staged changes, inspect, publish', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const w = world('installed-cli');
    const work = fs.mkdtempSync(path.join(w.root, 'artifacts-'));
    const authored = path.join(work, 'review.sarif');
    const enriched = path.join(work, 'enriched.sarif');
    const cli = (args, extra = {}) => {
      const result = spawnSync(bin, args, { cwd: consumer, env: w.env, encoding: 'utf8', timeout: 120_000, ...extra });
      for (const text of [result.stdout, result.stderr]) assert.ok(!text.includes(TOKEN), 'the token never appears');
      return result;
    };
    const jsonCli = (args, expectedExit = 0) => {
      const result = cli([...args, '--format', 'json']);
      assert.equal(result.status, expectedExit, result.stdout + result.stderr);
      assert.equal(result.stderr, '');
      return JSON.parse(result.stdout);
    };

    const created = jsonCli(['init', '--output', authored, '--tool-name', 'Review agent', '--repo', w.repoFlag, '--commit', w.head]);
    assert.equal(created.status, 'created');
    const a = jsonCli(['add-comment', '--sarif', authored, '--file', ORACLE.path, '--line', String(FINDING_A.line), '--message', FINDING_A.message]);
    const b = jsonCli([
      'add-comment', '--sarif', authored, '--file', ORACLE.path, '--line', String(FINDING_B.line),
      '--end-line', String(FINDING_B.endLine), '--message', FINDING_B.message,
    ]);
    assert.deepEqual([a.finding.ref, b.finding.ref], ['/runs/0/results/0', '/runs/0/results/1']);

    const before = jsonCli(['inspect', '--sarif', authored]);
    assert.deepEqual(
      before.view.findings.map((f) => [f.message.text, f.locations.map((l) => [l.path, l.startLine, l.endLine ?? l.startLine])]),
      [
        [FINDING_A.message, [[ORACLE.path, FINDING_A.line, FINDING_A.endLine]]],
        [FINDING_B.message, [[ORACLE.path, FINDING_B.line, FINDING_B.endLine]]],
      ],
    );
    assert.equal(before.view.summary.fixes, 0);

    const staged = jsonCli([
      'add-staged-changes', '--sarif', authored, '--output', enriched, '--worktree', w.dir, '--repo', w.repoFlag, '--commit', w.head,
    ]);
    assert.equal(staged.status, 'added');
    assert.deepEqual(staged.output, { path: enriched, written: true });
    assert.deepEqual(
      staged.receipt.changes[0].replacements.map((r) => [r.startLine, r.endLine, r.associated, r.explainedBy]),
      [
        [FINDING_A.line, FINDING_A.endLine, ['/runs/0/results/0'], 'finding'],
        [FINDING_B.line, FINDING_B.endLine, ['/runs/0/results/1'], 'finding'],
      ],
    );
    assertStagedFidelity(fs.readFileSync(enriched, 'utf8'));

    const after = jsonCli(['inspect', '--sarif', enriched, '--preview-lines', 'all']);
    assert.equal(after.view.summary.findings, 2, 'no finding added or lost');
    assert.deepEqual(after.view.findings.map((f) => f.message.text), [FINDING_A.message, FINDING_B.message]);
    assert.deepEqual(
      after.view.findings.map((f) => f.fixes.map((x) => x.changes[0].replacements.map((r) => r.inserted.text))),
      [[[`${FINDING_A.replacementLines.join('\n')}\n`]], [[`${FINDING_B.replacementLines.join('\n')}\n`]]],
    );
    const human = cli(['inspect', '--sarif', enriched]);
    assert.equal(human.status, 0, human.stderr);
    assert.ok(human.stdout.includes(FINDING_A.message) && human.stdout.includes(FINDING_B.message));

    const statePath = path.join(work, 'publication.json');
    const publishArgs = ['publish', '--sarif', enriched, '--repo', w.repoFlag, '--pull', w.pull, '--commit', w.head, '--state', statePath];
    const published = jsonCli(publishArgs);
    assert.equal(published.status, 'published', published.message);
    assert.equal(published.statePath, statePath);
    assertOracleReview(w.host, w);
    assert.ok(published.review.url.endsWith(`#pullrequestreview-${w.host.reviews()[0].id}`));

    const again = jsonCli(publishArgs);
    assert.deepEqual(again.review, published.review);
    assert.equal(createPosts(w.host), 1, 'a retry with the same state file sends nothing');
  });

  test('library authoring: the same workflow in memory through the installed functions', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const w = world('installed-library');
    const statePath = path.join(w.root, 'library-publication.json');
    const js = String.raw;
    const script = js`
      import assert from 'node:assert/strict';
      import { createSarifDocument, addSarifComment, inspectSarif, addStagedChangesToSarif, publishSarifReview } from 'sarif-to-comment';
      const oracle = JSON.parse(process.env.ORACLE);
      const [A, B] = oracle.findings;
      const [owner, repo] = process.env.REVIEW_REPOSITORY.split('/');
      const reviewedCommit = process.env.REVIEW_COMMIT;

      let sarif = createSarifDocument({ tool: { name: 'Review agent' }, source: { owner, repo, commit: reviewedCommit } });
      const first = addSarifComment(sarif, { file: oracle.path, line: A.line, message: A.message });
      assert.equal(first.status, 'added');
      assert.equal(sarif.runs[0].results.length, 0, 'the input document is unchanged');
      sarif = first.sarif;
      const second = addSarifComment(sarif, { file: oracle.path, line: B.line, endLine: B.endLine, message: B.message });
      sarif = second.sarif;
      assert.deepEqual([first.finding.ref, second.finding.ref], ['/runs/0/results/0', '/runs/0/results/1']);

      const inspected = inspectSarif(sarif);
      assert.equal(inspected.status, 'inspected');
      assert.deepEqual(inspected.view.findings.map((f) => f.message.text), [A.message, B.message]);

      const request = { sarif, worktree: process.env.WORKTREE, reviewedCommit, repository: { owner, repo } };
      const pending = addStagedChangesToSarif(request);
      sarif.runs[0].results[0].message.text = 'changed after the call started';
      const staged = await pending;
      assert.equal(staged.status, 'added', staged.markdown);
      assert.equal(staged.sarif.runs[0].results[0].message.text, A.message, 'the call captured its input');

      const outcome = await publishSarifReview({
        sarif: staged.sarif,
        destination: { owner, repo, pullNumber: Number(process.env.REVIEW_PULL) },
        reviewedCommit,
        statePath: process.env.REVIEW_STATE,
        token: process.env.GH_TOKEN,
      });
      assert.equal(outcome.status, 'published', outcome.markdown);
      process.stdout.write(JSON.stringify({ enriched: staged.sarif, receipt: staged.receipt, review: outcome.review }));
    `;
    const file = path.join(consumer, 'library-workflow.mjs');
    fs.writeFileSync(file, script);
    const env = {
      ...w.env,
      ORACLE: JSON.stringify(ORACLE),
      REVIEW_REPOSITORY: w.repoFlag,
      REVIEW_COMMIT: w.head,
      REVIEW_PULL: w.pull,
      REVIEW_STATE: statePath,
      WORKTREE: w.dir,
    };
    const result = spawnSync(process.execPath, [file], { cwd: consumer, env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const { enriched, receipt, review } = JSON.parse(result.stdout);
    assertStagedFidelity(JSON.stringify(enriched));
    assert.deepEqual(receipt.boundRuns, [], 'the authored run was already bound');
    assertOracleReview(w.host, w);
    assert.equal(typeof review.id, 'number');
  });

  test('upstream SARIF without initialization: inspect, staged changes, publish', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const w = world('installed-upstream');
    const work = fs.mkdtempSync(path.join(w.root, 'artifacts-'));
    const enriched = path.join(work, 'enriched.sarif');
    const jsonCli = (args) => {
      const result = spawnSync(bin, [...args, '--format', 'json'], { cwd: consumer, env: w.env, encoding: 'utf8', timeout: 120_000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    };

    const inspected = jsonCli(['inspect', '--sarif', UPSTREAM_SARIF_PATH]);
    assert.deepEqual(inspected.view.runs.map((r) => [r.tool.name, r.source.state]), [['Independent fixture producer', 'unbound']]);

    const staged = jsonCli([
      'add-staged-changes', '--sarif', UPSTREAM_SARIF_PATH, '--output', enriched, '--worktree', w.dir, '--repo', w.repoFlag, '--commit', w.head,
    ]);
    assert.deepEqual(staged.receipt.boundRuns, [0]);
    const text = fs.readFileSync(enriched, 'utf8');
    assertStagedFidelity(text);

    // Only documented additions: fixes on the two findings and the run's source binding.
    const output = JSON.parse(text);
    const strip = (sarif) => {
      const copy = structuredClone(sarif);
      delete copy.runs[0].versionControlProvenance;
      for (const result of copy.runs[0].results) delete result.fixes;
      return copy;
    };
    assert.deepEqual(strip(output), UPSTREAM, 'producer content, attribution and metadata are preserved');
    assert.deepEqual(output.runs[0].versionControlProvenance, [{ repositoryUri: `https://github.com/${w.repoFlag}`, revisionId: w.head }]);

    const published = jsonCli([
      'publish', '--sarif', enriched, '--repo', w.repoFlag, '--pull', w.pull, '--commit', w.head, '--state', path.join(work, 'state.json'),
    ]);
    assert.equal(published.status, 'published', published.message);
    assertOracleReview(w.host, w);
    for (const comment of w.host.reviews()[0].request.comments) {
      assert.ok(comment.body.includes('Independent fixture producer'), 'the upstream tool is credited');
    }
  });

  test('ready upstream SARIF publishes directly, with no authoring or staged step', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const w = world('installed-direct');
    const ready = structuredClone(UPSTREAM);
    const [a, b] = ready.runs[0].results;
    const fix = (line, endLine, text) => [
      {
        artifactChanges: [
          {
            artifactLocation: { uri: ORACLE.path },
            replacements: [{ deletedRegion: { startLine: line, startColumn: 1, endLine: endLine + 1, endColumn: 1 }, insertedContent: { text } }],
          },
        ],
      },
    ];
    // Written by hand from the oracle: each finding's intended replacement of its own lines.
    a.fixes = fix(FINDING_A.line, FINDING_A.endLine, `${FINDING_A.replacementLines.join('\n')}\n`);
    b.fixes = fix(FINDING_B.line, FINDING_B.endLine, `${FINDING_B.replacementLines.join('\n')}\n`);
    const file = path.join(w.root, 'ready.sarif');
    fs.writeFileSync(file, JSON.stringify(ready));
    const result = spawnSync(
      bin,
      ['--sarif', file, '--repo', w.repoFlag, '--pull', w.pull, '--commit', w.head, '--state', path.join(w.root, 'state.json')],
      { cwd: consumer, env: w.env, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /pullrequestreview-\d+/, 'the flag-only form prints the library Markdown');
    assertOracleReview(w.host, w);
  });
});
