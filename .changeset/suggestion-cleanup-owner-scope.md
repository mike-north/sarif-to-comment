---
"sarif-to-comment": minor
---

`close-suggestion-prs` (`closeSuggestionPullRequests`) now closes only the suggestion pull requests you opened, and can no longer spend a large part of your rate limit on a mistyped or overly broad label.

- **Whose suggestions.** `--owner me|all` (library `owner: 'me' | 'all'`) is about who opened the *suggestion* pull request, not the original. The default, `me`, closes only those opened by the token's account (read once with `GET /user`, and only when needed); `all` closes any conforming suggestion pull request. One someone else opened is reported with the new result `other-owner` and left open.
- **`not-ours` is renamed `not-conforming`**, for a pull request that does not follow the suggestion pull request convention. Neither name was released before.
- **Discovery by branch.** The default sweep lists the repository's `suggestion-pr/` branches with their open pull requests in one paginated GraphQL query, so its cost grows with suggestion branches, not with the repository. The suggestion label is now a confirming check on each pull request found, not the search. `--label NAME` checks the open pull requests carrying that label instead, and still skips the repository configuration.
- **Count first, with a limit.** A sweep counts its candidates in its first request. Over `--max-candidates N` (`maxCandidates`, default 500) nothing is checked: the status is `too-many-candidates` (exit 1) with a `suggestion-pr-candidates-over-limit` error stating the count, the limit and how to narrow the run.
- **Early exit for a wrong label.** A `--label` sweep whose first 20 pull requests show no suggestion marker and no `suggestion-pr/` branch stops with the status and warning `label-not-suggestion-prs` (exit 2), inspecting only the listing. `--force` (`force: true`) checks them anyway.
- **Counts.** The outcome and the JSON document add `owner` and `counts` (`candidates`, `checked`, `labeled`, `conforming`), and the report states how many pull requests were checked.

Closing by default with `--dry-run` to preview, the exit codes 0 / 2 / 3 / 1, a 404 on close counting as `permission-limited`, and `--label` skipping the configuration read are unchanged.

### `sarif-to-comment close-suggestion-prs --repo octo/widgets --dry-run`: a suggestion someone else opened

stdout (exit status 0 before and after):

```diff
 ## Suggestion pull request cleanup: dry run
 
-Checked the open pull requests labeled `suggestion-pr` in octo/widgets (the default suggestion label).
+Checked the open pull requests on `suggestion-pr/` branches in octo/widgets; the suggestion label is `suggestion-pr` (the default suggestion label). Only suggestion pull requests opened by this account are closed.
+
+Pull requests checked: 5 (5 labeled, 4 conforming).
 
 Original pull requests:
 
 - #36: open
 - #37: closed without merging
 
 Suggestion pull requests:
 
 - #38 (for #36): left open, because the original is still open
 - #39 (for #36): left open, because the original is still open
 - #40 (for #37): would be closed
-- #42 (for #37): would be closed
+- #42 (for #37): left open, because someone else opened it
 
 This was a dry run: nothing was closed.
```

stderr:

```diff
 ℹ note  A pull request does not follow the suggestion pull request convention  [suggestion-pr-not-conforming]
   octo/widgets#41
-  #41 does not follow the suggestion pull request convention (it has the label but no suggestion marker), so it was not touched.
+  #41 does not follow the suggestion pull request convention (its branch is under `suggestion-pr/`, but it has no suggestion marker), so it was not touched.
```

In `--format json`, the result `not-ours` is now `not-conforming`, and `owner` and `counts` follow `dryRun` and `suggestions`.

### `sarif-to-comment close-suggestion-prs --repo octo/widgets --label bug`: a label on ordinary pull requests

Before, every open `bug` pull request was listed and checked (here 30, one note each); now one request, and nothing is checked. stdout (exit status 0 before, 2 now):

```diff
-## Suggestion pull request cleanup complete
+## Suggestion pull request cleanup stopped: the label does not mark suggestion pull requests
 
-Checked the open pull requests labeled `bug` in octo/widgets (a label given in place of the repository's suggestion label).
-
-Closing never deletes a branch: each proposal branch is left in place.
+Nothing was checked or closed.
```

stderr:

```diff
-ℹ note  A pull request does not follow the suggestion pull request convention  [suggestion-pr-not-conforming]
-  octo/widgets#100
-  #100 does not follow the suggestion pull request convention (it has the label but no suggestion marker), so it was not touched.
-…
-30 notes
+▲ warning  The label does not seem to mark suggestion pull requests  [label-not-suggestion-prs]
+  octo/widgets
+  None of the first 20 of the 30 open pull requests labeled `bug` in octo/widgets has a suggestion marker or a `suggestion-pr/` branch, so the label does not look like a suggestion label, and nothing was checked or closed.
+  → Check the label: `--label` names the label suggestion pull requests were left under.
+  → If the label is right, run again with `--force` (library: `force: true`) to check every pull request carrying it.
+
+1 warning
```

### `sarif-to-comment close-suggestion-prs --help`

```diff
 Usage:
-  sarif-to-comment close-suggestion-prs --repo OWNER/REPO [--label NAME] [--original N]
-                                        [--dry-run] [--format human|json|toon]
+  sarif-to-comment close-suggestion-prs --repo OWNER/REPO [--owner me|all]
+                                        [--label NAME [--force]] [--original N]
+                                        [--max-candidates N] [--dry-run]
+                                        [--format human|json|toon]
```
