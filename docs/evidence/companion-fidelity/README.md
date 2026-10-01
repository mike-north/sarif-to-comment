# Companion fidelity after a force-push: live verification

Run on October 1, 2026 in `mike-north/doc-linter`, against the implementation of the fidelity projection ([companion contract §2.5.1](../../companion-suggestion-pr-contract.md#251-fidelity-after-a-rewritten-history), D58, D59). The built package ran from the working tree (`node dist/sarif-to-comment.cjs`, `--format json`) with the maintainer's personal token, given inline for each command. One account (`mike-north`, the repository owner) made every request. Nothing was published to npm, nothing was merged or closed, and `main` stayed at `0a7b03f` ([`10`](10-refs-after.txt)).

The verification was bounded: one fixture pull request, one validation-only run that the projection judges unfaithful, and one suggestion pull request the projection judges faithful.

Under the [evidence policy](../../evidence-policy.md), this record is historical. It is not updated to follow later changes to the fixtures.

## What was written to GitHub

| Action | Objects |
| --- | --- |
| Pushed a fixture branch from `main` | `exp-fidelity-20261001`: C0 `ac4038d` adds `docs/experiments/fidelity/sample.md` (20 lines `Line N.`); C1 `07791aa`, the reviewed commit, changes lines 5 and 6 |
| Opened a draft pull request into `main` | [#96](https://github.com/mike-north/doc-linter/pull/96) |
| Force-pushed the branch, twice | to D `78d69c0` (C0 plus line 15 only: C1's lines 5 and 6 dropped), then to A `e001d67` (C0 plus lines 5 and 6 as reviewed, and line 15) |
| `publish` at head A | the draft suggestion pull request [#97](https://github.com/mike-north/doc-linter/pull/97) from `suggestion-pr/96/05494b98-1051-40ea-8456-ffbac8b0fb8f` (commit `fa6f741`, parent C1), labeled `suggestion-pr`; the pending review 5375523422 on #96 |

All of them were left in place. The validation runs wrote nothing.

## The document

[`review.sarif.json`](review.sarif.json): one finding at C1, whose fix replaces line 10 of the sample with `Line 10, suggested.`. Every run delivered it with `--edits companion`, a strict list: a companion pull request or nothing.

## Runs

1. **Head D: projected unfaithful, so the review is blocked and nothing is written** ([`01`](01-validate-unfaithful.json), exit status 2, [`01-exit`](01-exit.txt)). `validate` answered `blocked` with one `delivery-unavailable` error: ``- `companion`: The history of #96 was rewritten after the reviewed commit, and projected onto its head `78d69c0…`, merging its suggestion pull request would not apply exactly its own changes: `docs/experiments/fidelity/sample.md` would bring back content the head no longer has.`` Its first remedy is `Review the pull request's current head again, and publish that review.` The reviewed commit was associated with #96 through the force-push that replaced it.
2. **Head A: projected faithful** ([`02`](02-validate-faithful.json), exit status 0). `validate` answered `ready`: ``Publication would also create 1 draft suggestion pull request into `exp-fidelity-20261001`, labeled `suggestion-pr`. The history of #96 was rewritten after the reviewed commit, so it is proposed on that commit and was projected onto the head `e001d67…`: merging it applies only its own changes.`` There were no diagnostics.
3. **Head A: published** ([`03`](03-publish-faithful.json), exit status 0). `publish` created #97 and the pending review 5375523422, and listed ``Suggestion pull requests (drafts into `exp-fidelity-20261001`, labeled `suggestion-pr`, proposed on the reviewed commit and projected onto the head `e001d67…`):``. There were no diagnostics. The plan ([`state/faithful.json`](state/faithful.json)) is version 3, and records `projection: { head: e001d67…, mergeBase: ac4038d…, suggestions: [{ verdict: faithful, conflicts: [] }] }`.
4. **A retry is answered from the receipts** ([`08`](08-retry.json), exit status 0): ``… was already published; its completion is recorded at `<evidence>/state/faithful.json`. Nothing was sent.`` Nothing was left to create, so the head was not read again.

Every run's standard error held only a warning from the shell's own environment, that Node ignores `NO_COLOR` when `FORCE_COLOR` is set ([`01`](01-validate-unfaithful.stderr.txt), [`02`](02-validate-faithful.stderr.txt), [`03`](03-publish-faithful.stderr.txt)). The tool wrote nothing to it.

## Projected and observed, kept apart

**The tool's projection (before #97 existed).** At head D: unfaithful, because `sample.md` would bring back content the head no longer has. At head A: faithful.

**A local projection, not a merge GitHub performed** ([`07`](07-local-merge-tree.txt)). `git merge-tree --write-tree` (Git 2.54.0, renames off) of the created proposal commit `fa6f741` into each head:

- **Into A:** clean. The merge differs from A only by line 10, and equals A plus only the proposal's own change (the cherry-pick target over C1).
- **Into D:** clean. The merge differs from D by lines 5, 6 and 10: it would bring back C1's lines 5 and 6, which D dropped.

Both agree with the tool's verdicts. The D case uses the commit created at A. It is the proposal commit the tool builds for this document whatever the head, because its parent is always C1.

**Observed on GitHub (after #97 existed).**

- **Its description** ([`04`](04-companion-pr-view.json), `body`) begins `Suggested in a review of #96 at commit 07791aa….`, followed by the projection section. That section says the reviewed commit is not part of the branch of #96, names A, and says merging it applies only its own changes. It then shows them as one hunk at line 10 (`-Line 10.`, `+Line 10, suggested.`), then the change list, lifecycle note, finding and version 1 marker.
- **GitHub's own view of #97** ([`04`](04-companion-pr-view.json), [`05`](05-companion-files.json)) lists two commits: C1, which the branch no longer contains, and the proposal commit. It shows `sample.md` +3 −3, at lines 5, 6 and 10. This is the diff from the merge base C0, as GH-18 recorded for other companions, and not the one-line change the description shows. The [behavior register](../../github-behavior.md) records these readbacks as GH-20.
- **Mergeability:** `MERGEABLE` from `gh pr view` ([`04`](04-companion-pr-view.json)), and `mergeable: true`, `mergeable_state: clean` from REST ([`06`](06-companion-pull-rest.json)).
- **#96 afterwards** ([`09`](09-original-pr-view.json)): an open draft into `main`, head A.

Nothing was merged, so GitHub's actual merge result was not observed. That `mergeable` agrees with the projection is not proof of the merged content.

## Files

| File | Source |
| --- | --- |
| `review.sarif.json` | The SARIF document of every run. |
| `01-validate-unfaithful.json`, `-stderr.txt`, `01-exit.txt` | `validate --edits companion --format json` at head D: standard output, standard error, exit status. |
| `02-validate-faithful.json`, `-stderr.txt`, `02-exit.txt` | The same at head A. |
| `03-publish-faithful.json`, `-stderr.txt`, `03-exit.txt` | `publish --edits companion --state <evidence>/state/faithful.json --format json` at head A. |
| `state/` | The publication's plan and step records. |
| `04-companion-pr-view.json` | `gh pr view 97 --json …` after creation. |
| `05-companion-files.json` | `GET repos/mike-north/doc-linter/pulls/97/files`. |
| `06-companion-pull-rest.json` | `GET repos/mike-north/doc-linter/pulls/97`. |
| `07-local-merge-tree.txt` | The local `git merge-tree` projections. Produced locally; not a GitHub response. |
| `08-retry.json`, `-stderr.txt`, `08-exit.txt` | The same `publish` again, with the same state path. |
| `09-original-pr-view.json` | `gh pr view 96 --json …` afterwards. |
| `10-refs-after.txt` | `git ls-remote` of `main`, the fixture branch and its suggestion branch afterwards. |

Redaction: the local directory of the run is written `<evidence>`, and any value under a key named `email` is `<redacted-email>`. No token appears.

## What this does not show

- A suggestion pull request projected to **conflict**, created with `companion-conflicts-at-head` and its `mergeable` read back. That path is covered by the fake host only (`test/force-push-companions.test.mts`, `test/suggestion-pr-fallback.test.mts`, `test/installed-delivery.test.mts`).
- A retry after the head moved again since the projection, live.
- Bundles, whole-file proposals, groups, binary files, symbolic links, submodules, renames, directory renames and truncated trees, live.
- A merge, so GitHub's merged content was never compared with the projection.
- Forks, other accounts and other bases.
