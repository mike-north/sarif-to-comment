---
"sarif-to-comment": minor
---

**Publish proposed new files, file deletions and alternative fixes.** 0.2.1 blocked a review holding any of them; they are now published.

- **New files and deletions.** A finding carrying a whole-file proposal (as `add-staged-changes` writes it) no longer blocks `publish` with `file-operation-unsupported`. Under the default `fileOperations: [manual]`, each distinct proposal becomes one section of the review body, followed by every finding that carries it. A new file is shown in full, in a code block its content cannot close, with its size, line endings, final newline, byte-order mark and mode stated, so an empty file stays distinct from one holding a newline. A deletion links the file at the reviewed commit and states that the whole file is removed, not emptied; its content is never read, so binary files and files over the 1,000,000-byte source limit can be deleted. Content a code block cannot show exactly (control characters, format characters such as a zero-width space or a bidirectional control, U+00A0, a bare carriage return, mixed line endings, binary or non-UTF-8 content), a path holding any such character, a tab or line break, or leading or trailing whitespace, a creation over an existing file, a deletion of a missing one, and conflicting proposals block the whole review before anything is written (`file-operation-content-unrepresentable` and related codes). Nothing is truncated or split. `file-operation-unsupported` now refuses only an `edit` operation, which is proposed as a SARIF fix instead. The `add-staged-changes` receipt no longer warns that the publisher refuses these proposals. With `--file-operations companion` they become suggestion pull requests instead.
- **Alternative fixes.** A result with several fixes no longer blocks the review with `fix-alternatives-unsupported`. Its first fix is the suggested change, delivered as a single fix would be; the producer's order decides, and the tool never picks another. Every further fix is listed in the same comment under **Alternatives to consider:** as `(1)`, `(2)`, …, with its description and the reviewed lines it would replace, in a code block its content cannot close, naming its file when that differs from the first fix's. An alternative with several changes is listed with one labelled part per change, and a CRLF replacement is shown with LF line breaks and `(CRLF line endings)` beside it. Alternatives are never applied, merged, grouped, bundled or committed. They count toward the size limits. An alternative that does not apply exactly to the reviewed commit, overlaps itself, or cannot be shown exactly (the same characters as above, in its lines or in a path it names, or a line that could open a suggestion block) blocks the review at its own pointer, such as `/runs/0/results/0/fixes/1` (`alternative-content-unrepresentable` and related codes). `publish` and `validate` agree, and `inspect` lists every fix.

### `sarif-to-comment publish`: a finding that proposes a new file `test/calc.test.js`

Exit status 2 → 0.

```diff
-## Review blocked
+## Draft review published
 
-Nothing was published and no publication state was written.
-
-**Review blocked:** 2 problems must be resolved before publication; nothing was published.
-
-- `file-operation-unsupported` at `/runs/0/results/0`: Proposed file create operations are not published in this milestone.
-- `source-file-missing` at `/runs/0/results/0`: test/calc.test.js does not exist at 4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e.
+Created the draft [review 5000](https://github.com/octo/calc/pull/12#pullrequestreview-5000) on octo/calc#12 at commit `4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e`. It stays a draft until someone submits it on GitHub.
```

### `sarif-to-comment publish`: a finding with two fixes

The first is a native suggestion and the second is listed as an alternative. Exit status 2 → 0.

```diff
-## Review blocked
+## Draft review published
 
-Nothing was published and no publication state was written.
-
-**Review blocked:** 1 problem must be resolved before publication; nothing was published.
-
-- `fix-alternatives-unsupported` at `/runs/0/results/0`: Several alternative fixes were proposed; none is chosen silently.
+Created the draft [review 5000](https://github.com/octo/calc/pull/12#pullrequestreview-5000) on octo/calc#12 at commit `4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e`. It stays a draft until someone submits it on GitHub.
```
