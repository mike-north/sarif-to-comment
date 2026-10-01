# Read-only snapshot of the force-push fixtures

Captured about 01:00–01:15 UTC on October 1, 2026, from draft pull requests [#41](https://github.com/mike-north/doc-linter/pull/41)–[#52](https://github.com/mike-north/doc-linter/pull/52) in `mike-north/doc-linter`. These are the fixtures of the [force-push experiment](../../force-push-experiment.md) of September 29, 2026, which left them in place. Every request was a read: `gh pr view`, REST `GET` and GraphQL queries. Nothing was written to GitHub, and no review was submitted, edited or deleted.

This is a later readback of the experiment's fixtures, not the experiment's own evidence. It records their state a day afterwards. Under the [evidence policy](../../evidence-policy.md) it is historical and is not updated to follow later changes. The submissions planned for the pending reviews will change their state.

## Files and redaction

Each file is the unmodified JSON response, pretty-printed with `jq`, with one redaction: the commit author and committer email is replaced by `<redacted-email>`. No token, environment or local path appears in any file.

| File | Source |
|---|---|
| `e0-<pr>-pr.json` | `gh pr view <pr> --json number,title,url,state,isDraft,closed,mergedAt,createdAt,updatedAt,headRefName,headRefOid,baseRefName,baseRefOid,commits,reviews,latestReviews,mergeable,mergeStateStatus,files,additions,deletions,changedFiles,body` |
| `e0-<pr>-reviews-rest.json` | `GET repos/mike-north/doc-linter/pulls/<pr>/reviews` |
| `e0-<pr>-review-comments-rest.json` | `GET repos/mike-north/doc-linter/pulls/<pr>/comments` |
| `e0-<pr>-review-<id>.json`, `e0-<pr>-review-<id>-comments.json` | `GET …/pulls/<pr>/reviews/<id>` and `…/reviews/<id>/comments`, for the four reviews only |
| `e0-<pr>-review-threads-graphql.json` | GraphQL: the PR's reviews, and its review threads with `isOutdated`, `line`, `originalLine` and each comment's `state`, `outdated`, `commit` and `originalCommit` |
| `e0-<pr>-force-push-events-graphql.json` | GraphQL `timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT])`, with `beforeCommit` and `afterCommit` |
| `e0-<pr>-timeline-graphql.json` | GraphQL: the whole timeline, unfiltered, for #41–#44 only |
| `e0-<pr>-compare-<a>-<b>.json` | `GET repos/mike-north/doc-linter/compare/<a>...<b>` |

The compare readbacks are the one the report names (`eb6c2f6...3f77a6e`, #43), each discarded reviewed commit against its PR's current head (#41, #42, #43), the control's reviewed commit against its head (#44), and each companion's base and head as the PR shows them (#45–#52).

## State of each fixture

All twelve are open drafts. None is merged or closed.

| PR | Variant | Head | Commits GitHub lists | Diff | Mergeable |
|---|---|---|---|---|---|
| #41 | amend | `b3e3ed7` | `b3e3ed7` | +2 −2 | MERGEABLE, CLEAN |
| #42 | rebase | `f4ba859`, base `13fddb7` | `f4ba859` | +1 −1 | MERGEABLE, CLEAN |
| #43 | orphan | `d28aa24` | `d28aa24` | +1 −1 | MERGEABLE, CLEAN |
| #44 | control | `4b82f10` | `91f433c`, `4b82f10` | +3 −3 | MERGEABLE, CLEAN |
| #45 | amend `line6` | `599270d` into `b3e3ed7` | `e69981e`, `599270d` | +2 −2 | CONFLICTING, DIRTY |
| #46 | amend `ctx` | `6089e28` into `b3e3ed7` | `e69981e`, `6089e28` | +3 −3 | CONFLICTING, DIRTY |
| #47 | rebase `line6` | `2296faa` into `f4ba859` | `7eb3dc6`, `2296faa` | +2 −2 | CONFLICTING, DIRTY |
| #48 | rebase `ctx` | `e90f59f` into `f4ba859` | `7eb3dc6`, `e90f59f` | +3 −3 | CONFLICTING, DIRTY |
| #49 | control `line6` | `f013010` into `4b82f10` | `f013010` | +1 −1 | MERGEABLE, CLEAN |
| #50 | control `ctx` | `15e360c` into `4b82f10` | `15e360c` | +1 −1 | MERGEABLE, CLEAN |
| #51 | amend re-applied | `c156ae2` into `b3e3ed7` | `3007343`, `c156ae2` | +3 −3 | CONFLICTING, DIRTY |
| #52 | orphan `ctx` | `d92f82c` into `d28aa24` | `eb6c2f6`, `d92f82c` | +3 −3 | MERGEABLE, CLEAN |

### Reviews and their comments

| Review | PR | State | `commit_id` | Inline comments now |
|---|---|---|---|---|
| 5356480526 | #41 | **PENDING** | `e69981e` (discarded) | line 5: outdated, `line` null, `commit_id` `3007343` (the intermediate head, also discarded). Line 6: not outdated, line 6 at `b3e3ed7`. |
| 5356481554 | #42 | COMMENTED, submitted 2026-09-29T18:02:58Z | `7eb3dc6` (discarded) | line 5: outdated, `line` null, `original_line` 5, `commit_id` `62ed990`. Line 6: not outdated, line 6 at `f4ba859`. |
| 5356511269 | #43 | **PENDING** | `eb6c2f6` (discarded) | none; body only |
| 5356482670 | #44 | **PENDING** | `91f433c` (ancestor of the head) | lines 5 and 6: not outdated, at `4b82f10` |

The three pending reviews are still pending: 5356480526 (#41), 5356511269 (#43) and 5356482670 (#44). Each review's own `commit_id` is still the commit it was created on.

Where each anchor field is visible:

- `GET …/pulls/<pr>/comments` returns the comments of the submitted review on #42, with `line`, `original_line` and `side`. It returns **no** comments for #41 and #44, whose comments belong to pending reviews.
- `GET …/reviews/<id>/comments` returns the pending comments, with `commit_id`, `original_commit_id`, `position` and `original_position`, but without `line`, `original_line` or `side`.
- GraphQL review threads return all of them, pending included, with `line`, `originalLine` and `outdated`. The line numbers in the table above come from there.

## Do force-push timeline events expose the discarded heads?

**Yes, in every recorded case.** Each `HeadRefForcePushedEvent` carried a non-null `beforeCommit` and `afterCommit`:

| PR | First rewrite | Second rewrite |
|---|---|---|
| #41 | `e69981e` → `3007343`, 18:04:37Z | `3007343` → `b3e3ed7`, 18:17:32Z |
| #42 | `7eb3dc6` → `62ed990`, 18:04:37Z | `62ed990` → `f4ba859`, 18:17:59Z |
| #43 | `eb6c2f6` → `3f77a6e`, 18:04:37Z | `3f77a6e` → `d28aa24`, 18:18:56Z |

Each discarded reviewed commit (`e69981e`, `7eb3dc6`, `eb6c2f6`) is the `beforeCommit` of the PR's first event, and each intermediate head is the `beforeCommit` of the second. The PR's commit list holds only the current head, so the timeline is the only readback here that names the discarded heads.

Other timeline observations:

- The companions whose target was force-pushed while they were open (#45–#48, #51) each have one `BaseRefForcePushedEvent` for the second rewrite, also with non-null `beforeCommit` and `afterCommit`. They were opened after the first rewrite, and #52 was opened after the second, so they have no other events.
- #44 (an ordinary push) and #42's base, which advanced by an ordinary push, have no force-push event.
- With `itemTypes` set, `totalCount` still counts the whole timeline (4 for #41, 3 for #44), while `filteredCount` counts the matching items (2 and 0). See `e0-41-timeline-graphql.json` and `e0-44-timeline-graphql.json`.
- The pending reviews appear in the timeline as `PullRequestReview` items for this account, which created them.

**Bearing on the association check** (specification R17; inference, not observation): an association check that accepts the head or any `beforeCommit` would associate all three discarded reviewed commits with their PRs. This snapshot has only three force-pushed PRs and at most two events each. It does not show whether `beforeCommit` can be null, for example after the commit is garbage-collected, or how events paginate past 100 items. The fixtures do not cover forks.

## Reachability of discarded commits

Every compare read succeeded, including those naming the discarded commits `e69981e`, `7eb3dc6` and `eb6c2f6`:

- `eb6c2f6...3f77a6e` (#43): `diverged`, ahead 1, behind 1, merge base `4f19746`, +3 −3. This is the readback the report names, and it matches.
- `e69981e...b3e3ed7` (#41) and `eb6c2f6...d28aa24` (#43): `diverged`, ahead 1, behind 1.
- `7eb3dc6...f4ba859` (#42): `diverged`, ahead 2 (`13fddb7`, `f4ba859`), behind 1, merge base `7b5863e`, the old base.
- `91f433c...4b82f10` (#44): `ahead` by 1. The reviewed commit is an ancestor of the head.
- The companions' compares list the same commits and line counts as their PRs. #45–#48 and #52 list the discarded reviewed commit with a merge base before it. #51 lists the intermediate head `3007343`, and #49 and #50 list only their proposal commit.

## Differences from the experiment report

None of the report's recorded observations is contradicted. Points that are new, or that refine it:

- **Current mergeability.** The report records #46 and #48 as MERGEABLE before the second rewrite, and #45–#48 all CONFLICTING after it. They are still CONFLICTING, and #51 is still CONFLICTING and still lists `3007343`, as the report says. #52 is still MERGEABLE.
- **#41's frozen comment.** The report says an outdated comment's `commit_id` freezes "at the last head where it applied". On #41 that head is `3007343`, an intermediate head that is itself discarded. The same holds for #42 (`62ed990`).
- **#43's head after the second rewrite** shows +1 −1. The report's "drops the whole C1 hunk" refers to lines 5 and 6; the remaining change is the line-15 edit from the first amend.
- **Pending comments are missing from `GET …/pulls/<pr>/comments`.** The report does not say which readback showed #41's pending comments. Here only the per-review endpoint and GraphQL return them.
- **Force-push events and `filteredCount`** were not read in the experiment. They are new in this snapshot.

## Denied or skipped requests

None was denied or skipped. No screenshots were taken; this snapshot is API state only.
