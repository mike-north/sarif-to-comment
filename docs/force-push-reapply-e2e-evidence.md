# Suggestion pull requests after a force-push: live GitHub evidence

Recorded September 29, 2026 in the private fixture repository `mike-north/doc-linter`, against the implementation of [issue #28](https://github.com/mike-north/sarif-to-comment/issues/28) ([convention §5.1](suggestion-pr-convention.md#51-when-the-originals-branch-has-moved-since-the-review), [companion contract §2.5–§2.5.1](companion-suggestion-pr-contract.md#251-re-application-after-a-rewritten-history)). The built package ran from the working tree (`node dist/sarif-to-comment.cjs`, `--format json`) with the maintainer's personal token. Nothing was published to npm, nothing was merged, and `main` stayed at `0a7b03f`. Sanitized outputs are in [`evidence/force-push-reapply/`](evidence/force-push-reapply/); every CLI step exited 0 and wrote nothing to stderr ([`exit-statuses.txt`](evidence/force-push-reapply/exit-statuses.txt)). The experiment that motivated the design is [force-push-experiment.md](force-push-experiment.md).

## Fixtures

Each original is a draft pull request into `main` from a branch holding C0 (adds `docs/experiments/reapply/sample-<v>.md`, 20 lines, and `obsolete-<v>.txt`) and C1 (changes lines 5 and 6). C1 is the reviewed commit. After the pull requests were opened ([`01`](evidence/force-push-reapply/01-originals-before-the-branches-moved.jsonl)), each branch moved ([`02`](evidence/force-push-reapply/02-heads-after-the-branches-moved.txt), [`02-pushes`](evidence/force-push-reapply/02-pushes.txt)):

| Original | Reviewed commit C1 | How the branch moved | Head at publication |
| --- | --- | --- | --- |
| [#61](https://github.com/mike-north/doc-linter/pull/61) advanced | `0531865` | an ordinary push of C2 (line 15) on top of C1 | `909a3c3`, a descendant of C1 |
| [#62](https://github.com/mike-north/doc-linter/pull/62) amended | `35a2457` | C1 amended to also change line 15, force-pushed | `a27db7c`; C1 is no longer part of the branch |
| [#64](https://github.com/mike-north/doc-linter/pull/64) rewritten | `5ebfe7d` | C1 amended so line 6 and the obsolete note differ, force-pushed | `080ce5e`; C1 is no longer part of the branch |

Each SARIF document ([`advanced`](evidence/force-push-reapply/advanced.sarif.json), [`amended`](evidence/force-push-reapply/amended.sarif.json), [`rewritten`](evidence/force-push-reapply/rewritten.sarif.json)), bound to its C1, holds an acceptance group `reword` of two edits of the sample (line 6, which C1 introduced, and line 10, context), a new page, the deletion of the obsolete note, and a plain remark: three suggestion pull requests and one ordinary section.

## Runs

1. **Advanced: proceed on the reviewed commit** ([`10`](evidence/force-push-reapply/10-validate-advanced.json), [`20`](evidence/force-push-reapply/20-publish-advanced.json)). `validate`: ``Publication would also create 3 draft suggestion pull requests into `exp-reapply-20260929-advanced`, labeled `suggestion-pr`.``, with no mention of re-application. `publish` created draft review 5361377275 and [#65](https://github.com/mike-north/doc-linter/pull/65)–[#67](https://github.com/mike-north/doc-linter/pull/67). Each branch's single commit has C1 `0531865` as its parent, and each marker is version 1 ([`31`](evidence/force-push-reapply/31-proposal-commits.txt), [`30`](evidence/force-push-reapply/30-suggestion-pull-requests.jsonl)). Before #28 this was refused.
2. **Amended: every suggestion re-applied** ([`11`](evidence/force-push-reapply/11-validate-amended.json), [`21`](evidence/force-push-reapply/21-publish-amended.json)). `validate` adds ``The history of #62 was rewritten after the reviewed commit, so they are re-applied onto commit `a27db7c…`, where everything they change is still exactly as reviewed.`` `publish` created draft review 5361380422 and [#68](https://github.com/mike-north/doc-linter/pull/68)–[#70](https://github.com/mike-north/doc-linter/pull/70), listed ``(drafts into `exp-reapply-20260929-amended`, labeled `suggestion-pr`, re-applied onto commit `a27db7c…`)``. Each branch's single commit has the new head `a27db7c` as its parent; each body carries the re-application paragraph and a version 2 marker, for example `{"version":2,…,"reviewedCommit":"35a2457…","reappliedOnto":"a27db7c…",…}`. The group's commit changes exactly lines 6 and 10 of the head's file and keeps the author's later line 15 ([`32`](evidence/force-push-reapply/32-amended-reword.diff)).
3. **Rewritten: two suggestions skipped with their reasons, one re-applied** ([`12`](evidence/force-push-reapply/12-validate-rewritten.json), [`22`](evidence/force-push-reapply/22-publish-rewritten.json)). `validate` and `publish` report the same two warnings, for example ``The history of #64 was rewritten after the reviewed commit, so the suggestion pull request `Suggestion for #64: reword (2 changes)` would have to be re-applied onto commit `080ce5e…`, and it cannot be: `docs/experiments/reapply/sample-rewritten.md` line 6 differs from the reviewed text. It is not created; its change and findings are presented in the review body.``, and ``… `docs/experiments/reapply/obsolete-rewritten.txt` differs from the reviewed file …``. `publish` created draft review 5361383437 and only [#71](https://github.com/mike-north/doc-linter/pull/71), the new page, re-applied onto `080ce5e`.
4. **The reviews** ([`33`](evidence/force-push-reapply/33-reviews.jsonl)). All three are pending at their reviewed commit C1, although only #61's C1 is still part of its branch. #62's sections link #68–#70 with the re-application paragraph. #64's review opens with ``**Suggestion pull request not created:** the history of #64 was rewritten after the reviewed commit, and this change cannot be re-applied onto commit 080ce5e…, the head of #64, because there:`` and the reason, then `It would have proposed these 2 changes together:`, the changes and both findings; then #71's section; then the deletion's not-created section; then the plain remark, published as before.
5. **What GitHub shows** ([`30`](evidence/force-push-reapply/30-suggestion-pull-requests.jsonl)). Every suggestion pull request lists exactly one commit and only its own change (+2 −2 for a group, +3 for a page, −2 for a deletion), and GitHub reports each MERGEABLE. In the [experiment](force-push-experiment.md), suggestions built on a discarded commit listed that commit, repeated its diff (+3 −3), and conflicted or would have silently undone the author's rewrite.
6. **Retries are answered from the receipts** ([`40`](evidence/force-push-reapply/40-retry-advanced.json)–[`42`](evidence/force-push-reapply/42-retry-rewritten.json)): each state path reports ``… was already published; its completion is recorded at `<evidence>/state/<v>.json`. Nothing was sent.``, and #62 and #64 still report `re-applied onto commit …`. Nothing was created ([`50`](evidence/force-push-reapply/50-refs-after.txt): the only suggestion branches of #61, #62 and #64 are the seven above, and `main` is still `0a7b03f`).

## What this covers

| #28 acceptance item | Live | Tests |
| --- | --- | --- |
| The reviewed commit is the head | Not live (unchanged behavior, covered by earlier evidence) | `test/force-push-reapply.test.mts` |
| Advanced branch: proceed on the reviewed commit | Run 1 | the same file, `test/companion-composition.test.mts`, `test/suggestion-pr-convention.test.mts` |
| Rewritten history, unchanged regions: re-applied | Run 2 | `test/force-push-reapply.test.mts` |
| Rewritten history, changed regions: skipped with a reason | Run 3 | the same file |
| Whole-file creation and deletion under rewritten history | Runs 2 and 3 (a creation re-applied twice, a deletion re-applied and skipped) | the same file: a created path that exists or is a directory, a deleted file changed or gone |
| Recovery and retry after a re-application | Run 6 (receipts) | the same file: a lost pull request response, a retry after a second force-push, a completed plan, a lost review response |
| `validate` reports the same per-suggestion outcomes | Runs 1–3 | the same file, including the CLI |

## Live artifacts

All left in place:

- Branches `exp-reapply-20260929-advanced` (`909a3c3`), `exp-reapply-20260929-amended` (`a27db7c`, force-pushed from `35a2457`) and `exp-reapply-20260929-rewritten` (`080ce5e`, force-pushed from `5ebfe7d`), created from `main` for this evidence.
- Draft originals [#61](https://github.com/mike-north/doc-linter/pull/61), [#62](https://github.com/mike-north/doc-linter/pull/62) and [#64](https://github.com/mike-north/doc-linter/pull/64) into `main`, open.
- Pending draft reviews 5361377275 (#61), 5361380422 (#62) and 5361383437 (#64).
- Suggestion pull requests, all open drafts labeled `suggestion-pr`, and their branches `suggestion-pr/<original>/<id>`: [#65](https://github.com/mike-north/doc-linter/pull/65), [#66](https://github.com/mike-north/doc-linter/pull/66) and [#67](https://github.com/mike-north/doc-linter/pull/67) (on the reviewed commit of #61); [#68](https://github.com/mike-north/doc-linter/pull/68), [#69](https://github.com/mike-north/doc-linter/pull/69) and [#70](https://github.com/mike-north/doc-linter/pull/70) (re-applied onto #62's head); [#71](https://github.com/mike-north/doc-linter/pull/71) (re-applied onto #64's head).

## What this does not show

- A second force-push after planning, live: the plan's snapshot is covered by `test/force-push-reapply.test.mts`.
- A branch reset to an earlier commit (`behind`), a range that only moved, or a directory where a file would be created: covered by the fake host only.
- Marking a re-applied suggestion ready and merging it: nothing was merged.
