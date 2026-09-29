/**
 * Proposed file creations and deletions through the production composition:
 * the real public library and CLI with the real GitHub client
 * (src/github.cts), talking HTTP to the fake GitHub host
 * (test/fixtures/composition/fake-http-github.mts). Only `fetch` is replaced.
 *
 * What this adds to the preparation-level suite (file-operations.test.mts):
 * - the exact create-review wire body for creations, an empty file and
 *   deletions of a text file, a binary file and a file over the source size
 *   limit, written by hand from docs/file-operation-publication-contract.md;
 * - the existence check through real Git tree reads: no blob of a deleted
 *   file is ever downloaded;
 * - exact-body delivery confirmation and recovery of a lost create response
 *   with proposal content in the body;
 * - `validate` reaching the same outcome as `publish` (ready, blocked with
 *   identical Markdown, or incomplete where publication rejects), through the
 *   library and the CLI.
 *
 * The host models documented GitHub behavior; it is not evidence of live
 * GitHub behavior (see docs/file-operation-publication-e2e-evidence.md).
 *
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://docs.github.com/en/rest/git/trees#get-a-tree
 * @see https://github.github.com/gfm/#fenced-code-blocks
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
import { FakeHttpGitHub, gitBlobSha } from './fixtures/composition/fake-http-github.mts';
import type { IHttpHostConfig, IHttpRepository } from './fixtures/composition/fake-http-github.mts';
import { asRecord, asString, parseJson, readJson } from './support/runtime-types.mts';

const CLI = path.join(import.meta.dirname, 'fixtures', 'composition', 'cli-with-fake-http.mts');
const BASE = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e';
const HEAD = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
const SHORT = 'feedfee';
const OWNER = 'octo';
const REPO = 'file-ops';
const PULL = 12;
const TOKEN = 'ghp_FILE_OPERATIONS_COMPOSITION_0123456789';
const CREATE_PATH = `/repos/${OWNER}/${REPO}/pulls/${String(PULL)}/reviews`;
const MARKER = /\n\n<!-- sarif-to-comment:review:[0-9a-f-]{36} -->$/;

/** Bytes that are not UTF-8 (a PNG signature followed by 0xFF). */
const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
/** One line over the client's 1,000,000-byte source limit. */
const HUGE = `${'x'.repeat(1_100_000)}\n`;

const UNCHANGED: Readonly<Record<string, readonly string[]>> = {
  'obsolete.txt': ['first line\n', 'second line\n'],
  'data/huge.csv': [HUGE],
};
const REPOSITORY: IHttpRepository = {
  destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
  commits: { base: BASE, head: HEAD },
  snapshots: {
    [BASE]: { 'README.md': ['# Widgets\n'], ...UNCHANGED },
    [HEAD]: { 'README.md': ['# Widgets\n', 'More.\n'], ...UNCHANGED },
  },
  rawFiles: {
    [BASE]: { 'assets/logo.png': { base64: LOGO.toString('base64') } },
    [HEAD]: { 'assets/logo.png': { base64: LOGO.toString('base64') } },
  },
  pullFiles: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: ['@@ -1 +1,2 @@\n', ' # Widgets\n', '+More.'] }],
};

/** Proposed content containing fences, HTML and template text (A19). */
const GUIDE = '# Guide\n\n````md\n```js\nx\n```\n````\n\n<script>alert(1)</script> {{ x }} @octocat\n';

type Json = Record<string, unknown>;

/** The SARIF: one run bound to the reviewed commit, five findings with file operations. */
function sarif({ guide = GUIDE, deletedPath = 'obsolete.txt' }: { guide?: string; deletedPath?: string } = {}): Json {
  const carrying = (text: string, operation: Json, location?: Json): Json => ({
    message: { text },
    ...(location === undefined ? {} : { locations: [{ physicalLocation: location }] }),
    properties: { sarifToComment: { proposedFileChanges: [operation] } },
  });
  return {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Doc bot', version: '1.2.0' } },
      columnKind: 'utf16CodeUnits',
      versionControlProvenance: [{ repositoryUri: `https://github.com/${OWNER}/${REPO}`, revisionId: HEAD }],
      artifacts: [
        { location: { uri: 'docs/guide.md' }, contents: { text: guide }, encoding: 'utf-8' },
        { location: { uri: 'empty.txt' }, contents: { text: '' }, encoding: 'utf-8' },
        { location: { uri: deletedPath } },
        { location: { uri: 'assets/logo.png' } },
        { location: { uri: 'data/huge.csv' } },
      ],
      results: [
        carrying('Add a guide.', { operation: 'create', artifactIndex: 0, fileMode: '100644' },
          { artifactLocation: { uri: 'docs/guide.md' }, region: { startLine: 1 } }),
        carrying('Add an empty placeholder.', { operation: 'create', artifactIndex: 1, fileMode: '100644' }),
        carrying('Obsolete.', { operation: 'delete', artifactIndex: 2 }, { artifactLocation: { uri: deletedPath } }),
        carrying('Unused image.', { operation: 'delete', artifactIndex: 3 }),
        carrying('Unused data.', { operation: 'delete', artifactIndex: 4 }),
      ],
    }],
  };
}

/** The review body the contract requires for sarif(), written by hand. */
const EXPECTED_BODY = [
  '**Proposed new file:** `docs/guide.md`',
  '',
  '**File details:** 77 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
  '',
  '`````',
  '# Guide',
  '',
  '````md',
  '```js',
  'x',
  '```',
  '````',
  '',
  '<script>alert(1)</script> {{ x }} @octocat',
  '`````',
  '',
  '**Location:** line 1 of the proposed file',
  '',
  'Add a guide.',
  '',
  '<sub>— Doc bot 1.2.0</sub>',
  '',
  '---',
  '',
  '**Proposed new file:** `empty.txt`',
  '',
  '**File details:** empty file (0 bytes) · mode 100644',
  '',
  'Add an empty placeholder.',
  '',
  '<sub>— Doc bot 1.2.0</sub>',
  '',
  '---',
  '',
  `**Proposed file deletion:** [obsolete.txt at ${SHORT}](https://github.com/${OWNER}/${REPO}/blob/${HEAD}/obsolete.txt)`,
  '',
  'The whole file is removed; this is not a proposal to empty it.',
  '',
  'Obsolete.',
  '',
  '<sub>— Doc bot 1.2.0</sub>',
  '',
  '---',
  '',
  `**Proposed file deletion:** [assets/logo.png at ${SHORT}](https://github.com/${OWNER}/${REPO}/blob/${HEAD}/assets/logo.png)`,
  '',
  'The whole file is removed; this is not a proposal to empty it.',
  '',
  'Unused image.',
  '',
  '<sub>— Doc bot 1.2.0</sub>',
  '',
  '---',
  '',
  `**Proposed file deletion:** [data/huge.csv at ${SHORT}](https://github.com/${OWNER}/${REPO}/blob/${HEAD}/data/huge.csv)`,
  '',
  'The whole file is removed; this is not a proposal to empty it.',
  '',
  'Unused data.',
  '',
  '<sub>— Doc bot 1.2.0</sub>',
].join('\n');

interface IWorld {
  readonly root: string;
  readonly statePath: string;
  readonly host: FakeHttpGitHub;
}

function makeWorld(config: Partial<IHttpHostConfig> = {}): IWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-ops-composition-')));
  FakeHttpGitHub.create(path.join(root, 'host'), config, REPOSITORY);
  return { root, statePath: path.join(root, 'state', 'review.json'), host: new FakeHttpGitHub(path.join(root, 'host'), TOKEN) };
}

function internalsFor(world: IWorld): { readonly createGitHubClient: (options: ICreateGitHubClientOptions) => IGitHubClient } {
  return { createGitHubClient: (options) => createGitHubClient({ ...options, fetch: world.host.fetch }) };
}

function baseInput(document: Json): Json {
  return { sarif: document, destination: { owner: OWNER, repo: REPO, pullNumber: PULL }, reviewedCommit: HEAD, token: TOKEN };
}

async function callLibrary(name: 'publishSarifReview' | 'validateSarifReview', input: Json, world: IWorld): Promise<Json> {
  const operation: unknown = Reflect.get(library, name);
  if (typeof operation !== 'function') throw new assert.AssertionError({ message: `the package exports ${name}` });
  const outcome: unknown = await Reflect.apply(operation, undefined, [input, internalsFor(world)]);
  return asRecord(outcome, `the ${name} outcome`);
}

const publish = (world: IWorld, document: Json = sarif()): Promise<Json> =>
  callLibrary('publishSarifReview', { ...baseInput(document), statePath: world.statePath }, world);
const validate = (world: IWorld, document: Json = sarif()): Promise<Json> => callLibrary('validateSarifReview', baseInput(document), world);

const posts = (world: IWorld): number => world.host.log().filter((r) => r.method === 'POST' && r.path === CREATE_PATH).length;
const blobReadsOf = (world: IWorld, bytes: Buffer): number => world.host.log().filter((r) => r.path.endsWith(`/git/blobs/${gitBlobSha(bytes)}`)).length;

describe('harness controls', () => {
  test('the expected body states the guide content exactly, and its byte count', () => {
    assert.equal(Buffer.byteLength(GUIDE, 'utf8'), 77);
    assert.ok(EXPECTED_BODY.includes(`\`\`\`\`\`\n${GUIDE.slice(0, -1)}\n\`\`\`\`\``));
  });
});

describe('library + real GitHub client over HTTP', () => {
  test('publishes creations, an empty file and deletions of text, binary and oversized files exactly as the contract states', async () => {
    const world = makeWorld();
    const outcome = await publish(world);
    assert.equal(outcome['status'], 'published', asString(outcome['markdown'] ?? ''));
    assert.equal(posts(world), 1);
    const [stored] = world.host.reviews();
    assert.ok(stored);
    assert.equal(stored.request.commit_id, HEAD);
    assert.deepEqual(stored.request.comments, []);
    assert.equal(Object.hasOwn(stored.request, 'event'), false, 'a draft');
    assert.match(stored.request.body, MARKER);
    assert.equal(stored.request.body.replace(MARKER, ''), EXPECTED_BODY);
    assert.equal(blobReadsOf(world, LOGO), 0, 'the binary file is never downloaded');
    assert.equal(blobReadsOf(world, Buffer.from(HUGE)), 0, 'the oversized file is never downloaded');
    assert.equal(blobReadsOf(world, Buffer.from('first line\nsecond line\n')), 0, 'a deleted text file is not read either');
    assert.equal(world.host.log().some((r) => r.path.includes('/contents/')), false);
  });

  test('validate is ready for the same input, using only GET requests', async () => {
    const world = makeWorld();
    const outcome = await validate(world);
    assert.equal(outcome['status'], 'ready', asString(outcome['markdown']));
    assert.match(asString(outcome['markdown']), /0 inline comment\(s\) and 5 general section\(s\)/);
    assert.deepEqual([...new Set(world.host.log().map((r) => r.method))], ['GET']);
    assert.deepEqual(world.host.reviews(), []);
  });

  test('a lost create response is recovered by comparing the exact proposal body, without a second create', async () => {
    const world = makeWorld({ create: 'lose-response' });
    const outcome = await publish(world);
    assert.equal(outcome['status'], 'published', asString(outcome['markdown'] ?? ''));
    assert.equal(posts(world), 1);
    const state = asRecord(readJson(world.statePath), 'the state record');
    assert.equal(asRecord(state['receipt'], 'the receipt')['via'], 'recovered');
  });

  const refusals: readonly (readonly [label: string, document: Json, code: RegExp])[] = [
    ['content with a bare CR', sarif({ guide: 'one\rtwo\n' }), /file-operation-content-unrepresentable/],
    ['a deletion of a path absent at the reviewed commit', sarif({ deletedPath: 'missing.txt' }), /file-operation-target-missing/],
  ];
  for (const [label, document, code] of refusals) {
    test(`${label}: publish and validate block with identical Markdown and nothing is written`, async () => {
      const world = makeWorld();
      const assessed = await validate(world, document);
      const published = await publish(world, document);
      assert.equal(assessed['status'], 'blocked');
      assert.equal(published['status'], 'blocked');
      assert.match(asString(published['markdown']), code);
      assert.equal(assessed['markdown'], published['markdown']);
      assert.equal(posts(world), 0);
      assert.equal(fs.existsSync(world.statePath), false);
    });
  }

  test('a failing existence check: validate is incomplete and publish rejects before any write', async () => {
    const world = makeWorld({ failTreeReads: true });
    const deletionOnly: Json = {
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'Doc bot' } },
        versionControlProvenance: [{ repositoryUri: `https://github.com/${OWNER}/${REPO}`, revisionId: HEAD }],
        artifacts: [{ location: { uri: 'assets/logo.png' } }],
        results: [{ message: { text: 'Unused image.' }, properties: { sarifToComment: { proposedFileChanges: [{ operation: 'delete', artifactIndex: 0 }] } } }],
      }],
    };
    const assessed = await validate(world, deletionOnly);
    assert.equal(assessed['status'], 'incomplete', asString(assessed['markdown']));
    assert.match(asString(assessed['markdown']), /502/);
    await assert.rejects(publish(world, deletionOnly), /502/);
    assert.equal(posts(world), 0);
    assert.equal(fs.existsSync(world.statePath), false);
  });
});

describe('CLI + real GitHub client over HTTP', () => {
  function cli(world: IWorld, command: 'publish' | 'validate', document: Json): { status: number | null; stdout: string; stderr: string } {
    const sarifPath = path.join(world.root, 'review.sarif');
    fs.writeFileSync(sarifPath, JSON.stringify(document));
    const args = [CLI, ...(command === 'validate' ? ['validate'] : []), '--sarif', sarifPath, '--repo', `${OWNER}/${REPO}`,
      '--pull', String(PULL), '--commit', HEAD, ...(command === 'publish' ? ['--state', world.statePath] : []), '--format', 'json'];
    const result = spawnSync(process.execPath, args, {
      cwd: world.root, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env['PATH'], GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: world.host.dir },
    });
    for (const text of [result.stdout, result.stderr]) assert.equal(text.includes(TOKEN), false, 'the token never appears');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  test('publish exits 0 with the exact body; validate exits 0 first', () => {
    const world = makeWorld();
    const checked = cli(world, 'validate', sarif());
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.equal(asRecord(parseJson(checked.stdout), 'validate JSON')['status'], 'ready');
    const published = cli(world, 'publish', sarif());
    assert.equal(published.status, 0, published.stdout + published.stderr);
    assert.equal(asRecord(parseJson(published.stdout), 'publish JSON')['status'], 'published');
    const [stored] = world.host.reviews();
    assert.ok(stored);
    assert.equal(stored.request.body.replace(MARKER, ''), EXPECTED_BODY);
  });

  test('refused content: publish and validate both exit 2 as blocked, and nothing is created', () => {
    const world = makeWorld();
    const document = sarif({ guide: 'mixed\r\nendings\n' });
    for (const command of ['validate', 'publish'] as const) {
      const result = cli(world, command, document);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      const doc = asRecord(parseJson(result.stdout), `${command} JSON`);
      assert.equal(doc['status'], 'blocked');
      assert.match(result.stdout, /file-operation-content-unrepresentable|cannot be shown exactly/);
    }
    assert.equal(posts(world), 0);
  });
});
