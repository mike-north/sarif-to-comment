# Example: close suggestion pull requests when a pull request is abandoned

[`abandonment-cleanup.workflow.yml`](abandonment-cleanup.workflow.yml) is an **example** GitHub Actions workflow for the owner's optional abandonment cleanup ([D54](../design-decisions.md#d54-delay-optional-abandonment-cleanup-and-recheck-the-original--owner-selected-candidate-policy-workflow-experiment-pending)). It is documentation only.

- **It is never installed or run here.** GitHub runs workflows only from a repository's `.github/workflows/`, and this file lives under `docs/examples/`. Nothing in sarif-to-comment installs it.
- **It has not been run on GitHub.** Running it live needs the owner's authority to install a workflow in a fixture repository; see [the remaining obstacle](../evidence/abandonment-cleanup/README.md#the-remaining-obstacle-a-live-workflow-run).
- **To use it**, a repository's maintainers copy it into their own `.github/workflows/` and add a `SARIF_TO_COMMENT_TOKEN` secret, after reading this page.

## What it does

1. **Trigger.** It runs when a pull request is closed (`pull_request`, `types: [closed]`).
2. **First filter.** The job runs only if the event says the pull request was not merged (`if: github.event.pull_request.merged == false`). This only saves a run: it is not the decision.
3. **The wait.** It waits two minutes (`sleep 120`).
4. **The tool decides.** It runs targeted cleanup with the guard:

   ```sh
   npx --yes sarif-to-comment@0.3.0 close-suggestion-prs \
     --repo OWNER/REPO --original N --if-abandoned --owner all
   ```

   The fresh check is the tool's own read of the pull request, made when the command runs, two minutes after the close. The event's payload is never trusted for it. The [cleanup contract §2.12](../suggestion-cleanup-contract.md#212-requiring-an-abandoned-original-requireabandonedoriginal---if-abandoned) defines the outcomes:

   | The tool's read of the pull request | Result | Exit status |
   | --- | --- | --- |
   | Still closed, not merged | Targeted cleanup closes its conforming suggestion pull requests, as `--original N` always does. | 0, or 2 or 3 as for any cleanup |
   | Open again: reopened during the wait | Skipped: `original-not-abandoned`, and a note. Nothing is checked or closed. | 0 |
   | Merged | Skipped, the same way | 0 |
   | Not found | Skipped, the same way | 0 |
   | Could not be read | An error. Nothing is closed. | 1 |

**The grace period belongs to the workflow, not to the tool.** `sarif-to-comment` never waits, schedules or watches anything: it reads once, when it runs. Change `sleep 120` to change the grace period.

**What it never does.** It never deletes a branch. It never reopens, recreates or edits a suggestion pull request, and it never touches the original. Every check that cleanup always makes still applies before anything is closed: the marker, the repository, the branch and the label.

## The accepted trade-off: reopening later

The wait and the fresh read keep a brief close and reopen from being treated as abandonment. Neither makes cleanup and reopening impossible to race.

- **Reopened much later.** If a pull request is reopened well after the run has closed its suggestion pull requests, they stay closed. Someone who wants them back reopens them by hand. Each one's branch, commits, description and label are left in place, so reopening restores it. The owner accepted this in D54.
- **Reopened during a run.** A pull request reopened after the tool's read, while that run is still working, can have its suggestion pull requests closed by that run. They are restored by reopening them by hand, too.

## Repeat runs

- **Closing again re-runs it.** Every close of the same pull request triggers a run. The `concurrency` group, keyed by the pull request's number with `cancel-in-progress: true`, cancels an earlier run that is still waiting. After a close, a reopen and a second close, only the latest run checks.
- **Running it again is safe.** If the pull request is still closed without merging, a rerun reports the suggestion pull requests it already closed as `already-closed` and closes nothing more. If the pull request has been reopened or merged since, the rerun skips. Re-running a workflow run from GitHub's interface behaves the same way.
- **Cost.** Each run holds a runner for about two minutes, and makes a handful of API requests. A skipped run reads the repository, its label configuration and the pull request, and lists nothing.

## Credential, permissions and `--owner all`

- **The credential: a personal access token in a secret.** The example runs cleanup with `GH_TOKEN: ${{ secrets.SARIF_TO_COMMENT_TOKEN }}`. This is a repository secret, named `SARIF_TO_COMMENT_TOKEN`, holding a personal access token: the credential sarif-to-comment supports (README, "Authentication"). The token needs:
  - read access to the repository;
  - permission to close its pull requests.

  A fine-grained token limited to this repository, with pull requests read and write and contents read, is enough.
- **Alternative: the workflow's own token, `github.token`, is not yet established.** The step can use `GH_TOKEN: ${{ github.token }}` instead, which needs no secret. It is left as a comment in the workflow, because sarif-to-comment's support profile does not claim GitHub App installation tokens, and the automatic Actions token is one. Publication is the reason: it reads the authenticated account with `GET /user`, which GitHub documents as unavailable to installation tokens. Run with `--owner all`, guarded cleanup never makes that request. Every request it does make (the repository and its configuration file, the original, the timeline query and the close) is one GitHub documents for installation tokens with the permissions below. That is advertised behavior, not an observation. Phase 2 of the bounded live run in [the remaining obstacle](../evidence/abandonment-cleanup/README.md#the-remaining-obstacle-a-live-workflow-run) is what would establish it.
- **Permissions.** The `permissions:` block scopes the workflow's own token. With the personal access token, that token's own access governs cleanup's requests. The permissions still matter: they apply as soon as the step is switched to `github.token`, and they cap anything else the job does. The block grants only what cleanup uses:
  - `pull-requests: write`, to close suggestion pull requests;
  - `contents: read`, to read the repository and its `.github/suggestion-prs.json` label configuration;
  - `issues: read`, so that the timeline query can resolve issues that reference the original. Cleanup ignores those issues, but GitHub must still let the query see them.

  That a workflow token lacking `issues: read` would fail on such a timeline is a precaution from GitHub's permission model. It has not been observed.
- **Why `--owner all`.** By default (`--owner me`) cleanup closes only the suggestion pull requests that the token's own account opened, and it reads that account with `GET /user`. A repository's suggestion pull requests may have been opened by whoever published reviews: people, or the accounts of their tools.
  - **With the personal access token**, `me` works, but it closes only the suggestion pull requests that the token's own account opened. Those opened by any other account would be left open.
  - **With `github.token`**, `me` would match nothing, because the token belongs to the GitHub Actions app, which opened none of them. It would also need `GET /user`, which GitHub documents as unavailable to that token.

  So the example uses `--owner all`, narrowed by `--original` to the suggestion pull requests of the one closed pull request. Each must still conform to the convention and carry the label. If every suggestion pull request in the repository is opened by the account whose token is in the secret, `--owner all` can be dropped to keep the default `me` scope.

## Security: `pull_request` or `pull_request_target`

The example uses `pull_request`, deliberately.

- **Which workflow definition runs.** With `pull_request`, GitHub runs the workflow definition from the pull request's branch, merged with its base. A pull request can therefore change the workflow it runs under. For a pull request from a branch of the same repository, its author can already push to the repository, and can already use the repository's workflows and secrets, so this grants nothing new. The workflow's own token is capped by the `permissions:` block. `pull_request_target` instead runs the definition from the default branch, with a write-capable token, even for pull requests from forks.
- **Code from the pull request's branch.** The example checks out nothing and runs nothing from the pull request's branch. It runs only the pinned `sarif-to-comment` release from npm. `pull_request_target` is dangerous mainly when a workflow checks out and runs code from the pull request's branch with that token. Avoid adding a checkout step to this workflow under either event.
- **Interpolation.** The script interpolates only `${{ github.repository }}` and `${{ github.event.pull_request.number }}`, which cannot carry shell syntax. Never interpolate a pull request's title, body or branch name into the script.
- **Tokens on forks.** For a pull request from a fork, `pull_request` passes no secrets, and gives the workflow's own token read access only, whatever `permissions:` asks for. A run for a fork's pull request therefore fails for want of a token with the secret, or could read but not close with `github.token`. Forks are not supported anyway: the convention keeps suggestion pull requests in the same repository, and publication makes none for a fork's pull request ([D25](../design-decisions.md#d25-record-fork-based-suggestions-without-expanding-near-term-scope--settled-priority)). So such a run normally finds nothing to close. `pull_request_target` would give fork-triggered runs the secret and a write token, to gain nothing. It would also take effect only once the workflow is on the default branch.
- **Supply chain.** Pin an exact release (`sarif-to-comment@0.3.0`, the first with `--if-abandoned`) and actions by commit, as the example does. Update them deliberately. `sarif-to-comment@0.3.0` resolves only once 0.3.0 is published: until then, the example's command cannot run.

## Verification

The tool's guard is tested against a simulated GitHub and through the installed package. Live dry runs in a fixture repository are recorded in the [abandonment-cleanup evidence](../evidence/abandonment-cleanup/README.md). The workflow file's YAML, trigger, condition, wait, permissions, token and command are checked by `test/abandonment-workflow-example.test.mts`. That test also checks that the command and its options exist in the CLI's help, and runs `actionlint` when it is installed. The workflow itself has not run on GitHub.
