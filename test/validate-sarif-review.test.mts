/**
 * Contract tests for the optional whole-review readiness assessment,
 * validateSarifReview (docs/readiness-assessment-contract.md, cited as
 * "contract").
 *
 * Assessment answers whether the complete SARIF artifact can be published
 * faithfully to its intended review, using the publisher's own checks. These
 * tests prove:
 * - its three outcomes: `ready`, `blocked` with reasons, and `incomplete`
 *   when the assessment itself could not be completed (authentication,
 *   network, source reads, a mismatched pull-request context, an account
 *   without a numeric id), never `ready` in those cases;
 * - zero remote writes and zero durable state: the fake GitHub records no
 *   write, and no file appears anywhere in the world directory;
 * - parity with the publisher: for the same input and remote, `ready` exactly
 *   when publication creates the review, `blocked` exactly when publication
 *   blocks (with identical Markdown), and `incomplete` exactly when
 *   publication rejects before any write;
 * - no reusable approval: a `ready` outcome carries nothing publication
 *   accepts, and publication checks the remote again, so a change after
 *   assessment is caught by publication itself.
 *
 * Expected verdicts come from the specification and the hand-authored
 * fixture (test/fixtures/public-api/repository.json: the pull request changes
 * src/app.js; line 4 at the reviewed commit is "const MAX = 100;"), never
 * from program output. The GitHub client is the private seam's file-backed
 * double; a separate composition suite exercises the real client over HTTP.
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api (401 Bad credentials)
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as util from 'node:util';

import library from '../dist/index.cjs';
import type { IPublishSarifReviewInput, PublishSarifReviewOutcome } from '../dist/publish-sarif-review.cjs';
import { FakeGitHubRemote } from './fixtures/publication/fake-github.mts';
import { REPOSITORY, createFakeClientFactory, readSource, setAdapterConfig, trustedContext } from './fixtures/public-api/fake-adapter.mts';
import type { ContextMode } from './fixtures/public-api/fake-adapter.mts';
import { asArray, asRecord, asString, readJson } from './support/runtime-types.mts';
import { isSchemaProblem } from './support/diagnostics.mts';

// ---------------------------------------------------------------------------
// Fixtures (hand-authored from the fixture repository and the specification)
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'public-api');
const loadSarif = (name: string): Record<string, unknown> => asRecord(readJson(path.join(FIXTURE_DIR, name)), name);
const READY = loadSarif('ready.sarif.json');
const HELD = loadSarif('held.sarif.json');
const INVALID = loadSarif('invalid.sarif.json');

const DESTINATION = REPOSITORY.destination;
const HEAD = REPOSITORY.commits.head;
const TOKEN = 'ghp_VALIDATE_SENTINEL_token_value_97531';

/** A one-run LintBot document with the given results (the ready fixture's run, other results replaced). */
function sarifWith(results: readonly unknown[]): Record<string, unknown> {
  return {
    $schema: 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'LintBot', version: '1.4.0' } }, columnKind: 'utf16CodeUnits', results }],
  };
}

/** A result on src/app.js with the given region (and nothing else). */
function located(message: string, region: Record<string, unknown>, uri = 'src/app.js'): Record<string, unknown> {
  return { message: { text: message }, locations: [{ physicalLocation: { artifactLocation: { uri }, region } }] };
}

/**
 * A finding on line 4 with a fix replacing exactly that line. On the pull
 * request as fetched ('ok': the diff ends at the reviewed commit) the fix is
 * a native suggestion; once the pull request has advanced ('historical'), a
 * fix on the reviewed commit is no longer on the diff head and blocks
 * (prepare-review support profile: fixes must be on the reviewed head, which
 * must be the diff head).
 */
const FIXED = sarifWith([
  {
    ...located('MAX is exported but never validated.', { startLine: 4 }),
    fixes: [
      {
        description: { text: 'Name the bound.' },
        artifactChanges: [
          {
            artifactLocation: { uri: 'src/app.js' },
            replacements: [
              { deletedRegion: { startLine: 4, startColumn: 1, endLine: 5, endColumn: 1 }, insertedContent: { text: 'const MAX = 100; // upper bound\n' } },
            ],
          },
        ],
      },
    ],
  },
]);

/** A fix replacing the text of one line of src/app.js (its newline is kept). */
function lineFix(line: number, text: string, uri = 'src/app.js'): Record<string, unknown> {
  return { artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion: { startLine: line }, insertedContent: { text } }] }] };
}

/**
 * FIXED's finding with further fixes after its own. The first fix stays the
 * suggestion; every further fix is listed with the finding as an alternative
 * (owner decision on issue #30), and is never applied.
 */
function withFurtherFixes(...further: readonly Record<string, unknown>[]): Record<string, unknown> {
  const sarif = structuredClone(FIXED);
  const result = asRecord(asArray(asRecord(asArray(sarif['runs'], 'runs')[0], 'run 0')['results'], 'results')[0], 'result 0');
  result['fixes'] = [...asArray(result['fixes'], 'fixes'), ...further];
  return sarif;
}

/** A document case whose verdict follows from the specification. */
interface IDocumentCase {
  readonly name: string;
  readonly sarif: Record<string, unknown>;
  readonly options?: { readonly ignoreApprovalHold: boolean };
  readonly expected: 'ready' | 'blocked';
  /** A JSON Pointer prefix one of the blocking problems must carry. */
  readonly pointer?: string;
  /** Text one of the blocking problems must mention. */
  readonly mentions?: RegExp;
}

const DOCUMENT_CASES: readonly IDocumentCase[] = [
  { name: 'a supported general finding and an in-diff finding', sarif: READY, expected: 'ready' },
  { name: 'a fix on an in-diff line of the diff head', sarif: FIXED, expected: 'ready' },
  // R3, D15: structural validation with the official schema (a run requires a tool).
  { name: 'schema-invalid SARIF', sarif: INVALID, expected: 'blocked', mentions: /schema/i },
  // Issue #30: the first fix is the suggestion and the others are listed as alternatives, so the review is not refused.
  { name: 'a finding offering alternative fixes', sarif: withFurtherFixes(lineFix(4, 'const MAX = 200;'), lineFix(6, 'module.exports = { LIMIT };')), expected: 'ready' },
  // Issue #30: an alternative changing several places is listed with one labelled part per change.
  {
    name: 'an alternative fix making two replacements',
    sarif: withFurtherFixes({ artifactChanges: [{ artifactLocation: { uri: 'src/app.js' }, replacements: [
      { deletedRegion: { startLine: 3 }, insertedContent: { text: 'const LIMIT = 50;' } },
      { deletedRegion: { startLine: 4 }, insertedContent: { text: 'const MAX = 200;' } },
    ] }] }),
    expected: 'ready',
  },
  // Issue #30: an alternative that cannot be shown exactly is refused at its own pointer.
  {
    name: 'an alternative fix on a file the reviewed commit does not have',
    sarif: withFurtherFixes(lineFix(1, 'x', 'src/missing.js')),
    expected: 'blocked',
    pointer: '/runs/0/results/0/fixes/1',
  },
  // Issue #30 and S5: alternatives count toward the 60,000-character comment limit; nothing is truncated.
  {
    name: 'alternative fixes that take the comment over the 60,000-character limit',
    sarif: withFurtherFixes(lineFix(4, `const MAX = '${'x'.repeat(60_000)}';`)),
    expected: 'blocked',
    mentions: /the limit is 60000/,
  },
  // R11, D11, D12: an explicit hold blocks the whole review by default ...
  { name: 'an approval hold', sarif: HELD, expected: 'blocked', pointer: '/runs/0/results/0' },
  // ... and the explicit override bypasses only the hold.
  { name: 'an approval hold with the override', sarif: HELD, options: { ignoreApprovalHold: true }, expected: 'ready' },
  // R3: source consistency. Line 4 is "const MAX = 100;", not this snippet.
  {
    name: 'a region snippet that differs from the reviewed source',
    sarif: sarifWith([located('MIN is unused.', { startLine: 4, snippet: { text: 'const MIN = 1;' } })]),
    expected: 'blocked',
    pointer: '/runs/0/results/0',
  },
  // R3: a nonexistent line is not made valid by schema validity (src/app.js has 6 lines).
  {
    name: 'a line the reviewed file does not have',
    sarif: sarifWith([located('Beyond the end.', { startLine: 40 })]),
    expected: 'blocked',
    pointer: '/runs/0/results/0',
  },
  // R3: an existing-file location naming a file the reviewed snapshot lacks.
  {
    name: 'a file the reviewed commit does not have',
    sarif: sarifWith([located('No such file.', { startLine: 1 }, 'src/missing.js')]),
    expected: 'blocked',
    pointer: '/runs/0/results/0',
  },
  // Supported profile: multiple locations are refused rather than dropped.
  {
    name: 'a finding with two locations',
    sarif: sarifWith([
      {
        message: { text: 'Both bounds.' },
        locations: [
          { physicalLocation: { artifactLocation: { uri: 'src/app.js' }, region: { startLine: 3 } } },
          { physicalLocation: { artifactLocation: { uri: 'src/app.js' }, region: { startLine: 4 } } },
        ],
      },
    ]),
    expected: 'blocked',
    pointer: '/runs/0/results/0',
  },
  // S5 and the documented product limit: at most 60,000 characters per body; nothing is truncated.
  {
    name: 'a review body over the 60,000-character limit',
    sarif: sarifWith([{ message: { text: 'x'.repeat(60_001) } }]),
    expected: 'blocked',
  },
];

// ---------------------------------------------------------------------------
// Outcome typing (runtime-checked; the declarations are checked by the build)
// ---------------------------------------------------------------------------

/** A problem of a blocked assessment, as the contract describes it. */
interface IProblemView {
  readonly message: string;
  readonly pointer?: string;
}

/** An assessment outcome, as these tests read it. */
interface IAssessment {
  readonly status: string;
  readonly markdown: string;
  readonly problems?: readonly IProblemView[];
}

function asAssessment(value: unknown): IAssessment {
  const record = asRecord(value, 'an assessment outcome');
  const problems = record['problems'] === undefined ? undefined : asArray(record['problems'], 'problems').map((p) => {
    const problem = asRecord(p, 'a problem');
    const pointer = problem['pointer'];
    return pointer === undefined
      ? { message: asString(problem['message'], 'a problem message') }
      : { message: asString(problem['message'], 'a problem message'), pointer: asString(pointer, 'a problem pointer') };
  });
  return {
    status: asString(record['status'], 'status'),
    markdown: asString(record['markdown'], 'markdown'),
    ...(problems === undefined ? {} : { problems }),
  };
}

// ---------------------------------------------------------------------------
// World and helpers
// ---------------------------------------------------------------------------

/** The client factory injected through the private seam; the product checks every answer itself. */
type ClientFactory = (options: { readonly token: string; readonly fetch?: unknown }) => object;

interface IWorld {
  readonly root: string;
  readonly statePath: string;
  readonly remote: FakeGitHubRemote;
  readonly createGitHubClient: ClientFactory;
}

function makeWorld(context: ContextMode = 'ok'): IWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'validate-')));
  const remote = FakeGitHubRemote.create(path.join(root, 'remote'));
  if (context !== 'ok') setAdapterConfig(remote.dir, { context });
  return { root, statePath: path.join(root, 'review.publication.json'), remote, createGitHubClient: createFakeClientFactory(remote.dir) };
}

/** The assessment input for a document: the publisher's input without a state path. */
function assessmentInput(sarif: Record<string, unknown>, options?: { readonly ignoreApprovalHold: boolean }): Record<string, unknown> {
  return {
    sarif: structuredClone(sarif),
    destination: { ...DESTINATION },
    reviewedCommit: HEAD,
    token: TOKEN,
    ...(options === undefined ? {} : { options: { ...options } }),
  };
}

/** Calls the public entry with the fake client through the private seam it honours at runtime. */
async function validate(world: IWorld, input: unknown): Promise<IAssessment> {
  const validateSarifReview: unknown = Reflect.get(library, 'validateSarifReview');
  assert.equal(typeof validateSarifReview, 'function', 'the package exports validateSarifReview');
  if (typeof validateSarifReview !== 'function') throw new TypeError('unreachable');
  const outcome: unknown = await Reflect.apply(validateSarifReview, undefined, [input, { createGitHubClient: world.createGitHubClient }]);
  return asAssessment(outcome);
}

/** Publishes the same document to `world` with a fresh state path. */
function publish(world: IWorld, sarif: Record<string, unknown>, options?: { readonly ignoreApprovalHold: boolean }): Promise<PublishSarifReviewOutcome> {
  const input: IPublishSarifReviewInput = {
    sarif: structuredClone(sarif),
    destination: { ...DESTINATION },
    reviewedCommit: HEAD,
    statePath: world.statePath,
    token: TOKEN,
    ...(options === undefined ? {} : { options: { ...options } }),
  };
  return library.publishSarifReview(
    input,
    // @ts-expect-error -- the private internals seam is deliberately absent from the public declaration; this suite injects the fake client through the seam the public entry honours at runtime
    { createGitHubClient: world.createGitHubClient },
  );
}

/** Every file below `dir`, relative, except the fake remote's own bookkeeping. */
function filesBelow(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => !name.startsWith('remote'))
    .sort();
}

/** Zero remote writes and zero durable publication state (contract: Guarantees). */
function assertNothingWritten(world: IWorld): void {
  assert.deepEqual(world.remote.writeCalls().map((c) => c.method), [], 'no remote write may occur');
  assert.equal(world.remote.calls('createReview').length, 0, 'no review is created');
  assert.deepEqual(world.remote.reviews(), [], 'the remote holds no review');
  assert.equal(fs.existsSync(world.statePath), false, 'no publication state exists at the state location');
  assert.deepEqual(filesBelow(world.root), [], 'no file of any kind is written');
}

/** The exact public field order per status (contract: Library). */
function assertShape(outcome: IAssessment, status: 'ready' | 'blocked' | 'incomplete', raw?: unknown): void {
  assert.equal(outcome.status, status, `expected ${status}, got ${outcome.status}:\n${outcome.markdown}`);
  // docs/diagnostics.md: `diagnostics` is appended after the 0.2.x fields.
  const keys = { ready: ['status', 'markdown', 'diagnostics'], blocked: ['status', 'problems', 'markdown', 'diagnostics'], incomplete: ['status', 'markdown', 'diagnostics'] }[status];
  if (raw !== undefined) assert.deepEqual(Object.keys(asRecord(raw, 'the outcome')), keys, 'outcome fields in documented order');
  assert.ok(outcome.markdown.length > 0);
  assert.equal(outcome.markdown.includes(TOKEN), false, 'the token never reaches the Markdown');
  // D45 supersedes D13: each problem is a version 1 problem, its diagnostic
  // fields appended after `message` and `pointer`.
  const rawProblems = raw === undefined ? [] : asArray(asRecord(raw, 'the outcome')['problems'] ?? [], 'problems');
  for (const problem of rawProblems) {
    assert.ok(isSchemaProblem(problem), `a version 1 problem: ${JSON.stringify(problem)}`);
    assert.deepEqual(Object.keys(asRecord(problem)).slice(0, 1), ['message']);
  }
}

/** The raw outcome (for exact key order), through the same seam. */
async function validateRaw(world: IWorld, input: unknown): Promise<unknown> {
  const validateSarifReview: unknown = Reflect.get(library, 'validateSarifReview');
  if (typeof validateSarifReview !== 'function') throw new assert.AssertionError({ message: 'the package exports validateSarifReview' });
  const outcome: unknown = await Reflect.apply(validateSarifReview, undefined, [input, { createGitHubClient: world.createGitHubClient }]);
  return outcome;
}

// ===========================================================================
// Tests
// ===========================================================================

describe('input is the publisher input without a state path, validated before any request', () => {
  const cases: readonly (readonly [string, (input: Record<string, unknown>) => void, RegExp])[] = [
    ['a state path (assessment reserves no publication identity)', (i) => { i['statePath'] = '/tmp/review.json'; }, /unknown field statePath/],
    ['an unknown field', (i) => { i['approval'] = true; }, /unknown field approval/],
    ['serialized SARIF text', (i) => { i['sarif'] = JSON.stringify(READY); }, /sarif must be a parsed SARIF object/],
    ['a short commit', (i) => { i['reviewedCommit'] = HEAD.slice(0, 7); }, /reviewedCommit/],
    ['an empty token', (i) => { i['token'] = ''; }, /token/],
    ['an unknown option', (i) => { i['options'] = { force: true }; }, /unknown option force/],
    ['a relative source root', (i) => { i['sourceRootUri'] = 'src/'; }, /sourceRootUri/],
    ['a destination with extra fields', (i) => { i['destination'] = { ...DESTINATION, branch: 'main' }; }, /destination/],
  ];
  for (const [label, change, message] of cases) {
    test(`refuses ${label} with a TypeError and no client`, async () => {
      const world = makeWorld();
      const input = assessmentInput(READY);
      change(input);
      await assert.rejects(validate(world, input), (err) => {
        assert.ok(err instanceof TypeError, String(err));
        assert.match(err.message, /^Invalid validateSarifReview input: /);
        assert.match(err.message, message);
        return true;
      });
      assert.deepEqual(world.remote.calls('adapter:create'), [], 'no client is created for invalid input');
      assertNothingWritten(world);
    });
  }

  test('the SARIF is captured when the call starts: later caller changes have no effect and getters never run', async () => {
    const world = makeWorld();
    const input = assessmentInput(HELD);
    const pending = validate(world, input);
    input['sarif'] = structuredClone(READY);
    assertShape(await pending, 'blocked');

    let ran = false;
    const withGetter = assessmentInput(READY);
    Object.defineProperty(asRecord(withGetter['sarif'], 'the input SARIF'), 'version', { enumerable: true, get: () => { ran = true; return '2.1.0'; } });
    await assert.rejects(validate(makeWorld(), withGetter), /accessor/);
    assert.equal(ran, false, 'a caller getter never runs');
  });
});

describe('ready: the complete artifact can be published, and nothing is written', () => {
  test('ready names what publication would create and that nothing was published or approved', async () => {
    const world = makeWorld();
    const raw = await validateRaw(world, assessmentInput(READY));
    const outcome = asAssessment(raw);
    assertShape(outcome, 'ready', raw);
    // The fixture: one general finding, one finding on line 4 (in the diff).
    assert.match(outcome.markdown, /1 inline comment/);
    assert.match(outcome.markdown, /1 general section/);
    assert.ok(outcome.markdown.includes(HEAD), 'the reviewed commit is named');
    assert.match(outcome.markdown, /nothing was published/i);
    assert.match(outcome.markdown, /no publication state/i);
    assert.match(outcome.markdown, /repeats every check/i, 'ready is not an approval');
    assert.match(outcome.markdown, /no pending review of this account/i, 'says the pending-review check found none');
    assert.match(outcome.markdown, /GitHub can still refuse the review/i, 'the pull request can change before publication');
    assertNothingWritten(world);
  });

  test('assessment reads the context once, the authenticated user and the review list, and reads back no review', async () => {
    const world = makeWorld();
    assertShape(await validate(world, assessmentInput(READY)), 'ready');
    assert.equal(world.remote.calls('adapter:fetchContext').length, 1);
    assert.equal(world.remote.calls('getAuthenticatedUser').length, 1, "the publisher's pre-send identity check runs");
    // Contract: "Pending review of this account". One page of the destination's reviews, for that check only.
    assert.deepEqual(world.remote.calls('listReviews').map((c) => c.args), [{ ...DESTINATION, cursor: null }]);
    assert.equal(world.remote.calls('listReviewComments').length, 0, 'no recovery lookup: assessment has no publication identity');
    assertNothingWritten(world);
  });
});

describe('blocked: every blocker, with reasons, and nothing written', () => {
  for (const c of DOCUMENT_CASES.filter((d) => d.expected === 'blocked')) {
    test(`${c.name} is blocked`, async () => {
      const world = makeWorld();
      const raw = await validateRaw(world, assessmentInput(c.sarif, c.options));
      const outcome = asAssessment(raw);
      assertShape(outcome, 'blocked', raw);
      const problems = outcome.problems ?? [];
      assert.ok(problems.length > 0, 'at least one reason');
      for (const problem of problems) {
        assert.ok(outcome.markdown.includes(problem.message), 'every problem appears in the Markdown');
      }
      if (c.pointer !== undefined) {
        const pointer = c.pointer;
        assert.ok(problems.some((p) => p.pointer?.startsWith(pointer)), `a problem points into ${pointer}: ${JSON.stringify(problems)}`);
      }
      if (c.mentions !== undefined) {
        const mentions = c.mentions;
        assert.ok(problems.some((p) => mentions.test(p.message)), `a problem mentions ${String(mentions)}`);
      }
      assert.match(outcome.markdown, /nothing was published/i);
      assertNothingWritten(world);
    });
  }
});

/** A remote condition under which the assessment cannot be completed. */
interface IIncompleteCase {
  readonly name: string;
  readonly arrange: (world: IWorld) => void;
  readonly mentions: RegExp;
}

const INCOMPLETE_CASES: readonly IIncompleteCase[] = [
  {
    name: 'an authentication failure (HTTP 401)',
    arrange: (w) => { setAdapterConfig(w.remote.dir, { context: 'unauthorized' }); },
    mentions: /401/,
  },
  {
    name: 'a source-read failure',
    arrange: (w) => { setAdapterConfig(w.remote.dir, { context: 'source-read-fails' }); },
    mentions: /502/,
  },
  { name: 'a network outage', arrange: (w) => { setAdapterConfig(w.remote.dir, { network: 'down' }); }, mentions: /ENOTFOUND/ },
  {
    name: 'a pull request that cannot be read',
    arrange: (w) => { setAdapterConfig(w.remote.dir, { context: 'throw' }); },
    mentions: /head branch no longer exists/,
  },
  {
    name: 'a context for another reviewed commit',
    arrange: (w) => { setAdapterConfig(w.remote.dir, { context: 'wrong-commit' }); },
    mentions: /reviewed commit/i,
  },
  {
    name: 'a context for another pull request',
    arrange: (w) => { setAdapterConfig(w.remote.dir, { context: 'wrong-pull' }); },
    mentions: /pull request/i,
  },
  {
    name: 'an account without a numeric user id (not user/PAT authentication)',
    arrange: (w) => { setAdapterConfig(w.remote.dir, { user: { id: 0, login: 'installation' } }); },
    mentions: /numeric authenticated user id/i,
  },
];

describe('incomplete: the assessment could not be completed, which is never ready', () => {
  for (const c of INCOMPLETE_CASES) {
    test(`${c.name} is incomplete, with the cause and no verdict`, async () => {
      const world = makeWorld();
      c.arrange(world);
      const raw = await validateRaw(world, assessmentInput(READY));
      const outcome = asAssessment(raw);
      assertShape(outcome, 'incomplete', raw);
      assert.match(outcome.markdown, c.mentions, 'the cause is named');
      assert.match(outcome.markdown, /not a verdict/i);
      assert.match(outcome.markdown, /nothing was published/i);
      assertNothingWritten(world);
    });
  }

  for (const mode of ['throw-with-token', 'throw-with-token-cause'] as const) {
    test(`an operational error carrying the token (${mode}) is incomplete and redacted`, async () => {
      const world = makeWorld(mode);
      const outcome = await validate(world, assessmentInput(READY));
      assertShape(outcome, 'incomplete');
      assert.match(outcome.markdown, /GET \/repos\/acme\/gizmos\/pulls\/7 failed/);
      assert.equal(util.inspect(outcome, { depth: null }).includes(TOKEN), false);
      assertNothingWritten(world);
    });
  }
});

describe('internal invariant failures are defects, not incomplete assessments', () => {
  /**
   * A world whose client answers for exactly the requested pull request and
   * commit, but without the diff the internal client contract always
   * carries: preparation refuses it as caller misuse (TypeError). That is a
   * defect in the package's own client boundary, not a transient condition,
   * so assessment must reject as publication does rather than advise a retry.
   */
  function contractBreakingWorld(): IWorld {
    const world = makeWorld();
    const context = Object.fromEntries(Object.entries(trustedContext()).filter(([key]) => key !== 'diff'));
    // eslint-disable-next-line @typescript-eslint/require-await -- fetchContext is async by contract
    const fetchContext = async (): Promise<{ context: unknown; readSource: typeof readSource }> => ({ context, readSource });
    const createGitHubClient: ClientFactory = (options) => ({ ...world.createGitHubClient(options), fetchContext });
    return { ...world, createGitHubClient };
  }

  test('a client answer that breaks the internal contract rejects, as publication does, instead of returning incomplete', async () => {
    const assessed = contractBreakingWorld();
    await assert.rejects(validate(assessed, assessmentInput(READY)), (err) => {
      assert.ok(err instanceof TypeError, String(err));
      assert.match(err.message, /context\.diff/);
      return true;
    });
    assertNothingWritten(assessed);

    const published = contractBreakingWorld();
    await assert.rejects(publish(published, READY), /context\.diff/);
    assert.deepEqual(published.remote.writeCalls(), []);
  });
});

describe('parity with the publisher on the same input and remote', () => {
  for (const c of DOCUMENT_CASES) {
    test(`${c.name}: assessment says ${c.expected}, and publication agrees`, async () => {
      const assessed = makeWorld();
      const outcome = await validate(assessed, assessmentInput(c.sarif, c.options));
      assert.equal(outcome.status, c.expected, outcome.markdown);
      assertNothingWritten(assessed);

      const published = makeWorld();
      const publication = await publish(published, c.sarif, c.options);
      if (c.expected === 'ready') {
        assert.equal(publication.status, 'published', publication.markdown);
        assert.equal(published.remote.calls('createReview').length, 1, 'publication proceeds to its single create');
      } else {
        assert.equal(publication.status, 'blocked', publication.markdown);
        assert.equal(outcome.markdown, publication.markdown, 'the blocked explanation is the publisher’s own');
        assert.deepEqual(published.remote.writeCalls(), []);
        assert.equal(fs.existsSync(published.statePath), false);
      }
    });
  }

  for (const c of INCOMPLETE_CASES) {
    test(`${c.name}: assessment is incomplete, and publication refuses before any write`, async () => {
      const assessed = makeWorld();
      c.arrange(assessed);
      assert.equal((await validate(assessed, assessmentInput(READY))).status, 'incomplete');

      const published = makeWorld();
      c.arrange(published);
      await assert.rejects(publish(published, READY), c.mentions);
      assert.deepEqual(published.remote.writeCalls(), [], 'publication wrote nothing remotely');
      assert.equal(fs.existsSync(published.statePath), false, 'publication created no state');
    });
  }
});

describe('no approval stamp: publication checks everything again', () => {
  test('a ready outcome carries nothing publication accepts', async () => {
    const world = makeWorld();
    const raw = await validateRaw(world, assessmentInput(READY));
    assert.deepEqual(Object.keys(asRecord(raw, 'the ready outcome')), ['status', 'markdown', 'diagnostics'], 'no stamp, fingerprint or identifier');
    const input = { ...assessmentInput(READY), statePath: world.statePath, readiness: raw };
    await assert.rejects(
      library.publishSarifReview(
        // @ts-expect-error -- deliberately passes the ready outcome as an extra field, which the publisher must refuse
        input,
      ),
      /unknown field readiness/,
    );
  });

  test('the pull request advancing after a ready assessment is caught by publication itself', async () => {
    // Worked example 6: the same remote, first as assessed, then after the author pushed.
    const world = makeWorld();
    assert.equal((await validate(world, assessmentInput(FIXED))).status, 'ready');
    setAdapterConfig(world.remote.dir, { context: 'historical' });
    const publication = await publish(world, FIXED);
    assert.equal(publication.status, 'blocked', publication.markdown);
    assert.equal(world.remote.calls('adapter:fetchContext').length, 2, 'publication fetched the context again');
    assert.deepEqual(world.remote.writeCalls(), [], 'nothing was written');
    assert.equal(fs.existsSync(world.statePath), false);
  });

  test('a network outage after a ready assessment makes publication refuse, not proceed', async () => {
    const world = makeWorld();
    assert.equal((await validate(world, assessmentInput(READY))).status, 'ready');
    setAdapterConfig(world.remote.dir, { network: 'down' });
    await assert.rejects(publish(world, READY), /ENOTFOUND/);
    assert.deepEqual(world.remote.writeCalls(), []);
    assert.equal(fs.existsSync(world.statePath), false);
  });

  test('publication after a ready assessment still fetches, prepares and creates on its own', async () => {
    const world = makeWorld();
    assert.equal((await validate(world, assessmentInput(READY))).status, 'ready');
    const publication = await publish(world, READY);
    assert.equal(publication.status, 'published', publication.markdown);
    assert.equal(world.remote.calls('adapter:fetchContext').length, 2);
    assert.equal(world.remote.calls('createReview').length, 1);
  });

  test('the same remote can be assessed again after the pull request advanced, with the new verdict', async () => {
    const world = makeWorld();
    assert.equal((await validate(world, assessmentInput(FIXED))).status, 'ready');
    setAdapterConfig(world.remote.dir, { context: 'historical' });
    assert.equal((await validate(world, assessmentInput(FIXED))).status, 'blocked', 'no cached verdict');
    assertNothingWritten(world);
  });
});

describe('submitted mode: the same checks, reported for that mode (docs/submitted-review-contract.md §2.6)', () => {
  /** The assessment input for a document with `submit` added to its options. */
  function submittedInput(c: IDocumentCase): Record<string, unknown> {
    return { ...assessmentInput(c.sarif), options: { ...c.options, submit: true } };
  }

  for (const c of DOCUMENT_CASES) {
    test(`${c.name}: submitted assessment says ${c.expected}, and a submitted publication agrees`, async () => {
      const assessed = makeWorld();
      const outcome = await validate(assessed, submittedInput(c));
      assert.equal(outcome.status, c.expected, outcome.markdown);
      assert.equal(outcome.status, (await validate(makeWorld(), assessmentInput(c.sarif, c.options))).status, 'the mode changes no verdict');
      assertNothingWritten(assessed);

      const published = makeWorld();
      const input: IPublishSarifReviewInput = {
        sarif: structuredClone(c.sarif),
        destination: { ...DESTINATION },
        reviewedCommit: HEAD,
        statePath: published.statePath,
        token: TOKEN,
        options: { ...c.options, submit: true },
      };
      const publication = await library.publishSarifReview(
        input,
        // @ts-expect-error -- the private internals seam is deliberately absent from the public declaration; this suite injects the fake client through the seam the public entry honours at runtime
        { createGitHubClient: published.createGitHubClient },
      );
      if (c.expected === 'ready') {
        assert.equal(publication.status, 'published', publication.markdown);
        assert.deepEqual(published.remote.reviews().map((r) => r.state), ['COMMENTED']);
      } else {
        assert.equal(publication.status, 'blocked', publication.markdown);
        assert.equal(outcome.markdown, publication.markdown, 'the blocked explanation is the publisher’s own');
        assert.deepEqual(published.remote.writeCalls(), []);
      }
    });
  }

  test('a ready submitted assessment says a submitted comment review would be created; the draft wording is unchanged', async () => {
    const submitted = await validate(makeWorld(), { ...assessmentInput(READY), options: { submit: true } });
    assertShape(submitted, 'ready');
    const where = `${DESTINATION.owner}/${DESTINATION.repo}#${String(DESTINATION.pullNumber)} at commit \`${HEAD}\``;
    assert.ok(
      submitted.markdown.includes(`The complete document can be published faithfully to ${where} as a submitted comment review.`),
      submitted.markdown,
    );
    const draft = await validate(makeWorld(), assessmentInput(READY));
    assert.ok(draft.markdown.includes(`The complete document can be published faithfully to ${where}.`), draft.markdown);
    assert.equal(draft.markdown.includes('submitted comment review'), false);
    const explicitDraft = await validate(makeWorld(), { ...assessmentInput(READY), options: { submit: false } });
    assert.equal(explicitDraft.markdown, draft.markdown);
  });

  test('a non-boolean submit option is refused with a TypeError and no client', async () => {
    const world = makeWorld();
    await assert.rejects(validate(world, { ...assessmentInput(READY), options: { submit: 'COMMENT' } }), (err) => {
      assert.ok(err instanceof TypeError);
      assert.match(err.message, /^Invalid validateSarifReview input: options\.submit must be a boolean/);
      return true;
    });
    assert.deepEqual(world.remote.calls('adapter:create'), []);
    assertNothingWritten(world);
  });
});
