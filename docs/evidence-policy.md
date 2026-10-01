# Evidence policy

Owner decision · September 29, 2026 ([D40](design-decisions.md#d40-evidence-manifests-are-immutable-historical-attestations--owner-accepted), [issue #24](https://github.com/mike-north/sarif-to-comment/issues/24)). This page states how recorded evidence is kept, and lists each hash manifest with the commit or artifact it attests to. For current status, see [Current status and reconciliation](status.md).

## The rule

- **A historical manifest is an immutable attestation.** A manifest lists the file hashes, or the artifact identity, that were reviewed, accepted or released at the time it was written. It is kept byte for byte. It is never regenerated, re-sorted or edited to match later files.
- **Each manifest is annotated with what it attests to.** That is a commit, or an artifact such as a packed or published tarball. The annotation lives outside the manifest: in the index below, and in the evidence report that cites the manifest.
- **A later accepted snapshot gets a new manifest.** It is a new file that names its own commit or artifact, and it gets a new row in the index. The earlier manifest stays as it is.
- **Verify at the recorded commit, not at the current head.** For a manifest of file hashes, hash each file at its recorded commit: `git show <commit>:<path> | shasum -a 256`. A mismatch at a later head is expected wherever a listed file was edited afterwards. It is not a defect in the manifest.
- **Other evidence is historical in the same way.** Evidence reports, outcome and readback files, screenshots and experiment records describe what was observed when they were made. They are not updated to describe later behavior. Current behavior is described by the contracts, the README and the tests.

The September 28, 2026 reconciliation, which preceded this policy, made two value edits in evidence files. The [editorial note](status.md#editorial-note) records them.

## Index of manifests

The "Checked" column records a check made on September 29, 2026 by hashing each listed file at the recorded commit.

| Manifest | Attests to | Checked |
|---|---|---|
| `docs/evidence/milestone-e2e/code-hashes-before-final.txt`, `docs/evidence/milestone-e2e/code-hashes-after-final.txt` | The ten product files of the first milestone at commit `dfaebb0`, hashed before and after the final live runs ([first-milestone live evidence](milestone-e2e-evidence.md)). The two files are identical. | All 10 entries match at `dfaebb0`. |
| `docs/evidence/suggestion-application/code-hashes.txt` | The same ten files at commit `dfaebb0` ([suggestion application](suggestion-application-e2e.md)). | All 10 entries match at `dfaebb0`. |
| `docs/evidence/independent-review/reviewed-hashes.txt` | The working snapshot examined by the independent re-review ([report](evidence/independent-review/review.md)). This is not a commit. | 13 of 16 entries match at `dfaebb0`. `src/prepare-review.cjs`, `test/composition.test.cjs` and `test/prepare-review.test.cjs` differ there, and no commit matches every entry. |
| `docs/evidence/npm-release/accepted-source-hashes.txt` | The release tooling, workflows, declarations and documents accepted for npm publication, at commit `d13d144` ([npm release verification](npm-release-verification.md)). | All 12 entries match at `d13d144`. |
| `docs/evidence/second-milestone/reviewed-source.sha256` | The reviewed 0.2.0 source at commit `da3c138`, apart from three versioning files that record the tree after versioning: `package.json`, `CHANGELOG.md` and the consumed `.changeset/authoring-inspection-staged-changes.md` ([second-milestone evidence](second-milestone-e2e-evidence.md#identities)). | 322 of 325 entries match at `da3c138`. The other three are those versioning files. |
| `docs/evidence/second-milestone/release/registry-file-identity.json` | The published `sarif-to-comment@0.2.0` tarball: 246 files, equal to the accepted packed artifact, SHA-256 `13b75f53…` ([release verification](second-milestone-release-verification.md)). | An artifact; verified at release. |
| `docs/evidence/typescript-migration/accepted-identity.json` | `sourceFiles`: the migrated source at commit `dc5dfee`. `tarballSha256` and `installedFileHashes`: the packed and installed candidate accepted before release, SHA-256 `c7da8fe6…` ([migration acceptance](typescript-migration-verification.md)). | All 102 `sourceFiles` entries match at `dc5dfee`. The tarball is an artifact, verified at acceptance. |
| `docs/evidence/typescript-migration/release/registry-file-identity.json` | The published `sarif-to-comment@0.2.1` tarball: 247 files, SHA-256 `85d3ef80…`, released from commit `a320567` ([release verification](typescript-migration-release-verification.md)). | An artifact; verified at release. |
| `docs/evidence/release-acceptance/package/tarball-identity.json` | The tarball packed from commit `89826ad` for release acceptance, before any version bump (it still names itself `0.2.1`): 536 files, SHA-256 `314fd9a4…` ([release acceptance](evidence/release-acceptance/README.md)). Not published. | An artifact; verified by `release-guard verify-pack` at acceptance, October 1, 2026. |

## Adding a manifest

When a later snapshot is accepted, write a new manifest in the evidence directory of the work it attests to. Name its commit or artifact in the report that cites it, and add a row to the index above. Never replace or edit an existing manifest, and never change an existing row's attestation.
