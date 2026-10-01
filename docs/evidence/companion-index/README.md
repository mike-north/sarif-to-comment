# The review's companion index: live verification

Run on October 1, 2026 in `mike-north/doc-linter`, against the implementation of the companion index and existing companions ([companion contract §2.13](../../companion-suggestion-pr-contract.md#213-the-companion-index-and-existing-companions), D56). The built package ran from the working tree at commit `f4a30a7` (`node dist/sarif-to-comment.cjs`, `--format json`), before that branch was rebased onto `main` at `85be397`. The maintainer's personal token was given inline for each command. One account (`mike-north`, the repository owner) made every request. Nothing was published to npm, nothing was merged or closed, and `main` stayed at `0a7b03f` ([`10`](10-refs-after.txt)).

The verification was bounded: one fixture pull request; one publication that creates one suggestion pull request, submitted as a comment review so that the account's one pending review stays free (GH-06); and one later, pending review that reuses that suggestion pull request and creates none.

Under the [evidence policy](../../evidence-policy.md), this record is historical. It is not updated to follow later changes to the fixtures.

## Why a fresh fixture

The plan was to publish a pending review on the earlier fixture #96, reusing its suggestion pull request #97. A read of #96's reviews before any write found this account's pending review 5375523422 there, from the [companion fidelity run](../companion-fidelity/README.md). GitHub allows one pending review per account on a pull request (GH-06), and this work does not touch earlier reviews, so a fresh fixture was used. #97 still served as the negative case: its marker names #96 as its original, so it cannot be listed in a review of the fresh fixture (run 0).

## What was written to GitHub

| Action | Objects |
| --- | --- |
| Pushed a fixture branch from `main` | `exp-companion-index-20261001` at `a7662e3`: adds `docs/experiments/companion-index/sample.md` (12 lines `Line N.`) |
| Opened a draft pull request into `main` | [#100](https://github.com/mike-north/doc-linter/pull/100) |
| `publish` of the first review, `--edits companion --submit` | the draft suggestion pull request [#101](https://github.com/mike-north/doc-linter/pull/101) from `suggestion-pr/100/07ce6f99-7c28-4b22-8583-c5161c7b1568` (commit `b03e88a`, parent `a7662e3`), labeled `suggestion-pr`; the submitted comment review 5376657276 on #100 |
| `publish` of the second review, `--existing-companion 101` | the pending review 5376687723 on #100, with one inline comment; no suggestion pull request |

All of them were left in place. The validation runs and the retry wrote nothing.

## The documents

- [`first.sarif.json`](first.sarif.json): one finding at `a7662e3`, whose fix replaces line 5 of the sample with `Line 5, suggested.`. It was delivered with `--edits companion`, a strict list.
- [`second.sarif.json`](second.sarif.json): a later review of the same commit, one finding on line 9 without a fix, published inline. It proposes nothing itself and lists #101 as an existing companion.

## Runs

0. **An existing pull request whose marker names another original is refused before any write** ([`00`](00-validate-other-original.json), exit status 2). `validate --existing-companion 97` on #100 answered `blocked` with one `companion-not-reusable` error: ``#97 cannot be listed as an existing companion of #100: its suggestion marker names #96, not #100.`` #97 carries the version 1 marker the companion fidelity run created, and the tool read it from GitHub's answer.
1. **The first review is ready** ([`01`](01-validate-first.json), exit status 0): ``Publication would also create 1 draft suggestion pull request into `exp-companion-index-20261001`, labeled `suggestion-pr`.``, as a submitted comment review.
2. **The first review is published** ([`02`](02-publish-first.json), exit status 0). It created #101 and the submitted review 5376657276. The plan ([`state/first.json`](state/first.json)) records the index as the review's first section, `{ "companionIndex": { "existing": [] } }`. The review body as GitHub stores it ([`08`](08-reviews-after.json)) begins:

   ```markdown
   **Companion pull requests of this review:**

   - [#101](https://github.com/mike-north/doc-linter/pull/101): Suggestion for \#100: edit docs/experiments/companion-index/sample.md — created with this review

   ---

   **Suggestion pull request:** [#101](https://github.com/mike-north/doc-linter/pull/101)
   ```

3. **#101 as GitHub shows it** ([`03`](03-companion-pr-view.json)): an open draft from its suggestion branch into `exp-companion-index-20261001`, labeled `suggestion-pr`, ending with a version 1 marker whose `original` is `mike-north/doc-linter#100`.
4. **No pending review of this account on #100** before the second review ([`04`](04-reviews-before-second.json)): only the submitted review 5376657276, state `COMMENTED`.
5. **The second review is ready** ([`05`](05-validate-second.json), exit status 0), with one `companion-reused` note: ``#101 is listed in the review's companion index as an existing companion; it was a draft when the review was prepared.``
6. **The second review is published, pending, creating nothing** ([`06`](06-publish-second.json), exit status 0): the draft review 5376687723, with the same note. Its body as GitHub stores it ([`08`](08-reviews-after.json)) is the index alone, then the publication marker; its finding is an inline comment:

   ```markdown
   **Companion pull requests of this review:**

   - [#101](https://github.com/mike-north/doc-linter/pull/101): Suggestion for \#100: edit docs/experiments/companion-index/sample.md — reused; it was a draft when this review was prepared
   ```

7. **A retry is answered from the receipt** ([`07`](07-retry-second.json), exit status 0): ``… was already published; its completion is recorded at `<evidence>/state/second.json`. Nothing was sent.`` It reported the same `companion-reused` note, recorded with the publication, and read nothing from GitHub.

Each review body GitHub stores is byte for byte the body recorded in its state file before it was sent (`request.body` of [`state/first.json.review`](state/first.json.review) and [`state/second.json`](state/second.json), compared with [`08`](08-reviews-after.json)). That recorded request is what recovery after a lost response matches; a lost response was not provoked live.

The standard error of runs 0, 1, 2, 5 and 6 held only a warning from the shell's own environment, that Node ignores `NO_COLOR` when `FORCE_COLOR` is set; that of run 7 is empty. The tool wrote nothing to it.

## Afterwards

- #100 ([`09`](09-original-pr-view.json)): an open draft into `main`, head `a7662e3`.
- #101 ([`09`](09-companion-pr-after.json)): an open draft, unchanged by the second review.
- The branches ([`10`](10-refs-after.txt)): `main` at `0a7b03f`, the fixture branch at `a7662e3`, the suggestion branch at `b03e88a`.

## Files

| File | Source |
| --- | --- |
| `first.sarif.json`, `second.sarif.json` | The SARIF documents of the two reviews. |
| `00-validate-other-original.json`, `-stderr.txt`, `00-exit.txt` | `validate --sarif second.sarif.json … --existing-companion 97 --format json`: standard output, standard error, exit status. |
| `01-validate-first.json`, `-stderr.txt`, `01-exit.txt` | `validate --sarif first.sarif.json … --edits companion --submit --format json`. |
| `02-publish-first.json`, `-stderr.txt`, `02-exit.txt` | `publish --sarif first.sarif.json … --edits companion --submit --state <evidence>/state/first.json --format json`. |
| `03-companion-pr-view.json` | `gh pr view 101 --json …` after creation. |
| `04-reviews-before-second.json` | `GET repos/mike-north/doc-linter/pulls/100/reviews` before the second review. |
| `05-validate-second.json`, `-stderr.txt`, `05-exit.txt` | `validate --sarif second.sarif.json … --existing-companion 101 --format json`. |
| `06-publish-second.json`, `-stderr.txt`, `06-exit.txt` | `publish --sarif second.sarif.json … --existing-companion 101 --state <evidence>/state/second.json --format json`. |
| `07-retry-second.json`, `-stderr.txt`, `07-exit.txt` | The same `publish` again, with the same state path. |
| `08-reviews-after.json` | `GET repos/mike-north/doc-linter/pulls/100/reviews` afterwards. |
| `09-original-pr-view.json`, `09-companion-pr-after.json` | `gh pr view 100` and `gh pr view 101 --json …` afterwards. |
| `10-refs-after.txt` | `git ls-remote` of `main`, the fixture branch and the suggestion branch afterwards. |
| `state/` | Both publications' state: the first one's plan and step records, the second one's publication record. |

Redaction: the local directory of the run is written `<evidence>`. No token or email address appears.

## What this does not show

- A review that both creates a suggestion pull request and lists an existing one, and a `single` bundle with an index. Both are covered by the fake host only (`test/companion-index-composition.test.mts`).
- An existing suggestion pull request that is closed or merged, from a fork, or with a version 2 marker, live.
- A lost create-review response, and its recovery with the identical body, live. The fake host covers it, with and without created suggestion pull requests.
- Whether the pending review's index renders as shown once it is submitted. The submitted first review's body was read back through the API, not rendered in a browser.
