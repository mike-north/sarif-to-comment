/**
 * Contract tests for grouping independent fixes for joint acceptance
 * (groupSarifFixes / ungroupSarifFixes), and for inspection showing each
 * finding's group.
 *
 * A group is declared by a per-result owned property,
 * `properties.sarifToComment.suggestionGroup`. Grouping is an authoring step
 * separate from extraction: it names findings by inspection selectors, never
 * infers anything, and returns a new document. The rules (issue #29, owner
 * decisions of September 29, 2026): a group needs at least two distinct
 * changes; a name already in use extends that group, but groups are never
 * joined; a finding belongs to at most one group; only a finding's primary
 * (first) fix is a member, alternatives never; a member without a change is
 * refused; a stale selector is refused.
 *
 * Every expected document and message is written by hand from the contract
 * (docs/companion-suggestion-pr-contract.md §2.3 and §2.12); none is captured
 * from the implementation. Group names are checked for parity with
 * publication's own reading, behaviourally, never by sharing its code.
 *
 * @see https://github.com/mike-north/sarif-to-comment/issues/29
 * @see docs/companion-suggestion-pr-contract.md
 * @see docs/finding-removal-contract.md (selectors)
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html (3.8 property bags, 3.55 fix)
 */

import { AssertionError } from 'node:assert';
import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import library from '../dist/index.cjs';
import { groupSarifFixes, ungroupSarifFixes } from '../dist/suggestion-groups.cjs';
import type {
  GroupSarifFixesOutcome,
  IGroupedSarifFixesOutcome,
  IRefusedSuggestionGroupOutcome,
  IUngroupedSarifFixesOutcome,
  UngroupSarifFixesOutcome,
} from '../dist/suggestion-groups.cjs';
import type { IStaleSarifSelectorOutcome } from '../dist/sarif-authoring.cjs';
import { prepareReview } from '../dist/prepare-review.cjs';
import { inspectSarif, renderInspectionText } from '../dist/sarif-inspection.cjs';
import type { ISarifInspection } from '../dist/sarif-inspection.cjs';
import { asArray, asRecord } from './support/runtime-types.mts';

// ---------------------------------------------------------------------------
// Documents

type Json = Record<string, unknown>;

const TOOL = 'Review bot';
const RETRY = '  const response = await request(id).catch(() => request(id));';

/** A one-line replacement of `uri` line `line` (SARIF 3.55-3.57). */
const lineFix = (uri: string, line: number, text: string): Json => ({
  artifactChanges: [{ artifactLocation: { uri }, replacements: [{ deletedRegion: { startLine: line }, insertedContent: { text } }] }],
});

/** A finding on `uri` line `line`, with optional extra result members. */
function finding(text: string, uri: string, line: number, extra: Json = {}): Json {
  return {
    message: { text },
    locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }],
    ...extra,
  };
}

function sarifDoc(results: readonly Json[], artifacts?: readonly Json[]): Json {
  return {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: TOOL } },
      columnKind: 'utf16CodeUnits',
      ...(artifacts === undefined ? {} : { artifacts }),
      results,
    }],
  };
}

/** The contract's worked example: a code edit, a test file creation, and an ungrouped typo fix. */
function codeAndTest(): Json {
  return sarifDoc([
    finding('Retry once on timeout.', 'src/client.ts', 2, { fixes: [lineFix('src/client.ts', 2, RETRY)] }),
    finding('Cover the retry.', 'test/client.test.ts', 3, {
      properties: { sarifToComment: { proposedFileChanges: [{ operation: 'create', artifactIndex: 0 }] } },
    }),
    finding('Typo.', 'README.md', 2, { fixes: [lineFix('README.md', 2, 'The widget client.')] }),
  ], [{ location: { uri: 'test/client.test.ts' }, contents: { text: 'test\n' } }]);
}

/** Three findings in two runs, each with its own one-line fix. */
function threeEdits(): Json {
  return {
    version: '2.1.0',
    runs: [
      { tool: { driver: { name: TOOL } }, columnKind: 'utf16CodeUnits', results: [
        finding('Strict mode.', 'bin/run.sh', 1, { fixes: [lineFix('bin/run.sh', 1, '#!/bin/sh -e')] }),
        finding('Quote.', 'bin/run.sh', 2, { fixes: [lineFix('bin/run.sh', 2, 'echo "run"')] }),
      ] },
      { tool: { driver: { name: 'Second bot' } }, columnKind: 'utf16CodeUnits', results: [
        finding('Document it.', 'README.md', 1, { fixes: [lineFix('README.md', 1, '# Widgets (run bin/run.sh)')] }),
      ] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers

/**
 * The value reached from `value` through `keys` (numbers index arrays,
 * strings index objects). Each step is runtime-checked.
 */
function dig(value: unknown, ...keys: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of keys) current = typeof key === 'number' ? asArray(current)[key] : asRecord(current)[key];
  return current;
}

function viewOf(sarif: object): ISarifInspection {
  const outcome = inspectSarif(sarif);
  if (outcome.status !== 'inspected') throw new AssertionError({ message: `SARIF refused: ${outcome.markdown}` });
  return outcome.view;
}

/** The selector inspection gives the finding at `ref`. */
function selectorAt(sarif: object, ref: string): string {
  const found = viewOf(sarif).findings.find((f) => f.ref === ref);
  if (!found) throw new AssertionError({ message: `inspection has no finding ${ref}` });
  return found.selector;
}

const selectorsAt = (sarif: object, ...refs: readonly string[]): string[] => refs.map((ref) => selectorAt(sarif, ref));

function grouped(outcome: GroupSarifFixesOutcome): IGroupedSarifFixesOutcome {
  if (outcome.status !== 'grouped') throw new AssertionError({ message: `grouping refused (${outcome.status}): ${outcome.markdown}` });
  return outcome;
}

function ungrouped(outcome: UngroupSarifFixesOutcome): IUngroupedSarifFixesOutcome {
  if (outcome.status !== 'ungrouped') throw new AssertionError({ message: `ungrouping refused (${outcome.status}): ${outcome.markdown}` });
  return outcome;
}

function stale(outcome: GroupSarifFixesOutcome | UngroupSarifFixesOutcome): IStaleSarifSelectorOutcome {
  if (outcome.status !== 'stale') throw new AssertionError({ message: `expected a stale refusal, got ${outcome.status}` });
  return outcome;
}

function refused(outcome: GroupSarifFixesOutcome | UngroupSarifFixesOutcome): IRefusedSuggestionGroupOutcome {
  if (outcome.status !== 'refused') throw new AssertionError({ message: `expected a refusal, got ${outcome.status}` });
  return outcome;
}

/**
 * The contract's expected result after grouping: the same result with
 * `properties.sarifToComment.suggestionGroup` added after every existing
 * property and owned key (§2.12).
 */
function withGroup(result: unknown, group: string): Json {
  const record = structuredClone(asRecord(result));
  const properties = record['properties'] === undefined ? {} : asRecord(record['properties']);
  const owned = properties['sarifToComment'] === undefined ? {} : asRecord(properties['sarifToComment']);
  record['properties'] = { ...properties, sarifToComment: { ...owned, suggestionGroup: group } };
  return record;
}

/** A copy of `sarif` whose results at the given [run, result] positions carry `group`. */
function expectGrouped(sarif: Json, group: string, positions: readonly (readonly [number, number])[]): Json {
  const copy = structuredClone(sarif);
  for (const [i, j] of positions) {
    const results = asArray(dig(copy, 'runs', i, 'results'));
    results[j] = withGroup(results[j], group);
  }
  return copy;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Every object and array reachable from a value. */
function objectsOf(value: unknown, into = new Set<unknown>()): Set<unknown> {
  if (value && typeof value === 'object') {
    into.add(value);
    Object.values(value).forEach((v) => objectsOf(v, into));
  }
  return into;
}

function assertSharesNothing(output: unknown, input: unknown): void {
  const inputs = objectsOf(input);
  for (const o of objectsOf(output)) assert.ok(!inputs.has(o), 'the output shares an object with the input');
}

// ---------------------------------------------------------------------------
// Grouping

describe('groupSarifFixes groups the primary fixes of findings across the document', () => {
  test('two fixes across findings: the exact new document and outcome', () => {
    const sarif = codeAndTest();
    const findings = selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1');
    const outcome = grouped(groupSarifFixes(sarif, { findings, group: 'retry-with-test' }));
    assert.deepEqual(outcome.sarif, expectGrouped(sarif, 'retry-with-test', [[0, 0], [0, 1]]));
    assert.deepEqual(outcome, {
      status: 'grouped',
      sarif: outcome.sarif,
      group: 'retry-with-test',
      extended: false,
      findings: [
        { ref: '/runs/0/results/0', runIndex: 0, resultIndex: 0, tool: TOOL, changes: 1 },
        { ref: '/runs/0/results/1', runIndex: 0, resultIndex: 1, tool: TOOL, changes: 1 },
      ],
      changes: 2,
    });
    // The owned key is written exactly as publication reads it.
    assert.equal(dig(outcome.sarif, 'runs', 0, 'results', 0, 'properties', 'sarifToComment', 'suggestionGroup'), 'retry-with-test');
    // Grouping an edit with a file creation keeps the creation's other owned keys, in order.
    assert.deepEqual(Object.keys(asRecord(dig(outcome.sarif, 'runs', 0, 'results', 1, 'properties', 'sarifToComment'))), ['proposedFileChanges', 'suggestionGroup']);
    // The ungrouped finding is untouched.
    assert.deepEqual(dig(outcome.sarif, 'runs', 0, 'results', 2), dig(sarif, 'runs', 0, 'results', 2));
    assert.equal(library.groupSarifFixes, groupSarifFixes, 'the package exports this operation');
  });

  test('several fixes across findings and runs; members are reported in document order', () => {
    const sarif = threeEdits();
    // Given out of document order: the outcome and the document do not depend on it.
    const findings = selectorsAt(sarif, '/runs/1/results/0', '/runs/0/results/1', '/runs/0/results/0');
    const outcome = grouped(groupSarifFixes(sarif, { findings, group: 'script' }));
    assert.deepEqual(outcome.sarif, expectGrouped(sarif, 'script', [[0, 0], [0, 1], [1, 0]]));
    assert.deepEqual(outcome.findings, [
      { ref: '/runs/0/results/0', runIndex: 0, resultIndex: 0, tool: TOOL, changes: 1 },
      { ref: '/runs/0/results/1', runIndex: 0, resultIndex: 1, tool: TOOL, changes: 1 },
      { ref: '/runs/1/results/0', runIndex: 1, resultIndex: 0, tool: 'Second bot', changes: 1 },
    ]);
    assert.equal(outcome.changes, 3);
  });

  test('an edit grouped with a whole-file creation', () => {
    const sarif = codeAndTest();
    const outcome = grouped(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/1', '/runs/0/results/0'), group: 'code+test' }));
    assert.equal(dig(outcome.sarif, 'runs', 0, 'results', 1, 'properties', 'sarifToComment', 'suggestionGroup'), 'code+test');
    assert.deepEqual(dig(outcome.sarif, 'runs', 0, 'results', 1, 'properties', 'sarifToComment', 'proposedFileChanges'),
      [{ operation: 'create', artifactIndex: 0 }], 'the creation itself is unchanged');
    assert.deepEqual(dig(outcome.sarif, 'runs', 0, 'artifacts'), dig(sarif, 'runs', 0, 'artifacts'));
  });

  test('a member whose fix has several changes contributes each of them', () => {
    const twoFiles: Json = { artifactChanges: [
      { artifactLocation: { uri: 'src/a.ts' }, replacements: [{ deletedRegion: { startLine: 1 }, insertedContent: { text: 'a' } }, { deletedRegion: { startLine: 5 }, insertedContent: { text: 'b' } }] },
      { artifactLocation: { uri: 'src/b.ts' }, replacements: [{ deletedRegion: { startLine: 2 }, insertedContent: { text: 'c' } }] },
    ] };
    const sarif = sarifDoc([
      finding('Rename everywhere.', 'src/a.ts', 1, { fixes: [twoFiles] }),
      finding('And the docs.', 'README.md', 1, { fixes: [lineFix('README.md', 1, '# Renamed')] }),
    ]);
    const outcome = grouped(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1'), group: 'rename' }));
    assert.deepEqual(outcome.findings.map((f) => f.changes), [3, 1]);
    assert.equal(outcome.changes, 4);
  });

  test('only the primary (first) fix is a member; alternatives are neither counted nor changed', () => {
    const sarif = sarifDoc([
      finding('Pick one.', 'src/a.ts', 1, { fixes: [
        lineFix('src/a.ts', 1, 'primary'),
        { artifactChanges: [{ artifactLocation: { uri: 'src/a.ts' }, replacements: [
          { deletedRegion: { startLine: 1 }, insertedContent: { text: 'alternative' } }, { deletedRegion: { startLine: 2 }, insertedContent: { text: 'too' } },
        ] }] },
      ] }),
      finding('Other.', 'src/b.ts', 1, { fixes: [lineFix('src/b.ts', 1, 'other')] }),
    ]);
    const outcome = grouped(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1'), group: 'pair' }));
    assert.deepEqual(outcome.findings.map((f) => f.changes), [1, 1], 'the alternative\'s two replacements are not members');
    assert.deepEqual(dig(outcome.sarif, 'runs', 0, 'results', 0, 'fixes'), dig(sarif, 'runs', 0, 'results', 0, 'fixes'));
  });

  test('existing properties and owned keys are kept, in order, with the group appended', () => {
    const sarif = sarifDoc([
      finding('One.', 'a.txt', 1, { fixes: [lineFix('a.txt', 1, 'x')], properties: { tags: ['keep'], sarifToComment: { approval: 'ready' } } }),
      finding('Two.', 'b.txt', 1, { fixes: [lineFix('b.txt', 1, 'y')] }),
    ]);
    const outcome = grouped(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1'), group: 'g' }));
    assert.deepEqual(dig(outcome.sarif, 'runs', 0, 'results', 0, 'properties'), { tags: ['keep'], sarifToComment: { approval: 'ready', suggestionGroup: 'g' } });
    assert.deepEqual(dig(outcome.sarif, 'runs', 0, 'results', 1, 'properties'), { sarifToComment: { suggestionGroup: 'g' } });
  });

  test('group names at the limits: one character, and 100 characters with inner spaces and non-ASCII text', () => {
    for (const group of ['x', `${'é'.repeat(49)} ${'ß'.repeat(50)}`]) {
      const sarif = threeEdits();
      const outcome = grouped(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1'), group }));
      assert.equal(outcome.group, group);
    }
  });
});

describe('groupSarifFixes refuses what the rules forbid, changing nothing', () => {
  test('a finding already in a group (a finding belongs to at most one)', () => {
    const first = threeEdits();
    const once = grouped(groupSarifFixes(first, { findings: selectorsAt(first, '/runs/0/results/0', '/runs/0/results/1'), group: 'script' })).sarif;
    const outcome = refused(groupSarifFixes(once, { findings: selectorsAt(once, '/runs/0/results/1', '/runs/1/results/0'), group: 'docs' }));
    const message = '`/runs/0/results/1` is already in suggestion group "script"; a finding belongs to at most one group. Ungroup it first to move it.';
    assert.deepEqual(outcome, {
      status: 'refused',
      problems: [{ message, pointer: '/runs/0/results/1' }],
      markdown: `**Cannot group the fixes:** nothing was changed.\n\n- ${message}`,
    });
  });

  test('a group name already in use extends that group; the result counts the whole group', () => {
    const first = threeEdits();
    const once = grouped(groupSarifFixes(first, { findings: selectorsAt(first, '/runs/0/results/0', '/runs/0/results/1'), group: 'script' })).sarif;
    const more = structuredClone(once);
    asArray(dig(more, 'runs', 1, 'results')).push(finding('More.', 'docs/x.md', 1, { fixes: [lineFix('docs/x.md', 1, 'x')] }));
    const outcome = grouped(groupSarifFixes(more, { findings: selectorsAt(more, '/runs/1/results/1', '/runs/1/results/0'), group: 'script' }));
    assert.deepEqual(outcome.sarif, expectGrouped(more, 'script', [[1, 0], [1, 1]]), 'only the named findings change');
    assert.deepEqual(outcome, {
      status: 'grouped',
      sarif: outcome.sarif,
      group: 'script',
      extended: true,
      findings: [
        { ref: '/runs/1/results/0', runIndex: 1, resultIndex: 0, tool: 'Second bot', changes: 1 },
        { ref: '/runs/1/results/1', runIndex: 1, resultIndex: 1, tool: 'Second bot', changes: 1 },
      ],
      changes: 4,
    });
  });

  test('a single finding may extend an existing group', () => {
    const first = threeEdits();
    const once = grouped(groupSarifFixes(first, { findings: selectorsAt(first, '/runs/0/results/0', '/runs/0/results/1'), group: 'script' })).sarif;
    const outcome = grouped(groupSarifFixes(once, { findings: selectorsAt(once, '/runs/1/results/0'), group: 'script' }));
    assert.deepEqual(outcome.sarif, expectGrouped(once, 'script', [[1, 0]]));
    assert.equal(outcome.extended, true);
    assert.equal(outcome.changes, 3);
  });

  test('naming a finding already in the same group is accepted and leaves it as it is', () => {
    const first = threeEdits();
    const once = grouped(groupSarifFixes(first, { findings: selectorsAt(first, '/runs/0/results/0', '/runs/0/results/1'), group: 'script' })).sarif;
    const outcome = grouped(groupSarifFixes(once, { findings: selectorsAt(once, '/runs/0/results/1', '/runs/1/results/0'), group: 'script' }));
    assert.deepEqual(outcome.sarif, expectGrouped(once, 'script', [[1, 0]]));
    assert.deepEqual(dig(outcome.sarif, 'runs', 0, 'results', 1), dig(once, 'runs', 0, 'results', 1));
  });

  test('extending never joins groups: a finding in another group is refused', () => {
    const first = threeEdits();
    const once = grouped(groupSarifFixes(first, { findings: selectorsAt(first, '/runs/0/results/0', '/runs/0/results/1'), group: 'script' })).sarif;
    const outcome = refused(groupSarifFixes(once, { findings: selectorsAt(once, '/runs/0/results/1'), group: 'docs' }));
    assert.deepEqual(outcome.problems.map((p) => p.message), [
      '`/runs/0/results/1` is already in suggestion group "script"; a finding belongs to at most one group. Ungroup it first to move it.',
      'The findings hold only 1 distinct change; a group needs at least two distinct changes to accept together (identical changes count once).',
    ]);
  });

  test('a new group of a single finding with one change is refused (fewer than two distinct changes)', () => {
    const sarif = threeEdits();
    const outcome = refused(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0'), group: 'solo' }));
    assert.deepEqual(outcome.problems, [{
      message: 'The findings hold only 1 distinct change; a group needs at least two distinct changes to accept together (identical changes count once).',
      pointer: '/runs/0/results/0',
    }]);
  });

  test('a member without a change is refused when extending too', () => {
    const first = threeEdits();
    const once = grouped(groupSarifFixes(first, { findings: selectorsAt(first, '/runs/0/results/0', '/runs/0/results/1'), group: 'script' })).sarif;
    const more = structuredClone(once);
    asArray(dig(more, 'runs', 1, 'results')).push(finding('Remark.', 'docs/x.md', 1));
    const outcome = refused(groupSarifFixes(more, { findings: selectorsAt(more, '/runs/1/results/1'), group: 'script' }));
    assert.equal(outcome.problems.length, 1);
    assert.match(outcome.problems[0]?.message ?? '', /proposes no change/);
  });

  test('fewer than two distinct changes: identical fixes count once', () => {
    const sarif = sarifDoc([
      finding('Same.', 'a.txt', 1, { fixes: [lineFix('a.txt', 1, 'x')] }),
      finding('Same again.', 'a.txt', 1, { fixes: [lineFix('a.txt', 1, 'x')] }),
    ]);
    const outcome = refused(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1'), group: 'g' }));
    assert.deepEqual(outcome.problems, [{
      message: 'The findings hold only 1 distinct change; a group needs at least two distinct changes to accept together (identical changes count once).',
      pointer: '/runs/0/results/0',
    }]);
  });

  test('a member without a change, reported with every other problem at once', () => {
    const sarif = sarifDoc([
      finding('Just a remark.', 'a.txt', 1),
      finding('A remark with an empty fix list.', 'a.txt', 2, { fixes: [] }),
      finding('A real change.', 'b.txt', 1, { fixes: [lineFix('b.txt', 1, 'y')] }),
    ]);
    const outcome = refused(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1', '/runs/0/results/2'), group: 'g' }));
    const noChange = (ref: string): string => `\`${ref}\` proposes no change: it has no fix and no proposed file operation, and a group joins changes. Leave it out of the group, or give it its change first.`;
    assert.deepEqual(outcome.problems, [
      { message: noChange('/runs/0/results/0'), pointer: '/runs/0/results/0' },
      { message: noChange('/runs/0/results/1'), pointer: '/runs/0/results/1' },
      { message: 'The findings hold only 1 distinct change; a group needs at least two distinct changes to accept together (identical changes count once).', pointer: '/runs/0/results/0' },
    ]);
    assert.equal(outcome.markdown, `**Cannot group the fixes:** nothing was changed.\n\n${outcome.problems.map((p) => `- ${p.message}`).join('\n')}`);
  });

  test('an owned namespace that is not an object cannot record a group', () => {
    const sarif = sarifDoc([
      finding('Odd.', 'a.txt', 1, { fixes: [lineFix('a.txt', 1, 'x')], properties: { sarifToComment: 'not an object' } }),
      finding('Fine.', 'b.txt', 1, { fixes: [lineFix('b.txt', 1, 'y')] }),
    ]);
    const outcome = refused(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1'), group: 'g' }));
    assert.deepEqual(outcome.problems, [{
      message: '`/runs/0/results/0` has a `properties.sarifToComment` that is not an object, so its group cannot be recorded.',
      pointer: '/runs/0/results/0',
    }]);
  });
});

describe('selectors: stale and ambiguous selections are refused', () => {
  test('a selector taken before the document changed is stale; nothing is grouped', () => {
    const sarif = threeEdits();
    const [a, b] = selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1');
    const changed = structuredClone(sarif);
    asArray(dig(changed, 'runs', 1, 'results')).push(finding('Later.', 'z.txt', 1));
    const outcome = stale(groupSarifFixes(changed, { findings: [String(a), String(b)], group: 'script' }));
    assert.equal(outcome.selector, a);
    assert.deepEqual(outcome.problems, [{
      message: `The document has changed since the selector \`${String(a)}\` was taken from inspecting it, so it may no longer name the same finding. Nothing was changed. Inspect the document again and use its current selectors.`,
      pointer: '/runs/0/results/0',
    }]);
    assert.ok(outcome.markdown.startsWith('**Cannot group the fixes:** '), outcome.markdown);
  });

  test('selectors from two different inspections are stale together, never mixed', () => {
    const sarif = threeEdits();
    const [a] = selectorsAt(sarif, '/runs/0/results/0');
    const once = grouped(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1'), group: 'x' })).sarif;
    const [c] = selectorsAt(once, '/runs/1/results/0');
    const outcome = groupSarifFixes(once, { findings: [String(a), String(c)], group: 'y' });
    assert.equal(outcome.status, 'stale');
  });

  test('a selector whose position holds no finding is stale', () => {
    const sarif = threeEdits();
    const digest = String(selectorAt(sarif, '/runs/0/results/0').split('@')[1]);
    const outcome = stale(groupSarifFixes(sarif, { findings: [selectorAt(sarif, '/runs/0/results/0'), `/runs/0/results/9@${digest}`], group: 'g' }));
    assert.deepEqual(outcome.problems.map((p) => p.pointer), ['/runs/0/results/9']);
  });

  test('identical findings in different runs are kept apart: only the selected one is grouped', () => {
    const same = (): Json => finding('Same.', 'a.txt', 1, { fixes: [lineFix('a.txt', 1, 'x')] });
    const sarif: Json = { version: '2.1.0', runs: [
      { tool: { driver: { name: TOOL } }, results: [same(), finding('Other.', 'b.txt', 1, { fixes: [lineFix('b.txt', 1, 'y')] })] },
      { tool: { driver: { name: TOOL } }, results: [same()] },
    ] };
    const outcome = grouped(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/1/results/0', '/runs/0/results/1'), group: 'g' }));
    assert.deepEqual(outcome.sarif, expectGrouped(sarif, 'g', [[0, 1], [1, 0]]));
    assert.equal(dig(outcome.sarif, 'runs', 0, 'results', 0, 'properties'), undefined, 'the identical finding in run 0 is not grouped');
  });

  const misuse: readonly (readonly [string, (s: Json) => unknown, RegExp])[] = [
    ['a bare position instead of a selector', (s) => ({ findings: ['/runs/0/results/0', selectorAt(s, '/runs/0/results/1')], group: 'g' }), /selector.*inspect/i],
    ['the same finding named twice (ambiguous)', (s) => ({ findings: [selectorAt(s, '/runs/0/results/0'), selectorAt(s, '/runs/0/results/0')], group: 'g' }), /twice/],
    ['an empty findings list', () => ({ findings: [], group: 'g' }), /at least one/],
    ['no findings list', () => ({ group: 'g' }), /findings/],
    ['a group name with surrounding whitespace', (s) => ({ findings: selectorsAt(s, '/runs/0/results/0', '/runs/0/results/1'), group: ' g' }), /1-100 characters/],
    ['an empty group name', (s) => ({ findings: selectorsAt(s, '/runs/0/results/0', '/runs/0/results/1'), group: '' }), /1-100 characters/],
    ['a group name of 101 characters', (s) => ({ findings: selectorsAt(s, '/runs/0/results/0', '/runs/0/results/1'), group: 'g'.repeat(101) }), /1-100 characters/],
    ['a group name with a control character', (s) => ({ findings: selectorsAt(s, '/runs/0/results/0', '/runs/0/results/1'), group: 'a\u0007b' }), /1-100 characters/],
    ['a group name with an invisible formatting character', (s) => ({ findings: selectorsAt(s, '/runs/0/results/0', '/runs/0/results/1'), group: 'a‮b' }), /1-100 characters/],
    ['a non-string group', (s) => ({ findings: selectorsAt(s, '/runs/0/results/0', '/runs/0/results/1'), group: 7 }), /group/],
    ['an unknown option', (s) => ({ findings: selectorsAt(s, '/runs/0/results/0', '/runs/0/results/1'), group: 'g', alternatives: true }), /alternatives/],
  ];
  for (const [label, options, pattern] of misuse) {
    test(`caller misuse is a TypeError: ${label}`, () => {
      const sarif = threeEdits();
      assert.throws(() => Reflect.apply(groupSarifFixes, undefined, [sarif, options(sarif)]),
        (err: unknown) => err instanceof TypeError && pattern.test(err.message) && err.message.startsWith('Invalid groupSarifFixes input: '));
    });
  }

  test('serialized text instead of a parsed document is a TypeError', () => {
    const sarif = threeEdits();
    assert.throws(() => Reflect.apply(groupSarifFixes, undefined, [JSON.stringify(sarif), { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1'), group: 'g' }]), TypeError);
  });

  test('schema-invalid SARIF is the invalid outcome', () => {
    const notSarif = { version: '2.1.0', runs: [{ results: [] }] };
    const outcome = groupSarifFixes(notSarif, { findings: ['/runs/0/results/0@0123456789abcdef', '/runs/0/results/1@0123456789abcdef'], group: 'g' });
    assert.equal(outcome.status, 'invalid');
  });
});

// ---------------------------------------------------------------------------
// Ungrouping

describe('ungroupSarifFixes removes findings from their groups', () => {
  /** threeEdits with all three findings in group "script". */
  function groupedThree(): Json {
    const sarif = threeEdits();
    return grouped(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1', '/runs/1/results/0'), group: 'script' })).sarif;
  }

  test('ungrouping a whole group restores the document exactly as it was before grouping', () => {
    const before = threeEdits();
    const once = groupedThree();
    const outcome = ungrouped(ungroupSarifFixes(once, { findings: selectorsAt(once, '/runs/0/results/0', '/runs/0/results/1', '/runs/1/results/0') }));
    assert.deepEqual(outcome.sarif, before, 'the group, and the owned namespace and property bag it created, are gone');
    assert.deepEqual(outcome, {
      status: 'ungrouped',
      sarif: outcome.sarif,
      findings: [
        { ref: '/runs/0/results/0', runIndex: 0, resultIndex: 0, tool: TOOL, group: 'script' },
        { ref: '/runs/0/results/1', runIndex: 0, resultIndex: 1, tool: TOOL, group: 'script' },
        { ref: '/runs/1/results/0', runIndex: 1, resultIndex: 0, tool: 'Second bot', group: 'script' },
      ],
    });
    assert.equal(library.ungroupSarifFixes, ungroupSarifFixes, 'the package exports this operation');
  });

  test('ungrouping one member keeps a group that still holds two distinct changes', () => {
    const once = groupedThree();
    const outcome = ungrouped(ungroupSarifFixes(once, { findings: selectorsAt(once, '/runs/1/results/0') }));
    assert.deepEqual(outcome.sarif, expectGrouped(threeEdits(), 'script', [[0, 0], [0, 1]]));
  });

  test('other owned keys and properties stay; only an emptied namespace and bag are removed', () => {
    const sarif = sarifDoc([
      finding('One.', 'a.txt', 1, { fixes: [lineFix('a.txt', 1, 'x')], properties: { tags: ['keep'], sarifToComment: { approval: 'ready', suggestionGroup: 'g' } } }),
      finding('Two.', 'b.txt', 1, { fixes: [lineFix('b.txt', 1, 'y')], properties: { sarifToComment: { suggestionGroup: 'g' } } }),
    ]);
    const outcome = ungrouped(ungroupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1') }));
    assert.deepEqual(dig(outcome.sarif, 'runs', 0, 'results', 0, 'properties'), { tags: ['keep'], sarifToComment: { approval: 'ready' } });
    assert.equal(dig(outcome.sarif, 'runs', 0, 'results', 1, 'properties'), undefined);
  });

  test('refused: a finding in no group', () => {
    const sarif = threeEdits();
    const outcome = refused(ungroupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/1') }));
    const message = '`/runs/0/results/1` is not in a suggestion group, so there is nothing to ungroup.';
    assert.deepEqual(outcome, {
      status: 'refused',
      problems: [{ message, pointer: '/runs/0/results/1' }],
      markdown: `**Cannot ungroup the fixes:** nothing was changed.\n\n- ${message}`,
    });
  });

  test('refused: ungrouping that would leave a group with a single change names the rest to include', () => {
    const sarif = threeEdits();
    const once = grouped(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1'), group: 'pair' })).sarif;
    const [keep] = selectorsAt(once, '/runs/0/results/1');
    const outcome = refused(ungroupSarifFixes(once, { findings: selectorsAt(once, '/runs/0/results/0') }));
    assert.deepEqual(outcome.problems, [{
      message: `Suggestion group "pair" would keep only 1 distinct change (\`/runs/0/results/1\`), and a group needs at least two. To dissolve the group, ungroup its other findings too: \`${String(keep)}\`.`,
      pointer: '/runs/0/results/1',
    }]);
  });

  test('stale and misused selectors are refused as for grouping', () => {
    const once = groupedThree();
    const [a] = selectorsAt(once, '/runs/0/results/0');
    const changed = structuredClone(once);
    asArray(dig(changed, 'runs', 0, 'results')).push(finding('Later.', 'z.txt', 1));
    const outcome = stale(ungroupSarifFixes(changed, { findings: [String(a)] }));
    assert.ok(outcome.markdown.startsWith('**Cannot ungroup the fixes:** '), outcome.markdown);
    for (const options of [{ findings: [] }, { findings: ['/runs/0/results/0'] }, { findings: [String(a), String(a)] }, {}]) {
      assert.throws(() => Reflect.apply(ungroupSarifFixes, undefined, [once, options]),
        (err: unknown) => err instanceof TypeError && err.message.startsWith('Invalid ungroupSarifFixes input: '));
    }
  });
});

// ---------------------------------------------------------------------------
// Immutability

describe('inputs are never mutated and outputs share nothing with them', () => {
  test('grouping and ungrouping a deep-frozen document', () => {
    const sarif = deepFreeze(codeAndTest());
    const snapshot = structuredClone(sarif);
    const findings = deepFreeze(selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1'));
    const outcome = grouped(groupSarifFixes(sarif, deepFreeze({ findings, group: 'retry-with-test' })));
    assert.deepEqual(sarif, snapshot);
    assertSharesNothing(outcome.sarif, sarif);
    const frozen = deepFreeze(outcome.sarif);
    const back = ungrouped(ungroupSarifFixes(frozen, { findings: selectorsAt(frozen, '/runs/0/results/0', '/runs/0/results/1') }));
    assertSharesNothing(back.sarif, frozen);
    assert.deepEqual(back.sarif, snapshot);
  });

  test('a refused grouping leaves the input exactly as it was', () => {
    const sarif = sarifDoc([finding('Same.', 'a.txt', 1, { fixes: [lineFix('a.txt', 1, 'x')] }), finding('Same.', 'a.txt', 1, { fixes: [lineFix('a.txt', 1, 'x')] })]);
    const snapshot = structuredClone(sarif);
    refused(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1'), group: 'g' }));
    assert.deepEqual(sarif, snapshot);
  });
});

// ---------------------------------------------------------------------------
// Inspection

describe('inspection shows each finding\'s group', () => {
  test('the view names the group of grouped findings only, after the finding\'s facts and before its message', () => {
    const sarif = codeAndTest();
    const once = grouped(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1'), group: 'retry-with-test' })).sarif;
    const view = viewOf(once);
    assert.deepEqual(view.findings.map((f) => f.suggestionGroup), ['retry-with-test', 'retry-with-test', undefined]);
    assert.equal(Object.hasOwn(asRecord(view.findings[2]), 'suggestionGroup'), false, 'an ungrouped finding has no suggestionGroup key');
    const keys = Object.keys(asRecord(view.findings[0]));
    assert.equal(keys.indexOf('suggestionGroup'), keys.indexOf('resultIndex') + 1, 'after the facts (none here besides the position)');
    assert.equal(keys.indexOf('message'), keys.indexOf('suggestionGroup') + 1, 'before the message');
    const approved = viewOf(sarifDoc([finding('Held.', 'a.txt', 1, { level: 'error', properties: { sarifToComment: { approval: 'ready', suggestionGroup: 'g' } } })]));
    const approvedKeys = Object.keys(asRecord(approved.findings[0]));
    assert.equal(approvedKeys.indexOf('suggestionGroup'), approvedKeys.indexOf('approval') + 1, 'right after a declared approval');
  });

  test('human inspection lists the group among the finding\'s facts', () => {
    const sarif = codeAndTest();
    const once = grouped(groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1'), group: 'retry-with-test' })).sarif;
    const text = renderInspectionText(viewOf(once));
    assert.ok(text.includes('Finding /runs/0/results/0 — Review bot · suggestionGroup: retry-with-test\n'), text);
    assert.ok(text.includes('Finding /runs/0/results/1 — Review bot · suggestionGroup: retry-with-test\n'), text);
    assert.ok(text.includes('Finding /runs/0/results/2 — Review bot\n'), text);
  });

  test('a group value that is not a string is not presented as a group (it stays in the finding\'s other content)', () => {
    const sarif = sarifDoc([finding('Odd.', 'a.txt', 1, { properties: { sarifToComment: { suggestionGroup: 7 } } })]);
    const view = viewOf(sarif);
    assert.equal(view.findings[0]?.suggestionGroup, undefined);
    assert.deepEqual(dig(view.findings[0], 'otherContent', 'properties'), { sarifToComment: { suggestionGroup: 7 } });
  });
});

// ---------------------------------------------------------------------------
// Parity with publication

describe('grouping accepts exactly the group names publication accepts', () => {
  const COMMIT = 'c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de';

  /** Whether publication's preparation reads `name` as a valid suggestion group (it reports no suggestion-group-invalid). */
  async function publisherAccepts(name: string): Promise<boolean> {
    const outcome = await prepareReview({
      sarif: sarifDoc([{ message: { text: 'm' }, properties: { sarifToComment: { suggestionGroup: name } } }]),
      context: { owner: 'octo', repo: 'widgets', pullNumber: 1, reviewedCommit: COMMIT, diff: { baseCommit: COMMIT, headCommit: COMMIT, files: [] } },
      readSource: () => Promise.resolve(null),
    });
    return outcome.status === 'ready' || !outcome.diagnostics.some((d) => d.code === 'suggestion-group-invalid');
  }

  function groupingAccepts(name: string): boolean {
    const sarif = threeEdits();
    try {
      return groupSarifFixes(sarif, { findings: selectorsAt(sarif, '/runs/0/results/0', '/runs/0/results/1'), group: name }).status === 'grouped';
    } catch (err) {
      if (err instanceof TypeError) return false;
      throw err;
    }
  }

  const names = [
    'retry-with-test', 'x', 'g'.repeat(100), 'g'.repeat(101), '', ' lead', 'trail ', 'inner space', 'tab\tinside', 'line\nbreak',
    'bell\u0007', 'del\u007F', 'c1\u0085', 'bom﻿', 'rtl‮', 'isolate⁦', 'lrm‎', 'ls ',
    'lone\uD800', '\uDC00lone', 'emoji 😀', 'ünïcödé',
  ];
  for (const name of names) {
    test(`the same verdict for ${JSON.stringify(name)}`, async () => {
      const published = await publisherAccepts(name);
      assert.equal(groupingAccepts(name), published);
    });
  }

  test('control: the verdicts are not all the same', async () => {
    assert.equal(await publisherAccepts('retry-with-test'), true);
    assert.equal(await publisherAccepts(' lead'), false);
  });
});
