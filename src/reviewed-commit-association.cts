/**
 * Whether a reviewed commit belongs to its pull request (private internal
 * module; docs/specification.md R17, D58).
 *
 * GitHub accepts a review at any commit of the repository, including one of
 * an unrelated branch (GH-16), so this module is the tool's own check that a
 * review is about the pull request it is published on. A reviewed commit R is
 * associated when it equals, or is an ancestor of, the pull request's current
 * head, or the head a force-push replaced (the `beforeCommit` of a
 * `HeadRefForcePushedEvent`). Reachability from the base branch alone never
 * associates it.
 *
 * The answer is one of:
 *   associated      R is the head, within it, or within a replaced head;
 *   not-associated  every replaced head was seen and compared, and none (nor
 *                   the head) contains R;
 *   unknown         nothing associated R, but the lookup could not see or
 *                   compare every replaced head (a null beforeCommit, an
 *                   incompletely listed timeline, an earlier head GitHub
 *                   cannot compare, or more earlier heads than the
 *                   comparison bound). A limited lookup's miss is not proof
 *                   of absence.
 * Any other failed read is operational and rejects.
 *
 * Requests, in order, stopping once R is associated: none when R is the
 * head; GET compare/{R}...{head}; every page of the force-push events; then
 * GET compare/{R}...{X} for each distinct earlier head X, newest first, at
 * most MAX_EARLIER_HEAD_COMPARISONS of them.
 *
 * It decides membership only. Turning the answer into a block or a note is
 * the preflight's (src/review-preflight.cts), through the diagnostics below.
 */

import type { CommitComparison, IHeadRefForcePushes, IPullRequestDestination } from './github.cjs';
import { createDiagnostic } from './diagnostics.cjs';
import type { IDiagnostic } from './diagnostics.cjs';

/** What the check needs from a GitHub client (src/github.cts has both). */
export interface IAssociationClient {
  readonly compareCommits?:
    | ((request: { readonly owner: string; readonly repo: string; readonly base: string; readonly head: string }) => Promise<CommitComparison>)
    | undefined;
  readonly listHeadRefForcePushes?: ((request: IPullRequestDestination) => Promise<IHeadRefForcePushes>) | undefined;
}

/** The pull request, its current head and the reviewed commit whose membership is asked. */
export interface IAssociationRequest {
  readonly destination: IPullRequestDestination;
  readonly reviewedCommit: string;
  readonly head: string;
}

/** Why the lookup could not decide, in the order they are reported. */
export type AssociationUnknownReason =
  | 'before-commit-missing'
  | 'events-incomplete'
  | 'earlier-head-unreadable'
  | 'comparison-limit';

/** How the reviewed commit belongs to the pull request. */
export type AssociationRoute = 'head' | 'ancestor-of-head' | 'replaced-head' | 'ancestor-of-replaced-head';

/** The answer of {@link associateReviewedCommit}. */
export type ReviewedCommitAssociation =
  | { readonly kind: 'associated'; readonly via: AssociationRoute }
  | { readonly kind: 'not-associated' }
  | { readonly kind: 'unknown'; readonly reasons: readonly AssociationUnknownReason[] };

/**
 * The most earlier heads compared with the reviewed commit. Most reviews are
 * of a head itself, which needs no comparison; past this bound the answer is
 * unknown rather than a long run of requests.
 */
export const MAX_EARLIER_HEAD_COMPARISONS = 10;

/** The order unknown reasons are reported in. */
const REASON_ORDER: readonly AssociationUnknownReason[] = ['before-commit-missing', 'events-incomplete', 'earlier-head-unreadable', 'comparison-limit'];

/** How each unknown reason reads in the note's message. */
const REASON_TEXT: Readonly<Record<AssociationUnknownReason, string>> = {
  'before-commit-missing': 'a force-push event names no earlier head',
  'events-incomplete': "the pull request's force-push events could not all be listed",
  'earlier-head-unreadable': 'GitHub could not compare it with an earlier head',
  'comparison-limit': `more than ${String(MAX_EARLIER_HEAD_COMPARISONS)} earlier heads would need comparing`,
};

/** Whether a comparison shows `ancestor` within `descendant` (the base of `compare/{ancestor}...{descendant}`). */
function contains(comparison: CommitComparison): boolean {
  return comparison === 'ahead' || comparison === 'identical';
}

/**
 * Whether a failed comparison is GitHub answering that it cannot compare the
 * two commits (HTTP 404), which leaves membership unknown, rather than an
 * operational failure. Read structurally, so any client's error with the
 * adapter's code and status counts.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error) || !('status' in error)) return false;
  return error.code === 'http-status' && error.status === 404;
}

/**
 * Establishes whether the reviewed commit belongs to the pull request (see the
 * module documentation). Rejects for an operational failure, and when the
 * client lacks a read the answer needs.
 */
export async function associateReviewedCommit(request: IAssociationRequest, client: IAssociationClient): Promise<ReviewedCommitAssociation> {
  const { destination, reviewedCommit, head } = request;
  if (reviewedCommit === head) return { kind: 'associated', via: 'head' };
  const { compareCommits, listHeadRefForcePushes } = client;
  if (compareCommits === undefined || listHeadRefForcePushes === undefined) {
    throw new Error('This GitHub client cannot check that the reviewed commit belongs to the pull request.');
  }
  const { owner, repo } = destination;
  if (contains(await compareCommits({ owner, repo, base: reviewedCommit, head }))) return { kind: 'associated', via: 'ancestor-of-head' };

  const pushes = await listHeadRefForcePushes(destination);
  const reasons = new Set<AssociationUnknownReason>();
  if (!pushes.complete) reasons.add('events-incomplete');
  if (pushes.beforeCommits.includes(null)) reasons.add('before-commit-missing');
  const earlier: string[] = [];
  for (const before of [...pushes.beforeCommits].reverse()) {
    if (before === null || earlier.includes(before)) continue;
    if (before === reviewedCommit) return { kind: 'associated', via: 'replaced-head' };
    earlier.push(before);
  }
  for (const [index, before] of earlier.entries()) {
    if (index >= MAX_EARLIER_HEAD_COMPARISONS) {
      reasons.add('comparison-limit');
      break;
    }
    try {
      if (contains(await compareCommits({ owner, repo, base: reviewedCommit, head: before }))) {
        return { kind: 'associated', via: 'ancestor-of-replaced-head' };
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
      reasons.add('earlier-head-unreadable');
    }
  }
  if (reasons.size === 0) return { kind: 'not-associated' };
  return { kind: 'unknown', reasons: REASON_ORDER.filter((reason) => reasons.has(reason)) };
}

/** `owner/repo#number`, the subject of both diagnostics. */
function pullRequestLabel({ owner, repo, pullNumber }: IPullRequestDestination): string {
  return `${owner}/${repo}#${String(pullNumber)}`;
}

/**
 * The diagnostic an association answer carries: the blocking
 * `reviewed-commit-not-in-pull-request` error, the
 * `reviewed-commit-association-unknown` note, or none when associated.
 */
export function associationDiagnostic(association: ReviewedCommitAssociation, request: IAssociationRequest): IDiagnostic | undefined {
  const { destination, reviewedCommit, head } = request;
  const label = pullRequestLabel(destination);
  switch (association.kind) {
    case 'associated':
      return undefined;
    case 'not-associated':
      return createDiagnostic('reviewed-commit-not-in-pull-request',
        `Commit ${reviewedCommit} is not part of ${label}: it is not the pull request's head ${head} or an ancestor of it, `
        + "and no force-push of the pull request's branch replaced a head that contains it. "
        + 'GitHub would accept a review at that commit, so nothing was prepared or written.',
        { subject: label });
    case 'unknown':
      return createDiagnostic('reviewed-commit-association-unknown',
        `Whether commit ${reviewedCommit} belongs to ${label} is not known: it is not the pull request's head ${head} or an ancestor of it, `
        + `and ${association.reasons.map((reason) => REASON_TEXT[reason]).join('; ')}. `
        + 'A lookup that cannot see every replaced head does not show that the commit is outside the pull request, so the review is prepared at that commit.',
        { subject: label });
  }
}
