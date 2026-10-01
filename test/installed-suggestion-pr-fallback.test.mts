/**
 * User acceptance of the suggestion pull request fallback (issue #37)
 * through the *installed* package (the tarball `npm pack` produces, installed
 * into a clean consumer by test/fixtures/package/installed-package.mts). Only
 * public surfaces are used: the linked `sarif-to-comment` executable and
 * `require('sarif-to-comment')`, against the rewritten-history fake GitHub
 * (test/fixtures/rewritten-history), reached through a preload that replaces
 * only `fetch`.
 *
 * After a rewritten history, a whole-file deletion that cannot be re-applied
 * is published as a review-body proposal with a `suggestion-pr-fallback`
 * warning and a headline, and a group that cannot be re-applied refuses the
 * review with `suggestion-group-pr-unavailable`, writing nothing. A retry
 * with the same state path reports the same warning, in JSON and in human
 * form (issue #42).
 *
 * @see https://github.com/mike-north/sarif-to-comment/issues/37
 * @see https://github.com/mike-north/sarif-to-comment/issues/42
 * @see docs/companion-suggestion-pr-contract.md §2.5.1
 * @see docs/diagnostics.md
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { ROOT, installIntoConsumer, packProject } from './fixtures/package/installed-package.mts';
import { DROPPED, OWNER, PULL, REPO, REVIEWED, REWRITTEN, TOKEN, documentWith, makeWorld, writes } from './fixtures/rewritten-history/world.mts';
import type { IWorld } from './fixtures/rewritten-history/world.mts';
import { asArray, asRecord, asString, parseJson } from './support/runtime-types.mts';

const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'docs', 'fake-fetch-preload.mts');

/** The environment that points the installed package's `fetch` at `world`'s fake GitHub. */
function envFor(world: IWorld): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'], GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: world.host.dir, NODE_OPTIONS: `--require=${PRELOAD}` };
}

const FALLBACK_MESSAGE = 'Suggestion pull requests are allowed, but the deletion of `obsolete.txt` is not proposed as one: the history of #7 was rewritten after the reviewed commit, '
  + `and it cannot be re-applied onto commit \`${DROPPED}\` because \`obsolete.txt\` no longer exists. `
  + 'It is handled as if suggestion pull requests were not allowed: the review body proposes it, with its findings.';
const PUBLISHED_HEADLINE = '**Published with 1 warning:** 1 suggestion pull request was not created; its change is shown in the review.';

describe('the installed package falls back, or refuses a group, after a rewritten history (#37)', () => {
  const skip = packProject().error || false;

  test('CLI: a deletion falls back with a structured warning; a group is refused with nothing written', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const run = (world: IWorld, args: readonly string[]): SpawnSyncReturns<string> => {
      const result = spawnSync(bin, args, { cwd: consumer, env: envFor(world), encoding: 'utf8', timeout: 120_000 });
      for (const text of [result.stdout, result.stderr]) assert.ok(!text.includes(TOKEN), 'the token never appears');
      return result;
    };
    const flags = (world: IWorld, parts: Parameters<typeof documentWith>[0]): string[] => {
      const file = path.join(world.root, 'review.sarif');
      fs.writeFileSync(file, JSON.stringify(documentWith(parts)));
      return ['--sarif', file, '--repo', `${OWNER}/${REPO}`, '--pull', String(PULL), '--commit', REVIEWED, '--allow-suggestion-prs'];
    };

    // validate first: once published, the review is this account's pending review.
    const fallbackWorld = makeWorld(DROPPED);
    const human = run(fallbackWorld, ['validate', ...flags(fallbackWorld, ['delete', 'remark'])]);
    assert.equal(human.status, 0, human.stdout + human.stderr);
    assert.ok(human.stdout.startsWith('## Ready to publish\n\n**Ready to publish with 1 warning:** '), human.stdout);
    assert.ok(human.stderr.startsWith('▲ warning  A change is handled as if suggestion pull requests were not allowed  [suggestion-pr-fallback]\n'), human.stderr);
    assert.ok(human.stderr.endsWith('\n1 warning\n'), human.stderr);

    const published = run(fallbackWorld, ['publish', ...flags(fallbackWorld, ['delete', 'remark']), '--state', fallbackWorld.statePath, '--format', 'json']);
    assert.equal(published.status, 0, published.stdout + published.stderr);
    const doc = asRecord(parseJson(published.stdout));
    assert.equal(doc['status'], 'published');
    assert.ok(asString(doc['message']).includes(PUBLISHED_HEADLINE), asString(doc['message']));
    const [warning, ...more] = asArray(doc['diagnostics']).map((d) => asRecord(d));
    assert.ok(warning && more.length === 0, 'exactly one diagnostic');
    assert.equal(warning['code'], 'suggestion-pr-fallback');
    assert.equal(warning['severity'], 'warning');
    assert.equal(warning['message'], FALLBACK_MESSAGE);
    assert.deepEqual(fallbackWorld.host.pulls(), []);

    // Issue #42: a retry with the same state path reports the same warning, in every format.
    const retried = run(fallbackWorld, ['publish', ...flags(fallbackWorld, ['delete', 'remark']), '--state', fallbackWorld.statePath, '--format', 'json']);
    assert.equal(retried.status, 0, retried.stdout + retried.stderr);
    const retriedDoc = asRecord(parseJson(retried.stdout));
    assert.equal(retriedDoc['status'], 'published');
    assert.deepEqual(retriedDoc['review'], doc['review']);
    assert.deepEqual(retriedDoc['diagnostics'], doc['diagnostics']);
    assert.ok(asString(retriedDoc['message']).startsWith(`## Draft review published\n\n${PUBLISHED_HEADLINE}\n\nThe draft [review `), asString(retriedDoc['message']));
    const retriedHuman = run(fallbackWorld, ['publish', ...flags(fallbackWorld, ['delete', 'remark']), '--state', fallbackWorld.statePath]);
    assert.equal(retriedHuman.status, 0, retriedHuman.stdout + retriedHuman.stderr);
    assert.ok(retriedHuman.stdout.startsWith(`## Draft review published\n\n${PUBLISHED_HEADLINE}\n\n`), retriedHuman.stdout);
    assert.ok(retriedHuman.stderr.startsWith('▲ warning  A change is handled as if suggestion pull requests were not allowed  [suggestion-pr-fallback]\n'), retriedHuman.stderr);
    assert.ok(retriedHuman.stderr.endsWith('\n1 warning\n'), retriedHuman.stderr);
    assert.equal(fallbackWorld.host.reviews().length, 1, 'the retries sent nothing');

    const refusedWorld = makeWorld(REWRITTEN);
    const refused = run(refusedWorld, ['publish', ...flags(refusedWorld, ['reword', 'remark']), '--state', refusedWorld.statePath, '--format', 'json']);
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    const refusal = asRecord(parseJson(refused.stdout));
    assert.equal(refusal['status'], 'blocked');
    assert.deepEqual(asArray(refusal['diagnostics']).map((d) => asRecord(d)['code']), ['suggestion-group-pr-unavailable']);
    assert.deepEqual(writes(refusedWorld), []);
    assert.equal(fs.existsSync(refusedWorld.statePath), false);
  });

  test('library: publishSarifReview and validateSarifReview report the same fallback warning; a group is blocked', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const fallbackWorld = makeWorld(DROPPED);
    const refusedWorld = makeWorld(REWRITTEN);
    const input = (world: IWorld, parts: Parameters<typeof documentWith>[0], withState: boolean): string => JSON.stringify({
      sarif: documentWith(parts),
      destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
      reviewedCommit: REVIEWED,
      options: { allowSuggestionPullRequests: true },
      ...(withState ? { statePath: world.statePath } : {}),
    });
    const script = (world: IWorld, operation: string, json: string): Record<string, unknown> => {
      const file = path.join(consumer, `${operation}-${path.basename(world.root)}.cjs`);
      fs.writeFileSync(file, [
        `const library = require('sarif-to-comment');`,
        `library.${operation}({ ...${json}, token: process.env.GH_TOKEN })`,
        '  .then((outcome) => process.stdout.write(JSON.stringify(outcome)), (err) => { console.error(err); process.exit(1); });',
        '',
      ].join('\n'));
      const result = spawnSync(process.execPath, [file], { cwd: consumer, env: envFor(world), encoding: 'utf8', timeout: 120_000 });
      assert.equal(result.status, 0, result.stderr);
      return asRecord(parseJson(result.stdout));
    };

    const assessed = script(fallbackWorld, 'validateSarifReview', input(fallbackWorld, ['delete', 'remark'], false));
    assert.equal(assessed['status'], 'ready');
    const published = script(fallbackWorld, 'publishSarifReview', input(fallbackWorld, ['delete', 'remark'], true));
    assert.equal(published['status'], 'published');
    assert.deepEqual(published['diagnostics'], assessed['diagnostics'], 'validate reports what publish does');
    const [warning] = asArray(published['diagnostics']).map((d) => asRecord(d));
    assert.ok(warning);
    assert.equal(warning['code'], 'suggestion-pr-fallback');
    assert.equal(warning['message'], FALLBACK_MESSAGE);
    assert.ok(asString(published['markdown']).startsWith(`## Draft review published\n\n${PUBLISHED_HEADLINE}\n\n`), asString(published['markdown']));

    const blocked = script(refusedWorld, 'validateSarifReview', input(refusedWorld, ['reword', 'remark'], false));
    assert.equal(blocked['status'], 'blocked');
    assert.deepEqual(asArray(blocked['problems']).map((p) => asRecord(p)['code']), ['suggestion-group-pr-unavailable']);
    assert.deepEqual(writes(refusedWorld), []);
  });
});
