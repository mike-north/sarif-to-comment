# Astra goal: deliver the happy path from findings to a GitHub review

Prepared and activated at the user's request on September 28, 2026. This is the assignment boundary for the second milestone. It supersedes the broader earlier authoring/correction/validation scope wherever they conflict.

## Goal

Enable an agent to create SARIF, add findings on lines or line ranges, inspect the current findings and fixes, incorporate staged Git changes as SARIF fixes, and publish the complete artifact as a GitHub draft review—without requiring an upstream SARIF producer or direct manipulation of SARIF structures. Provide the complete happy path through CLI subcommands and equivalent library functions, with human-readable and JSON CLI output. Preserve direct use of supported SARIF from upstream producers.

## Governing context

Read the current project instructions and:

- `docs/second-milestone.md`: current consumer outcome, boundaries and acceptance requirements.
- `docs/second-milestone-interface-design.md`: reviewed names and output contracts. Its prominently marked removal and standalone-validation sections are deferred, not delivery gates.
- `docs/design-decisions.md`: D31 establishes happy-path-first scope; D32 requires optional, freestanding authoring. D30 records the broader future direction. Relevant earlier decisions continue to govern faithful feedback/source/change representation.
- `docs/specification.md`: source and replacement contracts, including R2/R3 and the O2/O3 questions that still require concrete design. Historical status statements and full-product features do not override this assignment.
- `README.md`, `types/index.d.ts` and `docs/getting-started.md`: the existing public compatibility boundary.
- `docs/milestone-release-audit.md`, `docs/milestone-e2e-evidence.md`, `docs/suggestion-application-e2e.md` and `docs/npm-release-verification.md`: accepted baseline and evidence limits.

The baseline is the public npm package 0.1.1. The repository remains public by explicit user instruction. The completed first milestone and release setup must continue working.

## Required behavior and boundaries

The active operations are `init`, `add-comment`, `inspect`, `add-staged-changes` and `publish`, corresponding to `createSarifDocument`, `addSarifComment`, `inspectSarif`, `addStagedChangesToSarif` and the existing `publishSarifReview`. These names have received independent design review. Define the complete argument/result contracts before dependent implementation and document consequential design choices.

Authoring must be optional and freestanding. Ordinary SARIF is the interchange object/file, without mandatory authoring history, helper-only metadata, builder state or a private intermediate format. Upstream-produced SARIF must be usable for inspection and staged incorporation without initialization, and ready upstream SARIF must still publish directly. Both paths are first-class; usage frequency is unknown and need not be predicted. This is a modularity requirement, not a requirement to split npm packages.

The CLI uses file I/O; the library works with ordinary in-memory values. Share transformation and interpretation behavior rather than duplicating it. Implement `--format human|json` consistently, including handled failures. Inspection simplifies structure without discarding evidence: retain full findings, locations and included fixes, not only native-suggestion-compatible fixes. Only fix previews may be truncated, visibly and without changing source SARIF. Preserve legacy flag-only publication behavior.

Extract from the intended index snapshot relative to an explicit reviewed revision, not unstaged working-tree content. Preserve source associations, explanations and origins; do not invent reasoning or enlarge replacements to absorb nearby feedback. Independently applying supported extracted edits must reproduce the intended staged content. Define the operation/encoding/newline and feedback-association contracts honestly; unsupported meaningful changes must not be silently omitted. Deferring suggestion PRs does not by itself decide which Git operations can be represented during extraction.

Keep the existing whole-review checks, exact placement, native-suggestion fidelity, one-way draft publication and durable retry guarantees. Happy-path-first narrows the feature set, not correctness or failure safety.

## Explicitly deferred

Do not implement comment removal/correction, a broader proofreading loop, a standalone validation command/library function, suggestion PRs, review maintenance or a new release framework. Basic read-only inspection stays in scope. Existing publication-time validation stays mandatory. Do not make deferred selectors/deletion-concurrency/standalone-validation contracts prerequisites for finishing this increment.

## Engineering ownership

Astra owns planning, integration, acceptance and the completion claim. Use the existing `orchestrating-opus` skill: persistent Claude Code Opus implements cohesive assignments using native `/goal` and auto permission mode where supported. Opus owns its internal planning and tests-first repair loop. The user has explicitly authorized sending this repository's relevant material to Claude. Reuse suitable existing conversations after verifying no overlapping turn; record actual session/handle ownership and terminal evidence. An independent reviewer must scrutinize the integrated implementation.

Write behavioral tests before software changes, with meaningful failing evidence tied to intended outcomes. Use durable intent comments across abstractions. Preserve unrelated local changes, including the pre-existing `.claude/` research scaffolding. The current planning documents are intentional user-directed changes, not unexplained dirt to discard.

Resolve routine engineering choices independently. Record assumptions and remaining source/representation questions; raise only consequential ambiguities that cannot be resolved from the user's goal and existing contracts. No detailed implementation plan is prescribed here.

## Completion evidence

1. A complete authored-input flow through installed CLI and library surfaces, from initialization and line/range feedback through inspection, staged incorporation and actual GitHub draft publication. The demonstration must not hand-construct the SARIF scaffolding or bypass public interfaces.
2. A supported upstream-SARIF flow through inspection and staged incorporation without helper initialization, plus direct ready-SARIF publication compatibility.
3. Independent expected source locations and edited bytes. Exercise index/working-tree divergence, faithful line/range and fix association, and relevant coordinate/newline boundaries. Record what real GitHub readback/rendering/application proves separately from local fixtures and mocks. Coordinate live fixture writes and cleanup through the parent under the established authorization; never broaden to user review content.
4. Equivalent human/JSON CLI and library semantics, clean structured failures, honest artifact receipts and unchanged publication recovery behavior.
5. Independent review findings reconciled against the integrated source; appropriate lint, types, API documentation freshness, package installation and behavioral checks pass with no unexplained omissions.
6. Updated public declarations, generated API Extractor/API Documenter artifacts, README/getting-started examples and appropriate Changeset. Verify examples against the installed package. Preserve the existing pre-1.0 release guard and trusted-publishing pipeline. Parent retains Git delivery and npm release execution; do not invent a second release path.
7. A concise requirement-to-evidence completion audit and work record. Distinguish verified behavior, documented support limits, external blockers and future features. A green unit suite alone is not completion of the end-to-end goal.

Goal preparation/activation does not itself prove implementation progress or completion. Do not claim success until the selected outcome and these evidence obligations are met.
