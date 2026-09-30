/**
 * Complete, read-only SARIF inspection (private internal module).
 *
 * Turns any schema-valid SARIF, authored or upstream, into one simplified,
 * JSON-compatible view of its findings and proposed changes, so an agent can
 * see what it holds before publishing (contract §3.3). Human rendering
 * (`renderInspectionText`) is a projection of that same view, never an
 * independent traversal, so human and JSON output cannot disagree.
 *
 * Invariants:
 * - Complete, not a readiness check. Every run, finding, full message, every
 *   location and related location, every included fix (alternatives and
 *   multi-file changes too) and every file proposal appears. That includes
 *   content the publisher would block. Evidence without a named field of its
 *   own is kept verbatim in `otherContent`; counts never stand in for
 *   omitted content.
 *   - This includes log-level content (`log`) and artifact-content metadata
 *     (a preview's `otherContent`).
 *   - Results embedded in inline external properties are shown verbatim
 *     (`externalProperties`), counted separately (`summary.externalFindings`)
 *     and warned about. Declared run associations remain in that content;
 *     inspection does not merge embedded properties into run findings.
 *   - Referenced external property files are never loaded, and a warning
 *     says so.
 * - Only previews shorten. Inserted fix text and proposed file content may
 *   be previewed within line/character limits. Shortening is signalled only
 *   by `state: 'truncated'` and exact counts, never by editing the text.
 *   Messages are never shortened.
 * - Read-only and destination-free. No source, Git, host or file is read.
 *   Provenance is reported as declared facts; with no destination
 *   repository, inspection never judges a source foreign. The input SARIF is
 *   captured and never changed.
 * - Selectable. Every finding carries a selector bound to the document as
 *   inspected (finding-selectors.cts), which removal and grouping require,
 *   so a finding is never removed or grouped in a document that changed
 *   after it was inspected.
 * - Shared interpretation. Paths, rules and messages are read with the same
 *   rules the publisher uses (`sarif-common.cjs`). What cannot be resolved
 *   stays in the view (`path: null`, `resolved: false`) with a warning.
 */


import { documentDigest, findingSelector } from './finding-selectors.cjs';
import {
  captureJson, validateSarif, isPlainObject, parseBaseUri, resolveArtifactPath, resolveRule, resolveMessage,
} from './sarif-common.cjs';
import type {
  ArtifactPathResolution, IPlainObject, ISarifArtifact, ISarifArtifactLocation, ISarifMessage, ISarifReportingDescriptor,
  ISarifResult, ISarifRun, ISarifTool, ISarifToolComponent,
} from './sarif-common.cjs';
import type { IInvalidSarifOutcome } from './public-types.cjs';

// ---------------------------------------------------------------------------
// Public types
//
// These are the shapes the package documents for inspection. Their names and
// documentation are the public ones, so declarations generated from this
// module read exactly as the published API.

/**
 * Options for {@link inspectSarif}. Unknown fields are refused.
 *
 * @public
 */
export interface IInspectSarifOptions {
  /** Lines shown per fix preview: a positive whole number (default 20), or `null` for all. */
  readonly previewLines?: number | null | undefined;
  /** Characters shown per fix preview: a positive whole number (default 2000), or `null` for all. */
  readonly previewChars?: number | null | undefined;
  /**
   * Absolute `file:` URI (ending in `/`) of the repository root in the SARIF
   * producer's file system, so absolute artifact URIs resolve to paths.
   */
  readonly sourceRootUri?: string | undefined;
}

/**
 * Proposed text, possibly shortened. Only previews are ever shortened; the
 * text is never annotated, so `state` and the counts are the only signal.
 *
 * @public
 */
export interface IInspectionPreview {
  /**
   * `complete`: all of it is shown. `truncated`: the start is shown, in whole
   * lines where the line limit applies. `unavailable`: binary content, not shown.
   */
  readonly state: 'complete' | 'truncated' | 'unavailable';
  /** The shown text. */
  readonly text?: string | undefined;
  /** Lines in the complete text. */
  readonly totalLines?: number | undefined;
  /** UTF-16 code units in the complete text. */
  readonly totalChars?: number | undefined;
  /** Lines at least partly shown. */
  readonly shownLines?: number | undefined;
  /** UTF-16 code units shown. */
  readonly shownChars?: number | undefined;
  /** Size of unavailable binary content, in bytes. */
  readonly byteLength?: number | undefined;
  /**
   * Everything else the content carries beyond the previewed text or binary
   * (for example `rendered`, `properties`, or a `binary` alternative to
   * previewed text), kept verbatim and never shortened.
   */
  readonly otherContent?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * A location of a finding, a related location, or a location that could not
 * be resolved to a repository path.
 *
 * @public
 */
export interface IInspectionLocation {
  /** Repository-relative path, or `null` when it cannot be resolved. */
  readonly path: string | null;
  /** The artifact reference exactly as written. */
  readonly artifactLocation?: object | undefined;
  /** The reference's URI. */
  readonly uri?: string | undefined;
  /** The reference's base identifier. */
  readonly uriBaseId?: string | undefined;
  /** First line (one-based). */
  readonly startLine?: number | undefined;
  /** Last line (inclusive). */
  readonly endLine?: number | undefined;
  /** First column. */
  readonly startColumn?: number | undefined;
  /** Column after the last one. */
  readonly endColumn?: number | undefined;
  /** Character offset. */
  readonly charOffset?: number | undefined;
  /** Character length. */
  readonly charLength?: number | undefined;
  /** The region's snippet text. */
  readonly snippet?: string | undefined;
  /** The location's own message: its text, else its Markdown. */
  readonly message?: string | undefined;
  /**
   * The location's complete message, present when it holds more than plain
   * text: a Markdown alternative, an id, unused arguments or metadata.
   */
  readonly messageContent?: IInspectionMessage | undefined;
  /** Logical locations, exactly as written. */
  readonly logical?: readonly object[] | undefined;
  /** Every other property of the location, kept verbatim. */
  readonly otherContent?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * One replacement within a fix.
 *
 * @public
 */
export interface IInspectionReplacement {
  /** The region to delete, exactly as written (the deleted source text is not read). */
  readonly deletedRegion: Readonly<Record<string, unknown>>;
  /** The inserted text. */
  readonly inserted: IInspectionPreview;
  /** Every other property of the replacement, kept verbatim. */
  readonly otherContent?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The replacements a fix makes in one file.
 *
 * @public
 */
export interface IInspectionArtifactChange {
  /** Repository-relative path, or `null` when it cannot be resolved. */
  readonly path: string | null;
  /** The reference's URI. */
  readonly uri: string;
  /** The artifact reference exactly as written. */
  readonly artifactLocation: object;
  /** Every replacement, in order. */
  readonly replacements: readonly IInspectionReplacement[];
  /** Every other property of the change, kept verbatim. */
  readonly otherContent?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * One fix of a finding, including alternatives and changes to several files.
 *
 * @public
 */
export interface IInspectionFix {
  /** JSON Pointer to the fix. */
  readonly ref: string;
  /** The fix's description: its text, else its Markdown. */
  readonly description?: string | undefined;
  /**
   * The complete description, present when it holds more than plain text: a
   * Markdown alternative, an id, unused arguments or metadata.
   */
  readonly descriptionContent?: IInspectionMessage | undefined;
  /** Every file change, in order. */
  readonly changes: readonly IInspectionArtifactChange[];
  /** Every other property of the fix, kept verbatim. */
  readonly otherContent?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * A proposed whole-file operation (`create` or `delete`) carried by a
 * finding. Publication presents each one in the review body.
 *
 * @public
 */
export interface IInspectionFileProposal {
  /** JSON Pointer to the proposal. */
  readonly ref: string;
  /** The operation as written, normally `"create"` or `"delete"`; unknown values are shown as they are. */
  readonly operation: unknown;
  /** Repository-relative path of the file, or `null` when unknown. */
  readonly path: string | null;
  /** The artifact index the proposal names, as written. */
  readonly artifactIndex?: unknown;
  /** The proposed Git file mode, such as `"100644"`, as written. */
  readonly fileMode?: unknown;
  /** The proposed content of a created file. */
  readonly content?: IInspectionPreview | undefined;
  /** Every other property of the proposal, kept verbatim. */
  readonly otherContent?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * A message, resolved but never shortened.
 *
 * @public
 */
export interface IInspectionMessage {
  /** Plain text. */
  readonly text?: string | undefined;
  /** Markdown. */
  readonly markdown?: string | undefined;
  /** The message id, when the message is given by reference. */
  readonly id?: string | undefined;
  /** The supplied arguments, shown when resolution could not use them (an unknown id or a missing placeholder). */
  readonly arguments?: readonly string[] | undefined;
  /** False when a referenced message or argument is missing. */
  readonly resolved: boolean;
  /** Message metadata, such as `properties`, kept verbatim. */
  readonly otherContent?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * One finding (SARIF result) with everything it carries.
 *
 * @public
 */
export interface IInspectionFinding {
  /** JSON Pointer to the result, such as `/runs/0/results/3`. */
  readonly ref: string;
  /**
   * Selects this finding for {@link removeSarifComment},
   * {@link groupSarifFixes} and {@link ungroupSarifFixes}. It is bound to the
   * document exactly as inspected: after any change to the document, inspect
   * again for current selectors. Treat it as opaque.
   */
  readonly selector: string;
  /** Index of its run. */
  readonly runIndex: number;
  /** Index of the result in its run. */
  readonly resultIndex: number;
  /** Rule identifier. */
  readonly ruleId?: string | undefined;
  /** SARIF level. */
  readonly level?: string | undefined;
  /** SARIF kind. */
  readonly kind?: string | undefined;
  /** SARIF baseline state. */
  readonly baselineState?: string | undefined;
  /** A declared approval hold, as written. */
  readonly approval?: string | undefined;
  /**
   * The suggestion group the finding's change belongs to
   * (`properties.sarifToComment.suggestionGroup`), as written, when it is a
   * string. See {@link groupSarifFixes}.
   */
  readonly suggestionGroup?: string | undefined;
  /** The full message. */
  readonly message: IInspectionMessage;
  /** Every location, in order; empty for a general finding. */
  readonly locations: readonly IInspectionLocation[];
  /** Every related location, in order. */
  readonly relatedLocations: readonly IInspectionLocation[];
  /** Every other property of the result (such as code flows and suppressions), kept verbatim. */
  readonly otherContent: Readonly<Record<string, unknown>>;
  /** Every fix, including alternatives. */
  readonly fixes: readonly IInspectionFix[];
  /** Every proposed whole-file operation. */
  readonly fileProposals: readonly IInspectionFileProposal[];
}

/**
 * One run: its tool and declared source.
 *
 * @public
 */
export interface IInspectionRun {
  /** Index of the run. */
  readonly index: number;
  /** JSON Pointer to the run. */
  readonly ref: string;
  /** The run's tool. */
  readonly tool: { readonly name: string; readonly version?: string | undefined };
  /**
   * The declared source: `unbound` when the run declares no provenance,
   * otherwise `declared` with the provenance exactly as written.
   */
  readonly source: { readonly state: 'unbound' | 'declared'; readonly provenance: readonly object[] };
  /** The run's column unit. */
  readonly columnKind?: string | undefined;
  /** A declared approval hold, as written. */
  readonly approval?: string | undefined;
  /** Every other property of the run, kept verbatim. */
  readonly otherContent: Readonly<Record<string, unknown>>;
}

/**
 * Something inspection could not interpret, such as an unresolvable path.
 *
 * @public
 */
export interface IInspectionDiagnostic {
  /** Always `warning`: inspection never refuses valid SARIF. */
  readonly severity: 'warning';
  /** What could not be interpreted. */
  readonly message: string;
  /** JSON Pointer to it. */
  readonly pointer: string;
}

/**
 * One entry of the log's `inlineExternalProperties`, shown verbatim.
 *
 * @remarks
 * Results embedded here are counted and shown as written rather than merged
 * into run findings. Any declared runGuid association stays in that verbatim
 * content. External property files referenced by a run are never
 * fetched; those references stay in the run's `otherContent` with a warning.
 *
 * @public
 */
export interface IInspectionExternalProperties {
  /** JSON Pointer to the entry, such as `/inlineExternalProperties/0`. */
  readonly ref: string;
  /** How many results the entry embeds. */
  readonly results: number;
  /** The entry exactly as written, including its embedded results. */
  readonly content: Readonly<Record<string, unknown>>;
}

/**
 * A simplified, JSON-compatible view of a SARIF document for proofreading.
 * It is complete except for fix previews, and it is not a check that the
 * document can be published.
 *
 * @public
 */
export interface ISarifInspection {
  /** Identifies this view format. */
  readonly format: 'sarif-to-comment.inspection';
  /** Version of this view format. */
  readonly version: 1;
  /** Counts of what the view contains. */
  readonly summary: {
    readonly runs: number;
    readonly findings: number;
    readonly fixes: number;
    readonly fileProposals: number;
    readonly truncatedPreviews: number;
    /**
     * Results embedded in `inlineExternalProperties`, which are not counted
     * in `findings`. Present whenever the log has inline external properties.
     */
    readonly externalFindings?: number | undefined;
  };
  /**
   * Log-level content other than `version`, `$schema`, `runs` and
   * `inlineExternalProperties` (for example the log's `properties`), kept
   * verbatim. Present only when the log has such content.
   */
  readonly log?: { readonly otherContent: Readonly<Record<string, unknown>> } | undefined;
  /** Every inline external-properties entry, verbatim. Present only when the log has them. */
  readonly externalProperties?: readonly IInspectionExternalProperties[] | undefined;
  /** Every run. */
  readonly runs: readonly IInspectionRun[];
  /** Every finding of every run, in document order. */
  readonly findings: readonly IInspectionFinding[];
  /** Everything that could not be interpreted. */
  readonly diagnostics: readonly IInspectionDiagnostic[];
}

/**
 * The document was inspected.
 *
 * @public
 */
export interface IInspectedOutcome {
  /** Discriminant: the document was inspected. */
  readonly status: 'inspected';
  /** The view. */
  readonly view: ISarifInspection;
}

/**
 * Every outcome of {@link inspectSarif}, discriminated by `status`.
 *
 * @public
 */
export type InspectSarifOutcome = IInspectedOutcome | IInvalidSarifOutcome;
// ---------------------------------------------------------------------------
// Internal types

/**
 * A view under construction: the public shape with its fields writable, so
 * optional fields can be added in the view's documented key order. Only
 * fresh objects this module creates are built this way.
 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Evidence kept verbatim: the properties of a JSON object that no named view field presents. */
type Evidence = Record<string, unknown>;

/** Preview bounds and the producer's source root, as checked by {@link checkOptions}. */
interface IInspectionLimits {
  /** Lines shown per preview; Infinity for unlimited. */
  readonly lines: number;
  /** Characters shown per preview; Infinity for unlimited. */
  readonly chars: number;
  /** The validated `options.sourceRootUri`, passed on to path resolution as given. */
  readonly sourceRootUri?: unknown;
}

/** Mutable accumulation for one inspection: warnings and preview counts. */
interface IInspectionState {
  readonly limits: IInspectionLimits;
  readonly diagnostics: IInspectionDiagnostic[];
  truncatedPreviews: number;
}

/** The rule a finding names (if any) and the tool component whose messages it reads. */
interface IFindingContext {
  readonly rule: ISarifReportingDescriptor | undefined;
  readonly component: ISarifToolComponent;
}

// The SARIF types below describe a captured, schema-valid SARIF 2.1.0 log as
// far as inspection reads it. They extend the shared views with the fields
// inspection names, and keep an index signature because every property
// without a named view field is retained verbatim as evidence.

/** SARIF artifactContent (3.3): text, binary or other forms. */
interface IArtifactContentInput extends IPlainObject {
  readonly text?: string;
  readonly binary?: string;
}

/** SARIF artifactLocation (3.4), with any other properties it carries. */
interface IArtifactLocationInput extends ISarifArtifactLocation, IPlainObject {}

/** SARIF artifact (3.24), with its location and contents. */
interface IArtifactInput extends ISarifArtifact, IPlainObject {
  readonly location?: IArtifactLocationInput;
  readonly contents?: IArtifactContentInput;
}

/** SARIF message (3.11), with any metadata it carries. */
interface IMessageInput extends ISarifMessage, IPlainObject {}

/** SARIF region (3.30): the coordinates LocationView names, a snippet and anything else. */
interface IRegionInput extends IPlainObject {
  readonly startLine?: number;
  readonly endLine?: number;
  readonly startColumn?: number;
  readonly endColumn?: number;
  readonly charOffset?: number;
  readonly charLength?: number;
  readonly snippet?: IArtifactContentInput;
}

/** SARIF physicalLocation (3.29). */
interface IPhysicalLocationInput extends IPlainObject {
  readonly artifactLocation?: IArtifactLocationInput;
  readonly region?: IRegionInput;
}

/** SARIF location (3.28). */
interface ILocationInput extends IPlainObject {
  readonly physicalLocation?: IPhysicalLocationInput;
  readonly message?: IMessageInput;
  readonly logicalLocations?: readonly IPlainObject[];
}

/** SARIF replacement (3.57). */
interface IReplacementInput extends IPlainObject {
  readonly deletedRegion: IPlainObject;
  readonly insertedContent?: IArtifactContentInput;
}

/** SARIF artifactChange (3.56). */
interface IArtifactChangeInput extends IPlainObject {
  readonly artifactLocation: IArtifactLocationInput;
  readonly replacements: readonly IReplacementInput[];
}

/** SARIF fix (3.55). */
interface IFixInput extends IPlainObject {
  readonly description?: IMessageInput;
  readonly artifactChanges: readonly IArtifactChangeInput[];
}

/** SARIF result (3.27), with the fields a FindingView names. */
interface IResultInput extends ISarifResult, IPlainObject {
  readonly level?: string;
  readonly kind?: string;
  readonly baselineState?: string;
  readonly message: IMessageInput;
  readonly locations?: readonly ILocationInput[];
  readonly relatedLocations?: readonly ILocationInput[];
  readonly fixes?: readonly IFixInput[];
  readonly properties?: IPlainObject;
}

/** SARIF toolComponent (3.19), with the version fields a RunView names. */
interface IToolComponentInput extends ISarifToolComponent {
  readonly version?: string;
  readonly semanticVersion?: string;
}

/** SARIF tool (3.18). */
interface IToolInput extends ISarifTool {
  readonly driver: IToolComponentInput;
}

/** SARIF run (3.14), with the fields a RunView and inspection read. */
interface IRunInput extends ISarifRun, IPlainObject {
  readonly tool: IToolInput;
  readonly artifacts?: readonly IArtifactInput[];
  readonly results?: readonly IResultInput[];
  readonly columnKind?: string;
  readonly properties?: IPlainObject;
  readonly externalPropertyFileReferences?: unknown;
}

/** SARIF externalProperties (3.15), as embedded inline in a log. */
interface IExternalPropertiesInput extends IPlainObject {
  readonly results?: readonly unknown[];
}

/** SARIF log (3.13), as inspection reads it. */
interface IInspectableLog extends IPlainObject {
  readonly runs: readonly IRunInput[];
  readonly inlineExternalProperties?: readonly IExternalPropertiesInput[];
}

/** A text preview, as {@link previewText} produces it: its text and every count are present. */
interface ITextPreview extends IInspectionPreview {
  readonly text: string;
  readonly totalLines: number;
  readonly totalChars: number;
  readonly shownLines: number;
  readonly shownChars: number;
}

// ---------------------------------------------------------------------------
// Constants and helpers

/** Default preview bounds (contract §3.3); `null` means unlimited. */
const DEFAULT_PREVIEW_LINES = 20;
const DEFAULT_PREVIEW_CHARS = 2000;

/** Identifies the view's schema for consumers. */
const VIEW_FORMAT = 'sarif-to-comment.inspection';
const VIEW_VERSION = 1;

/** Owned file-proposal operations the product recognises (D23); others are shown with a warning. */
const KNOWN_FILE_OPERATIONS = new Set(['create', 'delete', 'edit']);

/** Result properties presented by named view fields; all other result content goes to otherContent. */
const NAMED_RESULT_KEYS = new Set(['ruleId', 'level', 'kind', 'baselineState', 'message', 'locations', 'relatedLocations', 'fixes']);

/** Run properties presented by named view fields; all other run content goes to otherContent. */
const NAMED_RUN_KEYS = new Set(['results', 'columnKind', 'versionControlProvenance']);

/** Region properties presented by named LocationView fields. */
const NAMED_REGION_KEYS = ['startLine', 'endLine', 'startColumn', 'endColumn', 'charOffset', 'charLength'] as const;

function misuse(message: string): TypeError {
  return new TypeError(`Invalid inspectSarif input: ${message}`);
}

/** `value` without the named keys; used to retain unnamed evidence verbatim. */
function without(value: object, keys: ReadonlySet<string>): Evidence {
  const rest: Evidence = {};
  for (const [key, item] of Object.entries(value)) if (!keys.has(key)) rest[key] = item;
  return rest;
}

/**
 * A property of a JSON object that the public view types hold as an opaque
 * `object` (artifact references, provenance entries, logical locations),
 * read exactly as `value[key]` would be.
 */
function read(value: object, key: string): unknown {
  const item: unknown = Reflect.get(value, key);
  return item;
}

/** Reads a preview bound: a positive integer, null for unlimited, or the default. */
function previewBound(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (value === null) return Infinity;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw misuse(`options.${name} must be a positive whole number or null for unlimited`);
  }
  return value;
}

function checkOptions(options: unknown): IInspectionLimits {
  if (options === undefined) return { lines: DEFAULT_PREVIEW_LINES, chars: DEFAULT_PREVIEW_CHARS };
  const given: unknown = captureJson(options, 'options');
  if (!isPlainObject(given)) throw misuse('options must be an object');
  for (const key of Object.keys(given)) {
    if (!['previewLines', 'previewChars', 'sourceRootUri'].includes(key)) throw misuse(`options has unknown key ${JSON.stringify(key)}`);
  }
  const { sourceRootUri } = given;
  if (sourceRootUri !== undefined) {
    const root = typeof sourceRootUri === 'string' ? parseBaseUri(sourceRootUri) : null;
    if (!root || root.error || root.root !== 'file:') throw misuse('options.sourceRootUri must be an absolute file: URI ending in "/"');
  }
  return {
    lines: previewBound(given['previewLines'], 'previewLines', DEFAULT_PREVIEW_LINES),
    chars: previewBound(given['previewChars'], 'previewChars', DEFAULT_PREVIEW_CHARS),
    sourceRootUri,
  };
}

// ---------------------------------------------------------------------------
// Previews

/**
 * A bounded preview of proposed text.
 *
 * Lines are physical lines; a final line without a newline counts.
 * - The line limit takes whole lines only.
 * - If the kept lines exceed the character limit, the longest run of whole
 *   lines within it is shown.
 * - If even the first line is too long, that line is cut at the character
 *   limit, never inside a surrogate pair.
 *
 * `shownLines` counts lines at least partly shown. The text itself is never
 * annotated.
 */
function previewText(text: string, limits: IInspectionLimits, state: IInspectionState): ITextPreview {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let shownLines = Math.min(lines.length, limits.lines);
  let shown = lines.slice(0, shownLines).join('');
  if (shown.length > limits.chars) {
    let whole = '';
    let count = 0;
    while (count < shownLines) {
      // count < shownLines <= lines.length, so the line always exists.
      const line = lines[count];
      if (line === undefined || whole.length + line.length > limits.chars) break;
      whole += line;
      count += 1;
    }
    if (count > 0) {
      shown = whole;
      shownLines = count;
    } else {
      let cut = limits.chars;
      const code = text.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
      shown = text.slice(0, cut);
      shownLines = shown === '' ? 0 : 1;
    }
  }
  const preview: ITextPreview = {
    state: shown === text ? 'complete' : 'truncated',
    text: shown,
    totalLines: lines.length,
    totalChars: text.length,
    shownLines,
    shownChars: shown.length,
  };
  if (preview.state === 'truncated') state.truncatedPreviews += 1;
  return preview;
}

/**
 * The preview of SARIF artifactContent (3.3).
 * - Text is previewed.
 * - Binary-only content is explicitly unavailable, with its decoded size.
 * Everything else the content holds is kept verbatim in `otherContent`:
 * `rendered` forms, `properties`, and a binary alternative when the text is
 * previewed. Only the previewed text itself may shorten.
 */
function previewContent(content: IArtifactContentInput | undefined, limits: IInspectionLimits, state: IInspectionState): IInspectionPreview {
  if (content === undefined) return previewText('', limits, state);
  let preview: Mutable<IInspectionPreview>;
  let shownKey: string | undefined;
  if (typeof content.text === 'string') {
    preview = previewText(content.text, limits, state);
    shownKey = 'text';
  } else if (typeof content.binary === 'string') {
    preview = { state: 'unavailable', byteLength: Buffer.from(content.binary, 'base64').length };
    shownKey = 'binary';
  } else {
    preview = { state: 'unavailable' };
  }
  const rest = without(content, new Set(shownKey ? [shownKey] : []));
  if (Object.keys(rest).length > 0) preview.otherContent = rest;
  return preview;
}

// ---------------------------------------------------------------------------
// View construction

/** Mutable accumulation for one inspection: warnings and preview counts. */
function newState(limits: IInspectionLimits): IInspectionState {
  return { limits, diagnostics: [], truncatedPreviews: 0 };
}

function warn(state: IInspectionState, pointer: string, message: string): void {
  state.diagnostics.push({ severity: 'warning', message, pointer });
}

/** Message properties presented by named message-view fields; others go to its otherContent. */
const NAMED_MESSAGE_KEYS = new Set(['text', 'markdown', 'id', 'arguments']);

/**
 * A message's content for the view: `{ id?, text?, markdown?, arguments?,
 * resolved, otherContent? }`.
 * - Text and Markdown alternatives are both kept.
 * - `arguments` are kept whenever resolution left them unused (unknown id or
 *   a missing placeholder), so nothing the producer supplied is lost.
 * - Message metadata such as `properties` goes to otherContent.
 * An unresolved message is warned about.
 */
function messageView(
  message: IMessageInput,
  rule: ISarifReportingDescriptor | undefined,
  component: ISarifToolComponent,
  pointer: string,
  state: IInspectionState,
): IInspectionMessage {
  const resolved = resolveMessage(message, rule, component);
  const { missingArgument, ...content } = resolved;
  const view: Mutable<IInspectionMessage> = content;
  if (!resolved.resolved && Array.isArray(message.arguments)) view.arguments = message.arguments;
  const rest = without(message, NAMED_MESSAGE_KEYS);
  if (Object.keys(rest).length > 0) view.otherContent = rest;
  if (!resolved.resolved) {
    warn(state, pointer, missingArgument !== undefined
      ? `The message needs argument {${String(missingArgument)}}, which was not supplied; its template is shown unsubstituted.`
      : `Message id \`${String(message.id)}\` is not defined by the rule or its tool component, so its text is unavailable.`);
  }
  return view;
}

/** One resolved path for an artifact reference; an unresolved path is `null` with a warning. */
function pathOf(artifactLocation: IArtifactLocationInput, run: IRunInput, pointer: string, state: IInspectionState): ArtifactPathResolution {
  const resolved = resolveArtifactPath(artifactLocation, run, { sourceRootUri: state.limits.sourceRootUri });
  if (resolved.error) {
    warn(state, pointer, `The artifact reference could not be resolved to a repository path (${resolved.error[0]}): ${resolved.error[1]}`);
  }
  return resolved;
}

/** The repository path of a resolution, or `null` when it names none (a resolution has a path exactly when it has no error). */
function pathOrNull(resolved: ArtifactPathResolution): string | null {
  return resolved.error ? null : resolved.path;
}

/**
 * Whether a message view is fully captured by its plain text string: resolved
 * text with no Markdown, id, arguments or metadata. Only then may a location
 * message or fix description be shown as a string alone. Otherwise the full
 * content object accompanies the string (`messageContent`,
 * `descriptionContent`).
 */
function plainText(message: IInspectionMessage): boolean {
  return message.resolved && Object.keys(message).every((key) => key === 'text' || key === 'resolved');
}

/**
 * A location (SARIF 3.28) as a LocationView.
 *
 * Named fields: path, reference, line/column/offset coordinates, snippet
 * text, message and logical locations. Every other location, physical
 * location and region property is kept under `otherContent`.
 */
function locationView(location: ILocationInput, run: IRunInput, finding: IFindingContext, pointer: string, state: IInspectionState): IInspectionLocation {
  let view: Mutable<IInspectionLocation>;
  const physical = location.physicalLocation;
  if (physical && physical.artifactLocation) {
    const resolved = pathOf(physical.artifactLocation, run, pointer, state);
    view = { path: pathOrNull(resolved), artifactLocation: physical.artifactLocation };
    if (resolved.uri !== undefined) view.uri = resolved.uri;
    if (resolved.uriBaseId !== undefined) view.uriBaseId = resolved.uriBaseId;
  } else {
    view = { path: null };
  }
  const region = physical && physical.region;
  const other: Evidence = {};
  if (region) {
    for (const key of NAMED_REGION_KEYS) if (region[key] !== undefined) view[key] = region[key];
    const regionRest = without(region, new Set(NAMED_REGION_KEYS));
    // regionRest.snippet is region.snippet: `without` copies values, not objects.
    const { snippet } = region;
    if (snippet && typeof snippet.text === 'string' && Object.keys(snippet).length === 1) {
      view.snippet = snippet.text;
      delete regionRest['snippet'];
    }
    if (Object.keys(regionRest).length > 0) other['region'] = regionRest;
  }
  if (location.message !== undefined) {
    const message = messageView(location.message, finding.rule, finding.component, `${pointer}/message`, state);
    const text = message.text !== undefined ? message.text : message.markdown;
    if (text !== undefined) view.message = text;
    if (!plainText(message)) view.messageContent = message;
  }
  if (location.logicalLocations !== undefined) view.logical = location.logicalLocations;
  if (physical) {
    const physicalRest = without(physical, new Set(['artifactLocation', 'region']));
    if (Object.keys(physicalRest).length > 0) other['physicalLocation'] = physicalRest;
  }
  const locationRest = without(location, new Set(['physicalLocation', 'message', 'logicalLocations']));
  if (Object.keys(locationRest).length > 0) other['location'] = locationRest;
  if (Object.keys(other).length > 0) view.otherContent = other;
  return view;
}

/**
 * A SARIF fix (3.55) with every artifact change and replacement. Deleted
 * regions are kept raw; inserted content is previewed.
 */
function fixView(fix: IFixInput, run: IRunInput, finding: IFindingContext, pointer: string, state: IInspectionState): IInspectionFix {
  const described: Mutable<Pick<IInspectionFix, 'description' | 'descriptionContent'>> = {};
  if (fix.description !== undefined) {
    const message = messageView(fix.description, finding.rule, finding.component, `${pointer}/description`, state);
    const text = message.text !== undefined ? message.text : message.markdown;
    if (text !== undefined) described.description = text;
    if (!plainText(message)) described.descriptionContent = message;
  }
  const view: Mutable<IInspectionFix> = {
    ref: pointer,
    ...described,
    changes: fix.artifactChanges.map((change, c) => {
      const changePointer = `${pointer}/artifactChanges/${String(c)}`;
      const resolved = pathOf(change.artifactLocation, run, changePointer, state);
      const changeView: Mutable<IInspectionArtifactChange> = {
        path: pathOrNull(resolved),
        uri: resolved.uri !== undefined ? resolved.uri : (change.artifactLocation.uri || ''),
        artifactLocation: change.artifactLocation,
        replacements: change.replacements.map((replacement) => {
          const replacementView: Mutable<IInspectionReplacement> = {
            deletedRegion: replacement.deletedRegion,
            inserted: previewContent(replacement.insertedContent, state.limits, state),
          };
          const rest = without(replacement, new Set(['deletedRegion', 'insertedContent']));
          if (Object.keys(rest).length > 0) replacementView.otherContent = rest;
          return replacementView;
        }),
      };
      const rest = without(change, new Set(['artifactLocation', 'replacements']));
      if (Object.keys(rest).length > 0) changeView.otherContent = rest;
      return changeView;
    }),
  };
  const rest = without(fix, new Set(['description', 'artifactChanges']));
  if (Object.keys(rest).length > 0) view.otherContent = rest;
  return view;
}

/**
 * The owned whole-file proposals of a result (D23: `properties.sarifToComment
 * .proposedFileChanges`), each with its artifact's path and a content
 * preview. Unknown operations and fields are shown verbatim.
 */
function fileProposalViews(result: IResultInput, run: IRunInput, ref: string, state: IInspectionState): IInspectionFileProposal[] {
  const owned = result.properties && result.properties['sarifToComment'];
  if (!isPlainObject(owned) || owned['proposedFileChanges'] === undefined) return [];
  const base = `${ref}/properties/sarifToComment/proposedFileChanges`;
  const proposed = owned['proposedFileChanges'];
  if (!Array.isArray(proposed)) {
    warn(state, base, 'proposedFileChanges is not a list of operations; it is kept verbatim in the finding\'s other content.');
    return [];
  }
  const operations: readonly unknown[] = proposed;
  return operations.map((operation, k): IInspectionFileProposal => {
    const pointer = `${base}/${String(k)}`;
    if (!isPlainObject(operation)) {
      warn(state, pointer, 'This proposed file change is not an object; it is shown verbatim.');
      return { ref: pointer, operation: null, path: null, otherContent: { value: operation } };
    }
    const name = operation['operation'];
    if (typeof name !== 'string' || !KNOWN_FILE_OPERATIONS.has(name)) {
      warn(state, pointer, `Unknown proposed file operation ${JSON.stringify(name)}; it is shown verbatim.`);
    }
    const artifactIndex = operation['artifactIndex'];
    const artifact = typeof artifactIndex === 'number' && Number.isInteger(artifactIndex) ? (run.artifacts || [])[artifactIndex] : undefined;
    let path: string | null;
    if (artifact && artifact.location) {
      path = pathOrNull(pathOf(artifact.location, run, pointer, state));
    } else {
      path = null;
      warn(state, pointer, 'The proposal names no artifact with a location, so its file is unknown.');
    }
    const view: Mutable<IInspectionFileProposal> = {
      ref: pointer,
      operation: name,
      ...(artifactIndex !== undefined ? { artifactIndex } : {}),
      path,
    };
    const fileMode = operation['fileMode'];
    if (fileMode !== undefined) view.fileMode = fileMode;
    if (artifact && artifact.contents !== undefined) view.content = previewContent(artifact.contents, state.limits, state);
    const rest = without(operation, new Set(['operation', 'artifactIndex', 'fileMode']));
    if (Object.keys(rest).length > 0) view.otherContent = rest;
    return view;
  });
}

/** The declared approval state in an owned property bag, if any (shown as declared, never verified). */
function approvalOf(properties: IPlainObject | undefined): string | undefined {
  return ownedString(properties, 'approval');
}

/** A string an owned property bag declares under `key`, if any (shown as written). */
function ownedString(properties: IPlainObject | undefined, key: 'approval' | 'suggestionGroup'): string | undefined {
  const owned = properties && properties['sarifToComment'];
  const value = isPlainObject(owned) ? owned[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/**
 * The level a rule's default configuration declares, if any. The shared
 * rule view does not name `defaultConfiguration`, so it is read as a
 * property; in schema-valid SARIF it is a reportingConfiguration object
 * whose `level` is a string.
 */
function defaultLevel(rule: ISarifReportingDescriptor | undefined): string | undefined {
  const configuration = rule && 'defaultConfiguration' in rule ? rule.defaultConfiguration : undefined;
  if (!isPlainObject(configuration)) return undefined;
  const level = configuration['level'];
  return typeof level === 'string' ? level : undefined;
}

function findingView(
  result: IResultInput, run: IRunInput, runIndex: number, resultIndex: number, digest: string, state: IInspectionState,
): IInspectionFinding {
  const ref = `/runs/${String(runIndex)}/results/${String(resultIndex)}`;
  const reference = resolveRule(result, run);
  if (reference.error) warn(state, ref, `The rule reference could not be resolved (${reference.error[0]}): ${reference.error[1]}`);
  // An unresolved reference names no rule, so its messages read from the driver.
  const finding: IFindingContext = reference.error
    ? { rule: undefined, component: run.tool.driver }
    : { rule: reference.rule, component: reference.component };

  const ruleId = result.ruleId !== undefined ? result.ruleId
    : result.rule && result.rule.id !== undefined ? result.rule.id : finding.rule && finding.rule.id;
  const level = result.level !== undefined ? result.level : defaultLevel(finding.rule);
  const approval = approvalOf(result.properties);
  const suggestionGroup = ownedString(result.properties, 'suggestionGroup');
  return {
    ref,
    selector: findingSelector(ref, digest),
    runIndex,
    resultIndex,
    ...(ruleId !== undefined ? { ruleId } : {}),
    ...(level !== undefined ? { level } : {}),
    ...(result.kind !== undefined ? { kind: result.kind } : {}),
    ...(result.baselineState !== undefined ? { baselineState: result.baselineState } : {}),
    ...(approval !== undefined ? { approval } : {}),
    ...(suggestionGroup !== undefined ? { suggestionGroup } : {}),
    message: messageView(result.message, finding.rule, finding.component, `${ref}/message`, state),
    locations: (result.locations || []).map((l, k) => locationView(l, run, finding, `${ref}/locations/${String(k)}`, state)),
    relatedLocations: (result.relatedLocations || []).map((l, k) => locationView(l, run, finding, `${ref}/relatedLocations/${String(k)}`, state)),
    otherContent: without(result, NAMED_RESULT_KEYS),
    fixes: (result.fixes || []).map((fix, k) => fixView(fix, run, finding, `${ref}/fixes/${String(k)}`, state)),
    fileProposals: fileProposalViews(result, run, ref, state),
  };
}

/** Log properties presented elsewhere: the format declaration (checked by validation), runs and external properties. */
const NAMED_LOG_KEYS = new Set(['version', '$schema', 'runs', 'inlineExternalProperties']);

/**
 * Log-level evidence (SARIF 3.13) outside runs, such as log `properties`.
 * Returns `{ otherContent }`, or undefined when the log holds none, so an
 * ordinary log's view is unchanged. `version` and `$schema` are the format
 * declaration already checked by schema validation.
 */
function logView(log: IInspectableLog): { readonly otherContent: Evidence } | undefined {
  const rest = without(log, NAMED_LOG_KEYS);
  return Object.keys(rest).length > 0 ? { otherContent: rest } : undefined;
}

/**
 * Inline external properties (SARIF 3.13.5, 3.15), kept verbatim as
 * `{ ref, results, content }`; `results` counts the results they embed.
 * Embedded results are not merged into run findings. Their full content,
 * including any declared runGuid association, is retained, counted in
 * `summary.externalFindings`, and warned about so nothing implies they are
 * absent. Returns undefined when the log has none.
 */
function externalPropertiesViews(log: IInspectableLog, state: IInspectionState): IInspectionExternalProperties[] | undefined {
  if (log.inlineExternalProperties === undefined) return undefined;
  return log.inlineExternalProperties.map((content, i) => {
    const ref = `/inlineExternalProperties/${String(i)}`;
    const results = Array.isArray(content.results) ? content.results.length : 0;
    if (results > 0) {
      warn(state, ref, `${String(results)} result(s) embedded in inline external properties are shown verbatim: inspection does not merge `
        + 'embedded external properties into run findings. Any declared runGuid is retained in the verbatim content.');
    }
    return { ref, results, content };
  });
}

function runView(run: IRunInput, index: number): IInspectionRun {
  const { driver } = run.tool;
  const version = driver.version !== undefined ? driver.version : driver.semanticVersion;
  const provenance = run.versionControlProvenance || [];
  const approval = approvalOf(run.properties);
  return {
    index,
    ref: `/runs/${String(index)}`,
    tool: version === undefined ? { name: driver.name } : { name: driver.name, version },
    source: { state: provenance.length > 0 ? 'declared' : 'unbound', provenance },
    ...(run.columnKind !== undefined ? { columnKind: run.columnKind } : {}),
    ...(approval !== undefined ? { approval } : {}),
    otherContent: without(run, NAMED_RUN_KEYS),
  };
}

/**
 * Whether a captured document that validateSarif has just accepted has the
 * shape inspection reads. This is the module's one unchecked boundary: it
 * confirms the top level (an object with a `runs` array) and relies on the
 * SARIF 2.1.0 schema, which ajv has enforced, for the rest of
 * {@link IInspectableLog}: the types of every run, result, location, fix
 * and content field inspection names.
 */
function isInspectableLog(captured: unknown): captured is IInspectableLog {
  return isPlainObject(captured) && Array.isArray(captured['runs']);
}

/**
 * Shows every finding, location and fix in a SARIF document, from any
 * producer, without changing or judging it.
 *
 * @remarks
 * Messages are never shortened; only fix previews are, and visibly. No
 * source, Git repository or host is contacted, so deleted source text is not
 * shown, and inspection says nothing about whether the document can be
 * published.
 *
 * @param sarif - A SARIF log as a parsed JSON object.
 * @param options - Preview limits and the producer's source root.
 * @returns `inspected` with the view, or `invalid` for input that is not
 * schema-valid SARIF.
 * @throws `TypeError` for non-JSON input or malformed options.
 *
 * @public
 */
export function inspectSarif(sarif: object, options?: IInspectSarifOptions): InspectSarifOutcome {
  return inspectSarifWithUntypedInput(sarif, options);
}

/**
 * Inspects SARIF without changing or judging it (contract §3.3).
 *
 * Both arguments are validated at run time, since JavaScript callers can pass
 * anything. The public {@link inspectSarif} calls this with its
 * documented parameter types; the CLI calls it directly, because it
 * passes parsed file content that only this validation judges.
 *
 * @param sarif - a parsed SARIF log
 * @param options - `{ previewLines?, previewChars?, sourceRootUri? }`; a
 *   preview bound is a positive whole number, or null for unlimited
 * @returns `{ status: 'inspected', view }` or `{ status: 'invalid', problems, markdown }`
 * @throws TypeError on non-JSON SARIF or malformed options
 */
function inspectSarifWithUntypedInput(sarif: unknown, options?: IInspectSarifOptions): InspectSarifOutcome {
  const input: unknown = sarif;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw misuse('sarif must be a parsed SARIF object, not serialized text');
  }
  const json = captureJson(input, 'sarif');
  const captured: unknown = json;
  const limits = checkOptions(options);
  const invalid = validateSarif(captured);
  if (invalid) return invalid;
  if (!isInspectableLog(captured)) throw new Error('Internal error: a schema-valid SARIF log has no runs array.');

  const digest = documentDigest(json);
  const state = newState(limits);
  const runs = captured.runs.map((run, i) => runView(run, i));
  const findings: IInspectionFinding[] = [];
  captured.runs.forEach((run, runIndex) => {
    (run.results || []).forEach((result, resultIndex) => findings.push(findingView(result, run, runIndex, resultIndex, digest, state)));
  });
  const count = (key: 'fixes' | 'fileProposals'): number => findings.reduce((n, f) => n + f[key].length, 0);
  const log = logView(captured);
  const externalProperties = externalPropertiesViews(captured, state);
  captured.runs.forEach((run, i) => {
    if (run.externalPropertyFileReferences !== undefined) {
      warn(state, `/runs/${String(i)}/externalPropertyFileReferences`, 'The run references external property files. Inspection never loads '
        + 'them, so content they hold (possibly results) is not shown; the references themselves are kept in the run\'s other content.');
    }
  });
  const summary: ISarifInspection['summary'] = { runs: runs.length, findings: findings.length, fixes: count('fixes'), fileProposals: count('fileProposals'),
    truncatedPreviews: state.truncatedPreviews,
    ...(externalProperties ? { externalFindings: externalProperties.reduce((n, e) => n + e.results, 0) } : {}) };
  const view: ISarifInspection = {
    format: VIEW_FORMAT,
    version: VIEW_VERSION,
    summary,
    ...(log ? { log } : {}),
    ...(externalProperties ? { externalProperties } : {}),
    runs,
    findings,
    diagnostics: state.diagnostics,
  };
  return { status: 'inspected', view };
}

// ---------------------------------------------------------------------------
// Human rendering (a projection of the view; no independent traversal)
//
// Every piece of evidence in the view appears in the human text; human and
// JSON output differ only in presentation. Named facts are rendered as
// labelled lines. Evidence without a named field of its own (otherContent,
// extra reference or provenance fields, message metadata) is rendered as
// indented JSON under a label. That is the evidence itself, not a key list
// and not a re-dump of the whole SARIF, since named fields are never
// repeated there.

/**
 * A producer-written JSON value in human text, exactly as a template literal
 * shows it: strings as they are, anything else by its default string
 * conversion (so an object reads "[object Object]" and an array its
 * comma-joined items). Used where the view holds values as written, whatever
 * JSON they are: proposal operations, artifact indexes and file modes,
 * logical-location names, and provenance fields.
 */
function asWritten(value: unknown): string {
  // JSON holds no symbols, so String() is exactly template-literal conversion.
  return String(value);
}

function toolLabel(tool: IInspectionRun['tool']): string {
  return tool.version === undefined ? tool.name : `${tool.name} ${tool.version}`;
}

/** A labelled, indented JSON block for evidence with no named rendering. */
function jsonBlock(label: string, value: unknown, indent: string): string[] {
  const body = JSON.stringify(value, null, 2).split('\n').map((line) => `${indent}  ${line}`);
  return [`${indent}${label}:`, ...body];
}

/** Indents every line of a multi-line text. */
function indentText(text: string, indent: string): string[] {
  return text.split('\n').map((line) => `${indent}${line}`);
}

/**
 * The lines for a message view: its text, any distinct Markdown alternative,
 * an unresolved id with its unused arguments, and message metadata.
 */
function messageLines(message: IInspectionMessage, label: string, indent: string): string[] {
  const lines: string[] = [];
  const text = message.text !== undefined ? message.text : message.markdown;
  if (text !== undefined) {
    lines.push(`${indent}${label}:`, ...indentText(text, indent));
  } else {
    lines.push(`${indent}${label}: (unresolved message id ${JSON.stringify(message.id)})`);
  }
  if (message.markdown !== undefined && message.text !== undefined && message.markdown !== message.text) {
    lines.push(`${indent}${label} (Markdown):`, ...indentText(message.markdown, indent));
  }
  if (message.id !== undefined && text !== undefined) lines.push(`${indent}${label} id: ${JSON.stringify(message.id)}`);
  if (!message.resolved) {
    lines.push(`${indent}${label} is unresolved${message.arguments ? `; arguments supplied: ${JSON.stringify(message.arguments)}` : ''}`);
  }
  if (message.otherContent !== undefined) lines.push(...jsonBlock(`${label} metadata`, message.otherContent, indent));
  return lines;
}

/** Whether an artifact reference says more than its resolved path. */
function referenceAddsDetail(path: string | null, artifactLocation: object | undefined): boolean {
  if (!artifactLocation) return false;
  const keys = Object.keys(artifactLocation);
  return !(path !== null && keys.length === 1 && read(artifactLocation, 'uri') === path);
}

function locationHeading(location: IInspectionLocation): string {
  let label = location.path !== null ? location.path : '(unresolved path)';
  if (location.startLine !== undefined) {
    label += `:${String(location.startLine)}`;
    if (location.endLine !== undefined && location.endLine !== location.startLine) label += `-${String(location.endLine)}`;
  }
  if (location.startColumn !== undefined || location.endColumn !== undefined) {
    label += ` (columns ${String(location.startColumn ?? 1)}-${String(location.endColumn ?? 'end')})`;
  }
  if (location.charOffset !== undefined) label += ` (characters ${String(location.charOffset)}+${String(location.charLength ?? 0)})`;
  if (location.snippet !== undefined) label += ` snippet ${JSON.stringify(location.snippet)}`;
  if (location.message !== undefined && location.messageContent === undefined) label += ` — ${location.message}`;
  return label;
}

/** A logical location with every field: its name, then each remaining property. */
function logicalLabel(logical: object): string {
  const name = read(logical, 'fullyQualifiedName') || read(logical, 'name') || read(logical, 'decoratedName') || '(unnamed)';
  const shownKey = read(logical, 'fullyQualifiedName') ? 'fullyQualifiedName' : read(logical, 'name') ? 'name' : 'decoratedName';
  const rest = Object.entries(logical)
    .filter(([key]) => key !== shownKey)
    .map(([key, value]: [string, unknown]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return rest.length === 0 ? asWritten(name) : `${asWritten(name)} (${rest.join('; ')})`;
}

function locationLines(location: IInspectionLocation, indent: string): string[] {
  const lines = [`${indent}${locationHeading(location)}`];
  const inner = `${indent}    `;
  if (referenceAddsDetail(location.path, location.artifactLocation)) {
    lines.push(`${inner}reference: ${JSON.stringify(location.artifactLocation)}`);
  }
  if (location.messageContent !== undefined) lines.push(...messageLines(location.messageContent, 'Location message', inner));
  for (const logical of location.logical || []) lines.push(`${inner}logical: ${logicalLabel(logical)}`);
  if (location.otherContent !== undefined) lines.push(...jsonBlock('Other location evidence', location.otherContent, inner));
  return lines;
}

/** Whether a preview carries its text and every count, as every non-binary preview inspectSarif produces does. */
function isTextPreview(preview: IInspectionPreview): preview is ITextPreview {
  return preview.text !== undefined && preview.totalLines !== undefined && preview.totalChars !== undefined
    && preview.shownLines !== undefined && preview.shownChars !== undefined;
}

/** Preview lines, prefixed so they are distinguishable from surrounding text, plus explicit truncation markers. */
function previewLines(preview: IInspectionPreview, indent: string): string[] {
  const other = preview.otherContent === undefined ? [] : jsonBlock('Other content evidence', preview.otherContent, indent);
  if (preview.state === 'unavailable') {
    return [`${indent}(binary content${preview.byteLength === undefined ? '' : `, ${String(preview.byteLength)} bytes`}, not shown)`, ...other];
  }
  if (!isTextPreview(preview)) throw new Error('Internal error: a text preview lacks its text or counts.');
  if (preview.totalChars === 0) return [`${indent}(empty)`, ...other];
  const out = preview.text.replace(/\n$/, '').split('\n').map((line) => `${indent}| ${line}`);
  if (preview.state === 'truncated') {
    out.push(preview.shownLines < preview.totalLines
      ? `${indent}(truncated: ${String(preview.shownLines)} of ${String(preview.totalLines)} lines shown)`
      : `${indent}(truncated: ${String(preview.shownChars)} of ${String(preview.totalChars)} characters shown)`);
  }
  return [...out, ...other];
}

function fixLines(fix: IInspectionFix, k: number, total: number): string[] {
  const lines = [`Fix ${String(k + 1)} of ${String(total)} (${fix.ref})${fix.description === undefined || fix.descriptionContent !== undefined ? '' : `: ${fix.description}`}`];
  if (fix.descriptionContent !== undefined) lines.push(...messageLines(fix.descriptionContent, 'Fix description', '  '));
  for (const change of fix.changes) {
    lines.push(`  Change ${change.path !== null ? change.path : '(unresolved path)'}`);
    if (referenceAddsDetail(change.path, change.artifactLocation)) lines.push(`    reference: ${JSON.stringify(change.artifactLocation)}`);
    for (const replacement of change.replacements) {
      lines.push(`    Replace region ${JSON.stringify(replacement.deletedRegion)} with:`);
      lines.push(...previewLines(replacement.inserted, '      '));
      if (replacement.otherContent !== undefined) lines.push(...jsonBlock('Other replacement evidence', replacement.otherContent, '      '));
    }
    if (change.otherContent !== undefined) lines.push(...jsonBlock('Other change evidence', change.otherContent, '    '));
  }
  if (fix.otherContent !== undefined) lines.push(...jsonBlock('Other fix evidence', fix.otherContent, '  '));
  return lines;
}

function proposalLines(proposal: IInspectionFileProposal): string[] {
  const lines = [`File proposal (${proposal.ref}): ${proposal.operation === null ? '(not an operation)' : asWritten(proposal.operation)} `
    + (proposal.path !== null ? proposal.path : '(unknown file)')
    + (proposal.artifactIndex === undefined ? '' : ` [artifact ${asWritten(proposal.artifactIndex)}]`)
    + (proposal.fileMode === undefined ? '' : ` (mode ${asWritten(proposal.fileMode)})`)];
  if (proposal.content !== undefined) lines.push(...previewLines(proposal.content, '    '));
  if (proposal.otherContent !== undefined) lines.push(...jsonBlock('Other proposal details', proposal.otherContent, '  '));
  return lines;
}

function runLines(run: IInspectionRun): string[] {
  const facts = [`source: ${run.source.state}`];
  if (run.columnKind !== undefined) facts.push(`columnKind: ${run.columnKind}`);
  if (run.approval !== undefined) facts.push(`approval: ${run.approval}`);
  const lines = [`Run ${String(run.index)} (${run.ref}): ${toolLabel(run.tool)} (${facts.join('; ')})`];
  for (const entry of run.source.provenance) {
    const plain = Object.keys(entry).every((key) => key === 'repositoryUri' || key === 'revisionId');
    const revisionId = read(entry, 'revisionId');
    lines.push(plain ? `  declared source: ${asWritten(read(entry, 'repositoryUri'))}${revisionId ? ` at ${asWritten(revisionId)}` : ''}`
      : `  declared source: ${JSON.stringify(entry)}`);
  }
  if (Object.keys(run.otherContent).length > 0) lines.push(...jsonBlock('Other run content', run.otherContent, '  '));
  return lines;
}

function findingLines(finding: IInspectionFinding, view: ISarifInspection): string[] {
  const run = view.runs[finding.runIndex];
  if (run === undefined) throw new Error(`Internal error: finding ${finding.ref} names run ${String(finding.runIndex)}, which the view does not have.`);
  const facts = [toolLabel(run.tool)];
  if (finding.ruleId !== undefined) facts.push(`rule ${finding.ruleId}`);
  for (const key of ['level', 'kind', 'baselineState', 'approval', 'suggestionGroup'] as const) {
    const value = finding[key];
    if (value !== undefined) facts.push(`${key}: ${value}`);
  }
  const lines = ['', `Finding ${finding.ref} — ${facts.join(' · ')}`, `Selector: ${finding.selector}`];
  lines.push(...messageLines(finding.message, 'Message', ''));
  lines.push(finding.locations.length === 0 ? 'Location: general' : 'Locations:');
  for (const location of finding.locations) lines.push(...locationLines(location, '  '));
  if (finding.relatedLocations.length > 0) {
    lines.push('Related locations:');
    for (const location of finding.relatedLocations) lines.push(...locationLines(location, '  '));
  }
  finding.fixes.forEach((fix, k) => lines.push(...fixLines(fix, k, finding.fixes.length)));
  for (const proposal of finding.fileProposals) lines.push(...proposalLines(proposal));
  if (Object.keys(finding.otherContent).length > 0) lines.push(...jsonBlock('Other finding evidence', finding.otherContent, ''));
  return lines;
}

/**
 * Renders an inspection view as plain human-readable text: every run with
 * its declared source and other content, and every finding with its full
 * message (and alternatives), locations (or "general"), fixes and proposals.
 * Previews carry explicit truncation markers, and all remaining evidence
 * appears as labelled JSON. No readiness is claimed.
 *
 * @param view - the `view` from inspectSarif
 */
function renderInspectionText(view: ISarifInspection): string {
  const { summary } = view;
  const lines = [`SARIF inspection: ${String(summary.runs)} run(s), ${String(summary.findings)} finding(s), ${String(summary.fixes)} fix(es), `
    + `${String(summary.fileProposals)} file proposal(s), ${String(summary.truncatedPreviews)} truncated preview(s)`
    + `${summary.externalFindings === undefined ? '' : `, ${String(summary.externalFindings)} embedded finding(s) in inline external properties (shown verbatim below, not as findings)`}.`];
  if (view.log !== undefined) lines.push(...jsonBlock('Log-level content', view.log.otherContent, ''));
  for (const external of view.externalProperties || []) {
    lines.push(...jsonBlock(`Inline external properties ${external.ref} (${String(external.results)} embedded result(s))`, external.content, ''));
  }
  for (const run of view.runs) lines.push(...runLines(run));
  for (const finding of view.findings) lines.push(...findingLines(finding, view));
  if (view.diagnostics.length > 0) {
    lines.push('', 'Warnings:');
    for (const d of view.diagnostics) lines.push(`  ${d.pointer}: ${d.message}`);
  }
  lines.push('', 'This inspection only describes the SARIF; it does not check whether it can be published.');
  return `${lines.join('\n')}\n`;
}

export { renderInspectionText, inspectSarifWithUntypedInput };
