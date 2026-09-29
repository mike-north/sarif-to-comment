/**
 * closeSuggestionPullRequests: on-demand cleanup of companion suggestion pull
 * requests whose original pull request has merged or closed (the eighth
 * public operation; the package entry re-exports it). Contract:
 * docs/suggestion-cleanup-contract.md.
 *
 * Cleanup is not publication and not review maintenance (D27, D29): it acts
 * only on suggestion pull requests this tool created, recognized by their
 * structured marker (src/suggestion-marker.cts), and its only write is to
 * close one. It never deletes or updates a branch, edits a body, title or
 * label, comments, or touches the original. It keeps no local record.
 *
 * ---------------------------------------------------------------------------
 * closeSuggestionPullRequests(input, internals?) -> Promise<Outcome>
 *
 * input (unknown keys are refused; a TypeError before any request):
 *   repository:          { owner, repo }
 *   token:               GitHub user/PAT credential; never shown
 *   label?:              the suggestion label (default 'suggestion'); the
 *                        publication rule plus no comma
 *   originalPullNumber?: targeted mode: only pull requests referencing it
 *   dryRun?:             discover and verify, write nothing
 *
 * Sequence (every read completes before the first write):
 *   1. Discovery. Sweep: every open pull request with the label (the
 *      client's labeled issues listing). Targeted: the original is resolved
 *      first; if it cannot be verified nothing else is read; otherwise its
 *      cross-referencing pull requests in this repository (D21). A pull
 *      request listed twice counts once.
 *   2. Classification in ascending number order (contract §2.6): marker,
 *      repository, targeted original, shared suggestion id, targeted state
 *      and label, then the original's state, resolved once per original.
 *   3. Verification of each suggestion whose original ended, on a fresh read
 *      (contract §2.8): still open, same marker line, head and base in this
 *      repository, head branch sarif-to-comment/suggestions/<original>/<id>,
 *      still labeled.
 *   4. Unless dryRun, one close per eligible suggestion, ascending. A 403 or
 *      404 refusal is permission-limited; any other failure is failed.
 *
 * Outcome: { status, dryRun, originals, suggestions, markdown } (see the
 * public types below). Rejects for invalid input, for an operational failure
 * during discovery (step 1), and for a defect in this package during steps
 * 1-3: always before anything has been written. From step 4 on, every
 * failure is reported in the outcome, so the closes already made are never
 * lost. Neither an outcome nor a rejection contains the token.
 *
 * internals (private seam, not caller API):
 *   createGitHubClient({ token, fetch }) -> a client with the suggestion
 *     cleanup transport of src/github.cts (checked at runtime). Defaults to
 *     src/github.cts.
 */

import { GitHubError, createGitHubClient as defaultCreateGitHubClient } from './github.cjs';
import type { ICreateGitHubClientOptions, IGitHubClient, IPullRequestSnapshot } from './github.cjs';
import type { IGitHubRepository } from './public-types.cjs';
import { DEFAULT_SUGGESTION_LABEL, LABEL_RULE, isLabelName, messageChain, redact, withoutCredential } from './review-preflight.cjs';
import { OWNER_PATTERN, REPO_PATTERN, isPlainObject } from './sarif-common.cjs';
import { findSuggestionMarker } from './suggestion-marker.cjs';
import type { ISuggestionMarkerFields } from './suggestion-marker.cjs';

// ---------------------------------------------------------------------------
// Public types

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
   * The label suggestion pull requests carry (default `suggestion`): 1-50
   * characters without commas, control or invisible formatting characters or
   * surrounding whitespace.
   */
  readonly label?: string | undefined;
  /**
   * Check only the pull requests that reference this original pull request
   * (its backlinks), instead of every open pull request with the label.
   */
  readonly originalPullNumber?: number | undefined;
  /** Read and verify everything, but close nothing; eligible suggestions are reported as `would-close`. */
  readonly dryRun?: boolean | undefined;
}

/**
 * An original pull request's state: `unverified` when it could not be read,
 * which is never treated as ended.
 *
 * @public
 */
export type OriginalPullRequestState = 'open' | 'merged' | 'closed' | 'unverified';

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
 * - `not-ours`: it is not recognizably one of this tool's suggestion pull
 *   requests (no, several or a changed marker, another repository or
 *   original, a fork, or another branch), so it was not touched.
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
  | 'not-ours'
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
  /** Why, for `unverified`, `permission-limited`, `failed` and `not-ours`. */
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
 *
 * @public
 */
export type CloseSuggestionPullRequestsStatus = 'complete' | 'permission-limited' | 'incomplete';

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
  /** Each original pull request resolved, by ascending number. */
  readonly originals: readonly IOriginalPullRequest[];
  /** Each pull request checked, by ascending number. Ordinary references without a marker or the label are not listed. */
  readonly suggestions: readonly ICheckedSuggestionPullRequest[];
  /** What was checked and done, as Markdown, including that no branch is ever deleted. */
  readonly markdown: string;
}

// ---------------------------------------------------------------------------
// Private seam

/** What cleanup needs from a GitHub client. */
type CleanupClient = Pick<IGitHubClient, 'listOpenLabeledPullRequests' | 'getPullRequest' | 'listCrossReferencingPullRequests' | 'closePullRequest'>;

/** The client methods cleanup calls. */
const CLEANUP_METHODS: readonly (keyof CleanupClient)[] = ['listOpenLabeledPullRequests', 'getPullRequest', 'listCrossReferencingPullRequests', 'closePullRequest'];

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
const INPUT_KEYS: ReadonlySet<string> = new Set(['repository', 'token', 'label', 'originalPullNumber', 'dryRun']);

/** The input, validated and captured before the first await. */
interface ICaptured {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly label: string;
  readonly originalPullNumber: number | undefined;
  readonly dryRun: boolean;
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
  if (originalPullNumber !== undefined && !(typeof originalPullNumber === 'number' && Number.isSafeInteger(originalPullNumber) && originalPullNumber >= 1)) {
    throw invalid('originalPullNumber must be a positive integer');
  }
  const dryRun = dataField(input, 'dryRun', 'dryRun');
  if (dryRun !== undefined && typeof dryRun !== 'boolean') throw invalid('dryRun must be a boolean');
  return { owner, repo, token, label: label ?? DEFAULT_SUGGESTION_LABEL, originalPullNumber, dryRun: dryRun ?? false };
}

// ---------------------------------------------------------------------------
// Cleanup

/** A pull request discovery found, before classification. */
interface ICandidate {
  readonly number: number;
  readonly url: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly state: 'open' | 'closed' | 'merged';
}

/** A reported pull request, with the stage a failure happened at (which only changes its wording). */
interface IChecked extends ICheckedSuggestionPullRequest {
  readonly failedWhile?: 'reading' | 'closing';
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

  constructor(
    private readonly captured: ICaptured,
    private readonly client: CleanupClient,
  ) {}

  async run(): Promise<ICloseSuggestionPullRequestsOutcome> {
    const eligible = await this.discoverAndVerify();
    for (const { candidate, original } of eligible) {
      if (this.captured.dryRun) this.report(candidate, original, 'would-close');
      else await this.close(candidate, original);
    }
    return this.outcome();
  }

  /** Steps 1-3: every read, and nothing else. */
  private async discoverAndVerify(): Promise<IEligible[]> {
    const { originalPullNumber } = this.captured;
    let candidates: ICandidate[];
    if (originalPullNumber === undefined) {
      candidates = await this.labeledCandidates();
    } else {
      const original = await this.resolveOriginal(originalPullNumber);
      if (original.state === 'unverified') return [];
      candidates = await this.referencingCandidates(originalPullNumber);
    }

    // Row 1-4 of contract §2.6: the marker, its repository and (targeted) its original.
    const marked: { readonly candidate: ICandidate; readonly marker: ISuggestionMarkerFields; readonly line: string }[] = [];
    for (const candidate of candidates) {
      const reading = findSuggestionMarker(candidate.body);
      const labeled = this.hasLabel(candidate.labels);
      if (reading.kind === 'none') {
        // Targeted discovery also finds ordinary references: neither marker nor label.
        if (originalPullNumber === undefined || labeled) this.report(candidate, null, 'not-ours', 'it has the label but no suggestion marker');
      } else if (reading.kind === 'several') {
        this.report(candidate, null, 'not-ours', 'its body has more than one suggestion marker');
      } else if (reading.kind === 'malformed') {
        this.report(candidate, null, 'not-ours', 'its suggestion marker is not in the canonical form');
      } else if (!this.isThisRepository(`${reading.fields.owner}/${reading.fields.repo}`)) {
        this.report(candidate, null, 'not-ours', `its marker names another repository (${reading.fields.owner}/${reading.fields.repo})`);
      } else if (originalPullNumber !== undefined && reading.fields.pullNumber !== originalPullNumber) {
        this.report(candidate, reading.fields.pullNumber, 'not-ours', `its marker names #${String(reading.fields.pullNumber)}, not #${String(originalPullNumber)}`);
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
      if (others.length > 0) {
        const list = others.map((n) => `#${String(n)}`).join(', ');
        const who = others.length === 1 ? `another open pull request (${list}) carries a marker` : `other open pull requests (${list}) carry markers`;
        this.report(candidate, original, 'not-ours', `${who} for the same suggestion`);
      } else if (candidate.state !== 'open') {
        this.report(candidate, original, 'already-closed');
      } else if (!this.hasLabel(candidate.labels)) {
        this.report(candidate, original, 'unlabeled');
      } else {
        const resolved = await this.resolveOriginal(original);
        if (resolved.state === 'open') this.report(candidate, original, 'left-open');
        else if (resolved.state === 'unverified') this.report(candidate, original, 'unverified', resolved.reason);
        else if (await this.verify(candidate, marker, line)) eligible.push({ candidate, original });
      }
    }
    return eligible;
  }

  /** Every open pull request with the label, each once. */
  private async labeledCandidates(): Promise<ICandidate[]> {
    const { owner, repo, label } = this.captured;
    const listed = await this.client.listOpenLabeledPullRequests({ owner, repo, label });
    return unique(listed.map((pr) => ({ number: pr.number, url: pr.htmlUrl, body: pr.body, labels: pr.labels, state: 'open' as const })));
  }

  /** Every pull request of this repository that references the original, each once. */
  private async referencingCandidates(pullNumber: number): Promise<ICandidate[]> {
    const { owner, repo } = this.captured;
    const listed = await this.client.listCrossReferencingPullRequests({ owner, repo, pullNumber });
    return unique(
      listed
        .filter((pr) => this.isThisRepository(pr.repository))
        .map((pr) => ({ number: pr.number, url: pr.htmlUrl, body: pr.body, labels: pr.labels, state: pr.state })),
    );
  }

  /** An original's state, read once however many suggestions name it (contract §2.7). */
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
      resolved = { number: pullNumber, state: 'unverified', reason: this.safe(err.message) };
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
    const branch = `sarif-to-comment/suggestions/${String(original)}/${marker.id}`;
    if (fresh.state !== 'open') {
      this.report(candidate, original, 'already-closed');
    } else if (reading.kind !== 'marker' || reading.line !== line) {
      this.report(candidate, original, 'not-ours', 'its suggestion marker changed while it was being checked');
    } else if (fresh.headRepository === null || !this.isThisRepository(fresh.headRepository)) {
      this.report(candidate, original, 'not-ours', `its head branch is in another repository (${fresh.headRepository ?? 'a deleted repository'})`);
    } else if (!this.isThisRepository(fresh.baseRepository)) {
      this.report(candidate, original, 'not-ours', `it belongs to another repository (${fresh.baseRepository})`);
    } else if (fresh.headRef !== branch) {
      this.report(candidate, original, 'not-ours', `its head branch is \`${fresh.headRef}\`, not \`${branch}\``);
    } else if (!this.hasLabel(fresh.labels)) {
      this.report(candidate, original, 'unlabeled');
    } else {
      return true;
    }
    return false;
  }

  /** Step 4: one close; its answer decides the result (contract §2.9). */
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
      url: candidate.url,
      original,
      result,
      ...(reason === undefined ? {} : { reason }),
      ...(failedWhile === undefined ? {} : { failedWhile }),
    });
  }

  private hasLabel(labels: readonly string[]): boolean {
    const wanted = this.captured.label.toLowerCase();
    return labels.some((label) => label.toLowerCase() === wanted);
  }

  /** Whether `owner/repo` names this repository (GitHub names are case-insensitive). */
  private isThisRepository(fullName: string): boolean {
    return fullName.toLowerCase() === `${this.captured.owner}/${this.captured.repo}`.toLowerCase();
  }

  private safe(text: string): string {
    return redact(text, this.captured.token);
  }

  private outcome(): ICloseSuggestionPullRequestsOutcome {
    const originals = [...this.originals.values()].sort((a, b) => a.number - b.number);
    const checked = [...this.checked].sort((a, b) => a.number - b.number);
    const incomplete = originals.some((o) => o.state === 'unverified') || checked.some((s) => s.result === 'failed' || s.result === 'unverified');
    const status: CloseSuggestionPullRequestsStatus = incomplete
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
    return {
      status,
      dryRun: this.captured.dryRun,
      originals,
      suggestions,
      markdown: this.safe(renderMarkdown(this.captured, status, originals, checked)),
    };
  }
}

/** Candidates in ascending number order, each pull request once (a listing can repeat one). */
function unique(candidates: readonly ICandidate[]): ICandidate[] {
  const byNumber = new Map<number, ICandidate>();
  for (const candidate of candidates) if (!byNumber.has(candidate.number)) byNumber.set(candidate.number, candidate);
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

// ---------------------------------------------------------------------------
// Presentation

const ORIGINAL_TEXT: Readonly<Record<Exclude<OriginalPullRequestState, 'unverified'>, string>> = {
  open: 'open',
  merged: 'merged',
  closed: 'closed without merging',
};

function originalLine(original: IOriginalPullRequest): string {
  const state = original.state === 'unverified' ? `could not be verified (${original.reason ?? 'no reason given'})` : ORIGINAL_TEXT[original.state];
  return `- #${String(original.number)}: ${state}`;
}

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
    case 'not-ours':
      return `skipped, not one of this tool's suggestion pull requests: ${reason}`;
    case 'unlabeled':
      return `skipped, it does not carry the label \`${label}\``;
  }
}

const TITLES: Readonly<Record<CloseSuggestionPullRequestsStatus, string>> = {
  complete: '## Suggestion pull request cleanup complete',
  'permission-limited': '## Suggestion pull request cleanup limited by permissions',
  incomplete: '## Suggestion pull request cleanup incomplete',
};

function renderMarkdown(
  captured: ICaptured,
  status: CloseSuggestionPullRequestsStatus,
  originals: readonly IOriginalPullRequest[],
  checked: readonly IChecked[],
): string {
  const where = `${captured.owner}/${captured.repo}`;
  const scope = captured.originalPullNumber === undefined
    ? `Checked the open pull requests labeled \`${captured.label}\` in ${where}.`
    : `Checked the pull requests that reference #${String(captured.originalPullNumber)} in ${where}.`;
  const lines = [status === 'complete' && captured.dryRun ? '## Suggestion pull request cleanup: dry run' : TITLES[status], '', scope, ''];
  if (originals.length > 0) lines.push('Original pull requests:', '', ...originals.map(originalLine), '');
  if (checked.length === 0) {
    lines.push('No suggestion pull requests were found.', '');
  } else {
    lines.push('Suggestion pull requests:', '');
    for (const entry of checked) {
      const forOriginal = entry.original === null ? '' : ` (for #${String(entry.original)})`;
      lines.push(`- #${String(entry.number)}${forOriginal}: ${resultText(entry, captured.label)}`);
    }
    lines.push('');
  }
  if (captured.dryRun) lines.push('This was a dry run: nothing was closed.', '');
  if (status === 'incomplete') {
    lines.push('Some results could not be established. Running the cleanup again is safe: it closes only suggestion pull requests that are still open and eligible.', '');
  }
  if (checked.some((entry) => entry.result === 'permission-limited')) {
    lines.push('Someone allowed to close the pull requests left open can finish, for example by running this cleanup with their own token.', '');
  }
  lines.push('Closing never deletes a branch: each proposal branch is left in place.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point

/**
 * Closes this tool's open companion suggestion pull requests whose original
 * pull request has merged or closed, in one repository.
 *
 * @remarks
 * Suggestion pull requests are recognized by the structured marker the
 * publisher writes into their description, never by their title. By default
 * every open pull request carrying the suggestion label is checked; with
 * `originalPullNumber`, only the pull requests referencing that original.
 * A suggestion is closed only after its original has been read and found
 * merged or closed, and after the suggestion itself has been read again and
 * verified: an original that cannot be read is `unverified`, never treated as
 * ended. Everything is read before anything is closed.
 *
 * Closing is the only change made. Branches are never deleted, and nothing
 * is edited, labeled, commented on or reopened; the original is never
 * touched. Running cleanup again is safe: suggestions already closed are not
 * listed again (or are reported `already-closed`).
 *
 * @param input - The repository, credential and optional label, original and
 * dry-run setting.
 * @returns What was checked and done. `status` is `complete`,
 * `permission-limited` (some eligible suggestions could not be closed with
 * this account) or `incomplete` (an original could not be verified or an
 * action failed).
 * @throws `TypeError` for invalid input, before any request. An `Error` when
 * discovery fails (GitHub, network, authentication), before anything was
 * closed. Neither a result nor a rejection contains the token.
 *
 * @example
 * ```ts
 * import { closeSuggestionPullRequests } from 'sarif-to-comment';
 *
 * const cleanup = await closeSuggestionPullRequests({
 *   repository: { owner: 'acme', repo: 'widgets' },
 *   token: process.env.GH_TOKEN!,
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
