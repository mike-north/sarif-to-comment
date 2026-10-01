# Observed GitHub behavior

This is the project's starting point for questions about what GitHub actually does. It consolidates existing experiments so that established observations do not have to be rediscovered in a conversation. Seeded September 30, 2026 from the reports and evidence below; no new experiment was performed to create this register. GH-14 was added the same day from the existing force-push report.

An observation establishes the recorded case, with its conditions. It is not a universal guarantee, an implementation requirement, or proof that this library currently supports the behavior. GitHub documentation describes advertised behavior; keep it distinct from observed outcomes, especially when the two appear to disagree. Product choices belong in the [decision log](design-decisions.md).

## How to use and maintain this record

- Read the applicable observation and its evidence before recommending another experiment or making a host-capability claim.
- Match the actual operation and conditions. For closing references, distinguish the PR containing the reference from the PR being closed, and record both base branches.
- Retain established results when a related case is untested. Identify the new variable rather than treating the old result as unknown.
- Add future authorized observations with the date, fixture, action, outcome, evidence links and limits. Keep stable observation IDs and preserve original evidence rather than overwriting it.
- Record documentation, inference, local projections and proposed experiments as such. Rendered previews, successful API creation, and exact applied file bytes establish different things.

Most seeded observations used one authenticated account and synthetic, same-repository PRs in `mike-north/doc-linter` during September 27–28, 2026. Each entry identifies exceptions and evidence limits. Existing reports remain the detailed records; this register is their lookup and scope map.

## Companion PRs and closing references

### GH-01 — A closing reference can close another PR without merging it

**Observed:** Merging an original PR containing a closing reference to its companion automatically closed that companion **without merging the companion**. Companion-only content did not enter the default branch.

**Exact case:** [Experiment: merge original with an unmerged suggestion](https://github.com/mike-north/doc-linter/pull/5) targeted `main` and contained `Closes #6`. [Experiment: unmerged suggestion when original merges](https://github.com/mike-north/doc-linter/pull/6) targeted the original's feature branch. The original merged; the companion closed unmerged. Its timeline records closure through the original PR.

**Evidence:** [Lifecycle report](companion-pr-lifecycle-experiment.md), [before](evidence/suggestion-lifecycle/sarif-lifecycle-merge-before.json), [after](evidence/suggestion-lifecycle/sarif-lifecycle-merge-after.json), [companion before](evidence/suggestion-lifecycle/sarif-lifecycle-merge-suggestion-before.json). Original references are preserved in the report and were confirmed by existing live readback during the September 30 discussion. The historical JSON snapshots retain branch/state information but not bodies.

**Limits:** The PR being merged targeted the default branch. The referenced PR targeted a feature branch, which did not prevent its closure. This does not establish sibling closure when the **referencing, merged PR** itself targets a feature branch. A recorded `willCloseTarget: false` did not predict the later observed closure; do not use that field as an established predictor.

### GH-02 — Closing the original without merging left its companion open

**Observed:** Closing an original PR without merging did not close its referenced companion, despite a closing reference in the original's body. The companion remained open in immediate and later readbacks. Subsequent manual cleanup is a separate action.

**Exact case:** [Experiment: close original with an unmerged suggestion](https://github.com/mike-north/doc-linter/pull/7) targeted `main` and contained `Closes #8`. [Experiment: unmerged suggestion when original closes](https://github.com/mike-north/doc-linter/pull/8) targeted the original feature branch. Both ultimately appear closed because the companion was cleaned up afterward; its current state alone does not show the immediate outcome.

**Evidence:** [Lifecycle report](companion-pr-lifecycle-experiment.md), [before](evidence/suggestion-lifecycle/sarif-lifecycle-close-before.json), [immediate result](evidence/suggestion-lifecycle/sarif-lifecycle-close-after.json), [settled result](evidence/suggestion-lifecycle/sarif-lifecycle-close-settled.json).

**Limits:** Same-repository fixture with automatic branch deletion disabled. Branches remained. This is the observed motivation for abandonment cleanup; it is not evidence that an optional GitHub Action has been tested.

### GH-03 — Accepting a companion incorporated its complete patch into the original branch

**Observed:** Squash-merging the companion added both proposed files in one commit. The complete resulting tree matched the companion head; the original PR stayed open and `main` stayed unchanged. An ordinary body backlink produced a discoverable cross-reference carrying the companion's suggestion label.

**Exact case and evidence:** Original [grouped acceptance fixture](https://github.com/mike-north/doc-linter/pull/3), [companion fixture](https://github.com/mike-north/doc-linter/pull/4), and [grouped-suggestion report](grouped-suggestion-experiment.md), which retains PR and commit links.

**Limits:** Same repository and single-page discovery. This proves the tested acceptance path, not enforced all-or-none human behavior, independent correctness, fork permissions, branch protection, or sibling closing references.

## Reviews, placement and readback

### GH-04 — Tested inline placements were accepted, including unchanged context

**Observed:** The placement fixture accepted LEFT unchanged context, RIGHT unchanged context, a LEFT deletion, a RIGHT addition and multiline RIGHT context. Later real product publication and browser inspection preserved the expected original anchors and comment text.

**Evidence:** [Placement report](placement-host-probe.md), [raw accepted threads](evidence/placement-host-probe/valid-batch-threads.json), [product readback](evidence/milestone-e2e/pr14-readback-04-cli-final.json), [browser evidence index](evidence/milestone-e2e/README.md).

**Limits:** LEFT-context acceptance is an observed case, not an established portable host contract. The placement-only fixture had no browser verification. This does not establish newly created inline comments against historical/discarded commits.

### GH-05 — The tested invalid batch created no partial review

**Observed:** A request containing a valid first comment followed by invalid line 999 returned HTTP 422. Subsequent reads found no review or threads. The real adapter repeated this validation-refusal case.

**Evidence:** [Product publication report](milestone-e2e-evidence.md), [invalid-anchor control](evidence/milestone-e2e/control-invalid-anchor.json), [after-control readback](evidence/milestone-e2e/pr15-readback-01-after-control.json).

**Limits:** This establishes the tested validation refusals, not transaction atomicity under network/server failure.

### GH-06 — A second pending review by the same author was refused

**Observed:** On the same PR, the same author attempted to create a second pending review and received HTTP 422; no second draft was created.

**Evidence:** [Fidelity report](native-suggestion-fidelity-experiment.md), [second-pending response](evidence/native-fidelity-probe/pending-second-response.json).

**Limits:** Exact same-PR/same-author case. It does not justify blocking based on another author's draft or a draft on another PR.

### GH-07 — Original anchors were more useful than some REST current-location fields

**Observed:** Per-review REST comment readback exposed positions while returning null line/side/original-line fields in the recorded pending and submitted cases. GraphQL original-location fields retained exact anchors. A single-line original start could be null even when current start fields were synthesized. After head advancement, current anchors shifted while the original anchors and review commit remained pinned.

**Evidence:** [Application/readback report](suggestion-application-e2e.md), [submitted readback](evidence/suggestion-application/raw/pr16-readback-03-suggestions-submitted.json), [head-advancement report](milestone-e2e-evidence.md), [after advancement](evidence/milestone-e2e/pr15-readback-05-after-head-advance.json).

**Limits:** Readback shapes from these fixtures. The attempted base-advancement case did not produce a different `base.sha`; that variant was not observed. Persistence of existing comments does not prove eligibility for creating new historical comments.

## Native suggestions and literal content

### GH-08 — The tested native replacements reproduced exact intended bytes

**Observed:** Applied native suggestions reproduced ordinary LF replacement, multiline replacement, an LF payload on CRLF source, a final-line replacement without a newline, and a final-line deletion with a newline in the fidelity fixture. Product-generated one-line-to-three, two-lines-to-one and middle-line deletion were independently applied and compared by exact file bytes. Later fixtures reproduced staged LF replacements, insertion before a line, and EOF append.

**Evidence:** [Fidelity report](native-suggestion-fidelity-experiment.md), [fidelity file comparisons](evidence/native-fidelity-probe/applied-files.json), [product application report](suggestion-application-e2e.md), [product file comparisons](evidence/suggestion-application/applied-files.json), [second-milestone report](second-milestone-e2e-evidence.md), [insertion application record](evidence/second-milestone/native-application.json).

**Limits:** Only the recorded text/line-ending shapes. The fidelity fixture batched nine suggestions into one commit; product application also used individual native commits. These runs did not publish whole-file creations/deletions.

### GH-09 — Some rendered suggestions applied different bytes than their preview implied

**Observed in the fidelity fixture:**

| Tested shape | Applied result |
|---|---|
| CRLF in the suggestion payload | Inserted doubled carriage returns. |
| Blank-only replacement | Deleted the selected content rather than inserting the intended blank content. |
| Four-backtick suggestion containing a nested fence | Preview rendered, but application deleted the selected content. |
| Deleting the final line of a file without a trailing newline | Also removed the preceding separator. |

**Evidence:** [Fidelity report](native-suggestion-fidelity-experiment.md), [intent](evidence/native-fidelity-probe/intent.json), [applied comparisons](evidence/native-fidelity-probe/applied-files.json).

**Limits:** These failures explain particular product safeguards; the safeguards themselves are not GitHub facts. Correct visual rendering does not prove native application fidelity.

### GH-10 — Tested review bodies retained their literal content

**Observed:** Inline-only/general bodies read back as expected, including quoted CRLF text. Body fidelity is separate from the suggestion-application behavior in GH-08/GH-09.

**Evidence:** [Application report](suggestion-application-e2e.md), [literal-body readback](evidence/suggestion-application/raw/pr16-readback-01-crlf.json).

### GH-11 — A longer ordinary Markdown fence rendered embedded backticks literally

**Observed September 29:** An issue body with an outer fifteen-backtick fence contained a triple-backtick example and a fourteen-backtick line. Recorded browser readback reported the expected text present and one code block.

**Evidence:** [Existing rendering fixture](https://github.com/mike-north/sarif-to-comment/issues/22), [extracted historical readback](evidence/github-behavior/dynamic-fence-readback.json).

**Limits:** Ordinary issue-body rendering, not native suggestion application. A separate attempted private PR browser opening returned a logged-out 404 and supplied no rendered proof. Do not treat this successful Markdown case as contradicting GH-09's application failure.

## Other observed host workflows

### GH-12 — Successful creations could be rediscovered by persisted markers

**Observed:** Distinct markers survived companion-PR and pending-review creation. After successful creation output was intentionally discarded, cross-reference/body lookup recovered the unlabeled companion and review listing recovered the marked pending review with its expected comment. Completing the label/body link reused the same objects; no second creation occurred.

**Evidence:** [Recovery report](publication-recovery-experiment.md) and its [saved intent](evidence/publication-recovery/sarif-recovery-intent.json), [companion discovery](evidence/publication-recovery/sarif-recovery-suggestion-discovered.json), [review recovery](evidence/publication-recovery/sarif-recovery-review-recovered.json), [repeat companion lookup](evidence/publication-recovery/sarif-recovery-suggestion-repeat.json), [repeat review lookup](evidence/publication-recovery/sarif-recovery-reviews-repeat.json).

**Limits:** Client-side suppression of a genuine successful response, not an observed transport outage. Delayed visibility, concurrency, real crash/restart, and multi-page discovery were not proven by this experiment.

### GH-13 — A bounded GitHub new-file URL prefilled path and content

**Observed in the recorded browser report:** A 270-character branch-based URL prefilled a nested file path and 126 UTF-8 bytes. The commit dialog offered direct-branch and new-branch choices; it was canceled. An 8,339-character URL was rejected as too long, and a commit-ID route returned not-found.

**Evidence:** [New-file representation research](new-file-representation-research.md).

**Limits:** Reported browser observations, with no separately retained raw artifact identified. No committed-byte proof, universal URL threshold, fork/protection coverage, or verified direct-deletion action link.

## Force-pushes and rewritten history

### GH-14 — Reviews survived force-pushes; a companion built on a discarded commit carried that commit

**Observed September 29, 2026:** Draft PRs [#41](https://github.com/mike-north/doc-linter/pull/41)–[#52](https://github.com/mike-north/doc-linter/pull/52), with sarif-to-comment at `6dade45`. Each variant had its own fixture base branch, and `main` was untouched. In every variant the reviewed commit changed lines 5 and 6 of a 20-line Markdown file. Each review had a comment on line 5 and a native suggestion on line 6.

- **Existing reviews survived.** The variants were an amend (#41, pending review), a rebase onto an advanced base (#42, submitted comment review) and an ordinary push (#44, control). Each review stayed listed, and its `commit_id` stayed the reviewed commit. Comments on unchanged lines moved to the new head and were not outdated; a force-push and an ordinary push behaved the same. A second rewrite dropped the line-5 change. The line-5 comment then became outdated (`line: null`, `commit_id` frozen at the last head where it applied), and the line-6 comment moved to the new head. The native suggestion's body was intact.
- **Discarded commits stayed reachable.** From a fresh repository, `git fetch --depth=1 <sha>` succeeded for all three discarded reviewed commits, and GitHub's file and compare reads served them.
- **A body-only review at a discarded commit was accepted silently.** On #43, after the force-push, GitHub accepted a new pending review whose `commit_id` was the discarded reviewed commit, while the PR's only commit was the new head. It gave no warning, and the body's blob links resolved. The review had no inline comments. sarif-to-comment had rendered its findings as body sections and refused a native suggestion there (`suggestion-historical-unsupported`); that is tool behavior, not a host observation.
- **The base of a companion PR changed what GitHub showed.** Each companion's single commit had the reviewed commit as its parent.
  - Where the reviewed commit was still an ancestor of the target head (#49, #50), GitHub listed only the proposal commit, showed +1 −1 and reported the PR MERGEABLE.
  - Where it had been discarded (#45–#48, #52), GitHub listed the discarded commit as one of the companion's commits. It measured the diff from the old merge base, so the discarded change reappeared beside the real edit (+2 −2 or +3 −3).
  - GitHub reported #45 and #47 CONFLICTING, and #46, #48 and #52 MERGEABLE, with no sign that anything was stale. After the second rewrite, #45–#48 were all CONFLICTING.
- **A re-applied companion was clean until the next rewrite.** With the change cherry-picked onto the rewritten head (#51), GitHub listed one commit, showed +1 −1 and reported MERGEABLE. After the next force-push it also listed that earlier head and conflicted.

**Inferred, not observed:** Nothing was merged. These merge outcomes are local `git merge-tree` projections that agreed with GitHub's mergeability verdicts:

- merging #52 would silently restore lines 5 and 6, which the author had deliberately removed;
- merging #46 or #48 would change only line 10, while adding the discarded commit to the branch's history.

Do not promote them to observed merge outcomes.

**Not tested:**

- New inline comments sent with a historical `commit_id`, whether the reviewed commit was discarded or was still an ancestor of the head. The tool never sends them, so their acceptance is unknown either way.
- Applying a native suggestion after its comment moved to a new head or became outdated.
- Submitting a pending review that spans a rewrite. #41's pending review survived, but it was never submitted.
- How the timeline renders a review submitted at an old commit. Only API state was recorded.
- A retry after a second rewrite.
- An actual merge of any companion.

**Evidence:** The [force-push experiment report](force-push-experiment.md), with its inline readback excerpts, and the live PRs, reviews and branches it lists, which were left in place. No raw readback files from the run itself are retained in the repository.

**Later read-only snapshot (October 1, 2026):** A [readback of #41–#52](evidence/realignment/e0-readme.md) recorded the fixtures' state a day after the run, with no writes. It is observed state at that time, not the experiment's own evidence.

- It agrees with every recorded observation above. #45–#48 and #51 were CONFLICTING, and #52 MERGEABLE. The reviews on #41, #43 and #44 were still pending.
- **Force-push events named the discarded heads.** Each `HeadRefForcePushedEvent` on #41, #42 and #43 carried a non-null `beforeCommit`, and each discarded reviewed commit was the `beforeCommit` of its PR's first event. The PR's commit list held only the current head.
- The outdated comments on #41 and #42 kept a `commit_id` that is the intermediate, also discarded, head.
- Pending review comments were absent from `GET …/pulls/<pr>/comments`. The per-review endpoint returned them without `line` or `original_line`, and GraphQL review threads returned them with both.

Whether `beforeCommit` can ever be null, and timelines longer than one page, are not covered.

Later implementation runs separately observed companions proposed on the reviewed commit of an advanced branch, or re-applied onto a rewritten head. Each listed exactly one commit carrying only its own change, and GitHub reported each MERGEABLE. Nothing was merged in those runs either. See the [force-push re-application evidence](force-push-reapply-e2e-evidence.md) and its raw outputs in [`evidence/force-push-reapply/`](evidence/force-push-reapply/).

**Limits:** One authenticated account, same-repository draft PRs, one modification hunk per synthetic file. Only the rebase variant advanced its base.

## Existing summaries whose primary evidence needs a repository home

**Product boundary:** The [settled force-push decisions](design-decisions.md#settled-force-push-boundary--september-30-2026) distinguish host review lifecycle, upstream follow-up and this project's faithful-publication responsibilities. Capability gaps below are experiment questions, not authority to invent a review-maintenance service.

The force-push experiment now has a repository home. Its report is [force-push-experiment.md](force-push-experiment.md), and GH-14 records it with its exact conditions and limits. Its primary evidence is the report's inline readback excerpts and the live fixtures it lists in `mike-north/doc-linter`, which were left in place. No raw readback files from the run itself are in the repository. A later read-only [snapshot of those fixtures](evidence/realignment/e0-readme.md), taken October 1, 2026, records their raw state, reviews, comments, force-push events and compare readbacks. It completes the record without rerunning the experiment.

Two working summaries of the experiment, a briefing and a responsibility review, exist only in the maintainer's uncommitted working logs. GH-14 keeps their distinctions between observed, inferred and untested results, and nothing in this register depends on them.

Keep the established limits attached. The removed-content restoration case was a local `merge-tree` projection plus a live mergeability verdict, **not a live merge**. Newly published historical inline comments, native-suggestion application after the branch moved, submission of a pending review after a rewrite, and a retry after a second rewrite remain untested. Do not promote the projection to an observed GitHub merge outcome.

## Cases this register does not establish

- Sibling alternatives automatically closing when the merged referencing companion targets the original feature branch (GH-01 only established a default-branch source).
- An optional Actions workflow performing abandonment cleanup (GH-02 established the condition motivating it).
- Pending-comment discovery, editing and post-submission links for a cross-linked native-suggestion group.
- New inline comments or native suggestions published at a historical or discarded commit; native-suggestion application after the branch moved; a pending review submitted across a rewrite; an actual merge of a companion built on a discarded commit (GH-14 records each as untested).
- Any broader behavior excluded by an entry's stated limits.

These boundaries preserve the observed facts; they are not a request to perform new experiments.
