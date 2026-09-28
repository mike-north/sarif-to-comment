# Grouped suggestion PR experiment

Verified September 27, 2026 in `mike-north/doc-linter`, at the user's request. This tested GitHub's interaction model manually, not a SARIF publisher implementation.

## Intended outcome

One draft suggestion PR proposes two new files against an original PR branch. Starting from the original PR, cross-reference events and the source PR's label identify the suggestion. Accepting the suggestion adds both exact files together to the original branch. The repository's default branch remains unchanged.

## Live evidence

- [Original test PR: Experiment: grouped SARIF suggestion target](https://github.com/mike-north/doc-linter/pull/3). Head branch: `codex/sarif-group-original-20260927`; base: `main`.
- [Suggestion PR: Experiment: propose two files as one suggestion](https://github.com/mike-north/doc-linter/pull/4). Created as a draft, targeting the original test branch, with the `suggestion` label and an ordinary body reference to the original PR. The original PR's body was not edited to establish this relationship.
- The suggestion added `docs/experiments/sarif-group/first.md` and `docs/experiments/sarif-group/second.md`. Both were absent from the original branch before acceptance.
- A GraphQL query beginning at the original PR's `timelineItems`, restricted to `CROSS_REFERENCED_EVENT`, returned the suggestion as `source`. Its fields included the repository, URL, draft state, branch context and labels. Local filtering by the `suggestion` label found the expected PR. Both timeline and label connections reported `hasNextPage: false`.
- The cross-reference reported `willCloseTarget: false` and `isCrossRepository: false`. This ordinary reference discovered the relationship without closing the original PR.
- Before acceptance, the suggestion's exact head was `66fffd17e735e824997ca10c33f13b919a9c0dd4`; the diff contained only the two synthetic file additions. Both reported version-guard checks passed.
- The suggestion was marked ready and squash-merged using an exact-head match. The resulting commit was [f064a185b3d90cb51ddd127f871edb2801755d6e](https://github.com/mike-north/doc-linter/commit/f064a185b3d90cb51ddd127f871edb2801755d6e). Its parent was the original branch's pre-acceptance head, `272da96551f35010ac88be3991447da4a1bc04af`. That single commit added both files. Comparing its complete tree with the suggestion head produced no differences.
- Readback confirmed the suggestion was `MERGED`, the original remained `OPEN`, and the original's file list contained both proposed additions. The same backlink query subsequently returned the suggestion in its merged state.
- `main` remained at `568c646058698d64dbae84852aab67235474e6ad`, its starting revision.

## Final state and limits

After verification, the original test PR was manually closed without merging (`mergedAt: null`). Both test branches were retained as evidence; both were observed present after acceptance. The new `suggestion` label remains available. No repository settings were changed.

This establishes the same-repository draft suggestion, backlink discovery, label filtering and grouped acceptance path. This run did not establish SARIF conversion, pending code-review creation, fork permissions, pagination across multiple pages, branch-protection behavior, automatic closing-keyword cleanup, or automatic branch deletion. The subsequent [lifecycle experiment](companion-pr-lifecycle-experiment.md) separately verified closing-reference and abandonment behavior. Neither run enabled automatic branch deletion.
