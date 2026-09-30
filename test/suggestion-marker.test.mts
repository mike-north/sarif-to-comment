/**
 * The suggestion pull request marker (docs/suggestion-pr-convention.md §7):
 * its canonical form, and its recognition for cleanup
 * (docs/suggestion-cleanup-contract.md §2.5).
 *
 * Every marker line below is written out by hand from the convention's
 * template, not produced by the formatter under test.
 *
 * @see https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { findSuggestionMarker, formatSuggestionMarker } from '../dist/suggestion-marker.cjs';

const ID = '5f72b5f4-8dd1-462a-948b-71b0767ecafe';
const BATCH = 'cc855bf5-b55e-4080-83fa-6938594d9608';
const COMMIT = '89bf101d454c10d98df84e504c05494e9627375b';
const LINE = `<!-- suggestion-pr {"version":1,"original":{"owner":"mike-north","repo":"doc-linter","pullNumber":36},"reviewedCommit":"${COMMIT}","id":"${ID}","batch":"${BATCH}"} -->`;
const FIELDS = { id: ID, batch: BATCH, owner: 'mike-north', repo: 'doc-linter', pullNumber: 36, reviewedCommit: COMMIT };
const BODY = `Suggested in a review of #36 at commit ${COMMIT}.\n\nMerging this pull request applies this change:\n\n- …\n\n${LINE}`;

describe('formatSuggestionMarker', () => {
  test('control: the hand-written line is exactly what the publisher formats (convention §7 member order, no whitespace)', () => {
    assert.equal(formatSuggestionMarker(FIELDS), LINE);
  });

  test('another tool\'s identifiers in the convention\'s alphabet are formatted the same way', () => {
    const fields = { ...FIELDS, id: 'Z9_suggestion-01', batch: 'review_2026-09-29' };
    assert.equal(
      formatSuggestionMarker(fields),
      `<!-- suggestion-pr {"version":1,"original":{"owner":"mike-north","repo":"doc-linter","pullNumber":36},"reviewedCommit":"${COMMIT}","id":"Z9_suggestion-01","batch":"review_2026-09-29"} -->`,
    );
  });
});

describe('findSuggestionMarker', () => {
  test('a body ending with the canonical marker yields its fields and line', () => {
    assert.deepEqual(findSuggestionMarker(BODY), { kind: 'marker', line: LINE, fields: FIELDS });
  });

  test('CRLF bodies (as GitHub may store an edited body) are read line by line', () => {
    assert.deepEqual(findSuggestionMarker(BODY.replace(/\n/g, '\r\n')), { kind: 'marker', line: LINE, fields: FIELDS });
  });

  test('a person may edit the text around the marker or add text after it (convention §7)', () => {
    const edited = `Reworded by a person.\n\n${LINE}\n\nThanks!`;
    assert.deepEqual(findSuggestionMarker(edited), { kind: 'marker', line: LINE, fields: FIELDS });
  });

  test('a conforming marker from another tool is recognized: identifiers need not be UUIDs', () => {
    const line = `<!-- suggestion-pr {"version":1,"original":{"owner":"octo","repo":"widgets","pullNumber":7},"reviewedCommit":"${COMMIT}","id":"A1","batch":"b"} -->`;
    assert.deepEqual(findSuggestionMarker(`Other tool.\n\n${line}`), {
      kind: 'marker', line, fields: { id: 'A1', batch: 'b', owner: 'octo', repo: 'widgets', pullNumber: 7, reviewedCommit: COMMIT },
    });
    const longest = 'a'.repeat(64);
    const edge = line.replace('"id":"A1"', `"id":"${longest}"`).replace('"batch":"b"', '"batch":"x_-y"');
    assert.equal(findSuggestionMarker(edge).kind, 'marker');
  });

  test('no marker: an empty (null) body, an ordinary body, and a mention of the prefix inside a line', () => {
    assert.deepEqual(findSuggestionMarker(null), { kind: 'none' });
    assert.deepEqual(findSuggestionMarker(''), { kind: 'none' });
    assert.deepEqual(findSuggestionMarker('Fixes the typo in #36.'), { kind: 'none' });
    assert.deepEqual(findSuggestionMarker(`Quoted: ${LINE}`), { kind: 'none' });
  });

  test('regression: the unreleased tool-branded marker form is not the convention\'s and is not recognized', () => {
    const branded = `<!-- sarif-to-comment:suggestion {"id":"${ID}","original":{"owner":"mike-north","pullNumber":36,"repo":"doc-linter"},"publication":"${BATCH}","reviewedCommit":"${COMMIT}","version":1} -->`;
    assert.deepEqual(findSuggestionMarker(`Body.\n\n${branded}`), { kind: 'none' });
  });

  test('two marker lines (for example a quoted marker) are never guessed at', () => {
    assert.deepEqual(findSuggestionMarker(`${LINE}\n${LINE}`), { kind: 'several' });
    const other = LINE.replace(ID, '6e2f1c1b-2f3a-4b5c-8d6e-7f8091a2b3c4');
    assert.deepEqual(findSuggestionMarker(`${BODY}\n${other}`), { kind: 'several' });
  });

  const malformed: readonly (readonly [string, string])[] = [
    ['whitespace inside the JSON', LINE.replace('"version":1', '"version": 1')],
    ['sorted instead of canonical member order', `<!-- suggestion-pr {"batch":"${BATCH}","id":"${ID}","original":{"owner":"mike-north","pullNumber":36,"repo":"doc-linter"},"reviewedCommit":"${COMMIT}","version":1} -->`],
    ['original members out of order', LINE.replace('"owner":"mike-north","repo":"doc-linter","pullNumber":36', '"owner":"mike-north","pullNumber":36,"repo":"doc-linter"')],
    ['an extra key', LINE.replace(`"batch":"${BATCH}"}`, `"batch":"${BATCH}","extra":true}`)],
    ['another version', LINE.replace('"version":1', '"version":2')],
    ['a missing batch', LINE.replace(`,"batch":"${BATCH}"`, '')],
    ['the old publication member instead of batch', LINE.replace('"batch"', '"publication"')],
    ['an id with a slash', LINE.replace(ID, 'a/b')],
    ['an id with a dot', LINE.replace(ID, 'a.b')],
    ['an id beginning with a hyphen', LINE.replace(ID, '-abc')],
    ['an id ending with an underscore', LINE.replace(ID, 'abc_')],
    ['an id of 65 characters', LINE.replace(ID, 'a'.repeat(65))],
    ['an empty batch', LINE.replace(`"batch":"${BATCH}"`, '"batch":""')],
    ['a batch that is a number', LINE.replace(`"batch":"${BATCH}"`, '"batch":7')],
    ['an abbreviated commit', LINE.replace(COMMIT, COMMIT.slice(0, 12))],
    ['an uppercase commit', LINE.replace(COMMIT, COMMIT.toUpperCase())],
    ['a pull number that is a string', LINE.replace('"pullNumber":36', '"pullNumber":"36"')],
    ['a pull number of zero', LINE.replace('"pullNumber":36', '"pullNumber":0')],
    ['an owner that is not a GitHub name', LINE.replace('"owner":"mike-north"', '"owner":"mike north"')],
    ['a repository named ..', LINE.replace('"repo":"doc-linter"', '"repo":".."')],
    ['an escaped character that decodes to the same value', LINE.replace('"owner":"mike-north"', '"owner":"mike\\u002dnorth"')],
    ['JSON that does not parse', LINE.replace(`"batch":"${BATCH}"}`, `"batch":"${BATCH}"`)],
    ['no closing -->', LINE.replace(' -->', '')],
    ['trailing text after -->', `${LINE} tampered`],
  ];
  for (const [what, line] of malformed) {
    test(`a non-canonical marker is refused: ${what}`, () => {
      assert.notEqual(line, LINE, 'the variant differs from the canonical line');
      assert.deepEqual(findSuggestionMarker(`Body.\n\n${line}`), { kind: 'malformed' });
    });
  }
});
