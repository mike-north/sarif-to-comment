/**
 * The structured marker that relates a companion suggestion pull request to
 * its original pull request (private internal module;
 * docs/companion-suggestion-pr-contract.md §2.7).
 *
 * A suggestion pull request's body ends with exactly one hidden line:
 *
 *   <!-- sarif-to-comment:suggestion {"id":…,"original":{"owner":…,"pullNumber":…,"repo":…},"publication":…,"reviewedCommit":…,"version":1} -->
 *
 * The JSON is canonical (keys sorted at every level, no whitespace), so the
 * line is a pure function of its fields and recovery can match it exactly.
 * `id` identifies the suggestion, `publication` the logical publication (one
 * per state path), `original` the original pull request in the same
 * repository, and `reviewedCommit` the proposal commit's parent. No value can
 * contain `>`, so the line can never close early: ids are UUIDs, the commit
 * is hex, the pull number an integer, and GitHub owner and repository names
 * are letters, digits, `.`, `_` and `-`. It is metadata, not a secret.
 */

/** The fields one suggestion's marker records. */
export interface ISuggestionMarkerFields {
  readonly id: string;
  readonly publication: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly reviewedCommit: string;
}

/** The marker format version. */
const MARKER_VERSION = 1;

/** The marker line for one suggestion (canonical JSON; see the module documentation). */
export function formatSuggestionMarker(fields: ISuggestionMarkerFields): string {
  const json = JSON.stringify({
    id: fields.id,
    original: { owner: fields.owner, pullNumber: fields.pullNumber, repo: fields.repo },
    publication: fields.publication,
    reviewedCommit: fields.reviewedCommit,
    version: MARKER_VERSION,
  });
  return `<!-- sarif-to-comment:suggestion ${json} -->`;
}
