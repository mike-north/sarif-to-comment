# Suggestion pull request convention

**Version 2** · September 29, 2026 · Owner-accepted in [issue #27](https://github.com/mike-north/sarif-to-comment/issues/27) ([D41](design-decisions.md#d41-the-suggestion-pull-request-convention-and-options--owner-decisions)). Version 2 adds suggestions re-applied after the original's history was rewritten (§5.1), the owner's decision on [issue #28](https://github.com/mike-north/sarif-to-comment/issues/28) ([D42](design-decisions.md#d42-test-ancestry-when-the-originals-branch-has-moved--owner-decision)), based on the [force-push experiment](force-push-experiment.md). The details listed under [Open questions](#10-open-questions) are proposals awaiting the owner.

A **suggestion pull request** proposes a change to someone else's pull request as a pull request of its own, into that pull request's branch. This document defines how such pull requests look on GitHub, so that any tool can create them, find them and tidy them up, and so that a person looking at one sees only a suggestion. Nothing in it depends on SARIF or on any particular tool. sarif-to-comment implements it: `publish` creates suggestion pull requests ([companion contract](companion-suggestion-pr-contract.md)) and `close-suggestion-prs` closes them ([cleanup contract](suggestion-cleanup-contract.md)).

The key words MUST, MUST NOT, SHOULD and MAY are used as in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. Terms

- **Original pull request**: the pull request under review, numbered `N`, in repository `OWNER/REPO`.
- **Suggestion pull request**: a pull request that proposes a change to the original, following this convention.
- **Producer**: a tool that creates suggestion pull requests. **Consumer**: a tool that finds or acts on them (for example, one that closes them once their original has ended).
- **Canonical label**: the one label every suggestion pull request of a repository carries (§3).
- **Batch**: the suggestions produced together by one review.

## 2. When a suggestion pull request is used

> **September 30, 2026 note.** This section describes the current implemented behavior. The owner's decisions [D48–D60](design-decisions.md#owner-decisions-of-september-30-2026-delivery-policy-and-the-force-push-boundary) set a different target: [D48](design-decisions.md#d48-make-publication-policy-caller-controlled--accepted-product-direction-implementation-design-open) lets a caller of this tool request companion pull requests for every proposed change, including changes that a native suggestion could represent. The guidance below matches the tool's implemented behavior. What makes a pull request a suggestion pull request under this convention does not change. Implementing that target is pending; until then, the behavior below is what the tool does.

A suggestion pull request is for a change that GitHub's native review suggestions cannot represent safely: a whole-file creation or deletion, or several edits that must be accepted together. A change a native suggestion represents faithfully SHOULD be offered as a native suggestion instead. This section is guidance for producers; consumers do not depend on it.

## 3. The canonical label

The canonical label is the `label` of the repository configuration (§4) when present, otherwise **`suggestion-pr`**. The default avoids colliding with labels such as a product-suggestion label.

- Every suggestion pull request MUST carry the canonical label. Consumers confirm a suggestion pull request by it, and may list a repository's suggestion pull requests by it (§9).
- A producer MAY add further labels (for example a team or campaign tag). They carry no meaning under this convention.
- Every label a producer applies MUST already exist in the repository. Producers MUST NOT create labels: a missing label is a reason not to create the suggestion, so that a typo can never create a stray label and label administration stays with the repository.
- There is no per-call override of the canonical label. It is a repository-wide convention, and consumers depend on it.
- Label names compare case-insensitively, as GitHub treats them.

**Label names.** A label name used under this convention (canonical or extra) is 1–50 characters (UTF-16 code units), with no control or invisible formatting characters (U+0000–U+001F, U+007F–U+009F, U+FEFF, U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069, U+2028, U+2029), no leading or trailing whitespace, and **no comma**. GitHub's label filter reads a comma as a list of labels, so a label with a comma could never be selected on its own.

## 4. Repository configuration

A repository MAY choose another canonical label with the file **`.github/suggestion-prs.json`**:

```json
{ "label": "suggestion-pr" }
```

- The file is read from the **current commit of the repository's default branch**, never from a pull request's branch, so a pull request cannot change its own label.
- It is optional, read-only and maintained by hand. Tools MUST NOT write it, and no tool state is kept in the repository.
- It MUST be a regular file holding UTF-8 JSON (a leading byte-order mark is allowed) whose value is an object. `label`, when present, MUST be a string that is a valid label name (§3). Other members are ignored, so that later versions can add members.

A tool reading it MUST treat each state exactly as follows:

| State of the file | Canonical label |
| --- | --- |
| Absent from the default branch | `suggestion-pr` |
| An object without `label` | `suggestion-pr` |
| An object whose `label` is a valid label name | that label |
| Not valid UTF-8 or JSON; JSON that is not an object; `label` not a string; `label` empty, containing a comma, or otherwise not a valid label name; a directory, symbolic link or submodule at that path, or a symbolic link or submodule on the way to it (never followed) | **invalid**: a producer creates nothing and reports the problem naming the file and the field; a consumer refuses to act |
| Could not be read (network failure, HTTP 403, 5xx, a malformed answer) | **unknown**: the operation stops as incomplete or failed. A failed read is never treated as a missing file. |

## 5. The branch

A suggestion pull request's head branch is:

```text
suggestion-pr/<original pull number>/<id>
```

in the original's repository, where `<id>` is the suggestion's identifier from its marker (§7).

- The branch holds exactly one commit, so the pull request's changes are exactly the suggested change. Its parent is the commit the suggestion was proposed on: the commit that was reviewed (the marker's `reviewedCommit`), or, for a suggestion re-applied after the original's history was rewritten (§5.1), the marker's `reappliedOnto`.
- A producer creates each branch once and MUST NOT update, force-push or delete it afterwards. People may push to it; producers never overwrite their changes.
- Consumers close pull requests only. Deleting a branch is left to people, or to GitHub's automatic deletion of merged branches.

### 5.1 When the original's branch has moved since the review

> **September 30, 2026 note.** This section describes the current implemented behavior. The owner's decisions [D48–D60](design-decisions.md#owner-decisions-of-september-30-2026-delivery-policy-and-the-force-push-boundary) set a different target: [D58](design-decisions.md#d58-do-not-abort-historical-review-publication-merely-because-the-pr-branch-changes--owner-selected-force-push-direction) keeps feedback about the explicitly reviewed commit when the branch moves, and does not authorize automatic re-application or rebasing of proposals. [D59](design-decisions.md#d59-treat-force-push-review-lifecycle-as-host-behavior-not-a-new-publisher-service--owner-selected-boundary) treats a companion that would unintentionally include discarded changes as a proposal-fidelity issue to investigate as such, rather than a rule keyed to branch movement. Re-application, and version 2 markers naming `reappliedOnto`, are therefore not the target direction for this tool. The convention's rule never to propose a suggestion on a discarded commit records the [force-push experiment](force-push-experiment.md)'s observations, which the [behavior register](github-behavior.md) keeps as GH-14. Implementing that target is pending; until then, the behavior below is what the tool does.

A producer tests **ancestry, not equality**: when the reviewed commit is not the original's current head, it asks whether the reviewed commit is still an ancestor of that head.

- **The branch only moved forward** (the reviewed commit is an ancestor of the head): the suggestion is proposed on the reviewed commit, as usual. GitHub shows its own changes, and any conflict with the later commits, to the person accepting it.
- **The history was rewritten** (a force-push, amend or rebase left the reviewed commit out of the branch): a producer MUST NOT propose a suggestion on the reviewed commit. GitHub would list the discarded commit in the suggestion pull request, repeat its diff, and could report it mergeable while merging it would silently restore changes the author had removed ([experiment](force-push-experiment.md)). For each suggestion instead:
  - **re-apply** its change onto the head, as read when the suggestion is planned, but only if everything the change touches is byte-identical there to what was reviewed: every replaced range of an edited file holds exactly the reviewed bytes, at the same lines; a file to be created is still absent; a file to be deleted is still present, with the reviewed content and mode. The re-applied suggestion's marker has version 2 and names that head as `reappliedOnto` (§7);
  - otherwise **do not create** it, never proposing it on the reviewed commit instead, and state why. What the producer publishes in its place is its own policy; for example, this tool presents the change exactly as it would without suggestion pull requests, and refuses the review when that cannot keep a group's changes together ([companion contract §2.5.1](companion-suggestion-pr-contract.md#251-re-application-after-a-rewritten-history)).
- A re-application is a snapshot of the head it was made on. The head may be rewritten again afterwards; a producer never chases it, and never updates the branch (§5).

## 6. The pull request

| Part | Convention |
| --- | --- |
| Repository | The original's repository (§9). |
| Base | The original's head branch. |
| Head | The branch of §5. |
| Draft | A draft by default. A producer MAY create it ready for review when its caller asks. |
| Title | Neutral, beginning `Suggestion for #N: ` followed by a short summary. Consumers MUST NOT rely on the title. |
| Body | Begins `Suggested in a review of #N at commit SHA.`, where SHA is the full reviewed commit. A re-applied suggestion (§5.1) SHOULD then say which commit it was re-applied onto, and why. It SHOULD then say what merging applies, and SHOULD include a brief note of the lifecycle (§8). Its last line is the marker (§7). |
| References | The body references the original only with an ordinary `#N` reference, never with a closing keyword. The original pull request's description is never edited. |
| Labels | The canonical label, and any extra labels (§3). |

The `#N` reference makes GitHub record a cross-reference on the original, which consumers can follow back from the original to its suggestions.

## 7. The marker

The body's last line is a hidden marker. A suggestion proposed on the reviewed commit carries a **version 1** marker:

```text
<!-- suggestion-pr {"version":1,"original":{"owner":"OWNER","repo":"REPO","pullNumber":N},"reviewedCommit":"SHA","id":"ID","batch":"BATCH"} -->
```

A suggestion re-applied onto a later commit after the original's history was rewritten (§5.1) carries a **version 2** marker, which adds `reappliedOnto`:

```text
<!-- suggestion-pr {"version":2,"original":{"owner":"OWNER","repo":"REPO","pullNumber":N},"reviewedCommit":"SHA","reappliedOnto":"SHA","id":"ID","batch":"BATCH"} -->
```

A producer writes version 1 whenever the suggestion was not re-applied, so that version-1 consumers keep working for it, and version 2 only for a re-applied one.

- The line is `<!-- suggestion-pr `, a JSON object, and ` -->`, with nothing else on the line.
- The JSON is **canonical**: exactly the members shown for its version, in exactly this order (`version`, `original` with `owner`, `repo`, `pullNumber`, then `reviewedCommit`, for version 2 `reappliedOnto`, then `id`, `batch`), with no whitespace. Every value below is plain ASCII that JSON writes without escapes, so the line is a pure function of its values.

| Member | Value |
| --- | --- |
| `version` | `1`, or `2` for a re-applied suggestion |
| `original.owner`, `original.repo` | The original's repository: GitHub names of letters, digits, `.`, `_` and `-` (never `.` or `..`). |
| `original.pullNumber` | The original's number, a positive integer. |
| `reviewedCommit` | The full commit the review was about, 40 lowercase hexadecimal digits. In version 1, the parent of the branch's commit. |
| `reappliedOnto` | Version 2 only, and required there: the full commit the change was re-applied onto (the original's head when the suggestion was planned), 40 lowercase hexadecimal digits, different from `reviewedCommit`: the parent of the branch's commit. |
| `id` | The suggestion's identifier, also in its branch name: 1–64 characters of letters, digits, `-` and `_`, beginning and ending with a letter or digit. It MUST be unique among the suggestions of its original; a random UUID is RECOMMENDED. |
| `batch` | An opaque identifier grouping the suggestions of one review, in the same alphabet as `id`. Consumers MUST NOT interpret it. |

No value can contain `>`, so the marker never ends early. It is metadata, not a secret.

**Recognition.** A consumer reads the body line by line, ignoring one trailing carriage return per line (GitHub may store an edited body with CRLF):

- no line begins with `<!-- suggestion-pr ` → no marker;
- more than one such line (for example a quoted marker) → not recognized, never guessed at;
- exactly one such line → it MUST be canonical for its version, byte for byte, with every value valid. Anything else, including a version the consumer does not know, a version 1 marker with `reappliedOnto` or a version 2 marker without it, is not recognized.

A person may edit the rest of the body or add text after the marker; the marker may therefore appear on any line. A pull request whose marker is not recognized is not a suggestion pull request under this version.

## 8. Lifecycle

1. A suggestion branch is created from the reviewed commit, or from the original's head when the change is re-applied after a rewritten history (§5.1), and the change is committed (§5).
2. A draft pull request is opened into the original's head branch (§6).
3. **Someone with write access marks it "Ready for review".** A draft cannot be merged. A suggestion created ready for review starts here.
4. The original's author merges it, or not. The original pull request then carries the change to its own base.
5. Once the original has been merged or closed, its open suggestion pull requests can be closed (§9).

## 9. Conformance, and acting on suggestion pull requests

A pull request **conforms** to this convention when, read fresh from GitHub:

- its body has exactly one recognized marker (§7);
- its repository, its head branch's repository and the marker's `original` repository are the same repository (names compared case-insensitively);
- its head branch is exactly `suggestion-pr/<original.pullNumber>/<id>` from its marker;
- no other open pull request carries a marker with the same `id` for the same original.

Consumers act only on conforming pull requests, whichever tool produced them. A consumer that closes suggestions:

- finds them by listing the open pull requests of the branches under `suggestion-pr/` (§5) and confirming the canonical label, by listing open pull requests with the canonical label, or by following the cross-references of one original. Listing the branch namespace keeps the cost proportional to suggestion branches, however many other pull requests share a label;
- closes a suggestion only after positively reading its original as merged or closed (a failed or unauthorized read is never evidence that it ended), and after reading the suggestion again and finding it still open, still conforming, and still carrying the canonical label;
- never deletes or updates a branch, and never edits a body, title or label.

**Scope.** In versions 1 and 2, suggestion pull requests are defined for originals whose head branch is in the repository itself (not a fork) and whose base is the repository's default branch. Other bases and forks are not yet covered; a possible later route for forks is a pull request from the reviewer's fork into the original fork's branch.

## 10. Open questions

> **September 30, 2026 note.** This section describes the current implemented behavior. The owner's decisions [D48–D60](design-decisions.md#owner-decisions-of-september-30-2026-delivery-policy-and-the-force-push-boundary) set a different target: questions 5 and 6 concern re-application, which [D58](design-decisions.md#d58-do-not-abort-historical-review-publication-merely-because-the-pr-branch-changes--owner-selected-force-push-direction) and [D59](design-decisions.md#d59-treat-force-push-review-lifecycle-as-host-behavior-not-a-new-publisher-service--owner-selected-boundary) no longer target. They stay listed because the implemented behavior still depends on them.

These details are proposals of this document, awaiting the owner's decision:

1. **The alphabet of `id` and `batch`** (§7): 1–64 letters, digits, `-` and `_`. It keeps the branch name a valid Git reference and the marker free of escapes; UUIDs fit.
2. **The member order** of the canonical marker (§7) follows the order the owner's decision lists the members in, rather than sorted keys.
3. **Unknown members of `.github/suggestion-prs.json` are ignored** (§4), so later versions can add members; the cost is that a misspelled `label` silently leaves the default in place.
4. **Label creation by GitHub.** GitHub's "add labels to an issue" endpoint is reported to create a label that does not exist (for example [hub#1906](https://github.com/mislav/hub/issues/1906)); this was not probed live. Producers check every label before any write, but a label deleted between that check and the write would be recreated.
5. **Where a replaced range is compared** (§5.1): at the same line numbers on the head. A range that only moved (lines were added or removed above it) is treated as changed, and the suggestion is not created; it is never relocated by searching for its text, which could pick the wrong occurrence.
6. **Versioning re-application** (§7, §11): a new marker version with a required `reappliedOnto`, rather than an optional member of version 1, so that a version-1 consumer, which cannot know that the branch is not based on the reviewed commit, does not recognize a re-applied suggestion at all.

## 11. Versioning

The marker's `version` names the version of this convention a suggestion pull request follows. A change to the marker, branch or label rules that an earlier consumer would misread requires a new version; a consumer never acts on a marker of a version it does not know. Additions that earlier readers can ignore (for example a new member of the repository configuration) do not.

**Version 2** (issue #28) adds the re-applied suggestion: its branch's commit is based on `reappliedOnto`, not on the reviewed commit (§5, §5.1). A version-1 consumer does not recognize a version-2 marker, so it leaves a re-applied suggestion alone rather than misreading it; every suggestion that was not re-applied still carries a version-1 marker, which version-1 consumers keep acting on. A version-2 consumer recognizes both versions.
