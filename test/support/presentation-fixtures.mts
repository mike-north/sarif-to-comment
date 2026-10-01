/**
 * Shared fixtures for the review presentation tests
 * (test/presentation-*.test.mts): an in-memory reviewed repository for the
 * preparation boundary, SARIF authoring shorthands, and a fake GitHub host
 * driven through the real client for the publication boundary.
 *
 * The repositories are authored by hand; nothing here is captured from
 * program output.
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createGitHubClient } from '../../dist/github.cjs';
import { prepareReview } from '../../dist/prepare-review.cjs';
import type { IReadyOutcome, PrepareReviewOutcome } from '../../dist/prepare-review.cjs';
import { publishSarifReviewWithInternals } from '../../dist/publish-sarif-review.cjs';
import type { PublishSarifReviewOutcome } from '../../dist/publish-sarif-review.cjs';
import { validateSarifReviewWithInternals } from '../../dist/validate-sarif-review.cjs';
import type { ValidateSarifReviewOutcome } from '../../dist/validate-sarif-review.cjs';
import { FakeHttpGitHub } from '../fixtures/composition/fake-http-github.mts';
import type { IHttpRepository } from '../fixtures/composition/fake-http-github.mts';

export type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Preparation boundary: an in-memory reviewed repository (acme/widgets#7)

export const BASE = '1111111111111111111111111111111111111111';
export const R = '2222222222222222222222222222222222222222';
export const SHORT = '2222222';
/** The separator between findings and between sections (rendering grammar). */
export const SEP = '\n\n---\n\n';

const SNAPSHOT: Readonly<Record<string, string>> = {
  'src/app.js': 'a\nc\nd\n',
  'docs/notes.md': 'first\nsecond\nthird\n',
  'obsolete.txt': 'first line\nsecond line\n',
  'odd dir/a(1).txt': 'odd\n',
};
const BASE_SNAPSHOT: Readonly<Record<string, string>> = { 'src/app.js': 'a\nb\nd\n' };

/** The review context: src/app.js line 2 is the pull request's only change. */
export const CONTEXT = {
  owner: 'acme',
  repo: 'widgets',
  pullNumber: 7,
  reviewedCommit: R,
  diff: { baseCommit: BASE, headCommit: R, files: [{ path: 'src/app.js', patch: '@@ -1,3 +1,3 @@\n a\n-b\n+c\n d' }] },
};

function snapshotAt(commit: string): Readonly<Record<string, string>> {
  if (commit === R) return SNAPSHOT;
  if (commit === BASE) return BASE_SNAPSHOT;
  throw new Error(`unknown commit ${commit}`);
}

/** Whole-review preparation of `sarif` against the in-memory repository, with optional internal options. */
export function prepareOutcome(sarif: Json, options?: Json): Promise<PrepareReviewOutcome> {
  return prepareReview({
    sarif,
    context: CONTEXT,
    readSource: (commit: string, filePath: string) => Promise.resolve(snapshotAt(commit)[filePath] ?? null),
    fileExists: (commit: string, filePath: string) => Promise.resolve(Object.hasOwn(snapshotAt(commit), filePath)),
    ...(options === undefined ? {} : { options }),
  });
}

/** {@link prepareOutcome}, which must be ready. */
export async function prepare(sarif: Json, options?: Json): Promise<IReadyOutcome> {
  const outcome = await prepareOutcome(sarif, options);
  assert.equal(outcome.status, 'ready', outcome.markdown);
  return outcome;
}

/** A permalink to a file at the reviewed commit (file-operation contract §2: PERMALINK). */
export const permalink = (encodedPath: string, anchor = ''): string => `https://github.com/acme/widgets/blob/${R}/${encodedPath}${anchor}`;

// ---------------------------------------------------------------------------
// SARIF shorthands

/** One run bound to the reviewed commit of acme/widgets (versionControlProvenance, SARIF 3.14.15). */
export function run(tool: Json, results: readonly Json[], artifacts: readonly Json[] = []): Json {
  return {
    tool,
    columnKind: 'utf16CodeUnits',
    versionControlProvenance: [{ repositoryUri: 'https://github.com/acme/widgets', revisionId: R }],
    artifacts,
    results,
  };
}

export const log = (...runs: readonly Json[]): Json => ({ version: '2.1.0', runs });

/** A location on `uri`, with an optional region and location message. */
export const at = (uri: string, region?: Json, message?: string): Json => ({
  physicalLocation: { artifactLocation: { uri }, ...(region === undefined ? {} : { region }) },
  ...(message === undefined ? {} : { message: { text: message } }),
});

/** A fix replacing whole line `line` of `uri` with `text`. */
export const lineFix = (uri: string, line: number, text: string, description: string): Json => ({
  description: { text: description },
  artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion: { startLine: line }, insertedContent: { text } }] }],
});

/** A result carrying whole-file proposals (the owned `proposedFileChanges` property). */
export function carrying(text: string, operations: readonly Json[], location?: Json): Json {
  return {
    message: { text },
    ...(location === undefined ? {} : { locations: [location] }),
    properties: { sarifToComment: { proposedFileChanges: operations } },
  };
}

// ---------------------------------------------------------------------------
// Publication boundary: the real client against the fake HTTP host (octo/widgets#7)

export const HEAD = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
const HEAD_BASE = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e';
export const TOKEN = 'ghp_PRESENTATION_FIXTURES_0123456789';
export const DESTINATION = { owner: 'octo', repo: 'widgets', pullNumber: 7 } as const;
export const GUIDE = '# Guide\n\nUse the client.\n';
/** The hidden per-publication marker the publication core appends (publication.cts MARKER_PATTERN). */
export const REVIEW_MARKER = /\n\n<!-- sarif-to-comment:review:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} -->$/;
/** The structured suggestion marker line (convention §7), captured with its JSON. */
export const SUGGESTION_MARKER = /\n\n(<!-- suggestion-pr (\{[^\n]*\}) -->)$/;

/** The host's repository: README.md line 2 is the pull request's only change; head branch feature/retry into main. */
export const HOST_REPOSITORY: IHttpRepository = {
  destination: DESTINATION,
  commits: { base: HEAD_BASE, head: HEAD },
  snapshots: {
    [HEAD_BASE]: { 'README.md': ['# Widgets\n'], 'docs/index.md': ['# Docs\n'] },
    [HEAD]: { 'README.md': ['# Widgets\n', 'More.\n'], 'docs/index.md': ['# Docs\n'] },
  },
  pullFiles: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: ['@@ -1 +1,2 @@\n', ' # Widgets\n', '+More.'] }],
  pull: { headRef: 'feature/retry', baseRef: 'main' },
  defaultBranch: 'main',
  labels: ['suggestion-pr'],
};

/** A run of "Review bot 1.0.0" bound to the reviewed head of octo/widgets. */
export function hostDocument(results: readonly Json[], artifacts: readonly Json[] = []): Json {
  return {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Review bot', version: '1.0.0' } },
      columnKind: 'utf16CodeUnits',
      versionControlProvenance: [{ repositoryUri: 'https://github.com/octo/widgets', revisionId: HEAD }],
      artifacts,
      results,
    }],
  };
}

/** A standalone creation of docs/guide.md with a finding on its line 1. */
export const GUIDE_DOCUMENT = hostDocument(
  [carrying('Add a guide.', [{ operation: 'create', artifactIndex: 0 }], at('docs/guide.md', { startLine: 1 }))],
  [{ location: { uri: 'docs/guide.md' }, contents: { text: GUIDE }, encoding: 'utf-8' }],
);

export interface IHostWorld {
  readonly root: string;
  readonly host: FakeHttpGitHub;
  readonly statePath: string;
}

export function hostWorld(): IHostWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-')));
  FakeHttpGitHub.create(path.join(root, 'host'), {}, HOST_REPOSITORY);
  return { root, host: new FakeHttpGitHub(path.join(root, 'host'), TOKEN), statePath: path.join(root, 'review.json') };
}

/** The real client for one world, talking to its fake host. */
const internalsFor = (world: IHostWorld) => ({ createGitHubClient: (options: Parameters<typeof createGitHubClient>[0]) => createGitHubClient({ ...options, fetch: world.host.fetch }) });

/** publishSarifReview of `sarif` to octo/widgets#7 at its head, through the world's host. */
export function publish(world: IHostWorld, sarif: Json, options?: object): Promise<PublishSarifReviewOutcome> {
  return publishSarifReviewWithInternals(
    { sarif, destination: DESTINATION, reviewedCommit: HEAD, statePath: world.statePath, token: TOKEN, ...(options === undefined ? {} : { options }) },
    internalsFor(world),
  );
}

/** validateSarifReview of `sarif` for octo/widgets#7 at its head, through the world's host. */
export function validate(world: IHostWorld, sarif: Json, options?: object): Promise<ValidateSarifReviewOutcome> {
  return validateSarifReviewWithInternals(
    { sarif, destination: DESTINATION, reviewedCommit: HEAD, token: TOKEN, ...(options === undefined ? {} : { options }) },
    internalsFor(world),
  );
}

/** The one stored review's body, with its trailing publication marker checked and removed. */
export function reviewBodyWithoutMarker(world: IHostWorld): string {
  const reviews = world.host.reviews();
  assert.equal(reviews.length, 1);
  const body = reviews[0]?.request.body ?? '';
  assert.match(body, REVIEW_MARKER);
  return body.replace(REVIEW_MARKER, '');
}
