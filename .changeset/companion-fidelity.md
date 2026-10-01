---
"sarif-to-comment": minor
---

After a force-push, suggestion pull requests stay on the reviewed commit and are checked for fidelity before they are created. None is ever re-applied or rebased onto the new head. Earlier unreleased builds re-applied them; that was never released, so there is no released behavior to compare with.

When the reviewed commit is no longer part of the pull request's branch, GitHub shows a suggestion pull request against an older merge base: its diff also lists the reviewed commit's own changes, and merging it could silently bring back what the author removed. So `publish` and `validate` now project what merging each one into the current head would do before creating it. The projection works file by file, from GitHub's trees and blobs, with a merge that follows Git's own (histogram diffs; changes that overlap or touch conflict). It is labelled a projection everywhere, because it is not a merge GitHub performed:

- **Faithful** (merging it changes nothing other than its own changes): it is created. Its description says that the reviewed commit is no longer part of the branch, and shows its own changes as a diff, separately from GitHub's; when the head already has those changes, it says that merging changes nothing.
- **Conflicts**, and nothing worse: it is created, with a `companion-conflicts-at-head` warning naming the files. Once it exists, GitHub's `mergeable` is read back and reported beside the projection: `suggestions[].mergeable` is `mergeable`, `conflicting` or `unknown`, and its line in the outcome says the same. The read waits while GitHub computes it, at most about ten seconds per conflicting suggestion pull request, and every later call that reports the publication reads it again, waiting again.
- **Unfaithful**: merging it would bring back content the head no longer has, remove a file the head kept, or lose part of the suggestion; or the suggestion cannot be expressed at the head; or the projection cannot decide (a truncated tree, a binary file or symbolic link changed on both sides, a directory-rename trigger, a file over the read limit, a `.gitattributes` merge driver such as `merge=union` on a file it would merge, or a `.gitattributes` that changed between the commits and could set one). Then its pull request can't be made: it goes to the next mechanism its delivery list names, with a `delivery-fallback` warning naming the files, or the review is blocked (`delivery-unavailable`, exit status 2).

The projection is made once, when the publication is planned, and is recorded in the state file. A retry never projects again: it reads the head again before each suggestion pull request it still has to create, creates it as planned, and says when the head has moved since the projection. The projection reads the comparison it already read, two commits, three trees, the blobs of only the files both sides changed, and the `.gitattributes` files on their way. It does not model rename detection, more than one merge base, or `.gitattributes` beyond merge drivers. Version 2 suggestion markers and state files written by those earlier builds are still read.

### `sarif-to-comment validate --grouped-edits companion`: a reviewed commit a force-push replaced

```text
Publication would also create 1 draft suggestion pull request into `feature`, labeled `suggestion-pr`. The history of #62 was rewritten after the reviewed commit, so it is proposed on that commit and was projected onto the head `a27db7c…`: merging it would conflict.
```

```text
▲ warning  A suggestion pull request is projected to conflict with the pull request's head  [companion-conflicts-at-head]
  /runs/0/results/0
  Projected onto the head `a27db7c…` of #62, merging the suggestion pull request for the group `reword` would conflict in `docs/sample.md`. It is created on the reviewed commit, as planned; GitHub shows the conflict to whoever merges it.
  → Review the pull request's current head again, and publish that review.
  → Or resolve the conflict when merging the suggestion pull request.
```
