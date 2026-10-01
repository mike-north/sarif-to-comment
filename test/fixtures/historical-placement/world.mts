/**
 * Pull requests whose reviewed commit is no longer the head, for the tests of
 * historical placement, native suggestions at the reviewed commit and the
 * reviewed commit's association with the pull request
 * (docs/specification.md R13.1 and R17).
 *
 * Each world is a fake GitHub over HTTP (test/fixtures/composition) serving
 * one pull request, reached by the real public library or CLI through the
 * real GitHub client with only `fetch` replaced. The fixtures mirror the live
 * fixtures of GH-16 (docs/evidence/realignment/e1-e3-readme.md) and GH-19
 * (docs/evidence/realignment/e2-readme.md): a 20-line file whose reviewed
 * commit changes lines 5 and 6.
 * Lines 2-20 are the recorded text; line 1, which no recorded hunk shows, is a
 * heading chosen here.
 *
 * - ANCESTOR (GH-16's #44): R changes lines 5 and 6; an ordinary push then
 *   changes line 15. R is an ancestor of the head.
 * - DISCARDED (GH-16's #41): R changes lines 5 and 6; an amend replaces it
 *   with a head that keeps only line 6's change and changes line 15. The
 *   force-push event names R as its earlier head (E0). R's parent R0 changes
 *   only line 5, so R0 is within the replaced head but in no current commit.
 * - REBASED (GH-16's #42): R changes lines 5 and 6 of the sample and line 2
 *   of a second file; the base then advances (line 18) and the head is
 *   rebased onto it, keeping only line 6's change. The base advances once
 *   more afterwards, on a commit the pull request never contained.
 * - UNRELATED: a commit of another branch, which no head of the pull request
 *   ever contained (GH-16's negative controls).
 * - MOVED (the base branch moved on without the pull request): R changes
 *   lines 5 and 6 of the sample and line 2 of the notes, and an ordinary push
 *   then changes line 15. The base branch's tip T, the pull request's
 *   `base.sha`, is no longer the merge base B of the base and the head:
 *   either T cherry-picked R's lines 5 and 6 ('moved-picked'), or T inserted
 *   a line near the top of the sample ('moved-inserted'). GitHub resolves a
 *   line at R against T..R (GH-16), which differs from B..R in the sample but
 *   not in the notes, which T left alone.
 *
 * The host models documented and recorded GitHub behavior; it is not
 * evidence of live GitHub behavior.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createGitHubClient } from '../../../dist/github.cjs';
import library from '../../../dist/index.cjs';
import type { ICreateGitHubClientOptions, IGitHubClient } from '../../../dist/github.cjs';
import { FakeHttpGitHub } from '../composition/fake-http-github.mts';
import type { IHttpHostConfig, IHttpRepository } from '../composition/fake-http-github.mts';
import { diffFiles } from '../composition/unified-diff.mts';
import { asRecord, asString } from '../../support/runtime-types.mts';

export const OWNER = 'octo';
export const REPO = 'gadgets';
export const PULL = 12;
export const TOKEN = 'ghp_HISTORICAL_PLACEMENT_0123456789abcd';
export const SAMPLE = 'docs/sample.md';
export const NOTES = 'docs/notes.md';

/** The pull request's base commit before the base advanced. */
export const BASE = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
/** ANCESTOR: R, then the head after an ordinary push. */
export const ANCESTOR_R = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
export const ANCESTOR_HEAD = 'a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
/** DISCARDED: R's parent (line 5 only), R, then the amended head that replaced R. */
export const DISCARDED_R0 = 'd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0';
export const DISCARDED_R = 'd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1';
export const DISCARDED_HEAD = 'd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2';
/** REBASED: R on the old base, the advanced base, the rebased head, and a later base commit outside the pull request. */
export const REBASED_R = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
export const ADVANCED_BASE = 'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0';
export const REBASED_HEAD = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
export const LATER_BASE = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
/** A commit of another branch. */
export const UNRELATED = 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';
/** MOVED: R, the head after an ordinary push, and two base tips that moved on from B (BASE) without the pull request. */
export const MOVED_R = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1';
export const MOVED_HEAD = 'f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2';
export const TIP_PICKED = 'f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3';
export const TIP_INSERTED = 'f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4';

/** A recorded line of the fixture file (docs/evidence/realignment/e0-41-compare-e69981e-b3e3ed7.json). */
function line(n: number, text: string): string {
  return `Line ${String(n).padStart(2, '0')}: ${text}\n`;
}

/** The sample file: GH-16's 20 lines, with some replaced. */
export function sample(replaced: Readonly<Record<number, string>> = {}): string[] {
  return Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    if (n === 1) return '# Placement fixture\n';
    const own = replaced[n];
    if (own !== undefined) return line(n, own);
    return line(n, [5, 6, 15, 18].includes(n) ? 'original text.' : 'stable filler text for the experiment.');
  });
}

export const REVIEWED_5 = 'reviewed change one (added by C1).';
export const REVIEWED_6 = 'reviewed change two (added by C1).';
const NOTES_BASE = ['# Notes\n', 'First note.\n', 'Second note.\n'];
const NOTES_REVIEWED = ['# Notes\n', 'First note, reviewed.\n', 'Second note.\n'];

export const SNAPSHOTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  [BASE]: { [SAMPLE]: sample(), [NOTES]: NOTES_BASE },
  [ANCESTOR_R]: { [SAMPLE]: sample({ 5: REVIEWED_5, 6: REVIEWED_6 }), [NOTES]: NOTES_BASE },
  [ANCESTOR_HEAD]: { [SAMPLE]: sample({ 5: REVIEWED_5, 6: REVIEWED_6, 15: 'follow-up commit C2.' }), [NOTES]: NOTES_BASE },
  [DISCARDED_R0]: { [SAMPLE]: sample({ 5: REVIEWED_5 }), [NOTES]: NOTES_BASE },
  [DISCARDED_R]: { [SAMPLE]: sample({ 5: REVIEWED_5, 6: REVIEWED_6 }), [NOTES]: NOTES_BASE },
  [DISCARDED_HEAD]: { [SAMPLE]: sample({ 6: REVIEWED_6, 15: "amended unrelated change (C1')." }), [NOTES]: NOTES_BASE },
  [REBASED_R]: { [SAMPLE]: sample({ 5: REVIEWED_5, 6: REVIEWED_6 }), [NOTES]: NOTES_REVIEWED },
  [ADVANCED_BASE]: { [SAMPLE]: sample({ 18: 'base advanced (N).' }), [NOTES]: NOTES_BASE },
  [REBASED_HEAD]: { [SAMPLE]: sample({ 6: REVIEWED_6, 18: 'base advanced (N).' }), [NOTES]: NOTES_REVIEWED },
  [LATER_BASE]: { [SAMPLE]: sample({ 18: 'base advanced (N).', 20: 'base advanced again.' }), [NOTES]: NOTES_BASE },
  [UNRELATED]: { [SAMPLE]: sample(), [NOTES]: ['# Notes\n', 'First note, elsewhere.\n', 'Second note.\n'] },
  [MOVED_R]: { [SAMPLE]: sample({ 5: REVIEWED_5, 6: REVIEWED_6 }), [NOTES]: NOTES_REVIEWED },
  [MOVED_HEAD]: { [SAMPLE]: sample({ 5: REVIEWED_5, 6: REVIEWED_6, 15: 'follow-up commit C2.' }), [NOTES]: NOTES_REVIEWED },
  [TIP_PICKED]: { [SAMPLE]: sample({ 5: REVIEWED_5, 6: REVIEWED_6 }), [NOTES]: NOTES_BASE },
  [TIP_INSERTED]: { [SAMPLE]: [...sample().slice(0, 1), 'Inserted by the base.\n', ...sample().slice(1)], [NOTES]: NOTES_BASE },
};

export const PARENTS: Readonly<Record<string, readonly string[]>> = {
  [ANCESTOR_R]: [BASE],
  [ANCESTOR_HEAD]: [ANCESTOR_R],
  [DISCARDED_R0]: [BASE],
  [DISCARDED_R]: [DISCARDED_R0],
  [DISCARDED_HEAD]: [BASE],
  [REBASED_R]: [BASE],
  [ADVANCED_BASE]: [BASE],
  [REBASED_HEAD]: [ADVANCED_BASE],
  [LATER_BASE]: [ADVANCED_BASE],
  [UNRELATED]: [BASE],
  [MOVED_R]: [BASE],
  [MOVED_HEAD]: [MOVED_R],
  [TIP_PICKED]: [BASE],
  [TIP_INSERTED]: [BASE],
};

/**
 * Each world's pull request: its base commit (`base.sha`), the merge base of
 * that and the head when it differs (the base of the pull request's diff),
 * its head, and the heads force-pushes replaced.
 */
export type WorldName = 'ancestor' | 'discarded' | 'rebased' | 'moved-picked' | 'moved-inserted';
interface IWorldPull {
  readonly base: string;
  readonly mergeBase?: string;
  readonly head: string;
  readonly forcePushes: readonly (string | null)[];
}
const PULLS: Readonly<Record<WorldName, IWorldPull>> = {
  ancestor: { base: BASE, head: ANCESTOR_HEAD, forcePushes: [] },
  discarded: { base: BASE, head: DISCARDED_HEAD, forcePushes: [DISCARDED_R] },
  rebased: { base: ADVANCED_BASE, head: REBASED_HEAD, forcePushes: [REBASED_R] },
  'moved-picked': { base: TIP_PICKED, mergeBase: BASE, head: MOVED_HEAD, forcePushes: [] },
  'moved-inserted': { base: TIP_INSERTED, mergeBase: BASE, head: MOVED_HEAD, forcePushes: [] },
};

/** A snapshot's files as text. */
function texts(commit: string): Record<string, string> {
  return Object.fromEntries(Object.entries(SNAPSHOTS[commit] ?? {}).map(([p, lines]) => [p, lines.join('')]));
}

/** The repository a world serves; `forcePushes` may replace the recorded events (for example with a null `beforeCommit`). */
export function repositoryFor(name: WorldName, forcePushes?: readonly (string | null)[]): IHttpRepository {
  const pull = PULLS[name];
  return {
    destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
    commits: { base: pull.base, head: pull.head },
    snapshots: SNAPSHOTS,
    parents: PARENTS,
    forcePushes: forcePushes ?? pull.forcePushes,
    // The pull request's files run from the merge base, as GitHub shows them.
    pullFiles: diffFiles(texts(pull.mergeBase ?? pull.base), texts(pull.head)),
    pull: { headRef: 'feature/placement', baseRef: 'main' },
    defaultBranch: 'main',
  };
}

// ---------------------------------------------------------------------------
// SARIF

export type Json = Record<string, unknown>;

/** A finding at one line of a file. */
export function finding(message: string, uri: string, startLine: number, extra: Json = {}): Json {
  return { message: { text: message }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine } } }], ...extra };
}

/** A fix replacing the text of one line of a file (its terminator kept) with `text`. */
export function lineFix(uri: string, startLine: number, text: string): Json {
  return { artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion: { startLine }, insertedContent: { text } }] }] };
}

/** A SARIF document of one run whose source revision is `revision` (the reviewed commit, or the diff base for deleted lines). */
export function document(results: readonly Json[], revision?: string): Json {
  return {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Review bot', version: '1.0.0' } },
      columnKind: 'utf16CodeUnits',
      ...(revision === undefined ? {} : { versionControlProvenance: [{ repositoryUri: `https://github.com/${OWNER}/${REPO}`, revisionId: revision }] }),
      results,
    }],
  };
}

// ---------------------------------------------------------------------------
// Harness

export interface IWorld {
  readonly root: string;
  readonly statePath: string;
  readonly host: FakeHttpGitHub;
}

/** A fresh world serving one pull request. */
export function makeWorld(name: WorldName, config: Partial<IHttpHostConfig> = {}, forcePushes?: readonly (string | null)[]): IWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'historical-placement-')));
  FakeHttpGitHub.create(path.join(root, 'host'), config, repositoryFor(name, forcePushes));
  fs.mkdirSync(path.join(root, 'state'));
  return { root, statePath: path.join(root, 'state', 'review.json'), host: new FakeHttpGitHub(path.join(root, 'host'), TOKEN) };
}

function internalsFor(world: IWorld): { readonly createGitHubClient: (options: ICreateGitHubClientOptions) => IGitHubClient } {
  return { createGitHubClient: (options) => createGitHubClient({ ...options, fetch: world.host.fetch }) };
}

/** Calls the public `publishSarifReview` or `validateSarifReview` for `world` at `reviewedCommit`. */
export async function call(name: 'publishSarifReview' | 'validateSarifReview', world: IWorld, reviewedCommit: string, sarif: Json): Promise<Json> {
  const operation: unknown = Reflect.get(library, name);
  if (typeof operation !== 'function') throw new assert.AssertionError({ message: `the package exports ${name}` });
  const input: Json = {
    sarif,
    destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
    reviewedCommit,
    token: TOKEN,
    ...(name === 'publishSarifReview' ? { statePath: world.statePath } : {}),
  };
  const outcome: unknown = await Reflect.apply(operation, undefined, [input, internalsFor(world)]);
  return asRecord(outcome, `the ${name} outcome`);
}

export const publish = (world: IWorld, reviewedCommit: string, sarif: Json): Promise<Json> => call('publishSarifReview', world, reviewedCommit, sarif);
export const validate = (world: IWorld, reviewedCommit: string, sarif: Json): Promise<Json> => call('validateSarifReview', world, reviewedCommit, sarif);
export const status = (outcome: Json): string => asString(outcome['status'], 'an outcome status');
export const markdown = (outcome: Json): string => asString(outcome['markdown'], 'outcome markdown');

/** Every write the host received (anything but a GET or a GraphQL query). */
export const writes = (world: IWorld): readonly string[] =>
  world.host.log().filter((r) => r.method !== 'GET' && r.path !== '/graphql').map((r) => `${r.method} ${r.path}`);
/** Every read, in order: REST paths under the repository, and `graphql` for each GraphQL query. */
export const reads = (world: IWorld): readonly string[] =>
  world.host.log().filter((r) => r.method === 'GET' || r.path === '/graphql')
    .map((r) => (r.path === '/graphql' ? 'graphql' : r.path.replace(`/repos/${OWNER}/${REPO}`, '')));
