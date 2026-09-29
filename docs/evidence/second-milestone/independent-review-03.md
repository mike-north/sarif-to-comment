# Second-milestone review 03: final delta, snapshot 02 → 03

This is a read-only, bounded delta review of `<working-logs>/m2/review-snapshot-03`.
- **Manifest:** `<working-logs>/m2/review-snapshot-03.sha256`, file SHA-256 `823bef633b25c49908aebb6b774aba6462bef9759a2131e0c41dc7223dfc60d7`, 325 entries.
- **Integrity:** `shasum -c` reported every entry OK, before and after. The snapshot's `git status --porcelain` was unchanged.
- **Probe:** `<working-logs>/m2/review-03-probes/ast-compare.cjs`, with output in `ast-compare.out`.

I made no edits, commits or remote actions, and did not repeat the broad review.

## Verdict

**The review-02 verdict still holds for this exact source: no material defect.** There is no actionable issue.
- The delta contains no algorithm, schema or field-shape change.
- Review 02's evidence (C1–C5, the grouped fixes, randomized byte checks and the repair reversions) applies unchanged, because every changed source file is either syntactically identical to snapshot 02 or differs only in one warning string.

## Delta verified

`diff -rq` of snapshots 02 and 03 lists exactly the 10 files in `review-snapshot-03-delta.txt`.

| File | SHA-256 (snapshot 03) | Nature of change (verified) |
|---|---|---|
| `src/staged-changes.cjs` | `e5d03ddc55c4ba0734f53654ea06b1b485db1ac360e9602cc280a7d39aceb84e` | Comment-only: syntax tree identical to snapshot 02 |
| `src/sarif-common.cjs` | `4946e26461a077462200477a0984fa8dc132440cc43e9ac52c42a07993076232` | Comment-only: syntax tree identical |
| `src/sarif-inspection.cjs` | `bd08dd875742c9d09cc20dfe563a969d6cf0e3047b41cfa818bd2e39f87d8787` | Comments, plus the text of one warning string; structure with strings blanked is identical |
| `test/staged-changes.test.cjs` | `b7f662144480a0064b56f999c159e56f319ff8e8941b56705ac265344e0305ec` | Comment-only: syntax tree identical |
| `test/staged-changes-integration.test.cjs` | `c04d07ee7b6c7a6e4efcad7a0131d2ad40915d0d1432d3c55b23d4bd49b4f7b7` | Comment-only: syntax tree identical |
| `test/sarif-inspection.test.cjs` | `c340d19f014e247356425b5e493857be096af399a11936156061d6ff0abd2b1f` | One new test; "(review C4)" removed from three suite titles; one progress comment removed |
| `types/index.d.ts` | `eb525c5b3304a3856e3cc2a8afe30fd9e7b2957f9dae8918f6d396b7f45c3608` | Doc comment of `IInspectionExternalProperties` only |
| `docs/api/sarif-to-comment.iinspectionexternalproperties.md` | `36a5c23115a32ed3ad891fc7cabb137bd9ae79454389a29b5b6125540d842dd6` | Regenerated; `check:api` passes: "API report and 225 reference pages are up to date" |
| `README.md` | `c59154d327bb40e67f9d6d6779654c859fd1b5732ef1d09cbe5644f6dc5bee28` | Empty and BOM-only reviewed-file limitation |
| `docs/getting-started.md` | `bc5e434be0f4ece58c5521526c8f3e4866e9cf2f89eaed6b80e34ae3a4ee0372` | The same limitation |

**Method.** The syntax-tree comparison parses both versions with ESLint's `espree` and strips comments and positions. It is how the "comment-only" and "only string text changed" classifications were established, not inferred from reading the diff.

## Claims checked

**`runGuid` overclaim: correctly fixed.**
- The vendored schema defines `externalProperties.runGuid` as "A stable, unique identifier for the run associated with this external properties object". The old text ("belong to no run", "no run association") was therefore an overclaim.
- The warning, module comments and declaration now say the entry is kept verbatim, that any declared `runGuid` stays in that content, and that inspection does not merge external properties into run findings. That matches the unchanged behavior; no resolver was added.
- `rg` finds no remaining "no run association" / "belong to no run" wording in `src`, `types`, `docs/api`, `README.md` or the guide. The only hit is the new test's negative assertion.

**New regression: meaningful.**
- It sets a schema-valid matching `runGuid` on both the run and the inline external properties.
- It asserts the `runGuid` is retained verbatim, that the message avoids the overclaim and says "does not merge", and that the human rendering contains the GUID.
- `<working-logs>/m2/inspection-run-guid-red.txt` shows it failing against the old message. `node --test test/sarif-inspection.test.cjs` in the snapshot gives 59 tests, 59 passing, 0 failing.

**README and guide clarification: accurate.** "Staged edits to UTF-8 text files become fixes", and publication blocks empty or BOM-only reviewed files for inline suggestions. That matches review 02's observation: extraction is faithful, and the unchanged publisher refuses with a precise diagnostic.
- **Nonactionable wording nuance:** "no source line" is slightly loose for a BOM-only file. The publisher treats the BOM as line 1 and refuses with `suggestion-final-newline-unverified`. The stated outcome, blocked, is correct.

## Scope limits

- Only the snapshot 02 → 03 delta was examined in this turn.
- I did not rerun the full suite. Your final full check covers that.
- Installed-package and real-GitHub acceptance remain your evidence gate, as before.
