# npm release verification

`sarif-to-comment@0.1.0` was published by npm trusted publishing from GitHub Actions and installed successfully from the public npm registry. The CLI, library, type declarations and shipped documentation were verified. The source repository was private at the start of this task but was observed public after publication; no agent changed visibility. The user's visibility decision is pending, so the full task is not yet complete.

## Acceptance record

| Requirement | Evidence | Status |
| --- | --- | --- |
| npm trusted-publisher connection | Saved `mike-north/sarif-to-comment` / `publish.yml` connection, permitting `npm publish`; [screenshot](evidence/npm-release/trusted-publisher.png). [Release run](https://github.com/mike-north/sarif-to-comment/actions/runs/36384821585) succeeded without an npm token in the workflow. | Verified for the actual release |
| Source repository visibility | Authenticated reads returned PRIVATE before the setup push and PUBLIC after publication. [Current observation](evidence/npm-release/visibility-after-publish.json). | User confirmation pending; private visibility has not been preserved through the entire run |
| Changesets release process | The real `release:version` command consumed the initial minor Changeset and generated version 0.1.0 and its changelog entry. [Release commit](https://github.com/mike-north/sarif-to-comment/commit/3797ca6efe2156d4c952fad7fed10b569f1dcbbb). | Verified |
| Pre-1.0 safeguard | Independent review reproduced quoted and unquoted major refusal, patch/minor progression and the deliberate ceiling override in temporary copies; actual ceiling remains 0. [27 deliberate defects](evidence/npm-release/mutation-results.txt) were detected. | Verified |
| API Extractor / API Documenter | Generated API report and 38 Markdown pages; independent mutation probes rejected stale declarations, signatures, pages, orphan pages and report edits. Published declarations and all generated pages match source. | Verified |
| README and getting-started examples | Actual shipped examples run through the registry-installed public library and CLI; each creates one draft in the controlled HTTP fixture and reuses its receipt on retry. [Consumer evidence](evidence/npm-release/registry-consumer-result.json). | Verified; provenance/gitHead wording correction pending release |
| Published type declarations | CommonJS and ES-module consumer compilation, exhaustive outcome handling and invalid-input negative control. [Evidence](evidence/npm-release/registry-types-check.txt). | Verified |
| Public documentation links | Getting-started and API-index links returned HTTP 200, redirected to 0.1.0, and exactly matched installed files. [Evidence](evidence/npm-release/documentation-links.json). | Verified |
| Product behavior unchanged | Registry-installed src/, bin/ and vendor/ match the accepted source byte for byte. Runtime source hashes also match the previous live GitHub milestone. | Verified |
| GitHub checks | Both Node 22 and Node 24 passed on the [release commit](https://github.com/mike-north/sarif-to-comment/actions/runs/36384821623); publish job independently passed all 1,409 tests, packed and checked the artifact, and published it. | Verified |
| Artifact identity | Registry SHA-1 `286b1bf09b5a209333a85a34699b63b5e15ee22e` matches the publish log; 52 files, 439,210 unpacked bytes. [Registry metadata](evidence/npm-release/registry-metadata.json). | Verified |
| Registry signatures and provenance | npm verified signatures for all eight installed packages and one provenance attestation. [Verification](evidence/npm-release/signature-verification.txt); [decoded statement](evidence/npm-release/provenance-statement.json). | Verified |

## Provenance and visibility

[npm's documentation](https://docs.npmjs.com/trusted-publishers/) distinguishes OIDC authentication from provenance. Trusted publishing supports private source repositories, but automatic provenance requires public source. The workflow omits `--provenance` and never changes repository visibility.

The source was unexpectedly public by the time 0.1.0 was published. npm therefore generated an attestation, and npm's own verifier accepted it. Its payload identifies commit `3797ca6efe2156d4c952fad7fed10b569f1dcbbb`, `.github/workflows/publish.yml`, and run `36384821585`. That proves this public-source release; it does not demonstrate a private-source release. The published registry metadata has no `gitHead` field. Commit attribution comes from the verified attestation and release-run evidence.

A user question asks whether the visibility change was intentional or private visibility should be restored. No further visibility-dependent release will be made before that answer. Local documentation corrections describe provenance conditionally and remove the unsupported `gitHead` promise. The same author recorded failing documentation regressions before the edits and passed the full check with 1,415 tests; the parent independently inspected the correction and passed all 29 documentation tests. A prepared patch Changeset will carry those corrections into 0.1.1 once the visibility decision is resolved.

## Review and runner repairs

The [initial independent review](evidence/npm-release/independent-review.md) found three defects: quoted Changeset bump values were ignored; raising the documented major ceiling did not permit that major; and `published` documentation claimed current remote existence even when returning a completed local receipt. The same Opus author repaired them tests first. [Independent re-review](evidence/npm-release/independent-recheck.md) confirmed all three fixed. The parent separately accepted the later no-release Changeset consumption correction and release-recovery documentation fixes.

Actual GitHub runs exposed two environment issues before publication:

1. pnpm 11.12.0 was marked broken by its installer. Commit `255ba20b8452dff12e1560b295025144b0579c3c` pins verified pnpm 11.27.1 and makes registry-behavior tests independent of the test Node version's bundled npm. The parent passed all 97 release tests independently.
2. Node 24.21.0/npm 11.19.0 on the Linux runner crashed while the test harness repacked an installed third-party dependency from pnpm's virtual store. The precise npm internals failure was not reproduced on macOS. Commit `34f29b22a3f4873a4708a29dfdffce91d69d9f22` supplies exact installed dependency files as npm-format tarballs while retaining real `npm pack` for this product and real `npm install` into clean consumers. New regressions cover the recorded failure boundary, archive contents, diagnostic logs and failure reuse. The parent independently passed all 43 package/type/docs/harness tests. Both real Linux CI jobs subsequently passed.

The test double used for the registry-installed examples is explicitly separate from prior live GitHub evidence. The public package runtime is byte-identical to the runtime covered by [the live first-milestone checks](milestone-e2e-evidence.md) and [native suggestion application](suggestion-application-e2e.md). No new live review was created for the registry-consumer demonstration.

Local worker transcripts and full investigative logs remain in ignored `logs/opus/`. Committed evidence includes the selected [publish summary](evidence/npm-release/publish-run-summary.txt), registry data and verification records. No credentials are included.
