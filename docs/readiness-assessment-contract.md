# Readiness assessment contract

Contract · September 28, 2026; decisions accepted September 29, 2026. This document specifies the optional whole-review readiness assessment. The [interface design](second-milestone-interface-design.md#deferred-standalone-validation-versus-inspection) deferred it, and D30 records it as user-requested. The command and function names come from that design. The input, outcomes and exit statuses below were first adopted provisionally. On September 29, 2026 the owner accepted the `ready` / `blocked` / `incomplete` outcomes, problem reporting, exit statuses, stateless operation and publication-time recheck ([#24](https://github.com/mike-north/sarif-to-comment/issues/24)). The owner also required one addition, a check for a pending review of the authenticated account ([#23](https://github.com/mike-north/sarif-to-comment/issues/23)), which replaces the provisional decision not to look for one. That check is specified in [Pending review of this account](#pending-review-of-this-account). See [Decisions](#decisions).

## Purpose

Assessment answers one question: can this complete SARIF artifact be published faithfully to this pull request, at this reviewed commit, under this policy? It is optional and never a workflow gate. It is not inspection. Inspection shows what a document contains and needs no destination. Assessment needs the destination and a credential, and it applies the publisher's own readiness rules:

- the SARIF 2.1.0 schema;
- the approval hold and its override (R11);
- source consistency against the reviewed snapshot (R3);
- supported representation and host constraints, including placement and native-suggestion eligibility (R7, R8);
- product limits;
- the pull-request context check that the publisher applies before any write (R12, R13);
- the publisher's own pre-send checks: the prepared review's shape and the authenticated account's numeric identity;
- a known host obstacle to the create request: a pending review of the authenticated account on the pull request (see [Pending review of this account](#pending-review-of-this-account)).

It performs the publisher's checks by running the publisher's code, not a copy of it (see [Shared checks](#shared-checks)).

## Guarantees

- **No remote writes.** Assessment uses only GitHub reads: the pull request, its files, the comparison, Git objects, the authenticated user and the pull request's review list. It never creates, submits, edits or deletes a review.
- **No durable state.** Assessment takes no state path and never creates, reads or changes a publication state file. It writes no file of any kind.
- **No approval stamp.** A `ready` outcome carries no token, fingerprint or identifier that publication accepts. Publication has no input for one; unknown fields are refused. `publish` performs every check itself, against the pull request as it is at that moment.
- **Not a delivery promise.** `ready` does not mean that delivery will succeed. The pull request can change after assessment; for example, a pending review of the account can be started before publication. GitHub can also refuse the create request for reasons that only the write reveals. Delivery recovery questions are answered only by the publication state contract.
- **Credential safety.** As for publication, the token never appears in an outcome, its Markdown or a rejection.

## Library

```ts
validateSarifReview(input: IValidateSarifReviewInput): Promise<ValidateSarifReviewOutcome>
```

The input is exactly the publisher's input without `statePath`: `sarif`, `destination`, `reviewedCommit`, `token`, and optionally `sourceRootUri`, `oldSourceCommit` and `options.ignoreApprovalHold`. It is validated and captured exactly as `publishSarifReview` captures it. Invalid input rejects with a `TypeError` before any request. `statePath` is an unknown field and is refused, so an input is never mistaken for a publication.

| `status` | Meaning | Fields |
| --- | --- | --- |
| `ready` | Publication would proceed to its single create request, and the account has no pending review on the pull request. | `markdown` |
| `blocked` | Publication would return `blocked`, or GitHub would refuse its create request because the account already has a pending review on the pull request. | `problems` (each a message with a JSON Pointer when the problem is in the document), `markdown` |
| `incomplete` | The assessment could not be completed, so this is no verdict. Examples: authentication failure, network failure, source-read failure, a pull request that does not match the requested destination and commit, an account without a numeric user id, or a review list that could not be read completely or leaves the answer undecided. | `markdown` |

For a document that publication would block, `blocked` Markdown is identical to publication's `blocked` Markdown for the same input and pull-request state. The pending-review blocker uses the same presentation (see [Pending review of this account](#pending-review-of-this-account)). `problems` carries the same blockers as the Markdown, without internal codes (D13). An operational failure is reported as `incomplete`, never thrown and never `ready`. Operational failures are those the GitHub client reports (HTTP, network, authentication, source reads, the review list), its answer that the account has no numeric id, context for another pull request or commit, and a review list that is incomplete or undecided. Any other failure after input capture is a defect in the package or its client boundary, such as an internal invariant or a client answer outside its contract. It rejects, as it does for `publishSarifReview`, rather than being presented as a transient condition with retry advice.

## Pending review of this account

GitHub lets an account hold one pending review per pull request, and it refuses to create another review while that one exists: HTTP 422, "User can only have one pending review per pull request". The refusal applies to a draft create and to a submitted (`COMMENT`) create alike. Both were observed live: the second draft in the [native suggestion fidelity experiment](native-suggestion-fidelity-experiment.md), and the submitted create in step 3 of the [submitted-review evidence](submitted-review-e2e-evidence.md). So the check applies in both modes, and `options.submit` does not change its verdict.

- **What is read.** Every page of the review list of the exact destination pull request (`GET /repos/{owner}/{repo}/pulls/{number}/reviews`), through the client's validated pagination. It is read after the authenticated-user check and only when the document is otherwise ready. When publication would block the document, that block is the verdict, reported exactly as publication reports it, and the review list is not read.
- **Who.** A review's author is compared with the authenticated account by stable numeric user id only. Logins can change and are never compared.
- **`blocked`.** Only for a review in state `PENDING` whose author id is the account's. There is one problem per such review, without a pointer, because the obstacle is not in the document. It names the pull request and the review's id and URL, says that GitHub would refuse the review in either mode, and says what to do. A person submits or deletes that pending review on GitHub; the tool never submits, edits or deletes it. If it is this tool's own earlier publication, the caller retries `publish` with that publication's state path instead.
- **Ignored.** Pending reviews by other accounts, and submitted reviews (`COMMENTED`, `APPROVED`, `CHANGES_REQUESTED`, `DISMISSED`) by every account, including the authenticated one.
- **`incomplete`, never `ready` or `blocked`.** A review list that cannot be read completely: a failed or refused page, a malformed page, or pagination that repeats a cursor or exceeds its limit. This applies even when an earlier page showed a pending review of the account. Nothing is inferred from a partial list.
- **Duplicate or ambiguous host data.** The list is checked in two steps.
  1. **The list itself.** A review listed more than once counts once when every listing has the same author and state. A listed review without a numeric id, or one review listed with different authors or states, makes the list `incomplete` before any review is judged, even beside a pending review of the account.
  2. **Each review.** In a list that passes step 1, one unambiguous pending review of the account is `blocked`, because it alone means GitHub would refuse the review. Only when there is none, a review that could be the account's pending review but cannot be shown to be makes the list `incomplete`. That is a review without a numeric author id that is not in a submitted state, or one of the account's own reviews in a state GitHub does not document.
- **Still stateless.** The check needs no state path and generates no publication marker. It does not read back any review's comments, and it does not match a review against a publication. A pending review that carries this tool's publication marker is treated like any other pending review of the account: it blocks. Proving that a remote review is a persisted publication stays the job of publication retry and recovery, which read the state path.

Publication itself is unchanged. It does not read the review list before its create request. It meets the same condition as GitHub's refusal of that request, reported as `rejected` and recorded against its state path. So `validate` can be `blocked` where a `publish` of the same input would be `rejected`, and a review-list read failure makes `validate` `incomplete` where `publish` would still send its create request and leave the question to GitHub.

The check was verified live against GitHub on September 29, 2026: `blocked` naming an existing pending review, in both modes, and `ready` beside submitted reviews of the same account. See the [pending-review check evidence](pending-review-check-e2e-evidence.md).

## CLI

```
sarif-to-comment validate --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA
                          [--source-root ABSOLUTE_FILE_URI] [--old-source-commit FULLSHA]
                          [--ignore-approval-hold] [--format human|json]
```

- It takes the publish flags except `--state`, which is refused as an unknown option. `--submit` keeps the pending-review check, since GitHub refuses a submitted review the same way.
- The token comes from `GH_TOKEN`, else `GITHUB_TOKEN`, as for `publish`.
- Human mode prints the library Markdown to stdout for every library outcome. As for `publish`, usage and operational errors go to stderr.
- JSON mode prints one document: `{ command: "validate", status, problems?, message }`. `status` is `ready`, `blocked` or `incomplete`. Errors detected before the library runs use the existing `error` and `usage-error` documents: an unreadable SARIF file, a missing token, or a library `TypeError` (`error`), and invalid arguments (`usage-error`).

| Exit | Meaning |
| --- | --- |
| 0 | ready |
| 2 | blocked, including a pending review of the account |
| 1 | incomplete, usage error, or operational error |

## Worked examples

The pull request `acme/gizmos#7` changes `src/app.js`, and its head is the reviewed commit `2222…`.

1. **Ready.** The SARIF has one general finding and one finding on line 4, which is in the diff. `validate` exits 0 with `status: "ready"`. The Markdown reports one inline comment and one general section for commit `2222…`. It also says that nothing was published or written, and that publication repeats every check. The fake host records no create request, and no state file exists.
2. **Blocked (approval hold).** The same finding carries `properties.sarifToComment.approval: "awaiting-approval"`. `validate` exits 2 with `status: "blocked"`. Its one problem points at `/runs/0/results/0`, and the Markdown is exactly what `publish` would print. With `--ignore-approval-hold`, the result is `ready`.
3. **Blocked (source inconsistency).** A finding's region snippet is `const MIN = 1;`, but line 4 of `src/app.js` at `2222…` is `const MAX = 100;`. The result is `blocked`, for the same reason that `publish` gives.
4. **Incomplete (authentication).** GitHub answers 401 to the pull-request read. `validate` exits 1 with `status: "incomplete"`. The Markdown names the failure (with the token redacted) and says that this is not a verdict. It is never `ready`.
5. **Incomplete (source read).** The pull request is readable but a source blob read fails. The result is `incomplete`, and `publish` would reject at the same point without writing.
6. **Remote context changes.** `validate` reports `ready` for a finding with a suggested fix on line 4. The author then pushes, so the pull request's head advances past the reviewed commit. A later `publish` fetches the context again and finds that the fix can no longer be a native suggestion on the current diff. Publication returns `blocked`: the earlier `ready` authorizes nothing.
7. **Blocked (pending review of this account).** The document of example 1 is ready, but the authenticated account (numeric id 7001001) has a pending review, 1001, on `acme/gizmos#7`. `validate` exits 2 with `status: "blocked"`, with or without `--submit`. Its one problem, without a pointer, names review 1001 and its URL and says that GitHub would refuse the review as a draft or as a submitted comment review. A `publish` of the same input would send its create request, and GitHub would refuse it with 422: `rejected`. Nothing is written by `validate`.
8. **Ready despite other reviews.** Another account has a pending review on the pull request, and the authenticated account has a submitted comment review there. Both are ignored, and `validate` exits 0.
9. **Incomplete (review list).** The first page of reviews is readable, but GitHub answers 403 for the second. `validate` exits 1 with `status: "incomplete"`, even if the first page showed a pending review of the account. It is never `ready` or `blocked` from a partial list.

## Shared checks

Publication and assessment call the same private functions for everything that precedes the publication identity:

- input validation and capture;
- the GitHub client's context fetch and its verification against the requested pull request and reviewed commit;
- whole-review preparation, and the check that it produced a review for the reviewed commit;
- the blocked explanation.

Assessment then applies the two pre-send checks that the publication core runs before its state record: the prepared-review shape check and the authenticated-user lookup. It computes no input fingerprint, does not recover existing state, claims no intent and sends nothing. There is no second implementation of any readiness rule, so a rule added to publication applies to assessment automatically.

The [pending-review check](#pending-review-of-this-account) is assessment's own. It is not a copy of a publication rule: publication has no read-side check for it and learns of it only from GitHub's refusal of its create request. Assessment reads the review list with the client's own paginated enumeration, the one publication recovery uses, and compares authors by the numeric id from the same authenticated-user lookup.

## Decisions

Decisions 1–5 were proposed provisionally and accepted by the owner on September 29, 2026 ([#24](https://github.com/mike-north/sarif-to-comment/issues/24)): the outcomes, problem reporting, exit statuses, stateless operation and publication-time recheck. Decision 6 was replaced by the owner's requirement in [#23](https://github.com/mike-north/sarif-to-comment/issues/23). The proposals are kept as written, with their rationale. Changing one is a contract change to this document and its tests.

1. **The incomplete status is spelled `incomplete`.** The design text said only "an assessment that could not be completed". A single word matches `ready` and `blocked`, and `status === 'incomplete'` reads plainly. The alternative, `assessment-incomplete`, is more explicit but inconsistent with the other statuses.
2. **Operational failures are an outcome, not a rejection.** The design requires JSON to distinguish the three results, and a library caller should see the same three. Only caller misuse (`TypeError`) and defects in the package itself reject, as they do for the publisher. The alternative, rejecting as `publishSarifReview` does, would make the library and CLI disagree about what `incomplete` is.
3. **`blocked` adds `problems`.** The publisher's `blocked` has only `markdown`. Assessment exists to give reasons to agents, and `IProblem` is an existing public shape without codes (D13). The alternative, Markdown only, would force agents to parse Markdown.
4. **Exit statuses 0 / 2 / 1.** `blocked` keeps publication's 2. `incomplete` uses 1, like every other failure to reach a verdict, because the JSON `status` already distinguishes it. The alternative, a distinct status such as 3, would reuse a code that means "uncertain: retry with the same state" for `publish`. That is a different recovery instruction.
5. **`statePath` and `--state` are refused, not ignored.** Silently accepting them could suggest that assessment reserves or checks a publication identity. The alternative, accepting and ignoring them, would let one input object serve both calls, at the cost of that confusion.
6. **No pending-review pre-check.** *Superseded.* GitHub's one-pending-review refusal is detected by publication only through the create request. Adding a read-side check only to assessment would make its verdict disagree with publication's own checks. `ready` Markdown named this limit instead. The owner required the check instead ([#23](https://github.com/mike-north/sarif-to-comment/issues/23)). Reported by assessment, the obstacle is known before a `publish` spends a state path on GitHub's refusal. It is specified in [Pending review of this account](#pending-review-of-this-account), including where assessment and publication now report the same condition differently.
