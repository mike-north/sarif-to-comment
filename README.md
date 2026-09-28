# sarif-to-comment

Publish a ready [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html) document as **one GitHub draft pull request review**: general feedback in the review body, findings on changed lines as inline comments, and supported fixes as native suggestions. It is sent in a single create-review request.

This is the first milestone (version 0.1.0). Its scope is deliberately narrow:

- **One-way.** SARIF goes to GitHub once. The tool never updates, reconciles, submits, restores or deletes a review afterwards. Supplying a new SARIF document (with a new state path) creates a separate review.
- **Drafts only.** The review is created pending. A person submits it on GitHub.
- **Whole review or nothing.** If any finding can't be published faithfully, nothing is published, and the tool explains why.
- **Not on the npm registry.** The package is `private` on purpose. Install it from a local checkout or a packed tarball.

Requires Node.js 22 or later.

## Installation (local only)

The package is not published to the npm registry. Build a tarball from a checkout, then install that file in your project:

```sh
# in a checkout of this repository
npm pack                      # writes sarif-to-comment-0.1.0.tgz

# in your project
npm install /path/to/sarif-to-comment-0.1.0.tgz
npx sarif-to-comment --help
```

Installation downloads the three runtime dependencies (`ajv`, `ajv-draft-04`, `ajv-formats`) from your usual registry. Only the library sources, the CLI, the vendored official SARIF schema and this README are installed.

## Library

The library is the primary interface. SARIF is passed as an in-memory object; no temporary file is needed. This example uses an ES module (`.mjs`, or a package with `"type": "module"`):

```js
import { publishSarifReview } from 'sarif-to-comment';

const outcome = await publishSarifReview({
  sarif, // the parsed SARIF log (a plain JSON object)
  destination: { owner: 'acme', repo: 'widgets', pullNumber: 42 },
  reviewedCommit: 'c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de', // full 40-character SHA
  statePath: '/var/lib/my-linter/reviews/acme-widgets-42-run-1817.json', // absolute; see below
  token: process.env.GH_TOKEN, // a personal access token or user token
  // sourceRootUri: 'file:///home/ci/work/widgets/', // optional: repo root in the producer's file system
  // oldSourceCommit: '<full SHA>',                  // optional: see "Old-side source"
  // options: { ignoreApprovalHold: true },          // optional: see "Approval hold"
});

console.log(outcome.markdown); // always a human-readable explanation

switch (outcome.status) {
  case 'published': // outcome.review = { id, url }; outcome.statePath
  case 'blocked':   // nothing was written anywhere; markdown lists every problem
  case 'uncertain': // delivery could not be confirmed; outcome.statePath (see below)
  case 'rejected':  // GitHub refused the request; it is never resent; outcome.statePath
}
```

The contract is `status` plus `markdown`, and `review` or `statePath` where listed. Internal diagnostic codes are not part of it and may change.

The promise rejects for:
- invalid input (a `TypeError`, before any network request);
- a corrupt state file, or a state path reused for different input;
- operational failures, such as a network error or an unreachable pull request.

A rejection never contains the token.

The `sarif` value is copied when the call starts, so changing your object afterwards has no effect. Getters are never run. The copy refuses cycles and values JSON can't represent (functions, `undefined`, `NaN`, class instances and so on), rather than silently dropping them.

## CLI

```sh
GH_TOKEN=... sarif-to-comment \
  --sarif results.sarif \
  --repo acme/widgets --pull 42 \
  --commit c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de \
  --state /var/lib/my-linter/reviews/acme-widgets-42-run-1817.json
```

Optional flags: `--source-root FILE_URI`, `--old-source-commit FULLSHA` and `--ignore-approval-hold`. Run `sarif-to-comment --help` for details; it needs no token and makes no request.

The CLI reads the file and calls the same `publishSarifReview`. It prints the same Markdown to stdout.

The SARIF file must be UTF-8 JSON. A leading UTF-8 byte-order mark is ignored, so the CLI and a library caller passing the same parsed document produce the same publication. A file that is not valid UTF-8 (including UTF-16) is refused before any request is made. Its bytes are never silently replaced.

| Exit status | Meaning |
| --- | --- |
| 0 | published (or already published) |
| 2 | blocked: nothing was published |
| 3 | uncertain: retry with the same `--state` |
| 1 | usage error, unreadable or unparsable SARIF file, refused request, or operational failure (details on stderr) |

## Credentials

Use a GitHub **personal access token or user token**, which needs permission to read the repository and to create pull request reviews. The CLI reads `GH_TOKEN`, or else `GITHUB_TOKEN`; there is no token flag.

Authentication uses the authenticated user's identity. GitHub App installation tokens, including the automatic `GITHUB_TOKEN` of GitHub Actions workflows, are **not supported**.

The token is never written to the state file, never included in any fingerprint, and never printed. It is redacted from errors.

## The state path: retries, recovery and concurrency

`statePath` (`--state`) is the durable identity of **one** publication. You choose it, and you must keep it.

- Before anything is sent, the tool writes the complete intended review and a hidden marker to that file and flushes it to disk. Only the process that creates the file sends, and it sends once.
- **Retry with the same state path.** A later run never sends again. It returns the recorded result, or checks GitHub for the marker and confirms the complete review. It doesn't need the branch to still exist or the SARIF to still apply, because it works from the saved request.
- **After an `uncertain` result, do not delete the state file.** Delivery could not be confirmed: the response may have been lost, or the review may not be visible yet. The file is the only record that a review may already exist, and deleting it risks a duplicate. Retry later with the same path. The tool never repairs or restores anything it finds.
- **A new state path means a new, separate review.** Use one only when you deliberately want another review, for example for new SARIF.
- Concurrent runs on the same state path are safe: exactly one sends and the others only check.
- The state path is bound to its input. Reusing it with different SARIF, a different pull request or commit, or a different source root or old-side candidate is refused. An unresolved publication also checks the authenticated account. Completed and rejected records return without authentication or network calls; the API still requires a token-shaped input.
- The state file is created with owner-only permissions. It requires a local file system that supports hard links.

## One pending review per account

GitHub lets an account hold only **one pending (draft) review per pull request**, and refuses a second one with HTTP 422. If your account already has a draft on the pull request — made by a person or by an earlier run — publication is `rejected`. The tool never submits, edits or deletes an existing draft to make room. A person has to submit or delete it on GitHub, and then you publish again with a new state path.

A refused request is recorded in the state file. Later runs with that path report the refusal without contacting GitHub, and never resend it.

## Supported SARIF (first-milestone profile)

- **Whole-review validation.** The document is validated against the official SARIF 2.1.0 schema, then checked for consistency against the pull request's actual source. Invalid input or an unsupported finding, source association or fix blocks the entire review. Every accepted finding is included; this is not a lossless rendering of all SARIF metadata.
- **General findings.** A result without a location goes in the review body.
- **Findings with a location.** A result with one physical location becomes an inline comment when it maps exactly onto a line of the pull request's diff at the reviewed commit. Otherwise it goes in the body with an exact permalink to that commit and a copy of the source. Nothing is ever placed on a nearby or different line.
- **Suggestions.** A fix with one text replacement on the reviewed head, inside the diff, becomes a native GitHub suggestion. A located result must refer to the same file and revision, with its lines contained in the replacement's lines. Otherwise this profile refuses the association; keep the correct finding location and separate the feedback from the unsupported fix. Cases GitHub doesn't apply faithfully are refused before anything is written, including raw CR in the suggestion payload, nested triple-backtick fences, blank-only replacements and unsafe final-line deletions.
- **Refused features.** Multiple locations, related locations, code flows, graphs, stacks, attachments, suppressions, alternative or multi-file fixes, and file creation or deletion proposals are refused with an explanation.
- **Metadata limits.** Producer fingerprints, rank and occurrence counts are not rendered. A logical location accompanying a physical location is not rendered; a logical-only location is unsupported. Taxonomy classifications remain in preparation evidence but are not shown in the review.
- **Result limits.** Results are limited to 100 inline comments, 60,000 characters per body or comment, and about 1 MB per request. These are conservative product limits, not GitHub maxima.
- **Pull request limits.** Pull requests changing more than 3,000 files, and source files larger than 1,000,000 bytes or not valid UTF-8, are refused rather than read partially. A file whose patch GitHub omits cannot receive inline comments.

### Approval hold

A run or result may declare `properties.sarifToComment.approval: "awaiting-approval"`. Publication then stops with `blocked`.

`options.ignoreApprovalHold` (`--ignore-approval-hold`) overrides **only** that hold, never any other check. The override is not part of the publication's identity, so a retry doesn't need to repeat it.

### Reviewed commit and historical reviews

The review is always tied to `reviewedCommit`, even when the author's branch has moved on since. If the pull request's head has advanced past the reviewed commit, the tool doesn't retarget the review. Findings that can no longer be anchored inline go in the body as exact links to the reviewed commit.

### Old-side source

Findings about deleted or original lines need to know the diff's old side. By default the tool asks GitHub to compare the pull request, and verifies each old file by reversing the pull request's own patch against the exact file contents. Old-side source of renamed files is not supported.

If that comparison can't establish the old side, you may pass `oldSourceCommit` (`--old-source-commit`) as a candidate. It is verified the same way, never trusted blindly, and it becomes part of the publication's identity. SARIF provenance naming other revisions is still published as general feedback. It is never chosen automatically as the diff's old side.

## Limitations

- The library and CLI have been verified against live GitHub with complete pending reviews, exact source and original-anchor readback, rendered inline comments and suggestions, general feedback, branch advance, and read-only recovery after a discarded create response and a process kill. These bounded fixture runs do not establish every host failure mode or suggestion shape. Native application of one-line-to-three, two-lines-to-one and middle-line deletion suggestions was verified by exact resulting file bytes and Git blob identities. Inline-only and CRLF-source review bodies also read back exactly. See the [live evidence](https://github.com/mike-north/sarif-to-comment/blob/main/docs/milestone-e2e-evidence.md) and [application evidence](https://github.com/mike-north/sarif-to-comment/blob/main/docs/suggestion-application-e2e.md) in the repository.
- Only `https://api.github.com` is supported.
- The hidden marker only identifies a review; it is not a secret. A human edit to an unconfirmed draft leaves delivery `uncertain` rather than being "fixed".
- The durability steps (write, flush, then send) are ordered for crash safety, but that has not been tested against power loss.
- GitHub Enterprise Server and GitHub App installation tokens are not supported.
- There is no review maintenance, re-review or synchronisation back to SARIF.

## Development

```sh
npm test            # node --test test/*.test.cjs
npm run check:lint  # ESLint, read-only
npm run check       # lint, then tests
```
