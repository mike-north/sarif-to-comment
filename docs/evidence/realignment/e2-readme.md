# Applying native suggestions after the head moved: E2

Run between 02:17 and 02:31 UTC on October 1, 2026, in `mike-north/doc-linter`, on two new draft pull requests made for this experiment. One authenticated account (`mike-north`, the repository owner and the pull requests' author) made every request and every web-interface action. Suggestions were applied in a signed-in Chrome session, because the API cannot apply a suggestion.

The question: does a native suggestion whose comment is anchored at a commit that is no longer the head apply to exactly the intended bytes, and how does the web interface treat it?

Under the [evidence policy](../../evidence-policy.md), this record is historical. It is not updated to follow later changes to the fixtures.

## Fixtures

Every object below was created for E2. `main` and the earlier fixtures (#41–#52) were not touched.

| Object | Value |
|---|---|
| Base branch `exp-e2-20261001-base` | `0c03fd7`, one commit on the fixture commit `d138c0e` (the base of #44), not on `main`'s tip. It adds two 20-line files, `docs/experiments/e2/sample-ancestor.md` and `sample-discarded.md`, each line reading `Line N: original text.` |
| R on each feature branch | One commit on `0c03fd7` that rewrites lines 5–9 of its own file to `Line N: reviewed change (R).`: `1b3d51f` (ancestor) and `639c1f8` (discarded). |
| [#94](https://github.com/mike-north/doc-linter/pull/94), ancestor case | `exp-e2-20261001-ancestor` into the base branch. After the first review, an ordinary fast-forward push added F `511cd5e`, which changes only line 6 to `Line 6: head change (F).` R stays an ancestor of the head. |
| [#95](https://github.com/mike-north/doc-linter/pull/95), discarded case | `exp-e2-20261001-discarded` into the base branch. After the first review, a force-push replaced R with R′ `54bd5cd`, whose parent is `0c03fd7`. R′ equals R except line 6, `Line 6: rewritten change (R').` R is no longer in the pull request. |

Both pull requests have the same shape, so each case has an unchanged line set (5, 7, 8, 9) and one line the head changed (6).

## Suggestions

Each suggestion is a single-line RIGHT comment whose body is a marker sentence and one fence:

````markdown
E2 fixture suggestion H7 (ancestor).

```suggestion
Line 7: applied H7 (ancestor).
```
````

Three submitted reviews per pull request (`event: COMMENT`), each created with `POST …/pulls/<pr>/reviews`:

| Review | `commit_id` | Created | Suggestions | #94 | #95 |
|---|---|---|---|---|---|
| P | R | Before the push, while R was the head | P5 (line 5, unchanged at the head), P6 (line 6, changed by the head) | 5374198581 | 5374198882 |
| H | R | After the push, so R was not the head (on #95, no longer in the PR) | H6 (changed), H7 and H8 (unchanged) | 5374213771 | 5374214025 |
| C | the head (F or R′) | After the push | C9 (control, line 9) | 5374213903 | 5374214161 |

So the cases asked for are covered twice: by a suggestion created at R before the head moved (P), and by one created afterwards with a historical `commit_id` (H).

## State before any application

From `GET …/pulls/<pr>/comments` and the GraphQL threads (`e2-<case>-before-apply-*.json`). Both pull requests showed the same pattern.

| Suggestion | REST `commit_id` / `original_commit_id` | `line` / `position` | GraphQL `outdated` | Web interface |
|---|---|---|---|---|
| P5 | head / R | 5 / 9 | `false` | Shown in Files changed at line 5. "Apply suggestion" enabled in the conversation; "Add to batch" and "Commit suggestions" in Files changed. |
| P6 | R / R | `null` / 1 | `true` | Labelled **Outdated** in the conversation; both buttons disabled, "Outdated suggestions cannot be applied." Absent from Files changed. |
| H6 | R / R | 6 / 10 | **`false`** | Labelled **Outdated** in the conversation; both buttons disabled, "Outdated suggestions cannot be applied." Absent from Files changed. |
| H7, H8 | R / R | 7, 8 / 11, 12 | `false` | Shown in Files changed at their lines of the current diff, with "Add to batch" and "Commit suggestions". |
| C9 | head / head | 9 / 13 | `false` | As H7. |

In the conversation tab, "Add suggestion to batch" is disabled for every suggestion, with "Batching suggestions must be done from the files tab."

H6 is the notable row: the API reports it current at R, not outdated, but the web interface treats it as outdated and refuses to apply it. P6, the same change created before the push, is outdated in both.

Screenshots: `e2-<case>-ui-conversation-*.jpg` and `e2-<case>-ui-files-*.jpg`.

## Applications

All in Files changed, each with an identifying commit message:

| PR | Commit | Mode | Suggestions | Parent |
|---|---|---|---|---|
| #94 | `f3a01c6` | single ("Commit suggestions") | H7 | `511cd5e` (F) |
| #94 | `15af1b1` | batch of two | H8 (at R) + C9 (at the head) | `f3a01c6` |
| #94 | `e0414c3` | single | P5 | `15af1b1` |
| #95 | `255d5dc` | single | H7 | `54bd5cd` (R′) |
| #95 | `4f2f59b` | batch of two | P5 + H8 (both at the discarded R) | `255d5dc` |
| #95 | `cc0f422` | single | C9 (control) | `4f2f59b` |

P6 and H6 were not applied on either pull request, because the interface offered no way to apply them.

Each applied commit has one parent, the previous head, and changes only the fixture file. Each is authored by Mike North, committed by GitHub, and signature-verified. GitHub appended a `Co-authored-by:` trailer for the suggestion author to the two batch commits, and not to the single ones.

## Exact bytes

Method, as in GH-08 (`e2-applied-files.json`): each applied commit was fetched into a local clone. The expected bytes are the parent's blob with exactly the suggested lines replaced by the suggestion payload plus LF. The actual bytes are `git show <commit>:<path>`. They were compared byte for byte and by Git blob id. Independently, the file at each commit was read through the contents API with the raw media type, and those bytes were compared with `git show`.

| PR | Commit | Suggestions | Expected blob | Actual blob | Exact bytes | Only the file changed | Raw API read equal |
|---|---|---|---|---|---|---|---|
| #94 | `f3a01c6` | H7 | `07fb292` | `07fb292` | yes | yes | yes |
| #94 | `15af1b1` | H8 + C9 | `2cd9a29` | `2cd9a29` | yes | yes | yes |
| #94 | `e0414c3` | P5 | `ee5d871` | `ee5d871` | yes | yes | yes |
| #95 | `255d5dc` | H7 | `10d7074` | `10d7074` | yes | yes | yes |
| #95 | `4f2f59b` | P5 + H8 | `e7b97ec` | `e7b97ec` | yes | yes | yes |
| #95 | `cc0f422` | C9 | `6a7f385` | `6a7f385` | yes | yes | yes |

The expected bytes keep the head's line 6 (`head change (F)` on #94, `rewritten change (R')` on #95). So applying a suggestion anchored at R changed only its own line of the **head's** file. It did not restore R's version of line 6, or anything else from R.

## State after application

From `e2-<case>-after-apply-*.json`. Each pull request is still an open draft, MERGEABLE and clean, with 5 commits (#94) and 4 commits (#95).

- Every applied suggestion's thread is resolved (`isResolved: true`).
- Every thread now reports `outdated: true`, `line: null` and `position` 1, the applied ones and the unapplied P6 and H6 alike, because each commit changed the lines under the remaining comments.
- P6 and H6 are still unresolved.

## Establishes

On one account's same-repository draft pull requests, for one-line LF replacements:

1. **Ancestor case.** A suggestion created at R before an ordinary push (P5), or afterwards with `commit_id` R (H7, H8), on a line the head did not change, was offered in Files changed, and applied to exactly the intended bytes of the head's file, singly and in a batch.
2. **Discarded case.** The same held after a force-push had removed R from the pull request. H7, H8 and P5 were anchored at the discarded R (or, for P5, moved to the head by GitHub) and applied exactly to the rewritten head.
3. **Mixed batch.** A batch combining a suggestion at a historical `commit_id` with one at the head (#94: H8 + C9) produced one commit with exactly both edits.
4. **Changed lines were not applicable.** On a line the head changed, neither the suggestion created before the push (P6) nor the one created afterwards at R (H6) could be applied. The web interface marked both "Outdated" and disabled both buttons. So no observed application overwrote the head's changed line.
5. **API state and the web interface disagreed for H6.** The API reported H6 not outdated (`outdated: false`, `line` 6), while the interface treated it as outdated. API `outdated` therefore does not predict whether the interface will offer application.
6. **Rendering of historical suggestions (GH-16's open question, for suggestions).** New comments at a historical `commit_id` on unchanged lines appeared in the current Files changed diff at their line. On a line the head changed, they appeared only in the conversation, as outdated.

## Does not establish

- Other accounts: a reviewer who is not the pull request's author, a user without write access, or a GitHub App identity.
- Forks or cross-repository pull requests.
- Other suggestion shapes: multi-line ranges, insertions, deletions, CRLF, final lines, nested fences, or file-level comments (GH-08 and GH-09 cover some shapes, at the head only).
- A suggestion on a line the head changed to the **same** text as the suggestion's original, or one adjacent to a changed line.
- Applying from the conversation tab ("Apply suggestion"); every application here used Files changed.
- Larger batches, or batches across files.
- A commit whose `commit_id` is unrelated to the pull request (GH-16's negative controls); no suggestion was placed there.
- Why the interface treats H6 as outdated while the API does not. One plausible inference is that the interface compares the anchored line's text at the head with its text at the comment's commit. It was not tested separately.
- Merging. Nothing was merged or closed.

## Files and redaction

Every JSON file except `e2-applied-files.json` is an envelope written from a `gh api --include` capture, as in the [E1 and E3 record](e1-e3-readme.md):

```json
{ "request": { "method": "…", "path": "…", "body": { } }, "status": 200, "statusLine": "HTTP/2.0 200 OK", "response": { }, "ghCliError": "…" }
```

Emails are redacted: any value under a key named `email`, and any email address inside a string (for example in a commit signature's `verification.payload` or a `Co-authored-by:` trailer), is replaced with `<redacted-email>`. A redacted signature payload no longer verifies. No token, environment or local path appears.

| Files | Source |
|---|---|
| `e2-setup-base-*.json` | Git data API: tree, commit and ref for the base branch |
| `e2-<case>-r-*.json`, `e2-<case>-ref.json` | Tree, commit and ref for R |
| `e2-ancestor-f-*.json` | Tree and commit for F, and the fast-forward ref update (`force: false`) |
| `e2-discarded-rprime-*.json` | Tree and commit for R′, and the forced ref update (`force: true`) |
| `e2-<case>-pr-create.json`, `e2-<case>-pr-after-push.json` | `POST …/pulls` (draft), and `GET …/pulls/<pr>` after the push |
| `e2-<case>-review-{P,H,C}-create.json` | `POST …/pulls/<pr>/reviews`, with the exact body sent |
| `e2-<case>-before-apply-pull-comments.json`, `…-graphql.json` | `GET …/pulls/<pr>/comments` and the GraphQL thread query, after all reviews and before any application |
| `e2-<case>-after-apply-*.json` | The same reads after the applications, plus `GET …/pulls/<pr>` and `GET …/pulls/<pr>/commits` |
| `e2-<case>-commit-<sha>.json` | `GET …/commits/<sha>` for every commit in each pull request |
| `e2-applied-files.json` | The exact-bytes comparison above, with each commit's actual text |
| `e2-<case>-ui-*.jpg` | Browser screenshots: conversation and Files changed states, the commit dialog, the batch panel, and the final diff |

The GraphQL query returns the pull request's head and base, its commits, its reviews with `commit` and `state`, and its review threads with `isOutdated`, `isResolved`, `line`, `originalLine` and `diffSide`, each comment with `outdated`, `line`, `originalLine`, `position`, `originalPosition`, `commit` and `originalCommit`.

## Denied requests and browser problems

GitHub denied nothing. Every request returned 200 or 201.

Locally, a steering hook stops each new `gh api` command on its first run. Every `gh api` command was run once plainly, stopped by the hook, and rerun unchanged with the reason "bounded doc-linter fixture experiment approved by the owner". One readback was redirected by the hook to the approved `gh-file read` tool, which was then used for the raw contents reads. No command was routed around the hook.

On #94, two attempts to add P5 to a batch did not register: the button stayed "Add to batch" and the batch panel did not list it. The file tree was expanded at the time, and once the batch panel opened, P5's card was too narrow to show the button. Following the two-failure rule, P5 was not retried for batching on #94. #94's batch used H8 + C9 instead, and P5 was applied singly. On #95, with the file tree collapsed, P5 was added to a batch at the first attempt. This is treated as a layout problem in the browser session, not a host behavior.
