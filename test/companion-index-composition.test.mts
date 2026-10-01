/**
 * The review's companion index and existing companions (D56) through the
 * production composition: the real public library and CLI with the real
 * GitHub client (src/github.cts), talking HTTP to the fake GitHub host
 * (test/fixtures/composition). Only `fetch` is replaced.
 *
 * Every expected value is written by hand from
 * docs/companion-suggestion-pr-contract.md §2.13 (the option, which pull
 * requests can be listed, the index, identity and recovery), §2.11 (the
 * sections the index precedes) and docs/diagnostics.md (the
 * `companion-not-reusable` and `companion-reused` codes). Only the host's
 * number for a created suggestion pull request is read back.
 *
 * The host models documented GitHub behavior; it is not evidence of live
 * GitHub behavior (see docs/evidence/companion-index/).
 *
 * @see ../docs/companion-suggestion-pr-contract.md
 * @see ../docs/suggestion-pr-convention.md
 * @see ../docs/diagnostics.md
 * @see https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createGitHubClient } from '../dist/github.cjs';
import type { ICreateGitHubClientOptions, IGitHubClient } from '../dist/github.cjs';
import library from '../dist/index.cjs';
import type { IStoredPull } from './fixtures/composition/fake-http-companion.mts';
import {
  ATTRIBUTION, BASE, GUIDE, HEAD, HEAD_REF, OWNER, PULL, REPO, TYPO,
  blockedMarkdown, cli, coded, create, created, diagnostics, document, input, makeWorld, markdown, onlyReview, publish, pullUrl, result,
  stateRecord, status, target, validate, writes,
} from './support/delivery-world.mts';
import type { IWorld, Json } from './support/delivery-world.mts';
import { asArray, asRecord, asString, parseJson } from './support/runtime-types.mts';

// ---------------------------------------------------------------------------
// Documents and existing companions

/** A finding with no location, published as a body section. */
const NOTE_TEXT = 'Consider a changelog entry.';
const note = (): Json => result({ text: NOTE_TEXT });
const NOTE_SECTION = `${NOTE_TEXT}\n\n${ATTRIBUTION}`;

/** A finding proposing docs/guide.md, delivered by a companion under `fileOperations: [companion]`. */
const guide = (): Json => result({ text: 'Add a guide.', operation: create(0) });
const GUIDE_ARTIFACT = created('docs/guide.md', GUIDE);
const PAGE = '# Page\n';
const page = (): Json => result({ text: 'Add a page.', operation: create(1) });
const PAGE_ARTIFACT = created('docs/page.md', PAGE);
const COMPANIONS: Json = { delivery: { fileOperations: ['companion'] } };

/** Contract §2.11: the section of a created suggestion pull request for the guide. */
const guideSection = (n: number): string => [
  `**Suggestion pull request:** [#${String(n)}](${pullUrl(n)})`,
  '',
  'Merging it into `feature/retry` applies this change:',
  '',
  '- New file `docs/guide.md`: 25 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
  '',
  'Add a guide.',
  '',
  ATTRIBUTION,
].join('\n');

const HEADING = '**Companion pull requests of this review:**';
const createdEntry = (n: number, title: string): string => `- [#${String(n)}](${pullUrl(n)}): ${title} — created with this review`;
const existingEntry = (n: number, title: string, state: string): string =>
  `- [#${String(n)}](${pullUrl(n)}): ${title} — reused; it was ${state} when this review was prepared`;
const index = (...entries: string[]): string => [HEADING, '', ...entries].join('\n');
const SEPARATOR = '\n\n---\n\n';

/** A canonical version-1 suggestion marker (convention §7). */
function marker(id: string, original: { readonly owner?: string; readonly repo?: string; readonly pullNumber?: number } = {}): string {
  const json = JSON.stringify({
    version: 1,
    original: { owner: original.owner ?? OWNER, repo: original.repo ?? REPO, pullNumber: original.pullNumber ?? PULL },
    reviewedCommit: BASE,
    id,
    batch: 'an-earlier-review',
  });
  return `<!-- suggestion-pr ${json} -->`;
}

const EXISTING_TITLE = 'Suggestion for #7: edit notes.txt';
/** The title as the index renders it: plain text, `#` escaped (contract §2.13.3). */
const EXISTING_INDEXED = 'Suggestion for \\#7: edit notes.txt';

/**
 * A suggestion pull request of #7 that an earlier review created, conforming
 * to the convention, opened by another account (authorship is not checked).
 */
function existing(number: number, change: Partial<IStoredPull> = {}): IStoredPull {
  const id = `earlier-${String(number)}`;
  return {
    number,
    title: EXISTING_TITLE,
    body: `Suggested in a review of #7 at commit ${BASE}.\n\nMerging this pull request into \`feature/retry\` applies this change.\n\n${marker(id)}`,
    head: `suggestion-pr/7/${id}`,
    base: HEAD_REF,
    draft: true,
    state: 'open',
    merged: false,
    labels: ['suggestion-pr'],
    authorId: 9001,
    ...change,
  };
}

const reusedNote = (n: number, state: string): string => `#${String(n)} is listed in the review's companion index as an existing companion; it was ${state} when the review was prepared.`;
const notReusable = (n: number, reason: string): string => `#${String(n)} cannot be listed as an existing companion of #7: ${reason}.`;
const blockedLine = (message: string): string => `- \`companion-not-reusable\`: ${message}`;

const withExisting = (numbers: readonly number[], options: Json = {}): Json => ({ ...options, existingCompanions: numbers });

/** How often the host was asked for pull request `n`. */
const readsOf = (world: IWorld, n: number): number =>
  world.host.log().filter((r) => r.method === 'GET' && r.path === `/repos/${OWNER}/${REPO}/pulls/${String(n)}`).length;

/**
 * Publishes through the real client over the host, except that every read of
 * the review list fails as a dropped connection: a review whose create
 * response was lost cannot be confirmed, so the call is uncertain.
 */
async function publishBlind(world: IWorld, sarif: Json, options: Json): Promise<Json> {
  const blind: typeof world.host.fetch = async (url, init) => {
    const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
    if ((init?.method ?? 'GET') === 'GET' && target.pathname.endsWith(`/pulls/${String(PULL)}/reviews`)) throw new TypeError('fetch failed: socket hang up');
    return world.host.fetch(url, init);
  };
  // The private second argument is the package's test seam (src/publish-sarif-review.cts), as delivery-world.mts uses it.
  const internals = { createGitHubClient: (options: ICreateGitHubClientOptions): IGitHubClient => createGitHubClient({ ...options, fetch: blind }) };
  const outcome: unknown = await Reflect.apply(library.publishSarifReview, undefined, [{ ...input(sarif, options), statePath: world.statePath }, internals]);
  return asRecord(outcome, 'the publishSarifReview outcome');
}

/** The suggestion pull requests this publication created (not seeded). */
function createdPulls(world: IWorld, seeded: readonly number[]): IStoredPull[] {
  return world.host.pulls().filter((pr) => !seeded.includes(pr.number));
}

// ---------------------------------------------------------------------------

describe('the option is validated before anything is read (§2.13.1)', () => {
  const invalid: readonly (readonly [string, unknown, RegExp])[] = [
    ['not an array', 97, /options\.existingCompanions must be an array of pull request numbers/],
    ['zero', [0], /options\.existingCompanions\[0\] must be a positive pull request number/],
    ['a negative number', [-3], /options\.existingCompanions\[0\] must be a positive pull request number/],
    ['a fraction', [97.5], /options\.existingCompanions\[0\] must be a positive pull request number/],
    ['a string', ['97'], /options\.existingCompanions\[0\] must be a positive pull request number/],
    ['an unsafe integer', [2 ** 53], /options\.existingCompanions\[0\] must be a positive pull request number/],
    ['a repeat', [97, 98, 97], /options\.existingCompanions\[2\] repeats #97/],
  ];
  for (const [what, value, message] of invalid) {
    test(`${what} is a TypeError, and nothing is requested`, async () => {
      const world = makeWorld();
      await assert.rejects(validate(world, document([note()]), { existingCompanions: value }), (err: unknown) => err instanceof TypeError && message.test(err.message));
      await assert.rejects(publish(world, document([note()]), { existingCompanions: value }), (err: unknown) => err instanceof TypeError && message.test(err.message));
      assert.deepEqual(world.host.log(), []);
    });
  }

  test('an empty list is the same as omitting it: no index, no note, the same publication identity', async () => {
    const world = makeWorld();
    const first = await publish(world, document([note()]));
    assert.equal(status(first), 'published', markdown(first));
    assert.equal(onlyReview(world).body, NOTE_SECTION);
    const again = await publish(world, document([note()]), { existingCompanions: [] });
    assert.equal(status(again), 'published', markdown(again));
    assert.match(markdown(again), /was already published/);
    assert.equal(world.host.reviews().length, 1);
  });
});

describe('a review that creates companions indexes them (§2.13.3)', () => {
  test('created only: the index comes first, then each section as before', async () => {
    const world = makeWorld();
    const sarif = document([note(), guide()], [GUIDE_ARTIFACT]);
    const outcome = await publish(world, sarif, COMPANIONS);
    assert.equal(status(outcome), 'published', markdown(outcome));
    const [pull] = createdPulls(world, []);
    assert.ok(pull);
    assert.equal(pull.title, 'Suggestion for #7: create docs/guide.md');
    assert.equal(onlyReview(world).body, [
      index(createdEntry(pull.number, 'Suggestion for \\#7: create docs/guide.md')),
      NOTE_SECTION,
      guideSection(pull.number),
    ].join(SEPARATOR));
    assert.deepEqual(coded(outcome), [], 'no note: nothing was reused');
  });

  test('a `single` bundle of two proposals is one companion, listed once', async () => {
    const world = makeWorld();
    const sarif = document([guide(), page()], [GUIDE_ARTIFACT, PAGE_ARTIFACT]);
    const outcome = await publish(world, sarif, { delivery: { fileOperations: ['companion'], companionBundle: 'single' } });
    assert.equal(status(outcome), 'published', markdown(outcome));
    const pulls = createdPulls(world, []);
    assert.equal(pulls.length, 1);
    const [pull] = pulls;
    assert.ok(pull);
    assert.equal(pull.title, 'Suggestion for #7: 2 proposals (2 changes)');
    const body = onlyReview(world).body;
    assert.ok(body.startsWith(`${index(createdEntry(pull.number, 'Suggestion for \\#7: 2 proposals (2 changes)'))}${SEPARATOR}`), body);
    assert.equal(body.split(`](${pullUrl(pull.number)})`).length - 1, 3, 'linked by the index and by each proposal\'s section');
    assert.ok(body.includes(`**Suggestion pull request:** [#${String(pull.number)}](${pullUrl(pull.number)}), proposal 1 of 2`), body);
    assert.ok(body.includes(`**Suggestion pull request:** [#${String(pull.number)}](${pullUrl(pull.number)}), proposal 2 of 2`), body);
  });

  test('the plan records the index as the review\'s first section, with the existing companions as read (§2.9, §2.13.4)', async () => {
    const world = makeWorld();
    world.host.seedPulls([existing(97)]);
    const outcome = await publish(world, document([guide()], [GUIDE_ARTIFACT]), withExisting([97], COMPANIONS));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const review = asRecord(stateRecord(world)['review']);
    const [first] = asArray(review['sections']);
    assert.deepEqual(first, { companionIndex: { existing: [{ number: 97, title: EXISTING_TITLE, state: 'draft' }] } });
  });
});

describe('existing companions (§2.13.2, §2.13.3)', () => {
  test('existing only: no companion is created, the index lists it, and its state is a note', async () => {
    const world = makeWorld();
    world.host.seedPulls([existing(97)]);
    const sarif = document([note()]);
    const assessed = await validate(world, sarif, withExisting([97]));
    assert.equal(status(assessed), 'ready', markdown(assessed));
    assert.deepEqual(coded(assessed), [['companion-reused', reusedNote(97, 'a draft')]]);
    const outcome = await publish(world, sarif, withExisting([97]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.equal(onlyReview(world).body, [index(existingEntry(97, EXISTING_INDEXED, 'a draft')), NOTE_SECTION].join(SEPARATOR));
    const [reused] = diagnostics(outcome);
    assert.deepEqual(reused, {
      code: 'companion-reused',
      severity: 'note',
      title: 'An existing companion pull request is listed in the review',
      message: reusedNote(97, 'a draft'),
      subject: `${OWNER}/${REPO}#97`,
    });
    assert.deepEqual(writes(world), [`POST /repos/${OWNER}/${REPO}/pulls/${String(PULL)}/reviews`], 'only the review is written');
    assert.equal(world.host.pulls().length, 1, 'no suggestion pull request is created');
    assert.equal(world.host.pulls()[0]?.state, 'open', 'the existing one is not changed');
  });

  test('a review whose only content is inline still carries the index as its body', async () => {
    const world = makeWorld();
    world.host.seedPulls([existing(97)]);
    const outcome = await publish(world, document([TYPO()]), withExisting([97]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const review = onlyReview(world);
    assert.equal(review.body, index(existingEntry(97, EXISTING_INDEXED, 'a draft')));
    assert.equal(review.comments.length, 1, 'the native suggestion stays inline');
  });

  test('state is reported, not enforced: open, closed and merged are listed in the order given', async () => {
    const world = makeWorld();
    world.host.seedPulls([
      existing(98, { draft: false }),
      existing(99, { state: 'closed', draft: false }),
      existing(100, { state: 'closed', merged: true, draft: false }),
    ]);
    const outcome = await publish(world, document([note()]), withExisting([100, 98, 99]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.equal(onlyReview(world).body, [index(
      existingEntry(100, EXISTING_INDEXED, 'merged'),
      existingEntry(98, EXISTING_INDEXED, 'open'),
      existingEntry(99, EXISTING_INDEXED, 'closed'),
    ), NOTE_SECTION].join(SEPARATOR));
    assert.deepEqual(coded(outcome), [
      ['companion-reused', reusedNote(100, 'merged')],
      ['companion-reused', reusedNote(98, 'open')],
      ['companion-reused', reusedNote(99, 'closed')],
    ]);
  });

  test('created and existing together: created first, then existing, each once', async () => {
    const world = makeWorld();
    world.host.seedPulls([existing(97)]);
    const sarif = document([note(), guide()], [GUIDE_ARTIFACT]);
    const outcome = await publish(world, sarif, withExisting([97], COMPANIONS));
    assert.equal(status(outcome), 'published', markdown(outcome));
    const [pull] = createdPulls(world, [97]);
    assert.ok(pull);
    assert.equal(onlyReview(world).body, [
      index(createdEntry(pull.number, 'Suggestion for \\#7: create docs/guide.md'), existingEntry(97, EXISTING_INDEXED, 'a draft')),
      NOTE_SECTION,
      guideSection(pull.number),
    ].join(SEPARATOR));
    assert.deepEqual(coded(outcome), [['companion-reused', reusedNote(97, 'a draft')]]);
    assert.deepEqual(asArray(outcome['suggestions']).map((s) => asRecord(s)['number']), [pull.number], 'only the created one is a created suggestion');
  });

  test('a version-2 marker conforms too (convention §7)', async () => {
    const world = makeWorld();
    const id = 'reapplied-97';
    const v2 = `<!-- suggestion-pr {"version":2,"original":{"owner":"${OWNER}","repo":"${REPO}","pullNumber":7},"reviewedCommit":"${BASE}","reappliedOnto":"${HEAD}","id":"${id}","batch":"b"} -->`;
    world.host.seedPulls([existing(97, { body: v2, head: `suggestion-pr/7/${id}` })]);
    const outcome = await publish(world, document([note()]), withExisting([97]));
    assert.equal(status(outcome), 'published', markdown(outcome));
  });

  test('a title is shown literally, so it can neither open HTML nor hide the links (composed-text checkpoint)', async () => {
    const world = makeWorld();
    world.host.seedPulls([existing(97, { title: '<details> `x` $\\phantom{y}$ [link](https://example.com)' })]);
    const outcome = await publish(world, document([note()]), withExisting([97]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.ok(onlyReview(world).body.startsWith(`${HEADING}\n\n- [#97](${pullUrl(97)}): \\<details\\> \\\`x\\\` \\$\\\\phantom\\{y\\}\\$ \\[link\\](https://example.com) — reused;`), onlyReview(world).body);
  });

  test('presentation callbacks still apply around the index, which stays built in', async () => {
    const world = makeWorld();
    world.host.seedPulls([existing(97)]);
    const presentation = { finding: (context: { readonly markdown: string }): string => `**Finding.** ${context.markdown}` };
    const outcome = await publish(world, document([note()]), withExisting([97], { presentation }));
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.equal(onlyReview(world).body, [index(existingEntry(97, EXISTING_INDEXED, 'a draft')), `**Finding.** ${NOTE_SECTION}`].join(SEPARATOR));
  });
});

describe('a named pull request that cannot be listed blocks before any write (§2.13.2)', () => {
  const cases: readonly (readonly [string, IStoredPull | null, string])[] = [
    ['a number with no pull request (404)', null, 'it is not a pull request in octo/widgets'],
    ['a pull request of another repository', existing(97, { repository: 'other/widgets' }), 'it is not a pull request in octo/widgets'],
    ['an issue', existing(97, { isIssue: true }), 'it is not a pull request in octo/widgets'],
    ['a fork', existing(97, { headRepo: 'someone/widgets' }), 'its head branch `suggestion-pr/7/earlier-97` is in another repository (someone/widgets)'],
    ['a deleted head repository', existing(97, { headRepo: null }), 'its head repository was deleted'],
    ['no marker', existing(97, { body: 'An ordinary pull request.' }), 'it has no suggestion marker'],
    ['a second marker line', existing(97, { body: `${marker('earlier-97')}\n\n${marker('earlier-97')}` }), 'its body has more than one suggestion marker'],
    ['a marker not in the canonical form', existing(97, { body: marker('earlier-97').replace('"version":1,', '"version": 1,') }), 'its suggestion marker is not in the canonical form'],
    ['an unknown marker version', existing(97, { body: marker('earlier-97').replace('"version":1', '"version":3') }), 'its suggestion marker is not in the canonical form'],
    ['a marker naming another repository', existing(97, { body: marker('earlier-97', { owner: 'other' }) }), 'its suggestion marker names another repository (other/widgets)'],
    ['a marker naming another original', existing(97, { body: marker('earlier-97', { pullNumber: 8 }) }), 'its suggestion marker names #8, not #7'],
    ['another head branch', existing(97, { head: 'feature/other' }), 'its head branch `feature/other` is not the suggestion branch `suggestion-pr/7/earlier-97` its marker names'],
  ];
  for (const [what, seeded, reason] of cases) {
    test(`${what}: publish and validate block alike, naming it`, async () => {
      const world = makeWorld();
      if (seeded !== null) world.host.seedPulls([seeded]);
      const sarif = document([note()]);
      const assessed = await validate(world, sarif, withExisting([97]));
      const published = await publish(world, sarif, withExisting([97]));
      for (const outcome of [assessed, published]) {
        assert.equal(status(outcome), 'blocked', markdown(outcome));
        assert.equal(markdown(outcome), blockedMarkdown([blockedLine(notReusable(97, reason))]));
        assert.deepEqual(diagnostics(outcome), [{
          code: 'companion-not-reusable',
          severity: 'error',
          title: 'An existing companion pull request cannot be listed in the review',
          message: notReusable(97, reason),
          remedies: ['Name a suggestion pull request whose marker names this pull request, or leave this one out (`--existing-companion`, `existingCompanions`).'],
          subject: `${OWNER}/${REPO}#97`,
        }]);
      }
      assert.deepEqual(writes(world), [], 'nothing is written');
    });
  }

  test('naming the reviewed pull request itself is refused: it has no marker', async () => {
    const world = makeWorld();
    const outcome = await validate(world, document([note()]), withExisting([PULL]));
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    assert.deepEqual(coded(outcome), [['companion-not-reusable', notReusable(PULL, 'it has no suggestion marker')]]);
  });

  test('every unusable one is named, in the order given, after preparation\'s own problems, and without delivery notes', async () => {
    const world = makeWorld();
    world.host.seedPulls([existing(97), existing(98, { body: 'none' })]);
    const broken = document([result({ text: 'Bad.', location: at404() })]);
    const outcome = await publish(world, broken, withExisting([404, 97, 98], { pullRequestLabels: ['team-a'] }));
    assert.equal(status(outcome), 'blocked', markdown(outcome));
    const codes = diagnostics(outcome).map((d) => d['code']);
    assert.notEqual(codes[0], 'companion-not-reusable', 'preparation\'s problem comes first');
    assert.deepEqual(coded(outcome).slice(-2), [
      ['companion-not-reusable', notReusable(404, 'it is not a pull request in octo/widgets')],
      ['companion-not-reusable', notReusable(98, 'it has no suggestion marker')],
    ]);
    assert.equal(codes.includes('companion-reused'), false, 'a blocked review states no reuse');
    assert.equal(codes.includes('companion-options-unused'), false, 'nor a delivery note');
    assert.deepEqual(writes(world), []);
  });

  test('a read that fails otherwise is operational: publish rejects, validate is incomplete, nothing is written', async () => {
    for (const failure of ['server-error', 'forbidden', 'malformed'] as const) {
      const world = makeWorld(undefined, { companion: { pullReads: { '97': failure } } });
      world.host.seedPulls([existing(97)]);
      const assessed = await validate(world, document([note()]), withExisting([97]));
      assert.equal(status(assessed), 'incomplete', `${failure}: ${markdown(assessed)}`);
      assert.deepEqual(diagnostics(assessed).map((d) => d['code']), ['assessment-incomplete']);
      await assert.rejects(publish(world, document([note()]), withExisting([97])), failure);
      assert.deepEqual(writes(world), [], failure);
    }
  });
});

/** A location in a file the reviewed commit does not have, which preparation refuses. */
function at404(): Json {
  return { artifactLocation: { uri: 'missing/file.ts' }, region: { startLine: 1 } };
}

describe('identity and recovery (§2.13.1, §2.13.4)', () => {
  test('the selection is part of the identity: another selection on the same state path is refused before any request', async () => {
    const world = makeWorld();
    world.host.seedPulls([existing(97), existing(98)]);
    const first = await publish(world, document([note()]), withExisting([97]));
    assert.equal(status(first), 'published', markdown(first));
    const before = world.host.log().length;
    for (const selection of [[98], [97, 98], [], null]) {
      await assert.rejects(publish(world, document([note()]), selection === null ? undefined : withExisting(selection)), /state-mismatch|different original input/);
    }
    assert.equal(world.host.log().length, before, 'refused locally');
  });

  test('a lost review response is recovered in the same call: one review, with the index', async () => {
    const world = makeWorld(undefined, { create: 'lose-response' });
    world.host.seedPulls([existing(97)]);
    const outcome = await publish(world, document([note()]), withExisting([97]));
    assert.equal(status(outcome), 'published', markdown(outcome));
    assert.match(markdown(outcome), /was confirmed on GitHub for this publication; nothing was resent/);
    assert.equal(onlyReview(world).body, [index(existingEntry(97, EXISTING_INDEXED, 'a draft')), NOTE_SECTION].join(SEPARATOR));
  });

  test('a review that could not be confirmed is recovered by a retry with the identical body, and nothing is read or decided again', async () => {
    const world = makeWorld(undefined, { create: 'lose-response' });
    world.host.seedPulls([existing(97)]);
    const sarif = document([note()]);
    const first = await publishBlind(world, sarif, withExisting([97]));
    assert.equal(status(first), 'uncertain', markdown(first));
    assert.deepEqual(coded(first).map(([c]) => c), ['delivery-unconfirmed', 'companion-reused']);
    const sent = onlyReview(world).body;
    // A person closes it and removes its marker; the retry does not look.
    world.host.editPull(97, { state: 'closed', body: 'Closed.' });
    const reads = readsOf(world, 97);
    const retry = await publish(world, sarif, withExisting([97]));
    assert.equal(status(retry), 'published', markdown(retry));
    assert.match(markdown(retry), /was confirmed on GitHub for this publication; nothing was resent/);
    assert.equal(readsOf(world, 97), reads, 'not read again');
    assert.equal(world.host.reviews().length, 1, 'never sent again');
    assert.equal(onlyReview(world).body, sent);
    assert.equal(sent, [index(existingEntry(97, EXISTING_INDEXED, 'a draft')), NOTE_SECTION].join(SEPARATOR));
    assert.deepEqual(coded(retry), [['companion-reused', reusedNote(97, 'a draft')]], 'the note recorded with the publication');
  });

  test('with created companions: a review that could not be confirmed after they exist is recovered with the identical body', async () => {
    const world = makeWorld(undefined, { create: 'lose-response' });
    world.host.seedPulls([existing(97)]);
    const sarif = document([note(), guide()], [GUIDE_ARTIFACT]);
    const first = await publishBlind(world, sarif, withExisting([97], COMPANIONS));
    assert.equal(status(first), 'uncertain', markdown(first));
    const [pull] = createdPulls(world, [97]);
    assert.ok(pull, 'the suggestion pull request exists, but the publication is not complete without its review');
    assert.ok(markdown(first).includes(`[pull request #${String(pull.number)}]`), markdown(first));
    const sent = onlyReview(world).body;
    world.host.editPull(97, { state: 'closed', merged: true });
    const reads = readsOf(world, 97);
    const retry = await publish(world, sarif, withExisting([97], COMPANIONS));
    assert.equal(status(retry), 'published', markdown(retry));
    assert.equal(readsOf(world, 97), reads, 'not read again');
    assert.equal(world.host.reviews().length, 1, 'never sent again');
    assert.equal(createdPulls(world, [97]).length, 1, 'no second suggestion pull request');
    assert.equal(onlyReview(world).body, sent);
    assert.equal(sent, [
      index(createdEntry(pull.number, 'Suggestion for \\#7: create docs/guide.md'), existingEntry(97, EXISTING_INDEXED, 'a draft')),
      NOTE_SECTION,
      guideSection(pull.number),
    ].join(SEPARATOR));
  });

  test('a refused companion step leaves the publication incomplete: no review, so no index, is published', async () => {
    const world = makeWorld(undefined, { companion: { refuse: { pull: 422 } } });
    world.host.seedPulls([existing(97)]);
    const outcome = await publish(world, document([guide()], [GUIDE_ARTIFACT]), withExisting([97], COMPANIONS));
    assert.equal(status(outcome), 'rejected', markdown(outcome));
    assert.equal(world.host.reviews().length, 0);
  });
});

// ---------------------------------------------------------------------------
// The command line

describe('the command line: --existing-companion N (§2.13.1)', () => {
  const json = (stdout: string): Json => asRecord(parseJson(stdout), 'the JSON document');

  test('publish and validate document the flag', () => {
    const world = makeWorld();
    for (const topic of [['publish'], ['validate'], []]) {
      const help = cli(world, [...topic, '--help']);
      assert.equal(help.status, 0, help.stderr);
      assert.ok(help.stdout.includes('--existing-companion N'), `${topic.join(' ') || 'top-level'} help names --existing-companion N`);
    }
  });

  test('repeated flags select existing companions in order; validate is ready and publish lists them', () => {
    const world = makeWorld();
    world.host.seedPulls([existing(97), existing(98, { draft: false })]);
    const args = [...target(world, document([note()])), '--existing-companion', '98', '--existing-companion', '97'];
    const checked = cli(world, ['validate', ...args, '--format', 'json']);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.deepEqual(asArray(json(checked.stdout)['diagnostics']).map((d) => asRecord(d)['message']), [reusedNote(98, 'open'), reusedNote(97, 'a draft')]);
    const published = cli(world, ['publish', ...args, '--state', world.statePath]);
    assert.equal(published.status, 0, published.stdout + published.stderr);
    assert.ok(published.stderr.includes(reusedNote(98, 'open')), published.stderr);
    assert.equal(onlyReview(world).body, [index(existingEntry(98, EXISTING_INDEXED, 'open'), existingEntry(97, EXISTING_INDEXED, 'a draft')), NOTE_SECTION].join(SEPARATOR));
  });

  test('one that cannot be listed blocks: exit 2, the diagnostic named, nothing written', () => {
    const world = makeWorld();
    const args = [...target(world, document([note()])), '--existing-companion', '404'];
    for (const command of [['validate'], ['publish', '--state', world.statePath]]) {
      const run = cli(world, [...command, ...args, '--format', 'json']);
      assert.equal(run.status, 2, run.stdout + run.stderr);
      const doc = json(run.stdout);
      assert.equal(doc['status'], 'blocked');
      assert.deepEqual(asArray(doc['diagnostics']).map((d) => [asRecord(d)['code'], asRecord(d)['message']]),
        [['companion-not-reusable', notReusable(404, 'it is not a pull request in octo/widgets')]]);
    }
    assert.deepEqual(writes(world), []);
  });

  const usage: readonly (readonly [string, readonly string[]])[] = [
    ['zero', ['--existing-companion', '0']],
    ['not a number', ['--existing-companion', 'abc']],
    ['a leading zero', ['--existing-companion', '097']],
    ['a reference rather than a number', ['--existing-companion', '#97']],
    ['the same number twice', ['--existing-companion', '97', '--existing-companion', '97']],
    ['no value', ['--existing-companion']],
  ];
  for (const [what, flags] of usage) {
    test(`${what} is a usage error (exit 1) before anything is read`, () => {
      const world = makeWorld();
      const run = cli(world, ['validate', ...target(world, document([note()])), ...flags, '--format', 'json']);
      assert.equal(run.status, 1, run.stdout + run.stderr);
      const doc = json(run.stdout);
      assert.equal(doc['status'], 'usage-error');
      assert.match(asString(asRecord(asArray(doc['diagnostics'])[0])['message']), /--existing-companion/);
      assert.deepEqual(world.host.log(), []);
    });
  }
});
