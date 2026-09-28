# Publication recovery after discarded creation responses

Verified September 27, 2026 in `mike-north/doc-linter`. This manual experiment deliberately discarded successful creation responses. It did not inject an actual transport failure, test delayed visibility or concurrency, or exercise an implemented publisher.

## Intended outcome

Persist a distinct stable identity for each intended remote object before sending its creation request. A suggestion PR's creation body contains both its marker and an ordinary reference to the known original PR. A draft review's body contains its own marker. Recovery must rediscover each object without using its creation response, verify its intended context, and finish remaining work without creating another object.

The same markers must be reused across retries. A network attempt is not a new intended object.

## Observed behavior

1. Persisted the [publication intent and per-object markers](evidence/publication-recovery/sarif-recovery-intent.json) before either tested creation. The marker strings are experiment identifiers, not secrets or credentials.
2. Created [Experiment: recover publication after a lost response](https://github.com/mike-north/doc-linter/pull/10) as the known original draft PR, anchored at `80208b0071131e4348e78832d909cfe5c8724ae2` on `codex/sarif-recovery-original-20260927`.
3. Created a draft suggestion with a marker and original reference in its initial body, discarding standard output without recording its returned PR identity. Deliberately omitted the label to represent partial publication.
4. Queried the known original's cross-reference timeline and inspected source PR bodies. The [discovery response](evidence/publication-recovery/sarif-recovery-suggestion-discovered.json) contained exactly one matching marker: [Experiment: rediscover a marked suggestion](https://github.com/mike-north/doc-linter/pull/11). Verified its repository, base branch, head branch, open/draft state and absent labels. Recovery did not depend on the suggestion label or a saved suggestion PR number.
5. Created a pending review on the original by omitting the submission event, with a distinct body marker and one synthetic inline comment. Again discarded the creation response.
6. Listed reviews for the known original, using pagination. Found [one matching pending review](evidence/publication-recovery/sarif-recovery-review-recovered.json), verifying the exact marker, authenticated author and reviewed commit. Its body marker survived creation. Its [inline comment](evidence/publication-recovery/sarif-recovery-review-comments.json) retained the expected body, file, commit and diff position. This endpoint returned a diff position rather than the submitted line field; the fixture's single new-file hunk made the position unambiguous.
7. Resumed the incomplete publication by labeling the recovered suggestion and updating the existing pending review body with a link to that suggestion while retaining its marker.
8. Repeated discovery. The [suggestion response](evidence/publication-recovery/sarif-recovery-suggestion-repeat.json) and [review listing](evidence/publication-recovery/sarif-recovery-reviews-repeat.json) identified the same single PR and pending review, now containing the completed label and link. No second creation was issued.

All inspected timeline and label connections reported no next page. Review listing used automatic pagination; this small fixture did not establish behavior across multiple live pages.

## Cleanup and limits

After saving evidence, fetched the pending review again and revalidated its exact identity, marker, author, state and commit before deleting it. Both temporary PRs were closed without merging. The branches remain as evidence. Main remained at `0a7b03fe399255a62118311cbc3e1bd6fe64cb23` throughout this experiment.

This establishes marker preservation and a usable rediscovery path for this same-repository case. It supports D14/D28's recovery model. It does not establish atomic publication across remote objects, absence from an incomplete or delayed lookup, safe concurrent retries, marker survival after arbitrary human edits, or implemented crash/restart behavior. Those remain engineering verification tasks, not reasons to require another product approval of the chosen recovery approach.

## Operational note

An SSH signing attempt initially failed because the signing agent did not respond; the user identified a missed 1Password approval. A temporary HTTPS operation succeeded. The user then explicitly requested SSH preference, and a retry authenticated successfully. Remaining Git pushes and final verification used SSH. No SSH configuration or Git remote was changed.
