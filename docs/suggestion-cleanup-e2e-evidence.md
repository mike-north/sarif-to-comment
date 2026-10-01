# Suggestion pull request cleanup: live GitHub evidence

Recorded September 29, 2026 (15:15–15:17 UTC) in the private fixture repository `mike-north/doc-linter`, against the implementation of the [suggestion cleanup contract](suggestion-cleanup-contract.md) ([#6](https://github.com/mike-north/sarif-to-comment/issues/6)). The built package ran from the working tree (`node dist/sarif-to-comment.cjs close-suggestion-prs`) with the maintainer's personal token. Nothing was published to npm, nothing was merged, no branch was created, moved or deleted, and the repository's `main` branch was not touched. Sanitized outputs are in [`evidence/suggestion-cleanup/`](evidence/suggestion-cleanup/); raw logs stayed in the maintainer's uncommitted working-log directory.

## Fixtures

The live artifacts of the [companion suggestion pull request evidence](companion-suggestion-pr-e2e-evidence.md) were reused; nothing new was created.

| Object | Identity | Before |
| --- | --- | --- |
| Original A | [#36](https://github.com/mike-north/doc-linter/pull/36), head `sarif-issue5-20260929-reviewed` | open draft |
| Original B (synthetic fixture) | [#37](https://github.com/mike-north/doc-linter/pull/37), head `sarif-issue5-20260929-recovery` | open draft |
| Suggestions of A | [#38](https://github.com/mike-north/doc-linter/pull/38), [#39](https://github.com/mike-north/doc-linter/pull/39) | open drafts, labeled `suggestion` |
| Suggestion of B | [#40](https://github.com/mike-north/doc-linter/pull/40) | open draft, labeled `suggestion` |
| Read-only probes | merged [#5](https://github.com/mike-north/doc-linter/pull/5) and closed [#10](https://github.com/mike-north/doc-linter/pull/10), earlier lifecycle experiments | unchanged |

The pull request states and every branch head were recorded first ([`01-before-pull-requests.jsonl`](evidence/suggestion-cleanup/01-before-pull-requests.jsonl), [`02-before-branches.txt`](evidence/suggestion-cleanup/02-before-branches.txt)).

## Runs

Exit statuses are in [`exit-statuses.txt`](evidence/suggestion-cleanup/exit-statuses.txt); every run wrote nothing to stderr.

1. **Sweep dry run, both originals open** ([`03`](evidence/suggestion-cleanup/03-sweep-dry-run-originals-open.json)): exit 0, `complete`. The labeled listing found #38, #39 and #40; their markers named #36 and #37, both resolved `open`, so all three were `left-open`. No write.
2. **Targeted dry runs** (read-only): `--original 36` found #38 and #39 through #36's cross-reference backlinks, `left-open` ([`04`](evidence/suggestion-cleanup/04-original-36-dry-run.json)). `--original 5` resolved #5 as `merged` and reported its labeled experiment suggestion #6, which has no marker, as `not-ours` ([`05`](evidence/suggestion-cleanup/05-original-5-merged-dry-run.json)). `--original 10` resolved #10 as `closed` and reported its labeled experiment suggestion #11, which carries only the earlier recovery experiment's own marker (`sarif-recovery-experiment:…`), as `not-ours` ([`06`](evidence/suggestion-cleanup/06-original-10-closed-dry-run.json)). `--original 9999` got GitHub's 404 and reported the original `unverified`, read nothing else, and exited 3, `incomplete` ([`07`](evidence/suggestion-cleanup/07-original-9999-inaccessible-dry-run.json)). Merged and closed originals were thus resolved live, and an inaccessible original was never treated as ended; none of these probes had an open suggestion to close.
3. **The original ends**: `gh pr close 37` closed the synthetic original without merging and without deleting its branch ([`08`](evidence/suggestion-cleanup/08-original-37-closed-unmerged.json): `CLOSED`, `mergedAt: null`).
4. **Sweep dry run** ([`09`](evidence/suggestion-cleanup/09-sweep-dry-run-after-close.md), human output): exit 0; #37 `closed without merging`, #40 `would be closed`, #38 and #39 left open. The three suggestions were still open afterwards.
5. **Cleanup** ([`10`](evidence/suggestion-cleanup/10-sweep-cleanup.json)): exit 0, `complete`: #40 `closed`; #38 and #39 `left-open`.
6. **Read-back** ([`11`](evidence/suggestion-cleanup/11-after-pull-requests.jsonl), [`12`](evidence/suggestion-cleanup/12-after-branches.txt)): `gh pr view` shows #40 `CLOSED` with `mergedAt: null`, still labeled and still a draft; #36, #38 and #39 `OPEN`; #37 as closed in step 3. Every branch head, including #40's `sarif-to-comment/suggestions/37/d692636b-…` at `ff055e3…` and #37's own head, is byte-identical to the record taken before (`diff` of the two `git ls-remote` listings is empty).
7. **Idempotence**: the sweep again ([`13`](evidence/suggestion-cleanup/13-sweep-rerun.json)) no longer lists #40 and reports #38 and #39 `left-open`, exit 0, no write. `--original 37` ([`14`](evidence/suggestion-cleanup/14-original-37-rerun.json)) finds #40 through the backlinks and reports it `already-closed`, exit 0. `--original 36` in human form ([`15`](evidence/suggestion-cleanup/15-original-36.md)) leaves #38 and #39 open.

The `not-ours` result in these runs was renamed `not-conforming` before the first release ([#44](https://github.com/mike-north/sarif-to-comment/issues/44)); the files above keep the name they were recorded with.

## Live artifacts touched

| Artifact | Change | By |
| --- | --- | --- |
| [#37](https://github.com/mike-north/doc-linter/pull/37) (synthetic original fixture) | closed, not merged; branch kept | `gh pr close`, to create the closed-original case |
| [#40](https://github.com/mike-north/doc-linter/pull/40) (its suggestion) | closed, not merged; branch, label and body kept | the cleanup run in step 5 |

Nothing else was changed. #36, #38 and #39 remain open for later experiments.

## What this does not show

These runs used one account that may close every pull request in the repository, a single page of labeled pull requests and short timelines. Multi-page listings and timelines, duplicate references, title changes, merged originals with an open suggestion, permission-limited and rate-limited closes, lost close responses and the race between listing and verification are covered only by the fake host (`test/cleanup-composition.test.mts`, `test/github-cleanup.test.mts`), which models documented GitHub behavior. A permission-limited close needs a second identity, which the fixture repository does not have.

## October 1, 2026: owner scope and bounded discovery (#44)

Recorded October 1, 2026 (01:24–01:28 UTC) in `mike-north/doc-linter`, for the acceptance criteria of [#44](https://github.com/mike-north/sarif-to-comment/issues/44): a sweep, an `--owner all` sweep, and a wrong `--label` refused early. The package was built (`pnpm run build`) from this change before its default-sweep fix (commit `57693bc` on this branch; `5e478b9` before a rebase), unreleased, and run from the working tree; the runs after the fix of the default sweep's defect ([below](#the-default-sweeps-defect-diagnosed-and-fixed): diagnosed 01:33–01:55 UTC, rerun at 02:02 UTC) were built from the fix (commit `bd71c78` on this branch; `cd304ce` before a rebase). Every run passed `--dry-run`: **nothing was closed, labeled or otherwise written**, so closing itself was not exercised here; the September 29 runs above cover it. The token was the maintainer's personal one, passed to each command inline and never stored. Exit statuses are in [`exit-statuses-2026-10-01.txt`](evidence/suggestion-cleanup/exit-statuses-2026-10-01.txt).

```sh
GH_TOKEN=… node dist/sarif-to-comment.cjs close-suggestion-prs --repo mike-north/doc-linter --dry-run [--format json]
GH_TOKEN=… node dist/sarif-to-comment.cjs close-suggestion-prs --repo mike-north/doc-linter --owner all --dry-run [--format json]
GH_TOKEN=… node dist/sarif-to-comment.cjs close-suggestion-prs --repo mike-north/doc-linter --label suggestion --dry-run [--format json]
GH_TOKEN=… node dist/sarif-to-comment.cjs close-suggestion-prs --repo mike-north/doc-linter --label suggestion-pr --dry-run --format json
```

### The state read

Read with `gh label list` and `gh pr list` only ([`16`](evidence/suggestion-cleanup/16-labels.tsv), [`17`](evidence/suggestion-cleanup/17-open-pull-requests.jsonl)), before and after the runs, unchanged:

- 70 open pull requests, all opened by the one account, none from a fork. No configuration file sets a label, so the canonical label is the default `suggestion-pr`.
- 18 branches under `suggestion-pr/`; 17 of them head an open pull request (#58, #65–#73, #78, #86–#91), each labeled `suggestion-pr` with exactly one `<!-- suggestion-pr ` marker line. The 18th belongs to #59, closed.
- Of the repository's 12 labels, only three are on any open pull request: `suggestion-pr` (17), `documentation` (4, all of them among those 17 suggestions) and `suggestion` (2). **No label is on an ordinary open pull request**, so no ordinary label could exercise the early exit. `suggestion` was used instead: its two open pull requests, #38 and #39, predate the convention, with a `sarif-to-comment/suggestions/` head branch and a `<!-- sarif-to-comment:suggestion …` marker, so neither shows a suggestion pull request as the convention defines one.

### Observed

1. **Default sweep** ([`18`](evidence/suggestion-cleanup/18-sweep-dry-run.json), human [`19`](evidence/suggestion-cleanup/19-sweep-dry-run.md)): exit 0, `complete`, `owner: "me"`, `counts` `{ candidates: 18, checked: 0, labeled: 0, conforming: 0 }`, "No suggestion pull requests were found.", no diagnostics. The count of 18 branches is right; **the 17 open pull requests on those branches were not found**. The contract makes every open pull request on a suggestion branch a candidate (§2.4), so this contradicts it: a defect, [diagnosed and fixed below](#the-default-sweeps-defect-diagnosed-and-fixed). This record of the defective run is kept as it was observed.
2. **`--owner all`** ([`20`](evidence/suggestion-cleanup/20-sweep-owner-all-dry-run.json), human [`21`](evidence/suggestion-cleanup/21-sweep-owner-all-dry-run.md)): the same, with `owner: "all"` and the scope line "Suggestion pull requests are closed whoever opened them." in place of "Only suggestion pull requests opened by this account are closed." The option is accepted and reported; with nothing found, and one account behind every pull request, it decides nothing here.
3. **Wrong label, `--label suggestion`** ([`22`](evidence/suggestion-cleanup/22-label-suggestion-dry-run.json), human [`23`](evidence/suggestion-cleanup/23-label-suggestion-dry-run.md) with its [stderr](evidence/suggestion-cleanup/23-label-suggestion-dry-run.stderr.txt)): exit 2, `label-not-suggestion-prs`, `counts` `{ candidates: 2, checked: 0, labeled: 0, conforming: 0 }`, one warning `label-not-suggestion-prs` naming the label and the 2 pull requests inspected, with remedies to check the label or to run again with `--force`, and "nothing was checked or closed". No pull request was classified and no original was resolved, as §2.4.2 requires. The human form prints the stop on stdout and the diagnostic on stderr.
4. **Contrast, `--label suggestion-pr`** ([`24`](evidence/suggestion-cleanup/24-label-suggestion-pr-dry-run.json)), run to locate the defect in 1: exit 0, `complete`, `counts` `{ candidates: 17, checked: 17, labeled: 17, conforming: 17 }`; the originals #56, #60–#64, #75 and #82–#84 all resolved `open`, so all 17 suggestions were `left-open`. A label sweep finds and classifies the same pull requests the branch sweep missed, so the classification, the owner check (the account opened all 17) and the outcome are sound; the fault is confined to listing the pull requests of the `suggestion-pr/` branches.

### The default sweep's defect, diagnosed and fixed

**Diagnosis**, by read-only GraphQL queries against `mike-north/doc-linter` with `gh api graphql` (each file records the query, its variables and GitHub's answer):

- [`25`](evidence/suggestion-cleanup/25-branch-prefix-query-as-sent.json): the query the client sent, with its variables, exactly. GitHub answered the 18 branches with `totalCount: 18`, and **every `associatedPullRequests` empty**. Each `name` was relative to the prefix (`56/bb3b8acd-…`, not `suggestion-pr/56/bb3b8acd-…`). The client parsed the answer correctly: there was nothing in it to discover.
- [`26`](evidence/suggestion-cleanup/26-branch-prefix-query-any-state.json): the same listing without `states: OPEN`: still no associated pull request of any state, so the state filter is not the cause. Each ref's `prefix` is `refs/heads/suggestion-pr/`.
- [`27`](evidence/suggestion-cleanup/27-heads-prefix-name-filter.json): the same 18 branches listed under `refs/heads/`, narrowed by the name filter `query: "suggestion-pr/"`: full names, and each of the 17 branches with an open pull request answers it (the 18th, `suggestion-pr/57/…`, belongs to #59, closed).
- [`28`](evidence/suggestion-cleanup/28-qualified-ref-and-pull-58.json): one suggestion branch looked up by its qualified name answers #58, whose head it is.
- [`29`](evidence/suggestion-cleanup/29-associated-head-not-base.json): `associatedPullRequests` relates pull requests by **head**, not base: the base branch of #58 answers #56, its own pull request, not #58. And the fault is not specific to suggestion branches: `delivery/00-ci-validation` answers its pull request #21 when listed under `refs/heads/` and none when listed under `refs/heads/delivery/`.

**Root cause:** GitHub answers no associated pull request for a ref listed under a `refPrefix` deeper than `refs/heads/`. The client listed `refs(refPrefix: "refs/heads/suggestion-pr/")` and read each ref's `associatedPullRequests`, so it counted every suggestion branch and discovered none of their pull requests. (This is consistent with GitHub relating a listed ref by its name relative to the prefix, which names no branch; only the observed behavior is relied on.) The fake GitHub host of the tests answered the deeper listing with the branches' pull requests, which GitHub does not, so the tests could not show the defect.

**The alternatives, measured:**

- [`30`](evidence/suggestion-cleanup/30-ref-name-filter-semantics.json), [`31`](evidence/suggestion-cleanup/31-ref-name-filter-anchors-and-paging.json): the `refs` name filter (`query`) is a substring match on the name relative to `refPrefix`, ignoring case (`uggestion-pr/` and `SUGGESTION-PR/` match the 18; `suggestion` matches 25, among them `codex/…-suggestion-…` and `sarif-to-comment/suggestions/…` branches), never fuzzy and never anchored (`^suggestion-pr/`, `suggestion-pr/*` and `refs/heads/suggestion-pr/` match nothing). A filtered listing pages by cursor.
- [`32`](evidence/suggestion-cleanup/32-search-head-prefix.json): the issue search `is:pr is:open head:suggestion-pr/` answered the 17. Not chosen: the search index lags behind writes, has its own rate limit, and counts pull requests, not branches (the contract already excludes search, §2.4).
- [`33`](evidence/suggestion-cleanup/33-open-pull-requests.json): all 70 open pull requests, to filter by head branch client-side. Not chosen: the cost scales with the repository, which D47 excludes.
- A query per branch (`pullRequests(headRefName:)`) was not chosen: one request per branch instead of one per 100.

**Fix** (commit `bd71c78`, with the regression test in `48cb71e`; `cd304ce` and `5e95c43` before a rebase): the sweep lists the branches under `refs/heads/` narrowed by the name filter, where each ref answers its open pull requests, and leaves out a listed branch whose name does not start with `suggestion-pr/` before reading anything about it. The same request counts the branches under `suggestion-pr/` exactly, with a second connection, `refs(refPrefix: "refs/heads/suggestion-pr/", first: 0) { totalCount }`. [`34`](evidence/suggestion-cleanup/34-fixed-branch-query.json) is the fixed query, run read-only: `branchCount` 18, and the 17 open pull requests on their branches. The request count is unchanged: one listing request per 100 branches the filter lists, the count in the first, and a refused sweep still one request. The fake host now answers ref listings as GitHub does above, and the regression test (`test/cleanup-scope.test.mts`, "live defect of October 1, 2026") fails against the previous client.

**After the fix** (dry runs, built from the fix, commit `bd71c78`):

```sh
GH_TOKEN=… node dist/sarif-to-comment.cjs close-suggestion-prs --repo mike-north/doc-linter --dry-run [--format json]
GH_TOKEN=… node dist/sarif-to-comment.cjs close-suggestion-prs --repo mike-north/doc-linter --owner all --dry-run --format json
```

5. **Default sweep** ([`35`](evidence/suggestion-cleanup/35-sweep-dry-run-fixed.json), human [`36`](evidence/suggestion-cleanup/36-sweep-dry-run-fixed.md)): exit 0, `complete`, `owner: "me"`, `counts` `{ candidates: 18, checked: 17, labeled: 17, conforming: 17 }`, no diagnostics. The originals #56, #60–#64, #75 and #82–#84 resolved `open`, and all 17 suggestions (#58, #65–#73, #78, #86–#91) were `left-open`: the same originals and suggestions, with the same results, as the label sweep of run 4. `candidates` is 18 because the default sweep counts branches, the 18th being #59's, closed.
6. **`--owner all`** ([`37`](evidence/suggestion-cleanup/37-sweep-owner-all-dry-run-fixed.json)): the same, with `owner: "all"`.

Read afterwards with `gh pr list`: still 70 open pull requests, the same 17 on `suggestion-pr/` branches.

### What this does not show

- **Closing by the default sweep.** Every original of the 17 suggestions is open, so the fixed sweep left them all open: it discovered and classified them, but closed none. Closing is covered by the September 29 runs above (by label) and by the tests.
- **A branch outside `suggestion-pr/` that the name filter lists.** doc-linter has none, so leaving one out is covered only by `test/cleanup-scope.test.mts` and `test/github-cleanup.test.mts`.
- **Owner scope with another account.** Every pull request in the fixture was opened by the same account, so `other-owner` cannot arise; it is covered only by `test/cleanup-scope.test.mts`.
- **The candidate limit.** 18 branches and 2 labeled pull requests are far below the default limit of 500, so `too-many-candidates` was not reached live, and neither was a wrong label carried by more than 20 pull requests or a forced label sweep.
- **The early exit against an ordinary label.** No ordinary open pull request carries a label, so the early exit was exercised with a label carried only by pre-convention suggestion pull requests. It shows the decision is made from the listing alone; what makes a label ordinary does not enter it.
- **Request counts.** The runs did not log requests, so "refused after one request" rests on the observed outcome (nothing classified, no original resolved) and on the tests, not on a live request log.
- **Closing.** Every run was a dry run.
