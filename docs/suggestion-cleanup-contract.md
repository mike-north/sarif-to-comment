# Suggestion pull request cleanup: contract

Partly owner-accepted · September 29, 2026. On-demand cleanup closes open suggestion pull requests that follow the tool-neutral [suggestion pull request convention](suggestion-pr-convention.md), whichever tool created them, once their original pull request has merged or closed. It is implemented under the options below and verified against live GitHub in the [live evidence](suggestion-cleanup-e2e-evidence.md) and the [convention evidence](suggestion-pr-convention-e2e-evidence.md). The owner's decisions on [issue #27](https://github.com/mike-north/sarif-to-comment/issues/27) (label resolution, the `--label` migration override, conforming pull requests) are marked as such; the decisions still listed in [Decisions awaiting acceptance](#4-decisions-awaiting-acceptance) are provisional until the owner accepts or replaces them.

**Sources.** [Issue #6](https://github.com/mike-north/sarif-to-comment/issues/6); [issue #27](https://github.com/mike-north/sarif-to-comment/issues/27) and the [suggestion pull request convention](suggestion-pr-convention.md); [specification](specification.md) R16 (cleanup paragraph), A31 and A36, with R14 and the deferred fork case (A34); [decisions](design-decisions.md) D21, D25, D27, D28 and D29; the [companion suggestion PR contract](companion-suggestion-pr-contract.md), especially §2.6–§2.7 and §5 (what cleanup can rely on); the [lifecycle experiment](companion-pr-lifecycle-experiment.md); [status](status.md).

## 1. What is fixed by the sources

- Cleanup is a separate, bounded, on-demand action on suggestion pull requests. It is not publication and not review maintenance (D27, D29).
- The broad sweep starts from open pull requests carrying the repository's canonical suggestion label, paginated, and resolves each one's original. Targeted discovery from one original through its backlinks remains supported (R16, D21, D27).
- Cleanup acts on any suggestion pull request that conforms to the [convention](suggestion-pr-convention.md), keeping all of the strict verification below, and resolves the canonical label exactly as publication does (#27).
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

The names use the vocabulary users already have: `allowSuggestionPullRequests` / `--allow-suggestion-prs` enable the pull requests, and the specification and the [convention](suggestion-pr-convention.md) call them "suggestion PRs". "Suggestions" alone would collide with native inline suggestions, which cleanup never touches. The verb says what the command does to GitHub (it closes pull requests), and it is not a mode of `publish`, because cleanup is not publication (D29).

### 2.2 Input

| Library (`input`) | CLI | Meaning |
| --- | --- | --- |
| `repository: { owner, repo }` | `--repo OWNER/REPO` | The repository whose suggestion pull requests are checked. Required. |
| `token` | `GH_TOKEN`, else `GITHUB_TOKEN` | A personal access token or user token, as for `publish`. Never shown. |
| `label?` | `--label NAME` | A **migration override** (#27): sweep and verify with this label instead of the repository's canonical label, for suggestions left under a previously configured label. Omitted: the canonical label (§2.2.1). |
| `originalPullNumber?` | `--original N` | Targeted mode: only the pull requests referencing this original (§2.4). |
| `dryRun?` | `--dry-run` | Discover and verify everything, close nothing (§2.3). |
| | `--format human\|json` | As for every command. |

Unknown fields are refused. Invalid input is a `TypeError` (CLI: a usage error, exit 1) before any request.

**Labels.** `label` must be a label name under the [convention](suggestion-pr-convention.md#3-the-canonical-label): 1–50 characters, no control or invisible formatting characters, no surrounding whitespace, and **no comma**. GitHub's label filter takes a comma-separated list, so a label with a comma cannot be selected on its own; the convention refuses commas in every suggestion label for the same reason.

#### 2.2.1 The canonical label

Without `label`, cleanup resolves the repository's canonical label exactly as `publish` and `validate` do ([companion contract §2.7](companion-suggestion-pr-contract.md#27-relationship-reference-marker-and-labels), [convention §4](suggestion-pr-convention.md#4-repository-configuration)), before any other read: the `label` of `.github/suggestion-prs.json` on the current commit of the default branch, otherwise `suggestion-pr`.

| Repository configuration | Cleanup |
| --- | --- |
| Absent, or an object without `label` | Uses `suggestion-pr` |
| A valid `label` | Uses it |
| Invalid (not UTF-8 JSON, not an object, `label` not a string, empty, with a comma or otherwise not a label name; a directory, symbolic link or submodule; over 1,000,000 bytes) | **Refuses**: rejects with an `Error` naming the file and the field (CLI: exit 1, "Nothing was closed."). Nothing else is read and nothing is closed. |
| The read failed (network, HTTP 403, 5xx, a malformed answer) | Operational: rejects (CLI: exit 1) before any other read. Never a silent default. |

With `label` (`--label`), the configuration is not read at all: the override names the label to use. The Markdown's scope line says which label was used and where it came from (§2.10).

### 2.3 Closing is the default; `--dry-run` writes nothing

The command's name is its intent, as with `publish` and `validate`: it closes eligible suggestion pull requests. `dryRun: true` (`--dry-run`) performs exactly the same discovery, resolution and verification reads and reports `would-close` where it would close; it sends no write of any kind. A dry run cannot predict permission: only an attempt establishes it (D25), so a dry run never reports `permission-limited`.

**All discovery and verification completes before any close.** Closing a pull request removes it from the `state=open` listing, which would shift later pages; reading everything first also means an operational failure during discovery leaves nothing half done.

**The window this leaves.** An original's state is read once, during discovery, and is not read again before its suggestions are closed. If someone reopens an original while a long sweep is still reading, its suggestions can still be closed on the strength of the earlier read (and a suggestion is re-read during verification, not immediately before its close). This is accepted rather than narrowed with a second read, which would only shrink the window: closing is reversible (a closed pull request can be reopened on GitHub, and its proposal branch, commits, body and label are all left untouched), so a suggestion closed this way is restored by reopening it.

### 2.4 Discovery

**Sweep (the default).** Every page of `GET /repos/{owner}/{repo}/issues?labels={label}&state=open`, where `label` is the canonical label or the override (§2.2.1),, following validated `Link: rel="next"` pagination (at most 100 pages of 100). Entries without a `pull_request` object are issues and are ignored. A pull request listed twice (pages can shift while being read) counts once. The issues listing is used because it filters by label on the host; the search API is not used (index lag, a 1,000-result cap and a separate rate limit).

**Targeted (`originalPullNumber`).** The original is resolved first (§2.7). If it cannot be verified, discovery stops there: nothing could be closed, and the outcome reports the original as `unverified`. Otherwise one paginated GraphQL traversal reads the original's `timelineItems(itemTypes: [CROSS_REFERENCED_EVENT])` and follows each event's `source` to a `PullRequest` (number, URL, repository, state, body and labels), as D21 describes. Sources that are issues, and sources in another repository, are ignored (D25); a foreign source is left out before its state or labels are read or checked, so an inaccessible or malformed foreign repository can never stop discovery. A source listed more than once counts once. A source's labels are read through this repository's REST labels listing when it has more than 100. This is the backlink lookup of D21 and D28 with the client the tool already has; no local record of earlier publications is consulted.

Any failure to list (HTTP, network, malformed answer, pagination) is operational: the call rejects (CLI: exit 1) and nothing has been closed.

### 2.5 Marker recognition

The marker of [convention §7](suggestion-pr-convention.md#7-the-marker) is the relationship. A body is read line by line, ignoring one trailing carriage return per line (GitHub may store edited bodies with CRLF):

- No line begins with `<!-- suggestion-pr ` → no marker.
- More than one such line (for example the marker quoted in feedback) → refused, never guessed at.
- Exactly one such line → it must be the **canonical** line of well-formed fields: `version` 1; `original` exactly `{ owner, repo, pullNumber }` with GitHub names and a positive integer; `reviewedCommit` a full lowercase commit; `id` and `batch` 1–64 letters, digits, `-` and `_`, beginning and ending with a letter or digit; and the whole line byte-identical to the canonical line formatted from those fields. Anything else (extra keys, reordered keys, whitespace, another version, a changed value in the wrong shape) is refused. Any tool's marker in this form is recognized, not only this tool's (#27); `batch` is never interpreted.

The marker may appear anywhere in the body: a person may edit the text around it (companion contract §2.10). Titles are never read.

### 2.6 Classification

Each candidate pull request gets exactly one `result`, decided in this order:

| # | Condition | `result` | Closed? |
| --- | --- | --- | --- |
| 1 | Targeted mode: no marker and no label | not reported: an ordinary reference | no |
| 2 | No marker but the label; several markers; a non-canonical marker | `not-ours` (not a conforming suggestion pull request) | no |
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
| Its head branch is `suggestion-pr/<original>/<id>`, from the marker ([convention §5](suggestion-pr-convention.md#5-the-branch)) | `not-ours` |
| It still carries the label (the canonical label, or the override) | `unlabeled` |

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
- `suggestions` lists each reported candidate, ascending; `original` is the number its marker names, or `null` when it has no usable marker. `result` is one of `closed`, `would-close`, `already-closed`, `left-open`, `unverified`, `permission-limited`, `failed`, `not-ours`, `unlabeled`. `reason` explains `unverified`, `permission-limited`, `failed` and `not-ours`. Under the convention, `not-ours` means "not a conforming suggestion pull request", whichever tool made it (§4, open question 8).
- `status`:
  - `incomplete` when any suggestion is `failed` or `unverified`, or a targeted original is `unverified`: something could not be established; running again is safe;
  - otherwise `permission-limited` when any suggestion is `permission-limited`: someone with the right to close them can finish;
  - otherwise `complete`, including a dry run and a run with nothing to do.
- `markdown` says what was checked, each original's state, each suggestion's result, that no branch is deleted, and, when relevant, that a rerun is safe or who can close the rest. Its form is shown in §3: a title naming the status (`complete`, `: dry run`, `limited by permissions`, `incomplete`), the scope (``Checked the open pull requests labeled `LABEL` in OWNER/REPO (SOURCE).`` for a sweep, ``Checked the pull requests that reference #N in OWNER/REPO; the suggestion label is `LABEL` (SOURCE).`` when targeted, where SOURCE is `the default suggestion label`, ``the suggestion label set in .github/suggestion-prs.json on `BRANCH` `` or `a label given in place of the repository's suggestion label`), `Original pull requests:` with one line per original (`open`, `merged`, `closed without merging`, `could not be verified (<reason>)`), `Suggestion pull requests:` with one line per result (`closed`; `would be closed`; `already closed`; `left open, because the original is still open`; `left open, because the original could not be verified`; `left open, not permitted to close it: <reason>`; `not closed, the close failed: <reason>` or `not closed, it could not be read again before closing: <reason>`; `skipped, not a conforming suggestion pull request: <reason>`; ``skipped, it does not carry the label `<label>` ``), then the dry-run, rerun and permission notes that apply, and last `Closing never deletes a branch: each proposal branch is left in place.`

It rejects with a `TypeError` for invalid input, and with an `Error` for an operational failure during discovery (before any write). Neither contains the token.

**CLI.** Human output is the Markdown on stdout. JSON is one document: `{ command: 'close-suggestion-prs', status, dryRun, originals, suggestions, message }`.

| Exit status | Meaning |
| --- | --- |
| 0 | `complete` (also a dry run with nothing unverified) |
| 2 | `permission-limited`: every other eligible suggestion was closed |
| 3 | `incomplete`: a failed close or an unverified original; rerun later |
| 1 | usage error, missing token, or an operational failure before any write |

### 2.11 What cleanup never does

Delete or update a branch; reopen, edit, label or comment on anything; write to the original; close a pull request whose marker is missing, duplicated, non-canonical or for another repository or original; close a fork's pull request; infer a terminal state from a failed lookup; treat an unreadable repository configuration as absent; write the repository configuration; keep any local record.

## 3. Worked example

`octo/widgets` has no `.github/suggestion-prs.json`, so its canonical label is `suggestion-pr`. It has open labeled suggestions #40 (marker original #37) and #38, #39 (marker original #36). #37 was closed without merging; #36 is open; one more labeled pull request, #41, has no marker.

`close-suggestion-prs --repo octo/widgets --dry-run`: originals #36 `open` and #37 `closed`; #38 and #39 `left-open`, #40 `would-close`, #41 `not-ours`; status `complete`, exit 0, no write. The Markdown:

```markdown
## Suggestion pull request cleanup: dry run

Checked the open pull requests labeled `suggestion-pr` in octo/widgets (the default suggestion label).

Original pull requests:

- #36: open
- #37: closed without merging

Suggestion pull requests:

- #38 (for #36): left open, because the original is still open
- #39 (for #36): left open, because the original is still open
- #40 (for #37): would be closed
- #41: skipped, not a conforming suggestion pull request: it has the label but no suggestion marker

This was a dry run: nothing was closed.

Closing never deletes a branch: each proposal branch is left in place.
```

Without `--dry-run`, #40 is `closed`: one `PATCH`, and its branch `suggestion-pr/37/<id>` still exists. The title is `## Suggestion pull request cleanup complete`, #40's line reads `- #40 (for #37): closed`, and there is no dry-run note. A rerun no longer lists #40 (it is not open): #38 and #39 `left-open`, exit 0. `--original 37` then finds #40 through #37's backlinks and reports it `already-closed`.

## 4. Decisions awaiting acceptance

Decided by the owner (September 29, 2026, the review of #5, #6 and #24 recorded on [#27](https://github.com/mike-north/sarif-to-comment/issues/27)), and no longer awaiting acceptance:

- **Label resolution** (§2.2.1): the repository configuration's `label`, otherwise `suggestion-pr`, resolved identically by `publish`, `validate` and `close-suggestion-prs`; an invalid configuration makes cleanup refuse; a failed read is operational, never a silent default.
- **`label` / `--label` as a migration override only** (§2.2), for sweeping suggestions left under a previously configured label.
- **Conforming pull requests** (§2.5–§2.8): cleanup acts on any suggestion pull request that conforms to the [convention](suggestion-pr-convention.md), keeping all of the existing strict verification: the names (`closeSuggestionPullRequests` / `close-suggestion-prs`, `originalPullNumber` / `--original`), the sweep and targeted discovery, strict canonical markers, one read per original, a fresh read of each suggestion before closing, the head branch bound to the marker, and the result vocabulary and statuses.
- **Closing only** (§2.9, §2.11): cleanup closes pull requests and never deletes a branch; branch removal is left to people or to GitHub's automatic deletion of merged branches.
- **Commas refused in labels** (§2.2), here and in every suggestion label.

Still awaiting the owner:

1. **Closing by default, with `dryRun` / `--dry-run`** (§2.3). Alternative: report by default and close only with `--apply`. Closing is what the command is named for, it is reversible (a closed pull request can be reopened), it is gated by positive verification, and it never deletes a branch.
2. **The exit-code mapping** (§2.10): exits 0/2/3/1 for `complete`, `permission-limited`, `incomplete` and usage or operational failures. `permission-limited` is deterministic for the account (exit 2, like `blocked`); `incomplete` is safe to retry (exit 3, like `uncertain`).
3. **A 404 on close is permission-limited** (§2.9): the pull request was just read, so the account can see it but may not close it.
4. **No author check** (§2.8): a conforming suggestion pull request is closed whoever opened it.

Open questions this contract raises for the owner:

5. **`not-ours` under the convention.** The result now means "not a conforming suggestion pull request", whichever tool made it; only its human wording changed, because the vocabulary is decided. A rename (for example `not-conforming`) would match the meaning better.
6. **An override skips the configuration** (§2.2.1): with `--label`, the repository configuration is not read, so an invalid configuration does not stop a sweep under an explicitly named label. The alternative is to read it anyway and refuse when it is invalid.

## 5. Verification

| Requirement | Tests | [Live evidence](suggestion-cleanup-e2e-evidence.md) |
| --- | --- | --- |
| Open, merged, closed-unmerged and inaccessible originals (A36) | `test/cleanup-composition.test.mts` | open and closed-unmerged with suggestions; merged, closed and missing originals probed read-only |
| Pagination, duplicate references, title changes (A31) | `test/cleanup-composition.test.mts`, `test/github-cleanup.test.mts` | single page only |
| Permission-limited apart from failed; no completion inferred from a failed lookup | `test/cleanup-composition.test.mts`, `test/github-cleanup.test.mts` | missing original `unverified` (exit 3) |
| Already-closed suggestions tolerated | `test/cleanup-composition.test.mts` | sweep and targeted reruns |
| Targeted discovery, dry run | `test/cleanup-composition.test.mts` | targeted and dry runs |
| Commas refused in labels | `test/cleanup-composition.test.mts`, `test/companion-composition.test.mts`, `test/github-cleanup.test.mts` | |
| Canonical label from the repository configuration, `--label` migration override, conforming pull requests of any tool (#27) | `test/suggestion-pr-convention.test.mts`, `test/cleanup-composition.test.mts` | [convention evidence](suggestion-pr-convention-e2e-evidence.md): default label only (the default branch is never modified) |
| Marker recognition | `test/suggestion-marker.test.mts` | the [convention evidence](suggestion-pr-convention-e2e-evidence.md) |
| Public types | `test/close-suggestion-pull-requests.types.mts` | |
| CLI and library through the installed package | `test/installed-cleanup.test.mts`, `test/cli-commands.test.mts` | |
