/**
 * Runtime-checked narrowing of `unknown` values for tests and fixtures.
 *
 * JSON.parse results, child-process output and fixture data are `unknown` to
 * the type checker. Instead of asserting a type (`as`), tests narrow such a
 * value with these helpers: each one checks the value at runtime and fails
 * with an AssertionError naming what was expected when it does not match, so
 * a narrowing is itself an assertion and can never hide a wrong shape.
 *
 * Two families:
 * - Guards (`isString`, `isRecord` (plain objects only), `isArrayOf(...)`, `isShape({...})`, ...)
 *   return a boolean and narrow in place; they compose into guards for whole
 *   documents and keep the original object (identity and key order).
 * - Expectations (`expectType`, `asRecord`, `asArray`, `asString`, ...)
 *   return the narrowed value or fail the test.
 */
import { AssertionError } from 'node:assert';
import * as fs from 'node:fs';

/** A type guard: checks at runtime that a value has type T. */
export type Guard<T> = (value: unknown) => value is T;

/** A plain object keyed by strings (see isRecord). */
export type UnknownRecord = Record<string, unknown>;

/** Guards for each property of an object shape. */
export type ShapeGuards = Readonly<Record<string, Guard<unknown>>>;

/** The object type a set of property guards describes. */
export type ShapeOf<S extends ShapeGuards> = { -readonly [K in keyof S]: S[K] extends Guard<infer T> ? T : never };

/** Parses JSON text; the result is `unknown` until narrowed. */
export function parseJson(text: string): unknown {
  // JSON.parse is typed `any`; binding it to `unknown` forces narrowing.
  const value: unknown = JSON.parse(text);
  return value;
}

/** Reads and parses a UTF-8 JSON file; the result is `unknown` until narrowed. */
export function readJson(file: string): unknown {
  return parseJson(fs.readFileSync(file, 'utf8'));
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function isNull(value: unknown): value is null {
  return value === null;
}

export function isUndefined(value: unknown): value is undefined {
  return value === undefined;
}

/** Accepts any value (for properties whose content a caller narrows later). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the parameter exists to be named by the type predicate; every value passes
export function isUnknown(_value: unknown): _value is unknown {
  return true;
}

/** Any array (elements unchecked). */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * A plain object keyed by strings: what JSON.parse produces for `{...}`.
 * Arrays, class instances (including Error, Map, Buffer), wrapped primitives
 * and objects with symbol keys are refused.
 */
export function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Object.getOwnPropertySymbols(value).length === 0;
}

/** An array whose every element passes `guard`. */
export function isArrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value: unknown): value is T[] => isArray(value) && value.every((item) => guard(item));
}

/** A record whose every own enumerable value passes `guard`. */
export function isRecordOf<T>(guard: Guard<T>): Guard<Record<string, T>> {
  return (value: unknown): value is Record<string, T> => isRecord(value) && Object.values(value).every((item) => guard(item));
}

/** One of the given literal values (compared with ===). */
export function isOneOf<const T extends readonly (string | number | boolean | null)[]>(...values: T): Guard<T[number]> {
  return (value: unknown): value is T[number] => values.some((allowed) => allowed === value);
}

/** Either guard. */
export function isEither<A, B>(a: Guard<A>, b: Guard<B>): Guard<A | B> {
  return (value: unknown): value is A | B => a(value) || b(value);
}

/** `guard`, or undefined (an absent property reads as undefined). */
export function isOptional<T>(guard: Guard<T>): Guard<T | undefined> {
  return isEither(guard, isUndefined);
}

/**
 * An object whose listed properties pass their guards. Other properties are
 * allowed and kept: the value itself is narrowed, never copied.
 */
export function isShape<S extends ShapeGuards>(shape: S): Guard<ShapeOf<S>> {
  return (value: unknown): value is ShapeOf<S> =>
    isRecord(value) && Object.entries(shape).every(([key, guard]) => guard(value[key]));
}

/** A short description of a value for failure messages. */
function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = Object.prototype.toString.call(value);
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Returns `value` narrowed by `guard`, or fails naming `what` was expected. */
export function expectType<T>(value: unknown, guard: Guard<T>, what: string): T {
  if (!guard(value)) {
    throw new AssertionError({ message: `expected ${what}, got ${describe(value)}`, actual: value, operator: 'expectType' });
  }
  return value;
}

export function asRecord(value: unknown, what = 'an object'): UnknownRecord {
  return expectType(value, isRecord, what);
}

export function asArray(value: unknown, what = 'an array'): unknown[] {
  return expectType(value, isArray, what);
}

export function asString(value: unknown, what = 'a string'): string {
  return expectType(value, isString, what);
}

export function asNumber(value: unknown, what = 'a number'): number {
  return expectType(value, isNumber, what);
}

export function asBoolean(value: unknown, what = 'a boolean'): boolean {
  return expectType(value, isBoolean, what);
}

export function asStringArray(value: unknown, what = 'an array of strings'): string[] {
  return expectType(value, isArrayOf(isString), what);
}
