# First milestone engineering plan

> **Historical engineering plan (reconciled September 28, 2026).** The npm deferral below was later superseded by the 0.1.0 and 0.1.1 releases. For current status, see [Current status and reconciliation](status.md).

The engineering lead owned contracts, integration and independent verification. The implementers wrote behavioral tests before implementation and repaired their own work. Governing scope is docs/first-milestone.md and D29: initial one-way draft publication, one body-plus-comments create request, whole-review validation, durable identity before any uncertain create. NPM publication is deferred.

## Consumer boundary

The user selected both an importable library and a CLI. The library is primary and accepts an in-memory SARIF value; the CLI reads a SARIF file and delegates to the same validation, rendering and publication implementation. Diagnostics, placement, and publication outcomes must agree. No serialization to a temporary SARIF file is required of library callers.

## Sequence and release evidence

1. Establish exact source placement as a private internal contract. Independently authored source/patch fixtures state commit, file, side, inclusive range and literal text. Inspect the initial behavioral failures, then continue to implementation. Wrong-line/side/file controls establish fixture discrimination.
2. Define a bounded ready-SARIF profile and library result/error contracts. Add whole-review rendering and validation tests before code, including unsupported meaningful inputs, approval-only override, and exact unchanged-source fallback links. Native suggestions retain their own replacement ranges.
3. Add durable initial-publication state and GitHub transport tests before implementation. Persist identity and sending state before network creation; uncertain outcomes only rediscover, and lookup misses remain uncertain. Completed publication does not restore human changes. Add thin CLI parity tests.
4. Have an independent reviewer examine stable source hashes. Reproduce findings, require regressions and repair by the original author, and reconcile review coverage.
5. Run representative real GitHub complete-draft publication/readback and rendered-placement checks against isolated synthetic fixtures in the authorized mike-north/doc-linter repository. Exercise branch advance and source text identity. Record host support limits and clean only owned artifacts. Mocks are not release evidence for actual GitHub placement.

## Work allocation

The first milestone was built by three implementers with disjoint file ownership:

- **Placement:** `src/placement.cjs`, its tests and fixtures.
- **Literal SARIF replacements:** `src/replacements.cjs`, its tests and fixtures. This covers exact edit application and faithful minimal whole-line suggestion expansion, independent of diff eligibility.
- **Durable publication:** `src/publication.cjs`, its tests and fixtures. This covers exclusive durable intent, a single create carrying the body and every comment, lost-response discovery, conservative uncertainty, restart and concurrency, and no restoration of human edits.

For each module, the tests-first checkpoint was inspected before the implementation was accepted. A separate read-only reviewer checked stable source and test snapshots, beginning with placement:

- source SHA-256 `4597d8ab3201baa09807609d652da3e8f189136c0b058ef5135064b372d16ce1`;
- test SHA-256 `ed014dfba87106cbc35abda4454b93957de37b02e89c86b1aca43cbbd19b5486`.

Implementation tools were limited to file inspection and editing and bounded test commands, under normal permission checks with no bypass. No external write authority was delegated to them. Real GitHub writes stayed with the supervising verifier. The user explicitly authorized sending the repository's relevant material to the AI coding service used for implementation and review. The narrative of the individual sessions is in Git history, and the results are in [work-record.md](work-record.md).

### Live batch validation control

Before the valid complete-draft case, send a separate uniquely marked bounded test request with several valid anchors followed by one deliberately invalid final anchor. Observe whether rejection leaves any earlier comments or a marker-bearing partial draft. Then verify exact cardinality and placement for the valid batch. This establishes only observed batch-validation behavior, not failure atomicity for arbitrary transport/server failures. Include literal suggestion content with backticks/fences where possible; longer Markdown fences must not be assumed to preserve native-suggestion semantics without host evidence.
