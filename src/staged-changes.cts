/**
 * Staged-change incorporation into ordinary SARIF.
 *
 * addStagedChangesToSarif adds the proposed changes in the intended Git
 * index, relative to an explicit reviewed commit, to an ordinary SARIF
 * document, authored or upstream. Contract:
 * docs/second-milestone-contract-proposal.md §3.4 and §4.
 *
 * Responsibilities and invariants:
 *   - Source of truth is one index snapshot and the reviewed commit, read by
 *     immutable blob identity (src/staged-git.cts). Working-tree bytes never
 *     reach the output.
 *   - Every supported changed text file becomes exact SARIF replacements;
 *     independently applying them to the reviewed bytes reproduces the
 *     staged bytes (R2). This module re-checks that with src/replacements.cts
 *     before returning, so a coordinate defect fails loudly.
 *   - Feedback and edits stay separate facts (D4). A finding receives a
 *     replacement only when its lines lie within the replacement's changed
 *     reviewed lines; nothing grows to collect nearby feedback, and a pure
 *     insertion is never attached to an existing line's finding.
 *   - Supplied fixes and file proposals are never modified. An equal one
 *     explains a staged change; a different one on the same lines is a
 *     mechanical conflict and fails. No winner is chosen (R4).
 *   - Creation and deletion are whole-file proposals in the owned
 *     `properties.sarifToComment.proposedFileChanges` extension (D23), kept
 *     distinct from emptying a file (D6). Publication presents them in the
 *     review body (docs/file-operation-publication-contract.md).
 *   - A staged change that no supplied finding explains becomes a neutral,
 *     tool-attributed result with factual text only (contract §10 Q1).
 *   - Strict: any unsupported meaningful change fails the whole operation
 *     with actionable problems and no SARIF; nothing is silently omitted.
 *
 * Outcomes: { status: 'added', sarif, receipt, diagnostics } | { status:
 * 'invalid' | 'failed', problems, markdown, diagnostics }. Malformed input rejects with TypeError;
 * environment failures (Git, repository, missing commit) reject with Error.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { repositoryUrl } from './github-urls.cjs';
import { applyReplacement } from './replacements.cjs';
import type { ColumnKind, IReplacementRegion, ReplacementOutcome } from './replacements.cjs';
import {
  captureJson,
  encodeRepositoryPath,
  isPlainObject,
  namesRepository,
  packageVersion,
  parseBaseUri,
  resolveArtifactPath,
  validateSarif,
  OWNER_PATTERN,
  REPO_PATTERN,
} from './sarif-common.cjs';
import type {
  IArtifactPathOptions,
  IJsonObject,
  IPlainObject,
  IRepositoryIdentity,
  ISarifArtifact,
  ISarifArtifactLocation,
  ISarifRun,
  ISarifSchemaRefusal,
  ISarifToolComponent,
  ISarifVersionControlDetails,
} from './sarif-common.cjs';
import { MODE, blobSizes, diffHunks, openRepository, readBlobs, readIndexSnapshot, readTree } from './staged-git.cjs';
import type { IDiffHunk, IGitRepository, IIndexEntry, IIndexSnapshot, ITreeEntry } from './staged-git.cjs';
import { createProblem, diagnosticOf } from './diagnostics.cjs';
import { listItem } from './presentation/markdown.cjs';
import type { IDiagnostic, IGitHubRepository, IInvalidSarifOutcome, IProblem, ISarifLog } from './public-types.cjs';

// ---------------------------------------------------------------------------
// Operation input and outcomes
// ---------------------------------------------------------------------------

/**
 * Input to {@link addStagedChangesToSarif}. Unknown fields are refused.
 *
 * @public
 */
export interface IAddStagedChangesInput {
  /** A SARIF log as a parsed JSON object, from any producer. Copied when the call starts. */
  readonly sarif: object;
  /**
   * Absolute path of a directory inside the Git working tree whose index is
   * read. Only staged content is used; unstaged working-tree content never is.
   */
  readonly worktree: string;
  /** Full 40-character commit the staged content is compared with; it must exist locally. */
  readonly reviewedCommit: string;
  /** The GitHub repository recorded as the fixes' source. */
  readonly repository: IGitHubRepository;
  /**
   * Absolute `file:` URI (ending in `/`) of the repository root in the SARIF
   * producer's file system.
   */
  readonly sourceRootUri?: string | undefined;
}

/**
 * One staged edit region and the findings that carry it.
 *
 * @remarks
 * A replacement either changes reviewed lines `startLine`–`endLine`, or is a
 * pure insertion (`insertion: true`) that changes no reviewed line. An
 * insertion's range is empty: `startLine` is the reviewed line it precedes
 * (one past the last line for an end-of-file append, 1 for an empty file) and
 * `endLine` is `startLine - 1`, the line it follows. A pure insertion is
 * never associated with an existing finding, even though GitHub may display
 * its suggestion on a neighbouring unchanged line.
 *
 * @public
 */
export interface IStagedReplacementReceipt {
  /** First changed line of the reviewed file; for an insertion, the line it precedes. */
  readonly startLine: number;
  /** Last changed line of the reviewed file; for an insertion, `startLine - 1`. */
  readonly endLine: number;
  /** Present, and true, only for a pure insertion. */
  readonly insertion?: true | undefined;
  /** Refs of the findings that received it. */
  readonly associated: readonly string[];
  /**
   * `finding`: supplied findings carry it. `existing-fix`: an equal supplied
   * fix already expresses it. `neutral`: no finding explains it, so a
   * factual result in a new run carries it.
   */
  readonly explainedBy: 'finding' | 'existing-fix' | 'neutral';
}

/**
 * One staged change to a file.
 *
 * @public
 */
export interface IStagedChangeReceipt {
  /** Repository-relative path. */
  readonly path: string;
  /** Edited, created or deleted. */
  readonly operation: 'edit' | 'create' | 'delete';
  /** For edits: each changed region. */
  readonly replacements?: readonly IStagedReplacementReceipt[] | undefined;
  /** For creation and deletion: refs of the findings that received the operation. */
  readonly associated?: readonly string[] | undefined;
  /** For creation and deletion: what explains the operation. */
  readonly explainedBy?: 'finding' | 'existing-proposal' | 'neutral' | undefined;
}

/**
 * What {@link addStagedChangesToSarif} did.
 *
 * @public
 */
export interface IStagedChangesReceipt {
  /** The reviewed commit. */
  readonly reviewedCommit: string;
  /** Every staged change, by path. Empty when nothing is staged. */
  readonly changes: readonly IStagedChangeReceipt[];
  /** Runs that were given the reviewed commit as their source. */
  readonly boundRuns: readonly number[];
  /** The run holding neutral results, if one was added. */
  readonly addedRun: number | null;
  /**
   * Things to know, such as findings that only partly overlap a change (they
   * are left unassociated).
   */
  readonly warnings: readonly IProblem[];
}

/**
 * The staged changes were added to a new copy of the document.
 *
 * @public
 */
export interface IAddedStagedChangesOutcome {
  /** Discriminant: the staged changes were added. */
  readonly status: 'added';
  /** The new document. Your input is unchanged. */
  readonly sarif: ISarifLog;
  /** What was done. */
  readonly receipt: IStagedChangesReceipt;
  /** The receipt's warnings as diagnostics. */
  readonly diagnostics: readonly IDiagnostic[];
}

/**
 * A staged change cannot be represented faithfully (for example a mode
 * change, a binary file, a conflict, or a supplied fix that disagrees with
 * the staged content). Nothing was produced; the problems say what would let
 * a rerun succeed.
 *
 * @public
 */
export interface IFailedStagedChangesOutcome {
  /** Discriminant: nothing was produced. */
  readonly status: 'failed';
  /** Every problem, naming its path. */
  readonly problems: readonly IProblem[];
  /** The same problems as a human-readable explanation. */
  readonly markdown: string;
  /** The same problems as diagnostics. */
  readonly diagnostics: readonly IDiagnostic[];
}

/**
 * Every outcome of {@link addStagedChangesToSarif}, discriminated by `status`.
 *
 * @public
 */
export type AddStagedChangesOutcome = IAddedStagedChangesOutcome | IInvalidSarifOutcome | IFailedStagedChangesOutcome;

// ---------------------------------------------------------------------------
// SARIF views
// ---------------------------------------------------------------------------

// The SARIF types below describe the parts of the captured, schema-valid
// document this module reads or writes (see assertSchemaValid). They are
// views, not a SARIF model: every other property is simply not described.
// Where this module guards a value at run time anyway, the view claims no
// more than the guard assumes (an optional or looser type), so no guard is
// ever made to look redundant. The captured document is a fresh, unfrozen
// copy owned by this call, so the views are writable where this module adds
// fixes, proposals, provenance and runs.

/** SARIF artifactContent (3.3): text or base64 bytes of an artifact, snippet or insertion. */
interface ISarifArtifactContent {
  text?: string;
  binary?: string;
}

/** SARIF region (3.30) of a finding: coordinates plus the snippet it may claim. */
interface IStagedRegion extends IReplacementRegion {
  readonly snippet?: ISarifArtifactContent;
}

/** SARIF physicalLocation (3.29), as read for a finding's file and region. */
interface ISarifPhysicalLocation {
  artifactLocation?: ISarifArtifactLocation;
  region?: IStagedRegion;
}

/** A physical location that names its artifact (the only kind a finding is located by). */
interface ILocatedPhysicalLocation extends ISarifPhysicalLocation {
  artifactLocation: ISarifArtifactLocation;
}

/** SARIF location (3.28). */
interface ISarifLocation {
  physicalLocation?: ISarifPhysicalLocation;
}

/**
 * SARIF replacement (3.57). A supplied one always has a deletedRegion; a
 * derived one written by this module has null only if a derived region were
 * missing, which the converter self-check rules out.
 */
interface ISarifReplacement {
  deletedRegion: IReplacementRegion | null;
  insertedContent?: ISarifArtifactContent;
}

/** SARIF artifactChange (3.56). */
interface ISarifArtifactChange {
  artifactLocation?: ISarifArtifactLocation;
  replacements?: ISarifReplacement[];
}

/** SARIF fix (3.55). */
interface ISarifFix {
  artifactChanges?: ISarifArtifactChange[];
}

/** SARIF propertyBag (3.8): arbitrary JSON under string keys, including the owned namespace. */
interface IPropertyBag {
  [key: string]: unknown;
}

/** SARIF result (3.27), as read for its location, fixes and owned file proposals. */
interface IStagedResult {
  locations?: ISarifLocation[];
  fixes?: ISarifFix[];
  properties?: IPropertyBag;
}

/** SARIF versionControlDetails (3.23), including the revision a run may be bound to. */
interface IStagedProvenance extends ISarifVersionControlDetails {
  revisionId?: string;
}

/** SARIF artifact (3.24), as read and written for proposed file operations. */
interface IStagedArtifact extends ISarifArtifact {
  contents?: ISarifArtifactContent;
  encoding?: string;
  length?: number;
  hashes?: Readonly<Record<string, unknown>>;
}

/** SARIF run (3.14), as read for bindings, findings and supplied proposals. */
interface IStagedRun extends ISarifRun {
  artifacts?: IStagedArtifact[];
  versionControlProvenance?: IStagedProvenance[];
  results?: IStagedResult[];
  columnKind?: ColumnKind;
  newlineSequences?: string[];
  defaultEncoding?: string;
}

/**
 * The captured SARIF log, once schema-valid. `runs` is described as an array,
 * as the public {@link ISarifLog} describes it; the schema also admits
 * `runs: null`, so every read of it keeps its `Array.isArray` guard.
 */
interface IStagedSarifLog extends ISarifLog {
  runs: IStagedRun[];
}

/** The tool component that attributes neutral results to this package. */
interface INeutralDriver extends ISarifToolComponent {
  readonly version: string;
}

/** A tool-attributed result carrying a staged change no supplied finding explains (contract §4.8). */
interface INeutralResult extends IStagedResult {
  readonly ruleId: string;
  readonly message: { readonly text: string };
}

/** The run added to hold neutral results. */
interface INeutralRun extends IStagedRun {
  readonly tool: { readonly driver: INeutralDriver };
  results: INeutralResult[];
}

/** An owned proposed file operation (D23), as written by this module. */
type ProposedFileChange =
  | { readonly operation: 'create'; readonly artifactIndex: number; readonly fileMode: string }
  | { readonly operation: 'delete'; readonly artifactIndex: number };

// ---------------------------------------------------------------------------
// Internal domain
// ---------------------------------------------------------------------------

/** The validated input, with the SARIF captured as owned JSON. */
interface ICapturedInput {
  readonly sarif: IJsonObject;
  readonly worktree: string;
  readonly reviewedCommit: string;
  readonly repository: IRepositoryIdentity;
  readonly sourceRootUri: string | undefined;
}

/** One physical line: `raw` is `body` followed by its terminator ('' only on an unterminated last line). */
interface IPhysicalLine {
  readonly raw: string;
  readonly body: string;
  readonly terminator: '\r\n' | '\n' | '';
}

/** One-based inclusive first and last line. */
type LineRange = readonly [first: number, last: number];

/** An exact [start, end) UTF-16 span of a text. `error` is never present; it lets `span.error` separate outcomes. */
interface ISpan {
  readonly error?: never;
  readonly start: number;
  readonly end: number;
}

/** Why a region denotes no span (or no lines) of a text. */
interface ISpanFailure {
  readonly error: string;
}

/** The one-based inclusive lines a finding's region denotes. */
interface IRegionLines {
  readonly error?: never;
  readonly startLine: number;
  readonly endLine: number;
}

/** A region whose columns mean different text in the two SARIF column units, with no declared kind. */
interface IAmbiguousOutcome {
  readonly kind: 'ambiguous';
}

/**
 * The deleted region of a derived replacement under a run's column
 * convention, or null when an end-of-file column differs between the units
 * and no kind is declared.
 */
type RegionFor = (kind: ColumnKind | undefined) => IReplacementRegion | null;

/** Where a pure insertion goes, as stated in a neutral result's text. */
type InsertionWhere = 'at the end' | `before line ${string}`;

/** A derived replacement that changes reviewed lines `changedLines`. */
interface IDerivedChange {
  readonly region: RegionFor;
  readonly insertedText: string;
  readonly changedLines: LineRange;
}

/**
 * A derived pure insertion: it changes no reviewed line and is inserted
 * before reviewed line `insertionLine` (line count + 1 at the end).
 */
interface IDerivedInsertion {
  readonly region: RegionFor;
  readonly insertedText: string;
  readonly changedLines: null;
  readonly insertionWhere: InsertionWhere;
  readonly insertionLine: number;
}

/** One exact replacement derived from the index for an edited file. */
type DerivedReplacement = IDerivedChange | IDerivedInsertion;

/** A Git entry of either snapshot: the reviewed tree or the index. */
type GitEntry = ITreeEntry | IIndexEntry;

/**
 * A staged edit of an existing regular file. The texts are read later (null
 * when they are not extractable text, which is always reported as a
 * problem), and the replacements are derived once both are text.
 */
interface IEditChange {
  readonly path: string;
  readonly reviewed: ITreeEntry;
  readonly staged: IIndexEntry;
  readonly operation: 'edit';
  reviewedText?: string | null;
  stagedText?: string | null;
  replacements?: readonly DerivedReplacement[];
}

/** A staged creation; its staged text is read later (null when not extractable, which is reported). */
interface ICreateChange {
  readonly path: string;
  readonly reviewed: undefined;
  readonly staged: IIndexEntry;
  readonly operation: 'create';
  stagedText?: string | null;
}

/** A staged deletion; its reviewed text is kept only to validate findings (null when unavailable). */
interface IDeleteChange {
  readonly path: string;
  readonly reviewed: ITreeEntry;
  readonly staged: undefined;
  readonly operation: 'delete';
  reviewedText?: string | null;
}

/** A whole-file proposal: creation or deletion. */
type FileOperationChange = ICreateChange | IDeleteChange;

/** One staged change between the reviewed tree and the index. */
type StagedChange = IEditChange | FileOperationChange;

/** The staged changes, in index path order, and the strict refusals found while comparing. */
interface ISnapshotComparison {
  readonly changes: StagedChange[];
  readonly problems: IProblem[];
}

/** How a run's source is bound (contract §2.1). */
type RunBinding =
  | { readonly state: 'foreign' }
  | { readonly state: 'unbound' }
  | { readonly state: 'conflicting' }
  | { readonly state: 'bound'; readonly commit: string };

/** An eligible finding located on a changed path; `lines` is null when it has no region. */
interface ILocatedFinding {
  readonly result: IStagedResult;
  readonly run: IStagedRun;
  readonly runIndex: number;
  readonly pointer: string;
  readonly change: StagedChange;
  readonly lines: LineRange | null;
}

/** A supplied text fix's replacements on a changed path. */
interface ISuppliedEdit {
  readonly pointer: string;
  readonly run: IStagedRun;
  readonly change: StagedChange;
  readonly replacements: readonly ISarifReplacement[];
}

/** A supplied owned file operation on a changed path, with the artifact it names. */
interface ISuppliedOperation {
  readonly pointer: string;
  readonly op: IPlainObject;
  readonly artifact: IStagedArtifact;
  readonly run: IStagedRun;
  readonly change: StagedChange;
}

/** A located replacement: a span of the reviewed text, what replaces it, and the lines it covers. */
interface IEditSpan {
  readonly start: number;
  readonly end: number;
  readonly inserted: string;
  readonly lines: LineRange;
}

/** A supplied replacement located in the reviewed text; `binary` when it inserts binary content. */
interface ISuppliedPiece extends IEditSpan {
  readonly binary: boolean;
}

/** A node of the overlap graph: a supplied piece or a staged replacement, by index. */
interface IComponentNode {
  readonly kind: 'supplied' | 'staged';
  readonly i: number;
  readonly lines: LineRange;
}

/** A connected component: indices of its supplied pieces and staged replacements. */
interface IComponent {
  readonly supplied: readonly number[];
  readonly staged: readonly number[];
}

/** A replacement receipt while findings are being associated. */
interface IReplacementReceiptDraft {
  readonly startLine: number;
  readonly endLine: number;
  readonly insertion?: true;
  readonly associated: string[];
  explainedBy: IStagedReplacementReceipt['explainedBy'];
}

/** A creation or deletion receipt while findings are being associated. */
interface IFileReceiptDraft {
  readonly path: string;
  readonly operation: 'create' | 'delete';
  readonly associated: string[];
  explainedBy: 'finding' | 'existing-proposal' | 'neutral';
}

/** Input fields accepted by addStagedChangesToSarif; anything else is a caller mistake. */
const INPUT_KEYS = new Set(['sarif', 'worktree', 'reviewedCommit', 'repository', 'sourceRootUri']);

/** A full lowercase SHA-1 commit id, the reviewed revision's only accepted form. */
const FULL_COMMIT = /^[0-9a-f]{40}$/;

/** Largest staged or reviewed text this extraction reads, matching the publisher's source limit. */
const MAX_SOURCE_BYTES = 1_000_000;

/** Byte-order mark: kept in text, excluded from SARIF coordinates. */
const BOM = String.fromCharCode(0xfeff);

/** The owned SARIF property namespace (D23). */
const OWNED = 'sarifToComment';

/** Rule id and factual message tail for neutral results (contract §4.8). */
const NEUTRAL_RULE = 'staged-change';
const NEUTRAL_TAIL = 'No supplied finding was associated with this change.';

/** Column conventions SARIF defines; a run may declare one or neither. */
const COLUMN_KINDS: readonly [ColumnKind, ColumnKind] = ['utf16CodeUnits', 'unicodeCodePoints'];

/** Sentinel inserted to recover a region's exact source span through the replacement module. */
const SPAN_SENTINEL = '\u0000sarif-to-comment-span\u0000';

/** A strict extraction refusal: collected, then reported together. */
class ExtractionFailure extends Error {
  /** The refusals, reported together as a failed outcome. */
  readonly problems: readonly IProblem[];

  constructor(problems: readonly IProblem[]) {
    super();
    this.problems = problems;
  }
}

/**
 * A value an earlier step of this module has established (a text read
 * without a reported problem, a derived list, a queued index). Reaching the
 * throw means an internal invariant was broken.
 */
function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Internal error: ${what} is missing.`);
  return value;
}

/**
 * The element at `index` of a list whose bounds this module has already
 * established. Reaching the throw means an internal invariant was broken.
 */
function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Internal error: index ${String(index)} is outside a list of ${String(items.length)}.`);
  return item;
}

/**
 * Whether a value read through a SARIF view is a plain object. Unlike
 * isPlainObject, it keeps the view's type rather than widening it to
 * IPlainObject (a view whose properties are all optional would otherwise be
 * replaced by it).
 */
function isViewObject<T extends object>(value: T | undefined): value is T {
  return isPlainObject(value);
}

/**
 * The module's one unchecked boundary. `validateSarif` found no schema error
 * in `sarif` (the caller passes its null refusal as the evidence), so the
 * captured document conforms to the SARIF 2.1.0 schema, which the SARIF
 * views above never exceed (except `runs`, see {@link IStagedSarifLog}).
 */
function assertSchemaValid(_sarif: unknown, refusal: ISarifSchemaRefusal | null): asserts _sarif is IStagedSarifLog {
  if (refusal !== null) throw new Error('Internal error: a SARIF document with schema errors was about to be interpreted.');
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function requireInput(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid addStagedChangesToSarif input: ${message}`);
}

/** Validates the caller's arguments and captures the SARIF synchronously. */
function captureInput(input: unknown): ICapturedInput {
  requireInput(isPlainObject(input), 'input must be an object');
  for (const key of Object.keys(input)) requireInput(INPUT_KEYS.has(key), `unknown field ${key}`);
  const { worktree, reviewedCommit, repository, sourceRootUri } = input;
  requireInput(typeof worktree === 'string' && path.isAbsolute(worktree), 'worktree must be an absolute path');
  requireInput(typeof reviewedCommit === 'string' && FULL_COMMIT.test(reviewedCommit), 'reviewedCommit must be a full 40-character lowercase commit');
  requireInput(
    isPlainObject(repository)
      && Object.keys(repository).every((k) => k === 'owner' || k === 'repo')
      && typeof repository['owner'] === 'string' && OWNER_PATTERN.test(repository['owner'])
      && typeof repository['repo'] === 'string' && REPO_PATTERN.test(repository['repo']),
    'repository must be { owner, repo } naming a GitHub repository',
  );
  if (sourceRootUri !== undefined) {
    requireInput(
      typeof sourceRootUri === 'string' && /^file:/i.test(sourceRootUri) && !parseBaseUri(sourceRootUri).error,
      'sourceRootUri must be an absolute file: URI ending in "/"',
    );
  }
  requireInput(input['sarif'] !== undefined, 'sarif is required');
  const sarif = captureJson(input['sarif'], 'sarif');
  requireInput(isPlainObject(sarif), 'sarif must be a JSON object');
  return {
    sarif,
    worktree,
    reviewedCommit,
    repository: { owner: repository['owner'], repo: repository['repo'] },
    sourceRootUri,
  };
}

// ---------------------------------------------------------------------------
// Text and coordinates
// ---------------------------------------------------------------------------

/** Physical lines of text (split after LF, terminators kept; a lone CR is content). */
function physicalLines(text: string): IPhysicalLine[] {
  const lines: IPhysicalLine[] = [];
  let start = 0;
  while (start < text.length) {
    const lf = text.indexOf('\n', start);
    const end = lf === -1 ? text.length : lf + 1;
    const raw = text.slice(start, end);
    const terminator = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
    lines.push({ raw, body: raw.slice(0, raw.length - terminator.length), terminator });
    start = end;
  }
  return lines;
}

/** Length of `text` in the given SARIF column unit. */
function unitLength(text: string, kind: ColumnKind): number {
  return kind === 'utf16CodeUnits' ? text.length : Array.from(text).length;
}

/**
 * The end-of-file column of a final line that ends with a newline: just past
 * its terminator (SARIF §3.30.2 Example 8). With no declared kind, the column
 * must mean the same in both units, or it cannot be written unambiguously.
 */
function endOfFileColumn(line: IPhysicalLine, kind: ColumnKind | undefined): number | null {
  const columns = (k: ColumnKind): number => unitLength(line.body, k) + 1 + line.terminator.length;
  if (kind) return columns(kind);
  const a = columns(COLUMN_KINDS[0]);
  const b = columns(COLUMN_KINDS[1]);
  return a === b ? a : null;
}

/** Decodes blob bytes as fatal UTF-8 text (a BOM is kept), or null. */
function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Applies one SARIF region through the shared replacement module under a
 * run's column convention. With no declared kind both units must agree.
 * Returns the replacement outcome or { kind: 'ambiguous' }.
 */
function applyUnder(
  sourceText: string,
  deletedRegion: IReplacementRegion | null,
  insertedText: string,
  columnKind: ColumnKind | undefined,
): ReplacementOutcome | IAmbiguousOutcome {
  const kinds: readonly ColumnKind[] = columnKind ? [columnKind] : COLUMN_KINDS;
  const outcomes = kinds.map((k) => applyReplacement({ sourceText, deletedRegion, insertedText, columnKind: k }));
  const first = itemAt(outcomes, 0);
  if (outcomes.some((o) => JSON.stringify(o) !== JSON.stringify(first))) return { kind: 'ambiguous' };
  return first;
}

/**
 * The exact [start, end) UTF-16 span a SARIF region denotes in `text`, read
 * through the shared replacement module under a run's column convention, or
 * { error }. Offsets index the full text, including any byte-order mark.
 */
function regionSpan(text: string, region: IReplacementRegion | null, columnKind: ColumnKind | undefined): ISpan | ISpanFailure {
  if (text.includes(SPAN_SENTINEL)) return { error: 'the source contains the internal span sentinel' };
  const outcome = applyUnder(text, region, SPAN_SENTINEL, columnKind);
  if (outcome.kind === 'ambiguous') return { error: 'its columns mean different text in UTF-16 code units and code points, and the run declares no columnKind' };
  if (outcome.kind !== 'replacement' && outcome.kind !== 'unanchored') return { error: outcome.message };
  const at = outcome.editedText.indexOf(SPAN_SENTINEL);
  const suffix = outcome.editedText.length - at - SPAN_SENTINEL.length;
  return { start: at, end: text.length - suffix };
}

/**
 * The one-based inclusive lines a span covers. An empty span (insertion
 * point) belongs to the line it starts on; the end-of-file position belongs
 * to the last line. A span ending at a line start excludes that line.
 */
function spanLines(text: string, { start, end }: ISpan): LineRange {
  const lineOf = (offset: number): number => text.slice(0, offset).split('\n').length;
  const lastLine = Math.max(1, physicalLines(text).length);
  const first = Math.min(lineOf(start), lastLine);
  return [first, end > start ? Math.min(lineOf(end - 1), lastLine) : first];
}

/**
 * The exact lines a finding's region denotes in `text`, checking any snippet,
 * or { error }. Lines are one-based and inclusive.
 */
function regionLines(text: string, region: IStagedRegion, columnKind: ColumnKind | undefined): IRegionLines | ISpanFailure {
  const span = regionSpan(text, region, columnKind);
  if (span.error !== undefined) return span;
  const spanText = text.slice(span.start, span.end);
  if (region.snippet && region.snippet.text !== undefined && region.snippet.text !== spanText) {
    return { error: `its snippet ${JSON.stringify(region.snippet.text)} is not the source text ${JSON.stringify(spanText)}` };
  }
  const [startLine, endLine] = spanLines(text, span);
  return { startLine, endLine };
}

/**
 * Applies spans { start, end, inserted } located in the unmodified `text`.
 * Callers guarantee the spans are disjoint and none share a start, so
 * applying them from the end of the text backwards is exact.
 */
function applySpans(text: string, spans: readonly IEditSpan[]): string {
  let result = text;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, span.start) + span.inserted + result.slice(span.end);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Replacements derived from the index
// ---------------------------------------------------------------------------

/**
 * Exact SARIF replacements turning `reviewed` into `staged` for one file,
 * from Git's line hunks. Each has { region(kind) -> deletedRegion | null,
 * insertedText, changedLines: [s, e] | null (null for pure insertion),
 * insertionWhere, insertionLine }. For a pure insertion, insertionLine is the
 * reviewed line the text is inserted before (line count + 1 at the end); no
 * reviewed line is changed by it.
 *
 * Git numbers lines of the raw blob, in which a leading byte-order mark is
 * part of line 1. A reviewed file that is only a byte-order mark therefore
 * has one Git line but no visible lines; any staged text is then a single
 * insertion after the mark, located by character offset (offsets exclude
 * the mark), never a fabricated line.
 */
function replacementsFor(reviewedText: string, stagedText: string, hunks: readonly IDiffHunk[]): DerivedReplacement[] {
  const hasBom = reviewedText.startsWith(BOM);
  const reviewed = physicalLines(hasBom ? reviewedText.slice(1) : reviewedText);
  const staged = physicalLines(stagedText.startsWith(BOM) ? stagedText.slice(1) : stagedText);
  const n = reviewed.length;
  const fixed = (deletedRegion: IReplacementRegion): RegionFor => () => deletedRegion;
  if (n === 0) {
    const insertedText = staged.map((l) => l.raw).join('');
    return [{ region: fixed({ charOffset: 0, charLength: 0 }), insertedText, changedLines: null, insertionWhere: 'at the end', insertionLine: 1 }];
  }
  return hunks.map((h): DerivedReplacement => {
    const insertedText = staged.slice(h.newStart - 1, h.newStart - 1 + h.newCount).map((l) => l.raw).join('');
    if (h.oldCount === 0) {
      if (h.oldStart < n) {
        const line = h.oldStart + 1;
        return {
          region: fixed({ startLine: line, startColumn: 1, endLine: line, endColumn: 1 }),
          insertedText,
          changedLines: null,
          insertionWhere: `before line ${String(line)}`,
          insertionLine: line,
        };
      }
      const last = itemAt(reviewed, n - 1);
      return {
        region: (kind) => {
          const column = endOfFileColumn(last, kind);
          return column === null ? null : { startLine: n, startColumn: column, endLine: n, endColumn: column };
        },
        insertedText,
        changedLines: null,
        insertionWhere: 'at the end',
        insertionLine: n + 1,
      };
    }
    const s = h.oldStart;
    const e = h.oldStart + h.oldCount - 1;
    if (e < n) return { region: fixed({ startLine: s, startColumn: 1, endLine: e + 1, endColumn: 1 }), insertedText, changedLines: [s, e] };
    const last = itemAt(reviewed, n - 1);
    if (last.terminator === '') return { region: fixed({ startLine: s, endLine: n }), insertedText, changedLines: [s, e] };
    return {
      region: (kind) => {
        const column = endOfFileColumn(last, kind);
        return column === null ? null : { startLine: s, startColumn: 1, endLine: n, endColumn: column };
      },
      insertedText,
      changedLines: [s, e],
    };
  });
}

/**
 * Converter self-check (R2): the file's replacements, applied bottom-up
 * through the shared replacement module, must reproduce the staged text.
 */
function verifyReproduction(filePath: string, reviewedText: string, stagedText: string, replacements: readonly DerivedReplacement[]): void {
  let text = reviewedText;
  for (const r of [...replacements].reverse()) {
    const outcome = applyReplacement({ sourceText: text, deletedRegion: r.region('utf16CodeUnits'), insertedText: r.insertedText, columnKind: 'utf16CodeUnits' });
    if (outcome.kind !== 'replacement' && outcome.kind !== 'unanchored') {
      throw new Error(`Converter defect: a derived replacement for ${filePath} is not applicable (${outcome.message}).`);
    }
    text = outcome.editedText;
  }
  if (text !== stagedText) throw new Error(`Converter defect: derived replacements for ${filePath} do not reproduce the staged bytes.`);
}

// ---------------------------------------------------------------------------
// Runs, findings and supplied proposals
// ---------------------------------------------------------------------------

/** Whether a run declares newline sequences other than SARIF's CRLF/LF default. */
function nonDefaultNewlines(run: IStagedRun): boolean {
  const sequences = run.newlineSequences;
  if (sequences === undefined) return false;
  return !(Array.isArray(sequences) && sequences.length === 2 && sequences.includes('\r\n') && sequences.includes('\n'));
}

/**
 * Classifies a run's source binding exactly as the publisher reads it
 * (contract §2.1): unbound, bound (to one full revision of this repository),
 * conflicting or foreign.
 */
function runBinding(run: IStagedRun, repository: IRepositoryIdentity): RunBinding {
  const provenance = Array.isArray(run.versionControlProvenance) ? run.versionControlProvenance : [];
  const ours = provenance.filter((p) => isPlainObject(p) && typeof p.repositoryUri === 'string' && namesRepository(p.repositoryUri, repository));
  if (provenance.length > 0 && ours.length === 0) return { state: 'foreign' };
  const revisions = [...new Set(ours.map((p) => p.revisionId).filter((r) => r !== undefined))];
  if (revisions.length === 0) return { state: 'unbound' };
  const commit = itemAt(revisions, 0);
  if (revisions.length > 1 || !FULL_COMMIT.test(commit)) return { state: 'conflicting' };
  return { state: 'bound', commit };
}

/** Whether a physical location names its artifact. */
function namesArtifact(physical: ISarifPhysicalLocation): physical is ILocatedPhysicalLocation {
  return isPlainObject(physical.artifactLocation);
}

/** The single physical location of a result, or null. */
function singlePhysicalLocation(result: IStagedResult): ILocatedPhysicalLocation | null {
  const locations = Array.isArray(result.locations) ? result.locations : [];
  const only = locations[0];
  if (locations.length !== 1 || only === undefined || !isViewObject(only.physicalLocation)) return null;
  const physical = only.physicalLocation;
  return namesArtifact(physical) ? physical : null;
}

function hasFixes(result: IStagedResult): boolean {
  return Array.isArray(result.fixes) && result.fixes.length > 0;
}

function ownedOperations(result: IStagedResult): readonly unknown[] {
  const owned = isPlainObject(result.properties) ? result.properties[OWNED] : undefined;
  return isPlainObject(owned) && isArray(owned['proposedFileChanges']) ? owned['proposedFileChanges'] : [];
}

/** Whether a value of any shape is an array (its elements not yet examined). */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function problemsMarkdown(title: string, problems: readonly IProblem[]): string {
  const lines = problems.map((p) => listItem(`${p.path ? `\`${p.path}\`: ` : ''}${p.message}${p.pointer ? ` (at \`${p.pointer}\`)` : ''}`));
  return `**${title}**\n\n${lines.join('\n')}\n`;
}

function failedOutcome(problems: readonly IProblem[]): IFailedStagedChangesOutcome {
  return {
    status: 'failed',
    problems,
    markdown: problemsMarkdown('Staged changes could not be added; nothing was produced.', problems),
    diagnostics: problems.map(diagnosticOf),
  };
}

// ---------------------------------------------------------------------------
// Snapshot comparison and the operation envelope (contract §4.1-§4.2)
// ---------------------------------------------------------------------------

const MODE_NAMES = new Map<number, string>([
  [MODE.REGULAR, 'regular file'],
  [MODE.EXECUTABLE, 'executable file'],
  [MODE.SYMLINK, 'symbolic link'],
  [MODE.GITLINK, 'submodule'],
  [MODE.DIRECTORY, 'sparse directory'],
]);

function isRegular(mode: number): boolean {
  return mode === MODE.REGULAR || mode === MODE.EXECUTABLE;
}

function modeText(mode: number): string {
  return mode.toString(8).padStart(6, '0');
}

/**
 * Compares the reviewed tree with the index. Returns { changes, problems }
 * where each change is { path, reviewed?, staged?, operation } in index
 * path order, and problems are the strict refusals of §4.1-§4.2.
 */
function compareSnapshots(tree: ReadonlyMap<string, ITreeEntry>, index: IIndexSnapshot): ISnapshotComparison {
  const problems: IProblem[] = index.problems.map((p) => createProblem('staged-split-index', p));
  const staged = new Map<string, IIndexEntry>();
  const conflicted = new Set<string>();
  for (const entry of index.entries) {
    const key = entry.pathBytes.toString('latin1');
    const shown = decodeText(entry.pathBytes) ?? entry.pathBytes.toString('latin1');
    if (entry.stage > 0) {
      if (!conflicted.has(key)) {
        conflicted.add(key);
        problems.push(createProblem('staged-conflict', { path: shown, message: 'has unmerged (conflicted) index entries. Resolve the conflict and stage the intended content, then retry.' }));
      }
      continue;
    }
    if (entry.intentToAdd) {
      problems.push(createProblem('staged-intent-to-add', { path: shown, message: 'is intent-to-add (`git add -N`): its content is not staged. Stage the intended content with `git add`, or remove the intent-to-add entry, then retry.' }));
      continue;
    }
    if (entry.mode === MODE.DIRECTORY) {
      problems.push(createProblem('staged-sparse-directory', { path: shown, message: 'is a sparse-index directory entry, whose files are not listed in the index. Disable the sparse index (`git sparse-checkout disable` or `index.sparse=false`) and retry.' }));
      continue;
    }
    staged.set(key, entry);
  }
  const keys = [...new Set([...tree.keys(), ...staged.keys()])].filter((k) => !conflicted.has(k));
  keys.sort((a, b) => Buffer.compare(Buffer.from(a, 'latin1'), Buffer.from(b, 'latin1')));
  const changes: StagedChange[] = [];
  for (const key of keys) {
    const reviewed = tree.get(key);
    const next = staged.get(key);
    if (reviewed && next && reviewed.mode === next.mode && reviewed.oid === next.oid) continue;
    const bytes = present(reviewed || next, 'the entry of a changed path').pathBytes;
    const decoded = decodeText(bytes);
    if (decoded === null) {
      problems.push(createProblem('staged-path-not-utf8', { path: bytes.toString('latin1'), message: 'is not a valid UTF-8 path, which SARIF URIs cannot represent faithfully. Rename it or unstage it, then retry.' }));
      continue;
    }
    for (const [side, entry] of [['reviewed', reviewed], ['staged', next]] as const) {
      if (entry && !isRegular(entry.mode)) {
        const kind = MODE_NAMES.get(entry.mode) || `mode ${modeText(entry.mode)} entry`;
        problems.push(createProblem('staged-not-regular-file', { path: decoded, message: `is a ${kind} in the ${side === 'reviewed' ? 'reviewed commit' : 'index'}. Only regular files can be proposed; unstage this change and retry.` }));
      }
    }
    if ((reviewed && !isRegular(reviewed.mode)) || (next && !isRegular(next.mode))) continue;
    if (reviewed && next && reviewed.mode !== next.mode) {
      problems.push(createProblem('staged-mode-change', {
        path: decoded,
        message: `changes file mode from ${modeText(reviewed.mode)} to ${modeText(next.mode)}, which a SARIF proposal cannot represent. Unstage the mode change (\`git update-index --chmod\`) and retry.`,
      }));
      continue;
    }
    // The operation follows from which snapshots hold the path: both (edit),
    // only the index (create) or only the reviewed tree (delete).
    if (reviewed && next) {
      changes.push({ path: decoded, reviewed, staged: next, operation: 'edit' });
    } else if (next) {
      changes.push({ path: decoded, reviewed: undefined, staged: next, operation: 'create' });
    } else {
      changes.push({ path: decoded, reviewed: present(reviewed, 'the reviewed entry of a deleted path'), staged: undefined, operation: 'delete' });
    }
  }
  return { changes, problems };
}

/**
 * Records that content is over the source size limit and cannot be proposed
 * as text (an over-limit blob is never read, so only its size is known).
 */
function refuseOversize(change: { readonly path: string }, length: number, side: string, problems: IProblem[]): null {
  problems.push(createProblem('staged-file-too-large', { path: change.path, message: `is ${String(length)} bytes in the ${side}, over the 1,000,000-byte source limit. Unstage it or split the change, then retry.` }));
  return null;
}

/** Checks that proposed or edited content is extractable text; returns its text or records a problem. */
function textFor(change: { readonly path: string }, bytes: Buffer, side: string, problems: IProblem[]): string | null {
  if (bytes.length > MAX_SOURCE_BYTES) return refuseOversize(change, bytes.length, side, problems);
  if (bytes.includes(0)) {
    problems.push(createProblem('staged-binary', { path: change.path, message: `is binary (it contains NUL bytes) in the ${side}; binary changes cannot be proposed as text. Unstage it and retry.` }));
    return null;
  }
  const text = decodeText(bytes);
  if (text === null) {
    problems.push(createProblem('staged-content-not-utf8', { path: change.path, message: `is not valid UTF-8 in the ${side}; only UTF-8 text changes can be proposed. Unstage it and retry.` }));
  }
  return text;
}

// ---------------------------------------------------------------------------
// Main operation
// ---------------------------------------------------------------------------

/**
 * Adds the changes staged in a Git index, relative to a reviewed commit, to a
 * copy of a SARIF document as fixes on the findings they belong to.
 *
 * @remarks
 * Reads one snapshot of the index and the reviewed commit by blob identity;
 * working-tree files, filters and hooks are never used, and nothing in the
 * repository is changed. Applying the resulting replacements to the reviewed
 * files reproduces the staged files exactly.
 *
 * A finding receives a change only when its lines lie within the change's
 * reviewed lines; neither is enlarged. Findings with their own fixes are
 * never changed. A change no finding explains is added as a factual result
 * in a new run attributed to this package. File creation and deletion become
 * proposed file operations, which inspection shows but the current publisher
 * refuses. Unsupported changes fail the whole call rather than being dropped.
 *
 * @param input - The document, worktree, reviewed commit and repository.
 * @returns `added` with the new document and a receipt, `invalid` for input
 * that is not schema-valid SARIF, or `failed`.
 * @throws `TypeError` for malformed input; an `Error` when Git cannot be run,
 * the worktree is not in a repository, or the reviewed commit is not
 * available locally.
 *
 * @public
 */
export async function addStagedChangesToSarif(input: IAddStagedChangesInput): Promise<AddStagedChangesOutcome> {
  return addStagedChangesToSarifWithUntypedInput(input);
}

/**
 * Adds proposed changes from the Git index to a SARIF document.
 *
 * The implementation takes `unknown`: JavaScript callers are unconstrained,
 * so every field is validated at run time (captureInput). The public
 * {@link addStagedChangesToSarif} calls this with its documented parameter
 * type; the CLI calls it directly, because it passes parsed file content
 * that only this validation judges.
 *
 * @param input - { sarif, worktree, reviewedCommit, repository: { owner, repo }, sourceRootUri? }
 * @returns added | invalid | failed outcome (see module documentation)
 */
async function addStagedChangesToSarifWithUntypedInput(input: unknown): Promise<AddStagedChangesOutcome> {
  const captured = captureInput(input);
  const invalid = validateSarif(captured.sarif);
  if (invalid) return invalid;
  const sarif: unknown = captured.sarif;
  assertSchemaValid(sarif, invalid);

  const repo = await openRepository(captured.worktree, captured.reviewedCommit);
  const index = readIndexSnapshot(repo);
  const tree = await readTree(repo, captured.reviewedCommit);
  const { changes, problems } = compareSnapshots(tree, index);
  if (problems.length > 0) return failedOutcome(problems);

  await loadTexts(repo, changes, problems);
  if (problems.length > 0) return failedOutcome(problems);

  for (const change of changes.filter((c): c is IEditChange => c.operation === 'edit')) {
    const reviewedText = present(change.reviewedText, 'the reviewed text of an edited file');
    const stagedText = present(change.stagedText, 'the staged text of an edited file');
    if (reviewedText.startsWith(BOM) !== stagedText.startsWith(BOM)) {
      problems.push(createProblem('staged-bom-change', { path: change.path, message: `${reviewedText.startsWith(BOM) ? 'loses' : 'gains'} a leading byte-order mark, which SARIF coordinates cannot represent (they exclude it). Stage the file with its original byte-order mark state and retry.` }));
      continue;
    }
    change.replacements = replacementsFor(reviewedText, stagedText, await diffHunks(repo, change.reviewed.oid, change.staged.oid));
    verifyReproduction(change.path, reviewedText, stagedText, change.replacements);
  }
  if (problems.length > 0) return failedOutcome(problems);

  try {
    return incorporate(captured, sarif, changes);
  } catch (err) {
    if (err instanceof ExtractionFailure) return failedOutcome(err.problems);
    throw err;
  }
}

/** Reads and checks the blob text each change needs onto the change; records strict problems. */
async function loadTexts(repo: IGitRepository, changes: readonly StagedChange[], problems: IProblem[]): Promise<void> {
  const wanted: string[] = [];
  for (const c of changes) {
    if (c.reviewed) wanted.push(c.reviewed.oid);
    if (c.staged) wanted.push(c.staged.oid);
  }
  const sizes = await blobSizes(repo, wanted);
  const readable = wanted.filter((oid) => (sizes.get(oid) ?? 0) <= MAX_SOURCE_BYTES);
  const blobs = await readBlobs(repo, readable);
  for (const c of changes) {
    const bytesOf = (entry: GitEntry): Buffer => blobs.get(entry.oid) ?? Buffer.alloc(sizes.get(entry.oid) ?? 0);
    const sizeOf = (entry: GitEntry): number => sizes.get(entry.oid) ?? 0;
    const oversize = (entry: GitEntry): boolean => sizeOf(entry) > MAX_SOURCE_BYTES;
    if (c.operation === 'edit') {
      c.reviewedText = oversize(c.reviewed) ? refuseOversize(c, sizeOf(c.reviewed), 'reviewed commit', problems) : textFor(c, bytesOf(c.reviewed), 'reviewed commit', problems);
      c.stagedText = oversize(c.staged) ? refuseOversize(c, sizeOf(c.staged), 'index', problems) : textFor(c, bytesOf(c.staged), 'index', problems);
    } else if (c.operation === 'create') {
      c.stagedText = oversize(c.staged) ? refuseOversize(c, sizeOf(c.staged), 'index', problems) : textFor(c, bytesOf(c.staged), 'index', problems);
    } else if (!oversize(c.reviewed)) {
      // Deletion needs no content; text is kept only to validate findings on the deleted file.
      const bytes = bytesOf(c.reviewed);
      c.reviewedText = bytes.includes(0) ? null : decodeText(bytes);
    } else {
      c.reviewedText = null;
    }
  }
}

/**
 * Associates changes with eligible findings and supplied proposals, and
 * builds the output SARIF and receipt. Throws ExtractionFailure for strict
 * refusals discovered during association.
 */
function incorporate(captured: ICapturedInput, sarif: IStagedSarifLog, changes: readonly StagedChange[]): IAddedStagedChangesOutcome {
  const { reviewedCommit, repository, sourceRootUri } = captured;
  const byPath = new Map(changes.map((c): [string, StagedChange] => [c.path, c]));
  const problems: IProblem[] = [];
  const warnings: IProblem[] = [];
  const runs = Array.isArray(sarif.runs) ? sarif.runs : [];

  // Eligible located findings and supplied proposals on changed paths.
  const findings: (ILocatedFinding | null)[] = [];
  const suppliedEdits: ISuppliedEdit[] = [];
  const suppliedOps: ISuppliedOperation[] = [];
  runs.forEach((run, runIndex) => {
    const binding = runBinding(run, repository);
    const eligible = binding.state === 'unbound' || (binding.state === 'bound' && binding.commit === reviewedCommit);
    if (!eligible) return;
    (run.results || []).forEach((result, resultIndex) => {
      const pointer = `/runs/${String(runIndex)}/results/${String(resultIndex)}`;
      const physical = singlePhysicalLocation(result);
      if (physical) {
        const resolved = resolveArtifactPath(physical.artifactLocation, run, { sourceRootUri, repository });
        if (resolved.error) {
          problems.push(createProblem('finding-location-unresolved', { pointer, message: `its location cannot be resolved to a repository path (${resolved.error[1]}), so its association with staged changes cannot be decided. Use a repository-relative URI or pass the producer's source root, then retry.` }));
        } else {
          const change = byPath.get(resolved.path);
          if (change !== undefined) findings.push(locatedFinding(result, physical, run, runIndex, pointer, change, problems));
        }
      }
      collectSupplied(result, run, pointer, byPath, { sourceRootUri, repository }, suppliedEdits, suppliedOps, problems);
    });
  });
  if (problems.length > 0) throw new ExtractionFailure(problems);

  const neutralResults: INeutralResult[] = [];
  const neutralArtifacts: IStagedArtifact[] = [];
  const attachedRuns = new Set<number>();
  const receiptChanges: IStagedChangeReceipt[] = [];

  for (const change of changes) {
    const onPath = findings.filter((f): f is ILocatedFinding => f !== null && f.change === change);
    if (change.operation === 'edit') {
      receiptChanges.push(incorporateEdit(change, onPath, suppliedEdits, attachedRuns, neutralResults, warnings, problems));
    } else {
      receiptChanges.push(incorporateFileOperation(change, onPath, suppliedEdits, suppliedOps, attachedRuns, neutralResults, neutralArtifacts, problems));
    }
  }
  if (problems.length > 0) throw new ExtractionFailure(problems);

  // Bind every previously unbound run that received a new proposal (§4.6).
  const boundRuns: number[] = [];
  for (const runIndex of [...attachedRuns].sort((a, b) => a - b)) {
    const run = itemAt(runs, runIndex);
    if (runBinding(run, repository).state !== 'unbound') continue;
    const provenance = Array.isArray(run.versionControlProvenance) ? run.versionControlProvenance : [];
    let added = false;
    for (const entry of provenance) {
      if (isPlainObject(entry) && typeof entry.repositoryUri === 'string' && namesRepository(entry.repositoryUri, repository) && entry.revisionId === undefined) {
        entry.revisionId = reviewedCommit;
        added = true;
      }
    }
    if (!added) provenance.push({ repositoryUri: canonicalRepositoryUri(repository), revisionId: reviewedCommit });
    run.versionControlProvenance = provenance;
    boundRuns.push(runIndex);
  }

  let addedRun: number | null = null;
  if (neutralResults.length > 0) {
    const neutral: INeutralRun = {
      tool: { driver: { name: 'sarif-to-comment', version: packageVersion(), rules: [{ id: NEUTRAL_RULE }] } },
      columnKind: 'utf16CodeUnits',
      versionControlProvenance: [{ repositoryUri: canonicalRepositoryUri(repository), revisionId: reviewedCommit }],
      results: neutralResults,
    };
    if (neutralArtifacts.length > 0) neutral.artifacts = neutralArtifacts;
    addedRun = runs.length;
    runs.push(neutral);
  }

  return {
    status: 'added',
    sarif,
    receipt: { reviewedCommit, changes: receiptChanges, boundRuns, addedRun, warnings },
    diagnostics: warnings.map(diagnosticOf),
  };
}

function canonicalRepositoryUri(repository: IRepositoryIdentity): string {
  return repositoryUrl(repository);
}

/**
 * Validates an eligible finding on a changed path against the snapshot its
 * coordinates refer to (§2.2) and records its lines.
 */
function locatedFinding(
  result: IStagedResult,
  physical: ILocatedPhysicalLocation,
  run: IStagedRun,
  runIndex: number,
  pointer: string,
  change: StagedChange,
  problems: IProblem[],
): ILocatedFinding | null {
  const region = physical.region;
  const base: ILocatedFinding = { result, run, runIndex, pointer, change, lines: null };
  if (region === undefined) return base;
  if (nonDefaultNewlines(run)) {
    problems.push(createProblem('newline-sequences-unsupported', { pointer, path: change.path, message: 'its run declares newline sequences other than CRLF and LF, so its lines cannot be interpreted. Remove the declaration or the finding, then retry.' }));
    return null;
  }
  const text = change.operation === 'create' ? change.stagedText : change.reviewedText;
  const snapshot = change.operation === 'create' ? 'the proposed (staged) file' : 'the reviewed file';
  if (text === null || text === undefined) {
    problems.push(createProblem('finding-region-unreadable', { pointer, path: change.path, message: `its region cannot be checked because ${snapshot} is not UTF-8 text within the size limit. Remove the region or the finding, then retry.` }));
    return null;
  }
  const lines = regionLines(text, region, run.columnKind);
  if (lines.error !== undefined) {
    problems.push(createProblem('source-range-invalid', { pointer, path: change.path, message: `its region does not denote text in ${snapshot}: ${lines.error}. Correct the finding's location, then retry.` }));
    return null;
  }
  return { ...base, lines: [lines.startLine, lines.endLine] };
}

/** Records supplied text fixes and file operations that touch changed paths. */
function collectSupplied(
  result: IStagedResult,
  run: IStagedRun,
  pointer: string,
  byPath: ReadonlyMap<string, StagedChange>,
  options: IArtifactPathOptions,
  suppliedEdits: ISuppliedEdit[],
  suppliedOps: ISuppliedOperation[],
  problems: IProblem[],
): void {
  (Array.isArray(result.fixes) ? result.fixes : []).forEach((fix, fixIndex) => {
    (Array.isArray(fix.artifactChanges) ? fix.artifactChanges : []).forEach((artifactChange) => {
      const resolved = resolveArtifactPath(artifactChange.artifactLocation || {}, run, options);
      if (resolved.error) {
        problems.push(createProblem('supplied-fix-location-unresolved', { pointer: `${pointer}/fixes/${String(fixIndex)}`, message: `a supplied fix's file cannot be resolved (${resolved.error[1]}), so it cannot be compared with staged changes. Use a repository-relative URI or pass the producer's source root, then retry.` }));
        return;
      }
      const change = byPath.get(resolved.path);
      if (!change) return;
      const replacements = Array.isArray(artifactChange.replacements) ? artifactChange.replacements : [];
      suppliedEdits.push({ pointer: `${pointer}/fixes/${String(fixIndex)}`, run, change, replacements });
    });
  });
  for (const op of ownedOperations(result)) {
    if (!isPlainObject(op)) continue;
    const artifactIndex = op['artifactIndex'];
    if (typeof artifactIndex !== 'number' || !Number.isInteger(artifactIndex)) continue;
    const artifact = (run.artifacts || [])[artifactIndex];
    if (!isViewObject(artifact) || !isViewObject(artifact.location)) continue;
    const resolved = resolveArtifactPath(artifact.location, run, options);
    if (resolved.error) continue;
    const change = byPath.get(resolved.path);
    if (change === undefined) continue;
    suppliedOps.push({ pointer, op, artifact, run, change });
  }
}

/**
 * Compares supplied text fixes on one edited file with its staged
 * replacements by effect (contract §4.5) and returns, per staged replacement
 * index, whether an equal supplied fix explains it. Records a problem for
 * every conflict or undeterminable effect.
 *
 * One supplied artifactChange may hold several replacements. SARIF §3.57.1
 * locates every deletedRegion in the unmodified artifact and applies them as
 * if in array order, so their combined effect is defined when they are
 * disjoint and no two start at the same position; otherwise their relative
 * order is not defined and the effect cannot be established. The change's
 * replacements and the staged replacements are grouped into connected
 * components by overlapping lines. Replacements touching no staged change
 * are other supplied proposals and are left alone. For each component, the
 * supplied replacements applied to the reviewed text must equal the staged
 * replacements applied to it; equal components explain their staged
 * replacements, different ones are conflicts. No winner is chosen (R4).
 */
function compareSuppliedFixes(change: IEditChange, suppliedEdits: readonly ISuppliedEdit[], problems: IProblem[]): Set<number> {
  const text = present(change.reviewedText, 'the reviewed text of an edited file');
  const staged = present(change.replacements, 'the derived replacements of an edited file').map((x): IEditSpan => {
    const span = regionSpan(text, x.region('utf16CodeUnits'), 'utf16CodeUnits');
    if (span.error !== undefined) throw new Error(`Converter defect: a derived replacement for ${change.path} has no span (${span.error}).`);
    return { ...span, inserted: x.insertedText, lines: spanLines(text, span) };
  });
  const explained = new Set<number>();
  for (const supplied of suppliedEdits.filter((e) => e.change === change)) {
    const pieces: ISuppliedPiece[] = [];
    let unusable = false;
    for (const r of supplied.replacements) {
      const content: ISarifArtifactContent = isViewObject(r.insertedContent) ? r.insertedContent : {};
      const span = regionSpan(text, r.deletedRegion, supplied.run.columnKind);
      if (span.error !== undefined) {
        problems.push(createProblem('supplied-fix-unlocatable', { pointer: supplied.pointer, path: change.path, message: `a supplied fix cannot be located in the reviewed file (${span.error}), so it cannot be compared with the staged change. Correct or remove it, then retry.` }));
        unusable = true;
        break;
      }
      pieces.push({ ...span, inserted: typeof content.text === 'string' ? content.text : '', binary: content.binary !== undefined, lines: spanLines(text, span) });
    }
    if (unusable) continue;

    const differing: string[] = [];
    for (const component of components(pieces, staged)) {
      const touched = component.staged.map((i) => itemAt(staged, i));
      const own = component.supplied.map((i) => itemAt(pieces, i));
      const where = touched.map((x) => `${String(x.lines[0])}-${String(x.lines[1])}`).join(', ');
      if (own.some((p) => p.binary)) {
        problems.push(createProblem('supplied-fix-binary', { pointer: supplied.pointer, path: change.path, message: `a supplied fix inserts binary content where the staged change to lines ${where} edits text, so its effect cannot be established. Correct or remove it, then retry.` }));
        continue;
      }
      const ordered = [...own].sort((a, b) => a.start - b.start || a.end - b.end);
      const clash = ordered.findIndex((p, i) => {
        const previous = ordered[i - 1];
        return i > 0 && previous !== undefined && (p.start < previous.end || p.start === previous.start);
      });
      if (clash !== -1) {
        const overlap = itemAt(ordered, clash).start < itemAt(ordered, clash - 1).end;
        problems.push(createProblem('fix-replacements-overlap', {
          pointer: supplied.pointer,
          path: change.path,
          message: overlap
            ? `a supplied fix has replacements that overlap in the reviewed file near the staged change to lines ${where}, so their combined effect is not defined. Correct or remove it, then retry.`
            : `a supplied fix has two replacements at the same position near the staged change to lines ${where}, so their relative order is not defined. Correct or remove it, then retry.`,
        }));
        continue;
      }
      if (applySpans(text, own) === applySpans(text, touched)) {
        component.staged.forEach((i) => explained.add(i));
      } else {
        differing.push(where);
      }
    }
    if (differing.length > 0) {
      problems.push(createProblem('staged-fix-conflict', {
        pointer: supplied.pointer,
        path: change.path,
        message: `a supplied fix conflicts with the staged change to lines ${differing.join(' and ')}: applied to the reviewed file, its combined replacements have a different effect than the staged content. No winner is chosen; reconcile the fix or the staged content, then retry.`,
      }));
    }
  }
  return explained;
}

/**
 * Connected components of supplied pieces and staged replacements linked by
 * overlapping lines, keeping only components that contain a staged
 * replacement. Returns [{ supplied: indices, staged: indices }].
 */
function components(pieces: readonly ISuppliedPiece[], staged: readonly IEditSpan[]): IComponent[] {
  const nodes: IComponentNode[] = [
    ...pieces.map((p, i): IComponentNode => ({ kind: 'supplied', i, lines: p.lines })),
    ...staged.map((x, i): IComponentNode => ({ kind: 'staged', i, lines: x.lines })),
  ];
  const seen = new Set<number>();
  const result: IComponent[] = [];
  nodes.forEach((_node, start) => {
    if (seen.has(start)) return;
    const queue = [start];
    const members: IComponentNode[] = [];
    seen.add(start);
    while (queue.length > 0) {
      const current = itemAt(nodes, present(queue.shift(), 'a queued node'));
      members.push(current);
      nodes.forEach((other, j) => {
        if (!seen.has(j) && other.kind !== current.kind && overlaps(other.lines, current.lines)) {
          seen.add(j);
          queue.push(j);
        }
      });
    }
    const group: IComponent = { supplied: members.filter((m) => m.kind === 'supplied').map((m) => m.i), staged: members.filter((m) => m.kind === 'staged').map((m) => m.i) };
    if (group.staged.length > 0 && group.supplied.length > 0) result.push(group);
  });
  return result;
}

function overlaps([a, b]: LineRange, [c, d]: LineRange): boolean {
  return a <= d && c <= b;
}

/** A text fix object carrying one replacement. */
function fixFor(filePath: string, deletedRegion: IReplacementRegion | null, insertedText: string): ISarifFix {
  return {
    artifactChanges: [
      { artifactLocation: { uri: encodeRepositoryPath(filePath) }, replacements: [{ deletedRegion, insertedContent: { text: insertedText } }] },
    ],
  };
}

/** Associates one edited file's replacements (contract §4.5). */
function incorporateEdit(
  change: IEditChange,
  onPath: readonly ILocatedFinding[],
  suppliedEdits: readonly ISuppliedEdit[],
  attachedRuns: Set<number>,
  neutralResults: INeutralResult[],
  warnings: IProblem[],
  problems: IProblem[],
): IStagedChangeReceipt {
  const explained = compareSuppliedFixes(change, suppliedEdits, problems);
  const entries: IReplacementReceiptDraft[] = [];
  for (const [index, x] of present(change.replacements, 'the derived replacements of an edited file').entries()) {
    // A pure insertion changes no reviewed line: its receipt range is empty
    // (endLine = startLine - 1) at the line it precedes, never the unchanged
    // line a host suggestion may borrow to render it.
    const entry: IReplacementReceiptDraft = x.changedLines
      ? { startLine: x.changedLines[0], endLine: x.changedLines[1], associated: [], explainedBy: 'neutral' }
      : { startLine: x.insertionLine, endLine: x.insertionLine - 1, insertion: true, associated: [], explainedBy: 'neutral' };
    if (explained.has(index)) {
      entry.explainedBy = 'existing-fix';
      entries.push(entry);
      continue;
    }
    if (x.changedLines) {
      for (const f of onPath) {
        if (!f.lines) continue;
        const contained = x.changedLines[0] <= f.lines[0] && f.lines[1] <= x.changedLines[1];
        if (!contained) {
          if (overlaps(f.lines, x.changedLines)) {
            warnings.push(createProblem('finding-partially-overlaps-change', { pointer: f.pointer, path: change.path, message: `This finding (lines ${String(f.lines[0])}-${String(f.lines[1])}) partially overlaps the staged change to lines ${String(x.changedLines[0])}-${String(x.changedLines[1])} and was not associated; neither the change nor the finding was enlarged.` }));
          }
          continue;
        }
        if (hasFixes(f.result)) continue;
        const region = x.region(f.run.columnKind);
        if (!region) {
          warnings.push(createProblem('finding-association-needs-column-kind', { pointer: f.pointer, path: change.path, message: 'This finding was not associated because its run declares no columnKind and the staged change needs an end-of-file column that differs between UTF-16 code units and code points. The change is carried by a separate result in a run with an explicit columnKind.' }));
          continue;
        }
        f.result.fixes = [fixFor(change.path, region, x.insertedText)];
        attachedRuns.add(f.runIndex);
        entry.associated.push(f.pointer);
      }
    }
    if (entry.associated.length > 0) {
      entry.explainedBy = 'finding';
    } else {
      neutralResults.push(neutralEditResult(change.path, x));
    }
    entries.push(entry);
  }
  return { path: change.path, operation: 'edit', replacements: entries };
}

function neutralEditResult(filePath: string, x: DerivedReplacement): INeutralResult {
  const uri = encodeRepositoryPath(filePath);
  const region = x.region('utf16CodeUnits');
  // Location: a changed region is located by exactly its changed lines. An
  // insertion before an existing line is located by that zero-length
  // insertion point, the same point its fix inserts at: a real source
  // association that claims no reviewed line changed, which the publisher
  // presents together with the fix. An insertion at the end of the file (or
  // into a file with no visible lines) has no reviewed line to point at, so
  // the result has no location and the fix alone names the file. No
  // finding is ever credited with an insertion.
  const pointless = !x.changedLines && x.insertionWhere === 'at the end';
  const result: INeutralResult = {
    ruleId: NEUTRAL_RULE,
    message: {
      text: x.changedLines
        ? `Staged change to lines ${String(x.changedLines[0])}–${String(x.changedLines[1])} of \`${filePath}\`. ${NEUTRAL_TAIL}`
        : `Staged insertion ${x.insertionWhere} of \`${filePath}\`. ${NEUTRAL_TAIL}`,
    },
    locations: [
      {
        physicalLocation: x.changedLines
          ? { artifactLocation: { uri }, region: { startLine: x.changedLines[0], endLine: x.changedLines[1] } }
          : { artifactLocation: { uri }, region: { startLine: x.insertionLine, startColumn: 1, endLine: x.insertionLine, endColumn: 1 } },
      },
    ],
    fixes: [fixFor(filePath, region, x.insertedText)],
  };
  if (pointless) delete result.locations;
  return result;
}

/** The artifact describing a proposed file (contract §4.7). */
function artifactFor(change: FileOperationChange): IStagedArtifact {
  const location = { uri: encodeRepositoryPath(change.path) };
  return change.operation === 'create'
    ? { location, contents: { text: present(change.stagedText, 'the staged text of a created file') }, encoding: 'utf-8' }
    : { location };
}

function operationFor(change: FileOperationChange, artifactIndex: number): ProposedFileChange {
  return change.operation === 'create'
    ? { operation: 'create', artifactIndex, fileMode: modeText(change.staged.mode) }
    : { operation: 'delete', artifactIndex };
}

/** Operation fields this version interprets; any other field may change the proposal's meaning. */
const OPERATION_FIELDS = new Set(['operation', 'artifactIndex', 'fileMode']);

/** SARIF hash algorithm names (§3.24.11) this module can verify, mapped to node:crypto names. */
const VERIFIABLE_HASHES = new Map([['sha-256', 'sha256'], ['sha-1', 'sha1'], ['sha-384', 'sha384'], ['sha-512', 'sha512'], ['md5', 'md5']]);

/**
 * Why a supplied file proposal does not mean the same as the staged
 * operation, or null when it does (contract §4.5/§4.7: equality by meaning).
 *
 * Meaningful and compared: the operation and every operation field (a field
 * this version does not interpret is never assumed harmless); for a
 * creation, the file mode and the exact bytes the artifact describes, which
 * depend on its contents (text or base64 binary) and on its encoding (the
 * artifact's, else the run's defaultEncoding; anything other than UTF-8
 * writes different bytes than the staged UTF-8 text); a declared length or
 * verifiable hash, checked against the proposed bytes (the staged bytes for a
 * creation, the reviewed bytes for a deletion's described content); and a
 * nested artifact (parentIndex), which names content inside another file.
 *
 * Benign and left untouched, never compared: description, properties,
 * mimeType, sourceLanguage, roles, lastModifiedTimeUtc, contents.rendered and
 * contents.properties, extra location fields, and hashes under algorithm
 * names this module cannot compute. None of these changes the proposed bytes
 * or operation.
 */
function proposalMismatch(supplied: ISuppliedOperation, change: FileOperationChange): string | null {
  const { op, artifact, run } = supplied;
  const unknown = Object.keys(op).filter((k) => !OPERATION_FIELDS.has(k));
  if (unknown.length > 0) return `its operation has field(s) ${unknown.join(', ')} that this version does not interpret`;
  if (op['operation'] !== change.operation) return `it proposes ${JSON.stringify(op['operation'])} where the index has a ${change.operation}`;
  if (artifact.parentIndex !== undefined) return 'its artifact is nested inside another artifact';
  let expected: Buffer;
  if (change.operation === 'create') {
    // The mode is captured JSON of any shape; String() converts it exactly as
    // a template literal would (they differ only for symbols, which JSON has none of).
    const mode: unknown = op['fileMode'] ?? '100644';
    if (mode !== modeText(change.staged.mode)) return `its file mode ${String(mode)} differs from the staged mode ${modeText(change.staged.mode)}`;
    expected = Buffer.from(present(change.stagedText, 'the staged text of a created file'), 'utf8');
    if (!isViewObject(artifact.contents)) return 'its artifact has no contents, so the proposed content cannot be compared';
  } else {
    if (op['fileMode'] !== undefined) return 'a deletion does not take a file mode';
    if (!isViewObject(artifact.contents) && artifact.length === undefined && artifact.hashes === undefined) return null;
    if (typeof change.reviewedText !== 'string') return 'its artifact describes content that cannot be compared with the deleted file';
    expected = Buffer.from(change.reviewedText, 'utf8');
  }
  if (isViewObject(artifact.contents)) {
    const encoding = artifact.encoding ?? run.defaultEncoding;
    if (encoding !== undefined && !/^utf-?8$/i.test(encoding)) {
      return `its declared encoding ${encoding} describes different bytes than the staged UTF-8 content`;
    }
    const { text, binary } = artifact.contents;
    const described: Buffer[] = [];
    if (typeof text === 'string') described.push(Buffer.from(text, 'utf8'));
    if (typeof binary === 'string') {
      const bytes = Buffer.from(binary, 'base64');
      if (bytes.toString('base64') !== binary.replace(/\s/g, '')) return 'its base64 contents are malformed';
      described.push(bytes);
    }
    if (described.length === 0) return 'its artifact has no text or binary contents, so the proposed content cannot be compared';
    if (described.some((bytes) => !bytes.equals(expected))) return 'its contents differ from the staged content';
  }
  if (artifact.length !== undefined && artifact.length !== -1 && artifact.length !== expected.length) {
    return `its declared length ${String(artifact.length)} differs from the ${String(expected.length)}-byte content`;
  }
  for (const [name, value] of Object.entries(isPlainObject(artifact.hashes) ? artifact.hashes : {})) {
    const algorithm = VERIFIABLE_HASHES.get(name.toLowerCase());
    if (algorithm && String(value).toLowerCase() !== crypto.createHash(algorithm).update(expected).digest('hex')) {
      return `its declared ${name} hash does not match the content`;
    }
  }
  return null;
}

/** Associates one created or deleted file (contract §4.7). */
function incorporateFileOperation(
  change: FileOperationChange,
  onPath: readonly ILocatedFinding[],
  suppliedEdits: readonly ISuppliedEdit[],
  suppliedOps: readonly ISuppliedOperation[],
  attachedRuns: Set<number>,
  neutralResults: INeutralResult[],
  neutralArtifacts: IStagedArtifact[],
  problems: IProblem[],
): IStagedChangeReceipt {
  for (const s of suppliedEdits.filter((e) => e.change === change)) {
    problems.push(createProblem('staged-proposal-conflict', { pointer: s.pointer, path: change.path, message: `a supplied text fix edits a file the index ${change.operation === 'create' ? 'creates' : 'deletes'}; the proposals conflict. Reconcile them, then retry.` }));
  }
  const equal: ISuppliedOperation[] = [];
  for (const s of suppliedOps.filter((o) => o.change === change)) {
    const mismatch = proposalMismatch(s, change);
    if (mismatch === null) equal.push(s);
    else problems.push(createProblem('staged-proposal-conflict', { pointer: s.pointer, path: change.path, message: `a supplied file proposal conflicts with the staged ${change.operation}: ${mismatch}. No winner is chosen; reconcile them, then retry.` }));
  }
  const entry: IFileReceiptDraft = { path: change.path, operation: change.operation, associated: [], explainedBy: 'neutral' };
  if (equal.length > 0) {
    entry.explainedBy = 'existing-proposal';
    return entry;
  }
  const artifactIndexByRun = new Map<number, number>();
  for (const f of onPath) {
    if (hasFixes(f.result) || ownedOperations(f.result).length > 0) continue;
    let artifactIndex = artifactIndexByRun.get(f.runIndex);
    if (artifactIndex === undefined) {
      if (!Array.isArray(f.run.artifacts)) f.run.artifacts = [];
      f.run.artifacts.push(artifactFor(change));
      artifactIndex = f.run.artifacts.length - 1;
      artifactIndexByRun.set(f.runIndex, artifactIndex);
    }
    const properties: IPropertyBag = isPlainObject(f.result.properties) ? f.result.properties : (f.result.properties = {});
    const owned: IPropertyBag = isPlainObject(properties[OWNED]) ? properties[OWNED] : (properties[OWNED] = {});
    owned['proposedFileChanges'] = [operationFor(change, artifactIndex)];
    attachedRuns.add(f.runIndex);
    entry.associated.push(f.pointer);
  }
  if (entry.associated.length > 0) {
    entry.explainedBy = 'finding';
    return entry;
  }
  neutralArtifacts.push(artifactFor(change));
  neutralResults.push({
    ruleId: NEUTRAL_RULE,
    message: { text: `Staged ${change.operation === 'create' ? 'creation' : 'deletion'} of \`${change.path}\`. ${NEUTRAL_TAIL}` },
    locations: [{ physicalLocation: { artifactLocation: { uri: encodeRepositoryPath(change.path) } } }],
    properties: { [OWNED]: { proposedFileChanges: [operationFor(change, neutralArtifacts.length - 1)] } },
  });
  return entry;
}

export { addStagedChangesToSarifWithUntypedInput };
