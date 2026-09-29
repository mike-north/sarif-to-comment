/**
 * Recognition of the companion suggestion marker for cleanup
 * (docs/suggestion-cleanup-contract.md §2.5; the marker's form is
 * docs/companion-suggestion-pr-contract.md §2.7).
 *
 * Every marker line below is written out by hand from the contract's
 * template, not produced by the formatter under test. The live line is the
 * one GitHub stored on mike-north/doc-linter#38
 * (docs/companion-suggestion-pr-e2e-evidence.md).
 *
 * @see https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { findSuggestionMarker, formatSuggestionMarker } from '../dist/suggestion-marker.cjs';

const ID = '5f72b5f4-8dd1-462a-948b-71b0767ecafe';
const PUBLICATION = 'cc855bf5-b55e-4080-83fa-6938594d9608';
const COMMIT = '89bf101d454c10d98df84e504c05494e9627375b';
const LINE = `<!-- sarif-to-comment:suggestion {"id":"${ID}","original":{"owner":"mike-north","pullNumber":36,"repo":"doc-linter"},"publication":"${PUBLICATION}","reviewedCommit":"${COMMIT}","version":1} -->`;
const FIELDS = { id: ID, publication: PUBLICATION, owner: 'mike-north', repo: 'doc-linter', pullNumber: 36, reviewedCommit: COMMIT };
const BODY = `Suggested in a review of #36 at commit ${COMMIT}.\n\nMerging this pull request applies this change:\n\n- …\n\n${LINE}`;

describe('findSuggestionMarker', () => {
  test('control: the hand-written line is exactly what the publisher formats', () => {
    assert.equal(formatSuggestionMarker(FIELDS), LINE);
  });

  test('a body ending with the canonical marker yields its fields and line', () => {
    assert.deepEqual(findSuggestionMarker(BODY), { kind: 'marker', line: LINE, fields: FIELDS });
  });

  test('CRLF bodies (as GitHub may store an edited body) are read line by line', () => {
    assert.deepEqual(findSuggestionMarker(BODY.replace(/\n/g, '\r\n')), { kind: 'marker', line: LINE, fields: FIELDS });
  });

  test('a person may edit the text around the marker or add text after it (companion contract §2.10)', () => {
    const edited = `Reworded by a person.\n\n${LINE}\n\nThanks!`;
    assert.deepEqual(findSuggestionMarker(edited), { kind: 'marker', line: LINE, fields: FIELDS });
  });

  test('no marker: an empty (null) body, an ordinary body, and a mention of the prefix inside a line', () => {
    assert.deepEqual(findSuggestionMarker(null), { kind: 'none' });
    assert.deepEqual(findSuggestionMarker(''), { kind: 'none' });
    assert.deepEqual(findSuggestionMarker('Fixes the typo in #36.'), { kind: 'none' });
    assert.deepEqual(findSuggestionMarker(`Quoted: ${LINE}`), { kind: 'none' });
  });

  test('two marker lines (for example a quoted marker) are never guessed at', () => {
    assert.deepEqual(findSuggestionMarker(`${LINE}\n${LINE}`), { kind: 'several' });
    const other = LINE.replace(ID, '6e2f1c1b-2f3a-4b5c-8d6e-7f8091a2b3c4');
    assert.deepEqual(findSuggestionMarker(`${BODY}\n${other}`), { kind: 'several' });
  });

  const malformed: readonly (readonly [string, string])[] = [
    ['whitespace inside the JSON', LINE.replace('"version":1', '"version": 1')],
    ['keys out of canonical order', LINE.replace(`{"id":"${ID}","original"`, `{"original"`).replace(',"publication"', `,"id":"${ID}","publication"`)],
    ['an extra key', LINE.replace('"version":1}', '"version":1,"extra":true}')],
    ['another version', LINE.replace('"version":1', '"version":2')],
    ['a missing field', LINE.replace(`"reviewedCommit":"${COMMIT}",`, '')],
    ['an uppercase id', LINE.replace(ID, ID.toUpperCase())],
    ['an id that is not a v4 UUID', LINE.replace(ID, '5f72b5f4-8dd1-162a-948b-71b0767ecafe')],
    ['an abbreviated commit', LINE.replace(COMMIT, COMMIT.slice(0, 12))],
    ['a pull number that is a string', LINE.replace('"pullNumber":36', '"pullNumber":"36"')],
    ['a pull number of zero', LINE.replace('"pullNumber":36', '"pullNumber":0')],
    ['an owner that is not a GitHub name', LINE.replace('"owner":"mike-north"', '"owner":"mike north"')],
    ['an escaped character that decodes to the same value', LINE.replace('"owner":"mike-north"', '"owner":"mike\\u002dnorth"')],
    ['JSON that does not parse', LINE.replace('"version":1}', '"version":1')],
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
