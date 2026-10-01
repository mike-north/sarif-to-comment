/**
 * The companion-index component (private internal module; D56, D60;
 * docs/companion-suggestion-pr-contract.md §2.13.3).
 *
 * The review body's list of the companion suggestion pull requests that
 * belong to this particular review: every one the publication creates and
 * every existing one the caller selected. It is how a review explicitly
 * identifies its proposals, so an upstream reviewer or agent can find them
 * from the review without inferring membership from labels, branches or
 * creation times. It presents the list; it never decides which pull requests
 * belong in it, or in which order (preparation and publication do).
 *
 * Each entry's link is an identity link, built from the pull request's
 * number by the shared builder (src/github-urls.cts). A title is shown as
 * literal text, so no title can re-point, hide or swallow a link. The
 * component is not customizable: the numbers of the pull requests a
 * publication creates exist only after every presentation callback has run.
 *
 * Rendering:
 *
 *   index  = "**Companion pull requests of this review:**\n\n" entry { "\n" entry }
 *   entry  = "- [#" N "](" URL "): " title " — " origin
 *   origin = "created with this review"
 *          | "reused; it was " state " when this review was prepared"
 *   state  = "open" | "a draft" | "closed" | "merged"
 *   title  = the title as literal text: Markdown characters (and `$`, which
 *            GitHub reads as math) backslash-escaped, an @mention as a code
 *            span, line breaks as spaces
 */

import { escapePlainInline } from './markdown.cjs';

/**
 * What an existing suggestion pull request was when the review was prepared:
 * open, open as a draft, closed without merging, or merged. Reported, never
 * enforced (D56: the caller decides whether a proposal still matters).
 */
export type ExistingCompanionState = 'open' | 'draft' | 'closed' | 'merged';

/** One companion pull request the index lists: created by this publication, or an existing one the caller selected. */
export type ICompanionIndexEntry = {
  /** The pull request's number. */
  readonly number: number;
  /** Its web URL, from the shared link builder. */
  readonly url: string;
  /** Its title: as planned for a created one, as GitHub reported it for an existing one. */
  readonly title: string;
} & ({ readonly origin: 'created' } | { readonly origin: 'existing'; readonly state: ExistingCompanionState });

/** How each state reads after "it was". */
const STATE_WORDS: Readonly<Record<ExistingCompanionState, string>> = {
  open: 'open',
  draft: 'a draft',
  closed: 'closed',
  merged: 'merged',
};

/** The wording of an existing companion's state, as the index and the `companion-reused` note state it. */
export function existingStateWords(state: ExistingCompanionState): string {
  return STATE_WORDS[state];
}

/** A title as literal inline text; `$` is escaped too, so a title never becomes GitHub math. */
function literalTitle(title: string): string {
  return escapePlainInline(title).replace(/\$/g, '\\$');
}

/** The review body's companion index, listing `entries` in the order given (at least one). */
export function renderCompanionIndex(entries: readonly ICompanionIndexEntry[]): string {
  if (entries.length === 0) throw new Error('Internal error: a companion index lists at least one pull request.');
  const lines = entries.map((entry) => {
    const origin = entry.origin === 'created'
      ? 'created with this review'
      : `reused; it was ${existingStateWords(entry.state)} when this review was prepared`;
    return `- [#${String(entry.number)}](${entry.url}): ${literalTitle(entry.title)} — ${origin}`;
  });
  return `**Companion pull requests of this review:**\n\n${lines.join('\n')}`;
}
