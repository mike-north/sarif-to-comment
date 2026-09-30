---
"sarif-to-comment": minor
---

CLI polish: `--version`, a definitive answer for a mistyped `--original`, a readable refusal message, help reflowed to 80 columns, and usage-error remedies that name the command's own help.

- **`sarif-to-comment --version`** prints the installed package's version, read from its `package.json` when the command runs (exit status 0). With `--format json` or `toon` it is one document, `{ command, status: "version", version, diagnostics }`. Like `--help`, it can follow a command, which is then not run.
- **A pull request that does not exist is a definitive answer in cleanup.** When GitHub answers 404 for an original pull request, its state is the new `not-found` (`OriginalPullRequestState`), which running cleanup again does not change. With `--original N` (`originalPullNumber`) for a number that does not exist, for example a typo, nothing can reference it: cleanup is `complete` (exit status 0) with the new `original-pull-request-not-found` warning, instead of `incomplete` (exit status 3) asking to run it again. In a sweep, a suggestion pull request whose marker names a pull request that does not exist is `not-ours`, not `unverified`. Other failed lookups (403, 5xx, the network) are still `unverified`, and neither state ever leads to a close. TypeScript code that switches exhaustively over `OriginalPullRequestState` needs a `not-found` case.
- **The `review-refused` and `suggestion-pr-step-refused` messages state the refusal once.** GitHub's reason follows the status as its own sentence, for new refusals and for refusals recorded by earlier versions.
- **Help text** fits in 80 columns: prose is filled, synopses wrap by option group, and every title is the command and a lowercase phrase. `remove-comment` and `add-staged-changes` help open with their help sentences.
- **Usage errors in `--format` or `--color`** name the help of the command given (for example ``Run `sarif-to-comment inspect --help` for usage.``) and are about that command, wherever the option stands, as every other usage error already did.

### `sarif-to-comment --version`

```diff
-✖ error  The command line is not valid  [usage-error]
-  unknown option --version
-  → Run `sarif-to-comment --help` for usage.
-
-1 error
+0.3.0
```

Exit status 1 → 0.

### `sarif-to-comment close-suggestion-prs --repo octo/widgets --original 99` (no pull request #99)

stdout:

```diff
-## Suggestion pull request cleanup incomplete
+## Suggestion pull request cleanup complete

 Checked the pull requests that reference #99 in octo/widgets; the suggestion label is `suggestion-pr` (the default suggestion label).

 No suggestion pull requests were found.

-Some results could not be established. Running the cleanup again is safe: it closes only suggestion pull requests that are still open and eligible.
-
 Closing never deletes a branch: each proposal branch is left in place.
```

stderr:

```diff
-▲ warning  An original pull request could not be verified  [original-pull-request-unverified]
+▲ warning  The original pull request was not found  [original-pull-request-not-found]
   octo/widgets#99
-  Pull request #99 could not be verified (GitHub answered the pull request read with HTTP 404: Not Found), so its suggestion pull requests were left open.
-  → Run cleanup again later.
+  octo/widgets has no pull request #99 that this account can read, so no suggestion pull request can reference it.
+  → Check the pull request number.

 1 warning
```

Exit status 3 → 0.

### `sarif-to-comment publish …` refused by GitHub (a pending review already exists): the `review-refused` message

```diff
-GitHub refused the create-review request (HTTP 422): GitHub answered the create-review request with HTTP 422: Unprocessable Entity; User can only have one pending review per pull request It is never resent; this state path now records the refusal. Resolve the cause, then publish under a new state path.
+GitHub refused the create-review request (HTTP 422): Unprocessable Entity; User can only have one pending review per pull request. It is never resent; this state path now records the refusal. Resolve the cause, then publish under a new state path.
```

### `sarif-to-comment inspect --format json --format json`

```diff
 ✖ error  The command line is not valid  [usage-error]
+  inspect
   --format was given more than once
-  → Run `sarif-to-comment --help` for usage.
+  → Run `sarif-to-comment inspect --help` for usage.

 1 error
```

### `sarif-to-comment --help`: usage and commands

```diff
 Usage:
   sarif-to-comment init --output FILE [options]
-  sarif-to-comment add-comment --sarif FILE --file PATH --line N (--message TEXT | --message-file FILE|-) [options]
+  sarif-to-comment add-comment --sarif FILE --file PATH --line N
+                   (--message TEXT | --message-file FILE|-) [options]
   sarif-to-comment remove-comment --sarif FILE --finding SELECTOR [options]
-  sarif-to-comment group-fixes --sarif FILE --finding SELECTOR [...] --group NAME [options]
+  sarif-to-comment group-fixes --sarif FILE --finding SELECTOR [...]
+                   --group NAME [options]
   sarif-to-comment ungroup-fixes --sarif FILE --finding SELECTOR [...] [options]
   sarif-to-comment inspect --sarif FILE [options]
-  sarif-to-comment add-staged-changes --sarif IN --output OUT --worktree DIR --repo OWNER/REPO --commit FULLSHA [options]
-  sarif-to-comment validate --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA [options]
-  sarif-to-comment publish --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA --state ABSOLUTE_FILE [options]
+  sarif-to-comment add-staged-changes --sarif IN --output OUT --worktree DIR
+                   --repo OWNER/REPO --commit FULLSHA [options]
+  sarif-to-comment validate --sarif FILE --repo OWNER/REPO --pull N
+                   --commit FULLSHA [options]
+  sarif-to-comment publish --sarif FILE --repo OWNER/REPO --pull N
+                   --commit FULLSHA --state ABSOLUTE_FILE [options]
   sarif-to-comment close-suggestion-prs --repo OWNER/REPO [options]
   sarif-to-comment --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA
                    --state ABSOLUTE_FILE [--source-root ABSOLUTE_FILE_URI]
-                   [--old-source-commit FULLSHA] [--ignore-approval-hold] [--submit]
-                   [--allow-suggestion-prs [--pr-labels A,B,C] [--mark-suggestion-prs-ready]]
+                   [--old-source-commit FULLSHA] [--ignore-approval-hold]
+                   [--submit] [--allow-suggestion-prs [--pr-labels A,B,C]
+                   [--mark-suggestion-prs-ready]]
   sarif-to-comment [COMMAND] --help
+  sarif-to-comment --version
```

```diff
 Commands:
   init                 Create a SARIF document for your own findings.
   add-comment          Add one finding on a line or line range to a SARIF file.
-  remove-comment       Remove a finding and its attached fixes from the SARIF document.
+  remove-comment       Remove a finding and its attached fixes from the SARIF
+                       document.
   group-fixes          Group fixes of several findings to be accepted together.
   ungroup-fixes        Remove findings from their suggestion groups.
   inspect              Show the findings, locations and fixes in a SARIF file.
-  add-staged-changes   Add proposed changes from the Git index to a SARIF document.
-  validate             Check, without publishing, that a SARIF file can be published.
-  publish              Publish a SARIF file as one GitHub pull request review (a draft
-                       unless --submit).
-  close-suggestion-prs Close suggestion pull requests whose original pull request has
-                       merged or closed.
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
+
+Every command reads and writes ordinary SARIF files; SARIF from any producer can
+be inspected, extended and published without init.
```

and after `--help` among the options:

```diff
   --help                         Show help. Needs no token, makes no request.
+  --version                      Show the package version. Needs no token, makes
+                                 no request.
```

### `sarif-to-comment inspect --help`: the description is filled

```diff
 Shows every finding with its full text, locations, fixes and suggestion group,
-and the selector remove-comment, group-fixes and ungroup-fixes take. Only fix previews are shortened, and visibly so. The file
-is not changed and nothing is contacted. Inspection is not a check that the
-file can be published.
+and the selector remove-comment, group-fixes and ungroup-fixes take. Only fix
+previews are shortened, and visibly so. The file is not changed and nothing is
+contacted. Inspection is not a check that the file can be published.
```

### `sarif-to-comment close-suggestion-prs --help`: title, synopsis, `--original` and exit status 0

```diff
-sarif-to-comment close-suggestion-prs — close suggestion pull requests whose original ended
+sarif-to-comment close-suggestion-prs — close suggestions whose original ended

 Usage:
-  sarif-to-comment close-suggestion-prs --repo OWNER/REPO [--label NAME] [--original N]
-                                        [--dry-run] [--format human|json|toon]
+  sarif-to-comment close-suggestion-prs --repo OWNER/REPO [--label NAME]
+                                        [--original N] [--dry-run]
+                                        [--format human|json|toon]
```

```diff
   --original N                   Check only the pull requests that reference
                                  original pull request N, instead of every open
-                                 pull request with the label.
+                                 pull request with the label. If N does not
+                                 exist, nothing can reference it: the cleanup is
+                                 complete, with a warning.
```

```diff
 Exit status:
-  0  complete: nothing left to do (also a dry run)
+  0  complete: nothing left to do (also a dry run, and an --original pull
+     request that does not exist)
```

The description paragraph is refilled the same way, so its short "…stops the command. A" line is gone.

### Command help titles

```diff
-sarif-to-comment remove-comment — Remove a finding and its attached fixes from the SARIF document.
+sarif-to-comment remove-comment — remove a finding from a SARIF file
-sarif-to-comment group-fixes — Group fixes of several findings to be accepted together.
+sarif-to-comment group-fixes — group fixes to be accepted together
-sarif-to-comment ungroup-fixes — Remove findings from their suggestion groups.
+sarif-to-comment ungroup-fixes — remove findings from their suggestion groups
-sarif-to-comment add-staged-changes — Add proposed changes from the Git index to a SARIF document.
+sarif-to-comment add-staged-changes — add staged Git changes as SARIF fixes
-sarif-to-comment validate — check that a SARIF file can be published as one GitHub review
+sarif-to-comment validate — check that a SARIF file can be published
-sarif-to-comment publish — publish a SARIF file as one GitHub review (a draft unless --submit)
+sarif-to-comment publish — publish a SARIF file as one GitHub review
```

`publish --help` says in its description that the review is a draft unless `--submit` is given.
