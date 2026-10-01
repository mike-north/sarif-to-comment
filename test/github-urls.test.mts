/**
 * Unit tests for the GitHub web URL builder (src/github-urls.cts).
 *
 * Every expected URL is written by hand from GitHub's web routes (as this
 * project's live evidence records them: `#pullrequestreview-ID`,
 * `#discussion_rID`, `/commit/SHA`, `/blob/SHA/PATH#LA-LB`) and from RFC 3986
 * percent-encoding: each path segment is UTF-8 percent-encoded, `(`, `)`,
 * `!`, `'` and `*` included so a Markdown link destination cannot end early,
 * and `/` separators are kept. A dot segment is refused because URL parsers
 * resolve it (WHATWG URL treats `%2e` as `.`), so the link would name another
 * path. Each encoded URL is also checked to survive a WHATWG URL parse with
 * its path and fragment unchanged.
 *
 * @see https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet
 * @see https://www.rfc-editor.org/rfc/rfc3986#section-2.1
 * @see https://www.rfc-editor.org/rfc/rfc3986#section-5.2.4
 * @see https://url.spec.whatwg.org/#single-dot-path-segment
 * @see https://spec.commonmark.org/0.31.2/#link-destination
 * @see https://git-scm.com/docs/git-check-ref-format
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  GITHUB_HOST,
  blobUrl,
  commitUrl,
  compareUrl,
  encodeUrlSegment,
  pullRequestUrl,
  repositoryUrl,
  reviewCommentUrl,
  reviewUrl,
} from '../dist/github-urls.cjs';

const REPO = { owner: 'acme', repo: 'widgets' } as const;
const C = 'c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de';
const BASE = 'https://github.com/acme/widgets';

/** A URL as a browser resolves it: the path and fragment must be exactly what was built. */
function assertStable(url: string): void {
  const parsed = new URL(url);
  assert.equal(parsed.href, url, `the URL parses back unchanged: ${url}`);
}

describe('the GitHub web URL builder', () => {
  test('the host is github.com', () => {
    assert.equal(GITHUB_HOST, 'github.com');
  });

  test('repository, pull request, review and review comment URLs', () => {
    assert.equal(repositoryUrl(REPO), BASE);
    assert.equal(pullRequestUrl(REPO, 7), `${BASE}/pull/7`);
    assert.equal(reviewUrl(REPO, 7, 5361645031), `${BASE}/pull/7#pullrequestreview-5361645031`);
    assert.equal(reviewCommentUrl(REPO, 16, 4118039304), `${BASE}/pull/16#discussion_r4118039304`);
    for (const url of [pullRequestUrl(REPO, 7), reviewUrl(REPO, 7, 1), reviewCommentUrl(REPO, 7, 1)]) assertStable(url);
  });

  test('a commit URL and a blob permalink without and with lines', () => {
    assert.equal(commitUrl(REPO, C), `${BASE}/commit/${C}`);
    assert.equal(blobUrl(REPO, C, 'src/app.js'), `${BASE}/blob/${C}/src/app.js`);
    assert.equal(blobUrl(REPO, C, 'src/app.js', { startLine: 3, endLine: 3 }), `${BASE}/blob/${C}/src/app.js#L3`);
    assert.equal(blobUrl(REPO, C, 'src/app.js', { startLine: 2, endLine: 9 }), `${BASE}/blob/${C}/src/app.js#L2-L9`);
  });

  test('compare URLs: commits, and ref names whose "/" separators are kept', () => {
    const other = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
    assert.equal(compareUrl(REPO, C, other), `${BASE}/compare/${C}...${other}`);
    assert.equal(compareUrl(REPO, 'main', 'feature/retry'), `${BASE}/compare/main...feature/retry`);
    assert.equal(compareUrl(REPO, 'main', 'topic/a#1 b'), `${BASE}/compare/main...topic/a%231%20b`);
    assertStable(compareUrl(REPO, 'main', 'topic/a#1 b'));
  });

  describe('path encoding', () => {
    const cases: readonly (readonly [label: string, path: string, encoded: string])[] = [
      ['spaces', 'odd dir/a b.txt', 'odd%20dir/a%20b.txt'],
      ['a "#" that would otherwise start a fragment', 'docs/#1 notes.md', 'docs/%231%20notes.md'],
      ['"?" and "%" that would otherwise start a query or an escape', 'q?/100%.md', 'q%3F/100%25.md'],
      ['parentheses, "!", "\'" and "*", which could end a Markdown link destination', "a(1)/b!'*.txt", "a%281%29/b%21%27%2A.txt"],
      ['non-ASCII text as UTF-8', 'docs/café/日本.md', 'docs/caf%C3%A9/%E6%97%A5%E6%9C%AC.md'],
      ['an astral character as its four UTF-8 bytes', 'emoji/😀.md', 'emoji/%F0%9F%98%80.md'],
      ['dots inside a segment (not a dot segment)', 'a..b/..c/d../.e', 'a..b/..c/d../.e'],
    ];
    for (const [label, filePath, encoded] of cases) {
      test(label, () => {
        const url = blobUrl(REPO, C, filePath, { startLine: 1, endLine: 2 });
        assert.equal(url, `${BASE}/blob/${C}/${encoded}#L1-L2`);
        assertStable(url);
        const parsed = new URL(url);
        assert.equal(parsed.hash, '#L1-L2', 'the path never leaks into the fragment');
        assert.equal(parsed.search, '', 'the path never leaks into a query');
      });
    }

    test('owner and repository names are encoded segments too', () => {
      assert.equal(repositoryUrl({ owner: 'a b', repo: 'c(d)' }), 'https://github.com/a%20b/c%28d%29');
    });

    test('a segment encoding leaves the unreserved characters alone', () => {
      assert.equal(encodeUrlSegment('A-z_0.9~'), 'A-z_0.9~');
      assert.equal(encodeUrlSegment('a/b'), 'a%2Fb');
    });
  });

  describe('refusals: a link that would silently name something else is never built', () => {
    for (const [label, filePath] of [
      ['a ".." segment', 'docs/../secret.txt'],
      ['a leading ".." segment', '../outside.txt'],
      ['a "." segment', 'docs/./notes.md'],
      ['an empty segment', 'docs//notes.md'],
      ['an empty path', ''],
    ] as const) {
      test(`a path with ${label}`, () => {
        assert.throws(() => blobUrl(REPO, C, filePath), /Internal error: a repository path has (a dot|an empty) segment/);
      });
    }

    test('a ref name containing ".." or an empty segment', () => {
      assert.throws(() => compareUrl(REPO, 'main', 'a..b'), /ref name contains "\.\."/);
      assert.throws(() => compareUrl(REPO, 'main...x', 'b'), /ref name contains "\.\."/);
      assert.throws(() => compareUrl(REPO, 'main', 'topic//x'), /ref name has an empty segment/);
    });

    test('an abbreviated, uppercase or non-hex commit', () => {
      for (const commit of ['c0dec0d', C.toUpperCase(), `${C.slice(0, 39)}g`, `${C}0`]) {
        assert.throws(() => commitUrl(REPO, commit), /not a full lowercase commit id/);
        assert.throws(() => blobUrl(REPO, commit, 'a.txt'), /not a full lowercase commit id/);
      }
    });

    test('a pull request number, review id, comment id or line that is not a positive integer', () => {
      for (const n of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => pullRequestUrl(REPO, n), /must be a positive integer/);
        assert.throws(() => reviewUrl(REPO, 7, n), /must be a positive integer/);
        assert.throws(() => reviewCommentUrl(REPO, 7, n), /must be a positive integer/);
        assert.throws(() => blobUrl(REPO, C, 'a.txt', { startLine: n, endLine: 3 }), /must be a positive integer/);
      }
    });
  });
});
