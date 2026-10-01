---
"sarif-to-comment": minor
---

**Suggestion pull requests.** A proposed change can now be offered as its own small pull request into the reviewed pull request's branch, a *companion* of the review, instead of in the review itself. Nothing changes unless you ask for it: the default delivery lists never name `companion` (see the delivery policy entry). List it for the proposals you want, for example `--file-operations companion`, `--grouped-edits companion`, `--edits native,companion`, or every proposal with `--delivery companion`.

- **What is created.** Each proposal delivered by `companion` (a whole-file creation or deletion, a suggestion group, a fix with several changes, or an edit) becomes one pull request from a new branch `suggestion-pr/<pull>/<id>` into the original pull request's head branch. It has one commit whose parent is the reviewed commit, a title such as `Suggestion for #7: create docs/new.md`, a description that names the reviewed commit, lists the changes and their findings and says how the suggestion is accepted, and the repository's suggestion label. It refers to the original without a closing keyword. It is a draft unless you pass `--mark-suggestion-prs-ready` (`markSuggestionPullRequestsReady`). `--pr-labels A,B,C` (`pullRequestLabels`) adds existing labels. With `--companion-bundle single` (`companionBundle: 'single'`), every proposal delivered by `companion` goes into one pull request, each in its own section; alternatives are never bundled.
- **A tool-neutral convention.** What GitHub shows names neither SARIF nor this tool, so any tool can create or tidy up such pull requests. The canonical label is `suggestion-pr`, unless the repository names another in an optional, hand-maintained `.github/suggestion-prs.json` (`{ "label": "…" }`) on its default branch. `publish`, `validate` and `close-suggestion-prs` resolve it the same way; an invalid file blocks, and a file that cannot be read is an error, never a silent default. Each description ends with a hidden `<!-- suggestion-pr {…} -->` marker that names the original. Every label must already exist; the tool never creates one.
- **The review indexes them.** A review with suggestion pull requests begins with an index of them, each with its link, its title (a code span, with any invisible or bidirectional character shown as a visible `{U+XXXX}` escape) and whether it was created with this review or reused. Each created one also keeps its own section of the review, with its changes and findings. A later review can list existing ones with `--existing-companion N`, repeated for several (`existingCompanions`): each is read once, before anything is written, and must be a suggestion pull request of this pull request under the convention, otherwise the review is blocked with `companion-not-reusable` (exit status 2). Its state (open, a draft, closed or merged) is reported in a `companion-reused` note and never enforced, and nothing you name is changed.
- **Checked before anything is written.** The group rules, conflicts between proposals, at most 10 suggestion pull requests per review (`too-many-suggestion-prs`, whose remedy names `--companion-bundle single` first), push permission, and that every label exists. `validate` reports the same outcome. For a pull request from a fork, or into a base other than the default branch, suggestion pull requests are not yet supported: each proposal goes to the next mechanism of its delivery list, or the review is blocked. The release acceptance recorded this live: on a pull request into another base, `validate` blocked a group that no other listed mechanism could deliver, exit status 2, before anything was written (`docs/evidence/release-acceptance/`, run B1, in the source repository).
- **Durable and never duplicated.** Each commit, branch, pull request and labels step is recorded beside the state file before it is sent, and is never sent twice. A retry finds a pull request whose response was lost by its branch and marker, continues the steps never sent, and never repairs what a person changed since.
- **After the branch moved.** When the branch only moved forward, suggestion pull requests are created on the reviewed commit as usual. When a force-push, amend or rebase left the reviewed commit out of the branch, they are still created on the reviewed commit and are never re-applied or rebased. Because GitHub then shows them from an older merge base, `publish` and `validate` first project what merging each one into the current head would do, file by file, from GitHub's trees and blobs, with a merge that follows Git's (histogram diffs; changes that overlap or touch conflict). It is labelled a projection everywhere, because it is not a merge GitHub performed:
  - **Faithful:** it is created. Its description says that the reviewed commit is not part of the branch and shows its own changes as a diff, separately from GitHub's. A character a code block does not show is written there as a visible `{U+XXXX}` escape, and a note says so; a change of line endings is stated on its hunk (`CRLF line endings become LF line endings`); the commit has the exact bytes.
  - **Conflicts**, and nothing worse: it is created, with a `companion-conflicts-at-head` warning naming the files. GitHub's `mergeable` is then read back, waiting up to about ten seconds while GitHub computes it, and reported beside the projection.
  - **Unfaithful:** merging it would bring back content the head no longer has, remove a file the head kept, or lose part of the suggestion; the suggestion cannot be expressed at the head; or the projection cannot decide (for example a truncated tree, a binary file changed on both sides, a merge driver in `.gitattributes`, or a directory-rename trigger). Its pull request is not made: the proposal goes to the next mechanism of its delivery list with a `delivery-fallback` warning, or the review is blocked with `delivery-unavailable`.

  The projection is made once, when the publication is planned, and recorded. A retry never projects again, and says when the head has moved since. Rename detection, more than one merge base and `.gitattributes` beyond merge drivers are not modelled.
- **Outcome.** A published outcome lists them in `suggestions` (`number`, `url`, `branch`, and `mergeable` for one projected to conflict), and its Markdown lists them after the review link.

Close them once their original has ended with the new `close-suggestion-prs` command (see its entry).

### `sarif-to-comment validate --delivery companion` (new)

```text
## Ready to publish

The complete document can be published faithfully to octo/widgets#7 at commit `c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1`.

Publication would also create 3 draft suggestion pull requests into `feature/retry`, labeled `suggestion-pr`.

**Review prepared:** 0 inline comment(s) and 4 general section(s) for commit `c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1`.
```

### `sarif-to-comment publish --delivery companion` (new)

stdout:

```text
## Draft review published

Created the draft [review 5000](https://github.com/octo/widgets/pull/7#pullrequestreview-5000) on octo/widgets#7 at commit `c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1`. It stays a draft until someone submits it on GitHub.

Suggestion pull requests (drafts into `feature/retry`, labeled `suggestion-pr`):

- [#101](https://github.com/octo/widgets/pull/101) from `suggestion-pr/7/f55322c3-6f99-4642-ad72-aeb378065d3d`
- [#102](https://github.com/octo/widgets/pull/102) from `suggestion-pr/7/dde025bf-075a-4f91-abda-9430c103dc7e`
- [#103](https://github.com/octo/widgets/pull/103) from `suggestion-pr/7/4c9d7c03-b15b-4c78-ab60-3db71cd0ab08`
```

The start of the review body:

```markdown
**Companion pull requests of this review:**

- [#101](https://github.com/octo/widgets/pull/101): `Suggestion for #7: reword (2 changes)` — created with this review
- [#102](https://github.com/octo/widgets/pull/102): `Suggestion for #7: create docs/new.md` — created with this review
- [#103](https://github.com/octo/widgets/pull/103): `Suggestion for #7: delete obsolete.txt` — created with this review

---

**Suggestion pull request:** [#101](https://github.com/octo/widgets/pull/101)

Merging it into `feature/retry` applies these 2 changes together:
```

### `sarif-to-comment validate --grouped-edits companion` after a force-push (new)

stdout:

```text
## Ready to publish

**Ready to publish with 1 warning:** A suggestion pull request is projected to conflict with the pull request's head.

The complete document can be published faithfully to octo/widgets#7 at commit `c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1`.

Publication would also create 1 draft suggestion pull request into `feature/retry`, labeled `suggestion-pr`. The history of #7 was rewritten after the reviewed commit, so it is proposed on that commit and was projected onto the head `a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1`: merging it would conflict.
```

stderr:

```text
▲ warning  A suggestion pull request is projected to conflict with the pull request's head  [companion-conflicts-at-head]
  /runs/0/results/0
  Projected onto the head `a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1` of #7, merging the suggestion pull request for the group `reword` would conflict in `docs/sample.md`. It is created on the reviewed commit, as planned; GitHub shows the conflict to whoever merges it.
  → Review the pull request's current head again, and publish that review.
  → Or resolve the conflict when merging the suggestion pull request.

1 warning
```
