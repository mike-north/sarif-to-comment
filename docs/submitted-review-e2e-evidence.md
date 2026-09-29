# Submitted comment reviews: live GitHub evidence

Recorded September 28, 2026, for the [submitted-review contract](submitted-review-contract.md). Sanitized artifacts are in [`evidence/submitted-review/`](evidence/submitted-review/). No token, environment or local path is recorded; local paths appear as `<state-dir>`, `<work>` or `<home>`.

## Fixture

- Owned private sandbox `mike-north/doc-linter`. Both pull requests are drafts and are never merged. The default branch was not touched (`0a7b03f` before and after).
- Base branch `sarif-issue7-20260928-base` (`0a7b03f`). The reviewed commit `05f3237` adds a seven-line page, `docs/sarif-issue7-fixture.md`.
- Pull request #33 (`sarif-issue7-20260928-draft`): the default publication. Pull request #34 (`sarif-issue7-20260928-submitted`): the explicit submitted publication. Both heads are the reviewed commit.
- The SARIF was authored with the installed CLI (`init`, `add-comment` ×2, `add-staged-changes`): a finding on line 4 with a staged fix (a native suggestion) and a finding on lines 6–7 ([`review.staged.sarif.json`](evidence/submitted-review/review.staged.sarif.json), [`fixture.json`](evidence/submitted-review/fixture.json)).
- The package was built from this branch, packed and installed into a clean consumer (tarball SHA-256 `4e4aac6c…`). Every step used the installed executable, except the discarded-response run, which used the installed library.

## Run

| Step | Command | Result |
| --- | --- | --- |
| 1 | `validate` on #33 (no flag) | `ready`, exit 0; draft wording unchanged |
| 2 | `publish` on #33 (no flag) | `published`, exit 0: draft review `5348454897`, request without `event` |
| 3 | `publish --submit` on #33 with a new state path, while that draft is pending | `rejected`, exit 1: HTTP 422 "User can only have one pending review per pull request"; recorded, never resent |
| 4 | `validate --submit` on #34 | `ready`, exit 0: "… as a submitted comment review." |
| 5 | `publish --submit` on #34 | `published`, exit 0: review `5348457465`, `## Review submitted` |
| 6 | step 5 again, same state path | `published` from the receipt: "Nothing was sent." |
| 7 | step 5's state path without `--submit` | exit 1: "records a submitted review, but a draft review was requested"; no request |
| 8 | installed library, `options.submit: true`, new state path, create response discarded after GitHub received it ([`lost-response.mjs`](evidence/submitted-review/lost-response.mjs)) | `published` via recovery: one create request, then review list, comments and review threads read back; review `5348460479`, "confirmed on GitHub for this publication; nothing was resent" |
| 9 | step 8's state path via the CLI with `--submit` | `published` from the receipt |

Step 3 answers the host question the contract left open (§2.6): GitHub refuses a submitted create while the account has a pending review on the pull request, exactly as it refuses a second draft.

## Independent readback

A verifier that uses only `gh pr view --json reviews`, the `gh-pr comments` listing and the state files, never the package's code ([`verify.py`](evidence/submitted-review/verify.py)), passed every check ([`readback-result.json`](evidence/submitted-review/readback-result.json)):

| Check | Draft (#33) | Submitted (#34, steps 5 and 8) |
| --- | --- | --- |
| GitHub state | `PENDING` | `COMMENTED` |
| Saved request `event` | absent | `COMMENT` |
| Body equals the saved request body byte for byte, ending with the record's marker once | passed | passed |
| Author is the publishing account | passed | passed |
| Review pinned to the reviewed commit `05f3237` | passed | passed |

- #34 holds exactly two reviews, one per state path, after steps 5–9: the retries and the discarded response created no duplicate.
- #34 lists exactly four inline comments, on lines 4 (with the suggestion) and 7 (the range 6–7), two for each submitted review. The comment listing does not name the review, so the per-review assignment rests on the package's own readback, which completed only after matching every comment's anchor and body for that review.
- #33 holds exactly one review: the refused submitted create in step 3 added nothing. The rejected state record keeps `event: "COMMENT"` in its saved request.

Draft comments are visible only to their author, so the listing shows none for #33. The package's own readback confirmed them in step 2.

## Limits

- One fixture, one account. The draft on #33 was left pending and the submitted reviews were left in place for inspection.
- Step 8 discards the response in the process, after the real request completed. It does not simulate a connection that drops while GitHub is still processing the request.
- A review's rendered HTML was not inspected. The submitted request differs from the draft request only by `event`, and the body bytes read back exactly.
