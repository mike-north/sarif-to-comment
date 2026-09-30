# Pending-review check: live GitHub evidence

Evidence record · September 29, 2026. It verifies, against the real GitHub API, the readiness check specified in [Pending review of this account](readiness-assessment-contract.md#pending-review-of-this-account) ([#23](https://github.com/mike-north/sarif-to-comment/issues/23)). The sanitized artifacts are in [`docs/evidence/pending-review-check/`](evidence/pending-review-check/), and [`live-run.json`](evidence/pending-review-check/live-run.json) lists every run.

## Setup

- **Package.** Built from commit `baf95d3`, the implementation of the check, packed with `pnpm pack` (tarball SHA-256 `aadb75ca…300cb`) and installed with `npm install` into a clean consumer. The runs used only the installed `sarif-to-comment` executable and `import { validateSarifReview } from 'sarif-to-comment'`.
- **Fixture repository.** `mike-north/doc-linter`, on two existing open fixture pull requests. Nothing was merged, published or pushed.
  - **#33** has one review, a pending draft by the maintainer account. It is the draft left pending by the [submitted-review evidence](submitted-review-e2e-evidence.md). Step 3 of that record is the live 422 refusal of a submitted create while this draft exists.
  - **#34** has two submitted (`COMMENTED`) reviews by the same account and no pending review.
- **Document.** [`probe.sarif.json`](evidence/pending-review-check/probe.sarif.json): one general finding with no location, so the document is ready on any pull request.
- **Credential.** The maintainer account's token, passed inline to each command and never printed.

## Results

| Pull request | Surface and mode | Exit | Status | Artifact |
| --- | --- | --- | --- | --- |
| #33 | CLI, draft, JSON | 2 | `blocked` | [`pr33-validate.json`](evidence/pending-review-check/pr33-validate.json) |
| #33 | CLI, draft, human | 2 | `blocked` | [`pr33-validate.txt`](evidence/pending-review-check/pr33-validate.txt) |
| #33 | CLI, `--submit`, JSON | 2 | `blocked` | [`pr33-validate-submit.json`](evidence/pending-review-check/pr33-validate-submit.json) |
| #33 | library, draft | — | `blocked` | [`pr33-library.json`](evidence/pending-review-check/pr33-library.json) |
| #34 | CLI, draft, JSON | 0 | `ready` | [`pr34-validate.json`](evidence/pending-review-check/pr34-validate.json) |
| #34 | CLI, draft, human | 0 | `ready` | [`pr34-validate.txt`](evidence/pending-review-check/pr34-validate.txt) |
| #34 | library, draft | — | `ready` | [`pr34-library.json`](evidence/pending-review-check/pr34-library.json) |

On #33, every outcome has exactly one problem, without a pointer. It names review `5348454897` and its URL, `https://github.com/mike-north/doc-linter/pull/33#pullrequestreview-5348454897`, and says that GitHub would refuse the review as a draft or as a submitted comment review. The CLI JSON `problems` and `message` equal the library's `problems` and `markdown`.

On #34, the account's two submitted reviews were ignored. The ready Markdown says that no pending review of this account was found.

## Cross-checks

- **The named review is the pending draft.** `gh pr view 33 --json reviews` reports one `PENDING` review by `mike-north`, with GraphQL node id `PRR_kwDOUuyy7s8AAAABPsrx8Q`. That id's base64url payload is the MessagePack array `[0, repository id, review id]`, and its review id is `0x13ecaf1f1` = `5348454897`, the id `validate` named from the REST list.
- **Nothing was written.** The reviews of #33 and #34 read before and after the runs are identical: the same node ids, states, authors and commits ([`reviews-before-after.json`](evidence/pending-review-check/reviews-before-after.json)). `validate` takes no state path and writes no file; the installed-package test in `test/installed-workflow.test.mts` checks the file system for the same flow.

## Limits

- One account and one repository. Pending reviews by another account cannot be observed live, because GitHub shows a pending review only to its author. That case, pagination, ambiguous host data and review-list failures are covered by `test/validate-pending-review.test.mts`, against the host double and against the real client over HTTP.
- The runs show GitHub's state at the time of the runs. A `ready` result does not promise that a later `publish` succeeds.
