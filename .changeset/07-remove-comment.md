---
"sarif-to-comment": minor
---

**Remove a finding from a SARIF document**, so a finding can be corrected by removing it and adding it again. The new `remove-comment --sarif FILE --finding SELECTOR` command edits the file in place, atomically, in human, JSON or TOON output; the library's `removeSarifComment(sarif, selector)` returns a new document and never changes its input. The finding goes with every fix and proposed file operation attached to it; every other finding and fix is kept, including identical ones. Removal changes only the local file, never a published GitHub review.

`inspect` now gives every finding a `selector` (shown as `Selector: …` in human output). A selector belongs to the document exactly as inspected: after any change it is refused as stale (exit status 2) rather than applied to whichever finding has moved into its place, and identical findings in different runs have different selectors.

### `sarif-to-comment inspect`: each finding's selector

```diff
 Finding /runs/0/results/0 — CalcLint 2.0.0
+Selector: /runs/0/results/0@64552a0bcd4dd06e
 Message:
 Test mul.
```
