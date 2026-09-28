# Companion PR lifecycle experiment

Status: executed September 27, 2026 in `mike-north/doc-linter`. PR closure and discovery are verified; automatic branch deletion while enabled remains untested.

## Question

Can GitHub's closing-keyword and automatic branch-deletion behavior clean up companion suggestion PRs after the original PR ends?

## Actual setup and scope

The user selected the existing doc-linter repository instead of a new private test repository. Each case used independent original and suggestion branches with synthetic Markdown files. The default branch was `main`; automatic branch deletion was disabled and left unchanged. The repository's required version guard passed before both merges into main. No protection bypass or repository-settings change was used.

The auto-closing setting was not exposed by the REST repository response inspected, so its configuration was not independently established. The actual PR-to-PR closing behavior below was observed directly. No branches were manually deleted during observation or cleanup.

## Observed results

| Case | Original PR action | Suggestion result | Branches and discovery |
|---|---|---|---|
| Accepted suggestion control | Original remained open during acceptance | Suggestion merged; both proposed files arrived together | Both branches remained; backlink plus label found the suggestion before and after acceptance. See the [grouped-suggestion experiment](grouped-suggestion-experiment.md). |
| Unmerged suggestion after original merge | Original body contained `Closes #6`; original merged into main | Suggestion automatically became `CLOSED`, with `mergedAt: null`; its proposed file remained absent from main | Both branches remained; original-to-suggestion backlink plus label still found it in its closed state. |
| Unmerged suggestion after abandonment | Original body contained `Closes #8`; original closed without merging | Suggestion remained `OPEN` on initial and later readback | Both branches remained; backlink plus label still found the open suggestion from the closed original. |

“Unmerged” describes whether the suggestion was accepted into its target branch, independently of any review approval. Both unmerged suggestions in this experiment were drafts.

### Merge case

- [Original: Experiment: merge original with an unmerged suggestion](https://github.com/mike-north/doc-linter/pull/5), branch `codex/sarif-lifecycle-merge-20260927`, targeting `main`.
- [Suggestion: Experiment: unmerged suggestion when original merges](https://github.com/mike-north/doc-linter/pull/6), branch `codex/sarif-lifecycle-merge-suggestion-20260927`, targeting the original branch.
- Original head: `fe1bd8153fb4cf82e75bf9e20bcc6bf70c5eb1b2`; suggestion head: `efb8af94892263919bb3d1dbd18f75b5228b372b`. Only the original's marker file entered main in commit `8d2d07b7deb848ad7498e04b8000ea2edba651ef`.
- [Before](evidence/suggestion-lifecycle/sarif-lifecycle-merge-before.json) and [after](evidence/suggestion-lifecycle/sarif-lifecycle-merge-after.json) responses preserve original state and the labeled suggestion reached through its timeline.

### Abandonment case

- [Original: Experiment: close original with an unmerged suggestion](https://github.com/mike-north/doc-linter/pull/7), branch `codex/sarif-lifecycle-close-20260927`, targeting `main`.
- [Suggestion: Experiment: unmerged suggestion when original closes](https://github.com/mike-north/doc-linter/pull/8), branch `codex/sarif-lifecycle-close-suggestion-20260927`, targeting the original branch.
- Original head: `e9ef5ed952b6363d5dd5c52d6404a01fec337f69`; suggestion head: `c97529d439e061a85b6cded20253954d0da3f74b`. Neither branch's files entered main.
- [Before](evidence/suggestion-lifecycle/sarif-lifecycle-close-before.json), [after](evidence/suggestion-lifecycle/sarif-lifecycle-close-after.json), and [later readback](evidence/suggestion-lifecycle/sarif-lifecycle-close-settled.json) show that the suggestion remained open after the original closed.

### GraphQL observation

Every inspected timeline and label connection reported no additional page. Filtering source PRs by the `suggestion` label found the intended suggestion in both terminal original states. This validates the single-page live path, not multi-page traversal.

The [merge suggestion's pre-action timeline](evidence/suggestion-lifecycle/sarif-lifecycle-merge-suggestion-before.json) reported `willCloseTarget: false` for the original's closing reference, even though the suggestion subsequently closed automatically when the original merged. Do not use that field as a tested predictor for PR-to-PR closing behavior. The observed state transition is the evidence; the discrepancy's cause was not investigated.

## Manual cleanup and final state

After recording the abandonment result, the still-open suggestion was manually closed. That closure was not automatic. All test PRs are now closed or merged, and their branches were retained as evidence.

[Clean up completed suggestion lifecycle experiment](https://github.com/mike-north/doc-linter/pull/9) removed the merge-case marker after the required checks passed. Final main commit `0a7b03fe399255a62118311cbc3e1bd6fe64cb23` has an identical complete tree to starting main commit `568c646058698d64dbae84852aab67235474e6ad`, verified with a full Git tree diff. History retains the experiment and cleanup commits. No suggestion-only content entered main.

These observations support explicit on-demand cleanup for abandonment and optional closing references for the tested same-repository/default-branch merge path. They do not establish automatic branch deletion with that setting enabled, automatic retargeting, fork permissions, non-default merge targets, or behavior when auto-closing is disabled. The general cleanup publisher has not been implemented.

## Original case definitions

1. **Accepted suggestion control.** Create an original PR targeting the default branch and a companion targeting the original branch. Merge the companion. Check whether GitHub deletes the companion's source branch and whether its content enters the original branch.
2. **Unused suggestion after original merge.** Create a fresh pair. Add a closing-keyword reference to the companion in the original PR's description. Merge only the original PR into the default branch. Check whether the companion closes without merging, whether its changes remain absent from the default branch, and whether its source branch remains. Observe any automatic retargeting if GitHub deletes the original branch.
3. **Unused suggestion after abandonment.** Create another pair with the same closing reference. Close the original PR without merging. Check the companion state and both source branches.

After the observed state settles, record it before manually closing any test PRs left open. Any later manual cleanup must be labeled separately from GitHub's automatic behavior. A same-repository experiment does not establish fork or cross-repository behavior.

## Documented expectations, not test results

- Closing references can close another PR when the referencing PR merges into the default branch. They do not establish cleanup on abandonment. [GitHub closing-keyword documentation](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue).
- Automatic branch deletion is documented for merged PRs. Closure of an unused PR does not establish that its unmerged branch will be deleted. [GitHub automatic branch-deletion documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches).
- Deleting a merged PR's head branch can retarget other open PRs that used it as their base. [GitHub branch-management documentation](https://docs.github.com/en/pull-requests/how-tos/commit-changes/managing-branches-within-your-repository).
