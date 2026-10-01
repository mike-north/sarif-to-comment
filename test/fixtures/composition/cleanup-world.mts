/**
 * The world of the suggestion cleanup composition tests
 * (test/cleanup-composition.test.mts, test/cleanup-scope.test.mts): one
 * repository served by the fake GitHub host (fake-http-github.mts), seeded
 * pull requests written out by hand from the suggestion pull request
 * convention's templates (docs/suggestion-pr-convention.md §5, §7), the real
 * public library and CLI with the real GitHub client, and readers of what the
 * host received. Only `fetch` is replaced.
 *
 * The repository has no configuration file, so its canonical label is the
 * default `suggestion-pr`. Suggestions are opened by the authenticated
 * account (`authorId` 4242, the host's user) unless a test says otherwise.
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createGitHubClient } from '../../../dist/github.cjs';
import library from '../../../dist/index.cjs';
import type { ICreateGitHubClientOptions, IGitHubClient } from '../../../dist/github.cjs';
import { FakeHttpGitHub } from './fake-http-github.mts';
import type { IHttpHostConfig, IHttpRepository } from './fake-http-github.mts';
import type { ICompanionConfig, IStoredPull } from './fake-http-companion.mts';
import { asArray, asRecord, asString } from '../../support/runtime-types.mts';

export const CLI = path.join(import.meta.dirname, 'cli-with-fake-http.mts');
export const OWNER = 'octo';
export const REPO = 'widgets';
export const TOKEN = 'ghp_CLEANUP_COMPOSITION_0123456789';
export const BASE = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e';
export const HEAD = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
export const BATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export function repository(): IHttpRepository {
  return {
    destination: { owner: OWNER, repo: REPO, pullNumber: 7 },
    commits: { base: BASE, head: HEAD },
    snapshots: { [BASE]: { 'README.md': ['# Widgets\n'] }, [HEAD]: { 'README.md': ['# Widgets\n'] } },
    pullFiles: [],
    labels: ['suggestion-pr'],
  };
}

// ---------------------------------------------------------------------------
// Seeded pull requests

/** The suggestion id a test gives suggestion pull request `n` (a v4 UUID). */
export const idOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The marker line of convention §7, written out from its template. */
export function markerLine(n: number, original: number, where = `"owner":"${OWNER}","repo":"${REPO}","pullNumber":${String(original)}`): string {
  return `<!-- suggestion-pr {"version":1,"original":{${where}},"reviewedCommit":"${HEAD}","id":"${idOf(n)}","batch":"${BATCH}"} -->`;
}

/** A suggestion body as the publisher writes it: the reference first, the marker last. */
export function suggestionBody(n: number, original: number): string {
  return `Suggested in a review of #${String(original)} at commit ${HEAD}.\n\nMerging this pull request into \`feature-${String(original)}\` applies this change:\n\n- New file \`docs/${String(n)}.md\`\n\n---\n\nAdd the page.\n\n${markerLine(n, original)}`;
}

export function original(number: number, state: 'open' | 'merged' | 'closed'): IStoredPull {
  return {
    number, title: `Original ${String(number)}`, body: 'The original work.', head: `feature-${String(number)}`, base: 'main',
    draft: false, state: state === 'open' ? 'open' : 'closed', merged: state === 'merged', labels: [], authorId: 1,
  };
}

export function suggestion(n: number, originalNumber: number, change: Partial<IStoredPull> = {}): IStoredPull {
  return {
    number: n,
    title: `Suggestion for #${String(originalNumber)}: create docs/${String(n)}.md`,
    body: suggestionBody(n, originalNumber),
    head: `suggestion-pr/${String(originalNumber)}/${idOf(n)}`,
    base: `feature-${String(originalNumber)}`,
    draft: true,
    state: 'open',
    merged: false,
    labels: ['suggestion-pr'],
    authorId: 4242,
    ...change,
  };
}

// ---------------------------------------------------------------------------
// Harness

export interface IWorld {
  readonly root: string;
  readonly host: FakeHttpGitHub;
}

export function makeWorld(pulls: readonly IStoredPull[], companion: ICompanionConfig = {}): IWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-composition-')));
  const config: Partial<IHttpHostConfig> = { companion };
  FakeHttpGitHub.create(path.join(root, 'host'), config, repository());
  const host = new FakeHttpGitHub(path.join(root, 'host'), TOKEN);
  host.seedPulls(pulls);
  return { root, host };
}

export function internalsFor(world: IWorld): { readonly createGitHubClient: (options: ICreateGitHubClientOptions) => IGitHubClient } {
  return { createGitHubClient: (options) => createGitHubClient({ ...options, fetch: world.host.fetch }) };
}

export type Json = Record<string, unknown>;

export function closeOperation(): (input: unknown, internals: unknown) => Promise<unknown> {
  const operation: unknown = Reflect.get(library, 'closeSuggestionPullRequests');
  if (typeof operation !== 'function') throw new assert.AssertionError({ message: 'the package exports closeSuggestionPullRequests' });
  return async (input, internals) => {
    const outcome: unknown = await Reflect.apply(operation, undefined, [input, internals]);
    return outcome;
  };
}

export async function cleanup(world: IWorld, extra: Json = {}): Promise<Json> {
  const outcome = await closeOperation()({ repository: { owner: OWNER, repo: REPO }, token: TOKEN, ...extra }, internalsFor(world));
  return asRecord(outcome, 'the cleanup outcome');
}

/** Each reported suggestion as [number, original, result]. */
export function results(outcome: Json): (readonly [unknown, unknown, unknown])[] {
  return asArray(outcome['suggestions']).map((s) => {
    const entry = asRecord(s);
    return [entry['number'], entry['original'], entry['result']] as const;
  });
}

/** The reported entry for suggestion `n`. */
export function entry(outcome: Json, n: number): Json {
  const found = asArray(outcome['suggestions']).map((s) => asRecord(s)).find((s) => s['number'] === n);
  assert.ok(found, `suggestion #${String(n)} is reported`);
  return found;
}

/** Each resolved original as [number, state]. */
export function originals(outcome: Json): (readonly [unknown, unknown])[] {
  return asArray(outcome['originals']).map((o) => [asRecord(o)['number'], asRecord(o)['state']] as const);
}

export function markdown(outcome: Json): string {
  return asString(outcome['markdown'], 'the cleanup Markdown');
}

export const pullUrl = (n: number): string => `https://github.com/${OWNER}/${REPO}/pull/${String(n)}`;
export const PULL_PATH = new RegExp(`^/repos/${OWNER}/${REPO}/pulls/(\\d+)$`);

/** Every request that is not a read: a PATCH (close) or any other write; GraphQL queries are reads. */
export function writes(world: IWorld): readonly string[] {
  return world.host.log().filter((r) => r.method !== 'GET' && !(r.method === 'POST' && r.path === '/graphql')).map((r) => `${r.method} ${r.path}`);
}

/** Pull request numbers read with GET pulls/{n}, in order. */
export function pullReads(world: IWorld): number[] {
  return world.host.log().filter((r) => r.method === 'GET').map((r) => PULL_PATH.exec(r.path)?.[1]).filter((n) => n !== undefined).map(Number);
}

export const closes = (...numbers: readonly number[]): string[] => numbers.map((n) => `PATCH /repos/${OWNER}/${REPO}/pulls/${String(n)}`);

export function stateOf(world: IWorld, n: number): { state: string; merged: boolean; head: string } {
  const pull = world.host.pulls().find((p) => p.number === n);
  assert.ok(pull, `pull request #${String(n)} exists`);
  return { state: pull.state, merged: pull.merged, head: pull.head };
}

/** Runs the real CLI over the host (cli-with-fake-http.mts); the token must never appear in its output. */
export function cli(world: IWorld, args: readonly string[], env: Record<string, string> = { GH_TOKEN: TOKEN }): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: world.root, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env['PATH'], FAKE_HTTP_GITHUB_DIR: world.host.dir, ...env },
  });
  for (const text of [result.stdout, result.stderr]) assert.equal(text.includes(TOKEN), false, 'the token never appears');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
