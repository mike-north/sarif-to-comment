# 048 an explicit group of three README edits under the defaults (native-batch)
feature: native-batch

$ GH_TOKEN=<fake-host-token> FAKE_HTTP_GITHUB_DIR=<tmp>/delivery-composition-QiqyQD/host NODE_OPTIONS=--require=<repo>/test/fixtures/docs/fake-fetch-preload.mts sarif-to-comment publish --sarif <tmp>/delivery-composition-QiqyQD/review.sarif --repo octo/widgets --pull 7 --commit feedfeedfeedfeedfeedfeedfeedfeedfeedfeed --state <tmp>/delivery-composition-QiqyQD/state/review.json --format json
exit status: 0

checks:
  PASS  the token never appears in stdout or stderr
  PASS  exit 0, published, no diagnostics
  PASS  three inline comments, each with the group note and a native suggestion block
  PASS  the body has the guidance "apply these 3 suggestions together, in one commit"

--- stdout
{
  "command": "publish",
  "status": "published",
  "review": {
    "id": 5000,
    "url": "https://github.com/octo/widgets/pull/7#pullrequestreview-5000"
  },
  "statePath": "<tmp>/delivery-composition-QiqyQD/state/review.json",
  "message": "## Draft review published\n\nCreated the draft [review 5000](https://github.com/octo/widgets/pull/7#pullrequestreview-5000) on octo/widgets#7 at commit `feedfeedfeedfeedfeedfeedfeedfeedfeedfeed`. It stays a draft until someone submits it on GitHub.",
  "diagnostics": []
}

--- stderr

--- input SARIF (as given to --sarif, before the command)
{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"Review bot","version":"1.0.0"}},"columnKind":"utf16CodeUnits","versionControlProvenance":[{"repositoryUri":"https://github.com/octo/widgets","revisionId":"feedfeedfeedfeedfeedfeedfeedfeedfeedfeed"}],"artifacts":[],"results":[{"message":{"text":"Fix the typo."},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"README.md"},"region":{"startLine":2}}}],"fixes":[{"artifactChanges":[{"artifactLocation":{"uri":"README.md"},"replacements":[{"deletedRegion":{"startLine":2},"insertedContent":{"text":"The widget client."}}]}]}],"properties":{"sarifToComment":{"suggestionGroup":"g"}}},{"message":{"text":"Fix the spelling."},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"README.md"},"region":{"startLine":3}}}],"fixes":[{"artifactChanges":[{"artifactLocation":{"uri":"README.md"},"replacements":[{"deletedRegion":{"startLine":3},"insertedContent":{"text":"Receive updates."}}]}]}],"properties":{"sarifToComment":{"suggestionGroup":"g"}}},{"message":{"text":"Use the American spelling."},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"README.md"},"region":{"startLine":4}}}],"fixes":[{"artifactChanges":[{"artifactLocation":{"uri":"README.md"},"replacements":[{"deletedRegion":{"startLine":4},"insertedContent":{"text":"License: MIT."}}]}]}],"properties":{"sarifToComment":{"suggestionGroup":"g"}}}]}]}
--- fake host after the command (writes so far, review requests, pull requests)
{
  "writesSoFar": [
    "POST /repos/octo/widgets/pulls/7/reviews"
  ],
  "reviews": [
    {
      "id": 5000,
      "state": "PENDING",
      "request": {
        "commit_id": "feedfeedfeedfeedfeedfeedfeedfeedfeedfeed",
        "body": "**Suggestion group `g`:** apply these 3 suggestions together, in one commit: add each of them to one batch of suggestions on the pull request, then commit the batch. Nothing checks that they are applied together.\n\n- `README.md` line 2\n- `README.md` line 3\n- `README.md` line 4\n\n<!-- sarif-to-comment:review:f8a8f26f-9ed8-4f8f-a93b-96bc872462be -->",
        "comments": [
          {
            "path": "README.md",
            "body": "Fix the typo.\n\n<sub>— Review bot 1.0.0</sub>\n\n**Suggestion group `g`:** apply this suggestion together with the group's other suggestions, listed in the review body.\n\n```suggestion\nThe widget client.\n```",
            "line": 2,
            "side": "RIGHT"
          },
          {
            "path": "README.md",
            "body": "Fix the spelling.\n\n<sub>— Review bot 1.0.0</sub>\n\n**Suggestion group `g`:** apply this suggestion together with the group's other suggestions, listed in the review body.\n\n```suggestion\nReceive updates.\n```",
            "line": 3,
            "side": "RIGHT"
          },
          {
            "path": "README.md",
            "body": "Use the American spelling.\n\n<sub>— Review bot 1.0.0</sub>\n\n**Suggestion group `g`:** apply this suggestion together with the group's other suggestions, listed in the review body.\n\n```suggestion\nLicense: MIT.\n```",
            "line": 4,
            "side": "RIGHT"
          }
        ]
      }
    }
  ],
  "pulls": []
}
