/**
 * Grouping fixes for joint acceptance (private internal module).
 *
 * SARIF groups changes natively only within one fix: a fix's artifact
 * changes and replacements apply together. It cannot join fixes of different
 * findings, or an edit with a whole-file creation or deletion. This module
 * lets a caller declare such a group without editing SARIF by hand, as an
 * authoring step separate from extraction (issue #29;
 * docs/companion-suggestion-pr-contract.md §2.3 and §2.12). With suggestion
 * pull requests allowed, publication proposes each group as one suggestion
 * pull request.
 *
 * Representation: every member result carries the same
 * `properties.sarifToComment.suggestionGroup` value. The property is read by
 * publication only; nothing about it reaches GitHub except the name, in the
 * suggestion pull request's title.
 *
 * Rules, all checked before anything changes:
 * - Selection is by inspection selectors, never guessed. A selector taken
 *   before the document changed is stale and refused; a bare position, or the
 *   same finding named twice, is caller misuse.
 * - A finding's change is its primary (first) fix, or its proposed whole-file
 *   operation. Further fixes are alternatives and never join a group.
 * - A group holds at least two distinct changes (identical changes count
 *   once). A member without a change is refused.
 * - A finding belongs to at most one group, and groups are never joined: a
 *   finding already in another group is refused. A name the document already
 *   uses extends that group (the owner's principle: refuse only when the
 *   tool cannot proceed safely), and its existing members count toward the
 *   two distinct changes. Ungrouping never leaves a group with fewer than two
 *   distinct changes, because such a group can never be published; the
 *   refusal names the rest of the group, to dissolve it instead.
 * - A change is carried by one group or by none (issue #42): a finding
 *   outside the group may not carry a change identical to one of the
 *   group's, since publication always refuses that
 *   (`suggestion-group-change-shared`). Grouping names each such finding
 *   with its current selector, to include it (or, in another group, to
 *   ungroup it first); ungrouping names the members that stay with the
 *   identical change, to ungroup them together. The identical change is
 *   never moved into the group: that would be inference.
 * - Nothing is inferred: only the named findings change.
 *
 * Distinctness is judged structurally here (the replacement or operation as
 * written), since this module reads no source; publication judges it again
 * against the reviewed files and refuses a group of one change.
 *
 * Invariants shared with the other authoring operations: inputs are
 * captured, never mutated; the returned document shares no objects with the
 * input; the module is pure (no source, Git, GitHub or file access).
 */

import { documentDigest, findingSelector, parseFindingSelector } from './finding-selectors.cjs';
import type { IParsedSelector } from './finding-selectors.cjs';
import { canonicalJson, captureJson, isPlainObject, isSuggestionGroupName, validateSarif } from './sarif-common.cjs';
import type { JsonValue } from './sarif-common.cjs';
import { createProblem, diagnosticOf } from './diagnostics.cjs';
import type { IDiagnostic, IInvalidSarifOutcome, IProblem, ISarifLog } from './public-types.cjs';
import type { IStaleSarifSelectorOutcome } from './sarif-authoring.cjs';

// ---------------------------------------------------------------------------
// Public types

/**
 * Options for {@link groupSarifFixes}. Unknown fields are refused.
 *
 * @public
 */
export interface IGroupSarifFixesOptions {
  /**
   * The findings whose changes must be accepted together: `selector`s from
   * {@link inspectSarif}, each naming a different finding of the document as
   * inspected. A finding's change is its primary (first) fix, or its
   * proposed whole-file operation; further fixes are alternatives and never
   * join a group. A new group needs findings with at least two distinct
   * changes; one finding can extend an existing group.
   */
  readonly findings: readonly string[];
  /**
   * The group's name, shown in the suggestion pull request's title: 1-100
   * characters with no control or invisible formatting characters and no
   * leading or trailing whitespace. A name already in use in the document
   * extends that group.
   */
  readonly group: string;
}

/**
 * Options for {@link ungroupSarifFixes}. Unknown fields are refused.
 *
 * @public
 */
export interface IUngroupSarifFixesOptions {
  /**
   * The findings to take out of their groups: at least one `selector` from
   * {@link inspectSarif}, each naming a different finding.
   */
  readonly findings: readonly string[];
}

/**
 * A finding {@link groupSarifFixes} added to the group.
 *
 * @public
 */
export interface IGroupedFinding {
  /** JSON Pointer to the finding, such as `/runs/0/results/3`. */
  readonly ref: string;
  /** Index of its run. */
  readonly runIndex: number;
  /** Index of the finding in its run. */
  readonly resultIndex: number;
  /** The run's tool name. */
  readonly tool: string;
  /**
   * How many changes the finding contributes: the replacements of its primary
   * fix, plus its proposed whole-file operations.
   */
  readonly changes: number;
}

/**
 * The findings were grouped in a new copy of the document.
 *
 * @public
 */
export interface IGroupedSarifFixesOutcome {
  /** Discriminant: the findings were grouped. */
  readonly status: 'grouped';
  /** The new document. Your input is unchanged; use this value from now on. */
  readonly sarif: ISarifLog;
  /** The group's name. */
  readonly group: string;
  /** Whether the group already existed in the document and was extended. */
  readonly extended: boolean;
  /** The findings named in this call, in document order. */
  readonly findings: readonly IGroupedFinding[];
  /** How many distinct changes the whole group now holds; identical changes count once. */
  readonly changes: number;
  /** Always empty: grouping raises no warnings or notes. */
  readonly diagnostics: readonly IDiagnostic[];
}

/**
 * The request breaks a grouping rule, such as a finding that is already in
 * another group or a group of fewer than two distinct changes. Nothing was
 * changed.
 *
 * @public
 */
export interface IRefusedSuggestionGroupOutcome {
  /** Discriminant: the request was refused. */
  readonly status: 'refused';
  /** Every rule the request breaks, each pointing at the finding concerned. */
  readonly problems: readonly IProblem[];
  /** The same explanation as Markdown. */
  readonly markdown: string;
  /** The same problems as diagnostics. */
  readonly diagnostics: readonly IDiagnostic[];
}

/**
 * Every outcome of {@link groupSarifFixes}, discriminated by `status`.
 *
 * @public
 */
export type GroupSarifFixesOutcome =
  | IGroupedSarifFixesOutcome
  | IRefusedSuggestionGroupOutcome
  | IStaleSarifSelectorOutcome
  | IInvalidSarifOutcome;

/**
 * A finding {@link ungroupSarifFixes} took out of its group.
 *
 * @public
 */
export interface IUngroupedFinding {
  /** JSON Pointer to the finding, such as `/runs/0/results/3`. */
  readonly ref: string;
  /** Index of its run. */
  readonly runIndex: number;
  /** Index of the finding in its run. */
  readonly resultIndex: number;
  /** The run's tool name. */
  readonly tool: string;
  /** The group it was in (its JSON text when the value written was not a string). */
  readonly group: string;
}

/**
 * The findings were taken out of their groups in a new copy of the document.
 *
 * @public
 */
export interface IUngroupedSarifFixesOutcome {
  /** Discriminant: the findings were ungrouped. */
  readonly status: 'ungrouped';
  /** The new document. Your input is unchanged; use this value from now on. */
  readonly sarif: ISarifLog;
  /** The findings, in document order. */
  readonly findings: readonly IUngroupedFinding[];
  /** Always empty: ungrouping raises no warnings or notes. */
  readonly diagnostics: readonly IDiagnostic[];
}

/**
 * Every outcome of {@link ungroupSarifFixes}, discriminated by `status`.
 *
 * @public
 */
export type UngroupSarifFixesOutcome =
  | IUngroupedSarifFixesOutcome
  | IRefusedSuggestionGroupOutcome
  | IStaleSarifSelectorOutcome
  | IInvalidSarifOutcome;

// ---------------------------------------------------------------------------
// Internal types

/** The public operation a misuse message names. */
type Operation = 'groupSarifFixes' | 'ungroupSarifFixes';

/**
 * A JSON object of the captured document. The capture is a fresh copy that
 * shares nothing with the caller's value, so this module may change it.
 */
interface IEditableObject {
  [key: string]: unknown;
}

/**
 * A run of a captured, schema-valid log, as far as this module reads it. The
 * schema requires every run's `tool.driver.name`, and a run's `results`,
 * when present, is an array of result objects.
 */
interface IGroupableRun {
  readonly tool: { readonly driver: { readonly name: string } };
  readonly results?: readonly unknown[];
}

/** A captured, schema-valid SARIF log (see {@link isValidatedLog}). */
interface IGroupableLog extends ISarifLog {
  readonly runs: IGroupableRun[];
}

/** A selected finding: where it is, its run's tool and its result object. */
interface ISelectedFinding {
  readonly ref: string;
  readonly runIndex: number;
  readonly resultIndex: number;
  readonly tool: string;
  readonly result: IEditableObject;
}

/** A result's owned namespace (`properties.sarifToComment`): absent, an object, or not an object. */
type OwnedNamespace =
  | { readonly state: 'absent' }
  | { readonly state: 'object'; readonly owned: IEditableObject }
  | { readonly state: 'invalid' };

/** The document with its runs, its digest, and the findings the selectors name. */
interface ISelection {
  readonly log: IGroupableLog;
  readonly digest: string;
  readonly findings: readonly ISelectedFinding[];
}

// ---------------------------------------------------------------------------
// Implementation

/** The owned property namespace on a result (D23). */
const OWNED_NAMESPACE = 'sarifToComment';

/** The owned key naming a result's suggestion group. */
const GROUP_KEY = 'suggestionGroup';

/** What each operation's refusal Markdown begins with. */
const HEADINGS: Readonly<Record<Operation, string>> = {
  groupSarifFixes: '**Cannot group the fixes:**',
  ungroupSarifFixes: '**Cannot ungroup the fixes:**',
};

function misuse(operation: Operation, message: string): TypeError {
  return new TypeError(`Invalid ${operation} input: ${message}`);
}

function isEditable(value: unknown): value is IEditableObject {
  return isPlainObject(value);
}

/**
 * Whether a captured document that validateSarif has just accepted has the
 * shape this module reads. It confirms the top level (an object with a `runs`
 * array) and relies on the SARIF 2.1.0 schema, which ajv has enforced, for
 * each run's `tool.driver.name` and each present `results` array.
 */
function isValidatedLog(captured: unknown): captured is IGroupableLog {
  return isPlainObject(captured) && Array.isArray(captured['runs']);
}

/**
 * Checks the options (captured, so no getter runs) and returns the parsed
 * selectors in the order given, and the group name for grouping. Throws a
 * TypeError naming the mistake.
 */
function checkOptions(options: unknown, operation: Operation): { readonly selectors: readonly IParsedSelector[]; readonly given: readonly string[]; readonly group?: string } {
  const captured: unknown = captureJson(options, 'options');
  if (!isPlainObject(captured)) throw misuse(operation, 'options must be an object');
  const allowed = operation === 'groupSarifFixes' ? ['findings', 'group'] : ['findings'];
  for (const key of Object.keys(captured)) {
    if (!allowed.includes(key)) throw misuse(operation, `options has unknown key ${JSON.stringify(key)}`);
  }
  const findings = captured['findings'];
  if (!Array.isArray(findings) || findings.length === 0) throw misuse(operation, 'options.findings must list at least one finding selector');
  const selectors: IParsedSelector[] = [];
  const given: string[] = [];
  for (const value of findings) {
    const parsed = parseFindingSelector(value);
    if (parsed === null || typeof value !== 'string') {
      throw misuse(operation, 'each of options.findings must be a finding selector such as "/runs/0/results/1@0123456789abcdef", '
        + 'copied from a finding\'s `selector` in inspectSarif (or `sarif-to-comment inspect`); a position alone does not select a finding');
    }
    if (given.includes(value)) throw misuse(operation, `options.findings names ${JSON.stringify(value)} twice; name each finding once`);
    selectors.push(parsed);
    given.push(value);
  }
  if (operation === 'ungroupSarifFixes') return { selectors, given };
  const group = captured['group'];
  if (!isSuggestionGroupName(group)) {
    throw misuse(operation, 'options.group must be 1-100 characters without control or invisible formatting characters or surrounding whitespace');
  }
  return { selectors, given, group };
}

/** A `stale` outcome for `selector`, pointing at the position it names. */
function staleSelector(operation: Operation, selector: string, ref: string, message: string): IStaleSarifSelectorOutcome {
  const problem = createProblem('finding-selector-stale', { message, pointer: ref });
  return { status: 'stale', selector, problems: [problem], markdown: `${HEADINGS[operation]} ${message}`, diagnostics: [diagnosticOf(problem)] };
}

/** A `refused` outcome listing every problem. */
function refusedOutcome(operation: Operation, problems: readonly IProblem[]): IRefusedSuggestionGroupOutcome {
  return {
    status: 'refused',
    problems,
    markdown: `${HEADINGS[operation]} nothing was changed.\n\n${problems.map((p) => `- ${p.message}`).join('\n')}`,
    diagnostics: problems.map(diagnosticOf),
  };
}

/**
 * Captures and validates the document, and locates every selected finding
 * in it. Returns the selection, or the `invalid` or `stale` outcome. Every
 * selector must carry the digest of the document as it is now, and name a
 * position that holds a finding; the first that does not is reported.
 */
function select(json: JsonValue, given: readonly string[], selectors: readonly IParsedSelector[], operation: Operation): ISelection | IStaleSarifSelectorOutcome | IInvalidSarifOutcome {
  const invalid = validateSarif(json);
  if (invalid) return invalid;
  if (!isValidatedLog(json)) throw new Error('Internal error: a schema-valid SARIF log has no runs array.');
  const digest = documentDigest(json);
  const selected: ISelectedFinding[] = [];
  for (const [i, parsed] of selectors.entries()) {
    const selector = given[i] ?? '';
    if (parsed.digest !== digest) {
      return staleSelector(operation, selector, parsed.ref, `The document has changed since the selector \`${selector}\` was taken from inspecting it, `
        + 'so it may no longer name the same finding. Nothing was changed. Inspect the document again and use its current selectors.');
    }
  }
  for (const [i, parsed] of selectors.entries()) {
    const selector = given[i] ?? '';
    const run = json.runs[parsed.runIndex];
    const result: unknown = run?.results?.[parsed.resultIndex];
    if (run === undefined || !isEditable(result)) {
      return staleSelector(operation, selector, parsed.ref, `This document has no finding at \`${parsed.ref}\`, so the selector \`${selector}\` did not come from `
        + 'inspecting it. Nothing was changed. Inspect the document again and use the selectors it shows.');
    }
    selected.push({ ref: parsed.ref, runIndex: parsed.runIndex, resultIndex: parsed.resultIndex, tool: run.tool.driver.name, result });
  }
  selected.sort((a, b) => a.runIndex - b.runIndex || a.resultIndex - b.resultIndex);
  return { log: json, digest, findings: selected };
}

/** A result's owned namespace. */
function ownedOf(result: IEditableObject): OwnedNamespace {
  const properties = result['properties'];
  if (properties === undefined) return { state: 'absent' };
  if (!isEditable(properties)) return { state: 'invalid' };
  const owned = properties[OWNED_NAMESPACE];
  if (owned === undefined) return { state: 'absent' };
  return isEditable(owned) ? { state: 'object', owned } : { state: 'invalid' };
}

/** A result's declared group value, if it declares one (whatever its type). */
function declaredGroup(result: unknown): { readonly value: unknown } | null {
  if (!isEditable(result)) return null;
  const owned = ownedOf(result);
  return owned.state === 'object' && Object.hasOwn(owned.owned, GROUP_KEY) ? { value: owned.owned[GROUP_KEY] } : null;
}

/** The array a member holds, or none. */
function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The identities of the changes a result contributes to a group: each
 * replacement of its primary fix and each proposed whole-file operation.
 * Equal identities are the same change. A location read through the run
 * (an artifact index or a base id) is qualified by the run, since another
 * run may read it differently; a whole-file operation always is (its
 * artifact index is its run's).
 */
function changeKeysOf(result: IEditableObject, runIndex: number): string[] {
  const keys: string[] = [];
  const [primary] = listOf(result['fixes']);
  if (isEditable(primary)) {
    for (const change of listOf(primary['artifactChanges'])) {
      if (!isEditable(change)) continue;
      const location = isEditable(change['artifactLocation']) ? change['artifactLocation'] : {};
      const scope = location['index'] !== undefined || location['uriBaseId'] !== undefined ? runIndex : null;
      for (const replacement of listOf(change['replacements'])) {
        keys.push(canonicalJson(captureJson(['edit', scope, location, replacement], 'a change')));
      }
    }
  }
  const owned = ownedOf(result);
  if (owned.state === 'object') {
    for (const operation of listOf(owned.owned['proposedFileChanges'])) {
      keys.push(canonicalJson(captureJson(['operation', runIndex, operation], 'a change')));
    }
  }
  return keys;
}

/** Every finding of the log with its position, in document order. */
function* findingsOf(log: IGroupableLog): Generator<{ readonly ref: string; readonly runIndex: number; readonly result: unknown }> {
  for (const [runIndex, run] of log.runs.entries()) {
    for (const [resultIndex, result] of (run.results ?? []).entries()) {
      yield { ref: `/runs/${String(runIndex)}/results/${String(resultIndex)}`, runIndex, result };
    }
  }
}

/** A list of findings' pointers as code spans, joined as the refusals word it. */
function refList(refs: readonly string[]): string {
  return refs.map((ref) => `\`${ref}\``).join(', ');
}

/** Why two groups (or a group and no group) cannot both carry one change, as the refusals end it. */
const SHARED_OUTSIDE = 'publication always refuses that, because one change cannot be accepted both in the group\'s suggestion pull request and on its own.';
const SHARED_BETWEEN_GROUPS = 'publication always refuses that, because one change cannot be accepted in two suggestion pull requests.';

/** The group name a declared value is reported by: the name, or its JSON text when it is not a string. */
function groupLabel(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The pointers of the findings in `members` (document order) that carry each
 * change: change identity to pointers.
 */
function carriers(log: IGroupableLog, members: (ref: string, result: unknown) => boolean): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const { ref, runIndex, result } of findingsOf(log)) {
    if (!isEditable(result) || !members(ref, result)) continue;
    for (const key of changeKeysOf(result, runIndex)) {
      const refs = byKey.get(key) ?? [];
      if (!refs.includes(ref)) refs.push(ref);
      byKey.set(key, refs);
    }
  }
  return byKey;
}

/** The pointers (document order, once each) of the carriers of every change of `result` that `byKey` holds. */
function sharing(result: IEditableObject, runIndex: number, byKey: ReadonlyMap<string, readonly string[]>): string[] {
  const refs = new Set<string>();
  for (const key of changeKeysOf(result, runIndex)) for (const ref of byKey.get(key) ?? []) refs.add(ref);
  return [...refs].sort(compareRefs);
}

/** Document order of two finding pointers of the form `/runs/R/results/N`. */
function compareRefs(a: string, b: string): number {
  const [ra = 0, na = 0] = a.split('/').filter((part) => /^\d+$/.test(part)).map(Number);
  const [rb = 0, nb = 0] = b.split('/').filter((part) => /^\d+$/.test(part)).map(Number);
  return ra - rb || na - nb;
}

/** "no change" or "only 1 distinct change": a count below two, as the refusals word it. */
function fewChanges(count: number): string {
  return count === 0 ? 'no change' : 'only 1 distinct change';
}

/**
 * Groups the fixes of several findings so that they are accepted together.
 *
 * @remarks
 * SARIF already applies the changes of one fix together; it cannot join
 * fixes of different findings, or an edit with a whole-file creation or
 * deletion. This operation declares such a group by giving each named
 * finding the same `properties.sarifToComment.suggestionGroup`. With
 * suggestion pull requests allowed, publication proposes the group as one
 * suggestion pull request; without them, it refuses the document, naming the
 * setting, and never splits the group.
 *
 * Take the selectors from {@link inspectSarif}. Only a finding's primary
 * (first) fix, or its proposed whole-file operation, is a member; further
 * fixes are alternatives and never grouped. A name already in use extends
 * that group, so one finding may be added to it; groups are never joined.
 * The request is refused, with nothing changed, when a finding is already in
 * another group or has no change, or when the group would hold fewer than
 * two distinct changes. The input is copied and never changed; after
 * grouping, inspect the new document for its selectors.
 *
 * @param sarif - A SARIF log as a parsed JSON object.
 * @param options - The findings and the group's name.
 * @returns `grouped` with the new document, `refused` if a rule is broken,
 * `stale` if a selector does not fit the document as it is now, or `invalid`
 * if the input is not schema-valid SARIF.
 * @throws `TypeError` for no findings, a selector that is not of
 * the form inspection gives, a finding named twice, an invalid group name,
 * unknown options, or non-JSON input.
 *
 * @example
 * ```ts
 * import { inspectSarif, groupSarifFixes } from 'sarif-to-comment';
 *
 * const inspected = inspectSarif(sarif);
 * if (inspected.status === 'inspected') {
 *   const findings = inspected.view.findings
 *     .filter((f) => f.fixes.length > 0 || f.fileProposals.length > 0)
 *     .map((f) => f.selector);
 *   const grouped = groupSarifFixes(sarif, { findings, group: 'retry-with-test' });
 *   if (grouped.status === 'grouped') sarif = grouped.sarif;
 * }
 * ```
 *
 * @public
 */
export function groupSarifFixes(sarif: object, options: IGroupSarifFixesOptions): GroupSarifFixesOutcome {
  return groupSarifFixesWithUntypedInput(sarif, options);
}

/**
 * Groups the selected findings in a copy of `sarif`
 * (docs/companion-suggestion-pr-contract.md §2.12). Order: capture the
 * document and options, check the options (TypeError), validate the schema
 * (`invalid`), check every selector (`stale`), check the rules (`refused`,
 * listing every problem), then write the group.
 *
 * Both arguments are validated at run time, since JavaScript callers can pass
 * anything; the CLI calls this directly with parsed file content.
 */
function groupSarifFixesWithUntypedInput(sarif: unknown, options: unknown): GroupSarifFixesOutcome {
  const operation = 'groupSarifFixes';
  if (sarif === null || typeof sarif !== 'object' || Array.isArray(sarif)) {
    throw misuse(operation, 'sarif must be a parsed SARIF object, not serialized text');
  }
  const json = captureJson(sarif, 'sarif');
  const { selectors, given, group } = checkOptions(options, operation);
  if (group === undefined) throw new Error('Internal error: grouping options have no group.');
  const selection = select(json, given, selectors, operation);
  if (!('findings' in selection)) return selection;

  const problems: IProblem[] = [];
  const keys = new Set<string>();
  const counts: number[] = [];
  const firstMember = selection.findings[0]?.ref;
  for (const member of selection.findings) {
    const owned = ownedOf(member.result);
    const existing = declaredGroup(member.result);
    if (owned.state === 'invalid') {
      problems.push(createProblem('owned-property-invalid', { message: `\`${member.ref}\` has a \`properties.sarifToComment\` that is not an object, so its group cannot be recorded.`, pointer: member.ref }));
    } else if (existing !== null && existing.value !== group) {
      problems.push(createProblem('finding-already-grouped', {
        message: `\`${member.ref}\` is already in suggestion group ${JSON.stringify(existing.value)}; a finding belongs to at most one group. Ungroup it first to move it.`,
        pointer: member.ref,
      }));
    }
    const own = changeKeysOf(member.result, member.runIndex);
    counts.push(own.length);
    if (own.length === 0) {
      problems.push(createProblem('suggestion-group-member-without-change', {
        message: `\`${member.ref}\` proposes no change: it has no fix and no proposed file operation, and a group joins changes. Leave it out of the group, or give it its change first.`,
        pointer: member.ref,
      }));
    }
    for (const key of own) keys.add(key);
  }
  // A name already in use extends that group: its other members' changes count too.
  const selectedRefs = new Set(selection.findings.map((f) => f.ref));
  let extended = false;
  for (const { ref, runIndex, result } of findingsOf(selection.log)) {
    if (declaredGroup(result)?.value !== group) continue;
    extended = true;
    if (selectedRefs.has(ref) || !isEditable(result)) continue;
    for (const key of changeKeysOf(result, runIndex)) keys.add(key);
  }
  if (keys.size < 2) {
    problems.push(createProblem('suggestion-group-single-change', {
      message: `The findings hold ${fewChanges(keys.size)}; a group needs at least two distinct changes to accept together (identical changes count once).`,
      pointer: firstMember,
    }));
  }
  // A change is carried by one group or by none (issue #42): every finding
  // left outside the group that carries one of its changes is named.
  const isMember = (ref: string, result: unknown): boolean => selectedRefs.has(ref) || declaredGroup(result)?.value === group;
  const memberCarriers = carriers(selection.log, isMember);
  for (const { ref, runIndex, result } of findingsOf(selection.log)) {
    if (!isEditable(result) || isMember(ref, result)) continue;
    const shared = sharing(result, runIndex, memberCarriers);
    if (shared.length === 0) continue;
    const lead = `\`${ref}\` carries the same change as ${refList(shared)} of suggestion group ${JSON.stringify(group)}`;
    const other = declaredGroup(result);
    problems.push(createProblem('suggestion-group-change-shared', {
      message: other === null
        ? `${lead}, but would stay outside the group; ${SHARED_OUTSIDE} Name it in the group too: \`${findingSelector(ref, selection.digest)}\`.`
        : `${lead}, but is in suggestion group ${JSON.stringify(groupLabel(other.value))}; ${SHARED_BETWEEN_GROUPS} `
          + `Groups are never joined: ungroup it from ${JSON.stringify(groupLabel(other.value))} first to include it.`,
      pointer: ref,
    }));
  }
  if (problems.length > 0) return refusedOutcome(operation, problems);

  for (const member of selection.findings) {
    const properties = isEditable(member.result['properties']) ? member.result['properties'] : {};
    const owned = isEditable(properties[OWNED_NAMESPACE]) ? properties[OWNED_NAMESPACE] : {};
    owned[GROUP_KEY] = group;
    properties[OWNED_NAMESPACE] = owned;
    member.result['properties'] = properties;
  }
  return {
    status: 'grouped',
    sarif: selection.log,
    group,
    extended,
    findings: selection.findings.map(({ ref, runIndex, resultIndex, tool }, i) => ({ ref, runIndex, resultIndex, tool, changes: counts[i] ?? 0 })),
    changes: keys.size,
    diagnostics: [],
  };
}

/**
 * Takes findings out of their suggestion groups.
 *
 * @remarks
 * Removes `properties.sarifToComment.suggestionGroup` from each named
 * finding; their fixes are then published independently again. An owned
 * namespace or property bag left empty is removed too, so ungrouping a whole
 * group restores the document as it was before grouping.
 *
 * Take the selectors from {@link inspectSarif}. The request is refused, with
 * nothing changed, when a finding is in no group, or when it would leave a
 * group with fewer than two distinct changes, which publication would always
 * refuse: to dissolve a group, name all of its findings (the refusal lists
 * the rest, with their current selectors). The input is copied and never
 * changed; afterwards, inspect the new document for its selectors.
 *
 * @param sarif - A SARIF log as a parsed JSON object.
 * @param options - The findings to ungroup.
 * @returns `ungrouped` with the new document, `refused` if a rule is broken,
 * `stale` if a selector does not fit the document as it is now, or `invalid`
 * if the input is not schema-valid SARIF.
 * @throws `TypeError` for no findings, a selector that is not of the form
 * inspection gives, a finding named twice, unknown options, or non-JSON
 * input.
 *
 * @public
 */
export function ungroupSarifFixes(sarif: object, options: IUngroupSarifFixesOptions): UngroupSarifFixesOutcome {
  return ungroupSarifFixesWithUntypedInput(sarif, options);
}

/**
 * Ungroups the selected findings in a copy of `sarif`, in the same order of
 * checks as grouping.
 */
function ungroupSarifFixesWithUntypedInput(sarif: unknown, options: unknown): UngroupSarifFixesOutcome {
  const operation = 'ungroupSarifFixes';
  if (sarif === null || typeof sarif !== 'object' || Array.isArray(sarif)) {
    throw misuse(operation, 'sarif must be a parsed SARIF object, not serialized text');
  }
  const json = captureJson(sarif, 'sarif');
  const { selectors, given } = checkOptions(options, operation);
  const selection = select(json, given, selectors, operation);
  if (!('findings' in selection)) return selection;

  const problems: IProblem[] = [];
  const groups: string[] = [];
  const affected = new Set<string>();
  for (const member of selection.findings) {
    const declared = declaredGroup(member.result);
    if (declared === null) {
      problems.push(createProblem('finding-not-grouped', { message: `\`${member.ref}\` is not in a suggestion group, so there is nothing to ungroup.`, pointer: member.ref }));
      groups.push('');
      continue;
    }
    const name = typeof declared.value === 'string' ? declared.value : JSON.stringify(declared.value);
    groups.push(name);
    if (typeof declared.value === 'string') affected.add(declared.value);
  }
  const selectedRefs = new Set(selection.findings.map((f) => f.ref));
  for (const name of affected) {
    const stays = (ref: string, result: unknown): boolean => !selectedRefs.has(ref) && declaredGroup(result)?.value === name;
    const rest = [...findingsOf(selection.log)].filter(({ ref, result }) => stays(ref, result));
    if (rest.length === 0) continue;
    const keys = new Set(rest.flatMap(({ result, runIndex }) => (isEditable(result) ? changeKeysOf(result, runIndex) : [])));
    if (keys.size < 2) {
      problems.push(createProblem('ungroup-leaves-single-change', {
        message: `Suggestion group ${JSON.stringify(name)} would keep ${fewChanges(keys.size)} (${rest.map(({ ref }) => `\`${ref}\``).join(', ')}), and a group needs at least two. `
          + `To dissolve the group, ungroup its other findings too: ${rest.map(({ ref }) => `\`${findingSelector(ref, selection.digest)}\``).join(', ')}.`,
        pointer: rest[0]?.ref,
      }));
    }
    // A change is carried by one group or by none (issue #42): a finding
    // leaving the group may not take a change a staying member carries.
    const stayingCarriers = carriers(selection.log, stays);
    for (const member of selection.findings) {
      if (declaredGroup(member.result)?.value !== name) continue;
      const shared = sharing(member.result, member.runIndex, stayingCarriers);
      if (shared.length === 0) continue;
      problems.push(createProblem('suggestion-group-change-shared', {
        message: `\`${member.ref}\` carries the same change as ${refList(shared)}, which ${shared.length === 1 ? 'stays' : 'stay'} in suggestion group ${JSON.stringify(name)}; ${SHARED_OUTSIDE} `
          + `Ungroup them together: ${shared.map((ref) => `\`${findingSelector(ref, selection.digest)}\``).join(', ')}.`,
        pointer: member.ref,
      }));
    }
  }
  if (problems.length > 0) return refusedOutcome(operation, problems);

  for (const member of selection.findings) {
    const properties = member.result['properties'];
    if (!isEditable(properties)) continue;
    const owned = properties[OWNED_NAMESPACE];
    if (!isEditable(owned)) continue;
    delete owned['suggestionGroup'];
    if (Object.keys(owned).length === 0) delete properties['sarifToComment'];
    if (Object.keys(properties).length === 0) delete member.result['properties'];
  }
  return {
    status: 'ungrouped',
    sarif: selection.log,
    findings: selection.findings.map(({ ref, runIndex, resultIndex, tool }, i) => ({ ref, runIndex, resultIndex, tool, group: groups[i] ?? '' })),
    diagnostics: [],
  };
}

export { groupSarifFixesWithUntypedInput, ungroupSarifFixesWithUntypedInput };
