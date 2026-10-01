# Release acceptance of `main` at `89826ad`: the installed package and live GitHub

Run on October 1, 2026, against `main` at merge commit `89826ad` (`89826adcb1ede78d3098f621c93dcd8da042f2b1`). This was the candidate for the next release: everything merged since `sarif-to-comment@0.2.1` and listed as unreleased in [Current status](../../status.md). Nothing was published to npm. `release:version` was not run, and the version was not bumped. So the packed and installed package still names itself `0.2.1`, and `--version` reports that (step 001), read from the installed `package.json`.

Under the [evidence policy](../../evidence-policy.md), this record is historical. It is not updated to follow later changes to the code or the fixtures.

The record has two parts:

- **A. Installed-tarball acceptance.** The packed tarball was installed into a clean consumer project. Every feature added since 0.2.1 was exercised through that installed executable and `import … from 'sarif-to-comment'`, against the repository's fake GitHub hosts. These results are **local**.
- **B. Live acceptance.** The same installed executable ran against `mike-north/doc-linter` on github.com. These results are **observed on GitHub**, and every one was read back through the API.

## Conditions

| Item | Value |
|---|---|
| Source | `main` at `89826ad`, clean worktree. `pnpm install --frozen-lockfile` and `pnpm run build` were run, and the build changed no tracked file. |
| Runtime | Node `v24.14.0`, npm `11.18.0`, pnpm `11.12.0`, macOS |
| Tarball | `sarif-to-comment-0.2.1.tgz`: 536 files, 495,345 bytes, SHA-256 `314fd9a4e05c23ecfa7f0904c1707f9975c77a8d7bda5b6eb20bdc3deaeb1158`, integrity `sha512-vv/sb8EC…` ([`package/tarball-identity.json`](package/tarball-identity.json), [`package/npm-pack.json`](package/npm-pack.json)) |
| Pack check | `node scripts/release-guard.mts verify-pack`: exit 0, "536 files, all inside the distribution boundary" ([`package/verify-pack.txt`](package/verify-pack.txt)) |
| Consumer | A new `package.json` in a scratch directory, then `npm install ../sarif-to-comment-0.2.1.tgz`. Dependencies came from the npm registry ([`package/consumer-npm-ls.txt`](package/consumer-npm-ls.txt)). |
| Fake hosts (part A) | `test/fixtures/composition` (`FakeHttpGitHub`), reached by preloading `test/fixtures/docs/fake-fetch-preload.mts` (`NODE_OPTIONS=--require=…`), which replaces only `fetch`. The worlds come from `test/support/delivery-world.mts`, `test/fixtures/rewritten-history/world.mts`, `test/fixtures/historical-placement/world.mts` and a cleanup world built as `test/installed-cleanup.test.mts` builds its own. |
| Live account (part B) | `mike-north`, the repository owner. The token came from `gh auth token` with `GITHUB_TOKEN` unset, and was given inline per command as `GH_TOKEN`. It was never printed or saved. |
| Live repository | `mike-north/doc-linter` (private). Its default branch `main` was `0a7b03f` before and after the run, and has no `.github/sarif-to-comment.json` or `.github/suggestion-prs.json`. |

## A. Installed-tarball acceptance (local)

The driver ([`installed/accept-driver.mts.txt`](installed/accept-driver.mts.txt), a copy of the script that ran) builds each fake world and runs one command or consumer module per step. It records the following for every step in [`installed/steps/`](installed/steps/):

- the command;
- its exit status;
- its full standard output and standard error;
- the SARIF given to `--sarif`;
- what the fake host held afterwards: every write, each review request and each pull request;
- every check made.

[`installed/summary.json`](installed/summary.json) lists all 93 steps. **All 227 checks passed.** Each step's checks also include that the fake token never appears in its output. Expected values are taken from the contracts, not from earlier output. For example:

- the configuration message of [delivery policy §11.4](../../delivery-policy-contract.md#114-states-and-validation);
- the companion index of [companion contract §2.13.3](../../companion-suggestion-pr-contract.md#2133-the-index);
- the native-batch and manual-group texts of [delivery policy §8.8 and §8.10](../../delivery-policy-contract.md#88-what-this-version-supports);
- the colour precedence of [Diagnostics](../../diagnostics.md).

| Feature | Steps | Checks | Result | What was shown |
|---|---|---|---|---|
| `--version` | 001–002 | 4 | pass | The installed `package.json` version, alone on stdout. `publish --version` works without a token. |
| `inspect` selectors and groups | 003–016 | 13 | pass | `/runs/0/results/N@<16 hex>` selectors in JSON and as `Selector:` lines. The group appears in both views. |
| `group-fixes` / `ungroup-fixes` | 005–012, 018 | 11 | pass | Grouping with `--output` leaves `--sarif` untouched. Extending a group in place works. A stale selector exits 2 with the file unchanged. A new group of one change exits 2. Ungrouping one member of three works. In the library, a lone member is `refused`, and ungrouping the whole group gives back the original document. |
| `remove-comment` | 013–018 | 5 | pass | A stale selector exits 2 with the file unchanged. A fresh selector removes exactly one finding. Human and library forms work. |
| `validate` with the pending-review check | 019–026 | 14 | pass | `ready` with no write. After a draft, `blocked` (exit 2: "already has a pending review"). After a *submitted* review, `ready` again. |
| `--submit` | 022–025 | 9 | pass | The request carries `event: COMMENT`. A retry is answered from the state. Retrying the same state without `--submit` is refused (exit 1), because the mode is bound to the state. |
| Whole-file proposals | 027 | 4 | pass | The creation, with its exact content, and the deletion are review-body sections. There is no inline comment and no companion. |
| Alternatives | 028 | 4 | pass | The first fix is the native suggestion. The second is listed under "Alternatives to consider:". |
| Delivery: presets | 034–036 | 14 | pass | `original-pr`: a native edit, two announced fallbacks (manual edit, manual group) and no companion, with the policy recorded as `caller-preset`. `companion`: two per-unit companions. `--companion-bundle single`: one companion holding both files. |
| Delivery: `--edits` / `--grouped-edits` / `--file-operations` | 037–039 | 6 | pass | Each flag delivers its unit as one companion, and the branch contents are checked. |
| Delivery: strict-list block | 029–030 | 6 | pass | `--edits native` (and the default) with an edit outside the diff: exit 2, `delivery-unavailable` naming `file-not-in-diff`. No write, no state file. |
| Delivery: announced fallback | 031–032 | 6 | pass | `--edits native,review-body`: one `delivery-fallback`. A retry reports the same warning and sends nothing. |
| Delivery: configuration file | 041–043 | 8 | pass | `edits: [companion]` from `.github/sarif-to-comment.json` makes a companion, recorded as `configuration`. A caller flag overrides it. A repeated mechanism blocks with exactly ``…cannot be used: `/delivery/edits/1` repeats `native`.`` |
| Delivery: usage errors and options | 040, 044–047 | 10 | pass | `native,,review-body`, an unknown preset and the retired `--allow-suggestion-prs` each exit 1. `--pr-labels` with no companion gives a `companion-options-unused` note. In the library, a repeated mechanism is a `TypeError`, and the `original-pr` preset reports a fallback. |
| Review-body edits | 031, 033 | 3+ | pass | `**Proposed edit, to make by hand:**` with the exact replacement, and no suggestion. |
| Native batch | 048–049 | 6 | pass | An explicit group of 3: three inline suggestions, each carrying the group note, plus the body guidance. A fix with 2 changes is labelled `Fix with 2 changes`. |
| Manual group and mixed groups | 050–053 | 11 | pass | Under the defaults, a group that cannot be native is blocked, because `manual-group` is never a default. `--grouped-edits manual-group` gives the guidance and the change labels. The defaults deliver creation + edit + deletion as the mixed manual group. `--file-operations companion` puts all three in one companion. |
| Historical placement and association | 054–057 | 11 | pass | At a discarded commit: `ready` with no note, and a review pinned to R with RIGHT lines 2 and 6, line 6 carrying the suggestion. At an ancestor of the head: `ready`. **At an unrelated commit:** exit 2, `reviewed-commit-not-in-pull-request`, nothing written. |
| Companion fidelity verdicts | 058–060 | 12 | pass | **Unfaithful** (head D): blocked, "would bring back content the head no longer has", nothing created. **Faithful** (head C1′): created, no warning, parent R, plan version 3 with `faithful`. **Conflicts:** created with `companion-conflicts-at-head`, `mergeable: conflicting` reported, review pinned to R. |
| Companion index and `--existing-companion` | 061–064 | 10 | pass | `--existing-companion 98`, whose marker names #8: `companion-not-reusable` with the contract message. A created companion plus #97 reused: the body begins with the exact index, #97 is unchanged, and a retry sends nothing. The defaults with #97 only: the index alone, and no `companion-options-unused`. |
| Presentation callbacks (library) | 065–066 | 7 | pass | `finding`, `lifecycleNote` and `companionIndex` callbacks shape the companion description and the review body, and the marker stays last. A `lifecycleNote` that leaves `<!--` open is a `TypeError` before any write. |
| `close-suggestion-prs` | 067–078 | 25 | pass | The results below. |
| Every `--format` | 077–093 | 29 | pass | The results below. |

`close-suggestion-prs`:

- `--dry-run`: only the account's own suggestions are closed (`other-owner` for #41), and nothing changes.
- `--owner all`: #41 would be closed too.
- `--max-candidates 2`: exit 1, `too-many-candidates`.
- Usage errors, each exit 1: `--max-candidates` with `--original`, and `--force` without `--label`, which makes no request.
- `--label bug`: exit 2, `label-not-suggestion-prs`.
- `--label bug --force --max-candidates 10`: exit 1, since `--force` lifts only the early exit.
- A real run makes exactly one PATCH and no DELETE.
- `--original 37`: `already-closed`.
- Human output, TOON output and the library each ran.

Every `--format`:

- Human with `--color never`: a Markdown headline, and a plain `▲ warning` block on stderr.
- `--color always`: ANSI escapes on stderr, and stdout identical to `--color never`.
- `auto` off a terminal: plain.
- `FORCE_COLOR=1` turns colour on. `--color always` overrides `NO_COLOR`, and `FORCE_COLOR` overrides `NO_COLOR`. `NO_COLOR` alone gives plain output.
- `--format json` with `--color always` has no escapes.
- JSON is one document with an empty stderr. TOON is not JSON and has an empty stderr, and the installed `@toon-format/toon` decodes it to exactly the JSON document.
- `inspect` ran in all three formats.
- A usage error in JSON is one `usage-error` document.

## B. Live acceptance (observed on GitHub)

The same installed executable ran every command (`scratch/consumer/node_modules/.bin/sarif-to-comment`, written `sarif-to-comment` below). Every `gh api` readback stopped once at the local steering hook. It was rerun unchanged with the reason "bounded doc-linter fixture acceptance", and nothing was routed around the hook.

### B1. A first fixture whose base is not the default branch: refused before any write

The fixture was planned as fresh base and feature branches cut from a fixture commit: base `sarif-u8-acceptance-20261001-base` at `0a7b03f`, and head `sarif-u8-acceptance-20261001-reviewed` at `58d916e`, which adds `docs/experiments/u8-acceptance/sample.md` (12 lines `Line N.`) and `obsolete.md`. On that draft pull request, [#102](https://github.com/mike-north/doc-linter/pull/102), `validate` answered `blocked`, exit 2 ([`live/b01-validate-102.json`](live/b01-validate-102.json)). The obstacle was `companion`: "The pull request merges into `sarif-u8-acceptance-20261001-base`, which is not the default branch `main` … suggestion pull requests are not yet supported for such a pull request." This is the documented support boundary (non-default bases), and nothing was written. The consolidated review was therefore published on a pull request into `main`.

### B2. One consolidated review: native suggestions, a native batch, a mixed manual group, a companion and the index

| Object | Value |
|---|---|
| Head branch | `sarif-u8-acceptance-20261001-into-main` at `58d916e` (the same fixture commit; parent `0a7b03f` = `main`) |
| Pull request | [#103](https://github.com/mike-north/doc-linter/pull/103), draft, into `main` |
| Document | [`live/review-103.sarif`](live/review-103.sarif), with 10 findings at `58d916e`: |
| | - two ungrouped one-line fixes (lines 2 and 3), which become native suggestions |
| | - the group `batch-steps` (lines 5 and 6), which becomes a native batch |
| | - the group `guide-move`: the creation of `guide.md` (holding a fenced `sh` block), an edit of line 8 and the deletion of `obsolete.md`. Under the default `fileOperations: [manual]`, this is the mixed manual group. |
| | - the group `readme-pointer`: `README.md` line 5, which is outside the diff, and sample line 10 |
| | - a comment on line 12 with no fix |
| Delivery | `--grouped-edits native-batch,companion`. `batch-steps` is a native batch. `readme-pointer` cannot be a native batch, so its listed fallback `companion` delivers it, with one `delivery-fallback` warning. A strict `--grouped-edits companion` would also have sent `batch-steps` to a companion, and `--file-operations companion` would have sent `guide-move`. One dimension holds one list for all its units, so this is the one combination that exercises all four forms in one review. |

1. `validate … --pull 103 --commit 58d916e… --grouped-edits native-batch,companion --format json`: exit 0, `ready`, "5 inline comment(s) and 3 general section(s)", one draft suggestion pull request planned, one `delivery-fallback` warning ([`live/b02-validate-103.json`](live/b02-validate-103.json)).
2. `publish` with the same arguments and `--state`: exit 0, `published`. It created the pending review **5377519897** and the draft suggestion pull request **[#104](https://github.com/mike-north/doc-linter/pull/104)**, from `suggestion-pr/103/ba6241f2-a68e-4810-9812-919cb089e19d` at `28821ca`, with label `suggestion-pr` ([`live/b03-publish-103.json`](live/b03-publish-103.json), state in [`live/state/`](live/state/)).
3. Readback:
   - [`b04`](live/b04-review.json): the review, `PENDING`, `commit_id` `58d916e`.
   - [`b05`](live/b05-review-comments.json): its 5 comments.
   - [`b06`](live/b06-review-full.json): its rendered HTML.
   - [`b07`](live/b07-companion-pull-rest.json): #104 over REST.
   - [`b08`](live/b08-companion-files.json): #104's files.
   - [`b09`](live/b09-pr103-reviews.json): #103's reviews.

What GitHub stores:

- **The body is byte for byte the request recorded in the state before sending** (`request.body` of `state/review-103.json.review`, compared with `b04`).
- It begins with the **companion index**: `` - [#104](…/pull/104): `Suggestion for #103: readme-pointer (2 changes)` — created with this review ``.
- Next comes the **native-batch guidance**: ``**Suggestion group `batch-steps`:** apply these 2 suggestions together, in one commit: …``, listing lines 5 and 6.
- Next comes the **mixed manual group**: ``**Suggestion group `guide-move`:** apply these 3 changes together, by hand, in one commit: …``, with its three labelled changes. The new file's content sits in a four-backtick fence that holds the inner ```` ```sh ```` block. The edit is shown exactly, and the deletion carries its permalink.
- Last is #104's section.
- **Inline comments:** five, on `sample.md`, all at `58d916e`:
  - lines 2 and 3 carry native suggestions (`Line two.`, `Line three.`);
  - lines 5 and 6 carry the batch note and their suggestions;
  - line 12 is a plain comment.
- **#104:**
  - open, draft, base `sarif-u8-acceptance-20261001-into-main`, label `suggestion-pr`;
  - `mergeable: true`, `mergeable_state: clean`;
  - its description lists the two edits, the lifecycle note, both findings and a version 1 marker naming #103;
  - its files are `README.md` (line 5 → `What it does today, in brief:`) and `sample.md` (line 10), +1 −1 each, exactly the group.
- **Browser:** [`live/ui-1-pr103-files.jpg`](live/ui-1-pr103-files.jpg) and [`live/ui-2-pr103-suggestion.jpg`](live/ui-2-pr103-suggestion.jpg) show #103's files with the pending comments. GitHub renders line 3's comment as a "Suggested change" (`Line 3.` → `Line three.`), noting that a suggestion in a pending comment cannot be applied.

### B3. The force-push flow: a review at R, a rewrite, then a historical review with a faithful companion

| Object | Value |
|---|---|
| Branch | `sarif-u8-forcepush-20261001` from `main` `0a7b03f`: C0 `fd5211c` adds `docs/experiments/u8-forcepush/sample.md` (20 lines). **R** `bd76c7b` changes lines 5 and 6. |
| Pull request | [#105](https://github.com/mike-north/doc-linter/pull/105), draft, into `main` (head R at creation) |

1. **Review at R** ([`live/review-105-first.sarif`](live/review-105-first.sarif)). `publish … --commit bd76c7b… --submit`: exit 0. It created the **submitted** comment review **5377549452**, with one inline comment on line 5 ([`c01`](live/c01-publish-first-at-R.json)). It was submitted so that the account's one pending review (GH-06) stayed free for step 3.
2. **Force-push a rewrite.** R was amended to also change line 15, giving **A** `d17de75` (parent C0), and pushed with `--force-with-lease`. R is no longer an ancestor of the head. The timeline records one `HeadRefForcePushedEvent`, `bd76c7b` → `d17de75` ([`c05`](live/c05-pr105-graphql.json)).
3. **Publish at the historical R** ([`live/review-105-historical.sarif`](live/review-105-historical.sarif)): a plain comment on line 3, a native suggestion on line 12 (`Line twelve.`), and the group `tail` (lines 9 and 10), delivered with `--grouped-edits companion`.
   - `validate`: exit 0, `ready`, no diagnostics ([`c02`](live/c02-validate-historical.json)): "The history of #105 was rewritten after the reviewed commit, so it is proposed on that commit and was projected onto the head `d17de75…`: merging it applies only its own changes."
   - `publish`: exit 0, with no diagnostics ([`c03`](live/c03-publish-historical.json)). It created the pending review **5377558120** at `commit_id` R and the draft suggestion pull request **[#106](https://github.com/mike-north/doc-linter/pull/106)**, from `suggestion-pr/105/87324e76-9889-4cd0-9d95-d13cb808ea05` at `88efe39`, whose parent is R.
   - The plan is version 3 and records `projection: { head: d17de75…, mergeBase: fd5211c…, suggestions: [{ verdict: faithful, conflicts: [] }] }` (`live/state/review-105-historical.json`).
   - A retry with the same state: exit 0, "already published … Nothing was sent." ([`c04`](live/c04-retry-historical.json)).
4. **Readback, including `mergeable`:**
   - **#106 over REST:** `mergeable: true`, `mergeable_state: clean` ([`c09`](live/c09-companion-pull-rest.json)). `gh pr view` also reports `MERGEABLE` ([`e02-pr-106`](live/e02-pr-106-view.json)).
   - **#106's description** carries the projection section: "The reviewed commit is not part of the branch of #105 … merging it applies only its own changes", followed by one hunk, lines 9 and 10.
   - **#106 on GitHub:** commits R and the proposal commit ([`c11`](live/c11-companion-commits.json)). It shows `sample.md` +4 −4 at lines 5, 6, 9 and 10 ([`c10`](live/c10-companion-files.json)). That is the diff from the old merge base C0, as GH-20 records, and not the two-line change the description shows.
   - **The historical review 5377558120** ([`c06`](live/c06-pr105-reviews.json), [`c07`](live/c07-historical-review-comments.json)): `PENDING` at `bd76c7b`. Its comments sit on lines 3 and 12 at `bd76c7b`, `position` = `original_position`. In GraphQL ([`c05`](live/c05-pr105-graphql.json)), both threads have `isOutdated: false` and `line` = `originalLine`. Its body equals the recorded request and begins with the index listing #106.
   - **The first, submitted review 5377549452** ([`c08`](live/c08-first-review-comments.json)): GitHub now reports its comment at `commit_id` `d17de75`, with `originalCommit` R and `line` 5. This is GitHub's own handling of a submitted comment across a force-push. It is not the tool's.
5. **An unrelated commit is blocked, live** ([`c12`](live/c12-validate-unrelated.json)). `validate` on #105 at `58d916e` (#103's commit): exit 2, `reviewed-commit-not-in-pull-request`. The commit "is not the pull request's head d17de75… or an ancestor of it, and no force-push … replaced a head that contains it."

### B4. Cleanup, dry run only

- `close-suggestion-prs --repo mike-north/doc-linter --dry-run --format json`: exit 0, `complete`, owner `me`, counts `{ candidates: 22, checked: 21, labeled: 21, conforming: 21 }`. All 21 suggestion pull requests were `left-open`, because each original, #103 and #105 included, is open ([`d01`](live/d01-cleanup-dry-run.json)).
- `--original 105 --dry-run` (human): #106 is left open because #105 is open. "This was a dry run: nothing was closed." ([`d02`](live/d02-cleanup-original-105-dry-run.md)).

Every standard error file of part B is empty. Branches afterwards: [`e01`](live/e01-refs-after.txt). Pull requests afterwards: [`e02-*`](live/).

### Every live object created

None was merged, closed, submitted (apart from the deliberately submitted review below) or deleted, and `main` was not touched.

| Kind | Object |
|---|---|
| Branch | `sarif-u8-acceptance-20261001-base` at `0a7b03f` |
| Branch | `sarif-u8-acceptance-20261001-reviewed` at `58d916e` |
| Branch | `sarif-u8-acceptance-20261001-into-main` at `58d916e` |
| Branch | `sarif-u8-forcepush-20261001`: first `bd76c7b` (R), force-pushed to `d17de75` |
| Branch (by the tool) | `suggestion-pr/103/ba6241f2-a68e-4810-9812-919cb089e19d` at `28821ca` |
| Branch (by the tool) | `suggestion-pr/105/87324e76-9889-4cd0-9d95-d13cb808ea05` at `88efe39` |
| Pull request | [#102](https://github.com/mike-north/doc-linter/pull/102), draft, into the fixture base (validation only; no review) |
| Pull request | [#103](https://github.com/mike-north/doc-linter/pull/103), draft, into `main` |
| Pull request | [#105](https://github.com/mike-north/doc-linter/pull/105), draft, into `main` |
| Pull request (by the tool) | [#104](https://github.com/mike-north/doc-linter/pull/104), draft suggestion, labeled `suggestion-pr` |
| Pull request (by the tool) | [#106](https://github.com/mike-north/doc-linter/pull/106), draft suggestion, labeled `suggestion-pr` |
| Review | 5377519897 on #103, **pending** |
| Review | 5377549452 on #105, **submitted** (`COMMENTED`) at R |
| Review | 5377558120 on #105, **pending**, at the historical R |

## What this establishes

- The tarball packed from `89826ad` passes the distribution-boundary check. Once installed from it alone, every feature added since 0.2.1 behaves as its contract states, through the executable and the library, against the repository's fake hosts.
- On live GitHub, the installed package publishes one pending review that combines:
  - native suggestions;
  - a native batch with its guidance;
  - a mixed manual group, with the exact content of a new file holding its own fence, plus an edit and a deletion;
  - an announced fallback to one companion pull request whose branch holds exactly the group;
  - the companion index.

  The stored body equals the recorded request.
- On live GitHub, after a force-push:
  - the tool publishes a review pinned to the discarded commit, with an inline comment, a native suggestion and a companion;
  - the tool projected that companion faithful;
  - GitHub reports the companion `mergeable: true`;
  - the association check blocks a commit outside the pull request;
  - a retry sends nothing.
- A live dry-run cleanup over the repository's 22 suggestion branches classifies every open suggestion correctly and closes nothing.

## What this does NOT establish

- **A publish to npm or a registry install.** The tarball was installed from a file. Signatures and provenance belong to the release itself.
- **Part A on GitHub.** Everything in part A is local, against fake hosts that model documented GitHub behavior. Only part B is live. The following ran live in earlier records only, or not at all:
  - a projection that conflicts (with GitHub's `mergeable` for it);
  - the configuration file;
  - `--companion-bundle single`;
  - the `companion` preset;
  - presentation callbacks;
  - `ungroup-fixes`;
  - a real cleanup that closes something;
  - the colour and TOON formats.
- **Merging or applying anything.** No suggestion was applied, and no companion was merged or marked ready, so GitHub's merged result was not compared with the projection. `mergeable: true` is not proof of the merged content.
- **Other conditions:** a pull request into a base other than the default branch (refused, B1), forks, other accounts, GitHub Enterprise, and a lost response or crash recovery, live.
- **The rendering of the whole review.** The browser screenshots show part of the files view of #103 only. The bodies were read back through the API.

## Observations, not defects

- **Nested obstacle lists in the outcome Markdown.** In the human and `markdown` outcome of a blocked or warning publication, each diagnostic is one list item (``- `code` at `/pointer`: MESSAGE``). The message's own obstacle bullets (delivery policy §10.1 and §10.2) follow it unindented, so in Markdown they render as siblings of the problem, not as its children ([`live/b01-validate-102.json`](live/b01-validate-102.json) and [`live/b02-validate-103.json`](live/b02-validate-103.json), `message`). The text and its order are what the contract specifies, and no contract specifies the nesting, so this is recorded for the owner rather than as a defect. To reproduce, run `validate` with `--grouped-edits native-batch,companion` on a group with an edit outside the diff of a pull request into a non-default base.
- **`--version` reports `0.2.1`** because the version was deliberately not bumped. The value comes from the installed `package.json`, as it should.

## Files

| Path | Contents |
|---|---|
| `package/` | `npm pack --json` output, the tarball identity (attests to `89826ad`), the `verify-pack` result, and the consumer's `npm ls` |
| `installed/summary.json` | Every step of part A: feature, title, redacted command, exit status, checks |
| `installed/steps/NNN-*.txt` | Per step: the command, exit status, checks, any library script, stdout, stderr, the input SARIF and the fake host afterwards |
| `installed/accept-driver.mts.txt` | The driver that ran part A (a copy; it imports the repository's test fixtures) |
| `live/*.sarif` | The SARIF documents of part B |
| `live/bNN-*`, `cNN-*`, `dNN-*`, `eNN-*` | Standard output, standard error (`.stderr.txt`) and exit status (`NN-exit.txt`) of each command, and each API readback, named in the text above |
| `live/state/` | The publication states of part B |
| `live/ui-*.jpg` | Browser screenshots of #103 |

Redaction: the local directory of the live run is written `<evidence>`, the worktree `<repo>`, the consumer project `<consumer>` and the scratch temporary directory `<tmp>`. Any value under a key named `email` is `<redacted-email>`. The fake hosts' tokens are test constants, and no real token appears.
