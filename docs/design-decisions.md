# SARIF review publication: principles and decisions

> **Status note (reconciled September 28, 2026).** This log remains the authoritative decision record. Its earlier statement that no behavior had been implemented was historical, and was replaced on September 30, 2026. For current status, see [Current status and reconciliation](status.md).

Updated: September 30, 2026 (the owner decisions in D45, which supersedes D13, and D46, which amends D42; and the [settled force-push boundary](#settled-force-push-boundary--september-30-2026) with the owner decisions in D48–D60). Earlier: September 29, 2026 (the owner acceptances and decisions in D34–D44).

This is the working design record for the product-shaping conversation. It records decisions, their reasons, their consequences, and what remains open. It is not an implementation specification. An accepted decision does not by itself establish implementation or integration-test completion; consult the corresponding delivery evidence for those claims.

The [observed GitHub behavior register](github-behavior.md) is the starting point for host-capability questions. Use its exact experimental conditions and evidence limits; advertised documentation and product preferences are not substitutes for recorded observation.

The [first behavioral specification](specification.md) translates these decisions into requirements and acceptance scenarios. This log remains the authority for decision provenance; candidate encodings and unresolved contracts remain labeled in the specification.

Entries were reconstructed from the conversation and its working notes. “Settled” means accepted in that discussion; “candidate” means proposed but not accepted. Derived consequences are identified separately so they do not masquerade as explicit user decisions. Later decisions supersede earlier proposals as recorded below.

## Settled force-push boundary — September 30, 2026

The owner's September 30 decisions were drafted as D34–D46 against an earlier copy of this log; they are recorded here as D48–D60 because D34–D46 were already assigned and D47 is reserved for the suggestion-cleanup scope decision, which is recorded with that change. References between them, and from this section, use the new numbers; references to earlier entries keep theirs.

| Drafted as | Recorded as |
|---|---|
| D34 | [D48](#d48-make-publication-policy-caller-controlled--accepted-product-direction-implementation-design-open) — Make publication policy caller-controlled |
| D35 | [D49](#d49-keep-each-supplied-group-available-for-collective-application-in-one-pr--owner-selected-direction-host-verification-open) — Keep each supplied group available for collective application in one PR |
| D36 | [D50](#d50-use-one-delivery-setting-for-whole-file-additions-and-deletions--owner-selected-direction) — Use one delivery setting for whole-file additions and deletions |
| D37 | [D51](#d51-propagate-whole-file-delivery-over-its-explicit-group--owner-selected-precedence) — Propagate whole-file delivery over its explicit group |
| D38 | [D52](#d52-organize-companion-prs-around-caller-selected-acceptance-choices--owner-scenarios-representation-design-open) — Organize companion PRs around caller-selected acceptance choices |
| D39 | [D53](#d53-offer-alternative-remedies-as-a-related-family-of-companion-prs--owner-scenario-cleanup-mechanism-unverified) — Offer alternative remedies as a related family of companion PRs |
| D40 | [D54](#d54-delay-optional-abandonment-cleanup-and-recheck-the-original--owner-selected-candidate-policy-workflow-experiment-pending) — Delay optional abandonment cleanup and recheck the original |
| D41 | [D55](#d55-report-unavailable-explicit-delivery-requests-without-silently-substituting--owner-selected-direction) — Report unavailable explicit delivery requests without silently substituting |
| D42 | [D56](#d56-make-each-review-an-explicit-index-of-its-companion-proposals--owner-selected-scope-extension) — Make each review an explicit index of its companion proposals |
| D43 | [D57](#d57-leave-conversation-resolution-enforcement-to-repository-policy--owner-selected-responsibility-boundary) — Leave conversation-resolution enforcement to repository policy |
| D44 | [D58](#d58-do-not-abort-historical-review-publication-merely-because-the-pr-branch-changes--owner-selected-force-push-direction) — Do not abort historical review publication merely because the PR branch changes |
| D45 | [D59](#d59-treat-force-push-review-lifecycle-as-host-behavior-not-a-new-publisher-service--owner-selected-boundary) — Treat force-push review lifecycle as host behavior, not a new publisher service |
| D46 | [D60](#d60-use-reusable-markdown-components-for-a-rich-github-review-experience--owner-selected-presentation-direction) — Use reusable Markdown components for a rich GitHub review experience |

Read [D56](#d56-make-each-review-an-explicit-index-of-its-companion-proposals--owner-selected-scope-extension), [D57](#d57-leave-conversation-resolution-enforcement-to-repository-policy--owner-selected-responsibility-boundary), [D58](#d58-do-not-abort-historical-review-publication-merely-because-the-pr-branch-changes--owner-selected-force-push-direction) and [D59](#d59-treat-force-push-review-lifecycle-as-host-behavior-not-a-new-publisher-service--owner-selected-boundary) before reopening this discussion.

- A review concerns its explicitly reviewed commit, which may currently or historically belong to the PR. A force push alone is not a reason to abort publication or move feedback to newer code.
- GitHub owns the existing review's presentation and thread state. Repository policy owns any conversation-resolution merge gate. The reviewer or upstream system owns substantive follow-up; collapsed or outdated does not mean addressed.
- Each review body explicitly identifies its companion proposals, including caller-selected reused companions. An upstream system can read those proposals, make another pass and publish a new independent review.
- Companions are continuing conceptual proposals maintained by authorized contributors. Per-wave content snapshots and automatic replacement-PR generations are not required.
- This project's responsibility remains faithful delivery: preserve the reviewed source association, intended proposed changes, complete groups and explicit companion references. Ordinary interrupted-delivery recovery prevents duplicate remote objects; it is not force-push review maintenance. D14/D28 already settle the mechanism: create and persist a distinct identity for each intended review or companion before its creation attempt, embed its hidden marker in that object's body, and discover the marked object after an ambiguous outcome instead of blindly creating another. Recently created candidates are the starting point; a limited lookup miss does not prove absence.
- Remaining experiments establish historical inline/native-suggestion capabilities. A concrete companion containing unintended discarded changes is a proposal-fidelity issue. Neither warrants inventing a general force-push lifecycle service.

**Reopening criterion:** Identify a concrete failure of faithful publication within those responsibilities, or new owner direction that changes them. The mere existence of rewritten history, collapsed feedback or an operational interruption does not establish a missing product feature. Existing evidence must be recovered before repeating established experiments.

## Purpose

Turn feedback expressed in SARIF into a faithful, ordinary code-review experience under the publisher's account. Feedback may originate from people, agents, linters, or other tools. Optional preparation derives proposed changes from a reviewed source snapshot and staged Git state. Generating good feedback and deciding whether it is worth publishing remain upstream responsibilities.

GitHub is the concrete destination under discussion. GitLab is a relevant host, not a declared non-goal; the precise initial host support commitment remains open.

## Principles and their consequences

| Principle | Reason | Decisions it constrains |
|---|---|---|
| P1. Preserve meaning, source context, and attribution. | Presentation can change without changing what the reviewer means. | D2, D3, D4, D5, D6 |
| P2. Keep mechanical conversion separate from judgment. | Deterministic tooling can establish representability, not whether feedback is sensible. | D1, D7, D8, D11 |
| P3. Prepare and validate the whole review before publication. | We do not know which feedback items depend on one another; selecting a subset can change or damage its meaning. | D7, D9, D12 |
| P4. Preserve evidence needed for repair. | Dropping flawed material makes the external repair loop reconstruct lost context. | D8, D9, D10 |
| P5. Ordinary SARIF should work without adopting our workflow conventions. | Commodity producers should not have to stamp every finding with approval metadata. | D1, D11 |
| P6. Separate host capability from caller policy. | A missing native presentation mechanism does not make the underlying feedback invalid. | D3, D6, D7 |

P3 was made explicit when discussing mixed approval states. Its rationale follows the earlier decision not to infer feedback dependencies. That connection should have been surfaced before asking about partial publication.

## Decision log

### D1. Preparation and publication are composable concerns — settled

Preparation may combine SARIF feedback and enrich it with fixes derived from staged changes. Publication consumes SARIF and review context. Feedback-only SARIF and SARIF already containing fixes are legitimate inputs; neither requires staged-change enrichment.

**Reason:** Different upstream workflows should converge on the same publication behavior.

**Consequences:** The publisher does not infer proposed fixes from the staging area. It may still need reviewed source to validate or render supplied fixes. Package boundaries and command structure are not settled.

### D2. One reconciled staged snapshot is the main change-extraction path — settled

Several agents may produce separate feedback reports while contributing to one reconciled staged repository state. Derive proposed edits from that shared state rather than assuming the main workflow merges independent competing fixes.

**Reason:** This makes the repository the concrete expression of the intended changes and avoids model-generated line arithmetic.

**Consequences:** Any validation claimed for those changes must concern the actual staged content. Mechanically conflicting independently supplied fixes may require upstream repair. Using Git to reconcile independent fixes is a candidate, not a required capability.

**Candidate invariant:** Applying supported extracted replacements to the reviewed snapshot reproduces the intended staged content. The exact supported operation contract still needs specification.

### D3. Classify host eligibility, apply caller policy, then render — settled

Determine whether the destination can present feedback in the requested form. Caller policy then chooses an appropriate treatment, and the adapter renders that treatment faithfully.

**Reason:** Valid feedback can concern source that is outside a host's inline-comment surface.

**Consequences:** General feedback with an exact-revision source reference can be legitimate. Do not silently relocate feedback, discard its association, or describe an unverified source location as verified.

**Default decided:** The user selected general review feedback with a link to the exact source location as the default treatment for valid feedback GitHub cannot place inline. This does not make inconsistent source references valid or promise that a general comment retains native click-to-apply behavior. Host eligibility remains separate from that presentation policy.

### D4. Findings, proposed changes, and rendered comments are not one-to-one — settled

A replacement range may carry several feedback items with their individual explanations and attribution, plus one suggestion. Feedback outside that range remains separate.

**Reason:** Presentation should express the actual change without duplicating it or enlarging it merely to collect nearby comments.

**Consequences:** Use the replacement range, not surrounding diff context, to determine suggestion scope. Do not manufacture one replacement per originating agent.

### D5. Preserve origin while publishing through one account — settled

Retain meaningful tool or reviewer attribution when combining feedback. Caller-supplied attribution can supplement inadequate source identity.

**Reason:** A review can mix human reasoning, agent feedback, and specialized local tooling under one publishing identity.

**Consequences:** Combining reports does not imply deduplication, semantic reconciliation, or flattening all runs into one. Existing GitHub draft import is a separate concern.

### D6. Staged additions and deletions can be valid review proposals — settled

A new file can be presented with its proposed path, contents, and explanation. A file removal can be presented as an explicit deletion proposal with its source reference and explanation. Native suggestion support is not the definition of a valid proposal.

**Reason:** A reviewer can legitimately propose a regression test or removal of an obsolete test module. A person or agent can implement feedback that has no direct patch-application action.

**Consequences:** Addition or deletion alone is not a blocking exception. Preserve the difference between deleting a file and emptying it. The tool does not establish whether tests are redundant or whether a staged notes file belongs in the review; proofreading handles those judgments.

**Supersedes:** The earlier blanket rule that a staged new file must be unstaged or treated as an error, and the proposed special confirmation gate for additions and deletions.

### D7. Do not infer or certify semantic dependencies — settled scope boundary

Do not build dependency grouping, certify arbitrary subsets, or guarantee that individually accepted suggestions form a correct program. Humans, agents, and tests reason about those questions upstream and downstream.

**Reason:** We have no established mechanism for reliably identifying or proving those dependencies.

**Consequences:** Mechanical compatibility is not semantic correctness. A clean merge does not prove correctness. This also argues against the publisher choosing a subset of feedback; D12 makes that publication consequence explicit.

### D8. Judgment-dependent failures feed an external repair loop — settled

Produce diagnostics with relevant source and input evidence, what failed, where the repair belongs, and what a successful rerun must establish. The external human or agent corrects ordinary inputs and reruns the same operation.

**Reason:** The converter should explain mechanical obstacles without becoming the agent that reasons through them.

**Consequences:** No special agent mode, report-editing protocol, or new resolution language is required. The repair target may be SARIF or staged repository state; diagnostics must distinguish them. Generated invalid output from valid supported input is a converter defect, not automatically a caller mistake.

### D9. Strict and best-effort modes govern preparation, not partial publication — settled

Strict preparation withholds prepared SARIF when blocking exceptions remain. Best-effort preparation preserves everything representable, including flawed material, and emits diagnostics. It does not filter down to a seemingly publishable subset.

**Reason:** A repair artifact must retain the evidence needed to understand and fix the problems.

**Consequences:** Best-effort output is not authorization to publish. Material that cannot be faithfully represented in SARIF needs its evidence retained alongside the diagnostics; the exact mechanism remains open. Zero blocking exceptions can coexist with declared warnings.

**Supersedes:** Earlier descriptions of best effort as publishing unaffected host comments or emitting only the successful subset.

### D10. Output names distinguish success, failure, and history — settled

Only successful preparation produces the expected normal output filename. Failed best-effort output uses a distinct error filename. Preserve any prior normal output by renaming it with an old designation and a timestamp prefix based on its original creation time, captured before renaming.

**Reason:** A caller that ignores exit status must not accidentally consume flawed output or stale successful output. Earlier results should remain available rather than being deleted or overwritten.

**Consequences:** Use a readable year-month-day prefix, not an epoch value. Failure also returns a failing exit status. Exact names, time precision, unavailable creation-time behavior, collision handling, and prior error-file rotation remain open. Filename conventions supplement publication validation.

### D11. Approval is an upstream convention honored by publication — settled

Represent an explicit awaiting-approval state in SARIF custom metadata. Ordinary SARIF with no such state follows normal publication rules. A deliberate publication option can ignore the awaiting-approval metadata. The tool does not build the approval experience.

**Reason:** Workflows that need proofreading should carry its integration cost; ordinary linter output should not need per-item approval stamps.

**Consequences:** Absence of a hold does not assert that a human approved the feedback. The override bypasses this hold, not other validation. Exact property names and recognized states are not settled. The publisher consumes declared state without reconstructing feedback-editing history; maintaining that state belongs upstream, as clarified later in the conversation.

**Supersedes:** The proposal that every item must carry positive human approval before it can publish.

**Derived workflow consequence:** SARIF generation and combination preserves awaiting-approval metadata. The marker alone does not make that operation fail or force an error output filename; publication is the operation that honors the hold. This follows the agreed publication boundary rather than adding an early approval-check phase.

### D12. Any unresolved approval hold blocks the entire review — settled

Converge on a publishable artifact in its entirety before making GitHub writes. Do not automatically publish ready items while omitting held items. The explicit approval override applies without silently dropping those items.

**Reason:** D7 means the tool cannot establish that a subset preserves the intended feedback. Partial feedback can be incomplete or harmful.

**Consequences:** Whole-review preflight is required. Upstream authors can deliberately revise the artifact, but the publisher does not select a subset on their behalf. This is a readiness boundary, not a claim that multiple remote API operations are transactional; publication recovery remains necessary.

### D13. Diagnostics are Markdown; repair interfaces remain the ordinary inputs — settled

> **Superseded by [D45](#d45-model-diagnostics-once-and-render-them-per-audience--owner-decision)** (owner decision of September 30, 2026). The text below is kept as it was decided.

Start with an editor-friendly Markdown exception report. An internal structured diagnostic model is acceptable, but do not freeze an external machine-readable exception schema at this stage.

**Reason:** Humans and agents need expressive explanations and actionable evidence, not another public protocol to maintain.

**Consequences:** Editing the diagnostic report is not how a caller fixes the next run. D8 determines the authoritative repair target.

### D14. Persist publication identity before sending — accepted approach; verification incomplete

Save a publication identifier locally before creation and include its hidden marker in the review body. If confirmation is lost, search the destination for that marker before another creation attempt.

**Reason:** An ambiguous network outcome must not automatically produce duplicate reviews.

**Consequences:** A matching marker can identify the created review. Failure to immediately find it does not prove creation had no effect. Pending-review marker preservation, concurrency, and completeness of multi-operation recovery still need validation. D16 settles caller control of pending versus submitted publication.

### D15. Validate SARIF format separately from review policy — settled

Use an off-the-shelf JSON Schema validator for structural validation. Product policy checks source consistency, supported treatment, and mechanical compatibility. Review context binds publication to the explicitly reviewed commit rather than silently using the newest head.

**Reason:** A structurally valid document can still refer to nonexistent source or contain incompatible proposed edits.

**Consequences:** A newer branch head does not alone invalidate the reviewed snapshot. Distinguish blocking misrepresentation from warnings about unused features. Exact host placement and historical-review behavior require targeted integration tests.

### D16. Pending versus submitted publication is caller-configurable — settled

> **Status note (reconciled September 28, 2026; updated September 29, 2026).** An explicitly submitted comment review has since been implemented (merged, unreleased) under the [submitted-review contract](submitted-review-contract.md). The owner accepted that contract on September 29, 2026 ([D38](#d38-submit-a-review-only-on-explicit-request-as-a-comment--owner-accepted)): the omitted option keeps a draft, and submission sends the `COMMENT` event only. The text below remains as historically recorded. See [status](status.md).

The caller chooses whether publication creates a pending review or submits the review immediately.

**Reason:** The user explicitly chose configurability rather than prescribing one publication lifecycle for every workflow.

**Consequences:** D12's whole-review readiness gate applies to either destination state. Pending publication does not bypass validation or approval holds. D26 subsequently sets draft as the default when configuration is omitted. Exact option syntax and submission event selection remain unspecified.

### D17. Offer a new-file prefill link only within its supported limits — settled direction; bound unmeasured

The user proposed linking to GitHub's prefilled new-file editor so an author can inspect and commit a proposed addition. A signed-in, unsubmitted probe confirmed short-file prefill; a longer URL was rejected. The user accepted offering this convenience only where it works.

**Consequences:** Preserve the complete ordinary review proposal when the link is unavailable. Recommended eligibility checks use the full encoded URL length and validated destination context; never truncate the file to make the link fit. A production size bound, fork and branch edge cases, and broader security checks remain unverified. See the [research record](new-file-representation-research.md) for exact evidence and the candidate SARIF representation.

### D18. Long proposed documents may use collapsible presentation — settled direction

The user proposed HTML details and summary elements to keep long document proposals readable in the published review.

**Consequences:** Collapsing content is presentation, not truncation or a way around host payload limits. Keep literal file contents separate from generated presentation markup. This does not change D17's URL eligibility rule. The destination's total comment-size limit and treatment of proposals exceeding it still need investigation under the existing faithful-representation and whole-review readiness principles.

### D19. Upstream non-fix feedback arrives as SARIF — settled clarification

The user explicitly clarified the input boundary: line-level feedback and other feedback that is not a fix are supplied to this tool as SARIF. This tool is responsible for turning staged changes into SARIF fixes and combining them with supplied feedback. The exact encoding of whole-file operations remains D6's representation question.

**Later scope extension:** D30 adds explicit authoring helpers for caller-supplied text and source locations. It supersedes the requirement that every caller already have SARIF; it does not add semantic inference from unstructured notes.

**Original consequences:** Do not imply that this tool accepts raw prose review notes and converts them into findings. The conversation exposed ambiguity in the label “preparation”; the current specification calls this operation **SARIF generation and combination**. It begins with supplied SARIF and any staged changes, and ends with the combined output SARIF. Earlier entries using “preparation” refer to this same operation, not upstream authoring or a later review step. The proposed additional early publication check was introduced by the assistant and is not an agreed feature.

### D20. Feedback on a proposed new file supplies its association — settled direction

For the documentation scenario, the user proposed a comment on a line in the new file, perhaps its first line. The tool associates that supplied SARIF feedback with the staged recommendation to introduce the file.

**Consequences:** A separate semantic inference step is unnecessary for this scenario. The location names the proposed path and an actual line in the staged addition. The tool validates that line against the staged content rather than pretending the file exists in the reviewed snapshot. The first line is an example, not a mandatory anchor. The rendered contribution combines the supplied comment and the create-file proposal; its SARIF line association does not require an equivalent GitHub inline anchor. Exact snapshot-disambiguation encoding remains open.

**User-confirmed collapse:** The same model applies to a comment explaining deletion of a file. Both belong to the existing D3 case of meaningful source-associated feedback that may lie outside the host's inline-comment surface. For addition, the referenced content is the staged proposed file; for deletion, it is the existing content before removal. No separate association product or mandatory special comment type is needed.

**Deletion clarification:** The staged operation identifies a whole-file deletion. Association to the file connects its explanation; the particular comment line does not define deletion scope and is not necessary to understand the operation. Do not turn deletion into a line-range proposal merely because supplied feedback has a line location.

## Candidate model: publish proposed changes through a companion PR

The user proposed a companion pull request targeting the original PR's head branch. Its diff carries proposed file additions and deletions, with associated feedback retained in that PR. The author accepts those changes by merging the companion PR into their branch. This is an exploratory alternative, not yet a settled default or an authorization to create branches or publish PRs.

**Assumption removed:** All proposed changes must be transported inside review-comment text. A companion PR can carry actual Git changes, removing the need for copyable file contents or a URL-encoded new-file editor in that publication path. Native suggestions and feedback-only publication remain meaningful; the companion route introduces branch, commit, and PR lifecycle responsibilities.

**Reality:** GitHub allows selecting a PR's destination branch. GitHub Actions branch filters for pull-request workflows apply to that destination. A companion PR targeting a feature branch can therefore miss CI limited to the default branch. Updating the original PR's head after accepting the companion is normally eligible for the original PR's update workflows, subject to their configuration and triggering actor. This is validation after acceptance into the author's branch, not proof of validation before acceptance. No live companion-PR experiment has been performed. Sources: [creating a PR](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/creating-a-pull-request), [workflow events and branch filters](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).

**Recommendation, not a decision:** Treat this as another publication strategy for proposed changes. It also carries related edits across existing and new files together. Whether it replaces the new-file link path, how much of a proposed patch it carries, and its initial product scope remain open. Acceptance remains subject to repository permissions and merge rules rather than a guaranteed literal single click.

**Stress checks:** Missing documentation and whole-file deletion both become ordinary Git diffs with rationale. A related edit plus a new regression test can travel together. Feedback without a proposed change still needs review publication. Fork-based PRs require verification of a writable proposal branch and a supported target repository relationship. Default-branch-only CI leaves a possible pre-acceptance validation gap. Whole-review readiness and approval holds still apply; recovery must account for multiple remote objects if this strategy is adopted.

**User correction to the CI comparison:** Ordinary native suggestions do not themselves supply a separate pre-acceptance CI run either. GitHub documents that accepting one suggestion or a batch creates a commit on the original PR's compare branch. The absence of companion-PR CI is therefore not inherently a regression relative to accepting native suggestions; it can have the same validation timing. Independent checks on the companion, when available, are an additional capability. Source: [incorporating suggestions](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/incorporating-feedback-in-your-pull-request).

**Conceptual collapse proposed by the user:** A suggested change is a compact way to offer a small patch for incorporation into a PR. A companion PR offers the same fundamental proposed-change relationship with a broader Git diff and its own discussion. Both can carry changes that the author accepts into the original branch; they have different host lifecycle and acceptance mechanisms. Keep proposed change as the existing fundamental concept, with native suggestion and companion PR as publication forms. This does not equate a GitHub suggestion object with an actual pull request, decide automatic batching, or settle selection policy. File additions, deletions, and changes spanning files no longer require separate text-transport concepts when published through the companion route.

### Candidate lifecycle simplification: closing references on the original PR

The user proposed adding closing-keyword references to suggestion PRs in the original PR's description, so unused suggestions close when the original work ends. The shared issue/PR numbering motivated the hypothesis, but does not itself prove equivalent lifecycle behavior.

**Documented support:** GitHub explicitly states that merging a referencing PR also closes a referenced PR when using its closing-keyword mechanism. Its documentation restricts description keywords to PRs targeting the default branch. This supports placing references to the companion PRs in the original PR's body when the original targets the default branch. Closing a companion this way does not incorporate its proposed changes. Source: [linking with closing keywords](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue#linking-a-pull-request-to-an-issue-using-a-keyword).

**Boundary:** The mechanism is triggered by merging, not by closing the referencing PR without merging. It therefore does not establish cleanup for every terminal state, or for an original PR merged into a non-default branch. GitHub also exposes a repository setting controlling auto-closing linked issues; its exact interaction with PR-to-PR references, cross-repository permissions, and the particular stacked layout needs a live probe before claiming complete coverage. Source: [auto-closing repository setting](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/managing-auto-closing-issues).

**Status:** The [live doc-linter experiment](companion-pr-lifecycle-experiment.md) verified that merging the original into the default branch with a closing reference closes the suggestion without merging its contents. Closing the original without merging leaves the suggestion open. D21 supplies the settled on-demand cleanup direction for leftovers. Closing suggestion PRs does not by itself establish deletion of their source branches.

**Branch-cleanup hypothesis:** The user proposed using the repository's automatic branch-deletion setting as well. GitHub documents that setting for merged PRs, so it supports the accepted-suggestion case but does not establish deletion of an unmerged suggestion branch whose PR merely closes. The [live experiment](companion-pr-lifecycle-experiment.md) separated accepted suggestions, unmerged suggestions after original merge, and unmerged suggestions after abandonment. All branches remained with doc-linter's automatic deletion setting disabled; behavior with it enabled remains untested. Source: [automatic branch deletion](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches).

**Discoverability fallback proposed by the user:** Label suggestion PRs so they can be filtered, include the original PR number in each suggestion title, and reference the original PR in the suggestion body. The user expects GitHub's enriched reference to expose the original PR's merged or closed state. These provide a recognizable relationship and a way to find leftover suggestions when automatic cleanup does not run. Exact enriched-reference presentation remains to be checked. This is a proposed lightweight fallback, not a decision to require a continuously running cleanup service. The assistant initially missed this contribution while continuing the earlier branch-deletion discussion; the new proposal is part of the current model.

**User clarification: metadata enables simple on-demand cleanup.** The label, title reference, and body backlink support automation, not merely human inspection. A manually initiated script can enumerate the suggestion PRs with pagination, extract their original PR identities, query those originals' current states, and close suggestions whose originals have ended, whether merged or closed without merging. This reuses the relationship recorded on GitHub rather than requiring a separate persistent relationship store or a continuously running service. The assistant's earlier framing as merely a discoverability fallback understated this purpose. Failure to retrieve an original PR's state is not evidence that it has closed. Exact metadata conventions and branch deletion remain separate implementation questions. No cleanup script has been implemented or run.

### Research: native relationships instead of title parsing

The user proposed using GitHub issue dependencies as a queryable original/suggestion relationship. Current GraphQL documentation exposes `blockedBy` and `blocking` on `Issue`, returning issue connections; the documented `PullRequest` fields do not include them. The `addBlockedBy` mutation also returns issue objects. This does not establish a supported PR-to-PR dependency mechanism. Shared REST numbering is not proof of GraphQL type equivalence. Sources: [issue schema](https://docs.github.com/en/graphql/reference/issues#issue), [PR schema](https://docs.github.com/en/graphql/reference/pulls#pullrequest).

A closer candidate is the existing body backlink: PR timelines expose `CrossReferencedEvent` with structured `source` and `target` subjects, either of which can be PRs, plus `willCloseTarget`. This can identify referenced PR objects without extracting numbers from titles. It is a general mention relationship, not intrinsically a suggestion-parent relation; the proposed suggestion label helps narrow candidates, but incidental references and edited/removed links need testing before destructive cleanup relies on it. The title can remain useful display text. Source: [cross-reference schema](https://docs.github.com/en/graphql/reference/issues#crossreferencedevent).

GitHub also documents native PR stack objects and positions in GraphQL, with stacked PRs currently in public preview. This is a separate candidate, not yet a fit established for several optional sibling suggestions targeting one original branch. Issue blocking semantics should not imply that an original PR must accept optional suggestions before it can finish. Sources: [PR stack schema](https://docs.github.com/en/graphql/reference/pulls#pullrequeststack), [stack workflow](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/managing-stacked-pull-requests). All findings here are documentation research, not executed relationship mutations or GraphQL queries.

### D21. Identify suggestion PRs through backlinks and a label — settled direction

The user accepted the combination of GitHub's structured back-references and a suggestion-label convention. Start at the original PR, enumerate its backlinks, and retain referencing PRs carrying the suggestion label. This is the intended original-to-suggestions lookup; it does not require extracting an original PR number from each suggestion title. Titles remain human-readable context.

**Consequences:** On-demand cleanup can find suggestions associated with an original PR that has merged or closed and close any still open. This resolves the earlier conceptual question about narrowing the cross-reference candidates; do not keep presenting generic incidental mentions as a new unresolved product problem. The live experiments verified backlink-plus-label discovery while the original was open, merged, and closed without merging. The remaining open suggestion after abandonment was manually closed after recording evidence. A general cleanup implementation and multi-page traversal still require verification. The user's suggested experiment with a PR number through an issue lookup was not executed; the accepted backlink-plus-label model makes that workaround unnecessary for this relationship.

**D21 query shape, checked against documentation and live single-page results:** One paginated GraphQL traversal can select the original PR's `timelineItems`, restrict `itemTypes` to cross-reference events, follow each event's `source` through a `PullRequest` fragment, and return the PR's identity, state, and labels. Label selection and the backlink traversal can share a request; the documented timeline connection has no source-label predicate, so the caller filters returned labels locally and deduplicates PR IDs. Both timeline and label connections require pagination when their page information indicates more results. GitHub also supports `nodes(ids: ...)` for batch lookup, but it has no label-filter argument and is unnecessary for the direct traversal. The [live lifecycle results](companion-pr-lifecycle-experiment.md) establish the query path for this same-repository experiment. Sources: [PR fields](https://docs.github.com/en/graphql/reference/pulls#pullrequest), [cross-reference fields](https://docs.github.com/en/graphql/reference/issues#crossreferencedevent), [batch node lookup](https://docs.github.com/en/graphql/reference/meta#nodes).

### Superseded policy proposal: native-first versus companion-first

The user raised whether companion PRs should always be used or selected by caller preference, noting that one companion merge can accept distinct changes across several files together. This extends the candidate beyond whole-file additions/deletions to a complete proposed remedy spanning files or ranges.

**Proposed organizing rule:** Choose the publication form for the intended unit of acceptance. A compound proposal that should be accepted together should retain that grouping in the host experience. A native suggestion's host representation and a companion PR are different ways of offering a proposed change; neither establishes the semantic correctness of a chosen subset.

**Assistant recommendation, not yet settled:** Expose a caller preference between native-first and companion-first publication. Native-first uses an inline suggestion when it faithfully represents the complete acceptance unit, and a companion PR for a compound unit that needs it. Companion-first offers proposed changes as PRs even when an inline suggestion would be possible. Native-first is the proposed default. Existing host-capability and fallback policy still governs unavailable forms; this proposal does not silently require new repository permissions.

**D7 boundary:** The caller or input artifact supplies meaningful grouping; the converter does not infer dependencies from proximity or file count. A companion PR can carry an explicitly selected whole patch or a supplied compound remedy. It must not silently merge mutually exclusive alternative remedies into one patch. The choice of publication form does not itself decide how many independently acceptable groups a review contains. Caller preference, default, and exact grouping representation remain open. No implementation has been requested in this discussion.

### D22. Gate suggestion PRs with one caller setting — settled direction

**September 30, 2026 update:** D48 supersedes this decision's restriction to one allow/disable setting and its mandatory preference for native suggestions. D49 subsequently establishes the group's collective-application boundary while allowing a batch of native suggestions or a companion PR. The table below records prior direction rather than requiring PR-only group representation. D48 selects no new default, so the September 29 explicit opt-in, default-off decision below is unchanged by it.

The user chose a setting controlling whether suggestion PRs are allowed, rather than the assistant's proposed native-first versus companion-first modes. Small edits continue to prefer native suggestions in either case, retaining their lightweight review experience and batching support while avoiding unnecessary PRs and potential CI runs.

| Proposal | Suggestion PRs disabled | Suggestion PRs enabled |
|---|---|---|
| Small edit supported by a native suggestion | Prefer native suggestion. | Prefer native suggestion. |
| Whole-file creation or deletion | Preserve the ordinary proposal and use supported action links where available. | Prefer a suggestion PR. |
| Multiple distinct edits explicitly intended for acceptance as one unit | Grouped application is unsupported; do not approximate it with independent apply actions. | Use a suggestion PR carrying the complete group. |

**Reason:** Creation/deletion can have reasonable individual host workflows without a companion PR; grouped application needs a coherent single acceptance operation. The user considers a companion PR the appropriate host mechanism for that operation. A linked creation editor has limited live evidence. A direct deletion confirmation link and the number of clicks in the deletion workflow remain hypotheses to verify, not guaranteed capabilities.

**Consequences:** Preserving explicitly supplied groups is in scope and does not contradict D7's prohibition on inferring dependencies. If publication requires grouped application while suggestion PRs are disabled, explain the required setting instead of silently splitting or omitting the group; D12's whole-review gate applies. Enabling the setting permits proposal-branch/PR publication, not automatic acceptance into the author's branch. Use D21's backlink-plus-label relationship for suggestion PR discovery. Exact grouping representation, permission-failure handling, and multi-object publication recovery remain open implementation contracts.

**Owner decision (September 29, 2026): explicit opt-in, default off.** Suggestion PRs are created only when the caller explicitly enables them; when the setting is omitted, they are disabled. The owner recorded this on [issue #5](https://github.com/mike-north/sarif-to-comment/issues/5), after the evaluation against PR clutter and triggered automation in the [companion suggestion PR contract §2.1](companion-suggestion-pr-contract.md#21-the-setting-and-why-it-is-off-by-default). The explicit enable setting and the explicit disable choice both remain. This supersedes the earlier provisional default below, which is kept as recorded.

**Earlier provisional default (superseded September 29, 2026), low conviction:** The user chose suggestion PRs enabled when the setting is omitted, explicitly as a choice to validate with real user feedback. Additional PR clutter and organization-specific review infrastructure triggered by PR creation may make opt-in preferable in some environments. Keep the explicit disable setting. Assess this default through actual user experience and downstream automation costs; do not describe it as a high-confidence or permanently settled preference. Small edits still prefer native suggestions.

**Supersedes:** The assistant's two-preference policy above. It does not establish an always-use-PR mode or turn file creation/deletion into errors when suggestion PRs are disabled.

**User stress case: multiple file additions accepted together.** The explicit group determines the acceptance unit: one suggestion PR contains every addition. Do not create one PR per file or substitute separate creation links. When suggestion PRs are disabled, the same grouped-application limitation applies. This case requires no new policy or concept.

### D23. Keep file descriptions separate from proposed operations — settled conceptual model

The user accepted artifacts describing file paths and contents, with proposed remedies carrying creation, deletion, or editing operations that reference those artifacts. Related operations can belong to one acceptance unit. Exact extension field placement and names remain open; accepting this model does not adopt the earlier illustrative result-level encoding.

**User validation direction:** Warn about proposal artifacts whose intended use the tool cannot understand. This is not a blanket rule that every ordinary SARIF artifact must participate in a fix: artifacts can legitimately provide analysis context. A warning applies where faithful publication remains possible; an unknown operation needed to realize the intended proposal remains subject to the existing whole-review blocker rule. The assistant's spoken suggestion to arbitrarily choose between failing fast and warning is not a separate accepted policy.

**Confidence and evidence:** Standard artifact fields can carry paths and content; property bags accept structured custom JSON without a schema-defined per-value size limit; the illustrative creation extension passed schema validation. These establish representational flexibility. They do not settle a general creation/deletion/group schema, guarantee other SARIF consumers understand it, or remove required standard fields from native fix objects. The remaining work is a precise, validated extension contract.

**Accepted encoding direction after the concrete walkthrough:** Put the proposed operation in the result's extension properties, referencing the artifact that describes the file. The user accepted this direction after verifying that the result has a standard property-bag extension point and can reference artifacts. Do not infer creation merely from an artifact's presence, and do not confuse the result's source location with the proposed operation's target. The creation instruction and its artifact reference are our convention inside the standard extension mechanism. Exact field names and the complete mixed-operation/alternative-remedy contract remain open. Native SARIF fixes remain available for standard edits. This supersedes the earlier stopping point of identifying a possible encoding without choosing its placement; it does not require fitting extension-only proposals into native fix objects with mandatory replacement fields missing.

### D24. Establish the relationship from the suggestion PR — settled

The user clarified that the required reference belongs in the suggestion PR's body and points to the original PR. The reviewer creates the suggestion PR but may lack permission to edit the original PR's description. Publication must not require that permission. D21's lookup still starts at the original PR and follows the back-reference generated by the suggestion's mention.

**Consequences:** Use an ordinary reference from suggestion to original, not a closing keyword that could close the original when the suggestion merges. The earlier original-body closing-keyword proposal cannot be the required cleanup mechanism: it depends on permissions this workflow does not assume. No automatic edits to the original description are part of establishing the relationship. The already-discussed on-demand cleanup can use backlinks plus the suggestion label when the original ends. Optional use of original-body closing references remains unadopted, not an assumed publication step. The separate question about visible suggestion PRs alongside pending reviews remains unanswered.

### D25. Record fork-based suggestions without expanding near-term scope — settled priority

The user pointed out that suggestion PRs may live in forks, then explicitly clarified that near-term cases do not involve forks and this should be recorded for completeness. The current focus is same-repository suggestions. Cross-repository support is a future compatibility case, not a required near-term feature or blocker.

**Future considerations:** A suggestion targeting the original PR's head branch may belong to that branch's repository rather than the original PR's repository. Backlink discovery can retain each source PR's repository and stable identity, with labels evaluated on that PR. Discovery and permission to close it are separate. Any branch cleanup would additionally resolve the actual head repository. Fork permissions, label provisioning, visibility, and cross-repository behavior will need verification if that scope is taken up. No new relationship store or title convention is implied. The assistant's briefly added normative cross-repository requirement was premature and has been removed from the near-term specification.

**Schema clarification:** The user asked specifically whether following the reference can return a PR from another repository. Yes: `CrossReferencedEvent` explicitly exposes `isCrossRepository`, and its `source`/`target` subjects can be PR objects with their own `repository` fields. The proposed nested traversal is not inherently limited to the original repository; visibility remains constrained by the querying identity. This answers the representational question without promoting fork workflows into near-term scope. Sources: [cross-reference fields](https://docs.github.com/en/graphql/reference/issues#crossreferencedevent), [PR fields](https://docs.github.com/en/graphql/reference/pulls#pullrequest).

**User permission scenario:** Three reviewers may have suggestions distributed across forks, while each cleanup identity has authority to close only some of them. Discovery can span the accessible relationship graph, but one invocation cannot promise global cleanup. The intended future behavior is to close eligible suggestions the caller can close and report visible suggestions left open for lack of permission, separately from failed close attempts. Other authorized reviewers can run cleanup for the remainder. Do not equate successful cleanup within one caller's authority with closure of all suggestions. Repeated runs should tolerate already-closed suggestions. This future-case record does not expand near-term fork support. PR-closing authority must be checked on each PR; it is not inferred solely from fork ownership or branch-edit permissions.

**Reference-format clarification:** For the optional original-description closing references discussed by the user, `Closes #123` identifies a suggestion in the original PR's own repository; `Closes owner/repository#123` identifies a suggestion PR in another repository. The qualifier names the repository containing the suggestion PR, which need not be its source-branch repository. Repeat the keyword for each target. Ordinary suggestion-body references likewise resolve relative to the suggestion PR's repository and must qualify an original PR in another repository. This does not make original-description editing a required step or extend closing keywords to abandonment. Source: [GitHub closing-reference syntax](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue#linking-a-pull-request-to-an-issue-using-a-keyword).

### D26. Pending publication means a draft code review — settled

The user clarified that pending means a draft code review and accepted the host's normal draft visibility. In the question under discussion, associated suggestion PRs may be created as drafts while the review remains unsubmitted; do not introduce a separate privacy or deferred-creation workflow merely because repository readers can see draft PRs. Pending review comments and draft PRs remain distinct GitHub objects with their respective native visibility rules.

**Consequences:** Prefer the user-facing phrase draft code review over the ambiguous label pending mode. D11/D12 readiness and approval checks still occur before publication. This settles the initial coexistence of a draft review and visible draft suggestion PRs; it does not introduce an automatic service tracking later review submission or discard.

**Supersedes:** Earlier open notes asking whether visible suggestion PRs alongside pending reviews are acceptable; the user answered yes.

**Default decided:** The user selected draft code reviews when publication mode is omitted. Immediate submission requires an explicit caller choice.

### D27. Sweep open suggestion PRs for on-demand cleanup — settled

**September 30, 2026 update:** See also [D54](#d54-delay-optional-abandonment-cleanup-and-recheck-the-original--owner-selected-candidate-policy-workflow-experiment-pending), a candidate optional workflow that waits two minutes after an original closes without merging, rechecks that it is still closed and unmerged, and then invokes this existing cleanup. It is not implemented, and it does not change this sweep. The text below is kept as decided.

After the live lifecycle tests, the user accepted that closing an original PR without merging can leave an unmerged suggestion open. This is a supported cleanup case, not a reason to add another lifecycle service or reopen the design. The preferred sweep starts with open PRs carrying the suggestion label, resolves their referenced original PRs, and closes eligible suggestions whose originals have ended, using the caller's actual permissions. Starting from ended originals and finding their suggestions remains valid for targeted cleanup under D21; suggestion-first enumeration is cleaner for a broader sweep.

**Scaling rationale:** Candidate enumeration follows outstanding open suggestions rather than the accumulating history of all closed original PRs. This is an architectural property, not a measured performance result. Pagination and repeated-original lookup deduplication belong in implementation; no separate relationship database or continuously running process is needed.

**Boundaries:** Positively resolve the original and retrieve its current terminal state before closing a suggestion. Missing access or a failed lookup is not proof that the original ended. Report permission-limited leftovers and failed actions accurately. The live tests establish original-first backlink discovery and closure behavior; the exact suggestion-first lookup implementation still needs verification. Branch deletion remains separate from PR closure and requires authority over the actual source branch. The user considers abandonment uncommon, but the cleanup path handles it without relying on its frequency.

### D28. Rediscover a created suggestion even when its response was lost — accepted approach

The user identified the ambiguous-create case: GitHub persists the suggestion PR but the connection drops before returning its identity. Recovery cannot depend on a locally saved PR number or URL. Persist the identity of the intended suggestion before sending the request and include a hidden marker in that PR's body as part of creation. The user then identified the existing original-PR reference as a narrower discovery path: the original PR is already known, and the suggestion body carries its ordinary reference in the creation request. Recovery should first traverse that original's backlinks, inspect candidate bodies for the exact marker, and verify the matching PR against the intended publication before resuming missing work. The reference narrows candidates; the marker distinguishes this intended suggestion from others targeting the same original. Repository enumeration remains a possible fallback, not the primary discovery requirement.

**Consequences:** The marker identifies this particular suggestion within the publication; it must not accidentally conflate distinct suggestion groups. A hidden comment is unobtrusive metadata, not a secret or credential. Recently created PRs are a useful search starting point, but failing to find a match in a recent subset is not evidence that creation failed. Candidate lookup must also cover partially completed publication: it cannot depend exclusively on a label if labeling can occur after PR creation. Recover using the known destination and exact operation identity even when the response supplying the remote PR identity never arrived. The [recovery experiment](publication-recovery-experiment.md) verified marker preservation and exact rediscovery for both an unlabeled suggestion PR and a pending review after deliberately discarding creation responses. Actual transport failure, visibility delays, concurrency and implemented restart recovery remain untested.

**Extends:** D14's persisted-before-send identity approach to suggestion PR creation. This is retrying the same publication, not deduplicating independent new reviews.

**Cardinality clarified:** Each intended remote object has its own stable identity: one for the review and a distinct one for each suggestion PR. Retries retain those identities; a network attempt does not receive a new object marker.

### D29. Publish the initial review in one direction — accepted scope constraint

The product takes SARIF to GitHub to create an initial review. It does not maintain that review afterward, reconcile human edits to a draft, import GitHub changes back into SARIF, or manage re-review. A wholly new SARIF input may create a separate new review; it does not update the earlier review.

**Product question reopened September 30, 2026, then bounded by D56:** The user questioned whether the author's and reviewer's back-and-forth is adequately modeled by treating each later feedback wave as another unrelated SARIF input. D56 selects explicit review-body references to companion PRs so an upstream agent can recover the review's proposals, manage their continuing content, and publish a subsequent independent review that may reference the same companions. A new artifact or publication does not imply unrelated feedback. The publisher still does not infer resolution, manage the review conversation, synchronize artifacts, or maintain previously published reviews.

Recovery is limited to establishing and completing the same initial publication without duplicate creation. Reading GitHub for delivery verification does not introduce synchronization. It must not restore original content over human changes or recreate human-deleted content as a maintenance operation. Unresolved delivery can be reported without implementing a human-change reconciliation system. This supersedes any broader continuation-policy implication in the independent model comparison. Previously agreed suggestion cleanup remains a separate, bounded action under D27.

**API evidence:** GitHub's [create-review endpoint](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request) accepts the review body and an array of inline comments in one request, with the reviewed commit and optional submission event. Omitting the event creates a pending review; specifying an event submits it. Thus review creation need not be a loop of separately created comments. Separate suggestion PRs are outside that request. This documents a single-request capability, not an unverified atomicity guarantee under failures or an unlimited payload promise.

### D30. Agent-friendly SARIF authoring and proofreading — user-selected second milestone

On September 28, 2026 the user selected staged-change extraction without suggestion PRs, then added a self-contained authoring workflow: initialize SARIF, add feedback on lines or line ranges, correct mistakes by removing and recreating feedback, inspect the current findings and fixes, incorporate staged changes as fixes, inspect again, validate readiness, and explicitly publish to GitHub. An agent should not need an upstream SARIF producer or direct knowledge of the format to perform this loop.

Every operation needs CLI commands/subcommands and an equivalent library surface. The CLI must support human-readable and JSON output; the user expects agents to favor JSON. Inspection shows findings, files, lines/ranges and any included fixes, not only fixes eligible as native GitHub suggestions. Fix previews may be truncated; truncation is a property of the view, not a destructive change to the artifact.

This extends D19: callers may still supply ordinary SARIF, but they can also use explicit authoring helpers with caller-provided text and locations. The tool does not invent a critique or infer a source association from arbitrary prose. Optional validation is now user-requested; it is not a mandatory extra approval gate, a publication act or a replacement for publication-time checks. D29's one-way GitHub publication boundary remains intact; local authoring/removal is not review maintenance.

The user delegated naming and design discretion and expressly requested independent scrutiny. The [milestone scope](second-milestone.md) and [interface design](second-milestone-interface-design.md) record the selected vocabulary, review feedback and remaining contracts. Detailed choices such as immutable library authoring, complete-finding removal including its attached fixes, and file-output policies are lead-selected designs under that discretion, not separately quoted user decisions.

### D31. Deliver the linear happy path before correction and standalone validation — user-selected priority

Later on September 28, 2026, while scoping the next milestone assignment, the user explicitly deferred proofreading/correction and standalone validation in favor of “the happy path first”: establish findings, see what is present, incorporate staged changes as SARIF fixes, and publish to GitHub. Initialization, adding comments, basic read-only inspection, staged incorporation, and publication comprise the next increment. CLI/library equivalence and human-readable/JSON CLI output remain required.

D30 remains the broader desired workflow. Its removal/correction operations and separate validation surface are no longer requirements of this milestone. Existing publication-time validation, faithful representation and safe failure/delivery behavior are preserved. Do not interpret the deferral as permission to publish invalid, incomplete or incorrectly placed content.

### D32. Keep authoring optional and freestanding behind ordinary SARIF boundaries — user-selected architecture

The user explicitly requires bootstrapping SARIF and adding/iterating on comments to be a modular, freestanding concern. Staged-fix incorporation, validation and publication operate on existing SARIF, which may originate in the helper library or an upstream tool. Library consumers exchange ordinary in-memory SARIF; CLI consumers use SARIF files.

Do not make the authoring helpers, their initialization history, an opaque builder/session, helper-specific metadata or a private intermediate representation mandatory for downstream operations. Preserve upstream-produced SARIF → staged incorporation and ready upstream-produced SARIF → direct publication. Required source context and the existing supported-profile checks remain applicable; optional authoring must not obstruct a supported upstream input.

This constrains responsibilities and composition, not deployment units: separate npm packages are not required. Future comment editing belongs to authoring; adding Git/GitHub behavior to a single authoring abstraction through unrelated modes would violate this boundary. Inspection of existing SARIF is shared, not authoring-only. D31's happy path is an example composition, not an enforced workflow state machine.

### D33. Maintain the implementation in strict TypeScript and distribute generated CommonJS — settled engineering decision

The implementation is strict TypeScript: runtime modules are `src/*.cts`, compiled by `tsc` into flat CommonJS `dist/*.cjs`, one directory below the package root as before. The public declarations are generated from that implementation: `tsc` emits per-module declarations and API Extractor rolls up those reachable from the declaration entry (`src/public-api.cts`) into the single shipped `dist/sarif-to-comment.d.ts`, with the API report and reference documentation derived from it. There is no hand-written declaration file.

The runtime entry (`src/index.cts`) stays a plain `module.exports` object of the five public functions, produced with `export =` and `import x = require()` so that no `__esModule` marker is emitted. A compile-time check proves that object has exactly the functions and types of the declaration entry. Private injection seams (a second argument to `publishSarifReview`, preparation and publication internals, the CLI's `main(io, internals)` through the shipped executable) keep their runtime behavior but are absent from the public declarations: the public function has one declared overload, and in-repository callers inject through internal functions. The seams remain unsupported test hooks, not a contract.

Tests, fixture helpers and build, check and release tooling are `.mts` files that Node runs directly by type stripping, and the tests exercise the built `dist/`, the artifact that ships. A content manifest of every build input and output makes tests and the manual-publish backstop refuse a missing, incomplete or stale `dist/`. Consumer `engines` stays `>=22`; the development floor of Node 22.18.0, the first release that runs `.mts` without flags, is enforced only for development through `devEngines`.

**Reason:** Declarations generated from the implementation cannot drift from it, and strict typing makes unchecked boundaries explicit. Consumers must see no difference from 0.2.0: the same public API, CLI behavior and CommonJS, ES module and bundler interop. A standard ES-module-syntax entry would emit an `__esModule` marker that changes the ES module namespace keys and bundler default-import behavior, and the seams were observable runtime behavior of the published package.

**Consequences:** `pnpm run build` is a prerequisite of `pnpm run check`, the tests and publication; there is no `prepack`, so the published tarball is exactly what was checked. Packaged runtime files moved from `src/` and `bin/` to `dist/`; `main`, `types` and `bin` point there, and the `exports` map, which exposes only the package entry and `package.json`, is unchanged. Removing or narrowing the seams, and consolidating duplicated helpers, are separate future decisions. Runtime validation of inputs stays in place even where the types appear to make it unnecessary, because JavaScript callers are unconstrained.

### Owner acceptances of September 29, 2026

On September 29, 2026 the owner accepted the contracts that had been implemented under provisional options, the security baseline and an evidence policy ([issue #24](https://github.com/mike-north/sarif-to-comment/issues/24)), and decided the suggestion pull request convention, force-push handling, grouping and alternative fixes ([#27](https://github.com/mike-north/sarif-to-comment/issues/27), [#28](https://github.com/mike-north/sarif-to-comment/issues/28), [#29](https://github.com/mike-north/sarif-to-comment/issues/29), [#30](https://github.com/mike-north/sarif-to-comment/issues/30)). D34–D44 record those decisions. Each names its source issue and, where one applies, the merged pull request whose behavior it accepts. A contract item that is not named here, or that its contract still lists as awaiting the owner, remains undecided. The companion suggestion PR default decided the same day (explicit opt-in, default off, [#5](https://github.com/mike-north/sarif-to-comment/issues/5)) is recorded in [D22](#d22-gate-suggestion-prs-with-one-caller-setting--settled-direction).

### D34. Remove findings by document-bound selectors — owner-accepted

**Provenance:** [issue #24](https://github.com/mike-north/sarif-to-comment/issues/24), accepting the [finding removal contract](finding-removal-contract.md) as merged in [PR #14](https://github.com/mike-north/sarif-to-comment/pull/14) ([#1](https://github.com/mike-north/sarif-to-comment/issues/1)).

A finding is selected for removal by the selector that inspection shows: its position bound to a digest of the whole document (the contract's option C). Any change to the SARIF document makes every earlier selector stale, so each removal requires a fresh inspection. Nothing is written into the document to make its findings removable.

**Consequences:** A stale or ambiguous selector is refused and never deletes whatever now occupies an old position. Removal stays local authoring (D29, D30). Batch removal and persistent identifiers remain possible later additions, not decisions.

### D35. Readiness assessment reports ready, blocked or incomplete, statelessly — owner-accepted; one check added

**Provenance:** [issue #24](https://github.com/mike-north/sarif-to-comment/issues/24), accepting the [readiness assessment contract](readiness-assessment-contract.md) as merged in [PR #15](https://github.com/mike-north/sarif-to-comment/pull/15) ([#2](https://github.com/mike-north/sarif-to-comment/issues/2)), with one addition, specified in [#23](https://github.com/mike-north/sarif-to-comment/issues/23) and implemented in [PR #35](https://github.com/mike-north/sarif-to-comment/pull/35).

Accepted: the `ready`, `blocked` and `incomplete` outcomes; operational failures reported as `incomplete` rather than thrown; `problems` on a `blocked` outcome; exit statuses 0, 2 and 1; stateless operation, with no state path accepted and no file written; and no approval stamp, so publication rechecks everything against the pull request as it is then.

**Addition:** Assessment must also report a known publication obstacle: a pending review on the exact destination pull request owned by the authenticated account. This replaces the contract's earlier proposal not to pre-check pending reviews. It is implemented (merged, unreleased): pending reviews by other accounts and submitted reviews are ignored, and a review list that cannot be read makes the assessment `incomplete` ([contract: Pending review of this account](readiness-assessment-contract.md#pending-review-of-this-account), [live evidence](pending-review-check-e2e-evidence.md)). Publication still meets the condition only as GitHub's refusal of the create request.

### D36. Publish whole-file operations as byte-determined review-body sections — owner-accepted

**Provenance:** [issue #24](https://github.com/mike-north/sarif-to-comment/issues/24), accepting the [file-operation publication contract](file-operation-publication-contract.md) as merged in [PR #16](https://github.com/mike-north/sarif-to-comment/pull/16) ([#4](https://github.com/mike-north/sarif-to-comment/issues/4)).

Accepted: one review-body section per distinct file operation, followed by every finding that carries it; a non-decoding existence check at the reviewed commit, so a deletion of a binary or oversized file still publishes; presentation facts that, with the displayed block, determine the file's exact bytes; and the conservative refusals of content the block could not show exactly.

**Consequences:** No prefill link, deletion link or collapsed presentation is part of this form; each remains a possible later addition under D17 and D18. Each refusal can be relaxed later with live evidence without changing any published output.

### D37. Fence proposed file content one backtick longer than its longest run — owner-accepted, verified live

**Provenance:** [issue #24](https://github.com/mike-north/sarif-to-comment/issues/24) and the completed [rendering experiment](https://github.com/mike-north/sarif-to-comment/issues/22).

A proposed file's content is shown in a backtick fence one longer than the longest backtick run in the content, and at least three, with no info string. In the experiment, GitHub rendered a Markdown file containing triple-backtick examples and a fourteen-backtick line as one exact code block.

**Consequences:** This is how file-operation presentation (D36) meets S1's fence containment for proposed content.

### D38. Submit a review only on explicit request, as a comment — owner-accepted

**Provenance:** [issue #24](https://github.com/mike-north/sarif-to-comment/issues/24), accepting the [submitted-review contract](submitted-review-contract.md) as merged in [PR #17](https://github.com/mike-north/sarif-to-comment/pull/17) ([#7](https://github.com/mike-north/sarif-to-comment/issues/7)).

Accepted: submission is an explicit opt-in (`options.submit` / `--submit`); omitting it leaves a draft review (D26); a submitted review sends GitHub's `COMMENT` event only; and the mode is part of the publication's durable state, so a retry with the other mode is refused.

**Consequences:** This settles the option syntax and submission event that D16 left open. `APPROVE` and `REQUEST_CHANGES` are not offered; a verdict option would be a separate decision.

### D39. The security baseline: S1, S2, S3, S5 and S7 are requirements — owner-accepted

**Provenance:** [issue #24](https://github.com/mike-north/sarif-to-comment/issues/24).

S1 (literal content and fence containment), S2 (staged content through the intended Git snapshot), S3 (the path and URI contract), S5 (explicit, bounded resource limits without silent loss) and S7 (approval state is not identity) are normative requirements in [specification §9](specification.md#9-security-requirements). S4 and S6 concern new-file action links, which are not implemented; they remain proposed, with [#8](https://github.com/mike-north/sarif-to-comment/issues/8).

**Consequences:** Accepting a requirement is not a claim of completed security validation; the validation cases in §9 still name the evidence each requires.

### D40. Evidence manifests are immutable historical attestations — owner-accepted

**Provenance:** [issue #24](https://github.com/mike-north/sarif-to-comment/issues/24).

A historical evidence manifest is kept unchanged and annotated with the commit or artifact it attests to. A later accepted snapshot gets a new manifest. An old manifest is never rewritten to match current files. The [evidence policy](evidence-policy.md) states the rule and indexes each manifest.

**Reason:** The recorded hashes attest to what was reviewed or released at the time. Documents they list are edited later, so a manifest that does not match the current head is expected, not a defect.

### D41. The suggestion pull request convention and options — owner decisions

**September 30, 2026 update:** See also [D56](#d56-make-each-review-an-explicit-index-of-its-companion-proposals--owner-selected-scope-extension): each review body references the companion pull requests that belong to it, and contributors with push permission maintain a continuing companion proposal. That is consistent with this convention, under which a producer never updates a branch it created while people may push to it. [D53](#d53-offer-alternative-remedies-as-a-related-family-of-companion-prs--owner-scenario-cleanup-mechanism-unverified) and [D54](#d54-delay-optional-abandonment-cleanup-and-recheck-the-original--owner-selected-candidate-policy-workflow-experiment-pending) record an owner scenario for families of alternative companions and a candidate delayed-cleanup workflow. None of these is implemented. The text below is kept as decided.

**Implemented September 30, 2026 (unreleased):** the opt-in is replaced by the delivery policy's `companion` listing ([D48](#d48-make-publication-policy-caller-controlled--accepted-product-direction-implementation-design-open), [D55](#d55-report-unavailable-explicit-delivery-requests-without-silently-substituting--owner-selected-direction); [delivery policy contract](delivery-policy-contract.md)).

**Provenance:** [issue #27](https://github.com/mike-north/sarif-to-comment/issues/27), implemented in [PR #31](https://github.com/mike-north/sarif-to-comment/pull/31).

Suggestion pull requests follow a tool-neutral [convention](suggestion-pr-convention.md): the canonical label `suggestion-pr`, or the `label` of a hand-maintained `.github/suggestion-prs.json` on the default branch, resolved identically by publication, readiness assessment and cleanup; branches `suggestion-pr/<pull>/<id>`, created once and never updated, force-pushed or deleted; a hidden marker with `batch`; a neutral title and body with an ordinary reference to the original, no closing keyword, and a brief lifecycle note. The options are `allowSuggestionPullRequests` / `--allow-suggestion-prs`, `pullRequestLabels` / `--pr-labels` and `markSuggestionPullRequestsReady` / `--mark-suggestion-prs-ready`; the per-call label is removed. Every label must already exist, and the tool never creates one. Suggestion pull requests are drafts by default. Support covers the same repository with a default-branch base; forks and other bases are not yet supported. The limits and mechanics are accepted as merged ([companion contract §4](companion-suggestion-pr-contract.md#4-decisions-awaiting-acceptance)). Cleanup resolves the same label, keeps `--label` only as a migration override, acts on any conforming suggestion pull request, closes pull requests only and refuses commas in labels ([cleanup contract §4](suggestion-cleanup-contract.md#4-decisions)).

**Still open:** the details those contracts and the [convention's open questions](suggestion-pr-convention.md#10-open-questions) list as awaiting the owner.

### D42. Test ancestry when the original's branch has moved — owner decision

**September 30, 2026 update:** Superseded in part, as target direction. [D58](#d58-do-not-abort-historical-review-publication-merely-because-the-pr-branch-changes--owner-selected-force-push-direction) keeps a review about its explicitly reviewed commit when the branch moves, and states that this does not authorize automatic re-analysis, or re-application or rebasing of proposals. [D59](#d59-treat-force-push-review-lifecycle-as-host-behavior-not-a-new-publisher-service--owner-selected-boundary) treats a companion that would unintentionally include discarded changes as a proposal-fidelity issue, to be investigated as such, rather than using branch movement as a blanket blocker. This entry's rule for a rewritten history (re-apply each suggestion onto the head when its regions are byte-identical there, with a version 2 marker naming that head) is therefore no longer the target. Its forward-move rule, that a branch which only moved forward is not a reason to refuse, is consistent with D58 and stands. The text below is kept as decided.

**October 1, 2026 update:** Re-application is removed, before it was ever released (see the implementation note under [D59](#d59-treat-force-push-review-lifecycle-as-host-behavior-not-a-new-publisher-service--owner-selected-boundary)). Every suggestion pull request is proposed on the reviewed commit. The version 2 marker and plan are no longer written, and are still read.

**Provenance:** [issue #28](https://github.com/mike-north/sarif-to-comment/issues/28), implemented in [PR #32](https://github.com/mike-north/sarif-to-comment/pull/32), based on the [force-push experiment](force-push-experiment.md).

A branch that only moved forward after the review is not a reason to refuse: suggestion pull requests are proposed on the reviewed commit. After a rewritten history, each suggestion is re-applied onto the head only when everything it changes is byte-identical there, and carries a version 2 marker naming that head; otherwise it is not created, with the reason stated in the review and the outcome. Ordinary feedback publishes as before.

**Still open:** the details of re-application and the handling of a branch rewritten again after planning, as the [companion contract §4](companion-suggestion-pr-contract.md#4-decisions-awaiting-acceptance) and the [convention's open questions](suggestion-pr-convention.md#10-open-questions) list them.

**Amended by [D46](#d46-fall-back-as-if-suggestion-pull-requests-were-not-allowed--owner-decision):** a suggestion that cannot be re-applied is no longer skipped with its change shown as text; it is handled as if suggestion pull requests were not allowed.

### D43. Group independent fixes by an explicit authoring step — owner decisions

**September 30, 2026 update:** Superseded in part, as target direction, by [D49](#d49-keep-each-supplied-group-available-for-collective-application-in-one-pr--owner-selected-direction-host-verification-open) and [D51](#d51-propagate-whole-file-delivery-over-its-explicit-group--owner-selected-precedence). D49 keeps each supplied group available for collective application in one PR: either all of its changes as batchable native suggestions on the original PR (a mixed group may include manual file-operation content assembled into one commit), or all of them in one companion PR. This entry's refusal of a grouped document when suggestion pull requests are disabled is therefore no longer the target, subject to the host verification D49 leaves open. D51 carries a group that contains a whole-file operation to that operation's delivery destination. The explicit authoring step, the rule that nothing is inferred and the rule that a finding belongs to at most one group are consistent with D49, which leaves regrouping to the user. The refusal remains the implemented behavior. The text below is kept as decided.

**Provenance:** [issue #29](https://github.com/mike-north/sarif-to-comment/issues/29), implemented in [PR #33](https://github.com/mike-north/sarif-to-comment/pull/33).

Extraction stays deterministic: every separable staged hunk is its own fix. Grouping is a separate authoring step (`group-fixes` / `groupSarifFixes`, `ungroup-fixes` / `ungroupSarifFixes`) that writes the per-result `suggestionGroup` property, renamed from the unreleased `acceptanceGroup`. A SARIF fix with several changes is already a group and needs no property. A group holds at least two distinct changes; a finding belongs to at most one group; groups are never joined, and a name already in use extends its group; only a finding's primary fix is a member; a member without a change is refused; nothing is inferred. With suggestion pull requests disabled, a grouped document is refused naming the setting ([companion contract §2.3, §2.4 and §2.12](companion-suggestion-pr-contract.md#23-groups-a-fix-with-several-changes-and-explicit-groups)).

**Consequences:** This applies D7: groups are supplied, never inferred.

### D44. Publish the first fix and list the others as alternatives — owner decision

**September 30, 2026 update:** See also [D53](#d53-offer-alternative-remedies-as-a-related-family-of-companion-prs--owner-scenario-cleanup-mechanism-unverified), an owner scenario that offers a result's alternative remedies as a related family of companion PRs, and [D52](#d52-organize-companion-prs-around-caller-selected-acceptance-choices--owner-scenarios-representation-design-open), which keeps explicit competing alternatives as separate acceptance choices. Both are inputs for design, not authorization. They do not replace this entry's presentation, which remains the implemented behavior. The text below is kept as decided.

**Provenance:** [issue #30](https://github.com/mike-north/sarif-to-comment/issues/30), which supersedes [#9](https://github.com/mike-north/sarif-to-comment/issues/9), implemented in [PR #34](https://github.com/mike-north/sarif-to-comment/pull/34); the [specification's R4 clarification](specification.md#r4-treat-irreconcilable-mechanical-conflicts-as-repair-work).

When a SARIF result carries several fixes, the first is its suggested change: a native suggestion where eligible, otherwise a suggestion pull request when allowed, otherwise the existing review-body presentation. Every further fix is listed in the same comment under "Alternatives to consider:", each in a dynamic fence (D37). The producer's order decides; the tool makes no semantic judgment. Alternatives are never unioned into one patch and are never members of a suggestion group (D43). They count toward the size limits and are never truncated. Extraction from staged changes is unaffected: it produces one fix per hunk.

**Reason:** R4's "MUST NOT choose a semantic winner" governs conflicting edits during generation and combination, not the presentation of alternatives a producer has already ordered. The earlier `fix-alternatives-unsupported` refusal was a limit of the first milestone's supported profile, not an owner decision.

**Consequences:** A single fix with several changes remains one change accepted whole. Without suggestion pull requests it is refused, naming the setting, rather than split: the known limitation #30 allowed to be recorded ([status](status.md#open-questions-for-the-owner), question 5). Live evidence: [alternative fixes](alternative-fixes-e2e-evidence.md).

### Owner decision of September 30, 2026

### D45. Model diagnostics once and render them per audience — owner decision

**Provenance:** [issue #38](https://github.com/mike-north/sarif-to-comment/issues/38), the owner's decision of September 30, 2026. It supersedes [D13](#d13-diagnostics-are-markdown-repair-interfaces-remain-the-ordinary-inputs--settled).

Errors, warnings and notes are modelled once, as structured diagnostics with a severity, a stable kebab-case code, a one-line title, a Markdown message, and an optional location, subject and remedies. Every library outcome and every CLI document carries them in `diagnostics`, always present and ordered errors, then warnings, then notes. They are rendered per audience: `--format json` carries them verbatim under a versioned JSON Schema, `--format toon` encodes the same document as TOON for agents, the default `--format human` shows each as a colored block on stderr (chalk; `--color auto|always|never`, `NO_COLOR` and `FORCE_COLOR`), and the `markdown` fields and GitHub text are Markdown rendered from the same diagnostics. Codes are public once released and are catalogued, with severity, meaning and typical remedies, in [Diagnostics](diagnostics.md).

**Reason:** Agents need structured, stable facts rather than Markdown to parse, and people need a readable terminal view; one model keeps every rendering consistent.

**Consequences:** `problems` arrays and receipt warnings keep their fields and gain the diagnostic fields additively; `markdown` fields remain. Exit statuses and behavior are unchanged. Six unclear internal codes were renamed before their first release as public codes. R15's Markdown requirement is now one rendering among several.

**Owner decisions of the same day:** in human output, the diagnostic blocks on stderr are the single rendering of problems and warnings: `validate`, `publish` and `close-suggestion-prs` keep their outcome text on stdout without repeating them, while the library's `markdown` and the JSON and TOON `message` remain the full report. Color is decided by `--color`, then `FORCE_COLOR`, then `NO_COLOR`, then the terminal, keeping Node's rule that `FORCE_COLOR` overrides `NO_COLOR`.

### D46. Fall back as if suggestion pull requests were not allowed — owner decision

**September 30, 2026 update:** Narrowed by [D55](#d55-report-unavailable-explicit-delivery-requests-without-silently-substituting--owner-selected-direction). An explicitly requested delivery mechanism is a constraint: when it is unavailable, the tool reports the obstacle and exits with a non-zero status rather than substituting another mechanism, unless the caller explicitly authorized a fallback. This entry reads `allowSuggestionPullRequests` as a permission, not a request. Its fallback of a whole-file proposal to the review body, with a warning and exit status 0, is a substitution of the kind D55 bars for an explicit request. It remains acceptable only where suggestion pull requests are permitted rather than explicitly requested, or where the caller has authorized the fallback. Which caller settings count as an explicit request belongs to [D48](#d48-make-publication-policy-caller-controlled--accepted-product-direction-implementation-design-open)'s open policy design. The whole-review refusal of a group or a fix with several changes (`suggestion-group-pr-unavailable`) is consistent with D55 and with [D49](#d49-keep-each-supplied-group-available-for-collective-application-in-one-pr--owner-selected-direction-host-verification-open)'s rule never to split a group. The rewritten-history trigger depends on [D42](#d42-test-ancestry-when-the-originals-branch-has-moved--owner-decision)'s re-application rule, which D58 and D59 supersede as target direction. The fallback below remains the implemented behavior. The text below is kept as decided.

**Provenance:** [issue #37](https://github.com/mike-north/sarif-to-comment/issues/37), the owner's decision of September 30, 2026. It amends [D42](#d42-test-ancestry-when-the-originals-branch-has-moved--owner-decision) and builds on [D45](#d45-model-diagnostics-once-and-render-them-per-audience--owner-decision).

`allowSuggestionPullRequests` is read literally: use a suggestion pull request where one is needed and can be made; otherwise behave, for that change, exactly as if suggestion pull requests were not allowed. A whole-file creation or deletion whose suggestion pull request cannot be made (for example after a rewritten history, when it cannot be re-applied onto the head) falls back to the review-body proposal and the review publishes with a `suggestion-pr-fallback` warning naming the change and the reason; an explicit group or a fix with several changes whose suggestion pull request cannot be made refuses the whole review before any write (`suggestion-group-pr-unavailable`), naming the reason and the ways forward (review the current head again, or remove the group). `validate` reports the same outcome first. Every fallback is announced by a warning, and every warning of a published or ready outcome is stated in a headline under its heading, in `diagnostics`, and on stderr in human output; the exit status stays 0.

**Reason:** Publishing a group as prose after a force-push was an exception nobody chose (A30 refuses the same group when suggestion pull requests are disallowed), and a warning only at the end of the output was too quiet for people and invisible to scripts.

**Owner decision of the same day:** the fallback applies wherever a suggestion pull request cannot be made, not only after a rewritten history: an original from a fork (or whose head repository was deleted), one whose base is not the default branch, a created file over the suggestion pull request size limit, and a description over the body limit. If the review-body form cannot hold the change either, the review is refused exactly as without suggestion pull requests.

**Consequences:** The companion contract's §2.5.1 no longer has a "not created" presentation. `suggestion-pr-not-reapplied`, never released, is renamed `suggestion-pr-fallback`; the refusal is `suggestion-group-pr-unavailable`; `suggestion-pr-fork-unsupported`, `suggestion-pr-base-unsupported`, `suggestion-file-too-large` and `suggestion-body-too-large`, never released, are no longer reported.

### D47. Scope cleanup by who opened the suggestion, and bound its discovery — owner decisions

**Provenance:** [issue #44](https://github.com/mike-north/sarif-to-comment/issues/44), the owner's decisions of September 30, 2026, before 0.3.0. They settle the provisional items of the [suggestion cleanup contract](suggestion-cleanup-contract.md#4-decisions) and amend [D27](#d27-sweep-open-suggestion-prs-for-on-demand-cleanup--settled).

Accepted as implemented: cleanup closes by default and `--dry-run` previews; the exit codes are 0 / 2 / 3 / 1 for `complete` / `permission-limited` / `incomplete` / usage or operational failure; an HTTP 404 on close is `permission-limited`; and `--label` stays a migration override that skips the repository-configuration read.

New: `--owner me|all` (library `owner: 'me' | 'all'`, default `me`) scopes cleanup by who opened the **suggestion** pull request, not the original; a conforming suggestion someone else opened is `other-owner` and left open. `not-ours`, never released, is renamed `not-conforming`, and the outcome reports its counts. The default sweep discovers suggestions by the convention's branch prefix (`suggestion-pr/`, one paginated GraphQL listing of the branches with their open pull requests), and the canonical label becomes a confirming check rather than the search net. Every sweep counts its candidates in its first request and stops before evaluating anything above `--max-candidates` (default 500), with an error diagnostic stating the count, the limit and how to narrow; a label sweep whose first 20 pull requests show no suggestion marker and no `suggestion-pr/` branch stops with a `label-not-suggestion-prs` warning (exit 2), which `--force` overrides.

**Reason:** Wrong closes were already impossible; the risk was wasted API budget. Paging a label shared with hundreds of thousands of open pull requests could exhaust an account's rate limit and turn up nothing, and in a shared repository one person's cleanup should not close another's suggestions by default.

**Consequences:** A bad input costs one request before it is refused. A sweep's cost scales with suggestion branches, not with the repository. The REST labeled-issues listing is no longer used.

### Owner decisions of September 30, 2026: delivery policy and the force-push boundary

D48–D60 record the owner's later decisions of September 30, 2026 on caller-controlled delivery policy, groups and bundles, alternative families, delayed cleanup, explicit delivery failures, review continuity through companion references, the force-push boundary and Markdown presentation components. They were drafted as D34–D46; the [numbering note](#settled-force-push-boundary--september-30-2026) maps the drafted numbers to these. They set target direction. The contracts and [status](status.md) still describe the implemented behavior, and the earlier entries they affect carry dated update notes.

### D48. Make publication policy caller-controlled — accepted product direction; implementation design open

**Acceptance basis:** In voice discussion on September 30, 2026, the user described teams that want only native suggestions to avoid PR and notification noise, and teams that prefer companion PRs as mergeable proposals, including for agents reviewing agents. The user explicitly directed sensible defaults that configuration can override, with explicit CLI options overriding configuration, and clarified that a team may want everything in native suggestions or everything in companion PRs.

**Direction:** Publication-policy defaults must remain replaceable. For each configurable publication-policy choice, explicit CLI options take precedence over configuration, and configuration takes precedence over the default. A caller must be able to request native suggestions for all proposed changes, or companion PRs for all proposed changes; a native-first convenience default must not defeat the latter request. These are choices about delivering proposed changes, not a requirement to invent edits for findings without fixes.

**Reason:** Review and notification practices differ between projects. The tool's purpose is to help agents produce SARIF, derive proposed edits mechanically from staged changes, and faithfully translate that material into a GitHub review. A preferred acceptance experience is a product-policy choice, not automatically a consequence of SARIF semantics or GitHub mechanics.

**Further owner scenarios:** The user also described a native-first hybrid using companion PRs for changes that cannot be offered as applicable native suggestions, and a different hybrid using companion PRs only for whole-file additions/deletions while keeping groups of ordinary edits as native suggestions. For the latter, the desired experience makes group membership visible, lists the members, and provides direct navigation between suggestion comments so the author can add every member to a GitHub batch. These scenarios establish the need to separate operation-based delivery choices from group representation; they do not select a default or prove that pending-comment links and edited suggestions work on GitHub. The tool communicates the apply-together relationship; that navigation alone does not enforce it.

**Scope and open design:** This accepts caller control and precedence, not option names, configuration locations, a new default, companion-PR cardinality, or a release commitment. D55 settles an unavailable explicitly requested form: report the problem and exit cleanly without silently substituting another mechanism. The request does not prove GitHub supports that representation. Group membership and apply-together relationships remain distinct from enforced all-or-none application. Cross-linked native suggestions remain a candidate whose pending-comment mechanics require verification. No policy implementation is authorized by this record alone.

**Examples for subsequent validation:** A configured native-suggestions preference with an explicit companion-PR CLI choice must resolve to the explicit choice. With no configuration, an explicit native-suggestions CLI choice must resolve to that choice. With neither supplied, a documented default applies. When the chosen representation is unavailable, validation must assess the separately accepted fallback policy rather than assume a substitution is authorized.

**Supersession:** D22's native-first restriction is superseded as target product direction. The earlier native-first versus companion-first proposal is not reinstated wholesale. Existing implementation and published releases are not evidence that this new direction has already been delivered. Unrelated contracts and the release hold remain in place.

**Implemented September 30, 2026 (unreleased):** the [delivery policy contract](delivery-policy-contract.md) implements caller control and precedence: the `--delivery`, `--edits`, `--grouped-edits`, `--file-operations` and `--companion-bundle` options and the library's `delivery` option override `.github/sarif-to-comment.json` on the default branch, which overrides the documented defaults (§5–§7, §11, §12), and either all-native or all-companion delivery can be requested.

### D49. Keep each supplied group available for collective application in one PR — owner-selected direction; host verification open

**Acceptance basis:** Later in the same September 30 voice discussion, the user specified that a group means do not apply its members except as a collective unit: all members must be available for application in a single commit. The user explicitly allowed either a batch of suggestions on the original PR or one companion PR, and prohibited splitting a group between those destinations or across multiple companion PRs. If splitting is desired, the user must deliberately break the group and thereby change the supplied intent; the tool must not infer that splitting is safe.

**Direction:** Preserve each supplied group's complete membership within one PR context. Its proposed changes may all be offered as batchable native suggestions on the original PR, or all be contained in one companion PR. Caller-controlled delivery policy selects between eligible forms without partitioning the group. This establishes collective-application availability, not enforced human acceptance or semantic correctness. Group member lists and navigation communicate the relationship but do not alone establish batch applicability.

**Conflict ownership, clarified by the user:** If intended members conflict, the upstream creator of the group must resolve that conflict. The tool reports the mechanical obstacle and preserves the complete intended membership; it must not publish two applicable members out of a three-member group as a valid substitute or choose the intended resolution on the creator's behalf. This is an obligation to honor the supplied collective unit, regardless of whether a test suite would detect an incomplete application. It does not certify that applying the complete group makes tests pass or decide the scope of a review-level refusal.

**Manual route, subsequently confirmed:** Asked whether a mixed group kept on the original PR can qualify through manually assembling all its changes locally and committing once, the user answered that mixed groups are fine. The complete proposal may therefore remain on the original PR with manual file-operation content and instructions; collective availability does not require every member to participate in GitHub's native suggestion batch. Applying only the native members first and the whole-file operations later would still violate the stated group intent. The representation must make the complete membership and collective workflow understandable.

**Scope:** The rule applies to an explicitly supplied group of proposed changes; it does not redefine SARIF's alternative remedies for one result as members to apply together. Requiring one destination per group does not require one companion PR per group: whether multiple complete groups share a PR remains a delivery-policy design question. No specific regrouping interface, configuration or CLI syntax is selected.

**Open host and failure questions:** Verify that each offered group can actually be applied collectively in one commit through its chosen host workflow. Co-location in a PR is necessary but insufficient evidence of this property. If the chosen form cannot offer every member for collective application, do not silently split the group. D55 requires reporting the obstacle and exiting cleanly when an explicitly requested delivery mechanism is unavailable; another representation requires caller authorization. Pending-comment discovery, body editing, navigation links, suggestion applicability and partial-publication recovery remain unverified for the linked-suggestion candidate.

**Validation examples:** A group of two edits offered natively must retain both in the original PR and support their collective application; a companion representation must contain both in the same companion PR. Offering one edit natively and the other in a companion PR, or one edit in each of two companion PRs, violates the rule. An explicit user-authored regrouping changes the input relationship; mere convenience or a delivery preference does not authorize the tool to perform that regrouping.

**Supersession and delivery:** This settles the reopened group-containment direction after D48, without reinstating the earlier rule that groups require companion PRs or a promise of enforced all-or-none acceptance. It is accepted intent for design discussion, not evidence of implementation, authorization to begin execution, or a release decision.

**Implemented September 30, 2026 (unreleased):** a group is delivered whole by one mechanism and never split: as a native batch (an explicit group or a fix with several changes, every change a native suggestion, with guidance listing every change by path and line), as one companion pull request, or, on the original pull request, as one review-body section holding every member's exact replacement or file proposal, with guidance to make them by hand and commit them once, which claims no enforcement ([delivery policy contract](delivery-policy-contract.md) §8.3, §8.4, §8.8, §8.10, §15). The manual group of edits is used only when listed (§8.4).

### D50. Use one delivery setting for whole-file additions and deletions — owner-selected direction

**Acceptance basis:** Continuing the September 30 voice discussion, the user selected one setting for file additions and deletions rather than separate delivery settings. Both ask the author to perform a file operation outside native suggestion application, or offer the operation through a companion PR whose merge incorporates it. Different instructions for creating and deleting files do not justify separate policy choices.

**Direction:** Treat whole-file additions and deletions as one delivery-policy category. The shared choice is between companion-PR delivery and a manual file-operation presentation, performed locally or through supported GitHub UI. Operation-specific content and instructions remain distinct: creation supplies the proposed file contents and destination; deletion identifies the intended file removal. One policy choice does not erase those different operation semantics.

**Reason:** The meaningful consumer choice is the acceptance workflow: a mergeable proposal versus personally performing the file operation. Independently configuring additions and deletions would add flexibility the user does not find useful for this model.

**Scope and validation:** This selects a common policy dimension, not a default, option name, configuration schema, PR cardinality, or host-action link guarantee. A shared companion-PR choice applies to both additions and deletions; a shared manual choice applies to both. D49's collective-application requirement still applies when a file operation belongs to a group. D51 subsequently selects destination precedence for that mixed group; the user confirmed that manual/local collective assembly qualifies. Host-specific presentation, action links and batch mechanics still require validation where used.

**Implemented September 30, 2026 (unreleased):** `fileOperations` is the one setting for whole-file creations and deletions, delivered as `manual` or `companion` ([delivery policy contract](delivery-policy-contract.md) §2, §3, §8.5).

### D51. Propagate whole-file delivery over its explicit group — owner-selected precedence

**Acceptance basis:** The user first proposed that, when ordinary edits are grouped with an addition or deletion, all members follow the whole-file operation's delivery choice, irrespective of whether those ordinary edits fit native suggestions, and requested scrutiny. The user then expressly distinguished honoring a group as a correctness constraint from preferring native suggestions as a presentation preference: do not break a group. An explicit choice to put a whole-file operation in a companion PR carries its other group members into that PR. This is correctness of honoring supplied intent, not a claim that the tool certifies the code or independently proves the group's semantic dependency.

**Accepted precedence:** Resolve the common whole-file-operation delivery choice, then preserve every member of a group containing such an operation at that destination. Do not route the ordinary members separately according to a generic native-suggestion preference. A common setting for additions and deletions does not itself group otherwise unrelated operations. The user's control includes changing the supplied grouping explicitly; a preference for native suggestions is not itself permission to split it. Exact interactions between general CLI presets and more specific configuration choices remain part of the configuration design; this does not select flag syntax.

**Example:** A new helper file and two edits that call it are explicitly grouped. If whole-file operations are selected for companion-PR delivery, all three proposed changes belong in one companion PR even when the two ordinary edits are eligible as native suggestions. An unrelated ungrouped edit retains its own delivery policy; the setting does not pull all review findings into that companion PR.

**No-companion workflow, confirmed by the user:** Users must remain able to select a workflow that creates no companion PRs. Selecting original-PR/manual delivery for whole-file operations prevents those operations from pulling their groups into companion PRs; native-suggestion preferences for other edits remain caller-controlled. A grouping constraint does not authorize creating a companion PR contrary to that selected workflow. The user subsequently confirmed that manually assembling a complete mixed group locally and committing once qualifies under D49.

**Independent conceptual scrutiny:** The precedence is coherent with retaining complete groups. The unresolved definition is what counts as collective-application availability when the group stays on the original PR but includes manual file operations. GitHub documents a suggestion batch creating one commit; that documentation does not establish inclusion of manually presented whole-file operations in the batch. A new helper file plus ordinary edits calling it illustrates the distinction: applying the ordinary edits in one commit and adding the helper later violates the collective unit. Keeping all content in the original PR does not alone prove a native collective workflow. Source: [GitHub's suggestion workflow](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/incorporating-feedback-in-your-pull-request).

**Resolved definition:** The user accepted manual/local assembly of the complete mixed group into one commit. A host-native collective application action is therefore not required for every permitted representation. This acceptance does not verify pending-comment mechanics or authorize a host experiment, implementation, default or release change.

**Implemented September 30, 2026 (unreleased):** a group containing a whole-file operation follows `fileOperations` as a whole, so `companion` carries every member into one companion pull request, and `manual`, the default, keeps every member on the original pull request as the mixed manual group: one review-body section with the edits' exact replacements, the creations and deletions as their file-operation sections, and guidance to assemble the whole group locally and commit it once ([delivery policy contract](delivery-policy-contract.md) §8.5, §8.8, §8.10, §15).

### D52. Organize companion PRs around caller-selected acceptance choices — owner scenarios; representation design open

**Source:** After confirming the mixed manual route, the user described companion-PR organizations serving different acceptance experiences: one PR per fix group for separate merge choices; a convenient PR containing several complete, high-confidence/noncontroversial groups; and separate optional or subjective ideas, including alternative proposals for one gap where at most one or none is expected to be accepted.

**Distinction for design:** A supplied fix group is the collective application unit under D49. A companion-PR bundle is a delivery and acceptance choice that may contain one or several complete groups. Bundling must not split an existing fix group or erase its identity. Sharing a PR does not prove the groups are semantically dependent; putting groups into separate PRs does not prove independent correctness.

**Scenarios to support:** The caller can keep complete groups separately selectable, bundle routine corrections for one convenient merge, and separate optional proposals from those routine corrections. Explicit competing alternatives must remain separate acceptance choices rather than be silently combined as cumulative changes. The tool does not infer confidence, controversy, dependency, or which alternative the author should accept from patch shape or the fact that separate PRs exist. Confidence explains the caller's intended organization; no confidence field or automatic classifier is selected.

**Open design:** The representation of bundle membership and alternative relationships, automatic organization policies, defaults, PR counts/limits and any CLI or library surface remain unspecified. These examples are product inputs for subsequent design, not authorization to publish every SARIF alternative or begin implementation. Tests and validation must distinguish complete-group preservation from faithful preservation of the caller's separate acceptance choices.

**Independent conceptual review:** The separate bundle concept is justified by the caller's acceptance choices. Bundling couples several complete groups into one convenient merge decision; it does not prove they depend on one another. Explicit choose-one alternatives must remain separately selectable, and cannot be combined into a bundle offered for wholesale acceptance unless a particular alternative has first been selected. Whether separate PRs are compatible or safely mergeable in any order remains upstream information or unknown.

**Partly implemented September 30, 2026 (unreleased):** `companionBundle` packages companion-delivered units `per-unit` or as one `single` bundle, each unit its own section and no group split; alternative families and other organizations remain open ([delivery policy contract](delivery-policy-contract.md) §9).

### D53. Offer alternative remedies as a related family of companion PRs — owner scenario; cleanup mechanism unverified

**Source:** The user described a complicated finding with two or three possible fixes, represented as a related family of suggestion PRs. Each member is an alternative remedy; accepting one is intended to leave the others unaccepted. The user proposed closing-keyword references in each PR body so that merging one would close its siblings. This is a proposed mechanism, not verified host behavior or new implementation authority.

**Representation basis:** SARIF permits multiple proposed fix objects for one result (§3.27.30); each fix describes a proposed remedy that can change multiple artifacts (§3.55). This supports the source shape for a family of candidate remedies. Treating explicitly supplied alternatives as separate acceptance choices remains distinct from bundling groups that must be applied together. Source: [SARIF 2.1.0 specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html).

**Host documentation and recovered experimental evidence:** GitHub documents automatic closure by keyword references, including PR-to-PR references, in the context of a referencing PR targeting the repository's default branch, and states that description keywords are ignored when targeting another branch. The user challenged the initial conclusion drawn from that documentation, pointing to the earlier live lifecycle experiment. A bounded read-only recovery confirms that merging original PR #5 into `main`, with `Closes #6` in its body, closed companion #6 without merging it. Closing original #7 without merging left referenced companion #8 open in immediate and later readbacks. The body text is preserved in the written experiment report; raw snapshots preserve branch identities and resulting states but not the bodies. That experiment's referencing PRs targeted the default branch. It explicitly did not test non-default merge targets or a companion PR closing sibling alternatives. Sources: [saved lifecycle experiment](companion-pr-lifecycle-experiment.md) and [GitHub's linking and closing-keyword documentation](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue).

**Current evidence boundary:** Automatic PR-to-PR closure on merge is established for the original-to-companion/default-branch case. Sibling closure when a companion is merged into the original feature branch is unverified by the saved experiments. The documentation raises a target-branch restriction to check; it is not a live observation of that new case. Do not rule the proposed mechanism out as experimentally disproved or promise it works. No new live experiment or host write was performed during this discussion.

**Scope still open:** Family identifiers, cross-references, how the caller supplies/selects alternatives, and sibling-cleanup behavior need design. An explicit cleanup action may be considered separately from a continuously observing lifecycle service. D29's initial-publication scope and existing bounded cleanup authority are not expanded by this scenario. Do not claim automatic sibling closure, change PR targets to obtain it, or add a monitoring service as an inferred requirement.

### D54. Delay optional abandonment cleanup and recheck the original — owner-selected candidate policy; workflow experiment pending

**Source and purpose:** The user proposed an optional GitHub Action invoking existing companion cleanup when an original PR closes without merging. The user then selected a two-minute grace period before cleanup, followed by a fresh read of the original PR. This avoids treating a brief accidental close/reopen, or a close/reopen used to retrigger CI, as abandonment.

**Selected behavior:** On the abandonment event, wait two minutes, then confirm the exact original PR is still closed and unmerged before proceeding. Closed alone is insufficient because merged PRs are also closed. Use the established companion identity/relationship rules; merely targeting the same branch does not establish that a PR is a managed suggestion. Invoke existing cleanup rather than independently redefining companion discovery.

**Accepted tradeoff:** Reopening much later may require manually reopening companions already closed by cleanup. This is a grace period and fresh-state check, not a guarantee that reopening can never race with cleanup. The delay does not authorize deleting branches or recreating/reopening proposals automatically.

**Evidence and open implementation:** GH-02 in the [behavior register](github-behavior.md#gh-02--closing-the-original-without-merging-left-its-companion-open) establishes that the tested abandoned original left its companion open. GitHub advertises `closed` PR events and an event payload merge flag; this documents a feasible trigger, not a tested workflow. Source: [Actions event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request). Workflow event choice, trusted-code execution, token permissions, fork scope, repeat-run behavior and a bounded positive/negative experiment remain design work. No workflow has been installed, run or authorized for execution during this discussion.

### D55. Report unavailable explicit delivery requests without silently substituting — owner-selected direction

**Acceptance basis:** Closing the delivery-policy discussion on September 30, 2026, the user confirmed that clear intent to use a particular delivery mechanism must be honored. If that mechanism is unavailable, switching to another would be surprising; report the problem and exit cleanly.

**Direction:** An explicitly requested delivery mechanism is a constraint, not merely a preference the tool may override. When it cannot deliver the intended proposal through that mechanism, explain the obstacle and exit cleanly with a non-zero CLI status, as the user explicitly clarified. The library must likewise expose failure rather than success; its exact outcome shape remains interface design. Do not create companion PRs, substitute manual instructions, or change to native suggestions contrary to that explicit request. Any fallback requires explicit caller authorization and must preserve complete groups and the caller's acceptance choices.

**Scope and remaining work:** This settles the failure-policy boundary for the preceding delivery discussion. It does not choose defaults, option syntax, diagnostic codes, or a fallback configuration interface. Whole-review validation and publication recovery still govern their respective stages; this decision does not promise rollback of already-created remote artifacts. Host verification and implementation remain pending. The product discussion can now proceed to moving-head and force-push behavior without treating those engineering tasks as new owner-policy questions.

**Implemented September 30, 2026 (unreleased):** a unit is delivered only by a mechanism its list names; when none is available the publication is blocked before any write with `delivery-unavailable` (exit 2), and a fallback happens only in the order a list authorizes, announced with `delivery-fallback` ([delivery policy contract](delivery-policy-contract.md) §8.1, §10).

### D56. Make each review an explicit index of its companion proposals — owner-selected scope extension

**Acceptance basis:** On September 30, 2026, the user proposed a bounded way to support the author/reviewer back-and-forth: the review body references every companion PR created for that review. An upstream agent can find its most recent review and follow those references to recover the proposals belonging to that review. The agent may update continuing companion proposals and publish a new review that references those same PRs.

**Direction:** Include explicit, usable companion-PR references in the review body for every companion created as part of that publication. A subsequent review can also reference caller-selected existing companions; referencing an existing companion does not mean creating another copy. The body records which companion proposals belong to this particular review, including continuing proposals the caller elects to reuse, rather than requiring inference from repository-wide labels, branch targets or the latest creation time. The caller owns that selection; the publisher does not automatically carry forward every older proposal.

**Responsibility boundary:** The upstream reviewer or agent reads prior feedback and proposal state, assesses the author's response, decides whether proposals remain relevant, and performs any authorized companion changes. This tool faithfully publishes the next supplied review and its explicit proposal references. Successive reviews remain independent publication artifacts while their selected companion references preserve continuity. D21's original-to-companions discovery remains useful for bounded cleanup; it does not by itself identify membership in a specific review wave.

**Continuing proposal content, confirmed by the user:** The companion PR's conceptual content is what matters to this relationship. Contributors with permission to push are responsible for maintaining that continuing proposal. This tool need not freeze or snapshot its contents separately for each review wave. Repository permissions, review requirements and the host's history remain external; no universal rule that a push requires a new approval is assumed.

**Revision proliferation rejected:** The user explicitly rejected creating an independent replacement companion PR for each revision, with chains of closing references or similar maintenance guarantees, because the burden and PR clutter are not worthwhile. Maintain a continuing proposal in its existing companion rather than having the publisher automatically manufacture a new PR generation. This does not prohibit D53's deliberately supplied competing alternatives or a genuinely different proposal.

**Moving-head implication:** After a force push or substantial new changes, an upstream agent or other system can make another pass using readable existing feedback and companion proposals, determine what remains relevant, and publish a new independent review. It may retain earlier feedback or explicitly reuse selected companions. This places semantic reassessment and proposal maintenance upstream rather than requiring an automatic force-push reconciliation service in the publisher. A displayed status alone does not decide whether the substantive concern is addressed. Exact historical placement eligibility, interrupted publication and remaining companion-creation behavior still need separate decisions; they are not settled by this continuity model.

**Completion and remaining design:** Complete delivery includes the review's references to the companions actually created or explicitly reused. Creation of some remote objects does not alone establish that the final review index is complete; recovery must preserve their identities and finish or report incomplete delivery. Exact input representation, link formatting and publication ordering remain design work. This decision does not authorize implementation, automatic proposal updates, thread management or a monitoring service.

**Implemented October 1, 2026 (unreleased).** The review body begins with a companion index ([companion contract §2.13](companion-suggestion-pr-contract.md#213-the-companion-index-and-existing-companions)): every suggestion pull request the publication creates, then every existing one the caller names in `existingCompanions` / `--existing-companion N`, each with its number, link, title and whether it was created or reused. The caller's selection is the only source of reused proposals: an existing one is read once, before any write, and must be a suggestion pull request of this original under the convention, or the review is blocked (`companion-not-reusable`); its state is reported in a `companion-reused` note and never enforced. The selection is part of the publication identity, the index is recorded in the plan and rendered from it, a recovered review carries the identical body, and a retry reads nothing again. A created suggestion pull request keeps its own section as well. The index is not customizable, because it names numbers that exist only after every presentation callback has run. The details are listed for the owner in the contract's §4, item 9. Live verification: [`evidence/companion-index/`](evidence/companion-index/README.md).

### D57. Leave conversation-resolution enforcement to repository policy — owner-selected responsibility boundary

**Acceptance basis:** The user described ordinary human review: feedback can become outdated or collapsed after new commits while its substantive concern remains valuable; the reviewer follows up with the author. Teams wanting a merge gate can require conversation resolution through GitHub's repository settings.

**Direction:** Do not make the publisher maintain visibility, regenerate feedback, resolve discussions automatically, or enforce a separate merge gate merely because code changes can collapse earlier comments. The reviewer or upstream system owns substantive follow-up. Repository policy owns any requirement to resolve conversations before merge. A resolved state records a workflow action; this tool does not treat it as an independent proof of code correctness.

**Documented host capability:** GitHub documents a branch-protection setting named **Require conversation resolution before merging**, requiring PR conversations to be resolved before merging into a protected branch. Source: [GitHub branch-protection documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-conversation-resolution-before-merging), checked September 30, 2026. This is advertised behavior, not a new live experiment, and does not establish that any particular repository has enabled it or lacks bypass permissions. No repository setting was changed.

### D58. Do not abort historical review publication merely because the PR branch changes — owner-selected force-push direction

**Acceptance basis:** The user rejected aborting publication when the branch changes: the review still concerns a commit that is, or previously was, part of the destination pull request. This answers the proposed stopping rule for branch movement itself; that proposal is not accepted policy.

**Direction:** A forward push or force push does not by itself invalidate the review or require aborting its initial publication or resumption. Preserve the explicitly reviewed commit and publish feedback about that snapshot rather than silently retargeting it to the new head. The reviewed commit must be associated with this PR, currently or historically; this is not permission to treat any repository commit as reviewed PR history. Loss of current ancestry alone is not a semantic reason to discard the feedback.

**Distinct delivery questions:** Determine whether the requested host representation can faithfully publish that historical feedback; historical inline and native-suggestion eligibility still require the bounded experiments. If a mechanism is genuinely unavailable, D55 governs failure or explicitly authorized fallback. Branch inequality alone must not stand in for demonstrated unavailability. This direction does not authorize automatic re-analysis, reapplication/rebasing of proposals, or creation of a companion that includes unintended changes. Existing companion identity and supplied intended content remain relevant to faithful delivery; whether new companion construction preserves that content is distinct from whether the historical review is valid.

**Recovery and scope:** Resumption still establishes which intended objects exist before creating missing ones, retaining their publication identities. Neither a changed branch nor an uncertain response authorizes duplicate creation. This records target behavior for design and verification, not a claim that current code or GitHub supports every historical presentation. No implementation, host experiment or release advancement follows automatically.

**October 1, 2026 implementation note.** Three parts of this direction are implemented, unreleased, from the host evidence GH-16 and GH-19: findings are placed inline at the reviewed commit against the reviewed diff, from the pull request's diff base to that commit, whether it is the head, an ancestor of it or discarded; a native suggestion there is offered whenever its inline anchor is valid, with GitHub left to refuse applying it on lines the head changed; and the reviewed commit must be associated with the pull request, through its head or a head a force-push replaced, before anything is written. The contract is [specification R13.1](specification.md#r131-the-reviewed-diff-historical-placement-and-native-suggestions) and [R17](specification.md#r17-publish-only-about-a-commit-of-the-pull-request); `suggestion-reviewed-commit-not-head` is retired. Removing re-application and checking a new companion's fidelity (D59) remain pending.

**October 1, 2026 implementation note, later the same day.** The rest is implemented, unreleased. No proposal is re-applied or rebased onto a later commit: every suggestion pull request is proposed on the reviewed commit, whether the branch moved forward or was rewritten ([companion contract §2.5](companion-suggestion-pr-contract.md#25-repository-target-branch-and-revision), [convention §5.1](suggestion-pr-convention.md#51-when-the-originals-branch-has-moved-since-the-review)). Plans and markers written by the unreleased re-application stay readable. A changed branch is still not a reason to abort, and a retry still creates what was planned and reports what changed (§2.10).

### D59. Treat force-push review lifecycle as host behavior, not a new publisher service — owner-selected boundary

**Acceptance basis:** The user challenged repeated framing of a normal force push as a problem this project must solve. GitHub retains the review in the PR experience, and teams can require conversation resolution; the reviewer or upstream system follows up on the concern. D58 already rejects branch movement as an automatic publication abort reason.

**Direction:** Do not introduce a force-push lifecycle or recovery service to keep old feedback visible, reinstate collapsed feedback, manage resolution, or manufacture replacement review/proposal generations. The publisher's responsibility is faithful delivery of supplied feedback about its explicitly reviewed commit, with D56's explicit companion references and ordinary delivery recovery. A force push does not itself create a new responsibility beyond that boundary.

**Verification that still belongs here:** Establish the actual support envelope for newly publishing historical inline feedback and native suggestions, preserving exact source association and intended edits. These are adapter/presentation capability checks, not a reason to infer that existing reviews disappear or require maintenance. A newly constructed companion must likewise present the intended proposal rather than unintentionally include discarded unrelated changes; investigate any concrete fidelity failure as such, rather than using branch movement as a blanket blocker. Existing experiments and their scope limits remain evidence; no new historical-inline result is claimed by this decision.

**October 1, 2026 implementation note.** The fidelity check of a new companion is implemented, unreleased, as a **projection** ([companion contract §2.5.1](companion-suggestion-pr-contract.md#251-fidelity-after-a-rewritten-history)). Its authority is this decision, D55, D58 and the boundary's fourth bullet; its rules follow a bounded assessment of 15 local scenarios of rewritten history. When the reviewed commit is not an ancestor of the head, the tool projects, before creating each companion, what merging it into the head would do. The projection is per path, three-way, over GitHub's full trees and only the blobs a line merge needs, with a merge that follows Git's own. The companion is faithful when diff(head, merge) is exactly its own changes. A faithful companion is created on the reviewed commit. One projected to conflict, and nothing worse, is created with a `companion-conflicts-at-head` warning, and GitHub's `mergeable` is read back as an observation. Any other outcome makes `companion` unavailable for its unit, under D55: discarded content brought back, part of the proposal lost, a proposal that cannot be expressed at the head, or a case the projection cannot decide. Nothing refuses a companion on ancestry alone. The projection is recorded in the plan, and a retry never repeats it. The live verification is in [`evidence/companion-fidelity/`](evidence/companion-fidelity/README.md).

### D60. Use reusable Markdown components for a rich GitHub review experience — owner-selected presentation direction

**Acceptance basis:** The user selected a concept analogous to GitHub UI components, implemented as reusable Markdown templates for GitHub surfaces that support their formatting. Explicit examples include presenting a proposed new file, indicating a proposed file deletion, communicating that related native suggestions must be applied together despite not being in a companion PR, listing a review's companion PRs, and displaying attribution from SARIF tool/component metadata. The user also requested systematized GitHub URL building and emphasized template customization, especially for library users. Markdown-returning callbacks and a templating system suitable for repository configuration were offered as alternative implementation approaches, not a selected engine.

**Direction:** Compose review presentation from reusable components with consistent formatting and clear semantic purposes. A file-addition component communicates the destination and proposed contents; a file-deletion component communicates the intended removal. These are ordinary Markdown outputs, not a requirement for a browser UI framework or a second public review format. Other repeated review elements can use the same presentation approach when their purposes are established.

**Established presentation purposes:** Grouped-suggestion presentation communicates complete membership and collective application, with navigation to related suggestion comments where supported. The companion-list component explicitly identifies the proposals associated with this review under D56. Attribution components can display supplied producer tool/component identities so readers understand that multiple contributors' feedback may be published by one GitHub account. This producer attribution is distinct from the authenticated GitHub publisher; do not infer a different GitHub author or invent contributor identities. SARIF producer components and Markdown presentation components are different concepts despite sharing the word component.

**Reusable links:** Systematize construction of links to PRs, reviews and individual review comments so components use a consistent approach rather than independently assembling URLs. Component contexts should receive the appropriate established object references and links. Exact helper contracts, supported destination variants and link verification remain design work; this does not make guessed object IDs or unverified routes valid.

**Customization:** Design for library callers to customize or replace these presentations. A callback returning Markdown can satisfy that interface; a named templating system is not required. Consider repository-level configuration when selecting the eventual mechanism, without prematurely adopting a template language or configuration schema. Sensible built-in presentations remain available. Custom formatting does not authorize dropping required provenance, complete-group meaning, source association or publication identity; the core must preserve the existing marker/recovery contract irrespective of template choice. Exact ownership and enforcement boundaries remain implementation design.

**Template execution constraint, explicitly selected by the user:** Templates MUST NOT enable arbitrary code execution. The user explicitly corrected the broader phrase "must not execute code": normal template rendering and constrained rendering helpers are not prohibited. Do not select a template engine that permits arbitrary JavaScript execution from template content; the user named Lodash's template function and EJS as excluded examples, and Handlebars or Mustache as acceptable kinds of declarative templating. Those examples identify candidate approaches, not a selected engine or proof that every configuration is safe. Repository/configuration templates must be declarative inputs rather than arbitrary executable programs. Template customization must not evaluate template text as arbitrary JavaScript or implicitly load repository-supplied executable helpers. Reviewing a repository must not implicitly authorize its configuration to execute arbitrary code in the reviewer's environment. This constraint does not retract the separately permitted programmatic callback supplied explicitly by a library caller in its own application code; do not use that API as a way to turn repository template data into arbitrary executable code. No engine has been selected or verified.

**Permitted compilation, clarified by the user:** A declarative template may compile into a function. The relevant boundary is what template content can cause that function to do: present the supplied data, without gaining authority to import third-party libraries, initiate network requests or perform arbitrary operations. These constraints govern template-driven execution; the publisher's ordinary GitHub operations and explicitly supplied application callbacks are separate responsibilities. Compilation alone is not evidence that a candidate satisfies this boundary.

**Markdown compatibility, additionally required by the user:** Select a mechanism whose interpolation delimiters coexist naturally with Markdown syntax. Ordinary static Markdown should not need awkward template-specific escaping, and value interpolation must preserve the intended formatting and content. Evaluate delimiter collisions and interpolated-value handling separately using representative review content, including links, lists, tables, inline code, fenced file contents and literal template-like examples. Code contents must retain their intended characters; one generic escaping rule must not silently change them. Exact context-sensitive rendering and literal-delimiter treatment remain engineering design, subject to the existing fidelity and native-suggestion constraints. No candidate has been verified against these cases yet.

**Responsibility boundary:** Components express the supplied feedback, operation, relationships and caller-selected workflow. They do not independently choose remedies, infer grouping, select delivery destinations, or manage review lifecycle. Presentation reuse must preserve distinct addition, deletion, existing-file edit and alternative-remedy meanings. GitHub-surface capability limits and exact native-suggestion fidelity still govern what a component can faithfully offer.

**Remaining design:** Component contracts, naming, composition, precise appearance, customization hooks/configuration and supported surfaces remain design work. Treat the examples as intended consumer experiences, not proof of GitHub rendering or application. Ordinary upstream SARIF remains first-class; adopting these rendering components must not require helper initialization or helper-only metadata. No component implementation or new host experiment was started by this decision.

## Current concepts

| Concept | Role |
|---|---|
| Feedback item | An explanation with origin and relevant source associations; it need not propose a change. |
| Proposed change | An intended repository change, supplied in SARIF or derived during preparation. |
| Review context | The reviewed revision and intended destination needed to interpret source and host eligibility. |
| Prepared review artifact | The complete input to whole-review publication assessment. |
| Rendered comment or suggestion | A host presentation derived from feedback, changes, context, and policy. |
| Exception report | An explanation of unresolved obstacles and where ordinary inputs need repair. |
| Publication identity | The persisted identity used to recover an uncertain remote creation. |

Awaiting approval is state on feedback, not a separate approval product. A native suggestion is one presentation of a proposed change, not the definition of a proposed change.

## Assumption ledger

| Assumption | Status |
|---|---|
| Feedback can have dependencies the converter does not know. | Load-bearing scope premise; D7 and D12. |
| Publication must preserve meaning and source context. | Load-bearing product requirement; P1. |
| The staging area expresses intended changes in the main extraction workflow. | Chosen workflow; semantic mistakes still require proofreading. |
| Every staged change must become a native suggestion. | Removed; D6. |
| Every feedback item requires a separate comment. | Removed; D4. |
| Every item needs positive approval metadata. | Removed; D11. |
| Best effort means retaining only valid items. | Removed; D9. |
| All intermediate SARIF must already match the host's native presentation. | Removed; D1, D3, and D6. |
| A clean mechanical merge proves correctness. | Rejected; D7. |

## Stress cases

These are design reasoning checks, not executed software tests.

| Scenario | Current model outcome | Remaining uncertainty |
|---|---|---|
| Commodity linter SARIF without approval metadata | Normal validation and publication; no metadata tax. | Exact supported input policy. |
| Two findings concern one staged replacement | Preserve both explanations and origins with one suggestion. | Detailed association rules. |
| An intentional new regression-test file | Render an explicit addition proposal. | Exact SARIF encoding and host presentation. |
| A staged private notes file is accidentally included | Present faithfully; upstream proofreading catches the inappropriate proposal. | Proofreading experience is external. |
| An obsolete test file is proposed for deletion | Render explicit deletion with rationale and source association. | Exact encoding and host presentation. |
| Two ready items and one awaiting approval | Hold the entire review unless the explicit override is used. | Exact metadata convention. |
| Valid finding outside native inline placement | Apply caller policy; a referenced general comment can be valid. | Host eligibility matrix and defaults. |
| Conflicting independently supplied fixes | Preserve evidence and report unresolved mechanical conflict. | Optional automatic Git reconciliation. |
| Failed preparation after a successful earlier run | Archive prior normal output; leave no normal success filename. | Timestamp edge cases. |
| GitHub creates a review but the response is lost | Recover using the saved publication marker before retrying. | Live verification and multi-operation recovery. |

The earlier worked example used a newly staged notes file as an automatic blocker. That example is obsolete under D6. It needs a genuine mechanical failure or an explicit approval hold to exercise the failure path.

The user supplied a concrete addition scenario for the representation walkthrough: a PR introduces functionality without documentation; the reviewing colleague has an agent draft and stage the missing page, then recommends that the author add it. This grounds D6 in a documentation proposal. The missing page's destination is distinct from the source location associated with the finding. The [product brief](product-brief.md#user-supplied-walkthrough-recommend-a-missing-documentation-page) records the scenario and the still-open encoding question.

## Discarded models

| Former model | What displaced it |
|---|---|
| New staged files are always unsupported errors. | Legitimate addition proposals can be ordinary review feedback. |
| Additions and deletions require their own confirmation flow. | General proofreading covers inappropriate proposals of every kind. |
| Approval metadata is mandatory for all input. | Commodity SARIF interoperability; explicit holds opt into the workflow. |
| Best effort publishes or emits only the successful subset. | Repair needs flawed evidence; publication requires the complete artifact. |
| Source feedback must never change presentation location. | Semantic source association can survive a referenced general comment. |
| The primary path must solve independent agent-fix conflicts. | Agents can share one reconciled staged repository state. |
| A separate agent repair protocol is necessary. | Correct ordinary inputs and rerun the same operation. |

## Open questions, constrained by the decisions above

1. What exact SARIF convention represents an approval hold? D11 settles the default and external ownership, but not the schema. The user agreed that source advancing is separate from editing feedback: D15 preserves the reviewed commit instead of silently retargeting. The user then challenged how an edit differs from receiving a new SARIF input and explicitly concluded that the editing-history question is moot. The publisher receives an artifact with declared state and honors that state. The earlier automatic reapproval proposal implicitly introduced change tracking and is withdrawn as a publisher requirement.
2. How are whole-file addition and deletion intentions preserved in SARIF and rendered without losing their operation semantics? D6 settles validity, not encoding.
3. Which host eligibility cases are supported and how does caller policy select general versus inline presentation? D3 fixes the separation of responsibilities.
4. How do retries and recovery behave for each publication mode? D16 makes pending versus submitted publication caller-configurable. D12 requires whole-review readiness in either mode; D14 provides a recovery approach but not a complete transactional design.
5. What are the remaining file-archival and error-artifact lifecycle rules? D10 fixes preservation and success-path safety.

Before introducing another question, connect it to the relevant principle and prior decision. If the answer is already a consequence, state that implication first rather than asking the user to reconstruct it. Keep genuinely new policy choices separate from settled scope, and update superseded entries when the model changes.
