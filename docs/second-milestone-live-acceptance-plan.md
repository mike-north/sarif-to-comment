# Second-milestone live acceptance plan

Prepared independently by the parent before second-milestone implementation. This is an oracle and planned experiment, not evidence of a running test, a created PR, or a passing product. The parent owns this plan and live coordination; Astra owns implementation contracts and integration.

## Purpose and boundaries

Prove the selected public workflow from authored findings to an actual GitHub draft review, using an installed package. Separately prove that ordinary upstream-produced SARIF can bypass authoring. Reuse isolated synthetic GitHub fixtures under the established experiment authority; never modify user review content or merge fixtures into a real default branch.

Local extraction correctness and GitHub presentation are distinct. The complete live scenario below uses existing reviewed text files and native-suggestion-compatible edits. It does not establish support for file addition, deletion, rename, mode change, binary content or every newline shape. The engineering contract and local acceptance suite must account for those operation classes separately; this live fixture must not silently define a narrower product goal.

## Source oracle authored before implementation

Use `fixture/review.txt` with LF separators and a final newline. Lines are literal content. Commit identities will be obtained from the actual synthetic repository, never represented by invented hashes.

Base source B has ten lines `base one` through `base ten` (number words spelled out). Reviewed source H is:

```text
reviewed one
reviewed two
reviewed three
reviewed four
reviewed five
reviewed six
reviewed seven
reviewed eight
reviewed nine
reviewed ten
```

The Git index target T is:

```text
reviewed one
corrected two
reviewed three
reviewed four
corrected five and six
reviewed seven
reviewed eight
reviewed nine
reviewed ten
```

The working tree W differs from T only by replacing its final line with `UNSTAGED SENTINEL — must not enter any proposed fix`. Stage T first, then make W without updating the index. Verify independently with Git that the index blob contains T and the working-tree file contains W immediately before extraction.

Caller-authored findings, stated against H:

| Finding | File/range | Exact message | Intended proposed edit |
| --- | --- | --- | --- |
| A | `fixture/review.txt`, line 2 | `Use the corrected second value.` | Replace H line 2 with `corrected two`. |
| B | `fixture/review.txt`, lines 5–6 inclusive | `Combine these two entries without changing the following entries.` | Replace H lines 5–6 with one line `corrected five and six`. |

These ranges are independent expected semantics. Extraction must not enlarge a replacement merely to gather explanations. If its legitimate edit decomposition cannot associate these findings faithfully, report that evidence against the contract; do not change the source oracle to make an incorrect result pass.

The expected total edited file is exactly T above. The sentinel is not in T, is not in an emitted fix, and must not reach GitHub through extraction. No test computes the expected final source by running the converter under test.

## Public-path demonstrations

1. **CLI authoring:** use installed `init`, two installed `add-comment` calls, and installed `inspect --format json`; no raw SARIF scaffolding is authored by the test. Independently assert the two messages and declared ranges. Use installed `add-staged-changes`, inspect the enriched artifact and assert full finding preservation, proposed edits, and absence of the unstaged sentinel. Use installed `publish` to create the complete draft. Capture structured command outcomes and actual successful write cardinality.
2. **Library authoring:** create and add the same feedback through installed public functions without a temporary SARIF input file or internal imports. Inspect, incorporate staged changes and publish through public functions. Use an independent publication state and isolated destination/fixture lifecycle so GitHub's one-pending-review-per-author constraint is not confused with product behavior.
3. **Upstream bypass:** supply an independently authored ordinary producer SARIF fixture with its own tool identity and no helper initialization markers. Inspect and enrich it through public entry points, verifying its explanation, origin and source association survive. Demonstrate complete publication. Separately retain direct ready-upstream publication coverage with no authoring or extraction calls.

The independently prepared input is [upstream-input.sarif.json](evidence/second-milestone/upstream-input.sarif.json). It contains A and B with separate rules and levels, plus producer-owned root, run and result properties. It deliberately has no provenance: the extraction invocation must supply the reviewed context, rather than require prior helper initialization. It passed the vendored SARIF schema before implementation began. That proves only fixture validity; preservation and public-path acceptance are still unexecuted. Compare the original fields structurally after enrichment, allowing only documented additions such as fix and source binding metadata.

Human and JSON renderings must represent equivalent information; JSON outputs are inspected as structured values, not asserted merely to contain expected substrings. Publication formatting must preserve blocked/uncertain/rejected behavior and state identity, verified by focused local tests rather than manufacturing remote failures during every live run.

## Host readback and actual edit proof

Read back the created review independently of the product adapter. Verify PENDING state, reviewed commit H, complete body/comment cardinality, exact messages, expected file and original RIGHT anchors for H line 2 and H range 5–6. B→H changes every line, so both intended ranges are independently eligible in this fixture. Preserve the original coordinates if GitHub later shifts current ones after applying a suggestion.

Inspect the actual rendered comments and native suggestion controls. Rendering alone is not evidence of application fidelity. On an explicitly owned synthetic review, submit only that experiment review if required for the host's Apply action, apply the product-generated suggestions through GitHub, then retrieve the final immutable blob and compare its bytes to T. Applying both corrections must preserve the following entries and the final newline. Record exact commits, source hashes, actual host coordinates and cleaned artifact identities.

Before any cleanup, verify ownership, marker and review/PR identity. Remove only owned pending drafts, close synthetic PRs unmerged, and confirm the real default branch is unchanged. Submitted experiment reviews may remain as bounded evidence.

## Evidence and interpretation

Record baseline package/source identity, independently authored B/H/T/W data, installed commands/library calls, actual index and reviewed commits, product output, independent GitHub readback, representative rendering, applied-byte comparison, and exact cleanup result. The final report must distinguish observed success from planned steps and local mocks. If a run used a modified source snapshot, pin it and rerun affected checks before claiming acceptance.

## Local fixture preparation checkpoint

The parent prepared the isolated repository at `logs/opus/m2/acceptance-fixture` before product implementation was available. The receipt is `logs/opus/m2/acceptance-fixture.json`. Base commit `e59eeae59556f47b6d9311bb6642e129c2bda89c` and reviewed commit `998d7cfc7c858adf3bbcea82ef126a900d51ebc3` contain the literal B and H source above. The index blob is `9b3cf3b2680e5e274c8ce85629d7ba62561ae020`; Git readback exactly matches T, while the filesystem readback exactly matches W. These identities identify local synthetic data, not published GitHub objects. No converter, installed-package or GitHub acceptance has run at this checkpoint.

Read-only GitHub preflight found `mike-north/doc-linter` default branch `main` at `0a7b03fe399255a62118311cbc3e1bd6fe64cb23`. Open PRs 1, 2, 17 and 18 are unrelated to this experiment and must remain untouched. The eventual synthetic PR will compare two experiment-owned branches. Recheck the default branch before writes and after cleanup; no remote fixture exists yet.

### GitHub fixture created

After rechecking `main` and proving the exact branch names were unused, the parent atomically pushed B and H to `codex/m2-20260928-base` and `codex/m2-20260928-reviewed`, then created [synthetic PR 19](https://github.com/mike-north/doc-linter/pull/19). Independent PR readback confirmed author `mike-north`, the exact B/H commits, and one modified path, `fixture/review.txt`. The PR is attached to this task. [live-fixture.json](evidence/second-milestone/live-fixture.json) records its identity. No product review has been created, no suggestion applied and no acceptance result claimed. Parent owns all subsequent review actions and cleanup; the fixture must be closed unmerged.

### Preliminary installed local acceptance

The parent independently packed and installed a development snapshot and ran `logs/opus/m2/installed-local-acceptance.cjs` against the reserved fixture. [local-acceptance-preliminary.json](evidence/second-milestone/local-acceptance-preliminary.json) records the tarball hash, actual installed source hashes, checks and limits. The authored CLI/library results matched; both upstream bypass paths worked without initialization; exact messages, ranges and producer markers survived; independently applying raw SARIF replacements reproduced T exactly; and the source, index, working tree and input SARIF remained unchanged. Human inspection retained both full messages.

This is preliminary local evidence only. The development package still carries version 0.1.1; this was not a registry release. It does not prove declarations, full inspection fidelity, GitHub publication or applied host bytes. Astra has an inspection fidelity repair in progress, and the final integrated source must be repacked and rerun. The first runner attempt stopped on its own guard because Node package self-resolution selected the checkout; anchoring `createRequire` to the consumer fixed the harness before any product result was claimed. That failed attempt remains in `parent-local-acceptance-01.txt`; attempts 02 and 03 passed, with 03 adding input/source non-mutation checks.

### Insertion acceptance added after independent review

The independent reviewer reproduced a composition failure: extraction carries a pure insertion on a result with a path-only location, which causes the unchanged publisher to block the whole artifact. The original author is correcting that defect. Before the correction, the parent prepared [a separate insertion oracle](evidence/second-milestone/insertion-source-oracle.json) and a reserved local fixture at `logs/opus/m2/acceptance-insertion-fixture`.

This uses the same immutable reviewed source H, with an insertion before line 3 and an append after line 10. An unrelated finding on unchanged line 3 must remain separate; its explanation cannot be borrowed for either insertion. The oracle permits either faithful adjacent native anchor for the middle insertion, while requiring the exact independently written final bytes. The index contains those intended bytes, and the working tree instead has an unstaged insertion sentinel. Git readback verified this divergence without invoking the converter.

The original PR 19 fixture and source oracle are unchanged. A separate owned synthetic PR will receive insertion acceptance after the final installed source is ready. Planned checks include public authoring/extraction, independent raw-fix application, remote original anchors and comment separation, actual native application and exact resulting bytes, followed by ownership-checked cleanup. No insertion product acceptance or new remote fixture is claimed at this checkpoint.

The insertion fixture is now [owned PR 20](https://github.com/mike-north/doc-linter/pull/20), created after verifying both experiment branch names were unused and `main` remained at its recorded baseline. Independent readback confirms author `mike-north`, the exact B/H commits and one modified file, `fixture/review.txt`. Its identity is recorded in [insertion-live-fixture.json](evidence/second-milestone/insertion-live-fixture.json). It is attached to this task and must be closed unmerged after acceptance. No product review has been published on this fixture yet.
