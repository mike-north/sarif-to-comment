# Second milestone engineering plan and work record

> **Historical work record (reconciled September 28, 2026).** The milestone was released as 0.2.0. For current status, see [Current status and reconciliation](status.md).

September 28, 2026. Governing assignment: [second-milestone-goal.md](second-milestone-goal.md). Baseline: npm 0.1.1, repository commit `bedc5b8b8efb47dcf07ea8f629ee8537fc2f37ce`. This record was condensed on September 28, 2026 to durable facts: plan, design boundaries, defects and their resolutions, and verification. The chronological narrative of how work was assigned and supervised is preserved in Git history.

## Outcome and sequence

The goal was to deliver the optional authoring path `init → add-comment → inspect → add-staged-changes → publish` through installed CLI and library surfaces. Ordinary upstream SARIF is equally supported for inspection, staged incorporation and direct publication. There is no required authoring session or private interchange object.

1. Close the engineering contracts before any dependent implementation:
   - argument and result shapes;
   - run and revision binding;
   - exact feedback/fix association;
   - the extraction operation envelope;
   - index snapshot consistency;
   - complete inspection;
   - CLI output preservation and structured outcomes.

   Record consequential defaults and genuinely unresolved policy separately.
2. Implement in three cohesive, separately owned areas: local authoring with shared inspection, staged Git extraction, and the CLI and public package surface. Each shared file has one owner.
3. Require behavioral tests before each implementation, meaningful failure evidence, and independently authored source and edit expectations.
4. Integrate the installed-package paths, keeping first-milestone publication, recovery and release infrastructure intact. Get an independent review of identified source hashes, reproduce its findings, and return repairs to the original author.
5. Demonstrate authored and upstream inputs through the public surfaces, with the index and working tree deliberately different and exact source and edit oracles. Real GitHub writes, rendered inspection and application, and cleanup of owned artifacts must be coordinated. Local or simulated checks alone do not finish the milestone.
6. Reconcile requirements against evidence: declarations and generated API documentation, runnable examples, the Changeset, package installation and full checks.

## Design boundaries

- Source coordinates refer to an explicit reviewed source or to explicitly proposed content. They are never inferred from mutable working-tree text.
- A replacement's actual changed region governs association. Each finding and its origin are preserved. Nearby feedback is not moved, and an edit is not enlarged to gather feedback.
- Whether a file addition or deletion is valid does not depend on GitHub native-suggestion eligibility (D6). A deletion is not disguised as an empty file.
- Existing ordinary fixes and meaningful upstream metadata survive transformation. A change that cannot be represented, or that conflicts, fails honestly instead of producing a filtered success.
- Inspection keeps every finding, location and included fix, even beyond the publisher's profile. Only visibly marked fix previews may be truncated.
- CLI receipts describe the actual files and remote outcomes. A failure must not leave a stale success at the normal output path (D10).

Removal and correction, standalone validation, suggestion PRs and review maintenance were deferred. Under the happy-path-first priority, strict extraction was accepted as the initial mode, and best-effort repair was not a prerequisite. The milestone did not have to extend the publisher to new operation classes. Extraction and inspection carry additions and deletions faithfully. At this point the publisher explicitly blocked them, which was later changed; see [status](status.md). Existing-file edits established the live happy path.

The contract analysis is in [second-milestone-contract-notes.md](second-milestone-contract-notes.md), and the resulting contract is [second-milestone-contract-proposal.md](second-milestone-contract-proposal.md). The live oracle is [the live acceptance plan](second-milestone-live-acceptance-plan.md). Q1 in the contract adopted a neutral result, truthfully attributed to the tool, for staged changes that no finding explains. It invents no rationale and adds no approval hold.

## Baseline

Before implementation, the unchanged baseline passed:

- lint;
- types;
- generated API freshness;
- release checks;
- 1,415 tests across 104 suites, with no failures or skips.

One failure appeared only in the sandbox: loopback listeners were denied. That was an environment restriction, not a product defect.

## Tests-first evidence

- **Authoring and inspection.** 155 tests all failed against explicit not-implemented stubs, reaching the behavioral entry points. Later, 155 focused tests passed, and the result was independently reproduced.
- **Extraction.** 55 behavioral tests failed against the not-implemented entry point. They used a separate fixture-application oracle and pre-authored source expectations, not production replacement generation.
- **Public surface.** 80 tests, with 1 passing and 79 failing. The artifact-file suite at first failed only because its module was absent, which does not prove its assertions discriminate. Eight file-effect mutants caught later closed that gap.

## Defects found and resolved

| Defect | How it was found | Resolution |
|---|---|---|
| Inspection dropped the alternate `markdown` of location messages and fix descriptions. Human output omitted logical-location details and nested evidence. | Reproduced with schema-valid upstream SARIF | Repaired tests first, with eight initial failures. 167 focused tests passed, and 13 repair mutants were caught. Inspection hash `7ef918afa1860c5d91f95ba4c1aa2ad4fe6ed89527cd44fcfca2bfafc0f6f415`. |
| A Git replacement ref could swap the reviewed blob, so extraction reported `added` with no fixes. | Reproduced in a disposable fixture | Immutable object identity is now read and verified. 82 focused tests passed and all 33 mutants were killed. `src/staged-git.cjs` hash `a54ce8608c0d17bc70ee9b8f5e8672ab421867b5bda06ed50d0a55aeedf002bd`. |
| A valid upstream fix that grouped two independent, identical staged edits was rejected as a conflict. | Reproduced. The first reproduction probe was itself wrong: a line-only region keeps its newline, so the probe's artifact was legitimately conflicting. It was replaced with a corrected valid control, and the original is retained. | Effect equality was repaired. 12 new tests failed first, then all 94 extraction tests passed. |
| A pure-insertion carrier blocked the unchanged publisher (C1). A single supplied replacement spanned several Git hunks (C2). A BOM-only source crashed (C3). Log-level, embedded and inserted-content evidence disappeared (C4). The insertion receipt labelled unchanged context as changed (C5). | Independent snapshot review 01; C1, C3, C4 and C5 were reproduced, and C2 was already passing | All repaired. Insertion receipts now use `insertion: true` and an empty source range (`endLine = startLine - 1`). A symlink observation was withdrawn after an actual CLI check showed the link preserved and its target edited. |
| Inspection wording said inline external properties have no run association. | Final delta check | Corrected: a declared `runGuid` stays verbatim, and inspection does not merge that content into run findings. A regression failed before the fix, and all 59 inspection tests passed after it. |

Independent review 02 reconciled C1–C5 and the grouped-fix repair as fixed. It checked 723 focused tests, 270 independent random byte-application cases and discriminating repair reversions. Review 03 was a syntax-tree comparison of the final delta. It confirmed changes to comments only plus one corrected warning string, and found no material defect. Empty and BOM-only sources extract faithfully but remain outside native inline publication.

## Final verification

- **Final check on the frozen source:**
  - lint, types and API freshness (225 pages);
  - the minor release plan;
  - 1,806 tests in 138 suites, with no failures or skips.
- **Manifest:** all 325 entries in the reviewed manifest matched the workspace. Manifest SHA-256: `823bef633b25c49908aebb6b774aba6462bef9759a2131e0c41dc7223dfc60d7`.
- **Durable evidence:** `docs/evidence/second-milestone/` holds `independent-review-02.md`, `independent-review-03.md`, `reviewed-source.sha256` and `source-handoff.json`.
- **Version and artifact:** the Changesets version command prepared 0.2.0, changing only the version, the CHANGELOG and the consumed Changeset. The packed artifact SHA-256 is `13b75f537f36453968b7720e09d6210571aca500116b5bb77bce7e11e994c1f1`. All 246 shipped files matched the checkout.
- **Live acceptance.** Five product publications passed independent GitHub readback: authored library, enriched upstream, direct ready upstream, authored CLI, and a separate insertion case. Retrying the authored-library publication returned the same review identity. GitHub's native batch Apply controls applied both replacements on PR 19 and both insertions on PR 20. The resulting immutable blobs exactly equal the pre-authored target bytes. See [second-milestone-e2e-evidence.md](second-milestone-e2e-evidence.md) and `docs/evidence/second-milestone/native-application.json`.
- **Cleanup.** PRs 19 and 20 are closed unmerged, with no pending reviews. doc-linter `main` remains at `0a7b03fe399255a62118311cbc3e1bd6fe64cb23` (`docs/evidence/second-milestone/cleanup.json`).
- **Known gaps:**
  - a retry overwrote the first authored-library textual receipt, although creation is proven by durable state and host identity;
  - the PR 20 pending screenshot did not capture expanded suggestions, although exact payloads, anchors and resulting bytes are retained.

## Lessons recorded

A retrospective by the implementation author is retained in `docs/evidence/second-milestone/collaboration-feedback.md`. It recorded two lessons:

- Verify expected replacement bytes independently before calling a probe a confirmed defect, and keep and explain a corrected oracle.
- Run new extraction output shapes through the existing publisher. Pure insertion passed subsystem checks but failed composition.

## Delivery and release

- **Push approval.** An automated approval check refused the first push of release commit `da3c138`, because it would trigger npm publication and the authorization in its context was not current. No alternate route was attempted.
- **Standing authority.** The user then explicitly authorized end-to-end work on `mike-north/sarif-to-comment`. That covers default-branch pushes and npm patch or minor publication below 1.0.0 through the existing Changesets and trusted-publishing workflow, including pushes that trigger publication. Releases at 1.0.0 or above, visibility changes, weakened safeguards and out-of-scope destructive actions still require approval.
- **Release.** Commit `da3c138897d45deaf90817bf10afbb426717cda5` was pushed.
  - CI run `36458246012` passed on Node 22 and 24.
  - Publish run `36458245873` passed all 1,806 tests and published 0.2.0.
  - An initial npm 404 resolved without retrying the publication.
- **Registry verification.** All 246 registry-installed files match the accepted artifact, and the registry consumer acceptance passed. Eight signatures and one provenance attestation verified. See [second-milestone-release-verification.md](second-milestone-release-verification.md).
