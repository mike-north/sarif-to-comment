/**
 * Caller customization of review presentation (D60, "Customization"): the
 * public callback types, and the core's enforcement of what a callback may
 * not change.
 *
 * A library caller may replace the Markdown of named presentation components
 * with functions in its own application code (`options.presentation` of
 * publishSarifReview and validateSarifReview). Each callback receives the
 * component's semantic data, the built-in Markdown, and the fragments the
 * result must keep, and returns Markdown. The built-in presentations remain
 * the default for every component a caller leaves out.
 *
 * Ownership boundary. A callback decides how an element reads, never what is
 * published, where, or how it is identified. The core keeps, independent of
 * any callback:
 *   - placement and composition: inline comments, body sections, the
 *     source link and quote of a finding section, the location line of a
 *     finding in a proposed file, separators, and every native suggestion
 *     block, which the core appends after the findings it follows;
 *   - publication identity: the review's hidden publication marker and a
 *     companion's structured marker, which the core appends after all
 *     presentation;
 *   - the exact bytes of proposed content (a new file's block and details,
 *     an alternative's replacement blocks), required provenance (the
 *     producer's names in an attribution, a finding's attribution), the
 *     source association of a deletion (its permalink), and the findings a
 *     proposal carries — each listed in the context's `required` fragments,
 *     which the result must contain verbatim;
 *   - every size limit, which counts the customized Markdown.
 * A result is refused, before anything is written, when it is not a string,
 * is blank, omits a required fragment, could open a native suggestion block,
 * leaves a code fence or raw HTML open (either would swallow or hide what
 * follows, including a suggestion block or marker), contains text that reads
 * as a publication or suggestion marker, or — for an inline component —
 * spans more than one line. The refusal is a TypeError naming the component
 * and the rule. A callback's own exception propagates unchanged.
 *
 * Callbacks are explicitly supplied application code, not repository
 * configuration: nothing here evaluates template text or loads code (D60,
 * "Template execution constraint"). Repository templates are separate future
 * work.
 *
 * @see https://github.github.com/gfm/#fenced-code-blocks
 * @see https://github.github.com/gfm/#raw-html
 */

import { fenceProblem, unbalancedHtml } from './markdown.cjs';

// ---------------------------------------------------------------------------
// Public types

/**
 * What every presentation callback receives besides its component's data.
 *
 * @public
 */
export interface IPresentationContext {
  /**
   * The built-in Markdown for this element. Return it unchanged to keep the
   * default, or build on it.
   */
  readonly markdown: string;
  /**
   * Markdown fragments the result must contain verbatim: the exact proposed
   * content, provenance, source association and nested findings the core
   * guarantees whatever the presentation. Each is already in
   * {@link IPresentationContext.markdown}.
   */
  readonly required: readonly string[];
}

/**
 * The producer attribution of one finding: who produced it according to the
 * SARIF document — the tool, the extension defining its rule, and the rule.
 * This is never the GitHub account that publishes the review.
 *
 * @remarks
 * Inline Markdown: the result must be one line. `required` holds the tool's
 * name (and the extension's, when there is one) as literal Markdown.
 *
 * @public
 */
export interface IAttributionPresentationContext extends IPresentationContext {
  /** The SARIF tool's (driver's) name. */
  readonly tool: string;
  /** The tool's version, when the SARIF states one. */
  readonly version?: string;
  /** The tool extension that defines the finding's rule, when it is not the driver. */
  readonly component?: { readonly name: string; readonly version?: string };
  /** The finding's rule id, when it has one. */
  readonly ruleId?: string;
}

/**
 * One alternative fix listed with a finding.
 *
 * @public
 */
export interface IAlternativePresentation {
  /** Its number in the list: 1, 2, … in the producer's order. */
  readonly number: number;
  /** The fix's description as Markdown, when it has one. */
  readonly description?: string;
  /**
   * Markdown of the exact whole-line changes it would make, with their code
   * blocks. Required verbatim in the alternatives result.
   */
  readonly changes: string;
  /** The built-in Markdown of this alternative: number, description and changes. */
  readonly markdown: string;
}

/**
 * The further fixes of one finding, listed as alternatives to consider.
 * Nothing is applied; each only shows the changes it would make.
 *
 * @remarks
 * `required` holds each alternative's `changes`.
 *
 * @public
 */
export interface IAlternativesPresentationContext extends IPresentationContext {
  /** The alternatives in the producer's order (at least one). */
  readonly alternatives: readonly IAlternativePresentation[];
}

/**
 * One finding: its classification, explanation, location message, fix
 * description, alternatives and attribution.
 *
 * @remarks
 * `attribution` and `alternatives` are those components' results (custom,
 * when those callbacks are supplied). `required` holds the attribution and,
 * when present, the alternatives. The core places the finding: it adds the
 * source link and quote of a body section, the location line in a proposed
 * file, and the native suggestion block that follows a suggestion's findings.
 *
 * @public
 */
export interface IFindingPresentationContext extends IPresentationContext {
  /** The SARIF result level, when stated (`error`, `warning`, `note` or `none`). */
  readonly level?: string;
  /** The SARIF result kind, when stated. */
  readonly kind?: string;
  /** The SARIF baseline state, when stated. */
  readonly baselineState?: string;
  /** The finding's explanation as Markdown. */
  readonly message: string;
  /** The message of the finding's location as Markdown, when it has one. */
  readonly locationMessage?: string;
  /** The description of the finding's suggested (first) fix as Markdown, when it has one. */
  readonly fixDescription?: string;
  /** The finding's alternatives as presented, when it has any. */
  readonly alternatives?: string;
  /** The finding's attribution as presented. */
  readonly attribution: string;
}

/**
 * A proposal to add a new file, shown in the review body with the findings
 * that carry it.
 *
 * @remarks
 * `required` holds the path as a code span, the file details, the content
 * block (when the file has content) and the findings: together they state the
 * destination and the file's exact bytes.
 *
 * @public
 */
export interface IFileAdditionPresentationContext extends IPresentationContext {
  /** The new file's repository path. */
  readonly path: string;
  /** Its Git mode. */
  readonly fileMode: '100644' | '100755';
  /** Its size in bytes of UTF-8 text. */
  readonly byteLength: number;
  /** The details that, with the content block, determine its exact bytes (size, byte-order mark, line endings, final newline, mode). */
  readonly details: string;
  /** The fenced code block showing its content, or undefined for an empty file (or one holding only a byte-order mark). */
  readonly content: string | undefined;
  /** The findings that carry the proposal, as presented and joined. */
  readonly findings: string;
}

/**
 * A proposal to delete a whole file that exists at the reviewed commit,
 * shown in the review body with the findings that carry it.
 *
 * @remarks
 * `required` holds the file's permalink and the findings.
 *
 * @public
 */
export interface IFileDeletionPresentationContext extends IPresentationContext {
  /** The file's repository path. */
  readonly path: string;
  /** The reviewed commit the file exists at. */
  readonly commit: string;
  /** The permalink to the whole file at that commit. */
  readonly url: string;
  /** The findings that carry the proposal, as presented and joined. */
  readonly findings: string;
}

/**
 * The note in every suggestion pull request's description that explains how
 * it is accepted and when it can be closed.
 *
 * @public
 */
export interface ILifecycleNotePresentationContext extends IPresentationContext {
  /** The reviewed (original) pull request's number. */
  readonly pullNumber: number;
  /** The original pull request's head branch, which the suggestion pull request targets. */
  readonly headRef: string;
  /** Whether suggestion pull requests are created ready for review rather than as drafts. */
  readonly ready: boolean;
}

/**
 * Functions that return the Markdown of named review presentation components,
 * for library callers who want a different look. Each is optional; a
 * component left out keeps its built-in presentation.
 *
 * @remarks
 * A callback controls how an element reads, never what is published or how
 * it is identified. Whatever it returns, the review keeps its publication
 * marker, every suggestion pull request keeps its structured marker, native
 * suggestion blocks stay exactly as validated, and the size limits count the
 * customized text. A result is refused with a `TypeError`, before anything is
 * written, when it is not a non-blank string, omits one of its context's
 * `required` fragments, could open a suggestion block, leaves a code fence or
 * raw HTML open, contains text that reads as a publication or suggestion
 * marker, or (for `attribution`) spans more than one line. An exception a
 * callback throws propagates unchanged.
 *
 * Callbacks run while the review is prepared, once per element, and must be
 * deterministic. They are not part of the publication identity: a retry with
 * the same state path never re-renders what an earlier call already planned
 * or sent.
 *
 * @public
 */
export interface IReviewPresentation {
  /** One finding (see {@link IFindingPresentationContext}). */
  readonly finding?: ((context: IFindingPresentationContext) => string) | undefined;
  /** A finding's producer attribution (see {@link IAttributionPresentationContext}). */
  readonly attribution?: ((context: IAttributionPresentationContext) => string) | undefined;
  /** A finding's alternative fixes (see {@link IAlternativesPresentationContext}). */
  readonly alternatives?: ((context: IAlternativesPresentationContext) => string) | undefined;
  /** A proposed new file (see {@link IFileAdditionPresentationContext}). */
  readonly fileAddition?: ((context: IFileAdditionPresentationContext) => string) | undefined;
  /** A proposed file deletion (see {@link IFileDeletionPresentationContext}). */
  readonly fileDeletion?: ((context: IFileDeletionPresentationContext) => string) | undefined;
  /** A suggestion pull request's lifecycle note (see {@link ILifecycleNotePresentationContext}). */
  readonly lifecycleNote?: ((context: ILifecycleNotePresentationContext) => string) | undefined;
}

// ---------------------------------------------------------------------------
// Enforcement (internal)

/** The name of a customizable presentation component. */
export type PresentationComponent = keyof IReviewPresentation;

/** Every customizable component, in documentation order. */
export const PRESENTATION_COMPONENTS: readonly PresentationComponent[] = [
  'finding', 'attribution', 'alternatives', 'fileAddition', 'fileDeletion', 'lifecycleNote',
];

/** Components whose Markdown is embedded within a line, so a result must be one line. */
const INLINE_COMPONENTS: ReadonlySet<PresentationComponent> = new Set(['attribution']);

/**
 * Text that reads as an identity marker: the review's hidden publication
 * marker (`<!-- sarif-to-comment:…`) or a suggestion pull request's
 * structured marker (`<!-- suggestion-pr …`, docs/suggestion-pr-convention.md
 * §7). Recovery and cleanup find these by their text, so presentation must
 * never carry one.
 */
const MARKER_TEXT = /<!--\s*(?:sarif-to-comment:|suggestion-pr\b)/i;

/**
 * Why a caller's `presentation` value is not a valid set of callbacks,
 * worded to follow "options.presentation" (it begins with a space or with
 * ".component"), or null: it must be a plain object whose own keys are
 * component names, each a data property holding a function or undefined
 * (getters never run).
 */
export function presentationOptionProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ' must be an object of presentation callbacks';
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return ' must be a plain object of presentation callbacks';
  const known: ReadonlySet<string> = new Set(PRESENTATION_COMPONENTS);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol' || !known.has(key)) return ` has an unknown component ${String(key)}; the components are ${PRESENTATION_COMPONENTS.join(', ')}`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return `.${key} is an accessor property; supply the function itself`;
    const callback: unknown = descriptor.value;
    if (callback !== undefined && typeof callback !== 'function') return `.${key} must be a function returning Markdown`;
  }
  return null;
}

/** A presentation callback as the core calls it: its result is checked, not trusted to be a string. */
export type PresentationCallback<Context> = (context: Context) => unknown;

/** The context a component's callback receives. */
type ContextOf<Name extends PresentationComponent> = Parameters<NonNullable<IReviewPresentation[Name]>>[0];

/**
 * The presentation callbacks the core calls: a caller's `presentation`
 * captured by {@link capturePresentation} (or, inside the package, any
 * functions of the same shape).
 */
export type CapturedPresentation = { readonly [Name in PresentationComponent]?: PresentationCallback<ContextOf<Name>> | undefined };

/** The function a component name holds in a validated presentation value, if any. */
function callbackAt(value: object, name: PresentationComponent): PresentationCallback<object> | undefined {
  const callback: unknown = Object.getOwnPropertyDescriptor(value, name)?.value;
  if (typeof callback !== 'function') return undefined;
  return (context) => {
    const result: unknown = Reflect.apply(callback, undefined, [context]);
    return result;
  };
}

/**
 * A validated snapshot of a caller's `presentation` value: the functions as
 * they were when the call started, so later changes to the caller's object
 * have no effect. Throws a TypeError (built by `refuse`) when invalid.
 */
export function capturePresentation(value: unknown, refuse: (message: string) => TypeError): CapturedPresentation {
  const problem = presentationOptionProblem(value);
  if (problem !== null) throw refuse(`options.presentation${problem}`);
  if (typeof value !== 'object' || value === null) throw refuse('options.presentation must be an object of presentation callbacks');
  return Object.freeze({
    finding: callbackAt(value, 'finding'),
    attribution: callbackAt(value, 'attribution'),
    alternatives: callbackAt(value, 'alternatives'),
    fileAddition: callbackAt(value, 'fileAddition'),
    fileDeletion: callbackAt(value, 'fileDeletion'),
    lifecycleNote: callbackAt(value, 'lifecycleNote'),
  });
}

/**
 * The Markdown of one element: the callback's result when the caller
 * supplied one and it keeps every core guarantee (see the module
 * documentation), otherwise the built-in `context.markdown`.
 */
export function present<Context extends IPresentationContext>(
  name: PresentationComponent,
  callback: PresentationCallback<Context> | undefined,
  context: Context,
): string {
  if (callback === undefined) return context.markdown;
  const result = callback(Object.freeze({ ...context, required: Object.freeze([...context.required]) }));
  const refuse = (problem: string): TypeError => new TypeError(`Invalid presentation: options.presentation.${name} returned Markdown that ${problem}. `
    + 'A presentation callback may change how an element reads, never what is published or how it is identified.');
  if (typeof result !== 'string') throw refuse(`is not a string (it returned ${result === null ? 'null' : typeof result})`);
  const problem = markdownProblem(name, result, context.required);
  if (problem !== null) throw refuse(problem);
  return result;
}

/** Why a callback's Markdown breaks a core guarantee, worded to follow "returned Markdown that", or null. */
function markdownProblem(name: PresentationComponent, result: string, required: readonly string[]): string | null {
  if (result.trim() === '') return 'is blank, which would drop the element';
  const missing = required.find((fragment) => !result.includes(fragment));
  if (missing !== undefined) return `omits a required fragment, which must appear verbatim: ${JSON.stringify(missing)}`;
  switch (fenceProblem(result)) {
    case 'suggestion-fence':
      return 'could open a suggestion block; only a validated SARIF fix creates a native suggestion';
    case 'unclosed-fence':
      return 'leaves a code fence open, which would swallow what follows, including a suggestion block or marker';
    case null:
      break;
  }
  const html = unbalancedHtml(result);
  if (html !== null) return `leaves ${html} open, which could hide what follows, including a suggestion block or marker`;
  if (MARKER_TEXT.test(result)) return 'contains text that reads as a publication or suggestion marker, which only the core writes';
  if (INLINE_COMPONENTS.has(name) && /[\r\n]/.test(result)) return 'spans more than one line, but this component is inline';
  return null;
}
