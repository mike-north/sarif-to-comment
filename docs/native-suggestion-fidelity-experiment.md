# Native suggestion application fidelity

On September 27, 2026, the supervising verifier tested nine manually authored native suggestions in [Experiment: verify native suggestion text fidelity](https://github.com/mike-north/doc-linter/pull/13). This establishes specific GitHub behavior. It is not an end-to-end test of the milestone implementation.

## Method and evidence

The isolated test PR compared synthetic base `53e81a076075f8f61f8b56ff537affb1d0e5c2d2` with head `fcae0d6a3d5f926a671840a434923edb7331142a`. Nine small existing-file changes were prepared, with expected final text recorded before application. A single create-review request created the body and all nine comments in a pending review. After checking its exact owner, marker, revision and pending state, the review was submitted as a comment so the suggestions could be applied in GitHub's browser UI.

All nine native suggestions were added to one batch and committed through that UI. The resulting commit was `14d7dbd8adbb8a2d745f0822ec377c665a3b665e`. Its exact Git blobs were fetched and compared with the independent expected strings, including line endings and terminal-newline presence. Browser rendering was inspected before application; actual resulting files are the fidelity oracle.

- [Original request](evidence/native-fidelity-probe/request.json)
- [Expected files](evidence/native-fidelity-probe/expected-files.json)
- [Exact applied files and comparison](evidence/native-fidelity-probe/applied-files.json)
- [Browser evidence after application](evidence/native-fidelity-probe/applied-browser.png)

## Results

| Case | Result | Observed behavior |
|---|---|---|
| Ordinary LF replacement | Exact match | Replaced only the intended line. |
| CRLF source, LF-only suggestion payload | Exact match | GitHub preserved source CRLF line endings. |
| CRLF source, CRLF suggestion payload | Mismatch | Produced `\r\r\n` on the inserted line. |
| Replace final line without terminal newline | Exact match | Preserved absent terminal newline. |
| Delete final line with terminal newline | Exact match | Preserved the preceding line's terminal newline. |
| Replace final content line with one blank line | Mismatch | Applied as zero replacement lines, losing the intended blank line. |
| Four-backtick suggestion containing triple-backtick code | Mismatch | Rendered four added lines as a native suggestion but applied as deletion of the target line. |
| Delete final line without terminal newline | Mismatch | Also removed the preceding line separator. |
| Two-line replacement | Exact match | Replaced exactly the selected two lines. |

Rendering successfully as a suggestion is insufficient evidence that GitHub will apply the intended replacement. The first milestone must reject unsupported meaningful fixes before any review write. In particular, this experiment does not justify emitting nested-fence suggestions, blank-only replacements, CRLF payloads, or final-line deletions whose resulting terminal-newline state differs from GitHub's observed behavior. Ordinary CRLF source is distinguishable from a CRLF payload; broader support still requires an exact application model and corresponding product tests.

## One pending review per author

A separate bounded probe on the same PR created one uniquely marked body-only pending review, then attempted another with a different marker. GitHub rejected the second request with HTTP 422 and reported that an author can have only one pending review per pull request. Readback showed exactly the first pending review plus the earlier submitted experiment review; no second draft was created.

The [first response](evidence/native-fidelity-probe/pending-first.json), [second response](evidence/native-fidelity-probe/pending-second-response.json), and [review list](evidence/native-fidelity-probe/pending-list.json) preserve that evidence. Test doubles must model this host constraint. A pre-existing human draft must not be deleted or submitted to make room for a new publication.

## Cleanup

The exact newly created pending review was fetched again and checked for owner, marker and pending state before deletion. [Final review readback](evidence/native-fidelity-probe/reviews-after-cleanup.json) retains only the submitted nine-comment experiment. The [PR is closed and unmerged](evidence/native-fidelity-probe/closed-state.json); its synthetic branches are retained. [Main remained unchanged](evidence/native-fidelity-probe/main-after.txt) at `0a7b03fe399255a62118311cbc3e1bd6fe64cb23`. The temporary browser tab was closed.
