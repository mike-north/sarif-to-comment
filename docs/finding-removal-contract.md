# Finding removal and correction: contract

Accepted by the owner · September 29, 2026 ([D34](design-decisions.md#d34-remove-findings-by-document-bound-selectors--owner-accepted), [issue #24](https://github.com/mike-north/sarif-to-comment/issues/24)), as merged in [PR #14](https://github.com/mike-north/sarif-to-comment/pull/14). First proposed September 28, 2026. The owner accepted the document-bound selector of §2 and its consequence: any change to the SARIF document requires a fresh inspection before the next removal.

**Sources.** [Interface design: inspection requirements and deferred removal design](second-milestone-interface-design.md#inspection-requirements-and-deferred-removal-design), its selected vocabulary, conventions and acceptance examples 2, 3, 5 and 8; [D30–D32](design-decisions.md); [the milestone's deferral](second-milestone.md#deferred); the [engineering contract](second-milestone-contract-proposal.md) §1 and §3.2–§3.3 for shared conventions.

## 1. What is fixed by the sources

- Vocabulary: CLI `remove-comment`, library `removeSarifComment`. Help sentence, verbatim: “Remove a finding and its attached fixes from the SARIF document.”
- A finding (one SARIF result) is the unit of removal. Removing it removes that complete result, including every fix and file proposal it carries. Every other finding and fix stays exactly as it was, including fixes elsewhere that are identical to a removed one. Orphaned fixes are never relocated.
- The selector comes from inspection, never from a guessed message, location or array index. Identical findings in different runs have different selectors. A stale or ambiguous selector is refused; it never deletes whatever now occupies an old position.
- Library: an ordinary-value operation that returns a new document and never changes its input. CLI: edits the named file in place, atomically, like `add-comment`, with human and JSON output and meaningful exit statuses.
- Only the local artifact changes. No GitHub review or publication state is read or edited (D29 stays intact).
- Correction is removal followed by the existing `add-comment` / `addSarifComment`. Enriched output is regenerated separately from the corrected authored input with `add-staged-changes`; removal never regenerates it.

## 2. Selector decision

The sources leave open whether selectors are persistent IDs or document-bound handles, and their spelling.

| Option | Refuses a stale position? | Problem |
| --- | --- | --- |
| A. Bare JSON Pointer (`/runs/0/results/1`), as `ref` already is | No | After any edit it silently names a different finding. Exactly what the sources forbid. |
| B. Pointer plus a fingerprint of that finding's content | Mostly | Identical findings defeat it: after removing one of two identical neighbours, the old selector matches the survivor that moved into its position and deletes it too. |
| C. Pointer plus a digest of the whole document (**recommended, adopted**) | Yes | Any change to the document makes every earlier selector stale, so each removal needs a fresh inspection. |
| D. Persistent IDs written into SARIF (`guid`) | Yes | Changes documents to make them removable, and upstream SARIF has no such IDs; D32 forbids helper-only markers as prerequisites. |

**Accepted: C** (recommended by this contract, accepted by the owner on September 29, 2026). It is the only option that is unambiguous for identical findings without writing anything into the document, and its cost (re-inspect after each change) is the safe default for a destructive edit. Batch removal and persistent IDs can be added later without breaking C.

**Form.** A selector is `<ref>@<digest>`, for example `/runs/1/results/0@3f9c0a1b2c3d4e5f`. `<digest>` is 16 lowercase hexadecimal characters derived from the whole parsed document with object keys in sorted order, so formatting and key order do not matter but any change of value does. Callers treat the selector as opaque and copy it from inspection. Its derivation is not a public contract.

**Where it appears.** Every inspection finding gains `selector`, immediately after `ref`, in the library view and in `inspect --format json`. Human inspection prints `Selector: …` under each finding heading. This is an additive field; the view keeps `version: 1`. `ref` keeps its meaning as a position in this document.

## 3. Library: `removeSarifComment(sarif, selector)`

```ts
function removeSarifComment(sarif: object, selector: string): RemoveSarifCommentOutcome;

type RemoveSarifCommentOutcome =
  | { status: 'removed'; sarif: SarifLog; finding: { ref: string; runIndex: number; resultIndex: number; tool: string; fixes: number; fileProposals: number } }
  | { status: 'stale'; selector: string; problems: Problem[]; markdown: string }
  | { status: 'invalid'; problems: Problem[]; markdown: string };
```

In order:

1. The input is captured as for every other operation. A non-object document, a selector that is not a string, or a string that is not of the selector form (a bare `ref` included) is a `TypeError` whose message says to use the `selector` from inspection.
2. A document that is not schema-valid SARIF is `invalid`.
3. A selector whose digest differs from the document's is `stale`: the document changed after it was inspected. A selector whose digest matches but whose position holds no finding is also `stale`: it did not come from this document's inspection. The problem's `pointer` is the selector's `ref`; the message says to inspect again.
4. Otherwise the result at `/runs/i/results/j` is removed from a fresh copy. Nothing else changes: other results and their fixes, `run.artifacts` (even entries only the removed finding referred to), run and log properties. A run left without findings keeps `results: []`. Later findings in the same run move up one position.
5. `finding` reports what was removed: its former `ref`, `runIndex`, `resultIndex`, the run's tool name, and how many fixes and file proposals went with it.

## 4. CLI: `remove-comment`

```text
sarif-to-comment remove-comment --sarif FILE --finding SELECTOR [--format human|json]
```

- Edits FILE in place with the same ownership marker, re-read check and atomic rename as `add-comment`, following a symbolic link to the real file.
- Receipt: `{ command: "remove-comment", status: "removed", sarif: { path, written: true }, finding }`, where `finding` is the library's. Human: `Removed <ref> (tool "<tool>") and its N attached fix(es) from <FILE>.`, plus file proposals when there were any, and a reminder to inspect again for new selectors.
- `stale` and `invalid`: exit 2, `{ command, status, sarif: { path, written: false }, problems }`; human output is the Markdown and `<FILE> was not changed.`
- A malformed `--finding`: usage error, exit 1. Unreadable, locked or concurrently changed file: operational error, exit 1, file unchanged.

## 5. Worked examples

**Identical findings in different runs (acceptance example 2).** Run 0 and run 1 each hold one finding with message “Handle the empty-input case.” on `src/parse.js` line 2. Inspection shows `/runs/0/results/0@d` and `/runs/1/results/0@d` (same digest `d`, different positions). Removing `/runs/1/results/0@d` leaves run 0's finding exactly as it was and leaves run 1 with `results: []`.

**Stale selection (example 5).** Inspection shows A at `/runs/0/results/0@d` and B at `/runs/0/results/1@d`. After A is removed, B is at `/runs/0/results/0`. Using `/runs/0/results/0@d` again is `stale`, so B is not deleted; so is `/runs/0/results/1@d`. Adding a comment after inspection likewise makes `@d` selectors stale.

**Correction (example 3).** Inspect `review.sarif`, remove the mistaken finding by its selector, add the corrected comment, inspect again, then run `add-staged-changes --sarif review.sarif --output review.staged.sarif …`. The previous `review.staged.sarif` is archived as usual (D10) and the new one reflects the correction. A finding elsewhere whose fix is identical to the removed finding's fix keeps it.

**After publication.** Removal never changes a published review. The state path of an earlier publication belongs to the earlier input; publishing the corrected artifact under a new state path creates a separate draft review.

## 6. Out of scope

Removing several findings in one call, persistent IDs, selectors in `add-comment` receipts, removing runs or results embedded in external properties, and automatic regeneration of enriched artifacts.
