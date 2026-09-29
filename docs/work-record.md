# Design work record

> **Historical work record (reconciled September 28, 2026).** Deferrals and "not yet" statements below describe their dates. In particular, npm publication was later authorized and performed. For current status, see [Current status and reconciliation](status.md).

This record covers design and the first milestone (ready SARIF to a GitHub draft review). On September 28, 2026 it was condensed to durable facts: scope decisions, user instructions, defects found and how they were resolved, and verification results. The chronological narrative of how implementation work was assigned and supervised is preserved in Git history.

## September 27, 2026: authority and scope

- **Repository authority.** The user authorized repository work as their delegate, including settings, branch protection, workflow changes and direct pushes to the default branch. This authority is for doing work when it is needed, not a requirement to change those settings. At this point npm publication was explicitly deferred. It was later authorized; see [npm release verification](npm-release-verification.md).
- **Transport.** The user prefers SSH for Git operations. One signing-agent failure during the recovery experiment came from a missed 1Password approval, and a retry succeeded. A slow interactive signing approval is not a reason to change transport.
- **Domain model first.** Before implementation, the user redirected the work to scrutiny of the domain model: the simplest model and surface that meet the full requirements, using their practical domain-modeling guide. The result is [domain-model-scrutiny.md](domain-model-scrutiny.md). The first milestone was refined from it.
- **Host experiments.** The live GitHub interaction experiments are recorded separately in the grouped-suggestion, companion-PR lifecycle and publication-recovery reports. They establish specific host behaviors, not an implemented converter or durable publisher.
- **One-way publication.** The user made the one-way boundary explicit. SARIF becomes an initial GitHub review. There is no human-edit reconciliation, GitHub-to-SARIF synchronization, review maintenance or re-review lifecycle, and new SARIF may create a separate new review. D29, the brief and R14 record this. The independent model comparison is annotated so that its earlier recovery recommendation cannot silently broaden scope. GitHub documentation confirms that one create-review request can carry the body and inline comments, either pending or submitted. That was a documentation check, not a live experiment or proof of failure atomicity.
- **First milestone accepted.** The user accepted the ready-SARIF-to-draft-review first milestone, stating that waiting projects need only this increment. [First milestone](first-milestone.md) records the consumer outcome, tests-first acceptance cases, later increments and delivery evidence.
- **Placement is the primary gate.** The user emphasized rigorous testing and exceptionally reliable placement on the right source line. Exact placement became the primary release gate. It is backed by independently authored expected locations, boundary and diff-side cases, wrong-placement negative controls, and real GitHub readback and rendering.
- **Surfaces.** The user selected both an importable library (primary, taking in-memory SARIF) and a CLI. The [engineering plan](milestone-engineering-plan.md) records the sequence.
- **Sharing material with the implementation service.** The user gave an explicit written authorization to send the repository's relevant material to the AI coding service used for implementation and independent review. The quote is recorded verbatim at line 31 of `git show 146c599:docs/work-record.md`. An automated approval check had initially refused the transfer, and no workaround was attempted.

## First milestone: engineering evidence

Every module followed the same pattern. Behavioral tests and independently authored fixtures came first. The implementation then made them pass, and each checkpoint was independently reproduced. Later repairs kept their own red and green evidence.

**Placement.** The initial checkpoint had 148 tests: 60 fixture and oracle checks passed, and 88 behavioral tests failed at an explicit not-implemented stub. The tests check expected literal source against authored line arrays. They detect wrong line, side, file and commit, and they compare the stored patches with independent Git diff output. One hand-authored patch alignment was corrected against Git before the checkpoint was frozen. Before implementation, fixtures were added for:

- unchanged context anchored on RIGHT;
- empty and single-line files;
- base-side no-newline markers and zero-count hunks;
- Unicode and spaced paths;
- adjacent replacements;
- independently advancing base provenance.

The implementation reached 248 of 248 passing, with no skips. Nine deliberately introduced mapper defects were detected.

Checkpoint SHA-256 hashes:

- initial `src/placement.cjs` stub: `37fd757d14cec129900be13f210e41a508a4f49e4abb1c4c5e8bfb63ceacb116`
- initial `test/placement.test.cjs`: `ce34f1e3fd9f463298b7427f2cf8e44189cba2d6aacfedc7d6a6ad0bfeb7d477`
- `test/fixtures/placement/placement-cases.json`: `bba7863c5e8bbb2fd3fe033927a746c1c118376d2a084af4c04ea5235687b192`
- `test/fixtures/placement/pr-basic.json`: `8bcca94d05f2e826bdfe3e0ffe5bce7ae73f93f808105be1cdb4ef10f73eb9fe`
- verified placement source: `4597d8ab3201baa09807609d652da3e8f189136c0b058ef5135064b372d16ce1`; test: `ed014dfba87106cbc35abda4454b93957de37b02e89c86b1aca43cbbd19b5486`

An independent placement review found five defects, all of which were reproduced:

- quoted spaced paths with a separator tab were falsely rejected;
- full-source coverage of create and delete patches was not enforced;
- empty hunks were accepted;
- legal section-heading separators were rejected;
- literal astral characters in quoted paths were misdecoded.

No wrong inline anchor was demonstrated. All five were repaired tests-first, and LEFT-side contiguity controls were added.

**Replacements.** The initial checkpoint had 180 tests: 90 oracle checks passed and 90 behavioral tests failed at the stub. The tests cover:

- literal substring edits and prefix/suffix preservation;
- multiline ranges and CRLF;
- insertion and a missing final newline;
- Unicode columns under both column kinds;
- character offsets and mismatched coordinate forms.

Review caught a model error before implementation. The proposed whole-line substitution always kept the final line terminator, so deleting an existing final line appeared to have no anchor. The representation now distinguishes zero replacement lines from one blank line. Later repairs fixed:

- BOM handling (266 of 266 passing, 19 of 19 mutants killed);
- the explicit terminal-newline endpoint required by SARIF §3.30.2 example 8 (306 of 306 passing, 22 of 22 mutants killed).

Hashes: initial stub `4c77b77fc51834377f2ddb64e6aa8bf731d6768cb8a8f232bfba8e9f0ca4cd7f`; initial test `dec57f347f9e2359e35365ff3420602ce11a3abc3c0eda639b8f087f68687987`.

**Publication.** The initial checkpoint had 64 tests: 7 discriminating oracle controls passed and 57 behavioral tests failed at the stub. Before implementation the tests were corrected to require:

- numeric author IDs;
- an original-input fingerprint distinct from the persisted intended request;
- read-only recovery before preparing current source;
- readback completeness after a successful response;
- multiset cardinality;
- cursor-cycle bounds;
- race-free fake-host counters.

The corrected red run had 125 tests (7 passing oracles and 118 stub failures), followed by the passing implementation. Seventeen mutants were killed, and eight repeated restart and concurrency runs each passed 6 of 6.

- Stable source hash: `ae3acb584bb0ee14828e8f3f384c3186da159622da90b1a84ae5cf201ffbe00d`; test: `fd64b00de445fbb00fb1e0eb73788df6453d7c39e4f17662da27694d83c9ae5a`.
- Replacement source hash: `445a0fb0705808c438c1beb114e7e12c802618c2e53d0acf0e87abdbd04f130d`; test: `2284b839285b3fd24c9bb5156e8fd9433841bf9fcf3290190ee0ad3e16c69bcd`.

A second independent review found no incorrect replacement or duplicate-send path. It found three actionable defects, all repaired:

- a confirmed host rejection became uncertain after a restart, because only the sending state was persisted;
- the fake host allowed several simultaneous pending drafts per author and PR;
- an explicit `byteOffset: -1` (and `charOffset: -1` with `charLength: 0`) wrongly blocked a valid region.

**Preparation.** The tests-first checkpoint had 142 tests: 29 oracle passes and 113 stub failures. Before implementation, the mistaken requirement that `reviewedCommit` equal the current diff head was removed, and validation of feedback columns, snippets, offsets and BOMs was strengthened. Default payload limits are conservative product limits, not claimed GitHub maxima. Three defects were reproduced during implementation and fixed with regressions first. They are release blockers that earlier passing tests had not caught:

- a result in one file with a fix in another was silently moved to the fix's anchor;
- supplied Markdown could inject an actionable suggestion fence without a SARIF fix;
- direct message text and Markdown did not substitute arguments.

The profile now blocks unsupported feedback/fix associations rather than relocating feedback.

**Adapter.** The GitHub adapter was designed to prove:

- snapshot consistency and exact pinned blobs;
- old-source verification by reversing the patch;
- one draft-create payload;
- original-anchor readback of pending comments.

The public default adapter is `createGitHubClient`, which provides the publication transport methods plus `fetchContext`. Historical reviewed commits keep the actual current diff for general fallback. An optional `oldSourceCommit` is a full immutable candidate that is included in the input fingerprint. Arbitrary SARIF historical provenance is never silently promoted to LEFT. Symlink dereferencing through the contents API was closed by verifying immutable tree-entry modes and blob identities.

**Native application fidelity.** A manual host probe ([native-suggestion-fidelity-experiment.md](native-suggestion-fidelity-experiment.md)) showed that rendering is not enough. In four cases a suggestion rendered correctly but applied wrongly:

- nested four-backtick suggestions applied as deletions;
- blank-only payloads applied as zero lines;
- CRLF payloads doubled the carriage return;
- deleting a final line without a trailing newline also removed the preceding separator.

The renderer now refuses these shapes. Ordinary no-final-newline replacement, and CRLF source with an LF payload, passed exact blob comparison.

**Dependencies.** Ajv 8.20.0, ajv-draft-04 1.0.0 and ajv-formats 3.0.1 were added. The official SARIF 2.1.0 Errata01 schema declares draft-04, and it is vendored with provenance in `vendor/sarif-schema-2.1.0.json`.

**Assembled review.** The final independent review reproduced all earlier assembled findings as fixed. It accepted public library and CLI composition through the real adapter. Lint and all 1,278 tests passed with no skips, and a second run reproduced the result.

Mutation checks showed which suite catches which defect:

- The composition suite catches changed wire ranges, wrong readback side or line, a dropped general body, and LEFT-to-RIGHT placement.
- Skipping old-side verification is caught by subsystem suites (12 failures), not the composition suite.
- Keeping base line numbers is likewise caught only by subsystem suites (8 failures).

One test title that overclaimed was narrowed to match what it tests. After the review, one diagnostic was corrected, tests first: an unsupported feedback/fix association now tells callers to keep the correct result location and separate the unsupported association. Preparation and composition then passed 281 of 281. Final hashes:

- `src/prepare-review.cjs`: `9626bc1b2504d8933ea5395f9594a5a58a1f2e61c8b14f8a108abcad1ee91852`
- `test/prepare-review.test.cjs`: `e877edf6d1f2571a5eebf7d5b83da2cc9a56497c19e72865caf0a7bf27ef029c`
- `test/composition.test.cjs`: `409c19ffbc954d395189d9fd5d5d9a4d26da37fca81d8cbe93ac5e306855c006`

The review disclosed one read-only GitHub request with a dummy token that returned 401. No remote write occurred.

**Live acceptance.** The live runs are reported in [milestone-e2e-evidence.md](milestone-e2e-evidence.md) and [suggestion-application-e2e.md](suggestion-application-e2e.md). They covered:

- real public library and CLI publication;
- exact original-anchor and source readback, and single-create equality;
- controlled lost-response and SIGKILL recovery;
- repeat and no-retargeting checks, and historical fallback;
- inline-only and CRLF-source bodies read back exactly;
- native application of all three product-generated suggestions, matching the pre-authored 1→3, 2→1 and middle-deletion expectations byte for byte (PR 16 final head `ee7d1ea18c3e99cbd399194eecdb9c908c190e94`).

Afterwards, fixture PRs 14–16 were closed unmerged, no pending test draft remained, and doc-linter `main` was unchanged.

**Final validation.** `pnpm check` passed lint and 1,278 of 1,278 tests across 81 suites, with no skips. Every product source file matched the manifest used for the final live runs. `npm pack` produced exactly the eleven intended files. Local research scaffolding was excluded from the product commit.

## September 28, 2026: second-milestone scope

- **Selection.** After the ready-SARIF milestone and the npm release, the user selected staged-change extraction and explicitly excluded suggestion PRs. They then asked for SARIF bootstrapping and an ergonomic way to add their own comment on a line or range. These are recorded in [second-milestone.md](second-milestone.md).
- **Interface naming.** The user delegated naming and asked for independent scrutiny. The resulting critique changed several things:
  - `init` writes with `--output`;
  - `line` and `endLine` are aligned across surfaces;
  - extraction is named `add-staged-changes` / `addStagedChangesToSarif`;
  - the legacy publication form is preserved;
  - finding selection and attached-fix removal are explicit.

  The user then added removal, inspection, optional validation, CLI/library equivalence and human/JSON output, and clarified the goal: an agent authoring and proofreading loop that needs no SARIF knowledge. D30 and the [interface design](second-milestone-interface-design.md) record this.
- **Happy path first.** The user narrowed the next increment to "the happy path first": establish findings, see what is present, incorporate staged changes as fixes, and publish. Removal and correction, and standalone validation, were deferred (D31). Both have since been implemented; see [status](status.md).
- **Freestanding authoring.** Upstream producers must remain first-class, so plain SARIF is the shared format. Authoring is optional, and no downstream step may require helper initialization or helper-only metadata (D32).
- **Assignment.** At the user's request the milestone was written up as an assignment ([second-milestone-goal.md](second-milestone-goal.md)) and carried out. The results are in [second-milestone-work-record.md](second-milestone-work-record.md).
