/**
 * The suggestion pull request convention and the owner's option, label and
 * lifecycle decisions (issue #27), through the production composition: the
 * real public library and CLI with the real GitHub client (src/github.cts),
 * talking HTTP to the fake GitHub host (test/fixtures/composition). Only
 * `fetch` is replaced. The convention module's pure rules are tested
 * directly first.
 *
 * Every expected value is written by hand from
 * docs/suggestion-pr-convention.md, docs/companion-suggestion-pr-contract.md
 * (§2.2, §2.5, §2.7, §2.8, §2.11) and docs/suggestion-cleanup-contract.md
 * (§2.2.1, §2.5, §2.10): labels, branch names, marker lines, bodies, blocked
 * problems, refusals and the requests sent. Only the random suggestion and
 * batch ids and the host's pull request numbers are read back.
 *
 * The host models documented GitHub behavior; it is not evidence of live
 * GitHub behavior (see docs/suggestion-pr-convention-e2e-evidence.md).
 *
 * @see https://docs.github.com/en/rest/git/refs#get-a-reference
 * @see https://docs.github.com/en/rest/git/trees#get-a-tree
 * @see https://docs.github.com/en/rest/git/blobs#get-a-blob
 * @see https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request
 * @see https://docs.github.com/en/rest/issues/labels#add-labels-to-an-issue
 * @see https://docs.github.com/en/rest/issues/labels#get-a-label
 * @see https://docs.github.com/en/rest/issues/issues#list-repository-issues
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { createGitHubClient } from '../dist/github.cjs';
import library from '../dist/index.cjs';
import type { ICreateGitHubClientOptions, IGitHubClient } from '../dist/github.cjs';
import {
  DEFAULT_SUGGESTION_PR_LABEL,
  SUGGESTION_PR_CONFIGURATION_PATH,
  combineLabels,
  resolveCanonicalLabel,
  suggestionPrBranch,
} from '../dist/suggestion-pr-convention.cjs';
import { FakeHttpGitHub } from './fixtures/composition/fake-http-github.mts';
import type { IHttpHostConfig, IHttpRawFile, IHttpRepository } from './fixtures/composition/fake-http-github.mts';
import type { IStoredPull } from './fixtures/composition/fake-http-companion.mts';
import { asArray, asRecord, asString, parseJson, readJson } from './support/runtime-types.mts';

const CLI = path.join(import.meta.dirname, 'fixtures', 'composition', 'cli-with-fake-http.mts');
const BASE = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e';
const HEAD = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
const CONFIGURED = 'c0f1c0f1c0f1c0f1c0f1c0f1c0f1c0f1c0f1c0f1';
const OWNER = 'octo';
const REPO = 'widgets';
const PULL = 7;
const HEAD_REF = 'feature/retry';
const TOKEN = 'ghp_CONVENTION_COMPOSITION_0123456789';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const GUIDE = '# Guide\n\nUse the client.\n';
const CONFIG_PATH = '.github/suggestion-prs.json';
const LABEL_RULE = '1-50 characters without commas, control or invisible formatting characters or surrounding whitespace';
const LABELS_PATH = /\/issues\/\d+\/labels$/;
const PULLS_PATH = new RegExp(`^/repos/${OWNER}/${REPO}/pulls$`);

// ---------------------------------------------------------------------------
// The convention's pure rules

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));
const file = (text: string): { readonly branch: string; readonly content: { readonly kind: 'file'; readonly bytes: Uint8Array } } => ({
  branch: 'main', content: { kind: 'file', bytes: bytes(text) },
});

describe('the convention module (docs/suggestion-pr-convention.md)', () => {
  test('its constants are the convention\'s: label `suggestion-pr`, configuration `.github/suggestion-prs.json`', () => {
    assert.equal(DEFAULT_SUGGESTION_PR_LABEL, 'suggestion-pr');
    assert.equal(SUGGESTION_PR_CONFIGURATION_PATH, '.github/suggestion-prs.json');
  });

  test('branch: suggestion-pr/<original pull number>/<id> (§5)', () => {
    assert.equal(suggestionPrBranch(7, '0f0e0d0c-0b0a-4908-8706-050403020100'), 'suggestion-pr/7/0f0e0d0c-0b0a-4908-8706-050403020100');
  });

  const resolved: readonly (readonly [string, Parameters<typeof resolveCanonicalLabel>[0], unknown])[] = [
    ['no file: the default', { branch: 'main', content: { kind: 'absent' } }, { status: 'resolved', label: 'suggestion-pr', source: 'default', branch: 'main' }],
    ['an object without label: the default', file('{}\n'), { status: 'resolved', label: 'suggestion-pr', source: 'default', branch: 'main' }],
    ['unknown members are ignored', file('{ "other": 1 }'), { status: 'resolved', label: 'suggestion-pr', source: 'default', branch: 'main' }],
    ['a valid label', file('{ "label": "proposal" }\n'), { status: 'resolved', label: 'proposal', source: 'repository', branch: 'main' }],
    ['a label with inner spaces and case', file('{"label":"Proposed Change"}'), { status: 'resolved', label: 'Proposed Change', source: 'repository', branch: 'main' }],
    ['a leading byte-order mark is allowed', file('\uFEFF{"label":"proposal"}'), { status: 'resolved', label: 'proposal', source: 'repository', branch: 'main' }],
  ];
  for (const [what, input, expected] of resolved) {
    test(`resolves: ${what}`, () => {
      assert.deepEqual(resolveCanonicalLabel(input), expected);
    });
  }

  const invalid: readonly (readonly [string, Parameters<typeof resolveCanonicalLabel>[0], string])[] = [
    ['invalid JSON', file('{ "label": '), 'it is not valid JSON'],
    ['not UTF-8', { branch: 'main', content: { kind: 'file', bytes: new Uint8Array([0x7b, 0xff, 0x7d]) } }, 'it is not UTF-8 text'],
    ['an array', file('["suggestion-pr"]'), 'it is not a JSON object'],
    ['a string', file('"suggestion-pr"'), 'it is not a JSON object'],
    ['null', file('null'), 'it is not a JSON object'],
    ['a number label', file('{"label":5}'), 'its `label` is not a string'],
    ['a null label', file('{"label":null}'), 'its `label` is not a string'],
    ['an empty label', file('{"label":""}'), 'its `label` is empty'],
    ['a label with a comma', file('{"label":"a,b"}'), 'its `label` contains a comma, which GitHub\'s label filter reads as a list of labels'],
    ['a padded label', file('{"label":" proposal"}'), `its \`label\` is not a label name (${LABEL_RULE})`],
    ['a label of 51 characters', file(`{"label":"${'x'.repeat(51)}"}`), `its \`label\` is not a label name (${LABEL_RULE})`],
    ['a label with a control character', file('{"label":"a\\u0007b"}'), `its \`label\` is not a label name (${LABEL_RULE})`],
    ['a directory', { branch: 'main', content: { kind: 'not-a-file', entry: 'a directory', path: '.github/suggestion-prs.json' } }, 'it is a directory, not a file'],
    ['a symbolic link', { branch: 'main', content: { kind: 'not-a-file', entry: 'a symbolic link', path: '.github/suggestion-prs.json' } }, 'it is a symbolic link, not a file'],
    ['a symbolic link on the way', { branch: 'main', content: { kind: 'not-a-file', entry: 'a symbolic link', path: '.github' } }, '`.github` is a symbolic link, which is never followed'],
    ['a submodule on the way', { branch: 'main', content: { kind: 'not-a-file', entry: 'a submodule', path: '.github' } }, '`.github` is a submodule, which is never followed'],
    ['too large', { branch: 'main', content: { kind: 'too-large', size: 1_000_001 } }, 'it is larger than 1000000 bytes'],
  ];
  for (const [what, input, detail] of invalid) {
    test(`is invalid, naming the file's problem: ${what}`, () => {
      assert.deepEqual(resolveCanonicalLabel(input), { status: 'invalid', branch: 'main', detail });
    });
  }

  test('labels: the canonical label first, then extras deduplicated case-insensitively keeping the first spelling (§2.2)', () => {
    assert.deepEqual(combineLabels('suggestion-pr', []), ['suggestion-pr']);
    assert.deepEqual(combineLabels('suggestion-pr', ['team-a', 'Campaign']), ['suggestion-pr', 'team-a', 'Campaign']);
    assert.deepEqual(combineLabels('suggestion-pr', ['Suggestion-PR', 'team-a', 'TEAM-A', 'campaign', 'Campaign']), ['suggestion-pr', 'team-a', 'campaign']);
  });
});

// ---------------------------------------------------------------------------
// Composition harness

type Json = Record<string, unknown>;

/** A repository whose default branch holds `config` (text, or raw bytes and mode) at the configuration path. */
function repository(overrides: Partial<IHttpRepository> = {}, config?: string | IHttpRawFile | { readonly directory: true }): IHttpRepository {
  const baseFiles = { 'README.md': ['# Widgets\n'] };
  const configured: Partial<IHttpRepository> = config === undefined ? {} : {
    defaultBranchCommit: CONFIGURED,
    snapshots: {
      [BASE]: baseFiles,
      [HEAD]: { 'README.md': ['# Widgets\n', 'More.\n'] },
      [CONFIGURED]: typeof config === 'string'
        ? { ...baseFiles, [CONFIG_PATH]: [config] }
        : 'directory' in config ? { ...baseFiles, [`${CONFIG_PATH}/inner.json`]: ['{}\n'] } : baseFiles,
    },
    ...(typeof config === 'object' && !('directory' in config) ? { rawFiles: { [CONFIGURED]: { [CONFIG_PATH]: config } } } : {}),
  };
  return {
    destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
    commits: { base: BASE, head: HEAD },
    snapshots: { [BASE]: baseFiles, [HEAD]: { 'README.md': ['# Widgets\n', 'More.\n'] } },
    pullFiles: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: ['@@ -1 +1,2 @@\n', ' # Widgets\n', '+More.'] }],
    pull: { headRef: HEAD_REF, baseRef: 'main' },
    defaultBranch: 'main',
    labels: ['suggestion-pr', 'team-a', 'Campaign', 'proposal'],
    ...configured,
    ...overrides,
  };
}

/** One standalone creation: exactly one suggestion pull request (contract §2.4). */
function guideDocument(reviewed = HEAD): Json {
  return {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Review bot', version: '1.0.0' } },
      columnKind: 'utf16CodeUnits',
      versionControlProvenance: [{ repositoryUri: `https://github.com/${OWNER}/${REPO}`, revisionId: reviewed }],
      artifacts: [{ location: { uri: 'docs/guide.md' }, contents: { text: GUIDE }, encoding: 'utf-8' }],
      results: [{
        message: { text: 'Add a guide.' },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'docs/guide.md' }, region: { startLine: 1 } } }],
        properties: { sarifToComment: { proposedFileChanges: [{ operation: 'create', artifactIndex: 0 }] } },
      }],
    }],
  };
}

interface IWorld {
  readonly root: string;
  readonly statePath: string;
  readonly host: FakeHttpGitHub;
}

function makeWorld(repo: IHttpRepository = repository(), config: Partial<IHttpHostConfig> = {}): IWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'convention-composition-')));
  FakeHttpGitHub.create(path.join(root, 'host'), config, repo);
  fs.mkdirSync(path.join(root, 'state'));
  return { root, statePath: path.join(root, 'state', 'review.json'), host: new FakeHttpGitHub(path.join(root, 'host'), TOKEN) };
}

function internalsFor(world: IWorld): { readonly createGitHubClient: (options: ICreateGitHubClientOptions) => IGitHubClient } {
  return { createGitHubClient: (options) => createGitHubClient({ ...options, fetch: world.host.fetch }) };
}

async function call(name: 'publishSarifReview' | 'validateSarifReview' | 'closeSuggestionPullRequests', value: Json, world: IWorld): Promise<Json> {
  const operation: unknown = Reflect.get(library, name);
  if (typeof operation !== 'function') throw new assert.AssertionError({ message: `the package exports ${name}` });
  const outcome: unknown = await Reflect.apply(operation, undefined, [value, internalsFor(world)]);
  return asRecord(outcome, `the ${name} outcome`);
}

const ALLOW: Json = { allowSuggestionPullRequests: true };

function reviewInput(options: Json | null, reviewed = HEAD): Json {
  return {
    sarif: guideDocument(reviewed),
    destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
    reviewedCommit: reviewed,
    token: TOKEN,
    ...(options === null ? {} : { options }),
  };
}

const publish = (world: IWorld, options: Json | null = ALLOW, reviewed = HEAD): Promise<Json> =>
  call('publishSarifReview', { ...reviewInput(options, reviewed), statePath: world.statePath }, world);
const validate = (world: IWorld, options: Json | null = ALLOW, reviewed = HEAD): Promise<Json> =>
  call('validateSarifReview', reviewInput(options, reviewed), world);
const cleanup = (world: IWorld, extra: Json = {}): Promise<Json> =>
  call('closeSuggestionPullRequests', { repository: { owner: OWNER, repo: REPO }, token: TOKEN, ...extra }, world);

const status = (outcome: Json): string => asString(outcome['status'], 'an outcome status');
const markdown = (outcome: Json): string => asString(outcome['markdown'], 'outcome markdown');
const writes = (world: IWorld): readonly string[] =>
  world.host.log().filter((r) => r.method !== 'GET' && !(r.method === 'POST' && r.path === '/graphql')).map((r) => `${r.method} ${r.path}`);
const count = (world: IWorld, method: string, pattern: RegExp): number =>
  world.host.log().filter((r) => r.method === method && pattern.test(r.path)).length;

function onlyPull(world: IWorld): IStoredPull {
  const pulls = world.host.pulls();
  assert.equal(pulls.length, 1, 'exactly one suggestion pull request');
  const [pull] = pulls;
  assert.ok(pull);
  return pull;
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

/** Publish and validate block with identical Markdown and write nothing (validate parity). */
async function assertBlockedEverywhere(world: IWorld, lines: readonly string[], options: Json = ALLOW, reviewed = HEAD): Promise<void> {
  const assessed = await validate(world, options, reviewed);
  const published = await publish(world, options, reviewed);
  assert.equal(status(assessed), 'blocked', markdown(assessed));
  assert.equal(status(published), 'blocked', markdown(published));
  assert.equal(markdown(published), blockedMarkdown(lines));
  assert.equal(markdown(assessed), markdown(published));
  assert.deepEqual(writes(world), [], 'no write of any kind');
  assert.equal(fs.existsSync(world.statePath), false);
}

const problem = (code: string, message: string): string => `- \`${code}\`: ${message}`;
const configurationInvalid = (detail: string): string => problem('suggestion-pr-configuration-invalid',
  `The suggestion pull request configuration \`.github/suggestion-prs.json\` on the default branch \`main\` of octo/widgets is invalid: ${detail}. Fix it on the default branch; suggestion pull requests take their label from it.`);
const cleanupRefusal = (detail: string): string =>
  `The suggestion pull request configuration \`.github/suggestion-prs.json\` on the default branch \`main\` of octo/widgets is invalid: ${detail}. Fix it on the default branch, or name the label to check with label (--label).`;
const missingDefault = problem('suggestion-label-missing',
  'The label `suggestion-pr` does not exist in octo/widgets. It is the default suggestion label: create it, or name another existing label in `.github/suggestion-prs.json` on the default branch. Labels are never created automatically.');
const missingConfigured = (label: string): string => problem('suggestion-label-missing',
  `The label \`${label}\` does not exist in octo/widgets. It is the suggestion label set in \`.github/suggestion-prs.json\` on \`main\`: create it, or change that file. Labels are never created automatically.`);
const missingExtra = (label: string): string => problem('suggestion-label-missing',
  `The label \`${label}\` does not exist in octo/widgets. It was given in pullRequestLabels (--pr-labels): create it, or leave it out. Labels are never created automatically.`);

const DRAFT_NOTE = '**How this suggestion is accepted:** it is a draft pull request into `feature/retry`, the branch of #7. A draft cannot be merged: someone with write access first marks it ready for review. The author of #7 then decides whether to merge it, and #7 carries the change to its base. Once #7 is merged or closed, this pull request can be closed.';
const READY_NOTE = '**How this suggestion is accepted:** it is a pull request into `feature/retry`, the branch of #7. The author of #7 decides whether to merge it, and #7 carries the change to its base. Once #7 is merged or closed, this pull request can be closed.';

/** Contract §2.11: the guide suggestion's body, with its lifecycle note and marker. */
function expectedBody(note: string, id: string, batch: string): string {
  return [
    `Suggested in a review of #7 at commit ${HEAD}.`,
    '',
    'Merging this pull request into `feature/retry` applies this change:',
    '',
    '- New file `docs/guide.md`: 25 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
    '',
    note,
    '',
    '---',
    '',
    '**Location:** line 1 of the proposed file',
    '',
    'Add a guide.',
    '',
    '<sub>— Review bot 1.0.0</sub>',
    '',
    `<!-- suggestion-pr {"version":1,"original":{"owner":"octo","repo":"widgets","pullNumber":7},"reviewedCommit":"${HEAD}","id":"${id}","batch":"${batch}"} -->`,
  ].join('\n');
}

/** The suggestion id (from its branch) and batch (from its marker) of a created pull request. */
function identify(pull: IStoredPull): { readonly id: string; readonly batch: string } {
  const branch = new RegExp(`^suggestion-pr/7/(${UUID})$`).exec(pull.head);
  assert.ok(branch, `a convention branch: ${pull.head}`);
  const marker = /\n<!-- suggestion-pr (\{[^\n]*\}) -->$/.exec(pull.body);
  assert.ok(marker, 'the body ends with the convention marker');
  const batch = asString(asRecord(parseJson(marker[1] ?? ''))['batch']);
  assert.match(batch, new RegExp(`^${UUID}$`));
  return { id: branch[1] ?? '', batch };
}

function cli(world: IWorld, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: world.root, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env['PATH'], GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: world.host.dir },
  });
  for (const text of [result.stdout, result.stderr]) assert.equal(text.includes(TOKEN), false, 'the token never appears');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function sarifFile(world: IWorld): string {
  const target = path.join(world.root, 'review.sarif');
  fs.writeFileSync(target, JSON.stringify(guideDocument()));
  return target;
}

const TARGET = ['--repo', `${OWNER}/${REPO}`, '--pull', String(PULL), '--commit', HEAD];

// ---------------------------------------------------------------------------

describe('branch, marker and body under the convention, with the lifecycle note (§2.6, §2.7, §2.11)', () => {
  test('a draft by default: branch suggestion-pr/7/<id>, the draft lifecycle note, the marker with batch, label suggestion-pr', async () => {
    const world = makeWorld();
    const outcome = await publish(world);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const pull = onlyPull(world);
    const { id, batch } = identify(pull);
    assert.equal(pull.draft, true);
    assert.equal(pull.base, HEAD_REF);
    assert.equal(pull.title, 'Suggestion for #7: create docs/guide.md');
    assert.equal(pull.body, expectedBody(DRAFT_NOTE, id, batch));
    assert.deepEqual(pull.labels, ['suggestion-pr']);
    const plan = asRecord(readJson(world.statePath));
    assert.equal(plan['publication'], batch, 'the batch is the publication identity');
    assert.deepEqual(plan['labels'], ['suggestion-pr']);
    assert.equal(plan['ready'], false);
    assert.ok(markdown(outcome).includes(
      ['Suggestion pull requests (drafts into `feature/retry`, labeled `suggestion-pr`):', '', `- [#${String(pull.number)}](https://github.com/octo/widgets/pull/${String(pull.number)}) from \`${pull.head}\``].join('\n'),
    ), markdown(outcome));
  });

  test('nothing GitHub shows names SARIF or this tool', async () => {
    const world = makeWorld();
    await publish(world);
    const pull = onlyPull(world);
    for (const text of [pull.title, pull.body, pull.head, ...pull.labels]) {
      assert.doesNotMatch(text, /sarif|sarif-to-comment/i, text);
    }
    const [commit] = Object.values(world.host.companion().commits);
    assert.ok(commit);
    assert.doesNotMatch(commit.message, /sarif/i);
  });

  test('markSuggestionPullRequestsReady: created ready for review, with the ready lifecycle note; validate says so', async () => {
    const options = { ...ALLOW, markSuggestionPullRequestsReady: true };
    const world = makeWorld();
    const assessed = await validate(world, options);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.ok(markdown(assessed).includes('Publication would also create 1 suggestion pull request, ready for review, into `feature/retry`, labeled `suggestion-pr`.'), markdown(assessed));
    const outcome = await publish(world, options);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const pull = onlyPull(world);
    const { id, batch } = identify(pull);
    assert.equal(pull.draft, false);
    assert.equal(pull.body, expectedBody(READY_NOTE, id, batch));
    assert.equal(asRecord(readJson(world.statePath))['ready'], true);
    assert.ok(markdown(outcome).includes('Suggestion pull requests (ready for review, into `feature/retry`, labeled `suggestion-pr`):'), markdown(outcome));
  });

  test('markSuggestionPullRequestsReady: false is the draft default', async () => {
    const world = makeWorld();
    assert.equal(status(await publish(world, { ...ALLOW, markSuggestionPullRequestsReady: false })), 'published');
    assert.equal(onlyPull(world).draft, true);
  });

  test('validate describes the draft default', async () => {
    const assessed = await validate(makeWorld());
    assert.ok(markdown(assessed).includes('Publication would also create 1 draft suggestion pull request into `feature/retry`, labeled `suggestion-pr`.'), markdown(assessed));
  });
});

describe('label resolution (convention §4): publish, validate and cleanup resolve it identically', () => {
  test('no configuration file: suggestion-pr, read from the default branch through Git objects', async () => {
    const world = makeWorld();
    assert.equal(status(await publish(world)), 'published');
    assert.deepEqual(onlyPull(world).labels, ['suggestion-pr']);
    const reads = world.host.log().filter((r) => r.method === 'GET').map((r) => r.path);
    assert.ok(reads.includes(`/repos/${OWNER}/${REPO}/git/ref/heads/main`), reads.join('\n'));
    assert.equal(reads.some((r) => r.includes('/contents/')), false, 'the Contents API is never used');
  });

  test('a file without `label`: the default', async () => {
    const world = makeWorld(repository({}, '{ "other": true }\n'));
    assert.equal(status(await publish(world)), 'published');
    assert.deepEqual(onlyPull(world).labels, ['suggestion-pr']);
  });

  test('a valid file: its label, as validate, publish and cleanup all say', async () => {
    const world = makeWorld(repository({}, '{ "label": "proposal" }\n'));
    const assessed = await validate(world);
    assert.ok(markdown(assessed).includes('labeled `proposal`.'), markdown(assessed));
    assert.equal(status(await publish(world)), 'published');
    const pull = onlyPull(world);
    assert.deepEqual(pull.labels, ['proposal']);
    const swept = await cleanup(world, { dryRun: true });
    assert.ok(markdown(swept).includes('Checked the open pull requests labeled `proposal` in octo/widgets (the suggestion label set in `.github/suggestion-prs.json` on `main`).'), markdown(swept));
    assert.ok(world.host.log().some((r) => r.method === 'GET' && r.path === `/repos/${OWNER}/${REPO}/issues`), 'the sweep lists the labeled issues');
  });

  test('a pull request cannot change its own label: a configuration file only on its head branch is ignored', async () => {
    const repo = repository();
    const world = makeWorld({ ...repo, snapshots: { ...repo.snapshots, [HEAD]: { 'README.md': ['# Widgets\n', 'More.\n'], [CONFIG_PATH]: ['{ "label": "proposal" }\n'] } } });
    assert.equal(status(await publish(world)), 'published');
    assert.deepEqual(onlyPull(world).labels, ['suggestion-pr']);
  });

  const invalid: readonly (readonly [string, string | IHttpRawFile | { readonly directory: true }, string])[] = [
    ['invalid JSON', '{ "label": ', 'it is not valid JSON'],
    ['a label of the wrong type', '{ "label": ["proposal"] }', 'its `label` is not a string'],
    ['an empty label', '{ "label": "" }', 'its `label` is empty'],
    ['a label with a comma', '{ "label": "a,b" }', 'its `label` contains a comma, which GitHub\'s label filter reads as a list of labels'],
    ['JSON that is not an object', '[]', 'it is not a JSON object'],
    ['a directory at the path', { directory: true }, 'it is a directory, not a file'],
    ['a symbolic link at the path', { base64: Buffer.from('elsewhere.json').toString('base64'), mode: '120000' }, 'it is a symbolic link, not a file'],
  ];
  test('a symbolic link on the way to the file (`.github` itself): blocked, naming it, and cleanup refuses', async () => {
    const link: IHttpRawFile = { base64: Buffer.from('elsewhere').toString('base64'), mode: '120000' };
    const repo = repository();
    const world = makeWorld({ ...repo, defaultBranchCommit: CONFIGURED, snapshots: { ...repo.snapshots, [CONFIGURED]: { 'README.md': ['# Widgets\n'] } }, rawFiles: { [CONFIGURED]: { '.github': link } } });
    await assertBlockedEverywhere(world, [configurationInvalid('`.github` is a symbolic link, which is never followed')]);
    await assert.rejects(cleanup(world), (err: unknown) => err instanceof Error && err.message === cleanupRefusal('`.github` is a symbolic link, which is never followed'));
  });

  test('the repository is read once per assessment: the default branch is not read twice', async () => {
    const world = makeWorld();
    assert.equal(status(await validate(world)), 'ready');
    assert.equal(world.host.log().filter((r) => r.method === 'GET' && r.path === `/repos/${OWNER}/${REPO}`).length, 1);
  });

  for (const [what, config, detail] of invalid) {
    test(`${what}: blocked before any write in publish and validate, and cleanup refuses`, async () => {
      const world = makeWorld(repository({}, config));
      await assertBlockedEverywhere(world, [configurationInvalid(detail)]);
      await assert.rejects(cleanup(world), (err: unknown) => err instanceof Error && err.message === cleanupRefusal(detail));
      assert.deepEqual(writes(world), []);
    });
  }

  test('an invalid file is reported together with a missing extra label; the canonical label is not checked', async () => {
    const world = makeWorld(repository({}, '{ "label": "" }'));
    await assertBlockedEverywhere(world, [configurationInvalid('its `label` is empty'), missingExtra('team-b')], { ...ALLOW, pullRequestLabels: ['team-b'] });
    assert.equal(world.host.log().some((r) => r.path.endsWith('/labels/suggestion-pr')), false);
  });

  for (const failure of ['forbidden', 'server-error', 'network'] as const) {
    test(`a failed read (${failure}) is never a silent default: validate is incomplete, publish and cleanup reject, nothing is written`, async () => {
      const world = makeWorld(repository(), { companion: { defaultBranchRead: failure } });
      const assessed = await validate(world);
      assert.equal(status(assessed), 'incomplete', markdown(assessed));
      await assert.rejects(publish(world));
      await assert.rejects(cleanup(world));
      assert.deepEqual(writes(world), []);
      assert.equal(fs.existsSync(world.statePath), false);
      assert.deepEqual(world.host.pulls(), []);
      assert.equal(world.host.log().some((r) => r.path === `/repos/${OWNER}/${REPO}/issues`), false, 'cleanup lists nothing without its label');
    });
  }

  test('the configuration is read only when the review needs a suggestion pull request', async () => {
    const world = makeWorld(repository(), { companion: { defaultBranchRead: 'server-error' } });
    const plain = { ...guideDocument(), runs: [{ ...asRecord(asArray(guideDocument()['runs'])[0]), artifacts: [], results: [{ message: { text: 'Fine.' } }] }] };
    const outcome = await call('publishSarifReview', { ...reviewInput(ALLOW), sarif: plain, statePath: world.statePath }, world);
    assert.equal(status(outcome), 'published', markdown(outcome));
  });
});

describe('extra labels (§2.2)', () => {
  test('added in addition to the canonical label, in one request, under GitHub\'s own names', async () => {
    const world = makeWorld();
    const options = { ...ALLOW, pullRequestLabels: ['TEAM-A', 'Campaign'] };
    const assessed = await validate(world, options);
    assert.ok(markdown(assessed).includes('labeled `suggestion-pr`, `team-a` and `Campaign`.'), markdown(assessed));
    const outcome = await publish(world, options);
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(onlyPull(world).labels, ['suggestion-pr', 'team-a', 'Campaign']);
    assert.equal(count(world, 'POST', LABELS_PATH), 1);
    assert.deepEqual(asRecord(readJson(world.statePath))['labels'], ['suggestion-pr', 'team-a', 'Campaign']);
    assert.ok(markdown(outcome).includes('labeled `suggestion-pr`, `team-a` and `Campaign`):'), markdown(outcome));
  });

  test('deduplicated case-insensitively, among themselves and against the canonical label (listing it is harmless)', async () => {
    const world = makeWorld();
    const outcome = await publish(world, { ...ALLOW, pullRequestLabels: ['Suggestion-PR', 'team-a', 'Team-A'] });
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(onlyPull(world).labels, ['suggestion-pr', 'team-a']);
  });

  test('an empty list is the same as none', async () => {
    const world = makeWorld();
    assert.equal(status(await publish(world, { ...ALLOW, pullRequestLabels: [] })), 'published');
    assert.deepEqual(onlyPull(world).labels, ['suggestion-pr']);
  });

  test('a name with a comma, or any other invalid name, is refused before any request', async () => {
    const world = makeWorld();
    for (const call_ of [publish, validate]) {
      await assert.rejects(call_(world, { ...ALLOW, pullRequestLabels: ['team-a', 'a,b'] }), (err: unknown) =>
        err instanceof TypeError && err.message.endsWith(`options.pullRequestLabels[1] must be ${LABEL_RULE}`));
      await assert.rejects(call_(world, { ...ALLOW, pullRequestLabels: [''] }), /options\.pullRequestLabels\[0\] must be/);
      await assert.rejects(call_(world, { ...ALLOW, pullRequestLabels: 'team-a' }), /options\.pullRequestLabels must be an array of label names/);
    }
    assert.deepEqual(world.host.log(), []);
  });

  test('without the opt-in, extra labels and the ready setting are refused rather than ignored', async () => {
    const world = makeWorld();
    for (const [options, name] of [
      [{ pullRequestLabels: ['team-a'] }, 'pullRequestLabels'],
      [{ allowSuggestionPullRequests: false, pullRequestLabels: [] }, 'pullRequestLabels'],
      [{ markSuggestionPullRequestsReady: true }, 'markSuggestionPullRequestsReady'],
      [{ markSuggestionPullRequestsReady: false }, 'markSuggestionPullRequestsReady'],
    ] as const) {
      await assert.rejects(publish(world, options), (err: unknown) =>
        err instanceof TypeError && err.message === `Invalid publishSarifReview input: options.${name} applies only with options.allowSuggestionPullRequests: true`);
      await assert.rejects(validate(world, options), /applies only with options\.allowSuggestionPullRequests: true/);
    }
    await assert.rejects(publish(world, { ...ALLOW, markSuggestionPullRequestsReady: 'yes' }), /options\.markSuggestionPullRequestsReady must be a boolean/);
    await assert.rejects(publish(world, { allowSuggestionPullRequests: 'yes' }), /options\.allowSuggestionPullRequests must be a boolean/);
    assert.deepEqual(world.host.log(), []);
  });
});

describe('missing labels block the whole review before any write, and validate says the same (§2.7)', () => {
  test('a missing default canonical label', async () => {
    await assertBlockedEverywhere(makeWorld(repository({ labels: ['team-a'] })), [missingDefault]);
  });

  test('a missing configured canonical label', async () => {
    await assertBlockedEverywhere(makeWorld(repository({ labels: ['suggestion-pr'] }, '{"label":"proposal"}')), [missingConfigured('proposal')]);
  });

  test('missing extra labels, each named, together with a missing canonical label', async () => {
    const world = makeWorld(repository({ labels: ['team-a'] }));
    await assertBlockedEverywhere(world, [missingDefault, missingExtra('team-b'), missingExtra('ops')], { ...ALLOW, pullRequestLabels: ['team-a', 'team-b', 'ops'] });
  });

  test('the tool never creates a label: no label write precedes a blocked review', async () => {
    const world = makeWorld(repository({ labels: [] }));
    await validate(world);
    await publish(world);
    assert.equal(world.host.log().some((r) => r.method !== 'GET' && r.path.includes('/labels')), false);
  });
});

describe('publication identity (§2.2): every setting is bound to the state path', () => {
  test('a retry with other extra labels or another ready setting is refused before any request', async () => {
    const world = makeWorld(repository(), { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    const options = { ...ALLOW, pullRequestLabels: ['team-a'] };
    assert.equal(status(await publish(world, options)), 'uncertain');
    const before = world.host.log().length;
    for (const other of [ALLOW, { ...ALLOW, pullRequestLabels: ['Campaign'] }, { ...options, markSuggestionPullRequestsReady: true }]) {
      await assert.rejects(publish(world, other), /different original input/);
    }
    assert.equal(world.host.log().length, before);
    world.host.setConfig({ companion: {} });
    const retried = await publish(world, options);
    assert.equal(status(retried), 'published', markdown(retried));
    assert.equal(count(world, 'POST', PULLS_PATH), 1);
  });
});

describe('not yet supported: forks and non-default bases fall back as if suggestion pull requests were not allowed (§2.5, issue #37)', () => {
  /** The owner's decision on #37: the creation is proposed in the review body, with a warning naming why no suggestion pull request is made. */
  const fallbackMessage = (reason: string): string =>
    `Suggestion pull requests are allowed, but the creation of \`docs/guide.md\` is not proposed as one: ${reason}. `
    + 'It is handled as if suggestion pull requests were not allowed: the review body proposes it, with its findings.';
  const FORK = "the pull request's head branch `feature/retry` is in the fork fork-owner/widgets, and suggestion pull requests are not yet supported for a pull request from a fork";
  const BASE_BRANCH = 'the pull request merges into `release`, which is not the default branch `main` of octo/widgets, and suggestion pull requests are not yet supported for such a pull request';

  /** validate is ready and publish publishes the review alone, both with exactly this fallback warning. */
  async function assertFallsBackEverywhere(world: IWorld, reason: string): Promise<void> {
    const expected = [{
      severity: 'warning', code: 'suggestion-pr-fallback', title: 'A change is handled as if suggestion pull requests were not allowed',
      message: fallbackMessage(reason), location: { pointer: '/runs/0/results/0', path: 'docs/guide.md' },
    }];
    const assessed = await validate(world);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.deepEqual(assessed['diagnostics'], expected);
    const published = await publish(world);
    assert.equal(status(published), 'published', markdown(published));
    assert.deepEqual(published['diagnostics'], expected);
    assert.deepEqual(world.host.pulls(), []);
    assert.deepEqual(writes(world), [`POST /repos/${OWNER}/${REPO}/pulls/${String(PULL)}/reviews`], 'only the review');
  }

  test('a fork', async () => {
    await assertFallsBackEverywhere(makeWorld(repository({ pull: { headRef: HEAD_REF, baseRef: 'main', headRepo: 'fork-owner/widgets' } })), FORK);
  });

  test('a deleted head repository', async () => {
    await assertFallsBackEverywhere(makeWorld(repository({ pull: { headRef: HEAD_REF, baseRef: 'main', headRepo: null } })),
      "the pull request's head repository was deleted, so there is no branch to propose it into");
  });

  test('a base that is not the default branch', async () => {
    await assertFallsBackEverywhere(makeWorld(repository({ pull: { headRef: HEAD_REF, baseRef: 'release' } })), BASE_BRANCH);
  });

  test('the base is compared with the repository\'s actual default branch, whatever its name', async () => {
    const world = makeWorld(repository({ pull: { headRef: HEAD_REF, baseRef: 'develop' }, defaultBranch: 'develop' }));
    const outcome = await publish(world);
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.equal(onlyPull(world).base, HEAD_REF);
  });

  test('a reviewed commit the branch has moved past is proposed on, not refused (issue #28; convention §5.1)', async () => {
    const world = makeWorld();
    const assessed = await validate(world, ALLOW, BASE);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    const outcome = await publish(world, ALLOW, BASE);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const pull = onlyPull(world);
    assert.match(pull.body, new RegExp(`^Suggested in a review of #7 at commit ${BASE}\\.\\n\\nMerging this pull request`));
    assert.match(pull.body, new RegExp(`\\n<!-- suggestion-pr \\{"version":1,"original":\\{"owner":"octo","repo":"widgets","pullNumber":7\\},"reviewedCommit":"${BASE}","id":"${UUID}","batch":"${UUID}"\\} -->$`));
    const commits = Object.values(world.host.companion().commits);
    assert.deepEqual(commits.map((c) => c.parents), [[BASE]], 'the proposal is based on the reviewed commit');
  });

  test('a fork into another base: both reasons, in a fixed order; with nothing to create, permission and labels are not needed', async () => {
    const world = makeWorld(repository({ labels: [], push: false, pull: { headRef: HEAD_REF, baseRef: 'release', headRepo: 'fork-owner/widgets' } }));
    await assertFallsBackEverywhere(world, `${FORK}; ${BASE_BRANCH}`);
  });
});

describe('renamed options and flags; the old names are unknown', () => {
  test('library: suggestionPullRequests and suggestionLabel are unknown options, refused before any request', async () => {
    const world = makeWorld();
    await assert.rejects(publish(world, { suggestionPullRequests: true }), (err: unknown) =>
      err instanceof TypeError && err.message === 'Invalid publishSarifReview input: unknown option suggestionPullRequests');
    await assert.rejects(validate(world, { suggestionPullRequests: true }), (err: unknown) =>
      err instanceof TypeError && err.message === 'Invalid validateSarifReview input: unknown option suggestionPullRequests');
    await assert.rejects(publish(world, { allowSuggestionPullRequests: true, suggestionLabel: 'suggestion-pr' }), (err: unknown) =>
      err instanceof TypeError && err.message === 'Invalid publishSarifReview input: unknown option suggestionLabel');
    assert.deepEqual(world.host.log(), []);
  });

  test('CLI: --suggestion-prs and --suggestion-label are unknown options (exit 1), in every form', () => {
    const world = makeWorld();
    const sarif = sarifFile(world);
    const forms = [['validate'], ['publish', '--state', world.statePath], ['--state', world.statePath]];
    for (const form of forms) {
      const [first = '', ...rest] = form;
      const command = first.startsWith('--') ? [] : [first];
      const tail = first.startsWith('--') ? form : rest;
      const old = cli(world, [...command, '--sarif', sarif, ...TARGET, ...tail, '--suggestion-prs']);
      assert.equal(old.status, 1, old.stdout + old.stderr);
      assert.match(old.stderr, /unknown option --suggestion-prs/);
      const label = cli(world, [...command, '--sarif', sarif, ...TARGET, ...tail, '--allow-suggestion-prs', '--suggestion-label', 'x']);
      assert.equal(label.status, 1, label.stdout + label.stderr);
      assert.match(label.stderr, /unknown option --suggestion-label/);
    }
    assert.deepEqual(world.host.log(), []);
  });

  test('CLI: --allow-suggestion-prs --pr-labels --mark-suggestion-prs-ready publish a ready, labeled suggestion (JSON outcome)', () => {
    const world = makeWorld();
    const result = cli(world, ['publish', '--sarif', sarifFile(world), ...TARGET, '--state', world.statePath,
      '--allow-suggestion-prs', '--pr-labels', 'team-a, Campaign', '--mark-suggestion-prs-ready', '--format', 'json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const doc = asRecord(parseJson(result.stdout));
    assert.equal(doc['status'], 'published');
    const pull = onlyPull(world);
    assert.equal(pull.draft, false);
    assert.deepEqual(pull.labels, ['suggestion-pr', 'team-a', 'Campaign']);
    assert.deepEqual(doc['suggestions'], [{ number: pull.number, url: `https://github.com/octo/widgets/pull/${String(pull.number)}`, branch: pull.head }]);
  });

  test('CLI: the flag-only form and validate accept the new flags', () => {
    const world = makeWorld();
    const sarif = sarifFile(world);
    const checked = cli(world, ['validate', '--sarif', sarif, ...TARGET, '--allow-suggestion-prs', '--pr-labels', 'team-a']);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.ok(checked.stdout.includes('Publication would also create 1 draft suggestion pull request into `feature/retry`, labeled `suggestion-pr` and `team-a`.'), checked.stdout);
    const published = cli(world, ['--sarif', sarif, ...TARGET, '--state', world.statePath, '--allow-suggestion-prs']);
    assert.equal(published.status, 0, published.stdout + published.stderr);
    assert.deepEqual(onlyPull(world).labels, ['suggestion-pr']);
  });

  test('CLI: --pr-labels and --mark-suggestion-prs-ready need --allow-suggestion-prs; empty names are usage errors', () => {
    const world = makeWorld();
    const sarif = sarifFile(world);
    const cases: readonly (readonly [readonly string[], RegExp])[] = [
      [['--pr-labels', 'team-a'], /--pr-labels requires --allow-suggestion-prs/],
      [['--mark-suggestion-prs-ready'], /--mark-suggestion-prs-ready requires --allow-suggestion-prs/],
      [['--allow-suggestion-prs', '--pr-labels', 'a,,b'], new RegExp(`--pr-labels must be a comma-separated list of label names, each ${LABEL_RULE}`)],
      [['--allow-suggestion-prs', '--pr-labels', 'a,'], /--pr-labels must be a comma-separated list of label names/],
      [['--allow-suggestion-prs', '--pr-labels', ' , '], /--pr-labels must be a comma-separated list of label names/],
      [['--allow-suggestion-prs', '--pr-labels='], /--pr-labels requires a non-empty value/],
    ];
    for (const [flags, message] of cases) {
      for (const command of [['validate'], ['publish', '--state', world.statePath]]) {
        const [name = '', ...rest] = command;
        const result = cli(world, [name, '--sarif', sarif, ...TARGET, ...rest, ...flags]);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, message);
      }
    }
    assert.deepEqual(world.host.log(), []);
  });

  test('CLI help documents the new flags and not the old ones', () => {
    const world = makeWorld();
    for (const command of [['validate', '--help'], ['publish', '--help'], ['--help']]) {
      const help = cli(world, command);
      assert.equal(help.status, 0);
      for (const flag of ['--allow-suggestion-prs', '--pr-labels', '--mark-suggestion-prs-ready']) assert.ok(help.stdout.includes(flag), `${command.join(' ')} omits ${flag}`);
      assert.doesNotMatch(help.stdout, /--suggestion-prs\b|--suggestion-label/);
    }
  });
});

// ---------------------------------------------------------------------------
// Cleanup under the convention

const ID_OF = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function original(number: number, state: 'open' | 'merged' | 'closed'): IStoredPull {
  return {
    number, title: `Original ${String(number)}`, body: 'The original work.', head: `feature-${String(number)}`, base: 'main',
    draft: false, state: state === 'open' ? 'open' : 'closed', merged: state === 'merged', labels: [], authorId: 1,
  };
}

/** A conforming suggestion, written out from the convention's templates (§5–§7). */
function conforming(n: number, originalNumber: number, id: string, batch: string, labels: readonly string[], authorId = 4242): IStoredPull {
  const marker = `<!-- suggestion-pr {"version":1,"original":{"owner":"${OWNER}","repo":"${REPO}","pullNumber":${String(originalNumber)}},"reviewedCommit":"${HEAD}","id":"${id}","batch":"${batch}"} -->`;
  return {
    number: n,
    title: `Suggestion for #${String(originalNumber)}: create docs/${String(n)}.md`,
    body: `Suggested in a review of #${String(originalNumber)} at commit ${HEAD}.\n\nAdd the page.\n\n${marker}`,
    head: `suggestion-pr/${String(originalNumber)}/${id}`,
    base: `feature-${String(originalNumber)}`,
    draft: true, state: 'open', merged: false, labels: [...labels], authorId,
  };
}

function cleanupWorld(pulls: readonly IStoredPull[], repo: IHttpRepository = repository()): IWorld {
  const world = makeWorld(repo);
  world.host.seedPulls(pulls);
  return world;
}

function results(outcome: Json): (readonly [unknown, unknown, unknown])[] {
  return asArray(outcome['suggestions']).map((s) => {
    const entry = asRecord(s);
    return [entry['number'], entry['original'], entry['result']] as const;
  });
}

const closes = (world: IWorld): readonly string[] => writes(world).filter((w) => w.startsWith('PATCH '));

describe('cleanup under the convention (cleanup contract §2.2.1, §2.5, §2.8)', () => {
  test('acts on conforming suggestion pull requests of any tool: another tool\'s ids and batch, another author', async () => {
    const world = cleanupWorld([
      original(37, 'merged'),
      conforming(40, 37, ID_OF(40), BATCH, ['suggestion-pr']),
      conforming(41, 37, 'other-tool_1', 'nightly-run', ['suggestion-pr', 'bot'], 999),
    ]);
    const outcome = await cleanup(world);
    assert.equal(status(outcome), 'complete', markdown(outcome));
    assert.deepEqual(results(outcome), [[40, 37, 'closed'], [41, 37, 'closed']]);
    assert.deepEqual(closes(world), ['PATCH /repos/octo/widgets/pulls/40', 'PATCH /repos/octo/widgets/pulls/41']);
    assert.ok(markdown(outcome).includes('Checked the open pull requests labeled `suggestion-pr` in octo/widgets (the default suggestion label).'), markdown(outcome));
  });

  test('a pull request that does not conform is never closed: the tool-branded marker, or a branch outside the convention', async () => {
    const branded = conforming(42, 37, ID_OF(42), BATCH, ['suggestion-pr']);
    const world = cleanupWorld([
      original(37, 'merged'),
      { ...branded, body: branded.body.replace('<!-- suggestion-pr {', '<!-- sarif-to-comment:suggestion {') },
      { ...conforming(43, 37, ID_OF(43), BATCH, ['suggestion-pr']), head: `sarif-to-comment/suggestions/37/${ID_OF(43)}` },
    ]);
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[42, null, 'not-ours'], [43, 37, 'not-ours']]);
    assert.deepEqual(closes(world), []);
    assert.ok(markdown(outcome).includes('- #42: skipped, not a conforming suggestion pull request: it has the label but no suggestion marker'), markdown(outcome));
    assert.ok(markdown(outcome).includes(`- #43 (for #37): skipped, not a conforming suggestion pull request: its head branch is \`sarif-to-comment/suggestions/37/${ID_OF(43)}\`, not \`suggestion-pr/37/${ID_OF(43)}\``), markdown(outcome));
  });

  test('the configured label is swept and verified; suggestions under another label are not listed', async () => {
    const world = cleanupWorld([
      original(37, 'closed'),
      conforming(40, 37, ID_OF(40), BATCH, ['proposal']),
      conforming(41, 37, ID_OF(41), BATCH, ['suggestion-pr']),
    ], repository({}, '{"label":"proposal"}'));
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
  });

  test('--label is a migration override: it sweeps the old label, verifies with it, and does not read the configuration', async () => {
    const world = cleanupWorld([
      original(37, 'closed'),
      conforming(40, 37, ID_OF(40), BATCH, ['old-label']),
      conforming(41, 37, ID_OF(41), BATCH, ['suggestion-pr']),
    ], repository({}, '{ "label": '));
    const outcome = await cleanup(world, { label: 'old-label' });
    assert.equal(status(outcome), 'complete', markdown(outcome));
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
    assert.ok(markdown(outcome).includes('Checked the open pull requests labeled `old-label` in octo/widgets (a label given in place of the repository\'s suggestion label).'), markdown(outcome));
    assert.equal(world.host.log().some((r) => r.path.endsWith('/git/ref/heads/main')), false, 'the configuration is not read');
  });

  test('targeted mode resolves the label the same way', async () => {
    const world = cleanupWorld([
      original(37, 'closed'),
      conforming(40, 37, ID_OF(40), BATCH, ['proposal']),
    ], repository({}, '{"label":"proposal"}'));
    const outcome = await cleanup(world, { originalPullNumber: 37 });
    assert.deepEqual(results(outcome), [[40, 37, 'closed']]);
    assert.ok(markdown(outcome).includes('Checked the pull requests that reference #37 in octo/widgets; the suggestion label is `proposal` (the suggestion label set in `.github/suggestion-prs.json` on `main`).'), markdown(outcome));
  });

  test('CLI: an invalid configuration exits 1, naming the file and field; --label bypasses it', () => {
    const world = cleanupWorld([original(37, 'closed'), conforming(40, 37, ID_OF(40), BATCH, ['old-label'])], repository({}, '{"label":5}'));
    const refused = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`]);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.ok(refused.stderr.includes(cleanupRefusal('its `label` is not a string')), refused.stderr);
    assert.match(refused.stdout, /Nothing was closed\./);
    const swept = cli(world, ['close-suggestion-prs', '--repo', `${OWNER}/${REPO}`, '--label', 'old-label', '--format', 'json']);
    assert.equal(swept.status, 0, swept.stdout + swept.stderr);
    assert.deepEqual(asArray(asRecord(parseJson(swept.stdout))['suggestions']).map((s) => asRecord(s)['result']), ['closed']);
  });
});

describe('a published suggestion is what cleanup acts on (round trip)', () => {
  test('publish, end the original, and cleanup closes the conforming suggestion without touching its branch', async () => {
    const world = makeWorld();
    assert.equal(status(await publish(world, { ...ALLOW, pullRequestLabels: ['team-a'] })), 'published');
    const pull = onlyPull(world);
    world.host.seedPulls([original(PULL, 'merged')]);
    const outcome = await cleanup(world);
    assert.deepEqual(results(outcome), [[pull.number, PULL, 'closed']]);
    assert.equal(world.host.pulls().find((p) => p.number === pull.number)?.state, 'closed');
    assert.ok(Object.hasOwn(world.host.companion().refs, pull.head), 'the branch is left in place');
  });
});
