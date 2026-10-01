---
"sarif-to-comment": minor
---

**Group fixes that must be accepted together.** Extraction still turns every separable staged change into its own fix. A person or an agent then declares, as a separate step, which fixes belong together:

- **New commands and functions.** `group-fixes --sarif FILE --finding SELECTOR … --group NAME` and `ungroup-fixes --sarif FILE --finding SELECTOR …` edit the SARIF file in place, atomically, or write a new `--output` file. `groupSarifFixes(sarif, { findings, group })` and `ungroupSarifFixes(sarif, { findings })` return a new document and never change their input. Findings are named by the selectors `inspect` shows, and a stale selector is refused.
- **The rules.** A group needs at least two distinct changes. A name already in use extends that group, so one finding is enough; a finding belongs to at most one group, and groups are never joined. Only a finding's primary (first) fix, or its proposed whole-file operation, is a member; a finding without a change is refused, and nothing is inferred. When two findings carry the identical change, both or neither must be in the group: otherwise `group-fixes` refuses it (exit status 2), naming the finding left outside with its current selector, and `ungroup-fixes` likewise refuses to take out only one of them. Publication refuses a document with such a group, for example one written by hand, with `suggestion-group-change-shared`.
- **The property.** The group is recorded as `properties.sarifToComment.suggestionGroup`, which 0.2.1 refused as an unknown key (`owned-property-invalid`). `inspect` shows each finding's group, and its JSON view's findings gain `suggestionGroup`.
- **Publication.** A group is delivered whole by its delivery list (see the delivery policy entry), as is a single fix with several changes, which needs no property: under the defaults a group of edits is a native batch, and a group with a whole-file operation is the mixed manual group in the review body. A group is never split.

`sarif-to-comment --help` lists both commands (see the command-line entry); `group-fixes --help` and `ungroup-fixes --help` are new.

### `sarif-to-comment publish`: two findings of the group `g`, each with a fix

Under the default policy the group is a native batch. Exit status 2 → 0.

```diff
-## Review blocked
+## Draft review published
 
-Nothing was published and no publication state was written.
-
-**Review blocked:** 2 problems must be resolved before publication; nothing was published.
-
-- `owned-property-invalid` at `/runs/0/results/0`: properties.sarifToComment has keys this product does not define here: suggestionGroup.
-- `owned-property-invalid` at `/runs/0/results/1`: properties.sarifToComment has keys this product does not define here: suggestionGroup.
+Created the draft [review 5000](https://github.com/octo/calc/pull/12#pullrequestreview-5000) on octo/calc#12 at commit `4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e`. It stays a draft until someone submits it on GitHub.
```

### `sarif-to-comment inspect`: each finding's group, and its selector

```diff
-Finding /runs/0/results/0 — CalcLint 2.0.0
+Finding /runs/0/results/0 — CalcLint 2.0.0 · suggestionGroup: g
+Selector: /runs/0/results/0@16c56f57a13ccda1
 Message:
 Rename mul to multiply.
```
