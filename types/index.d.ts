/**
 * Author, inspect and extend SARIF 2.1.0, and publish it as one GitHub draft
 * pull request review.
 *
 * @remarks
 * Five operations work on ordinary in-memory SARIF values:
 *
 * - {@link createSarifDocument} and {@link addSarifComment} optionally author
 *   SARIF for your own findings, on lines or line ranges.
 *
 * - {@link inspectSarif} shows every finding, location and fix in any SARIF.
 *
 * - {@link addStagedChangesToSarif} adds the changes staged in a Git index as
 *   SARIF fixes.
 *
 * - {@link publishSarifReview} publishes a ready document as one draft review.
 *
 * Authoring is optional: SARIF from any producer can be inspected, extended
 * and published directly, and no operation depends on how a document was
 * made. There is no builder, session or private format; each operation that
 * changes a document returns a new one and leaves its input untouched.
 *
 * The `sarif-to-comment` command-line interface provides the same operations
 * for files (`init`, `add-comment`, `inspect`, `add-staged-changes`,
 * `publish`). These declarations describe the CommonJS runtime in
 * `src/index.cjs`; they are written by hand, checked by API Extractor and
 * compiled against CommonJS and ES module consumers by the package tests.
 *
 * @packageDocumentation
 */

/**
 * The pull request that receives the review.
 *
 * @public
 */
export interface IPullRequestDestination {
  /** Account or organization that owns the repository, for example `acme`. */
  readonly owner: string;
  /** Repository name, for example `widgets`. */
  readonly repo: string;
  /** Pull request number (a positive integer). */
  readonly pullNumber: number;
}

/**
 * Options that change how a ready document is judged. Unknown options are
 * refused.
 *
 * @public
 */
export interface IPublishSarifReviewOptions {
  /**
   * Publish despite an approval hold declared in the SARIF
   * (`properties.sarifToComment.approval: "awaiting-approval"`). Bypasses only
   * the hold, never validation, and is not part of the publication identity.
   */
  readonly ignoreApprovalHold?: boolean | undefined;
}

/**
 * Input to {@link publishSarifReview}. Unknown fields are refused.
 *
 * @public
 */
export interface IPublishSarifReviewInput {
  /**
   * The SARIF 2.1.0 log as a parsed JSON object (not text). It is copied
   * when the call starts; later changes to your object have no effect. Values
   * JSON cannot represent (cycles, functions, `undefined`, `NaN`, class
   * instances, accessors) are refused rather than dropped.
   */
  readonly sarif: object;
  /** The pull request that receives the review. */
  readonly destination: IPullRequestDestination;
  /**
   * Full 40-character lowercase commit SHA the review is about. The review
   * stays pinned to it even if the pull request has since advanced; findings
   * that cannot be anchored there become exact links in the review body.
   */
  readonly reviewedCommit: string;
  /**
   * Absolute path of the durable publication state file: the identity of
   * this publication. Retry with the same path; never delete it after an
   * `uncertain` outcome. A new path starts a new, separate review.
   */
  readonly statePath: string;
  /**
   * GitHub personal access token (or user token) used to read the pull
   * request and create the draft review. GitHub App installation tokens,
   * including the automatic Actions `GITHUB_TOKEN`, are not supported. Never
   * persisted, fingerprinted, rendered or included in a rejection.
   */
  readonly token: string;
  /**
   * Absolute `file:` URI (ending in `/`) of the repository root in the SARIF
   * producer's file system, so absolute artifact URIs resolve to repository
   * paths.
   */
  readonly sourceRootUri?: string | undefined;
  /**
   * Full commit SHA to use as the diff's old side when GitHub's own
   * comparison cannot establish it. Only a candidate: every old-side file is
   * verified against the pull request's patches.
   */
  readonly oldSourceCommit?: string | undefined;
  /** Options; see {@link IPublishSarifReviewOptions}. */
  readonly options?: IPublishSarifReviewOptions | undefined;
}

/**
 * The draft review on GitHub.
 *
 * @public
 */
export interface IPublishedReview {
  /** GitHub's numeric review id. */
  readonly id: number;
  /** Web URL of the review. */
  readonly url: string;
}

/**
 * The publication is complete: the draft review was created and confirmed
 * now, confirmed after an earlier uncertain attempt, or recorded as complete
 * in the state file by an earlier call.
 *
 * @remarks
 * A completed record is returned without contacting GitHub. Publication is
 * one-way: the review may since have been submitted, edited or deleted by a
 * person, and the tool does not check.
 *
 * @public
 */
export interface IPublishedOutcome {
  /** Discriminant: The publication is complete. */
  readonly status: 'published';
  /** The review as it was when the publication completed. */
  readonly review: IPublishedReview;
  /** The state file recording this publication. */
  readonly statePath: string;
  /** Human-readable explanation, including the review link. */
  readonly markdown: string;
}

/**
 * The document cannot be published faithfully. Nothing was written to GitHub
 * and no state file was created.
 *
 * @public
 */
export interface IBlockedOutcome {
  /** Discriminant: Nothing was published. */
  readonly status: 'blocked';
  /** Every problem, with a pointer into the SARIF document. */
  readonly markdown: string;
}

/**
 * Delivery could not be confirmed. Retry later with the same state path; it
 * only checks GitHub and never sends the review again. Do not delete the
 * state file.
 *
 * @public
 */
export interface IUncertainOutcome {
  /** Discriminant: Delivery could not be confirmed. */
  readonly status: 'uncertain';
  /** The preserved state file to retry with. */
  readonly statePath: string;
  /** What is known and what to do next. */
  readonly markdown: string;
}

/**
 * GitHub definitively refused the create-review request (for example because
 * the account already has a pending review on the pull request). It is never
 * resent; publish again with a new state path after resolving the cause.
 *
 * @public
 */
export interface IRejectedOutcome {
  /** Discriminant: GitHub refused the request. */
  readonly status: 'rejected';
  /** The state file that records the refusal. */
  readonly statePath: string;
  /** GitHub's reason and what to do next. */
  readonly markdown: string;
}

/**
 * Every outcome of {@link publishSarifReview}, discriminated by `status`.
 *
 * @public
 */
export type PublishSarifReviewOutcome = IPublishedOutcome | IBlockedOutcome | IUncertainOutcome | IRejectedOutcome;

/**
 * Publishes a ready SARIF document as one GitHub draft review — or explains
 * why it is blocked, uncertain or refused.
 *
 * @remarks
 * The whole document is validated before anything is written: if any finding
 * cannot be published faithfully, nothing is published. Publication is
 * one-way and draft-only: the tool never submits, updates, restores or
 * deletes a review. Retrying with the same `statePath` never creates a second
 * review; an existing record is honoured before any GitHub request for the
 * pull request's source.
 *
 * @param input - The document, destination, reviewed commit, state path and
 * credential.
 * @returns The outcome. `status` plus `markdown` is the stable contract;
 * internal diagnostic codes are not part of it.
 * @throws `TypeError` for invalid input (before any network request); an
 * `Error` for a corrupt state file, a state path reused for different input,
 * or an operational failure (for example the network). A rejection never
 * contains the token.
 *
 * @example
 * ```ts
 * import { publishSarifReview } from 'sarif-to-comment';
 *
 * const outcome = await publishSarifReview({
 *   sarif,
 *   destination: { owner: 'acme', repo: 'widgets', pullNumber: 42 },
 *   reviewedCommit: 'c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de',
 *   statePath: '/var/lib/my-linter/acme-widgets-42.json',
 *   token: process.env.GH_TOKEN!,
 * });
 * if (outcome.status === 'published') console.log(outcome.review.url);
 * ```
 *
 * @public
 */
export declare function publishSarifReview(input: IPublishSarifReviewInput): Promise<PublishSarifReviewOutcome>;

// ---------------------------------------------------------------------------
// Shared SARIF and outcome types
// ---------------------------------------------------------------------------

/**
 * A SARIF 2.1.0 log as a plain JSON object. The operations in this package
 * return fresh values of this shape, which you own and may change or store.
 *
 * @remarks
 * Only the top-level fields every document has are typed; everything else in
 * SARIF is ordinary JSON.
 *
 * @public
 */
export interface ISarifLog {
  /** The SARIF schema URI, when present. */
  $schema?: string;
  /** Always `"2.1.0"`. */
  version: '2.1.0';
  /** The runs, each with its own tool and results. */
  runs: object[];
  /** Any other top-level SARIF property. */
  [property: string]: unknown;
}

/**
 * A problem that prevented an operation, with where it is.
 *
 * @public
 */
export interface IProblem {
  /** What is wrong and what would fix it, as Markdown. */
  readonly message: string;
  /** JSON Pointer into the SARIF document, when the problem is in it. */
  readonly pointer?: string | undefined;
  /** Repository-relative path, when the problem concerns a file. */
  readonly path?: string | undefined;
}

/**
 * The input is not schema-valid SARIF 2.1.0, or cannot take the requested
 * change. Nothing was produced.
 *
 * @public
 */
export interface IInvalidSarifOutcome {
  /** Discriminant: the SARIF input was refused. */
  readonly status: 'invalid';
  /** Every problem found. */
  readonly problems: readonly IProblem[];
  /** The same problems as a human-readable explanation. */
  readonly markdown: string;
}

/**
 * A GitHub repository.
 *
 * @public
 */
export interface IGitHubRepository {
  /** Account or organization that owns the repository, for example `acme`. */
  readonly owner: string;
  /** Repository name, for example `widgets`. */
  readonly repo: string;
}

/**
 * The repository and reviewed commit a run's locations refer to. The run
 * records it as `versionControlProvenance` with repository URI
 * `https://github.com/OWNER/REPO`.
 *
 * @public
 */
export interface ISarifSourceBinding extends IGitHubRepository {
  /** Full 40-character lowercase commit SHA. */
  readonly commit: string;
}

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

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
export declare function createSarifDocument(options?: ICreateSarifDocumentOptions): ISarifLog;

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
}

/**
 * Every outcome of {@link addSarifComment}, discriminated by `status`.
 *
 * @public
 */
export type AddSarifCommentOutcome = IAddedSarifCommentOutcome | IInvalidSarifOutcome;

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
export declare function addSarifComment(sarif: object, comment: ISarifComment): AddSarifCommentOutcome;

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

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
 * finding. The current publisher refuses these.
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
export declare function inspectSarif(sarif: object, options?: IInspectSarifOptions): InspectSarifOutcome;

// ---------------------------------------------------------------------------
// Staged changes
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
   * are left unassociated) or proposals the current publisher refuses.
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
}

/**
 * Every outcome of {@link addStagedChangesToSarif}, discriminated by `status`.
 *
 * @public
 */
export type AddStagedChangesOutcome = IAddedStagedChangesOutcome | IInvalidSarifOutcome | IFailedStagedChangesOutcome;

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
export declare function addStagedChangesToSarif(input: IAddStagedChangesInput): Promise<AddStagedChangesOutcome>;
