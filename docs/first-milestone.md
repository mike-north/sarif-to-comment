# First milestone: ready SARIF to a GitHub draft review

> **Historical scope record (reconciled September 28, 2026).** The npm deferral below was later superseded: the milestone was released as 0.1.0 and 0.1.1 (see [npm release verification](npm-release-verification.md)). For current status, see [Current status and reconciliation](status.md).

The user selected this milestone because existing projects need only this capability to become unblocked. Deliver the ready-SARIF publication path before staged-change enrichment or suggestion-PR support. This is the initial usable increment of the product, not a claim to implement the full specification.

## Consumer outcome

A caller supplies a ready SARIF file, the destination PR, and the reviewed commit. The tool validates the complete contribution and creates one GitHub draft review containing its general feedback, eligible inline comments, and supported existing-file suggestions. The review body and inline comments are supplied in one create-review request. After a lost response, the tool uses the persisted publication marker to establish whether that initial review was created before considering another create request.

Publication is one-way under D29. No review maintenance, human-edit reconciliation, GitHub-to-SARIF synchronization, or re-review lifecycle is part of the milestone. A new SARIF file may create a separate review. The marker is hidden in normal rendering, not secret. A lookup miss after an uncertain response is not proof that creation failed.

## Acceptance tests before implementation

These are required behavioral cases for executable tests, not tests already written or passed.

1. Feedback-only SARIF creates a draft review without requiring a fix, staged changes, or positive approval metadata.
2. General feedback goes in the review body. Supported source-associated feedback becomes inline comments where eligible; valid non-inline feedback retains an exact reviewed-source link in the general body.
3. A supported existing-file replacement becomes a native suggestion with its explanation, attribution, reviewed source, and intended replacement content preserved.
4. Multiple comments and the body are passed together in one create-review request; successful creation does not trigger follow-up assembly of those comments.
5. Invalid SARIF, inconsistent source references, unsupported meaningful changes, or an explicit approval hold block the entire publication before any remote write. No item is silently dropped. The explicit approval override bypasses only the hold.
6. A simulated create that succeeds remotely but loses its response is rediscovered through the same persisted marker without a duplicate create. Delayed visibility remains an unresolved delivery outcome rather than permission to duplicate.
7. A completed publication is not rewritten when a human changes its draft content. Supplying a new SARIF artifact can produce a separate review.
8. The reviewed commit remains explicit when the author's branch advances. Historical-reference validity does not by itself establish native-suggestion eligibility.

## Delivery evidence and boundaries

### Primary release gate: correct source placement

The user identified highly reliable placement of feedback on the appropriate code line as the milestone's central requirement. A successfully created review is insufficient evidence. Incorrect inline placement is a release-blocking defect.

- Each fixture must specify its intended reviewed commit, file, source line or range, and the actual source text it means. Expected placement must be authored independently of the mapping implementation; a test must not compute its expectation with the same mapper it is testing.
- Exercise first and last lines, additions, deletions, unchanged context, old/new diff sides, multiple hunks, multiple files, adjacent replacements, and multiline ranges. Include insertions that shift later line numbers, repeated identical source lines, non-ASCII text, CRLF, and missing final newlines. Renames and historical revisions must either have verified support or produce an explicit unsupported outcome; never guess.
- Check feedback-only locations and suggestion replacement ranges separately. A suggestion's replacement range must not be enlarged to collect nearby feedback. Findings inside and outside that range must retain their correct associations.
- Verify that non-inline fallback is used only for a valid reviewed-source association and links to the exact source revision. A nonexistent line or ambiguous mapping must not quietly become a comment on a nearby line or on a different revision.
- Use a fixed reviewed commit and a deliberately advancing author branch to verify that publication cannot silently retarget feedback. Current-branch applicability and historical source identity are separate assertions.
- Include negative controls that deliberately shift a line, select the wrong diff side, or swap the target file, proving the tests detect plausible placement defects. Local fixtures and adapter mocks alone do not establish GitHub placement.
- Run representative end-to-end cases against real GitHub PRs: publish the complete draft, read back its comments and reviewed commit, and compare their file, side, line/range, and associated source text with the independent expected locations. Inspect representative rendered cases as well. Record the tested host behavior and support envelope; cleanup must target only the test's own artifacts.

The milestone may declare a bounded support profile, but every supported case must preserve exact placement. Request rejection or a clear diagnostic is preferable to successful publication on the wrong code. Practical limits and unsupported cases must be visible to callers.

Define the supported SARIF/replacement profile and caller interface before implementing them. Use behavior tests first, followed by implementation and independent review, then verify a representative complete draft review against GitHub. The single-request API shape is verified in the official documentation; failure atomicity and practical request limits are separate evidence obligations. Do not introduce per-comment recovery merely because the API internally stores several comments.

Staged extraction, file-creation/deletion publication, suggestion PRs, grouped-change publication, and suggestion cleanup follow in later increments. Inputs requiring an unavailable faithful presentation must fail with actionable diagnostics. Immediate submission remains part of the full product specification; draft publication is the selected initial consumer outcome. NPM publication remains explicitly deferred.

## Selected consumer interfaces

The user selected both an importable library and a CLI. Direct integration by SARIF-producing projects is the primary use: the library accepts SARIF in memory without requiring a temporary file. The CLI accepts a SARIF file on disk and delegates to the same whole-review validation, placement, rendering, and publication core. Tests must establish equivalent placement and failure behavior through both interfaces.
