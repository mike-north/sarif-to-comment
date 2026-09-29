# Second milestone: accepted engineering contract

> **Status note (reconciled September 28, 2026).** This contract was implemented and released in 0.2.0. Its "no implementation claimed" statement is historical. For current status, see [Current status and reconciliation](status.md).

Accepted by Astra after parent review on September 28, 2026. This defines the selected five-operation increment. Implementation algorithms remain the authors' responsibility. No second-milestone implementation or passing tests are claimed by this document. The historical filename retains the design proposal's provenance.

**Governing documents:** [goal](second-milestone-goal.md), [scope](second-milestone.md), [interface design](second-milestone-interface-design.md), [lead's contract notes](second-milestone-contract-notes.md), [decisions](design-decisions.md) (D1–D10, D19–D20, D23, D31–D32), and the [specification](specification.md) (R1–R9, O2–O3).

**Grounding:**
- The public 0.1.1 surface (`types/index.d.ts`, `bin/sarif-to-comment.cjs`).
- The publisher's current support profile (`src/prepare-review.cjs`, `src/index.cjs`).

Each rule below is tagged:
- **[F]** follows from an existing decision or the shipped contract;
- **[E]** is an engineering default chosen here;
- **[Q]** marks the original proposal's question; Q1 is resolved in §10. Corrections in this revision are lead-selected engineering resolutions, not new user product policy.

## 1. Shared principles

1. **Ordinary SARIF in, ordinary SARIF out.** Every operation consumes and produces plain SARIF 2.1.0 values or files. There is no authoring marker, builder, session or private format. Everything these helpers write is standard SARIF, plus the product's already-owned `properties.sarifToComment` namespace. **[F: D32, D23]**
2. **Capture before await.** Every operation that receives SARIF first takes a deep JSON copy using the publisher's existing capture rules: own data properties only, no getters, and refusal of cycles and non-JSON values. The copy is taken synchronously, before any await. A later change to the caller's object therefore cannot alter the operation. **[F: notes; E: reuse `src/index.cjs` capture]**
3. **Inputs are never mutated.** Library transformations return a new document.
   - **Library:** the returned document is a fresh JSON value that shares no objects with the input.
   - **CLI:** the CLI writes files and never edits the source being reviewed. **[F: interface design]**
4. **Structural validation before interpretation.** An input that fails the vendored SARIF 2.1.0 errata01 schema is refused as `invalid`, never interpreted best-effort. **[F: D15/R3; E: applied to authoring and inspection]**
5. **No invented reasoning.** No operation writes a critique, intention, severity or human attribution that the caller did not supply. **[F: R3, D19, D30]**
6. **The publisher is unchanged.**
   - `publishSarifReview`, its state files, its one-way delivery and its support profile stay as they are.
   - Its blocking of `proposedFileChanges`, multi-location results and fix alternatives remains.
   - Extraction may produce valid proposals the publisher blocks. That is a support limit, not an extraction error. **[F: goal, notes item 6]**

## 2. Source binding and coordinates

### 2.1 Run revision

A run's source revision is read exactly as the publisher reads it **[F]**:

| Run's `versionControlProvenance` | Meaning |
|---|---|
| Absent or empty | Unbound. Locations are interpreted at whatever reviewed revision the downstream operation is explicitly given. This is the ordinary upstream case. |
| Entries naming repository `R` with exactly one full 40-hex `revisionId` `C` | Bound to `C` in `R`. |
| Several distinct revisions for `R`, or an abbreviated revision | Conflicting. Extraction never associates it (§4.4), and the publisher blocks its locations and fixes. |
| Entries naming only other repositories | Foreign. Extraction never associates it, and the publisher blocks it. |

**Repository identity.** Generated bindings use `https://github.com/{owner}/{repo}`. Interpretation retains the publisher's existing case-insensitive GitHub identity rules, including its accepted http/https/ssh/git URI forms and `.git` suffix. Do not narrow accepted upstream provenance merely to the generated form. **[F]**

**Authoring binding.** `createSarifDocument` writes a binding only when the caller supplies both repository and commit. A bare revision cannot be written, because the schema requires `repositoryUri`. **[F: notes]**

**Binding never moves.** A later operation that is given a different revision never rebinds an existing bound run.
- Feedback bound to A stays about A.
- When published at B, the publisher treats it as historical general feedback. That is shipped behavior. **[F: D15]**

### 2.2 Which snapshot a location refers to

| File state at the reviewed revision R and in the staged index I | Coordinates of a finding on that path |
|---|---|
| Exists in R (unchanged, edited or deleted in I) | **R's content**, one-based inclusive lines. This holds even when I edits the file; lines are never interpreted in staged coordinates. |
| Absent in R, created in I | **I's proposed content.** D20: this is a real line of the proposed file, never a fabricated line in R. |
| Absent in both | Unresolvable. Extraction fails if such a result is eligible (§4.4). Otherwise the publisher reports it. |

- **Why this is unambiguous without an extra field:** a path cannot both exist and not exist in R, so the disambiguation needs no encoding. **[E: resolves O2/O3's reviewed-versus-proposed question within D20]**
- **Consequence for authors:** a comment on changed code in an existing file must use the reviewed file's line numbers. Inspection and the extraction receipt report the result of association so an agent can see when a comment did not attach (§4.5).

## 3. Operation contracts

Types are shown in TypeScript notation for the public declarations. All inputs refuse unknown keys. All paths are repository-relative, use `/`, and have no `.`, `..` or empty segment, no leading slash, no backslash and no NUL. A path is written as a SARIF `artifactLocation.uri` with RFC 3986 percent-encoding, which the publisher decodes. **[F: publisher URI rules; E: encoding]**

### 3.1 `createSarifDocument` / `init`

```ts
function createSarifDocument(options?: {
  tool?: { name: string; version?: string };        // default name "sarif-to-comment", version = package.json version
  source?: { owner: string; repo: string; commit: string }; // optional binding; all three together
}): SarifLog;                                        // throws TypeError on malformed options
```

The document it returns is exactly:

```json
{
  "$schema": "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
  "version": "2.1.0",
  "runs": [{
    "tool": { "driver": { "name": "<name>", "version": "<version if known>" } },
    "columnKind": "utf16CodeUnits",
    "versionControlProvenance": [{ "repositoryUri": "https://github.com/<owner>/<repo>", "revisionId": "<commit>" }],
    "results": []
  }]
}
```

- `versionControlProvenance` is present only when `source` is given.
- With no caller-supplied tool, the default name/version identify this package, reading its version at runtime. With a caller-supplied name, only a supplied version is written; do not attribute this package's version to another author.
- `columnKind` is fixed so that later column-bearing edits are unambiguous. **[E]**

Guidance to callers: pass a `tool.name` that identifies the actual author, such as "Claude review agent". The default attributes the feedback to this tool (D5).

**CLI:**

```text
sarif-to-comment init --output FILE [--tool-name NAME] [--tool-version V] [--repo OWNER/REPO --commit FULLSHA] [--format human|json]
```

- `--repo` and `--commit` must be given together or not at all. They carry the same meanings as for `publish`.
- The output file is created exclusively; an existing path is refused.
- Success receipt: `{ command: "init", status: "created", output: { path, written: true }, runIndex: 0, source?: { repositoryUri, commit } }`.

### 3.2 `addSarifComment` / `add-comment`

```ts
function addSarifComment(sarif: object, comment: {
  file: string;                  // repository-relative path
  line: number;                  // one-based
  endLine?: number;              // inclusive, >= line; omitted = single line
  message: string;               // non-empty, caller's full text
  messageFormat?: 'text' | 'markdown';  // default 'text'
  ruleId?: string;
  level?: 'none' | 'note' | 'warning' | 'error';  // omitted unless given
  run?: number | { toolName: string; toolVersion?: string; source?: { owner: string; repo: string; commit: string } };
}): AddSarifCommentOutcome;

type AddSarifCommentOutcome =
  | { status: 'added'; sarif: SarifLog; finding: { ref: string; runIndex: number; resultIndex: number; tool: string } }
  | { status: 'invalid'; problems: Problem[]; markdown: string };   // input SARIF not schema-valid
type Problem = { message: string; pointer?: string; path?: string }; // message is Markdown; no public codes (D13)
```

**The appended result.**
- The result is appended, in order, to the selected run: `{ ruleId?, level?, message, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine, endLine? } } }] }`.
- `message` becomes `{ text }` for text format, and `{ text: message, markdown: message }` for Markdown format, because the schema requires `text`.
- **[F: line/endLine names; E: field mapping]**

**Run selection** **[E, from D5 attribution]:**
- `run` omitted:
  - one run → that run;
  - no runs → `invalid`;
  - several runs → TypeError telling the caller to choose.
- `run: n` selects run n. Out of range is a TypeError.
- `run: { toolName, … }` appends a new run with that identity and optional binding, then adds the finding to it. Use this to add your own feedback to upstream SARIF without attributing it to the upstream tool.

**`ref`** is the JSON Pointer `/runs/i/results/j`. It is bound to this document and is not a persistent identifier; removal selectors are deferred.

> **Superseded:** removal selectors were later defined by [the finding removal contract](finding-removal-contract.md) §2. Inspection now gives each finding a `selector` bound to the document as inspected; `ref` keeps the meaning above.

**No source access.** Line validity is checked later, by extraction (§4) and by publication.

**CLI:**

```text
sarif-to-comment add-comment --sarif FILE --file PATH --line N [--end-line M] (--message TEXT | --message-file FILE|-) [--markdown] [--rule-id ID] [--level LEVEL] [--run N | --new-run-tool NAME [--new-run-tool-version V] [--repo O/R --commit SHA]] [--format human|json]
```

- The file is updated in place atomically: write a temporary sibling, then rename.
- **[E]** Cooperating CLI writers use exclusive per-artifact ownership through the write; concurrent/stale ownership causes an actionable refusal, never blind takeover. Re-read content before replacement and refuse an observed external change. A hash check is not a filesystem compare-and-swap: arbitrary non-cooperating edits after that check are outside the guarantee and must not be claimed safe. Do not alter source files or leave an unexplained lock after handled completion.
- Receipt: `{ command, status: "added", sarif: { path, written: true }, finding: { ref, path, line, endLine, tool } }`.

### 3.3 `inspectSarif` / `inspect`

```ts
function inspectSarif(sarif: object, options?: { previewLines?: number | null; previewChars?: number | null; sourceRootUri?: string }): InspectOutcome;
// defaults 20 lines / 2000 chars; null = unlimited
type InspectOutcome = { status: 'inspected'; view: SarifInspection } | { status: 'invalid'; problems: Problem[]; markdown: string };
```

The `SarifInspection` value is a JSON-compatible object. Inspection is complete except for fix previews. **[F: scope item 3, notes item 8]**

```ts
interface SarifInspection {
  format: 'sarif-to-comment.inspection'; version: 1;
  summary: { runs: number; findings: number; fixes: number; fileProposals: number; truncatedPreviews: number };
  runs: Array<{ index: number; ref: string; tool: { name: string; version?: string };
    source: { state: 'unbound' | 'declared'; provenance: object[] }; // full declared facts; no destination-relative foreign judgement
    columnKind?: string; approval?: string;
    otherContent: Record<string, unknown> }>;          // full additional evidence, not counts standing in for omitted content
  findings: Array<{
    ref: string; runIndex: number; resultIndex: number;
    selector: string;                                   // added later: see finding-removal-contract.md §2
    ruleId?: string; level?: string; kind?: string; baselineState?: string; approval?: string;
    message: { text?: string; markdown?: string; id?: string; resolved: boolean };  // full text, never shortened
    locations: LocationView[];                          // every location, in order; [] = general finding
    relatedLocations: LocationView[];
    otherContent: Record<string, unknown>;              // retain additional result evidence, including flows, metadata and suppressions
    fixes: Array<{ ref: string; description?: string;
      changes: Array<{ path: string | null; uri: string; replacements: Array<{
        deletedRegion: Record<string, unknown>;         // full raw region, including snippet and properties
        inserted: Preview }> }> }>;
    fileProposals: Array<{ ref: string; operation: string; path: string | null; fileMode?: string; content?: Preview }>;
  }>;
  diagnostics: Array<{ severity: 'warning'; message: string; pointer: string }>;
}
interface LocationView { path: string | null; artifactLocation?: object; uri?: string; uriBaseId?: string; startLine?: number; endLine?: number;
  startColumn?: number; endColumn?: number; charOffset?: number; charLength?: number; snippet?: string;
  message?: string; logical?: object[]; otherContent?: Record<string, unknown> }
interface Preview { state: 'complete' | 'truncated' | 'unavailable'; text?: string;
  totalLines?: number; totalChars?: number; shownLines?: number; shownChars?: number; byteLength?: number }
```

**How content is presented.**
- `message` resolves `message.id` using the publisher's resolver. An unresolvable id gives `resolved: false` plus a warning.
- `path` is a faithfully resolved repository-relative path under the existing URI/index/base rules, using optional `sourceRootUri` when supplied; unresolved paths remain `null` with their complete artifact reference and a warning. Index-only references are valid SARIF and must not be lost. Raw locations, regions, logical associations, extension content and other meaningful evidence not represented by named fields remain in `otherContent`; counts alone do not preserve that evidence.
- Inspection has no destination repository: it reports complete declared provenance facts and cannot label a source foreign. Extraction separately interprets provenance against its explicit repository.
- All included fixes and proposals are retained, including unknown operation fields. The preview mechanism is the only permitted shortening of fix content; unavailable binary preview is explicit and preserves its identity/size and operation structure.
- Binary inserted content gives `state: 'unavailable'` with `byteLength`.
- A preview never ends mid-line when a line limit applies. Truncation is signalled only by `state` and the counts; no `…` is inserted into the text.
- An unknown owned operation is shown verbatim with a warning.

**What inspection does not do.** It reads no source and contacts no host, so a deleted region's original text is not shown. It makes no readiness claim, and the input SARIF is untouched.

**CLI:**

```text
sarif-to-comment inspect --sarif FILE [--preview-lines N|all] [--preview-chars N|all] [--source-root FILE_URI] [--format human|json]
```

- JSON output is `{ command: "inspect", status, view | problems }`.
- Human output renders the same `view`, with no independent traversal: each finding shows its full text, run tool, locations (or "general"), and fixes grouped under it with previews and explicit "(truncated: X of Y lines shown)" markers.

### 3.4 `addStagedChangesToSarif` / `add-staged-changes`

```ts
function addStagedChangesToSarif(input: {
  sarif: object;
  worktree: string;              // absolute path inside the Git working tree whose index is read
  reviewedCommit: string;        // full 40-hex, must exist locally
  repository: { owner: string; repo: string };   // identity written into provenance (§4.6)
  sourceRootUri?: string;        // producer root for supported absolute/uriBaseId paths
}): Promise<AddStagedChangesOutcome>;

type AddStagedChangesOutcome =
  | { status: 'added'; sarif: SarifLog; receipt: StagedReceipt }
  | { status: 'invalid'; problems: Problem[]; markdown: string }       // input SARIF not schema-valid
  | { status: 'failed'; problems: Problem[]; markdown: string };        // strict extraction refused (§4)
// Rejects (Error) for operational failures: git not runnable, worktree not a repository,
// reviewedCommit absent locally, I/O. Rejects TypeError for malformed input.

interface StagedReceipt {
  reviewedCommit: string;
  changes: Array<{
    path: string; operation: 'edit' | 'create' | 'delete';
    replacements?: Array<{ startLine: number; endLine: number; associated: string[]; explainedBy: 'finding' | 'existing-fix' | 'neutral' }>;
    associated?: string[]; explainedBy?: 'finding' | 'existing-proposal' | 'neutral';   // whole-file operations
  }>;
  boundRuns: number[];            // runs that gained provenance (§4.6)
  addedRun: number | null;        // run holding neutral results, if any
  warnings: Problem[];            // e.g. partial overlaps (§4.5), proposals the current publisher blocks
}
```

The complete semantics are in §4.

**CLI:**

```text
sarif-to-comment add-staged-changes --sarif IN --output OUT --worktree DIR --repo OWNER/REPO --commit FULLSHA [--source-root FILE_URI] [--format human|json]
```

`OUT` must resolve to a different file from `IN`. Output preservation follows §6.

### 3.5 `publishSarifReview` / `publish`

- The library is unchanged.
- The CLI gains `publish` with exactly the legacy flags plus `--format`.
- Existing flag-only invocations without `--format` stay compatible in behavior, output, exit codes and credentials. Explicit `--format human|json` is also accepted on the legacy route; JSON is opt-in and must not alter publication/recovery semantics. **[F: interface design]**
- `publish --format json` emits `{ command: "publish", status, review?: { id, url }, statePath?, message }`. Here `message` is the library's Markdown, and the exit codes are the legacy ones. **[F: interface design]**

## 4. Staged extraction semantics

### 4.1 Snapshot

- Capture one coherent index snapshot including path, mode, blob identity, conflict stage and the information needed to distinguish intent-to-add from an intentionally staged empty file. `ls-files --stage` alone does not distinguish every required state. The exact read-only Git mechanism is the author's choice; separate mutable reads cannot silently produce a mixed snapshot.
- The reviewed tree is read by blob id from `reviewedCommit`.
- All content is read by immutable blob id. Working-tree files are never read.
- Only read-only plumbing is used: no hooks, filters, textconv, external diff, smudge/clean or end-of-line conversion. Comparison is of repository blob bytes, which are what GitHub stores and what the publisher reads.
- Caller environment variables that Git itself honors, such as `GIT_INDEX_FILE`, are honored.
- **[F: R2, notes; E: mechanism]**

**Strict failures.** Each of these gives `failed` with the listed paths and a repair instruction. None is partially applied:
- unmerged entries (stage > 0), because of conflicts;
- intent-to-add entries, because their content is not staged;
- sparse-directory entries;
- a non-UTF-8 path. **[E]**

### 4.2 Operation envelope

For every path whose `(mode, blob)` differs between R and I:

| R | I | Result |
|---|---|---|
| regular (100644/100755) | same mode, different blob | **edit**: text replacements (§4.3). Both blobs must be fatal-UTF-8 (a BOM is preserved) and within the 1,000,000-byte source limit. |
| absent | regular | **create**: whole-file proposal (§4.7). Content must be UTF-8 within the limit; `fileMode` is recorded. |
| regular | absent | **delete**: whole-file proposal (§4.7). Any content is allowed, since the reviewed blob identity is the source. |
| regular | regular, different mode | **fail**: a mode change cannot be represented. This applies even when content also changes; never drop the mode. |
| symlink/submodule on either side, or a type change | — | **fail**: unsupported. |
| regular, non-UTF-8 or binary, edit or create | — | **fail**: unsupported. There are no binary replacements. |

- **Renames** are never inferred. A moved file is a delete plus a create, exactly as the index expresses it. **[F: notes]**
- **Distinct operations stay distinct:** emptying a file is an edit, deletion is a delete, and creating an empty file is a create with `""`. **[F: D6/R9]**

Every failure names the path and what would make the rerun succeed. **[F: D8/R15]**

### 4.3 Replacements

Each maximal contiguous changed region of a deterministic line diff yields one exact SARIF replacement. Compare literal physical lines including terminators; do not add unchanged context to gather feedback. The author chooses the algorithm, documents its repeated-line tie behavior and verifies exact reconstruction. **[E]**

Regions must be valid under the actual destination run's column convention, and must denote the exact intended span. An explicit final endpoint may include the terminal newline on the final existing line; an invented line `n+1` after a terminal newline is not valid merely because the file ends with a separator. For example, replacing all of `a\n` can end at line 1, column 3; it cannot end at nonexistent line 2. Source BOM handling follows the existing replacement contract. Preserve BOMs, CRLF/LF, missing final newlines and Unicode exactly; a BOM transition that cannot be faithfully represented must fail explicitly, never disappear.

Do not stamp a missing `columnKind` onto upstream data and thereby reinterpret its existing regions. Use coordinates valid under its declared kind, or unit-independent coordinates when none is declared. If a new replacement cannot be unambiguously represented in a candidate existing run, keep its original finding separate and use the generated run's explicit convention, with a receipt warning. No native offset extension may silently become a prerequisite for ordinary upstream SARIF.

**Independent R2 oracle:** applying all extracted replacements to independently recorded reviewed bytes must reproduce independently recorded staged bytes exactly. The acceptance test's expected bytes and application oracle must not be computed using the implementation's own replacement-generation or placement functions. Separately check compatibility with `src/replacements.cjs` and the existing publisher for the supported native path.

**Association range:** for a nonempty changed source region, use precisely its affected reviewed lines, excluding an unchanged line named only by an exclusive end-at-column-1 endpoint. No surrounding diff context or host-only line borrowing enlarges this range. For a pure insertion, automatically associate no existing reviewed-line finding: native rendering may borrow an unchanged line, but that is not evidence the finding explains the insertion. Keep the finding separate and emit a neutral proposal unless an existing supplied fix already expresses the exact change. **[F: D4/R8; E: conservative insertion rule]**

Empty source and EOF insertion must have a faithful valid representation or a precise strict support diagnostic. Do not fabricate a line or cite native eligibility as proof that an invalid SARIF coordinate is valid.

### 4.4 Eligible findings

A result is **eligible** for association when all of the following hold:
- its run is unbound, or bound to `repository` at exactly `reviewedCommit`;
- it has exactly one physical location;
- that location's path is changed, created or deleted in I.

Findings in any other run are never touched, even when they name the same path. This means a historical run is never reassigned. **[F: notes discriminating case]**

**Validation.** Eligible located results are validated:
- its complete region must resolve faithfully under the run's column/newline convention against the snapshot §2.2 selects, including line/column/offset agreement and any snippet;
- invalid or ambiguous meaningful coordinates fail rather than being reduced to a convenient line number.

A failure is strict. For example, a finding on line 12 of a created five-line file gives `failed`. **[F: A25]**

### 4.5 Association (edits)

For each replacement X on path p, each eligible finding F on p is handled as follows:

1. **Contained, no fixes.** If F's lines lie within X's association range and F has no `fixes`, F receives a fix `{ artifactChanges: [{ artifactLocation: { uri: p }, replacements: [X] }] }` with no description. Several contained findings each receive an identical copy, which the publisher already coalesces into one suggestion that keeps every explanation and origin. **[F: D4/R8]**
2. **Contained, already fixed.** If F lies within X's range but already has fixes, F is never modified. **[F: notes, "preserve supplied alternatives"]**
3. **Partial overlap.** If F only partially overlaps X, F stays feedback-only, unchanged, and the receipt warns about the partial overlap. Neither the replacement nor the location grows. **[F: D4]**

**Existing fixes.** Existing text fixes in eligible runs are compared by effect: their replacement-module result on R, meaning lines and replacement text.
- **Equal** to X: X is **explained by the existing fix** and is not added again. This makes re-running extraction on its own output idempotent for already-represented changes.
- **Overlapping** X's lines with a different effect: `failed`, as a mechanical conflict. No winner is chosen. **[F: R4]**
- **Non-overlapping:** preserved untouched, as another supplied proposal. **[F: D1]**

**Unexplained changes.** A replacement contained by no finding and not equal to an existing fix is **unexplained**. It becomes a neutral result (§4.8). **[Q1: see §10]**

### 4.6 Binding written by extraction

- **Runs that received fixes or file proposals.** Bind every previously unbound run receiving a new text fix or whole-file operation to the explicit repository and reviewed commit. This records the revision the operation was verified against. Preserve all existing provenance entries, mappings and metadata: add the missing revision to matching unbound entries, or append the required canonical binding, without replacing unrelated context. A matching entry with no revision remains an unbound case; existing matching bound revisions are never changed. The receipt lists changed runs in `boundRuns`.
- **Other runs** are left exactly as they were. **[E, from notes, "source binding must be expressible"]**
- **Why `repository` is required:** it is needed to write a binding the publisher honors.

### 4.7 Whole-file operations

**Representation.** Whole-file operations use the D23 result-level extension, which the publisher recognizes and blocks. **[F: D23; E: exact fields]**

```json
"properties": { "sarifToComment": { "proposedFileChanges": [
  { "operation": "create", "artifactIndex": 3, "fileMode": "100644" }
] } }
```

**Artifacts.**
- The artifact at `artifactIndex`, in the same run's `artifacts`, holds `{ location: { uri }, contents: { text }, encoding: "utf-8" }`.
- For a delete, the artifact holds `{ location: { uri } }` only, and the operation is `{ "operation": "delete", "artifactIndex": k }`.
- Artifacts are appended; existing indices never shift.

**Association.** Each eligible finding located on the created or deleted path receives the operation, with or without a region. This happens only if the finding has no fixes and no `proposedFileChanges`; otherwise it is untouched, and an equal existing operation counts as explaining the change.
- A region on a created file is validated against I.
- A region on a deleted file is validated against R.
- The region never narrows a deletion's scope. **[F: D20/R9]**
- An operation that no finding carries becomes a neutral result (§4.8).

**Publisher consequence.** Inspection shows every proposal, and publication blocks the whole review with `file-operation-unsupported`. Nothing is dropped. The receipt warns about this. **[F]**

*Later:* publication now presents each creation and deletion in the review body, and the receipt no longer warns; see the [file-operation publication contract](file-operation-publication-contract.md).

### 4.8 Neutral results

Unexplained changes are appended as a new run for each invocation, and only when needed:
- tool `sarif-to-comment` at the package version;
- a rule `staged-change`;
- `columnKind`;
- a binding to `reviewedCommit`.

Each result has no `kind` or `level`. Its message is a factual template, never a claim of defect or intent:
- `"Staged change to lines S–E of \`p\`. No supplied finding was associated with this change."`
- `"Staged creation of \`p\`. No supplied finding was associated with this change."`
- `"Staged deletion of \`p\`. No supplied finding was associated with this change."`

It carries the replacement or operation. A nonempty changed source region can provide its exact source association; a pure insertion must not invent reviewed-line feedback to match a host anchor. Whole-file operations use the path without a region. The result has truthful machine attribution and no invented severity, rationale or approval hold.

### 4.9 No staged changes

If I equals R for every path, the outcome is `added` with the SARIF unchanged and `changes: []`. The CLI writes the normal output, per D10: success writes the output.

## 5. Error model

| Layer | Caller mistake | Content cannot be processed faithfully | Environment |
|---|---|---|---|
| Library | `TypeError`, thrown synchronously or as a rejection | `{ status: 'invalid' \| 'failed', problems, markdown }` | rejected `Error` with an actionable message |
| CLI exit | 1 (`usage-error`) | 2 (`invalid`/`failed`); `publish` keeps 0/1/2/3 | 1 (`error`) |

- No token or credential appears in any message; the publisher's redaction applies.
- `problems[].message` is Markdown. There are no public diagnostic codes (D13).

## 6. CLI conventions and output preservation (D10)

### 6.1 Command dispatch

- The first argument selects the command: `init`, `add-comment`, `inspect`, `add-staged-changes` or `publish`.
- A first argument beginning with `--` selects legacy publication; existing calls remain unchanged and explicit formatting is additive.
- Anything else is a usage error.
- `--help` at the top level or per command needs no token or network.

### 6.2 Output format

`--format human|json` is accepted by the five commands. The default is `human`, independent of whether output is a terminal.

**Format is resolved first**, before unrelated usage validation, including on the legacy route and for an unknown command:
- If it resolves to `json`, every handled outcome, including usage errors, is exactly one JSON document on stdout, with nothing on stderr.
- An invalid, missing or repeated `--format` value is a human usage error on stderr, exit 1, with nothing on stdout.

**Human mode:** outcomes go to stdout; usage and operational errors go to stderr.

**JSON envelope:** `{ "command": string | null, "status": string, ... }`.
- For usage errors, `status` is `"usage-error"` and the envelope includes `message` and `usage`.
- For operational errors, `status` is `"error"` and the envelope includes `message`.

### 6.3 Receipts

Receipts list only files actually written, archived, or deliberately not written (`written: false`).

### 6.4 Preservation for `add-staged-changes`

These rules are **[F: D10/R6; E: the concrete names below]**.

1. **Operation start.** The operation starts once arguments are valid, meaning `OUT` differs from `IN` (including existing symlink/hard-link aliases), `OUT`'s directory exists and exclusive cooperating-writer ownership is established. A usage error never moves or writes anything.
2. **Archive an existing output.** At start, if `OUT` exists, it is archived before any other work, so every later failure leaves no normal output:
   - archive name: `<YYYY-MM-DDTHH-mm-ss.SSSZ>.old.<basename(OUT)>` in the same directory;
   - the timestamp is the file's birth time in UTC, read before the move;
   - if the platform reports no birth time (zero or unavailable), the modification time is used, and the receipt says `timeSource: "modified"`;
   - on a name collision, `-2`, `-3`, … is appended to the stamp;
   - the archive is created with an exclusive hard link and the original is then unlinked, so it never overwrites.
3. **Success.** The new SARIF is written to a temporary sibling and exclusively linked to `OUT`. If `OUT` has reappeared through a concurrent writer, the attempt fails, `OUT` is left alone, and the result is reported.
4. **Failure.** Content refusal exits 2; usage/operational failure exits 1 under §5. Any handled outcome after operation start includes actual artifact effects. A content-refusal receipt reports:
   - `output: { path, written: false }`;
   - `archived: { path, from, timeSource } | null`;
   - `problems`.

   No error SARIF file is written, because strict mode has no best-effort artifact. D10's error filename applies to deferred best-effort output.

### 6.5 Other commands

- `init` refuses an existing output.
- `add-comment` edits its input atomically (§3.2).
- `inspect` writes nothing.
- `publish` keeps its state-file rules.

## 7. Worked cases

**W1: the happy path.** Reviewed revision R has `src/parse.js`:

```text
1 function parse(input) {
2   const parts = input.split(',');
3   return parts.map(Number);
4 }
```

1. `init --output a.sarif --repo acme/widgets --commit R --tool-name "Review agent"`.
2. `add-comment --sarif a.sarif --file src/parse.js --line 2 --message "Handle the empty-input case."`.
3. Staged: line 2 becomes `  const parts = input === '' ? [] : input.split(',');`. The working tree also changes line 3 to `UNSTAGED`.
4. `add-staged-changes --sarif a.sarif --output b.sarif --worktree . --repo acme/widgets --commit R`.

Results:
- The output's single result keeps its message and location, and gains one fix: `deletedRegion {2,1,3,1}`, with the inserted text being the new line 2 plus `\n`.
- `UNSTAGED` appears nowhere.
- The receipt shows `edit src/parse.js`, `2–2 associated [/runs/0/results/0] explainedBy finding`.
- `publish` renders one suggestion carrying the comment.

**W2: partial overlap is not absorbed.** The same comment is placed on lines 2–3, with the same staged change.
- The finding stays feedback-only.
- A neutral result carries the 2–2 replacement.
- The receipt warns that `/runs/0/results/0` partially overlaps staged lines 2–2 and was not associated.
- Publication shows the comment and a separate neutral suggestion.

**W3: shared replacement, adjacent feedback.** Findings A and B, from different runs and both unbound, lie on line 2. Finding C lies on line 3.
- A and B each receive the fix, and the publisher shows one suggestion with both explanations and origins.
- C is untouched.

**W4: binding.** Run 0 is bound to R, and run 1 is bound to an older commit Q. Both have findings on `src/parse.js` line 2.
- Only run 0's finding associates.
- Run 1 stays untouched and is published as historical general feedback.

**W5: new documentation page (D20).** I adds `docs/feature.md` with five lines, and a finding sits on its line 1.
- The finding gains `create` with a UTF-8 artifact, validated against I.
- A finding on line 12 would instead give `failed`, because the proposed file has five lines.
- Inspection shows the proposal and a content preview. Publication blocks with `file-operation-unsupported`.

**W6: file-operation distinctions.** Four staged variants give four different results:

| Staged change | Result |
|---|---|
| Create an empty file | `create` with `""` |
| Empty an existing file | an edit replacing all lines with `""` |
| Delete the file | `delete` |
| Chmod +x | `failed` (mode change) |

**W7: upstream input without initialization.** An ESLint SARIF file (one unbound run, results with fixes) is used without `init`.
- Results that already have fixes are never modified. An equal staged edit is `existing-fix`; a conflicting overlapping one is `failed`.
- A human note is added with `add-comment --new-run-tool "Reviewer"`, so ESLint is not credited with it.
- The same ready file publishes directly.

**W8: D10 preservation.** A first run writes `b.sarif`. A second run meets an unsupported mode change.
- `b.sarif` is moved to `2026-09-28T10-15-00.000Z.old.b.sarif`, no `b.sarif` exists, and the exit status is 2.
- The JSON receipt has `output.written:false` and names the archive.
- A usage error (for example, a missing `--commit`) moves nothing.

## 8. Observable acceptance tests (write first)

Each test asserts independently authored bytes and coordinates, never output derived from the implementation.

1. **init.** The exact document shape, with and without binding. The version equals `package.json`. The document passes the schema. An existing output is refused.
2. **add-comment, content.**
   - Single-line and range comments round-trip through inspection with full text.
   - The caller's object is unchanged, and the returned document is new.
   - Run selection covers: one run, several runs without `run` (TypeError), and `run: {toolName}` appending a run.
   - Text versus Markdown mapping.
   - Invalid input SARIF gives `invalid`.
3. **add-comment, file handling.** Atomic in-place write. A cooperating concurrent writer is refused; an external modification observed before replacement gives a failure without overwriting it. Do not claim arbitrary external-editor CAS safety.
4. **inspect.**
   - General, multi-location, related-location, logical, alternative-fix, multi-file-fix, binary and file-proposal inputs all appear.
   - Long previews are truncated with exact counts, and the source SARIF is byte-identical afterwards.
   - JSON output equals the library view, and human output renders the same view.
5. **Extraction, index versus working tree** (the notes' `a\nb\nc\n` case). The staged content is extracted, `UNSTAGED` is absent, and the caller's object is mutated during the await with no effect on the result.
6. **Extraction, the R2 oracle.** For each fixture, applying the extracted replacements to R reproduces I's bytes. Fixtures cover CRLF, a missing final newline added or removed, a BOM, non-ASCII, pure insertion, EOF append, middle-line deletion, 1→3 and 2→1 edits, emptying a file, and an empty R.
7. **Association.** W1–W4 and W7, including idempotent re-extraction of the tool's own output and a conflicting supplied fix.
8. **Envelope.** W5, W6, unmerged entries, intent-to-add, symlink, submodule, binary, over-limit and rename-as-delete-plus-create. Each gives the exact outcome and a repair message naming the path.
9. **D10.** W8 case by case: timestamp source, collision suffix, concurrent reappearance, and no file moved on usage error.
10. **CLI format.** For every command in both formats:
    - one JSON document per outcome, including usage errors;
    - an invalid `--format` gives a human error;
    - exit codes follow §5;
    - no secret appears in any stream.
11. **Compatibility.** The legacy flag-only publish tests pass unmodified. `publish --format human` matches the legacy output.
12. **End-to-end (local, then live via parent).** The W1 flow through the installed package and library; upstream SARIF (W7) through inspect and extract; direct publish. Live evidence is recorded separately from local tests.

## 9. What is new versus inherited

- **Inherited unchanged:** the publisher, state and recovery; placement; replacement semantics; the capture discipline; the schema validator; message resolution; URI rules; the `sarifToComment` namespace and its blocking of file operations.
- **Newly defined here [E]:**
  - run selection and new-run authoring;
  - the reviewed-versus-proposed coordinate rule;
  - the snapshot mechanism;
  - the region forms;
  - effect-equality for existing fixes;
  - binding on association;
  - the exact `proposedFileChanges` fields (`operation`, `artifactIndex`, `fileMode`);
  - the neutral-result template;
  - the inspection view schema;
  - the CLI envelope and exit codes;
  - archive naming.

Every new rule is testable per §8.

## 10. Resolved representation choice: unexplained changes

**Q1, resolved by the parent under delegated engineering discretion: adopt A without an additional user gate.** What happens to a staged change that no supplied finding explains?** The settled constraints forbid dropping it and forbid inventing reasoning (notes, "Neutral descriptions"). Three options:

| Option | Behavior | Consequence |
|---|---|---|
| **A. Neutral result (recommended, used in §4.8)** | A factual, tool-attributed result carries the change. | A representable unexplained change is retained without fabricating reasoning; other strict failures can still block the operation. The review shows a suggestion with factual text but no rationale, which the reviewer can see in `inspect` before publishing. |
| B. Strict failure | `failed`, listing unexplained changes. The agent must add a comment covering each change and rerun. | Guarantees every suggestion has a human or agent rationale. W2-style partial overlaps would block extraction. |
| C. Neutral result plus approval hold | As A, but the neutral run declares `approval: "awaiting-approval"`. | Publication blocks until the caller removes the hold or uses the existing override. This makes unexplained changes an explicit decision, at the cost of an extra step. |

A is adopted because it matches D6 ("presented faithfully; proofreading catches it") and happy-path-first. B and C need no other contract change: B swaps §4.8 for a failure, and C adds one run property.

No other product decision was found to be irreducible. The binding, coordinate, envelope and D10 details are engineering defaults consistent with existing decisions and can be revised without changing the public shapes above.

## 11. Recommended ownership split

1. **Authoring and shared interpretation:**
   - `createSarifDocument`, `addSarifComment`, `inspectSarif` and the shared capture, schema, message and URI helpers, extracted from the existing modules without changing behavior;
   - tests 1, 2, 4. No Git, GitHub or file I/O.
2. **Staged extraction:**
   - `addStagedChangesToSarif`: snapshot, envelope, region derivation, association, binding and neutral results;
   - Git fixtures and the independent R2 oracle; tests 5–8.
   - Consumes owner 1's helpers.
3. **CLI and public surface:**
   - command dispatch, format and envelope, file handling (atomic edit, D10 archive), legacy compatibility;
   - declarations, generated API docs, README and getting-started examples, and the Changeset; tests 3, 9–11.
   - Integrates the shared entry files.
4. **Publisher:** unchanged. Any integration need is raised to Astra with a regression test first.
5. **Independent reviewer** on the integrated source, plus live evidence (test 12) through the parent.

Owners 1 and 2 can proceed in parallel once §3 is accepted, since they share only the helper module's signatures. Owner 3 can build dispatch and D10 against stubs.

## 12. Reconciliation before implementation

Astra and the parent reviewed the proposal against the existing implementation and selected scope. This accepted revision corrects legacy JSON opt-in, destination-free inspection, complete inspection evidence, binding of file operations without provenance loss, truthful neutral text, conservative insertion association, valid EOF/newline coordinates, intent-to-add snapshot requirements, and bounded concurrent-file guarantees. These are observable contract corrections; implementation algorithms remain delegated. The original no-code design ticket completed before implementation assignments.
