/**
 * User acceptance of the delivery policy through the *installed* package
 * (the tarball `npm pack` produces, installed into a clean consumer by
 * test/fixtures/package/installed-package.mts). Only public surfaces are
 * used: the linked `sarif-to-comment` executable and
 * `require('sarif-to-comment')`, against the rewritten-history fake GitHub
 * (test/fixtures/rewritten-history), reached through a preload that replaces
 * only `fetch`.
 *
 * After a rewritten history, a whole-file deletion whose companion pull
 * request cannot be re-applied is delivered by the next mechanism its list
 * names, `--file-operations companion,manual`: the review body proposes it,
 * with a `delivery-fallback` warning and a headline, and a retry with the
 * same state path reports the same warning (issue #42). A group whose only
 * listed mechanism is unavailable (`--grouped-edits companion`) blocks the
 * review with `delivery-unavailable` and exit status 2, writing nothing.
 * Help documents the delivery flags.
 *
 * @see docs/delivery-policy-contract.md §10
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

const REWRITTEN_DELETION = `The history of #7 was rewritten after the reviewed commit, and it cannot be re-applied onto commit \`${DROPPED}\` because \`obsolete.txt\` no longer exists.`;
const FALLBACK_MESSAGE = 'The deletion of `obsolete.txt` is delivered as `manual`. `fileOperations` is `[companion, manual]`, set by the caller (`--file-operations`, `delivery.fileOperations`), '
  + `and the mechanisms listed before it are unavailable:\n\n- \`companion\`: ${REWRITTEN_DELETION}`;
const LIBRARY_FALLBACK_MESSAGE = FALLBACK_MESSAGE;
const GROUP_UNAVAILABLE = 'The group `reword` cannot be delivered. `groupedEdits` is `[companion]`, set by the caller (`--grouped-edits`, `delivery.groupedEdits`), and no mechanism it lists is available:\n\n'
  + `- \`companion\`: The history of #7 was rewritten after the reviewed commit, and its 2 changes cannot be re-applied onto commit \`${REWRITTEN}\` because \`docs/sample.md\` line 6 differs from the reviewed text.`;
const PUBLISHED_HEADLINE = '**Published with 1 warning:** A proposal is delivered by a later mechanism of its delivery list.';
const WARNING_BLOCK = '▲ warning  A proposal is delivered by a later mechanism of its delivery list  [delivery-fallback]\n';

describe('the installed package follows the delivery policy', () => {
  const skip = packProject().error || false;

  test('CLI: help names the delivery flags; a listed fallback is announced; a strict list blocks with exit 2', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const run = (world: IWorld, args: readonly string[]): SpawnSyncReturns<string> => {
      const result = spawnSync(bin, args, { cwd: consumer, env: envFor(world), encoding: 'utf8', timeout: 120_000 });
      for (const text of [result.stdout, result.stderr]) assert.ok(!text.includes(TOKEN), 'the token never appears');
      return result;
    };
    const flags = (world: IWorld, parts: Parameters<typeof documentWith>[0], delivery: readonly string[]): string[] => {
      const file = path.join(world.root, 'review.sarif');
      fs.writeFileSync(file, JSON.stringify(documentWith(parts)));
      return ['--sarif', file, '--repo', `${OWNER}/${REPO}`, '--pull', String(PULL), '--commit', REVIEWED, ...delivery];
    };

    const helpWorld = makeWorld(DROPPED);
    const help = run(helpWorld, ['publish', '--help']);
    assert.equal(help.status, 0, help.stderr);
    for (const flag of ['--delivery', '--edits', '--grouped-edits', '--file-operations', '--companion-bundle']) assert.ok(help.stdout.includes(flag), flag);
    assert.equal(help.stdout.includes('--allow-suggestion-prs'), false);
    const removed = run(helpWorld, ['validate', ...flags(helpWorld, ['remark'], ['--allow-suggestion-prs'])]);
    assert.equal(removed.status, 1, removed.stdout + removed.stderr);
    assert.ok(removed.stderr.includes('unknown option --allow-suggestion-prs'), removed.stderr);

    // validate first: once published, the review is this account's pending review.
    const fallbackWorld = makeWorld(DROPPED);
    const companionOrManual = ['--file-operations', 'companion,manual'];
    const human = run(fallbackWorld, ['validate', ...flags(fallbackWorld, ['delete', 'remark'], companionOrManual)]);
    assert.equal(human.status, 0, human.stdout + human.stderr);
    assert.ok(human.stdout.startsWith('## Ready to publish\n\n**Ready to publish with 1 warning:** A proposal is delivered by a later mechanism of its delivery list.\n'), human.stdout);
    assert.ok(human.stderr.startsWith(WARNING_BLOCK), human.stderr);
    assert.ok(human.stderr.endsWith('\n1 warning\n'), human.stderr);

    const published = run(fallbackWorld, ['publish', ...flags(fallbackWorld, ['delete', 'remark'], companionOrManual), '--state', fallbackWorld.statePath, '--format', 'json']);
    assert.equal(published.status, 0, published.stdout + published.stderr);
    const doc = asRecord(parseJson(published.stdout));
    assert.equal(doc['status'], 'published');
    assert.ok(asString(doc['message']).includes(PUBLISHED_HEADLINE), asString(doc['message']));
    const [warning, ...more] = asArray(doc['diagnostics']).map((d) => asRecord(d));
    assert.ok(warning && more.length === 0, 'exactly one diagnostic');
    assert.equal(warning['code'], 'delivery-fallback');
    assert.equal(warning['severity'], 'warning');
    assert.equal(warning['message'], FALLBACK_MESSAGE);
    assert.deepEqual(fallbackWorld.host.pulls(), []);

    // Issue #42: a retry with the same state path reports the same warning, in every format.
    const retried = run(fallbackWorld, ['publish', ...flags(fallbackWorld, ['delete', 'remark'], companionOrManual), '--state', fallbackWorld.statePath, '--format', 'json']);
    assert.equal(retried.status, 0, retried.stdout + retried.stderr);
    const retriedDoc = asRecord(parseJson(retried.stdout));
    assert.equal(retriedDoc['status'], 'published');
    assert.deepEqual(retriedDoc['review'], doc['review']);
    assert.deepEqual(retriedDoc['diagnostics'], doc['diagnostics']);
    const retriedHuman = run(fallbackWorld, ['publish', ...flags(fallbackWorld, ['delete', 'remark'], companionOrManual), '--state', fallbackWorld.statePath]);
    assert.equal(retriedHuman.status, 0, retriedHuman.stdout + retriedHuman.stderr);
    assert.ok(retriedHuman.stdout.startsWith(`## Draft review published\n\n${PUBLISHED_HEADLINE}\n\n`), retriedHuman.stdout);
    assert.ok(retriedHuman.stderr.startsWith(WARNING_BLOCK), retriedHuman.stderr);
    assert.equal(fallbackWorld.host.reviews().length, 1, 'the retries sent nothing');

    const refusedWorld = makeWorld(REWRITTEN);
    const refused = run(refusedWorld, ['publish', ...flags(refusedWorld, ['reword', 'remark'], ['--grouped-edits', 'companion']), '--state', refusedWorld.statePath, '--format', 'json']);
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    const refusal = asRecord(parseJson(refused.stdout));
    assert.equal(refusal['status'], 'blocked');
    assert.deepEqual(asArray(refusal['diagnostics']).map((d) => asRecord(d)['message']), [GROUP_UNAVAILABLE]);
    assert.deepEqual(writes(refusedWorld), []);
    assert.equal(fs.existsSync(refusedWorld.statePath), false);
  });

  test('library: publishSarifReview and validateSarifReview report the same fallback warning; a group is blocked; bad settings are a TypeError', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const fallbackWorld = makeWorld(DROPPED);
    const refusedWorld = makeWorld(REWRITTEN);
    const input = (world: IWorld, parts: Parameters<typeof documentWith>[0], delivery: unknown, withState: boolean): string => JSON.stringify({
      sarif: documentWith(parts),
      destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
      reviewedCommit: REVIEWED,
      options: { delivery },
      ...(withState ? { statePath: world.statePath } : {}),
    });
    const script = (world: IWorld, operation: string, json: string): Record<string, unknown> => {
      const file = path.join(consumer, `${operation}-${path.basename(world.root)}.cjs`);
      fs.writeFileSync(file, [
        `const library = require('sarif-to-comment');`,
        `library.${operation}({ ...${json}, token: process.env.GH_TOKEN })`,
        '  .then((outcome) => process.stdout.write(JSON.stringify(outcome)),',
        '    (err) => process.stdout.write(JSON.stringify({ thrown: err instanceof TypeError ? "TypeError" : String(err), message: err.message })));',
        '',
      ].join('\n'));
      const result = spawnSync(process.execPath, [file], { cwd: consumer, env: envFor(world), encoding: 'utf8', timeout: 120_000 });
      assert.equal(result.status, 0, result.stderr);
      return asRecord(parseJson(result.stdout));
    };

    const companionOrManual = { fileOperations: ['companion', 'manual'] };
    const assessed = script(fallbackWorld, 'validateSarifReview', input(fallbackWorld, ['delete', 'remark'], companionOrManual, false));
    assert.equal(assessed['status'], 'ready');
    const published = script(fallbackWorld, 'publishSarifReview', input(fallbackWorld, ['delete', 'remark'], companionOrManual, true));
    assert.equal(published['status'], 'published');
    assert.deepEqual(published['diagnostics'], assessed['diagnostics'], 'validate reports what publish does');
    const [warning] = asArray(published['diagnostics']).map((d) => asRecord(d));
    assert.ok(warning);
    assert.equal(warning['code'], 'delivery-fallback');
    assert.equal(warning['message'], LIBRARY_FALLBACK_MESSAGE);
    assert.ok(asString(published['markdown']).startsWith(`## Draft review published\n\n${PUBLISHED_HEADLINE}\n\n`), asString(published['markdown']));

    const blocked = script(refusedWorld, 'validateSarifReview', input(refusedWorld, ['reword', 'remark'], { groupedEdits: ['companion'] }, false));
    assert.equal(blocked['status'], 'blocked');
    assert.deepEqual(asArray(blocked['problems']).map((p) => asRecord(p)['code']), ['delivery-unavailable']);
    assert.deepEqual(writes(refusedWorld), []);

    const invalid = script(refusedWorld, 'validateSarifReview', input(refusedWorld, ['remark'], { fileOperations: [] }, false));
    assert.deepEqual(invalid, { thrown: 'TypeError', message: 'Invalid validateSarifReview input: options.delivery.fileOperations must list at least one mechanism' });
  });
});
