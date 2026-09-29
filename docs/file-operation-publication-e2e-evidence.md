# Publishing whole-file proposals: live GitHub evidence

Recorded September 28, 2026, for the [file-operation publication contract](file-operation-publication-contract.md). Sanitized artifacts are in [`evidence/file-operation-publication/`](evidence/file-operation-publication/). No token, environment or local path is recorded.

## Fixture

- Owned private sandbox `mike-north/doc-linter`, draft pull request #32 (never merged), from `sarif-issue4-20260928-reviewed` (`a9f05fb`) into `sarif-issue4-20260928-base` (`4306773`). The default branch was not touched (`0a7b03f` before and after).
- The reviewed commit holds a text file, a 16-byte binary file and a 1,128,899-byte file, which is over the 1,000,000-byte source limit.
- A local clone stages, against the reviewed commit ([`fixture.json`](evidence/file-operation-publication/fixture.json)):
  - four creations: a Markdown page with 3-, 4- and 10-backtick runs, a `~~~` line, `</details>`, `<script>`, an unterminated `<!--`, `{{ }}`, `@octocat`, `#1`, a `javascript:` link and a line opening a suggestion fence; a byte-order-mark file with CRLF endings and no final newline; a multibyte UTF-8 file with a tab and trailing spaces; and an executable script (mode 100755);
  - an empty file;
  - three deletions: the text file, the binary file and the oversized file;
  - one ordinary edit inside the pull request's diff.
- Two authored findings: line 1 of the new page, and line 2 of the deleted text file.

The expected review body was written by hand from the contract before publishing ([`oracle.json`](evidence/file-operation-publication/oracle.json)). The byte counts in it agree with Git's own blob sizes.

## Run

1. The built package was packed and installed into a clean consumer, as the installed-package tests do (tarball SHA-256 `da503db1…`).
2. Through the installed library: `createSarifDocument` → `addSarifComment` ×2 → `addStagedChangesToSarif` → `inspectSarif`, which reported 8 file proposals.
3. The installed CLI `validate` reported `ready` (exit 0).
4. `publishSarifReview` reported `published`: pending review `5347825990`.
5. Read-only control: the same document with the page's content replaced by `bare\rreturn\n` gives `validate` exit 2, `blocked`, naming line 1 ([`refused-validate.json`](evidence/file-operation-publication/refused-validate.json)).

## Independent readback

A verifier that uses only `gh api` reads and the oracle, never the package's code, checked the following ([`readback-result.json`](evidence/file-operation-publication/readback-result.json)):

| Check | Result |
| --- | --- |
| The review is pending, by the publishing account, the only pending review of that account, on the reviewed commit | passed |
| The stored body equals the intended request body byte for byte, including the CRLF inside the proposal | passed |
| The body is the hand-written oracle followed only by the hidden marker, which occurs once | passed |
| `body_html` has exactly five code blocks, each holding the exact proposed content: the page, the deleted file's quoted line, the CRLF file, the script and the multibyte file | passed |
| HTML-like content is escaped: the rendered HTML has no script element, no `onerror` attribute, no `javascript:` link and no `<details>` element; the content appears only as escaped text | passed |
| The deletions link `blob/<reviewed commit>/…` (and `#L2` for the quoted line), no link exists to any created path, and `@octocat` in the content is not linked | passed |
| Attribution: two authored items and six neutral `sarif-to-comment 0.2.1 · rule staged-change` items | passed |
| The edit stays one inline native suggestion | passed |

The rendered HTML shows CRLF content with LF line breaks, which is why the file details state the line-ending style. The raw body keeps the bytes. The binary and oversized files were deleted without their content being read.

## Limits

- The evidence covers one fixture and one account. The draft was left pending for inspection and was never submitted. Nothing was applied, so it shows presentation and delivery, not that a person can recreate files from them.
- No screenshots were taken. `body_html` ([`readback-review.json`](evidence/file-operation-publication/readback-review.json)) is GitHub's own rendering of the body.
- Mixed line endings, bidirectional controls, and other refused content were not sent to GitHub. They are refused before any write.
