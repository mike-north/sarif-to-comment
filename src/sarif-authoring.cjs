'use strict';

/**
 * Optional, freestanding SARIF authoring (private internal module).
 *
 * Lets a caller with no upstream SARIF producer create an ordinary SARIF
 * 2.1.0 document and append feedback on repository lines or line ranges
 * (D31, D32). Contract: docs/second-milestone-contract-proposal.md §3.1-§3.2.
 *
 * Invariants:
 * - Ordinary SARIF in and out. There is no builder, session, marker,
 *   authoring history or private format. Any schema-valid SARIF, authored or
 *   upstream, can be extended, and authored documents need nothing from this
 *   module downstream.
 * - Inputs are never mutated. addSarifComment captures the caller's document
 *   (no getters, no cycles, no non-JSON values) and returns a fresh document
 *   that shares no objects with it. Every existing run, finding, attribution
 *   and metadata value is kept exactly; the only change is the appended
 *   result, plus an appended run when one is requested.
 * - No invented content. Only what the caller supplied is written: message,
 *   location, rule and level. The attributed tool is the caller's or, by
 *   default, this package at its runtime version.
 * - Pure: no source, Git, GitHub, credential or file access. Line validity
 *   against real source is checked later, by extraction and publication.
 *
 * Caller mistakes (malformed options, an ambiguous or invalid run selection,
 * non-JSON input) throw TypeError. A document that is not schema-valid SARIF,
 * or that has no run to add to, is the contract's `invalid` outcome.
 */

const {
  COMMIT_PATTERN, OWNER_PATTERN, REPO_PATTERN, captureJson, validateSarif, isPlainObject,
  isNormalizedRepositoryPath, encodeRepositoryPath, packageVersion,
} = require('./sarif-common.cjs');

/** The schema identifier written into every created document. */
const SCHEMA_URI = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';

/** Tool name used when the caller names no author (D5 attribution to this tool). */
const DEFAULT_TOOL_NAME = 'sarif-to-comment';

/**
 * Column unit declared on every run this module creates. Later column-bearing
 * edits, such as staged-change fixes, are then unambiguous.
 */
const COLUMN_KIND = 'utf16CodeUnits';

/** Result levels a caller may state (SARIF 3.27.10); omitted unless given. */
const LEVELS = new Set(['none', 'note', 'warning', 'error']);

function misuse(operation, message) {
  return new TypeError(`Invalid ${operation} input: ${message}`);
}

/** Refuses keys outside `allowed`, so misspelled options never pass silently. */
function refuseUnknownKeys(value, allowed, where, operation) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw misuse(operation, `${where} has unknown key ${JSON.stringify(key)}`);
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * Validates an optional `{ owner, repo, commit }` source binding. All three
 * are required together: the schema needs a repositoryUri for any revision.
 */
function checkSource(source, where, operation) {
  if (!isPlainObject(source)) throw misuse(operation, `${where} must be an object with owner, repo and commit`);
  refuseUnknownKeys(source, ['owner', 'repo', 'commit'], where, operation);
  if (typeof source.owner !== 'string' || !OWNER_PATTERN.test(source.owner)) throw misuse(operation, `${where}.owner must be a GitHub account name`);
  if (typeof source.repo !== 'string' || !REPO_PATTERN.test(source.repo) || source.repo === '.' || source.repo === '..') {
    throw misuse(operation, `${where}.repo must be a GitHub repository name`);
  }
  if (typeof source.commit !== 'string' || !COMMIT_PATTERN.test(source.commit)) {
    throw misuse(operation, `${where}.commit must be a full 40-character lowercase commit`);
  }
}

/**
 * A new empty run for a known author, with an optional binding. Its key order
 * is exactly the contract's document shape. With no caller-named tool, this
 * package at its runtime version is the author. With a named tool, only a
 * supplied version is written: this package's version is never attributed to
 * another author.
 */
function newRun({ name, version }, source) {
  const driver = version === undefined ? { name } : { name, version };
  const run = { tool: { driver }, columnKind: COLUMN_KIND };
  if (source) {
    run.versionControlProvenance = [{ repositoryUri: `https://github.com/${source.owner}/${source.repo}`, revisionId: source.commit }];
  }
  run.results = [];
  return run;
}

/**
 * Creates an ordinary SARIF document with one empty run (contract §3.1).
 *
 * @param {{ tool?: { name: string, version?: string },
 *           source?: { owner: string, repo: string, commit: string } }} [options]
 * @returns {object} a fresh, schema-valid SARIF log
 * @throws {TypeError} on malformed options
 */
function createSarifDocument(options) {
  const operation = 'createSarifDocument';
  const given = options === undefined ? {} : captureJson(options, 'options');
  if (!isPlainObject(given)) throw misuse(operation, 'options must be an object');
  refuseUnknownKeys(given, ['tool', 'source'], 'options', operation);
  let tool = { name: DEFAULT_TOOL_NAME, version: packageVersion() };
  if (given.tool !== undefined) {
    if (!isPlainObject(given.tool)) throw misuse(operation, 'options.tool must be an object with a name');
    refuseUnknownKeys(given.tool, ['name', 'version'], 'options.tool', operation);
    if (!nonEmptyString(given.tool.name)) throw misuse(operation, 'options.tool.name must be a non-empty string');
    if (given.tool.version !== undefined && !nonEmptyString(given.tool.version)) {
      throw misuse(operation, 'options.tool.version must be a non-empty string when given');
    }
    tool = { name: given.tool.name, version: given.tool.version };
  }
  if (given.source !== undefined) checkSource(given.source, 'options.source', operation);
  return { $schema: SCHEMA_URI, version: '2.1.0', runs: [newRun(tool, given.source)] };
}

/** Validates a comment and returns its captured copy (see addSarifComment). */
function checkComment(comment, operation) {
  const captured = captureJson(comment, 'comment');
  if (!isPlainObject(captured)) throw misuse(operation, 'comment must be an object');
  refuseUnknownKeys(captured, ['file', 'line', 'endLine', 'message', 'messageFormat', 'ruleId', 'level', 'run'], 'comment', operation);
  if (!isNormalizedRepositoryPath(captured.file)) {
    throw misuse(operation, 'comment.file must be a repository-relative path with "/" separators and no ".", ".." or empty segment');
  }
  if (!Number.isInteger(captured.line) || captured.line < 1) throw misuse(operation, 'comment.line must be a positive whole line number');
  if (captured.endLine !== undefined && (!Number.isInteger(captured.endLine) || captured.endLine < captured.line)) {
    throw misuse(operation, 'comment.endLine must be a whole line number no smaller than comment.line');
  }
  if (!nonEmptyString(captured.message)) throw misuse(operation, 'comment.message must be a non-empty string');
  if (captured.messageFormat !== undefined && captured.messageFormat !== 'text' && captured.messageFormat !== 'markdown') {
    throw misuse(operation, 'comment.messageFormat must be "text" or "markdown"');
  }
  if (captured.ruleId !== undefined && !nonEmptyString(captured.ruleId)) throw misuse(operation, 'comment.ruleId must be a non-empty string');
  if (captured.level !== undefined && !LEVELS.has(captured.level)) throw misuse(operation, 'comment.level must be none, note, warning or error');
  const { run } = captured;
  if (run !== undefined && !(Number.isInteger(run) && run >= 0)) {
    if (!isPlainObject(run)) throw misuse(operation, 'comment.run must be a run index or { toolName, toolVersion?, source? }');
    refuseUnknownKeys(run, ['toolName', 'toolVersion', 'source'], 'comment.run', operation);
    if (!nonEmptyString(run.toolName)) throw misuse(operation, 'comment.run.toolName must be a non-empty string');
    if (run.toolVersion !== undefined && !nonEmptyString(run.toolVersion)) throw misuse(operation, 'comment.run.toolVersion must be a non-empty string');
    if (run.source !== undefined) checkSource(run.source, 'comment.run.source', operation);
  }
  return captured;
}

/**
 * The SARIF result a comment denotes (contract §3.2). Fields appear in the
 * contract's order: ruleId, level, message, locations. A text comment's
 * message is `{ text }`. A Markdown comment's message is `{ text, markdown }`,
 * both holding the caller's text, because the schema requires `text`. The
 * region states endLine only when the caller gave one.
 */
function resultFor(comment) {
  const result = {};
  if (comment.ruleId !== undefined) result.ruleId = comment.ruleId;
  if (comment.level !== undefined) result.level = comment.level;
  result.message = comment.messageFormat === 'markdown'
    ? { text: comment.message, markdown: comment.message }
    : { text: comment.message };
  const region = comment.endLine === undefined ? { startLine: comment.line } : { startLine: comment.line, endLine: comment.endLine };
  result.locations = [{ physicalLocation: { artifactLocation: { uri: encodeRepositoryPath(comment.file) }, region } }];
  return result;
}

/**
 * Appends one line or line-range finding to a copy of `sarif` (contract §3.2).
 *
 * Run selection, for D5 attribution:
 * - `run` omitted: the only run. No runs gives `invalid`; several runs is a
 *   TypeError asking the caller to choose.
 * - `run: n`: run n. Out of range is a TypeError.
 * - `run: { toolName, toolVersion?, source? }`: a new run with that identity
 *   and optional binding, appended so an upstream tool is never credited with
 *   the caller's feedback.
 *
 * `finding.ref` is the JSON Pointer of the new result in the returned
 * document. It is not a persistent identifier.
 *
 * @returns {{ status: 'added', sarif: object, finding: { ref, runIndex, resultIndex, tool } }
 *         | { status: 'invalid', problems: object[], markdown: string }}
 * @throws {TypeError} on caller misuse
 */
function addSarifComment(sarif, comment) {
  const operation = 'addSarifComment';
  if (sarif === null || typeof sarif !== 'object' || Array.isArray(sarif)) {
    throw misuse(operation, 'sarif must be a parsed SARIF object, not serialized text');
  }
  const captured = captureJson(sarif, 'sarif');
  const checked = checkComment(comment, operation);
  const invalid = validateSarif(captured);
  if (invalid) return invalid;

  const { runs } = captured;
  let runIndex;
  if (isPlainObject(checked.run)) {
    runs.push(newRun({ name: checked.run.toolName, version: checked.run.toolVersion }, checked.run.source));
    runIndex = runs.length - 1;
  } else if (checked.run !== undefined) {
    if (checked.run >= runs.length) throw misuse(operation, `comment.run ${checked.run} is out of range; the document has ${runs.length} run(s)`);
    runIndex = checked.run;
  } else if (runs.length === 0) {
    const message = 'The document has no run to add the comment to. Pass `run: { toolName }` to add one under your own attribution.';
    return { status: 'invalid', problems: [{ message, pointer: '/runs' }], markdown: `**Cannot add the comment:** ${message}` };
  } else if (runs.length > 1) {
    throw misuse(operation, `the document has ${runs.length} runs; choose one with comment.run (an index or { toolName } for a new run)`);
  } else {
    runIndex = 0;
  }

  const run = runs[runIndex];
  if (!Array.isArray(run.results)) run.results = [];
  run.results.push(resultFor(checked));
  const resultIndex = run.results.length - 1;
  return {
    status: 'added',
    sarif: captured,
    finding: { ref: `/runs/${runIndex}/results/${resultIndex}`, runIndex, resultIndex, tool: run.tool.driver.name },
  };
}

module.exports = { createSarifDocument, addSarifComment };
