---
"sarif-to-comment": minor
---

**Create a submitted comment review when you ask for one.** `--submit` on `publish` and `validate`, or `options.submit: true` in `publishSarifReview` and `validateSarifReview`, creates the review already submitted with GitHub's `COMMENT` event, in the same single create request. The tool never approves or requests changes, and infers nothing from finding severity. Validation, approval holds and the reviewed commit apply unchanged. Without the option, the review is a draft, exactly as in 0.2.1.

The mode is recorded in the state file: a state path is retried only in the mode it started with (the other mode is refused before any request), and a lost response is confirmed by finding the submitted review by its marker, without sending again. A submitted publication is confirmed only when GitHub reports the review as `COMMENTED`. State files written by 0.2.1 read as drafts.
