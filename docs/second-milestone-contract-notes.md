# Second-milestone contract notes

September 28, 2026. This is Astra's local contract analysis while the authorized Opus launch awaits approval reconsideration. It distinguishes settled constraints from proposed engineering defaults. It is not an adopted implementation contract and does not claim software progress. The [goal](second-milestone-goal.md), current scope and interface design govern; the forthcoming complete contract must settle argument/result types before dependent implementation.

## Settled constraints and scope interpretations

1. The active operations are `createSarifDocument`, `addSarifComment`, `inspectSarif`, `addStagedChangesToSarif` and existing `publishSarifReview`, with their selected CLI commands. No mandatory builder, authoring ID, initialization marker or private interchange representation may gate downstream work (D32).
2. Immutable library transformations receive and return ordinary SARIF values. CLI file I/O is a distinct responsibility. Inspection shares one interpretation for human and JSON rendering; the library does not need local artifacts or credentials to author feedback.
3. Source coordinates are one-based inclusive lines/ranges at an explicit source snapshot. Extraction uses the intended index, never unstaged content. An independently applied supported edit set must reproduce the staged bytes (R2).
4. Feedback and edits are separate facts. A replacement must not expand to absorb nearby feedback. Several explanations inside one replacement may accompany one rendered suggestion with their individual origins (D4/D5). No explanation may be invented from staged code.
5. A proposed creation is not an edit to a fictitious empty reviewed file, and deletion is not emptying. D23 selects result-level operation properties referencing standard artifacts. Feedback about a new file is verified against the proposed content; deletion feedback refers to the existing source (D6/D20).
6. Current publisher guarantees and its bounded operation profile remain intact. The parent interprets this selected increment as allowing faithful extracted file proposals that the publisher still explicitly blocks. The live happy path uses supported existing-file fixes. This does not classify file additions/deletions as invalid or remove them from the broader product.
7. The parent confirmed strict extraction is sufficient under the latest happy-path-first priority. Best-effort repair workflows are deferred; actionable failure evidence and applicable D10 artifact preservation are not.
8. Inspection is not publication readiness. It must retain full explanations, every source association and every included fix, even when the publisher cannot accept them. Only fix previews can shorten, and omission must be explicit without mutating the SARIF.
9. Existing flag-only publication remains compatible. Every handled JSON-mode outcome is one JSON document on stdout, with meaningful exit status. Removal/correction selectors, standalone validation and suggestion PRs are not prerequisites.

## Concrete contract consequences

### Captured inputs and immutable source

Asynchronous extraction must capture the input JSON before awaiting Git, following the existing publisher's no-getter/no-silent-coercion discipline. Otherwise a caller could mutate feedback while the staged snapshot is read. A read of index paths followed later by mutable working-tree contents cannot meet the contract. The implementation must establish one index snapshot and read immutable blob identities from it; the exact Git mechanism is an engineering choice.

**Discriminating case:** reviewed text is `a\nb\nc\n`; staged text is `a\nB\nc\n`; working-tree text is `a\nUNSTAGED\nc\n`. Applying the extracted change to the reviewed bytes produces the staged bytes, and the output contains neither `UNSTAGED` nor an edit to an untouched line. A later change to the caller's input object cannot alter the captured operation.

### Association does not follow proximity

The current publisher already coalesces identical replacements across results while retaining separate explanations and origins. Extraction can use ordinary SARIF fixes to express that relationship without a new association service. The actual changed scope governs eligibility; native suggestion expansion to whole lines must not be confused with arbitrary surrounding diff context.

**Discriminating case:** two independently attributed findings inside one replacement keep their own messages and locations and yield one proposal. A third finding on the immediately adjacent unchanged line remains feedback-only. Neither its location nor the replacement grows to collect it.

**Unresolved engineering detail:** define exact boundary behavior for zero-length insertions, a finding spanning several distinct replacements, and a result that already has a supplied fix. The complete contract must preserve supplied alternatives and prevent silent semantic reassignment.

### Neutral descriptions are not reasoning

Unexplained staged changes must not disappear. A candidate representation is an explicitly machine-originated result with factual text identifying the staged operation and saying no explanation was supplied. It must not invent a defect, intention, benefit, severity or human attribution. Another possible representation is an unassociated operation within a documented extension; the implementation contract must choose a schema-valid form and explain its inspection/publication consequences.

This remains a proposal, not an adopted rule. It is an engineering representation question under the settled prohibition on invented reasoning.

### Source binding must be expressible in ordinary SARIF

Standard `versionControlProvenance` can preserve an immutable revision, but the schema requires `repositoryUri`; a revision alone cannot simply be inserted there. Existing upstream SARIF without provenance is interpreted under explicit downstream reviewed context. The authoring contract must distinguish those two cases rather than inventing a hidden initialization dependency.

**Discriminating case:** authored feedback bound to revision A must not silently become feedback about B merely because a later command supplies B. An upstream result with no provenance must remain usable under the explicitly supplied reviewed revision. A separate historical run must not be flattened or reassigned to the current staged change merely because it names the same path.

**Remaining design:** required versus optional source-binding arguments at initialization, explicit run selection for addition, and the corresponding CLI flags. No new user product decision has been identified for these routine choices; document the choice and test it.

### File-operation semantics are independent of publisher support

The existing namespace `properties.sarifToComment.proposedFileChanges` is recognized by the publisher and explicitly blocked. The earlier example documents a candidate `create` operation referencing `artifactIndex`, but its exact schema is not adopted. Reusing a result-level extension under D23 can retain creation/deletion intent without weakening that block.

**Discriminating cases:** creating an empty file, emptying an existing file, deleting that file, and replacing text in it must remain distinguishable. A new-file finding at a valid proposed line can be verified; one beyond the proposed end fails. Neither requires fabrication of a reviewed line. Inspection shows every proposal; publication never silently drops unsupported operations to send the remaining review.

**Remaining design:** exact extension fields and artifact contents; supported regular-file modes and encoding/newline envelope; treatment of symlinks, submodules, conflicts, intent-to-add and mode changes. Git's index describes paths, modes and blobs rather than a durable rename-intent object; any chosen rename treatment must be explicit and faithful, not inferred as proof of user intent.

### Output preservation is an observable contract

Staged incorporation writes a distinct output artifact. D10 requires archiving previous normal output based on its recorded original creation time and ensuring a failed attempt leaves no stale normal success path. The failure receipt must distinguish a preserved prior artifact, an absent new output and any actual diagnostic artifact. A generic overwrite switch cannot bypass this rule.

**Discriminating case:** a successful extraction creates `enriched.sarif`; the next attempt fails on a meaningful unsupported staged operation. The old result remains under a non-clobbering historical name, the normal output is absent, the exit status fails, and JSON does not claim a new SARIF output. Invalid invocation that never selects a valid operation must not accidentally move unrelated files.

**Remaining design:** exact archive naming/collision rules, birth-time fallback, operation-start boundary and concurrent writer behavior. These are implementation-level choices constrained by preservation, not a deferred removal/proofreading protocol.

## Proposed responsibility split

After the complete shared contracts are agreed:

- Authoring and shared SARIF interpretation: pure document creation/addition plus complete inspection; no Git/GitHub or CLI file management.
- Staged incorporation: explicit repository/index snapshot, source verification, exact proposed edits and faithful merge with supplied feedback. Own its Git fixtures and independent apply oracle.
- Public surface and artifacts: CLI dispatch/file handling/human-JSON presentation, package exports, declarations, generated API docs, installed examples and Changeset. One owner integrates shared entry files.
- Existing publication: preserve its contract and sources unless a necessary integration change is identified and regression-tested; no new operation rendering in this increment.
- Independent reviewer: separate conversation, final integrated source identity, meaningful tests and installed-user paths. Parent owns live fixture writes and release delivery.

These are responsibility boundaries, not prescribed algorithms or a requirement for additional packages. Opus should own implementation decomposition within the agreed contracts.

## Next design deliverable

The contract-design ticket must choose complete argument/result shapes, CLI flags and structured outcomes; resolve the engineering details above; and attach testable examples. Astra will reconcile it with these constraints before dependent implementation. No software implementation has started while Claude authorization remains unresolved.
