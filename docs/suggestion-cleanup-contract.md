# Suggestion pull request cleanup: contract

Proposal awaiting owner acceptance · September 29, 2026. On-demand cleanup closes this tool's own open companion suggestion pull requests once their original pull request has merged or closed. It is implemented under the conservative options below and verified against live GitHub in the [live evidence](suggestion-cleanup-e2e-evidence.md). Every decision in [Decisions awaiting acceptance](#4-decisions-awaiting-acceptance) is provisional until the owner accepts or replaces it.

**Sources.** [Issue #6](https://github.com/mike-north/sarif-to-comment/issues/6); [specification](specification.md) R16 (cleanup paragraph), A31 and A36, with R14 and the deferred fork case (A34); [decisions](design-decisions.md) D21, D25, D27, D28 and D29; the [companion suggestion PR contract](companion-suggestion-pr-contract.md), especially §2.6–§2.7 and §5 (what cleanup can rely on); the [lifecycle experiment](companion-pr-lifecycle-experiment.md); [status](status.md).

## 1. What is fixed by the sources

- Cleanup is a separate, bounded, on-demand action on suggestion pull requests. It is not publication and not review maintenance (D27, D29).
- The broad sweep starts from open pull requests carrying the configured suggestion label, paginated, and resolves each one's original. Targeted discovery from one original through its backlinks remains supported (R16, D21, D27).
- The relationship is the structured marker, never the title. Returned pull requests are deduplicated (A31, D21; companion contract §5).
- A suggestion is closed only after the original has been **positively** resolved as merged or closed. A failed or unauthorized lookup is not a terminal state (R16, D27, A36).
- Cleanup uses the caller's actual permissions, checked on each pull request. Permission-limited leftovers are reported apart from failed actions, and one run never claims global completion (R16, D25, A34, A36).
- Repeated runs tolerate suggestions that are already closed (A36).
- Closing a pull request and deleting its branch are separate operations; cleanup never deletes a branch (R16, D27; companion contract §2.6).
- No relationship store, no continuously running process and no scan of the history of closed originals (R16, D27).
- Near-term support is the same repository only (D25).

## 2. Decisions (proposal)

### 2.1 Names

| Library | CLI |
| --- | --- |
| `closeSuggestionPullRequests(input)` | `sarif-to-comment close-suggestion-prs` |

The names use the vocabulary users already have: `suggestionPullRequests` / `--suggestion-prs` enable the pull requests, and the specification calls them "suggestion PRs". "Suggestions" alone would collide with native inline suggestions, which cleanup never touches. The verb says what the command does to GitHub (it closes pull requests), and it is not a mode of `publish`, because cleanup is not publication (D29).

### 2.2 Input

| Library (`input`) | CLI | Meaning |
| --- | --- | --- |
| `repository: { owner, repo }` | `--repo OWNER/REPO` | The repository whose suggestion pull requests are checked. Required. |
| `token` | `GH_TOKEN`, else `GITHUB_TOKEN` | A personal access token or user token, as for `publish`. Never shown. |
| `label?` | `--label NAME` | The suggestion label. Default `suggestion`. |
| `originalPullNumber?` | `--original N` | Targeted mode: only the pull requests referencing this original (§2.4). |
| `dryRun?` | `--dry-run` | Discover and verify everything, close nothing (§2.3). |
| | `--format human\|json` | As for every command. |

Unknown fields are refused. Invalid input is a `TypeError` (CLI: a usage error, exit 1) before any request.

**Labels.** The label follows `suggestionLabel`'s rules (1–50 characters, no control or invisible formatting characters, no surrounding whitespace) and, in addition, **must not contain a comma**. GitHub's label filter takes a comma-separated list, so a label with a comma cannot be selected on its own. Because a suggestion published under such a label could never be swept, `suggestionLabel` / `--suggestion-label` refuse commas too. This applies from the unreleased companion suggestion pull requests onward, so no published suggestion carries one.

### 2.3 Closing is the default; `--dry-run` writes nothing

The command's name is its intent, as with `publish` and `validate`: it closes eligible suggestion pull requests. `dryRun: true` (`--dry-run`) performs exactly the same discovery, resolution and verification reads and reports `would-close` where it would close; it sends no write of any kind. A dry run cannot predict permission: only an attempt establishes it (D25), so a dry run never reports `permission-limited`.

**All discovery and verification completes before any close.** Closing a pull request removes it from the `state=open` listing, which would shift later pages; reading everything first also means an operational failure during discovery leaves nothing half done.

### 2.4 Discovery

**Sweep (the default).** Every page of `GET /repos/{owner}/{repo}/issues?labels={label}&state=open`, following validated `Link: rel="next"` pagination (at most 100 pages of 100). Entries without a `pull_request` object are issues and are ignored. A pull request listed twice (pages can shift while being read) counts once. The issues listing is used because it filters by label on the host; the search API is not used (index lag, a 1,000-result cap and a separate rate limit).

**Targeted (`originalPullNumber`).** The original is resolved first (§2.7). If it cannot be verified, discovery stops there: nothing could be closed, and the outcome reports the original as `unverified`. Otherwise one paginated GraphQL traversal reads the original's `timelineItems(itemTypes: [CROSS_REFERENCED_EVENT])` and follows each event's `source` to a `PullRequest` (number, URL, repository, state, body and labels), as D21 describes. Sources in another repository and sources that are issues are ignored (D25). A source listed more than once counts once. A source's labels are read through the REST labels listing when it has more than 100. This is the backlink lookup of D21 and D28 with the client the tool already has; no local record of earlier publications is consulted.

Any failure to list (HTTP, network, malformed answer, pagination) is operational: the call rejects (CLI: exit 1) and nothing has been closed.

### 2.5 Marker recognition

The marker of companion contract §2.7 is the relationship. A body is read line by line, ignoring one trailing carriage return per line (GitHub may store edited bodies with CRLF):

- No line begins with `<!-- sarif-to-comment:suggestion ` → no marker.
- More than one such line (for example the marker quoted in feedback) → refused, never guessed at.
- Exactly one such line → it must be the **canonical** line of well-formed fields: `id` and `publication` lowercase v4 UUIDs, `reviewedCommit` a full lowercase commit, `original` exactly `{ owner, pullNumber, repo }` with GitHub names and a positive integer, `version` 1, and the whole line byte-identical to the line the publisher formats from those fields. Anything else (extra keys, whitespace, another version, a changed value in the wrong shape) is refused.

The marker may appear anywhere in the body: a person may edit the text around it (companion contract §2.10). Titles are never read.

### 2.6 Classification

Each candidate pull request gets exactly one `result`, decided in this order:

| # | Condition | `result` | Closed? |
| --- | --- | --- | --- |
| 1 | Targeted mode: no marker and no label | not reported: an ordinary reference | no |
| 2 | No marker but the label; several markers; a non-canonical marker | `not-ours` | no |
| 3 | The marker names another repository (compared case-insensitively) | `not-ours` | no |
| 4 | Targeted mode: the marker names a different original | `not-ours` | no |
| 5 | Two or more open candidates carry markers with the same suggestion `id` | `not-ours` (each) | no |
| 6 | Targeted mode: the candidate is already closed or merged | `already-closed` | no |
| 7 | Targeted mode: the candidate lacks the label (compared case-insensitively) | `unlabeled` | no |
| 8 | Its original is open (drafts included) | `left-open` | no |
| 9 | Its original could not be verified (§2.7) | `unverified` | no |
| 10 | Its original merged or closed: the suggestion is re-read and verified (§2.8) | see §2.8 | only if verified |

Originals are resolved once each, however many suggestions reference them. The base branch is never checked: after a merged original's head branch is deleted, GitHub retargets its dependent pull requests ([lifecycle experiment](companion-pr-lifecycle-experiment.md)), so a suggestion may legitimately target another branch by the time it is cleaned up.

### 2.7 Resolving an original

`GET /repos/{owner}/{repo}/pulls/{n}`. Only an answer that names pull request `n`, with `state` `open` or `closed` and a boolean `merged`, resolves it:

| Answer | Original state |
| --- | --- |
| `state: open` | `open` |
| `state: closed`, `merged: true` | `merged` |
| `state: closed`, `merged: false` | `closed` |
| 404, 403, 401, 5xx, a network failure, a redirect, a malformed or inconsistent answer | `unverified`, with the reason |

An inaccessible original is not a closed original: `unverified` never leads to a close.

### 2.8 Verifying a suggestion before it is closed

A suggestion whose original has ended is read again with `GET /repos/{owner}/{repo}/pulls/{s}`, and every check is made on that fresh answer:

| Check | Failing it gives |
| --- | --- |
| The read succeeds | `failed` (with the reason; nothing is closed) |
| It is still open | `already-closed` |
| Its body still carries exactly the same marker line | `not-ours` |
| Its head and base repositories are this repository | `not-ours` (a fork is never closed, D25) |
| Its head branch is `sarif-to-comment/suggestions/<original>/<id>`, from the marker | `not-ours` |
| It still carries the label | `unlabeled` |

A suggestion that passes every check is **eligible**: `would-close` in a dry run, otherwise it is closed (§2.9).

### 2.9 Closing

After every read, each eligible suggestion is closed in ascending number order with `PATCH /repos/{owner}/{repo}/pulls/{s}` and exactly the body `{"state":"closed"}`. That is the only write cleanup ever sends. It never deletes or updates a branch, edits a body, title or label, comments, or touches the original.

| Answer | `result` |
| --- | --- |
| 200 naming the pull request with `state: closed` | `closed` |
| 403 without a rate-limit signal, or 404 (the pull request was just read, so the account can see it but may not close it) | `permission-limited` |
| 429, or 403 with a rate-limit signal (`x-ratelimit-remaining: 0`, a `retry-after` header, or a message about a rate limit) | `failed` |
| Anything else: another status, a network failure, a malformed answer | `failed` |

`failed` never claims the pull request is still open or was closed: a rerun reads it again and reports what it finds.

### 2.10 Outcome

The library resolves (it does not reject) once discovery has completed:

```text
{ status, dryRun, originals: [{ number, state, reason? }], suggestions: [{ number, url, original, result, reason? }], markdown }
```

- `originals` lists each original resolved, ascending; `state` is `open`, `merged`, `closed` or `unverified`.
- `suggestions` lists each reported candidate, ascending; `original` is the number its marker names, or `null` when it has no usable marker. `result` is one of `closed`, `would-close`, `already-closed`, `left-open`, `unverified`, `permission-limited`, `failed`, `not-ours`, `unlabeled`. `reason` explains `unverified`, `permission-limited`, `failed` and `not-ours`.
- `status`:
  - `incomplete` when any suggestion is `failed` or `unverified`, or a targeted original is `unverified`: something could not be established; running again is safe;
  - otherwise `permission-limited` when any suggestion is `permission-limited`: someone with the right to close them can finish;
  - otherwise `complete`, including a dry run and a run with nothing to do.
- `markdown` says what was checked, each original's state, each suggestion's result, that no branch is deleted, and, when relevant, that a rerun is safe or who can close the rest. Its form is shown in §3: a title naming the status (`complete`, `: dry run`, `limited by permissions`, `incomplete`), the scope, `Original pull requests:` with one line per original (`open`, `merged`, `closed without merging`, `could not be verified (<reason>)`), `Suggestion pull requests:` with one line per result (`closed`; `would be closed`; `already closed`; `left open, because the original is still open`; `left open, because the original could not be verified`; `left open, not permitted to close it: <reason>`; `not closed, the close failed: <reason>` or `not closed, it could not be read again before closing: <reason>`; `skipped, not one of this tool's suggestion pull requests: <reason>`; ``skipped, it does not carry the label `<label>` ``), then the dry-run, rerun and permission notes that apply, and last `Closing never deletes a branch: each proposal branch is left in place.`

It rejects with a `TypeError` for invalid input, and with an `Error` for an operational failure during discovery (before any write). Neither contains the token.

**CLI.** Human output is the Markdown on stdout. JSON is one document: `{ command: 'close-suggestion-prs', status, dryRun, originals, suggestions, message }`.

| Exit status | Meaning |
| --- | --- |
| 0 | `complete` (also a dry run with nothing unverified) |
| 2 | `permission-limited`: every other eligible suggestion was closed |
| 3 | `incomplete`: a failed close or an unverified original; rerun later |
| 1 | usage error, missing token, or an operational failure before any write |

### 2.11 What cleanup never does

Delete or update a branch; reopen, edit, label or comment on anything; write to the original; close a pull request whose marker is missing, duplicated, non-canonical or for another repository or original; close a fork's pull request; infer a terminal state from a failed lookup; keep any local record.

## 3. Worked example

`octo/widgets` has open labeled suggestions #40 (marker original #37) and #38, #39 (marker original #36). #37 was closed without merging; #36 is open; one more labeled pull request, #41, has no marker.

`close-suggestion-prs --repo octo/widgets --dry-run`: originals #36 `open` and #37 `closed`; #38 and #39 `left-open`, #40 `would-close`, #41 `not-ours`; status `complete`, exit 0, no write. The Markdown:

```markdown
## Suggestion pull request cleanup: dry run

Checked the open pull requests labeled `suggestion` in octo/widgets.

Original pull requests:

- #36: open
- #37: closed without merging

Suggestion pull requests:

- #38 (for #36): left open, because the original is still open
- #39 (for #36): left open, because the original is still open
- #40 (for #37): would be closed
- #41: skipped, not one of this tool's suggestion pull requests: it has the label but no suggestion marker

This was a dry run: nothing was closed.

Closing never deletes a branch: each proposal branch is left in place.
```

Without `--dry-run`, #40 is `closed`: one `PATCH`, and its branch `sarif-to-comment/suggestions/37/<id>` still exists. The title is `## Suggestion pull request cleanup complete`, #40's line reads `- #40 (for #37): closed`, and there is no dry-run note. A rerun no longer lists #40 (it is not open): #38 and #39 `left-open`, exit 0. `--original 37` then finds #40 through #37's backlinks and reports it `already-closed`.

## 4. Decisions awaiting acceptance

1. **Names** `closeSuggestionPullRequests` / `close-suggestion-prs`, and `originalPullNumber` / `--original` (§2.1–§2.2). Alternatives: `cleanupSuggestions` (collides with native suggestions and hides that it closes), or a `publish` flag (conflates cleanup with publication, D29).
2. **Closing by default, with `dryRun` / `--dry-run`** (§2.3). Alternative: report by default and close only with `--apply`. Closing is what the command is named for, it is reversible (a closed pull request can be reopened), it is gated by positive verification, and it never deletes a branch.
3. **Result vocabulary, status and exit codes** (§2.10): nine results, three statuses, exits 0/2/3/1. `permission-limited` is deterministic for the account (exit 2, like `blocked`); `incomplete` is safe to retry (exit 3, like `uncertain`).
4. **Discovery and verification** (§2.4–§2.8): the issues listing for the sweep, GraphQL cross-references for targeted mode, strict canonical markers, one read per original, a fresh read of each suggestion before closing, the head branch bound to the marker, and no base-branch check. Alternatives: the search API (index lag and caps), or trusting the listing without a re-read (a suggestion edited or moved between listing and closing would be closed).
5. **Targeted discovery by backlinks** (§2.4), rather than the labeled listing filtered by marker original. Backlinks also find suggestions whose label was removed, which are then reported as `unlabeled` and never closed.
6. **Closing only** (§2.9, §2.11): no branch deletion, no relationship store, no scan of closed originals.
7. **Commas refused in labels** (§2.2), here and in `suggestionLabel`.

## 5. Verification

| Requirement | Tests | [Live evidence](suggestion-cleanup-e2e-evidence.md) |
| --- | --- | --- |
| Open, merged, closed-unmerged and inaccessible originals (A36) | `test/cleanup-composition.test.mts` | open and closed-unmerged with suggestions; merged, closed and missing originals probed read-only |
| Pagination, duplicate references, title changes (A31) | `test/cleanup-composition.test.mts`, `test/github-cleanup.test.mts` | single page only |
| Permission-limited apart from failed; no completion inferred from a failed lookup | `test/cleanup-composition.test.mts`, `test/github-cleanup.test.mts` | missing original `unverified` (exit 3) |
| Already-closed suggestions tolerated | `test/cleanup-composition.test.mts` | sweep and targeted reruns |
| Targeted discovery, dry run | `test/cleanup-composition.test.mts` | targeted and dry runs |
| Commas refused in labels | `test/cleanup-composition.test.mts`, `test/companion-composition.test.mts`, `test/github-cleanup.test.mts` | |
| Marker recognition | `test/suggestion-marker.test.mts` | live marker of #38 |
| Public types | `test/close-suggestion-pull-requests.types.mts` | |
| CLI and library through the installed package | `test/installed-cleanup.test.mts`, `test/cli-commands.test.mts` | |
