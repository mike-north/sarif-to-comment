# New-file proposals: encoding and GitHub action research

Research date: September 27, 2026. This records findings and a candidate design, not an implemented feature or adopted public schema.

**Subsequent decision:** D23 now selects the result-level extension direction: the proposed operation references a file artifact from the result's property bag. The alternative placements discussed below are research history. Exact extension field names and the general remedy schema remain unadopted.

## Result

A proposed documentation page can be carried in ordinary SARIF. Explicit machine-readable file-creation intent needs a convention beyond the standard replacement model. GitHub's current new-file editor also accepts a prefilled filename and contents through its URL, as verified in a signed-in browser without creating a commit.

## SARIF representation

The standard fix model describes region replacements. I found no explicit create-file or delete-file operation in the normative fix sections or the official schema. Treating an absent file as an empty existing file would add consumer-specific semantics. The artifact's historical change status is not a proposed operation. [SARIF specification, sections 3.24 and 3.55–3.57](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html)

The [candidate example](examples/proposed-documentation.sarif.json) uses one result for the review contribution and an artifact for the proposed path and literal contents. Following the user's association decision, the result location points to the first line of the proposed content. A custom property declares the create operation. Custom property bags are standard extension points; our operation's meaning would remain a documented tool convention. [Official SARIF schema](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json)

The example is deliberately illustrative. It does not contain a real documentation page, destination PR, or complete publication context. The supplied comment explains the addition. Its line exists in the proposed content; it is not asserted to exist in the reviewed repository snapshot. There is no separate finding critiquing the generated page.

An alternative is a complete Markdown message containing the entire proposal. That works for presentation, but leaves operation and path embedded in prose. For deterministic validation and generation of an action link, structured path and content are preferable. This is a recommendation, not a settled decision.

## Extension capacity clarification

SARIF section 3.8.1 permits property-bag values of any JSON type, including nested objects and arrays. The official Errata 01 schema's `propertyBag` allows additional properties and sets no property-count or per-value size bound. The standard `artifactContent.text` and `artifactContent.binary` fields likewise have no schema `maxLength`. These findings mean the format supplies room for a structured create/delete/group convention; they do not promise unlimited parser memory, transport capacity, or downstream-host acceptance.

The existing candidate puts the complete proposed file in standard artifact contents and uses a small extension to identify the creation operation and artifact. Metadata need not duplicate the file payload. Consumer understanding of the custom convention remains an interoperability contract, distinct from schema validity. Sources: [property bags, section 3.8](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html), [official schema](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json).

The user also identified placing operation metadata on the artifact itself. SARIF supports an artifact's `properties` extension bag, so this is an allowed structural placement. The existing example instead puts operation metadata on the result and references the artifact. Neither placement is an adopted operation contract; ordinary artifact fields still describe the path/content, while extension fields supply tool-specific meaning. Custom fields belong inside `properties`, not as arbitrary new top-level artifact fields.

### Modeling clarification: file description versus proposed operation

The recommended conceptual separation is feedback describing the problem, a proposed remedy containing operations to accept together, and artifact records describing the files those operations reference. An artifact describes path/content; creation or deletion is an operation in a particular proposal, not necessarily an intrinsic property of the artifact. This is a recommendation about ownership of meaning, not an adopted schema.

Standard SARIF `fix` objects already collect changes to multiple artifacts for region-edit remedies. However, a standard `fix` requires a nonempty `artifactChanges` array and each `artifactChange` requires replacements. A proposed extension-only creation/deletion group cannot be assumed to be a valid ordinary `fix` with those mandatory fields omitted or empty. The existing result-level extension example demonstrates carrying the data, not a completed general remedy/group encoding. The exact extension placement must preserve grouping and satisfy the standard schema without fabricating content edits solely to pass validation.

## Live GitHub observations

The tested form is:

```text
https://github.com/OWNER/REPOSITORY/new/BRANCH?filename=ENCODED_PATH&value=ENCODED_CONTENT
```

Parameters were built with a URL encoder. All probes used synthetic, nonsensitive text in the existing project repository. Nothing was committed, posted, or uploaded as an attachment.

| Probe | Observed result |
|---|---|
| Nested destination path and 126 UTF-8 bytes of text; 270-character URL | Filename, directory, and contents prefilled. The editor's logical lines exactly reproduced the input, including blank lines, final newline, non-ASCII text, Markdown fences, and URL punctuation. |
| Open the commit dialog | Direct commit to the selected branch was available, along with creating a new branch and PR. The dialog was canceled. The observed workflow has an editor button followed by a final commit confirmation. |
| 7,830 bytes of synthetic documentation; 8,339-character URL | GitHub rejected it with “Your request URL is too long.” This is an observed failure point, not a measured universal maximum. |
| Replace the branch in the route with the repository's existing full commit identifier | GitHub returned a not-found page. Exact-commit targeting through that route was not established. |

GitHub itself exposes a filename-prefilling new-file link through its Add a README action. Its [file-creation documentation](https://docs.github.com/en/repositories/working-with-files/managing-files/creating-new-files) explains the editing and commit workflow, but this research did not find an official documented contract for the content-prefill parameter.

## Recommended security boundaries

These are proposed implementation requirements prompted by the user's request to make the design secure. They have not been implemented or security-tested.

- Preserve proposed file contents as literal artifact data. When showing the source in a comment, wrap it in a code fence longer than any matching fence sequence inside the content; do not execute or interpret it as a template. Fenced code is literal under [GitHub Flavored Markdown](https://github.github.com/gfm/#fenced-code-blocks). A Markdown page can itself contain code fences, HTML examples, links, or template expressions.
- Derive action-link host, repository, and branch from validated destination context. For a fork PR, that means its head repository and branch, not automatically the base repository. A SARIF-provided arbitrary URL must not choose the destination.
- Validate the destination as a repository-relative path under one explicit URI-decoding convention. Reject traversal, absolute paths, unsupported URI schemes, and ambiguous encodings. Do not read local files or fetch remote content merely because an input artifact names them. Preparation should read the intended staged Git blob, rather than follow a working-tree symlink.
- Encode parameter values with a URL library and escape the resulting Markdown link syntax. File contents must not introduce additional parameters, redirect the destination, or escape their displayed code block. Keep parser depth, artifact size, and final comment-size limits explicit; do not silently truncate the proposal.
- Treat a branch link as a convenience action against a moving branch, not a commit-pinned or conflict-checked application. Keep the reviewed revision and full proposal visible. Verify fork behavior, slash-containing branch names, existing-file conflicts, and protected branches before claiming broader support.
- Make content-bearing URLs an explicit caller policy choice: the document text becomes part of browser history and request URLs. URL encoding is not encryption. Do not use external shorteners or third-party content hosting as an automatic workaround. Retain the complete review proposal when a link is omitted for sensitivity or size.
- Opening the form is not applying the change. The user chooses whether and where to commit. This publisher does not automatically click the final commit action or execute instructions contained in proposed documentation. Literal formatting also does not establish that content is appropriate for a downstream agent; proofreading and that agent's own authorization remain separate.

## What is established and what remains

The URL affordance works for the short tested file and branch. It is optional presentation convenience; ordinary review feedback remains the fallback. No maximum safe URL length, fork behavior, protected-branch behavior, or exact-commit application guarantee was established.

The encoding example passed validation against the official SARIF 2.1.0 Errata 01 schema using the workspace's existing Ajv dependency with the draft-04 meta-schema. Schema acceptance cannot prove the meaning or security of the custom operation. That convention needs its own documented contract and behavioral tests before implementation.

The user accepted offering the prefill link only in cases where it works. The proposed length guard measures the complete encoded URL, including repository, branch, path, and content, rather than raw document characters. A production support bound has not yet been established; the two probes above demonstrate success and failure, not the cutoff. Never truncate contents to fit.
