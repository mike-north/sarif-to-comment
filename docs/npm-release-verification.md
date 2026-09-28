# npm release verification

The publishing task adds Changesets versioning, an explicit pre-1.0 release ceiling, generated API documentation, and consumer documentation. Product runtime behavior must remain unchanged. The source repository stays private; the npm package is public. This task supersedes the first milestone's npm-publication deferral.

## Acceptance record

| Requirement | Evidence | Status |
| --- | --- | --- |
| npm trusted-publisher connection | npm Settings displayed “Successfully added new Trusted Publisher connection” and the saved mike-north/sarif-to-comment / publish.yml entry, allowing npm publish; [screenshot](evidence/npm-release/trusted-publisher.png) | Saved; actual OIDC release pending |
| Private GitHub source repository | Authenticated `gh repo view` returned PRIVATE and default branch main | Verified before release |
| Changesets release process and ceiling | Independent re-review reproduced quoted major refusal, quoted minor/patch progression and an explicitly raised ceiling allowing 1.0 but refusing 2.0 in temporary copies; actual ceiling remains 0 | Verified; final release pending |
| API Extractor and API Documenter | Independent review reproduced generation and rejection of stale declarations, signatures, generated pages, orphan pages and API report | Verified; receipt wording repaired and independently rechecked |
| README/getting-started examples | Independent review ran the guide's actual code from a locally packed and installed package through the public library and CLI | Local verification complete; registry installation pending |
| Behavior preservation | Product src/, bin/ and vendor/ byte-identical to the accepted first milestone during independent review | Verified again against the live-milestone source hashes |
| GitHub Actions pins | Official remote tags resolve to checkout v7.0.1 commit 3d3c42e5aac5ba805825da76410c181273ba90b1, setup-node v7.0.0 commit 820762786026740c76f36085b0efc47a31fe5020, pnpm/action-setup v6.1.0 peeled commit ea17c68df8912ef543352723c149a84f56e3d413 | Verified |
| Published package | npm contained only 0.0.0 at start | Release and consumer proof pending |

## Provenance boundary

[npm's trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/) distinguishes OIDC authentication from provenance attestations. Trusted publishing supports this private source repository, but automatic provenance requires a public source repository. The release workflow intentionally omits `--provenance`; it must not claim an attestation or change source visibility to obtain one.

## Independent review and repair

The initial reviewer identified three actionable findings: quoted Changeset bump values were ignored; raising the documented major ceiling did not permit the newly allowed major; and `published` documentation claimed current remote existence even when returning a final local receipt without network access. The same Opus author repaired these tests-first; [independent re-review](evidence/npm-release/independent-recheck.md) confirmed all three fixed. The author then added regressions for empty/no-release Changesets and applying them without a version bump, following Changesets semantics. The prior author checkpoint passed 1,392 tests without skips, and [27 deliberate release defects](evidence/npm-release/mutation-results.txt) were detected. Final documentation repairs explain how a new repository commit differs from rerunning an old failed workflow. The parent independently inspected these comment/documentation deltas and the no-release Changeset consumption branch, then ran the full check: 1,398 tests passed, none skipped, with lint, types, API freshness and release-plan checks passing. The first parent run was blocked from opening a local HTTP test server by the sandbox; the normal permissioned rerun passed. No confirmed local defect remains.

Local worker transcripts and full test logs remain in ignored `logs/opus/`. This document records durable outcomes, not credentials or raw authenticated traffic.
