/**
 * Readiness assessment through the production composition: the real public
 * library and CLI with the real GitHub client (src/github.cts), talking HTTP
 * to the fake GitHub host (test/fixtures/composition/fake-http-github.mts).
 * Only `fetch` is replaced, so every request the assessment makes is the
 * product's own, and the host's request log proves which methods were used.
 *
 * What this adds to the seam-level suite (validate-sarif-review.test.mts):
 * - assessment issues only GET requests — no create-review POST and no
 *   GraphQL — while publication of the same input does POST;
 * - a credential GitHub refuses (HTTP 401) and a failing Git blob read
 *   surface from the real client as `incomplete`, where publication rejects
 *   before any write;
 * - the CLI `validate` command in both formats over the same composition.
 *
 * The host models documented GitHub behavior; it is not evidence of live
 * GitHub behavior.
 *
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://docs.github.com/en/rest/git/blobs#get-a-blob
 * @see https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api (401 Bad credentials)
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
import type { IPublishSarifReviewInput } from '../dist/publish-sarif-review.cjs';
import { FakeHttpGitHub, REPOSITORY } from './fixtures/composition/fake-http-github.mts';
import type { IHttpHostConfig } from './fixtures/composition/fake-http-github.mts';
import { asRecord, asString, parseJson, readJson } from './support/runtime-types.mts';

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'composition');
const SARIF = asRecord(readJson(path.join(FIXTURE_DIR, 'review.sarif.json')), 'the composition SARIF');
const CLI = path.join(FIXTURE_DIR, 'cli-with-fake-http.mts');
const { head: HEAD } = REPOSITORY.commits;
const { owner: OWNER, repo: REPO, pullNumber: PULL } = REPOSITORY.destination;
const TOKEN = 'ghp_VALIDATE_COMPOSITION_0123456789abcdef';
const CREATE_PATH = `/repos/${OWNER}/${REPO}/pulls/${String(PULL)}/reviews`;

interface IWorld {
  readonly root: string;
  readonly host: FakeHttpGitHub;
}

function makeWorld(config: Partial<IHttpHostConfig> = {}): IWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'validate-composition-')));
  FakeHttpGitHub.create(path.join(root, 'host'), config);
  return { root, host: new FakeHttpGitHub(path.join(root, 'host'), TOKEN) };
}

/** The private seam's client factory: the real client, with only `fetch` replaced by the host's. */
function internalsFor(world: IWorld): { readonly createGitHubClient: (options: ICreateGitHubClientOptions) => IGitHubClient } {
  return { createGitHubClient: (options) => createGitHubClient({ ...options, fetch: world.host.fetch }) };
}

/** The publication input for the composition SARIF; assessment takes the same fields without `statePath`. */
function publicationInput(token: string, statePath: string): IPublishSarifReviewInput {
  return { sarif: structuredClone(SARIF), destination: { owner: OWNER, repo: REPO, pullNumber: PULL }, reviewedCommit: HEAD, statePath, token };
}

function baseInput(token: string): Record<string, unknown> {
  return { sarif: structuredClone(SARIF), destination: { owner: OWNER, repo: REPO, pullNumber: PULL }, reviewedCommit: HEAD, token };
}

/** The public validateSarifReview with the HTTP-backed real client injected through the private seam. */
async function validate(world: IWorld, token = TOKEN): Promise<Record<string, unknown>> {
  const validateSarifReview: unknown = Reflect.get(library, 'validateSarifReview');
  if (typeof validateSarifReview !== 'function') throw new assert.AssertionError({ message: 'the package exports validateSarifReview' });
  const outcome: unknown = await Reflect.apply(validateSarifReview, undefined, [baseInput(token), internalsFor(world)]);
  return asRecord(outcome, 'the assessment outcome');
}

/** The public publisher on the same composition, with a state path inside the world. */
function publish(world: IWorld, token = TOKEN): Promise<unknown> {
  return library.publishSarifReview(
    publicationInput(token, path.join(world.root, 'state.json')),
    // @ts-expect-error -- the private internals seam is deliberately absent from the public declaration; this suite injects the HTTP-backed real client through it
    internalsFor(world),
  );
}

/** Files in the world other than the host's own directory. */
function worldFiles(world: IWorld): string[] {
  return fs.readdirSync(world.root).filter((name) => name !== 'host');
}

function assertReadOnly(world: IWorld): void {
  const methods = new Set(world.host.log().map((r) => r.method));
  assert.deepEqual([...methods], ['GET'], 'assessment issues only GET requests');
  assert.deepEqual(world.host.reviews(), [], 'no review exists on the host');
  assert.deepEqual(worldFiles(world), [], 'no local file was written');
}

describe('library assessment + real GitHub client over HTTP', () => {
  test('ready uses only GET requests, reads the authenticated user and creates nothing; publication then POSTs once', async () => {
    const world = makeWorld();
    const outcome = await validate(world);
    assert.equal(outcome['status'], 'ready', asString(outcome['markdown']));
    assertReadOnly(world);
    const paths = world.host.log().map((r) => r.path);
    assert.ok(paths.includes('/user'), "the publisher's authenticated-user check ran");
    assert.ok(paths.some((p) => p.includes('/git/blobs/')), 'source was read through Git objects');
    assert.ok(world.host.log().every((r) => r.authorized), 'every request carried the caller token');

    const published = asRecord(await publish(world), 'the publication outcome');
    assert.equal(published['status'], 'published');
    assert.equal(world.host.log().filter((r) => r.method === 'POST' && r.path === CREATE_PATH).length, 1);
  });

  test('a refused credential (HTTP 401) is incomplete; publication rejects without writing', async () => {
    const world = makeWorld({ onlyCredential: TOKEN });
    const outcome = await validate(world, 'ghp_wrong_credential_000000000000');
    assert.equal(outcome['status'], 'incomplete', asString(outcome['markdown']));
    assert.match(asString(outcome['markdown']), /401/);
    assert.equal(asString(outcome['markdown']).includes('ghp_wrong_credential_000000000000'), false, 'the credential is redacted');
    assertReadOnly(world);

    await assert.rejects(publish(world, 'ghp_wrong_credential_000000000000'), /401/);
    assert.equal(world.host.log().some((r) => r.method === 'POST'), false, 'publication wrote nothing');
    assert.deepEqual(worldFiles(world), [], 'publication created no state');
  });

  test('a failing source read is incomplete; publication rejects without writing', async () => {
    const world = makeWorld({ failBlobReads: true });
    const outcome = await validate(world);
    assert.equal(outcome['status'], 'incomplete', asString(outcome['markdown']));
    assert.match(asString(outcome['markdown']), /502/);
    assertReadOnly(world);

    await assert.rejects(publish(world), /502/);
    assert.equal(world.host.log().some((r) => r.method === 'POST'), false);
    assert.deepEqual(worldFiles(world), []);
  });
});

describe('CLI validate + real GitHub client over HTTP', () => {
  function cli(world: IWorld, args: readonly string[], token = TOKEN): { status: number | null; stdout: string; stderr: string } {
    const sarifPath = path.join(world.root, 'review.sarif');
    fs.writeFileSync(sarifPath, JSON.stringify(SARIF));
    const result = spawnSync(
      process.execPath,
      [CLI, 'validate', '--sarif', sarifPath, '--repo', `${OWNER}/${REPO}`, '--pull', String(PULL), '--commit', HEAD, ...args],
      { cwd: world.root, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env['PATH'], GH_TOKEN: token, FAKE_HTTP_GITHUB_DIR: world.host.dir } },
    );
    fs.rmSync(sarifPath);
    for (const text of [result.stdout, result.stderr]) assert.equal(text.includes(token), false, 'the token never appears');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  test('ready in JSON: exit 0, one document, only GET requests, no files', () => {
    const world = makeWorld();
    const result = cli(world, ['--format', 'json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    const doc = asRecord(parseJson(result.stdout), 'the JSON document');
    assert.deepEqual(Object.keys(doc), ['command', 'status', 'message']);
    assert.equal(doc['command'], 'validate');
    assert.equal(doc['status'], 'ready');
    assertReadOnly(world);
  });

  test('a refused credential in human form: exit 1, the explanation on stdout, nothing written', () => {
    const world = makeWorld({ onlyCredential: TOKEN });
    const result = cli(world, [], 'ghp_wrong_credential_111111111111');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /401/);
    assert.match(result.stdout, /not a verdict/i);
    assertReadOnly(world);
  });
});
