/**
 * Companion suggestion pull requests through the production composition: the
 * real public library and CLI with the real GitHub client (src/github.cts),
 * talking HTTP to the fake GitHub host (test/fixtures/composition). Only
 * `fetch` is replaced.
 *
 * Every expected value is written by hand from
 * docs/companion-suggestion-pr-contract.md and docs/suggestion-pr-convention.md:
 * the proposal branch's exact file
 * bytes and modes, the suggestion pull request's title, body, base, draft
 * state and label, the review body that links it, the blocked explanations,
 * and the identity, recovery and human-change outcomes of §2.9–§2.10. Only
 * the random suggestion and publication ids and the host's pull request
 * numbers are read back and substituted.
 *
 * The host models documented GitHub behavior; it is not evidence of live
 * GitHub behavior (see docs/companion-suggestion-pr-e2e-evidence.md).
 *
 * @see https://docs.github.com/en/rest/git/trees#create-a-tree
 * @see https://docs.github.com/en/rest/git/refs#create-a-reference
 * @see https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request
 * @see https://docs.github.com/en/rest/issues/labels#add-labels-to-an-issue
 * @see https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { createGitHubClient } from '../dist/github.cjs';
import library from '../dist/index.cjs';
import type { ICreateGitHubClientOptions, IGitHubClient } from '../dist/github.cjs';
import { FakeHttpGitHub } from './fixtures/composition/fake-http-github.mts';
import type { IHttpHostConfig, IHttpRepository } from './fixtures/composition/fake-http-github.mts';
import type { IStoredPull } from './fixtures/composition/fake-http-companion.mts';
import { asArray, asNumber, asRecord, asString, parseJson, readJson } from './support/runtime-types.mts';

const CLI = path.join(import.meta.dirname, 'fixtures', 'composition', 'cli-with-fake-http.mts');
const BASE = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e';
const HEAD = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
const SHORT = 'feedfee';
const OWNER = 'octo';
const REPO = 'widgets';
const PULL = 7;
const HEAD_REF = 'feature/retry';
const TOKEN = 'ghp_COMPANION_COMPOSITION_0123456789';
const REVIEW_PATH = `/repos/${OWNER}/${REPO}/pulls/${String(PULL)}/reviews`;
const REVIEW_MARKER = /\n\n<!-- sarif-to-comment:review:[0-9a-f-]{36} -->$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const BRANCH = new RegExp(`^suggestion-pr/7/(${UUID})$`);
const SUGGESTION_MARKER = new RegExp(`\\n\\n(<!-- suggestion-pr (\\{[^\\n]*\\}) -->)$`);

const CLIENT = [
  'export async function fetchWidget(id: string) {\n',
  '  const response = await request(id);\n',
  '  return response.body;\n',
  '}\n',
];
const RUN_SH = '#!/bin/sh\necho run\n';
const TEST_FILE = "import { fetchWidget } from '../src/client';\n\ntest('retries once', async () => {\n  await fetchWidget('w1');\n});\n";
const PAGE_A = '# A\n\nFirst page.\n';
const PAGE_B = '# B\n\nSecond page.\n';
const GUIDE = '# Guide\n\nUse the client.\n';

const UNCHANGED: Readonly<Record<string, readonly string[]>> = {
  'src/client.ts': CLIENT,
  'obsolete.txt': ['first\n', 'second\n'],
  'docs/index.md': ['# Docs\n'],
};

function repository(overrides: Partial<IHttpRepository> = {}): IHttpRepository {
  return {
    destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
    commits: { base: BASE, head: HEAD },
    snapshots: {
      [BASE]: { 'README.md': ['# Widgets\n'], ...UNCHANGED },
      [HEAD]: { 'README.md': ['# Widgets\n', 'Teh widget client.\n'], ...UNCHANGED },
    },
    rawFiles: {
      [BASE]: { 'bin/run.sh': { base64: Buffer.from(RUN_SH).toString('base64'), mode: '100755' } },
      [HEAD]: { 'bin/run.sh': { base64: Buffer.from(RUN_SH).toString('base64'), mode: '100755' } },
    },
    pullFiles: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: ['@@ -1 +1,2 @@\n', ' # Widgets\n', '+Teh widget client.'] }],
    pull: { headRef: HEAD_REF, baseRef: 'main' },
    defaultBranch: 'main',
    labels: ['bug', 'suggestion-pr'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SARIF

type Json = Record<string, unknown>;

interface IResultSpec {
  readonly text: string;
  readonly group?: unknown;
  readonly location?: Json;
  readonly fix?: Json;
  readonly operation?: Json;
}

function result({ text, group, location, fix, operation }: IResultSpec): Json {
  const owned: Json = {
    ...(group === undefined ? {} : { suggestionGroup: group }),
    ...(operation === undefined ? {} : { proposedFileChanges: [operation] }),
  };
  return {
    message: { text },
    ...(location === undefined ? {} : { locations: [{ physicalLocation: location }] }),
    ...(fix === undefined ? {} : { fixes: [fix] }),
    ...(Object.keys(owned).length === 0 ? {} : { properties: { sarifToComment: owned } }),
  };
}

function document(results: readonly Json[], artifacts: readonly Json[] = []): Json {
  return {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Review bot', version: '1.0.0' } },
      columnKind: 'utf16CodeUnits',
      versionControlProvenance: [{ repositoryUri: `https://github.com/${OWNER}/${REPO}`, revisionId: HEAD }],
      artifacts,
      results,
    }],
  };
}

const at = (uri: string, startLine?: number): Json => ({ artifactLocation: { uri }, ...(startLine === undefined ? {} : { region: { startLine } }) });
const lineFix = (uri: string, line: number, text: string): Json => ({
  artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion: { startLine: line }, insertedContent: { text } }] }],
});
const created = (uri: string, text: string): Json => ({ location: { uri }, contents: { text }, encoding: 'utf-8' });

/** Git's blob id, computed here from its definition rather than taken from the host. */
function gitBlob(bytes: Buffer): string {
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${String(bytes.length)}\0`), bytes])).digest('hex');
}

const RETRY = '  const response = await request(id).catch(() => request(id));';
const RETRY_MESSAGE = 'Retry once on timeout.';
const COVER_MESSAGE = 'Cover the retry.';
const TYPO_MESSAGE = 'Typo.';

/** The contract's worked example (§3): a grouped edit plus test, and an ungrouped native suggestion. */
function groupedCodeAndTest(group: unknown = 'retry-with-test'): Json {
  return document([
    result({ text: RETRY_MESSAGE, group, location: at('src/client.ts', 2), fix: lineFix('src/client.ts', 2, RETRY) }),
    result({ text: COVER_MESSAGE, group, location: at('test/client.test.ts', 3), operation: { operation: 'create', artifactIndex: 0, fileMode: '100644' } }),
    result({ text: TYPO_MESSAGE, location: at('README.md', 2), fix: {
      artifactChanges: [{ artifactLocation: { uri: 'README.md' }, replacements: [{ deletedRegion: { startLine: 2, startColumn: 1, endColumn: 4 }, insertedContent: { text: 'The' } }] }],
    } }),
  ], [created('test/client.test.ts', TEST_FILE)]);
}

/** Two new pages explicitly grouped for joint acceptance (A32). */
function groupedAdditions(): Json {
  return document([
    result({ text: 'Add page A.', group: 'docs-pair', operation: { operation: 'create', artifactIndex: 0 } }),
    result({ text: 'Add page B.', group: 'docs-pair', operation: { operation: 'create', artifactIndex: 1 } }),
  ], [created('docs/a.md', PAGE_A), created('docs/b.md', PAGE_B)]);
}

/** A standalone creation and a standalone deletion (A28). */
function standaloneOperations(): Json {
  return document([
    result({ text: 'Add a guide.', location: at('docs/guide.md', 1), operation: { operation: 'create', artifactIndex: 0 } }),
    result({ text: 'Obsolete.', location: at('obsolete.txt'), operation: { operation: 'delete', artifactIndex: 1 } }),
  ], [created('docs/guide.md', GUIDE), { location: { uri: 'obsolete.txt' } }]);
}

// ---------------------------------------------------------------------------
// Harness

interface IWorld {
  readonly root: string;
  readonly statePath: string;
  readonly host: FakeHttpGitHub;
}

function makeWorld(config: Partial<IHttpHostConfig> = {}, repo: IHttpRepository = repository()): IWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'companion-composition-')));
  FakeHttpGitHub.create(path.join(root, 'host'), config, repo);
  fs.mkdirSync(path.join(root, 'state'));
  return { root, statePath: path.join(root, 'state', 'review.json'), host: new FakeHttpGitHub(path.join(root, 'host'), TOKEN) };
}

function internalsFor(world: IWorld): { readonly createGitHubClient: (options: ICreateGitHubClientOptions) => IGitHubClient } {
  return { createGitHubClient: (options) => createGitHubClient({ ...options, fetch: world.host.fetch }) };
}

const ENABLED: Json = { allowSuggestionPullRequests: true };

/** Library input; `options` null omits the field (the default: suggestion pull requests disabled). */
function input(sarif: Json, options: Json | null, reviewedCommit = HEAD): Json {
  return {
    sarif,
    destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
    reviewedCommit,
    token: TOKEN,
    ...(options === null ? {} : { options }),
  };
}

async function callLibrary(name: 'publishSarifReview' | 'validateSarifReview', value: Json, world: IWorld): Promise<Json> {
  const operation: unknown = Reflect.get(library, name);
  if (typeof operation !== 'function') throw new assert.AssertionError({ message: `the package exports ${name}` });
  const outcome: unknown = await Reflect.apply(operation, undefined, [value, internalsFor(world)]);
  return asRecord(outcome, `the ${name} outcome`);
}

const publish = (world: IWorld, sarif: Json, options: Json | null = ENABLED, reviewedCommit = HEAD): Promise<Json> =>
  callLibrary('publishSarifReview', { ...input(sarif, options, reviewedCommit), statePath: world.statePath }, world);
const validate = (world: IWorld, sarif: Json, options: Json | null = ENABLED, reviewedCommit = HEAD): Promise<Json> =>
  callLibrary('validateSarifReview', input(sarif, options, reviewedCommit), world);

const count = (world: IWorld, method: string, pattern: RegExp): number =>
  world.host.log().filter((r) => r.method === method && pattern.test(r.path)).length;
const writes = (world: IWorld): readonly string[] =>
  world.host.log().filter((r) => r.method === 'POST' && r.path !== '/graphql').map((r) => r.path);
const REFS = /\/git\/refs$/;
const PULLS = new RegExp(`^/repos/${OWNER}/${REPO}/pulls$`);
const LABELS = /\/issues\/\d+\/labels$/;
const REVIEWS = new RegExp(`^${REVIEW_PATH}$`);

function status(outcome: Json): string {
  return asString(outcome['status'], 'an outcome status');
}

function markdown(outcome: Json): string {
  return asString(outcome['markdown'], 'outcome markdown');
}

/** The one created pull request, with its branch and the ids its marker records. */
function onlyPull(world: IWorld): { pull: IStoredPull; branch: string; id: string; publication: string; marker: string } {
  const pulls = world.host.pulls();
  assert.equal(pulls.length, 1, 'exactly one suggestion pull request');
  const [pull] = pulls;
  assert.ok(pull);
  return { pull, ...identify(pull) };
}

/** The branch, suggestion id and publication id of a created pull request. */
function identify(pull: IStoredPull): { branch: string; id: string; publication: string; marker: string } {
  const branch = BRANCH.exec(pull.head);
  assert.ok(branch, `a proposal branch name: ${pull.head}`);
  const marker = SUGGESTION_MARKER.exec(pull.body);
  assert.ok(marker, 'the body ends with the structured marker');
  const parsed = asRecord(parseJson(marker[2] ?? ''), 'the marker JSON');
  const id = asString(parsed['id']);
  assert.equal(id, branch[1], 'the marker names the branch\'s suggestion id');
  return { branch: pull.head, id, publication: asString(parsed['batch']), marker: marker[1] ?? '' };
}

function markerFor(id: string, publication: string): string {
  return `<!-- suggestion-pr {"version":1,"original":{"owner":"${OWNER}","repo":"${REPO}","pullNumber":${String(PULL)}},"reviewedCommit":"${HEAD}","id":"${id}","batch":"${publication}"} -->`;
}

/** Contract §2.11: the draft lifecycle note of a suggestion for #7 into `feature/retry`. */
const DRAFT_NOTE = '**How this suggestion is accepted:** it is a draft pull request into `feature/retry`, the branch of #7. A draft cannot be merged: someone with write access first marks it ready for review. The author of #7 then decides whether to merge it, and #7 carries the change to its base. Once #7 is merged or closed, this pull request can be closed.';

const blob = (file: string, anchor = ''): string => `https://github.com/${OWNER}/${REPO}/blob/${HEAD}/${file}${anchor}`;
const pullUrl = (n: number): string => `https://github.com/${OWNER}/${REPO}/pull/${String(n)}`;
const attribution = '<sub>— Review bot 1.0.0</sub>';

/** §2.11: the findings of the worked example's group, as both the review and the pull request show them. */
const GROUP_ITEMS = [
  `**Source:** [src/client.ts line 2 at ${SHORT}](${blob('src/client.ts', '#L2')})`,
  '',
  '```',
  '  const response = await request(id);',
  '```',
  '',
  RETRY_MESSAGE,
  '',
  attribution,
  '',
  '---',
  '',
  '**Location:** line 3 of the proposed file',
  '',
  COVER_MESSAGE,
  '',
  attribution,
];
const GROUP_CHANGES = [
  `- Edited [src/client.ts line 2 at ${SHORT}](${blob('src/client.ts', '#L2')})`,
  '- New file `test/client.test.ts`: 112 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
];

function expectedGroupPullBody(id: string, publication: string): string {
  return [
    `Suggested in a review of #7 at commit ${HEAD}.`,
    '',
    'Merging this pull request into `feature/retry` applies these 2 changes together:',
    '',
    ...GROUP_CHANGES,
    '',
    DRAFT_NOTE,
    '',
    '---',
    '',
    ...GROUP_ITEMS,
    '',
    markerFor(id, publication),
  ].join('\n');
}

function expectedGroupReviewBody(number: number): string {
  return [
    `**Suggestion pull request:** [#${String(number)}](${pullUrl(number)})`,
    '',
    'Merging it into `feature/retry` applies these 2 changes together:',
    '',
    ...GROUP_CHANGES,
    '',
    ...GROUP_ITEMS,
  ].join('\n');
}

const EDITED_CLIENT = [CLIENT[0], `${RETRY}\n`, CLIENT[2], CLIENT[3]].join('');
const HEAD_FILES: ReadonlyMap<string, string> = new Map([
  ['README.md', '100644'], ['src/client.ts', '100644'], ['obsolete.txt', '100644'], ['docs/index.md', '100644'], ['bin/run.sh', '100755'],
]);

/** The worked example's published state: one branch, one labelled draft pull request, one review. */
function assertGroupPublished(world: IWorld, outcome: Json): { branch: string; number: number } {
  assert.equal(status(outcome), 'published', markdown(outcome));
  const { pull, branch, id, publication } = onlyPull(world);
  assert.equal(pull.title, 'Suggestion for #7: retry-with-test (2 changes)');
  assert.equal(pull.base, HEAD_REF);
  assert.equal(pull.draft, true);
  assert.equal(pull.state, 'open');
  assert.deepEqual(pull.labels, ['suggestion-pr']);
  assert.equal(pull.body, expectedGroupPullBody(id, publication));
  assert.deepEqual(world.host.fileOnBranch(branch, 'src/client.ts'), Buffer.from(EDITED_CLIENT));
  assert.deepEqual(world.host.fileOnBranch(branch, 'test/client.test.ts'), Buffer.from(TEST_FILE));
  assert.deepEqual(world.host.filesOnBranch(branch), new Map([...HEAD_FILES, ['test/client.test.ts', '100644']]));
  const commits = Object.entries(world.host.companion().commits);
  assert.equal(commits.length, 1, 'one proposal commit');
  const [entry] = commits;
  assert.ok(entry);
  const [commitSha, commit] = entry;
  assert.deepEqual(commit.parents, [HEAD]);
  assert.equal(commit.message, `Suggestion for #7: retry-with-test (2 changes)\n\nSuggested in a review of ${OWNER}/${REPO} pull request 7 at commit ${HEAD}.`);
  assert.deepEqual(world.host.companion().refs, { [branch]: commitSha });

  const reviews = world.host.reviews();
  assert.equal(reviews.length, 1);
  const [review] = reviews;
  assert.ok(review);
  assert.equal(review.request.body.replace(REVIEW_MARKER, ''), expectedGroupReviewBody(pull.number));
  assert.equal(review.request.comments.length, 1, 'the ungrouped typo stays a native suggestion (A27)');
  const [comment] = review.request.comments;
  assert.ok(comment);
  assert.deepEqual([comment.path, comment.line, comment.side], ['README.md', 2, 'RIGHT']);
  assert.ok(comment.body.endsWith('```suggestion\nThe widget client.\n```'), comment.body);

  assert.deepEqual(outcome['suggestions'], [{ number: pull.number, url: pullUrl(pull.number), branch }]);
  assert.equal(count(world, 'POST', REFS), 1);
  assert.equal(count(world, 'POST', PULLS), 1);
  assert.equal(count(world, 'POST', LABELS), 1);
  assert.equal(count(world, 'POST', REVIEWS), 1);
  return { branch, number: pull.number };
}

/** The blocked explanation both publish and validate give, from its problem lines (written by hand). */
function blockedMarkdown(lines: readonly string[]): string {
  return [
    '## Review blocked',
    '',
    'Nothing was published and no publication state was written.',
    '',
    `**Review blocked:** ${String(lines.length)} problem${lines.length === 1 ? '' : 's'} must be resolved before publication; nothing was published.`,
    '',
    ...lines,
  ].join('\n');
}

/** Publish and validate block with identical Markdown and write nothing. */
async function assertBlockedEverywhere(world: IWorld, sarif: Json, lines: readonly string[], options: Json | null = ENABLED, reviewedCommit = HEAD): Promise<void> {
  const assessed = await validate(world, sarif, options, reviewedCommit);
  const published = await publish(world, sarif, options, reviewedCommit);
  assert.equal(status(assessed), 'blocked', markdown(assessed));
  assert.equal(status(published), 'blocked', markdown(published));
  assert.equal(markdown(published), blockedMarkdown(lines));
  assert.equal(markdown(assessed), markdown(published));
  assert.deepEqual(writes(world), [], 'no write of any kind');
  assert.equal(fs.existsSync(world.statePath), false);
}

const GROUP_REQUIRES = (group: string, pointer: string): string =>
  `- \`suggestion-group-requires-suggestion-prs\` at \`${pointer}\`: Suggestion group "${group}" must be accepted as one unit, which needs a suggestion pull request. `
  + 'Enable suggestion pull requests (options.allowSuggestionPullRequests or --allow-suggestion-prs); a group is never split into separate suggestions or published in part.';

// ---------------------------------------------------------------------------

describe('harness controls', () => {
  test('the expected test file is 112 bytes, and the retry edit changes only line 2', () => {
    assert.equal(Buffer.byteLength(TEST_FILE), 112);
    assert.equal(EDITED_CLIENT.split('\n').length, 5);
    assert.notEqual(EDITED_CLIENT, CLIENT.join(''));
  });

  test('the host refuses a malformed companion request body as a harness failure', async () => {
    const world = makeWorld();
    const response = await world.host.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/refs`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ ref: 'refs/heads/x', sha: HEAD, force: true }),
    });
    assert.equal(response.status, 400);
  });
});

describe('grouped code and test changes (A29)', () => {
  test('enabled: one draft suggestion pull request carries both changes, labelled, and the review links it', async () => {
    const world = makeWorld();
    const outcome = await publish(world, groupedCodeAndTest());
    const { branch, number } = assertGroupPublished(world, outcome);
    assert.ok(markdown(outcome).includes(
      ['Suggestion pull requests (drafts into `feature/retry`, labeled `suggestion-pr`):', '', `- [#${String(number)}](${pullUrl(number)}) from \`${branch}\``].join('\n'),
    ), markdown(outcome));
  });

  test('the proposal commit is built from exact blobs on the reviewed tree, and each write is sent once in order', async () => {
    const world = makeWorld();
    await publish(world, groupedCodeAndTest());
    const order = writes(world).map((p) => p.replace(`/repos/${OWNER}/${REPO}`, ''));
    assert.deepEqual(order, ['/git/blobs', '/git/blobs', '/git/trees', '/git/commits', '/git/refs', '/pulls', '/issues/101/labels', `/pulls/${String(PULL)}/reviews`]);
    assert.deepEqual(Object.keys(world.host.companion().blobs).sort(), [
      gitBlob(Buffer.from(EDITED_CLIENT)), gitBlob(Buffer.from(TEST_FILE)),
    ].sort());
  });

  test('disabled (the default): blocked, naming the setting, with nothing split or written (A30)', async () => {
    const world = makeWorld();
    await assertBlockedEverywhere(world, groupedCodeAndTest(), [GROUP_REQUIRES('retry-with-test', '/runs/0/results/0')], null);
    await assertBlockedEverywhere(makeWorld(), groupedCodeAndTest(), [GROUP_REQUIRES('retry-with-test', '/runs/0/results/0')], { allowSuggestionPullRequests: false });
  });

  test('a group edit keeps an executable file\'s mode, and two edits of one file combine in line order', async () => {
    const world = makeWorld();
    const sarif = document([
      result({ text: 'Quote.', group: 'script', location: at('bin/run.sh', 2), fix: lineFix('bin/run.sh', 2, 'echo "run"') }),
      result({ text: 'Strict.', group: 'script', location: at('bin/run.sh', 1), fix: lineFix('bin/run.sh', 1, '#!/bin/sh -e') }),
    ]);
    const outcome = await publish(world, sarif);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const { pull, branch } = onlyPull(world);
    assert.equal(pull.title, 'Suggestion for #7: script (2 changes)');
    assert.deepEqual(world.host.fileOnBranch(branch, 'bin/run.sh'), Buffer.from('#!/bin/sh -e\necho "run"\n'));
    assert.equal(world.host.filesOnBranch(branch).get('bin/run.sh'), '100755');
    assert.ok(pull.body.includes([
      `- Edited [bin/run.sh line 2 at ${SHORT}](${blob('bin/run.sh', '#L2')})`,
      `- Edited [bin/run.sh line 1 at ${SHORT}](${blob('bin/run.sh', '#L1')})`,
    ].join('\n')), pull.body);
  });
});

describe('grouped additions (A32)', () => {
  test('enabled: one pull request adds both pages; never one pull request per file', async () => {
    const world = makeWorld();
    const outcome = await publish(world, groupedAdditions());
    assert.equal(status(outcome), 'published', markdown(outcome));
    const { pull, branch, id, publication } = onlyPull(world);
    assert.equal(pull.title, 'Suggestion for #7: docs-pair (2 changes)');
    assert.deepEqual(world.host.fileOnBranch(branch, 'docs/a.md'), Buffer.from(PAGE_A));
    assert.deepEqual(world.host.fileOnBranch(branch, 'docs/b.md'), Buffer.from(PAGE_B));
    assert.equal(pull.body, [
      `Suggested in a review of #7 at commit ${HEAD}.`,
      '',
      'Merging this pull request into `feature/retry` applies these 2 changes together:',
      '',
      '- New file `docs/a.md`: 17 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
      '- New file `docs/b.md`: 18 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
      '',
      DRAFT_NOTE,
      '',
      '---',
      '',
      'Add page A.',
      '',
      attribution,
      '',
      '---',
      '',
      'Add page B.',
      '',
      attribution,
      '',
      markerFor(id, publication),
    ].join('\n'));
  });

  test('disabled: blocked, with no separate creation sections substituted', async () => {
    await assertBlockedEverywhere(makeWorld(), groupedAdditions(), [GROUP_REQUIRES('docs-pair', '/runs/0/results/0')], null);
  });
});

describe('standalone file operations (A28)', () => {
  test('enabled: each distinct operation gets its own suggestion pull request; the deletion removes the file', async () => {
    const world = makeWorld();
    const outcome = await publish(world, standaloneOperations());
    assert.equal(status(outcome), 'published', markdown(outcome));
    const pulls = world.host.pulls();
    assert.deepEqual(pulls.map((p) => [p.number, p.title, p.base, p.labels]), [
      [101, 'Suggestion for #7: create docs/guide.md', HEAD_REF, ['suggestion-pr']],
      [102, 'Suggestion for #7: delete obsolete.txt', HEAD_REF, ['suggestion-pr']],
    ]);
    const [creation, deletion] = pulls;
    assert.ok(creation && deletion);
    assert.deepEqual(world.host.fileOnBranch(creation.head, 'docs/guide.md'), Buffer.from(GUIDE));
    assert.deepEqual(world.host.filesOnBranch(creation.head), new Map([...HEAD_FILES, ['docs/guide.md', '100644']]));
    assert.equal(world.host.fileOnBranch(deletion.head, 'obsolete.txt'), null);
    assert.deepEqual(world.host.filesOnBranch(deletion.head), new Map([...HEAD_FILES].filter(([p]) => p !== 'obsolete.txt')));
    assert.notEqual(identify(creation).publication, '');
    assert.equal(identify(creation).publication, identify(deletion).publication, 'one publication id for both suggestions');
    assert.notEqual(identify(creation).id, identify(deletion).id, 'distinct suggestion ids (D28)');

    const [review] = world.host.reviews();
    assert.ok(review);
    assert.equal(review.request.body.replace(REVIEW_MARKER, ''), [
      `**Suggestion pull request:** [#101](${pullUrl(101)})`,
      '',
      'Merging it into `feature/retry` applies this change:',
      '',
      '- New file `docs/guide.md`: 25 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
      '',
      '**Location:** line 1 of the proposed file',
      '',
      'Add a guide.',
      '',
      attribution,
      '',
      '---',
      '',
      `**Suggestion pull request:** [#102](${pullUrl(102)})`,
      '',
      'Merging it into `feature/retry` applies this change:',
      '',
      `- Deleted file [obsolete.txt at ${SHORT}](${blob('obsolete.txt')}): the whole file is removed`,
      '',
      'Obsolete.',
      '',
      attribution,
    ].join('\n'));
    assert.deepEqual(asArray(outcome['suggestions']).map((s) => asNumber(asRecord(s)['number'])), [101, 102]);
  });

  test('two findings carrying the identical creation share one pull request', async () => {
    const world = makeWorld();
    const sarif = document([
      result({ text: 'Add a guide.', operation: { operation: 'create', artifactIndex: 0 } }),
      result({ text: 'Yes, add it.', operation: { operation: 'create', artifactIndex: 0 } }),
    ], [created('docs/guide.md', GUIDE)]);
    assert.equal(status(await publish(world, sarif)), 'published');
    assert.equal(onlyPull(world).pull.title, 'Suggestion for #7: create docs/guide.md');
  });

  test('disabled: the review-body presentation of the file-operation contract, with no branch or pull request', async () => {
    const world = makeWorld();
    const outcome = await publish(world, standaloneOperations(), null);
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.equal(Object.hasOwn(outcome, 'suggestions'), false);
    assert.deepEqual(writes(world), [REVIEW_PATH]);
    const [review] = world.host.reviews();
    assert.ok(review);
    assert.ok(review.request.body.startsWith('**Proposed new file:** `docs/guide.md`'), review.request.body);
    assert.equal(asRecord(readJson(world.statePath))['format'], 'sarif-to-comment.publication-state');
  });
});

describe('default-off behavior is unchanged', () => {
  const plain = (): Json => document([
    result({ text: TYPO_MESSAGE, location: at('README.md', 2), fix: {
      artifactChanges: [{ artifactLocation: { uri: 'README.md' }, replacements: [{ deletedRegion: { startLine: 2, startColumn: 1, endColumn: 4 }, insertedContent: { text: 'The' } }] }],
    } }),
  ]);

  test('omitted and false settings send the identical review request and read no repository or label', async () => {
    const bodies: string[] = [];
    for (const options of [null, { allowSuggestionPullRequests: false }]) {
      const world = makeWorld();
      assert.equal(status(await publish(world, standaloneOperations(), options)), 'published');
      const [review] = world.host.reviews();
      assert.ok(review);
      bodies.push(JSON.stringify({ ...review.request, body: review.request.body.replace(REVIEW_MARKER, '') }));
      assert.equal(world.host.log().some((r) => r.path === `/repos/${OWNER}/${REPO}` || r.path.includes('/labels')), false);
      assert.deepEqual(fs.readdirSync(path.dirname(world.statePath)), ['review.json'], 'no companion state files');
    }
    assert.equal(bodies[0], bodies[1]);
  });

  test('enabled but needing no suggestion pull request: the same review and a version-1 state record', async () => {
    const disabled = makeWorld();
    const enabled = makeWorld();
    assert.equal(status(await publish(disabled, plain(), null)), 'published');
    assert.equal(status(await publish(enabled, plain())), 'published');
    const [a] = disabled.host.reviews();
    const [b] = enabled.host.reviews();
    assert.ok(a && b);
    assert.equal(b.request.body.replace(REVIEW_MARKER, ''), a.request.body.replace(REVIEW_MARKER, ''));
    assert.deepEqual(b.request.comments, a.request.comments);
    assert.equal(asRecord(readJson(enabled.statePath))['format'], 'sarif-to-comment.publication-state');
    assert.deepEqual(enabled.host.pulls(), []);
  });

  test('the old option names are unknown options, refused before any request', async () => {
    const world = makeWorld();
    await assert.rejects(publish(world, plain(), { suggestionPullRequests: true }), /unknown option suggestionPullRequests/);
    await assert.rejects(validate(world, plain(), { allowSuggestionPullRequests: true, suggestionLabel: 'suggestion-pr' }), /unknown option suggestionLabel/);
    assert.deepEqual(world.host.log(), []);
  });
});

describe('group rules (§2.3–§2.4), identical in validate and publish', () => {
  const createOp = (index: number): Json => ({ operation: 'create', artifactIndex: index });

  test('an invalid group value', async () => {
    const sarif = document([
      result({ text: 'A.', group: '', operation: createOp(0) }),
      result({ text: 'B.', group: ' padded ', operation: createOp(1) }),
    ], [created('docs/a.md', PAGE_A), created('docs/b.md', PAGE_B)]);
    const problem = (pointer: string): string =>
      `- \`suggestion-group-invalid\` at \`${pointer}\`: properties.sarifToComment.suggestionGroup must be 1-100 characters without control or invisible formatting characters or surrounding whitespace.`;
    await assertBlockedEverywhere(makeWorld(), sarif, [problem('/runs/0/results/0'), problem('/runs/0/results/1')]);
  });

  test('a member without a change, and a group of one distinct change', async () => {
    const sarif = document([
      result({ text: 'Context only.', group: 'g1', location: at('README.md', 1) }),
      result({ text: 'A.', group: 'g1', operation: createOp(0) }),
      result({ text: 'A again.', group: 'g1', operation: createOp(0) }),
    ], [created('docs/a.md', PAGE_A)]);
    await assertBlockedEverywhere(makeWorld(), sarif, [
      '- `suggestion-group-member-without-change` at `/runs/0/results/0`: The finding is in suggestion group "g1" but proposes no change; a group joins changes. Remove the finding from the group, or give it its change.',
      '- `suggestion-group-single-change` at `/runs/0/results/0`: Suggestion group "g1" holds only one distinct change; a group needs at least two changes to accept together. Remove the group, and the change is published on its own.',
    ]);
  });

  test('overlapping edits within a group, and a group edit overlapping a native suggestion', async () => {
    const sarif = document([
      result({ text: 'One.', group: 'g', location: at('README.md', 2), fix: lineFix('README.md', 2, 'The widget client, fixed.') }),
      result({ text: 'Two.', group: 'g', location: at('README.md', 2), fix: lineFix('README.md', 2, 'Another text.') }),
    ]);
    await assertBlockedEverywhere(makeWorld(), sarif, [
      '- `overlapping-replacements` at `/runs/0/results/1`: The replacement of README.md lines 2-2 overlaps a different replacement.',
    ]);
    const mixed = document([
      result({ text: 'Native.', location: at('README.md', 2), fix: lineFix('README.md', 2, 'The widget client.') }),
      result({ text: 'Grouped.', group: 'g', location: at('README.md', 2), fix: lineFix('README.md', 2, 'Other.') }),
      result({ text: 'Page.', group: 'g', operation: createOp(0) }),
    ], [created('docs/a.md', PAGE_A)]);
    await assertBlockedEverywhere(makeWorld(), mixed, [
      '- `overlapping-replacements` at `/runs/0/results/1`: The replacement of README.md lines 2-2 overlaps a different replacement.',
    ]);
  });

  test('a path changed both in a group and by a standalone suggestion', async () => {
    const sarif = document([
      result({ text: 'Replace it.', group: 'g', operation: { operation: 'delete', artifactIndex: 0 } }),
      result({ text: 'And this.', group: 'g', operation: createOp(1) }),
      result({ text: 'Delete it too.', operation: { operation: 'delete', artifactIndex: 0 } }),
    ], [{ location: { uri: 'obsolete.txt' } }, created('docs/a.md', PAGE_A)]);
    await assertBlockedEverywhere(makeWorld(), sarif, [
      '- `file-operation-conflict` at `/runs/0/results/2`: obsolete.txt already has a proposed change in another part of this review; one of them must be chosen before publication.',
    ]);
  });

  test('a located member outside its replacement lines is never moved', async () => {
    const sarif = document([
      result({ text: 'Moved?', group: 'g', location: at('src/client.ts', 1), fix: lineFix('src/client.ts', 2, RETRY) }),
      result({ text: 'Page.', group: 'g', operation: createOp(0) }),
    ], [created('docs/a.md', PAGE_A)]);
    await assertBlockedEverywhere(makeWorld(), sarif, [
      '- `fix-association-unsupported` at `/runs/0/results/0`: The result\'s location is not within its fix\'s replacement lines; presenting them together would move the feedback. Keep the correct result location and separate the feedback from this unsupported fix association.',
    ]);
  });

  test('a group member\'s first fix joins the group; its further fixes are listed as alternatives, never unioned (issue #30)', async () => {
    const alternative = '  const response = await retry(request, id);';
    const sarif = document([
      { ...result({ text: 'Two ways to retry.', group: 'g', location: at('src/client.ts', 2) }), fixes: [lineFix('src/client.ts', 2, RETRY), lineFix('src/client.ts', 2, alternative)] },
      result({ text: 'Page.', group: 'g', operation: createOp(0) }),
    ], [created('docs/a.md', PAGE_A)]);
    const world = makeWorld();
    assert.equal(status(await validate(world, sarif)), 'ready');
    const outcome = await publish(world, sarif);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const { pull, branch, id, publication } = onlyPull(world);
    assert.equal(pull.title, 'Suggestion for #7: g (2 changes)');
    // Only the first fix is committed: the alternative is never applied or unioned into the group.
    assert.deepEqual(world.host.fileOnBranch(branch, 'src/client.ts'), Buffer.from(EDITED_CLIENT));
    assert.deepEqual(world.host.fileOnBranch(branch, 'docs/a.md'), Buffer.from(PAGE_A));
    const changes = [
      `- Edited [src/client.ts line 2 at ${SHORT}](${blob('src/client.ts', '#L2')})`,
      '- New file `docs/a.md`: 17 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
    ];
    const items = [
      `**Source:** [src/client.ts line 2 at ${SHORT}](${blob('src/client.ts', '#L2')})`,
      '',
      '```',
      '  const response = await request(id);',
      '```',
      '',
      'Two ways to retry.',
      '',
      '**Alternatives to consider:**',
      '',
      '(1) Replace line 2 with:',
      '',
      '```',
      alternative,
      '```',
      '',
      attribution,
      '',
      '---',
      '',
      'Page.',
      '',
      attribution,
    ];
    assert.equal(pull.body, [
      `Suggested in a review of #7 at commit ${HEAD}.`,
      '',
      'Merging this pull request into `feature/retry` applies these 2 changes together:',
      '',
      ...changes,
      '',
      DRAFT_NOTE,
      '',
      '---',
      '',
      ...items,
      '',
      markerFor(id, publication),
    ].join('\n'));
    const [review] = world.host.reviews();
    assert.ok(review);
    assert.equal(review.request.body.replace(REVIEW_MARKER, ''), [
      `**Suggestion pull request:** [#${String(pull.number)}](${pullUrl(pull.number)})`,
      '',
      'Merging it into `feature/retry` applies these 2 changes together:',
      '',
      ...changes,
      '',
      ...items,
    ].join('\n'));
    assert.deepEqual(review.request.comments, []);
  });

  test('regression: a suggestion pull request body over 60,000 characters blocks the review; nothing is truncated', async () => {
    const message = 'x'.repeat(60_000);
    const sarif = document([result({ text: message, operation: createOp(0) })], [created('docs/guide.md', GUIDE)]);
    // The body §2.11 defines, with a marker of the same length (its ids are v4 UUIDs, 36 characters each).
    const uuid = '00000000-0000-4000-8000-000000000000';
    const body = [
      `Suggested in a review of #7 at commit ${HEAD}.`,
      '',
      'Merging this pull request into `feature/retry` applies this change:',
      '',
      '- New file `docs/guide.md`: 25 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
      '',
      DRAFT_NOTE,
      '',
      '---',
      '',
      message,
      '',
      attribution,
      '',
      markerFor(uuid, uuid),
    ].join('\n');
    assert.ok(body.length > 60_000);
    await assertBlockedEverywhere(makeWorld(), sarif, [
      `- \`suggestion-body-too-large\` at \`/runs/0/results/0\`: The suggestion pull request for the proposed change to docs/guide.md would have a ${String(body.length)}-character body; the limit is 60000. Nothing is truncated or split.`,
    ]);
  });

  test('more than ten suggestion pull requests', async () => {
    const pages = Array.from({ length: 11 }, (_, i) => created(`docs/p${String(i)}.md`, `# ${String(i)}\n`));
    const sarif = document(pages.map((_, i) => result({ text: `Page ${String(i)}.`, operation: createOp(i) })), pages);
    await assertBlockedEverywhere(makeWorld(), sarif, [
      '- `too-many-suggestion-prs`: The review needs 11 suggestion pull requests; the limit is 10. Nothing is split or dropped.',
    ]);
  });

  test('a created file over 1,000,000 bytes', async () => {
    const big = `${'x'.repeat(1_000_000)}\n`;
    const sarif = document([result({ text: 'Big.', operation: createOp(0) })], [created('docs/big.md', big)]);
    await assertBlockedEverywhere(makeWorld(), sarif, [
      '- `suggestion-file-too-large` at `/runs/0/results/0`: docs/big.md: the proposed file is 1000001 bytes; a suggestion pull request carries at most 1000000 bytes per file.',
    ]);
  });
});

describe('repository readiness (§2.5, §2.7, §2.8), identical in validate and publish', () => {
  test('a reviewed commit the branch has moved past (an ancestor of the head) proceeds on that commit (issue #28)', async () => {
    const world = makeWorld();
    const historical = {
      ...groupedAdditions(),
      runs: [{ ...asRecord(asArray(groupedAdditions()['runs'])[0]), versionControlProvenance: [{ repositoryUri: `https://github.com/${OWNER}/${REPO}`, revisionId: BASE }] }],
    };
    const assessed = await validate(world, historical, ENABLED, BASE);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.ok(markdown(assessed).includes('Publication would also create 1 draft suggestion pull request into `feature/retry`, labeled `suggestion-pr`.\n'), markdown(assessed));
    const outcome = await publish(world, historical, ENABLED, BASE);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const { pull } = onlyPull(world);
    assert.ok(pull.body.startsWith(`Suggested in a review of #7 at commit ${BASE}.\n\nMerging this pull request`), pull.body);
    assert.deepEqual(Object.values(world.host.companion().commits).map((c) => c.parents), [[BASE]]);
  });

  test('an extra label is matched as GitHub names it, and applied under that name', async () => {
    const world = makeWorld({}, repository({ labels: ['suggestion-pr', 'Proposed Change'] }));
    const outcome = await publish(world, groupedAdditions(), { allowSuggestionPullRequests: true, pullRequestLabels: ['proposed change'] });
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(onlyPull(world).pull.labels, ['suggestion-pr', 'Proposed Change']);
  });

  test('ready: validate says what would be created, using only reads', async () => {
    const world = makeWorld();
    const assessed = await validate(world, groupedCodeAndTest());
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.ok(markdown(assessed).includes('Publication would also create 1 draft suggestion pull request into `feature/retry`, labeled `suggestion-pr`.'), markdown(assessed));
    assert.deepEqual(writes(world), []);
    const two = await validate(makeWorld(), standaloneOperations());
    assert.ok(markdown(two).includes('Publication would also create 2 draft suggestion pull requests into `feature/retry`, labeled `suggestion-pr`.'), markdown(two));
  });

  test('a failing repository read: validate is incomplete and publish rejects, before any write', async () => {
    const world = makeWorld({ companion: { failRepositoryRead: true } });
    const assessed = await validate(world, groupedAdditions());
    assert.equal(status(assessed), 'incomplete', markdown(assessed));
    assert.match(markdown(assessed), /502/);
    await assert.rejects(publish(world, groupedAdditions()), /502/);
    assert.deepEqual(writes(world), []);
    assert.equal(fs.existsSync(world.statePath), false);
  });
});

describe('durable identity and recovery (§2.9–§2.10)', () => {
  const steps = [['ref', REFS], ['pull', PULLS], ['label', LABELS]] as const;

  for (const [write, pattern] of steps) {
    test(`a lost ${write} response is rediscovered at once and never resent`, async () => {
      const world = makeWorld({ companion: { loseResponse: [write] } });
      const outcome = await publish(world, groupedCodeAndTest());
      assertGroupPublished(world, outcome);
      assert.equal(count(world, 'POST', pattern), 1);
    });
  }

  test('a lost review response is recovered by marker, after every suggestion step', async () => {
    const world = makeWorld({ create: 'lose-response' });
    const outcome = await publish(world, groupedCodeAndTest());
    assertGroupPublished(world, outcome);
  });

  const delayed = [
    ['ref', REFS, { refs: 1 }, /proposal branch/],
    ['pull', PULLS, { pulls: 1 }, /suggestion pull request/],
    ['label', LABELS, { labels: 1 }, /label/],
  ] as const;
  for (const [write, pattern, hidden, named] of delayed) {
    test(`a lost ${write} response that is not yet visible: uncertain, then recovered on retry without a second write`, async () => {
      const world = makeWorld({ companion: { loseResponse: [write] } });
      world.host.hide(hidden);
      const first = await publish(world, groupedCodeAndTest());
      assert.equal(status(first), 'uncertain', markdown(first));
      assert.match(markdown(first), named);
      assert.match(markdown(first), /never sends? it again/);
      assert.equal(asString(first['statePath']), world.statePath);
      assert.equal(world.host.reviews().length, 0, 'the review waits for every suggestion');
      world.host.setConfig({ companion: {} });
      const second = await publish(world, groupedCodeAndTest());
      assertGroupPublished(world, second);
      assert.equal(count(world, 'POST', pattern), 1);
    });
  }

  test('a write that failed before GitHub stored it stays uncertain; absence never authorizes a resend', async () => {
    const world = makeWorld({ companion: { failBeforeStore: ['pull'] } });
    const first = await publish(world, groupedCodeAndTest());
    assert.equal(status(first), 'uncertain', markdown(first));
    world.host.setConfig({ companion: {} });
    const second = await publish(world, groupedCodeAndTest());
    assert.equal(status(second), 'uncertain', markdown(second));
    assert.equal(count(world, 'POST', PULLS), 1);
    assert.deepEqual(world.host.pulls(), []);
    assert.equal(count(world, 'POST', LABELS), 0);
    assert.equal(world.host.reviews().length, 0);
  });

  test('a failure before any branch write rejects; a retry creates everything exactly once', async () => {
    const world = makeWorld({ companion: { failBeforeStore: ['commit'] } });
    await assert.rejects(publish(world, groupedCodeAndTest()), /502/);
    assert.equal(count(world, 'POST', REFS), 0);
    world.host.setConfig({ companion: {} });
    assertGroupPublished(world, await publish(world, groupedCodeAndTest()));
  });

  test('a definitive refusal stops the publication without the review; a retry reports it without any request', async () => {
    const world = makeWorld({ companion: { refuse: { pull: 422 } } });
    const first = await publish(world, groupedCodeAndTest());
    assert.equal(status(first), 'rejected', markdown(first));
    assert.match(markdown(first), /HTTP 422/);
    assert.match(markdown(first), /new state path/);
    assert.equal(world.host.reviews().length, 0);
    assert.equal(count(world, 'POST', LABELS), 0);
    const before = world.host.log().length;
    const second = await publish(world, groupedCodeAndTest());
    assert.equal(status(second), 'rejected');
    assert.equal(world.host.log().length, before, 'the recorded refusal is reported without contacting GitHub');
  });

  test('a refused branch is recorded the same way', async () => {
    const world = makeWorld({ companion: { refuse: { ref: 403 } } });
    const first = await publish(world, groupedCodeAndTest());
    assert.equal(status(first), 'rejected', markdown(first));
    assert.match(markdown(first), /HTTP 403/);
    assert.deepEqual(world.host.pulls(), []);
  });

  test('a completed publication is reported from its records without any request', async () => {
    const world = makeWorld();
    const first = await publish(world, groupedCodeAndTest());
    assertGroupPublished(world, first);
    const before = world.host.log().length;
    const again = await publish(world, groupedCodeAndTest());
    assert.equal(status(again), 'published', markdown(again));
    assert.deepEqual(again['suggestions'], first['suggestions']);
    assert.deepEqual(again['review'], first['review']);
    assert.equal(world.host.log().length, before);
  });

  test('the state is a plan at the state path with one record per step beside it, the review record unchanged in form', async () => {
    const world = makeWorld();
    await publish(world, standaloneOperations());
    const dir = path.dirname(world.statePath);
    assert.deepEqual(fs.readdirSync(dir).sort(), [
      'review.json',
      'review.json.review',
      'review.json.suggestion-1-branch',
      'review.json.suggestion-1-labels',
      'review.json.suggestion-1-pull',
      'review.json.suggestion-2-branch',
      'review.json.suggestion-2-labels',
      'review.json.suggestion-2-pull',
    ]);
    const plan = asRecord(readJson(world.statePath));
    assert.equal(plan['format'], 'sarif-to-comment.companion-publication-state');
    assert.equal(plan['version'], 1);
    assert.equal(plan['headRef'], HEAD_REF);
    assert.deepEqual(plan['labels'], ['suggestion-pr']);
    assert.equal(plan['ready'], false);
    const review = asRecord(readJson(`${world.statePath}.review`));
    assert.equal(review['format'], 'sarif-to-comment.publication-state');
    assert.equal(review['phase'], 'completed');
    for (const name of fs.readdirSync(dir).filter((n) => n.includes('suggestion-'))) {
      const step = asRecord(readJson(path.join(dir, name)));
      assert.equal(step['format'], 'sarif-to-comment.companion-step');
      assert.equal(step['phase'], 'completed');
      assert.equal(step['publication'], plan['publication']);
    }
    for (const name of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
  });

  test('concurrent publications of one state path create each object once', async () => {
    const world = makeWorld();
    const outcomes = await Promise.all([publish(world, groupedCodeAndTest()), publish(world, groupedCodeAndTest())]);
    assert.ok(outcomes.some((o) => status(o) === 'published'), outcomes.map(markdown).join('\n\n'));
    for (const o of outcomes) assert.ok(['published', 'uncertain'].includes(status(o)), markdown(o));
    assert.equal(count(world, 'POST', REFS), 1);
    assert.equal(count(world, 'POST', PULLS), 1);
    assert.equal(count(world, 'POST', LABELS), 1);
    assert.equal(count(world, 'POST', REVIEWS), 1);
    assertGroupPublished(world, await publish(world, groupedCodeAndTest()));
  });

  test('a retry with a different setting or label is refused as another publication, before any request', async () => {
    const world = makeWorld({ companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world, groupedCodeAndTest())), 'uncertain');
    const before = world.host.log().length;
    await assert.rejects(publish(world, groupedCodeAndTest(), null), /state-mismatch|different original input/);
    await assert.rejects(publish(world, groupedCodeAndTest(), { allowSuggestionPullRequests: true, pullRequestLabels: ['bug'] }), /different original input/);
    await assert.rejects(publish(world, groupedCodeAndTest(), { allowSuggestionPullRequests: true, submit: true }), /records a draft review/);
    assert.equal(world.host.log().length, before);
  });

  test('a corrupt plan or step record is never mistaken for absence', async () => {
    const world = makeWorld({ companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    await publish(world, groupedCodeAndTest());
    const stepPath = `${world.statePath}.suggestion-1-pull`;
    const original = fs.readFileSync(stepPath, 'utf8');
    fs.writeFileSync(stepPath, original.replace('"sending"', '"completed"'));
    await assert.rejects(publish(world, groupedCodeAndTest()), /state-corrupt|not a valid record/);
    fs.writeFileSync(stepPath, original);
    fs.writeFileSync(world.statePath, fs.readFileSync(world.statePath, 'utf8').replace(HEAD_REF, 'feature/other'));
    await assert.rejects(publish(world, groupedCodeAndTest()), /state-corrupt|not a valid record/);
    assert.equal(count(world, 'POST', PULLS), 1);
  });
});

describe('human changes are never repaired (§2.10, D29)', () => {
  test('a branch a person moved before its pull request: nothing is created, force-pushed or recreated', async () => {
    const world = makeWorld({ companion: { failRefReadsAfter: 1 } });
    await assert.rejects(publish(world, groupedCodeAndTest()), /502/);
    const [branch] = Object.keys(world.host.companion().refs);
    assert.ok(branch);
    world.host.setRef(branch, HEAD);
    world.host.setConfig({ companion: {} });
    const outcome = await publish(world, groupedCodeAndTest());
    assert.equal(status(outcome), 'uncertain', markdown(outcome));
    assert.match(markdown(outcome), /no longer points at the proposed commit/);
    assert.equal(count(world, 'POST', PULLS), 0);
    assert.equal(count(world, 'POST', REFS), 1);
    assert.equal(world.host.companion().refs[branch], HEAD, 'the person\'s change is kept');
  });

  test('a branch a person deleted before its pull request is not recreated', async () => {
    const world = makeWorld({ companion: { failRefReadsAfter: 1 } });
    await assert.rejects(publish(world, groupedCodeAndTest()), /502/);
    const [branch] = Object.keys(world.host.companion().refs);
    assert.ok(branch);
    world.host.setRef(branch, null);
    world.host.setConfig({ companion: {} });
    const outcome = await publish(world, groupedCodeAndTest());
    assert.equal(status(outcome), 'uncertain', markdown(outcome));
    assert.equal(count(world, 'POST', REFS), 1);
    assert.deepEqual(world.host.companion().refs, {});
  });

  test('a person pushed to the branch while its creation was unconfirmed: uncertain, never overwritten', async () => {
    const world = makeWorld({ companion: { loseResponse: ['ref'] } });
    world.host.hide({ refs: 1 });
    assert.equal(status(await publish(world, groupedCodeAndTest())), 'uncertain');
    const [branch] = Object.keys(world.host.companion().refs);
    assert.ok(branch);
    world.host.setRef(branch, HEAD);
    world.host.setConfig({ companion: {} });
    const outcome = await publish(world, groupedCodeAndTest());
    assert.equal(status(outcome), 'uncertain', markdown(outcome));
    assert.equal(world.host.companion().refs[branch], HEAD);
    assert.equal(count(world, 'POST', REFS), 1);
    assert.equal(count(world, 'POST', PULLS), 0);
  });

  test('a person edited the unconfirmed pull request but kept the marker: it is recognized and the edit is kept', async () => {
    const world = makeWorld({ companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world, groupedCodeAndTest())), 'uncertain');
    const { pull, marker } = onlyPull(world);
    const edited = `A person's own description.\n\n${marker}`;
    world.host.editPull(pull.number, { title: 'Renamed by a person', body: edited });
    world.host.setConfig({ companion: {} });
    const outcome = await publish(world, groupedCodeAndTest());
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.equal(count(world, 'POST', PULLS), 1);
    const [kept] = world.host.pulls();
    assert.ok(kept);
    assert.equal(kept.body, edited);
    assert.equal(kept.title, 'Renamed by a person');
    assert.deepEqual(kept.labels, ['suggestion-pr']);
  });

  test('a person removed the marker from the unconfirmed pull request: uncertain, never recreated', async () => {
    const world = makeWorld({ companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world, groupedCodeAndTest())), 'uncertain');
    world.host.editPull(onlyPull(world).pull.number, { body: 'No marker any more.' });
    world.host.setConfig({ companion: {} });
    const outcome = await publish(world, groupedCodeAndTest());
    assert.equal(status(outcome), 'uncertain', markdown(outcome));
    assert.equal(count(world, 'POST', PULLS), 1);
    assert.equal(world.host.reviews().length, 0);
  });

  test('a person closed the suggestion before its label and review: it is labelled and linked, never reopened', async () => {
    const world = makeWorld({ companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world, groupedCodeAndTest())), 'uncertain');
    const { pull } = onlyPull(world);
    world.host.editPull(pull.number, { state: 'closed' });
    world.host.setConfig({ companion: {} });
    const outcome = await publish(world, groupedCodeAndTest());
    assert.equal(status(outcome), 'published', markdown(outcome));
    const [closed] = world.host.pulls();
    assert.ok(closed);
    assert.equal(closed.state, 'closed');
    assert.deepEqual(closed.labels, ['suggestion-pr']);
    const [review] = world.host.reviews();
    assert.ok(review);
    assert.ok(review.request.body.startsWith(`**Suggestion pull request:** [#${String(pull.number)}]`));
  });

  test('a person removed the label while its application was unconfirmed: uncertain, never re-applied', async () => {
    const world = makeWorld({ companion: { loseResponse: ['label'] } });
    world.host.hide({ labels: 1 });
    assert.equal(status(await publish(world, groupedCodeAndTest())), 'uncertain');
    world.host.removeLabel(onlyPull(world).pull.number, 'suggestion-pr');
    world.host.setConfig({ companion: {} });
    const outcome = await publish(world, groupedCodeAndTest());
    assert.equal(status(outcome), 'uncertain', markdown(outcome));
    assert.equal(count(world, 'POST', LABELS), 1);
    assert.equal(world.host.reviews().length, 0);
  });

  test('changes after completion are not inspected', async () => {
    const world = makeWorld();
    const first = await publish(world, groupedCodeAndTest());
    const { pull, branch } = onlyPull(world);
    world.host.setRef(branch, HEAD);
    world.host.editPull(pull.number, { state: 'closed', body: 'gone' });
    world.host.removeLabel(pull.number, 'suggestion-pr');
    const before = world.host.log().length;
    const again = await publish(world, groupedCodeAndTest());
    assert.equal(status(again), 'published');
    assert.deepEqual(again['suggestions'], first['suggestions']);
    assert.equal(world.host.log().length, before);
  });
});

describe('relationship for cleanup (§2.7, §5)', () => {
  test('the body references the original without a closing keyword, and the original is never written to', async () => {
    const world = makeWorld();
    await publish(world, groupedCodeAndTest());
    const { pull } = onlyPull(world);
    assert.doesNotMatch(pull.body, /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#7\b/i);
    assert.match(pull.body, /^Suggested in a review of #7 at commit /);
    const originalWrites = world.host.log().filter((r) => r.method !== 'GET' && r.path === `/repos/${OWNER}/${REPO}/pulls/${String(PULL)}`);
    assert.deepEqual(originalWrites, []);
    assert.equal(writes(world).some((p) => p.includes(`/issues/${String(PULL)}`)), false);
  });

  test('suggestion-first discovery: labelled pull requests whose marker names the original', async () => {
    const world = makeWorld();
    await publish(world, standaloneOperations());
    const found = world.host.pulls()
      .filter((p) => p.labels.includes('suggestion-pr'))
      .map((p) => SUGGESTION_MARKER.exec(p.body))
      .map((m) => asRecord(parseJson(m?.[2] ?? 'null')))
      .map((m) => asRecord(m['original']));
    assert.deepEqual(found, [{ owner: OWNER, pullNumber: PULL, repo: REPO }, { owner: OWNER, pullNumber: PULL, repo: REPO }]);
  });
});

describe('CLI + real GitHub client over HTTP', () => {
  function cli(world: IWorld, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: world.root, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env['PATH'], GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: world.host.dir },
    });
    for (const text of [result.stdout, result.stderr]) assert.equal(text.includes(TOKEN), false, 'the token never appears');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }
  function sarifFile(world: IWorld, sarif: Json): string {
    const file = path.join(world.root, 'review.sarif');
    fs.writeFileSync(file, JSON.stringify(sarif));
    return file;
  }
  const target = ['--repo', `${OWNER}/${REPO}`, '--pull', String(PULL), '--commit', HEAD];

  test('publish --allow-suggestion-prs --format json reports the suggestion pull requests', () => {
    const world = makeWorld();
    const file = sarifFile(world, groupedCodeAndTest());
    const checked = cli(world, ['validate', '--sarif', file, ...target, '--allow-suggestion-prs']);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.ok(checked.stdout.includes('Publication would also create 1 draft suggestion pull request into `feature/retry`, labeled `suggestion-pr`.'), checked.stdout);
    const published = cli(world, ['publish', '--sarif', file, ...target, '--state', world.statePath, '--allow-suggestion-prs', '--format', 'json']);
    assert.equal(published.status, 0, published.stdout + published.stderr);
    const doc = asRecord(parseJson(published.stdout));
    assert.equal(doc['command'], 'publish');
    assert.equal(doc['status'], 'published');
    const { pull, branch } = onlyPull(world);
    assert.deepEqual(doc['suggestions'], [{ number: pull.number, url: pullUrl(pull.number), branch }]);
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'review', 'suggestions', 'statePath', 'message', 'diagnostics']);
  });

  test('the legacy flag-only form accepts the same flags, and --pr-labels adds labels', () => {
    const world = makeWorld({}, repository({ labels: ['suggestion-pr', 'proposal'] }));
    const file = sarifFile(world, groupedAdditions());
    const result = cli(world, ['--sarif', file, ...target, '--state', world.statePath, '--allow-suggestion-prs', '--pr-labels', 'proposal']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(onlyPull(world).pull.labels, ['suggestion-pr', 'proposal']);
  });

  test('without the flag a group is blocked (exit 2), naming the flag', () => {
    const world = makeWorld();
    const result = cli(world, ['publish', '--sarif', sarifFile(world, groupedAdditions()), ...target, '--state', world.statePath]);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /^## Review blocked\n/);
    assert.match(result.stderr, /\[suggestion-group-requires-suggestion-prs\][\s\S]*--allow-suggestion-prs/, 'the problem, naming the flag, is on stderr');
    assert.deepEqual(writes(world), []);
  });

  test('an uncertain companion publication exits 3; its retry exits 0', () => {
    const world = makeWorld({ companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    const file = sarifFile(world, groupedCodeAndTest());
    const args = ['publish', '--sarif', file, ...target, '--state', world.statePath, '--allow-suggestion-prs'];
    const first = cli(world, args);
    assert.equal(first.status, 3, first.stdout + first.stderr);
    world.host.setConfig({ companion: {} });
    const second = cli(world, args);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal(count(world, 'POST', PULLS), 1);
  });
});

// ---------------------------------------------------------------------------
// A single SARIF fix with several changes is already a group (issue #29): with
// suggestion pull requests allowed it becomes one suggestion pull request with
// no extra property; disallowed, it is refused naming the setting (A30).

describe('a native multi-change fix (one SARIF fix with several changes)', () => {
  const change = (uri: string, ...replacements: readonly Json[]): Json => ({ artifactLocation: { uri }, replacements });
  const replace = (region: Json, text: string): Json => ({ deletedRegion: region, insertedContent: { text } });
  const RETRY_README = 'Retry, and say so in the README.';
  const EDITED_README = '# Widgets\nThe widget client.\n';

  /** One finding whose single fix edits src/client.ts line 2 and README.md line 2 together. */
  const multiFile = (group?: string): Json => result({
    text: RETRY_README,
    location: at('src/client.ts', 2),
    fix: { artifactChanges: [change('src/client.ts', replace({ startLine: 2 }, RETRY)), change('README.md', replace({ startLine: 2 }, 'The widget client.'))] },
    ...(group === undefined ? {} : { group }),
  });

  const MULTI_CHANGES = [
    `- Edited [src/client.ts line 2 at ${SHORT}](${blob('src/client.ts', '#L2')})`,
    `- Edited [README.md line 2 at ${SHORT}](${blob('README.md', '#L2')})`,
  ];
  const MULTI_ITEM = [
    `**Source:** [src/client.ts line 2 at ${SHORT}](${blob('src/client.ts', '#L2')})`,
    '',
    '```',
    '  const response = await request(id);',
    '```',
    '',
    RETRY_README,
    '',
    attribution,
  ];

  test('enabled: several files become one draft suggestion pull request, linked from the review', async () => {
    const world = makeWorld();
    const outcome = await publish(world, document([multiFile()]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const { pull, branch, id, publication } = onlyPull(world);
    assert.equal(pull.title, 'Suggestion for #7: 2 changes');
    assert.equal(pull.base, HEAD_REF);
    assert.equal(pull.draft, true);
    assert.deepEqual(pull.labels, ['suggestion-pr']);
    assert.equal(pull.body, [
      `Suggested in a review of #7 at commit ${HEAD}.`,
      '',
      'Merging this pull request into `feature/retry` applies these 2 changes together:',
      '',
      ...MULTI_CHANGES,
      '',
      DRAFT_NOTE,
      '',
      '---',
      '',
      ...MULTI_ITEM,
      '',
      markerFor(id, publication),
    ].join('\n'));
    assert.deepEqual(world.host.fileOnBranch(branch, 'src/client.ts'), Buffer.from(EDITED_CLIENT));
    assert.deepEqual(world.host.fileOnBranch(branch, 'README.md'), Buffer.from(EDITED_README));
    assert.deepEqual(world.host.filesOnBranch(branch), HEAD_FILES, 'no file is added or removed');
    const [commit] = Object.values(world.host.companion().commits);
    assert.ok(commit);
    assert.deepEqual(commit.parents, [HEAD]);
    assert.equal(commit.message, `Suggestion for #7: 2 changes\n\nSuggested in a review of ${OWNER}/${REPO} pull request 7 at commit ${HEAD}.`);

    const [review] = world.host.reviews();
    assert.ok(review);
    assert.equal(review.request.body.replace(REVIEW_MARKER, ''), [
      `**Suggestion pull request:** [#${String(pull.number)}](${pullUrl(pull.number)})`,
      '',
      'Merging it into `feature/retry` applies these 2 changes together:',
      '',
      ...MULTI_CHANGES,
      '',
      ...MULTI_ITEM,
    ].join('\n'));
    assert.deepEqual(review.request.comments, [], 'nothing is split into native suggestions');
    assert.deepEqual(outcome['suggestions'], [{ number: pull.number, url: pullUrl(pull.number), branch }]);
  });

  test('enabled: several replacements of one file are combined in one commit of that file', async () => {
    const world = makeWorld();
    const sarif = document([result({
      text: 'Type the result.',
      location: at('src/client.ts', 3),
      fix: { artifactChanges: [change('src/client.ts',
        replace({ startLine: 1 }, 'export async function fetchWidget(id: string): Promise<string> {'),
        replace({ startLine: 3 }, '  return String(response.body);'))] },
    })]);
    const outcome = await publish(world, sarif);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const { pull, branch } = onlyPull(world);
    assert.equal(pull.title, 'Suggestion for #7: edit src/client.ts');
    assert.ok(pull.body.includes([
      'Merging this pull request into `feature/retry` applies these 2 changes together:',
      '',
      `- Edited [src/client.ts line 1 at ${SHORT}](${blob('src/client.ts', '#L1')})`,
      `- Edited [src/client.ts line 3 at ${SHORT}](${blob('src/client.ts', '#L3')})`,
    ].join('\n')), pull.body);
    assert.deepEqual(world.host.fileOnBranch(branch, 'src/client.ts'), Buffer.from([
      'export async function fetchWidget(id: string): Promise<string> {\n', CLIENT[1], '  return String(response.body);\n', CLIENT[3],
    ].join('')));
  });

  test('enabled: two replacements on one line apply together as one change of that line', async () => {
    const world = makeWorld();
    // "Teh widget client." — columns 1-3 are "Teh", 12-17 are "client" (SARIF 3.30: endColumn is exclusive).
    const sarif = document([result({
      text: 'Wording.',
      location: at('README.md', 2),
      fix: { artifactChanges: [change('README.md',
        replace({ startLine: 2, startColumn: 1, endColumn: 4 }, 'The'),
        replace({ startLine: 2, startColumn: 12, endColumn: 18 }, 'API'))] },
    })]);
    const outcome = await publish(world, sarif);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const { pull, branch } = onlyPull(world);
    assert.equal(pull.title, 'Suggestion for #7: edit README.md');
    assert.ok(pull.body.includes(`applies this change:\n\n- Edited [README.md line 2 at ${SHORT}](${blob('README.md', '#L2')})\n`), pull.body);
    assert.deepEqual(world.host.fileOnBranch(branch, 'README.md'), Buffer.from('# Widgets\nThe widget API.\n'));
  });

  test('two findings carrying the identical multi-change fix share one pull request', async () => {
    const world = makeWorld();
    const second = { ...multiFile(), message: { text: 'Agreed.' } };
    const outcome = await publish(world, document([multiFile(), second]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const { pull } = onlyPull(world);
    assert.ok(pull.body.includes(RETRY_README) && pull.body.includes('Agreed.'), pull.body);
  });

  test('a multi-change fix joined to an explicit group contributes every change to the group\'s one pull request', async () => {
    const world = makeWorld();
    const sarif = document([
      multiFile('retry-and-docs'),
      result({ text: 'Add page A.', group: 'retry-and-docs', operation: { operation: 'create', artifactIndex: 0 } }),
    ], [created('docs/a.md', PAGE_A)]);
    const outcome = await publish(world, sarif);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const { pull, branch } = onlyPull(world);
    assert.equal(pull.title, 'Suggestion for #7: retry-and-docs (3 changes)');
    assert.ok(pull.body.includes([
      'Merging this pull request into `feature/retry` applies these 3 changes together:',
      '',
      ...MULTI_CHANGES,
      '- New file `docs/a.md`: 17 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
    ].join('\n')), pull.body);
    assert.deepEqual(world.host.fileOnBranch(branch, 'README.md'), Buffer.from(EDITED_README));
    assert.deepEqual(world.host.fileOnBranch(branch, 'docs/a.md'), Buffer.from(PAGE_A));
  });

  test('disabled (the default): refused naming the setting; nothing is split or written (A30)', async () => {
    const line = '- `fix-changes-require-suggestion-prs` at `/runs/0/results/0`: The fix makes 2 changes that apply together (a SARIF fix is accepted whole), which needs a suggestion pull request. '
      + 'Enable suggestion pull requests (options.allowSuggestionPullRequests or --allow-suggestion-prs); a fix is never split into separate suggestions or published in part.';
    await assertBlockedEverywhere(makeWorld(), document([multiFile()]), [line], null);
    await assertBlockedEverywhere(makeWorld(), document([multiFile()]), [line], { allowSuggestionPullRequests: false });
  });

  test('replacements of one fix that overlap, or start at the same position, are refused (their combined effect is undefined)', async () => {
    for (const second of [replace({ startLine: 2, startColumn: 3, endColumn: 6 }, 'x'), replace({ startLine: 2, startColumn: 1, endColumn: 1 }, 'x')]) {
      const sarif = document([result({
        text: 'Clash.',
        location: at('README.md', 2),
        fix: { artifactChanges: [change('README.md', replace({ startLine: 2, startColumn: 1, endColumn: 4 }, 'The'), second)] },
      })]);
      await assertBlockedEverywhere(makeWorld(), sarif, [
        '- `fix-replacements-overlap` at `/runs/0/results/0`: Two replacements of README.md in this fix overlap or start at the same position, so their combined effect is not defined. Correct the fix.',
      ]);
    }
  });

  test('a located finding outside every change of its fix is never moved', async () => {
    const sarif = document([result({
      text: 'Where?',
      location: at('src/client.ts', 4),
      fix: { artifactChanges: [change('src/client.ts', replace({ startLine: 2 }, RETRY)), change('README.md', replace({ startLine: 2 }, 'The widget client.'))] },
    })]);
    await assertBlockedEverywhere(makeWorld(), sarif, [
      '- `fix-association-unsupported` at `/runs/0/results/0`: The result\'s location is not within its fix\'s replacement lines; presenting them together would move the feedback. Keep the correct result location and separate the feedback from this unsupported fix association.',
    ]);
  });
});

describe('the group property is `suggestionGroup` (renamed from the unreleased `acceptanceGroup`)', () => {
  test('`acceptanceGroup` is an unknown owned key: blocked, never read as a group', async () => {
    const sarif = document([
      { message: { text: 'Old name.' }, properties: { sarifToComment: { acceptanceGroup: 'g', proposedFileChanges: [{ operation: 'create', artifactIndex: 0 }] } } },
      result({ text: 'B.', operation: { operation: 'create', artifactIndex: 1 } }),
    ], [created('docs/a.md', PAGE_A), created('docs/b.md', PAGE_B)]);
    await assertBlockedEverywhere(makeWorld(), sarif, [
      '- `owned-property-invalid` at `/runs/0/results/0`: properties.sarifToComment has keys this product does not define here: acceptanceGroup.',
    ]);
  });
});
