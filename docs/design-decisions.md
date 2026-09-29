# SARIF review publication: principles and decisions

> **Status note (reconciled September 28, 2026).** This log remains the authoritative decision record. Its statement that no behavior has been implemented is historical. For current status, see [Current status and reconciliation](status.md).

Updated: September 28, 2026.

This is the working design record for the product-shaping conversation. It records decisions, their reasons, their consequences, and what remains open. It is not an implementation specification. No behavior described here has been implemented or integration-tested in this project.

The [first behavioral specification](specification.md) translates these decisions into requirements and acceptance scenarios. This log remains the authority for decision provenance; candidate encodings and unresolved contracts remain labeled in the specification.

Entries were reconstructed from the conversation and its working notes. “Settled” means accepted in that discussion; “candidate” means proposed but not accepted. Derived consequences are identified separately so they do not masquerade as explicit user decisions. Later decisions supersede earlier proposals as recorded below.

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

> **Status note (reconciled September 28, 2026).** An explicitly submitted comment review has since been implemented (merged, unreleased) under the provisional [submitted-review contract](submitted-review-contract.md), which proposes the omitted-option default (draft) and the `COMMENT` event. The text below remains as historically recorded, pending owner acceptance of that contract. See [status](status.md).

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
