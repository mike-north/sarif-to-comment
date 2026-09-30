# Immediately submitted reviews: contract

Accepted by the owner · September 29, 2026 ([D38](design-decisions.md#d38-submit-a-review-only-on-explicit-request-as-a-comment--owner-accepted), [issue #24](https://github.com/mike-north/sarif-to-comment/issues/24)), as merged in [PR #17](https://github.com/mike-north/sarif-to-comment/pull/17). First proposed September 28, 2026. The owner accepted explicit opt-in (`options.submit` / `--submit`), a draft when the option is omitted, `COMMENT` as the only submitted event, and the mode bound to the publication's durable state and recovery.

**Sources.** [Issue #7](https://github.com/mike-north/sarif-to-comment/issues/7); [D16, D26 and D29](design-decisions.md); [specification](specification.md) R1, R13, R14 and open contract O6; the publication core (`src/publication.cts`) and its README contract.

## 1. What is fixed by the sources

- The caller chooses between a draft (pending) review and an immediately submitted review (D16, R13).
- When the choice is omitted, the review stays a draft; submission requires an explicit caller choice (D26, R13). Today's draft behaviour is the omitted-option behaviour, unchanged.
- The review event is never inferred from a finding's severity or source (R1).
- Whole-review readiness, approval holds and exact reviewed-commit targeting apply to both modes (D12, D16, R13). Submitted mode is not a bypass.
- This is an initial-publication option only. It never submits, updates or maintains an existing draft, and recovery never becomes maintenance (D29, issue #7 scope).

## 2. Decisions

### 2.1 Event: `COMMENT` only (accepted)

| Option | Problem |
| --- | --- |
| A. `COMMENT` only (**accepted**) | None found. It is the only event that states no verdict, and GitHub accepts it on a review of one's own pull request. |
| B. Caller-selected `APPROVE` / `REQUEST_CHANGES` / `COMMENT` | A verdict is a human act of approval or blocking. The sources settle only publication mode, not verdict authority; `APPROVE` and `REQUEST_CHANGES` are also refused by GitHub on one's own pull request, so they would add a failure mode for no stated need. |
| C. Event derived from severity (errors → `REQUEST_CHANGES`) | Forbidden by R1. |

A later explicit verdict option, if the owner wants one, would be a separate, additive option. It would not change the meaning of the option below.

### 2.2 Option name

| Option | Assessment |
| --- | --- |
| `options.submit: true` / `--submit` (**accepted**) | Matches the existing vocabulary: options are booleans named for what they do (`ignoreApprovalHold` / `--ignore-approval-hold`). It says exactly what differs from the default. |
| `options.mode: 'draft' \| 'submitted'` | Equally clear, but introduces a second style of option and a value (`'draft'`) that only restates the default. |
| `options.event: 'COMMENT'` | Mirrors GitHub, but invites `APPROVE`, which 2.1 declines, and names the transport rather than the caller's intent. |

`submit` accepts only a boolean. `submit: false` and an omitted `submit` both mean draft and are indistinguishable everywhere, including the state record. `validateSarifReview` accepts the same option, because it takes publication's options.

### 2.3 The request

Draft (omitted option), unchanged byte for byte:

```json
{ "commit_id": "<reviewed commit>", "body": "<body>\n\n<marker>", "comments": [ … ] }
```

Submitted:

```json
{ "commit_id": "<reviewed commit>", "body": "<body>\n\n<marker>", "event": "COMMENT", "comments": [ … ] }
```

The body, marker, inline comments and `commit_id` are identical in both modes. Only `event` differs. It is still exactly one create-review request, never a create followed by a submit.

### 2.4 Mode is part of the durable identity

The saved request in the state record is the record of what was sent, so the mode is stored there: a submitted publication's `request` carries `"event": "COMMENT"`, and a draft's `request` has no `event` key. Because `requestFingerprint` covers the whole request, the mode is also covered by the record's integrity check.

A record is a draft record exactly when its request has no `event` key. Every state file written by 0.2.x therefore reads as a draft record, unchanged. The record `version` stays `1`, and draft records are byte-for-byte what 0.2.x writes.

Reusing a state path with the other mode is refused before any network request, with a local `state-mismatch` error:

> Publication state at `/…/review.json` records a draft review, but a submitted review was requested. A publication's mode is fixed when it starts: retry with the mode it started with, or use a new state path for a separate review.

(and the converse, "records a submitted review, but a draft review was requested"). This applies to every phase, including completed and rejected records, so a retry can never quietly turn into a different kind of publication. The mode is not added to the input fingerprint: the fingerprint identifies the input's content, and the saved request already binds the mode.

The only `event` value a record may hold is `"COMMENT"`. Any other value, or an `event` key that is not a string, makes the record corrupt (fail closed, never sent).

**Downgrade.** A 0.2.x reader refuses a submitted record as corrupt (its saved request has an unexpected field). It sends nothing and never mistakes the record for a draft.

### 2.5 Delivery evidence and recovery

Recovery is the same in both modes: it enumerates every review on the pull request, finds the single review carrying the record's marker, and verifies author id, reviewed commit, the exact body and every inline comment. A submitted review is visible in that enumeration like any other review, so a lost create response is recovered by marker and never re-sent.

One check is added for submitted mode only: the candidate's state must be `COMMENTED`. A review carrying the marker that is still `PENDING` (or in any other state) is not the intended contribution and is reported as `uncertain` (`candidate-mismatch`), never submitted or repaired. `COMMENTED` reviews cannot be dismissed or returned to pending, so this check has no human-change false positive.

Draft mode keeps its existing rule: the state is not compared, so a draft a person has since submitted still confirms the initial delivery.

### 2.6 Readiness and host refusals

- `validate` / `validateSarifReview` runs exactly the same checks in both modes. There is no mode-specific readiness rule: neither the SARIF nor the pull request is judged differently for a submitted review.
- GitHub refuses a create when the account already has a pending review on the pull request (HTTP 422, "User can only have one pending review per pull request"). The refusal applies to a submitted create too (observed live, [evidence](submitted-review-e2e-evidence.md) step 3). It is a definitive refusal: recorded, never resent, and reported as `rejected` with the existing advice. The tool never submits or deletes the existing draft to make room. `validate` reports a pending review of the account as `blocked` in both modes ([readiness contract](readiness-assessment-contract.md#pending-review-of-this-account), [#23](https://github.com/mike-north/sarif-to-comment/issues/23)); publication still meets the condition only as this refusal.
- In submitted mode the ready explanation says what would be created: "The complete document can be published faithfully to o/r#n at commit \`…\` as a submitted comment review." The draft explanation is unchanged.

### 2.7 Outcomes and exit statuses

The outcome shapes, statuses and CLI exit statuses are unchanged. Only the published explanation differs:

| Mode | Heading | Created |
| --- | --- | --- |
| draft | `## Draft review published` | `Created the draft [review N](url) on o/r#n at commit \`…\`. It stays a draft until someone submits it on GitHub.` |
| submitted | `## Review submitted` | `Created and submitted the comment [review N](url) on o/r#n at commit \`…\`. It is visible on the pull request now.` |

The recovered and receipt forms change "draft" to "submitted comment" in the same way.

## 3. Worked examples

1. `publishSarifReview({ …, statePath })` → one request without `event`; state record identical to 0.2.x; outcome "Draft review published".
2. `publishSarifReview({ …, statePath, options: { submit: true } })` → one request with `"event": "COMMENT"`; readback confirms state `COMMENTED`; record request holds `"event": "COMMENT"`.
3. Example 2, but the create response is lost. The retry with the same state path and `submit: true` finds the `COMMENTED` review by its marker, records the receipt and sends nothing.
4. Example 2's state path retried without `submit` → `state-mismatch` ("records a submitted review, but a draft review was requested"), no request.
5. A 0.2.1 draft state file retried with `submit: true` → `state-mismatch` ("records a draft review, but a submitted review was requested"), no request.
6. A held document with `submit: true` → `blocked`, nothing written; with `ignoreApprovalHold: true` as well → submitted.
7. CLI: `sarif-to-comment publish … --state /abs/state.json --submit` and `sarif-to-comment validate … --submit`.

## 4. Out of scope

Submitting, updating or deleting an existing draft; `APPROVE` and `REQUEST_CHANGES`; changing an earlier publication's mode; suggestion pull requests.
