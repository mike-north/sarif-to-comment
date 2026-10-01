/**
 * User acceptance of library presentation callbacks (`options.presentation`)
 * through the *installed* package: the tarball `npm pack` produces, installed
 * into a clean consumer by test/fixtures/package/installed-package.mts, used
 * only through `import … from 'sarif-to-comment'`.
 *
 * A consumer module customizes the finding and the lifecycle note, assesses
 * and publishes a whole-file proposal as a companion suggestion pull request
 * against a fake GitHub that speaks HTTP to the product's real client (the
 * preload replaces only `fetch`), and confirms that a callback which would
 * hide the suggestion marker is refused before anything is written.
 *
 * The expected bodies are written by hand from
 * docs/companion-suggestion-pr-contract.md §2.11 and the callbacks' own text.
 *
 * @see ../docs/design-decisions.md (D60)
 * @see ../docs/companion-suggestion-pr-contract.md
 * @see https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { FakeHttpGitHub } from './fixtures/composition/fake-http-github.mts';
import { ROOT, installIntoConsumer, packProject } from './fixtures/package/installed-package.mts';
import { GUIDE_DOCUMENT, HEAD, HOST_REPOSITORY, REVIEW_MARKER, SUGGESTION_MARKER, TOKEN } from './support/presentation-fixtures.mts';

const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'docs', 'fake-fetch-preload.mts');
const GUIDE_CHANGE = '- New file `docs/guide.md`: 25 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644';
const GUIDE_ITEMS = '**Location:** line 1 of the proposed file\n\nAdd a guide. (Review bot 1.0.0)';

describe('the installed package accepts presentation callbacks', () => {
  const skip = packProject().error || false;

  test('library: validate and publish with a custom finding and lifecycle note; a marker-hiding callback is refused', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-presentation-'));
    const hostDir = path.join(root, 'host');
    FakeHttpGitHub.create(hostDir, {}, HOST_REPOSITORY);
    const host = new FakeHttpGitHub(hostDir, TOKEN);
    const sarifPath = path.join(root, 'review.sarif');
    fs.writeFileSync(sarifPath, JSON.stringify(GUIDE_DOCUMENT, null, 2));

    const js = String.raw;
    const script = js`
      import assert from 'node:assert/strict';
      import { existsSync, readFileSync } from 'node:fs';
      import { publishSarifReview, validateSarifReview } from 'sarif-to-comment';
      const sarif = JSON.parse(readFileSync(process.env.SARIF_PATH, 'utf8'));
      const tick = String.fromCharCode(96);
      const presentation = {
        lifecycleNote: (c) => '**Accepting:** a ' + (c.ready ? 'ready' : 'draft') + ' proposal into ' + tick + c.headRef + tick + ' for #' + c.pullNumber + '.',
        finding: (c) => c.message + ' (' + c.attribution + ')',
      };
      const input = { sarif, destination: { owner: 'octo', repo: 'widgets', pullNumber: 7 }, reviewedCommit: process.env.REVIEW_COMMIT, token: process.env.GH_TOKEN };
      const options = { delivery: { groupedEdits: ['companion'], fileOperations: ['companion', 'manual'] }, presentation };
      const assessed = await validateSarifReview({ ...input, options });
      assert.equal(assessed.status, 'ready', assessed.markdown);
      await assert.rejects(
        publishSarifReview({ ...input, statePath: process.env.REFUSED_STATE, options: { ...options, presentation: { lifecycleNote: () => 'Accept it.\n\n<!--' } } }),
        (error) => error instanceof TypeError && /options\.presentation\.lifecycleNote returned Markdown that leaves an HTML <!-- construct open/.test(error.message),
      );
      assert.equal(existsSync(process.env.REFUSED_STATE), false);
      const outcome = await publishSarifReview({ ...input, statePath: process.env.REVIEW_STATE, options });
      assert.equal(outcome.status, 'published', outcome.markdown);
      process.stdout.write(JSON.stringify({ status: outcome.status, suggestions: outcome.suggestions.length }));
    `;
    const file = path.join(consumer, 'presentation-library.mjs');
    fs.writeFileSync(file, script);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'], HOME: root, GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: hostDir, NODE_OPTIONS: `--require=${PRELOAD}`,
      SARIF_PATH: sarifPath, REVIEW_COMMIT: HEAD, REVIEW_STATE: path.join(root, 'state.json'), REFUSED_STATE: path.join(root, 'refused.json'),
    };
    const result = spawnSync(process.execPath, [file], { cwd: consumer, env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'published', suggestions: 1 });
    assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN));

    // Exactly one suggestion pull request and one review: the refused call wrote nothing.
    const pulls = host.pulls();
    assert.equal(pulls.length, 1);
    const [pull] = pulls;
    assert.ok(pull);
    const marker = SUGGESTION_MARKER.exec(pull.body);
    assert.ok(marker, 'the suggestion pull request still ends with its structured marker');
    assert.equal(pull.body, [
      `Suggested in a review of #7 at commit ${HEAD}.`,
      '',
      'Merging this pull request into `feature/retry` applies this change:',
      '',
      GUIDE_CHANGE,
      '',
      '**Accepting:** a draft proposal into `feature/retry` for #7.',
      '',
      '---',
      '',
      GUIDE_ITEMS,
      '',
      marker[1],
    ].join('\n'));
    const reviews = host.reviews();
    assert.equal(reviews.length, 1);
    const body = reviews[0]?.request.body ?? '';
    assert.match(body, REVIEW_MARKER);
    const number = String(pull.number);
    assert.equal(body.replace(REVIEW_MARKER, ''), [
      '**Companion pull requests of this review:**',
      '',
      `- [#${number}](https://github.com/octo/widgets/pull/${number}): Suggestion for \\#7: create docs/guide.md — created with this review`,
      '',
      '---',
      '',
      `**Suggestion pull request:** [#${number}](https://github.com/octo/widgets/pull/${number})`,
      '',
      'Merging it into `feature/retry` applies this change:',
      '',
      GUIDE_CHANGE,
      '',
      GUIDE_ITEMS,
    ].join('\n'));
    assert.ok(host.log().every((r) => r.authorized));
  });
});
