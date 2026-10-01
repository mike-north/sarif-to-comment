# Pending review 5375833995 in the GitHub web interface

Run at about 07:00 UTC on October 1, 2026, a few minutes after the publication in [`README.md`](README.md). Chrome, signed in to github.com as `mike-north` (the page's `user-login` is `mike-north`; the pending review is visible only to its author). The page was the Conversation view of [mike-north/doc-linter#99](https://github.com/mike-north/doc-linter/pull/99), dark theme, desktop width.

Nothing was written. No button was clicked on the pull request: no submit, edit, comment, apply, merge or close. The DOM was read with page scripts, and the permalinks were opened in a separate tab.

## Checks

| Check | Result | Evidence |
|---|---|---|
| The review shows as pending, by `mike-north` | Passed. "mike-north started a review", **Pending** badge | [`ui-1-pending-review.jpg`](ui-1-pending-review.jpg) |
| Each content block matches the proposed bytes | Passed, all 8 | below |
| No "Commit suggestion" or "Add suggestion to batch" control | Passed. Neither text is on the page; no button on the page mentions a suggestion or batch; the review body's only controls are 8 "Copy code to clipboard" buttons | [`ui-2`](ui-2-guidance-and-new-file.jpg) to [`ui-6`](ui-6-readme-edit.jpg) |
| The guidance is readable and claims no enforcement by GitHub | Passed. It says to apply the 4 changes "by hand, in one commit" and that "nothing checks that they are applied together". The text has no "enforce", "atomic" or "GitHub will/ensures/applies" | [`ui-2-guidance-and-new-file.jpg`](ui-2-guidance-and-new-file.jpg) |
| Group parts and member lines | Passed. Four member lines in order (new file, line 5, line 7, file deletion), then labels "change 1 of 4" to "change 4 of 4" | [`ui-2`](ui-2-guidance-and-new-file.jpg), [`ui-3`](ui-3-change-2.jpg), [`ui-4`](ui-4-change-3.jpg), [`ui-5`](ui-5-change-4-deletion.jpg) |
| The permalinks resolve | Passed, with a defect (below). The body has 5 distinct links, into 3 files at `84c53bd`. `README.md#L5`, `sample.md#L5` and `obsolete.md#L1` were opened and each shows its file at that commit; `sample.md#L7` and the anchorless `obsolete.md` link point into the same files | [`ui-7`](ui-7-permalink-readme-preview.jpg), [`ui-9`](ui-9-permalink-sample-preview.jpg), [`ui-10`](ui-10-permalink-obsolete-preview.jpg) |

### Content blocks

The expected bytes are the fenced contents of the request body in [`state.json`](state.json), which equals the body read back in [`review-5375833995.json`](review-5375833995.json). For each of the 8 `<pre>` elements in the review body, `textContent` was compared with `===` in the page:

| # | Block | Length | Equal |
|---|---|---|---|
| 1 | `guide.md` content, with a nested ```` ```sh ```` fence | 45 | yes |
| 2 | replacement of `sample.md` line 5 (the link stays literal) | 37 | yes |
| 3 | quote of `sample.md` line 5 | 49 | yes |
| 4 | replacement of `sample.md` line 7 | 39 | yes |
| 5 | quote of `sample.md` line 7 | 42 | yes |
| 6 | quote of `obsolete.md` line 1 | 17 | yes |
| 7 | README replacement, with a nested ```` ```sh ```` fence | 73 | yes |
| 8 | quote of README line 5 | 20 | yes |

No block has a language class or syntax highlighting, and none contains a carriage return. The nested fences show as literal text inside the outer block ([`ui-2`](ui-2-guidance-and-new-file.jpg), [`ui-6`](ui-6-readme-edit.jpg)). This fixture has no CRLF content, no content without a final newline, and no leading or trailing spaces, so those were not exercised.

The copy button gives each block's content **without** its final newline (`data-snippet-clipboard-copy-content` equals the content with the last `\n` removed, for all 8). For the new file, the "File details" line states "ends with a newline", so the page still says what the copied text leaves out.

## Defect

**Line anchors on Markdown files do not show the line.** Every line permalink in the body points into a `.md` file as `…/blob/<sha>/<path>#L<n>`. GitHub opens a Markdown file in its rendered Preview, where line anchors do not exist: the page shows the rendered document, with no line highlighted and no scroll to the line ([`ui-7`](ui-7-permalink-readme-preview.jpg), [`ui-9`](ui-9-permalink-sample-preview.jpg), [`ui-10`](ui-10-permalink-obsolete-preview.jpg)). The same URL with `?plain=1` before the anchor opens the Code view with line 5 highlighted ([`ui-8`](ui-8-permalink-readme-plain.jpg)). The links resolve to the right file at the right commit, but the reader is not taken to the line the proposal names.

## Establishes

- In the web interface, the pending review shows both forms as plain prose and code blocks, with no suggestion controls.
- Each code block on the page holds the exact bytes proposed, including content with its own fences.
- The group guidance reads as a by-hand instruction and does not claim GitHub enforces it.

## Does not establish

- Applying anything. This checks rendering only; no change was applied or committed.
- How the review looks once submitted, to other accounts, on mobile, or in the light theme.
- CRLF, missing final newline, or whitespace-edge content, which this fixture does not contain.
