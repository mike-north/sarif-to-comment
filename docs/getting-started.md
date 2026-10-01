# Getting started with sarif-to-comment

`sarif-to-comment` turns a [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html) document into **one draft review** on a GitHub pull request. The SARIF can come from any analyzer, or you can [write it yourself](#write-a-review-yourself), add the changes you staged with Git as suggested fixes, and inspect it before publishing. Publication works like this:

- general findings go in the review body;
- findings on lines the pull request changed become inline comments;
- supported fixes become native suggestions.

Everything is sent in a single request, pinned to the commit you reviewed.

A few rules shape everything below:

- **Whole review or nothing.** The document is validated first. If any finding can't be published faithfully, nothing is published and you get an explanation (`blocked`).
- **Draft by default, one-way.** The review is created as a draft, and a person submits it on GitHub. The tool never submits, edits, restores or deletes a review afterwards. If you want the review visible at once, ask for it explicitly: see [Submitting the review immediately](#submitting-the-review-immediately).
- **Never duplicated.** Each publication has a durable state file. Retrying with the same file confirms the existing review instead of creating another.

There are two ways to use it: the **library**, which takes SARIF in memory, and the **CLI**, which takes SARIF files. Both run the same code and produce the same results.

## Install

Requires Node.js 22 or later.

```sh
npm install sarif-to-comment
```

## Credentials

Creating a review needs a GitHub **personal access token** (or another user token) for an account that can review the pull request:

- **Fine-grained token:** grant *Contents: Read* and *Pull requests: Read and write* on the repository.
- **Classic token:** use the `repo` scope for private repositories.

Pass the token as `token` to the library, or set `GH_TOKEN` (or `GITHUB_TOKEN`) for the CLI.

GitHub App installation tokens are **not supported**, and that includes the automatic `GITHUB_TOKEN` inside GitHub Actions workflows. In a workflow, store a personal access token as a secret and pass that instead.

This token is only for creating reviews. It is unrelated to how this package itself is published to npm, which uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and concerns maintainers only.

## What you need to know about the review

The examples below read these values from the environment:

| Variable | Meaning | Example |
| --- | --- | --- |
| `GH_TOKEN` | The token described above. | |
| `REVIEW_REPOSITORY` | `owner/repo` of the pull request. | `acme/widgets` |
| `REVIEW_PULL` | Pull request number. | `42` |
| `REVIEW_COMMIT` | The **reviewed commit**: the full 40-character SHA your analyzer looked at. | `c0dec0de…` |
| `REVIEW_STATE` | Absolute path of the **state file** for this publication. | `/var/lib/my-linter/acme-widgets-42-run-1817.json` |

- **Reviewed commit.** This is usually the pull request's head commit when your analysis ran. The review stays pinned to it even if the author pushes more commits later. Findings that can no longer be anchored inline become exact links to the reviewed commit in the review body. Nothing is ever moved to a different line or commit.
- **State path.** Choose one state file per publication and keep it:
  - Retry with the same path.
  - **Do not delete it** after an `uncertain` result; it is the only record that the review may already exist.
  - A new path starts a new, separate review.
  - Concurrent runs sharing one path are safe: exactly one sends.
- **Source root.** If your SARIF uses absolute `file:` URIs from the machine that ran the analysis (for example `file:///home/runner/work/widgets/widgets/src/app.js`), also pass the repository root as an absolute `file:` URI ending in `/`. That's `sourceRootUri` in the library and `--source-root` in the CLI. Repository-relative URIs need nothing extra.

GitHub allows an account **one pending draft review per pull request**. If your account already has a draft there, publication is `rejected`, and the tool will never touch that draft. Submit or delete it on GitHub yourself, then publish again with a new state path.

### Submitting the review immediately

Add `options: { submit: true }` (library) or `--submit` (CLI, for `publish` and `validate`) to create the review already submitted, as a **comment review**. It is the same single request with GitHub's `COMMENT` event, so the review is visible on the pull request at once and its explanation starts with `## Review submitted`.

- It never approves or requests changes, and nothing is inferred from finding severity.
- Every check, approval hold and the reviewed-commit pinning apply exactly as for a draft.
- The state file records the mode. Retry with the same state path **and** the same mode; the other mode is refused before any request.

### Choosing where each proposed change goes

Each proposed change is delivered by the first available mechanism of an ordered list for its kind (the full rules are in the source repository, `docs/delivery-policy-contract.md`):

| Kind | Library (`options.delivery`) | CLI | Default |
| --- | --- | --- | --- |
| An edit in no group | `edits` | `--edits` | `['native']`: a native suggestion |
| A group of edits, or a fix with several changes | `groupedEdits` | `--grouped-edits` | `['native-batch']`: every change a native suggestion, to apply together |
| A whole-file creation or deletion, and any group with one | `fileOperations` | `--file-operations` | `['manual']`: its section of the review body; for a group, one section holding every member |

- The defaults never create a pull request. A later mechanism of a list is a fallback, announced by a `delivery-fallback` warning. When no listed mechanism can deliver a proposal, nothing is published: the review is blocked with a `delivery-unavailable` error naming why (exit status 2), and nothing else is substituted.
- `--delivery companion` (`delivery: { preset: 'companion' }`) sends every proposal to companion pull requests; `--delivery original-pr` keeps every proposal on the pull request. On the command line a list is comma-separated, for example `--file-operations companion,manual`.
- A repository can set the same members in `.github/sarif-to-comment.json` on its default branch (`{ "delivery": { "fileOperations": ["companion", "manual"] } }`); your settings win over it, setting by setting.
- `review-body` (`--edits native,review-body`) and `manual-group` (`--grouped-edits native-batch,manual-group`) put a proposal in the review body for the author to make by hand: each edit as its exact replacement in a code block, never as a suggestion, and a group as one section listing every change, to commit at once. They are used only when listed. `manual`, the default for a group that creates or deletes a file, presents that group the same way.

### Proposing new files and grouped changes as pull requests

List `companion` to offer whole-file creations and deletions, SARIF fixes with several changes, and changes you grouped with `group-fixes` (`groupSarifFixes`) as **suggestion pull requests** into the pull request's head branch: for example `--grouped-edits companion --file-operations companion,manual` (library: `options: { delivery: { groupedEdits: ['companion'], fileOperations: ['companion', 'manual'] } }`). They are drafts, unless you add `markSuggestionPullRequestsReady: true` (`--mark-suggestion-prs-ready`). The review links each one, and the outcome lists them in `suggestions`. With `--companion-bundle single`, every one goes into one pull request, a section each.

- It is off by default: every created pull request is visible to the repository and can trigger its CI and notifications.
- Each carries the repository's suggestion label: `suggestion-pr`, or the `label` of `.github/suggestion-prs.json` on the default branch. Add team or campaign labels with `pullRequestLabels: ['team-a']` (`--pr-labels team-a`). Every label must already exist (the tool never creates labels), your token needs *Contents: Read and write*, and the original pull request must come from the same repository and target its default branch; otherwise the proposal goes to the next mechanism of its list, or the review is blocked.
- A draft can't be merged: someone with write access marks it ready for review, then the author merges it or not.
- Keep the state file **and** the files created beside it (`<state>.suggestion-1-branch`, …, `<state>.review`); a retry uses them to continue without sending anything twice.
- After the original pull request merges or closes, `sarif-to-comment close-suggestion-prs --repo OWNER/REPO` (library: [`closeSuggestionPullRequests`](./api/sarif-to-comment.closesuggestionpullrequests.md)) closes its suggestion pull requests that are still open. Try it with `--dry-run` first. By default it closes only the suggestion pull requests your token's account opened; `--owner all` closes anyone's. It finds them by their `suggestion-pr/` branches and stops before checking anything if there are more than 500 (`--max-candidates N` changes the limit). It only closes pull requests: branches are never deleted, and an original it can't read is never treated as ended.

## Library: publish SARIF from memory

Save this as `publish-review.mjs` and run it with `node publish-review.mjs`. It uses an ES module; with CommonJS, replace the `import` with `const { publishSarifReview } = require('sarif-to-comment')` and wrap the `await` in an async function. The located finding refers to line 7 of `src/calc.js`; in your own code, the locations come from your analyzer, and inline comments appear only on lines the pull request changed.

<!-- verified-example: library -->
```js
import { publishSarifReview } from 'sarif-to-comment';

// 1. Your analyzer's SARIF 2.1.0 output as a plain object. No file is needed.
const sarif = {
  version: '2.1.0',
  runs: [
    {
      tool: { driver: { name: 'example-linter', version: '1.0.0' } },
      columnKind: 'utf16CodeUnits',
      results: [
        { message: { text: 'Consider adding a changelog entry for this change.' } },
        {
          message: { text: 'This new function has no tests.' },
          locations: [
            { physicalLocation: { artifactLocation: { uri: 'src/calc.js' }, region: { startLine: 7 } } },
          ],
        },
      ],
    },
  ],
};

// 2. Where the review goes, which commit it is about, and its state file.
const [owner, repo] = process.env.REVIEW_REPOSITORY.split('/');
const outcome = await publishSarifReview({
  sarif,
  destination: { owner, repo, pullNumber: Number(process.env.REVIEW_PULL) },
  reviewedCommit: process.env.REVIEW_COMMIT,
  statePath: process.env.REVIEW_STATE, // keep this file and reuse it to retry
  token: process.env.GH_TOKEN,
  // sourceRootUri: 'file:///home/runner/work/widgets/widgets/', // only for absolute file: URIs
});

// 3. Act on the outcome. `markdown` always explains what happened.
console.log(outcome.markdown);
switch (outcome.status) {
  case 'published':
    console.log(`Draft review: ${outcome.review.url}`);
    break;
  case 'blocked':
    process.exitCode = 2; // fix the SARIF; nothing was written anywhere
    break;
  case 'uncertain':
    process.exitCode = 3; // retry later with the same statePath; do not delete it
    break;
  case 'rejected':
    process.exitCode = 1; // GitHub refused; resolve it, then use a new statePath
    break;
}
```

Run it again with the same `REVIEW_STATE` and it reports the same review without sending anything.

The promise rejects, rather than returning an outcome, in three cases:

- invalid input: a `TypeError`, raised before any network request;
- a corrupt state file, or a state path reused for different input;
- an operational failure such as a network error.

The error message never contains the token.

## CLI: publish a SARIF file

Your analyzer writes `results.sarif`, which must be UTF-8 JSON; a leading byte-order mark is fine. Then:

<!-- verified-example: cli -->
```sh
# GH_TOKEN, REVIEW_REPOSITORY, REVIEW_PULL, REVIEW_COMMIT and REVIEW_STATE are set as described above.
npx --no-install sarif-to-comment \
  --sarif results.sarif \
  --repo "$REVIEW_REPOSITORY" \
  --pull "$REVIEW_PULL" \
  --commit "$REVIEW_COMMIT" \
  --state "$REVIEW_STATE"
status=$?

case $status in
  0) echo "Published (or already published)." ;;
  2) echo "Blocked: fix the SARIF file; nothing was published." ;;
  3) echo "Uncertain: retry later with the same --state file; do not delete it." ;;
  *) echo "Failed or refused (exit $status); see the message above." ;;
esac
exit $status
```

The CLI prints the same Markdown the library returns. Add `--source-root file:///…/` for absolute artifact URIs, and `--ignore-approval-hold` to publish despite an approval hold. `npx sarif-to-comment --help` lists every option and needs no token.

## Check readiness without publishing

`validate` (`validateSarifReview` in the library) runs every check `publish` runs against the pull request, then stops. It also reports a pending review of your account on the pull request, which GitHub would not let you add another review beside. It reads GitHub but never writes to it, and it takes no state path and writes no file. It is optional, and it grants nothing: `publish` repeats every check against the pull request as it is then.

<!-- verified-example: validate -->
```sh
# GH_TOKEN, REVIEW_REPOSITORY, REVIEW_PULL and REVIEW_COMMIT are set as described above.
npx --no-install sarif-to-comment validate \
  --sarif results.sarif \
  --repo "$REVIEW_REPOSITORY" \
  --pull "$REVIEW_PULL" \
  --commit "$REVIEW_COMMIT"
status=$?

case $status in
  0) echo "Ready: publish would create the review." ;;
  2) echo "Blocked: the message lists every problem to resolve before publishing." ;;
  *) echo "Not assessed (exit $status): no verdict; see the message above." ;;
esac
exit $status
```

| Library `status` | CLI exit | Meaning |
| --- | --- | --- |
| `ready` | 0 | Publication would proceed to its single create request, and your account has no pending review on the pull request. The pull request can still change before you publish. |
| `blocked` | 2 | Publication would be blocked, or your account already has a pending review on the pull request. `problems` lists each problem, with a pointer into the SARIF when it is in the document; for a document problem the Markdown is exactly what `publish` would print. |
| `incomplete` | 1 | The check could not be completed, for example because of a refused credential, a network failure, a failed source read or a review list that couldn't be read completely. This is not a verdict. |

## Write a review yourself

You don't need an analyzer. Create a SARIF document, add findings on lines or line ranges, stage the changes you are proposing with `git add`, and turn them into suggested fixes on those findings:

| Step | CLI | Library |
| --- | --- | --- |
| Create a document for your findings | `init` | `createSarifDocument` |
| Add a finding on a line or range | `add-comment` | `addSarifComment` |
| Add your staged changes as fixes | `add-staged-changes` | `addStagedChangesToSarif` |
| Proofread findings and fixes | `inspect` | `inspectSarif` |
| Publish the draft review | `publish` | `publishSarifReview` |

Each step reads and writes ordinary SARIF. Every step is optional, and none of them needs the one before it: SARIF from an analyzer can be inspected, given staged changes, extended with your own findings, or published directly.

Things to know:

- **Line numbers refer to the reviewed commit**, the same `REVIEW_COMMIT` as above. For a file the reviewed commit doesn't have, they refer to its staged content.
- **Only staged content is used.** Changes in your working tree that you haven't staged are ignored, so stage exactly what you want to propose.
- **A change attaches to a finding only when the finding's lines lie inside the lines the change replaces.** Neither is ever enlarged. A staged change that only adds lines replaces no reviewed line, so it is never credited to a nearby finding; its receipt entry says `insertion: true` (the CLI prints "insertion after line N"). A change that no finding explains is still included, as a short factual finding attributed to `sarif-to-comment`; a finding that only partly overlaps a change stays a plain comment, and the receipt says so.
- **Findings from another tool keep their attribution.** To add your own finding to an analyzer's SARIF, give it a new run (`--new-run-tool NAME`, or `run: { toolName }`), so the analyzer is never credited with it.
- **Library calls never change their input.** Each call returns a new document; keep using the returned one.

The examples below use a repository whose reviewed commit has this `src/parse.js`:

```js
function parse(input) {
  const parts = input.split(',');
  return parts.map(Number);
}
```

with line 2 changed and staged as `  const parts = input === '' ? [] : input.split(',');`. Run them from the repository's working tree, with the variables from the table above.

### CLI

<!-- verified-example: authoring-cli -->
```sh
set -e
npx --no-install sarif-to-comment init --output review.sarif --tool-name "Review agent"
npx --no-install sarif-to-comment add-comment --sarif review.sarif \
  --file src/parse.js --line 2 --message "Handle the empty-input case."

# Stage your proposed change first (git add src/parse.js); unstaged edits are ignored.
npx --no-install sarif-to-comment add-staged-changes --sarif review.sarif \
  --output review.staged.sarif --worktree . \
  --repo "$REVIEW_REPOSITORY" --commit "$REVIEW_COMMIT"

npx --no-install sarif-to-comment inspect --sarif review.staged.sarif
npx --no-install sarif-to-comment publish --sarif review.staged.sarif \
  --repo "$REVIEW_REPOSITORY" --pull "$REVIEW_PULL" \
  --commit "$REVIEW_COMMIT" --state "$REVIEW_STATE"
```

- `init` refuses to overwrite an existing file. `add-comment` updates its file in place.
- `add-staged-changes` never changes its input, so you can correct `review.sarif` and run it again. If the output file already exists, it's first renamed to `<UTC time>.old.review.staged.sarif`. When it fails, it writes no output and exits with status 2.
- `inspect` shows every finding in full, with its locations and fixes. Only long fix previews are shortened, always with a `(truncated: …)` note. Log-level properties and inline external properties are shown verbatim too; results embedded in inline external properties are counted separately and are not presented as findings, and external property files are never fetched. Inspecting doesn't check whether the file can be published; `publish` does that.
- Add `--format json` (or `--format toon`, the same document in a more compact notation) to any command for one document on standard output, including for errors. It carries the same information as the human output, and the exit status is the same. Agents should prefer it. Every document ends with `diagnostics`: its errors, warnings and notes, each with a stable `code` listed in [Diagnostics](./diagnostics.md). In human output, the diagnostics appear on standard error, once: standard output keeps the outcome (for `validate`, `publish` and `close-suggestion-prs`, the report without its problem and warning lists).

### Library

<!-- verified-example: authoring-library -->
```js
import {
  createSarifDocument,
  addSarifComment,
  addStagedChangesToSarif,
  inspectSarif,
  publishSarifReview,
} from 'sarif-to-comment';

const [owner, repo] = process.env.REVIEW_REPOSITORY.split('/');
const reviewedCommit = process.env.REVIEW_COMMIT;

// 1. Your findings. Each call returns a new document; keep the returned one.
let sarif = createSarifDocument({ tool: { name: 'Review agent' } });
const added = addSarifComment(sarif, { file: 'src/parse.js', line: 2, message: 'Handle the empty-input case.' });
if (added.status !== 'added') throw new Error(added.markdown);
sarif = added.sarif;

// 2. What you staged with `git add` becomes fixes on those findings.
const staged = await addStagedChangesToSarif({ sarif, worktree: process.cwd(), reviewedCommit, repository: { owner, repo } });
if (staged.status !== 'added') throw new Error(staged.markdown);
sarif = staged.sarif;

// 3. Proofread.
const inspected = inspectSarif(sarif);
if (inspected.status !== 'inspected') throw new Error(inspected.markdown);
for (const finding of inspected.view.findings) {
  console.log(`${finding.ref}: ${finding.message.text} (${finding.fixes.length} fix)`);
}

// 4. Publish one draft review.
const outcome = await publishSarifReview({
  sarif,
  destination: { owner, repo, pullNumber: Number(process.env.REVIEW_PULL) },
  reviewedCommit,
  statePath: process.env.REVIEW_STATE,
  token: process.env.GH_TOKEN,
});
console.log(outcome.markdown);
if (outcome.status !== 'published') process.exitCode = 1;
```

### Correcting a finding

To correct a finding, remove it and add the corrected one. `remove-comment` removes one finding and the fixes attached to it; every other finding and fix stays as it is. It takes a selector, which `inspect` shows for every finding (`Selector: …` in human output, `selector` in JSON). A selector belongs to the document as it was inspected: after any change to the file, inspect again. An old selector is refused (exit status 2) rather than removing whichever finding has moved into its place. This example corrects a comment that was put on the wrong line:

<!-- verified-example: correction-cli -->
```sh
set -e
npx --no-install sarif-to-comment init --output review.sarif --tool-name "Review agent"
npx --no-install sarif-to-comment add-comment --sarif review.sarif \
  --file src/parse.js --line 3 --message "Handle the empty-input case."

# Oops: that belongs on line 2. Take the finding's selector from inspect, remove it, add it again.
selector=$(npx --no-install sarif-to-comment inspect --sarif review.sarif --format json \
  | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s).view.findings[0].selector))')
npx --no-install sarif-to-comment remove-comment --sarif review.sarif --finding "$selector"
npx --no-install sarif-to-comment add-comment --sarif review.sarif \
  --file src/parse.js --line 2 --message "Handle the empty-input case."

# Regenerate the separate output from the corrected file, then publish it.
npx --no-install sarif-to-comment add-staged-changes --sarif review.sarif \
  --output review.staged.sarif --worktree . \
  --repo "$REVIEW_REPOSITORY" --commit "$REVIEW_COMMIT"
npx --no-install sarif-to-comment publish --sarif review.staged.sarif \
  --repo "$REVIEW_REPOSITORY" --pull "$REVIEW_PULL" \
  --commit "$REVIEW_COMMIT" --state "$REVIEW_STATE"
```

- Correct the file you authored and run `add-staged-changes` again, rather than editing its output: removal never re-derives fixes, and the previous output is kept as `<UTC time>.old.review.staged.sarif`.
- Removal only changes the local file. A review you already published stays as it is on GitHub; publishing the corrected file needs a new state path and creates a separate draft review.
- In the library, `removeSarifComment(sarif, selector)` does the same in memory and returns `removed` with the new document, or `stale` / `invalid` with the reason; the input is never changed.

### SARIF from an analyzer

An analyzer's SARIF needs no `init`. This adds your staged changes to `results.sarif` from an analyzer that reported line 2 of `src/parse.js`, then publishes:

<!-- verified-example: upstream-cli -->
```sh
set -e
npx --no-install sarif-to-comment inspect --sarif results.sarif
npx --no-install sarif-to-comment add-staged-changes --sarif results.sarif \
  --output results.staged.sarif --worktree . \
  --repo "$REVIEW_REPOSITORY" --commit "$REVIEW_COMMIT"
npx --no-install sarif-to-comment publish --sarif results.staged.sarif \
  --repo "$REVIEW_REPOSITORY" --pull "$REVIEW_PULL" \
  --commit "$REVIEW_COMMIT" --state "$REVIEW_STATE"
```

A finding that already has its own fix is never changed. If your staged change is identical to that fix, it counts as already present. If your staged change differs from it on the same lines, `add-staged-changes` fails rather than choose between them.

**Current limits.** Staged edits to UTF-8 text files become fixes. Publication still checks native-suggestion compatibility: empty reviewed files, or files containing only a byte-order mark, have no source line for an inline suggestion and are blocked. Staged file creations and deletions are recorded as proposed file operations that `inspect` shows. `publish` presents each one in the review body: a new file in full, with its size, line endings and mode stated, and a deletion as a link to the file at the reviewed commit. Content that a code block can't show exactly, such as control characters or mixed line endings, blocks the review instead. Mode changes, symbolic links, submodules, binary files, conflicts and intent-to-add entries can't be represented; `add-staged-changes` fails, names the path and explains what to do.

## Outcomes

| Library `status` | CLI exit | Meaning | What to do |
| --- | --- | --- | --- |
| `published` | 0 | The publication is complete: the draft review was created and confirmed now, confirmed after an earlier uncertain attempt, or already recorded as complete in the state file (which needs no GitHub request). A person may since have submitted, edited or deleted the review; the tool does not check. | Nothing more to publish. Reviewing and submitting the draft is up to people on GitHub. |
| `blocked` | 2 | The document can't be published faithfully. Nothing was written and no state file exists. | Fix the SARIF (the Markdown lists every problem with a pointer), then run again. |
| `uncertain` | 3 | Delivery could not be confirmed, for example because the response was lost or the review isn't visible yet. | Retry later with the **same** state path; it only checks GitHub. Don't delete the file. |
| `rejected` | 1 | GitHub definitively refused the request, and it is never resent. | Resolve the cause (often an existing pending draft), then use a **new** state path. |
| *(rejects / throws)* | 1 | Invalid input, a state problem, or an operational failure. | Read the message; nothing was published unless a state file says otherwise. |

## More

- **Approval hold.** A run or result with `properties.sarifToComment.approval: "awaiting-approval"` blocks publication. `options.ignoreApprovalHold` (`--ignore-approval-hold`) bypasses only that hold.
- **Old-side source.** Findings on deleted lines are verified against the pull request's own patch. Pass `oldSourceCommit` (`--old-source-commit`) only when GitHub's comparison can't establish the diff's old side.
- **Supported SARIF and limits.** See the [README](../README.md) for the supported profile, limits and current limitations.
- **API reference.** The generated [API reference](./api/index.md) documents every function and every input and outcome type. The package also ships TypeScript declarations.
