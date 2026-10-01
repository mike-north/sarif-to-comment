/**
 * The lifecycle-note component (private internal module; D60;
 * docs/companion-suggestion-pr-contract.md §2.11; docs/suggestion-pr-convention.md §8).
 *
 * The brief note every companion suggestion pull request's description
 * carries so a reader knows how the proposal is accepted: how a draft becomes
 * mergeable, that the original pull request's author decides whether to merge
 * it, that the original carries the change to its base, and when the
 * proposal can be closed. It describes the lifecycle; it does not manage it.
 *
 * Rendering (draft, then ready for review):
 *
 *   "**How this suggestion is accepted:** it is a draft pull request into `HEAD`, the branch of #PULL.
 *    A draft cannot be merged: someone with write access first marks it ready for review. The author of
 *    #PULL then decides whether to merge it, and #PULL carries the change to its base. Once #PULL is
 *    merged or closed, this pull request can be closed."
 *   "**How this suggestion is accepted:** it is a pull request into `HEAD`, the branch of #PULL. The author
 *    of #PULL decides whether to merge it, and #PULL carries the change to its base. Once #PULL is merged
 *    or closed, this pull request can be closed."
 */

import type { ICompanionTarget } from './companion-changes.cjs';
import { codeSpan } from './markdown.cjs';

/** The lifecycle note of a companion into `target`'s head branch, worded for a draft or a ready pull request. */
export function renderLifecycleNote(target: Pick<ICompanionTarget, 'pullNumber' | 'headRef' | 'ready'>): string {
  const pull = `#${String(target.pullNumber)}`;
  const branch = codeSpan(target.headRef);
  const accepted = target.ready
    ? `it is a pull request into ${branch}, the branch of ${pull}. The author of ${pull} decides whether to merge it`
    : `it is a draft pull request into ${branch}, the branch of ${pull}. A draft cannot be merged: someone with write access first marks it ready for review. The author of ${pull} then decides whether to merge it`;
  return `**How this suggestion is accepted:** ${accepted}, and ${pull} carries the change to its base. Once ${pull} is merged or closed, this pull request can be closed.`;
}
