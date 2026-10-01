---
"sarif-to-comment": minor
---

Reviews of a commit that is no longer the pull request's head keep their inline comments and native suggestions, and the reviewed commit must now belong to the pull request.

- **Inline at the reviewed commit.** When the branch moved on, or a force-push replaced the reviewed commit, `publish` and `validate` now anchor findings on the reviewed diff, from the pull request's diff base to the reviewed commit, and create the review at that commit. A finding whose lines are in that diff is an inline comment; one whose lines are not (for example a line only a later commit changed) still goes in the review body with an exact link. Before, every located finding of such a review went in the body.
- **Native suggestions at the reviewed commit.** A fix there is a native suggestion whenever its lines have an inline anchor. GitHub applies it to the head exactly on lines the head left unchanged, and shows it as outdated, without letting anyone apply it, on lines the head changed. The `suggestion-reviewed-commit-not-head` refusal is retired.
- **The reviewed commit must belong to the pull request.** Before anything is prepared or written, the reviewed commit must be the head, an ancestor of it, or part of a head a force-push replaced (read from the pull request's timeline). Otherwise the review is refused with `reviewed-commit-not-in-pull-request` (exit status 2). GitHub itself accepts a review at any commit of the repository. When the force-push history cannot settle it, the review is published with the note `reviewed-commit-association-unknown`.
- **Known limit.** When the base branch moved and the head was rebased onto it, GitHub's API cannot give the reviewed diff for files the base side also changed: findings on those files go in the body with an `inline-placement-unavailable` warning.

### `sarif-to-comment validate`: two findings at a commit a force-push replaced

```diff
 ## Ready to publish
 
 The complete document can be published faithfully to octo/gadgets#12 at commit `d1d1d1d…`.
 
-**Review prepared:** 0 inline comment(s) and 2 general section(s) for commit `d1d1d1d…`.
+**Review prepared:** 2 inline comment(s) and 0 general section(s) for commit `d1d1d1d…`.
```

### `sarif-to-comment validate`: the same, with a fix on line 6

```diff
-## Review blocked
+## Ready to publish
 
-Nothing was published and no publication state was written. 1 problem must be resolved before publication.
+The complete document can be published faithfully to octo/gadgets#12 at commit `d1d1d1d…`.
+
+**Review prepared:** 3 inline comment(s) and 0 general section(s) for commit `d1d1d1d…`.
```

```diff
-✖ error  A native suggestion needs the reviewed commit to be the pull request head  [suggestion-reviewed-commit-not-head]
-  /runs/0/results/2
-  The reviewed commit is not the pull request head, so a native suggestion could not be applied to the reviewed text.
-  → Review the pull request's head commit, or enable suggestion pull requests.
-
-1 error
```

### `sarif-to-comment validate`: a commit of another branch

```diff
-## Ready to publish
+## Review blocked
 
-The complete document can be published faithfully to octo/gadgets#12 at commit `e1e1e1e…`.
-
-**Review prepared:** 0 inline comment(s) and 2 general section(s) for commit `e1e1e1e…`.
+Nothing was published and no publication state was written. 1 problem must be resolved before publication.
```

```diff
+✖ error  The reviewed commit does not belong to the pull request  [reviewed-commit-not-in-pull-request]
+  octo/gadgets#12
+  Commit e1e1e1e… is not part of octo/gadgets#12: it is not the pull request's head d2d2d2d… or an ancestor of it, and no force-push of the pull request's branch replaced a head that contains it. GitHub would accept a review at that commit, so nothing was prepared or written.
+  → Check the reviewed commit: review a commit of this pull request.
+  → Check the pull request number.
+
+1 error
```
