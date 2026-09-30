---
"sarif-to-comment": minor
---

Errors, warnings and notes are now modelled once, as structured diagnostics, and rendered for agents and for people. Every library outcome and every CLI document carries `diagnostics`, always present and ordered errors, warnings, notes. Each diagnostic has a `severity`, a stable kebab-case `code`, a one-line `title`, a Markdown `message`, and, where they apply, a `location` (`pointer`, `path`, `startLine`, `endLine`), a `subject` and `remedies`. The new public types are `IDiagnostic`, `IDiagnosticLocation` and `DiagnosticSeverity`. The package ships `docs/diagnostics.md`, which catalogs every code with its severity, meaning and typical remedies, and `docs/diagnostic.v1.schema.json`, the version 1 JSON Schema of the shape.

Compatibility: every `problems` entry keeps its `message`, `pointer` and `path`, first and unchanged, and gains the diagnostic fields. The same holds for the `warnings` of an `add-staged-changes` receipt and for inspection's `view.diagnostics` (the view version is unchanged). `IProblem` now extends `IDiagnostic`. `markdown` fields keep their wording. Existing keys keep their order, and `diagnostics` is appended last. Exit statuses and all behavior are unchanged.

Codes renamed before their first release as public codes. They appear under their new names in Markdown lists that name codes:

- `inline-unavailable` → `inline-placement-unavailable`
- `invocation-failed` → `tool-invocation-failed`
- `tool-notification-error` → `tool-reported-errors`
- `repository-mismatch` → `provenance-repository-mismatch`
- `provenance-conflict` → `provenance-revision-conflict`
- `suggestion-historical-unsupported` → `suggestion-reviewed-commit-not-head`

The CLI's `--format` takes `human|json|toon`. `toon` prints the JSON document encoded as [TOON](https://toonformat.dev) for token-efficient agent use; decoding it gives the JSON document exactly. The default `human` format keeps the primary result on stdout and writes each diagnostic to stderr as a block, closed by a summary line. A block has a severity badge, the title, the code, where it is, the message wrapped to the terminal's width, and `→` remedies. A refusal now writes only its file notes to stdout. `inspect` lists its warnings, and `add-staged-changes` its `Warning:` lines, as diagnostics on stderr. `validate`, `publish` and `close-suggestion-prs` still print their full Markdown report on stdout. Color comes from chalk and is decided by the new `--color auto|always|never`, then `FORCE_COLOR`, then `NO_COLOR`; without an explicit choice, only a terminal gets color. Output that is not a terminal is plain and unwrapped. JSON and TOON never carry color.

chalk 6 and `@toon-format/toon` are new runtime dependencies. Both are ES modules without dependencies, loaded with `import()` only when needed, so the package stays CommonJS and `engines.node` stays `>=22`.

### `sarif-to-comment inspect --help`: output options

```diff
-  --format human|json            Output format (default human). JSON prints one
-                                 document on stdout for every outcome.
+  --format human|json|toon       Output format (default human). JSON and TOON
+                                 print one document on stdout for every outcome.
+  --color auto|always|never      Color diagnostics (default auto: only on a
+                                 terminal; NO_COLOR and FORCE_COLOR apply).
```

Every command's synopsis changes from `[--format human|json]` to `[--format human|json|toon]` in the same way.

### `sarif-to-comment inspect --sarif broken.sarif.json` (human): the refusal moves to stderr as a diagnostic

stdout:

```diff
-**Invalid SARIF:** the document does not conform to the SARIF 2.1.0 schema, so it was not interpreted.
-
-- `/runs/0/results/0` must have required property 'message'.
```

stderr:

```diff
+✖ error  The document is not valid SARIF 2.1.0  [sarif-schema-invalid]
+  /runs/0/results/0
+  `/runs/0/results/0` must have required property 'message'.
+  → Correct the document so that it conforms to the SARIF 2.1.0 schema.
+
+1 error
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

### `sarif-to-comment inspect --sarif broken.sarif.json --format toon` (new)

```diff
+command: inspect
+status: invalid
+problems[1]:
+  - message: `/runs/0/results/0` must have required property 'message'.
+    pointer: /runs/0/results/0
+    severity: error
+    code: sarif-schema-invalid
+    title: The document is not valid SARIF 2.1.0
+    location:
+      pointer: /runs/0/results/0
+    remedies[1]: Correct the document so that it conforms to the SARIF 2.1.0 schema.
+diagnostics[1]:
+  - severity: error
+    code: sarif-schema-invalid
+    title: The document is not valid SARIF 2.1.0
+    message: `/runs/0/results/0` must have required property 'message'.
+    location:
+      pointer: /runs/0/results/0
+    remedies[1]: Correct the document so that it conforms to the SARIF 2.1.0 schema.
```
