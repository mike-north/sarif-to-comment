# SARIF generation, combination, and review publication

> **Historical status (reconciled September 28, 2026).** This specification was written before any implementation. Its requirements still govern the broader product, but its status statements (such as "No product implementation exists") are historical. The product has since shipped through 0.2.1, and the §11 open contracts O1–O11 are mapped to shipped evidence, issues, decisions or non-goals in [the reconciliation](status.md#reconciliation-of-the-first-specifications-open-contracts-o1o11). The latest release evidence is [TypeScript migration release verification](typescript-migration-release-verification.md).

First behavioral specification · September 27, 2026 · Draft for review

## 1. Purpose and authority

The product turns feedback from humans, agents, and analysis tools into a coherent code review while preserving its meaning, source context, proposed changes, and attribution. It removes mechanical work from combining and publishing SARIF feedback and deriving fixes from staged changes; it does not decide whether that feedback is correct or useful.

The [decision log](design-decisions.md) governs this draft. Decision identifiers below refer to that document. The [product brief](product-brief.md) supplies the user workflow. The [new-file research](new-file-representation-research.md) records limited live evidence and a candidate encoding.

**Status:** No product implementation exists. Requirements describe intended behavior. Acceptance scenarios are specifications for future tests, not claims that tests have passed. The candidate SARIF example has passed schema validation; the browser probes establish only the particular observations recorded in the research document.

**Interpretation:** MUST and MUST NOT identify requirements grounded in settled decisions or their stated consequences. Proposed security requirements are labeled separately. Open questions are not implementation permission to choose a new product policy silently. If this draft conflicts with a settled decision, correct the draft rather than treating it as a decision change.

## 2. Scope and non-goals

The product supports the following composable concerns (authoring added for the second milestone under D30):

1. Authoring and inspecting caller-supplied feedback through CLI and library helpers without requiring direct SARIF manipulation.
2. Combining SARIF feedback while preserving its origins.
3. Optionally enriching feedback with proposed changes derived from a reviewed source snapshot and staged repository state.
4. Validating and publishing the complete artifact to a review destination.

These are responsibilities, not settled packages, commands, or deployment units. Under D32, authoring is optional and freestanding: ordinary SARIF is the interchange boundary, and downstream operations must accept supported upstream-produced SARIF without helper initialization or authoring-only state. Publication MUST also accept supported feedback-only SARIF and supported SARIF with supplied fixes without requiring staged-change extraction. **[D1, D5]**

**Input boundary (extended by D30):** Producers may supply existing SARIF, or callers may use the second milestone’s authoring helpers to initialize an artifact and add explicit comment text and source locations. Both paths produce SARIF for preparation and publication. The helpers must not require callers to hand-build SARIF structures. This tool converts staged changes into SARIF fixes or the explicit whole-file proposal representation once that convention is settled. It combines that derived change information with the supplied SARIF; it does not infer findings or source locations from unstructured prose review notes. “SARIF generation and combination” names this tool operation. It starts with supplied or helper-authored SARIF and any staged changes, and ends when the combined output SARIF is produced. It is neither upstream feedback authoring nor a later review step. **[D19, D30; A23]**

GitHub is the concrete destination for the acceptance scenarios. GitLab remains relevant; the initial supported-host set is open. Host-specific eligibility and presentation MUST remain distinguishable from caller policy. **[D3]**

The following are outside this specification's current product scope:

- Generating review reasoning or documentation, judging whether feedback is sound, or selecting the best semantic fix.
- Inferring dependencies among findings or proving arbitrary subsets of suggestions correct.
- Inferring which edits require joint acceptance or preventing an author from manually applying arbitrary subsets. Preserving explicitly supplied groups through suggestion PRs is in scope under R16.
- Building a proofreading or human-approval interface.
- Tracking an editing history to decide whether incoming SARIF is new feedback or edited feedback.
- Maintaining existing reviews, reconciling human edits to draft reviews, importing GitHub state back into SARIF, or managing re-review. New SARIF may create a separate new review. Recovery only establishes and completes the same initial publication; it is delivery verification, not synchronization. **[D29]**
- Automatically committing proposed file additions or deletions to the author's branch.

When the caller enables suggestion PRs, publication may create proposal branches and PRs targeting the author's PR branch. Acceptance remains the author's action; this is distinct from automatically committing into that branch. **[D22; R16]**

## 3. Semantic model and inputs

| Concept | Meaning and boundary |
|---|---|
| Feedback item | An explanation with available origin and source associations. A SARIF result can express it. A proposed change is optional. |
| Proposed change | An intended repository modification, addition, or deletion. Its meaning exists independently of whether the host offers a native Apply suggestion action. |
| Reviewed snapshot | The explicitly identified source revision against which source references and proposed modifications are interpreted. |
| Staged snapshot | The intended Git index content used by optional extraction. It is not interchangeable with the current working-tree content. |
| Review context | The reviewed snapshot, destination repository and review, and caller-selected presentation and publication policy. |
| Combined SARIF artifact | The complete SARIF input to publication assessment. Being structurally valid does not establish publication readiness. |
| Rendered review | The host presentation of the complete artifact under its context and policy. Several feedback items can share one rendered comment. |
| Blocking exception | An unresolved obstacle to the operation's required contract. It differs from a warning and from a claim that the reviewer is wrong. |
| Approval hold | Explicit upstream state that publication must wait, unless the caller deliberately bypasses that state. |
| Publication identity | Stable identity for a logical publication and distinct identities for its intended remote objects, retained across network retries; not feedback-editing identity across unrelated invocations. |

The wire representation of review context, proposed whole-file operations, and approval state remains open. This draft does not require a second public review format alongside SARIF.

## 4. SARIF generation and combination requirements

### R1. Preserve feedback and origin

Combining inputs MUST retain their explanations, meaningful origin metadata, and relevant source associations. Combining reports MUST NOT itself be treated as approval to discard duplicate-looking feedback, invent a merged rationale, or resolve competing semantic proposals. Caller-supplied attribution may supplement inadequate producer identity. Flattening multiple runs is not required. **[D5; A1, A2]**

The tool MUST NOT infer a GitHub approval or request-changes action merely from a finding's severity or source. The exact submitted review event is an open caller-policy contract. **[P1, P2; O6]**

### R2. Extract from the intended staged state

When extraction is requested, the tool MUST use the reviewed snapshot and the intended staged state. It MUST NOT substitute unstaged working-tree changes. Several feedback producers can share this single reconciled staged state. Independent competing fixes are not an assumption of the main path. **[D2; A2, A3]**

**Proposed acceptance invariant:** For supported text replacements, applying the extracted replacements to the reviewed snapshot reproduces the relevant staged content. This supplies a concrete correctness check for extraction; it does not prove the resulting program or arbitrary subsets semantically correct. Exact supported operations, encoding, and normalization rules require O2 and O3 before implementation.

### R3. Validate structure and review policy separately

SARIF generation/combination and publication assessment MUST distinguish structural SARIF validation from product policy. Use an off-the-shelf JSON Schema validator for structure. Product policy MUST account for source consistency, faithful supported representation, and mechanical compatibility as applicable. **[D15; A4, A5]**

An existing-file location that names a nonexistent line in the reviewed snapshot is not made valid by passing schema validation. An explicitly proposed new file is a different operation and MUST NOT be rejected merely because it does not yet exist. **[D6, D15; A4, A7]**

In the new-documentation workflow, supplied feedback may identify a line in the proposed file itself, such as its first line. The tool MUST associate that feedback with the staged addition and validate the reference against the staged proposed content, not misclassify it as a reference to an existing reviewed file. This is a real line in the proposed file, not a fabricated location in the reviewed snapshot. Exact representation of reviewed versus proposed source context remains part of O2/O3. **[D20; A25]**

Warnings may describe unused or unsupported information that does not prevent faithful publication. A blocker MUST NOT be downgraded to a warning merely to make publication succeed. Missing or weak reasoning is a proofreading concern; the converter MUST NOT invent an explanation. **[D8, D9, D15; A5]**

### R4. Treat irreconcilable mechanical conflicts as repair work

If proposed edits cannot be faithfully reconciled mechanically, the generation/combination operation MUST report the conflict and preserve relevant evidence. It MUST NOT choose a semantic winner. Clean mechanical reconciliation MUST NOT be described as proof of correctness. Automatic Git-based reconciliation of independent fixes is optional and not a requirement of this draft. **[D2, D7, D8; A5]**

### R5. Apply strict and best-effort modes to SARIF generation and combination

| Generation/combination outcome | Strict mode | Best-effort mode |
|---|---|---|
| No blocking generation/combination exceptions | Produce the normal combined SARIF artifact. | Produce the normal combined SARIF artifact. |
| Blocking generation/combination exceptions remain | Withhold the attempted combined SARIF; emit diagnostics. | Emit the most complete faithfully representable working SARIF under the distinct error name, plus diagnostics. |

An awaiting-approval marker MUST be preserved as input state. That marker alone is not a generation/combination exception and MUST NOT force the error output name. The combined SARIF may be successfully generated while its publication is held. This is a consequence of D11's publication boundary, not an additional workflow mode. **[D11, D19; A24]**

Best effort MUST preserve flawed representable material, rather than output only the successfully processed subset. It MUST NOT imply permission to publish any part of that output. If material cannot be represented in SARIF, its available evidence MUST be retained alongside the diagnostic through a mechanism still to be specified. **[D9; A5, A6]**

Arbitrarily malformed input may prevent reliable recovery of independent items. The tool MUST NOT manufacture apparently valid findings from content it could not reliably interpret. The diagnostic describes the failure and available evidence. **[P1, P4; A6]**

### R6. Preserve previous output while making failure unmistakable

Before replacing a prior normal output, preserve it by renaming it with an old designation and a prefix based on its original creation time. Read that time before renaming. The prefix uses a readable year-month-day form. A failed run MUST return failure and MUST NOT leave the earlier successful artifact at the expected normal output path. **[D10; A14]**

Only a successful generation/combination run produces the normal output filename. A failed best-effort run uses a distinguishable error filename. Archival MUST NOT overwrite another historical artifact. Exact filenames, timestamp precision, missing birth-time handling, collisions, and error-file rotation require O7.

These names are illustrative roles, not final syntax:

```text
review.sarif.json                         normal combined SARIF output
review.error.sarif.json                   attempted output with exceptions
20260927-<original-time>.review.old.json   preserved earlier output
review.exceptions.md                     Markdown repair report
```

The publisher MUST validate its actual input; a filename alone does not establish publication readiness. The proposed optional early publication check has been withdrawn as a requirement; see the O8 clarification. **[D10, D11]**

## 5. Review presentation requirements

### R7. Keep eligibility, policy, and rendering in order

The adapter MUST determine host placement eligibility for the relevant context. Caller policy chooses the treatment of feedback that cannot use its preferred native presentation. The adapter then renders that treatment. **[D3; A9]**

A valid source reference outside native inline placement MUST default to general review feedback with an exact-revision source link. The tool MUST make the source association explicit and MUST NOT fabricate a source location or describe an unverified location as verified. An unverified or inconsistent location requires reconciliation rather than this fallback. A general comment MUST NOT be represented as retaining unavailable native click-to-apply behavior. Host capability details remain in O4. **[D3; A9]**

### R8. Let actual replacement ranges determine native suggestion scope

Several feedback items within one replacement range may accompany one rendered suggestion. Their explanations and origins MUST be retained. The tool MUST NOT duplicate the replacement per producer or enlarge its range merely to include nearby feedback. Feedback outside the replacement range remains separate. **[D4; A2]**

### R9. Represent whole-file proposals as review contributions

A proposed addition MUST preserve the intended repository path, full content, and supplied explanation. A proposed deletion MUST preserve its explicit delete-file meaning, source association, and supplied explanation. Deleting a file MUST NOT be represented as merely emptying it. **[D6; A7, A8]**

The supplied explanation may be a source-associated SARIF comment on the affected file. For an addition, its referenced line is in the staged proposed content; for a deletion, it is in the existing content before removal. Both use R7's ordinary eligibility, policy, and rendering model when the host cannot provide the corresponding inline placement. They do not require another kind of feedback association. **[D20; A25, A26]**

For whole-file deletion, the staged operation and file identity determine the proposal. A comment's particular line MUST NOT narrow the operation to deleting that line or become a required anchor for understanding the deletion. The supplied comment explains the file-level operation. **[D20; A26]**

The contribution “This PR needs documentation; here is a proposed page” is one item of feedback with a remedy. The tool MUST NOT invent another finding critiquing the reviewer's own generated page or invent a source line in the absent file. **[D6 and user-supplied scenario; A7]**

There is no special confirmation requirement for additions and deletions. Their appropriateness is evaluated by general upstream proofreading, just like an inappropriate inline comment or bad suggestion. **[D6, D11; A8]**

### R10. Make convenience actions subordinate to the complete proposal

A new-file prefill link may be offered only within supported conditions when using the ordinary review-content route. If unavailable, the complete ordinary review proposal MUST remain available. Contents MUST NOT be truncated to fit the link. When R16 selects a suggestion PR, the proposed Git change may carry the complete file without duplicating its contents in a comment. **[D17, D22; A15, A28]**

Long content may use generated details/summary presentation. Collapsing MUST preserve the full content and MUST NOT be treated as reducing the host's actual payload size. **[D18; A16]**

The live evidence supports one short prefill case and one rejected longer URL. It does not establish a production limit or exact-commit application. The recommended guard evaluates the complete encoded URL. Before enabling the feature, O5 must establish its support envelope and relevant destination behavior.

If the full proposal cannot fit any supported faithful representation, report an exception rather than silently truncate it. This follows R7 and R12; automatic splitting, uploads, or external hosting are not specified remedies. **[P1, D3, D12; A16]**

### R16. Select publication forms using the suggestion-PR setting

> **Status note (September 29, 2026).** Suggestion PRs have since been implemented (merged, unreleased) under the provisional [companion suggestion PR contract](companion-suggestion-pr-contract.md). That proposal leaves them **disabled when the setting is omitted**, departing from the low-conviction default below, and records its evaluation against PR clutter and triggered automation. The text below remains as recorded, pending owner acceptance. See [status](status.md).

The caller MUST be able to allow or disallow suggestion PRs. Small edits eligible for native suggestions MUST prefer that presentation in either configuration. When suggestion PRs are enabled, whole-file creation and deletion MUST prefer a suggestion PR, and an explicitly supplied group of distinct edits requiring acceptance as a unit MUST use a suggestion PR containing the complete group. Such a PR targets the original PR's branch and preserves its supplied feedback. **[D22; A27–A29]**

When this setting is omitted, suggestion PRs MUST currently be enabled. This is a low-conviction product default to validate through real user feedback, particularly PR clutter and repository automation triggered by PR creation. The caller's explicit disable choice remains supported. **[D22]**

With suggestion PRs disabled, individual creation/deletion proposals remain supported through faithful ordinary review presentation and supported action links. Exact deletion-link support is unverified; no click count or direct confirmation URL is promised. Grouped application is unsupported in this configuration. The publisher MUST report that the group requires suggestion PRs rather than silently split it into independently applicable suggestions or omit it. This is a publication capability constraint, not by itself an error in SARIF generation and combination. R12's whole-review gate applies. **[D6, D12, D22; A30]**

The tool MUST preserve supplied grouping without inferring semantic dependencies or combining alternative remedies into one patch. Suggestion PRs MUST carry the configured suggestion label and an ordinary reference to the original PR in their own body, allowing discovery from the original's structured back-references plus label filtering without title parsing. Establishing this relationship MUST NOT require editing the original PR's description. The reference MUST NOT use a closing keyword that would close the original when the suggestion is accepted. Exact conventions and remaining remote lifecycle details require O11. **[D7, D21, D22, D24; A29, A31, A33]**

R11 and R12 apply before proposal-branch or suggestion-PR publication writes as well as review writes. R14's recovery model must cover all remote objects involved; a created suggestion PR alone is not proof that the complete review was published. **[D12, D14, D22; O6, O11]**

On-demand cleanup SHOULD enumerate open PRs with the configured suggestion label, resolve each referenced original, and close eligible suggestions only after positively verifying that the original has merged or closed. Targeted discovery from an original remains supported. A failed or unauthorized original lookup MUST NOT be treated as a terminal original state. Cleanup MUST respect the caller's actual permissions and distinguish remaining unauthorized suggestions from failed actions. Candidate enumeration MUST paginate; it need not scan the full history of closed originals or maintain a separate relationship store. PR closure and source-branch deletion are separate operations. **[D21, D25, D27; A36]**

**Deferred fork case:** Near-term suggestion-PR workflows focus on the same repository. Suggestions in forks are recorded for completeness, not required for initial support. If added later, discovery and cleanup must account for the suggestion PR's repository, access permissions, and separately owned head branch. This does not block the same-repository design. **[D25; A34]**

## 6. Approval and publication requirements

### R11. Honor declared approval state without reconstructing its history

Ordinary SARIF without approval metadata MUST follow normal publication validation. Explicit awaiting-approval state MUST block publication by default. A caller-selected override may ignore that state and MUST NOT bypass other blockers. **[D11; A10–A12]**

Missing metadata MUST NOT be presented as evidence that a human approved the feedback. The publisher MUST NOT require editing history or compare against earlier SARIF inputs to infer whether declared approval is stale. Maintaining approval state belongs to upstream tooling. **[D11 and closed editing-history discussion; A12]**

### R12. Assess the entire artifact before any publication write

The publisher MUST validate the complete intended review before the first GitHub write. If any blocking publication exception or effective approval hold remains, it MUST perform no publication writes. Read-only destination inspection is compatible with this requirement. **[D12; A10, A11]**

The publisher MUST NOT select a ready subset by omitting held or invalid items. When the approval override is used and other validation succeeds, the intended artifact remains complete; the override is not a filter. Upstream authors may deliberately revise an artifact and invoke the tool again. **[D7, D11, D12; A10, A11]**

This is a guarantee of validation before publication writes, not a promise of atomic network effects. A host failure after the first write can leave uncertain or partial remote state. Recovery requirements apply; the tool cannot declare success merely because local validation succeeded. **[D12, D14; A18]**

### R13. Preserve the reviewed revision and caller-selected publication mode

> **Status note (reconciled September 28, 2026).** An explicitly submitted comment review has since been implemented (merged, unreleased) under the provisional [submitted-review contract](submitted-review-contract.md), which proposes the omitted-option default (draft) and the `COMMENT` event. The text below remains as historically recorded, pending owner acceptance of that contract. See [status](status.md).

Publication MUST target the explicitly reviewed source revision rather than silently substitute the newest branch head. A newer branch head alone MUST NOT imply invalid input or reset declared approval. Unsupported host placement remains subject to R7. **[D15 and source-freshness clarification; A13]**

The caller MUST be able to choose pending or submitted publication. R11 and R12 apply to both. Pending mode is not a bypass for incomplete or held input. The omitted-option default and submitted review event remain open. **[D16; A17]**

Pending publication means a **draft code review**. Associated suggestion PRs may be created as drafts at that time, using GitHub's normal visibility. The publisher MUST NOT introduce an additional privacy or deferred-creation requirement solely because repository readers can see those draft PRs. This does not require a service synchronizing their later lifecycle with manual review submission or discard. **[D26; A35]**

When publication mode is omitted, the publisher MUST leave the code review as a draft. Immediate submission MUST require an explicit caller choice. **[D26]**

### R14. Recover uncertain creation using persisted publication identity

Before creating the remote review, persist its publication identity. Include a hidden identity marker in the review body. If the creation response is lost, recovery MUST investigate the destination for that identity before another creation attempt. **[D14; A18]**

Suggestion PR creation MUST likewise persist the identity of the intended suggestion before sending and include its marker and ordinary original-PR reference in the creation body. Recovery MUST support GitHub having persisted the PR while no PR number or URL reached the caller. It SHOULD begin with the known original's backlinks, inspect candidate markers, and verify the identified PR against the intended operation. Distinct suggestion groups MUST retain distinct identities within the publication. Missing backlinks or a recent repository-list miss MUST NOT establish absence, and recovery lookup MUST NOT require a label that may only be applied after creation. **[D28; A37]**

A matching marker identifies a candidate created review; it does not establish that every intended remote operation completed. Immediate absence of a marker MUST NOT be treated as proof of no remote effect. State persistence, concurrency, delayed visibility, and multi-operation completeness require O6 before this recovery path can be considered implemented.

Retrying the same publication is distinct from a new invocation with a new input artifact. This specification does not define automatic cross-invocation deduplication or updating of earlier feedback.

Recovery MUST NOT overwrite human edits or restore human-deleted review content to reproduce the original SARIF. Completed initial publication ends the publisher's responsibility for review content. If delivery remains uncertain, the tool may report that uncertainty; it MUST NOT expand recovery into maintenance or reconciliation of the review. The separate suggestion-cleanup behavior in R16 remains bounded by its existing contract. **[D29; A38, A39]**

**Verified API capability:** GitHub supports creating a review with its body and inline comments in one request, pending or immediately submitted. [Create a review documentation](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request). This reduces the required review writes; it does not include suggestion PR creation or establish transactional guarantees under failures. Supported request limits still require verification.

## 7. Diagnostics and repair

### R15. Give the external repair loop enough evidence

Diagnostics MUST be Markdown suitable for humans, agents, and editor rendering. They MUST explain the failed contract, identify the relevant evidence and input, and state a mechanically checkable completion condition where one exists. The report MUST distinguish which input the next run will consume. **[D8, D13; A4–A6]**

An internal diagnostic model may be structured. The initial external contract is not a frozen machine-readable diagnostic schema, and editing the report is not an input-repair protocol.

**Illustrative diagnostic; field labels are not a public schema:**

> **Referenced source line does not exist**
>
> The feedback names line 90 of `src/retry.ts`, but that file has 60 lines at the reviewed revision.
>
> **Repair target:** the source location in the originating SARIF result, or the explicitly supplied review context if the wrong revision was selected.
>
> **Evidence:** the reviewed revision, source path, originating report/result reference, and available source excerpt are included with this exception.
>
> **Completion:** rerun with a source association that can be verified against the intended reviewed snapshot. Do not silently retarget to the latest branch head.

This example proves that a source-consistency failure is different from malformed JSON, and that the repair target is explicit. A separate approval diagnostic would explain the declared hold; it would not assert that the feedback is factually wrong.

## 8. Missing-documentation acceptance walkthrough

**Given:** A PR adds functionality at reviewed revision A. It lacks a documentation page. A reviewing colleague has an agent draft and stage a new page. The reviewer supplies the contribution “This PR needs documentation; here is a proposed page” as SARIF. The input is the existing SARIF feedback plus the staged page, not raw review prose for this tool to interpret.

**SARIF generation and combination:** Capture the intended path and staged content, preserve the explanation and available attribution, and represent the file as a proposed addition. Do not fabricate an existing location for the new page. A candidate wire representation exists in [proposed-documentation.sarif.json](examples/proposed-documentation.sarif.json); its custom property names remain provisional.

The upstream SARIF comment identifies a line in the proposed documentation file, for example line one. That location supplies the association to the staged addition. It does not claim that the page already exists in revision A or require a GitHub comment anchored to that nonexistent file. The combined review contribution presents the comment with the recommendation to introduce the page. **[D20]**

**Illustrative rendered contribution:**

> This PR needs documentation for the new functionality. Here is a proposed page to add at `docs/new-feature.md`.
>
> **Proposed file contents** — the complete literal staged content appears here, optionally in a collapsed section.
>
> **Open GitHub's new-file editor** — included only when the destination and complete encoded link meet the supported conditions.

The descriptive placeholders above are not literal output text. The actual output contains the entire page. No action claims that the addition has already been applied.

**Proofreading:** If upstream marks this item awaiting approval, the entire review waits. Clearing the hold upstream, or deliberately selecting the approval override, allows publication assessment to continue. Neither action waives other validation.

**Publication:** After whole-review validation, create the caller-selected pending or submitted review tied to revision A. A later branch update does not silently change A. A convenience editor link targets its validated branch context and does not claim to be pinned to A.

**What this proves:** One review contribution can carry a remedy that creates a file; native suggestion support is optional; proofreading state and mechanical representability are separate; neither a blocked link nor a moving branch licenses lost content or silent retargeting.

## 9. Proposed security requirements

The user explicitly requested a secure design. The following are proposed constraints for implementation review, derived from the identified input and presentation boundaries. They are not claims of completed security validation. They do not add another human-confirmation gate for file additions.

| ID | Proposed requirement | Validation case |
|---|---|---|
| S1 | Treat file content as literal data. Do not execute it or interpret it as a template. Generated Markdown fences must contain embedded fence sequences without exposing file content as surrounding markup. | A19: nested fences, HTML examples, template braces, and apparent action links remain literal source. |
| S2 | Resolve staged content through the intended Git snapshot. An input URI must not itself authorize arbitrary local-file reads, external fetches, or symlink traversal. | A20: artifact names outside the repository and staged symlinks do not cause disclosure of their targets. |
| S3 | Apply a documented repository-relative path and URI-decoding contract to proposed destinations. Reject traversal, unsupported schemes, absolute destinations, and ambiguous encodings. | A20: adversarial path fixtures are rejected before link generation or content access. |
| S4 | Derive action host, repository, and branch from validated review context. Encode parameters with a URL library and safely render the link. | A21: document text containing parameter delimiters cannot change the destination or add parameters; fork context uses the intended head repository. |
| S5 | Keep resource limits explicit and bounded. Exceeding a supported limit must not produce silent content loss. | A16, A22: excessive nesting, oversized artifacts, encoded links, and comment bodies produce the specified fallback or diagnostic. Numerical limits remain open. |
| S6 | Make content-bearing URL policy explicit. Treat the full document as exposed in that URL; do not use external shorteners or hosting as an automatic fallback. | A22: policy disabling content-bearing links retains the complete review proposal and generates no such link. Default policy remains open. |
| S7 | Honor upstream approval state without claiming it authenticates a human. Metadata alone is not proof of reviewer identity. | A12: absence is never labeled human approval; externally supplied identity is not described as independently verified. |

These requirements protect mechanical boundaries. They do not prove the proposed documentation safe or appropriate for a downstream agent to execute. This tool publishes review content; downstream execution authority remains separate.

## 10. Acceptance and evidence matrix

Each scenario is a future test obligation or a named gap. Tests should be written against these outcomes before implementation, following the project's tests-first instruction. Tests must not merely reproduce the converter's own calculations.

| ID | Fixture or action | Required assertion | Trace |
|---|---|---|---|
| A1 | Ordinary supported linter SARIF, no fixes or custom approval metadata | Can proceed through normal validation without staged extraction or per-item approval stamps; origin remains visible. | R1, R11; D1, D5, D11 |
| A2 | Two attributed findings within one staged replacement, plus nearby feedback outside it | One replacement with both explanations/origins; nearby feedback separate; replacement range unchanged. | R1, R8; D4, D5 |
| A3 | Working-tree content differs from the index | Extraction follows the index. Independently applying supported replacements yields the staged target under the proposed invariant, once O2/O3 are fixed. | R2; D2 |
| A4 | Schema-valid existing-file location beyond end of reviewed file | Source exception, explicit repair target, no publication writes; no automatic relocation. | R3, R15; D3, D8, D15 |
| A5 | Two irreconcilable supplied replacements | Strict withholds attempted SARIF; best effort preserves both representable proposals with diagnostics; neither publishes. | R3–R5; D7–D9 |
| A6 | Malformed SARIF, including a case with unreliable item boundaries | No fabricated valid items; diagnostic retains available evidence; success path absent on failure. Exact evidence container is O9. | R5, R6, R15; D9, D10, D13 |
| A7 | User's missing-documentation scenario | One contribution, full proposed page and destination retained, no fabricated source line or second critique. | R9; D6 |
| A8 | Intentional deletion, then an accidental notes-file addition | Deletion remains distinct from emptying; addition is not mechanically rejected solely for being new; no special confirmation gate. | R9; D6 |
| A9 | Verified source outside host inline eligibility | Apply configured treatment with exact-revision association, or report unsupported treatment; do not silently choose a fallback. | R7; D3 |
| A10 | Two ready findings plus one explicit approval hold | No publication writes for either pending or submitted mode. | R11–R13; D11, D12, D16 |
| A11 | Same artifact with approval override; then add a source inconsistency | First case includes all items if other validation succeeds; second still blocks all publication. | R11, R12; D11, D12 |
| A12 | New input with declared approval state and no previous input available | Honor supplied state without edit-history lookup or claims of verified human approval. | R11, S7; D11 |
| A13 | PR head advances after the reviewed snapshot | Publication assessment retains the reviewed revision; no automatic approval reset or retargeting. Host support verified separately. | R13; D15 |
| A14 | Successful output followed by failed rerun | Prior output archived without clobbering; normal path absent; error artifact only in best effort; failing exit status. | R6; D10 |
| A15 | Short supported prefill URL and oversized or unsupported one | Eligible case prefills exact path/content; ineligible case omits action but retains full proposal. Live evidence is limited to the research probes. | R10; D17 |
| A16 | Long content using collapsed presentation; then exceed supported host body size | Full content retained within supported size. Otherwise block unsupported representation; no silent truncation. | R10, S5; D18, P1 |
| A17 | Same ready artifact with pending and submitted configuration | Corresponding host state; same complete feedback and readiness checks. Exact submit event requires O6. | R13; D16 |
| A18 | Simulated remote creation followed by lost response | Identity persisted before send; recovery searches for it before retry; no claim that absence or marker alone proves operation completeness. Live confirmation needed. | R14; D14 |
| A19 | Proposed Markdown page containing fences, HTML examples, and braces | Literal content survives rendering; it cannot alter surrounding presentation or trigger execution. | S1 |
| A20 | Traversal/absolute/encoded paths, external URI, staged symlink | No unintended file access or fetch; invalid destination rejected under the selected path contract. | S2, S3 |
| A21 | URL punctuation and Unicode in content; fork and slash-containing branch contexts | Values round-trip without modifying URL structure; correct repository/branch. Only a subset has live evidence. | S4 |
| A22 | Input resource limits and disabled content-link policy | Bounded handling with complete supported fallback or diagnostic; no truncation, external upload, or shortener. | S5, S6 |
| A23 | Upstream SARIF feedback plus a staged documentation page | Preserve the supplied feedback; derive proposed-change information from the index. No arbitrary prose-to-finding conversion is part of this workflow. | Scope input boundary; D19 |
| A24 | Otherwise valid supplied SARIF containing an approval hold, combined with supported staged fixes | Generation/combination succeeds under its normal output name and preserves the hold; subsequent publication performs no writes without the explicit approval override. | R5, R11, R12; D11, D19 |
| A25 | SARIF feedback names a real line in the staged new documentation page, then a line beyond its end | Valid line associates the supplied comment with the addition without requiring a GitHub inline anchor. Nonexistent staged line is a source-consistency error. Neither is evaluated as an existing file in the reviewed tree. | R3; D20 |
| A26 | SARIF comment explains a staged file deletion, with or without a particular line; host cannot place it inline | Preserve file association and the entire-file deletion through configured general presentation. A supplied line does not narrow deletion scope. Use existing placement policy rather than invent another association mechanism. | R7, R9; D3, D20 |
| A27 | A small eligible replacement with suggestion PRs disabled, then enabled | Prefer the native suggestion in both cases; enabling PRs does not route every edit to a new PR. | R16; D22 |
| A28 | Standalone file addition and deletion, each with suggestion PRs disabled, then enabled | Disabled retains faithful ordinary proposals and supported action links; enabled prefers suggestion PRs carrying the actual operations and explanation. | R9, R10, R16; D6, D22 |
| A29 | An explicitly grouped code edit and regression-test addition, with suggestion PRs enabled | One suggestion PR carries both for acceptance together; the converter neither infers the group nor substitutes unrelated alternatives. | R16; D7, D22 |
| A30 | The same required group with suggestion PRs disabled, alongside other publishable feedback | Report the unsupported grouped application and required setting; no publication writes, no silent splitting or partial publication. Generation/combination can still preserve the valid group. | R12, R16; D12, D22 |
| A31 | Several referencing PRs, including labeled suggestions and ordinary references; suggestion titles change | Structured backlinks plus the configured label identify suggestion PRs independently of titles; paginate and deduplicate the returned PRs. | R16; D21 |
| A32 | Multiple file additions explicitly grouped for joint acceptance | With suggestion PRs enabled, one PR contains all additions. With them disabled, report unsupported grouped application under R12; do not substitute separate creation links or one PR per file. | R12, R16; D22 |
| A33 | Reviewer can create a suggestion PR but cannot edit the original PR's description | Establish the relationship through an ordinary reference in the suggestion body and the suggestion label; no original-description edit is required or attempted. Accepting the suggestion must not close the original via that reference. | R16; D21, D24 |
| A34 | Deferred: original PR upstream and suggestions across three reviewers' forks, with each cleanup caller authorized for only some PRs | Future compatibility scenario only; not an initial acceptance gate. Verify cross-repository discovery, labels, actual PR-closing authority, and branch ownership. Close eligible authorized suggestions; distinguish permission-limited leftovers from failed closes, and do not claim global completion. Subsequent reviewers can clean up the remainder. | D25 |
| A35 | A ready review containing a suggestion PR is published as a draft code review | Leave the review unsubmitted and allow creation of the associated draft suggestion PR under normal GitHub visibility; no additional private staging or deferred-creation gate. | R13, R16; D26 |
| A36 | Open labeled suggestions reference originals that are open, merged, closed without merging, or inaccessible | Suggestion-first cleanup leaves active originals' suggestions open; closes authorized eligible suggestions for verified ended originals; reports lookup and permission failures without inferring closure. Repeated runs tolerate suggestions already closed. | R16; D21, D25, D27 |
| A37 | GitHub persists a suggestion PR but its creation response never reaches the caller; labeling may still be incomplete | Retry locates and verifies the PR through its pre-persisted identity marker without a known PR number, reuses the existing PR, and resumes missing work. A recent-list miss or missing label does not justify duplicate creation. | R14; D14, D28 |
| A38 | A human edits or removes review content after initial publication | Do not restore the original contents, reconcile the changes into SARIF, or maintain the review. An uncertain delivery outcome does not authorize such repair. | R14; D29 |
| A39 | Caller supplies a wholly new SARIF file for the same original PR | May create a separate new review under normal validation; do not update or reconcile the earlier review. | R14; D29 |

## 11. Open contracts and implementation gates

| ID | Gap | Governing boundary | Evidence or decision needed |
|---|---|---|---|
| O1 | Approval metadata property names and recognized values | Absence follows ordinary publication; explicit hold blocks all; override is approval-only. | Small convention and malformed/unknown-value behavior. Do not reopen editing history. |
| O2 | Whole-file creation and deletion encoding | Preserve operation, content/source, and relation to one contribution. | Review the candidate extension and define deletion semantics; schema validity alone is insufficient. |
| O3 | Extraction and association details | Use staged snapshot and actual replacement ranges; no invented reasoning. | Supported file types, encoding/newline treatment, renames/modes, feedback-to-change association, absent explanation, and mixed reviewed revisions. |
| O4 | Host capability matrix | Eligibility → policy → rendering; valid non-inline feedback defaults to general feedback with an exact source link. | Tests for changed, unchanged, distant, historical, and nonexistent source cases; initial host support commitment. |
| O5 | Prefill and comment-size support envelope | Optional link, complete fallback, no truncation. | Encoded-URL bound, full-comment bound, fork permissions, branch-name encoding, existing-file and protected-branch behavior. |
| O6 | Publication lifecycle details | Draft by default, explicit immediate submission; whole-review validation before writes; persisted identity. | Submission event, pending-marker preservation, retries, concurrency, delayed visibility, and partial remote operation recovery. |
| O7 | File lifecycle details | Preserve history and keep stale success off the normal path. | Timestamp precision/timezone, absent creation time, collision handling, archival/write failures, and old error/report rotation. |
| O8 | Closed clarification: approval state during SARIF generation | Strict/best effort concern SARIF combination/extraction; approval holds govern publication. | R5 preserves the marker without treating it alone as a generation error; R11 honors it at publication. No additional early approval gate or workflow phase is required. |
| O9 | Unrepresentable input evidence | Best effort preserves evidence rather than disguising loss. | Location and format for evidence that cannot fit in SARIF; no external diagnostic schema is implied. |
| O10 | Security profile details | Proposed S1–S7. | Approve path/URI rules, resource limits, action-link content policy, and adversarial fixture coverage. |
| O11 | Suggestion PR representation and lifecycle | D21 selects backlinks plus label; D22 provisionally enables suggestion PRs by default, with native small edits, preferred PRs for file operations, and required PRs for grouped application. D26 permits visible draft suggestion PRs alongside a draft review. | Exact grouping/label conventions, proposal branch ownership and revision handling, permission failures, multi-object recovery, deletion links, and remaining lifecycle/cleanup verification. Validate the low-conviction default against real PR clutter and downstream automation costs. |

These gaps limit implementation readiness, not the value of the settled behavioral contract. Work on a dependent behavior must resolve its relevant gap explicitly. A first specification does not make every candidate a settled requirement.

## 12. Document history and compatibility

This is the first behavioral specification. There is no released product behavior or migration contract to preserve yet. Commodity SARIF interoperability is a target requirement, while custom property names remain provisional.

The draft carries forward the retired-model corrections in the decision log: additions are not automatically errors; best effort is not a filtered subset; approval metadata is not mandatory; publication does not infer editing history; pending mode does not bypass whole-review readiness.

The next revision should close selected open contracts and add their fixture assertions. It should not broaden scope merely because a host API offers additional actions.
