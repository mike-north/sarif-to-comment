# SARIF to review comments: product brief

> **Historical design record (reconciled September 28, 2026; updated September 29, 2026).** "Not implemented" statements are historical; the product has shipped within a bounded profile. Its description of suggestion PRs as provisionally enabled by default is superseded: they are explicit opt-in and off by default ([D22](design-decisions.md#d22-gate-suggestion-prs-with-one-caller-setting--settled-direction), owner decision of September 29, 2026). For current status, see [Current status and reconciliation](status.md).

Status: draft synthesis of the design conversation, September 27, 2026. This describes intended outcomes, not implemented behavior. The [decision log](design-decisions.md) contains rationale, scope boundaries, and unresolved details. The [behavioral specification](specification.md) defines requirements and acceptance scenarios.

## Product goal

Let a reviewer turn feedback from people, agents, and local analysis tools into a coherent code review, preserving explanations, source context, proposed changes, and attribution while removing the mechanical work of constructing host comments and suggestions.

The primary worked destination is GitHub. GitLab is relevant, but the initial host support commitment remains open.

## Main workflow

Several reviewers or tools produce SARIF feedback about a particular source revision. Where proposed changes are useful, reviewers edit and stage a shared, reconciled repository state.

Upstream line-level and other non-fix feedback is already SARIF when handed to this tool. The optional SARIF generation and combination operation combines those reports and turns staged changes into SARIF fixes or the explicit whole-file proposal representation once settled. It does not interpret arbitrary prose review notes into findings. Already complete SARIF and SARIF feedback without proposed changes can enter publication directly.

SARIF generation and combination reports mechanical problems and preserves repair evidence. A person or agent fixes the ordinary inputs and reruns that operation. Proofreading decides whether the resulting feedback is worth sending; the converter does not make that judgment.

Publication validates the complete artifact, honors any explicit approval holds, and creates a pending or submitted review according to caller configuration. It does not select a supposedly independent subset of feedback.

Publication is one-way: SARIF in, initial GitHub review out. The tool does not maintain the draft after creation, reconcile human edits, import GitHub content back into SARIF, or manage re-review. New SARIF may produce a separate new review. Retry recovery verifies and completes only the original delivery; it does not restore or synchronize changed review content. **[D29]**

The caller chooses whether to allow **suggestion PRs** targeting the original PR's branch. Small edits prefer native suggestions either way. When enabled, suggestion PRs are preferred for whole-file creation and deletion and are required for applying an explicitly supplied group of distinct edits as one unit. When disabled, individual file proposals can still use ordinary review content and supported creation/deletion links; grouped application is unsupported. The tool does not split a required group into independent actions. The exact deletion-link experience remains unverified.

Reviews default to drafts. Suggestion PRs are provisionally enabled by default, with low conviction: real user feedback must assess PR clutter and the effects of organization-specific automation triggered by new PRs. Callers can disable them.

Suggestion PRs carry a suggestion label and an ordinary reference to the original PR in their own body. Establishing that relationship does not require permission to edit the original PR's description. Targeted cleanup can follow structured backlinks and filter by label; a broader sweep prefers open labeled suggestions and checks their referenced originals. Both avoid title parsing or a separate relationship database. Original-description closing keywords are not required by this workflow. The [live lifecycle experiment](companion-pr-lifecycle-experiment.md) verified automatic PR closure on the tested closing-reference merge path and the need for explicit cleanup after abandonment. Automatic branch deletion with the setting enabled remains untested.

## Observable outcomes

| Goal | Evidence that the outcome is met |
|---|---|
| Ordinary tools integrate with little ceremony. | Valid supported SARIF without custom approval metadata can publish under normal validation rules. |
| Feedback retains its meaning. | Explanations, attribution, reviewed source association, and proposed operations remain recognizable in the rendered review. |
| Staged changes remove manual suggestion arithmetic. | Supported replacements derive from the staged snapshot and reproduce its intended edits when applied to the reviewed source. |
| Host limitations do not automatically invalidate useful feedback. | Caller policy can select a faithful general-comment representation when native inline presentation is unavailable. |
| Repairs are actionable. | Diagnostics identify the problem, relevant evidence, authoritative input to change, and what a rerun must establish. |
| Failure cannot masquerade as success. | Blocking generation/combination exceptions leave no normal success output path; earlier results are preserved under historical names. |
| Publication preserves review completeness. | An unresolved blocker or approval hold prevents publication of the entire artifact, subject to the explicit approval-only override. |
| Ambiguous publication outcomes are recoverable. | A persisted identity for each intended remote object supports rediscovery before attempting duplicate creation. The manual response-discard experiment verified the marker paths; implemented retry/restart behavior still needs verification. |

## Worked scenario: two reviewers, one intended patch

This is a design walkthrough, not an executed test.

1. Two reviewers inspect the same commit. One identifies a negative retry-delay problem; the other recommends using the existing parser. Their findings concern the same replacement range.
2. The shared staged state replaces that calculation with the parser call and adds a regression-test file. Both are intentional proposed changes.
3. SARIF generation and combination preserves the two findings and their origins. It derives one replacement for the existing calculation, rather than duplicating it for each reviewer.
4. If the inputs describe independently acceptable proposals, the rendered review presents both explanations with the native replacement suggestion and presents the regression test as an explicit addition, preferably through a suggestion PR when enabled. If the inputs instead require the replacement and test to be accepted together, suggestion PRs must be enabled and one PR carries that complete group. The tool does not infer either grouping from the files involved.
5. Upstream proofreading marks an item as awaiting approval. Publication holds the entire review; it does not send the other items independently.
6. The upstream workflow clears the hold after proofreading. Publication revalidates the supplied complete artifact and creates the caller-selected pending or submitted review.

The publisher does not infer whether the second artifact was edited or newly generated. It consumes the declared state in the artifact it receives. Recovery of the same uncertain publication uses the separately persisted publication identity.

## Failure and adjacent scenarios

### User-supplied walkthrough: recommend a missing documentation page

A PR author adds new functionality but omits its documentation page. A colleague reviewing the PR has an agent draft a reasonable page and stages that net-new file as a proposed addition to the author's change.

This is one review contribution: the author's PR is missing documentation, and the reviewer supplies a proposed page to address that omission. It is not feedback critiquing the reviewer's own newly generated page, and no second finding about that page is implied. The staged file is the concrete remedy. The combined SARIF artifact needs to preserve the explanation, proposed repository path, complete staged contents, reviewed revision, and available attribution.

A candidate review presentation is a comment explaining the documentation gap, explicitly asking the author to add the proposed file, and including its path and contents. Where appropriate, the comment can accompany the relevant feature implementation; general review feedback is another presentation governed by caller policy. Do not invent an existing source line for the absent documentation file.

The publisher does not generate or judge the documentation. Upstream proofreading evaluates the proposed page, and any explicit approval hold blocks the whole review. The author or their agent implements the proposed addition.

The user chose a comment on a line in the new file as the association mechanism: upstream SARIF names the proposed documentation file and an actual staged line, perhaps its first line. This tool combines that comment with the staged recommendation to introduce the file. The location refers to proposed content rather than an existing file at the reviewed revision. It does not require a separate critique of the generated page or an equivalent GitHub inline anchor.

The representation walkthrough must still establish the exact SARIF encoding. In particular, it must preserve the intention to create a file rather than treating a nonexistent file as an existing empty file. This is not established merely by producing schema-valid JSON.

### Other scenarios

| Scenario | Required behavior from settled decisions |
|---|---|
| A finding references a line that does not exist at the reviewed revision. | Report the source inconsistency. Best-effort SARIF generation and combination preserves representable evidence in an error artifact; publication does not proceed. |
| Two supplied fixes cannot be reconciled mechanically. | Explain the conflict and preserve evidence for upstream repair; do not synthesize a semantic resolution. |
| An earlier successful output exists before a failed rerun. | Rename the earlier output with an old designation and original-creation-time prefix; the normal success filename remains absent. |
| A reviewer deliberately proposes deleting an obsolete test module. | Convey a file-deletion proposal and its rationale, preserving the distinction between deletion and empty content. |
| An agent accidentally stages private working notes. | Make the proposed addition visible in the resulting review proposal. Its appropriateness belongs to general proofreading, without a special file-addition confirmation mechanism. |
| New commits arrive on the PR branch. | Preserve the explicitly reviewed commit and source association; do not silently retarget the feedback to newer code. |
| A caller intentionally bypasses an approval hold. | Publish the whole artifact only if other validation passes; the override does not waive mechanical correctness checks. |
| The host may have created a review before the response was lost. | Use the saved identity to investigate the outcome before attempting a duplicate creation. |

## Scope boundaries

- Generate, judge, and encode non-fix review feedback as SARIF upstream; extract staged changes into proposed fixes, combine the SARIF, and publish it here.
- Infer neither semantic dependencies nor the correctness of arbitrary accepted subsets.
- Define and honor approval metadata without building the approval experience or feedback-editing history.
- Keep strict and best-effort behavior in SARIF generation and combination; do not offer best-effort partial publication.
- Exclude updating or reconciling existing reviews, including human-edited drafts, and importing GitHub state into SARIF. New input may create a separate review; no review-maintenance roadmap is implied.
- Preserve source meaning across host presentations without promising unverified host capabilities.

## Next evidence needed

A [candidate representation and live prefill-link research](new-file-representation-research.md) now exist for the new-documentation scenario. The example passes the SARIF schema, but the custom operation convention is not yet an adopted interface. The specification keeps these encoding questions distinct from settled product behavior.

Remaining host probes must establish placement boundaries, historical-commit behavior and the full intended pending/submitted review behavior. The [publication-recovery experiment](publication-recovery-experiment.md) verified body-marker preservation and rediscovery for a pending review and suggestion PR after discarding creation responses; it does not prove implemented crash recovery or concurrent retries.

An implementation plan and tests can follow the confirmed contracts. No implementation is authorized or claimed by this brief.
