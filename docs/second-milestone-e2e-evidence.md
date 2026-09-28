# Second milestone: installed and live end-to-end evidence

On September 28, 2026 the parent packed the reviewed source as `sarif-to-comment-0.2.0.tgz` and installed it into a clean consumer. It then drove the workflow through the installed package's public library functions and its executable, against real GitHub on two owned synthetic pull requests in the private repository `mike-north/doc-linter`. Five draft reviews were created by the product. Two were submitted and their suggestions applied with GitHub's native Commit suggestion, and the resulting file bytes were read back from immutable Git blobs.

The product purpose and requirements are in [the milestone goal](second-milestone-goal.md). This report records observations. Their status against each requirement is in [the acceptance audit](second-milestone-release-audit.md).

**Where the evidence is.**
- **Consolidated record:** [acceptance-evidence.json](evidence/second-milestone/acceptance-evidence.json) is a compact, sanitized consolidation. Each publication lists the working records it was copied from.
- **Other durable evidence:**
  - [native-application.json](evidence/second-milestone/native-application.json)
  - [source-handoff.json](evidence/second-milestone/source-handoff.json)
  - [reviewed-source.sha256](evidence/second-milestone/reviewed-source.sha256)
  - [version-preparation.json](evidence/second-milestone/version-preparation.json)
  - [independent review 02](evidence/second-milestone/independent-review-02.md) and [independent review 03](evidence/second-milestone/independent-review-03.md)
  - four screenshots
- **Raw working records:** the unedited GitHub responses and product output are under `logs/opus/m2/` (`parent-live-final/`, `parent-insertion-final/`, `parent-local-final/`, `parent-installed-final.json`). That area is local and git-ignored.

**What the consolidation drops.** It omits user-profile blobs, credentials, process environments and absolute temporary paths. The product's own messages name the local state file by absolute path; the consolidation replaces that path with `<state file>`.

## Identities

| Item | Value |
|---|---|
| Reviewed source manifest | `reviewed-source.sha256`, 325 entries, file SHA-256 `823bef633b25c49908aebb6b774aba6462bef9759a2131e0c41dc7223dfc60d7` |
| Post-versioning differences from the manifest | Only `package.json` (0.1.1 → 0.2.0), `CHANGELOG.md` and the consumed `.changeset/authoring-inspection-staged-changes.md`. `version-preparation.json` records that code, types, API and lockfile are unchanged. A re-check of the manifest against the working tree on September 28 found exactly these three differing entries. |
| Packed artifact | `sarif-to-comment-0.2.0.tgz`, SHA-256 `13b75f537f36453968b7720e09d6210571aca500116b5bb77bce7e11e994c1f1`. The installed `src/` hashes equal the reviewed source hashes (`acceptance-evidence.json`, `installedPackage`). |
| Registry | **Released and verified.** These live runs used the locally packed artifact; all 246 published files match it exactly. See [release verification](second-milestone-release-verification.md). |
| Final lead check at the reviewed source | lint, types, API freshness (225 pages), release plan and `npm test`: 1806 tests, 138 suites, 0 failed, 0 skipped, exit 0 (`source-handoff.json`) |
| Fixture base (B) | `e59eeae59556f47b6d9311bb6642e129c2bda89c` |
| Reviewed head (H) | `998d7cfc7c858adf3bbcea82ef126a900d51ebc3`, used by both pull requests |
| PR 19, replacements | [mike-north/doc-linter#19](https://github.com/mike-north/doc-linter/pull/19), `codex/m2-20260928-base` ← `codex/m2-20260928-reviewed`, staged index blob `9b3cf3b2680e5e274c8ce85629d7ba62561ae020` |
| PR 20, insertions | [mike-north/doc-linter#20](https://github.com/mike-north/doc-linter/pull/20), `codex/m2-insertions-20260928-base` ← `codex/m2-insertions-20260928-reviewed`, staged index blob `dd78f964770442a58ea4d1b2fe6a71b98547769a` |
| Default branch | baseline `0a7b03fe399255a62118311cbc3e1bd6fe64cb23` recorded before the runs |

## Independent oracles

Both oracles were written by hand without converter output. Each fixes the reviewed, staged and working-tree text of `fixture/review.txt`, and the working tree carries an unstaged sentinel line that must never appear.

- **Replacements:** [source-oracle.json](evidence/second-milestone/source-oracle.json), authored before the second-milestone implementation. It holds finding A (line 2, "Use the corrected second value.") and finding B (lines 5–6, "Combine these two entries without changing the following entries."), each with its exact replacement lines.
- **Insertions:** [insertion-source-oracle.json](evidence/second-milestone/insertion-source-oracle.json), authored after the first independent review reported the insertion defects and before their repair. It predates the repair, not the original implementation.
  - The oracle holds an unchanged-line finding on line 3, which must stay separate, a staged insertion before line 3, and an end-of-file append.
  - It lists every faithful native rendering: the insertion anchored at line 2 or line 3, and the append anchored at line 10.

## Local acceptance through the installed package

`parent-local-final/local-acceptance.json` and `parent-insertion-final.txt` both passed against the 0.2.0 artifact at H. The replacement run covered three paths.
- **Installed library:** create, add A and B, inspect, add staged changes.
- **Installed CLI, JSON mode:** `init`, `add-comment` ×2, `inspect`, `add-staged-changes` and `inspect`. The CLI's inspection view equalled the library's, and human inspection was checked too.
- **Ordinary upstream bypass:** `upstream-input.sarif.json` inspected and enriched through both surfaces, with no initialization.

Across these, the runners asserted:
- exact caller messages and ranges;
- equality between the CLI and library outputs;
- that applying the extracted replacements independently reproduces the staged bytes;
- that the unstaged sentinel is excluded;
- that producer metadata is preserved;
- that the reviewed, index and working-tree bytes are unchanged.

The insertion run additionally asserted independent edited bytes, and that the unchanged-line feedback stays separate from both insertions.

Links between local acceptance and the live runs:
- **PR 19 library modes** (authored-library, upstream-enriched): the live runner rebuilt the SARIF through the installed package and asserted it deep-equal to the SARIF accepted locally before publishing.
- **authored-cli:** published the locally accepted CLI output file itself.
- **upstream-direct:** published the unmodified upstream fixture.

## Live publications

Each publication created one pending review through the installed product. The durable state recorded `phase: "completed"` with `via: "created"`.

An independent read-only verifier (`logs/opus/m2/live-readback.cjs`, which shares no code with `src/`) then asserted the following against GitHub:
- the review is `PENDING`, by the authenticated account (id 558005), at H;
- its body equals the product's saved request body and carries the state marker;
- exactly one review on the pull request carries that marker, and exactly one pending review belongs to the account;
- the expected comment count;
- each comment's exact explanation and immutable original anchor, taken from the GraphQL review thread;
- the exact expected suggestion payload, or its asserted absence.

| Mode | Surface | Review | Comments and original anchors (RIGHT, at H) | Afterwards |
|---|---|---|---|---|
| authored-library | library: author, inspect, extract, publish | 5341773653 | A at line 2, suggestion `corrected two`; B at lines 5–6, suggestion `corrected five and six`; attributed to "Independent acceptance reviewer" | draft deleted |
| upstream-enriched | library: inspect, extract, publish on upstream SARIF | 5341790476 | A and B with the producer's level, rule (`VALUE`, `COMBINE`) and "Independent fixture producer 1.0.0" credit, plus the same two suggestions | draft deleted |
| upstream-direct | library: `publishSarifReview` only, on ready upstream SARIF with no fixes | 5341805378 | A at line 2 and B at lines 5–6 with producer credit; no suggestion, as asserted | draft deleted |
| authored-cli | executable `publish --format json` on the SARIF produced by the installed CLI's authoring and extraction | 5341813827 | the same as authored-library | submitted, applied, retained |
| insertions | library: author, extract, inspect, publish | 5341820039 | the unchanged-line finding at line 3, with no suggestion; a neutral `staged-change` result at line 3 with the insertion suggestion; a neutral result at line 10 with the end-of-file append suggestion | submitted, applied, retained |

The insertion suggestions used the renderings `inserted before third entry` / `reviewed three` (anchor 3) and `reviewed ten` / `appended after tenth entry` (anchor 10), both listed as faithful in the oracle. The neutral results say "Staged insertion before line 3 of …" and "Staged insertion at the end of …" with "No supplied finding was associated with this change". They are attributed to `sarif-to-comment 0.2.0 · rule staged-change`. The line-3 finding was not credited with either insertion.

**Retry with the same state path.** Re-running authored-library returned `published` with the same review id, 5341773653: "was already published; its completion is recorded at `<state file>`. Nothing was sent." Only one review with that marker exists.

**Deleted drafts.** The parent deleted drafts 5341773653, 5341790476 and 5341805378 after their readback, and saved each before-delete and delete response. Each deletion is also confirmed by absence: the next PR 19 review listing held only the next review (5341790476, then 5341805378, then 5341813827).

**Retained reviews.** Reviews 5341813827 (PR 19, submitted `2026-09-28T16:44:28Z`) and 5341820039 (PR 20, submitted `2026-09-28T16:44:34Z`) are retained as `COMMENTED`. Submission was required for GitHub's Apply action.

## Host rendering and application

- **Rendering.** [pr19-pending.png](evidence/second-milestone/pr19-pending.png) shows both PR 19 comments as pending, with native "Suggested change" blocks: line 2 `reviewed two` → `corrected two`, and lines 5–6 → `corrected five and six`.
- **Application.** Both reviews' suggestions were committed with GitHub's native suggestion commit. Each resulting file was read back from its immutable Git blob and matched the independently authored staged text exactly, with the final newline preserved and only `fixture/review.txt` changed. The local indexes and working trees were unchanged ([native-application.json](evidence/second-milestone/native-application.json)).

| PR | Applied commit | Blob | Bytes | SHA-256 |
|---|---|---|---|---|
| 19 | `c7544bd12a160901baa7d5699f0029c608ba34f6` | `9b3cf3b2680e5e274c8ce85629d7ba62561ae020` (equal to the staged index blob) | 136 | `9e7dabaee28cefae4897a7cec5f4afa8a5d51bedfa82f88ffbf01389177e030d` |
| 20 | `c3971627d0a1ae1f4a0b8c88419dae9ce3a7be31` | `dd78f964770442a58ea4d1b2fe6a71b98547769a` (equal to the staged index blob) | 194 | `e9e571950f1ea2a9e5b3fe5ffcbccd78d9f5789a9cfa332f9524f827bd50a9b6` |

[pr19-applied.png](evidence/second-milestone/pr19-applied.png) and [pr20-applied.png](evidence/second-milestone/pr20-applied.png) show the applied diffs. The PR 20 screenshot also shows the unchanged-line comment ("Preserve the original third entry.") retained, displayed at its shifted current position R4.

## Evidence limits and gaps

- **First-run authored-library output.** The live runner writes `<mode>.json` on every invocation, so the retry overwrote the first run's receipt. The retained file holds the retry's "already published … Nothing was sent" outcome. The creation itself is still evidenced: the state receipt says `via: "created"`, exactly one review carries that state's marker, and independent readback passed. The first run's own "Created" text is not retained. The other four receipts are first-run outputs.
- **PR 20 pending rendering.** [pr20-pending.png](evidence/second-milestone/pr20-pending.png) shows only the file tree with three comments. It does not show the rendered insertion suggestions or the neutral message text. Their payloads and anchors are proven by API readback and their effect by blob-level application, but their visual rendering is not captured. In particular, the neutral message is published as plain text. The readback body escapes its backticks (`\``), so GitHub shows literal backticks around the path rather than code formatting; this is inferred from the body, not observed.
- **Readback flag meaning.** For `upstream-direct`, `readback.json` records `exactReplacementPayloads: false`. The verifier sets that flag by mode, not as a failure: for this mode it asserted that no suggestion exists, because the input carries no fixes.
- **Single account and profile.** One account and one small text file with LF endings were exercised on the host. File creation and deletion proposals are blocked by the publisher and were not published. Other encodings, CRLF, BOM and multi-file cases rest on local tests and the independent reviews' randomized byte checks (270 cases, 0 mismatches), not on host evidence.
- **Cleanup verified after acceptance.** [cleanup.json](evidence/second-milestone/cleanup.json) confirms PRs 19 and 20 closed unmerged, zero pending reviews, the retained submitted reviews and the unchanged default branch `0a7b03fe399255a62118311cbc3e1bd6fe64cb23`. Experiment branches remain as evidence. Git delivery and npm release subsequently passed; see [release verification](second-milestone-release-verification.md).
