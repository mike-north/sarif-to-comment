---
"sarif-to-comment": patch
---

**Fixes.**

- **Line links open the source view.** Every permalink that names lines now adds `?plain=1` (`…/blob/COMMIT/PATH?plain=1#L5`), so it reaches its line in every file type. In 0.2.1 a line link into a file GitHub renders, such as Markdown, opened the rendered preview, which has no line anchors. Code files open as before, and a link to a whole file has no query.
- **A refusal by GitHub is stated once.** When GitHub refuses the create-review request, the message now gives the status and GitHub's reason once, as its own sentence. This applies to refusals recorded by 0.2.1 too.

### A finding's source link

```diff
-**Source:** [docs/sample.md line 5 at c1c1c1c](https://github.com/octo/widgets/blob/c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1/docs/sample.md#L5)
+**Source:** [docs/sample.md line 5 at c1c1c1c](https://github.com/octo/widgets/blob/c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1/docs/sample.md?plain=1#L5)
```

### `sarif-to-comment publish` refused by GitHub (a pending review already exists)

```diff
-GitHub refused the create-review request (HTTP 422): GitHub answered the create-review request with HTTP 422: Unprocessable Entity; User can only have one pending review per pull request It is never resent; this state path now records the refusal. Resolve the cause, then publish under a new state path.
+GitHub refused the create-review request (HTTP 422): Unprocessable Entity; User can only have one pending review per pull request. It is never resent; this state path now records the refusal. Resolve the cause, then publish under a new state path.
```
