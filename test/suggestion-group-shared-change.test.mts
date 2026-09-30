/**
 * A change carried by one group or by none (issue #42), through the
 * production composition: the real public library with the real GitHub
 * client, talking HTTP to the fake GitHub host of
 * test/fixtures/rewritten-history (only `fetch` is replaced).
 *
 * Two findings may explain one change (`add-staged-changes` gives both the
 * identical fix). When a suggestion group holds one of them and the other is
 * outside it, the group's suggestion pull request and the other finding's
 * own presentation would each propose the change, and neither could be
 * accepted after the other, so publication refuses the review with
 * `suggestion-group-change-shared`, naming the group, both findings and the
 * change (contract §2.3). `group-fixes` and `ungroup-fixes` never write such
 * a document (§2.12), so every document they accept is one publication
 * accepts: grouping both findings, or neither, is ready.
 *
 * Expected messages are written by hand from the contract.
 *
 * @see https://github.com/mike-north/sarif-to-comment/issues/42
 * @see docs/companion-suggestion-pr-contract.md §2.3, §2.4 (Conflicts), §2.12
 * @see docs/diagnostics.md
 */

import { AssertionError } from 'node:assert';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { describe, test } from 'node:test';

import library from '../dist/index.cjs';
import { LINE10_MESSAGE, LINE6_MESSAGE, REVIEWED, call, lineFix, makeWorld, markdown, reviewDocument, status, writes } from './fixtures/rewritten-history/world.mts';
import type { IWorld, Json } from './fixtures/rewritten-history/world.mts';
import { assertDiagnostics, expectedDiagnostic } from './support/diagnostics.mts';
import { asArray, asRecord, asString } from './support/runtime-types.mts';

const SAMPLE = 'docs/sample.md';
const LINE6 = 'Line 6, suggested.';

/** A finding on docs/sample.md line `line` with a one-line fix, in `group` when given. */
function edit(message: string, line: number, text: string, group?: string): Json {
  return {
    message: { text: message },
    locations: [{ physicalLocation: { artifactLocation: { uri: SAMPLE }, region: { startLine: line } } }],
    fixes: [lineFix(SAMPLE, line, text)],
    ...(group === undefined ? {} : { properties: { sarifToComment: { suggestionGroup: group } } }),
  };
}

/** reviewDocument's run with `results` instead of its own, and no artifact contents left over as context. */
function documentOf(results: readonly Json[]): Json {
  const document = reviewDocument();
  const run = asRecord(asArray(document['runs'])[0]);
  run['results'] = [...results];
  run['artifacts'] = [{ location: { uri: 'docs/new.md' } }, { location: { uri: 'obsolete.txt' } }];
  return document;
}

/** The three findings of the defect: two explaining the identical change of line 6, and a change of line 10. */
function explainedTwice(groups: readonly [string | undefined, string | undefined, string | undefined]): Json {
  return documentOf([
    edit(LINE6_MESSAGE, 6, LINE6, groups[0]),
    edit('Line 6 again, for another reason.', 6, LINE6, groups[1]),
    edit(LINE10_MESSAGE, 10, 'Line 10, suggested.', groups[2]),
  ]);
}

const validateDoc = (world: IWorld, sarif: Json): Promise<Json> => call('validateSarifReview', world, sarif);
const publishDoc = (world: IWorld, sarif: Json): Promise<Json> => call('publishSarifReview', world, sarif);

/** The refusal of a change a group and a finding outside it both propose (contract §2.3). */
function shared(pointer: string, message: string, remedies?: readonly string[]): Json {
  const documented = expectedDiagnostic('suggestion-group-change-shared', message, { location: { pointer, path: SAMPLE } });
  return remedies === undefined ? documented : { ...documented, remedies: [...remedies] };
}

const OUTSIDE_TAIL = 'one change cannot be accepted both in the group\'s suggestion pull request and on its own.';

function assertBlockedWith(outcome: Json, expected: readonly Json[]): void {
  assert.equal(status(outcome), 'blocked', markdown(outcome));
  assertDiagnostics(outcome['diagnostics'], expected.map((e) => ({
    code: asString(e['code']),
    location: asRecord(e['location']),
    remedies: e['remedies'] === undefined ? [] : asArray(e['remedies']).map((r) => asString(r)),
  })));
  assert.deepEqual(outcome['diagnostics'], expected);
}

function assertNothingWritten(world: IWorld): void {
  assert.deepEqual(writes(world), []);
  assert.equal(fs.existsSync(world.statePath), false);
}

describe('publication refuses a change that a group and a finding outside it both carry, naming the group (#42)', () => {
  test('regression (#42): the group comes first; the refusal is at the finding outside it, not a generic overlap', async () => {
    const expected = [shared('/runs/0/results/1',
      `The replacement of \`${SAMPLE}\` line 6 is proposed both by suggestion group "reword" (\`/runs/0/results/0\`) and by \`/runs/0/results/1\`, which is not in the group; ${OUTSIDE_TAIL}`)];
    for (const operation of [validateDoc, publishDoc]) {
      const world = makeWorld(REVIEWED);
      assertBlockedWith(await operation(world, explainedTwice(['reword', undefined, 'reword'])), expected);
      assertNothingWritten(world);
    }
  });

  test('the finding outside the group comes first; the refusal is at the group\'s finding', async () => {
    const document = documentOf([
      edit('Line 6 again, for another reason.', 6, LINE6),
      edit(LINE6_MESSAGE, 6, LINE6, 'reword'),
      edit(LINE10_MESSAGE, 10, 'Line 10, suggested.', 'reword'),
    ]);
    const world = makeWorld(REVIEWED);
    assertBlockedWith(await validateDoc(world, document), [shared('/runs/0/results/1',
      `The replacement of \`${SAMPLE}\` line 6 is proposed both by suggestion group "reword" (\`/runs/0/results/1\`) and by \`/runs/0/results/0\`, which is not in the group; ${OUTSIDE_TAIL}`)]);
  });

  test('two groups carrying the identical change: both groups named; groups are never joined', async () => {
    const document = documentOf([
      edit(LINE6_MESSAGE, 6, LINE6, 'reword'),
      edit('Line 6 again, for another reason.', 6, LINE6, 'other'),
      edit(LINE10_MESSAGE, 10, 'Line 10, suggested.', 'reword'),
      edit('Line 5 too.', 5, 'Line 5, suggested.', 'other'),
    ]);
    const world = makeWorld(REVIEWED);
    assertBlockedWith(await validateDoc(world, document), [shared('/runs/0/results/1',
      `The replacement of \`${SAMPLE}\` line 6 is proposed both by suggestion group "reword" (\`/runs/0/results/0\`) and by suggestion group "other" (\`/runs/0/results/1\`); `
      + 'one change cannot be accepted in two suggestion pull requests, and groups are never joined.',
      ['Take one of the two findings out of its group (`ungroup-fixes`).'])]);
  });

  test('grouping both, or neither, is ready', async () => {
    for (const groups of [['reword', 'reword', 'reword'], [undefined, undefined, undefined]] as const) {
      const outcome = await validateDoc(makeWorld(REVIEWED), explainedTwice(groups));
      assert.equal(status(outcome), 'ready', markdown(outcome));
      assert.deepEqual(outcome['diagnostics'], []);
    }
  });
});

describe('every document group-fixes and ungroup-fixes write is one publication accepts (#42)', () => {
  type SelectorOutcome = { readonly status: string; readonly sarif?: unknown; readonly problems?: readonly { readonly code: string }[] };
  const selectors = (sarif: Json, ...refs: readonly string[]): string[] => {
    const inspected = library.inspectSarif(sarif);
    if (inspected.status !== 'inspected') throw new AssertionError({ message: `inspection refused: ${inspected.markdown}` });
    return refs.map((ref) => {
      const found = inspected.view.findings.find((f) => f.ref === ref);
      assert.ok(found, `inspection shows ${ref}`);
      return found.selector;
    });
  };

  test('regression (#42): group-fixes refuses one of the two findings; grouping both publishes one suggestion pull request', async () => {
    const document = explainedTwice([undefined, undefined, undefined]);
    const partial: SelectorOutcome = library.groupSarifFixes(document, { findings: selectors(document, '/runs/0/results/0', '/runs/0/results/2'), group: 'reword' });
    assert.equal(partial.status, 'refused');
    assert.deepEqual(partial.problems?.map((p) => p.code), ['suggestion-group-change-shared']);

    const whole = library.groupSarifFixes(document, { findings: selectors(document, '/runs/0/results/0', '/runs/0/results/1', '/runs/0/results/2'), group: 'reword' });
    if (whole.status !== 'grouped') throw new AssertionError({ message: `grouping refused: ${whole.markdown}` });
    const grouped: Json = asRecord(whole.sarif);
    const assessed = await validateDoc(makeWorld(REVIEWED), grouped);
    assert.equal(status(assessed), 'ready', markdown(assessed));
    const world = makeWorld(REVIEWED);
    const published = await publishDoc(world, grouped);
    assert.equal(status(published), 'published', markdown(published));
    assert.equal(world.host.pulls().length, 1);

    const ungroupOne = library.ungroupSarifFixes(grouped, { findings: selectors(grouped, '/runs/0/results/1') });
    assert.equal(ungroupOne.status, 'refused');
  });
});
