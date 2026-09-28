'use strict';

/**
 * GitHub host adapter for the first milestone (private internal module).
 *
 * Speaks raw HTTP to the GitHub REST and GraphQL APIs through an injected
 * `fetch`, and exposes two narrow boundaries:
 *   - the publication transport consumed by src/publication.cjs
 *     (getAuthenticatedUser, createReview, listReviews, listReviewComments),
 *     normalizing host readback into that module's private shapes; and
 *   - the trusted review context and source-snapshot boundary consumed by
 *     src/prepare-review.cjs (fetchContext, and the readSource it returns).
 *
 * It never decides placement, rendering, or delivery; it never retries a
 * write, never submits, edits or deletes a review, and never invents
 * coordinates or source text. Anything it cannot establish exactly is an
 * error, not an approximation.
 *
 * ---------------------------------------------------------------------------
 * createGitHubClient({ token, fetch = globalThis.fetch, apiOrigin?, limits? })
 *   -> { getAuthenticatedUser, createReview, listReviews, listReviewComments,
 *        fetchContext }
 *
 *   token:     string   personal access token or user OAuth token. Held only in
 *                       a closure: never a property of the client, never in an
 *                       error (every host- or fetch-supplied text is redacted
 *                       and raw causes are replaced by redacted descriptions),
 *                       never logged or persisted. Authentication is user/PAT
 *                       only (the numeric id comes from GET /user); GitHub App
 *                       installation tokens are not claimed to work.
 *   fetch:     WHATWG fetch implementation.
 *   apiOrigin: exactly 'https://api.github.com' (the default). Any other origin,
 *              including GitHub Enterprise Server, is refused.
 *   limits:    { maxSourceBytes = 1_000_000, maxPullFiles = 3000,
 *                maxPages = 100 }. Exceeding a limit is an error; nothing is
 *              truncated.
 *
 * HTTP discipline (every request):
 *   - URL origin is apiOrigin; Authorization is sent to no other origin.
 *   - Headers: Authorization: Bearer <token>; User-Agent; for REST
 *     Accept: application/vnd.github+json and X-GitHub-Api-Version:
 *     2022-11-28; Content-Type: application/json when a body is sent.
 *   - `redirect: 'manual'`; any 3xx (or opaque redirect) is refused, never
 *     followed.
 *   - Pagination follows Link rel="next" only after validating it: same origin,
 *     no credentials or fragment, the same endpoint (under
 *     /repos/{owner}/{repo} or /repositories/{id}), no query parameters other
 *     than per_page=100 and page exactly one greater. The next request is
 *     rebuilt canonically under /repos/{owner}/{repo}. At most `maxPages`.
 *   - The only non-GET requests are the single create-review POST and GraphQL
 *     POSTs whose document is a query (never a mutation).
 *
 * Errors: GitHubError { code, status?, hostRejected, message, cause? }.
 *   hostRejected is true only when the create-review POST received one of the
 *   understood refusal statuses 400, 401, 403, 404, 409, 422 or 429: the host
 *   answered that it did not accept the request. Every other create failure —
 *   network error, redirect, 408, any other 4xx, 5xx, unreadable 2xx — is
 *   indeterminate (hostRejected false). This classifies answers only; it
 *   asserts nothing about server-side atomicity. A refusal keeps the host's
 *   redacted explanation (for example GitHub's 422 when the author already has
 *   a pending review on the pull request). Codes: 'network', 'http-status',
 *   'redirect', 'unsafe-link', 'malformed-response', 'graphql-errors',
 *   'pagination', 'head-race', 'files-incomplete', 'duplicate-file',
 *   'anchor-unavailable', 'anchor-ambiguous', 'anchor-malformed',
 *   'old-source-unverified', 'rename-unsupported', 'patch-unavailable',
 *   'source-inconsistent', 'not-a-file', 'blob-integrity',
 *   'undecodable-source', 'source-too-large'. Malformed caller input is a
 *   TypeError before any request.
 *
 * ---------------------------------------------------------------------------
 * Publication transport (see test/fixtures/publication/fake-github.cjs)
 *
 *   getAuthenticatedUser() -> { id, login }          GET /user
 *   createReview({ owner, repo, pullNumber, commitId, body, comments })
 *       -> { id, htmlUrl }
 *     Exactly one POST /repos/{o}/{r}/pulls/{n}/reviews with JSON
 *     { commit_id, body, comments: [{ path, body, line, side,
 *       start_line?, start_side? }] } and no `event` (a pending draft). Bodies
 *     are sent byte-for-byte. Never retried.
 *   listReviews({ owner, repo, pullNumber, cursor })
 *       -> { reviews: [{ id, htmlUrl, authorId, authorLogin, commitId, state,
 *            body }], nextCursor }
 *     One REST page per call; cursor is an adapter-issued page number.
 *   listReviewComments({ owner, repo, pullNumber, reviewId, cursor: null })
 *       -> { comments: [{ path, side, line, startSide?, startLine?, body }],
 *            nextCursor: null }
 *     Reads every REST comment page of the review (bodies, ids) and every
 *     GraphQL reviewThreads page of the pull request. Pending-review REST
 *     comments may carry null or absent line/side, so anchors come only from
 *     the thread whose first comment has the REST comment's databaseId and
 *     this review's databaseId: path, diffSide, originalLine, and — only when
 *     both are present — startDiffSide/originalStartLine. Current (possibly
 *     shifted) line fields are never used. Threads rooted in other reviews are
 *     ignored whatever their shape; a body-only review reads back as []. Each
 *     REST comment must match exactly one thread and each of this review's
 *     thread roots exactly one REST comment; paths and original commits must
 *     agree; non-null REST anchor fields must agree. Otherwise the whole read
 *     fails (anchor-unavailable / anchor-ambiguous / anchor-malformed) rather
 *     than shifting or matching by text. Order follows REST.
 *     GraphQL: POST https://api.github.com/graphql, a query with variables
 *     { owner, repo, number, after } selecting, per reviewThreads node, path,
 *     subjectType, diffSide, startDiffSide, originalLine, originalStartLine and
 *     comments(first: 1) { databaseId pullRequestReview { databaseId }
 *     originalCommit { oid } }, with pageInfo { hasNextPage endCursor }. A
 *     missing or repeated endCursor while hasNextPage is 'pagination'; a
 *     response `errors` array is 'graphql-errors'. subjectType must be LINE.
 *
 * ---------------------------------------------------------------------------
 * Review context
 *
 *   fetchContext({ destination: { owner, repo, pullNumber }, reviewedCommit,
 *                  oldSourceCommit? }) -> { context, readSource }
 *
 *   Requests, in order: GET pull; every GET pull files page; GET pull again
 *   (its head must equal the first, else 'head-race'); then, only when no
 *   oldSourceCommit is given, GET compare/{base.sha}...{pull head} for a
 *   merge-base CANDIDATE. The reviewed commit may differ from the pull head
 *   (a historical review); the actual current pull diff is always returned.
 *
 *   context: {
 *     owner, repo, pullNumber, reviewedCommit,
 *     pullHead,          // pinned pull head observed twice
 *     currentBaseTip,    // base.sha; informational, never provenance
 *     diff: { baseCommit, headCommit: pullHead, files },
 *     fileDiagnostics: [{ path, reason: 'patch-omitted'|'patch-inconsistent' }],
 *   }
 *   files: [{ path, previousPath?, patch? }] in host order. A patch is dropped
 *   (with a diagnostic) when omitted or when its +/- counts disagree with the
 *   entry's additions/deletions (truncated). changed_files must equal the
 *   listed count and be at most maxPullFiles; filenames must be unique.
 *   baseCommit is the caller's oldSourceCommit or the compare merge base; it is
 *   only a candidate until readSource verifies each old-side read.
 *
 *   readSource(commit, path) -> string | null
 *     commit: full lowercase 40-hex. path: repository-relative, "/" separated;
 *     empty, ".", ".." segments, leading "/", backslash and NUL are refused.
 *     Reads Git objects only, never the Contents API (which dereferences
 *     in-repository symlinks and would answer with another path's text):
 *     GET git/commits/{commit} for its root tree, GET git/trees/{sha}
 *     (non-recursive) for each directory on the path, then GET
 *     git/blobs/{sha}. Commits and trees are immutable and read once per
 *     client. Every answer must name exactly the requested object; a tree
 *     must be complete (truncated false) with unique names and known
 *     mode/type pairs (040000 tree, 100644/100755 blob, 120000 blob, 160000
 *     commit). Only directories are traversed and only regular files
 *     (100644, 100755) are source: a directory, symlink or submodule at or
 *     above the path is 'not-a-file'. A name missing from a complete listing
 *     (or below a regular file) means absent (null); an HTTP 404 for a commit,
 *     tree or blob is an operational 'http-status' error, never absence. The
 *     blob must be strict base64 (GitHub's newline wrapping allowed) whose
 *     bytes have the declared and tree-listed size, hash to the requested
 *     blob id, fit maxSourceBytes (checked from the tree before download) and
 *     decode as fatal UTF-8 (a leading BOM is preserved). 'blob-integrity'
 *     covers any commit, tree or blob answer whose identity, size or hash
 *     disagrees with what was requested.
 *     A read at diff.baseCommit is verified against the pinned pull head: the
 *     file's authoritative patch reverse-applied to the head file must
 *     reproduce the candidate's file exactly (absence included); an unchanged
 *     file must be identical at both commits. Renamed files refuse under either
 *     name ('rename-unsupported'), files without a usable patch refuse
 *     ('patch-unavailable'), a changed file missing where its patch says it
 *     exists is 'source-inconsistent', and any other disagreement —
 *     incompatible hunks, missing "\ No newline at end of file" markers,
 *     different text — is 'old-source-unverified'. Reads at any other full
 *     commit (the pull head, the reviewed commit, historical provenance) are
 *     direct.
 *
 * @see https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api
 * @see https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
 * @see https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files
 * @see https://docs.github.com/en/rest/commits/commits#compare-two-commits
 * @see https://docs.github.com/en/rest/repos/contents#get-repository-content
 * @see https://docs.github.com/en/rest/pulls/reviews
 * @see https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread
 */

const crypto = require('node:crypto');

/** The only API origin this adapter will send credentials to. */
const API_ORIGIN = 'https://api.github.com';

/** Documented REST media type and API version sent on every REST request. */
const REST_ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';

/** GitHub rejects requests without a User-Agent; this names the tool, not a version. */
const USER_AGENT = 'sarif-to-comment';

/** Page size requested from every paginated REST listing (GitHub's maximum). */
const PER_PAGE = 100;

/** Page size requested from the GraphQL reviewThreads connection (its maximum). */
const THREADS_PER_PAGE = 100;

const DEFAULT_LIMITS = Object.freeze({ maxSourceBytes: 1_000_000, maxPullFiles: 3000, maxPages: 100 });

/**
 * Create-review answers understood as the host declining the request. Any
 * other status leaves open whether the review was created.
 */
const DEFINITIVE_CREATE_REFUSALS = new Set([400, 401, 403, 404, 409, 422, 429]);

/** A full, canonical (lowercase) Git object name; abbreviations are never accepted. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/** GitHub owner and repository names: letters, digits, '-', '_', '.' (never '.' or '..'). */
const REPO_NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * Git tree entry modes as GitHub's trees API reports them, with the object
 * type each must carry. Directories are reported as "040000".
 */
const TREE_MODE = '040000';
const SYMLINK_MODE = '120000';
const SUBMODULE_MODE = '160000';
const TREE_ENTRY_TYPES = new Map([
  [TREE_MODE, 'tree'],
  ['100644', 'blob'],
  ['100755', 'blob'],
  [SYMLINK_MODE, 'blob'],
  [SUBMODULE_MODE, 'commit'],
]);

/** Modes of regular files, the only tree entries whose blob is source text. */
const REGULAR_FILE_MODES = new Set(['100644', '100755']);

/** Review-comment sides in the create request and in thread anchors. */
const SIDES = new Set(['LEFT', 'RIGHT']);

/** Keys a create request and its comments may carry; anything else is refused. */
const CREATE_KEYS = ['body', 'comments', 'commitId', 'owner', 'pullNumber', 'repo'];
const COMMENT_KEYS = new Set(['path', 'side', 'line', 'startSide', 'startLine', 'body']);

/** Unified hunk header; omitted counts mean 1. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Identity tag marking an embedded GraphQL document for tooling. */
const gql = String.raw;

/**
 * Review threads of one pull request with exactly the fields the anchor join
 * needs. The first comment of a thread is the comment that created it.
 */
const REVIEW_THREADS_QUERY = gql`query ($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREADS_PER_PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          path
          subjectType
          diffSide
          startDiffSide
          originalLine
          originalStartLine
          comments(first: 1) {
            nodes { databaseId pullRequestReview { databaseId } originalCommit { oid } }
          }
        }
      }
    }
  }
}`;

/**
 * A host or adapter failure. `code` classifies it; `hostRejected` is true only
 * when GitHub definitively refused the single create-review request.
 */
class GitHubError extends Error {
  constructor(code, message, { status, hostRejected = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GitHubError';
    this.code = code;
    if (status !== undefined) this.status = status;
    this.hostRejected = hostRejected;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function requireInput(condition, message) {
  if (!condition) throw new TypeError(`Invalid GitHub adapter input: ${message}`);
}

function isRepoName(value) {
  return typeof value === 'string' && REPO_NAME.test(value) && value !== '.' && value !== '..';
}

function requireDestination({ owner, repo, pullNumber }) {
  requireInput(isRepoName(owner), 'owner must be a GitHub account name');
  requireInput(isRepoName(repo), 'repo must be a GitHub repository name');
  requireInput(isPositiveInteger(pullNumber), 'pullNumber must be a positive integer');
}

function requireFullSha(value, name) {
  requireInput(typeof value === 'string' && FULL_SHA.test(value), `${name} must be a full lowercase 40-hex commit`);
}

/** Whether a repository-relative path is safe to address: no traversal or ambiguity. */
function requireRepositoryPath(filePath) {
  requireInput(typeof filePath === 'string' && filePath.length > 0, 'path must be a non-empty string');
  requireInput(!filePath.includes('\\') && !filePath.includes('\0'), 'path must not contain backslashes or NUL');
  requireInput(
    filePath.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'path must be repository-relative without empty, "." or ".." segments',
  );
}

/** Git blob object id of raw bytes ("blob <size>\0" + bytes, SHA-1). */
function gitBlobSha(bytes) {
  return crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes]))
    .digest('hex');
}

/** Physical lines of a text, each keeping its own terminator; a lone CR is content. */
function physicalLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Whether a Link header's rel value names the next page. */
function isNextRel(rel) {
  return rel.split(/\s+/).includes('next');
}

/** The href of a Link header's rel="next" entry, or null. */
function nextLinkHref(header) {
  if (!header) return null;
  for (const match of header.matchAll(/<([^>]*)>\s*;\s*rel="([^"]*)"/g)) {
    if (isNextRel(match[2])) return match[1];
  }
  return null;
}

/**
 * Old-side text of a file, reproduced by reverse-applying its unified-diff
 * patch to the new-side text (null when absent). Returns { absent: true } when
 * the patch says the old file did not exist, else { text }. Any structural or
 * content disagreement throws, so only an exact, complete reconstruction is
 * ever returned.
 */
function reverseApplyPatch(newText, patch, filePath) {
  const fail = (why) => {
    throw new GitHubError('old-source-unverified', `The patch for ${filePath} does not reproduce an old side: ${why}.`);
  };
  const patchLines = patch.split('\n');
  if (patchLines.at(-1) === '') patchLines.pop();
  const newLines = physicalLines(newText ?? '');
  const oldLines = [];
  let newIndex = 0;
  let oldAbsent = false;
  let newAbsent = false;
  let hunks = 0;
  let i = 0;
  while (i < patchLines.length) {
    const header = HUNK_HEADER.exec(patchLines[i]);
    if (!header) fail(`line ${i + 1} is not a hunk header`);
    hunks += 1;
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    if (oldCount === 0 && oldStart === 0) oldAbsent = true;
    if (newCount === 0 && newStart === 0) newAbsent = true;
    const hunkNewIndex = newCount === 0 ? newStart : newStart - 1;
    if (hunkNewIndex < newIndex || hunkNewIndex > newLines.length) fail('hunks overlap or lie outside the new text');
    while (newIndex < hunkNewIndex) oldLines.push(newLines[newIndex++]);
    const expectedOldIndex = oldCount === 0 ? oldStart : oldStart - 1;
    if (oldLines.length !== expectedOldIndex) fail('hunk offsets disagree with the unchanged text between hunks');
    let oldSeen = 0;
    let newSeen = 0;
    i += 1;
    while (oldSeen < oldCount || newSeen < newCount) {
      if (i >= patchLines.length) fail('a hunk ends before its line counts are reached');
      const line = patchLines[i];
      const kind = line[0];
      const noNewline = i + 1 < patchLines.length && patchLines[i + 1].startsWith('\\');
      const text = line.slice(1) + (noNewline ? '' : '\n');
      if (kind === ' ' || kind === '+') {
        if (newLines[newIndex] !== text) fail(`new-side line ${newIndex + 1} differs from the patch`);
        newIndex += 1;
        newSeen += 1;
      }
      if (kind === ' ' || kind === '-') {
        oldLines.push(text);
        oldSeen += 1;
      }
      if (kind !== ' ' && kind !== '+' && kind !== '-') fail(`line ${i + 1} is not a hunk body line`);
      i += noNewline ? 2 : 1;
    }
    if (oldSeen !== oldCount || newSeen !== newCount) fail('a hunk body disagrees with its line counts');
  }
  if (hunks === 0) fail('it has no hunks');
  while (newIndex < newLines.length) oldLines.push(newLines[newIndex++]);
  if (newAbsent && newText !== null) fail('it deletes a file that exists');
  if (!newAbsent && newText === null) fail('it changes a file that does not exist');
  if (oldAbsent) {
    if (oldLines.length !== 0) fail('it creates a file but leaves old text');
    return { absent: true };
  }
  return { text: oldLines.join('') };
}

/** Number of '+' and '-' body lines in a patch, excluding markers and headers. */
function patchCounts(patch) {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Creates a GitHub client bound to one token and one fetch implementation.
 *
 * @param {object} options see module documentation
 * @returns {object} the publication transport plus fetchContext
 */
function createGitHubClient(options) {
  requireInput(isPlainObject(options), 'options must be an object');
  const { token, fetch: fetchImpl = globalThis.fetch, apiOrigin = API_ORIGIN, limits: limitOverrides = {} } = options;
  requireInput(typeof token === 'string' && token.length > 0, 'token must be a non-empty string');
  requireInput(typeof fetchImpl === 'function', 'fetch must be a function');
  requireInput(apiOrigin === API_ORIGIN, `apiOrigin must be ${API_ORIGIN}`);
  requireInput(isPlainObject(limitOverrides), 'limits must be an object');
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  for (const [name, value] of Object.entries(limits)) {
    requireInput(Object.hasOwn(DEFAULT_LIMITS, name), `unknown limit ${name}`);
    requireInput(isPositiveInteger(value), `limits.${name} must be a positive integer`);
  }

  // ---------------------------------------------------------------------------
  // Credential-safe HTTP
  // ---------------------------------------------------------------------------

  /** Removes the token from any host- or fetch-supplied text. */
  function redact(value) {
    return String(value).split(token).join('[redacted]');
  }

  /**
   * A redacted, cause-free description of a thrown value. Raw errors from
   * fetch or parsing may carry request configuration or echoed headers, so
   * they are never attached as-is.
   */
  function describeCause(thrown) {
    const description = new Error(redact(thrown && thrown.message !== undefined ? thrown.message : thrown));
    if (thrown && typeof thrown.name === 'string') description.name = redact(thrown.name);
    if (thrown && typeof thrown.code === 'string') description.code = redact(thrown.code);
    return description;
  }

  function repoPath(owner, repo) {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  /** Sends one request to the API origin; a thrown fetch or redirect is a GitHubError. */
  async function send(method, url, { body, graphql = false } = {}) {
    if (new URL(url).origin !== API_ORIGIN) {
      throw new GitHubError('unsafe-link', 'Refusing to send credentials outside the GitHub API origin.');
    }
    const headers = { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT };
    if (!graphql) {
      headers.Accept = REST_ACCEPT;
      headers['X-GitHub-Api-Version'] = API_VERSION;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
    } catch (err) {
      throw new GitHubError('network', `${method} ${new URL(url).pathname} failed before a response was read.`, {
        cause: describeCause(err),
      });
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new GitHubError('redirect', `GitHub answered ${method} ${new URL(url).pathname} with a redirect, which is not followed.`, {
        status: response.status || undefined,
      });
    }
    return response;
  }

  /** The parsed JSON body of a response, or a malformed-response error. */
  async function jsonBody(response, what) {
    let text;
    try {
      text = await response.text();
    } catch (err) {
      throw new GitHubError('network', `The ${what} response body could not be read.`, { cause: describeCause(err) });
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new GitHubError('malformed-response', `The ${what} response is not JSON.`, { cause: describeCause(err) });
    }
  }

  /** An http-status error carrying the host's redacted explanation. */
  async function statusError(response, what, hostRejected = false) {
    let explanation = '';
    try {
      const parsed = JSON.parse(await response.text());
      const parts = [];
      if (isPlainObject(parsed) && typeof parsed.message === 'string') parts.push(parsed.message);
      if (isPlainObject(parsed) && Array.isArray(parsed.errors)) {
        for (const e of parsed.errors) parts.push(typeof e === 'string' ? e : JSON.stringify(e));
      }
      if (parts.length > 0) explanation = `: ${parts.join('; ')}`;
    } catch {
      // The status alone still classifies the failure.
    }
    return new GitHubError('http-status', redact(`GitHub answered the ${what} with HTTP ${response.status}${explanation}`), {
      status: response.status,
      hostRejected,
    });
  }

  /** GET a REST resource; returns { body, link }. */
  async function restGet(url, what) {
    const response = await send('GET', url);
    if (!response.ok) throw await statusError(response, what);
    return { body: await jsonBody(response, what), link: response.headers.get('link') };
  }

  /**
   * The page number a validated rel="next" link names after `page`, or null
   * when there is none. The link must address the same endpoint on the API
   * origin, carry no credentials, and name exactly the following page.
   */
  function nextPage(linkHeader, owner, repo, suffix, page) {
    const href = nextLinkHref(linkHeader);
    if (href === null) return null;
    let url;
    try {
      url = new URL(href);
    } catch {
      throw new GitHubError('unsafe-link', 'A pagination link is not a URL.');
    }
    const canonical = `${repoPath(owner, repo)}${suffix}`.toLowerCase();
    const byId = new RegExp(`^/repositories/\\d+${suffix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'i');
    const endpointOk = url.pathname.toLowerCase() === canonical || byId.test(url.pathname);
    const params = [...url.searchParams.keys()];
    const queryOk =
      params.every((k) => k === 'page' || k === 'per_page') &&
      new Set(params).size === params.length &&
      (url.searchParams.get('per_page') ?? String(PER_PAGE)) === String(PER_PAGE);
    if (url.origin !== API_ORIGIN || url.username || url.password || url.hash || !endpointOk || !queryOk) {
      throw new GitHubError('unsafe-link', 'A pagination link leaves the requested endpoint; it is not followed.');
    }
    const next = url.searchParams.get('page');
    if (next !== String(page + 1)) {
      throw new GitHubError('pagination', `A pagination link names page ${redact(next)} after page ${page}.`);
    }
    if (page + 1 > limits.maxPages) {
      throw new GitHubError('pagination', `Pagination exceeded ${limits.maxPages} pages.`);
    }
    return page + 1;
  }

  function pageUrl(owner, repo, suffix, page) {
    return `${API_ORIGIN}${repoPath(owner, repo)}${suffix}?per_page=${PER_PAGE}&page=${page}`;
  }

  /** Every item of a paginated REST listing, in host order. */
  async function listAll(owner, repo, suffix, what) {
    const items = [];
    for (let page = 1; page !== null; ) {
      const { body, link } = await restGet(pageUrl(owner, repo, suffix, page), what);
      if (!Array.isArray(body)) throw new GitHubError('malformed-response', `The ${what} page is not a list.`);
      items.push(...body);
      page = nextPage(link, owner, repo, suffix, page);
    }
    return items;
  }

  // ---------------------------------------------------------------------------
  // Publication transport
  // ---------------------------------------------------------------------------

  async function getAuthenticatedUser() {
    const { body } = await restGet(`${API_ORIGIN}/user`, 'authenticated user request');
    if (!isPlainObject(body) || !isPositiveInteger(body.id) || typeof body.login !== 'string') {
      throw new GitHubError('malformed-response', 'The authenticated user has no numeric id and login.');
    }
    return { id: body.id, login: body.login };
  }

  function createPayload(request) {
    requireInput(isPlainObject(request), 'the create request must be an object');
    const keys = Object.keys(request).sort();
    requireInput(
      keys.length === CREATE_KEYS.length && keys.every((k, i) => k === CREATE_KEYS[i]),
      `the create request must have exactly ${CREATE_KEYS.join(', ')}`,
    );
    requireDestination(request);
    requireFullSha(request.commitId, 'commitId');
    requireInput(typeof request.body === 'string', 'body must be a string');
    requireInput(Array.isArray(request.comments), 'comments must be a list');
    const comments = request.comments.map((c, i) => {
      requireInput(isPlainObject(c), `comments[${i}] must be an object`);
      for (const key of Object.keys(c)) requireInput(COMMENT_KEYS.has(key), `comments[${i}] has unsupported field ${key}`);
      requireInput(typeof c.path === 'string' && c.path.length > 0, `comments[${i}].path must be a non-empty string`);
      requireInput(SIDES.has(c.side), `comments[${i}].side must be LEFT or RIGHT`);
      requireInput(isPositiveInteger(c.line), `comments[${i}].line must be a positive integer`);
      requireInput(typeof c.body === 'string', `comments[${i}].body must be a string`);
      const hasStart = Object.hasOwn(c, 'startSide');
      requireInput(hasStart === Object.hasOwn(c, 'startLine'), `comments[${i}] start fields go together`);
      const payload = { path: c.path, body: c.body, line: c.line, side: c.side };
      if (hasStart) {
        requireInput(SIDES.has(c.startSide), `comments[${i}].startSide must be LEFT or RIGHT`);
        requireInput(isPositiveInteger(c.startLine), `comments[${i}].startLine must be a positive integer`);
        payload.start_line = c.startLine;
        payload.start_side = c.startSide;
      }
      return payload;
    });
    return { commit_id: request.commitId, body: request.body, comments };
  }

  async function createReview(request) {
    const payload = createPayload(request);
    const url = `${API_ORIGIN}${repoPath(request.owner, request.repo)}/pulls/${request.pullNumber}/reviews`;
    const response = await send('POST', url, { body: payload });
    if (!response.ok) {
      throw await statusError(response, 'create-review request', DEFINITIVE_CREATE_REFUSALS.has(response.status));
    }
    const body = await jsonBody(response, 'create-review');
    if (!isPlainObject(body) || !isPositiveInteger(body.id) || typeof body.html_url !== 'string') {
      throw new GitHubError('malformed-response', 'The create-review answer names no review; the outcome is unknown.');
    }
    return { id: body.id, htmlUrl: body.html_url };
  }

  async function listReviews({ owner, repo, pullNumber, cursor } = {}) {
    requireDestination({ owner, repo, pullNumber });
    requireInput(
      cursor === null || cursor === undefined || (typeof cursor === 'string' && /^[1-9]\d{0,5}$/.test(cursor)),
      'cursor must be null or a cursor this adapter issued',
    );
    const page = cursor ? Number(cursor) : 1;
    requireInput(page <= limits.maxPages, 'cursor exceeds the page limit');
    const suffix = `/pulls/${pullNumber}/reviews`;
    const { body, link } = await restGet(pageUrl(owner, repo, suffix, page), 'review list');
    if (!Array.isArray(body)) throw new GitHubError('malformed-response', 'The review list page is not a list.');
    const reviews = body.map((r) => {
      if (!isPlainObject(r) || !isPositiveInteger(r.id)) {
        throw new GitHubError('malformed-response', 'A review in the list has no numeric id.');
      }
      const user = isPlainObject(r.user) ? r.user : null;
      return {
        id: r.id,
        htmlUrl: r.html_url,
        authorId: user ? user.id : null,
        authorLogin: user ? user.login : null,
        commitId: r.commit_id,
        state: r.state,
        body: r.body,
      };
    });
    const next = nextPage(link, owner, repo, suffix, page);
    return { reviews, nextCursor: next === null ? null : String(next) };
  }

  /** Every review-thread node of a pull request, across all GraphQL pages. */
  async function listReviewThreads(owner, repo, pullNumber) {
    const nodes = [];
    const seen = new Set();
    let after = null;
    for (let pages = 1; ; pages += 1) {
      if (pages > limits.maxPages) throw new GitHubError('pagination', `Review threads exceeded ${limits.maxPages} pages.`);
      const response = await send('POST', `${API_ORIGIN}/graphql`, {
        graphql: true,
        body: { query: REVIEW_THREADS_QUERY, variables: { owner, repo, number: pullNumber, after } },
      });
      if (!response.ok) throw await statusError(response, 'review-thread query');
      const body = await jsonBody(response, 'review-thread query');
      if (isPlainObject(body) && Array.isArray(body.errors) && body.errors.length > 0) {
        const types = body.errors.map((e) => (isPlainObject(e) ? e.type || e.message : String(e))).join('; ');
        throw new GitHubError('graphql-errors', redact(`The review-thread query returned errors: ${types}`));
      }
      const threads = body?.data?.repository?.pullRequest?.reviewThreads;
      if (!isPlainObject(threads) || !Array.isArray(threads.nodes) || !isPlainObject(threads.pageInfo)) {
        throw new GitHubError('malformed-response', 'The review-thread query returned no thread connection.');
      }
      nodes.push(...threads.nodes);
      const { hasNextPage, endCursor } = threads.pageInfo;
      if (hasNextPage === false) return nodes;
      if (hasNextPage !== true || typeof endCursor !== 'string' || endCursor === '' || seen.has(endCursor)) {
        throw new GitHubError('pagination', 'The review-thread pagination is missing or repeats a cursor.');
      }
      seen.add(endCursor);
      after = endCursor;
    }
  }

  /** The original anchor of one thread, or an anchor-malformed error. */
  function threadAnchor(thread, commentId) {
    const bad = (why) => new GitHubError('anchor-malformed', `The thread of comment ${commentId} has ${why}.`);
    if (thread.subjectType !== 'LINE') throw bad('no line subject');
    if (typeof thread.path !== 'string' || thread.path === '') throw bad('no path');
    if (!SIDES.has(thread.diffSide)) throw bad('no valid side');
    if (!isPositiveInteger(thread.originalLine)) throw bad('no original line');
    const anchor = { path: thread.path, side: thread.diffSide, line: thread.originalLine };
    const hasStartLine = thread.originalStartLine !== null && thread.originalStartLine !== undefined;
    const hasStartSide = thread.startDiffSide !== null && thread.startDiffSide !== undefined;
    if (hasStartLine !== hasStartSide) throw bad('a start line without a start side (or the reverse)');
    if (hasStartLine) {
      if (!isPositiveInteger(thread.originalStartLine) || !SIDES.has(thread.startDiffSide)) throw bad('an invalid start');
      anchor.startSide = thread.startDiffSide;
      anchor.startLine = thread.originalStartLine;
    }
    return anchor;
  }

  async function listReviewComments({ owner, repo, pullNumber, reviewId, cursor } = {}) {
    requireDestination({ owner, repo, pullNumber });
    requireInput(isPositiveInteger(reviewId), 'reviewId must be a positive integer');
    requireInput(cursor === null || cursor === undefined, 'readback is one complete enumeration; cursor must be null');
    const rest = await listAll(owner, repo, `/pulls/${pullNumber}/reviews/${reviewId}/comments`, 'review comment list');
    for (const c of rest) {
      if (
        !isPlainObject(c) ||
        !isPositiveInteger(c.id) ||
        c.pull_request_review_id !== reviewId ||
        typeof c.path !== 'string' ||
        typeof c.body !== 'string' ||
        typeof c.original_commit_id !== 'string'
      ) {
        throw new GitHubError('malformed-response', `A listed comment does not belong to review ${reviewId} or lacks its fields.`);
      }
    }
    const threads = await listReviewThreads(owner, repo, pullNumber);
    const byRoot = new Map();
    for (const thread of threads) {
      const root = thread?.comments?.nodes?.[0];
      if (!isPlainObject(root) || root.pullRequestReview?.databaseId !== reviewId) continue;
      if (!isPositiveInteger(root.databaseId)) {
        throw new GitHubError('anchor-malformed', `A thread of review ${reviewId} has no root comment id.`);
      }
      byRoot.set(root.databaseId, [...(byRoot.get(root.databaseId) ?? []), thread]);
    }
    const restIds = new Set(rest.map((c) => c.id));
    for (const rootId of byRoot.keys()) {
      if (!restIds.has(rootId)) {
        throw new GitHubError('anchor-ambiguous', `Review ${reviewId} has a thread whose root comment the review does not list.`);
      }
    }
    const comments = rest.map((c) => {
      const candidates = byRoot.get(c.id) ?? [];
      if (candidates.length === 0) {
        throw new GitHubError('anchor-unavailable', `No review thread establishes the original anchor of comment ${c.id}.`);
      }
      if (candidates.length > 1) {
        throw new GitHubError('anchor-ambiguous', `More than one review thread is rooted at comment ${c.id}.`);
      }
      const [thread] = candidates;
      const anchor = threadAnchor(thread, c.id);
      const disagree = (why) => new GitHubError('anchor-ambiguous', `Comment ${c.id} and its thread disagree on ${why}.`);
      if (anchor.path !== c.path) throw disagree('the path');
      const oid = thread.comments.nodes[0].originalCommit?.oid;
      if (typeof oid !== 'string') throw new GitHubError('anchor-malformed', `The thread of comment ${c.id} has no original commit.`);
      if (oid !== c.original_commit_id) throw disagree('the original commit');
      if (c.original_line !== null && c.original_line !== undefined && c.original_line !== anchor.line) throw disagree('the line');
      if (c.side !== null && c.side !== undefined && c.side !== anchor.side) throw disagree('the side');
      if (c.original_start_line !== null && c.original_start_line !== undefined && c.original_start_line !== anchor.startLine) {
        throw disagree('the start line');
      }
      if (c.start_side !== null && c.start_side !== undefined && c.start_side !== anchor.startSide) throw disagree('the start side');
      return { ...anchor, body: c.body };
    });
    return { comments, nextCursor: null };
  }

  // ---------------------------------------------------------------------------
  // Review context and source snapshots
  // ---------------------------------------------------------------------------

  /** The pull request's head and base commits and changed-file count. */
  async function readPull(owner, repo, pullNumber) {
    const { body } = await restGet(`${API_ORIGIN}${repoPath(owner, repo)}/pulls/${pullNumber}`, 'pull request');
    const head = body?.head?.sha;
    const base = body?.base?.sha;
    const changedFiles = body?.changed_files;
    if (!FULL_SHA.test(head ?? '') || !FULL_SHA.test(base ?? '') || !Number.isSafeInteger(changedFiles) || changedFiles < 0) {
      throw new GitHubError('malformed-response', 'The pull request lacks full head/base commits or a changed-file count.');
    }
    return { head, base, changedFiles };
  }

  /** Every changed-file entry of the pull request, complete and unique, or an error. */
  async function readPullFiles(owner, repo, pullNumber, changedFiles) {
    if (changedFiles > limits.maxPullFiles) {
      throw new GitHubError('files-incomplete', `The pull request changes ${changedFiles} files; at most ${limits.maxPullFiles} can be listed completely.`);
    }
    const entries = await listAll(owner, repo, `/pulls/${pullNumber}/files`, 'pull request file list');
    const seen = new Set();
    for (const entry of entries) {
      if (
        !isPlainObject(entry) ||
        typeof entry.filename !== 'string' ||
        entry.filename === '' ||
        !Number.isSafeInteger(entry.additions) ||
        !Number.isSafeInteger(entry.deletions) ||
        (entry.patch !== undefined && typeof entry.patch !== 'string') ||
        (entry.previous_filename !== undefined && typeof entry.previous_filename !== 'string')
      ) {
        throw new GitHubError('malformed-response', 'A pull request file entry lacks its fields.');
      }
      if (seen.has(entry.filename)) {
        throw new GitHubError('duplicate-file', redact(`The pull request lists ${entry.filename} more than once.`));
      }
      seen.add(entry.filename);
    }
    if (entries.length !== changedFiles) {
      throw new GitHubError('files-incomplete', `The pull request reports ${changedFiles} changed files but lists ${entries.length}.`);
    }
    return entries;
  }

  // Source is read only as Git objects: the commit's root tree, one
  // non-recursive tree per directory on the path, then the final blob. The
  // Contents API is never used because it dereferences in-repository
  // symlinks and would return another path's text as if it were this one.

  /** In-flight or settled reads of immutable objects, per repository and id. */
  const objectCache = new Map();

  /** Memoizes an immutable-object read; a failed read is forgotten. */
  function cached(key, read) {
    if (!objectCache.has(key)) {
      const pending = read();
      objectCache.set(key, pending);
      pending.catch(() => objectCache.delete(key));
    }
    return objectCache.get(key);
  }

  function identityError(what, requested) {
    return new GitHubError('blob-integrity', `GitHub answered a request for ${what} ${requested} with another object.`);
  }

  /** The root tree id of a full commit. */
  function commitTree(owner, repo, commit) {
    return cached(`${owner}/${repo}:commit:${commit}`, async () => {
      const url = `${API_ORIGIN}${repoPath(owner, repo)}/git/commits/${commit}`;
      const { body } = await restGet(url, 'commit request');
      if (!isPlainObject(body)) throw new GitHubError('malformed-response', 'The commit answer is not an object.');
      if (body.sha !== commit) throw identityError('commit', commit);
      const treeSha = body.tree?.sha;
      if (!FULL_SHA.test(treeSha ?? '')) throw new GitHubError('malformed-response', `Commit ${commit} names no tree.`);
      return treeSha;
    });
  }

  /** The complete, validated entries of one tree, by name. */
  function treeEntries(owner, repo, treeSha) {
    return cached(`${owner}/${repo}:tree:${treeSha}`, async () => {
      const url = `${API_ORIGIN}${repoPath(owner, repo)}/git/trees/${treeSha}`;
      const { body } = await restGet(url, 'tree request');
      if (!isPlainObject(body)) throw new GitHubError('malformed-response', 'The tree answer is not an object.');
      if (body.sha !== treeSha) throw identityError('tree', treeSha);
      if (body.truncated !== false || !Array.isArray(body.tree)) {
        throw new GitHubError('malformed-response', `Tree ${treeSha} is not a complete listing.`);
      }
      const entries = new Map();
      for (const entry of body.tree) {
        const valid =
          isPlainObject(entry) &&
          typeof entry.path === 'string' &&
          entry.path !== '' &&
          entry.path !== '.' &&
          entry.path !== '..' &&
          !entry.path.includes('/') &&
          // An unknown mode maps to no type, so it can never match.
          TREE_ENTRY_TYPES.get(entry.mode) === entry.type &&
          FULL_SHA.test(entry.sha ?? '') &&
          (entry.size === undefined || (Number.isSafeInteger(entry.size) && entry.size >= 0));
        if (!valid) throw new GitHubError('malformed-response', `Tree ${treeSha} has an entry of unknown or inconsistent kind.`);
        if (entries.has(entry.path)) {
          throw new GitHubError('malformed-response', `Tree ${treeSha} lists one name more than once.`);
        }
        entries.set(entry.path, entry);
      }
      return entries;
    });
  }

  /**
   * The tree entry at a path in a commit, or null when a complete listing
   * shows the path does not exist. Only real directories are traversed: a
   * symlink or submodule on the way is refused, never resolved.
   */
  async function entryAt(owner, repo, commit, filePath) {
    const segments = filePath.split('/');
    let treeSha = await commitTree(owner, repo, commit);
    for (let i = 0; i < segments.length; i += 1) {
      const entry = (await treeEntries(owner, repo, treeSha)).get(segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) return entry;
      if (entry.mode === TREE_MODE) {
        treeSha = entry.sha;
        continue;
      }
      if (REGULAR_FILE_MODES.has(entry.mode)) return null;
      const kind = entry.mode === SYMLINK_MODE ? 'a symbolic link' : 'a submodule';
      throw new GitHubError('not-a-file', redact(`${segments.slice(0, i + 1).join('/')} is ${kind}; ${filePath} is not read through it.`));
    }
    return null;
  }

  /** Decodes one git blob answer, bound to the requested blob id. */
  function decodeBlob(body, blobSha, expectedSize, filePath) {
    if (!isPlainObject(body)) throw new GitHubError('malformed-response', 'The blob answer is not an object.');
    if (body.sha !== blobSha) throw identityError('blob', blobSha);
    if (body.encoding !== 'base64' || typeof body.content !== 'string' || !Number.isSafeInteger(body.size)) {
      throw new GitHubError('malformed-response', redact(`${filePath} is not base64 blob content.`));
    }
    if (body.size > limits.maxSourceBytes) {
      throw new GitHubError('source-too-large', redact(`${filePath} exceeds the ${limits.maxSourceBytes}-byte source limit.`));
    }
    const base64 = body.content.replace(/\n/g, '');
    if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      throw new GitHubError('malformed-response', redact(`${filePath} content is not strict base64.`));
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64) {
      throw new GitHubError('malformed-response', redact(`${filePath} content is not canonical base64.`));
    }
    if (bytes.length > limits.maxSourceBytes) {
      throw new GitHubError('source-too-large', redact(`${filePath} exceeds the ${limits.maxSourceBytes}-byte source limit.`));
    }
    const sizeMatches = bytes.length === body.size && (expectedSize === undefined || bytes.length === expectedSize);
    if (!sizeMatches || gitBlobSha(bytes) !== blobSha) {
      throw new GitHubError('blob-integrity', redact(`${filePath} content does not hash to the blob its tree names.`));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (err) {
      throw new GitHubError('undecodable-source', redact(`${filePath} is not valid UTF-8 text.`), { cause: describeCause(err) });
    }
  }

  /**
   * Exact text of the regular file at a path in a pinned commit, or null when
   * the path does not exist there. Directories, symlinks and submodules are
   * refused; an unreachable commit, tree or blob is an operational error,
   * never evidence of absence.
   */
  async function readBlob(owner, repo, commit, filePath) {
    const entry = await entryAt(owner, repo, commit, filePath);
    if (entry === null) return null;
    if (!REGULAR_FILE_MODES.has(entry.mode)) {
      const kind = { [TREE_MODE]: 'a directory', [SYMLINK_MODE]: 'a symbolic link', [SUBMODULE_MODE]: 'a submodule' }[entry.mode];
      throw new GitHubError('not-a-file', redact(`${filePath} is ${kind} at this commit, not a regular file.`));
    }
    if (entry.size !== undefined && entry.size > limits.maxSourceBytes) {
      throw new GitHubError('source-too-large', redact(`${filePath} exceeds the ${limits.maxSourceBytes}-byte source limit.`));
    }
    const { body } = await restGet(`${API_ORIGIN}${repoPath(owner, repo)}/git/blobs/${entry.sha}`, 'blob request');
    return decodeBlob(body, entry.sha, entry.size, filePath);
  }

  async function fetchContext({ destination, reviewedCommit, oldSourceCommit } = {}) {
    requireInput(isPlainObject(destination), 'destination must be an object');
    requireDestination(destination);
    requireFullSha(reviewedCommit, 'reviewedCommit');
    if (oldSourceCommit !== undefined) requireFullSha(oldSourceCommit, 'oldSourceCommit');
    const { owner, repo, pullNumber } = destination;

    const first = await readPull(owner, repo, pullNumber);
    const entries = await readPullFiles(owner, repo, pullNumber, first.changedFiles);
    const second = await readPull(owner, repo, pullNumber);
    if (second.head !== first.head) {
      throw new GitHubError('head-race', 'The pull request head moved while its files were read; no consistent diff exists.');
    }
    const head = first.head;

    let baseCommit = oldSourceCommit;
    if (baseCommit === undefined) {
      const { body } = await restGet(
        `${API_ORIGIN}${repoPath(owner, repo)}/compare/${first.base}...${head}`,
        'merge-base comparison',
      );
      baseCommit = body?.merge_base_commit?.sha;
      if (!FULL_SHA.test(baseCommit ?? '')) {
        throw new GitHubError('malformed-response', 'The comparison names no full merge-base commit.');
      }
    }

    const files = [];
    const fileDiagnostics = [];
    const changes = new Map();
    for (const entry of entries) {
      const file = { path: entry.filename };
      if (entry.previous_filename !== undefined) file.previousPath = entry.previous_filename;
      let patch;
      if (entry.patch === undefined) {
        fileDiagnostics.push({ path: entry.filename, reason: 'patch-omitted' });
      } else {
        const counts = patchCounts(entry.patch);
        if (counts.additions !== entry.additions || counts.deletions !== entry.deletions) {
          fileDiagnostics.push({ path: entry.filename, reason: 'patch-inconsistent' });
        } else {
          patch = entry.patch;
          file.patch = patch;
        }
      }
      files.push(file);
      changes.set(entry.filename, { patch, renamedFrom: file.previousPath });
    }
    const renamedPaths = new Set();
    for (const [filePath, change] of changes) {
      if (change.renamedFrom !== undefined) {
        renamedPaths.add(filePath);
        renamedPaths.add(change.renamedFrom);
      }
    }

    /**
     * Old-side text at the candidate, accepted only when the pinned head file
     * and the file's authoritative patch reproduce it exactly.
     */
    async function readVerifiedBase(filePath) {
      if (renamedPaths.has(filePath)) {
        throw new GitHubError('rename-unsupported', redact(`${filePath} is renamed by the pull request; its old side is not read.`));
      }
      const change = changes.get(filePath);
      if (change === undefined) {
        const [headText, baseText] = [await readBlob(owner, repo, head, filePath), await readBlob(owner, repo, baseCommit, filePath)];
        if (headText !== baseText) {
          throw new GitHubError('old-source-unverified', redact(`${filePath} is unchanged by the diff but differs at the candidate base.`));
        }
        return baseText;
      }
      if (change.patch === undefined) {
        throw new GitHubError('patch-unavailable', redact(`${filePath} has no usable patch to verify its old side.`));
      }
      const headText = await readBlob(owner, repo, head, filePath);
      const deletesFile = /^@@ -\d+(?:,\d+)? \+0,0 @@/.test(change.patch);
      if ((headText === null) !== deletesFile) {
        throw new GitHubError('source-inconsistent', redact(`${filePath} existence at the pull head disagrees with its patch.`));
      }
      const old = reverseApplyPatch(headText, change.patch, redact(filePath));
      const baseText = await readBlob(owner, repo, baseCommit, filePath);
      const matches = old.absent ? baseText === null : baseText !== null && baseText === old.text;
      if (!matches) {
        throw new GitHubError('old-source-unverified', redact(`${filePath} at the candidate base is not what the pull request diff reverses to.`));
      }
      return baseText;
    }

    async function readSource(commit, filePath) {
      requireFullSha(commit, 'commit');
      requireRepositoryPath(filePath);
      if (commit === baseCommit) return readVerifiedBase(filePath);
      return readBlob(owner, repo, commit, filePath);
    }

    const context = {
      owner,
      repo,
      pullNumber,
      reviewedCommit,
      pullHead: head,
      currentBaseTip: first.base,
      diff: { baseCommit, headCommit: head, files },
      fileDiagnostics,
    };
    return { context, readSource };
  }

  return Object.freeze({ getAuthenticatedUser, createReview, listReviews, listReviewComments, fetchContext });
}

module.exports = { createGitHubClient, GitHubError };
