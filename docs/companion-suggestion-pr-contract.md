# Companion suggestion pull requests: contract

Partly owner-accepted · September 29, 2026. Publication of whole-file operations and explicitly grouped edits as companion suggestion pull requests is implemented under the options below. Suggestion pull requests follow the tool-neutral [suggestion pull request convention](suggestion-pr-convention.md). The default-off setting (§2.1) is the owner's decision on [issue #5](https://github.com/mike-north/sarif-to-comment/issues/5) (recorded in D22 and R16); the options, the convention, labels, draft and ready pull requests, the supported scope and the limits are the owner's decisions on [issue #27](https://github.com/mike-north/sarif-to-comment/issues/27); proposing on a branch that has moved since the review, including after a force-push (§2.5.1), is the owner's decision on [issue #28](https://github.com/mike-north/sarif-to-comment/issues/28). Groups, including a fix with several changes and the `group-fixes` authoring step (§2.3, §2.12), are the owner's decisions on [issue #29](https://github.com/mike-north/sarif-to-comment/issues/29). The decision log records these owner decisions as [D22](design-decisions.md#d22-gate-suggestion-prs-with-one-caller-setting--settled-direction), [D41](design-decisions.md#d41-the-suggestion-pull-request-convention-and-options--owner-decisions), [D42](design-decisions.md#d42-test-ancestry-when-the-originals-branch-has-moved--owner-decision) and [D43](design-decisions.md#d43-group-independent-fixes-by-an-explicit-authoring-step--owner-decisions). The decisions still listed in [Decisions awaiting acceptance](#4-decisions-awaiting-acceptance) are provisional until the owner accepts or replaces them.

**Sources.** [Issue #5](https://github.com/mike-north/sarif-to-comment/issues/5); [issue #27](https://github.com/mike-north/sarif-to-comment/issues/27) and the [suggestion pull request convention](suggestion-pr-convention.md); [issue #28](https://github.com/mike-north/sarif-to-comment/issues/28) and the [force-push experiment](force-push-experiment.md); [specification](specification.md) R16 and open contract O11, with R1, R3, R8, R10, R12, R13 and R14; [decisions](design-decisions.md) D7, D12, D14, D21–D29; the [file-operation publication contract](file-operation-publication-contract.md), which remains the form used when suggestion pull requests are not enabled; the [grouped-suggestion](grouped-suggestion-experiment.md), [lifecycle](companion-pr-lifecycle-experiment.md) and [recovery](publication-recovery-experiment.md) experiments; [status](status.md). Cleanup of suggestion pull requests after their original pull request ends ([issue #6](https://github.com/mike-north/sarif-to-comment/issues/6)) is specified separately, in the [suggestion cleanup contract](suggestion-cleanup-contract.md); §5 states what it relies on.

## 1. What is fixed by the sources

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

### 2.1 The setting, and why it is off by default

**Owner decision (September 29, 2026): suggestion pull requests are explicit opt-in and disabled unless the caller enables them** (`options.allowSuggestionPullRequests: true`, CLI `--allow-suggestion-prs`; the names are the owner's decision on #27). The owner recorded it on [issue #5](https://github.com/mike-north/sarif-to-comment/issues/5); [D22](design-decisions.md#d22-gate-suggestion-prs-with-one-caller-setting--settled-direction) and [R16](specification.md#r16-select-publication-forms-using-the-suggestion-pr-setting) now state it. The evaluation below is the evidence it rests on.

D22 earlier recorded "enabled when omitted" as a *low-conviction* default, to be validated against "PR clutter and repository automation triggered by PR creation". Issue #5 asks for that evaluation. It found the costs of an enabled default concrete and the benefit small:

| Consideration | Enabled by default | Disabled by default (adopted) |
| --- | --- | --- |
| Behavior of existing callers | Changes silently on upgrade: a document with a file operation, which today publishes one review, would start creating branches and pull requests, and would need new permissions (branch push, labels). | Unchanged byte for byte: the same requests, the same review body, the same state file. |
| Repository clutter | One extra pull request and branch per standalone file operation and per group, visible to every repository reader, persisting until someone closes them (cleanup is a separate, on-demand action, [#6](https://github.com/mike-north/sarif-to-comment/issues/6)). | Only callers who asked for pull requests get them. |
| Triggered automation | Every created pull request can start CI workflows (`pull_request` events run for draft pull requests unless a workflow opts out), notify watchers and code owners, trigger bots, and count against required-check and runner budgets. None of this is visible to the reviewer publishing SARIF, and the lifecycle experiments confirmed that the repository's own required checks ran on suggestion pull requests. | The caller opts into those costs knowingly. |
| Failure surface | New failure modes for everyone: missing push permission, a missing label, fork pull requests, a moved head. Each would block reviews that publish today. | Those checks apply only when requested. |
| What is lost | Grouped edits and pull-request-based file operations work without a flag. | Grouped edits need one explicit setting; without it they are refused with the setting named (never split). Creations and deletions still publish, in the review body. |

The asymmetry decides it: an enabled default imposes surprise costs on every repository to save one flag for the callers who want the feature, and turning it off after the fact does not remove pull requests already created. The explicit disable choice D22 requires remains available (`allowSuggestionPullRequests: false` behaves exactly like omission). Nothing else in this contract depends on the omitted-option value.

### 2.2 Options

Owner decisions of September 29, 2026 ([#27](https://github.com/mike-north/sarif-to-comment/issues/27)). A flag's name says what kind of value it takes: a switch reads as a switch, a list as a list.

| Library (`options`) | CLI | Meaning |
| --- | --- | --- |
| `allowSuggestionPullRequests?: boolean` | `--allow-suggestion-prs` | Explicit opt-in. Omitted or `false`: disabled (§2.1). |
| `pullRequestLabels?: string[]` | `--pr-labels a,b,c` | Extra labels every suggestion pull request carries **in addition to** the canonical label (§2.7), for example a team or campaign tag. |
| `markSuggestionPullRequestsReady?: boolean` | `--mark-suggestion-prs-ready` | Create suggestion pull requests ready for review instead of as drafts. Drafts are the default. |

- `pullRequestLabels` and `markSuggestionPullRequestsReady` require `allowSuggestionPullRequests: true`: given without it (with any value), they are a `TypeError` (CLI: a usage error), so a setting is never silently ignored.
- Each extra label is a label name under the [convention](suggestion-pr-convention.md#3-the-canonical-label): 1–50 characters, no control or invisible formatting characters, no surrounding whitespace, **no comma**. The library refuses anything else with a `TypeError`. The CLI splits `--pr-labels` at commas and trims the spaces around each name, so `--pr-labels "docs, team-a"` names `docs` and `team-a`; an empty name (`a,,b`, a trailing comma, an empty value) is a usage error. A name cannot contain a comma in either form.
- Extra labels are deduplicated case-insensitively, keeping the first spelling given: first among themselves, then against the canonical label, which always comes first. Listing the canonical label is therefore harmless. `pullRequestLabels: []` is the same as omitting it.
- **Removed:** `suggestionLabel` / `--suggestion-label`. There is no per-call override of the canonical label: the label is a repository-wide convention (§2.7), and cleanup depends on it. The earlier names `suggestionPullRequests` / `--suggestion-prs` are replaced by the names above. None of them was released, so no compatibility shim exists: the old option names are refused as unknown options, and the old flags as unknown options (exit 1).

`validateSarifReview` and `validate` accept the same options, because they take publication's options.

**Publication identity.** All of these settings are part of the publication's input identity: when enabled, the input fingerprint's identity document gains

```text
suggestionPullRequests: { markReady: <boolean>, pullRequestLabels: [<extra labels, deduplicated among themselves, in the order given>] }
```

When disabled, the identity document is exactly what it was, so default-off fingerprints, requests and state files are unchanged. Retrying a state path with any different setting is refused as a `state-mismatch` ("belongs to a different original input") before any request. The canonical label is not a caller setting: it is resolved from the repository once, when the publication is planned, and recorded in the plan (§2.9), so a later change to the repository configuration never changes a publication already planned.

### 2.3 Groups: a fix with several changes, and explicit groups

SARIF groups changes natively only within one fix: a single `fix` with several `artifactChanges` or `replacements` means "apply together". It cannot join fixes of different findings, or an edit with a whole-file creation or deletion. The owner's model ([#29](https://github.com/mike-north/sarif-to-comment/issues/29), September 29, 2026) keeps both:

**A fix with several changes is a group of its own**, with no extra property.

- Its replacements are located in the unmodified file and applied as if in array order, the reading staged extraction already uses; their combined effect is therefore defined only when they are disjoint and no two start at the same position, and otherwise the review is blocked (`fix-replacements-overlap`). Several artifact changes naming one file are that file's replacements.
- Replacements whose lines overlap become one change of the union of their lines; changes of one file are combined in line order. The change count is the number of such changes.
- With suggestion pull requests disabled, the finding is refused (`fix-changes-require-suggestion-prs`), naming the setting; the fix is never split into separate suggestions (A30). This refusal is the known limitation that [#30](https://github.com/mike-north/sarif-to-comment/issues/30) allowed to be recorded for such a fix without suggestion pull requests ([D44](design-decisions.md#d44-publish-the-first-fix-and-list-the-others-as-alternatives--owner-decision)).

**An explicit group** is declared by a per-result owned property:

```json
"properties": { "sarifToComment": { "suggestionGroup": "retry-with-test" } }
```

- It is written by `group-fixes` / `groupSarifFixes` (§2.12), not by hand. Results whose `suggestionGroup` values are equal form one group, across every run of the log. The value is an identifier the caller chooses; it is shown only in the suggestion pull request's title. It must be 1–100 characters with no control or invisible formatting characters and no leading or trailing whitespace (`suggestion-group-invalid`). The property is input-side only; GitHub never sees it.
- A member's change is its **primary (first) fix**, with every change that fix makes, or its `proposedFileChanges` creation or deletion. Further fixes are alternatives: they are listed with the finding, never grouped, committed or unioned ([#30](https://github.com/mike-north/sarif-to-comment/issues/30)). A member with no change is refused (`suggestion-group-member-without-change`): a group joins changes, and feedback without a change has nothing to join.
- Members that carry the identical change (same path, range and replacement text; or the same whole-file operation) share it, as identical suggestions and identical proposals already do (R8). A group must hold at least two distinct changes (`suggestion-group-single-change`); a single change is published on its own.
- Nothing is inferred. Results without the property are never added to a group, and two groups are never joined, even when they touch the same file.
- With suggestion pull requests disabled, every group is refused with `suggestion-group-requires-suggestion-prs` at its first member, naming the setting. The whole review is blocked; nothing is split or published (A30, A32).

The property was called `acceptanceGroup` until #29; that name was never released, so it is now an unknown owned key and blocks the review as `owned-property-invalid`. Documents without the key behave exactly as before.

### 2.4 Presentation-form selection

| Proposal | Disabled (default) | Enabled |
| --- | --- | --- |
| Edit eligible for a native suggestion, not in a group | Native suggestion (unchanged) | Native suggestion (unchanged) |
| Standalone whole-file creation or deletion | Review-body section ([file-operation contract](file-operation-publication-contract.md)) | One suggestion pull request per distinct operation; findings carrying the identical operation share it |
| A fix with several changes, not in a group | Blocked: `fix-changes-require-suggestion-prs` | One suggestion pull request per distinct fix; findings carrying the identical fix share it |
| Explicit group | Blocked: `suggestion-group-requires-suggestion-prs` | One suggestion pull request containing every change of the group |
| Edit that no native suggestion can represent, not in a group | Blocked as today (for example `suggestion-not-inline`) | Blocked as today; a single edit uses a pull request only as part of an explicit group |

A group edit, and every change of a fix with several changes, is applied to the reviewed file exactly as a native suggestion's replacement would be (the replacement module's exact edit), but it does not need native-suggestion eligibility: it is committed, not rendered. The existing association rule still applies: a located member's own lines must lie within its replacement's lines (one of them, for a fix with several changes; `fix-association-unsupported`), so feedback is never moved.

**Conflicts.** Each presentation unit (one inline comment, one suggestion pull request, one body section) must be acceptable independently of the others. The whole review is blocked when two units propose different changes to the same lines (`overlapping-replacements`), or when a path is created or deleted in one unit and changed in any way by another (`file-operation-conflict`). Within one group, non-overlapping edits of one file are combined in line order; overlapping different edits are refused.

### 2.5 Repository, target branch and revision

- **Supported scope** (owner decision, #27): original pull requests whose head branch is in the repository itself and whose base is the repository's **default branch**. Other bases and forks are **not yet supported**. The refusal names the capability that is missing, not a policy:
  - a fork (`suggestion-pr-fork-unsupported`): the suggestion would have to be opened in the fork, as a pull request into the fork's branch, and this tool creates branches and pull requests only in the original's repository. A possible later route is a pull request from the reviewer's fork into the original fork's branch. A head repository that was deleted leaves no branch to propose into.
  - another base (`suggestion-pr-base-unsupported`): following a suggestion through an original that merges into a branch other than the default branch (for example one pull request of a stack, which GitHub retargets when the branch below it merges) has not been built or verified yet.
- **Target.** Each suggestion pull request's base is the original pull request's head branch (`head.ref`), read from the pull request during validation. Because the original's base is the default branch, its head branch never is.
- **Base commit.** Each proposal branch is one commit whose parent is the **reviewed commit**. The proposed changes are therefore exactly the pull request's diff from the reviewed state, never a rebase or a merge.
- **A head that moved on since the review** (owner decision, [#28](https://github.com/mike-north/sarif-to-comment/issues/28); [convention §5.1](suggestion-pr-convention.md#51-when-the-originals-branch-has-moved-since-the-review)). The tool tests ancestry, not equality. When the pull request's head is not the reviewed commit, validation compares them (`GET compare/{reviewed}...{head}`):
  - `ahead`: the reviewed commit is an ancestor of the head, so the branch only moved forward. Publication proceeds exactly as for the head: each proposal branch's parent is the reviewed commit, and GitHub shows any conflict with the later commits.
  - `behind` or `diverged`: the history was rewritten (a force-push, amend or rebase). Each suggestion pull request is re-applied onto the head or not created, as §2.5.1 states.

  The comparison is read only when the document has suggestion units (it needs at least one suggestion pull request before re-application is decided), the head moved, and the pull request is one suggestion pull requests support (same repository, default-branch base); it is read at most once, during preparation, because what is created depends on it. A review that creates no suggestion pull request never reads it, so its failure can never refuse one. When it is read, a failed read is operational (`publish` rejects, `validate` answers `incomplete`) and nothing is written.
- **A head that moves later** (after validation, or after a re-application) is not chased. The branch keeps the reviewed commit as its parent, the pull request still targets the head branch, and nothing is retargeted, rebased or re-validated on retry. GitHub shows the suggestion's own changes; whether they still merge cleanly is for the person accepting them.
- **Draft or ready.** Suggestion pull requests are created as drafts, in both review modes, unless `markSuggestionPullRequestsReady` asks for them ready for review (owner decision, #27). A draft avoids automatic review requests to code owners, and cannot be merged until someone with write access marks it ready (the lifecycle, §2.11). A repository that does not allow draft pull requests refuses the create; that refusal is recorded like any other (§2.9).

### 2.5.1 Re-application after a rewritten history

When the reviewed commit is not an ancestor of the head H (read when the publication is planned), each suggestion pull request is decided on its own, from its complete list of changes:

| Change | Re-applied onto H only when | Otherwise, the reason given |
| --- | --- | --- |
| Edit of `PATH` (one or more replaced line ranges of the reviewed file) | `PATH` is a regular file at H, and each replaced range holds exactly the reviewed bytes at the same lines (line terminators included) | `` `PATH` line L differs from the reviewed text `` or `` `PATH` lines A-B differ from the reviewed text `` (one reason per range); `` `PATH` no longer exists `` |
| Creation of `PATH` | nothing exists at `PATH` at H | `` `PATH` already exists `` |
| Deletion of `PATH` | `PATH` is a regular file at H with the reviewed file's exact content and mode (the same Git blob and mode) | `` `PATH` differs from the reviewed file ``; `` `PATH` no longer exists `` |
| Edit of `PATH`, whose text at H cannot be read as source | — | `` `PATH` is not UTF-8 text at the head ``; `` `PATH` exceeds the source-read limit `` (1,000,000 bytes, checked from the tree before any download) |
| Any change | — | `` `X` is a directory ``, `` `X` is a symbolic link `` or `` `X` is a submodule `` when X, the path or a directory on the way to it, is one at H (never followed) |

The checks read Git trees and, for an edit, the file's text at H, through Git objects as source is read, never the Contents API; no blob of a created or deleted file is downloaded. An edited file whose text at H cannot be read as source (not UTF-8, or over the source limit) cannot be compared, so its suggestion is not created, with that reason; skipping is always safe. Any other failed read is operational. A range is compared at the same line numbers: a range that only moved is treated as changed and is never relocated. Every change must pass: a group is re-applied whole or not at all, never split.

- **Re-applied:** the proposal commit's parent is H, and its changes are the same changes applied to H: an edited file is H's file with exactly the same ranges replaced (so later edits elsewhere in the file are kept), a creation and a deletion are unchanged. The marker is version 2 and names H as `reappliedOnto` ([convention §7](suggestion-pr-convention.md#7-the-marker)); the body and the review section say so (§2.11).
- **Not created:** its section in the review body says so and lists every reason (§2.11), still showing the change and every finding carrying it; the ready assessment and the publication outcome carry one warning per such suggestion (`suggestion-pr-not-reapplied`), naming it and its reasons. Not creating a suggestion is not a refusal of the review, and everything else publishes as usual. A review whose suggestions are all not created needs no suggestion pull request at all: it is published exactly like one without them (no labels, permission or configuration are needed, and its state is the version-1 record).
- The limit of 10 suggestion pull requests (§2.8) counts the ones that would be created. Without a rewritten history every one would be. Either way the limit is reported with every other problem of the review.
- The decision is made once, when the publication is planned, and recorded in the plan (§2.9). A retry never compares again or re-decides, even if the head was rewritten again in between: a re-application is a snapshot of the head it was made on.

### 2.6 Branch naming and ownership

Each suggestion's proposal branch is `suggestion-pr/<pull number>/<suggestion id>` ([convention §5](suggestion-pr-convention.md#5-the-branch)), where the suggestion id is a random v4 UUID generated once per suggestion and persisted before any write. The name is unique to one suggestion of one publication, so a new publication (a new state path) never collides with an earlier one.

The tool owns only branches it created, and only to create them: it creates each branch exactly once, pointing at its proposal commit, and never updates, force-pushes, rebases or deletes it. A branch a person has since changed is left as it is (§2.10). Deleting branches is outside publication; cleanup closes pull requests only, and branch removal is left to people or to GitHub's automatic deletion of merged branches.

The proposal commit is created through GitHub's Git database API: one blob per created or edited file, whose Git blob id is computed locally from the exact proposed bytes and must equal the host's answer; one tree based on the parent's tree (a deletion is a `sha: null` entry); one commit with the parent as its only parent. The parent is the reviewed commit, or H for a re-applied suggestion (§2.5.1). Before the branch is created, the commit is read back: its tree, parent, and every changed path (blob id and mode, or absence for a deletion) must be exactly as proposed. An edited file keeps its existing mode; a created file has its proposed mode. These objects are content-addressed and invisible until a branch points at them, so creating them again after a failure creates nothing a person can see and is not an uncertain write.

### 2.7 Relationship: reference, marker and labels

A suggestion pull request's body establishes the relationship; the original pull request is never edited. Everything below is the [convention](suggestion-pr-convention.md); nothing GitHub shows names SARIF or this tool.

- **Ordinary reference.** The body begins `Suggested in a review of #<pull> at commit <reviewed commit>.` The `#<pull>` reference creates GitHub's cross-reference on the original pull request (the D21 backlink). It is not a closing keyword.
- **Structured marker.** The body ends with one hidden line ([convention §7](suggestion-pr-convention.md#7-the-marker)):

  ```
  <!-- suggestion-pr {"version":1,"original":{"owner":"<owner>","repo":"<repo>","pullNumber":<pull>},"reviewedCommit":"<40-hex>","id":"<suggestion id>","batch":"<publication id>"} -->
  ```

  The JSON is canonical: exactly these members in this order, no whitespace. `id` identifies this suggestion (its branch carries it), `batch` groups the suggestions of one review (this tool uses its publication id, one per state path), `original` names the original pull request, and `reviewedCommit` the proposal's parent. A suggestion re-applied after a rewritten history (§2.5.1) carries the version-2 marker instead, `{"version":2,…,"reviewedCommit":"<40-hex>","reappliedOnto":"<40-hex>","id":…,"batch":…}`, whose `reappliedOnto` is the proposal's parent. The marker is metadata, not a secret, and never contains `-->`. The review-body marker released in 0.2.x is not part of the convention and is unchanged.
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

1. Whole-review preparation of the SARIF with the setting: every rule of §2.3–§2.4, the file-operation rules, and the existing limits. With the setting enabled, one more limit applies: at most **10 suggestion pull requests** per review (`too-many-suggestion-prs`), a conservative product limit against pull-request storms; and every suggestion pull request body is held to the existing 60,000-character limit (`suggestion-body-too-large`), never truncated. A created file in a suggestion pull request may hold at most 1,000,000 bytes (`suggestion-file-too-large`), the source-read limit. File-content refusals of the file-operation contract (for example bare carriage returns) still apply. These limits are the owner-accepted ones (#27), and they are this tool's, not the convention's.
2. With the setting enabled, the pull request's branches and repositories and the repository's default branch and permissions are read before preparation, because the suggestion texts name the head branch; their comparison is read lazily, during preparation and only once it has found suggestion units, when the head is not the reviewed commit and the pull request is one suggestion pull requests support (§2.5), because what is created depends on it. Only when the ready preparation needs at least one suggestion pull request are the repository checks applied, all reported together: `suggestion-pr-fork-unsupported`, `suggestion-pr-base-unsupported`, `suggestion-pr-permission-missing`, `suggestion-pr-configuration-invalid`, `suggestion-label-missing`. A head that moved is never among them (§2.5). The repository configuration and the labels are read only then (the canonical label is not checked when the configuration is invalid; the extra labels still are). A failed read is operational (`publish` rejects, `validate` answers `incomplete`). With the setting disabled, none of these reads happens.
3. The authenticated account's numeric id, as today.

A `ready` assessment with suggestion pull requests says how many would be created, into which branch, in which form and with which labels, for example ``Publication would also create 1 draft suggestion pull request into `feature/retry`, labeled `suggestion-pr`.`` or ``Publication would also create 2 suggestion pull requests, ready for review, into `feature/retry`, labeled `suggestion-pr` and `docs`.`` When they are re-applied after a rewritten history (§2.5.1), it adds ``The history of #7 was rewritten after the reviewed commit, so it is re-applied onto commit `H`, where everything it changes is still exactly as reviewed.`` (for several: ``so they are re-applied onto commit `H`, where everything they change is still exactly as reviewed.``), and a suggestion that would not be created is a `suggestion-pr-not-reapplied` warning. Codes are internal, as always (D13); the Markdown and `problems` are the contract. *Since [D45](design-decisions.md#d45-model-diagnostics-once-and-render-them-per-audience--owner-decision) (September 30, 2026), codes are public and catalogued in [Diagnostics](diagnostics.md), and this warning is a `suggestion-pr-not-reapplied` diagnostic.*

### 2.9 Durable identity and the order of writes

The caller's single `statePath` identifies the publication. With suggestion pull requests, the state is several files, each written with the existing durability discipline (a flushed sibling temp file, an exclusive hard link to claim, an atomic rename to complete, a directory flush):

| File | Holds | Written |
| --- | --- | --- |
| `<statePath>` | The **plan**: format `sarif-to-comment.companion-publication-state`, version 1, or version 2 when its suggestions are re-applied (§2.5.1), which adds `reappliedOnto`, the commit they are re-applied onto; destination, reviewed commit, input fingerprint, author id, mode, head branch, the labels (the canonical label first, then the extra labels, each as GitHub names it), whether the pull requests are created ready for review; the publication id (the marker's `batch`); for each suggestion its id, branch, title, body (with marker), commit message and exact changes; the review's body sections and inline comments; a fingerprint over all of it. | Once, exclusively, before any write. Never changed. |
| `<statePath>.suggestion-<n>-branch` | Intent: the proposal commit. Receipt: the branch verified at that commit. | Claimed exclusively before the branch is created. |
| `<statePath>.suggestion-<n>-pull` | Intent to create the pull request. Receipt: its number and URL. | Claimed exclusively before the pull request is created. |
| `<statePath>.suggestion-<n>-labels` | Intent to label pull request N with the plan's labels. Receipt: every label verified on it. | Claimed exclusively before the labels are added. |
| `<statePath>.review` | The review's own publication record, exactly the existing version-1 format (marker, saved request, receipt or refusal). | By the existing publication core, before the review is sent. |

Order: for each suggestion in turn, proposal commit, branch, pull request, labels (one request adding every label); then the review, whose body links every suggestion pull request by number. Each step's intent is persisted and exclusively claimed **before** its write is sent, and a claimed step is **never sent again** by any invocation, whatever a later lookup shows. The Git objects of §2.6 are the only writes made without a claim, because they are invisible and content-addressed. A step whose claim another invocation holds is only investigated, so concurrent invocations never duplicate a write.

Without suggestion pull requests, and when enabled but the review needs none, the state file is the existing version-1 record, byte for byte.

**Definitive refusals.** When GitHub definitively refuses a branch, pull-request or labels write (HTTP 400, 401, 403, 404, 409, 422 or 429), the step's record becomes a terminal refusal with only the status and a bounded message, no later step is sent, and the review is not published (it would link a suggestion that does not exist). Later calls report the recorded refusal without contacting GitHub. Anything already created is left as it is and listed.

### 2.10 Recovery and human changes

A call that meets an existing plan continues it: each completed step is reported from its receipt with no request; each claimed but unsettled step is **investigated**; each unclaimed step is performed. Every investigation is read-only and requires the same authenticated account id as the plan.

| Step | Investigation | Complete when | Otherwise |
| --- | --- | --- | --- |
| Branch | Read `refs/heads/<branch>` | It points at the intended commit | Absent: `not-found`. Elsewhere: `candidate-differs` (a person may have pushed). |
| Pull request | List the repository's pull requests whose head is the proposal branch (`state=all`) | Exactly one carries the exact marker line (version 2 for a re-applied suggestion), is authored by the plan's account, has the proposal branch as head in this repository and the original's head branch as base | None: `not-found`. Several: `ambiguous`. Wrong author, head or base: `candidate-mismatch`. |
| Labels | Read the pull request's labels | Every planned label is present (compared case-insensitively) | `not-found`, naming the missing labels |
| Review | The existing review investigation | As today | As today |

Any unsettled outcome stops the publication as **uncertain**, naming the step, what is already established, and that a retry with the same state path only rechecks and never sends that step again. Absence is never treated as proof that nothing was created (delayed visibility), and the labels are never needed to locate a pull request.

**The branch changed since planning.** A call that continues a plan in which some suggestion's steps are not all complete, and no step was refused, first reads the pull request's head (read-only) and compares it with the plan's base: `reappliedOnto`, otherwise the reviewed commit. When the base is no longer part of the branch (a force-push since the suggestions were planned), nothing is re-decided: the suggestion pull requests still to be created are created on the planned base, as planned. The outcome then says so, before the list of suggestion pull requests (or after the detail of an uncertain or refused outcome): ``**The branch of #7 changed since these suggestions were planned:** they are based on commit `B`, which is no longer part of it (its head is now `H`). The suggestion pull requests still to be created are created on that commit, as planned; nothing is re-decided.`` A failed read is not a reason to stop: the outcome says instead that whether the branch changed is not known, naming the read's failure. A branch that only moved forward from the base, or a plan with nothing left to create, gives no such paragraph, and a completed plan reads nothing. The review body is never changed for it (it is rendered from the plan).

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

**Review body.** Each suggestion pull request becomes one body section, at the position of the first finding that carries any of its changes, in SARIF order:

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
- edit: `Edited [PATH line L at SHORT](PERMALINK#LL)` or `Edited [PATH lines A-B at SHORT](PERMALINK#LA-LB)`, the replaced lines of the reviewed file.

`ITEMS` are the findings carrying those changes, joined by `\n\n---\n\n`, each rendered as today: after `**Location:** line(s) … of the proposed file` for a located finding on a created file, and after its quoted source for a located finding on an edited or deleted file. Proposed content is not repeated in the review (R10): the pull request carries the exact bytes.

**Suggestion pull request.** Title `Suggestion for #PULL: SUMMARY`, where SUMMARY is `create PATH`, `delete PATH` or `edit PATH` for one change and `GROUP (K changes)` for a group; if the title would exceed 256 characters, SUMMARY is `K change(s)`. Body:

```
Suggested in a review of #PULL at commit REVIEWED.

REAPPLIED                                                         (only when re-applied, §2.5.1)

Merging this pull request into HEADREF applies this change:     (or: these K changes together:)

- CHANGE
- …

LIFECYCLE

---

ITEMS

MARKER
```

`LIFECYCLE` is the brief lifecycle note the owner asked for in each body (#27; [convention §8](suggestion-pr-convention.md#8-lifecycle)). For a draft:

```
**How this suggestion is accepted:** it is a draft pull request into HEADREF, the branch of #PULL. A draft cannot be merged: someone with write access first marks it ready for review. The author of #PULL then decides whether to merge it, and #PULL carries the change to its base. Once #PULL is merged or closed, this pull request can be closed.
```

Created ready for review:

```
**How this suggestion is accepted:** it is a pull request into HEADREF, the branch of #PULL. The author of #PULL decides whether to merge it, and #PULL carries the change to its base. Once #PULL is merged or closed, this pull request can be closed.
```

`REAPPLIED` is `The history of #PULL was rewritten after that commit, so this change is re-applied onto commit H, the head of #PULL when it was proposed, where everything it changes is still exactly as reviewed.`

The commit message is the title, a blank line, and `Suggested in a review of OWNER/REPO pull request PULL at commit REVIEWED.`, or for a re-applied suggestion `Suggested in a review of OWNER/REPO pull request PULL at commit REVIEWED, and re-applied onto commit H after the pull request's history was rewritten.`

**Re-application in the review body** (§2.5.1). A re-applied suggestion's section gains, after its link, the paragraph `The history of #PULL was rewritten after the reviewed commit, so this change is re-applied onto commit H, the head of #PULL when it was proposed, where everything it changes is still exactly as reviewed.` A suggestion that is not created keeps its section, at the same position, as:

```
**Suggestion pull request not created:** the history of #PULL was rewritten after the reviewed commit, and this change cannot be re-applied onto commit H, the head of #PULL, because there:

- REASON
- …

It would have proposed this change:                    (or: these K changes together:)

- CHANGE
- …

ITEMS
```

with the reasons of §2.5.1 grouped by file, in the order the change list first names each file.

**Outcomes.** A published outcome gains `suggestions: [{ number, url, branch }]`, present only when suggestion pull requests were created; its Markdown lists them after ``Suggestion pull requests (drafts into `HEADREF`, labeled LABELS):`` or ``Suggestion pull requests (ready for review, into `HEADREF`, labeled LABELS):``, where LABELS lists every applied label as code spans joined like `` `a` ``, `` `a` and `b` ``, `` `a`, `b` and `c` ``. Re-applied suggestions add ``, re-applied onto commit `H` `` before the colon, on every call that reports the publication. The `suggestion-pr-not-reapplied` warnings appear in the outcome of the call that planned the publication, as every preparation warning does; the review body keeps the reasons permanently. Uncertain and refused outcomes list what is already established. Everything else is unchanged.

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
- **Grouping rules.** Refused: a finding already in another group (a finding belongs to at most one, and groups are never joined); a finding whose `properties.sarifToComment` is not an object; a finding without a change (no fix and no proposed file operation); a group, new or extended, that would hold fewer than two distinct changes. A change is a replacement of the primary fix or a proposed file operation, compared as written (identical ones count once); publication checks distinctness again against the reviewed files (§2.3).
- **What grouping writes.** `properties.sarifToComment.suggestionGroup: NAME` on each finding, creating the property bag and namespace when absent; nothing else changes.
- **Ungrouping** removes the key from each finding, and then an owned namespace or property bag left empty, so ungrouping a whole group restores the document as it was. Refused: a finding in no group; leaving a group with fewer than two distinct changes (the refusal names the remaining findings and their current selectors, to include them). That refusal stays because the tool cannot proceed safely there: such a group could never be published (`suggestion-group-single-change`), and silently ungrouping the rest would be inference.
- **Outcomes.** `grouped`: `{ sarif, group, extended, findings: [{ ref, runIndex, resultIndex, tool, changes }], changes }` (`extended` says whether the group already existed; `findings` are those named in the call, in document order; `changes` per finding counts its primary fix's replacements and its proposed operations; the group's `changes` counts the whole group's distinct ones). `ungrouped`: `{ sarif, findings: [{ ref, runIndex, resultIndex, tool, group }] }`. `refused`: `{ problems, markdown }`, the Markdown beginning `**Cannot group the fixes:**` or `**Cannot ungroup the fixes:**`. `stale` is the removal contract's outcome.
- **CLI receipts.** `{ command, status, sarif: { path, written }, [output: { path, written }], ... }` with the library's fields; refusals carry `problems`. Human output says whether findings were grouped or added to an existing group, names each with its change count, what publication does with the group, and that selectors must be taken again.
- **Inspection** shows `suggestionGroup` after the finding's facts (`Finding … — tool · suggestionGroup: NAME`, and the `suggestionGroup` field of the JSON view), when the value is a string; any other value stays visible in the finding's other content.

## 3. Worked example

Pull request `octo/widgets#7`, head branch `feature/retry`, base `main` (the default branch), reviewed at its head `2222222…`. The repository has no `.github/suggestion-prs.json`, so the canonical label is `suggestion-pr`. One run bound to that commit holds:

1. "Retry once on timeout." with a fix replacing line 3 of `src/client.ts`;
2. "Cover the retry." creating `test/client.test.ts`;
3. "Typo." with a native-suggestion-eligible fix on line 1 of `README.md`.

An agent inspects the document and runs `group-fixes --finding <selector of 1> --finding <selector of 2> --group retry-with-test`, which gives results 1 and 2 `suggestionGroup: "retry-with-test"`; result 3 stays in no group.

Disabled: blocked, `suggestion-group-requires-suggestion-prs` at `/runs/0/results/0`. Enabled (`--allow-suggestion-prs --pr-labels team-a`), with the labels `suggestion-pr` and `team-a` present and push permission: one draft pull request from `suggestion-pr/7/<id>` into `feature/retry`, titled `Suggestion for #7: retry-with-test (2 changes)`, whose single commit edits line 3 of `src/client.ts` and adds `test/client.test.ts`, labeled `suggestion-pr` and `team-a`, with the draft lifecycle note; then one draft review whose inline comment on `README.md` carries the native suggestion and whose body section links the pull request, lists both changes and presents both findings. With `--mark-suggestion-prs-ready` as well, the pull request is created ready for review and its body carries the ready lifecycle note. If `team-a` did not exist, the review would be blocked before any write, and `validate` would say the same.

## 4. Decisions awaiting acceptance

Decided by the owner, and no longer awaiting acceptance:

- **Off by default, explicit opt-in** (§2.1): [#5](https://github.com/mike-north/sarif-to-comment/issues/5). The earlier provisional D22 default ("enabled when omitted") is superseded.
- **The convention, options, labels and lifecycle** ([#27](https://github.com/mike-north/sarif-to-comment/issues/27)): the tool-neutral [convention](suggestion-pr-convention.md) (label `suggestion-pr`, the optional default-branch configuration file, branch `suggestion-pr/<pull>/<id>`, the marker with `batch`, neutral title and body with no closing keywords); the option names `allowSuggestionPullRequests` / `--allow-suggestion-prs`, `pullRequestLabels` / `--pr-labels`, `markSuggestionPullRequestsReady` / `--mark-suggestion-prs-ready`, and the removal of the per-call label; all of them in the publication identity; every label must already exist, the tool never creates one, and a missing label blocks before any write; drafts by default; branches created once and never updated, force-pushed or deleted; native suggestions first; same repository with a default-branch base, with forks and other bases not yet supported; and the limits and mechanics as merged (at most 10 suggestion pull requests per review, bodies of at most 60,000 characters, created files of at most 1 MB, per-step state persisted before each attempt, recovery by unique branch plus exact marker, a refused step stops publication, a retry never overwrites human pushes).
- **Groups** ([#29](https://github.com/mike-north/sarif-to-comment/issues/29)): extraction stays deterministic (every separable staged hunk is its own fix); grouping is a separate authoring step (§2.12); a fix with several changes is already a group and becomes one suggestion pull request with no property; the per-result `suggestionGroup` property, renamed from the unreleased `acceptanceGroup`, joins what SARIF cannot; at least two distinct changes; a finding in at most one group, and groups never joined, while a name already in use extends its group (refuse only when the tool cannot proceed safely); only the primary fix is a member; a member without a change is refused; nothing is inferred; `inspect` shows each finding's group; disallowed suggestion pull requests refuse a grouped document naming the setting (§2.3, §2.4).
- **A branch that moved forward after the review is not a reason to refuse** (#27), and **a rewritten history is handled by testing ancestry** ([#28](https://github.com/mike-north/sarif-to-comment/issues/28)): an advanced branch proceeds on the reviewed commit; after a rewrite, each suggestion is re-applied onto the head only when everything it changes is byte-identical there, and is otherwise not created, with its reason stated in the review and the outcome; ordinary feedback publishes as before (§2.5, §2.5.1).

Still awaiting the owner:

1. **Head-branch target and reviewed-commit parent** (§2.5), and not chasing a head that moves after validation. Alternative: basing on the current head (would propose against unreviewed code).
2. **Presentation details** (§2.11): the exact lifecycle note and the review-body section. The owner asked for a brief lifecycle note in each body; its wording is this contract's.
3. **Refusal wording** for the unsupported cases (§2.5), in particular why an original into a non-default base is not yet supported (the stacked-pull-request retargeting path is unbuilt and unverified).
4. **Details of the options** (§2.2): the CLI trims spaces around `--pr-labels` names; extra labels are deduplicated keeping the first spelling; the identity document's shape.
5. **Details of the configuration read** (§2.7): through Git objects, with a symbolic link, directory or submodule, and a file over 1,000,000 bytes, treated as invalid; unknown members ignored ([convention open questions](suggestion-pr-convention.md#10-open-questions)).
6. **One request for all labels**, and one labels step and state file per suggestion (§2.9).
7. **Details of re-application** (§2.5.1, §2.11): ranges compared at the same line numbers, never relocated; a deletion compared by Git blob and mode; the reason and presentation wording; the plan's version 2 with `reappliedOnto`; and counting only the suggestion pull requests that would be created against the limit of 10.
8. **A branch rewritten again after planning** (§2.10): a retry keeps the plan (the remaining suggestion pull requests are still created on the planned base) and only warns in its outcome. Alternatives: stop the remaining steps, or re-plan them, which would break the rule that a retry never re-decides.

## 5. What cleanup (#6) can rely on

- Every suggestion pull request this tool creates follows the [convention](suggestion-pr-convention.md): it carries the canonical label and any extra labels (once its labels step completes) and exactly one marker line of §2.7 (version 1, or version 2 when re-applied), whose `original` names the original pull request in the same repository. Suggestion-first enumeration can list open pull requests with the canonical label and parse the marker; targeted discovery can start from the original's cross-reference backlinks, which the body's ordinary reference creates.
- The marker, not the title, is the relationship. A labeled pull request without a recognized marker is not a suggestion pull request.
- The labels may be missing when a publication stopped before its labels step, or when a person removed them; such a suggestion is still reached from the original's backlinks and its marker.
- Proposal branches are named `suggestion-pr/<pull>/<id>` and are never changed by the tool after creation. A re-applied one's commit is based on the marker's `reappliedOnto`, not on the reviewed commit.
- The canonical label is resolved the same way for cleanup as for publication (§2.7).
