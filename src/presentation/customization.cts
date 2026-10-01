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
 *     an alternative's replacement blocks, an edit made by hand's block and
 *     details), required provenance (the producer's names in an
 *     attribution, a finding's attribution), the source association of a
 *     deletion (its permalink) and of an edit made by hand (its location
 *     link), and the findings a proposal carries — each listed in the
 *     context's `required` fragments, each shown at its own occurrence (a
 *     fragment that appears only inside another required one does not
 *     count),
 *     which the result must show as itself: verbatim, and not concealed or
 *     turned into other code (src/presentation/markdown-tree.cts,
 *     showsAsItself);
 *   - a group's identity and membership when it is made by hand: its
 *     guidance, member lines and change labels, around each change's
 *     component (docs/delivery-policy-contract.md §8.10);
 *   - the destination of an identity link — a manual edit's location, a
 *     deletion's link — which no link of the result may carry to anywhere
 *     else, unless the built-in Markdown has that exact link;
 *   - every size limit, which counts the customized Markdown.
 * A result is refused, before anything is written, when it is not a string,
 * is blank, omits a required fragment, could open a native suggestion block,
 * leaves a code fence or raw HTML open (either would swallow or hide what
 * follows, including a suggestion block or marker), contains text that reads
 * as a publication or suggestion marker, adds raw HTML or a link reference
 * definition of its own (a node whose exact source is also a node of the
 * built-in Markdown, and so is carried by the presented content, may pass
 * through), hides a required fragment, or — for an inline component — spans
 * more than one line. The refusal is a
 * TypeError naming the component and the rule. A callback's own exception
 * propagates unchanged. The context a callback receives is a deeply frozen
 * copy, so a callback cannot change what preparation holds.
 *
 * The checks read the Markdown with a conformant CommonMark + GFM parser
 * (src/presentation/markdown-tree.cts; docs/review-presentation-contract.md
 * §7 records where GitHub's renderer may differ).
 *
 * Callbacks are explicitly supplied application code, not repository
 * configuration: nothing here evaluates template text or loads code (D60,
 * "Template execution constraint"). Repository templates are separate future
 * work.
 *
 * @see https://github.github.com/gfm/#fenced-code-blocks
 * @see https://github.github.com/gfm/#raw-html
 */

import { addedConstruct, fenceProblem, linksIn, shownOccurrences, unbalancedHtml } from './markdown-tree.cjs';
import type { IOccurrence } from './markdown-tree.cjs';

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
 * The SARIF tool extension that defines a finding's rule, as an attribution
 * names it.
 *
 * @public
 */
export interface IAttributionComponent {
  /** The extension's name. */
  readonly name: string;
  /** The extension's version, when the SARIF states one. */
  readonly version?: string;
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
  readonly component?: IAttributionComponent;
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
 * One edit of a reviewed file for the author to make by hand, shown in the
 * review body: its exact whole-line replacement and the findings that carry
 * it. It is never a suggestion. It is presented alone (an edit delivered in
 * the review body) or as one change of a group made by hand, whose guidance
 * and labels the core keeps around it.
 *
 * @remarks
 * `required` holds the location link, the replacement block (when the lines
 * are replaced rather than removed), the details (when there are any) and
 * the findings: together they state the file, the lines, the reviewed
 * commit and the replacement's exact bytes.
 *
 * @public
 */
export interface IManualEditPresentationContext extends IPresentationContext {
  /** The edited file's repository path. */
  readonly path: string;
  /** The first replaced line of the reviewed file. */
  readonly startLine: number;
  /** The last replaced line of the reviewed file. */
  readonly endLine: number;
  /** The reviewed commit the lines are read at. */
  readonly commit: string;
  /** The permalink to the replaced lines at that commit. */
  readonly url: string;
  /** The Markdown link naming the file, the lines and the commit, to {@link IManualEditPresentationContext.url}. */
  readonly location: string;
  /**
   * The fenced code block of the new lines: LF line breaks, without the last
   * line's terminator or the file's own byte-order mark. Absent when the
   * lines are removed.
   */
  readonly replacement?: string;
  /** What the block cannot show (`CRLF line endings`, `no newline at end of file`), when anything. */
  readonly details?: string;
  /** The findings that carry the edit, as presented and joined. */
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
 * customized text. Results are read with a conformant CommonMark + GFM
 * parser. A result is refused with a `TypeError`, before anything is written,
 * when it:
 *
 * - is not a non-blank string;
 *
 * - omits one of its context's `required` fragments;
 *
 * - could open a suggestion block, or leaves a code fence, an HTML block or
 *   raw HTML open (a trailing `/>` closes only void elements);
 *
 * - contains text that reads as a publication or suggestion marker;
 *
 * - adds raw HTML or a link reference definition of its own (a node whose
 *   exact text the built-in Markdown also has as a node may pass through);
 *
 * - hides a `required` fragment: inside raw HTML, code it does not open, an
 *   image, a definition, an element GitHub does not display or that has a
 *   `hidden` or `style` attribute, or GitHub math (`$…$`); or, for a
 *   permalink, as an image source, as the text of a link elsewhere, or inside
 *   an `<a>` whose `href` is elsewhere;
 *
 * - (for `attribution`) spans more than one line;
 *
 * - once composed into its comment, body or suggestion pull request
 *   description, leaves something open there that the built-in presentation
 *   does not, or disturbs a suggestion block or marker.
 *
 * An exception a callback throws propagates unchanged.
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
  /** An edit made by hand in the review body (see {@link IManualEditPresentationContext}). */
  readonly manualEdit?: ((context: IManualEditPresentationContext) => string) | undefined;
  /** A suggestion pull request's lifecycle note (see {@link ILifecycleNotePresentationContext}). */
  readonly lifecycleNote?: ((context: ILifecycleNotePresentationContext) => string) | undefined;
}

// ---------------------------------------------------------------------------
// Enforcement (internal)

/** The name of a customizable presentation component. */
export type PresentationComponent = keyof IReviewPresentation;

/** Every customizable component, in documentation order. */
export const PRESENTATION_COMPONENTS: readonly PresentationComponent[] = [
  'finding', 'attribution', 'alternatives', 'fileAddition', 'fileDeletion', 'manualEdit', 'lifecycleNote',
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
    manualEdit: callbackAt(value, 'manualEdit'),
    lifecycleNote: callbackAt(value, 'lifecycleNote'),
  });
}

/**
 * A link that identifies what an element proposes: its text (as a reader
 * reads it) may lead only to its destination.
 */
export interface IIdentityLink {
  readonly text: string;
  readonly url: string;
}

/**
 * The Markdown of one element: the callback's result when the caller
 * supplied one and it keeps every core guarantee (see the module
 * documentation), otherwise the built-in `context.markdown`. `identity`
 * names the element's identity links.
 */
export function present<Context extends IPresentationContext>(
  name: PresentationComponent,
  callback: PresentationCallback<Context> | undefined,
  context: Context,
  identity: readonly IIdentityLink[] = [],
): string {
  if (callback === undefined) return context.markdown;
  const result = callback(deepFrozenCopy(context));
  const refuse = (problem: string): TypeError => new TypeError(`Invalid presentation: options.presentation.${name} returned Markdown that ${problem}. `
    + 'A presentation callback may change how an element reads, never what is published or how it is identified.');
  if (typeof result !== 'string') throw refuse(`is not a string (it returned ${result === null ? 'null' : typeof result})`);
  const problem = markdownProblem(name, result, context, identity);
  if (problem !== null) throw refuse(problem);
  return result;
}

/** A deeply frozen structured copy of a context: plain data only, so the callback can change nothing preparation holds. */
function deepFrozenCopy<Context extends IPresentationContext>(context: Context): Context {
  return deepFreeze(structuredClone(context));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
    Object.freeze(value);
  }
  return value;
}

/** Why a callback's Markdown breaks a core guarantee, worded to follow "returned Markdown that", or null. */
function markdownProblem(name: PresentationComponent, result: string, context: IPresentationContext, identity: readonly IIdentityLink[]): string | null {
  const { required } = context;
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
  const added = addedConstruct(result, context.markdown);
  if (added !== undefined) {
    return `adds ${added.kind === 'html' ? 'raw HTML' : 'a link reference definition'} of its own (${JSON.stringify(added.text)}), which could hide text; `
      + 'only raw HTML and definitions that the presented content carries may pass through';
  }
  const occurrences = required.map((fragment) => shownOccurrences(result, fragment));
  const concealed = required.find((_, i) => occurrences[i]?.length === 0);
  if (concealed !== undefined) {
    return `hides a required fragment, which must be shown as itself: ${JSON.stringify(concealed)} `
      + '(not inside raw HTML, a code span or block it does not open itself, an image, a definition or an element GitHub does not display, '
      + 'and, for a permalink, not as an image source or the text of a link to somewhere else)';
  }
  const shared = sharedFragment(required, occurrences);
  if (shared !== undefined) {
    return `shows a required fragment only inside another required fragment, but each must be shown on its own: ${JSON.stringify(shared)}`;
  }
  const spoofed = spoofedLink(result, context.markdown, identity);
  if (spoofed !== undefined) return `links the text ${JSON.stringify(spoofed.text)} to ${JSON.stringify(spoofed.url)} rather than its permalink`;
  if (INLINE_COMPONENTS.has(name) && /[\r\n]/.test(result)) return 'spans more than one line, but this component is inline';
  return null;
}

/**
 * Whether occurrence `a` of fragment `fa` and occurrence `b` of fragment `fb`
 * may both count: they are disjoint, or one is a URL inside the other, a link
 * to that very URL (a location link holds its own permalink).
 */
function compatible(fa: string, a: IOccurrence, fb: string, b: IOccurrence): boolean {
  if (a.end <= b.start || b.end <= a.start) return true;
  const within = (inner: IOccurrence, outer: IOccurrence): boolean => outer.start <= inner.start && inner.end <= outer.end;
  const linksTo = (link: string, url: string): boolean => /^https?:\/\/\S+$/.test(url) && link.includes(`](${url})`);
  return (within(b, a) && linksTo(fa, fb)) || (within(a, b) && linksTo(fb, fa));
}

/**
 * The required fragment that cannot be shown on its own, or undefined: the
 * fragments must be shown at occurrences that are pairwise compatible (see
 * compatible), so that a fragment appearing only inside another one — a
 * location link inside a finding's identical source link — never stands in
 * for itself. Every assignment is searched; when none exists, the fragment
 * named is one whose every occurrence lies inside another fragment's.
 */
function sharedFragment(required: readonly string[], occurrences: readonly (readonly IOccurrence[])[]): string | undefined {
  const chosen: IOccurrence[] = [];
  const assign = (i: number): boolean => {
    if (i === required.length) return true;
    const fragment = required[i] ?? '';
    for (const occurrence of occurrences[i] ?? []) {
      if (!chosen.every((other, j) => compatible(fragment, occurrence, required[j] ?? '', other))) continue;
      chosen.push(occurrence);
      if (assign(i + 1)) return true;
      chosen.pop();
    }
    return false;
  };
  if (assign(0)) return undefined;
  const inside = required.find((fragment, i) => (occurrences[i] ?? []).every((occurrence) => required.some((other, j) => j !== i && other !== fragment
    && (occurrences[j] ?? []).some((outer) => outer.start <= occurrence.start && occurrence.end <= outer.end && !compatible(fragment, occurrence, other, outer)))));
  return inside ?? required[required.length - 1];
}

/**
 * A link of `result` that carries an identity link's text to another
 * destination, or undefined. A link the built-in Markdown has exactly (text
 * and destination) passes through: it is the presented content's own.
 */
function spoofedLink(result: string, builtIn: string, identity: readonly IIdentityLink[]): { readonly text: string; readonly url: string } | undefined {
  if (identity.length === 0) return undefined;
  const own = linksIn(builtIn);
  return linksIn(result).find((link) => identity.some((id) => id.text === link.text && id.url !== link.url)
    && !own.some((o) => o.text === link.text && o.url === link.url));
}
