---
"sarif-to-comment": minor
---

`--allow-suggestion-prs` (`allowSuggestionPullRequests`) now means: use a suggestion pull request where one is needed and can be made; otherwise behave, for that change, exactly as if suggestion pull requests were not allowed. A suggestion pull request cannot be made when the pull request's history was rewritten after the review and the suggestion cannot be re-applied onto the new head; when the pull request is from a fork (or its head repository was deleted) or merges into a branch other than the default branch, neither of which is supported yet; when a created file is over 1,000,000 bytes; or when its description would be over 60,000 characters. Then:

- **A whole-file creation or deletion** is proposed in the review body, exactly as without `--allow-suggestion-prs`, and the review publishes with a `suggestion-pr-fallback` warning that names the change, each reason and this handling. The review-body form's own limits then apply: a created file too large for the review body is refused exactly as without suggestion pull requests.
- **An explicit group, or a fix with several changes,** refuses the whole review before anything is written (`suggestion-group-pr-unavailable`, exit status 2), because nothing else keeps its changes together. The problem names the group or fix and each reason, and offers the ways forward: remedy the reason where there is one (review the current head again, reduce the file, shorten the messages), or remove the group (for a fix, split it into separate findings). A review mixing such a group with suggestions that can be made is refused as a whole.

Suggestions that can be re-applied behave as before, and `validate` reports the same outcome and warnings before anything is written. The review body no longer has a "**Suggestion pull request not created:**" section.

Warnings are no longer easy to miss. A published or ready outcome with warnings states their count and nature directly under its heading, for every warning code, for example `**Published with 1 warning:** 1 suggestion pull request was not created; its change is shown in the review.` The warnings are in `diagnostics` in the library, JSON and TOON, and the human CLI prints each once on stderr. The exit status of a successful publication with warnings stays 0.

Codes, none of them released before: `suggestion-pr-not-reapplied` is renamed `suggestion-pr-fallback`; `suggestion-group-pr-unavailable` (error) is new; `suggestion-pr-fork-unsupported`, `suggestion-pr-base-unsupported`, `suggestion-file-too-large` and `suggestion-body-too-large` are no longer reported, because those cases now fall back.

### `sarif-to-comment publish --allow-suggestion-prs`: a pull request into a branch other than the default branch, proposing a new file

stdout (exit status 2 before, 0 now):

```diff
-## Review blocked
+## Draft review published
 
-Nothing was published and no publication state was written. 1 problem must be resolved before publication.
+**Published with 1 warning:** 1 suggestion pull request was not created; its change is shown in the review.
+
+Created the draft [review 5371460927](…) on acme/widgets#79 at commit `0a75e46…`. It stays a draft until someone submits it on GitHub.
```

stderr:

```diff
-✖ error  Suggestion pull requests need a pull request into the default branch  [suggestion-pr-base-unsupported]
-  acme/widgets
-  Suggestion pull requests are not yet supported for a pull request into `release`, which is not the default branch `main` of acme/widgets: following a suggestion through a pull request that merges into another branch (for example one of a stack of pull requests, which GitHub retargets when the branch below it merges) is not built yet.
-  → Publish without suggestion pull requests.
+▲ warning  A change is handled as if suggestion pull requests were not allowed  [suggestion-pr-fallback]
+  docs/new.md · /runs/0/results/0
+  Suggestion pull requests are allowed, but the creation of `docs/new.md` is not proposed as one: the pull request merges into `release`, which is not the default branch `main` of acme/widgets, and suggestion pull requests are not yet supported for such a pull request. It is handled as if suggestion pull requests were not allowed: the review body proposes it, with its findings.
 
-1 error
+1 warning
```

A fork is handled the same way (``the pull request's head branch `feature` is in the fork someone/widgets, and suggestion pull requests are not yet supported for a pull request from a fork``), where `suggestion-pr-fork-unsupported` refused the review before.

### `sarif-to-comment validate --allow-suggestion-prs`: a created file over 1,000,000 bytes

```diff
-✖ error  A proposed file is too large for a suggestion pull request  [suggestion-file-too-large]
-  /runs/0/results/0
-  docs/big.md: the proposed file is 1000001 bytes; a suggestion pull request carries at most 1000000 bytes per file.
-  → Reduce the proposed file, or propose it outside the review.
+✖ error  The review body would be too long  [body-too-large]
+  The review body is … characters; the limit is 60000. Whole-file proposals in the body: docs/big.md (… characters). Nothing is truncated or split.
+  → Publish fewer general findings, or enable suggestion pull requests for whole-file proposals.
+
+▲ warning  A change is handled as if suggestion pull requests were not allowed  [suggestion-pr-fallback]
+  docs/big.md · /runs/0/results/0
+  Suggestion pull requests are allowed, but the creation of `docs/big.md` is not proposed as one: `docs/big.md` is 1000001 bytes, and a suggestion pull request carries at most 1000000 bytes per file. It is handled as if suggestion pull requests were not allowed: the review body proposes it, with its findings.
+  → To propose the change as a suggestion pull request, reduce the proposed file to at most 1,000,000 bytes.
 
-1 error
+1 error, 1 warning
```

The review is still refused, now exactly as it is without suggestion pull requests.

### `sarif-to-comment validate --allow-suggestion-prs`: a deletion that cannot be re-applied after a force-push

stdout:

```diff
 ## Ready to publish
 
+**Ready to publish with 1 warning:** 1 suggestion pull request would not be created; its change would be shown in the review.
+
 The complete document can be published faithfully to acme/widgets#75 at commit `a968709…`.
```

stderr:

```diff
-▲ warning  A suggestion pull request is not created after a rewritten history  [suggestion-pr-not-reapplied]
-  /runs/0/results/1
-  The history of #75 was rewritten after the reviewed commit, so the suggestion pull request `Suggestion for #75: delete obsolete.txt` would have to be re-applied onto commit `8c35033…`, and it cannot be: `obsolete.txt` differs from the reviewed file. It is not created; its change and findings are presented in the review body.
-  → Review the pull request's new head, and publish the suggestion from there.
+▲ warning  A change is handled as if suggestion pull requests were not allowed  [suggestion-pr-fallback]
+  obsolete.txt · /runs/0/results/1
+  Suggestion pull requests are allowed, but the deletion of `obsolete.txt` is not proposed as one: the history of #75 was rewritten after the reviewed commit, and it cannot be re-applied onto commit `8c35033…` because `obsolete.txt` differs from the reviewed file. It is handled as if suggestion pull requests were not allowed: the review body proposes it, with its findings.
+  → To propose the change as a suggestion pull request, review the pull request's current head again and publish that review.
 
 1 warning
```

### `sarif-to-comment publish --allow-suggestion-prs`: the review body for that deletion

```diff
-**Suggestion pull request not created:** the history of #75 was rewritten after the reviewed commit, and this change cannot be re-applied onto commit 8c35033…, the head of #75, because there:
-
-- `obsolete.txt` differs from the reviewed file
-
-It would have proposed this change:
-
-- Deleted file [obsolete.txt at a968709](…): the whole file is removed
+**Proposed file deletion:** [obsolete.txt at a968709](…)
+
+The whole file is removed; this is not a proposal to empty it.
 
 Obsolete.
```

### `sarif-to-comment publish --allow-suggestion-prs`: a group that cannot be re-applied after a force-push

stdout (exit status 0 before, 2 now):

```diff
-## Draft review published
+## Review blocked
 
-Created the draft [review 5361383437](…) on acme/widgets#76 at commit `897bc5f…`. It stays a draft until someone submits it on GitHub.
+Nothing was published and no publication state was written. 1 problem must be resolved before publication.
```

stderr:

```diff
-▲ warning  A suggestion pull request is not created after a rewritten history  [suggestion-pr-not-reapplied]
+✖ error  A group's suggestion pull request cannot be made  [suggestion-group-pr-unavailable]
   /runs/0/results/0
-  The history of #76 was rewritten after the reviewed commit, so the suggestion pull request `Suggestion for #76: reword (2 changes)` would have to be re-applied onto commit `f2f401e…`, and it cannot be: `docs/sample.md` line 6 differs from the reviewed text. It is not created; its change and findings are presented in the review body.
-  → Review the pull request's new head, and publish the suggestion from there.
+  Suggestion pull requests are allowed, but suggestion group "reword" cannot become one: the history of #76 was rewritten after the reviewed commit, and its 2 changes cannot be re-applied onto commit `f2f401e…` because `docs/sample.md` line 6 differs from the reviewed text. Without a suggestion pull request, a group cannot be published: its changes are accepted together or not at all, and are never split or published in part.
+  → Review the pull request's current head again, and publish that review.
+  → Or remove the group (`ungroup-fixes`), so that its changes are published on their own.
 
-1 warning
+1 error
```

### `sarif-to-comment publish --format json`: a published review with a warning

```diff
 {
   "command": "publish",
   "status": "published",
   …
-  "message": "## Draft review published\n\nCreated the draft …",
+  "message": "## Draft review published\n\n**Published with 1 warning:** 1 suggestion pull request was not created; its change is shown in the review.\n\nCreated the draft …",
   "diagnostics": [
     {
       "severity": "warning",
-      "code": "suggestion-pr-not-reapplied",
+      "code": "suggestion-pr-fallback",
       …
```
