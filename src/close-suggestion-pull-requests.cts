/**
 * closeSuggestionPullRequests: on-demand cleanup of suggestion pull requests
 * whose original pull request has merged or closed (the eighth public
 * operation; the package entry re-exports it). Contract:
 * docs/suggestion-cleanup-contract.md.
 *
 * Cleanup is not publication and not review maintenance (D27, D29): it acts
 * only on suggestion pull requests that conform to the tool-neutral
 * convention (docs/suggestion-pr-convention.md), whichever tool created
 * them, recognized by their structured marker (src/suggestion-marker.cts),
 * and its only write is to close one. It never deletes or updates a branch,
 * edits a body, title or label, comments, or touches the original. It keeps
 * no local record, and never writes the repository configuration.
 *
 * ---------------------------------------------------------------------------
 * closeSuggestionPullRequests(input, internals?) -> Promise<Outcome>
 *
 * input (unknown keys are refused; a TypeError before any request):
 *   repository:          { owner, repo }
 *   token:               GitHub user/PAT credential; never shown
 *   label?:              a migration override of the canonical label (a
 *                        label name under the convention: no comma); without
 *                        originalPullNumber it also selects a label sweep
 *   originalPullNumber?: targeted mode: only pull requests referencing it
 *   owner?:              'me' (default): close only suggestion pull requests
 *                        the authenticated account opened; 'all': any
 *   maxCandidates?:      a sweep's candidate limit (default 500); refused
 *                        with originalPullNumber, which has no limit
 *   force?:              a label sweep continues past the early exit;
 *                        refused (when true) outside a label sweep
 *   dryRun?:             discover and verify, write nothing
 *
 * Sequence (every read completes before the first write):
 *   1. Discovery. Sweep (no originalPullNumber): the first page of the
 *      branches under suggestion-pr/ with their open pull requests, or,
 *      with a label, of the open pull requests carrying it. A label sweep
 *      whose first page shows no suggestion marker and no suggestion-pr/
 *      branch stops (label-not-suggestion-prs) unless forced; then a total
 *      count over maxCandidates stops the run (too-many-candidates), forced
 *      or not. Otherwise every further page is read. Targeted: the original
 *      is resolved first; if it cannot be verified, or does not exist (404),
 *      nothing else is read; otherwise its cross-referencing pull requests
 *      in this repository (D21). A pull request listed twice counts once.
 *   2. The label (after the first sweep page, before targeted discovery):
 *      the override, or else the repository's canonical label resolved
 *      exactly as publication resolves it (contract §2.2.1). An invalid
 *      configuration rejects, naming the file and field; a failed read
 *      rejects as operational. With the override in targeted mode the
 *      repository itself is read instead (a failed read rejects as
 *      operational, naming it), since nothing else would prove it exists
 *      before an original's 404 is trusted.
 *   3. Classification in ascending number order (contract §2.6): marker,
 *      repository, targeted original, shared suggestion id, head branch,
 *      targeted state, label, owner (the account read once, only when an
 *      owner decides something), then the original's state, resolved once
 *      per original.
 *   4. Verification of each suggestion whose original ended, on a fresh read
 *      (contract §2.8): still open, same marker line, head and base in this
 *      repository, head branch suggestion-pr/<original>/<id>, still labeled.
 *   5. Unless dryRun, one close per eligible suggestion, ascending. A 403 or
 *      404 refusal is permission-limited; any other failure is failed.
 *
 * Outcome: { status, dryRun, owner, originals, suggestions, counts, markdown,
 * diagnostics } (see the public types below). A stopped sweep resolves too,
 * with nothing evaluated. Rejects for invalid input, for an invalid or
 * unreadable repository configuration, for an operational failure during
 * discovery or while reading the account, and for a defect in this package
 * during steps 1-4: always before anything has been written. From step 5
 * on, every failure is reported in the outcome, so the closes already made
 * are never lost. Neither an outcome nor a rejection contains the token.
 *
 * internals (private seam, not caller API):
 *   createGitHubClient({ token, fetch }) -> a client with the suggestion
 *     cleanup transport of src/github.cts (checked at runtime). Defaults to
 *     src/github.cts.
 */

import { GitHubError, createGitHubClient as defaultCreateGitHubClient } from './github.cjs';
import type { ICreateGitHubClientOptions, IGitHubClient, IListedPullRequest, IOpenPullRequestPage, IPullRequestSnapshot } from './github.cjs';
import type { IGitHubRepository } from './public-types.cjs';
import { createDiagnostic, mapDiagnosticText, orderDiagnostics } from './diagnostics.cjs';
import type { IDiagnostic } from './diagnostics.cjs';
import { messageChain, redact, withoutCredential } from './review-preflight.cjs';
import type { IReported } from './review-preflight.cjs';
import { OWNER_PATTERN, REPO_PATTERN, isPlainObject } from './sarif-common.cjs';
import { findSuggestionMarker } from './suggestion-marker.cjs';
import type { ISuggestionMarkerFields } from './suggestion-marker.cjs';
import {
  LABEL_RULE,
  SUGGESTION_BRANCH_PREFIX,
  SUGGESTION_PR_CONFIGURATION_PATH,
  configurationProblem,
  isLabelName,
  labelSourceText,
  resolveCanonicalLabel,
  suggestionPrBranch,
} from './suggestion-pr-convention.cjs';
import type { LabelSource } from './suggestion-pr-convention.cjs';

// ---------------------------------------------------------------------------
// Public types

/**
 * Whose suggestion pull requests a cleanup closes, by who opened the
 * suggestion pull request (not the original): `'me'`, the authenticated
 * account; `'all'`, anyone.
 *
 * @public
 */
export type SuggestionOwnerScope = 'me' | 'all';

/**
 * Input to {@link closeSuggestionPullRequests}. Unknown fields are refused.
 *
 * @public
 */
export interface ICloseSuggestionPullRequestsInput {
  /** The repository whose suggestion pull requests are checked. */
  readonly repository: IGitHubRepository;
  /**
   * GitHub personal access token (or user token) used to read pull requests
   * and close eligible ones. Closing needs permission to update pull
   * requests. Never included in an outcome or a rejection.
   */
  readonly token: string;
  /**
   * A migration override of the repository's canonical suggestion label, for
   * sweeping suggestions left under a previously configured label: 1-50
   * characters without commas, control or invisible formatting characters or
   * surrounding whitespace. Without it (the normal case), suggestions are
   * found by their branches and confirmed by the canonical label: the label
   * set in `.github/suggestion-prs.json` on the default branch, or else the
   * default `suggestion-pr`, exactly as publication resolves it. With it,
   * the repository configuration is not read, and without
   * originalPullNumber the open pull requests carrying it are checked
   * instead of the suggestion branches.
   */
  readonly label?: string | undefined;
  /**
   * Check only the pull requests that reference this original pull request
   * (its backlinks), instead of sweeping the repository.
   */
  readonly originalPullNumber?: number | undefined;
  /**
   * Whose suggestion pull requests may be closed, by who opened them; the
   * default is `'me'`. A conforming suggestion someone else opened is
   * reported `other-owner` and left open.
   */
  readonly owner?: SuggestionOwnerScope | undefined;
  /**
   * The most candidates a sweep evaluates: suggestion branches, or open pull
   * requests with the label. When GitHub counts more, nothing is evaluated
   * and the status is `too-many-candidates`. A positive integer; the
   * default is 500. Targeted discovery has no limit, so giving it with
   * `originalPullNumber` is a `TypeError`.
   */
  readonly maxCandidates?: number | undefined;
  /**
   * Continue a label sweep whose first page shows no suggestion pull request,
   * instead of stopping with the status `label-not-suggestion-prs`. Only a
   * label sweep stops that way, so `true` requires `label` and cannot be
   * combined with `originalPullNumber` (a `TypeError` otherwise). It does
   * not lift `maxCandidates`.
   */
  readonly force?: boolean | undefined;
  /** Read and verify everything, but close nothing; eligible suggestions are reported as `would-close`. */
  readonly dryRun?: boolean | undefined;
}

/**
 * An original pull request's state. `not-found` when GitHub answered that the
 * repository has no pull request with its number that this account can read
 * (HTTP 404): a definitive answer, which running cleanup again does not
 * change. `unverified` when it could not be read for any other reason, which
 * running cleanup again may change. Neither is ever treated as ended.
 *
 * @public
 */
export type OriginalPullRequestState = 'open' | 'merged' | 'closed' | 'not-found' | 'unverified';

/**
 * An original pull request cleanup resolved.
 *
 * @public
 */
export interface IOriginalPullRequest {
  /** The original pull request's number. */
  readonly number: number;
  /** Its state; only `merged` and `closed` allow its suggestions to be closed. */
  readonly state: OriginalPullRequestState;
  /** Why it could not be verified (with `unverified` only). */
  readonly reason?: string;
}

/**
 * What cleanup did with one pull request:
 *
 * - `closed`: it was closed now.
 * - `would-close`: a dry run would close it.
 * - `already-closed`: it is no longer open.
 * - `left-open`: its original is still open.
 * - `unverified`: its original could not be verified, so it was left open.
 * - `permission-limited`: GitHub refused to let this account close it.
 * - `failed`: reading or closing it failed; running cleanup again is safe.
 * - `not-conforming`: it does not conform to the suggestion pull request
 *   convention (no, several or a changed marker, another repository or
 *   original, an original that is not a pull request of the repository, a
 *   fork, or another branch), so it was not touched.
 * - `other-owner`: it conforms, but someone other than this account opened
 *   it, and the owner scope is `me`; it was left open.
 * - `unlabeled`: it does not carry the label, so it was not touched.
 *
 * @public
 */
export type SuggestionCleanupResult =
  | 'closed'
  | 'would-close'
  | 'already-closed'
  | 'left-open'
  | 'unverified'
  | 'permission-limited'
  | 'failed'
  | 'not-conforming'
  | 'other-owner'
  | 'unlabeled';

/**
 * One pull request cleanup checked.
 *
 * @public
 */
export interface ICheckedSuggestionPullRequest {
  /** The pull request's number. */
  readonly number: number;
  /** Web URL of the pull request. */
  readonly url: string;
  /** The original pull request its marker names, or null when it has no usable marker. */
  readonly original: number | null;
  /** What cleanup did with it. */
  readonly result: SuggestionCleanupResult;
  /** Why, for `unverified`, `permission-limited`, `failed` and `not-conforming`. */
  readonly reason?: string;
}

/**
 * Whether cleanup established everything it set out to:
 *
 * - `complete`: every pull request checked has its final result (a dry run
 *   too).
 * - `permission-limited`: everything else is done, but some eligible
 *   suggestion pull requests could not be closed with this account.
 * - `incomplete`: an original could not be verified or an action failed;
 *   running cleanup again is safe.
 * - `too-many-candidates`: a sweep found more candidates than its limit
 *   (`maxCandidates`), so nothing was evaluated.
 * - `label-not-suggestion-prs`: a label sweep's first page shows no
 *   suggestion pull request, so nothing was evaluated; `force` continues.
 *
 * @public
 */
export type CloseSuggestionPullRequestsStatus = 'complete' | 'permission-limited' | 'incomplete' | 'too-many-candidates' | 'label-not-suggestion-prs';

/**
 * How much a cleanup found and checked.
 *
 * @public
 */
export interface ISuggestionCleanupCounts {
  /**
   * The candidates discovery counted, the number `maxCandidates` limits: for
   * the default sweep the branches under `suggestion-pr/` (GitHub's total),
   * for a label sweep the open pull requests with the label (GitHub's
   * total), for targeted discovery the pull requests of this repository that
   * reference the original.
   */
  readonly candidates: number;
  /** The pull requests checked: those listed in `suggestions`. */
  readonly checked: number;
  /** How many of those carried the label when discovery listed them. */
  readonly labeled: number;
  /** How many of those conformed to the suggestion pull request convention when discovery listed them. */
  readonly conforming: number;
}

/**
 * The outcome of {@link closeSuggestionPullRequests}.
 *
 * @public
 */
export interface ICloseSuggestionPullRequestsOutcome {
  /** Whether cleanup established everything; see {@link CloseSuggestionPullRequestsStatus}. */
  readonly status: CloseSuggestionPullRequestsStatus;
  /** Whether this was a dry run, which closes nothing. */
  readonly dryRun: boolean;
  /** Whose suggestion pull requests could be closed; see {@link SuggestionOwnerScope}. */
  readonly owner: SuggestionOwnerScope;
  /** Each original pull request resolved, by ascending number. */
  readonly originals: readonly IOriginalPullRequest[];
  /** Each pull request checked, by ascending number. Ordinary references without a marker, the label or a suggestion branch are not listed. */
  readonly suggestions: readonly ICheckedSuggestionPullRequest[];
  /** How much was found and checked; see {@link ISuggestionCleanupCounts}. */
  readonly counts: ISuggestionCleanupCounts;
  /** What was checked and done, as Markdown, including that no branch is ever deleted. */
  readonly markdown: string;
  /**
   * What was left undone or untouched: a failed read or close, or a sweep
   * stopped by the candidate limit (error); an original that could not be
   * verified, a targeted original that does not exist, a close this account
   * may not make, or a label sweep stopped
   * because its label does not look like a suggestion label (warning); and a
   * pull request that does not follow the convention (note).
   */
  readonly diagnostics: readonly IDiagnostic[];
}

// ---------------------------------------------------------------------------
// Private seam

/** What cleanup needs from a GitHub client. */
type CleanupClient = Pick<
  IGitHubClient,
  | 'readDefaultBranchFile'
  | 'readRepository'
  | 'getAuthenticatedUser'
  | 'listOpenPullRequestsByBranchPrefix'
  | 'listOpenPullRequestsByLabel'
  | 'getPullRequest'
  | 'listCrossReferencingPullRequests'
  | 'closePullRequest'
>;

/** The client methods cleanup calls. */
const CLEANUP_METHODS: readonly (keyof CleanupClient)[] = [
  'readDefaultBranchFile',
  'readRepository',
  'getAuthenticatedUser',
  'listOpenPullRequestsByBranchPrefix',
  'listOpenPullRequestsByLabel',
  'getPullRequest',
  'listCrossReferencingPullRequests',
  'closePullRequest',
];

/**
 * The private test seam of {@link closeSuggestionPullRequests}, shaped like
 * publication's so one injected client serves every operation. The client
 * is checked at runtime (a client made for publication alone lacks the
 * cleanup methods). Not a supported contract, which is why the public
 * declaration has no second parameter.
 */
export interface ICloseSuggestionPullRequestsInternals {
  readonly createGitHubClient?: ((options: ICreateGitHubClientOptions) => object) | undefined;
}

/**
 * Whether a client has every cleanup method. Only that each is a function
 * can be checked at runtime; their signatures are the injector's contract.
 */
function isCleanupClient(client: object): client is CleanupClient {
  return CLEANUP_METHODS.every((name) => typeof Reflect.get(client, name) === 'function');
}

// ---------------------------------------------------------------------------
// Input

/** Every accepted input field. */
const INPUT_KEYS: ReadonlySet<string> = new Set(['repository', 'token', 'label', 'originalPullNumber', 'owner', 'maxCandidates', 'force', 'dryRun']);

/** The candidate limit of a sweep when the caller sets none (contract §2.4.1). */
const DEFAULT_MAX_CANDIDATES = 500;

/**
 * The pull requests of a label sweep's first page, all the early exit
 * inspects (contract §2.4.2): enough to tell a suggestion label from a busy
 * ordinary one, small enough that a wrong label costs one short request.
 */
const EARLY_EXIT_PAGE = 20;

/** Items asked for per sweep page after the first (GraphQL's maximum). */
const SWEEP_PAGE = 100;

/** The input, validated and captured before the first await. */
interface ICaptured {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  /** The migration override, when given. */
  readonly label: string | undefined;
  readonly originalPullNumber: number | undefined;
  readonly scope: SuggestionOwnerScope;
  readonly maxCandidates: number;
  readonly force: boolean;
  readonly dryRun: boolean;
}

/**
 * How candidates are discovered: the default sweep by suggestion branch, a
 * label sweep (the override without an original), or targeted discovery
 * from one original's backlinks.
 */
type DiscoveryMode = 'branches' | 'label' | 'targeted';

/** The label a run confirms with, and where it came from. */
interface ICleanupLabel {
  readonly name: string;
  readonly source: LabelSource | 'override';
  /** The default branch it was read from (with a repository source). */
  readonly branch: string;
}

function invalid(message: string): TypeError {
  return new TypeError(`Invalid closeSuggestionPullRequests input: ${message}`);
}

/** An own data property's value; an accessor is refused and its getter never runs. */
function dataField(object: object, key: string, where: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw invalid(`${where} must be a data property, not an accessor`);
  return descriptor.value;
}

function isRepositoryName(value: unknown): value is string {
  return typeof value === 'string' && REPO_PATTERN.test(value) && value !== '.' && value !== '..';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isOwnerScope(value: unknown): value is SuggestionOwnerScope {
  return value === 'me' || value === 'all';
}

/** An optional boolean field, refused when it is anything else. */
function booleanField(input: object, key: string): boolean {
  const value = dataField(input, key, key);
  if (value !== undefined && typeof value !== 'boolean') throw invalid(`${key} must be a boolean`);
  return value ?? false;
}

function capture(input: unknown): ICaptured {
  if (!isPlainObject(input)) throw invalid('input must be a plain object');
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === 'symbol' || !INPUT_KEYS.has(key)) throw invalid(`unknown field ${String(key)}`);
  }
  const repository = dataField(input, 'repository', 'repository');
  if (!isPlainObject(repository) || Reflect.ownKeys(repository).map(String).sort().join(',') !== 'owner,repo') {
    throw invalid('repository must be exactly { owner, repo }');
  }
  const owner = dataField(repository, 'owner', 'repository.owner');
  const repo = dataField(repository, 'repo', 'repository.repo');
  if (typeof owner !== 'string' || !OWNER_PATTERN.test(owner)) throw invalid('repository.owner must be a GitHub account name');
  if (!isRepositoryName(repo)) throw invalid('repository.repo must be a GitHub repository name');
  const token = dataField(input, 'token', 'token');
  if (typeof token !== 'string' || token.length === 0) throw invalid('token must be a non-empty string');
  const label = dataField(input, 'label', 'label');
  if (label !== undefined && !isLabelName(label)) throw invalid(`label must be ${LABEL_RULE}`);
  const originalPullNumber = dataField(input, 'originalPullNumber', 'originalPullNumber');
  if (originalPullNumber !== undefined && !isPositiveInteger(originalPullNumber)) throw invalid('originalPullNumber must be a positive integer');
  const scope = dataField(input, 'owner', 'owner');
  if (scope !== undefined && !isOwnerScope(scope)) throw invalid("owner must be 'me' or 'all'");
  const maxCandidates = dataField(input, 'maxCandidates', 'maxCandidates');
  if (maxCandidates !== undefined && !isPositiveInteger(maxCandidates)) throw invalid('maxCandidates must be a positive integer');
  const force = booleanField(input, 'force');
  // An option that could change nothing is refused rather than ignored
  // (contract §2.2): only a label sweep stops early, and only a sweep has a
  // candidate limit. `force: false` asks for nothing, so it is accepted.
  if (force && label === undefined) throw invalid('force applies only to a label sweep, so it requires label');
  if (force && originalPullNumber !== undefined) throw invalid('force applies only to a label sweep, so it cannot be combined with originalPullNumber');
  if (maxCandidates !== undefined && originalPullNumber !== undefined) {
    throw invalid('maxCandidates limits a sweep, so it cannot be combined with originalPullNumber (targeted discovery has no limit)');
  }
  return {
    owner,
    repo,
    token,
    label,
    originalPullNumber,
    scope: scope ?? 'me',
    maxCandidates: maxCandidates ?? DEFAULT_MAX_CANDIDATES,
    force,
    dryRun: booleanField(input, 'dryRun'),
  };
}

function discoveryMode(captured: ICaptured): DiscoveryMode {
  if (captured.originalPullNumber !== undefined) return 'targeted';
  return captured.label === undefined ? 'branches' : 'label';
}

/**
 * The label a run uses (contract §2.2.1): the override, without reading the
 * configuration; otherwise the canonical label, resolved exactly as
 * publication resolves it. An invalid configuration is refused, naming the
 * file and field; a failed read propagates as the operational error it is.
 *
 * An original's 404 means "no such pull request" (`not-found`) only once
 * the repository is known to exist: GitHub answers 404 as well for a
 * repository that does not exist or that the token cannot see, which must
 * fail, never pass as a complete cleanup. The configuration read begins by
 * reading the repository, and a sweep's first page fails on a missing one;
 * only the override in targeted mode reads nothing else first, so there the
 * repository is read on its own.
 */
async function resolveLabel(captured: ICaptured, client: CleanupClient): Promise<ICleanupLabel> {
  if (captured.label !== undefined) {
    if (captured.originalPullNumber !== undefined) await confirmRepository(captured, client);
    return { name: captured.label, source: 'override', branch: '' };
  }
  const { owner, repo } = captured;
  const configuration = await client.readDefaultBranchFile({ owner, repo, path: SUGGESTION_PR_CONFIGURATION_PATH });
  const canonical = resolveCanonicalLabel(configuration);
  if (canonical.status === 'invalid') {
    throw new Error(
      `${configurationProblem(`${owner}/${repo}`, canonical.branch, canonical.detail)} Fix it on the default branch, or name the label to check with label (--label).`,
    );
  }
  return { name: canonical.label, source: canonical.source, branch: canonical.branch };
}

/**
 * Reads the repository, rejecting with an operational Error that names it
 * when the read fails for any reason (a mistyped name and a repository the
 * token cannot see are both a 404).
 */
async function confirmRepository(captured: ICaptured, client: CleanupClient): Promise<void> {
  const { owner, repo } = captured;
  try {
    await client.readRepository({ owner, repo });
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    // The message carries GitHub's answer; like the configuration refusal in
    // resolveLabel, no cause is attached, so it is not printed twice.
    throw new Error(`The repository ${owner}/${repo} could not be read (${err.message}). Check the repository name, and that this token can read it.`);
  }
}

// ---------------------------------------------------------------------------
// Discovery

/** A pull request discovery found, before classification. */
interface ICandidate extends IListedPullRequest {
  readonly state: 'open' | 'closed' | 'merged';
}

/** Why a sweep stopped before evaluating anything (contract §2.4.1, §2.4.2). */
type StopReason = 'too-many-candidates' | 'label-not-suggestion-prs';

/** A sweep stopped after its first page: what it counted and what it inspected. */
interface IStopped {
  readonly kind: 'stopped';
  readonly reason: StopReason;
  /** The listing's total count. */
  readonly total: number;
  /** The pull requests of the first page (the early exit's evidence). */
  readonly inspected: number;
}

/** Discovery that ran to the end: every candidate, and how many the listing counted. */
interface IFound {
  readonly kind: 'found';
  readonly candidates: readonly ICandidate[];
  readonly total: number;
  readonly label: ICleanupLabel;
}

/**
 * Whether a listed pull request looks like a suggestion pull request by its
 * listing alone (contract §2.4.2): a line that begins as a marker does, even
 * a malformed one, and so does a head branch under `suggestion-pr/`.
 */
function looksLikeSuggestion(pull: IListedPullRequest): boolean {
  return findSuggestionMarker(pull.body).kind !== 'none' || pull.headRef.startsWith(SUGGESTION_BRANCH_PREFIX);
}

/**
 * Steps 1-2 of a sweep: its first page, the early exit and then the
 * candidate limit, then (unless stopped) the label and every further page. A sweep
 * stopped by its first page reads nothing else, not even the configuration,
 * so a bad input costs one request. `label` is a label sweep's label, or
 * undefined for the default sweep by suggestion branch.
 */
async function sweep(captured: ICaptured, client: CleanupClient, label: string | undefined): Promise<IStopped | IFound> {
  const { owner, repo } = captured;
  const list = (first: number, after: string | null): Promise<IOpenPullRequestPage> =>
    label === undefined
      ? client.listOpenPullRequestsByBranchPrefix({ owner, repo, branchPrefix: SUGGESTION_BRANCH_PREFIX, first, after })
      : client.listOpenPullRequestsByLabel({ owner, repo, label, first, after });
  const first = await list(label === undefined ? SWEEP_PAGE : EARLY_EXIT_PAGE, null);
  const inspected = first.pullRequests.length;
  // The early exit is decided before the limit, from the same page: a wrong
  // label is refused as a wrong label however many pull requests carry it.
  // `force` bypasses only the early exit; the limit still applies.
  if (label !== undefined && !captured.force && inspected > 0 && !first.pullRequests.some(looksLikeSuggestion)) {
    return { kind: 'stopped', reason: 'label-not-suggestion-prs', total: first.totalCount, inspected };
  }
  if (first.totalCount > captured.maxCandidates) return { kind: 'stopped', reason: 'too-many-candidates', total: first.totalCount, inspected };
  const resolved = await resolveLabel(captured, client);
  const pulls = [...first.pullRequests];
  // The listing may grow while it is read, but not without bound: one page
  // of growth is tolerated, more stops the run before anything is closed.
  const bound = first.totalCount + SWEEP_PAGE;
  const seen = new Set<string>();
  let items = first.itemCount;
  for (let after = first.nextCursor; after !== null; ) {
    if (seen.has(after)) throw new GitHubError('pagination', 'The sweep listing repeated a page; nothing was closed.');
    seen.add(after);
    const page = await list(SWEEP_PAGE, after);
    items += page.itemCount;
    if (items > bound) {
      throw new GitHubError('pagination', `The sweep listing grew past ${String(bound)} items while it was read; nothing was closed. Run cleanup again.`);
    }
    pulls.push(...page.pullRequests);
    after = page.nextCursor;
  }
  return { kind: 'found', candidates: unique(pulls.map((pr) => ({ ...pr, state: 'open' as const }))), total: first.totalCount, label: resolved };
}

// ---------------------------------------------------------------------------
// Cleanup

/** A reported pull request, with the stage a failure happened at (which only changes its wording). */
interface IChecked extends ICheckedSuggestionPullRequest {
  readonly failedWhile?: 'reading' | 'closing';
  /** Whether discovery listed it with the label. */
  readonly labeled: boolean;
}

/** A suggestion verified for closing: its candidate and marker. */
interface IEligible {
  readonly candidate: ICandidate;
  readonly original: number;
}

/** One run of cleanup: its captured input, client and everything it has established. */
class Cleanup {
  private readonly originals = new Map<number, IOriginalPullRequest>();
  private readonly checked: IChecked[] = [];
  /** The pull requests that conformed when discovery listed them. */
  private readonly conforming = new Set<number>();
  private label: ICleanupLabel | undefined;
  /** The candidates discovery counted (see ISuggestionCleanupCounts). */
  private candidates = 0;
  /** The authenticated account's login, read once and only when an owner decides something. */
  private login: Promise<string> | undefined;

  constructor(
    private readonly captured: ICaptured,
    private readonly client: CleanupClient,
  ) {}

  async run(): Promise<IReported<ICloseSuggestionPullRequestsOutcome>> {
    const mode = discoveryMode(this.captured);
    let candidates: readonly ICandidate[];
    if (mode === 'targeted') {
      this.label = await resolveLabel(this.captured, this.client);
      candidates = await this.referencingCandidates();
      this.candidates = candidates.length;
    } else {
      const found = await sweep(this.captured, this.client, this.captured.label);
      if (found.kind === 'stopped') return stoppedOutcome(this.captured, found);
      this.label = found.label;
      this.candidates = found.total;
      candidates = found.candidates;
    }
    const eligible = await this.classifyAndVerify(candidates, mode);
    for (const { candidate, original } of eligible) {
      if (this.captured.dryRun) this.report(candidate, original, 'would-close');
      else await this.close(candidate, original);
    }
    return this.outcome();
  }

  /** The label this run confirms with (resolved before classification starts). */
  private get suggestionLabel(): ICleanupLabel {
    if (this.label === undefined) throw new Error('Internal error: the suggestion label was not resolved before classification.');
    return this.label;
  }

  /**
   * Targeted discovery: the original is resolved first, and only when it is
   * verified are the pull requests of this repository that reference it
   * listed, each once. Nothing can be closed for an original that cannot be
   * verified, and nothing can reference one that does not exist (the run is
   * then complete, with a warning about the original).
   */
  private async referencingCandidates(): Promise<ICandidate[]> {
    const { owner, repo, originalPullNumber } = this.captured;
    if (originalPullNumber === undefined) return [];
    const original = await this.resolveOriginal(originalPullNumber);
    if (original.state === 'unverified' || original.state === 'not-found') return [];
    const listed = await this.client.listCrossReferencingPullRequests({ owner, repo, pullNumber: originalPullNumber });
    return unique(listed.filter((pr) => this.isThisRepository(pr.repository)));
  }

  /** Steps 3-4: every read after discovery, and nothing else. */
  private async classifyAndVerify(candidates: readonly ICandidate[], mode: DiscoveryMode): Promise<IEligible[]> {
    const { originalPullNumber } = this.captured;

    // Rows 1-4 of contract §2.6: the marker, its repository and (targeted) its original.
    const marked: { readonly candidate: ICandidate; readonly marker: ISuggestionMarkerFields; readonly line: string }[] = [];
    for (const candidate of candidates) {
      const reading = findSuggestionMarker(candidate.body);
      if (reading.kind === 'none') {
        // Targeted discovery also finds ordinary references: no marker, label or suggestion branch.
        const labeled = this.hasLabel(candidate.labels);
        if (mode === 'targeted' && !labeled && !this.onSuggestionBranch(candidate)) continue;
        const why = mode === 'label' || (mode === 'targeted' && labeled)
          ? 'it has the label but no suggestion marker'
          : `its branch is under \`${SUGGESTION_BRANCH_PREFIX}\`, but it has no suggestion marker`;
        this.report(candidate, null, 'not-conforming', why);
      } else if (reading.kind === 'several') {
        this.report(candidate, null, 'not-conforming', 'its body has more than one suggestion marker');
      } else if (reading.kind === 'malformed') {
        this.report(candidate, null, 'not-conforming', 'its suggestion marker is not in the canonical form');
      } else if (!this.isThisRepository(`${reading.fields.owner}/${reading.fields.repo}`)) {
        this.report(candidate, null, 'not-conforming', `its marker names another repository (${reading.fields.owner}/${reading.fields.repo})`);
      } else if (originalPullNumber !== undefined && reading.fields.pullNumber !== originalPullNumber) {
        this.report(candidate, reading.fields.pullNumber, 'not-conforming', `its marker names #${String(reading.fields.pullNumber)}, not #${String(originalPullNumber)}`);
      } else {
        marked.push({ candidate, marker: reading.fields, line: reading.line });
      }
    }

    // Row 5: open pull requests claiming one suggestion cannot be told apart.
    const claims = new Map<string, number[]>();
    for (const { candidate, marker } of marked) {
      if (candidate.state === 'open') claims.set(marker.id, [...(claims.get(marker.id) ?? []), candidate.number]);
    }

    const eligible: IEligible[] = [];
    for (const { candidate, marker, line } of marked) {
      const original = marker.pullNumber;
      const others = (claims.get(marker.id) ?? []).filter((n) => n !== candidate.number);
      const branchProblem = this.headProblem(candidate.headRepository, candidate.headRef, suggestionPrBranch(original, marker.id));
      if (others.length > 0) {
        const list = others.map((n) => `#${String(n)}`).join(', ');
        const who = others.length === 1 ? `another open pull request (${list}) carries a marker` : `other open pull requests (${list}) carry markers`;
        this.report(candidate, original, 'not-conforming', `${who} for the same suggestion`);
      } else if (branchProblem !== null) {
        // Row 6: the head branch the marker names, in this repository.
        this.report(candidate, original, 'not-conforming', branchProblem);
      } else {
        this.conforming.add(candidate.number);
        if (candidate.state !== 'open') this.report(candidate, original, 'already-closed');
        else if (!this.hasLabel(candidate.labels)) this.report(candidate, original, 'unlabeled');
        else if (!(await this.isInScope(candidate))) this.report(candidate, original, 'other-owner');
        else {
          const resolved = await this.resolveOriginal(original);
          if (resolved.state === 'open') this.report(candidate, original, 'left-open');
          else if (resolved.state === 'unverified') this.report(candidate, original, 'unverified', resolved.reason);
          else if (resolved.state === 'not-found') this.report(candidate, original, 'not-conforming', `its marker names #${String(original)}, which is not a pull request in ${this.fullName()}`);
          else if (await this.verify(candidate, marker, line)) eligible.push({ candidate, original });
        }
      }
    }
    return eligible;
  }

  /**
   * Whether the owner scope lets this run close a pull request (contract
   * §2.6): always with `all`; with `me`, only one the authenticated account
   * opened (logins compared case-insensitively). A pull request without an
   * author (a deleted account) was not opened by this one.
   */
  private async isInScope(candidate: ICandidate): Promise<boolean> {
    if (this.captured.scope === 'all') return true;
    if (candidate.author === null) return false;
    this.login ??= this.client.getAuthenticatedUser().then((user) => user.login);
    return candidate.author.toLowerCase() === (await this.login).toLowerCase();
  }

  /**
   * An original's state, read once however many suggestions name it
   * (contract §2.7). A 404 is GitHub's definitive answer that the repository
   * has no such pull request this account can read: `not-found`, the same on
   * every run. Every other failure is `unverified`.
   */
  private async resolveOriginal(pullNumber: number): Promise<IOriginalPullRequest> {
    const known = this.originals.get(pullNumber);
    if (known !== undefined) return known;
    let resolved: IOriginalPullRequest;
    try {
      const pull = await this.client.getPullRequest({ owner: this.captured.owner, repo: this.captured.repo, pullNumber });
      resolved = { number: pullNumber, state: pull.state === 'open' ? 'open' : pull.merged ? 'merged' : 'closed' };
    } catch (err) {
      // Positive verification only: a lookup that fails for any reason is
      // not evidence that the original ended.
      if (!(err instanceof GitHubError)) throw err;
      resolved = err.code === 'http-status' && err.status === 404
        ? { number: pullNumber, state: 'not-found' }
        : { number: pullNumber, state: 'unverified', reason: this.safe(err.message) };
    }
    this.originals.set(pullNumber, resolved);
    return resolved;
  }

  /** Contract §2.8: whether a suggestion of an ended original may be closed, reporting it when not. */
  private async verify(candidate: ICandidate, marker: ISuggestionMarkerFields, line: string): Promise<boolean> {
    const { owner, repo } = this.captured;
    let fresh: IPullRequestSnapshot;
    try {
      fresh = await this.client.getPullRequest({ owner, repo, pullNumber: candidate.number });
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      this.report(candidate, marker.pullNumber, 'failed', this.safe(err.message), 'reading');
      return false;
    }
    const original = marker.pullNumber;
    const reading = findSuggestionMarker(fresh.body);
    const headProblem = this.headProblem(fresh.headRepository, fresh.headRef, suggestionPrBranch(original, marker.id));
    if (fresh.state !== 'open') {
      this.report(candidate, original, 'already-closed');
    } else if (reading.kind !== 'marker' || reading.line !== line) {
      this.report(candidate, original, 'not-conforming', 'its suggestion marker changed while it was being checked');
    } else if (!this.isThisRepository(fresh.baseRepository)) {
      this.report(candidate, original, 'not-conforming', `it belongs to another repository (${fresh.baseRepository})`);
    } else if (headProblem !== null) {
      this.report(candidate, original, 'not-conforming', headProblem);
    } else if (!this.hasLabel(fresh.labels)) {
      this.report(candidate, original, 'unlabeled');
    } else {
      return true;
    }
    return false;
  }

  /**
   * Why a head branch is not the suggestion's (convention §5, §9), or null
   * when it is: it must be `branch`, in this repository (never a fork's, D25).
   */
  private headProblem(headRepository: string | null, headRef: string, branch: string): string | null {
    if (headRepository === null || !this.isThisRepository(headRepository)) {
      return `its head branch is in another repository (${headRepository ?? 'a deleted repository'})`;
    }
    return headRef === branch ? null : `its head branch is \`${headRef}\`, not \`${branch}\``;
  }

  /** Step 5: one close; its answer decides the result (contract §2.9). */
  private async close(candidate: ICandidate, original: number): Promise<void> {
    const { owner, repo } = this.captured;
    try {
      await this.client.closePullRequest({ owner, repo, pullNumber: candidate.number });
    } catch (err) {
      // The pull request was just read, so a 404 as well as a 403 means this
      // account may see it but not close it. Rate limits and anything else
      // are failures, never a claim either way; the error is reported rather
      // than thrown so the closes already made stay in the outcome.
      const refused = err instanceof GitHubError && err.code === 'http-status' && (err.status === 403 || err.status === 404);
      this.report(candidate, original, refused ? 'permission-limited' : 'failed', this.safe(messageChain(err)), 'closing');
      return;
    }
    this.report(candidate, original, 'closed');
  }

  private report(candidate: ICandidate, original: number | null, result: SuggestionCleanupResult, reason?: string, failedWhile?: 'reading' | 'closing'): void {
    this.checked.push({
      number: candidate.number,
      url: candidate.htmlUrl,
      original,
      result,
      ...(reason === undefined ? {} : { reason }),
      ...(failedWhile === undefined ? {} : { failedWhile }),
      labeled: this.hasLabel(candidate.labels),
    });
  }

  private hasLabel(labels: readonly string[]): boolean {
    const wanted = this.suggestionLabel.name.toLowerCase();
    return labels.some((label) => label.toLowerCase() === wanted);
  }

  /** Whether a pull request's head is a branch under `suggestion-pr/` of this repository. */
  private onSuggestionBranch(candidate: ICandidate): boolean {
    return candidate.headRepository !== null && this.isThisRepository(candidate.headRepository) && candidate.headRef.startsWith(SUGGESTION_BRANCH_PREFIX);
  }

  /** Whether `owner/repo` names this repository (GitHub names are case-insensitive). */
  private isThisRepository(fullName: string): boolean {
    return fullName.toLowerCase() === this.fullName().toLowerCase();
  }

  /** This repository as `owner/repo`, as given. */
  private fullName(): string {
    return `${this.captured.owner}/${this.captured.repo}`;
  }

  private safe(text: string): string {
    return redact(text, this.captured.token);
  }

  private outcome(): IReported<ICloseSuggestionPullRequestsOutcome> {
    const originals = [...this.originals.values()].sort((a, b) => a.number - b.number);
    // Each pull request is reported once; a stable sort keeps that order among equals.
    const checked = [...this.checked].sort((a, b) => a.number - b.number);
    const incomplete = originals.some((o) => o.state === 'unverified') || checked.some((s) => s.result === 'failed' || s.result === 'unverified');
    const status: IReport['status'] = incomplete
      ? 'incomplete'
      : checked.some((s) => s.result === 'permission-limited')
        ? 'permission-limited'
        : 'complete';
    const suggestions = checked.map((c): ICheckedSuggestionPullRequest => ({
      number: c.number,
      url: c.url,
      original: c.original,
      result: c.result,
      ...(c.reason === undefined ? {} : { reason: c.reason }),
    }));
    const counts: ISuggestionCleanupCounts = {
      candidates: this.candidates,
      checked: checked.length,
      labeled: checked.filter((c) => c.labeled).length,
      conforming: this.conforming.size,
    };
    const report: IReport = { captured: this.captured, label: this.suggestionLabel, status, counts, originals, checked };
    return {
      outcome: {
        status,
        dryRun: this.captured.dryRun,
        owner: this.captured.scope,
        originals,
        suggestions,
        counts,
        markdown: this.safe(renderMarkdown(report)),
        diagnostics: cleanupDiagnostics(this.captured, originals, suggestions).map((d) => mapDiagnosticText(d, (text) => this.safe(text))),
      },
      report: this.safe(renderMarkdown(report, false)),
    };
  }
}

/**
 * The diagnostics of a cleanup, each about one pull request: every original
 * that could not be verified, the targeted original when it does not exist,
 * and every suggestion pull request that failed, could not be closed with
 * this account, or does not follow the convention. Suggestions left open
 * because their original could not be verified are covered by that
 * original's warning. An original that does not exist and is not the
 * targeted one was named by a suggestion's marker, whose `not-conforming`
 * note says so. One someone else opened is the owner scope working as asked,
 * not a problem, so it has none.
 */
function cleanupDiagnostics(
  captured: ICaptured,
  originals: readonly IOriginalPullRequest[],
  suggestions: readonly ICheckedSuggestionPullRequest[],
): IDiagnostic[] {
  const subject = (n: number): string => `${captured.owner}/${captured.repo}#${String(n)}`;
  const because = (reason: string | undefined): string => (reason === undefined ? '' : ` (${reason})`);
  const forOriginal = (original: number | null): string => (original === null ? '' : ` (for #${String(original)})`);
  const found: IDiagnostic[] = [];
  for (const o of originals) {
    if (o.state === 'unverified') {
      found.push(createDiagnostic('original-pull-request-unverified',
        `Pull request #${String(o.number)} could not be verified${because(o.reason)}, so its suggestion pull requests were left open.`, { subject: subject(o.number) }));
    } else if (o.state === 'not-found' && o.number === captured.originalPullNumber) {
      found.push(createDiagnostic('original-pull-request-not-found',
        `${notFoundText(captured, o.number)}, so no suggestion pull request can reference it.`, { subject: subject(o.number) }));
    }
  }
  for (const s of suggestions) {
    const which = `#${String(s.number)}${forOriginal(s.original)}`;
    if (s.result === 'failed') {
      found.push(createDiagnostic('suggestion-pr-cleanup-failed', `Cleanup of ${which} did not finish${because(s.reason)}.`, { subject: subject(s.number) }));
    } else if (s.result === 'permission-limited') {
      found.push(createDiagnostic('suggestion-pr-close-not-permitted', `${which} was left open, not permitted to close it${because(s.reason)}.`, { subject: subject(s.number) }));
    } else if (s.result === 'not-conforming') {
      found.push(createDiagnostic('suggestion-pr-not-conforming', `#${String(s.number)} does not follow the suggestion pull request convention${because(s.reason)}, so it was not touched.`, { subject: subject(s.number) }));
    }
  }
  return orderDiagnostics(found);
}

/** Candidates in ascending number order, each pull request once (a listing can repeat one). */
function unique(candidates: readonly ICandidate[]): ICandidate[] {
  const byNumber = new Map<number, ICandidate>();
  for (const candidate of candidates) if (!byNumber.has(candidate.number)) byNumber.set(candidate.number, candidate);
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

// ---------------------------------------------------------------------------
// A stopped sweep (contract §2.4.1, §2.4.2)

/** What a sweep counted, in the words of its listing. */
function listingText(captured: ICaptured, count: number): string {
  const where = `${captured.owner}/${captured.repo}`;
  if (captured.label === undefined) return `${String(count)} branch${count === 1 ? '' : 'es'} under \`${SUGGESTION_BRANCH_PREFIX}\` in ${where}`;
  return `${String(count)} open pull request${count === 1 ? '' : 's'} labeled \`${captured.label}\` in ${where}`;
}

/** The diagnostic of a stopped sweep: the count and the limit, or what the first page showed. */
function stopDiagnostic(captured: ICaptured, stopped: IStopped): IDiagnostic {
  const subject = `${captured.owner}/${captured.repo}`;
  if (stopped.reason === 'too-many-candidates') {
    return createDiagnostic(
      'suggestion-pr-candidates-over-limit',
      `There are ${listingText(captured, stopped.total)}, more than the limit of ${String(captured.maxCandidates)} candidates, so nothing was checked or closed.`,
      { subject },
    );
  }
  const labeled = `open pull request${stopped.total === 1 ? '' : 's'} labeled \`${captured.label ?? ''}\` in ${subject}`;
  const which = stopped.total === 1
    ? `The only ${labeled} has no suggestion marker and no \`${SUGGESTION_BRANCH_PREFIX}\` branch`
    : stopped.inspected < stopped.total
      ? `None of the first ${String(stopped.inspected)} of the ${String(stopped.total)} ${labeled} has a suggestion marker or a \`${SUGGESTION_BRANCH_PREFIX}\` branch`
      : `None of the ${String(stopped.total)} ${labeled} has a suggestion marker or a \`${SUGGESTION_BRANCH_PREFIX}\` branch`;
  return createDiagnostic('label-not-suggestion-prs', `${which}, so the label does not look like a suggestion label, and nothing was checked or closed.`, { subject });
}

const STOPPED_TITLES: Readonly<Record<StopReason, string>> = {
  'too-many-candidates': '## Suggestion pull request cleanup stopped: too many candidates',
  'label-not-suggestion-prs': '## Suggestion pull request cleanup stopped: the label does not mark suggestion pull requests',
};

/**
 * The outcome of a sweep stopped by its first page: nothing evaluated, the
 * count, and one diagnostic. The Markdown is its title and the diagnostic's
 * message; the CLI's human report leaves the message to stderr.
 */
function stoppedOutcome(captured: ICaptured, stopped: IStopped): IReported<ICloseSuggestionPullRequestsOutcome> {
  const diagnostic = stopDiagnostic(captured, stopped);
  return {
    outcome: {
      status: stopped.reason,
      dryRun: captured.dryRun,
      owner: captured.scope,
      originals: [],
      suggestions: [],
      counts: { candidates: stopped.total, checked: 0, labeled: 0, conforming: 0 },
      markdown: [STOPPED_TITLES[stopped.reason], '', diagnostic.message].join('\n'),
      diagnostics: [diagnostic],
    },
    report: [STOPPED_TITLES[stopped.reason], '', 'Nothing was checked or closed.'].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Presentation

const ORIGINAL_TEXT: Readonly<Record<Exclude<OriginalPullRequestState, 'unverified' | 'not-found'>, string>> = {
  open: 'open',
  merged: 'merged',
  closed: 'closed without merging',
};

/** What GitHub's 404 for original `n` establishes, as a clause. */
function notFoundText(captured: ICaptured, n: number): string {
  return `${captured.owner}/${captured.repo} has no pull request #${String(n)} that this account can read`;
}

function originalLine(captured: ICaptured, original: IOriginalPullRequest): string {
  const state = original.state === 'unverified'
    ? `could not be verified (${original.reason ?? 'no reason given'})`
    : original.state === 'not-found'
      ? `not found (${notFoundText(captured, original.number)})`
      : ORIGINAL_TEXT[original.state];
  return `- #${String(original.number)}: ${state}`;
}

/** Original states that are diagnostics (see cleanupDiagnostics), which the CLI's human report leaves to stderr. */
const DIAGNOSED_ORIGINALS: ReadonlySet<OriginalPullRequestState> = new Set(['unverified', 'not-found']);

function resultText(entry: IChecked, label: string): string {
  const reason = entry.reason ?? 'no reason given';
  switch (entry.result) {
    case 'closed':
      return 'closed';
    case 'would-close':
      return 'would be closed';
    case 'already-closed':
      return 'already closed';
    case 'left-open':
      return 'left open, because the original is still open';
    case 'unverified':
      return 'left open, because the original could not be verified';
    case 'permission-limited':
      return `left open, not permitted to close it: ${reason}`;
    case 'failed':
      return entry.failedWhile === 'reading' ? `not closed, it could not be read again before closing: ${reason}` : `not closed, the close failed: ${reason}`;
    case 'not-conforming':
      return `skipped, not a conforming suggestion pull request: ${reason}`;
    case 'other-owner':
      return 'left open, because someone else opened it';
    case 'unlabeled':
      return `skipped, it does not carry the label \`${label}\``;
  }
}

/** The titles of a cleanup that evaluated its candidates. */
const TITLES: Readonly<Record<Exclude<CloseSuggestionPullRequestsStatus, StopReason>, string>> = {
  complete: '## Suggestion pull request cleanup complete',
  'permission-limited': '## Suggestion pull request cleanup limited by permissions',
  incomplete: '## Suggestion pull request cleanup incomplete',
};

/** Where the label came from, as the scope line says it (contract §2.10). */
function labelSource(label: ICleanupLabel): string {
  return label.source === 'override' ? "a label given in place of the repository's suggestion label" : labelSourceText(label.source, label.branch);
}

/** Whose suggestion pull requests may be closed, as the scope line says it (contract §2.10). */
const OWNER_TEXT: Readonly<Record<SuggestionOwnerScope, string>> = {
  me: 'Only suggestion pull requests opened by this account are closed.',
  all: 'Suggestion pull requests are closed whoever opened them.',
};

/** The scope line: what was checked, with which label, and whose suggestions may be closed. */
function scopeLine(captured: ICaptured, label: ICleanupLabel): string {
  const where = `${captured.owner}/${captured.repo}`;
  const source = labelSource(label);
  const checked = captured.originalPullNumber !== undefined
    ? `Checked the pull requests that reference #${String(captured.originalPullNumber)} in ${where}; the suggestion label is \`${label.name}\` (${source}).`
    : captured.label === undefined
      ? `Checked the open pull requests on \`${SUGGESTION_BRANCH_PREFIX}\` branches in ${where}; the suggestion label is \`${label.name}\` (${source}).`
      : `Checked the open pull requests labeled \`${label.name}\` in ${where} (${source}).`;
  return `${checked} ${OWNER_TEXT[captured.scope]}`;
}

/** Suggestion results that are diagnostics (see cleanupDiagnostics), which the CLI's human report leaves to stderr. */
const DIAGNOSED_RESULTS: ReadonlySet<SuggestionCleanupResult> = new Set(['unverified', 'permission-limited', 'failed', 'not-conforming']);

/** Everything a cleanup report says. */
interface IReport {
  readonly captured: ICaptured;
  readonly label: ICleanupLabel;
  readonly status: Exclude<CloseSuggestionPullRequestsStatus, StopReason>;
  readonly counts: ISuggestionCleanupCounts;
  readonly originals: readonly IOriginalPullRequest[];
  readonly checked: readonly IChecked[];
}

/**
 * The cleanup report. In full for the outcome's `markdown`; with `full`
 * false, the CLI's human report (IReported), which leaves out the entries
 * the outcome's diagnostics already say: originals that could not be
 * verified or were not found, and suggestions left open by them, refused,
 * failed or not conforming.
 */
function renderMarkdown({ captured, label, status, counts, originals: allOriginals, checked: allChecked }: IReport, full = true): string {
  const originals = full ? allOriginals : allOriginals.filter((o) => !DIAGNOSED_ORIGINALS.has(o.state));
  const checked = full ? allChecked : allChecked.filter((c) => !DIAGNOSED_RESULTS.has(c.result));
  const lines = [status === 'complete' && captured.dryRun ? '## Suggestion pull request cleanup: dry run' : TITLES[status], '', scopeLine(captured, label), ''];
  if (counts.checked > 0) {
    lines.push(`Pull requests checked: ${String(counts.checked)} (${String(counts.labeled)} labeled, ${String(counts.conforming)} conforming).`, '');
  }
  if (originals.length > 0) lines.push('Original pull requests:', '', ...originals.map((o) => originalLine(captured, o)), '');
  if (allChecked.length === 0) {
    lines.push('No suggestion pull requests were found.', '');
  } else if (checked.length > 0) {
    lines.push('Suggestion pull requests:', '');
    for (const entry of checked) {
      const forOriginal = entry.original === null ? '' : ` (for #${String(entry.original)})`;
      lines.push(`- #${String(entry.number)}${forOriginal}: ${resultText(entry, label.name)}`);
    }
    lines.push('');
  }
  if (captured.dryRun) lines.push('This was a dry run: nothing was closed.', '');
  if (status === 'incomplete') {
    lines.push('Some results could not be established. Running the cleanup again is safe: it closes only suggestion pull requests that are still open and eligible.', '');
  }
  if (allChecked.some((entry) => entry.result === 'permission-limited')) {
    lines.push('Someone allowed to close the pull requests left open can finish, for example by running this cleanup with their own token.', '');
  }
  lines.push('Closing never deletes a branch: each proposal branch is left in place.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point

/**
 * Closes open suggestion pull requests whose original pull request has
 * merged or closed, in one repository.
 *
 * @remarks
 * Suggestion pull requests follow the tool-neutral suggestion pull request
 * convention, whichever tool created them: they are recognized by the
 * structured marker in their description, never by their title. By default
 * the open pull requests of the repository's branches under `suggestion-pr/`
 * are checked, and each must carry the repository's canonical suggestion
 * label (the `label` of `.github/suggestion-prs.json` on the default branch,
 * otherwise `suggestion-pr`); with `label`, the open pull requests carrying
 * that label instead; with `originalPullNumber`, only the pull requests
 * referencing that original. By default only suggestion pull requests opened
 * by the authenticated account are closed; with `owner: 'all'`, any.
 *
 * A sweep counts its candidates first, in one request. A label sweep whose
 * first 20 pull requests show no suggestion marker and no suggestion branch
 * stops there, unless `force` is set; then any sweep evaluates nothing when
 * there are more than `maxCandidates` (default 500). So a mistyped or
 * overly broad label costs one request, never a walk through the repository.
 * The default sweep counts every branch under `suggestion-pr/`, including
 * those of suggestions already closed (cleanup never deletes a branch), so
 * an active repository can reach the limit over time; raise it with
 * `maxCandidates`.
 *
 * A suggestion is closed only after its original has been read and found
 * merged or closed, and after the suggestion itself has been read again and
 * verified: an original that cannot be read is `unverified`, and one GitHub
 * reports does not exist is `not-found`; neither is ever treated as ended.
 * Everything is read before anything is closed.
 *
 * Closing is the only change made. Branches are never deleted, and nothing
 * is edited, labeled, commented on or reopened; the original is never
 * touched. Running cleanup again is safe: suggestions already closed are not
 * listed again (or are reported `already-closed`).
 *
 * @param input - The repository, credential and optional label, original,
 * owner scope, candidate limit, force and dry-run settings.
 * @returns What was checked and done. The status is `complete`, or
 * else `permission-limited` (some eligible suggestions could not be closed
 * with this account), `incomplete` (an original could not be verified or an
 * action failed), or `too-many-candidates` or `label-not-suggestion-prs` (a
 * sweep stopped before evaluating anything).
 * @throws A `TypeError` for invalid input, before any request, including
 * `force: true` outside a label sweep and `maxCandidates` with
 * `originalPullNumber`. An `Error`
 * when the repository configuration is invalid (naming the file and field)
 * or cannot be read, or when discovery or reading the account fails (GitHub,
 * network, authentication), before anything was closed. Neither a result
 * nor a rejection contains the token.
 *
 * @example
 * ```ts
 * import { closeSuggestionPullRequests } from 'sarif-to-comment';
 *
 * const cleanup = await closeSuggestionPullRequests({
 *   repository: { owner: 'acme', repo: 'widgets' },
 *   token: process.env.GH_TOKEN!,
 *   owner: 'me', // the default: only suggestion pull requests this account opened
 *   dryRun: true,
 * });
 * for (const s of cleanup.suggestions) console.log(`#${s.number}: ${s.result}`);
 * ```
 *
 * @public
 */
export function closeSuggestionPullRequests(input: ICloseSuggestionPullRequestsInput): Promise<ICloseSuggestionPullRequestsOutcome>;
// Implementation signature, never emitted to the declarations: the input is
// `unknown` because JavaScript callers are unconstrained, and a second
// argument is honoured at runtime as the private test seam. In-package
// callers that inject use closeSuggestionPullRequestsWithInternals. The
// default keeps the function's length 1, like the other operations.
export async function closeSuggestionPullRequests(
  input: unknown,
  internals: ICloseSuggestionPullRequestsInternals = {},
): Promise<ICloseSuggestionPullRequestsOutcome> {
  return closeSuggestionPullRequestsWithInternals(input, internals);
}

/**
 * {@link closeSuggestionPullRequests} with its private test seam typed.
 * Internal: the CLI and tests reach the seam through it; it is not part of the
 * public API.
 */
export async function closeSuggestionPullRequestsWithInternals(
  input: unknown,
  internals: ICloseSuggestionPullRequestsInternals = {},
): Promise<ICloseSuggestionPullRequestsOutcome> {
  return (await closeSuggestionPullRequestsReported(input, internals)).outcome;
}

/**
 * {@link closeSuggestionPullRequests} with the CLI's human report of the
 * outcome (see IReported). Internal: the CLI prints the report in human form.
 */
export async function closeSuggestionPullRequestsReported(
  input: unknown,
  internals: ICloseSuggestionPullRequestsInternals = {},
): Promise<IReported<ICloseSuggestionPullRequestsOutcome>> {
  const captured = capture(input);
  const createGitHubClient = internals.createGitHubClient || defaultCreateGitHubClient;
  try {
    const client = createGitHubClient({ token: captured.token, fetch: globalThis.fetch });
    if (!isCleanupClient(client)) throw new Error('This GitHub client cannot close suggestion pull requests.');
    return await new Cleanup(captured, client).run();
  } catch (err) {
    throw withoutCredential(err, captured.token);
  }
}
