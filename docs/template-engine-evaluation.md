# Template engine evaluation

Recorded October 1, 2026, against `main` at `c6c7fcb`.

> **This is an evaluation, not a selection.** No template engine was integrated into the product, and no dependency was added to the package's `package.json` or lockfile. The candidates were installed only in an isolated scratch directory. This record selects no engine. The owner decides when repository templates are implemented. Until then, [D60](design-decisions.md#d60-use-reusable-markdown-components-for-a-rich-github-review-experience--owner-selected-presentation-direction)'s "No engine has been selected or verified" still stands. This record supplies the capability and Markdown checks that D60 requires before any selection.

**Sources.** [D60](design-decisions.md#d60-use-reusable-markdown-components-for-a-rich-github-review-experience--owner-selected-presentation-direction), its "Template execution constraint", "Permitted compilation" and "Markdown compatibility" paragraphs; the [review presentation contract](review-presentation-contract.md) §7 (required fragments, the composed-text checkpoint, pass-through by node, markers); and the engineering shortlist this evaluation was asked to check: mustache.js, an in-house Mustache subset and sandboxed LiquidJS, with Handlebars ranked third. The cases it was asked to cover are prototype access, helper loading, delimiter collisions (`{{`, `${{ }}`), re-parsing of values, dynamic fences, CRLF and trailing newlines.

## 1. The constraints checked

| Id | D60 constraint |
| --- | --- |
| C1 | Templates must not enable arbitrary code execution. Lodash `template` and EJS are excluded by name. |
| C2 | A template may compile to a function only if what the template can make that function do is present the supplied data. It must not import libraries, make network requests or perform arbitrary operations. |
| C3 | A template must not implicitly load executable repository helpers. This evaluation also checks partials and layouts loaded from disk. |
| C4 | Interpolation delimiters must coexist with Markdown without awkward template-specific escaping. Delimiter collisions in static text are checked separately from the handling of interpolated values. |
| C5 | Intended bytes and native-suggestion semantics are preserved. Code keeps its exact characters, and no generic escaping is applied. |

Whatever the engine, the result must also pass the checks that the presentation contract §7 applies to every callback result, and the composed-text checkpoint.

## 2. Method

**Candidates and configurations.** The candidates are mustache.js 4.2.0, LiquidJS 10.29.0 and Handlebars 4.7.9, from the npm registry, installed in `scratch/engines/` with their own `package.json`, plus the in-house subset sketched in `scratch/eval/subset.mjs` (138 lines, reproduced in the [appendix](#appendix-the-in-house-subset-sketch)). The tests ran on Node 24.14.0, with `dist/` built from `c6c7fcb` (`pnpm run build`). Each engine ran in up to three configurations:

| Configuration | Settings |
| --- | --- |
| mustache.js, default | `Mustache.render(t, data)`, which HTML-escapes `{{v}}`. |
| mustache.js, escape off | `Mustache.render(t, data, {}, { escape: String })`. |
| mustache.js, fixed `<% %>` | As escape off, plus `tags: ['<%', '%>']` set by the product, not by the template. |
| Subset | The appendix grammar. Delimiters are fixed at `{{ }}`. There is no escaping, and lookup is strict and own-property only. Tags in the `{{{{raw}}}}` literal block are not processed. Templates are capped at 256 KiB, sections at 16 levels of nesting, and output at 1 MiB. |
| LiquidJS, default | `new Liquid()`. |
| LiquidJS, hardened | `ownPropertyOnly`, `strictVariables`, `strictFilters`, `lenientIf` (an absent optional field in `{% if %}` is false), an `fs` that refuses every read, empty `root`/`partials`/`layouts`, `relativeReference: false`, `dynamicPartials: false`, no cache, `parseLimit` 256 KiB, `renderLimit` 1000 ms, `memoryLimit` 1 MiB. |
| Handlebars, default | `Handlebars.compile(t)(data)`. |
| Handlebars, hardened | An isolated environment (`Handlebars.create()`) with `log` and `lookup` unregistered and a product-registered `raw` block helper. It compiles with `noEscape`, `strict`, `knownHelpersOnly` (`raw`, `if`, `unless`, `each`, `with`), and renders with `allowProtoPropertiesByDefault` and `allowProtoMethodsByDefault` set to false. |

**Scripts.** There are four, all under `scratch/eval/`:

- **A** (`test-a-static.mjs`) renders static Markdown with empty data and compares bytes.
- **B** (`test-b-values.mjs`) interpolates each value between brackets, as `[VALUE]`, and compares the result with the exact bytes.
- **C** (`test-c-safety.mjs`, with `c-worker.mjs`) runs each attempt in a fresh Node process with a 10-second bound. The process's data is a structured, cloned, deeply frozen object, like a callback context. The worker records the output or the error, whether a sentinel global was set (which would mean code ran), anything the engine wrote to the console, and the elapsed time.
- **D** (`test-d-composition.mjs`) calls `prepareReview` from the built `dist/prepare-review.cjs`. Its `options.presentation` callbacks render a template with the callback's own context as data, so every result goes through `present()` and the composed-text checkpoint exactly as a library callback's would.

**The scripts are not committed.** D depends on the built `dist/`, so the scripts depend on files outside `scratch/`. This section and the tables below summarize them, with their exact inputs and outputs.

## 3. A: delimiter collisions in static Markdown

Each template is static Markdown alone, rendered with empty data. The cases are:

````text
A1  link + reference definition  See [the guide][guide] and [docs](https://example.com/a_(b)?q=1&r=2#x).⏎⏎[guide]: https://example.com/guide "Guide"⏎
A2  nested list                  - item one⏎  - nested `x`⏎1. first⏎
A3  table with pipes             | Column | Value |⏎| --- | --- |⏎| a \| b | `c|d` |⏎
A4  inline code {{               Type `{{` to start.⏎
A5  inline code }}               Type `}}` to end.⏎
A6  inline code {{ … }}          Between `{{` and `}}`.⏎
A7  inline Actions expression    Use `${{ github.token }}`.⏎
A8  inline Liquid tag            Use `{% if x %}`.⏎
A9  fenced Actions YAML          ```yaml⏎steps:⏎  - run: echo "${{ github.token }}"⏎    if: ${{ github.event_name == 'push' }}⏎```⏎
A10 fenced Jinja                 ```jinja⏎Hello {{ user.name }}! {% for x in xs %}{{ x }}{% endfor %}⏎```⏎
A11 fenced Liquid with raw       ```liquid⏎{% raw %}{{ page.title }}{% endraw %}{% comment %}note{% endcomment %}⏎```⏎
A12 fenced Python f-string       ```python⏎print(f"{{literal}} {{{value}}}")⏎```⏎
A13 fenced Handlebars            ```hbs⏎{{#each items}}{{this}}{{/each}}⏎```⏎
A14 fenced ERB/EJS               ```erb⏎<%= user.name %> <% if x %>y<% end %>⏎```⏎
A15 suggestion fence             ```suggestion⏎const value = compute();⏎```⏎
A16 HTML comment                 <!-- a reviewer note -->⏎
A17 marker-like HTML comment     <!-- sarif-to-comment:review:00000000-0000-4000-8000-000000000000 -->⏎
A18 backslashes                  C:\path\to\file \* \_ \\ \` and a hard break\⏎end.⏎
A19 backslash before {{          Literal \{{ not a tag }} here.⏎
A20 CRLF, no final newline       # Title␍⏎␍⏎- a␍⏎- b␍⏎␍⏎| x |␍⏎| - |␍⏎| y |
````

(`⏎` is LF, and `␍⏎` is CRLF.) In the table, **same** means identical bytes, **CHANGED** means rendered without error but with different bytes (silent corruption), and **error** means the engine refused (a loud failure). mustache.js's default and escape-off configurations behave identically on static text, since escaping applies only to values.

| Case | mustache.js `{{ }}` | mustache.js fixed `<% %>` | Subset | LiquidJS default | LiquidJS hardened | Handlebars default | Handlebars hardened |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1–A3 | same | same | same | same | same | same | same |
| A4 | error | same | same | error | error | error | error |
| A5 | same | same | same | same | same | same | same |
| A6 | **CHANGED** | same | same | error | error | error | error |
| A7 | **CHANGED** | same | error | **CHANGED** | error | **CHANGED** | error |
| A8 | same | same | same | error | error | same | same |
| A9 | **CHANGED** | same | error | **CHANGED** | error | error | error |
| A10 | **CHANGED** | same | error | **CHANGED** | error | **CHANGED** | error |
| A11 | **CHANGED** | same | error | **CHANGED** | **CHANGED** | **CHANGED** | error |
| A12 | **CHANGED** | same | error | error | error | **CHANGED** | error |
| A13 | error | same | error | error | error | **CHANGED** | **CHANGED** |
| A14 | same | error | same | same | same | same | same |
| A15–A18 | same | same | same | same | same | same | same |
| A19 | **CHANGED** | same | same | **CHANGED** | error | **CHANGED** | **CHANGED** |
| A20 | same | same | same | same | same | same | same |

The silent changes, exactly:

```text
A6  mustache.js        "Between ``.\n"                       (the span from {{ to }} was read as one tag)
A7  mustache.js, LiquidJS default, Handlebars default
                       "Use `$`.\n"
A9  mustache.js        "  - run: echo \"$\"" and "    if: $"
A9  LiquidJS default   "  - run: echo \"$\"" and "    if: $false"
A10 mustache.js, Handlebars default
                       "Hello ! {% for x in xs %}{% endfor %}"
A10 LiquidJS default   "Hello ! "
A11 mustache.js, Handlebars default
                       "{% raw %}{% endraw %}{% comment %}note{% endcomment %}"
A11 LiquidJS default and hardened
                       "{{ page.title }}"                   (the sample's own raw and comment tags were executed)
A12 mustache.js, Handlebars default
                       "print(f\" \")"
A13 Handlebars default and hardened
                       "```hbs\n\n```"                      (strict mode does not cover helper arguments)
A19 mustache.js, LiquidJS default
                       "Literal \\ here.\n"
A19 Handlebars default and hardened
                       "Literal {{ not a tag }} here.\n"    (the backslash, Markdown's own escape, was consumed)
```

Links, reference definitions, lists, tables, the suggestion fence, HTML comments including the marker-like one, backslashes, CRLF line endings and a missing final newline were byte-identical in every engine. No engine normalized line endings or added or removed a final newline.

**The whole representative document.** All the cases above were placed in one 40-line document (`scratch/eval/fixtures/static.md`) and rendered twice: once with LF and a final newline, and once with CRLF and no final newline. Next, each engine got the escaping its author would need to keep the document literal. Every escaped version rendered identical bytes in both variants.

| Engine | Unescaped | Escaping needed to keep the bytes literal |
| --- | --- | --- |
| mustache.js `{{ }}` | **CHANGED**, silently: 771 → 641 characters (LF) | One standalone line, `{{=<% %>=}}`, at the top. Every interpolation in the template then uses `<% %>`. This is equivalent to the fixed-delimiter configuration, and it moves the collision to ERB/EJS samples (A14). |
| Subset | error at line 15, `unknown name "github.token"` | Four `{{{{raw}}}}…{{{{/raw}}}}` wrappers: the inline Actions code span and the YAML, Jinja and Liquid fences. Each error names the line that needs one. Non-tag braces (A4, A6, A19) and Liquid tags needed nothing. |
| LiquidJS hardened | error at line 15 | Five `{% raw %}…{% endraw %}` wrappers. A Liquid sample that itself contains `{% endraw %}` cannot sit inside `raw`, and needed `{% raw %}{% raw %}{{ page.title }}{% endraw %}{{ "{% endraw %}" }}{% raw %}{% comment %}note{% endcomment %}{% endraw %}`. |
| Handlebars hardened | parse error at line 15 | Five `{{{{raw}}}}…{{{{/raw}}}}` blocks, which need a `raw` helper that the product registers. The backslash escape `\{{` cannot be used, because it consumes the backslash and stays in effect only until the next `{{`. |

## 4. B: interpolated values

The template is `[TAG]`, and the data holds the value plus `x`, `p` and `github.token`, so that a re-parse would show.

```text
B1 Markdown metacharacters   **bold** _em_ [link](https://x.test) | a | b |⏎# Heading⏎- item⏎> quote
B2 HTML                      <details><summary>s</summary>⏎<!-- open comment
B3 backticks and fence runs  `code` ``` ```` ~~~⏎```⏎break out⏎```
B4 CRLF                      one␍⏎two␍⏎
B5 invisible / control       a U+200B b U+202E c U+FEFF d U+0000 e U+2028 f
B6 template-like text        {{x}} {{{x}}} {{#x}}y{{/x}} {{> p}} {{=<% %>=}} {% x %} {%- if x -%}{{ x | upcase }} <%x%> ${{ github.token }} {{{{raw}}}}
B7 code                      if (a < b && c > "d") { s = 'q' + `r`; } // x = y
B8 long                      "a<b&" × 50,000 (200,000 characters)
B9 huge                      "x" × 5,000,000
```

| Value | mustache.js `{{v}}`, default | mustache.js `{{{v}}}` / escape off / fixed `<% %>` | Subset `{{v}}` | LiquidJS `{{ v }}`, default and hardened | LiquidJS `{{ v \| escape }}` | Handlebars `{{v}}`, default | Handlebars `{{{v}}}` / hardened `noEscape` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | **escaped** | exact | exact | exact | **escaped** | **escaped** | exact |
| B2 | **escaped** | exact | exact | exact | **escaped** | **escaped** | exact |
| B3 | **escaped** | exact | exact | exact | exact | **escaped** | exact |
| B4, B5 | exact | exact | exact | exact | exact | exact | exact |
| B6 | **escaped**, not re-parsed | exact | exact | exact | **escaped**, not re-parsed | **escaped**, not re-parsed | exact |
| B7 | **escaped** | exact | exact | exact | **escaped** | **escaped** | exact |
| B8 | **escaped**, 550,002 characters | exact | exact | exact | **escaped** | **escaped** | exact |
| B9 | exact | exact | refused: output over 1 MiB | exact | exact | exact | exact |

What default HTML escaping did to the code value B7:

```text
mustache.js  [if (a &lt; b &amp;&amp; c &gt; &quot;d&quot;) { s &#x3D; &#39;q&#39; + &#x60;r&#x60;; } &#x2F;&#x2F; x &#x3D; y]
Handlebars   [if (a &lt; b &amp;&amp; c &gt; &quot;d&quot;) { s &#x3D; &#x27;q&#x27; + &#x60;r&#x60;; } // x &#x3D; y]
LiquidJS     [if (a &lt; b &amp;&amp; c &gt; &#34;d&#34;) { s = &#39;q&#39; + `r`; } // x = y]     (only with | escape; off by default)
```

The three questions:

- **(a) Re-parsing.** No engine, in any configuration, re-parsed an interpolated value as template code. The template-like text B6 came out byte-exact wherever escaping was off, and only HTML-escaped where it was on.
- **(b) Default HTML escaping.** mustache.js and Handlebars escape `{{v}}` by default and so corrupt code bytes, backticks and Markdown links (mustache.js also escapes `/`). LiquidJS does not escape by default. D shows that the product's checks refuse escaped output when it touches a required fragment.
- **(c) Exact bytes for raw interpolation.** All four engines were exact with escaping off, including CRLF, NUL, bidirectional controls, U+2028 and a 5-million-character value. Every render took less than 5 ms. The subset refuses output over its 1 MiB cap, by design. GitHub's own body limit of 65,536 characters is far lower.

**Typed fragments, not raw text in template-authored code.** A value placed inside a fence that the template itself writes breaks out of it whatever the engine. For example, the subset rendered `` ```⏎{{v}}⏎``` `` with `v` = `` a⏎```⏎<details>⏎``` `` as `` ```⏎a⏎```⏎<details>⏎```⏎``` ``. So code must reach a template as a fragment the core has already fenced, with the dynamic fence (contract §4 and §5), and the core's checks then confirm that the fragment is shown as itself (D).

## 5. C: safety negatives

The data was a deeply frozen, structured clone of `{ v: 'value', obj: { name: 'n' }, items: ['0' … '9'] }`. In no attempt, in any engine or configuration, did the sentinel global get set: no code ran. An empty output (`""`) means the tag rendered as the empty string. Unless noted, mustache.js's default configuration behaves as escape off.

| Attempt | mustache.js | Subset | Handlebars default | Handlebars hardened |
| --- | --- | --- | --- | --- |
| `{{constructor}}` | `[object Object]`: it **called** `Object()` | refused (forbidden name) | `""` | `""` |
| `{{constructor.constructor}}` | `""`: it **called the `Function` constructor**, which built an empty function | refused | `""` | refused (strict) |
| `{{__proto__}}` | `[object Object]` | refused | `""` | `""` |
| `{{toString}}` | `[object Object]` (**called**) | refused (unknown name) | `""`, and a console error | `""` |
| `{{v.constructor.name}}` | `String` | refused | `""` | refused |
| `{{hasOwnProperty}}` | `false` (**called**) | refused | `""`, and a console error | `""` |
| `{{v.toUpperCase}}` | `""` (**called**, with the context as `this`) | refused | `""`, and a console error | refused |
| `{{items.pop}}` | TypeError, "Cannot add property length, object is not extensible": it **called** `Array.prototype.pop` on the context, and only the freeze stopped the mutation | refused | `""`, and a console error | `""` |
| `{{#obj}}{{__defineGetter__}}{{/obj}}` | TypeError (**called**) | refused | `""` | `""` |
| `{{#constructor.constructor}}globalThis.PWNED = 1{{/…}}` | `""`, nothing ran | refused | `""` | refused |
| `{{#constructor}}{{#constructor}}globalThis.PWNED = 1{{/…}}{{/…}}` | outputs the section text `globalThis.PWNED = 1`, which did not run | refused | `""` | `""` |
| Handlebars gadget of the CVE-2019-19919 family (`lookup` / `string.sub.apply`) | parse error | parse error | `""`: prototype access was denied (console error), and the gadget did not run | refused at compile: `lookup` is not a known helper |
| `{{log "leaked to console"}}` | `""` | stays literal text | `""`, and it **wrote "leaked to console" to `console.info`** | refused at compile |
| `{{lookup . "constructor"}}` | `""` | literal | `""` | refused at compile |
| Unknown helper `{{foo v}}` | `""` | literal | refused (missing helper) | refused at compile |
| `{{process.env.HOME}}`, `{{require}}` | `""` | refused (unknown name) | `""` | refused |
| Partial `{{> secret.txt}}`, `{{> /etc/hosts}}` | `""`: only partials passed by the caller are used, never the disk | literal | refused (not registered) | refused |
| Recursive partial `{{> self}}` (none registered) | `""` | literal | refused | refused |
| 10,000 nested sections | stack overflow, 23 ms | refused: deeper than 16 levels, 0 ms | stack overflow after about 9 s | stack overflow after about 9 s (one run went past the 10 s bound and was killed) |
| 1,000,000 tags (a 5 MB template) | 5,000,000 characters rendered in 219 ms | refused: template over 256 KiB, 0 ms | **process crashed, out of memory** | **process crashed, out of memory** |
| Output amplification: 8 nested sections over 10 items = 10^8 | **100,000,000 characters in 2.3 s**, no bound | refused at 1 MiB of output, 112 ms | `""` (Handlebars scoping did not resolve the nested `items`; not a bound) | TypeError from strict mode on string items (not a bound) |

The LiquidJS attempts use Liquid syntax:

| Attempt | LiquidJS default | LiquidJS hardened |
| --- | --- | --- |
| `{{ constructor }}`, `{{ __proto__ }}`, `{{ v.constructor }}`, `{{ v.toString }}`, `{{ obj.constructor.constructor }}` | `""` | refused (undefined variable) |
| Unknown filter `{{ v \| evil }}` | `value`: the filter was silently ignored | refused (undefined filter) |
| `{{ "now" \| date: "%Y" }}` | `2026`: **reads the clock** | `2026`: **reads the clock** (built-in filter) |
| `{{ process.env.HOME }}` | `""` | refused |
| `{% include "secret.txt" %}` (a file in the working directory) | **read the file into the output**: `SECRET-FILE-CONTENTS` | refused (the `fs` denies it) |
| `{% layout "secret.txt" %}` | **read the file into the output** | refused |
| `{% render "../engines/package.json" %}`, `{% include "/etc/hosts" %}` | refused (outside root `.`) | refused |
| A file including itself | stack overflow after 239 ms | refused (no `fs`) |
| 10,000 nested `{% if %}` | ParseError (stack), 32 ms | ParseError (stack), 32 ms |
| 1,000,000 output tags (an 8 MB template) | **hung, killed at 10 s** | refused: `parseLimit` |
| `{% for i in (1..100000000) %}` | **hung, killed at 10 s** | refused: `memoryLimit` |
| 8 nested `for` over 10 items | **hung, killed at 10 s** | refused: `renderLimit`, after 1 s of wall-clock time |

Findings:

- **mustache.js** never ran code from a template here. Its lookup does, however, follow the prototype chain and call any function it reaches, with the context as `this`: `Object`, `Function`, `toString`, `hasOwnProperty`, `pop`, `__defineGetter__`. Only the product's deep freeze kept `{{items.pop}}` from mutating the context. It also has no bound on template size or output.
- **LiquidJS's default** configuration reads files relative to the process's working directory, which in a review job is the reviewed checkout, and places them in the output. A repository template could publish a checked-out file, such as a generated `.env`, into a review comment. The hardened configuration closes this, but its bounds are partly wall-clock time (`renderLimit`), so whether a render is refused can vary between runs. The `date` filter reads the clock even when hardened, which breaks the callback rule that rendering is deterministic, unless the filter is overridden.
- **Handlebars** compiles template text to JavaScript source and evaluates it with `new Function`. Its hardened configuration refused every injection attempt, but compilation alone took about 9 seconds and then overflowed the stack on deep nesting, and a 5 MB template crashed the whole process with an out-of-memory error, which cannot be caught. Its advisory history includes code-execution and prototype-pollution flaws reachable from template content: CVE-2019-19919, CVE-2019-20920, CVE-2021-23369 and CVE-2021-23383, all fixed before 4.7.9. These identifiers were not verified from local files; the package's own release notes describe matching code-execution and prototype fixes from 4.0.14 to 4.7.7, and 4.7.9 itself lists a further unspecified security fix. Its default configuration also writes to the console from templates (`{{log}}`).
- **The subset** has no path from a template to any function, prototype, file or helper. Unknown names fail loudly. Helper, partial and set-delimiter syntax is simply literal text. Every bound is a size or depth limit, so it is deterministic.

## 6. D: composition with the product's checks

**Reproducing the built-in presentation.** The input was one SARIF document. Its tool is `Lint 1.2.3`, and it has an extension `style-pack 0.4`. It has three results:

- a body finding with level, kind and location message;
- an inline finding with a native suggestion, a fix description and one alternative;
- a whole-file creation, whose content `` Use `x` && <b>y</b>; see ${{ github.token }} and {{ name }}. `` contains template-like text, HTML and `&`.

Each engine's hardened configuration rendered templates for the `attribution`, `finding` and `fileAddition` components, using the callback context directly as data. For example, the Mustache-family attribution template is:

```text
{{tool}}{{#version}} {{version}}{{/version}}{{#component}} · {{name}}{{#component.version}} {{component.version}}{{/component.version}}{{/component}}{{#ruleId}} · rule `{{ruleId}}`{{/ruleId}}
```

| Engine | Preparation | Every posted text (review body, inline comment) identical to the built-in | Each callback result equal to `context.markdown` |
| --- | --- | --- | --- |
| mustache.js | ready | yes | 7 of 7 |
| Subset | ready | yes | 7 of 7 |
| LiquidJS | ready | yes | 7 of 7 |
| Handlebars | ready | yes | 7 of 7 |

The proposed file's `${{ github.token }}` and `{{ name }}` reached the review unchanged in every engine, because a value is never re-parsed. The status line (`**Level:** warning · **Kind:** fail`) joins whichever fields are present. Logic-less Mustache can express it, but only with nested inverted sections (`{{#level}} · {{/level}}{{^level}}{{#kind}} · {{/kind}}{{/level}}`). Liquid and Handlebars express it with `or` / `else if`.

**Raw values where a Markdown fragment is required.** With the tool renamed `lint_*`, the same attribution template, interpolating the context's raw `tool`, was refused for every engine: `omits a required fragment, which must appear verbatim: "lint\\_\\*"`. Template contexts carry raw strings, but the built-in Markdown escapes them.

**Malicious templates.** The SARIF here has no extension and no alternatives, so every refusal below is the product's, not the engine's. The control row confirms that a minimal faithful template is accepted.

| Template | All four engines |
| --- | --- |
| Control: `{{message}}⏎⏎<sub>— {{attribution}}</sub>` | accepted |
| Finding drops the attribution: `{{message}}` | refused: omits a required fragment, ``"Lint 1.2.3 · rule `no-x`"`` |
| Finding forges a native suggestion: control plus `` ⏎⏎```suggestion⏎rm -rf /⏎``` `` | refused: could open a suggestion block |
| Finding forges a publication marker: control plus `<!-- sarif-to-comment:review:0000…0000 -->` | refused: reads as a publication or suggestion marker |
| Finding hides the attribution in `<details><summary>more</summary>` | refused: adds raw HTML of its own |
| Finding leaves a fence open: control plus `` ⏎⏎```` `` | refused: leaves a code fence open |
| Finding opens an HTML comment block: control plus `⏎⏎<!--` | refused: leaves an HTML `<!--` construct open |
| Attribution spans lines: `{{tool}}⏎⏎# Approved by the maintainers` | refused: spans more than one line |
| Attribution ends in a backslash: `{{tool}}\` | refused **at the composed-text checkpoint**: in inline comment 1, it leaves a `<sub>` element open |
| File addition re-fences the content: ` ````⏎{{content}}⏎```` ` | refused: hides a required fragment |
| File addition drops the file details | refused: omits a required fragment |

Two further results:

- **mustache.js with its default escaping**, on otherwise faithful templates, was refused: the escaped backticks of `` rule `no-x` `` dropped the required attribution fragment.
- **Accepted, but wrong.** `**Level:** {{level}}`, applied to the file-addition finding, which states no level, was refused by the three strict engines (unknown name) and **accepted from mustache.js**, which renders `**Level:** ` with nothing after it. Mustache's context-stack fallback goes further. The attribution template `…{{#component}} · {{name}}{{#version}} {{version}}{{/version}}{{/component}}…`, given an extension that states no version, renders `` Lint 1.2.3 · style-pack 1.2.3 · rule `no-x` ``. That shows the extension with the **tool's** version, and it was **accepted** from both mustache.js and the subset, because the required fragments are the names, not their versions. The built-in Markdown is `` Lint 1.2.3 · style-pack · rule `no-x` ``.

The checks are an engine-independent backstop for structure, required provenance, suggestion blocks and markers: they refused every structural attack, whichever engine rendered it. They cannot know which static text or which optional value the template author intended.

## 7. Verdicts

**Pass** means the property held in every test above. **Conditional** means it holds only under the stated product-side measures. **Fail** means a test showed a violation.

| Constraint | mustache.js (escape off) | Subset | LiquidJS (hardened) | Handlebars (hardened) |
| --- | --- | --- | --- | --- |
| C1 No arbitrary code | Conditional. No code ran, but lookup calls any reachable function, including the `Function` constructor. | Pass. There is no path to a function, provided the data is a structured clone (which has no getters): an own accessor property would be invoked. | Pass. The default also ran no code. | Conditional. It compiles to `new Function`, and its CVE history includes code execution from templates. The hardened configuration refused the gadget. |
| C2 Presentation only | Conditional. It calls built-ins with the context as `this`, and only the product's deep freeze prevented a mutation. Output and template size are unbounded. | Pass. Own enumerable data only, with deterministic size and depth bounds. | Conditional. `date` reads the clock, the filter and tag surface is large, and the time-based `renderLimit` makes refusal vary between runs. The default fails: it reads files and hangs. | Fail on resources: about 9 s to compile deep nesting, and an uncatchable out-of-memory crash on a 5 MB template. The default writes to the console. |
| C3 No implicit helpers or partials | Pass. Only caller-passed partials, so `{{>` renders empty silently. | Pass. There is no partial or helper syntax. | Pass with the denying `fs`. The default fails: `include` and `layout` read the working directory. | Pass. Only registered partials and helpers. |
| C4 Coexists with Markdown | Fail with `{{ }}`: Actions, Jinja, Liquid, Python and `\{{` text is silently corrupted. Conditional with product-fixed `<% %>`: no collision except ERB/EJS samples, which fail loudly. | Conditional. Every collision in A fails loudly or stays literal, and one `{{{{raw}}}}` wrapper per region fixes it. A static `{{ name }}` that names a real field interpolates silently. | Fail. Inline `{{` and `{%` are errors. A11 (Liquid's own tags in a sample) is silently executed even hardened. A sample containing `{% endraw %}` needs a contortion. | Fail. `\{{` silently consumes Markdown's backslash. `{{#each}}` samples are silently emptied even hardened. Literal regions need a product helper. |
| C5 Bytes and suggestion semantics | Pass with escaping off. The default escaping fails, and the checks refuse it. | Pass. | Pass. There is no escaping by default. | Pass with `noEscape`. The default escaping fails. |

## 8. Recommendation

This is a recommendation for the owner. It is not a selection.

**Preferred: the in-house subset.** It needs one design change and one addition before any implementation.

- **Why:**
  - It is the only candidate that passed every constraint without relying on a product-side measure. There is no path from a template to a function, a prototype, a file or a helper, because no such syntax exists.
  - Unknown names fail loudly, which turns most delimiter collisions into errors instead of silent corruption. Non-tag braces stay literal.
  - Its bounds are deterministic sizes.
  - It is byte-exact across LF, CRLF and a missing final newline.
  - It reproduced the built-in components exactly.
  - It is under 150 lines, has no dependency, and can be written spec-first.
- **Design change:**
  - Remove the context-stack fallback. Inside a section, a bare name resolves only in the section's own value. Reaching an outer field takes an explicit path from the root.
  - D shows the fallback attributing the tool's version to an extension, and the checks cannot catch that.
  - This is a deliberate departure from Mustache semantics. Its cost is that ordinary Mustache templates that rely on scope inheritance stop working.
- **Addition:**
  - The template context should expose Markdown fragments, not only raw strings: for example, the tool's name escaped as the built-in shows it, and the path as a code span.
  - Raw strings remain available for sections and conditions. D shows a raw `tool` refused once a name contains Markdown metacharacters.
- **Untested option:** treat a `{{` immediately preceded by `$` as literal. That would make GitHub Actions expressions, the most common collision in review content, need no escaping. It was not measured here.
- **Residual risks:**
  - Maintenance stays in-house, and a grammar and its edge cases must be specified.
  - The `{{{{raw}}}}` literal block is borrowed from Handlebars and is not standard Mustache.
  - Joins and conditional separators are verbose without `else` or `or`.
  - A static example that happens to name a real context field (`` `{{ message }}` ``) interpolates silently.

**Alternative, if a maintained dependency is preferred: mustache.js** with delimiters fixed by the product, escaping off, and typed fragments.

- **Required wrapper:**
  - Validate the token tree from `Mustache.parse` before rendering. Allow only text, name, section, inverted-section and comment tokens, and refuse partials (`>`), unescaped (`&`, `{`) and set-delimiter (`=`) tokens.
  - Allowlist names against the context's own keys. This is what makes unknown names fail loudly and stops calls to built-ins.
  - Render against null-prototype, deeply frozen data, and bound the template and output size.
- **Cost:** that wrapper is about the size of the subset, so the dependency saves little.
- **Delimiters:** fixed `<% %>` avoided every collision except ERB/EJS samples, where it fails loudly. Any fixed pair moves the collision somewhere else.

**Not recommended:**

- **LiquidJS.** It is acceptable only in the hardened configuration. It collides with Markdown and with code samples more than any other candidate, silently runs Liquid's own tags in static samples, has a large surface, nondeterministic filters and time-based limits, and its default configuration reads files.
- **Handlebars.** It compiles to `Function`, has a code-execution advisory history, cannot bound its own compilation against a hostile template, and silently alters `\{{` and `{{#each}}` text.

**The most important residual risk, whatever the engine:** silent changes that remain well-formed Markdown. The product's checks are an engine-independent backstop for structure, required fragments, suggestion blocks and markers, and they refused every structural attack in D. They cannot know the static text or the optional values the template author intended: an example's `{{ message }}` interpolated, an Actions expression reduced to `$` by a lenient engine, an extension shown with the tool's version. The mitigations are an engine that fails loudly on unknown names and has no scope fallback, literal blocks, and a way to preview the rendered review, for example through `validate`, before publishing.

## 9. What remains for implementation

- **Configuration location.**
  - Templates belong to the repository's delivery configuration, `.github/sarif-to-comment.json`.
  - They are either inline strings keyed by component, or paths to template files under a fixed directory such as `.github/sarif-to-comment/templates/`, resolved by the configuration and never by the engine.
  - An unknown component key or an invalid template blocks, as an invalid configuration does, with a diagnostic that names the component and the template line. Under D55, an unusable template is not silently replaced by the built-in presentation.
- **Trust model**, consistent with D60's "reviewing a repository must not implicitly authorize its configuration to execute arbitrary code".
  - A repository template is data: it is parsed and rendered by an engine that has no file, network, module, helper, partial or clock access.
  - The repository cannot register helpers, filters or partials.
  - Only library callers' explicit callbacks, in their own application code, are code, and the callback API is not a channel for repository content.
  - The composed-text checks apply to template output exactly as to callback output.
  - The context is a deeply frozen, structured copy.
  - An owner decision remains open: whether honoring repository templates also needs an explicit caller opt-in, given that a template still controls what reviewers read.
- **Default-branch reads.**
  - Read the configuration and its template files from the default branch through Git objects, as the delivery configuration is read, never from the working tree or the pull request head, so a pull request cannot change its own presentation.
  - Record the default branch's commit and the resolved templates in the publication plan, so a retry with the same state path renders nothing again and is unaffected by later changes to the default branch.
- **Contract work, spec-first.**
  - A grammar and data contract for each customizable component, naming which fields are raw strings and which are Markdown fragments.
  - The literal-block syntax, and the size, depth and output bounds.
  - Diagnostics codes for template errors.
  - Tests derived from the contract, including this record's cases A–D.
- **Still not customizable.** The companion reference, the native batch guidance and the native batch note stay non-customizable, as today.

## Appendix: the in-house subset sketch

This is the sketch evaluated above. It is not product code, and it is reproduced here because `scratch/` is not kept. The design change recommended in §8 (no scope fallback) is **not** applied in it.

```js
// In-house Mustache subset (evaluation sketch, not product code).
//
// Purpose: the smallest declarative template language that can present the
// review components' data: variables, sections (incl. inverted) and comments.
// Deliberately absent: partials, lambdas, set-delimiter, HTML escaping,
// helpers/filters, triple-stash, any property access beyond the data's own
// enumerable keys.
//
// Grammar (delimiters fixed at `{{` `}}`):
//   {{ name }}          variable: raw string/number, never re-parsed, never escaped
//   {{# name }} … {{/ name }}   section: falsy/empty skips; array iterates; object pushes; true renders once
//   {{^ name }} … {{/ name }}   inverted section
//   {{! anything }}     comment
//   {{{{raw}}}} … {{{{/raw}}}}  literal block: contents emitted byte-for-byte
// A `{{ … }}` whose inside does not match the grammar (e.g. `{% x %}`, `{{}}`,
// `{{ a b }}`) is NOT a tag: it stays literal static text.
// name := `.` | ident ( `.` ident )*, ident := [A-Za-z_][A-Za-z0-9_]*, never
// `__proto__` / `constructor` / `prototype`.
// Strict: a variable whose root name is not an own key of some context frame
// is a render error (so a stray `${{ github.token }}` fails loudly instead of
// silently rendering `$`). Sections over absent names are falsy (optional fields).
// Standalone section/comment/raw lines (only whitespace around the tag) are
// removed with their line ending, as in the Mustache spec, for LF and CRLF.
// Bounds: template length, section depth and output length are capped.

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const NAME = new RegExp(`^(?:\\.|${IDENT}(?:\\.${IDENT})*)$`);
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const TAG = /\{\{\{\{(\/?)raw\}\}\}\}|\{\{(!)([\s\S]*?)\}\}|\{\{\s*([#^/]?)\s*([^{}\s]+)\s*\}\}/g;
const LIMITS = { template: 256 * 1024, depth: 16, output: 1024 * 1024 };

export class TemplateError extends Error {}

function lineOf(text, index) { return text.slice(0, index).split('\n').length; }

/** Parse into a tree of nodes: {t:'text',v} | {t:'var',name} | {t:'sec'|'inv',name,children}. */
export function parse(template) {
  if (typeof template !== 'string') throw new TemplateError('template must be a string');
  if (template.length > LIMITS.template) throw new TemplateError(`template exceeds ${LIMITS.template} characters`);
  const root = { children: [] };
  const stack = [root];
  let cursor = 0;
  const push = (node) => stack[stack.length - 1].children.push(node);
  const text = (from, to) => { if (to > from) push({ t: 'text', v: template.slice(from, to) }); };
  TAG.lastIndex = 0;
  for (let m; (m = TAG.exec(template)) !== null;) {
    const [whole, rawClose, bang, , sigil = '', name] = m;
    const isRaw = whole.startsWith('{{{{');
    if (!isRaw && !bang && !NAME.test(name)) continue; // not a tag: stays literal
    // Standalone line handling for non-variable tags.
    let start = m.index, end = m.index + whole.length;
    if (isRaw || bang || sigil) {
      const lineStart = template.lastIndexOf('\n', start - 1) + 1;
      const eol = template.indexOf('\n', end);
      const lineEnd = eol === -1 ? template.length : eol + 1;
      const after = template.slice(end, lineEnd);
      if (/^[ \t]*$/.test(template.slice(lineStart, start)) && /^[ \t]*(?:\r?\n)?$/.test(after)
          && (lineStart >= cursor)) { start = lineStart; end = lineEnd; }
    }
    if (isRaw) {
      if (rawClose) throw new TemplateError(`line ${lineOf(template, m.index)}: {{{{/raw}}}} without {{{{raw}}}}`);
      text(cursor, start);
      const close = template.indexOf('{{{{/raw}}}}', end); // contents are literal: no tag inside is seen
      if (close === -1) throw new TemplateError(`line ${lineOf(template, m.index)}: {{{{raw}}}} is never closed`);
      const closeLineStart = template.lastIndexOf('\n', close - 1) + 1;
      const closeEnd = close + '{{{{/raw}}}}'.length;
      const eol = template.indexOf('\n', closeEnd);
      const standalone = closeLineStart >= end && /^[ \t]*$/.test(template.slice(closeLineStart, close))
        && /^[ \t]*(?:\r?\n)?$/.test(template.slice(closeEnd, eol === -1 ? template.length : eol + 1));
      text(end, standalone ? closeLineStart : close);
      cursor = standalone ? (eol === -1 ? template.length : eol + 1) : closeEnd;
      TAG.lastIndex = cursor;
      continue;
    }
    text(cursor, start);
    cursor = end;
    if (bang) continue;
    if (name.split('.').some((part) => FORBIDDEN.has(part))) throw new TemplateError(`line ${lineOf(template, m.index)}: name "${name}" is not allowed`);
    if (sigil === '#' || sigil === '^') {
      if (stack.length > LIMITS.depth) throw new TemplateError(`line ${lineOf(template, m.index)}: sections nest deeper than ${LIMITS.depth}`);
      const node = { t: sigil === '#' ? 'sec' : 'inv', name, children: [], line: lineOf(template, m.index) };
      push(node); stack.push(node);
    } else if (sigil === '/') {
      const open = stack.pop();
      if (open === root || open.name !== name) throw new TemplateError(`line ${lineOf(template, m.index)}: {{/${name}}} does not close ${open === root ? 'any section' : `{{#${open.name}}}`}`);
    } else push({ t: 'var', name, line: lineOf(template, m.index) });
  }
  text(cursor, template.length);
  if (stack.length > 1) throw new TemplateError(`{{#${stack[stack.length - 1].name}}} is never closed`);
  return root.children;
}

const isRecord = (v) => typeof v === 'object' && v !== null && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Look a name up through the context stack, own enumerable data properties only. */
function lookup(frames, name) {
  if (name === '.') return { found: true, value: frames[frames.length - 1] };
  const [first, ...rest] = name.split('.');
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    if (!isRecord(frame) || !Object.prototype.propertyIsEnumerable.call(frame, first)) continue;
    let value = frame[first];
    for (const part of rest) {
      if (!isRecord(value) || !Object.prototype.propertyIsEnumerable.call(value, part)) return { found: false };
      value = value[part];
    }
    return { found: true, value };
  }
  return { found: false };
}

export function render(template, data) {
  const tree = typeof template === 'string' ? parse(template) : template;
  let out = '';
  const emit = (s) => { out += s; if (out.length > LIMITS.output) throw new TemplateError(`output exceeds ${LIMITS.output} characters`); };
  const walk = (nodes, frames) => {
    for (const node of nodes) {
      if (node.t === 'text') { emit(node.v); continue; }
      const { found, value } = lookup(frames, node.name);
      if (node.t === 'var') {
        if (!found) throw new TemplateError(`line ${node.line}: unknown name "${node.name}"`);
        if (typeof value === 'string') emit(value);
        else if (typeof value === 'number' && Number.isFinite(value)) emit(String(value));
        else throw new TemplateError(`line ${node.line}: "${node.name}" is not text (${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value})`);
        continue;
      }
      const empty = !found || value === undefined || value === null || value === false || value === ''
        || (Array.isArray(value) && value.length === 0);
      if (node.t === 'inv') { if (empty) walk(node.children, frames); continue; }
      if (empty) continue;
      if (typeof value === 'function') throw new TemplateError(`line ${node.line}: "${node.name}" is not data`);
      if (Array.isArray(value)) for (const item of value) walk(node.children, [...frames, item]);
      else walk(node.children, value === true ? frames : [...frames, value]);
    }
  };
  walk(tree, [data]);
  return out;
}
```
