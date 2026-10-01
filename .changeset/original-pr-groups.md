---
"sarif-to-comment": minor
---

Every delivery mechanism now delivers. Groups can stay on the pull request whole, either made by hand in the review body or as a native batch that covers fixes with several changes.

- **A group with a new or deleted file is published by default.** Under the default `fileOperations: [manual]`, a group with a whole-file creation or deletion is now the **mixed manual group**, where it was refused before. It is one review-body section that lists every change by path and line and asks for all of them to be made by hand in one commit, followed by each change: an edit as its exact replacement, and a created or deleted file as its usual section. It never creates a companion pull request, and none of it is a suggestion.
- **A fix with several changes is a native batch by default.** When every change can be a native suggestion, the default `groupedEdits: [native-batch]` now offers each change as a suggestion. Each one holds the finding and the note `**Fix with K changes:** apply this suggestion together with the fix's other suggestions, listed in the review body.`. The body lists the changes and says that nothing checks they are applied together (as every native batch's guidance now does). A group member whose fix makes several changes contributes each change to its group's batch. When any change can't be a native suggestion, the proposal is blocked, naming that change.
- **`edits: review-body` and `groupedEdits: manual-group`** (`--edits native,review-body`, `--grouped-edits native-batch,manual-group`, or the `original-pr` preset) put an edit, or a whole group, in the review body to make by hand. Neither is ever a default. An edit made by hand shows its exact replacement: a link to the replaced lines at the reviewed commit, a code block of the new lines, and `CRLF line endings` or `no newline at end of file` beside it when they apply. If a replacement can't be shown exactly (for example an invisible or bidirectional character, mixed line endings, or a line that could open a suggestion block), that mechanism is unavailable for it. You get the reason and the remedy `Change the replacement.`, so a later listed mechanism can still deliver it.
- **Limits.** A body that grows too large with these sections is blocked with `body-too-large`, naming each proposal made by hand and its size. Nothing is split.
- **Library.** A new `manualEdit` presentation callback (`IManualEditPresentationContext`) replaces how an edit made by hand reads. Its location link, permalink, replacement block, details and findings are required, each shown on its own (a finding's identical source link does not count for the location), and no link may carry the location's text to another destination. A group's guidance and change labels stay the tool's.

- **Shown exactly.** Every content block, in a new file, an alternative or an edit made by hand, now also refuses format characters (Unicode category `Cf`: zero-width spaces and joiners, the word joiner, the soft hyphen, tag characters, …) and U+00A0, which a code block can't show exactly. A new file or an alternative holding one blocks the review (`file-operation-content-unrepresentable`, `alternative-content-unrepresentable`). For an edit made by hand, it is an obstacle of that mechanism.
- **Presentation callbacks.** Every callback's required fragments must now be shown at separate occurrences, so one fragment can't stand in for another. A link the callback writes may not reuse the text of any link the element presents, or of the source link before a finding, to point elsewhere. Text is compared as it reads, so a trailing, doubled or no-break space makes no difference. A callback also may not add a format character (such as a zero-width space) or a no-break space outside the content it presents.

### Compared with 0.2.1: a fix that changes lines 2 and 3

```diff
-## Review blocked
+## Draft review published
 
-Nothing was published and no publication state was written.
-
-**Review blocked:** 1 problem must be resolved before publication; nothing was published.
-
-- `fix-multiple-replacements-unsupported` at `/runs/0/results/0`: A fix with several replacements is not supported yet.
+Created the draft [review 5000](https://github.com/octo/widgets/pull/7#pullrequestreview-5000) on octo/widgets#7 at commit `feedfeedfeedfeedfeedfeedfeedfeedfeedfeed`. It stays a draft until someone submits it on GitHub.
```

This is `sarif-to-comment publish` under the default delivery policy. The exit status changes from 2 to 0. The review has two native suggestions and the guidance that lists them.

### Compared with 0.2.1: a new helper file grouped with two edits

0.2.1 could publish neither groups nor proposed new files. It refused such a document, reporting `suggestionGroup` as an unknown property and the creation as `file-operation-unsupported`. Under the default delivery policy, `publish` now creates one draft review, with exit status 0. Its body is the mixed manual group: guidance listing `src/helper.ts`: new file, `README.md` line 2 and `README.md` line 3, then each change. No companion pull request is created.
