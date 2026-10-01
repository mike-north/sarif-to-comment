---
"sarif-to-comment": minor
---

**Choose where each proposed change goes.** Every proposal in the review is delivered by the first available mechanism of an ordered list for its kind:

| List | Governs | Mechanisms | Default |
| --- | --- | --- | --- |
| `edits` | an edit in no group | `native`, `review-body`, `companion` | `[native]` |
| `groupedEdits` | a suggestion group of edits, or one fix with several changes | `native-batch`, `companion`, `manual-group` | `[native-batch]` |
| `fileOperations` | a whole-file creation or deletion, and any group containing one, as a whole | `manual`, `companion` | `[manual]` |

plus `companionBundle` (`per-unit`, the default, or `single`). Set them with `--edits`, `--grouped-edits`, `--file-operations` and `--companion-bundle` on `publish` and `validate`, or with a preset: `--delivery original-pr` keeps every proposal on the pull request (`edits: [native, review-body]`, `groupedEdits: [native-batch, manual-group]`, `fileOperations: [manual]`), and `--delivery companion` sends every proposal to suggestion pull requests, strictly. Library callers pass `options.delivery` (`edits`, `groupedEdits`, `fileOperations`, `companionBundle`, `preset`) to `publishSarifReview` and `validateSarifReview`. A repository can set the same members in `.github/sarif-to-comment.json` on its default branch; your settings win over it, setting by setting, and it wins over the defaults. The defaults never create a suggestion pull request.

- **What changes for a 0.2.1 document under the defaults.** An edit is still a native suggestion or blocks the review, but the refusal is now one `delivery-unavailable` error whose `native` bullet carries the reason 0.2.1 gave, instead of `suggestion-not-inline`, `suggestion-fence-unverified`, `suggestion-blank-only-unverified`, `suggestion-crlf-unverified` or `suggestion-final-newline-unverified`. Three kinds of proposal that 0.2.1 refused are now delivered: a fix with several changes (0.2.1: `fix-multiple-files-unsupported`, `fix-multiple-replacements-unsupported`) is a native batch when every change can be a native suggestion; a whole-file creation or deletion is a section of the review body (see its entry); and a suggestion group is a native batch, or, when it contains a whole-file operation, the mixed manual group below.
- **No silent substitution.** A later mechanism of a list is an announced fallback: a `delivery-fallback` warning names the proposal, the list, where it was set and why the earlier mechanisms were unavailable, and the exit status stays 0. When no listed mechanism can deliver a proposal, nothing is published: the review is blocked with one `delivery-unavailable` error per proposal, naming the list, where it was set and every obstacle (exit status 2; the library's `blocked` outcome). A one-entry list is strict. When a size limit or a repository check blocks a review that a fallback contributed to, the error says so.
- **Native batches.** A group, or a fix with several changes, whose changes can all be native suggestions is offered as a native batch: each change is a native suggestion that notes its group, and the review body lists them by path and line, to be added to one batch of suggestions and committed together. It is never split: if any change cannot be a native suggestion, the batch is unavailable, naming that change.
- **Proposals made by hand.** `review-body` (an edit), `manual-group` (a group of edits) and `manual` for a group with a whole-file operation (the *mixed manual group*, the default for such a group) put proposals in the review body for the author to make by hand, never as suggestions. An edit made by hand is shown exactly: a link to the replaced lines at the reviewed commit, a code block of the new lines, and `CRLF line endings` or `no newline at end of file` beside it when they apply. A group lists every change by path and line, then each change. A replacement that cannot be shown exactly (for example an invisible or bidirectional character, a no-break space or a zero-width space in its lines or its file's path, mixed line endings, or a line that could open a suggestion block) makes the mechanism unavailable for it, with the remedy `Change the replacement.`. `review-body` and `manual-group` are used only when listed.
- **Limits.** A review body that grows too large with these sections is blocked with `body-too-large`, naming each proposal made by hand and its size. Nothing is split or truncated.
- **Validation and recording.** An invalid setting is a usage error (exit status 1), or a `TypeError` in the library, before anything is read. An invalid configuration file blocks the review with `delivery-configuration-invalid`, one per problem; a file that cannot be read is an error, never a silent default; when your settings decide every list, the file is not read. Your settings are part of the publication's identity, and the resolved policy, with where each value came from, is recorded in the state file before the first write; a retry never reads the configuration again.
- **Suggestion pull request options.** `--pr-labels` and `--mark-suggestion-prs-ready` are accepted with any policy; when no suggestion pull request is planned they have no effect, and a `companion-options-unused` note says so.

### `sarif-to-comment publish --help`: the delivery options

`validate --help` and the original form without a command gain the same options.

```diff
-sarif-to-comment publish — publish a SARIF file as one GitHub draft review
+sarif-to-comment publish — publish a SARIF file as one GitHub review
 
 Usage:
-  sarif-to-comment publish --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA
-                           --state ABSOLUTE_FILE [--source-root ABSOLUTE_FILE_URI]
-                           [--old-source-commit FULLSHA] [--ignore-approval-hold]
-                           [--format human|json]
+  sarif-to-comment publish --sarif FILE --repo OWNER/REPO --pull N
+                           --commit FULLSHA --state ABSOLUTE_FILE
+                           [--source-root ABSOLUTE_FILE_URI]
+                           [--old-source-commit FULLSHA]
+                           [--ignore-approval-hold] [--submit]
+                           [--delivery PRESET] [--edits LIST]
+                           [--grouped-edits LIST] [--file-operations LIST]
+                           [--companion-bundle BUNDLE] [--pr-labels A,B,C]
+                           [--mark-suggestion-prs-ready]
+                           [--existing-companion N]...
+                           [--format human|json|toon]
 
-The same operation as the original form without a command.
+The same operation as the original form without a command. The review is a draft
+unless --submit is given.
 
+Delivery: each proposed change is delivered by the first mechanism its list
+names that can deliver it. Flags override the repository's
+.github/sarif-to-comment.json on the default branch, which overrides the
+defaults; the defaults never create a companion pull request. When no listed
+mechanism can deliver a proposal, nothing is published. review-body,
+manual-group and manual show proposals in the review body for the author to make
+by hand, never as suggestions; review-body and manual-group are used only when
+listed.
+
 Options:
@@
-  --format human|json            Output format (default human). JSON prints one
-                                 document on stdout for every outcome.
+  --submit                       Create the review already submitted, as a
+                                 comment review, instead of a draft. Never
+                                 approves or requests changes. Retry a
+                                 publication with the mode it started with.
+  --delivery original-pr|companion
+                                 A delivery preset: keep every proposal on the
+                                 pull request (original-pr), or send every
+                                 proposal to companion pull requests
+                                 (companion). The flags below override it.
+  --edits LIST                   How an edit in no group is delivered: an
+                                 ordered, comma-separated list of native,
+                                 review-body and companion. The first listed
+                                 mechanism that can deliver it does; a later one
+                                 is a fallback, with a warning. Default: native.
+  --grouped-edits LIST           How a group of edits, or a fix with several
+                                 changes, is delivered, always whole: a list of
+                                 native-batch, companion and manual-group.
+                                 Default: native-batch.
+  --file-operations LIST         How a whole-file creation or deletion, and any
+                                 group containing one, is delivered: a list of
+                                 manual and companion. Default: manual.
+  --companion-bundle per-unit|single
+                                 One companion pull request per proposal
+                                 (per-unit, the default), or one holding them
+                                 all (single).
+  --pr-labels A,B,C              Extra existing labels for companion pull
+                                 requests, comma-separated.
+  --mark-suggestion-prs-ready    Create companion pull requests ready for review
+                                 instead of as drafts.
+  --existing-companion N         An existing suggestion pull request of this
+                                 pull request to list in the review's companion
+                                 index, beside those the review creates. Repeat
+                                 it for several. It must name this pull request
+                                 in its marker; it is never changed.
+  --format human|json|toon       Output format (default human). JSON and TOON
+                                 print one document on stdout for every outcome.
+  --color auto|always|never      Color diagnostics (default auto: only on a
+                                 terminal; NO_COLOR and FORCE_COLOR apply).
 
-Credentials (publish only):
+Credentials (validate, publish and close-suggestion-prs only):
```

### `sarif-to-comment publish`: one fix that replaces lines 7 and 11

Under the default policy, the fix is a native batch: two native suggestions and the guidance that lists them. Exit status 2 → 0.

```diff
-## Review blocked
+## Draft review published
 
-Nothing was published and no publication state was written.
-
-**Review blocked:** 1 problem must be resolved before publication; nothing was published.
-
-- `fix-multiple-replacements-unsupported` at `/runs/0/results/0`: A fix with several replacements is not supported yet.
+Created the draft [review 5000](https://github.com/octo/calc/pull/12#pullrequestreview-5000) on octo/calc#12 at commit `4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e`. It stays a draft until someone submits it on GitHub.
```

### `sarif-to-comment publish`: a fix on a file outside the pull request's diff

Still blocked under the default `edits: [native]` (exit status 2), now as `delivery-unavailable`. stdout:

```diff
 ## Review blocked
 
-Nothing was published and no publication state was written.
-
-**Review blocked:** 1 problem must be resolved before publication; nothing was published.
-
-- `suggestion-not-inline` at `/runs/0/results/0`: Lines 3-3 of docs/notes.md cannot carry a native suggestion (file-not-in-diff).
+Nothing was published and no publication state was written. 1 problem must be resolved before publication.
```

stderr:

```diff
+✖ error  No delivery mechanism the policy lists is available for a proposal  [delivery-unavailable]
+  /runs/0/results/0
+  The edit of `docs/notes.md` line 3 cannot be delivered. `edits` is `[native]`, the default, and no mechanism it lists is available:
+
+  - `native`: Lines 3-3 of docs/notes.md cannot carry a native suggestion (file-not-in-diff).
+  → Remove the fix.
+  → Remove the obstacle the message names, then publish again.
+  → Or list a mechanism that is available for this kind of proposal (`--edits`, `--grouped-edits`, `--file-operations`, the `delivery` option, or `.github/sarif-to-comment.json`).
+
+1 error
```

With `--edits native,review-body` the same edit is shown in the review body to make by hand, the review is published (exit status 0) with the headline `**Published with 1 warning:** A proposal is delivered by a later mechanism of its delivery list.`, and stderr carries:

```text
▲ warning  A proposal is delivered by a later mechanism of its delivery list  [delivery-fallback]
  /runs/0/results/0
  The edit of `docs/notes.md` line 3 is delivered as `review-body`. `edits` is `[native, review-body]`, set by the caller (`--edits`, `delivery.edits`), and the mechanisms listed before it are unavailable:

  - `native`: Lines 3-3 of docs/notes.md cannot carry a native suggestion (file-not-in-diff).
  → Remove the fix.
  → To use an earlier mechanism, remove the obstacle the message names, then publish again.
  → To refuse rather than fall back, list only the mechanism you require.

1 warning
```
