'use strict';

/**
 * The sarif-to-comment command-line interface (bin/sarif-to-comment.cjs runs
 * `main`). It is a file-oriented transport over the public library: every
 * SARIF, Git and GitHub interpretation is the library's (src/index.cjs), and
 * this module adds only argument handling, file I/O (src/artifact-files.cjs),
 * credential selection, output formatting and exit statuses.
 *
 * Commands (contract: docs/second-milestone-contract-proposal.md §3, §5, §6):
 *   init                create a SARIF file              createSarifDocument
 *   add-comment         add one finding, in place        addSarifComment
 *   inspect             read-only view of a SARIF file   inspectSarif
 *   add-staged-changes  add staged Git changes to a copy addStagedChangesToSarif
 *   publish             create the GitHub draft review   publishSarifReview
 * A first argument beginning with "-" (or no argument) is the original
 * flag-only publisher, which keeps its exact behavior, output, credentials and
 * exit statuses. Anything else is a usage error.
 *
 * Output format (`--format human|json`, default human, never inferred from a
 * terminal) is resolved before anything else. An invalid, missing or repeated
 * `--format` is a human usage error on stderr with nothing on stdout. Once
 * JSON is selected, every handled outcome — including help, usage errors and
 * operational errors — is exactly one JSON document on stdout and nothing is
 * written to stderr. The envelope is `{ command, status, ... }` where
 * `command` is null only when no command was identified. Human mode writes
 * outcomes to stdout and usage/operational errors to stderr.
 *
 * Exit statuses: 0 success or help; 1 usage error or operational error; 2 the
 * content was refused (`invalid` / `failed`). `publish` keeps the publisher's
 * statuses: 0 published, 2 blocked, 3 uncertain, 1 otherwise.
 *
 * Receipts name only files actually written, archived, or deliberately not
 * written (`written: false`). The GitHub token (GH_TOKEN, else GITHUB_TOKEN)
 * is used only by `publish` and is redacted from every output in both modes.
 */

const fs = require('node:fs');
const path = require('node:path');

const library = require('./index.cjs');
const files = require('./artifact-files.cjs');
const { isNormalizedRepositoryPath, OWNER_PATTERN, REPO_PATTERN } = require('./sarif-common.cjs');
const { renderInspectionText } = require('./sarif-inspection.cjs');

const md = String.raw;

/** The commands, in workflow order. */
const COMMANDS = ['init', 'add-comment', 'inspect', 'add-staged-changes', 'publish'];

/** Exit statuses for non-publication outcomes (§5). */
const EXIT = Object.freeze({ ok: 0, usage: 1, error: 1, refused: 2 });

/** Exit statuses for publication, unchanged from the flag-only publisher. */
const PUBLISH_EXIT = Object.freeze({ published: 0, blocked: 2, uncertain: 3, rejected: 1 });

const COMMIT_FLAG_PATTERN = /^[0-9a-f]{40}$/;
const REPO_FLAG_PATTERN = /^([^/\s]+)\/([^/\s]+)$/;

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

const PUBLISH_OPTIONS = md`  --sarif FILE                   SARIF 2.1.0 JSON file to publish.
  --repo OWNER/REPO              Repository of the pull request.
  --pull N                       Pull request number.
  --commit FULLSHA               Full 40-character commit the review is about.
  --state ABSOLUTE_FILE          Durable publication state. Retry with the same
                                 file; never delete it after an uncertain
                                 result. A new file starts a separate review.
  --source-root ABSOLUTE_FILE_URI
                                 Repository root in the SARIF producer's file
                                 system (file:///.../ ending in "/").
  --old-source-commit FULLSHA    Candidate commit for the diff's old side, used
                                 only when GitHub's comparison cannot establish
                                 it; verified against the pull request's patches.
  --ignore-approval-hold         Publish despite an approval hold (bypasses only
                                 the hold, never validation).
`;

const CREDENTIALS = md`Credentials (publish only):
  GH_TOKEN, or else GITHUB_TOKEN: a GitHub personal access token or user token.
  GitHub App installation tokens (including the automatic Actions token) are
  not supported. There is no token flag.
`;

const FORMAT_OPTION = md`  --format human|json            Output format (default human). JSON prints one
                                 document on stdout for every outcome.
`;

const USAGE = {
  top: md`sarif-to-comment — author, inspect and publish SARIF as one GitHub draft review

Usage:
  sarif-to-comment init --output FILE [options]
  sarif-to-comment add-comment --sarif FILE --file PATH --line N (--message TEXT | --message-file FILE|-) [options]
  sarif-to-comment inspect --sarif FILE [options]
  sarif-to-comment add-staged-changes --sarif IN --output OUT --worktree DIR --repo OWNER/REPO --commit FULLSHA [options]
  sarif-to-comment publish --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA --state ABSOLUTE_FILE [options]
  sarif-to-comment --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA
                   --state ABSOLUTE_FILE [--source-root ABSOLUTE_FILE_URI]
                   [--old-source-commit FULLSHA] [--ignore-approval-hold]
  sarif-to-comment [COMMAND] --help

Commands:
  init                 Create a SARIF document for your own findings.
  add-comment          Add one finding on a line or line range to a SARIF file.
  inspect              Show the findings, locations and fixes in a SARIF file.
  add-staged-changes   Add proposed changes from the Git index to a SARIF document.
  publish              Publish a SARIF file as one GitHub draft pull request review.
Every command reads and writes ordinary SARIF files; SARIF from any producer
can be inspected, extended and published without init.

Publishing without a command (the original form) takes the publish options:
${PUBLISH_OPTIONS}${FORMAT_OPTION}  --help                         Show help. Needs no token, makes no request.

${CREDENTIALS}
Exit status:
  0  success; published (or already published)
  2  refused content: blocked (nothing was published), or invalid/failed input
  3  uncertain: delivery could not be confirmed; retry with the same --state
  1  usage error, unreadable file, refused request, or operational failure
`,
  init: md`sarif-to-comment init — create a SARIF document for your own findings

Usage:
  sarif-to-comment init --output FILE [--tool-name NAME [--tool-version V]]
                        [--repo OWNER/REPO --commit FULLSHA] [--format human|json]

Options:
  --output FILE                  New SARIF file; an existing file is refused.
  --tool-name NAME               Who the findings come from, for example
                                 "Review agent" (default: sarif-to-comment).
  --tool-version V               Version of that tool (only with --tool-name).
  --repo OWNER/REPO              Bind the run to this repository ...
  --commit FULLSHA               ... at this full 40-character reviewed commit.
                                 Give both or neither.
${FORMAT_OPTION}
Exit status: 0 created; 1 usage error or the file could not be created.
`,
  'add-comment': md`sarif-to-comment add-comment — add one finding to a SARIF file

Usage:
  sarif-to-comment add-comment --sarif FILE --file PATH --line N [--end-line M]
                               (--message TEXT | --message-file FILE|-) [--markdown]
                               [--rule-id ID] [--level none|note|warning|error]
                               [--run N | --new-run-tool NAME [--new-run-tool-version V]
                                          [--repo OWNER/REPO --commit FULLSHA]]
                               [--format human|json]

The SARIF file is updated in place (atomically). Line numbers are one-based and
refer to the reviewed revision of the file (or to the proposed content of a
file that the reviewed revision does not have).

Options:
  --sarif FILE                   SARIF file to update.
  --file PATH                    Repository-relative path the finding is about.
  --line N                       First line of the finding.
  --end-line M                   Last line (inclusive); default: --line.
  --message TEXT                 The finding's full text.
  --message-file FILE|-          Read the text from a UTF-8 file, or "-" for stdin.
  --markdown                     The text is Markdown.
  --rule-id ID                   Rule identifier to record.
  --level LEVEL                  none, note, warning or error (omitted otherwise).
  --run N                        Add to existing run N (needed when there are several).
  --new-run-tool NAME            Add to a new run attributed to NAME, so another
                                 tool is never credited with your finding.
  --new-run-tool-version V       Version of that tool.
  --repo OWNER/REPO              Bind the new run to this repository ...
  --commit FULLSHA               ... at this reviewed commit. Give both or neither.
${FORMAT_OPTION}
While it runs, the command owns FILE through a marker file
".<name>.sarif-to-comment-lock" beside it; another command's marker is never
taken over.

Exit status: 0 added; 2 the SARIF file is not valid SARIF; 1 usage error or
the file could not be read or replaced.
`,
  inspect: md`sarif-to-comment inspect — show the findings and fixes in a SARIF file

Usage:
  sarif-to-comment inspect --sarif FILE [--preview-lines N|all] [--preview-chars N|all]
                           [--source-root ABSOLUTE_FILE_URI] [--format human|json]

Shows every finding with its full text, locations and fixes. Only fix previews
are shortened, and visibly so. The file is not changed and nothing is contacted.
Inspection is not a check that the file can be published.

Options:
  --sarif FILE                   SARIF file to inspect.
  --preview-lines N|all          Lines shown per fix preview (default 20).
  --preview-chars N|all          Characters shown per fix preview (default 2000).
  --source-root ABSOLUTE_FILE_URI
                                 Repository root in the SARIF producer's file
                                 system (file:///.../ ending in "/").
${FORMAT_OPTION}
Exit status: 0 inspected; 2 not valid SARIF; 1 usage error or unreadable file.
`,
  'add-staged-changes': md`sarif-to-comment add-staged-changes — Add proposed changes from the Git index to a SARIF document.

Usage:
  sarif-to-comment add-staged-changes --sarif IN --output OUT --worktree DIR
                                      --repo OWNER/REPO --commit FULLSHA
                                      [--source-root ABSOLUTE_FILE_URI] [--format human|json]

Reads what is staged in DIR's Git index (never unstaged working-tree content),
compares it with the reviewed commit, and writes a copy of IN to OUT in which
the staged changes are fixes on the findings they belong to. Source files and
the index are not changed.

Options:
  --sarif IN                     SARIF file to start from (not changed).
  --output OUT                   Where to write the result; must differ from IN.
  --worktree DIR                 A directory in the Git working tree whose index is read.
  --repo OWNER/REPO              GitHub repository recorded as the fixes' source.
  --commit FULLSHA               Reviewed commit the staged changes are compared with.
  --source-root ABSOLUTE_FILE_URI
                                 Repository root in the SARIF producer's file system.
${FORMAT_OPTION}
Existing output is preserved: if OUT exists it is first renamed to
"<UTC time>.old.<name>" beside it (its creation time, or its modification time
when the system does not record one). If the command then fails, no OUT is
written. While it runs, the command owns OUT through a marker file
".<name>.sarif-to-comment-lock" beside it.

Exit status: 0 written; 2 invalid SARIF or a staged change that cannot be
represented faithfully (nothing written); 1 usage error or operational failure.
`,
  publish: md`sarif-to-comment publish — publish a SARIF file as one GitHub draft review

Usage:
  sarif-to-comment publish --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA
                           --state ABSOLUTE_FILE [--source-root ABSOLUTE_FILE_URI]
                           [--old-source-commit FULLSHA] [--ignore-approval-hold]
                           [--format human|json]

The same operation as the original form without a command.

Options:
${PUBLISH_OPTIONS}${FORMAT_OPTION}
${CREDENTIALS}
Exit status:
  0  published (or already published)
  2  blocked: nothing was published
  3  uncertain: delivery could not be confirmed; retry with the same --state
  1  usage error, unreadable SARIF file, refused request, or operational failure
`,
};

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

/** A command-line mistake the user fixes by changing the arguments. */
class UsageError extends Error {}

/**
 * Removes the `--format` option from argv and resolves it. Throws UsageError
 * (always reported in human form) when it is repeated, valueless or unknown.
 */
function resolveFormat(argv) {
  const rest = [];
  let format;
  let seen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let value;
    if (arg === '--format') {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError('--format requires a value: human or json');
      i += 1;
    } else if (arg.startsWith('--format=')) {
      value = arg.slice('--format='.length);
    } else {
      rest.push(arg);
      continue;
    }
    if (seen) throw new UsageError('--format was given more than once');
    seen = true;
    if (value !== 'human' && value !== 'json') throw new UsageError(`--format must be human or json, not ${JSON.stringify(value)}`);
    format = value;
  }
  return { format: format ?? 'human', argv: rest };
}

/**
 * Parses `--flag value` / `--flag=value` options exactly, as the flag-only
 * publisher always has: unknown, repeated, valueless or empty options and
 * positional arguments are usage errors. Returns { values: Map, flags: Set }.
 */
function parseOptions(argv, { values: valueFlags, booleans = [], required = [] }) {
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
    if (!valueFlags.includes(name)) throw new UsageError(`unknown option ${name}`);
    if (values.has(name)) throw new UsageError(`${name} was given more than once`);
    let value;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} requires a value`);
      i += 1;
    }
    if (value === '') throw new UsageError(`${name} requires a non-empty value`);
    values.set(name, value);
  }
  const missing = required.filter((flag) => !values.has(flag));
  if (missing.length > 0) throw new UsageError(`missing required option ${missing.join(', ')}`);
  return { values, flags };
}

/** OWNER/REPO from a flag, validated as GitHub names; throws UsageError. */
function repositoryFlag(values, flag = '--repo') {
  const match = REPO_FLAG_PATTERN.exec(values.get(flag));
  if (!match || !OWNER_PATTERN.test(match[1]) || !REPO_PATTERN.test(match[2]) || match[2] === '.' || match[2] === '..') {
    throw new UsageError(`${flag} must be OWNER/REPO`);
  }
  return { owner: match[1], repo: match[2] };
}

/** A full lowercase commit from a flag, or undefined; throws UsageError. */
function commitFlag(values, flag) {
  const value = values.get(flag);
  if (value !== undefined && !COMMIT_FLAG_PATTERN.test(value)) {
    throw new UsageError(`${flag} must be a full 40-character lowercase commit SHA`);
  }
  return value;
}

/** `{ owner, repo, commit }` from --repo/--commit given together, or undefined. */
function optionalSource(values) {
  const hasRepo = values.has('--repo');
  const hasCommit = values.has('--commit');
  if (hasRepo && !hasCommit) throw new UsageError('--repo requires --commit (give both or neither)');
  if (hasCommit && !hasRepo) throw new UsageError('--commit requires --repo (give both or neither)');
  if (!hasRepo) return undefined;
  const { owner, repo } = repositoryFlag(values);
  return { owner, repo, commit: commitFlag(values, '--commit') };
}

/** A `--source-root` value, or undefined; throws UsageError. */
function sourceRootFlag(values) {
  const value = values.get('--source-root');
  if (value !== undefined && !(value.startsWith('file:') && value.endsWith('/'))) {
    throw new UsageError('--source-root must be an absolute file: URI ending in "/"');
  }
  return value;
}

/** A positive whole number from a flag; throws UsageError. */
function positiveFlag(values, flag) {
  const value = values.get(flag);
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`${flag} must be a positive whole number`);
  }
  return Number(value);
}

/** A preview limit: a positive whole number, or "all" (no limit, null); throws UsageError. */
function previewFlag(values, flag) {
  const value = values.get(flag);
  if (value === undefined) return undefined;
  if (value === 'all') return null;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`${flag} must be a positive whole number or "all"`);
  }
  return Number(value);
}

/** The credential: GH_TOKEN, else GITHUB_TOKEN; empty counts as unset. */
function tokenFrom(env) {
  if (typeof env.GH_TOKEN === 'string' && env.GH_TOKEN !== '') return env.GH_TOKEN;
  if (typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN !== '') return env.GITHUB_TOKEN;
  return undefined;
}

/** An error's message and cause chain, one line each. */
function describeError(err) {
  const lines = [];
  const seen = new Set();
  for (let current = err; current !== undefined && current !== null && !seen.has(current); current = current.cause) {
    seen.add(current);
    lines.push(lines.length === 0 ? String(current.message ?? current) : `  caused by: ${current.message ?? current}`);
    if (!(current instanceof Error)) break;
  }
  return lines.join('\n');
}

/** Reads all of a readable stream as a Buffer. */
async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** SARIF as written by the CLI: two-space indented JSON with a final newline. */
function serialize(sarif) {
  return `${JSON.stringify(sarif, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Outcomes
//
// Every handler returns an Outcome: { exit, doc, out?, err? }. `doc` is the
// JSON document (always complete, so both formats carry the same facts); `out`
// and `err` are the human renderings for stdout and stderr.
// ---------------------------------------------------------------------------

/** An operational failure after arguments were accepted, with its artifact receipt fields. */
function errorOutcome(command, message, receipt = {}, humanNotes = []) {
  const notes = humanNotes.length === 0 ? '' : `\n${humanNotes.join('\n')}`;
  return { exit: EXIT.error, doc: { command, status: 'error', message, ...receipt }, err: `sarif-to-comment: ${message}${notes}\n` };
}

/** A usage error; `usage` is the command's help (or the top-level help). */
function usageOutcome(command, message, legacy = false) {
  const hint = legacy || command === null ? 'sarif-to-comment --help' : `sarif-to-comment ${command} --help`;
  return {
    exit: EXIT.usage,
    doc: { command, status: 'usage-error', message, usage: USAGE[command ?? 'top'] ?? USAGE.top },
    err: `sarif-to-comment: ${message}\nRun ${hint} for usage.\n`,
  };
}

/** Human text for refused content: the library's Markdown and what happened to files. */
function refusedText(markdown, notes) {
  const text = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  return notes.length === 0 ? text : `${text}\n${notes.join('\n')}\n`;
}

/** A one-based line or inclusive range, written like inspection output (`2` or `5-6`). */
const lineRange = (start, end) => (end === undefined || end === start ? `${start}` : `${start}-${end}`);

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

function init(argv, { cwd }) {
  const { values } = parseOptions(argv, {
    values: ['--output', '--tool-name', '--tool-version', '--repo', '--commit'],
    required: ['--output'],
  });
  if (values.has('--tool-version') && !values.has('--tool-name')) {
    throw new UsageError("--tool-version requires --tool-name (this package's version is never attributed to another tool)");
  }
  const source = optionalSource(values);
  const options = {};
  if (values.has('--tool-name')) {
    options.tool = { name: values.get('--tool-name') };
    if (values.has('--tool-version')) options.tool.version = values.get('--tool-version');
  }
  if (source) options.source = source;
  let sarif;
  try {
    sarif = library.createSarifDocument(options);
  } catch (err) {
    if (err instanceof TypeError) throw new UsageError(err.message);
    throw err;
  }

  const output = path.resolve(cwd, values.get('--output'));
  try {
    files.createExclusive(output, serialize(sarif));
  } catch (err) {
    if (!(err instanceof files.ArtifactError)) throw err;
    return errorOutcome('init', err.message, { output: { path: output, written: false } });
  }
  const doc = { command: 'init', status: 'created', output: { path: output, written: true }, runIndex: 0 };
  const run = sarif.runs[0];
  const binding = run.versionControlProvenance?.[0];
  if (binding) doc.source = { repositoryUri: binding.repositoryUri, commit: binding.revisionId };
  const tool = run.tool.driver.version === undefined ? run.tool.driver.name : `${run.tool.driver.name} ${run.tool.driver.version}`;
  const bound = binding ? `, bound to ${binding.repositoryUri} at ${binding.revisionId}` : ', not bound to a commit';
  return {
    exit: EXIT.ok,
    doc,
    out: `Created ${output}: a SARIF document with one run (run 0, tool "${tool}"${bound}).\n`,
  };
}

// ---------------------------------------------------------------------------
// add-comment
// ---------------------------------------------------------------------------

async function addComment(argv, { cwd, stdin }) {
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
  const file = values.get('--file');
  if (!isNormalizedRepositoryPath(file)) {
    throw new UsageError('--file must be a repository-relative path with "/" separators and no leading "/", ".", ".." or empty segment');
  }
  const line = positiveFlag(values, '--line');
  const endLine = positiveFlag(values, '--end-line');
  if (endLine !== undefined && endLine < line) throw new UsageError('--end-line must not be smaller than --line');
  const level = values.get('--level');
  if (level !== undefined && !['none', 'note', 'warning', 'error'].includes(level)) {
    throw new UsageError('--level must be none, note, warning or error');
  }
  const newRunTool = values.get('--new-run-tool');
  if (values.has('--run') && newRunTool !== undefined) throw new UsageError('--run and --new-run-tool cannot be combined');
  for (const flag of ['--new-run-tool-version', '--repo', '--commit']) {
    if (values.has(flag) && newRunTool === undefined) throw new UsageError(`${flag} applies only to a new run: give --new-run-tool NAME`);
  }
  let run;
  if (values.has('--run')) {
    const index = values.get('--run');
    if (!/^(0|[1-9][0-9]*)$/.test(index)) throw new UsageError('--run must be a run index (0, 1, ...)');
    run = Number(index);
  } else if (newRunTool !== undefined) {
    run = { toolName: newRunTool };
    if (values.has('--new-run-tool-version')) run.toolVersion = values.get('--new-run-tool-version');
    const source = optionalSource(values);
    if (source) run.source = source;
  }

  const sarifPath = path.resolve(cwd, values.get('--sarif'));
  const notWritten = { sarif: { path: sarifPath, written: false } };

  let message;
  try {
    if (values.has('--message')) {
      message = values.get('--message');
    } else if (values.get('--message-file') === '-') {
      message = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readStream(stdin));
    } else {
      message = files.readTextFile(path.resolve(cwd, values.get('--message-file')), 'message file').text;
    }
  } catch (err) {
    if (err instanceof files.ArtifactError) return errorOutcome('add-comment', err.message, notWritten);
    if (err instanceof TypeError) return errorOutcome('add-comment', 'standard input is not valid UTF-8; the message must be UTF-8 encoded.', notWritten);
    throw err;
  }
  if (message === '') throw new UsageError('the message must not be empty');

  const comment = { file, line, message };
  if (endLine !== undefined) comment.endLine = endLine;
  if (flags.has('--markdown')) comment.messageFormat = 'markdown';
  if (values.has('--rule-id')) comment.ruleId = values.get('--rule-id');
  if (level !== undefined) comment.level = level;
  if (run !== undefined) comment.run = run;

  // Edit the real file behind any symbolic link, so the link itself survives.
  let target;
  try {
    target = fs.realpathSync(sarifPath);
  } catch (err) {
    return errorOutcome('add-comment', `cannot read SARIF file ${sarifPath}: ${err.message}`, notWritten);
  }
  let release;
  try {
    release = files.acquireOwnership(target);
  } catch (err) {
    if (err instanceof files.ArtifactError) return errorOutcome('add-comment', err.message, notWritten);
    throw err;
  }
  try {
    let read;
    try {
      read = files.readJsonFile(target, 'SARIF file');
    } catch (err) {
      if (err instanceof files.ArtifactError) return errorOutcome('add-comment', err.message, notWritten);
      throw err;
    }
    let outcome;
    try {
      outcome = library.addSarifComment(read.value, comment);
    } catch (err) {
      if (err instanceof TypeError) {
        throw new UsageError(`${err.message}. Select a run with --run N, or add one with --new-run-tool NAME.`);
      }
      throw err;
    }
    if (outcome.status === 'invalid') {
      return {
        exit: EXIT.refused,
        doc: { command: 'add-comment', status: 'invalid', ...notWritten, problems: outcome.problems },
        out: refusedText(outcome.markdown, [`${sarifPath} was not changed.`]),
      };
    }
    try {
      files.replaceIfUnchanged(target, read.bytes, serialize(outcome.sarif));
    } catch (err) {
      if (err instanceof files.ArtifactError) return errorOutcome('add-comment', err.message, notWritten);
      throw err;
    }
    const finding = { ref: outcome.finding.ref, path: file, line, endLine: endLine ?? line, tool: outcome.finding.tool };
    return {
      exit: EXIT.ok,
      doc: { command: 'add-comment', status: 'added', sarif: { path: sarifPath, written: true }, finding },
      out: `Added ${finding.ref} (tool "${finding.tool}") on ${file}:${lineRange(line, endLine)} to ${sarifPath}.\n`,
    };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

function inspect(argv, { cwd }) {
  const { values } = parseOptions(argv, {
    values: ['--sarif', '--preview-lines', '--preview-chars', '--source-root'],
    required: ['--sarif'],
  });
  const options = {};
  const previewLines = previewFlag(values, '--preview-lines');
  const previewChars = previewFlag(values, '--preview-chars');
  const sourceRootUri = sourceRootFlag(values);
  if (previewLines !== undefined) options.previewLines = previewLines;
  if (previewChars !== undefined) options.previewChars = previewChars;
  if (sourceRootUri !== undefined) options.sourceRootUri = sourceRootUri;

  const sarifPath = path.resolve(cwd, values.get('--sarif'));
  let read;
  try {
    read = files.readJsonFile(sarifPath, 'SARIF file');
  } catch (err) {
    if (err instanceof files.ArtifactError) return errorOutcome('inspect', err.message);
    throw err;
  }
  let outcome;
  try {
    outcome = library.inspectSarif(read.value, options);
  } catch (err) {
    if (err instanceof TypeError) throw new UsageError(err.message);
    throw err;
  }
  if (outcome.status === 'invalid') {
    return {
      exit: EXIT.refused,
      doc: { command: 'inspect', status: 'invalid', problems: outcome.problems },
      out: refusedText(outcome.markdown, []),
    };
  }
  const text = renderInspectionText(outcome.view);
  return {
    exit: EXIT.ok,
    doc: { command: 'inspect', status: 'inspected', view: outcome.view },
    out: text.endsWith('\n') ? text : `${text}\n`,
  };
}

// ---------------------------------------------------------------------------
// add-staged-changes
// ---------------------------------------------------------------------------

/** Human lines describing an extraction receipt. */
function stagedReceiptText(receipt) {
  const lines = [];
  if (receipt.changes.length === 0) lines.push('No staged changes: the SARIF content is unchanged.');
  for (const change of receipt.changes) {
    if (change.operation === 'edit') {
      lines.push(`${change.operation} ${change.path}`);
      for (const r of change.replacements ?? []) {
        const who = r.associated.length === 0 ? 'no finding' : r.associated.join(', ');
        // A pure insertion changes no reviewed line; its empty range ends at the
        // line it follows, so name that position rather than a changed range.
        const where = r.insertion
          ? `${r.endLine === 0 ? 'insertion at the start of the file' : `insertion after line ${r.endLine}`} (no reviewed line changed)`
          : `lines ${lineRange(r.startLine, r.endLine)}`;
        lines.push(`  ${where}: ${who} (explained by ${r.explainedBy})`);
      }
    } else {
      const who = (change.associated ?? []).length === 0 ? 'no finding' : change.associated.join(', ');
      lines.push(`${change.operation} ${change.path}: ${who} (explained by ${change.explainedBy})`);
    }
  }
  if (receipt.boundRuns.length > 0) lines.push(`Runs bound to ${receipt.reviewedCommit}: ${receipt.boundRuns.join(', ')}`);
  if (receipt.addedRun !== null) lines.push(`Changes no finding explains are in run ${receipt.addedRun}.`);
  for (const warning of receipt.warnings) lines.push(`Warning: ${warning.message}`);
  return lines;
}

/** Human line describing an archived output. */
function archiveNote(archived) {
  if (!archived) return [];
  const time = archived.timeSource === 'birth' ? 'creation' : 'modification';
  return [`The previous ${archived.from} was preserved as ${archived.path} (named by its ${time} time).`];
}

async function addStagedChanges(argv, { cwd }) {
  const { values } = parseOptions(argv, {
    values: ['--sarif', '--output', '--worktree', '--repo', '--commit', '--source-root'],
    required: ['--sarif', '--output', '--worktree', '--repo', '--commit'],
  });
  const repository = repositoryFlag(values);
  const reviewedCommit = commitFlag(values, '--commit');
  const sourceRootUri = sourceRootFlag(values);
  const input = path.resolve(cwd, values.get('--sarif'));
  const output = path.resolve(cwd, values.get('--output'));
  const worktree = path.resolve(cwd, values.get('--worktree'));
  if (input === output || files.sameExistingFile(input, output)) {
    throw new UsageError(`--output must be a different file from --sarif (${output} and ${input} are the same file)`);
  }
  let outputDirectory;
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
  let release;
  try {
    release = files.acquireOwnership(output);
  } catch (err) {
    if (err instanceof files.ArtifactError) {
      return errorOutcome(command, err.message, { output: { path: output, written: false }, archived: null });
    }
    throw err;
  }
  let archived = null;
  const receiptFields = () => ({ output: { path: output, written: false }, archived });
  const notes = () => [`${output} was not written.`, ...archiveNote(archived)];
  try {
    try {
      archived = files.archiveExisting(output);
    } catch (err) {
      if (err instanceof files.ArtifactError) return errorOutcome(command, err.message, receiptFields(), notes());
      throw err;
    }
    let read;
    try {
      read = files.readJsonFile(input, 'SARIF file');
    } catch (err) {
      if (err instanceof files.ArtifactError) return errorOutcome(command, err.message, receiptFields(), notes());
      throw err;
    }
    const request = { sarif: read.value, worktree, reviewedCommit, repository };
    if (sourceRootUri !== undefined) request.sourceRootUri = sourceRootUri;
    let outcome;
    try {
      outcome = await library.addStagedChangesToSarif(request);
    } catch (err) {
      return errorOutcome(command, describeError(err), receiptFields(), notes());
    }
    if (outcome.status === 'invalid' || outcome.status === 'failed') {
      return {
        exit: EXIT.refused,
        doc: { command, status: outcome.status, ...receiptFields(), problems: outcome.problems },
        out: refusedText(outcome.markdown, notes()),
      };
    }
    try {
      files.createExclusive(output, serialize(outcome.sarif));
    } catch (err) {
      if (err instanceof files.ArtifactError) return errorOutcome(command, err.message, receiptFields(), notes());
      throw err;
    }
    return {
      exit: EXIT.ok,
      doc: { command, status: 'added', output: { path: output, written: true }, archived, receipt: outcome.receipt },
      out: `${[`Wrote ${output}.`, ...archiveNote(archived), ...stagedReceiptText(outcome.receipt)].join('\n')}\n`,
    };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// publish (and the flag-only publisher)
// ---------------------------------------------------------------------------

const PUBLISH_SPEC = {
  values: ['--sarif', '--repo', '--pull', '--commit', '--state', '--source-root', '--old-source-commit'],
  booleans: ['--ignore-approval-hold'],
  required: ['--sarif', '--repo', '--pull', '--commit', '--state'],
};

/** Library input fields from publish options; throws UsageError. */
function publishRequest(argv) {
  const { values, flags } = parseOptions(argv, PUBLISH_SPEC);
  const repo = REPO_FLAG_PATTERN.exec(values.get('--repo'));
  if (!repo) throw new UsageError('--repo must be OWNER/REPO');
  const pull = values.get('--pull');
  if (!/^[1-9][0-9]*$/.test(pull) || !Number.isSafeInteger(Number(pull))) {
    throw new UsageError('--pull must be a positive pull request number');
  }
  const statePath = values.get('--state');
  if (!path.isAbsolute(statePath)) throw new UsageError('--state must be an absolute file path');
  const input = {
    destination: { owner: repo[1], repo: repo[2], pullNumber: Number(pull) },
    reviewedCommit: commitFlag(values, '--commit'),
    statePath,
  };
  const oldSourceCommit = commitFlag(values, '--old-source-commit');
  if (oldSourceCommit !== undefined) input.oldSourceCommit = oldSourceCommit;
  const sourceRootUri = sourceRootFlag(values);
  if (sourceRootUri !== undefined) input.sourceRootUri = sourceRootUri;
  if (flags.has('--ignore-approval-hold')) input.options = { ignoreApprovalHold: true };
  return { sarifPath: values.get('--sarif'), input };
}

/**
 * Publication. Human output is exactly the flag-only publisher's: the
 * library's Markdown on stdout, errors on stderr. The SARIF path is used as
 * given, as it always has been.
 */
async function publish(argv, { env }, internals) {
  const request = publishRequest(argv);
  const token = tokenFrom(env);
  if (token === undefined) {
    return errorOutcome('publish', 'no GitHub token: set GH_TOKEN (or GITHUB_TOKEN) to a personal access token or user token.');
  }
  let sarif;
  try {
    ({ value: sarif } = files.readJsonFile(request.sarifPath, 'SARIF file'));
  } catch (err) {
    if (!(err instanceof files.ArtifactError)) throw err;
    // The flag-only publisher's wording for these failures, kept exactly.
    const message = err.message.includes('is not valid UTF-8')
      ? `SARIF file ${request.sarifPath} is not valid UTF-8; nothing was published. SARIF files must be UTF-8 encoded JSON.`
      : err.message;
    return errorOutcome('publish', message);
  }
  let outcome;
  try {
    outcome = await library.publishSarifReview({ ...request.input, sarif, token }, internals);
  } catch (err) {
    return errorOutcome('publish', describeError(err));
  }
  const doc = { command: 'publish', status: outcome.status };
  if (outcome.review) doc.review = { id: outcome.review.id, url: outcome.review.url };
  if (outcome.statePath) doc.statePath = outcome.statePath;
  doc.message = outcome.markdown;
  return {
    exit: PUBLISH_EXIT[outcome.status] ?? EXIT.error,
    doc,
    out: outcome.markdown.endsWith('\n') ? outcome.markdown : `${outcome.markdown}\n`,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const HANDLERS = {
  init,
  'add-comment': addComment,
  inspect,
  'add-staged-changes': addStagedChanges,
  publish,
};

/**
 * Runs the CLI and returns its exit status; expected failures never throw.
 *
 * @param {{ argv: string[], env: object, stdout: object, stderr: object,
 *           stdin?: object, cwd?: string }} io
 *   argv: arguments after the executable; stdin is read only by
 *   `add-comment --message-file -`; cwd resolves relative paths (default:
 *   the process's working directory).
 * @param {object} [internals] passed to publishSarifReview (private test seam)
 */
async function main({ argv, env, stdout, stderr, stdin = process.stdin, cwd = process.cwd() }, internals) {
  const token = tokenFrom(env);
  const safe = (text) => (token === undefined ? String(text) : String(text).split(token).join('[redacted]'));

  let format;
  let args;
  try {
    ({ format, argv: args } = resolveFormat(argv));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(safe(`sarif-to-comment: ${err.message}\nRun sarif-to-comment --help for usage.\n`));
    return EXIT.usage;
  }

  const legacy = args.length === 0 || args[0].startsWith('-');
  const command = legacy ? 'publish' : COMMANDS.includes(args[0]) ? args[0] : null;
  const rest = legacy ? args : args.slice(1);

  let outcome;
  if (command === null) {
    outcome = usageOutcome(null, `unknown command ${args[0]}`);
  } else if (rest.includes('--help') || rest.includes('-h')) {
    const helpCommand = legacy ? null : command;
    const usage = USAGE[helpCommand ?? 'top'];
    outcome = { exit: EXIT.ok, doc: { command: helpCommand, status: 'help', usage }, out: usage };
  } else {
    try {
      outcome = await HANDLERS[command](rest, { env, stdin, cwd }, internals);
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      outcome = usageOutcome(command, err.message, legacy);
    }
  }

  if (format === 'json') {
    stdout.write(safe(`${JSON.stringify(outcome.doc, null, 2)}\n`));
  } else {
    if (outcome.out !== undefined) stdout.write(safe(outcome.out));
    if (outcome.err !== undefined) stderr.write(safe(outcome.err));
  }
  return outcome.exit;
}

module.exports = { main, USAGE };
