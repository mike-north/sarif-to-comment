# Abandonment cleanup: live evidence

Recorded October 1, 2026 (UTC), for the owner's optional abandonment cleanup ([D54](../../design-decisions.md#d54-delay-optional-abandonment-cleanup-and-recheck-the-original--owner-selected-candidate-policy-workflow-experiment-pending)). It covers the guard `--if-abandoned` (`requireAbandonedOriginal`) of [cleanup contract §2.12](../../suggestion-cleanup-contract.md#212-requiring-an-abandoned-original-requireabandonedoriginal---if-abandoned).

## Conditions and limits

- **Fixture.** `mike-north/doc-linter`, a same-repository fixture with one account (`mike-north`). The token was the account's own, supplied per command and never recorded.
- **Build.** The built CLI of this repository at commit `f9ea9c3` (`node dist/sarif-to-comment.cjs`), not an installed release. The runs used that commit's tree, built before the branch was rebased onto `main`; the rebased commit's tree is identical.
- **Writes.** Every cleanup run was a dry run (`--dry-run`), and nothing was written to GitHub. No pull request was closed, reopened or created to make a case. The states of the ten fixture pull requests involved were read before and after the runs, and are identical: [`a00`](live/a00-fixture-states.json), [`a12`](live/a12-fixture-states-after.json).
- **No workflow.** No GitHub Actions workflow was installed or run, here or in the fixture. The example workflow is checked by `test/abandonment-workflow-example.test.mts` (parsed, and accepted by `actionlint` 1.7.12 locally), not run. See [the remaining obstacle](#the-remaining-obstacle-a-live-workflow-run).
- **Not run live.** Two cases were not run against GitHub:
  - A read failure of the original. It cannot be produced against GitHub without changing access. It is covered against the simulated host (`test/cleanup-abandonment.test.mts`: 403, 502 and a malformed answer).
  - A real close by a guarded run. The only closed, unmerged fixture originals with suggestion pull requests (#57, #7) have them closed already, and creating a case would need a write.

## Runs

| # | Command (all `close-suggestion-prs --repo mike-north/doc-linter`) | The original, as `gh` read it | Result | Exit |
| --- | --- | --- | --- | --- |
| a01 | `--original 105 --if-abandoned --dry-run --format json` | #105 open (draft); its suggestion #106 open | **Skipped**: `original-not-abandoned`, `originals: [{ 105, open }]`, no suggestions, zero counts. One note, `original-pull-request-not-abandoned`, about `mike-north/doc-linter#105`: "#105 is open, not closed without merging, so nothing was checked or closed." ([json](live/a01-open-105-guarded-dry-run.json)) | 0 ([exit](live/a01-exit.txt)) |
| a02 | `--original 103 --if-abandoned --dry-run` (human) | #103 open (draft); its suggestion #104 open | **Skipped**. Stdout is the title and "Nothing was checked or closed." ([md](live/a02-open-103-guarded-dry-run.md)). The note is on stderr ([stderr](live/a02-open-103-guarded-dry-run.stderr.txt)). | 0 |
| a03 | `--original 57 --if-abandoned --dry-run --format json` | #57 closed, not merged; its suggestion #59 closed | **Proceeded**: `complete`, `#57: closed without merging`, #59 `already-closed`, counts 1/1/1/1 ([json](live/a03-closed-57-guarded-dry-run.json)). | 0 |
| a04 | `--original 57 --dry-run --format json` (no guard: the control) | as a03 | The same document as a03, byte for byte after parsing: the guard changed nothing for a closed, unmerged original ([json](live/a04-closed-57-unguarded-dry-run.json)). | 0 |
| a05 | `--original 7 --if-abandoned --dry-run` (human) | #7 closed, not merged; its 2026-09-27 companion #8 predates the convention (a `codex/…` branch, the `suggestion` label) | **Proceeded**: `#7: closed without merging`, "No suggestion pull requests were found." #8 is not reported. It has no `suggestion-pr` label and no `suggestion-pr/` branch. So it is either not among #7's backlinks, or an ordinary reference without a marker (contract §2.6, row 1) ([md](live/a05-closed-7-guarded-dry-run.md)). | 0 |
| a06 | `--original 5 --if-abandoned --dry-run --format json` | #5 merged | **Skipped**: `original-not-abandoned`, `{ 5, merged }`, the note "#5 was merged, not closed without merging, so nothing was checked or closed." ([json](live/a06-merged-5-guarded-dry-run.json)) | 0 |
| a07 | `--original 9999 --if-abandoned --dry-run --format json` | no #9999 | **Skipped**: `{ 9999, not-found }`, the note "mike-north/doc-linter has no pull request #9999 that this account can read, so nothing was checked or closed.", and no `original-pull-request-not-found` warning ([json](live/a07-missing-9999-guarded-dry-run.json)). | 0 |
| a08 | `--if-abandoned --dry-run --format json` (no `--original`) | — | **Usage error**: "--if-abandoned requires --original (it checks that original pull request)" ([json](live/a08-usage-without-original.json)). | 1 |

### The original is read before anything is listed

[`request-log-preload.cjs`](request-log-preload.cjs) is preloaded into the CLI. It records each request's method and path, and never its headers. The three runs below repeat a01, a03 and a06:

- [`a09`](live/a09-open-105-guarded-dry-run.requests.txt) (open #105): five reads resolve the label (the repository, then `main`'s reference, commit and trees, to look for `.github/suggestion-prs.json`), then `GET /pulls/105`, and nothing after it.
- [`a10`](live/a10-closed-57-guarded-dry-run.requests.txt) (closed #57): the same five reads, then `GET /pulls/57`, then the one backlink query (`POST /graphql`, `timelineItems`). No second read of #57.
- [`a11`](live/a11-merged-5-guarded-dry-run.requests.txt) (merged #5): the same five reads, then `GET /pulls/5`, and nothing after it.

So a skipped run cost six requests here: the label resolution and the one read of the original. It lists nothing and does not read the account. A run that proceeds costs what targeted cleanup costs (contract §2.12, "Request cost").

## What this establishes

- On GitHub, the guard skips an open original and a merged original, and skips one that does not exist. Each skip exits 0, with the documented note, and lists nothing.
- It proceeds for a closed, unmerged original, with the same outcome as unguarded targeted cleanup.
- It reads the exact original after the label resolution and before any listing.
- It refuses `--if-abandoned` without `--original`.

It does not establish:

- the workflow's trigger, condition, wait or concurrency;
- that the example's credential, a personal access token from a repository secret, reaches the command in a workflow run;
- that the workflow's own token (`github.token`, the documented alternative) can run the guarded cleanup;
- a close made by a guarded run;
- a read failure against GitHub.

## The remaining obstacle: a live workflow run

Running the example workflow on GitHub (the realignment plan's E7) needs **the owner's authority to install a GitHub Actions workflow in a fixture repository's branch, and to let it run**. Running the example as shipped also needs a repository secret, `SARIF_TO_COMMENT_TOKEN`, holding the account's personal access token in the fixture repository. That authority has not been given. The workflow has therefore never been installed or run, here or in `mike-north/doc-linter`. Everything else this work needed was within the existing authority.

**The proposed bounded experiment.** It runs in `mike-north/doc-linter`, never on `main`, never merging anything, with one account. Each step below is named by what it needs.

1. **Build (needs the authority above).** Add the `SARIF_TO_COMMENT_TOKEN` secret to the fixture repository. Push two fixture branches from `main`: `sarif-e7-a-<date>` and `sarif-e7-b-<date>`. Each adds a one-line documentation change and `.github/workflows/abandonment-cleanup.yml`, the example with one difference: `--dry-run` appended to the command. Open each as a draft pull request into `main`: O-A and O-B.
   - With `pull_request`, GitHub reads the workflow from each pull request's own merge commit, so `main` is never changed.
   - Until 0.3.0 is published, the pinned `npx sarif-to-comment@0.3.0` cannot resolve. Run the experiment after publication, unchanged. Or run it before, with the command pointed at the candidate's packed tarball, and record that difference.
2. **Companions (existing authority).** Publish one review with one companion on each (`publish --delivery companion`), giving C-A and C-B.
3. **Case A: closed and left closed.** Close O-A without merging, and leave it closed. Expected:
   - one workflow run for the `closed` event, whose job runs (`merged == false`);
   - a step of about 120 seconds;
   - then a guarded dry run that reports `complete`, with O-A `closed without merging` and C-A `would-close`, exit 0.
4. **Case B: a quick close and reopen.** Close O-B, and reopen it within about 30 seconds. Expected:
   - a run that waits, then reports `original-not-abandoned` with O-B `open`, exit 0;
   - no reopen-triggered run, because the workflow does not listen to `reopened`;
   - C-B untouched.
5. **Case C (optional): repeat runs.** Close O-B, reopen it, and close it again within the wait. Expected: `concurrency` cancels the first waiting run, and the second reports `complete` with C-B `would-close`.
6. **Record:**
   - each run's id, event and timestamps (`gh run view`), and its job log;
   - the pull requests' states and timelines before and after;
   - the time of the guard's read, against the time of the close and the reopen.
7. **Afterwards.** Leave the fixture pull requests closed. Delete nothing; branch removal is the owner's call.

**Phase 2 (separate, optional authority).** Switch the step to the documented alternative, `GH_TOKEN: ${{ github.token }}`, and remove `--dry-run` for one case-A rerun, so that the workflow's own token closes C-A. That would establish:

- the one thing dry runs and the personal token cannot: that the automatic Actions token can run guarded cleanup end to end, which would let the example offer it as more than an alternative;
- whether `issues: read` is needed;
- whether `--owner all` is enough.

The README's support profile does not yet claim installation tokens.

**Out of reach either way.** `pull_request_target` runs only from the default branch, so testing it would need a change on `main` (the realignment plan's risk 4). The merged path needs a merge. It is covered by the job's condition and by the guard's live skip of merged #5 (a06).
