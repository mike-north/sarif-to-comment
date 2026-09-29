---
"sarif-to-comment": minor
---

Create an immediately submitted comment review when you ask for it explicitly: `options.submit: true` in `publishSarifReview` and `validateSarifReview`, or `--submit` on `publish` and `validate`. The review is sent in the same single create request with GitHub's `COMMENT` event added; the tool never approves or requests changes and infers nothing from finding severity. Whole-review validation, approval holds and the reviewed commit apply unchanged. Omitting the option keeps today's draft review, request and state file byte for byte. The mode is recorded in the state file: a state path is retried only in the mode it started with (the other mode is refused before any request), a lost response is confirmed by finding the submitted review by its marker without sending again, and state files from earlier versions read as drafts. A submitted publication is confirmed only when GitHub reports the review as `COMMENTED`.
