/**
 * User acceptance of historical placement and the reviewed commit's
 * association through the *installed* package (the tarball `npm pack`
 * produces, installed into a clean consumer by
 * test/fixtures/package/installed-package.mts). Only public surfaces are
 * used: the linked `sarif-to-comment` executable and
 * `require('sarif-to-comment')`, against the historical-placement fake GitHub
 * (test/fixtures/historical-placement), reached through a preload that
 * replaces only `fetch`.
 *
 * A review of a commit a force-push discarded publishes its findings and its
 * native suggestion inline at that commit; a review of a commit outside the
 * pull request is refused with exit status 2 and nothing written.
 *
 * @see docs/specification.md (R13.1, R17)
 * @see docs/evidence/realignment/e1-e3-readme.md
 * @see docs/diagnostics.md
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { ROOT, installIntoConsumer, packProject } from './fixtures/package/installed-package.mts';
import {
  DISCARDED_R,
  OWNER,
  PULL,
  REPO,
  SAMPLE,
  TOKEN,
  UNRELATED,
  document,
  finding,
  lineFix,
  makeWorld,
  writes,
} from './fixtures/historical-placement/world.mts';
import type { IWorld } from './fixtures/historical-placement/world.mts';
import { asArray, asRecord, parseJson } from './support/runtime-types.mts';

const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'docs', 'fake-fetch-preload.mts');

/** The environment that points the installed package's `fetch` at `world`'s fake GitHub. */
function envFor(world: IWorld): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'], GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: world.host.dir, NODE_OPTIONS: `--require=${PRELOAD}` };
}

describe('the installed package reviews a commit that is no longer the head (R13.1, R17)', () => {
  const skip = packProject().error || false;

  test('CLI: inline at a discarded commit, exit 0; a commit outside the pull request, exit 2 with nothing written', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const run = (world: IWorld, args: readonly string[]): SpawnSyncReturns<string> => {
      const result = spawnSync(bin, args, { cwd: consumer, env: envFor(world), encoding: 'utf8', timeout: 120_000 });
      for (const text of [result.stdout, result.stderr]) assert.ok(!text.includes(TOKEN), 'the token never appears');
      return result;
    };
    const sarif = document([
      finding('Line 2 context.', SAMPLE, 2),
      finding('Reword line 6.', SAMPLE, 6, { fixes: [lineFix(SAMPLE, 6, 'Line 06: suggested.')] }),
    ]);
    const flags = (world: IWorld, commit: string): string[] => {
      const file = path.join(world.root, 'review.sarif');
      fs.writeFileSync(file, JSON.stringify(sarif));
      return ['--sarif', file, '--repo', `${OWNER}/${REPO}`, '--pull', String(PULL), '--commit', commit, '--state', world.statePath, '--format', 'json'];
    };

    const discarded = makeWorld('discarded');
    const published = run(discarded, ['publish', ...flags(discarded, DISCARDED_R)]);
    assert.equal(published.status, 0, published.stdout + published.stderr);
    assert.equal(asRecord(parseJson(published.stdout))['status'], 'published');
    const reviews = discarded.host.reviews();
    assert.equal(reviews.length, 1);
    const [review] = reviews;
    assert.ok(review);
    assert.equal(review.request.commit_id, DISCARDED_R);
    assert.deepEqual(review.request.comments.map((c) => [c.path, c.side, c.line]), [[SAMPLE, 'RIGHT', 2], [SAMPLE, 'RIGHT', 6]]);
    assert.ok(review.request.comments[1]?.body.endsWith('```suggestion\nLine 06: suggested.\n```'));

    const unrelated = makeWorld('discarded');
    const refused = run(unrelated, ['publish', ...flags(unrelated, UNRELATED)]);
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    const doc = asRecord(parseJson(refused.stdout));
    assert.equal(doc['status'], 'blocked');
    assert.deepEqual(asArray(doc['diagnostics']).map((d) => asRecord(d)['code']), ['reviewed-commit-not-in-pull-request']);
    assert.deepEqual(writes(unrelated), []);
    assert.equal(fs.existsSync(unrelated.statePath), false);
  });

  test('library: validateSarifReview answers ready at a discarded commit and blocked outside the pull request', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const script = path.join(consumer, 'assess.cjs');
    fs.writeFileSync(script, `const { validateSarifReview } = require('sarif-to-comment');
const [sarif, commit] = [JSON.parse(process.argv[2]), process.argv[3]];
validateSarifReview({ sarif, destination: { owner: ${JSON.stringify(OWNER)}, repo: ${JSON.stringify(REPO)}, pullNumber: ${String(PULL)} }, reviewedCommit: commit, token: process.env.GH_TOKEN })
  .then((outcome) => process.stdout.write(JSON.stringify({ status: outcome.status, codes: outcome.diagnostics.map((d) => d.code) })));
`);
    const sarif = JSON.stringify(document([finding('Line 5.', SAMPLE, 5)]));
    const world = makeWorld('discarded');
    const assess = (commit: string): unknown => {
      const result = spawnSync(process.execPath, [script, sarif, commit], { cwd: consumer, env: envFor(world), encoding: 'utf8', timeout: 120_000 });
      assert.equal(result.status, 0, result.stderr);
      return parseJson(result.stdout);
    };
    assert.deepEqual(assess(DISCARDED_R), { status: 'ready', codes: [] });
    assert.deepEqual(assess(UNRELATED), { status: 'blocked', codes: ['reviewed-commit-not-in-pull-request'] });
    assert.deepEqual(writes(world), []);
  });
});
