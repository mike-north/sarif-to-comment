# Companion suggestion pull requests: contract

Proposal awaiting owner acceptance · September 29, 2026. Publication of whole-file operations and explicitly grouped edits as companion suggestion pull requests is implemented under the conservative options below. Every decision in [Decisions awaiting acceptance](#decisions-awaiting-acceptance) is provisional until the owner accepts or replaces it. Where this proposal departs from a recorded default (§2.1), the departure is stated with its reasons.

**Sources.** [Issue #5](https://github.com/mike-north/sarif-to-comment/issues/5); [specification](specification.md) R16 and open contract O11, with R1, R3, R8, R10, R12, R13 and R14; [decisions](design-decisions.md) D7, D12, D14, D21–D29; the [file-operation publication contract](file-operation-publication-contract.md), which remains the form used when suggestion pull requests are not enabled; the [grouped-suggestion](grouped-suggestion-experiment.md), [lifecycle](companion-pr-lifecycle-experiment.md) and [recovery](publication-recovery-experiment.md) experiments; [status](status.md). Cleanup of suggestion pull requests after their original pull request ends is [issue #6](https://github.com/mike-north/sarif-to-comment/issues/6) and is not implemented here; §8 states what it can rely on.

## 1. What is fixed by the sources

- The caller can allow or disallow suggestion pull requests (R16, D22).
- Small edits that a native suggestion represents faithfully prefer the native suggestion in either configuration (R16, D22; A27). Enabling suggestion pull requests never routes a native suggestion to a pull request.
- With suggestion pull requests enabled, a whole-file creation or deletion prefers a suggestion pull request, and an explicitly supplied group of distinct edits requiring acceptance as a unit uses one suggestion pull request containing the whole group (R16, D22; A28, A29, A32).
- With suggestion pull requests disabled, creations and deletions keep their ordinary review presentation ([file-operation contract](file-operation-publication-contract.md)), and a required group is reported as needing suggestion pull requests; it is never split, approximated with independent suggestions or omitted, and the whole-review gate applies (R12, R16, D12, D22; A30, A32).
- Groups are only ever supplied, never inferred, and alternative remedies are never merged into one patch (D7; §2 of the specification).
- A suggestion pull request targets the original pull request's branch. It carries an ordinary reference to the original in its own body and the configured suggestion label. The original's description is never edited, and the reference is never a closing keyword (D21, D24; A31, A33).
- Near-term support is the same repository only; forks are recorded, not required (D25; A34).
- R11 and R12 apply before any proposal-branch, pull-request or label write as well as the review write. Recovery covers every remote object, and a created suggestion pull request is not proof that the review was published (R16, R14, D28).
- Each intended remote object has its own identity, persisted before its uncertain write. Rediscovery must survive a lost response; absence from a listing never establishes that nothing was created, and recovery never depends on a label applied after creation (R14, D28; A37).
- A draft code review may be accompanied by visible draft suggestion pull requests; no extra privacy step is added (R13, D26; A35).
- Publication is one-way. Recovery completes the same initial publication and never restores, reconciles or maintains anything a person changed (D29; A38, A39).

## 2. Decisions (proposal)

### 2.1 The setting, and why it is off by default

**Adopted: suggestion pull requests are disabled unless the caller enables them** (`options.suggestionPullRequests: true`, CLI `--suggestion-prs`).

[D22](design-decisions.md#d22-gate-suggestion-prs-with-one-caller-setting--settled-direction) records "enabled when omitted" as a *low-conviction* default, to be validated against "PR clutter and repository automation triggered by PR creation". Issue #5 asks for that evaluation. It found the costs of an enabled default concrete and the benefit small:

| Consideration | Enabled by default | Disabled by default (adopted) |
| --- | --- | --- |
| Behavior of existing callers | Changes silently on upgrade: a document with a file operation, which today publishes one review, would start creating branches and pull requests, and would need new permissions (branch push, labels). | Unchanged byte for byte: the same requests, the same review body, the same state file. |
| Repository clutter | One extra pull request and branch per standalone file operation and per group, visible to every repository reader, persisting until someone closes them (cleanup is a separate, on-demand action, [#6](https://github.com/mike-north/sarif-to-comment/issues/6)). | Only callers who asked for pull requests get them. |
| Triggered automation | Every created pull request can start CI workflows (`pull_request` events run for draft pull requests unless a workflow opts out), notify watchers and code owners, trigger bots, and count against required-check and runner budgets. None of this is visible to the reviewer publishing SARIF, and the lifecycle experiments confirmed that the repository's own required checks ran on suggestion pull requests. | The caller opts into those costs knowingly. |
| Failure surface | New failure modes for everyone: missing push permission, a missing label, fork pull requests, a moved head. Each would block reviews that publish today. | Those checks apply only when requested. |
| What is lost | Grouped edits and pull-request-based file operations work without a flag. | Grouped edits need one explicit setting; without it they are refused with the setting named (never split). Creations and deletions still publish, in the review body. |

The asymmetry decides it: an enabled default imposes surprise costs on every repository to save one flag for the callers who want the feature, and turning it off after the fact does not remove pull requests already created. The explicit disable choice D22 requires remains available (`suggestionPullRequests: false` behaves exactly like omission). If the owner re-adopts D22's default, only the omitted-option value changes; nothing else in this contract depends on it.

### 2.2 Options

| Library (`options`) | CLI | Meaning |
| --- | --- | --- |
| `suggestionPullRequests?: boolean` | `--suggestion-prs` | Allow suggestion pull requests. Omitted or `false`: disabled. |
| `suggestionLabel?: string` | `--suggestion-label NAME` | The label every suggestion pull request carries. Default `suggestion`. Allowed only together with `suggestionPullRequests: true` (otherwise a `TypeError` / usage error, so a label is never silently ignored). 1–50 characters, no control or invisible formatting characters, no leading or trailing whitespace. |

`validateSarifReview` and `validate` accept the same options, because they take publication's options.

The setting and the label are part of the publication's **input identity**: when enabled, the input fingerprint's identity document gains `suggestionPullRequests: { label }`. When disabled, the identity document is exactly what it was, so default-off fingerprints, requests and state files are unchanged. Retrying a state path with a different setting or label is refused as a `state-mismatch` ("belongs to a different original input") before any request.

### 2.3 Explicit groups in SARIF

A result joins an acceptance group through its owned property:

```json
"properties": { "sarifToComment": { "acceptanceGroup": "retry-with-test" } }
```

- Results whose `acceptanceGroup` values are equal form one group, across every run of the log. The value is an identifier the caller chooses; it is shown only in the suggestion pull request's title. It must be 1–100 characters with no control or invisible formatting characters and no leading or trailing whitespace (`acceptance-group-invalid`).
- Every member carries exactly one change: one SARIF fix with one artifact change and one replacement (an **edit**), or one `proposedFileChanges` creation or deletion. A member with neither is refused (`acceptance-group-member-without-change`): a group joins changes, and feedback without a change has nothing to join.
- Members that carry the identical change (same path, range and replacement text; or the same whole-file operation) share it, as identical suggestions and identical proposals already do (R8). A group must hold at least two distinct changes (`acceptance-group-single-change`); a single change is published on its own.
- Nothing is inferred. Results without the property are never added to a group, and two groups are never joined, even when they touch the same file.
- Alternatives are not a group. Several fixes on one result remain `fix-alternatives-unsupported`, and a multi-file or multi-replacement SARIF fix remains unsupported; that fix structure belongs to [#9](https://github.com/mike-north/sarif-to-comment/issues/9).
- With suggestion pull requests disabled, every group is refused with `acceptance-group-requires-suggestion-prs` at its first member, naming the setting. The whole review is blocked; nothing is split or published (A30, A32).

Before this contract, `acceptanceGroup` was an unknown owned key and blocked the review as `owned-property-invalid`. Documents without the key behave exactly as before.

### 2.4 Presentation-form selection

| Proposal | Disabled (default) | Enabled |
| --- | --- | --- |
| Edit eligible for a native suggestion, not in a group | Native suggestion (unchanged) | Native suggestion (unchanged) |
| Standalone whole-file creation or deletion | Review-body section ([file-operation contract](file-operation-publication-contract.md)) | One suggestion pull request per distinct operation; findings carrying the identical operation share it |
| Explicit group | Blocked: `acceptance-group-requires-suggestion-prs` | One suggestion pull request containing every change of the group |
| Edit that no native suggestion can represent, not in a group | Blocked as today (for example `suggestion-not-inline`) | Blocked as today; an edit uses a pull request only as part of an explicit group |

A group edit is applied to the reviewed file exactly as a native suggestion's replacement would be (the replacement module's exact edit), but it does not need native-suggestion eligibility: it is committed, not rendered. The existing association rule still applies: a located member's own lines must lie within its replacement's lines (`fix-association-unsupported`), so feedback is never moved.

**Conflicts.** Each presentation unit (one inline comment, one suggestion pull request, one body section) must be acceptable independently of the others. The whole review is blocked when two units propose different changes to the same lines (`overlapping-replacements`), or when a path is created or deleted in one unit and changed in any way by another (`file-operation-conflict`). Within one group, non-overlapping edits of one file are combined in line order; overlapping different edits are refused.

### 2.5 Repository, target branch and revision

- **Same repository only** (D25). The pull request's head repository must be its base repository (`suggestion-pr-fork-unsupported`).
- **Target.** Each suggestion pull request's base is the original pull request's head branch (`head.ref`), read from the pull request during validation. It is never the default branch: when the original's head branch *is* the repository's default branch, the review is blocked (`suggestion-pr-default-branch-unsupported`), because GitHub acts on closing keywords in a pull request that targets the default branch, and the suggestion carries the reviewers' own feedback text verbatim.
- **Base commit.** Each proposal branch is one commit whose parent is the **reviewed commit**, and it is created only when the reviewed commit is the pull request's current head (`suggestion-pr-historical-unsupported`). The proposed changes are therefore exactly the pull request's diff from the reviewed state, never a rebase or a merge.
- **A head that moves later** (after validation) is not chased. The branch keeps the reviewed commit as its parent, the pull request still targets the head branch, and nothing is retargeted, rebased or re-validated on retry. GitHub shows the suggestion's own changes; whether they still merge cleanly is for the person accepting them.
- **Draft pull requests.** Suggestion pull requests are always created as drafts, in both review modes. Draft status avoids automatic review requests to code owners and is the accepted D26 form. A repository that does not allow draft pull requests refuses the create; that refusal is recorded like any other (§2.9).

### 2.6 Branch naming and ownership

Each suggestion's proposal branch is `sarif-to-comment/suggestions/<pull number>/<suggestion id>`, where the suggestion id is a random v4 UUID generated once per suggestion and persisted before any write. The name is unique to one suggestion of one publication, so a new publication (a new state path) never collides with an earlier one.

The tool owns only branches it created under that prefix, and only to create them: it creates each branch exactly once, pointing at its proposal commit, and never updates, force-pushes, rebases or deletes it. A branch a person has since changed is left as it is (§2.10). Deleting branches is outside publication; cleanup of pull requests (#6) is also distinct from branch deletion.

The proposal commit is created through GitHub's Git database API: one blob per created or edited file, whose Git blob id is computed locally from the exact proposed bytes and must equal the host's answer; one tree based on the reviewed commit's tree (a deletion is a `sha: null` entry); one commit with the reviewed commit as its only parent. Before the branch is created, the commit is read back: its tree, parent, and every changed path (blob id and mode, or absence for a deletion) must be exactly as proposed. An edited file keeps its existing mode; a created file has its proposed mode. These objects are content-addressed and invisible until a branch points at them, so creating them again after a failure creates nothing a person can see and is not an uncertain write.

### 2.7 Relationship: reference, marker and label

A suggestion pull request's body establishes the relationship; the original pull request is never edited.

- **Ordinary reference.** The body begins `Suggested in a review of #<pull> at commit <reviewed commit>.` The `#<pull>` reference creates GitHub's cross-reference on the original pull request (the D21 backlink). It is not a closing keyword.
- **Structured marker.** The body ends with one hidden line:

  ```
  <!-- sarif-to-comment:suggestion {"id":"<suggestion id>","original":{"owner":"<owner>","pullNumber":<pull>,"repo":"<repo>"},"publication":"<publication id>","reviewedCommit":"<40-hex>","version":1} -->
  ```

  The JSON is canonical (keys sorted, no whitespace). `id` identifies this suggestion, `publication` the logical publication (one per state path), `original` the original pull request, and `reviewedCommit` the proposal's parent. The marker is metadata, not a secret, and never contains `-->`.
- **Label.** After creation the configured label is added. The label must already exist in the repository; validation reads it and blocks otherwise (`suggestion-label-missing`), naming the label and how to create it or choose another. The tool never creates labels, so a typo cannot create a stray label and label administration stays with the repository. The label's name as the host reports it is what is applied.
- **Permission.** Validation reads the repository's permissions for the authenticated account and blocks when it cannot push (`suggestion-pr-permission-missing`). This reflects the account's role; a token restricted below that role is discovered only when a write is refused (§2.9).

### 2.8 Readiness

Everything below runs in the shared review preflight, so `validate` and `publish` report the same outcome. It is read-only.

1. Whole-review preparation of the SARIF with the setting: every rule of §2.3–§2.4, the file-operation rules, and the existing limits. With the setting enabled, one more limit applies: at most **10 suggestion pull requests** per review (`too-many-suggestion-prs`), a conservative product limit against pull-request storms; and every suggestion pull request body is held to the existing 60,000-character limit (`suggestion-body-too-large`). A created file in a suggestion pull request may hold at most 1,000,000 bytes (`suggestion-file-too-large`), the source-read limit. File-content refusals of the file-operation contract (for example bare carriage returns) still apply.
2. With the setting enabled, the pull request's head branch and repositories and the repository's default branch and permissions are read before preparation, because the suggestion texts name the head branch. Only when the ready preparation needs at least one suggestion pull request are the host capability checks applied, all reported together: `suggestion-pr-fork-unsupported`, `suggestion-pr-historical-unsupported`, `suggestion-pr-default-branch-unsupported`, `suggestion-pr-permission-missing`, `suggestion-label-missing`; the label is read only then. A failed read is operational (`publish` rejects, `validate` answers `incomplete`). With the setting disabled, none of these reads happens.
3. The authenticated account's numeric id, as today.

A `ready` assessment with suggestion pull requests says how many would be created, into which branch and with which label, for example ``Publication would also create 1 draft suggestion pull request into `feature/retry`, labeled `suggestion`.`` Codes are internal, as always (D13); the Markdown and `problems` are the contract.

### 2.9 Durable identity and the order of writes

The caller's single `statePath` identifies the publication. With suggestion pull requests, the state is several files, each written with the existing durability discipline (a flushed sibling temp file, an exclusive hard link to claim, an atomic rename to complete, a directory flush):

| File | Holds | Written |
| --- | --- | --- |
| `<statePath>` | The **plan**: format `sarif-to-comment.companion-publication-state`, version 1; destination, reviewed commit, input fingerprint, author id, mode, head branch, label; the publication id; for each suggestion its id, branch, title, body (with marker), commit message and exact changes; the review's body sections and inline comments; a fingerprint over all of it. | Once, exclusively, before any write. Never changed. |
| `<statePath>.suggestion-<n>-branch` | Intent: the proposal commit. Receipt: the branch verified at that commit. | Claimed exclusively before the branch is created. |
| `<statePath>.suggestion-<n>-pull` | Intent to create the pull request. Receipt: its number and URL. | Claimed exclusively before the pull request is created. |
| `<statePath>.suggestion-<n>-label` | Intent to label pull request N. Receipt: the label verified on it. | Claimed exclusively before the label is added. |
| `<statePath>.review` | The review's own publication record, exactly the existing version-1 format (marker, saved request, receipt or refusal). | By the existing publication core, before the review is sent. |

Order: for each suggestion in turn, proposal commit, branch, pull request, label; then the review, whose body links every suggestion pull request by number. Each step's intent is persisted and exclusively claimed **before** its write is sent, and a claimed step is **never sent again** by any invocation, whatever a later lookup shows. The Git objects of §2.6 are the only writes made without a claim, because they are invisible and content-addressed. A step whose claim another invocation holds is only investigated, so concurrent invocations never duplicate a write.

Without suggestion pull requests, and when enabled but the review needs none, the state file is the existing version-1 record, byte for byte.

**Definitive refusals.** When GitHub definitively refuses a branch, pull-request or label write (HTTP 400, 401, 403, 404, 409, 422 or 429), the step's record becomes a terminal refusal with only the status and a bounded message, no later step is sent, and the review is not published (it would link a suggestion that does not exist). Later calls report the recorded refusal without contacting GitHub. Anything already created is left as it is and listed.

### 2.10 Recovery and human changes

A call that finds a plan continues it: each completed step is reported from its receipt with no request; each claimed but unsettled step is **investigated**; each unclaimed step is performed. Every investigation is read-only and requires the same authenticated account id as the plan.

| Step | Investigation | Complete when | Otherwise |
| --- | --- | --- | --- |
| Branch | Read `refs/heads/<branch>` | It points at the intended commit | Absent: `not-found`. Elsewhere: `candidate-differs` (a person may have pushed). |
| Pull request | List the repository's pull requests whose head is the proposal branch (`state=all`) | Exactly one carries the exact marker line, is authored by the plan's account, has the proposal branch as head in this repository and the original's head branch as base | None: `not-found`. Several: `ambiguous`. Wrong author, head or base: `candidate-mismatch`. |
| Label | Read the pull request's labels | The label is present | `not-found` |
| Review | The existing review investigation | As today | As today |

Any unsettled outcome stops the publication as **uncertain**, naming the step, what is already established, and that a retry with the same state path only rechecks and never sends that step again. Absence is never treated as proof that nothing was created (delayed visibility), and the label is never needed to find a pull request.

Before a pull request is created, the proposal branch is read once more. If it no longer points at the proposal commit, nothing is created and the outcome is uncertain (`branch-changed`): the branch is never recreated, reset or force-pushed.

Exact outcomes for human changes (D29: none is repaired, restored or reconciled):

| Change by a person | Outcome |
| --- | --- |
| Pushes to, or deletes, a proposal branch before its pull request exists | `branch-changed`; no pull request is created; each retry rechecks without writing. |
| Pushes to a proposal branch after its pull request exists | Not inspected; publication continues. |
| Edits a suggestion pull request's title or body, keeping the marker line | The pull request is still recognized; the edit is kept. |
| Removes the marker line before the pull request step was settled | `not-found`; the pull request is never recreated. |
| Closes or merges a suggestion pull request before the label or review | The label is still applied and the review still links it; nothing is reopened. |
| Removes the label | Before the label step settled: `not-found`, never re-applied. After: not inspected. |
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

Merging this pull request into HEADREF applies this change:     (or: these K changes together:)

- CHANGE
- …

---

ITEMS

MARKER
```

The commit message is the title, a blank line, and `Suggested in a review of OWNER/REPO pull request PULL at commit REVIEWED.`

**Outcomes.** A published outcome gains `suggestions: [{ number, url, branch }]`, present only when suggestion pull requests were created; its Markdown lists them. Uncertain and refused outcomes list what is already established. Everything else is unchanged.

## 3. Worked example

Pull request `octo/widgets#7`, head branch `feature/retry`, reviewed at its head `2222222…`. One run bound to that commit holds:

1. "Retry once on timeout." with a fix replacing line 3 of `src/client.ts`, in group `retry-with-test`;
2. "Cover the retry." creating `test/client.test.ts`, in group `retry-with-test`;
3. "Typo." with a native-suggestion-eligible fix on line 1 of `README.md`, in no group.

Disabled: blocked, `acceptance-group-requires-suggestion-prs` at `/runs/0/results/0`. Enabled, with the `suggestion` label present and push permission: one draft pull request from `sarif-to-comment/suggestions/7/<id>` into `feature/retry`, titled `Suggestion for #7: retry-with-test (2 changes)`, whose single commit edits line 3 of `src/client.ts` and adds `test/client.test.ts`, labeled `suggestion`; then one draft review whose inline comment on `README.md` carries the native suggestion and whose body section links the pull request, lists both changes and presents both findings.

## 4. Decisions awaiting acceptance

1. **Off by default** (§2.1), departing from D22's low-conviction "enabled when omitted". Alternative: D22's default, which changes existing callers' behavior and requirements on upgrade.
2. **Option names** `suggestionPullRequests` / `suggestionLabel` and `--suggestion-prs` / `--suggestion-label` (§2.2). Alternatives: a single `suggestionPullRequests: { label }` object (less uniform with the boolean options), or `companion…` names (the specification's term is "suggestion PR").
3. **Group representation** `properties.sarifToComment.acceptanceGroup` (§2.3), with members holding one change each, at least two distinct changes, and no feedback-only members. Alternatives: a multi-file SARIF fix (a fix structure left to #9), or a run-level group table (indirection without benefit).
4. **Same repository, head-branch target, reviewed-commit parent, refusal of historical reviews, forks and default-branch heads** (§2.5). Alternatives: basing on the current head (would propose against unreviewed code) or accepting any ancestor (needs a comparison read and still proposes a stale diff).
5. **Always draft** suggestion pull requests (§2.5). Alternative: ready pull requests for submitted reviews, which request code-owner reviews and trigger more automation.
6. **Branch prefix and ownership** (§2.6): create once, never update or delete.
7. **Label must exist; the tool never creates it; default name `suggestion`** (§2.7), the name the recorded experiments used. Alternative: create it on demand, which needs label administration rights and turns a typo into a new label.
8. **Structured marker** (§2.7), in the form #6 will parse.
9. **Limits** (§2.8): at most 10 suggestion pull requests per review; bodies at most 60,000 characters; created files at most 1,000,000 bytes.
10. **State layout** (§2.9): a plan file at the state path with one sibling file per claimed step and the unchanged review record beside it. Alternative: a single rewritten file, which cannot claim individual steps exclusively across processes.
11. **Recovery lookup by proposal branch** (§2.10): pull requests are found by their unique head branch and verified by marker, rather than by traversing the original's backlinks first (D28's "SHOULD begin with backlinks"). The branch is unique to the suggestion, so its listing is the narrowest candidate set; neither lookup may establish absence.
12. **Refusal and branch-change outcomes** (§2.9, §2.10): a refused step stops the publication without the review; a changed branch stops before its pull request.

## 5. What cleanup (#6) can rely on

- Every suggestion pull request this tool creates carries the configured label (once its label step completes) and exactly one marker line of §2.7, whose `original` names the original pull request in the same repository. Suggestion-first enumeration can list open pull requests with the label and parse the marker; targeted discovery can start from the original's cross-reference backlinks, which the body's ordinary reference creates.
- The marker, not the title, is the relationship. A labeled pull request without a parseable marker is not one of this tool's suggestions.
- The label may be missing when a publication stopped before its label step, or when a person removed it; such a suggestion is still found from the original's backlinks and its marker.
- Proposal branches are named `sarif-to-comment/suggestions/<pull>/<id>` and are never changed by the tool after creation.
