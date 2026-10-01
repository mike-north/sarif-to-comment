---
"sarif-to-comment": patch
---

Refuse producer Markdown that would swallow or hide what follows it, as GitHub renders it. A SARIF message's Markdown is now read as CommonMark reads code: a code span cannot hide raw HTML across a blank line or a line that ends its paragraph (a heading, block quote, list item, HTML block, table row, fence or thematic break), and an escaped backtick opens no code span; a fence is closed only by a closing fence indented at most three spaces, in the same block quote and list item, and ends with its block quote or list item. Markdown that leaves a `<details>` element or a fence open by one of these routes was published before, and GitHub then rendered the attribution, later findings and the native suggestion block inside it; it is now refused as `producer-html-unbalanced` or `producer-fence-unclosed`. A fence inside a block quote that ends with the block quote is no longer reported as unclosed.
