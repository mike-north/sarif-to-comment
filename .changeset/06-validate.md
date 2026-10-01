---
"sarif-to-comment": minor
---

**Check a review without publishing it.** The new `sarif-to-comment validate` command and `validateSarifReview` library function run every check `publish` runs (schema, approval hold, source consistency, supported representation, placement, delivery, limits, the authenticated account and, when suggestion pull requests are planned, the repository's labels and permissions) against the pull request, and stop before anything is written. They take the same options as `publish` except the state path, write nothing to GitHub and write no file.

- **Outcomes.** `ready` (exit status 0) with what publication would create; `blocked` (exit status 2) with every problem; or `incomplete` (exit status 1) when the check could not be completed, for example when the network or a source read failed.
- **A pending review of yours blocks.** Because GitHub refuses to create another review, draft or submitted, while the authenticated account has a pending review on the pull request, `validate` reports `blocked` (`pending-review-exists`), naming that review's id and URL. It reads every page of the pull request's reviews and compares authors by numeric user id; other accounts' pending reviews and submitted reviews are ignored, and a review list that cannot be read completely makes the result `incomplete`.
- **Not an approval.** A `ready` result grants nothing: `publish` repeats every check against the pull request as it is then.

### `sarif-to-comment validate` (new)

```text
## Ready to publish

The complete document can be published faithfully to octo/calc#12 at commit `4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e`.

**Review prepared:** 1 inline comment(s) and 0 general section(s) for commit `4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e`.

Nothing was published and no publication state was written.

No pending review of this account was found on the pull request. This is not an approval: publication repeats every check against the pull request as it is then. GitHub can still refuse the review, for example if this account starts a pending review on the pull request before publication.
```
