# Review presentation: contract

Implemented behavior, written down September 30, 2026, from the rendering that the review presentation components produce. Not yet presented to the owner for acceptance. It describes the built-in presentation of the review elements that no other contract specifies: a finding, its attribution, its alternatives, the body section that quotes a finding's source, and the warnings list of an outcome report. Whole-file additions and deletions are specified by the [file-operation contract](file-operation-publication-contract.md) §2, and suggestion pull requests, their lifecycle note and the review's reference to them by the [companion contract](companion-suggestion-pr-contract.md) §2.11.

**Sources.** [D60](design-decisions.md#d60-use-reusable-markdown-components-for-a-rich-github-review-experience--owner-selected-presentation-direction) (components with clear semantic purposes, systematic links, customization that cannot drop provenance or identity); [D45](design-decisions.md#d45-model-diagnostics-once-and-render-them-per-audience--owner-decision) (diagnostics rendered per audience); [issue #30](https://github.com/mike-north/sarif-to-comment/issues/30) (alternative fixes); [issue #42](https://github.com/mike-north/sarif-to-comment/issues/42) (warnings on every call); [Diagnostics](diagnostics.md).

## 1. Components

Each element with its own meaning is one component, in `src/presentation/`. A component decides only how its element reads. Preparation decides what is published and where, and composes the components.

| Component | What it presents | Specified in |
| --- | --- | --- |
| Finding | One SARIF result as a reader meets it: the producer's stated classification, its explanation, its location message, its fix description, its alternatives and its attribution. | §2 |
| Attribution | Who produced the finding according to the SARIF document: the tool, the extension that defines its rule, and the rule. It is never the GitHub account that publishes the review, and no contributor identity is inferred. | §3 |
| Alternatives | The finding's further fixes, in the producer's order, each with the exact whole-line changes it would make. None is applied, chosen, grouped or unioned. | §4 |
| Finding section | A finding in the review body with its source association: an exact-revision link and, for lines, a literal quote. | §5 |
| File addition, file deletion | A proposed new file, or the removal of a whole file, with the findings that carry it. | [File-operation contract](file-operation-publication-contract.md) §2 |
| Companion reference, companion description, lifecycle note | A suggestion pull request as the review links it, its own body, and how it is accepted. | [Companion contract](companion-suggestion-pr-contract.md) §2.11 |
| Warnings list | The diagnostics an outcome report lists. This is for the caller and is never posted to GitHub. | §6 |

Links to GitHub (pull requests, reviews, review comments, blob permalinks, commits and comparisons) come from one builder, `src/github-urls.cts`, with one host and one percent-encoding.

## 2. Finding

```
[ STATUS "\n\n" ] MESSAGE [ "\n\n**At this location:** " LOCATION ] [ "\n\n**Fix:** " FIX ] [ "\n\n" ALTERNATIVES ] "\n\n<sub>— " ATTRIBUTION "</sub>"
```

- `STATUS` lists the classification the producer stated, in this order, joined by ` · `: `**Level:** LEVEL` (SARIF 3.27.10, or the rule's default level), `**Kind:** KIND` (3.27.9), `**Baseline:** STATE` (3.27.24). It is absent when none is stated.
- `MESSAGE`, `LOCATION` (the message of the result's one location) and `FIX` (the description of its first fix) are Markdown: the producer's `markdown`, or its `text` escaped so it renders literally, with plain-text `@mentions` shown as code spans.
- `ALTERNATIVES` is §4, present only when the result has further fixes.
- Findings that share an inline comment or a body section are joined by `\n\n---\n\n`. A comment carrying a native suggestion ends with `` "\n\n```suggestion\n" PAYLOAD "```" ``, after all its findings.

## 3. Attribution

```
TOOL [ " " VERSION ] [ " · " EXTENSION [ " " EXTENSION-VERSION ] ] [ " · rule " RULE ]
```

`TOOL` is the run's `tool.driver.name`, and `VERSION` its `version`, else its `semanticVersion`. `EXTENSION` is the tool extension that defines the result's rule (`result.rule.toolComponent`), named only when it is not the driver. `RULE` is the rule id as a code span. Names and versions are shown literally. The attribution is one line.

## 4. Alternatives

```
"**Alternatives to consider:**" { "\n\n" "(" N ") " [ DESCRIPTION "\n\n" ] CHANGES }        (N = 1, 2, …)
```

`CHANGES` states the exact whole-line changes of reviewed files:

- One change: ``Replace LINES [of `PATH`] with[ (CRLF line endings)]:`` then a blank line and `BLOCK`, or ``Delete LINES [of `PATH`].``. The path is named only when it differs from the first fix's file.
- Several: `Changes K files together:` or `Makes K changes together:`, then for each change a blank line and ``` `PATH` — replace LINES with[ (CRLF line endings)]: ``` with its `BLOCK`, or ``` `PATH` — delete LINES. ```.
- `LINES` is `line N` or `lines N-M` of the reviewed file.
- `BLOCK` is a fenced code block of the replacement lines, with LF line breaks and without the final terminator. Its fence is one backtick longer than the longest backtick run inside, and at least three.

## 5. Finding section

A finding published in the review body rather than inline keeps its source association:

```
[ "**Source:** [" PATH [ " " LINES ] " at " SHORT "](" PERMALINK ")\n\n" [ FENCE "\n" SOURCE "\n" FENCE "\n\n" ] ] FINDING
```

`PERMALINK` is `https://github.com/OWNER/REPO/blob/COMMIT/PATH`, with `#LA` or `#LA-LB` for lines. Each path segment is percent-encoded, including `(`, `)`, `!`, `'` and `*`. `SHORT` is the commit's first seven characters. A whole-file location has no lines and no quote. `SOURCE` is the located lines' exact text, in a fence longer than any backtick run inside. Body sections are joined by `\n\n---\n\n`.

## 6. Warnings list

Outcome reports (the library's `markdown`, and the CLI's JSON and TOON `message`) list diagnostics one per line:

```
"- `" CODE "`" [ " at `" POINTER "`" ] ": " MESSAGE
```

A report with warnings ends with them:

```
"**Warnings:**\n\n" LINE { "\n" LINE }
```

A prepared review's report begins `**Review prepared:** C inline comment(s) and S general section(s) for commit `COMMIT`.` A published outcome does not repeat that summary. It states its warnings in a headline under its heading and ends with this list, on its first call and on every later call for the same state path ([Diagnostics](diagnostics.md), "Headline" and "Warnings on every call for a publication").

## 7. Customization

A library caller may replace the Markdown of the finding, attribution, alternatives, file addition, file deletion and lifecycle note components with callbacks (`options.presentation`; README, "Customizing how the review reads"). The core keeps everything this contract and the two contracts it cites make independent of presentation:

- placement, the finding section's source link and quote, and the location line of a finding in a proposed file;
- native suggestion blocks, exactly as validated;
- the review's publication marker and each suggestion pull request's structured marker;
- the size limits.

Each callback's context lists `required` fragments that its result must show as itself. These are the exact proposed content and file details, a deletion's permalink, a finding's attribution and alternatives, the producers' names, and the findings a proposal carries. Showing a fragment as itself means not inside a comment, a code span or block it does not open itself, a tag, a link destination or title, an image description, or an element GitHub does not display. A result that breaks this, or that adds a comment, CDATA section, processing instruction, declaration or link reference definition of its own, is refused before anything is written. The companion reference is not customizable yet.
