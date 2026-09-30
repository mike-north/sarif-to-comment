'use strict';

/**
 * The sarif-to-comment command-line interface (src/sarif-to-comment.cts runs
 * `main`). It is a file-oriented transport over the public library: every
 * SARIF, Git and GitHub interpretation is the library's (src/index.cts), and
 * this module adds only argument handling, file I/O (src/artifact-files.cts),
 * credential selection, output formatting and exit statuses.
 *
 * Commands (contract: docs/second-milestone-contract-proposal.md §3, §5, §6):
 *   init                create a SARIF file              createSarifDocument
 *   add-comment         add one finding, in place        addSarifComment
 *   remove-comment      remove one finding, in place     removeSarifComment
 *   group-fixes         group fixes for joint            groupSarifFixes
 *                       acceptance, in place or to a copy
 *   ungroup-fixes       undo a grouping                  ungroupSarifFixes
 *   inspect             read-only view of a SARIF file   inspectSarif
 *   add-staged-changes  add staged Git changes to a copy addStagedChangesToSarif
 *   validate            readiness, without publishing    validateSarifReview
 *   publish             create the GitHub review         publishSarifReview
 *                       (a draft; --submit: submitted;
 *                       --allow-suggestion-prs: with
 *                       suggestion pull requests)
 *   close-suggestion-prs close suggestion pull requests  closeSuggestionPullRequests
 *                       whose original ended
 *                       (docs/suggestion-cleanup-contract.md)
 * A first argument beginning with "-" (or no argument) is the original
 * flag-only publisher, which keeps its exact behavior, output, credentials and
 * exit statuses. Anything else is a usage error. `--help` (or `-h`) anywhere
 * prints help instead of running anything; otherwise `--version` anywhere
 * prints the package's version, read from its package.json at run time.
 *
 * Output format (`--format human|json|toon`, default human, never inferred
 * from a terminal) and `--color auto|always|never` are resolved before
 * anything else, wherever they appear. An invalid, missing or repeated value
 * is a human usage error on stderr with nothing on stdout; its remedy names
 * the help of the command given, wherever the option stands. Once JSON or TOON
 * is selected, every handled outcome — including help, usage errors and
 * operational errors — is exactly one document on stdout and nothing is
 * written to stderr; TOON is the JSON document encoded as TOON. The envelope
 * is `{ command, status, ..., diagnostics }` where `command` is null only when
 * no command was identified and `diagnostics` is always last
 * (docs/diagnostics.md). Human mode writes the primary result (what was
 * created, written, inspected, checked, published or closed, and what
 * happened to each file) to stdout and the diagnostics, as colored blocks
 * when color is on, to stderr.
 *
 * Exit statuses: 0 success, help or version; 1 usage error or operational error; 2 the
 * content was refused (`invalid` / `failed` / `stale` / `refused`). `publish` keeps the publisher's
 * statuses: 0 published, 2 blocked, 3 uncertain, 1 otherwise. `validate`
 * (docs/readiness-assessment-contract.md): 0 ready, 2 blocked, 1 incomplete
 * or otherwise. `close-suggestion-prs`: 0 complete (a dry run too), 2
 * permission-limited or a label that does not mark suggestion pull requests,
 * 3 incomplete, 1 more candidates than the limit, or a usage or operational
 * error (before anything was closed).
 *
 * Receipts name only files actually written, archived, or deliberately not
 * written (`written: false`). The GitHub token (GH_TOKEN, else GITHUB_TOKEN)
 * is used only by `validate`, `publish` and `close-suggestion-prs` and is
 * redacted from every output in both modes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as files from './artifact-files.cjs';
import type { IArchivedOutput, IJsonFile, ReleaseOwnership } from './artifact-files.cjs';
import { closeSuggestionPullRequestsReported } from './close-suggestion-pull-requests.cjs';
import type { CloseSuggestionPullRequestsStatus, ICloseSuggestionPullRequestsInternals } from './close-suggestion-pull-requests.cjs';
import { publishSarifReviewReported } from './publish-sarif-review.cjs';
import type { ISarifSourceBinding } from './public-types.cjs';
import { parseFindingSelector } from './finding-selectors.cjs';
import { createSarifDocument, addSarifCommentWithUntypedInput, removeSarifCommentWithUntypedInput } from './sarif-authoring.cjs';
import type { ICreateSarifDocumentOptions, INewSarifRun, ISarifComment } from './sarif-authoring.cjs';
import { isNormalizedRepositoryPath, isSuggestionGroupName, packageVersion, OWNER_PATTERN, REPO_PATTERN } from './sarif-common.cjs';
import { inspectSarifWithUntypedInput, renderInspectionText } from './sarif-inspection.cjs';
import { groupSarifFixesWithUntypedInput, ungroupSarifFixesWithUntypedInput } from './suggestion-groups.cjs';
import { LABEL_RULE, isLabelName } from './suggestion-pr-convention.cjs';
import type { IInspectSarifOptions } from './sarif-inspection.cjs';
import { addStagedChangesToSarifWithUntypedInput } from './staged-changes.cjs';
import type { IStagedChangesReceipt } from './staged-changes.cjs';
import { validateSarifReviewReported } from './validate-sarif-review.cjs';
import { createDiagnostic, orderDiagnostics } from './diagnostics.cjs';
import type { IDiagnostic } from './diagnostics.cjs';
import { PLAIN_STYLE, loadColorStyle, renderDiagnostics, shouldUseColor } from './diagnostic-rendering.cjs';
import type { ColorChoice } from './diagnostic-rendering.cjs';
import type { IValidateSarifReviewInternals } from './validate-sarif-review.cjs';

const md = String.raw;

/** A CLI command, in workflow order. */
type CliCommand =
  | 'init'
  | 'add-comment'
  | 'remove-comment'
  | 'group-fixes'
  | 'ungroup-fixes'
  | 'inspect'
  | 'add-staged-changes'
  | 'validate'
  | 'publish'
  | 'close-suggestion-prs';

/** The commands, in workflow order. */
const COMMANDS: readonly CliCommand[] = [
  'init', 'add-comment', 'remove-comment', 'group-fixes', 'ungroup-fixes', 'inspect', 'add-staged-changes', 'validate', 'publish', 'close-suggestion-prs',
];

/**
 * The private test seam the executable passes to the GitHub-using
 * operations. Its client serves all of them: assessment needs the
 * authenticated user as well as the review context, publication validates its
 * transport itself, and cleanup checks for its own methods.
 */
type CliInternals = IValidateSarifReviewInternals & ICloseSuggestionPullRequestsInternals;

/** Exit statuses for non-publication outcomes (§5). */
const EXIT: Readonly<{ ok: 0; usage: 1; error: 1; refused: 2 }> = Object.freeze({ ok: 0, usage: 1, error: 1, refused: 2 });

/** Exit statuses for readiness assessment (docs/readiness-assessment-contract.md). */
const VALIDATE_EXIT: Readonly<{ ready: 0; blocked: 2; incomplete: 1 }> = Object.freeze({ ready: 0, blocked: 2, incomplete: 1 });

/**
 * Exit statuses for suggestion pull request cleanup
 * (docs/suggestion-cleanup-contract.md §2.10): a sweep over its candidate
 * limit is refused like any other failure before a write (1); a label that
 * does not look like a suggestion label is a warning that needs a decision,
 * like a permission limit (2).
 */
const CLEANUP_EXIT: Readonly<Record<CloseSuggestionPullRequestsStatus, number>> = Object.freeze({
  complete: 0,
  'permission-limited': 2,
  incomplete: 3,
  'too-many-candidates': 1,
  'label-not-suggestion-prs': 2,
});

/** Exit statuses for publication, unchanged from the flag-only publisher. */
const PUBLISH_EXIT: Readonly<{ published: 0; blocked: 2; uncertain: 3; rejected: 1 }> = Object.freeze({
  published: 0,
  blocked: 2,
  uncertain: 3,
  rejected: 1,
});

const COMMIT_FLAG_PATTERN = /^[0-9a-f]{40}$/;
const REPO_FLAG_PATTERN = /^([^/\s]+)\/([^/\s]+)$/;

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

/** The pull request and reviewed commit, shared by publish and validate. */
const REVIEW_TARGET_OPTIONS = md`  --repo OWNER/REPO              Repository of the pull request.
  --pull N                       Pull request number.
  --commit FULLSHA               Full 40-character commit the review is about.
`;

/** How the document is read and judged, shared by publish and validate. */
const REVIEW_POLICY_OPTIONS = md`  --source-root ABSOLUTE_FILE_URI
                                 Repository root in the SARIF producer's file
                                 system (file:///.../ ending in "/").
  --old-source-commit FULLSHA    Candidate commit for the diff's old side, used
                                 only when GitHub's comparison cannot establish
                                 it; verified against the pull request's
                                 patches.
  --ignore-approval-hold         Publish despite an approval hold (bypasses only
                                 the hold, never validation).
  --submit                       Create the review already submitted, as a
                                 comment review, instead of a draft. Never
                                 approves or requests changes. Retry a
                                 publication with the mode it started with.
  --allow-suggestion-prs         Allow suggestion pull requests: propose
                                 whole-file creations and deletions, fixes with
                                 several changes, and changes grouped with
                                 group-fixes, as pull requests into the pull
                                 request's head branch, linked from the review.
                                 They carry the repository's suggestion label
                                 (suggestion-pr, or the label in
                                 .github/suggestion-prs.json on the default
                                 branch), which must already exist.
  --pr-labels A,B,C              Extra existing labels for suggestion pull
                                 requests, comma-separated. Needs
                                 --allow-suggestion-prs.
  --mark-suggestion-prs-ready    Create suggestion pull requests ready for
                                 review instead of as drafts. Needs
                                 --allow-suggestion-prs.
`;

const PUBLISH_OPTIONS = md`  --sarif FILE                   SARIF 2.1.0 JSON file to publish.
${REVIEW_TARGET_OPTIONS}  --state ABSOLUTE_FILE          Durable publication state. Retry with the same
                                 file; never delete it after an uncertain
                                 result. A new file starts a separate review.
${REVIEW_POLICY_OPTIONS}`;

const VALIDATE_OPTIONS = md`  --sarif FILE                   SARIF 2.1.0 JSON file to check.
${REVIEW_TARGET_OPTIONS}${REVIEW_POLICY_OPTIONS}`;

const CREDENTIALS = md`Credentials (validate, publish and close-suggestion-prs only):
  GH_TOKEN, or else GITHUB_TOKEN: a GitHub personal access token or user token.
  GitHub App installation tokens (including the automatic Actions token) are
  not supported. There is no token flag.
`;

const FORMAT_OPTION = md`  --format human|json|toon       Output format (default human). JSON and TOON
                                 print one document on stdout for every outcome.
  --color auto|always|never      Color diagnostics (default auto: only on a
                                 terminal; NO_COLOR and FORCE_COLOR apply).
`;

/**
 * Help text: the top-level usage and each command's. Every line fits in 80
 * columns, prose is filled to that width, and each title is the command and a
 * lowercase phrase saying what it does (test/cli-commands.test.mts).
 */
const USAGE: Readonly<Record<'top' | CliCommand, string>> = {
  top: md`sarif-to-comment — author, inspect and publish SARIF as one GitHub draft review

Usage:
  sarif-to-comment init --output FILE [options]
  sarif-to-comment add-comment --sarif FILE --file PATH --line N
                   (--message TEXT | --message-file FILE|-) [options]
  sarif-to-comment remove-comment --sarif FILE --finding SELECTOR [options]
  sarif-to-comment group-fixes --sarif FILE --finding SELECTOR [...]
                   --group NAME [options]
  sarif-to-comment ungroup-fixes --sarif FILE --finding SELECTOR [...] [options]
  sarif-to-comment inspect --sarif FILE [options]
  sarif-to-comment add-staged-changes --sarif IN --output OUT --worktree DIR
                   --repo OWNER/REPO --commit FULLSHA [options]
  sarif-to-comment validate --sarif FILE --repo OWNER/REPO --pull N
                   --commit FULLSHA [options]
  sarif-to-comment publish --sarif FILE --repo OWNER/REPO --pull N
                   --commit FULLSHA --state ABSOLUTE_FILE [options]
  sarif-to-comment close-suggestion-prs --repo OWNER/REPO [options]
  sarif-to-comment --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA
                   --state ABSOLUTE_FILE [--source-root ABSOLUTE_FILE_URI]
                   [--old-source-commit FULLSHA] [--ignore-approval-hold]
                   [--submit] [--allow-suggestion-prs [--pr-labels A,B,C]
                   [--mark-suggestion-prs-ready]]
  sarif-to-comment [COMMAND] --help
  sarif-to-comment --version

Commands:
  init                 Create a SARIF document for your own findings.
  add-comment          Add one finding on a line or line range to a SARIF file.
  remove-comment       Remove a finding and its attached fixes from the SARIF
                       document.
  group-fixes          Group fixes of several findings to be accepted together.
  ungroup-fixes        Remove findings from their suggestion groups.
  inspect              Show the findings, locations and fixes in a SARIF file.
  add-staged-changes   Add proposed changes from the Git index to a SARIF
                       document.
  validate             Check, without publishing, that a SARIF file can be
                       published.
  publish              Publish a SARIF file as one GitHub pull request review
                       (a draft unless --submit).
  close-suggestion-prs Close suggestion pull requests whose original pull
                       request has merged or closed.

Every command reads and writes ordinary SARIF files; SARIF from any producer can
be inspected, extended and published without init.

Publishing without a command (the original form) takes the publish options:
${PUBLISH_OPTIONS}${FORMAT_OPTION}  --help                         Show help. Needs no token, makes no request.
  --version                      Show the package version. Needs no token, makes
                                 no request.

${CREDENTIALS}
Exit status:
  0  success; published (or already published); ready; cleanup complete
  2  refused content: blocked (nothing was published), invalid/failed input,
     a refused grouping, or a stale finding selector; cleanup left pull
     requests it may not close, or its --label does not mark suggestion
     pull requests
  3  uncertain: delivery could not be confirmed; retry with the same --state;
     cleanup incomplete (safe to run again)
  1  usage error, unreadable file, refused request, incomplete validation,
     cleanup candidates over the limit, or operational failure
`,
  init: md`sarif-to-comment init — create a SARIF document for your own findings

Usage:
  sarif-to-comment init --output FILE [--tool-name NAME [--tool-version V]]
                        [--repo OWNER/REPO --commit FULLSHA]
                        [--format human|json|toon]

Options:
  --output FILE                  New SARIF file; an existing file is refused.
  --tool-name NAME               Who the findings come from (default:
                                 sarif-to-comment), for example "Review agent".
  --tool-version V               Version of that tool (only with --tool-name).
  --repo OWNER/REPO              Bind the run to this repository ...
  --commit FULLSHA               ... at this full 40-character reviewed commit.
                                 Give both or neither.
${FORMAT_OPTION}
Exit status: 0 created; 1 usage error or the file could not be created.
`,
  'add-comment': md`sarif-to-comment add-comment — add one finding to a SARIF file

Usage:
  sarif-to-comment add-comment --sarif FILE --file PATH --line N
                               [--end-line M]
                               (--message TEXT | --message-file FILE|-)
                               [--markdown] [--rule-id ID]
                               [--level none|note|warning|error]
                               [--run N | --new-run-tool NAME
                                          [--new-run-tool-version V]
                                          [--repo OWNER/REPO --commit FULLSHA]]
                               [--format human|json|toon]

The SARIF file is updated in place (atomically). Line numbers are one-based and
refer to the reviewed revision of the file (or to the proposed content of a file
that the reviewed revision does not have).

Options:
  --sarif FILE                   SARIF file to update.
  --file PATH                    Repository-relative path the finding is about.
  --line N                       First line of the finding.
  --end-line M                   Last line (inclusive); default: --line.
  --message TEXT                 The finding's full text.
  --message-file FILE|-          Read the text from a UTF-8 file, or "-" for
                                 stdin.
  --markdown                     The text is Markdown.
  --rule-id ID                   Rule identifier to record.
  --level LEVEL                  none, note, warning or error (omitted
                                 otherwise).
  --run N                        Add to existing run N (needed when there are
                                 several).
  --new-run-tool NAME            Add to a new run attributed to NAME, so another
                                 tool is never credited with your finding.
  --new-run-tool-version V       Version of that tool.
  --repo OWNER/REPO              Bind the new run to this repository ...
  --commit FULLSHA               ... at this reviewed commit. Give both or
                                 neither.
${FORMAT_OPTION}
While it runs, the command owns FILE through a marker file
".<name>.sarif-to-comment-lock" beside it; another command's marker is never
taken over.

Exit status: 0 added; 2 the SARIF file is not valid SARIF; 1 usage error or the
file could not be read or replaced.
`,
  'remove-comment': md`sarif-to-comment remove-comment — remove a finding from a SARIF file

Usage:
  sarif-to-comment remove-comment --sarif FILE --finding SELECTOR
                                  [--format human|json|toon]

Remove a finding and its attached fixes from the SARIF document. The whole
finding goes, with every fix and proposed file operation attached to it; every
other finding and fix stays as it is, including identical ones. The SARIF file
is updated in place (atomically); no GitHub review is changed.

Take SELECTOR from inspect: "Selector:" under each finding, or "selector" in
JSON. It belongs to the file exactly as inspected, so inspect again after any
change. A selector the file no longer fits is refused, never applied to
whichever finding has moved into its place.

To correct a finding, remove it and add the corrected one with add-comment. If
you made an output with add-staged-changes, run it again on the corrected file
rather than editing that output.

Options:
  --sarif FILE                   SARIF file to update.
  --finding SELECTOR             The finding's selector from inspect.
${FORMAT_OPTION}
While it runs, the command owns FILE through a marker file
".<name>.sarif-to-comment-lock" beside it; another command's marker is never
taken over.

Exit status: 0 removed; 2 the selector is stale (the file changed since it was
inspected) or the file is not valid SARIF; 1 usage error or the file could not
be read or replaced.
`,
  'group-fixes': md`sarif-to-comment group-fixes — group fixes to be accepted together

Usage:
  sarif-to-comment group-fixes --sarif FILE --finding SELECTOR [...]
                               --group NAME [--output FILE]
                               [--format human|json|toon]

Records that the changes of the selected findings must be accepted together:
each finding gets the same properties.sarifToComment.suggestionGroup. A NAME
already in use extends that group, so a single finding may be added; groups are
never joined. A finding's change is its primary (first) fix, or its proposed
whole-file operation; further fixes are alternatives and are never grouped.
Publishing with --allow-suggestion-prs proposes the group as one suggestion pull
request; without it, publication refuses the group and never splits it. A single
fix with several changes is already accepted whole and needs no group.

Take each SELECTOR from inspect: "Selector:" under each finding, or "selector"
in JSON. Selectors belong to the file exactly as inspected, so inspect again
after any change. Refused, with nothing changed: a stale selector, a finding
already in another group or without a change, or a group of fewer than two
distinct changes.

The SARIF file is updated in place (atomically) unless --output names a new
file.

Options:
  --sarif FILE                   SARIF file to read (and update in place).
  --finding SELECTOR             A finding's selector from inspect; repeat for
                                 more. A new group needs at least two distinct
                                 changes.
  --group NAME                   The group's name, shown in the suggestion pull
                                 request's title: 1-100 characters, no control
                                 or invisible characters, no surrounding spaces.
  --output FILE                  Write the result to this new file instead; an
                                 existing file is refused and --sarif is not
                                 changed.
${FORMAT_OPTION}
While it runs, the command owns the file it writes through a marker file
".<name>.sarif-to-comment-lock" beside it; another command's marker is never
taken over.

Exit status: 0 grouped; 2 refused, a stale selector, or not valid SARIF; 1 usage
error or a file could not be read or written.
`,
  'ungroup-fixes': md`sarif-to-comment ungroup-fixes — remove findings from their suggestion groups

Usage:
  sarif-to-comment ungroup-fixes --sarif FILE --finding SELECTOR [...]
                                 [--output FILE] [--format human|json|toon]

Removes properties.sarifToComment.suggestionGroup from each selected finding, so
its fix is published on its own again. A group is never left with fewer than two
distinct changes, which publication would always refuse: to dissolve a group,
select all of its findings (a refusal lists the rest).

Take each SELECTOR from inspect, as for group-fixes. The SARIF file is updated
in place (atomically) unless --output names a new file.

Options:
  --sarif FILE                   SARIF file to read (and update in place).
  --finding SELECTOR             A finding's selector from inspect; repeat for
                                 more.
  --output FILE                  Write the result to this new file instead; an
                                 existing file is refused and --sarif is not
                                 changed.
${FORMAT_OPTION}
While it runs, the command owns the file it writes through a marker file
".<name>.sarif-to-comment-lock" beside it; another command's marker is never
taken over.

Exit status: 0 ungrouped; 2 refused, a stale selector, or not valid SARIF; 1
usage error or a file could not be read or written.
`,
  inspect: md`sarif-to-comment inspect — show the findings and fixes in a SARIF file

Usage:
  sarif-to-comment inspect --sarif FILE [--preview-lines N|all]
                           [--preview-chars N|all]
                           [--source-root ABSOLUTE_FILE_URI]
                           [--format human|json|toon]

Shows every finding with its full text, locations, fixes and suggestion group,
and the selector remove-comment, group-fixes and ungroup-fixes take. Only fix
previews are shortened, and visibly so. The file is not changed and nothing is
contacted. Inspection is not a check that the file can be published.

Options:
  --sarif FILE                   SARIF file to inspect.
  --preview-lines N|all          Lines shown per fix preview (default 20).
  --preview-chars N|all          Characters shown per fix preview (default
                                 2000).
  --source-root ABSOLUTE_FILE_URI
                                 Repository root in the SARIF producer's file
                                 system (file:///.../ ending in "/").
${FORMAT_OPTION}
Exit status: 0 inspected; 2 not valid SARIF; 1 usage error or unreadable file.
`,
  'add-staged-changes': md`sarif-to-comment add-staged-changes — add staged Git changes as SARIF fixes

Usage:
  sarif-to-comment add-staged-changes --sarif IN --output OUT --worktree DIR
                                      --repo OWNER/REPO --commit FULLSHA
                                      [--source-root ABSOLUTE_FILE_URI]
                                      [--format human|json|toon]

Add proposed changes from the Git index to a SARIF document. The command reads
what is staged in DIR's Git index (never unstaged working-tree content),
compares it with the reviewed commit, and writes a copy of IN to OUT in which
the staged changes are fixes on the findings they belong to. Source files and
the index are not changed.

Options:
  --sarif IN                     SARIF file to start from (not changed).
  --output OUT                   Where to write the result; must differ from IN.
  --worktree DIR                 A directory in the Git working tree whose index
                                 is read.
  --repo OWNER/REPO              GitHub repository recorded as the fixes'
                                 source.
  --commit FULLSHA               Reviewed commit the staged changes are compared
                                 with.
  --source-root ABSOLUTE_FILE_URI
                                 Repository root in the SARIF producer's file
                                 system.
${FORMAT_OPTION}
Existing output is preserved: an existing OUT is first renamed, beside it, to
"<UTC time>.old.<name>" (its creation time, or its modification time when the
system does not record one). If the command then fails, no OUT is written. While
it runs, the command owns OUT through a marker file
".<name>.sarif-to-comment-lock" beside it.

Exit status: 0 written; 2 invalid SARIF or a staged change that cannot be
represented faithfully (nothing written); 1 usage error or operational failure.
`,
  validate: md`sarif-to-comment validate — check that a SARIF file can be published

Usage:
  sarif-to-comment validate --sarif FILE --repo OWNER/REPO --pull N
                            --commit FULLSHA [--source-root ABSOLUTE_FILE_URI]
                            [--old-source-commit FULLSHA]
                            [--ignore-approval-hold] [--submit]
                            [--allow-suggestion-prs [--pr-labels A,B,C]
                            [--mark-suggestion-prs-ready]]
                            [--format human|json|toon]

Runs every check publish runs, reading the pull request and its source from
GitHub, and stops before publishing: nothing is written to GitHub and no file is
written. It also reads the pull request's reviews: a pending review of yours
already there is reported as blocked, because GitHub refuses another review,
draft or submitted, while it exists. A ready result is not an approval: publish
repeats every check against the pull request as it is then. Validation takes no
publication state file and reserves no publication.

Options:
${VALIDATE_OPTIONS}${FORMAT_OPTION}
${CREDENTIALS}
Exit status:
  0  ready: publish would create the review
  2  blocked: publish would refuse, or GitHub would refuse a pending review of
     yours; every problem is listed
  1  incomplete: the check could not be completed (for example the credential,
     the network or a source read failed), or a usage error, unreadable SARIF
     file or operational failure
`,
  publish: md`sarif-to-comment publish — publish a SARIF file as one GitHub review

Usage:
  sarif-to-comment publish --sarif FILE --repo OWNER/REPO --pull N
                           --commit FULLSHA --state ABSOLUTE_FILE
                           [--source-root ABSOLUTE_FILE_URI]
                           [--old-source-commit FULLSHA]
                           [--ignore-approval-hold] [--submit]
                           [--allow-suggestion-prs [--pr-labels A,B,C]
                           [--mark-suggestion-prs-ready]]
                           [--format human|json|toon]

The same operation as the original form without a command. The review is a draft
unless --submit is given.

Options:
${PUBLISH_OPTIONS}${FORMAT_OPTION}
${CREDENTIALS}
Exit status:
  0  published (or already published)
  2  blocked: nothing was published
  3  uncertain: delivery could not be confirmed; retry with the same --state
  1  usage error, unreadable SARIF file, refused request, or operational failure
`,
  'close-suggestion-prs': md`sarif-to-comment close-suggestion-prs — close suggestions whose original ended

Usage:
  sarif-to-comment close-suggestion-prs --repo OWNER/REPO [--owner me|all]
                                        [--label NAME [--force]] [--original N]
                                        [--max-candidates N] [--dry-run]
                                        [--format human|json|toon]

Closes open suggestion pull requests (made by publish --allow-suggestion-prs, or
by any tool following the suggestion pull request convention) whose original
pull request has merged or closed. They are found by their suggestion-pr/
branches and recognized by the marker in their description, never by their
title. They must carry the repository's suggestion label: suggestion-pr, or the
label in .github/suggestion-prs.json on the default branch; an invalid file
stops the command. By default only suggestion pull requests opened by the
account of the token are closed. A suggestion is closed only after its original
has been read and found merged or closed and the suggestion itself has been read
again; an original that cannot be read is never treated as ended. Everything is
read before anything is closed. Closing never deletes a branch, and nothing else
is changed. Running it again is safe.

A sweep first counts its candidates in one request, and checks nothing when
there are more than the limit. A --label sweep whose first 20 pull requests show
no suggestion marker and no suggestion-pr/ branch stops as well.

Options:
  --repo OWNER/REPO              Repository whose suggestion pull requests are
                                 checked.
  --owner me|all                 Whose suggestion pull requests may be closed,
                                 by who opened them (default me: the account of
                                 the token). Others are reported and left open.
  --label NAME                   Check the open pull requests with this label
                                 instead, for suggestions left under a
                                 previously configured label. The repository's
                                 suggestion label is then not read.
  --force                        With --label: check every pull request even
                                 when the first 20 do not look like suggestion
                                 pull requests.
  --original N                   Check only the pull requests that reference
                                 original pull request N, instead of sweeping.
                                 If N does not exist, nothing can reference it:
                                 the cleanup is complete, with a warning.
  --max-candidates N             The most candidates a sweep checks: suggestion
                                 branches, or pull requests with the --label
                                 (default 500). More stops it before any check.
  --dry-run                      Read and verify everything, close nothing.
${FORMAT_OPTION}
${CREDENTIALS}
Exit status:
  0  complete: nothing left to do (also a dry run, and an --original pull
     request that does not exist)
  2  permission-limited: some suggestion pull requests could not be closed with
     this token; someone allowed to close them can finish. Also: the --label
     does not mark suggestion pull requests (nothing was checked; see --force)
  3  incomplete: an original could not be verified or an action failed; run
     it again later
  1  usage error, missing token, more candidates than --max-candidates, or
     operational failure (nothing was closed)
`,
};

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

/** A command-line mistake the user fixes by changing the arguments. */
class UsageError extends Error {}

/** An output format; human is the default and is never inferred from a terminal. */
type OutputFormat = 'human' | 'json' | 'toon';

/** Parsed options: each value option's value, each repeatable option's values in order, and the boolean flags given. */
interface IParsedOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly lists: ReadonlyMap<string, readonly string[]>;
  readonly flags: ReadonlySet<string>;
}

/**
 * The options a command accepts; every other option is a usage error.
 * `repeatable` options take a value and may be given several times;
 * `required` may name value and repeatable options alike.
 */
interface IOptionSpec {
  readonly values: readonly string[];
  readonly repeatable?: readonly string[];
  readonly booleans?: readonly string[];
  readonly required?: readonly string[];
}

/**
 * The argument at `index`, which the caller's loop bound keeps in range.
 * (An out-of-range read would be a defect in this module, never user input.)
 */
function argAt(argv: readonly string[], index: number): string {
  const arg = argv[index];
  if (arg === undefined) throw new Error(`Internal error: argument ${String(index)} is outside a list of ${String(argv.length)}.`);
  return arg;
}

/** The options every invocation takes, resolved before anything else. */
interface IGlobalOptions {
  readonly format: OutputFormat;
  readonly color: ColorChoice;
  /** The arguments without them. */
  readonly argv: string[];
}

/**
 * Removes one value-typed global option from argv and resolves it: its value
 * must be one of `allowed`, and it may be given once. Throws UsageError
 * (always reported in human form) when it is repeated, valueless or unknown.
 */
function takeGlobalOption<T extends string>(argv: readonly string[], name: string, allowed: readonly T[]): { readonly value: T | undefined; readonly argv: string[] } {
  const choices = `${allowed.slice(0, -1).join(', ')} or ${String(allowed.at(-1))}`;
  const rest: string[] = [];
  let value: T | undefined;
  let seen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argAt(argv, i);
    let given: string;
    if (arg === name) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${name} requires a value: ${choices}`);
      given = next;
      i += 1;
    } else if (arg.startsWith(`${name}=`)) {
      given = arg.slice(name.length + 1);
    } else {
      rest.push(arg);
      continue;
    }
    if (seen) throw new UsageError(`${name} was given more than once`);
    seen = true;
    const match = allowed.find((choice) => choice === given);
    if (match === undefined) throw new UsageError(`${name} must be ${choices}, not ${JSON.stringify(given)}`);
    value = match;
  }
  return { value, argv: rest };
}

/** The value-typed options every invocation takes, wherever they appear. */
const GLOBAL_OPTIONS: readonly string[] = ['--format', '--color'];

/** Removes and resolves `--format` and `--color`; throws UsageError. */
function resolveGlobalOptions(argv: readonly string[]): IGlobalOptions {
  const format = takeGlobalOption<OutputFormat>(argv, '--format', ['human', 'json', 'toon']);
  const color = takeGlobalOption<ColorChoice>(format.argv, '--color', ['auto', 'always', 'never']);
  return { format: format.value ?? 'human', color: color.value ?? 'auto', argv: color.argv };
}

/**
 * The command an invocation names, found without resolving its global
 * options, so that a mistake in one of them can still point to the
 * command's own help: the first argument that is neither a global option nor
 * the value takeGlobalOption would take for it. Null when that argument is
 * not a command (the flag-only publisher, or an unknown command), whose help
 * is the top-level help.
 */
function commandNamedIn(argv: readonly string[]): CliCommand | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argAt(argv, i);
    if (GLOBAL_OPTIONS.includes(arg)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) i += 1;
    } else if (!GLOBAL_OPTIONS.some((name) => arg.startsWith(`${name}=`))) {
      return isCommand(arg) ? arg : null;
    }
  }
  return null;
}

/**
 * Parses `--flag value` / `--flag=value` options exactly, as the flag-only
 * publisher always has: unknown, repeated, valueless or empty options and
 * positional arguments are usage errors, except that a repeatable option
 * collects every value in order. Returns { values: Map, lists: Map, flags: Set }.
 */
function parseOptions(argv: readonly string[], { values: valueFlags, repeatable = [], booleans = [], required = [] }: IOptionSpec): IParsedOptions {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argAt(argv, i);
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument ${arg}`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name === '--token') {
      throw new UsageError('unknown option --token: the token is read only from GH_TOKEN or GITHUB_TOKEN');
    }
    if (booleans.includes(name)) {
      if (eq !== -1) throw new UsageError(`${name} takes no value`);
      if (flags.has(name)) throw new UsageError(`${name} was given more than once`);
      flags.add(name);
      continue;
    }
    const listed = repeatable.includes(name);
    if (!listed && !valueFlags.includes(name)) throw new UsageError(`unknown option ${name}`);
    if (values.has(name)) throw new UsageError(`${name} was given more than once`);
    let value: string;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${name} requires a value`);
      value = next;
      i += 1;
    }
    if (value === '') throw new UsageError(`${name} requires a non-empty value`);
    if (listed) lists.set(name, [...(lists.get(name) ?? []), value]);
    else values.set(name, value);
  }
  const missing = required.filter((flag) => !values.has(flag) && !lists.has(flag));
  if (missing.length > 0) throw new UsageError(`missing required option ${missing.join(', ')}`);
  return { values, lists, flags };
}

/**
 * A required option's value. parseOptions has already refused its absence,
 * so a missing value is a defect in this module, never user input.
 */
function requiredValue(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) throw new Error(`Internal error: required option ${flag} was not parsed.`);
  return value;
}

/** OWNER/REPO from a flag, validated as GitHub names; throws UsageError. */
function repositoryFlag(values: ReadonlyMap<string, string>, flag = '--repo'): { readonly owner: string; readonly repo: string } {
  // String() is the conversion RegExp#exec applies itself.
  const match = REPO_FLAG_PATTERN.exec(String(values.get(flag)));
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined || !OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || repo === '.' || repo === '..') {
    throw new UsageError(`${flag} must be OWNER/REPO`);
  }
  return { owner, repo };
}

/** A full lowercase commit given for a flag; throws UsageError. */
function commitValue(value: string, flag: string): string {
  if (!COMMIT_FLAG_PATTERN.test(value)) {
    throw new UsageError(`${flag} must be a full 40-character lowercase commit SHA`);
  }
  return value;
}

/** A full lowercase commit from a flag, or undefined; throws UsageError. */
function commitFlag(values: ReadonlyMap<string, string>, flag: string): string | undefined {
  const value = values.get(flag);
  return value === undefined ? undefined : commitValue(value, flag);
}

/** `{ owner, repo, commit }` from --repo/--commit given together, or undefined. */
function optionalSource(values: ReadonlyMap<string, string>): ISarifSourceBinding | undefined {
  const hasRepo = values.has('--repo');
  const commit = values.get('--commit');
  const hasCommit = commit !== undefined;
  if (hasRepo && !hasCommit) throw new UsageError('--repo requires --commit (give both or neither)');
  if (hasCommit && !hasRepo) throw new UsageError('--commit requires --repo (give both or neither)');
  if (!hasRepo || !hasCommit) return undefined;
  const { owner, repo } = repositoryFlag(values);
  return { owner, repo, commit: commitValue(commit, '--commit') };
}

/** A `--source-root` value, or undefined; throws UsageError. */
function sourceRootFlag(values: ReadonlyMap<string, string>): string | undefined {
  const value = values.get('--source-root');
  if (value !== undefined && !(value.startsWith('file:') && value.endsWith('/'))) {
    throw new UsageError('--source-root must be an absolute file: URI ending in "/"');
  }
  return value;
}

/** A positive whole number given for a flag; throws UsageError. */
function positiveValue(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`${flag} must be a positive whole number`);
  }
  return Number(value);
}

/** A positive whole number from a flag; throws UsageError. */
function positiveFlag(values: ReadonlyMap<string, string>, flag: string): number | undefined {
  const value = values.get(flag);
  if (value === undefined) return undefined;
  return positiveValue(value, flag);
}

/** A preview limit: a positive whole number, or "all" (no limit, null); throws UsageError. */
function previewFlag(values: ReadonlyMap<string, string>, flag: string): number | null | undefined {
  const value = values.get(flag);
  if (value === undefined) return undefined;
  if (value === 'all') return null;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`${flag} must be a positive whole number or "all"`);
  }
  return Number(value);
}

/** The process environment as the CLI reads it (only the token variables). */
type CliEnvironment = Readonly<Record<string, string | undefined>>;

/** The credential: GH_TOKEN, else GITHUB_TOKEN; empty counts as unset. */
function tokenFrom(env: CliEnvironment): string | undefined {
  const ghToken = env['GH_TOKEN'];
  if (typeof ghToken === 'string' && ghToken !== '') return ghToken;
  const githubToken = env['GITHUB_TOKEN'];
  if (typeof githubToken === 'string' && githubToken !== '') return githubToken;
  return undefined;
}

/**
 * A caught value's `message` property, read as `value.message` reads it
 * (a primitive has none; neither has null or undefined, which cannot be read).
 */
function messageProperty(value: unknown): unknown {
  return (typeof value === 'object' && value !== null) || typeof value === 'function' ? Reflect.get(value, 'message') : undefined;
}

/** An error's message and cause chain, one line each. */
function describeError(err: unknown): string {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const message = messageProperty(current) ?? current;
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a thrown value of any type is shown by its message, else by String(), the deliberate total coercion
    lines.push(lines.length === 0 ? String(message) : `  caused by: ${String(message)}`);
    if (!(current instanceof Error)) break;
    current = current.cause;
  }
  return lines.join('\n');
}

/** Reads all of a readable stream as a Buffer. */
async function readStream(stream: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** SARIF as written by the CLI: two-space indented JSON with a final newline. */
function serialize(sarif: unknown): string {
  return `${JSON.stringify(sarif, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Outcomes
//
// Every handler returns an Outcome: { exit, doc, out?, diagnostics? }. `doc`
// is the JSON document without its diagnostics (always complete, so every
// format carries the same facts); `out` is the human primary result for
// stdout; `diagnostics` (none when omitted) are appended to the document and
// rendered on stderr in human mode.
// ---------------------------------------------------------------------------

/** The JSON document of an outcome: `{ command, status, ... }`. */
type OutcomeDocument = Readonly<Record<string, unknown>>;

/** What a handled invocation produced (see above). */
interface IOutcome {
  readonly exit: number;
  readonly doc: OutcomeDocument;
  readonly out?: string | undefined;
  readonly diagnostics?: readonly IDiagnostic[] | undefined;
}

/** An artifact receipt: the fields naming files written, archived or deliberately not written. */
type ArtifactReceipt = Readonly<Record<string, unknown>>;

/**
 * An operational failure after arguments were accepted, with its artifact
 * receipt fields. The document's `message` is the failure's message; the
 * human notes say what happened to the files, on stdout.
 */
function errorOutcome(command: CliCommand, failure: IDiagnostic, receipt: ArtifactReceipt = {}, humanNotes: readonly string[] = []): IOutcome {
  return { exit: EXIT.error, doc: { command, status: 'error', message: failure.message, ...receipt }, out: notesText(humanNotes), diagnostics: [failure] };
}

/** A file problem as its diagnostic, about the file. */
function artifactFailure(err: files.ArtifactError): IDiagnostic {
  return createDiagnostic(err.code, err.message, { subject: err.file });
}

/** A failure outside the document (Git, GitHub, the network, publication state) as its diagnostic. */
function operationFailure(message: string): IDiagnostic {
  return createDiagnostic('operation-failed', message);
}

/** The failure of a GitHub-reading command without a credential. */
function tokenMissing(): IDiagnostic {
  return createDiagnostic('github-token-missing', 'no GitHub token: set GH_TOKEN (or GITHUB_TOKEN) to a personal access token or user token.');
}

/**
 * A usage error about `subject`, the command whose help documents the
 * mistake, or null for the top-level help (no command, the flag-only
 * publisher, or an unknown command). The remedy names that exact help
 * command (docs/diagnostics.md, usage-error).
 */
function usageDiagnostic(subject: CliCommand | null, message: string): IDiagnostic {
  const hint = subject === null ? 'sarif-to-comment --help' : `sarif-to-comment ${subject} --help`;
  return createDiagnostic('usage-error', message, { subject: subject ?? undefined, remedies: [`Run \`${hint}\` for usage.`] });
}

/** A usage error; `usage` is the command's help (or the top-level help). */
function usageOutcome(command: CliCommand | null, message: string, legacy = false): IOutcome {
  return {
    exit: EXIT.usage,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- every command has help text; the top-level fallback is kept as the durable guard it always was
    doc: { command, status: 'usage-error', message, usage: USAGE[command ?? 'top'] ?? USAGE.top },
    diagnostics: [usageDiagnostic(legacy ? null : command, message)],
  };
}

/**
 * The package's version, as `--version` reports it: read from this
 * package's package.json when the command runs, so it is always the
 * installed release's. `command` is the command given with it, if any; the
 * version is the package's either way. A manifest that cannot be read is a
 * broken installation, reported as an operational failure.
 */
function versionOutcome(command: CliCommand | null): IOutcome {
  let version: string;
  try {
    version = packageVersion();
  } catch (err) {
    const failure = operationFailure(`The package version could not be read from this package's package.json: ${describeError(err)}`);
    return { exit: EXIT.error, doc: { command, status: 'error', message: failure.message }, diagnostics: [failure] };
  }
  return { exit: EXIT.ok, doc: { command, status: 'version', version }, out: `${version}\n` };
}

/** Human lines saying what happened to files, for stdout; nothing when there are none. */
function notesText(notes: readonly string[]): string | undefined {
  return notes.length === 0 ? undefined : `${notes.join('\n')}\n`;
}

/** A one-based line or inclusive range, written like inspection output (`2` or `5-6`). */
const lineRange = (start: number, end: number | undefined): string =>
  end === undefined || end === start ? String(start) : `${String(start)}-${String(end)}`;

/** What every command handler may use from the invocation. */
interface IHandlerContext {
  readonly env: CliEnvironment;
  readonly stdin: AsyncIterable<Buffer | string>;
  readonly cwd: string;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

function init(argv: readonly string[], { cwd }: IHandlerContext): IOutcome {
  const { values } = parseOptions(argv, {
    values: ['--output', '--tool-name', '--tool-version', '--repo', '--commit'],
    required: ['--output'],
  });
  if (values.has('--tool-version') && !values.has('--tool-name')) {
    throw new UsageError("--tool-version requires --tool-name (this package's version is never attributed to another tool)");
  }
  const source = optionalSource(values);
  const toolName = values.get('--tool-name');
  const toolVersion = values.get('--tool-version');
  const options: ICreateSarifDocumentOptions = {
    ...(toolName === undefined ? {} : { tool: { name: toolName, ...(toolVersion === undefined ? {} : { version: toolVersion }) } }),
    ...(source ? { source } : {}),
  };
  let sarif;
  try {
    sarif = createSarifDocument(options);
  } catch (err) {
    if (err instanceof TypeError) throw new UsageError(err.message);
    throw err;
  }

  const output = path.resolve(cwd, requiredValue(values, '--output'));
  try {
    files.createExclusive(output, serialize(sarif));
  } catch (err) {
    if (!(err instanceof files.ArtifactError)) throw err;
    return errorOutcome('init', artifactFailure(err), { output: { path: output, written: false } });
  }
  const run = createdRun(sarif.runs[0]);
  const binding = run.versionControlProvenance?.[0];
  const doc = {
    command: 'init',
    status: 'created',
    output: { path: output, written: true },
    runIndex: 0,
    ...(binding ? { source: { repositoryUri: binding.repositoryUri, commit: binding.revisionId } } : {}),
  };
  const tool = run.tool.driver.version === undefined ? run.tool.driver.name : `${run.tool.driver.name} ${run.tool.driver.version}`;
  const bound = binding ? `, bound to ${binding.repositoryUri} at ${binding.revisionId}` : ', not bound to a commit';
  return {
    exit: EXIT.ok,
    doc,
    out: `Created ${output}: a SARIF document with one run (run 0, tool "${tool}"${bound}).\n`,
  };
}

/** The run createSarifDocument makes, as far as init reports it. */
interface ICreatedRun {
  readonly tool: { readonly driver: { readonly name: string; readonly version?: string } };
  readonly versionControlProvenance?: readonly { readonly repositoryUri: string; readonly revisionId: string }[];
}

/**
 * The one run of a document createSarifDocument has just made. It always
 * has that run (with a named driver and, when bound, its provenance), so
 * this check refuses only a defect in this package, never user input.
 */
function createdRun(run: object | undefined): ICreatedRun {
  if (!isCreatedRun(run)) throw new Error('Internal error: createSarifDocument returned no run with a named tool.');
  return run;
}

/** Whether `value` has the shape createSarifDocument gives its run (see ICreatedRun). */
function isCreatedRun(value: unknown): value is ICreatedRun {
  if (typeof value !== 'object' || value === null || !('tool' in value)) return false;
  const { tool } = value;
  if (typeof tool !== 'object' || tool === null || !('driver' in tool)) return false;
  const { driver } = tool;
  if (typeof driver !== 'object' || driver === null || !('name' in driver) || typeof driver.name !== 'string') return false;
  if ('version' in driver && driver.version !== undefined && typeof driver.version !== 'string') return false;
  if (!('versionControlProvenance' in value) || value.versionControlProvenance === undefined) return true;
  const provenance = value.versionControlProvenance;
  return (
    Array.isArray(provenance) &&
    provenance.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        'repositoryUri' in entry &&
        typeof entry.repositoryUri === 'string' &&
        'revisionId' in entry &&
        typeof entry.revisionId === 'string',
    )
  );
}

// ---------------------------------------------------------------------------
// add-comment
// ---------------------------------------------------------------------------

/** A SARIF level `--level` accepts. */
type SarifLevel = NonNullable<ISarifComment['level']>;

/** The SARIF levels `--level` accepts. */
const LEVELS: readonly SarifLevel[] = ['none', 'note', 'warning', 'error'];

function isLevel(value: string): value is SarifLevel {
  return LEVELS.some((level) => level === value);
}

async function addComment(argv: readonly string[], { cwd, stdin }: IHandlerContext): Promise<IOutcome> {
  const { values, flags } = parseOptions(argv, {
    values: [
      '--sarif', '--file', '--line', '--end-line', '--message', '--message-file', '--rule-id', '--level', '--run',
      '--new-run-tool', '--new-run-tool-version', '--repo', '--commit',
    ],
    booleans: ['--markdown'],
    required: ['--sarif', '--file', '--line'],
  });
  if (values.has('--message') === values.has('--message-file')) {
    throw new UsageError('give exactly one of --message TEXT or --message-file FILE|-');
  }
  const file = requiredValue(values, '--file');
  if (!isNormalizedRepositoryPath(file)) {
    throw new UsageError('--file must be a repository-relative path with "/" separators and no leading "/", ".", ".." or empty segment');
  }
  const line = positiveValue(requiredValue(values, '--line'), '--line');
  const endLine = positiveFlag(values, '--end-line');
  if (endLine !== undefined && endLine < line) throw new UsageError('--end-line must not be smaller than --line');
  const level = values.get('--level');
  if (level !== undefined && !isLevel(level)) {
    throw new UsageError('--level must be none, note, warning or error');
  }
  const newRunTool = values.get('--new-run-tool');
  if (values.has('--run') && newRunTool !== undefined) throw new UsageError('--run and --new-run-tool cannot be combined');
  for (const flag of ['--new-run-tool-version', '--repo', '--commit']) {
    if (values.has(flag) && newRunTool === undefined) throw new UsageError(`${flag} applies only to a new run: give --new-run-tool NAME`);
  }
  let run: number | INewSarifRun | undefined;
  const index = values.get('--run');
  if (index !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(index)) throw new UsageError('--run must be a run index (0, 1, ...)');
    run = Number(index);
  } else if (newRunTool !== undefined) {
    const toolVersion = values.get('--new-run-tool-version');
    const newRunVersion = toolVersion === undefined ? {} : { toolVersion };
    const source = optionalSource(values);
    run = { toolName: newRunTool, ...newRunVersion, ...(source ? { source } : {}) };
  }

  const sarifPath = path.resolve(cwd, requiredValue(values, '--sarif'));
  const notWritten = { sarif: { path: sarifPath, written: false } };

  let message: string;
  try {
    const inline = values.get('--message');
    const messageFile = values.get('--message-file');
    if (inline !== undefined) {
      message = inline;
    } else if (messageFile === '-') {
      message = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readStream(stdin));
    } else {
      message = files.readTextFile(path.resolve(cwd, String(messageFile)), 'message file').text;
    }
  } catch (err) {
    if (err instanceof files.ArtifactError) return errorOutcome('add-comment', artifactFailure(err), notWritten);
    if (err instanceof TypeError) return errorOutcome('add-comment', createDiagnostic('message-not-utf8', 'standard input is not valid UTF-8; the message must be UTF-8 encoded.'), notWritten);
    throw err;
  }
  if (message === '') throw new UsageError('the message must not be empty');

  const ruleId = values.get('--rule-id');
  const comment: ISarifComment = {
    file,
    line,
    message,
    ...(endLine === undefined ? {} : { endLine }),
    ...(flags.has('--markdown') ? { messageFormat: 'markdown' as const } : {}),
    ...(ruleId === undefined ? {} : { ruleId }),
    ...(level === undefined ? {} : { level }),
    ...(run === undefined ? {} : { run }),
  };

  return editInPlace('add-comment', sarifPath, (value) => {
    let outcome;
    try {
      outcome = addSarifCommentWithUntypedInput(value, comment);
    } catch (err) {
      if (err instanceof TypeError) {
        throw new UsageError(`${err.message}. Select a run with --run N, or add one with --new-run-tool NAME.`);
      }
      throw err;
    }
    if (outcome.status === 'invalid') {
      return {
        outcome: {
          exit: EXIT.refused,
          doc: { command: 'add-comment', status: 'invalid', ...notWritten, problems: outcome.problems },
          out: notesText([`${sarifPath} was not changed.`]),
          diagnostics: outcome.diagnostics,
        },
      };
    }
    const finding = { ref: outcome.finding.ref, path: file, line, endLine: endLine ?? line, tool: outcome.finding.tool };
    return {
      replacement: serialize(outcome.sarif),
      outcome: {
        exit: EXIT.ok,
        doc: { command: 'add-comment', status: 'added', sarif: { path: sarifPath, written: true }, finding },
        out: `Added ${finding.ref} (tool "${finding.tool}") on ${file}:${lineRange(line, endLine)} to ${sarifPath}.\n`,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// remove-comment
// ---------------------------------------------------------------------------

function removeComment(argv: readonly string[], { cwd }: IHandlerContext): IOutcome {
  const { values } = parseOptions(argv, { values: ['--sarif', '--finding'], required: ['--sarif', '--finding'] });
  const selector = requiredValue(values, '--finding');
  if (parseFindingSelector(selector) === null) {
    throw new UsageError('--finding must be a finding selector such as /runs/0/results/1@0123456789abcdef: run '
      + '"sarif-to-comment inspect --sarif FILE" and copy the finding\'s selector (a position or message alone does not select a finding)');
  }
  const command = 'remove-comment';
  const sarifPath = path.resolve(cwd, requiredValue(values, '--sarif'));
  const notWritten = { sarif: { path: sarifPath, written: false } };
  return editInPlace(command, sarifPath, (value) => {
    let outcome;
    try {
      outcome = removeSarifCommentWithUntypedInput(value, selector);
    } catch (err) {
      if (err instanceof TypeError) throw new UsageError(err.message);
      throw err;
    }
    if (outcome.status === 'invalid' || outcome.status === 'stale') {
      return {
        outcome: {
          exit: EXIT.refused,
          doc: { command, status: outcome.status, ...notWritten, problems: outcome.problems },
          out: notesText([`${sarifPath} was not changed.`]),
          diagnostics: outcome.diagnostics,
        },
      };
    }
    const { finding } = outcome;
    const proposals = finding.fileProposals === 0 ? '' : ` and ${String(finding.fileProposals)} proposed file operation(s)`;
    return {
      replacement: serialize(outcome.sarif),
      outcome: {
        exit: EXIT.ok,
        doc: { command, status: 'removed', sarif: { path: sarifPath, written: true }, finding },
        out: `Removed ${finding.ref} (tool "${finding.tool}") and its ${String(finding.fixes)} attached fix(es)${proposals} from ${sarifPath}.\n`
          + 'Selectors from earlier inspections no longer apply; inspect the file again before another removal.\n',
      },
    };
  });
}

// ---------------------------------------------------------------------------
// group-fixes and ungroup-fixes (docs/companion-suggestion-pr-contract.md §2.12)
// ---------------------------------------------------------------------------

/** The commands that group and ungroup fixes. */
type GroupingCommand = 'group-fixes' | 'ungroup-fixes';

/** What a grouping command writes and reports once the library has accepted the request. */
interface IGroupingSuccess {
  readonly sarif: unknown;
  /** Receipt fields after `sarif` / `output`. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** The human summary, given where the result was written. */
  readonly summary: (written: { readonly sarifPath: string; readonly output: string | undefined }) => string;
  /** One human line per finding. */
  readonly members: readonly string[];
  /** Human lines after the members, before the reminder about selectors. */
  readonly notes: readonly string[];
}

/** What a grouping command's library call decided: success, or a refusal with its status. */
type GroupingDecision =
  | { readonly accepted: IGroupingSuccess }
  | {
      readonly accepted?: undefined;
      readonly status: string;
      readonly problems: readonly unknown[];
      readonly markdown: string;
      readonly diagnostics: readonly IDiagnostic[];
    };

/** "1 change" / "2 changes". */
const plural = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

/** The --finding selectors, checked for form and repetition; throws UsageError. */
function selectorFlags(lists: ReadonlyMap<string, readonly string[]>): readonly string[] {
  const selectors = lists.get('--finding') ?? [];
  for (const [i, selector] of selectors.entries()) {
    if (parseFindingSelector(selector) === null) {
      throw new UsageError('--finding must be a finding selector such as /runs/0/results/1@0123456789abcdef: run '
        + '"sarif-to-comment inspect --sarif FILE" and copy the finding\'s selector (a position or message alone does not select a finding)');
    }
    if (selectors.indexOf(selector) !== i) throw new UsageError(`--finding ${selector} was given twice; name each finding once`);
  }
  return selectors;
}

/** The --output file of a grouping command, checked against --sarif and its directory; throws UsageError. */
function groupingOutput(values: ReadonlyMap<string, string>, sarifPath: string, cwd: string): string | undefined {
  const given = values.get('--output');
  if (given === undefined) return undefined;
  const output = path.resolve(cwd, given);
  if (output === sarifPath || files.sameExistingFile(sarifPath, output)) {
    throw new UsageError(`--output must be a different file from --sarif (${output} and ${sarifPath} are the same file); omit --output to edit ${sarifPath} in place`);
  }
  let directory: fs.Stats | null;
  try {
    directory = fs.statSync(path.dirname(output));
  } catch {
    directory = null;
  }
  if (!directory || !directory.isDirectory()) throw new UsageError(`the --output directory ${path.dirname(output)} does not exist`);
  return output;
}

function groupFixes(argv: readonly string[], { cwd }: IHandlerContext): IOutcome {
  const { values, lists } = parseOptions(argv, { values: ['--sarif', '--group', '--output'], repeatable: ['--finding'], required: ['--sarif', '--finding', '--group'] });
  const findings = selectorFlags(lists);
  const group = requiredValue(values, '--group');
  if (!isSuggestionGroupName(group)) {
    throw new UsageError('--group must be 1-100 characters without control or invisible formatting characters or surrounding whitespace');
  }
  const sarifPath = path.resolve(cwd, requiredValue(values, '--sarif'));
  const output = groupingOutput(values, sarifPath, cwd);
  return runGrouping('group-fixes', sarifPath, output, (value): GroupingDecision => {
    const outcome = libraryCall(() => groupSarifFixesWithUntypedInput(value, { findings, group }));
    if (outcome.status !== 'grouped') return outcome;
    return {
      accepted: {
        sarif: outcome.sarif,
        fields: { group: outcome.group, extended: outcome.extended, findings: outcome.findings, changes: outcome.changes },
        summary: ({ sarifPath: file, output: written }) => {
          const what = plural(outcome.findings.length, 'finding');
          const name = JSON.stringify(outcome.group);
          const total = `${String(outcome.changes)} distinct changes to accept together.`;
          const verb = outcome.extended ? `Added ${what}` : `Grouped ${what}`;
          const where = outcome.extended ? `to suggestion group ${name}: ${total}` : `as suggestion group ${name}: ${total}`;
          return written === undefined ? `${verb} in ${file} ${where}` : `${verb} ${where} Wrote ${written}; ${file} was not changed.`;
        },
        members: outcome.findings.map((f) => `  ${f.ref} (tool "${f.tool}"): ${plural(f.changes, 'change')}`),
        notes: ['Publishing with --allow-suggestion-prs proposes the group as one suggestion pull request; without it, publication refuses the group.'],
      },
    };
  });
}

function ungroupFixes(argv: readonly string[], { cwd }: IHandlerContext): IOutcome {
  const { values, lists } = parseOptions(argv, { values: ['--sarif', '--output'], repeatable: ['--finding'], required: ['--sarif', '--finding'] });
  const findings = selectorFlags(lists);
  const sarifPath = path.resolve(cwd, requiredValue(values, '--sarif'));
  const output = groupingOutput(values, sarifPath, cwd);
  return runGrouping('ungroup-fixes', sarifPath, output, (value): GroupingDecision => {
    const outcome = libraryCall(() => ungroupSarifFixesWithUntypedInput(value, { findings }));
    if (outcome.status !== 'ungrouped') return outcome;
    return {
      accepted: {
        sarif: outcome.sarif,
        fields: { findings: outcome.findings },
        summary: ({ sarifPath: file, output: written }) => {
          const what = plural(outcome.findings.length, 'finding');
          return written === undefined ? `Ungrouped ${what} in ${file}.` : `Ungrouped ${what}. Wrote ${written}; ${file} was not changed.`;
        },
        members: outcome.findings.map((f) => `  ${f.ref} (tool "${f.tool}"): was in suggestion group ${JSON.stringify(f.group)}`),
        notes: [],
      },
    };
  });
}

/** Runs a library operation, reporting caller misuse (a TypeError) as a usage error. */
function libraryCall<T>(call: () => T): T {
  try {
    return call();
  } catch (err) {
    if (err instanceof TypeError) throw new UsageError(err.message);
    throw err;
  }
}

/**
 * Runs a grouping command: edits --sarif in place, or writes the result to a
 * new --output file and leaves --sarif unchanged. A refusal writes nothing
 * and exits 2.
 */
function runGrouping(command: GroupingCommand, sarifPath: string, output: string | undefined, decide: (value: unknown) => GroupingDecision): IOutcome {
  const reminder = output === undefined
    ? 'Selectors from earlier inspections no longer apply; inspect the file again before another edit.'
    : `Inspect ${output} for its selectors before editing it.`;
  const refusal = (decision: Exclude<GroupingDecision, { readonly accepted: IGroupingSuccess }>, receipt: ArtifactReceipt, notes: readonly string[]): IOutcome => ({
    exit: EXIT.refused,
    doc: { command, status: decision.status, ...receipt, problems: decision.problems },
    out: notesText(notes),
    diagnostics: decision.diagnostics,
  });
  const success = (accepted: IGroupingSuccess, receipt: ArtifactReceipt): IOutcome => ({
    exit: EXIT.ok,
    doc: { command, status: command === 'group-fixes' ? 'grouped' : 'ungrouped', ...receipt, ...accepted.fields },
    out: `${[accepted.summary({ sarifPath, output }), ...accepted.members, ...accepted.notes, reminder].join('\n')}\n`,
  });

  if (output === undefined) {
    const notWritten = { sarif: { path: sarifPath, written: false } };
    return editInPlace(command, sarifPath, (value) => {
      const decision = decide(value);
      if (decision.accepted === undefined) return { outcome: refusal(decision, notWritten, [`${sarifPath} was not changed.`]) };
      return { replacement: serialize(decision.accepted.sarif), outcome: success(decision.accepted, { sarif: { path: sarifPath, written: true } }) };
    });
  }

  const notWritten = { sarif: { path: sarifPath, written: false }, output: { path: output, written: false } };
  const notes = [`${sarifPath} was not changed.`, `${output} was not written.`];
  let release: ReleaseOwnership;
  try {
    release = files.acquireOwnership(output);
  } catch (err) {
    if (err instanceof files.ArtifactError) return errorOutcome(command, artifactFailure(err), notWritten, notes);
    throw err;
  }
  try {
    let read: IJsonFile;
    try {
      read = files.readJsonFile(sarifPath, 'SARIF file');
    } catch (err) {
      if (err instanceof files.ArtifactError) return errorOutcome(command, artifactFailure(err), notWritten, notes);
      throw err;
    }
    const decision = decide(read.value);
    if (decision.accepted === undefined) return refusal(decision, notWritten, notes);
    try {
      files.createExclusive(output, serialize(decision.accepted.sarif));
    } catch (err) {
      if (err instanceof files.ArtifactError) return errorOutcome(command, artifactFailure(err), notWritten, notes);
      throw err;
    }
    return success(decision.accepted, { sarif: { path: sarifPath, written: false }, output: { path: output, written: true } });
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// In-place edits (add-comment, remove-comment, group-fixes, ungroup-fixes)
// ---------------------------------------------------------------------------

/**
 * What an in-place edit computed from a SARIF file's parsed content: the
 * outcome to report and, when the file is to change, its new content. The
 * outcome is reported only after that content has replaced the file.
 */
interface IInPlaceEdit {
  readonly outcome: IOutcome;
  readonly replacement?: string;
}

/**
 * Applies `edit` to the SARIF file at `sarifPath` in place (contract §3.2):
 * the real file behind any symbolic link is edited, so the link survives;
 * the command owns the file through its marker for the whole edit; and the
 * new content replaces the file atomically, only if the file still holds the
 * bytes the edit was computed from. Every failure leaves the file unchanged
 * and reports it with `written: false`. A UsageError thrown by `edit`
 * propagates after ownership is released.
 */
function editInPlace(command: 'add-comment' | 'remove-comment' | GroupingCommand, sarifPath: string, edit: (value: unknown) => IInPlaceEdit): IOutcome {
  const notWritten = { sarif: { path: sarifPath, written: false } };
  let target: string;
  try {
    target = fs.realpathSync(sarifPath);
  } catch (err) {
    return errorOutcome(command, createDiagnostic('file-unreadable', `cannot read SARIF file ${sarifPath}: ${String(messageProperty(err))}`, { subject: sarifPath }), notWritten);
  }
  let release: ReleaseOwnership;
  try {
    release = files.acquireOwnership(target);
  } catch (err) {
    if (err instanceof files.ArtifactError) return errorOutcome(command, artifactFailure(err), notWritten);
    throw err;
  }
  try {
    let read: IJsonFile;
    try {
      read = files.readJsonFile(target, 'SARIF file');
    } catch (err) {
      if (err instanceof files.ArtifactError) return errorOutcome(command, artifactFailure(err), notWritten);
      throw err;
    }
    const { outcome, replacement } = edit(read.value);
    if (replacement === undefined) return outcome;
    try {
      files.replaceIfUnchanged(target, read.bytes, replacement);
    } catch (err) {
      if (err instanceof files.ArtifactError) return errorOutcome(command, artifactFailure(err), notWritten);
      throw err;
    }
    return outcome;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

function inspect(argv: readonly string[], { cwd }: IHandlerContext): IOutcome {
  const { values } = parseOptions(argv, {
    values: ['--sarif', '--preview-lines', '--preview-chars', '--source-root'],
    required: ['--sarif'],
  });
  const previewLines = previewFlag(values, '--preview-lines');
  const previewChars = previewFlag(values, '--preview-chars');
  const sourceRootUri = sourceRootFlag(values);
  const options: IInspectSarifOptions = {
    ...(previewLines === undefined ? {} : { previewLines }),
    ...(previewChars === undefined ? {} : { previewChars }),
    ...(sourceRootUri === undefined ? {} : { sourceRootUri }),
  };

  const sarifPath = path.resolve(cwd, requiredValue(values, '--sarif'));
  let read: IJsonFile;
  try {
    read = files.readJsonFile(sarifPath, 'SARIF file');
  } catch (err) {
    if (err instanceof files.ArtifactError) return errorOutcome('inspect', artifactFailure(err));
    throw err;
  }
  let outcome;
  try {
    outcome = inspectSarifWithUntypedInput(read.value, options);
  } catch (err) {
    if (err instanceof TypeError) throw new UsageError(err.message);
    throw err;
  }
  if (outcome.status === 'invalid') {
    return {
      exit: EXIT.refused,
      doc: { command: 'inspect', status: 'invalid', problems: outcome.problems },
      out: notesText([]),
          diagnostics: outcome.diagnostics,
    };
  }
  const text = renderInspectionText(outcome.view);
  return {
    exit: EXIT.ok,
    doc: { command: 'inspect', status: 'inspected', view: outcome.view },
    out: text.endsWith('\n') ? text : `${text}\n`,
    diagnostics: outcome.diagnostics,
  };
}

// ---------------------------------------------------------------------------
// add-staged-changes
// ---------------------------------------------------------------------------

/** Human lines describing an extraction receipt (its warnings are diagnostics, shown on their own). */
function stagedReceiptText(receipt: IStagedChangesReceipt): string[] {
  const lines: string[] = [];
  if (receipt.changes.length === 0) lines.push('No staged changes: the SARIF content is unchanged.');
  for (const change of receipt.changes) {
    if (change.operation === 'edit') {
      lines.push(`${change.operation} ${change.path}`);
      for (const r of change.replacements ?? []) {
        const who = r.associated.length === 0 ? 'no finding' : r.associated.join(', ');
        // A pure insertion changes no reviewed line; its empty range ends at the
        // line it follows, so name that position rather than a changed range.
        const where = r.insertion
          ? `${r.endLine === 0 ? 'insertion at the start of the file' : `insertion after line ${String(r.endLine)}`} (no reviewed line changed)`
          : `lines ${lineRange(r.startLine, r.endLine)}`;
        lines.push(`  ${where}: ${who} (explained by ${r.explainedBy})`);
      }
    } else {
      const associated = change.associated ?? [];
      const who = associated.length === 0 ? 'no finding' : associated.join(', ');
      lines.push(`${change.operation} ${change.path}: ${who} (explained by ${String(change.explainedBy)})`);
    }
  }
  if (receipt.boundRuns.length > 0) lines.push(`Runs bound to ${receipt.reviewedCommit}: ${receipt.boundRuns.join(', ')}`);
  if (receipt.addedRun !== null) lines.push(`Changes no finding explains are in run ${String(receipt.addedRun)}.`);
  return lines;
}

/** Human line describing an archived output. */
function archiveNote(archived: IArchivedOutput | null): string[] {
  if (!archived) return [];
  const time = archived.timeSource === 'birth' ? 'creation' : 'modification';
  return [`The previous ${archived.from} was preserved as ${archived.path} (named by its ${time} time).`];
}

async function addStagedChanges(argv: readonly string[], { cwd }: IHandlerContext): Promise<IOutcome> {
  const { values } = parseOptions(argv, {
    values: ['--sarif', '--output', '--worktree', '--repo', '--commit', '--source-root'],
    required: ['--sarif', '--output', '--worktree', '--repo', '--commit'],
  });
  const repository = repositoryFlag(values);
  const reviewedCommit = commitValue(requiredValue(values, '--commit'), '--commit');
  const sourceRootUri = sourceRootFlag(values);
  const input = path.resolve(cwd, requiredValue(values, '--sarif'));
  const output = path.resolve(cwd, requiredValue(values, '--output'));
  const worktree = path.resolve(cwd, requiredValue(values, '--worktree'));
  if (input === output || files.sameExistingFile(input, output)) {
    throw new UsageError(`--output must be a different file from --sarif (${output} and ${input} are the same file)`);
  }
  let outputDirectory: fs.Stats | null;
  try {
    outputDirectory = fs.statSync(path.dirname(output));
  } catch {
    outputDirectory = null;
  }
  if (!outputDirectory || !outputDirectory.isDirectory()) {
    throw new UsageError(`the --output directory ${path.dirname(output)} does not exist`);
  }

  // Operation start (§6.4): ownership, then archive, before any other work.
  const command = 'add-staged-changes';
  let release: ReleaseOwnership;
  try {
    release = files.acquireOwnership(output);
  } catch (err) {
    if (err instanceof files.ArtifactError) {
      return errorOutcome(command, artifactFailure(err), { output: { path: output, written: false }, archived: null });
    }
    throw err;
  }
  let archived: IArchivedOutput | null = null;
  const receiptFields = (): ArtifactReceipt => ({ output: { path: output, written: false }, archived });
  const notes = (): string[] => [`${output} was not written.`, ...archiveNote(archived)];
  try {
    try {
      archived = files.archiveExisting(output);
    } catch (err) {
      if (err instanceof files.ArtifactError) return errorOutcome(command, artifactFailure(err), receiptFields(), notes());
      throw err;
    }
    let read: IJsonFile;
    try {
      read = files.readJsonFile(input, 'SARIF file');
    } catch (err) {
      if (err instanceof files.ArtifactError) return errorOutcome(command, artifactFailure(err), receiptFields(), notes());
      throw err;
    }
    const request = {
      sarif: read.value,
      worktree,
      reviewedCommit,
      repository,
      ...(sourceRootUri === undefined ? {} : { sourceRootUri }),
    };
    let outcome;
    try {
      outcome = await addStagedChangesToSarifWithUntypedInput(request);
    } catch (err) {
      return errorOutcome(command, operationFailure(describeError(err)), receiptFields(), notes());
    }
    if (outcome.status === 'invalid' || outcome.status === 'failed') {
      return {
        exit: EXIT.refused,
        doc: { command, status: outcome.status, ...receiptFields(), problems: outcome.problems },
        out: notesText(notes()),
          diagnostics: outcome.diagnostics,
      };
    }
    try {
      files.createExclusive(output, serialize(outcome.sarif));
    } catch (err) {
      if (err instanceof files.ArtifactError) return errorOutcome(command, artifactFailure(err), receiptFields(), notes());
      throw err;
    }
    return {
      exit: EXIT.ok,
      doc: { command, status: 'added', output: { path: output, written: true }, archived, receipt: outcome.receipt },
      out: `${[`Wrote ${output}.`, ...archiveNote(archived), ...stagedReceiptText(outcome.receipt)].join('\n')}\n`,
      diagnostics: outcome.diagnostics,
    };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// validate and publish (and the flag-only publisher)
// ---------------------------------------------------------------------------

/** The review options publish and validate share: everything but --state. */
const REVIEW_SPEC = {
  values: ['--sarif', '--repo', '--pull', '--commit', '--source-root', '--old-source-commit', '--pr-labels'],
  booleans: ['--ignore-approval-hold', '--submit', '--allow-suggestion-prs', '--mark-suggestion-prs-ready'],
  required: ['--sarif', '--repo', '--pull', '--commit'],
} as const satisfies IOptionSpec;

const PUBLISH_SPEC: IOptionSpec = {
  values: [...REVIEW_SPEC.values.slice(0, 4), '--state', ...REVIEW_SPEC.values.slice(4)],
  booleans: REVIEW_SPEC.booleans,
  required: [...REVIEW_SPEC.required, '--state'],
};

/** Library input fields shared by publish and validate (everything but the SARIF, the token and the state path). */
interface IReviewRequestInput {
  readonly destination: { readonly owner: string; readonly repo: string; readonly pullNumber: number };
  readonly reviewedCommit: string;
  readonly oldSourceCommit?: string;
  readonly sourceRootUri?: string;
  readonly options?: {
    readonly ignoreApprovalHold?: true;
    readonly submit?: true;
    readonly allowSuggestionPullRequests?: true;
    readonly pullRequestLabels?: readonly string[];
    readonly markSuggestionPullRequestsReady?: true;
  };
}

/** A review command's SARIF file and library input fields. */
interface IReviewRequest<Input extends IReviewRequestInput> {
  readonly sarifPath: string;
  readonly input: Input;
}

/** The review target and policy from parsed options; throws UsageError. */
function reviewRequestInput({ values, flags }: IParsedOptions): IReviewRequestInput {
  const repo = REPO_FLAG_PATTERN.exec(requiredValue(values, '--repo'));
  const owner = repo?.[1];
  const name = repo?.[2];
  if (owner === undefined || name === undefined) throw new UsageError('--repo must be OWNER/REPO');
  const pull = requiredValue(values, '--pull');
  if (!/^[1-9][0-9]*$/.test(pull) || !Number.isSafeInteger(Number(pull))) {
    throw new UsageError('--pull must be a positive pull request number');
  }
  const destination = { owner, repo: name, pullNumber: Number(pull) };
  const reviewedCommit = commitValue(requiredValue(values, '--commit'), '--commit');
  const oldSourceCommit = commitFlag(values, '--old-source-commit');
  const sourceRootUri = sourceRootFlag(values);
  const allow = flags.has('--allow-suggestion-prs');
  const labels = values.get('--pr-labels');
  if (labels !== undefined && !allow) throw new UsageError('--pr-labels requires --allow-suggestion-prs');
  const ready = flags.has('--mark-suggestion-prs-ready');
  if (ready && !allow) throw new UsageError('--mark-suggestion-prs-ready requires --allow-suggestion-prs');
  const options = {
    ...(flags.has('--ignore-approval-hold') ? { ignoreApprovalHold: true as const } : {}),
    ...(flags.has('--submit') ? { submit: true as const } : {}),
    ...(allow ? { allowSuggestionPullRequests: true as const } : {}),
    ...(labels === undefined ? {} : { pullRequestLabels: labelListFlag(labels) }),
    ...(ready ? { markSuggestionPullRequestsReady: true as const } : {}),
  };
  return {
    destination,
    reviewedCommit,
    ...(oldSourceCommit === undefined ? {} : { oldSourceCommit }),
    ...(sourceRootUri === undefined ? {} : { sourceRootUri }),
    ...(Object.keys(options).length === 0 ? {} : { options }),
  };
}

/**
 * The names of `--pr-labels`: split at commas, with the spaces around each
 * name trimmed (docs/companion-suggestion-pr-contract.md §2.2). An empty
 * name, or one that is not a label name, is a usage error.
 */
function labelListFlag(value: string): string[] {
  const names = value.split(',').map((name) => name.trim());
  if (!names.every(isLabelName)) throw new UsageError(`--pr-labels must be a comma-separated list of label names, each ${LABEL_RULE}`);
  return names;
}

/** Library input fields from publish options; throws UsageError. */
function publishRequest(argv: readonly string[]): IReviewRequest<IReviewRequestInput & { readonly statePath: string }> {
  const parsed = parseOptions(argv, PUBLISH_SPEC);
  const target = reviewRequestInput(parsed);
  const statePath = requiredValue(parsed.values, '--state');
  if (!path.isAbsolute(statePath)) throw new UsageError('--state must be an absolute file path');
  return { sarifPath: requiredValue(parsed.values, '--sarif'), input: { ...target, statePath } };
}

/** Library input fields from validate options (no --state); throws UsageError. */
function validateRequest(argv: readonly string[]): IReviewRequest<IReviewRequestInput> {
  const parsed = parseOptions(argv, REVIEW_SPEC);
  return { sarifPath: requiredValue(parsed.values, '--sarif'), input: reviewRequestInput(parsed) };
}

/** The credential and SARIF a review command sends to the library, or the error outcome that stops it. */
type ReviewInputs = { readonly token: string; readonly sarif: unknown } | { readonly error: IOutcome };

/** Reads the token and the SARIF file for a GitHub-reading command. */
function reviewInputs(command: 'validate' | 'publish', sarifPath: string, env: CliEnvironment): ReviewInputs {
  const token = tokenFrom(env);
  if (token === undefined) {
    return { error: errorOutcome(command, tokenMissing()) };
  }
  try {
    return { token, sarif: files.readJsonFile(sarifPath, 'SARIF file').value };
  } catch (err) {
    if (!(err instanceof files.ArtifactError)) throw err;
    // The flag-only publisher's wording for these failures, kept exactly.
    const message = err.message.includes('is not valid UTF-8')
      ? `SARIF file ${sarifPath} is not valid UTF-8; nothing was ${command === 'publish' ? 'published' : 'checked'}. SARIF files must be UTF-8 encoded JSON.`
      : err.message;
    return { error: errorOutcome(command, createDiagnostic(err.code, message, { subject: err.file })) };
  }
}

/**
 * Readiness assessment. Every library outcome (ready, blocked, incomplete)
 * is shown in human form as publish shows its outcomes: the report on
 * stdout, its problems and warnings as diagnostics on stderr, once; the JSON
 * `message` is the library's full Markdown. The library's rejection for
 * invalid input is an operational error. Nothing is written anywhere.
 */
async function validate(argv: readonly string[], { env }: IHandlerContext, internals: CliInternals | undefined): Promise<IOutcome> {
  const request = validateRequest(argv);
  const inputs = reviewInputs('validate', request.sarifPath, env);
  if ('error' in inputs) return inputs.error;
  let outcome;
  let report: string;
  try {
    ({ outcome, report } = await validateSarifReviewReported({ ...request.input, sarif: inputs.sarif, token: inputs.token }, internals));
  } catch (err) {
    return errorOutcome('validate', operationFailure(describeError(err)));
  }
  const doc = {
    command: 'validate',
    status: outcome.status,
    ...(outcome.status === 'blocked' ? { problems: outcome.problems } : {}),
    message: outcome.markdown,
  };
  return {
    exit: VALIDATE_EXIT[outcome.status],
    doc,
    out: `${report}\n`,
    diagnostics: outcome.diagnostics,
  };
}

/**
 * Publication, for this command and the flag-only publisher alike: the
 * report on stdout, its problems and warnings as diagnostics on stderr,
 * once; the JSON `message` is the library's full Markdown. The SARIF path is
 * used as given, as it always has been.
 */
async function publish(argv: readonly string[], { env }: IHandlerContext, internals: CliInternals | undefined): Promise<IOutcome> {
  const request = publishRequest(argv);
  const inputs = reviewInputs('publish', request.sarifPath, env);
  if ('error' in inputs) return inputs.error;
  const { sarif, token } = inputs;
  let outcome;
  let report: string;
  try {
    ({ outcome, report } = await publishSarifReviewReported({ ...request.input, sarif, token }, internals));
  } catch (err) {
    return errorOutcome('publish', operationFailure(describeError(err)));
  }
  const doc = {
    command: 'publish',
    status: outcome.status,
    ...('review' in outcome ? { review: { id: outcome.review.id, url: outcome.review.url } } : {}),
    ...(outcome.status === 'published' && outcome.suggestions !== undefined
      ? { suggestions: outcome.suggestions.map((s) => ({ number: s.number, url: s.url, branch: s.branch })) }
      : {}),
    ...('statePath' in outcome && outcome.statePath ? { statePath: outcome.statePath } : {}),
    message: outcome.markdown,
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- every publication status has an exit status; the operational-error fallback is kept as the durable guard it always was
    exit: PUBLISH_EXIT[outcome.status] ?? EXIT.error,
    doc,
    out: `${report}\n`,
    diagnostics: outcome.diagnostics,
  };
}

// ---------------------------------------------------------------------------
// close-suggestion-prs
// ---------------------------------------------------------------------------

/**
 * Suggestion pull request cleanup. The report is shown on stdout for every
 * status, with what could not be done as diagnostics on stderr, once; the
 * JSON `message` is the library's full Markdown. A rejection (invalid input,
 * or a failure before anything was closed) is an operational error.
 */
async function closeSuggestionPrs(argv: readonly string[], { env }: IHandlerContext, internals: CliInternals | undefined): Promise<IOutcome> {
  const command = 'close-suggestion-prs';
  const { values, flags } = parseOptions(argv, {
    values: ['--repo', '--label', '--original', '--owner', '--max-candidates'],
    booleans: ['--dry-run', '--force'],
    required: ['--repo'],
  });
  const repository = repositoryFlag(values);
  const label = values.get('--label');
  if (label !== undefined && !isLabelName(label)) throw new UsageError(`--label must be ${LABEL_RULE}`);
  const originalPullNumber = positiveFlag(values, '--original');
  const owner = values.get('--owner');
  if (owner !== undefined && owner !== 'me' && owner !== 'all') throw new UsageError('--owner must be me or all');
  const maxCandidates = positiveFlag(values, '--max-candidates');
  const token = tokenFrom(env);
  if (token === undefined) {
    return errorOutcome(command, tokenMissing());
  }
  const input = {
    repository,
    token,
    ...(label === undefined ? {} : { label }),
    ...(originalPullNumber === undefined ? {} : { originalPullNumber }),
    ...(owner === undefined ? {} : { owner }),
    ...(maxCandidates === undefined ? {} : { maxCandidates }),
    ...(flags.has('--force') ? { force: true } : {}),
    ...(flags.has('--dry-run') ? { dryRun: true } : {}),
  };
  let outcome;
  let report: string;
  try {
    ({ outcome, report } = await closeSuggestionPullRequestsReported(input, internals));
  } catch (err) {
    return errorOutcome(command, operationFailure(describeError(err)), {}, ['Nothing was closed.']);
  }
  const doc = {
    command,
    status: outcome.status,
    dryRun: outcome.dryRun,
    owner: outcome.owner,
    originals: outcome.originals,
    suggestions: outcome.suggestions,
    counts: outcome.counts,
    message: outcome.markdown,
  };
  return { exit: CLEANUP_EXIT[outcome.status], doc, out: `${report}\n`, diagnostics: outcome.diagnostics };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** A command handler: arguments after the command, the invocation, and the private seam. */
type Handler = (
  argv: readonly string[],
  context: IHandlerContext,
  internals: CliInternals | undefined,
) => IOutcome | Promise<IOutcome>;

const HANDLERS: Readonly<Record<CliCommand, Handler>> = {
  init,
  'add-comment': addComment,
  'remove-comment': removeComment,
  'group-fixes': groupFixes,
  'ungroup-fixes': ungroupFixes,
  inspect,
  'add-staged-changes': addStagedChanges,
  validate,
  publish,
  'close-suggestion-prs': closeSuggestionPrs,
};

/** Whether an argument names a command. */
function isCommand(arg: string): arg is CliCommand {
  return COMMANDS.some((command) => command === arg);
}

/**
 * Something the CLI writes its output to (the process's stdout or stderr, or
 * a test's capture). A terminal says so with `isTTY` and gives its width in
 * `columns`, as Node's tty.WriteStream does; human diagnostics use both.
 */
interface IOutputStream {
  write(text: string): unknown;
  readonly isTTY?: boolean | undefined;
  readonly columns?: number | undefined;
}

/**
 * Writes human diagnostics to stderr: colored when color is on
 * (docs/diagnostics.md, "Color"), wrapped to the width of a terminal, plain
 * and unwrapped otherwise. Nothing is written when there are none. If the
 * color library cannot be loaded (a broken installation), the diagnostics
 * are written plain with a `color-unavailable` warning: color is
 * presentation, so it never costs the outcome or its exit status.
 */
async function writeDiagnostics(
  diagnostics: readonly IDiagnostic[],
  stderr: IOutputStream,
  env: CliEnvironment,
  color: ColorChoice,
  safe: (text: string) => string,
): Promise<void> {
  if (diagnostics.length === 0) return;
  const isTTY = stderr.isTTY === true;
  let style = PLAIN_STYLE;
  let shown = diagnostics;
  if (shouldUseColor(color, env, isTTY)) {
    try {
      style = await loadColorStyle();
    } catch (err) {
      const unavailable = createDiagnostic('color-unavailable', `The color library could not be loaded (${describeError(err)}), so diagnostics are shown as plain text.`);
      shown = orderDiagnostics([...diagnostics, unavailable]);
    }
  }
  const width = isTTY && typeof stderr.columns === 'number' && stderr.columns > 0 ? stderr.columns : undefined;
  stderr.write(safe(renderDiagnostics(shown, { style, width })));
}

/** Encodes a JSON document as TOON text with a final newline. */
type ToonEncoder = (document: OutcomeDocument) => string;

/**
 * The TOON encoder (docs/diagnostics.md, "--format toon"). It is loaded
 * before any work is done, so an installation that cannot load it fails
 * before anything is read or written, never after an outcome.
 */
async function loadToonEncoder(): Promise<ToonEncoder> {
  const { encode } = await import('@toon-format/toon');
  // A JSON round trip first, so TOON carries exactly what the JSON document does.
  return (document) => `${encode(JSON.parse(JSON.stringify(document)))}\n`;
}

/**
 * The invocation `main` runs: argv is the arguments after the executable;
 * stdin is read only by `add-comment --message-file -`; cwd resolves
 * relative paths (default: the process's working directory).
 */
export interface ICliIo {
  readonly argv: readonly string[];
  readonly env: CliEnvironment;
  readonly stdout: IOutputStream;
  readonly stderr: IOutputStream;
  readonly stdin?: AsyncIterable<Buffer | string> | undefined;
  readonly cwd?: string | undefined;
}

/**
 * Runs the CLI and returns its exit status; expected failures never throw.
 *
 * @param io - `{ argv, env, stdout, stderr, stdin?, cwd? }` (see ICliIo)
 * @param internals - passed to publishSarifReview, validateSarifReview and
 *   closeSuggestionPullRequests (private test seam; the shipped executable's
 *   test wrappers inject a fake GitHub client through it)
 */
async function main(
  { argv, env, stdout, stderr, stdin = process.stdin, cwd = process.cwd() }: ICliIo,
  internals?: CliInternals,
): Promise<number> {
  const token = tokenFrom(env);
  const safe = (text: string): string => (token === undefined ? text : text.split(token).join('[redacted]'));

  let format: OutputFormat;
  let color: ColorChoice;
  let args: string[];
  try {
    ({ format, color, argv: args } = resolveGlobalOptions(argv));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    // The format (or the color) is unknown, so this is always human output.
    await writeDiagnostics([usageDiagnostic(commandNamedIn(argv), err.message)], stderr, env, 'auto', safe);
    return EXIT.usage;
  }

  let toon: ToonEncoder | undefined;
  if (format === 'toon') {
    try {
      toon = await loadToonEncoder();
    } catch (err) {
      // Without the encoder no TOON document can be printed; this is reported
      // in human form, before any command has done anything.
      const failure = createDiagnostic('operation-failed',
        `The TOON encoder could not be loaded (${describeError(err)}), so nothing was done. Use --format json, or reinstall the package's dependencies.`);
      await writeDiagnostics([failure], stderr, env, color, safe);
      return EXIT.error;
    }
  }

  const first = args[0];
  const legacy = first === undefined || first.startsWith('-');
  const command = first === undefined || legacy ? 'publish' : isCommand(first) ? first : null;
  const rest = legacy ? args : args.slice(1);

  let outcome: IOutcome;
  if (command === null) {
    outcome = usageOutcome(null, `unknown command ${String(first)}`);
  } else if (rest.includes('--help') || rest.includes('-h')) {
    const helpCommand = legacy ? null : command;
    const usage = USAGE[helpCommand ?? 'top'];
    outcome = { exit: EXIT.ok, doc: { command: helpCommand, status: 'help', usage }, out: usage };
  } else if (rest.includes('--version')) {
    outcome = versionOutcome(legacy ? null : command);
  } else {
    try {
      outcome = await HANDLERS[command](rest, { env, stdin, cwd }, internals);
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      outcome = usageOutcome(command, err.message, legacy);
    }
  }

  const diagnostics = orderDiagnostics(outcome.diagnostics ?? []);
  const document: OutcomeDocument = { ...outcome.doc, diagnostics };
  if (format === 'json') {
    stdout.write(safe(`${JSON.stringify(document, null, 2)}\n`));
  } else if (toon !== undefined) {
    stdout.write(safe(toon(document)));
  } else {
    if (outcome.out !== undefined) stdout.write(safe(outcome.out));
    await writeDiagnostics(diagnostics, stderr, env, color, safe);
  }
  return outcome.exit;
}

export { main, USAGE };
