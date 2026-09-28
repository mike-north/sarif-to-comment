# First milestone: live end-to-end evidence

On September 27, 2026 the implemented public library (`src/index.cjs`) and the actual CLI (`bin/sarif-to-comment.cjs`) were run against real GitHub. They used the real adapter (`src/github.cjs`) and global `fetch`, with no fake transport and no test seams. The target was an isolated synthetic fixture in the private repository `mike-north/doc-linter`.

Expectations were written by hand before any product run, and results were checked by a reader that shares no code with `src/`. The earlier manual probes ([placement](placement-host-probe.md), [native suggestion fidelity](native-suggestion-fidelity-experiment.md)) remain supporting host facts only. Selected sanitized evidence is retained in [docs/evidence/milestone-e2e](evidence/milestone-e2e/README.md); full raw evidence remains in `logs/opus/e2e/`. None of the original evidence contains the credential: a final scan of all 79 files there, plus this report, found none.

## Fixture

| Item | Value |
|---|---|
| Merge base / diff old side (B) | `5a5ca130467bb00993c4dc10701bc40f4167796e` (`sarif-e2e/base-20260927`) |
| Reviewed head (H) | `c96e4c386527de44b29b507907e2c97d2351d45e` |
| Base-branch advance (B2) | `83b2904bf897f2ba050162f5e5e27a8684873b96`, which changes base line 3 (the line the LEFT comment addresses) |
| Head advance (H2, PR 15 only) | `a20defde6f2b021f7de7c79ab62f6a3136cf2b96`, which prepends one line to `alpha.txt` |
| PR A, the CLI review | [mike-north/doc-linter#14](https://github.com/mike-north/doc-linter/pull/14), closed unmerged after rendering verification, original head H |
| PR B, library, recovery and advance scenarios | [mike-north/doc-linter#15](https://github.com/mike-north/doc-linter/pull/15), closed unmerged |
| `main` | unchanged at `0a7b03fe399255a62118311cbc3e1bd6fe64cb23`; nothing merged |

**Fixture files:** `sarif-e2e-fixture/alpha.txt`, `gamma.js`, `notes.md`. `alpha.txt` has two hunks: two inserted lines, one deleted line, and a changed last line, so head context is shifted by +1. `gamma.js` gains an added function. `notes.md` gains an added non-ASCII line.

**Inputs:** the SARIF is `logs/opus/e2e/fixture.sarif.json`. It has 2 runs and 10 results; the second run carries `versionControlProvenance` for revision B. The expectations are in `logs/opus/e2e/expected.json`. `verify.cjs` reads each expected literal text back from Git with `git show`, independently of the product, and every one matched.

**Expected placement:**

| Finding | Expected placement |
|---|---|
| E2E002 | RIGHT 1 `alpha one` (first line) |
| E2E003 | RIGHT 2 `inserted first` (addition) |
| E2E004 | RIGHT 5–7 (shifted context; base lines 4–6) |
| E2E005 | RIGHT 21 `alpha TWENTY` (second hunk, last line) |
| E2H001 | LEFT 3 `remove this line` (deleted base line; base provenance supplied explicitly through `oldSourceCommit` = B and verified) |
| E2E007 | RIGHT 8 suggestion `function farewell(person) {\n` (substring edit) |
| E2E008 | RIGHT 9–10 suggestion `  return 'Goodbye, ' + name;\n` (ordinary multiline suggestion) |
| E2E009 | RIGHT 4 `Schöne Grüße — ünïcödé ✓` (non-ASCII line) |
| E2E001 | general feedback in the body (no location) |
| E2E006 | general feedback in the body (outside every hunk), with its literal text and permalink [`alpha.txt#L12` at H](https://github.com/mike-north/doc-linter/blob/c96e4c386527de44b29b507907e2c97d2351d45e/sarif-e2e-fixture/alpha.txt#L12) |

## Demonstrated

Each row below was checked against the real host through independent readback (`host.cjs` and `verify.cjs`) and a request log. The request log (`wire-*.jsonl`) is written by a wrapper around the real `fetch`. It records method, URL, JSON body and status, and never headers.

**1. Exact placement and complete delivery.** Every publication below passed every check in `verify.cjs`:
- the review is authored by the viewer, PENDING, pinned to H, and ends with exactly one marker;
- there are 8 REST comments and 8 GraphQL threads, matched one-to-one;
- the multiset of original thread anchors equals the eight expected anchors;
- each comment carries its message, and exactly the two suggestion comments carry the exact expected suggestion fence;
- the general sections, the permalink and the literal text are in the body, with nothing duplicated.

The publications were library reviews 5333318805, 5333330277, 5333334104 and 5333351652, and CLI reviews 5333342940 and 5333352940.

**2. One pending create.** Each publication made exactly one `POST …/pulls/{n}/reviews`, with the body and all 8 comments and no `event`. The final request is `logs/opus/e2e/create-request-cli-final.json`. The library and CLI requests are identical apart from the per-publication marker.

**3. Explicit, verified old-side provenance.** With `oldSourceCommit` set, no compare request was made. The base blob of `alpha.txt` at B was fetched through commit → trees → blob. It was accepted only after the pull request's patch, reverse-applied to the head blob, reproduced it. No request ever read the advanced base tip B2.

**4. Repeat.** Re-running with the same state path returned the receipt with 0 requests, for both the library and the CLI (exit 0). Reusing a state path with different SARIF was refused locally with 0 requests (CLI exit 1).

**5. Recovery after a genuine lost response.** In library run 3, the create reached GitHub and GitHub answered it. The recorder then discarded that answer and threw a network error. The library found its own review through the persisted marker using read-only lookups and recorded the receipt `via: recovered`. There was 1 POST and exactly one review.

**6. Recovery across a process kill.** In library run 4, the process was SIGKILLed immediately after GitHub answered the create, leaving only the `sending` intent on disk. A fresh process using the same state path recovered with 0 POSTs.

**7. Branch advance without retargeting.** After the head was pushed from H to H2:
- re-running the completed publication made 0 requests;
- the review stayed on H, and the thread `originalLine`s stayed exact, while GitHub shifted the current lines (for example, `alpha.txt` 1→2 and 5–7→6–8).

A new publication pinned to H (so historical), made without `oldSourceCommit`, behaved as follows:
- It used the compare candidate `B...H2` and verified the base read against the new head H2's blob.
- With fixes present, it was blocked before any write, with 2 actionable `suggestion-historical-unsupported` diagnostics and no state file written.
- The feedback-only variant (`fixture-feedback-only.sarif.json`) published with 0 inline comments. Every finding was linked at its own source commit, including the base finding at B (`alpha.txt#L3`).

**8. One pending review per author.** A new publication while our draft was still pending returned `rejected` with GitHub's 422 ("User can only have one pending review per pull request"). It was sent once and never retried, and the Markdown tells the user to resolve the existing draft themselves.

**9. Invalid-anchor control.** Through the real adapter, one create was sent with a valid first comment and a final comment on line 999. It returned 422 "Line could not be resolved", with `hostRejected: true`. Readback then showed zero reviews. The only artifact is the record `logs/opus/e2e/control-invalid-anchor.json`.

Host facts observed during these runs:
- Pending REST review comments return `line`, `side` and `original_line` as `null`, with diff positions only.
- GraphQL `originalStartLine` is `null` for single-line threads, while the current `startLine` is synthesized. This is why the adapter uses original thread anchors.
- After the base-branch push, both PRs still reported `base.sha` / `baseRefOid` = B. So in this run, `base.sha` never differed from the merge base.

## Draft retained after publication

**Draft review [5333352940 on PR #14](https://github.com/mike-north/doc-linter/pull/14#pullrequestreview-5333352940):**
- author `mike-north` (id 558005);
- state PENDING;
- commit `c96e4c386527de44b29b507907e2c97d2351d45e`;
- marker `<!-- sarif-to-comment:review:d0dad03f-6464-4421-9216-9d303034be75 -->`;
- state file `logs/opus/e2e/state/pr14-cli-final.json` (completed, `via: created`).

It was published by the CLI and passed every check (`pr14-verify-04-cli-final.txt`). It was not submitted or applied. After the parent verified its rendering, it was deleted under exact author/state/marker checks and PR #14 was closed unmerged; see the supplemental application report.

**All other drafts were cleaned up.** Every other draft was deleted only after its author, PENDING state and single marker were checked. The deletion records are in `pr15-delete-*.json` and `pr14-delete-*.json`. The fixture branches are retained.

## Not yet demonstrated

- Browser rendering was subsequently verified by the parent against the final draft, including both general entries, the exact source link, all eight source associations and both native suggestion previews; see the retained evidence README.
- Native application was subsequently verified on a separate product-generated fixture, covering 1→3, 2→1 and middle-line deletion with exact final bytes; see [the application report](suggestion-application-e2e.md).
- A `base.sha` that differs from the merge base. GitHub did not move it here, so that case rests on the adapter's unit tests.
- Transport or 5xx uncertainty on the real host. The lost response and the process kill were simulated at the client after a genuine host answer.
- Any claim of server-side atomicity beyond the tested 422 refusals.

## Code identity

The hashes were recorded immediately before and after the final library and CLI runs (`code-hashes-before-final.txt`, `code-hashes-after-final.txt`), and the two files are identical.

Another worker changed `src/prepare-review.cjs` at 19:23:09, which was after the earlier scenario runs. Those runs' create requests are byte-identical, apart from the marker, to the final run's.

| File | SHA-256 |
|---|---|
| `src/github.cjs` | `f43b4e561637aefbaac05f02d17d11b9e8fabedb158aa15a44c3ca25fd73bfa7` |
| `src/index.cjs` | `0a21d7ee4869747d47a9a57228bafe6630e4507c8eb62fcf0795ca085daba293` |
| `src/placement.cjs` | `7f0df1a586972162c5496757c29adcf211d566884e2243fd6eb0ba87b44bbefc` |
| `src/prepare-review.cjs` | `9626bc1b2504d8933ea5395f9594a5a58a1f2e61c8b14f8a108abcad1ee91852` |
| `src/publication.cjs` | `71fff07a0cedc52408df3974fd387ff4668260ea4d4b8b35d3d3221c9615e7b8` |
| `src/replacements.cjs` | `71109a561fed6d2ae4b339cc71c12be74300b7638b007b300f2c915652fdd9dd` |
| `bin/sarif-to-comment.cjs` | `f437934733841b1ae6a28d385d810cca45ca1a194b5035c8202e544cd7245f27` |
| `package.json` | `cce72ebe9a9fc9587808e7d6df4eebf607ccb1104198eb4e3103f0fd637e210e` |

Local validation at that snapshot: `node --test test/*.test.cjs` passed 1278 of 1278, and `eslint .` was clean (`logs/opus/e2e/local-suite.txt`, `local-lint.txt`). No product code was changed for this demonstration.

**Operational note:** an invalid `GITHUB_TOKEN` in this environment overrides the valid keyring login for `gh`. Every command therefore ran with `GITHUB_TOKEN` unset and received `GH_TOKEN` from the keyring. No credential was changed.
