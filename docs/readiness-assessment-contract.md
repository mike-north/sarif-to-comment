# Readiness assessment contract

Contract notes and decision proposal · September 28, 2026. This document specifies the optional whole-review readiness assessment. The [interface design](second-milestone-interface-design.md#deferred-standalone-validation-versus-inspection) deferred it, and D30 records it as user-requested. The command and function names come from that design. The input, outcomes and exit statuses below were not settled there. They are **a proposal awaiting owner acceptance**, adopted provisionally in their most conservative form, and listed under [Decisions awaiting acceptance](#decisions-awaiting-acceptance).

## Purpose

Assessment answers one question: can this complete SARIF artifact be published faithfully to this pull request, at this reviewed commit, under this policy? It is optional and never a workflow gate. It is not inspection. Inspection shows what a document contains and needs no destination. Assessment needs the destination and a credential, and it applies the publisher's own readiness rules:

- the SARIF 2.1.0 schema;
- the approval hold and its override (R11);
- source consistency against the reviewed snapshot (R3);
- supported representation and host constraints, including placement and native-suggestion eligibility (R7, R8);
- product limits;
- the pull-request context check that the publisher applies before any write (R12, R13);
- the publisher's own pre-send checks: the prepared review's shape and the authenticated account's numeric identity.

It performs these checks by running the publisher's code, not a copy of it (see [Shared checks](#shared-checks)).

## Guarantees

- **No remote writes.** Assessment uses only GitHub reads: the pull request, its files, the comparison, Git objects and the authenticated user. It never creates, submits, edits or deletes a review.
- **No durable state.** Assessment takes no state path and never creates, reads or changes a publication state file. It writes no file of any kind.
- **No approval stamp.** A `ready` outcome carries no token, fingerprint or identifier that publication accepts. Publication has no input for one; unknown fields are refused. `publish` performs every check itself, against the pull request as it is at that moment.
- **Not a delivery promise.** `ready` does not mean that delivery will succeed. The pull request can change after assessment. GitHub can also refuse the create request for reasons that only the write reveals, such as an existing pending review by the same account on the pull request. Delivery recovery questions are answered only by the publication state contract.
- **Credential safety.** As for publication, the token never appears in an outcome, its Markdown or a rejection.

## Library

```ts
validateSarifReview(input: IValidateSarifReviewInput): Promise<ValidateSarifReviewOutcome>
```

The input is exactly the publisher's input without `statePath`: `sarif`, `destination`, `reviewedCommit`, `token`, and optionally `sourceRootUri`, `oldSourceCommit` and `options.ignoreApprovalHold`. It is validated and captured exactly as `publishSarifReview` captures it. Invalid input rejects with a `TypeError` before any request. `statePath` is an unknown field and is refused, so an input is never mistaken for a publication.

| `status` | Meaning | Fields |
| --- | --- | --- |
| `ready` | Publication would proceed to its single create request. | `markdown` |
| `blocked` | Publication would return `blocked`. | `problems` (each a message with a JSON Pointer when the problem is in the document), `markdown` |
| `incomplete` | The assessment could not be completed, so this is no verdict. Examples: authentication failure, network failure, source-read failure, a pull request that does not match the requested destination and commit, or an account without a numeric user id. | `markdown` |

`blocked` Markdown is identical to publication's `blocked` Markdown for the same input and pull-request state. `problems` carries the same blockers as the Markdown, without internal codes (D13). An operational failure is reported as `incomplete`, never thrown and never `ready`. Operational failures are those the GitHub client reports (HTTP, network, authentication, source reads), its answer that the account has no numeric id, and context for another pull request or commit. Any other failure after input capture is a defect in the package or its client boundary, such as an internal invariant or a client answer outside its contract. It rejects, as it does for `publishSarifReview`, rather than being presented as a transient condition with retry advice.

## CLI

```
sarif-to-comment validate --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA
                          [--source-root ABSOLUTE_FILE_URI] [--old-source-commit FULLSHA]
                          [--ignore-approval-hold] [--format human|json]
```

- It takes the publish flags except `--state`, which is refused as an unknown option.
- The token comes from `GH_TOKEN`, else `GITHUB_TOKEN`, as for `publish`.
- Human mode prints the library Markdown to stdout for every library outcome. As for `publish`, usage and operational errors go to stderr.
- JSON mode prints one document: `{ command: "validate", status, problems?, message }`. `status` is `ready`, `blocked` or `incomplete`. Errors detected before the library runs use the existing `error` and `usage-error` documents: an unreadable SARIF file, a missing token, or a library `TypeError` (`error`), and invalid arguments (`usage-error`).

| Exit | Meaning |
| --- | --- |
| 0 | ready |
| 2 | blocked |
| 1 | incomplete, usage error, or operational error |

## Worked examples

The pull request `acme/gizmos#7` changes `src/app.js`, and its head is the reviewed commit `2222…`.

1. **Ready.** The SARIF has one general finding and one finding on line 4, which is in the diff. `validate` exits 0 with `status: "ready"`. The Markdown reports one inline comment and one general section for commit `2222…`. It also says that nothing was published or written, and that publication repeats every check. The fake host records no create request, and no state file exists.
2. **Blocked (approval hold).** The same finding carries `properties.sarifToComment.approval: "awaiting-approval"`. `validate` exits 2 with `status: "blocked"`. Its one problem points at `/runs/0/results/0`, and the Markdown is exactly what `publish` would print. With `--ignore-approval-hold`, the result is `ready`.
3. **Blocked (source inconsistency).** A finding's region snippet is `const MIN = 1;`, but line 4 of `src/app.js` at `2222…` is `const MAX = 100;`. The result is `blocked`, for the same reason that `publish` gives.
4. **Incomplete (authentication).** GitHub answers 401 to the pull-request read. `validate` exits 1 with `status: "incomplete"`. The Markdown names the failure (with the token redacted) and says that this is not a verdict. It is never `ready`.
5. **Incomplete (source read).** The pull request is readable but a source blob read fails. The result is `incomplete`, and `publish` would reject at the same point without writing.
6. **Remote context changes.** `validate` reports `ready` for a finding with a suggested fix on line 4. The author then pushes, so the pull request's head advances past the reviewed commit. A later `publish` fetches the context again and finds that the fix can no longer be a native suggestion on the current diff. Publication returns `blocked`: the earlier `ready` authorizes nothing.

## Shared checks

Publication and assessment call the same private functions for everything that precedes the publication identity:

- input validation and capture;
- the GitHub client's context fetch and its verification against the requested pull request and reviewed commit;
- whole-review preparation, and the check that it produced a review for the reviewed commit;
- the blocked explanation.

Assessment then applies the two pre-send checks that the publication core runs before its state record: the prepared-review shape check and the authenticated-user lookup. Assessment stops there. It computes no input fingerprint, does not recover existing state, claims no intent and sends nothing. There is no second implementation of any readiness rule, so a rule added to publication applies to assessment automatically.

## Decisions awaiting acceptance

Each of these is adopted provisionally in the conservative form stated. Changing one before release is a contract change to this document and its tests.

1. **The incomplete status is spelled `incomplete`.** The design text said only "an assessment that could not be completed". A single word matches `ready` and `blocked`, and `status === 'incomplete'` reads plainly. The alternative, `assessment-incomplete`, is more explicit but inconsistent with the other statuses.
2. **Operational failures are an outcome, not a rejection.** The design requires JSON to distinguish the three results, and a library caller should see the same three. Only caller misuse (`TypeError`) and defects in the package itself reject, as they do for the publisher. The alternative, rejecting as `publishSarifReview` does, would make the library and CLI disagree about what `incomplete` is.
3. **`blocked` adds `problems`.** The publisher's `blocked` has only `markdown`. Assessment exists to give reasons to agents, and `IProblem` is an existing public shape without codes (D13). The alternative, Markdown only, would force agents to parse Markdown.
4. **Exit statuses 0 / 2 / 1.** `blocked` keeps publication's 2. `incomplete` uses 1, like every other failure to reach a verdict, because the JSON `status` already distinguishes it. The alternative, a distinct status such as 3, would reuse a code that means "uncertain: retry with the same state" for `publish`. That is a different recovery instruction.
5. **`statePath` and `--state` are refused, not ignored.** Silently accepting them could suggest that assessment reserves or checks a publication identity. The alternative, accepting and ignoring them, would let one input object serve both calls, at the cost of that confusion.
6. **No pending-review pre-check.** GitHub's one-pending-review refusal is detected by publication only through the create request. Adding a read-side check only to assessment would make its verdict disagree with publication's own checks. `ready` Markdown names this limit instead.
