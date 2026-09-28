/**
 * Self-test of the shared runtime narrowing helpers (test/support/runtime-types.mts).
 *
 * Tests narrow `unknown` values with these helpers instead of type
 * assertions, so each helper must refuse every value outside its type (a
 * guard that accepted too much would silently weaken the assertions built on
 * it) and must accept the values tests really narrow.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  expectType,
  isArray,
  isArrayOf,
  isBoolean,
  isEither,
  isNull,
  isNumber,
  isOneOf,
  isOptional,
  isRecord,
  isRecordOf,
  isShape,
  isString,
  isUndefined,
  isUnknown,
  parseJson,
  readJson,
} from './support/runtime-types.mts';

describe('runtime narrowing helpers', () => {
  test('primitive guards accept exactly their type', () => {
    assert.deepEqual(
      ['', 0, false, null, undefined, {}, []].map((v) => [isString(v), isNumber(v), isBoolean(v), isNull(v), isUndefined(v)]),
      [
        [true, false, false, false, false],
        [false, true, false, false, false],
        [false, false, true, false, false],
        [false, false, false, true, false],
        [false, false, false, false, true],
        [false, false, false, false, false],
        [false, false, false, false, false],
      ],
    );
    assert.equal(isUnknown(Symbol('any')), true);
  });

  test('isRecord accepts plain objects only', () => {
    assert.equal(isRecord({ a: 1 }), true);
    assert.equal(isRecord(Object.create(null)), true);
    assert.equal(isRecord(parseJson('{"a":[1]}')), true);
    for (const refused of [null, [], 'x', 1, new Error('e'), new Map(), Buffer.from('x'), Object(10n), { [Symbol('k')]: 1 }]) {
      assert.equal(isRecord(refused), false, Object.prototype.toString.call(refused));
    }
  });

  test('composite guards check every element and property', () => {
    assert.equal(isArray([1, 'a']), true);
    assert.equal(isArray({ length: 0 }), false);
    assert.equal(isArrayOf(isString)(['a', 'b']), true);
    assert.equal(isArrayOf(isString)(['a', 1]), false);
    assert.equal(isRecordOf(isNumber)({ a: 1, b: 2 }), true);
    assert.equal(isRecordOf(isNumber)({ a: 1, b: '2' }), false);
    assert.equal(isOneOf('ok', 'down')('ok'), true);
    assert.equal(isOneOf('ok', 'down')('up'), false);
    assert.equal(isEither(isString, isNull)(null), true);
    assert.equal(isEither(isString, isNull)(0), false);
    assert.equal(isOptional(isString)(undefined), true);
    assert.equal(isOptional(isString)(null), false);
  });

  test('isShape checks the listed properties, allows others and narrows the value itself', () => {
    const isPoint = isShape({ x: isNumber, y: isNumber, label: isOptional(isString) });
    const value: unknown = { x: 1, y: 2, extra: true };
    assert.equal(isPoint(value), true);
    assert.equal(isPoint({ x: 1 }), false);
    assert.equal(isPoint({ x: 1, y: 2, label: 3 }), false);
    assert.equal(isPoint([1, 2]), false);
    assert.equal(expectType(value, isPoint, 'a point'), value);
  });

  test('expectations return the narrowed value or fail naming what was expected', () => {
    assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
    assert.deepEqual(asArray([1]), [1]);
    assert.equal(asString('s'), 's');
    assert.equal(asNumber(2), 2);
    assert.equal(asBoolean(false), false);
    assert.deepEqual(asStringArray(['a']), ['a']);
    assert.throws(() => asString(5, 'the review body'), {
      name: 'AssertionError',
      message: 'expected the review body, got 5',
    });
    assert.throws(() => asRecord([1]), { name: 'AssertionError', message: 'expected an object, got [1]' });
    assert.throws(() => asStringArray(['a', 2]), { name: 'AssertionError', message: 'expected an array of strings, got ["a",2]' });
    assert.throws(() => asNumber(undefined), { name: 'AssertionError', message: 'expected a number, got undefined' });
  });

  test('parseJson and readJson return the parsed value and propagate syntax errors', () => {
    assert.deepEqual(parseJson('[1,{"a":null}]'), [1, { a: null }]);
    assert.throws(() => parseJson('{'), SyntaxError);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-types-'));
    const file = path.join(dir, 'x.json');
    fs.writeFileSync(file, '{"k":"v"}');
    assert.deepEqual(readJson(file), { k: 'v' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
