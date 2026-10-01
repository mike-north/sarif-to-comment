---
"sarif-to-comment": minor
---

**Command line: `--version`, new commands in the help, a title covering both review modes, and help that fits 80 columns.**

- **`sarif-to-comment --version`** prints the installed package's version, read from its `package.json` when the command runs (exit status 0). With `--format json` or `toon` it is one document, `{ command, status: "version", version, diagnostics }`. Like `--help`, it can follow a command, which is then not run. 0.2.1 refused it as an unknown option.
- **New commands:** `validate`, `remove-comment`, `group-fixes`, `ungroup-fixes` and `close-suggestion-prs` (see their entries). `publish`, `validate` and the original form gain `--submit`, the delivery options and `--existing-companion`.
- **Output options on every command:** `--format human|json|toon` and `--color auto|always|never` (see the diagnostics entry).
- **The help's title** no longer says the review is always a draft: `--submit` creates a submitted comment review.
- **Help text** fits in 80 columns: prose is filled, synopses wrap by option group, and every command's title is the command and a lowercase phrase. `add-staged-changes --help` opens with its help sentence.
- **Exit statuses** are listed for the new outcomes: `validate`'s `ready` (0), `blocked` (2) and `incomplete` (1); a refused grouping or a stale finding selector (2); and cleanup's statuses.

### `sarif-to-comment --version`

```diff
-sarif-to-comment: unknown option --version
-Run sarif-to-comment --help for usage.
+0.3.0
```

Exit status 1 → 0.

### `sarif-to-comment --help`: title, usage, commands and exit status

```diff
@@ -1,2 +1,2 @@
-sarif-to-comment — author, inspect and publish SARIF as one GitHub draft review
+sarif-to-comment — author, inspect, publish SARIF as a draft or submitted review
 
@@ -4,6 +4,16 @@
   sarif-to-comment init --output FILE [options]
-  sarif-to-comment add-comment --sarif FILE --file PATH --line N (--message TEXT | --message-file FILE|-) [options]
+  sarif-to-comment add-comment --sarif FILE --file PATH --line N
+                   (--message TEXT | --message-file FILE|-) [options]
+  sarif-to-comment remove-comment --sarif FILE --finding SELECTOR [options]
+  sarif-to-comment group-fixes --sarif FILE --finding SELECTOR [...]
+                   --group NAME [options]
+  sarif-to-comment ungroup-fixes --sarif FILE --finding SELECTOR [...] [options]
   sarif-to-comment inspect --sarif FILE [options]
-  sarif-to-comment add-staged-changes --sarif IN --output OUT --worktree DIR --repo OWNER/REPO --commit FULLSHA [options]
-  sarif-to-comment publish --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA --state ABSOLUTE_FILE [options]
+  sarif-to-comment add-staged-changes --sarif IN --output OUT --worktree DIR
+                   --repo OWNER/REPO --commit FULLSHA [options]
+  sarif-to-comment validate --sarif FILE --repo OWNER/REPO --pull N
+                   --commit FULLSHA [options]
+  sarif-to-comment publish --sarif FILE --repo OWNER/REPO --pull N
+                   --commit FULLSHA --state ABSOLUTE_FILE [options]
+  sarif-to-comment close-suggestion-prs --repo OWNER/REPO [options]
   sarif-to-comment --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA
@@ -11,3 +21,8 @@
                    [--old-source-commit FULLSHA] [--ignore-approval-hold]
+                   [--submit] [--delivery PRESET] [--edits LIST]
+                   [--grouped-edits LIST] [--file-operations LIST]
+                   [--companion-bundle BUNDLE] [--pr-labels A,B,C]
+                   [--mark-suggestion-prs-ready] [--existing-companion N]...
   sarif-to-comment [COMMAND] --help
+  sarif-to-comment --version
 
@@ -16,8 +31,19 @@
   add-comment          Add one finding on a line or line range to a SARIF file.
+  remove-comment       Remove a finding and its attached fixes from the SARIF
+                       document.
+  group-fixes          Group fixes of several findings to be accepted together.
+  ungroup-fixes        Remove findings from their suggestion groups.
   inspect              Show the findings, locations and fixes in a SARIF file.
-  add-staged-changes   Add proposed changes from the Git index to a SARIF document.
-  publish              Publish a SARIF file as one GitHub draft pull request review.
-Every command reads and writes ordinary SARIF files; SARIF from any producer
-can be inspected, extended and published without init.
+  add-staged-changes   Add proposed changes from the Git index to a SARIF
+                       document.
+  validate             Check, without publishing, that a SARIF file can be
+                       published.
+  publish              Publish a SARIF file as one GitHub pull request review
+                       (a draft unless --submit).
+  close-suggestion-prs Close suggestion pull requests whose original pull
+                       request has merged or closed.
 
+Every command reads and writes ordinary SARIF files; SARIF from any producer can
+be inspected, extended and published without init.
+
 Publishing without a command (the original form) takes the publish options:
@@
-Credentials (publish only):
+Credentials (validate, publish and close-suggestion-prs only):
   GH_TOKEN, or else GITHUB_TOKEN: a GitHub personal access token or user token.
@@ -48,5 +113,10 @@
 Exit status:
-  0  success; published (or already published)
-  2  refused content: blocked (nothing was published), or invalid/failed input
-  3  uncertain: delivery could not be confirmed; retry with the same --state
-  1  usage error, unreadable file, refused request, or operational failure
+  0  success; published (or already published); ready; cleanup complete
+  2  refused content: blocked (nothing was published), invalid/failed input,
+     a refused grouping, or a stale finding selector; cleanup left pull
+     requests it may not close, or its --label does not mark suggestion
+     pull requests
+  3  uncertain: delivery could not be confirmed; retry with the same --state;
+     cleanup incomplete (safe to run again)
+  1  usage error, unreadable file, refused request, incomplete validation,
+     cleanup candidates over the limit, or operational failure
```
