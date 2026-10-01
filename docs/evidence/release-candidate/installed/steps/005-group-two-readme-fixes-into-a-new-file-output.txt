# 005 group two README fixes into a new file (--output)
feature: group-fixes

$ sarif-to-comment group-fixes --sarif <tmp>/authoring-HObiYv/review.sarif --finding /runs/0/results/0@e6bf06fcf799f76c --finding /runs/0/results/1@e6bf06fcf799f76c --group readme-typos --output <tmp>/authoring-HObiYv/grouped.sarif --format json
exit status: 0

checks:
  PASS  exit 0, status grouped
  PASS  --sarif is not changed when --output is given
  PASS  results 0 and 1 carry properties.sarifToComment.suggestionGroup "readme-typos"; others none

--- stdout
{
  "command": "group-fixes",
  "status": "grouped",
  "sarif": {
    "path": "<tmp>/authoring-HObiYv/review.sarif",
    "written": false
  },
  "output": {
    "path": "<tmp>/authoring-HObiYv/grouped.sarif",
    "written": true
  },
  "group": "readme-typos",
  "extended": false,
  "findings": [
    {
      "ref": "/runs/0/results/0",
      "runIndex": 0,
      "resultIndex": 0,
      "tool": "Review bot",
      "changes": 1
    },
    {
      "ref": "/runs/0/results/1",
      "runIndex": 0,
      "resultIndex": 1,
      "tool": "Review bot",
      "changes": 1
    }
  ],
  "changes": 2,
  "diagnostics": []
}

--- stderr

--- input SARIF (as given to --sarif, before the command)
{
  "version": "2.1.0",
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "Review bot",
          "version": "1.0.0"
        }
      },
      "columnKind": "utf16CodeUnits",
      "versionControlProvenance": [
        {
          "repositoryUri": "https://github.com/octo/widgets",
          "revisionId": "feedfeedfeedfeedfeedfeedfeedfeedfeedfeed"
        }
      ],
      "artifacts": [],
      "results": [
        {
          "message": {
            "text": "Fix the typo."
          },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": {
                  "uri": "README.md"
                },
                "region": {
                  "startLine": 2
                }
              }
            }
          ],
          "fixes": [
            {
              "artifactChanges": [
                {
                  "artifactLocation": {
                    "uri": "README.md"
                  },
                  "replacements": [
                    {
                      "deletedRegion": {
                        "startLine": 2
                      },
                      "insertedContent": {
                        "text": "The widget client."
                      }
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "message": {
            "text": "Fix the spelling."
          },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": {
                  "uri": "README.md"
                },
                "region": {
                  "startLine": 3
                }
              }
            }
          ],
          "fixes": [
            {
              "artifactChanges": [
                {
                  "artifactLocation": {
                    "uri": "README.md"
                  },
                  "replacements": [
                    {
                      "deletedRegion": {
                        "startLine": 3
                      },
                      "insertedContent": {
                        "text": "Receive updates."
                      }
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "message": {
            "text": "Use the American spelling."
          },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": {
                  "uri": "README.md"
                },
                "region": {
                  "startLine": 4
                }
              }
            }
          ],
          "fixes": [
            {
              "artifactChanges": [
                {
                  "artifactLocation": {
                    "uri": "README.md"
                  },
                  "replacements": [
                    {
                      "deletedRegion": {
                        "startLine": 4
                      },
                      "insertedContent": {
                        "text": "License: MIT."
                      }
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "message": {
            "text": "Retry once on timeout."
          },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": {
                  "uri": "src/client.ts"
                },
                "region": {
                  "startLine": 2
                }
              }
            }
          ],
          "fixes": [
            {
              "artifactChanges": [
                {
                  "artifactLocation": {
                    "uri": "src/client.ts"
                  },
                  "replacements": [
                    {
                      "deletedRegion": {
                        "startLine": 2
                      },
                      "insertedContent": {
                        "text": "  const response = await request(id).catch(() => request(id));"
                      }
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "message": {
            "text": "Revise note 3."
          },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": {
                  "uri": "notes.txt"
                },
                "region": {
                  "startLine": 3
                }
              }
            }
          ],
          "fixes": [
            {
              "artifactChanges": [
                {
                  "artifactLocation": {
                    "uri": "notes.txt"
                  },
                  "replacements": [
                    {
                      "deletedRegion": {
                        "startLine": 3
                      },
                      "insertedContent": {
                        "text": "Note 3, revised."
                      }
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
