# sarif-to-comment

## 0.2.0

### Minor Changes

- Write, inspect and extend SARIF without an analyzer, and turn staged Git changes into suggested fixes.

  - New library functions `createSarifDocument`, `addSarifComment`, `inspectSarif` and `addStagedChangesToSarif`, with TypeScript declarations. They work on ordinary in-memory SARIF, never change their input, and accept SARIF from any producer.
  - New CLI commands `init`, `add-comment`, `inspect`, `add-staged-changes` and `publish`.
  - `--format human|json` on every command: JSON mode prints exactly one document for every outcome, errors included.
  - `add-staged-changes` reads only the Git index, never unstaged working-tree content. It attaches a change to a finding only when the finding's lines lie within the change, and fails with an explanation for changes it cannot represent. An existing output file is preserved under a timestamped `.old.` name.
  - Publishing is unchanged. The original flag-only command keeps its exact behavior, output and exit statuses.

## 0.1.1

### Patch Changes

- e3a0c2a: Correct the release documentation shipped in the README.

  - Provenance is described conditionally. Trusted publishing authenticates with OIDC from a private or public repository, but npm attaches a provenance attestation only when the source repository is public at publish time. Version 0.1.0 carries a verified attestation; a release from a private repository has none.
  - Release commits are no longer said to be recorded as `gitHead`, which is absent from the registry metadata for 0.1.0. The commit is identified by the `publish.yml` run and, when present, the provenance attestation; tags remain optional.

## 0.1.0

### Minor Changes

- d13d144: First release: publish a ready SARIF 2.1.0 document as one GitHub draft pull request review.

  - Library (`publishSarifReview`, in-memory SARIF) and CLI (`sarif-to-comment`) share one validation, placement and publication core.
  - Whole-review validation: invalid, inconsistent, unsupported or held input blocks the entire review before any write.
  - General feedback in the review body, exact inline comments on changed lines, and supported fixes as native suggestions, sent in one create-review request pinned to the reviewed commit.
  - Durable, never-duplicating delivery: a caller-chosen state path records intent before sending, and retries confirm the review on GitHub instead of creating another.
  - TypeScript declarations, a getting-started guide and generated API reference are included in the package.
