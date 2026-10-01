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

Recorded October 1, 2026 (01:24–01:28 UTC) in `mike-north/doc-linter`, for the acceptance criteria of [#44](https://github.com/mike-north/sarif-to-comment/issues/44): a sweep, an `--owner all` sweep, and a wrong `--label` refused early. The package was built (`pnpm run build`) from commit `5e478b9`, unreleased, and run from the working tree. Every run passed `--dry-run`: **nothing was closed, labeled or otherwise written**, so closing itself was not exercised here; the September 29 runs above cover it. The token was the maintainer's personal one, passed to each command inline and never stored. Exit statuses are in [`exit-statuses-2026-10-01.txt`](evidence/suggestion-cleanup/exit-statuses-2026-10-01.txt).

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

1. **Default sweep** ([`18`](evidence/suggestion-cleanup/18-sweep-dry-run.json), human [`19`](evidence/suggestion-cleanup/19-sweep-dry-run.md)): exit 0, `complete`, `owner: "me"`, `counts` `{ candidates: 18, checked: 0, labeled: 0, conforming: 0 }`, "No suggestion pull requests were found.", no diagnostics. The count of 18 branches is right; **the 17 open pull requests on those branches were not found**. The contract makes every open pull request on a suggestion branch a candidate (§2.4), so this contradicts it: a defect, not yet diagnosed.
2. **`--owner all`** ([`20`](evidence/suggestion-cleanup/20-sweep-owner-all-dry-run.json), human [`21`](evidence/suggestion-cleanup/21-sweep-owner-all-dry-run.md)): the same, with `owner: "all"` and the scope line "Suggestion pull requests are closed whoever opened them." in place of "Only suggestion pull requests opened by this account are closed." The option is accepted and reported; with nothing found, and one account behind every pull request, it decides nothing here.
3. **Wrong label, `--label suggestion`** ([`22`](evidence/suggestion-cleanup/22-label-suggestion-dry-run.json), human [`23`](evidence/suggestion-cleanup/23-label-suggestion-dry-run.md) with its [stderr](evidence/suggestion-cleanup/23-label-suggestion-dry-run.stderr.txt)): exit 2, `label-not-suggestion-prs`, `counts` `{ candidates: 2, checked: 0, labeled: 0, conforming: 0 }`, one warning `label-not-suggestion-prs` naming the label and the 2 pull requests inspected, with remedies to check the label or to run again with `--force`, and "nothing was checked or closed". No pull request was classified and no original was resolved, as §2.4.2 requires. The human form prints the stop on stdout and the diagnostic on stderr.
4. **Contrast, `--label suggestion-pr`** ([`24`](evidence/suggestion-cleanup/24-label-suggestion-pr-dry-run.json)), run to locate the defect in 1: exit 0, `complete`, `counts` `{ candidates: 17, checked: 17, labeled: 17, conforming: 17 }`; the originals #56, #60–#64, #75 and #82–#84 all resolved `open`, so all 17 suggestions were `left-open`. A label sweep finds and classifies the same pull requests the branch sweep missed, so the classification, the owner check (the account opened all 17) and the outcome are sound; the fault is confined to listing the pull requests of the `suggestion-pr/` branches.

### What this does not show

- **The default sweep's discovery, which is defective** (run 1). Its count is right and its outcome is well formed, but it found none of the open pull requests on suggestion branches. Until that is fixed, this record shows only that the default sweep counts and reports, not that it finds suggestions.
- **Owner scope with another account.** Every pull request in the fixture was opened by the same account, so `other-owner` cannot arise; it is covered only by `test/cleanup-scope.test.mts`.
- **The candidate limit.** 18 branches and 2 labeled pull requests are far below the default limit of 500, so `too-many-candidates` was not reached live, and neither was a wrong label carried by more than 20 pull requests or a forced label sweep.
- **The early exit against an ordinary label.** No ordinary open pull request carries a label, so the early exit was exercised with a label carried only by pre-convention suggestion pull requests. It shows the decision is made from the listing alone; what makes a label ordinary does not enter it.
- **Request counts.** The runs did not log requests, so "refused after one request" rests on the observed outcome (nothing classified, no original resolved) and on the tests, not on a live request log.
- **Closing.** Every run was a dry run.
