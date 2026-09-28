#!/usr/bin/env node
'use strict';

/**
 * Thin command-line interface over publishSarifReview (src/index.cjs).
 *
 * Reads one SARIF JSON file, calls the same library operation library
 * consumers use, and prints that operation's Markdown. It has no rendering,
 * placement or delivery logic of its own: argument parsing, file reading,
 * credential selection and exit-status mapping are its only concerns.
 *
 * Usage:
 *   sarif-to-comment --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA
 *                    --state ABSOLUTE_FILE [--source-root ABSOLUTE_FILE_URI]
 *                    [--old-source-commit FULLSHA] [--ignore-approval-hold]
 *   sarif-to-comment --help
 *
 * Flags accept `--flag value` or `--flag=value`. Unknown, missing, valueless
 * or repeated flags and positional arguments are usage errors.
 * `--ignore-approval-hold` takes no value and bypasses only an approval hold.
 * There is no token flag and no reset/force-resend flag: `--state` is the
 * durable identity of one publication; retry with the same path.
 *
 * Credential: GH_TOKEN, else GITHUB_TOKEN (empty counts as unset). Both are
 * treated as user/PAT credentials; automatic Actions tokens are not claimed to
 * be supported. The token never appears in output; any occurrence in an error
 * is redacted. `--help` needs no token and makes no network call.
 *
 * Output and exit status:
 *   stdout: the operation's Markdown for any outcome
 *   stderr: usage, input-file and operational errors (actionable, redacted)
 *   0 published   2 blocked   3 uncertain
 *   1 usage error, unreadable/unparsable SARIF file, operational failure,
 *     local state refusal, or GitHub refusal of the create request
 *
 * ---------------------------------------------------------------------------
 * main({ argv, env, stdout, stderr }, internals?) -> Promise<exitCode>
 *   argv: arguments after the executable; env: environment variables;
 *   stdout/stderr: writable streams. `internals` is passed through to
 *   publishSarifReview (private test seam). Running this file directly calls
 *   main with the process and sets process.exitCode.
 */

const fs = require('node:fs');
const path = require('node:path');

const { publishSarifReview } = require('../src/index.cjs');

/** Exit status per public outcome (and for help); every refusal or failure is 1. */
const EXIT = Object.freeze({ help: 0, published: 0, failure: 1, blocked: 2, uncertain: 3, rejected: 1 });

/** Flags that take exactly one value. */
const VALUE_FLAGS = new Set(['--sarif', '--repo', '--pull', '--commit', '--state', '--source-root', '--old-source-commit']);

/**
 * Decoder for SARIF files, which are UTF-8 JSON (SARIF 2.1.0 §3.1, RFC 8259
 * §8.1). `fatal` refuses bytes that are not valid UTF-8 instead of silently
 * substituting U+FFFD, which would change what is fingerprinted and
 * published. A leading UTF-8 byte-order mark is an encoding signature, not
 * JSON content, so it is removed (the decoder's default, `ignoreBOM: false`);
 * the library then sees exactly the document a caller would pass in memory.
 */
const SARIF_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(['--ignore-approval-hold']);

/** Flags every publication needs. */
const REQUIRED_FLAGS = ['--sarif', '--repo', '--pull', '--commit', '--state'];

const md = String.raw;

const USAGE = md`sarif-to-comment — publish a ready SARIF file as one GitHub draft review

Usage:
  sarif-to-comment --sarif FILE --repo OWNER/REPO --pull N --commit FULLSHA
                   --state ABSOLUTE_FILE [--source-root ABSOLUTE_FILE_URI]
                   [--old-source-commit FULLSHA] [--ignore-approval-hold]
  sarif-to-comment --help

Options:
  --sarif FILE                   SARIF 2.1.0 JSON file to publish.
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
  --help                         Show this help. Needs no token, makes no request.

Credentials:
  GH_TOKEN, or else GITHUB_TOKEN: a GitHub personal access token or user token.
  GitHub App installation tokens (including the automatic Actions token) are
  not supported. There is no token flag.

Exit status:
  0  published (or already published)
  2  blocked: nothing was published
  3  uncertain: delivery could not be confirmed; retry with the same --state
  1  usage error, unreadable SARIF file, refused request, or operational failure
`;

/** A command-line mistake the user can fix by changing the arguments. */
class UsageError extends Error {}

/** Parses argv into { help } or { values, flags } exactly; throws UsageError. */
function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
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
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) throw new UsageError(`${name} takes no value`);
      if (flags.has(name)) throw new UsageError(`${name} was given more than once`);
      flags.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown option ${name}`);
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
  const missing = REQUIRED_FLAGS.filter((flag) => !values.has(flag));
  if (missing.length > 0) throw new UsageError(`missing required option ${missing.join(', ')}`);
  return { help: false, values, flags };
}

/** Converts parsed flags into library input fields; throws UsageError. */
function interpretArgs({ values, flags }) {
  const repo = /^([^/\s]+)\/([^/\s]+)$/.exec(values.get('--repo'));
  if (!repo) throw new UsageError('--repo must be OWNER/REPO');
  const pull = values.get('--pull');
  if (!/^[1-9][0-9]*$/.test(pull) || !Number.isSafeInteger(Number(pull))) {
    throw new UsageError('--pull must be a positive pull request number');
  }
  const commitFlag = (flag) => {
    const value = values.get(flag);
    if (value !== undefined && !/^[0-9a-f]{40}$/.test(value)) {
      throw new UsageError(`${flag} must be a full 40-character lowercase commit SHA`);
    }
    return value;
  };
  const statePath = values.get('--state');
  if (!path.isAbsolute(statePath)) throw new UsageError('--state must be an absolute file path');
  const sourceRootUri = values.get('--source-root');
  if (sourceRootUri !== undefined && !(sourceRootUri.startsWith('file:') && sourceRootUri.endsWith('/'))) {
    throw new UsageError('--source-root must be an absolute file: URI ending in "/"');
  }
  const input = {
    destination: { owner: repo[1], repo: repo[2], pullNumber: Number(pull) },
    reviewedCommit: commitFlag('--commit'),
    statePath,
  };
  const oldSourceCommit = commitFlag('--old-source-commit');
  if (oldSourceCommit !== undefined) input.oldSourceCommit = oldSourceCommit;
  if (sourceRootUri !== undefined) input.sourceRootUri = sourceRootUri;
  if (flags.has('--ignore-approval-hold')) input.options = { ignoreApprovalHold: true };
  return { sarifPath: values.get('--sarif'), input };
}

/** The credential from the environment: GH_TOKEN, else GITHUB_TOKEN; empty is unset. */
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

/**
 * Runs the CLI. Returns the exit status; never throws for expected failures.
 */
async function main({ argv, env, stdout, stderr }, internals) {
  const token = tokenFrom(env);
  const safe = (text) => (token === undefined ? String(text) : String(text).split(token).join('[redacted]'));
  const fail = (message) => {
    stderr.write(`sarif-to-comment: ${safe(message)}\n`);
    return EXIT.failure;
  };

  let parsed;
  let request;
  try {
    parsed = parseArgs(argv);
    if (parsed.help) {
      stdout.write(USAGE);
      return EXIT.help;
    }
    request = interpretArgs(parsed);
  } catch (err) {
    if (err instanceof UsageError) return fail(`${err.message}\nRun sarif-to-comment --help for usage.`);
    throw err;
  }
  if (token === undefined) {
    return fail('no GitHub token: set GH_TOKEN (or GITHUB_TOKEN) to a personal access token or user token.');
  }

  let bytes;
  try {
    bytes = fs.readFileSync(request.sarifPath);
  } catch (err) {
    return fail(`cannot read SARIF file ${request.sarifPath}: ${err.message}`);
  }
  let text;
  try {
    text = SARIF_DECODER.decode(bytes);
  } catch {
    return fail(
      `SARIF file ${request.sarifPath} is not valid UTF-8; nothing was published. SARIF files must be UTF-8 encoded JSON.`,
    );
  }
  let sarif;
  try {
    sarif = JSON.parse(text);
  } catch (err) {
    return fail(`SARIF file ${request.sarifPath} is not valid JSON: ${err.message}`);
  }

  let outcome;
  try {
    outcome = await publishSarifReview({ ...request.input, sarif, token }, internals);
  } catch (err) {
    return fail(describeError(err));
  }
  const markdown = safe(outcome.markdown);
  stdout.write(markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  return EXIT[outcome.status] ?? EXIT.failure;
}

if (require.main === module) {
  main({ argv: process.argv.slice(2), env: process.env, stdout: process.stdout, stderr: process.stderr }).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`sarif-to-comment: unexpected failure: ${err && err.message}\n`);
      process.exitCode = EXIT.failure;
    },
  );
}

module.exports = { main };
