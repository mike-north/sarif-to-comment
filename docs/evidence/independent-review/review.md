No confirmed code defect still blocks the first milestone. All four earlier findings reproduce as fixed. What remains before release is live-GitHub evidence, not code.

**Reviewed snapshot.** Every entry in `logs/opus/assembled-review-hashes-02.txt` matches:

| File | SHA-256 |
|---|---|
| `src/prepare-review.cjs` | `9273bc0e…` |
| `bin/sarif-to-comment.cjs` | `f4379347…` |
| `test/composition.test.cjs` | `da46e1f5…` |
| `test/prepare-review.test.cjs` | `128d9b6b…` |
| `test/cli.test.cjs` | `f5628efd…` |
| `test/package.test.cjs` | `731fccfd…` |

The other ten files are unchanged since the last review. The composition fixtures are not in the hash list:

| Fixture | SHA-256 |
|---|---|
| `cli-with-fake-http.cjs` | `1856bfef…` |
| `fake-http-github.cjs` | `a97dc853…` |
| `repository.json` | `99c7d86b…` |
| `review.sarif.json` | `d421e166…` |

In my run, all 1278 tests passed with none skipped, lint was clean, and `git status` was the same before and after.

## Reconciliation

**D1 (silently dropped SARIF input): fixed.**
- `kind`, `level` and `baselineState` now render as a literal status line, for example `**Level:** none · **Kind:** pass`. Error and note results are no longer identical.
- `baselineState: "absent"` blocks with `baseline-absent-unsupported`.
- `location.message` renders as `**At this location:** …`.
- `executionSuccessful: false` blocks with `invocation-failed` and quotes the tool's error notification.

**D2 (unclosed producer HTML): fixed.**
- These all block with `producer-html-unbalanced`: `<!--`, `<pre>`, `<details>`, `<script>`, `<textarea>`, `<style>`, `<div>`, `<span>`, CDATA, `<?`, `<!DOCTYPE`, uppercase tags, and tags whose attributes continue on the next line.
- Balanced HTML, `<br>`, autolinks, `a < b`, closed comments, and HTML inside code spans or fences are kept verbatim.
- The guard over-blocks a few valid inputs, such as `<!-- \`-->\``, `<b>` inside a table cell, and `<div>` inside an indented code block. Refusing too much is safe, so I don't count that as a defect.

**D3 (plain-text mentions): fixed within the scope you settled.**
- Plain-text `@user` and `@org/team` become exact code spans in messages, `location.message`, literal arguments inside Markdown templates, and tool names and versions in the attribution.
- Email addresses are left alone. Producer Markdown mentions and links stay verbatim.
- Issue and commit references stay as ordinary text, as you decided. That no notification fires on human submission is still unverified; the code span only keeps the text literal.

**D4 (CLI decoding): fixed.**
- Invalid UTF-8 is refused with "not valid UTF-8; nothing was published".
- One leading BOM is stripped, and the file then parses and proceeds.
- **Disclosure:** my BOM reproduction reached `api.github.com` with a dummy token and got one read answered 401. Nothing was written.

**E2 (no test composed the real adapter): fixed, with one overclaiming test name.**
- The composition suite drives the real library and CLI through the real `src/github.cjs` over fake HTTP.
- I injected defects into a scratch copy under `/tmp`:

  | Injected defect | Composition failures |
  |---|---|
  | `start_line` sent as `line` on the wire | 6 |
  | Readback side forced to RIGHT | 6 |
  | Readback line off by one | 6 |
  | General body sections dropped | 4 |
  | LEFT deletions anchored RIGHT | 4 |
  | Old-side verification skipped entirely | 0 |
  | Base context kept at its base line numbers | 0 |

- The two defects the composition suite missed are caught elsewhere: `test/github.test.cjs` plus the other subsystem suites fail 12 tests for the first, and the placement suite fails 8 for the second.
- The test named "old-side source is verified … never from base.sha alone" (`test/composition.test.cjs:213`) only checks request paths. Its fake returns a merge base equal to `base.sha`, so it doesn't show what its name says. It is a low-priority test-naming fix, not a blocker.

**Earlier supported behavior survives.** My earlier fake-HTTP composition script produces exactly the same anchors as before:
- RIGHT 2 for the replaced head line;
- RIGHT 3–4 for the context range;
- RIGHT 4 for the suggestion;
- LEFT 6 for the deleted base line;
- RIGHT 3 for base context;
- the location-less finding in the body.

## Residual limits the core author named

- **Logical location alongside a physical one.** It is dropped with no warning, while `taxa` do get one (`inline-unavailable`-style warnings are not raised for it either). The physical placement is still exact, and a result with only a logical location blocks. So nothing is misassociated and no finding disappears. I'd add a warning for consistency, but it doesn't block.
- **`rank`, `occurrenceCount` and `fingerprints`.** They are producer metadata that neither changes the finding's association nor removes a finding, so leaving them unrendered is acceptable. A warning would be nice for `occurrenceCount > 1`, which means the result stands for several occurrences.

## Remaining blocker

The only blocker is E1, the live GitHub run your side owns. It must show:
- exact readback of review bodies, including an inline-only body `"\n\n<marker>"` and raw CR inside quoted CRLF source;
- the GraphQL anchor fields used for readback;
- live application of middle-line deletions and suggestions that change the line count, both of which the product still emits.

These are evidence gaps, not code defects. This covers the hashes above only and is not approval of the milestone.
