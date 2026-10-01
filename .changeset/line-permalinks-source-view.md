---
"sarif-to-comment": patch
---

A link to lines of a file now opens GitHub's source view, so it reaches its line in every file type.

- **What changed.** Every permalink that names lines adds `?plain=1`: `…/blob/COMMIT/PATH?plain=1#L5`. This covers a finding section's source link, a companion pull request's change list and an edit made by hand. Before, a line link into a file GitHub renders, such as Markdown, opened the rendered preview, which has no line anchors, so the line wasn't shown.
- **Unchanged.** Code files open as before. A link to a whole file (a deletion, a whole-file location) has no query, so it still opens as GitHub presents it.

```diff
-**Source:** [README.md line 5 at 84c53bd](https://github.com/mike-north/doc-linter/blob/84c53bd94db0ea6eba5c6d16b590d5d3811a3de3/README.md#L5)
+**Source:** [README.md line 5 at 84c53bd](https://github.com/mike-north/doc-linter/blob/84c53bd94db0ea6eba5c6d16b590d5d3811a3de3/README.md?plain=1#L5)
```
