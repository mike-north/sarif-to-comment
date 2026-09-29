# Second-milestone interface design

> **Historical design record (reconciled September 28, 2026).** Names selected here shipped in 0.2.0. The removal and validation designs marked deferred have since been merged under provisional contracts. For current status, see [Current status and reconciliation](status.md).

Design proposal · September 28, 2026. The user delegated command and function naming and requested independent sub-agent scrutiny. This document designs the vocabulary and visible operation boundaries for [the second milestone](second-milestone.md); it is not an implemented API or a complete extraction specification.

## Current delivery boundary — happy path first

The latest user instruction narrows this milestone to **init → add-comment → inspect → add-staged-changes → publish**, with equivalent library capabilities and human/JSON CLI output. Inspection can also show the enriched artifact. `remove-comment` / `removeSarifComment` and `validate` / `validateSarifReview`, along with their correction, stale-deletion and standalone-readiness contracts, are **deferred**. They remain design notes below, not current delivery requirements. D31 supersedes earlier milestone-scope statements that included them. Existing publisher checks and delivery safety remain mandatory.

The user described this specifically as “the happy path first.” The broader workflow below is future direction. Implementers must use [the current milestone scope](second-milestone.md) for acceptance boundaries.

## Consumer workflow

A reviewer creates a SARIF document, adds caller-written comments, inspects the current findings and fixes, removes unwanted comments, incorporates proposed changes from the Git index, and explicitly publishes through the existing operation. The user wants this loop to work without an upstream SARIF producer or direct manipulation of complex SARIF JSON. Each step has a distinct artifact or effect. Authoring does not require GitHub credentials or a destination PR.

The current flag-only CLI invokes publication, and the current library exports `publishSarifReview`. Both are compatibility commitments. Adding authoring must not silently reinterpret existing publication calls or require a new builder class.

## Modular input boundary

Authoring is an optional, freestanding concern (D32). `createSarifDocument` and `addSarifComment` help callers construct ordinary SARIF; they are not an entry ticket to the rest of the library. `inspectSarif`, `addStagedChangesToSarif`, future standalone validation, and `publishSarifReview` consume ordinary SARIF plus their explicit context, irrespective of how it was produced. CLI equivalents consume files with the same semantics.

Do not introduce hidden authoring sessions, mandatory helper IDs, initialization markers or a private document wrapper as downstream prerequisites. Optional authoring metadata cannot become a compatibility gate. Shared SARIF interpretation may be reused across operations without placing unrelated Git or GitHub responsibilities inside the authoring abstraction. Package splitting is not required by this boundary.

Two first-class paths must remain visible in docs and acceptance examples:

- Helper authoring → optional inspection/staged incorporation → publication.
- Upstream-produced SARIF → optional inspection/staged incorporation → publication, including direct publication of ready SARIF.

The existing supported-profile limitations remain explicit; accepting upstream input does not promise support for every SARIF feature. It does mean supported ordinary input cannot be refused solely because our helpers did not create it.

## Selected vocabulary

These names are lead-selected design decisions under the user's delegation, scrutinized by an independent sub-agent. They are not available in version 0.1.1 except for the existing library publisher and flag-only publication CLI.

| Intent | CLI command | Library function | Visible effect |
| --- | --- | --- | --- |
| Draft a new artifact | `init` | `createSarifDocument` | Create a local SARIF artifact; no GitHub review. |
| Add line/range feedback | `add-comment` | `addSarifComment` | Add one caller-written finding. |
| Deferred: correct by removing feedback | `remove-comment` | `removeSarifComment` | Remove one selected finding and its attached fixes. |
| Inspect the current artifact | `inspect` | `inspectSarif` | Show findings, source locations and included fixes; no mutation. |
| Incorporate staged fixes | `add-staged-changes` | `addStagedChangesToSarif` | Add proposed changes from the Git index to SARIF. |
| Deferred: assess readiness | `validate` | `validateSarifReview` | Check readiness for the intended GitHub review without publishing. |
| Publish the ready artifact | `publish` | existing `publishSarifReview` | Create the GitHub draft through the existing delivery contract. |

The workflow is `init → add-comment → inspect/remove-comment/add-comment → add-staged-changes → inspect → validate → publish`. Inspection can occur whenever useful; these commands do not create a mandatory workflow state machine.

Selected staged-operation help sentence: “Add proposed changes from the Git index to a SARIF document.” It neither stages source files nor applies proposed changes to them. `extract-staged` sounds like a raw change-list operation, and `enrich-staged` leaves its target unclear. The verb add does not promise unconditional accumulation, repeat-call idempotence or automatic reconciliation.

## Selected interface conventions

- Library authoring works on ordinary in-memory SARIF values. Addition and removal return a new document and preserve the input; examples must assign the return value, such as `sarif = addSarifComment(...)`. No builder/session is required. Inspection returns a simplified JSON-compatible object. Extraction reads Git and is asynchronous. Exact result/error types remain part of behavioral design.
- CLI `init --output FILE` creates a document and refuses an existing destination. `--sarif FILE` consistently selects an existing input. `add-comment` and `remove-comment` update that selected authored file on success; they are artifact editing commands, not GitHub writes.
- Staged incorporation requires a distinct output artifact. The ordinary correction loop edits the authored input, then regenerates an enriched output. It must not imply that re-enriching an already enriched file is safe before repeat-call behavior is defined. Existing output preservation and error-artifact behavior must honor D10; no generic overwrite flag bypasses that policy.
- `--file` means the repository-relative source path named by a comment, independent of the shell's current directory. It is distinct from the local `--sarif` artifact. `--worktree` selects the local checkout/index for extraction; it does not make unstaged contents the extraction target. Existing `--repo OWNER/REPO` retains its GitHub destination meaning.
- Use `--line` plus optional `--end-line`, and corresponding library fields `line`/`endLine`. They are one-based inclusive feedback coordinates; omitted end means a single line. Users need not learn SARIF's internal `startLine` spelling. They do not define the replacement scope of a fix.
- A removal selector comes from inspection, not from guessing a message, source location or current array index. The selector representation and argument spelling will be finalized with the stale-selection contract.
- Existing `--commit` means the explicit reviewed revision. Existing `--state` continues to mean durable publication identity, never the authored SARIF artifact. Source binding, producer defaults and run selection must be defined before complete runnable examples or signatures are finalized.
- Add explicit `publish` CLI routing while preserving the existing flag-only invocation exactly: arguments, validation, credentials, exit behavior and delivery recovery remain compatible.

## Deferred: standalone validation versus inspection

This was deferred from the second milestone and has since been implemented. The [readiness assessment contract](readiness-assessment-contract.md) records the outcomes, CLI output and exit statuses, and the decisions still awaiting acceptance.

Inspection answers “What have I authored, and what fixes are included?” It does not require the document to be supported for publication. Validation answers “Can this complete artifact be published faithfully to this intended review under the selected policy?” It must use the publisher's readiness rules, including source consistency and host constraints, rather than treating schema validity alone as readiness.

Validation may require authenticated GitHub reads. It must perform no remote writes, create no durable publication record, and issue no reusable approval stamp. It is optional and never bypasses the publisher's own checks: remote source and review context can change after validation. A valid proposed edit is not a claim that the code is correct or the critique is worthwhile. The user requested this assessment; it is not a revival of the assistant-invented mandatory early approval gate rejected under D19.

## Human and machine-readable CLI output

The user explicitly requires both modes across the complete CLI workflow and equivalent library functionality. The selected proposal is `--format human|json`, with `human` as the default. Output selection must not depend on whether stdout happens to be a terminal. There is no second synonymous formatting flag in the initial design.

Human output should make proofreading easy: finding references, full explanations, readable paths and line ranges, and concise fix previews with visible truncation. JSON output exposes a structured representation suitable for agent consumption, not a JSON string containing formatted Markdown and not a dump of raw SARIF when inspection was requested.

`inspect --format json` returns the same simplified view as `inspectSarif`, including selectors, every finding/location/fix, preview completeness and diagnostics. Human inspection formats that view rather than using an independent traversal that could omit evidence. Both modes preserve all findings and full comments; only fix previews may be shortened under the current contract.

Functional equivalence does not mean pretending that file-oriented CLI commands and in-memory library calls have identical transport wrappers. CLI authoring operates on a named file and should return a concise receipt with its location and affected finding references. Library authoring returns the new SARIF value and the information needed to continue the equivalent workflow without filesystem access. Exact returned-document/receipt types must be settled together so retrieving a newly added comment reference does not require reverse-engineering SARIF.

All commands need exactly one JSON document on stdout for every handled success, blocker or error in JSON mode. When JSON format is validly selected, unrelated usage errors also use JSON. Invalid, missing or conflicting format values fail as usage errors; their fallback rendering must be specified and tested before implementation. Preserve useful exit statuses; JSON is not a substitute for failure signaling. Keep progress messages, color escapes and human prose out of JSON stdout. Schema/usage/operational errors must remain distinguishable at the outcome level, and secrets must not enter either output mode. Stable outcome fields and actionable text are sufficient; do not introduce a new public diagnostic-code schema merely for JSON output (D13). Existing flag-only human publication output and exit behavior remain compatible. A JSON option is opt-in. Receipts identify only files actually written, with withheld normal output, error artifacts and archives distinguished when applicable. Publication JSON retains the known review URL, relevant state path and retry guidance; formatting cannot change recovery semantics or exit status.

The JSON readiness result must distinguish `ready`, `blocked`, and an assessment that could not be completed. A prior successful validation does not answer delivery recovery questions; only the existing publication state contract does that.

## Reasons not to choose some shorter alternatives

- `createReview` or `initReview`: ambiguous between a local SARIF artifact and a remote GitHub review.
- `addComment` alone: loses the SARIF destination when imported beside a GitHub client.
- `extractStagedChanges` returning full enriched SARIF: suggests a patch or change list, hiding input preservation and association work.
- `prepare`: hides which inputs are consumed and whether validation, extraction or publication is included.
- A mandatory builder/session object: adds lifecycle and conversion steps to an existing plain-object library without an established need.
- A second `sarif` command namespace: adds nesting to a single-purpose executable. Revisit only if the command surface grows enough to warrant it.

## Contracts names cannot settle

Producer defaults/run selection, source snapshot binding, reviewed-versus-proposed line coordinates, attribution, existing fixes, feedback association, staged operations without comments, supported operation types, failure artifacts, and concurrency still require the second milestone's behavioral design. Ergonomic names must not imply these questions are resolved. In particular, plain SARIF comment authoring extends the earlier D19 input boundary without authorizing generation of reasoning from arbitrary prose or code.

## Inspection requirements and deferred removal design

The inspection view is for proofreading, not for reconstructing the original SARIF document or certifying publication readiness. Preserve full finding explanations by default, without model-generated paraphrases. Show general findings without fabricating a file/line; retain multiple locations and every included alternative or multi-file fix in the view even when the publisher cannot currently support them. File locations of findings and targets of fixes are distinct information.

Only fix previews may be shortened under the current user instruction. Indicate truncation explicitly and retain enough counts/structure to show what was omitted. Never rewrite or truncate the source SARIF, silently drop a fix, or present the shortened text as an executable complete patch. The library returns a JSON-compatible summary; the CLI formats that summary for reading. Both human-readable and JSON CLI output are explicitly required by the user, who expects agents to prefer JSON.

Inspection must expose a reference that can select the exact finding for removal, including identical-looking findings in separate runs. A stale or ambiguous reference must not delete a different finding. Whether references are persistent IDs or document-bound selection handles remains an implementation/design choice. Inspection itself is read-only.

**Selected removal semantics:** a comment is one selectable finding. Removing it removes that complete finding, including its attached fixes; all other findings and their fixes remain unchanged. Do not relocate orphaned fixes or delete equivalent fixes elsewhere. Help must say “Remove a finding and its attached fixes from the SARIF document.” Inspection groups fixes under the finding so this effect is visible. This edits only the artifact, never a previously published review.

D4 permits several independent findings to contribute to one rendered suggestion; extraction must preserve their independent editability rather than collapse them into an unremovable aggregate. Correct the authored input and regenerate the separate enriched output to incorporate the staged fixes again. This removal policy is the lead's selected design under the user's explicit design discretion, not a verbatim user requirement.

## Review record

Independent reviewer: `/root/authoring_api_review`, explicitly requested by the user; read-only inspection of the scope, existing contracts and public interfaces.

Accepted findings: use `init --output`; keep authoring functions ordinary-value operations and illustrate returned-document assignment; distinguish local `--worktree` from remote `--repo`; use `line`/`endLine` on both authoring surfaces; preserve the existing flag-only publisher as an exact compatibility form; avoid an extra `sarif` namespace or mandatory builder.

The reviewer initially preferred `enrich-staged`. A focused countercheck of what the verb’s object appears to be led both lead and reviewer to select `add-staged-changes` / `addStagedChangesToSarif`. This settles vocabulary without claiming accumulation, idempotence or automatic reconciliation.

The reviewer endorsed `remove-comment` / `removeSarifComment` and `inspect` / `inspectSarif`, and identified the complete-result removal ambiguity. After the user's product clarification and delegation of discretion, the lead selected the removal policy above; the reviewer found it coherent with the correction loop and D4. Its requested correction was to make regeneration use the authored input plus a separate enriched output rather than imply safe repeated incorporation into enriched SARIF.

The reviewer also required preservation of every finding, location and alternative fix; explicit complete/truncated/unavailable preview states; distinct selectors for duplicate-looking findings; and rejection of stale selection rather than deletion of another finding. These are accepted acceptance targets, not executed test results.

The reviewer endorsed `--format human|json` with a fixed human default, a single JSON document for every handled outcome, JSON-formatted usage errors when the format is validly selected, accurate file receipts and full publication recovery information. It confirmed that equivalent functionality allows honest transport differences between in-memory library returns and CLI file receipts. These recommendations are incorporated above.

The reviewer endorsed `validate` / `validateSarifReview` as optional whole-review readiness assessment. It required an explicit separation between shared preflight and publication identity/recovery: validation must not claim a new publication identity is safe to send or that delivery is guaranteed. Authentication/source-read failures must not be reported as ready. This distinction is accepted.


## Acceptance examples for the authoring loop

These are design acceptance examples, not passing tests. Examples 2–3 and 5 insofar as they require removal/correction, and example 7 for standalone validation, are deferred under D31. Current milestone implementation must not pick them up merely because they remain in this broader design record.

1. Initialize, add a single-line comment, then add a range comment. Inspection retains both exact explanations and their intended coordinates without requiring raw SARIF knowledge.
2. Two identical messages at identical coordinates in different runs remain distinct in inspection; remove one by its returned selector and retain the other.
3. Correct a finding by removal and recreation. Remove only that finding and its attached fixes; other findings and equivalent fixes remain untouched. Inspect the corrected authored input, then regenerate a separate enriched artifact from the index.
4. Keep general findings and multiple source locations visible. Show all alternative and multi-file fixes, including those unsupported by the current publisher. Truncate a long fix preview explicitly while preserving the complete finding explanation and raw source document.
5. Change the artifact after inspection. A stale positional selection cannot remove whichever finding now occupies that position.
6. Make working-tree contents differ from the index. Enrichment uses the intended index snapshot; applying supported derived replacements independently reproduces its content. Inspection of the enriched artifact exposes the fixes without claiming publication readiness.
7. Validate an unsupported or inconsistent artifact: report the blocker and perform no remote writes or publication-state creation. A successful validation likewise performs no publication; a later explicit publish still applies its normal checks.

8. Run each CLI operation in human and JSON modes and the equivalent library operation. Assert equivalent meaningful outcomes and diagnostics; inspection JSON and library inspection share the same normalized data. Failed JSON-mode calls remain machine-readable, use nonzero exit status, and contain no interleaved human output.

9. Use supported upstream-tool SARIF that has never passed through the authoring helpers. Inspect it and incorporate staged fixes directly, preserving feedback/attribution; separately publish ready upstream input without authoring or extraction. No helper-only marker or state is required.
