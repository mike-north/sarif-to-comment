# Second milestone: the happy path from authored findings to a GitHub review

Current scope · September 28, 2026. The user's latest instruction is **“the happy path first.”** This narrows the earlier broader authoring/proofreading proposal. No second-milestone implementation or completed tests are claimed.

## Consumer outcome

An agent can create SARIF, add caller-written findings on source lines or line ranges, see the findings and fixes currently present, incorporate staged Git changes as fixes, and publish the resulting artifact as a GitHub draft review. It does not need an upstream SARIF producer or to construct and repeatedly read complex SARIF JSON itself.

The selected sequence is:

**Initialize → add findings → inspect → incorporate staged fixes → publish.**

The same read-only inspection can show the enriched artifact before publication. This is visibility into the happy path, not a correction/proofreading workflow. Inspection does not judge the feedback or certify readiness.

## In this milestone

1. Initialize a structurally valid SARIF document without hand-building boilerplate.
2. Add caller-supplied text associated with a file and a single line or inclusive line range, preserving existing findings.
3. Inspect current findings, source files/locations and all included fixes through a simplified representation. Keep full comment text. Fix previews may be truncated with explicit omission information; never truncate the source artifact or silently hide a fix.
4. Derive proposed changes from an explicit reviewed snapshot and the intended Git index, then incorporate them as SARIF fixes. Unstaged working-tree contents are not the extraction target. Preserve meaningful feedback and its source associations.
5. Compose with the existing one-way draft publisher, retaining precise placement, whole-review checks and durable delivery/recovery behavior.
6. Provide CLI commands/subcommands and equivalent library capabilities for the complete selected flow. The CLI supports human-readable and JSON output; JSON is expected to be the primary agent interface. Library authoring works in memory; the CLI works with files.

## Architecture: optional, freestanding authoring

The user explicitly requires modularity: bootstrapping SARIF and adding/editing comments are a freestanding authoring concern. Inspection, staged-fix incorporation, later standalone validation, and publication operate on ordinary existing SARIF, whether created by these helpers or by an upstream producer.

Plain SARIF is the interchange boundary: an in-memory object for the library, a file on disk for the CLI. Downstream operations must not require a helper-owned builder/session, initialization history, private authoring representation, or helper-specific marker. Required source/destination context remains an explicit input; ordinary SARIF still passes the documented supported-profile and source checks.

The linear workflow describes one consumer path, not mandatory phases. Preserve both bypasses: an upstream SARIF artifact can be enriched with staged fixes without initialization or comment-authoring calls, and ready upstream SARIF can go directly to the existing publisher. Authoring is also useful without extracting fixes or contacting GitHub. Inspection belongs at the shared SARIF boundary, not behind an authoring-only object.

This is a responsibility boundary, not a requirement for separate npm packages or services. Keep file I/O in the CLI boundary and avoid turning the authoring abstraction into a mode-driven facade for Git extraction or remote publication.

## Deferred

- Comment removal and correction by removal/recreation. (Delivered after this milestone under [the finding removal contract](finding-removal-contract.md).)
- A broader proofreading/correction loop.
- A standalone `validate` command and library readiness-assessment function. It has since been implemented after this milestone; see the [readiness assessment contract](readiness-assessment-contract.md).
- Suggestion PRs and review maintenance.

Deferring standalone validation does not remove schema/source checks required for correct authoring or extraction, weaken the existing publisher's safety checks, or permit silently wrong placement or dropped content. Happy-path-first is a product-scope decision, not permission to ignore errors.

## Worked outcome and acceptance evidence

A caller initializes an artifact, adds “Handle the empty-input case” on `src/parse.js` lines 8–10, and stages a corresponding implementation change. The working tree also contains an unrelated unstaged edit.

Inspection retains the supplied explanation and source association. Extraction reflects the staged change and excludes the unstaged edit. Independently applying the supported extracted replacements to the reviewed source reproduces the intended staged content. Inspecting the enriched artifact shows the resulting fixes. Publishing through the existing library and CLI creates the expected complete draft review with independently verified locations and replacement content. No hand-authored SARIF scaffolding is needed in the consumer demonstration.

Acceptance must also exercise ordinary upstream-producer SARIF through inspection and staged incorporation without helper initialization, and directly through publication without authoring or extraction. Preserve explanations, attribution and relevant producer metadata; no implicit migration to an authoring-only format.

Write behavioral tests before implementation, use independently authored source/placement/edit expectations, and preserve the accepted first-milestone guarantees. Tests and mocks must not be described as proof of live GitHub placement or application. The eventual end-to-end acceptance must identify which guarantees were checked against the real host.

## Contracts still to settle within the selected scope

- Initialization defaults, producer/run identity and binding feedback to the reviewed source snapshot.
- Feedback coordinates for reviewed versus staged proposed source, plus preservation of attribution and existing supplied fixes.
- Association of findings with extracted replacements and treatment of staged changes without an explanation.
- Supported extraction operations and exact treatment of additions/deletions, renames, modes, encodings and newlines. Deferring suggestion PRs does not itself decide extraction's representation envelope.
- In-memory return/error types and CLI artifact preservation, JSON receipts and output/error behavior.
- Inspection completeness for absent/multiple locations and all supplied fixes; preview truncation is separate from publication support.

Do not make removal identifiers, stale-deletion handling or standalone validation outcomes release gates for this milestone. The earlier broader design is retained as future direction in the [interface design](second-milestone-interface-design.md). D31 records the latest priority; D30 remains the broader product direction. The existing [specification](specification.md), especially R2/R3 and O2/O3, supplies governing source-fidelity contracts.
