# Diagnostics

Errors, warnings and notes are modelled once, as structured diagnostics, and rendered for each audience: JSON and TOON for agents, a colored terminal view for people, and Markdown for GitHub and the library's `markdown` fields.

**Status:** owner decision of September 30, 2026 ([issue #38](https://github.com/mike-north/sarif-to-comment/issues/38)), recorded as [D45](design-decisions.md#d45-model-diagnostics-once-and-render-them-per-audience--owner-decision). It supersedes [D13](design-decisions.md#d13-diagnostics-are-markdown-repair-interfaces-remain-the-ordinary-inputs--settled), which deliberately avoided a public machine-readable diagnostic schema. The codes below are public API once released.

## The model

Every diagnostic has one shape, exported from the package as `IDiagnostic`:

```ts
interface IDiagnostic {
  severity: 'error' | 'warning' | 'note';
  code: string;        // stable, kebab-case, listed in the catalog below
  title: string;       // one plain-text line
  message: string;     // the full explanation, Markdown
  location?: { pointer?: string; path?: string; startLine?: number; endLine?: number };
  subject?: string;    // what it concerns: a pull request, a group, a review, ...
  remedies?: string[]; // concrete next steps
}
```

- **Severity.** `error`: the operation did not do what was asked, and nothing was changed that the outcome does not report. `warning`: the operation did what was asked, or may have, and something needs attention. `note`: information only.
- **Code.** Stable once released; the catalog gives each code one severity. A code names a condition, not a message: the message may carry specifics such as paths, line numbers or GitHub's own reason.
- **Title.** The same for every diagnostic of a code, so it can be shown or grouped without parsing the message.
- **Message.** Markdown, as it always has been. For conditions that existed before this model, the message is exactly the text `problems[].message` carried before, so it may already name a remedy.
- **Location.** `pointer` is a JSON Pointer into the SARIF document; `path` is a repository-relative path; `startLine` and `endLine` are one-based lines of that path. Absent when the diagnostic is about the whole operation.
- **Subject.** What the diagnostic concerns when that is not a location: a pull request (`acme/widgets#42`), a suggestion group, a review.
- **Remedies.** Concrete next steps from the catalog. Absent when nothing needs doing.

### On every outcome

Every library outcome and every CLI JSON (or TOON) document carries `diagnostics: IDiagnostic[]`. The array is always present, possibly empty, and ordered: errors, then warnings, then notes, each in the order they were found.

`createSarifDocument` returns a SARIF log, not an outcome, and has no diagnostics; `init` reports an empty array.

### Compatibility with 0.2.x

- **`problems`.** Every `problems` array keeps its entries' `message`, `pointer` and `path` exactly as before, and each entry gains the diagnostic fields: `severity`, `code`, `title`, and `location`, `subject` and `remedies` where they apply. An entry is therefore a diagnostic plus the two flat fields it always had (`IProblem extends IDiagnostic`). `problems` lists the blocking problems (`error`); `diagnostics` lists them too, with every warning and note.
- **Receipt warnings.** `add-staged-changes` receipt `warnings` keep their shape the same way and are `warning` diagnostics. Inspection's `view.diagnostics` entries gain the same fields; the view's `format` and `version` are unchanged, because entries only gain fields.
- **`markdown`.** Every `markdown` field remains and is rendered from the same diagnostics, with the same wording. Where a Markdown list names a code (`` - `code` at `pointer`: message ``), it names the catalog code, so the six renamed codes below appear under their new names.
- **Key order.** Existing keys of outcomes and CLI documents keep their order. `diagnostics` is appended last.
- **Behavior.** Exit statuses, refusals, fallbacks and everything written are unchanged. Only the human presentation and the new fields differ.

## JSON schema, version 1

The diagnostic shape is published as a JSON Schema: [`diagnostic.v1.schema.json`](diagnostic.v1.schema.json), shipped in the package at `docs/diagnostic.v1.schema.json`. It defines `diagnostic` (exactly the fields above, no others) and `problem` (a diagnostic plus the flat `pointer` and `path`).

Version 1 is fixed. Adding, removing or retyping a field, or adding a severity, is a new version with a new schema file; the old one is never edited. New codes may be added to the catalog within a version. An existing code keeps its severity and meaning.

## Output formats

`--format human|json|toon` selects the CLI's output, and `human` is the default. The format is never inferred from a terminal. Invalid, missing or repeated values are usage errors, reported in the human form.

The examples below are one invocation, `sarif-to-comment inspect --sarif broken.sarif.json`, on a document whose only result has no message. The tests run it and compare the output with these examples.

### `--format json`

One JSON document on stdout for every outcome, and nothing on stderr:

<!-- diagnostics-example: json -->
```json
{
  "command": "inspect",
  "status": "invalid",
  "problems": [
    {
      "message": "`/runs/0/results/0` must have required property 'message'.",
      "pointer": "/runs/0/results/0",
      "severity": "error",
      "code": "sarif-schema-invalid",
      "title": "The document is not valid SARIF 2.1.0",
      "location": {
        "pointer": "/runs/0/results/0"
      },
      "remedies": [
        "Correct the document so that it conforms to the SARIF 2.1.0 schema."
      ]
    }
  ],
  "diagnostics": [
    {
      "severity": "error",
      "code": "sarif-schema-invalid",
      "title": "The document is not valid SARIF 2.1.0",
      "message": "`/runs/0/results/0` must have required property 'message'.",
      "location": {
        "pointer": "/runs/0/results/0"
      },
      "remedies": [
        "Correct the document so that it conforms to the SARIF 2.1.0 schema."
      ]
    }
  ]
}
```

### `--format toon`

The same document, encoded as [TOON](https://toonformat.dev) (Token-Oriented Object Notation) for token-efficient agent consumption. Decoding it gives exactly the JSON document:

<!-- diagnostics-example: toon -->
```text
command: inspect
status: invalid
problems[1]:
  - message: `/runs/0/results/0` must have required property 'message'.
    pointer: /runs/0/results/0
    severity: error
    code: sarif-schema-invalid
    title: The document is not valid SARIF 2.1.0
    location:
      pointer: /runs/0/results/0
    remedies[1]: Correct the document so that it conforms to the SARIF 2.1.0 schema.
diagnostics[1]:
  - severity: error
    code: sarif-schema-invalid
    title: The document is not valid SARIF 2.1.0
    message: `/runs/0/results/0` must have required property 'message'.
    location:
      pointer: /runs/0/results/0
    remedies[1]: Correct the document so that it conforms to the SARIF 2.1.0 schema.
```

### `--format human`

The primary result goes to stdout, and diagnostics go to stderr: each diagnostic is a block, and a summary line closes them. Here the refused inspection has no primary result, so stdout is empty and stderr is:

<!-- diagnostics-example: human -->
```text
✖ error  The document is not valid SARIF 2.1.0  [sarif-schema-invalid]
  /runs/0/results/0
  `/runs/0/results/0` must have required property 'message'.
  → Correct the document so that it conforms to the SARIF 2.1.0 schema.

1 error
```

Each block is:

1. A severity badge (`✖ error`, `▲ warning`, `ℹ note`), the title in bold, and the code, dimmed, in brackets. This header is one line and is never wrapped.
2. Where it is: `path:line` (or `path:start-end`), the JSON Pointer, and the subject, joined by ` · `. Omitted when there is none.
3. The message, indented and wrapped to the terminal's width, measured in display columns: a wide (CJK) character or an emoji is two columns, and a combining mark none. Lines inside a fenced code block are never wrapped, and a word longer than the width is never broken.
4. Each remedy on its own `→` line.

Blocks are separated by a blank line. The summary line counts each severity present, for example `1 error, 2 warnings`. When there are no diagnostics, nothing is written to stderr.

**Streams.** Human output keeps the CLI's conventions: the primary result (what was created, written, inspected, checked, published or closed, and what happened to each file) goes to stdout, and diagnostics go to stderr. A refusal or an operational error writes only its file notes, such as ``… was not changed.``, to stdout. `inspect` no longer lists its warnings in its text, and `add-staged-changes` no longer prints `Warning:` lines: both are diagnostics on stderr. `validate`, `publish` and `close-suggestion-prs` print their outcome text on stdout (the heading, the review and pull request links, the state path, and the retry and next-step guidance) without repeating their problems and warnings: the diagnostic blocks on stderr are the single human rendering of them (owner decision, September 30, 2026). What stdout leaves out is exactly what a diagnostic says: the lists of problems and warnings, the detail of a failure, and, for cleanup, the pull requests that were refused, failed, could not be verified or do not follow the convention. The library's `markdown` fields and the JSON and TOON `message` are unchanged: they remain the full report.

**Headline.** A successful `publish` or `validate` outcome with warnings states them directly under its heading, in the library's `markdown`, the JSON and TOON `message` and the human stdout alike, so that no warning is only at the end of the output ([issue #37](https://github.com/mike-north/sarif-to-comment/issues/37)): `**Published with N warning(s):**` or `**Ready to publish with N warning(s):**`, then one sentence per code, in the order first found. `suggestion-pr-fallback` has its own sentence (`1 suggestion pull request was not created; its change is shown in the review.`, or `… would not be created; its change would be shown in the review.` for `validate`, and the plural `2 suggestion pull requests were not created; their changes are shown in the review.`); any other code is its title, followed by `(N times)` when it occurs more than once. For example:

```text
## Draft review published

**Published with 1 warning:** 1 suggestion pull request was not created; its change is shown in the review.

Created the draft [review 42](https://github.com/acme/widgets/pull/7#pullrequestreview-42) on acme/widgets#7 at commit `…`. It stays a draft until someone submits it on GitHub.
```

Errors and notes are never counted in the headline, and an outcome without warnings has none. The exit status of a successful outcome with warnings stays 0.

**Color.** Badges are red (error), yellow (warning) and blue (note); the location line is cyan; the `→` is green; the summary counts take their severity's color. Whether color is used is decided for stderr, in this order:

1. `--color always` or `--color never`.
2. `FORCE_COLOR`: `0` or `false` turns color off; any other value, including empty, turns it on. It takes precedence over `NO_COLOR`, as it does in Node.js; the owner confirmed this order on September 30, 2026.
3. `NO_COLOR` set to a non-empty value turns color off.
4. Otherwise (`--color auto`, the default): color only when stderr is a terminal and `TERM` is not `dumb`.

Without color, the output is plain text with no escape sequences, and the layout is identical. Text is wrapped only when stderr is a terminal, to its width; otherwise lines are not wrapped. `--color` is accepted with every format and affects only human output.

### Markdown

The library's `markdown` fields and the JSON `message` are Markdown rendered from the same diagnostics, with the wording they had before this model. GitHub review text is unchanged.

## Dependencies

**chalk 6, loaded with `import()`.** Color uses [chalk](https://github.com/chalk/chalk), the owner's choice. The package ships CommonJS with `engines.node >=22`. chalk 5 and 6 are ES modules only, and an unflagged `require()` of an ES module needs Node 22.12 or later. chalk 4 is CommonJS but has not been maintained since 2021 and brings two dependencies. chalk 6 has none, declares `engines.node >=22` exactly as this package does, and is maintained. The CLI's `main` is asynchronous, so it loads chalk with a dynamic `import()`, which CommonJS supports on every Node 22 release. So the package uses chalk 6 and keeps `engines.node >=22` unchanged. chalk is loaded only when color is on (if it cannot be loaded, the diagnostics are shown as plain text with a `color-unavailable` warning, and the exit status is unchanged), and its color level is set explicitly from the decision above, never from its own detection (which reads `process.argv` and ignores `NO_COLOR`).

**TOON with `@toon-format/toon`.** [`@toon-format/toon`](https://www.npmjs.com/package/@toon-format/toon) is the reference encoder of the [TOON specification](https://github.com/toon-format/spec): MIT-licensed, no dependencies, published with npm provenance, and maintained (4.1.1, August 2026). It is also an ES module only, and is loaded the same way, only for `--format toon`. It is loaded before the command runs, so an installation that cannot load it fails with `operation-failed` (exit status 1) before anything is read or written. The CLI encodes the JSON document after a JSON round trip, so TOON always carries exactly the JSON document. Tests decode the TOON output and compare it with the JSON output.

## Renamed codes

These internal codes were unclear. They were renamed before their first release as public codes; every other code keeps the name it had in Markdown. `suggestion-pr-not-reapplied` became `suggestion-pr-fallback` when a suggestion pull request that cannot be re-applied stopped being skipped and started falling back as if suggestion pull requests were not allowed ([issue #37](https://github.com/mike-north/sarif-to-comment/issues/37)); a group in that situation is refused as `suggestion-group-pr-unavailable`. Since the same decision, a fork, a base other than the default branch, a created file over the size limit and a description over the body limit are fallbacks too, so `suggestion-pr-fork-unsupported`, `suggestion-pr-base-unsupported`, `suggestion-file-too-large` and `suggestion-body-too-large`, never released, are no longer reported.

| Before | After |
|---|---|
| `inline-unavailable` | `inline-placement-unavailable` |
| `invocation-failed` | `tool-invocation-failed` |
| `tool-notification-error` | `tool-reported-errors` |
| `repository-mismatch` | `provenance-repository-mismatch` |
| `provenance-conflict` | `provenance-revision-conflict` |
| `suggestion-historical-unsupported` | `suggestion-reviewed-commit-not-head` |
| `suggestion-pr-not-reapplied` | `suggestion-pr-fallback` |

## Code catalog

One entry per code: its severity, its title, what it means and its typical remedies. The tests check that this catalog and the implementation's catalog agree on every code, severity, title and remedy.

### Command line and files

| Code | Severity | Title | Meaning | Typical remedies |
|---|---|---|---|---|
| `usage-error` | error | The command line is not valid | An option is unknown, missing, repeated or has a value the command does not accept, or the command is unknown. Nothing was read or written. The CLI's remedy names the exact `--help` command. | Run the command with `--help` for its usage, and correct the command line. |
| `github-token-missing` | error | No GitHub token is set | `validate`, `publish` and `close-suggestion-prs` read GitHub and need a token in `GH_TOKEN` or `GITHUB_TOKEN`. There is no token flag. | Set GH_TOKEN (or GITHUB_TOKEN) to a personal access token or user token. |
| `file-unreadable` | error | A file could not be read | An input file does not exist, is not readable, or could not be read again before it was replaced. | Check the path and the file's permissions, then run the command again. |
| `file-not-utf8` | error | A file is not UTF-8 text | SARIF and message files must be UTF-8 encoded. | Save the file as UTF-8, then run the command again. |
| `file-not-json` | error | A file is not valid JSON | The SARIF file could not be parsed as JSON, so it was not interpreted. | Correct the file's JSON syntax, then run the command again. |
| `output-exists` | error | The output file already exists | A command that creates a new file never replaces an existing one. | Choose a new output path, or move the existing file away. |
| `file-not-writable` | error | A file could not be written | Creating the output, its ownership marker or its replacement failed; the file named was not changed. | Check the directory's permissions and free space, then run the command again. |
| `file-in-use` | error | Another command is writing the file | The file's ownership marker (`.<name>.sarif-to-comment-lock`) exists: another sarif-to-comment command owns it. Another command's marker is never taken over. | Wait for the other command to finish.<br>If no such command is running, delete the stale marker the message names and run the command again. |
| `file-changed-during-edit` | error | The file changed while the command ran | An in-place edit found different content when it was about to replace the file, so it did not overwrite it. | Run the command again. |
| `output-archive-failed` | error | The existing output could not be preserved | `add-staged-changes` moves an existing output aside before writing a new one; that failed, so nothing was written. | Check the output directory's permissions, then run the command again. |
| `message-not-utf8` | error | The message on standard input is not UTF-8 | `add-comment --message-file -` reads the finding's text from standard input, which must be UTF-8. | Provide the message as UTF-8 text. |
| `operation-failed` | error | The operation could not be completed | The operation stopped for a reason outside the document: for example the network, GitHub, Git, or a publication state file that is corrupt or belongs to other input. The message names the cause. | Resolve the cause the message names, then run the command again. |
| `color-unavailable` | warning | Color is unavailable | Color was asked for, but the color library (chalk) could not be loaded, so the diagnostics are shown as plain text. The outcome and its exit status are unaffected. | Reinstall the package's dependencies, or use `--color never`. |

### SARIF documents, authoring and grouping

| Code | Severity | Title | Meaning | Typical remedies |
|---|---|---|---|---|
| `sarif-schema-invalid` | error | The document is not valid SARIF 2.1.0 | The input does not conform to the SARIF 2.1.0 schema, so it was not interpreted. | Correct the document so that it conforms to the SARIF 2.1.0 schema. |
| `sarif-no-runs` | error | The document has no run to add the finding to | A finding is added to an existing run, or to a new run attributed to your own tool. | Add the finding to a new run of your own tool (`run: { toolName }`, or `add-comment --new-run-tool NAME`). |
| `finding-selector-stale` | error | The finding selector does not fit the document | The document changed after the selector was taken from inspecting it, or the selector came from another document. It is never applied to whichever finding is now in its place. | Inspect the document again and use the selector it shows now. |
| `finding-already-grouped` | error | The finding is already in another suggestion group | A finding belongs to at most one suggestion group, and groups are never joined. | Ungroup the finding first to move it to another group. |
| `finding-not-grouped` | error | The finding is not in a suggestion group | Only a finding in a suggestion group can be ungrouped. | Leave the finding out of the ungroup request. |
| `ungroup-leaves-single-change` | error | Ungrouping would leave a group with fewer than two changes | Publication always refuses a group of fewer than two distinct changes, so ungrouping never leaves one behind. | Ungroup the group's other findings too, which dissolves the group. |

### Inspection

| Code | Severity | Title | Meaning | Typical remedies |
|---|---|---|---|---|
| `uninterpreted-message` | warning | A message could not be resolved | A message names an argument that was not supplied, or a message id the rule and its tool component do not define. Inspection shows what it can; publication would refuse it (`message-argument-missing`, `message-unresolved`). | Supply the missing argument or message string in the SARIF. |
| `uninterpreted-artifact-location` | warning | An artifact location could not be resolved to a repository path | Inspection shows the location as given; publication would refuse it with the resolution's own code (for example `uri-outside-repository`). | Use a repository-relative URI, or pass the producer's source root (`--source-root`, `sourceRootUri`). |
| `uninterpreted-file-proposal` | warning | A proposed file change could not be interpreted | `properties.sarifToComment.proposedFileChanges` is not a list of operations, an entry is not an object or names an unknown operation, or it names no artifact with a location. It is shown verbatim. | Correct the proposal, or remove it. |
| `uninterpreted-rule-reference` | warning | A rule reference could not be resolved | The result's rule reference names no rule or tool component, or contradicts itself. Inspection shows the result without the rule. | Correct the result's `ruleId`, `ruleIndex` or `rule`. |
| `external-results-not-merged` | warning | Results in inline external properties are shown verbatim | Inspection does not merge results embedded in `inlineExternalProperties` into the findings. | Move the results into a run if they are findings to publish. |
| `external-property-files-not-loaded` | warning | External property files are not loaded | Inspection never loads the files a run's `externalPropertyFileReferences` names; their content is not shown. | Inline the content into the document if it matters for review. |

### Staged changes

| Code | Severity | Title | Meaning | Typical remedies |
|---|---|---|---|---|
| `staged-conflict` | error | A staged path has unmerged index entries | The index holds a conflict for the path, so there is no single staged content to propose. | Resolve the conflict and stage the intended content, then run again. |
| `staged-intent-to-add` | error | A path is only intended to be added | An intent-to-add entry (`git add -N`) has no staged content. | Stage the intended content with `git add`, or remove the intent-to-add entry, then run again. |
| `staged-sparse-directory` | error | The index holds a sparse directory entry | A sparse index lists a directory, not the files in it, so its staged files cannot be compared. | Disable the sparse index (`git sparse-checkout disable` or `index.sparse=false`), then run again. |
| `staged-split-index` | error | The index is a split index | Some entries of a split index live in a shared index file that extraction does not read. | Run `git update-index --no-split-index`, then run again. |
| `staged-path-not-utf8` | error | A staged path is not valid UTF-8 | SARIF URIs cannot represent the path faithfully. | Rename or unstage the path, then run again. |
| `staged-not-regular-file` | error | A staged path is not a regular file | Only regular files can be proposed; symbolic links, submodules and directories cannot. | Unstage the change, then run again. |
| `staged-mode-change` | error | A staged change changes a file mode | A SARIF proposal cannot represent a change of file mode. | Unstage the mode change (`git update-index --chmod`), then run again. |
| `staged-file-too-large` | error | A staged file is over the source size limit | Files over 1,000,000 bytes in the reviewed commit or the index are not read. | Unstage the file or split the change, then run again. |
| `staged-binary` | error | A staged file is binary | The file contains NUL bytes; binary changes cannot be proposed as text. | Unstage the file, then run again. |
| `staged-content-not-utf8` | error | A staged file is not UTF-8 text | Only UTF-8 text changes can be proposed. | Unstage the file, or stage it as UTF-8, then run again. |
| `staged-bom-change` | error | A staged change adds or removes a byte-order mark | SARIF coordinates exclude the byte-order mark, so gaining or losing one cannot be represented. | Stage the file with its original byte-order mark state, then run again. |
| `finding-location-unresolved` | error | A finding's location cannot be resolved to a repository path | Its association with staged changes cannot be decided. | Use a repository-relative URI, or pass the producer's source root, then run again. |
| `finding-region-unreadable` | error | A finding's region cannot be checked | The file the region refers to is not UTF-8 text within the size limit in the snapshot it names. | Remove the region or the finding, then run again. |
| `supplied-fix-location-unresolved` | error | A supplied fix's file cannot be resolved | The fix names a file that cannot be resolved to a repository path, so it cannot be compared with the staged changes. | Use a repository-relative URI, or pass the producer's source root, then run again. |
| `supplied-fix-unlocatable` | error | A supplied fix cannot be located in the reviewed file | Its replacements do not denote text in the reviewed file, so it cannot be compared with the staged change. | Correct or remove the fix, then run again. |
| `supplied-fix-binary` | error | A supplied fix inserts binary content where the staged change edits text | Its effect on the text cannot be established. | Correct or remove the fix, then run again. |
| `staged-fix-conflict` | error | A supplied fix conflicts with the staged change | Applied to the reviewed file, the fix has a different effect than the staged content. No winner is chosen. | Reconcile the fix or the staged content, then run again. |
| `staged-proposal-conflict` | error | A supplied proposal conflicts with a staged creation or deletion | A supplied text fix edits a file the index creates or deletes, or a supplied file proposal differs from the staged operation. No winner is chosen. | Reconcile the proposal or the staged content, then run again. |
| `finding-partially-overlaps-change` | warning | A finding only partly overlaps a staged change | The finding was not associated with the change; neither was enlarged. The change is carried by a separate, neutral result. | Adjust the finding's lines to cover the whole change if they belong together. |
| `finding-association-needs-column-kind` | warning | A finding was not associated because its run declares no columnKind | The staged change needs an end-of-file column that differs between UTF-16 code units and code points. The change is carried by a separate result in a run with an explicit columnKind. | Declare the run's `columnKind` if the finding and the change belong together. |

### Review preparation: interpreting the SARIF

| Code | Severity | Title | Meaning | Typical remedies |
|---|---|---|---|---|
| `external-properties-unsupported` | error | External properties are not supported | The log has inline external properties, or a run references external property files; publication would not present their content. | Move the content into the runs, or remove it. |
| `owned-property-invalid` | error | The sarifToComment properties are not valid | `properties.sarifToComment` is not an object, has keys this product does not define there, or a value of the wrong shape. | Correct or remove `properties.sarifToComment`. |
| `approval-hold` | error | The review is held for approval | A run or finding declares `properties.sarifToComment.approval: "awaiting-approval"`, which holds the whole review. | Resolve the hold in the SARIF.<br>Or publish deliberately despite it with `--ignore-approval-hold` (`ignoreApprovalHold`). |
| `approval-hold-overridden` | warning | An approval hold was bypassed | The explicit override published or assessed the review despite a declared hold. | — |
| `approval-state-invalid` | error | The approval state is not recognized | `properties.sarifToComment.approval` must be `"awaiting-approval"` or `"ready"`. | Set the approval state to `awaiting-approval` or `ready`, or remove it. |
| `suggestion-group-invalid` | error | The suggestion group name is not valid | `properties.sarifToComment.suggestionGroup` must be 1-100 characters without control or invisible formatting characters or surrounding whitespace. | Correct the group name, or regroup the findings with `group-fixes`. |
| `tool-invocation-failed` | error | The tool reports that its analysis did not complete | A run's invocation is not successful, so its results may be partial. | Rerun the analysis until it completes, or remove the run. |
| `tool-reported-errors` | warning | The tool reported errors during a successful invocation | The run's invocation succeeded but carries error notifications; its results are published. | Check the tool's notifications if the results look incomplete. |
| `context-artifact-uninterpreted` | warning | Artifact contents are treated as context only | A run's artifact carries contents that no proposed file change references; artifacts never imply a file creation or edit. | Reference the artifact from `proposedFileChanges` if it is a proposed file. |
| `taxa-uninterpreted` | warning | Taxonomy classifications are not shown | A result's `taxa` are retained in evidence but not rendered in the review. | — |
| `newline-sequences-unsupported` | error | The run declares unsupported newline sequences | Only SARIF's default CRLF and LF are supported, so the run's line and column coordinates cannot be read faithfully. | Remove the `newlineSequences` declaration, or the findings that depend on it. |
| `provenance-repository-mismatch` | error | The run's provenance names only other repositories | Its locations cannot be read from this pull request's repository. | Publish the run to a pull request of the repository it analyzed, or correct its `versionControlProvenance`. |
| `provenance-revision-invalid` | error | The run's provenance revision is not a full commit | Abbreviated revisions are never matched. | Record the full 40-character commit in `versionControlProvenance`. |
| `provenance-revision-conflict` | error | The run names several revisions of this repository | Its locations have no single source revision. | Split the run by revision, or correct its `versionControlProvenance`. |
| `related-locations-unsupported` | error | Related locations are not supported | The review profile does not present a result's related locations. | Remove the related locations, or describe them in the message. |
| `graphs-unsupported` | error | Graphs are not supported | The review profile does not present a result's graphs or graph traversals. | Remove them, or describe them in the message. |
| `stacks-unsupported` | error | Stacks are not supported | The review profile does not present a result's stacks. | Remove them, or describe them in the message. |
| `attachments-unsupported` | error | Attachments are not supported | The review profile does not present a result's attachments. | Remove them, or describe them in the message. |
| `suppressed-result-unsupported` | error | Suppressions are not supported | The review profile does not present a result's suppressions. | Remove suppressed results, or their suppressions, before publishing. |
| `code-flows-unsupported` | error | Code flows are not supported | The review profile does not present a result's code flows. | Remove them, or describe them in the message. |
| `multiple-locations-unsupported` | error | A result has several locations | Results with several locations are not supported yet. | Split the result into one result per location. |
| `location-annotations-unsupported` | error | Location annotations are not supported | Region annotations carry their own messages, which the review profile does not present. | Remove the annotations, or describe them in the message. |
| `baseline-absent-unsupported` | error | An absent baseline result cannot be presented | It describes a problem seen only in the baseline run, whose source revision is not established. | Remove results whose `baselineState` is `absent`. |
| `location-without-physical-source` | error | A location has no physical source | Only physical source locations (with an artifact) are supported. | Give the location a `physicalLocation` with an artifact, or remove it. |
| `message-unresolved` | error | A message id is not defined | The rule and the tool driver do not define the message id, so the finding cannot be rendered. | Define the message string, or give the message its text. |
| `message-argument-missing` | error | A message argument is missing | A message template needs an argument that was not supplied. | Supply the argument in the message's `arguments`. |
| `producer-html-unbalanced` | error | Producer Markdown leaves HTML open | An unclosed HTML element could hide the attribution, later findings or a suggestion that follows. | Close the HTML element in the message. |
| `producer-fence-unclosed` | error | Producer Markdown leaves a code fence open | An unclosed fence would swallow the attribution and any suggestion that follows. | Close the code fence in the message. |
| `producer-suggestion-fence` | error | Producer Markdown opens a suggestion block | Only a validated SARIF fix may create a native suggestion. | Express the change as a SARIF fix, or use another fence language. |
| `rule-component-unresolved` | error | A rule's tool component cannot be resolved | The rule reference names no single component of the tool. | Correct the rule reference's `toolComponent`. |
| `rule-reference-conflict` | error | A result's rule references disagree | `ruleId`, `ruleIndex` and `rule` name different rules. | Make the result's rule references agree. |
| `rule-reference-invalid` | error | A rule index names no rule | The index is outside the component's rules. | Correct the rule index. |
| `artifact-index-invalid` | error | An artifact index names no artifact location | The location's `index` is outside the run's artifacts, or names one without a location. | Correct the artifact index. |
| `artifact-index-conflict` | error | A location disagrees with the artifact it indexes | The location's URI differs from the indexed artifact's. | Make the location's URI match its artifact, or drop one of them. |
| `nested-artifact-unsupported` | error | Nested artifacts are not supported | Artifacts inside other artifacts (with a `parentIndex`) cannot be resolved to repository paths. | Refer to the file directly. |
| `uri-invalid` | error | An artifact URI is not valid | The URI is empty, malformed, has a query or fragment, names the repository root, or has another defect the message names. | Use a repository-relative URI, or a `file:` URI with a source root. |
| `uri-traversal` | error | An artifact URI contains a dot segment | `.` and `..` segments are never resolved. | Use a normalized repository-relative URI. |
| `uri-encoded-separator` | error | An artifact URI encodes a path separator | A percent-encoded `/` or `\` would change which file is named. | Use a URI whose segments do not encode separators. |
| `uri-scheme-unsupported` | error | An artifact URI scheme is not supported | Only repository paths and `file:` URIs are supported. | Use a repository-relative URI, or a `file:` URI with a source root. |
| `uri-base-invalid` | error | A URI base is not valid | A base is relative without a base of its own, or does not end with `/`. | Correct the run's `originalUriBaseIds`. |
| `uri-base-unresolved` | error | A URI base cannot be resolved | The base is not a known repository root, or refers to itself in a cycle. | Define the base in `originalUriBaseIds`, or pass the producer's source root. |
| `uri-outside-repository` | error | An artifact URI is outside the repository | The URI is not inside a known repository root. | Pass the producer's source root (`--source-root`, `sourceRootUri`), or use a repository-relative URI. |

### Review preparation: source and placement

| Code | Severity | Title | Meaning | Typical remedies |
|---|---|---|---|---|
| `source-file-missing` | error | The file does not exist at the source revision | The location names a file the reviewed commit (or the run's source revision) does not have. | Correct the location, or review the commit the finding refers to. |
| `source-range-invalid` | error | A region does not denote text in the file | The region's lines or columns are out of range, inverted, or address only the end-of-file position. | Correct the region against the reviewed source. |
| `source-coordinates-inconsistent` | error | A region's coordinates disagree | Its line/column and character offsets denote different text. | Make the region's coordinates agree, or give only one kind. |
| `region-unsupported` | error | A region form is not supported | For example byte regions, which cannot be read as text. | Express the region in lines and columns or character offsets. |
| `column-kind-required` | error | The run needs a columnKind | The run declares no `columnKind`, and a region or replacement denotes different text in UTF-16 code units and in Unicode code points. | Declare the run's `columnKind`. |
| `snippet-mismatch` | error | A region's snippet is not the source text | The region claims a snippet that differs from the reviewed source at that region. | Correct the region or its snippet, or review the commit it was made from. |
| `diff-context-inconsistent` | error | The pull request's diff does not match its source | Placement found the diff and the source inconsistent for this location, so no faithful anchor exists. | Check the reviewed commit and `--old-source-commit`, then run again. |
| `inline-placement-unavailable` | warning | A finding is published in the review body | It cannot be anchored inline on the diff (the message says why), so it is general feedback with an exact link. | — |

### Review preparation: fixes and suggestions

| Code | Severity | Title | Meaning | Typical remedies |
|---|---|---|---|---|
| `fix-association-unsupported` | error | A finding's location is outside its fix | Presenting the finding with its fix would move the feedback. | Keep the correct location, and separate the feedback from the fix. |
| `fix-binary-unsupported` | error | A fix inserts binary content | Binary content cannot be presented as a suggestion. | Express the fix as text, or remove it. |
| `fix-replacements-overlap` | error | A fix's replacements overlap | Two replacements overlap or start at the same position, so their combined effect is not defined. | Correct the fix. |
| `fix-replacements-unlocatable` | error | A fix's replacements cannot be located together | The replacements of one file cannot be located together in its text. | Correct the fix against the reviewed source. |
| `replacement-invalid` | error | A fix's replacement cannot be applied | Its region or inserted text is not valid for the file it edits; the message gives the reason. | Correct the fix against the reviewed source. |
| `replacement-unsupported` | error | A fix's replacement form is not supported | For example a byte region, which cannot be applied as text. | Express the replacement in lines and columns or character offsets. |
| `replacement-unanchored` | error | A fix edits an empty file | A replacement in an empty file has no line to anchor a suggestion on. | Propose the content as a new file, or enable suggestion pull requests. |
| `fix-changes-require-suggestion-prs` | error | A fix with several changes needs suggestion pull requests | A SARIF fix is accepted whole; a fix with several changes is published as one suggestion pull request, never split. | Enable suggestion pull requests (`--allow-suggestion-prs`, `allowSuggestionPullRequests`). |
| `overlapping-replacements` | error | Replacements of different findings overlap | Two findings propose different replacements for overlapping lines; no winner is chosen. | Reconcile the findings' fixes. |
| `suggestion-source-not-reviewed` | error | A fix edits another revision than the reviewed commit | Its applicability to the reviewed commit is unverified. | Derive the fix from the reviewed commit. |
| `suggestion-reviewed-commit-not-head` | error | A native suggestion needs the reviewed commit to be the pull request head | GitHub applies a native suggestion to the head, so a suggestion on an older reviewed commit could not be applied to the reviewed text. | Review the pull request's head commit, or enable suggestion pull requests. |
| `suggestion-not-inline` | error | The lines cannot carry a native suggestion | The fix's lines are not on the new side of the pull request's diff. | Enable suggestion pull requests, or remove the fix. |
| `suggestion-fence-unverified` | error | The replacement contains a suggestion fence | GitHub applied a nested ``` suggestion as a deletion, so this replacement cannot be a native suggestion. | Enable suggestion pull requests, or change the replacement. |
| `suggestion-blank-only-unverified` | error | The replacement is blank lines only | GitHub applied a blank-only suggestion as zero lines, so this replacement cannot be a native suggestion. | Enable suggestion pull requests, or change the replacement. |
| `suggestion-crlf-unverified` | error | The replacement's line endings would not be reproduced | GitHub doubles a CR in suggestion text, so this replacement cannot be a native suggestion. | Enable suggestion pull requests, or change the replacement. |
| `suggestion-final-newline-unverified` | error | The replacement's end of file would not be reproduced | GitHub's observed application would not reproduce the intended end of the file. | Enable suggestion pull requests, or change the replacement. |
| `alternative-path-unrepresentable` | error | An alternative fix's file path cannot be shown exactly | Alternatives are listed with their paths; this path cannot be shown faithfully. | Remove the alternative, or rename the file. |
| `alternative-content-unrepresentable` | error | An alternative fix's content cannot be shown exactly | Its text contains characters a review cannot show faithfully, such as an unpaired surrogate or invisible formatting. | Remove the alternative, or correct its content. |
| `alternative-suggestion-fence` | error | An alternative fix could open a suggestion block | Only a validated first fix may create a native suggestion. | Remove the alternative, or change its content. |

### Review preparation: whole-file operations

| Code | Severity | Title | Meaning | Typical remedies |
|---|---|---|---|---|
| `file-operation-multiple-unsupported` | error | A finding proposes several file operations | One finding carries one whole-file proposal. | Give each operation its own finding. |
| `file-operation-unsupported` | error | A proposed file edit is not published | Edits are proposed as SARIF fixes, not as file operations. | Propose the edit as a SARIF fix. |
| `file-operation-unknown` | error | The proposed file operation is unknown | Only `create` and `delete` are defined. | Use `create` or `delete`. |
| `file-operation-conflict` | error | A finding has both fixes and a file operation | They cannot be accepted together. | Keep either the fixes or the file operation. |
| `file-operation-invalid` | error | The proposed file operation is not valid | It has uninterpreted fields, names no artifact, has a wrong file mode, lacks text contents, or describes content a deletion cannot verify. | Correct the operation or its artifact as the message says. |
| `file-operation-path-unrepresentable` | error | The proposed file's path cannot be shown exactly | The review names the file by its path; this one cannot be shown faithfully. | Rename the proposed file. |
| `file-operation-source-not-reviewed` | error | A file operation is based on another revision | A whole-file proposal is published relative to the reviewed commit, but the run's source revision differs. | Derive the proposal from the reviewed commit. |
| `file-operation-binary-unsupported` | error | A proposed file is binary | Binary contents cannot be presented as a proposed file. | Remove the proposal. |
| `file-operation-encoding-unsupported` | error | A proposed file is not UTF-8 | Its declared encoding describes bytes other than the UTF-8 text a review can show. | Propose the file as UTF-8 text. |
| `file-operation-content-unrepresentable` | error | A proposed file's content cannot be shown exactly | Its text contains characters a review cannot show faithfully. | Correct the proposed content. |
| `file-operation-target-exists` | error | A proposed new file already exists | A proposed creation must not replace an existing file. | Propose an edit as a SARIF fix instead, or choose a new path. |
| `file-operation-target-missing` | error | A file proposed for deletion does not exist | The reviewed commit does not have the file. | Remove the proposal, or correct its path. |
| `file-operation-association-unsupported` | error | A finding is located in another file than its proposal | Presenting them together would move the feedback. | Locate the finding in the proposed file, or separate it from the proposal. |

### Suggestion groups and suggestion pull requests

| Code | Severity | Title | Meaning | Typical remedies |
|---|---|---|---|---|
| `suggestion-group-requires-suggestion-prs` | error | A suggestion group needs suggestion pull requests | A group is accepted as one unit through one suggestion pull request; it is never split or published in part. | Enable suggestion pull requests (`--allow-suggestion-prs`, `allowSuggestionPullRequests`).<br>Or ungroup the findings (`ungroup-fixes`). |
| `suggestion-group-member-without-change` | error | A grouped finding proposes no change | A group joins changes; a member without a fix or file operation has none to join. | Remove the finding from the group, or give it its change. |
| `suggestion-group-single-change` | error | A suggestion group holds fewer than two distinct changes | A group needs at least two distinct changes to accept together; identical changes count once. | Remove the group, and the change is published on its own; or add another change to it. |
| `too-many-suggestion-prs` | error | The review would create too many suggestion pull requests | The number of suggestion pull requests one review creates is bounded. | Publish fewer proposals in one review, or group related changes. |
| `suggestion-pr-fallback` | warning | A change is handled as if suggestion pull requests were not allowed | Suggestion pull requests are allowed, but this whole-file creation or deletion cannot become one, so it is published exactly as it would be without them: the review body proposes it, and the limits of that form apply. The reasons: the history was rewritten after the review and the change cannot be re-applied onto the head; the pull request is from a fork, or its head repository was deleted; its base is not the default branch; a created file is over 1,000,000 bytes; or the suggestion pull request's description would be over the body limit. The message names the change and each reason; the remedies are the ways to make the suggestion pull request, if any. Presenting a small edit as a native suggestion is intended, not a fallback. | To propose the change as a suggestion pull request, review the pull request's current head again and publish that review. |
| `suggestion-group-pr-unavailable` | error | A group's suggestion pull request cannot be made | Suggestion pull requests are allowed, but an explicit group or a fix with several changes cannot become one, and without a suggestion pull request its changes cannot be kept together, so the whole review is refused before anything is written, as it is when suggestion pull requests are not allowed. The reasons are those of `suggestion-pr-fallback`. The message names the group or fix and each reason; the remedies address each reason, then removing the group (for a fix, splitting it into separate findings). | Review the pull request's current head again, and publish that review.<br>Or remove the group (`ungroup-fixes`), so that its changes are published on their own. |
| `suggestion-pr-permission-missing` | error | The account cannot push to the repository | Creating proposal branches needs push access. | Use a token of an account with push access, or publish without suggestion pull requests. |
| `suggestion-pr-configuration-invalid` | error | The suggestion pull request configuration is not valid | `.github/suggestion-prs.json` on the default branch cannot be used. | Fix the file on the default branch. |
| `suggestion-label-missing` | error | A suggestion label does not exist | Every label must already exist; the tool never creates one. | Create the label in the repository, or choose an existing one. |

### Review limits

| Code | Severity | Title | Meaning | Typical remedies |
|---|---|---|---|---|
| `too-many-comments` | error | The review needs too many inline comments | Nothing is split or dropped. | Publish fewer findings in one review. |
| `comment-too-large` | error | An inline comment would be too long | Nothing is truncated. | Shorten the finding's message or its fix. |
| `body-too-large` | error | The review body would be too long | Nothing is truncated; the message lists the whole-file proposals in the body. | Publish fewer general findings, or enable suggestion pull requests for whole-file proposals. |
| `payload-too-large` | error | The review would be too large to send | Nothing is truncated or split. | Publish fewer findings in one review. |

### Readiness assessment

| Code | Severity | Title | Meaning | Typical remedies |
|---|---|---|---|---|
| `pending-review-exists` | error | The account already has a pending review on the pull request | GitHub allows one pending review per account on a pull request, so it refuses another review, draft or submitted. This tool never submits, edits or deletes it. | Submit or delete that pending review on GitHub.<br>If it is this tool's own earlier publication, retry publish with that publication's state path. |
| `assessment-incomplete` | error | Readiness could not be assessed | The assessment could not be completed (for example the credential, the network, a source read or the review list failed). This is not a verdict on the document. | Resolve the cause, then validate again. |

### Publication

| Code | Severity | Title | Meaning | Typical remedies |
|---|---|---|---|---|
| `publication-receipt-not-recorded` | warning | Completion could not be recorded in the state file | The review was published, but the state file could not record it. | Keep the state file: a later run with the same state path confirms the review without sending it again. |
| `delivery-unconfirmed` | warning | Delivery could not be confirmed | The review, or a suggestion pull request step, may or may not exist on GitHub. | Retry later with the same state path: it only checks GitHub and never sends the same thing again.<br>Do not delete the state file.<br>A new state path starts a new, separate publication. |
| `review-refused` | error | GitHub refused the review | GitHub definitively refused the create-review request; it is never resent. | Resolve the cause, then publish again with a new state path. |
| `suggestion-pr-step-refused` | error | GitHub refused a suggestion pull request step | The step is never resent, and the review was not published: it would link a suggestion that does not exist. | Resolve the cause, then publish again with a new state path; anything already created is left as it is. |
| `suggestion-branch-moved` | note | The branch changed since the suggestions were planned | The planned suggestion pull requests are created on the commit they were planned on; nothing is re-decided. | — |
| `suggestion-branch-unreadable` | warning | Whether the branch changed since the suggestions were planned is not known | The branch could not be read; nothing is re-decided. | — |

### Suggestion pull request cleanup

| Code | Severity | Title | Meaning | Typical remedies |
|---|---|---|---|---|
| `original-pull-request-unverified` | warning | An original pull request could not be verified | Its state could not be read, so its suggestion pull requests were left open. It is never treated as ended. | Run cleanup again later. |
| `suggestion-pr-close-not-permitted` | warning | GitHub did not allow this account to close a suggestion pull request | Everything else is done; the pull request is eligible but still open. | Someone allowed to close it can run cleanup again. |
| `suggestion-pr-cleanup-failed` | error | Reading or closing a suggestion pull request failed | Cleanup could not finish for this pull request; running it again is safe. | Run cleanup again later. |
| `suggestion-pr-not-conforming` | note | A pull request does not follow the suggestion pull request convention | It was not touched: its marker, repository, original, fork or branch does not conform. | — |

## Open questions

1. **A version marker in each document.** The schema is versioned by its file name and `$id`, and CLI documents carry no version field. A `diagnosticsVersion` key could be appended later if consumers need to detect the version from output alone.
2. **Severity of an uncertain delivery.** `delivery-unconfirmed` is a warning: the review may exist. Its exit status (3) already distinguishes it from success.
3. **Notes.** Only two conditions are notes (`suggestion-branch-moved`, `suggestion-pr-not-conforming`). Other informational facts stay in the primary result.
4. **Repetition in the human output of `validate`, `publish` and `close-suggestion-prs`.** *Resolved September 30, 2026 (owner decision):* the diagnostic blocks on stderr are the single human rendering of problems and warnings, and stdout keeps the outcome text without them (see "Streams").
5. **Color precedence.** *Resolved September 30, 2026 (owner decision):* `--color`, then `FORCE_COLOR`, then `NO_COLOR`, then the terminal, keeping Node's rule that `FORCE_COLOR` overrides `NO_COLOR`.
6. **Human errors of the flag-only publisher.** Its usage and operational errors were a `sarif-to-comment: …` line on stderr; they are now diagnostic blocks, like every other command's. Its exit statuses are unchanged, and its stdout follows the report rule above.
