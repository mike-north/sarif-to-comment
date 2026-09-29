# npm release verification

> **Historical release record (reconciled September 28, 2026).** The latest release is 0.2.1. The latest release evidence is [TypeScript migration release verification](typescript-migration-release-verification.md). For current status, see [Current status and reconciliation](status.md).

The current verified release is [0.2.0](second-milestone-release-verification.md). The record below preserves the initial release-setup and 0.1.1 verification history.

`sarif-to-comment@0.1.1` is published and verified from a clean public-registry installation. Trusted publishing, Changesets, the pre-1.0 guard, API Extractor and API Documenter, and the shipped CLI/library guides are complete. On 2026-09-28 the user explicitly instructed “Keep it public,” superseding the original private-visibility constraint. The repository remains public; no agent changed its visibility.

## Acceptance record

| Requirement | Current evidence | Status |
| --- | --- | --- |
| npm trusted-publisher connection | Saved `mike-north/sarif-to-comment` / `publish.yml` connection with no environment; [setup screenshot](evidence/npm-release/trusted-publisher.png). The [0.1.1 publish run](https://github.com/mike-north/sarif-to-comment/actions/runs/36433021589) succeeded without a long-lived npm token. | Verified |
| Source repository visibility | Authenticated reads returned PUBLIC before the 0.1.1 push; the user explicitly chose public source on 2026-09-28. The earlier private constraint is superseded. | Verified under the updated instruction |
| Changesets release process | Real `release:version` consumed the initial minor Changeset for 0.1.0 and the documentation patch Changeset for 0.1.1, producing the versions and changelog entries. [Patch release commit](https://github.com/mike-north/sarif-to-comment/commit/b586beeb25314eee6dd90c8a2a1dbb3f002c27c3). | Verified |
| Pre-1.0 safeguard | `MAXIMUM_RELEASE_MAJOR` remains 0. Independent review exercised quoted/unquoted major refusal, patch/minor progression and deliberate ceiling override; [27 deliberate defects](evidence/npm-release/mutation-results.txt) were detected. Release checks passed for the final patch. | Verified |
| API Extractor / API Documenter | A generated API report and 38 Markdown pages are current; independent mutation probes rejected stale declarations, signatures, pages, orphan pages and report edits. All published 0.1.1 reference pages match source. | Verified |
| README and getting-started examples | Shipped examples executed through the registry-installed library and CLI, each creating one draft in the controlled HTTP fixture and returning the same receipt on retry. The corrected README is published. [Consumer evidence](evidence/npm-release/0.1.1/registry-consumer-result.json). | Verified |
| Published type declarations | CommonJS and ES-module compilation, exhaustive outcomes and invalid-input negative control all pass against the installed 0.1.1 package. [Evidence](evidence/npm-release/0.1.1/registry-types-docs-check.txt). | Verified |
| Public documentation links | Versioned README, getting-started and API-index links returned HTTP 200 and exactly matched installed files. [Evidence](evidence/npm-release/0.1.1/documentation-links.json). | Verified |
| Product behavior unchanged | Registry-installed src/, bin/ and vendor/ match source byte for byte. Git diff against the accepted live milestone is empty for those directories. | Verified |
| GitHub checks | Both Node 22 and Node 24 passed on the [0.1.1 release commit](https://github.com/mike-north/sarif-to-comment/actions/runs/36433021542). The publish job independently passed all 1,415 tests, with no failures or skips, plus lint, types, API freshness and release checks. | Verified |
| Artifact identity | Registry SHA-1 `76e706586e4681b03609cbb82783bee1e604c458` matches the [publish log](evidence/npm-release/0.1.1/publish-run-summary.txt); 52 packed files. [Registry metadata](evidence/npm-release/0.1.1/registry-metadata.json). | Verified |
| Registry signatures and provenance | npm verified signatures for all eight installed packages and one provenance attestation. [Verification](evidence/npm-release/0.1.1/signature-verification.txt); [decoded statements](evidence/npm-release/0.1.1/provenance-statements.json). | Verified |

## Provenance and visibility

[npm's documentation](https://docs.npmjs.com/trusted-publishers/) distinguishes OIDC authentication from provenance. Trusted publishing supports private source repositories, but automatic provenance requires public source. The workflow omits `--provenance` and never changes repository visibility.

The repository was private at the beginning of setup and unexpectedly public by the time 0.1.0 was published; no agent changed it. npm generated a verified attestation for that release. The user subsequently confirmed “Keep it public,” and the 0.1.1 release preserved that observed state. The verified 0.1.1 attestation identifies commit `b586beeb25314eee6dd90c8a2a1dbb3f002c27c3`, `.github/workflows/publish.yml` and run `36433021589`. This is evidence for public-source trusted publication; no private-source release was performed.

Registry metadata for 0.1.0 omitted `gitHead`. Release documentation now identifies commits through the workflow run and, when present, the verified provenance rather than promising that registry field. The same Opus author recorded failing documentation regressions before the correction and passed all 1,415 tests; the parent independently inspected it, passed all 29 documentation tests, then reran the full check on the Changesets-generated 0.1.1 release. The original 0.1.0 evidence remains in `docs/evidence/npm-release/`; follow-up evidence is in `docs/evidence/npm-release/0.1.1/`.

## Review and runner repairs

The [initial independent review](evidence/npm-release/independent-review.md) found three defects: quoted Changeset bump values were ignored; raising the documented major ceiling did not permit that major; and `published` documentation claimed current remote existence even when returning a completed local receipt. The same Opus author repaired them tests first. [Independent re-review](evidence/npm-release/independent-recheck.md) confirmed all three fixed. The parent separately accepted the later no-release Changeset consumption correction and release-recovery documentation fixes.

Actual GitHub runs exposed two environment issues before publication:

1. pnpm 11.12.0 was marked broken by its installer. Commit `255ba20b8452dff12e1560b295025144b0579c3c` pins verified pnpm 11.27.1 and makes registry-behavior tests independent of the test Node version's bundled npm. The parent passed all 97 release tests independently.
2. Node 24.21.0/npm 11.19.0 on the Linux runner crashed while the test harness repacked an installed third-party dependency from pnpm's virtual store. The precise npm internals failure was not reproduced on macOS. Commit `34f29b22a3f4873a4708a29dfdffce91d69d9f22` supplies exact installed dependency files as npm-format tarballs while retaining real `npm pack` for this product and real `npm install` into clean consumers. New regressions cover the recorded failure boundary, archive contents, diagnostic logs and failure reuse. The parent independently passed all 43 package/type/docs/harness tests. Both real Linux CI jobs subsequently passed.

The test double used for the registry-installed examples is explicitly separate from prior live GitHub evidence. The public package runtime is byte-identical to the runtime covered by [the live first-milestone checks](milestone-e2e-evidence.md) and [native suggestion application](suggestion-application-e2e.md). No new live review was created for the registry-consumer demonstration.

Local worker transcripts and full investigative logs remain in ignored `logs/opus/`. Committed evidence includes the selected [publish summary](evidence/npm-release/publish-run-summary.txt), registry data and verification records. No credentials are included.
