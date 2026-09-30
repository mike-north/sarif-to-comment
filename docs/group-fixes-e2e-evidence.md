# Grouping fixes for joint acceptance: live GitHub evidence

Recorded September 29, 2026 in the private fixture repository `mike-north/doc-linter`, against the implementation of [#29](https://github.com/mike-north/sarif-to-comment/issues/29) ([companion contract §2.3, §2.4 and §2.12](companion-suggestion-pr-contract.md#23-groups-a-fix-with-several-changes-and-explicit-groups)). The built package ran from the working tree (`node dist/sarif-to-comment.cjs`) with the maintainer's personal token. Nothing was published to npm, nothing was merged, and `main` was not touched. Sanitized outputs are in [`evidence/group-fixes/`](evidence/group-fixes/) (local paths replaced by `<work>`); every step's exit status is in [`exit-statuses.txt`](evidence/group-fixes/exit-statuses.txt), and every JSON output parsed as one document, so no step wrote to stderr.

## What this covers

| #29 acceptance item | Live | Elsewhere |
| --- | --- | --- |
| A grouped change across findings, as one suggestion pull request | Original A, steps A1–A8 | `test/companion-composition.test.mts`, `test/installed-companion.test.mts` |
| A native multi-file fix, as one suggestion pull request | Original B, steps B1–B5 | `test/companion-composition.test.mts` (several files, several replacements of one file, two on one line, overlap refused), `test/installed-companion.test.mts` |
| An agent-style inspect → group → publish flow | Steps A2–A7, with the CLI | `test/installed-companion.test.mts` (installed CLI and library) |
| Refusal naming `--allow-suggestion-prs` when disallowed (A30) | Steps A5, B2, B3 | `test/companion-composition.test.mts` |
| Selector staleness | Step A4 | `test/suggestion-groups.test.mts`, `test/cli-suggestion-groups.test.mts` |

## Fixtures

Two originals were created for this evidence: a branch from `main` adding Markdown pages under `docs/experiments/sarif-issue29/`, pushed, and a draft pull request into `main` (the supported scope). The pull request list and every branch head were recorded after they were created and before the first run.

| Object | Identity | Reviewed commit |
| --- | --- | --- |
| Original A | [#60](https://github.com/mike-north/doc-linter/pull/60), head `sarif-issue29-20260929-a`, adds `a-guide.md` | `ea29b3d4966ca71eabdcc422607ffe4dfd7d7177` |
| Original B | [#63](https://github.com/mike-north/doc-linter/pull/63), head `sarif-issue29-20260929-b`, adds `b-guide.md` and `b-reference.md` | `72b43d6f6f51d2bed9d8af061daf882932bf8fb2` |

## Original A: a grouped change across findings

The staged change on #60 fixes a typo on line 5 of `a-guide.md`, turns "the checklist" on line 7 into a link to `a-checklist.md`, and creates that checklist. The link and the new page only make sense together; the typo stands alone.

1. **Author** (`init`, three `add-comment`s, `add-staged-changes`): three findings, each explained by its own staged change: the line-5 edit, the line-7 edit and the creation ([`a.grouped.sarif.json`](evidence/group-fixes/a.grouped.sarif.json) is the document after step 3).
2. **Inspect** (`inspect --format json`): the agent reads the selectors of the link finding and the checklist finding, `/runs/0/results/1@139ba80f10af77d9` and `/runs/0/results/2@139ba80f10af77d9`.
3. **Group** ([`a07-group.json`](evidence/group-fixes/a07-group.json)): `group-fixes --finding … --finding … --group checklist-link`, exit 0, `grouped`, two members with one change each, `changes: 2`. The file was edited in place; each member now carries `properties.sarifToComment.suggestionGroup: "checklist-link"`, and the typo finding carries nothing.
4. **Stale selector** ([`a08-group-stale-human.txt`](evidence/group-fixes/a08-group-stale-human.txt)): the same command again, with the selectors taken before step 3: exit 2, ``The document has changed since the selector `/runs/0/results/1@139ba80f10af77d9` was taken from inspecting it, … Inspect the document again and use its current selectors.``, and the file was not changed.
5. **Inspection shows the group** ([`a09-inspect-human.txt`](evidence/group-fixes/a09-inspect-human.txt)): `Finding /runs/0/results/1 — Review agent · suggestionGroup: checklist-link`, the same for result 2, and no group on result 0.
6. **Disallowed** ([`a10-validate-disabled.json`](evidence/group-fixes/a10-validate-disabled.json)): `validate` without the setting: exit 2, `blocked`, the single problem ``suggestion-group-requires-suggestion-prs`` at `/runs/0/results/1`, naming `--allow-suggestion-prs`.
7. **Allowed** ([`a11-validate-enabled.json`](evidence/group-fixes/a11-validate-enabled.json), [`a12-publish.json`](evidence/group-fixes/a12-publish.json)): `validate --allow-suggestion-prs`: ready, ``Publication would also create 1 draft suggestion pull request into `sarif-issue29-20260929-a`, labeled `suggestion-pr`.`` with 1 inline comment and 1 general section. `publish --allow-suggestion-prs`: exit 0, `published`: the draft review [5361645031](https://github.com/mike-north/doc-linter/pull/60#pullrequestreview-5361645031) and [#72](https://github.com/mike-north/doc-linter/pull/72).
8. **Read-back** ([`a13-readback-72.json`](evidence/group-fixes/a13-readback-72.json), [`a14-proposal-commit.txt`](evidence/group-fixes/a14-proposal-commit.txt), [`a12-review-request.json`](evidence/group-fixes/a12-review-request.json)):
    - #72: open draft into `sarif-issue29-20260929-a`, labeled `suggestion-pr`, titled `Suggestion for #60: checklist-link (2 changes)`; its body says ``Merging this pull request into `sarif-issue29-20260929-a` applies these 2 changes together:`` and lists the line-7 edit and the new file, then both findings.
    - Its single commit has the reviewed commit as its only parent and changes exactly the two paths: `a-checklist.md` byte-identical to the staged file, and `a-guide.md` with only line 7 replaced (its blob equals the reviewed file with that one line changed; the line-5 typo is not in the pull request).
    - The review request sent to #60 has one inline comment on line 5 carrying the native suggestion `The client retries once on a timeout.`, and a body section linking #72. The ungrouped typo stayed a native suggestion (the review is pending, so GitHub shows it only to its author; the request is the tool's saved record).

## Original B: a native multi-file fix

The SARIF ([`b.sarif.json`](evidence/group-fixes/b.sarif.json)) is written as an upstream linter would: one finding on line 3 of `b-guide.md` whose single fix replaces lines 3 and 5 of `b-guide.md` and line 5 of `b-reference.md` (three replacements, two files). It carries no group property.

1. **Inspect**: one finding, one fix with both artifact changes.
2. **Disallowed** ([`b02-validate-disabled.json`](evidence/group-fixes/b02-validate-disabled.json)): `validate`: exit 2, ``fix-changes-require-suggestion-prs`` at `/runs/0/results/0`: ``The fix makes 3 changes that apply together (a SARIF fix is accepted whole), which needs a suggestion pull request. Enable suggestion pull requests (options.allowSuggestionPullRequests or --allow-suggestion-prs); a fix is never split into separate suggestions or published in part.``
3. **Publish parity** ([`b03-publish-disabled.json`](evidence/group-fixes/b03-publish-disabled.json)): `publish` without the setting: exit 2, the identical Markdown, and no state file written.
4. **Allowed** ([`b04-validate-enabled.json`](evidence/group-fixes/b04-validate-enabled.json), [`b05-publish.json`](evidence/group-fixes/b05-publish.json)): ready with 1 draft suggestion pull request, 0 inline comments and 1 general section; `publish --allow-suggestion-prs`: exit 0: the draft review [5361651490](https://github.com/mike-north/doc-linter/pull/63#pullrequestreview-5361651490) and [#73](https://github.com/mike-north/doc-linter/pull/73).
5. **Read-back** ([`b06-readback-73.json`](evidence/group-fixes/b06-readback-73.json), [`b08-proposal-commit.txt`](evidence/group-fixes/b08-proposal-commit.txt)): #73 is an open draft into `sarif-issue29-20260929-b`, labeled `suggestion-pr`, titled `Suggestion for #63: 3 changes`; its body lists the three edits (`b-guide.md` lines 3 and 5, `b-reference.md` line 5) as ``these 3 changes together``, then the finding with its level, fix description and rule. Its single commit, parented on the reviewed commit, changes exactly those three lines in the two files. The review on #63 is pending, and its body begins with the section linking #73.

## Live artifacts

Every artifact these runs created, all left in place ([`99-branches.diff`](evidence/group-fixes/99-branches.diff) compares the branch listing before and after the runs):

| Artifact | Change | By |
| --- | --- | --- |
| Branches `sarif-issue29-20260929-a` (`ea29b3d…`) and `sarif-issue29-20260929-b` (`72b43d6…`) | created from `main` | `git push`, fixture setup |
| [#60](https://github.com/mike-north/doc-linter/pull/60) (original A), [#63](https://github.com/mike-north/doc-linter/pull/63) (original B) | opened as drafts into `main`; still open | `gh pr create`, fixture setup |
| Draft review 5361645031 on #60, draft review 5361651490 on #63 | created, pending | publication (steps A7, B4) |
| Branch `suggestion-pr/60/d9f36f69-…` (`d898243…`) and [#72](https://github.com/mike-north/doc-linter/pull/72) | created; open draft, labeled `suggestion-pr` | publication (step A7) |
| Branch `suggestion-pr/63/457b8f95-…` (`544e4b3…`) and [#73](https://github.com/mike-north/doc-linter/pull/73) | created; open draft, labeled `suggestion-pr` | publication (step B4) |

Nothing else was changed. The label `suggestion-pr` already existed. Every other step wrote only local files.

## What this does not show

- Ungrouping live: `ungroup-fixes` edits only a local file and has no GitHub effect; it is covered by `test/suggestion-groups.test.mts` and `test/cli-suggestion-groups.test.mts`.
- The library surface live: the same operations run through the installed library in `test/installed-companion.test.mts`, against the fake host.
- Several replacements on one line, and overlapping replacements, live: covered by `test/companion-composition.test.mts`.
- Merging a suggestion pull request: nothing was merged.
