/**
 * Diagnostics on every library outcome (docs/diagnostics.md, "On every
 * outcome" and "Compatibility with 0.2.x"; D45).
 *
 * For each operation, a representative outcome of each kind is produced
 * through the public package entry and checked for:
 * - `diagnostics` always present, appended after the 0.2.x keys, ordered
 *   errors, warnings, notes, each schema-valid with the documented severity,
 *   title and remedies of its code;
 * - `problems` (and receipt `warnings`, inspection's `view.diagnostics`)
 *   keeping their 0.2.x values and key order and gaining the diagnostic
 *   fields additively;
 * - `markdown` unchanged where a test pins it.
 *
 * The 0.2.x values below were written by hand from the contracts and the
 * released behavior (the messages are unchanged); codes and locations come
 * from the documented catalog.
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { createGitHubClient } from '../dist/github.cjs';
import type { ICreateGitHubClientOptions, IGitHubClient } from '../dist/github.cjs';
import library from '../dist/index.cjs';
import { FakeHttpGitHub } from './fixtures/composition/fake-http-github.mts';
import type { IHttpRepository } from './fixtures/composition/fake-http-github.mts';
import type { ICompanionConfig, IStoredPull } from './fixtures/composition/fake-http-companion.mts';
import { DEFAULT_USER, FakeGitHubRemote } from './fixtures/publication/fake-github.mts';
import type { IFakeRemoteConfig } from './fixtures/publication/fake-github.mts';
import { REPOSITORY, createFakeClientFactory, setAdapterConfig } from './fixtures/public-api/fake-adapter.mts';
import { createFixtureRepo, removeFixtureRepo } from './fixtures/staged-changes/git-fixture.mts';
import type { IFixtureRepo, IFixtureRepoSpec } from './fixtures/staged-changes/git-fixture.mts';
import { assertDiagnostics, assertProblemsExtend } from './support/diagnostics.mts';
import { asArray, asRecord, asString, readJson } from './support/runtime-types.mts';

type Json = Record<string, unknown>;

const PUBLIC_API = path.join(import.meta.dirname, 'fixtures', 'public-api');
const READY = asRecord(readJson(path.join(PUBLIC_API, 'ready.sarif.json')));
const HELD = asRecord(readJson(path.join(PUBLIC_API, 'held.sarif.json')));
const INVALID = asRecord(readJson(path.join(PUBLIC_API, 'invalid.sarif.json')));
const TOKEN = 'ghp_DIAGNOSTICS_OUTCOMES_token_24680';
const DESTINATION = REPOSITORY.destination;
const HEAD = REPOSITORY.commits.head;

/** The 0.2.x problem of INVALID (the schema requires a run's tool). */
const INVALID_PROBLEM = { message: "`/runs/0` must have required property 'tool'.", pointer: '/runs/0' };
const INVALID_MARKDOWN = "**Invalid SARIF:** the document does not conform to the SARIF 2.1.0 schema, so it was not interpreted.\n\n- `/runs/0` must have required property 'tool'.";

/** Calls a public operation by name with any arguments, as a JavaScript consumer can. */
async function call(name: string, ...args: unknown[]): Promise<Json> {
  const operation: unknown = Reflect.get(library, name);
  if (typeof operation !== 'function') throw new assert.AssertionError({ message: `the package exports ${name}` });
  const outcome: unknown = await Reflect.apply(operation, undefined, args);
  return asRecord(outcome, `the ${name} outcome`);
}

/** A one-run document with `results`. */
function doc(results: readonly object[], runExtra: object = {}): Json {
  return { version: '2.1.0', runs: [{ tool: { driver: { name: 'Reviewer' } }, results, ...runExtra }] };
}

function located(uri: string, startLine: number, text = 'Finding.', extra: object = {}): object {
  return { message: { text }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine } } }], ...extra };
}

function textFix(uri: string, startLine: number, text: string): object {
  return { artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion: { startLine }, insertedContent: { text } }] }] };
}

/** The shared invalid-SARIF expectations of every operation that validates its input. */
function assertInvalid(outcome: Json, keys: readonly string[] = ['status', 'problems', 'markdown', 'diagnostics']): void {
  assert.equal(outcome['status'], 'invalid');
  assert.deepEqual(Object.keys(outcome), keys);
  assert.equal(outcome['markdown'], INVALID_MARKDOWN, 'the Markdown is unchanged');
  assertDiagnostics(outcome['diagnostics'], [{ code: 'sarif-schema-invalid', location: { pointer: '/runs/0' }, message: /required property 'tool'/ }]);
  assertProblemsExtend(outcome['problems'], [INVALID_PROBLEM], outcome['diagnostics']);
}

describe('authoring: addSarifComment and removeSarifComment', () => {
  const comment = { file: 'src/a.ts', line: 3, message: 'Check this.' };

  test('an added comment has no diagnostics', async () => {
    const outcome = await call('addSarifComment', doc([]), comment);
    assert.equal(outcome['status'], 'added');
    assert.deepEqual(Object.keys(outcome), ['status', 'sarif', 'finding', 'diagnostics']);
    assertDiagnostics(outcome['diagnostics'], []);
  });

  test('invalid SARIF: sarif-schema-invalid, and the problem keeps its message and pointer', async () => {
    assertInvalid(await call('addSarifComment', INVALID, comment));
  });

  test('a document without runs: sarif-no-runs at /runs', async () => {
    const outcome = await call('addSarifComment', { version: '2.1.0', runs: [] }, comment);
    assert.equal(outcome['status'], 'invalid');
    assertDiagnostics(outcome['diagnostics'], [{ code: 'sarif-no-runs', location: { pointer: '/runs' } }]);
    assertProblemsExtend(outcome['problems'], [{
      message: 'The document has no run to add the comment to. Pass `run: { toolName }` to add one under your own attribution.',
      pointer: '/runs',
    }], outcome['diagnostics']);
    assert.equal(outcome['markdown'], '**Cannot add the comment:** The document has no run to add the comment to. Pass `run: { toolName }` to add one under your own attribution.');
  });

  test('a removed finding has no diagnostics; a stale selector is finding-selector-stale at its position', async () => {
    const sarif = doc([located('a.ts', 1), located('b.ts', 2)]);
    const inspected = await call('inspectSarif', sarif);
    const findings = asArray(asRecord(inspected['view'])['findings']);
    const selector = asString(asRecord(findings[1])['selector']);
    const removed = await call('removeSarifComment', sarif, selector);
    assert.equal(removed['status'], 'removed');
    assert.deepEqual(Object.keys(removed), ['status', 'sarif', 'finding', 'diagnostics']);
    assertDiagnostics(removed['diagnostics'], []);

    const stale = await call('removeSarifComment', removed['sarif'], selector);
    assert.equal(stale['status'], 'stale');
    assert.deepEqual(Object.keys(stale), ['status', 'selector', 'problems', 'markdown', 'diagnostics']);
    assertDiagnostics(stale['diagnostics'], [{ code: 'finding-selector-stale', location: { pointer: '/runs/0/results/1' }, message: /has changed since the selector/ }]);
    const problem = asRecord(asArray(stale['problems'])[0]);
    assertProblemsExtend(stale['problems'], [{ message: problem['message'], pointer: '/runs/0/results/1' }], stale['diagnostics']);
  });

  test('removal of invalid SARIF reports sarif-schema-invalid', async () => {
    assertInvalid(await call('removeSarifComment', INVALID, '/runs/0/results/0@0123456789abcdef'));
  });
});

describe('grouping: groupSarifFixes and ungroupSarifFixes', () => {
  const sarif = doc([
    located('a.ts', 1, 'One.', { fixes: [textFix('a.ts', 1, 'one\n')] }),
    located('b.ts', 1, 'Two.', { fixes: [textFix('b.ts', 1, 'two\n')] }),
    located('c.ts', 1, 'No change.'),
  ]);

  async function selectors(value: Json): Promise<string[]> {
    const inspected = await call('inspectSarif', value);
    return asArray(asRecord(inspected['view'])['findings']).map((f) => asString(asRecord(f)['selector']));
  }

  test('a grouping has no diagnostics; a refusal lists each problem as an error diagnostic', async () => {
    const [a = '', b = '', c = ''] = await selectors(sarif);
    const grouped = await call('groupSarifFixes', sarif, { findings: [a, b], group: 'Docs' });
    assert.equal(grouped['status'], 'grouped');
    assert.equal(Object.keys(grouped).at(-1), 'diagnostics');
    assertDiagnostics(grouped['diagnostics'], []);

    const refused = await call('groupSarifFixes', sarif, { findings: [a, c], group: 'Docs' });
    assert.equal(refused['status'], 'refused');
    assert.deepEqual(Object.keys(refused), ['status', 'problems', 'markdown', 'diagnostics']);
    assertDiagnostics(refused['diagnostics'], [
      { code: 'suggestion-group-member-without-change', location: { pointer: '/runs/0/results/2' }, message: /proposes no change/ },
      { code: 'suggestion-group-single-change', location: { pointer: '/runs/0/results/0' }, message: /at least two distinct changes/ },
    ]);
    const problems = asArray(refused['problems']).map((p) => asRecord(p));
    assertProblemsExtend(refused['problems'], problems.map((p) => ({ message: p['message'], pointer: p['pointer'] })), refused['diagnostics']);
  });

  test('ungrouping a finding that is in no group is finding-not-grouped', async () => {
    const [a = ''] = await selectors(sarif);
    const refused = await call('ungroupSarifFixes', sarif, { findings: [a] });
    assert.equal(refused['status'], 'refused');
    assertDiagnostics(refused['diagnostics'], [{ code: 'finding-not-grouped', location: { pointer: '/runs/0/results/0' } }]);
  });

  test('grouping invalid SARIF reports sarif-schema-invalid', async () => {
    assertInvalid(await call('groupSarifFixes', INVALID, { findings: ['/runs/0/results/0@0123456789abcdef', '/runs/0/results/1@0123456789abcdef'], group: 'G' }));
  });
});

describe('inspectSarif', () => {
  test('an inspection without warnings has empty diagnostics after the view', async () => {
    const outcome = await call('inspectSarif', READY);
    assert.deepEqual(Object.keys(outcome), ['status', 'view', 'diagnostics']);
    assertDiagnostics(outcome['diagnostics'], []);
    assert.deepEqual(asRecord(outcome['view'])['diagnostics'], []);
  });

  test('an inspection warning is a warning diagnostic, and the view entry keeps severity, message and pointer first', async () => {
    const sarif = doc([{ message: { id: 'undefined-id' } }]);
    const outcome = await call('inspectSarif', sarif);
    const [diagnostic] = assertDiagnostics(outcome['diagnostics'], [{ code: 'uninterpreted-message', location: { pointer: '/runs/0/results/0/message' }, message: /undefined-id/ }]);
    const view = asRecord(outcome['view']);
    const entries = asArray(view['diagnostics']).map((d) => asRecord(d));
    assert.equal(entries.length, 1);
    const entry = entries[0] ?? {};
    assert.deepEqual(Object.keys(entry).slice(0, 3), ['severity', 'message', 'pointer'], 'the 0.2.x fields first');
    assert.equal(entry['severity'], 'warning');
    assert.equal(entry['pointer'], '/runs/0/results/0/message');
    for (const key of ['code', 'title', 'message', 'location', 'remedies']) assert.deepEqual(entry[key], diagnostic?.[key], key);
    assert.equal(view['version'], 1, 'the view version is unchanged: entries only gain fields');
  });

  test('inspecting invalid SARIF reports sarif-schema-invalid', async () => {
    assertInvalid(await call('inspectSarif', INVALID));
  });
});

describe('addStagedChangesToSarif', () => {
  const repos: IFixtureRepo[] = [];
  const fixture = (spec: IFixtureRepoSpec): IFixtureRepo => {
    const repo = createFixtureRepo(spec);
    repos.push(repo);
    return repo;
  };
  test.after(() => {
    repos.forEach(removeFixtureRepo);
  });
  const extract = (repo: IFixtureRepo, sarif: Json): Promise<Json> =>
    call('addStagedChangesToSarif', { sarif, worktree: repo.dir, reviewedCommit: repo.reviewedCommit, repository: { owner: 'acme', repo: 'widgets' } });

  test('a receipt warning is a warning diagnostic; the receipt keeps its pointer, path and message first', async () => {
    const repo = fixture({ reviewed: { 'f.txt': 'a\nb\nc\nd\n' }, staged: { 'f.txt': 'a\nB\nc\nd\n' } });
    const partial = { message: { text: 'Partial.' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'f.txt' }, region: { startLine: 2, endLine: 3 } } }] };
    const outcome = await extract(repo, doc([partial]));
    assert.equal(outcome['status'], 'added');
    assert.deepEqual(Object.keys(outcome), ['status', 'sarif', 'receipt', 'diagnostics']);
    const [diagnostic] = assertDiagnostics(outcome['diagnostics'], [{
      code: 'finding-partially-overlaps-change',
      location: { pointer: '/runs/0/results/0', path: 'f.txt' },
      message: /partially overlaps the staged change to lines 2-2/,
    }]);
    const warnings = asArray(asRecord(outcome['receipt'])['warnings']).map((w) => asRecord(w));
    assert.equal(warnings.length, 1);
    const warning = warnings[0] ?? {};
    assert.deepEqual(Object.keys(warning).slice(0, 3), ['pointer', 'path', 'message']);
    for (const key of ['severity', 'code', 'title', 'message', 'location', 'remedies']) assert.deepEqual(warning[key], diagnostic?.[key], key);
  });

  test('a failure lists each problem as an error diagnostic with its path', async () => {
    const repo = fixture({ reviewed: { 'a.txt': 'a\n' }, staged: { 'a.txt': 'a\n', 'n.bin': Buffer.from([0x61, 0x00, 0x62]) } });
    const outcome = await extract(repo, doc([]));
    assert.equal(outcome['status'], 'failed');
    assert.deepEqual(Object.keys(outcome), ['status', 'problems', 'markdown', 'diagnostics']);
    assertDiagnostics(outcome['diagnostics'], [{ code: 'staged-binary', location: { path: 'n.bin' }, message: /binary/ }]);
    assertProblemsExtend(outcome['problems'], [{
      path: 'n.bin',
      message: 'is binary (it contains NUL bytes) in the index; binary changes cannot be proposed as text. Unstage it and retry.',
    }], outcome['diagnostics']);
    assert.equal(
      outcome['markdown'],
      '**Staged changes could not be added; nothing was produced.**\n\n- `n.bin`: is binary (it contains NUL bytes) in the index; binary changes cannot be proposed as text. Unstage it and retry.\n',
    );
  });
});

// ---------------------------------------------------------------------------
// validateSarifReview and publishSarifReview, through the private client seam

interface IWorld {
  readonly root: string;
  readonly statePath: string;
  readonly remote: FakeGitHubRemote;
  readonly internals: { readonly createGitHubClient: ReturnType<typeof createFakeClientFactory> };
}

function makeWorld(config: Partial<IFakeRemoteConfig> = {}): IWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-outcomes-')));
  const remote = FakeGitHubRemote.create(path.join(root, 'remote'), config);
  return { root, statePath: path.join(root, 'review.publication.json'), remote, internals: { createGitHubClient: createFakeClientFactory(remote.dir) } };
}

const review = (sarif: Json, extra: Json = {}): Json => ({ sarif: structuredClone(sarif), destination: { ...DESTINATION }, reviewedCommit: HEAD, token: TOKEN, ...extra });

/** READY with a taxonomy classification on its second result, which preparation warns about. */
const WITH_TAXA = (() => {
  const copy = structuredClone(READY);
  const run = asRecord(asArray(copy['runs'])[0]);
  const result = asRecord(asArray(run['results'])[1]);
  result['taxa'] = [{ id: 'CWE-20' }];
  return copy;
})();

describe('validateSarifReview', () => {
  test('ready: its preparation warnings, and nothing else', async () => {
    const world = makeWorld();
    const plain = await call('validateSarifReview', review(READY), world.internals);
    assert.equal(plain['status'], 'ready');
    assert.deepEqual(Object.keys(plain), ['status', 'markdown', 'diagnostics']);
    assertDiagnostics(plain['diagnostics'], []);

    const warned = await call('validateSarifReview', review(WITH_TAXA), world.internals);
    assert.equal(warned['status'], 'ready');
    assertDiagnostics(warned['diagnostics'], [{ code: 'taxa-uninterpreted', location: { pointer: '/runs/0/results/1' } }]);
    assert.match(asString(warned['markdown']), /`taxa-uninterpreted` at `\/runs\/0\/results\/1`/, 'the Markdown names the code');
  });

  test('blocked: problems keep message and pointer and gain the diagnostic fields', async () => {
    const world = makeWorld();
    const outcome = await call('validateSarifReview', review(HELD), world.internals);
    assert.equal(outcome['status'], 'blocked');
    assert.deepEqual(Object.keys(outcome), ['status', 'problems', 'markdown', 'diagnostics']);
    assertDiagnostics(outcome['diagnostics'], [{ code: 'approval-hold', location: { pointer: '/runs/0/results/0' }, message: /Awaiting approval/ }]);
    assertProblemsExtend(outcome['problems'], [{
      message: 'Awaiting approval: the whole review is held. Resolve the hold or use the explicit override.',
      pointer: '/runs/0/results/0',
    }], outcome['diagnostics']);
  });

  test('blocked by a pending review: pending-review-exists about the pull request, without a location', async () => {
    const world = makeWorld();
    world.remote.seedReview({ ...DESTINATION, authorId: DEFAULT_USER.id, authorLogin: DEFAULT_USER.login, commitId: HEAD, body: 'Earlier.', state: 'PENDING' });
    const outcome = await call('validateSarifReview', review(READY), world.internals);
    assert.equal(outcome['status'], 'blocked');
    assertDiagnostics(outcome['diagnostics'], [{ code: 'pending-review-exists', subject: 'acme/gizmos#7', message: /already has a pending review/ }]);
  });

  test('incomplete: assessment-incomplete naming the cause', async () => {
    const world = makeWorld();
    setAdapterConfig(world.remote.dir, { context: 'unauthorized' });
    const outcome = await call('validateSarifReview', review(READY), world.internals);
    assert.equal(outcome['status'], 'incomplete');
    assert.deepEqual(Object.keys(outcome), ['status', 'markdown', 'diagnostics']);
    const [d] = assertDiagnostics(outcome['diagnostics'], [{ code: 'assessment-incomplete', subject: 'acme/gizmos#7', message: /401/ }]);
    assert.equal(asString(d?.['message']).includes(TOKEN), false, 'the token never appears');
  });
});

describe('publishSarifReview', () => {
  const publish = (world: IWorld, sarif: Json): Promise<Json> => call('publishSarifReview', review(sarif, { statePath: world.statePath }), world.internals);

  test('published: preparation warnings; a retry from the receipt reports the same ones (#42)', async () => {
    const world = makeWorld();
    const outcome = await publish(world, WITH_TAXA);
    assert.equal(outcome['status'], 'published');
    assert.deepEqual(Object.keys(outcome), ['status', 'review', 'statePath', 'markdown', 'diagnostics']);
    assertDiagnostics(outcome['diagnostics'], [{ code: 'taxa-uninterpreted', location: { pointer: '/runs/0/results/1' } }]);
    const again = await publish(world, WITH_TAXA);
    assert.equal(again['status'], 'published');
    assert.deepEqual(again['diagnostics'], outcome['diagnostics']);
  });

  test('blocked: the blocking problems and warnings as diagnostics; the outcome still has no problems field', async () => {
    const world = makeWorld();
    const outcome = await publish(world, HELD);
    assert.equal(outcome['status'], 'blocked');
    assert.deepEqual(Object.keys(outcome), ['status', 'markdown', 'diagnostics']);
    assertDiagnostics(outcome['diagnostics'], [{ code: 'approval-hold', location: { pointer: '/runs/0/results/0' } }]);
  });

  test('uncertain: delivery-unconfirmed about the pull request, with the retry remedies', async () => {
    const world = makeWorld({ create: 'lose-response', visibilityDelay: 4 });
    const outcome = await publish(world, READY);
    assert.equal(outcome['status'], 'uncertain');
    assert.deepEqual(Object.keys(outcome), ['status', 'statePath', 'markdown', 'diagnostics']);
    assertDiagnostics(outcome['diagnostics'], [{ code: 'delivery-unconfirmed', subject: 'acme/gizmos#7' }]);
  });

  test('rejected: review-refused with GitHub\'s reason', async () => {
    const world = makeWorld({ create: 'reject' });
    const outcome = await publish(world, READY);
    assert.equal(outcome['status'], 'rejected');
    assert.deepEqual(Object.keys(outcome), ['status', 'statePath', 'markdown', 'diagnostics']);
    assertDiagnostics(outcome['diagnostics'], [{ code: 'review-refused', subject: 'acme/gizmos#7' }]);
  });
});

// ---------------------------------------------------------------------------
// closeSuggestionPullRequests, over the real client and the HTTP host double

describe('closeSuggestionPullRequests', () => {
  const OWNER = 'octo';
  const REPO = 'widgets';
  const BASE = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e';
  const CLEAN_HEAD = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
  const idOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const marker = (n: number, original: number): string =>
    `<!-- suggestion-pr {"version":1,"original":{"owner":"${OWNER}","repo":"${REPO}","pullNumber":${String(original)}},"reviewedCommit":"${CLEAN_HEAD}","id":"${idOf(n)}","batch":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"} -->`;
  const repository = (): IHttpRepository => ({
    destination: { owner: OWNER, repo: REPO, pullNumber: 7 },
    commits: { base: BASE, head: CLEAN_HEAD },
    snapshots: { [BASE]: { 'README.md': ['# Widgets\n'] }, [CLEAN_HEAD]: { 'README.md': ['# Widgets\n'] } },
    pullFiles: [],
    labels: ['suggestion-pr'],
  });
  const original = (number: number): IStoredPull => ({
    number, title: 'Original', body: 'Work.', head: `feature-${String(number)}`, base: 'main', draft: false, state: 'closed', merged: true, labels: [], authorId: 1,
  });
  const suggestion = (n: number, originalNumber: number, change: Partial<IStoredPull> = {}): IStoredPull => ({
    number: n, title: 'Suggestion', body: `Suggested.\n\n${marker(n, originalNumber)}`, head: `suggestion-pr/${String(originalNumber)}/${idOf(n)}`,
    base: `feature-${String(originalNumber)}`, draft: true, state: 'open', merged: false, labels: ['suggestion-pr'], authorId: 4242, ...change,
  });
  function cleanup(pulls: readonly IStoredPull[], companion: ICompanionConfig = {}): Promise<Json> {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-cleanup-')));
    FakeHttpGitHub.create(path.join(root, 'host'), { companion }, repository());
    const host = new FakeHttpGitHub(path.join(root, 'host'), TOKEN);
    host.seedPulls(pulls);
    const internals = { createGitHubClient: (options: ICreateGitHubClientOptions): IGitHubClient => createGitHubClient({ ...options, fetch: host.fetch }) };
    return call('closeSuggestionPullRequests', { repository: { owner: OWNER, repo: REPO }, token: TOKEN }, internals);
  }

  test('complete: no diagnostics, appended after the 0.2.x keys', async () => {
    const outcome = await cleanup([original(37), suggestion(40, 37)]);
    assert.equal(outcome['status'], 'complete');
    assert.deepEqual(Object.keys(outcome), ['status', 'dryRun', 'originals', 'suggestions', 'markdown', 'diagnostics']);
    assertDiagnostics(outcome['diagnostics'], []);
  });

  test('a close refused by permissions is a warning, a failed close an error, a non-conforming pull request a note', async () => {
    const outcome = await cleanup(
      [original(37), suggestion(40, 37), suggestion(41, 37), suggestion(42, 37, { body: 'No marker.' })],
      { closes: { '40': 'forbidden', '41': 'server-error' } },
    );
    assert.equal(outcome['status'], 'incomplete');
    assertDiagnostics(outcome['diagnostics'], [
      { code: 'suggestion-pr-cleanup-failed', subject: 'octo/widgets#41', message: /HTTP 502/ },
      { code: 'suggestion-pr-close-not-permitted', subject: 'octo/widgets#40', message: /HTTP 403/ },
      { code: 'suggestion-pr-not-conforming', subject: 'octo/widgets#42' },
    ]);
  });

  test('an original that cannot be verified is a warning about that original', async () => {
    const outcome = await cleanup([original(37), suggestion(40, 37)], { pullReads: { '37': 'server-error' } });
    assert.equal(outcome['status'], 'incomplete');
    assertDiagnostics(outcome['diagnostics'], [{ code: 'original-pull-request-unverified', subject: 'octo/widgets#37', message: /HTTP 502/ }]);
  });
});
