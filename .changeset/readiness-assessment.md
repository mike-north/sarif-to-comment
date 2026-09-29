---
"sarif-to-comment": minor
---

Add optional whole-review readiness assessment: `validateSarifReview` in the library and `sarif-to-comment validate` in the CLI. It runs the publisher's own checks (schema, approval hold, source consistency, supported representation, placement, limits and the authenticated account) against the pull request and reports `ready`, `blocked` with its problems, or `incomplete` when the check could not be completed. It reads GitHub but never writes to it, takes no state path and writes no file. A `ready` result grants nothing: `publish` still performs every check itself.
