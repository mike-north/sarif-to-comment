# Live evidence: exact review-body readback and native suggestion application fixture

On September 27, 2026 the real public product was run against GitHub. It used the actual CLI and the in-memory library, the real adapter, and global `fetch`. The runs close the independent reviewer's remaining live-evidence gaps (E1 in `<working-logs>/assembled-review-04-result.md`), including subsequent native browser application and exact-byte verification by the supervising verifier.

Expectations were written by hand before any run (`docs/evidence/suggestion-application/expected.json`, `expected-after-apply/`, `expected-blobs.txt`). Readback came from an independent reader that shares no code with `src/`. Raw, credential-free evidence is in `docs/evidence/suggestion-application/raw/`; a scan of all 128 evidence files found no credential.

## Demonstrated

| Gap | Result on the real host |
|---|---|
| Exact readback of an inline-only review body | The suggestions review body reads back as exactly `"\n\n<!-- sarif-to-comment:review:69e623b0-bf6e-43ca-b352-86e9da33496b -->"`. It equals the saved create request byte for byte, and so does every one of its 3 comment bodies. |
| General feedback quoting CRLF source | The CLI published a general-only review quoting `crlf-notes.txt` lines 1–2. The body read back byte-for-byte equal to the request, raw `\r` included (`alpha\r\nbeta` inside the fence), with its exact permalink. The product itself reported `published`, which requires that exact body match. |
| GraphQL anchor fields used for readback | The threads' `diffSide`, `originalLine`, `originalStartLine`, `startDiffSide`, `subjectType` and `originalCommit` equal the hand-authored anchors: RIGHT 2, RIGHT 2–3 and RIGHT 3, all on the reviewed head. |
| Product-generated line-count-changing and deletion suggestions | The library emitted a one-line-to-three suggestion, a two-lines-to-one suggestion, and a middle-line deletion (an empty suggestion fence). There was one create with 3 comments and no `event`. |

**Host fact:** the per-review REST comments endpoint returns `line`, `side` and `original_line` as `null` both while the review is pending and after it is submitted. It exposes only positions. Anchor readback therefore has to come from the GraphQL thread's original fields.

Code identity for these runs: every product file predates the runs and is identical to the hashes previously reported (`docs/evidence/suggestion-application/code-hashes.txt`). For example, `src/prepare-review.cjs` is `9626bc1b…` and `src/github.cjs` is `f43b4e56…`. No product code changed, and no defect was found.

## Verified native browser application

[PR mike-north/doc-linter#16](https://github.com/mike-north/doc-linter/pull/16) was closed unmerged after verification.

| Item | Value |
|---|---|
| Base | `a43efe70bad0b22c31b03db9985abbad89d44d3e` (`sarif-e2e/apply-base-20260927`) |
| Head | `54cae057bc66ef7b49c3186923e0be0a0a0917ae` (`sarif-e2e/apply-head-20260927`) |
| Review | [5333375577](https://github.com/mike-north/doc-linter/pull/16#pullrequestreview-5333375577), authored by `mike-north` (id 558005) and published through the library |

The review was submitted as **COMMENT** solely for this experiment, by the evidence tool after the author, PENDING and single-marker checks, at 2026-09-28T02:31:06Z with the body unchanged. The product itself remains draft-only.

Each suggestion targets a separate file, so the order of application does not matter:

| Comment | File, anchor | Suggestion | Blob now | Expected blob after Apply |
|---|---|---|---|---|
| [r4118039304](https://github.com/mike-north/doc-linter/pull/16#discussion_r4118039304) | `apply-fixture/one-to-three.txt`, RIGHT 2 (`replace me`) | `first replacement\nsecond replacement\nthird replacement\n` | `1b9fd7f5…` | `bc330c7477115f2e4a7aac83eb993a8078066f52` (79 bytes) |
| [r4118039314](https://github.com/mike-north/doc-linter/pull/16#discussion_r4118039314) | `apply-fixture/two-to-one.js`, RIGHT 2–3 | `  return 'Goodbye, ' + name;\n` | `69baa339…` | `846ad07e232eaaa60c5e46462bbf373334429ed1` (57 bytes) |
| [r4118039316](https://github.com/mike-north/doc-linter/pull/16#discussion_r4118039316) | `apply-fixture/delete-middle.txt`, RIGHT 3 (`delete me`) | empty (delete the line) | `18a66067…` | `dd5ec2852977a3379935cb14ff2ecefb2f4a683e` (38 bytes) |

The exact expected bytes are in `docs/evidence/suggestion-application/expected-after-apply/`. After clicking GitHub's native Apply (individually or as a batch), compare `git rev-parse <new head>:apply-fixture/<file>` with the expected blob ids above.

The supervising verifier clicked GitHub's native **Apply suggestion → Commit changes** for each of the three comments in signed-in Chrome. GitHub reported each application successful. The resulting head is `ee7d1ea18c3e99cbd399194eecdb9c908c190e94`; the three commits are `8310df8eadbc58d88abc7a3de9a57504d3803f45`, `6185e7d97392039f2f92883b510d5b1265939b97` and `ee7d1ea18c3e99cbd399194eecdb9c908c190e94`.

Independent REST reads pinned to that final immutable commit were decoded and compared byte for byte against the pre-authored expected files. All three matched. Independently calculated Git blob hashes also matched both GitHub's blob identifiers and the pre-authored expectations. Evidence: [applied-files.json](evidence/suggestion-application/applied-files.json), [browser screenshot](evidence/suggestion-application/applied-browser.png). No expected replacement text was committed through Git or an API; GitHub's suggestion application produced the tested files.

## Cleanup performed

**PR #14:** the supervising verifier had visually verified draft review 5333352940 in signed-in Chrome. Before deletion, a fresh readback passed every check (`raw/pr14-verify-05-before-cleanup.txt`). It was then deleted after checking author 558005, state PENDING and its single marker `<!-- sarif-to-comment:review:d0dad03f-6464-4421-9216-9d303034be75 -->` (`raw/pr14-delete-cli-final.json`). PR #14 was closed unmerged with no reviews.

**PR #16 CRLF-general draft:** draft 5333374050 was deleted after the same checks, to free the author's single pending-review slot (`raw/pr16-delete-crlf.json`).

No other review or draft was touched. `main` remains `0a7b03fe399255a62118311cbc3e1bd6fe64cb23`. Fixture branches are retained. After all three exact-byte checks passed, the supervising verifier verified the fixture branch identities and final head, closed PR #16 unmerged, and retained its submitted review as evidence. See [cleanup.json](evidence/suggestion-application/cleanup.json). No pending experiment draft remains.
