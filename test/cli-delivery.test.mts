/**
 * The delivery policy through the real command line (user acceptance): the
 * `--delivery`, `--edits`, `--grouped-edits`, `--file-operations` and
 * `--companion-bundle` flags, layered over the repository's
 * `.github/sarif-to-comment.json` on the default branch, with the real GitHub
 * client talking HTTP to the fake GitHub host. Exit statuses, the JSON
 * documents and the human diagnostics on stderr are written by hand from
 * docs/delivery-policy-contract.md §8.8, §8.10 and §10–§12 and
 * docs/diagnostics.md.
 *
 * @see docs/delivery-policy-contract.md
 * @see docs/diagnostics.md
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { describe, test } from 'node:test';

import {
  FORK_OBSTACLE, GUIDE, HELPER, LICENSE, RETRY, RETRY_NOT_INLINE, SPELLING, TYPO,
  at, cli, create, created, deleted, document, linesFix, makeWorld, onlyReview, remove, repository, result, stateRecord, target, writes,
} from './support/delivery-world.mts';
import type { IWorld, Json } from './support/delivery-world.mts';
import { asArray, asRecord, asString, parseJson } from './support/runtime-types.mts';

const json = (stdout: string): Json => asRecord(parseJson(stdout), 'the JSON document');
const codes = (doc: Json): unknown[] => asArray(doc['diagnostics']).map((d) => asRecord(d)['code']);
const messages = (doc: Json): unknown[] => asArray(doc['diagnostics']).map((d) => asRecord(d)['message']);

const guideCreation = (): Json => document([result({ text: 'Add a guide.', location: at('docs/guide.md', 1), operation: create(0) })], [created('docs/guide.md', GUIDE)]);
const obsoleteDeletion = (): Json => document([result({ text: 'Remove the obsolete file.', location: at('obsolete.txt'), operation: remove(0) })], [deleted('obsolete.txt')]);
const pair = (): Json => document([TYPO('pair'), SPELLING('pair')]);

/** The flags a test uses, for publish (with its state path) and validate. */
const commands = (world: IWorld): readonly (readonly string[])[] => [['validate'], ['publish', '--state', world.statePath]];

describe('help', () => {
  test('publish and validate document the delivery flags, and no longer --allow-suggestion-prs', () => {
    const world = makeWorld();
    for (const topic of [['publish'], ['validate'], []]) {
      const help = cli(world, [...topic, '--help']);
      assert.equal(help.status, 0, help.stderr);
      for (const flag of ['--delivery', '--edits', '--grouped-edits', '--file-operations', '--companion-bundle', '--pr-labels', '--mark-suggestion-prs-ready']) {
        assert.ok(help.stdout.includes(flag), `${topic.join(' ') || 'top-level'} help names ${flag}`);
      }
      assert.equal(help.stdout.includes('--allow-suggestion-prs'), false, `${topic.join(' ') || 'top-level'} help no longer names --allow-suggestion-prs`);
    }
    // Prose is filled to 80 columns, so phrases are compared with line breaks read as spaces.
    const publish = cli(world, ['publish', '--help']).stdout.replace(/\s+/g, ' ');
    for (const vocabulary of ['original-pr|companion', 'per-unit|single', 'native, review-body', 'native-batch, companion', 'manual and companion', '.github/sarif-to-comment.json']) {
      assert.ok(publish.includes(vocabulary), `publish --help names ${vocabulary}`);
    }
    // §8.10: every mechanism is supported; the forms made by hand are never suggestions, and two are used only when listed.
    assert.ok(publish.includes('review-body, manual-group and manual show proposals in the review body for the author to make by hand, never as suggestions; review-body and manual-group are used only when listed.'), publish);
    assert.equal(publish.includes('not yet supported'), false, 'no mechanism is reported as unsupported');
  });
});

describe('caller settings are validated before anything is read (§12)', () => {
  test('--allow-suggestion-prs is an unknown option (exit 1)', () => {
    const world = makeWorld();
    const args = target(world, guideCreation());
    for (const command of commands(world)) {
      const run = cli(world, [...command, ...args, '--allow-suggestion-prs', '--format', 'json']);
      assert.equal(run.status, 1, run.stdout + run.stderr);
      const doc = json(run.stdout);
      assert.equal(doc['status'], 'usage-error');
      assert.deepEqual(messages(doc), ['unknown option --allow-suggestion-prs']);
    }
    assert.deepEqual(world.host.log(), []);
  });

  test('D-A17: an empty, unknown, repeated or malformed value is a usage error (exit 1) naming the flag', () => {
    const world = makeWorld();
    const args = target(world, pair());
    const cases: readonly (readonly [readonly string[], string])[] = [
      [['--file-operations', ''], '--file-operations requires a non-empty value'],
      [['--file-operations='], '--file-operations requires a non-empty value'],
      [['--edits', 'native,,companion'], '--edits must be a comma-separated list of mechanisms, without empty entries'],
      [['--edits', 'native,'], '--edits must be a comma-separated list of mechanisms, without empty entries'],
      [['--grouped-edits', ' , '], '--grouped-edits must be a comma-separated list of mechanisms, without empty entries'],
      [['--edits', 'native,native'], '--edits entry 2 repeats `native`'],
      [['--grouped-edits', 'batch'], '--grouped-edits entry 1 is not one of `native-batch`, `companion`, `manual-group`'],
      [['--file-operations', 'manual,review-body'], '--file-operations entry 2 is not one of `manual`, `companion`'],
      [['--delivery', 'all'], '--delivery is not one of `original-pr`, `companion`'],
      [['--companion-bundle', 'many'], '--companion-bundle is not one of `per-unit`, `single`'],
      [['--delivery', 'companion', '--delivery', 'original-pr'], '--delivery was given more than once'],
    ];
    for (const [flags, message] of cases) {
      for (const command of commands(world)) {
        const run = cli(world, [...command, ...args, ...flags, '--format', 'json']);
        assert.equal(run.status, 1, `${flags.join(' ')}: ${run.stdout}${run.stderr}`);
        const doc = json(run.stdout);
        assert.equal(doc['status'], 'usage-error');
        assert.deepEqual(codes(doc), ['usage-error']);
        assert.deepEqual(messages(doc), [message], flags.join(' '));
      }
    }
    assert.deepEqual(world.host.log(), [], 'nothing was read');
  });
});

describe('strict lists, fallback and the configuration through the CLI', () => {
  test('a strict list that cannot be honored: exit 2, delivery-unavailable on stderr, nothing written (D55)', () => {
    const world = makeWorld(repository({ fork: true }));
    const args = target(world, obsoleteDeletion());
    const human = cli(world, ['publish', ...args, '--state', world.statePath, '--file-operations', 'companion']);
    assert.equal(human.status, 2, human.stdout + human.stderr);
    assert.equal(human.stdout, '## Review blocked\n\nNothing was published and no publication state was written. 1 problem must be resolved before publication.\n');
    assert.ok(human.stderr.startsWith('✖ error  No delivery mechanism the policy lists is available for a proposal  [delivery-unavailable]\n  /runs/0/results/0\n'), human.stderr);
    assert.ok(human.stderr.includes('The deletion of `obsolete.txt` cannot be delivered.'), human.stderr);
    assert.ok(human.stderr.endsWith('\n1 error\n'), human.stderr);

    const machine = cli(world, ['publish', ...args, '--state', world.statePath, '--file-operations', 'companion', '--format', 'json']);
    assert.equal(machine.status, 2);
    const doc = json(machine.stdout);
    assert.equal(doc['status'], 'blocked');
    assert.deepEqual(messages(doc), [
      'The deletion of `obsolete.txt` cannot be delivered. `fileOperations` is `[companion]`, set by the caller (`--file-operations`, `delivery.fileOperations`), and no mechanism it lists is available:\n\n'
        + `- \`companion\`: ${FORK_OBSTACLE}`,
    ]);
    const checked = cli(world, ['validate', ...args, '--file-operations', 'companion', '--format', 'json']);
    assert.equal(checked.status, 2);
    assert.deepEqual(json(checked.stdout)['diagnostics'], doc['diagnostics']);
    assert.deepEqual(writes(world), []);
    assert.equal(fs.existsSync(world.statePath), false);
  });

  test('a list with spaces around its entries is trimmed; the fallback is a warning, exit 0', () => {
    const world = makeWorld(repository({ fork: true }));
    const args = target(world, guideCreation());
    const run = cli(world, ['publish', ...args, '--state', world.statePath, '--file-operations', 'companion, manual', '--format', 'json']);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const doc = json(run.stdout);
    assert.equal(doc['status'], 'published');
    assert.deepEqual(codes(doc), ['delivery-fallback']);
    assert.deepEqual(messages(doc), [
      'The creation of `docs/guide.md` is delivered as `manual`. `fileOperations` is `[companion, manual]`, set by the caller (`--file-operations`, `delivery.fileOperations`), and the mechanisms listed before it are unavailable:\n\n'
        + `- \`companion\`: ${FORK_OBSTACLE}`,
    ]);
    assert.ok(asString(doc['message']).includes('**Published with 1 warning:** A proposal is delivered by a later mechanism of its delivery list.'));

    const retried = cli(world, ['publish', ...args, '--state', world.statePath, '--file-operations', 'companion, manual']);
    assert.equal(retried.status, 0, retried.stdout + retried.stderr);
    assert.ok(retried.stderr.startsWith('▲ warning  A proposal is delivered by a later mechanism of its delivery list  [delivery-fallback]\n'), retried.stderr);
    assert.ok(retried.stderr.endsWith('\n1 warning\n'), retried.stderr);
  });

  test('flags override the repository configuration per dimension (D-A1), and the resolution is recorded with its sources', () => {
    const world = makeWorld(repository({ configuration: '{"delivery":{"groupedEdits":["native-batch"],"companionBundle":"single"}}' }));
    const args = target(world, pair());
    const run = cli(world, ['publish', ...args, '--state', world.statePath, '--grouped-edits', 'companion', '--format', 'json']);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(asArray(json(run.stdout)['suggestions']).length, 1);
    assert.deepEqual(stateRecord(world)['delivery'], {
      edits: { value: ['native'], source: 'default' },
      groupedEdits: { value: ['companion'], source: 'caller' },
      fileOperations: { value: ['manual'], source: 'default' },
      companionBundle: { value: 'single', source: 'configuration' },
    });
  });

  test('--delivery companion --companion-bundle single sends every proposal to one companion pull request', () => {
    const world = makeWorld();
    const args = target(world, document([TYPO(), result({ text: 'Add a guide.', location: at('docs/guide.md', 1), operation: create(0) })], [created('docs/guide.md', GUIDE)]));
    const run = cli(world, ['publish', ...args, '--state', world.statePath, '--delivery', 'companion', '--companion-bundle', 'single', '--format', 'json']);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(world.host.pulls().length, 1);
    assert.equal(world.host.pulls()[0]?.title, 'Suggestion for #7: 2 proposals (2 changes)');
  });

  test('an invalid configuration blocks validate and publish alike (exit 2); a failed read is incomplete (exit 1)', () => {
    const invalid = makeWorld(repository({ configuration: '{"delivery":{"preset":"everything"}}' }));
    const args = target(invalid, pair());
    for (const command of commands(invalid)) {
      const run = cli(invalid, [...command, ...args, '--format', 'json']);
      assert.equal(run.status, 2, run.stdout + run.stderr);
      assert.deepEqual(messages(json(run.stdout)), ['`.github/sarif-to-comment.json` on the default branch `main` cannot be used: `/delivery/preset` is not one of `original-pr`, `companion`.']);
    }
    assert.deepEqual(writes(invalid), []);

    const unreadable = makeWorld(repository(), { companion: { defaultBranchRead: 'forbidden' } });
    const checked = cli(unreadable, ['validate', ...target(unreadable, pair()), '--format', 'json']);
    assert.equal(checked.status, 1, checked.stdout + checked.stderr);
    assert.equal(json(checked.stdout)['status'], 'incomplete');
    const published = cli(unreadable, ['publish', ...target(unreadable, pair()), '--state', unreadable.statePath, '--format', 'json']);
    assert.equal(published.status, 1, published.stdout + published.stderr);
    assert.deepEqual(writes(unreadable), []);
  });

  test('companion options without a planned companion: exit 0 with a companion-options-unused note on stderr', () => {
    const world = makeWorld();
    const run = cli(world, ['publish', ...target(world, document([TYPO()])), '--state', world.statePath, '--pr-labels', 'team-a', '--mark-suggestion-prs-ready']);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(run.stderr.startsWith('ℹ note  Companion pull request options have no effect  [companion-options-unused]\n'), run.stderr);
    assert.ok(run.stderr.endsWith('\n1 note\n'), run.stderr);
  });

  test('the flag-only publisher takes the same delivery flags', () => {
    const world = makeWorld();
    const run = cli(world, [...target(world, document([RETRY()])), '--state', world.statePath, '--edits', 'native', '--format', 'json']);
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.deepEqual(messages(json(run.stdout)), [
      'The edit of `src/client.ts` line 2 cannot be delivered. `edits` is `[native]`, set by the caller (`--edits`, `delivery.edits`), and no mechanism it lists is available:\n\n'
        + `- \`native\`: ${RETRY_NOT_INLINE}`,
    ]);
  });
});

describe('proposals on the original pull request through the CLI (§8.8, §8.10)', () => {
  /** D-A7/D-A8: a new helper file and two README edits grouped as `helper`, and an unrelated edit. */
  const helperGroup = (): Json => document([
    result({ text: 'Add the helper.', group: 'helper', location: at('src/helper.ts', 1), operation: create(0) }),
    TYPO('helper'),
    SPELLING('helper'),
    LICENSE(),
  ], [created('src/helper.ts', HELPER)]);
  const GUIDANCE = (label: string, count: number): string =>
    `**${label}:** apply these ${String(count)} changes together, by hand, in one commit: make every change below in a local copy of the pull request's branch, then commit them together. They are not offered as suggestions, and nothing checks that they are applied together.`;

  test('D-A8: under the defaults a group with a new file is published (exit 0) as the mixed manual group, with no companion and no suggestion in the body', () => {
    const world = makeWorld();
    const args = target(world, helperGroup());
    const checked = cli(world, ['validate', ...args, '--format', 'json']);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.equal(json(checked.stdout)['status'], 'ready');
    const run = cli(world, ['publish', ...args, '--state', world.statePath]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(run.stdout.startsWith('## Draft review published\n'), run.stdout);
    assert.equal(run.stderr, '', 'no diagnostics: the requested delivery');
    assert.deepEqual(world.host.pulls(), []);
    const review = onlyReview(world);
    assert.ok(review.body.startsWith(`${GUIDANCE('Suggestion group `helper`', 3)}\n\n- \`src/helper.ts\`: new file\n- \`README.md\` line 2\n- \`README.md\` line 3\n\n---\n\n**Suggestion group \`helper\` — change 1 of 3**\n\n**Proposed new file:** \`src/helper.ts\``), review.body);
    assert.doesNotMatch(review.body, /```suggestion/);
    assert.equal(review.comments.length, 1, 'the unrelated edit is the only inline comment');
  });

  test('D-A11: --delivery original-pr publishes a group with an ineligible member made by hand, with a fallback warning on stderr', () => {
    const world = makeWorld();
    const args = target(world, document([TYPO('pair'), RETRY('pair')]));
    const run = cli(world, ['publish', ...args, '--state', world.statePath, '--delivery', 'original-pr']);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(run.stderr.startsWith('▲ warning  A proposal is delivered by a later mechanism of its delivery list  [delivery-fallback]\n'), run.stderr);
    assert.ok(run.stderr.includes('The group `pair` is delivered as `manual-group`.'), run.stderr);
    const review = onlyReview(world);
    assert.ok(review.body.startsWith(`${GUIDANCE('Suggestion group `pair`', 2)}\n\n- \`README.md\` line 2\n- \`src/client.ts\` line 2\n\n---\n\n`), review.body);
    assert.deepEqual(review.comments, []);
  });

  test('D-A22: --edits review-body publishes an edit outside the diff as a proposal to make by hand (JSON)', () => {
    const world = makeWorld();
    const run = cli(world, ['publish', ...target(world, document([RETRY()])), '--state', world.statePath, '--edits', 'review-body', '--format', 'json']);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const doc = json(run.stdout);
    assert.equal(doc['status'], 'published');
    assert.deepEqual(codes(doc), []);
    assert.ok(onlyReview(world).body.startsWith('**Proposed edit, to make by hand:** replace [src/client.ts line 2 at feedfee]('), onlyReview(world).body);
  });

  test('D-A23: under the defaults a fix with several changes is published (exit 0) as a native batch', () => {
    const world = makeWorld();
    const joint = document([result({ text: 'Fix both lines.', location: at('README.md', 2), fixes: [linesFix('README.md', { 2: 'The widget client.', 3: 'Receive updates.' })] })]);
    const run = cli(world, ['publish', ...target(world, joint), '--state', world.statePath, '--format', 'json']);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(json(run.stdout)['status'], 'published');
    const review = onlyReview(world);
    assert.deepEqual(review.comments.map((c) => c.line), [2, 3]);
    assert.ok(review.body.startsWith('**Fix with 2 changes:** apply these 2 suggestions together, in one commit:'), review.body);
  });

  test('D-A25: an edit no listed mechanism can show exactly: exit 2, with the obstacle on stderr; nothing written', () => {
    const world = makeWorld();
    const hidden = document([result({ text: 'Mark it.', location: at('notes.txt', 2), fixes: [linesFix('notes.txt', { 2: 'Note 2,‎ revised.' })] })]);
    const run = cli(world, ['publish', ...target(world, hidden), '--state', world.statePath, '--edits', 'review-body']);
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.ok(run.stderr.includes('- `review-body`: The replacement of `notes.txt` line 2 cannot be shown exactly in the review body: replacement line 1 contains U+200E, which a code block does not show.'), run.stderr);
    assert.deepEqual(writes(world), []);
  });
});
