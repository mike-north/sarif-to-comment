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
 *   readEntry?: async (commit, path) => { kind: 'file', blob, mode } |
 *                    { kind: 'absent' } | { kind: 'not-a-file', entry, path }
 *                    // trusted tree read at the same boundary: what stands
 *                    // at a path, never downloading a blob. Required with,
 *                    // and called only for, a head resolveRewrittenHead names.
 *                    // There, a readSource error whose `code` is
 *                    // 'undecodable-source' or 'source-too-large' (an edited
 *                    // file that is not source at the head) makes that
 *                    // suggestion not created instead of failing.
 *   fileExists?: async (commit, path) => boolean
 *                    // trusted existence check at the same boundary: whether
 *                    // a regular file exists there, without reading its
 *                    // content. Called only with the reviewed commit and a
 *                    // path a whole-file proposal names. Without it, the
 *                    // source reader's answer decides (which cannot read
 *                    // binary or oversized files). A thrown error is
 *                    // operational and propagates unchanged.
 *   options?: {
 *     ignoreApprovalHold?: boolean,   // bypasses only an approval hold
 *     suggestionPullRequests?: { headRef, ready, resolveRewrittenHead? },
 *                                     // enabled: whole-file proposals and
 *                                     // explicit groups become suggestion
 *                                     // pull requests into the named head
 *                                     // branch, drafts unless `ready` (it
 *                                     // words their lifecycle note).
 *                                     // `resolveRewrittenHead`: async, called
 *                                     // at most once and only when the review
 *                                     // has suggestion units; answers the pull
 *                                     // request's head when the reviewed
 *                                     // commit is not its ancestor, otherwise
 *                                     // undefined. Each suggestion is then
 *                                     // re-applied onto it only when
 *                                     // everything it changes is identical
 *                                     // there, and is otherwise not created,
 *                                     // with a warning and its reasons in the
 *                                     // review body (contract §2.5.1)
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
 *     src/replacements.cts). Source-region coordinates always use the
 *     production replacement module so feedback and fixes share one reading
 *     of SARIF regions.
 *
 * Outcome:
 *   { status: 'ready',
 *     review: { commitId, body, comments: Comment[] },
 *       Comment: { path, side, line, startSide?, startLine?, body }
 *       (the preparedReview shape accepted by publication)
 *     evidence: Evidence[],   // one per SARIF result, in SARIF order
 *     warnings: Diagnostic[], markdown: string,
 *     suggestions?: { companions, sections } }  // only when suggestion pull
 *       // requests are created: each companion's exact changes (re-applied
 *       // onto the rewritten head when there is one), title, commit message and rendered
 *       // parts, and the body's sections (text, or a companion index
 *       // rendered once its number is known); review.body is then the body
 *       // at its largest possible size, for the limits
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
 *     fileOperation?: { operation, path, fileMode?, byteLength?,
 *       proposedLines? } (a general result's whole-file proposal),
 *     suggestionPullRequest? (the suggestion carrying a general result's change),
 *     alternatives?: [{ fix, path, replacement }] (a result's further fixes as
 *       listed, each with its index in fixes[] and exact replacement),
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
 *   physical location is placed through src/placement.cts: inline when a
 *   faithful anchor on the reviewed commit exists, otherwise a general body
 *   section with an exact permalink and a literal source fence. A location
 *   without a region is whole-file general feedback.
 * - Regions follow SARIF 3.30 exactly as src/replacements.cts reads them
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
 * - Fixes: a result's first fix is its suggested change, on the reviewed
 *   head. A first fix with one artifactChange and one text replacement is a
 *   native suggestion, whose reviewed commit must be the diff head; a first
 *   fix with several changes (see suggestion pull requests below) is
 *   accepted whole. A located result's own lines must lie within its
 *   replacement lines (one of them, for a fix with several changes);
 *   otherwise the association is unsupported and blocks (feedback is never
 *   moved to a fix location, and the replacement is never enlarged). Results
 *   with identical replacements share one suggestion comment and keep every
 *   explanation and origin; overlapping different replacements block. The
 *   suggestion payload is emitted only when GitHub's observed application
 *   reproduces the exact intended file (see suggestionPayload); suggestions
 *   outside the inline diff are unsupported.
 * - Alternative fixes (issue #30): every further fix of a result is listed
 *   with the result as an alternative, in the producer's order. Nothing is
 *   chosen: the first fix is presented exactly as a single fix would be, and
 *   an ineligible first fix blocks even when a later one would be eligible.
 *   An alternative is never applied, grouped or unioned, so it takes no part
 *   in overlap and conflict checks. It must be one text replacement in one
 *   file that applies exactly to the reviewed commit (like a fix, without the
 *   native-suggestion requirements), and its replacement lines must be
 *   showable exactly in a code block (no invisible or bidirectional
 *   characters, no carriage return inside a line, no line that could open a
 *   suggestion block); line terminators are not shown. Anything else blocks
 *   at the alternative's own pointer (…/fixes/N). Alternatives are part of
 *   the item text, so they count toward every size limit.
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
 *   suppressions, an alternative fix that changes several files or makes
 *   several replacements, binary replacements, nested artifacts.
 * - Owned namespace properties.sarifToComment on runs and results: `approval`
 *   ('awaiting-approval' holds; 'ready' is a declared, unverified state) and,
 *   on results, `proposedFileChanges` and `suggestionGroup`; any other key
 *   or value blocks. Other properties are retained in evidence as
 *   uninterpreted metadata. Artifacts with contents and no proposed
 *   operation are context, reported as warnings.
 * - Whole-file proposals (docs/file-operation-publication-contract.md): one
 *   `create` or `delete` per result, naming an artifact of its run, relative
 *   to the reviewed commit. A creation is UTF-8 text (mode 100644 or 100755)
 *   whose path is absent there and that a code block plus stated details
 *   show exactly; a deletion names a file present there, of any content.
 *   Existence is checked without reading content. A creation finding's
 *   region is read in the proposed text; a deletion finding's region is
 *   quoted from the reviewed file and never narrows the deletion. Findings
 *   carrying the same proposal share one body section; conflicting
 *   proposals, and fixes on a proposed path, block. `edit` operations are
 *   unsupported: edits are SARIF fixes.
 * - Suggestion pull requests (docs/companion-suggestion-pr-contract.md): a
 *   result's owned `suggestionGroup` joins it to an explicit group of
 *   changes (each member's primary fix or whole-file proposal; at least two
 *   distinct changes; nothing inferred). A fix with several artifact changes
 *   or replacements is a group of its own (SARIF applies a fix whole): its
 *   replacements are located in the unmodified file, must be disjoint and
 *   start at different positions, and are combined per file, with
 *   replacements sharing lines merged into one whole-line change. A group
 *   member's or several-change fix's edits are exact edits of the reviewed
 *   file, committed rather than rendered, so they need no native-suggestion
 *   eligibility. Without the setting every group, and every several-change
 *   fix, blocks, naming it. With it, each group, each distinct several-change
 *   fix and each distinct standalone whole-file proposal becomes one
 *   suggestion pull request whose body section links it; native
 *   suggestions are unchanged. Every unit must be
 *   acceptable on its own: overlapping edits across units, and any change to
 *   a path another unit creates or deletes, block. At most 10 suggestion
 *   pull requests, each body within the comment limit, each created file
 *   within 1,000,000 bytes.
 *
 * Rendering:
 *   item      = message [ "\n\n**Fix:** " fix description ]
 *               [ "\n\n**Alternatives to consider:**" { "\n\n" alternative } ]
 *               "\n\n<sub>— " attribution "</sub>"
 *   alternative = "(" n ") " [ description "\n\n" ] change    (n = 1, 2, … per item)
 *   change    = "Replace " lines [ " of " code span of path ] " with:\n\n" fence "\n"
 *                 replacement lines without their final terminator "\n" fence
 *             | "Delete " lines [ " of " code span of path ] "."
 *               (the path is named only when it differs from the first fix's file)
 *   lines     = "line " N | "lines " N "-" M     (whole lines of the reviewed file)
 *   attribution = tool name [ " " version ] [ " · " extension name [ " " version ] ]
 *                 [ " · rule " code span of ruleId ]
 *   comment   = items joined by "\n\n---\n\n" [ "\n\n```suggestion\n" replacementText "```" ]
 *   section   = [ "**Source:** [" path " " lines " at " short commit "](" permalink ")\n\n"
 *                 fence "\n" source text "\n" fence "\n\n" ] item
 *   proposal  = creation: "**Proposed new file:** " code span of path "\n\n**File details:** "
 *                 facts joined by " · " [ "\n\n" fence "\n" content "\n" fence ]
 *               deletion: "**Proposed file deletion:** [" path " at " short commit "]("
 *                 permalink ")\n\nThe whole file is removed; this is not a proposal to empty it."
 *               then "\n\n" and its items joined by "\n\n---\n\n", each preceded by
 *               "**Location:** line(s) N[-M] of the proposed file\n\n" (creation) or
 *               rendered as a section with its quoted source (deletion)
 *   body      = sections and proposals joined by "\n\n---\n\n" ('' when there are none)
 *   Source and alternative fences are longer than any backtick run they
 *   enclose, and never shorter than three backticks.
 */

import * as crypto from 'node:crypto';

import type { SchemaObject, ValidateFunction } from 'ajv';
import type AjvDraft04Module = require('ajv-draft-04');
import type AjvFormatsModule = require('ajv-formats');
import type { IReviewContext, PathEntry, ProposalChange } from './github.cjs';
import { classifyPlacement } from './placement.cjs';
import type { IPlacementSourceRange, PlacementAnchorSide } from './placement.cjs';
import { applyReplacement as productionApplyReplacement } from './replacements.cjs';
import { formatSuggestionMarker } from './suggestion-marker.cjs';
import { isSuggestionGroupName } from './sarif-common.cjs';
import type {
  ColumnKind, IAppliedReplacement, IReplacementRegion, IReplacementRequest, ReplacementDiagnostic, ReplacementOutcome,
} from './replacements.cjs';
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

/**
 * SARIF artifact (3.24): contents are context unless a whole-file proposal
 * names the artifact, whose encoding, length and hashes then describe the
 * proposed bytes.
 */
interface ISarifArtifactView extends ISarifArtifact {
  readonly contents?: ISarifArtifactContent;
  readonly encoding?: string;
  readonly length?: number;
  readonly hashes?: Readonly<Record<string, string>>;
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
  readonly defaultEncoding?: string;
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
 * identity fields have exactly the review context's shape (src/github.cts);
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
 * The review context's ReadSource (src/github.cts) is one.
 */
type SnapshotReader = (commit: string, path: string) => unknown;

/**
 * The trusted existence check: whether a regular file exists at a path in a
 * full commit, without reading its content (true or false; anything else is
 * misuse). The review context's FileExists (src/github.cts) is one.
 */
type ExistenceCheck = (commit: string, path: string) => unknown;

/**
 * The trusted tree read: what stands at a path in a full commit, from its
 * trees alone (checked where it is used). The review context's ReadEntry
 * (src/github.cts) is one.
 */
type EntryReader = (commit: string, path: string) => unknown;

/**
 * Suggestion pull requests are enabled (docs/companion-suggestion-pr-contract.md):
 * `headRef` is the pull request's head branch they would target, which their
 * rendered text names, and `ready` whether they are created ready for review
 * (their lifecycle note says which).
 */
interface ISuggestionPullRequestsOption {
  readonly headRef: string;
  readonly ready: boolean;
  /**
   * Answers the pull request's head when the reviewed commit is not its
   * ancestor (the history was rewritten), otherwise undefined: suggestions
   * are then re-applied onto it, or not created
   * (docs/companion-suggestion-pr-contract.md §2.5.1). Called at most once,
   * and only when the review has suggestion units, so a review that creates
   * none never depends on it (§2.8). A rejection is operational.
   */
  readonly resolveRewrittenHead?: () => Promise<string | undefined>;
}

/** Caller options; every limit defaults to PRODUCT_LIMITS. */
interface IPrepareReviewOptions {
  readonly ignoreApprovalHold?: boolean | undefined;
  readonly maxComments?: number | undefined;
  readonly maxCommentBodyChars?: number | undefined;
  readonly maxPayloadBytes?: number | undefined;
  readonly suggestionPullRequests?: ISuggestionPullRequestsOption | undefined;
}

/** The caller input once validateCallerInput accepted it (see the module documentation). */
export interface IPrepareReviewInput {
  /** A parsed SARIF log; the schema is checked inside preparation, not at the boundary. */
  readonly sarif: Readonly<Record<string, unknown>>;
  readonly context: IPreparationContext;
  readonly readSource: SnapshotReader;
  readonly fileExists?: ExistenceCheck | undefined;
  readonly readEntry?: EntryReader | undefined;
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
  readonly suggestionPullRequests?: ISuggestionPullRequestsOption | undefined;
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

/** The Git modes a proposed new file may have. */
type ProposedFileMode = '100644' | '100755';

/**
 * A validated whole-file proposal (docs/file-operation-publication-contract.md):
 * a new file's exact text and mode, or the deletion of a file that exists at
 * the reviewed commit.
 */
type PreparedFileOperation =
  | { readonly operation: 'create'; readonly path: string; readonly fileMode: ProposedFileMode; readonly text: string }
  | { readonly operation: 'delete'; readonly path: string; readonly commit: string };

/** Lines of a proposed new file that a finding names (never lines of the reviewed snapshot). */
interface IProposedLines {
  readonly startLine: number;
  readonly endLine: number;
}

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

/**
 * A further fix of a result, listed with it as an alternative: one exact
 * replacement of the reviewed file, never applied, grouped or unioned.
 */
interface IPreparedAlternative {
  /** The fix's index in the result's fixes[] (1 or more). */
  readonly fix: number;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly originalText: string;
  readonly replacementText: string;
  /** The replacement lines as the code block shows them: without the final terminator, or the file's own byte-order mark. */
  readonly shownText: string;
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
  readonly fileOperation: PreparedFileOperation | null;
  readonly proposedLines: IProposedLines | null;
  /** The caller's suggestion group, when the result declares one. */
  readonly group: string | undefined;
  /**
   * The edits of a fix committed in a suggestion pull request rather than
   * rendered as a native suggestion: a group member's fix, or a fix with
   * several changes. One per file region, in the fix's order.
   */
  readonly edits: readonly IPreparedEdit[];
  /** Whether the result's own fix has several changes, which are accepted together as a unit of their own (when not in a group). */
  readonly jointFix: boolean;
  /** The result's further fixes, in the producer's order, listed with it (never applied). */
  readonly alternatives: readonly IPreparedAlternative[];
}

/** A committed fix's change to one region: exact whole-line replacement text for lines of the reviewed file. */
interface IPreparedEdit {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly replacementText: string;
  /** The complete reviewed file the replacement applies to. */
  readonly sourceText: string;
  /** The replaced lines at the reviewed commit. */
  readonly source: IPlacementSourceRange;
  readonly description: string | undefined;
}

/** The exact replacement-module output a suggestion presents. */
interface IReplacementEvidence {
  readonly startLine: number;
  readonly endLine: number;
  readonly originalText: string;
  readonly replacementText: string;
}

/** A further fix listed as an alternative: its index in fixes[], its file and its exact replacement. */
interface IAlternativeEvidence {
  readonly fix: number;
  readonly path: string;
  readonly replacement: IReplacementEvidence;
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
  readonly alternatives?: readonly IAlternativeEvidence[];
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

/** The whole-file proposal a general result carries, as presented. */
interface IFileOperationEvidence {
  readonly operation: 'create' | 'delete';
  readonly path: string;
  readonly fileMode?: ProposedFileMode;
  readonly byteLength?: number;
  readonly proposedLines?: IProposedLines;
}

/** A result presented as a general body section. */
interface IGeneralEvidence extends IEvidenceRecord {
  readonly treatment: 'general';
  readonly bodySectionIndex: number;
  readonly source?: EvidenceSource;
  readonly fileOperation?: IFileOperationEvidence;
  /** The index of the suggestion pull request that carries this result's change. */
  readonly suggestionPullRequest?: number;
}

/** One evidence record per SARIF result, in SARIF order. */
export type Evidence = ISuggestionEvidence | IInlineEvidence | IGeneralEvidence;

/**
 * One suggestion pull request as preparation settles it: its exact changes
 * and every text except what only its creation can supply (its number, and
 * its structured marker's identifiers).
 */
export interface IPreparedCompanion {
  readonly title: string;
  readonly commitMessage: string;
  /** One change per path, in the order paths first appear. */
  readonly changes: readonly ProposalChange[];
  /** How many distinct changes the list shows (edits of one file are listed separately). */
  readonly changeCount: number;
  /** The rendered change list ("- …" lines). */
  readonly changeLines: string;
  /** The rendered findings carrying these changes. */
  readonly items: string;
}

/** The suggestion pull requests a ready review needs, and where each appears in its body. */
export interface IPreparedSuggestions {
  readonly companions: readonly IPreparedCompanion[];
  /**
   * The review body's sections in order: literal text, or the index of the
   * companion whose section is rendered once its pull request exists.
   */
  readonly sections: readonly (string | number)[];
}

/** A complete review, ready for publication. */
export interface IReadyOutcome {
  readonly status: 'ready';
  /**
   * The review. When `suggestions` is present, `review.body` is only the
   * body at its largest possible size (each suggestion link with the largest
   * pull request number), which the limits were checked against; the body
   * sent is rendered from `suggestions.sections` once the numbers are known.
   */
  readonly review: IPreparedReview;
  readonly evidence: readonly Evidence[];
  readonly warnings: readonly IDiagnostic[];
  readonly markdown: string;
  /** Present exactly when the review needs suggestion pull requests. */
  readonly suggestions?: IPreparedSuggestions;
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
  readonly fileExists: (commit: string, path: string) => Promise<boolean>;
  /** Present exactly when suggestions may have to be re-applied onto a rewritten head. */
  readonly readEntry: ((commit: string, path: string) => Promise<PathEntry>) | null;
  readonly sourceRoot: ParsedReference | null;
}

/** One entry of proposedFileChanges: its operation name and every field as written. */
type ProposedOperationEntry = Readonly<Record<string, unknown>> & { readonly operation: string };

/** An owned property namespace, as parseOwned reads it. */
interface IOwnedProperties {
  approval: DeclaredApproval | undefined;
  proposedFileChanges: readonly ProposedOperationEntry[] | undefined;
  suggestionGroup: string | undefined;
}

/** A result's whole-file proposal, with where its finding points. */
interface IFileOperationPlacement {
  readonly operation: PreparedFileOperation;
  /** A deletion finding's quoted lines at the reviewed commit. */
  readonly placement: PreparedPlacement | null;
  /** A creation finding's lines of the proposed content. */
  readonly proposedLines: IProposedLines | null;
}

/** A rendered whole-file proposal section's path and size, named when the body is too large. */
interface IRenderedProposal {
  readonly path: string;
  readonly characters: number;
}

/** One general body section before rendering: a single finding, or a proposal and its findings. */
type BodySection =
  | { readonly kind: 'item'; readonly item: IPreparedItem }
  | { readonly kind: 'operation'; readonly operation: PreparedFileOperation; readonly items: IPreparedItem[] };

/** A body section when suggestion pull requests are in play: a single finding, or a suggestion pull request's section. */
type UnitSection = { readonly kind: 'item'; readonly item: IPreparedItem } | { readonly kind: 'suggestion'; readonly unit: number };

/** A change a suggestion pull request (or a native suggestion) proposes, as conflicts are judged. */
type UnitChange =
  | { readonly kind: 'operation'; readonly operation: PreparedFileOperation }
  | { readonly kind: 'edit'; readonly edit: IPreparedEdit };

/** Who proposes a change: a suggestion pull request by index, or a native suggestion. */
type ChangeOwner = number | 'native';

/** One suggestion pull request while the review is assembled. */
interface ISuggestionUnit {
  readonly group: string | undefined;
  readonly sectionIndex: number;
  readonly items: IPreparedItem[];
  /** Distinct changes in order of first appearance, by identity. */
  readonly changes: Map<string, UnitChange>;
}

/** What a suggestion pull request's texts name besides its own changes and findings. */
export interface ISuggestionContext {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly reviewedCommit: string;
  /** The original pull request's head branch, which the suggestion targets. */
  readonly headRef: string;
  /** Whether the suggestion is created ready for review instead of as a draft (its lifecycle note says which). */
  readonly ready: boolean;
  /** The commit the suggestion is re-applied onto after a rewritten history, when it is (§2.5.1). */
  readonly reappliedOnto?: string;
}

/**
 * What the unit-based assembly produces (meaningful only when no error was
 * reported); `suggestions` is absent when no suggestion pull request is
 * created, because every one was not re-applied (§2.5.1).
 */
interface IUnitAssembly {
  readonly review: IPreparedReview;
  readonly evidence: Evidence[];
  readonly sectionCount: number;
  readonly suggestions?: IPreparedSuggestions;
}

/** Whether one suggestion pull request is created (re-applied onto a head, with that head's edited files) or not. */
type UnitDecision =
  | { readonly kind: 'created'; readonly headTexts: ReadonlyMap<string, string> }
  | { readonly kind: 'not-created'; readonly reasons: readonly string[] };

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
const OWNED_RESULT_KEYS: ReadonlySet<string> = new Set(['approval', 'proposedFileChanges', 'suggestionGroup']);

/** Suggestion pull requests one review may create (docs/companion-suggestion-pr-contract.md §2.8). */
const MAX_SUGGESTION_PULL_REQUESTS = 10;

/** Bytes one created or edited file in a suggestion pull request may hold: the source-read limit. */
const MAX_SUGGESTION_FILE_BYTES = 1_000_000;

/** The largest pull request number GitHub issues (a 32-bit signed integer): sizing uses its length. */
const LARGEST_PULL_NUMBER = 2_147_483_647;

/** A v4 UUID's shape, used only to size a suggestion marker before its identifiers exist. */
const SIZING_UUID = '00000000-0000-4000-8000-000000000000';

/** Title length GitHub accepts for a pull request. */
const MAX_TITLE = 256;

/** Declared approval states; anything else in the owned namespace is invalid. */
const APPROVAL_HOLD = 'awaiting-approval';
const APPROVAL_READY = 'ready';

/** Fields of a proposedFileChanges entry this version interprets (D23); any other may change its meaning. */
const OPERATION_FIELDS: ReadonlySet<string> = new Set(['operation', 'artifactIndex', 'fileMode']);

/** The mode of a proposed new file when none is stated, as extraction writes it. */
const DEFAULT_FILE_MODE: ProposedFileMode = '100644';

/** SARIF hash algorithm names (3.24.11) whose digest of the proposed bytes is verified. */
const VERIFIABLE_HASHES: ReadonlyMap<string, string> = new Map([
  ['sha-256', 'sha256'], ['sha-1', 'sha1'], ['sha-384', 'sha384'], ['sha-512', 'sha512'], ['md5', 'md5'],
]);

/** Byte-order mark: kept in a proposed file, stated in its details rather than shown. */
const BOM = '\uFEFF';

/**
 * Characters a rendered code block cannot show exactly: C0 controls other
 * than tab, LF and CR; DEL and C1 controls; a byte-order mark; the Arabic
 * letter mark and the bidirectional marks, embeddings, overrides and
 * isolates, which reorder text invisibly; and the line and paragraph
 * separators.
 */
const INVISIBLE_IN_CONTENT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/;

/** The same, plus tab, LF and CR: a path is shown on one line, in a code span or link text. */
const INVISIBLE_IN_PATH = /[\u0000-\u001F\u007F-\u009F\uFEFF\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/;

/** A UTF-16 surrogate without its pair: not a Unicode scalar value, so not UTF-8 text. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

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

  const cachedSource = cachedReader(readSource);
  const state: IPreparationState = {
    context,
    options,
    report,
    applyFix: (internals && internals.applyReplacement) || productionApplyReplacement,
    readSource: cachedSource,
    fileExists: existenceCheck(input.fileExists === undefined ? undefined : cachedReader(input.fileExists), cachedSource),
    readEntry: input.readEntry === undefined ? null : entryReader(cachedReader(input.readEntry)),
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

  // Units (suggestion pull requests) are needed only for explicit groups and
  // fixes with several changes, or for whole-file proposals when suggestion
  // pull requests are enabled; every other review is assembled exactly as it
  // always was.
  const enabled = options.suggestionPullRequests;
  const needsUnits = items.some((item) => item.group !== undefined || item.jointFix)
    || (enabled !== undefined && items.some((item) => item.fileOperation !== null));
  if (needsUnits) {
    const units = await assembleWithSuggestions(items, state);
    if (report.errors.length > 0) return blocked(report);
    enforceLimits(units.review, [], state);
    if (report.errors.length > 0) return blocked(report);
    return {
      status: 'ready',
      review: units.review,
      evidence: units.evidence,
      warnings: report.warnings,
      markdown: readyMarkdown(units.review, units.sectionCount, report),
      ...(units.suggestions === undefined ? {} : { suggestions: units.suggestions }),
    };
  }

  const assembled = assemble(items, state);
  if (report.errors.length > 0) return blocked(report);
  enforceLimits(assembled.review, assembled.proposals, state);
  if (report.errors.length > 0) return blocked(report);

  return {
    status: 'ready',
    review: assembled.review,
    evidence: assembled.evidence,
    warnings: report.warnings,
    markdown: readyMarkdown(assembled.review, assembled.sectionCount, report),
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
  const fileExists = input['fileExists'];
  if (fileExists !== undefined && typeof fileExists !== 'function') fail('`fileExists` must be a function (commit, path) => Promise<boolean>.');
  const options = input['options'];
  if (options !== undefined) {
    if (!isPlainObject(options)) fail('`options` must be an object.');
    for (const key of ['maxComments', 'maxCommentBodyChars', 'maxPayloadBytes']) {
      const value = options[key];
      if (value !== undefined && !(typeof value === 'number' && Number.isInteger(value) && value > 0)) fail(`\`options.${key}\` must be a positive integer.`);
    }
    const hold = options['ignoreApprovalHold'];
    if (hold !== undefined && typeof hold !== 'boolean') fail('`options.ignoreApprovalHold` must be a boolean.');
    const suggestions = options['suggestionPullRequests'];
    if (
      suggestions !== undefined &&
      !(isPlainObject(suggestions) && typeof suggestions['headRef'] === 'string' && suggestions['headRef'] !== '' && typeof suggestions['ready'] === 'boolean')
    ) {
      fail('`options.suggestionPullRequests` must be { headRef, ready } naming the pull request\'s head branch and whether they are created ready for review.');
    }
    const resolve = isPlainObject(suggestions) ? suggestions['resolveRewrittenHead'] : undefined;
    if (resolve !== undefined && typeof resolve !== 'function') {
      fail('`options.suggestionPullRequests.resolveRewrittenHead` must be a function () => Promise<commit | undefined>.');
    }
  }
}

/**
 * Whether a regular file exists at a path in a commit: the caller's existence
 * check when given, which reads no content; otherwise whether the source
 * reader finds the file. An answer of the wrong type is caller misuse.
 */
function existenceCheck(
  check: ((commit: string, path: string) => Promise<unknown>) | undefined,
  readSource: (commit: string, path: string) => Promise<unknown>,
): (commit: string, path: string) => Promise<boolean> {
  if (check === undefined) {
    return async (commit, path) => {
      const text = await readSource(commit, path);
      if (text === null || text === undefined) return false;
      if (typeof text !== 'string') throw new TypeError(`readSource(${commit}, ${path}) returned a non-string.`);
      return true;
    };
  }
  return async (commit, path) => {
    const exists = await check(commit, path);
    if (typeof exists !== 'boolean') throw new TypeError(`fileExists(${commit}, ${path}) returned a non-boolean.`);
    return exists;
  };
}

/**
 * The caller's tree read, with its answer checked: an entry of a known kind
 * with well-formed fields. Anything else is caller misuse.
 */
function entryReader(read: (commit: string, path: string) => Promise<unknown>): (commit: string, path: string) => Promise<PathEntry> {
  return async (commit, path) => {
    const entry = await read(commit, path);
    if (isPathEntry(entry)) return entry;
    throw new TypeError(`readEntry(${commit}, ${path}) returned an answer that is not a path entry.`);
  };
}

/** Whether an answer of the caller's tree read is a PathEntry (see src/github.cts). */
function isPathEntry(value: unknown): value is PathEntry {
  if (!isPlainObject(value)) return false;
  switch (value['kind']) {
    case 'absent':
      return true;
    case 'file':
      return isFullCommit(value['blob']) && (value['mode'] === '100644' || value['mode'] === '100755');
    case 'not-a-file':
      return ['a directory', 'a symbolic link', 'a submodule'].includes(String(value['entry'])) && typeof value['path'] === 'string';
    default:
      return false;
  }
}

/** Reads each (commit, path) snapshot at most once. */
function cachedReader(readSource: SnapshotReader | ExistenceCheck | EntryReader): (commit: string, path: string) => Promise<unknown> {
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

/**
 * A whole-review block for problems found outside the SARIF (the repository
 * facts suggestion pull requests need), rendered exactly as preparation's own
 * blocks, keeping a ready preparation's warnings.
 */
function blockedBy(diagnostics: readonly IDiagnostic[], warnings: readonly IDiagnostic[]): IBlockedOutcome {
  const report = new Report();
  for (const d of diagnostics) report.error(d.code, d.pointer, d.message);
  for (const w of warnings) report.warn(w.code, w.pointer, w.message);
  return blocked(report);
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

function readyMarkdown(review: IPreparedReview, sections: number, report: Report): string {
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
    // `executionSuccessful` is required by the SARIF 2.1.0 schema
    // (vendor/sarif-schema-2.1.0.json, invocation.required), and the document
    // has already been validated against it, so it is always a boolean here
    // and this is equivalent to the literal `=== false` comparison.
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
  const outcome: IOwnedProperties = { approval: undefined, proposedFileChanges: undefined, suggestionGroup: undefined };
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
      outcome.proposedFileChanges = operations;
    }
  }
  const group = owned['suggestionGroup'];
  if (group !== undefined && allowedKeys.has('suggestionGroup')) {
    if (isSuggestionGroupName(group)) {
      outcome.suggestionGroup = group;
    } else {
      state.report.error('suggestion-group-invalid', pointer,
        `properties.${OWNED_NAMESPACE}.suggestionGroup must be 1-100 characters without control or invisible formatting characters or surrounding whitespace.`);
    }
  }
  return outcome;
}

/** Whether a proposedFileChanges entry is an object naming its operation. */
function isProposedOperation(value: unknown): value is ProposedOperationEntry {
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
  let suggestion: IPreparedSuggestion | null = null;
  let edits: readonly IPreparedEdit[] = [];
  let fileOperation: IFileOperationPlacement | null = null;
  const fixes: readonly ISarifFix[] | null = Array.isArray(result.fixes) && result.fixes.length > 0 ? result.fixes : null;
  let alternatives: readonly IPreparedAlternative[] = [];
  const operations = owned.proposedFileChanges || [];
  const group = owned.suggestionGroup;
  // A single fix with several changes applies them together (SARIF 3.55):
  // it is accepted whole, as a group of its own. With alternatives, the
  // alternatives refusal comes first, as it always has.
  const changeCount = fixes && fixes.length === 1 ? fixChangeCount(itemAt(fixes, 0)) : 0;
  const jointFix = operations.length === 0 && group === undefined && changeCount > 1;
  if (operations.length > 0) {
    // A whole-file proposal decides how its finding's location is read: a
    // created file's lines are in the proposed content, never the reviewed
    // snapshot, and a deletion is never narrowed to a line.
    fileOperation = await prepareFileOperation(operations, locations.length === 1 ? onlyLocation : undefined, fixes !== null, pointer, runInfo, state);
    placement = fileOperation ? fileOperation.placement : null;
  } else {
    if (locations.length === 1 && onlyLocation !== undefined) placement = await placeLocation(onlyLocation, pointer, runInfo, state);
    // The first fix is the result's suggested change, whatever follows it.
    // A group member's fix, and a fix with several changes, is committed in a
    // suggestion pull request, so it needs exact edits, not native-suggestion
    // eligibility. Without suggestion pull requests, a fix with several
    // changes cannot be published at all: it is refused, naming the setting.
    if (jointFix && state.options.suggestionPullRequests === undefined) {
      report.error('fix-changes-require-suggestion-prs', pointer,
        `The fix makes ${String(changeCount)} changes that apply together (a SARIF fix is accepted whole), which needs a suggestion pull request. `
        + 'Enable suggestion pull requests (options.allowSuggestionPullRequests or --allow-suggestion-prs); a fix is never split into separate suggestions or published in part.');
    } else if (fixes && (group !== undefined || jointFix)) {
      edits = await prepareFixEdits(itemAt(fixes, 0), pointer, runInfo, state) ?? [];
    } else if (fixes) {
      suggestion = await prepareFix(itemAt(fixes, 0), pointer, runInfo, state);
    }
    // Every further fix is listed as an alternative, never chosen instead.
    if (fixes) alternatives = await prepareAlternatives(fixes, suggestion ? suggestion.path : singlePath(edits), pointer, runInfo, state);
  }
  // D3/D4: a result's explanation travels with its fix only when the result's
  // own source lies within the fix's replacement lines (one of them, for a fix
  // with several changes); it is never moved to the fix location, and the
  // replacement is never enlarged to reach it.
  const replaced: readonly Pick<IPreparedSuggestion, 'path' | 'startLine' | 'endLine' | 'source'>[] = suggestion ? [suggestion] : edits;
  if (replaced.length > 0 && placement && !replaced.some((r) => sourceWithin(placement.source, r))) {
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
    fixDescription: suggestion ? suggestion.description : edits[0]?.description,
    attribution,
    approval,
    uninterpretedProperties: Object.keys(uninterpreted).length > 0 ? uninterpreted : undefined,
    taxa: Array.isArray(result.taxa) && result.taxa.length > 0 ? result.taxa : undefined,
    placement,
    suggestion,
    fileOperation: fileOperation ? fileOperation.operation : null,
    proposedLines: fileOperation ? fileOperation.proposedLines : null,
    group,
    edits,
    jointFix,
    alternatives,
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

/** Whether a located source range lies within a replacement's lines of the same file and revision. */
function sourceWithin(source: EvidenceSource, suggestion: Pick<IPreparedSuggestion, 'path' | 'startLine' | 'endLine' | 'source'>): boolean {
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
// Whole-file proposals (docs/file-operation-publication-contract.md)

/**
 * Validates a result's whole-file proposal (the D23 extension extraction
 * writes) and its finding's location. A creation must name UTF-8 text that a
 * code block and its stated details reproduce exactly, at a path absent from
 * the reviewed commit; a deletion must name a file present there. Existence
 * is checked without reading content. Returns the proposal, or null after
 * recording errors.
 */
async function prepareFileOperation(
  operations: readonly ProposedOperationEntry[],
  location: ISarifLocation | undefined,
  hasFixes: boolean,
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): Promise<IFileOperationPlacement | null> {
  const { report, context } = state;
  const fail = (code: string, message: string): null => {
    report.error(code, pointer, message);
    return null;
  };
  if (operations.length > 1) {
    return fail('file-operation-multiple-unsupported',
      `The finding proposes ${String(operations.length)} file operations; one finding carries one whole-file proposal. Give each operation its own finding.`);
  }
  const entry = itemAt(operations, 0);
  const name = entry.operation;
  if (name === 'edit') {
    return fail('file-operation-unsupported', 'A proposed file edit operation is not published; propose edits as SARIF fixes.');
  }
  if (name !== 'create' && name !== 'delete') return fail('file-operation-unknown', `Unknown proposed file operation ${JSON.stringify(name)}.`);
  if (hasFixes) {
    return fail('file-operation-conflict',
      `The finding carries both fixes and a proposed file ${name === 'create' ? 'creation' : 'deletion'}; they cannot be accepted together. Keep one of them.`);
  }
  const uninterpreted = Object.keys(entry).filter((key) => !OPERATION_FIELDS.has(key));
  if (uninterpreted.length > 0) {
    return fail('file-operation-invalid',
      `The proposed ${name} has field(s) ${uninterpreted.join(', ')} that this version does not interpret; they could change what is proposed.`);
  }
  const index = entry['artifactIndex'];
  const artifact = typeof index === 'number' && Number.isInteger(index) && index >= 0 ? (runInfo.run.artifacts || [])[index] : undefined;
  if (!artifact || !artifact.location) {
    return fail('file-operation-invalid', `artifactIndex ${JSON.stringify(index)} names no artifact with a location in this run.`);
  }
  if (artifact.parentIndex !== undefined) {
    return fail('nested-artifact-unsupported', 'The proposed file is nested inside another artifact, which is not supported.');
  }
  const resolved = resolveArtifactPath(artifact.location, runInfo);
  if (resolved.error) return fail(resolved.error[0], resolved.error[1]);
  const path = resolved.path;
  const pathProblem = pathRepresentationProblem(path);
  if (pathProblem) return fail('file-operation-path-unrepresentable', `The path ${JSON.stringify(path)} ${pathProblem}.`);
  if (runInfo.provenanceError) return fail(runInfo.provenanceError[0], runInfo.provenanceError[1]);
  const reviewed = context.reviewedCommit;
  if (runInfo.sourceCommit !== reviewed) {
    return fail('file-operation-source-not-reviewed',
      `The run's source revision is ${runInfo.sourceCommit}, but a whole-file proposal is published relative to the reviewed commit ${reviewed}.`);
  }

  let operation: PreparedFileOperation;
  if (name === 'create') {
    const mode = entry['fileMode'] === undefined ? DEFAULT_FILE_MODE : entry['fileMode'];
    if (mode !== '100644' && mode !== '100755') {
      return fail('file-operation-invalid', `File mode ${JSON.stringify(mode)} is not a regular file mode (100644 or 100755).`);
    }
    const contents = artifact.contents;
    if (contents && contents.binary !== undefined) {
      return fail('file-operation-binary-unsupported', `${path}: binary contents cannot be presented as a proposed file.`);
    }
    if (!contents || typeof contents.text !== 'string') return fail('file-operation-invalid', `${path}: the proposed file has no text contents.`);
    const encoding = artifact.encoding !== undefined ? artifact.encoding : runInfo.run.defaultEncoding;
    if (encoding !== undefined && !/^utf-?8$/i.test(encoding)) {
      return fail('file-operation-encoding-unsupported', `${path}: encoding ${encoding} describes bytes other than the UTF-8 text a review can show.`);
    }
    const text = contents.text;
    const contentProblem = contentRepresentationProblem(text);
    if (contentProblem) {
      return fail('file-operation-content-unrepresentable', `${path}: ${contentProblem}, so the review could not show the proposed file exactly.`);
    }
    const described = describedBytesProblem(artifact, Buffer.from(text, 'utf8'));
    if (described) return fail('file-operation-invalid', `${path}: ${described}.`);
    if (await state.fileExists(reviewed, path)) {
      return fail('file-operation-target-exists', `${path} already exists at ${reviewed}; a proposed new file must not replace it.`);
    }
    operation = { operation: 'create', path, fileMode: mode, text };
  } else {
    if (entry['fileMode'] !== undefined) return fail('file-operation-invalid', 'A deletion does not take a file mode.');
    if (artifact.contents !== undefined || artifact.length !== undefined || artifact.hashes !== undefined) {
      return fail('file-operation-invalid',
        `${path}: a deletion's artifact describes content, a length or hashes, which cannot be verified without reading the file; name only its location.`);
    }
    if (!(await state.fileExists(reviewed, path))) {
      return fail('file-operation-target-missing', `${path} does not exist at ${reviewed}, so it cannot be deleted.`);
    }
    operation = { operation: 'delete', path, commit: reviewed };
  }

  const located = await locateFileOperationFinding(location, operation, pointer, runInfo, state);
  return located && { operation, ...located };
}

/**
 * Where a finding carrying a whole-file proposal points: nowhere (no
 * location, or no region), lines of the proposed content (a creation), or
 * quoted lines of the reviewed file (a deletion; context only). The location
 * must name the proposed file. Returns null after recording errors.
 */
async function locateFileOperationFinding(
  location: ISarifLocation | undefined,
  operation: PreparedFileOperation,
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): Promise<Pick<IFileOperationPlacement, 'placement' | 'proposedLines'> | null> {
  const none = { placement: null, proposedLines: null };
  if (location === undefined) return none;
  const fail = (code: string, message: string): null => {
    state.report.error(code, pointer, message);
    return null;
  };
  const physical = location.physicalLocation;
  if (!physical || !physical.artifactLocation) {
    return fail('location-without-physical-source', 'Only physical source locations are supported; this location has no artifact.');
  }
  const resolved = resolveArtifactPath(physical.artifactLocation, runInfo);
  if (resolved.error) return fail(resolved.error[0], resolved.error[1]);
  if (resolved.path !== operation.path) {
    return fail('file-operation-association-unsupported',
      `The finding is located in ${resolved.path} but proposes ${operation.operation === 'create' ? 'creating' : 'deleting'} ${operation.path}; `
      + 'presenting them together would move the feedback. Locate the finding in the proposed file, or separate it from the proposal.');
  }
  if (physical.region === undefined) return none;
  if (runInfo.newlineError) return fail(runInfo.newlineError[0], runInfo.newlineError[1]);
  if (operation.operation === 'create') {
    const span = resolveSourceRegion(operation.text, physical.region, runInfo.columnKind);
    if (span.error) return fail(span.error[0], `${operation.path} (proposed content): ${span.error[1]}`);
    return { placement: null, proposedLines: { startLine: span.startLine, endLine: span.endLine } };
  }
  const text = await state.readSource(operation.commit, operation.path);
  if (typeof text !== 'string') throw new TypeError(`readSource(${operation.commit}, ${operation.path}) returned no text for a file that exists.`);
  const span = resolveSourceRegion(text, physical.region, runInfo.columnKind);
  if (span.error) return fail(span.error[0], `${operation.path} at ${operation.commit}: ${span.error[1]}`);
  // Placement supplies the exact quoted lines; a deletion finding is always
  // general feedback, so any inline anchor it offers is not used.
  const outcome = classifyPlacement({
    source: { commit: operation.commit, path: operation.path, text },
    range: { startLine: span.startLine, endLine: span.endLine },
    diff: state.context.diff,
  });
  if (outcome.kind === 'rejected') {
    const code = outcome.reason === 'invalid-range' || outcome.reason === 'range-out-of-bounds' ? 'source-range-invalid' : 'diff-context-inconsistent';
    return fail(code, `${outcome.reason}: ${outcome.message}`);
  }
  return { placement: { treatment: 'general', source: outcome.source }, proposedLines: null };
}

/** Why a path cannot be shown exactly on one line of Markdown, or null. */
function pathRepresentationProblem(path: string): string | null {
  const invisible = INVISIBLE_IN_PATH.exec(path);
  if (invisible) return `contains ${codePointName(invisible[0])}, which cannot be shown exactly`;
  if (/^\s|\s$/.test(path)) return 'begins or ends with whitespace, which Markdown does not show';
  return null;
}

/**
 * Why proposed text cannot be shown exactly as a code block plus its stated
 * details (contract §2), or null. The details state one line-ending style, a
 * leading byte-order mark and the final newline; everything else must be
 * visible text.
 */
function contentRepresentationProblem(text: string): string | null {
  const lineAt = (index: number): string => `line ${String(text.slice(0, index).split('\n').length)}`;
  const surrogate = LONE_SURROGATE.exec(text);
  if (surrogate) return `${lineAt(surrogate.index)} contains an unpaired surrogate, which is not UTF-8 text`;
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const offset = text.length - body.length;
  const invisible = INVISIBLE_IN_CONTENT.exec(body);
  if (invisible) return `${lineAt(invisible.index + offset)} contains ${codePointName(invisible[0])}, which a code block does not show`;
  const bareCr = /\r(?!\n)/.exec(body);
  if (bareCr) return `${lineAt(bareCr.index + offset)} contains a carriage return that does not end a CRLF line`;
  if (body.includes('\r\n') && /(?<!\r)\n/.test(body)) return 'it mixes CRLF and LF line endings, and its details can state only one';
  return null;
}

/** "U+XXXX" for a character, as diagnostics name invisible characters. */
function codePointName(character: string): string {
  return `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Why an artifact's declared length or verifiable hashes disagree with the
 * proposed bytes, or null. A length of -1 means unknown (SARIF 3.24.9); hash
 * algorithms outside VERIFIABLE_HASHES are not compared.
 */
function describedBytesProblem(artifact: ISarifArtifactView, bytes: Buffer): string | null {
  if (artifact.length !== undefined && artifact.length !== -1 && artifact.length !== bytes.length) {
    return `the declared length ${String(artifact.length)} differs from the ${String(bytes.length)}-byte proposed content`;
  }
  for (const [name, value] of Object.entries(artifact.hashes || {})) {
    const algorithm = VERIFIABLE_HASHES.get(name.toLowerCase());
    if (algorithm !== undefined && value.toLowerCase() !== crypto.createHash(algorithm).update(bytes).digest('hex')) {
      return `the declared ${name} hash does not match the proposed content`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fixes

/** The exact replacement a single supported SARIF fix makes to the reviewed file. */
interface IAppliedFix {
  readonly source: ILocatedSource;
  readonly edit: Extract<ReplacementOutcome, { readonly kind: 'replacement' }>;
  readonly description: string | undefined;
}

/**
 * Reads one one-change fix and applies its one replacement to the reviewed
 * file exactly: a result's first fix presented as a native suggestion, or an
 * alternative. `native` adds the native-suggestion requirement that the
 * reviewed commit is the diff head, checked in the order it always was.
 * `subject` names the fix in shape diagnostics ("This fix", or "Alternative
 * fix (N)"). Returns the applied fix, or null after recording errors at
 * `pointer`.
 */
async function applyResultFix(
  fix: ISarifFix,
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
  native: boolean,
  subject = 'This fix',
): Promise<IAppliedFix | null> {
  const { report, context } = state;
  const fail = (code: string, message: string): null => {
    report.error(code, pointer, message);
    return null;
  };
  // The schema requires at least one artifact change per fix and one
  // replacement per change. A first fix with several changes never reaches
  // here: it is accepted whole, as committed edits (prepareFixEdits). An
  // alternative's several changes are one change applied together, which
  // its listing does not present yet.
  if (fix.artifactChanges.length > 1) {
    return fail('fix-multiple-files-unsupported',
      `${subject} changes several files, which are applied together as one change; presenting a fix that changes several files is not supported yet.`);
  }
  const change = itemAt(fix.artifactChanges, 0);
  if (change.replacements.length > 1) {
    return fail('fix-multiple-replacements-unsupported',
      `${subject} makes several replacements, which are applied together as one change; presenting a fix with several replacements is not supported yet.`);
  }
  const replacement = itemAt(change.replacements, 0);
  if (replacement.insertedContent && replacement.insertedContent.binary !== undefined) {
    return fail('fix-binary-unsupported', `${subject} inserts binary content, which cannot be presented as text.`);
  }
  if (runInfo.newlineError) return fail(runInfo.newlineError[0], runInfo.newlineError[1]);
  if (runInfo.provenanceError) return fail(runInfo.provenanceError[0], runInfo.provenanceError[1]);
  if (runInfo.sourceCommit !== context.reviewedCommit) {
    return fail('suggestion-source-not-reviewed',
      `The fix edits ${runInfo.sourceCommit}, not the reviewed commit; its applicability there is unverified.`);
  }
  if (native && context.reviewedCommit !== context.diff.headCommit) {
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
  return { source, edit, description };
}

/**
 * Prepares a result's first fix as its native suggestion. Returns
 * { path, startLine, endLine, originalText, replacementText, source, description }
 * or null after recording errors.
 */
async function prepareFix(
  fix: ISarifFix,
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): Promise<IPreparedSuggestion | null> {
  const { report, context } = state;
  const fail = (code: string, message: string): null => {
    report.error(code, pointer, message);
    return null;
  };
  const applied = await applyResultFix(fix, pointer, runInfo, state, true);
  if (!applied) return null;
  const { source, edit, description } = applied;
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

/** The one file a first fix's committed edits change, or undefined when they change several (or none). */
function singlePath(edits: readonly IPreparedEdit[]): string | undefined {
  const paths = new Set(edits.map((e) => e.path));
  return paths.size === 1 ? itemAt([...paths], 0) : undefined;
}

/** How many changes a fix makes: its replacements, over every artifact change. */
function fixChangeCount(fix: ISarifFix): number {
  return fix.artifactChanges.reduce((count, change) => count + change.replacements.length, 0);
}

/** One replacement of a fix, applied alone to its file, with its exact span there. */
interface IAppliedReplacementSpan {
  readonly edit: IAppliedReplacement;
  /** The replaced span of the unmodified file, [start, end) in UTF-16 code units. */
  readonly start: number;
  readonly end: number;
  readonly insertedText: string;
}

/** A region of one file a committed fix replaces: exact whole-line replacement text for lines of the reviewed file. */
interface IRegionEdit {
  readonly startLine: number;
  readonly endLine: number;
  readonly replacementText: string;
}

/**
 * Text inserted in place of a replacement to locate its exact span in the
 * unmodified file. Private-use characters, so no real source contains it by
 * accident; a source that does is refused rather than misread.
 */
const SPAN_SENTINEL = '\uE000sarif-to-comment:span\uE000';

/**
 * Prepares a fix committed in a suggestion pull request rather than rendered:
 * a group member's primary fix, or a fix with several changes. Every
 * replacement is applied to the reviewed file exactly, as a native
 * suggestion's would be, but neither native-suggestion fidelity nor inline
 * placement applies. Returns the fix's edits (per file in the order of the
 * fix's artifact changes, then per region in line order), or null after
 * recording errors.
 */
async function prepareFixEdits(
  fix: ISarifFix,
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): Promise<IPreparedEdit[] | null> {
  const { report, context } = state;
  const fail = (code: string, message: string): null => {
    report.error(code, pointer, message);
    return null;
  };
  const replacements = fix.artifactChanges.flatMap((change) => change.replacements);
  if (replacements.some((r) => r.insertedContent && r.insertedContent.binary !== undefined)) {
    return fail('fix-binary-unsupported', 'Binary replacement content cannot be presented as a suggestion.');
  }
  if (runInfo.newlineError) return fail(runInfo.newlineError[0], runInfo.newlineError[1]);
  if (runInfo.provenanceError) return fail(runInfo.provenanceError[0], runInfo.provenanceError[1]);
  if (runInfo.sourceCommit !== context.reviewedCommit) {
    return fail('suggestion-source-not-reviewed',
      `The fix edits ${runInfo.sourceCommit}, not the reviewed commit; its applicability there is unverified.`);
  }
  // The replacements of each file, in order of first appearance. Several
  // artifact changes naming one file are one file's replacements.
  const byFile = new Map<string, { readonly source: ILocatedSource; readonly replacements: ISarifReplacement[] }>();
  for (const change of fix.artifactChanges) {
    const source = await readLocatedSource(change.artifactLocation, pointer, runInfo, state);
    if (!source) return null;
    const entry = byFile.get(source.path) ?? { source, replacements: [] };
    entry.replacements.push(...change.replacements);
    byFile.set(source.path, entry);
  }
  const description = fix.description ? resolveMessage(fix.description, undefined, runInfo.driver, pointer, state).markdown : undefined;

  const edits: IPreparedEdit[] = [];
  for (const { source, replacements: onFile } of byFile.values()) {
    const regions = fileRegionEdits(source, onFile, pointer, runInfo, state);
    if (!regions) return null;
    for (const region of regions) {
      const placed = classifyPlacement({
        source: { commit: source.commit, path: source.path, text: source.text },
        range: { startLine: region.startLine, endLine: region.endLine },
        diff: context.diff,
      });
      if (placed.kind === 'rejected') return fail('diff-context-inconsistent', `${placed.reason}: ${placed.message}`);
      edits.push({ path: source.path, ...region, sourceText: source.text, source: placed.source, description });
    }
  }
  return edits;
}

/**
 * The whole-line edits a fix's replacements of one file make together.
 *
 * Each replacement is applied alone to the unmodified file, giving its exact
 * edit and its whole-line candidate. SARIF locates every replacement of a
 * fix in the unmodified file and applies them as if in array order (the
 * reading staged extraction already uses), so their combined effect is
 * defined only when they are disjoint and no two start at the same position;
 * otherwise the fix is refused. Replacements whose candidate lines overlap
 * are merged into one edit of the union of their lines, whose text is the
 * file with exactly those replacements applied, so edits of different
 * regions never overlap and combine by line. Returns the regions in line
 * order, or null after recording errors.
 */
function fileRegionEdits(
  source: ILocatedSource,
  replacements: readonly ISarifReplacement[],
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): IRegionEdit[] | null {
  const fail = (code: string, message: string): null => {
    state.report.error(code, pointer, message);
    return null;
  };
  const unlocatable = (): null => fail('fix-replacements-unlocatable',
    `The replacements of ${source.path} in this fix cannot be located together in its text.`);
  const kinds = runInfo.columnKind === undefined ? COLUMN_KINDS : [runInfo.columnKind];
  const applied: IAppliedReplacementSpan[] = [];
  for (const replacement of replacements) {
    const insertedText = replacement.insertedContent && replacement.insertedContent.text !== undefined ? replacement.insertedContent.text : '';
    const outcomes = kinds.map((columnKind) => state.applyFix({ sourceText: source.text, deletedRegion: replacement.deletedRegion, insertedText, columnKind }));
    const edit = itemAt(outcomes, 0);
    if (outcomes.some((o) => JSON.stringify(o) !== JSON.stringify(edit))) {
      return fail('column-kind-required',
        'The run declares no columnKind and this replacement edits different text in UTF-16 code units and in Unicode code points.');
    }
    if (edit.kind !== 'replacement') return fail(`replacement-${edit.kind}`, `The replacement cannot be applied (${edit.reason}): ${edit.message}`);
    if (replacements.length === 1) return [{ startLine: edit.startLine, endLine: edit.endLine, replacementText: edit.replacementText }];
    // Source-region coordinates always use the production replacement module.
    if (source.text.includes(SPAN_SENTINEL)) return unlocatable();
    const spans = kinds.map((columnKind) => productionApplyReplacement({
      sourceText: source.text, deletedRegion: replacement.deletedRegion, insertedText: SPAN_SENTINEL, columnKind,
    }));
    const located = itemAt(spans, 0);
    if (located.kind !== 'replacement' || spans.some((o) => o.kind !== 'replacement' || o.editedText !== located.editedText)) return unlocatable();
    const start = located.editedText.indexOf(SPAN_SENTINEL);
    const end = source.text.length - (located.editedText.length - start - SPAN_SENTINEL.length);
    applied.push({ edit, start, end, insertedText });
  }

  const ordered = [...applied].sort((a, b) => a.start - b.start || a.end - b.end);
  if (ordered.some((r, i) => i > 0 && (r.start < itemAt(ordered, i - 1).end || r.start === itemAt(ordered, i - 1).start))) {
    return fail('fix-replacements-overlap',
      `Two replacements of ${source.path} in this fix overlap or start at the same position, so their combined effect is not defined. Correct the fix.`);
  }

  // Replacements whose candidate lines overlap form one region.
  const regions: IAppliedReplacementSpan[][] = [];
  let regionEnd = 0;
  for (const r of [...applied].sort((a, b) => a.edit.startLine - b.edit.startLine)) {
    const last = regions[regions.length - 1];
    if (last !== undefined && r.edit.startLine <= regionEnd) {
      last.push(r);
      regionEnd = Math.max(regionEnd, r.edit.endLine);
    } else {
      regions.push([r]);
      regionEnd = r.edit.endLine;
    }
  }
  const lines: readonly string[] = source.text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const offsetOf = (line: number): number => lines.slice(0, line - 1).reduce((n, l) => n + l.length, 0);
  return regions.map((members): IRegionEdit => {
    const startLine = Math.min(...members.map((m) => m.edit.startLine));
    const endLine = Math.max(...members.map((m) => m.edit.endLine));
    const [only] = members;
    if (members.length === 1 && only !== undefined) return { startLine, endLine, replacementText: only.edit.replacementText };
    let text = source.text;
    for (const m of [...members].sort((a, b) => b.start - a.start)) text = text.slice(0, m.start) + m.insertedText + text.slice(m.end);
    const prefix = offsetOf(startLine);
    const suffix = source.text.length - offsetOf(endLine + 1);
    return { startLine, endLine, replacementText: text.slice(prefix, text.length - suffix) };
  });
}

/**
 * Prepares a result's further fixes (fixes[1…]) as alternatives, in the
 * producer's order. Each is one exact replacement of the reviewed file, as a
 * fix is, but it is only listed: it needs no inline placement or native
 * payload, and it is never applied, so it takes no part in conflict checks.
 * Its replacement lines must be showable exactly in a code block, and its
 * path too when it differs from `primaryPath` (the first fix's file, when
 * that fix was prepared), since only then is the path named. Every
 * alternative is checked, and each problem is recorded at the alternative's
 * own pointer; the list is complete only when no problem was recorded.
 */
async function prepareAlternatives(
  fixes: readonly ISarifFix[],
  primaryPath: string | undefined,
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): Promise<readonly IPreparedAlternative[]> {
  const alternatives: IPreparedAlternative[] = [];
  for (const [index, fix] of fixes.entries()) {
    if (index === 0) continue;
    const at = `${pointer}/fixes/${String(index)}`;
    const subject = `Alternative fix (${String(index)})`;
    const applied = await applyResultFix(fix, at, runInfo, state, false, subject);
    if (!applied) continue;
    const { source, edit, description } = applied;
    // Coordinates never delete a byte-order mark, so a mark leading line 1's
    // replacement is the file's own, unchanged: it is not shown.
    const bom = edit.startLine === 1 && source.text.startsWith(BOM) && edit.replacementText.startsWith(BOM) ? BOM.length : 0;
    const shownText = edit.replacementText.slice(bom).replace(/\r?\n$/, '');
    const pathProblem = source.path === primaryPath ? null : pathRepresentationProblem(source.path);
    const problem: Problem | null = pathProblem === null ? shownTextProblem(shownText) : ['alternative-path-unrepresentable', `its file path ${pathProblem}`];
    if (problem) {
      state.report.error(problem[0], at, `${subject} cannot be shown exactly: ${problem[1]}.`);
      continue;
    }
    alternatives.push({
      fix: index,
      path: source.path,
      startLine: edit.startLine,
      endLine: edit.endLine,
      originalText: edit.originalText,
      replacementText: edit.replacementText,
      shownText,
      description,
    });
  }
  return alternatives;
}

/**
 * Why an alternative's replacement lines cannot be shown exactly in a code
 * block, as [code, reason], or null. Lines are shown, not their terminators.
 * A line that could open a suggestion block is refused as producer Markdown
 * is: only a validated first fix may create a native suggestion.
 */
function shownTextProblem(text: string): Problem | null {
  const lineAt = (index: number): string => `replacement line ${String(text.slice(0, index).split('\n').length)}`;
  const unrepresentable = (reason: string): Problem => ['alternative-content-unrepresentable', reason];
  const surrogate = LONE_SURROGATE.exec(text);
  if (surrogate) return unrepresentable(`${lineAt(surrogate.index)} contains an unpaired surrogate, which is not UTF-8 text`);
  const invisible = INVISIBLE_IN_CONTENT.exec(text);
  if (invisible) return unrepresentable(`${lineAt(invisible.index)} contains ${codePointName(invisible[0])}, which a code block does not show`);
  const bareCr = /\r(?!\n)/.exec(text);
  if (bareCr) return unrepresentable(`${lineAt(bareCr.index)} contains a carriage return that does not end a line`);
  const fence = producerFenceProblem(text);
  if (fence && fence[0] === 'producer-suggestion-fence') {
    return ['alternative-suggestion-fence', 'a line of its content could open a suggestion block, and only a validated first fix may create a native suggestion'];
  }
  return null;
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

/** The evidence fields every treatment of a result shares; absent ones are omitted. */
function evidenceRecord(item: IPreparedItem): IEvidenceRecord {
  return {
    pointer: item.pointer,
    attribution: item.attribution,
    approval: item.approval,
    ...(item.uninterpretedProperties ? { uninterpretedProperties: item.uninterpretedProperties } : {}),
    ...(item.taxa ? { taxa: item.taxa } : {}),
    ...(item.classification ? { classification: item.classification } : {}),
    ...(item.locationMessage !== undefined ? { locationMessage: item.locationMessage } : {}),
    ...(item.alternatives.length > 0 ? {
      alternatives: item.alternatives.map((a) => ({
        fix: a.fix,
        path: a.path,
        replacement: { startLine: a.startLine, endLine: a.endLine, originalText: a.originalText, replacementText: a.replacementText },
      })),
    } : {}),
  };
}

/**
 * Builds the review: inline comments in SARIF order of first appearance, with
 * identical suggestions merged and overlapping different suggestions
 * blocked; general sections in SARIF order, where every finding carrying the
 * same whole-file proposal joins the section of the first one and different
 * proposals for one path (or a fix editing a proposed path) block; one
 * evidence record per result.
 */
function assemble(
  items: readonly IPreparedItem[],
  state: IPreparationState,
): {
  readonly review: IPreparedReview;
  readonly evidence: Evidence[];
  readonly commentItems: ICommentEntry[];
  readonly sectionCount: number;
  readonly proposals: readonly IRenderedProposal[];
} {
  const { context, report } = state;
  const commentItems: ICommentEntry[] = [];
  const sections: BodySection[] = [];
  const evidence: Evidence[] = [];
  const suggestionComments = new Map<string, number>();
  /** Body section of each distinct proposal, by its identity. */
  const proposalSections = new Map<string, number>();
  /** The identity of the proposal for each proposed path. */
  const proposedPaths = new Map<string, string>();
  const suggestedPaths = new Set<string>();

  for (const item of items) {
    const record = evidenceRecord(item);
    if (item.fileOperation) {
      const operation = item.fileOperation;
      const key = proposalKey(operation);
      const other = proposedPaths.get(operation.path);
      if ((other !== undefined && other !== key) || suggestedPaths.has(operation.path)) {
        report.error('file-operation-conflict', item.pointer,
          `${operation.path} already has a different proposed change in this review; one of them must be chosen before publication.`);
        continue;
      }
      proposedPaths.set(operation.path, key);
      let index = proposalSections.get(key);
      if (index === undefined) {
        index = sections.length;
        proposalSections.set(key, index);
        sections.push({ kind: 'operation', operation, items: [] });
      }
      const section = itemAt(sections, index);
      if (section.kind === 'operation') section.items.push(item);
      evidence.push({ ...record, treatment: 'general', bodySectionIndex: index,
        ...(item.placement ? { source: item.placement.source } : {}),
        fileOperation: fileOperationEvidence(operation, item.proposedLines) });
    } else if (item.suggestion) {
      const s = item.suggestion;
      if (proposedPaths.has(s.path)) {
        report.error('file-operation-conflict', item.pointer,
          `The fix edits ${s.path}, which this review proposes to create or delete; the proposals conflict.`);
        continue;
      }
      suggestedPaths.add(s.path);
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
      sections.push({ kind: 'item', item });
    }
  }

  const rendered = sections.map((section) => (section.kind === 'item'
    ? renderSection(section.item, context)
    : renderProposalSection(section.operation, section.items, context)));
  const proposals = sections.flatMap((section, i): IRenderedProposal[] => (section.kind === 'operation'
    ? [{ path: section.operation.path, characters: itemAt(rendered, i).length }] : []));

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
    review: { commitId: context.reviewedCommit, body: rendered.join(SEPARATOR), comments },
    evidence,
    commentItems,
    sectionCount: sections.length,
    proposals,
  };
}

// ---------------------------------------------------------------------------
// Assembly with suggestion pull requests (docs/companion-suggestion-pr-contract.md)

/** The identity of a change: equal changes are shared, as equal suggestions and proposals are (R8). */
function changeKey(change: UnitChange): string {
  return change.kind === 'operation'
    ? proposalKey(change.operation)
    : JSON.stringify(['edit', change.edit.path, change.edit.startLine, change.edit.endLine, change.edit.replacementText]);
}

/** The path a change touches. */
function changePath(change: UnitChange): string {
  return change.kind === 'operation' ? change.operation.path : change.edit.path;
}

/** The changes a result carries as a unit member: its whole-file proposal, or its committed fix's edits. */
function unitChangesOf(item: IPreparedItem): UnitChange[] {
  if (item.fileOperation) return [{ kind: 'operation', operation: item.fileOperation }];
  return item.edits.map((edit): UnitChange => ({ kind: 'edit', edit }));
}

/**
 * The key of the unit a result belongs to: its group, its standalone
 * whole-file proposal, or its several-change fix. Results carrying equal
 * proposals, or equal several-change fixes, share one unit (R8).
 */
function unitKeyOf(item: IPreparedItem, changes: readonly UnitChange[]): string {
  if (item.group !== undefined) return `group:${item.group}`;
  return item.jointFix ? `fix:${JSON.stringify(changes.map(changeKey))}` : `operation:${changes.map(changeKey).join('')}`;
}

/**
 * Tracks which unit proposes what, so that every unit stays acceptable on
 * its own: a path created or deleted by one unit is changed by no other,
 * and no two units change the same lines.
 */
class ChangeRegistry {
  private readonly operations = new Map<string, { readonly owner: ChangeOwner; readonly key: string }>();
  private readonly edits = new Map<string, { readonly owner: ChangeOwner; readonly key: string; readonly startLine: number; readonly endLine: number }[]>();

  constructor(private readonly report: Report) {}

  /**
   * Admits `change` for `owner`: 'shared' when the same unit already has
   * the equal change, 'new' after registering it, or false after recording
   * the conflict.
   */
  admit(change: UnitChange, owner: ChangeOwner, pointer: string): 'new' | 'shared' | false {
    const key = changeKey(change);
    const filePath = changePath(change);
    const operation = this.operations.get(filePath);
    const pathEdits = this.edits.get(filePath) ?? [];
    if (change.kind === 'operation') {
      if (operation !== undefined && operation.owner === owner && operation.key === key) return 'shared';
      if (operation !== undefined || pathEdits.length > 0) {
        const sameUnit = (operation === undefined || operation.owner === owner) && pathEdits.every((e) => e.owner === owner);
        this.report.error('file-operation-conflict', pointer, sameUnit
          ? `${filePath} already has a different proposed change in this review; one of them must be chosen before publication.`
          : `${filePath} already has a proposed change in another part of this review; one of them must be chosen before publication.`);
        return false;
      }
      this.operations.set(filePath, { owner, key });
      return 'new';
    }
    const { startLine, endLine } = change.edit;
    if (operation !== undefined) {
      this.report.error('file-operation-conflict', pointer, `The fix edits ${filePath}, which this review proposes to create or delete; the proposals conflict.`);
      return false;
    }
    if (pathEdits.some((e) => e.owner === owner && e.key === key)) return 'shared';
    if (pathEdits.some((e) => e.startLine <= endLine && startLine <= e.endLine)) {
      this.report.error('overlapping-replacements', pointer,
        `The replacement of ${filePath} lines ${String(startLine)}-${String(endLine)} overlaps a different replacement.`);
      return false;
    }
    this.edits.set(filePath, [...pathEdits, { owner, key, startLine, endLine }]);
    return 'new';
  }
}

/**
 * Builds a review whose explicit groups and several-change fixes, and (when
 * suggestion pull requests are enabled) whose whole-file proposals, travel
 * as suggestion pull requests. Every presentation unit — an inline comment, a native
 * suggestion, a suggestion pull request — must be acceptable on its own;
 * within one unit, equal changes are shared and conflicting ones block.
 * Without the setting, every group is refused, naming the setting (a
 * several-change fix already was, when its result was prepared); nothing is
 * split. Each suggestion pull request's section takes the position of the
 * first finding carrying one of its changes.
 */
async function assembleWithSuggestions(items: readonly IPreparedItem[], state: IPreparationState): Promise<IUnitAssembly> {
  const { context, report, options } = state;
  const enabled = options.suggestionPullRequests;
  const registry = new ChangeRegistry(report);
  const commentItems: ICommentEntry[] = [];
  const sections: UnitSection[] = [];
  const evidence: Evidence[] = [];
  const units: ISuggestionUnit[] = [];
  const unitByKey = new Map<string, number>();
  const suggestionComments = new Map<string, number>();
  /** Every distinct change each group's members declared, including refused ones, by group. */
  const declared = new Map<string, Set<string>>();
  /** Each group's first member, in SARIF order. */
  const firstMember = new Map<string, string>();

  for (const item of items) {
    if (item.group === undefined || firstMember.has(item.group)) continue;
    firstMember.set(item.group, item.pointer);
    declared.set(item.group, new Set());
    if (enabled === undefined) {
      report.error('suggestion-group-requires-suggestion-prs', item.pointer,
        `Suggestion group ${JSON.stringify(item.group)} must be accepted as one unit, which needs a suggestion pull request. `
        + 'Enable suggestion pull requests (options.allowSuggestionPullRequests or --allow-suggestion-prs); a group is never split into separate suggestions or published in part.');
    }
  }

  for (const item of items) {
    const record = evidenceRecord(item);
    const changes = unitChangesOf(item);
    if (item.group !== undefined && changes.length === 0) {
      report.error('suggestion-group-member-without-change', item.pointer,
        `The finding is in suggestion group ${JSON.stringify(item.group)} but proposes no change; a group joins changes. `
        + 'Remove the finding from the group, or give it its change.');
    } else if (changes.length > 0 && (item.group !== undefined || item.fileOperation || item.jointFix)) {
      const { group } = item;
      if (group !== undefined) for (const change of changes) declared.get(group)?.add(changeKey(change));
      const key = unitKeyOf(item, changes);
      const owner = unitByKey.get(key) ?? units.length;
      const admitted = changes.map((change) => registry.admit(change, owner, item.pointer));
      if (admitted.includes(false)) continue;
      let index = unitByKey.get(key);
      if (index === undefined) {
        index = units.length;
        unitByKey.set(key, index);
        units.push({ group: item.group, sectionIndex: sections.length, items: [], changes: new Map() });
        sections.push({ kind: 'suggestion', unit: index });
      }
      const unit = itemAt(units, index);
      for (const [i, change] of changes.entries()) {
        if (admitted[i] === 'new') unit.changes.set(changeKey(change), change);
        if (enabled !== undefined && change.kind === 'operation' && change.operation.operation === 'create') {
          const bytes = Buffer.byteLength(change.operation.text, 'utf8');
          if (bytes > MAX_SUGGESTION_FILE_BYTES) {
            report.error('suggestion-file-too-large', item.pointer,
              `${change.operation.path}: the proposed file is ${String(bytes)} bytes; a suggestion pull request carries at most ${String(MAX_SUGGESTION_FILE_BYTES)} bytes per file.`);
          }
        }
      }
      unit.items.push(item);
      evidence.push({ ...record, treatment: 'general', bodySectionIndex: unit.sectionIndex,
        ...(item.placement ? { source: item.placement.source } : {}),
        ...(item.fileOperation ? { fileOperation: fileOperationEvidence(item.fileOperation, item.proposedLines) } : {}),
        suggestionPullRequest: index });
    } else if (item.suggestion) {
      const s = item.suggestion;
      const key = JSON.stringify([s.path, s.startLine, s.endLine, s.replacementText]);
      let index = suggestionComments.get(key);
      if (index === undefined) {
        const native: UnitChange = {
          kind: 'edit',
          edit: { path: s.path, startLine: s.startLine, endLine: s.endLine, replacementText: s.replacementText, sourceText: '', source: s.source, description: s.description },
        };
        if (registry.admit(native, 'native', item.pointer) === false) continue;
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
      evidence.push({ ...record, treatment: 'inline', commentIndex: index, source: item.placement.source, anchor: item.placement.anchor });
    } else {
      evidence.push({ ...record, treatment: 'general', bodySectionIndex: sections.length,
        ...(item.placement ? { source: item.placement.source } : {}) });
      sections.push({ kind: 'item', item });
    }
  }

  for (const [group, changes] of declared) {
    if (changes.size < 2) {
      report.error('suggestion-group-single-change', firstMember.get(group),
        `Suggestion group ${JSON.stringify(group)} holds only one distinct change; a group needs at least two changes to accept together. `
        + 'Remove the group, and the change is published on its own.');
    }
  }
  const comments: PreparedComment[] = commentItems.map((entry) => {
    const body = entry.items.map(renderItem).join(SEPARATOR);
    return { ...entry.coordinates, body: entry.suggestion ? `${body}\n\n\`\`\`suggestion\n${entry.suggestion.payload}\`\`\`` : body };
  });
  const blockedAssembly: IUnitAssembly = { review: { commitId: context.reviewedCommit, body: '', comments }, evidence, sectionCount: sections.length };
  if (enabled === undefined) return blockedAssembly;

  // Ancestry is resolved only now that suggestion units exist (§2.8), even
  // when another problem already blocks, so that the limit below counts what
  // would be created and is reported with every other problem.
  const head = units.length === 0 ? undefined : await rewrittenHeadOf(enabled, context, state);
  const target: ISuggestionContext = {
    owner: context.owner, repo: context.repo, pullNumber: context.pullNumber, reviewedCommit: context.reviewedCommit, headRef: enabled.headRef,
    ready: enabled.ready, ...(head === undefined ? {} : { reappliedOnto: head }),
  };
  // After a rewritten history each unit is re-applied onto the head or not
  // created (contract §2.5.1); otherwise every unit is created as reviewed.
  const decisions: UnitDecision[] = [];
  for (const unit of units) decisions.push(head === undefined ? { kind: 'created', headTexts: new Map() } : await reapplication(unit, head, state));
  const created = units.flatMap((_, i) => (itemAt(decisions, i).kind === 'created' ? [i] : []));
  if (created.length > MAX_SUGGESTION_PULL_REQUESTS) report.error('too-many-suggestion-prs', undefined, tooManySuggestions(created.length));
  if (report.errors.length > 0) return blockedAssembly;

  /** Each created unit's companion index, in unit order. */
  const companionOf = new Map(created.map((unitIndex, companionIndex) => [unitIndex, companionIndex]));
  const prepared = units.map((unit, i) => {
    const decision = itemAt(decisions, i);
    return prepareCompanion(unit, target, context, decision.kind === 'created' ? decision.headTexts : new Map<string, string>());
  });
  const companions = created.map((i) => itemAt(prepared, i));
  const sizingMarker = formatSuggestionMarker({ ...target, id: SIZING_UUID, batch: SIZING_UUID });
  const { maxCommentBodyChars } = options;
  for (const i of created) {
    const companion = itemAt(prepared, i);
    const size = renderSuggestionPullBody(companion, sizingMarker, target).length;
    const unit = itemAt(units, i);
    if (maxCommentBodyChars !== undefined && size > maxCommentBodyChars) {
      const subject = unit.group !== undefined ? `suggestion group ${JSON.stringify(unit.group)}` : `the proposed change to ${itemAt(companion.changes, 0).path}`;
      report.error('suggestion-body-too-large', unit.items[0]?.pointer,
        `The suggestion pull request for ${subject} would have a ${String(size)}-character body; the limit is ${String(maxCommentBodyChars)}. Nothing is truncated or split.`);
    }
  }
  if (report.errors.length > 0) return blockedAssembly;

  const notCreated = new Map<number, string>();
  for (const [i, decision] of decisions.entries()) {
    if (decision.kind === 'created' || head === undefined) continue;
    const companion = itemAt(prepared, i);
    notCreated.set(i, renderNotCreatedSection(companion, decision.reasons, head, target));
    report.warn('suggestion-pr-not-reapplied', itemAt(units, i).items[0]?.pointer,
      `The history of #${String(target.pullNumber)} was rewritten after the reviewed commit, so the suggestion pull request ${codeSpan(companion.title)} `
      + `would have to be re-applied onto commit ${codeSpan(head)}, and it cannot be: ${decision.reasons.join('; ')}. `
      + 'It is not created; its change and findings are presented in the review body.');
  }
  const parts = sections.map((section): string | number => {
    if (section.kind === 'item') return renderSection(section.item, context);
    const part = companionOf.get(section.unit) ?? notCreated.get(section.unit);
    if (part === undefined) throw new Error(`Internal error: suggestion unit ${String(section.unit)} is neither created nor presented as not created.`);
    return part;
  });
  // A result carried by a suggestion that is not created is general feedback in that suggestion's section.
  const renumbered = evidence.map((record): Evidence => {
    if (record.treatment !== 'general' || record.suggestionPullRequest === undefined) return record;
    const { suggestionPullRequest, ...rest } = record;
    const index = companionOf.get(suggestionPullRequest);
    return index === undefined ? rest : { ...rest, suggestionPullRequest: index };
  });
  if (companions.length === 0) {
    const body = parts.map(String).join(SEPARATOR);
    return { review: { commitId: context.reviewedCommit, body, comments }, evidence: renumbered, sectionCount: sections.length };
  }
  const suggestions: IPreparedSuggestions = { companions, sections: parts };
  return {
    review: { commitId: context.reviewedCommit, body: renderReviewBody(suggestions, companions.map(() => LARGEST_PULL_NUMBER), target), comments },
    evidence: renumbered,
    sectionCount: sections.length,
    suggestions,
  };
}

/**
 * The rewritten head suggestions are re-applied onto (contract §2.5.1), from
 * the caller's resolver, checked: a full commit other than the reviewed one,
 * with a tree read to compare against. Undefined when there is none.
 */
async function rewrittenHeadOf(enabled: ISuggestionPullRequestsOption, context: IPreparationContext, state: IPreparationState): Promise<string | undefined> {
  if (enabled.resolveRewrittenHead === undefined) return undefined;
  const head: unknown = await enabled.resolveRewrittenHead();
  if (head === undefined) return undefined;
  if (!isFullCommit(head) || head === context.reviewedCommit) {
    throw new TypeError('`resolveRewrittenHead` must answer a full commit other than the reviewed commit, or undefined.');
  }
  if (state.readEntry === null) throw new TypeError('`readEntry` is required to re-apply suggestions onto a rewritten head.');
  return head;
}

/**
 * Whether one suggestion pull request can be re-applied onto a rewritten head
 * (contract §2.5.1): every change must still meet exactly what was reviewed
 * there — an edited file with each replaced range byte-identical at the same
 * lines, a created path absent, a deleted file with the same blob and mode.
 * Created with the head's text of each edited file, or not created with every
 * reason, in the order of the changes.
 */
async function reapplication(unit: ISuggestionUnit, head: string, state: IPreparationState): Promise<UnitDecision> {
  const { readEntry } = state;
  if (readEntry === null) throw new TypeError('`readEntry` is required to re-apply suggestions onto a rewritten head.');
  const reasons: string[] = [];
  const headTexts = new Map<string, string>();
  for (const [filePath, onPath] of changesByPath(unit)) {
    const first = itemAt(onPath, 0);
    const entry = await readEntry(head, filePath);
    if (entry.kind === 'not-a-file') {
      reasons.push(`${codeSpan(entry.path)} is ${entry.entry}`);
    } else if (first.kind === 'edit') {
      if (entry.kind === 'absent') {
        reasons.push(`${codeSpan(filePath)} no longer exists`);
        continue;
      }
      const read = await headSource(state, head, filePath);
      if (read.kind === 'unreadable') {
        reasons.push(`${codeSpan(filePath)} ${read.reason}`);
        continue;
      }
      const { text } = read;
      const reviewedLines = sourceLines(first.edit.sourceText);
      const headLines = sourceLines(text);
      const differing = onPath.flatMap((change) => {
        if (change.kind !== 'edit') return [];
        const { startLine, endLine } = change.edit;
        const region = (lines: readonly string[]): string => lines.slice(startLine - 1, endLine).join('');
        if (region(headLines) === region(reviewedLines)) return [];
        return [startLine === endLine
          ? `${codeSpan(filePath)} line ${String(startLine)} differs from the reviewed text`
          : `${codeSpan(filePath)} lines ${String(startLine)}-${String(endLine)} differ from the reviewed text`];
      });
      reasons.push(...differing);
      if (differing.length === 0) headTexts.set(filePath, text);
    } else if (first.operation.operation === 'create') {
      if (entry.kind === 'file') reasons.push(`${codeSpan(filePath)} already exists`);
    } else if (entry.kind === 'absent') {
      reasons.push(`${codeSpan(filePath)} no longer exists`);
    } else {
      const reviewed = await readEntry(first.operation.commit, filePath);
      if (reviewed.kind !== 'file' || reviewed.blob !== entry.blob || reviewed.mode !== entry.mode) {
        reasons.push(`${codeSpan(filePath)} differs from the reviewed file`);
      }
    }
  }
  return reasons.length === 0 ? { kind: 'created', headTexts } : { kind: 'not-created', reasons };
}

/** The too-many-suggestion-prs problem for `count` suggestion pull requests (contract §2.8). */
function tooManySuggestions(count: number): string {
  return `The review needs ${String(count)} suggestion pull requests; the limit is ${String(MAX_SUGGESTION_PULL_REQUESTS)}. Nothing is split or dropped.`;
}

/**
 * Why a head file's text is not source a replaced range can be compared in,
 * by the reader's error code (src/github.cts): not UTF-8, or beyond the
 * source-read limit. Such a file makes its suggestion not created; any other
 * failure stays operational.
 */
const UNREADABLE_SOURCE: Readonly<Record<string, string>> = {
  'undecodable-source': 'is not UTF-8 text at the head',
  'source-too-large': 'exceeds the source-read limit',
};

/** An edited file's text at a rewritten head, or why it cannot be compared (contract §2.5.1). */
async function headSource(
  state: IPreparationState,
  head: string,
  filePath: string,
): Promise<{ readonly kind: 'text'; readonly text: string } | { readonly kind: 'unreadable'; readonly reason: string }> {
  let text: unknown;
  try {
    text = await state.readSource(head, filePath);
  } catch (err) {
    const code: unknown = err instanceof Error ? Reflect.get(err, 'code') : undefined;
    const reason = typeof code === 'string' && Object.hasOwn(UNREADABLE_SOURCE, code) ? UNREADABLE_SOURCE[code] : undefined;
    if (reason === undefined) throw err;
    return { kind: 'unreadable', reason };
  }
  if (typeof text !== 'string') throw new TypeError(`readSource(${head}, ${filePath}) returned no text for a file that exists.`);
  return { kind: 'text', text };
}

/** A unit's changes grouped by path, in the order paths first appear. */
function changesByPath(unit: ISuggestionUnit): Map<string, UnitChange[]> {
  const byPath = new Map<string, UnitChange[]>();
  for (const change of unit.changes.values()) byPath.set(changePath(change), [...(byPath.get(changePath(change)) ?? []), change]);
  return byPath;
}

/** A file's lines, each with its terminator (a final line may have none). */
function sourceLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

/**
 * A unit's companion: its exact commit changes, title, commit message and
 * rendered parts. An edited file whose text at a rewritten head is given has
 * the same ranges replaced in that text (a re-application, contract §2.5.1);
 * otherwise in the reviewed file.
 */
function prepareCompanion(
  unit: ISuggestionUnit,
  target: ISuggestionContext,
  context: IPreparationContext,
  headTexts: ReadonlyMap<string, string>,
): IPreparedCompanion {
  const changes = [...unit.changes.values()];
  const commitChanges = [...changesByPath(unit)].map(([filePath, onPath]): ProposalChange => {
    const first = itemAt(onPath, 0);
    if (first.kind === 'operation') {
      const operation = first.operation;
      return operation.operation === 'create'
        ? { operation: 'create', path: filePath, text: operation.text, fileMode: operation.fileMode }
        : { operation: 'delete', path: filePath };
    }
    const fileEdits = onPath.flatMap((c) => (c.kind === 'edit' ? [c.edit] : []));
    return { operation: 'edit', path: filePath, text: combineEdits(headTexts.get(filePath) ?? first.edit.sourceText, fileEdits) };
  });
  const count = changes.length;
  const pull = `#${String(target.pullNumber)}`;
  const only = commitChanges.length === 1 ? itemAt(commitChanges, 0) : undefined;
  const summary = unit.group !== undefined ? `${unit.group} (${String(count)} changes)`
    : only === undefined ? `${String(count)} changes` : `${only.operation} ${only.path}`;
  const full = `Suggestion for ${pull}: ${summary}`;
  const title = full.length <= MAX_TITLE ? full : `Suggestion for ${pull}: ${String(count)} change${count === 1 ? '' : 's'}`;
  return {
    title,
    commitMessage: `${title}\n\nSuggested in a review of ${target.owner}/${target.repo} pull request ${String(target.pullNumber)} at commit ${target.reviewedCommit}`
      + `${target.reappliedOnto === undefined ? '' : `, and re-applied onto commit ${target.reappliedOnto} after the pull request's history was rewritten`}.`,
    changes: commitChanges,
    changeCount: count,
    changeLines: changes.map((change) => changeLine(change, context)).join('\n'),
    items: unit.items.map((item) => renderSuggestionItem(item, context)).join(SEPARATOR),
  };
}

/**
 * The reviewed file with non-overlapping whole-line replacements applied:
 * each replaces exactly its lines, in any order of the list (applied from
 * the last line up, so earlier line numbers stay valid).
 */
function combineEdits(sourceText: string, fileEdits: readonly IPreparedEdit[]): string {
  const lines = sourceLines(sourceText);
  for (const edit of [...fileEdits].sort((a, b) => b.startLine - a.startLine)) {
    lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, edit.replacementText);
  }
  return lines.join('');
}

/** One line of a suggestion's change list (contract §2.11). */
function changeLine(change: UnitChange, context: IPreparationContext): string {
  if (change.kind === 'edit') {
    const { edit } = change;
    const lines = edit.startLine === edit.endLine ? `line ${String(edit.startLine)}` : `lines ${String(edit.startLine)}-${String(edit.endLine)}`;
    return `- Edited [${escapePlainInline(edit.path)} ${lines} at ${edit.source.commit.slice(0, 7)}](${permalink(context, edit.source)})`;
  }
  const { operation } = change;
  if (operation.operation === 'create') return `- New file ${codeSpan(operation.path)}: ${fileFacts(operation.text, operation.fileMode)}`;
  const source: IWholeFileSource = { commit: operation.commit, path: operation.path };
  return `- Deleted file [${escapePlainInline(operation.path)} at ${operation.commit.slice(0, 7)}](${permalink(context, source)}): the whole file is removed`;
}

/** A finding in a suggestion's section: its lines of a proposed file, or its quoted reviewed source. */
function renderSuggestionItem(item: IPreparedItem, context: IPreparationContext): string {
  const lines = item.proposedLines;
  if (!lines) return renderSection(item, context);
  const named = lines.startLine === lines.endLine ? `line ${String(lines.startLine)}` : `lines ${String(lines.startLine)}-${String(lines.endLine)}`;
  return `**Location:** ${named} of the proposed file\n\n${renderItem(item)}`;
}

/** "Merging … into HEAD applies this change:" or "… these N changes together:". */
function mergeSentence(companion: IPreparedCompanion, subject: string, headRef: string): string {
  const what = companion.changeCount === 1 ? 'this change' : `these ${String(companion.changeCount)} changes together`;
  return `Merging ${subject} into ${codeSpan(headRef)} applies ${what}:`;
}

/**
 * The paragraph that says a suggestion was re-applied onto a rewritten head
 * (contract §2.11), naming what it was rewritten after: "that commit" in the
 * suggestion's own body, whose first line names it, "the reviewed commit" in
 * the review. Empty when it was not re-applied.
 */
function reappliedParagraph(target: ISuggestionContext, after: string): string {
  if (target.reappliedOnto === undefined) return '';
  const pull = `#${String(target.pullNumber)}`;
  return `The history of ${pull} was rewritten after ${after}, so this change is re-applied onto commit ${target.reappliedOnto}, `
    + `the head of ${pull} when it was proposed, where everything it changes is still exactly as reviewed.\n\n`;
}

/** A suggestion pull request's section of the review body, once its number is known. */
function renderSuggestionSection(companion: IPreparedCompanion, number: number, target: ISuggestionContext): string {
  const link = `https://${GITHUB_HOST}/${encodeLinkSegment(target.owner)}/${encodeLinkSegment(target.repo)}/pull/${String(number)}`;
  return `**Suggestion pull request:** [#${String(number)}](${link})\n\n${reappliedParagraph(target, 'the reviewed commit')}`
    + `${mergeSentence(companion, 'it', target.headRef)}\n\n${companion.changeLines}\n\n${companion.items}`;
}

/**
 * The review-body section of a suggestion that is not created because it
 * could not be re-applied onto a rewritten head (contract §2.5.1, §2.11):
 * every reason, then the change and the findings, at the section's place.
 */
function renderNotCreatedSection(companion: IPreparedCompanion, reasons: readonly string[], head: string, target: ISuggestionContext): string {
  const pull = `#${String(target.pullNumber)}`;
  const what = companion.changeCount === 1 ? 'this change' : `these ${String(companion.changeCount)} changes together`;
  return `**Suggestion pull request not created:** the history of ${pull} was rewritten after the reviewed commit, `
    + `and this change cannot be re-applied onto commit ${head}, the head of ${pull}, because there:\n\n${reasons.map((r) => `- ${r}`).join('\n')}`
    + `\n\nIt would have proposed ${what}:\n\n${companion.changeLines}\n\n${companion.items}`;
}

/**
 * The review body: its sections in order, each suggestion's section rendered
 * with its pull request number (`numbers[i]` for companion i).
 */
function renderReviewBody(suggestions: IPreparedSuggestions, numbers: readonly number[], target: ISuggestionContext): string {
  return suggestions.sections
    .map((part) => (typeof part === 'string' ? part : renderSuggestionSection(itemAt(suggestions.companions, part), itemAt(numbers, part), target)))
    .join(SEPARATOR);
}

/**
 * The brief lifecycle note every suggestion pull request body carries
 * (docs/companion-suggestion-pr-contract.md §2.11; docs/suggestion-pr-convention.md §8):
 * how a draft becomes mergeable, who decides, and when it can be closed.
 */
function lifecycleNote(target: ISuggestionContext): string {
  const pull = `#${String(target.pullNumber)}`;
  const branch = codeSpan(target.headRef);
  const accepted = target.ready
    ? `it is a pull request into ${branch}, the branch of ${pull}. The author of ${pull} decides whether to merge it`
    : `it is a draft pull request into ${branch}, the branch of ${pull}. A draft cannot be merged: someone with write access first marks it ready for review. The author of ${pull} then decides whether to merge it`;
  return `**How this suggestion is accepted:** ${accepted}, and ${pull} carries the change to its base. Once ${pull} is merged or closed, this pull request can be closed.`;
}

/** A suggestion pull request's body, ending with its structured marker line. */
function renderSuggestionPullBody(companion: IPreparedCompanion, marker: string, target: ISuggestionContext): string {
  return `Suggested in a review of #${String(target.pullNumber)} at commit ${target.reviewedCommit}.`
    + `\n\n${reappliedParagraph(target, 'that commit')}${mergeSentence(companion, 'this pull request', target.headRef)}\n\n${companion.changeLines}\n\n${lifecycleNote(target)}`
    + `${SEPARATOR}${companion.items}\n\n${marker}`;
}

/** The identity of a proposal: equal proposals share one section (R8). */
function proposalKey(operation: PreparedFileOperation): string {
  return JSON.stringify(operation.operation === 'create'
    ? ['create', operation.path, operation.fileMode, operation.text]
    : ['delete', operation.path]);
}

function fileOperationEvidence(operation: PreparedFileOperation, proposedLines: IProposedLines | null): IFileOperationEvidence {
  if (operation.operation === 'delete') return { operation: 'delete', path: operation.path };
  return {
    operation: 'create',
    path: operation.path,
    fileMode: operation.fileMode,
    byteLength: Buffer.byteLength(operation.text, 'utf8'),
    ...(proposedLines ? { proposedLines } : {}),
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

/**
 * Enforces the product limits on the complete prepared review; never
 * truncates. A body over its limit names each whole-file proposal's share.
 */
function enforceLimits(review: IPreparedReview, proposals: readonly IRenderedProposal[], state: IPreparationState): void {
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
    const shares = proposals.map((p) => `${p.path} (${String(p.characters)} characters)`);
    report.error('body-too-large', undefined,
      `The review body is ${String(review.body.length)} characters; the limit is ${String(maxCommentBodyChars)}.`
      + (shares.length === 0 ? '' : ` Whole-file proposals in the body: ${shares.join(', ')}.`)
      + ' Nothing is truncated or split.');
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
  const primaryPath = item.suggestion ? item.suggestion.path : singlePath(item.edits);
  const alternatives = item.alternatives.length === 0 ? ''
    : `\n\n**Alternatives to consider:**${item.alternatives.map((a, i) => `\n\n${renderAlternative(a, i + 1, primaryPath)}`).join('')}`;
  return `${status === '' ? '' : `${status}\n\n`}${item.message}${location}${fix}${alternatives}\n\n<sub>— ${renderAttribution(item.attribution)}</sub>`;
}

/**
 * One listed alternative (see the module's rendering grammar): its number,
 * its description, and its whole-line change of the reviewed file, naming
 * the file only when it is not the first fix's.
 */
function renderAlternative(alternative: IPreparedAlternative, number: number, primaryPath: string | undefined): string {
  const { startLine, endLine, path: filePath, replacementText, shownText, description } = alternative;
  const lines = startLine === endLine ? `line ${String(startLine)}` : `lines ${String(startLine)}-${String(endLine)}`;
  const where = filePath === primaryPath ? lines : `${lines} of ${codeSpan(filePath)}`;
  const change = replacementText === '' ? `Delete ${where}.` : `Replace ${where} with:\n\n${fenced(shownText)}`;
  return `(${String(number)}) ${description === undefined ? '' : `${description}\n\n`}${change}`;
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
  return `**Source:** [${escapePlainInline(source.path)} ${lines} at ${short}](${link})\n\n${fenced(source.text)}\n\n${renderItem(item)}`;
}

/**
 * A whole-file proposal's body section (contract §2): the proposal once,
 * then each finding carrying it. A creation shows its content in a fence
 * longer than any backtick run inside, with details that, together with the
 * block, determine its exact bytes; a deletion links the file at the reviewed
 * commit and never shows or narrows it.
 */
function renderProposalSection(operation: PreparedFileOperation, items: readonly IPreparedItem[], context: IPreparationContext): string {
  if (operation.operation === 'delete') {
    const source: IWholeFileSource = { commit: operation.commit, path: operation.path };
    return `**Proposed file deletion:** [${escapePlainInline(operation.path)} at ${operation.commit.slice(0, 7)}](${permalink(context, source)})\n\n`
      + `The whole file is removed; this is not a proposal to empty it.\n\n${items.map((item) => renderSection(item, context)).join(SEPARATOR)}`;
  }
  const { text, fileMode } = operation;
  const hasBom = text.startsWith(BOM);
  const body = hasBom ? text.slice(BOM.length) : text;
  const finalTerminator = body.endsWith('\r\n') ? '\r\n' : body.endsWith('\n') ? '\n' : '';
  const displayed = body.slice(0, body.length - finalTerminator.length);
  const block = body === '' ? '' : `\n\n${fenced(displayed)}`;
  const rendered = items.map((item) => {
    const lines = item.proposedLines;
    if (!lines) return renderItem(item);
    const named = lines.startLine === lines.endLine ? `line ${String(lines.startLine)}` : `lines ${String(lines.startLine)}-${String(lines.endLine)}`;
    return `**Location:** ${named} of the proposed file\n\n${renderItem(item)}`;
  });
  return `**Proposed new file:** ${codeSpan(operation.path)}\n\n**File details:** ${fileFacts(text, fileMode)}${block}\n\n${rendered.join(SEPARATOR)}`;
}

/**
 * The details of a proposed new file that, with its displayed content,
 * determine its exact bytes (docs/file-operation-publication-contract.md §2).
 */
function fileFacts(text: string, fileMode: ProposedFileMode): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  const hasBom = text.startsWith(BOM);
  const body = hasBom ? text.slice(BOM.length) : text;
  const finalTerminator = body.endsWith('\r\n') ? '\r\n' : body.endsWith('\n') ? '\n' : '';
  const facts: string[] = [];
  if (bytes === 0) {
    facts.push('empty file (0 bytes)');
  } else {
    facts.push(`${String(bytes)} byte${bytes === 1 ? '' : 's'} of UTF-8 text`);
    if (hasBom) facts.push('begins with a byte-order mark');
    if (body === '') {
      facts.push('no content after the byte-order mark');
    } else {
      facts.push(body.includes('\r\n') ? 'CRLF line endings' : body.includes('\n') ? 'LF line endings' : 'no line breaks');
      facts.push(finalTerminator === '' ? 'no newline at end of file' : 'ends with a newline');
    }
  }
  facts.push(fileMode === '100755' ? 'mode 100755 (executable)' : 'mode 100644');
  return facts.join(' · ');
}

/**
 * One URL path segment for a Markdown link destination: encodeURIComponent
 * leaves ( ) ! ' * unencoded, and an unbalanced parenthesis would end the
 * destination early, so those are percent-encoded too (RFC 3986 permits it).
 */
function encodeLinkSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[()!'*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** GitHub permalink to an exact revision, path and optional line range. */
function permalink(context: IPreparationContext, source: EvidenceSource): string {
  const encodedPath = source.path.split('/').map(encodeLinkSegment).join('/');
  const base = `https://${GITHUB_HOST}/${encodeLinkSegment(context.owner)}/${encodeLinkSegment(context.repo)}/blob/${source.commit}/${encodedPath}`;
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

/**
 * A fenced code block showing `text` literally: its backtick fence is one
 * longer than the longest backtick run inside, and never shorter than three,
 * so no line of the text can close it (GFM §4.5).
 */
function fenced(text: string): string {
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  return `${fence}\n${text}\n${fence}`;
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

export { blockedBy, codeSpan, prepareReview, PRODUCT_LIMITS, renderReviewBody, renderSuggestionPullBody };
