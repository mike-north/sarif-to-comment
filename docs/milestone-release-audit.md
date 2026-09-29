# First-milestone release audit

> **Historical audit (reconciled September 28, 2026).** The npm deferral and "package remains private" statements below were later superseded by the 0.1.0 and 0.1.1 releases and by the owner's decision to keep the repository public. For current status, see [Current status and reconciliation](status.md).

This is the engineering lead's independent completion audit against the user's goal. It records evidence, not implementation instructions or a substitute scope. A row stays unverified until its evidence has been inspected. Passing a narrower test does not establish a broader claim.

The selected scope in [first-milestone.md](first-milestone.md) governs which parts of the broader [specification](specification.md) apply now. Settled decisions D3–D5, D11–D14, D26 and D29 govern source association, attribution, whole-review validation, durable initial publication and draft behavior. Staged extraction, file proposals and suggestion-PR requirements in the broader specification are future scope, not missing features in this increment. The engineering contract defines a bounded profile but cannot override those requirements. SARIF's normative coordinate and message rules govern interpretation of supported inputs.

Findings are classified as aligned, divergent, specified but missing, insufficiently tested, or spec ambiguity. A candidate implementation under active development stays unverified until its reviewed source and required evidence agree. The final deliverable is this requirement/evidence ledger with every release-blocking divergence resolved or explicitly reported.

## Required evidence

| Requirement | Evidence needed | Current assessment |
|---|---|---|
| Importable library for producer integrations | Public exports and documented in-memory SARIF call; executable integration example using the distributable package | Verified: installed package smoke plus live public in-memory library runs; final request matches the CLI apart from publication marker. See milestone-e2e-evidence.md. |
| Thin CLI for SARIF files | Packaged executable calls the same core; success, validation, operational-failure and uncertain-delivery parity tests | Verified: actual installed executable, CLI behavioral tests, real-adapter composition suite, strict UTF-8/BOM regressions and live CLI publication/repeat/changed-input refusal. |
| Complete draft review | Real GitHub review is pending; body and all intended comments are created by one request and read back with expected cardinality | Verified live: one body-plus-eight-comments create, PENDING readback, exact multiset/cardinality and authored commit. Supplemental inline-only and CRLF-source bodies also read back byte for byte. |
| General and inline feedback | Explanations and available provenance preserved; valid non-inline fallback links to exact reviewed source; no-location feedback preserved | Verified: schema/preparation tests, independent reviewed source and live eight-inline/two-general fixture; final browser rendering preserves source link/text, attribution, deleted LEFT and shifted RIGHT ranges. |
| Supported existing-file suggestions | Applying rendered suggestion text produces the intended SARIF replacement; precise regions, Unicode columns and newline semantics exercised | Verified: precise region/Unicode/newline replacement tests, regressions for observed unfaithful host shapes, and actual native GitHub application of product-generated 1→3, 2→1 and middle-line deletion suggestions. Exact final bytes and Git blob identities match independent expectations. Earlier manual host probe establishes CRLF-source/LF-payload and no-final-newline envelope. |
| Exact placement | Independent expected file, commit, side, line/range and literal source text; local boundary cases plus real GitHub readback and representative rendered inspection | Verified for the documented profile: independent source oracle and mutation controls, full Git patches, six live publications, actual REST/GraphQL original-anchor readback and refreshed signed-in Chrome inspection. Branch advance preserves original identities. No claim of arbitrary SARIF support. |
| Tests precede implementation | Saved initial behavioral failures, meaningful wrong-line/side/file controls, subsequent implementation history by the same author | Verified for all six modules and CLI/package through the independently reproduced red checkpoints in work-record.md and the working logs; independent oracles and mutation controls distinguish wrong source placement. Later repairs retain their own red/green evidence. |
| Complete preflight | Schema, policy, source inconsistency, unsupported meaningful input and approval-hold cases prove no remote writes; override affects approval only | Verified: public API tests assert no writes or state for invalid/held input; core tests cover whole-review source/profile/schema failures and prove approval override cannot bypass mechanical errors. Live historical fixes and invalid-anchor controls preserve zero successful remote publication. |
| Ambiguous creation recovery | Durable marker/intent before send; lost-response and restart evidence; repeated recovery creates no duplicate; inconclusive lookup remains uncertain | Verified locally and live: durable intent plus true host creation with client-side response loss and SIGKILL; fresh process recovers with zero additional POSTs. Delayed visibility and mismatches remain uncertain in discriminating local tests. |
| Concurrency | Two independently instantiated publishers sharing a record cannot issue duplicate creation; stale/uncertain ownership does not authorize blind resend | Verified locally: publication tests launch twelve concurrent callers and three rounds of six independent processes; exactly one sender, complete on-disk records, and only receipt/recovery/uncertain followers. SIGKILL tests exercise both sides of host persistence and prohibit later resend. Included in independently passing full suite. Power-loss durability is not claimed. |
| One-way publication | Completed review is not maintained or restored after human edits/deletion; new input can create a distinct review | Verified in coordinator source and publication tests: completed receipts return without host access, uncertain mismatches never repair, and only createReview is a write capability. A separate state path may create another review after the account's earlier pending review is submitted/deleted by a person. |
| Library and CLI usable by waiting projects | Installation/package contents, examples and supported-input documentation independently exercised without npm publication | Verified: actual clean-consumer npm installation, installed library/executable smoke, corrected async example and documented bounded profile/authentication. Real product library/CLI use also passed live. No npm publication. |
| Durable comments | Public and internal abstractions explain semantic responsibilities, boundaries and invariants; progress lives in work records | Verified by source inspection and independent review: modules document purpose, identity/provenance, sequencing, supported profile and refusal boundaries; key functions/constants/types explain invariants. Work status is kept in docs/work-record.md. |
| Independent review | A separate reviewer examines identified stable source; actionable findings reproduced, repaired, regression-tested and rechecked | Verified: a separate reviewer reconciled all four assembled findings as fixed and reproduced 1,278 passing tests plus lint. Retained report/hashes in evidence/independent-review. Post-review delta only corrects a containment diagnostic and narrows a test title, with tests-first focused proof. |
| Full integrated validation | Appropriate final test/lint/type/package checks pass for the reviewed source; any host-test artifacts are accounted for | Verified: the final pnpm check passed lint and all 1,278 tests in 81 suites with zero failures/skips. Product source matches the final live-run manifest. Package install and CLI/library smoke passed; all host fixtures accounted for and closed unmerged. |
| Scope limits | No staged extraction, suggestion PRs, human-change synchronization or npm publication added; unsupported inputs are not silently dropped | Verified: library/CLI implement only ready-SARIF initial draft publication. Package remains private. Unsupported finding semantics are blocked or preserved with diagnostics; documented auxiliary producer metadata is not rendered. No staged extraction, suggestion PR, review maintenance or npm release was added. |

## Evidence interpretation

- Current planning documents establish intended behavior only.
- The initial response-discard experiment in the earlier design phase establishes limited host behavior; it does not validate the implementation produced by this milestone.
- API documentation establishes that review creation accepts a body and comments array. The supported implementation must use that capability; documentation alone does not prove all failure modes atomic.
- Local fixtures and mocks are necessary but cannot establish actual GitHub placement. Live evidence must identify the source revision, expected locations, actual review/comments and cleanup outcome.
- npm release is explicitly deferred. A locally installable package can demonstrate usability without publication.

## Audit findings

The ledger above is the final assessment. The chronological findings below preserve the earlier checkpoints and their limitations; the final acceptance section records their resolution.

The auditor independently checked 35 initial placement source-text expectations against the authored source line arrays; all matched. This checks the fixture oracle, not implementation behavior. The manual host probe in `docs/placement-host-probe.md` separately verified a four-comment pending batch and an invalid-anchor batch with no residual review. It does not replace the eventual implemented library/CLI live test or rendered inspection.

Separately, the implementation process was adjusted after observed authentication, authorization-context, session-persistence and fixture-authoring failures. That is a process change, not product evidence.

### Placement subsystem checkpoint

The auditor read the mapper and its independent fixture oracle, then ran `node --test test/placement.test.cjs`: 248 tests passed, zero failed or skipped. The oracle uses authored source line arrays and display-row coordinates; it does not derive expected anchors from the mapper. The suite also checks authored patches against Git-generated patches. This is a verified local subsystem checkpoint, not completion of the integrated placement gate.

The implementer's mutation record reports nine injected defects detected, including wrong side, wrong shifted line, omitted source checks and altered source identity. The auditor inspected that record but did not independently rerun those mutations. Two additional base-side range-boundary cases were added after the original red checkpoint when mutation testing exposed missing coverage; their timing is disclosed in the implementer's record.

### Replacement finding: explicit terminal-newline endpoint

The auditor reproduced a spec mismatch after the first passing replacement implementation: source `a\n`, region `{startLine: 1, startColumn: 3, endColumn: 3}`, inserted text `x`, UTF-16 columns returned `invalid/out-of-bounds`. [SARIF section 3.30.2, example 8](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html) explicitly allows an EOF insertion on the last existing line, with the column including its terminal newline. The expected edited text is `a\nx`. An omitted endColumn excludes the newline; this does not imply that an explicit endpoint must exclude it. The finding was accepted for a tests-first repair by the original author. Resolution remains unverified here.

### Credential compatibility review point

GitHub's [authenticated-user endpoint](https://docs.github.com/en/rest/users/users#get-the-authenticated-user) lists user access tokens and personal access tokens, but not GitHub App installation tokens. An adapter that obtains publication authorship solely through this endpoint must not claim installation-token or ordinary GitHub Actions token support. The final supported-input documentation and integration tests must state the implemented credential envelope. This is a compatibility review point, not a request to expand the first milestone into additional authentication systems.

### Validation artifact provenance

The auditor independently verified that `vendor/sarif-schema-2.1.0.json` is byte-identical to the earlier official Errata01 download, with SHA-256 `c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e`. Its declared dialect is JSON Schema draft-04. This establishes provenance of the validation artifact; executable whole-review validation remains a separate gate.

### Native application fidelity gate

The auditor completed a nine-case manual GitHub application probe, including browser application and exact resulting Git blob comparison. Five cases matched the independently recorded expected text; four did not. Nested-fence suggestions rendered correctly but applied as deletions; blank-only payloads lost the blank line; CRLF payloads doubled carriage returns; deleting a final non-newline line also removed the preceding separator. These are host-envelope findings, not failures of an integrated product run. The [full experiment](native-suggestion-fidelity-experiment.md) records exact requests, expected/actual text, screenshot and cleanup.

The same probe independently confirmed that GitHub rejects a second pending review by the same author on one PR with HTTP 422. Only the exact marked test draft was deleted; the synthetic PR is closed unmerged and main is unchanged. Both findings were passed on for tests-first incorporation. The integrated suggestion renderer and publisher remain unverified here until their final supported profile and regression evidence are inspected.

### Preparation findings awaiting repair

The auditor reproduced a wrong-association defect during preparation implementation: a result located at `src/util.js` line 4, with a fix changing `src/app.js` line 3, produced only a suggestion comment on `src/app.js` line 3. Its general body was empty, and its evidence replaced the finding's source with the fix's source. The original source association disappeared. The reproducer used the authored preparation repository fixture and real replacement implementation, replacing columns 23–25 of the head's `DEFAULT_LIMIT = 25` with `20`. D3/D4 require separate handling of feedback outside a replacement's range. The exact reproducer was passed on for tests-first repair; same-file distant locations require coverage too.

The auditor also identified an unvalidated-action boundary in message rendering: supplied SARIF Markdown was passed verbatim into inline comments, where GitHub suggestion fences can become actionable edits without a SARIF fix. Unclosed fences can interfere with generated attribution and suggestion markup. This was accepted for tests-first validation of executable and unbalanced fences. This is a source-level finding; no new live write experiment was used for it.

The auditor separately reproduced missing argument substitution for direct message text: `{text: 'Variable {0} is uninitialized.', arguments: ['pBuffer']}` returned ready with literal `{0}` in the body. The implementation only substituted named message templates. [SARIF sections 3.11.5 and 3.11.11](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html) require substitution in direct text and Markdown too. This was passed on for repair, including missing-argument and escaped-brace coverage.

### Adapter source-identity finding awaiting repair

The [GitHub contents endpoint](https://docs.github.com/en/rest/repos/contents#get-repository-content) documents that a symlink targeting an ordinary repository file returns the target's content. The proposed adapter's `type: file` check and hash of returned bytes therefore do not establish that those bytes belong to the requested path's Git object. Its tests only covered a response explicitly typed `symlink`. This is insufficiently tested source identity, with a documented path-dereferencing risk for general feedback outside the diff. A tests-first correction was accepted, requiring the immutable Git tree entry's mode and blob identity, or equivalent non-dereferencing reads. This finding is based on documentation and the adapter contract, not an observed incorrect publication.

### Process note

The user directed that implementation assignments be complete, ticket-sized outcomes: the problem, the governing contracts and constraints, and the success criteria. Implementers own their plan and their tests-first correction loop, and independent final acceptance stays separate. This changed how work was assigned, not the product scope. A live GitHub assignment was initially refused by an automated approval check, which could not treat recovered authorization excerpts as trusted. It was later approved against the existing user authorization, with no permission bypass.

### Preparation recheck

The auditor independently reran the original cross-file association, direct-message argument and producer-suggestion reproductions against preparation SHA-256 `54f8da4c754fc44f06b698ed9154406930854e23653309af776e54c36fa8a595`. All three passed their intended outcomes: unsupported cross-file association blocks, the direct message renders `pBuffer` in place of its argument placeholder, and the unvalidated suggestion fence blocks. Evidence: `<working-logs>/parent-preparation-recheck.json`. These findings are resolved at that source snapshot; final integrated/live acceptance remains separate.

### Assembled local and package evidence

The auditor inspected the independently executed `<working-logs>/final-check-lead-02.txt`: lint succeeded and all 1,222 tests passed with zero skips. The saved installation transcript proves actual `npm install` into a clean temporary consumer, all eleven package files, import of the installed library and execution of its installed CLI. The library smoke used an injected host; this is package usability evidence, not real-host acceptance.

The auditor read the public entry point and durable publication coordinator. The library captures the original in-memory JSON, checks saved publication state before current source preparation, and invokes one shared preparation/publication path. Existing completed/rejected receipts return without host calls; incomplete intents verify the authenticated author and complete body/comment multiset. Exclusive publication of a flushed intent controls send ownership. These source checks support the acceptance ledger but do not replace restart/concurrency tests or live readback.

The independent assembled reviewer identified dropped meaningful SARIF fields, HTML that could swallow rendered feedback, and CLI decoding/BOM handling. Repairs by the same author were in progress, with an additional public-wrapper-through-real-adapter raw-HTTP composition test. The earlier green snapshot is therefore not the final release snapshot.

### Final independent re-review and live product proof

The auditor inspected the independent [re-review report and source manifest](evidence/independent-review/review.md). All four actionable assembled findings are resolved: meaningful result/invocation semantics, unbalanced HTML, plain-text mentions within the settled profile, and strict CLI decoding/BOM. The real-adapter composition suite now discriminates incorrect wire ranges, readback sides/lines, missing body sections and LEFT placement. Two additional injected defects that survived that suite were killed by focused subsystem suites; the ledger does not claim that each suite independently proves every property.

The [live product report](milestone-e2e-evidence.md) and [retained raw readback/expectations](evidence/milestone-e2e/README.md) establish public-library and actual-CLI delivery, single-request body/comment equality, exact original anchors, lost-response/process-kill recovery, repeat refusal and historical-source behavior. Chrome inspection of the final recreated review confirms visible general and inline content and native suggestion rendering. The supplemental experiment subsequently verified exact inline-only/CRLF body readback and native application of 1→3, 2→1 and middle-line deletion suggestions. The auditor compared immutable final file bytes and blob identities to independently authored expectations; all matched. All synthetic PRs were closed unmerged, exact owned pending drafts were removed, and doc-linter main remained unchanged.

### Final acceptance

The selected first milestone is verified against every requirement in the ledger. The final `pnpm check` passed lint and all 1,278 tests (81 suites, zero failures/skips). The remaining E1 host gaps passed exact-byte checks in the supplemental live experiment. Product code needed no repair for either live experiment; final source identity is recorded with their evidence.

The supported profile and residual limits remain explicit: personal/user tokens only, conservative request/file limits, restricted single-replacement fixes with contained feedback, no guessed historical suggestion anchoring, no power-loss proof, and no claim about every possible GitHub failure. Human editing, review maintenance, staged enrichment, suggestion PRs and npm publication remain outside this milestone.
