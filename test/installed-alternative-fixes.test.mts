/**
 * User acceptance of a finding that offers alternative fixes, through the
 * *installed* package (the tarball `npm pack` produces, installed into a
 * clean consumer by test/fixtures/package/installed-package.mts). Only public
 * surfaces are used: the linked `sarif-to-comment` executable and
 * `import … from 'sarif-to-comment'`.
 *
 * An upstream producer's SARIF (written to disk as a tool would) carries one
 * finding with three fixes. Both the CLI and the library run inspect →
 * validate → publish against a fake GitHub that speaks HTTP to the product's
 * real client (the preload replaces only `fetch`). The first fix becomes the
 * native suggestion; the other two are listed in the same comment as
 * alternatives (owner decision on issue #30). Before this change the whole
 * review was refused.
 *
 * The expected comment is written by hand from
 * docs/review-presentation-contract.md §2–§4 and the fixture bytes below.
 *
 * @see ../docs/review-presentation-contract.md
 * @see https://github.com/mike-north/sarif-to-comment/issues/30
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
import { ROOT, installIntoConsumer, packProject } from './fixtures/package/installed-package.mts';
import { asRecord, expectType, isShape, isUnknown, parseJson } from './support/runtime-types.mts';

const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'docs', 'fake-fetch-preload.mts');
const TOKEN = 'ghp_ALTERNATIVE_FIXES_installed_0123456789';
const DESTINATION = { owner: 'octo', repo: 'parsers', pullNumber: 30 } as const;
const BASE = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e';
const HEAD = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';

const REPOSITORY: IHttpRepository = {
  destination: DESTINATION,
  commits: { base: BASE, head: HEAD },
  snapshots: {
    [BASE]: { 'src/app.js': ['const a = 1;\n', 'const b = oldParse(input);\n', 'const c = 3;\n'], 'src/other.js': ['export const parse = parseA;\n'] },
    [HEAD]: { 'src/app.js': ['const a = 1;\n', 'const b = parseA(input);\n', 'const c = 3;\n'], 'src/other.js': ['export const parse = parseA;\n'] },
  },
  pullFiles: [{
    filename: 'src/app.js', status: 'modified', additions: 1, deletions: 1,
    patch: ['@@ -1,3 +1,3 @@\n', ' const a = 1;\n', '-const b = oldParse(input);\n', '+const b = parseA(input);\n', ' const c = 3;'],
  }],
};

const lineFix = (uri: string, line: number, text: string, description?: string): Record<string, unknown> => ({
  ...(description === undefined ? {} : { description: { text: description } }),
  artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion: { startLine: line }, insertedContent: { text } }] }],
});

/** An upstream tool's SARIF: one finding on line 2 with three fixes, in the producer's order. */
const SARIF = {
  version: '2.1.0',
  runs: [{
    tool: { driver: { name: 'Parser advisor', version: '2.0.0' } },
    columnKind: 'utf16CodeUnits',
    versionControlProvenance: [{ repositoryUri: `https://github.com/${DESTINATION.owner}/${DESTINATION.repo}`, revisionId: HEAD }],
    results: [{
      ruleId: 'slow-parse',
      message: { text: 'parseA is slow on large inputs.' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'src/app.js' }, region: { startLine: 2 } } }],
      fixes: [
        lineFix('src/app.js', 2, 'const b = parseB(input);', 'Use parseB.'),
        lineFix('src/app.js', 2, 'const b = md`\n```js\nparseA(input)\n```\n`;', 'Document the call instead.'),
        lineFix('src/other.js', 1, 'export const parse = parseB;', 'Switch the shared parser.'),
      ],
    }],
  }],
};

/** The one inline comment the review must carry (written by hand). */
const EXPECTED_COMMENT = [
  'parseA is slow on large inputs.',
  '',
  '**Fix:** Use parseB.',
  '',
  '**Alternatives to consider:**',
  '',
  '(1) Document the call instead.',
  '',
  'Replace line 2 with:',
  '',
  '````',
  'const b = md`',
  '```js',
  'parseA(input)',
  '```',
  '`;',
  '````',
  '',
  '(2) Switch the shared parser.',
  '',
  'Replace line 1 of `src/other.js` with:',
  '',
  '```',
  'export const parse = parseB;',
  '```',
  '',
  '<sub>— Parser advisor 2.0.0 · rule `slow-parse`</sub>',
  '',
  '```suggestion',
  'const b = parseB(input);',
  '```',
].join('\n');

interface IWorld {
  readonly root: string;
  readonly sarifPath: string;
  readonly host: FakeHttpGitHub;
  readonly env: NodeJS.ProcessEnv;
}

function world(label: string): IWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const hostDir = path.join(root, 'host');
  FakeHttpGitHub.create(hostDir, {}, REPOSITORY);
  const sarifPath = path.join(root, 'advisor.sarif');
  fs.writeFileSync(sarifPath, JSON.stringify(SARIF, null, 2));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'], HOME: root, GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: hostDir, NODE_OPTIONS: `--require=${PRELOAD}`,
  };
  return { root, sarifPath, host: new FakeHttpGitHub(hostDir, TOKEN), env };
}

/** The one stored review: a draft on the reviewed commit whose one comment is the suggestion with its alternatives. */
function assertPublished(w: IWorld): void {
  const reviews = w.host.reviews();
  assert.equal(reviews.length, 1);
  const [stored] = reviews;
  assert.ok(stored);
  assert.equal(stored.state, 'PENDING');
  assert.equal(stored.request.commit_id, HEAD);
  assert.equal(stored.request.comments.length, 1);
  const [comment] = stored.request.comments;
  assert.ok(comment);
  assert.deepEqual([comment.path, comment.side, comment.line], ['src/app.js', 'RIGHT', 2]);
  assert.equal(comment.body, EXPECTED_COMMENT);
  assert.ok(w.host.log().every((r) => r.authorized));
}

describe('the installed package publishes a finding that offers alternative fixes', () => {
  const skip = packProject().error || false;

  test('CLI: inspect lists every fix, validate is ready and publish lists the alternatives', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const w = world('installed-alternatives-cli');
    const cli = (args: readonly string[]): unknown => {
      const result: SpawnSyncReturns<string> = spawnSync(bin, [...args, '--format', 'json'], { cwd: consumer, env: w.env, encoding: 'utf8', timeout: 120_000 });
      for (const text of [result.stdout, result.stderr]) assert.ok(!text.includes(TOKEN), 'the token never appears');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return parseJson(result.stdout);
    };
    const inspected = expectType(cli(['inspect', '--sarif', w.sarifPath]), isShape({ view: isShape({ summary: isShape({ fixes: isUnknown }) }) }), 'inspection');
    assert.equal(inspected.view.summary.fixes, 3);

    const flags = ['--sarif', w.sarifPath, '--repo', `${DESTINATION.owner}/${DESTINATION.repo}`, '--pull', String(DESTINATION.pullNumber), '--commit', HEAD];
    assert.equal(asRecord(cli(['validate', ...flags]), 'validate')['status'], 'ready');
    assert.equal(w.host.reviews().length, 0);
    assert.equal(asRecord(cli(['publish', ...flags, '--state', path.join(w.root, 'state.json')]), 'publish')['status'], 'published');
    assertPublished(w);
  });

  test('library: the same flow through the installed functions', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const w = world('installed-alternatives-library');
    const js = String.raw;
    const script = js`
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { inspectSarif, validateSarifReview, publishSarifReview } from 'sarif-to-comment';
      const sarif = JSON.parse(readFileSync(process.env.SARIF_PATH, 'utf8'));
      const inspection = inspectSarif(sarif);
      assert.equal(inspection.status, 'inspected');
      assert.deepEqual(inspection.view.findings[0].fixes.map((f) => f.ref), ['/runs/0/results/0/fixes/0', '/runs/0/results/0/fixes/1', '/runs/0/results/0/fixes/2']);
      const input = { sarif, destination: { owner: 'octo', repo: 'parsers', pullNumber: 30 }, reviewedCommit: process.env.REVIEW_COMMIT, token: process.env.GH_TOKEN };
      const assessed = await validateSarifReview(input);
      assert.equal(assessed.status, 'ready', assessed.markdown);
      const outcome = await publishSarifReview({ ...input, statePath: process.env.REVIEW_STATE });
      assert.equal(outcome.status, 'published', outcome.markdown);
      process.stdout.write(JSON.stringify({ status: outcome.status }));
    `;
    const file = path.join(consumer, 'alternative-fixes-library.mjs');
    fs.writeFileSync(file, script);
    const env = { ...w.env, SARIF_PATH: w.sarifPath, REVIEW_COMMIT: HEAD, REVIEW_STATE: path.join(w.root, 'library-state.json') };
    const result = spawnSync(process.execPath, [file], { cwd: consumer, env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN));
    assertPublished(w);
  });
});
