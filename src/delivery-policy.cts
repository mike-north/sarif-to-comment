/**
 * The delivery policy (private internal module;
 * docs/delivery-policy-contract.md): which mechanism delivers each proposed
 * change or group of changes, as the caller, the repository configuration
 * and the defaults decide it (D48), keeping every group whole (D49, D51),
 * never substituting a mechanism the policy does not list (D55), and
 * packaging companion deliveries into bundles (D52).
 *
 * Pure: nothing here reads GitHub, the SARIF document or the file system.
 * Preparation decides whether each mechanism *can* deliver each unit (native
 * eligibility, companion obstacles, body limits) and describes the units
 * abstractly ({@link DeliveryUnit}); the transport reads the configuration's
 * bytes from the default branch. This module decides what the settings mean
 * and which mechanism each unit gets.
 *
 * Responsibilities, by contract section:
 *   - the fixed vocabularies, defaults and presets (§3, §5, §6);
 *   - resolving each dimension separately through the five layers, recording
 *     each value's source layer (§7, §13): {@link resolveDeliveryPolicy};
 *   - deciding whether the configuration must be read at all (§11.1):
 *     {@link deliveryConfigurationNeeded};
 *   - validating a caller's settings and the configuration file (§11, §12):
 *     {@link validateDeliveryPolicyLayer}, {@link validateDeliveryConfiguration},
 *     {@link readDeliveryConfiguration}, {@link deliveryConfigurationDiagnostics};
 *   - planning one destination per unit, the companion bundles and their
 *     limit, the blocked and fallback diagnostics, and the note for unused
 *     companion options (§8-§10, §12): {@link planDelivery};
 *   - naming the fallbacks that contributed to a block found after planning
 *     (§10.1): {@link nameFallbackCauses}.
 *
 * It does not present anything or persist anything; its diagnostics carry
 * the remedies the obstacles came with, ahead of the catalogued ones. How a
 * mechanism is rendered belongs to the presentation contracts.
 */

import { DIAGNOSTIC_CATALOG } from './diagnostic-catalog.cjs';
import { createDiagnostic, orderDiagnostics } from './diagnostics.cjs';
import type { ILocationInput } from './diagnostics.cjs';
import type { IDiagnostic } from './public-types.cjs';
import { MAX_CONFIGURATION_BYTES } from './suggestion-pr-convention.cjs';
import type { IDefaultBranchConfiguration } from './suggestion-pr-convention.cjs';

// ---------------------------------------------------------------------------
// Vocabularies, defaults and presets (§3, §5, §6)
// ---------------------------------------------------------------------------

/**
 * Each delivery dimension's fixed vocabulary, in the contract's order (§3).
 * No other value is valid for the dimension, in any layer.
 */
export const DELIVERY_MECHANISMS = Object.freeze({
  /** An ungrouped change to an existing file. */
  edits: Object.freeze(['native', 'review-body', 'companion'] as const),
  /** A group all of whose members are edits (an explicit group, or a fix with several changes). */
  groupedEdits: Object.freeze(['native-batch', 'companion', 'manual-group'] as const),
  /** An ungrouped whole-file creation or deletion, and any group containing one (D50, D51). */
  fileOperations: Object.freeze(['manual', 'companion'] as const),
});

/** How companion-delivered units are packaged (§3, §9): not a delivery dimension, and never a list. */
export const COMPANION_BUNDLES = Object.freeze(['per-unit', 'single'] as const);

/** The named presets (§6). */
export const DELIVERY_PRESETS = Object.freeze(['original-pr', 'companion'] as const);

/** A delivery dimension: the kind of proposal a list governs. */
export type DeliveryDimension = keyof typeof DELIVERY_MECHANISMS;
/** A mechanism that can deliver an ungrouped edit. */
export type EditMechanism = (typeof DELIVERY_MECHANISMS.edits)[number];
/** A mechanism that can deliver an edit group. */
export type GroupedEditMechanism = (typeof DELIVERY_MECHANISMS.groupedEdits)[number];
/** A mechanism that can deliver a whole-file operation or a group containing one. */
export type FileOperationMechanism = (typeof DELIVERY_MECHANISMS.fileOperations)[number];
/** How companion-delivered units are packaged. */
export type CompanionBundle = (typeof COMPANION_BUNDLES)[number];
/** A preset's name. */
export type DeliveryPreset = (typeof DELIVERY_PRESETS)[number];

/**
 * The settings one layer can give, apart from a preset. A list is ordered:
 * the caller authorizing fallback in that order (§4).
 */
export interface IDeliverySettings {
  readonly edits?: readonly EditMechanism[];
  readonly groupedEdits?: readonly GroupedEditMechanism[];
  readonly fileOperations?: readonly FileOperationMechanism[];
  readonly companionBundle?: CompanionBundle;
}

/**
 * What one layer says: the caller's settings (CLI flags or the library's
 * `delivery` option), or the configuration file's `delivery` object. A
 * specific setting outranks the layer's own preset (§7).
 */
export interface IDeliveryPolicyLayer extends IDeliverySettings {
  readonly preset?: DeliveryPreset;
}

/**
 * The defaults (§5). They never name a companion, so a default publication
 * creates none, and `edits` is strictly native, so an edit that cannot be a
 * native suggestion is refused as it always was.
 */
export const DEFAULT_DELIVERY_POLICY = Object.freeze({
  edits: Object.freeze(['native'] as const),
  // The owner may replace this default at release review (contract §15, item 1).
  groupedEdits: Object.freeze(['native-batch'] as const),
  fileOperations: Object.freeze(['manual'] as const),
  companionBundle: 'per-unit',
} satisfies Required<IDeliverySettings>);

/**
 * What each preset expands to (§6). A preset sets only the dimensions it
 * names; the others are decided by lower layers.
 */
export const DELIVERY_PRESET_SETTINGS: Readonly<Record<DeliveryPreset, IDeliverySettings>> = Object.freeze({
  // Everything on the original pull request; never a companion (D48's all-native mode, D51's no-companion workflow).
  'original-pr': Object.freeze({
    edits: Object.freeze(['native', 'review-body'] as const),
    groupedEdits: Object.freeze(['native-batch', 'manual-group'] as const),
    fileOperations: Object.freeze(['manual'] as const),
  }),
  // Every proposed change in companions, strictly (D48's all-companion mode, D55).
  // companionBundle is left to lower layers; the limit's error names `single` (§9).
  companion: Object.freeze({
    edits: Object.freeze(['companion'] as const),
    groupedEdits: Object.freeze(['companion'] as const),
    fileOperations: Object.freeze(['companion'] as const),
  }),
});

/** Where the configuration file lives on the default branch (§11.1). */
export const DELIVERY_CONFIGURATION_PATH = '.github/sarif-to-comment.json';

// ---------------------------------------------------------------------------
// Resolution (§7, §13)
// ---------------------------------------------------------------------------

/** A layer a resolved value can come from, highest rank first (§7). */
export type DeliveryPolicySource = 'caller' | 'caller-preset' | 'configuration' | 'configuration-preset' | 'default';

/**
 * One resolved setting and where it came from. A preset layer also names the
 * preset. This is also the recorded form (§13).
 */
export type ResolvedDeliverySetting<V> =
  | { readonly value: V; readonly source: 'caller' | 'configuration' | 'default' }
  | { readonly value: V; readonly source: 'caller-preset' | 'configuration-preset'; readonly preset: DeliveryPreset };

/**
 * The policy a publication follows: every dimension and the bundle setting,
 * each with its source, in the recorded order of §13. It is JSON as it
 * stands, so it can be persisted with the publication's plan.
 */
export interface IResolvedDeliveryPolicy {
  readonly edits: ResolvedDeliverySetting<readonly EditMechanism[]>;
  readonly groupedEdits: ResolvedDeliverySetting<readonly GroupedEditMechanism[]>;
  readonly fileOperations: ResolvedDeliverySetting<readonly FileOperationMechanism[]>;
  readonly companionBundle: ResolvedDeliverySetting<CompanionBundle>;
}

/** The validated layers a policy is resolved from; an absent layer sets nothing. */
export interface IDeliveryPolicyInputs {
  readonly caller?: IDeliveryPolicyLayer | undefined;
  readonly configuration?: IDeliveryPolicyLayer | undefined;
}

/**
 * One setting, from the first of the five layers that sets it (§7). `copy`
 * detaches a list from the caller's input, so later changes to it never
 * change a resolved policy.
 */
function resolveSetting<V>(
  inputs: IDeliveryPolicyInputs,
  read: (settings: IDeliverySettings) => V | undefined,
  fallback: V,
  copy: (value: V) => V,
): ResolvedDeliverySetting<V> {
  const { caller, configuration } = inputs;
  const callerValue = caller === undefined ? undefined : read(caller);
  if (callerValue !== undefined) return { value: copy(callerValue), source: 'caller' };
  if (caller?.preset !== undefined) {
    const presetValue = read(DELIVERY_PRESET_SETTINGS[caller.preset]);
    if (presetValue !== undefined) return { value: copy(presetValue), source: 'caller-preset', preset: caller.preset };
  }
  const configured = configuration === undefined ? undefined : read(configuration);
  if (configured !== undefined) return { value: copy(configured), source: 'configuration' };
  if (configuration?.preset !== undefined) {
    const presetValue = read(DELIVERY_PRESET_SETTINGS[configuration.preset]);
    if (presetValue !== undefined) return { value: copy(presetValue), source: 'configuration-preset', preset: configuration.preset };
  }
  return { value: copy(fallback), source: 'default' };
}

/** A frozen copy of a list. */
function frozenList<T>(list: readonly T[]): readonly T[] {
  return Object.freeze([...list]);
}

/** A value that needs no copy. */
function same<T>(value: T): T {
  return value;
}

/**
 * The policy from the validated caller and configuration layers: each
 * dimension, and `companionBundle`, resolved separately (§7). A winning list
 * is taken whole and never merged with a lower layer's.
 */
export function resolveDeliveryPolicy(inputs: IDeliveryPolicyInputs): IResolvedDeliveryPolicy {
  return {
    edits: resolveSetting(inputs, (s) => s.edits, DEFAULT_DELIVERY_POLICY.edits, frozenList),
    groupedEdits: resolveSetting(inputs, (s) => s.groupedEdits, DEFAULT_DELIVERY_POLICY.groupedEdits, frozenList),
    fileOperations: resolveSetting(inputs, (s) => s.fileOperations, DEFAULT_DELIVERY_POLICY.fileOperations, frozenList),
    companionBundle: resolveSetting<CompanionBundle>(inputs, (s) => s.companionBundle, DEFAULT_DELIVERY_POLICY.companionBundle, same),
  };
}

/**
 * Why `value` is not a resolved policy in its recorded form (§13), or null:
 * exactly the four settings in their order, each `{ value, source }` with a
 * list or value from its vocabulary (a list non-empty and without repeats),
 * a known source, and `preset` exactly when the source is a preset layer.
 * Publication state and companion plans are checked with it when they are
 * read back, so a corrupt record is refused rather than trusted.
 */
export function deliveryRecordProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'the delivery policy is not an object';
  const names = Object.keys(value);
  const expected = ['edits', 'groupedEdits', 'fileOperations', 'companionBundle'];
  if (names.length !== expected.length || names.some((name, i) => name !== expected[i])) return 'the delivery policy does not hold exactly its four settings, in order';
  for (const name of expected) {
    const setting = value[name];
    if (!isPlainObject(setting)) return `the delivery policy's ${name} is not an object`;
    const source = setting['source'];
    const presetSource = source === 'caller-preset' || source === 'configuration-preset';
    const keys = Object.keys(setting).sort().join(',');
    if (keys !== (presetSource ? 'preset,source,value' : 'source,value')) return `the delivery policy's ${name} does not hold exactly its fields`;
    if (!presetSource && source !== 'caller' && source !== 'configuration' && source !== 'default') return `the delivery policy's ${name} has an unknown source`;
    if (presetSource && !isOneOf(setting['preset'], DELIVERY_PRESETS)) return `the delivery policy's ${name} names an unknown preset`;
    const recorded = setting['value'];
    if (name === 'companionBundle') {
      if (!isOneOf(recorded, COMPANION_BUNDLES)) return 'the delivery policy\'s companionBundle is not a bundle setting';
      continue;
    }
    const vocabulary: readonly string[] = DELIVERY_MECHANISMS[name === 'edits' ? 'edits' : name === 'groupedEdits' ? 'groupedEdits' : 'fileOperations'];
    const problems: IDeliveryPolicyProblem[] = [];
    if (validateList(recorded, `/${name}`, vocabulary, problems) === undefined) return `the delivery policy's ${name} is not a list of its mechanisms`;
  }
  return null;
}

/** Whether `value` is a resolved policy in its recorded form (see {@link deliveryRecordProblem}). */
export function isResolvedDeliveryPolicy(value: unknown): value is IResolvedDeliveryPolicy {
  return deliveryRecordProblem(value) === null;
}

/**
 * Whether the configuration file must be read (§11.1): true unless the
 * caller's specific settings and preset together decide `edits`,
 * `groupedEdits`, `fileOperations` and `companionBundle`, in which case no
 * configuration value could win (§7) and the file is not read at all.
 */
export function deliveryConfigurationNeeded(caller: IDeliveryPolicyLayer | undefined): boolean {
  if (caller === undefined) return true;
  const preset: IDeliverySettings = caller.preset === undefined ? {} : DELIVERY_PRESET_SETTINGS[caller.preset];
  const decides = (read: (settings: IDeliverySettings) => unknown): boolean => read(caller) !== undefined || read(preset) !== undefined;
  return !(decides((s) => s.edits) && decides((s) => s.groupedEdits) && decides((s) => s.fileOperations) && decides((s) => s.companionBundle));
}

// ---------------------------------------------------------------------------
// Validation (§11.3, §11.4, §12)
// ---------------------------------------------------------------------------

/**
 * One problem with a caller layer or a configuration file. `pointer` is a
 * JSON Pointer to the member (from the `delivery` option for a caller layer,
 * from the file's root for a configuration), or `''` for the value as a
 * whole; `detail` is the contract's clause for the problem (§11.4).
 */
export interface IDeliveryPolicyProblem {
  readonly pointer: string;
  readonly detail: string;
}

/** A validated layer, or every problem found in it. */
export type DeliveryLayerValidation =
  | { readonly status: 'valid'; readonly layer: IDeliveryPolicyLayer }
  | { readonly status: 'invalid'; readonly problems: readonly IDeliveryPolicyProblem[] };

/**
 * Whether a value is a plain object keyed by strings: not null, not an array,
 * not a class instance or wrapped primitive, and without symbol keys. A
 * parsed JSON object always is one; a caller's settings must be one, so
 * nothing they hold is silently skipped.
 */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0;
}

/** Whether a value is an array, typed without `any`. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Whether `value` is one of `vocabulary`. */
function isOneOf<T extends string>(value: unknown, vocabulary: readonly T[]): value is T {
  return vocabulary.some((entry) => entry === value);
}

/** The clause for a value outside `vocabulary`. */
function notOneOf(vocabulary: readonly string[]): string {
  return `is not one of ${vocabulary.map((entry) => `\`${entry}\``).join(', ')}`;
}

/**
 * Characters a member name shows as `\uXXXX`: the controls and invisible
 * formatting characters a label name may not hold (the suggestion pull
 * request convention §3).
 */
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\uFEFF\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/g;

/** One member name as a JSON Pointer segment, with invisible characters made visible (§11.4). */
function pointerSegment(name: string): string {
  return name
    .replace(/~/g, '~0')
    .replace(/\//g, '~1')
    .replace(INVISIBLE, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

/**
 * A list of `vocabulary`, or undefined after recording its problems: not an
 * array, empty, an entry outside the vocabulary, or a repeated mechanism.
 */
function validateList<T extends string>(
  value: unknown,
  pointer: string,
  vocabulary: readonly T[],
  problems: IDeliveryPolicyProblem[],
): readonly T[] | undefined {
  if (!isUnknownArray(value)) {
    problems.push({ pointer, detail: 'must be a list of mechanisms' });
    return undefined;
  }
  if (value.length === 0) {
    problems.push({ pointer, detail: 'must list at least one mechanism' });
    return undefined;
  }
  const listed: T[] = [];
  const before = problems.length;
  for (const [index, entry] of value.entries()) {
    const at = `${pointer}/${String(index)}`;
    if (!isOneOf(entry, vocabulary)) problems.push({ pointer: at, detail: notOneOf(vocabulary) });
    else if (listed.includes(entry)) problems.push({ pointer: at, detail: `repeats \`${entry}\`` });
    else listed.push(entry);
  }
  return problems.length === before ? listed : undefined;
}

/** The mutable form of a layer while it is validated. */
type LayerDraft = { -readonly [K in keyof IDeliveryPolicyLayer]: IDeliveryPolicyLayer[K] };

/**
 * A layer object at `base` (a JSON Pointer prefix): every member checked in
 * order, every problem recorded. `notObject` is the clause when the value is
 * not an object at all.
 */
function validateLayerAt(value: unknown, base: string, notObject: string): DeliveryLayerValidation {
  if (!isPlainObject(value)) return { status: 'invalid', problems: [{ pointer: base, detail: notObject }] };
  const problems: IDeliveryPolicyProblem[] = [];
  const layer: LayerDraft = {};
  for (const name of Object.keys(value)) {
    const pointer = `${base}/${pointerSegment(name)}`;
    const member = value[name];
    switch (name) {
      case 'preset':
        if (isOneOf(member, DELIVERY_PRESETS)) layer.preset = member;
        else problems.push({ pointer, detail: notOneOf(DELIVERY_PRESETS) });
        break;
      case 'companionBundle':
        if (isOneOf(member, COMPANION_BUNDLES)) layer.companionBundle = member;
        else problems.push({ pointer, detail: notOneOf(COMPANION_BUNDLES) });
        break;
      case 'edits': {
        const list = validateList(member, pointer, DELIVERY_MECHANISMS.edits, problems);
        if (list !== undefined) layer.edits = list;
        break;
      }
      case 'groupedEdits': {
        const list = validateList(member, pointer, DELIVERY_MECHANISMS.groupedEdits, problems);
        if (list !== undefined) layer.groupedEdits = list;
        break;
      }
      case 'fileOperations': {
        const list = validateList(member, pointer, DELIVERY_MECHANISMS.fileOperations, problems);
        if (list !== undefined) layer.fileOperations = list;
        break;
      }
      default:
        problems.push({ pointer, detail: 'is not a known setting' });
    }
  }
  return problems.length === 0 ? { status: 'valid', layer } : { status: 'invalid', problems };
}

/**
 * A caller's delivery settings (the library's `delivery` option, or what the
 * command line built from its flags), validated by §11.4's rules (§12).
 * Pointers are relative to the `delivery` object. Turning problems into a
 * `TypeError` or a usage error is the caller surface's business.
 */
export function validateDeliveryPolicyLayer(value: unknown): DeliveryLayerValidation {
  return validateLayerAt(value, '', 'must be an object');
}

/**
 * A parsed configuration file (§11.3, §11.4): its `delivery` object as a
 * layer, or every problem. A `$schema` string is allowed and ignored; any
 * other unknown member is a problem. A file with any problem yields no layer.
 */
export function validateDeliveryConfiguration(parsed: unknown): DeliveryLayerValidation {
  if (!isPlainObject(parsed)) return { status: 'invalid', problems: [{ pointer: '', detail: 'it is not a JSON object' }] };
  const problems: IDeliveryPolicyProblem[] = [];
  let layer: IDeliveryPolicyLayer = {};
  for (const name of Object.keys(parsed)) {
    const pointer = `/${pointerSegment(name)}`;
    switch (name) {
      case '$schema':
        if (typeof parsed[name] !== 'string') problems.push({ pointer, detail: 'must be a string' });
        break;
      case 'delivery': {
        const delivery = validateLayerAt(parsed[name], pointer, 'must be an object');
        if (delivery.status === 'valid') layer = delivery.layer;
        else problems.push(...delivery.problems);
        break;
      }
      default:
        problems.push({ pointer, detail: 'is not a known setting' });
    }
  }
  return problems.length === 0 ? { status: 'valid', layer } : { status: 'invalid', problems };
}

/** What the default branch's configuration file means (§11.4). A failed read never reaches this module. */
export type DeliveryConfigurationRead =
  | { readonly status: 'absent'; readonly branch: string }
  | { readonly status: 'valid'; readonly branch: string; readonly layer: IDeliveryPolicyLayer }
  | { readonly status: 'invalid'; readonly branch: string; readonly problems: readonly IDeliveryPolicyProblem[] };

/**
 * The configuration layer from what the transport read at
 * {@link DELIVERY_CONFIGURATION_PATH} on the default branch, by exactly the
 * table of §11.4: absent sets nothing; anything other than a valid UTF-8 JSON
 * object of known members is invalid, with every problem.
 */
export function readDeliveryConfiguration(configuration: IDefaultBranchConfiguration): DeliveryConfigurationRead {
  const { branch, content } = configuration;
  const whole = (detail: string): DeliveryConfigurationRead => ({ status: 'invalid', branch, problems: [{ pointer: '', detail }] });
  switch (content.kind) {
    case 'absent':
      return { status: 'absent', branch };
    case 'not-a-file':
      return whole(
        content.path === DELIVERY_CONFIGURATION_PATH
          ? `it is ${content.entry}, not a file`
          : `${codeSpan(content.path)} is ${content.entry}, which is never followed`,
      );
    case 'too-large':
      return whole(`it is larger than ${String(MAX_CONFIGURATION_BYTES)} bytes`);
    case 'file':
      break;
  }
  if (content.bytes.length > MAX_CONFIGURATION_BYTES) return whole(`it is larger than ${String(MAX_CONFIGURATION_BYTES)} bytes`);
  let text: string;
  try {
    // A leading byte-order mark is allowed and not part of the JSON: the decoder drops it.
    text = new TextDecoder('utf-8', { fatal: true }).decode(content.bytes);
  } catch {
    return whole('it is not UTF-8 text');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return whole('it is not valid JSON');
  }
  const validation = validateDeliveryConfiguration(parsed);
  return validation.status === 'valid'
    ? { status: 'valid', branch, layer: validation.layer }
    : { status: 'invalid', branch, problems: validation.problems };
}

/**
 * One `delivery-configuration-invalid` diagnostic per problem, with the
 * exact message of §11.4. Together they block the publication before any
 * write.
 */
export function deliveryConfigurationDiagnostics(invalid: { readonly branch: string; readonly problems: readonly IDeliveryPolicyProblem[] }): IDiagnostic[] {
  return invalid.problems.map((problem) => {
    const clause = problem.pointer === '' ? problem.detail : `${codeSpan(problem.pointer)} ${problem.detail}`;
    return createDiagnostic(
      'delivery-configuration-invalid',
      `${codeSpan(DELIVERY_CONFIGURATION_PATH)} on the default branch ${codeSpan(invalid.branch)} cannot be used: ${clause}.`,
    );
  });
}

// ---------------------------------------------------------------------------
// Planning (§8, §9, §10)
// ---------------------------------------------------------------------------

/**
 * Whether one mechanism can deliver one unit, as preparation decided it
 * (§8.7). An unavailable mechanism always says why: each obstacle is one
 * Markdown sentence. Obstacles that the author can remove come with what
 * to do about them (§8.9): `remedies`, each one sentence, in the order of
 * the obstacles they relate to. The planner puts them ahead of the
 * diagnostic's catalogued remedies (§10.1, §10.2).
 */
export type MechanismAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly obstacles: readonly [string, ...string[]]; readonly remedies?: readonly string[] | undefined };

/** What every delivery unit carries, whatever its kind. */
interface IDeliveryUnitBase {
  /** Distinct within one plan; the plan refers to the unit by it. */
  readonly id: string;
  /** How a diagnostic names the unit: Markdown, starting with a capital ("The creation of `a.md`", "The group `retry`"). */
  readonly description: string;
  /** Where the unit's finding is, for its diagnostics. */
  readonly location?: ILocationInput | undefined;
}

/**
 * Whether each mechanism can deliver one unit, answered on request (§8.7).
 * The planner asks only for mechanisms its resolved list names, in list
 * order, at most once each, and never after the first available one, so
 * preparation never works out obstacles nobody needs.
 */
export type AvailabilityOf<M extends string> = (mechanism: M) => MechanismAvailability;

/** An ungrouped change to an existing file (§2), governed by `edits`. */
export interface IEditUnit extends IDeliveryUnitBase {
  readonly kind: 'edit';
  readonly availability: AvailabilityOf<EditMechanism>;
}

/** One member of an edit group: whether it alone could be a native suggestion (§8.3). */
export interface IEditGroupMember {
  /** How an obstacle names the member: Markdown ("The edit of `b.md` line 9"). */
  readonly description: string;
  /** Asked only when the group's `native-batch` is asked for (§8.7). */
  readonly native: () => MechanismAvailability;
}

/**
 * An edit group (§2), governed by `groupedEdits`. Its `native-batch`
 * availability holds only obstacles of the group as a whole; the members'
 * own eligibility is added to it (§8.3).
 */
export interface IEditGroupUnit extends IDeliveryUnitBase {
  readonly kind: 'edit-group';
  readonly members: readonly IEditGroupMember[];
  readonly availability: AvailabilityOf<GroupedEditMechanism>;
}

/** An ungrouped whole-file creation or deletion (§2, D50), governed by `fileOperations`. */
export interface IFileOperationUnit extends IDeliveryUnitBase {
  readonly kind: 'file-operation';
  readonly availability: AvailabilityOf<FileOperationMechanism>;
}

/**
 * A group containing a whole-file operation (§2), governed by
 * `fileOperations` as a whole (D51). Any group, explicit or a fix with
 * several changes, that has at least one whole-file creation or deletion
 * among its members is classified as this kind, whatever its edits'
 * eligibility for native suggestions; it is never an edit group.
 */
export interface IFileOperationGroupUnit extends IDeliveryUnitBase {
  readonly kind: 'file-operation-group';
  readonly availability: AvailabilityOf<FileOperationMechanism>;
}

/**
 * A further fix of a result (§2, §8.6). Not delivered by any mechanism: it
 * is listed with its finding, and never bundled, grouped or committed (D53).
 */
export interface IAlternativeUnit extends IDeliveryUnitBase {
  readonly kind: 'alternative';
}

/** Everything a plan routes, described independently of how preparation found it. */
export type DeliveryUnit = IEditUnit | IEditGroupUnit | IFileOperationUnit | IFileOperationGroupUnit | IAlternativeUnit;

/** One unit's destination: the dimension that governed it and the mechanism chosen. */
export type UnitDelivery =
  | { readonly unitId: string; readonly kind: 'edit'; readonly dimension: 'edits'; readonly mechanism: EditMechanism }
  | { readonly unitId: string; readonly kind: 'edit-group'; readonly dimension: 'groupedEdits'; readonly mechanism: GroupedEditMechanism }
  | {
      readonly unitId: string;
      readonly kind: 'file-operation' | 'file-operation-group';
      readonly dimension: 'fileOperations';
      readonly mechanism: FileOperationMechanism;
    };

/**
 * A unit delivered by a mechanism that is not the first of its list (§10.2),
 * kept so that a block found after planning can name the fallback that
 * contributed to it (§10.1, {@link nameFallbackCauses}).
 */
export interface IFallbackDelivery {
  readonly unitId: string;
  readonly mechanism: UnitDelivery['mechanism'];
  /** The paragraph a blocking error ends with: "This includes a proposal delivered by a fallback: …". */
  readonly cause: string;
}

/** One companion pull request: the units it holds, each its own section, in order (§9). */
export interface ICompanionPlan {
  readonly sections: readonly string[];
}

/**
 * The plan for a review: every unit's destination, the companion pull
 * requests and the announced fallbacks; or, when any unit has no available
 * listed mechanism, a block naming every such unit (D55). Diagnostics are
 * ordered errors, then warnings.
 */
export type DeliveryPlan =
  | {
      readonly status: 'planned';
      readonly policy: IResolvedDeliveryPolicy;
      /** One per delivered unit, in input order. */
      readonly deliveries: readonly UnitDelivery[];
      readonly companions: readonly ICompanionPlan[];
      /** The alternatives, listed with their findings and delivered by nothing. */
      readonly alternatives: readonly string[];
      /** The `delivery-fallback` warnings, then any `companion-options-unused` note. */
      readonly diagnostics: readonly IDiagnostic[];
      /** The units delivered by a fallback, in input order, one per `delivery-fallback` warning. */
      readonly fallbacks: readonly IFallbackDelivery[];
    }
  | {
      readonly status: 'blocked';
      readonly policy: IResolvedDeliveryPolicy;
      /** The units no listed mechanism can deliver, in input order; empty when only the companion limit blocks. */
      readonly blocked: readonly string[];
      /**
       * A `delivery-unavailable` error per blocked unit, then a
       * `too-many-suggestion-prs` error when the companion limit is
       * exceeded. Never a `delivery-fallback` warning: a blocked plan
       * delivers nothing, so no unit "is delivered as" anything (§10.1, D55).
       */
      readonly diagnostics: readonly IDiagnostic[];
    };

/** The flag that sets each dimension (§10.1's source table). */
const FLAG: Readonly<Record<DeliveryDimension, string>> = {
  edits: '--edits',
  groupedEdits: '--grouped-edits',
  fileOperations: '--file-operations',
};

/** How a message names where a list came from (§10.1). */
function sourcePhrase(dimension: DeliveryDimension, setting: ResolvedDeliverySetting<unknown>): string {
  switch (setting.source) {
    case 'caller':
      return `set by the caller (\`${FLAG[dimension]}\`, \`delivery.${dimension}\`)`;
    case 'caller-preset':
      return `set by the caller's preset \`${setting.preset}\` (\`--delivery\`, \`delivery.preset\`)`;
    case 'configuration':
      return `set by \`${DELIVERY_CONFIGURATION_PATH}\` on the default branch (\`delivery.${dimension}\`)`;
    case 'configuration-preset':
      return `set by the preset \`${setting.preset}\` in \`${DELIVERY_CONFIGURATION_PATH}\` on the default branch`;
    case 'default':
      return 'the default';
  }
}

/** Why a mechanism cannot deliver a unit: its obstacle sentences and their remedies, both in obstacle order. */
interface IObstacles {
  readonly obstacles: readonly string[];
  readonly remedies: readonly string[];
}

/** No obstacle: the mechanism is available. */
const NO_OBSTACLES: IObstacles = { obstacles: [], remedies: [] };

/** A mechanism that could not deliver a unit, with why. */
interface IObstructed<M extends string> extends IObstacles {
  readonly mechanism: M;
}

/** The obstacles of one availability, none when it is available. */
function obstaclesOf(availability: MechanismAvailability): IObstacles {
  if (availability.available) return NO_OBSTACLES;
  // The type requires an obstacle; a JavaScript caller could still omit it, and §8.7 never reports no reason.
  if (availability.obstacles.length === 0) throw new TypeError('An unavailable delivery mechanism must name at least one obstacle.');
  return { obstacles: availability.obstacles, remedies: availability.remedies ?? [] };
}

/**
 * The first mechanism of `list` with no obstacles, and the mechanisms before
 * it with theirs; or every mechanism with its obstacles when none is free.
 */
function firstAvailable<M extends string>(
  list: readonly M[],
  obstacles: (mechanism: M) => IObstacles,
): { readonly mechanism: M | undefined; readonly obstructed: readonly IObstructed<M>[] } {
  const obstructed: IObstructed<M>[] = [];
  for (const mechanism of list) {
    const found = obstacles(mechanism);
    if (found.obstacles.length === 0) return { mechanism, obstructed };
    obstructed.push({ mechanism, ...found });
  }
  return { mechanism: undefined, obstructed };
}

/**
 * An edit group's obstacles for `native-batch`: the group's own, then each
 * ineligible member named with its obstacles, with their remedies in the
 * same order. Any member's obstacle makes the whole batch unavailable
 * (§8.3).
 */
function nativeBatchObstacles(unit: IEditGroupUnit): IObstacles {
  const group = obstaclesOf(unit.availability('native-batch'));
  const members = unit.members.map((member) => ({ member, found: obstaclesOf(member.native()) }))
    .filter(({ found }) => found.obstacles.length > 0);
  return {
    obstacles: [...group.obstacles, ...members.map(({ member, found }) => `${member.description}: ${found.obstacles.join(' ')}`)],
    remedies: [...group.remedies, ...members.flatMap(({ found }) => found.remedies)],
  };
}

/**
 * A diagnostic's remedies (§10.1, §10.2): the obstructed mechanisms'
 * remedies in obstacle order, each once, then the code's catalogued
 * remedies.
 */
function remediesFor(code: 'delivery-unavailable' | 'delivery-fallback', obstructed: readonly IObstructed<string>[]): readonly string[] {
  return [...new Set([...obstructed.flatMap((o) => o.remedies), ...DIAGNOSTIC_CATALOG[code].remedies])];
}

/** The `- \`mechanism\`: obstacles` lines of a message (§10.1, §10.2). */
function obstacleLines(obstructed: readonly IObstructed<string>[]): string {
  return obstructed.map((o) => `- \`${o.mechanism}\`: ${o.obstacles.join(' ')}`).join('\n');
}

/** The list as one code span: `` `[a, b]` `` (§10.1). */
function listSpan(list: readonly string[]): string {
  return `\`[${list.join(', ')}]\``;
}

/** The routing of one non-alternative unit: its delivery, or that it is blocked, and its diagnostic if any. */
type Routing =
  | { readonly delivery: UnitDelivery; readonly fallback: { readonly warning: IDiagnostic; readonly cause: string } | undefined }
  | { readonly blocked: IDiagnostic };

/** `text` with its first letter in lower case, as a unit's description reads mid-sentence (§10.1). */
function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/**
 * Routes one unit by `setting`'s list (§8.1): the first available mechanism,
 * announced when it is not the first (§10.2), or blocked when none is
 * (§10.1).
 */
function route<M extends string>(
  unit: Exclude<DeliveryUnit, IAlternativeUnit>,
  dimension: DeliveryDimension,
  setting: ResolvedDeliverySetting<readonly M[]>,
  obstacles: (mechanism: M) => IObstacles,
  deliver: (mechanism: M) => UnitDelivery,
): Routing {
  const list = setting.value;
  const { mechanism, obstructed } = firstAvailable(list, obstacles);
  const listed = `\`${dimension}\` is ${listSpan(list)}, ${sourcePhrase(dimension, setting)}`;
  if (mechanism === undefined) {
    return {
      blocked: createDiagnostic(
        'delivery-unavailable',
        `${unit.description} cannot be delivered. ${listed}, and no mechanism it lists is available:\n\n${obstacleLines(obstructed)}`,
        { location: unit.location, remedies: remediesFor('delivery-unavailable', obstructed) },
      ),
    };
  }
  if (obstructed.length === 0) return { delivery: deliver(mechanism), fallback: undefined };
  const warning = createDiagnostic(
    'delivery-fallback',
    `${unit.description} is delivered as \`${mechanism}\`. ${listed}, and the mechanisms listed before it are unavailable:\n\n${obstacleLines(obstructed)}`,
    { location: unit.location, remedies: remediesFor('delivery-fallback', obstructed) },
  );
  const earlier = obstructed.map((o) => `\`${o.mechanism}\``).join(', ');
  const cause = `This includes a proposal delivered by a fallback: ${lowerFirst(unit.description)} is delivered as \`${mechanism}\`, `
    + `because \`${dimension}\` is ${listSpan(list)} and the mechanisms listed before it (${earlier}) are unavailable.`;
  return { delivery: deliver(mechanism), fallback: { warning, cause } };
}

/** Routes one unit by the dimension that governs its kind (§2, §8.2-§8.5). */
function routeUnit(policy: IResolvedDeliveryPolicy, unit: Exclude<DeliveryUnit, IAlternativeUnit>): Routing {
  switch (unit.kind) {
    case 'edit':
      return route(unit, 'edits', policy.edits, (m) => obstaclesOf(unit.availability(m)),
        (mechanism) => ({ unitId: unit.id, kind: unit.kind, dimension: 'edits', mechanism }));
    case 'edit-group':
      return route(unit, 'groupedEdits', policy.groupedEdits,
        (m) => (m === 'native-batch' ? nativeBatchObstacles(unit) : obstaclesOf(unit.availability(m))),
        (mechanism) => ({ unitId: unit.id, kind: unit.kind, dimension: 'groupedEdits', mechanism }));
    case 'file-operation':
    case 'file-operation-group':
      return route(unit, 'fileOperations', policy.fileOperations, (m) => obstaclesOf(unit.availability(m)),
        (mechanism) => ({ unitId: unit.id, kind: unit.kind, dimension: 'fileOperations', mechanism }));
  }
}

/**
 * The most companion pull requests one review creates, counted after
 * bundling (§9; the companion contract's limit, `too-many-suggestion-prs`).
 */
export const MAX_COMPANION_PULL_REQUESTS = 10;

/** The limit's error, unchanged in wording; its catalogued remedies name the single bundle first (§9). */
function tooManyCompanions(count: number): IDiagnostic {
  return createDiagnostic(
    'too-many-suggestion-prs',
    `The review needs ${String(count)} suggestion pull requests; the limit is ${String(MAX_COMPANION_PULL_REQUESTS)}. Nothing is split or dropped.`,
  );
}

/**
 * The caller's companion pull request options, as given (§12). They apply
 * only to companions; planning notes them when no companion is planned.
 */
export interface ICompanionOptions {
  readonly pullRequestLabels?: readonly string[] | undefined;
  readonly markSuggestionPullRequestsReady?: boolean | undefined;
}

/**
 * The `companion-options-unused` note for the options that would have had
 * an effect (at least one label; ready true), or undefined when none would.
 */
function unusedCompanionOptions(options: ICompanionOptions): IDiagnostic | undefined {
  const named = [
    ...((options.pullRequestLabels?.length ?? 0) > 0 ? ['`--pr-labels` (`pullRequestLabels`)'] : []),
    ...(options.markSuggestionPullRequestsReady === true ? ['`--mark-suggestion-prs-ready` (`markSuggestionPullRequestsReady`)'] : []),
  ];
  if (named.length === 0) return undefined;
  return createDiagnostic('companion-options-unused', `No companion pull request is planned, so these options have no effect: ${named.join(', ')}.`);
}

/** The companion pull requests for the companion-delivered units, in order (§9). */
function bundle(bundling: CompanionBundle, units: readonly string[]): ICompanionPlan[] {
  if (units.length === 0) return [];
  return bundling === 'single' ? [{ sections: [...units] }] : units.map((unit) => ({ sections: [unit] }));
}

/**
 * Plans one destination for every unit under `policy` (§8-§10). A unit is
 * delivered whole by the first available mechanism of its dimension's list;
 * a mechanism the list does not name is never used. If any unit has no
 * available listed mechanism, or the companions exceed
 * {@link MAX_COMPANION_PULL_REQUESTS}, the plan is blocked and reports every
 * such problem. A planned publication with no companion notes the caller's
 * `companionOptions` that therefore have no effect (§12).
 *
 * @throws TypeError when two units share an identifier: a plan names each unit once.
 */
export function planDelivery(
  policy: IResolvedDeliveryPolicy,
  units: readonly DeliveryUnit[],
  companionOptions: ICompanionOptions = {},
): DeliveryPlan {
  const ids = new Set<string>();
  for (const unit of units) {
    if (ids.has(unit.id)) throw new TypeError(`Two delivery units share the identifier ${JSON.stringify(unit.id)}.`);
    ids.add(unit.id);
  }
  const deliveries: UnitDelivery[] = [];
  const alternatives: string[] = [];
  const blocked: string[] = [];
  const errors: IDiagnostic[] = [];
  const warnings: IDiagnostic[] = [];
  const fallbacks: IFallbackDelivery[] = [];
  for (const unit of units) {
    if (unit.kind === 'alternative') {
      alternatives.push(unit.id);
      continue;
    }
    const routing = routeUnit(policy, unit);
    if ('blocked' in routing) {
      blocked.push(unit.id);
      errors.push(routing.blocked);
    } else {
      deliveries.push(routing.delivery);
      if (routing.fallback !== undefined) {
        warnings.push(routing.fallback.warning);
        fallbacks.push({ unitId: unit.id, mechanism: routing.delivery.mechanism, cause: routing.fallback.cause });
      }
    }
  }
  const companions = bundle(policy.companionBundle.value, deliveries.filter((d) => d.mechanism === 'companion').map((d) => d.unitId));
  if (companions.length > MAX_COMPANION_PULL_REQUESTS) errors.push(tooManyCompanions(companions.length));
  // Blocked: only the errors. The fallback warnings describe deliveries that will not happen (§10.1).
  if (errors.length > 0) return { status: 'blocked', policy, blocked, diagnostics: errors };
  const unused = companions.length === 0 ? unusedCompanionOptions(companionOptions) : undefined;
  const diagnostics = unused === undefined ? warnings : [...warnings, unused];
  return { status: 'planned', policy, deliveries, companions, alternatives, diagnostics: orderDiagnostics(diagnostics), fallbacks };
}

/**
 * Where each mechanism puts a unit, as the checks made after planning see it
 * (§10.1): the blocking codes a unit delivered by that mechanism contributes
 * to. `manual` is a review-body section; `native` and `native-batch` are
 * inline comments; `companion` is a companion pull request, which the
 * repository checks govern. Both bodies and comments count toward the
 * review's payload.
 */
const CONTRIBUTES_TO: Readonly<Record<UnitDelivery['mechanism'], ReadonlySet<string>>> = {
  'manual': new Set(['body-too-large', 'payload-too-large']),
  'native': new Set(['too-many-comments', 'comment-too-large', 'payload-too-large']),
  'native-batch': new Set(['too-many-comments', 'comment-too-large', 'payload-too-large']),
  'companion': new Set(['suggestion-pr-permission-missing', 'suggestion-pr-configuration-invalid', 'suggestion-label-missing']),
  'review-body': new Set(['body-too-large', 'payload-too-large']),
  'manual-group': new Set(['body-too-large', 'payload-too-large']),
};

/**
 * A block found after planning, naming its causes (§10.1): each error a
 * fallback-delivered unit contributed to ends with one paragraph per such
 * unit, in plan order. Other diagnostics, and every diagnostic when nothing
 * fell back, are returned unchanged. The block itself carries no
 * `delivery-fallback` warning; the caller leaves those out.
 */
export function nameFallbackCauses<D extends IDiagnostic>(diagnostics: readonly D[], fallbacks: readonly IFallbackDelivery[]): D[] {
  return diagnostics.map((diagnostic) => {
    if (diagnostic.severity !== 'error') return diagnostic;
    const causes = fallbacks.filter((f) => CONTRIBUTES_TO[f.mechanism].has(diagnostic.code)).map((f) => `\n\n${f.cause}`);
    return causes.length === 0 ? diagnostic : { ...diagnostic, message: `${diagnostic.message}${causes.join('')}` };
  });
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** `text` as one Markdown code span, whatever backticks it holds. */
function codeSpan(text: string): string {
  let fence = '`';
  while (text.includes(fence)) fence += '`';
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
