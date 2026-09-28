# Manual GitHub placement probe

This probe tests host behavior independently of the product implementation. It does not satisfy the milestone's later end-to-end release test. It uses an isolated synthetic base/head pair in the already authorized `mike-north/doc-linter` repository; no default-branch changes or unrelated review writes are intended.

## Expected source before requests

The base text has six lines: `alpha`, `keep-before`, `remove-me`, `keep-middle`, `keep-after`, `final`. The head inserts two lines after `alpha` and deletes `remove-me`, leaving seven lines. Base line 4 (`keep-middle`) is head line 5; base line 3 is a deletion and head line 2 is an addition.

1. Probe a pending review anchored to unchanged base context at LEFT line 4. Record whether the create endpoint accepts it and how the host reports the resulting anchor. Official review-comment documentation recommends RIGHT for context; any accepted LEFT behavior is additional observed behavior, not assumed portable support.
2. Create one pending review containing RIGHT line 5 context, LEFT line 3 deletion, RIGHT line 2 addition, and RIGHT lines 4–6 multiline context. Read back the exact body, cardinality and source anchors.
3. Attempt a separate uniquely marked batch with a valid first comment and an invalid final line 999. Verify the response and whether any review/comments from that rejected batch remain. This cannot prove general failure atomicity.

Delete only the probe's exact pending reviews after checking ownership/state, and close the owned synthetic PR without merging. Record any leftover artifacts and retain evidence.

## Results

Executed against [Experiment: verify exact SARIF review placement](https://github.com/mike-north/doc-linter/pull/12). Exact source/request/response evidence is in [evidence/placement-host-probe](evidence/placement-host-probe/intent.json).

- GitHub accepted LEFT line 4 for unchanged context. Its GraphQL thread reported LEFT line 4 and the expected comment; REST review-comment readback exposed only legacy diff position 6. This is observed extra host behavior. The implementation can still prefer the documented RIGHT mapping for context.
- The complete valid batch created one PENDING review containing all four comments. GraphQL thread anchors were exactly RIGHT 5, LEFT 3, RIGHT 2, and RIGHT 4–6. The reviewed commit was the pinned synthetic head. REST readback retained the corresponding comment bodies and positions.
- The invalid-final-anchor batch returned HTTP 422, with no reviews or review threads remaining. This verifies the tested validation failure left no partial earlier comment; it does not prove all server/network failure modes atomic.
- Both successful pending reviews were verified as owned and PENDING before deletion. The synthetic PR was closed without merging. Test branches remain for reproducibility; main was not modified by this experiment.
- The in-app browser was signed out and could not display this private repository. No rendered-placement verification is claimed for this manual probe. The milestone's implemented end-to-end test still requires its own API and rendered evidence.

The native connector returns normalized thread fields (`line`, `diff_side`, `start_line`, `start_diff_side`, `original_line`, `original_start_line`). It reported a synthesized-looking `start_line` even on single-line comments with null `start_diff_side`; use actual GraphQL semantics rather than assuming that connector field alone establishes a multiline range. The raw normalized outputs are retained.
