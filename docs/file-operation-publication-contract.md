# Publishing whole-file creation and deletion: contract

Accepted by the owner · September 29, 2026 ([D36](design-decisions.md#d36-publish-whole-file-operations-as-byte-determined-review-body-sections--owner-accepted), [issue #24](https://github.com/mike-north/sarif-to-comment/issues/24)), as merged in [PR #16](https://github.com/mike-north/sarif-to-comment/pull/16). First proposed September 28, 2026. Publication of proposed file creations and deletions is implemented as described below. The owner accepted the three decisions listed under [Accepted decisions](#accepted-decisions), and the dynamic fence of [Content and facts](#content-and-facts-decision-3), which GitHub rendered exactly in the completed [rendering experiment](https://github.com/mike-north/sarif-to-comment/issues/22) ([D37](design-decisions.md#d37-fence-proposed-file-content-one-backtick-longer-than-its-longest-run--owner-accepted-verified-live)).

**Sources.** [R9, R10, R16 and R1/R3/R7/R8/R12/R14](specification.md); [D6, D17, D18, D20, D22, D23](design-decisions.md); the [engineering contract](second-milestone-contract-proposal.md) §2.2, §4.2 and §4.7; the [new-file representation research](new-file-representation-research.md); security requirement S1 (A19).

## 1. What is fixed by the sources

- The representation is the one extraction writes and inspection shows (D23, contract §4.7). A result carries `properties.sarifToComment.proposedFileChanges: [{ operation, artifactIndex, fileMode? }]`, and the artifact at `artifactIndex` in the same run describes the file. For a creation, the artifact holds `{ location: { uri }, contents: { text }, encoding: "utf-8" }`. For a deletion, it holds `{ location: { uri } }`. Publication reads nothing else and infers nothing: an artifact with contents never implies a creation.
- A creation keeps its path, its complete literal content and its explanation. A deletion keeps its delete-file meaning, its file and its explanation. Deleting a file is never presented as emptying it. Creating an empty file is a creation with `""`. Emptying an existing file is an edit, which travels as an ordinary SARIF fix (R9, D6, contract §4.2).
- Feedback on a created file refers to a line of the proposed content, never to an invented line of the reviewed snapshot. Feedback on a deleted file refers to the file as it exists at the reviewed commit. A line never narrows a deletion (R9, D20; A25, A26).
- The complete proposal must stand in the ordinary review without any link. It is never truncated, split, uploaded or hosted elsewhere. When no faithful representation fits, the whole review is refused before anything is written (R10, R12, D17, D18).
- With suggestion pull requests not enabled (they are explicit opt-in and off by default, D22, #5; see the [companion suggestion PR contract](companion-suggestion-pr-contract.md)), file operations use the ordinary review (R16's disabled column). No prefill link and no deletion link are promised.

## 2. Presentation (decision 1)

Every distinct file operation becomes **one section of the review body**. The section holds the proposal once, followed by every finding that carries that operation, each with its own explanation and attribution. Two operations are the same when their operation, path, mode and exact content are equal. This is how identical suggestions already share one comment (R8, R1). The section takes the position of the first finding that carries the operation, in SARIF order. File operations never become inline comments: a created file is not in the diff, and a deletion concerns the whole file, not a line.

A creation section:

```
**Proposed new file:** `PATH`

**File details:** FACTS

FENCE
CONTENT
FENCE

ITEMS
```

A deletion section:

```
**Proposed file deletion:** [PATH at SHORT](PERMALINK)

The whole file is removed; this is not a proposal to empty it.

ITEMS
```

- `PERMALINK` is `https://github.com/OWNER/REPO/blob/REVIEWED_COMMIT/PATH`, the exact file at the reviewed commit. Each path segment is percent-encoded, including `(`, `)`, `!`, `'` and `*`, so the link destination can never end early; `/` separators are kept. `SHORT` is the commit's first seven characters. No permalink is ever produced for a created path.
- `ITEMS` are the findings joined by `\n\n---\n\n`, as in a shared suggestion comment. Each item is the ordinary rendered finding (message, location message, status and attribution). It is preceded by its location when the finding has a region:
  - on a created file: `**Location:** line N of the proposed file` (or `lines N-M`), then a blank line. The content is already shown, so it is not quoted again.
  - on a deleted file: the existing general-feedback source quote, `**Source:** [PATH line N at SHORT](PERMALINK#LN)` followed by a fenced quote of those lines at the reviewed commit.
- A finding without a region has no location line; the section header already names the file.

### Content and facts (decision 3)

`CONTENT` is the file's text with a leading byte-order mark removed and exactly one final line terminator removed. `FENCE` is a run of backticks one longer than the longest backtick run in `CONTENT`, and at least three. It is at the start of its line and has no info string. A line inside the block can therefore never close it (GFM fenced code blocks). HTML, template braces, `@mentions`, issue references and links inside the content stay literal code.

**Rendering evidence.** In the completed [rendering experiment](https://github.com/mike-north/sarif-to-comment/issues/22) of September 29, 2026, GitHub rendered a Markdown file containing a triple-backtick example and a fourteen-backtick line, inside a fifteen-backtick fence, as one code block whose text matched the file exactly. The owner accepted this fence on that evidence ([D37](design-decisions.md#d37-fence-proposed-file-content-one-backtick-longer-than-its-longest-run--owner-accepted-verified-live)).

`FACTS` make the displayed block and the facts together determine the file's exact bytes. They are joined by ` · `:

1. `N bytes of UTF-8 text` (UTF-8 bytes of the whole file, including any byte-order mark; `1 byte` in the singular).
2. `begins with a byte-order mark`, only when it does.
3. `LF line endings`, `CRLF line endings`, or `no line breaks`.
4. `ends with a newline` or `no newline at end of file`.
5. `mode 100644`, or `mode 100755 (executable)`. An absent `fileMode` means `100644`, as in extraction.

Two contents have no block at all:
- the empty file: `FACTS` is `empty file (0 bytes) · mode 100644`;
- a file holding only a byte-order mark: `FACTS` is `3 bytes of UTF-8 text · begins with a byte-order mark · no content after the byte-order mark · mode 100644`.

A file of one newline, `"\n"`, has a block containing one empty line. This keeps it distinct from the empty file.

### Refusals

Any of the following blocks the whole review before any write:

| Problem | Diagnostic code |
| --- | --- |
| The operation is `edit` (edits travel as SARIF fixes), or unknown | `file-operation-unsupported`, `file-operation-unknown` |
| More than one operation on one result | `file-operation-multiple-unsupported` |
| An operation field this version does not interpret; a missing or invalid `artifactIndex`; a mode other than `100644`/`100755`; a mode on a deletion; a deletion artifact that describes content, length or hashes; a declared length or verifiable hash that does not match the proposed bytes | `file-operation-invalid` |
| A nested artifact, or an invalid path (traversal, encoded separator, unresolved base, …) | the existing artifact path codes |
| A path with a control or invisible formatting character, or leading or trailing whitespace, which cannot be shown exactly | `file-operation-path-unrepresentable` |
| Binary contents (`contents.binary`) or no `contents.text` | `file-operation-binary-unsupported`, `file-operation-invalid` |
| An encoding other than UTF-8 (`encoding`, else the run's `defaultEncoding`) | `file-operation-encoding-unsupported` |
| Content that cannot be shown exactly: C0 controls other than tab, LF and CR in CRLF; DEL and C1 controls; a bare CR; mixed LF and CRLF line endings; a byte-order mark after the start; bidirectional formatting controls; U+2028/U+2029; a lone surrogate | `file-operation-content-unrepresentable` |
| The run's source revision is not the reviewed commit | `file-operation-source-not-reviewed` (or the run's provenance code) |
| A created path already exists at the reviewed commit; a deleted path does not | `file-operation-target-exists`, `file-operation-target-missing` |
| The finding's location names another file | `file-operation-association-unsupported` |
| A finding with both fixes and an operation; different operations on one path; a fix editing a created or deleted path | `file-operation-conflict` |
| A region outside the proposed content (A25) | the existing region codes, such as `source-range-invalid` |
| The complete review exceeds the existing limits: 60,000 characters of body, 60,000 per comment, 1,000,000 bytes of payload | `body-too-large` (which then lists each proposal's size), `comment-too-large`, `payload-too-large` |

## 3. Reading the reviewed commit (decision 2)

A deletion needs only the fact that the file exists at the reviewed commit. A creation needs the fact that its path does not. The GitHub client gains a read-only existence check, `fileExists(commit, path)`. It walks the same Git trees as the source reader, never decodes a blob and has no size limit. It answers `true` for a regular file, `false` when a complete listing shows the path absent, and fails as the source reader does for a directory, symbolic link or submodule. A deletion of a binary or oversized file therefore publishes. The source reader is used only when a deletion finding has a region, which must be quoted; that requires readable UTF-8 text within the 1,000,000-byte source limit, as for any quoted source.

Preparation reads both facts through the review context that publication and readiness assessment share (`src/review-preflight.cts`), so `validate` reports the same outcome as `publish`. A failure of the existence check is an operational failure: `publish` rejects and `validate` answers `incomplete`.

## 4. Worked examples

The pull request `acme/widgets#7` is reviewed at commit `2222222…`. The results are in a run bound to that commit.

1. **Creation with feedback on its line 1.** The artifact's text is `# Guide\n\nUse \`x\`.\n` and the finding says "Document the new option." at line 1. The body section is:

   ````
   **Proposed new file:** `docs/guide.md`

   **File details:** 18 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644

   ```
   # Guide

   Use `x`.
   ```

   **Location:** line 1 of the proposed file

   Document the new option.

   <sub>— T</sub>
   ````

2. **Empty file.** `"text": ""` with a neutral result produces `**File details:** empty file (0 bytes) · mode 100644` and no block.
3. **Deletion of a binary file.** `assets/logo.png` exists at `2222222…` and is not UTF-8. The section links `https://github.com/acme/widgets/blob/2222222…/assets/logo.png` and publishes without reading the blob.
4. **Content with fences.** Content containing a line of four backticks is shown inside a five-backtick fence.
5. **Refused content.** Content containing a bare CR blocks the whole review with `file-operation-content-unrepresentable`, naming the line.
6. **Two findings, one proposal.** Two findings in different runs carry the same creation. The content appears once, followed by both findings with their own attribution.

## Accepted decisions

The owner accepted these three decisions on September 29, 2026, as merged ([D36](design-decisions.md#d36-publish-whole-file-operations-as-byte-determined-review-body-sections--owner-accepted), [issue #24](https://github.com/mike-north/sarif-to-comment/issues/24)): the presentation, the non-decoding existence check, and the byte-determined facts with their conservative refusals. The alternatives are kept below as the reasons for each choice.

1. **One body section per distinct operation.** Alternatives: (b) render the proposal with each finding, which duplicates large content and cannot be inline for a created file anyway; (c) separate the findings from the proposal, which breaks the association R9 requires. Adopted: (a). No prefill link, no deletion link and no `<details>` collapsing. A prefill link has no measured support bound (O5), and collapsing adds HTML-block interactions not yet verified live. Both are additive later.
2. **A non-decoding existence check at the GitHub boundary.** Alternative: refuse deletions of binary or oversized files with a diagnostic. That would narrow D6's accepted requirement ("any content is allowed" for a deletion, contract §4.2), so it was rejected.
3. **Byte-determined presentation.** Adopted: the fence, facts and refusals above, and the existing limits with whole-review refusal and no truncation. Three conservative refusals were added beyond the initial proposal (control characters, bare CR, lone surrogates and non-UTF-8), because each would make the rendered block ambiguous about the bytes: **mixed LF and CRLF** (the facts can state only one style), **bidirectional formatting controls and U+2028/U+2029** (they reorder or break the displayed text without being visible), and a **byte-order mark after the start**. A deletion artifact that describes content, a length or hashes is also refused rather than verified, because verifying it would need the decoding read that decision 2 avoids. Each refusal can be relaxed later with live evidence without changing any published output.
