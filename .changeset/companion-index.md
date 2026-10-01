---
"sarif-to-comment": minor
---

Every review with companion pull requests now begins with an index of them, and a later review can list companion pull requests an earlier review created.

The index lists every suggestion pull request the publication creates, then every existing one you name, each with its link, its title and whether it was created with this review or reused. Each created one keeps its own section, with its changes and findings, where its first finding is. You, or an upstream agent, can find a review's proposals from the review itself, and continue them in a later review without creating copies. Titles are shown as code spans, so a title is never Markdown, a mention or a link, and any invisible or bidirectional character in it is shown as a visible `{U+XXXX}` escape (a zero-width joiner inside an emoji sequence is kept).

Name existing ones with `existingCompanions` (library) or `--existing-companion N`, repeated for several, on `publish` and `validate`. Only the pull requests you name are listed: nothing is looked up, inferred or carried forward by itself, and nothing you name is created, changed, reopened or closed. Each is read once, before anything is written. It must be a pull request of the repository whose head branch is its marker's `suggestion-pr/<pull>/<id>` branch in the repository, with exactly one suggestion marker naming this pull request as its original. Any tool may have created it. Otherwise the review is blocked with `companion-not-reusable` (exit status 2), naming the pull request and the reason. Open, a draft, closed or merged, it is listed, and a `companion-reused` note states which. The numbers are part of the publication's identity, and the index is recorded with the publication, so a recovered review carries the identical body and a retry reads nothing again.

Library callers can replace the index and each suggestion pull request's section with `options.presentation.companionIndex` and `options.presentation.companionReference`. Each receives every companion's `number`, `url`, `title`, `origin`, `state` and `link`, and must keep every `link`: a result that drops a companion, points a `#N` link elsewhere or adds any other link is refused with a `TypeError`. These callbacks run while the review is prepared, with placeholder numbers, so a bad result is refused before anything is written, and once more with the real numbers when the review is composed after its suggestion pull requests exist, before it is recorded and sent. Recovery and retries reuse the recorded body and call no callback.

### `sarif-to-comment publish --help` and `validate --help`

```text
                           [--companion-bundle BUNDLE] [--pr-labels A,B,C]
                           [--mark-suggestion-prs-ready]
                           [--existing-companion N]...
                           [--format human|json|toon]
```

```text
  --existing-companion N         An existing suggestion pull request of this
                                 pull request to list in the review's companion
                                 index, beside those the review creates. Repeat
                                 it for several. It must name this pull request
                                 in its marker; it is never changed.
```

### `sarif-to-comment publish --file-operations companion --existing-companion 97`: the start of the review body

```markdown
**Companion pull requests of this review:**

- [#101](https://github.com/acme/widgets/pull/101): `Suggestion for #42: create docs/guide.md` — created with this review
- [#97](https://github.com/acme/widgets/pull/97): `Suggestion for #42: edit README.md` — reused; it was a draft when this review was prepared

---

**Suggestion pull request:** [#101](https://github.com/acme/widgets/pull/101)

Merging it into `feature/retry` applies this change:
```

### `sarif-to-comment validate --existing-companion 101`: a suggestion pull request of this pull request

```text
ℹ note  An existing companion pull request is listed in the review  [companion-reused]
  mike-north/doc-linter#101
  #101 is listed in the review's companion index as an existing companion; it was a draft when the review was prepared.
```

### `sarif-to-comment validate --existing-companion 97`: one whose marker names another pull request (exit status 2)

```text
✖ error  An existing companion pull request cannot be listed in the review  [companion-not-reusable]
  mike-north/doc-linter#97
  #97 cannot be listed as an existing companion of #100: its suggestion marker names #96, not #100.
  → Name a suggestion pull request whose marker names this pull request, or leave this one out (`--existing-companion`, `existingCompanions`).
```
