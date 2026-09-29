# validate without --suggestion-prs (exit 2)

## Review blocked

Nothing was published and no publication state was written.

**Review blocked:** 1 problem must be resolved before publication; nothing was published.

- `acceptance-group-requires-suggestion-prs` at `/runs/0/results/0`: Acceptance group "retry-with-check" must be accepted as one unit, which needs a suggestion pull request. Enable suggestion pull requests (options.suggestionPullRequests or --suggestion-prs); a group is never split into separate suggestions or published in part.


# validate --suggestion-prs (exit 0)

## Ready to publish

The complete document can be published faithfully to mike-north/doc-linter#36 at commit `89bf101d454c10d98df84e504c05494e9627375b`.

Publication would also create 2 draft suggestion pull requests into `sarif-issue5-20260929-reviewed`, labeled `suggestion`.

**Review prepared:** 1 inline comment(s) and 2 general section(s) for commit `89bf101d454c10d98df84e504c05494e9627375b`.

Nothing was published and no publication state was written.

This is not an approval: publication repeats every check against the pull request as it is then. GitHub can still refuse the review, for example when this account already has a pending review on the pull request.
