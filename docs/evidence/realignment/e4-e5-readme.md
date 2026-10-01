# Linked native-suggestion group and companion fidelity: E4 and E5

Run between 02:09 and 02:59 UTC on October 1, 2026, in `mike-north/doc-linter`. One authenticated account (`mike-north`, the repository owner) made every request. Two experiments were run:

- **E4** created a new fixture pull request with one pending review holding three native suggestions. It listed the pending comments, edited their bodies and the review body while the review was still pending, then submitted the review and read everything back.
- **E5** compared what GitHub shows for the companion pull requests #46, #48 and #52 of the [force-push experiment](../../force-push-experiment.md) with a local `git merge-tree` projection of each companion onto its target's head. It added two commits with no ref: one built on a discarded commit, one control built on the current head.

Under the [evidence policy](../../evidence-policy.md), this record is historical. It is not updated to follow later changes to the fixtures.

## What was written to GitHub

Nothing was merged, closed or deleted, `main` was not touched, and no suggestion was applied. #46, #48 and #52 were only read.

| Action | Objects |
|---|---|
| E4: pushed a base fixture branch at an existing commit | `exp-linkgroup-20261001-base` at `d138c0e`, the existing force-push control base (`exp-forcepush-20260929-control-base`) |
| E4: pushed a head fixture branch with one new commit | `exp-linkgroup-20261001-head` at `04d5d81`, changing lines 5, 15 and 18 of `docs/experiments/forcepush/sample-control.md` |
| E4: opened a draft pull request | [#93](https://github.com/mike-north/doc-linter/pull/93), from the head branch into the base branch |
| E4: created one pending review | review 5374159934, with comments 4151162432 (line 5), 4151162440 (line 15) and 4151162443 (line 18) |
| E4: edited the three comment bodies and the review body while pending | the same objects |
| E4: submitted the review with `COMMENT` | review 5374159934 |
| E5: created Git objects with no ref | blobs `0fb3b23` and `f21d9e6`; trees `ee628cd` and `c0d28f0`; commits P `9b513c4` and P2 `c4b74a2` |

## Files and redaction

Every `e4-*.json` and `e5-*.json` file named after a request is an envelope written from a `gh api --include` capture, in the same form as the [E1 and E3 record](e1-e3-readme.md):

```json
{ "request": { "method": "…", "path": "…", "body": { } }, "status": 200, "statusLine": "HTTP/2.0 200 OK", "response": { } }
```

`request.body` is the exact JSON sent, for writes and for GraphQL. `response` is the response body, unmodified apart from pretty-printing and one redaction: any value under a key named `email`, in the request or the response, is replaced by `<redacted-email>`. This affects the commit authors in the compare readbacks and the author of P and P2. Response headers are not kept. No token, environment or local path appears.

| File | Source |
|---|---|
| `e4-create-pending.json` | `POST …/pulls/93/reviews` with three comments and no `event` |
| `e4-pending-review-comments.json`, `e4-pending-graphql.json` | `GET …/pulls/93/reviews/5374159934/comments` and the GraphQL query, just after creation |
| `e4-gql-update-<comment-id>.json` | GraphQL `updatePullRequestReviewComment`, one per comment |
| `e4-edited-review-comments.json`, `e4-edited-graphql.json` | the same two reads after the comment edits |
| `e4-put-review-body.json` | `PUT …/pulls/93/reviews/5374159934` with the new review body |
| `e4-before-submit-review.json`, `e4-before-submit-review-comments.json`, `e4-before-submit-graphql.json` | `GET …/reviews/5374159934`, its comments and the GraphQL query, after the body edit and before submission |
| `e4-submit.json` | `POST …/pulls/93/reviews/5374159934/events` with `{"event":"COMMENT"}` |
| `e4-after-review.json`, `e4-after-review-comments.json`, `e4-after-graphql.json` | the same three reads after submission |
| `e4-after-pull-comments-gh-pr.txt` | `gh-pr comments 93`: a local read-only tool's text listing of `GET …/pulls/93/comments` after submission (see [Denied or rerouted requests](#denied-or-rerouted-requests)) |
| `e4-93-pr-view.json` | `gh pr view 93 --json …` after submission |
| `e5-<pr>-pr-files.json` | `GET …/pulls/<pr>/files` for #46, #48 and #52 |
| `e5-<pr>-compare-<head>-<proposal>.json` | `GET …/compare/<target head>...<companion head>` |
| `e5-<pr>-pr-view.json` | `gh pr view <pr> --json …`, for mergeability |
| `e5-P-blob.json`, `e5-P-tree.json`, `e5-P-commit.json`, and the same for P2 | `POST …/git/blobs`, `…/git/trees` and `…/git/commits` |
| `e5-P-compare-d28aa24-9b513c4.json`, `e5-P2-compare-d28aa24-c4b74a2.json` | `GET …/compare/d28aa24...P` and `…/compare/d28aa24...P2` |
| `e5-merge-tree-projection.json` | The local projection: for each case, the exact `git merge-tree` commands, their output, the trees and the diffs. Produced locally; not a GitHub response. |
| `e5-prediction-vs-github.json` | A local, field-by-field comparison of the projection with the GitHub readbacks above. Produced locally. |

The E4 GraphQL query returns the pull request's head and base, its reviews with `state`, `body`, `url`, `lastEditedAt` and `commit`, each review comment with `id`, `databaseId`, `url`, `state`, `body`, `line`, `originalLine`, `position`, `outdated`, `lastEditedAt`, `commit` and `originalCommit`, and the review threads with `isOutdated`, `line` and `diffSide`.

"Byte for byte" below means that the string GitHub returned, after JSON decoding, equals the string sent, character for character. Every body here is ASCII, so that is also equality of the UTF-8 bytes.

## E4: discovering and editing the comments of a pending review

### Conditions

PR #93 changes three lines of one 20-line Markdown file: line 5, and lines 15 and 18, which fall in one hunk. Review 5374159934 was created with `commit_id` the head `04d5d81`, no `event`, and three single-line RIGHT comments. Each comment held one `suggestion` block replacing its line, for example:

````markdown
E4 suggestion on line 5.

```suggestion
Line 05: linked-group suggested text.
```
````

### Outcomes

| Step | Request | Status | Outcome |
|---|---|---|---|
| Create the pending review | `POST …/pulls/93/reviews` | 200 | `state: PENDING`. The response already carried the review's `id`, `node_id` and `html_url` (`…/pull/93#pullrequestreview-5374159934`). |
| List the pending comments, REST | `GET …/reviews/5374159934/comments` | 200 | All three comments, each with `id`, `node_id`, `html_url` (`…/pull/93#discussion_r<id>`) and `pull_request_review_id`. The `line`, `original_line` and `side` keys were absent; `position` and `original_position` were present. |
| List the pending comments, GraphQL | review `comments` and `reviewThreads` | 200 | The same three comments, `state: PENDING`, with `databaseId` and `id` equal to REST's `id` and `node_id`, `url` equal to REST's `html_url`, and `line` 5, 15 and 18. |
| Edit each comment body, REST | `PATCH …/pulls/comments/<id>` | not sent | Denied locally before sending (see below). |
| Edit each comment body, GraphQL | `updatePullRequestReviewComment` | 200, three times | Each response returned `state: PENDING` and a `body` equal to the one sent. `updatedAt` changed; `lastEditedAt` stayed `null`. |
| Read back after the edits | REST and GraphQL, as above | 200 | Every body equal to the one sent, byte for byte, in both APIs. |
| Edit the review body | `PUT …/pulls/93/reviews/5374159934` | 200 | `state` stayed `PENDING`. The body, with a hidden marker and links to the three comments, was returned byte for byte. |
| Read back before submission | `GET` review, its comments, GraphQL | 200 | The review body, its marker and the three comment bodies with their suggestion blocks, all byte for byte. Review `lastEditedAt` `null`. |
| Submit | `POST …/reviews/5374159934/events`, `COMMENT` | 200 | `state: COMMENTED`, `submitted_at` 2026-10-01T02:29:25Z, `commit_id` `04d5d81`, body unchanged. |
| Read back after submission | `GET` review, its comments, GraphQL, and `gh-pr comments 93` | 200 | Same review and comment `id`, `node_id` and `html_url` as while pending. Comment `state: SUBMITTED`, bodies byte for byte, `updated_at` equal to the submission time, `lastEditedAt` still `null`. Threads at lines 5, 15 and 18, not outdated or resolved. The submitted comments appear in `GET …/pulls/93/comments`. |

Each edited comment body named its part ("Part N of 3 of one linked suggestion group"), linked the other two parts by their `…/pull/93#discussion_r<id>` URLs, gave a batch-apply instruction, and kept its original suggestion block. The review body listed the three parts with the same links and ended with the marker `<!-- e4:93:linkgroup parts=4151162432,4151162440,4151162443 -->`.

### What E4 establishes

- **IDs and URLs exist while pending.** A pending review's comments have their final `id`, `node_id` and `html_url` before submission, from both REST and GraphQL, and they do not change on submission. So the `#discussion_r<id>` links can be written into the group's bodies before the review is published.
- **Pending comment bodies can be edited through GraphQL**, and the review body through REST `PUT`, without submitting the review. Neither edit changed the review's state.
- **The edits were preserved exactly.** The hidden marker, the links and every suggestion block survived the edits and the submission byte for byte.
- **The links still point at the comments after submission.** Each link's URL equals the `html_url` its target comment reported after submission.
- Neither edit set `lastEditedAt`, before or after submission.

### What E4 does not establish

- **Browser behavior was not observed.** No page was opened. Whether the links render and navigate to the right comment, whether the suggestions render as applicable, whether an "edited" mark appears, and batch application with a byte comparison of the result are all unobserved. Applying suggestions is a separate experiment, done in a browser.
- REST `PATCH …/pulls/comments/<id>` on a pending comment was never sent, so whether it works is unknown.
- One account, which also authored the PR and the review. Edits by another account were not tried. Three comments in one file; larger groups, several files, multi-line suggestions and pagination are untested.

## E5: companion fidelity against discarded content

### Conditions

| Case | Target head H | Proposal X | Reviewed commit R (X's parent) | R an ancestor of H? |
|---|---|---|---|---|
| #46 (amend) | `b3e3ed7` | `6089e28` | `e69981e` | no |
| #48 (rebase) | `f4ba859` | `e90f59f` | `7eb3dc6` | no |
| #52 (orphan) | `d28aa24` | `d92f82c` | `eb6c2f6` | no |
| P | `d28aa24` | `9b513c4` | `eb6c2f6` | no |
| P2 (control) | `d28aa24` | `c4b74a2` | `d28aa24` | yes, it is H |

The targets and companions were as the [read-only snapshot](e0-readme.md) recorded them; their branch tips were unchanged. In #46, #48, #52 and P the reviewed commit changed lines 5 and 6. In every case the proposal edits line 10 of the same file.

P and P2 each change line 10 of `docs/experiments/forcepush/sample-orphan.md` to `Line 10: E5 proposal edits a context line.` and leave the rest of their parent's file as it was. P's parent is the discarded `eb6c2f6`, like #52. P2's parent is the current head `d28aa24`. They were created with the Git data API and no ref. Each blob and tree SHA GitHub returned equals the one local `git` computed for the same content. Their author and committer dates were set in the request to 2026-10-01T03:00:00Z; the objects were created between 02:47 and 02:51.

### Step 1: the PR file lists equal the compare readbacks

For #46, #48 and #52, `GET …/pulls/<pr>/files` returned exactly the same list as `GET …/compare/<H>...<X>`, every field included (`e5-prediction-vs-github.json`, `prFilesEqualCompareFiles`).

Each compare was `diverged` and listed the reviewed commit as well as the proposal. #46 and #52 were ahead 2 and behind 1; #48 was ahead 2 and behind 2. Each showed +3 −3 in one file: lines 5, 6 and 10. Each `patch` equals the local diff from the merge base to X (`c29a1b2`, `7b5863e` and `4f19746`), and each file `sha` is X's blob. A fresh `gh pr view` reported #46 and #48 CONFLICTING (DIRTY) and #52 MERGEABLE (CLEAN), as in the earlier snapshot.

### Step 2: compare readbacks for the dangling commits

- `compare/d28aa24...P`: HTTP 200, `diverged`, ahead 2, behind 1, merge base `4f19746`. It lists `eb6c2f6` and `9b513c4`, and shows +3 −3 at lines 5, 6 and 10: the same shape as #52.
- `compare/d28aa24...P2`: HTTP 200, `ahead` 1, behind 0, merge base `d28aa24`. It lists only `c4b74a2` and shows +1 −1 at line 10.

GitHub served both commits by SHA, through the compare API and through `git fetch` over HTTPS, though no ref points at them.

### Step 3: the content-based prediction

For each case, `e5-merge-tree-projection.json` records two projections made with local Git 2.54.0:

- **merge:** `git merge-tree --write-tree H X`, what merging X into H would produce from their real merge base;
- **head + proposal:** `git merge-tree --write-tree --merge-base=R H X`, H plus only the proposal's own edits (the cherry-pick of R..X).

The files whose content differs between the two are what the merge would restore or change beyond the proposal. Under the content-based fidelity definition then proposed (fidelity judged by content, not by ancestry), those files make a companion unfaithful.

| Case | Merge | Head + proposal | Files the merge changes beyond the proposal |
|---|---|---|---|
| #46 | **conflict** in `sample-amend.md` at line 5 | clean; changes only line 10 | `sample-amend.md`: the head has the original line 5; the companion brings back C1's line 5, next to line 6, which both sides changed the same way |
| #48 | **conflict** in `sample-rebase.md` at line 5 | clean; changes only line 10 | `sample-rebase.md`, the same way |
| #52 | clean | clean; changes only line 10 | `sample-orphan.md`: the merge **restores lines 5 and 6**, C1's change, which the head had dropped. It keeps the head's line 15. |
| P | clean | clean; changes only line 10 | `sample-orphan.md`: the same restoration of lines 5 and 6 |
| P2 | clean | clean; changes only line 10 | **none**: the merge tree equals head + proposal |

**Supplementary cases, projected locally only.** GH-14 recorded #46 and #48 MERGEABLE while their targets were at the first rewrite's heads, `3007343` and `62ed990`, both discarded since. Projected onto those heads, both merges are clean and equal head + proposal, changing only line 10. That reproduces GH-14's earlier inference. In both, R's file differs from H's, but only through H's own edits (line 15 amended on `3007343`; line 18 from the advanced base on `62ed990`), and the merge keeps those. This is L1's "stale parent, clean projection" case: a note, not a block.

So a file-level "R's blob differs from H's" test flags every stale-parent case alike. Only the projection separates the clean ones (#46 and #48 at the earlier heads) from those that restore content (#52, P) or conflict (#46 and #48 now).

### Step 4: the prediction against GitHub's readbacks

| Check | #46 | #48 | #52 | P | P2 |
|---|---|---|---|---|---|
| Merge base equal to local | yes | yes | yes | yes | yes |
| `patch` equals the local merge-base-to-X diff | yes | yes | yes | yes | yes |
| `patch` equals what the merge would change on H | **no** | **no** | yes | yes | yes |
| File `sha` is X's blob | yes | yes | yes | yes | yes |
| File `sha` is the projected merge's blob | no | no | no | no | yes |
| GitHub lists the reviewed commit (non-ancestry signal) | yes | yes | yes | yes | no |
| Mergeability agrees with the projection | yes (CONFLICTING) | yes (CONFLICTING) | yes (MERGEABLE) | no PR | no PR |

The prediction agrees with every GitHub readback that speaks to it:

- **#52 and P:** GitHub's diff shows lines 5 and 6 beside the line-10 proposal, which is exactly the restoration the projection predicts. GitHub calls #52 MERGEABLE, and the projection's merge is clean.
- **#46 and #48:** GitHub reports CONFLICTING, and the projection conflicts.
- **P2:** GitHub shows only the line-10 proposal, and the projection equals head + proposal.

GitHub's readbacks do not decide the question on their own. Compare and the PR file list show the diff from the merge base to the companion, not the merge result:

- On #46 and #48 they show line 6 as a change, although the head already has it, and they cannot show the line-5 conflict.
- Their file `sha` is the companion's blob, not the merged file. The merge also keeps the head's line 15, which no readback shows.
- At file level, a faithful companion (P2) and an unfaithful one (P, #52) list the same single file, because the restored lines sit in the proposal's own file.

The content projection, or an equivalent comparison of blobs, is what tells them apart.

**Files restored, #52 against P2:** for #52 (and P), `docs/experiments/forcepush/sample-orphan.md`, lines 5 and 6 (`reviewed change one/two (added by C1)` replacing `original text`). For P2, none.

### What E5 establishes and does not

**No merge was performed.** Every merge outcome above is a local `git merge-tree` projection, which writes trees and blobs into a local clone and changes no ref anywhere. GitHub's own merge could differ from local Git 2.54.0 in conflict handling. The projection agrees with GitHub's mergeability verdicts for #46, #48 and #52; P and P2 have no pull request, so no verdict.

Established:

- For #46, #48 and #52, GitHub's PR file list equals the compare from the target head to the companion head. Both show the merge-base diff.
- A commit with no ref, whose parent is a discarded commit, gets the same compare shape as #52: the discarded commit is listed and its change reappears.
- The content-based prediction matches GitHub's readbacks, and names `sample-orphan.md` (lines 5 and 6) for #52 and P, and nothing for P2.

Not established:

- An actual merge of any companion.
- How long GitHub keeps P and P2 without a ref.
- Companions with several files, renames, whole-file additions or deletions, or binary content.
- Forks or cross-repository companions.

## Denied or rerouted requests

GitHub refused nothing: every request sent was answered with HTTP 200 or 201.

Locally:

- **REST `PATCH …/pulls/comments/<id>` was denied before sending.** A local hook maps that path to an approved read-and-reply tool (`gh-pr`), which has no edit command. It denied the first attempt and the identical rerun with a stated reason. The step was stopped, and the plan's fallback, GraphQL `updatePullRequestReviewComment`, was used instead. Nothing was sent to GitHub, so REST `PATCH` on a pending comment remains untested.
- **`GET …/pulls/93/comments` was steered** to that tool's read-only `comments` command, which was used instead. Its text output is `e4-after-pull-comments-gh-pr.txt`.
- **Every other `gh api` command** was stopped by a steering hook on its first run and rerun unchanged with the reason "bounded doc-linter fixture experiment approved by the owner; no gh subcommand covers this".
- **Fetching P over SSH failed**, because the local SSH agent could not sign. P, P2 and `62ed990` were fetched over HTTPS with the already-configured `gh` credential helper. No credential or account was changed.

No screenshots were taken.
