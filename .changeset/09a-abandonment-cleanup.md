---
"sarif-to-comment": minor
---

**Close suggestion pull requests only when their original was abandoned.** `close-suggestion-prs --original N --if-abandoned` (library: `originalPullNumber` with `requireAbandonedOriginal: true`) is meant for automation that runs when a pull request is closed without merging.

- **The check.** Before anything is listed, it reads pull request N. It goes on only if that fresh read shows N closed without merging, and the cleanup is then exactly the targeted cleanup of `--original N`.
- **A skip.** If N is open (for example, reopened after it was closed), merged or not found, nothing is checked or closed. The status is `original-not-abandoned` (exit status 0), with the note `original-pull-request-not-abandoned` naming N's state.
- **A failed read.** If N cannot be read, the command fails (exit status 1) and closes nothing.
- **Usage.** `--if-abandoned` without `--original` is a usage error (a `TypeError` in the library).
- **No waiting.** The command never waits: a grace period before it runs belongs to the caller. It never deletes a branch, and never reopens or recreates a suggestion pull request.

The source repository has an example GitHub Actions workflow (`docs/examples/abandonment-cleanup.workflow.yml`, explained in `docs/examples/abandonment-cleanup.md`). It waits two minutes after a pull request is closed without merging, and then runs the guarded command. It is documentation only. It has not been run on GitHub, and it uses the workflow's own token, which this release does not yet claim to support.
