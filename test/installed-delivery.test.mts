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
 * request is projected unfaithful (it would bring back lines the rewrite
 * dropped) is delivered by the next mechanism its list names,
 * `--file-operations companion,manual`: the review body proposes it, with a
 * `delivery-fallback` warning and a headline, and a retry with the same
 * state path reports the same warning (issue #42). A group whose only listed
 * mechanism is unavailable (`--grouped-edits companion`) blocks the review
 * with `delivery-unavailable` and exit status 2, writing nothing. A group
 * projected to conflict, and nothing worse, is created on the reviewed
 * commit with a `companion-conflicts-at-head` warning, its description shows
 * its own changes, and GitHub's `mergeable` is reported as observed
 * (docs/companion-suggestion-pr-contract.md §2.5.1, §2.11). Help documents
 * the delivery flags.
 *
 * On the original pull request (the composition fake GitHub,
 * test/support/delivery-world.mts), the defaults deliver a group with a new
 * file whole, made by hand in the review body (the mixed manual group), and a
 * fix with several changes as a native batch; both were refused before.
 *
 * @see docs/delivery-policy-contract.md §8.8, §8.10, §10
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
import { AMENDED, DROPPED, OWNER, PULL, REPO, REVIEWED, TOKEN, documentWith, makeWorld, proposalCommit, writes } from './fixtures/rewritten-history/world.mts';
import type { IWorld } from './fixtures/rewritten-history/world.mts';
import * as delivery from './support/delivery-world.mts';
import { asArray, asRecord, asString, parseJson } from './support/runtime-types.mts';

const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'docs', 'fake-fetch-preload.mts');

/** The environment that points the installed package's `fetch` at `world`'s fake GitHub. */
function envFor(world: IWorld): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'], GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: world.host.dir, NODE_OPTIONS: `--require=${PRELOAD}` };
}

const REWRITTEN_DELETION = `The history of #7 was rewritten after the reviewed commit, and projected onto its head \`${DROPPED}\`, merging its suggestion pull request would not apply `
  + 'exactly its own changes: `docs/sample.md` would bring back content the head no longer has.';
const FALLBACK_MESSAGE = 'The deletion of `obsolete.txt` is delivered as `manual`. `fileOperations` is `[companion, manual]`, set by the caller (`--file-operations`, `delivery.fileOperations`), '
  + `and the mechanisms listed before it are unavailable:\n\n- \`companion\`: ${REWRITTEN_DELETION}`;
const LIBRARY_FALLBACK_MESSAGE = FALLBACK_MESSAGE;
const GROUP_UNAVAILABLE = 'The group `reword` cannot be delivered. `groupedEdits` is `[companion]`, set by the caller (`--grouped-edits`, `delivery.groupedEdits`), and no mechanism it lists is available:\n\n'
  + `- \`companion\`: The history of #7 was rewritten after the reviewed commit, and projected onto its head \`${DROPPED}\`, merging its suggestion pull request would not apply `
  + 'exactly its own changes: `docs/sample.md` would bring back content the head no longer has, beside a conflict.';
const CONFLICT_MESSAGE = `Projected onto the head \`${AMENDED}\` of #7, merging the suggestion pull request for the group \`reword\` would conflict in \`docs/sample.md\`. `
  + 'It is created on the reviewed commit, as planned; GitHub shows the conflict to whoever merges it.';
const CONFLICT_BLOCK = '▲ warning  A suggestion pull request is projected to conflict with the pull request\'s head  [companion-conflicts-at-head]\n';
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

    const refusedWorld = makeWorld(DROPPED);
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
    const refusedWorld = makeWorld(DROPPED);
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

  test('CLI: after a rewritten history, a group projected to conflict is created on the reviewed commit, warned of, shows its own changes, and GitHub\'s mergeable is reported', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    // GitHub has already computed it as conflicting when first read.
    const world = makeWorld(AMENDED, { companion: { mergeable: { '101': { value: false, pendingReads: 0 } } } });
    const file = path.join(world.root, 'review.sarif');
    fs.writeFileSync(file, JSON.stringify(documentWith(['reword', 'remark'])));
    const flags = ['--sarif', file, '--repo', `${OWNER}/${REPO}`, '--pull', String(PULL), '--commit', REVIEWED, '--grouped-edits', 'companion'];
    const run = (args: readonly string[]): SpawnSyncReturns<string> => {
      const result = spawnSync(bin, args, { cwd: consumer, env: envFor(world), encoding: 'utf8', timeout: 120_000 });
      for (const text of [result.stdout, result.stderr]) assert.ok(!text.includes(TOKEN), 'the token never appears');
      return result;
    };
    const checked = run(['validate', ...flags]);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.ok(checked.stdout.includes(`so it is proposed on that commit and was projected onto the head \`${AMENDED}\`: merging it would conflict.`), checked.stdout);
    assert.ok(checked.stderr.startsWith(CONFLICT_BLOCK), checked.stderr);

    const published = run(['publish', ...flags, '--state', world.statePath, '--format', 'json']);
    assert.equal(published.status, 0, published.stdout + published.stderr);
    const doc = asRecord(parseJson(published.stdout));
    assert.equal(doc['status'], 'published');
    const [warning, ...more] = asArray(doc['diagnostics']).map((d) => asRecord(d));
    assert.ok(warning && more.length === 0, 'exactly one diagnostic');
    assert.equal(warning['code'], 'companion-conflicts-at-head');
    assert.equal(warning['message'], CONFLICT_MESSAGE);
    const [suggestion] = asArray(doc['suggestions']).map((s) => asRecord(s));
    assert.equal(suggestion?.['mergeable'], 'conflicting');
    assert.ok(asString(doc['message']).includes(': projected to conflict; GitHub reports it as conflicting.'), asString(doc['message']));
    const [pull] = world.host.pulls();
    assert.ok(pull);
    assert.deepEqual(proposalCommit(world, pull.head).parents, [REVIEWED]);
    assert.ok(pull.body.includes('**The reviewed commit is not part of the branch of #7:**'), pull.body);
    assert.ok(pull.body.includes('```diff\n--- a/docs/sample.md\n+++ b/docs/sample.md\n@@ -3,11 +3,11 @@\n'), pull.body);
  });
});

describe('the installed package delivers groups on the original pull request', () => {
  const skip = packProject().error || false;

  test('CLI and library: under the defaults, a group with a new file is made by hand in the body, and a fix with several changes is a native batch', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const env = (world: delivery.IWorld): NodeJS.ProcessEnv => ({ PATH: process.env['PATH'], GH_TOKEN: delivery.TOKEN, FAKE_HTTP_GITHUB_DIR: world.host.dir, NODE_OPTIONS: `--require=${PRELOAD}` });
    const helperGroup = delivery.document([
      delivery.result({ text: 'Add the helper.', group: 'helper', location: delivery.at('src/helper.ts', 1), operation: delivery.create(0) }),
      delivery.TYPO('helper'),
      delivery.SPELLING('helper'),
    ], [delivery.created('src/helper.ts', delivery.HELPER)]);

    const world = delivery.makeWorld();
    const file = path.join(world.root, 'review.sarif');
    fs.writeFileSync(file, JSON.stringify(helperGroup));
    const published = spawnSync(bin, ['publish', '--sarif', file, '--repo', `${delivery.OWNER}/${delivery.REPO}`, '--pull', String(delivery.PULL), '--commit', delivery.HEAD, '--state', world.statePath, '--format', 'json'],
      { cwd: consumer, env: env(world), encoding: 'utf8', timeout: 120_000 });
    assert.equal(published.status, 0, published.stdout + published.stderr);
    assert.equal(asRecord(parseJson(published.stdout))['status'], 'published');
    assert.deepEqual(world.host.pulls(), []);
    const review = delivery.onlyReview(world);
    assert.ok(review.body.startsWith('**Suggestion group `helper`:** apply these 3 changes together, by hand, in one commit: '), review.body);
    assert.ok(review.body.includes('\n\n- `src/helper.ts`: new file\n- `README.md` line 2\n- `README.md` line 3\n\n---\n\n'), review.body);
    assert.doesNotMatch(review.body, /```suggestion/);
    assert.deepEqual(review.comments, []);

    const jointWorld = delivery.makeWorld();
    const joint = delivery.document([delivery.result({ text: 'Fix both lines.', location: delivery.at('README.md', 2), fixes: [delivery.linesFix('README.md', { 2: 'The widget client.', 3: 'Receive updates.' })] })]);
    const script = path.join(consumer, 'publish-joint.cjs');
    fs.writeFileSync(script, [
      `const library = require('sarif-to-comment');`,
      `library.publishSarifReview({ ...${JSON.stringify(delivery.input(joint))}, statePath: ${JSON.stringify(jointWorld.statePath)}, token: process.env.GH_TOKEN })`,
      '  .then((outcome) => process.stdout.write(JSON.stringify(outcome)), (err) => process.stdout.write(JSON.stringify({ thrown: String(err) })));',
      '',
    ].join('\n'));
    const ran = spawnSync(process.execPath, [script], { cwd: consumer, env: env(jointWorld), encoding: 'utf8', timeout: 120_000 });
    assert.equal(ran.status, 0, ran.stderr);
    const outcome = asRecord(parseJson(ran.stdout));
    assert.equal(outcome['status'], 'published', JSON.stringify(outcome));
    assert.deepEqual(asArray(outcome['diagnostics']), []);
    const batch = delivery.onlyReview(jointWorld);
    assert.deepEqual(batch.comments.map((c) => c.line), [2, 3]);
    assert.ok(batch.comments.every((c) => c.body.includes("**Fix with 2 changes:** apply this suggestion together with the fix's other suggestions, listed in the review body.")));
    assert.equal(batch.body, '**Fix with 2 changes:** apply these 2 suggestions together, in one commit: add each of them to one batch of suggestions on the pull request, then commit the batch.\n\n- `README.md` line 2\n- `README.md` line 3');
  });
});
