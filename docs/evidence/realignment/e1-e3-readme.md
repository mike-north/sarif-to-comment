# Historical reviews on the force-push fixtures: E3 and E1

Run between 01:35 and 02:03 UTC on October 1, 2026, in `mike-north/doc-linter`, on the draft pull requests of the [force-push experiment](../../force-push-experiment.md). The fixtures were in the state the [read-only snapshot](e0-readme.md) recorded a few minutes earlier. One authenticated account (`mike-north`, the repository owner) made every request.

Two experiments were run, E3 first:

- **E3** submitted two pending reviews created before the branch moved: one whose reviewed commit was later discarded by an amend (#41), and one whose reviewed commit is still an ancestor of the head (#44, the control).
- **E1** created new submitted reviews (`event: COMMENT`) with `commit_id` set to an older commit, and one inline comment each, on #44 (an ancestor of the head), #41 (discarded by an amend) and #42 (discarded by a rebase). It also ran negative controls whose `commit_id` is not in the pull request's history.

Under the [evidence policy](../../evidence-policy.md), this record is historical. It is not updated to follow later changes to the fixtures.

## What was written to GitHub

Only reviews were written, and only on #41, #42 and #44. No branch was pushed, no commit was created, no suggestion was applied, nothing was merged, closed or deleted, and `main` was not touched. Pending review 5356511269 on #43 was not needed and was not touched.

| Action | Pull request | Objects |
|---|---|---|
| E3: submitted a pending review | #41 | review 5356480526 (existing) |
| E3: submitted a pending review | #44 | review 5356482670 (existing) |
| E1: created a submitted review | #44 | 5373957212, 5373957299, 5373957407 (cases a, b, c); 5373959027, 5373959134, 5373959198, 5373959288 (negative controls n1–n4) |
| E1: created a submitted review | #41 | 5373957613, 5373957705, 5373957807, 5373957926, 5373958025 |
| E1: created a submitted review | #42 | 5373958189, 5373958297, 5373958412, 5373958488, 5373958588, 5373958814 |

The six E1 requests that GitHub refused created nothing. The review counts after the run equal the earlier reviews plus the accepted cases: 6 on #41, 7 on #42 and 8 on #44 (`e1-<pr>-after-reviews-rest.json`).

Each E1 review body carries a marker `<!-- e1:<pr>:<case> -->` and says it is a fixture. No E1 comment carries a suggestion block.

## Files and redaction

Every file is an envelope written from a `gh api --include` capture:

```json
{ "request": { "method": "…", "path": "…", "body": { } }, "status": 200, "statusLine": "HTTP/2.0 200 OK", "response": { }, "ghCliError": "…" }
```

`request.body` is the exact JSON sent, for writes. `response` is the response body, unmodified apart from pretty-printing. `ghCliError` is the line the `gh` CLI printed after an error body. Response headers are not kept. As in E0, any value under a key named `email` would be replaced by `<redacted-email>`; none of these responses contain one. No token, environment or local path appears.

The GraphQL readbacks use one query, which returns the pull request's head and base, its reviews with `commit`, `state` and `submittedAt`, its review threads with `isOutdated`, `line`, `originalLine` and `diffSide`, each thread comment with `state`, `outdated`, `line`, `originalLine`, `position`, `originalPosition`, `diffHunk`, `commit` and `originalCommit`, and the `PULL_REQUEST_REVIEW` timeline items with their `state` and `commit`.

| File | Source |
|---|---|
| `e3-<pr>-before-review-<id>.json`, `e3-<pr>-before-review-<id>-comments.json`, `e3-<pr>-before-graphql.json` | `GET …/pulls/<pr>/reviews/<id>`, `GET …/reviews/<id>/comments` and the GraphQL query, just before submission |
| `e3-<pr>-submit-<id>.json` | `POST …/pulls/<pr>/reviews/<id>/events` with `{"event":"COMMENT"}` |
| `e3-<pr>-after-review-<id>.json`, `e3-<pr>-after-review-<id>-comments.json`, `e3-<pr>-after-pull-comments.json`, `e3-<pr>-after-graphql.json` | The same reads after submission, plus `GET …/pulls/<pr>/comments` |
| `e1-<pr>-<case>-create.json` | `POST …/pulls/<pr>/reviews`, one per case |
| `e1-<pr>-<case>-review.json`, `e1-<pr>-<case>-review-comments.json` | `GET …/reviews/<id>` and `GET …/reviews/<id>/comments`, for each accepted case |
| `e1-<pr>-after-reviews-rest.json`, `e1-<pr>-after-pull-comments.json`, `e1-<pr>-after-graphql.json` | `GET …/pulls/<pr>/reviews`, `GET …/pulls/<pr>/comments` and the GraphQL query, about one minute after the E1 writes |
| `e1-<pr>-later-pull-comments.json`, `e1-<pr>-later-graphql.json` | The same two reads, repeated about 23 minutes after the E1 writes |

`GET …/pulls/<pr>/comments` is the only REST read that returns `line`, `original_line` and `side`. The per-review endpoint returns them as `null`, as GH-07 recorded. REST has no `outdated` field; `outdated` and `isOutdated` come from GraphQL.

## E3: submitting a pending review across a rewrite

| Review | PR | Condition | Submission | After submission |
|---|---|---|---|---|
| 5356480526 | #41 | Created pending at `e69981e`. The branch was then amended twice: the reviewed commit is discarded, the head is `b3e3ed7`, and the line-5 change was dropped. | HTTP 200, `state: COMMENTED`, `submitted_at` 2026-10-01T01:35:19Z | Review `commit_id` still `e69981e`. Timeline item: `COMMENTED`, commit `e69981e`. |
| 5356482670 | #44 | Created pending at `91f433c`. An ordinary push then added `4b82f10`, so the reviewed commit is an ancestor of the head. | HTTP 200, `state: COMMENTED`, `submitted_at` 2026-10-01T01:35:20Z | Review `commit_id` still `91f433c`. Timeline item: `COMMENTED`, commit `91f433c`. |

The comments, after submission:

| Comment | Review | REST `commit_id` | `original_commit_id` | `line` / `original_line` | `position` / `original_position` | GraphQL `outdated`, thread `isOutdated` / `line` / `originalLine` |
|---|---|---|---|---|---|---|
| 4136702045, RIGHT line 5 | 5356480526 (#41) | `3007343` | `e69981e` | `null` / 5 | 1 / 6 | `true`, `true` / `null` / 5 |
| 4136702047, RIGHT line 6 | 5356480526 (#41) | `b3e3ed7` (head) | `e69981e` | 6 / 6 | 5 / 7 | `false`, `false` / 6 / 6 |
| 4136703820, RIGHT line 5 | 5356482670 (#44) | `4b82f10` (head) | `91f433c` | 5 / 5 | 6 / 6 | `false`, `false` / 5 / 5 |
| 4136703828, RIGHT line 6 | 5356482670 (#44) | `4b82f10` (head) | `91f433c` | 6 / 6 | 7 / 7 | `false`, `false` / 6 / 6 |

`3007343` is #41's intermediate head, itself discarded. GraphQL comment `state` changed from `PENDING` to `SUBMITTED`, and REST `updated_at` changed to the submission time. Nothing else changed between the before and after readbacks: no anchor, commit or position moved on submission.

**Establishes:** a pending review created before a force-push, whose reviewed commit was discarded, could be submitted afterwards with `COMMENT`. GitHub kept the review's `commit_id` at the discarded commit and reported no error or warning. Its comments kept the state they had reached while pending: the one on the unchanged line stayed moved to the head, and the one on the dropped line stayed outdated. The forward-push control behaved the same way, with both comments at the head.

**Does not establish:** how the timeline or the comments render (no screenshot was possible, so rendering was NOT observed); the `APPROVE` or `REQUEST_CHANGES` events; a pending review with native suggestions being applied after submission (E2); forks, other accounts, or a reviewer other than the pull request's author.

## E1: new historical inline reviews

### How each line was chosen

Each fixture file is 20 lines. The reviewed commit changes lines 5 and 6. The diffs were computed with `git diff` in a local clone of `doc-linter`, with the discarded commits fetched by SHA. The `diff_hunk` of each accepted comment matches them.

| Fixture | Base…reviewed commit | Base…head |
|---|---|---|
| #44: base `d138c0e`, reviewed `91f433c`, head `4b82f10` | one hunk, new lines 2–9: lines 5 and 6 changed (LEFT 5 and 6 deleted) | the same hunk, plus new lines 12–18 (line 15 changed) |
| #41: base `c29a1b2`, reviewed `e69981e` (discarded), head `b3e3ed7` | one hunk, new lines 2–9: lines 5 and 6 changed | new lines 3–9: line 6 changed, line 5 is context; and new lines 12–18 (line 15 changed) |
| #42: base `13fddb7`, reviewed `7eb3dc6` (discarded), head `f4ba859` | from the old merge base `7b5863e`: one hunk, new lines 2–9. From the current base `13fddb7` (two-dot): that hunk, plus new lines 15–20, because the base later changed line 18 | new lines 3–9: line 6 changed, line 5 is context |

So line 2 is in the reviewed diff but outside the head diff on #41 and #42. Line 15 is in the head diff but outside the reviewed diff on #41 and #44. #44 has no line of the first kind, and #42 none of the second. Line 18 on #42 is only in the two-dot diff from the current base. Line 11 is outside every hunk of every diff, as a control.

### Results

Each accepted review came back with `state: COMMENTED`, `commit_id` equal to the `commit_id` sent, and a `PULL_REQUEST_REVIEW` timeline item with the same `state` and `commit`. Every refusal was HTTP 422 with `{"message":"Unprocessable Entity","errors":["Line could not be resolved"]}`.

In every accepted case the comment's REST `commit_id` and `original_commit_id` both equal the reviewed commit, and `line` equals `original_line`.

| Case | Anchor | HTTP | Review | `position` / `original_position` | GraphQL `outdated`, thread `isOutdated` / `line` / `originalLine` |
|---|---|---|---|---|---|
| 44-a-right6 | RIGHT 6 | 200 | 5373957212 | 7 / 7 | `false`, `false` / 6 / 6 |
| 44-b-right5 | RIGHT 5 | 200 | 5373957299 | 6 / 6 | `false`, `false` / 5 / 5 |
| 44-c-left5 | LEFT 5 | 200 | 5373957407 | 4 / 4 | `false`, `false` / 5 / 5 |
| 44-d-head-only-right15 | RIGHT 15 | 422 | none | | |
| 44-e-outside-right11 | RIGHT 11 | 422 | none | | |
| 41-a-right6 | RIGHT 6 | 200 | 5373957613 | 7 / 7 | `false`, `false` / 6 / 6 |
| 41-b-right5 | RIGHT 5 | 200 | 5373957705 | 6 / 6 | `false`, `false` / 5 / 5 |
| 41-c-left6 | LEFT 6 | 200 | 5373957807 | 5 / 5 | `false`, `false` / 6 / 6 |
| 41-c-left5 | LEFT 5 | 200 | 5373957926 | 4 / 4 | `false`, `false` / 5 / 5 |
| 41-d-reviewed-only-right2 | RIGHT 2 | 200 | 5373958025 | 1 / 1 | `false`, `false` / 2 / 2 |
| 41-d-head-only-right15 | RIGHT 15 | 422 | none | | |
| 41-e-outside-right11 | RIGHT 11 | 422 | none | | |
| 42-a-right6 | RIGHT 6 | 200 | 5373958189 | 7 / 7 | `false`, `false` / 6 / 6 |
| 42-b-right5 | RIGHT 5 | 200 | 5373958297 | 6 / 6 | `false`, `false` / 5 / 5 |
| 42-c-left6 | LEFT 6 | 200 | 5373958412 | 5 / 5 | `false`, `false` / 6 / 6 |
| 42-c-left5 | LEFT 5 | 200 | 5373958488 | 4 / 4 | `false`, `false` / 5 / 5 |
| 42-d-reviewed-only-right2 | RIGHT 2 | 200 | 5373958588 | 1 / 1 | `false`, `false` / 2 / 2 |
| 42-f-twodot-only-right18 | RIGHT 18 | 200 | 5373958814 | **1 / 16** | **`true`, `true`** / 18 / 18 |
| 42-e-outside-right11 | RIGHT 11 | 422 | none | | |

The `original_position` values count lines of the diff from the pull request's base to the reviewed commit. On #42-f, `original_position` 16 is line 18 in the second hunk of the two-dot diff from `13fddb7`, and the stored `diff_hunk` reads `-Line 18: base advanced (N).` / `+Line 18: original text.`, which exists only in that diff.

### Negative controls, all on #44

| Case | `commit_id` | Anchor | HTTP | Review | Comment |
|---|---|---|---|---|---|
| n1-unrelated-inline | `bbd615c`, the tip of `demo/content-review`, an unrelated branch not in #44's history | RIGHT 1 of `demo-content/accept-online-payments.md`, a file that commit adds and #44 does not contain | 200 | 5373959027 | `commit_id` and `original_commit_id` `bbd615c`; `line` 1, `position` 1; `outdated: false` |
| n2-unrelated-body | `bbd615c` | body only | 200 | 5373959134 | none |
| n3-other-fixture-inline | `909a3c3`, the tip of `exp-reapply-20260929-advanced`, a fixture of a different experiment | RIGHT 6 of `docs/experiments/reapply/sample-advanced.md`, which #44 does not contain | 200 | 5373959198 | `commit_id` and `original_commit_id` `909a3c3`; `line` 6, `position` 6; `outdated: false` |
| n4-other-fixture-body | `909a3c3` | body only | 200 | 5373959288 | none |

Each review's `commit_id` is the foreign commit, and each appears in #44's timeline with that commit. The inline comments are listed by `GET …/pulls/44/comments` with paths that #44's diff does not contain.

### Each case: condition, outcome, scope

The common limits, which apply to every case below: rendering was NOT observed (no screenshot was possible, so where the web interface shows these comments, in the current diff, as outdated, or in the conversation only, is unknown); no suggestion was included or applied; one account, same-repository draft pull requests, no forks; single-line comments only; no later push to these branches, so whether a push repositions these comments was not tested.

- **44-a-right6, 44-b-right5.** Condition: RIGHT lines 6 and 5 at `91f433c`, an ancestor of the head; both lines are the same at the head. Outcome: accepted; the comments stay at `91f433c` with their original positions, not outdated. Establishes: GitHub accepts new inline comments at an ancestor of the head, and does not move them to the head. Does not establish: how they render.
- **44-c-left5.** Condition: LEFT line 5, a deleted base line in both diffs. Outcome: accepted, at `91f433c`, not outdated. Establishes: a LEFT comment on a deleted line at an ancestor commit is accepted.
- **44-d-head-only-right15.** Condition: RIGHT line 15 at `91f433c`; line 15 is inside the head's diff but not the reviewed commit's. Outcome: 422 "Line could not be resolved", nothing created. Establishes: the line is not resolved against the head's diff.
- **44-e-outside-right11.** Condition: RIGHT line 11, outside every hunk. Outcome: 422, nothing created. Establishes: a line outside the diff is refused at a historical commit too, as at the head (GH-05).
- **41-a-right6.** Condition: RIGHT line 6 at the discarded `e69981e`; line 6 is the same at the head. Outcome: accepted, at `e69981e`, not outdated, not moved. Establishes: GitHub accepts new inline comments at a commit that is no longer in the pull request.
- **41-b-right5.** Condition: RIGHT line 5 at `e69981e`, a change the head dropped. Outcome: accepted, at `e69981e`, `outdated: false`. Establishes: a comment on a range the head no longer has is still accepted, and is not flagged outdated at creation. Does not establish: whether the web interface treats it as outdated.
- **41-c-left6, 41-c-left5.** Condition: LEFT lines 6 and 5, both deleted in the reviewed diff; at the head, line 6 is still deleted and line 5 is context. Outcome: both accepted, at `e69981e`, not outdated. Establishes: LEFT comments on deleted lines at a discarded commit are accepted, whatever the head does with that line.
- **41-d-reviewed-only-right2.** Condition: RIGHT line 2, inside the reviewed diff's hunk but outside every hunk of the head's diff. Outcome: accepted, `position` 1. Establishes, with 41-d-head-only-right15: the line is resolved against the reviewed commit's diff, not the head's.
- **41-d-head-only-right15, 41-e-outside-right11.** As on #44: both 422, nothing created.
- **42-a-right6, 42-b-right5, 42-c-left6, 42-c-left5, 42-d-reviewed-only-right2.** As on #41, at `7eb3dc6`, discarded by a rebase onto an advanced base. All accepted, at `7eb3dc6`, not outdated. Establishes: the rebase variant behaves like the amend variant for these lines.
- **42-f-twodot-only-right18.** Condition: RIGHT line 18, which is changed only in the diff from the current base `13fddb7` to `7eb3dc6`, not in the diff from their merge base `7b5863e`, and not in the head's diff. Outcome: accepted. The comment is at `7eb3dc6` with `original_position` 16 and `diff_hunk` from the `13fddb7` diff, but `position` 1 and `outdated: true` from creation. Establishes: the line was resolved against the diff from the pull request's current base commit to the reviewed commit, not the diff from their merge base. Does not establish: whether that base is the base branch's tip or the merge base of the base and the head (both are `13fddb7` here); why GitHub marks it outdated (see the inferences below).
- **42-e-outside-right11.** 422, nothing created.
- **n1–n4.** Condition: `commit_id` is a commit that is not in #44's history: the tip of an unrelated branch, or a commit of another experiment's fixture. Outcome: all four accepted, including inline comments on files #44 does not contain. Establishes: GitHub does not check that `commit_id` belongs to the pull request. Does not establish: commits from another repository or a fork; how such comments render.

### Later readback

At 02:02:48 UTC, about 23 minutes after the writes, `GET …/pulls/<pr>/comments` and the GraphQL query were repeated for #41, #42 and #44 (`e1-<pr>-later-*.json`). Both responses are identical to the readbacks taken about one minute after the writes, including every `commit_id`, `position`, `outdated` and `updated_at`. Nothing was repositioned in that time. No push happened in between, so this does not show what a later push would do.

## Answers

1. **Does GitHub accept new inline comments at an ancestor reviewed commit? At a discarded one?** Yes to both, observed. At `91f433c` (#44, an ancestor of the head) and at `e69981e` and `7eb3dc6` (#41 and #42, discarded by an amend and by a rebase), GitHub accepted RIGHT comments on changed and unchanged lines and LEFT comments on deleted lines, with HTTP 200 and no warning. Evidence: `e1-44-a-right6-create.json`, `e1-41-a-right6-create.json`, `e1-41-b-right5-create.json`, `e1-41-c-left5-create.json`, `e1-42-*-create.json`.
2. **Which diff are lines validated against?** Observed: the diff of the reviewed commit, not the head's. Line 2 was accepted where only the reviewed diff has it (`e1-41-d-reviewed-only-right2-create.json`, `e1-42-d-reviewed-only-right2-create.json`); line 15 was refused where only the head's diff has it (`e1-41-d-head-only-right15-create.json`, `e1-44-d-head-only-right15-create.json`); line 11, outside both, was refused. On #42, whose base advanced, line 18 was accepted although it is in the diff from the current base `13fddb7` to the reviewed commit and not in the diff from their merge base (`e1-42-f-twodot-only-right18-create.json`, and its `diff_hunk` in `e1-42-after-pull-comments.json`). So the diff runs from the pull request's current base commit to the reviewed commit.
3. **How are those comments shown: outdated, or moved?** By the API fields, neither. Each comment's `commit_id` stays the reviewed commit, `position` equals `original_position`, and GraphQL reports `outdated: false` and thread `isOutdated: false`, even on the discarded commits and on line 5, which the head dropped. They are not moved to the head, unlike the existing comments in E3. The exception is #42's line 18, outdated from creation (`position` 1). Evidence: `e1-<pr>-after-pull-comments.json`, `e1-<pr>-after-graphql.json` and the later readbacks. Rendering was NOT observed, so where the web interface shows them is unknown.
4. **Does GitHub itself enforce that the commit belongs to the PR?** No, observed. Reviews with `commit_id` from an unrelated branch and from another experiment's fixture were accepted on #44, inline and body-only, and their inline comments sit on files #44 does not contain. Evidence: `e1-44-n1-unrelated-inline-create.json` to `e1-44-n4-other-fixture-body-create.json`, and `e1-44-after-pull-comments.json`.
5. **Can a pending review created before a rewrite be submitted afterwards, and what are its `commit_id` and the comments' state then?** Yes, observed. Review 5356480526 (#41) was submitted with HTTP 200 after its reviewed commit `e69981e` was discarded. Its `commit_id` stayed `e69981e`, and so did the timeline item's commit. Its comments kept the state they had while pending: line 6 at the head `b3e3ed7`, not outdated; line 5 outdated, `line: null`, `commit_id` the discarded intermediate head `3007343`. The forward-push control (5356482670, #44) behaved the same, with both comments at the head. Evidence: `e3-41-submit-5356480526.json`, `e3-41-after-*.json`, `e3-44-submit-5356482670.json`, `e3-44-after-*.json`.

## Inferences, not observations

- **Why #42's line 18 is outdated.** `original_position` 16 counts the diff from `13fddb7`, and `position` 1 with `outdated: true` suggests GitHub then re-resolved the comment against a diff without that line, perhaps the one from the merge base `7b5863e`. The other cases are not outdated because their lines sit in the first hunk, which is the same in both diffs. This is an explanation of the fields; it was not tested separately.
- **No association check.** Since GitHub accepted foreign commits, any check that a reviewed commit belongs to the pull request (EC9) must be the tool's own. The host does not provide one.
- **Rendering of new historical comments.** The API fields place them at the reviewed commit, neither at the head nor outdated. It is plausible that the web interface shows them in the conversation with the reviewed diff hunk, and not in the current "Files changed" diff, but this was not observed.

## Denied or skipped requests

GitHub denied nothing: every refusal is one of the six recorded 422s, and each was an intended case.

Locally, a steering hook stops each new `gh api` command on its first run and asks for a reason. Every `gh api` command was run once plainly, stopped by the hook, and rerun unchanged with the reason "bounded doc-linter fixture experiment approved by the owner; no gh subcommand creates historical-commit reviews". No command was routed around the hook. No screenshots were taken.
