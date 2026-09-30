---
"sarif-to-comment": minor
---

Suggestion pull requests follow a tool-neutral **suggestion pull request convention**: what GitHub shows names neither SARIF nor this tool, and any tool could create them or tidy them up. Each carries the repository's canonical label, `suggestion-pr` unless the repository names another in an optional, hand-maintained `.github/suggestion-prs.json` (`{ "label": "…" }`) on its default branch; `publish`, `validate` and `close-suggestion-prs` resolve it the same way. An invalid file blocks the review (and stops cleanup), naming the file and field; a file that can't be read is an error, never a silent default. Branches are named `suggestion-pr/<pull>/<id>`, bodies end with a hidden `<!-- suggestion-pr {…} -->` marker and briefly explain the lifecycle, and cleanup closes any suggestion pull request that conforms to the convention.

The options say what kind of value they take: `allowSuggestionPullRequests` (`--allow-suggestion-prs`) opts in, `pullRequestLabels` (`--pr-labels a,b,c`) adds extra existing labels (deduplicated case-insensitively; no commas), and `markSuggestionPullRequestsReady` (`--mark-suggestion-prs-ready`) creates them ready for review instead of as drafts. There is no per-call label option: `close-suggestion-prs --label` remains only to sweep suggestions left under a previously configured label. Every label must already exist, or the whole review is blocked before anything is written, and `validate` says the same. Suggestion pull requests are supported for originals from the same repository whose base is the default branch; for forks and other bases, the refusal names the missing capability. Nothing released in 0.2.x changes: without the opt-in, requests, reviews and state files are unchanged.

### `sarif-to-comment publish --help` (and the flag-only form): suggestion pull request options

The options of the unreleased suggestion pull requests are renamed; the per-call label is removed.

```diff
   sarif-to-comment publish --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA
                            --state ABSOLUTE_FILE [--source-root ABSOLUTE_FILE_URI]
                            [--old-source-commit FULLSHA] [--ignore-approval-hold]
-                           [--submit] [--suggestion-prs [--suggestion-label NAME]]
+                           [--submit] [--allow-suggestion-prs [--pr-labels A,B,C]
+                           [--mark-suggestion-prs-ready]]
                            [--format human|json]
@@
-  --suggestion-prs               Propose whole-file creations and deletions,
-                                 and grouped changes (acceptanceGroup), as draft
-                                 suggestion pull requests into the pull
-                                 request's head branch, linked from the review.
-  --suggestion-label NAME        Existing label for suggestion pull requests
-                                 (default: suggestion). Needs --suggestion-prs.
+  --allow-suggestion-prs         Allow suggestion pull requests: propose
+                                 whole-file creations and deletions, and grouped
+                                 changes (acceptanceGroup), as pull requests
+                                 into the pull request's head branch, linked
+                                 from the review. They carry the repository's
+                                 suggestion label (suggestion-pr, or the label
+                                 in .github/suggestion-prs.json on the default
+                                 branch), which must already exist.
+  --pr-labels A,B,C              Extra existing labels for suggestion pull
+                                 requests, comma-separated. Needs
+                                 --allow-suggestion-prs.
+  --mark-suggestion-prs-ready    Create suggestion pull requests ready for
+                                 review instead of as drafts. Needs
+                                 --allow-suggestion-prs.
```

### `sarif-to-comment validate --help`: the same options

```diff
   sarif-to-comment validate --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA
                             [--source-root ABSOLUTE_FILE_URI] [--old-source-commit FULLSHA]
                             [--ignore-approval-hold] [--submit]
-                            [--suggestion-prs [--suggestion-label NAME]] [--format human|json]
+                            [--allow-suggestion-prs [--pr-labels A,B,C] [--mark-suggestion-prs-ready]]
+                            [--format human|json]
```

### `sarif-to-comment close-suggestion-prs --help`: the label is the repository's

```diff
-Closes this tool's open suggestion pull requests (made by publish
---suggestion-prs) whose original pull request has merged or closed. They are
-recognized by the marker in their description, never by their title. A
+Closes open suggestion pull requests (made by publish --allow-suggestion-prs,
+or by any tool following the suggestion pull request convention) whose
+original pull request has merged or closed. They are recognized by the marker
+in their description, never by their title. They carry the repository's
+suggestion label: suggestion-pr, or the label in .github/suggestion-prs.json
+on the default branch; an invalid file stops the command. A
 suggestion is closed only after its original has been read and found merged
@@
   --repo OWNER/REPO              Repository whose suggestion pull requests are checked.
-  --label NAME                   The suggestion label (default: suggestion).
+  --label NAME                   Check this label instead of the repository's
+                                 suggestion label, for suggestions left under a
+                                 previously configured label.
```
