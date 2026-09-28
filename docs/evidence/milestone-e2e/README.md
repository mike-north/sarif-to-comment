# Retained live milestone evidence

Selected sanitized artifacts from the real library/CLI experiment. The independently authored SARIF and expected locations precede the product run. Readback is from independent REST/GraphQL calls, not the product adapter. Full exploratory transport logs remain local in `logs/opus/e2e/`.

See [the experiment report](../../milestone-e2e-evidence.md) for the fixture, source hashes, interpretation and limits. The readback preserves original host anchors, while the expected file/source text was checked independently against Git. Recovery records distinguish a simulated lost response and process crash from an actual GitHub outage.

## Browser verification

The parent inspected the CLI-created draft on September 27, 2026 in signed-in Chrome, then refreshed the page after the final source-pinned rerun and verified review 5333352940 (not cached earlier review 5333342940). The conversation card visibly contained both general feedback entries, the exact H-revision link to alpha.txt line 12 and literal `alpha eleven`, all eight pending inline comments, the deleted LEFT line, the shifted context range, non-ASCII text, and both native suggestion previews. The two-line suggestion visibly replaces lines 9–10 with one line; the other preserves the surrounding function declaration. No suggestion was applied in this rendering check.

GitHub's new Files changed submission modal showed an empty text editor; the actual pending review body was present and readable on the conversation card at the returned review URL. No submission or modification was attempted through that modal.
