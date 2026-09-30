# Publishing alternative fixes: live GitHub evidence

Recorded 2026-09-30, 03:00–03:10 UTC, in the private fixture repository `mike-north/doc-linter`, for the owner decision on [#30](https://github.com/mike-north/sarif-to-comment/issues/30): a result's first fix is its suggested change, and every further fix is listed in the same comment as an alternative. The built package ran from the working tree (`node dist/sarif-to-comment.cjs`) with the maintainer's personal token. Nothing was published to npm, nothing was merged or submitted, and `main` was not touched. Sanitized artifacts are in [`evidence/alternative-fixes/`](evidence/alternative-fixes/). No token, environment or local path is recorded.

## Fixture

- Draft pull request [#54](https://github.com/mike-north/doc-linter/pull/54) (never merged), from `sarif-issue30-20260929-reviewed` (`8f005c8`) into `sarif-issue30-20260929-base` (`7f25b12`), both new branches on `main` (`0a7b03f`, unchanged). The pull request changes line 2 of `examples/alternative-fixes/parse.js`. `examples/alternative-fixes/fence.js` is unchanged and outside the diff ([`fixture.json`](evidence/alternative-fixes/fixture.json)).
- One upstream-style finding on line 2 with three fixes, in this order ([`input.sarif.json`](evidence/alternative-fixes/input.sarif.json)):
  1. `parseB` on line 2 (the first fix);
  2. a two-line cache on line 2;
  3. a line of `fence.js` whose content has a three-backtick run.

The expected comment was written by hand from the rendering grammar before publishing ([`oracle.json`](evidence/alternative-fixes/oracle.json)).

## Run

Exit statuses are in [`exit-statuses.txt`](evidence/alternative-fixes/exit-statuses.txt). Every run wrote nothing to stderr.

1. `inspect` listed all three fixes as `Fix 1 of 3` … `Fix 3 of 3` ([`inspect.txt`](evidence/alternative-fixes/inspect.txt)).
2. `validate` reported `ready`, one inline comment (exit 0; [`validate.json`](evidence/alternative-fixes/validate.json)). Before #30 this document was refused with `fix-alternatives-unsupported`.
3. Read-only control: the same document with a U+202E override in the second fix gives `validate` exit 2, `blocked`, at `/runs/0/results/0/fixes/1` ([`refused-validate.json`](evidence/alternative-fixes/refused-validate.json)). Nothing was sent.
4. `publish` reported `published`: pending review `5361030472` (exit 0; [`publish.json`](evidence/alternative-fixes/publish.json)).

## Independent read-back

The stored review and its inline thread were read back with `gh pr view --json reviews` ([`readback-review.json`](evidence/alternative-fixes/readback-review.json)) and `gh-reviews threads` over GraphQL ([`readback-thread.json`](evidence/alternative-fixes/readback-thread.json)). A verifier that uses only those reads and the oracle, never the package's code, checked the following ([`readback-result.json`](evidence/alternative-fixes/readback-result.json)):

| Check | Result |
| --- | --- |
| One review, `PENDING`, by the publishing account, never submitted, on the reviewed commit (the pull request head) | passed |
| The review body is only the hidden marker, once | passed |
| One inline thread, at `examples/alternative-fixes/parse.js` line 2 | passed |
| The stored comment body equals the hand-written oracle byte for byte | passed |
| An independent GFM fence reading finds exactly three code blocks: alternative (1) in a three-backtick fence holding both replacement lines; alternative (2) in a four-backtick fence holding its line with the ```` ``` ```` run intact; then the `suggestion` block holding only the first fix | passed |
| Alternative (2) names `examples/alternative-fixes/fence.js`; alternative (1), on the first fix's file, names no file | passed |

Branch heads after the run are in [`branch-heads-after.txt`](evidence/alternative-fixes/branch-heads-after.txt): `main` is still `0a7b03f`.

## Multi-part and CRLF alternatives

Recorded later the same session, after alternatives changing several files or making several replacements became listable, and CRLF replacements became shown with LF line breaks and a stated style. Artifacts are in [`evidence/alternative-fixes/parts/`](evidence/alternative-fixes/parts/).

- Fixture: draft pull request [#55](https://github.com/mike-north/doc-linter/pull/55), from `sarif-issue30-20260930-parts-reviewed` (`04f75e0`) into `sarif-issue30-20260930-parts-base` (`48a9894`), both new branches on `main` (`0a7b03f`, unchanged). The pull request changes line 2 of `examples/alternative-parts/parse.js`. `examples/alternative-parts/windows.txt` has CRLF line endings and is outside the diff ([`fixture.json`](evidence/alternative-fixes/parts/fixture.json)).
- One finding with three fixes ([`input.sarif.json`](evidence/alternative-fixes/parts/input.sarif.json)): the first fix on line 2; then an alternative that makes two replacements in `parse.js` and one in `windows.txt`; then a two-line CRLF replacement in `windows.txt`. The expected comment was written by hand before publishing ([`oracle.json`](evidence/alternative-fixes/parts/oracle.json)).
- `validate` reported `ready` and `publish` reported `published`, pending review `5361103017` (exit 0 each; nothing on stderr).
- The independent verifier ([`readback-result.json`](evidence/alternative-fixes/parts/readback-result.json)) passed every check. The stored comment equals the oracle byte for byte and contains no carriage return. It has exactly five code blocks, in order: the three labelled parts of alternative (1) under "Changes 2 files together:", alternative (2), then the `suggestion` block holding only the first fix. Both CRLF replacements state "(CRLF line endings)".

## Live artifacts

| Artifact | State |
| --- | --- |
| Branches `sarif-issue30-20260929-base`, `sarif-issue30-20260929-reviewed` | created for this fixture; kept |
| Draft pull request [#54](https://github.com/mike-north/doc-linter/pull/54) | open draft, never merged |
| Pending review `5361030472` with one inline comment | left pending for inspection, never submitted |
| Branches `sarif-issue30-20260930-parts-base`, `sarif-issue30-20260930-parts-reviewed` | created for the multi-part fixture; kept |
| Draft pull request [#55](https://github.com/mike-north/doc-linter/pull/55) | open draft, never merged |
| Pending review `5361103017` with one inline comment | left pending for inspection, never submitted |

## What this does not show

- GitHub's rendered HTML was not captured: the reads allowed in this run return the stored Markdown, not `body_html`. The draft stays pending, so the rendering can be seen on the pull request by the publishing account. The dynamic-fence rendering itself was established earlier ([#22](https://github.com/mike-north/sarif-to-comment/issues/22)), and the fence structure is checked here by an independent reading of the stored body.
- The suggestion was not applied. Native application with alternatives above it in the same comment is not verified live; the suggestion block is the same one a single fix produces.
- One fixture and one account. A grouped first fix in a suggestion pull request, and the size limit, are covered by the fake host (`test/companion-composition.test.mts`, `test/alternative-fixes.test.mts`, `test/validate-sarif-review.test.mts`), not live.
