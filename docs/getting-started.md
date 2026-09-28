# Getting started with sarif-to-comment

`sarif-to-comment` turns a ready [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html) document into **one draft review** on a GitHub pull request:

- general findings go in the review body;
- findings on lines the pull request changed become inline comments;
- supported fixes become native suggestions.

Everything is sent in a single request, pinned to the commit you reviewed.

A few rules shape everything below:

- **Whole review or nothing.** The document is validated first. If any finding can't be published faithfully, nothing is published and you get an explanation (`blocked`).
- **Draft only, one-way.** The review is created as a draft. A person submits it on GitHub. The tool never submits, edits, restores or deletes a review afterwards.
- **Never duplicated.** Each publication has a durable state file. Retrying with the same file confirms the existing review instead of creating another.

There are two ways to use it: the **library**, which takes SARIF in memory, and the **CLI**, which takes a SARIF file. Both run the same code and produce the same results.

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
- **API reference.** The generated [API reference](./api/index.md) documents `publishSarifReview` and every input and outcome type. The package also ships TypeScript declarations.
