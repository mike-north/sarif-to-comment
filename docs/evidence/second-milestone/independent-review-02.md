# Second-milestone independent review 02: reconciliation of the final fixed snapshot

This review is read-only. It examines the snapshot at `logs/opus/m2/review-snapshot-02` (Git baseline `bedc5b8`, package `0.1.1`, with the minor Changeset present), against its manifest `logs/opus/m2/review-snapshot-02.sha256`.
- **Manifest file SHA-256:** `18e459187b193da1f1cb56c2c6d26f4636ed3ff6d61ec2ab102e793b111774f1`.
- **Manifest size:** 325 entries, including 225 generated `docs/api` pages.

It is compared with review 01 (`logs/opus/m2/review-01-report.md`, snapshot 01). Probes and outputs are in `logs/opus/m2/review-02-probes/`. Mutations ran only in the throwaway copy `/tmp/m2-review-02-mut`. I made no product, test, snapshot or Git change and no external write, and I ran no parent fixture or remote action. This covers exactly the snapshot below and nothing changed after it.

## Conclusion

**No material defect remains in this snapshot within the reviewed scope.**
- Review 01's findings C1–C5 and the known grouped-fix case are fixed and independently reproduced.
- Each repair is guarded by the snapshot's own tests.
- No new actionable defect was found.

Remaining items are support limits, the evidence gate you own, and one correction to review 01.

## Coverage and checks

- `shasum -a 256 -c review-snapshot-02.sha256` reported all 325 OK, both before and after the review. The snapshot's `git status --porcelain` was identical before and after.
- **Actual delta against snapshot 01** (`diff -rq`), matching `review-snapshot-02-delta.txt`:
  - source: `src/staged-changes.cjs`, `src/sarif-inspection.cjs`, `src/cli.cjs`;
  - declarations: `types/index.d.ts` and `api-report`;
  - documents: `README.md`, `docs/getting-started.md`;
  - tests: `test/staged-changes.test.cjs`, `test/sarif-inspection.test.cjs`, `test/cli-commands.test.cjs`, `test/package.test.cjs`;
  - new tests and fixtures: `test/staged-changes-integration.test.cjs`, `test/staged-changes-supplied-fixes.test.cjs`, `test/fixtures/sarif-inspection/log-evidence.sarif.json`;
  - generated `docs/api` pages;
  - documentation and evidence files only: the live acceptance plan, release audit, work record and two `docs/evidence/second-milestone` files. I did not review these, and I ran none of the evidence they contain.
- **Unchanged since review 01, so review 01's evidence still applies:**
  - `src/staged-git.cjs`, `src/sarif-authoring.cjs`, `src/sarif-common.cjs`, `src/artifact-files.cjs`, `src/index.cjs`, `bin/sarif-to-comment.cjs`;
  - the publisher: `src/prepare-review.cjs`, `src/publication.cjs`, `src/placement.cjs`, `src/replacements.cjs`, `src/github.cjs`.
- **Focused checks in the snapshot:**
  - These nine test files: 723 tests, 723 passing, 0 failing, 0 skipped.
    - `node --test test/staged-changes.test.cjs test/staged-changes-integration.test.cjs test/staged-changes-supplied-fixes.test.cjs test/staged-changes-identity.test.cjs test/sarif-inspection.test.cjs test/cli-commands.test.cjs test/prepare-review.test.cjs test/publication.test.cjs test/cli.test.cjs`
  - `check:types` exit 0; `check:api` exit 0 ("API report and 225 reference pages are up to date"); `check:lint` exit 0.
  - You own the full assembled check. I did not repeat it.

**Final reviewed source hashes (SHA-256):**

| File | SHA-256 |
|---|---|
| `src/staged-changes.cjs` | `737498aa11ef5b4a1d323ba0e465baa187f477af472b3a7980cd20816bc5ee09` |
| `src/sarif-inspection.cjs` | `d1ebd17796e0fa005a10aac0aeb4f364a391f1850f347c62b471b2978fbf4284` |
| `src/cli.cjs` | `0b8133b7e2d683558efbe01bfa1cddb74088524b1f299fc5b686028803d390ce` |
| `src/staged-git.cjs` | `a54ce8608c0d17bc70ee9b8f5e8672ab421867b5bda06ed50d0a55aeedf002bd` |
| `src/sarif-authoring.cjs` | `edb7c7b7e2a056ac520a5430a6c71fd9e925efbd671256fe6d0bf31cd582f853` |
| `src/sarif-common.cjs` | `ba645328b239462beddf1478964d8232a9217efc1b3937a1f88897ee87b29446` |
| `src/artifact-files.cjs` | `bf3d7e30acba59c62f069db35524b610af49c0345d47d81afdb1a4687dbaefc0` |
| `src/index.cjs` | `6b01cda2c541926a190c731cdb3acde68a620c8b8b28f10c21fe0823517bef28` |
| `src/prepare-review.cjs` | `9626bc1b2504d8933ea5395f9594a5a58a1f2e61c8b14f8a108abcad1ee91852` |
| `src/publication.cjs` | `71fff07a0cedc52408df3974fd387ff4668260ea4d4b8b35d3d3221c9615e7b8` |
| `src/placement.cjs` | `7f0df1a586972162c5496757c29adcf211d566884e2243fd6eb0ba87b44bbefc` |
| `src/replacements.cjs` | `71109a561fed6d2ae4b339cc71c12be74300b7638b007b300f2c915652fdd9dd` |
| `src/github.cjs` | `f43b4e561637aefbaac05f02d17d11b9e8fabedb158aa15a44c3ca25fd73bfa7` |
| `bin/sarif-to-comment.cjs` | `f9e0b1400975552971e7cb071545fa2865bf74c7b3d1e44005b77071211bbdf7` |
| `types/index.d.ts` | `baf01f24068cb12faa2d18893156bc2894ed5534706addfa8fd6edf4b1d84a96` |
| `api-report/sarif-to-comment.api.md` | `30ee2e0e5815e818b47a60888525f363c3e315e22003361f0143f34ee8851ad5` |
| `README.md` | `d22f424ba2e802137cb5e0dfc95d3fabc2ee70171f1c13fcac9ed0c5da8801e9` |
| `docs/getting-started.md` | `26a18807ef724f7fc259d280f264002e8ed058e148a98f4d8cf94c519847616e` |
| `package.json` | `173ef00273b6c46ba5aa96f31f1dc72c2f5f45af004c20513ce80f7551d5fb3f` |
| `.changeset/authoring-inspection-staged-changes.md` | `d66d6a4aaeccc5495533ad240f1e7c808cd8080d97603c5133d0633f2e2c2144` |
| `test/staged-changes.test.cjs` | `4759fbe933bf00f7f3fef2900e5b253c0c46f0d6be66820ae4419596c2c23a01` |
| `test/staged-changes-integration.test.cjs` | `eb9e3ecd142edb1710ea213e1969d18252106c283257ce4c83647d40c4c5056a` |
| `test/staged-changes-supplied-fixes.test.cjs` | `11eb68c88197c65539e602f5c7c175b2535c5e3ba24aa2384890cfe3af43b321` |
| `test/staged-changes-identity.test.cjs` | `e100da48709cbdd6921d878209c553bc4f33f7d687a4e77e745a43304d054209` |
| `test/sarif-inspection.test.cjs` | `4ec239a8ec684ccb2336db2544f998066d35c895d7b78b2e0030e86033db2369` |
| `test/cli-commands.test.cjs` | `73080e1819a109b6b1843b48558315060440e3d6d5ca6f5d945a6c128179a42f` |
| `test/package.test.cjs` | `cec19286432f91927bb61c4057d4bb3b66b97e5e486d55eee28704f04a636b70` |
| `test/fixtures/sarif-inspection/log-evidence.sarif.json` | `c9616fe5265b22a3bbba11896116e78c64793f1bc532a30af2e13ac03c766d0d` |

## Reconciliation

**C1 — fixed.** Extracted pure insertions now prepare through the unchanged publisher.
- **The repair:** an insertion before an existing line is located by its zero-length insertion point, the same point its fix uses. An end-of-file append, or an insertion into a file with no visible lines, has no location. A finding is never credited.
- **Evidence** (`c1-insertions.cjs`, `c1.out`). Five cases, each with findings on the neighbouring lines:
  - middle insertion;
  - insertion before line 1;
  - end-of-file append (LF);
  - end-of-file append (CRLF);
  - middle insertion (CRLF).

  In every case:
  - `prepareReview` is ready with exactly one native suggestion;
  - 0 neighbouring findings are credited;
  - an oracle independent of the product, which replaces the anchored reviewed lines with the payload using the file's own terminator, reproduces the staged bytes.

  My review-01 probe (`p1.out`) now prepares as RIGHT line 3.
- **Guarded:** reverting the location repair fails 3 of the snapshot's own tests (`repair-reversions.cjs`, `reversions.out`). Keeping a path-only location for end-of-file appends also fails 3.

**C2 and the grouped-fix case — fixed.** Supplied fixes are now compared by the combined effect of connected groups of supplied replacements and staged hunks (`compareSuppliedFixes`/`components`). Evidence is in `c2-supplied-fixes.cjs` and `c2.out`; every accepted case was checked by an independent applier against the staged bytes.

| Case | Outcome |
|---|---|
| One replacement spanning two hunks (review-01 C2) | `added`; explained by the existing fix; upstream fix kept verbatim; no neutral run; staged bytes reproduced (no duplicate edit) |
| Two replacements, one per hunk: line-only | `added`, as above |
| Two replacements, one per hunk: whole-line | `added`, as above |
| One replacement equal, one different | `failed` |
| Your original case (line-only region, newline-bearing text, a genuine extra newline) | `failed`: correctly a real conflict. This is not cited as closure evidence. |
| Supplied fix equal to the first hunk only | first hunk `existing-fix`, second hunk a neutral result; staged bytes reproduced |
| Overlapping supplied replacements | `failed`, with a precise message |
| Two insertions at the same position | `failed`, with a precise message |

- **Guarded:** disabling the grouping fails 14 tests.
- **Contract note:** a supplied fix that equals one hunk but also carries an extra non-overlapping edit the index does not make is kept verbatim, as §4.5 requires for non-overlapping proposals. Applying all fixes then differs from the staged bytes by exactly that supplied edit. This is contract-consistent, and publication blocks multi-replacement fixes anyway.

**C3 — fixed.** A BOM-only reviewed file now yields one insertion at `charOffset 0` after the mark, with no fabricated line (`c3-c4.cjs`, `c3-c4.out`).

| Reviewed / staged | Outcome |
|---|---|
| `EF BB BF` / `EF BB BF 7A 0A` | independently reproduces the staged bytes |
| BOM-only / two lines without a final newline | independently reproduces the staged bytes |
| Empty (no BOM) / one line | independently reproduces the staged bytes |
| BOM-only / BOM removed | precise BOM-transition refusal |

- **Randomized check** (`p4-r2-fuzz.cjs`, seeds 12345 and 999): 270 cases, 0 mismatches, 0 crashes. Review 01's 13 crashes are gone; the only refusals are my harness putting findings on empty files, which are correct refusals.
- **Support limit:** the unchanged publisher refuses these files with precise diagnostics (`suggestion-final-newline-unverified`, `replacement-unanchored`).
- **Guarded:** removing the branch fails 3 tests.

**C4 — fixed.**
- **What now survives:** log `properties`, results in `inlineExternalProperties`, run `externalPropertyFileReferences`, and `insertedContent.properties`/`rendered` all appear in both the JSON view and the human rendering.
- **External results:** they are counted in `summary.externalFindings` and shown verbatim with a warning, and are not turned into findings. The view still holds 1 finding, `/runs/0/results/0`, so no run association is invented.
- **Ordinary logs:** a log without these has an unchanged view shape.
- **Guarded:** removing external properties fails 3 tests; dropping content metadata fails 5.

**C5 — fixed.** Pure-insertion receipts give `{ startLine: L, endLine: L-1, insertion: true }` (1/0 for the start of a file or an empty file). This matches the updated `types/index.d.ts` remarks and the regenerated API pages.
- **CLI:** checked through the actual CLI (`c5-cli-and-symlink.cjs`, `c5.out`). The human output reads "insertion at the start of the file (no reviewed line changed)" and "insertion after line 2 (no reviewed line changed)"; the JSON receipt matches.
- **Guarded:** reverting fails 3 tests.

**Supplied file-proposal equality — assessed, sensible** (`supplied-proposals.cjs`, `proposals.out`).

| Supplied proposal differs by | Outcome |
|---|---|
| Opaque annotations: artifact `description`, `mimeType`, `roles`, `properties`; `contents.rendered`/`properties`; a `UTF-8` case variant; a hash under a non-computable algorithm | explained (`existing-proposal`) |
| Encoding `utf-16le` | refused with a precise reason |
| Different content | refused with a precise reason |
| Different file mode | refused with a precise reason |
| Wrong declared `sha-256` | refused with a precise reason |
| An unknown field on the product-owned `proposedFileChanges` operation | refused with a precise reason |

The last row is strict but defensible: the operation schema is this product's own namespace. This supersedes review 01's nonblocking note on supplied-proposal equality.

## Correction to review 01

Review 01 said that `add-comment` on a SARIF path that is a symbolic link replaces the link with a regular file. **That was wrong.** I inferred it from `src/artifact-files.cjs` without reading `src/cli.cjs`, which already calls `fs.realpathSync` before locking and replacing, in both snapshots (`src/cli.cjs:569`).
- Rechecked through the actual CLI (`c5.out`): exit 0, the link is still a symbolic link, its target gained the comment, and no marker or temporary files were left.
- Withdraw that observation.

## Nonblocking notes and evidence gates

- **Documentation nuance.** `README.md` says that "Staged edits to UTF-8 text files become suggested fixes". For empty or BOM-only reviewed files, extraction is faithful but publication blocks. That is a support limit, not a wrong edit, and the edge could be documented.
- **Deliberate strict refusals, unchanged from review 01.** Split and sparse indexes are refused, and an unresolvable artifact reference in an eligible run fails extraction.
- **Evidence gate: installed and real-GitHub acceptance on the owned PR19/20.** Your independent insertion oracle and its index/working-tree divergence, and live application of the extracted suggestions, remain yours. I did not run or observe them. Local fixtures and the unchanged publisher's preparation do not prove GitHub placement or application.
