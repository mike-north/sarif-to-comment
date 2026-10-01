---
"sarif-to-comment": minor
---

**Structured diagnostics, rendered for agents and for people.** Errors, warnings and notes are now modelled once. Every library outcome and every CLI document carries `diagnostics`, always present and ordered errors, warnings, notes. Each diagnostic has a `severity`, a stable kebab-case `code`, a one-line `title`, a Markdown `message`, and, where they apply, a `location` (`pointer`, `path`, `startLine`, `endLine`), a `subject` and `remedies`. The new public types are `IDiagnostic`, `IDiagnosticLocation` and `DiagnosticSeverity`. The package ships `docs/diagnostics.md`, which catalogs every code with its severity, meaning and typical remedies, and `docs/diagnostic.v1.schema.json`, the version 1 JSON Schema of the shape. Codes are public API from this release.

- **Compatible fields.** Every `problems` entry keeps its `message`, `pointer` and `path`, first and unchanged, and gains the diagnostic fields. The same holds for the `warnings` of an `add-staged-changes` receipt and for inspection's `view.diagnostics`. `markdown` fields keep their wording, existing keys keep their order, and `diagnostics` is appended last.
- **Breaking for TypeScript code that builds these objects.** `IProblem` and `IInspectionDiagnostic` now extend `IDiagnostic`, so `severity`, `code` and `title` are required. Code that only reads them is unaffected; code that constructs them, such as a test double, must supply them.
- **Renamed codes.** 0.2.1 named codes only in its Markdown problem lists. Five are renamed to say what they mean: `inline-unavailable` → `inline-placement-unavailable`, `invocation-failed` → `tool-invocation-failed`, `tool-notification-error` → `tool-reported-errors`, `repository-mismatch` → `provenance-repository-mismatch`, and `provenance-conflict` → `provenance-revision-conflict`.
- **Codes no longer reported**, because what they refused is now delivered or reported another way (see the delivery policy, file operation and earlier-commit entries): `suggestion-not-inline`, `suggestion-fence-unverified`, `suggestion-blank-only-unverified`, `suggestion-crlf-unverified` and `suggestion-final-newline-unverified` (now `delivery-unavailable`); `fix-multiple-files-unsupported` and `fix-multiple-replacements-unsupported`; `fix-alternatives-unsupported`; and `suggestion-historical-unsupported`. `file-operation-unsupported` now refuses only an `edit` operation.
- **Breaking: human output.** Problems and warnings move from stdout to stderr. The default `human` format keeps the primary result on stdout and writes each diagnostic to stderr as a block: a severity badge, the title, the code, where it is, the message wrapped to the terminal's width, and `→` remedies, closed by a summary line. `validate` and `publish` print their outcome on stdout without repeating its problems and warnings, and a refusal writes only its file notes to stdout. The library's `markdown` and the JSON and TOON `message` keep the full report, one list item per diagnostic; a message's own lines, such as the obstacles a `delivery-unavailable` error lists, are indented so they stay nested under its item. Usage errors are diagnostics too.
- **Warnings are stated, and stated on every call.** An outcome with warnings states them in a headline under its heading, such as `**Published with 1 warning:** Taxonomy classifications are not shown.`. A publication's preparation warnings are now recorded with it in the state file, and every later `publish` with the same state path reports them again, including a retry that finds the review already published. In 0.2.1 a retry reported none. State files written by 0.2.1 recorded no warnings, so their later calls report none.
- **`--format toon`** prints the JSON document encoded as [TOON](https://toonformat.dev), for token-efficient agent use; decoding it gives the JSON document exactly.
- **`--color auto|always|never`**, then `FORCE_COLOR` (which wins over `NO_COLOR`, as in Node.js), then `NO_COLOR`, decide color; by default only a terminal gets color. Output that is not a terminal is plain and unwrapped. JSON and TOON never carry color.
- **Dependencies.** chalk 6 and `@toon-format/toon` are new runtime dependencies. Both are ES modules without dependencies, loaded with `import()` only when needed, so the package stays CommonJS and `engines.node` stays `>=22`.

### `sarif-to-comment publish` on a document with an approval hold (human)

stdout:

```diff
 ## Review blocked
 
-Nothing was published and no publication state was written.
-
-**Review blocked:** 1 problem must be resolved before publication; nothing was published.
-
-- `approval-hold` at `/runs/0/results/0`: Awaiting approval: the whole review is held. Resolve the hold or use the explicit override.
+Nothing was published and no publication state was written. 1 problem must be resolved before publication.
```

stderr:

```diff
+✖ error  The review is held for approval  [approval-hold]
+  /runs/0/results/0
+  Awaiting approval: the whole review is held. Resolve the hold or use the explicit override.
+  → Resolve the hold in the SARIF.
+  → Or publish deliberately despite it with `--ignore-approval-hold` (`ignoreApprovalHold`).
+
+1 error
```

### `sarif-to-comment publish` with a warning, then retried with the same `--state`

First call, stdout:

```diff
 ## Draft review published
 
+**Published with 1 warning:** Taxonomy classifications are not shown.
+
 Created the draft [review 5000](https://github.com/octo/calc/pull/12#pullrequestreview-5000) on octo/calc#12 at commit `4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e`. It stays a draft until someone submits it on GitHub.
-
-**Review prepared:** 1 inline comment(s) and 0 general section(s) for commit `4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e`.
-
-**Warnings:**
-
-- `taxa-uninterpreted` at `/runs/0/results/0`: Taxonomy classifications are retained in evidence but not rendered in the review.
```

The retry, stdout:

```diff
 ## Draft review published
 
+**Published with 1 warning:** Taxonomy classifications are not shown.
+
 The draft [review 5000](https://github.com/octo/calc/pull/12#pullrequestreview-5000) on octo/calc#12 at commit `4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e` was already published; its completion is recorded at `/var/lib/my-linter/acme-calc-12.json`. Nothing was sent.
```

Both calls, stderr:

```diff
+▲ warning  Taxonomy classifications are not shown  [taxa-uninterpreted]
+  /runs/0/results/0
+  Taxonomy classifications are retained in evidence but not rendered in the review.
+
+1 warning
```

### `sarif-to-comment inspect` (human): a usage error

```diff
-sarif-to-comment: missing required option --sarif
-Run sarif-to-comment inspect --help for usage.
+✖ error  The command line is not valid  [usage-error]
+  inspect
+  missing required option --sarif
+  → Run `sarif-to-comment inspect --help` for usage.
+
+1 error
```

### `sarif-to-comment inspect --sarif broken.sarif.json --format json`: problems gain the diagnostic fields, and `diagnostics` is appended

```diff
 {
   "command": "inspect",
   "status": "invalid",
   "problems": [
     {
       "message": "`/runs/0/results/0` must have required property 'message'.",
-      "pointer": "/runs/0/results/0"
+      "pointer": "/runs/0/results/0",
+      "severity": "error",
+      "code": "sarif-schema-invalid",
+      "title": "The document is not valid SARIF 2.1.0",
+      "location": {
+        "pointer": "/runs/0/results/0"
+      },
+      "remedies": [
+        "Correct the document so that it conforms to the SARIF 2.1.0 schema."
+      ]
     }
-  ]
+  ],
+  "diagnostics": [
+    {
+      "severity": "error",
+      "code": "sarif-schema-invalid",
+      "title": "The document is not valid SARIF 2.1.0",
+      "message": "`/runs/0/results/0` must have required property 'message'.",
+      "location": {
+        "pointer": "/runs/0/results/0"
+      },
+      "remedies": [
+        "Correct the document so that it conforms to the SARIF 2.1.0 schema."
+      ]
+    }
+  ]
 }
```
