# Proposals made by hand on the original pull request: live publication

Run at about 06:50 UTC on October 1, 2026, in `mike-north/doc-linter`, on draft pull request [#99](https://github.com/mike-north/doc-linter/pull/99), a fresh fixture between two fixture branches. The product was this repository at commit `22dd832` (built `dist/`, run as `node dist/sarif-to-comment.cjs`), implementing the [delivery policy's §8.10](../../delivery-policy-contract.md#810-proposals-made-by-hand-on-the-original-pull-request). One authenticated account (`mike-north`) made every request.

Under the [evidence policy](../../evidence-policy.md), this record is historical. It is not updated to follow later changes to the fixture.

## Fixture

| Object | Value |
|---|---|
| Base branch | `sarif-original-pr-groups-20261001-base`, created at `0a7b03f` (the default branch's commit at the time; the default branch itself was not changed) |
| Head branch | `sarif-original-pr-groups-20261001-reviewed`, one commit `84c53bd94db0ea6eba5c6d16b590d5d3811a3de3` adding `docs/experiments/original-pr-groups/sample.md` (7 lines) and `obsolete.md` |
| Pull request | #99, open draft, base → head above |
| Delivery configuration | none on the default branch: every dimension the caller did not set is the default |

## What was written

Two new branches, the draft pull request #99, and exactly one review: the pending review **5375833995**, created by `publish` with no `--submit`. It was left pending. Nothing was submitted, applied, merged or closed. The default branch was not touched, and nothing was cleaned up.

## The document

[`review.sarif`](review.sarif) holds five findings, run bound to `84c53bd`:

- the group `guide-move`, with four changes: the creation of `guide.md`, whose content contains a fenced `sh` block; an edit of `sample.md` line 5; an edit of `sample.md` line 7; and the deletion of `obsolete.md`. Under the default `fileOperations: [manual]`, it is the **mixed manual group**.
- an ungrouped edit of `README.md` line 5, a file outside the pull request's diff. Its replacement is five lines that contain a fenced block. It was published with `--edits native,review-body`, so it is an **edit made by hand** in the review body, after an announced fallback.

## Commands

The token was passed inline from `gh auth token` with `GITHUB_TOKEN` unset. It was never printed or saved.

1. `sarif-to-comment validate --sarif review.sarif --repo mike-north/doc-linter --pull 99 --commit 84c53bd… --edits native,review-body --format json`: exit 0, `ready`, "0 inline comment(s) and 2 general section(s)" ([`validate.json`](validate.json)). It reports one `delivery-fallback` warning. The README edit is delivered as `review-body` because `native` is unavailable: ``GitHub applied a nested ``` suggestion as a deletion; this replacement cannot be a native suggestion.``
2. `sarif-to-comment publish` with the same arguments and `--state`: exit 0, `published`, review 5375833995, the same warning ([`publish.json`](publish.json), with the local state path redacted). The publication state, including the exact request sent and the recorded policy (`edits` `[native, review-body]` from the caller, the rest from the defaults), is [`state.json`](state.json).
3. Readback with GETs only:
   - `GET …/pulls/99/reviews/5375833995` ([`review-5375833995.json`](review-5375833995.json));
   - the same with `Accept: application/vnd.github.full+json`, for GitHub's rendered HTML ([`review-5375833995-full.json`](review-5375833995-full.json));
   - `GET …/pulls/99/reviews/5375833995/comments` ([`review-5375833995-comments.json`](review-5375833995-comments.json)).

A local steering hook stops each new `gh api` command on its first run. Each command was rerun unchanged with the reason "bounded doc-linter fixture verification". No command was routed around the hook.

## Result

| Check | Readback |
|---|---|
| Review | 5375833995, `PENDING`, `commit_id` `84c53bd…` |
| Inline comments | none (`[]`): neither form is a suggestion, and no member of the group is an inline comment |
| Body | identical to the body sent (the request recorded in `state.json`), ending with the publication marker |
| Suggestion blocks | none: the body has no `` ```suggestion `` line, and the rendered HTML has no code block with a language. The word "suggestion" appears only in prose ("Suggestion group …", "They are not offered as suggestions, …") |
| Group guidance | one section opening ``**Suggestion group `guide-move`:** apply these 4 changes together, by hand, in one commit: …``, whose member lines are, in order: `guide.md`: new file; `sample.md` line 5; `sample.md` line 7; `obsolete.md`: file deletion |
| Group parts | four labels ``**Suggestion group `guide-move` — change N of 4**``, N = 1…4. Each is followed by its change: the file-operation contract's creation section, two manual edits with their quoted findings, and the deletion section |
| Edit made by hand | a second section, ``**Proposed edit, to make by hand:** replace [README.md line 5 at 84c53bd](…/blob/84c53bd…/README.md#L5) with:``, then its block and the finding with its quote |

**Exact bytes, as GitHub rendered them.** Each `<pre>` element in `body_html` was read, with tags removed and entities decoded. In order:

1. `guide.md`'s content, `# Guide\n\nRun the checks:\n\n```sh\nnpm test\n```\n`. This is the proposed file exactly. The tool's four-backtick fence held the inner three-backtick fence.
2. The replacement of `sample.md` line 5: `Steps live in [the guide](guide.md).\n`. The link is literal, not rendered.
3. The quote of `sample.md` line 5 at the reviewed commit.
4. The replacement of `sample.md` line 7.
5. The quote of `sample.md` line 7.
6. The quote of `obsolete.md` line 1.
7. The README replacement: `What it does today. Try it with:\n\n```sh\nnpx doc-linter assess --help\n```\n`. These are the five replacement lines exactly, inside a four-backtick fence.
8. The quote of README line 5.

Each `<pre>` text equals the shown lines plus the final newline GitHub's renderer adds to every code block. That is the replacement or file's own final newline, since none of these lacks one, so no `DETAILS` were stated.

## Establishes

- Live GitHub accepts and stores, as one pending review with no inline comments, a mixed manual group (creation, two edits and deletion) and an edit made by hand, exactly as composed.
- GitHub's renderer shows each proposal's content blocks with the exact bytes the tool proposes, including content that holds its own fenced code. Nothing in either form renders as a suggestion.
- The announced fallback from `native` to `review-body` behaves on live GitHub as the contract says.

## Does not establish

- **The web interface.** The browser tools were not available to the agent that ran this check, so the GitHub UI was not inspected here. `body_html` is GitHub's own rendering of the body, but it is not a view of the page. A later browser check of the same pending review is recorded in [`ui-check.md`](ui-check.md). It found that line permalinks into Markdown files opened the rendered preview, which has no line anchors; line permalinks now add `?plain=1`. The links in this record are historical, from before that change.
- **Manual assembly.** Whether an author can assemble the group locally and commit it once is not shown. Nothing was applied.
- **Other content.** CRLF or missing-final-newline details, other content shapes, the body size limit, forks and other accounts were not run live. Each is covered against the simulated host only.
