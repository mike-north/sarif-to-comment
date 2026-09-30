---
"sarif-to-comment": minor
---

`validate` / `validateSarifReview` now reports `blocked` when the authenticated account already has a pending review on the pull request, because GitHub refuses to create another review, draft or submitted, while it exists. The problem names that review's id and URL. Assessment reads every page of the pull request's reviews and compares authors by numeric user id. Other accounts' pending reviews and all submitted reviews are ignored. A review list that cannot be read completely, or whose data leaves the answer undecided, is reported as `incomplete`. Assessment still writes nothing and takes no state path, and `publish` is unchanged.
