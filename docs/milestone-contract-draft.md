# Ready-SARIF publisher: engineering contract draft

This is a proposed bounded implementation profile for the selected milestone. It does not supersede D29 or extend publication to staged extraction, file proposals, grouped application, or review maintenance. It is not yet an implemented or released interface. The library and CLI scope is user-selected; the exact names below are engineering proposals to be finalized against tests.

## Consumer shape

The primary library operation accepts an in-memory SARIF document, destination owner/repository/PR, explicit full reviewed commit, a local publication-state location or durable store, and options. The CLI reads JSON and calls that operation. Source retrieval is through repository snapshots; SARIF URIs cannot authorize arbitrary local reads or remote fetches. A transport boundary supplies authenticated GitHub reads and the single create-review operation. A caller-provided transport is useful for tests; tests using it do not demonstrate GitHub behavior.

Normal completion returns the created/recovered review identity and destination URL, with warning/report text. Invalid or unsupported input returns an actionable Markdown diagnostic and no remote writes. Uncertain delivery is a distinct outcome, not ordinary validation failure or permission to create again. Local I/O and transport failures retain their operational cause. The CLI maps validation/operational/uncertain outcomes to nonzero exits; diagnostic wording and placement come from the shared core. Exact public structured diagnostic codes remain unfrozen under D13.

## Placement boundary

A source association consists of a full commit, normalized repository-relative path, inclusive line range, and the actual text at that snapshot. A GitHub anchor separately identifies path, LEFT or RIGHT, and inclusive range within the verified diff surface. The mapper may establish equivalence; it must never assume identical numbers mean identical source.

The complete old/new file texts and diff provenance must agree. Count actual lines, preserving non-ASCII characters, CRLF identity and absence of a terminal newline; a terminal newline does not create an extra addressable source line. Validate coordinates before classifying inline eligibility. A malformed or truncated patch is not evidence that nearby lines are safe to use. Unsupported renames and historical inline cases produce explicit limitations; valid historical source may retain a pinned general link.

A run's standard version-control provenance can identify its source revision. The exact convention for mapping that provenance to base-side findings must be fixed before publishing LEFT comments. The top-level reviewed commit remains the review's commit regardless of current branch advance. A deleted line cannot be invented in the reviewed head; base-side source requires explicit verified base provenance. Tests of private mapping can cover both sides before that input contract is adopted.

## Initial SARIF profile to implement and test

- Validate SARIF 2.1.0 against its standard schema with an off-the-shelf validator, separately from policy checks.
- Preserve each run's producer identity, result explanation, rule identity and available meaningful attribution. Text and Markdown are not interchangeable without a rendering rule. Message-ID lookup must either resolve faithfully or explicitly reject; it must not silently discard a finding.
- Support ordinary feedback with no locations and supported physical source locations. Multiple locations, related locations, flows, attachments, and unfamiliar meaningful extensions require an explicit support or rejection rule. Context-only metadata may be a warning when faithful publication remains possible.
- Resolve relative artifact URIs and indexed artifacts consistently, rejecting contradictory identities, traversal, absolute paths, unsupported schemes and ambiguous encodings. No input-driven local filesystem or network reads.
- Start native suggestions with one unambiguous complete-line replacement in an existing text file. Multiple replacements or alternative fixes need an explicit faithful presentation rule; do not silently choose one. The selected support profile can reject them with repair instructions.
- Retain feedback within a shared replacement exactly once with all explanations/origins; nearby feedback stays separate. Identical replacements are not an excuse to discard explanations. Overlapping incompatible replacements block the review.
- Column/byte-offset regions, binary content, replacement newline transformations, empty-range insertions and file operation extensions require explicit handling. Reject unsupported meaningful cases before any write; no approximate suggestion ranges.
- Approval metadata remains optional. Adopt one documented namespaced hold convention, with unknown/malformed values handled explicitly. Override bypasses the declared hold only.
- Document practical finite input/comment/request bounds. Exceeding them blocks complete publication without truncation or per-comment assembly.

## Durable publication state

Use one stable identity for the review and one request containing its body and every inline comment. A logical invocation has a persisted input/destination fingerprint so retry cannot accidentally publish changed input under the old identity. A new logical invocation may use a new identity even for the same PR. This is delivery identity, not a review-maintenance database.

Before network creation, persist both the marker and a state proving that sending may have started. A process crash at that boundary is conservatively uncertain. Creation is attempted at most once for an uncertain identity; subsequent operations search paginated reviews for its marker and verify intended destination, author and reviewed commit. A missing marker or a temporarily failed lookup remains uncertain. Multiple matching candidates are an ambiguity, not permission to choose arbitrarily.

A durable completed receipt ends publication responsibility and returns without rewriting human edits. Recovery does not restore missing comments or markers. Marker identity alone must not be described as proof of untested remote atomicity. Define evidence for completion of the supported single request without using content comparison as permission to repair human changes.

Concurrent callers sharing one state record require exclusive claiming before send. Exclusive file creation or an equivalent store compare-and-set should reject a simultaneous sender. A stale lock cannot be automatically stolen if doing so could issue a duplicate request; report unresolved state with recovery guidance. Prove restart behavior using independent processes or fresh instances and on-disk state, rather than only process-local mocks.

## Required real-host evidence

An isolated synthetic PR must contain independently authored source files and expected locations: base deletion, new addition, context, first/last line, multiple hunks/files, line shifts, and a multiline suggestion. Publish a body plus all comments in one request. Read back reviewed commit, file, side/range or trustworthy equivalent source coordinates, and source text. Inspect representative browser rendering. Then advance the branch deliberately and verify unchanged reviewed identity and conservative suggestion applicability. Preserve raw responses and provenance; clean only owned draft review/PR artifacts. These observations define the release support envelope, not a blanket GitHub atomicity guarantee.

## Common producer compatibility and exact replacement semantics

The bounded profile must be useful to real SARIF producers; reject-for-convenience is not the goal. Implement ordinary message-ID resolution, URI-base and artifact-index references, and faithful column-based text replacements. GitHub's whole-line suggestion anchors do not require rejecting a substring edit: apply the precise SARIF source slice, then preserve untouched prefix/suffix when expanding its presentation to the necessary full source lines.

The [normative SARIF 2.1.0 specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html), sections 3.14.27, 3.30.5–10 and 3.57, governs these fixtures: absent startColumn means 1; absent endLine means startLine; endColumn is exclusive; an omitted endColumn ends before the newline sequence. A line-only deletedRegion therefore does not consume its newline. Equal start/end coordinates represent insertion. charOffset/charLength are a separate coordinate form, and simultaneous coordinate forms must agree. columnKind distinguishes UTF-16 code units and Unicode code points. Include supplementary-plane characters before edits, CRLF and missing-final-newline cases to expose arithmetic mistakes.

Source feedback coordinates and replacement presentation boundaries are distinct. Test the exact edited text first, then the minimal faithful suggestion range and preservation of untouched text. Unsupported boundary cases require a concrete impossibility or unverified-host explanation rather than blanket rejection of common producer features.

## Base-side diff provenance

GitHub PRs show a three-dot/merge-base diff, not necessarily a diff from the current base-branch tip. GitHub further documents that compare and PR pages can calculate different merge bases after the base moves. Therefore `base.sha` alone is not authority for LEFT/deleted source, and a fresh comparison endpoint must not be assumed identical to the PR's authoritative diff. Resolve old-source provenance against the actual diff and verify literal source text. Test independently advancing the base branch as well as advancing the head. If source provenance cannot be established, decline the unsupported inline placement rather than guessing an old commit. Sources: [GitHub branches](https://docs.github.com/en/pull-requests/reference/branches), [GitHub pull requests](https://docs.github.com/en/pull-requests/reference/pull-requests).

### Bounded old-source verification strategy

Reconstruct the complete old file from the authoritative PR diff and pinned reviewed-head blob. Require exact equality with the complete blob at the explicitly declared old-source revision before treating that source as LEFT provenance. Preserve CRLF and no-newline markers; reject omitted, truncated or inconsistent patches. This verifies file content against the actual diff without substituting `base.sha` or a fresh compare merge base. Context that maps faithfully to RIGHT retains the original source commit/range in its source association. This strategy still needs executable and real-host evidence.

### Column-kind and character-offset constraints

Normative SARIF §3.14.27 requires `columnKind` for nonempty text-analysis runs and declares no default; the Errata01 schema likewise has no default, although it does not enforce the conditional requirement. Do not assume UTF-16 when producers omit it. A documented compatibility treatment may safely handle line-only or BMP-unambiguous regions without choosing differing units; non-BMP column ambiguity requires a clear diagnostic or an explicit caller convention.

`charOffset` is zero-based and omitted `charLength` means a zero-length insertion; offsets include newline characters and exclude a leading byte-order mark. Simultaneous offset and line/column coordinates must independently agree. The inspected normative sections do not unambiguously establish character-offset units as Unicode code points versus UTF-16 code units; do not silently infer this from `columnKind`, which expressly concerns columns. Primary producer evidence remains under investigation before adopting that behavior.

### Minimal local state implementation direction

Require a caller-chosen local publication state path for the initial library/CLI profile. Use a fresh path for a new logical publication and retain it across retries/restarts. After whole-review validation, exclusively create and durably flush a complete intent record already declaring that sending may have started. Only the invocation that successfully created that record may issue the single create-review request. Every invocation finding an existing record can only return its completed receipt or investigate its stable marker; it cannot send again. A crash after intent persistence but before sending is deliberately uncertain rather than risking duplication.

This removes the need for stale-lock stealing or a generic store/lease service. Tests must cover simultaneous fresh callers, interrupted initial writes, crashes around the send boundary, failed receipt persistence, fresh-process recovery, mismatched input reused with the same state path, and delayed visibility. The state record must bind destination, authenticated author, explicit reviewed commit and input/request fingerprint. A completed receipt is persisted atomically and ends review maintenance responsibility. The caller must preserve the state file; an ephemeral process-local cache is insufficient.
