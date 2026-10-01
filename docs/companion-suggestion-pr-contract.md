# Companion suggestion pull requests: contract

Partly owner-accepted · September 29, 2026. Publication of whole-file operations and explicitly grouped edits as companion suggestion pull requests is implemented under the options below. Suggestion pull requests follow the tool-neutral [suggestion pull request convention](suggestion-pr-convention.md). The default-off setting (§2.1) is the owner's decision on [issue #5](https://github.com/mike-north/sarif-to-comment/issues/5) (recorded in D22 and R16); the options, the convention, labels, draft and ready pull requests, the supported scope and the limits are the owner's decisions on [issue #27](https://github.com/mike-north/sarif-to-comment/issues/27); proposing on a branch that has moved since the review (§2.5) is the owner's decision on [issue #28](https://github.com/mike-north/sarif-to-comment/issues/28), and, after a force-push, keeping every proposal on the reviewed commit and projecting its fidelity before creating it (§2.5.1) follows the owner's decisions D58 and D59; what happens to a suggestion pull request that cannot be made is the owner's decision on [issue #37](https://github.com/mike-north/sarif-to-comment/issues/37), as the delivery policy now states it. Groups, including a fix with several changes and the `group-fixes` authoring step (§2.3, §2.12), are the owner's decisions on [issue #29](https://github.com/mike-north/sarif-to-comment/issues/29). The decision log records these owner decisions as [D22](design-decisions.md#d22-gate-suggestion-prs-with-one-caller-setting--settled-direction), [D41](design-decisions.md#d41-the-suggestion-pull-request-convention-and-options--owner-decisions), [D42](design-decisions.md#d42-test-ancestry-when-the-originals-branch-has-moved--owner-decision) and [D43](design-decisions.md#d43-group-independent-fixes-by-an-explicit-authoring-step--owner-decisions) and [D46](design-decisions.md#d46-fall-back-as-if-suggestion-pull-requests-were-not-allowed--owner-decision). The decisions still listed in [Decisions awaiting acceptance](#4-decisions-awaiting-acceptance) are provisional until the owner accepts or replaces them.

**Since September 30, 2026, the [delivery policy](delivery-policy-contract.md) decides which mechanism delivers each proposed change** ([D48](design-decisions.md#d48-make-publication-policy-caller-controlled--accepted-product-direction-implementation-design-open)–[D55](design-decisions.md#d55-report-unavailable-explicit-delivery-requests-without-silently-substituting--owner-selected-direction)): a companion suggestion pull request is used only for a proposal whose delivery list names `companion`, as the first of its listed mechanisms that is available. The single `allowSuggestionPullRequests` setting and its implicit fallback are removed. This contract keeps what a companion suggestion pull request is, how it is created, recovered and presented, and what prevents one (its obstacles, §2.5).

**Sources.** [Issue #5](https://github.com/mike-north/sarif-to-comment/issues/5); [issue #27](https://github.com/mike-north/sarif-to-comment/issues/27) and the [suggestion pull request convention](suggestion-pr-convention.md); [issue #28](https://github.com/mike-north/sarif-to-comment/issues/28) and the [force-push experiment](force-push-experiment.md); [specification](specification.md) R16 and open contract O11, with R1, R3, R8, R10, R12, R13 and R14; [decisions](design-decisions.md) D7, D12, D14, D21–D29; the [file-operation publication contract](file-operation-publication-contract.md), which remains the form used when suggestion pull requests are not enabled; the [grouped-suggestion](grouped-suggestion-experiment.md), [lifecycle](companion-pr-lifecycle-experiment.md) and [recovery](publication-recovery-experiment.md) experiments; [status](status.md). Cleanup of suggestion pull requests after their original pull request ends ([issue #6](https://github.com/mike-north/sarif-to-comment/issues/6)) is specified separately, in the [suggestion cleanup contract](suggestion-cleanup-contract.md); §5 states what it relies on.

## 1. What is fixed by the sources

> **September 30, 2026 note.** These are the sources as they stood when suggestion pull requests were introduced. The owner's decisions [D48–D60](design-decisions.md#owner-decisions-of-september-30-2026-delivery-policy-and-the-force-push-boundary) replace the allow/disallow setting with the [delivery policy](delivery-policy-contract.md), which is implemented: delivery is caller-controlled, with explicit CLI options over configuration over defaults, so a caller can request native suggestions for every proposed change or companion pull requests for every one ([D48](design-decisions.md#d48-make-publication-policy-caller-controlled--accepted-product-direction-implementation-design-open)); a group is delivered whole, on the original pull request or in one companion pull request ([D49](design-decisions.md#d49-keep-each-supplied-group-available-for-collective-application-in-one-pr--owner-selected-direction-host-verification-open)); whole-file additions and deletions share one setting, which carries their group with them ([D50](design-decisions.md#d50-use-one-delivery-setting-for-whole-file-additions-and-deletions--owner-selected-direction), [D51](design-decisions.md#d51-propagate-whole-file-delivery-over-its-explicit-group--owner-selected-precedence)). Where a bullet below speaks of enabling or disabling suggestion pull requests, read listing `companion`, or not, in the governing delivery list.

- The caller can allow or disallow suggestion pull requests (R16, D22).
- Small edits that a native suggestion represents faithfully prefer the native suggestion in either configuration (R16, D22; A27). Enabling suggestion pull requests never routes a native suggestion to a pull request.
- With suggestion pull requests enabled, a whole-file creation or deletion prefers a suggestion pull request, and an explicitly supplied group of distinct edits requiring acceptance as a unit, or a single SARIF fix with several changes, uses one suggestion pull request containing the whole group (R16, D22; A28, A29, A32; #29).
- With suggestion pull requests disabled, creations and deletions keep their ordinary review presentation ([file-operation contract](file-operation-publication-contract.md)), and a required group is reported as needing suggestion pull requests; it is never split, approximated with independent suggestions or omitted, and the whole-review gate applies (R12, R16, D12, D22; A30, A32).
- Groups are only ever supplied, never inferred, and alternative remedies are never merged into one patch (D7; §2 of the specification).
- A suggestion pull request targets the original pull request's branch. It carries an ordinary reference to the original in its own body and the repository's canonical suggestion label. The original's description is never edited, and the reference is never a closing keyword (D21, D24; A31, A33).
- Once feedback reaches GitHub, SARIF and this tool are implementation details: everything GitHub shows (label, branch, marker, title, body) follows the tool-neutral [convention](suggestion-pr-convention.md) (#27).
- Near-term support is the same repository only, for originals whose base is the default branch; forks and other bases are not yet supported (D25; A34; #27).
- R11 and R12 apply before any proposal-branch, pull-request or label write as well as the review write. Recovery covers every remote object, and a created suggestion pull request is not proof that the review was published (R16, R14, D28).
- Each intended remote object has its own identity, persisted before its uncertain write. Rediscovery must survive a lost response; absence from a listing never establishes that nothing was created, and recovery never depends on a label applied after creation (R14, D28; A37).
- A draft code review may be accompanied by visible draft suggestion pull requests; no extra privacy step is added (R13, D26; A35).
- Publication is one-way. Recovery completes the same initial publication and never restores, reconciles or maintains anything a person changed (D29; A38, A39).

## 2. Decisions

### 2.1 Off by default, and why

**Owner decision (September 29, 2026): suggestion pull requests are explicit opt-in and disabled unless the caller enables them.** The owner recorded it on [issue #5](https://github.com/mike-north/sarif-to-comment/issues/5); [D22](design-decisions.md#d22-gate-suggestion-prs-with-one-caller-setting--settled-direction) and [R16](specification.md#r16-select-publication-forms-using-the-suggestion-pr-setting) state it. Since the [delivery policy](delivery-policy-contract.md), the opt-in is listing `companion` in a delivery list (by a flag, the `delivery` option, a preset, or the repository's `.github/sarif-to-comment.json`); the defaults list no companion ([delivery policy §5](delivery-policy-contract.md#5-defaults)). The evaluation below is the evidence the decision rests on.

D22 earlier recorded "enabled when omitted" as a *low-conviction* default, to be validated against "PR clutter and repository automation triggered by PR creation". Issue #5 asks for that evaluation. It found the costs of an enabled default concrete and the benefit small:

| Consideration | Enabled by default | Disabled by default (adopted) |
| --- | --- | --- |
| Behavior of existing callers | Changes silently on upgrade: a document with a file operation, which today publishes one review, would start creating branches and pull requests, and would need new permissions (branch push, labels). | Unchanged byte for byte: the same requests, the same review body, the same state file. |
| Repository clutter | One extra pull request and branch per standalone file operation and per group, visible to every repository reader, persisting until someone closes them (cleanup is a separate, on-demand action, [#6](https://github.com/mike-north/sarif-to-comment/issues/6)). | Only callers who asked for pull requests get them. |
| Triggered automation | Every created pull request can start CI workflows (`pull_request` events run for draft pull requests unless a workflow opts out), notify watchers and code owners, trigger bots, and count against required-check and runner budgets. None of this is visible to the reviewer publishing SARIF, and the lifecycle experiments confirmed that the repository's own required checks ran on suggestion pull requests. | The caller opts into those costs knowingly. |
| Failure surface | New failure modes for everyone: missing push permission, a missing label, fork pull requests, a moved head. Each would block reviews that publish today. | Those checks apply only when requested. |
| What is lost | Grouped edits and pull-request-based file operations work without a flag. | Grouped edits need one explicit setting; without it they are refused with the setting named (never split). Creations and deletions still publish, in the review body. |

The asymmetry decides it: an enabled default imposes surprise costs on every repository to save one flag for the callers who want the feature, and turning it off after the fact does not remove pull requests already created. The explicit disable choice D22 requires remains available: a list that does not name `companion` never creates one, for example the `original-pr` preset.

### 2.2 Options

Owner decisions of September 29, 2026 ([#27](https://github.com/mike-north/sarif-to-comment/issues/27)). A flag's name says what kind of value it takes: a switch reads as a switch, a list as a list.

Whether a proposal goes to a suggestion pull request is the [delivery policy](delivery-policy-contract.md#12-caller-settings)'s: `options.delivery` and `--delivery`, `--edits`, `--grouped-edits`, `--file-operations`, `--companion-bundle`. These options say how the suggestion pull requests that are planned are made:

| Library (`options`) | CLI | Meaning |
| --- | --- | --- |
| `pullRequestLabels?: string[]` | `--pr-labels a,b,c` | Extra labels every suggestion pull request carries **in addition to** the canonical label (§2.7), for example a team or campaign tag. |
| `markSuggestionPullRequestsReady?: boolean` | `--mark-suggestion-prs-ready` | Create suggestion pull requests ready for review instead of as drafts. Drafts are the default. |

- Both are valid with any delivery policy and are never a `TypeError` or a usage error for that reason, because whether a companion is planned is known only once the configuration is read and the proposals are routed. A publication planned with no suggestion pull request reports a `companion-options-unused` note naming the options given with an effect ([delivery policy §12](delivery-policy-contract.md#12-caller-settings)).
- Each extra label is a label name under the [convention](suggestion-pr-convention.md#3-the-canonical-label): 1–50 characters, no control or invisible formatting characters, no surrounding whitespace, **no comma**. The library refuses anything else with a `TypeError`. The CLI splits `--pr-labels` at commas and trims the spaces around each name, so `--pr-labels "docs, team-a"` names `docs` and `team-a`; an empty name (`a,,b`, a trailing comma, an empty value) is a usage error. A name cannot contain a comma in either form.
- Extra labels are deduplicated case-insensitively, keeping the first spelling given: first among themselves, then against the canonical label, which always comes first. Listing the canonical label is therefore harmless. `pullRequestLabels: []` is the same as omitting it.
- **Removed:** `suggestionLabel` / `--suggestion-label`. There is no per-call override of the canonical label: the label is a repository-wide convention (§2.7), and cleanup depends on it. The earlier names `suggestionPullRequests` / `--suggestion-prs`, and the opt-in `allowSuggestionPullRequests` / `--allow-suggestion-prs`, are replaced by the delivery policy's settings. None of them was released, so no compatibility shim exists: the old option names are refused as unknown options (`TypeError`), and the old flags as unknown options (exit 1).

`validateSarifReview` and `validate` accept the same options, because they take publication's options.

**Publication identity.** These settings are part of the publication's input identity: when either is given with an effect (at least one extra label, or `markSuggestionPullRequestsReady: true`), the input fingerprint's identity document gains

```text
suggestionPullRequests: { markReady: <boolean>, pullRequestLabels: [<extra labels, deduplicated among themselves, in the order given>] }
```

Otherwise the identity document has no such member, so `pullRequestLabels: []` and `markSuggestionPullRequestsReady: false` are the same publication as omitting them. The caller's existing companions (`existingCompanions`, §2.13.1) and delivery settings are part of it too ([delivery policy §13](delivery-policy-contract.md#13-recording-the-resolved-policy)). Retrying a state path with any different setting is refused as a `state-mismatch` ("belongs to a different original input") before any request. The canonical label is not a caller setting: it is resolved from the repository once, when the publication is planned, and recorded in the plan (§2.9), so a later change to the repository configuration never changes a publication already planned; the same holds for the delivery configuration.

### 2.3 Groups: a fix with several changes, and explicit groups

> **September 30, 2026 note.** A group's delivery is the [delivery policy](delivery-policy-contract.md#8-routing-each-unit)'s: an edit group (an explicit group of edits, or a fix with several changes) follows `groupedEdits`, and a group with a whole-file creation or deletion follows `fileOperations` as a whole ([D49](design-decisions.md#d49-keep-each-supplied-group-available-for-collective-application-in-one-pr--owner-selected-direction-host-verification-open), [D51](design-decisions.md#d51-propagate-whole-file-delivery-over-its-explicit-group--owner-selected-precedence)). A group is never split; when no listed mechanism can deliver it, the review is blocked with `delivery-unavailable`. The authoring step, the group rules below and the rule that nothing is inferred are unchanged.

SARIF groups changes natively only within one fix: a single `fix` with several `artifactChanges` or `replacements` means "apply together". It cannot join fixes of different findings, or an edit with a whole-file creation or deletion. The owner's model ([#29](https://github.com/mike-north/sarif-to-comment/issues/29), September 29, 2026) keeps both:

**A fix with several changes is a group of its own**, with no extra property.

- Its replacements are located in the unmodified file and applied as if in array order, the reading staged extraction already uses; their combined effect is therefore defined only when they are disjoint and no two start at the same position, and otherwise the review is blocked (`fix-replacements-overlap`). Several artifact changes naming one file are that file's replacements.
- Replacements whose lines overlap become one change of the union of their lines; changes of one file are combined in line order. The change count is the number of such changes.
- It is an edit group of the delivery policy and follows `groupedEdits`. It is never split into separate suggestions (A30): when no listed mechanism can deliver it, the review is blocked (`delivery-unavailable`). This version does not yet offer such a fix as a native batch ([delivery policy §8.8](delivery-policy-contract.md#88-what-this-version-supports)), so under the defaults it is blocked, as it was refused before (`fix-changes-require-suggestion-prs`, retired): the known limitation that [#30](https://github.com/mike-north/sarif-to-comment/issues/30) allowed to be recorded ([D44](design-decisions.md#d44-publish-the-first-fix-and-list-the-others-as-alternatives--owner-decision)).

**An explicit group** is declared by a per-result owned property:

```json
"properties": { "sarifToComment": { "suggestionGroup": "retry-with-test" } }
```

- It is written by `group-fixes` / `groupSarifFixes` (§2.12), not by hand. Results whose `suggestionGroup` values are equal form one group, across every run of the log. The value is an identifier the caller chooses; it is shown only in the suggestion pull request's title. It must be 1–100 characters with no control or invisible formatting characters and no leading or trailing whitespace (`suggestion-group-invalid`). The property is input-side only; GitHub never sees it.
- A member's change is its **primary (first) fix**, with every change that fix makes, or its `proposedFileChanges` creation or deletion. Further fixes are alternatives: they are listed with the finding, never grouped, committed or unioned ([#30](https://github.com/mike-north/sarif-to-comment/issues/30)). A member with no change is refused (`suggestion-group-member-without-change`): a group joins changes, and feedback without a change has nothing to join.
- Members that carry the identical change (same path, range and replacement text; or the same whole-file operation) share it, as identical suggestions and identical proposals already do (R8). A group must hold at least two distinct changes (`suggestion-group-single-change`); a single change is published on its own.
- Nothing is inferred. Results without the property are never added to a group, and two groups are never joined, even when they touch the same file.
- A change is carried by one group or by none. When a finding outside a group carries a change identical to one of the group's changes (in another group, or in none), the review is blocked (`suggestion-group-change-shared`) at the later of the two findings, naming the group, both findings and the change: the group's delivery and the other finding's own presentation would each propose it, and neither could be accepted after the other (§2.4, Conflicts). The identical change is never moved into the group, because that would add a finding the group does not declare. `group-fixes` and `ungroup-fixes` never write such a document (§2.12); publication judges identity against the reviewed files, so it also refuses a document written by hand or whose changes differ only in how they are written ([#42](https://github.com/mike-north/sarif-to-comment/issues/42)).
- A group is one delivery unit: it is delivered whole by the first available mechanism its list names, or the whole review is blocked with `delivery-unavailable` at its first member (A30, A32). `suggestion-group-requires-suggestion-prs`, which refused every group without suggestion pull requests, is retired.

The property was called `acceptanceGroup` until #29; that name was never released, so it is now an unknown owned key and blocks the review as `owned-property-invalid`. Documents without the key behave exactly as before.

### 2.4 Presentation-form selection

The form of each proposal is the mechanism the [delivery policy](delivery-policy-contract.md#8-routing-each-unit) routes its unit to: the first available mechanism of the governing list, with an announced `delivery-fallback` when it is not the first, or a `delivery-unavailable` block when none is. Under the defaults:

| Proposal | Defaults | With a list naming `companion` |
| --- | --- | --- |
| Edit eligible for a native suggestion, not in a group | Native suggestion (`edits: [native]`) | `edits` decides: for example `[companion]` gives it a suggestion pull request of its own (D48) |
| Standalone whole-file creation or deletion | Review-body section ([file-operation contract](file-operation-publication-contract.md)) | `fileOperations: [companion]`: one suggestion pull request per distinct operation; findings carrying the identical operation share it |
| A fix with several changes, not in a group | A native batch when every change is eligible, otherwise blocked | `groupedEdits: [companion]`: one suggestion pull request per distinct fix |
| Explicit group of edits | A native batch when every change is eligible, otherwise blocked | `groupedEdits: [companion]`: one suggestion pull request containing every change of the group |
| Explicit group with a whole-file creation or deletion | The mixed manual group: one review-body section holding every member, to make by hand and commit once ([delivery policy](delivery-policy-contract.md) §8.10) | `fileOperations: [companion]`: one suggestion pull request containing every change of the group |
| Edit that no native suggestion can represent, not in a group | Blocked: `delivery-unavailable`, naming the native obstacle (for example its lines are outside the diff) | `edits: [native, companion]`: a suggestion pull request of its own, with a `delivery-fallback` warning |

The behavior of the removed `allowSuggestionPullRequests: true` is `groupedEdits: [companion]` with `fileOperations: [companion, manual]`: a whole-file proposal whose suggestion pull request cannot be made falls back to its review-body section, now announced by `delivery-fallback` instead of `suggestion-pr-fallback`.

Native-suggestion eligibility does not depend on whether the reviewed commit is still the pull request's head: an edit is eligible when its lines have a valid anchor on the reviewed diff ([specification R13.1](specification.md#r131-the-reviewed-diff-historical-placement-and-native-suggestions), October 1, 2026). So an edit at a reviewed commit that the head moved past, or that a force-push discarded, is delivered as the first row says, like any other.

A change committed in a suggestion pull request (an edit, a group edit, or a change of a fix with several changes) is applied to the reviewed file exactly as a native suggestion's replacement would be (the replacement module's exact edit), but it does not need native-suggestion eligibility: it is committed, not rendered. The existing association rule still applies: a located member's own lines must lie within its replacement's lines (one of them, for a fix with several changes; `fix-association-unsupported`), so feedback is never moved.

**Conflicts.** Each delivery unit (an edit, a group, a fix with several changes, a whole-file proposal) must be acceptable independently of the others, whatever delivers it. The whole review is blocked when two units propose different changes to the same lines (`overlapping-replacements`), or when a path is created or deleted in one unit and changed in any way by another (`file-operation-conflict`). A group's change that a finding outside the group also carries is refused as `suggestion-group-change-shared` instead, naming the group (§2.3). Within one group, non-overlapping edits of one file are combined in line order; overlapping different edits are refused.

### 2.5 Repository, target branch and revision

- **Supported scope** (owner decision, #27): original pull requests whose head branch is in the repository itself and whose base is the repository's **default branch**. Other bases and forks are **not yet supported**. For such a pull request no suggestion pull request can be made: `companion` is unavailable for every unit, with an obstacle that names the capability that is missing, not a policy (§2.5.1), and each unit falls back to a later mechanism of its list or blocks ([delivery policy §10](delivery-policy-contract.md#10-blocking-and-announced-fallback)):
  - a fork: the suggestion would have to be opened in the fork, as a pull request into the fork's branch, and this tool creates branches and pull requests only in the original's repository. A possible later route is a pull request from the reviewer's fork into the original fork's branch. A head repository that was deleted leaves no branch to propose into.
  - another base: following a suggestion through an original that merges into a branch other than the default branch (for example one pull request of a stack, which GitHub retargets when the branch below it merges) has not been built or verified yet.
- **Association** ([specification R17](specification.md#r17-publish-only-about-a-commit-of-the-pull-request), October 1, 2026). Before anything is prepared, the reviewed commit must be the head, an ancestor of it, or within a head a force-push replaced. Otherwise the review is blocked (`reviewed-commit-not-in-pull-request`) and no suggestion pull request is planned or created; when that cannot be established, publication proceeds with the note `reviewed-commit-association-unknown`.
- **Target.** Each suggestion pull request's base is the original pull request's head branch (`head.ref`), read from the pull request during validation. Because the original's base is the default branch, its head branch never is.
- **Base commit.** Each proposal branch is one commit whose parent is the **reviewed commit**. The proposed changes are therefore exactly the pull request's diff from the reviewed state, never a rebase or a merge.
- **A head that moved on since the review** (owner decisions, [#28](https://github.com/mike-north/sarif-to-comment/issues/28), [D58](design-decisions.md#d58-do-not-abort-historical-review-publication-merely-because-the-pr-branch-changes--owner-selected-force-push-direction); [convention §5.1](suggestion-pr-convention.md#51-when-the-originals-branch-has-moved-since-the-review)). The tool tests ancestry, not equality, and never moves a proposal off the reviewed commit. When the pull request's head is not the reviewed commit, validation compares them (`GET compare/{reviewed}...{head}`):
  - `ahead`: the reviewed commit is an ancestor of the head, so the branch only moved forward. Publication proceeds exactly as for the head: each proposal branch's parent is the reviewed commit, and GitHub shows any conflict with the later commits.
  - `behind` or `diverged`: the history was rewritten (a force-push, amend or rebase). Each proposal branch's parent is still the reviewed commit. Before it is created, whether merging it would apply exactly its own changes is projected (§2.5.1); when it would not, `companion` is unavailable for its unit.

  The comparison is read only when a unit's `companion` availability is first asked ([delivery policy §8.7](delivery-policy-contract.md#87-availability-is-an-input)), the head moved, and the pull request is one suggestion pull requests support (same repository, default-branch base); it is read at most once, during preparation, because what is created depends on it. A review that creates no suggestion pull request never reads it, so its failure can never refuse one. When it is read, a failed read is operational (`publish` rejects, `validate` answers `incomplete`) and nothing is written. The same holds for every read of the projection.
- **A head that moves later** (after validation, or after the projection) is not chased. The branch keeps the reviewed commit as its parent, the pull request still targets the head branch, and nothing is retargeted, rebased, re-validated or projected again on retry (§2.10). GitHub shows the suggestion's own changes; whether they still merge cleanly is for the person accepting them.
- **Draft or ready.** Suggestion pull requests are created as drafts, in both review modes, unless `markSuggestionPullRequestsReady` asks for them ready for review (owner decision, #27). A draft avoids automatic review requests to code owners, and cannot be merged until someone with write access marks it ready (the lifecycle, §2.11). A repository that does not allow draft pull requests refuses the create; that refusal is recorded like any other (§2.9).

<a id="251-re-application-after-a-rewritten-history"></a>

### 2.5.1 Fidelity after a rewritten history

> **October 1, 2026.** The owner's decisions [D58](design-decisions.md#d58-do-not-abort-historical-review-publication-merely-because-the-pr-branch-changes--owner-selected-force-push-direction) and [D59](design-decisions.md#d59-treat-force-push-review-lifecycle-as-host-behavior-not-a-new-publisher-service--owner-selected-boundary): a suggestion pull request is always proposed on the reviewed commit, and is never re-applied or rebased onto a later commit. After a rewritten history, whether merging it would apply exactly its own changes is projected before it is created, and a suggestion that would bring back discarded content is not created. This replaces the re-application this section used to specify, which was never released. What happens when a suggestion pull request cannot be made is the [delivery policy](delivery-policy-contract.md#10-blocking-and-announced-fallback)'s ([D55](design-decisions.md#d55-report-unavailable-explicit-delivery-requests-without-silently-substituting--owner-selected-direction)), as below.

Write R for the reviewed commit, H for the pull request's head read when the publication is planned (§2.5), and P for the proposal commit as §2.6 builds it: R's tree with the suggestion's changes. When R is not an ancestor of H, GitHub measures the suggestion pull request from the merge base of H and P. Its displayed diff then also lists R's own changes, and merging it can bring back content the rewrite removed ([GH-14](github-behavior.md#gh-14--reviews-survived-force-pushes-a-companion-built-on-a-discarded-commit-carried-that-commit), [GH-18](github-behavior.md#gh-18--a-companions-file-list-and-compare-showed-the-merge-base-diff-not-what-a-merge-would-change)). Neither GitHub's file list, nor its comparison, nor its mergeability shows what a merge would do, so the tool projects it.

**Faithful.** A suggestion pull request is faithful when merge(H, P) is the head with exactly its own changes, diff(R, P), applied: merging it into the head's branch changes nothing other than its own changes. When the head already has them, merging it changes nothing at all, and its description says so (§2.11). A discarded commit in its history is not, by itself, a reason to refuse it.

**The projection.** For each suggestion pull request of the plan (under `companionBundle: single`, the bundle as planned so far, [delivery policy §9](delivery-policy-contract.md#9-companion-bundles)):

1. M is the merge base GitHub names: the `merge_base_commit` of `GET compare/{R}...{H}`, the comparison that also tells whether R is an ancestor of H.
2. The complete trees of M, R and H are read recursively (`GET git/trees/{tree}?recursive=1`). P's tree is R's with the suggestion's changes, computed locally: an edited file keeps its mode, a created file has its proposed mode, a deleted file is absent. Each path's entry is its mode, type and object id; absence is a value. Renames are not detected.
3. The paths projected are those whose entry in P differs from M's or from R's: diff(M, P) ∪ diff(R, P). Every other path is the head's in both results below.
4. For each path, two three-way merges are computed, each with H as one side and P as the other: the **merge**, over M (what merging the pull request does), and the **target**, over R (the head with only the suggestion's own changes). Entries merge as Git merges them. When the two sides are equal, or one side equals the base, the result is decided without content. A regular file changed differently on both sides is merged line by line, over an empty base when the base lacks it. Its mode merges the same way. The line merge follows Git's: histogram diffs, and changes that overlap or touch conflict unless they are identical. Only the blobs of such files are read (`GET git/blobs/{sha}`); the suggestion's own bytes are known locally.

   **Merge attributes.** Before a path is merged line by line in either merge, or when the merge conflicts at it, the head's `.gitattributes` files on its way are read: the root's and each of its ancestor directories', each once. Their patterns are matched as [gitattributes(5)](https://git-scm.com/docs/gitattributes) specifies: relative to the directory of the file that holds them; a pattern without a slash matches the last segment at any depth; a leading `/` anchors it; `*` and `?` never match a slash, and `**` matches across directories; a pattern ending in `/` matches no file; a negative pattern (`!pattern`) is ignored, as Git ignores it; a quoted pattern is unquoted. Patterns match UTF-8 bytes as Git's wildmatch does, case-sensitively, bracket expressions included; a pattern Git cannot complete matches nothing. Git discards a malformed line (one with an invalid attribute name, so also one whose attributes end in a `# comment`; a `[attr]` line outside the root file; or a line of 2,048 bytes or more), and the projection discards it too; `-merge=VALUE` unsets `merge`, as in Git. Later lines win, and a deeper file wins over one nearer the root. The built-in macro `binary` and the root file's `[attr]` macros are expanded where a line sets them. When the `merge` attribute in effect is anything other than the text merge (unspecified, set, or `merge=text`), for example `merge=union`, `-merge`, a custom driver or `binary`, Git's merge of that file is not the line merge above, and the path meets a limit. A path no line merge involves and that does not conflict is merged without content, whatever its attributes.
5. Each path's verdict is the first of these that holds:

   | The path | Verdict |
   | --- | --- |
   | Meets a limit (below) | **cannot be projected** |
   | The target conflicts in its entry: the head deleted the file, or changed its kind, while the suggestion changes it | **cannot be expressed at the head** |
   | The merge conflicts | **conflicts**, unless merging R itself over M, with every conflict resolved to the head's side, does not give the head's entry: the merge would then bring back content the head no longer has, **beside the conflict** |
   | The target conflicts in its lines (the merge does not) | **cannot be expressed at the head** |
   | The merge equals the target | **faithful** |
   | The merge leaves the head's entry, and the target does not | **would lose its change** |
   | The merge removes the head's file, and the target does not | **would be removed from the head**: a deletion the rewrite dropped would be applied again |
   | Otherwise | **would bring back content the head no longer has**: an entry, a mode, or lines |

   A path that would be both a file and a directory, in the target or in the merge, **cannot be expressed at the head**.
6. **Limits.** The projection cannot decide, and says so, for: a tree GitHub lists as truncated (beyond 100,000 entries or 7 MB); a comparison that names no merge base; a file that is binary (Git's test: a NUL byte in its first 8,000 bytes) and changed differently on both sides; a symbolic link or submodule changed differently on both sides, or changed in kind on either side while the other also changes it; a blob that would have to be merged but is larger than the 1,000,000-byte read limit, or that GitHub lists without its size (it is not read); a **merge attribute** other than the text merge that applies to a path (above); a `.gitattributes` file that differs between M, R, H and P when any of its versions could assign a merge driver (it sets `merge` in any state, or `binary`, or a macro that sets `merge` that any version of the root file defines, or it defines such a macro), since which commit's attributes GitHub's merge reads is not modelled; a `.gitattributes` on a merged path's way that is not a regular file, or cannot be read within the read limit; and a **directory-rename trigger**, a path added on one side (relative to M) under a directory that exists in M but that the other side removed entirely, which Git's directory-rename detection could move. The trigger is conservative: it holds whether the other side removed the directory by renaming it or by deleting its files, though Git's detection moves a path only after a rename.

The suggestion pull request's verdict follows from its paths:

| Paths | Verdict | What happens |
| --- | --- | --- |
| Every path faithful | **faithful** | It is created on R, as any other. Its description says that the reviewed commit is not part of the branch, and shows its own changes (§2.11). |
| Some path conflicts, and none is worse | **conflicts** | It is created on R, as planned, with the warning `companion-conflicts-at-head` naming the paths. Once it exists, GitHub's `mergeable` is read back and reported as observed (§2.11). |
| Any path would bring back content, would lose its change, cannot be expressed at the head, or cannot be projected | **unfaithful** | `companion` is unavailable for its unit, with the obstacles below. |

**A projection, labelled as one.** Every verdict made before creation is a projection: a local computation over GitHub's trees and blobs, not a merge GitHub performed. GitHub's merge engine was not observed on adjacency, directory renames or a live merge. Diagnostics, obstacles and descriptions call it a projection, and the observed `mergeable` is reported separately from it.

**Known limits.** The projection reproduces Git's own merge (Git 2.54's merge-ort and xdiff) under its defaults. It does not model:

- **Renames.** A file the head renamed while the suggestion changes it projects as a conflict (one side deleted it, the other changed it), though GitHub's merge, which detects renames, may merge it cleanly through the rename.
- **More than one merge base.** The projection uses the one GitHub names. The scenario of this case that was assessed projected the same verdict as Git's recursive merge base.
- **Repository attributes beyond merge drivers.** A merge driver set in the repository's `.gitattributes` is detected and is a limit (above). `text`/`eol` normalization and whitespace options are not modelled, and attributes outside the repository's tree (`$GIT_DIR/info/attributes`, `core.attributesFile`) cannot be read.
- **GitHub's own Git.** It may be another version than the one the projection follows.

**What it costs.** Nothing beyond today's reads unless the head moved. When it did, the comparison `GET compare/{R}...{H}` is read once, as it was before. When R is not an ancestor of H, these are read once per publication, shared by every suggestion pull request:

- at most 2 commit reads, `GET git/commits/{sha}` for M and H (R's was already read for its source);
- 3 recursive tree reads, `GET git/trees/{tree}?recursive=1`, for M, R and H;
- for each path whose line merge is needed, `GET git/blobs/{sha}` for each of its blobs at M, R and H not already read: at most 3 per such path, each blob read once;
- for each path whose line merge is needed or whose merge conflicts, the head's `.gitattributes` on its way, root and ancestor directories, `GET git/blobs/{sha}`, each file read once however many paths share it: at most d, the number of distinct directories on those paths' ways that hold one;
- only when some `.gitattributes` differs between M, R, H and P: each distinct version of the root `.gitattributes` and of each such file, each blob read once: at most 4 per such file.

That is at most 6 + 3k + d + 4c requests, where k is the number of paths both the head and the suggestion changed differently, d as above, and c the number of `.gitattributes` files that differ (plus the root's). A suggestion pull request projected to conflict costs up to 4 more reads once it exists (§2.11). A publication whose lists never reach `companion`, or whose reviewed commit is an ancestor of the head, makes none of these reads.

**Decided once.** The projection is made when the publication is planned, and recorded in the plan with the head it was made on (§2.9). A retry never projects again or re-decides, even if the head was rewritten again in between; it reports that the projection no longer applies (§2.10).

**When a suggestion pull request cannot be made.** It cannot be made when its projection is unfaithful (above); when the pull request is one suggestion pull requests do not support yet (a fork, a deleted head repository, or a base other than the default branch, §2.5); when a created file is over 1,000,000 bytes; or when its description would be over the 60,000-character body limit (§2.8). Each is an **obstacle** of `companion` for that unit ([delivery policy §8.7](delivery-policy-contract.md#87-availability-is-an-input)), one sentence each, in this order:

- ``The pull request's head branch `B` is in the fork O/R, and suggestion pull requests are not yet supported for a pull request from a fork.``
- ``The pull request's head repository was deleted, so there is no branch to propose it into.``
- ``The pull request merges into `X`, which is not the default branch `D` of O/R, and suggestion pull requests are not yet supported for such a pull request.``
- ``The history of #7 was rewritten after the reviewed commit, and projected onto its head `H`, merging its suggestion pull request would not apply exactly its own changes: REASONS.``, where REASONS, joined by `; ` in path order, are `` `PATH` would bring back content the head no longer has``, `` `PATH` would bring back content the head no longer has, beside a conflict``, `` `PATH` would be removed from the head``, `` `PATH` would lose its change``, `` its change to `PATH` cannot be expressed at the head`` and `` `PATH` would be both a file and a directory``;
- ``The history of #7 was rewritten after the reviewed commit, and whether merging its suggestion pull request into the head `H` would apply exactly its own changes cannot be projected: LIMITS.``, where LIMITS, joined by `; `, are ``GitHub listed the tree of commit `C` as truncated``, ``GitHub named no merge base of the reviewed commit and the head``, `` `PATH` is binary and changed on both sides``, `` `PATH` is a symbolic link changed on both sides``, `` `PATH` is a submodule changed on both sides``, `` `PATH` changes kind on one side and changes on the other``, `` `PATH` is larger than the 1,000,000-byte read limit``, ``GitHub listed `PATH` without its size``, ``a merge attribute (`merge=union`) applies to `PATH`; its merge cannot be projected`` (naming the attribute as written: `-merge`, `binary`, a macro), `` `PATH` differs between the commits and could assign a merge attribute``, `` `PATH` is not a regular file, so its attributes cannot be read`` and `` a new file under `DIR/` lands in a directory the other side removed, which Git's directory-rename detection could move``;
- `` `PATH` is N bytes, and a suggestion pull request carries at most 1000000 bytes per file.``
- ``Its suggestion pull request's description would be N characters, and the limit is 60000.``

The two projection obstacles carry the remedy `Review the pull request's current head again, and publish that review.` The unit is then delivered by the next available mechanism its list names, with a `delivery-fallback` warning naming these obstacles, or, when none is, the review is blocked before anything is written, with a `delivery-unavailable` error naming them. Nothing unlisted is substituted. For example, under `fileOperations: [companion, manual]` a whole-file proposal whose suggestion pull request cannot be made is presented in the review body exactly as without suggestion pull requests (the review-body proposal of the [file-operation contract](file-operation-publication-contract.md), at its position, with its findings, held to that contract's limits, not to §2.8's per-file limit), with a `delivery-fallback` warning; under `fileOperations: [companion]` the review is blocked. After a fallback, the change is judged by the limits of the mechanism that delivers it: a created file over 1,000,000 bytes, for example, then usually makes the review body too large (`body-too-large`), whose message names the fallback that put it there ([delivery policy §10.1](delivery-policy-contract.md#101-blocked-no-listed-mechanism-is-available-d55)).

One unit's fallback is not a refusal of the review: in a document with a faithful suggestion and a whole-file proposal that falls back, the first is created and the second presented in the body. `validate` reports the same outcome and diagnostics before anything is written. A review whose units all fall back needs no suggestion pull request at all: it is published exactly like one without them (no labels, permission or label configuration are needed).

The limit of 10 suggestion pull requests (§2.8) counts the ones that would be created.

### 2.6 Branch naming and ownership

Each suggestion's proposal branch is `suggestion-pr/<pull number>/<suggestion id>` ([convention §5](suggestion-pr-convention.md#5-the-branch)), where the suggestion id is a random v4 UUID generated once per suggestion and persisted before any write. The name is unique to one suggestion of one publication, so a new publication (a new state path) never collides with an earlier one.

The tool owns only branches it created, and only to create them: it creates each branch exactly once, pointing at its proposal commit, and never updates, force-pushes, rebases or deletes it. A branch a person has since changed is left as it is (§2.10). Deleting branches is outside publication; cleanup closes pull requests only, and branch removal is left to people or to GitHub's automatic deletion of merged branches.

The proposal commit is created through GitHub's Git database API: one blob per created or edited file, whose Git blob id is computed locally from the exact proposed bytes and must equal the host's answer; one tree based on the parent's tree (a deletion is a `sha: null` entry); one commit with the parent as its only parent. The parent is the reviewed commit, whatever happened to the branch since (§2.5.1). A plan written before re-application was removed, of version 2 (§2.9), is continued as it was planned: its parent is its `reappliedOnto`. Before the branch is created, the commit is read back: its tree, parent, and every changed path (blob id and mode, or absence for a deletion) must be exactly as proposed. An edited file keeps its existing mode; a created file has its proposed mode. These objects are content-addressed and invisible until a branch points at them, so creating them again after a failure creates nothing a person can see and is not an uncertain write.

### 2.7 Relationship: reference, marker and labels

A suggestion pull request's body establishes the relationship; the original pull request is never edited. Everything below is the [convention](suggestion-pr-convention.md); nothing GitHub shows names SARIF or this tool.

- **Ordinary reference.** The body begins `Suggested in a review of #<pull> at commit <reviewed commit>.` The `#<pull>` reference creates GitHub's cross-reference on the original pull request (the D21 backlink). It is not a closing keyword.
- **Structured marker.** The body ends with one hidden line ([convention §7](suggestion-pr-convention.md#7-the-marker)):

  ```
  <!-- suggestion-pr {"version":1,"original":{"owner":"<owner>","repo":"<repo>","pullNumber":<pull>},"reviewedCommit":"<40-hex>","id":"<suggestion id>","batch":"<publication id>"} -->
  ```

  The JSON is canonical: exactly these members in this order, no whitespace. `id` identifies this suggestion (its branch carries it), `batch` groups the suggestions of one review (this tool uses its publication id, one per state path), `original` names the original pull request, and `reviewedCommit` the proposal's parent. Every suggestion pull request this tool creates carries version 1. The version-2 marker of a re-applied suggestion, `{"version":2,…,"reviewedCommit":"<40-hex>","reappliedOnto":"<40-hex>","id":…,"batch":…}`, is no longer written, but it stays part of the [convention](suggestion-pr-convention.md#7-the-marker): cleanup recognizes it, and a version-2 plan (§2.9) still creates and finds its suggestion pull requests with it. The marker is metadata, not a secret, and never contains `-->`. The review-body marker released in 0.2.x is not part of the convention and is unchanged.
- **Canonical label.** Resolved identically by `publish`, `validate` and `close-suggestion-prs`: the `label` of the optional, read-only, hand-maintained `.github/suggestion-prs.json` (`{ "label": "…" }`), read from the current commit of the repository's **default branch** so that a pull request cannot change its own label; otherwise **`suggestion-pr`**. The tool never writes that file, and keeps no state in the repository. The file's states are exactly those of [convention §4](suggestion-pr-convention.md#4-repository-configuration):

  | File on the default branch | Outcome |
  | --- | --- |
  | Absent, or an object without `label` | The default `suggestion-pr` |
  | An object whose `label` is a valid label name | That label |
  | Invalid UTF-8 or JSON; not an object; `label` not a string; `label` empty, containing a comma or otherwise not a label name; a directory, symbolic link or submodule at the path, or a symbolic link or submodule on the way to it (never followed) | **blocked** before any write (`suggestion-pr-configuration-invalid`), with a problem naming the file and the field; `validate` reports the same |
  | The read failed (network, HTTP 403, 5xx, a malformed answer) | Operational: `publish` rejects and `validate` answers `incomplete`. Never a silent default. |

  The file is read through Git objects (the default branch's reference, its commit, the trees on the path and the blob), never the Contents API, which would follow a symbolic link to another path's text. A configuration file over the 1,000,000-byte source limit is invalid.
- **Labels applied.** Every suggestion pull request carries the canonical label and every extra label (§2.2), all added in one request after creation. **Every label must already exist:** validation reads each one and, if any is missing, blocks the whole review before any write (`suggestion-label-missing`, one problem per missing label, naming it and where it came from); `validate` reports the same. The tool never creates labels, so a typo cannot create a stray label and label administration stays with the repository. Each label's name as the host reports it is what is applied.
- **Permission.** Validation reads the repository's permissions for the authenticated account and blocks when it cannot push (`suggestion-pr-permission-missing`). This reflects the account's role; a token restricted below that role is discovered only when a write is refused (§2.9).

### 2.8 Readiness

Everything below runs in the shared review preflight, so `validate` and `publish` report the same outcome. It is read-only.

1. Whole-review preparation of the SARIF under the resolved [delivery policy](delivery-policy-contract.md): every rule of §2.3–§2.4, the file-operation rules, and the existing limits. When suggestion pull requests are planned, one more limit applies: at most **10 suggestion pull requests** per review (`too-many-suggestion-prs`), a conservative product limit against pull-request storms, counting the ones that would be created after bundling ([delivery policy §9](delivery-policy-contract.md#9-companion-bundles)). Every suggestion pull request body is held to the existing 60,000-character limit, never truncated, and a created file in one may hold at most 1,000,000 bytes, the source-read limit; a suggestion over either limit cannot be made, which is an obstacle of `companion` (§2.5.1). File-content refusals of the file-operation contract (for example bare carriage returns) still apply. These limits are the owner-accepted ones (#27), and they are this tool's, not the convention's.
2. The pull request's branches and repositories and the repository's default branch and permissions are read during preparation, the first time a unit's `companion` availability is asked ([delivery policy §8.7](delivery-policy-contract.md#87-availability-is-an-input)), because the suggestion texts name the head branch; their comparison is read lazily too, when the head is not the reviewed commit and the pull request is one suggestion pull requests support (§2.5), because what is created depends on it. A fork, a deleted head repository or a base other than the default branch is an obstacle of `companion` (§2.5.1). Only when the ready preparation plans at least one suggestion pull request are the repository checks applied, all reported together: `suggestion-pr-permission-missing`, `suggestion-pr-configuration-invalid`, `suggestion-label-missing`. A head that moved is never among them (§2.5). The label configuration and the labels are read only then (the canonical label is not checked when the configuration is invalid; the extra labels still are). A failed read is operational (`publish` rejects, `validate` answers `incomplete`). A publication whose lists never reach `companion` makes none of these reads.
3. The authenticated account's numeric id, as today.
4. Each existing companion the caller names (`existingCompanions`, §2.13.2) is read before preparation, and one that cannot be listed in the companion index blocks with `companion-not-reusable`, reported after preparation's problems. Each one that can is a `companion-reused` note stating its state.

A `ready` assessment with suggestion pull requests says how many would be created, into which branch, in which form and with which labels, for example ``Publication would also create 1 draft suggestion pull request into `feature/retry`, labeled `suggestion-pr`.`` or ``Publication would also create 2 suggestion pull requests, ready for review, into `feature/retry`, labeled `suggestion-pr` and `docs`.`` When the history was rewritten after the reviewed commit and they were projected (§2.5.1), it adds ``The history of #7 was rewritten after the reviewed commit, so it is proposed on that commit and was projected onto the head `H`: merging it applies only its own changes.``, ending ``merging it would conflict.`` for one projected to conflict, and ``merging it changes nothing, because the head already has its own changes.`` for one whose changes the head already has. For several it counts them: ``…so the 2 suggestion pull requests are proposed on that commit and were projected onto the head `H`: merging 1 applies only its own changes, and merging 1 would conflict.`` (only the parts that apply). Each one projected to conflict is also a `companion-conflicts-at-head` warning. A unit that falls back (§2.5.1) is a `delivery-fallback` warning, stated in the headline under the heading by the code's title, for example ``**Ready to publish with 1 warning:** A proposal is delivered by a later mechanism of its delivery list.`` The Markdown, `problems` and `diagnostics` are the contract; codes are public and catalogued in [Diagnostics](diagnostics.md) ([D45](design-decisions.md#d45-model-diagnostics-once-and-render-them-per-audience--owner-decision)).

### 2.9 Durable identity and the order of writes

The caller's single `statePath` identifies the publication. With suggestion pull requests, the state is several files, each written with the existing durability discipline (a flushed sibling temp file, an exclusive hard link to claim, an atomic rename to complete, a directory flush):

| File | Holds | Written |
| --- | --- | --- |
| `<statePath>` | The **plan**: format `sarif-to-comment.companion-publication-state`, version 1, or version 3 when its suggestions were projected after a rewritten history (§2.5.1), which adds `projection`: `{ "head": H, "mergeBase": M, "suggestions": [{ "verdict": "faithful" \| "conflicts", "conflicts": [paths] }, …] }`, one entry per suggestion, in order. Version 2, written only by unreleased builds that re-applied suggestions, adds `reappliedOnto`; it is still read and continued as it was planned, and never written. Destination, reviewed commit, input fingerprint, author id, mode, head branch, the labels (the canonical label first, then the extra labels, each as GitHub names it), whether the pull requests are created ready for review; the resolved delivery policy with each value's source (`delivery`, [delivery policy §13](delivery-policy-contract.md#13-recording-the-resolved-policy)); the publication id (the marker's `batch`); for each suggestion its id, branch, title, body (with marker), commit message, exact changes and sections (one per unit it holds, §2.11); the review's body sections (literal text, a reference to one proposal of one suggestion, or, first, the companion index with the existing companions as they were read, §2.13.4) and inline comments; preparation's warnings and notes, when there are any (`warnings`, [#42](https://github.com/mike-north/sarif-to-comment/issues/42)); a fingerprint over all of it. | Once, exclusively, before any write. Never changed. |
| `<statePath>.suggestion-<n>-branch` | Intent: the proposal commit. Receipt: the branch verified at that commit. | Claimed exclusively before the branch is created. |
| `<statePath>.suggestion-<n>-pull` | Intent to create the pull request. Receipt: its number and URL. | Claimed exclusively before the pull request is created. |
| `<statePath>.suggestion-<n>-labels` | Intent to label pull request N with the plan's labels. Receipt: every label verified on it. | Claimed exclusively before the labels are added. |
| `<statePath>.review` | The review's own publication record, exactly the existing version-1 format (marker, saved request, receipt or refusal). | By the existing publication core, before the review is sent. |

Order: for each suggestion in turn, proposal commit, branch, pull request, labels (one request adding every label); then the review, whose body lists every suggestion pull request in its companion index and links each from its own section, by number (§2.11, §2.13). Each step's intent is persisted and exclusively claimed **before** its write is sent, and a claimed step is **never sent again** by any invocation, whatever a later lookup shows. The Git objects of §2.6 are the only writes made without a claim, because they are invisible and content-addressed. A step whose claim another invocation holds is only investigated, so concurrent invocations never duplicate a write.

A review that needs no suggestion pull request is recorded as the publication record at the state path: version 3, which is version 1 plus the resolved delivery policy (`delivery`) and, when preparation reported any, its warnings and notes (`warnings`, [#42](https://github.com/mike-north/sarif-to-comment/issues/42)). Records of version 1 (0.2.x) and version 2 (version 1 plus `warnings`) are still read and continued unchanged. Warnings are recorded with the publication, in the same write that claims it, so that every later call reports them (§2.11).

**Definitive refusals.** When GitHub definitively refuses a branch, pull-request or labels write (HTTP 400, 401, 403, 404, 409, 422 or 429), the step's record becomes a terminal refusal with only the status and a bounded message, no later step is sent, and the review is not published (it would link a suggestion that does not exist). Later calls report the recorded refusal without contacting GitHub. Anything already created is left as it is and listed.

### 2.10 Recovery and human changes

A call that meets an existing plan continues it: each completed step is reported from its receipt with no request; each claimed but unsettled step is **investigated**; each unclaimed step is performed. Every investigation is read-only and requires the same authenticated account id as the plan.

| Step | Investigation | Complete when | Otherwise |
| --- | --- | --- | --- |
| Branch | Read `refs/heads/<branch>` | It points at the intended commit | Absent: `not-found`. Elsewhere: `candidate-differs` (a person may have pushed). |
| Pull request | List the repository's pull requests whose head is the proposal branch (`state=all`) | Exactly one carries the exact marker line (version 2 for a suggestion of a version-2 plan), is authored by the plan's account, has the proposal branch as head in this repository and the original's head branch as base | None: `not-found`. Several: `ambiguous`. Wrong author, head or base: `candidate-mismatch`. |
| Labels | Read the pull request's labels | Every planned label is present (compared case-insensitively) | `not-found`, naming the missing labels |
| Review | The existing review investigation | As today | As today |

Any unsettled outcome stops the publication as **uncertain**, naming the step, what is already established, and that a retry with the same state path only rechecks and never sends that step again. Absence is never treated as proof that nothing was created (delayed visibility), and the labels are never needed to locate a pull request.

**The branch changed since planning.** A call that continues a plan in which some suggestion's steps are not all complete, and no step was refused, reads the pull request's head (read-only) again before each suggestion still to be created, and compares it with what was planned. Nothing is re-decided or projected again: the suggestion pull requests still to be created are created on the planned base, as planned. The outcome then says what it found, before the list of suggestion pull requests (or after the detail of an uncertain or refused outcome), from the last read:

- A plan of version 3, projected onto the head H, whose head is now another commit: ``**The head of #7 changed since these suggestions were projected:** they were projected onto commit `H`, and the head is now `H2`, so that projection no longer applies. The suggestion pull requests still to be created are created on the reviewed commit, as planned; nothing is re-decided or projected again.``
- Any other plan whose base (`reappliedOnto` for version 2, otherwise the reviewed commit) is no longer part of the branch: ``**The branch of #7 changed since these suggestions were planned:** they are based on commit `B`, which is no longer part of it (its head is now `H`). The suggestion pull requests still to be created are created on that commit, as planned; nothing is re-decided.``

Both are the note `suggestion-branch-moved`. A failed read is not a reason to stop: the outcome says instead that whether the branch changed is not known, naming the read's failure (`suggestion-branch-unreadable`). A head that is still the projected head, a branch that only moved forward from the base, or a plan with nothing left to create gives no such paragraph, and a completed plan reads nothing. The review body is never changed for it (it is rendered from the plan).

Re-checking the head does not make a retry refuse a projection that no longer applies: that would re-decide what the plan settled, which a retry never does. The paragraph is how the change is reported.

Before a pull request is created, the proposal branch is read once more. If it no longer points at the proposal commit, nothing is created and the outcome is uncertain (`branch-changed`): the branch is never recreated, reset or force-pushed.

Exact outcomes for human changes (D29: none is repaired, restored or reconciled):

| Change by a person | Outcome |
| --- | --- |
| Pushes to, or deletes, a proposal branch before its pull request exists | `branch-changed`; no pull request is created; each retry rechecks without writing. |
| Pushes to a proposal branch after its pull request exists | Not inspected; publication continues. |
| Edits a suggestion pull request's title or body, keeping the marker line | The pull request is still recognized; the edit is kept. |
| Removes the marker line before the pull request step was settled | `not-found`; the pull request is never recreated. |
| Closes, merges or marks ready a suggestion pull request before its labels or the review | The labels are still applied and the review still links it; nothing is reopened or converted. |
| Removes a label | Before the labels step settled: `not-found`, never re-applied. After: not inspected. |
| Edits, submits or deletes the review | As today (the review record). |

### 2.11 Presentation

> **September 30, 2026 note.** This section describes the current implemented behavior. The owner's decisions [D48–D60](design-decisions.md#owner-decisions-of-september-30-2026-delivery-policy-and-the-force-push-boundary) set a different target: [D56](design-decisions.md#d56-make-each-review-an-explicit-index-of-its-companion-proposals--owner-selected-scope-extension) makes each review body an explicit index of its companion proposals, including caller-selected existing companions that a later review reuses. Until October 1, 2026 the body only linked each suggestion pull request it created, one section per delivered unit, and could not reference an existing companion. [D60](design-decisions.md#d60-use-reusable-markdown-components-for-a-rich-github-review-experience--owner-selected-presentation-direction) composes the presentation from reusable Markdown components that library callers can customize, and repository templates must be declarative and unable to execute arbitrary code. The D56 index is implemented, unreleased, October 1, 2026: the review body begins with the companion index, which lists every suggestion pull request the publication creates and every existing one the caller selects (§2.13); the sections below are kept. Repository templates are pending; until then, the behavior below is what the tool does. The texts below are now rendered by presentation components (`src/presentation/`), byte for byte as described, and a library caller may replace the lifecycle note, the findings, the companion index and the section that links each suggestion pull request through `options.presentation` (README, "Customizing how the review reads"; §2.13.3); the change list, the reference sentence of a suggestion pull request's own description and the marker are not customizable.

**Review body.** The body begins with the companion index (§2.13.3). Each suggestion pull request also becomes one body section, at the position of the first finding that carries any of its changes, in SARIF order:

```
**Suggestion pull request:** [#N](https://github.com/OWNER/REPO/pull/N)

Merging it into HEADREF applies this change:            (one change)
Merging it into HEADREF applies these K changes together:   (a group)

- CHANGE
- …

ITEMS
```

`HEADREF` is a code span of the head branch. Changes are listed in SARIF order of first appearance:

- creation: ``New file `PATH`: FACTS``, where FACTS are the file-operation contract's details (for example `18 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644`);
- deletion: `Deleted file [PATH at SHORT](PERMALINK): the whole file is removed`;
- edit: `Edited [PATH line L at SHORT](PERMALINK?plain=1#LL)` or `Edited [PATH lines A-B at SHORT](PERMALINK?plain=1#LA-LB)`, the replaced lines of the reviewed file.

`ITEMS` are the findings carrying those changes, joined by `\n\n---\n\n`, each rendered as today: after `**Location:** line(s) … of the proposed file` for a located finding on a created file, and after its quoted source for a located finding on an edited or deleted file. Proposed content is not repeated in the review (R10): the pull request carries the exact bytes.

**A bundle** ([delivery policy §9](delivery-policy-contract.md#9-companion-bundles)). Under `companionBundle: single`, one suggestion pull request holds every unit delivered by `companion`, each its own section. When it holds one unit, everything below is exactly as for a suggestion pull request of its own. When it holds M ≥ 2 units, each unit keeps its own section of the review body, at its own position, linking the bundle:

```
**Suggestion pull request:** [#N](https://github.com/OWNER/REPO/pull/N), proposal K of M

Merging it into HEADREF applies this change, with the M-1 other proposals it bundles:    (one change)
Merging it into HEADREF applies these J changes together, with the M-1 other proposals it bundles:   (a group)

- CHANGE

ITEMS
```

(`1 other proposal` when M is 2).

**Suggestion pull request.** Title `Suggestion for #PULL: SUMMARY`, where SUMMARY is `create PATH`, `delete PATH` or `edit PATH` for one change and `GROUP (K changes)` for a group; if the title would exceed 256 characters, SUMMARY is `K change(s)`. Body:

```
Suggested in a review of #PULL at commit REVIEWED.

PROJECTION                                                        (only when projected, §2.5.1)

Merging this pull request into HEADREF applies this change:     (or: these K changes together:)

- CHANGE
- …

LIFECYCLE

---

ITEMS

MARKER
```

A bundle of M ≥ 2 units has the title `Suggestion for #PULL: M proposals (J changes)` (or `Suggestion for #PULL: J changes` when that would exceed 256 characters), and the body:

```
Suggested in a review of #PULL at commit REVIEWED.

PROJECTION                                                        (only when projected, §2.5.1)

This pull request bundles M proposals, each in its own section below. Merging it into HEADREF applies all of them; bundling them does not mean they depend on one another.

LIFECYCLE

---

**Proposal 1 of M:** this change:     (or: these J changes together:)

- CHANGE

ITEMS

---

**Proposal 2 of M:** …

MARKER
```

Every unit's changes are committed together in its one commit; changes of different units to one file are combined in line order. Alternatives are never in a bundle.

`LIFECYCLE` is the brief lifecycle note the owner asked for in each body (#27; [convention §8](suggestion-pr-convention.md#8-lifecycle)). For a draft:

```
**How this suggestion is accepted:** it is a draft pull request into HEADREF, the branch of #PULL. A draft cannot be merged: someone with write access first marks it ready for review. The author of #PULL then decides whether to merge it, and #PULL carries the change to its base. Once #PULL is merged or closed, this pull request can be closed.
```

Created ready for review:

```
**How this suggestion is accepted:** it is a pull request into HEADREF, the branch of #PULL. The author of #PULL decides whether to merge it, and #PULL carries the change to its base. Once #PULL is merged or closed, this pull request can be closed.
```

`PROJECTION` is the projection component (`src/presentation/companion-projection.cts`), present exactly when the suggestion was projected after a rewritten history (§2.5.1). It names the reviewed commit again, says why GitHub's displayed diff is not the proposal's, and shows the proposal's own changes, separately from that diff:

````
**The reviewed commit is not part of the branch of #PULL:** the branch was rewritten after commit REVIEWED (its head was H when this was proposed). GitHub shows this pull request's changes from an older merge base, so they also list changes of the reviewed commit itself. Projected onto that head before this pull request was created, merging it applies only its own changes, which are these:

```diff
--- a/PATH
+++ b/PATH
@@ -A,B +C,D @@
 context
-removed
+added
```
````

For a suggestion projected to conflict, the last sentence is ``Projected onto that head before this pull request was created, merging it conflicts in `PATH` and `PATH2`; its own changes are these:``. For a faithful suggestion whose changes the head already has, it is ``Projected onto that head before this pull request was created, merging it changes nothing, because the head already has its own changes, which are these:``. The diff holds each edited file's hunks from the reviewed file to the proposed one, in the order of the change list, with three lines of context, changes closer than six lines sharing a hunk, numbered as Git numbers them (a range of one line has no count); a carriage return ending a line is not shown, and a line without a final newline is followed by `\ No newline at end of file`. Its fence is one backtick longer than the longest run of backticks in it, and at least three. Whole-file creations and deletions are not repeated in it: they are the change list's. When the suggestion edits no file, the sentence ends ``which are listed below.`` (``its own changes are listed below.``) and there is no diff. A bundle has one such section, after its first line. The section is not customizable.

The commit message is the title, a blank line, and `Suggested in a review of OWNER/REPO pull request PULL at commit REVIEWED.` (A version-2 plan's commit message, already recorded, adds `, and re-applied onto commit H after the pull request's history was rewritten`.)

**The review body.** A projected suggestion's section in the review is the same as any other's; the projection is in the suggestion pull request's own description. A unit whose suggestion pull request cannot be made is delivered by the next mechanism its list names (for a whole-file proposal under `[companion, manual]`, the section it has without suggestion pull requests, `**Proposed new file:** …` or `**Proposed file deletion:** …`, at the same position), or the review is blocked. There is no "not created" section. (A version-2 plan's review sections, rendered when its review is published, keep the paragraph they were planned with: `The history of #PULL was rewritten after the reviewed commit, so this change is re-applied onto commit H, the head of #PULL when it was proposed, where everything it changes is still exactly as reviewed.`)

**Outcomes.** A published outcome gains `suggestions: [{ number, url, branch }]`, present only when suggestion pull requests were created; its Markdown lists them after ``Suggestion pull requests (drafts into `HEADREF`, labeled LABELS):`` or ``Suggestion pull requests (ready for review, into `HEADREF`, labeled LABELS):``, where LABELS lists every applied label as code spans joined like `` `a` ``, `` `a` and `b` ``, `` `a`, `b` and `c` ``. Suggestions projected after a rewritten history add ``, proposed on the reviewed commit and projected onto the head `H` `` before the colon, on every call that reports the publication (those of a version-2 plan, ``, re-applied onto commit `H` ``). **A suggestion projected to conflict** is read back once it exists: GitHub's `mergeable`, read with `GET pulls/{n}` up to 4 times, waiting 2, 3 and 5 seconds between reads while GitHub has not computed it, on every call that reports the publication as published. Its entry in `suggestions` gains `mergeable`: `'mergeable'`, `'conflicting'`, or `'unknown'` when GitHub had not computed it after the last read or the read failed; this observation is never a reason to fail. Its line in the Markdown list ends ``: projected to conflict; GitHub reports it as conflicting.``, ``…as mergeable.`` or ``…; GitHub has not reported whether it can be merged.`` The projection and the observation are reported side by side, never one in place of the other. Preparation's warnings and notes, among them every `delivery-fallback` warning and any `companion-options-unused` note, are recorded with the publication when it is planned (§2.9) and are reported identically by every call for its state path in which the review exists or may exist: the call that planned it, and every later call, published or uncertain, whether it creates the review, recovers a lost response, confirms a delivery after `uncertain` or finds the completion recorded ([#42](https://github.com/mike-north/sarif-to-comment/issues/42)). A refused outcome, where the review was not created, does not report them. A state file written before #42 recorded no warnings, and its later calls report none. A published outcome with warnings states them directly under its heading, for example ``**Published with 1 warning:** A proposal is delivered by a later mechanism of its delivery list.``; the warnings are in its `diagnostics` (library, JSON, TOON) and, in the CLI's human form, rendered once on stderr ([Diagnostics](diagnostics.md)). The exit status of a successful publication with warnings stays 0. Uncertain and refused outcomes list what is already established. Everything else is unchanged.

### 2.12 Authoring groups: `group-fixes` and `ungroup-fixes`

Owner decisions of September 29, 2026 ([#29](https://github.com/mike-north/sarif-to-comment/issues/29)). Grouping is an authoring step separate from extraction, performed by a person or an agent, never inferred.

```ts
groupSarifFixes(sarif, { findings: string[], group: string }): GroupSarifFixesOutcome
ungroupSarifFixes(sarif, { findings: string[] }): UngroupSarifFixesOutcome
```

```text
sarif-to-comment group-fixes --sarif FILE --finding SELECTOR [...] --group NAME [--output FILE] [--format human|json]
sarif-to-comment ungroup-fixes --sarif FILE --finding SELECTOR [...] [--output FILE] [--format human|json]
```

- **Immutable.** Both functions capture their input and return a new document sharing no objects with it. The CLI edits `--sarif` in place with the ownership marker, re-read check and atomic rename of `add-comment`, or writes `--output`, which must be a new file (an existing one is refused, exit 1) and leaves `--sarif` unchanged.
- **Selection.** Findings are named by the inspection selectors of the [finding-removal contract](finding-removal-contract.md) §2. Checks, in order: the options (a `TypeError`, CLI usage error, exit 1, for no findings, a selector not of the selector form, the same selector twice, an invalid group name, or an unknown option); the schema (`invalid`); every selector against the document as it is now (`stale`, reporting the first that does not fit: a changed document, or a position with no finding); then the rules (`refused`, listing every problem). `stale`, `invalid` and `refused` exit 2 and change nothing.
- **Extending.** A name already used in the document extends that group: the named findings join it, one finding is enough, and the existing members' changes count toward the two distinct changes. Naming a finding already in that group leaves it as it is. This follows the owner's principle to refuse only when the tool cannot proceed safely; extending changes nothing that joining two groups would, so groups are still never joined.
- **Grouping rules.** Refused: a finding already in another group (a finding belongs to at most one, and groups are never joined); a finding whose `properties.sarifToComment` is not an object; a finding without a change (no fix and no proposed file operation); a group, new or extended, that would hold fewer than two distinct changes; a group one of whose changes a finding outside it also carries (`suggestion-group-change-shared`, §2.3), which publication would always refuse. That refusal names the group, each finding outside it that carries the identical change and the members that carry it, with the outside finding's current selector, to include it in the same call; a finding in another group must first be ungrouped from it, since groups are never joined. A change is a replacement of the primary fix or a proposed file operation, compared as written (identical ones count once); publication checks distinctness again against the reviewed files (§2.3).
- **What grouping writes.** `properties.sarifToComment.suggestionGroup: NAME` on each finding, creating the property bag and namespace when absent; nothing else changes.
- **Ungrouping** removes the key from each finding, and then an owned namespace or property bag left empty, so ungrouping a whole group restores the document as it was. Refused: a finding in no group; leaving a group with fewer than two distinct changes (the refusal names the remaining findings and their current selectors, to include them). That refusal stays because the tool cannot proceed safely there: such a group could never be published (`suggestion-group-single-change`), and silently ungrouping the rest would be inference. Refused for the same reason: ungrouping a finding that carries a change identical to one of a member that stays (`suggestion-group-change-shared`, §2.3); the refusal names the group and those members, with their current selectors, to ungroup them together.
- **Why authoring refuses a shared change** ([#42](https://github.com/mike-north/sarif-to-comment/issues/42)). Two findings may explain one change (for example when `add-staged-changes` gives both the identical fix). Grouping only one of them used to succeed, and publication then always refused the review. Of the two ways to keep authoring and publication consistent, the tool refuses at authoring, naming the finding to include, rather than letting publication treat the identical change as the group's: the latter would put a finding in a group it does not declare, which §2.3 rules out (nothing is inferred), and it follows the rule already applied when ungrouping would leave a single change. Findings that carry the identical change are grouped, or left out, together.
- **Outcomes.** `grouped`: `{ sarif, group, extended, findings: [{ ref, runIndex, resultIndex, tool, changes }], changes }` (`extended` says whether the group already existed; `findings` are those named in the call, in document order; `changes` per finding counts its primary fix's replacements and its proposed operations; the group's `changes` counts the whole group's distinct ones). `ungrouped`: `{ sarif, findings: [{ ref, runIndex, resultIndex, tool, group }] }`. `refused`: `{ problems, markdown }`, the Markdown beginning `**Cannot group the fixes:**` or `**Cannot ungroup the fixes:**`. `stale` is the removal contract's outcome.
- **CLI receipts.** `{ command, status, sarif: { path, written }, [output: { path, written }], ... }` with the library's fields; refusals carry `problems`. Human output says whether findings were grouped or added to an existing group, names each with its change count, what publication does with the group, and that selectors must be taken again.
- **Inspection** shows `suggestionGroup` after the finding's facts (`Finding … — tool · suggestionGroup: NAME`, and the `suggestionGroup` field of the JSON view), when the value is a string; any other value stays visible in the finding's other content.

### 2.13 The companion index and existing companions

October 1, 2026. This section implements [D56](design-decisions.md#d56-make-each-review-an-explicit-index-of-its-companion-proposals--owner-selected-scope-extension) and the [settled force-push boundary](design-decisions.md#settled-force-push-boundary--september-30-2026)'s "each review body explicitly identifies its companion proposals, including caller-selected reused companions", within the publication boundary of [D29](design-decisions.md#d29-publish-the-initial-review-in-one-direction--accepted-scope-constraint) and [D59](design-decisions.md#d59-treat-force-push-review-lifecycle-as-host-behavior-not-a-new-publisher-service--owner-selected-boundary).

**Purpose.** The review body records which companion proposals belong to this particular review: every suggestion pull request this publication creates, and every existing one the caller selects. An upstream reviewer or agent finds a review and follows its index to the proposals it carries; it may then maintain those proposals and publish a later, independent review that selects some of them again. The index is the relationship between a review and its proposals. [D21](design-decisions.md#d21-identify-suggestion-prs-through-backlinks-and-a-label--settled-direction)'s backlinks and label relate a suggestion to its original pull request, for cleanup; they do not say which review a suggestion belongs to.

**The publisher never selects.** Only the caller's `existingCompanions` adds an existing suggestion pull request to a review. Earlier reviews, the original's backlinks, labels, branches and creation times are never read to infer or carry forward a proposal. A pull request the caller names is referenced, never created again, changed, reopened or closed.

#### 2.13.1 The option

| Library (`options`) | CLI | Meaning |
| --- | --- | --- |
| `existingCompanions?: number[]` | `--existing-companion N`, repeatable | Existing suggestion pull requests of this pull request that the review lists in its companion index, in the order given. |

- Each entry is a pull request number: a positive safe integer, each at most once. The library refuses anything else with a `TypeError` naming the entry (``options.existingCompanions[1] repeats #97``); the CLI takes one number per flag (`--existing-companion 97 --existing-companion 98`) and refuses a value that is not a positive number, or a number given twice, as a usage error (exit 1). `[]` is the same as omitting it.
- The name says what the value is: a suggestion pull request that already exists. It is not a delivery mechanism and requests nothing: `companion` in a delivery list creates a suggestion pull request; `existingCompanions` names one that is already there. The option is valid with any delivery policy, including one that creates no suggestion pull request.
- `validateSarifReview` and `validate` take it too, because they take publication's options, and check it the same way (§2.13.2).
- **Identity.** When it names at least one pull request, the input fingerprint's identity document (§2.2) gains `existingCompanions: [N, …]`, in the order given. Otherwise it has no such member. Retrying a state path with another selection is refused as a `state-mismatch` before any request.

#### 2.13.2 Which pull requests can be listed

During the shared preflight (§2.8), after the reviewed commit's association check and before preparation, each named pull request is read once, in the order given (`GET pulls/{n}`). These reads are the only ones it makes, and they write nothing. A named pull request can be listed when, as read:

1. GitHub answers it as a pull request of this repository. A 404 means it is not one, for example an issue number or a number that does not exist.
2. Its head branch is in this repository: not a fork, and not a deleted repository ([convention §9](suggestion-pr-convention.md#9-conformance-and-acting-on-suggestion-pull-requests)).
3. Its body has exactly one recognized suggestion marker ([convention §7](suggestion-pr-convention.md#7-the-marker)), of any version the convention defines (1 or 2).
4. The marker's `original` names this repository and this pull request.
5. Its head branch is the marker's suggestion branch, `suggestion-pr/<pull>/<id>` ([convention §5](suggestion-pr-convention.md#5-the-branch)).

Nothing else is required. It need not be open, carry the canonical label, target the original's current head branch, or have been created by this tool or this account: the convention, not the producer, makes it a suggestion pull request of this original. The convention's last conformance condition, that no other open pull request claims the same suggestion id, is not checked: it lets a consumer that discovers suggestions tell them apart, and the caller names this one by its number.

A pull request that fails a condition blocks the review before anything is written, with one `companion-not-reusable` error per such pull request, in the order given, whose subject is `OWNER/REPO#N` and whose message is `#N cannot be listed as an existing companion of #PULL: REASON.`, with the first failing condition's reason:

| Condition | REASON |
| --- | --- |
| 1 | ``it is not a pull request in OWNER/REPO`` |
| 2 | ``its head branch `REF` is in another repository (FORK)`` or ``its head repository was deleted`` |
| 3 | ``it has no suggestion marker``, ``its body has more than one suggestion marker`` or ``its suggestion marker is not in the canonical form`` |
| 4 | ``its suggestion marker names another repository (OWNER2/REPO2)`` or ``its suggestion marker names #M, not #PULL`` |
| 5 | ``its head branch `REF` is not the suggestion branch `suggestion-pr/PULL/ID` its marker names`` |

These errors are reported together with every problem preparation found, after them, so `validate` and `publish` list everything at once; a blocked publication exits 2 and writes no state. Like the repository checks of §2.8, a review blocked by them carries no `delivery-fallback` warning or `companion-options-unused` note. Any other failed read (HTTP 403 or 5xx, the network, an answer that is not a valid pull request) is operational: `publish` rejects and `validate` answers `incomplete`, and nothing is written. The URL GitHub answers with is not used; links are built from the number (§2.13.3).

**State is reported, not enforced.** Each listed pull request's state is recorded as it was read: `open`, `draft` (open and a draft), `closed` (without merging) or `merged`. A closed or merged one is still listed: whether a proposal still matters is the caller's judgment (D56, D59). Each one gives one `companion-reused` note: ``#N is listed in the review's companion index as an existing companion; it was STATE when the review was prepared.``, where STATE is `open`, `a draft`, `closed` or `merged`. The notes come after preparation's warnings and notes and are recorded with the publication, so every call for its state path reports them.

#### 2.13.3 The index

The **companion-index** component (`src/presentation/companion-index.cts`) is the review body's list of its companion pull requests:

```
"**Companion pull requests of this review:**\n\n" ENTRY { "\n" ENTRY }
ENTRY  = "- [#" N "](" URL "): " TITLE " — " ORIGIN
ORIGIN = "created with this review"
       | "reused; it was " STATE " when this review was prepared"
```

- `URL` is `https://github.com/OWNER/REPO/pull/N`, from the shared link builder (`src/github-urls.cts`), never GitHub's answer. `TITLE` is a code span of the pull request's title: the title planned for a created one (§2.11), and the title GitHub reported for an existing one. In a code span nothing is Markdown, a mention or a link, GFM autolink literals (`https://…`, `www.…`, an email address) included, so a title can add no link and cannot read as an entry's origin. Line breaks become spaces. Every character a reader could not see, a format character (Unicode category Cf, which includes the bidirectional controls that reorder text inside a code span too) or U+00A0, is written as a visible escape `{U+XXXX}`; nothing is dropped. A zero-width joiner (U+200D) between two pictographs, after an optional variation selector U+FE0F, is kept, so emoji sequences still read as themselves. `STATE` is `open`, `a draft`, `closed` or `merged` (§2.13.2).
- **Order:** the suggestion pull requests this publication creates, in the order they are created (the order of their first findings, §2.11), then the existing ones, in the order given. A pull request appears once.
- **Position:** the index is the body's first section, before every finding, joined to the next by `\n\n---\n\n` like any section. It is present exactly when the review has at least one created or existing companion; a review with neither is unchanged. The prepared summary's count of general sections does not count it.

For example, a review that creates #101 and lists the existing #97:

```
**Companion pull requests of this review:**

- [#101](https://github.com/octo/widgets/pull/101): `Suggestion for #7: retry-with-test (2 changes)` — created with this review
- [#97](https://github.com/octo/widgets/pull/97): `Suggestion for #7: edit README.md` — reused; it was a draft when this review was prepared
```

**The index and the sections of §2.11.** Each created suggestion pull request keeps its own section, at the position of its first finding, with its changes and the findings that carry them. The index does not replace those sections, and they are not folded into it: the sections are the review's feedback, in document order (R1), and the index is the list D56 asks for, which an agent reads without parsing feedback. A created suggestion pull request is therefore linked twice: in the index and in its own section. An existing one appears only in the index, because this review delivers none of its changes and presents none of its findings.

**Customizable (D60).** A library caller may replace the index with `options.presentation.companionIndex`, and each companion's section of §2.11 with `options.presentation.companionReference` ([review presentation contract §7](review-presentation-contract.md#7-customization)). The index callback receives every companion in the order above, each with its `number`, `url`, raw `title`, `origin` (`created` or `reused`), `state` (reused only) and `link`, `[#N](URL)`; the section callback receives its companion, which proposal of how many it is, the change list and the findings. Every companion's `link` is a required fragment, shown as itself at its own place, so a result keeps every entry, and the link text carries its number. A section's change list and findings are required too. The links are identity links: no link of the result whose text reads `#N` (compared after NFKC and whitespace normalization, so a fullwidth `＃` or digit reads as itself; a visibly different look-alike such as the letter O for zero is a documented limit) may lead elsewhere, and a result may add no link at all, an autolink literal included, and no image, beyond those the built-in Markdown has. Marker-like text in a title is not refused while it stays in code, as the built-in index shows it; the same text outside code is. **The contract guarantees membership and links: every companion is listed, and each number leads to its own pull request. The order of the entries and their created or reused wording belong to the callback.** A title the callback shows itself brings no exemption: a link or invisible character it carries is refused as the callback's. Every other check of the review presentation contract applies. A refused result is the presentation `TypeError`. When those checks run is §2.13.4's.

#### 2.13.4 Identity, recovery and completion

- **A review that creates no suggestion pull request** (only existing companions) is published as any other: its body, index included, is rendered during preparation, checked by the limits and the composed-text checkpoint, and saved in the publication record's request before it is sent ([§2.9](#29-durable-identity-and-the-order-of-writes)). Recovery after a lost response matches that saved request, so the body is identical.
- **A review that creates suggestion pull requests** records the index in its plan as the first of the review's sections (§2.9): `{ "companionIndex": { "existing": [{ "number": N, "title": "…", "state": "open" | "draft" | "closed" | "merged" }, …] } }`, the existing companions as they were read. When the review is first sent, the index is rendered from the plan: each created one from its planned title and its pull request's number in the pull request step's receipt, each existing one from that record. The rendered body is saved in the review's own record before it is sent, so a recovered review has the identical body, and the existing companions are never read again. During preparation, the index and the sections are rendered with placeholder numbers, the largest pull request number and those just below it (one per created companion, each as long as any real number), for the limits and the checkpoint.
- **A retry never re-validates or re-decides.** It reads no existing companion again, whatever happened to it since, and does not ask whether a created one still exists.
- **When the companion callbacks run, and what a refusal costs.**
  - *During preparation*, by `validate` and `publish` alike, before anything is written: once per element, with the real numbers of existing companions and the placeholder numbers of those to be created. Every check runs on the result and on the composed body, so a callback that drops an entry, swaps or re-points a link, adds a link, raw HTML, a definition or an invisible character, or leaves something open is refused before any write.
  - *When a publication composes its review*, after its suggestion pull requests exist and only if no earlier call recorded the review's body: once more, with the real numbers and this call's callbacks, with the same checks, including the size limits (the review body's 60,000 characters and the complete review's 1,000,000 bytes), and the composed-text checkpoint. A review that creates no suggestion pull request has nothing to compose then: its body is the one prepared.
  - A callback that is accepted with the placeholder numbers but refused with the real ones is therefore refused **after its suggestion pull requests were created and before the review is recorded or sent**. The publication rejects with the presentation `TypeError`; nothing is sent for the review, the plan and every step record stay, and a retry with the same state path continues it, composing the review with that call's callbacks. The suggestion pull requests are not undone. Callbacks must be deterministic; this case is the cost of one that is not, or that depends on the number.
  - A call that resumes a publication before its review step was sent (for example after an uncertain pull request step) composes the review with its own callbacks, which need not be the first call's: callbacks are not part of the identity.
  - Once the review's request is recorded, no call composes it again: recovery after a lost response and every later retry reuse the recorded body byte for byte, and call no callback.
  - A version-2 plan's re-applied sections are always rendered as planned, built in; its index, if it has one, takes the callback.
- **A plan written before the index existed** has no index section and is continued as it was planned, without one.
- **Completion.** D56 makes the index part of complete delivery. A publication is `published` only once its review, carrying the index, exists. Until then it is `uncertain` or `rejected` and lists the suggestion pull requests already created (§2.9, §2.10); a suggestion pull request that exists without its review is not a complete delivery.

## 3. Worked example

Pull request `octo/widgets#7`, head branch `feature/retry`, base `main` (the default branch), reviewed at its head `2222222…`. The repository has no `.github/suggestion-prs.json`, so the canonical label is `suggestion-pr`. One run bound to that commit holds:

1. "Retry once on timeout." with a fix replacing line 3 of `src/client.ts`;
2. "Cover the retry." creating `test/client.test.ts`;
3. "Typo." with a native-suggestion-eligible fix on line 1 of `README.md`.

An agent inspects the document and runs `group-fixes --finding <selector of 1> --finding <selector of 2> --group retry-with-test`, which gives results 1 and 2 `suggestionGroup: "retry-with-test"`; result 3 stays in no group.

Under the defaults: the group has a whole-file creation, so it follows `fileOperations`, whose default `[manual]` delivers it as the mixed manual group: one review-body section listing `` `src/client.ts` line 3 `` and `` `test/client.test.ts`: new file ``, then the edit's replacement and the creation's section, each with its finding, to make by hand and commit once; result 3 is a native suggestion. With `--file-operations companion --pr-labels team-a`, the labels `suggestion-pr` and `team-a` present and push permission: one draft pull request from `suggestion-pr/7/<id>` into `feature/retry`, titled `Suggestion for #7: retry-with-test (2 changes)`, whose single commit edits line 3 of `src/client.ts` and adds `test/client.test.ts`, labeled `suggestion-pr` and `team-a`, with the draft lifecycle note; then one draft review whose inline comment on `README.md` carries the native suggestion and whose body section links the pull request, lists both changes and presents both findings. With `--mark-suggestion-prs-ready` as well, the pull request is created ready for review and its body carries the ready lifecycle note. If `team-a` did not exist, the review would be blocked before any write, and `validate` would say the same.

## 4. Decisions awaiting acceptance

> **September 30, 2026 note.** This section records decisions about the current implemented behavior. The owner's decisions [D48–D60](design-decisions.md#owner-decisions-of-september-30-2026-delivery-policy-and-the-force-push-boundary) change the target for several of them. Re-application, in the #28 bullet and items 7 and 8, is not authorized by [D58](design-decisions.md#d58-do-not-abort-historical-review-publication-merely-because-the-pr-branch-changes--owner-selected-force-push-direction) and [D59](design-decisions.md#d59-treat-force-push-review-lifecycle-as-host-behavior-not-a-new-publisher-service--owner-selected-boundary), and was removed on October 1, 2026, before it was ever released: every proposal stays on the reviewed commit, and its fidelity is projected (§2.5.1). The #37 bullet's substitution of the review body is narrowed by [D55](design-decisions.md#d55-report-unavailable-explicit-delivery-requests-without-silently-substituting--owner-selected-direction). The #29 bullet's refusal of grouped documents without suggestion pull requests is superseded as target by [D49](design-decisions.md#d49-keep-each-supplied-group-available-for-collective-application-in-one-pr--owner-selected-direction-host-verification-open). The #27 bullet's native suggestions first is superseded as target by [D48](design-decisions.md#d48-make-publication-policy-caller-controlled--accepted-product-direction-implementation-design-open). Accepting or rewording these items should follow the new direction. The delivery policy, which replaces the opt-in setting, the native-first rule, the group refusals and the #37 substitution, is implemented ([delivery policy](delivery-policy-contract.md)), and the fidelity projection replaces re-application (§2.5.1).

Decided by the owner, and no longer awaiting acceptance:

- **Off by default, explicit opt-in** (§2.1): [#5](https://github.com/mike-north/sarif-to-comment/issues/5). The earlier provisional D22 default ("enabled when omitted") is superseded.
- **The convention, options, labels and lifecycle** ([#27](https://github.com/mike-north/sarif-to-comment/issues/27)): the tool-neutral [convention](suggestion-pr-convention.md) (label `suggestion-pr`, the optional default-branch configuration file, branch `suggestion-pr/<pull>/<id>`, the marker with `batch`, neutral title and body with no closing keywords); the option names `allowSuggestionPullRequests` / `--allow-suggestion-prs`, `pullRequestLabels` / `--pr-labels`, `markSuggestionPullRequestsReady` / `--mark-suggestion-prs-ready`, and the removal of the per-call label; all of them in the publication identity; every label must already exist, the tool never creates one, and a missing label blocks before any write; drafts by default; branches created once and never updated, force-pushed or deleted; native suggestions first; same repository with a default-branch base, with forks and other bases not yet supported; and the limits and mechanics as merged (at most 10 suggestion pull requests per review, bodies of at most 60,000 characters, created files of at most 1 MB, per-step state persisted before each attempt, recovery by unique branch plus exact marker, a refused step stops publication, a retry never overwrites human pushes).
- **Groups** ([#29](https://github.com/mike-north/sarif-to-comment/issues/29)): extraction stays deterministic (every separable staged hunk is its own fix); grouping is a separate authoring step (§2.12); a fix with several changes is already a group and becomes one suggestion pull request with no property; the per-result `suggestionGroup` property, renamed from the unreleased `acceptanceGroup`, joins what SARIF cannot; at least two distinct changes; a finding in at most one group, and groups never joined, while a name already in use extends its group (refuse only when the tool cannot proceed safely); only the primary fix is a member; a member without a change is refused; nothing is inferred; `inspect` shows each finding's group; disallowed suggestion pull requests refuse a grouped document naming the setting (§2.3, §2.4).
- **A branch that moved forward after the review is not a reason to refuse** (#27), and **a rewritten history is handled by testing ancestry** ([#28](https://github.com/mike-north/sarif-to-comment/issues/28)): an advanced branch proceeds on the reviewed commit; after a rewrite, each suggestion is re-applied onto the head only when everything it changes is byte-identical there; ordinary feedback publishes as before (§2.5, §2.5.1). The re-application this records is superseded and removed (see the note above).
- **A suggestion whose pull request cannot be made is handled as if suggestion pull requests were not allowed** ([#37](https://github.com/mike-north/sarif-to-comment/issues/37)), whether it cannot be re-applied after a rewritten history, the pull request is a fork or into another base, or it is over the file or body limit: a whole-file creation or deletion falls back to the review-body proposal with a `suggestion-pr-fallback` warning; a group or several-change fix refuses the whole review before any write; every warning is stated in a headline and as structured diagnostics (§2.5.1, §2.8, §2.11). This replaces #28's skip, which published the change as text in the review body.

Still awaiting the owner:

1. **Head-branch target and reviewed-commit parent** (§2.5), and not chasing a head that moves after validation. Alternative: basing on the current head (would propose against unreviewed code).
2. **Presentation details** (§2.11): the exact lifecycle note and the review-body section. The owner asked for a brief lifecycle note in each body; its wording is this contract's.
3. **Refusal wording** for the unsupported cases (§2.5), in particular why an original into a non-default base is not yet supported (the stacked-pull-request retargeting path is unbuilt and unverified).
4. **Details of the options** (§2.2): the CLI trims spaces around `--pr-labels` names; extra labels are deduplicated keeping the first spelling; the identity document's shape.
5. **Details of the configuration read** (§2.7): through Git objects, with a symbolic link, directory or submodule, and a file over 1,000,000 bytes, treated as invalid; unknown members ignored ([convention open questions](suggestion-pr-convention.md#10-open-questions)).
6. **One request for all labels**, and one labels step and state file per suggestion (§2.9).
7. **Details of the fidelity projection** (§2.5.1, §2.11), replacing those of re-application: its verdict table and limits, the obstacle and warning wording, the projection component of the description, the plan's version 3 with `projection`, and the bounded read of `mergeable`.
8. **A branch rewritten again after planning** (§2.10): a retry re-reads the head before each suggestion still to be created, keeps the plan (they are still created on the reviewed commit), and only reports that the projection or the base no longer applies. Alternatives: stop the remaining steps, or project them again and refuse those no longer faithful, which would break the rule that a retry never re-decides.
9. **Details of the companion index** (§2.13), engineering choices made to implement D56: the index is the body's first section and keeps each created suggestion pull request's own section rather than absorbing it; the option is named `existingCompanions` / `--existing-companion N` (repeatable) rather than `--companion N`, because `companion` already names the delivery mechanism that creates one; an existing companion is checked against the convention's conformance except uniqueness of its id among open pull requests; its state is a `companion-reused` note and is shown in the index as of preparation; titles are code spans with visible escapes; and the index and each companion's section are customizable, their callbacks checked with placeholder numbers before any write and run again with the real numbers when the review is composed (§2.13.4). Alternatives: the index last, or folding each section into the index; checking uniqueness too (one more read per pull request); refusing closed or merged ones (D56 leaves that judgment to the caller).

## 5. What cleanup (#6) can rely on

- Every suggestion pull request this tool creates, whatever the delivery policy that planned it and including a bundle, follows the [convention](suggestion-pr-convention.md): it carries the canonical label and any extra labels (once its labels step completes) and exactly one marker line of §2.7 (version 1; version 2 only from a version-2 plan, §2.9), whose `original` names the original pull request in the same repository. Suggestion-first enumeration can list open pull requests with the canonical label and parse the marker; targeted discovery can start from the original's cross-reference backlinks, which the body's ordinary reference creates.
- The marker, not the title, is the relationship. A labeled pull request without a recognized marker is not a suggestion pull request.
- The labels may be missing when a publication stopped before its labels step, or when a person removed them; such a suggestion is still reached from the original's backlinks and its marker.
- Proposal branches are named `suggestion-pr/<pull>/<id>` and are never changed by the tool after creation. Every one's commit is based on the reviewed commit, except a version-2 plan's, which is based on its marker's `reappliedOnto`.
- The canonical label is resolved the same way for cleanup as for publication (§2.7).
