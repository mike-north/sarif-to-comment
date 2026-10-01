# Review presentation: contract

Implemented behavior, written down September 30, 2026, from the rendering that the review presentation components produce. Not yet presented to the owner for acceptance. It describes the built-in presentation of the review elements that no other contract specifies: a finding, its attribution, its alternatives, the body section that quotes a finding's source, and the warnings list of an outcome report. Whole-file additions and deletions are specified by the [file-operation contract](file-operation-publication-contract.md) §2, suggestion pull requests, their lifecycle note and the review's reference to them by the [companion contract](companion-suggestion-pr-contract.md) §2.11, a native batch's guidance and note by the [delivery policy contract](delivery-policy-contract.md) §8.8, and proposals made by hand on the original pull request (an edit, and a group with its guidance) by that contract's §8.10.

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
| Companion index | The review body's list of the suggestion pull requests that belong to this review: those it creates and the existing ones the caller selects (D56), each by its identity link. | [Companion contract](companion-suggestion-pr-contract.md) §2.13.3 |
| Native batch guidance, native batch note | A group of edits (an explicit group, or a fix with several changes) offered as native suggestions to apply together: the review body's guidance listing every change, and the note in each change's inline comment. Neither is customizable. | [Delivery policy contract](delivery-policy-contract.md) §8.8 |
| Manual edit | One edit of a reviewed file for the author to make by hand, in the review body: its exact replacement (a location link, a code block and the details that make its bytes exact) with the findings that carry it. Never a suggestion. | [Delivery policy contract](delivery-policy-contract.md) §8.10 |
| Manual group guidance | A group kept on the original pull request for the author to assemble by hand and commit once: the guidance listing every change by path and line, and each change's label. Not customizable. | [Delivery policy contract](delivery-policy-contract.md) §8.10 |
| Warnings list | The diagnostics an outcome report lists. This is for the caller and is never posted to GitHub. | §6 |

Links to GitHub (pull requests, reviews, review comments, blob permalinks, commits and comparisons) come from one builder, `src/github-urls.cts`, with one host and one percent-encoding.

## 2. Finding

```
[ STATUS "\n\n" ] MESSAGE [ "\n\n**At this location:** " LOCATION ] [ "\n\n**Fix:** " FIX ] [ "\n\n" ALTERNATIVES ] "\n\n<sub>— " ATTRIBUTION "</sub>"
```

- `STATUS` lists the classification the producer stated, in this order, joined by ` · `: `**Level:** LEVEL` (SARIF 3.27.10, or the rule's default level), `**Kind:** KIND` (3.27.9), `**Baseline:** STATE` (3.27.24). It is absent when none is stated.
- `MESSAGE`, `LOCATION` (the message of the result's one location) and `FIX` (the description of its first fix) are Markdown: the producer's `markdown`, or its `text` escaped so it renders literally, with plain-text `@mentions` shown as code spans.
- `ALTERNATIVES` is §4, present only when the result has further fixes.
- Findings that share an inline comment or a body section are joined by `\n\n---\n\n`. A comment carrying a native suggestion ends with `` "\n\n```suggestion\n" PAYLOAD "```" ``, after all its findings and, for a member of a native batch, after the group's note ([delivery policy contract](delivery-policy-contract.md) §8.8).

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
- Lines a block cannot show exactly block the review at the alternative (`alternative-content-unrepresentable`): a C0 control other than tab, LF and the CR of CRLF; DEL or a C1 control; any format character (Unicode category `Cf`, such as a zero-width space, a soft hyphen, a bidirectional control or a byte-order mark other than the file's own); U+00A0, which renders as a space; U+2028 or U+2029; a carriage return that does not end a line; mixed CRLF and LF; an unpaired surrogate. A manual edit ([delivery policy contract](delivery-policy-contract.md) §8.10) and a new file's content ([file-operation contract](file-operation-publication-contract.md) §2) follow the same rule.

## 5. Finding section

A finding published in the review body rather than inline keeps its source association:

```
[ "**Source:** [" PATH [ " " LINES ] " at " SHORT "](" PERMALINK ")\n\n" [ FENCE "\n" SOURCE "\n" FENCE "\n\n" ] ] FINDING
```

`PERMALINK` is `https://github.com/OWNER/REPO/blob/COMMIT/PATH`, with `?plain=1#LA` or `?plain=1#LA-LB` for lines. `?plain=1` asks GitHub for the source view: for a file GitHub renders (Markdown, for example), the default view is a preview without line anchors, so a line link would not reach its line. It is harmless for other files. A link without lines (a whole-file location, a deletion) has no query. Each path segment is percent-encoded, including `(`, `)`, `!`, `'` and `*`. `SHORT` is the commit's first seven characters. A whole-file location has no lines and no quote. `SOURCE` is the located lines' exact text, in a fence longer than any backtick run inside. Body sections are joined by `\n\n---\n\n`.

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

A library caller may replace the Markdown of the finding, attribution, alternatives, file addition, file deletion, manual edit, lifecycle note, companion index and companion reference components with callbacks (`options.presentation`; README, "Customizing how the review reads"). The core keeps everything this contract and the two contracts it cites make independent of presentation:

- placement, the finding section's source link and quote, and the location line of a finding in a proposed file;
- native suggestion blocks, exactly as validated;
- the review's publication marker and each suggestion pull request's structured marker;
- the size limits.

Each callback's context lists `required` fragments that its result must show as itself. These are the exact proposed content and file details, a deletion's permalink, a manual edit's location link, replacement block and details, a finding's attribution and alternatives, the producers' names, and the findings a proposal carries. **Each fragment counts once:** the fragments must be shown at pairwise-disjoint occurrences, so a fragment that also appears inside another one (a manual edit's location link inside a finding's identical source link, a new file's path inside a finding's message) does not satisfy both. The one overlap allowed is a permalink inside a required link to that same permalink (a manual edit's `url` in its location link). A manual group's guidance, member lines and change labels carry its membership and are the core's: a callback presents each change, never the group. The checks below refuse a result before anything is written.

**Companion index and companion reference.** `companionIndex` and `companionReference` replace the review body's companion index and each companion's section ([companion contract §2.13.3](companion-suggestion-pr-contract.md#2133-the-index)). Their required fragments are every companion's identity link, `[#N](URL)`, which carries its number, and, for a section, its change list and findings. Each link is an identity link: a link whose text reads `#N` (after NFKC and whitespace normalization; an image's alt text counts as its text) must lead to that companion, and these two components may add no link at all, an autolink literal included, and no image, beyond those their built-in Markdown has. Membership and links are guaranteed; the order of the entries and their wording are the callback's. Text that reads as an identity marker is refused only outside code, so a title the built-in index shows as a code span passes through. Because the pull requests a review creates are numbered only once they exist, these two callbacks run during preparation with placeholder numbers, so every check here refuses a bad result before any write, and once more with the real numbers when the review is composed, before its request is recorded and sent, with the same checks, the size limits included. A result refused only then stops the publication after its suggestion pull requests exist, before the review; a retry composes it with that call's callbacks. Once the request is recorded, recovery and retries reuse it byte for byte and call no callback ([companion contract §2.13.4](companion-suggestion-pr-contract.md#2134-identity-recovery-and-completion)).

**Templates.** Repository templates are not implemented. Callbacks are application code, and nothing here evaluates template text. The [template engine evaluation](template-engine-evaluation.md) records the delimiter, value, safety and composition checks D60 requires before an engine is chosen, including template output run through the checks below. It selects no engine.

**Parser basis.** Producer Markdown and callback results are read with a conformant CommonMark 0.31 + GFM parser: micromark with its GFM extension, through `mdast-util-from-markdown` and `mdast-util-gfm`. The parser decides what is code, text, raw HTML, a link, an image or a definition. Two checks remain hand-written, because a Markdown parser does not answer them:

- the balance of the elements that raw HTML opens and closes;
- a deliberately broad refusal of any line that could open a `suggestion` fence.

**Composed-text checkpoint.** Once every inline comment, suggestion pull request description (one per suggestion pull request, however many proposals it bundles) and the review body is fully composed, and the review is within its size limits, the core reads each whole text again, with or without callbacks. The review body is checked before its pull request numbers and publication marker exist, so it is read with the largest pull request number and a sample marker. A description is read with a sample of its structured marker. The text must leave no raw HTML open and swallow nothing after it. It must contain exactly the native suggestion block the core built: one `suggestion` code block, intact, as the comment's last block. A suggestion line inside code the core shows literally, such as a proposed file's content, is code and does not count. Its marker must be its own final node. This is the backstop for every seam between pieces of Markdown. When the body fails, its sections are read to locate the culprit.

- A problem that the same text, composed with the built-in presentation, does not have comes from a callback, and rejects with the presentation `TypeError`. An attribution callback returning `eslint\` is an example: it is clean on its own, but its trailing backslash escapes the `<` of the `</sub>` around it.
- Any other problem comes from producer content. It is reported as `producer-html-unbalanced` or `producer-fence-unclosed` at the finding whose own Markdown shows it, or else at the first finding the text presents.

Producer content combined with a callback's layout is blamed according to whether the built-in layout composes it cleanly:

- A finding callback that places a producer message `    <details>` after a label of its own is refused as the callback's. At the start of a line that message is indented code. The built-in layout, which starts the message on its own line, is clean.
- A producer fix description `    <details>` is refused as the producer's even when a callback places it safely at the start of a line, because the built-in layout places it after `**Fix:** `, where it leaves `<details>` open.

Producer Markdown that the finding places after a label on the same line (`**At this location:** `, `**Fix:** `, an alternative's `(1) `) is also checked after that label, at its own finding or fix. An indented or fenced line reads differently in the middle of a line than at its start.

**What follows must stay outside.** The tool always puts a blank line and further content after producer or caller Markdown. The Markdown is refused when that content would come out inside it, in either of these cases:

- a fenced code block, or an HTML block such as a comment, `<pre>` or `<script>`, runs to the end of the input;
- the raw HTML the parser finds leaves a tag unterminated or an element unclosed.

Values the core shows as code spans (a rule id, a branch name) have their line breaks rendered as spaces, as a code span would, so they can never end their paragraph and start a block of their own. Text and code never count as raw HTML. An unterminated `<!--` inside a paragraph, for example, is text, which GitHub escapes. As in HTML, only void elements (`<br>`, `<img>`, `<hr>` and the like) close themselves. A trailing `/>` on any other start tag, as in `<details/>`, leaves the element open.

**Pass-through by node.** A callback may add no raw HTML (`html` nodes) and no link reference definitions (`definition` nodes) of its own. Such a node is accepted only when its exact source text is also such a node in that component's built-in Markdown. This lets content the producer wrote pass through unchanged, but never extended. A definition or comment that the callback lengthens, or that it re-labels across lines, counts as added.

**Shown as itself.** Both the result and the fragment are parsed, and they must agree at some occurrence of the fragment:

- every node of the result that lies within the occurrence is one of the fragment's own nodes, of the same type and at the same place;
- every node that contains the occurrence shows its content. That means a paragraph, heading, block quote, list, table, emphasis or the like. It may also be a text node, when the fragment alone is plain text, or a link whose text holds the occurrence;
- code, inline code, raw HTML, an image, a definition or any other node conceals the occurrence when it contains it;
- no element that hides its content reaches into the occurrence. Such an element is one GitHub does not display (`<template>`, `<script>`, `<textarea>` and the like), or one with a `hidden` or `style` attribute.

**Permalinks.** A fragment that is a URL, such as a deletion's permalink, may also be exactly the destination of an inline link. It may not be an image's source, since an image does not link to the file. It also may not be the text of a link whose destination is somewhere else, or sit inside a raw-HTML `<a>` (passed through from the presented content) whose `href` is somewhere else. Either would spoof the association.

**Identity links.** A callback may not reuse a link's text to point elsewhere. Every link of the component's built-in Markdown is an identity link. That includes a manual edit's location (``[PATH LINES at SHORT](PERMALINK)``), a deletion's link (``[PATH at SHORT](PERMALINK)``), and the source links and other links of the findings it presents. So is the source link the core places before a finding in a body section (``**Source:** [PATH LINES at SHORT](PERMALINK)``), for the finding callback. Any link in the result whose text reads as an identity link's text must have that identity link's destination (one of them, when several links share a text). Link text, including the alt text of an image inside a link, is compared after compatibility normalization (NFKC), with every run of whitespace read as one space and the ends trimmed, so a trailing, doubled or no-break space, or a fullwidth character, does not make a different text. A look-alike that differs visibly (the letter O for the digit zero) is not caught. The location's `url` is also a required permalink, under the rule below, so it may not be the text of a link elsewhere either.

**No invisible characters of its own.** A callback's result may not contain a format character (Unicode category `Cf`: a zero-width space or joiner, a word joiner, a soft hyphen, a bidirectional control, …) or U+00A0, except inside the content it presents: text that its context gives it and the built-in Markdown carries verbatim, such as a producer's message. Such a character could make a link or a fragment read as something it is not. It is refused like every other problem, with the presentation `TypeError`.

**Known limits of these rules.** They catch text that reads the same. They do not catch visibly different variants: a link to elsewhere whose text differs in a way a reader can see (a 6- or 8-character commit, another letter case, an extra word), or Markdown around the real link that changes how it reads (strike-through, for example). The core still shows every required fragment as itself.

**Math.** GitHub renders `$…$` and `$$…$$` as TeX, where `\phantom{}` and similar commands hide text. The parser does not model math. Producer math is accepted: a producer's Markdown is its own to present. The `$` rule applies only to a callback's required fragments. Such a fragment does not count as shown when the paragraph, heading or table cell containing part of it has an unescaped `$` outside the fragment and outside code. This is deliberately broad within that scope. GitHub's math rendering has not been live-checked.

**Known limit: details are shown, not understood.** A required fragment must be shown, not believed. A callback can still contradict a details fragment it shows, for example by writing "not CRLF line endings" around a manual edit's `CRLF line endings`, or around a new file's details. The check cannot tell; the caller owns that wording.

**Known limit.** GitHub renders with cmark-gfm. For some raw-HTML edge cases, cmark-gfm follows the HTML comment rules of CommonMark 0.29 rather than 0.31. Under 0.29, `<!-->`, `<!--->` and a comment containing `--` or ending in `-` are not comments. Where these differ, the checks follow micromark, except that such a comment is read both ways. Element balance is walked once with the comment as a comment and once with its `<!--` as text. Either walk that leaves something open refuses. So `<!-- a -- <details> -->` is refused, and so is `<details> <!-- -- </details> -->`, whose `</details>` only one reading sees. `<!-- TODO -- fix -->` is accepted. The remaining divergence is recorded for a live check against GitHub; it has not been checked yet.
