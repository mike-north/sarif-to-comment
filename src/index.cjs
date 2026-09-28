'use strict';

/**
 * Public library entry point.
 *
 * Five operations, each on ordinary in-memory SARIF 2.1.0 values (no files,
 * builders, sessions or private formats); the CLI (src/cli.cjs) is a file
 * transport over exactly these functions:
 *
 *   createSarifDocument(options?)          optional authoring: a new document
 *   addSarifComment(sarif, comment)        optional authoring: one finding
 *   inspectSarif(sarif, options?)          read-only view of any SARIF
 *   addStagedChangesToSarif(input)         staged Git changes as SARIF fixes
 *   publishSarifReview(input, internals?)  one GitHub draft review
 *
 * Authoring is optional and freestanding: SARIF from any producer can be
 * inspected, extended and published without it, and nothing downstream
 * depends on how a document was made. The first four are implemented in
 * their own modules (src/sarif-authoring.cjs, src/sarif-inspection.cjs,
 * src/staged-changes.cjs) and re-exported here unchanged; their contracts are
 * in those modules and in types/index.d.ts.
 *
 * Publication composes private cores: the GitHub client (src/github.cjs),
 * whole-review preparation (src/prepare-review.cjs) and durable initial
 * publication (src/publication.cjs). It adds no rendering, placement or
 * delivery logic of its own; it only validates, captures, sequences and
 * explains.
 *
 * ---------------------------------------------------------------------------
 * publishSarifReview(input, internals?) -> Promise<Outcome>
 *
 * input (unknown keys are refused):
 *   sarif:            plain JSON value (object) — the SARIF 2.1.0 log
 *   destination:      { owner: string, repo: string, pullNumber: number }
 *   reviewedCommit:   string  // full lowercase 40-hex commit the review is
 *                             // about; the review stays pinned to it even
 *                             // when the pull request has since advanced
 *   statePath:        string  // absolute file path; the durable identity of
 *                             // this publication. Retry with the same path;
 *                             // a new path means a deliberately separate review
 *   token:            string  // GitHub user/PAT credential; used only by the
 *                             // GitHub client; never persisted, fingerprinted,
 *                             // rendered or exposed in a rejection
 *   sourceRootUri?:   string  // absolute file: URI ending in "/", the
 *                             // repository root in the producer's filesystem
 *   oldSourceCommit?: string  // full 40-hex commit: a candidate for the diff's
 *                             // old side, used only when GitHub's own compare
 *                             // cannot establish it; still verified file by
 *                             // file against the pull request's patches
 *   options?: { ignoreApprovalHold?: boolean }  // bypasses only an approval hold
 *
 * Outcome — the consumer contract is `status` plus human-readable `markdown`
 * (and the listed identifiers). Internal reason codes, evidence and diagnostics
 * are deliberately not part of it (D13).
 *   { status: 'published', review: { id, url }, statePath, markdown }
 *   { status: 'blocked', markdown }        // nothing was written anywhere
 *   { status: 'uncertain', statePath, markdown }
 *       // delivery could not be confirmed; markdown names the preserved
 *       // state path, says to retry with the same path and not to delete it,
 *       // and that a new path would create a separate review
 *   { status: 'rejected', statePath, markdown }
 *       // GitHub definitively refused the single create; never resent
 * Rejects (promise) for invalid input (TypeError, before any remote read),
 * local state problems (corrupt state, reuse of a state path for different
 * input), and operational failures (GitHub context, network). A rejection
 * never exposes the token: an error that mentions it anywhere (message,
 * causes, extra properties) is replaced by a redacted error without cause.
 *
 * Sequence:
 *   1. Validate input and synchronously capture a deep JSON copy of `sarif`
 *      from own data properties only — caller getters never run — refusing
 *      cycles and non-JSON values rather than dropping or coercing them, so
 *      later caller mutation cannot change what is fingerprinted or rendered.
 *   2. inputFingerprint = 'sha256:' + hex SHA-256 of canonical JSON (object
 *      keys sorted recursively, no insignificant whitespace, UTF-8) of
 *        { format: 'sarif-to-comment.input', version: 1, sarif: <copy>,
 *          sourceRootUri: <string or null>, oldSourceCommit: <string or null> }
 *      Excludes the token, statePath, destination and reviewedCommit (the
 *      latter two are checked separately by publication state) and the
 *      approval-hold override (it authorizes, but does not change, content).
 *   3. recoverPublication with only that identity — before any branch or
 *      source work. A completed receipt or a known refusal returns without
 *      network; an existing sending intent is investigated with its saved
 *      request and is never re-prepared or re-sent.
 *   4. Only when no state exists: fetch the review context, verify it is for
 *      exactly this pull request and reviewed commit, prepare the whole
 *      review, and return `blocked` (no remote write, no state file) or call
 *      publishPreparedReview exactly once.
 *
 * internals (private seam, not caller API):
 *   createGitHubClient({ token, fetch }) -> client with the publication
 *     transport methods and fetchContext({ destination, reviewedCommit,
 *     oldSourceCommit? }) -> { context, readSource }. Defaults to
 *     src/github.cjs.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const util = require('node:util');

const { createGitHubClient: defaultCreateGitHubClient } = require('./github.cjs');
const { prepareReview } = require('./prepare-review.cjs');
const { publishPreparedReview, recoverPublication } = require('./publication.cjs');
const { createSarifDocument, addSarifComment } = require('./sarif-authoring.cjs');
const { inspectSarif } = require('./sarif-inspection.cjs');
const { addStagedChangesToSarif } = require('./staged-changes.cjs');

/** Identity-document format of the original input, fixed by the fingerprint spec. */
const INPUT_FORMAT = 'sarif-to-comment.input';
const INPUT_VERSION = 1;

/** Every accepted top-level input field; anything else is a caller mistake. */
const INPUT_KEYS = new Set([
  'sarif',
  'destination',
  'reviewedCommit',
  'statePath',
  'token',
  'sourceRootUri',
  'oldSourceCommit',
  'options',
]);

/** Every accepted option. Only the approval-hold override exists in this milestone. */
const OPTION_KEYS = new Set(['ignoreApprovalHold']);

/** A full, immutable, lowercase Git commit id. */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** GitHub account names: alphanumerics and single interior hyphens. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** GitHub repository names: letters, digits, '.', '_' and '-' (never '.' or '..'). */
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Nesting bound for captured JSON, so hostile depth fails as input, not a stack overflow. */
const MAX_JSON_DEPTH = 512;

/** Replacement text for a credential found in anything shown to a person. */
const REDACTED = '[redacted]';

// ---------------------------------------------------------------------------
// Input validation and capture (synchronous, before any remote read)
// ---------------------------------------------------------------------------

function invalid(message) {
  return new TypeError(`Invalid publishSarifReview input: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** An own data property's value, refusing accessors (whose getters are never run). */
function dataValue(object, key, where) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw invalid(`${where} is an accessor property; only plain JSON data is accepted`);
  return descriptor.value;
}

/**
 * A deep copy of `value` restricted to what JSON represents faithfully:
 * plain objects with enumerable string-keyed data properties, dense arrays,
 * strings, finite numbers (not -0), booleans and null. Anything else — cycles,
 * accessors, symbols, undefined, functions, BigInt, class instances, holes —
 * is refused rather than dropped or coerced, so the fingerprint and the
 * rendered review can only ever describe the same document.
 */
function captureJson(value, where, ancestors = new Set(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw invalid(`${where} is not a finite JSON number`);
    return value;
  }
  if (typeof value !== 'object') throw invalid(`${where} is a ${typeof value}, which JSON cannot represent`);
  if (depth > MAX_JSON_DEPTH) throw invalid(`${where} is nested more than ${MAX_JSON_DEPTH} levels deep`);
  if (ancestors.has(value)) throw invalid(`${where} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw invalid(`${where} is not a plain array`);
      const keys = Reflect.ownKeys(value);
      const length = dataValue(value, 'length', `${where}.length`);
      if (keys.length !== length + 1) throw invalid(`${where} has holes or extra properties`);
      const copy = new Array(length);
      for (let i = 0; i < length; i += 1) {
        if (!Object.hasOwn(value, i)) throw invalid(`${where}[${i}] is a hole`);
        copy[i] = captureJson(dataValue(value, String(i), `${where}[${i}]`), `${where}[${i}]`, ancestors, depth + 1);
      }
      return copy;
    }
    if (!isPlainObject(value)) throw invalid(`${where} is not a plain JSON object`);
    const copy = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') throw invalid(`${where} has a symbol-keyed property`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable) throw invalid(`${where}.${key} is not enumerable`);
      const item = captureJson(dataValue(value, key, `${where}.${key}`), `${where}.${key}`, ancestors, depth + 1);
      Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function isCommit(value) {
  return typeof value === 'string' && COMMIT_PATTERN.test(value);
}

/** Whether `value` is an absolute file: URI naming a directory (ending in "/"). */
function isFileRootUri(value) {
  if (typeof value !== 'string' || !value.startsWith('file:') || !value.endsWith('/')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'file:' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

/**
 * Validates `input` and returns an independent snapshot of everything the
 * operation will use. Runs synchronously, before the first await.
 */
function captureInput(input) {
  if (!isPlainObject(input)) throw invalid('input must be a plain object');
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === 'symbol' || !INPUT_KEYS.has(key)) throw invalid(`unknown field ${String(key)}`);
  }
  const field = (key) => dataValue(input, key, key);

  const sarifValue = field('sarif');
  if (!isPlainObject(sarifValue)) throw invalid('sarif must be a parsed SARIF object (not text or an array)');
  const sarif = captureJson(sarifValue, 'sarif');

  const destinationValue = field('destination');
  if (!isPlainObject(destinationValue)) throw invalid('destination must be { owner, repo, pullNumber }');
  const destination = captureJson(destinationValue, 'destination');
  const destinationKeys = Object.keys(destination).sort().join(',');
  if (destinationKeys !== 'owner,pullNumber,repo') throw invalid('destination must have exactly owner, repo and pullNumber');
  if (typeof destination.owner !== 'string' || !OWNER_PATTERN.test(destination.owner)) {
    throw invalid('destination.owner must be a GitHub account name');
  }
  if (typeof destination.repo !== 'string' || !REPO_PATTERN.test(destination.repo) || /^\.\.?$/.test(destination.repo)) {
    throw invalid('destination.repo must be a GitHub repository name');
  }
  if (!Number.isSafeInteger(destination.pullNumber) || destination.pullNumber < 1) {
    throw invalid('destination.pullNumber must be a positive integer');
  }

  const reviewedCommit = field('reviewedCommit');
  if (!isCommit(reviewedCommit)) throw invalid('reviewedCommit must be a full 40-character lowercase commit SHA');

  const oldSourceCommit = field('oldSourceCommit');
  if (oldSourceCommit !== undefined && !isCommit(oldSourceCommit)) {
    throw invalid('oldSourceCommit must be a full 40-character lowercase commit SHA');
  }

  const statePath = field('statePath');
  if (typeof statePath !== 'string' || !path.isAbsolute(statePath)) {
    throw invalid('statePath must be an absolute file path chosen by the caller');
  }

  const token = field('token');
  if (typeof token !== 'string' || token.length === 0) throw invalid('token must be a non-empty string');

  const sourceRootUri = field('sourceRootUri');
  if (sourceRootUri !== undefined && !isFileRootUri(sourceRootUri)) {
    throw invalid('sourceRootUri must be an absolute file: URI ending in "/"');
  }

  const optionsValue = field('options');
  let ignoreApprovalHold;
  if (optionsValue !== undefined) {
    if (!isPlainObject(optionsValue)) throw invalid('options must be a plain object');
    const options = captureJson(optionsValue, 'options');
    for (const key of Object.keys(options)) if (!OPTION_KEYS.has(key)) throw invalid(`unknown option ${key}`);
    if (options.ignoreApprovalHold !== undefined && typeof options.ignoreApprovalHold !== 'boolean') {
      throw invalid('options.ignoreApprovalHold must be a boolean');
    }
    ignoreApprovalHold = options.ignoreApprovalHold;
  }

  return { sarif, destination, reviewedCommit, oldSourceCommit, statePath, token, sourceRootUri, ignoreApprovalHold };
}

// ---------------------------------------------------------------------------
// Original-input identity
// ---------------------------------------------------------------------------

/** JSON with recursively sorted object keys and no insignificant whitespace. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Fingerprint of everything that determines the prepared content (see module doc). */
function inputFingerprintOf(captured) {
  const identity = {
    format: INPUT_FORMAT,
    version: INPUT_VERSION,
    sarif: captured.sarif,
    sourceRootUri: captured.sourceRootUri ?? null,
    oldSourceCommit: captured.oldSourceCommit ?? null,
  };
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Credential safety
// ---------------------------------------------------------------------------

/** `text` with every occurrence of the credential replaced. */
function redact(text, token) {
  return String(text).split(token).join(REDACTED);
}

/** The message of `err` followed by its cause chain, as plain text. */
function messageChain(err) {
  const parts = [];
  const seen = new Set();
  for (let current = err; current !== undefined && current !== null && !seen.has(current); current = current.cause) {
    seen.add(current);
    parts.push(current instanceof Error ? current.message : String(current));
    if (!(current instanceof Error)) break;
  }
  return parts.join(' (caused by: ') + ')'.repeat(parts.length - 1);
}

/**
 * `err` unchanged when nothing inspectable about it mentions the token;
 * otherwise a new error of the same name carrying only the redacted message
 * chain and no cause or extra properties.
 */
function withoutCredential(err, token) {
  const inspected = util.inspect(err, { depth: null, showHidden: true });
  if (!inspected.includes(token)) return err;
  const safe = new Error(redact(messageChain(err), token));
  safe.name = err instanceof Error ? err.name : 'Error';
  return safe;
}

// ---------------------------------------------------------------------------
// Context verification
// ---------------------------------------------------------------------------

/**
 * Refuses a context that is not for exactly the requested pull request and
 * reviewed commit. The review is never retargeted to another pull request or
 * to the pull request's current head.
 */
function verifyContext(context, captured) {
  const { owner, repo, pullNumber } = captured.destination;
  const wanted = `${owner}/${repo}#${pullNumber}`;
  if (!isPlainObject(context)) throw new Error(`GitHub returned no usable review context for ${wanted}.`);
  const sameName = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  if (!sameName(context.owner, owner) || !sameName(context.repo, repo) || context.pullNumber !== pullNumber) {
    throw new Error(
      `GitHub returned review context for pull request ${context.owner}/${context.repo}#${context.pullNumber}, not the requested pull request ${wanted}.`,
    );
  }
  if (context.reviewedCommit !== captured.reviewedCommit) {
    throw new Error(
      `GitHub returned review context for reviewed commit ${context.reviewedCommit}, not the requested reviewed commit ${captured.reviewedCommit}. A review is never retargeted to another commit.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Markdown presentation
// ---------------------------------------------------------------------------

function code(text) {
  return `\`${String(text).replace(/`/g, "'")}\``;
}

function destinationLabel(captured) {
  const { owner, repo, pullNumber } = captured.destination;
  return `${owner}/${repo}#${pullNumber}`;
}

function publishedMarkdown(result, captured, prepared) {
  const link = `[review ${result.review.id}](${result.review.htmlUrl})`;
  const where = `${destinationLabel(captured)} at commit ${code(captured.reviewedCommit)}`;
  const lines = ['## Draft review published', ''];
  if (result.via === 'receipt') {
    lines.push(`The draft ${link} on ${where} was already published; its completion is recorded at ${code(captured.statePath)}. Nothing was sent.`);
  } else if (result.via === 'recovered') {
    lines.push(`The draft ${link} on ${where} was confirmed on GitHub for this publication; nothing was resent.`);
  } else {
    lines.push(`Created the draft ${link} on ${where}. It stays a draft until someone submits it on GitHub.`);
  }
  if (!result.receiptPersisted) {
    lines.push(
      '',
      `Completion could not be recorded at ${code(captured.statePath)}. Keep that file: a later run with the same state path confirms the review without sending it again.`,
    );
  }
  if (prepared && prepared.warnings.length > 0 && prepared.markdown) lines.push('', prepared.markdown.trim());
  return lines.join('\n');
}

function uncertainMarkdown(result, captured) {
  return [
    '## Delivery could not be confirmed',
    '',
    result.detail,
    '',
    `The publication state is preserved at ${code(captured.statePath)}.`,
    '',
    '- Retry later with the same state path: it only checks GitHub for this review and never sends it again.',
    '- Do not delete that file: it is the only record that this review may already exist.',
    '- A new state path starts a new, separate review; use one only if you intend a separate review.',
  ].join('\n');
}

function rejectedMarkdown(result, captured) {
  const lines = [
    '## GitHub refused the review',
    '',
    result.detail,
    '',
    `The request is never resent. The refusal is tied to the state path ${code(captured.statePath)}.`,
  ];
  if (/one pending review/i.test(result.detail)) {
    lines.push(
      '',
      'This account already has a pending draft review on this pull request, and GitHub allows only one. This tool never submits, edits or deletes it: submit or delete that draft on GitHub yourself.',
    );
  }
  lines.push('', 'After resolving the cause, publish again with a new state path.');
  return lines.join('\n');
}

function blockedMarkdown(prepared) {
  return ['## Review blocked', '', 'Nothing was published and no publication state was written.', '', prepared.markdown.trim()].join(
    '\n',
  );
}

/** The public outcome for a publication-core result. */
function present(result, captured, prepared) {
  const { statePath } = captured;
  switch (result.status) {
    case 'published':
      return {
        status: 'published',
        review: { id: result.review.id, url: result.review.htmlUrl },
        statePath,
        markdown: publishedMarkdown(result, captured, prepared),
      };
    case 'uncertain':
      return { status: 'uncertain', statePath, markdown: uncertainMarkdown(result, captured) };
    case 'rejected':
      return { status: 'rejected', statePath, markdown: rejectedMarkdown(result, captured) };
    default:
      throw new Error(`Unexpected publication status ${result.status}.`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run(captured, createGitHubClient) {
  const client = createGitHubClient({ token: captured.token, fetch: globalThis.fetch });
  const identity = {
    destination: captured.destination,
    reviewedCommit: captured.reviewedCommit,
    inputFingerprint: inputFingerprintOf(captured),
    statePath: captured.statePath,
    transport: client,
  };

  const existing = await recoverPublication(identity);
  if (existing.status !== 'missing') return present(existing, captured);

  const contextRequest = { destination: captured.destination, reviewedCommit: captured.reviewedCommit };
  if (captured.oldSourceCommit !== undefined) contextRequest.oldSourceCommit = captured.oldSourceCommit;
  const { context, readSource } = await client.fetchContext(contextRequest);
  verifyContext(context, captured);

  const prepareInput = {
    sarif: captured.sarif,
    context: captured.sourceRootUri === undefined ? context : { ...context, sourceRootUri: captured.sourceRootUri },
    readSource,
  };
  if (captured.ignoreApprovalHold !== undefined) prepareInput.options = { ignoreApprovalHold: captured.ignoreApprovalHold };
  const prepared = await prepareReview(prepareInput);
  if (prepared.status === 'blocked') return { status: 'blocked', markdown: blockedMarkdown(prepared) };
  if (prepared.status !== 'ready' || prepared.review.commitId !== captured.reviewedCommit) {
    throw new Error('Review preparation returned an unexpected outcome; nothing was published.');
  }

  const result = await publishPreparedReview({
    ...identity,
    preparedReview: { body: prepared.review.body, comments: prepared.review.comments },
  });
  return present(result, captured, prepared);
}

/**
 * Publishes a ready SARIF document as one GitHub draft review, or reports why
 * it is blocked, uncertain or refused. See the module documentation.
 *
 * @param {object} input see module documentation
 * @param {object} [internals] private seam: { createGitHubClient }
 * @returns {Promise<object>} the public outcome
 */
async function publishSarifReview(input, internals = {}) {
  const captured = captureInput(input);
  const createGitHubClient = internals.createGitHubClient || defaultCreateGitHubClient;
  let outcome;
  try {
    outcome = await run(captured, createGitHubClient);
  } catch (err) {
    throw withoutCredential(err, captured.token);
  }
  return { ...outcome, markdown: redact(outcome.markdown, captured.token) };
}

module.exports = { createSarifDocument, addSarifComment, inspectSarif, addStagedChangesToSarif, publishSarifReview };
