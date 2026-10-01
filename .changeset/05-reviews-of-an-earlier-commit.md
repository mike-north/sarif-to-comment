---
"sarif-to-comment": minor
---

**Reviews of a commit that is no longer the pull request's head keep their inline comments and native suggestions, and the reviewed commit must now belong to the pull request.**

- **Inline at the reviewed commit.** When the branch moved on, or a force-push replaced the reviewed commit, findings are now placed on the reviewed diff, from the pull request's base commit to the reviewed commit, and the review is created at that commit. A finding whose lines are in that diff is an inline comment; one whose lines are not still goes in the review body with an exact link. In 0.2.1, every located finding of such a review went in the body.
- **Native suggestions at the reviewed commit.** A fix is a native suggestion whenever its lines have an inline anchor there. GitHub applies it to the head exactly on lines the head left unchanged, and shows it as outdated, without letting anyone apply it, on lines the head changed. 0.2.1 refused the whole review instead (`suggestion-historical-unsupported`, no longer reported).
- **Breaking: the reviewed commit must belong to the pull request.** Before anything is prepared or written, the reviewed commit must be the head, an ancestor of it, or part of a head that a force-push replaced (read from the pull request's timeline). Otherwise the review is refused with `reviewed-commit-not-in-pull-request` (exit status 2). 0.2.1 published such a review, because GitHub accepts a review at any commit of the repository. When the force-push history cannot settle it, the review is published with the note `reviewed-commit-association-unknown`.
- **Known limit.** When the base branch has moved since the reviewed commit's diff base, GitHub may resolve lines against a diff the tool cannot read for the files the base side changed. Findings on those files go in the body with an `inline-placement-unavailable` warning, so every line the tool places inline is valid, at the cost of some findings GitHub would have accepted inline.

### `sarif-to-comment publish`: two findings at a commit a force-push replaced

The draft review is created as before; its two findings are now inline comments on lines 5 and 6 instead of two sections of the review body.

### `sarif-to-comment publish`: the same, with a fix on line 6

Exit status 2 → 0.

```diff
-## Review blocked
+## Draft review published
 
-Nothing was published and no publication state was written.
-
-**Review blocked:** 1 problem must be resolved before publication; nothing was published.
-
-- `suggestion-historical-unsupported` at `/runs/0/results/2`: The reviewed commit is not the pull request head, so a native suggestion could not be applied to the reviewed text.
+Created the draft [review 5000](https://github.com/octo/widgets/pull/7#pullrequestreview-5000) on octo/widgets#7 at commit `c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1`. It stays a draft until someone submits it on GitHub.
```

### `sarif-to-comment publish`: a commit that is not part of the pull request

Exit status 0 → 2. stdout:

```diff
-## Draft review published
+## Review blocked
 
-Created the draft [review 5000](https://github.com/octo/widgets/pull/7#pullrequestreview-5000) on octo/widgets#7 at commit `d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3`. It stays a draft until someone submits it on GitHub.
+Nothing was published and no publication state was written. 1 problem must be resolved before publication.
```

stderr:

```diff
+✖ error  The reviewed commit does not belong to the pull request  [reviewed-commit-not-in-pull-request]
+  octo/widgets#7
+  Commit d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3 is not part of octo/widgets#7: it is not the pull request's head a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1 or an ancestor of it, and no force-push of the pull request's branch replaced a head that contains it. GitHub would accept a review at that commit, so nothing was prepared or written.
+  → Check the reviewed commit: review a commit of this pull request.
+  → Check the pull request number.
+
+1 error
```
