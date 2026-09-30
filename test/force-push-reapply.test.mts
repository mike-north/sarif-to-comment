/**
 * Suggestion pull requests on a branch that moved, or whose history was
 * rewritten, after the review (issue #28), through the production
 * composition: the real public library and CLI with the real GitHub client
 * (src/github.cts), talking HTTP to the fake GitHub host
 * (test/fixtures/composition), which models ancestry through each commit's
 * parents. Only `fetch` is replaced.
 *
 * Every expected value is written by hand from
 * docs/companion-suggestion-pr-contract.md (§2.5, §2.5.1, §2.8–§2.11) and
 * docs/suggestion-pr-convention.md (§5.1, §7): which suggestions are created,
 * each proposal commit's parent and exact file bytes, the version 1 and 2
 * markers, the suggestion pull request bodies, the review body, the warnings
 * and the outcome sentences of `validate` and `publish`. Only the random
 * suggestion and publication ids are read back and substituted.
 *
 * The scenario mirrors the live experiment (docs/force-push-experiment.md):
 * C0 adds a 20-line file, the reviewed commit C1 changes its lines 5 and 6,
 * and the pull request's branch then moves forward (C2), is amended (C1′),
 * or is rewritten so that what the suggestions touch has changed.
 *
 * The host models documented GitHub behavior; it is not evidence of live
 * GitHub behavior (see docs/force-push-reapply-e2e-evidence.md).
 *
 * @see https://docs.github.com/en/rest/commits/commits#compare-two-commits
 * @see https://docs.github.com/en/rest/git/trees#get-a-tree
 * @see https://docs.github.com/en/rest/git/commits#create-a-commit
 * @see https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request
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
import { findSuggestionMarker } from '../dist/suggestion-marker.cjs';
import { FakeHttpGitHub } from './fixtures/composition/fake-http-github.mts';
import type { IHttpHostConfig, IHttpPullFile, IHttpRepository } from './fixtures/composition/fake-http-github.mts';
import type { IStoredPull } from './fixtures/composition/fake-http-companion.mts';
import { asArray, asRecord, asString, parseJson, readJson } from './support/runtime-types.mts';

const CLI = path.join(import.meta.dirname, 'fixtures', 'composition', 'cli-with-fake-http.mts');
const OWNER = 'octo';
const REPO = 'widgets';
const PULL = 7;
const HEAD_REF = 'feature/retry';
const TOKEN = 'ghp_FORCE_PUSH_COMPOSITION_0123456789';

/** C0, the pull request's base: adds docs/sample.md. */
const BASE = 'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0';
/** C1, the reviewed commit: changes lines 5 and 6. */
const REVIEWED = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
/** C2, an ordinary push on top of C1 (line 15): the branch moved forward. */
const ADVANCED = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
/** C1′, C1 amended to also change line 15: rewritten, but nothing a suggestion touches changed. */
const AMENDED = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
/** C1″, rewritten: line 6 and obsolete.txt changed, docs/new.md still absent, line 10 unchanged. */
const REWRITTEN = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
/** Rewritten so that nothing can be re-applied: the change dropped, line 10 edited, docs/new.md added, obsolete.txt deleted. */
const DROPPED = 'd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3';
/** Rewritten with a line inserted above the reviewed lines, and a directory where docs/new.md would go. */
const MOVED = 'e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4';
/** An ordinary push on top of the amended head C1′: the branch moved forward from it. */
const AMENDED_LATER = 'a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
/** Rewritten so that docs/sample.md is no longer UTF-8 text (a 0xFF byte on line 15). */
const NOT_TEXT = 'f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5';
/** Rewritten so that docs/sample.md is larger than the 1,000,000-byte source-read limit. */
const OVERSIZE = 'f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6';

const SHORT = REVIEWED.slice(0, 7);
const OBSOLETE = ['first\n', 'second\n'];
const NEW_PAGE = '# New\n';

/** docs/sample.md: 20 lines `Line N.`, with some lines replaced. */
function sample(replaced: Readonly<Record<number, string>> = {}): string[] {
  return Array.from({ length: 20 }, (_, i) => `${replaced[i + 1] ?? `Line ${String(i + 1)}.`}\n`);
}

const REVIEWED_LINES = { 5: 'Line 5, reviewed.', 6: 'Line 6, reviewed.' };
const SNAPSHOTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
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
const NOT_TEXT_SAMPLE = Buffer.concat([
  Buffer.from(sample(REVIEWED_LINES).slice(0, 14).join('')),
  Buffer.from([0x4c, 0x69, 0x6e, 0x65, 0x20, 0xff, 0x0a]),
  Buffer.from(sample(REVIEWED_LINES).slice(15).join('')),
]);
function specialHead(head: string): Pick<IHttpRepository, 'snapshots' | 'rawFiles'> {
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
const PARENTS: Readonly<Record<string, readonly string[]>> = {
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
function pullFile(filename: string, before: readonly string[] | undefined, after: readonly string[] | undefined): IHttpPullFile {
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

/** The pull request, its head at `head`; every snapshot stays readable (discarded commits stay fetchable). */
function repositoryAt(head: string): IHttpRepository {
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
    pullFiles,
    pull: { headRef: HEAD_REF, baseRef: 'main' },
    defaultBranch: 'main',
    labels: ['suggestion-pr'],
  };
}

// ---------------------------------------------------------------------------
// SARIF: one group of two edits, a creation, a deletion and a plain remark

type Json = Record<string, unknown>;

const LINE6_MESSAGE = 'Say what line 6 means.';
const LINE10_MESSAGE = 'Line 10 too.';
const NEW_MESSAGE = 'Add a new page.';
const OBSOLETE_MESSAGE = 'Obsolete.';
const REMARK = 'A general remark.';

function lineFix(uri: string, line: number, text: string): Json {
  return { artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion: { startLine: line }, insertedContent: { text } }] }] };
}

function reviewDocument(): Json {
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

interface IWorld {
  readonly root: string;
  readonly statePath: string;
  readonly host: FakeHttpGitHub;
}

function makeWorld(head: string, config: Partial<IHttpHostConfig> = {}): IWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'force-push-composition-')));
  FakeHttpGitHub.create(path.join(root, 'host'), config, repositoryAt(head));
  fs.mkdirSync(path.join(root, 'state'));
  return { root, statePath: path.join(root, 'state', 'review.json'), host: new FakeHttpGitHub(path.join(root, 'host'), TOKEN) };
}

function internalsFor(world: IWorld): { readonly createGitHubClient: (options: ICreateGitHubClientOptions) => IGitHubClient } {
  return { createGitHubClient: (options) => createGitHubClient({ ...options, fetch: world.host.fetch }) };
}

async function call(name: 'publishSarifReview' | 'validateSarifReview', world: IWorld, sarif: Json = reviewDocument()): Promise<Json> {
  const operation: unknown = Reflect.get(library, name);
  if (typeof operation !== 'function') throw new assert.AssertionError({ message: `the package exports ${name}` });
  const input: Json = {
    sarif,
    destination: { owner: OWNER, repo: REPO, pullNumber: PULL },
    reviewedCommit: REVIEWED,
    token: TOKEN,
    options: { allowSuggestionPullRequests: true },
    ...(name === 'publishSarifReview' ? { statePath: world.statePath } : {}),
  };
  const outcome: unknown = await Reflect.apply(operation, undefined, [input, internalsFor(world)]);
  return asRecord(outcome, `the ${name} outcome`);
}

const publish = (world: IWorld): Promise<Json> => call('publishSarifReview', world);
const validate = (world: IWorld): Promise<Json> => call('validateSarifReview', world);
const publishWith = (world: IWorld, sarif: Json): Promise<Json> => call('publishSarifReview', world, sarif);
const validateWith = (world: IWorld, sarif: Json): Promise<Json> => call('validateSarifReview', world, sarif);

const status = (outcome: Json): string => asString(outcome['status'], 'an outcome status');
const markdown = (outcome: Json): string => asString(outcome['markdown'], 'outcome markdown');
const writes = (world: IWorld): readonly string[] =>
  world.host.log().filter((r) => r.method === 'POST' && r.path !== '/graphql').map((r) => r.path.replace(`/repos/${OWNER}/${REPO}`, ''));
const compareReads = (world: IWorld): readonly string[] =>
  world.host.log().filter((r) => r.method === 'GET' && r.path.includes('/compare/')).map((r) => r.path.replace(`/repos/${OWNER}/${REPO}/compare/`, ''));

const SUGGESTION_MARKER = /\n\n(<!-- suggestion-pr (\{[^\n]*\}) -->)$/;
const REVIEW_MARKER = /\n\n<!-- sarif-to-comment:review:[0-9a-f-]{36} -->$/;

/** The suggestion and publication ids a created pull request's marker records. */
function idsOf(pull: IStoredPull): { readonly id: string; readonly batch: string } {
  const marker = SUGGESTION_MARKER.exec(pull.body);
  assert.ok(marker, `pull request #${String(pull.number)} ends with a marker`);
  const parsed = asRecord(parseJson(marker[2] ?? ''), 'the marker JSON');
  return { id: asString(parsed['id']), batch: asString(parsed['batch']) };
}

/** The single proposal commit a branch points at: its parent and message. */
function proposalCommit(world: IWorld, branch: string): { readonly parents: readonly string[]; readonly message: string } {
  const state = world.host.companion();
  const sha = state.refs[branch];
  assert.ok(sha !== undefined, `the branch ${branch} exists`);
  const commit = state.commits[sha];
  assert.ok(commit, `the branch ${branch} points at a proposal commit`);
  return { parents: commit.parents, message: commit.message };
}

// ---------------------------------------------------------------------------
// Expected texts (contract §2.11, §2.5.1; convention §7)

const blob = (file: string, anchor = ''): string => `https://github.com/${OWNER}/${REPO}/blob/${REVIEWED}/${file}${anchor}`;
const pullUrl = (n: number): string => `https://github.com/${OWNER}/${REPO}/pull/${String(n)}`;
const ATTRIBUTION = '<sub>— Review bot 1.0.0</sub>';
const DRAFT_NOTE = '**How this suggestion is accepted:** it is a draft pull request into `feature/retry`, the branch of #7. A draft cannot be merged: someone with write access first marks it ready for review. The author of #7 then decides whether to merge it, and #7 carries the change to its base. Once #7 is merged or closed, this pull request can be closed.';

/** One suggestion as §2.11 renders it: its title, change list, merge sentence tail and findings. */
interface IUnit {
  readonly title: string;
  readonly what: string;
  readonly changes: readonly string[];
  readonly items: readonly string[];
}

const REWORD: IUnit = {
  title: 'Suggestion for #7: reword (2 changes)',
  what: 'these 2 changes together:',
  changes: [
    `- Edited [docs/sample.md line 6 at ${SHORT}](${blob('docs/sample.md', '#L6')})`,
    `- Edited [docs/sample.md line 10 at ${SHORT}](${blob('docs/sample.md', '#L10')})`,
  ],
  items: [
    `**Source:** [docs/sample.md line 6 at ${SHORT}](${blob('docs/sample.md', '#L6')})`, '', '```', 'Line 6, reviewed.', '```', '', LINE6_MESSAGE, '', ATTRIBUTION,
    '', '---', '',
    `**Source:** [docs/sample.md line 10 at ${SHORT}](${blob('docs/sample.md', '#L10')})`, '', '```', 'Line 10.', '```', '', LINE10_MESSAGE, '', ATTRIBUTION,
  ],
};
const CREATE: IUnit = {
  title: 'Suggestion for #7: create docs/new.md',
  what: 'this change:',
  changes: ['- New file `docs/new.md`: 6 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644'],
  items: ['**Location:** line 1 of the proposed file', '', NEW_MESSAGE, '', ATTRIBUTION],
};
const DELETE: IUnit = {
  title: 'Suggestion for #7: delete obsolete.txt',
  what: 'this change:',
  changes: [`- Deleted file [obsolete.txt at ${SHORT}](${blob('obsolete.txt')}): the whole file is removed`],
  items: [OBSOLETE_MESSAGE, '', ATTRIBUTION],
};
const REMARK_SECTION = [REMARK, '', ATTRIBUTION];

/** §2.11: the paragraph a re-applied suggestion's body carries after its first line. */
const reappliedInBody = (head: string): string =>
  `The history of #7 was rewritten after that commit, so this change is re-applied onto commit ${head}, the head of #7 when it was proposed, where everything it changes is still exactly as reviewed.`;
/** §2.11: the paragraph a re-applied suggestion's review section carries after its link. */
const reappliedInReview = (head: string): string =>
  `The history of #7 was rewritten after the reviewed commit, so this change is re-applied onto commit ${head}, the head of #7 when it was proposed, where everything it changes is still exactly as reviewed.`;

/** Convention §7: version 1, or version 2 naming the commit it was re-applied onto. */
function marker(id: string, batch: string, reappliedOnto?: string): string {
  const original = `"original":{"owner":"${OWNER}","repo":"${REPO}","pullNumber":${String(PULL)}}`;
  return reappliedOnto === undefined
    ? `<!-- suggestion-pr {"version":1,${original},"reviewedCommit":"${REVIEWED}","id":"${id}","batch":"${batch}"} -->`
    : `<!-- suggestion-pr {"version":2,${original},"reviewedCommit":"${REVIEWED}","reappliedOnto":"${reappliedOnto}","id":"${id}","batch":"${batch}"} -->`;
}

/** §2.11: a suggestion pull request's whole body. */
function pullBody(unit: IUnit, ids: { readonly id: string; readonly batch: string }, reappliedOnto?: string): string {
  return [
    `Suggested in a review of #7 at commit ${REVIEWED}.`,
    '',
    ...(reappliedOnto === undefined ? [] : [reappliedInBody(reappliedOnto), '']),
    `Merging this pull request into \`feature/retry\` applies ${unit.what}`,
    '',
    ...unit.changes,
    '',
    DRAFT_NOTE,
    '',
    '---',
    '',
    ...unit.items,
    '',
    marker(ids.id, ids.batch, reappliedOnto),
  ].join('\n');
}

/** §2.11: a created suggestion's section of the review body. */
function createdSection(unit: IUnit, number: number, reappliedOnto?: string): string[] {
  return [
    `**Suggestion pull request:** [#${String(number)}](${pullUrl(number)})`,
    '',
    ...(reappliedOnto === undefined ? [] : [reappliedInReview(reappliedOnto), '']),
    `Merging it into \`feature/retry\` applies ${unit.what}`,
    '',
    ...unit.changes,
    '',
    ...unit.items,
  ];
}

/** §2.11: the section of a suggestion that is not created, with every reason of §2.5.1. */
function skippedSection(unit: IUnit, head: string, reasons: readonly string[]): string[] {
  return [
    `**Suggestion pull request not created:** the history of #7 was rewritten after the reviewed commit, and this change cannot be re-applied onto commit ${head}, the head of #7, because there:`,
    '',
    ...reasons.map((r) => `- ${r}`),
    '',
    `It would have proposed ${unit.what}`,
    '',
    ...unit.changes,
    '',
    ...unit.items,
  ];
}

/** §2.11: the review body's sections, joined as every review body's sections are. */
const reviewBody = (...sections: readonly (readonly string[])[]): string => sections.map((s) => s.join('\n')).join('\n\n---\n\n');

/** §2.5.1: the warning for a suggestion that is not created. */
function notReapplied(pointer: string, unit: IUnit, head: string, reasons: readonly string[]): string {
  return `- \`suggestion-pr-not-reapplied\` at \`${pointer}\`: The history of #7 was rewritten after the reviewed commit, so the suggestion pull request \`${unit.title}\` would have to be re-applied onto commit \`${head}\`, and it cannot be: ${reasons.join('; ')}. It is not created; its change and findings are presented in the review body.`;
}

/** Contract §2.10: the retry warning when the branch changed after the suggestions were planned. */
function changedSincePlanned(base: string, head: string): string {
  return `**The branch of #7 changed since these suggestions were planned:** they are based on commit \`${base}\`, which is no longer part of it `
    + `(its head is now \`${head}\`). The suggestion pull requests still to be created are created on that commit, as planned; nothing is re-decided.`;
}

/** The warnings block of prepared Markdown, as validate and publish both show it. */
function warningsOf(text: string): string {
  const at = text.indexOf('**Warnings:**');
  assert.ok(at >= 0, `the outcome lists warnings:\n${text}`);
  return text.slice(at).split('\n\n').slice(0, 2).join('\n\n');
}
const warningsBlock = (...lines: readonly string[]): string => ['**Warnings:**', lines.join('\n')].join('\n\n');

const REVIEWED_SAMPLE = sample(REVIEWED_LINES);

/** docs/sample.md on a proposal branch: `lines` with lines 6 and 10 replaced as suggested. */
function suggestedSample(lines: readonly string[]): Buffer {
  const edited = [...lines];
  edited[5] = 'Line 6, suggested.\n';
  edited[9] = 'Line 10, suggested.\n';
  return Buffer.from(edited.join(''));
}

/** The three created suggestions in order, with their ids, after asserting there are exactly three. */
function threePulls(world: IWorld): readonly [IStoredPull, IStoredPull, IStoredPull] {
  const [a, b, c, ...rest] = world.host.pulls();
  assert.ok(a && b && c && rest.length === 0, `exactly three suggestion pull requests: ${String(world.host.pulls().length)}`);
  return [a, b, c];
}

/** Every suggestion is created as before, on the reviewed commit, with version 1 markers. */
function assertProposedOnReviewed(world: IWorld, outcome: Json): void {
  assert.equal(status(outcome), 'published', markdown(outcome));
  const pulls = threePulls(world);
  for (const [pull, unit] of [[pulls[0], REWORD], [pulls[1], CREATE], [pulls[2], DELETE]] as const) {
    assert.equal(pull.title, unit.title);
    assert.equal(pull.body, pullBody(unit, idsOf(pull)));
    assert.deepEqual(proposalCommit(world, pull.head).parents, [REVIEWED]);
  }
  assert.deepEqual(world.host.fileOnBranch(pulls[0].head, 'docs/sample.md'), suggestedSample(REVIEWED_SAMPLE));
  assert.equal(proposalCommit(world, pulls[0].head).message,
    `Suggestion for #7: reword (2 changes)\n\nSuggested in a review of ${OWNER}/${REPO} pull request 7 at commit ${REVIEWED}.`);
  const [review] = world.host.reviews();
  assert.ok(review);
  assert.equal(review.request.commit_id, REVIEWED);
  assert.equal(review.request.body.replace(REVIEW_MARKER, ''), reviewBody(
    createdSection(REWORD, pulls[0].number), createdSection(CREATE, pulls[1].number), createdSection(DELETE, pulls[2].number), REMARK_SECTION,
  ));
  assert.ok(markdown(outcome).includes('Suggestion pull requests (drafts into `feature/retry`, labeled `suggestion-pr`):'), markdown(outcome));
  assert.doesNotMatch(markdown(outcome), /re-applied|Warnings/);
}

// ---------------------------------------------------------------------------

describe('harness controls', () => {
  test('the fixture relates the commits as the experiment did', async () => {
    const world = makeWorld(ADVANCED);
    const statusOf = async (a: string, b: string): Promise<unknown> =>
      asRecord(await (await world.host.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/compare/${a}...${b}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json())['status'];
    assert.equal(await statusOf(REVIEWED, ADVANCED), 'ahead');
    assert.equal(await statusOf(REVIEWED, AMENDED), 'diverged');
    assert.equal(await statusOf(REVIEWED, BASE), 'behind');
    assert.equal(await statusOf(REVIEWED, REVIEWED), 'identical');
  });

  test('the amended head keeps every line the suggestions touch; the rewritten ones do not', () => {
    const at = (commit: string, line: number): string | undefined => SNAPSHOTS[commit]?.['docs/sample.md']?.[line - 1];
    for (const line of [6, 10]) assert.equal(at(AMENDED, line), at(REVIEWED, line));
    assert.notEqual(at(REWRITTEN, 6), at(REVIEWED, 6));
    assert.equal(at(REWRITTEN, 10), at(REVIEWED, 10));
    assert.notEqual(at(MOVED, 6), at(REVIEWED, 6));
  });
});

describe('the reviewed commit is still the head', () => {
  test('suggestions are proposed on it, and no comparison is read', async () => {
    const world = makeWorld(REVIEWED);
    assertProposedOnReviewed(world, await publish(world));
    assert.deepEqual(compareReads(world), [`${BASE}...${REVIEWED}`], 'only the merge-base comparison of the review context');
  });
});

describe('the branch moved forward: the reviewed commit is an ancestor of the head (§2.5)', () => {
  test('publication proceeds on the reviewed commit, exactly as for the head, with version 1 markers', async () => {
    const world = makeWorld(ADVANCED);
    assertProposedOnReviewed(world, await publish(world));
    assert.ok(compareReads(world).includes(`${REVIEWED}...${ADVANCED}`), 'the ancestry was read');
  });

  test('validate says what would be created, with no mention of re-application, and writes nothing', async () => {
    const world = makeWorld(ADVANCED);
    const assessed = await validate(world);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.ok(markdown(assessed).includes('Publication would also create 3 draft suggestion pull requests into `feature/retry`, labeled `suggestion-pr`.\n'), markdown(assessed));
    assert.doesNotMatch(markdown(assessed), /re-applied|Warnings/);
    assert.deepEqual(writes(world), []);
  });

  test('regression: an advanced head is no longer refused as historical', async () => {
    const world = makeWorld(ADVANCED);
    const assessed = await validate(world);
    assert.doesNotMatch(markdown(assessed), /suggestion-pr-historical-unsupported|no longer the pull request's head/);
  });
});

describe('rewritten history, and everything the suggestions touch is unchanged: re-applied onto the head (§2.5.1)', () => {
  test('each suggestion is re-applied onto the amended head, with version 2 markers and the re-application stated', async () => {
    const world = makeWorld(AMENDED);
    const outcome = await publish(world);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const pulls = threePulls(world);
    for (const [pull, unit] of [[pulls[0], REWORD], [pulls[1], CREATE], [pulls[2], DELETE]] as const) {
      assert.equal(pull.title, unit.title);
      assert.equal(pull.base, HEAD_REF);
      assert.equal(pull.draft, true);
      assert.deepEqual(pull.labels, ['suggestion-pr']);
      assert.equal(pull.body, pullBody(unit, idsOf(pull), AMENDED));
      assert.deepEqual(proposalCommit(world, pull.head).parents, [AMENDED], 'never the discarded reviewed commit');
    }
    // The edit is applied to the head's file: the amendment's line 15 is kept.
    assert.deepEqual(world.host.fileOnBranch(pulls[0].head, 'docs/sample.md'), suggestedSample(SNAPSHOTS[AMENDED]?.['docs/sample.md'] ?? []));
    assert.deepEqual(world.host.fileOnBranch(pulls[1].head, 'docs/new.md'), Buffer.from(NEW_PAGE));
    assert.equal(world.host.fileOnBranch(pulls[2].head, 'obsolete.txt'), null);
    assert.equal(proposalCommit(world, pulls[0].head).message,
      `Suggestion for #7: reword (2 changes)\n\nSuggested in a review of ${OWNER}/${REPO} pull request 7 at commit ${REVIEWED}, and re-applied onto commit ${AMENDED} after the pull request's history was rewritten.`);

    const [review] = world.host.reviews();
    assert.ok(review);
    assert.equal(review.request.commit_id, REVIEWED, 'the review stays pinned to the reviewed commit');
    assert.equal(review.request.body.replace(REVIEW_MARKER, ''), reviewBody(
      createdSection(REWORD, pulls[0].number, AMENDED),
      createdSection(CREATE, pulls[1].number, AMENDED),
      createdSection(DELETE, pulls[2].number, AMENDED),
      REMARK_SECTION,
    ));
    assert.ok(markdown(outcome).includes([
      `Suggestion pull requests (drafts into \`feature/retry\`, labeled \`suggestion-pr\`, re-applied onto commit \`${AMENDED}\`):`,
      '',
      ...pulls.map((p) => `- [#${String(p.number)}](${pullUrl(p.number)}) from \`${p.head}\``),
    ].join('\n')), markdown(outcome));
  });

  test('validate reports the same: three re-applied suggestions, and nothing written', async () => {
    const world = makeWorld(AMENDED);
    const assessed = await validate(world);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.ok(markdown(assessed).includes(
      `Publication would also create 3 draft suggestion pull requests into \`feature/retry\`, labeled \`suggestion-pr\`. The history of #7 was rewritten after the reviewed commit, so they are re-applied onto commit \`${AMENDED}\`, where everything they change is still exactly as reviewed.`,
    ), markdown(assessed));
    assert.doesNotMatch(markdown(assessed), /Warnings/);
    assert.deepEqual(writes(world), []);
  });

  test('the version 2 marker is recognized by cleanup\'s reader (convention §7)', async () => {
    const world = makeWorld(AMENDED);
    await publish(world);
    for (const pull of threePulls(world)) {
      const reading = findSuggestionMarker(pull.body);
      assert.equal(reading.kind, 'marker');
      assert.equal(reading.fields.reappliedOnto, AMENDED);
      assert.equal(reading.fields.reviewedCommit, REVIEWED);
    }
  });
});

describe('rewritten history where some regions changed: those suggestions are not created, with the reason (§2.5.1)', () => {
  const GROUP_REASON = '`docs/sample.md` line 6 differs from the reviewed text';
  const DELETE_REASON = '`obsolete.txt` differs from the reviewed file';

  test('only the creation is re-applied; the review presents the others with their reasons, and ordinary feedback still publishes', async () => {
    const world = makeWorld(REWRITTEN);
    const outcome = await publish(world);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const [pull, ...others] = world.host.pulls();
    assert.ok(pull && others.length === 0, 'exactly one suggestion pull request');
    assert.equal(pull.title, CREATE.title);
    assert.equal(pull.body, pullBody(CREATE, idsOf(pull), REWRITTEN));
    assert.deepEqual(proposalCommit(world, pull.head).parents, [REWRITTEN]);
    assert.deepEqual(world.host.fileOnBranch(pull.head, 'docs/new.md'), Buffer.from(NEW_PAGE));

    const [review] = world.host.reviews();
    assert.ok(review);
    assert.equal(review.request.body.replace(REVIEW_MARKER, ''), reviewBody(
      skippedSection(REWORD, REWRITTEN, [GROUP_REASON]),
      createdSection(CREATE, pull.number, REWRITTEN),
      skippedSection(DELETE, REWRITTEN, [DELETE_REASON]),
      REMARK_SECTION,
    ));
    assert.deepEqual(outcome['suggestions'], [{ number: pull.number, url: pullUrl(pull.number), branch: pull.head }]);
    assert.equal(warningsOf(markdown(outcome)), warningsBlock(
      notReapplied('/runs/0/results/0', REWORD, REWRITTEN, [GROUP_REASON]),
      notReapplied('/runs/0/results/3', DELETE, REWRITTEN, [DELETE_REASON]),
    ));
    assert.ok(markdown(outcome).includes(`Suggestion pull requests (drafts into \`feature/retry\`, labeled \`suggestion-pr\`, re-applied onto commit \`${REWRITTEN}\`):`), markdown(outcome));
  });

  test('validate reports the same per-suggestion outcomes, and writes nothing', async () => {
    const published = await publish(makeWorld(REWRITTEN));
    const world = makeWorld(REWRITTEN);
    const assessed = await validate(world);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.equal(warningsOf(markdown(assessed)), warningsOf(markdown(published)));
    assert.ok(markdown(assessed).includes(
      `Publication would also create 1 draft suggestion pull request into \`feature/retry\`, labeled \`suggestion-pr\`. The history of #7 was rewritten after the reviewed commit, so it is re-applied onto commit \`${REWRITTEN}\`, where everything it changes is still exactly as reviewed.`,
    ), markdown(assessed));
    assert.deepEqual(writes(world), []);
  });
});

describe('rewritten history where nothing can be re-applied (§2.5.1)', () => {
  const REASONS = {
    reword: ['`docs/sample.md` line 6 differs from the reviewed text', '`docs/sample.md` line 10 differs from the reviewed text'],
    create: ['`docs/new.md` already exists'],
    delete: ['`obsolete.txt` no longer exists'],
  };

  test('no suggestion pull request is created; the review is published exactly like one without them', async () => {
    const world = makeWorld(DROPPED);
    const outcome = await publish(world);
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(world.host.pulls(), []);
    assert.equal(outcome['suggestions'], undefined);
    assert.deepEqual(writes(world), [`/pulls/${String(PULL)}/reviews`], 'only the review is written: no branch, pull request or label');
    const [review] = world.host.reviews();
    assert.ok(review);
    assert.equal(review.request.body.replace(REVIEW_MARKER, ''), reviewBody(
      skippedSection(REWORD, DROPPED, REASONS.reword),
      skippedSection(CREATE, DROPPED, REASONS.create),
      skippedSection(DELETE, DROPPED, REASONS.delete),
      REMARK_SECTION,
    ));
    assert.equal(asRecord(readJson(world.statePath))['format'], 'sarif-to-comment.publication-state', 'the version-1 review record');
    assert.equal(warningsOf(markdown(outcome)), warningsBlock(
      notReapplied('/runs/0/results/0', REWORD, DROPPED, REASONS.reword),
      notReapplied('/runs/0/results/2', CREATE, DROPPED, REASONS.create),
      notReapplied('/runs/0/results/3', DELETE, DROPPED, REASONS.delete),
    ));
    assert.doesNotMatch(markdown(outcome), /Suggestion pull requests \(/);
  });

  test('neither labels nor push permission are needed when nothing would be created', async () => {
    const world = makeWorld(DROPPED);
    world.host.replaceRepository({ ...repositoryAt(DROPPED), labels: [], push: false });
    const assessed = await validate(world);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.doesNotMatch(markdown(assessed), /Publication would also create/);
    assert.equal(warningsOf(markdown(assessed)).split('\n').filter((l) => l.startsWith('- ')).length, 3);
    assert.equal(status(await publish(world)), 'published');
  });

  test('a moved region is never relocated, and a directory where a file would be created is named', async () => {
    const world = makeWorld(MOVED);
    const outcome = await publish(world);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const [pull, ...others] = world.host.pulls();
    assert.ok(pull && others.length === 0, 'only the deletion, whose file is unchanged, is created');
    assert.equal(pull.title, DELETE.title);
    assert.equal(pull.body, pullBody(DELETE, idsOf(pull), MOVED));
    assert.equal(warningsOf(markdown(outcome)), warningsBlock(
      notReapplied('/runs/0/results/0', REWORD, MOVED, ['`docs/sample.md` line 6 differs from the reviewed text', '`docs/sample.md` line 10 differs from the reviewed text']),
      notReapplied('/runs/0/results/2', CREATE, MOVED, ['`docs/new.md` is a directory']),
    ));
  });
});

describe('recovery and retry after a re-application (§2.9, §2.10)', () => {
  test('a lost pull request response is rediscovered by its version 2 marker, never resent', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    const first = await publish(world);
    assert.equal(status(first), 'uncertain', markdown(first));
    world.host.setConfig({ companion: {} });
    const second = await publish(world);
    assert.equal(status(second), 'published', markdown(second));
    const pulls = threePulls(world);
    for (const pull of pulls) assert.equal(pull.body, pullBody([REWORD, CREATE, DELETE][pulls.indexOf(pull)] ?? REWORD, idsOf(pull), AMENDED));
    assert.equal(writes(world).filter((w) => w === '/pulls').length, 3, 'one create per suggestion');
    assert.equal(world.host.reviews().length, 1);
  });

  test('a retry never re-decides: the head rewritten again in between changes nothing already planned, and the outcome says so', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    const compares = compareReads(world).length;
    // The author force-pushes again, dropping everything the suggestions touch.
    world.host.replaceRepository(repositoryAt(DROPPED));
    world.host.setConfig({ companion: {} });
    const retried = await publish(world);
    assert.equal(status(retried), 'published', markdown(retried));
    assert.deepEqual(compareReads(world).slice(compares), [`${AMENDED}...${DROPPED}`], 'only the planned base against the head, to warn; nothing is re-decided');
    for (const pull of threePulls(world)) assert.deepEqual(proposalCommit(world, pull.head).parents, [AMENDED], 'still re-applied onto the head it was planned on');
    assert.ok(markdown(retried).includes(`re-applied onto commit \`${AMENDED}\`):`), markdown(retried));
    assert.ok(markdown(retried).includes(changedSincePlanned(AMENDED, DROPPED)), markdown(retried));
  });

  test('a retry after the branch only moved forward from the planned base gives no warning', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.replaceRepository(repositoryAt(AMENDED_LATER));
    world.host.setConfig({ companion: {} });
    const retried = await publish(world);
    assert.equal(status(retried), 'published', markdown(retried));
    assert.doesNotMatch(markdown(retried), /changed since these suggestions were planned/);
  });

  test('a plan on the reviewed commit warns too when the branch was rewritten after planning (no re-decision)', async () => {
    const world = makeWorld(ADVANCED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.replaceRepository(repositoryAt(AMENDED));
    world.host.setConfig({ companion: {} });
    const retried = await publish(world);
    assert.equal(status(retried), 'published', markdown(retried));
    for (const pull of threePulls(world)) assert.deepEqual(proposalCommit(world, pull.head).parents, [REVIEWED]);
    assert.ok(markdown(retried).includes(changedSincePlanned(REVIEWED, AMENDED)), markdown(retried));
  });

  test('an uncertain retry carries the warning as well', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.replaceRepository(repositoryAt(DROPPED));
    world.host.hide({ pulls: 1 });
    const retried = await publish(world);
    assert.equal(status(retried), 'uncertain', markdown(retried));
    assert.ok(markdown(retried).includes(changedSincePlanned(AMENDED, DROPPED)), markdown(retried));
  });

  test('a retry whose branch check cannot be read says so, and still publishes as planned', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.replaceRepository(repositoryAt(DROPPED));
    world.host.setConfig({ companion: {}, failAncestryCompare: 404 });
    const retried = await publish(world);
    assert.equal(status(retried), 'published', markdown(retried));
    const text = markdown(retried);
    const start = `**Whether the branch of #7 changed since these suggestions were planned is not known:** they are based on commit \`${AMENDED}\`, and the branch could not be read (`;
    const at = text.indexOf(start);
    assert.ok(at >= 0, text);
    const paragraph = text.slice(at).split('\n')[0] ?? '';
    assert.match(paragraph, /404/);
    assert.ok(paragraph.endsWith('). Nothing is re-decided.'), paragraph);
    assert.ok(text.indexOf(paragraph) < text.indexOf('Suggestion pull requests ('), 'before the list');
    assert.doesNotMatch(text, /changed since these suggestions were planned:\*\* they are based/);
    for (const pull of threePulls(world)) assert.deepEqual(proposalCommit(world, pull.head).parents, [AMENDED]);
  });

  test('a retry refused by GitHub carries the warning with its refusal', async () => {
    const world = makeWorld(AMENDED, { companion: { loseResponse: ['pull'] } });
    world.host.hide({ pulls: 1 });
    assert.equal(status(await publish(world)), 'uncertain');
    world.host.replaceRepository(repositoryAt(DROPPED));
    world.host.setConfig({ companion: { refuse: { ref: 422 } } });
    const retried = await publish(world);
    assert.equal(status(retried), 'rejected', markdown(retried));
    const text = markdown(retried);
    assert.ok(text.includes(changedSincePlanned(AMENDED, DROPPED)), text);
    assert.ok(text.indexOf('It is never resent') < text.indexOf(changedSincePlanned(AMENDED, DROPPED)), 'after the refusal');
    assert.deepEqual(world.host.reviews(), [], 'the review is not published');
  });

  test('a completed publication is reported from its receipts, with no request that writes and no ancestry read', async () => {
    const world = makeWorld(AMENDED);
    assert.equal(status(await publish(world)), 'published');
    const before = writes(world).length;
    const compares = compareReads(world).length;
    world.host.replaceRepository(repositoryAt(DROPPED));
    const again = await publish(world);
    assert.equal(status(again), 'published', markdown(again));
    assert.equal(writes(world).length, before);
    assert.equal(compareReads(world).length, compares, 'nothing is left to create, so the branch is not checked');
    assert.ok(markdown(again).includes(`re-applied onto commit \`${AMENDED}\`):`), markdown(again));
    assert.doesNotMatch(markdown(again), /changed since these suggestions were planned/);
  });

  test('when nothing is re-applied, a lost review response is rediscovered and never resent, as for any review', async () => {
    const world = makeWorld(DROPPED, { create: 'lose-response' });
    const first = await publish(world);
    assert.equal(status(first), 'published', markdown(first));
    assert.ok(markdown(first).includes('was confirmed on GitHub for this publication; nothing was resent.'), markdown(first));
    world.host.setConfig({ create: 'ok' });
    const before = writes(world).length;
    const retried = await publish(world);
    assert.equal(status(retried), 'published', markdown(retried));
    assert.equal(writes(world).length, before, 'the retry is answered from the receipt');
    assert.equal(world.host.reviews().length, 1);
    assert.deepEqual(world.host.pulls(), []);
  });
});


describe('a head file that cannot be read as source is a reason to skip, never a failure (§2.5.1)', () => {
  for (const [head, what, reason] of [
    [NOT_TEXT, 'not UTF-8', '`docs/sample.md` is not UTF-8 text at the head'],
    [OVERSIZE, 'over the source-read limit', '`docs/sample.md` exceeds the source-read limit'],
  ] as const) {
    test(`an edited file that is ${what} at the head skips its suggestion; the others are re-applied`, async () => {
      const assessed = await validate(makeWorld(head));
      assert.equal(status(assessed), 'ready', markdown(assessed));
      const world = makeWorld(head);
      const outcome = await publish(world);
      assert.equal(status(outcome), 'published', markdown(outcome));
      assert.deepEqual(world.host.pulls().map((p) => p.title), [CREATE.title, DELETE.title]);
      const expected = warningsBlock(notReapplied('/runs/0/results/0', REWORD, head, [reason]));
      assert.equal(warningsOf(markdown(outcome)), expected);
      assert.equal(warningsOf(markdown(assessed)), expected);
      const [review] = world.host.reviews();
      assert.ok(review);
      assert.ok(review.request.body.startsWith(skippedSection(REWORD, head, [reason]).join('\n')), review.request.body);
    });
  }
});

describe('the ancestry read is made only when a suggestion pull request could be created (§2.5, §2.8)', () => {
  const remarkOnly = (): Json => {
    const doc = reviewDocument();
    const [run] = asArray(doc['runs']);
    const results = asArray(asRecord(run)['results']);
    return { ...doc, runs: [{ ...asRecord(run), results: results.slice(4) }] };
  };

  test('a review that creates no suggestion pull request never reads it, so its failure cannot refuse the review', async () => {
    const world = makeWorld(AMENDED, { failAncestryCompare: 404 });
    const assessed = await validateWith(world, remarkOnly());
    assert.equal(status(assessed), 'ready', markdown(assessed));
    const outcome = await publishWith(world, remarkOnly());
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(compareReads(world).filter((c) => !c.startsWith(`${BASE}...`)), [], 'no ancestry read');
  });

  test('when one is needed, a failed read is operational: validate is incomplete, publish rejects, and nothing is written', async () => {
    const world = makeWorld(AMENDED, { failAncestryCompare: 404 });
    const assessed = await validate(world);
    assert.equal(status(assessed), 'incomplete', markdown(assessed));
    assert.match(markdown(assessed), /404/);
    await assert.rejects(publish(world), /404/);
    assert.deepEqual(writes(world), []);
    assert.equal(fs.existsSync(world.statePath), false);
  });
});

describe('every problem is reported together after a rewritten history too (§2.8)', () => {
  const pages = (): Json => {
    const artifacts = Array.from({ length: 11 }, (_, i) => ({ location: { uri: `docs/p${String(i)}.md` }, contents: { text: `# ${String(i)}\n` }, encoding: 'utf-8' }));
    const results = artifacts.map((_, i) => ({
      message: { text: `Page ${String(i)}.` },
      properties: { sarifToComment: { proposedFileChanges: [{ operation: 'create', artifactIndex: i }], ...(i === 0 ? { suggestionGroup: 'solo' } : {}) } },
    }));
    const [run] = asArray(reviewDocument()['runs']);
    return { ...reviewDocument(), runs: [{ ...asRecord(run), artifacts, results }] };
  };
  const problems = [
    '- `suggestion-group-single-change` at `/runs/0/results/0`: Suggestion group "solo" holds only one distinct change; a group needs at least two changes to accept together. Remove the group, and the change is published on its own.',
    '- `too-many-suggestion-prs`: The review needs 11 suggestion pull requests; the limit is 10. Nothing is split or dropped.',
  ];

  for (const head of [REVIEWED, AMENDED]) {
    test(`the limit is reported with the other problems (${head === REVIEWED ? 'head is the reviewed commit' : 'rewritten history'})`, async () => {
      const world = makeWorld(head);
      const assessed = await validateWith(world, pages());
      assert.equal(status(assessed), 'blocked', markdown(assessed));
      for (const line of problems) assert.ok(markdown(assessed).includes(line), markdown(assessed));
      assert.ok(markdown(assessed).includes('**Review blocked:** 2 problems must be resolved'), markdown(assessed));
    });
  }
});

describe('a fix with several changes (issue #29) after a rewritten history (§2.3, §2.5.1)', () => {
  /** One finding whose single fix replaces lines 6 and 10 of docs/sample.md together, with no group property. */
  function jointFixDocument(): Json {
    const document = reviewDocument();
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
  const TITLE = 'Suggestion for #7: edit docs/sample.md';

  test('re-applied onto the amended head as one suggestion pull request, keeping the amendment', async () => {
    const world = makeWorld(AMENDED);
    const outcome = await publishWith(world, jointFixDocument());
    assert.equal(status(outcome), 'published', markdown(outcome));
    const [pull, ...others] = world.host.pulls();
    assert.ok(pull && others.length === 0, 'exactly one suggestion pull request');
    assert.equal(pull.title, TITLE);
    assert.ok(pull.body.includes(REWORD.changes.join('\n')), pull.body);
    assert.deepEqual(proposalCommit(world, pull.head).parents, [AMENDED], 'never the discarded reviewed commit');
    assert.equal(proposalCommit(world, pull.head).message,
      `${TITLE}\n\nSuggested in a review of ${OWNER}/${REPO} pull request 7 at commit ${REVIEWED}, and re-applied onto commit ${AMENDED} after the pull request's history was rewritten.`);
    assert.deepEqual(world.host.fileOnBranch(pull.head, 'docs/sample.md'), suggestedSample(SNAPSHOTS[AMENDED]?.['docs/sample.md'] ?? []));
    const reading = findSuggestionMarker(pull.body);
    assert.equal(reading.kind, 'marker');
    assert.equal(reading.fields.reappliedOnto, AMENDED);
  });

  test('not created when one of its lines changed at the rewritten head; the whole fix is kept together, never split', async () => {
    const world = makeWorld(REWRITTEN);
    const outcome = await publishWith(world, jointFixDocument());
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.deepEqual(world.host.pulls(), [], 'line 10 alone is not proposed');
    const [review] = world.host.reviews();
    assert.ok(review);
    assert.deepEqual(review.request.comments, [], 'no native suggestion is substituted');
    assert.ok(review.request.body.startsWith('**Suggestion pull request not created:** the history of #7 was rewritten after the reviewed commit, and this change cannot be re-applied onto commit '
      + `${REWRITTEN}, the head of #7, because there:\n\n- \`docs/sample.md\` line 6 differs from the reviewed text\n`), review.request.body);
    assert.ok(markdown(outcome).includes(`\`suggestion-pr-not-reapplied\` at \`/runs/0/results/0\`: The history of #7 was rewritten after the reviewed commit, so the suggestion pull request \`${TITLE}\``), markdown(outcome));
    const assessed = await validateWith(makeWorld(REWRITTEN), jointFixDocument());
    assert.equal(warningsOf(markdown(assessed)), warningsOf(markdown(outcome)));
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

  test('validate and publish report the same per-suggestion outcomes (exit 0)', () => {
    const world = makeWorld(REWRITTEN);
    const file = path.join(world.root, 'review.sarif');
    fs.writeFileSync(file, JSON.stringify(reviewDocument()));
    const target = ['--sarif', file, '--repo', `${OWNER}/${REPO}`, '--pull', String(PULL), '--commit', REVIEWED, '--allow-suggestion-prs'];
    const checked = cli(world, ['validate', ...target]);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    const published = cli(world, ['publish', ...target, '--state', world.statePath]);
    assert.equal(published.status, 0, published.stdout + published.stderr);
    // Human form: the warnings are diagnostics on stderr, once each, with the messages the Markdown lists.
    for (const [pointer, unit, reasons] of [
      ['/runs/0/results/0', REWORD, ['`docs/sample.md` line 6 differs from the reviewed text']],
      ['/runs/0/results/3', DELETE, ['`obsolete.txt` differs from the reviewed file']],
    ] as const) {
      const message = notReapplied(pointer, unit, REWRITTEN, reasons).replace(/^- `suggestion-pr-not-reapplied` at `[^`]+`: /, '');
      for (const run of [checked, published]) {
        assert.ok(run.stderr.includes(`[suggestion-pr-not-reapplied]\n  ${pointer}\n  ${message}\n`), run.stderr);
        assert.equal(run.stdout.includes(message), false, 'not repeated on stdout');
      }
    }
    for (const run of [checked, published]) assert.ok(run.stderr.endsWith('\n2 warnings\n'), run.stderr);
    assert.equal(world.host.pulls().length, 1);
  });
});
