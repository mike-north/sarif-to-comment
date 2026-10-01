/**
 * The world the delivery policy's end-to-end tests share
 * (docs/delivery-policy-contract.md): a fake GitHub host over HTTP
 * (test/fixtures/composition) serving one pull request whose diff adds three
 * README lines that can each carry a native suggestion, files outside the
 * diff whose edits cannot, and — when a test gives one — the repository's
 * delivery configuration `.github/sarif-to-comment.json` on the default
 * branch; the SARIF builders those tests write their documents with; and
 * helpers that call the real public library, or run the real CLI, with only
 * `fetch` replaced.
 *
 * The host models documented GitHub behavior; it is not evidence of live
 * GitHub behavior.
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createGitHubClient } from '../../dist/github.cjs';
import library from '../../dist/index.cjs';
import type { ICreateGitHubClientOptions, IGitHubClient } from '../../dist/github.cjs';
import { FakeHttpGitHub } from '../fixtures/composition/fake-http-github.mts';
import type { IHttpHostConfig, IHttpRepository } from '../fixtures/composition/fake-http-github.mts';
import { asArray, asRecord, asString, parseJson } from './runtime-types.mts';

export const CLI = path.join(import.meta.dirname, '..', 'fixtures', 'composition', 'cli-with-fake-http.mts');
export const OWNER = 'octo';
export const REPO = 'widgets';
export const PULL = 7;
export const HEAD_REF = 'feature/retry';
export const TOKEN = 'ghp_DELIVERY_POLICY_COMPOSITION_0123456789';
/** The pull request's base. */
export const BASE = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e';
/** The pull request's head, which is the reviewed commit. */
export const HEAD = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
export const SHORT = 'feedfee';
/** The default branch's commit when a test gives the repository a delivery configuration. */
export const CONFIGURED = 'c0f1c0f1c0f1c0f1c0f1c0f1c0f1c0f1c0f1c0f1';
export const CONFIGURATION_PATH = '.github/sarif-to-comment.json';
export const REVIEW_PATH = `/repos/${OWNER}/${REPO}/pulls/${String(PULL)}/reviews`;
export const REVIEW_MARKER = /\n\n<!-- sarif-to-comment:review:[0-9a-f-]{36} -->$/;

/** README.md at the head: lines 2-4 are added by the pull request, so each can carry a native suggestion. */
export const README = ['# Widgets\n', 'Teh widget client.\n', 'Recieve updates.\n', 'Licence: MIT.\n'];
export const CLIENT = [
  'export async function fetchWidget(id: string) {\n',
  '  const response = await request(id);\n',
  '  return response.body;\n',
  '}\n',
];
/** notes.txt: twelve lines, outside the diff. */
export const NOTES = Array.from({ length: 12 }, (_, i) => `Note ${String(i + 1)}.\n`);
export const OBSOLETE = ['first\n', 'second\n'];
export const GUIDE = '# Guide\n\nUse the client.\n';
export const HELPER = 'export const retries = 1;\n';

const UNCHANGED: Readonly<Record<string, readonly string[]>> = { 'src/client.ts': CLIENT, 'notes.txt': NOTES, 'obsolete.txt': OBSOLETE };

/** The repository; `configuration` puts `.github/sarif-to-comment.json` with that text on the default branch. */
export function repository(options: { readonly configuration?: string; readonly fork?: boolean; readonly labels?: readonly string[] } = {}): IHttpRepository {
  const base = { 'README.md': ['# Widgets\n'], ...UNCHANGED };
  return {
    destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
    commits: { base: BASE, head: HEAD },
    snapshots: {
      [BASE]: base,
      [HEAD]: { 'README.md': README, ...UNCHANGED },
      ...(options.configuration === undefined ? {} : { [CONFIGURED]: { ...base, [CONFIGURATION_PATH]: [options.configuration] } }),
    },
    pullFiles: [{
      filename: 'README.md', status: 'modified', additions: 3, deletions: 0,
      patch: ['@@ -1 +1,4 @@\n', ' # Widgets\n', '+Teh widget client.\n', '+Recieve updates.\n', '+Licence: MIT.'],
    }],
    pull: { headRef: HEAD_REF, baseRef: 'main', ...(options.fork === true ? { headRepo: 'someone/widgets' } : {}) },
    defaultBranch: 'main',
    ...(options.configuration === undefined ? {} : { defaultBranchCommit: CONFIGURED }),
    labels: options.labels ?? ['bug', 'suggestion-pr', 'team-a'],
  };
}

// ---------------------------------------------------------------------------
// SARIF

export type Json = Record<string, unknown>;

export interface IResultSpec {
  readonly text: string;
  readonly group?: string;
  readonly location?: Json;
  readonly fixes?: readonly Json[];
  readonly operation?: Json;
}

export function result({ text, group, location, fixes, operation }: IResultSpec): Json {
  const owned: Json = {
    ...(group === undefined ? {} : { suggestionGroup: group }),
    ...(operation === undefined ? {} : { proposedFileChanges: [operation] }),
  };
  return {
    message: { text },
    ...(location === undefined ? {} : { locations: [{ physicalLocation: location }] }),
    ...(fixes === undefined ? {} : { fixes }),
    ...(Object.keys(owned).length === 0 ? {} : { properties: { sarifToComment: owned } }),
  };
}

export function document(results: readonly Json[], artifacts: readonly Json[] = []): Json {
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

export const at = (uri: string, startLine?: number): Json => ({ artifactLocation: { uri }, ...(startLine === undefined ? {} : { region: { startLine } }) });
/** A fix replacing line `line` of `uri` (its text, not its terminator) with `text`. */
export const lineFix = (uri: string, line: number, text: string): Json => ({
  artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion: { startLine: line }, insertedContent: { text } }] }],
});
/** One fix replacing several lines of `uri` together. */
export const linesFix = (uri: string, lines: Readonly<Record<number, string>>): Json => ({
  artifactChanges: [{
    artifactLocation: { uri },
    replacements: Object.entries(lines).map(([line, text]) => ({ deletedRegion: { startLine: Number(line) }, insertedContent: { text } })),
  }],
});
export const created = (uri: string, text: string): Json => ({ location: { uri }, contents: { text }, encoding: 'utf-8' });
export const deleted = (uri: string): Json => ({ location: { uri } });
export const create = (artifactIndex: number): Json => ({ operation: 'create', artifactIndex });
export const remove = (artifactIndex: number): Json => ({ operation: 'delete', artifactIndex });

/** The README edits a test uses: each a finding on its line with its one-change fix. */
export const TYPO = (group?: string): Json => result({ text: 'Fix the typo.', ...(group === undefined ? {} : { group }), location: at('README.md', 2), fixes: [lineFix('README.md', 2, 'The widget client.')] });
export const SPELLING = (group?: string): Json => result({ text: 'Fix the spelling.', ...(group === undefined ? {} : { group }), location: at('README.md', 3), fixes: [lineFix('README.md', 3, 'Receive updates.')] });
export const LICENSE = (group?: string): Json => result({ text: 'Use the American spelling.', ...(group === undefined ? {} : { group }), location: at('README.md', 4), fixes: [lineFix('README.md', 4, 'License: MIT.')] });
/** An edit of src/client.ts, which is not in the pull request's diff, so it cannot be a native suggestion. */
export const RETRY = (group?: string): Json => result({
  text: 'Retry once on timeout.', ...(group === undefined ? {} : { group }), location: at('src/client.ts', 2),
  fixes: [lineFix('src/client.ts', 2, '  const response = await request(id).catch(() => request(id));')],
});
/** An edit of line `line` of notes.txt (outside the diff). */
export const NOTE = (line: number, group?: string): Json => result({
  text: `Revise note ${String(line)}.`, ...(group === undefined ? {} : { group }), location: at('notes.txt', line), fixes: [lineFix('notes.txt', line, `Note ${String(line)}, revised.`)],
});

/** The obstacle a native suggestion of the src/client.ts edit has (contract §8.9). */
export const RETRY_NOT_INLINE = 'Lines 2-2 of src/client.ts cannot carry a native suggestion (file-not-in-diff).';
/** The obstacle every companion pull request of a pull request from a fork has (companion contract §2.5.1). */
export const FORK_OBSTACLE = "The pull request's head branch `feature/retry` is in the fork someone/widgets, and suggestion pull requests are not yet supported for a pull request from a fork.";

// ---------------------------------------------------------------------------
// Harness

export interface IWorld {
  readonly root: string;
  readonly statePath: string;
  readonly host: FakeHttpGitHub;
}

export function makeWorld(repo: IHttpRepository = repository(), config: Partial<IHttpHostConfig> = {}): IWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-composition-')));
  FakeHttpGitHub.create(path.join(root, 'host'), config, repo);
  fs.mkdirSync(path.join(root, 'state'));
  return { root, statePath: path.join(root, 'state', 'review.json'), host: new FakeHttpGitHub(path.join(root, 'host'), TOKEN) };
}

function internalsFor(world: IWorld): { readonly createGitHubClient: (options: ICreateGitHubClientOptions) => IGitHubClient } {
  return { createGitHubClient: (options) => createGitHubClient({ ...options, fetch: world.host.fetch }) };
}

/** Library input; `options` undefined omits the field. */
export function input(sarif: Json, options?: Json): Json {
  return {
    sarif,
    destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
    reviewedCommit: HEAD,
    token: TOKEN,
    ...(options === undefined ? {} : { options }),
  };
}

async function callLibrary(name: 'publishSarifReview' | 'validateSarifReview', value: Json, world: IWorld): Promise<Json> {
  const operation: unknown = Reflect.get(library, name);
  if (typeof operation !== 'function') throw new assert.AssertionError({ message: `the package exports ${name}` });
  const outcome: unknown = await Reflect.apply(operation, undefined, [value, internalsFor(world)]);
  return asRecord(outcome, `the ${name} outcome`);
}

export const publish = (world: IWorld, sarif: Json, options?: Json): Promise<Json> =>
  callLibrary('publishSarifReview', { ...input(sarif, options), statePath: world.statePath }, world);
export const validate = (world: IWorld, sarif: Json, options?: Json): Promise<Json> =>
  callLibrary('validateSarifReview', input(sarif, options), world);

export const status = (outcome: Json): string => asString(outcome['status'], 'an outcome status');
export const markdown = (outcome: Json): string => asString(outcome['markdown'], 'outcome markdown');
/** An outcome's diagnostics as records. */
export const diagnostics = (outcome: Json): Json[] => asArray(outcome['diagnostics'], 'diagnostics').map((d) => asRecord(d));
/** An outcome's diagnostics as [code, message] pairs, in order. */
export const coded = (outcome: Json): (readonly [unknown, unknown])[] => diagnostics(outcome).map((d) => [d['code'], d['message']] as const);

/** Every write the host received (anything but a read). */
export const writes = (world: IWorld): readonly string[] =>
  world.host.log().filter((r) => r.method !== 'GET' && !(r.method === 'POST' && r.path === '/graphql')).map((r) => `${r.method} ${r.path}`);

/** The state file as JSON. */
export const stateRecord = (world: IWorld): Json => asRecord(parseJson(fs.readFileSync(world.statePath, 'utf8')), 'the state record');

/** Git's blob id of `text`, computed from its definition. */
export function gitBlob(text: string): string {
  const bytes = Buffer.from(text);
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${String(bytes.length)}\0`), bytes])).digest('hex');
}

/** Whether the host was asked for the blob holding `text` (for example the delivery configuration). */
export const readBlobOf = (world: IWorld, text: string): boolean => world.host.log().some((r) => r.method === 'GET' && r.path.endsWith(`/git/blobs/${gitBlob(text)}`));

export const blobUrl = (file: string, anchor = ''): string => `https://github.com/${OWNER}/${REPO}/blob/${HEAD}/${file}${anchor}`;
export const pullUrl = (n: number): string => `https://github.com/${OWNER}/${REPO}/pull/${String(n)}`;
export const ATTRIBUTION = '<sub>— Review bot 1.0.0</sub>';

/** The blocked explanation both publish and validate give, from its problem lines. */
export function blockedMarkdown(lines: readonly string[]): string {
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

/** Publish and validate both block, with identical Markdown, and nothing is written. */
export async function assertBlockedEverywhere(world: IWorld, sarif: Json, options: Json | undefined, lines: readonly string[]): Promise<Json> {
  const assessed = await validate(world, sarif, options);
  const published = await publish(world, sarif, options);
  assert.equal(status(assessed), 'blocked', markdown(assessed));
  assert.equal(status(published), 'blocked', markdown(published));
  assert.equal(markdown(published), blockedMarkdown(lines));
  assert.equal(markdown(assessed), markdown(published));
  assert.deepEqual(diagnostics(assessed), diagnostics(published));
  assert.deepEqual(writes(world), [], 'no write of any kind');
  assert.equal(fs.existsSync(world.statePath), false, 'no publication state');
  return published;
}

/** The one review the host holds, without its hidden marker. */
export function onlyReview(world: IWorld): { readonly body: string; readonly comments: readonly { readonly path: string; readonly line: number; readonly side: string; readonly body: string }[] } {
  const reviews = world.host.reviews();
  assert.equal(reviews.length, 1, 'exactly one review');
  const [review] = reviews;
  assert.ok(review);
  return { body: review.request.body.replace(REVIEW_MARKER, ''), comments: review.request.comments };
}

// ---------------------------------------------------------------------------
// The command line

export interface ICliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the real CLI against `world`'s host, from `world.root`. */
export function cli(world: IWorld, args: readonly string[]): ICliRun {
  const run = spawnSync(process.execPath, [CLI, ...args], {
    cwd: world.root, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env['PATH'], GH_TOKEN: TOKEN, FAKE_HTTP_GITHUB_DIR: world.host.dir },
  });
  for (const text of [run.stdout, run.stderr]) assert.equal(text.includes(TOKEN), false, 'the token never appears');
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** Writes `sarif` into `world` and returns the publish/validate arguments that name it. */
export function target(world: IWorld, sarif: Json): string[] {
  const file = path.join(world.root, 'review.sarif');
  fs.writeFileSync(file, JSON.stringify(sarif));
  return ['--sarif', file, '--repo', `${OWNER}/${REPO}`, '--pull', String(PULL), '--commit', HEAD];
}
