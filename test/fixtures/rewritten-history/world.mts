/**
 * The rewritten-history world shared by the tests of suggestion pull requests
 * on a branch that moved after the review (issue #28) and of the fallback when
 * one cannot be re-applied (issue #37): a fake GitHub host over HTTP
 * (test/fixtures/composition) whose pull request's head is one of several
 * commits related by their parents, the SARIF document those tests review,
 * and helpers that call the real public library through the real GitHub
 * client with only `fetch` replaced.
 *
 * The scenario mirrors the live experiment (docs/force-push-experiment.md):
 * C0 adds a 20-line file, the reviewed commit C1 changes its lines 5 and 6,
 * and the pull request's branch then moves forward (C2), is amended (C1′),
 * or is rewritten so that what the suggestions touch has changed.
 *
 * The host models documented GitHub behavior; it is not evidence of live
 * GitHub behavior.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createGitHubClient } from '../../../dist/github.cjs';
import library from '../../../dist/index.cjs';
import type { ICreateGitHubClientOptions, IGitHubClient } from '../../../dist/github.cjs';
import { FakeHttpGitHub } from '../composition/fake-http-github.mts';
import type { IHttpHostConfig, IHttpPullFile, IHttpRepository } from '../composition/fake-http-github.mts';
import type { IStoredPull } from '../composition/fake-http-companion.mts';
import { asArray, asRecord, asString, parseJson } from '../../support/runtime-types.mts';

/** The CLI entry that runs the real CLI with `fetch` replaced by the fake host. */
export const CLI = path.join(import.meta.dirname, '..', 'composition', 'cli-with-fake-http.mts');
export const OWNER = 'octo';
export const REPO = 'widgets';
export const PULL = 7;
export const HEAD_REF = 'feature/retry';
export const TOKEN = 'ghp_FORCE_PUSH_COMPOSITION_0123456789';

/** C0, the pull request's base: adds docs/sample.md. */
export const BASE = 'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0';
/** C1, the reviewed commit: changes lines 5 and 6. */
export const REVIEWED = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
/** C2, an ordinary push on top of C1 (line 15): the branch moved forward. */
export const ADVANCED = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
/** C1′, C1 amended to also change line 15: rewritten, but nothing a suggestion touches changed. */
export const AMENDED = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
/** C1″, rewritten: line 6 and obsolete.txt changed, docs/new.md still absent, line 10 unchanged. */
export const REWRITTEN = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
/** Rewritten so that nothing can be re-applied: the change dropped, line 10 edited, docs/new.md added, obsolete.txt deleted. */
export const DROPPED = 'd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3';
/** Rewritten with a line inserted above the reviewed lines, and a directory where docs/new.md would go. */
export const MOVED = 'e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4';
/** An ordinary push on top of the amended head C1′: the branch moved forward from it. */
export const AMENDED_LATER = 'a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
/** Rewritten so that docs/sample.md is no longer UTF-8 text (a 0xFF byte on line 15). */
export const NOT_TEXT = 'f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5';
/** Rewritten so that docs/sample.md is larger than the 1,000,000-byte source-read limit. */
export const OVERSIZE = 'f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6';

export const SHORT = REVIEWED.slice(0, 7);
export const OBSOLETE = ['first\n', 'second\n'];
export const NEW_PAGE = '# New\n';

/** docs/sample.md: 20 lines `Line N.`, with some lines replaced. */
export function sample(replaced: Readonly<Record<number, string>> = {}): string[] {
  return Array.from({ length: 20 }, (_, i) => `${replaced[i + 1] ?? `Line ${String(i + 1)}.`}\n`);
}

export const REVIEWED_LINES = { 5: 'Line 5, reviewed.', 6: 'Line 6, reviewed.' };
export const SNAPSHOTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  [BASE]: { 'docs/sample.md': sample(), 'obsolete.txt': OBSOLETE },
  [REVIEWED]: { 'docs/sample.md': sample(REVIEWED_LINES), 'obsolete.txt': OBSOLETE },
  [ADVANCED]: { 'docs/sample.md': sample({ ...REVIEWED_LINES, 15: 'Line 15, later.' }), 'obsolete.txt': OBSOLETE },
  [AMENDED]: { 'docs/sample.md': sample({ ...REVIEWED_LINES, 15: 'Line 15, later.' }), 'obsolete.txt': OBSOLETE },
  [REWRITTEN]: { 'docs/sample.md': sample({ 5: 'Line 5, reviewed.', 6: 'Line 6, rewritten.', 15: 'Line 15, later.' }), 'obsolete.txt': ['first\n', 'changed\n'] },
  [DROPPED]: { 'docs/sample.md': sample({ 10: 'Line 10, edited.' }), 'docs/new.md': ["# Someone else's page\n"] },
  [MOVED]: { 'docs/sample.md': ['Preface.\n', ...sample(REVIEWED_LINES)], 'obsolete.txt': OBSOLETE, 'docs/new.md/index.md': ['# Index\n'] },
  [AMENDED_LATER]: { 'docs/sample.md': sample({ ...REVIEWED_LINES, 15: 'Line 15, later.', 20: 'Line 20, even later.' }), 'obsolete.txt': OBSOLETE },
};

/**
 * Heads served only by the worlds that use them: a sample that is not UTF-8
 * (given as raw bytes), and one over the source-read limit (large, so it is
 * not built into every world).
 */
export const NOT_TEXT_SAMPLE = Buffer.concat([
  Buffer.from(sample(REVIEWED_LINES).slice(0, 14).join('')),
  Buffer.from([0x4c, 0x69, 0x6e, 0x65, 0x20, 0xff, 0x0a]),
  Buffer.from(sample(REVIEWED_LINES).slice(15).join('')),
]);
export function specialHead(head: string): Pick<IHttpRepository, 'snapshots' | 'rawFiles'> {
  if (head === NOT_TEXT) {
    return {
      snapshots: { ...SNAPSHOTS, [NOT_TEXT]: { 'obsolete.txt': OBSOLETE } },
      rawFiles: { [NOT_TEXT]: { 'docs/sample.md': { base64: NOT_TEXT_SAMPLE.toString('base64') } } },
    };
  }
  if (head === OVERSIZE) {
    return { snapshots: { ...SNAPSHOTS, [OVERSIZE]: { 'docs/sample.md': [...sample(REVIEWED_LINES), `${'x'.repeat(1_000_000)}\n`], 'obsolete.txt': OBSOLETE } } };
  }
  return { snapshots: SNAPSHOTS };
}
export const PARENTS: Readonly<Record<string, readonly string[]>> = {
  [REVIEWED]: [BASE],
  [ADVANCED]: [REVIEWED],
  [AMENDED]: [BASE],
  [REWRITTEN]: [BASE],
  [DROPPED]: [BASE],
  [MOVED]: [BASE],
  [AMENDED_LATER]: [AMENDED],
  [NOT_TEXT]: [BASE],
  [OVERSIZE]: [BASE],
};

/** A pull request file whose patch replaces the whole file (a valid unified diff for any two versions). */
export function pullFile(filename: string, before: readonly string[] | undefined, after: readonly string[] | undefined): IHttpPullFile {
  const old = before ?? [];
  const now = after ?? [];
  const range = (lines: readonly string[]): string => (lines.length === 0 ? '0,0' : `1,${String(lines.length)}`);
  const lines = [`@@ -${range(old)} +${range(now)} @@\n`, ...old.map((l) => `-${l}`), ...now.map((l) => `+${l}`)];
  const last = lines.length - 1;
  return {
    filename,
    status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
    additions: now.length,
    deletions: old.length,
    patch: lines.map((l, i) => (i === last ? l.replace(/\n$/, '') : l)),
  };
}

/**
 * The heads force-pushes replaced to reach each head, oldest first, as the
 * pull request's timeline records them (each discarded reviewed commit was
 * the `beforeCommit` of a HeadRefForcePushedEvent in E0,
 * docs/evidence/realignment/e0-readme.md). An ordinary push records none.
 */
export const FORCE_PUSHES: Readonly<Record<string, readonly string[]>> = {
  [AMENDED]: [REVIEWED],
  [REWRITTEN]: [REVIEWED],
  [DROPPED]: [REVIEWED],
  [MOVED]: [REVIEWED],
  [AMENDED_LATER]: [REVIEWED],
  [NOT_TEXT]: [REVIEWED],
  [OVERSIZE]: [REVIEWED],
};

/** The pull request, its head at `head`; every snapshot stays readable (discarded commits stay fetchable). */
export function repositoryAt(head: string): IHttpRepository {
  const special = specialHead(head);
  const base = SNAPSHOTS[BASE] ?? {};
  const now = special.snapshots[head] ?? {};
  const paths = [...new Set([...Object.keys(base), ...Object.keys(now)])].sort();
  const pullFiles = paths
    .filter((p) => JSON.stringify(base[p]) !== JSON.stringify(now[p]))
    .map((p) => pullFile(p, base[p], now[p]));
  return {
    destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
    commits: { base: BASE, head },
    ...special,
    parents: PARENTS,
    forcePushes: FORCE_PUSHES[head] ?? [],
    pullFiles,
    pull: { headRef: HEAD_REF, baseRef: 'main' },
    defaultBranch: 'main',
    labels: ['suggestion-pr'],
  };
}

// ---------------------------------------------------------------------------
// SARIF: one group of two edits, a creation, a deletion and a plain remark

export type Json = Record<string, unknown>;

export const LINE6_MESSAGE = 'Say what line 6 means.';
export const LINE10_MESSAGE = 'Line 10 too.';
export const NEW_MESSAGE = 'Add a new page.';
export const OBSOLETE_MESSAGE = 'Obsolete.';
export const REMARK = 'A general remark.';

export function lineFix(uri: string, line: number, text: string): Json {
  return { artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion: { startLine: line }, insertedContent: { text } }] }] };
}

export function reviewDocument(): Json {
  const at = (uri: string, startLine?: number): Json[] => [{ physicalLocation: { artifactLocation: { uri }, ...(startLine === undefined ? {} : { region: { startLine } }) } }];
  return {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Review bot', version: '1.0.0' } },
      columnKind: 'utf16CodeUnits',
      versionControlProvenance: [{ repositoryUri: `https://github.com/${OWNER}/${REPO}`, revisionId: REVIEWED }],
      artifacts: [
        { location: { uri: 'docs/new.md' }, contents: { text: NEW_PAGE }, encoding: 'utf-8' },
        { location: { uri: 'obsolete.txt' } },
      ],
      results: [
        { message: { text: LINE6_MESSAGE }, locations: at('docs/sample.md', 6), fixes: [lineFix('docs/sample.md', 6, 'Line 6, suggested.')], properties: { sarifToComment: { suggestionGroup: 'reword' } } },
        { message: { text: LINE10_MESSAGE }, locations: at('docs/sample.md', 10), fixes: [lineFix('docs/sample.md', 10, 'Line 10, suggested.')], properties: { sarifToComment: { suggestionGroup: 'reword' } } },
        { message: { text: NEW_MESSAGE }, locations: at('docs/new.md', 1), properties: { sarifToComment: { proposedFileChanges: [{ operation: 'create', artifactIndex: 0 }] } } },
        { message: { text: OBSOLETE_MESSAGE }, locations: at('obsolete.txt'), properties: { sarifToComment: { proposedFileChanges: [{ operation: 'delete', artifactIndex: 1 }] } } },
        { message: { text: REMARK } },
      ],
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

/**
 * A world whose pull request's head is `head`; `repository` overrides parts
 * of that pull request's repository (for example a fork's head or another
 * base branch).
 */
export function makeWorld(head: string, config: Partial<IHttpHostConfig> = {}, repository: Partial<IHttpRepository> = {}): IWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'force-push-composition-')));
  FakeHttpGitHub.create(path.join(root, 'host'), config, { ...repositoryAt(head), ...repository });
  fs.mkdirSync(path.join(root, 'state'));
  return { root, statePath: path.join(root, 'state', 'review.json'), host: new FakeHttpGitHub(path.join(root, 'host'), TOKEN) };
}

export function internalsFor(world: IWorld): { readonly createGitHubClient: (options: ICreateGitHubClientOptions) => IGitHubClient } {
  return { createGitHubClient: (options) => createGitHubClient({ ...options, fetch: world.host.fetch }) };
}

/**
 * The delivery lists that do what the removed `allowSuggestionPullRequests:
 * true` did (docs/companion-suggestion-pr-contract.md §2.4): groups and
 * fixes with several changes in companions, strictly, and whole-file
 * operations in companions with the review body as the announced fallback.
 */
export const COMPANIONS: Json = { groupedEdits: ['companion'], fileOperations: ['companion', 'manual'] };

/**
 * Calls the public `publishSarifReview` or `validateSarifReview` for `world`,
 * delivering by companions as {@link COMPANIONS} lists them unless
 * `companions` is false, which keeps the default delivery policy.
 */
export async function call(
  name: 'publishSarifReview' | 'validateSarifReview',
  world: IWorld,
  sarif: Json = reviewDocument(),
  companions = true,
): Promise<Json> {
  const operation: unknown = Reflect.get(library, name);
  if (typeof operation !== 'function') throw new assert.AssertionError({ message: `the package exports ${name}` });
  const input: Json = {
    sarif,
    destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
    reviewedCommit: REVIEWED,
    token: TOKEN,
    ...(companions ? { options: { delivery: COMPANIONS } } : {}),
    ...(name === 'publishSarifReview' ? { statePath: world.statePath } : {}),
  };
  const outcome: unknown = await Reflect.apply(operation, undefined, [input, internalsFor(world)]);
  return asRecord(outcome, `the ${name} outcome`);
}

export const publish = (world: IWorld): Promise<Json> => call('publishSarifReview', world);
export const validate = (world: IWorld): Promise<Json> => call('validateSarifReview', world);
export const publishWith = (world: IWorld, sarif: Json): Promise<Json> => call('publishSarifReview', world, sarif);
export const validateWith = (world: IWorld, sarif: Json): Promise<Json> => call('validateSarifReview', world, sarif);

export const status = (outcome: Json): string => asString(outcome['status'], 'an outcome status');
export const markdown = (outcome: Json): string => asString(outcome['markdown'], 'outcome markdown');
export const writes = (world: IWorld): readonly string[] =>
  world.host.log().filter((r) => r.method === 'POST' && r.path !== '/graphql').map((r) => r.path.replace(`/repos/${OWNER}/${REPO}`, ''));
export const compareReads = (world: IWorld): readonly string[] =>
  world.host.log().filter((r) => r.method === 'GET' && r.path.includes('/compare/')).map((r) => r.path.replace(`/repos/${OWNER}/${REPO}/compare/`, ''));

export const SUGGESTION_MARKER = /\n\n(<!-- suggestion-pr (\{[^\n]*\}) -->)$/;
export const REVIEW_MARKER = /\n\n<!-- sarif-to-comment:review:[0-9a-f-]{36} -->$/;

/** The suggestion and publication ids a created pull request's marker records. */
export function idsOf(pull: IStoredPull): { readonly id: string; readonly batch: string } {
  const marker = SUGGESTION_MARKER.exec(pull.body);
  assert.ok(marker, `pull request #${String(pull.number)} ends with a marker`);
  const parsed = asRecord(parseJson(marker[2] ?? ''), 'the marker JSON');
  return { id: asString(parsed['id']), batch: asString(parsed['batch']) };
}

/** The single proposal commit a branch points at: its parent and message. */
export function proposalCommit(world: IWorld, branch: string): { readonly parents: readonly string[]; readonly message: string } {
  const state = world.host.companion();
  const sha = state.refs[branch];
  assert.ok(sha !== undefined, `the branch ${branch} exists`);
  const commit = state.commits[sha];
  assert.ok(commit, `the branch ${branch} points at a proposal commit`);
  return { parents: commit.parents, message: commit.message };
}

// ---------------------------------------------------------------------------
// Expected link texts

export const blob = (file: string, anchor = ''): string => `https://github.com/${OWNER}/${REPO}/blob/${REVIEWED}/${file}${anchor}`;
export const pullUrl = (n: number): string => `https://github.com/${OWNER}/${REPO}/pull/${String(n)}`;
export const ATTRIBUTION = '<sub>— Review bot 1.0.0</sub>';

/** A part of {@link reviewDocument}: the group of two edits, the creation, the deletion or the plain remark. */
export type DocumentPart = 'reword' | 'create' | 'delete' | 'remark';

/** The results of {@link reviewDocument} for each part, in document order. */
const PART_RESULTS: readonly (readonly [DocumentPart, readonly number[]])[] = [['reword', [0, 1]], ['create', [2]], ['delete', [3]], ['remark', [4]]];

/**
 * {@link reviewDocument} with only the results of `parts`, in its order. The
 * new page's artifact keeps its contents only while the creation refers to
 * them, unless `keepUnreferencedContents` asks for them (which makes them
 * context the review warns about).
 */
export function documentWith(parts: readonly DocumentPart[], { keepUnreferencedContents = false } = {}): Json {
  const document = reviewDocument();
  const run = asRecord(asArray(document['runs'])[0]);
  const results = asArray(run['results']);
  const kept = PART_RESULTS.filter(([part]) => parts.includes(part)).flatMap(([, indices]) => indices);
  run['results'] = kept.map((i) => results[i]);
  if (!parts.includes('create') && !keepUnreferencedContents) run['artifacts'] = [{ location: { uri: 'docs/new.md' } }, { location: { uri: 'obsolete.txt' } }];
  return document;
}

/**
 * One finding whose single fix replaces lines 6 and 10 of docs/sample.md
 * together, with no group property, and no artifact contents left over as
 * context.
 */
export function jointFixDocument(): Json {
  const document = documentWith([]);
  const run = asRecord(asArray(document['runs'])[0]);
  run['results'] = [{
    message: { text: LINE6_MESSAGE },
    locations: [{ physicalLocation: { artifactLocation: { uri: 'docs/sample.md' }, region: { startLine: 6 } } }],
    fixes: [{ artifactChanges: [{ artifactLocation: { uri: 'docs/sample.md' }, replacements: [
      { deletedRegion: { startLine: 6 }, insertedContent: { text: 'Line 6, suggested.' } },
      { deletedRegion: { startLine: 10 }, insertedContent: { text: 'Line 10, suggested.' } },
    ] }] }],
  }];
  return document;
}
