# Current status and reconciliation

Reconciled September 28, 2026, against `main` at merge commit `146c599`. This page is the entry point for what is shipped, what is merged but unreleased, what is still open, and which documents are historical. It changes no decision. Where it summarizes a decision, the [decision log](design-decisions.md) governs. Where it summarizes shipped behavior, the [README](../README.md) and the tests govern.

## Releases and unreleased changes

**Latest npm release: `sarif-to-comment@0.2.1`.** This is the strict TypeScript implementation of the 0.2.0 behavior ([D33](design-decisions.md#d33-maintain-the-implementation-in-strict-typescript-and-distribute-generated-commonjs--settled-engineering-decision)). It was verified from a clean registry installation, with signatures and provenance checked. See [TypeScript migration release verification](typescript-migration-release-verification.md).

| Version | What it added | Release evidence |
|---|---|---|
| 0.1.0, 0.1.1 | Ready SARIF to one GitHub draft review, with durable, never-duplicating delivery | [npm release verification](npm-release-verification.md), [first-milestone live evidence](milestone-e2e-evidence.md), [suggestion application](suggestion-application-e2e.md) |
| 0.2.0 | Optional authoring (`init`, `add-comment`), `inspect` and strict staged-change extraction (`add-staged-changes`) | [second-milestone release verification](second-milestone-release-verification.md), [live evidence](second-milestone-e2e-evidence.md) |
| 0.2.1 | Same behavior, reimplemented in strict TypeScript with generated declarations | [migration acceptance](typescript-migration-verification.md), [release verification](typescript-migration-release-verification.md) |

**Merged to `main` and not yet released.** Each item below has a pending Changeset in `.changeset/`, so none of it is in any npm version yet.

| Change | Issue and pull request | Contract | Evidence |
|---|---|---|---|
| Finding removal and correction: `remove-comment` / `removeSarifComment`, and inspection selectors | [#1](https://github.com/mike-north/sarif-to-comment/issues/1), [PR #14](https://github.com/mike-north/sarif-to-comment/pull/14) | [finding removal contract](finding-removal-contract.md) (provisional) | `test/sarif-removal.test.mts`, `test/cli-commands.test.mts`, the installed correction example in `test/docs.test.mts` |
| Standalone readiness assessment: `validate` / `validateSarifReview` | [#2](https://github.com/mike-north/sarif-to-comment/issues/2), [PR #15](https://github.com/mike-north/sarif-to-comment/pull/15) | [readiness assessment contract](readiness-assessment-contract.md) (provisional) | `test/validate-sarif-review.test.mts`, `test/validate-composition.test.mts`, the installed readiness example in `test/docs.test.mts` |
| Publication of whole-file creation and deletion proposals in the review body | [#4](https://github.com/mike-north/sarif-to-comment/issues/4), [PR #16](https://github.com/mike-north/sarif-to-comment/pull/16) | [file-operation publication contract](file-operation-publication-contract.md) (provisional) | `test/file-operations*.test.mts`, `test/installed-file-operations.test.mts`, [live GitHub evidence](file-operation-publication-e2e-evidence.md) |
| Narrower TypeScript test suppressions (test-only; no Changeset) | [#11](https://github.com/mike-north/sarif-to-comment/issues/11), [PR #13](https://github.com/mike-north/sarif-to-comment/pull/13) | — | the test tree |

## Provisional contracts awaiting owner acceptance

Each of these features is implemented under the most conservative option its contract proposes. The owner has not yet accepted the proposals. If the owner accepts a different option, the implementation changes to match, and the proposal gives way to the owner's decision.

- [Finding removal contract](finding-removal-contract.md): the selector design in its §2 ([#1](https://github.com/mike-north/sarif-to-comment/issues/1)).
- [Readiness assessment contract](readiness-assessment-contract.md#decisions-awaiting-acceptance): the input, outcomes and exit statuses ([#2](https://github.com/mike-north/sarif-to-comment/issues/2)).
- [File-operation publication contract](file-operation-publication-contract.md#decisions-awaiting-acceptance): its three listed decisions ([#4](https://github.com/mike-north/sarif-to-comment/issues/4)).

## Bounded support profile

The shipped behavior is verified only within a documented profile. The full list is in the README's [Supported SARIF](../README.md#supported-sarif-first-milestone-profile) and [Limitations](../README.md#limitations) sections. In summary:

- **Verified:** the recorded live GitHub fixture runs, the local and installed-package suites, and native application of the suggestion shapes named in the evidence reports.
- **Host:** only `https://api.github.com`, with personal or user tokens. GitHub Enterprise Server, GitHub App installation tokens and other hosts are unsupported.
- **SARIF:** a bounded profile. Multiple or related locations, code flows, graphs, stacks, attachments, suppressions, and alternative or multi-file fixes are refused, never approximated.
- **Not verified, and not claimed:**
  - arbitrary SARIF;
  - other providers or hosts;
  - suggestion shapes beyond those exercised;
  - durability across power loss (the write, flush, send ordering is designed for crash safety but untested against power loss);
  - every GitHub failure mode.

## Reconciliation of the first specification's open contracts (O1–O11)

The [first specification §11](specification.md#11-open-contracts-and-implementation-gates) listed O1–O11 before any implementation existed. The table maps each one to shipped evidence, a remaining issue, an explicit decision or a documented non-goal. Most entries are split: the shipped part is listed first and the remainder after it.

| ID | Gap as recorded | Current disposition |
|---|---|---|
| O1 | Approval metadata property names and values | **Shipped (0.1.0).** `properties.sarifToComment.approval: "awaiting-approval"` on a run or result blocks the whole review. Any other value in the owned namespace is invalid. `ignoreApprovalHold` overrides only the hold. Evidence: [README: approval hold](../README.md#approval-hold) and the `approval convention` tests in `test/prepare-review.test.mts`. Governed by [D11](design-decisions.md#d11-approval-is-an-upstream-convention-honored-by-publication--settled) and [D12](design-decisions.md#d12-any-unresolved-approval-hold-blocks-the-entire-review--settled). |
| O2 | Whole-file creation and deletion encoding | **Extraction encoding shipped (0.2.0):** the result-level `proposedFileChanges` extension ([contract §4.7](second-milestone-contract-proposal.md#47-whole-file-operations), [D23](design-decisions.md#d23-keep-file-descriptions-separate-from-proposed-operations--settled-conceptual-model)). **Publication and deletion semantics:** merged, unreleased, under the provisional [file-operation publication contract](file-operation-publication-contract.md) ([#4](https://github.com/mike-north/sarif-to-comment/issues/4)). **Remaining:** editor/prefill links ([#8](https://github.com/mike-north/sarif-to-comment/issues/8)) and companion suggestion PRs ([#5](https://github.com/mike-north/sarif-to-comment/issues/5)). |
| O3 | Extraction and association details | **Shipped (0.2.0), strict mode.** The engineering contract settles the snapshot, operation envelope, replacements, association, neutral results and run binding ([contract §2 and §4](second-milestone-contract-proposal.md#41-snapshot)). Evidence: [second-milestone live evidence](second-milestone-e2e-evidence.md). **Remaining:** best-effort extraction ([#3](https://github.com/mike-north/sarif-to-comment/issues/3)). Binary, mode, symlink and rename extraction are documented support boundaries; expanding them is triaged in [#12](https://github.com/mike-north/sarif-to-comment/issues/12). |
| O4 | Host capability matrix and initial host support | **Shipped for GitHub.** Changed, unchanged, distant, historical and nonexistent sources are covered by `test/placement.test.mts`, `test/prepare-review.test.mts` and the [first-milestone live evidence](milestone-e2e-evidence.md). See the README on [reviewed commits](../README.md#reviewed-commit-and-historical-reviews) and [old-side source](../README.md#old-side-source). The initial host commitment is `api.github.com` only. **Remaining:** GitLab and other hosts are unscheduled optional expansion, triaged in [#12](https://github.com/mike-north/sarif-to-comment/issues/12) ([D3](design-decisions.md) keeps the host set open). |
| O5 | Prefill and comment-size envelope | **Comment size shipped:** conservative product limits with whole-review refusal and no truncation ([README](../README.md#supported-sarif-first-milestone-profile)). **Remaining:** the prefill link envelope, fork and branch behavior, and content-bearing URL policy ([#8](https://github.com/mike-north/sarif-to-comment/issues/8); [D17](design-decisions.md#d17-offer-a-new-file-prefill-link-only-within-its-supported-limits--settled-direction-bound-unmeasured)). |
| O6 | Publication lifecycle details | **Shipped (0.1.0):** draft by default ([D26](design-decisions.md#d26-pending-publication-means-a-draft-code-review--settled)), whole-review validation before writes, persisted identity before sending ([D14](design-decisions.md#d14-persist-publication-identity-before-sending--accepted-approach-verification-incomplete)), pending-marker rediscovery, restart and concurrency safety, and uncertain delayed visibility. Evidence: [README: state path](../README.md#the-state-path-retries-recovery-and-concurrency) and [live recovery evidence](milestone-e2e-evidence.md). **Remaining:** an explicitly submitted review and its event contract ([#7](https://github.com/mike-north/sarif-to-comment/issues/7); [D16](design-decisions.md#d16-pending-versus-submitted-publication-is-caller-configurable--settled)), and multi-object recovery for companion PRs ([#5](https://github.com/mike-north/sarif-to-comment/issues/5)). Power-loss durability is unverified (see above). |
| O7 | File lifecycle details | **Shipped (0.2.0) for strict extraction output:** an existing output is archived under a non-clobbering UTC-stamped name, and a failed attempt leaves no stale success at the normal path ([contract §6.4](second-milestone-contract-proposal.md#64-preservation-for-add-staged-changes), `src/artifact-files.cts`, [D10](design-decisions.md#d10-output-names-distinguish-success-failure-and-history--settled)). **Remaining:** error/report artifacts and their rotation ([#3](https://github.com/mike-north/sarif-to-comment/issues/3)). |
| O8 | Approval state during SARIF generation | **Closed in the specification itself.** No early approval gate: [R5](specification.md#r5-apply-strict-and-best-effort-modes-to-sarif-generation-and-combination) preserves the marker and [R11](specification.md#r11-honor-declared-approval-state-without-reconstructing-its-history) honors it at publication ([D9](design-decisions.md#d9-strict-and-best-effort-modes-govern-preparation-not-partial-publication--settled), [D11](design-decisions.md#d11-approval-is-an-upstream-convention-honored-by-publication--settled)). Shipped publication behavior matches (O1). |
| O9 | Evidence for unrepresentable input | **Remaining:** [#3](https://github.com/mike-north/sarif-to-comment/issues/3). Strict extraction fails with actionable diagnostics and does not yet keep a separate best-effort artifact. |
| O10 | Security profile details (S1–S7) | **Partly shipped.** Literal content and fence containment (S1), the index-snapshot source (S2), path and URI checks (S3), explicit resource limits without silent loss (S5) and approval not claimed as identity (S7) are implemented within the profile. Adversarial content (fences, HTML, template braces, `javascript:` links) is exercised in `test/file-operations.test.mts` and the [file-operation live evidence](file-operation-publication-e2e-evidence.md). **Remaining:** the action-link rules S4 and S6 ([#8](https://github.com/mike-north/sarif-to-comment/issues/8)). The table in [§9](specification.md#9-proposed-security-requirements) is still labeled "proposed"; see the open questions. |
| O11 | Suggestion PR representation and lifecycle | **Decisions:** [D21](design-decisions.md#d21-identify-suggestion-prs-through-backlinks-and-a-label--settled-direction), [D22](design-decisions.md#d22-gate-suggestion-prs-with-one-caller-setting--settled-direction) (enabled by default is still provisional), [D24](design-decisions.md#d24-establish-the-relationship-from-the-suggestion-pr--settled), [D27](design-decisions.md#d27-sweep-open-suggestion-prs-for-on-demand-cleanup--settled) and [D28](design-decisions.md#d28-rediscover-a-created-suggestion-even-when-its-response-was-lost--accepted-approach). **Remaining:** publication ([#5](https://github.com/mike-north/sarif-to-comment/issues/5)) and on-demand cleanup ([#6](https://github.com/mike-north/sarif-to-comment/issues/6)). Fork-based suggestions are deferred by [D25](design-decisions.md#d25-record-fork-based-suggestions-without-expanding-near-term-scope--settled-priority) and triaged in [#12](https://github.com/mike-north/sarif-to-comment/issues/12). |

## One-way reviews versus suggestion cleanup

Two boundaries apply here, and neither implies the other:

- **One-way review publication ([D29](design-decisions.md#d29-publish-the-initial-review-in-one-direction--accepted-scope-constraint)): an accepted exclusion.**
  - The tool creates an initial review and then never updates, reconciles, restores, submits or deletes it.
  - Reading GitHub to confirm the initial delivery is recovery, not synchronization.
  - Review maintenance, re-review and syncing GitHub state back to SARIF are non-goals.
  - Removing a finding from a local SARIF file is local authoring and does not touch GitHub ([D30](design-decisions.md#d30-agent-friendly-sarif-authoring-and-proofreading--user-selected-second-milestone)).
- **Suggestion-PR cleanup ([D27](design-decisions.md#d27-sweep-open-suggestion-prs-for-on-demand-cleanup--settled), [#6](https://github.com/mike-north/sarif-to-comment/issues/6)): separately accepted lifecycle behavior.**
  - An on-demand action closes the tool's own open companion suggestion PRs after their original PR has merged or closed.
  - It acts on suggestion PRs, not on reviews, so D29 does not exclude it. D29 itself says this cleanup "remains a separate, bounded action."
  - It is unimplemented and depends on companion suggestion PRs ([#5](https://github.com/mike-north/sarif-to-comment/issues/5)).

## Remaining work

Open issues, in no priority order:

- [#3](https://github.com/mike-north/sarif-to-comment/issues/3): best-effort extraction artifacts (O7, O9).
- [#5](https://github.com/mike-north/sarif-to-comment/issues/5): companion suggestion PRs (O2, O6, O11).
- [#6](https://github.com/mike-north/sarif-to-comment/issues/6): suggestion-PR cleanup (O11, D27).
- [#7](https://github.com/mike-north/sarif-to-comment/issues/7): explicitly submitted reviews (O6, D16).
- [#8](https://github.com/mike-north/sarif-to-comment/issues/8): new-file action links (O5, O10).
- [#9](https://github.com/mike-north/sarif-to-comment/issues/9): alternative remedies and broader fix structures.
- [#12](https://github.com/mike-north/sarif-to-comment/issues/12): decisions on optional expansion, such as other hosts, forks, helper consolidation and private test seams.

## Explicit non-goals

These come from [specification §2](specification.md#2-scope-and-non-goals) and the decision log. They are exclusions, not missing work:

- judging whether feedback is correct, or choosing the best semantic fix;
- inferring dependencies among findings;
- tracking editing history;
- review maintenance, reconciliation or synchronization ([D29](design-decisions.md#d29-publish-the-initial-review-in-one-direction--accepted-scope-constraint));
- a proofreading or human-approval interface;
- committing proposed changes to the author's branch automatically.

## Historical documents

The documents below record how the project was planned, built and verified. Their status statements describe the time they were written. Each one opens with a note pointing here. That note is the only change to their decisions and evidence, except that internal process labels were removed from the work records (see [Editorial note](#editorial-note)).

| Document | Historical statement it contains | Current fact |
|---|---|---|
| [specification.md](specification.md) | "No product implementation exists"; §11 open contracts | Its requirements still govern the broader product. Implementation has shipped (see above), and O1–O11 are reconciled above. |
| [product-brief.md](product-brief.md), [design-decisions.md](design-decisions.md), [domain-model-scrutiny.md](domain-model-scrutiny.md), [new-file-representation-research.md](new-file-representation-research.md) | "not implemented behavior", "No behavior described here has been implemented" | The decision log remains authoritative for decisions. Implementation status is described here. |
| [first-milestone.md](first-milestone.md), [milestone-contract-draft.md](milestone-contract-draft.md), [milestone-engineering-plan.md](milestone-engineering-plan.md), [milestone-release-audit.md](milestone-release-audit.md), [work-record.md](work-record.md) | "npm publication is deferred", "No product code has been written" | Released as 0.1.0 and then 0.1.1; see [npm release verification](npm-release-verification.md). |
| [second-milestone.md](second-milestone.md), [second-milestone-goal.md](second-milestone-goal.md), [second-milestone-interface-design.md](second-milestone-interface-design.md), [second-milestone-contract-notes.md](second-milestone-contract-notes.md), [second-milestone-contract-proposal.md](second-milestone-contract-proposal.md), [second-milestone-live-acceptance-plan.md](second-milestone-live-acceptance-plan.md), [second-milestone-work-record.md](second-milestone-work-record.md), [second-milestone-release-audit.md](second-milestone-release-audit.md) | "implementation has not begun"; removal, validation and file-operation publication "deferred" | Released as 0.2.0. Removal, validation and file-operation publication have since been merged, unreleased (see above). |
| [typescript-migration-plan.md](typescript-migration-plan.md), [typescript-migration-work-record.md](typescript-migration-work-record.md) | "execution in progress" | Released as 0.2.1. |
| [npm-release-verification.md](npm-release-verification.md) | "The current verified release is 0.2.0" | The latest release is 0.2.1. |

Dated experiment and evidence reports record their own observations and remain accurate as records. They include the [placement probe](placement-host-probe.md), [native suggestion fidelity](native-suggestion-fidelity-experiment.md), the [grouped suggestion](grouped-suggestion-experiment.md), [companion PR lifecycle](companion-pr-lifecycle-experiment.md) and [publication recovery](publication-recovery-experiment.md) experiments, and the live evidence reports linked above.

## Open questions for the owner

These were found during reconciliation. They are recorded here rather than decided:

1. **Accepting the three provisional contracts.** They are listed above. Until they are accepted, the next release would ship them under their conservative options.
2. **Security requirements S1–S7.** Specification §9 still labels them "proposed" even though S1–S3, S5 and S7 are implemented within the profile. Should they be formally accepted? S4 and S6 remain with [#8](https://github.com/mike-north/sarif-to-comment/issues/8).
3. **Default for companion suggestion PRs.** [D22](design-decisions.md#d22-gate-suggestion-prs-with-one-caller-setting--settled-direction) enables them by default, but the specification calls that low-conviction. It should be settled before or during [#5](https://github.com/mike-north/sarif-to-comment/issues/5).
4. **Evidence manifests.** Hash manifests under `docs/evidence/` identify files as they were at the recorded commits. Documentation edited since then, including this reconciliation, no longer matches those old hashes. Git history holds the exact reviewed bytes.

## Editorial note

On September 28, 2026 the work records and plans were condensed to their durable engineering facts: decisions, evidence, defects found and how they were resolved. Internal process labels were removed: assistant and model names, session and process identifiers, local absolute paths, and internal phase codes. Evidence values that were local paths now read `<working-logs>/…`, which stands for the maintainer's uncommitted working-log directory. The original wording is preserved in Git history. No decision, measurement or verification result was changed.
