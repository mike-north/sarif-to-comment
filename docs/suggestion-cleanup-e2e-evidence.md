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

## Live artifacts touched

| Artifact | Change | By |
| --- | --- | --- |
| [#37](https://github.com/mike-north/doc-linter/pull/37) (synthetic original fixture) | closed, not merged; branch kept | `gh pr close`, to create the closed-original case |
| [#40](https://github.com/mike-north/doc-linter/pull/40) (its suggestion) | closed, not merged; branch, label and body kept | the cleanup run in step 5 |

Nothing else was changed. #36, #38 and #39 remain open for later experiments.

## What this does not show

These runs used one account that may close every pull request in the repository, a single page of labeled pull requests and short timelines. Multi-page listings and timelines, duplicate references, title changes, merged originals with an open suggestion, permission-limited and rate-limited closes, lost close responses and the race between listing and verification are covered only by the fake host (`test/cleanup-composition.test.mts`, `test/github-cleanup.test.mts`), which models documented GitHub behavior. A permission-limited close needs a second identity, which the fixture repository does not have.
