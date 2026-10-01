---
"sarif-to-comment": minor
---

Suggestion pull requests stay safe when the original pull request's branch moved after the review, including after a force-push. `publish` and `validate` now test whether the reviewed commit is still part of the branch instead of requiring it to be the head:

- **The branch only moved forward:** suggestion pull requests are created on the reviewed commit, as for the head. This was refused before.
- **The history was rewritten** (a force-push, amend or rebase dropped the reviewed commit): suggestion pull requests are still created on the reviewed commit, after a projection of what merging each one would do; see the companion fidelity entry of this release. The rest of the review publishes as before, and a retry never re-decides.
- `close-suggestion-prs` recognizes version 1 and version 2 markers of the suggestion pull request convention.

### `sarif-to-comment validate --file-operations companion`: a reviewed commit the branch has moved past

```diff
-## Review blocked
+## Ready to publish
 
-Nothing was published and no publication state was written.
+The complete document can be published faithfully to acme/widgets#62 at commit `35a2457…`.
 
-**Review blocked:** 1 problem must be resolved before publication; nothing was published.
+Publication would also create 1 draft suggestion pull request into `feature`, labeled `suggestion-pr`. The history of #62 was rewritten after the reviewed commit, so it is proposed on that commit and was projected onto the head `a27db7c…`: merging it applies only its own changes.
 
-- `suggestion-pr-historical-unsupported`: The reviewed commit 35a2457… is no longer the pull request's head a27db7c…. Proposing a suggestion on top of later commits needs a check that the reviewed commit is still part of the branch, which is not yet supported. Review the current head, or publish without suggestion pull requests.
+**Review prepared:** 0 inline comment(s) and 2 general section(s) for commit `35a2457…`.
```

### `sarif-to-comment publish --file-operations companion`: the published outcome

```diff
-Suggestion pull requests (drafts into `feature`, labeled `suggestion-pr`):
+Suggestion pull requests (drafts into `feature`, labeled `suggestion-pr`, proposed on the reviewed commit and projected onto the head `a27db7c…`):
```
