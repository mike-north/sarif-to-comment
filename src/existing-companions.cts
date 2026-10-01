/**
 * Existing companions: the suggestion pull requests a caller selects for a
 * review's companion index (private internal module; D56;
 * docs/companion-suggestion-pr-contract.md §2.13.2).
 *
 * D56 lets a later, independent review list continuing proposals that an
 * earlier review created, so an upstream agent can carry them forward. Only
 * the caller selects them; this module never discovers, infers or carries
 * forward a proposal. It answers one question for each pull request the
 * caller names: can the review list it as one of its companions? That is so
 * exactly when it is a suggestion pull request of the reviewed pull request
 * under the tool-neutral convention (docs/suggestion-pr-convention.md §5,
 * §7, §9), whoever created it and whatever its state.
 *
 * Boundaries:
 *   - It only reads: one `GET pulls/{n}` per named pull request, in the
 *     order given, during the shared review preflight, before anything is
 *     written. Publication and readiness assessment run it alike.
 *   - A pull request that cannot be listed is a `companion-not-reusable`
 *     error naming it and the first failing condition; a 404 is GitHub's
 *     definitive answer that the repository has no such pull request. Any
 *     other failed read is operational and propagates.
 *   - A listed pull request's state (open, a draft, closed, merged) is
 *     recorded as read and reported in a `companion-reused` note; it is
 *     never enforced (D56, D59). What it records is all a publication ever
 *     knows of it: a retry never reads it again (§2.13.4).
 *   - The convention's last conformance condition (no other open pull
 *     request claims the same suggestion id) is not checked: it lets a
 *     consumer that discovers suggestions tell them apart, and the caller
 *     names this one by its number.
 */

import { createDiagnostic } from './diagnostics.cjs';
import type { IDiagnostic } from './diagnostics.cjs';
import { GitHubError } from './github.cjs';
import type { IPullRequestDestination, IPullRequestSnapshot } from './github.cjs';
import { existingStateWords } from './presentation/companion-index.cjs';
import type { ExistingCompanionState } from './presentation/companion-index.cjs';
import { codeSpan } from './presentation/markdown.cjs';
import { findSuggestionMarker } from './suggestion-marker.cjs';
import { suggestionPrBranch } from './suggestion-pr-convention.cjs';

/**
 * An existing suggestion pull request the review lists, as it was read when
 * the review was prepared: what the index shows of it, and all a
 * publication records about it.
 */
export interface IExistingCompanion {
  readonly number: number;
  readonly title: string;
  readonly state: ExistingCompanionState;
}

/** What reading the caller's selection established: the pull requests listed, the ones refused, and a note per listed one. */
export interface IExistingCompanionsReading {
  /** The pull requests the index lists, in the order given. */
  readonly listed: readonly IExistingCompanion[];
  /** One `companion-not-reusable` error per pull request that cannot be listed, in the order given. */
  readonly problems: readonly IDiagnostic[];
  /** One `companion-reused` note per listed pull request, in the order given. */
  readonly notes: readonly IDiagnostic[];
}

/** The read this module makes: one pull request of the reviewed repository. */
export type ReadPullRequest = (request: IPullRequestDestination) => Promise<IPullRequestSnapshot>;

/** GitHub repository names compare case-insensitively. */
function sameRepository(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A pull request's state as the index records it. */
function stateOf(pull: IPullRequestSnapshot): ExistingCompanionState {
  if (pull.merged) return 'merged';
  if (pull.state === 'closed') return 'closed';
  return pull.draft ? 'draft' : 'open';
}

/**
 * Why `pull` cannot be listed as an existing companion of `destination`'s
 * pull request (contract §2.13.2, conditions 1-5 after the read itself), or
 * null when it can.
 */
function unusableBecause(pull: IPullRequestSnapshot, destination: IPullRequestDestination): string | null {
  const repository = `${destination.owner}/${destination.repo}`;
  if (!sameRepository(pull.baseRepository, repository)) return `it is not a pull request in ${repository}`;
  if (pull.headRepository === null) return 'its head repository was deleted';
  if (!sameRepository(pull.headRepository, repository)) return `its head branch ${codeSpan(pull.headRef)} is in another repository (${pull.headRepository})`;
  const reading = findSuggestionMarker(pull.body);
  switch (reading.kind) {
    case 'none': return 'it has no suggestion marker';
    case 'several': return 'its body has more than one suggestion marker';
    case 'malformed': return 'its suggestion marker is not in the canonical form';
    case 'marker': break;
  }
  const { fields } = reading;
  const named = `${fields.owner}/${fields.repo}`;
  if (!sameRepository(named, repository)) return `its suggestion marker names another repository (${named})`;
  if (fields.pullNumber !== destination.pullNumber) {
    return `its suggestion marker names #${String(fields.pullNumber)}, not #${String(destination.pullNumber)}`;
  }
  const branch = suggestionPrBranch(fields.pullNumber, fields.id);
  if (pull.headRef !== branch) return `its head branch ${codeSpan(pull.headRef)} is not the suggestion branch ${codeSpan(branch)} its marker names`;
  return null;
}

/**
 * Reads each pull request the caller named, in order, and says which the
 * review can list (see the module documentation). Rejects with the read's
 * own error for any failure but a 404.
 */
export async function readExistingCompanions(
  numbers: readonly number[],
  destination: IPullRequestDestination,
  read: ReadPullRequest,
): Promise<IExistingCompanionsReading> {
  const { owner, repo, pullNumber } = destination;
  const listed: IExistingCompanion[] = [];
  const problems: IDiagnostic[] = [];
  const notes: IDiagnostic[] = [];
  for (const number of numbers) {
    const subject = `${owner}/${repo}#${String(number)}`;
    const refuse = (reason: string): void => {
      problems.push(createDiagnostic('companion-not-reusable',
        `#${String(number)} cannot be listed as an existing companion of #${String(pullNumber)}: ${reason}.`, { subject }));
    };
    let pull: IPullRequestSnapshot;
    try {
      pull = await read({ owner, repo, pullNumber: number });
    } catch (err) {
      if (err instanceof GitHubError && err.code === 'http-status' && err.status === 404) {
        refuse(`it is not a pull request in ${owner}/${repo}`);
        continue;
      }
      throw err;
    }
    const because = unusableBecause(pull, destination);
    if (because !== null) {
      refuse(because);
      continue;
    }
    const state = stateOf(pull);
    listed.push({ number, title: pull.title, state });
    notes.push(createDiagnostic('companion-reused',
      `#${String(number)} is listed in the review's companion index as an existing companion; it was ${existingStateWords(state)} when the review was prepared.`,
      { subject }));
  }
  return { listed, problems, notes };
}
