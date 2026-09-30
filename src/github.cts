/**
 * GitHub host adapter for the first milestone (private internal module).
 *
 * Speaks raw HTTP to the GitHub REST and GraphQL APIs through an injected
 * `fetch`, and exposes two narrow boundaries:
 *   - the publication transport consumed by src/publication.cts
 *     (getAuthenticatedUser, createReview, listReviews, listReviewComments),
 *     normalizing host readback into that module's private shapes; and
 *   - the trusted review context and source-snapshot boundary consumed by
 *     src/prepare-review.cts (fetchContext, and the readSource it returns);
 *   - the companion suggestion pull request transport consumed by
 *     src/review-preflight.cts and src/companion-publication.cts (see
 *     "Companion suggestion pull requests" below);
 *   - the suggestion cleanup transport consumed by
 *     src/close-suggestion-pull-requests.cts (see "Suggestion cleanup"
 *     below).
 *
 * It never decides placement, rendering, delivery or what to close; it never
 * retries a write, never submits an existing review, edits or deletes a
 * review, and never invents
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
 *   - The only non-GET requests are the single create-review POST, GraphQL
 *     POSTs whose document is a query (never a mutation), the companion
 *     writes below (Git blobs, trees and commits, one branch, one pull
 *     request, one label), and cleanup's close of one pull request (a PATCH
 *     whose body is exactly { state: 'closed' }). Nothing here ever deletes a
 *     branch, pull request, label or review, and nothing else updates one.
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
 *   'undecodable-source', 'source-too-large', 'rate-limited' (a close refused
 *   by a rate limit rather than by permission). Malformed caller input is a
 *   TypeError before any request.
 *
 * ---------------------------------------------------------------------------
 * Publication transport (see test/fixtures/publication/fake-github.mts)
 *
 *   getAuthenticatedUser() -> { id, login }          GET /user
 *   createReview({ owner, repo, pullNumber, commitId, body, event?, comments })
 *       -> { id, htmlUrl }
 *     Exactly one POST /repos/{o}/{r}/pulls/{n}/reviews with JSON
 *     { commit_id, body, comments: [{ path, body, line, side,
 *       start_line?, start_side? }] }. Without `event` the review is a pending
 *     draft and no `event` is sent; `event` may only be 'COMMENT', which is
 *     sent after `body` and creates the review already submitted as a comment
 *     review (never a verdict). Bodies are sent byte-for-byte. Never retried.
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
 *                  oldSourceCommit? }) -> { context, readSource, fileExists,
 *                                           readEntry }
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
 *   fileExists(commit, path) -> boolean
 *     The same tree walk as readSource, with the same path and commit
 *     validation and the same refusals, but it never requests or decodes a
 *     blob and has no size limit: true for a regular file (100644, 100755),
 *     false when a complete listing shows the path absent (or below a regular
 *     file). A directory, symlink or submodule at or above the path is
 *     'not-a-file'. Reads at every full commit are direct, including the
 *     diff base: a commit's own trees decide what exists in it. Used to
 *     confirm whole-file proposals (docs/file-operation-publication-contract.md).
 *
 *   readEntry(commit, path) -> { kind: 'file', blob, mode } | { kind: 'absent' }
 *                              | { kind: 'not-a-file', entry, path }
 *     The same tree walk and validation as fileExists, answering what stands
 *     there instead of refusing it: a regular file's blob id and mode
 *     (100644, 100755); absent when a complete listing shows the path absent
 *     (or below a regular file); otherwise 'a directory', 'a symbolic link'
 *     or 'a submodule' with the path where it stands (the path itself, or a
 *     link or submodule on the way, never followed). No blob is read. Used to
 *     re-apply suggestions onto a rewritten head
 *     (docs/companion-suggestion-pr-contract.md §2.5.1).
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
 * ---------------------------------------------------------------------------
 * Companion suggestion pull requests (docs/companion-suggestion-pr-contract.md)
 *
 *   readSuggestionTarget({ owner, repo, pullNumber })
 *       -> { headSha, headRef, headRepository, baseRef, baseRepository,
 *            defaultBranch, canPush }
 *     GET pull, GET repository. headRepository is null when the head
 *     repository was deleted; canPush is the account role's permissions.push.
 *   readDefaultBranchFile({ owner, repo, path, branch? })
 *       -> { branch, commit, content }
 *     The file at `path` on the current commit of the repository's default
 *     branch (docs/suggestion-pr-convention.md §4): GET repository for the
 *     default branch unless the caller already read it (`branch`), GET
 *     git/ref/heads/{branch} for its commit (404 is
 *     'malformed-response': a default branch always has one), then the same
 *     verified Git-object reads as readSource, never the Contents API.
 *     content: { kind: 'absent' } when a complete listing shows no such path;
 *     { kind: 'not-a-file', entry: 'a directory' | 'a symbolic link' |
 *     'a submodule', path } for anything at or above the path that is not a
 *     directory on the way or a regular file at the end (never followed),
 *     `path` naming where it stands;
 *     { kind: 'too-large', size } beyond maxSourceBytes (never downloaded);
 *     { kind: 'file', bytes } with the exact verified bytes, not decoded.
 *     Any failed read is an error, never absence.
 *   findLabel({ owner, repo, name }) -> the label's name as GitHub reports
 *     it, or null for 404 (GET labels/{name}, name percent-encoded)
 *   compareCommits({ owner, repo, base, head })
 *       -> 'identical' | 'ahead' | 'behind' | 'diverged'
 *     GET compare/{base}...{head}: its `status`, where `ahead` means `base`
 *     is an ancestor of `head` (contract §2.5). The merge base must agree:
 *     `base` for identical and ahead, `head` for behind; any other status or
 *     a contradicting merge base is 'malformed-response'. A refused read is
 *     'http-status', never a verdict.
 *   createProposalCommit({ owner, repo, parent, message, changes })
 *       -> { commit }
 *     changes: [{ operation: 'create', path, text, fileMode } |
 *               { operation: 'edit', path, text } | { operation: 'delete', path }]
 *     A created path must be absent at `parent`; an edited or deleted path
 *     must be a regular file there, whose mode an edit keeps. One POST
 *     git/blobs { content (base64 of the UTF-8 text), encoding: 'base64' }
 *     per created or edited file, whose answered sha must equal the blob id
 *     computed locally; one POST git/trees { base_tree: parent's tree, tree:
 *     [{ path, mode, type: 'blob', sha | null }] }; one POST git/commits
 *     { message, tree, parents: [parent] }. The commit is then read back: its
 *     tree and only parent, and every changed path (blob and mode, or
 *     absence) must be exactly as proposed, else 'blob-integrity'. These
 *     writes are never hostRejected: they are invisible until a branch names
 *     them, and repeating them creates nothing new.
 *   getBranch({ owner, repo, branch }) -> commit or null (404)
 *     GET git/ref/heads/{branch}, each segment percent-encoded.
 *   createBranch({ owner, repo, branch, commit })
 *     POST git/refs { ref: 'refs/heads/' + branch, sha }. Never force.
 *   createPullRequest({ owner, repo, title, head, base, body, draft })
 *       -> { number, htmlUrl }
 *     POST pulls { title, head, base, body, draft }; draft is a boolean.
 *   listBranchPullRequests({ owner, repo, branch })
 *       -> [{ number, htmlUrl, body, authorId, headRef, headRepository, baseRef }]
 *     Every page of GET pulls?head={owner}:{branch}&state=all.
 *   addLabels({ owner, repo, number, labels })
 *     POST issues/{number}/labels { labels } (a non-empty list of names).
 *   listLabels({ owner, repo, number }) -> names
 *     Every page of GET issues/{number}/labels.
 *   The three writes a person can see (createBranch, createPullRequest,
 *   addLabels) classify their answers like create-review: hostRejected only
 *   for the understood refusal statuses.
 *
 * ---------------------------------------------------------------------------
 * Suggestion cleanup (docs/suggestion-cleanup-contract.md)
 *
 *   listOpenLabeledPullRequests({ owner, repo, label })
 *       -> [{ number, htmlUrl, body, labels }]
 *     Every page of GET issues?labels={label}&state=open (the label filter is
 *     applied by the host; a label containing a comma, which GitHub reads as
 *     a list, is refused). Entries without a `pull_request` object are issues
 *     and are left out. A null body is ''. Host order; not deduplicated.
 *   getPullRequest({ owner, repo, pullNumber })
 *       -> { number, htmlUrl, state: 'open' | 'closed', merged, body, headRef,
 *            headRepository, baseRepository, labels }
 *     GET pull. The answer must name the requested pull request, with state
 *     open or closed and a boolean merged that is false while open;
 *     headRepository is null when the head repository was deleted. Anything
 *     else is 'malformed-response', never a guess.
 *   listCrossReferencingPullRequests({ owner, repo, pullNumber })
 *       -> [{ number, htmlUrl, repository, state: 'open' | 'closed' | 'merged',
 *             body, labels }]
 *     Every page of a GraphQL query of the pull request's timelineItems
 *     restricted to CROSS_REFERENCED_EVENT, following each event's source
 *     through a PullRequest fragment (variables { owner, repo, number, after }).
 *     Sources that are not pull requests, and sources in any other repository
 *     (compared case-insensitively), are left out before their state or
 *     labels are read or checked, so a foreign repository can never stop the
 *     traversal. `repository` is the source's repository as GitHub names it.
 *     A source with more than 100 labels has its labels read in full with
 *     listLabels. Timeline order; not deduplicated. Pagination is checked as
 *     for review threads.
 *   closePullRequest({ owner, repo, pullNumber })
 *     PATCH pull with exactly { state: 'closed' }; the answer must name the
 *     pull request as closed ('malformed-response' otherwise). A 429, or a 403
 *     with a rate-limit signal (x-ratelimit-remaining: 0, a retry-after
 *     header, or a message naming a rate limit), is 'rate-limited'; any other
 *     refusal is 'http-status' with its status. Never retried; hostRejected is
 *     always false.
 *
 * @see https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api
 * @see https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
 * @see https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files
 * @see https://docs.github.com/en/rest/commits/commits#compare-two-commits
 * @see https://docs.github.com/en/rest/repos/contents#get-repository-content
 * @see https://docs.github.com/en/rest/pulls/reviews
 * @see https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread
 * @see https://docs.github.com/en/rest/git/blobs#create-a-blob
 * @see https://docs.github.com/en/rest/git/trees#create-a-tree
 * @see https://docs.github.com/en/rest/git/commits#create-a-commit
 * @see https://docs.github.com/en/rest/git/refs
 * @see https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/pulls#list-pull-requests
 * @see https://docs.github.com/en/rest/issues/labels
 * @see https://docs.github.com/en/rest/repos/repos#get-a-repository
 * @see https://docs.github.com/en/rest/issues/issues#list-repository-issues
 * @see https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request
 * @see https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 * @see https://docs.github.com/en/graphql/reference/objects#crossreferencedevent
 */

import * as crypto from 'node:crypto';

import type { RepositoryFileContent } from './suggestion-pr-convention.cjs';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** Classification of every GitHubError this adapter raises (see the module documentation). */
export type GitHubErrorCode =
  | 'network'
  | 'http-status'
  | 'redirect'
  | 'unsafe-link'
  | 'malformed-response'
  | 'graphql-errors'
  | 'pagination'
  | 'head-race'
  | 'files-incomplete'
  | 'duplicate-file'
  | 'anchor-unavailable'
  | 'anchor-ambiguous'
  | 'anchor-malformed'
  | 'old-source-unverified'
  | 'rename-unsupported'
  | 'patch-unavailable'
  | 'source-inconsistent'
  | 'not-a-file'
  | 'blob-integrity'
  | 'undecodable-source'
  | 'source-too-large'
  | 'rate-limited';

/** Optional GitHubError details. An omitted `status` leaves the error without an own `status` key. */
export interface IGitHubErrorOptions {
  readonly status?: number | undefined;
  readonly hostRejected?: boolean | undefined;
  readonly cause?: unknown;
}

/** A review-comment side, in the create request and in thread anchors. */
export type ReviewSide = 'LEFT' | 'RIGHT';

/** Why a changed file's patch was dropped from the review context. */
export type FileDiagnosticReason = 'patch-omitted' | 'patch-inconsistent';

/** The HTTP methods this adapter ever sends (PATCH only to close a pull request). */
type HttpMethod = 'GET' | 'POST' | 'PATCH';

/**
 * The request options this adapter passes to fetch. `body` is present as
 * `undefined` on body-less requests (WHATWG fetch treats an undefined
 * dictionary member as absent).
 */
export interface IFetchInit {
  readonly method: HttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly redirect: 'manual';
}

/** The response headers this adapter reads: the pagination Link header, and a refused close's rate-limit headers. */
export interface IFetchResponseHeaders {
  get(name: string): string | null;
}

/** The subset of a WHATWG fetch Response this adapter reads. */
export interface IFetchResponse {
  readonly type: string;
  readonly status: number;
  readonly ok: boolean;
  readonly headers: IFetchResponseHeaders;
  text(): Promise<string>;
}

/** The subset of WHATWG fetch this adapter calls: always an absolute URL string and full options. */
export type FetchSubset = (url: string, init: IFetchInit) => Promise<IFetchResponse>;

/**
 * An injectable fetch: any implementation of the subset, or the platform
 * fetch itself. The platform fetch is named separately because Node's
 * declarations of RequestInit, read with exactOptionalPropertyTypes, do not
 * admit the `body: undefined` this adapter sends on body-less requests, which
 * fetch accepts at runtime.
 */
export type GitHubFetch = FetchSubset | typeof globalThis.fetch;

/** Resource limits; exceeding one is an error and nothing is truncated. */
export interface IGitHubClientLimits {
  readonly maxSourceBytes: number;
  readonly maxPullFiles: number;
  readonly maxPages: number;
}

/** Options of createGitHubClient. Every field is re-validated at runtime. */
export interface ICreateGitHubClientOptions {
  readonly token: string;
  readonly fetch?: GitHubFetch | undefined;
  readonly apiOrigin?: 'https://api.github.com' | undefined;
  readonly limits?: Partial<IGitHubClientLimits> | undefined;
}

/** The pull request a request addresses. */
export interface IPullRequestDestination {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
}

/** The authenticated user, identified by the numeric id GET /user reports. */
export interface IAuthenticatedUser {
  readonly id: number;
  readonly login: string;
}

/** One inline comment of a create-review request; the start fields go together or not at all. */
export interface IReviewCommentDraft {
  readonly path: string;
  readonly side: ReviewSide;
  readonly line: number;
  readonly startSide?: ReviewSide;
  readonly startLine?: number;
  readonly body: string;
}

/**
 * A create-review request: exactly these keys, nothing else. `event` is
 * present only to submit the new review as a comment review.
 */
export interface ICreateReviewRequest extends IPullRequestDestination {
  readonly commitId: string;
  readonly body: string;
  readonly event?: 'COMMENT';
  readonly comments: readonly IReviewCommentDraft[];
}

/** The review GitHub created. */
export interface ICreatedReview {
  readonly id: number;
  readonly htmlUrl: string;
}

/** One page request of a pull request's reviews; `cursor` is null or one this adapter issued. */
export interface IListReviewsRequest extends IPullRequestDestination {
  readonly cursor?: string | null | undefined;
}

/**
 * One listed review. Only `id` is validated here; every other field is the
 * host's value as received (the consumer validates what it relies on).
 */
export interface IReviewSummary {
  readonly id: number;
  readonly htmlUrl: unknown;
  readonly authorId: unknown;
  readonly authorLogin: unknown;
  readonly commitId: unknown;
  readonly state: unknown;
  readonly body: unknown;
}

/** One REST page of reviews and the adapter-issued cursor of the next page, if any. */
export interface IReviewPage {
  readonly reviews: readonly IReviewSummary[];
  readonly nextCursor: string | null;
}

/** A readback request: one complete enumeration of a review's comments. */
export interface IListReviewCommentsRequest extends IPullRequestDestination {
  readonly reviewId: number;
  readonly cursor?: null | undefined;
}

/** The original anchor of a review thread; the start fields are present together or not at all. */
export interface IReviewCommentAnchor {
  readonly path: string;
  readonly side: ReviewSide;
  readonly line: number;
  readonly startSide?: ReviewSide;
  readonly startLine?: number;
}

/** A read-back review comment: its thread's original anchor and its exact body. */
export interface IReadBackComment extends IReviewCommentAnchor {
  readonly body: string;
}

/** Every comment of one review, in REST order. */
export interface IReviewCommentPage {
  readonly comments: readonly IReadBackComment[];
  readonly nextCursor: null;
}

/** A review-context request; `oldSourceCommit` replaces the merge-base lookup when given. */
export interface IFetchContextRequest {
  readonly destination: IPullRequestDestination;
  readonly reviewedCommit: string;
  readonly oldSourceCommit?: string | undefined;
}

/** One changed file of the pull request, in host order; `patch` only when it is usable. */
export interface IPullFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly patch?: string;
}

/** Why a changed file carries no patch. */
export interface IFileDiagnostic {
  readonly path: string;
  readonly reason: FileDiagnosticReason;
}

/**
 * The pull request's current diff. `baseCommit` is the caller's
 * oldSourceCommit, or the host's merge base; `headCommit` is the host's pull
 * head. Host-supplied commits passed the adapter's full-commit check on
 * their string form (see hasFullShaForm) and are passed on as received, so
 * they are typed as unknown; the consumer validates them again.
 */
export interface IReviewDiff {
  readonly baseCommit: unknown;
  readonly headCommit: unknown;
  readonly files: readonly IPullFile[];
}

/** The trusted review context of one pull request (see the module documentation). */
export interface IReviewContext {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly reviewedCommit: string;
  /** Pinned pull head observed twice (host-supplied; see IReviewDiff). */
  readonly pullHead: unknown;
  /** base.sha; informational, never provenance (host-supplied; see IReviewDiff). */
  readonly currentBaseTip: unknown;
  readonly diff: IReviewDiff;
  readonly fileDiagnostics: readonly IFileDiagnostic[];
}

/** Exact text of the regular file at a path in a full commit, or null when it does not exist there. */
export type ReadSource = (commit: string, path: string) => Promise<string | null>;

/**
 * Whether a regular file exists at a path in a full commit, decided from Git
 * trees alone: no blob is downloaded or decoded, so the answer does not depend
 * on the file's size or encoding.
 */
export type FileExists = (commit: string, path: string) => Promise<boolean>;

/**
 * What stands at a path in a full commit, decided from Git trees alone: a
 * regular file's blob id and mode, nothing, or something that is not a file
 * (and where it stands: the path itself, or a link or submodule on the way).
 */
export type PathEntry =
  | { readonly kind: 'file'; readonly blob: string; readonly mode: '100644' | '100755' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'not-a-file'; readonly entry: 'a directory' | 'a symbolic link' | 'a submodule'; readonly path: string };

/** What stands at a path in a full commit (see PathEntry). */
export type ReadEntry = (commit: string, path: string) => Promise<PathEntry>;

/** GitHub's comparison of two commits: `ahead` means the base is an ancestor of the head. */
export type CommitComparison = 'identical' | 'ahead' | 'behind' | 'diverged';

/** The review context and the snapshot readers bound to it. */
export interface IFetchedContext {
  readonly context: IReviewContext;
  readonly readSource: ReadSource;
  readonly fileExists: FileExists;
  readonly readEntry: ReadEntry;
}

/** The branches and permissions a suggestion pull request depends on (read only when one is needed). */
export interface ISuggestionTarget {
  /** The pull request's current head commit. */
  readonly headSha: string;
  /** The pull request's head branch, which suggestion pull requests target. */
  readonly headRef: string;
  /** The head branch's repository (`owner/repo`), or null when it was deleted. */
  readonly headRepository: string | null;
  /** The pull request's base branch, which it merges into. */
  readonly baseRef: string;
  /** The pull request's own repository (`owner/repo`). */
  readonly baseRepository: string;
  readonly defaultBranch: string;
  /** Whether the authenticated account's role allows pushing to the repository. */
  readonly canPush: boolean;
}

/** A file on the current commit of a repository's default branch (readDefaultBranchFile). */
export interface IDefaultBranchFile {
  /** The default branch's name. */
  readonly branch: string;
  /** The commit it pointed at when read. */
  readonly commit: string;
  readonly content: RepositoryFileContent;
}

/** One change of a proposal commit: exact new text for a created or edited file, or a deletion. */
export type ProposalChange =
  | { readonly operation: 'create'; readonly path: string; readonly text: string; readonly fileMode: '100644' | '100755' }
  | { readonly operation: 'edit'; readonly path: string; readonly text: string }
  | { readonly operation: 'delete'; readonly path: string };

/** A created and verified proposal commit. */
export interface IProposalCommit {
  readonly commit: string;
}

/** One entry of a create-tree request. */
interface ICreateTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: 'blob';
  readonly sha: string | null;
}

/** The pull request GitHub created. */
export interface ICreatedPullRequest {
  readonly number: number;
  readonly htmlUrl: string;
}

/**
 * One pull request from a branch. Only `number` is validated here; every
 * other field is the host's value as received (the consumer validates what
 * it relies on).
 */
export interface IBranchPullRequest {
  readonly number: number;
  readonly htmlUrl: unknown;
  readonly body: unknown;
  readonly authorId: unknown;
  readonly headRef: unknown;
  readonly headRepository: unknown;
  readonly baseRef: unknown;
}

/** One open pull request carrying a label, as the labeled issues listing reports it. */
export interface ILabeledPullRequest {
  readonly number: number;
  readonly htmlUrl: string;
  /** The description ('' when it has none). */
  readonly body: string;
  /** Label names as GitHub reports them. */
  readonly labels: readonly string[];
}

/** A pull request's current state and the fields suggestion cleanup verifies. */
export interface IPullRequestSnapshot {
  readonly number: number;
  readonly htmlUrl: string;
  readonly state: 'open' | 'closed';
  /** Whether it was merged; always false while open. */
  readonly merged: boolean;
  /** The description ('' when it has none). */
  readonly body: string;
  readonly headRef: string;
  /** The head branch's repository (`owner/repo`), or null when it was deleted. */
  readonly headRepository: string | null;
  /** The pull request's own repository (`owner/repo`). */
  readonly baseRepository: string;
  /** Label names as GitHub reports them. */
  readonly labels: readonly string[];
}

/** A pull request whose body or comments reference another pull request (a cross-reference backlink). */
export interface ICrossReferencingPullRequest {
  readonly number: number;
  readonly htmlUrl: string;
  /** The repository holding it (`owner/name`), as GitHub names it: always the requested one, possibly in another letter case. */
  readonly repository: string;
  readonly state: 'open' | 'closed' | 'merged';
  /** The description ('' when it has none). */
  readonly body: string;
  /** Every label name, as GitHub reports it. */
  readonly labels: readonly string[];
}

/**
 * The frozen client createGitHubClient returns: the publication transport
 * (getAuthenticatedUser, createReview, listReviews, listReviewComments),
 * fetchContext, the companion suggestion pull request transport, and the
 * suggestion cleanup transport. Every method re-validates its input at
 * runtime.
 */
export interface IGitHubClient {
  readonly getAuthenticatedUser: () => Promise<IAuthenticatedUser>;
  readonly createReview: (request: ICreateReviewRequest) => Promise<ICreatedReview>;
  readonly listReviews: (request: IListReviewsRequest) => Promise<IReviewPage>;
  readonly listReviewComments: (request: IListReviewCommentsRequest) => Promise<IReviewCommentPage>;
  readonly fetchContext: (request: IFetchContextRequest) => Promise<IFetchedContext>;
  readonly readSuggestionTarget: (request: IPullRequestDestination) => Promise<ISuggestionTarget>;
  readonly findLabel: (request: { readonly owner: string; readonly repo: string; readonly name: string }) => Promise<string | null>;
  readonly compareCommits: (request: { readonly owner: string; readonly repo: string; readonly base: string; readonly head: string }) => Promise<CommitComparison>;
  readonly readDefaultBranchFile: (request: {
    readonly owner: string;
    readonly repo: string;
    readonly path: string;
    /** The default branch, when the caller has already read it from the repository. */
    readonly branch?: string | undefined;
  }) => Promise<IDefaultBranchFile>;
  readonly createProposalCommit: (request: {
    readonly owner: string;
    readonly repo: string;
    readonly parent: string;
    readonly message: string;
    readonly changes: readonly ProposalChange[];
  }) => Promise<IProposalCommit>;
  readonly getBranch: (request: { readonly owner: string; readonly repo: string; readonly branch: string }) => Promise<string | null>;
  readonly createBranch: (request: { readonly owner: string; readonly repo: string; readonly branch: string; readonly commit: string }) => Promise<void>;
  readonly createPullRequest: (request: {
    readonly owner: string;
    readonly repo: string;
    readonly title: string;
    readonly head: string;
    readonly base: string;
    readonly body: string;
    readonly draft: boolean;
  }) => Promise<ICreatedPullRequest>;
  readonly listBranchPullRequests: (request: { readonly owner: string; readonly repo: string; readonly branch: string }) => Promise<readonly IBranchPullRequest[]>;
  readonly addLabels: (request: { readonly owner: string; readonly repo: string; readonly number: number; readonly labels: readonly string[] }) => Promise<void>;
  readonly listLabels: (request: { readonly owner: string; readonly repo: string; readonly number: number }) => Promise<readonly string[]>;
  readonly listOpenLabeledPullRequests: (request: { readonly owner: string; readonly repo: string; readonly label: string }) => Promise<readonly ILabeledPullRequest[]>;
  readonly getPullRequest: (request: IPullRequestDestination) => Promise<IPullRequestSnapshot>;
  readonly listCrossReferencingPullRequests: (request: IPullRequestDestination) => Promise<readonly ICrossReferencingPullRequest[]>;
  readonly closePullRequest: (request: IPullRequestDestination) => Promise<void>;
}

/**
 * Any non-null, non-array object (JSON answers, caller input). Its members
 * are unknown until checked.
 */
type UntrustedObject = Readonly<Record<string, unknown>>;

/** A method's input before validation: every documented field may be anything, including absent. */
type Unchecked<Keys extends string> = { readonly [Key in Keys]?: unknown };

/** The request headers this adapter sends, in the order it adds them. */
type RequestHeaders = {
  Authorization: string;
  'User-Agent': string;
  Accept?: string;
  'X-GitHub-Api-Version'?: string;
  'Content-Type'?: string;
};

/** The create-review POST body; `event` only for a submitted comment review. */
interface ICreateReviewPayload {
  readonly commit_id: string;
  readonly body: string;
  readonly event?: 'COMMENT';
  readonly comments: readonly ICreateReviewCommentPayload[];
}

interface ICreateReviewCommentPayload {
  path: string;
  body: string;
  line: number;
  side: ReviewSide;
  start_line?: number;
  start_side?: ReviewSide;
}

/** A REST review comment as validated before the anchor join; anchor fields stay unchecked. */
interface IRestReviewComment {
  readonly id: number;
  readonly pull_request_review_id: number;
  readonly path: string;
  readonly body: string;
  readonly original_commit_id: string;
  readonly original_line?: unknown;
  readonly side?: unknown;
  readonly original_start_line?: unknown;
  readonly start_side?: unknown;
}

/** A pull request file entry as validated. */
interface IPullFileEntry {
  readonly filename: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string | undefined;
  readonly previous_filename?: string | undefined;
}

/**
 * A validated tree entry. `mode` and `type` are only known to be a pair of
 * TREE_ENTRY_TYPES (or both absent from it), and `sha` to have a full-commit
 * string form, so they stay unknown.
 */
interface ITreeEntry {
  readonly path: string;
  readonly mode: unknown;
  readonly type: unknown;
  readonly sha: unknown;
  readonly size?: number | undefined;
}

/** Where a walk down a commit's trees ended: at the path's entry (or its absence), or at what it would read through. */
type PathWalk =
  | { readonly kind: 'entry'; readonly entry: ITreeEntry | null }
  | { readonly kind: 'through'; readonly at: string; readonly entry: 'a symbolic link' | 'a submodule' };

/** A pull request's pinned commits and changed-file count. */
interface IPullSnapshot {
  readonly head: unknown;
  readonly base: unknown;
  readonly changedFiles: number;
}

/** Old-side text reproduced from a patch, or the patch's word that no old file existed. */
type ReversedPatch = { readonly absent: true; readonly text?: never } | { readonly absent?: never; readonly text: string };

/** A thrown value's redacted description; `code` is copied only when it is a string. */
interface IErrorDescription extends Error {
  code?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

/** Page size requested from the GraphQL timelineItems connection (its maximum). */
const TIMELINE_PER_PAGE = 100;

/** Labels read with each cross-referencing pull request (the connection's maximum); more are read through REST. */
const SOURCE_LABELS = 100;

/** GraphQL pull request states, as cleanup names them. */
const GRAPHQL_PULL_STATES: ReadonlyMap<unknown, ICrossReferencingPullRequest['state']> = new Map([
  ['OPEN', 'open'],
  ['CLOSED', 'closed'],
  ['MERGED', 'merged'],
]);

const DEFAULT_LIMITS: Readonly<IGitHubClientLimits> = Object.freeze({ maxSourceBytes: 1_000_000, maxPullFiles: 3000, maxPages: 100 });

/**
 * Create-review answers understood as the host declining the request. Any
 * other status leaves open whether the review was created.
 */
const DEFINITIVE_CREATE_REFUSALS: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 422, 429]);

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
// Keyed by unknown: it is looked up with the host's unchecked mode value.
const TREE_ENTRY_TYPES: ReadonlyMap<unknown, string> = new Map([
  [TREE_MODE, 'tree'],
  ['100644', 'blob'],
  ['100755', 'blob'],
  [SYMLINK_MODE, 'blob'],
  [SUBMODULE_MODE, 'commit'],
]);

/** Modes of regular files, the only tree entries whose blob is source text. */
const REGULAR_FILE_MODES: ReadonlySet<unknown> = new Set(['100644', '100755']);

/** Review-comment sides in the create request and in thread anchors. */
const SIDES: ReadonlySet<unknown> = new Set<ReviewSide>(['LEFT', 'RIGHT']);

/** Keys a create request and its comments may carry; anything else is refused. */
const CREATE_KEYS: readonly string[] = ['body', 'comments', 'commitId', 'owner', 'pullNumber', 'repo'];
const SUBMITTED_CREATE_KEYS: readonly string[] = [...CREATE_KEYS, 'event'].sort();
const COMMENT_KEYS: ReadonlySet<string> = new Set(['path', 'side', 'line', 'startSide', 'startLine', 'body']);

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
      reviewThreads(first: ${String(THREADS_PER_PAGE)}, after: $after) {
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
 * The pull requests that cross-reference one pull request: its timeline's
 * cross-reference events, each followed to its source when that is a pull
 * request (D21). The first 100 labels of each source share the request.
 */
const CROSS_REFERENCES_QUERY = gql`query ($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      timelineItems(first: ${String(TIMELINE_PER_PAGE)}, after: $after, itemTypes: [CROSS_REFERENCED_EVENT]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on PullRequest {
                number
                url
                body
                state
                repository { nameWithOwner }
                labels(first: ${String(SOURCE_LABELS)}) { pageInfo { hasNextPage } nodes { name } }
              }
            }
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
export class GitHubError extends Error {
  // `declare`: no class-field initialization. The constructor alone creates
  // these own properties, in this order, and `status` only when one is given.
  declare readonly code: GitHubErrorCode;
  declare readonly status?: number;
  declare readonly hostRejected: boolean;

  constructor(code: GitHubErrorCode, message: string, { status, hostRejected = false, cause }: IGitHubErrorOptions = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GitHubError';
    this.code = code;
    if (status !== undefined) this.status = status;
    this.hostRejected = hostRejected;
  }
}

function isPlainObject(value: unknown): value is UntrustedObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Array.isArray without its `any[]` narrowing: the elements are unknown until checked. */
function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

function isSide(value: unknown): value is ReviewSide {
  return SIDES.has(value);
}

/**
 * Whether a host value's string form is a full commit. RegExp#test converts
 * its argument with the same ToString as String() for every JSON value, so a
 * value that is not a string (in practice only a one-element array) is judged
 * by its string form and passed on as received.
 */
function hasFullShaForm(value: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- deliberately the ToString RegExp#test applies; an object's '[object Object]' form can never match FULL_SHA
  return FULL_SHA.test(String(value ?? ''));
}

/**
 * `value?.[k1]?.[k2]...` over an untrusted value: each read stops at null or
 * undefined and otherwise reads the property, inherited ones included, as a
 * member expression would.
 */
function optionalMember(value: unknown, ...keys: readonly PropertyKey[]): unknown {
  let current = value;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    current = Reflect.get(Object.prototype.valueOf.call(current), key);
  }
  return current;
}

/**
 * The fetch the client calls. Only a function can be checked at runtime; its
 * signature is the injector's contract.
 */
function isFetch(value: unknown): value is FetchSubset {
  return typeof value === 'function';
}

function requireInput(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid GitHub adapter input: ${message}`);
}

function isRepoName(value: unknown): value is string {
  return typeof value === 'string' && REPO_NAME.test(value) && value !== '.' && value !== '..';
}

function requireDestination(destination: UntrustedObject): asserts destination is UntrustedObject & IPullRequestDestination {
  const { owner, repo, pullNumber } = destination;
  requireInput(isRepoName(owner), 'owner must be a GitHub account name');
  requireInput(isRepoName(repo), 'repo must be a GitHub repository name');
  requireInput(isPositiveInteger(pullNumber), 'pullNumber must be a positive integer');
}

/** Whether a host value is one of the four statuses GitHub's commit comparison documents. */
function isCommitComparison(value: unknown): value is CommitComparison {
  return value === 'identical' || value === 'ahead' || value === 'behind' || value === 'diverged';
}

function requireFullSha(value: unknown, name: string): asserts value is string {
  requireInput(typeof value === 'string' && FULL_SHA.test(value), `${name} must be a full lowercase 40-hex commit`);
}

/** Whether a repository-relative path is safe to address: no traversal or ambiguity. */
function requireRepositoryPath(filePath: unknown): asserts filePath is string {
  requireInput(typeof filePath === 'string' && filePath.length > 0, 'path must be a non-empty string');
  requireInput(!filePath.includes('\\') && !filePath.includes('\0'), 'path must not contain backslashes or NUL');
  requireInput(
    filePath.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'path must be repository-relative without empty, "." or ".." segments',
  );
}

/** Every limit is a known name with a positive integer value. */
function requireLimits(limits: UntrustedObject): asserts limits is UntrustedObject & IGitHubClientLimits {
  for (const [name, value] of Object.entries(limits)) {
    requireInput(Object.hasOwn(DEFAULT_LIMITS, name), `unknown limit ${name}`);
    requireInput(isPositiveInteger(value), `limits.${name} must be a positive integer`);
  }
}

/** Git blob object id of raw bytes ("blob <size>\0" + bytes, SHA-1). */
function gitBlobSha(bytes: Buffer): string {
  return crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${String(bytes.length)}\0`, 'utf8'), bytes]))
    .digest('hex');
}

/** Physical lines of a text, each keeping its own terminator; a lone CR is content. */
function physicalLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Whether a Link header's rel value names the next page. */
function isNextRel(rel: string): boolean {
  return rel.split(/\s+/).includes('next');
}

/** The href of a Link header's rel="next" entry, or null. */
function nextLinkHref(header: string | null): string | null {
  if (!header) return null;
  for (const match of header.matchAll(/<([^>]*)>\s*;\s*rel="([^"]*)"/g)) {
    // Both groups are mandatory, so a match always captures them.
    const [, href, rel] = match;
    if (href !== undefined && rel !== undefined && isNextRel(rel)) return href;
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
function reverseApplyPatch(newText: string | null, patch: string, filePath: string): ReversedPatch {
  const fail: (why: string) => never = (why) => {
    throw new GitHubError('old-source-unverified', `The patch for ${filePath} does not reproduce an old side: ${why}.`);
  };
  const patchLines = patch.split('\n');
  if (patchLines.at(-1) === '') patchLines.pop();
  const newLines = physicalLines(newText ?? '');
  const oldLines: string[] = [];
  let newIndex = 0;
  let oldAbsent = false;
  let newAbsent = false;
  let hunks = 0;
  let i = 0;
  while (i < patchLines.length) {
    // In range by the loop condition; '' (never a header) only satisfies the type.
    const header = HUNK_HEADER.exec(patchLines[i] ?? '');
    if (!header) fail(`line ${String(i + 1)} is not a hunk header`);
    hunks += 1;
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    if (oldCount === 0 && oldStart === 0) oldAbsent = true;
    if (newCount === 0 && newStart === 0) newAbsent = true;
    const hunkNewIndex = newCount === 0 ? newStart : newStart - 1;
    if (hunkNewIndex < newIndex || hunkNewIndex > newLines.length) fail('hunks overlap or lie outside the new text');
    for (const line of newLines.slice(newIndex, hunkNewIndex)) oldLines.push(line);
    newIndex = hunkNewIndex;
    const expectedOldIndex = oldCount === 0 ? oldStart : oldStart - 1;
    if (oldLines.length !== expectedOldIndex) fail('hunk offsets disagree with the unchanged text between hunks');
    let oldSeen = 0;
    let newSeen = 0;
    i += 1;
    while (oldSeen < oldCount || newSeen < newCount) {
      // Past the last patch line exactly when the index is out of range.
      const line = patchLines[i];
      if (line === undefined) fail('a hunk ends before its line counts are reached');
      const kind = line[0];
      const noNewline = patchLines[i + 1]?.startsWith('\\') === true;
      const text = line.slice(1) + (noNewline ? '' : '\n');
      if (kind === ' ' || kind === '+') {
        if (newLines[newIndex] !== text) fail(`new-side line ${String(newIndex + 1)} differs from the patch`);
        newIndex += 1;
        newSeen += 1;
      }
      if (kind === ' ' || kind === '-') {
        oldLines.push(text);
        oldSeen += 1;
      }
      if (kind !== ' ' && kind !== '+' && kind !== '-') fail(`line ${String(i + 1)} is not a hunk body line`);
      i += noNewline ? 2 : 1;
    }
    if (oldSeen !== oldCount || newSeen !== newCount) fail('a hunk body disagrees with its line counts');
  }
  if (hunks === 0) fail('it has no hunks');
  for (const line of newLines.slice(newIndex)) oldLines.push(line);
  if (newAbsent && newText !== null) fail('it deletes a file that exists');
  if (!newAbsent && newText === null) fail('it changes a file that does not exist');
  if (oldAbsent) {
    if (oldLines.length !== 0) fail('it creates a file but leaves old text');
    return { absent: true };
  }
  return { text: oldLines.join('') };
}

/** Number of '+' and '-' body lines in a patch, excluding markers and headers. */
function patchCounts(patch: string): { readonly additions: number; readonly deletions: number } {
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
 * @param options - see module documentation
 * @returns the publication transport plus fetchContext
 */
export function createGitHubClient(options: ICreateGitHubClientOptions): IGitHubClient {
  // JavaScript callers are unconstrained: every option is checked from unknown.
  const input: unknown = options;
  requireInput(isPlainObject(input), 'options must be an object');
  const {
    token: tokenInput,
    fetch: fetchInput = globalThis.fetch,
    apiOrigin = API_ORIGIN,
    limits: limitOverrides = {},
  } = input;
  requireInput(typeof tokenInput === 'string' && tokenInput.length > 0, 'token must be a non-empty string');
  requireInput(isFetch(fetchInput), 'fetch must be a function');
  requireInput(apiOrigin === API_ORIGIN, `apiOrigin must be ${API_ORIGIN}`);
  requireInput(isPlainObject(limitOverrides), 'limits must be an object');
  const mergedLimits: UntrustedObject = { ...DEFAULT_LIMITS, ...limitOverrides };
  requireLimits(mergedLimits);
  const token: string = tokenInput;
  const fetchImpl: FetchSubset = fetchInput;
  const limits: IGitHubClientLimits = mergedLimits;

  // ---------------------------------------------------------------------------
  // Credential-safe HTTP
  // ---------------------------------------------------------------------------

  /** Removes the token from any host- or fetch-supplied text. */
  function redact(value: unknown): string {
    return String(value).split(token).join('[redacted]');
  }

  /**
   * A redacted, cause-free description of a thrown value. Raw errors from
   * fetch or parsing may carry request configuration or echoed headers, so
   * they are never attached as-is.
   */
  function describeCause(thrown: unknown): IErrorDescription {
    const description: IErrorDescription = new Error(
      redact(thrown && optionalMember(thrown, 'message') !== undefined ? optionalMember(thrown, 'message') : thrown),
    );
    const name = thrown ? optionalMember(thrown, 'name') : undefined;
    if (thrown && typeof name === 'string') description.name = redact(name);
    const code = thrown ? optionalMember(thrown, 'code') : undefined;
    if (thrown && typeof code === 'string') description.code = redact(code);
    return description;
  }

  function repoPath(owner: string, repo: string): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  /** Sends one request to the API origin; a thrown fetch or redirect is a GitHubError. */
  async function send(
    method: HttpMethod,
    url: string,
    { body, graphql = false }: { readonly body?: unknown; readonly graphql?: boolean } = {},
  ): Promise<IFetchResponse> {
    if (new URL(url).origin !== API_ORIGIN) {
      throw new GitHubError('unsafe-link', 'Refusing to send credentials outside the GitHub API origin.');
    }
    const headers: RequestHeaders = { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT };
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
  async function jsonBody(response: IFetchResponse, what: string): Promise<unknown> {
    let text;
    try {
      text = await response.text();
    } catch (err) {
      throw new GitHubError('network', `The ${what} response body could not be read.`, { cause: describeCause(err) });
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed;
    } catch (err) {
      throw new GitHubError('malformed-response', `The ${what} response is not JSON.`, { cause: describeCause(err) });
    }
  }

  /** The host's explanation in an error answer (its message and errors), or '' when it gives none. */
  async function explanationOf(response: IFetchResponse): Promise<string> {
    try {
      const parsed: unknown = JSON.parse(await response.text());
      const parts: string[] = [];
      if (isPlainObject(parsed) && typeof parsed['message'] === 'string') parts.push(parsed['message']);
      if (isPlainObject(parsed) && isList(parsed['errors'])) {
        for (const e of parsed['errors']) parts.push(typeof e === 'string' ? e : JSON.stringify(e));
      }
      return parts.join('; ');
    } catch {
      // The status alone still classifies the failure.
      return '';
    }
  }

  /** The redacted text of an error answer to `what`. */
  function answeredWith(response: IFetchResponse, what: string, explanation: string): string {
    return redact(`GitHub answered the ${what} with HTTP ${String(response.status)}${explanation === '' ? '' : `: ${explanation}`}`);
  }

  /** An http-status error carrying the host's redacted explanation. */
  async function statusError(response: IFetchResponse, what: string, hostRejected = false): Promise<GitHubError> {
    const explanation = await explanationOf(response);
    return new GitHubError('http-status', answeredWith(response, what, explanation), { status: response.status, hostRejected });
  }

  /** GET a REST resource; returns { body, link }. */
  async function restGet(url: string, what: string): Promise<{ readonly body: unknown; readonly link: string | null }> {
    const response = await send('GET', url);
    if (!response.ok) throw await statusError(response, what);
    return { body: await jsonBody(response, what), link: response.headers.get('link') };
  }

  /**
   * The page number a validated rel="next" link names after `page`, or null
   * when there is none. The link must address the same endpoint on the API
   * origin, carry no credentials, and name exactly the following page. A
   * filtered listing's `filter` parameters must be repeated exactly, and no
   * other parameter may appear.
   */
  function nextPage(
    linkHeader: string | null,
    owner: string,
    repo: string,
    suffix: string,
    page: number,
    filter: Readonly<Record<string, string>> = {},
  ): number | null {
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
    const filterOk = Object.entries(filter).every(([key, value]) => url.searchParams.get(key) === value);
    const queryOk =
      params.every((k) => k === 'page' || k === 'per_page' || Object.hasOwn(filter, k)) &&
      new Set(params).size === params.length &&
      filterOk &&
      (url.searchParams.get('per_page') ?? String(PER_PAGE)) === String(PER_PAGE);
    if (url.origin !== API_ORIGIN || url.username || url.password || url.hash || !endpointOk || !queryOk) {
      throw new GitHubError('unsafe-link', 'A pagination link leaves the requested endpoint; it is not followed.');
    }
    const next = url.searchParams.get('page');
    if (next !== String(page + 1)) {
      throw new GitHubError('pagination', `A pagination link names page ${redact(next)} after page ${String(page)}.`);
    }
    if (page + 1 > limits.maxPages) {
      throw new GitHubError('pagination', `Pagination exceeded ${String(limits.maxPages)} pages.`);
    }
    return page + 1;
  }

  function pageUrl(owner: string, repo: string, suffix: string, page: number, filter: Readonly<Record<string, string>> = {}): string {
    const filtered = Object.entries(filter).map(([key, value]) => `${key}=${encodeURIComponent(value)}&`).join('');
    return `${API_ORIGIN}${repoPath(owner, repo)}${suffix}?${filtered}per_page=${String(PER_PAGE)}&page=${String(page)}`;
  }

  /** Every item of a paginated REST listing, in host order; `filter` names fixed query parameters. */
  async function listAll(
    owner: string,
    repo: string,
    suffix: string,
    what: string,
    filter: Readonly<Record<string, string>> = {},
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let page: number | null = 1; page !== null; ) {
      const { body, link } = await restGet(pageUrl(owner, repo, suffix, page, filter), what);
      if (!isList(body)) throw new GitHubError('malformed-response', `The ${what} page is not a list.`);
      items.push(...body);
      page = nextPage(link, owner, repo, suffix, page, filter);
    }
    return items;
  }

  // ---------------------------------------------------------------------------
  // Publication transport
  // ---------------------------------------------------------------------------

  async function getAuthenticatedUser(): Promise<IAuthenticatedUser> {
    const { body } = await restGet(`${API_ORIGIN}/user`, 'authenticated user request');
    if (!isPlainObject(body) || !isPositiveInteger(body['id']) || typeof body['login'] !== 'string') {
      throw new GitHubError('malformed-response', 'The authenticated user has no numeric id and login.');
    }
    return { id: body['id'], login: body['login'] };
  }

  function createPayload(request: unknown): ICreateReviewPayload {
    requireInput(isPlainObject(request), 'the create request must be an object');
    const keys = Object.keys(request).sort();
    const submitted = Object.hasOwn(request, 'event');
    const expectedKeys = submitted ? SUBMITTED_CREATE_KEYS : CREATE_KEYS;
    requireInput(
      keys.length === expectedKeys.length && keys.every((k, i) => k === expectedKeys[i]),
      `the create request must have exactly ${CREATE_KEYS.join(', ')} and optionally event`,
    );
    const event = request['event'];
    requireInput(!submitted || event === 'COMMENT', "event must be 'COMMENT' when present; a review verdict is never sent");
    requireDestination(request);
    requireFullSha(request['commitId'], 'commitId');
    requireInput(typeof request['body'] === 'string', 'body must be a string');
    requireInput(isList(request['comments']), 'comments must be a list');
    const comments = request['comments'].map((c, i) => {
      requireInput(isPlainObject(c), `comments[${String(i)}] must be an object`);
      for (const key of Object.keys(c)) requireInput(COMMENT_KEYS.has(key), `comments[${String(i)}] has unsupported field ${key}`);
      requireInput(typeof c['path'] === 'string' && c['path'].length > 0, `comments[${String(i)}].path must be a non-empty string`);
      requireInput(isSide(c['side']), `comments[${String(i)}].side must be LEFT or RIGHT`);
      requireInput(isPositiveInteger(c['line']), `comments[${String(i)}].line must be a positive integer`);
      requireInput(typeof c['body'] === 'string', `comments[${String(i)}].body must be a string`);
      const hasStart = Object.hasOwn(c, 'startSide');
      requireInput(hasStart === Object.hasOwn(c, 'startLine'), `comments[${String(i)}] start fields go together`);
      const payload: ICreateReviewCommentPayload = { path: c['path'], body: c['body'], line: c['line'], side: c['side'] };
      if (hasStart) {
        requireInput(isSide(c['startSide']), `comments[${String(i)}].startSide must be LEFT or RIGHT`);
        requireInput(isPositiveInteger(c['startLine']), `comments[${String(i)}].startLine must be a positive integer`);
        payload.start_line = c['startLine'];
        payload.start_side = c['startSide'];
      }
      return payload;
    });
    // The draft payload keeps exactly the key set and order it always had.
    return event === 'COMMENT'
      ? { commit_id: request['commitId'], body: request['body'], event, comments }
      : { commit_id: request['commitId'], body: request['body'], comments };
  }

  // The declared request type is the consumer's contract; createPayload checks
  // it from unknown before any field is used.
  async function createReview(request: ICreateReviewRequest): Promise<ICreatedReview> {
    const payload = createPayload(request);
    const url = `${API_ORIGIN}${repoPath(request.owner, request.repo)}/pulls/${String(request.pullNumber)}/reviews`;
    const response = await send('POST', url, { body: payload });
    if (!response.ok) {
      throw await statusError(response, 'create-review request', DEFINITIVE_CREATE_REFUSALS.has(response.status));
    }
    const body = await jsonBody(response, 'create-review');
    if (!isPlainObject(body) || !isPositiveInteger(body['id']) || typeof body['html_url'] !== 'string') {
      throw new GitHubError('malformed-response', 'The create-review answer names no review; the outcome is unknown.');
    }
    return { id: body['id'], htmlUrl: body['html_url'] };
  }

  async function listReviews({
    owner: ownerInput,
    repo: repoInput,
    pullNumber: pullNumberInput,
    cursor,
  }: Unchecked<'owner' | 'repo' | 'pullNumber' | 'cursor'> = {}): Promise<IReviewPage> {
    const destination = { owner: ownerInput, repo: repoInput, pullNumber: pullNumberInput };
    requireDestination(destination);
    const { owner, repo, pullNumber } = destination;
    requireInput(
      cursor === null || cursor === undefined || (typeof cursor === 'string' && /^[1-9]\d{0,5}$/.test(cursor)),
      'cursor must be null or a cursor this adapter issued',
    );
    const page = cursor ? Number(cursor) : 1;
    requireInput(page <= limits.maxPages, 'cursor exceeds the page limit');
    const suffix = `/pulls/${String(pullNumber)}/reviews`;
    const { body, link } = await restGet(pageUrl(owner, repo, suffix, page), 'review list');
    if (!isList(body)) throw new GitHubError('malformed-response', 'The review list page is not a list.');
    const reviews = body.map((r): IReviewSummary => {
      if (!isPlainObject(r) || !isPositiveInteger(r['id'])) {
        throw new GitHubError('malformed-response', 'A review in the list has no numeric id.');
      }
      const user = isPlainObject(r['user']) ? r['user'] : null;
      return {
        id: r['id'],
        htmlUrl: r['html_url'],
        authorId: user ? user['id'] : null,
        authorLogin: user ? user['login'] : null,
        commitId: r['commit_id'],
        state: r['state'],
        body: r['body'],
      };
    });
    const next = nextPage(link, owner, repo, suffix, page);
    return { reviews, nextCursor: next === null ? null : String(next) };
  }

  /** Every review-thread node of a pull request, across all GraphQL pages. */
  async function listReviewThreads(owner: string, repo: string, pullNumber: number): Promise<unknown[]> {
    const nodes: unknown[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    for (let pages = 1; ; pages += 1) {
      if (pages > limits.maxPages) throw new GitHubError('pagination', `Review threads exceeded ${String(limits.maxPages)} pages.`);
      const response = await send('POST', `${API_ORIGIN}/graphql`, {
        graphql: true,
        body: { query: REVIEW_THREADS_QUERY, variables: { owner, repo, number: pullNumber, after } },
      });
      if (!response.ok) throw await statusError(response, 'review-thread query');
      const body = await jsonBody(response, 'review-thread query');
      if (isPlainObject(body) && isList(body['errors']) && body['errors'].length > 0) {
        const types = body['errors'].map((e) => (isPlainObject(e) ? e['type'] || e['message'] : String(e))).join('; ');
        throw new GitHubError('graphql-errors', redact(`The review-thread query returned errors: ${types}`));
      }
      const threads = optionalMember(body, 'data', 'repository', 'pullRequest', 'reviewThreads');
      if (!isPlainObject(threads) || !isList(threads['nodes']) || !isPlainObject(threads['pageInfo'])) {
        throw new GitHubError('malformed-response', 'The review-thread query returned no thread connection.');
      }
      nodes.push(...threads['nodes']);
      const { hasNextPage, endCursor } = threads['pageInfo'];
      if (hasNextPage === false) return nodes;
      if (hasNextPage !== true || typeof endCursor !== 'string' || endCursor === '' || seen.has(endCursor)) {
        throw new GitHubError('pagination', 'The review-thread pagination is missing or repeats a cursor.');
      }
      seen.add(endCursor);
      after = endCursor;
    }
  }

  /** The original anchor of one thread, or an anchor-malformed error. */
  function threadAnchor(thread: UntrustedObject, commentId: number): IReviewCommentAnchor {
    const bad = (why: string): GitHubError =>
      new GitHubError('anchor-malformed', `The thread of comment ${String(commentId)} has ${why}.`);
    if (thread['subjectType'] !== 'LINE') throw bad('no line subject');
    if (typeof thread['path'] !== 'string' || thread['path'] === '') throw bad('no path');
    if (!isSide(thread['diffSide'])) throw bad('no valid side');
    if (!isPositiveInteger(thread['originalLine'])) throw bad('no original line');
    const anchor: { -readonly [Key in keyof IReviewCommentAnchor]: IReviewCommentAnchor[Key] } = {
      path: thread['path'],
      side: thread['diffSide'],
      line: thread['originalLine'],
    };
    const hasStartLine = thread['originalStartLine'] !== null && thread['originalStartLine'] !== undefined;
    const hasStartSide = thread['startDiffSide'] !== null && thread['startDiffSide'] !== undefined;
    if (hasStartLine !== hasStartSide) throw bad('a start line without a start side (or the reverse)');
    if (hasStartLine) {
      if (!isPositiveInteger(thread['originalStartLine']) || !isSide(thread['startDiffSide'])) throw bad('an invalid start');
      anchor.startSide = thread['startDiffSide'];
      anchor.startLine = thread['originalStartLine'];
    }
    return anchor;
  }

  /** Whether a listed REST comment belongs to the review and carries the fields the join needs. */
  function isRestReviewComment(c: unknown, reviewId: number): c is IRestReviewComment {
    return (
      isPlainObject(c) &&
      isPositiveInteger(c['id']) &&
      c['pull_request_review_id'] === reviewId &&
      typeof c['path'] === 'string' &&
      typeof c['body'] === 'string' &&
      typeof c['original_commit_id'] === 'string'
    );
  }

  async function listReviewComments({
    owner: ownerInput,
    repo: repoInput,
    pullNumber: pullNumberInput,
    reviewId,
    cursor,
  }: Unchecked<'owner' | 'repo' | 'pullNumber' | 'reviewId' | 'cursor'> = {}): Promise<IReviewCommentPage> {
    const destination = { owner: ownerInput, repo: repoInput, pullNumber: pullNumberInput };
    requireDestination(destination);
    const { owner, repo, pullNumber } = destination;
    requireInput(isPositiveInteger(reviewId), 'reviewId must be a positive integer');
    requireInput(cursor === null || cursor === undefined, 'readback is one complete enumeration; cursor must be null');
    const listed = await listAll(
      owner,
      repo,
      `/pulls/${String(pullNumber)}/reviews/${String(reviewId)}/comments`,
      'review comment list',
    );
    const rest: IRestReviewComment[] = [];
    for (const c of listed) {
      if (!isRestReviewComment(c, reviewId)) {
        throw new GitHubError(
          'malformed-response',
          `A listed comment does not belong to review ${String(reviewId)} or lacks its fields.`,
        );
      }
      rest.push(c);
    }
    const threads = await listReviewThreads(owner, repo, pullNumber);
    const byRoot = new Map<number, UntrustedObject[]>();
    for (const thread of threads) {
      const root = optionalMember(thread, 'comments', 'nodes', 0);
      // A thread whose root comment is an object is itself an object: JSON
      // arrays and primitives have no `comments` member.
      if (!isPlainObject(thread) || !isPlainObject(root) || optionalMember(root['pullRequestReview'], 'databaseId') !== reviewId) {
        continue;
      }
      if (!isPositiveInteger(root['databaseId'])) {
        throw new GitHubError('anchor-malformed', `A thread of review ${String(reviewId)} has no root comment id.`);
      }
      byRoot.set(root['databaseId'], [...(byRoot.get(root['databaseId']) ?? []), thread]);
    }
    const restIds = new Set(rest.map((c) => c.id));
    for (const rootId of byRoot.keys()) {
      if (!restIds.has(rootId)) {
        throw new GitHubError(
          'anchor-ambiguous',
          `Review ${String(reviewId)} has a thread whose root comment the review does not list.`,
        );
      }
    }
    const comments = rest.map((c): IReadBackComment => {
      const candidates = byRoot.get(c.id) ?? [];
      const [thread] = candidates;
      if (thread === undefined) {
        throw new GitHubError('anchor-unavailable', `No review thread establishes the original anchor of comment ${String(c.id)}.`);
      }
      if (candidates.length > 1) {
        throw new GitHubError('anchor-ambiguous', `More than one review thread is rooted at comment ${String(c.id)}.`);
      }
      const anchor = threadAnchor(thread, c.id);
      const disagree = (why: string): GitHubError =>
        new GitHubError('anchor-ambiguous', `Comment ${String(c.id)} and its thread disagree on ${why}.`);
      if (anchor.path !== c.path) throw disagree('the path');
      const oid = optionalMember(thread, 'comments', 'nodes', 0, 'originalCommit', 'oid');
      if (typeof oid !== 'string') {
        throw new GitHubError('anchor-malformed', `The thread of comment ${String(c.id)} has no original commit.`);
      }
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
  async function readPull(owner: string, repo: string, pullNumber: number): Promise<IPullSnapshot> {
    const { body } = await restGet(`${API_ORIGIN}${repoPath(owner, repo)}/pulls/${String(pullNumber)}`, 'pull request');
    const head = optionalMember(body, 'head', 'sha');
    const base = optionalMember(body, 'base', 'sha');
    const changedFiles = optionalMember(body, 'changed_files');
    if (!hasFullShaForm(head) || !hasFullShaForm(base) || !isSafeInteger(changedFiles) || changedFiles < 0) {
      throw new GitHubError('malformed-response', 'The pull request lacks full head/base commits or a changed-file count.');
    }
    return { head, base, changedFiles };
  }

  /** Whether a listed pull request file entry carries its fields. */
  function isPullFileEntry(entry: unknown): entry is IPullFileEntry {
    return (
      isPlainObject(entry) &&
      typeof entry['filename'] === 'string' &&
      entry['filename'] !== '' &&
      Number.isSafeInteger(entry['additions']) &&
      Number.isSafeInteger(entry['deletions']) &&
      (entry['patch'] === undefined || typeof entry['patch'] === 'string') &&
      (entry['previous_filename'] === undefined || typeof entry['previous_filename'] === 'string')
    );
  }

  /** Every changed-file entry of the pull request, complete and unique, or an error. */
  async function readPullFiles(owner: string, repo: string, pullNumber: number, changedFiles: number): Promise<IPullFileEntry[]> {
    if (changedFiles > limits.maxPullFiles) {
      throw new GitHubError(
        'files-incomplete',
        `The pull request changes ${String(changedFiles)} files; at most ${String(limits.maxPullFiles)} can be listed completely.`,
      );
    }
    const listed = await listAll(owner, repo, `/pulls/${String(pullNumber)}/files`, 'pull request file list');
    const entries: IPullFileEntry[] = [];
    const seen = new Set<string>();
    for (const entry of listed) {
      if (!isPullFileEntry(entry)) {
        throw new GitHubError('malformed-response', 'A pull request file entry lacks its fields.');
      }
      if (seen.has(entry.filename)) {
        throw new GitHubError('duplicate-file', redact(`The pull request lists ${entry.filename} more than once.`));
      }
      seen.add(entry.filename);
      entries.push(entry);
    }
    if (entries.length !== changedFiles) {
      throw new GitHubError(
        'files-incomplete',
        `The pull request reports ${String(changedFiles)} changed files but lists ${String(entries.length)}.`,
      );
    }
    return entries;
  }

  // Source is read only as Git objects: the commit's root tree, one
  // non-recursive tree per directory on the path, then the final blob. The
  // Contents API is never used because it dereferences in-repository
  // symlinks and would return another path's text as if it were this one.

  /**
   * In-flight or settled reads of immutable objects, per repository and id.
   * Commits and trees are cached separately so each cache holds one result
   * type; their keys never overlap (':commit:' vs ':tree:').
   */
  const commitCache = new Map<string, Promise<unknown>>();
  const treeCache = new Map<string, Promise<ReadonlyMap<string, ITreeEntry>>>();

  /** Memoizes an immutable-object read; a failed read is forgotten. */
  function cached<T>(objectCache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
    const existing = objectCache.get(key);
    if (existing !== undefined) return existing;
    const pending = read();
    objectCache.set(key, pending);
    pending.catch(() => objectCache.delete(key));
    return pending;
  }

  function identityError(what: string, requested: unknown): GitHubError {
    return new GitHubError('blob-integrity', `GitHub answered a request for ${what} ${String(requested)} with another object.`);
  }

  /** The root tree id of a full commit. */
  function commitTree(owner: string, repo: string, commit: unknown): Promise<unknown> {
    return cached(commitCache, `${owner}/${repo}:commit:${String(commit)}`, async () => {
      const url = `${API_ORIGIN}${repoPath(owner, repo)}/git/commits/${String(commit)}`;
      const { body } = await restGet(url, 'commit request');
      if (!isPlainObject(body)) throw new GitHubError('malformed-response', 'The commit answer is not an object.');
      if (body['sha'] !== commit) throw identityError('commit', commit);
      const treeSha = optionalMember(body['tree'], 'sha');
      if (!hasFullShaForm(treeSha)) throw new GitHubError('malformed-response', `Commit ${String(commit)} names no tree.`);
      return treeSha;
    });
  }

  /** Whether a tree listing entry is a single, well-formed name of a known kind. */
  function isTreeEntry(entry: unknown): entry is ITreeEntry {
    return (
      isPlainObject(entry) &&
      typeof entry['path'] === 'string' &&
      entry['path'] !== '' &&
      entry['path'] !== '.' &&
      entry['path'] !== '..' &&
      !entry['path'].includes('/') &&
      // An unknown mode maps to no type, so it can never match.
      TREE_ENTRY_TYPES.get(entry['mode']) === entry['type'] &&
      hasFullShaForm(entry['sha']) &&
      (entry['size'] === undefined || (isSafeInteger(entry['size']) && entry['size'] >= 0))
    );
  }

  /** The complete, validated entries of one tree, by name. */
  function treeEntries(owner: string, repo: string, treeSha: unknown): Promise<ReadonlyMap<string, ITreeEntry>> {
    return cached(treeCache, `${owner}/${repo}:tree:${String(treeSha)}`, async () => {
      const url = `${API_ORIGIN}${repoPath(owner, repo)}/git/trees/${String(treeSha)}`;
      const { body } = await restGet(url, 'tree request');
      if (!isPlainObject(body)) throw new GitHubError('malformed-response', 'The tree answer is not an object.');
      if (body['sha'] !== treeSha) throw identityError('tree', treeSha);
      if (body['truncated'] !== false || !isList(body['tree'])) {
        throw new GitHubError('malformed-response', `Tree ${String(treeSha)} is not a complete listing.`);
      }
      const entries = new Map<string, ITreeEntry>();
      for (const entry of body['tree']) {
        if (!isTreeEntry(entry)) {
          throw new GitHubError('malformed-response', `Tree ${String(treeSha)} has an entry of unknown or inconsistent kind.`);
        }
        if (entries.has(entry.path)) {
          throw new GitHubError('malformed-response', `Tree ${String(treeSha)} lists one name more than once.`);
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
  async function entryAt(owner: string, repo: string, commit: unknown, filePath: string): Promise<ITreeEntry | null> {
    const walked = await walkTo(owner, repo, commit, filePath);
    if (walked.kind === 'through') {
      throw new GitHubError('not-a-file', redact(`${walked.at} is ${walked.entry}; ${filePath} is not read through it.`));
    }
    return walked.entry;
  }

  /**
   * The walk of entryAt: the entry at the path (null when a complete listing
   * shows it absent, or a regular file stands on the way), or the symbolic
   * link or submodule on the way that it would have to be read through.
   */
  async function walkTo(owner: string, repo: string, commit: unknown, filePath: string): Promise<PathWalk> {
    const segments = filePath.split('/');
    let treeSha = await commitTree(owner, repo, commit);
    for (const [i, segment] of segments.entries()) {
      const entry = (await treeEntries(owner, repo, treeSha)).get(segment);
      if (entry === undefined) return { kind: 'entry', entry: null };
      if (i === segments.length - 1) return { kind: 'entry', entry };
      if (entry.mode === TREE_MODE) {
        treeSha = entry.sha;
        continue;
      }
      if (REGULAR_FILE_MODES.has(entry.mode)) return { kind: 'entry', entry: null };
      return { kind: 'through', at: segments.slice(0, i + 1).join('/'), entry: entry.mode === SYMLINK_MODE ? 'a symbolic link' : 'a submodule' };
    }
    return { kind: 'entry', entry: null };
  }

  /**
   * The tree entry of the regular file at a path in a pinned commit, or null
   * when the path does not exist there. Directories, symlinks and submodules
   * are refused.
   */
  async function regularFileAt(owner: string, repo: string, commit: unknown, filePath: string): Promise<ITreeEntry | null> {
    const entry = await entryAt(owner, repo, commit, filePath);
    if (entry === null) return null;
    if (!REGULAR_FILE_MODES.has(entry.mode)) {
      // Looked up by property key like the member expression it mirrors: a
      // mode outside this table (possible only when the tree entry also had no
      // type) reads as whatever that key holds, usually undefined.
      const kind: unknown = Reflect.get(
        { [TREE_MODE]: 'a directory', [SYMLINK_MODE]: 'a symbolic link', [SUBMODULE_MODE]: 'a submodule' },
        String(entry.mode),
      );
      throw new GitHubError('not-a-file', redact(`${filePath} is ${String(kind)} at this commit, not a regular file.`));
    }
    return entry;
  }

  /** The exact bytes of one git blob answer, bound to the requested blob id. */
  function blobBytes(body: unknown, blobSha: unknown, expectedSize: number | undefined, filePath: string): Buffer {
    if (!isPlainObject(body)) throw new GitHubError('malformed-response', 'The blob answer is not an object.');
    if (body['sha'] !== blobSha) throw identityError('blob', blobSha);
    if (body['encoding'] !== 'base64' || typeof body['content'] !== 'string' || !isSafeInteger(body['size'])) {
      throw new GitHubError('malformed-response', redact(`${filePath} is not base64 blob content.`));
    }
    if (body['size'] > limits.maxSourceBytes) {
      throw new GitHubError('source-too-large', redact(`${filePath} exceeds the ${String(limits.maxSourceBytes)}-byte source limit.`));
    }
    const base64 = body['content'].replace(/\n/g, '');
    if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      throw new GitHubError('malformed-response', redact(`${filePath} content is not strict base64.`));
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64) {
      throw new GitHubError('malformed-response', redact(`${filePath} content is not canonical base64.`));
    }
    if (bytes.length > limits.maxSourceBytes) {
      throw new GitHubError('source-too-large', redact(`${filePath} exceeds the ${String(limits.maxSourceBytes)}-byte source limit.`));
    }
    const sizeMatches = bytes.length === body['size'] && (expectedSize === undefined || bytes.length === expectedSize);
    if (!sizeMatches || gitBlobSha(bytes) !== blobSha) {
      throw new GitHubError('blob-integrity', redact(`${filePath} content does not hash to the blob its tree names.`));
    }
    return bytes;
  }

  /** Decodes one git blob answer as UTF-8 text, bound to the requested blob id. */
  function decodeBlob(body: unknown, blobSha: unknown, expectedSize: number | undefined, filePath: string): string {
    const bytes = blobBytes(body, blobSha, expectedSize, filePath);
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
  async function readBlob(owner: string, repo: string, commit: unknown, filePath: string): Promise<string | null> {
    const entry = await regularFileAt(owner, repo, commit, filePath);
    if (entry === null) return null;
    if (entry.size !== undefined && entry.size > limits.maxSourceBytes) {
      throw new GitHubError('source-too-large', redact(`${filePath} exceeds the ${String(limits.maxSourceBytes)}-byte source limit.`));
    }
    const { body } = await restGet(`${API_ORIGIN}${repoPath(owner, repo)}/git/blobs/${String(entry.sha)}`, 'blob request');
    return decodeBlob(body, entry.sha, entry.size, filePath);
  }

  async function fetchContext({
    destination,
    reviewedCommit,
    oldSourceCommit,
  }: Unchecked<'destination' | 'reviewedCommit' | 'oldSourceCommit'> = {}): Promise<IFetchedContext> {
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

    let baseCommit: unknown = oldSourceCommit;
    if (baseCommit === undefined) {
      const { body } = await restGet(
        `${API_ORIGIN}${repoPath(owner, repo)}/compare/${String(first.base)}...${String(head)}`,
        'merge-base comparison',
      );
      baseCommit = optionalMember(body, 'merge_base_commit', 'sha');
      if (!hasFullShaForm(baseCommit)) {
        throw new GitHubError('malformed-response', 'The comparison names no full merge-base commit.');
      }
    }

    const files: IPullFile[] = [];
    const fileDiagnostics: IFileDiagnostic[] = [];
    const changes = new Map<string, { readonly patch: string | undefined; readonly renamedFrom: string | undefined }>();
    for (const entry of entries) {
      const file: { path: string; previousPath?: string; patch?: string } = { path: entry.filename };
      if (entry.previous_filename !== undefined) file.previousPath = entry.previous_filename;
      let patch: string | undefined;
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
    const renamedPaths = new Set<string>();
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
    async function readVerifiedBase(filePath: string): Promise<string | null> {
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

    // Callers are unconstrained: both arguments are checked from unknown, and
    // an invalid one rejects the returned promise rather than throwing.
    async function readSource(commit: unknown, filePath: unknown): Promise<string | null> {
      requireFullSha(commit, 'commit');
      requireRepositoryPath(filePath);
      if (commit === baseCommit) return readVerifiedBase(filePath);
      return readBlob(owner, repo, commit, filePath);
    }

    // Checked from unknown like readSource. Existence is decided by the
    // commit's own trees, so the diff base needs no patch verification here.
    async function fileExists(commit: unknown, filePath: unknown): Promise<boolean> {
      requireFullSha(commit, 'commit');
      requireRepositoryPath(filePath);
      return (await regularFileAt(owner, repo, commit, filePath)) !== null;
    }

    // Checked from unknown like readSource; answers what stands there
    // rather than refusing anything that is not a regular file.
    async function readEntry(commit: unknown, filePath: unknown): Promise<PathEntry> {
      requireFullSha(commit, 'commit');
      requireRepositoryPath(filePath);
      return pathEntry(owner, repo, commit, filePath);
    }

    const context: IReviewContext = {
      owner,
      repo,
      pullNumber,
      reviewedCommit,
      pullHead: head,
      currentBaseTip: first.base,
      diff: { baseCommit, headCommit: head, files },
      fileDiagnostics,
    };
    return { context, readSource, fileExists, readEntry };
  }

  // ---------------------------------------------------------------------------
  // Companion suggestion pull requests (docs/companion-suggestion-pr-contract.md)
  // ---------------------------------------------------------------------------

  /** A branch name's URL path: each "/"-separated segment encoded on its own. */
  function branchPath(branch: string): string {
    return branch.split('/').map(encodeURIComponent).join('/');
  }

  /** The string form of a host value that must be a string, or a malformed-response error. */
  function hostString(value: unknown, what: string): string {
    if (typeof value !== 'string' || value === '') throw new GitHubError('malformed-response', `The ${what} is missing.`);
    return value;
  }

  /** A full-commit host value as a string, or a malformed-response error. */
  function hostSha(value: unknown, what: string): string {
    if (typeof value !== 'string' || !FULL_SHA.test(value)) throw new GitHubError('malformed-response', `The ${what} is not a full object id.`);
    return value;
  }

  /** POSTs a JSON body; a refusal answer is hostRejected only when `definitive` and its status is understood. */
  async function restPost(url: string, body: unknown, what: string, definitive: boolean): Promise<unknown> {
    const response = await send('POST', url, { body });
    if (!response.ok) throw await statusError(response, what, definitive && DEFINITIVE_CREATE_REFUSALS.has(response.status));
    return jsonBody(response, what);
  }

  async function readSuggestionTarget({
    owner: ownerInput,
    repo: repoInput,
    pullNumber: pullNumberInput,
  }: Unchecked<'owner' | 'repo' | 'pullNumber'> = {}): Promise<ISuggestionTarget> {
    const destination = { owner: ownerInput, repo: repoInput, pullNumber: pullNumberInput };
    requireDestination(destination);
    const { owner, repo, pullNumber } = destination;
    const { body: pull } = await restGet(`${API_ORIGIN}${repoPath(owner, repo)}/pulls/${String(pullNumber)}`, 'pull request');
    const headRepo = optionalMember(pull, 'head', 'repo');
    const headRepository = headRepo === null ? null : optionalMember(headRepo, 'full_name');
    const { body: repository } = await restGet(`${API_ORIGIN}${repoPath(owner, repo)}`, 'repository');
    const push = optionalMember(repository, 'permissions', 'push');
    return {
      headSha: hostSha(optionalMember(pull, 'head', 'sha'), 'pull request head'),
      headRef: hostString(optionalMember(pull, 'head', 'ref'), 'pull request head branch'),
      headRepository: headRepository === null ? null : hostString(headRepository, 'pull request head repository'),
      baseRef: hostString(optionalMember(pull, 'base', 'ref'), 'pull request base branch'),
      baseRepository: hostString(optionalMember(pull, 'base', 'repo', 'full_name'), 'pull request base repository'),
      defaultBranch: hostString(optionalMember(repository, 'default_branch'), 'repository default branch'),
      canPush: push === true,
    };
  }

  async function findLabel({ owner, repo, name }: Unchecked<'owner' | 'repo' | 'name'> = {}): Promise<string | null> {
    requireInput(isRepoName(owner) && isRepoName(repo), 'owner and repo must be GitHub names');
    requireInput(typeof name === 'string' && name.length > 0, 'name must be a non-empty string');
    const response = await send('GET', `${API_ORIGIN}${repoPath(owner, repo)}/labels/${encodeURIComponent(name)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await statusError(response, 'label request');
    return hostString(optionalMember(await jsonBody(response, 'label'), 'name'), 'label name');
  }

  /** How a tree entry that is not a regular file is named. */
  function entryKind(mode: unknown): 'a directory' | 'a symbolic link' | 'a submodule' {
    if (mode === TREE_MODE) return 'a directory';
    if (mode === SYMLINK_MODE) return 'a symbolic link';
    return 'a submodule';
  }

  /** What stands at a path in a commit (see PathEntry), from its trees alone. */
  async function pathEntry(owner: string, repo: string, commit: string, filePath: string): Promise<PathEntry> {
    const walked = await walkTo(owner, repo, commit, filePath);
    if (walked.kind === 'through') return { kind: 'not-a-file', entry: walked.entry, path: walked.at };
    const { entry } = walked;
    if (entry === null) return { kind: 'absent' };
    if (!REGULAR_FILE_MODES.has(entry.mode)) return { kind: 'not-a-file', entry: entryKind(entry.mode), path: filePath };
    return { kind: 'file', blob: hostSha(entry.sha, 'tree entry'), mode: entry.mode === '100755' ? '100755' : '100644' };
  }

  async function compareCommits({ owner, repo, base, head }: Unchecked<'owner' | 'repo' | 'base' | 'head'> = {}): Promise<CommitComparison> {
    requireInput(isRepoName(owner) && isRepoName(repo), 'owner and repo must be GitHub names');
    requireFullSha(base, 'base');
    requireFullSha(head, 'head');
    const { body } = await restGet(`${API_ORIGIN}${repoPath(owner, repo)}/compare/${base}...${head}`, 'commit comparison');
    const status = optionalMember(body, 'status');
    if (!isCommitComparison(status)) throw new GitHubError('malformed-response', 'The commit comparison has no known status.');
    // The status is only trusted when the merge base agrees with what it claims.
    const agreed = status === 'behind' ? head : status === 'diverged' ? null : base;
    if (agreed !== null && optionalMember(body, 'merge_base_commit', 'sha') !== agreed) {
      throw new GitHubError('malformed-response', `The commit comparison says ${status}, but names another merge base.`);
    }
    return status;
  }

  async function readDefaultBranchFile({
    owner,
    repo,
    path: filePath,
    branch: known,
  }: Unchecked<'owner' | 'repo' | 'path' | 'branch'> = {}): Promise<IDefaultBranchFile> {
    requireInput(isRepoName(owner) && isRepoName(repo), 'owner and repo must be GitHub names');
    requireRepositoryPath(filePath);
    requireInput(known === undefined || (typeof known === 'string' && known !== ''), 'branch must be a non-empty string when given');
    const branch = typeof known === 'string'
      ? known
      : hostString(optionalMember((await restGet(`${API_ORIGIN}${repoPath(owner, repo)}`, 'repository')).body, 'default_branch'), 'repository default branch');
    const commit = await getBranch({ owner, repo, branch });
    if (commit === null) throw new GitHubError('malformed-response', redact(`The default branch ${branch} has no commit.`));
    const walked = await walkTo(owner, repo, commit, filePath);
    // A symbolic link or submodule on the way is never followed: what is
    // there is not a file, which is the convention's problem to name.
    if (walked.kind === 'through') return { branch, commit, content: { kind: 'not-a-file', entry: walked.entry, path: walked.at } };
    const { entry } = walked;
    if (entry === null) return { branch, commit, content: { kind: 'absent' } };
    if (!REGULAR_FILE_MODES.has(entry.mode)) return { branch, commit, content: { kind: 'not-a-file', entry: entryKind(entry.mode), path: filePath } };
    if (entry.size !== undefined && entry.size > limits.maxSourceBytes) return { branch, commit, content: { kind: 'too-large', size: entry.size } };
    const { body } = await restGet(`${API_ORIGIN}${repoPath(owner, repo)}/git/blobs/${String(entry.sha)}`, 'blob request');
    return { branch, commit, content: { kind: 'file', bytes: new Uint8Array(blobBytes(body, entry.sha, entry.size, filePath)) } };
  }

  /**
   * One proposal commit on `parent`: a verified blob per created or edited
   * file, one tree based on the parent's tree, and one commit with the parent
   * as its only parent, read back before it is returned. These objects are
   * content-addressed and invisible until a branch names them.
   */
  async function createProposalCommit({
    owner,
    repo,
    parent,
    message,
    changes,
  }: Unchecked<'owner' | 'repo' | 'parent' | 'message' | 'changes'> = {}): Promise<IProposalCommit> {
    requireInput(isRepoName(owner) && isRepoName(repo), 'owner and repo must be GitHub names');
    requireFullSha(parent, 'parent');
    requireInput(typeof message === 'string' && message.length > 0, 'message must be a non-empty string');
    requireInput(isList(changes) && changes.length > 0, 'changes must be a non-empty list');
    const planned = changes.map((change, i) => proposalChange(change, i));
    requireInput(new Set(planned.map((c) => c.path)).size === planned.length, 'changes must name each path once');
    const base = repoPath(owner, repo);

    const rootTree = await commitTree(owner, repo, parent);
    const entries: ICreateTreeEntry[] = [];
    const expected: { readonly path: string; readonly blob: string | null; readonly mode: string }[] = [];
    for (const change of planned) {
      const existing = await regularFileAt(owner, repo, parent, change.path);
      if (change.operation === 'create' ? existing !== null : existing === null) {
        throw new GitHubError('source-inconsistent', redact(`${change.path} ${change.operation === 'create' ? 'already exists' : 'does not exist'} at ${parent}.`));
      }
      const mode = change.operation === 'create' ? change.fileMode : String(existing?.mode);
      if (mode !== '100644' && mode !== '100755') throw new GitHubError('not-a-file', redact(`${change.path} is not a regular file at ${parent}.`));
      if (change.operation === 'delete') {
        entries.push({ path: change.path, mode, type: 'blob', sha: null });
        expected.push({ path: change.path, blob: null, mode });
        continue;
      }
      const bytes = Buffer.from(change.text, 'utf8');
      const blob = gitBlobSha(bytes);
      const created = await restPost(`${API_ORIGIN}${base}/git/blobs`, { content: bytes.toString('base64'), encoding: 'base64' }, 'create-blob request', false);
      if (optionalMember(created, 'sha') !== blob) throw identityError('blob', blob);
      entries.push({ path: change.path, mode, type: 'blob', sha: blob });
      expected.push({ path: change.path, blob, mode });
    }
    const tree = hostSha(optionalMember(await restPost(`${API_ORIGIN}${base}/git/trees`, { base_tree: rootTree, tree: entries }, 'create-tree request', false), 'sha'), 'created tree');
    const commit = hostSha(
      optionalMember(await restPost(`${API_ORIGIN}${base}/git/commits`, { message, tree, parents: [parent] }, 'create-commit request', false), 'sha'),
      'created commit',
    );

    const { body } = await restGet(`${API_ORIGIN}${base}/git/commits/${commit}`, 'commit request');
    const parents = optionalMember(body, 'parents');
    const parentShas = isList(parents) ? parents.map((p) => optionalMember(p, 'sha')) : null;
    if (optionalMember(body, 'sha') !== commit || optionalMember(body, 'tree', 'sha') !== tree || parentShas?.length !== 1 || parentShas[0] !== parent) {
      throw new GitHubError('blob-integrity', `The created commit ${commit} does not have the proposed tree and parent.`);
    }
    // The verified answer is the commit's root tree: the path reads below walk it without reading the commit again.
    void cached(commitCache, `${owner}/${repo}:commit:${commit}`, () => Promise.resolve<unknown>(tree));
    for (const { path: filePath, blob, mode } of expected) {
      const entry = await entryAt(owner, repo, commit, filePath);
      const exact = blob === null ? entry === null : entry !== null && entry.sha === blob && entry.mode === mode;
      if (!exact) throw new GitHubError('blob-integrity', redact(`The created commit ${commit} does not hold the proposed ${filePath}.`));
    }
    return { commit };
  }

  /** A proposal change as validated at the boundary. */
  function proposalChange(change: unknown, i: number): ProposalChange {
    requireInput(isPlainObject(change), `changes[${String(i)}] must be an object`);
    const { operation, path: filePath, text, fileMode } = change;
    requireRepositoryPath(filePath);
    if (operation === 'delete') return { operation, path: filePath };
    requireInput(typeof text === 'string', `changes[${String(i)}].text must be a string`);
    if (operation === 'edit') return { operation, path: filePath, text };
    requireInput(operation === 'create', `changes[${String(i)}].operation must be create, edit or delete`);
    requireInput(fileMode === '100644' || fileMode === '100755', `changes[${String(i)}].fileMode must be 100644 or 100755`);
    return { operation, path: filePath, text, fileMode };
  }

  async function getBranch({ owner, repo, branch }: Unchecked<'owner' | 'repo' | 'branch'> = {}): Promise<string | null> {
    requireInput(isRepoName(owner) && isRepoName(repo), 'owner and repo must be GitHub names');
    requireRepositoryPath(branch);
    const response = await send('GET', `${API_ORIGIN}${repoPath(owner, repo)}/git/ref/heads/${branchPath(branch)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await statusError(response, 'branch request');
    const body = await jsonBody(response, 'branch');
    if (optionalMember(body, 'ref') !== `refs/heads/${branch}`) throw new GitHubError('malformed-response', 'The branch answer names another reference.');
    return hostSha(optionalMember(body, 'object', 'sha'), 'branch commit');
  }

  async function createBranch({ owner, repo, branch, commit }: Unchecked<'owner' | 'repo' | 'branch' | 'commit'> = {}): Promise<void> {
    requireInput(isRepoName(owner) && isRepoName(repo), 'owner and repo must be GitHub names');
    requireRepositoryPath(branch);
    requireFullSha(commit, 'commit');
    await restPost(`${API_ORIGIN}${repoPath(owner, repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit }, 'create-branch request', true);
  }

  async function createPullRequest({
    owner,
    repo,
    title,
    head,
    base,
    body,
    draft,
  }: Unchecked<'owner' | 'repo' | 'title' | 'head' | 'base' | 'body' | 'draft'> = {}): Promise<ICreatedPullRequest> {
    requireInput(isRepoName(owner) && isRepoName(repo), 'owner and repo must be GitHub names');
    for (const [name, value] of Object.entries({ title, head, base, body })) {
      requireInput(typeof value === 'string' && value.length > 0, `${name} must be a non-empty string`);
    }
    requireInput(typeof draft === 'boolean', 'draft must be a boolean');
    const created = await restPost(`${API_ORIGIN}${repoPath(owner, repo)}/pulls`, { title, head, base, body, draft }, 'create-pull-request request', true);
    const number = optionalMember(created, 'number');
    const htmlUrl = optionalMember(created, 'html_url');
    if (!isPositiveInteger(number) || typeof htmlUrl !== 'string') {
      throw new GitHubError('malformed-response', 'The create-pull-request answer names no pull request; the outcome is unknown.');
    }
    return { number, htmlUrl };
  }

  async function listBranchPullRequests({ owner, repo, branch }: Unchecked<'owner' | 'repo' | 'branch'> = {}): Promise<readonly IBranchPullRequest[]> {
    requireInput(isRepoName(owner) && isRepoName(repo), 'owner and repo must be GitHub names');
    requireRepositoryPath(branch);
    const listed = await listAll(owner, repo, '/pulls', 'pull request list', { head: `${owner}:${branch}`, state: 'all' });
    return listed.map((pr): IBranchPullRequest => {
      const number = optionalMember(pr, 'number');
      if (!isPositiveInteger(number)) throw new GitHubError('malformed-response', 'A listed pull request has no number.');
      return {
        number,
        htmlUrl: optionalMember(pr, 'html_url'),
        body: optionalMember(pr, 'body'),
        authorId: optionalMember(pr, 'user', 'id'),
        headRef: optionalMember(pr, 'head', 'ref'),
        headRepository: optionalMember(pr, 'head', 'repo', 'full_name'),
        baseRef: optionalMember(pr, 'base', 'ref'),
      };
    });
  }

  async function addLabels({ owner, repo, number, labels }: Unchecked<'owner' | 'repo' | 'number' | 'labels'> = {}): Promise<void> {
    requireInput(isRepoName(owner) && isRepoName(repo), 'owner and repo must be GitHub names');
    requireInput(isPositiveInteger(number), 'number must be a positive integer');
    requireInput(
      isList(labels) && labels.length > 0 && labels.every((label) => typeof label === 'string' && label.length > 0),
      'labels must be a non-empty list of non-empty names',
    );
    await restPost(`${API_ORIGIN}${repoPath(owner, repo)}/issues/${String(number)}/labels`, { labels: [...labels] }, 'add-labels request', true);
  }

  async function listLabels({ owner, repo, number }: Unchecked<'owner' | 'repo' | 'number'> = {}): Promise<readonly string[]> {
    requireInput(isRepoName(owner) && isRepoName(repo), 'owner and repo must be GitHub names');
    requireInput(isPositiveInteger(number), 'number must be a positive integer');
    const listed = await listAll(owner, repo, `/issues/${String(number)}/labels`, 'label list');
    return listed.map((label) => hostString(optionalMember(label, 'name'), 'label name'));
  }

  // ---------------------------------------------------------------------------
  // Suggestion cleanup (docs/suggestion-cleanup-contract.md)
  // ---------------------------------------------------------------------------

  /** Label names of a host answer's `labels` list, or a malformed-response error. */
  function labelNames(value: unknown, what: string): string[] {
    if (!isList(value)) throw new GitHubError('malformed-response', `The ${what} has no label list.`);
    return value.map((label) => hostString(optionalMember(label, 'name'), `${what}'s label name`));
  }

  /** A description as a string: GitHub answers null for an empty one. */
  function bodyText(value: unknown, what: string): string {
    if (value === null) return '';
    if (typeof value !== 'string') throw new GitHubError('malformed-response', `The ${what} has no description text.`);
    return value;
  }

  async function listOpenLabeledPullRequests({ owner, repo, label }: Unchecked<'owner' | 'repo' | 'label'> = {}): Promise<readonly ILabeledPullRequest[]> {
    requireInput(isRepoName(owner) && isRepoName(repo), 'owner and repo must be GitHub names');
    requireInput(typeof label === 'string' && label.length > 0, 'label must be a non-empty string');
    requireInput(!label.includes(','), 'label must not contain a comma (GitHub reads a comma as a list of labels)');
    const listed = await listAll(owner, repo, '/issues', 'labeled issue list', { labels: label, state: 'open' });
    const pulls: ILabeledPullRequest[] = [];
    for (const item of listed) {
      const number = optionalMember(item, 'number');
      if (!isPositiveInteger(number)) throw new GitHubError('malformed-response', 'A listed issue has no number.');
      // Pull requests are issues with a `pull_request` object; plain issues carry none.
      if (!isPlainObject(optionalMember(item, 'pull_request'))) continue;
      const what = `listed pull request ${String(number)}`;
      pulls.push({
        number,
        htmlUrl: hostString(optionalMember(item, 'html_url'), `${what}'s URL`),
        body: bodyText(optionalMember(item, 'body'), what),
        labels: labelNames(optionalMember(item, 'labels'), what),
      });
    }
    return pulls;
  }

  async function getPullRequest({
    owner: ownerInput,
    repo: repoInput,
    pullNumber: pullNumberInput,
  }: Unchecked<'owner' | 'repo' | 'pullNumber'> = {}): Promise<IPullRequestSnapshot> {
    const destination = { owner: ownerInput, repo: repoInput, pullNumber: pullNumberInput };
    requireDestination(destination);
    const { owner, repo, pullNumber } = destination;
    const { body: pull } = await restGet(`${API_ORIGIN}${repoPath(owner, repo)}/pulls/${String(pullNumber)}`, 'pull request read');
    const what = `pull request ${String(pullNumber)} answer`;
    if (optionalMember(pull, 'number') !== pullNumber) throw new GitHubError('malformed-response', `The ${what} names another pull request.`);
    const state = optionalMember(pull, 'state');
    const merged = optionalMember(pull, 'merged');
    if (state !== 'open' && state !== 'closed') throw new GitHubError('malformed-response', `The ${what} has no valid state.`);
    if (typeof merged !== 'boolean' || (state === 'open' && merged)) {
      throw new GitHubError('malformed-response', `The ${what} has no valid merged flag.`);
    }
    const headRepo = optionalMember(pull, 'head', 'repo');
    return {
      number: pullNumber,
      htmlUrl: hostString(optionalMember(pull, 'html_url'), `${what}'s URL`),
      state,
      merged,
      body: bodyText(optionalMember(pull, 'body'), what),
      headRef: hostString(optionalMember(pull, 'head', 'ref'), `${what}'s head branch`),
      headRepository: headRepo === null ? null : hostString(optionalMember(headRepo, 'full_name'), `${what}'s head repository`),
      baseRepository: hostString(optionalMember(pull, 'base', 'repo', 'full_name'), `${what}'s base repository`),
      labels: labelNames(optionalMember(pull, 'labels'), what),
    };
  }

  /**
   * One cross-reference timeline node as a pull request source of `owner/repo`,
   * or null when its source is not a pull request or is in another
   * repository. A foreign source is left out before anything else about it is
   * read or checked: its labels may be unreadable (a private repository
   * refuses their listing) or absent, and it is never a suggestion here (D25).
   */
  async function crossReferenceSource(node: unknown, owner: string, repo: string): Promise<ICrossReferencingPullRequest | null> {
    const source = optionalMember(node, 'source');
    if (!isPlainObject(source) || source['__typename'] !== 'PullRequest') return null;
    const number = source['number'];
    if (!isPositiveInteger(number)) throw new GitHubError('malformed-response', 'A cross-referencing pull request has no number.');
    const what = `cross-referencing pull request ${String(number)}`;
    const repository = hostString(optionalMember(source, 'repository', 'nameWithOwner'), `${what}'s repository`);
    if (repository.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) return null;
    const state = GRAPHQL_PULL_STATES.get(source['state']);
    if (state === undefined) throw new GitHubError('malformed-response', `The ${what} has no valid state.`);
    const labels = source['labels'];
    const more = optionalMember(labels, 'pageInfo', 'hasNextPage');
    if (!isPlainObject(labels) || typeof more !== 'boolean') throw new GitHubError('malformed-response', `The ${what} has no label connection.`);
    return {
      number,
      htmlUrl: hostString(source['url'], `${what}'s URL`),
      repository,
      state,
      body: bodyText(source['body'], what),
      // A source with more labels than the connection holds is read in full
      // from this repository's REST listing.
      labels: more ? await listLabels({ owner, repo, number }) : labelNames(labels['nodes'], what),
    };
  }

  async function listCrossReferencingPullRequests({
    owner: ownerInput,
    repo: repoInput,
    pullNumber: pullNumberInput,
  }: Unchecked<'owner' | 'repo' | 'pullNumber'> = {}): Promise<readonly ICrossReferencingPullRequest[]> {
    const destination = { owner: ownerInput, repo: repoInput, pullNumber: pullNumberInput };
    requireDestination(destination);
    const { owner, repo, pullNumber } = destination;
    const found: ICrossReferencingPullRequest[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    for (let pages = 1; ; pages += 1) {
      if (pages > limits.maxPages) throw new GitHubError('pagination', `Cross-references exceeded ${String(limits.maxPages)} pages.`);
      const response = await send('POST', `${API_ORIGIN}/graphql`, {
        graphql: true,
        body: { query: CROSS_REFERENCES_QUERY, variables: { owner, repo, number: pullNumber, after } },
      });
      if (!response.ok) throw await statusError(response, 'cross-reference query');
      const body = await jsonBody(response, 'cross-reference query');
      if (isPlainObject(body) && isList(body['errors']) && body['errors'].length > 0) {
        const types = body['errors'].map((e) => (isPlainObject(e) ? e['type'] || e['message'] : String(e))).join('; ');
        throw new GitHubError('graphql-errors', redact(`The cross-reference query returned errors: ${types}`));
      }
      const items = optionalMember(body, 'data', 'repository', 'pullRequest', 'timelineItems');
      if (!isPlainObject(items) || !isList(items['nodes']) || !isPlainObject(items['pageInfo'])) {
        throw new GitHubError('malformed-response', 'The cross-reference query returned no timeline connection.');
      }
      for (const node of items['nodes']) {
        const source = await crossReferenceSource(node, owner, repo);
        if (source !== null) found.push(source);
      }
      const { hasNextPage, endCursor } = items['pageInfo'];
      if (hasNextPage === false) return found;
      if (hasNextPage !== true || typeof endCursor !== 'string' || endCursor === '' || seen.has(endCursor)) {
        throw new GitHubError('pagination', 'The cross-reference pagination is missing or repeats a cursor.');
      }
      seen.add(endCursor);
      after = endCursor;
    }
  }

  /** Whether a refused answer is a rate limit (primary or secondary) rather than a permission refusal. */
  function isRateLimit(response: IFetchResponse, explanation: string): boolean {
    if (response.status === 429) return true;
    return (
      response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('retry-after') !== null || /rate limit/i.test(explanation))
    );
  }

  async function closePullRequest({
    owner: ownerInput,
    repo: repoInput,
    pullNumber: pullNumberInput,
  }: Unchecked<'owner' | 'repo' | 'pullNumber'> = {}): Promise<void> {
    const destination = { owner: ownerInput, repo: repoInput, pullNumber: pullNumberInput };
    requireDestination(destination);
    const { owner, repo, pullNumber } = destination;
    const response = await send('PATCH', `${API_ORIGIN}${repoPath(owner, repo)}/pulls/${String(pullNumber)}`, { body: { state: 'closed' } });
    if (!response.ok) {
      const explanation = await explanationOf(response);
      const code = isRateLimit(response, explanation) ? 'rate-limited' : 'http-status';
      throw new GitHubError(code, answeredWith(response, 'close-pull-request request', explanation), { status: response.status });
    }
    const closed = await jsonBody(response, 'close-pull-request');
    if (optionalMember(closed, 'number') !== pullNumber || optionalMember(closed, 'state') !== 'closed') {
      throw new GitHubError('malformed-response', `The close answer does not show pull request ${String(pullNumber)} closed; the outcome is unknown.`);
    }
  }

  return Object.freeze({
    getAuthenticatedUser,
    createReview,
    listReviews,
    listReviewComments,
    fetchContext,
    readSuggestionTarget,
    findLabel,
    compareCommits,
    readDefaultBranchFile,
    createProposalCommit,
    getBranch,
    createBranch,
    createPullRequest,
    listBranchPullRequests,
    addLabels,
    listLabels,
    listOpenLabeledPullRequests,
    getPullRequest,
    listCrossReferencingPullRequests,
    closePullRequest,
  });
}
