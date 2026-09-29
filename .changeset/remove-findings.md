---
"sarif-to-comment": minor
---

Remove a finding and its attached fixes from a SARIF document, so a finding can be corrected by removing it and adding it again. The new `remove-comment` command (`--sarif FILE --finding SELECTOR`) edits the file in place, atomically, in human or JSON output; the library's `removeSarifComment(sarif, selector)` returns a new document and never changes its input. Every other finding and fix is kept, including identical ones.

Inspection now gives every finding a `selector` (shown as `Selector: …` in human output), which removal takes. A selector belongs to the document exactly as inspected: after any change it is refused as `stale` (exit status 2) rather than removing whichever finding has moved into its place, and identical findings in different runs have different selectors. Removal only changes the local artifact, never a published GitHub review.
