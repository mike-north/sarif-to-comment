---
"sarif-to-comment": minor
---

**Breaking: publication state files written by this version cannot be continued by 0.2.1.** The state record of a publication now records its resolved delivery policy and its preparation warnings, and is version 3. 0.2.1 refuses such a file as an invalid record ("unsupported record version") and treats it as neither absent nor complete, so finish a publication with the version that started it, or start a new state path. State files written by 0.2.1 (version 1) are still read and continued: they read as draft publications with no warnings.

A publication that creates suggestion pull requests also keeps a plan, and one record per commit, branch, pull request and labels step, beside its state path; keep them with it.

### `sarif-to-comment publish` (0.2.1) with a state path a newer version started

```text
sarif-to-comment: Publication state at /var/lib/my-linter/acme-calc-12.json is not a valid record (unsupported record version); it is not treated as absent.
```

Exit status 1.
