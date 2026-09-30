// Public types shared by several operations (type-only module).
//
// The SARIF log, the diagnostic and problem, the `invalid` outcome, and the
// repository shapes are part of more than one operation's documented
// contract. They are
// declared once here, with their public names and documentation, and every
// implementing module imports them with `import type`, so the generated
// public declarations have exactly one definition of each.
//
// This module has no runtime content: its compiled output holds only the
// CommonJS module marker and is not shipped.

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
 * How serious a diagnostic is: `error` (the operation did not do what was
 * asked), `warning` (it did, or may have, and something needs attention) or
 * `note` (information only).
 *
 * @public
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'note';

/**
 * Where a diagnostic is. At least one field is present.
 *
 * @public
 */
export interface IDiagnosticLocation {
  /** JSON Pointer into the SARIF document, such as `/runs/0/results/3`. */
  readonly pointer?: string;
  /** Repository-relative path of the file concerned. */
  readonly path?: string;
  /** First one-based line of `path` concerned. */
  readonly startLine?: number;
  /** Last one-based line of `path` concerned. */
  readonly endLine?: number;
}

/**
 * An error, warning or note, modelled once and rendered for each audience:
 * as JSON or TOON for agents, as a colored block for people, and as the
 * Markdown of an outcome's `markdown` field.
 *
 * @remarks
 * Every outcome carries its diagnostics in `diagnostics`, ordered errors,
 * then warnings, then notes. `code` is stable once released; the catalog in
 * the package's `docs/diagnostics.md` lists every code with its severity,
 * title, meaning and typical remedies, and `docs/diagnostic.v1.schema.json`
 * is the JSON Schema of this shape.
 *
 * @public
 */
export interface IDiagnostic {
  /** How serious it is; always the same for a code. */
  readonly severity: DiagnosticSeverity;
  /** Stable kebab-case code from the catalog, such as `approval-hold`. */
  readonly code: string;
  /** One plain-text line, the same for every diagnostic of the code. */
  readonly title: string;
  /** The full explanation, as Markdown. */
  readonly message: string;
  /** Where it is, when it concerns a place in the document or a file. */
  readonly location?: IDiagnosticLocation;
  /** What it concerns when that is not a location: a pull request (`owner/repo#7`), a file, a command. */
  readonly subject?: string;
  /** Concrete next steps, in order; absent when nothing needs doing. */
  readonly remedies?: readonly string[];
}

/**
 * A problem that prevented an operation, with where it is: a diagnostic
 * that also carries its location's pointer and path directly, as problems
 * always have.
 *
 * @public
 */
export interface IProblem extends IDiagnostic {
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
  /** The same problems as diagnostics. */
  readonly diagnostics: readonly IDiagnostic[];
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
