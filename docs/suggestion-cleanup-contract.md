# Suggestion pull request cleanup: contract

Owner-accepted · September 30, 2026. On-demand cleanup closes open suggestion pull requests that follow the tool-neutral [suggestion pull request convention](suggestion-pr-convention.md), whichever tool created them, once their original pull request has merged or closed. It is implemented under the options below and verified against live GitHub in the [live evidence](suggestion-cleanup-e2e-evidence.md) and the [convention evidence](suggestion-pr-convention-e2e-evidence.md). The owner's decisions on [issue #27](https://github.com/mike-north/sarif-to-comment/issues/27) (label resolution, the `--label` migration override, conforming pull requests), recorded in the decision log as [D41](design-decisions.md#d41-the-suggestion-pull-request-convention-and-options--owner-decisions), and on [issue #44](https://github.com/mike-north/sarif-to-comment/issues/44) (closing by default, the exit codes, a 404 on close, the override skipping the configuration, the owner scope and bounded discovery), recorded as [D47](design-decisions.md#d47-scope-cleanup-by-who-opened-the-suggestion-and-bound-its-discovery--owner-decisions), are listed in [Decisions](#4-decisions). The owner's optional abandonment cleanup ([D54](design-decisions.md#d54-delay-optional-abandonment-cleanup-and-recheck-the-original--owner-selected-candidate-policy-workflow-experiment-pending)) is a guard on targeted cleanup, implemented October 1, 2026 (§2.12), with an example workflow that is documentation only. Only the [open questions](#4-decisions) listed there remain for the owner.

**Sources.** [Issue #6](https://github.com/mike-north/sarif-to-comment/issues/6); [issue #44](https://github.com/mike-north/sarif-to-comment/issues/44); [issue #27](https://github.com/mike-north/sarif-to-comment/issues/27) and the [suggestion pull request convention](suggestion-pr-convention.md); [specification](specification.md) R16 (cleanup paragraph), A31 and A36, with R14 and the deferred fork case (A34); [decisions](design-decisions.md) D21, D25, D27, D28, D29 and D54; the [companion suggestion PR contract](companion-suggestion-pr-contract.md), especially §2.6–§2.7 and §5 (what cleanup can rely on); the [lifecycle experiment](companion-pr-lifecycle-experiment.md); [status](status.md).

## 1. What is fixed by the sources

- Cleanup is a separate, bounded, on-demand action on suggestion pull requests. It is not publication and not review maintenance (D27, D29).
- The broad sweep starts from the open pull requests of the convention's suggestion branches, paginated, confirms each one's canonical suggestion label, and resolves each one's original. A sweep's cost scales with suggestion branches, never with the repository's size, and a bad input is refused within one or two requests (#44). Targeted discovery from one original through its backlinks remains supported (R16, D21, D27).
- Cleanup acts on any suggestion pull request that conforms to the [convention](suggestion-pr-convention.md), keeping all of the strict verification below, and resolves the canonical label exactly as publication does (#27).
- The relationship is the structured marker, never the title. Returned pull requests are deduplicated (A31, D21; companion contract §5).
- A suggestion is closed only after the original has been **positively** resolved as merged or closed. A failed or unauthorized lookup is not a terminal state (R16, D27, A36).
- Cleanup uses the caller's actual permissions, checked on each pull request. Permission-limited leftovers are reported apart from failed actions, and one run never claims global completion (R16, D25, A34, A36).
- Repeated runs tolerate suggestions that are already closed (A36).
- Closing a pull request and deleting its branch are separate operations; cleanup never deletes a branch (R16, D27; companion contract §2.6).
- No relationship store, no continuously running process and no scan of the history of closed originals (R16, D27).
- Near-term support is the same repository only (D25).

## 2. Decisions

### 2.1 Names

| Library | CLI |
| --- | --- |
| `closeSuggestionPullRequests(input)` | `sarif-to-comment close-suggestion-prs` |

The names use the vocabulary users already have: a [delivery list](delivery-policy-contract.md) that names `companion` requests the pull requests, and the specification and the [convention](suggestion-pr-convention.md) call them "suggestion PRs". "Suggestions" alone would collide with native inline suggestions, which cleanup never touches. The verb says what the command does to GitHub (it closes pull requests), and it is not a mode of `publish`, because cleanup is not publication (D29).

### 2.2 Input

| Library (`input`) | CLI | Meaning |
| --- | --- | --- |
| `repository: { owner, repo }` | `--repo OWNER/REPO` | The repository whose suggestion pull requests are checked. Required. |
| `token` | `GH_TOKEN`, else `GITHUB_TOKEN` | A personal access token or user token, as for `publish`. Never shown. |
| `label?` | `--label NAME` | A **migration override** (#27): sweep the open pull requests with this label (a *label sweep*) and verify with it, instead of the repository's canonical label, for suggestions left under a previously configured label. Omitted: the default sweep by suggestion branch, confirmed by the canonical label (§2.2.1, §2.4). |
| `originalPullNumber?` | `--original N` | Targeted mode: only the pull requests referencing this original (§2.4). |
| `owner?` | `--owner me\|all` | Whose suggestion pull requests may be closed, by who opened the **suggestion** pull request (not the original): `me` (the default), the authenticated account; `all`, anyone (§2.6). |
| `maxCandidates?` | `--max-candidates N` | A sweep's candidate limit, a positive integer; default 500 (§2.4.1). Targeted discovery has no limit, so it cannot be combined with `originalPullNumber` (`--original`). |
| `force?` | `--force` | A label sweep continues past the early exit (§2.4.2); its limit still applies (§2.4.1). Nothing else stops early, so `force: true` requires `label` and cannot be combined with `originalPullNumber` (`--force` requires `--label` and cannot be combined with `--original`). |
| `requireAbandonedOriginal?` | `--if-abandoned` | Targeted mode only: proceed only if a fresh read shows the original closed without merging; otherwise skip, closing nothing (§2.12). `true` requires `originalPullNumber` (`--if-abandoned` requires `--original`). |
| `dryRun?` | `--dry-run` | Discover and verify everything, close nothing (§2.3). |
| | `--format human\|json` | As for every command. |

Unknown fields are refused. Invalid input is a `TypeError` (CLI: a usage error, exit 1, whose remedy names `sarif-to-comment close-suggestion-prs --help`) before any request. An option that could change nothing is invalid input too, never silently ignored: `force: true` without `label` or with `originalPullNumber`, `maxCandidates` with `originalPullNumber`, and `requireAbandonedOriginal: true` without `originalPullNumber`. `force: false` and `requireAbandonedOriginal: false` ask for nothing and are accepted.

**Labels.** `label` must be a label name under the [convention](suggestion-pr-convention.md#3-the-canonical-label): 1–50 characters, no control or invisible formatting characters, no surrounding whitespace, and **no comma**. GitHub's label filter takes a comma-separated list, so a label with a comma cannot be selected on its own; the convention refuses commas in every suggestion label for the same reason.

#### 2.2.1 The canonical label

Without `label`, cleanup resolves the repository's canonical label exactly as `publish` and `validate` do ([companion contract §2.7](companion-suggestion-pr-contract.md#27-relationship-reference-marker-and-labels), [convention §4](suggestion-pr-convention.md#4-repository-configuration)): the `label` of `.github/suggestion-prs.json` on the current commit of the default branch, otherwise `suggestion-pr`. It is read after a sweep's first page (which does not depend on it, and may stop the run, §2.4.1), and first of all in targeted mode; always before any pull request is classified.

| Repository configuration | Cleanup |
| --- | --- |
| Absent, or an object without `label` | Uses `suggestion-pr` |
| A valid `label` | Uses it |
| Invalid (not UTF-8 JSON, not an object, `label` not a string, empty, with a comma or otherwise not a label name; a directory, symbolic link or submodule at the path, or a symbolic link or submodule on the way to it; over 1,000,000 bytes) | **Refuses**: rejects with an `Error` naming the file and the field (CLI: exit 1, "Nothing was closed."). Nothing else is read and nothing is closed. |
| The read failed (network, HTTP 403, 5xx, a malformed answer) | Operational: rejects (CLI: exit 1) before any pull request or the account is read. Never a silent default. |

With `label` (`--label`), the configuration is not read at all: the override names the label to use, so an invalid configuration does not stop a sweep under an explicitly named label (owner decision, #44). GitHub answers 404 alike for a pull request that does not exist and for a repository that does not exist or that the token cannot see, so an original's 404 means "no such pull request" (§2.7) only once the repository is known to exist. The configuration read establishes that, and a label sweep's first listing fails on a missing repository; so with `label` in targeted mode, and only then, the repository itself is read first (`GET /repos/{owner}/{repo}`), once. A failed repository read is operational: the call rejects with an `Error` naming the repository (CLI: exit 1) before anything else is read. The Markdown's scope line says which label was used and where it came from (§2.10).

### 2.3 Closing is the default; `--dry-run` writes nothing

The command's name is its intent, as with `publish` and `validate`: it closes eligible suggestion pull requests. `dryRun: true` (`--dry-run`) performs exactly the same discovery, resolution and verification reads and reports `would-close` where it would close; it sends no write of any kind. A dry run cannot predict permission: only an attempt establishes it (D25), so a dry run never reports `permission-limited`.

**All discovery and verification completes before any close.** Closing a pull request removes it from the `state=open` listing, which would shift later pages; reading everything first also means an operational failure during discovery leaves nothing half done.

**The window this leaves.** An original's state is read once, during discovery, and is not read again before its suggestions are closed. If someone reopens an original while a long sweep is still reading, its suggestions can still be closed on the strength of the earlier read (and a suggestion is re-read during verification, not immediately before its close). This is accepted rather than narrowed with a second read, which would only shrink the window: closing is reversible (a closed pull request can be reopened on GitHub, and its proposal branch, commits, body and label are all left untouched), so a suggestion closed this way is restored by reopening it.

### 2.4 Discovery

**Sweep by suggestion branch (the default).** The convention puts every suggestion on a branch `suggestion-pr/<original>/<id>` ([convention §5](suggestion-pr-convention.md#5-the-branch)), so the sweep lists that namespace, not a label: one GraphQL query, paginated, with two `repository.refs` connections. `refs(refPrefix: "refs/heads/suggestion-pr/", first: 0)` answers only `totalCount`, the count of branches under `suggestion-pr/`. `refs(refPrefix: "refs/heads/", query: "suggestion-pr/", orderBy: ALPHABETICAL)` lists the branches, each with `associatedPullRequests(states: OPEN, first: 10)` and each pull request's number, URL, body, head branch and repository, author and first 100 labels (more are read through REST). The branches are listed under `refs/heads/` and narrowed by GitHub's name filter (`query`), not listed under `refs/heads/suggestion-pr/`, because GitHub associates no pull request with a ref listed under a prefix deeper than `refs/heads/` ([live evidence of October 1, 2026](suggestion-cleanup-e2e-evidence.md#the-default-sweeps-defect-diagnosed-and-fixed)). The name filter matches anywhere in a name, ignoring case, so it can also list a branch such as `backport/suggestion-pr/1/x` or `Suggestion-PR/1/x`; such a branch is not under `suggestion-pr/`, is left out before anything about it is read, and is neither counted nor a candidate. The first page asks for 100 branches, and so does every later one. A branch without an open pull request (its suggestion was closed; closing never deletes a branch) costs nothing more; a pull request of another repository (one from a branch here into an upstream) is left out before anything else about it is read; a branch with more than 10 open pull requests is an operational error, never truncated. The canonical label is a **confirming check** on each pull request found (§2.6), not the search net, so the cost scales with suggestion branches, not with the repository's pull requests.

**Label sweep (`label`).** One GraphQL query, paginated, of `repository.pullRequests(labels: [label], states: OPEN, orderBy: CREATED_AT ASC)` with `totalCount` and the same fields. The first page asks for 20 pull requests (§2.4.2), later pages for 100. Oldest first, so that a pull request opened while the listing is read only adds a later page. The label is a GraphQL list element, so a comma could never turn it into a list.

**Both sweeps** read every page before classifying anything. A pull request listed twice counts once. Pagination follows `pageInfo.endCursor`; a next page without a cursor, a repeated cursor, or a listing that grows by more than one page beyond its first `totalCount` while being read is operational. The REST issues listing is no longer used: it pages through every labeled issue and pull request, and a label shared with ordinary work made a sweep's cost grow with the repository. The search API is not used either (index lag, a 1,000-result cap and a separate rate limit).

**Request cost.** A sweep costs `ceil(n / 100)` listing queries for the `n` branches the name filter lists: the branches under `suggestion-pr/`, and any other branch whose name contains `suggestion-pr/` in any case, which a repository following the convention does not have (a label sweep: one query for its first 20 pull requests, then `ceil((n - 20) / 100)`), then the configuration read (default sweep only), one `GET /user` if any conforming, labeled suggestion reaches the owner check with `owner: 'me'`, one read per distinct original, one fresh read per suggestion of an ended original, and one `PATCH` per close. A refused sweep (§2.4.1, §2.4.2) costs one request.

**Targeted (`originalPullNumber`).** The original is resolved first (§2.7). If it cannot be verified, discovery stops there: nothing could be closed, and the outcome reports the original as `unverified`. If GitHub answers that it does not exist (`not-found`), discovery stops there too: nothing can reference a pull request that does not exist, so cleanup is `complete`, with an `original-pull-request-not-found` warning (a mistyped number is a definitive answer, never a reason to run again). Otherwise one paginated GraphQL traversal reads the original's `timelineItems(itemTypes: [CROSS_REFERENCED_EVENT])` and follows each event's `source` to a `PullRequest` (number, URL, repository, state, body and labels), as D21 describes. Sources that are issues, and sources in another repository, are ignored (D25); a foreign source is left out before its state or labels are read or checked, so an inaccessible or malformed foreign repository can never stop discovery. A source listed more than once counts once. A source's labels are read through this repository's REST labels listing when it has more than 100. This is the backlink lookup of D21 and D28 with the client the tool already has; no local record of earlier publications is consulted.

Any failure to list (HTTP, network, malformed answer, GraphQL errors, pagination) is operational: the call rejects (CLI: exit 1) and nothing has been closed. Targeted discovery also reads each source's head branch and repository and its author, for §2.6.

#### 2.4.1 Count first, with a limit

A sweep's first page carries GitHub's total count of its candidates: the branches under `suggestion-pr/`, or the open pull requests with the label. A label sweep's early exit (§2.4.2) is decided first, from the same page; `force` lifts only the early exit, so a forced label sweep is still limited here. If the count exceeds `maxCandidates` (`--max-candidates`, default **500**), the sweep stops there: nothing is evaluated, no further page, configuration, account or pull request is read, and nothing is closed. The outcome resolves with status `too-many-candidates`, empty `originals` and `suggestions`, `counts.candidates` set to the count, and one error diagnostic, `suggestion-pr-candidates-over-limit`, about the repository, stating the count and the limit and how to narrow (`--original`) or raise the limit (CLI: exit 1). Exactly the limit is allowed. Targeted discovery has no limit: it is already narrowed to one original, so `maxCandidates` with `originalPullNumber` is refused (§2.2).

**Known limitation: the branches of closed suggestions count.** The default sweep's count is GitHub's total of branches under `suggestion-pr/`, read in the first request, and cleanup never deletes a branch (§1, §2.9). The branches of suggestions already closed, by cleanup or by hand, therefore still count, and an active repository can reach the limit over time even with few open suggestions. The remedy is `--max-candidates N` (`maxCandidates`), which the diagnostic's remedy names, saying why the count grows; deleting the branches of closed suggestions also lowers it. The count is not narrowed to branches with an open pull request, because that would take reading every page, the cost the limit exists to bound.

#### 2.4.2 Early exit of a label sweep

A label sweep's first page is its first 20 pull requests. If there is at least one and none of them shows a suggestion pull request, judged from the listing alone (a body line that begins `<!-- suggestion-pr `, even a malformed one, or a head branch under `suggestion-pr/`), the label looks wrong and the sweep stops: nothing is evaluated and no per-pull-request read is made. The outcome resolves with status `label-not-suggestion-prs`, empty `originals` and `suggestions`, and one warning diagnostic, `label-not-suggestion-prs`, about the repository, naming the label and how many pull requests were inspected (CLI: exit 2). `force: true` (`--force`) continues anyway, for a deliberate second run; the limit (§2.4.1) still applies after it. A label no open pull request carries is not stopped: there is nothing to check. The default sweep never stops early: every pull request on a suggestion branch is a candidate by construction.

**Order.** The early exit is decided before the limit, on the same first page. A wrong broad label is therefore refused as `label-not-suggestion-prs` (exit 2) whether 30 or 600 pull requests carry it, never as `too-many-candidates`; only with `force` can a label sweep stop over its limit.

A mistyped or overly broad label therefore costs one request before it is refused (the owner's bound is two).

### 2.5 Marker recognition

The marker of [convention §7](suggestion-pr-convention.md#7-the-marker) is the relationship. A body is read line by line, ignoring one trailing carriage return per line (GitHub may store edited bodies with CRLF):

- No line begins with `<!-- suggestion-pr ` → no marker.
- More than one such line (for example the marker quoted in feedback) → refused, never guessed at.
- Exactly one such line → it must be the **canonical** line of well-formed fields: `version` 1, or `version` 2 for a suggestion re-applied after a rewritten history (no longer written by `publish` since October 1, 2026, and still recognized here), which alone carries `reappliedOnto` after `reviewedCommit` ([convention §7](suggestion-pr-convention.md#7-the-marker), [#28](https://github.com/mike-north/sarif-to-comment/issues/28)); `original` exactly `{ owner, repo, pullNumber }` with GitHub names and a positive integer; `reviewedCommit` (and `reappliedOnto`, a different one) a full lowercase commit; `id` and `batch` 1–64 letters, digits, `-` and `_`, beginning and ending with a letter or digit; and the whole line byte-identical to the canonical line formatted from those fields. Anything else (extra keys, reordered keys, whitespace, another version, a changed value in the wrong shape) is refused. Any tool's marker in this form is recognized, not only this tool's (#27); `batch` is never interpreted.

The marker may appear anywhere in the body: a person may edit the text around it (companion contract §2.10). Titles are never read.

### 2.6 Classification

Each candidate pull request gets exactly one `result`, decided in this order:

| # | Condition | `result` | Closed? |
| --- | --- | --- | --- |
| 1 | Targeted mode: no marker, no label and not on a `suggestion-pr/` branch | not reported: an ordinary reference | no |
| 2 | No marker (but a suggestion branch or the label); several markers; a non-canonical marker | `not-conforming` (not a conforming suggestion pull request) | no |
| 3 | The marker names another repository (compared case-insensitively) | `not-conforming` | no |
| 4 | Targeted mode: the marker names a different original | `not-conforming` | no |
| 5 | Two or more open candidates carry markers with the same suggestion `id` | `not-conforming` (each) | no |
| 6 | Its head branch is not `suggestion-pr/<original>/<id>` from the marker, or not in this repository (a fork, or a deleted repository) | `not-conforming` | no |
| 7 | Targeted mode: the candidate is already closed or merged | `already-closed` | no |
| 8 | The candidate lacks the label (compared case-insensitively) | `unlabeled` | no |
| 9 | `owner: 'me'` and someone other than the authenticated account opened it | `other-owner` | no |
| 10 | Its original is open (drafts included) | `left-open` | no |
| 11 | Its original could not be verified (§2.7) | `unverified` | no |
| 12 | Its original does not exist (§2.7): the marker names a number that is not a pull request of this repository | `not-conforming` | no |
| 13 | Its original merged or closed: the suggestion is re-read and verified (§2.8) | see §2.8 | only if verified |

Rows 2–6 are conformance ([convention §9](suggestion-pr-convention.md#9-conformance-and-acting-on-suggestion-pull-requests)) as the listing shows it; `counts.conforming` counts the candidates that pass them. Originals are resolved once each, however many suggestions reference them.

**Owner scope (row 9).** `owner` names who opened the *suggestion* pull request, not the original, as GitHub reports its author. With `me` (the default), the authenticated account's login is read once (`GET /user`), and only when a conforming, labeled, open candidate reaches this row; a pull request without an author (a deleted account) is someone else's. Logins compare case-insensitively. With `all`, the account is not read and any conforming suggestion may be closed. Someone else's suggestion is not a problem to report: it has no diagnostic and no reason, and its original is not read on its account. A failed account read is operational: the call rejects before anything is closed. The base branch is never checked: after a merged original's head branch is deleted, GitHub retargets its dependent pull requests ([lifecycle experiment](companion-pr-lifecycle-experiment.md)), so a suggestion may legitimately target another branch by the time it is cleaned up.

### 2.7 Resolving an original

`GET /repos/{owner}/{repo}/pulls/{n}`. Only an answer that names pull request `n`, with `state` `open` or `closed` and a boolean `merged`, resolves it:

| Answer | Original state |
| --- | --- |
| `state: open` | `open` |
| `state: closed`, `merged: true` | `merged` |
| `state: closed`, `merged: false` | `closed` |
| 404 | `not-found`: the repository has no pull request `n` that this account can read |
| 403, 401, 5xx, a network failure, a redirect, a malformed or inconsistent answer | `unverified`, with the reason |

An inaccessible original is not a closed original: neither `not-found` nor `unverified` ever leads to a close. They differ in what running cleanup again can change. A 404 is GitHub's definitive answer about the number, because cleanup has already established that this repository exists (§2.2.1), so it is the same on every run; every other failure may pass.

### 2.8 Verifying a suggestion before it is closed

A suggestion whose original has ended is read again with `GET /repos/{owner}/{repo}/pulls/{s}`, and every check is made on that fresh answer:

| Check | Failing it gives |
| --- | --- |
| The read succeeds | `failed` (with the reason; nothing is closed) |
| It is still open | `already-closed` |
| Its body still carries exactly the same marker line | `not-conforming` |
| Its base repository is this repository | `not-conforming` |
| Its head branch is `suggestion-pr/<original>/<id>` from the marker ([convention §5](suggestion-pr-convention.md#5-the-branch)), in this repository | `not-conforming` (a fork is never closed, D25) |
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

The library resolves (it does not reject) once discovery has completed, once a sweep has stopped (§2.4.1, §2.4.2), or once a guarded run has skipped because its original is not closed without merging (§2.12):

```text
{ status, dryRun, owner, originals: [{ number, state, reason? }], suggestions: [{ number, url, original, result, reason? }],
  counts: { candidates, checked, labeled, conforming }, markdown, diagnostics }
```

- `owner` is the scope used: `me` or `all`.
- `originals` lists each original resolved, ascending; `state` is `open`, `merged`, `closed`, `not-found` or `unverified`.
- `suggestions` lists each reported candidate, ascending; `original` is the number its marker names, or `null` when it has no usable marker. `result` is one of `closed`, `would-close`, `already-closed`, `left-open`, `unverified`, `permission-limited`, `failed`, `not-conforming`, `other-owner`, `unlabeled`. `reason` explains `unverified`, `permission-limited`, `failed` and `not-conforming`. `not-conforming` means "not a conforming suggestion pull request", whichever tool made it; it was named `not-ours` before its first release (owner decision, #44). `other-owner` means a conforming suggestion someone else opened, left open under `owner: 'me'`.
- `counts`: `candidates` is what discovery counted, the number `maxCandidates` limits (GitHub's total of branches under `suggestion-pr/` for the default sweep, of open pull requests with the label for a label sweep; for targeted discovery, the pull requests of this repository that reference the original); `checked` is the number of `suggestions`; `labeled` and `conforming` are how many of those carried the label and passed rows 2–6 of §2.6 as discovery listed them.
- `status`:
  - `too-many-candidates` or `label-not-suggestion-prs` when a sweep stopped (§2.4.1, §2.4.2): nothing was evaluated;
  - `original-not-abandoned` when `requireAbandonedOriginal` found the original open, merged or not found (§2.12): nothing was listed, evaluated or closed;
  - otherwise `incomplete` when any suggestion is `failed` or `unverified`, or a targeted original is `unverified`: something could not be established; running again is safe;
  - otherwise `permission-limited` when any suggestion is `permission-limited`: someone with the right to close them can finish;
  - otherwise `complete`, including a dry run and a run with nothing to do.
- `markdown` says what was checked, how much, each original's state, each suggestion's result, that no branch is deleted, and, when relevant, that a rerun is safe or who can close the rest. Its form is shown in §3: a title naming the status (`complete`, `: dry run`, `limited by permissions`, `incomplete`), the scope (``Checked the open pull requests on `suggestion-pr/` branches in OWNER/REPO; the suggestion label is `LABEL` (SOURCE).`` for the default sweep, ``Checked the open pull requests labeled `LABEL` in OWNER/REPO (SOURCE).`` for a label sweep, ``Checked the pull requests that reference #N in OWNER/REPO; the suggestion label is `LABEL` (SOURCE).`` when targeted, where SOURCE is `the default suggestion label`, ``the suggestion label set in `.github/suggestion-prs.json` on `BRANCH` `` or `a label given in place of the repository's suggestion label`; followed by `Only suggestion pull requests opened by this account are closed.` or `Suggestion pull requests are closed whoever opened them.`), `Pull requests checked: N (L labeled, C conforming).` when any was, `Original pull requests:` with one line per original (`open`, `merged`, `closed without merging`, `not found (OWNER/REPO has no pull request #N that this account can read)`, `could not be verified (<reason>)`), `Suggestion pull requests:` with one line per result (`closed`; `would be closed`; `already closed`; `left open, because the original is still open`; `left open, because the original could not be verified`; `left open, not permitted to close it: <reason>`; `not closed, the close failed: <reason>` or `not closed, it could not be read again before closing: <reason>`; `skipped, not a conforming suggestion pull request: <reason>`; `left open, because someone else opened it`; ``skipped, it does not carry the label `<label>` ``), then the dry-run, rerun and permission notes that apply, and last `Closing never deletes a branch: each proposal branch is left in place.` A stopped sweep's Markdown is its title (`## Suggestion pull request cleanup stopped: too many candidates`, or `… stopped: the label does not mark suggestion pull requests`) and its diagnostic's message. A skipped guarded run's Markdown is its title, `## Suggestion pull request cleanup skipped: the original is not closed without merging`, and its note's message (§2.12).

It rejects with a `TypeError` for invalid input, and with an `Error` for an operational failure during discovery or the account read, or when the original of a guarded run cannot be read (§2.12); always before any write. Neither contains the token.

**CLI.** Human output is the Markdown on stdout, without what the diagnostics on stderr already say; a stopped sweep or a skipped guarded run prints its title and `Nothing was checked or closed.` JSON is one document: `{ command: 'close-suggestion-prs', status, dryRun, owner, originals, suggestions, counts, message, diagnostics }`.

| Exit status | Meaning |
| --- | --- |
| 0 | `complete` (also a dry run with nothing unverified, and a targeted original that does not exist); or `original-not-abandoned`: a guarded run skipped, nothing was checked (§2.12) |
| 2 | `permission-limited`: every other eligible suggestion was closed; or `label-not-suggestion-prs`: the label sweep stopped, nothing was checked (`--force` continues) |
| 3 | `incomplete`: a failed close or an unverified original; rerun later |
| 1 | `too-many-candidates`: the sweep stopped, nothing was checked; or a usage error, missing token, or an operational failure before any write (including a guarded run whose original could not be read, §2.12) |

### 2.11 What cleanup never does

Delete or update a branch; reopen, recreate, edit, label or comment on anything; wait, schedule or watch for anything (a guarded run's grace period belongs to its caller, §2.12); write to the original; close a pull request whose marker is missing, duplicated, non-canonical or for another repository or original; close a fork's pull request; close someone else's suggestion under `owner: 'me'`; infer a terminal state from a failed lookup; treat an unreadable repository configuration as absent; write the repository configuration; keep any local record; evaluate the candidates of a sweep over its limit, or of a label sweep stopped early.

### 2.12 Requiring an abandoned original (`requireAbandonedOriginal`, `--if-abandoned`)

The owner's [D54](design-decisions.md#d54-delay-optional-abandonment-cleanup-and-recheck-the-original--owner-selected-candidate-policy-workflow-experiment-pending) asks for optional cleanup when an original pull request is **abandoned**: closed without merging. [GH-02](github-behavior.md#gh-02--closing-the-original-without-merging-left-its-companion-open) shows why: closing an original without merging left its companion open. An automated trigger (the [example workflow](examples/abandonment-cleanup.md)) waits two minutes after the close, then runs targeted cleanup with this guard. The guard makes the decision on the tool's own fresh read of the original, never on the event that started the run. A brief close and reopen therefore skips: for example, one used to retrigger checks.

**Input.** `requireAbandonedOriginal: true` (`--if-abandoned`) applies only to targeted mode. Without `originalPullNumber` (`--original N`) it could change nothing, so it is invalid input: a `TypeError` (CLI: a usage error, exit 1) before any request (§2.2). `requireAbandonedOriginal: false` asks for nothing and is accepted. The guard combines with `label`, `owner` and `dryRun` as targeted cleanup does.

**Read first, then act.** A guarded run resolves the label exactly as targeted cleanup does (§2.2.1). That read also establishes that the repository exists, so an original's 404 stays definitive. It then reads the original, `GET /repos/{owner}/{repo}/pulls/{n}` (§2.7). This is the read targeted discovery makes before anything else (§2.4), made when the tool runs. Nothing is listed, classified or closed before it, and the account is not read. The answer decides the run:

| The original's fresh read (§2.7) | A guarded run |
| --- | --- |
| `closed` (`state: closed`, `merged: false`) | **Proceeds**: targeted cleanup, unchanged (§2.4–§2.10), with this read as the original's state; it is not read a second time. |
| `open`, including an original reopened after it was closed | **Skipped** |
| `merged` | **Skipped**: a merged original is closed but not abandoned |
| `not-found` (404) | **Skipped** |
| `unverified` (403, 401, 5xx, a network failure, a malformed answer) | **Operational failure**: the call rejects with an `Error` naming the original and the reason (CLI: exit 1, `operation-failed`, "Nothing was closed."). An unread original is never treated as abandoned, and never as not abandoned. |

**A skip is not a failure.** "The original is not abandoned" is a definitive answer for this run. A skipped run resolves with:

- status `original-not-abandoned` (CLI: exit 0);
- `originals` holding the one original and its state (`open`, `merged` or `not-found`);
- empty `suggestions`, and zero `counts`;
- one note, `original-pull-request-not-abandoned`, about `OWNER/REPO#N`, whose message names the state:
  - `#N is open, not closed without merging, so nothing was checked or closed.`
  - `#N was merged, not closed without merging, so nothing was checked or closed.`
  - `OWNER/REPO has no pull request #N that this account can read, so nothing was checked or closed.`

  Without the guard, the `not-found` case is a warning, `original-pull-request-not-found` (§2.4). Under the guard it is only the note.

The Markdown is the title `## Suggestion pull request cleanup skipped: the original is not closed without merging` and the note's message. The CLI's human report is the title and `Nothing was checked or closed.`, with the note on stderr. A dry run skips identically.

**What the guard keeps.** A run that proceeds is targeted cleanup, so every positive identification of §2.5–§2.8 still applies to each suggestion: the marker, the repository, the head branch, the label and the owner scope. Each suggestion is still read again before it is closed. The guard adds no write and no new kind of write. Cleanup still never deletes a branch, and never reopens, recreates or edits anything (§2.9, §2.11). In particular, the guard never reopens suggestions when an original is reopened, and never recreates proposals.

**The grace period belongs to the caller.** The library and the CLI never wait, schedule or watch. They read the original once, when they run. The two-minute delay is the workflow's (`sleep 120` in the example). A caller can choose another delay, or none.

**The window, and the accepted trade-off.** The guard narrows the race between a reopen and cleanup; it does not remove it. An original reopened after the guard's read can still have its suggestions closed in that run, as in §2.3. An original reopened much later does not reopen the suggestions cleanup already closed. Someone reopens them by hand. Closing is reversible: each suggestion's branch, commits, body and label are left untouched. The owner accepted this trade-off in D54.

**Repeat runs.** Running the guarded command again is safe. If the original is still closed without merging, the run proceeds: suggestions already closed are `already-closed`, and nothing more is written (§2.6 row 7). If the original was reopened or merged in the meantime, the run skips.

**Request cost.** The guard adds no request to targeted cleanup. Its read of the original is the one targeted discovery makes first (§2.4). A run that proceeds therefore costs exactly what targeted cleanup costs. A skipped run costs the label resolution and that one read: no listing, no account read, no write. Compared with trusting the event that triggered a workflow, the guard costs one extra read of the original, made when the tool runs.

#### 2.12.1 Acceptance examples

Each example uses `octo/widgets` with no repository configuration (label `suggestion-pr`), and #40, a conforming, labeled suggestion of #37 opened by this account.

1. **Closed and unmerged: cleanup proceeds.** #37 is closed without merging. Running `close-suggestion-prs --repo octo/widgets --original 37 --if-abandoned`:
   - reads #37 before the backlink listing;
   - lists #37's backlinks, reads #40 again, and closes it with one `PATCH`;
   - reports status `complete` and `- #37: closed without merging`, and exits 0.

   The outcome is identical to the same command without `--if-abandoned`.
2. **Reopened: skipped.** #37 was closed and then reopened, so it is open when the guard reads it. The run:
   - reports status `original-not-abandoned` and `originals` `[{ number: 37, state: 'open' }]`;
   - adds the note `#37 is open, not closed without merging, so nothing was checked or closed.`;
   - exits 0.

   No backlink listing, account read or write is made, and #40 stays open.
3. **Merged: skipped.** #37 was merged. The run is the same as example 2, with state `merged` and the note `#37 was merged, not closed without merging, so nothing was checked or closed.` Unguarded targeted cleanup would close #40 here.
4. **Not found: skipped.** `--original 99`, and GitHub answers 404 for #99. The run:
   - reports status `original-not-abandoned` and `originals` `[{ number: 99, state: 'not-found' }]`;
   - adds the note `octo/widgets has no pull request #99 that this account can read, so nothing was checked or closed.`, and no `original-pull-request-not-found` warning;
   - exits 0, with nothing listed or written.
5. **Read failure: nothing is closed.** The read of #37 answers HTTP 502 (or 403, or a malformed answer). The library rejects with an `Error` that begins `Pull request octo/widgets#37 could not be read (` and names the reason. The CLI exits 1, with `operation-failed` on stderr and `Nothing was closed.` on stdout. Nothing is listed or written.
6. **Without `--original`: usage error.** `--if-abandoned` without `--original` is a usage error (exit 1) naming `--original`, and no request is made. The library raises the corresponding `TypeError`.
7. **Dry run.** With `--dry-run`, a closed, unmerged #37 makes the same reads as example 1 and reports #40 `would-close`; nothing is written. An open #37 skips exactly as in example 2.
8. **Repeat run.** After example 1, running the same command again reads #37 (still closed without merging), proceeds, and reports #40 `already-closed`. Nothing more is written.

## 3. Worked example

`octo/widgets` has no `.github/suggestion-prs.json`, so its canonical label is `suggestion-pr`. The account running cleanup opened the labeled suggestions #40 (marker original #37, branch `suggestion-pr/37/<id>`) and #38, #39 (marker original #36). #37 was closed without merging; #36 is open; one more labeled pull request, #41, was opened by hand on the branch `suggestion-pr/37/by-hand` and has no marker.

`close-suggestion-prs --repo octo/widgets --dry-run`: four branches under `suggestion-pr/`, one listing request; originals #36 `open` and #37 `closed`; #38 and #39 `left-open`, #40 `would-close`, #41 `not-conforming`; counts 4 candidates, 4 checked, 4 labeled, 3 conforming; status `complete`, exit 0, no write. The Markdown:

```markdown
## Suggestion pull request cleanup: dry run

Checked the open pull requests on `suggestion-pr/` branches in octo/widgets; the suggestion label is `suggestion-pr` (the default suggestion label). Only suggestion pull requests opened by this account are closed.

Pull requests checked: 4 (4 labeled, 3 conforming).

Original pull requests:

- #36: open
- #37: closed without merging

Suggestion pull requests:

- #38 (for #36): left open, because the original is still open
- #39 (for #36): left open, because the original is still open
- #40 (for #37): would be closed
- #41: skipped, not a conforming suggestion pull request: its branch is under `suggestion-pr/`, but it has no suggestion marker

This was a dry run: nothing was closed.

Closing never deletes a branch: each proposal branch is left in place.
```

Without `--dry-run`, #40 is `closed`: one `PATCH`, and its branch `suggestion-pr/37/<id>` still exists. The title is `## Suggestion pull request cleanup complete`, #40's line reads `- #40 (for #37): closed`, and there is no dry-run note. A rerun still counts #40's branch but no longer lists #40 (it is not open): #38 and #39 `left-open`, exit 0. `--original 37` then finds #40 through #37's backlinks and reports it `already-closed`.

Had a colleague opened #40, it would be `other-owner` and left open, and #37 would not be read; `--owner all` would close it. `--label bug` on a repository whose first 20 open `bug` pull requests are ordinary work stops after one request with `label-not-suggestion-prs` (exit 2), however many there are; with `--force`, 600 of them stop after one request with `too-many-candidates` (exit 1). A repository with 501 branches under `suggestion-pr/` stops after one request with `too-many-candidates` (exit 1) unless `--max-candidates` allows it.

## 4. Decisions

Decided by the owner on September 29, 2026 (the review of #5, #6 and #24 recorded on [#27](https://github.com/mike-north/sarif-to-comment/issues/27), [D41](design-decisions.md#d41-the-suggestion-pull-request-convention-and-options--owner-decisions)):

- **Label resolution** (§2.2.1): the repository configuration's `label`, otherwise `suggestion-pr`, resolved identically by `publish`, `validate` and `close-suggestion-prs`; an invalid configuration makes cleanup refuse; a failed read is operational, never a silent default.
- **`label` / `--label` as a migration override only** (§2.2), for sweeping suggestions left under a previously configured label.
- **Conforming pull requests** (§2.5–§2.8): cleanup acts on any suggestion pull request that conforms to the [convention](suggestion-pr-convention.md), keeping all of the existing strict verification: the names (`closeSuggestionPullRequests` / `close-suggestion-prs`, `originalPullNumber` / `--original`), targeted discovery, strict canonical markers, one read per original, a fresh read of each suggestion before closing, the head branch bound to the marker, and the statuses.
- **Closing only** (§2.9, §2.11): cleanup closes pull requests and never deletes a branch; branch removal is left to people or to GitHub's automatic deletion of merged branches.
- **Commas refused in labels** (§2.2), here and in every suggestion label.

Decided by the owner on September 30, 2026 ([#44](https://github.com/mike-north/sarif-to-comment/issues/44), [D47](design-decisions.md#d47-scope-cleanup-by-who-opened-the-suggestion-and-bound-its-discovery--owner-decisions)), before 0.3.0:

- **Closing by default, with `dryRun` / `--dry-run`** (§2.3), as implemented.
- **The exit codes** (§2.10): 0 / 2 / 3 / 1 for `complete` / `permission-limited` / `incomplete` / usage or operational failure; a stopped label sweep is 2 and a sweep over its limit is 1.
- **A 404 on close is permission-limited** (§2.9): the pull request was just read, so the account can see it but may not close it.
- **An override skips the configuration** (§2.2.1): `--label` is a migration override and the repository configuration is not read.
- **The owner scope** (§2.2, §2.6): `owner: 'me' | 'all'` (`--owner`), default `me`, about who opened the suggestion pull request; `other-owner` for a conforming suggestion someone else opened. This replaces the provisional "no author check".
- **`not-ours` is renamed `not-conforming`** (§2.10), and the counts are reported.
- **Bounded discovery** (§2.4): the default sweep discovers by the convention's branch prefix, with the canonical label as a confirming check; a sweep counts first and stops over `maxCandidates` (default 500, `--max-candidates`); a label sweep whose first 20 pull requests show no suggestion pull request stops with `label-not-suggestion-prs` unless `force` (`--force`).

Settled in engineering after the implementation review of #44, within D47:

- **Options that would change nothing are refused** (§2.2): `force` outside a label sweep and `maxCandidates` with `originalPullNumber` are usage errors (library: `TypeError`), never silently ignored.
- **The early exit comes before the limit** (§2.4.1, §2.4.2): a wrong broad label is `label-not-suggestion-prs`, not `too-many-candidates`; `force` lifts only the early exit; either refusal still costs one request.
- **The count is unchanged** (§2.4.1): it is GitHub's total of `suggestion-pr/` branches in the first request, including those of closed suggestions, documented as a known limitation with `--max-candidates` as the remedy; the early exit's evidence is unchanged as well.

Decided by the owner on September 30, 2026 ([D54](design-decisions.md#d54-delay-optional-abandonment-cleanup-and-recheck-the-original--owner-selected-candidate-policy-workflow-experiment-pending)), implemented October 1, 2026 (§2.12):

- **Optional abandonment cleanup**: wait two minutes, then freshly confirm that the exact original is still closed and unmerged, then use the established discovery and cleanup. A brief close and reopen skips. Reopening companions by hand after a much later reopen is an accepted trade-off. Nothing infers branch deletion, or the automatic recreation or reopening of proposals.

Settled in engineering when implementing D54 (the realignment plan's EC8):

- **The names** `requireAbandonedOriginal` / `--if-abandoned`, a boolean that requires `originalPullNumber` / `--original`.
- **A skip has its own status**, `original-not-abandoned` (exit 0), and one note, `original-pull-request-not-abandoned`, so that a caller can tell a skip from a cleanup that ran.
- **An unreadable original makes a guarded run fail operationally** (exit 1), rather than end `incomplete` (exit 3) as unguarded targeted cleanup does. The guard exists to decide whether to act, and an unknown answer cannot decide it.
- **The guard's read is targeted discovery's own read** of the original. It is not a second read, so it adds no request.
- **The delay lives in the workflow**, which is shipped as an example under `docs/examples/`, never installed. Running it live on GitHub (the realignment plan's E7) needs the owner's authority to install a workflow in a fixture repository's branch ([evidence](evidence/abandonment-cleanup/README.md#the-remaining-obstacle-a-live-workflow-run)).

Open questions for the owner, raised by implementing #44:

1. **The early exit's evidence** (§2.4.2): a malformed marker line or a `suggestion-pr/` branch on the first page counts as looking like a suggestion, so a label on a single abandoned, hand-opened suggestion branch lets a broad sweep continue up to its limit. The alternative is to require a recognized marker.
2. **Branches with many open pull requests** (§2.4): more than 10 open pull requests from one suggestion branch stops the sweep as an operational error rather than reading them all. A suggestion branch has one open pull request under the convention.

## 5. Verification

| Requirement | Tests | [Live evidence](suggestion-cleanup-e2e-evidence.md) |
| --- | --- | --- |
| Open, merged, closed-unmerged and inaccessible originals (A36) | `test/cleanup-composition.test.mts` | open and closed-unmerged with suggestions; merged, closed and missing originals probed read-only |
| Pagination, duplicate references, title changes (A31) | `test/cleanup-composition.test.mts`, `test/github-cleanup.test.mts` | single page only |
| Owner scope, branch-prefix discovery, the candidate limit, the early exit before the limit, `--force` bypassing only the early exit, options that would change nothing refused, `--dry-run` with each, counts, and a broad label refused after one request (#44) | `test/cleanup-scope.test.mts`, `test/github-cleanup.test.mts`, `test/installed-cleanup.test.mts` | [dry runs of October 1, 2026](suggestion-cleanup-e2e-evidence.md#october-1-2026-owner-scope-and-bounded-discovery-44): a wrong label refused early (exit 2, nothing checked); `--owner all` accepted and reported; the default sweep first counted 18 branches but found none of their 17 open pull requests, a defect, [diagnosed and fixed](suggestion-cleanup-e2e-evidence.md#the-default-sweeps-defect-diagnosed-and-fixed): after the fix the default and `--owner all` sweeps found and classified all 17, as the label sweep did; one account and no limit reached |
| Permission-limited apart from failed; no completion inferred from a failed lookup; a missing original is definitive (`not-found`), never retried | `test/cleanup-composition.test.mts`, `test/github-cleanup.test.mts` | missing original probed read-only (reported `unverified`, exit 3, before a 404 was made definitive) |
| Already-closed suggestions tolerated | `test/cleanup-composition.test.mts` | sweep and targeted reruns |
| Targeted discovery, dry run | `test/cleanup-composition.test.mts` | targeted and dry runs |
| Commas refused in labels | `test/cleanup-composition.test.mts`, `test/companion-composition.test.mts`, `test/github-cleanup.test.mts` | |
| Canonical label from the repository configuration, `--label` migration override, conforming pull requests of any tool (#27) | `test/suggestion-pr-convention.test.mts`, `test/cleanup-composition.test.mts` | [convention evidence](suggestion-pr-convention-e2e-evidence.md): default label only (the default branch is never modified) |
| Marker recognition | `test/suggestion-marker.test.mts` | the [convention evidence](suggestion-pr-convention-e2e-evidence.md) |
| Public types | `test/close-suggestion-pull-requests.types.mts` | |
| CLI and library through the installed package | `test/installed-cleanup.test.mts`, `test/cli-commands.test.mts` | |
| Diagnostics of cleanup | `test/diagnostics-outcomes.test.mts`, `test/cli-human-reports.test.mts` | |
| Requiring an abandoned original (§2.12, D54): every original state, the usage error, an unreadable original, and the original read before any listing | `test/cleanup-abandonment.test.mts`, `test/installed-cleanup.test.mts`, `test/close-suggestion-pull-requests.types.mts` | [dry runs of October 1, 2026](evidence/abandonment-cleanup/README.md): an open original skipped; a closed, unmerged original proceeded; a merged and a missing original skipped. No workflow was run. |
| The example workflow parses, has the documented trigger, condition, delay, permissions and token, and runs a command the CLI's help documents | `test/abandonment-workflow-example.test.mts` | not run on GitHub (E7; [evidence](evidence/abandonment-cleanup/README.md#the-remaining-obstacle-a-live-workflow-run)) |
