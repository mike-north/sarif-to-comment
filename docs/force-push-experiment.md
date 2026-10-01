# Reviews and suggestion pull requests after a force-push

Run September 29, 2026 in `mike-north/doc-linter`, on draft pull requests [#41](https://github.com/mike-north/doc-linter/pull/41)–[#52](https://github.com/mike-north/doc-linter/pull/52), with sarif-to-comment at `6dade45`. The repository's `main` (`0a7b03f`) was never touched. The owner's decision on [issue #28](https://github.com/mike-north/sarif-to-comment/issues/28) rests on this experiment; its implementation's live evidence is in [force-push re-application evidence](force-push-reapply-e2e-evidence.md).

It asked four questions:

1. Does an existing review survive a force-push of the pull request's branch?
2. Can a new review be published for a commit the force-push discarded?
3. What does a suggestion pull request built on a discarded commit look like, and what would merging it do?
4. Does re-applying the suggested change on the new head give a clean suggestion pull request?

## Setup

Each variant had its own fixture base branch, so `main` stayed untouched. The base held C0, which adds a 20-line `docs/experiments/forcepush/sample-<variant>.md`; the pull request's branch added C1, which changes lines 5 and 6. The pull request's diff was therefore one modification hunk. Each review had a comment on line 5 and a comment on line 6 carrying a native suggestion.

| Pull request | Variant | Reviewed commit C1 | What happened to the branch | Review |
|---|---|---|---|---|
| [#41](https://github.com/mike-north/doc-linter/pull/41) | amend | `e69981e` | amended to C1′ `3007343` (also edits line 15), then to C1″ `b3e3ed7` (drops the line-5 change) | draft 5356480526 |
| [#42](https://github.com/mike-north/doc-linter/pull/42) | rebase | `7eb3dc6` | base advanced to `13fddb7`, rebased to C1′ `62ed990`, then C1″ `f4ba859` (drops the line-5 change) | submitted 5356481554 |
| [#43](https://github.com/mike-north/doc-linter/pull/43) | orphan | `eb6c2f6` | amended to C1′ `3f77a6e` (line 15), later to C1″ `d28aa24` (drops the whole C1 hunk) | draft 5356511269, published **after** the force-push, at `eb6c2f6` |
| [#44](https://github.com/mike-north/doc-linter/pull/44) | control | `91f433c` | an ordinary push of C2 `4b82f10` (line 15) | draft 5356482670 |

Each suggestion pull request was a draft from a branch whose single commit had C1 as its parent, into the original pull request's branch, exactly as sarif-to-comment builds proposal commits (the reviewed commit is the parent). Two suggestions were tried per variant: `line6` rewrites a line that C1 introduced, and `ctx` edits line 10, a context line C1 did not touch.

## Results

### 1. Existing reviews survive

| Case | Review still listed? | Its comments |
|---|---|---|
| #41 amend, hunk unchanged | yes, `PENDING`; the review's `commit_id` stays `e69981e` | both moved to the new head: `commit_id` `3007343`, position unchanged; not outdated |
| #42 rebase, hunk unchanged | yes, `COMMENTED` | both moved to `62ed990`, lines 5 and 6; not outdated |
| #44 control, ordinary push | yes | the same as above: a force-push and an ordinary push behave identically |
| #41 and #42, second rewrite dropping the line-5 change | yes | the line-5 comment became **outdated** (`line: null`, `commit_id` frozen at the last head where it applied); the line-6 comment moved to the new head |

For example, on #42 after the drop:

```json
{"id":4136702857,"commit_id":"62ed990…","original_commit_id":"7eb3dc6…","position":1,"original_position":6,"line":null,"original_line":5}
{"id":4136702859,"commit_id":"f4ba859…","original_commit_id":"7eb3dc6…","position":5,"original_position":7,"line":6,"original_line":6}
```

The native suggestion's body was intact. Discarded commits stayed reachable: in a fresh, empty repository, `git fetch --depth=1 <sha>` succeeded for all three discarded C1 commits, and GitHub's file and compare reads served them. Comparing `eb6c2f6...3f77a6e` reported +3/−3, which confirms that the reviewed C1 is not an ancestor of C1′.

### 2. GitHub accepts a new review on a discarded commit, silently

On #43, after the force-push (head `3f77a6e`), with the reviewed commit `eb6c2f6`:

- `validate` of plain feedback answered `ready`, with "0 inline comment(s) and 2 general section(s)": at a commit that is not the head, findings become review-body sections linking line 5 of the file at that commit (`blob/eb6c2f6…`, with the line anchor for line 5).
- `validate` of the same document with a native fix answered `blocked` (`suggestion-historical-unsupported`): "The reviewed commit is not the pull request head, so a native suggestion could not be applied to the reviewed text."
- `publish` of the plain feedback succeeded: pending review 5356511269 has `commit_id` `eb6c2f6…` while the pull request's only commit is `3f77a6e`. GitHub gave no warning, and the body's links resolve.

Inline comments at a discarded `commit_id` were not tried: the tool never sends them there.

### 3. A suggestion pull request built on a discarded commit drags that commit along

| Pull request | Target head, and its relation to C1 | Commits GitHub lists | Files | Mergeable |
|---|---|---|---|---|
| [#49](https://github.com/mike-north/doc-linter/pull/49) control `line6` | C2; C1 is an ancestor | `f013010` only | +1 −1 | MERGEABLE, clean |
| [#50](https://github.com/mike-north/doc-linter/pull/50) control `ctx` | the same | `15e360c` only | +1 −1 | MERGEABLE, clean |
| [#45](https://github.com/mike-north/doc-linter/pull/45) amend `line6` | C1′, after a harmless amend | **`e69981e`**, `599270d` | +2 −2 | **CONFLICTING** |
| [#46](https://github.com/mike-north/doc-linter/pull/46) amend `ctx` | C1′ | **`e69981e`**, `6089e28` | **+3 −3** | MERGEABLE, clean |
| [#47](https://github.com/mike-north/doc-linter/pull/47) rebase `line6` | C1′, rebased onto the advanced base | **`7eb3dc6`**, `2296faa` | +2 −2 | **CONFLICTING** |
| [#48](https://github.com/mike-north/doc-linter/pull/48) rebase `ctx` | C1′, rebased | **`7eb3dc6`**, `e90f59f` | +3 −3 | MERGEABLE, clean |
| #45–#48 after the line-5 drop | C1″ | unchanged | unchanged | all CONFLICTING |
| [#52](https://github.com/mike-north/doc-linter/pull/52) orphan `ctx` | C1″ `d28aa24`, which dropped the whole C1 hunk | **`eb6c2f6`**, `d92f82c` | +3 −3 | **MERGEABLE** |

GitHub lists the discarded C1 as a commit of the suggestion pull request and measures the diff from the old merge base, so it repeats C1's change: the #46 diff shows lines 5 and 6 as new even though the target already has them, beside the real line-10 edit. A local `git merge-tree` agreed with every GitHub verdict; for #46 and #48 a merge would change only line 10 but would add the discarded C1 to the branch's history.

For **#52, a clean merge would silently bring back lines 5 and 6, which the author had deliberately removed**:

```diff
-Line 05: original text.
-Line 06: original text.
+Line 05: reviewed change one (added by C1).
+Line 06: reviewed change two (added by C1).
```

GitHub reported it MERGEABLE and showed no sign that anything was stale.

### 4. Re-applying the change on the new head works

[#51](https://github.com/mike-north/doc-linter/pull/51) carried the `line6` suggestion cherry-picked onto C1′ `3007343`, where line 6 was still exactly as reviewed: one commit, +1 −1, MERGEABLE and clean. After the next force-push (C1″) it listed `3007343` as well and conflicted: a re-application is a snapshot of the head it was made on.

## Conclusions

1. **Reviews and their comments survive a force-push.** The review keeps its `commit_id`; comments on unchanged lines move to the new head, and comments on changed lines become outdated. Discarded commits stay fetchable and browsable.
2. **A body-only review of a discarded commit is accepted.** sarif-to-comment already presents such findings as review-body sections with links to the exact commit, and refuses native suggestions there, so ordinary feedback can keep publishing as it does.
3. **A suggestion pull request on a discarded commit is unsafe.** It drags the discarded commit along, shows a misleading diff, and depending on the content either conflicts (#45, #47), merges while adding the discarded commit to the history (#46, #48), or merges while silently undoing the author's rewrite (#52). "Create it and let GitHub show the problem" is not safe, because GitHub shows nothing.
4. **Test ancestry, not equality.** When the reviewed commit is still an ancestor of the head, suggestion pull requests from the reviewed commit are clean and minimal (#49, #50). Only a reviewed commit that is not an ancestor of the head is dangerous.
5. **Re-applying on the current head gives the best pull request (#51), but only when it is faithful.** The regions the change replaces must still be exactly the reviewed text there; otherwise the suggestion must not be created. The re-application is a snapshot of that head.

The owner's decision on [#28](https://github.com/mike-north/sarif-to-comment/issues/28) adopts conclusions 4 and 5, keeps ordinary feedback publishing as in conclusion 2, and skips a suggestion pull request, with its reason stated, whenever re-application would not be faithful.

## Artifacts

Nothing was cleaned up.

- Pull requests [#41](https://github.com/mike-north/doc-linter/pull/41)–[#52](https://github.com/mike-north/doc-linter/pull/52), all drafts titled "Experiment: force-push behaviour (do not merge)".
- Reviews 5356480526 (#41, pending), 5356481554 (#42, submitted comment), 5356482670 (#44, pending) and 5356511269 (#43, pending, at the discarded `eb6c2f6`).
- Branches `exp-forcepush-20260929-*`: `amend`, `rebase`, `orphan` and `control`, each with its `-base` (`rebase-base` advanced); the suggestion branches `amend-sugg-{line6,ctx,reapply}`, `rebase-sugg-{line6,ctx}`, `control-sugg-{line6,ctx}` and `orphan-sugg-ctx`.
- The `amend`, `rebase` and `orphan` branches were each force-pushed twice.
