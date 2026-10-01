/**
 * GitHub web URLs (private internal module).
 *
 * The one place that turns established GitHub object references — a
 * repository, a pull request number, a review or review comment id, a commit,
 * a repository path — into the web URLs that review Markdown links to and
 * that SARIF provenance names. Every caller builds links here, so they share
 * one host and one encoding instead of assembling URLs independently (D60,
 * "Reusable links").
 *
 * Scope and boundaries:
 *   - It only formats references the caller already holds. It never invents,
 *     guesses or verifies an object id, and never contacts GitHub: a URL is
 *     only as valid as the reference it was given. A URL GitHub itself
 *     returned (an `html_url`) remains authoritative for that object.
 *   - The forms are GitHub's web routes as observed in this project's live
 *     evidence (docs/github-behavior.md and the e2e evidence documents):
 *       repository        https://github.com/OWNER/REPO
 *       pull request      …/pull/N
 *       review            …/pull/N#pullrequestreview-ID
 *       review comment    …/pull/N#discussion_rID
 *       blob permalink    …/blob/COMMIT/PATH[?plain=1#LA[-LB]]
 *       commit            …/commit/COMMIT
 *       compare           …/compare/BASE...HEAD
 *   - Encoding: every path segment (owner, repository, each segment of a
 *     repository path, each segment of a ref name) is percent-encoded with
 *     encodeURIComponent and additionally `(`, `)`, `!`, `'` and `*`, which
 *     encodeURIComponent leaves alone but which could end a Markdown link
 *     destination early (RFC 3986 permits encoding them). `/` separators of
 *     repository paths and ref names are kept. Spaces, `#`, `?`, `%` and
 *     non-ASCII text are therefore always encoded, so a path can never become
 *     a fragment, a query or a different path.
 *   - Refusals (Error, an internal invariant): a non-positive or non-integer
 *     number or id, a commit that is not 40 lowercase hex digits, an empty,
 *     `.` or `..` owner or repository name, an empty path or ref segment,
 *     and a `.` or `..` path segment — URL parsers
 *     resolve dot segments (WHATWG URL, RFC 3986 §5.2.4) even when
 *     percent-encoded, so such a link would silently name another path. A ref
 *     containing `..` is refused for the same reason, and because Git forbids
 *     it and it would make a `BASE...HEAD` comparison ambiguous.
 *
 * @see https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet
 * @see https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-comparing-branches-in-pull-requests
 * @see https://www.rfc-editor.org/rfc/rfc3986
 * @see https://url.spec.whatwg.org/#single-dot-path-segment
 * @see https://git-scm.com/docs/git-check-ref-format
 */

/** The GitHub web host: repository identity in SARIF provenance and every link this package renders. */
export const GITHUB_HOST = 'github.com';

/** A repository on {@link GITHUB_HOST}: its owning account and its name. */
export interface IGitHubRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

/** Whole lines of a file a permalink highlights: line `startLine` through `endLine` (equal for one line). */
export interface ILineRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** A full, immutable, lowercase Git commit id: what a permalink pins. */
const FULL_COMMIT = /^[0-9a-f]{40}$/;

/**
 * One URL path segment, safe inside a Markdown link destination:
 * encodeURIComponent plus `(`, `)`, `!`, `'` and `*` (see the module
 * documentation).
 */
export function encodeUrlSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[()!'*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The web URL of a repository: `https://github.com/OWNER/REPO`. */
export function repositoryUrl(repository: IGitHubRepositoryRef): string {
  return `https://${GITHUB_HOST}/${nameSegment(repository.owner, 'owner')}/${nameSegment(repository.repo, 'repository name')}`;
}

/** The web URL of a pull request: `…/pull/N`. */
export function pullRequestUrl(repository: IGitHubRepositoryRef, pullNumber: number): string {
  return `${repositoryUrl(repository)}/pull/${positive(pullNumber, 'pull request number')}`;
}

/**
 * The web URL of one review of a pull request: `…/pull/N#pullrequestreview-ID`.
 * Kept for the review-continuity work of D56 and the companion index, which
 * link reviews they name; publication itself reports GitHub's own `html_url`.
 */
export function reviewUrl(repository: IGitHubRepositoryRef, pullNumber: number, reviewId: number): string {
  return `${pullRequestUrl(repository, pullNumber)}#pullrequestreview-${positive(reviewId, 'review id')}`;
}

/**
 * The web URL of one review comment of a pull request: `…/pull/N#discussion_rID`.
 * Kept for D60's navigation between the members of a suggestion group, which
 * links the comments it names.
 */
export function reviewCommentUrl(repository: IGitHubRepositoryRef, pullNumber: number, commentId: number): string {
  return `${pullRequestUrl(repository, pullNumber)}#discussion_r${positive(commentId, 'review comment id')}`;
}

/**
 * A permalink to a repository file at an exact commit, optionally
 * highlighting whole lines: `…/blob/COMMIT/PATH`, then `?plain=1#LA` for one
 * line or `?plain=1#LA-LB` for several. `?plain=1` opens the source view: a
 * file GitHub renders (Markdown, notebooks, …) otherwise opens as a preview
 * with no line anchors, so the link would not reach its line. For other
 * files it changes nothing. A link to the whole file has no query, so a
 * rendered file opens as GitHub presents it.
 */
export function blobUrl(repository: IGitHubRepositoryRef, commit: string, repositoryPath: string, lines?: ILineRange): string {
  const base = `${repositoryUrl(repository)}/blob/${fullCommit(commit)}/${encodePath(repositoryPath, 'repository path')}`;
  if (lines === undefined) return base;
  const start = positive(lines.startLine, 'start line');
  return lines.endLine === lines.startLine ? `${base}?plain=1#L${start}` : `${base}?plain=1#L${start}-L${positive(lines.endLine, 'end line')}`;
}

/**
 * The web URL of a commit: `…/commit/COMMIT`. Kept for presentations that
 * name a reviewed or proposal commit (D60, the companion index).
 */
export function commitUrl(repository: IGitHubRepositoryRef, commit: string): string {
  return `${repositoryUrl(repository)}/commit/${fullCommit(commit)}`;
}

/**
 * The web URL comparing two revisions (commits or ref names):
 * `…/compare/BASE...HEAD`, GitHub's three-dot comparison of HEAD against its
 * merge base with BASE. Kept for presentations that show what a companion
 * proposal changes relative to the reviewed commit (D60, the companion index).
 */
export function compareUrl(repository: IGitHubRepositoryRef, base: string, head: string): string {
  return `${repositoryUrl(repository)}/compare/${encodeRef(base)}...${encodeRef(head)}`;
}

/** An owner or repository name as one encoded segment; empty, `.` and `..` would name another path. */
function nameSegment(value: string, what: string): string {
  if (value === '' || value === '.' || value === '..') throw new Error(`Internal error: ${JSON.stringify(value)} is not a GitHub ${what}.`);
  return encodeUrlSegment(value);
}

/** A repository path, each segment encoded and its `/` separators kept. */
function encodePath(value: string, what: string): string {
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '') throw new Error(`Internal error: a ${what} has an empty segment: ${JSON.stringify(value)}.`);
    if (segment === '.' || segment === '..') throw new Error(`Internal error: a ${what} has a dot segment: ${JSON.stringify(value)}.`);
  }
  return segments.map(encodeUrlSegment).join('/');
}

/** A revision of a comparison: a full commit, or a ref name encoded as a path. */
function encodeRef(ref: string): string {
  if (ref.includes('..')) throw new Error(`Internal error: a ref name contains "..": ${JSON.stringify(ref)}.`);
  return encodePath(ref, 'ref name');
}

function fullCommit(commit: string): string {
  if (!FULL_COMMIT.test(commit)) throw new Error(`Internal error: ${JSON.stringify(commit)} is not a full lowercase commit id.`);
  return commit;
}

function positive(value: number, what: string): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Internal error: a ${what} must be a positive integer, not ${String(value)}.`);
  return String(value);
}
