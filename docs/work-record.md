# Design work record

## September 27, 2026

The user authorized repository work as their delegate, including settings, branch-protection changes, GitHub workflow changes and direct pushes to the default branch. This is authority to perform work when needed, not a requirement to modify those settings. NPM publication is explicitly deferred.

The user prefers SSH for Git operations. A missed 1Password approval caused one signing-agent failure during the recovery experiment; a subsequent retry succeeded. Do not change transport preference merely because an interactive signing approval takes time.

Before implementation, the user explicitly redirected the work to scrutiny of the domain model. The goal is the simplest model and surface that satisfy the full product requirements, using their supplied practical domain-modeling guide and the previously invoked deep-design skill. Astra is assigned to challenge concepts, assumptions, identities, boundaries, scenario coverage and possible collapses. A first milestone is to be refined from that work; product implementation has not begun.

The live GitHub interaction experiments are recorded separately in the grouped-suggestion, companion-PR lifecycle and publication-recovery reports. They establish specific host behaviors, not an implemented converter or durable publisher.

The user subsequently made the one-way publication boundary explicit and requested that it be recorded: SARIF becomes an initial GitHub review; no human-edit reconciliation, GitHub-to-SARIF synchronization, review maintenance, or re-review lifecycle. New SARIF may create a separate new review. D29, the brief, and R14 record this constraint; the independent comparison is annotated so its earlier recovery recommendation cannot silently broaden scope. GitHub documentation confirms that one create-review request can carry the body and inline comments, either pending or immediately submitted. This was a documentation check, not a new live write experiment or proof of failure atomicity.

The user accepted the ready-SARIF-to-draft-review first milestone and stated that waiting projects need only that increment to be unblocked. [First milestone](first-milestone.md) records the consumer outcome, tests-first acceptance cases, later increments, and delivery evidence. No product code or executable tests have yet been written; the acceptance cases are the specification for that work.

The user emphasized rigorous testing and exceptionally reliable placement on the appropriate source line. The milestone now treats exact placement as the primary release gate, with independently authored expected locations, boundary and diff-side cases, wrong-placement negative controls, and real GitHub readback/rendering evidence in addition to local tests. These are planned verification requirements, not completed validation.

The user explicitly selected the orchestrating-opus skill for Astra to lead with Claude Code as implementor. Astra milestone lead was dispatched as `/root/astra_milestone_lead` using `gpt-6-astra`, with a fresh bounded brief and the current milestone/specification documents. Astra owns engineering contracts, tests-first evidence, worker coordination, independent review, and verification; a persistent Claude Code Opus session owns code implementation. The caller interface (CLI, importable library, or both) remains a pending user question. Independent internal placement contracts and tests can proceed without freezing that public choice. Worker session identities and actual launch/completion evidence must be recorded by the lead; this dispatch alone is not evidence that Opus has started or that any implementation exists.

### Astra implementation launch

The user selected both library and CLI, with direct library integration primary. Accepted scope is recorded in first-milestone.md. Concrete sequence and worker ledger are in milestone-engineering-plan.md. Opus conversation `41f7934f-e3ed-46c7-88ee-027bf059e5a7` is actually running turn 1 on process handle `48511`, writing independent exact-placement fixtures and behavioral tests only before implementation. Raw logs remain in ignored logs/opus. No release claim is implied by launch.

### Opus launch limitation

The initial process terminated before any model call because the sandbox could not access the existing keychain login. A normal read-only auth-status check outside the sandbox confirmed login is present. Automatic approval review then rejected same-session resume because its context lacked explicit authorization to transmit this repository's relevant contents to Claude. The lead has been notified; no workaround or replacement coding agent was used. Contracts can continue while the authority question is resolved. Tests-first checkpoint is not yet produced.

### Explicit Claude authority and initialized worker

The user stated: “I give explicit authorization to send this repository’s relevant material to Claude. Claude is as trusted as Codex. So, you should feel comfortable sharing whatever information with it needs to be shared.” This covers necessary repository material for the requested Opus implementation and independent review work.

Approval reconsideration succeeded. The first resume found no saved conversation because the earlier authentication failure preceded persistence. The reserved conversation ID was therefore initialized, preserving the intended worker identity. Current process handle is 17348; raw logs are logs/opus/placement-03.events.jsonl and logs/opus/placement-03.stderr.log. No permission bypass is used.

### Placement tests-first checkpoint inspected

Opus conversation 41f7934f-e3ed-46c7-88ee-027bf059e5a7 completed its first successful assignment turn (process 17348 exit 0, model claude-opus-5-5). Created test/placement.test.cjs, two JSON fixtures, and a throwing interface-only src/placement.cjs. Lead independently ran `node --test test/placement.test.cjs`: 148 tests, 60 pass, 88 fail, 0 skipped. All behavioral failures reach the explicit not-implemented stub; fixture/oracle tests pass. Raw author evidence: logs/opus/placement-red.txt. Independent evidence: logs/opus/placement-lead-red.txt.

Tests verify expected literal source against authored line arrays, detect wrong line/side/file/commit and anchor mutation controls, and compare all five stored patches with independent Git diff output. One hand-authored patch alignment was corrected against Git before freezing the initial checkpoint, preserving source meaning. No passing production implementation exists yet.

Checkpoint SHA-256 hashes:
- src/placement.cjs: 37fd757d14cec129900be13f210e41a508a4f49e4abb1c4c5e8bfb63ceacb116
- test/placement.test.cjs: ce34f1e3fd9f463298b7427f2cf8e44189cba2d6aacfedc7d6a6ad0bfeb7d477
- test/fixtures/placement/placement-cases.json: bba7863c5e8bbb2fd3fe033927a746c1c118376d2a084af4c04ea5235687b192
- test/fixtures/placement/pr-basic.json: 8bcca94d05f2e826bdfe3e0ffe5bce7ae73f93f808105be1cdb4ef10f73eb9fe

Lead review identified a host-contract question before implementation: unchanged context may require RIGHT anchoring even when source provenance is the base. Parent is verifying this against official GitHub behavior; deleted LEFT source remains separate. Additional fixture gaps are empty/single-line files, base-side no-newline markers, zero-count hunks, Unicode/spaced paths, adjacent replacements, and independently advancing base provenance. These will be added before implementation, preserving original red evidence. Live-host validation remains outstanding.

### Replacement tests-first checkpoint inspected

Replacement Opus conversation c31b982d-f3bf-461a-acc7-eb4ced94b037 completed tests-only turn 01 (process 59748 exit 0). Lead independently reproduced 180 tests: 90 fixture/oracle checks pass, 90 behavior tests fail at the explicit unimplemented stub, 0 skipped. Raw independent evidence: logs/opus/replacements-lead-red.txt; author evidence: logs/opus/replacements-red.txt.

The tests cover literal substring edits, prefix/suffix preservation, multiline ranges, CRLF, insertion, no-final-newline, Unicode columns under both declared column kinds, unambiguous character offsets and mismatched coordinate forms. No implementation yet. Lead review requires a correction before passing implementation: the proposed whole-line substitution model always retains the selected final line terminator and therefore incorrectly treats deleting an existing final line as lacking an anchor. The representation must distinguish zero replacement lines from one blank replacement line, retaining exact edited source independently of host rendering. Appending after a final newline can anchor to and preserve the existing final line when faithful; do not conflate no directly named insertion line with no available anchor. Parent is checking remaining normative offset/newline details.

Initial stub SHA-256: 4c77b77fc51834377f2ddb64e6aa8bf731d6768cb8a8f232bfba8e9f0ca4cd7f. Initial test SHA-256: dec57f347f9e2359e35365ff3420602ce11a3abc3c0eda639b8f087f68687987. Full fixture hashes retained in lead tool evidence. Original red evidence will remain unchanged through corrections.

### Placement verified and preparation started

Lead and parent independently reproduced placement 248/248 green with no skips. Lead evidence: logs/opus/placement-lead-green.txt. Nine deliberately introduced mapper defects were detected and reverted (logs/opus/placement-mutations.md). Current source SHA-256 4597d8ab3201baa09807609d652da3e8f189136c0b058ef5135064b372d16ce1; test ed014dfba87106cbc35abda4454b93957de37b02e89c86b1aca43cbbd19b5486. This is subsystem evidence, not assembled product or actual GitHub placement proof.

Same worker conversation 41f7934f-e3ed-46c7-88ee-027bf059e5a7 resumed as core turn05 on process22496, owning only src/prepare-review.cjs stub, test/prepare-review.test.cjs and preparation fixtures. Tests-only checkpoint before implementation. Replacement worker resumed turn02 on process55689, correcting the whole-line representation before updated red run and implementation. Publication tests worker51250 remains active.

Installed AJV8.20.0, ajv-draft-04 1.0.0 and ajv-formats3.0.1 through pnpm; official SARIF Errata01 schema declares draft-04. Vendored its exact official schema in vendor/sarif-schema-2.1.0.json with provenance README. Package installation required normal sandbox escalation for pnpm's shared cache; no policy bypass or publication occurred.

### Publication tests-first checkpoint inspected and resumed

Coordinator worker e9247b54-242b-45d6-9f34-0d74a7bc48ba completed tests-only turn01. Lead reproduced64 tests:7 discriminating oracle controls pass,57behavior tests fail at stub,0skips (logs/opus/publication-lead-red.txt). Stub hash14affe708bcb62bf19d71d4ffe710b40ccba206c891e1447172e3d452a1ea738; test hash5f04b04a34cfbd79233e3abbb692c08369812a0a6bff236717963e56a23859a2.

Resumed same conversation turn02 on handle63978. Required test corrections before implementation: numeric author IDs; original-input fingerprint distinct from persisted complete intended request; read-only recovery before current-source preparation; successful-response readback completeness as well as lost-response recovery; multiset cardinality; cursor-cycle bounds; repair non-atomic fake-host counters/records so cross-process tests assess publisher correctness rather than harness races. No per-comment writes or human-edit restoration.

Resume adds parent's tested narrow discovery flags `--strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands`, preserving normal user/project configuration, hooks, authentication and permission checks. Relevant governing instructions are explicit in assignment. Existing conversation/system snapshot continuity is preserved; no claim that cached system context shrank. Parent's profile measurement identified20,631 initial tokens versus98,288 initial tokens in original publication worker;190,726 was cumulative cache creation, not initial size. Raw profile experiment is logs/opus/profile-isolation-01.events.jsonl.

### Independent repair and preparation assignments

Replacement BOM repair turn03 completed; Astra independently reproduced 266/266 tests, no skips (logs/opus/replacements-lead-green-03.txt). Author reports 19/19 real mutants killed; the earlier equivalent survivor was replaced. Parent found a further normative explicit terminal-newline endpoint defect. Same replacement conversation turn04 runs on handle43181 to add LF/CRLF, Unicode/BOM regressions before fixing it (logs/opus/replacements-04.*).

Preparation tests-only core turn05 completed 142 tests:29 oracle passes,113 stub failures, independently reproduced in logs/opus/prepare-review-lead-red.txt. No passing preparation existed at that checkpoint. Core turn06 same conversation41f7934f-e3ed-46c7-88ee-027bf059e5a7 runs on handle94381. Before implementation it removes the mistaken reviewedCommit=currentDiffHead requirement and strengthens feedback column/snippet/offset/BOM validation. Default payload limits are conservative product limits, not claimed GitHub maxima.

Independent placement review dac76d06-ff9e-486f-a27d-d5f6256ca3b9 completed with five actionable findings; Astra reproduced all five: quoted spaced paths with separator tab falsely rejected, create/delete patch full-source coverage not enforced, empty hunks accepted, legal section-heading separators rejected, literal astral quoted paths misdecoded. No wrong inline anchor was demonstrated. Original core worker owns tests-first repair before preparation implementation; reviewer also requested LEFT oracle-contiguity controls and honest full-header Git verification. Source remains unaudited for these repairs until independently rechecked.

### Replacement and publication checkpoints; assembly assignments

Explicit EOF column repair turn04 completed and author recorded306/306 with22/22mutants. Astra independently ran replacement+publication suites together:431/431 (306+125), zero skipped, logs/opus/replacements-publication-lead-green.txt. Publication corrected red125 had7oraclepasses118stubfailures, followed by passing implementation. Lead independently ran publication-mutation-check.cjs:17mutants killed, zero survivors, plus eight repeated restart/concurrency runs each6/6; logs/opus/publication-mutations.txt. This resolves the author's omitted-command limitation without altering permission policy.

Stable review snapshot: publication source ae3acb584bb0ee14828e8f3f384c3186da159622da90b1a84ae5cf201ffbe00d; publication test fd64b00de445fbb00fb1e0eb73788df6453d7c39e4f17662da27694d83c9ae5a; replacements source445a0fb0705808c438c1beb114e7e12c802618c2e53d0acf0e87abdbd04f130d; replacements test2284b839285b3fd24c9bb5156e8fd9433841bf9fcf3290190ee0ad3e16c69bcd. Independent reviewer dac76d06-ff9e-486f-a27d-d5f6256ca3b9 resumed turn02 on26892 (publication-review-02 logs), read-only review of these modules.

Replacement author c31b982d-f3bf-461a-acc7-eb4ced94b037 owns GitHub adapter tests-only turn05 on55962, src/github.cjs stub/test/github.test.cjs/fixtures only. Must prove snapshot consistency, exact pinned blobs, reversepatch old-source verification, one draft-create payload, and pending-comment original-anchor readback with raw HTTP fixtures. Parent confirmed comparemergebase is only a candidate; multiple historical general revisions remain allowed, but only one verified oldside identity fits current mapper.

Publication author e9247b54-242b-45d6-9f34-0d74a7bc48ba owns public API/CLI tests-only turn03 on37417, src/index.cjs and bin/sarif-to-comment.cjs stubs, API/CLItests/fixtures only. Primary publishSarifReview accepts inmemorySARIF; CLI delegates. Recovery precedes currentcontext/sourcepreparation; fingerprint snapshots originalJSON plus options without secrets. Both assignments stop at red checkpoint before implementation. Core worker94381 remains active on placementrepair/preparation; no overlapping file ownership.

### Second independent review findings

Read-only reviewer turn02 completed against the publication/replacement hashes above. No incorrect replacement or duplicate-send path was found. Actionable findings awaiting same-author repair: confirmed host rejection currently becomes uncertain on restart because only sending state persists; fake host permits multiple simultaneous pending drafts per author/PR; explicit byteOffset:-1 incorrectly blocks a text region. Astra reproduced the byteOffset default failure and also charOffset:-1 with explicit charLength:0 incorrectly blocking the otherwise valid line-region default. Reviewer flags newline-interior coordinate classification as a safe but inconsistent support limitation; this is not evidence of a wrong edit. Literal BOM representation contradicts its escape-form comment. Actual transport normalization and live apply evidence remain separate gates.

Parent's manual native-suggestion application probe found critical differences between rendered appearance and actual host edits. Four-backtick nested-code suggestions rendered as native UI but applied as deletion; blank-only payload applied as zero lines; CRLF payload doubled CR; deleting a final non-newline line removed preceding separator. Those require conservative renderer blocks and regressions. Ordinary no-final-newline replacement and CRLF source with LF payload passed exact blob comparison. Raw evidence is docs/evidence/native-fidelity-probe/applied-files.json; this is manual host-envelope evidence, not assembled product evidence.

### Host-informed integration and release-blocking repairs

Adapter red80 (3fixturepasses77stubfailures) and API/CLIred94 (2harnesspasses92stubfailures) independently reproduced. Adapter author resumed turn06 handle20286, API/publication author turn04 handle30455. Public/default adapter contract is createGitHubClient with publication transport methods plus fetchContext. Historical reviewed commits retain actualcurrentdiff for coregeneral fallback. Optional oldSourceCommit is a full immutable source-verification candidate included in originalfingerprint and CLIparity; arbitrary SARIF historicalprovenance is not silently promoted to LEFT. Parent accepted this engineeringchoice. Publication sameauthor repairs realonependingdraft modeling and durableterminalrejection before wrapper/package implementation.

Core turn06 completed preparation170green plus placementrepairs. Lead independently rechecked allfive placementcounterexamples and ran272tests:271pass,0fail,1intentional syntheticnonGitfixture skip. Parent discovered actualsourceassociation loss: a result referencing onefile withfix inanother was silentlymoved tofixanchor. Lead reproduced this and unvalidated native suggestion injection through producerMarkdown. Parent also reproduced missingargument substitution in directtext/Markdown. Core sameauthor turn07 handle4667 adds regressionsbeforefix for these, plus actualGitHub applicationfidelity cases from docs/native-suggestion-fidelity-experiment.md. These are releaseblockers; priorpassingtests did notestablish correctassembledbehavior. The boundedprofile may explicitlyblock unsupportedmismatchedfix/sourceassociation, neverrelocatefeedback.

The parent completedandcleaned nativehostprobe; submitted experimentreview retained, exactownedpendingdraft removed, PRclosedunmerged, mainunchanged. New actionableproducerMarkdown mustnot createexecutablefixes outsidevalidatedSARIFfix semantics. Realhostevidence proves renderingalone insufficient for suggestionfidelity. No integratedcompletionclaim yet.

### User operating-model correction

The user directed subsequent Claude turns to use auto permissions mode and prepend /goal, with ticket-sized outcomes that describe the problem, governing contracts, constraints and success criteria rather than detailed implementation plans. Opus should own its internal planning, tests-first implementation and correction loop; lead supervision should focus on integration and independent acceptance. Parent is verifying the installed CLI support and updating the shared skill. Existing running turns are preserved and will not overlap. This instruction supersedes the earlier fine-grained checkpoint/resume assignment style for future turns.

### Native goal and auto mode verified on the next real ticket

The next core assignment used the existing Opus conversation with --permission-mode auto and a prompt beginning /goal. Raw initialization for core turn08 (process78530) reports permissionMode:auto with the native tool surface restored and unrelated MCP servers excluded. The worker explicitly acknowledged “Goal set” for the ready-SARIF fidelity ticket. Its outcome covers unsupported newline semantics, external result references and component-qualified attribution; the worker owns its internal planning, tests-first implementation and correction loop. This is actual assignment evidence, not a rehearsal. Logs: logs/opus/core-08.*.

Prior core turn07 reports481/481 core tests and965/965 combined after feedback-association, producer-fence, direct-argument and host-fidelity repairs. Those remain subject to final independent integration acceptance. Adapter/replacement lead checkpoint428/428 and publication repair156/156 passed. Adapter mutation run killed20/21; missing head/context no-newline-marker control is queued for acceptance review. Adapter turn07 (92741) is repairing documented symlink dereference provenance, and API/package turn04 (30455) is completing integration. These already-running turns retain their launch settings; subsequent turns use the corrected operating model.

### Assembled acceptance and live-dispatch authority check

All modules reached implementation checkpoints. Lead ran full tests:1220 passed and two package tests failed only because npm attempted sandbox-disallowed writes to the user's cache. Lint identified eight unused test bindings. Package author now owns a native /goal auto-mode readiness ticket (package turn05,59207) to make checks self-contained and demonstrate real temporary-consumer installation. Independent assembled review runs in the original reviewer conversation (turn03,45344) against logs/opus/assembled-review-hashes-01.txt.

The proposed live product /goal ticket (logs/opus/live-08.prompt.md) was rejected by automatic approval review before process launch. The stated reason was that this subagent's trusted user context did not explicitly authorize creating or changing fixture branches and leaving a draft review in mike-north/doc-linter. No workaround or indirect execution was attempted. Parent was asked for the exact existing user authority or policy-approved execution from its full authorized context. Unaffected review and packaging work continues. The adapter conversation remains idle; there is no live-08 process or completed live product evidence yet.

The parent recovered exact user authority from this chat's authoritative session rollout, and the lead inspected it: user direction to use doc-linter for the isolated experiment, agreement to representative real-PR draft placement tests, broad repository delegation excluding npm, and explicit Claude material-sharing authority. Normal reconsideration still rejected the same unlaunched ticket, stating that recovered tool-output excerpts were not trusted user authorization in this context. No live worker started and no remote writes occurred. Parent received the exact rejection for resolution through normal approval; no workaround was attempted. Package and independent review work remain unaffected.

The same live ticket subsequently passed normal approval in the parent's full original user context. Parent explicitly supplied the trusted authorization and the earlier child-context rejection; no permission bypass was used. The same idle adapter conversation is now running the native live /goal in auto mode on process95006, owned by parent, with logs/opus/live-08-parent.*. Initialization confirmed claude-opus-5-5 and an explicit Goal set acknowledgment. The earlier authority block is resolved; the live outcome remains pending. Do not overlap this conversation with another turn.

Package readiness goal completed: author reports clean lint and1222/1222 tests, plus actual offline npm installation into a clean temporary consumer and installed library/executable smoke evidence. The package test now uses isolated npm cache/config rather than the user's global cache. Stable product source hashes remain unchanged for the independent assembled review; only package test, lint config and README changed in the readiness ticket.

### Final independent repair reconciliation

Reviewer conversation dac76d06-ff9e-486f-a27d-d5f6256ca3b9 turn04 completed against logs/opus/assembled-review-hashes-02.txt. It independently reproduced all prior D1–D4 findings as fixed and accepted E2 public-library/CLI through real-adapter composition coverage. Its full run passed lint and 1,278 tests with no skips; the lead independently obtained the same result in final-check-lead-03.txt. No confirmed code defect remained at this snapshot. Live-host E1 evidence is separately owned by the parent and remains a distinct acceptance gate. The review disclosed one dummy-token, read-only GitHub request returning 401 during its CLI BOM probe; no remote writes occurred.

Reviewer mutation checks found that the composition suite detects changed wire ranges, wrong readback side/line, dropped general body and LEFT-to-RIGHT placement defects. Skipping old-side verification and retaining base line numbers were caught by subsystem suites (12 and 8 failures respectively), not the composition suite. The lead narrowed the latter suite's overclaiming endpoint-read test title to its actual evidence.

After the reviewed snapshot, the lead made one bounded diagnostic correction: an unsupported feedback/fix association now tells callers to keep the correct result location and separate the unsupported association, rather than moving the result inside the fix. A new outcome assertion failed on the old wording before the edit (logs/opus/diagnostic-wording-red.txt). Preparation plus composition then passed 281/281 with no skips and lint passed (diagnostic-wording-green.txt and diagnostic-wording-lint.txt). Final deltas: src/prepare-review.cjs SHA-256 9626bc1b2504d8933ea5395f9594a5a58a1f2e61c8b14f8a108abcad1ee91852; test/prepare-review.test.cjs e877edf6d1f2571a5eebf7d5b83da2cc9a56497c19e72865caf0a7bf27ef029c; test/composition.test.cjs 409c19ffbc954d395189d9fd5d5d9a4d26da37fca81d8cbe93ac5e306855c006. This wording-only source delta is outside the reviewer's earlier hash and was inspected by the lead.

### Final live acceptance and native application

The parent's live worker turn08 completed real public library/CLI publication, exact original-anchor/source readback, single-create equality, controlled lost-response and SIGKILL recovery, repeat/no-retargeting checks and historical fallback. Full report docs/milestone-e2e-evidence.md; selected sanitized evidence is committed under docs/evidence/milestone-e2e. Parent inspected both the initial and final recreated CLI drafts in signed-in Chrome.

Same adapter conversation turn09 ran native /goal in auto mode on process12516 and completed the supplemental E1 fixture without product edits. Inline-only and CRLF-source bodies read back exactly. The parent used native GitHub Apply controls on all three product-generated suggestions. All final file bytes and independent Git blob hashes exactly match the pre-authored 1→3, 2→1 and middle-deletion expectations. PR16 finalhead ee7d1ea18c3e99cbd399194eecdb9c908c190e94; docs/suggestion-application-e2e.md contains the report, screenshot, raw evidence and cleanup. All three milestone fixture PRs14–16 are closed unmerged; no pending test draft remains; doc-linter main is unchanged. Submitted PR16 experiment review is retained as evidence.

Astra completed the independent review and repair reconciliation. The only post-review source delta is the tested diagnostic correction; final live runs pin this source. No confirmed code finding remains. Final parent validation and Git delivery follow; npm publication remains prohibited.

### Parent final validation and delivery preparation

Parent `pnpm check` passed lint and 1,278/1,278 tests across 81 suites with no skips. Every product source file matches the manifest used for the final live experiments. Final `npm pack` produced the local private tarball with exactly eleven intended files; no registry publication. Remote main was verified at the original initial commit before delivery. The experimental toolsmith staging directory is local research scaffolding and is excluded from the product commit. SSH discovery stalled and was canceled; HTTPS uses the existing GitHub credential helper transiently without changing repository configuration or credentials.
