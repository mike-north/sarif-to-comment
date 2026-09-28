# First milestone engineering plan

Astra leads contracts, integration and independent verification. Persistent Claude Code Opus writes behavioral tests before implementation and repairs its own work. Governing scope is docs/first-milestone.md and D29: initial one-way draft publication, one body-plus-comments create request, whole-review validation, durable identity before any uncertain create. NPM publication is deferred.

## Consumer boundary

The user selected both an importable library and a CLI. The library is primary and accepts an in-memory SARIF value; the CLI reads a SARIF file and delegates to the same validation, rendering and publication implementation. Diagnostics, placement, and publication outcomes must agree. No serialization to a temporary SARIF file is required of library callers.

## Sequence and release evidence

1. Establish exact source placement as a private internal contract. Independently authored source/patch fixtures state commit, file, side, inclusive range and literal text. Inspect initial behavioral failures, then resume the same Opus conversation for implementation. Wrong-line/side/file controls establish fixture discrimination.
2. Define a bounded ready-SARIF profile and library result/error contracts. Add whole-review rendering and validation tests before code, including unsupported meaningful inputs, approval-only override, and exact unchanged-source fallback links. Native suggestions retain their own replacement ranges.
3. Add durable initial-publication state and GitHub transport tests before implementation. Persist identity and sending state before network creation; uncertain outcomes only rediscover, and lookup misses remain uncertain. Completed publication does not restore human changes. Add thin CLI parity tests.
4. Review stable source hashes in an independent reviewer conversation. Reproduce findings, require regressions and same-worker repair, and reconcile review coverage.
5. Run representative real GitHub complete-draft publication/readback and rendered-placement checks against isolated synthetic fixtures in the authorized mike-north/doc-linter repository. Exercise branch advance and source text identity. Record host support limits and clean only owned artifacts. Mocks are not release evidence for actual GitHub placement.

## Worker ledger

- Role: primary placement tests and implementation worker.
- Conversation: `41f7934f-e3ed-46c7-88ee-027bf059e5a7`.
- Workspace: `/Users/mnorth/Development/sarif-to-comment`.
- CLI: Claude Code 2.1.283; selected model alias `opus`; initialized model pending event inspection.
- Turn 1 scope: `test/placement.test.cjs`, `test/fixtures/placement/**`, interface-only `src/placement.cjs`. Tests-first checkpoint; no passing implementation authorized yet.
- Turn 1 process handle: `48511`.
- Prompt and raw stdout/stderr: `logs/opus/placement-01.*` (ignored). Initial red evidence: `logs/opus/placement-red.txt`.
- Permission mode: `acceptEdits`, normal permission checks, no bypass. Tools limited to file inspection/editing and bounded test commands. No external write authority delegated in this turn.
- Launch arguments: `claude -p --model opus --session-id 41f7934f-e3ed-46c7-88ee-027bf059e5a7 --output-format stream-json --verbose --permission-mode acceptEdits --permission-prompts none --tools Read,Write,Edit,Glob,Grep,Bash --allowedTools 'Bash(node --test *)' 'Bash(mkdir -p test*)' 'Bash(mkdir -p src*)'`.

### Launch authentication evidence

Turn 1 process 48511 terminated with exit 1 before any model call: the sandbox could not access Claude authentication. A read-only status check outside the sandbox confirmed the existing Claude login is valid. The proposed same-conversation resume was then rejected by automatic approval review because transmission of repository prompts and potentially private contents to the external Claude service lacked sufficiently explicit destination/data authorization in its context. No alternative route was attempted. Parent lead received the precise reason and request for explicit authorization or authoritative existing evidence. No test or implementation files have been written by the worker. Turn 2 log paths were reserved but no process was launched.

### Worker initialization confirmed

After explicit user authority and successful approval reconsideration, the same reserved conversation was initialized successfully (the auth-failed original had not persisted). Raw system event confirms model `claude-opus-5-5`, conversation `41f7934f-e3ed-46c7-88ee-027bf059e5a7`, normal `acceptEdits` permissions. Active process handle: `17348`; logs: `logs/opus/placement-03.*`. The user explicitly authorized sending this repository's relevant material to Claude; exact wording is preserved in work-record.md.

### Live batch validation control

Before the valid complete-draft case, send a separate uniquely marked bounded test request with several valid anchors followed by one deliberately invalid final anchor. Observe whether rejection leaves any earlier comments or a marker-bearing partial draft. Then verify exact cardinality and placement for the valid batch. This establishes only observed batch-validation behavior, not failure atomicity for arbitrary transport/server failures. Include literal suggestion content with backticks/fences where possible; longer Markdown fences must not be assumed to preserve native-suggestion semantics without host evidence.

### Active assignments after first inspected checkpoint

Placement worker same conversation `41f7934f-e3ed-46c7-88ee-027bf059e5a7`, process `58838`, turn 04: correct documented context-side semantics, add boundary/provenance fixtures, preserve new red run before implementing mapper. Scope unchanged. Raw prompt/events/stderr: logs/opus/placement-04.*.

The tests-first inspect/resume loop now works. A disjoint second Opus worker handles literal SARIF replacement semantics without touching placement:
- Conversation: `c31b982d-f3bf-461a-acc7-eb4ced94b037`.
- Process: `59748`, tests-only turn 01.
- Owned files: `src/replacements.cjs` interface-only stub, `test/replacements.test.cjs`, `test/fixtures/replacements/**`.
- Scope: exact edit application and faithful minimal whole-line suggestion expansion, independent of diff eligibility. No SARIF artifact parsing, remote writes, or shared-file edits.
- Raw prompt/events/stderr: logs/opus/replacements-01.*; planned red evidence logs/opus/replacements-red.txt.
- Launch: Claude Code `--model opus --session-id c31b982d-f3bf-461a-acc7-eb4ced94b037`, same limited tools and normal acceptEdits permissions as placement. User's explicit repository-sharing authority applies.
- Stop: lead-inspected tests-first checkpoint before passing production implementation.

A third disjoint worker covers the other independent release-critical boundary while mapper and replacement work proceed:
- Conversation `e9247b54-242b-45d6-9f34-0d74a7bc48ba`, process `51250`, publication tests-only turn 01.
- Owns `src/publication.cjs` interface stub, `test/publication.test.cjs`, `test/fixtures/publication/**`.
- Receives already validated prepared review through a private boundary; tests exclusive durable intent, single body-plus-all-comments create, lost-response discovery, conservative uncertainty, restart/concurrency and no human-edit restoration. No SARIF rendering or real GitHub operations delegated.
- Raw logs/prompt: logs/opus/publication-01.*; planned red evidence logs/opus/publication-red.txt.
- Same Opus alias and normal acceptEdits permissions; explicit user repository-sharing authority applies. Stop before passing implementation for lead inspection.

### Independent placement review

Read-only reviewer conversation `dac76d06-ff9e-486f-a27d-d5f6256ca3b9`, process77685, reviews the stable placement source/test snapshot separately from authors. Source SHA4597d8ab3201baa09807609d652da3e8f189136c0b058ef5135064b372d16ce1; test SHAed014dfba87106cbc35abda4454b93957de37b02e89c86b1aca43cbbd19b5486. Tools restricted to Read/Glob/Grep, unrelated MCP and slash-command discovery disabled, normal dontAsk permission controls. Raw prompt/logs logs/opus/placement-review-01.*. This is subsystem review only; final assembled review remains required.
