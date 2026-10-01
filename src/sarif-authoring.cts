/**
 * Optional, freestanding SARIF authoring (private internal module).
 *
 * Lets a caller with no upstream SARIF producer create an ordinary SARIF
 * 2.1.0 document, append feedback on repository lines or line ranges, and
 * correct it by removing a finding selected through inspection (D30-D32).
 * Contracts: docs/second-milestone-contract-proposal.md §3.1-§3.2 and
 * docs/finding-removal-contract.md.
 *
 * Invariants:
 * - Ordinary SARIF in and out. There is no builder, session, marker,
 *   authoring history or private format. Any schema-valid SARIF, authored or
 *   upstream, can be extended, and authored documents need nothing from this
 *   module downstream.
 * - Inputs are never mutated. addSarifComment and removeSarifComment capture
 *   the caller's document (no getters, no cycles, no non-JSON values) and
 *   return a fresh document that shares no objects with it. Every other run,
 *   finding, attribution and metadata value is kept exactly; the only change
 *   is the appended result (plus an appended run when one is requested) or
 *   the one removed result.
 * - Removal is selected, never guessed. A selector from inspection names a
 *   finding in the document exactly as inspected; any later change makes it
 *   stale, and a stale selector removes nothing. The whole result goes, with
 *   the fixes and file proposals it carries, and nothing else: fixes are
 *   never relocated, and identical fixes elsewhere, run artifacts and
 *   properties stay.
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


import { documentDigest, parseFindingSelector } from './finding-selectors.cjs';
import { repositoryUrl } from './github-urls.cjs';
import {
  COMMIT_PATTERN, OWNER_PATTERN, REPO_PATTERN, captureJson, validateSarif, isPlainObject,
  isNormalizedRepositoryPath, encodeRepositoryPath, packageVersion,
} from './sarif-common.cjs';
import { createProblem, diagnosticOf } from './diagnostics.cjs';
import type { IDiagnostic, IInvalidSarifOutcome, IProblem, ISarifLog, ISarifSourceBinding } from './public-types.cjs';

// ---------------------------------------------------------------------------
// Public types
//
// These are the shapes the package documents for authoring. Their names and
// documentation are the public ones, so declarations generated from this
// module read exactly as the published API. The shapes several operations
// share (the SARIF log, the invalid outcome, the source binding) are declared
// once in public-types.cts.

/**
 * The author of findings, recorded as a run's tool.
 *
 * @public
 */
export interface ISarifToolIdentity {
  /** Who the findings come from, for example `"Review agent"`. */
  readonly name: string;
  /** That tool's version, when it has one. */
  readonly version?: string | undefined;
}

/**
 * Options for {@link createSarifDocument}. Unknown fields are refused.
 *
 * @public
 */
export interface ICreateSarifDocumentOptions {
  /**
   * The author of the findings you will add. Defaults to this package at its
   * installed version. A named tool gets only the version you give; this
   * package's version is never attributed to another author.
   */
  readonly tool?: ISarifToolIdentity | undefined;
  /**
   * Bind the run to a repository and reviewed commit. Without it the run is
   * unbound: its lines are read at whatever reviewed commit a later
   * operation is given.
   */
  readonly source?: ISarifSourceBinding | undefined;
}

/**
 * Adds the finding to a new run with its own tool identity, so that feedback
 * added to another producer's SARIF is never attributed to that producer.
 *
 * @public
 */
export interface INewSarifRun {
  /** The new run's tool name. */
  readonly toolName: string;
  /** The new run's tool version. */
  readonly toolVersion?: string | undefined;
  /** Bind the new run to a repository and reviewed commit. */
  readonly source?: ISarifSourceBinding | undefined;
}

/**
 * One finding for {@link addSarifComment}. Unknown fields are refused.
 *
 * @public
 */
export interface ISarifComment {
  /**
   * Repository-relative path with `/` separators and no leading `/`, `.`,
   * `..` or empty segment, for example `src/parse.js`.
   */
  readonly file: string;
  /**
   * First line, one-based. Lines refer to the reviewed revision of the file,
   * or to the proposed content of a file the reviewed revision does not have.
   */
  readonly line: number;
  /** Last line, inclusive and not smaller than `line`. Omitted means one line. */
  readonly endLine?: number | undefined;
  /** The finding's full text, exactly as it should appear. */
  readonly message: string;
  /** Whether `message` is plain text (default) or Markdown. */
  readonly messageFormat?: 'text' | 'markdown' | undefined;
  /** A rule identifier to record. */
  readonly ruleId?: string | undefined;
  /** A SARIF level to record; omitted unless given. */
  readonly level?: 'none' | 'note' | 'warning' | 'error' | undefined;
  /**
   * Which run receives the finding: an existing run's index, or a new run.
   * Omitted means the only run; a document with several runs needs a choice.
   */
  readonly run?: number | INewSarifRun | undefined;
}

/**
 * Where a finding was added.
 *
 * @public
 */
export interface IAddedFinding {
  /**
   * JSON Pointer to the new result, such as `/runs/0/results/3`. It locates
   * the finding in the returned document only; it is not a persistent
   * identifier.
   */
  readonly ref: string;
  /** Index of the run that received the finding. */
  readonly runIndex: number;
  /** Index of the new result in that run. */
  readonly resultIndex: number;
  /** The receiving run's tool name. */
  readonly tool: string;
}

/**
 * The finding was added to a new copy of the document.
 *
 * @public
 */
export interface IAddedSarifCommentOutcome {
  /** Discriminant: the finding was added. */
  readonly status: 'added';
  /** The new document. Your input is unchanged; use this value from now on. */
  readonly sarif: ISarifLog;
  /** Where the finding is in `sarif`. */
  readonly finding: IAddedFinding;
  /** Always empty: adding a finding raises no warnings or notes. */
  readonly diagnostics: readonly IDiagnostic[];
}

/**
 * Every outcome of {@link addSarifComment}, discriminated by `status`.
 *
 * @public
 */
export type AddSarifCommentOutcome = IAddedSarifCommentOutcome | IInvalidSarifOutcome;

/**
 * The finding {@link removeSarifComment} removed.
 *
 * @public
 */
export interface IRemovedFinding {
  /** JSON Pointer the finding had in the input, such as `/runs/0/results/3`. */
  readonly ref: string;
  /** Index of its run. */
  readonly runIndex: number;
  /** Index it had in that run; findings after it have moved up by one. */
  readonly resultIndex: number;
  /** The run's tool name. */
  readonly tool: string;
  /** How many fixes were removed with it. */
  readonly fixes: number;
  /** How many proposed whole-file operations were removed with it. */
  readonly fileProposals: number;
}

/**
 * The finding and its attached fixes were removed from a new copy of the
 * document.
 *
 * @public
 */
export interface IRemovedSarifCommentOutcome {
  /** Discriminant: the finding was removed. */
  readonly status: 'removed';
  /** The new document. Your input is unchanged; use this value from now on. */
  readonly sarif: ISarifLog;
  /** What was removed. */
  readonly finding: IRemovedFinding;
  /** Always empty: removing a finding raises no warnings or notes. */
  readonly diagnostics: readonly IDiagnostic[];
}

/**
 * A selector does not select a finding in this document as it is now,
 * usually because the document changed after it was inspected. Nothing was
 * changed: {@link removeSarifComment} removed nothing, and
 * {@link groupSarifFixes} and {@link ungroupSarifFixes} grouped or ungrouped
 * nothing.
 *
 * @public
 */
export interface IStaleSarifSelectorOutcome {
  /** Discriminant: the selector was refused. */
  readonly status: 'stale';
  /** The selector, as given (the first that does not fit, when several were given). */
  readonly selector: string;
  /** Why, with the position the selector names as its pointer. */
  readonly problems: readonly IProblem[];
  /** The same explanation as Markdown. */
  readonly markdown: string;
  /** The same problem as a `finding-selector-stale` diagnostic. */
  readonly diagnostics: readonly IDiagnostic[];
}

/**
 * Every outcome of {@link removeSarifComment}, discriminated by `status`.
 *
 * @public
 */
export type RemoveSarifCommentOutcome = IRemovedSarifCommentOutcome | IStaleSarifSelectorOutcome | IInvalidSarifOutcome;

// ---------------------------------------------------------------------------
// Internal types

/** The public operation a misuse message names. */
type Operation = 'createSarifDocument' | 'addSarifComment' | 'removeSarifComment';

/** A run's tool driver as this module writes it: the version only when one is known. */
interface IAuthoredDriver {
  readonly name: string;
  readonly version?: string;
}

/** The provenance entry written for a source binding (SARIF versionControlDetails, 3.23). */
interface IAuthoredProvenance {
  readonly repositoryUri: string;
  readonly revisionId: string;
}

/**
 * A run this module creates, in the contract's key order: tool, columnKind,
 * the optional provenance, then results. It is a fresh value, so appending
 * results to it is safe.
 */
interface IAuthoredRun {
  readonly tool: { readonly driver: IAuthoredDriver };
  readonly columnKind: typeof COLUMN_KIND;
  readonly versionControlProvenance?: readonly IAuthoredProvenance[];
  results: object[];
}

/** A result this module writes (contract §3.2), in the contract's key order. */
interface IAuthoredResult {
  readonly ruleId?: string;
  readonly level?: 'none' | 'note' | 'warning' | 'error';
  readonly message: { readonly text: string; readonly markdown?: string };
  readonly locations: readonly [{
    readonly physicalLocation: {
      readonly artifactLocation: { readonly uri: string };
      readonly region: { readonly startLine: number; readonly endLine?: number };
    };
  }];
}

/**
 * A run of a captured, schema-valid log, as far as addSarifComment reads and
 * extends it. The schema requires every run's `tool.driver.name`, and a
 * run's `results`, when present, is an array of result objects.
 */
interface IExtensibleSarifRun {
  readonly tool: { readonly driver: { readonly name: string } };
  results?: object[];
}

/**
 * A captured, schema-valid SARIF log. The capture is a fresh copy that
 * shares nothing with the caller's value, so addSarifComment extends it in
 * place and returns it.
 */
interface IExtensibleSarifLog extends ISarifLog {
  runs: IExtensibleSarifRun[];
}

// ---------------------------------------------------------------------------
// Implementation

/** The schema identifier written into every created document. */
const SCHEMA_URI = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';

/** Tool name used when the caller names no author (D5 attribution to this tool). */
const DEFAULT_TOOL_NAME = 'sarif-to-comment';

/**
 * Column unit declared on every run this module creates. Later column-bearing
 * edits, such as staged-change fixes, are then unambiguous.
 */
const COLUMN_KIND = 'utf16CodeUnits';

/**
 * Result levels a caller may state (SARIF 3.27.10); omitted unless given.
 * Typed over `unknown` because membership is tested on unvalidated input.
 */
const LEVELS: ReadonlySet<unknown> = new Set(['none', 'note', 'warning', 'error']);

function misuse(operation: Operation, message: string): TypeError {
  return new TypeError(`Invalid ${operation} input: ${message}`);
}

/** Refuses keys outside `allowed`, so misspelled options never pass silently. */
function refuseUnknownKeys(value: object, allowed: readonly string[], where: string, operation: Operation): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw misuse(operation, `${where} has unknown key ${JSON.stringify(key)}`);
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * Validates an optional `{ owner, repo, commit }` source binding. All three
 * are required together: the schema needs a repositoryUri for any revision.
 */
function checkSource(source: unknown, where: string, operation: Operation): asserts source is ISarifSourceBinding {
  if (!isPlainObject(source)) throw misuse(operation, `${where} must be an object with owner, repo and commit`);
  refuseUnknownKeys(source, ['owner', 'repo', 'commit'], where, operation);
  const { owner, repo, commit } = source;
  if (typeof owner !== 'string' || !OWNER_PATTERN.test(owner)) throw misuse(operation, `${where}.owner must be a GitHub account name`);
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo) || repo === '.' || repo === '..') {
    throw misuse(operation, `${where}.repo must be a GitHub repository name`);
  }
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
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
function newRun({ name, version }: ISarifToolIdentity, source: ISarifSourceBinding | undefined): IAuthoredRun {
  const driver: IAuthoredDriver = version === undefined ? { name } : { name, version };
  return {
    tool: { driver },
    columnKind: COLUMN_KIND,
    ...(source ? { versionControlProvenance: [{ repositoryUri: repositoryUrl(source), revisionId: source.commit }] } : {}),
    results: [],
  };
}

/**
 * Creates a SARIF document with one empty run, ready for
 * {@link addSarifComment}.
 *
 * @remarks
 * The result is ordinary SARIF: it has the schema URI, version `2.1.0` and
 * one run with the tool, `columnKind: "utf16CodeUnits"`, the optional
 * binding and no results. It carries no authoring marker, and nothing else in
 * the package requires a document to have been created this way.
 *
 * @param options - The findings' author and an optional source binding.
 * @returns A new SARIF log.
 * @throws `TypeError` for malformed options.
 *
 * @example
 * ```ts
 * import { createSarifDocument } from 'sarif-to-comment';
 *
 * let sarif = createSarifDocument({ tool: { name: 'Review agent' } });
 * ```
 *
 * @public
 */
export function createSarifDocument(options?: ICreateSarifDocumentOptions): ISarifLog;
/**
 * Creates an ordinary SARIF document with one empty run (contract §3.1).
 *
 * @param options - the author (`tool: { name, version? }`) and an optional
 *   source binding (`source: { owner, repo, commit }`); validated at run
 *   time, since JavaScript callers can pass anything
 * @returns a fresh, schema-valid SARIF log
 * @throws TypeError on malformed options
 */
export function createSarifDocument(options?: ICreateSarifDocumentOptions): ISarifLog {
  const operation = 'createSarifDocument';
  const input: unknown = options;
  const given: unknown = input === undefined ? {} : captureJson(input, 'options');
  if (!isPlainObject(given)) throw misuse(operation, 'options must be an object');
  refuseUnknownKeys(given, ['tool', 'source'], 'options', operation);
  let tool: ISarifToolIdentity = { name: DEFAULT_TOOL_NAME, version: packageVersion() };
  const givenTool = given['tool'];
  if (givenTool !== undefined) {
    if (!isPlainObject(givenTool)) throw misuse(operation, 'options.tool must be an object with a name');
    refuseUnknownKeys(givenTool, ['name', 'version'], 'options.tool', operation);
    const { name, version } = givenTool;
    if (!nonEmptyString(name)) throw misuse(operation, 'options.tool.name must be a non-empty string');
    if (version !== undefined && !nonEmptyString(version)) {
      throw misuse(operation, 'options.tool.version must be a non-empty string when given');
    }
    tool = { name, version };
  }
  const source = given['source'];
  if (source !== undefined) checkSource(source, 'options.source', operation);
  return { $schema: SCHEMA_URI, version: '2.1.0', runs: [newRun(tool, source)] };
}

/** Validates a captured comment (see addSarifComment), refusing it with a TypeError. */
function assertComment(captured: unknown, operation: Operation): asserts captured is ISarifComment {
  if (!isPlainObject(captured)) throw misuse(operation, 'comment must be an object');
  refuseUnknownKeys(captured, ['file', 'line', 'endLine', 'message', 'messageFormat', 'ruleId', 'level', 'run'], 'comment', operation);
  const { file, line, endLine, message, messageFormat, ruleId, level, run } = captured;
  if (!isNormalizedRepositoryPath(file)) {
    throw misuse(operation, 'comment.file must be a repository-relative path with "/" separators and no ".", ".." or empty segment');
  }
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) throw misuse(operation, 'comment.line must be a positive whole line number');
  if (endLine !== undefined && (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < line)) {
    throw misuse(operation, 'comment.endLine must be a whole line number no smaller than comment.line');
  }
  if (!nonEmptyString(message)) throw misuse(operation, 'comment.message must be a non-empty string');
  if (messageFormat !== undefined && messageFormat !== 'text' && messageFormat !== 'markdown') {
    throw misuse(operation, 'comment.messageFormat must be "text" or "markdown"');
  }
  if (ruleId !== undefined && !nonEmptyString(ruleId)) throw misuse(operation, 'comment.ruleId must be a non-empty string');
  if (level !== undefined && !LEVELS.has(level)) throw misuse(operation, 'comment.level must be none, note, warning or error');
  if (run !== undefined && !(typeof run === 'number' && Number.isInteger(run) && run >= 0)) {
    if (!isPlainObject(run)) throw misuse(operation, 'comment.run must be a run index or { toolName, toolVersion?, source? }');
    refuseUnknownKeys(run, ['toolName', 'toolVersion', 'source'], 'comment.run', operation);
    const { toolName, toolVersion, source } = run;
    if (!nonEmptyString(toolName)) throw misuse(operation, 'comment.run.toolName must be a non-empty string');
    if (toolVersion !== undefined && !nonEmptyString(toolVersion)) throw misuse(operation, 'comment.run.toolVersion must be a non-empty string');
    if (source !== undefined) checkSource(source, 'comment.run.source', operation);
  }
}

/** Validates a comment and returns its captured copy (see addSarifComment). */
function checkComment(comment: unknown, operation: Operation): ISarifComment {
  const captured: unknown = captureJson(comment, 'comment');
  assertComment(captured, operation);
  return captured;
}

/**
 * The SARIF result a comment denotes (contract §3.2). Fields appear in the
 * contract's order: ruleId, level, message, locations. A text comment's
 * message is `{ text }`. A Markdown comment's message is `{ text, markdown }`,
 * both holding the caller's text, because the schema requires `text`. The
 * region states endLine only when the caller gave one.
 */
function resultFor(comment: ISarifComment): IAuthoredResult {
  const region = comment.endLine === undefined ? { startLine: comment.line } : { startLine: comment.line, endLine: comment.endLine };
  return {
    ...(comment.ruleId !== undefined ? { ruleId: comment.ruleId } : {}),
    ...(comment.level !== undefined ? { level: comment.level } : {}),
    message: comment.messageFormat === 'markdown'
      ? { text: comment.message, markdown: comment.message }
      : { text: comment.message },
    locations: [{ physicalLocation: { artifactLocation: { uri: encodeRepositoryPath(comment.file) }, region } }],
  };
}

/**
 * Whether a validated comment's run selection asks for a new run: a plain
 * object, where an existing run is chosen by a whole number.
 */
function isNewRun(run: ISarifComment['run']): run is INewSarifRun {
  return isPlainObject(run);
}

/**
 * Whether a captured document that validateSarif has just accepted has the
 * shape this module reads. This is the module's one unchecked boundary: it
 * confirms the top level (an object with a `runs` array) and relies on the
 * SARIF 2.1.0 schema, which ajv has enforced, for the rest of
 * {@link IExtensibleSarifLog}: `version` "2.1.0", each run's
 * `tool.driver.name` and each present `results` array.
 */
function isValidatedLog(captured: unknown): captured is IExtensibleSarifLog {
  return isPlainObject(captured) && Array.isArray(captured['runs']);
}

/**
 * Adds one finding on a line or line range to a copy of a SARIF document.
 *
 * @remarks
 * Works on any schema-valid SARIF, whether it came from
 * {@link createSarifDocument} or from another producer. The input is copied
 * and never changed; every existing run, finding and property is kept. Only
 * what you supply is written: no source is read, so lines are checked later,
 * by {@link addStagedChangesToSarif} and by publication.
 *
 * @param sarif - A SARIF log as a parsed JSON object.
 * @param comment - The finding.
 * @returns `added` with the new document, or `invalid` if the input is not
 * schema-valid SARIF or has no run.
 * @throws `TypeError` for a malformed comment, a run index out of range, or
 * a document with several runs and no `run` choice.
 *
 * @example
 * ```ts
 * import { createSarifDocument, addSarifComment } from 'sarif-to-comment';
 *
 * let sarif = createSarifDocument({ tool: { name: 'Review agent' } });
 * const added = addSarifComment(sarif, { file: 'src/parse.js', line: 2, message: 'Handle empty input.' });
 * if (added.status === 'added') sarif = added.sarif;
 * ```
 *
 * @public
 */
export function addSarifComment(sarif: object, comment: ISarifComment): AddSarifCommentOutcome {
  return addSarifCommentWithUntypedInput(sarif, comment);
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
 * Both arguments are validated at run time, since JavaScript callers can pass
 * anything. The public {@link addSarifComment} calls this with its
 * documented parameter types; the CLI calls it directly, because it
 * passes parsed file content that only this validation judges.
 *
 * @returns `{ status: 'added', sarif, finding: { ref, runIndex, resultIndex, tool }, diagnostics: [] }`
 *   or `{ status: 'invalid', problems, markdown, diagnostics }`
 * @throws TypeError on caller misuse
 */
function addSarifCommentWithUntypedInput(sarif: unknown, comment: unknown): AddSarifCommentOutcome {
  const operation = 'addSarifComment';
  const input: unknown = sarif;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw misuse(operation, 'sarif must be a parsed SARIF object, not serialized text');
  }
  const captured: unknown = captureJson(input, 'sarif');
  const checked = checkComment(comment, operation);
  const invalid = validateSarif(captured);
  if (invalid) return invalid;
  if (!isValidatedLog(captured)) throw new Error('Internal error: a schema-valid SARIF log has no runs array.');

  const { runs } = captured;
  let runIndex: number;
  if (isNewRun(checked.run)) {
    runs.push(newRun({ name: checked.run.toolName, version: checked.run.toolVersion }, checked.run.source));
    runIndex = runs.length - 1;
  } else if (checked.run !== undefined) {
    if (checked.run >= runs.length) throw misuse(operation, `comment.run ${String(checked.run)} is out of range; the document has ${String(runs.length)} run(s)`);
    runIndex = checked.run;
  } else if (runs.length === 0) {
    const message = 'The document has no run to add the comment to. Pass `run: { toolName }` to add one under your own attribution.';
    const problem = createProblem('sarif-no-runs', { message, pointer: '/runs' });
    return { status: 'invalid', problems: [problem], markdown: `**Cannot add the comment:** ${message}`, diagnostics: [diagnosticOf(problem)] };
  } else if (runs.length > 1) {
    throw misuse(operation, `the document has ${String(runs.length)} runs; choose one with comment.run (an index or { toolName } for a new run)`);
  } else {
    runIndex = 0;
  }

  const run = runs[runIndex];
  if (run === undefined) throw new Error(`Internal error: run ${String(runIndex)} is outside a list of ${String(runs.length)}.`);
  let { results } = run;
  if (!Array.isArray(results)) {
    results = [];
    run.results = results;
  }
  results.push(resultFor(checked));
  const resultIndex = results.length - 1;
  return {
    status: 'added',
    sarif: captured,
    finding: { ref: `/runs/${String(runIndex)}/results/${String(resultIndex)}`, runIndex, resultIndex, tool: run.tool.driver.name },
    diagnostics: [],
  };
}

/**
 * Removes one finding, with the fixes attached to it, from a copy of a SARIF
 * document.
 *
 * @remarks
 * Take the selector from {@link inspectSarif}: each finding's `selector`. It
 * belongs to the document exactly as inspected, so after any change, such as
 * a previous removal, inspect again. A selector that no longer fits is
 * refused as `stale` rather than removing whichever finding is now in its
 * place, which also keeps identical findings apart.
 *
 * The whole finding is removed, including its fixes and proposed file
 * operations. Everything else is kept: other findings and their fixes (even
 * identical ones), runs, artifacts and properties. Works on SARIF from any
 * producer; the input is copied and never changed.
 *
 * To correct a finding, remove it and add the replacement with
 * {@link addSarifComment}. Removal only edits this document; it never changes
 * a published review, and it does not re-derive fixes: run
 * {@link addStagedChangesToSarif} again on the corrected document.
 *
 * @param sarif - A SARIF log as a parsed JSON object.
 * @param selector - The finding's `selector` from {@link inspectSarif}.
 * @returns `removed` with the new document, `stale` if the selector does not
 * fit the document as it is now, or `invalid` if the input is not schema-valid
 * SARIF.
 * @throws `TypeError` for a selector that is not of the form inspection gives
 * (a bare `ref` included), or non-JSON input.
 *
 * @example
 * ```ts
 * import { inspectSarif, removeSarifComment } from 'sarif-to-comment';
 *
 * const inspected = inspectSarif(sarif);
 * if (inspected.status === 'inspected') {
 *   const removed = removeSarifComment(sarif, inspected.view.findings[0].selector);
 *   if (removed.status === 'removed') sarif = removed.sarif;
 * }
 * ```
 *
 * @public
 */
export function removeSarifComment(sarif: object, selector: string): RemoveSarifCommentOutcome {
  return removeSarifCommentWithUntypedInput(sarif, selector);
}

/** A `stale` outcome for `selector`, pointing at the position it names. */
function staleSelector(selector: string, ref: string, message: string): IStaleSarifSelectorOutcome {
  const problem = createProblem('finding-selector-stale', { message, pointer: ref });
  return { status: 'stale', selector, problems: [problem], markdown: `**Cannot remove the finding:** ${message}`, diagnostics: [diagnosticOf(problem)] };
}

/** How many entries a property of a removed result holds, when it is an array. */
function entriesOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** How many proposed whole-file operations a result carries in its owned extension (D23). */
function fileProposalsOf(result: object): number {
  if (!isPlainObject(result)) return 0;
  const { properties } = result;
  if (!isPlainObject(properties)) return 0;
  const owned = properties['sarifToComment'];
  return isPlainObject(owned) ? entriesOf(owned['proposedFileChanges']) : 0;
}

/**
 * Removes the selected finding from a copy of `sarif` (docs/finding-removal-contract.md §3).
 *
 * Order: capture, check the selector's form (TypeError), validate the
 * schema (`invalid`), compare the document digest and locate the position
 * (`stale`), then remove. The digest is taken before anything changes, over
 * the same captured value inspection digests, so a document that is
 * unchanged since inspection always matches.
 *
 * Both arguments are validated at run time, since JavaScript callers can pass
 * anything; the CLI calls this directly with parsed file content.
 *
 * @returns `{ status: 'removed', sarif, finding, diagnostics: [] }`, `{ status: 'stale', selector, problems, markdown, diagnostics }`
 *   or `{ status: 'invalid', problems, markdown, diagnostics }`
 * @throws TypeError on caller misuse
 */
function removeSarifCommentWithUntypedInput(sarif: unknown, selector: unknown): RemoveSarifCommentOutcome {
  const operation = 'removeSarifComment';
  const input: unknown = sarif;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw misuse(operation, 'sarif must be a parsed SARIF object, not serialized text');
  }
  const json = captureJson(input, 'sarif');
  const captured: unknown = json;
  const parsed = parseFindingSelector(selector);
  if (parsed === null || typeof selector !== 'string') {
    throw misuse(operation, 'selector must be a finding selector such as "/runs/0/results/1@0123456789abcdef", '
      + 'copied from a finding\'s `selector` in inspectSarif (or `sarif-to-comment inspect`); a position alone does not select a finding');
  }
  const invalid = validateSarif(captured);
  if (invalid) return invalid;
  if (!isValidatedLog(captured)) throw new Error('Internal error: a schema-valid SARIF log has no runs array.');

  const { ref, runIndex, resultIndex } = parsed;
  if (documentDigest(json) !== parsed.digest) {
    return staleSelector(selector, ref, `The document has changed since the selector \`${selector}\` was taken from inspecting it, `
      + 'so it may no longer name the same finding. Nothing was removed. Inspect the document again and use its current selector.');
  }
  const run = captured.runs[runIndex];
  const results = run?.results;
  const result = results?.[resultIndex];
  if (run === undefined || results === undefined || result === undefined) {
    return staleSelector(selector, ref, `This document has no finding at \`${ref}\`, so the selector \`${selector}\` did not come from `
      + 'inspecting it. Nothing was removed. Inspect the document again and use a selector it shows.');
  }
  results.splice(resultIndex, 1);
  return {
    status: 'removed',
    sarif: captured,
    finding: {
      ref,
      runIndex,
      resultIndex,
      tool: run.tool.driver.name,
      fixes: isPlainObject(result) ? entriesOf(result['fixes']) : 0,
      fileProposals: fileProposalsOf(result),
    },
    diagnostics: [],
  };
}

export { addSarifCommentWithUntypedInput, removeSarifCommentWithUntypedInput };
