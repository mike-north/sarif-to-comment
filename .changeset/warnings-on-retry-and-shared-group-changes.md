---
"sarif-to-comment": minor
---

Report a publication's warnings on every retry, and never author a suggestion group that publication would refuse.

- **Warnings are reported by every call for a publication.** Preparation's warnings, such as a `delivery-fallback` warning, were reported only by the call that planned the publication: a retry with the same state path, including one that recovers a lost response or confirms a delivery after `uncertain`, reported none. They are now recorded in the state file with the publication, in the same write that claims it, and every later `publish` with that state path reports them identically: in `diagnostics`, in the headline under the heading, and on stderr in human output. An `uncertain` outcome carries them too, before its `delivery-unconfirmed` warning; a `rejected` outcome, where the review was not created, does not. The full Markdown of an outcome with warnings (the library's `markdown`, and `message` in JSON and TOON) now ends with the same `**Warnings:**` list on every call, and no longer includes preparation's `**Review prepared:**` summary line.
- **State files.** The record of a publication without suggestion pull requests now holds its warnings as `warnings` (it is version 3, with the delivery policy; see that entry); with suggestion pull requests, the plan gains `warnings`. Earlier versions of the package refuse a version-2 record as corrupt state. State files written before this change recorded no warnings, and later calls with them report none.
- **Grouping never splits a change between a group and a finding outside it.** Two findings may explain one change, for example when `add-staged-changes` gives both the identical fix. `group-fixes` accepted grouping only one of them, and publication then always refused the review with a misleading `overlapping-replacements` error. Now `group-fixes` (`groupSarifFixes`) refuses such a group (exit status 2), naming each finding left outside that carries the identical change, with its current selector, to include it; for a finding in another group, it says to ungroup it first, since groups are never joined. `ungroup-fixes` (`ungroupSarifFixes`) likewise refuses to take out one of two findings that carry the identical change while the other stays, naming the members to ungroup together. Publication reports a document with such a group, for example one written by hand, with the new `suggestion-group-change-shared` error instead of `overlapping-replacements` or `file-operation-conflict`, naming the group and both findings. Grouping both findings, or neither, is unchanged.

### `sarif-to-comment publish` retried with the same `--state`: stdout

A retry now states the warnings the first run reported, as the first run did.

```diff
 ## Draft review published
 
+**Published with 1 warning:** A proposal is delivered by a later mechanism of its delivery list.
+
 The draft [review 42](https://github.com/acme/widgets/pull/7#pullrequestreview-42) on acme/widgets#7 at commit `c0dec0de…` was already published; its completion is recorded at `/var/lib/my-linter/acme-widgets-7.json`. Nothing was sent.
```

### `sarif-to-comment publish` retried with the same `--state`: stderr

```diff
+▲ warning  A proposal is delivered by a later mechanism of its delivery list  [delivery-fallback]
+  /runs/0/results/0
+  The deletion of `obsolete.txt` is delivered as `manual`. `fileOperations` is `[companion, manual]`, set by the caller (`--file-operations`, `delivery.fileOperations`), and the mechanisms listed before it are unavailable:
+
+  - `companion`: The pull request merges into `release`, which is not the default branch `main` of acme/widgets, and suggestion pull requests are not yet supported for such a pull request.
+  → To use an earlier mechanism, remove the obstacle the message names, then publish again.
+  → To refuse rather than fall back, list only the mechanism you require.
+
+1 warning
```

### `sarif-to-comment group-fixes` naming one of two findings that carry the identical change

Previously exit status 0; now exit status 2, and the file is not changed.

```diff
-Grouped 2 findings in review.sarif as suggestion group "retry-with-test": 2 distinct changes to accept together.
-  /runs/0/results/0 (tool "Review agent"): 1 change
-  /runs/0/results/2 (tool "Review agent"): 1 change
-Publication delivers the group whole, by its delivery list (--grouped-edits, or --file-operations when it creates or deletes a whole file), or refuses it.
-Selectors from earlier inspections no longer apply; inspect the file again before another edit.
+review.sarif was not changed.
```

On stderr:

```diff
+✖ error  A group's change is also proposed outside the group  [suggestion-group-change-shared]
+  /runs/0/results/1
+  `/runs/0/results/1` carries the same change as `/runs/0/results/0` of suggestion group "retry-with-test", but would stay outside the group; publication always refuses that, because one change cannot be accepted both as part of the group and on its own. Name it in the group too: `/runs/0/results/1@…`.
+  → Name the finding outside the group in it too (`group-fixes`).
+  → Or take the group's findings that carry the change out of the group (`ungroup-fixes`).
+
+1 error
```
