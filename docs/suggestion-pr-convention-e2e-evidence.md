# Suggestion pull request convention: live GitHub evidence

Recorded September 29, 2026 in the private fixture repository `mike-north/doc-linter`, against the implementation of the [suggestion pull request convention](suggestion-pr-convention.md) and the owner's option decisions ([#27](https://github.com/mike-north/sarif-to-comment/issues/27)). The built package ran from the working tree (`node dist/sarif-to-comment.cjs`) with the maintainer's personal token. Nothing was published to npm, nothing was merged, and the repository's `main` branch was not touched. Sanitized outputs are in [`evidence/suggestion-pr-convention/`](evidence/suggestion-pr-convention/); every CLI step wrote nothing to stderr, and its exit status is in [`exit-statuses.txt`](evidence/suggestion-pr-convention/exit-statuses.txt).

## What this covers

| #27 acceptance item | Live | Elsewhere |
| --- | --- | --- |
| Publication with the default label | Steps 1–6 | `test/suggestion-pr-convention.test.mts` |
| Publication with a repository-configured label | **Not live**: `.github/suggestion-prs.json` is read from the default branch, which these runs never modify. Every live run read the configuration path on `main` through Git objects and found it absent. | `test/suggestion-pr-convention.test.mts` (valid, absent, no `label`, invalid, unreadable, head-branch-only files), `test/installed-companion.test.mts` and `test/installed-cleanup.test.mts` (the installed package with a configured label) |
| Extra labels | Steps 7–10 | `test/suggestion-pr-convention.test.mts` |
| A ready suggestion pull request | Steps 9–11 | `test/suggestion-pr-convention.test.mts`, `test/installed-companion.test.mts` |
| Cleanup of convention-conforming suggestion pull requests | Steps 12–19 | `test/suggestion-pr-convention.test.mts`, `test/cleanup-composition.test.mts` |

## Fixtures

Both originals were created for this evidence: a branch from `main` adding one Markdown page, pushed to the repository, and a draft pull request into `main` (the supported scope: same repository, default-branch base).

| Object | Identity | Reviewed commit |
| --- | --- | --- |
| Original A | [#56](https://github.com/mike-north/doc-linter/pull/56), head `sarif-issue27-20260929-a` | `37eaceec3431911c60692ff561d6c1afd91297fc` |
| Original B | [#57](https://github.com/mike-north/doc-linter/pull/57), head `sarif-issue27-20260929-b` | `68cbc6c810720bdd1de289ef70a01c3482364f36` |

Each SARIF document ([`a.sarif.json`](evidence/suggestion-pr-convention/a.sarif.json), [`b.sarif.json`](evidence/suggestion-pr-convention/b.sarif.json)) was authored with the CLI (`init`, `add-comment`, `add-staged-changes`) from a staged new page, `docs/experiments/sarif-issue27/{a,b}-guide.md`, so each needs one suggestion pull request. The pull requests and every branch head were recorded after the fixtures were created and before the first run ([`00-before-pull-requests.jsonl`](evidence/suggestion-pr-convention/00-before-pull-requests.jsonl), [`00-before-branches.txt`](evidence/suggestion-pr-convention/00-before-branches.txt)).

## Runs

1. **A missing canonical label blocks before any write** ([`01`](evidence/suggestion-pr-convention/01-validate-a-label-missing.json)). `validate --allow-suggestion-prs` on #56, before the repository had a `suggestion-pr` label: exit 2, `blocked`, one problem: ``The label `suggestion-pr` does not exist in mike-north/doc-linter. It is the default suggestion label: create it, or name another existing label in `.github/suggestion-prs.json` on the default branch. Labels are never created automatically.``
2. **Publish parity** ([`02`](evidence/suggestion-pr-convention/02-publish-a-label-missing.json)). `publish` with the same input: exit 2, `blocked`, the identical Markdown, and no state file written.
3. **Not yet supported: a non-default base** ([`03`](evidence/suggestion-pr-convention/03-validate-36-base-not-default.json)). A read-only `validate` of the earlier fixture [#36](https://github.com/mike-north/doc-linter/pull/36), whose base is `sarif-issue5-20260929-base`: exit 2, ``Suggestion pull requests are not yet supported for a pull request into `sarif-issue5-20260929-base`, which is not the default branch `main` of mike-north/doc-linter: following a suggestion through a pull request that merges into another branch […] is not built yet.``, reported together with the missing label.
4. **The label is created by a person**, not by the tool: `gh label create suggestion-pr`.
5. **Validate ready (draft)** ([`05`](evidence/suggestion-pr-convention/05-validate-a-ready.json)): ``Publication would also create 1 draft suggestion pull request into `sarif-issue27-20260929-a`, labeled `suggestion-pr`.``
6. **Default label, draft** ([`06`](evidence/suggestion-pr-convention/06-publish-a-default-label.json)): exit 0, `published`: the draft review [5361143618](https://github.com/mike-north/doc-linter/pull/56#pullrequestreview-5361143618) on #56 and the suggestion pull request [#58](https://github.com/mike-north/doc-linter/pull/58) from `suggestion-pr/56/bb3b8acd-0bdf-4464-b341-8802383b6935`.
7. **A missing extra label blocks** ([`07`](evidence/suggestion-pr-convention/07-validate-b-extra-missing.json)): `--pr-labels "documentation, sarif-issue27-no-such-label"` on #57: exit 2, one problem naming `sarif-issue27-no-such-label` as given in `pullRequestLabels (--pr-labels)`; the existing `documentation` is not reported.
8. **Publish parity** ([`08`](evidence/suggestion-pr-convention/08-publish-b-extra-missing.json)): exit 2, the identical Markdown, no state file.
9. **Ready for review, with extra labels** ([`09`](evidence/suggestion-pr-convention/09-validate-b-ready-extra.json)): `--pr-labels "documentation, Suggestion-PR" --mark-suggestion-prs-ready`: ``Publication would also create 1 suggestion pull request, ready for review, into `sarif-issue27-20260929-b`, labeled `suggestion-pr` and `documentation`.`` The case variant `Suggestion-PR` was deduplicated against the canonical label.
10. **Published** ([`10`](evidence/suggestion-pr-convention/10-publish-b-ready-extra.json)): exit 0: the draft review [5361148093](https://github.com/mike-north/doc-linter/pull/57#pullrequestreview-5361148093) on #57 and [#59](https://github.com/mike-north/doc-linter/pull/59) from `suggestion-pr/57/81e4d9fe-25d2-48e4-b421-9115dce6f808`.
11. **Read-back** ([`11-readback-58`](evidence/suggestion-pr-convention/11-readback-58.json), [`11-readback-59`](evidence/suggestion-pr-convention/11-readback-59.json), [`20-proposal-commits`](evidence/suggestion-pr-convention/20-proposal-commits.txt)), as GitHub reports it:
    - #58: open, **draft**, labels `suggestion-pr`, base `sarif-issue27-20260929-a`; #59: open, **not a draft**, labels `documentation` and `suggestion-pr`, base `sarif-issue27-20260929-b`.
    - Titles `Suggestion for #56: create docs/experiments/sarif-issue27/a-guide.md` and the same for #57. Each body starts ``Suggested in a review of #N at commit …``, carries the draft or ready lifecycle note of the [companion contract §2.11](companion-suggestion-pr-contract.md#211-presentation), and ends with the convention's marker, for #58 `<!-- suggestion-pr {"version":1,"original":{"owner":"mike-north","repo":"doc-linter","pullNumber":56},"reviewedCommit":"37eaceec3431911c60692ff561d6c1afd91297fc","id":"bb3b8acd-0bdf-4464-b341-8802383b6935","batch":"a0d34b4d-6f04-43f9-80d2-65631f902afd"} -->`. No title, body, branch, label or commit message names SARIF or the tool.
    - Each branch holds one commit whose only parent is the reviewed commit, adding exactly the staged page (the bytes compared equal to the staged file).
12. **Cleanup dry run, both originals open** ([`12`](evidence/suggestion-pr-convention/12-cleanup-dry-run-originals-open.json)): ``Checked the open pull requests labeled `suggestion-pr` in mike-north/doc-linter (the default suggestion label).``; #58 and #59 `left-open`, exit 0.
13. **Original B ends**: `gh pr close 57`, not merged, branch kept ([`13`](evidence/suggestion-pr-convention/13-original-57-after-close.json)).
14. **Dry run** ([`14`](evidence/suggestion-pr-convention/14-cleanup-dry-run-after-close.md), human output): #57 `closed without merging`; #59 `would be closed`; #58 left open.
15. **Cleanup** ([`15`](evidence/suggestion-pr-convention/15-cleanup.json)): exit 0, `complete`: #59 `closed`, #58 `left-open`.
16. **Read-back** ([`16-after-pull-requests`](evidence/suggestion-pr-convention/16-after-pull-requests.jsonl), [`16-branches.diff`](evidence/suggestion-pr-convention/16-branches.diff)): #59 `CLOSED`, `mergedAt: null`, still labeled; #56 and #58 open; #57 closed as in step 13. Compared with the listing before the runs, the only branch changes are the two new suggestion branches (both still present after cleanup) and GitHub's own `refs/pull/*` references.
17. **Targeted rerun** ([`17`](evidence/suggestion-pr-convention/17-cleanup-original-57-rerun.json)): `--original 57` finds #59 through #57's backlinks and reports it `already-closed`, exit 0, no write.
18. **Sweep rerun** ([`18`](evidence/suggestion-pr-convention/18-cleanup-sweep-rerun.json)): only #58, `left-open`, exit 0.
19. **The `--label` migration override** ([`19`](evidence/suggestion-pr-convention/19-cleanup-label-override-dry-run.md)): `--label suggestion --dry-run` sweeps the label the unreleased implementation used, ``(a label given in place of the repository's suggestion label)``. Its open pull requests [#38](https://github.com/mike-north/doc-linter/pull/38) and [#39](https://github.com/mike-north/doc-linter/pull/39) carry the earlier, tool-branded marker, which does not conform to the convention, so both are reported `skipped, not a conforming suggestion pull request` and never closed.

## Live artifacts

Every artifact these runs created or changed, all left in place:

| Artifact | Change | By |
| --- | --- | --- |
| Branches `sarif-issue27-20260929-a` (`37eacee…`) and `sarif-issue27-20260929-b` (`68cbc6c…`) | created from `main` | `git push`, fixture setup |
| [#56](https://github.com/mike-north/doc-linter/pull/56) (original A) | opened as a draft into `main`; still open | `gh pr create`, fixture setup |
| [#57](https://github.com/mike-north/doc-linter/pull/57) (original B) | opened as a draft into `main`, then closed without merging; branch kept | `gh pr create`; `gh pr close` (step 13) |
| Label `suggestion-pr` | created | `gh label create` (step 4) |
| Draft review 5361143618 on #56, draft review 5361148093 on #57 | created, pending | publication (steps 6, 10) |
| Branch `suggestion-pr/56/bb3b8acd-…` (`5cd90d7…`) and [#58](https://github.com/mike-north/doc-linter/pull/58) | created; #58 open draft, labeled `suggestion-pr` | publication (step 6) |
| Branch `suggestion-pr/57/81e4d9fe-…` (`45de42b…`) and [#59](https://github.com/mike-north/doc-linter/pull/59) | created ready for review, labeled `suggestion-pr` and `documentation`; closed by cleanup; branch kept | publication (step 10), cleanup (step 15) |

Nothing else was changed. Steps 1–3, 5, 7–9, 12, 14 and 17–19 wrote nothing.

## What this does not show

- A repository-configured label, live (see the table above).
- Forks: the fixture repository has no fork pull request; the refusal is covered by `test/suggestion-pr-convention.test.mts`. *Since [#37](https://github.com/mike-north/sarif-to-comment/issues/37) (September 30, 2026), a fork or a base other than the default branch is no longer refused: each change is handled as if suggestion pull requests were not allowed ([evidence](suggestion-pr-fallback-e2e-evidence.md)). Since the [delivery policy](delivery-policy-contract.md) (September 30, 2026, later), each change goes to the next mechanism its list names, for example the review body under `fileOperations: [companion, manual]` with a `delivery-fallback` warning, or is blocked with `delivery-unavailable` when its list names nothing else available.*
- A reviewed commit that is no longer the head, which remains refused until [#28](https://github.com/mike-north/sarif-to-comment/issues/28); covered by the same tests.
- Marking a draft suggestion ready and merging it: #58 is left as a draft, and nothing was merged.
- A suggestion pull request made by another tool: cleanup's handling of foreign identifiers, batches and authors is covered by the fake host only.
