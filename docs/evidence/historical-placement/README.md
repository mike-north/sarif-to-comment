# Historical placement on a discarded reviewed commit: live publication

Run at about 03:20 UTC on October 1, 2026, in `mike-north/doc-linter`, on draft pull request [#41](https://github.com/mike-north/doc-linter/pull/41), a fixture of the [force-push experiment](../../force-push-experiment.md). The product was this repository at commit `2a2569d` (built `dist/`, run as `node dist/sarif-to-comment.cjs`), with the [specification's R13.1 and R17](../../specification.md#r131-the-reviewed-diff-historical-placement-and-native-suggestions). One authenticated account (`mike-north`) made every request.

Under the [evidence policy](../../evidence-policy.md), this record is historical. It is not updated to follow later changes to the fixture.

## Fixture

| Object | Value |
|---|---|
| Pull request | #41, open draft, base `c29a1b2`, head `b3e3ed7` |
| Reviewed commit R | `e69981ed42926b07d0ff3f25d98558229afd348e`, discarded by two amends: it is not in the pull request's commits, and the first `HeadRefForcePushedEvent` names it as `beforeCommit` |
| File | `docs/experiments/forcepush/sample-amend.md`. R changes lines 5 and 6; the head keeps line 6's change, drops line 5's and changes line 15 |
| Pending reviews of this account on #41 before the run | none (`gh pr view 41 --json reviews`) |

## What was written

Exactly one object: the pending review **5374560867**, created by `publish` with no `--submit`. It was left pending. Nothing was submitted, applied, pushed, merged or closed, and `main` was not touched.

The document ([`review.sarif`](review.sarif)) has two findings on the reviewed file: one on line 3, a context line that neither R nor the head changed, and one on line 6 with a fix that replaces that line, which R changed and the head left unchanged.

## Commands

The token was passed inline from `gh auth token` with `GITHUB_TOKEN` unset, and never printed or saved.

1. `sarif-to-comment validate --sarif review.sarif --repo mike-north/doc-linter --pull 41 --commit e69981ed… --format json`: exit 0, `ready`, "2 inline comment(s) and 0 general section(s)", no diagnostics ([`validate.json`](validate.json)). So the association check found R (it is the `beforeCommit` of a force-push event), and no `reviewed-commit-association-unknown` note was reported.
2. `sarif-to-comment publish` with the same arguments and `--state`: exit 0, `published`, review 5374560867, no diagnostics ([`publish.json`](publish.json); the publication state, including the exact request sent, is [`state.json`](state.json)).
3. Readback with GETs only: `GET …/pulls/41/reviews/5374560867` ([`review-5374560867.json`](review-5374560867.json)), `GET …/pulls/41/reviews/5374560867/comments` ([`review-5374560867-comments.json`](review-5374560867-comments.json)), and one GraphQL query of the review threads and force-push events ([`pull-41-threads-and-force-pushes.graphql`](pull-41-threads-and-force-pushes.graphql), answer in [`pull-41-threads-and-force-pushes-graphql.json`](pull-41-threads-and-force-pushes-graphql.json)).

A local steering hook stops each new `gh api` command on its first run; each was rerun unchanged with the reason "verify a bounded doc-linter fixture publication". No command was routed around it.

## Result

| Field | Value |
|---|---|
| Review | 5374560867, `PENDING`, `commit_id` `e69981e…` (the reviewed commit, not the head) |
| Comment 4151501976 | RIGHT line 3 at `e69981e`; REST `commit_id` and `original_commit_id` `e69981e`, `position` = `original_position` = 2; GraphQL `line` 3, `originalLine` 3, `outdated: false`, thread `isOutdated: false` |
| Comment 4151501982 | RIGHT line 6 at `e69981e`, carrying the native suggestion `Line 06: reviewed change two (added by C1), checked historically.`; `position` = `original_position` = 7; GraphQL `line` 6, `originalLine` 6, `outdated: false`, thread `isOutdated: false` |
| Force-push events | `filteredCount` 2: `e69981e` → `3007343`, then `3007343` → `b3e3ed7` |

GitHub accepted both inline comments at the discarded commit, with the lines the tool computed from the reviewed diff (`c29a1b2...e69981e`, one hunk over lines 2–9): position 2 is line 3 and position 7 is the added line 6 of that hunk. Before this change the tool would have put both findings in the review body and refused the fix with `suggestion-reviewed-commit-not-head`.

## Establishes

- The product, end to end against live GitHub, creates a pending review at a reviewed commit a force-push discarded, with an inline comment on an unchanged line and a native suggestion, and GitHub accepts them at that commit, neither moved nor outdated.
- The association check accepted the discarded commit through the force-push timeline, without a note.

## Does not establish

- Rendering in the web interface, or whether the suggestion can be applied; GH-19 records application for suggestions created this way, within its limits. The review was left pending and nothing was applied.
- The rebased case, where the base also changed the reviewed file (handled by withholding the patch, tested against a simulated host only), a refused association (tested against a simulated host only), forks, other accounts, multi-line ranges.
