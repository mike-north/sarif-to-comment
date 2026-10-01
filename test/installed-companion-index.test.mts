/**
 * User acceptance of the review's companion index (D56) through the
 * *installed* package (the tarball `npm pack` produces, installed into a
 * clean consumer by test/fixtures/package/installed-package.mts). Only public
 * surfaces are used: the linked `sarif-to-comment` executable and
 * `import … from 'sarif-to-comment'`, against the fake GitHub host
 * (test/fixtures/composition), reached through a preload that replaces only
 * `fetch`.
 *
 * A later review of pull request #7 reuses a suggestion pull request an
 * earlier review created (`--existing-companion 97`, `existingCompanions`)
 * and creates one of its own: the review body begins with the index listing
 * both, and the reuse is a note. A pull request whose marker names another
 * original blocks with exit status 2 and writes nothing. Expected texts are
 * written by hand from docs/companion-suggestion-pr-contract.md §2.13.
 *
 * @see ../docs/companion-suggestion-pr-contract.md
 * @see ../docs/diagnostics.md
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { ROOT, installIntoConsumer, packProject } from './fixtures/package/installed-package.mts';
import type { IStoredPull } from './fixtures/composition/fake-http-companion.mts';
import { BASE, GUIDE, HEAD, HEAD_REF, OWNER, PULL, REPO, TOKEN, create, created, document, makeWorld, onlyReview, pullUrl, result, writes } from './support/delivery-world.mts';
import type { IWorld } from './support/delivery-world.mts';
import { asArray, asRecord, parseJson } from './support/runtime-types.mts';

const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'docs', 'fake-fetch-preload.mts');

function envFor(world: IWorld): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'], GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: world.host.dir, NODE_OPTIONS: `--require=${PRELOAD}` };
}

/** A conforming suggestion pull request of #7 from an earlier review, or of `original` when given. */
function earlier(number: number, original = PULL): IStoredPull {
  const id = `earlier-${String(number)}`;
  const marker = `<!-- suggestion-pr {"version":1,"original":{"owner":"${OWNER}","repo":"${REPO}","pullNumber":${String(original)}},"reviewedCommit":"${BASE}","id":"${id}","batch":"earlier"} -->`;
  return {
    number, title: 'Suggestion for #7: edit notes.txt', body: `Suggested in a review of #${String(original)}.\n\n${marker}`, head: `suggestion-pr/${String(original)}/${id}`,
    base: HEAD_REF, draft: false, state: 'open', merged: false, labels: ['suggestion-pr'], authorId: 9001,
  };
}

const sarif = document([result({ text: 'Add a guide.', operation: create(0) })], [created('docs/guide.md', GUIDE)]);
const REUSED = '#97 is listed in the review\'s companion index as an existing companion; it was open when the review was prepared.';

/** The review's index: the created suggestion pull request, then #97. */
function expectedIndex(createdNumber: number): string {
  return [
    '**Companion pull requests of this review:**',
    '',
    `- [#${String(createdNumber)}](${pullUrl(createdNumber)}): \`Suggestion for #7: create docs/guide.md\` — created with this review`,
    `- [#97](${pullUrl(97)}): \`Suggestion for #7: edit notes.txt\` — reused; it was open when this review was prepared`,
  ].join('\n');
}

function createdNumber(world: IWorld): number {
  const created = world.host.pulls().filter((pr) => pr.number !== 97 && pr.number !== 98);
  assert.equal(created.length, 1, 'one suggestion pull request is created');
  return created[0]?.number ?? 0;
}

describe('the installed package indexes a review\'s companions', () => {
  const skip = packProject().error || false;

  test('CLI: --existing-companion is validated, listed with the created one, and refused when it names another original', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    const run = (world: IWorld, args: readonly string[]): SpawnSyncReturns<string> => {
      const result = spawnSync(bin, args, { cwd: consumer, env: envFor(world), encoding: 'utf8', timeout: 120_000 });
      for (const text of [result.stdout, result.stderr]) assert.ok(!text.includes(TOKEN), 'the token never appears');
      return result;
    };
    const flags = (world: IWorld): string[] => {
      const file = path.join(world.root, 'review.sarif');
      fs.writeFileSync(file, JSON.stringify(sarif));
      return ['--sarif', file, '--repo', `${OWNER}/${REPO}`, '--pull', String(PULL), '--commit', HEAD, '--file-operations', 'companion'];
    };

    const world = makeWorld();
    world.host.seedPulls([earlier(97), earlier(98, 8)]);
    const help = run(world, ['publish', '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.ok(help.stdout.includes('--existing-companion N'), help.stdout);

    const refused = run(world, ['validate', ...flags(world), '--existing-companion', '98', '--format', 'json']);
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    assert.deepEqual(asArray(asRecord(parseJson(refused.stdout))['diagnostics']).map((d) => [asRecord(d)['code'], asRecord(d)['message']]),
      [['companion-not-reusable', '#98 cannot be listed as an existing companion of #7: its suggestion marker names #8, not #7.']]);

    const published = run(world, ['publish', ...flags(world), '--existing-companion', '97', '--state', world.statePath, '--format', 'json']);
    assert.equal(published.status, 0, published.stdout + published.stderr);
    const doc = asRecord(parseJson(published.stdout));
    assert.equal(doc['status'], 'published');
    assert.deepEqual(asArray(doc['diagnostics']).map((d) => [asRecord(d)['code'], asRecord(d)['message']]), [['companion-reused', REUSED]]);
    const number = createdNumber(world);
    assert.ok(onlyReview(world).body.startsWith(`${expectedIndex(number)}\n\n---\n\n**Suggestion pull request:** [#${String(number)}]`), onlyReview(world).body);
  });

  test('library: existingCompanions and a companionIndex callback through the installed functions, and a retry reports the same note', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const world = makeWorld();
    world.host.seedPulls([earlier(97)]);
    const js = String.raw;
    const script = js`
      import assert from 'node:assert/strict';
      import { validateSarifReview, publishSarifReview } from 'sarif-to-comment';
      const input = {
        sarif: JSON.parse(process.env.SARIF),
        destination: { owner: 'octo', repo: 'widgets', pullNumber: 7 },
        reviewedCommit: process.env.REVIEW_COMMIT,
        token: process.env.GH_TOKEN,
        options: {
          delivery: { fileOperations: ['companion'] },
          existingCompanions: [97],
          presentation: { companionIndex: (c) => c.companions.map((x) => '* ' + x.link + ' (' + x.origin + ')').join('\n') },
        },
      };
      await assert.rejects(validateSarifReview({ ...input, options: { existingCompanions: [97, 97] } }), TypeError);
      const assessed = await validateSarifReview(input);
      assert.equal(assessed.status, 'ready', assessed.markdown);
      const outcome = await publishSarifReview({ ...input, statePath: process.env.REVIEW_STATE });
      assert.equal(outcome.status, 'published', outcome.markdown);
      const again = await publishSarifReview({ ...input, statePath: process.env.REVIEW_STATE });
      assert.deepEqual(again.diagnostics, outcome.diagnostics);
      process.stdout.write(JSON.stringify(outcome.diagnostics.map((d) => [d.code, d.message])));
    `;
    const file = path.join(consumer, 'companion-index.mjs');
    fs.writeFileSync(file, script);
    const env = { ...envFor(world), SARIF: JSON.stringify(sarif), REVIEW_COMMIT: HEAD, REVIEW_STATE: world.statePath };
    const ran = spawnSync(process.execPath, [file], { cwd: consumer, env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.deepEqual(parseJson(ran.stdout), [['companion-reused', REUSED]]);
    const number = createdNumber(world);
    // The caller's companionIndex callback shaped the index (D60).
    assert.ok(onlyReview(world).body.startsWith(`* [#${String(number)}](${pullUrl(number)}) (created)\n* [#97](${pullUrl(97)}) (reused)\n\n---\n\n`), onlyReview(world).body);
    assert.equal(writes(world).filter((w) => w.endsWith('/reviews')).length, 1, 'the retry sent nothing');
  });
});
