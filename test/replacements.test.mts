/**
 * Contract tests for exact SARIF text replacement (src/replacements.cts).
 *
 * A replacement must reproduce the producer's literal edit of the original
 * file. Separately, it is described as a closed range of whole source lines:
 * the original lines with their own terminators, and the exact text (and line
 * sequence) that replaces them, preserving every untouched character on those
 * lines. Expected edited sources, line ranges, original and replacement text,
 * replacement line sequences and terminal-newline status are hand-authored in
 * test/fixtures/replacements from the SARIF region rules; none is computed by
 * the module under test.
 *
 * Two independent checks guard the fixtures themselves. A line-splice oracle
 * confirms that each case's authored original lines, replacement text and
 * edited source describe the same edit using only whole-line substitution,
 * never region arithmetic. Hand-authored wrong outputs (an inclusive end
 * column, a deleted, retained or normalized newline, UTF-16 versus code-point
 * units, a counted or stripped byte-order mark, a lost prefix or suffix, zero
 * lines confused with one blank line, a neighbouring edit applied) must differ
 * from the expected result, proving each case can detect that defect.
 *
 * The module under test applies exactly one replacement. It never decides
 * which feedback a replacement carries, never widens lines toward nearby
 * feedback or neighbouring edits, and never judges how a host renders the
 * candidate or whether it may be applied there; none of that is tested here.
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html (3.14.27 columnKind, run.newlineSequences, 3.30 regions, 3.57 replacement)
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json (region charOffset/charLength defaults)
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { applyReplacement } from '../dist/replacements.cjs';
import type { ReplacementOutcome } from '../dist/replacements.cjs';
import {
  asRecord,
  isArrayOf,
  isBoolean,
  isEither,
  isNumber,
  isOneOf,
  isOptional,
  isRecordOf,
  isShape,
  isString,
  isUnknown,
  expectType,
  readJson,
} from './support/runtime-types.mts';

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'replacements');

type OutcomeKind = ReplacementOutcome['kind'];

/** Exact result fields per outcome kind; anything else is outside this module's contract. */
const RESULT_KEYS: Record<OutcomeKind, string[]> = {
  replacement: [
    'editedText',
    'endLine',
    'endsWithNewline',
    'kind',
    'originalText',
    'replacementLines',
    'replacementText',
    'startLine',
  ],
  unanchored: ['editedText', 'kind', 'message', 'reason'],
  invalid: ['kind', 'message', 'reason'],
  unsupported: ['kind', 'message', 'reason'],
};

const WRONG_FIELDS = {
  wrongEditedText: 'editedText',
  wrongReplacementText: 'replacementText',
  wrongReplacementLines: 'replacementLines',
} as const;

type WrongGroup = keyof typeof WRONG_FIELDS;

/** WRONG_FIELDS as typed [group, field] pairs. */
const WRONG_FIELD_ENTRIES = Object.keys(WRONG_FIELDS)
  .filter((group): group is WrongGroup => Object.hasOwn(WRONG_FIELDS, group))
  .map((group) => [group, WRONG_FIELDS[group]] as const);

/** Authored expectation of an applied replacement. */
const isExpectedReplacement = isShape({
  kind: isOneOf('replacement'),
  editedText: isString,
  startLine: isNumber,
  endLine: isNumber,
  originalText: isString,
  replacementText: isString,
  replacementLines: isArrayOf(isString),
  endsWithNewline: isShape({ original: isBoolean, edited: isBoolean }),
});

/** Authored expectation of a diagnostic (the editedText of an unanchored edit included). */
const isExpectedDiagnostic = isShape({
  kind: isOneOf('unanchored', 'invalid', 'unsupported'),
  reason: isString,
  editedText: isOptional(isString),
});

/** One authored case: the request (deliberately unchecked: invalid requests are cases too) and its expectation. */
const isCase = isShape({
  name: isString,
  input: isShape({ sourceText: isUnknown, columnKind: isOptional(isString), charOffsetKind: isOptional(isString) }),
  expected: isEither(isExpectedReplacement, isExpectedDiagnostic),
  wrongEditedText: isOptional(isRecordOf(isUnknown)),
  wrongReplacementText: isOptional(isRecordOf(isUnknown)),
  wrongReplacementLines: isOptional(isRecordOf(isUnknown)),
});

const isFixture = isShape({
  cases: isOptional(isArrayOf(isCase)),
  groups: isOptional(isArrayOf(isShape({ name: isString, members: isArrayOf(isCase) }))),
});

/** Every fixture file, each contributing standalone cases and/or groups of adjacent alternatives. */
function loadFixtures() {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((file) => ({ file, ...expectType(readJson(path.join(FIXTURE_DIR, file)), isFixture, `replacement fixture ${file}`) }));
}

const fixtures = loadFixtures();

/** Every case, standalone or group member, labelled by its fixture file. */
const allCases = fixtures.flatMap(({ file, cases = [], groups = [] }) => [
  ...cases.map((c) => ({ file, ...c })),
  ...groups.flatMap((g) => g.members.map((m) => ({ file, ...m, name: `${g.name}: ${m.name}` }))),
]);

/**
 * Physical lines of a text under the default SARIF newline sequences (CRLF,
 * LF), each string keeping its own terminator; a lone CR is line content and
 * a terminal newline yields no extra line.
 */
function physicalLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Line-splice oracle: the source with whole lines startLine..endLine (each
 * with its terminator) replaced by replacementText. Independent of SARIF
 * region arithmetic.
 */
function spliceLines(sourceText: string, startLine: number, endLine: number, replacementText: string): string {
  const lines = physicalLines(sourceText);
  return lines.slice(0, startLine - 1).join('') + replacementText + lines.slice(endLine).join('');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Calls the module with an immutable deep copy so any input mutation fails loudly. */
function apply(input: unknown): ReplacementOutcome {
  return applyReplacement(deepFreeze(structuredClone(input)));
}

/** `value[name]` of a plain object (outcomes and fixture values), whatever its outcome kind. */
function field(value: object, name: string): unknown {
  return asRecord(value)[name];
}

/** items[index] of parallel arrays, which always exists. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError(`no item at index ${String(index)}`);
  return item;
}

type Case = (typeof allCases)[number];
type ReplacementCase = Case & { expected: Extract<Case['expected'], { kind: 'replacement' }> };

const isReplacementCase = (c: Case): c is ReplacementCase => c.expected.kind === 'replacement';

function assertOutcome(actual: ReplacementOutcome, expected: Case['expected']): void {
  assert.equal(actual.kind, expected.kind, `outcome kind (reason: ${'reason' in actual ? actual.reason : 'none'})`);
  assert.deepEqual(Object.keys(actual).sort(), RESULT_KEYS[expected.kind]);
  if (expected.kind === 'replacement') {
    assert.deepEqual(actual, expected);
    return;
  }
  assert.equal(field(actual, 'reason'), expected.reason);
  const message = field(actual, 'message');
  assert.equal(typeof message, 'string');
  assert.ok(String(message).trim().length > 0, 'diagnostic message is actionable text');
  if (expected.kind === 'unanchored') {
    assert.equal(field(actual, 'editedText'), expected.editedText);
  }
}

describe('fixture integrity (checks authored expectations without the module under test)', () => {
  test('physicalLines oracle splits lines as the contract defines them', () => {
    assert.deepEqual(physicalLines(''), []);
    assert.deepEqual(physicalLines('a'), ['a']);
    assert.deepEqual(physicalLines('a\n'), ['a\n']);
    assert.deepEqual(physicalLines('a\r\n\nb'), ['a\r\n', '\n', 'b']);
    assert.deepEqual(physicalLines('a\rb\r'), ['a\rb\r']);
  });

  for (const c of allCases) {
    test(`${c.file}: ${c.name}`, () => {
      const { expected, input } = c;
      assert.ok(Object.hasOwn(RESULT_KEYS, expected.kind), 'known outcome kind');
      if (expected.kind === 'replacement') {
        const sourceText = expectType(input.sourceText, isString, 'the source text of a valid edit');
        const lines = physicalLines(sourceText);
        assert.ok(1 <= expected.startLine && expected.startLine <= expected.endLine);
        assert.ok(expected.endLine <= lines.length, 'candidate lines exist in the original source');
        assert.equal(
          expected.originalText,
          lines.slice(expected.startLine - 1, expected.endLine).join(''),
          'authored originalText is exactly the candidate source lines with their terminators',
        );
        assert.equal(
          spliceLines(sourceText, expected.startLine, expected.endLine, expected.replacementText),
          expected.editedText,
          'authored replacement on the authored lines reproduces the authored edited source',
        );
        assert.deepEqual(
          expected.replacementLines,
          physicalLines(expected.replacementText),
          'authored line sequence is exactly the authored replacement text',
        );
        assert.deepEqual(expected.endsWithNewline, {
          original: sourceText.endsWith('\n'),
          edited: expected.editedText.endsWith('\n'),
        });
      }
      if (expected.kind === 'replacement' || expected.kind === 'unanchored') {
        assert.equal(typeof expected.editedText, 'string');
        assert.notEqual(expected.editedText, input.sourceText, 'every valid fixture edit changes the file');
      }
      if (expected.kind === 'unanchored') {
        assert.equal(input.sourceText, '', 'only an empty source lacks an anchor line');
      }
      for (const [group, name] of WRONG_FIELD_ENTRIES) {
        for (const [defect, wrong] of Object.entries(c[group] ?? {})) {
          assert.notDeepEqual(wrong, field(expected, name), `negative control "${defect}" is distinguishable`);
        }
      }
    });
  }
});

describe('applyReplacement', () => {
  for (const c of allCases) {
    test(`${c.file}: ${c.name}`, () => {
      const actual = apply(c.input);
      assertOutcome(actual, c.expected);
      for (const [group, name] of WRONG_FIELD_ENTRIES) {
        for (const [defect, wrong] of Object.entries(c[group] ?? {})) {
          assert.notDeepEqual(field(actual, name), wrong, `exhibits defect "${defect}"`);
        }
      }
    });
  }

  test('repeated calls with equal input yield equal, independent results', () => {
    const input = allCases.find((c) => c.expected.kind === 'replacement' && c.expected.replacementLines.length > 1)?.input;
    const first = apply(input);
    const second = apply(input);
    assert.deepEqual(second, first);
    assert.notEqual(field(second, 'replacementLines'), field(first, 'replacementLines'), 'no shared mutable result state');
  });
});

describe('adjacent replacements are independent alternatives', () => {
  for (const { file, groups = [] } of fixtures) {
    for (const group of groups) {
      test(`${file}: ${group.name} yields the same outcomes in any evaluation order`, () => {
        const forward = group.members.map((m) => apply(m.input));
        const backward = [...group.members].reverse().map((m) => apply(m.input)).reverse();
        assert.deepEqual(backward, forward);
        group.members.forEach((m, i) => {
          assertOutcome(at(forward, i), m.expected);
        });
      });
    }
  }
});

test('fixtures cover every outcome kind, both column kinds, and both offset kinds', () => {
  const kinds = new Set(allCases.map((c) => c.expected.kind));
  assert.deepEqual([...kinds].sort(), ['invalid', 'replacement', 'unanchored', 'unsupported']);
  const replacements = allCases.filter(isReplacementCase);
  const columnKinds = new Set(replacements.map((c) => c.input.columnKind));
  assert.deepEqual([...columnKinds].sort(), ['unicodeCodePoints', 'utf16CodeUnits']);
  const offsetKinds = new Set(replacements.map((c) => c.input.charOffsetKind).filter(Boolean));
  assert.deepEqual([...offsetKinds].sort(), ['unicodeCodePoints', 'utf16CodeUnits']);
  assert.ok(replacements.some((c) => c.expected.replacementLines.length === 0), 'a zero-line replacement');
  assert.ok(
    replacements.some((c) => c.expected.replacementLines.length === 1 && c.expected.replacementLines[0] === '\n'),
    'a one-blank-line replacement',
  );
  assert.ok(
    replacements.some((c) => c.expected.endsWithNewline.original !== c.expected.endsWithNewline.edited),
    'a terminal-newline status change',
  );
});
