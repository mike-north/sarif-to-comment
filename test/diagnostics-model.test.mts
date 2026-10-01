/**
 * The structured diagnostic model (docs/diagnostics.md, D45): the code
 * catalog, the constructor every module uses, ordering, and the version 1
 * JSON Schema.
 *
 * Expected values come from docs/diagnostics.md and
 * docs/diagnostic.v1.schema.json, the specification; the implementation's
 * catalog must agree with the documented one, code by code.
 *
 * @see https://json-schema.org/draft-07/json-schema-release-notes
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DIAGNOSTIC_CATALOG } from '../dist/diagnostic-catalog.cjs';
import { createDiagnostic, orderDiagnostics } from '../dist/diagnostics.cjs';
import type { IDiagnostic } from '../dist/diagnostics.cjs';
import { CATALOG, DIAGNOSTIC_SCHEMA, DIAGNOSTICS_DOC, documentedCatalog, isSchemaDiagnostic, isSchemaProblem } from './support/diagnostics.mts';

describe('the code catalog (docs/diagnostics.md "Code catalog")', () => {
  test('documents every code once, as stable kebab-case, with a one-line title', () => {
    const entries = documentedCatalog();
    assert.ok(entries.length >= 100, `the catalog lists the codes (${String(entries.length)})`);
    assert.equal(new Set(entries.map((e) => e.code)).size, entries.length, 'no code is listed twice');
    for (const e of entries) {
      assert.match(e.code, /^[a-z0-9]+(-[a-z0-9]+)*$/, e.code);
      assert.doesNotMatch(e.title, /\n|\.$/, `${e.code}: one plain line without a final period`);
    }
  });

  test('the implementation catalog agrees with the documented one on every code, severity, title and remedy', () => {
    const implemented = Object.entries(DIAGNOSTIC_CATALOG).map(([code, e]) => ({ code, severity: e.severity, title: e.title, remedies: [...e.remedies] }));
    assert.deepEqual(
      implemented.sort((a, b) => a.code.localeCompare(b.code)),
      documentedCatalog().map((e) => ({ ...e, remedies: [...e.remedies] })).sort((a, b) => a.code.localeCompare(b.code)),
    );
  });

  test('the codes the issue names are catalog entries, and the renamed codes are gone', () => {
    // Issue #38 names these internal codes as becoming catalog entries.
    for (const code of ['pending-review-exists']) {
      assert.ok(CATALOG.has(code), code);
    }
    // The delivery policy replaced the native-suggestion eligibility codes 0.2.1 reported with its own
    // (docs/delivery-policy-contract.md §10.3); the reviewed diff retired `suggestion-historical-unsupported`
    // (specification R13.1); fixes with several changes and alternative fixes are now delivered.
    // docs/diagnostics.md "Retired codes": reported by 0.2.1, and no longer reported.
    for (const code of ['delivery-unavailable', 'delivery-fallback', 'delivery-configuration-invalid', 'companion-options-unused']) assert.ok(CATALOG.has(code), code);
    const retiredSince021 = [
      'suggestion-not-inline', 'suggestion-fence-unverified', 'suggestion-blank-only-unverified', 'suggestion-crlf-unverified',
      'suggestion-final-newline-unverified', 'suggestion-historical-unsupported', 'fix-multiple-files-unsupported',
      'fix-multiple-replacements-unsupported', 'fix-alternatives-unsupported',
    ];
    for (const code of retiredSince021) {
      assert.equal(CATALOG.has(code), false, `${code} is retired`);
      assert.ok(DIAGNOSTICS_DOC.includes(`| \`${code}\` | `), `the retired ${code} is listed under "Retired codes"`);
    }
    // Codes that only unreleased builds reported are gone too; the shipped catalog does not list them.
    for (const code of [
      'suggestion-pr-fallback', 'suggestion-group-pr-unavailable', 'suggestion-group-requires-suggestion-prs', 'fix-changes-require-suggestion-prs',
      'suggestion-reviewed-commit-not-head', 'suggestion-pr-not-reapplied',
    ]) {
      assert.equal(CATALOG.has(code), false, `${code} is not reported`);
    }
    // Specification R17: the reviewed commit's association with the pull request.
    assert.equal(CATALOG.get('reviewed-commit-not-in-pull-request')?.severity, 'error');
    assert.equal(CATALOG.get('reviewed-commit-association-unknown')?.severity, 'note');
    // docs/diagnostics.md "Renamed codes": the codes 0.2.1 named in its Markdown that were renamed.
    const renames: readonly (readonly [string, string])[] = [
      ['inline-unavailable', 'inline-placement-unavailable'],
      ['invocation-failed', 'tool-invocation-failed'],
      ['tool-notification-error', 'tool-reported-errors'],
      ['repository-mismatch', 'provenance-repository-mismatch'],
      ['provenance-conflict', 'provenance-revision-conflict'],
    ];
    for (const [before, after] of renames) {
      assert.equal(CATALOG.has(before), false, `${before} was renamed`);
      assert.ok(CATALOG.has(after), after);
      assert.ok(DIAGNOSTICS_DOC.includes(`| \`${before}\` | \`${after}\` |`), `the rename ${before} -> ${after} is listed`);
    }
  });

  test('each severity is used, and warnings and notes the model calls out have that severity', () => {
    assert.equal(CATALOG.get('delivery-fallback')?.severity, 'warning');
    assert.equal(CATALOG.get('delivery-unavailable')?.severity, 'error');
    assert.equal(CATALOG.get('companion-options-unused')?.severity, 'note');
    assert.equal(CATALOG.get('finding-partially-overlaps-change')?.severity, 'warning');
    assert.equal(CATALOG.get('suggestion-branch-moved')?.severity, 'note');
    assert.equal(CATALOG.get('usage-error')?.severity, 'error');
  });
});

describe('createDiagnostic', () => {
  test('takes severity, title and remedies from the catalog, in the model\'s key order', () => {
    const d = createDiagnostic('sarif-schema-invalid', 'The document is broken.', { location: { pointer: '/runs/0' } });
    assert.deepEqual(d, {
      severity: 'error',
      code: 'sarif-schema-invalid',
      title: 'The document is not valid SARIF 2.1.0',
      message: 'The document is broken.',
      location: { pointer: '/runs/0' },
      remedies: ['Correct the document so that it conforms to the SARIF 2.1.0 schema.'],
    });
    assert.deepEqual(Object.keys(d), ['severity', 'code', 'title', 'message', 'location', 'remedies']);
    assert.ok(isSchemaDiagnostic(d));
  });

  test('omits remedies for a code without any, and location and subject when not given', () => {
    const d = createDiagnostic('taxa-uninterpreted', 'Taxa are kept.');
    assert.deepEqual(d, { severity: 'warning', code: 'taxa-uninterpreted', title: 'Taxonomy classifications are not shown', message: 'Taxa are kept.' });
    assert.ok(isSchemaDiagnostic(d));
  });

  test('places a subject after the location, and accepts remedies that replace the catalog\'s', () => {
    const d = createDiagnostic('suggestion-pr-cleanup-failed', 'Closing failed.', {
      location: { path: 'a.txt', startLine: 2, endLine: 3 },
      subject: 'acme/widgets#40',
      remedies: ['Try later.'],
    });
    assert.deepEqual(Object.keys(d), ['severity', 'code', 'title', 'message', 'location', 'subject', 'remedies']);
    assert.deepEqual(d.remedies, ['Try later.']);
    assert.ok(isSchemaDiagnostic(d));
  });

  test('an empty location is omitted rather than written as an empty object', () => {
    const d = createDiagnostic('usage-error', 'Wrong.', { location: {} });
    assert.equal(Object.hasOwn(d, 'location'), false);
  });
});

describe('orderDiagnostics', () => {
  const make = (code: 'usage-error' | 'taxa-uninterpreted' | 'suggestion-branch-moved' | 'approval-hold', message: string): IDiagnostic => createDiagnostic(code, message);

  test('orders errors, then warnings, then notes, keeping the order found within each severity', () => {
    const list = [
      make('suggestion-branch-moved', 'n1'),
      make('taxa-uninterpreted', 'w1'),
      make('usage-error', 'e1'),
      make('taxa-uninterpreted', 'w2'),
      make('approval-hold', 'e2'),
    ];
    assert.deepEqual(orderDiagnostics(list).map((d) => d.message), ['e1', 'e2', 'w1', 'w2', 'n1']);
    assert.deepEqual(list.map((d) => d.message), ['n1', 'w1', 'e1', 'w2', 'e2'], 'the input is not reordered in place');
  });

  test('an empty list stays empty', () => {
    assert.deepEqual(orderDiagnostics([]), []);
  });
});

describe('the version 1 JSON Schema (docs/diagnostic.v1.schema.json)', () => {
  const valid = { severity: 'note', code: 'suggestion-branch-moved', title: 'T', message: 'M' };

  test('is identified as version 1 and requires exactly the model\'s fields', () => {
    assert.equal(DIAGNOSTIC_SCHEMA['$id'], 'https://unpkg.com/sarif-to-comment/docs/diagnostic.v1.schema.json');
    assert.match(String(DIAGNOSTIC_SCHEMA['title']), /version 1/);
    assert.ok(isSchemaDiagnostic(valid));
    assert.ok(isSchemaDiagnostic({ ...valid, location: { pointer: '' }, subject: 'acme/widgets#1', remedies: ['Do it.'] }));
  });

  const invalid: readonly (readonly [string, unknown])[] = [
    ['an unknown severity', { ...valid, severity: 'fatal' }],
    ['a code that is not kebab-case', { ...valid, code: 'Not_Kebab' }],
    ['a title over several lines', { ...valid, title: 'one\ntwo' }],
    ['a missing message', { severity: 'note', code: 'x', title: 'T' }],
    ['an extra field', { ...valid, pointer: '/runs/0' }],
    ['an empty location', { ...valid, location: {} }],
    ['a line number below 1', { ...valid, location: { path: 'a', startLine: 0 } }],
    ['an unknown location field', { ...valid, location: { file: 'a' } }],
    ['an empty remedies list', { ...valid, remedies: [] }],
  ];
  for (const [what, value] of invalid) {
    test(`refuses ${what}`, () => {
      assert.equal(isSchemaDiagnostic(value), false);
    });
  }

  test('a problem is a diagnostic plus the flat pointer and path, without a required location', () => {
    const problem = { message: 'M', pointer: '/runs/0', path: 'a.txt', severity: 'error', code: 'x-y', title: 'T', location: { pointer: '/runs/0', path: 'a.txt' } };
    assert.ok(isSchemaProblem(problem));
    assert.equal(isSchemaDiagnostic(problem), false, 'the flat fields are not diagnostic fields');
    assert.equal(isSchemaProblem({ message: 'M', pointer: '/runs/0' }), false, 'a 0.2.x problem lacks the new required fields');
  });
});
