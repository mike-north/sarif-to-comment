/**
 * Whole-review preparation from ready SARIF (private internal module).
 *
 * Turns one in-memory SARIF 2.1.0 document into the complete contents of one
 * draft review — the general body and every inline comment — or blocks the
 * whole review with actionable Markdown diagnostics. Nothing is written
 * anywhere: publication (a separate module) sends the prepared review in one
 * create request. Preparation is all-or-nothing (P3, D12): any invalid,
 * inconsistent, unsupported-but-meaningful or held item blocks the entire
 * review, and no finding is silently dropped.
 *
 * ---------------------------------------------------------------------------
 * prepareReview(input, internals?) -> Promise<Outcome>
 *
 * input:
 *   sarif:   object  // parsed SARIF log, validated against the official 2.1.0
 *                    // errata01 schema (formats enforced)
 *   context: {       // trusted, authoritative review context (from transport)
 *     owner, repo: string, pullNumber: number,
 *     reviewedCommit: string,  // full 40-hex; the review's commit and the
 *                              // default source revision
 *     diff: { baseCommit, headCommit, files },  // placement diff contract for
 *                              // the pull request's current diff. Inline
 *                              // anchors exist only when headCommit equals
 *                              // reviewedCommit; an earlier reviewedCommit
 *                              // yields exact historical general feedback.
 *     sourceRootUri?: string,  // absolute file: URI of the repository root in
 *                              // the producer's filesystem, ending in "/";
 *                              // read-only path interpretation only
 *   }
 *   readSource: async (commit, path) => string | null
 *                    // trusted snapshot boundary: exact file text of a
 *                    // repository-relative normalized path at a full commit,
 *                    // or null when the file does not exist there. Called only
 *                    // with the reviewed commit, the verified diff base, or a
 *                    // repository-validated provenance revision, and only with
 *                    // paths that resolved inside the repository. A thrown
 *                    // error is operational and propagates unchanged.
 *   options?: {
 *     ignoreApprovalHold?: boolean,   // bypasses only an approval hold
 *     maxComments?: number,           // default 100 inline comments
 *     maxCommentBodyChars?: number,   // default 60000 UTF-16 units per comment
 *                                     // body and for the review body
 *     maxPayloadBytes?: number,       // default 1,000,000 bytes of UTF-8 JSON
 *                                     // of { body, comments }
 *   }
 *   The defaults are conservative product limits, not verified host maxima.
 *   Exceeding one blocks; nothing is truncated or split.
 *
 * internals (private test seam, not caller API):
 *   applyReplacement: replacement-module boundary used for fixes (defaults to
 *     src/replacements.cjs). Source-region coordinates always use the
 *     production replacement module so feedback and fixes share one reading
 *     of SARIF regions.
 *
 * Outcome:
 *   { status: 'ready',
 *     review: { commitId, body, comments: Comment[] },
 *       Comment: { path, side, line, startSide?, startLine?, body }
 *       (the preparedReview shape accepted by publication)
 *     evidence: Evidence[],   // one per SARIF result, in SARIF order
 *     warnings: Diagnostic[], markdown: string }
 *   { status: 'blocked', diagnostics: Diagnostic[], warnings: Diagnostic[], markdown: string }
 *
 *   Diagnostic: { code, pointer?, message }  pointer is a JSON Pointer into the
 *     SARIF log (e.g. "/runs/0/results/3"); codes are private, not a frozen
 *     public schema (D13). `markdown` lists every diagnostic with its pointer.
 *   Evidence: { pointer, treatment: 'inline'|'suggestion'|'general',
 *     commentIndex? | bodySectionIndex?, source?: { commit, path, startLine?,
 *     endLine?, text? } (always the result's own location), anchor?,
 *     fixSource?, replacement?: { startLine, endLine, originalText,
 *     replacementText } (exact replacement-module output), suggestionPayload?,
 *     attribution: { tool, version?, component?: { name, version? }, ruleId? },
 *     taxa? (retained, not rendered),
 *     approval: 'none'|'declared-ready'|'hold-overridden',
 *     uninterpretedProperties? }
 *
 * Caller misuse (non-object SARIF, malformed context, non-function
 * readSource, malformed options) rejects with TypeError; SARIF content
 * problems are diagnostics.
 *
 * ---------------------------------------------------------------------------
 * Support profile (first milestone)
 *
 * - Results with no location become general body feedback. A result's one
 *   physical location is placed through src/placement.cjs: inline when a
 *   faithful anchor on the reviewed commit exists, otherwise a general body
 *   section with an exact permalink and a literal source fence. A location
 *   without a region is whole-file general feedback.
 * - Regions follow SARIF 3.30 exactly as src/replacements.cjs reads them
 *   (columns, charOffset, BOM exclusion, coordinate agreement). columnKind has
 *   no default: without it a region is accepted only when both SARIF units
 *   denote the same text. A region snippet must equal the region's text.
 * - Source revision: the reviewed commit by default; a run's
 *   versionControlProvenance revisionId applies only when its repositoryUri
 *   names this GitHub repository. A revision equal to the diff base is
 *   base-side source; any other revision is pinned historical source.
 * - URIs: repository-relative references; uriBaseId chains through
 *   originalUriBaseIds; bases and absolute file: URIs only under a known
 *   repository root (context.sourceRootUri or the matching provenance
 *   mappedTo). Traversal, encoded separators, queries, fragments, other
 *   schemes, unresolved bases and index/uri conflicts block. No URI is ever
 *   read; only the resolved repository path reaches readSource.
 * - Messages: markdown preferred over text; plain text is escaped so it
 *   renders literally; message.id resolves from the rule's messageStrings,
 *   then the globalMessageStrings of the component defining the rule (the
 *   driver unless result.rule.toolComponent names an extension). SARIF {n}
 *   arguments and {{ }}
 *   apply to direct and resolved strings alike (arguments are literal text).
 *   Producer Markdown may contain balanced ordinary code fences, but never a
 *   line that could open a suggestion block and never an unclosed fence:
 *   only a validated SARIF fix creates a native suggestion.
 * - Fixes: at most one fix per result with one artifactChange and one text
 *   replacement on the reviewed head, which must be the diff head. A located
 *   result's own lines must lie within its replacement lines; otherwise the
 *   association is unsupported and blocks (feedback is never moved to a fix
 *   location, and the replacement is never enlarged). Results with identical
 *   replacements share one suggestion comment and keep every explanation and
 *   origin; overlapping different replacements block. The suggestion payload
 *   is emitted only when GitHub's observed application reproduces the exact
 *   intended file (see suggestionPayload); suggestions outside the inline
 *   diff are unsupported.
 * - Rules may live in tool extensions: result.rule.toolComponent (index, guid
 *   or name) selects the component, whose identity is kept in attribution.
 *   Unresolvable components block. Result taxa are kept in evidence with a
 *   warning.
 * - Coordinates are read only under SARIF's default newline sequences; a run
 *   declaring others blocks its located results and fixes.
 * - External property files and inline external properties are not loaded;
 *   their presence blocks the whole review so no finding is lost.
 * - Explicitly unsupported (blocking): multiple locations, logical-only
 *   locations, related locations, code flows, graphs, stacks, attachments,
 *   suppressions, alternative fixes, multi-file or multi-replacement fixes,
 *   binary replacements, nested artifacts, sarifToComment.proposedFileChanges.
 * - Owned namespace properties.sarifToComment on runs and results: `approval`
 *   ('awaiting-approval' holds; 'ready' is a declared, unverified state) and,
 *   on results, `proposedFileChanges`; any other key or value blocks. Other
 *   properties are retained in evidence as uninterpreted metadata. Artifacts
 *   with contents and no proposed operation are context, reported as warnings.
 *
 * Rendering:
 *   item      = message [ "\n\n**Fix:** " fix description ] "\n\n<sub>— " attribution "</sub>"
 *   attribution = tool name [ " " version ] [ " · " extension name [ " " version ] ]
 *                 [ " · rule " code span of ruleId ]
 *   comment   = items joined by "\n\n---\n\n" [ "\n\n```suggestion\n" replacementText "```" ]
 *   section   = [ "**Source:** [" path " " lines " at " short commit "](" permalink ")\n\n"
 *                 fence "\n" source text "\n" fence "\n\n" ] item
 *   body      = sections joined by "\n\n---\n\n" ('' when there are none)
 *   Source fences are longer than any backtick run they enclose.
 */

import type { SchemaObject, ValidateFunction } from 'ajv';
import type AjvDraft04Module = require('ajv-draft-04');
import type AjvFormatsModule = require('ajv-formats');
import type { IReviewContext } from './github.cjs';
import { classifyPlacement } from './placement.cjs';
import type { IPlacementSourceRange, PlacementAnchorSide } from './placement.cjs';
import { applyReplacement as productionApplyReplacement } from './replacements.cjs';
import type { ColumnKind, IReplacementRegion, IReplacementRequest, ReplacementDiagnostic, ReplacementOutcome } from './replacements.cjs';
import type {
  ArtifactPathErrorCode,
  IRelativeReference,
  IResolutionFailure,
  IRootedReference,
  ISarifArtifact,
  ISarifArtifactLocation,
  ISarifMessage,
  ISarifMultiformatMessageString,
  ISarifReportingDescriptor,
  ISarifReportingDescriptorReference,
  ISarifResult,
  ISarifRun,
  ISarifTool,
  ISarifToolComponent,
  ISarifToolComponentReference,
  ISarifVersionControlDetails,
  ParsedReference,
} from './sarif-common.cjs';

/**
 * The vendored SARIF 2.1.0 schema. JSON data, so it is `unknown` until
 * {@link isSchemaObject} confirms it is the object ajv compiles.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the vendored JSON schema is data outside the compiled program; require() resolves it one directory above the compiled module, exactly as before
const SARIF_SCHEMA: unknown = require('../vendor/sarif-schema-2.1.0.json');

// ---------------------------------------------------------------------------
// Domain types: the SARIF this module reads
//
// These views describe a log only after it passed the official schema (see
// sarifValidator): every property they name has exactly the type and
// requiredness the SARIF 2.1.0 errata01 schema gives it. They name only what
// preparation reads; anything else in the log is carried along unexamined.

/** SARIF result and notification level (3.27.10, 3.58.6). */
type SarifLevel = 'none' | 'note' | 'warning' | 'error';

/** SARIF result kind (3.27.9). */
type SarifResultKind = 'notApplicable' | 'pass' | 'fail' | 'review' | 'open' | 'informational';

/** SARIF result baseline state (3.27.24). */
type SarifBaselineState = 'new' | 'unchanged' | 'updated' | 'absent';

/** A SARIF property bag (3.8): arbitrary producer data, kept uninterpreted unless owned. */
type SarifPropertyBag = Readonly<Record<string, unknown>>;

/** SARIF artifactContent (3.3): literal text or base64 binary content. */
interface ISarifArtifactContent {
  readonly text?: string;
  readonly binary?: string;
}

/** SARIF region (3.30) as the replacement module reads it, plus its snippet. */
interface ISarifRegion extends IReplacementRegion {
  readonly snippet?: ISarifArtifactContent;
}

/** SARIF physicalLocation (3.29). */
interface ISarifPhysicalLocation {
  readonly artifactLocation?: ISarifArtifactLocation;
  readonly region?: ISarifRegion;
}

/** SARIF location (3.28). Annotations are only counted, never read. */
interface ISarifLocation {
  readonly physicalLocation?: ISarifPhysicalLocation;
  readonly message?: ISarifMessage;
  readonly annotations?: readonly unknown[];
}

/** SARIF replacement (3.57). */
interface ISarifReplacement {
  readonly deletedRegion: ISarifRegion;
  readonly insertedContent?: ISarifArtifactContent;
}

/** SARIF artifactChange (3.56); the schema requires at least one replacement. */
interface ISarifArtifactChange {
  readonly artifactLocation: ISarifArtifactLocation;
  readonly replacements: readonly ISarifReplacement[];
}

/** SARIF fix (3.55); the schema requires at least one artifact change. */
interface ISarifFix {
  readonly description?: ISarifMessage;
  readonly artifactChanges: readonly ISarifArtifactChange[];
}

/**
 * A rule or global message string (3.11.7). The schema requires `text`, so a
 * resolved template always has literal text to fall back on.
 */
interface ISarifMessageString extends ISarifMultiformatMessageString {
  readonly text: string;
}

/** SARIF reportingDescriptor (3.49) as read for messages and default level. */
interface ISarifRule extends ISarifReportingDescriptor {
  readonly messageStrings?: Readonly<Record<string, ISarifMessageString>>;
  readonly defaultConfiguration?: { readonly level?: SarifLevel };
}

/** SARIF toolComponent (3.19): the driver or an extension. */
interface ISarifComponent extends ISarifToolComponent {
  readonly version?: string;
  readonly semanticVersion?: string;
  readonly rules?: readonly ISarifRule[];
  readonly globalMessageStrings?: Readonly<Record<string, ISarifMessageString>>;
}

/** SARIF tool (3.18). */
interface ISarifToolView extends ISarifTool {
  readonly driver: ISarifComponent;
  readonly extensions?: readonly ISarifComponent[];
}

/** SARIF notification (3.58), as read for error-level tool notifications. */
interface ISarifNotification {
  readonly message: ISarifMessage;
  readonly level?: SarifLevel;
}

/** SARIF invocation (3.20). */
interface ISarifInvocation {
  readonly executionSuccessful: boolean;
  readonly toolExecutionNotifications?: readonly ISarifNotification[];
  readonly toolConfigurationNotifications?: readonly ISarifNotification[];
}

/** SARIF versionControlDetails (3.23) with the revision it names. */
interface ISarifProvenance extends ISarifVersionControlDetails {
  readonly revisionId?: string;
}

/** SARIF artifact (3.24) with its (context-only) contents. */
interface ISarifArtifactView extends ISarifArtifact {
  readonly contents?: ISarifArtifactContent;
}

/** Result properties that carry meaning this profile cannot present (see UNSUPPORTED_RESULT_FEATURES). */
type UnsupportedResultFeature =
  | 'codeFlows'
  | 'relatedLocations'
  | 'graphs'
  | 'graphTraversals'
  | 'stacks'
  | 'attachments'
  | 'suppressions';

/** SARIF result (3.27) as preparation reads it. */
interface ISarifResultView extends ISarifResult, Readonly<Partial<Record<UnsupportedResultFeature, readonly unknown[]>>> {
  readonly message: ISarifMessage;
  readonly properties?: SarifPropertyBag;
  readonly locations?: readonly ISarifLocation[];
  readonly baselineState?: SarifBaselineState;
  readonly level?: SarifLevel;
  readonly kind?: SarifResultKind;
  readonly taxa?: readonly ISarifReportingDescriptorReference[];
  readonly fixes?: readonly ISarifFix[];
}

/** SARIF run (3.14) as preparation reads it. */
interface ISarifRunView extends ISarifRun {
  readonly tool: ISarifToolView;
  readonly artifacts?: readonly ISarifArtifactView[];
  readonly versionControlProvenance?: readonly ISarifProvenance[];
  readonly columnKind?: ColumnKind;
  readonly newlineSequences?: readonly string[];
  readonly invocations?: readonly ISarifInvocation[];
  /** Values are one reference (`conversion`) or arrays of them; only their presence matters. */
  readonly externalPropertyFileReferences?: Readonly<Record<string, unknown>>;
  readonly results?: readonly ISarifResultView[];
  readonly properties?: SarifPropertyBag;
}

/** A schema-valid SARIF log (3.13) as preparation reads it. The schema allows `runs: null`. */
interface ISarifLogView {
  readonly runs: readonly ISarifRunView[] | null;
  readonly inlineExternalProperties?: readonly unknown[];
}

// ---------------------------------------------------------------------------
// Domain types: caller input, internals and outcome

/**
 * The trusted review context, as validated at the caller boundary. The
 * identity fields have exactly the review context's shape (src/github.cjs);
 * the diff commits are host-supplied there and only become strings here,
 * after validation. Diff files are checked by the placement module.
 */
interface IPreparationContext extends Pick<IReviewContext, 'owner' | 'repo' | 'pullNumber' | 'reviewedCommit'> {
  readonly diff: {
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly files: readonly unknown[];
  };
  /** Absolute file: URI of the repository root in the producer's filesystem, ending in "/". */
  readonly sourceRootUri?: string | undefined;
}

/**
 * The trusted snapshot boundary. Its answer is checked where it is used:
 * null or undefined means "no such file", any other non-string is misuse.
 * The review context's ReadSource (src/github.cjs) is one.
 */
type SnapshotReader = (commit: string, path: string) => unknown;

/** Caller options; every limit defaults to PRODUCT_LIMITS. */
interface IPrepareReviewOptions {
  readonly ignoreApprovalHold?: boolean | undefined;
  readonly maxComments?: number | undefined;
  readonly maxCommentBodyChars?: number | undefined;
  readonly maxPayloadBytes?: number | undefined;
}

/** The caller input once validateCallerInput accepted it (see the module documentation). */
export interface IPrepareReviewInput {
  /** A parsed SARIF log; the schema is checked inside preparation, not at the boundary. */
  readonly sarif: Readonly<Record<string, unknown>>;
  readonly context: IPreparationContext;
  readonly readSource: SnapshotReader;
  readonly options?: IPrepareReviewOptions | undefined;
}

/** The replacement-module boundary used for fixes. */
type ApplyReplacement = (request: IReplacementRequest) => ReplacementOutcome;

/** The private test seam (see the module documentation); not caller API. */
interface IPrepareReviewInternals {
  readonly applyReplacement?: ApplyReplacement;
}

/** Conservative product limits on one prepared review. */
export interface IProductLimits {
  readonly maxComments: number;
  readonly maxCommentBodyChars: number;
  readonly maxPayloadBytes: number;
}

/**
 * The limits and flags preparation applies. A caller option explicitly set
 * to undefined overrides the default with undefined, which disables that
 * limit; this looseness is kept as it always was.
 */
interface IEffectiveOptions {
  readonly maxComments: number | undefined;
  readonly maxCommentBodyChars: number | undefined;
  readonly maxPayloadBytes: number | undefined;
  readonly ignoreApprovalHold: boolean | undefined;
}

/**
 * One problem or warning. `pointer` is a JSON Pointer into the SARIF log and
 * is omitted (never undefined) for whole-review problems. Codes are private,
 * not a frozen public schema (D13).
 */
export interface IDiagnostic {
  readonly code: string;
  readonly pointer?: string;
  readonly message: string;
}

/** A diagnostic before it is recorded: `[code, message]`. */
type Problem = readonly [code: string, message: string];

/** GitHub review-comment coordinates of one inline comment, before its body. */
interface ISingleLineCoordinates {
  readonly path: string;
  readonly side: PlacementAnchorSide;
  readonly line: number;
}

/** A multi-line anchor names its start on the same side. */
interface IMultiLineCoordinates extends ISingleLineCoordinates {
  readonly startSide: PlacementAnchorSide;
  readonly startLine: number;
}

/** Publication comment coordinates: start fields present together or omitted. */
type CommentCoordinates = ISingleLineCoordinates | IMultiLineCoordinates;

/** One inline comment exactly as publication accepts it. */
export type PreparedComment = CommentCoordinates & { readonly body: string };

/** The complete prepared draft review (the preparedReview shape accepted by publication). */
export interface IPreparedReview {
  readonly commitId: string;
  readonly body: string;
  readonly comments: readonly PreparedComment[];
}

/** An inline anchor on the reviewed commit; `startLine` only for a multi-line anchor. */
interface IInlineAnchor {
  readonly side: PlacementAnchorSide;
  readonly line: number;
  readonly startLine?: number | undefined;
}

/** A whole-file location: no region, so no lines and no quoted text. */
interface IWholeFileSource {
  readonly commit: string;
  readonly path: string;
  readonly startLine?: undefined;
  readonly endLine?: undefined;
}

/** The result's own location: a whole file or an exact validated line range. */
export type EvidenceSource = IWholeFileSource | IPlacementSourceRange;

/** Where a located result is presented. */
type PreparedPlacement =
  | { readonly treatment: 'inline'; readonly source: IPlacementSourceRange; readonly anchor: IInlineAnchor }
  | { readonly treatment: 'general'; readonly source: EvidenceSource };

/** A tool component beside the driver: an extension that defines the rule. */
interface IComponentIdentity {
  readonly name: string;
  readonly version?: string;
}

/** Who produced a finding: tool, optional version, defining extension and rule. */
export interface IAttribution {
  readonly tool: string;
  readonly version?: string;
  readonly component?: IComponentIdentity;
  readonly ruleId?: string;
}

/** The producer's explicit classification of a result; only stated fields are present. */
interface IClassification {
  kind?: SarifResultKind;
  level?: SarifLevel;
  baselineState?: SarifBaselineState;
}

/** A declared owned approval state: 'hold' is awaiting-approval. */
type DeclaredApproval = 'hold' | 'ready';

/** A result's approval as recorded in evidence. */
export type EvidenceApproval = 'none' | 'declared-ready' | 'hold-overridden';

/** A validated fix: one exact replacement presented as a native suggestion. */
interface IPreparedSuggestion {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly originalText: string;
  readonly replacementText: string;
  readonly payload: string;
  readonly source: IPlacementSourceRange;
  readonly description: string | undefined;
}

/** One result, fully validated and ready to render. */
interface IPreparedItem {
  readonly pointer: string;
  readonly message: string;
  readonly locationMessage: string | undefined;
  readonly classification: IClassification | undefined;
  readonly fixDescription: string | undefined;
  readonly attribution: IAttribution;
  readonly approval: EvidenceApproval;
  readonly uninterpretedProperties: SarifPropertyBag | undefined;
  readonly taxa: readonly ISarifReportingDescriptorReference[] | undefined;
  readonly placement: PreparedPlacement | null;
  readonly suggestion: IPreparedSuggestion | null;
}

/** Fields every evidence record carries; optional ones are omitted when absent. */
interface IEvidenceRecord {
  readonly pointer: string;
  readonly attribution: IAttribution;
  readonly approval: EvidenceApproval;
  readonly uninterpretedProperties?: SarifPropertyBag;
  readonly taxa?: readonly ISarifReportingDescriptorReference[];
  readonly classification?: IClassification;
  readonly locationMessage?: string;
}

/** The exact replacement-module output a suggestion presents. */
interface IReplacementEvidence {
  readonly startLine: number;
  readonly endLine: number;
  readonly originalText: string;
  readonly replacementText: string;
}

/** A result presented in (or merged into) a native suggestion comment. */
interface ISuggestionEvidence extends IEvidenceRecord {
  readonly treatment: 'suggestion';
  readonly commentIndex: number;
  readonly source?: EvidenceSource;
  readonly fixSource: IPlacementSourceRange;
  readonly replacement: IReplacementEvidence;
  readonly suggestionPayload: string;
}

/** A result presented as its own inline comment. */
interface IInlineEvidence extends IEvidenceRecord {
  readonly treatment: 'inline';
  readonly commentIndex: number;
  readonly source: IPlacementSourceRange;
  readonly anchor: IInlineAnchor;
}

/** A result presented as a general body section. */
interface IGeneralEvidence extends IEvidenceRecord {
  readonly treatment: 'general';
  readonly bodySectionIndex: number;
  readonly source?: EvidenceSource;
}

/** One evidence record per SARIF result, in SARIF order. */
export type Evidence = ISuggestionEvidence | IInlineEvidence | IGeneralEvidence;

/** A complete review, ready for publication. */
export interface IReadyOutcome {
  readonly status: 'ready';
  readonly review: IPreparedReview;
  readonly evidence: readonly Evidence[];
  readonly warnings: readonly IDiagnostic[];
  readonly markdown: string;
}

/** The whole review is blocked; nothing may be published. */
export interface IBlockedOutcome {
  readonly status: 'blocked';
  readonly diagnostics: readonly IDiagnostic[];
  readonly warnings: readonly IDiagnostic[];
  readonly markdown: string;
}

/** The outcome of prepareReview. */
export type PrepareReviewOutcome = IReadyOutcome | IBlockedOutcome;

/** Facts shared by every result of a run (see analyzeRun). */
interface IRunInfo {
  readonly run: ISarifRunView;
  readonly pointer: string;
  readonly driver: ISarifComponent;
  readonly attribution: IAttribution;
  readonly approval: DeclaredApproval | undefined;
  readonly columnKind: ColumnKind | undefined;
  sourceCommit: string;
  provenanceError: Problem | null;
  newlineError: Problem | null;
  readonly roots: (IRootedReference | IRelativeReference)[];
}

/** What every step of one preparation shares. */
interface IPreparationState {
  readonly context: IPreparationContext;
  readonly options: IEffectiveOptions;
  readonly report: Report;
  readonly applyFix: ApplyReplacement;
  readonly readSource: (commit: string, path: string) => Promise<unknown>;
  readonly sourceRoot: ParsedReference | null;
}

/** An owned property namespace, as parseOwned reads it. */
interface IOwnedProperties {
  approval: DeclaredApproval | undefined;
  proposedFileChanges: undefined;
}

/** Source text read at a location's resolved repository path and revision. */
interface ILocatedSource {
  readonly commit: string;
  readonly path: string;
  readonly text: string;
}

/** A message rendered as Markdown ('' after a recorded error). */
interface IRenderedMessage {
  readonly markdown: string;
}

/** A result's rule and the component defining it; both absent after an error. */
interface IRuleResolution {
  readonly rule?: ISarifRule | undefined;
  readonly component?: ISarifComponent;
}

/** A resolved path, or why the location names none. */
type ArtifactPathOutcome = { readonly error?: never; readonly path: string } | IResolutionFailure<ArtifactPathErrorCode>;

/** A resolved base: a rooted location, or why there is none. */
type ResolvedBase = IRootedReference | IResolutionFailure<ArtifactPathErrorCode>;

/**
 * The span one column unit gives a region: an exact [start, end) UTF-16 span,
 * or the replacement module's diagnostic.
 */
type RegionSpan =
  | { readonly outcome: ReplacementDiagnostic; readonly start?: undefined; readonly end?: undefined }
  | { readonly outcome?: undefined; readonly start: number; readonly end: number };

/** A region's physical lines, or why they cannot be read. */
type RegionLines =
  | { readonly error?: undefined; readonly startLine: number; readonly endLine: number }
  | { readonly error: Problem };

/** A native suggestion payload, or why none can be emitted faithfully. */
type SuggestionPayload = { readonly error?: undefined; readonly text: string } | { readonly error: Problem };

/** The inline comment a set of items shares, with its coordinates and optional suggestion. */
interface ICommentEntry {
  readonly coordinates: CommentCoordinates;
  readonly items: IPreparedItem[];
  readonly suggestion?: IPreparedSuggestion;
}

/** The JSON key identifying one exact replacement: [path, startLine, endLine, replacementText]. */
type SuggestionKey = readonly [path: string, startLine: number, endLine: number, replacementText: string];

// ---------------------------------------------------------------------------
// Constants

/** Conservative product limits on one prepared review; not claims about host maxima. */
const PRODUCT_LIMITS: Readonly<IProductLimits> = Object.freeze({ maxComments: 100, maxCommentBodyChars: 60000, maxPayloadBytes: 1000000 });

/** A full, canonical Git object name; abbreviations are never prefix-matched. */
const FULL_COMMIT = /^[0-9a-f]{40}$/;

/** The property-bag namespace this product owns (D11, D23). */
const OWNED_NAMESPACE = 'sarifToComment';

/** Owned keys meaningful on a run and on a result. */
const OWNED_RUN_KEYS: ReadonlySet<string> = new Set(['approval']);
const OWNED_RESULT_KEYS: ReadonlySet<string> = new Set(['approval', 'proposedFileChanges']);

/** Declared approval states; anything else in the owned namespace is invalid. */
const APPROVAL_HOLD = 'awaiting-approval';
const APPROVAL_READY = 'ready';

/** Proposed file operations the product recognizes but does not publish in this milestone (D23). */
const KNOWN_FILE_OPERATIONS: ReadonlySet<string> = new Set(['create', 'delete', 'edit']);

/** The two SARIF column units; a region without columnKind must mean the same text in both. */
const COLUMN_KINDS: readonly ColumnKind[] = ['utf16CodeUnits', 'unicodeCodePoints'];

/** Result features with meaning this profile cannot present faithfully. */
const UNSUPPORTED_RESULT_FEATURES: readonly (readonly [key: UnsupportedResultFeature, code: string, label: string])[] = [
  ['codeFlows', 'code-flows-unsupported', 'Code flows'],
  ['relatedLocations', 'related-locations-unsupported', 'Related locations'],
  ['graphs', 'graphs-unsupported', 'Graphs'],
  ['graphTraversals', 'graphs-unsupported', 'Graph traversals'],
  ['stacks', 'stacks-unsupported', 'Stacks'],
  ['attachments', 'attachments-unsupported', 'Attachments'],
  ['suppressions', 'suppressed-result-unsupported', 'Suppressions'],
];

/**
 * SARIF's default newline sequences (3.14.20). Line coordinates are read only
 * under this set, in either order; any other declaration would give the same
 * numbers a different source association and blocks located results and fixes.
 */
const DEFAULT_NEWLINE_SEQUENCES: readonly string[] = ['\r\n', '\n'];

/**
 * External property files and inline external properties (3.15, 3.14.2) can
 * hold results, rules, artifacts and other meaning for findings. This profile
 * never loads them, so their presence blocks the whole review rather than
 * silently publishing an incomplete one.
 */
const EXTERNAL_PROPERTIES_MESSAGE = 'The log keeps SARIF content in external properties, which this profile does not load; '
  + 'publishing without it could lose findings or their meaning. Inline the content into the log.';

/** Separator between rendered items and between general body sections. */
const SEPARATOR = '\n\n---\n\n';

/**
 * A GitHub-style @mention in plain text: a user or org/team handle not
 * preceded by a word character (so email addresses are excluded).
 */
const MENTION = /(?<![A-Za-z0-9_`])(@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?)/;

/** Characters that CommonMark/GFM may interpret anywhere in a line of plain text. */
const INLINE_MARKDOWN = /[\\`*_[\]<>#!|~{}&]/g;

/** GitHub web host for exact-revision permalinks and repository identity. */
const GITHUB_HOST = 'github.com';

/**
 * A CommonJS module as `require()` returns it when the package exposes its
 * main value directly and also as `default`: either may be the one to use.
 */
type CommonJsModule<T> = T & { readonly default?: T };

/** The ajv-draft-04 constructor. */
type AjvDraft04 = typeof AjvDraft04Module.default;

/** The ajv-formats plugin. */
type AddFormats = typeof AjvFormatsModule.default;

/** Whether the vendored schema is an object, the only kind of schema ajv compiles here. */
function isSchemaObject(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

let schemaValidator: ValidateFunction<ISarifLogView> | undefined;

/** The compiled official SARIF 2.1.0 schema (draft-04) with formats enforced. */
function sarifValidator(): ValidateFunction<ISarifLogView> {
  if (!schemaValidator) {
    // ajv loads lazily, on the first preparation; only its types are imported statically.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- require() is untyped; ajv-draft-04's CommonJS export is the Ajv class, also exposed as `default` (the declarations imported type-only above)
    const AjvDraft04: CommonJsModule<AjvDraft04> = require('ajv-draft-04');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- require() is untyped; ajv-formats' CommonJS export is the formats plugin, also exposed as `default` (the declarations imported type-only above)
    const formats: CommonJsModule<AddFormats> = require('ajv-formats');
    const Ajv = AjvDraft04.default || AjvDraft04;
    const addFormats = formats.default || formats;
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    if (!isSchemaObject(SARIF_SCHEMA)) throw new TypeError('The vendored SARIF schema is not a JSON object.');
    // The one unchecked claim about SARIF content: a document the official
    // schema accepts has the shape ISarifLogView describes. The views name
    // only schema-defined properties with the schema's own types and
    // requiredness, so the validator's type guard is the narrowing.
    schemaValidator = ajv.compile<ISarifLogView>(SARIF_SCHEMA);
  }
  return schemaValidator;
}

/**
 * Prepares one complete draft review from a ready SARIF document.
 *
 * @param input - see module documentation for the exact shape; validated here
 * @param internals - private test seam
 * @returns a ready review or a whole-review block
 */
async function prepareReview(input: unknown, internals: IPrepareReviewInternals | null = {}): Promise<PrepareReviewOutcome> {
  validateCallerInput(input);
  const { sarif, context, readSource } = input;
  const options: IEffectiveOptions = { ...PRODUCT_LIMITS, ignoreApprovalHold: false, ...(input.options || {}) };
  const report = new Report();

  const validate = sarifValidator();
  if (!validate(sarif)) {
    const errors = validate.errors || [];
    report.error('sarif-schema-invalid', errors[0] && errors[0].instancePath ? errors[0].instancePath : undefined,
      `The SARIF log does not conform to the SARIF 2.1.0 schema: ${errors.slice(0, 10)
        .map((e) => `${e.instancePath || '/'} ${String(e.message)}`).join('; ')}.`);
    return blocked(report);
  }

  const state: IPreparationState = {
    context,
    options,
    report,
    applyFix: (internals && internals.applyReplacement) || productionApplyReplacement,
    readSource: cachedReader(readSource),
    sourceRoot: context.sourceRootUri === undefined ? null : parseBaseUri(context.sourceRootUri),
  };

  if (Array.isArray(sarif.inlineExternalProperties) && sarif.inlineExternalProperties.length > 0) {
    report.error('external-properties-unsupported', '/inlineExternalProperties', EXTERNAL_PROPERTIES_MESSAGE);
  }

  // Only results that prepared cleanly are kept. A result that could not be
  // prepared recorded an error, so the review blocks right after this loop
  // and the kept items are never assembled.
  const items: IPreparedItem[] = [];
  for (const [runIndex, run] of (sarif.runs || []).entries()) {
    const runInfo = analyzeRun(run, runIndex, state);
    for (const [resultIndex, result] of (run.results || []).entries()) {
      const item = await prepareResult(result, `/runs/${String(runIndex)}/results/${String(resultIndex)}`, runInfo, state);
      if (item) items.push(item);
    }
  }
  if (report.errors.length > 0) return blocked(report);

  const assembled = assemble(items, state);
  if (report.errors.length > 0) return blocked(report);
  enforceLimits(assembled.review, items, state);
  if (report.errors.length > 0) return blocked(report);

  return {
    status: 'ready',
    review: assembled.review,
    evidence: assembled.evidence,
    warnings: report.warnings,
    markdown: readyMarkdown(assembled.review, report),
  };
}

// ---------------------------------------------------------------------------
// Caller boundary

/** Rejects caller misuse of the library boundary; SARIF content is diagnosed later. */
function validateCallerInput(input: unknown): asserts input is IPrepareReviewInput {
  const fail: (message: string) => never = (message) => { throw new TypeError(message); };
  if (!isPlainObject(input)) fail('prepareReview input must be an object.');
  if (!isPlainObject(input['sarif'])) fail('`sarif` must be a parsed SARIF object, not serialized text.');
  const context = input['context'];
  if (!isPlainObject(context)) fail('`context` must be an object.');
  for (const key of ['owner', 'repo']) {
    if (typeof context[key] !== 'string' || context[key] === '') fail(`\`context.${key}\` must be a non-empty string.`);
  }
  const pullNumber = context['pullNumber'];
  if (typeof pullNumber !== 'number' || !Number.isInteger(pullNumber) || pullNumber < 1) fail('`context.pullNumber` must be a positive integer.');
  if (!isFullCommit(context['reviewedCommit'])) fail('`context.reviewedCommit` must be a full 40-character lowercase commit.');
  const diff = context['diff'];
  if (!isPlainObject(diff) || !isFullCommit(diff['baseCommit']) || !isFullCommit(diff['headCommit']) || !Array.isArray(diff['files'])) {
    fail('`context.diff` must name full base and head commits and list its files.');
  }
  const sourceRootUri = context['sourceRootUri'];
  if (sourceRootUri !== undefined) {
    const root = typeof sourceRootUri === 'string' ? parseBaseUri(sourceRootUri) : null;
    if (!root || root.error || typeof root.root !== 'string' || !root.root.startsWith('file:')) {
      fail('`context.sourceRootUri` must be an absolute file: URI ending in "/".');
    }
  }
  if (typeof input['readSource'] !== 'function') fail('`readSource` must be a function (commit, path) => Promise<string|null>.');
  const options = input['options'];
  if (options !== undefined) {
    if (!isPlainObject(options)) fail('`options` must be an object.');
    for (const key of ['maxComments', 'maxCommentBodyChars', 'maxPayloadBytes']) {
      const value = options[key];
      if (value !== undefined && !(typeof value === 'number' && Number.isInteger(value) && value > 0)) fail(`\`options.${key}\` must be a positive integer.`);
    }
    const hold = options['ignoreApprovalHold'];
    if (hold !== undefined && typeof hold !== 'boolean') fail('`options.ignoreApprovalHold` must be a boolean.');
  }
}

/** Reads each (commit, path) snapshot at most once. */
function cachedReader(readSource: SnapshotReader): (commit: string, path: string) => Promise<unknown> {
  const cache = new Map<string, Promise<unknown>>();
  return (commit, path) => {
    const key = `${commit}\0${path}`;
    let snapshot = cache.get(key);
    if (snapshot === undefined) {
      snapshot = Promise.resolve(readSource(commit, path));
      cache.set(key, snapshot);
    }
    return snapshot;
  };
}

// ---------------------------------------------------------------------------
// Diagnostics

/** Collects blocking diagnostics and warnings for the whole review. */
class Report {
  readonly errors: IDiagnostic[];
  readonly warnings: IDiagnostic[];

  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  error(code: string, pointer: string | undefined, message: string): void {
    this.errors.push(diagnostic(code, pointer, message));
  }

  warn(code: string, pointer: string | undefined, message: string): void {
    this.warnings.push(diagnostic(code, pointer, message));
  }
}

function diagnostic(code: string, pointer: string | undefined, message: string): IDiagnostic {
  return pointer === undefined ? { code, message } : { code, pointer, message };
}

function blocked(report: Report): IBlockedOutcome {
  return { status: 'blocked', diagnostics: report.errors, warnings: report.warnings, markdown: blockedMarkdown(report) };
}

function diagnosticLine(d: IDiagnostic): string {
  return `- ${codeSpan(d.code)}${d.pointer === undefined ? '' : ` at ${codeSpan(d.pointer)}`}: ${d.message}`;
}

function warningsMarkdown(report: Report): string {
  return report.warnings.length === 0 ? '' : `\n\n**Warnings:**\n\n${report.warnings.map(diagnosticLine).join('\n')}`;
}

function blockedMarkdown(report: Report): string {
  const count = report.errors.length;
  return `**Review blocked:** ${String(count)} problem${count === 1 ? '' : 's'} must be resolved before publication; `
    + `nothing was published.\n\n${report.errors.map(diagnosticLine).join('\n')}${warningsMarkdown(report)}`;
}

function readyMarkdown(review: IPreparedReview, report: Report): string {
  const sections = review.body === '' ? 0 : review.body.split(SEPARATOR).length;
  return `**Review prepared:** ${String(review.comments.length)} inline comment(s) and ${String(sections)} general section(s) `
    + `for commit ${codeSpan(review.commitId)}.${warningsMarkdown(report)}`;
}

// ---------------------------------------------------------------------------
// Runs: attribution, owned properties, provenance, URI bases

/**
 * Facts shared by every result of a run: tool identity, run-level approval,
 * the source revision its provenance establishes for this repository, the
 * repository roots it declares, and its URI bases.
 */
function analyzeRun(run: ISarifRunView, runIndex: number, state: IPreparationState): IRunInfo {
  const pointer = `/runs/${String(runIndex)}`;
  const driver = run.tool.driver;
  const owned = parseOwned(run.properties, pointer, OWNED_RUN_KEYS, state);
  const driverVersion = versionOf(driver);
  const info: IRunInfo = {
    run,
    pointer,
    driver,
    attribution: { tool: driver.name, ...(driverVersion === undefined ? {} : { version: driverVersion }) },
    approval: owned.approval,
    columnKind: run.columnKind,
    sourceCommit: state.context.reviewedCommit,
    provenanceError: null,
    newlineError: null,
    roots: [],
  };
  // The caller boundary accepted only a rooted file: URI; the error check narrows its type.
  if (state.sourceRoot && !state.sourceRoot.error) info.roots.push(state.sourceRoot);

  const newlines = run.newlineSequences;
  if (newlines !== undefined && !(newlines.length === DEFAULT_NEWLINE_SEQUENCES.length
    && DEFAULT_NEWLINE_SEQUENCES.every((sequence) => newlines.includes(sequence)))) {
    info.newlineError = ['newline-sequences-unsupported',
      `The run declares newline sequences ${JSON.stringify(newlines)}; only SARIF's default CRLF and LF are supported, `
      + 'so its line and column coordinates cannot be read faithfully.'];
  }
  for (const [index, invocation] of (run.invocations || []).entries()) {
    const notes = [...(invocation.toolExecutionNotifications || []), ...(invocation.toolConfigurationNotifications || [])]
      .filter((n) => n.level === 'error').map(notificationText);
    const quoted = notes.length === 0 ? '' : ` Error notifications: ${notes.map((n) => JSON.stringify(n)).join('; ')}.`;
    if (!invocation.executionSuccessful) {
      state.report.error('invocation-failed', `${pointer}/invocations/${String(index)}`,
        `The tool reports that this analysis did not complete successfully, so its results may be partial.${quoted}`);
    } else if (notes.length > 0) {
      state.report.warn('tool-notification-error', `${pointer}/invocations/${String(index)}`,
        `The tool reported errors during a successful invocation.${quoted}`);
    }
  }
  const external = run.externalPropertyFileReferences;
  if (external && Object.values(external).some((value) => value !== undefined
    && (!Array.isArray(value) || value.length > 0))) {
    state.report.error('external-properties-unsupported', `${pointer}/externalPropertyFileReferences`, EXTERNAL_PROPERTIES_MESSAGE);
  }

  const provenance = run.versionControlProvenance || [];
  const ours = provenance.filter((p) => namesRepository(p.repositoryUri, state.context));
  if (provenance.length > 0 && ours.length === 0) {
    info.provenanceError = ['repository-mismatch',
      'The run\'s version control provenance names only other repositories, so its locations cannot be read from this pull request.'];
  }
  const revisions = [...new Set(ours.map((p) => p.revisionId).filter((r) => r !== undefined))];
  const onlyRevision = revisions[0];
  if (revisions.some((r): boolean => !isFullCommit(r))) {
    info.provenanceError = ['provenance-revision-invalid',
      `Provenance revision ${String(revisions.find((r): boolean => !isFullCommit(r)))} is not a full 40-character commit; abbreviations are never matched.`];
  } else if (revisions.length > 1) {
    info.provenanceError = ['provenance-conflict', `The run names several revisions of this repository: ${revisions.join(', ')}.`];
  } else if (revisions.length === 1 && onlyRevision !== undefined) {
    info.sourceCommit = onlyRevision;
  }
  for (const p of ours) {
    if (p.mappedTo === undefined) continue;
    const root = resolveBaseLocation(p.mappedTo, info);
    if (root.error) state.report.error(root.error[0], `${pointer}/versionControlProvenance`, root.error[1]);
    else info.roots.push(root);
  }

  const referenced = new Set<unknown>();
  for (const result of run.results || []) {
    const namespace = result.properties ? result.properties[OWNED_NAMESPACE] : undefined;
    const changes = isPlainObject(namespace) ? namespace['proposedFileChanges'] : undefined;
    if (Array.isArray(changes)) changes.forEach((c: unknown) => isPlainObject(c) && referenced.add(c['artifactIndex']));
  }
  for (const [index, artifact] of (run.artifacts || []).entries()) {
    if (artifact.contents !== undefined && !referenced.has(index)) {
      state.report.warn('context-artifact-uninterpreted', `${pointer}/artifacts/${String(index)}`,
        'Artifact contents are treated as analysis context only; artifacts never imply a file creation or edit.');
    }
  }
  return info;
}

/** Literal text of a notification message for a diagnostic. */
function notificationText(notification: ISarifNotification): string {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the schema requires message; the fallback is kept as the durable guard it always was
  const m: ISarifMessage = notification.message || {};
  return m.text !== undefined ? m.text : m.markdown !== undefined ? m.markdown : `message id ${String(m.id)}`;
}

function versionOf(driver: ISarifComponent): string | undefined {
  return driver.version !== undefined ? driver.version : driver.semanticVersion;
}

/** Whether a provenance repositoryUri names this GitHub repository (https, http, ssh or git forms). */
function namesRepository(uri: string, context: IPreparationContext): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || url.hostname.toLowerCase() !== GITHUB_HOST) return false;
  const parts = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  const [owner, repo] = parts;
  return parts.length === 2 && owner !== undefined && repo !== undefined
    && owner.toLowerCase() === context.owner.toLowerCase()
    && repo.toLowerCase() === context.repo.toLowerCase();
}

/**
 * Validates an owned property namespace. Returns the declared approval
 * ('hold' | 'ready' | undefined) and proposed operations; records
 * diagnostics for anything invalid or held.
 */
function parseOwned(
  properties: SarifPropertyBag | undefined,
  pointer: string,
  allowedKeys: ReadonlySet<string>,
  state: IPreparationState,
): IOwnedProperties {
  const outcome: IOwnedProperties = { approval: undefined, proposedFileChanges: undefined };
  if (!properties || properties[OWNED_NAMESPACE] === undefined) return outcome;
  const owned = properties[OWNED_NAMESPACE];
  if (!isPlainObject(owned)) {
    state.report.error('owned-property-invalid', pointer, `properties.${OWNED_NAMESPACE} must be an object.`);
    return outcome;
  }
  const unknown = Object.keys(owned).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    state.report.error('owned-property-invalid', pointer,
      `properties.${OWNED_NAMESPACE} has keys this product does not define here: ${unknown.join(', ')}.`);
  }
  if (Object.prototype.hasOwnProperty.call(owned, 'approval')) {
    const approval = owned['approval'];
    if (approval === APPROVAL_HOLD) {
      outcome.approval = 'hold';
      if (state.options.ignoreApprovalHold) {
        state.report.warn('approval-hold-overridden', pointer, 'An approval hold was bypassed by the explicit override.');
      } else {
        state.report.error('approval-hold', pointer,
          'Awaiting approval: the whole review is held. Resolve the hold or use the explicit override.');
      }
    } else if (approval === APPROVAL_READY) {
      outcome.approval = 'ready';
    } else {
      state.report.error('approval-state-invalid', pointer,
        `Approval state ${JSON.stringify(approval)} is not '${APPROVAL_HOLD}' or '${APPROVAL_READY}'.`);
    }
  }
  const operations = owned['proposedFileChanges'];
  if (operations !== undefined && allowedKeys.has('proposedFileChanges')) {
    if (!Array.isArray(operations) || !operations.every(isProposedOperation)) {
      state.report.error('owned-property-invalid', pointer, 'proposedFileChanges must be an array of operations.');
    } else {
      for (const { operation } of operations) {
        if (KNOWN_FILE_OPERATIONS.has(operation)) {
          state.report.error('file-operation-unsupported', pointer,
            `Proposed file ${operation} operations are not published in this milestone.`);
        } else {
          state.report.error('file-operation-unknown', pointer, `Unknown proposed file operation ${JSON.stringify(operation)}.`);
        }
      }
    }
  }
  return outcome;
}

/** Whether a proposedFileChanges entry names its operation (the only field read). */
function isProposedOperation(value: unknown): value is { readonly operation: string } {
  return isPlainObject(value) && typeof value['operation'] === 'string';
}

// ---------------------------------------------------------------------------
// Results

/**
 * Validates and prepares one result. Returns its prepared item, or null when
 * it has blocking diagnostics (recorded in the report).
 */
async function prepareResult(
  result: ISarifResultView,
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): Promise<IPreparedItem | null> {
  const { report } = state;
  const errorsBefore = report.errors.length;
  const owned = parseOwned(result.properties, pointer, OWNED_RESULT_KEYS, state);

  for (const [key, code, label] of UNSUPPORTED_RESULT_FEATURES) {
    const feature = result[key];
    if (Array.isArray(feature) && feature.length > 0) {
      report.error(code, pointer, `${label} are not presented by this milestone's review profile.`);
    }
  }
  const locations = result.locations || [];
  if (locations.length > 1) {
    report.error('multiple-locations-unsupported', pointer, 'Results with several locations are not supported yet.');
  }
  if (locations.some((location) => Array.isArray(location.annotations) && location.annotations.length > 0)) {
    report.error('location-annotations-unsupported', pointer,
      'Region annotations on a location carry their own messages, which this profile does not present.');
  }
  if (result.baselineState === 'absent') {
    report.error('baseline-absent-unsupported', pointer,
      'An absent baseline result describes a problem seen only in the baseline run; its locations refer to a source '
      + 'revision that is not established, so it cannot be presented as feedback on the reviewed commit.');
  }

  const { rule, component } = resolveRule(result, runInfo, pointer, state);
  const message = resolveMessage(result.message, rule, component || runInfo.driver, pointer, state);
  const [onlyLocation] = locations;
  const locationMessage = locations.length === 1 && onlyLocation !== undefined && onlyLocation.message !== undefined
    ? resolveMessage(onlyLocation.message, rule, component || runInfo.driver, pointer, state).markdown : undefined;
  const classification = classifyResult(result, rule);
  const reference: ISarifReportingDescriptorReference = result.rule || {};
  const ruleId = result.ruleId !== undefined ? result.ruleId : reference.id !== undefined ? reference.id : rule && rule.id;
  const attribution: IAttribution = {
    ...runInfo.attribution,
    ...(component && component !== runInfo.driver ? { component: componentIdentity(component) } : {}),
    ...(ruleId === undefined ? {} : { ruleId }),
  };
  if (Array.isArray(result.taxa) && result.taxa.length > 0) {
    report.warn('taxa-uninterpreted', pointer,
      'Taxonomy classifications are retained in evidence but not rendered in the review.');
  }

  let placement: PreparedPlacement | null = null;
  if (locations.length === 1 && onlyLocation !== undefined) placement = await placeLocation(onlyLocation, pointer, runInfo, state);

  let suggestion: IPreparedSuggestion | null = null;
  if (Array.isArray(result.fixes) && result.fixes.length > 0) {
    suggestion = await prepareFix(result.fixes, pointer, runInfo, state);
  }
  // D3/D4: a result's explanation travels with its fix only when the result's
  // own source lies within the fix's replacement lines; it is never moved to
  // the fix location, and the replacement is never enlarged to reach it.
  if (suggestion && placement && !sourceWithin(placement.source, suggestion)) {
    report.error('fix-association-unsupported', pointer,
      'The result\'s location is not within its fix\'s replacement lines; presenting them together would move the feedback. '
      + 'Keep the correct result location and separate the feedback from this unsupported fix association.');
  }
  if (report.errors.length > errorsBefore) return null;

  const approval: EvidenceApproval = owned.approval === 'hold' || runInfo.approval === 'hold' ? 'hold-overridden'
    : owned.approval === 'ready' || runInfo.approval === 'ready' ? 'declared-ready' : 'none';
  const uninterpreted: Record<string, unknown> = { ...(result.properties || {}) };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- OWNED_NAMESPACE is a module constant, not caller data; deleting it from the copy keeps the other properties' order exactly
  delete uninterpreted[OWNED_NAMESPACE];

  return {
    pointer,
    message: message.markdown,
    locationMessage,
    classification,
    fixDescription: suggestion ? suggestion.description : undefined,
    attribution,
    approval,
    uninterpretedProperties: Object.keys(uninterpreted).length > 0 ? uninterpreted : undefined,
    taxa: Array.isArray(result.taxa) && result.taxa.length > 0 ? result.taxa : undefined,
    placement,
    suggestion,
  };
}

/**
 * The producer's explicit classification of a result (SARIF 3.27.9 kind,
 * 3.27.10 level, 3.27.24 baselineState). The level falls back to the rule's
 * defaultConfiguration level; SARIF's implicit defaults are not invented.
 * Returns undefined when the producer stated none.
 */
function classifyResult(result: ISarifResultView, rule: ISarifRule | undefined): IClassification | undefined {
  const level = result.level !== undefined ? result.level
    : rule && rule.defaultConfiguration ? rule.defaultConfiguration.level : undefined;
  const classification: IClassification = {};
  if (result.kind !== undefined) classification.kind = result.kind;
  if (level !== undefined) classification.level = level;
  if (result.baselineState !== undefined) classification.baselineState = result.baselineState;
  return Object.keys(classification).length > 0 ? classification : undefined;
}

/** Whether a located source range lies within a suggestion's replacement lines of the same file and revision. */
function sourceWithin(source: EvidenceSource, suggestion: IPreparedSuggestion): boolean {
  return source.path === suggestion.path && source.commit === suggestion.source.commit
    && source.startLine !== undefined && source.startLine >= suggestion.startLine && source.endLine <= suggestion.endLine;
}

/**
 * The rule a result names, and the tool component that defines it (SARIF
 * 3.27.5-3.27.7, 3.52). Without result.rule.toolComponent the component is the
 * driver; with it, ruleIndex and ruleId are interpreted within the referenced
 * component (an extension or the driver). An unresolvable component or
 * contradictory identifiers block; nothing falls back to the driver.
 * Returns { rule?, component? }; component is undefined only after an error.
 */
function resolveRule(result: ISarifResultView, runInfo: IRunInfo, pointer: string, state: IPreparationState): IRuleResolution {
  const reference: ISarifReportingDescriptorReference = result.rule || {};
  let component: ISarifComponent | undefined = runInfo.driver;
  if (reference.toolComponent !== undefined) {
    component = resolveComponent(reference.toolComponent, runInfo);
    if (!component) {
      state.report.error('rule-component-unresolved', pointer,
        `The rule's toolComponent ${JSON.stringify(reference.toolComponent)} names no single component of the tool.`);
      return {};
    }
  }
  const noun = component === runInfo.driver ? 'the tool driver' : `tool component ${component.name}`;
  if (result.ruleId !== undefined && reference.id !== undefined && result.ruleId !== reference.id) {
    state.report.error('rule-reference-conflict', pointer, `ruleId ${result.ruleId} differs from rule.id ${reference.id}.`);
    return {};
  }
  if (result.ruleIndex !== undefined && reference.index !== undefined && result.ruleIndex !== reference.index) {
    state.report.error('rule-reference-conflict', pointer, `ruleIndex ${String(result.ruleIndex)} differs from rule.index ${String(reference.index)}.`);
    return {};
  }
  const rules = component.rules || [];
  const index = result.ruleIndex !== undefined ? result.ruleIndex : reference.index;
  const id = result.ruleId !== undefined ? result.ruleId : reference.id;
  const matchesId = (rule: ISarifRule): boolean => rule.id === id || (typeof id === 'string' && id.startsWith(`${rule.id}/`));
  if (index !== undefined && index >= 0) {
    const rule = rules[index];
    if (!rule) {
      state.report.error('rule-reference-invalid', pointer, `Rule index ${String(index)} names no rule of ${noun}.`);
      return {};
    }
    if (id !== undefined && !matchesId(rule)) {
      state.report.error('rule-reference-conflict', pointer, `Rule index ${String(index)} of ${noun} names rule ${rule.id}, but the rule id is ${id}.`);
      return {};
    }
    return { rule, component };
  }
  if (id === undefined) return { component };
  return { rule: rules.find((rule) => rule.id === id) || rules.find(matchesId), component };
}

/**
 * The single tool component a toolComponentReference (3.54) names: index
 * selects tool.extensions; guid and name match the driver or any extension.
 * Every stated property must agree; zero or several matches is unresolved.
 */
function resolveComponent(reference: ISarifToolComponentReference, runInfo: IRunInfo): ISarifComponent | undefined {
  const extensions = runInfo.run.tool.extensions || [];
  let candidates: readonly ISarifComponent[] = [runInfo.driver, ...extensions];
  if (reference.index !== undefined) {
    const extension = extensions[reference.index];
    candidates = extension ? [extension] : [];
  }
  const { guid, name } = reference;
  if (guid !== undefined) {
    candidates = candidates.filter((c) => typeof c.guid === 'string' && c.guid.toLowerCase() === guid.toLowerCase());
  }
  if (name !== undefined) candidates = candidates.filter((c) => c.name === name);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** A component's name and version, recorded and rendered beside the driver's identity. */
function componentIdentity(component: ISarifComponent): IComponentIdentity {
  const version = versionOf(component);
  return { name: component.name, ...(version === undefined ? {} : { version }) };
}

/**
 * Resolves a SARIF message to Markdown: markdown verbatim, text escaped to
 * render literally, or message.id through the rule's messageStrings and then
 * the defining component's globalMessageStrings with {n} arguments (SARIF 3.11).
 */
function resolveMessage(
  message: ISarifMessage,
  rule: ISarifRule | undefined,
  component: ISarifComponent,
  pointer: string,
  state: IPreparationState,
): IRenderedMessage {
  let template: ISarifMessage | ISarifMessageString = message;
  let name = 'The message';
  if (message.text === undefined && message.markdown === undefined) {
    const id = message.id;
    // String(id) is the property key JavaScript itself would use for id.
    const fromRule = rule && rule.messageStrings && rule.messageStrings[String(id)];
    const global = component.globalMessageStrings && component.globalMessageStrings[String(id)];
    const resolved = fromRule || global;
    name = `Message ${JSON.stringify(id)}`;
    if (!resolved) {
      state.report.error('message-unresolved', pointer,
        `Message id ${JSON.stringify(id)} is not defined by the rule or the tool driver; the finding cannot be rendered.`);
      return { markdown: '' };
    }
    template = resolved;
  }
  // SARIF 3.11.5 formatting applies to direct and id-resolved strings alike.
  const useMarkdown = template.markdown !== undefined;
  const templateText = template.markdown !== undefined ? template.markdown : template.text;
  if (templateText === undefined) {
    // Schema-valid messages always have text or markdown, and a message string
    // requires text. Only an id naming an inherited object member (such as
    // "constructor") lands here; it fails with exactly the TypeError that
    // reading `replace` of the missing text has always raised.
    throw new TypeError('Cannot read properties of undefined (reading \'replace\')');
  }
  const substituted = substitute(templateText, message.arguments || [],
    useMarkdown ? escapePlainInline : (a) => a);
  if (substituted.missing !== undefined) {
    state.report.error('message-argument-missing', pointer,
      `${name} needs argument {${substituted.missing}}, which was not supplied.`);
    return { markdown: '' };
  }
  const markdown = useMarkdown ? substituted.text : escapePlain(substituted.text);
  const fenceProblem = producerFenceProblem(markdown) || producerHtmlProblem(markdown);
  if (fenceProblem) {
    state.report.error(fenceProblem[0], pointer, fenceProblem[1]);
    return { markdown: '' };
  }
  return { markdown };
}

/** HTML elements that never take a closing tag. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * A conservative, hand-written raw-HTML profile for producer Markdown (not an
 * HTML parser). Outside fenced code and code spans, every comment, processing
 * instruction, CDATA section, declaration and tag must be terminated, and
 * non-void elements must be closed in order within the same producer string.
 * Anything left open could hide later findings, attribution or a validated
 * suggestion when rendered, so it blocks. Backslash-escaped `<` is literal.
 */
function producerHtmlProblem(markdown: string): Problem | null {
  const unbalanced = (what: string): Problem => ['producer-html-unbalanced',
    `Producer Markdown leaves ${what} open, which could hide the attribution, later findings or a suggestion that follows.`];
  const text = markdownOutsideCode(markdown);
  const stack: string[] = [];
  const token = /<!--|<\?|<!\[CDATA\[|<![A-Za-z]|<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/g;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    let backslashes = 0;
    for (let i = match.index - 1; i >= 0 && text[i] === '\\'; i -= 1) backslashes += 1;
    if (backslashes % 2 === 1) continue;
    // Groups 1 and 2 participate only in the tag alternative.
    const [opener, slash, name] = match;
    const terminator = opener === '<!--' ? '-->' : opener === '<?' ? '?>' : opener === '<![CDATA[' ? ']]>' : '>';
    const end = text.indexOf(terminator, match.index + opener.length);
    if (end === -1) return unbalanced(name ? `a <${String(slash)}${name}> tag` : `an HTML ${opener} construct`);
    token.lastIndex = end + terminator.length;
    if (!name) continue;
    const element = name.toLowerCase();
    if (slash) {
      if (stack.pop() !== element) return unbalanced(`an unmatched </${element}> tag`);
    } else if (!VOID_ELEMENTS.has(element) && !text.slice(match.index, end).endsWith('/')) {
      stack.push(element);
    }
  }
  return stack.length > 0 ? unbalanced(`a <${String(stack[stack.length - 1])}> element`) : null;
}

/**
 * Producer Markdown with fenced code blocks and code spans blanked out, since
 * their contents are literal. Fence recognition matches producerFenceProblem.
 */
function markdownOutsideCode(markdown: string): string {
  const kept: string[] = [];
  let open: string | null = null;
  for (const line of markdown.split(/\r\n|\n|\r/)) {
    let core = line;
    for (let previous: string | undefined; previous !== core;) {
      previous = core;
      core = core.replace(/^[ \t]*(?:>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/, '');
    }
    const fence = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(core);
    if (fence) {
      const marker = groupOf(fence, 1);
      const rest = groupOf(fence, 2);
      if (open) {
        if (marker[0] === open[0] && marker.length >= open.length && rest.trim() === '') open = null;
      } else if (!(marker[0] === '`' && rest.includes('`'))) {
        open = marker;
      }
      continue;
    }
    if (!open) kept.push(line);
  }
  return kept.join('\n').replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ' ');
}

/**
 * A conservative, hand-written fence profile for producer Markdown (not a
 * complete Markdown parser). Only a validated SARIF fix may create a native
 * suggestion, so any line that could open a `suggestion` fence — after
 * blockquote markers, list markers and indentation, with backticks or tildes
 * of any length and any fence state — blocks. Fences must also be balanced
 * (a closing fence uses the opening character, is at least as long and has
 * no info string); an unclosed fence would swallow the attribution and any
 * generated suggestion that follows.
 */
function producerFenceProblem(markdown: string): Problem | null {
  let open: string | null = null;
  for (const line of markdown.split(/\r\n|\n|\r/)) {
    let core = line;
    for (let previous: string | undefined; previous !== core;) {
      previous = core;
      core = core.replace(/^[ \t]*(?:>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/, '');
    }
    const fence = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(core);
    if (!fence) continue;
    const marker = groupOf(fence, 1);
    const rest = groupOf(fence, 2);
    const info = rest.trim();
    if (/^suggestion/i.test(info)) {
      return ['producer-suggestion-fence',
        'Producer Markdown opens a suggestion block; only a validated SARIF fix may create a native suggestion.'];
    }
    if (open) {
      if (marker[0] === open[0] && marker.length >= open.length && info === '') open = null;
    } else if (!(marker[0] === '`' && rest.includes('`'))) {
      open = marker;
    }
  }
  return open ? ['producer-fence-unclosed',
    'Producer Markdown leaves a code fence open, which would swallow the attribution and any suggestion that follows.'] : null;
}

/** SARIF 3.11.5 placeholder substitution: {n} arguments, {{ and }} literal braces. */
function substitute(
  template: string,
  args: readonly string[],
  format: (argument: string) => string,
): { readonly text: string; readonly missing: string | undefined } {
  let missing: string | undefined;
  const text = template.replace(/\{\{|\}\}|\{(\d+)\}/g, (match: string, n: string | undefined) => {
    if (match === '{{') return '{';
    if (match === '}}') return '}';
    if (Number(n) >= args.length) {
      if (missing === undefined) missing = n;
      return match;
    }
    return format(String(args[Number(n)]));
  });
  return { text, missing };
}

// ---------------------------------------------------------------------------
// Locations and source

/**
 * Resolves, reads, validates and places one result location. Returns the
 * placement ({ treatment, source, anchor? }) or null after recording errors.
 */
async function placeLocation(
  location: ISarifLocation,
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): Promise<PreparedPlacement | null> {
  const physical = location.physicalLocation;
  if (!physical || !physical.artifactLocation) {
    state.report.error('location-without-physical-source', pointer,
      'Only physical source locations are supported; this location has no artifact.');
    return null;
  }
  if (physical.region !== undefined && runInfo.newlineError) {
    state.report.error(runInfo.newlineError[0], pointer, runInfo.newlineError[1]);
    return null;
  }
  const source = await readLocatedSource(physical.artifactLocation, pointer, runInfo, state);
  if (!source) return null;
  if (physical.region === undefined) {
    return { treatment: 'general', source: { commit: source.commit, path: source.path } };
  }
  const span = resolveSourceRegion(source.text, physical.region, runInfo.columnKind);
  if (span.error) {
    state.report.error(span.error[0], pointer, `${source.path} at ${source.commit}: ${span.error[1]}`);
    return null;
  }
  return classify(source, span.startLine, span.endLine, pointer, state);
}

/** Resolves a location's repository path and revision, and reads its source text. */
async function readLocatedSource(
  artifactLocation: ISarifArtifactLocation,
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): Promise<ILocatedSource | null> {
  if (runInfo.provenanceError) {
    state.report.error(runInfo.provenanceError[0], pointer, runInfo.provenanceError[1]);
    return null;
  }
  const resolved = resolveArtifactPath(artifactLocation, runInfo);
  if (resolved.error) {
    state.report.error(resolved.error[0], pointer, resolved.error[1]);
    return null;
  }
  const commit = runInfo.sourceCommit;
  const text = await state.readSource(commit, resolved.path);
  if (text === null || text === undefined) {
    state.report.error('source-file-missing', pointer, `${resolved.path} does not exist at ${commit}.`);
    return null;
  }
  if (typeof text !== 'string') throw new TypeError(`readSource(${commit}, ${resolved.path}) returned a non-string.`);
  return { commit, path: resolved.path, text };
}

/** Classifies an exact source line range through the placement module. */
function classify(
  source: ILocatedSource,
  startLine: number,
  endLine: number,
  pointer: string,
  state: IPreparationState,
): PreparedPlacement | null {
  const { context } = state;
  const outcome = classifyPlacement({
    source: { commit: source.commit, path: source.path, text: source.text },
    range: { startLine, endLine },
    diff: context.diff,
  });
  if (outcome.kind === 'rejected') {
    const code = outcome.reason === 'invalid-range' || outcome.reason === 'range-out-of-bounds'
      ? 'source-range-invalid' : 'diff-context-inconsistent';
    state.report.error(code, pointer, `${outcome.reason}: ${outcome.message}`);
    return null;
  }
  if (outcome.kind === 'inline' && outcome.anchor.commit_id === context.reviewedCommit) {
    const { side, line, start_line: anchorStart } = outcome.anchor;
    return {
      treatment: 'inline',
      source: outcome.source,
      anchor: anchorStart === undefined ? { side, line } : { side, line, startLine: anchorStart },
    };
  }
  if (outcome.kind === 'unsupported') {
    state.report.warn('inline-unavailable', pointer,
      `Inline placement is unavailable (${outcome.reason}); the finding is published as general feedback with an exact link.`);
  }
  return { treatment: 'general', source: outcome.source };
}

/**
 * Resolves a SARIF region to the exact source span and the physical lines it
 * covers, reading coordinates exactly as the replacement module does (no
 * second coordinate engine). The span is recovered from two applications with
 * different inserted characters, so no source-dependent sentinel is needed.
 * Without columnKind the region is accepted only if both SARIF units yield
 * the same span.
 */
function resolveSourceRegion(text: string, region: ISarifRegion, columnKind: ColumnKind | undefined): RegionLines {
  const kinds = columnKind === undefined ? COLUMN_KINDS : [columnKind];
  const spans = kinds.map((kind): RegionSpan => {
    // Replacing the region by two different one-character texts yields edited
    // texts that first differ exactly at the region start; lengths give its end.
    const [a, b] = ['a', 'b'].map((insertedText) => productionApplyReplacement({
      sourceText: text, deletedRegion: region, insertedText, columnKind: kind,
    }));
    if (a === undefined || b === undefined) throw new Error('Internal error: a region was applied fewer than twice.');
    if (a.kind === 'invalid' || a.kind === 'unsupported') return { outcome: a };
    // The same region applies the same way whichever single character is
    // inserted, so the second application is never a diagnostic here.
    if (b.kind === 'invalid' || b.kind === 'unsupported') throw new Error('Internal error: a region applied with one inserted text but not another.');
    let start = 0;
    while (a.editedText[start] === b.editedText[start]) start += 1;
    return { start, end: start + (text.length - (a.editedText.length - 1)) };
  });
  const first = itemAt(spans, 0);
  const agree = spans.every((s) => (s.outcome && first.outcome
    ? s.outcome.kind === first.outcome.kind && s.outcome.reason === first.outcome.reason
    : !s.outcome && !first.outcome && s.start === first.start && s.end === first.end));
  if (!agree) {
    return { error: ['column-kind-required',
      'The run declares no columnKind and this region denotes different text in UTF-16 code units and in Unicode code points.'] };
  }
  if (first.outcome) {
    const { kind, reason, message } = first.outcome;
    const code = kind === 'unsupported' ? 'region-unsupported'
      : reason === 'coordinate-disagreement' ? 'source-coordinates-inconsistent' : 'source-range-invalid';
    return { error: [code, `${reason}: ${message}`] };
  }
  const lineStarts = lineStartsOf(text);
  const startLine = lineOf(lineStarts, text, first.start);
  const endLine = first.end > first.start ? lineOf(lineStarts, text, first.end - 1) : startLine;
  if (startLine === null || endLine === null) {
    return { error: ['source-range-invalid', 'The region addresses only the end-of-file position, which has no line.'] };
  }
  if (region.snippet && region.snippet.text !== undefined && region.snippet.text !== text.slice(first.start, first.end)) {
    return { error: ['snippet-mismatch',
      `The region snippet ${JSON.stringify(region.snippet.text)} is not the source text ${JSON.stringify(text.slice(first.start, first.end))}.`] };
  }
  return { startLine, endLine };
}

/** UTF-16 index at which each physical line starts; a terminal newline starts no line. */
function lineStartsOf(text: string): number[] {
  const starts: number[] = text.length === 0 ? [] : [0];
  for (let i = text.indexOf('\n'); i !== -1 && i + 1 < text.length; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** The 1-based line containing a UTF-16 index, or null for the end-of-file position after a newline. */
function lineOf(starts: readonly number[], text: string, index: number): number | null {
  if (starts.length === 0 || (index >= text.length && text.endsWith('\n'))) return null;
  let line = 0;
  while (line + 1 < starts.length && itemAt(starts, line + 1) <= index) line += 1;
  return line + 1;
}

// ---------------------------------------------------------------------------
// Fixes

/**
 * Prepares a result's single native suggestion. Returns
 * { path, startLine, endLine, originalText, replacementText, source, description }
 * or null after recording errors.
 */
async function prepareFix(
  fixes: readonly ISarifFix[],
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): Promise<IPreparedSuggestion | null> {
  const { report, context } = state;
  const fail = (code: string, message: string): null => {
    report.error(code, pointer, message);
    return null;
  };
  if (fixes.length > 1) {
    return fail('fix-alternatives-unsupported', 'Several alternative fixes were proposed; none is chosen silently.');
  }
  // The caller passes at least one fix, and the schema requires at least one
  // artifact change per fix and one replacement per change.
  const fix = itemAt(fixes, 0);
  if (fix.artifactChanges.length > 1) return fail('fix-multiple-files-unsupported', 'A fix changing several files is not supported yet.');
  const change = itemAt(fix.artifactChanges, 0);
  if (change.replacements.length > 1) {
    return fail('fix-multiple-replacements-unsupported', 'A fix with several replacements is not supported yet.');
  }
  const replacement = itemAt(change.replacements, 0);
  if (replacement.insertedContent && replacement.insertedContent.binary !== undefined) {
    return fail('fix-binary-unsupported', 'Binary replacement content cannot be presented as a suggestion.');
  }
  if (runInfo.newlineError) return fail(runInfo.newlineError[0], runInfo.newlineError[1]);
  if (runInfo.provenanceError) return fail(runInfo.provenanceError[0], runInfo.provenanceError[1]);
  if (runInfo.sourceCommit !== context.reviewedCommit) {
    return fail('suggestion-source-not-reviewed',
      `The fix edits ${runInfo.sourceCommit}, not the reviewed commit; its applicability there is unverified.`);
  }
  if (context.reviewedCommit !== context.diff.headCommit) {
    return fail('suggestion-historical-unsupported',
      'The reviewed commit is not the pull request head, so a native suggestion could not be applied to the reviewed text.');
  }
  const source = await readLocatedSource(change.artifactLocation, pointer, runInfo, state);
  if (!source) return null;

  const description = fix.description ? resolveMessage(fix.description, undefined, runInfo.driver, pointer, state).markdown : undefined;
  const insertedText = replacement.insertedContent && replacement.insertedContent.text !== undefined
    ? replacement.insertedContent.text : '';
  const kinds = runInfo.columnKind === undefined ? COLUMN_KINDS : [runInfo.columnKind];
  const outcomes = kinds.map((columnKind) => state.applyFix({
    sourceText: source.text, deletedRegion: replacement.deletedRegion, insertedText, columnKind,
  }));
  const edit = itemAt(outcomes, 0);
  if (outcomes.some((o) => JSON.stringify(o) !== JSON.stringify(edit))) {
    return fail('column-kind-required',
      'The run declares no columnKind and this replacement edits different text in UTF-16 code units and in Unicode code points.');
  }
  if (edit.kind !== 'replacement') {
    return fail(`replacement-${edit.kind}`, `The replacement cannot be applied (${edit.reason}): ${edit.message}`);
  }
  const { startLine, endLine, originalText, replacementText } = edit;
  const payload = suggestionPayload(source.text, startLine, endLine, replacementText, edit.editedText);
  if (payload.error) return fail(payload.error[0], payload.error[1]);
  const placed = classifyPlacement({
    source: { commit: source.commit, path: source.path, text: source.text },
    range: { startLine, endLine },
    diff: context.diff,
  });
  if (placed.kind !== 'inline' || placed.anchor.side !== 'RIGHT' || placed.anchor.commit_id !== context.reviewedCommit) {
    return fail(placed.kind === 'rejected' ? 'diff-context-inconsistent' : 'suggestion-not-inline',
      `Lines ${String(startLine)}-${String(endLine)} of ${source.path} cannot carry a native suggestion (${placed.kind === 'inline' ? placed.anchor.side : placed.reason}).`);
  }
  return {
    path: source.path, startLine, endLine, originalText, replacementText, payload: payload.text, source: placed.source, description,
  };
}

/**
 * The native suggestion payload for an exact replacement, emitted only when
 * GitHub's observed application of that payload reproduces the intended
 * edited file exactly (docs/native-suggestion-fidelity-experiment.md).
 * Rendering as a suggestion is not evidence of faithful application.
 *
 * Observed host application of a payload replacing lines s..e:
 *   - each payload line is written with the replaced lines' shared line
 *     terminator (an LF payload re-creates CRLF in a CRLF source), except that
 *     replacing a final line without a newline keeps it without one;
 *   - an empty payload deletes the lines; deleting a final line without a
 *     newline also removes the preceding line's terminator.
 * Observed misapplications, blocked before any write: a payload containing CR
 * doubles it, a nonzero blank-only payload applies as zero lines, and a
 * nested ``` payload applies as a deletion. Anything the model does not
 * reproduce exactly is unsupported.
 */
function suggestionPayload(
  sourceText: string,
  startLine: number,
  endLine: number,
  replacementText: string,
  editedText: string,
): SuggestionPayload {
  const block = (code: string, message: string): SuggestionPayload => ({ error: [code, message] });
  if (replacementText.includes('```')) {
    return block('suggestion-fence-unverified',
      'GitHub applied a nested ``` suggestion as a deletion; this replacement cannot be a native suggestion.');
  }
  const payloadLines = replacementText === '' ? [] : replacementText.replace(/\r?\n$/, '').split(/\r?\n/);
  if (payloadLines.length > 0 && payloadLines.every((line) => /^[ \t]*$/.test(line))) {
    return block('suggestion-blank-only-unverified',
      'GitHub applied a blank-only suggestion as zero lines; this replacement cannot be a native suggestion.');
  }
  if (payloadLines.some((line) => line.includes('\r'))) {
    return block('suggestion-crlf-unverified', 'A CR in suggestion text is doubled by GitHub; this replacement cannot be a native suggestion.');
  }

  const lines: readonly string[] = sourceText.match(/[^\n]*\n|[^\n]+$/g) || [];
  const terminatorOf = (line: string): string => (line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '');
  const selected = lines.slice(startLine - 1, endLine);
  const terminators = new Set(selected.map(terminatorOf).filter((t) => t !== ''));
  const finalWithoutNewline = endLine === lines.length && terminatorOf(itemAt(lines, lines.length - 1)) === '';
  const touchesFinalLine = endLine === lines.length;
  const unfaithful = (): SuggestionPayload => (touchesFinalLine
    ? block('suggestion-final-newline-unverified',
      'GitHub\'s observed application would not reproduce the intended end of the file.')
    : block('suggestion-crlf-unverified',
      'GitHub\'s observed application would not reproduce the intended line endings.'));

  if (terminators.size > 1 || (terminators.size === 0 && payloadLines.length > 1)) return unfaithful();
  const terminator = terminators.size === 1 ? itemAt([...terminators], 0) : '';
  const prefix = lines.slice(0, startLine - 1).join('');
  const suffix = lines.slice(endLine).join('');
  let applied: string;
  if (payloadLines.length === 0) {
    const before = finalWithoutNewline ? prefix.slice(0, prefix.length - terminatorOf(prefix).length) : prefix;
    applied = before + suffix;
  } else {
    applied = prefix + payloadLines.join(terminator) + (finalWithoutNewline ? '' : terminator) + suffix;
  }
  if (applied !== editedText) return unfaithful();
  return { text: payloadLines.map((line) => `${line}\n`).join('') };
}

// ---------------------------------------------------------------------------
// Assembly

/**
 * Builds the review: inline comments in SARIF order of first appearance, with
 * identical suggestions merged and overlapping different suggestions
 * blocked; general sections in SARIF order; one evidence record per result.
 */
function assemble(
  items: readonly IPreparedItem[],
  state: IPreparationState,
): { readonly review: IPreparedReview; readonly evidence: Evidence[]; readonly commentItems: ICommentEntry[] } {
  const { context, report } = state;
  const commentItems: ICommentEntry[] = [];
  const sections: string[] = [];
  const evidence: Evidence[] = [];
  const suggestionComments = new Map<string, number>();

  for (const item of items) {
    const record: IEvidenceRecord = {
      pointer: item.pointer,
      attribution: item.attribution,
      approval: item.approval,
      ...(item.uninterpretedProperties ? { uninterpretedProperties: item.uninterpretedProperties } : {}),
      ...(item.taxa ? { taxa: item.taxa } : {}),
      ...(item.classification ? { classification: item.classification } : {}),
      ...(item.locationMessage !== undefined ? { locationMessage: item.locationMessage } : {}),
    };
    if (item.suggestion) {
      const s = item.suggestion;
      const key = JSON.stringify([s.path, s.startLine, s.endLine, s.replacementText]);
      let index = suggestionComments.get(key);
      if (index === undefined) {
        const overlapping = [...suggestionComments.entries()].find(([otherKey]) => {
          const [path, start, end] = parseSuggestionKey(otherKey);
          return path === s.path && start <= s.endLine && s.startLine <= end;
        });
        if (overlapping) {
          report.error('overlapping-replacements', item.pointer,
            `The replacement of ${s.path} lines ${String(s.startLine)}-${String(s.endLine)} overlaps a different replacement.`);
          continue;
        }
        index = commentItems.length;
        suggestionComments.set(key, index);
        commentItems.push({
          coordinates: inlineCoordinates(s.path, { side: 'RIGHT', line: s.endLine, startLine: s.startLine === s.endLine ? undefined : s.startLine }),
          items: [],
          suggestion: s,
        });
      }
      itemAt(commentItems, index).items.push(item);
      evidence.push({ ...record, treatment: 'suggestion', commentIndex: index,
        ...(item.placement ? { source: item.placement.source } : {}),
        fixSource: s.source,
        replacement: { startLine: s.startLine, endLine: s.endLine, originalText: s.originalText, replacementText: s.replacementText },
        suggestionPayload: s.payload });
    } else if (item.placement && item.placement.treatment === 'inline') {
      const index = commentItems.length;
      commentItems.push({ coordinates: inlineCoordinates(item.placement.source.path, item.placement.anchor), items: [item] });
      evidence.push({ ...record, treatment: 'inline', commentIndex: index, source: item.placement.source,
        anchor: item.placement.anchor });
    } else {
      evidence.push({ ...record, treatment: 'general', bodySectionIndex: sections.length,
        ...(item.placement ? { source: item.placement.source } : {}) });
      sections.push(renderSection(item, context));
    }
  }

  // Each comment's body follows its coordinates, once every item it presents is known.
  const comments: PreparedComment[] = commentItems.map((entry) => {
    const body = entry.items.map(renderItem).join(SEPARATOR);
    return {
      ...entry.coordinates,
      body: entry.suggestion
        ? `${body}\n\n\`\`\`suggestion\n${entry.suggestion.payload}\`\`\``
        : body,
    };
  });
  return {
    review: { commitId: context.reviewedCommit, body: sections.join(SEPARATOR), comments },
    evidence,
    commentItems,
  };
}

/** Reads back a key this module wrote with JSON.stringify in assemble. */
function parseSuggestionKey(key: string): SuggestionKey {
  const parsed: unknown = JSON.parse(key);
  if (!Array.isArray(parsed) || parsed.length !== 4) throw new Error('Internal error: a suggestion key is not a four-element array.');
  const values: readonly unknown[] = parsed;
  const [path, startLine, endLine, replacementText] = values;
  if (typeof path !== 'string' || typeof startLine !== 'number' || typeof endLine !== 'number' || typeof replacementText !== 'string') {
    throw new Error('Internal error: a suggestion key does not hold a path, two lines and a replacement.');
  }
  return [path, startLine, endLine, replacementText];
}

/** Publication comment coordinates; a multi-line anchor names its start on the same side. */
function inlineCoordinates(path: string, anchor: IInlineAnchor): CommentCoordinates {
  if (anchor.startLine !== undefined) {
    return { path, side: anchor.side, line: anchor.line, startSide: anchor.side, startLine: anchor.startLine };
  }
  return { path, side: anchor.side, line: anchor.line };
}

/** Enforces the product limits on the complete prepared review; never truncates. */
function enforceLimits(review: IPreparedReview, _items: readonly IPreparedItem[], state: IPreparationState): void {
  const { options, report } = state;
  // A limit explicitly set to undefined compares false, exactly as it always did.
  const { maxComments, maxCommentBodyChars, maxPayloadBytes } = options;
  if (maxComments !== undefined && review.comments.length > maxComments) {
    report.error('too-many-comments', undefined,
      `The review needs ${String(review.comments.length)} inline comments; the limit is ${String(maxComments)}. Nothing is split or dropped.`);
  }
  const long = maxCommentBodyChars === undefined ? -1 : review.comments.findIndex((c) => c.body.length > maxCommentBodyChars);
  if (long !== -1) {
    report.error('comment-too-large', undefined,
      `Inline comment ${String(long)} is ${String(itemAt(review.comments, long).body.length)} characters; the limit is ${String(maxCommentBodyChars)}.`);
  }
  if (maxCommentBodyChars !== undefined && review.body.length > maxCommentBodyChars) {
    report.error('body-too-large', undefined,
      `The review body is ${String(review.body.length)} characters; the limit is ${String(maxCommentBodyChars)}.`);
  }
  const bytes = Buffer.byteLength(JSON.stringify({ body: review.body, comments: review.comments }), 'utf8');
  if (maxPayloadBytes !== undefined && bytes > maxPayloadBytes) {
    report.error('payload-too-large', undefined,
      `The complete review is ${String(bytes)} bytes; the limit is ${String(maxPayloadBytes)}. Nothing is truncated or split.`);
  }
}

// ---------------------------------------------------------------------------
// Rendering

function renderItem(item: IPreparedItem): string {
  const c: IClassification = item.classification || {};
  const stated: readonly (readonly [label: string, value: string | undefined])[] = [['Level', c.level], ['Kind', c.kind], ['Baseline', c.baselineState]];
  const status = stated
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined).map(([label, value]) => `**${label}:** ${value}`).join(' · ');
  const location = item.locationMessage === undefined ? '' : `\n\n**At this location:** ${item.locationMessage}`;
  const fix = item.fixDescription === undefined ? '' : `\n\n**Fix:** ${item.fixDescription}`;
  return `${status === '' ? '' : `${status}\n\n`}${item.message}${location}${fix}\n\n<sub>— ${renderAttribution(item.attribution)}</sub>`;
}

function renderAttribution({ tool, version, component, ruleId }: IAttribution): string {
  const named = (name: string, v: string | undefined): string => `${escapePlainInline(name)}${v === undefined ? '' : ` ${escapePlainInline(v)}`}`;
  return `${named(tool, version)}${component === undefined ? '' : ` · ${named(component.name, component.version)}`}`
    + (ruleId === undefined ? '' : ` · rule ${codeSpan(ruleId)}`);
}

/** A general body section: exact-revision link and literal source quote when the finding has a location. */
function renderSection(item: IPreparedItem, context: IPreparationContext): string {
  const source = item.placement && item.placement.source;
  if (!source) return renderItem(item);
  const short = source.commit.slice(0, 7);
  const link = permalink(context, source);
  if (source.startLine === undefined) {
    return `**Source:** [${escapePlainInline(source.path)} at ${short}](${link})\n\n${renderItem(item)}`;
  }
  const lines = source.startLine === source.endLine ? `line ${String(source.startLine)}` : `lines ${String(source.startLine)}-${String(source.endLine)}`;
  const fence = '`'.repeat(Math.max(3, longestRun(source.text, '`') + 1));
  return `**Source:** [${escapePlainInline(source.path)} ${lines} at ${short}](${link})\n\n`
    + `${fence}\n${source.text}\n${fence}\n\n${renderItem(item)}`;
}

/** GitHub permalink to an exact revision, path and optional line range. */
function permalink(context: IPreparationContext, source: EvidenceSource): string {
  const encodedPath = source.path.split('/').map(encodeURIComponent).join('/');
  const base = `https://${GITHUB_HOST}/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}/blob/${source.commit}/${encodedPath}`;
  if (source.startLine === undefined) return base;
  return `${base}#L${String(source.startLine)}${source.endLine !== source.startLine ? `-L${String(source.endLine)}` : ''}`;
}

/**
 * Plain text rendered literally: Markdown-significant characters are
 * backslash-escaped, line-start block markers neutralized, line breaks kept
 * as hard breaks and blank-line paragraph breaks kept.
 */
function escapePlain(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '').split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.split('\n').map(escapeLine).join('\\\n'))
    .join('\n\n');
}

/**
 * Plain text embedded within a rendered line (never at a line start), so only
 * inline Markdown syntax needs escaping.
 */
function escapePlainInline(text: unknown): string {
  return escapeInline(String(text).replace(/\r?\n/g, ' '));
}

function escapeLine(line: string): string {
  return escapeInline(line)
    .replace(/^(\s*)([-+=])/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])/, '$1\\$2');
}

/**
 * Escapes inline Markdown syntax in plain text and renders plain-text
 * @mentions as code spans: the characters stay exact, but plain text never
 * turns into a notification when a person later submits the draft. (Host
 * mention handling inside code spans is not live-verified.)
 */
function escapeInline(text: string): string {
  return text.split(MENTION).map((part, i) => (i % 2 === 1 ? codeSpan(part) : part.replace(INLINE_MARKDOWN, '\\$&'))).join('');
}

/** A CommonMark code span whose delimiter is longer than any backtick run inside. */
function codeSpan(text: string): string {
  const fence = '`'.repeat(longestRun(text, '`') + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function longestRun(text: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const c of text) {
    current = c === character ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

// ---------------------------------------------------------------------------
// Artifact locations and URIs (RFC 3986 references; SARIF 3.4, 3.10, 3.14.14)

/**
 * Resolves an artifactLocation (directly or through run.artifacts) to a
 * normalized repository-relative path, or { error: [code, message] }.
 * Interpretation only: nothing named by a URI is ever read.
 */
function resolveArtifactPath(artifactLocation: ISarifArtifactLocation, runInfo: IRunInfo): ArtifactPathOutcome {
  let effective = artifactLocation;
  if (artifactLocation.index !== undefined) {
    const artifact = (runInfo.run.artifacts || [])[artifactLocation.index];
    if (!artifact || !artifact.location) {
      return { error: ['artifact-index-invalid', `Artifact index ${String(artifactLocation.index)} names no artifact location.`] };
    }
    if (artifact.parentIndex !== undefined) {
      return { error: ['nested-artifact-unsupported', 'Artifacts nested inside other artifacts are not supported.'] };
    }
    if (artifactLocation.uri !== undefined && (artifactLocation.uri !== artifact.location.uri
      || artifactLocation.uriBaseId !== artifact.location.uriBaseId)) {
      return { error: ['artifact-index-conflict',
        `The location names ${JSON.stringify(artifactLocation.uri)} but artifact ${String(artifactLocation.index)} is ${JSON.stringify(artifact.location.uri)}.`] };
    }
    effective = artifact.location;
  }
  if (typeof effective.uri !== 'string') return { error: ['uri-invalid', 'The artifact location has no URI.'] };

  const reference = parseReference(effective.uri);
  if (reference.error) return reference;
  let located: IRootedReference;
  if (reference.root !== undefined) {
    located = reference;
  } else if (effective.uriBaseId !== undefined) {
    const base = resolveBase(effective.uriBaseId, runInfo, new Set());
    if (base.error) return base;
    located = { root: base.root, segments: [...base.segments, ...reference.segments] };
  } else {
    return finishPath(reference.segments);
  }
  for (const root of runInfo.roots) {
    if (root.root === located.root && root.segments.every((s, i) => located.segments[i] === s)) {
      return finishPath(located.segments.slice(root.segments.length));
    }
  }
  return located.root.startsWith('base:')
    ? { error: ['uri-base-unresolved', `URI base ${located.root.slice(5)} is not a known repository root.`] }
    : { error: ['uri-outside-repository', `${effective.uri} is not inside a known repository root.`] };
}

function finishPath(segments: readonly string[]): ArtifactPathOutcome {
  if (segments.length === 0) return { error: ['uri-invalid', 'The URI names the repository root, not a file.'] };
  return { path: segments.join('/') };
}

/**
 * Resolves a uriBaseId to { root, segments }. A base with no URI value is an
 * abstract named root ("base:ID"), meaningful only if the run maps it to the
 * repository. Chains are followed; cycles and invalid bases block.
 */
function resolveBase(id: string, runInfo: IRunInfo, visited: Set<string>): ResolvedBase {
  if (visited.has(id)) return { error: ['uri-base-unresolved', `URI base ${id} refers to itself in a cycle.`] };
  visited.add(id);
  const entry = (runInfo.run.originalUriBaseIds || {})[id];
  if (!entry || entry.uri === undefined) {
    if (entry && entry.uriBaseId !== undefined) return resolveBase(entry.uriBaseId, runInfo, visited);
    return { root: `base:${id}`, segments: [] };
  }
  const base = parseBaseUri(entry.uri);
  if (base.error) return base;
  if (base.root !== undefined) return base;
  if (entry.uriBaseId === undefined) {
    return { error: ['uri-base-invalid', `URI base ${id} is relative but names no base of its own.`] };
  }
  const parent = resolveBase(entry.uriBaseId, runInfo, visited);
  if (parent.error) return parent;
  return { root: parent.root, segments: [...parent.segments, ...base.segments] };
}

/** Resolves a provenance mappedTo artifactLocation to a repository root. */
function resolveBaseLocation(location: ISarifArtifactLocation, runInfo: IRunInfo): ResolvedBase {
  if (location.uri === undefined) {
    return location.uriBaseId === undefined
      ? { error: ['uri-invalid', 'mappedTo names neither a URI nor a URI base.'] }
      : resolveBase(location.uriBaseId, runInfo, new Set());
  }
  const base = parseBaseUri(location.uri);
  if (base.error || base.root !== undefined) return base;
  if (location.uriBaseId === undefined) {
    return { error: ['uri-base-invalid', 'A relative mappedTo URI needs a URI base.'] };
  }
  const parent = resolveBase(location.uriBaseId, runInfo, new Set());
  if (parent.error) return parent;
  return { root: parent.root, segments: [...parent.segments, ...base.segments] };
}

/** Parses a base URI, which must end in "/". */
function parseBaseUri(uri: unknown): ParsedReference {
  if (typeof uri !== 'string' || !uri.endsWith('/')) {
    return { error: ['uri-base-invalid', `Base URI ${JSON.stringify(uri)} must end with "/".`] };
  }
  const parsed = parseReference(uri.slice(0, -1) || '.', { allowEmptyPath: true, base: true });
  return parsed;
}

/**
 * Parses a URI reference into decoded path segments: relative references
 * (root undefined) or absolute file: URIs (root "file:<authority>"). Other
 * schemes, queries, fragments, absolute-path references, empty or dot
 * segments, encoded separators and invalid percent-encoding are errors.
 */
function parseReference(
  uri: string,
  { base = false }: { readonly base?: boolean; readonly allowEmptyPath?: boolean } = {},
): ParsedReference {
  if (uri === '') return { error: ['uri-invalid', 'The URI is empty.'] };
  if (/[\\\u0000-\u001f\u007f]/.test(uri)) return { error: ['uri-invalid', `${JSON.stringify(uri)} contains a backslash or control character.`] };
  if (/[?#]/.test(uri)) return { error: ['uri-invalid', `${JSON.stringify(uri)} has a query or fragment.`] };
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri);
  let root: string | undefined;
  let path = uri;
  if (scheme) {
    const schemeName = groupOf(scheme, 1);
    if (schemeName.toLowerCase() !== 'file') {
      return { error: ['uri-scheme-unsupported', `URI scheme ${schemeName} is not supported; only repository paths and file: URIs are.`] };
    }
    const rest = uri.slice(scheme[0].length);
    if (!rest.startsWith('//')) return { error: ['uri-invalid', `${uri} is not a hierarchical file: URI.`] };
    const slash = rest.indexOf('/', 2);
    const authority = slash === -1 ? rest.slice(2) : rest.slice(2, slash);
    if (authority !== '' && authority.toLowerCase() !== 'localhost') {
      return { error: ['uri-invalid', `file: URI authority ${authority} is not supported.`] };
    }
    root = 'file:';
    path = slash === -1 ? '' : rest.slice(slash + 1);
    if (path === '') return { root, segments: [] };
  } else if (uri.startsWith('/')) {
    return { error: ['uri-invalid', `${uri} is an absolute-path reference with no defined repository root.`] };
  }
  if (base && path === '.') return { root, segments: [] };
  const segments: string[] = [];
  for (const raw of path.split('/')) {
    if (raw === '') return { error: ['uri-invalid', `${uri} has an empty path segment.`] };
    const decoded = percentDecode(raw);
    if (decoded === null) return { error: ['uri-invalid', `${uri} has invalid percent-encoding.`] };
    if (decoded === '.' || decoded === '..') return { error: ['uri-traversal', `${uri} contains a dot segment.`] };
    if (/[/\\]/.test(decoded)) return { error: ['uri-encoded-separator', `${uri} encodes a path separator.`] };
    if (decoded.includes('\0')) return { error: ['uri-invalid', `${uri} encodes a NUL character.`] };
    segments.push(decoded);
  }
  return { root, segments };
}

/** Decodes %XX sequences as UTF-8; null when malformed. */
function percentDecode(segment: string): string | null {
  if (!segment.includes('%')) return segment;
  if (/%(?![0-9A-Fa-f]{2})/.test(segment)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < segment.length;) {
    if (segment[i] === '%') {
      bytes.push(parseInt(segment.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      // i is always inside the string, so codePointAt never yields undefined;
      // NaN would reproduce fromCodePoint(undefined)'s RangeError if it did.
      const code = segment.codePointAt(i) ?? Number.NaN;
      const character = String.fromCodePoint(code);
      bytes.push(...Buffer.from(character, 'utf8'));
      i += character.length;
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFullCommit(value: unknown): value is string {
  return typeof value === 'string' && FULL_COMMIT.test(value);
}

/**
 * The element at `index` of a list whose bounds the caller has already
 * established (or the schema guarantees). Reaching the throw means an
 * internal invariant was broken.
 */
function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Internal error: index ${String(index)} is outside a list of ${String(items.length)}.`);
  return item;
}

/** A capture group that participates in every match of its expression. */
function groupOf(match: RegExpExecArray, index: number): string {
  const group = match[index];
  if (group === undefined) throw new Error(`Internal error: capture group ${String(index)} did not participate in the match.`);
  return group;
}

export { prepareReview, PRODUCT_LIMITS };
