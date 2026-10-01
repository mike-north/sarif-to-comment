# Companion suggestion pull requests: live GitHub evidence

Recorded September 29, 2026 in the private fixture repository `mike-north/doc-linter`, against the implementation of the [companion suggestion PR contract](companion-suggestion-pr-contract.md) ([#5](https://github.com/mike-north/sarif-to-comment/issues/5)). The built package ran from the working tree (`node dist/sarif-to-comment.cjs`, and for the recovery case a Node script importing the built modules). Nothing was published to npm, nothing was merged, and the repository's `main` branch was not touched. Sanitized outputs are in [`evidence/companion-suggestion-pr/`](evidence/companion-suggestion-pr/); raw logs stayed in the maintainer's uncommitted working-log directory, written `<working-logs>` below.

> These runs predate [#29](https://github.com/mike-north/sarif-to-comment/issues/29): the group property they show, `acceptanceGroup`, and its problem codes `acceptance-group-*` were renamed to `suggestionGroup` and `suggestion-group-*` before any release. The recorded outputs are kept as they were; see the [grouping evidence](group-fixes-e2e-evidence.md) for the current names.

## Fixtures

| Object | Identity |
| --- | --- |
| Fixture base branch | `sarif-issue5-20260929-base`, at `main`'s `0a7b03fe399255a62118311cbc3e1bd6fe64cb23` (no new commit) |
| Reviewed branch (case A) | `sarif-issue5-20260929-reviewed`, head `89bf101d454c10d98df84e504c05494e9627375b`, adding `docs/experiments/sarif-issue5/client.md` and `obsolete.md` |
| Recovery branch (case B) | `sarif-issue5-20260929-recovery`, head `83b57cf731f0026f993691ff11ba48b42a674753`, adding `docs/experiments/sarif-issue5/recovery.md` |
| Original pull request A | [#36](https://github.com/mike-north/doc-linter/pull/36), draft, `sarif-issue5-20260929-reviewed` into the fixture base |
| Original pull request B | [#37](https://github.com/mike-north/doc-linter/pull/37), draft, `sarif-issue5-20260929-recovery` into the fixture base |
| Label | `suggestion` (already present in the repository; not created by the tool) |

The inputs are [`a.sarif.json`](evidence/companion-suggestion-pr/a.sarif.json) and [`b.sarif.json`](evidence/companion-suggestion-pr/b.sarif.json). Case A holds an explicit group `retry-with-check` (an edit of line 3 of `client.md` and the creation of `client-test.md`), a standalone deletion of `obsolete.md`, and an ungrouped typo fix on line 5 of `client.md`, inside the diff. Case B holds a group `recovery-pair` of two new pages.

## Case A: readiness, publication, relationship and exact bytes

1. **Readiness without the setting** ([`a-validate.md`](evidence/companion-suggestion-pr/a-validate.md)): `validate` exits 2 with the single blocker `acceptance-group-requires-suggestion-prs` at `/runs/0/results/0`, naming `--suggestion-prs`. Nothing was split.
2. **Readiness with `--suggestion-prs`**: exit 0, "Publication would also create 2 draft suggestion pull requests into `sarif-issue5-20260929-reviewed`, labeled `suggestion`", and 1 inline comment plus 2 general sections. Only reads were made.
3. **Publication** ([`a-publish.json`](evidence/companion-suggestion-pr/a-publish.json)): `publish --suggestion-prs --format json` exited 0 with `status: published`, draft review `5354085442` on #36, and `suggestions` [#38](https://github.com/mike-north/doc-linter/pull/38) (the group) and [#39](https://github.com/mike-north/doc-linter/pull/39) (the deletion). The state path holds the plan and one record per branch, pull request and label, plus the review record ([`state-records.json`](evidence/companion-suggestion-pr/state-records.json)).
4. **Branch targets** ([`pull-requests.json`](evidence/companion-suggestion-pr/pull-requests.json)): #38 and #39 are open drafts whose base is `sarif-issue5-20260929-reviewed`, the original's head branch, from `sarif-to-comment/suggestions/36/<id>` branches. #36's description is unchanged.
5. **Exact proposed bytes** ([`proposal-commits.txt`](evidence/companion-suggestion-pr/proposal-commits.txt)): each proposal branch, fetched with Git, is one commit whose only parent is the reviewed commit. The group's commit modifies line 3 of `client.md` and adds `client-test.md`; the deletion's commit removes `obsolete.md`; nothing else differs. The blob ids of `client.md` (`eea963b…`) and `client-test.md` (`24d6c48…`) equal `git hash-object` of the content derived by hand from the SARIF. GitHub's own file lists for #38 (`client-test.md` +3, `client.md` +1/−1) and #39 (`obsolete.md` −3) agree.
6. **Relationship discovery** ([`discovery-label-and-marker.json`](evidence/companion-suggestion-pr/discovery-label-and-marker.json)): `gh pr list --label suggestion --state open` returns #38 and #39 (and #40 from case B). Each body begins `Suggested in a review of #36 at commit 89bf101…`, an ordinary reference, and ends with exactly one marker whose `original` is `mike-north/doc-linter#36`, with the reviewed commit, a distinct suggestion `id` per pull request and one shared `publication` id. This is the suggestion-first path [#6](https://github.com/mike-north/sarif-to-comment/issues/6) will use.
7. **Draft review visibility**: `gh pr view 36 --json reviews` shows one `PENDING` review by the publishing account whose body starts with `**Suggestion pull request:** [#38](…)`, lists the two changes and presents both group findings, then the deletion's section linking #39. The typo stays a native suggestion comment. The publisher's own readback had verified the complete body and inline comment before it reported `published`.
8. **Retry without any request** ([`a-retry-invalid-token.md`](evidence/companion-suggestion-pr/a-retry-invalid-token.md)): the same command with the same state path and a deliberately invalid token exited 0, "already published … Nothing was sent", listing #38 and #39. An invalid token would have been refused by GitHub, so no request was made.

## Case B: lost responses, delayed visibility and resumption

A Node script drove the built `publishSarifReview` (through its private client seam) with a `fetch` wrapper; every request it did not name went to GitHub unchanged ([`b-first-lost-responses.json`](evidence/companion-suggestion-pr/b-first-lost-responses.json), [`b-retry.json`](evidence/companion-suggestion-pr/b-retry.json)).

1. **First attempt.** GitHub performed `POST git/refs` (201) and `POST pulls` (201), but both responses were discarded and a network error was raised instead. The branch was rediscovered at once by reading it at the proposal commit. The first listing of pull requests from the proposal branch was answered as empty without being sent, modelling delayed visibility. Outcome: `uncertain`, naming the proposal branch as already on GitHub, saying the pull request may not be visible yet and that this state path never creates it again.
2. **Between attempts**, `gh pr list --head <proposal branch> --state all` showed exactly one pull request, [#40](https://github.com/mike-north/doc-linter/pull/40), a draft into `sarif-issue5-20260929-recovery`, still without a label.
3. **Retry** with the same state path, discarding the add-label response this time: the requests were `GET /user`, the branch's pull request listing (which found #40 by its marker), `POST issues/40/labels` (performed, response discarded), the label listing (found), then the review's create and readback. No second `POST git/refs` or `POST pulls` was sent. Outcome `published`: draft review `5354106412` on #37, suggestion #40. Afterwards #40 carried `suggestion`, and its only commit, parent `83b57cf…`, adds exactly `recovery-a.md` (`f3552c6…`) and `recovery-b.md` (`13d2211…`), matching the hand-derived blob ids.

## Triggered automation

[`triggered-checks.txt`](evidence/companion-suggestion-pr/triggered-checks.txt): each suggestion pull request (#38, #39, #40) ran the repository's `Version guard` workflow twice, once for the `push` of its proposal branch and once for its `pull_request`, although every one is a draft. This is the cost the [off-by-default decision](companion-suggestion-pr-contract.md#21-off-by-default-and-why) weighs: in this small repository, three suggestions produced six workflow runs beyond the originals' own.

## What this does not establish

- Backlink traversal from the original pull request (GraphQL timeline cross-references) was not re-run here; the earlier [grouped-suggestion experiment](grouped-suggestion-experiment.md) established it. Case A shows the ordinary reference that creates the backlink.
- No suggestion pull request was merged, so acceptance into the original branch is established only by the earlier experiment.
- Forks, branch protection on proposal branches, repositories that disallow draft pull requests, and fine-grained tokens below the account's role were not exercised.
- Delayed visibility was modelled by the wrapper, not observed from GitHub; GitHub's own responses were real and immediate in every case.

## Live artifacts (left in place)

Nothing was cleaned up. Cleanup of suggestion pull requests is the separate on-demand action of #6; closing the originals and removing the fixture branches is left to the owner.

- Pull requests: originals [#36](https://github.com/mike-north/doc-linter/pull/36) and [#37](https://github.com/mike-north/doc-linter/pull/37); suggestions [#38](https://github.com/mike-north/doc-linter/pull/38), [#39](https://github.com/mike-north/doc-linter/pull/39) and [#40](https://github.com/mike-north/doc-linter/pull/40), all open drafts.
- Branches: `sarif-issue5-20260929-base`, `sarif-issue5-20260929-reviewed`, `sarif-issue5-20260929-recovery`, `sarif-to-comment/suggestions/36/5f72b5f4-8dd1-462a-948b-71b0767ecafe`, `sarif-to-comment/suggestions/36/ec69538b-1cf2-4801-b7e1-ae96d9076ff1`, `sarif-to-comment/suggestions/37/d692636b-46f9-4185-8e44-1b961e27bfc4`.
- Draft reviews: `5354085442` on #36 and `5354106412` on #37, both pending.
- Label: `suggestion` applied to #38, #39 and #40 (the label itself pre-existed).
