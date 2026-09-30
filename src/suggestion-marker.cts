/**
 * The structured marker that relates a suggestion pull request to its
 * original pull request (private internal module;
 * docs/suggestion-pr-convention.md §7).
 *
 * A suggestion pull request's body ends with exactly one hidden line:
 *
 *   <!-- suggestion-pr {"version":1,"original":{"owner":…,"repo":…,"pullNumber":…},"reviewedCommit":…,"id":…,"batch":…} -->
 *
 * The JSON is canonical: exactly these members, in exactly this order, with
 * no whitespace, so the line is a pure function of its fields and recovery
 * can match it exactly. `id` identifies the suggestion (its branch carries
 * it), `batch` groups the suggestions of one review (this tool uses its
 * publication id, one per state path), `original` names the original pull
 * request in the same repository, and `reviewedCommit` the proposal commit's
 * parent. No value can contain `>`, `"` or `\`, so the line can never close
 * early and JSON writes it without escapes: the commit is hex, the pull
 * number an integer, GitHub owner and repository names are letters, digits,
 * `.`, `_` and `-`, and `id` and `batch` are letters, digits, `-` and `_`. It
 * is metadata, not a secret.
 *
 * findSuggestionMarker reads it back for cleanup
 * (docs/suggestion-cleanup-contract.md §2.5), whichever tool wrote it.
 * Recognition is strict: exactly one line of the body may begin with the
 * marker prefix, and that line must be the canonical line of well-formed
 * fields, byte for byte (the round trip through formatSuggestionMarker is
 * the check). A person may edit the rest of the body, add text after the
 * marker, or let GitHub store it with CRLF line endings (one trailing
 * carriage return per line is ignored); a changed, duplicated or quoted
 * marker is never guessed at.
 */

/** The fields one suggestion's marker records. */
export interface ISuggestionMarkerFields {
  readonly id: string;
  readonly batch: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly reviewedCommit: string;
}

/**
 * What a body's marker lines establish: none, one canonical marker, or a
 * refusal to recognize any (`several` lines carry the prefix, or the only
 * one is not canonical).
 */
export type SuggestionMarkerReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'several' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'marker'; readonly line: string; readonly fields: ISuggestionMarkerFields };

/** The convention version this module writes and recognizes. */
const MARKER_VERSION = 1;

/** The start of every marker line. */
const MARKER_PREFIX = '<!-- suggestion-pr ';

/** The canonical line's frame around its JSON. */
const MARKER_LINE = /^<!-- suggestion-pr (\{[^\n]*\}) -->$/;

/** A suggestion id or batch: 1-64 letters, digits, `-` and `_`, beginning and ending with a letter or digit. */
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;

/** A full lowercase commit id. */
const COMMIT = /^[0-9a-f]{40}$/;

/** GitHub owner and repository names (never `.` or `..`). */
const NAME = /^[A-Za-z0-9_.-]+$/;

/** Whether `value` is a suggestion id or batch under the convention. */
export function isSuggestionIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

/** The marker line for one suggestion (canonical JSON; see the module documentation). */
export function formatSuggestionMarker(fields: ISuggestionMarkerFields): string {
  const json = JSON.stringify({
    version: MARKER_VERSION,
    original: { owner: fields.owner, repo: fields.repo, pullNumber: fields.pullNumber },
    reviewedCommit: fields.reviewedCommit,
    id: fields.id,
    batch: fields.batch,
  });
  return `${MARKER_PREFIX}${json} -->`;
}

/** Whether a value is a JSON object (not null, not an array). */
function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && NAME.test(value) && value !== '.' && value !== '..';
}

/** The fields of one canonical marker line, or null when the line is anything else. */
function parseMarkerLine(line: string): ISuggestionMarkerFields | null {
  const framed = MARKER_LINE.exec(line);
  if (!framed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(framed[1] ?? '');
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const { id, original, batch, reviewedCommit } = parsed;
  if (!isObject(original)) return null;
  const { owner, repo, pullNumber } = original;
  if (
    !isSuggestionIdentifier(id) ||
    !isSuggestionIdentifier(batch) ||
    typeof reviewedCommit !== 'string' || !COMMIT.test(reviewedCommit) ||
    !isName(owner) || !isName(repo) ||
    typeof pullNumber !== 'number' || !Number.isSafeInteger(pullNumber) || pullNumber < 1
  ) {
    return null;
  }
  const fields: ISuggestionMarkerFields = { id, batch, owner, repo, pullNumber, reviewedCommit };
  // Canonical form only: extra or reordered members, whitespace, another
  // version or escaped characters all make the line differ from its
  // formatted form.
  return formatSuggestionMarker(fields) === line ? fields : null;
}

/**
 * The suggestion marker a pull request body carries (see the module
 * documentation). A null body (GitHub's answer for an empty one) has none.
 */
export function findSuggestionMarker(body: string | null): SuggestionMarkerReading {
  if (body === null) return { kind: 'none' };
  const lines = body.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const candidates = lines.filter((line) => line.startsWith(MARKER_PREFIX));
  const [line] = candidates;
  if (line === undefined) return { kind: 'none' };
  if (candidates.length > 1) return { kind: 'several' };
  const fields = parseMarkerLine(line);
  return fields === null ? { kind: 'malformed' } : { kind: 'marker', line, fields };
}
