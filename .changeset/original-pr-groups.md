---
"sarif-to-comment": minor
---

Every delivery mechanism now delivers. Groups can stay on the pull request whole, either made by hand in the review body or as a native batch that covers fixes with several changes.

- **A group with a new or deleted file is published by default.** Under the default `fileOperations: [manual]`, a group with a whole-file creation or deletion is now the **mixed manual group**, where it was refused before. It is one review-body section that lists every change by path and line and asks for all of them to be made by hand in one commit, followed by each change: an edit as its exact replacement, and a created or deleted file as its usual section. It never creates a companion pull request, and none of it is a suggestion.
- **A fix with several changes is a native batch by default.** When every change can be a native suggestion, the default `groupedEdits: [native-batch]` now offers each change as a suggestion. Each one holds the finding and the note `**Fix with K changes:** apply this suggestion together with the fix's other suggestions, listed in the review body.`, and the body lists the changes. A group member whose fix makes several changes contributes each change to its group's batch. When any change can't be a native suggestion, the proposal is blocked, naming that change.
- **`edits: review-body` and `groupedEdits: manual-group`** (`--edits native,review-body`, `--grouped-edits native-batch,manual-group`, or the `original-pr` preset) put an edit, or a whole group, in the review body to make by hand. Neither is ever a default. An edit made by hand shows its exact replacement: a link to the replaced lines at the reviewed commit, a code block of the new lines, and `CRLF line endings` or `no newline at end of file` beside it when they apply. If a replacement can't be shown exactly (for example an invisible or bidirectional character, mixed line endings, or a line that could open a suggestion block), that mechanism is unavailable for it. You get the reason and the remedy `Change the replacement.`, so a later listed mechanism can still deliver it.
- **Limits.** A body that grows too large with these sections is blocked with `body-too-large`, naming each proposal made by hand and its size. Nothing is split.
- **Library.** A new `manualEdit` presentation callback (`IManualEditPresentationContext`) replaces how an edit made by hand reads. Its location link, replacement block, details and findings are required. A group's guidance and change labels stay the tool's.

### `sarif-to-comment validate`: a new helper file grouped with two edits, under the defaults

```diff
-## Review blocked
+## Ready to publish
 
-Nothing was published and no publication state was written. 1 problem must be resolved before publication.
+The complete document can be published faithfully to octo/widgets#7 at commit `feedfeedfeedfeedfeedfeedfeedfeedfeedfeed`.
+
+**Review prepared:** 0 inline comment(s) and 1 general section(s) for commit `feedfeedfeedfeedfeedfeedfeedfeedfeedfeed`.
+
+Nothing was published and no publication state was written.
+
+No pending review of this account was found on the pull request. This is not an approval: publication repeats every check against the pull request as it is then. GitHub can still refuse the review, for example if this account starts a pending review on the pull request before publication.
```

```diff
-✖ error  No delivery mechanism the policy lists is available for a proposal  [delivery-unavailable]
-  /runs/0/results/0
-  The group `helper` cannot be delivered. `fileOperations` is `[manual]`, the default, and no mechanism it lists is available:
-
-  - `manual`: Delivering a group with a whole-file creation or deletion on the original pull request is not yet supported by this version.
-  → Remove the obstacle the message names, then publish again.
-  → Or list a mechanism that is available for this kind of proposal (`--edits`, `--grouped-edits`, `--file-operations`, the `delivery` option, or `.github/sarif-to-comment.json`).
-
-1 error
```

The exit status changes from 2 to 0.

### `sarif-to-comment validate`: one fix that changes lines 2 and 3, under the defaults

```diff
-## Review blocked
+## Ready to publish
 
-Nothing was published and no publication state was written. 1 problem must be resolved before publication.
+The complete document can be published faithfully to octo/widgets#7 at commit `feedfeedfeedfeedfeedfeedfeedfeedfeedfeed`.
+
+**Review prepared:** 2 inline comment(s) and 1 general section(s) for commit `feedfeedfeedfeedfeedfeedfeedfeedfeedfeed`.
```

```diff
-✖ error  No delivery mechanism the policy lists is available for a proposal  [delivery-unavailable]
-  /runs/0/results/0
-  The fix with 2 changes at `/runs/0/results/0` cannot be delivered. `groupedEdits` is `[native-batch]`, the default, and no mechanism it lists is available:
-
-  - `native-batch`: Offering a fix with several changes as a native batch is not yet supported by this version.
```

### `sarif-to-comment publish --help`: Delivery

`validate --help` changes the same way.

```diff
 defaults; the defaults never create a companion pull request. When no listed
-mechanism can deliver a proposal, nothing is published. review-body and
-manual-group, and manual for a group with a whole-file operation, are not yet
-supported by this version.
+mechanism can deliver a proposal, nothing is published. review-body,
+manual-group and manual show proposals in the review body for the author to make
+by hand, never as suggestions; review-body and manual-group are used only when
+listed.
 
 Options:
```
