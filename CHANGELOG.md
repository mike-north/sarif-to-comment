# sarif-to-comment

## 0.1.0

### Minor Changes

- d13d144: First release: publish a ready SARIF 2.1.0 document as one GitHub draft pull request review.

  - Library (`publishSarifReview`, in-memory SARIF) and CLI (`sarif-to-comment`) share one validation, placement and publication core.
  - Whole-review validation: invalid, inconsistent, unsupported or held input blocks the entire review before any write.
  - General feedback in the review body, exact inline comments on changed lines, and supported fixes as native suggestions, sent in one create-review request pinned to the reviewed commit.
  - Durable, never-duplicating delivery: a caller-chosen state path records intent before sending, and retries confirm the review on GitHub instead of creating another.
  - TypeScript declarations, a getting-started guide and generated API reference are included in the package.
