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
 *                              // the reviewed diff (docs/specification.md
 *                              // R13.1): from the pull request's diff base
 *                              // to reviewedCommit, so headCommit must equal
 *                              // reviewedCommit. Whether reviewedCommit is
 *                              // still the pull request's head does not
 *                              // matter here: inline anchors and native
 *                              // suggestions follow the reviewed diff.
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
 *                    // file that is not source at the head) is a reason
 *                    // that suggestion cannot be re-applied, not a failure.
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
 *     delivery?: { policy, companionOptions?, companionTarget? },
 *                                     // the resolved delivery policy
 *                                     // (src/delivery-policy.cts; the
 *                                     // defaults when absent), the caller's
 *                                     // companion options as given (for the
 *                                     // companion-options-unused note), and
 *                                     // `companionTarget`: async, called at
 *                                     // most once, the first time a unit's
 *                                     // `companion` availability is asked;
 *                                     // answers { headRef, ready,
 *                                     // unavailable?, resolveRewrittenHead? }:
 *                                     // the head branch companions target,
 *                                     // whether they are created ready, the
 *                                     // obstacles that prevent every one
 *                                     // (a fork, another base), and the
 *                                     // pull request's head when the reviewed
 *                                     // commit is not its ancestor, onto
 *                                     // which each companion is re-applied
 *                                     // only when everything it changes is
 *                                     // identical there (contract §2.5.1)
 *     maxComments?: number,           // default 100 inline comments
 *     maxCommentBodyChars?: number,   // default 60000 UTF-16 units per comment
 *                                     // body and for the review body
 *     maxPayloadBytes?: number,       // default 1,000,000 bytes of UTF-8 JSON
 *                                     // of { body, comments }
 *     presentation?: { finding?, attribution?, alternatives?, fileAddition?,
 *       fileDeletion?, lifecycleNote? } // caller callbacks returning the
 *                                     // Markdown of named components; each
 *                                     // result is checked by the core
 *                                     // (src/presentation/customization.cts),
 *                                     // and a refused one rejects with
 *                                     // TypeError
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
 *     suggestions?: { companions, sections, lifecycleNote } }  // only when the plan
 *       // has companion pull requests: each companion's exact changes
 *       // (re-applied onto the rewritten head when there is one), title,
 *       // commit message and the rendered sections of the proposals it holds
 *       // (several for a `single` bundle), and the body's sections (text, or
 *       // a reference to one proposal of one companion, rendered once its
 *       // number is known); review.body is then the body at its largest
 *       // possible size, for the limits
 *   { status: 'blocked', diagnostics: Diagnostic[], warnings: Diagnostic[], markdown: string }
 *
 *   Diagnostic: the public IDiagnostic (docs/diagnostics.md, D45), with the
 *     code's catalog severity, title and remedies and, when the problem is in
 *     the document, location.pointer, a JSON Pointer into the SARIF log (e.g.
 *     "/runs/0/results/3"). `markdown` lists every diagnostic with its code and
 *     pointer.
 *   Evidence: { pointer, treatment: 'inline'|'suggestion'|'general',
 *     commentIndex? | bodySectionIndex?, source?: { commit, path, startLine?,
 *     endLine?, text? } (always the result's own location), anchor?,
 *     fixSource?, replacement?: { startLine, endLine, originalText,
 *     replacementText } (exact replacement-module output), suggestionPayload?,
 *     attribution: { tool, version?, component?: { name, version? }, ruleId? },
 *     fileOperation?: { operation, path, fileMode?, byteLength?,
 *       proposedLines? } (a general result's whole-file proposal),
 *     suggestionPullRequest? (the companion carrying a general result's change),
 *     alternatives?: [{ fix, changes: [{ path, replacement }] }] (a result's
 *       further fixes as listed, each with its index in fixes[] and every
 *       file and exact replacement it makes, in order),
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
 * - Fixes: a result's first fix is its suggested change: its exact edits of
 *   the reviewed files. Whether a fix with one artifactChange and one text
 *   replacement can be a native suggestion (its reviewed commit is the diff
 *   head, GitHub's observed application reproduces it, its lines are on the
 *   new side of the diff) is an availability of the delivery policy, asked
 *   only when a list names `native` or `native-batch`; a first fix with
 *   several changes (see delivery below) is accepted whole. A located result's own lines must lie within its
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
 *   in overlap and conflict checks. Its replacements are read as a first
 *   fix's several changes are (fileRegionEdits): text that applies exactly
 *   to the reviewed commit, located together in the unmodified file (no two
 *   overlapping), with those on the same lines forming one whole-line change
 *   of their region. One region is listed as a single change; several are
 *   listed as one alternative with a labelled part per region. Each part's
 *   lines must be showable exactly in a code block (no invisible or bidirectional
 *   characters, no carriage return inside a line, one line-ending style, no
 *   line that could open a suggestion block), as must any path the listing
 *   names. The block shows LF line breaks; CRLF is stated beside it.
 *   Anything else blocks at the alternative's own pointer (…/fixes/N).
 *   Alternatives are part of the item text, so they count toward every size
 *   limit.
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
 *   suppressions, binary replacements, nested artifacts.
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
 * - Delivery (docs/delivery-policy-contract.md): every proposal is one
 *   delivery unit, routed by the resolved policy to one destination. A
 *   result's owned `suggestionGroup` joins it to an explicit group of changes
 *   (each member's primary fix or whole-file proposal; at least two distinct
 *   changes; nothing inferred). A fix with several artifact changes or
 *   replacements is a group of its own (SARIF applies a fix whole): its
 *   replacements are located in the unmodified file, must be disjoint and
 *   start at different positions, and are combined per file, with
 *   replacements sharing lines merged into one whole-line change. Units are
 *   an ungrouped edit (`edits`), an edit group (`groupedEdits`), an ungrouped
 *   whole-file proposal, and a group with one (`fileOperations`, as a whole).
 *   Findings carrying the identical change share its unit. Every unit must
 *   be acceptable on its own: overlapping edits across units, and any change
 *   to a path another unit creates or deletes, block. Each unit is delivered
 *   whole by the first available mechanism of its list (announced by a
 *   `delivery-fallback` warning when it is not the first), or the review is
 *   blocked (`delivery-unavailable`); availability is asked lazily. In this
 *   version a native batch (every member a native suggestion, with the
 *   group's note and the body's guidance) is offered for an explicit group
 *   of one-change members; `review-body`, `manual-group` and the mixed
 *   manual group are always unavailable (§8.8). A companion cannot be made
 *   for an unsupported pull request, a unit that cannot be re-applied onto a
 *   rewritten head, a created file over 1,000,000 bytes, or a description
 *   over the comment limit (under `single`, the bundle's). At most 10
 *   companion pull requests, after bundling. Each obstacle carries the
 *   remedy its retired refusal code gave (§8.9). A limit that blocks the
 *   review after planning names the fallbacks that put proposals where it
 *   looks (§10.1).
 *
 * Rendering. Each element is a presentation component in src/presentation/
 * (finding and finding section, attribution, alternatives, file addition,
 * file deletion, companion reference, companion description, lifecycle
 * note, native batch), with links from src/github-urls.cts; this module
 * decides what is published and where, and composes them. The contract for
 * the built-in presentation is docs/review-presentation-contract.md (with
 * docs/file-operation-publication-contract.md §2,
 * docs/companion-suggestion-pr-contract.md §2.11 and
 * docs/delivery-policy-contract.md §8.8); the summary below is a
 * reading aid, and the contract governs where they differ. (The reports about
 * a review — its outcome Markdown — list diagnostics through
 * src/presentation/warnings-list.cts.) Producer Markdown is checked with the
 * parser-based reader of src/presentation/markdown-tree.cts.
 *   item      = message [ "\n\n**Fix:** " fix description ]
 *               [ "\n\n**Alternatives to consider:**" { "\n\n" alternative } ]
 *               "\n\n<sub>— " attribution "</sub>"
 *   alternative = "(" n ") " [ description "\n\n" ] ( change | parts )   (n = 1, 2, … per item)
 *   change    = "Replace " lines [ " of " code span of path ] " with" crlf ":\n\n" block
 *             | "Delete " lines [ " of " code span of path ] "."
 *               (one replacement; the path is named only when it differs from
 *               the first fix's file)
 *   parts     = ( "Changes " N " files together:" | "Makes " N " changes together:" )
 *               { "\n\n" code span of path " — " ( "replace " lines " with" crlf ":\n\n" block
 *                 | "delete " lines "." ) }       (one per change: a region of whole lines)
 *   crlf      = " (CRLF line endings)" when the replacement's lines end with CRLF, else ""
 *   block     = fence "\n" replacement lines, LF-separated, without the final terminator "\n" fence
 *   lines     = "line " N | "lines " N "-" M     (whole lines of the reviewed file)
 *   attribution = tool name [ " " version ] [ " · " extension name [ " " version ] ]
 *                 [ " · rule " code span of ruleId ]
 *   comment   = items joined by "\n\n---\n\n" [ "\n\n" batch note ] [ "\n\n```suggestion\n" replacementText "```" ]
 *               (a native batch member's note: src/presentation/native-batch.cts)
 *   section   = [ "**Source:** [" path " " lines " at " short commit "](" permalink ")\n\n"
 *                 fence "\n" source text "\n" fence "\n\n" ] item
 *   proposal  = creation: "**Proposed new file:** " code span of path "\n\n**File details:** "
 *                 facts joined by " · " [ "\n\n" fence "\n" content "\n" fence ]
 *               deletion: "**Proposed file deletion:** [" path " at " short commit "]("
 *                 permalink ")\n\nThe whole file is removed; this is not a proposal to empty it."
 *               then "\n\n" and its items joined by "\n\n---\n\n", each preceded by
 *               "**Location:** line(s) N[-M] of the proposed file\n\n" (creation) or
 *               rendered as a section with its quoted source (deletion)
 *   body      = sections, proposals, companion references and native batch
 *               guidance joined by "\n\n---\n\n" ('' when there are none)
 *   Source and alternative fences are longer than any backtick run they
 *   enclose, and never shorter than three backticks.
 */

import * as crypto from 'node:crypto';

import type { SchemaObject, ValidateFunction } from 'ajv';
import type AjvDraft04Module = require('ajv-draft-04');
import type AjvFormatsModule = require('ajv-formats');
import type { IReviewContext, PathEntry, ProposalChange } from './github.cjs';
import { blobUrl, pullRequestUrl } from './github-urls.cjs';
import { classifyPlacement } from './placement.cjs';
import type { IPlacementSourceRange, PlacementAnchorSide } from './placement.cjs';
import { applyReplacement as productionApplyReplacement } from './replacements.cjs';
import { formatSuggestionMarker } from './suggestion-marker.cjs';
import { isSuggestionGroupName, namesRepository } from './sarif-common.cjs';
import { renderAlternative, renderAlternativeChanges, renderAlternatives } from './presentation/alternatives.cjs';
import type { IAlternative } from './presentation/alternatives.cjs';
import { renderAttribution } from './presentation/attribution.cjs';
import type { IProducerAttribution, IProducerComponent } from './presentation/attribution.cjs';
import { renderCompanionChange } from './presentation/companion-changes.cjs';
import { renderCompanionBundleDescription } from './presentation/companion-description.cjs';
import { renderBundledCompanionReference } from './presentation/companion-reference.cjs';
import type { ICompanionContent } from './presentation/companion-changes.cjs';
import { present, presentationOptionProblem } from './presentation/customization.cjs';
import type { CapturedPresentation } from './presentation/customization.cjs';
import { fileDetails, proposedContentBlock, renderFileAddition, renderProposedFileFinding } from './presentation/file-addition.cjs';
import type { ProposedFileMode } from './presentation/file-addition.cjs';
import { renderFileDeletion } from './presentation/file-deletion.cjs';
import { renderFinding, renderFindingSection } from './presentation/finding.cjs';
import type { QuotedSource } from './presentation/finding.cjs';
import { renderLifecycleNote } from './presentation/lifecycle-note.cjs';
import { renderNativeBatchGuidance, renderNativeBatchMemberNote } from './presentation/native-batch.cjs';
import { SEPARATOR, codeSpan, escapePlain, escapePlainInline, lineSpan } from './presentation/markdown.cjs';
import { composedProblem, fenceProblem, loadMarkdownParser, unbalancedHtml } from './presentation/markdown-tree.cjs';
import type { IComposedExpectation } from './presentation/markdown-tree.cjs';
import { renderDiagnosticLine, renderWarningsList } from './presentation/warnings-list.cjs';
import { createDiagnostic } from './diagnostics.cjs';
import type { DiagnosticCode, IDiagnostic } from './diagnostics.cjs';
import { deliveryRecordProblem, nameFallbackCauses, planDelivery, resolveDeliveryPolicy } from './delivery-policy.cjs';
import type {
  DeliveryPlan, DeliveryUnit, ICompanionOptions, IEditGroupMember, IFallbackDelivery, IResolvedDeliveryPolicy, MechanismAvailability,
} from './delivery-policy.cjs';
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
 * What companion suggestion pull requests need to know about the pull request
 * (docs/companion-suggestion-pr-contract.md): `headRef` is its head branch,
 * which they target and their texts name, and `ready` whether they are
 * created ready for review (their lifecycle note says which).
 */
interface ICompanionTargetFacts {
  readonly headRef: string;
  readonly ready: boolean;
  /**
   * Answers the pull request's head when the reviewed commit is not its
   * ancestor (the history was rewritten), otherwise undefined: companions
   * are then re-applied onto it, or `companion` is unavailable for the unit
   * (docs/companion-suggestion-pr-contract.md §2.5.1). Called at most once,
   * and only when the target is supported (no `unavailable` obstacle). A
   * rejection is operational.
   */
  readonly resolveRewrittenHead?: () => Promise<unknown>;
  /**
   * Why no companion pull request can be made for this pull request at all
   * (for example a fork, or a base that is not the default branch), each an
   * obstacle sentence; absent or empty when one can (§2.5).
   */
  readonly unavailable?: readonly string[];
}

/**
 * The delivery policy preparation follows (docs/delivery-policy-contract.md):
 * the resolved policy, the caller's companion options as given (for the
 * `companion-options-unused` note, §12), and how to learn the companion
 * target, asked the first time a unit's `companion` availability is (§8.7).
 */
interface IDeliveryOption {
  readonly policy: IResolvedDeliveryPolicy;
  readonly companionOptions?: ICompanionOptions | undefined;
  /** Called at most once; without it, a list that reaches `companion` is caller misuse (TypeError). */
  readonly companionTarget?: (() => Promise<ICompanionTargetFacts>) | undefined;
}

/** Caller options; every limit defaults to PRODUCT_LIMITS. */
interface IPrepareReviewOptions {
  readonly ignoreApprovalHold?: boolean | undefined;
  readonly maxComments?: number | undefined;
  readonly maxCommentBodyChars?: number | undefined;
  readonly maxPayloadBytes?: number | undefined;
  /** The delivery policy; the defaults when absent. */
  readonly delivery?: IDeliveryOption | undefined;
  /**
   * The caller's presentation callbacks (src/presentation/customization.cts):
   * each replaces the Markdown of one named component, and the core refuses
   * a result that drops required content or could disturb a suggestion block
   * or marker. Omitted components keep their built-in presentation.
   */
  readonly presentation?: CapturedPresentation | undefined;
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
  readonly delivery: IDeliveryOption;
  readonly presentation?: CapturedPresentation | undefined;
}

/** A diagnostic before it is recorded: `[code, message]`. */
type Problem = readonly [code: DiagnosticCode, message: string];

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
type IComponentIdentity = IProducerComponent;

/** Who produced a finding: tool, optional version, defining extension and rule (src/presentation/attribution.cts). */
export type IAttribution = IProducerAttribution;

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

/** One replacement of a listed alternative: an exact whole-line change of one reviewed file. */
interface IAlternativePart {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly originalText: string;
  readonly replacementText: string;
  /**
   * The replacement lines as the code block shows them: LF line breaks,
   * without the final terminator or the file's own byte-order mark.
   */
  readonly shownText: string;
  /** Whether the replacement's lines end with CRLF, which is then stated beside the block. */
  readonly crlf: boolean;
}

/**
 * A further fix of a result, listed with it as an alternative: its exact
 * replacements of reviewed files, in the producer's order, never applied,
 * grouped or unioned.
 */
interface IPreparedAlternative {
  /** The fix's index in the result's fixes[] (1 or more). */
  readonly fix: number;
  readonly parts: readonly IAlternativePart[];
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
  readonly fileOperation: PreparedFileOperation | null;
  readonly proposedLines: IProposedLines | null;
  /** The caller's suggestion group, when the result declares one. */
  readonly group: string | undefined;
  /**
   * The exact edits of the result's primary fix, one per file region, in the
   * fix's order: whatever delivers them (a native suggestion, a native batch
   * or a companion pull request) applies exactly these.
   */
  readonly edits: readonly IPreparedEdit[];
  /** Whether the result's own fix has several changes, which are accepted together as a unit of their own (when not in a group). */
  readonly jointFix: boolean;
  /** The result's further fixes, in the producer's order, listed with it (never applied). */
  readonly alternatives: readonly IPreparedAlternative[];
}

/** A fix's change to one region: exact whole-line replacement text for lines of the reviewed file. */
interface IPreparedEdit {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly replacementText: string;
  /** The replaced lines' text in the reviewed file. */
  readonly originalText: string;
  /** The complete reviewed file the replacement applies to. */
  readonly sourceText: string;
  /** The reviewed file with exactly this edit applied. */
  readonly editedText: string;
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

/** A further fix listed as an alternative: its index in fixes[], and each file and exact replacement it makes. */
interface IAlternativeEvidence {
  readonly fix: number;
  readonly changes: readonly { readonly path: string; readonly replacement: IReplacementEvidence }[];
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
  /** One change per path, in the order paths first appear, every proposal's changes of a path combined. */
  readonly changes: readonly ProposalChange[];
  /**
   * The proposals it holds, in order: one for a companion of its own,
   * several for a `single` bundle (docs/delivery-policy-contract.md §9).
   * Each is its change count, rendered change list and rendered findings.
   */
  readonly sections: readonly ICompanionContent[];
}

/** A review body section that references one proposal of one companion, rendered once its number is known. */
export interface ICompanionSectionReference {
  readonly companion: number;
  readonly section: number;
}

/** The suggestion pull requests a ready review needs, and where each appears in its body. */
export interface IPreparedSuggestions {
  readonly companions: readonly IPreparedCompanion[];
  /**
   * The review body's sections in order: literal text, or the proposal of a
   * companion whose section is rendered once its pull request exists.
   */
  readonly sections: readonly (string | ICompanionSectionReference)[];
  /**
   * The lifecycle note every suggestion pull request's body carries, as
   * presented (built in, or the caller's lifecycleNote callback) during
   * preparation, so publication never calls a presentation callback.
   */
  readonly lifecycleNote: string;
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
  /** Present exactly when the plan has companion pull requests. */
  readonly suggestions?: IPreparedSuggestions;
  /**
   * The units delivered by a fallback, in plan order: a repository check
   * that blocks the review after preparation names those that contributed
   * to it (docs/delivery-policy-contract.md §10.1, nameFallbackCauses).
   */
  readonly fallbacks: readonly IFallbackDelivery[];
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
  /** Renders prepared findings and proposals, with the caller's presentation callbacks. */
  readonly renderer: ReviewRenderer;
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

/** A body section: a single finding, or the section of a delivery unit (its proposal, companion reference or batch guidance). */
type UnitSection = { readonly kind: 'item'; readonly item: IPreparedItem } | { readonly kind: 'unit'; readonly unit: number };

/** A change a suggestion pull request (or a native suggestion) proposes, as conflicts are judged. */
type UnitChange =
  | { readonly kind: 'operation'; readonly operation: PreparedFileOperation }
  | { readonly kind: 'edit'; readonly edit: IPreparedEdit };

/** Who proposes a change: a delivery unit, by index. */
type ChangeOwner = number;

/**
 * A delivery unit while the review is assembled (docs/delivery-policy-contract.md
 * §2): an ungrouped edit, an edit group (an explicit group of edits, or a fix
 * with several changes), an ungrouped whole-file operation, or a group with
 * at least one whole-file operation. Findings carrying the identical change
 * share its unit (R8). Every unit gets exactly one destination.
 */
interface ISuggestionUnit {
  /** Set once every member is known: a group with any whole-file operation is a file-operation group, whatever its edits (D51). */
  kind: 'edit' | 'edit-group' | 'file-operation' | 'file-operation-group';
  /** The explicit group's name; undefined for any other unit. */
  readonly group: string | undefined;
  /** Whether the unit is a fix with several changes (not in a group). */
  readonly jointFix: boolean;
  /** The findings carrying its changes, in SARIF order. */
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
 * What assembly produces (meaningful only when no error was reported);
 * `suggestions` is present exactly when the plan has companion pull
 * requests.
 */
interface IUnitAssembly {
  readonly review: IPreparedReview;
  readonly evidence: Evidence[];
  readonly sectionCount: number;
  /** The whole-file proposals presented in the body, named when the body is too large. */
  readonly proposals: readonly IRenderedProposal[];
  readonly suggestions?: IPreparedSuggestions;
  /** The composed texts the checkpoint reads once the limits pass; none for a blocked assembly. */
  readonly composed: readonly IComposedUnit[];
  /** The plan's `delivery-fallback` warnings and `companion-options-unused` note, reported only when the review is ready. */
  readonly deliveryDiagnostics: readonly IDiagnostic[];
  /** The units the plan delivered by a fallback, which a later block names (docs/delivery-policy-contract.md §10.1). */
  readonly fallbacks: readonly IFallbackDelivery[];
}

/** Whether one unit can be re-applied onto a rewritten head (with that head's edited files) or not, with every reason. */
type UnitDecision =
  | { readonly kind: 'created'; readonly headTexts: ReadonlyMap<string, string> }
  | { readonly kind: 'not-created'; readonly reasons: readonly string[] };

/**
 * Whether one edit can be a native suggestion: the suggestion, or every
 * obstacle with its remedy (docs/delivery-policy-contract.md §8.9).
 */
type NativeEligibility =
  | { readonly available: true; readonly suggestion: IPreparedSuggestion }
  | { readonly available: false; readonly obstacles: readonly [string, ...string[]]; readonly remedies: readonly string[] };

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

/** A native suggestion payload, or the sentence saying why none can be emitted faithfully (an obstacle of `native`). */
type SuggestionPayload = { readonly error?: undefined; readonly text: string } | { readonly error: string };

/** The inline comment a set of items shares, with its coordinates and optional suggestion. */
interface ICommentEntry {
  readonly coordinates: CommentCoordinates;
  readonly items: IPreparedItem[];
  readonly suggestion?: IPreparedSuggestion;
  /** A line shown between the findings and the suggestion block: a native batch member's group note. */
  readonly note?: string;
}


// ---------------------------------------------------------------------------
// Constants

/** Conservative product limits on one prepared review; not claims about host maxima. */
const PRODUCT_LIMITS: Readonly<IProductLimits> = Object.freeze({ maxComments: 100, maxCommentBodyChars: 60000, maxPayloadBytes: 1000000 });

/**
 * The labels the finding component puts before producer Markdown on the same
 * line (docs/review-presentation-contract.md §2, §4); the producer checks
 * read such Markdown after its label, as composed.
 */
const LOCATION_LABEL = '**At this location:** ';
const FIX_LABEL = '**Fix:** ';
const ALTERNATIVE_LABEL = '(1) ';

/** A full, canonical Git object name; abbreviations are never prefix-matched. */
const FULL_COMMIT = /^[0-9a-f]{40}$/;

/** The property-bag namespace this product owns (D11, D23). */
const OWNED_NAMESPACE = 'sarifToComment';

/** Owned keys meaningful on a run and on a result. */
const OWNED_RUN_KEYS: ReadonlySet<string> = new Set(['approval']);
const OWNED_RESULT_KEYS: ReadonlySet<string> = new Set(['approval', 'proposedFileChanges', 'suggestionGroup']);

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
const UNSUPPORTED_RESULT_FEATURES: readonly (readonly [key: UnsupportedResultFeature, code: DiagnosticCode, label: string])[] = [
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
  // Producer Markdown and presentation callbacks are checked with the
  // CommonMark + GFM parser, an ES module loaded once here.
  await loadMarkdownParser();
  const { sarif, context, readSource } = input;
  const { delivery, ...given } = input.options || {};
  const options: IEffectiveOptions = {
    ...PRODUCT_LIMITS, ignoreApprovalHold: false, ...given, delivery: delivery ?? { policy: resolveDeliveryPolicy({}) },
  };
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
    renderer: new ReviewRenderer(context, options.presentation ?? {}),
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

  // Every proposal is a delivery unit routed by the policy
  // (docs/delivery-policy-contract.md); a review without proposals has none.
  const units = await assembleDelivery(items, state);
  if (units === null || report.errors.length > 0) return blocked(report);
  enforceLimits(units.review, units.proposals, state);
  if (report.errors.length > 0) {
    // A limit blocks a review the plan already routed; a fallback that put a
    // proposal where the limit looks is named in the error (§10.1).
    report.errors.splice(0, report.errors.length, ...nameFallbackCauses(report.errors, units.fallbacks));
    return blocked(report);
  }
  // The composed-text checkpoint reads only a review within its limits.
  checkComposed(units.composed, state);
  if (report.errors.length > 0) return blocked(report);
  // The plan's fallback warnings and note describe deliveries; a blocked
  // review delivers nothing, so only a ready one carries them (§10.1, §12).
  for (const diagnostic of units.deliveryDiagnostics) report.add(diagnostic);
  return {
    status: 'ready',
    review: units.review,
    evidence: units.evidence,
    warnings: report.warnings,
    markdown: readyMarkdown(units.review, units.sectionCount, report),
    ...(units.suggestions === undefined ? {} : { suggestions: units.suggestions }),
    fallbacks: units.fallbacks,
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
  if (diff['headCommit'] !== context['reviewedCommit']) {
    fail('`context.diff` must be the reviewed diff: its head commit must be `context.reviewedCommit`.');
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
    const delivery = options['delivery'];
    if (delivery !== undefined) {
      if (!isPlainObject(delivery)) fail('`options.delivery` must be { policy, companionOptions?, companionTarget? }.');
      const problem = deliveryRecordProblem(delivery['policy']);
      if (problem !== null) fail(`\`options.delivery.policy\` must be a resolved delivery policy: ${problem}.`);
      const target = delivery['companionTarget'];
      if (target !== undefined && typeof target !== 'function') fail('`options.delivery.companionTarget` must be a function () => Promise<{ headRef, ready, resolveRewrittenHead?, unavailable? }>.');
      const companionOptions = delivery['companionOptions'];
      if (companionOptions !== undefined && !isPlainObject(companionOptions)) fail('`options.delivery.companionOptions` must be an object.');
    }
    const presentation = options['presentation'];
    const presentationProblem = presentation === undefined ? null : presentationOptionProblem(presentation);
    if (presentationProblem !== null) fail(`options.presentation${presentationProblem}.`);
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

/** What a reported diagnostic adds to its pointer: the repository path it concerns, a subject, or remedies of its own. */
interface IReportDetails {
  readonly path?: string | undefined;
  readonly subject?: string | undefined;
  readonly remedies?: readonly string[] | undefined;
}

/** Collects blocking diagnostics and warnings for the whole review. */
class Report {
  readonly errors: IDiagnostic[];
  readonly warnings: IDiagnostic[];

  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  /** Records a blocking diagnostic at `pointer`; `details` may add a path, a subject or the case's own remedies. */
  error(code: DiagnosticCode, pointer: string | undefined, message: string, details: IReportDetails = {}): void {
    this.errors.push(createDiagnostic(code, message, { ...details, location: { pointer, path: details.path } }));
  }

  /** Records a warning at `pointer`; `details` may add a path, a subject or the case's own remedies. */
  warn(code: DiagnosticCode, pointer: string | undefined, message: string, details: IReportDetails = {}): void {
    this.warnings.push(createDiagnostic(code, message, { ...details, location: { pointer, path: details.path } }));
  }

  /** Records a diagnostic made elsewhere, such as a repository-level block (see {@link blockedBy}). */
  add(diagnostic: IDiagnostic): void {
    (diagnostic.severity === 'error' ? this.errors : this.warnings).push(diagnostic);
  }
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
  for (const d of diagnostics) report.add(d);
  for (const w of warnings) report.add(w);
  return blocked(report);
}

/**
 * The warnings section a prepared review's Markdown ends with
 * (src/presentation/warnings-list.cts); empty without warnings.
 */
function warningsSection(warnings: readonly IDiagnostic[]): string {
  return warnings.length === 0 ? '' : `\n\n${renderWarningsList(warnings)}`;
}

function warningsMarkdown(report: Report): string {
  return warningsSection(report.warnings);
}

/**
 * A ready preparation's Markdown without its warnings section: the summary
 * the CLI shows on stdout, where the warnings are diagnostics on stderr
 * instead (docs/diagnostics.md, "Streams").
 */
export function withoutWarnings(prepared: { readonly markdown: string; readonly warnings: readonly IDiagnostic[] }): string {
  const section = warningsSection(prepared.warnings);
  if (!prepared.markdown.endsWith(section)) throw new Error('Internal error: a prepared review\'s Markdown does not end with its warnings.');
  return prepared.markdown.slice(0, prepared.markdown.length - section.length);
}

function blockedMarkdown(report: Report): string {
  const count = report.errors.length;
  return `**Review blocked:** ${String(count)} problem${count === 1 ? '' : 's'} must be resolved before publication; `
    + `nothing was published.\n\n${report.errors.map(renderDiagnosticLine).join('\n')}${warningsMarkdown(report)}`;
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
      state.report.error('tool-invocation-failed', `${pointer}/invocations/${String(index)}`,
        `The tool reports that this analysis did not complete successfully, so its results may be partial.${quoted}`);
    } else if (notes.length > 0) {
      state.report.warn('tool-reported-errors', `${pointer}/invocations/${String(index)}`,
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
    info.provenanceError = ['provenance-repository-mismatch',
      'The run\'s version control provenance names only other repositories, so its locations cannot be read from this pull request.'];
  }
  const revisions = [...new Set(ours.map((p) => p.revisionId).filter((r) => r !== undefined))];
  const onlyRevision = revisions[0];
  if (revisions.some((r): boolean => !isFullCommit(r))) {
    info.provenanceError = ['provenance-revision-invalid',
      `Provenance revision ${String(revisions.find((r): boolean => !isFullCommit(r)))} is not a full 40-character commit; abbreviations are never matched.`];
  } else if (revisions.length > 1) {
    info.provenanceError = ['provenance-revision-conflict', `The run names several revisions of this repository: ${revisions.join(', ')}.`];
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
    ? resolveMessage(onlyLocation.message, rule, component || runInfo.driver, pointer, state, LOCATION_LABEL).markdown : undefined;
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
  let edits: readonly IPreparedEdit[] = [];
  let fileOperation: IFileOperationPlacement | null = null;
  const fixes: readonly ISarifFix[] | null = Array.isArray(result.fixes) && result.fixes.length > 0 ? result.fixes : null;
  let alternatives: readonly IPreparedAlternative[] = [];
  const operations = owned.proposedFileChanges || [];
  const group = owned.suggestionGroup;
  // A single fix with several changes applies them together (SARIF 3.55):
  // it is accepted whole, as a group of its own. Only the first fix counts:
  // any further fixes are alternatives, listed and never applied.
  const changeCount = fixes ? fixChangeCount(itemAt(fixes, 0)) : 0;
  const jointFix = operations.length === 0 && group === undefined && changeCount > 1;
  if (operations.length > 0) {
    // A whole-file proposal decides how its finding's location is read: a
    // created file's lines are in the proposed content, never the reviewed
    // snapshot, and a deletion is never narrowed to a line.
    fileOperation = await prepareFileOperation(operations, locations.length === 1 ? onlyLocation : undefined, fixes !== null, pointer, runInfo, state);
    placement = fileOperation ? fileOperation.placement : null;
  } else {
    if (locations.length === 1 && onlyLocation !== undefined) placement = await placeLocation(onlyLocation, pointer, runInfo, state);
    // The first fix is the result's suggested change, whatever follows it:
    // its exact edits of the reviewed files. Whether they can also be a
    // native suggestion is an availability the delivery policy asks for
    // only when a list names `native` or `native-batch` (§8.7, §8.9).
    if (fixes && changeCount === 1) {
      edits = await prepareSingleFix(itemAt(fixes, 0), pointer, runInfo, state) ?? [];
    } else if (fixes) {
      edits = await prepareFixEdits(itemAt(fixes, 0), pointer, runInfo, state) ?? [];
    }
    // Every further fix is listed as an alternative, never chosen instead.
    if (fixes) alternatives = await prepareAlternatives(fixes, pointer, runInfo, state);
  }
  // D3/D4: a result's explanation travels with its fix only when the result's
  // own source lies within the fix's replacement lines (one of them, for a fix
  // with several changes); it is never moved to the fix location, and the
  // replacement is never enlarged to reach it.
  if (edits.length > 0 && placement && !edits.some((r) => sourceWithin(placement.source, r))) {
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
    fixDescription: edits[0]?.description,
    attribution,
    approval,
    uninterpretedProperties: Object.keys(uninterpreted).length > 0 ? uninterpreted : undefined,
    taxa: Array.isArray(result.taxa) && result.taxa.length > 0 ? result.taxa : undefined,
    placement,
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
 * The producer Markdown checks read it alone and, for a message the review
 * places after a label on the same line, also after `placedAfter` (for
 * example `**Fix:** `), as it is composed: an indented or fenced line reads
 * differently in the middle of a line than at its start.
 */
function resolveMessage(
  message: ISarifMessage,
  rule: ISarifRule | undefined,
  component: ISarifComponent,
  pointer: string,
  state: IPreparationState,
  placedAfter = '',
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
  const markupProblem = producerFenceProblem(markdown) || producerHtmlProblem(markdown)
    || (placedAfter === '' ? null : producerFenceProblem(`${placedAfter}${markdown}`) || producerHtmlProblem(`${placedAfter}${markdown}`));
  if (markupProblem) {
    state.report.error(markupProblem[0], pointer, markupProblem[1]);
    return { markdown: '' };
  }
  return { markdown };
}

/**
 * Producer Markdown that leaves raw HTML open (src/presentation/markdown.cts,
 * unbalancedHtml): anything left open could hide later findings, attribution
 * or a validated suggestion when rendered, so it blocks.
 */
function producerHtmlProblem(markdown: string): Problem | null {
  const what = unbalancedHtml(markdown);
  return what === null ? null : ['producer-html-unbalanced',
    `Producer Markdown leaves ${what} open, which could hide the attribution, later findings or a suggestion that follows.`];
}

/**
 * Producer Markdown that could open a native suggestion block or leaves a
 * fence open (src/presentation/markdown.cts, fenceProblem). Only a validated
 * SARIF fix may create a native suggestion; an unclosed fence would swallow
 * the attribution and any generated suggestion that follows.
 */
function producerFenceProblem(markdown: string): Problem | null {
  switch (fenceProblem(markdown)) {
    case 'suggestion-fence':
      return ['producer-suggestion-fence',
        'Producer Markdown opens a suggestion block; only a validated SARIF fix may create a native suggestion.'];
    case 'unclosed-fence':
      return ['producer-fence-unclosed',
        'Producer Markdown leaves a code fence open, which would swallow the attribution and any suggestion that follows.'];
    case null:
      return null;
  }
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
    state.report.warn('inline-placement-unavailable', pointer,
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
  const fail = (code: DiagnosticCode, message: string): null => {
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
  const fail = (code: DiagnosticCode, message: string): null => {
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
 * Reads a result's first fix, when it makes one change, and applies its one
 * replacement to the reviewed file exactly. Returns the applied fix, or null
 * after recording errors at `pointer`.
 */
async function applyResultFix(
  fix: ISarifFix,
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): Promise<IAppliedFix | null> {
  const { report, context } = state;
  const fail = (code: DiagnosticCode, message: string): null => {
    report.error(code, pointer, message);
    return null;
  };
  // The schema requires at least one artifact change per fix and one
  // replacement per change. A first fix with several changes never reaches
  // here: it is accepted whole, as committed edits (prepareFixEdits).
  if (fixChangeCount(fix) !== 1) throw new Error('Internal error: a fix with several changes was prepared as a native suggestion.');
  const change = itemAt(fix.artifactChanges, 0);
  const replacement = itemAt(change.replacements, 0);
  if (replacement.insertedContent && replacement.insertedContent.binary !== undefined) {
    return fail('fix-binary-unsupported', 'This fix inserts binary content, which cannot be presented as text.');
  }
  const runProblem = fixRunProblem(runInfo, context);
  if (runProblem) return fail(runProblem[0], runProblem[1]);
  const source = await readLocatedSource(change.artifactLocation, pointer, runInfo, state);
  if (!source) return null;

  const description = fix.description ? resolveMessage(fix.description, undefined, runInfo.driver, pointer, state, FIX_LABEL).markdown : undefined;
  const edit = applyExactly(source.text, replacement, runInfo, state);
  if (edit.problem) return fail(edit.problem[0], edit.problem[1]);
  return { source, edit: edit.edit, description };
}

/** Why a run's fixes cannot be read against the reviewed commit, as [code, message], or null. */
function fixRunProblem(runInfo: IRunInfo, context: IPreparationContext): Problem | null {
  if (runInfo.newlineError) return runInfo.newlineError;
  if (runInfo.provenanceError) return runInfo.provenanceError;
  if (runInfo.sourceCommit !== context.reviewedCommit) {
    return ['suggestion-source-not-reviewed', `The fix edits ${runInfo.sourceCommit}, not the reviewed commit; its applicability there is unverified.`];
  }
  return null;
}

/**
 * Applies one text replacement to a reviewed file exactly, through the
 * replacement module, in every column unit the run allows (without a
 * declared columnKind both must agree). Returns the edit or the problem.
 */
function applyExactly(
  sourceText: string,
  replacement: ISarifReplacement,
  runInfo: IRunInfo,
  state: IPreparationState,
): { readonly edit: IAppliedFix['edit']; readonly problem?: undefined } | { readonly problem: Problem } {
  const insertedText = replacement.insertedContent && replacement.insertedContent.text !== undefined
    ? replacement.insertedContent.text : '';
  const kinds = runInfo.columnKind === undefined ? COLUMN_KINDS : [runInfo.columnKind];
  const outcomes = kinds.map((columnKind) => state.applyFix({
    sourceText, deletedRegion: replacement.deletedRegion, insertedText, columnKind,
  }));
  const edit = itemAt(outcomes, 0);
  if (outcomes.some((o) => JSON.stringify(o) !== JSON.stringify(edit))) {
    return { problem: ['column-kind-required',
      'The run declares no columnKind and this replacement edits different text in UTF-16 code units and in Unicode code points.'] };
  }
  if (edit.kind !== 'replacement') {
    return { problem: [`replacement-${edit.kind}`, `The replacement cannot be applied (${edit.reason}): ${edit.message}`] };
  }
  return { edit };
}

/**
 * Prepares a result's first fix, when it makes one change, as its exact edit
 * of the reviewed file. Returns the edit, or null after recording errors.
 * Whether it can also be a native suggestion is decided only when asked
 * ({@link nativeEligibility}).
 */
async function prepareSingleFix(
  fix: ISarifFix,
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): Promise<IPreparedEdit[] | null> {
  const { report, context } = state;
  const applied = await applyResultFix(fix, pointer, runInfo, state);
  if (!applied) return null;
  const { source, edit, description } = applied;
  const { startLine, endLine, originalText, replacementText, editedText } = edit;
  const placed = classifyPlacement({
    source: { commit: source.commit, path: source.path, text: source.text },
    range: { startLine, endLine },
    diff: context.diff,
  });
  if (placed.kind === 'rejected') {
    report.error('diff-context-inconsistent', pointer, `${placed.reason}: ${placed.message}`);
    return null;
  }
  return [{ path: source.path, startLine, endLine, replacementText, originalText, sourceText: source.text, editedText, source: placed.source, description }];
}

/**
 * The remedies of native suggestions' obstacles (docs/delivery-policy-contract.md
 * §8.9): what each retired refusal code told the author to do, without its
 * "enable suggestion pull requests", which listing another mechanism replaced.
 */
const NATIVE_REMEDIES = Object.freeze({
  notHead: 'Review the pull request\'s head commit, and publish that review.',
  unreproducible: 'Change the replacement.',
  notInline: 'Remove the fix.',
});

/**
 * Whether one exact edit can be a native suggestion
 * (docs/delivery-policy-contract.md §8.9): the reviewed commit is the pull
 * request's head, GitHub's observed application of the suggestion reproduces
 * exactly the intended file, and the lines are on the new side of the diff,
 * checked in that order. The suggestion when it can; otherwise every
 * obstacle, each the sentence the condition always had, with its remedy.
 */
function nativeEligibility(edit: IPreparedEdit, context: IPreparationContext): NativeEligibility {
  const unavailable = (obstacle: string, remedy: string): NativeEligibility => ({ available: false, obstacles: [obstacle], remedies: [remedy] });
  if (context.reviewedCommit !== context.diff.headCommit) {
    return unavailable('The reviewed commit is not the pull request head, so a native suggestion could not be applied to the reviewed text.', NATIVE_REMEDIES.notHead);
  }
  const { path: filePath, startLine, endLine, originalText, replacementText } = edit;
  const payload = suggestionPayload(edit.sourceText, startLine, endLine, replacementText, edit.editedText);
  if (payload.error !== undefined) return unavailable(payload.error, NATIVE_REMEDIES.unreproducible);
  const placed = classifyPlacement({
    source: { commit: edit.source.commit, path: filePath, text: edit.sourceText },
    range: { startLine, endLine },
    diff: context.diff,
  });
  if (placed.kind !== 'inline' || placed.anchor.side !== 'RIGHT' || placed.anchor.commit_id !== context.reviewedCommit) {
    return unavailable(
      `Lines ${String(startLine)}-${String(endLine)} of ${filePath} cannot carry a native suggestion (${placed.kind === 'inline' ? placed.anchor.side : placed.reason}).`,
      NATIVE_REMEDIES.notInline,
    );
  }
  return {
    available: true,
    suggestion: { path: filePath, startLine, endLine, originalText, replacementText, payload: payload.text, source: placed.source, description: edit.description },
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

/** A region of one file a fix replaces: exact whole-line replacement text for lines of the reviewed file. */
interface IRegionEdit {
  readonly startLine: number;
  readonly endLine: number;
  readonly replacementText: string;
  /** The replaced lines' text in the reviewed file. */
  readonly originalText: string;
  /** The reviewed file with exactly this region's replacements applied. */
  readonly editedText: string;
}

/**
 * Text inserted in place of a replacement to locate its exact span in the
 * unmodified file. Private-use characters, so no real source contains it by
 * accident; a source that does is refused rather than misread.
 */
const SPAN_SENTINEL = '\uE000sarif-to-comment:span\uE000';

/**
 * Prepares a first fix with several changes as its exact edits, whatever
 * delivers them: every replacement is applied to the reviewed file exactly,
 * as a native suggestion's would be. Whether each edit could also be a
 * native suggestion (fidelity and inline placement) is asked only when a
 * list names `native-batch` (docs/delivery-policy-contract.md §8.7).
 * Returns the fix's edits (per file in the order of the fix's artifact
 * changes, then per region in line order), or null after recording errors.
 */
async function prepareFixEdits(
  fix: ISarifFix,
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): Promise<IPreparedEdit[] | null> {
  const { report, context } = state;
  const fail = (code: DiagnosticCode, message: string): null => {
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
  const description = fix.description ? resolveMessage(fix.description, undefined, runInfo.driver, pointer, state, FIX_LABEL).markdown : undefined;

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
  const fail = (code: DiagnosticCode, message: string): null => {
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
    if (replacements.length === 1) {
      return [{ startLine: edit.startLine, endLine: edit.endLine, replacementText: edit.replacementText, originalText: edit.originalText, editedText: edit.editedText }];
    }
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
    if (members.length === 1 && only !== undefined) {
      return { startLine, endLine, replacementText: only.edit.replacementText, originalText: only.edit.originalText, editedText: only.edit.editedText };
    }
    let text = source.text;
    for (const m of [...members].sort((a, b) => b.start - a.start)) text = text.slice(0, m.start) + m.insertedText + text.slice(m.end);
    const prefix = offsetOf(startLine);
    const suffix = source.text.length - offsetOf(endLine + 1);
    return { startLine, endLine, replacementText: text.slice(prefix, text.length - suffix), originalText: lines.slice(startLine - 1, endLine).join(''), editedText: text };
  });
}

/**
 * Prepares a result's further fixes (fixes[1…]) as alternatives, in the
 * producer's order. An alternative is only listed, never applied: it needs
 * no inline placement or native payload and takes no part in conflict
 * checks, so a fix changing several files or making several replacements is
 * listed too, one labelled part per change. Each replacement must apply
 * exactly to the reviewed file, and its lines, its line-ending style and any
 * path the listing names must be showable exactly. Every alternative is
 * checked; its first problem is recorded at its own pointer, and the list is
 * complete only when no problem was recorded.
 */
async function prepareAlternatives(
  fixes: readonly ISarifFix[],
  pointer: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): Promise<readonly IPreparedAlternative[]> {
  // The one file the first fix changes, resolved without reading, whether or
  // not that fix could be prepared (undefined when it changes several): a
  // one-part alternative names its file only when it differs, so only then
  // is its path shown and checked.
  const firstPaths = itemAt(fixes, 0).artifactChanges.map((change) => resolveArtifactPath(change.artifactLocation, runInfo));
  const resolvedPaths = new Set(firstPaths.flatMap((resolved) => (resolved.error ? [] : [resolved.path])));
  const primaryPath = resolvedPaths.size === 1 && firstPaths.every((resolved) => !resolved.error) ? itemAt([...resolvedPaths], 0) : undefined;
  const alternatives: IPreparedAlternative[] = [];
  for (const [index, fix] of fixes.entries()) {
    if (index === 0) continue;
    const at = `${pointer}/fixes/${String(index)}`;
    const subject = `Alternative fix (${String(index)})`;
    const alternative = await prepareAlternative(fix, index, subject, primaryPath, at, runInfo, state);
    if (alternative !== null) alternatives.push(alternative);
  }
  return alternatives;
}

/** One alternative's parts, or null after recording its first problem at `at`. */
async function prepareAlternative(
  fix: ISarifFix,
  index: number,
  subject: string,
  primaryPath: string | undefined,
  at: string,
  runInfo: IRunInfo,
  state: IPreparationState,
): Promise<IPreparedAlternative | null> {
  const fail = (code: DiagnosticCode, message: string): null => {
    state.report.error(code, at, message);
    return null;
  };
  const replacements = fix.artifactChanges.flatMap((change) => change.replacements);
  if (replacements.some((r) => r.insertedContent !== undefined && r.insertedContent.binary !== undefined)) {
    return fail('fix-binary-unsupported', `${subject} inserts binary content, which cannot be shown as text.`);
  }
  const runProblem = fixRunProblem(runInfo, state.context);
  if (runProblem) return fail(runProblem[0], runProblem[1]);
  // Its replacements are read exactly as a first fix's several changes are
  // (fileRegionEdits): per file, in order of first appearance, and those
  // whose lines overlap form one whole-line change of their region.
  const byFile = new Map<string, { readonly source: ILocatedSource; readonly replacements: ISarifReplacement[] }>();
  for (const change of fix.artifactChanges) {
    const source = await readLocatedSource(change.artifactLocation, at, runInfo, state);
    if (!source) return null;
    const entry = byFile.get(source.path) ?? { source, replacements: [] };
    entry.replacements.push(...change.replacements);
    byFile.set(source.path, entry);
  }
  const regions: { readonly source: ILocatedSource; readonly region: IRegionEdit }[] = [];
  for (const { source, replacements: onFile } of byFile.values()) {
    const fileRegions = fileRegionEdits(source, onFile, at, runInfo, state);
    if (!fileRegions) return null;
    regions.push(...fileRegions.map((region) => ({ source, region })));
  }
  const parts: IAlternativePart[] = [];
  for (const { source, region } of regions) {
    const lines: readonly string[] = source.text.match(/[^\n]*\n|[^\n]+$/g) || [];
    // Coordinates never delete a byte-order mark, so a mark leading line
    // 1's replacement is the file's own, unchanged: it is not shown.
    const bom = region.startLine === 1 && source.text.startsWith(BOM) && region.replacementText.startsWith(BOM) ? BOM.length : 0;
    const text = region.replacementText.slice(bom);
    const named = regions.length > 1 || source.path !== primaryPath;
    const pathProblem = named ? pathRepresentationProblem(source.path) : null;
    const problem: Problem | null = pathProblem === null ? shownTextProblem(text) : ['alternative-path-unrepresentable', `the file path ${pathProblem}`];
    if (problem) return fail(problem[0], `${subject} cannot be shown exactly: ${problem[1]}.`);
    parts.push({
      path: source.path,
      startLine: region.startLine,
      endLine: region.endLine,
      originalText: lines.slice(region.startLine - 1, region.endLine).join(''),
      replacementText: region.replacementText,
      shownText: text.replace(/\r?\n$/, '').replace(/\r\n/g, '\n'),
      crlf: text.includes('\r\n'),
    });
  }
  const description = fix.description ? resolveMessage(fix.description, undefined, runInfo.driver, at, state, ALTERNATIVE_LABEL).markdown : undefined;
  return { fix: index, parts, description };
}

/**
 * Why an alternative's replacement lines cannot be shown exactly as a code
 * block plus a stated line-ending style, as [code, reason], or null. The
 * block shows the lines with LF breaks; CRLF is stated beside it, so the
 * lines must use one style. A line that could open a suggestion block is
 * refused as producer Markdown is: only a validated first fix may create a
 * native suggestion.
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
  if (text.includes('\r\n') && /(?<!\r)\n/.test(text)) return unrepresentable('it mixes CRLF and LF line endings, and only one style can be stated');
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
  const block = (message: string): SuggestionPayload => ({ error: message });
  if (replacementText.includes('```')) {
    return block(
      'GitHub applied a nested ``` suggestion as a deletion; this replacement cannot be a native suggestion.');
  }
  const payloadLines = replacementText === '' ? [] : replacementText.replace(/\r?\n$/, '').split(/\r?\n/);
  if (payloadLines.length > 0 && payloadLines.every((line) => /^[ \t]*$/.test(line))) {
    return block(
      'GitHub applied a blank-only suggestion as zero lines; this replacement cannot be a native suggestion.');
  }
  if (payloadLines.some((line) => line.includes('\r'))) {
    return block('A CR in suggestion text is doubled by GitHub; this replacement cannot be a native suggestion.');
  }

  const lines: readonly string[] = sourceText.match(/[^\n]*\n|[^\n]+$/g) || [];
  const terminatorOf = (line: string): string => (line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '');
  const selected = lines.slice(startLine - 1, endLine);
  const terminators = new Set(selected.map(terminatorOf).filter((t) => t !== ''));
  const finalWithoutNewline = endLine === lines.length && terminatorOf(itemAt(lines, lines.length - 1)) === '';
  const touchesFinalLine = endLine === lines.length;
  const unfaithful = (): SuggestionPayload => (touchesFinalLine
    ? block(
      'GitHub\'s observed application would not reproduce the intended end of the file.')
    : block(
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
        changes: a.parts.map((p) => ({
          path: p.path,
          replacement: { startLine: p.startLine, endLine: p.endLine, originalText: p.originalText, replacementText: p.replacementText },
        })),
      })),
    } : {}),
  };
}

// ---------------------------------------------------------------------------
// Delivery units (docs/delivery-policy-contract.md §2)

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
 * whole-file proposal, its several-change fix or its one edit. Results
 * carrying equal proposals, equal several-change fixes or equal edits share
 * one unit (R8).
 */
function unitKeyOf(item: IPreparedItem, changes: readonly UnitChange[]): string {
  if (item.group !== undefined) return `group:${item.group}`;
  if (item.fileOperation) return `operation:${changes.map(changeKey).join('')}`;
  return item.jointFix ? `fix:${JSON.stringify(changes.map(changeKey))}` : `edit:${changes.map(changeKey).join('')}`;
}

/**
 * Who proposes a registered change: the unit that owns it, that unit's
 * explicit group (absent for any other unit), and the finding that first
 * proposed it.
 */
interface IChangeProposer {
  readonly owner: ChangeOwner;
  readonly group?: string | undefined;
  readonly pointer: string;
}

/** A registered change: its proposer and identity. */
interface IRegisteredChange extends IChangeProposer {
  readonly key: string;
}

/** A registered edit, with the lines it replaces. */
interface IRegisteredEdit extends IRegisteredChange {
  readonly startLine: number;
  readonly endLine: number;
}

/** How a conflict names a change: the replaced lines, or the whole-file operation. */
function changeDescription(change: UnitChange): string {
  if (change.kind === 'operation') {
    return `The ${change.operation.operation === 'create' ? 'creation' : 'deletion'} of ${codeSpan(change.operation.path)}`;
  }
  const { path: filePath, startLine, endLine } = change.edit;
  return `The replacement of ${codeSpan(filePath)} ${lineSpan(startLine, endLine)}`;
}

/**
 * Tracks which unit proposes what, so that every unit stays acceptable on
 * its own: a path created or deleted by one unit is changed by no other,
 * no two units change the same lines, and a change of an explicit group is
 * carried by no other unit (issue #42).
 */
class ChangeRegistry {
  private readonly operations = new Map<string, IRegisteredChange>();
  private readonly edits = new Map<string, IRegisteredEdit[]>();

  constructor(private readonly report: Report) {}

  /**
   * Admits `change` for `owner` (in `group`, when the owner is one):
   * 'shared' when the same unit already has the equal change, 'new' after
   * registering it, or false after recording the conflict.
   */
  admit(change: UnitChange, owner: ChangeOwner, pointer: string, group?: string): 'new' | 'shared' | false {
    const key = changeKey(change);
    const filePath = changePath(change);
    const operation = this.operations.get(filePath);
    const pathEdits = this.edits.get(filePath) ?? [];
    const proposer: IChangeProposer = { owner, group, pointer };
    if (change.kind === 'operation') {
      if (operation !== undefined && operation.owner === owner && operation.key === key) return 'shared';
      if (operation !== undefined && operation.key === key && (operation.group !== undefined || group !== undefined)) {
        this.sharedWithGroup(change, operation, proposer);
        return false;
      }
      if (operation !== undefined || pathEdits.length > 0) {
        const sameUnit = (operation === undefined || operation.owner === owner) && pathEdits.every((e) => e.owner === owner);
        this.report.error('file-operation-conflict', pointer, sameUnit
          ? `${filePath} already has a different proposed change in this review; one of them must be chosen before publication.`
          : `${filePath} already has a proposed change in another part of this review; one of them must be chosen before publication.`);
        return false;
      }
      this.operations.set(filePath, { ...proposer, key });
      return 'new';
    }
    const { startLine, endLine } = change.edit;
    if (operation !== undefined) {
      this.report.error('file-operation-conflict', pointer, `The fix edits ${filePath}, which this review proposes to create or delete; the proposals conflict.`);
      return false;
    }
    if (pathEdits.some((e) => e.owner === owner && e.key === key)) return 'shared';
    const identical = pathEdits.find((e) => e.key === key && (e.group !== undefined || group !== undefined));
    if (identical !== undefined) {
      this.sharedWithGroup(change, identical, proposer);
      return false;
    }
    if (pathEdits.some((e) => e.startLine <= endLine && startLine <= e.endLine)) {
      this.report.error('overlapping-replacements', pointer,
        `The replacement of ${filePath} lines ${String(startLine)}-${String(endLine)} overlaps a different replacement.`);
      return false;
    }
    this.edits.set(filePath, [...pathEdits, { ...proposer, key, startLine, endLine }]);
    return 'new';
  }

  /**
   * Records that `later` proposes the change `first` already carries, where
   * at least one of them is an explicit group: the group's delivery and the
   * other proposal could not both be accepted, and the change is never
   * moved into the group (contract §2.3). Reported at `later`, naming the
   * group (or both groups) and both findings.
   */
  private sharedWithGroup(change: UnitChange, first: IChangeProposer, later: IChangeProposer): void {
    const what = changeDescription(change);
    const path = changePath(change);
    const named = (proposer: IChangeProposer): string => `suggestion group ${JSON.stringify(proposer.group)} (${codeSpan(proposer.pointer)})`;
    if (first.group !== undefined && later.group !== undefined) {
      this.report.error('suggestion-group-change-shared', later.pointer,
        `${what} is proposed both by ${named(first)} and by ${named(later)}; one change cannot be accepted as part of two groups, and groups are never joined.`,
        { path, remedies: ['Take one of the two findings out of its group (`ungroup-fixes`).'] });
      return;
    }
    const [grouped, outside] = first.group !== undefined ? [first, later] : [later, first];
    this.report.error('suggestion-group-change-shared', later.pointer,
      `${what} is proposed both by ${named(grouped)} and by ${codeSpan(outside.pointer)}, which is not in the group; `
      + 'one change cannot be accepted both as part of the group and on its own.',
      { path });
  }
}

/**
 * Builds the review under the delivery policy (docs/delivery-policy-contract.md):
 *   1. every proposal is classified into a delivery unit (§2), in SARIF
 *      order, and each of its changes is admitted so that every unit stays
 *      acceptable on its own: no conflict with another unit, no change of a
 *      group carried by anything else (issue #42), every group member with a
 *      change, every group with at least two;
 *   2. one destination is planned per unit (§8–§10), asking each
 *      mechanism's availability lazily, in the order of the unit's list
 *      (§8.7);
 *   3. each unit is rendered by its destination (a native suggestion, a
 *      native batch, a review-body proposal or a companion pull request,
 *      bundled as planned, §9), and findings without a proposal as always.
 * Returns null after recording errors: the review is blocked, and a blocked
 * plan reports only its errors (§10.1).
 */
async function assembleDelivery(items: readonly IPreparedItem[], state: IPreparationState): Promise<IUnitAssembly | null> {
  const { report } = state;
  const registry = new ChangeRegistry(report);
  const units: ISuggestionUnit[] = [];
  const unitByKey = new Map<string, number>();
  const unitOf = new Map<IPreparedItem, number>();
  /** Every distinct change each group's members declared, including refused ones, by group. */
  const declared = new Map<string, Set<string>>();
  /** Each group's first member, in SARIF order. */
  const firstMember = new Map<string, string>();

  for (const item of items) {
    const changes = unitChangesOf(item);
    const { group } = item;
    if (group !== undefined && !firstMember.has(group)) {
      firstMember.set(group, item.pointer);
      declared.set(group, new Set());
    }
    if (group !== undefined && changes.length === 0) {
      report.error('suggestion-group-member-without-change', item.pointer,
        `The finding is in suggestion group ${JSON.stringify(group)} but proposes no change; a group joins changes. `
        + 'Remove the finding from the group, or give it its change.');
      continue;
    }
    if (changes.length === 0) continue;
    if (group !== undefined) for (const change of changes) declared.get(group)?.add(changeKey(change));
    const key = unitKeyOf(item, changes);
    const owner = unitByKey.get(key) ?? units.length;
    const admitted = changes.map((change) => registry.admit(change, owner, item.pointer, group));
    if (admitted.includes(false)) continue;
    let index = unitByKey.get(key);
    if (index === undefined) {
      index = units.length;
      unitByKey.set(key, index);
      const kind = group !== undefined || item.jointFix ? 'edit-group' : item.fileOperation ? 'file-operation' : 'edit';
      units.push({ kind, group, jointFix: item.jointFix, items: [], changes: new Map() });
    }
    const unit = itemAt(units, index);
    for (const [i, change] of changes.entries()) {
      if (admitted[i] === 'new') unit.changes.set(changeKey(change), change);
    }
    unit.items.push(item);
    unitOf.set(item, index);
  }
  for (const [group, changes] of declared) {
    if (changes.size < 2) {
      report.error('suggestion-group-single-change', firstMember.get(group),
        `Suggestion group ${JSON.stringify(group)} holds only one distinct change; a group needs at least two changes to accept together. `
        + 'Remove the group, and the change is published on its own.');
    }
  }
  // A group with any whole-file creation or deletion follows fileOperations
  // as a whole, whatever its edits' eligibility (D51; §2, §8.5).
  for (const unit of units) {
    if (unit.group !== undefined && unit.items.some((item) => item.fileOperation !== null)) unit.kind = 'file-operation-group';
  }

  // The units are planned even when another problem already blocks, so that
  // every unit no listed mechanism can deliver, and the companion limit, are
  // reported with every other problem of the review (companion contract
  // §2.5.1). A blocked review carries no fallback warning or note (§10.1).
  const companions = new CompanionPlanner(state, units);
  const availability = new DeliveryAvailability(state, units, companions);
  const plan = await availability.plan();
  if (plan.status === 'blocked') {
    for (const diagnostic of plan.diagnostics) report.add(diagnostic);
    return null;
  }
  if (report.errors.length > 0) return null;
  return renderDelivery(items, units, unitOf, plan, availability, companions, state);
}

/** The sentences of the mechanisms this version does not support yet (docs/delivery-policy-contract.md §8.8). */
const NOT_YET_SUPPORTED = Object.freeze({
  reviewBody: 'Delivering an edit in the review body is not yet supported by this version.',
  manualGroup: 'Delivering a group in the review body for manual application is not yet supported by this version.',
  mixedManualGroup: 'Delivering a group with a whole-file creation or deletion on the original pull request is not yet supported by this version.',
  jointFixBatch: 'Offering a fix with several changes as a native batch is not yet supported by this version.',
});

/** An unavailable mechanism with its obstacles (at least one) and their remedies, in obstacle order. */
function unavailableFor(obstacles: readonly string[], remedies: readonly string[] = []): MechanismAvailability {
  const [first, ...rest] = obstacles;
  if (first === undefined) throw new Error('Internal error: an unavailable delivery mechanism must name an obstacle.');
  return { available: false, obstacles: [first, ...rest], ...(remedies.length === 0 ? {} : { remedies }) };
}

const AVAILABLE: MechanismAvailability = Object.freeze({ available: true });

/** How a diagnostic names one edit: "The edit of `PATH` line N" (§10.1). */
function editDescription(edit: IPreparedEdit): string {
  return `The edit of ${codeSpan(edit.path)} ${lineSpan(edit.startLine, edit.endLine)}`;
}

/** How a diagnostic names a unit (§10.1): the edit, the group, the fix or the operation. */
function unitDescription(unit: ISuggestionUnit): string {
  const [first] = unit.changes.values();
  if (first === undefined) throw new Error('Internal error: a delivery unit has no change.');
  if (unit.group !== undefined) return `The group ${codeSpan(unit.group)}`;
  if (unit.jointFix) return `The fix with ${String(unit.changes.size)} changes at ${codeSpan(itemAt(unit.items, 0).pointer)}`;
  if (first.kind === 'edit') return editDescription(first.edit);
  return `The ${first.operation.operation === 'create' ? 'creation' : 'deletion'} of ${codeSpan(first.operation.path)}`;
}

/** A unit's edits, in order of first appearance. */
function unitEdits(unit: ISuggestionUnit): IPreparedEdit[] {
  return [...unit.changes.values()].flatMap((change) => (change.kind === 'edit' ? [change.edit] : []));
}

/**
 * Whether each mechanism can deliver each unit, worked out lazily and
 * remembered (docs/delivery-policy-contract.md §8.7). The pure planner
 * (src/delivery-policy.cts) asks synchronously; companion availability needs
 * reads, so {@link DeliveryAvailability.plan} first answers, in each unit's
 * list order, exactly the questions the planner then asks, stopping at the
 * first available mechanism, and the planner reads the answers back. A
 * question the planner asks that was never answered is an internal error.
 */
class DeliveryAvailability {
  readonly #state: IPreparationState;
  readonly #units: readonly ISuggestionUnit[];
  readonly #companions: CompanionPlanner;
  /** Each unit's answers, by mechanism; a native batch's answer is the group's own obstacles only. */
  readonly #answers: Map<string, MechanismAvailability>[];
  /** Each edit's native eligibility, by change identity, for the units whose `native` or `native-batch` was asked. */
  readonly #natives = new Map<string, NativeEligibility>();

  constructor(state: IPreparationState, units: readonly ISuggestionUnit[], companions: CompanionPlanner) {
    this.#state = state;
    this.#units = units;
    this.#companions = companions;
    this.#answers = units.map(() => new Map<string, MechanismAvailability>());
  }

  /** The plan: every unit's list answered lazily, in order, then planned (§8–§10). */
  async plan(): Promise<DeliveryPlan> {
    const { policy, companionOptions } = this.#state.options.delivery;
    for (const [index, unit] of this.#units.entries()) {
      for (const mechanism of this.#listOf(unit)) {
        if (await this.#answer(index, unit, mechanism)) {
          if (mechanism === 'companion') this.#companions.accept(index);
          break;
        }
      }
    }
    const units = this.#units.map((unit, index): DeliveryUnit => this.#deliveryUnit(unit, index));
    return planDelivery(policy, units, companionOptions ?? {});
  }

  /** The native suggestion of an edit whose eligibility was asked and found available. */
  suggestion(edit: IPreparedEdit): IPreparedSuggestion {
    const native = this.#natives.get(changeKey({ kind: 'edit', edit }));
    if (native?.available !== true) throw new Error('Internal error: an edit is delivered natively without a native suggestion.');
    return native.suggestion;
  }

  /** The list that governs a unit (§2). */
  #listOf(unit: ISuggestionUnit): readonly string[] {
    const { policy } = this.#state.options.delivery;
    switch (unit.kind) {
      case 'edit': return policy.edits.value;
      case 'edit-group': return policy.groupedEdits.value;
      case 'file-operation':
      case 'file-operation-group': return policy.fileOperations.value;
    }
  }

  /** Answers one question and remembers it; whether the mechanism can deliver the unit as a whole. */
  async #answer(index: number, unit: ISuggestionUnit, mechanism: string): Promise<boolean> {
    const answers = itemAt(this.#answers, index);
    if (mechanism === 'companion') {
      const answer = await this.#companions.availability(index);
      answers.set(mechanism, answer);
      return answer.available;
    }
    const answer = this.#localAnswer(unit, mechanism);
    answers.set(mechanism, answer);
    if (mechanism !== 'native-batch') return answer.available;
    const members = unit.jointFix ? [] : unitEdits(unit).map((edit) => this.#native(edit));
    return answer.available && members.every((m) => m.available);
  }

  /** The availability of a mechanism that needs no read. */
  #localAnswer(unit: ISuggestionUnit, mechanism: string): MechanismAvailability {
    switch (`${unit.kind}:${mechanism}`) {
      case 'edit:native': {
        const native = this.#native(itemAt(unitEdits(unit), 0));
        return native.available ? AVAILABLE : unavailableFor(native.obstacles, native.remedies);
      }
      case 'edit:review-body': return unavailableFor([NOT_YET_SUPPORTED.reviewBody]);
      case 'edit-group:native-batch': return this.#batchObstacles(unit);
      case 'edit-group:manual-group': return unavailableFor([NOT_YET_SUPPORTED.manualGroup]);
      case 'file-operation:manual': return AVAILABLE;
      case 'file-operation-group:manual': return unavailableFor([NOT_YET_SUPPORTED.mixedManualGroup]);
      default: throw new Error(`Internal error: ${mechanism} is not a mechanism of a ${unit.kind} unit.`);
    }
  }

  /**
   * A native batch's obstacles of the group as a whole (§8.3, §8.8): this
   * version offers one only for an explicit group whose every member's fix
   * makes one change. The members' own eligibility is asked separately.
   */
  #batchObstacles(unit: ISuggestionUnit): MechanismAvailability {
    if (unit.jointFix) return unavailableFor([NOT_YET_SUPPORTED.jointFixBatch]);
    const several = unit.items.filter((item) => item.edits.length > 1).map((item) =>
      `The finding at ${codeSpan(item.pointer)} makes ${String(item.edits.length)} changes with one fix; a fix with several changes is not yet offered in a native batch by this version.`);
    return several.length === 0 ? AVAILABLE : unavailableFor(several);
  }

  /** One edit's native eligibility, worked out once. */
  #native(edit: IPreparedEdit): NativeEligibility {
    const key = changeKey({ kind: 'edit', edit });
    let native = this.#natives.get(key);
    if (native === undefined) {
      native = nativeEligibility(edit, this.#state.context);
      this.#natives.set(key, native);
    }
    return native;
  }

  /** The planner's view of a unit: its identity, description and remembered answers. */
  #deliveryUnit(unit: ISuggestionUnit, index: number): DeliveryUnit {
    const answers = itemAt(this.#answers, index);
    const asked = (mechanism: string): MechanismAvailability => {
      const answer = answers.get(mechanism);
      if (answer === undefined) throw new Error(`Internal error: the planner asked for ${mechanism} of a unit, which was never answered.`);
      return answer;
    };
    const base = { id: String(index), description: unitDescription(unit), location: { pointer: itemAt(unit.items, 0).pointer } };
    switch (unit.kind) {
      case 'edit': return { ...base, kind: 'edit', availability: asked };
      case 'edit-group': {
        const members = unit.jointFix ? [] : unitEdits(unit).map((edit): IEditGroupMember => ({
          description: editDescription(edit),
          native: () => {
            const native = this.#natives.get(changeKey({ kind: 'edit', edit }));
            if (native === undefined) throw new Error('Internal error: the planner asked for a member\'s native eligibility, which was never answered.');
            return native.available ? AVAILABLE : unavailableFor(native.obstacles, native.remedies);
          },
        }));
        return { ...base, kind: 'edit-group', members, availability: asked };
      }
      case 'file-operation': return { ...base, kind: 'file-operation', availability: asked };
      case 'file-operation-group': return { ...base, kind: 'file-operation-group', availability: asked };
    }
  }
}

/**
 * The remedies of a companion's obstacles (docs/delivery-policy-contract.md
 * §8.9), as the retired `suggestion-group-pr-unavailable` gave them. A fork,
 * another base and an unsupported mechanism have none of their own.
 */
const COMPANION_REMEDIES = Object.freeze({
  rewritten: 'Review the pull request\'s current head again, and publish that review.',
  fileSize: `Reduce the proposed file to at most ${MAX_SUGGESTION_FILE_BYTES.toLocaleString('en-US')} bytes.`,
  description: 'Shorten the findings\' messages.',
});

/** A unit whose companion is available: its rendered content and the head's text of each file it edits, when re-applied. */
interface ICompanionDraft {
  readonly unit: ISuggestionUnit;
  readonly content: ICompanionContent;
  readonly headTexts: ReadonlyMap<string, string>;
}

/**
 * Whether a companion pull request can deliver each unit
 * (docs/companion-suggestion-pr-contract.md §2.5, §2.5.1, §2.8), worked out
 * only when asked: the pull request's target is read the first time, the
 * rewritten head (if any) once, and each unit is checked against the
 * obstacles a companion can meet — an unsupported pull request, a rewritten
 * history it cannot be re-applied onto, a created file over the per-file
 * limit, and a description over the body limit (under a `single` bundle,
 * the bundle's description as planned so far, docs/delivery-policy-contract.md
 * §9). It then builds the companions the plan bundles.
 */
class CompanionPlanner {
  readonly #state: IPreparationState;
  readonly #units: readonly ISuggestionUnit[];
  #facts: ICompanionTargetFacts | undefined;
  #target: ISuggestionContext | undefined;
  #lifecycleNote: string | undefined;
  readonly #drafts = new Map<number, ICompanionDraft>();
  /** The units delivered by `companion` so far, in order. */
  readonly #accepted: number[] = [];

  constructor(state: IPreparationState, units: readonly ISuggestionUnit[]) {
    this.#state = state;
    this.#units = units;
  }

  /** The texts every companion of this review names; known once a companion was asked for. */
  target(): ISuggestionContext {
    if (this.#target === undefined) throw new Error('Internal error: the companion target is needed before any companion was asked for.');
    return this.#target;
  }

  /** The lifecycle note every companion carries; presented once, with the first companion that can be made. */
  lifecycleNote(): string {
    if (this.#lifecycleNote === undefined) throw new Error('Internal error: a companion is planned without its lifecycle note.');
    return this.#lifecycleNote;
  }

  /** Records that `companion` delivers the unit (so a `single` bundle's size counts it). */
  accept(index: number): void {
    this.#accepted.push(index);
  }

  /** Whether a companion pull request can deliver unit `index`, with every obstacle when it cannot. */
  async availability(index: number): Promise<MechanismAvailability> {
    const state = this.#state;
    const facts = await this.#readFacts();
    const target = this.#target ?? await this.#resolveTarget(facts);
    const unit = itemAt(this.#units, index);
    const obstacles: string[] = [...(facts.unavailable ?? [])];
    const remedies: string[] = [];
    let headTexts: ReadonlyMap<string, string> = new Map();
    if (obstacles.length === 0 && target.reappliedOnto !== undefined) {
      const decision = await reapplication(unit, target.reappliedOnto, state);
      if (decision.kind === 'created') headTexts = decision.headTexts;
      else {
        const subject = unit.changes.size === 1 ? 'it' : `its ${String(unit.changes.size)} changes`;
        obstacles.push(`The history of #${String(target.pullNumber)} was rewritten after the reviewed commit, and ${subject} cannot be re-applied onto commit `
          + `${codeSpan(target.reappliedOnto)} because ${decision.reasons.join('; ')}.`);
        remedies.push(COMPANION_REMEDIES.rewritten);
      }
    }
    for (const change of unit.changes.values()) {
      if (change.kind !== 'operation' || change.operation.operation !== 'create') continue;
      const bytes = Buffer.byteLength(change.operation.text, 'utf8');
      if (bytes > MAX_SUGGESTION_FILE_BYTES) {
        obstacles.push(`${codeSpan(change.operation.path)} is ${String(bytes)} bytes, and a suggestion pull request carries at most ${String(MAX_SUGGESTION_FILE_BYTES)} bytes per file.`);
        remedies.push(COMPANION_REMEDIES.fileSize);
      }
    }
    if (obstacles.length === 0) {
      const content = companionContent(unit, state.renderer);
      this.#lifecycleNote ??= state.renderer.lifecycleNote(target);
      const bundled = state.options.delivery.policy.companionBundle.value === 'single'
        ? [...this.#accepted.map((i) => this.#draft(i).content), content]
        : [content];
      const sizingMarker = formatSuggestionMarker({ ...target, id: SIZING_UUID, batch: SIZING_UUID });
      const characters = renderCompanionBundleDescription(bundled, target, this.#lifecycleNote, sizingMarker).length;
      const limit = state.options.maxCommentBodyChars;
      if (limit !== undefined && characters > limit) {
        obstacles.push(`Its suggestion pull request's description would be ${String(characters)} characters, and the limit is ${String(limit)}.`);
        remedies.push(COMPANION_REMEDIES.description);
      } else {
        this.#drafts.set(index, { unit, content, headTexts });
      }
    }
    return obstacles.length === 0 ? AVAILABLE : unavailableFor(obstacles, [...new Set(remedies)]);
  }

  /** The companions of the plan, each holding its units in order (§9). */
  build(plan: Extract<DeliveryPlan, { readonly status: 'planned' }>): IPreparedCompanion[] {
    return plan.companions.map((companion) => bundleCompanion(companion.sections.map((id) => this.#draft(Number(id))), this.target()));
  }

  #draft(index: number): ICompanionDraft {
    const draft = this.#drafts.get(index);
    if (draft === undefined) throw new Error('Internal error: a unit is delivered by companion without its companion.');
    return draft;
  }

  /** The caller's target facts, asked once and checked. */
  async #readFacts(): Promise<ICompanionTargetFacts> {
    if (this.#facts !== undefined) return this.#facts;
    const ask = this.#state.options.delivery.companionTarget;
    if (ask === undefined) throw new TypeError('A delivery list names `companion`, but `options.delivery.companionTarget` is not given.');
    const facts: unknown = await ask();
    if (!isPlainObject(facts)) throw new TypeError('`options.delivery.companionTarget` must answer an object.');
    const headRef = facts['headRef'];
    const ready = facts['ready'];
    const unavailable = facts['unavailable'];
    const resolve = facts['resolveRewrittenHead'];
    if (typeof headRef !== 'string' || headRef === '' || typeof ready !== 'boolean') {
      throw new TypeError('`options.delivery.companionTarget` must answer { headRef, ready, resolveRewrittenHead?, unavailable? }.');
    }
    if (unavailable !== undefined && !isObstacleList(unavailable)) throw new TypeError('`options.delivery.companionTarget` must answer `unavailable` as non-empty obstacle sentences.');
    if (resolve !== undefined && typeof resolve !== 'function') throw new TypeError('`resolveRewrittenHead` must be a function () => Promise<commit | undefined>.');
    this.#facts = {
      headRef,
      ready,
      ...(unavailable === undefined ? {} : { unavailable }),
      ...(resolve === undefined ? {} : { resolveRewrittenHead: (): Promise<unknown> => Promise.resolve(Reflect.apply(resolve, facts, [])) }),
    };
    return this.#facts;
  }

  /** The companion texts' context, with the rewritten head when the pull request is supported and its history was rewritten. */
  async #resolveTarget(facts: ICompanionTargetFacts): Promise<ISuggestionContext> {
    const { context } = this.#state;
    const supported = (facts.unavailable ?? []).length === 0;
    const head = supported ? await rewrittenHeadOf(facts, context, this.#state) : undefined;
    this.#target = {
      owner: context.owner, repo: context.repo, pullNumber: context.pullNumber, reviewedCommit: context.reviewedCommit, headRef: facts.headRef,
      ready: facts.ready, ...(head === undefined ? {} : { reappliedOnto: head }),
    };
    return this.#target;
  }
}

/** Whether a value is a list of non-empty obstacle sentences. */
function isObstacleList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((r) => typeof r === 'string' && r !== '');
}

/**
 * The rewritten head companions are re-applied onto (contract §2.5.1), from
 * the caller's resolver, checked: a full commit other than the reviewed one,
 * with a tree read to compare against. Undefined when there is none.
 */
async function rewrittenHeadOf(facts: ICompanionTargetFacts, context: IPreparationContext, state: IPreparationState): Promise<string | undefined> {
  if (facts.resolveRewrittenHead === undefined) return undefined;
  const head: unknown = await facts.resolveRewrittenHead();
  if (head === undefined) return undefined;
  if (!isFullCommit(head) || head === context.reviewedCommit) {
    throw new TypeError('`resolveRewrittenHead` must answer a full commit other than the reviewed commit, or undefined.');
  }
  if (state.readEntry === null) throw new TypeError('`readEntry` is required to re-apply suggestions onto a rewritten head.');
  return head;
}

/** Where each item of a delivered unit goes, once the plan is known. */
type Destination =
  | { readonly mechanism: 'native' | 'native-batch' | 'manual' | 'companion'; readonly unit: number }
  | { readonly mechanism: 'none' };

/**
 * Renders the planned review: inline comments in SARIF order of first
 * appearance (native suggestions merged when identical, a native batch's
 * members each with the group's note), body sections in SARIF order (a
 * finding, a whole-file proposal with its findings, a companion's reference,
 * or a native batch's guidance, each unit at its first finding's position),
 * one evidence record per result, and the companion pull requests.
 */
function renderDelivery(
  items: readonly IPreparedItem[],
  units: readonly ISuggestionUnit[],
  unitOf: ReadonlyMap<IPreparedItem, number>,
  plan: Extract<DeliveryPlan, { readonly status: 'planned' }>,
  availability: DeliveryAvailability,
  companions: CompanionPlanner,
  state: IPreparationState,
): IUnitAssembly {
  const { context, renderer } = state;
  const mechanismOf = new Map(plan.deliveries.map((d) => [Number(d.unitId), d.mechanism]));
  const referenceOf = new Map<number, ICompanionSectionReference>();
  for (const [companion, planned] of plan.companions.entries()) {
    for (const [section, id] of planned.sections.entries()) referenceOf.set(Number(id), { companion, section });
  }
  const prepared = companions.build(plan);
  const destination = (item: IPreparedItem): Destination => {
    const unit = unitOf.get(item);
    if (unit === undefined) return { mechanism: 'none' };
    const mechanism = mechanismOf.get(unit);
    // `review-body` and `manual-group` are always unavailable in this version (§8.8), so the planner never routes to them.
    if (mechanism === 'native' || mechanism === 'native-batch' || mechanism === 'manual' || mechanism === 'companion') return { mechanism, unit };
    throw new Error(`Internal error: a unit is delivered by ${String(mechanism)}, which this version renders nowhere.`);
  };

  const commentItems: ICommentEntry[] = [];
  const sections: UnitSection[] = [];
  const evidence: Evidence[] = [];
  const suggestionComments = new Map<string, number>();
  const unitSections = new Map<number, number>();
  const sectionOf = (unit: number): number => {
    let index = unitSections.get(unit);
    if (index === undefined) {
      index = sections.length;
      unitSections.set(unit, index);
      sections.push({ kind: 'unit', unit });
    }
    return index;
  };
  const suggestionComment = (s: IPreparedSuggestion, note: string | undefined): number => {
    const key = JSON.stringify([s.path, s.startLine, s.endLine, s.replacementText]);
    let index = suggestionComments.get(key);
    if (index === undefined) {
      index = commentItems.length;
      suggestionComments.set(key, index);
      commentItems.push({
        coordinates: inlineCoordinates(s.path, { side: 'RIGHT', line: s.endLine, startLine: s.startLine === s.endLine ? undefined : s.startLine }),
        items: [],
        suggestion: s,
        ...(note === undefined ? {} : { note }),
      });
    }
    return index;
  };

  for (const item of items) {
    const record = evidenceRecord(item);
    const where = destination(item);
    switch (where.mechanism) {
      case 'none':
        if (item.placement && item.placement.treatment === 'inline') {
          const index = commentItems.length;
          commentItems.push({ coordinates: inlineCoordinates(item.placement.source.path, item.placement.anchor), items: [item] });
          evidence.push({ ...record, treatment: 'inline', commentIndex: index, source: item.placement.source, anchor: item.placement.anchor });
        } else {
          evidence.push({ ...record, treatment: 'general', bodySectionIndex: sections.length, ...(item.placement ? { source: item.placement.source } : {}) });
          sections.push({ kind: 'item', item });
        }
        break;
      case 'native':
      case 'native-batch': {
        const unit = itemAt(units, where.unit);
        if (where.mechanism === 'native-batch') sectionOf(where.unit);
        const s = availability.suggestion(itemAt(item.edits, 0));
        const note = where.mechanism === 'native-batch' && unit.group !== undefined ? renderNativeBatchMemberNote(unit.group) : undefined;
        const index = suggestionComment(s, note);
        itemAt(commentItems, index).items.push(item);
        evidence.push({ ...record, treatment: 'suggestion', commentIndex: index,
          ...(item.placement ? { source: item.placement.source } : {}),
          fixSource: s.source,
          replacement: { startLine: s.startLine, endLine: s.endLine, originalText: s.originalText, replacementText: s.replacementText },
          suggestionPayload: s.payload });
        break;
      }
      case 'manual':
      case 'companion': {
        const reference = where.mechanism === 'companion' ? referenceOf.get(where.unit) : undefined;
        evidence.push({ ...record, treatment: 'general', bodySectionIndex: sectionOf(where.unit),
          ...(item.placement ? { source: item.placement.source } : {}),
          ...(item.fileOperation ? { fileOperation: fileOperationEvidence(item.fileOperation, item.proposedLines) } : {}),
          ...(reference === undefined ? {} : { suggestionPullRequest: reference.companion }) });
        break;
      }
    }
  }

  /** A body section as `r` renders it; a companion's proposal is its reference, rendered once the numbers are known. */
  const sectionPart = (section: UnitSection, r: ReviewRenderer): string | ICompanionSectionReference => {
    if (section.kind === 'item') return r.section(section.item);
    const unit = itemAt(units, section.unit);
    const mechanism = mechanismOf.get(section.unit);
    if (mechanism === 'companion') {
      const reference = referenceOf.get(section.unit);
      if (reference === undefined) throw new Error('Internal error: a unit is delivered by companion without a companion.');
      return reference;
    }
    if (mechanism === 'native-batch' && unit.group !== undefined) return renderNativeBatchGuidance(unit.group, unitEdits(unit));
    if (mechanism !== 'manual') throw new Error(`Internal error: a unit delivered by ${String(mechanism)} has a body section.`);
    return r.proposal(standaloneOperation(unit), unit.items);
  };
  const parts = sections.map((section) => sectionPart(section, renderer));
  const proposals: IRenderedProposal[] = sections.flatMap((section, i) => {
    const part = itemAt(parts, i);
    return section.kind === 'unit' && mechanismOf.get(section.unit) === 'manual' && typeof part === 'string'
      ? [{ path: standaloneOperation(itemAt(units, section.unit)).path, characters: part.length }] : [];
  });
  // Body sections are rendered before inline comments, as they always were, so callbacks see elements in that order.
  const comments: PreparedComment[] = commentItems.map((entry) => ({ ...entry.coordinates, body: composeComment(entry, renderer) }));

  // The composed-text checkpoint (see checkComposed): every comment, every
  // section, every companion pull request's description and the body, each
  // with a way to compose it again with another renderer. A companion's
  // reference is read with the largest pull request number, as the limits are.
  const target = prepared.length === 0 ? undefined : companions.target();
  const referenceText = (reference: ICompanionSectionReference, content: ICompanionContent): string => {
    if (target === undefined) throw new Error('Internal error: a companion reference without a companion.');
    const largest = { number: LARGEST_PULL_NUMBER, url: pullRequestUrl(target, LARGEST_PULL_NUMBER) };
    const count = itemAt(prepared, reference.companion).sections.length;
    return renderBundledCompanionReference(content, largest, target, reference.section + 1, count);
  };
  /** A section's text: a part as rendered, a companion's reference with its planned content or as `r` renders it. */
  const partText = (part: string | ICompanionSectionReference, r?: ReviewRenderer): string => {
    if (typeof part === 'string') return part;
    if (r === undefined) return referenceText(part, itemAt(itemAt(prepared, part.companion).sections, part.section));
    const unit = itemAt(units, Number(itemAt(itemAt(plan.companions, part.companion).sections, part.section)));
    return referenceText(part, companionContent(unit, r));
  };
  const sectionWith = (section: UnitSection, r: ReviewRenderer): string => partText(sectionPart(section, r), r);
  const sectionUnits = sections.map((section, i): IComposedUnit => ({
    what: `body section ${String(i + 1)}`,
    // Sections are read only to locate the culprit when the body fails.
    get text(): string { return partText(itemAt(parts, i)); },
    expected: {},
    items: section.kind === 'item' ? [section.item] : itemAt(units, section.unit).items,
    compose: (r) => sectionWith(section, r),
  }));
  const composedBody = (r: ReviewRenderer): string => sections.map((section) => sectionWith(section, r)).join(SEPARATOR);
  const composedFor = (body: string, descriptions: readonly IComposedUnit[]): IComposedUnit[] => [
    ...commentItems.map((entry, i) => commentUnit(entry, itemAt(comments, i).body, i)),
    ...descriptions,
    ...bodyUnits(body, sectionUnits, composedBody),
  ];

  if (target === undefined) {
    const body = parts.map((part) => {
      if (typeof part !== 'string') throw new Error('Internal error: a companion reference without a companion.');
      return part;
    }).join(SEPARATOR);
    return {
      review: { commitId: context.reviewedCommit, body, comments },
      evidence,
      sectionCount: sections.length,
      proposals,
      composed: composedFor(body, []),
      deliveryDiagnostics: plan.diagnostics,
      fallbacks: plan.fallbacks,
    };
  }
  const lifecycleNote = companions.lifecycleNote();
  const sizingMarker = formatSuggestionMarker({ ...target, id: SIZING_UUID, batch: SIZING_UUID });
  const descriptions = plan.companions.map((planned, c): IComposedUnit => {
    const members = planned.sections.map((id) => Number(id));
    const delivered = members.map((index) => itemAt(units, index));
    return {
      what: `the description of the suggestion pull request for unit${members.length === 1 ? '' : 's'} ${members.map((index) => String(index + 1)).join(', ')}`,
      text: renderSuggestionPullBody(itemAt(prepared, c), sizingMarker, target, lifecycleNote),
      expected: { marker: sizingMarker },
      items: delivered.flatMap((unit) => unit.items),
      compose: (r) => renderCompanionBundleDescription(delivered.map((unit) => companionContent(unit, r)), target, r.lifecycleNote(target), sizingMarker),
    };
  });
  const suggestions: IPreparedSuggestions = { companions: prepared, sections: parts, lifecycleNote };
  const body = renderReviewBody(suggestions, prepared.map(() => LARGEST_PULL_NUMBER), target);
  return {
    review: { commitId: context.reviewedCommit, body, comments },
    evidence,
    sectionCount: sections.length,
    proposals,
    suggestions,
    composed: composedFor(body, descriptions),
    deliveryDiagnostics: plan.diagnostics,
    fallbacks: plan.fallbacks,
  };
}

/**
 * Whether one suggestion pull request can be re-applied onto a rewritten head
 * (contract §2.5.1): every change must still meet exactly what was reviewed
 * there — an edited file with each replaced range byte-identical at the same
 * lines, a created path absent, a deleted file with the same blob and mode.
 * Created with the head's text of each edited file, or not re-appliable with
 * every reason, in the order of the changes.
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

/** The whole-file proposal a standalone proposal unit carries (its only change). */
function standaloneOperation(unit: ISuggestionUnit): PreparedFileOperation {
  const [change, ...others] = unit.changes.values();
  if (change?.kind !== 'operation' || others.length > 0) throw new Error('Internal error: a standalone proposal unit carries exactly one whole-file proposal.');
  return change.operation;
}

/**
 * Why a head file's text is not source a replaced range can be compared in,
 * by the reader's error code (src/github.cts): not UTF-8, or beyond the
 * source-read limit. Such a file is a reason its suggestion cannot be
 * re-applied; any other failure stays operational.
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

/** A unit's section of a companion: how many changes it makes, its rendered change list and its rendered findings. */
function companionContent(unit: ISuggestionUnit, renderer: ReviewRenderer): ICompanionContent {
  const changes = [...unit.changes.values()];
  return {
    changeCount: changes.length,
    changeLines: changes.map((change) => renderer.changeLine(change)).join('\n'),
    items: unit.items.map((item) => renderer.suggestionItem(item)).join(SEPARATOR),
  };
}

/**
 * One companion pull request holding `drafts`' units, in order: its exact
 * commit changes (each path once, every unit's changes of it combined, an
 * edited file being the head's text when re-applied, contract §2.5.1),
 * title, commit message and sections (docs/delivery-policy-contract.md §9).
 * A companion of one unit is titled as always; a bundle of several, by its
 * proposals and changes.
 */
function bundleCompanion(drafts: readonly ICompanionDraft[], target: ISuggestionContext): IPreparedCompanion {
  const byPath = new Map<string, UnitChange[]>();
  const headTexts = new Map<string, string>();
  for (const draft of drafts) {
    for (const [filePath, onPath] of changesByPath(draft.unit)) byPath.set(filePath, [...(byPath.get(filePath) ?? []), ...onPath]);
    for (const [filePath, text] of draft.headTexts) headTexts.set(filePath, text);
  }
  const commitChanges = [...byPath].map(([filePath, onPath]): ProposalChange => {
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
  const count = drafts.reduce((n, draft) => n + draft.content.changeCount, 0);
  const pull = `#${String(target.pullNumber)}`;
  const [only] = drafts;
  const single = commitChanges.length === 1 ? itemAt(commitChanges, 0) : undefined;
  const summary = drafts.length > 1 || only === undefined ? `${String(drafts.length)} proposals (${String(count)} changes)`
    : only.unit.group !== undefined ? `${only.unit.group} (${String(count)} changes)`
      : single === undefined ? `${String(count)} changes` : `${single.operation} ${single.path}`;
  const full = `Suggestion for ${pull}: ${summary}`;
  const title = full.length <= MAX_TITLE ? full : `Suggestion for ${pull}: ${String(count)} change${count === 1 ? '' : 's'}`;
  return {
    title,
    commitMessage: `${title}\n\nSuggested in a review of ${target.owner}/${target.repo} pull request ${String(target.pullNumber)} at commit ${target.reviewedCommit}`
      + `${target.reappliedOnto === undefined ? '' : `, and re-applied onto commit ${target.reappliedOnto} after the pull request's history was rewritten`}.`,
    changes: commitChanges,
    sections: drafts.map((draft) => draft.content),
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

/**
 * The review body: its sections in order, each proposal of a companion
 * rendered with its pull request number (`numbers[i]` for companion i) as
 * the companion-reference component (src/presentation/companion-reference.cts),
 * naming which proposal of a bundle it is.
 */
function renderReviewBody(suggestions: Pick<IPreparedSuggestions, 'companions' | 'sections'>, numbers: readonly number[], target: ISuggestionContext): string {
  return suggestions.sections
    .map((part) => {
      if (typeof part === 'string') return part;
      const number = itemAt(numbers, part.companion);
      const companion = itemAt(suggestions.companions, part.companion);
      const pull = { number, url: pullRequestUrl(target, number) };
      return renderBundledCompanionReference(itemAt(companion.sections, part.section), pull, target, part.section + 1, companion.sections.length);
    })
    .join(SEPARATOR);
}

/**
 * A suggestion pull request's body, ending with its structured marker line
 * (src/presentation/companion-description.cts), carrying the lifecycle note
 * every suggestion pull request carries, as presented during preparation
 * (IPreparedSuggestions.lifecycleNote): one proposal's description, or a
 * bundle's.
 */
function renderSuggestionPullBody(companion: IPreparedCompanion, marker: string, target: ISuggestionContext, lifecycleNote: string): string {
  return renderCompanionBundleDescription(companion.sections, target, lifecycleNote, marker);
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
// The composed-text checkpoint

/**
 * A marker of the form publication appends to the review body
 * (src/publication.cts, MARKER_PATTERN), with a fixed id: the checkpoint
 * reads the body as it will be sent.
 */
const SAMPLE_REVIEW_MARKER = `<!-- sarif-to-comment:review:${SIZING_UUID} -->`;

/**
 * One fully composed text the checkpoint reads: what it is (for messages),
 * its text, what the core built it to end with, the findings it presents,
 * and how to compose it again with a given renderer (to tell whether a
 * problem comes from presentation callbacks or from producer content).
 */
interface IComposedUnit {
  readonly what: string;
  readonly text: string;
  readonly expected: IComposedExpectation;
  readonly items: readonly IPreparedItem[];
  readonly compose: (renderer: ReviewRenderer) => string;
  /** The parts (the body's sections) read, only when this text fails, to locate the culprit. */
  readonly parts?: readonly IComposedUnit[];
}

/** The native suggestion block the core appends to a suggestion comment. */
function suggestionBlock(payload: string): string {
  return `\`\`\`suggestion\n${payload}\`\`\``;
}

/**
 * An inline comment: its findings, then, for a suggestion, its note (a native
 * batch member's group note) and its native suggestion block.
 */
function composeComment(entry: ICommentEntry, renderer: ReviewRenderer): string {
  const body = entry.items.map((item) => renderer.finding(item)).join(SEPARATOR);
  const note = entry.note === undefined ? '' : `\n\n${entry.note}`;
  return entry.suggestion ? `${body}${note}\n\n${suggestionBlock(entry.suggestion.payload)}` : body;
}

function commentUnit(entry: ICommentEntry, text: string, index: number): IComposedUnit {
  return {
    what: `inline comment ${String(index + 1)}`,
    text,
    expected: entry.suggestion ? { suggestionBlock: suggestionBlock(entry.suggestion.payload) } : {},
    items: entry.items,
    compose: (r) => composeComment(entry, r),
  };
}

/**
 * The review body as it will be sent, with a sample publication marker after
 * it (the body is checked before its pull request numbers and marker exist);
 * none when the body is empty. Its sections locate a failure.
 */
function bodyUnits(body: string, sections: readonly IComposedUnit[], compose: (r: ReviewRenderer) => string): IComposedUnit[] {
  if (body === '') return [];
  return [{
    what: 'the review body',
    text: `${body}\n\n${SAMPLE_REVIEW_MARKER}`,
    expected: { marker: SAMPLE_REVIEW_MARKER },
    items: sections.flatMap((section) => section.items),
    compose: (r) => `${compose(r)}\n\n${SAMPLE_REVIEW_MARKER}`,
    parts: sections,
  }];
}

/**
 * The backstop for every seam between pieces of Markdown: each inline
 * comment, body section, suggestion pull request description and the review
 * body is read again, fully composed, and must leave no raw HTML open,
 * swallow nothing, keep exactly its native suggestion block intact as built,
 * and end with its marker as its own final node
 * (src/presentation/markdown-tree.cts, composedProblem). It runs with or
 * without presentation callbacks. A problem that the same text composed with
 * the built-in presentation does not have comes from a callback, and rejects
 * with the presentation TypeError; any other is producer content's, and is
 * reported as `producer-html-unbalanced` or `producer-fence-unclosed` at the
 * finding whose own Markdown shows it, or else the first the text presents.
 */
function checkComposed(units: readonly IComposedUnit[], state: IPreparationState): void {
  let builtIn: ReviewRenderer | undefined;
  const builtInRenderer = (): ReviewRenderer => (builtIn ??= state.renderer.customized ? new ReviewRenderer(state.context, {}) : state.renderer);
  const reported = new Set<string>();
  for (const whole of units) {
    const wholeProblem = composedProblem(whole.text, whole.expected);
    if (wholeProblem === null) continue;
    // A failing body is narrowed to its first failing section, when one fails alone.
    let unit = whole;
    let problem = wholeProblem;
    for (const part of whole.parts ?? []) {
      const partProblem = composedProblem(part.text, part.expected);
      if (partProblem !== null) {
        unit = part;
        problem = partProblem;
        break;
      }
    }
    if (state.renderer.customized && composedProblem(unit.compose(builtInRenderer()), unit.expected) === null) {
      throw new TypeError(`Invalid presentation: options.presentation returned Markdown that, composed into ${unit.what}, ${problem}, `
        + 'which would hide or swallow what the core places after it (findings, a suggestion block or a marker). '
        + 'A presentation callback may change how an element reads, never what is published or how it is identified.');
    }
    const culprit = unit.items.find((item) => composedProblem(builtInRenderer().finding(item), {}) !== null) ?? unit.items[0];
    const code: DiagnosticCode = problem.startsWith('leaves a code fence') || problem.includes('suggestion') || problem.includes('marker')
      ? 'producer-fence-unclosed' : 'producer-html-unbalanced';
    const key = `${code} ${culprit?.pointer ?? ''}`;
    if (reported.has(key)) continue;
    reported.add(key);
    state.report.error(code, culprit?.pointer,
      `Composed into ${unit.what}, the producer Markdown ${problem}, which would hide or swallow the attribution, later findings, a suggestion block or a marker that follows.`);
  }
}

// ---------------------------------------------------------------------------
// Rendering: prepared findings and proposals through the presentation
// components (src/presentation). Preparation decides what is published and
// where; the components decide only how each element reads.

/**
 * Renders prepared findings and proposals for one review: each element
 * through its presentation component, or through the caller's callback for
 * that component, which `present` checks (src/presentation/customization.cts).
 * The renderer composes what the core owns — a finding section's source link
 * and quote, the location line of a finding in a proposed file, separators —
 * around the presented elements; suggestion blocks and markers are appended
 * later still, by assembly and publication.
 */
class ReviewRenderer {
  readonly #context: IPreparationContext;
  readonly #presentation: CapturedPresentation;

  constructor(context: IPreparationContext, presentation: CapturedPresentation) {
    this.#context = context;
    this.#presentation = presentation;
  }

  /** Whether any presentation callback is in use (otherwise everything is built in). */
  get customized(): boolean {
    return Object.values(this.#presentation).some((callback) => callback !== undefined);
  }

  /** A prepared finding, with its alternatives and attribution. */
  finding(item: IPreparedItem): string {
    const primaryPath = singlePath(item.edits);
    const attribution = this.#attribution(item.attribution);
    const alternatives = this.#alternatives(item.alternatives, primaryPath);
    const c: IClassification = item.classification || {};
    return present('finding', this.#presentation.finding, {
      ...(c.level === undefined ? {} : { level: c.level }),
      ...(c.kind === undefined ? {} : { kind: c.kind }),
      ...(c.baselineState === undefined ? {} : { baselineState: c.baselineState }),
      message: item.message,
      ...(item.locationMessage === undefined ? {} : { locationMessage: item.locationMessage }),
      ...(item.fixDescription === undefined ? {} : { fixDescription: item.fixDescription }),
      ...(alternatives === undefined ? {} : { alternatives }),
      attribution,
      markdown: renderFinding({
        classification: item.classification,
        message: item.message,
        locationMessage: item.locationMessage,
        fixDescription: item.fixDescription,
        alternatives,
        attribution,
      }),
      required: alternatives === undefined ? [attribution] : [attribution, alternatives],
    });
  }

  /** A general body section: exact-revision link and literal source quote when the finding has a location. */
  section(item: IPreparedItem): string {
    const source = item.placement && item.placement.source;
    return renderFindingSection(this.finding(item), source ? quotedSource(this.#context, source) : undefined);
  }

  /** A finding in a suggestion's section: its lines of a proposed file, or its quoted reviewed source. */
  suggestionItem(item: IPreparedItem): string {
    return item.proposedLines ? renderProposedFileFinding(item.proposedLines, this.finding(item)) : this.section(item);
  }

  /**
   * A whole-file proposal's body section (contract §2): the proposal once,
   * then each finding carrying it — after its lines of the proposed file for
   * a creation, or as a section with its quoted reviewed source for a deletion.
   */
  proposal(operation: PreparedFileOperation, items: readonly IPreparedItem[]): string {
    if (operation.operation === 'delete') {
      const url = permalink(this.#context, { commit: operation.commit, path: operation.path });
      const findings = items.map((item) => this.section(item)).join(SEPARATOR);
      const deletion = { path: operation.path, commit: operation.commit, url };
      return present('fileDeletion', this.#presentation.fileDeletion, {
        ...deletion, findings, markdown: renderFileDeletion(deletion, findings), required: [url, findings],
      });
    }
    const findings = items.map((item) => renderProposedFileFinding(item.proposedLines, this.finding(item))).join(SEPARATOR);
    const details = fileDetails(operation.text, operation.fileMode);
    const content = proposedContentBlock(operation.text);
    return present('fileAddition', this.#presentation.fileAddition, {
      path: operation.path,
      fileMode: operation.fileMode,
      byteLength: Buffer.byteLength(operation.text, 'utf8'),
      details,
      content,
      findings,
      markdown: renderFileAddition(operation, findings),
      required: [codeSpan(operation.path), details, ...(content === undefined ? [] : [content]), findings],
    });
  }

  /** One line of a suggestion pull request's change list (contract §2.11). */
  changeLine(change: UnitChange): string {
    if (change.kind === 'edit') {
      const { edit } = change;
      return renderCompanionChange({
        kind: 'edit', path: edit.path, startLine: edit.startLine, endLine: edit.endLine, commit: edit.source.commit, url: permalink(this.#context, edit.source),
      });
    }
    const { operation } = change;
    if (operation.operation === 'create') return renderCompanionChange({ kind: 'create', path: operation.path, text: operation.text, fileMode: operation.fileMode });
    const url = permalink(this.#context, { commit: operation.commit, path: operation.path });
    return renderCompanionChange({ kind: 'delete', path: operation.path, commit: operation.commit, url });
  }

  /** The lifecycle note of a suggestion pull request into `target`'s head branch. */
  lifecycleNote(target: ISuggestionContext): string {
    return present('lifecycleNote', this.#presentation.lifecycleNote, {
      pullNumber: target.pullNumber, headRef: target.headRef, ready: target.ready, markdown: renderLifecycleNote(target), required: [],
    });
  }

  /** A finding's producer attribution; the producers' names are required provenance. */
  #attribution(attribution: IAttribution): string {
    const { tool, version, component, ruleId } = attribution;
    return present('attribution', this.#presentation.attribution, {
      tool,
      ...(version === undefined ? {} : { version }),
      ...(component === undefined ? {} : { component }),
      ...(ruleId === undefined ? {} : { ruleId }),
      markdown: renderAttribution(attribution),
      required: [escapePlainInline(tool), ...(component === undefined ? [] : [escapePlainInline(component.name)])],
    });
  }

  /** A finding's alternatives, or undefined when it has none; each alternative's exact changes are required. */
  #alternatives(prepared: readonly IPreparedAlternative[], primaryPath: string | undefined): string | undefined {
    const alternatives = prepared.map(alternativeOf);
    const markdown = renderAlternatives(alternatives, primaryPath);
    if (markdown === undefined) return undefined;
    const listed = alternatives.map((alternative, i) => ({
      number: i + 1,
      ...(alternative.description === undefined ? {} : { description: alternative.description }),
      changes: renderAlternativeChanges(alternative, primaryPath),
      markdown: renderAlternative(alternative, i + 1, primaryPath),
    }));
    return present('alternatives', this.#presentation.alternatives, { alternatives: listed, markdown, required: listed.map((a) => a.changes) });
  }
}

/** A prepared alternative as the alternatives component lists it. */
function alternativeOf(alternative: IPreparedAlternative): IAlternative {
  return { description: alternative.description, changes: alternative.parts };
}

/** A finding's own location as a finding section quotes it, with its permalink. */
function quotedSource(context: IPreparationContext, source: EvidenceSource): QuotedSource {
  const url = permalink(context, source);
  return source.startLine === undefined
    ? { path: source.path, commit: source.commit, url }
    : { path: source.path, commit: source.commit, url, lines: { startLine: source.startLine, endLine: source.endLine, text: source.text } };
}

/** GitHub permalink to an exact revision, path and optional line range (src/github-urls.cts). */
function permalink(context: IPreparationContext, source: EvidenceSource): string {
  return blobUrl(context, source.commit, source.path, source.startLine === undefined ? undefined : { startLine: source.startLine, endLine: source.endLine });
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
