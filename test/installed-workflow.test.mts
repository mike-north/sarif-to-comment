/**
 * End-to-end acceptance of the complete workflow through the *installed*
 * package: the tarball `npm pack` produces, installed by npm into a clean
 * consumer (test/fixtures/package/installed-package.mts). Only public
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
 *   4. Correction, through the CLI and the library: a mistaken finding is
 *      removed by its inspected selector (a stale reuse is refused), its
 *      replacement is added, and the enriched artifact is regenerated
 *      separately from the corrected authored input before publication
 *      (docs/finding-removal-contract.md).
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

import { AssertionError } from 'node:assert';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import {
  ORACLE,
  UPSTREAM_SARIF_PATH,
  SENTINEL,
  createGitWorld,
  applyReplacements,
  replacementsFor,
  distinctReplacements,
} from './fixtures/authoring-workflow/git-world.mts';
import type { IGitWorld } from './fixtures/authoring-workflow/git-world.mts';
import { FakeHttpGitHub } from './fixtures/composition/fake-http-github.mts';
import { ROOT, packProject, installIntoConsumer } from './fixtures/package/installed-package.mts';
import {
  asArray,
  asRecord,
  expectType,
  isArrayOf,
  isOptional,
  isRecord,
  isShape,
  isString,
  isUnknown,
  parseJson,
  readJson,
} from './support/runtime-types.mts';

/** `value`, which the assertions before it establish is present; fails naming `what` otherwise. */
function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new AssertionError({ message: `expected ${what}`, actual: value, operator: 'present' });
  return value;
}

const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'docs', 'fake-fetch-preload.mts');
const TOKEN = 'ghp_WORKFLOW_token_for_installed_tests_0123456789';
const UPSTREAM = readJson(UPSTREAM_SARIF_PATH);
const FINDING_A = present(ORACLE.findings[0], 'oracle finding A');
const FINDING_B = present(ORACLE.findings[1], 'oracle finding B');

/** A Git world with its fake GitHub and the environment and flags for installed commands. */
interface IWorkflowWorld extends IGitWorld {
  readonly host: FakeHttpGitHub;
  readonly env: NodeJS.ProcessEnv;
  readonly repoFlag: string;
  readonly pull: string;
}

/** A CLI outcome: its status and, when it failed, the Markdown explaining why. */
const isOutcome = isShape({ status: isUnknown, message: isOptional(isString), markdown: isOptional(isString) });

/** An inspection view as the assertions read it; the compared values stay `unknown`. */
const isInspection = isShape({
  view: isShape({
    summary: isShape({ fixes: isUnknown, findings: isUnknown }),
    findings: isArrayOf(isShape({ message: isShape({ text: isUnknown }) })),
  }),
});

/** A Git world plus a fake GitHub serving its commits, and the environment for installed commands. */
function world(label: string): IWorkflowWorld {
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

const createPosts = (host: FakeHttpGitHub): number => host.log().filter((r) => r.method === 'POST' && r.path.endsWith('/reviews')).length;

/** The exact inline comments a faithful publication of findings A and B creates (from the oracle). */
function assertOracleReview(
  host: FakeHttpGitHub,
  w: IWorkflowWorld,
  { messages = [FINDING_A.message, FINDING_B.message] }: { messages?: readonly [string, string] } = {},
): void {
  const reviews = host.reviews();
  assert.equal(reviews.length, 1, 'exactly one review');
  const stored = present(reviews[0], 'the review');
  assert.equal(stored.state, 'PENDING', 'a draft');
  assert.equal(Object.hasOwn(stored.request, 'event'), false, 'never submitted');
  assert.equal(stored.request.commit_id, w.head);
  const comments = [...stored.request.comments].sort((x, y) => x.line - y.line);
  assert.equal(comments.length, 2, JSON.stringify(stored.request.comments, null, 2));
  const a = present(comments[0], 'the comment on finding A');
  const b = present(comments[1], 'the comment on finding B');
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
function assertStagedFidelity(sarifText: string): void {
  assert.ok(!sarifText.includes(SENTINEL), 'unstaged working-tree content never enters the SARIF');
  const edits = distinctReplacements(replacementsFor(parseJson(sarifText), ORACLE.path));
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
    const cli = (args: readonly string[], extra: Partial<SpawnSyncOptionsWithStringEncoding> = {}): SpawnSyncReturns<string> => {
      const result = spawnSync(bin, args, { cwd: consumer, env: w.env, encoding: 'utf8', timeout: 120_000, ...extra });
      for (const text of [result.stdout, result.stderr]) assert.ok(!text.includes(TOKEN), 'the token never appears');
      return result;
    };
    const jsonCli = (args: readonly string[], expectedExit = 0): unknown => {
      const result = cli([...args, '--format', 'json']);
      assert.equal(result.status, expectedExit, result.stdout + result.stderr);
      assert.equal(result.stderr, '');
      return parseJson(result.stdout);
    };

    const created = expectType(
      jsonCli(['init', '--output', authored, '--tool-name', 'Review agent', '--repo', w.repoFlag, '--commit', w.head]),
      isOutcome,
      'the init outcome',
    );
    assert.equal(created.status, 'created');
    const isAdded = isShape({ finding: isShape({ ref: isUnknown }) });
    const a = expectType(
      jsonCli(['add-comment', '--sarif', authored, '--file', ORACLE.path, '--line', String(FINDING_A.line), '--message', FINDING_A.message]),
      isAdded,
      'an added comment',
    );
    const b = expectType(
      jsonCli([
        'add-comment', '--sarif', authored, '--file', ORACLE.path, '--line', String(FINDING_B.line),
        '--end-line', String(FINDING_B.endLine), '--message', FINDING_B.message,
      ]),
      isAdded,
      'an added comment',
    );
    assert.deepEqual([a.finding.ref, b.finding.ref], ['/runs/0/results/0', '/runs/0/results/1']);

    const before = expectType(
      jsonCli(['inspect', '--sarif', authored]),
      isShape({
        view: isShape({
          summary: isShape({ fixes: isUnknown }),
          findings: isArrayOf(
            isShape({
              message: isShape({ text: isUnknown }),
              locations: isArrayOf(isShape({ path: isUnknown, startLine: isUnknown, endLine: isUnknown })),
            }),
          ),
        }),
      }),
      'an inspection with locations',
    );
    assert.deepEqual(
      before.view.findings.map((f) => [f.message.text, f.locations.map((l) => [l.path, l.startLine, l.endLine ?? l.startLine])]),
      [
        [FINDING_A.message, [[ORACLE.path, FINDING_A.line, FINDING_A.endLine]]],
        [FINDING_B.message, [[ORACLE.path, FINDING_B.line, FINDING_B.endLine]]],
      ],
    );
    assert.equal(before.view.summary.fixes, 0);

    const staged = expectType(
      jsonCli([
        'add-staged-changes', '--sarif', authored, '--output', enriched, '--worktree', w.dir, '--repo', w.repoFlag, '--commit', w.head,
      ]),
      isShape({ status: isUnknown, output: isUnknown, receipt: isUnknown }),
      'the staged-changes outcome',
    );
    assert.equal(staged.status, 'added');
    assert.deepEqual(staged.output, { path: enriched, written: true });
    const { receipt } = expectType(
      staged,
      isShape({
        receipt: isShape({
          changes: isArrayOf(
            isShape({
              replacements: isArrayOf(isShape({ startLine: isUnknown, endLine: isUnknown, associated: isUnknown, explainedBy: isUnknown })),
            }),
          ),
        }),
      }),
      'a staged-changes receipt',
    );
    assert.deepEqual(
      present(receipt.changes[0], 'the receipt change').replacements.map((r) => [r.startLine, r.endLine, r.associated, r.explainedBy]),
      [
        [FINDING_A.line, FINDING_A.endLine, ['/runs/0/results/0'], 'finding'],
        [FINDING_B.line, FINDING_B.endLine, ['/runs/0/results/1'], 'finding'],
      ],
    );
    assertStagedFidelity(fs.readFileSync(enriched, 'utf8'));

    const after = expectType(jsonCli(['inspect', '--sarif', enriched, '--preview-lines', 'all']), isInspection, 'an inspection');
    assert.equal(after.view.summary.findings, 2, 'no finding added or lost');
    assert.deepEqual(after.view.findings.map((f) => f.message.text), [FINDING_A.message, FINDING_B.message]);
    const withFixes = expectType(
      after.view.findings,
      isArrayOf(
        isShape({
          fixes: isArrayOf(isShape({ changes: isArrayOf(isShape({ replacements: isArrayOf(isShape({ inserted: isShape({ text: isUnknown }) })) })) })),
        }),
      ),
      'findings with fix previews',
    );
    assert.deepEqual(
      withFixes.map((f) => f.fixes.map((x) => present(x.changes[0], 'a fix change').replacements.map((r) => r.inserted.text))),
      [[[`${FINDING_A.replacementLines.join('\n')}\n`]], [[`${FINDING_B.replacementLines.join('\n')}\n`]]],
    );
    const human = cli(['inspect', '--sarif', enriched]);
    assert.equal(human.status, 0, human.stderr);
    assert.ok(human.stdout.includes(FINDING_A.message) && human.stdout.includes(FINDING_B.message));

    const statePath = path.join(work, 'publication.json');
    const publishArgs = ['publish', '--sarif', enriched, '--repo', w.repoFlag, '--pull', w.pull, '--commit', w.head, '--state', statePath];
    const published = expectType(jsonCli(publishArgs), isShape({ status: isUnknown, message: isOptional(isString), statePath: isUnknown, review: isUnknown }), 'the publish outcome');
    assert.equal(published.status, 'published', published.message);
    assert.equal(published.statePath, statePath);
    assertOracleReview(w.host, w);
    const review = expectType(published.review, isShape({ url: isString }), 'the published review');
    assert.ok(review.url.endsWith(`#pullrequestreview-${String(present(w.host.reviews()[0], 'the stored review').id)}`));

    const again = expectType(jsonCli(publishArgs), isShape({ review: isUnknown }), 'the repeated publish outcome');
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
    const { enriched, receipt, review } = expectType(
      parseJson(result.stdout),
      isShape({ enriched: isUnknown, receipt: isShape({ boundRuns: isUnknown }), review: isShape({ id: isUnknown }) }),
      'the library workflow report',
    );
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
    const jsonCli = (args: readonly string[]): unknown => {
      const result = spawnSync(bin, [...args, '--format', 'json'], { cwd: consumer, env: w.env, encoding: 'utf8', timeout: 120_000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return parseJson(result.stdout);
    };

    const inspected = expectType(
      jsonCli(['inspect', '--sarif', UPSTREAM_SARIF_PATH]),
      isShape({ view: isShape({ runs: isArrayOf(isShape({ tool: isShape({ name: isUnknown }), source: isShape({ state: isUnknown }) })) }) }),
      'an inspection of runs',
    );
    assert.deepEqual(inspected.view.runs.map((r) => [r.tool.name, r.source.state]), [['Independent fixture producer', 'unbound']]);

    const staged = expectType(
      jsonCli([
        'add-staged-changes', '--sarif', UPSTREAM_SARIF_PATH, '--output', enriched, '--worktree', w.dir, '--repo', w.repoFlag, '--commit', w.head,
      ]),
      isShape({ receipt: isShape({ boundRuns: isUnknown }) }),
      'a staged-changes receipt',
    );
    assert.deepEqual(staged.receipt.boundRuns, [0]);
    const text = fs.readFileSync(enriched, 'utf8');
    assertStagedFidelity(text);

    // Only documented additions: fixes on the two findings and the run's source binding.
    const output = parseJson(text);
    const firstRun = (sarif: unknown): Record<string, unknown> =>
      asRecord(present(asArray(asRecord(sarif, 'a SARIF log')['runs'], 'its runs')[0], 'its first run'), 'a run');
    const strip = (sarif: unknown): unknown => {
      const copy = structuredClone(sarif);
      const run = firstRun(copy);
      delete run['versionControlProvenance'];
      for (const result of expectType(run['results'], isArrayOf(isRecord), 'the run results')) delete result['fixes'];
      return copy;
    };
    assert.deepEqual(strip(output), UPSTREAM, 'producer content, attribution and metadata are preserved');
    assert.deepEqual(firstRun(output)['versionControlProvenance'], [{ repositoryUri: `https://github.com/${w.repoFlag}`, revisionId: w.head }]);

    const published = expectType(
      jsonCli([
        'publish', '--sarif', enriched, '--repo', w.repoFlag, '--pull', w.pull, '--commit', w.head, '--state', path.join(work, 'state.json'),
      ]),
      isOutcome,
      'the publish outcome',
    );
    assert.equal(published.status, 'published', published.message);
    assertOracleReview(w.host, w);
    for (const comment of present(w.host.reviews()[0], 'the stored review').request.comments) {
      assert.ok(comment.body.includes('Independent fixture producer'), 'the upstream tool is credited');
    }
  });

  test('CLI correction: remove a mistaken finding by its selector, add the replacement, regenerate, publish', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const w = world('installed-correction-cli');
    const work = fs.mkdtempSync(path.join(w.root, 'artifacts-'));
    const authored = path.join(work, 'review.sarif');
    const enriched = path.join(work, 'enriched.sarif');
    const MISTAKE = 'MISTAKEN finding on the wrong line.';
    const cli = (args: readonly string[], expectedExit = 0): unknown => {
      const result = spawnSync(bin, [...args, '--format', 'json'], { cwd: consumer, env: w.env, encoding: 'utf8', timeout: 120_000 });
      assert.equal(result.status, expectedExit, result.stdout + result.stderr);
      assert.equal(result.stderr, '');
      return parseJson(result.stdout);
    };
    const isView = isShape({
      view: isShape({ findings: isArrayOf(isShape({ ref: isString, selector: isString, message: isShape({ text: isUnknown }) })) }),
    });
    const inspect = (file: string) => expectType(cli(['inspect', '--sarif', file]), isView, 'an inspection with selectors').view.findings;

    cli(['init', '--output', authored, '--tool-name', 'Review agent', '--repo', w.repoFlag, '--commit', w.head]);
    // The mistake: finding A's text on a line no staged change replaces.
    cli(['add-comment', '--sarif', authored, '--file', ORACLE.path, '--line', String(FINDING_B.endLine + 1), '--message', MISTAKE]);
    cli(['add-comment', '--sarif', authored, '--file', ORACLE.path, '--line', String(FINDING_B.line), '--end-line', String(FINDING_B.endLine), '--message', FINDING_B.message]);
    const staleEnriched = cli(['add-staged-changes', '--sarif', authored, '--output', enriched, '--worktree', w.dir, '--repo', w.repoFlag, '--commit', w.head]);
    assert.equal(expectType(staleEnriched, isOutcome, 'the first staged outcome').status, 'added');

    const [mistaken, kept] = inspect(authored);
    assert.equal(present(mistaken, 'the mistaken finding').message.text, MISTAKE);
    const removal = expectType(
      cli(['remove-comment', '--sarif', authored, '--finding', present(mistaken, 'the mistaken finding').selector]),
      isShape({ status: isUnknown, sarif: isUnknown, finding: isUnknown }),
      'the removal outcome',
    );
    assert.equal(removal.status, 'removed');
    assert.deepEqual(removal.sarif, { path: authored, written: true });
    assert.deepEqual(removal.finding, { ref: '/runs/0/results/0', runIndex: 0, resultIndex: 0, tool: 'Review agent', fixes: 0, fileProposals: 0 });
    assert.deepEqual(inspect(authored).map((f) => f.message.text), [FINDING_B.message], 'only the selected finding is gone');

    const again = expectType(
      cli(['remove-comment', '--sarif', authored, '--finding', present(mistaken, 'the mistaken finding').selector], 2),
      isOutcome,
      'the stale outcome',
    );
    assert.equal(again.status, 'stale', 'the old selector no longer deletes the finding now at its position');
    assert.deepEqual(inspect(authored).map((f) => f.message.text), [FINDING_B.message]);
    assert.notEqual(present(kept, 'the kept finding').selector, present(inspect(authored)[0], 'the kept finding now').selector);

    cli(['add-comment', '--sarif', authored, '--file', ORACLE.path, '--line', String(FINDING_A.line), '--message', FINDING_A.message]);
    const regenerated = expectType(
      cli(['add-staged-changes', '--sarif', authored, '--output', enriched, '--worktree', w.dir, '--repo', w.repoFlag, '--commit', w.head]),
      isShape({ status: isUnknown, archived: isShape({ path: isString }) }),
      'the regenerated staged outcome',
    );
    assert.equal(regenerated.status, 'added');
    assert.ok(fs.readFileSync(regenerated.archived.path, 'utf8').includes(MISTAKE), 'the earlier enriched artifact is preserved, not edited');
    const text = fs.readFileSync(enriched, 'utf8');
    assert.ok(!text.includes(MISTAKE), 'the regenerated artifact reflects the correction');
    assertStagedFidelity(text);

    const published = expectType(
      cli(['publish', '--sarif', enriched, '--repo', w.repoFlag, '--pull', w.pull, '--commit', w.head, '--state', path.join(work, 'state.json')]),
      isOutcome,
      'the publish outcome',
    );
    assert.equal(published.status, 'published', published.message);
    assertOracleReview(w.host, w);
    assert.ok(!JSON.stringify(w.host.reviews()).includes(MISTAKE), 'the removed finding is never published');
  });

  test('library correction: the same in memory through the installed functions', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const w = world('installed-correction-library');
    const js = String.raw;
    const script = js`
      import assert from 'node:assert/strict';
      import { createSarifDocument, addSarifComment, removeSarifComment, inspectSarif, addStagedChangesToSarif, publishSarifReview } from 'sarif-to-comment';
      const oracle = JSON.parse(process.env.ORACLE);
      const [A, B] = oracle.findings;
      const [owner, repo] = process.env.REVIEW_REPOSITORY.split('/');
      const reviewedCommit = process.env.REVIEW_COMMIT;
      const MISTAKE = 'MISTAKEN finding on the wrong line.';

      let sarif = createSarifDocument({ tool: { name: 'Review agent' }, source: { owner, repo, commit: reviewedCommit } });
      sarif = addSarifComment(sarif, { file: oracle.path, line: B.endLine + 1, message: MISTAKE }).sarif;
      sarif = addSarifComment(sarif, { file: oracle.path, line: B.line, endLine: B.endLine, message: B.message }).sarif;

      const [mistaken] = inspectSarif(sarif).view.findings;
      const authored = sarif;
      const removal = removeSarifComment(sarif, mistaken.selector);
      assert.equal(removal.status, 'removed', removal.markdown);
      assert.equal(authored.runs[0].results.length, 2, 'the input document is unchanged');
      sarif = removal.sarif;
      assert.equal(removeSarifComment(sarif, mistaken.selector).status, 'stale');
      sarif = addSarifComment(sarif, { file: oracle.path, line: A.line, message: A.message }).sarif;

      const staged = await addStagedChangesToSarif({ sarif, worktree: process.env.WORKTREE, reviewedCommit, repository: { owner, repo } });
      assert.equal(staged.status, 'added', staged.markdown);
      const outcome = await publishSarifReview({
        sarif: staged.sarif,
        destination: { owner, repo, pullNumber: Number(process.env.REVIEW_PULL) },
        reviewedCommit,
        statePath: process.env.REVIEW_STATE,
        token: process.env.GH_TOKEN,
      });
      assert.equal(outcome.status, 'published', outcome.markdown);
      process.stdout.write(JSON.stringify({ enriched: staged.sarif, removed: removal.finding }));
    `;
    const file = path.join(consumer, 'library-correction.mjs');
    fs.writeFileSync(file, script);
    const env = {
      ...w.env,
      ORACLE: JSON.stringify(ORACLE),
      REVIEW_REPOSITORY: w.repoFlag,
      REVIEW_COMMIT: w.head,
      REVIEW_PULL: w.pull,
      REVIEW_STATE: path.join(w.root, 'library-correction.json'),
      WORKTREE: w.dir,
    };
    const result = spawnSync(process.execPath, [file], { cwd: consumer, env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = expectType(parseJson(result.stdout), isShape({ enriched: isUnknown, removed: isUnknown }), 'the library correction report');
    assert.deepEqual(report.removed, { ref: '/runs/0/results/0', runIndex: 0, resultIndex: 0, tool: 'Review agent', fixes: 0, fileProposals: 0 });
    assertStagedFidelity(JSON.stringify(report.enriched));
    assertOracleReview(w.host, w);
    assert.ok(!JSON.stringify(w.host.reviews()).includes('MISTAKEN'), 'the removed finding is never published');
  });

  test('ready upstream SARIF publishes directly, with no authoring or staged step', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const w = world('installed-direct');
    const ready = expectType(
      structuredClone(UPSTREAM),
      isShape({ runs: isArrayOf(isShape({ results: isArrayOf(isRecord) })) }),
      'upstream SARIF with results',
    );
    const [a, b] = present(ready.runs[0], 'the upstream run').results;
    const fix = (line: number, endLine: number, text: string): unknown[] => [
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
    present(a, 'upstream finding A')['fixes'] = fix(FINDING_A.line, FINDING_A.endLine, `${FINDING_A.replacementLines.join('\n')}\n`);
    present(b, 'upstream finding B')['fixes'] = fix(FINDING_B.line, FINDING_B.endLine, `${FINDING_B.replacementLines.join('\n')}\n`);
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
