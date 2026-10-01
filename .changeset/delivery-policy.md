---
"sarif-to-comment": minor
---

Choose where each proposed change goes. Every proposal is delivered by the first available mechanism of an ordered list for its kind: `edits` (an edit in no group: `native`, `review-body`, `companion`), `groupedEdits` (a group of edits, or one fix with several changes: `native-batch`, `companion`, `manual-group`) and `fileOperations` (a whole-file creation or deletion, and any group containing one, as a whole: `manual`, `companion`), plus `companionBundle` (`per-unit` or `single`). Set them with `options.delivery` in `publishSarifReview` and `validateSarifReview`, with `--edits`, `--grouped-edits`, `--file-operations` and `--companion-bundle` on `publish` and `validate`, or with a preset, `--delivery original-pr` (everything on the pull request) or `--delivery companion` (every proposal in companion pull requests). A repository can set the same members in `.github/sarif-to-comment.json` on its default branch; your settings win over it, setting by setting, and it wins over the defaults.

- **The defaults** are `edits: [native]`, `groupedEdits: [native-batch]`, `fileOperations: [manual]` and `companionBundle: per-unit`. They never create a companion pull request.
- **No silent substitution.** A later mechanism of a list is an announced fallback (`delivery-fallback` warning, exit status 0). When no listed mechanism can deliver a proposal, nothing is published: the review is blocked with one `delivery-unavailable` error per proposal, naming the list, where it was set and every obstacle (CLI exit status 2; the library's `blocked` outcome). A one-entry list is strict. The remedies of both diagnostics start with each obstacle's own remedy, deduplicated, in obstacle order. A blocked review carries no fallback warning; when a review-size limit or a companion pull request check blocks a review that a fallback contributed to, the error ends naming that fallback.
- **Groups stay whole.** A group of edits each making one change is offered by default as a **native batch**: every member is a native suggestion in the review, noting its group, and the review body lists them by path and line to add to one batch and commit together. A group with a whole-file operation follows `fileOperations` as a whole. A group is never split.
- **Not yet supported by this version:** `review-body`, `manual-group`, `manual` for a group with a whole-file operation, and a native batch for a fix with several changes. They are always reported unavailable with that reason, never imitated, so a group with a new file and a fix with several changes are still blocked under the defaults, as before.
- **Bundles and the limit.** With `--companion-bundle single`, every companion-delivered proposal goes into one companion pull request, each in its own section. One review creates at most 10 companion pull requests; the `too-many-suggestion-prs` error now names `--companion-bundle single` first.
- **Companion options.** `--pr-labels` and `--mark-suggestion-prs-ready` are valid with any policy; with no companion planned they have no effect, and a `companion-options-unused` note says so.
- **Validation and recording.** An invalid caller setting is a usage error (exit status 1) or a `TypeError`, before anything is read. An invalid configuration file blocks the review (`delivery-configuration-invalid`, one per problem); a file that can't be read is an error, never a silent default; when your settings decide every dimension, the file is not read. Your settings are part of the publication's identity, and the resolved policy, with where each value came from, is recorded in the state file before the first write (a state record without companion pull requests is now version 3; records of 0.2.x are still continued). A retry never reads the configuration again.
- **Codes.** New: `delivery-unavailable`, `delivery-fallback`, `delivery-configuration-invalid`, `companion-options-unused`. An edit that can't be a native suggestion is now reported as `delivery-unavailable`, whose bullet for `native` states the reason and whose remedies start with the one the retired code gave; the unreleased `suggestion-not-inline`, `suggestion-reviewed-commit-not-head`, `suggestion-fence-unverified`, `suggestion-blank-only-unverified`, `suggestion-crlf-unverified` and `suggestion-final-newline-unverified` are therefore no longer reported, and neither are `suggestion-pr-fallback`, `suggestion-group-pr-unavailable`, `suggestion-group-requires-suggestion-prs` and `fix-changes-require-suggestion-prs`.
- **Reading.** `publish` and `validate` now read `.github/sarif-to-comment.json` from the default branch through Git objects, after the pull request's context, unless your settings decide everything. The repository is read once per call: planning companion pull requests reuses that read.

### `sarif-to-comment publish --help`: the delivery options

`validate --help` and the flag-only form gain the same options.

```diff
                            [--ignore-approval-hold] [--submit]
+                           [--delivery PRESET] [--edits LIST]
+                           [--grouped-edits LIST] [--file-operations LIST]
+                           [--companion-bundle BUNDLE] [--pr-labels A,B,C]
+                           [--mark-suggestion-prs-ready]
                            [--format human|json|toon]
 
 The same operation as the original form without a command. The review is a draft
 unless --submit is given.
 
+Delivery: each proposed change is delivered by the first mechanism its list
+names that can deliver it. Flags override the repository's
+.github/sarif-to-comment.json on the default branch, which overrides the
+defaults; the defaults never create a companion pull request. When no listed
+mechanism can deliver a proposal, nothing is published. review-body and
+manual-group, and manual for a group with a whole-file operation, are not yet
+supported by this version.
+
 Options:
@@
   --submit                       Create the review already submitted, as a
                                  comment review, instead of a draft. Never
                                  approves or requests changes. Retry a
                                  publication with the mode it started with.
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
   --format human|json|toon       Output format (default human). JSON and TOON
```

### `sarif-to-comment publish --file-operations companion`: a strict list that cannot be honored

A deletion on a pull request from a fork, where no companion pull request can be made. Nothing is written, and the exit status is 2.

stdout:

```diff
+## Review blocked
+
+Nothing was published and no publication state was written. 1 problem must be resolved before publication.
```

stderr:

```diff
+✖ error  No delivery mechanism the policy lists is available for a proposal  [delivery-unavailable]
+  /runs/0/results/0
+  The deletion of `obsolete.txt` cannot be delivered. `fileOperations` is `[companion]`, set by the caller (`--file-operations`, `delivery.fileOperations`), and no mechanism it lists is available:
+
+  - `companion`: The pull request's head branch `feature/retry` is in the fork someone/widgets, and suggestion pull requests are not yet supported for a pull request from a fork.
+  → Remove the obstacle the message names, then publish again.
+  → Or list a mechanism that is available for this kind of proposal (`--edits`, `--grouped-edits`, `--file-operations`, the `delivery` option, or `.github/sarif-to-comment.json`).
+
+1 error
```

With `--file-operations companion,manual` the same deletion is proposed in the review body, the review is published (exit status 0), and the warning reads ``The deletion of `obsolete.txt` is delivered as `manual`. …``, under the headline `**Published with 1 warning:** A proposal is delivered by a later mechanism of its delivery list.`
