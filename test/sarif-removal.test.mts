/**
 * Contract tests for removing a finding (removeSarifComment) and for the
 * inspection selectors that choose it.
 *
 * A finding is one SARIF result. Removing it removes that complete result,
 * with every fix and file proposal it carries; every other finding, fix,
 * artifact and property stays exactly as it was, including identical fixes
 * elsewhere. The selector comes from inspection and is bound to the document
 * that was inspected: after any change it is refused as stale, so it can
 * never delete whatever now occupies an old position. Identical findings in
 * different runs have different selectors.
 *
 * Expected documents are written by hand from the contract: the input with
 * exactly the selected result spliced out. They are never captured from the
 * implementation.
 *
 * @see docs/finding-removal-contract.md
 * @see docs/second-milestone-interface-design.md (inspection requirements and deferred removal design; acceptance examples 2, 3, 5)
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 * @see https://www.rfc-editor.org/rfc/rfc6901 (JSON Pointer, the position part of a selector)
 */

import { AssertionError } from 'node:assert';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import library from '../dist/index.cjs';
import { addSarifComment, createSarifDocument, removeSarifComment } from '../dist/sarif-authoring.cjs';
import type { AddSarifCommentOutcome, IAddedSarifCommentOutcome } from '../dist/sarif-authoring.cjs';
import type { IRemovedSarifCommentOutcome, IStaleSarifSelectorOutcome, RemoveSarifCommentOutcome } from '../dist/sarif-authoring.cjs';
import { inspectSarif } from '../dist/sarif-inspection.cjs';
import type { ISarifInspection } from '../dist/sarif-inspection.cjs';
import { validateSarif } from '../dist/sarif-common.cjs';
import { asArray, asRecord, readJson } from './support/runtime-types.mts';

const UPSTREAM = path.join(import.meta.dirname, 'fixtures', 'sarif-inspection', 'upstream.sarif.json');
const loadUpstream = () => asRecord(readJson(UPSTREAM), 'the upstream SARIF fixture');

/** The selector form of the contract (§2): `<ref>@<16 lowercase hex>`. */
const SELECTOR = /^(\/runs\/(?:0|[1-9][0-9]*)\/results\/(?:0|[1-9][0-9]*))@([0-9a-f]{16})$/;

// ---------------------------------------------------------------------------
// Helpers

/**
 * The value reached from `value` through `keys` (numbers index arrays, strings
 * index objects). Each step is runtime-checked; only the last may be absent.
 */
function dig(value: unknown, ...keys: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of keys) current = typeof key === 'number' ? asArray(current)[key] : asRecord(current)[key];
  return current;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Every object/array reachable from a value. */
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

/** The inspection view of a document that must be valid SARIF. */
function viewOf(sarif: object): ISarifInspection {
  const outcome = inspectSarif(sarif);
  if (outcome.status !== 'inspected') throw new AssertionError({ message: `SARIF refused: ${outcome.markdown}` });
  return outcome.view;
}

/** Every finding's selector, in view order. */
function selectorsOf(sarif: object): string[] {
  return viewOf(sarif).findings.map((f) => f.selector);
}

/** The selector inspection gives the finding at `ref`. */
function selectorAt(sarif: object, ref: string): string {
  const finding = viewOf(sarif).findings.find((f) => f.ref === ref);
  if (!finding) throw new AssertionError({ message: `inspection has no finding ${ref}` });
  return finding.selector;
}

/** The outcome of a comment that must have been added. */
function added(outcome: AddSarifCommentOutcome): IAddedSarifCommentOutcome {
  if (outcome.status !== 'added') throw new AssertionError({ message: `comment refused: ${outcome.markdown}` });
  return outcome;
}

/** The outcome of a removal that must have succeeded. */
function removed(outcome: RemoveSarifCommentOutcome): IRemovedSarifCommentOutcome {
  if (outcome.status !== 'removed') throw new AssertionError({ message: `removal refused (${outcome.status}): ${outcome.markdown}` });
  return outcome;
}

/** The outcome of a removal that must have been refused as stale. */
function stale(outcome: RemoveSarifCommentOutcome): IStaleSarifSelectorOutcome {
  if (outcome.status !== 'stale') throw new AssertionError({ message: `expected a stale refusal, got ${outcome.status}` });
  return outcome;
}

/** A copy of `sarif` with exactly the result at run `i`, position `j` removed: the contract's expected document. */
function without(sarif: unknown, i: number, j: number): unknown {
  const copy = structuredClone(sarif);
  asArray(dig(copy, 'runs', i, 'results')).splice(j, 1);
  return copy;
}

/** A deep copy of a JSON value with every object's keys in reverse order. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversedKeys(v)]));
  }
  return value;
}

const EMPTY_INPUT = 'Handle the empty-input case.';

/** One authored finding, as addSarifComment writes it (contract §3.2), on src/parse.js line 2. */
const emptyInputFinding = () => ({
  message: { text: EMPTY_INPUT },
  locations: [{ physicalLocation: { artifactLocation: { uri: 'src/parse.js' }, region: { startLine: 2 } } }],
});

/** A fix replacing src/parse.js line 2; identical wherever it is attached. */
const lineTwoFix = () => ({
  description: { text: 'Guard the empty input.' },
  artifactChanges: [{
    artifactLocation: { uri: 'src/parse.js' },
    replacements: [{ deletedRegion: { startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 }, insertedContent: { text: "  if (input === '') return [];\n" } }],
  }],
});

/** Two runs, each holding one identical finding at identical coordinates (acceptance example 2). */
function twoRunsWithIdenticalFindings(): Record<string, unknown> {
  return {
    version: '2.1.0',
    runs: [
      { tool: { driver: { name: 'Review agent' } }, results: [emptyInputFinding()] },
      { tool: { driver: { name: 'Review agent' } }, results: [emptyInputFinding()] },
    ],
  };
}

/**
 * One run with: A (two fixes, one of them the line-two fix, and a file
 * proposal referring to run artifact 0), B (the identical line-two fix), and
 * C (no fix). Run and log properties are present so their preservation is
 * visible.
 */
function findingsWithFixes(): Record<string, unknown> {
  return {
    version: '2.1.0',
    properties: { purpose: 'removal fixture' },
    runs: [{
      tool: { driver: { name: 'Review agent', version: '1.0.0' } },
      columnKind: 'utf16CodeUnits',
      artifacts: [{ location: { uri: 'docs/new.md' }, contents: { text: '# New\n' } }],
      properties: { note: 'run metadata' },
      results: [
        {
          ruleId: 'A',
          message: { text: 'Finding A.' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'src/parse.js' }, region: { startLine: 2 } } }],
          fixes: [lineTwoFix(), { description: { text: 'Alternative.' }, artifactChanges: [{ artifactLocation: { uri: 'src/other.js' }, replacements: [{ deletedRegion: { startLine: 1 } }] }] }],
          properties: { sarifToComment: { proposedFileChanges: [{ operation: 'create', artifactIndex: 0 }] } },
        },
        {
          ruleId: 'B',
          message: { text: 'Finding B.' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'src/parse.js' }, region: { startLine: 2 } } }],
          fixes: [lineTwoFix()],
        },
        { ruleId: 'C', message: { text: 'Finding C, general.' } },
      ],
    }],
  };
}

// ---------------------------------------------------------------------------
// Selectors in inspection (contract §2)

describe('inspection gives every finding a selector bound to the inspected document', () => {
  test('each finding has a selector of the form <ref>@<digest>, placed right after ref', () => {
    const view = viewOf(loadUpstream());
    assert.equal(view.findings.length, 7);
    for (const finding of view.findings) {
      const match = SELECTOR.exec(finding.selector);
      assert.ok(match, `malformed selector ${finding.selector}`);
      assert.equal(match[1], finding.ref, 'the position part is the finding ref');
      assert.deepStrictEqual(Object.keys(finding).slice(0, 2), ['ref', 'selector']);
    }
  });

  test('all findings of one document share its digest, so every selector is distinct only by position', () => {
    const selectors = selectorsOf(loadUpstream());
    const digests = new Set(selectors.map((s) => SELECTOR.exec(s)?.[2]));
    assert.equal(digests.size, 1);
    assert.equal(new Set(selectors).size, selectors.length);
  });

  test('identical findings in different runs have different selectors (acceptance example 2)', () => {
    const view = viewOf(twoRunsWithIdenticalFindings());
    assert.deepStrictEqual(view.findings.map((f) => f.ref), ['/runs/0/results/0', '/runs/1/results/0']);
    const [first, second] = view.findings.map((f) => f.selector);
    assert.notEqual(first, second);
    assert.deepStrictEqual(view.findings.map((f) => f.message.text), [EMPTY_INPUT, EMPTY_INPUT]);
  });

  test('the same document gives the same selectors, whatever its key order or formatting', () => {
    const sarif = loadUpstream();
    const selectors = selectorsOf(sarif);
    assert.deepStrictEqual(selectorsOf(loadUpstream()), selectors);
    const reordered = asRecord(reversedKeys(sarif));
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(sarif), 'the control really reorders keys');
    assert.deepStrictEqual(selectorsOf(reordered), selectors);
  });

  test('any change of value gives every finding a new selector', () => {
    const sarif = loadUpstream();
    const before = selectorsOf(sarif);
    const edited = structuredClone(sarif);
    asRecord(dig(edited, 'runs', 1, 'results', 0, 'message'))['text'] = 'Handle the empty-input case!';
    const after = selectorsOf(edited);
    for (const [k, selector] of after.entries()) assert.notEqual(selector, before[k]);
    const extraProperty = structuredClone(sarif);
    extraProperty['properties'] = { added: true };
    assert.notDeepStrictEqual(selectorsOf(extraProperty), before, 'log-level content is part of the document');
  });

  test('inspection options change previews, never selectors', () => {
    const sarif = loadUpstream();
    const plain = selectorsOf(sarif);
    const outcome = inspectSarif(sarif, { previewLines: 1, previewChars: 3, sourceRootUri: 'file:///work/app/' });
    if (outcome.status !== 'inspected') throw new AssertionError({ message: `SARIF refused: ${outcome.markdown}` });
    assert.deepStrictEqual(outcome.view.findings.map((f) => f.selector), plain);
  });
});

// ---------------------------------------------------------------------------
// removeSarifComment (contract §3)

describe('removeSarifComment removes exactly the selected finding and its attached fixes', () => {
  test('removing one of two identical findings in different runs keeps the other (acceptance example 2)', () => {
    const sarif = twoRunsWithIdenticalFindings();
    const outcome = removed(removeSarifComment(sarif, selectorAt(sarif, '/runs/1/results/0')));
    assert.deepStrictEqual(outcome.sarif, without(sarif, 1, 0));
    assert.deepStrictEqual(dig(outcome.sarif, 'runs', 1, 'results'), [], 'a run left without findings keeps an empty results list');
    assert.deepStrictEqual(outcome.finding, { ref: '/runs/1/results/0', runIndex: 1, resultIndex: 0, tool: 'Review agent', fixes: 0, fileProposals: 0 });

    const other = removed(removeSarifComment(sarif, selectorAt(sarif, '/runs/0/results/0')));
    assert.deepStrictEqual(other.sarif, without(sarif, 0, 0));
    assert.deepStrictEqual(dig(other.sarif, 'runs', 1, 'results'), [emptyInputFinding()]);
  });

  test('the whole result goes, with its fixes and file proposals; identical fixes elsewhere and all other content stay', () => {
    const sarif = findingsWithFixes();
    const outcome = removed(removeSarifComment(sarif, selectorAt(sarif, '/runs/0/results/0')));
    assert.deepStrictEqual(outcome.sarif, without(sarif, 0, 0));
    assert.deepStrictEqual(dig(outcome.sarif, 'runs', 0, 'results', 0, 'fixes'), [lineTwoFix()], 'B keeps its identical fix');
    assert.deepStrictEqual(dig(outcome.sarif, 'runs', 0, 'artifacts'), dig(sarif, 'runs', 0, 'artifacts'),
      'run artifacts are kept even when only the removed finding referred to them');
    assert.deepStrictEqual(outcome.finding, { ref: '/runs/0/results/0', runIndex: 0, resultIndex: 0, tool: 'Review agent', fixes: 2, fileProposals: 1 });
    assert.equal(validateSarif(outcome.sarif), null, 'the result is schema-valid SARIF');
  });

  test('the outcome and its finding serialize in contract order', () => {
    const sarif = findingsWithFixes();
    const outcome = removed(removeSarifComment(sarif, selectorAt(sarif, '/runs/0/results/2')));
    assert.deepStrictEqual(Object.keys(outcome), ['status', 'sarif', 'finding']);
    assert.deepStrictEqual(Object.keys(outcome.finding), ['ref', 'runIndex', 'resultIndex', 'tool', 'fixes', 'fileProposals']);
    assert.deepStrictEqual(outcome.finding, { ref: '/runs/0/results/2', runIndex: 0, resultIndex: 2, tool: 'Review agent', fixes: 0, fileProposals: 0 });
    assert.deepStrictEqual(outcome.sarif, without(sarif, 0, 2));
  });

  test('upstream SARIF: each finding can be removed and nothing else changes', () => {
    const upstream = loadUpstream();
    const expectedCounts: readonly (readonly [string, number, number, string])[] = [
      // [ref, fixes, file proposals, tool]: counted by hand from the fixture.
      ['/runs/0/results/0', 1, 0, 'ESLint'],
      ['/runs/0/results/1', 2, 0, 'ESLint'],
      ['/runs/0/results/2', 0, 0, 'ESLint'],
      ['/runs/0/results/3', 1, 0, 'ESLint'],
      ['/runs/0/results/4', 0, 3, 'ESLint'],
      ['/runs/0/results/5', 0, 0, 'ESLint'],
      ['/runs/1/results/0', 0, 0, 'Review agent'],
    ];
    for (const [ref, fixes, fileProposals, tool] of expectedCounts) {
      const [, i = '', j = ''] = /^\/runs\/(\d+)\/results\/(\d+)$/.exec(ref) ?? [];
      const outcome = removed(removeSarifComment(upstream, selectorAt(upstream, ref)));
      assert.deepStrictEqual(outcome.sarif, without(upstream, Number(i), Number(j)), `removing ${ref}`);
      assert.deepStrictEqual(outcome.finding, { ref, runIndex: Number(i), resultIndex: Number(j), tool, fixes, fileProposals });
    }
  });

  test('the input is never changed and the result shares nothing with it', () => {
    const sarif = deepFreeze(findingsWithFixes());
    const before = JSON.stringify(sarif);
    const outcome = removed(removeSarifComment(sarif, selectorAt(sarif, '/runs/0/results/1')));
    assert.equal(JSON.stringify(sarif), before);
    assertSharesNothing(outcome.sarif, sarif);
  });

  test('the public entry point exports the same operation', () => {
    assert.equal(library.removeSarifComment, removeSarifComment);
  });
});

describe('stale or foreign selectors are refused and delete nothing (acceptance example 5)', () => {
  test('after one removal, neither the old position nor the moved finding\'s old selector deletes anything', () => {
    const sarif = findingsWithFixes();
    const [a, b, c] = selectorsOf(sarif);
    const once = removed(removeSarifComment(sarif, String(a))).sarif;
    // B now occupies /runs/0/results/0, the position `a` names.
    for (const old of [a, b, c]) {
      const outcome = stale(removeSarifComment(once, String(old)));
      assert.equal(outcome.selector, old);
    }
  });

  test('identical neighbours: reusing a selector never removes the survivor that moved into its position', () => {
    const sarif = { version: '2.1.0', runs: [{ tool: { driver: { name: 'Review agent' } }, results: [emptyInputFinding(), emptyInputFinding()] }] };
    const first = selectorAt(sarif, '/runs/0/results/0');
    const once = removed(removeSarifComment(sarif, first)).sarif;
    assert.deepStrictEqual(dig(once, 'runs', 0, 'results'), [emptyInputFinding()]);
    stale(removeSarifComment(once, first));
  });

  test('a comment added after inspection makes earlier selectors stale', () => {
    const sarif = createSarifDocument({ tool: { name: 'Review agent' } });
    const one = added(addSarifComment(sarif, { file: 'src/parse.js', line: 2, message: EMPTY_INPUT }));
    const selector = selectorAt(one.sarif, '/runs/0/results/0');
    const two = added(addSarifComment(one.sarif, { file: 'src/parse.js', line: 5, message: 'Another.' }));
    stale(removeSarifComment(two.sarif, selector));
  });

  test('an edit anywhere in the document makes the selector stale', () => {
    const sarif = findingsWithFixes();
    const selector = selectorAt(sarif, '/runs/0/results/1');
    const edited = structuredClone(sarif);
    asRecord(dig(edited, 'runs', 0, 'properties'))['note'] = 'changed';
    stale(removeSarifComment(edited, selector));
  });

  test('a selector with this document\'s digest but no finding at its position is refused', () => {
    const sarif = findingsWithFixes();
    const digest = SELECTOR.exec(selectorAt(sarif, '/runs/0/results/0'))?.[2] ?? '';
    for (const ref of ['/runs/0/results/3', '/runs/1/results/0']) {
      const outcome = stale(removeSarifComment(sarif, `${ref}@${digest}`));
      assert.equal(outcome.problems[0]?.pointer, ref);
    }
  });

  test('the refusal names the selector and its position and says to inspect again', () => {
    const sarif = findingsWithFixes();
    const selector = selectorAt(sarif, '/runs/0/results/1');
    const once = removed(removeSarifComment(sarif, selectorAt(sarif, '/runs/0/results/0'))).sarif;
    const outcome = stale(removeSarifComment(once, selector));
    assert.deepStrictEqual(Object.keys(outcome), ['status', 'selector', 'problems', 'markdown']);
    assert.equal(outcome.problems.length, 1);
    const [problem] = outcome.problems;
    if (!problem) throw new AssertionError({ message: 'the refusal has no problem' });
    assert.equal(problem.pointer, '/runs/0/results/1');
    assert.match(problem.message, /inspect/i);
    assert.match(outcome.markdown, /inspect/i);
  });
});

describe('malformed input', () => {
  const sarif = findingsWithFixes();
  const digest = SELECTOR.exec(selectorAt(sarif, '/runs/0/results/0'))?.[2] ?? '';
  const malformed: readonly (readonly [string, unknown])[] = [
    ['a bare ref (a position alone is not a selector)', '/runs/0/results/0'],
    ['an empty string', ''],
    ['a number', 0],
    ['an object', { ref: '/runs/0/results/0' }],
    ['an uppercase digest', `/runs/0/results/0@${digest.toUpperCase()}`],
    ['a short digest', `/runs/0/results/0@${digest.slice(1)}`],
    ['a leading-zero index', `/runs/00/results/0@${digest}`],
    ['a pointer to something other than a result', `/runs/0@${digest}`],
    ['surrounding whitespace', ` /runs/0/results/0@${digest}`],
  ];
  for (const [label, selector] of malformed) {
    test(`${label} is a TypeError that points to inspection`, () => {
      // @ts-expect-error -- deliberately untyped: proves runtime validation of the selector for JavaScript callers
      assert.throws(() => removeSarifComment(sarif, selector), (err: unknown) => err instanceof TypeError && /inspect/i.test(err.message));
    });
  }

  test('serialized text instead of a parsed document is a TypeError', () => {
    // @ts-expect-error -- deliberately untyped: proves runtime validation of the document for JavaScript callers
    assert.throws(() => removeSarifComment(JSON.stringify(sarif), selectorAt(sarif, '/runs/0/results/0')), TypeError);
  });

  test('schema-invalid SARIF is the invalid outcome', () => {
    const outcome = removeSarifComment({ version: '2.1.0', runs: [{ results: [] }] }, `/runs/0/results/0@${digest}`);
    if (outcome.status !== 'invalid') throw new AssertionError({ message: `expected invalid, got ${outcome.status}` });
    assert.ok(outcome.problems.length > 0);
    assert.deepStrictEqual(Object.keys(outcome), ['status', 'problems', 'markdown']);
  });
});

describe('correction: remove the mistaken finding, then add its replacement (acceptance example 3)', () => {
  test('the corrected document has the replacement and every other finding unchanged', () => {
    let sarif = createSarifDocument({ tool: { name: 'Review agent' } });
    for (const [line, message] of [[3, 'Handle the empty input case on the wrong line.'], [5, 'Combine these entries.']] as const) {
      sarif = added(addSarifComment(sarif, { file: 'src/parse.js', line, message })).sarif;
    }
    const keep = dig(sarif, 'runs', 0, 'results', 1);
    const out = removed(removeSarifComment(sarif, selectorAt(sarif, '/runs/0/results/0')));
    sarif = out.sarif;
    const corrected = added(addSarifComment(sarif, { file: 'src/parse.js', line: 2, message: EMPTY_INPUT }));
    assert.equal(corrected.finding.ref, '/runs/0/results/1');
    assert.deepStrictEqual(dig(corrected.sarif, 'runs', 0, 'results'), [keep, emptyInputFinding()]);
    const view = viewOf(corrected.sarif);
    assert.deepStrictEqual(view.findings.map((f) => [f.message.text, f.locations[0]?.startLine]),
      [['Combine these entries.', 5], [EMPTY_INPUT, 2]]);
  });
});
