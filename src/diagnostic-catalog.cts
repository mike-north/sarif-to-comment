/**
 * The diagnostic code catalog: every code a diagnostic of this package can
 * carry, with the severity, title and typical remedies that code always has
 * (docs/diagnostics.md, "Code catalog", which adds each code's meaning).
 *
 * Codes are public and stable once released. A code names a condition, not a
 * message: the message a diagnostic carries may add specifics. Keeping the
 * catalog as data typed by {@link DiagnosticCode} means a module can only
 * report a catalogued code, and the tests compare this catalog with the
 * documented one entry by entry.
 */

/** The fixed facts of one code. */
export interface IDiagnosticCatalogEntry {
  /** error, warning or note; the same for every diagnostic of the code. */
  readonly severity: 'error' | 'warning' | 'note';
  /** One plain-text line, the same for every diagnostic of the code. */
  readonly title: string;
  /** Concrete next steps, in order; empty when nothing needs doing. */
  readonly remedies: readonly string[];
}

/** Every code, in the catalog's documented order. */
export const DIAGNOSTIC_CATALOG = {
  'usage-error': {
    severity: 'error',
    title: 'The command line is not valid',
    remedies: ['Run the command with `--help` for its usage, and correct the command line.'],
  },
  'github-token-missing': {
    severity: 'error',
    title: 'No GitHub token is set',
    remedies: ['Set GH_TOKEN (or GITHUB_TOKEN) to a personal access token or user token.'],
  },
  'file-unreadable': {
    severity: 'error',
    title: 'A file could not be read',
    remedies: ['Check the path and the file\'s permissions, then run the command again.'],
  },
  'file-not-utf8': {
    severity: 'error',
    title: 'A file is not UTF-8 text',
    remedies: ['Save the file as UTF-8, then run the command again.'],
  },
  'file-not-json': {
    severity: 'error',
    title: 'A file is not valid JSON',
    remedies: ['Correct the file\'s JSON syntax, then run the command again.'],
  },
  'output-exists': {
    severity: 'error',
    title: 'The output file already exists',
    remedies: ['Choose a new output path, or move the existing file away.'],
  },
  'file-not-writable': {
    severity: 'error',
    title: 'A file could not be written',
    remedies: ['Check the directory\'s permissions and free space, then run the command again.'],
  },
  'file-in-use': {
    severity: 'error',
    title: 'Another command is writing the file',
    remedies: ['Wait for the other command to finish.', 'If no such command is running, delete the stale marker the message names and run the command again.'],
  },
  'file-changed-during-edit': {
    severity: 'error',
    title: 'The file changed while the command ran',
    remedies: ['Run the command again.'],
  },
  'output-archive-failed': {
    severity: 'error',
    title: 'The existing output could not be preserved',
    remedies: ['Check the output directory\'s permissions, then run the command again.'],
  },
  'message-not-utf8': {
    severity: 'error',
    title: 'The message on standard input is not UTF-8',
    remedies: ['Provide the message as UTF-8 text.'],
  },
  'operation-failed': {
    severity: 'error',
    title: 'The operation could not be completed',
    remedies: ['Resolve the cause the message names, then run the command again.'],
  },
  'color-unavailable': {
    severity: 'warning',
    title: 'Color is unavailable',
    remedies: ['Reinstall the package\'s dependencies, or use `--color never`.'],
  },
  'sarif-schema-invalid': {
    severity: 'error',
    title: 'The document is not valid SARIF 2.1.0',
    remedies: ['Correct the document so that it conforms to the SARIF 2.1.0 schema.'],
  },
  'sarif-no-runs': {
    severity: 'error',
    title: 'The document has no run to add the finding to',
    remedies: ['Add the finding to a new run of your own tool (`run: { toolName }`, or `add-comment --new-run-tool NAME`).'],
  },
  'finding-selector-stale': {
    severity: 'error',
    title: 'The finding selector does not fit the document',
    remedies: ['Inspect the document again and use the selector it shows now.'],
  },
  'finding-already-grouped': {
    severity: 'error',
    title: 'The finding is already in another suggestion group',
    remedies: ['Ungroup the finding first to move it to another group.'],
  },
  'finding-not-grouped': {
    severity: 'error',
    title: 'The finding is not in a suggestion group',
    remedies: ['Leave the finding out of the ungroup request.'],
  },
  'ungroup-leaves-single-change': {
    severity: 'error',
    title: 'Ungrouping would leave a group with fewer than two changes',
    remedies: ['Ungroup the group\'s other findings too, which dissolves the group.'],
  },
  'uninterpreted-message': {
    severity: 'warning',
    title: 'A message could not be resolved',
    remedies: ['Supply the missing argument or message string in the SARIF.'],
  },
  'uninterpreted-artifact-location': {
    severity: 'warning',
    title: 'An artifact location could not be resolved to a repository path',
    remedies: ['Use a repository-relative URI, or pass the producer\'s source root (`--source-root`, `sourceRootUri`).'],
  },
  'uninterpreted-file-proposal': {
    severity: 'warning',
    title: 'A proposed file change could not be interpreted',
    remedies: ['Correct the proposal, or remove it.'],
  },
  'uninterpreted-rule-reference': {
    severity: 'warning',
    title: 'A rule reference could not be resolved',
    remedies: ['Correct the result\'s `ruleId`, `ruleIndex` or `rule`.'],
  },
  'external-results-not-merged': {
    severity: 'warning',
    title: 'Results in inline external properties are shown verbatim',
    remedies: ['Move the results into a run if they are findings to publish.'],
  },
  'external-property-files-not-loaded': {
    severity: 'warning',
    title: 'External property files are not loaded',
    remedies: ['Inline the content into the document if it matters for review.'],
  },
  'staged-conflict': {
    severity: 'error',
    title: 'A staged path has unmerged index entries',
    remedies: ['Resolve the conflict and stage the intended content, then run again.'],
  },
  'staged-intent-to-add': {
    severity: 'error',
    title: 'A path is only intended to be added',
    remedies: ['Stage the intended content with `git add`, or remove the intent-to-add entry, then run again.'],
  },
  'staged-sparse-directory': {
    severity: 'error',
    title: 'The index holds a sparse directory entry',
    remedies: ['Disable the sparse index (`git sparse-checkout disable` or `index.sparse=false`), then run again.'],
  },
  'staged-split-index': {
    severity: 'error',
    title: 'The index is a split index',
    remedies: ['Run `git update-index --no-split-index`, then run again.'],
  },
  'staged-path-not-utf8': {
    severity: 'error',
    title: 'A staged path is not valid UTF-8',
    remedies: ['Rename or unstage the path, then run again.'],
  },
  'staged-not-regular-file': {
    severity: 'error',
    title: 'A staged path is not a regular file',
    remedies: ['Unstage the change, then run again.'],
  },
  'staged-mode-change': {
    severity: 'error',
    title: 'A staged change changes a file mode',
    remedies: ['Unstage the mode change (`git update-index --chmod`), then run again.'],
  },
  'staged-file-too-large': {
    severity: 'error',
    title: 'A staged file is over the source size limit',
    remedies: ['Unstage the file or split the change, then run again.'],
  },
  'staged-binary': {
    severity: 'error',
    title: 'A staged file is binary',
    remedies: ['Unstage the file, then run again.'],
  },
  'staged-content-not-utf8': {
    severity: 'error',
    title: 'A staged file is not UTF-8 text',
    remedies: ['Unstage the file, or stage it as UTF-8, then run again.'],
  },
  'staged-bom-change': {
    severity: 'error',
    title: 'A staged change adds or removes a byte-order mark',
    remedies: ['Stage the file with its original byte-order mark state, then run again.'],
  },
  'finding-location-unresolved': {
    severity: 'error',
    title: 'A finding\'s location cannot be resolved to a repository path',
    remedies: ['Use a repository-relative URI, or pass the producer\'s source root, then run again.'],
  },
  'finding-region-unreadable': {
    severity: 'error',
    title: 'A finding\'s region cannot be checked',
    remedies: ['Remove the region or the finding, then run again.'],
  },
  'supplied-fix-location-unresolved': {
    severity: 'error',
    title: 'A supplied fix\'s file cannot be resolved',
    remedies: ['Use a repository-relative URI, or pass the producer\'s source root, then run again.'],
  },
  'supplied-fix-unlocatable': {
    severity: 'error',
    title: 'A supplied fix cannot be located in the reviewed file',
    remedies: ['Correct or remove the fix, then run again.'],
  },
  'supplied-fix-binary': {
    severity: 'error',
    title: 'A supplied fix inserts binary content where the staged change edits text',
    remedies: ['Correct or remove the fix, then run again.'],
  },
  'staged-fix-conflict': {
    severity: 'error',
    title: 'A supplied fix conflicts with the staged change',
    remedies: ['Reconcile the fix or the staged content, then run again.'],
  },
  'staged-proposal-conflict': {
    severity: 'error',
    title: 'A supplied proposal conflicts with a staged creation or deletion',
    remedies: ['Reconcile the proposal or the staged content, then run again.'],
  },
  'finding-partially-overlaps-change': {
    severity: 'warning',
    title: 'A finding only partly overlaps a staged change',
    remedies: ['Adjust the finding\'s lines to cover the whole change if they belong together.'],
  },
  'finding-association-needs-column-kind': {
    severity: 'warning',
    title: 'A finding was not associated because its run declares no columnKind',
    remedies: ['Declare the run\'s `columnKind` if the finding and the change belong together.'],
  },
  'external-properties-unsupported': {
    severity: 'error',
    title: 'External properties are not supported',
    remedies: ['Move the content into the runs, or remove it.'],
  },
  'owned-property-invalid': {
    severity: 'error',
    title: 'The sarifToComment properties are not valid',
    remedies: ['Correct or remove `properties.sarifToComment`.'],
  },
  'approval-hold': {
    severity: 'error',
    title: 'The review is held for approval',
    remedies: ['Resolve the hold in the SARIF.', 'Or publish deliberately despite it with `--ignore-approval-hold` (`ignoreApprovalHold`).'],
  },
  'approval-hold-overridden': {
    severity: 'warning',
    title: 'An approval hold was bypassed',
    remedies: [],
  },
  'approval-state-invalid': {
    severity: 'error',
    title: 'The approval state is not recognized',
    remedies: ['Set the approval state to `awaiting-approval` or `ready`, or remove it.'],
  },
  'suggestion-group-invalid': {
    severity: 'error',
    title: 'The suggestion group name is not valid',
    remedies: ['Correct the group name, or regroup the findings with `group-fixes`.'],
  },
  'tool-invocation-failed': {
    severity: 'error',
    title: 'The tool reports that its analysis did not complete',
    remedies: ['Rerun the analysis until it completes, or remove the run.'],
  },
  'tool-reported-errors': {
    severity: 'warning',
    title: 'The tool reported errors during a successful invocation',
    remedies: ['Check the tool\'s notifications if the results look incomplete.'],
  },
  'context-artifact-uninterpreted': {
    severity: 'warning',
    title: 'Artifact contents are treated as context only',
    remedies: ['Reference the artifact from `proposedFileChanges` if it is a proposed file.'],
  },
  'taxa-uninterpreted': {
    severity: 'warning',
    title: 'Taxonomy classifications are not shown',
    remedies: [],
  },
  'newline-sequences-unsupported': {
    severity: 'error',
    title: 'The run declares unsupported newline sequences',
    remedies: ['Remove the `newlineSequences` declaration, or the findings that depend on it.'],
  },
  'provenance-repository-mismatch': {
    severity: 'error',
    title: 'The run\'s provenance names only other repositories',
    remedies: ['Publish the run to a pull request of the repository it analyzed, or correct its `versionControlProvenance`.'],
  },
  'provenance-revision-invalid': {
    severity: 'error',
    title: 'The run\'s provenance revision is not a full commit',
    remedies: ['Record the full 40-character commit in `versionControlProvenance`.'],
  },
  'provenance-revision-conflict': {
    severity: 'error',
    title: 'The run names several revisions of this repository',
    remedies: ['Split the run by revision, or correct its `versionControlProvenance`.'],
  },
  'related-locations-unsupported': {
    severity: 'error',
    title: 'Related locations are not supported',
    remedies: ['Remove the related locations, or describe them in the message.'],
  },
  'graphs-unsupported': {
    severity: 'error',
    title: 'Graphs are not supported',
    remedies: ['Remove them, or describe them in the message.'],
  },
  'stacks-unsupported': {
    severity: 'error',
    title: 'Stacks are not supported',
    remedies: ['Remove them, or describe them in the message.'],
  },
  'attachments-unsupported': {
    severity: 'error',
    title: 'Attachments are not supported',
    remedies: ['Remove them, or describe them in the message.'],
  },
  'suppressed-result-unsupported': {
    severity: 'error',
    title: 'Suppressions are not supported',
    remedies: ['Remove suppressed results, or their suppressions, before publishing.'],
  },
  'code-flows-unsupported': {
    severity: 'error',
    title: 'Code flows are not supported',
    remedies: ['Remove them, or describe them in the message.'],
  },
  'multiple-locations-unsupported': {
    severity: 'error',
    title: 'A result has several locations',
    remedies: ['Split the result into one result per location.'],
  },
  'location-annotations-unsupported': {
    severity: 'error',
    title: 'Location annotations are not supported',
    remedies: ['Remove the annotations, or describe them in the message.'],
  },
  'baseline-absent-unsupported': {
    severity: 'error',
    title: 'An absent baseline result cannot be presented',
    remedies: ['Remove results whose `baselineState` is `absent`.'],
  },
  'location-without-physical-source': {
    severity: 'error',
    title: 'A location has no physical source',
    remedies: ['Give the location a `physicalLocation` with an artifact, or remove it.'],
  },
  'message-unresolved': {
    severity: 'error',
    title: 'A message id is not defined',
    remedies: ['Define the message string, or give the message its text.'],
  },
  'message-argument-missing': {
    severity: 'error',
    title: 'A message argument is missing',
    remedies: ['Supply the argument in the message\'s `arguments`.'],
  },
  'producer-html-unbalanced': {
    severity: 'error',
    title: 'Producer Markdown leaves HTML open',
    remedies: ['Close the HTML element in the message.'],
  },
  'producer-fence-unclosed': {
    severity: 'error',
    title: 'Producer Markdown leaves a code fence open',
    remedies: ['Close the code fence in the message.'],
  },
  'producer-suggestion-fence': {
    severity: 'error',
    title: 'Producer Markdown opens a suggestion block',
    remedies: ['Express the change as a SARIF fix, or use another fence language.'],
  },
  'rule-component-unresolved': {
    severity: 'error',
    title: 'A rule\'s tool component cannot be resolved',
    remedies: ['Correct the rule reference\'s `toolComponent`.'],
  },
  'rule-reference-conflict': {
    severity: 'error',
    title: 'A result\'s rule references disagree',
    remedies: ['Make the result\'s rule references agree.'],
  },
  'rule-reference-invalid': {
    severity: 'error',
    title: 'A rule index names no rule',
    remedies: ['Correct the rule index.'],
  },
  'artifact-index-invalid': {
    severity: 'error',
    title: 'An artifact index names no artifact location',
    remedies: ['Correct the artifact index.'],
  },
  'artifact-index-conflict': {
    severity: 'error',
    title: 'A location disagrees with the artifact it indexes',
    remedies: ['Make the location\'s URI match its artifact, or drop one of them.'],
  },
  'nested-artifact-unsupported': {
    severity: 'error',
    title: 'Nested artifacts are not supported',
    remedies: ['Refer to the file directly.'],
  },
  'uri-invalid': {
    severity: 'error',
    title: 'An artifact URI is not valid',
    remedies: ['Use a repository-relative URI, or a `file:` URI with a source root.'],
  },
  'uri-traversal': {
    severity: 'error',
    title: 'An artifact URI contains a dot segment',
    remedies: ['Use a normalized repository-relative URI.'],
  },
  'uri-encoded-separator': {
    severity: 'error',
    title: 'An artifact URI encodes a path separator',
    remedies: ['Use a URI whose segments do not encode separators.'],
  },
  'uri-scheme-unsupported': {
    severity: 'error',
    title: 'An artifact URI scheme is not supported',
    remedies: ['Use a repository-relative URI, or a `file:` URI with a source root.'],
  },
  'uri-base-invalid': {
    severity: 'error',
    title: 'A URI base is not valid',
    remedies: ['Correct the run\'s `originalUriBaseIds`.'],
  },
  'uri-base-unresolved': {
    severity: 'error',
    title: 'A URI base cannot be resolved',
    remedies: ['Define the base in `originalUriBaseIds`, or pass the producer\'s source root.'],
  },
  'uri-outside-repository': {
    severity: 'error',
    title: 'An artifact URI is outside the repository',
    remedies: ['Pass the producer\'s source root (`--source-root`, `sourceRootUri`), or use a repository-relative URI.'],
  },
  'reviewed-commit-not-in-pull-request': {
    severity: 'error',
    title: 'The reviewed commit does not belong to the pull request',
    remedies: ['Check the reviewed commit: review a commit of this pull request.', 'Check the pull request number.'],
  },
  'reviewed-commit-association-unknown': {
    severity: 'note',
    title: 'Whether the reviewed commit belongs to the pull request is not known',
    remedies: [],
  },
  'source-file-missing': {
    severity: 'error',
    title: 'The file does not exist at the source revision',
    remedies: ['Correct the location, or review the commit the finding refers to.'],
  },
  'source-range-invalid': {
    severity: 'error',
    title: 'A region does not denote text in the file',
    remedies: ['Correct the region against the reviewed source.'],
  },
  'source-coordinates-inconsistent': {
    severity: 'error',
    title: 'A region\'s coordinates disagree',
    remedies: ['Make the region\'s coordinates agree, or give only one kind.'],
  },
  'region-unsupported': {
    severity: 'error',
    title: 'A region form is not supported',
    remedies: ['Express the region in lines and columns or character offsets.'],
  },
  'column-kind-required': {
    severity: 'error',
    title: 'The run needs a columnKind',
    remedies: ['Declare the run\'s `columnKind`.'],
  },
  'snippet-mismatch': {
    severity: 'error',
    title: 'A region\'s snippet is not the source text',
    remedies: ['Correct the region or its snippet, or review the commit it was made from.'],
  },
  'diff-context-inconsistent': {
    severity: 'error',
    title: 'The pull request\'s diff does not match its source',
    remedies: ['Check the reviewed commit and `--old-source-commit`, then run again.'],
  },
  'inline-placement-unavailable': {
    severity: 'warning',
    title: 'A finding is published in the review body',
    remedies: [],
  },
  'fix-association-unsupported': {
    severity: 'error',
    title: 'A finding\'s location is outside its fix',
    remedies: ['Keep the correct location, and separate the feedback from the fix.'],
  },
  'fix-binary-unsupported': {
    severity: 'error',
    title: 'A fix inserts binary content',
    remedies: ['Express the fix as text, or remove it.'],
  },
  'fix-replacements-overlap': {
    severity: 'error',
    title: 'A fix\'s replacements overlap',
    remedies: ['Correct the fix.'],
  },
  'fix-replacements-unlocatable': {
    severity: 'error',
    title: 'A fix\'s replacements cannot be located together',
    remedies: ['Correct the fix against the reviewed source.'],
  },
  'replacement-invalid': {
    severity: 'error',
    title: 'A fix\'s replacement cannot be applied',
    remedies: ['Correct the fix against the reviewed source.'],
  },
  'replacement-unsupported': {
    severity: 'error',
    title: 'A fix\'s replacement form is not supported',
    remedies: ['Express the replacement in lines and columns or character offsets.'],
  },
  'replacement-unanchored': {
    severity: 'error',
    title: 'A fix edits an empty file',
    remedies: ['Propose the content as a new file.'],
  },
  'overlapping-replacements': {
    severity: 'error',
    title: 'Replacements of different findings overlap',
    remedies: ['Reconcile the findings\' fixes.'],
  },
  'suggestion-source-not-reviewed': {
    severity: 'error',
    title: 'A fix edits another revision than the reviewed commit',
    remedies: ['Derive the fix from the reviewed commit.'],
  },
  'alternative-path-unrepresentable': {
    severity: 'error',
    title: 'An alternative fix\'s file path cannot be shown exactly',
    remedies: ['Remove the alternative, or rename the file.'],
  },
  'alternative-content-unrepresentable': {
    severity: 'error',
    title: 'An alternative fix\'s content cannot be shown exactly',
    remedies: ['Remove the alternative, or correct its content.'],
  },
  'alternative-suggestion-fence': {
    severity: 'error',
    title: 'An alternative fix could open a suggestion block',
    remedies: ['Remove the alternative, or change its content.'],
  },
  'file-operation-multiple-unsupported': {
    severity: 'error',
    title: 'A finding proposes several file operations',
    remedies: ['Give each operation its own finding.'],
  },
  'file-operation-unsupported': {
    severity: 'error',
    title: 'A proposed file edit is not published',
    remedies: ['Propose the edit as a SARIF fix.'],
  },
  'file-operation-unknown': {
    severity: 'error',
    title: 'The proposed file operation is unknown',
    remedies: ['Use `create` or `delete`.'],
  },
  'file-operation-conflict': {
    severity: 'error',
    title: 'A finding has both fixes and a file operation',
    remedies: ['Keep either the fixes or the file operation.'],
  },
  'file-operation-invalid': {
    severity: 'error',
    title: 'The proposed file operation is not valid',
    remedies: ['Correct the operation or its artifact as the message says.'],
  },
  'file-operation-path-unrepresentable': {
    severity: 'error',
    title: 'The proposed file\'s path cannot be shown exactly',
    remedies: ['Rename the proposed file.'],
  },
  'file-operation-source-not-reviewed': {
    severity: 'error',
    title: 'A file operation is based on another revision',
    remedies: ['Derive the proposal from the reviewed commit.'],
  },
  'file-operation-binary-unsupported': {
    severity: 'error',
    title: 'A proposed file is binary',
    remedies: ['Remove the proposal.'],
  },
  'file-operation-encoding-unsupported': {
    severity: 'error',
    title: 'A proposed file is not UTF-8',
    remedies: ['Propose the file as UTF-8 text.'],
  },
  'file-operation-content-unrepresentable': {
    severity: 'error',
    title: 'A proposed file\'s content cannot be shown exactly',
    remedies: ['Correct the proposed content.'],
  },
  'file-operation-target-exists': {
    severity: 'error',
    title: 'A proposed new file already exists',
    remedies: ['Propose an edit as a SARIF fix instead, or choose a new path.'],
  },
  'file-operation-target-missing': {
    severity: 'error',
    title: 'A file proposed for deletion does not exist',
    remedies: ['Remove the proposal, or correct its path.'],
  },
  'file-operation-association-unsupported': {
    severity: 'error',
    title: 'A finding is located in another file than its proposal',
    remedies: ['Locate the finding in the proposed file, or separate it from the proposal.'],
  },
  'suggestion-group-member-without-change': {
    severity: 'error',
    title: 'A grouped finding proposes no change',
    remedies: ['Remove the finding from the group, or give it its change.'],
  },
  'suggestion-group-single-change': {
    severity: 'error',
    title: 'A suggestion group holds fewer than two distinct changes',
    remedies: ['Remove the group, and the change is published on its own; or add another change to it.'],
  },
  'suggestion-group-change-shared': {
    severity: 'error',
    title: 'A group\'s change is also proposed outside the group',
    remedies: [
      'Name the finding outside the group in it too (`group-fixes`).',
      'Or take the group\'s findings that carry the change out of the group (`ungroup-fixes`).',
    ],
  },
  'too-many-suggestion-prs': {
    severity: 'error',
    title: 'The review would create too many suggestion pull requests',
    remedies: [
      'Bundle them into one companion pull request (`--companion-bundle single`, `delivery.companionBundle: \'single\'`).',
      'Publish fewer proposals in one review, or group related changes.',
    ],
  },
  'suggestion-pr-permission-missing': {
    severity: 'error',
    title: 'The account cannot push to the repository',
    remedies: ['Use a token of an account with push access, or publish with delivery lists that do not name `companion`.'],
  },
  'suggestion-pr-configuration-invalid': {
    severity: 'error',
    title: 'The suggestion pull request configuration is not valid',
    remedies: ['Fix the file on the default branch.'],
  },
  'suggestion-label-missing': {
    severity: 'error',
    title: 'A suggestion label does not exist',
    remedies: ['Create the label in the repository, or choose an existing one.'],
  },
  'delivery-unavailable': {
    severity: 'error',
    title: 'No delivery mechanism the policy lists is available for a proposal',
    remedies: [
      'Remove the obstacle the message names, then publish again.',
      'Or list a mechanism that is available for this kind of proposal (`--edits`, `--grouped-edits`, `--file-operations`, the `delivery` option, or `.github/sarif-to-comment.json`).',
    ],
  },
  'delivery-fallback': {
    severity: 'warning',
    title: 'A proposal is delivered by a later mechanism of its delivery list',
    remedies: [
      'To use an earlier mechanism, remove the obstacle the message names, then publish again.',
      'To refuse rather than fall back, list only the mechanism you require.',
    ],
  },
  'delivery-configuration-invalid': {
    severity: 'error',
    title: 'The delivery configuration is not valid',
    remedies: ['Fix `.github/sarif-to-comment.json` on the default branch.'],
  },
  'companion-options-unused': {
    severity: 'note',
    title: 'Companion pull request options have no effect',
    remedies: [],
  },
  'companion-conflicts-at-head': {
    severity: 'warning',
    title: "A suggestion pull request is projected to conflict with the pull request's head",
    remedies: ['Review the pull request\'s current head again, and publish that review.', 'Or resolve the conflict when merging the suggestion pull request.'],
  },
  'too-many-comments': {
    severity: 'error',
    title: 'The review needs too many inline comments',
    remedies: ['Publish fewer findings in one review.'],
  },
  'comment-too-large': {
    severity: 'error',
    title: 'An inline comment would be too long',
    remedies: ['Shorten the finding\'s message or its fix.'],
  },
  'body-too-large': {
    severity: 'error',
    title: 'The review body would be too long',
    remedies: ['Publish fewer general findings, or deliver whole-file proposals as companion pull requests (`--file-operations companion`).'],
  },
  'payload-too-large': {
    severity: 'error',
    title: 'The review would be too large to send',
    remedies: ['Publish fewer findings in one review.'],
  },
  'pending-review-exists': {
    severity: 'error',
    title: 'The account already has a pending review on the pull request',
    remedies: ['Submit or delete that pending review on GitHub.', 'If it is this tool\'s own earlier publication, retry publish with that publication\'s state path.'],
  },
  'assessment-incomplete': {
    severity: 'error',
    title: 'Readiness could not be assessed',
    remedies: ['Resolve the cause, then validate again.'],
  },
  'publication-receipt-not-recorded': {
    severity: 'warning',
    title: 'Completion could not be recorded in the state file',
    remedies: ['Keep the state file: a later run with the same state path confirms the review without sending it again.'],
  },
  'delivery-unconfirmed': {
    severity: 'warning',
    title: 'Delivery could not be confirmed',
    remedies: ['Retry later with the same state path: it only checks GitHub and never sends the same thing again.', 'Do not delete the state file.', 'A new state path starts a new, separate publication.'],
  },
  'review-refused': {
    severity: 'error',
    title: 'GitHub refused the review',
    remedies: ['Resolve the cause, then publish again with a new state path.'],
  },
  'suggestion-pr-step-refused': {
    severity: 'error',
    title: 'GitHub refused a suggestion pull request step',
    remedies: ['Resolve the cause, then publish again with a new state path; anything already created is left as it is.'],
  },
  'suggestion-branch-moved': {
    severity: 'note',
    title: 'The branch changed since the suggestions were planned',
    remedies: [],
  },
  'suggestion-branch-unreadable': {
    severity: 'warning',
    title: 'Whether the branch changed since the suggestions were planned is not known',
    remedies: [],
  },
  'original-pull-request-unverified': {
    severity: 'warning',
    title: 'An original pull request could not be verified',
    remedies: ['Run cleanup again later.'],
  },
  'original-pull-request-not-found': {
    severity: 'warning',
    title: 'The original pull request was not found',
    remedies: ['Check the pull request number.'],
  },
  'suggestion-pr-close-not-permitted': {
    severity: 'warning',
    title: 'GitHub did not allow this account to close a suggestion pull request',
    remedies: ['Someone allowed to close it can run cleanup again.'],
  },
  'suggestion-pr-cleanup-failed': {
    severity: 'error',
    title: 'Reading or closing a suggestion pull request failed',
    remedies: ['Run cleanup again later.'],
  },
  'suggestion-pr-not-conforming': {
    severity: 'note',
    title: 'A pull request does not follow the suggestion pull request convention',
    remedies: [],
  },
  'suggestion-pr-candidates-over-limit': {
    severity: 'error',
    title: 'The sweep found more candidates than its limit',
    remedies: [
      'Narrow the cleanup to one original pull request with `--original N` (library: `originalPullNumber`).',
      'If the count is expected, raise the limit above it with `--max-candidates N` (library: `maxCandidates`). The branches under `suggestion-pr/` include those of suggestions already closed, because cleanup never deletes a branch, so the count grows over time.',
    ],
  },
  'label-not-suggestion-prs': {
    severity: 'warning',
    title: 'The label does not seem to mark suggestion pull requests',
    remedies: [
      'Check the label: `--label` names the label suggestion pull requests were left under.',
      'If the label is right, run again with `--force` (library: `force: true`) to check every pull request carrying it.',
    ],
  },
} as const satisfies Readonly<Record<string, IDiagnosticCatalogEntry>>;

/** A catalogued diagnostic code. */
export type DiagnosticCode = keyof typeof DIAGNOSTIC_CATALOG;

/** Whether `value` is a catalogued code. */
export function isDiagnosticCode(value: unknown): value is DiagnosticCode {
  return typeof value === 'string' && Object.hasOwn(DIAGNOSTIC_CATALOG, value);
}
