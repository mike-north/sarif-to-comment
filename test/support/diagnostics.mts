/**
 * Test support for structured diagnostics: the documented catalog and schema
 * (docs/diagnostics.md, docs/diagnostic.v1.schema.json), read as the
 * specification that tests assert against, and assertions every diagnostics
 * test shares.
 *
 * Expected titles, severities and remedies come from the documented catalog,
 * never from the implementation's own catalog, so a test that reads them here
 * checks the implementation against the documentation.
 *
 * @see https://json-schema.org/draft-07/json-schema-release-notes
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import AjvModule from 'ajv';

import { asArray, asRecord, asString, readJson } from './runtime-types.mts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** docs/diagnostics.md, the specification of the model, the formats and the catalog. */
export const DIAGNOSTICS_DOC = fs.readFileSync(path.join(ROOT, 'docs', 'diagnostics.md'), 'utf8');

/** The published JSON Schema of a diagnostic and a problem, version 1. */
export const DIAGNOSTIC_SCHEMA = asRecord(readJson(path.join(ROOT, 'docs', 'diagnostic.v1.schema.json')), 'the diagnostic schema');

/** A severity of the model. */
export type Severity = 'error' | 'warning' | 'note';

/** One documented catalog entry. */
export interface ICatalogEntry {
  readonly code: string;
  readonly severity: Severity;
  readonly title: string;
  readonly remedies: readonly string[];
}

function isSeverity(value: string): value is Severity {
  return value === 'error' || value === 'warning' || value === 'note';
}

/** Every row of the documented code catalog, in document order. */
export function documentedCatalog(doc: string = DIAGNOSTICS_DOC): ICatalogEntry[] {
  const start = doc.indexOf('\n## Code catalog\n');
  assert.ok(start !== -1, 'docs/diagnostics.md has a code catalog');
  const end = doc.indexOf('\n## ', start + 1);
  const section = doc.slice(start, end === -1 ? undefined : end);
  const entries: ICatalogEntry[] = [];
  for (const line of section.split('\n')) {
    const match = /^\| `([a-z0-9-]+)` \| (\w+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/.exec(line);
    if (!match) continue;
    const [, code = '', severity = '', title = '', , remedies = ''] = match;
    assert.ok(isSeverity(severity), `${code}: severity ${severity}`);
    entries.push({ code, severity, title: title.trim(), remedies: remedies.trim() === '—' ? [] : remedies.trim().split('<br>') });
  }
  return entries;
}

/** The documented catalog by code. */
export const CATALOG: ReadonlyMap<string, ICatalogEntry> = new Map(documentedCatalog().map((e) => [e.code, e]));

/** The documented entry of `code`; fails when the code is not documented. */
export function catalogEntry(code: string): ICatalogEntry {
  const entry = CATALOG.get(code);
  assert.ok(entry !== undefined, `code ${code} is documented in docs/diagnostics.md`);
  return entry;
}

// ---------------------------------------------------------------------------
// Schema validation

interface IValidator {
  (value: unknown): boolean;
  errors?: unknown;
}

const Ajv = AjvModule.default;
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(DIAGNOSTIC_SCHEMA);
const SCHEMA_ID = asString(DIAGNOSTIC_SCHEMA['$id'], 'the schema $id');

function validator(definition: 'diagnostic' | 'problem'): IValidator {
  const validate = ajv.getSchema(`${SCHEMA_ID}#/definitions/${definition}`);
  assert.ok(validate !== undefined, `the schema defines ${definition}`);
  return validate;
}

const validateDiagnostic = validator('diagnostic');
const validateProblem = validator('problem');

/** Whether `value` is a version 1 diagnostic. */
export function isSchemaDiagnostic(value: unknown): boolean {
  return validateDiagnostic(value);
}

/** Whether `value` is a version 1 problem. */
export function isSchemaProblem(value: unknown): boolean {
  return validateProblem(value);
}

// ---------------------------------------------------------------------------
// Shared assertions

const RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, note: 2 };

/** What a test expects of one diagnostic, beyond what the catalog fixes. */
export interface IExpectedDiagnostic {
  readonly code: string;
  readonly location?: Readonly<Record<string, unknown>>;
  readonly subject?: string;
  /** A pattern the message must match. */
  readonly message?: RegExp;
}

/**
 * Asserts that `value` is an outcome's `diagnostics` array: schema-valid
 * entries, ordered errors, warnings, notes, whose codes are exactly `expected`
 * in order, each with the documented severity, title and remedies.
 */
export function assertDiagnostics(value: unknown, expected: readonly IExpectedDiagnostic[], what = 'diagnostics'): Record<string, unknown>[] {
  const list = asArray(value, what).map((d) => asRecord(d, `an entry of ${what}`));
  for (const d of list) assert.ok(isSchemaDiagnostic(d), `${what}: schema-valid ${JSON.stringify(d)}: ${JSON.stringify(validateDiagnostic.errors)}`);
  assert.deepEqual(list.map((d) => d['code']), expected.map((e) => e.code), `${what}: the codes, in order`);
  const ranks = list.map((d) => RANK[catalogEntry(asString(d['code'])).severity]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${what}: errors, then warnings, then notes`);
  for (const [i, d] of list.entries()) {
    const want = expected[i];
    if (want === undefined) continue;
    const entry = catalogEntry(want.code);
    assert.equal(d['severity'], entry.severity, `${want.code}: the documented severity`);
    assert.equal(d['title'], entry.title, `${want.code}: the documented title`);
    if (entry.remedies.length === 0) assert.equal(Object.hasOwn(d, 'remedies'), false, `${want.code}: no remedies`);
    else assert.deepEqual(d['remedies'], entry.remedies, `${want.code}: the documented remedies`);
    if (want.location === undefined) assert.equal(Object.hasOwn(d, 'location'), false, `${want.code}: no location`);
    else assert.deepEqual(d['location'], want.location, `${want.code}: its location`);
    if (want.subject === undefined) assert.equal(Object.hasOwn(d, 'subject'), false, `${want.code}: no subject`);
    else assert.equal(d['subject'], want.subject, `${want.code}: its subject`);
    if (want.message !== undefined) assert.match(asString(d['message']), want.message, `${want.code}: its message`);
    // The model's key order: severity, code, title, message, then the optional fields.
    const keys = Object.keys(d);
    assert.deepEqual(keys, ['severity', 'code', 'title', 'message', 'location', 'subject', 'remedies'].filter((k) => keys.includes(k)), `${want.code}: key order`);
  }
  return list;
}

/**
 * Asserts that a `problems` array kept its 0.2.x entries exactly (the same
 * `message`, `pointer` and `path` values, as the first keys, in the same
 * order) and that each entry gained the diagnostic fields of the matching
 * error diagnostic.
 */
export function assertProblemsExtend(problems: unknown, before: readonly Readonly<Record<string, unknown>>[], diagnostics: unknown): void {
  const list = asArray(problems, 'problems').map((p) => asRecord(p, 'a problem'));
  const errors = asArray(diagnostics, 'diagnostics').map((d) => asRecord(d)).filter((d) => d['severity'] === 'error');
  assert.equal(list.length, before.length, 'the same number of problems');
  assert.equal(errors.length, list.length, 'every problem is an error diagnostic, and every error diagnostic a problem');
  for (const [i, problem] of list.entries()) {
    const legacy = before[i] ?? {};
    const legacyKeys = Object.keys(legacy);
    assert.deepEqual(Object.keys(problem).slice(0, legacyKeys.length), legacyKeys, 'the 0.2.x fields come first, in their order');
    for (const key of legacyKeys) assert.deepEqual(problem[key], legacy[key], `problem ${String(i)}: ${key} is unchanged`);
    assert.ok(isSchemaProblem(problem), `problem ${String(i)} is schema-valid: ${JSON.stringify(validateProblem.errors)}`);
    const diagnostic = errors[i] ?? {};
    for (const key of ['severity', 'code', 'title', 'message', 'location', 'subject', 'remedies']) {
      assert.deepEqual(problem[key], diagnostic[key], `problem ${String(i)}: ${key} matches its diagnostic`);
    }
  }
}
