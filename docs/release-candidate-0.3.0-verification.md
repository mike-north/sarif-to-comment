# Release candidate 0.3.0: acceptance before publication

Run on October 1, 2026, against the final candidate for 0.3.0: `main` at merge commit `99b461d` (`99b461d599d58d4bcca7fc7cfdad5d4b0076343b`). This record covers the candidate **before publication**. Nothing was published to npm, `release:version` was not run in any working tree, and the version was not bumped. The packed and installed package therefore still names itself `0.2.1`.

**This record attests only to commit `99b461d599d58d4bcca7fc7cfdad5d4b0076343b` (tree `8e967698c25eed18d7050bfeb11f683ed2322b2d`) and the tarball with SHA-256 `72ec9f58c1f2b20b59de85920dcc0eb9d69ff3d48cba66b2ffef94e23b423385`.** It is not evidence for any other commit or artifact. The earlier acceptance of `89826ad` ([evidence](evidence/release-acceptance/README.md)) remains a separate, historical record. Under the [evidence policy](evidence-policy.md), this record is historical too: it is not updated to follow later changes.

**Result: no defect was found.** Every check passed:

- **Part A:** the clean-clone build and check, and the pack check.
- **Part B:** 126 installed-package steps with 350 checks.
- **Part C:** 31 live checks.

On this evidence, the candidate is ready for the owner's review. Versioning and publishing follow through the version pull request.

The evidence is in [`evidence/release-candidate/`](evidence/release-candidate/), redacted as described [below](#files).

## A. Identity of the candidate

| Item | Value |
|---|---|
| Source | A fresh `git clone` of `github.com/mike-north/sarif-to-comment`, checked out detached at `99b461d599d58d4bcca7fc7cfdad5d4b0076343b`, which was also `origin/main`. Tree `8e967698c25eed18d7050bfeb11f683ed2322b2d`. |
| Runtime | Node `v24.14.0`, npm `11.18.0`, pnpm `11.12.0`, macOS (Darwin arm64). `GITHUB_TOKEN` was unset for every command. |
| Install, build | `pnpm install --frozen-lockfile`: exit 0. `pnpm run build`: exit 0, and the build changed no tracked file. |
| Check | `pnpm run check` (lint, types, API report and reference, release plan, full test suite): exit 0. **4,073 tests in 458 suites, 4,073 passing**, with 0 failing, cancelled, skipped or todo. |
| Release plan | `Release plan allowed: sarif-to-comment 0.2.1 -> 0.3.0 (minor).` |
| Tarball | `npm pack --json` in the clone gave `sarif-to-comment-0.2.1.tgz`: **537 files**, 501,411 bytes. SHA-256 **`72ec9f58c1f2b20b59de85920dcc0eb9d69ff3d48cba66b2ffef94e23b423385`**, SHA-1 `3a7cb8257e339a322a697fcaff4254c63a59e544`, integrity `sha512-+jaFyHXxWb3NTpSZ8LQskdTLpx3tdt9IvDdnm0XyofKYsrZPP8QSc94/x61u42j+hPBq5kzyKUo4VLQL+nj80w==`. |
| Pack check | `node scripts/release-guard.mts verify-pack`: exit 0, "Verified sarif-to-comment-0.2.1.tgz: 537 files, all inside the distribution boundary." |
| Rendered CHANGELOG | `pnpm run release:version` was run in a **throwaway clone** at `99b461d`, never in the worktree. It exited 0 and consumed the sixteen changesets. It set `package.json` to `0.3.0` and wrote `CHANGELOG.md`: **69,745 bytes** (751 lines), SHA-256 **`8a8067258e331003dd48411af8dae6bf1ecd7abd83e67a355129881af7d26fa5`**. Its `## 0.3.0` section, up to `## 0.2.1`, is 66,548 bytes (708 lines), SHA-256 `6470b65abbf6cf8c920b0200ad31f485dbd41da925ba93d5ed3578946faea0a1`. The rendered file is kept byte for byte. |

Evidence for part A:

- [`package/clean-clone.txt`](evidence/release-candidate/package/clean-clone.txt)
- [`package/tarball-identity.json`](evidence/release-candidate/package/tarball-identity.json), which is the manifest for this tarball, with every file
- [`package/npm-pack.json`](evidence/release-candidate/package/npm-pack.json)
- [`package/verify-pack.txt`](evidence/release-candidate/package/verify-pack.txt)
- [`package/changelog-0.3.0.json`](evidence/release-candidate/package/changelog-0.3.0.json)
- [`package/CHANGELOG-0.3.0-rendered.txt`](evidence/release-candidate/package/CHANGELOG-0.3.0-rendered.txt)

The tarball has one more file than the earlier acceptance's 536: the generated reference page `docs/api/sarif-to-comment.iclosesuggestionpullrequestsinput.requireabandonedoriginal.md`. No file was removed. The tarball's version is `0.2.1` because nothing was versioned. A version pull request changes only `package.json`, `CHANGELOG.md` and the consumed changesets, so its tarball will have a different SHA-256 from this one.

## B. Installed-package acceptance of this tarball (local)

The tarball was installed into a new consumer project (`npm install <tarball>`). Its lockfile records the same integrity as the pack. The dependencies came from the registry ([`package/consumer-npm-ls.txt`](evidence/release-candidate/package/consumer-npm-ls.txt)).

The driver ([`installed/accept-driver.mts.txt`](evidence/release-candidate/installed/accept-driver.mts.txt)) is the earlier acceptance's driver, with only its output path changed and sections 13 to 18 added for the delta. It ran from the fresh clone, so the fake GitHub hosts and fixtures are those of `99b461d`. Every command ran through the installed `sarif-to-comment` executable or `import … from 'sarif-to-comment'` in the consumer.

For each step, [`installed/steps/`](evidence/release-candidate/installed/steps/) holds:

- the command and its exit status;
- standard output and standard error;
- the input SARIF;
- what the fake host held afterwards;
- every check.

[`installed/summary.json`](evidence/release-candidate/installed/summary.json) lists them all. Expected values are written from the contracts, not from earlier output.

**Result: 126 steps and 350 checks. Every check passed.**

| Part | Steps | Checks | Result | What was shown |
|---|---|---|---|---|
| **The full earlier suite, unchanged** | 001–093 | 227 | pass | Every feature added since 0.2.1, as the [earlier acceptance](evidence/release-acceptance/README.md#a-installed-tarball-acceptance-local) lists them. No earlier expectation needed changing. |
| Root `--help` title | 094 | 4 | pass | The first line is exactly `sarif-to-comment — author, inspect, publish SARIF as a draft or submitted review`, 80 characters or fewer. |
| Path rule: whole-file proposal | 095, 098 | 10 | pass | A creation whose path holds U+200B, and then one holding U+00A0, is blocked with exit 2 and `file-operation-path-unrepresentable`. The message says "contains U+200B, which cannot be shown exactly" (or U+00A0). Nothing is written and there is no state file. |
| Path rule: alternative | 096, 099 | 10 | pass | An alternative on a file whose path holds the character is blocked with `alternative-path-unrepresentable`, "the file path contains U+XXXX, which cannot be shown exactly". Nothing is written. |
| Path rule: edit made by hand | 097, 100 | 8 | pass | Under `--edits review-body`, the edit is blocked with `delivery-unavailable`. Its `review-body` obstacle ends "the file path contains U+XXXX, which cannot be shown exactly." ([delivery policy §8.10](delivery-policy-contract.md#810-proposals-made-by-hand-on-the-original-pull-request)). Nothing is written. |
| Outcome Markdown nesting | 101–104 | 11 | pass | A blocked `validate` on a pull request from a fork has two `delivery-unavailable` problems with two obstacles each. In its outcome `message`, each obstacle line is indented two spaces. The installed `mdast-util-from-markdown` with GFM parses it as one list of two items, each holding its own list of two obstacles, with no sibling list. A published `delivery-fallback` warning parses as one item holding its one obstacle. The diagnostic's own `message` keeps its unindented text. |
| Projected diff | 105–106 | 12 | pass | Results below the table. |
| `--if-abandoned` | 107–123 | 57 | pass | Results below the table. |
| Example workflow | 124–126 | 11 | pass | `docs/examples/abandonment-cleanup.workflow.yml` parses as YAML (`yaml` 2.x) and has the shape listed below the table. `actionlint` 1.7.12 reports nothing (exit 0). Every option the workflow passes is in the installed `close-suggestion-prs --help`. |

**Projected diff.** The step reviews the commit a force-push replaced (the rewritten-history world with head C1′). Its edit replaces the CRLF line `Only line, with CRLF.` with `Only line,​with LF.\n` and is delivered with `--edits companion`. It is `ready`, then `published`, with no diagnostics. Exactly one draft suggestion pull request is created. Its description holds, exactly as [companion contract §2.11](companion-suggestion-pr-contract.md#211-presentation) specifies:

- the projection section;
- the hunk `@@ -1 +1 @@ CRLF line endings become LF line endings`, with `+Only line,{U+200B}with LF.`;
- the escapes note.

No raw U+200B, U+00A0 or CR is in the description. The committed bytes are exactly the replacement, and `docs/sample.md` is unchanged. The proposal commit's parent is the reviewed commit. The plan is version 3, with a `faithful` projection, and the review is pinned to the reviewed commit.

**`--if-abandoned`.** The steps follow [cleanup contract §2.12](suggestion-cleanup-contract.md#212-requiring-an-abandoned-original-requireabandonedoriginal---if-abandoned):

- **An open, a merged and a missing original** are each skipped: exit 0 and `original-not-abandoned`, with one note `original-pull-request-not-abandoned` carrying the §2.12 message. The run makes no listing and no write. The original is read right after the label resolution, and nothing is requested after it. A missing original gives no `original-pull-request-not-found` warning.
- **The human form of a skip** prints the skip title and "Nothing was checked or closed." on stdout, with the note on stderr.
- **A closed, unmerged original:**
  - The guarded dry run proceeds (`would-close`), and its JSON document is identical to the unguarded one.
  - The real run makes exactly one PATCH, which closes the suggestion.
  - A rerun reports `already-closed`.
- **An original whose read fails** (403 or 502): exit 1, `error`, `operation-failed`, with "Pull request … could not be read (… HTTP 403/502 …) … nothing was checked or closed." Nothing is requested after the failed read. In human form, stdout is "Nothing was closed."
- **Usage errors**, each exit 1 with no request: the guard without `--original`, with a `--label` sweep, and given a value (`--if-abandoned=yes`). In JSON form, the error is one `usage-error` document.
- **The help** documents the option.
- **The library:** `requireAbandonedOriginal` skips an open original. Without `originalPullNumber`, or given a value that is not a boolean, it is a `TypeError`.

**The example workflow's shape:**

- it triggers on `pull_request` `closed` only, and never on `pull_request_target`;
- the job runs only when the event says the pull request was not merged;
- its first step is `sleep 120`;
- its permissions are `pull-requests: write`, `contents: read` and `issues: read`;
- `GH_TOKEN` is `${{ secrets.SARIF_TO_COMMENT_TOKEN }}`;
- it runs `npx --yes sarif-to-comment@0.3.0 close-suggestion-prs --repo … --original … --if-abandoned --owner all`;
- there is no checkout step;
- concurrency cancels an earlier waiting run.

Separately, `git ls-remote` shows that the pinned `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` is the commit of both tags `v7.0.0` and `v7` ([`live/c14-setup-node-tag.txt`](evidence/release-candidate/live/c14-setup-node-tag.txt)).

## C. Live acceptance of the delta (`mike-north/doc-linter`)

The installed executable from part B ran against `mike-north/doc-linter`, a private fixture repository, as its owner `mike-north`. The token came from `gh auth token` with `GITHUB_TOKEN` unset, and was given inline per command. It was never printed or saved. The `gh api` readback stopped once at the local steering hook. It was rerun unchanged with the reason "bounded doc-linter fixture acceptance", and nothing was routed around the hook.

[`live/live-checks.mts.txt`](evidence/release-candidate/live/live-checks.mts.txt) computes every check from the saved outputs. The results are in [`live/checks.json`](evidence/release-candidate/live/checks.json). **Result: 31 checks over 12 steps. Every check passed.**

### C1. One review whose suggestion pull request carries a CRLF line and an invisible character

The projected diff appears only in a suggestion pull request for a commit that a force-push replaced. So the fresh fixture was built like the earlier force-push flow, with three commits:

| Commit | SHA | Contents |
|---|---|---|
| C0 | `3c27048` | From `main` (`0a7b03f`). Adds `docs/experiments/rc030/sample.md` (20 lines) and `docs/experiments/rc030/crlf.txt`, whose one line is `Only line, with CRLF.\r\n` (bytes `…2e 0d 0a`). |
| R | `920fc63` | Changes lines 5 and 6 of the sample. The branch `sarif-rc030-crlf-20261001` was pushed at R, and [#107](https://github.com/mike-north/doc-linter/pull/107) was opened as a draft into `main`. |
| A | `3706446` | R amended to also change line 15, with parent C0. Force-pushed with a lease. |

The SARIF document ([`live/review-107.sarif`](evidence/release-candidate/live/review-107.sarif)), at R, has two findings:

- a general remark;
- a fix that replaces line 1 of `crlf.txt`, including its CRLF terminator, with `Only line,​with LF.\n`.

It was delivered with `--edits companion`.

| Step | Result |
|---|---|
| c01 `validate … --pull 107 --commit 920fc63… --edits companion --format json` | Exit 0, `ready`, no diagnostics. It plans one draft suggestion pull request, "projected onto the head `3706446…`: merging it applies only its own changes". |
| c02 `publish` with a relative `--state` | **Operator error, not a product check.** Exit 1, `usage-error` "--state must be an absolute file path", raised before any request. The readback shows one review and one suggestion pull request in all, both from c03. |
| c03 `publish` with an absolute `--state` | Exit 0, `published`, no diagnostics. It created the **pending review 5378749555** and the **draft suggestion pull request [#108](https://github.com/mike-north/doc-linter/pull/108)** from `suggestion-pr/107/7e5f9d0c-d206-4fa4-b752-7daa9659ede1` at `5747d6a`. |
| c04, c06: #108 | Open, draft, into `sarif-rc030-crlf-20261001`, label `suggestion-pr`. GitHub reports `MERGEABLE` / `CLEAN`. The description has the exact §2.11 section and no raw U+200B, U+00A0 or CR. It ends with a version 1 marker naming #107 and R. Its commits are R (parent C0) and `5747d6a` (parent R). |
| c05, c06: committed bytes | `git` shows the committed `crlf.txt` (blob `d87cade`) is exactly `4f6e6c79206c696e652c e2808b 77697468204c462e 0a`: "Only line,", U+200B, "with LF.", one LF and no CR. The proposal commit changes only that file, and `sample.md` is R's blob. GitHub's GraphQL reports the blob as 22 bytes, not binary, with exactly that text. At R the file is the 23-byte CRLF original. |
| c06: the review | One review on #107: `PENDING` at R, with no inline comment. Its body equals the request recorded in the state before sending. It begins with the companion index listing #108 "created with this review". The plan is version 3 with `projection: { head: A, mergeBase: C0, suggestions: [{ verdict: faithful }] }`. |

The description of #108 as GitHub stores it ([`live/c04-pr-108-view.json`](evidence/release-candidate/live/c04-pr-108-view.json)):

````
**The reviewed commit is not part of the branch of #107:** the branch was rewritten after commit 920fc63ae2fde7a398dd63c1d80dad425c7fc085 (its head was 37064469185a2a04ffef0063059c5c6fd8332c31 when this was proposed). GitHub shows this pull request's changes from an older merge base, so they also list changes of the reviewed commit itself. Projected onto that head before this pull request was created, merging it applies only its own changes, which are these:

```diff
--- a/docs/experiments/rc030/crlf.txt
+++ b/docs/experiments/rc030/crlf.txt
@@ -1 +1 @@ CRLF line endings become LF line endings
-Only line, with CRLF.
+Only line,{U+200B}with LF.
```

In this diff, each `{U+XXXX}` stands for the character with that code point, written visibly; this pull request's commit has the exact bytes.
````

### C2. `--if-abandoned --dry-run` against an open and a closed, unmerged original

| Step | Original | Result |
|---|---|---|
| c08 (JSON), c09 (human) | #107, open (draft) | Exit 0, **skipped**: `original-not-abandoned`, `originals: [{ 107, open }]`, no suggestions and zero counts. It reports one note `original-pull-request-not-abandoned` about `mike-north/doc-linter#107`: "#107 is open, not closed without merging, so nothing was checked or closed." In human form, stdout is the skip title and "Nothing was checked or closed.", and the note is on stderr. |
| c10 (JSON), c11 (human) | #57, closed without merging on September 30, 2026 | Exit 0, **proceeded**: `complete`, `#57: closed without merging`, its suggestion #59 `already-closed`, counts 1/1/1/1, no diagnostics, "This was a dry run: nothing was closed." |

The states of #107, #108, #57 and #59 were read with `gh pr view` before and after these runs and are identical ([`c07`](evidence/release-candidate/live/c07-states-before.jsonl), [`c12`](evidence/release-candidate/live/c12-states-after.jsonl)). `main` was `0a7b03f` before and after ([`c13`](evidence/release-candidate/live/c13-refs-after.txt)).

### Every live object created

Nothing was merged, closed, submitted or deleted, and `main` was not touched. Nothing was cleaned up.

| Kind | Object |
|---|---|
| Branch | `sarif-rc030-crlf-20261001`: pushed at R `920fc63`, then force-pushed to A `37064469185a2a04ffef0063059c5c6fd8332c31`. C0 `3c27048` is in its history. |
| Branch (by the tool) | `suggestion-pr/107/7e5f9d0c-d206-4fa4-b752-7daa9659ede1` at `5747d6ab1c7779e3601da56bdb5962fdd2bf83e5` |
| Pull request | [#107](https://github.com/mike-north/doc-linter/pull/107), draft, into `main` |
| Pull request (by the tool) | [#108](https://github.com/mike-north/doc-linter/pull/108), draft suggestion, labeled `suggestion-pr` |
| Review | 5378749555 on #107, **pending**, at R |

## What this covers

- **The exact candidate.** A fresh clone at `99b461d` installs from its lockfile, builds without changing a tracked file, and passes the full check (4,073 tests). Its pack passes the distribution-boundary check. The release plan is 0.2.1 → 0.3.0, and the rendered 0.3.0 CHANGELOG is identified by hash.
- **The installed tarball, against fake hosts.** Every installed-package check of the earlier acceptance passes again, unchanged, against this tarball. So do new checks for every change merged since `89826ad`:
  - the projected-diff display, with visible escapes and the line-ending note;
  - the nesting of the outcome Markdown, checked by parsing;
  - the path rule for invisible characters, in all three forms;
  - the root `--help` title;
  - `--if-abandoned` in every state and usage error;
  - the example workflow, checked by parsing and by `actionlint`.
- **On live GitHub:**
  - the projected diff of a suggestion pull request after a force-push: an invisible character written as `{U+200B}` with the note, a CRLF-to-LF change stated on its hunk, and the exact bytes committed, read back through Git and through GitHub;
  - the guard skipping an open original and proceeding for a closed, unmerged one, without writing.
- **Content-only changes.** The consolidated release notes are covered by the rendered CHANGELOG's identity. The docs anchor repairs change only documentation, and the full check passed with them.

## What this does not cover

- **No live run of the example workflow.** Running it on GitHub (the realignment plan's E7) needs the owner's authority to install a workflow in a fixture repository's branch, and a repository secret. That authority has not been given. Only the workflow file was checked, by parsing and `actionlint`. Its trigger, wait, concurrency and credential have not been observed on GitHub. The pinned `sarif-to-comment@0.3.0` resolves only once 0.3.0 is published.
- **`github.token` support is unproven.** The example documents the automatic Actions token as an alternative, but the support profile does not claim it, and no run has used it (Phase 2 of the [proposed experiment](evidence/abandonment-cleanup/README.md#the-remaining-obstacle-a-live-workflow-run)).
- **Forks and non-default bases are unsupported.** Suggestion pull requests are not made for a pull request from a fork or into a base other than the default branch ([D41](design-decisions.md#d41-the-suggestion-pull-request-convention-and-options--owner-decisions)). This run refused a fork only against the fake host (step 101). The live refusal for a non-default base is in the earlier acceptance (doc-linter #102).
- **Projection limits.** The projection is exact only within the limits of [companion contract §2.5.1](companion-suggestion-pr-contract.md#251-fidelity-after-a-rewritten-history). Beyond them (for example a directory rename, or a file that is not text) no suggestion pull request is made. A conflicting projection was exercised only against the fake host, in step 060 of the earlier suite. A projected suggestion pull request was neither merged nor applied, so GitHub's merged result was not compared with the projection. `MERGEABLE` is not proof of the merged content.
- **The D60 template engine is not selected.** Repository templates for the review's presentation are not in 0.3.0. Only library callbacks customize the review ([D60](design-decisions.md#d60-use-reusable-markdown-components-for-a-rich-github-review-experience--owner-selected-presentation-direction), [template engine evaluation](template-engine-evaluation.md#8-recommendation)).
- **Publication itself.** This covers neither the versioned tarball, a registry install, signatures, provenance, nor the publish workflow. The version pull request's tarball will differ from this one in `package.json` and `CHANGELOG.md`. Its acceptance belongs to the release verification.
- **Other conditions.** Node 22 was not run here (CI runs it), and neither were other operating systems, other accounts or GitHub Enterprise. Live, this run did not cover a guarded run that closes something, or a read failure of the original (both are covered against the fake host, steps 113 and 115–117). It also did not cover a live run of the features that the earlier acceptance and earlier records cover.
- **The owner's review.** The items listed for confirmation in [Current status](status.md#items-for-the-owners-confirmation-at-release-review) are implemented as described. This record does not confirm them.

## Observations, not defects

- **Raw characters in refusal messages.** A refused path is quoted raw in the caller's diagnostic, for example `The path "docs/x​y.md" contains U+200B, …` (steps 095–100). The message names the character by code point, nothing reaches GitHub, and no contract requires diagnostics to escape it. It is recorded for the owner.
- **The suggestion pull request's file list.** #108's files on GitHub include `sample.md` +2 −2, R's own change of lines 5 and 6. This is GitHub's diff from the older merge base C0 (GH-20), and its description says so. The proposal commit itself changes only `crlf.txt` (c05).
- **The source excerpt** in #108's description shows the reviewed line as `Only line, with CRLF.`, without its terminator. The review presentation contract §5 shows a line's text, and a CRLF terminator is not part of it. The change of line ending is stated in the diff.

## Files

All paths are under [`evidence/release-candidate/`](evidence/release-candidate/).

| Path | Contents |
|---|---|
| `package/clean-clone.txt` | Part A: the clone, revision, tree, runtime versions, install, build and check results, the test totals and the release plan line |
| `package/tarball-identity.json` | The tarball's identity and every file, attesting to `99b461d` (the manifest for this record) |
| `package/npm-pack.json`, `package/verify-pack.txt`, `package/consumer-npm-ls.txt` | The pack output, the distribution-boundary check, and the consumer's dependencies |
| `package/changelog-0.3.0.json`, `package/CHANGELOG-0.3.0-rendered.txt` | The rendered CHANGELOG's identity, and the file itself |
| `installed/summary.json`, `installed/steps/` | Every step of part B, with its checks |
| `installed/accept-driver.mts.txt` | The driver that ran part B (a copy; it imports the repository's test fixtures) |
| `live/review-107.sarif`, `live/state/` | The live SARIF document and the publication state |
| `live/cNN-*` | The standard output, standard error and exit status of each command, and each readback, named in the text above. `c06-readback.graphql` is the one GraphQL query. |
| `live/checks.json`, `live/live-checks.mts.txt` | The part C checks and the script that computed them from those files |

Redaction: the live run's local directory is written `<evidence>`, the worktree `<repo>`, the clone `<clone>` and the consumer project `<consumer>`. Part B's temporary directory is `<tmp>`. Email addresses are `<redacted-email>`. The fake hosts' tokens are test constants, and no real token appears.
