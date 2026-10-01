---
"sarif-to-comment": minor
---

Group independent fixes for joint acceptance without editing SARIF. Extraction still turns every separable staged change into its own fix; a person or an agent then declares which fixes must be accepted together, as a separate step. `groupSarifFixes(sarif, { findings, group })` and `ungroupSarifFixes(sarif, { findings })` return a new document; the new `group-fixes` and `ungroup-fixes` commands edit the SARIF file in place, atomically, or write a new `--output` file. Findings are named by the selectors `inspect` shows, and a stale selector is refused. A group needs at least two distinct changes; a name already in use extends that group (one finding is enough), but a finding belongs to at most one group and groups are never joined; only a finding's primary (first) fix is a member, a finding without a change is refused, and nothing is inferred. `inspect` shows each finding's group.

The group is recorded as `properties.sarifToComment.suggestionGroup`, renamed from the unreleased `acceptanceGroup` (the old key is now refused as unknown). Publication delivers each group whole, as does a single SARIF fix with several artifact changes or replacements, which needs no property: as a native batch, as one companion suggestion pull request, or, when no mechanism of its delivery list can, by refusing the review, naming the list (see the delivery policy entry). It is never split.

### `sarif-to-comment --help`: two new commands

```diff
   sarif-to-comment remove-comment --sarif FILE --finding SELECTOR [options]
+  sarif-to-comment group-fixes --sarif FILE --finding SELECTOR [...] --group NAME [options]
+  sarif-to-comment ungroup-fixes --sarif FILE --finding SELECTOR [...] [options]
   sarif-to-comment inspect --sarif FILE [options]
@@
   remove-comment       Remove a finding and its attached fixes from the SARIF document.
+  group-fixes          Group fixes of several findings to be accepted together.
+  ungroup-fixes        Remove findings from their suggestion groups.
   inspect              Show the findings, locations and fixes in a SARIF file.
@@
   2  refused content: blocked (nothing was published), invalid/failed input,
-     or a stale finding selector; cleanup left pull requests it may not close
+     a refused grouping, or a stale finding selector; cleanup left pull
+     requests it may not close
```

### `sarif-to-comment group-fixes --help` (new)

```diff
+Usage:
+  sarif-to-comment group-fixes --sarif FILE --finding SELECTOR [...] --group NAME
+                               [--output FILE] [--format human|json]
+
+Options:
+  --sarif FILE                   SARIF file to read (and update in place).
+  --finding SELECTOR             A finding's selector from inspect; repeat for more.
+                                 A new group needs at least two distinct changes.
+  --group NAME                   The group's name, shown in the suggestion pull
+                                 request's title: 1-100 characters, no control
+                                 or invisible characters, no surrounding spaces.
+  --output FILE                  Write the result to this new file instead; an
+                                 existing file is refused and --sarif is not changed.
+
+Exit status: 0 grouped; 2 refused, a stale selector, or not valid SARIF; 1
+usage error or a file could not be read or written.
```

`ungroup-fixes --help` is the same without `--group`, with `--finding SELECTOR` repeatable from one.

### `sarif-to-comment group-fixes`: human output

```diff
+Grouped 2 findings in review.sarif as suggestion group "checklist-link": 2 distinct changes to accept together.
+  /runs/0/results/1 (tool "Review agent"): 1 change
+  /runs/0/results/2 (tool "Review agent"): 1 change
+Publication delivers the group whole, by its delivery list (--grouped-edits, or --file-operations when it creates or deletes a whole file), or refuses it.
+Selectors from earlier inspections no longer apply; inspect the file again before another edit.
```

Adding to an existing group by reusing its name:

```diff
+Added 1 finding in review.sarif to suggestion group "checklist-link": 3 distinct changes to accept together.
```

### `sarif-to-comment inspect`: each finding's group

```diff
-Finding /runs/0/results/1 — Review agent
+Finding /runs/0/results/1 — Review agent · suggestionGroup: checklist-link
```

The JSON view's findings gain `suggestionGroup` when they have one. The help text says so:

```diff
-Shows every finding with its full text, locations and fixes, and the selector
-remove-comment takes.
+Shows every finding with its full text, locations, fixes and suggestion group,
+and the selector remove-comment, group-fixes and ungroup-fixes take.
```

### `sarif-to-comment validate` / `publish`: a fix with several changes under the default delivery policy

```diff
-- `fix-multiple-files-unsupported` at `/runs/0/results/0`: A fix changing several files is not supported yet.
+- `delivery-unavailable` at `/runs/0/results/0`: The fix with 3 changes at `/runs/0/results/0` cannot be delivered. `groupedEdits` is `[native-batch]`, the default, and no mechanism it lists is available:
+
+- `native-batch`: Offering a fix with several changes as a native batch is not yet supported by this version.
```

The explicit-group problems are renamed with the property: `acceptance-group-*` becomes `suggestion-group-*`, and their messages say "Suggestion group".
