# Diagnostics: live GitHub evidence

Evidence record · September 30, 2026. It shows the structured diagnostics of [D45](design-decisions.md#d45-model-diagnostics-once-and-render-them-per-audience--owner-decision) ([#38](https://github.com/mike-north/sarif-to-comment/issues/38)) on real GitHub answers, in the TOON, JSON and human formats. The change is presentation only, so this is a spot check; the installed-package formats are verified by `test/installed-diagnostics.test.mts`.

- **Build.** The `dist/` built from commit `ec61055` of this work, run with `node dist/sarif-to-comment.cjs` from the checkout.
- **Fixture repository.** `mike-north/doc-linter`, on the two open fixture pull requests of the [pending-review check evidence](pending-review-check-e2e-evidence.md), both at head `05f323760807c1c30aa7e9efa280d12b8717d7f3`. `validate` only reads GitHub; nothing was written.
- **Document.** The same [`probe.sarif.json`](evidence/pending-review-check/probe.sarif.json): one general finding, ready on any pull request.

| Pull request | Invocation | Exit | Result | Artifact |
|---|---|---|---|---|
| #34 | `validate --format toon` | 0 | `ready`, `diagnostics: []` | [`pr34-validate.toon`](evidence/diagnostics/pr34-validate.toon) |
| #33 | `validate --format toon` | 2 | `blocked`, one `pending-review-exists` error | [`pr33-validate.toon`](evidence/diagnostics/pr33-validate.toon) |
| #33 | `validate --format json` | 2 | the same document as JSON | [`pr33-validate.json`](evidence/diagnostics/pr33-validate.json) |
| #33 | `validate` (human) | 2 | the Markdown report on stdout, one diagnostic block on stderr | [`pr33-validate.stdout.txt`](evidence/diagnostics/pr33-validate.stdout.txt), [`pr33-validate.stderr.txt`](evidence/diagnostics/pr33-validate.stderr.txt) |

## Observations

- On #33 the diagnostic is `pending-review-exists`, an error with the catalog's title and remedies, `subject: mike-north/doc-linter#33`, and no location, because the obstacle is not in the document. The problem keeps its 0.2.x `message` (naming review `5348454897` and its URL) and gains the same fields.
- Decoding `pr33-validate.toon` with `@toon-format/toon` gives a value deeply equal to `pr33-validate.json`.
- The human run was not on a terminal, so stderr is plain and unwrapped: the block and the summary `1 error`. stdout is the report the JSON `message` carries.
- Neither output contains a credential.
