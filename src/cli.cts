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

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as files from './artifact-files.cjs';
import type { IArchivedOutput, IJsonFile, ReleaseOwnership } from './artifact-files.cjs';
import type { IPublishSarifReviewInternals } from './publish-sarif-review.cjs';
import { publishSarifReviewWithInternals } from './publish-sarif-review.cjs';
import type { ISarifSourceBinding } from './public-types.cjs';
import { createSarifDocument, addSarifCommentWithUntypedInput } from './sarif-authoring.cjs';
import type { ICreateSarifDocumentOptions, INewSarifRun, ISarifComment } from './sarif-authoring.cjs';
import { isNormalizedRepositoryPath, OWNER_PATTERN, REPO_PATTERN } from './sarif-common.cjs';
import { inspectSarifWithUntypedInput, renderInspectionText } from './sarif-inspection.cjs';
import type { IInspectSarifOptions } from './sarif-inspection.cjs';
import { addStagedChangesToSarifWithUntypedInput } from './staged-changes.cjs';
import type { IStagedChangesReceipt } from './staged-changes.cjs';

const md = String.raw;

/** A CLI command, in workflow order. */
type CliCommand = 'init' | 'add-comment' | 'inspect' | 'add-staged-changes' | 'publish';

/** The commands, in workflow order. */
const COMMANDS: readonly CliCommand[] = ['init', 'add-comment', 'inspect', 'add-staged-changes', 'publish'];

/** Exit statuses for non-publication outcomes (§5). */
const EXIT: Readonly<{ ok: 0; usage: 1; error: 1; refused: 2 }> = Object.freeze({ ok: 0, usage: 1, error: 1, refused: 2 });

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

/** Help text: the top-level usage and each command's. */
const USAGE: Readonly<Record<'top' | CliCommand, string>> = {
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

/** An output format; human is the default and is never inferred from a terminal. */
type OutputFormat = 'human' | 'json';

/** Parsed options: each value option's value, and the boolean flags given. */
interface IParsedOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

/** The options a command accepts; every other option is a usage error. */
interface IOptionSpec {
  readonly values: readonly string[];
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

/**
 * Removes the `--format` option from argv and resolves it. Throws UsageError
 * (always reported in human form) when it is repeated, valueless or unknown.
 */
function resolveFormat(argv: readonly string[]): { readonly format: OutputFormat; readonly argv: string[] } {
  const rest: string[] = [];
  let format: OutputFormat | undefined;
  let seen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argAt(argv, i);
    let value: string;
    if (arg === '--format') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError('--format requires a value: human or json');
      value = next;
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
function parseOptions(argv: readonly string[], { values: valueFlags, booleans = [], required = [] }: IOptionSpec): IParsedOptions {
  const values = new Map<string, string>();
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
    if (!valueFlags.includes(name)) throw new UsageError(`unknown option ${name}`);
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
    values.set(name, value);
  }
  const missing = required.filter((flag) => !values.has(flag));
  if (missing.length > 0) throw new UsageError(`missing required option ${missing.join(', ')}`);
  return { values, flags };
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
// Every handler returns an Outcome: { exit, doc, out?, err? }. `doc` is the
// JSON document (always complete, so both formats carry the same facts); `out`
// and `err` are the human renderings for stdout and stderr.
// ---------------------------------------------------------------------------

/** The JSON document of an outcome: `{ command, status, ... }`. */
type OutcomeDocument = Readonly<Record<string, unknown>>;

/** What a handled invocation produced (see above). */
interface IOutcome {
  readonly exit: number;
  readonly doc: OutcomeDocument;
  readonly out?: string;
  readonly err?: string;
}

/** An artifact receipt: the fields naming files written, archived or deliberately not written. */
type ArtifactReceipt = Readonly<Record<string, unknown>>;

/** An operational failure after arguments were accepted, with its artifact receipt fields. */
function errorOutcome(command: CliCommand, message: string, receipt: ArtifactReceipt = {}, humanNotes: readonly string[] = []): IOutcome {
  const notes = humanNotes.length === 0 ? '' : `\n${humanNotes.join('\n')}`;
  return { exit: EXIT.error, doc: { command, status: 'error', message, ...receipt }, err: `sarif-to-comment: ${message}${notes}\n` };
}

/** A usage error; `usage` is the command's help (or the top-level help). */
function usageOutcome(command: CliCommand | null, message: string, legacy = false): IOutcome {
  const hint = legacy || command === null ? 'sarif-to-comment --help' : `sarif-to-comment ${command} --help`;
  return {
    exit: EXIT.usage,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- every command has help text; the top-level fallback is kept as the durable guard it always was
    doc: { command, status: 'usage-error', message, usage: USAGE[command ?? 'top'] ?? USAGE.top },
    err: `sarif-to-comment: ${message}\nRun ${hint} for usage.\n`,
  };
}

/** Human text for refused content: the library's Markdown and what happened to files. */
function refusedText(markdown: string, notes: readonly string[]): string {
  const text = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  return notes.length === 0 ? text : `${text}\n${notes.join('\n')}\n`;
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
    return errorOutcome('init', err.message, { output: { path: output, written: false } });
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
    if (err instanceof files.ArtifactError) return errorOutcome('add-comment', err.message, notWritten);
    if (err instanceof TypeError) return errorOutcome('add-comment', 'standard input is not valid UTF-8; the message must be UTF-8 encoded.', notWritten);
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

  // Edit the real file behind any symbolic link, so the link itself survives.
  let target: string;
  try {
    target = fs.realpathSync(sarifPath);
  } catch (err) {
    return errorOutcome('add-comment', `cannot read SARIF file ${sarifPath}: ${String(messageProperty(err))}`, notWritten);
  }
  let release: ReleaseOwnership;
  try {
    release = files.acquireOwnership(target);
  } catch (err) {
    if (err instanceof files.ArtifactError) return errorOutcome('add-comment', err.message, notWritten);
    throw err;
  }
  try {
    let read: IJsonFile;
    try {
      read = files.readJsonFile(target, 'SARIF file');
    } catch (err) {
      if (err instanceof files.ArtifactError) return errorOutcome('add-comment', err.message, notWritten);
      throw err;
    }
    let outcome;
    try {
      outcome = addSarifCommentWithUntypedInput(read.value, comment);
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
    if (err instanceof files.ArtifactError) return errorOutcome('inspect', err.message);
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
  for (const warning of receipt.warnings) lines.push(`Warning: ${warning.message}`);
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
      return errorOutcome(command, err.message, { output: { path: output, written: false }, archived: null });
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
      if (err instanceof files.ArtifactError) return errorOutcome(command, err.message, receiptFields(), notes());
      throw err;
    }
    let read: IJsonFile;
    try {
      read = files.readJsonFile(input, 'SARIF file');
    } catch (err) {
      if (err instanceof files.ArtifactError) return errorOutcome(command, err.message, receiptFields(), notes());
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

const PUBLISH_SPEC: IOptionSpec = {
  values: ['--sarif', '--repo', '--pull', '--commit', '--state', '--source-root', '--old-source-commit'],
  booleans: ['--ignore-approval-hold'],
  required: ['--sarif', '--repo', '--pull', '--commit', '--state'],
};

/** Library input fields from publish options (everything but the SARIF and the token). */
interface IPublishRequest {
  readonly sarifPath: string;
  readonly input: {
    readonly destination: { readonly owner: string; readonly repo: string; readonly pullNumber: number };
    readonly reviewedCommit: string;
    readonly statePath: string;
    readonly oldSourceCommit?: string;
    readonly sourceRootUri?: string;
    readonly options?: { readonly ignoreApprovalHold: true };
  };
}

/** Library input fields from publish options; throws UsageError. */
function publishRequest(argv: readonly string[]): IPublishRequest {
  const { values, flags } = parseOptions(argv, PUBLISH_SPEC);
  const repo = REPO_FLAG_PATTERN.exec(requiredValue(values, '--repo'));
  const owner = repo?.[1];
  const name = repo?.[2];
  if (owner === undefined || name === undefined) throw new UsageError('--repo must be OWNER/REPO');
  const pull = requiredValue(values, '--pull');
  if (!/^[1-9][0-9]*$/.test(pull) || !Number.isSafeInteger(Number(pull))) {
    throw new UsageError('--pull must be a positive pull request number');
  }
  const statePath = requiredValue(values, '--state');
  if (!path.isAbsolute(statePath)) throw new UsageError('--state must be an absolute file path');
  const destination = { owner, repo: name, pullNumber: Number(pull) };
  const reviewedCommit = commitValue(requiredValue(values, '--commit'), '--commit');
  const oldSourceCommit = commitFlag(values, '--old-source-commit');
  const sourceRootUri = sourceRootFlag(values);
  const input = {
    destination,
    reviewedCommit,
    statePath,
    ...(oldSourceCommit === undefined ? {} : { oldSourceCommit }),
    ...(sourceRootUri === undefined ? {} : { sourceRootUri }),
    ...(flags.has('--ignore-approval-hold') ? { options: { ignoreApprovalHold: true as const } } : {}),
  };
  return { sarifPath: requiredValue(values, '--sarif'), input };
}

/**
 * Publication. Human output is exactly the flag-only publisher's: the
 * library's Markdown on stdout, errors on stderr. The SARIF path is used as
 * given, as it always has been.
 */
async function publish(
  argv: readonly string[],
  { env }: IHandlerContext,
  internals: IPublishSarifReviewInternals | undefined,
): Promise<IOutcome> {
  const request = publishRequest(argv);
  const token = tokenFrom(env);
  if (token === undefined) {
    return errorOutcome('publish', 'no GitHub token: set GH_TOKEN (or GITHUB_TOKEN) to a personal access token or user token.');
  }
  let sarif: unknown;
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
    outcome = await publishSarifReviewWithInternals({ ...request.input, sarif, token }, internals);
  } catch (err) {
    return errorOutcome('publish', describeError(err));
  }
  const doc = {
    command: 'publish',
    status: outcome.status,
    ...('review' in outcome ? { review: { id: outcome.review.id, url: outcome.review.url } } : {}),
    ...('statePath' in outcome && outcome.statePath ? { statePath: outcome.statePath } : {}),
    message: outcome.markdown,
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- every publication status has an exit status; the operational-error fallback is kept as the durable guard it always was
    exit: PUBLISH_EXIT[outcome.status] ?? EXIT.error,
    doc,
    out: outcome.markdown.endsWith('\n') ? outcome.markdown : `${outcome.markdown}\n`,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** A command handler: arguments after the command, the invocation, and the private seam. */
type Handler = (
  argv: readonly string[],
  context: IHandlerContext,
  internals: IPublishSarifReviewInternals | undefined,
) => IOutcome | Promise<IOutcome>;

const HANDLERS: Readonly<Record<CliCommand, Handler>> = {
  init,
  'add-comment': addComment,
  inspect,
  'add-staged-changes': addStagedChanges,
  publish,
};

/** Whether an argument names a command. */
function isCommand(arg: string): arg is CliCommand {
  return COMMANDS.some((command) => command === arg);
}

/** Something the CLI writes its output to (the process's stdout or stderr, or a test's capture). */
interface IOutputStream {
  write(text: string): unknown;
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
 * @param internals - passed to publishSarifReview (private test seam; the
 *   shipped executable's test wrapper injects a fake GitHub client through it)
 */
async function main(
  { argv, env, stdout, stderr, stdin = process.stdin, cwd = process.cwd() }: ICliIo,
  internals?: IPublishSarifReviewInternals,
): Promise<number> {
  const token = tokenFrom(env);
  const safe = (text: string): string => (token === undefined ? text : text.split(token).join('[redacted]'));

  let format: OutputFormat;
  let args: string[];
  try {
    ({ format, argv: args } = resolveFormat(argv));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(safe(`sarif-to-comment: ${err.message}\nRun sarif-to-comment --help for usage.\n`));
    return EXIT.usage;
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

export { main, USAGE };
