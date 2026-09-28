// Public types shared by several operations (type-only module).
//
// The SARIF log, the problem and `invalid` outcome, and the repository shapes
// are part of more than one operation's documented contract. They are
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
