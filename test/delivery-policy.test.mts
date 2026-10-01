/**
 * The delivery policy (docs/delivery-policy-contract.md): resolving each
 * dimension from the caller, the repository configuration and the defaults,
 * validating caller settings and the configuration file, and planning one
 * destination for every delivery unit, with blocked units and announced
 * fallbacks.
 *
 * The module is pure, so it is tested directly. Every expected value is
 * written by hand from the contract, and each test names the section it
 * checks: the vocabularies (§3), lists (§4), defaults (§5), presets (§6),
 * precedence (§7), routing (§8), bundles (§9), diagnostics (§10), the
 * configuration file (§11) and the acceptance examples (§14). The
 * property-style tests at the end check the contract's invariants over
 * generated policies and units with a seeded generator, so every run is the
 * same.
 *
 * @see https://www.rfc-editor.org/rfc/rfc6901
 * @see https://json-schema.org/draft-07/json-schema-release-notes
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import AjvModule from 'ajv';

import {
  COMPANION_BUNDLES,
  DEFAULT_DELIVERY_POLICY,
  DELIVERY_CONFIGURATION_PATH,
  DELIVERY_MECHANISMS,
  DELIVERY_PRESETS,
  DELIVERY_PRESET_SETTINGS,
  deliveryConfigurationDiagnostics,
  deliveryConfigurationNeeded,
  deliveryRecordProblem,
  isResolvedDeliveryPolicy,
  planDelivery,
  readDeliveryConfiguration,
  resolveDeliveryPolicy,
  validateDeliveryConfiguration,
  validateDeliveryPolicyLayer,
} from '../dist/delivery-policy.cjs';
import type {
  DeliveryPlan,
  DeliveryUnit,
  EditMechanism,
  FileOperationMechanism,
  GroupedEditMechanism,
  IDeliveryPolicyInputs,
  IDeliveryPolicyLayer,
  IEditGroupMember,
  IResolvedDeliveryPolicy,
  MechanismAvailability,
  UnitDelivery,
} from '../dist/delivery-policy.cjs';
import type { IDiagnostic } from '../dist/public-types.cjs';
import { asRecord, parseJson } from './support/runtime-types.mts';

const CONTRACT = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'delivery-policy-contract.md'), 'utf8');

// ---------------------------------------------------------------------------
// Builders. Availability, units and the expected diagnostics, from §8 and §10.
// ---------------------------------------------------------------------------

const OK: MechanismAvailability = { available: true };

/** An unavailable mechanism with its obstacles (§8.7: always at least one). */
function no(...obstacles: [string, ...string[]]): MechanismAvailability {
  return { available: false, obstacles };
}

/** Lazy availability (§8.7) answering from a table of each mechanism's availability. */
function lookup<M extends string>(table: Readonly<Record<M, MechanismAvailability>>): (mechanism: M) => MechanismAvailability {
  return (mechanism) => table[mechanism];
}

function edit(
  id: string,
  description: string,
  native: MechanismAvailability = OK,
  reviewBody: MechanismAvailability = OK,
  companion: MechanismAvailability = OK,
): DeliveryUnit {
  return { kind: 'edit', id, description, availability: lookup({ native, 'review-body': reviewBody, companion }) };
}

function member(description: string, native: MechanismAvailability = OK): IEditGroupMember {
  return { description, native: () => native };
}

interface IGroupAvailability {
  readonly nativeBatch?: MechanismAvailability;
  readonly companion?: MechanismAvailability;
  readonly manualGroup?: MechanismAvailability;
}

function editGroup(id: string, description: string, members: readonly IEditGroupMember[], a: IGroupAvailability = {}): DeliveryUnit {
  return {
    kind: 'edit-group',
    id,
    description,
    members,
    availability: lookup({ 'native-batch': a.nativeBatch ?? OK, companion: a.companion ?? OK, 'manual-group': a.manualGroup ?? OK }),
  };
}

interface IFileAvailability {
  readonly manual?: MechanismAvailability;
  readonly companion?: MechanismAvailability;
}

function fileOperation(id: string, description: string, a: IFileAvailability = {}): DeliveryUnit {
  return { kind: 'file-operation', id, description, availability: lookup({ manual: a.manual ?? OK, companion: a.companion ?? OK }) };
}

function fileOperationGroup(id: string, description: string, a: IFileAvailability = {}): DeliveryUnit {
  return { kind: 'file-operation-group', id, description, availability: lookup({ manual: a.manual ?? OK, companion: a.companion ?? OK }) };
}

function alternative(id: string, description: string): DeliveryUnit {
  return { kind: 'alternative', id, description };
}

function policy(inputs: IDeliveryPolicyInputs = {}): IResolvedDeliveryPolicy {
  return resolveDeliveryPolicy(inputs);
}

/** The catalog facts of the three codes, from the contract's table (§10.3). */
const UNAVAILABLE = {
  severity: 'error',
  code: 'delivery-unavailable',
  title: 'No delivery mechanism the policy lists is available for a proposal',
  remedies: [
    'Remove the obstacle the message names, then publish again.',
    'Or list a mechanism that is available for this kind of proposal (`--edits`, `--grouped-edits`, `--file-operations`, the `delivery` option, or `.github/sarif-to-comment.json`).',
  ],
} as const;
const FALLBACK = {
  severity: 'warning',
  code: 'delivery-fallback',
  title: 'A proposal is delivered by a later mechanism of its delivery list',
  remedies: [
    'To use an earlier mechanism, remove the obstacle the message names, then publish again.',
    'To refuse rather than fall back, list only the mechanism you require.',
  ],
} as const;
const CONFIGURATION_INVALID = {
  severity: 'error',
  code: 'delivery-configuration-invalid',
  title: 'The delivery configuration is not valid',
  remedies: ['Fix `.github/sarif-to-comment.json` on the default branch.'],
} as const;

/** The existing limit's code, from docs/diagnostics.md, with the remedies of contract §9. */
const TOO_MANY = {
  severity: 'error',
  code: 'too-many-suggestion-prs',
  title: 'The review would create too many suggestion pull requests',
  remedies: [
    'Bundle them into one companion pull request (`--companion-bundle single`, `delivery.companionBundle: \'single\'`).',
    'Publish fewer proposals in one review, or group related changes.',
  ],
} as const;
const OPTIONS_UNUSED = { severity: 'note', code: 'companion-options-unused', title: 'Companion pull request options have no effect' } as const;

function tooManyDiagnostic(count: number): IDiagnostic {
  return {
    severity: TOO_MANY.severity,
    code: TOO_MANY.code,
    title: TOO_MANY.title,
    message: `The review needs ${String(count)} suggestion pull requests; the limit is 10. Nothing is split or dropped.`,
    remedies: [...TOO_MANY.remedies],
  };
}

function optionsUnusedDiagnostic(message: string): IDiagnostic {
  return { severity: OPTIONS_UNUSED.severity, code: OPTIONS_UNUSED.code, title: OPTIONS_UNUSED.title, message };
}

function unavailableDiagnostic(message: string): IDiagnostic {
  return { severity: UNAVAILABLE.severity, code: UNAVAILABLE.code, title: UNAVAILABLE.title, message, remedies: [...UNAVAILABLE.remedies] };
}

function fallbackDiagnostic(message: string): IDiagnostic {
  return { severity: FALLBACK.severity, code: FALLBACK.code, title: FALLBACK.title, message, remedies: [...FALLBACK.remedies] };
}

function configurationDiagnostic(message: string): IDiagnostic {
  return {
    severity: CONFIGURATION_INVALID.severity,
    code: CONFIGURATION_INVALID.code,
    title: CONFIGURATION_INVALID.title,
    message,
    remedies: [...CONFIGURATION_INVALID.remedies],
  };
}

/** The planned variant, failing the test otherwise. */
function planned(plan: DeliveryPlan): Extract<DeliveryPlan, { status: 'planned' }> {
  assert.equal(plan.status, 'planned', JSON.stringify(plan.diagnostics, null, 2));
  return plan;
}

/** The blocked variant, failing the test otherwise. */
function blocked(plan: DeliveryPlan): Extract<DeliveryPlan, { status: 'blocked' }> {
  assert.equal(plan.status, 'blocked');
  return plan;
}

const encoder = new TextEncoder();

function file(text: string): { readonly branch: string; readonly content: { readonly kind: 'file'; readonly bytes: Uint8Array } } {
  return { branch: 'main', content: { kind: 'file', bytes: encoder.encode(text) } };
}

// ---------------------------------------------------------------------------
// §3, §5, §6: vocabularies, defaults and presets
// ---------------------------------------------------------------------------

describe('vocabularies, defaults and presets (contract §3, §5, §6, §11.1)', () => {
  test('each dimension has exactly its fixed vocabulary, in the contract\'s order (§3)', () => {
    assert.deepEqual(DELIVERY_MECHANISMS, {
      edits: ['native', 'review-body', 'companion'],
      groupedEdits: ['native-batch', 'companion', 'manual-group'],
      fileOperations: ['manual', 'companion'],
    });
    assert.deepEqual(COMPANION_BUNDLES, ['per-unit', 'single']);
    assert.deepEqual(DELIVERY_PRESETS, ['original-pr', 'companion']);
  });

  test('the defaults are explicit, edits is strictly native, and none names a companion (§5)', () => {
    assert.deepEqual(DEFAULT_DELIVERY_POLICY, {
      edits: ['native'],
      groupedEdits: ['native-batch'],
      fileOperations: ['manual'],
      companionBundle: 'per-unit',
    });
  });

  test('each preset sets exactly the dimensions of its row (§6)', () => {
    assert.deepEqual(DELIVERY_PRESET_SETTINGS, {
      'original-pr': { edits: ['native', 'review-body'], groupedEdits: ['native-batch', 'manual-group'], fileOperations: ['manual'] },
      companion: { edits: ['companion'], groupedEdits: ['companion'], fileOperations: ['companion'] },
    });
  });

  test('the configuration file is .github/sarif-to-comment.json (§11.1)', () => {
    assert.equal(DELIVERY_CONFIGURATION_PATH, '.github/sarif-to-comment.json');
  });
});

// ---------------------------------------------------------------------------
// §7: layers and precedence, the full truth table
// ---------------------------------------------------------------------------

/** One row of the truth table: which layers set the dimension, and which one wins (§7's ranks). */
type Row = readonly [caller: boolean, callerPreset: boolean, configuration: boolean, configurationPreset: boolean, winner: 'caller' | 'caller-preset' | 'configuration' | 'configuration-preset' | 'default'];

/** Written by hand from §7: the highest-ranked layer that sets the dimension wins. */
const TRUTH_TABLE: readonly Row[] = [
  [false, false, false, false, 'default'],
  [false, false, false, true, 'configuration-preset'],
  [false, false, true, false, 'configuration'],
  [false, false, true, true, 'configuration'],
  [false, true, false, false, 'caller-preset'],
  [false, true, false, true, 'caller-preset'],
  [false, true, true, false, 'caller-preset'],
  [false, true, true, true, 'caller-preset'],
  [true, false, false, false, 'caller'],
  [true, false, false, true, 'caller'],
  [true, false, true, false, 'caller'],
  [true, false, true, true, 'caller'],
  [true, true, false, false, 'caller'],
  [true, true, false, true, 'caller'],
  [true, true, true, false, 'caller'],
  [true, true, true, true, 'caller'],
];

function rowName(row: Row): string {
  const [c, cp, f, fp] = row;
  return `caller ${c ? 'set' : '-'}, caller preset ${cp ? 'set' : '-'}, configuration ${f ? 'set' : '-'}, configuration preset ${fp ? 'set' : '-'}`;
}

describe('precedence, per dimension (contract §7)', () => {
  // groupedEdits: both presets set it, so every layer can decide. Each layer's
  // list is distinct, so the value identifies the winner as well as the source.
  for (const row of TRUTH_TABLE) {
    test(`groupedEdits: ${rowName(row)} -> ${row[4]}`, () => {
      const [c, cp, f, fp, winner] = row;
      const caller: IDeliveryPolicyLayer = { ...(c ? { groupedEdits: ['manual-group'] } : {}), ...(cp ? { preset: 'companion' } : {}) };
      const configuration: IDeliveryPolicyLayer = { ...(f ? { groupedEdits: ['native-batch', 'companion'] } : {}), ...(fp ? { preset: 'original-pr' } : {}) };
      const expected = {
        caller: { value: ['manual-group'], source: 'caller' },
        'caller-preset': { value: ['companion'], source: 'caller-preset', preset: 'companion' },
        configuration: { value: ['native-batch', 'companion'], source: 'configuration' },
        'configuration-preset': { value: ['native-batch', 'manual-group'], source: 'configuration-preset', preset: 'original-pr' },
        default: { value: ['native-batch'], source: 'default' },
      }[winner];
      assert.deepEqual(policy({ caller, configuration }).groupedEdits, expected);
    });
  }

  for (const row of TRUTH_TABLE) {
    test(`fileOperations: ${rowName(row)} -> ${row[4]}`, () => {
      const [c, cp, f, fp, winner] = row;
      const caller: IDeliveryPolicyLayer = { ...(c ? { fileOperations: ['manual', 'companion'] } : {}), ...(cp ? { preset: 'companion' } : {}) };
      const configuration: IDeliveryPolicyLayer = { ...(f ? { fileOperations: ['companion', 'manual'] } : {}), ...(fp ? { preset: 'original-pr' } : {}) };
      const expected = {
        caller: { value: ['manual', 'companion'], source: 'caller' },
        'caller-preset': { value: ['companion'], source: 'caller-preset', preset: 'companion' },
        configuration: { value: ['companion', 'manual'], source: 'configuration' },
        'configuration-preset': { value: ['manual'], source: 'configuration-preset', preset: 'original-pr' },
        default: { value: ['manual'], source: 'default' },
      }[winner];
      assert.deepEqual(policy({ caller, configuration }).fileOperations, expected);
    });
  }

  for (const row of TRUTH_TABLE) {
    test(`edits: ${rowName(row)} -> ${row[4]}`, () => {
      const [c, cp, f, fp, winner] = row;
      const caller: IDeliveryPolicyLayer = { ...(c ? { edits: ['review-body'] } : {}), ...(cp ? { preset: 'original-pr' } : {}) };
      const configuration: IDeliveryPolicyLayer = { ...(f ? { edits: ['review-body', 'native'] } : {}), ...(fp ? { preset: 'original-pr' } : {}) };
      const expected = {
        caller: { value: ['review-body'], source: 'caller' },
        'caller-preset': { value: ['native', 'review-body'], source: 'caller-preset', preset: 'original-pr' },
        configuration: { value: ['review-body', 'native'], source: 'configuration' },
        'configuration-preset': { value: ['native', 'review-body'], source: 'configuration-preset', preset: 'original-pr' },
        default: { value: ['native'], source: 'default' },
      }[winner];
      assert.deepEqual(policy({ caller, configuration }).edits, expected);
    });
  }

  // companionBundle: no preset sets it (§6), so a preset never decides it and
  // the search continues to the next layer.
  const BUNDLE_TABLE: readonly Row[] = [
    [false, false, false, false, 'default'],
    [false, false, false, true, 'default'],
    [false, false, true, false, 'configuration'],
    [false, false, true, true, 'configuration'],
    [false, true, false, false, 'default'],
    [false, true, false, true, 'default'],
    [false, true, true, false, 'configuration'],
    [false, true, true, true, 'configuration'],
    [true, false, false, false, 'caller'],
    [true, false, false, true, 'caller'],
    [true, false, true, false, 'caller'],
    [true, false, true, true, 'caller'],
    [true, true, false, false, 'caller'],
    [true, true, false, true, 'caller'],
    [true, true, true, false, 'caller'],
    [true, true, true, true, 'caller'],
  ];
  for (const row of BUNDLE_TABLE) {
    test(`companionBundle: ${rowName(row)} -> ${row[4]}`, () => {
      const [c, cp, f, fp, winner] = row;
      const caller: IDeliveryPolicyLayer = { ...(c ? { companionBundle: 'single' } : {}), ...(cp ? { preset: 'companion' } : {}) };
      const configuration: IDeliveryPolicyLayer = { ...(f ? { companionBundle: 'single' } : {}), ...(fp ? { preset: 'companion' } : {}) };
      const expected = {
        caller: { value: 'single', source: 'caller' },
        configuration: { value: 'single', source: 'configuration' },
        default: { value: 'per-unit', source: 'default' },
      }[winner === 'caller-preset' || winner === 'configuration-preset' ? 'default' : winner];
      assert.deepEqual(policy({ caller, configuration }).companionBundle, expected);
    });
  }

  test('a preset that does not set a setting does not stop the search (§7)', () => {
    // No preset sets companionBundle (§6).
    const resolved = policy({ caller: { preset: 'companion' }, configuration: { companionBundle: 'single' } });
    assert.deepEqual(resolved.companionBundle, { value: 'single', source: 'configuration' });
  });

  test('a list is taken whole: the winning layer replaces lower lists, never merges with them (§7)', () => {
    const resolved = policy({ caller: { fileOperations: ['manual'] }, configuration: { fileOperations: ['companion', 'manual'] } });
    assert.deepEqual(resolved.fileOperations, { value: ['manual'], source: 'caller' });
  });

  test('dimensions resolve independently of one another (§7)', () => {
    const resolved = policy({ caller: { edits: ['native'] }, configuration: { fileOperations: ['companion'], companionBundle: 'single' } });
    assert.deepEqual(resolved, {
      edits: { value: ['native'], source: 'caller' },
      groupedEdits: { value: ['native-batch'], source: 'default' },
      fileOperations: { value: ['companion'], source: 'configuration' },
      companionBundle: { value: 'single', source: 'configuration' },
    });
  });

  test('the resolved lists do not change when the caller later changes its own input (§13: what is recorded is what was resolved)', () => {
    const edits: ('native' | 'review-body')[] = ['review-body'];
    const resolved = policy({ caller: { edits } });
    edits.push('native');
    assert.deepEqual(resolved.edits.value, ['review-body']);
  });

  test('the recorded form has the members of §13, in its order', () => {
    const resolved = policy({ caller: { preset: 'companion' } });
    assert.deepEqual(Object.keys(resolved), ['edits', 'groupedEdits', 'fileOperations', 'companionBundle']);
    assert.deepEqual(parseJson(JSON.stringify(resolved)), {
      edits: { value: ['companion'], source: 'caller-preset', preset: 'companion' },
      groupedEdits: { value: ['companion'], source: 'caller-preset', preset: 'companion' },
      fileOperations: { value: ['companion'], source: 'caller-preset', preset: 'companion' },
      companionBundle: { value: 'per-unit', source: 'default' },
    });
  });
});

describe('whether the configuration is read (contract §11.1)', () => {
  // Written by hand: the file is not read exactly when the caller's specific
  // settings and preset together decide edits, groupedEdits, fileOperations
  // and companionBundle.
  const CASES: readonly (readonly [what: string, caller: IDeliveryPolicyLayer | undefined, needed: boolean])[] = [
    ['no caller layer', undefined, true],
    ['an empty caller layer', {}, true],
    ['every setting given specifically', { edits: ['native'], groupedEdits: ['companion'], fileOperations: ['manual'], companionBundle: 'per-unit' }, false],
    ['every list but no companionBundle', { edits: ['native'], groupedEdits: ['companion'], fileOperations: ['manual'] }, true],
    ['the companion preset alone (it leaves companionBundle)', { preset: 'companion' }, true],
    ['the companion preset and companionBundle', { preset: 'companion', companionBundle: 'per-unit' }, false],
    ['the original-pr preset and companionBundle', { preset: 'original-pr', companionBundle: 'single' }, false],
    ['the original-pr preset alone', { preset: 'original-pr' }, true],
    ['edits alone', { edits: ['native'] }, true],
    ['a preset plus specific overrides, still deciding everything', { preset: 'companion', edits: ['native'], companionBundle: 'single' }, false],
  ];
  for (const [what, caller, needed] of CASES) {
    test(`${what}: ${needed ? 'read' : 'not read'}`, () => {
      assert.equal(deliveryConfigurationNeeded(caller), needed);
    });
  }

  test('when it is not read, the resolution comes from the caller layers alone', () => {
    const caller: IDeliveryPolicyLayer = { preset: 'companion', companionBundle: 'single' };
    assert.equal(deliveryConfigurationNeeded(caller), false);
    const resolved = policy({ caller });
    assert.deepEqual(
      [resolved.edits.source, resolved.groupedEdits.source, resolved.fileOperations.source, resolved.companionBundle.source],
      ['caller-preset', 'caller-preset', 'caller-preset', 'caller'],
    );
  });
});

// ---------------------------------------------------------------------------
// §11.4 and §12: validating caller settings and the configuration
// ---------------------------------------------------------------------------

describe('validating a caller layer (contract §12, by the rules of §11.4)', () => {
  test('an empty layer and a complete layer are valid, and the layer is returned as given', () => {
    assert.deepEqual(validateDeliveryPolicyLayer({}), { status: 'valid', layer: {} });
    const complete = {
      preset: 'companion',
      edits: ['review-body', 'native'],
      groupedEdits: ['manual-group', 'companion', 'native-batch'],
      fileOperations: ['companion', 'manual'],
      companionBundle: 'single',
    };
    assert.deepEqual(validateDeliveryPolicyLayer(complete), { status: 'valid', layer: complete });
  });

  const INVALID: readonly (readonly [what: string, value: unknown, problems: readonly { pointer: string; detail: string }[]])[] = [
    ['not an object (null)', null, [{ pointer: '', detail: 'must be an object' }]],
    ['not an object (an array)', ['native'], [{ pointer: '', detail: 'must be an object' }]],
    ['not an object (a string)', 'companion', [{ pointer: '', detail: 'must be an object' }]],
    ['an unknown member', { bundle: 'single' }, [{ pointer: '/bundle', detail: 'is not a known setting' }]],
    ['the configuration-only $schema member', { $schema: 'x' }, [{ pointer: '/$schema', detail: 'is not a known setting' }]],
    ['the removed boolean, as a member', { allowSuggestionPullRequests: true }, [{ pointer: '/allowSuggestionPullRequests', detail: 'is not a known setting' }]],
    ['a list given as a string', { edits: 'native' }, [{ pointer: '/edits', detail: 'must be a list of mechanisms' }]],
    ['a list given as null', { fileOperations: null }, [{ pointer: '/fileOperations', detail: 'must be a list of mechanisms' }]],
    ['an empty list', { edits: [] }, [{ pointer: '/edits', detail: 'must list at least one mechanism' }]],
    ['a mechanism of another dimension', { edits: ['native', 'manual'] }, [{ pointer: '/edits/1', detail: 'is not one of `native`, `review-body`, `companion`' }]],
    ['a non-string entry', { edits: [1] }, [{ pointer: '/edits/0', detail: 'is not one of `native`, `review-body`, `companion`' }]],
    ['a differently cased mechanism', { groupedEdits: ['companion', 'Companion'] }, [{ pointer: '/groupedEdits/1', detail: 'is not one of `native-batch`, `companion`, `manual-group`' }]],
    ['a repeated mechanism', { edits: ['native', 'review-body', 'native'] }, [{ pointer: '/edits/2', detail: 'repeats `native`' }]],
    ['a mechanism repeated twice', { fileOperations: ['manual', 'manual', 'manual'] }, [
      { pointer: '/fileOperations/1', detail: 'repeats `manual`' },
      { pointer: '/fileOperations/2', detail: 'repeats `manual`' },
    ]],
    ['a preset outside its vocabulary', { preset: 'native' }, [{ pointer: '/preset', detail: 'is not one of `original-pr`, `companion`' }]],
    ['a companionBundle given as a list', { companionBundle: ['single'] }, [{ pointer: '/companionBundle', detail: 'is not one of `per-unit`, `single`' }]],
    ['several problems, in member order', { fileOperations: [], preset: 'all', groupedEdits: ['companion', 'companion'] }, [
      { pointer: '/fileOperations', detail: 'must list at least one mechanism' },
      { pointer: '/preset', detail: 'is not one of `original-pr`, `companion`' },
      { pointer: '/groupedEdits/1', detail: 'repeats `companion`' },
    ]],
    ['a member name with / and ~, escaped as in RFC 6901', { 'a/b~c': 1 }, [{ pointer: '/a~1b~0c', detail: 'is not a known setting' }]],
    ['a member name with a control character, shown as \\uXXXX', { 'x\u0007y\u202E': 1 }, [{ pointer: '/x\\u0007y\\u202E', detail: 'is not a known setting' }]],
    ['a __proto__ member from JSON', parseJson('{"__proto__":["native"]}'), [{ pointer: '/__proto__', detail: 'is not a known setting' }]],
  ];
  for (const [what, value, problems] of INVALID) {
    test(`invalid: ${what}`, () => {
      assert.deepEqual(validateDeliveryPolicyLayer(value), { status: 'invalid', problems });
    });
  }
});

describe('validating the configuration file (contract §11.3, §11.4)', () => {
  test('an object without delivery, or with an empty delivery, sets nothing', () => {
    assert.deepEqual(validateDeliveryConfiguration({}), { status: 'valid', layer: {} });
    assert.deepEqual(validateDeliveryConfiguration({ delivery: {} }), { status: 'valid', layer: {} });
  });

  test('the $schema member is allowed as a string and ignored', () => {
    assert.deepEqual(
      validateDeliveryConfiguration({ $schema: 'https://example.com/schema.json', delivery: { edits: ['native'] } }),
      { status: 'valid', layer: { edits: ['native'] } },
    );
  });

  test('the example of §11.3 is valid', () => {
    const example = CONTRACT.slice(CONTRACT.indexOf('### 11.3 Shape'));
    const json = /```json\n([\s\S]*?)\n```/.exec(example)?.[1] ?? '';
    assert.deepEqual(validateDeliveryConfiguration(parseJson(json)), {
      status: 'valid',
      layer: {
        preset: 'original-pr',
        edits: ['native', 'review-body'],
        groupedEdits: ['native-batch', 'companion'],
        fileOperations: ['companion', 'manual'],
        companionBundle: 'single',
      },
    });
  });

  const INVALID: readonly (readonly [what: string, value: unknown, problems: readonly { pointer: string; detail: string }[]])[] = [
    ['an array', [], [{ pointer: '', detail: 'it is not a JSON object' }]],
    ['a string', 'native', [{ pointer: '', detail: 'it is not a JSON object' }]],
    ['null', null, [{ pointer: '', detail: 'it is not a JSON object' }]],
    ['the convention file\'s label member (§11.2)', { label: 'suggestion-pr' }, [{ pointer: '/label', detail: 'is not a known setting' }]],
    ['a dimension at the top level instead of in delivery', { edits: ['native'] }, [{ pointer: '/edits', detail: 'is not a known setting' }]],
    ['$schema not a string', { $schema: 3 }, [{ pointer: '/$schema', detail: 'must be a string' }]],
    ['delivery not an object', { delivery: ['companion'] }, [{ pointer: '/delivery', detail: 'must be an object' }]],
    ['delivery null', { delivery: null }, [{ pointer: '/delivery', detail: 'must be an object' }]],
    ['an empty list', { delivery: { groupedEdits: [] } }, [{ pointer: '/delivery/groupedEdits', detail: 'must list at least one mechanism' }]],
    ['an unknown member in delivery', { delivery: { companionBundles: 'single' } }, [{ pointer: '/delivery/companionBundles', detail: 'is not a known setting' }]],
    ['problems at both levels, in file order', { extra: 1, delivery: { edits: ['native', 'native'] } }, [
      { pointer: '/extra', detail: 'is not a known setting' },
      { pointer: '/delivery/edits/1', detail: 'repeats `native`' },
    ]],
  ];
  for (const [what, value, problems] of INVALID) {
    test(`invalid: ${what}`, () => {
      assert.deepEqual(validateDeliveryConfiguration(value), { status: 'invalid', problems });
    });
  }

  test('the validator agrees with the contract\'s JSON Schema on every sample (§11.3)', () => {
    const marker = CONTRACT.indexOf('<!-- delivery-configuration-schema -->');
    assert.ok(marker !== -1, 'the contract carries the schema');
    const schemaText = /```json\n([\s\S]*?)\n```/.exec(CONTRACT.slice(marker))?.[1] ?? '';
    const Ajv = AjvModule.default;
    const validate = new Ajv({ allErrors: true, strict: true }).compile(asRecord(parseJson(schemaText), 'the schema'));
    const samples: unknown[] = [];
    // Fixed samples, then generated ones mixing valid and invalid members.
    samples.push({}, [], null, 'x', 1, { delivery: {} }, { $schema: 'x' }, { $schema: 1 }, { label: 'x' });
    const random = seeded(0x5eed);
    const values: readonly unknown[] = [
      [], ['native'], ['native', 'review-body'], ['native', 'native'], ['review-body', 'native'], ['companion'], ['manual'],
      ['companion', 'manual'], ['manual-group', 'native-batch'], ['native-batch', 'companion', 'manual-group'], [1], 'native',
      null, 'single', 'per-unit', 'companion', 'original-pr', 'native-batch', {}, true,
    ];
    // Mostly values valid for their member, so that valid documents are common too.
    const validFor: Readonly<Record<string, readonly unknown[]>> = {
      preset: ['original-pr', 'companion'],
      edits: [['native'], ['review-body', 'native']],
      groupedEdits: [['companion'], ['native-batch', 'manual-group']],
      fileOperations: [['manual'], ['companion', 'manual']],
      companionBundle: ['single', 'per-unit'],
    };
    const keys = ['preset', 'edits', 'groupedEdits', 'fileOperations', 'companionBundle', 'bundle'];
    for (let i = 0; i < 400; i += 1) {
      const delivery: Record<string, unknown> = {};
      for (const key of keys) {
        if (random() >= 0.4) continue;
        const valid = validFor[key];
        delivery[key] = valid !== undefined && random() < 0.75 ? pick(random, valid) : pick(random, values);
      }
      const root: Record<string, unknown> = { delivery };
      if (random() < 0.1) root['$schema'] = random() < 0.5 ? 'https://example.com' : 2;
      if (random() < 0.05) root['other'] = 1;
      samples.push(root);
    }
    let valid = 0;
    for (const sample of samples) {
      const expected = validate(sample);
      if (expected) valid += 1;
      assert.equal(validateDeliveryConfiguration(sample).status === 'valid', expected, JSON.stringify(sample));
    }
    assert.ok(valid > 20 && valid < samples.length - 20, `the samples mix valid (${String(valid)}) and invalid documents`);
  });
});

describe('reading the configuration from the default branch (contract §11.1, §11.4)', () => {
  test('an absent file sets nothing', () => {
    assert.deepEqual(readDeliveryConfiguration({ branch: 'main', content: { kind: 'absent' } }), { status: 'absent', branch: 'main' });
  });

  test('a valid file is its layer, and a leading byte-order mark is not part of the JSON', () => {
    assert.deepEqual(readDeliveryConfiguration(file('{"delivery":{"fileOperations":["companion"]}}')), {
      status: 'valid', branch: 'main', layer: { fileOperations: ['companion'] },
    });
    assert.deepEqual(readDeliveryConfiguration(file('\uFEFF{"delivery":{"preset":"companion"}}')), {
      status: 'valid', branch: 'main', layer: { preset: 'companion' },
    });
  });

  const INVALID: readonly (readonly [what: string, configuration: Parameters<typeof readDeliveryConfiguration>[0], detail: string])[] = [
    ['not UTF-8', { branch: 'main', content: { kind: 'file', bytes: new Uint8Array([0x7b, 0xff, 0x7d]) } }, 'it is not UTF-8 text'],
    ['not JSON', file('{"delivery":'), 'it is not valid JSON'],
    ['JSON that is not an object', file('["native"]'), 'it is not a JSON object'],
    ['a directory at the path', { branch: 'main', content: { kind: 'not-a-file', entry: 'a directory', path: '.github/sarif-to-comment.json' } }, 'it is a directory, not a file'],
    ['a symbolic link at the path', { branch: 'main', content: { kind: 'not-a-file', entry: 'a symbolic link', path: '.github/sarif-to-comment.json' } }, 'it is a symbolic link, not a file'],
    ['a submodule at the path', { branch: 'main', content: { kind: 'not-a-file', entry: 'a submodule', path: '.github/sarif-to-comment.json' } }, 'it is a submodule, not a file'],
    ['a symbolic link on the way', { branch: 'main', content: { kind: 'not-a-file', entry: 'a symbolic link', path: '.github' } }, '`.github` is a symbolic link, which is never followed'],
    ['over the size limit', { branch: 'main', content: { kind: 'too-large', size: 1_000_001 } }, 'it is larger than 1000000 bytes'],
  ];
  for (const [what, configuration, detail] of INVALID) {
    test(`blocked: ${what}`, () => {
      assert.deepEqual(readDeliveryConfiguration(configuration), { status: 'invalid', branch: 'main', problems: [{ pointer: '', detail }] });
    });
  }

  test('a file with any problem is never partly used (§11.4)', () => {
    const read = readDeliveryConfiguration(file('{"delivery":{"fileOperations":["companion"],"edits":[]}}'));
    assert.deepEqual(read, { status: 'invalid', branch: 'main', problems: [{ pointer: '/delivery/edits', detail: 'must list at least one mechanism' }] });
    assert.equal(Object.hasOwn(read, 'layer'), false);
  });

  test('each problem is one delivery-configuration-invalid diagnostic with the exact message of §11.4', () => {
    assert.deepEqual(
      deliveryConfigurationDiagnostics({
        branch: 'main',
        problems: [
          { pointer: '', detail: 'it is not valid JSON' },
          { pointer: '/delivery/edits/1', detail: 'repeats `native`' },
        ],
      }),
      [
        configurationDiagnostic('`.github/sarif-to-comment.json` on the default branch `main` cannot be used: it is not valid JSON.'),
        configurationDiagnostic('`.github/sarif-to-comment.json` on the default branch `main` cannot be used: `/delivery/edits/1` repeats `native`.'),
      ],
    );
  });

  test('a branch name with a backtick stays one code span', () => {
    const [diagnostic] = deliveryConfigurationDiagnostics({ branch: 'release`1', problems: [{ pointer: '', detail: 'it is not valid JSON' }] });
    assert.equal(diagnostic?.message, '`.github/sarif-to-comment.json` on the default branch ``release`1`` cannot be used: it is not valid JSON.');
  });
});

// ---------------------------------------------------------------------------
// §8, §9, §10: routing, bundles, blocking and fallback
// ---------------------------------------------------------------------------

describe('routing each unit (contract §8)', () => {
  test('an edit follows edits, to its first available mechanism (§8.1, §8.2)', () => {
    const plan = planned(planDelivery(policy(), [edit('e1', 'The edit of `a.ts` line 3')]));
    assert.deepEqual(plan.deliveries, [{ unitId: 'e1', kind: 'edit', dimension: 'edits', mechanism: 'native' }]);
    assert.deepEqual(plan.diagnostics, []);
    assert.deepEqual(plan.companions, []);
  });

  test('a mechanism the list does not name is never used, even when it is available (§4.3)', () => {
    const plan = planned(planDelivery(policy({ caller: { groupedEdits: ['companion'] } }), [
      editGroup('g', 'The group `g`', [member('The edit of `a.ts` line 1'), member('The edit of `b.ts` line 2')]),
    ]));
    assert.deepEqual(plan.deliveries, [{ unitId: 'g', kind: 'edit-group', dimension: 'groupedEdits', mechanism: 'companion' }]);
  });

  test('native-batch requires every member to be eligible, and names each ineligible member (§8.3, §10.1)', () => {
    const plan = blocked(planDelivery(policy(), [
      editGroup('g', 'The group `reword`', [
        member('The edit of `a.md` line 1'),
        member('The edit of `b.md` line 9', no('The lines are not on the new side of the pull request\'s diff.')),
        member('The edit of `c.md` line 2', no('The replacement is blank lines only.', 'The reviewed commit is not the head.')),
      ]),
    ]));
    assert.deepEqual(plan.blocked, ['g']);
    assert.deepEqual(plan.diagnostics, [
      unavailableDiagnostic(
        'The group `reword` cannot be delivered. `groupedEdits` is `[native-batch]`, the default, and no mechanism it lists is available:\n\n'
        + '- `native-batch`: The edit of `b.md` line 9: The lines are not on the new side of the pull request\'s diff. '
        + 'The edit of `c.md` line 2: The replacement is blank lines only. The reviewed commit is not the head.',
      ),
    ]);
  });

  test('an obstacle of the group as a whole comes before the members\' obstacles (§10.1)', () => {
    const plan = blocked(planDelivery(policy(), [
      editGroup('g', 'The group `g`', [member('The edit of `a.md` line 1', no('Not inline.'))], { nativeBatch: no('Linked suggestions are not supported.') }),
    ]));
    assert.deepEqual(plan.diagnostics, [
      unavailableDiagnostic(
        'The group `g` cannot be delivered. `groupedEdits` is `[native-batch]`, the default, and no mechanism it lists is available:\n\n'
        + '- `native-batch`: Linked suggestions are not supported. The edit of `a.md` line 1: Not inline.',
      ),
    ]);
  });

  test('a group-level native-batch obstacle makes it unavailable even when every member is eligible (§8.3)', () => {
    const plan = blocked(planDelivery(policy(), [
      editGroup('g', 'The group `g`', [member('m1'), member('m2')], { nativeBatch: no('Not yet supported.') }),
    ]));
    assert.deepEqual(plan.blocked, ['g']);
  });

  test('manual-group is used for an edit group only when the list names it (§8.4)', () => {
    const group = editGroup('g', 'The group `g`', [member('m1'), member('m2', no('Not inline.'))]);
    blocked(planDelivery(policy(), [group]));
    blocked(planDelivery(policy({ caller: { groupedEdits: ['native-batch', 'companion'] } }), [
      editGroup('g', 'The group `g`', [member('m1'), member('m2', no('Not inline.'))], { companion: no('A fork.') }),
    ]));
    const plan = planned(planDelivery(policy({ configuration: { groupedEdits: ['native-batch', 'manual-group'] } }), [group]));
    assert.deepEqual(plan.deliveries, [{ unitId: 'g', kind: 'edit-group', dimension: 'groupedEdits', mechanism: 'manual-group' }]);
  });

  test('a file-operation group follows fileOperations as a whole, whatever groupedEdits says (§8.5)', () => {
    const units = [fileOperationGroup('h', 'The group `helper`')];
    const toCompanion = planned(planDelivery(policy({ caller: { fileOperations: ['companion'], groupedEdits: ['manual-group'] } }), units));
    assert.deepEqual(toCompanion.deliveries, [{ unitId: 'h', kind: 'file-operation-group', dimension: 'fileOperations', mechanism: 'companion' }]);
    const manual = planned(planDelivery(policy({ caller: { groupedEdits: ['companion'] } }), units));
    assert.deepEqual(manual.deliveries, [{ unitId: 'h', kind: 'file-operation-group', dimension: 'fileOperations', mechanism: 'manual' }]);
    assert.deepEqual(manual.companions, []);
  });

  test('a standalone file operation follows fileOperations (§2, D50)', () => {
    const plan = planned(planDelivery(policy(), [fileOperation('f', 'The deletion of `old.txt`')]));
    assert.deepEqual(plan.deliveries, [{ unitId: 'f', kind: 'file-operation', dimension: 'fileOperations', mechanism: 'manual' }]);
  });

  test('alternatives are listed with their finding and delivered by nothing (§8.6)', () => {
    const plan = planned(planDelivery(policy({ caller: { preset: 'companion', companionBundle: 'single' } }), [
      alternative('alt-1', 'The second fix of the finding'),
      fileOperation('f', 'The creation of `a.md`'),
      alternative('alt-2', 'The third fix of the finding'),
    ]));
    assert.deepEqual(plan.alternatives, ['alt-1', 'alt-2']);
    assert.deepEqual(plan.deliveries, [{ unitId: 'f', kind: 'file-operation', dimension: 'fileOperations', mechanism: 'companion' }]);
    assert.deepEqual(plan.companions, [{ sections: ['f'] }]);
  });

  test('unit identifiers must be distinct (a plan names each unit once)', () => {
    assert.throws(() => planDelivery(policy(), [edit('x', 'one'), fileOperation('x', 'two')]), TypeError);
  });

  test('no units: an empty plan', () => {
    assert.deepEqual(planDelivery(policy(), []), { status: 'planned', policy: policy(), deliveries: [], companions: [], alternatives: [], diagnostics: [] });
  });
});

describe('companion bundles (contract §9)', () => {
  const units = (): DeliveryUnit[] => [
    editGroup('g1', 'The group `one`', [member('a'), member('b')]),
    edit('e', 'The edit of `x.ts` line 1'),
    fileOperation('f', 'The creation of `new.md`'),
    editGroup('g2', 'The group `two`', [member('c'), member('d')]),
  ];

  // The edit stays native, so only the groups and the creation are companion-delivered.
  test('per-unit: one companion per companion-delivered unit, in order', () => {
    const plan = planned(planDelivery(policy({ caller: { preset: 'companion', edits: ['native'] } }), units()));
    assert.deepEqual(plan.companions, [{ sections: ['g1'] }, { sections: ['f'] }, { sections: ['g2'] }]);
  });

  test('single: one companion with each unit as its own section, in order', () => {
    const plan = planned(planDelivery(policy({ caller: { preset: 'companion', edits: ['native'], companionBundle: 'single' } }), units()));
    assert.deepEqual(plan.companions, [{ sections: ['g1', 'f', 'g2'] }]);
  });

  test('single with nothing delivered by companion creates no companion', () => {
    const plan = planned(planDelivery(policy({ caller: { companionBundle: 'single' } }), units()));
    assert.deepEqual(plan.companions, []);
  });
});

describe('blocking and announced fallback (contract §10)', () => {
  test('every unit with no available listed mechanism is reported, errors before warnings (§10.1, §10.2)', () => {
    const plan = blocked(planDelivery(policy({ caller: { edits: ['native'] } }), [
      edit('e1', 'The edit of `a.ts` line 1', no('Not inline.')),
      fileOperation('f', 'The creation of `b.md`', { manual: no('The review body would be too long.') }),
      edit('e2', 'The edit of `c.ts` line 4'),
      edit('e3', 'The edit of `d.ts` line 2', no('Blank lines only.')),
    ]));
    assert.deepEqual(plan.blocked, ['e1', 'f', 'e3']);
    assert.deepEqual(plan.diagnostics, [
      unavailableDiagnostic(
        'The edit of `a.ts` line 1 cannot be delivered. `edits` is `[native]`, set by the caller (`--edits`, `delivery.edits`), and no mechanism it lists is available:\n\n'
        + '- `native`: Not inline.',
      ),
      unavailableDiagnostic(
        'The creation of `b.md` cannot be delivered. `fileOperations` is `[manual]`, the default, and no mechanism it lists is available:\n\n'
        + '- `manual`: The review body would be too long.',
      ),
      unavailableDiagnostic(
        'The edit of `d.ts` line 2 cannot be delivered. `edits` is `[native]`, set by the caller (`--edits`, `delivery.edits`), and no mechanism it lists is available:\n\n'
        + '- `native`: Blank lines only.',
      ),
    ]);
  });

  test('a blocked plan carries no fallback warning: nothing is delivered (§10.1, D55)', () => {
    const plan = blocked(planDelivery(policy({ caller: { edits: ['native', 'review-body'] } }), [
      edit('e1', 'The edit of `a.ts` line 1', no('Not inline.')),
      fileOperation('f', 'The creation of `b.md`', { manual: no('Too long.') }),
    ]));
    assert.deepEqual(plan.diagnostics.map((d) => d.code), ['delivery-unavailable']);
  });

  test('a plan blocked by the companion limit carries no fallback warning either (§10.1)', () => {
    const units = Array.from({ length: 11 }, (_, i) => edit(`e${String(i)}`, `Edit ${String(i)}`, no('Not inline.')));
    const plan = blocked(planDelivery(policy({ caller: { edits: ['native', 'companion'] } }), units));
    assert.deepEqual(plan.diagnostics.map((d) => d.code), ['too-many-suggestion-prs']);
  });

  test('a mechanism reported unavailable without an obstacle is refused (§8.7)', () => {
    const unit: DeliveryUnit = {
      kind: 'edit',
      id: 'e',
      description: 'The edit',
      // @ts-expect-error -- a JavaScript caller can break §8.7's rule; the planner refuses it rather than report no reason
      availability: () => ({ available: false, obstacles: [] }),
    };
    assert.throws(() => planDelivery(policy(), [unit]), TypeError);
  });

  test('the blocked message lists every mechanism of a longer list, in order (§10.1)', () => {
    const plan = blocked(planDelivery(policy({ configuration: { fileOperations: ['companion', 'manual'] } }), [
      fileOperation('f', 'The deletion of `old.txt`', { companion: no('The pull request is from a fork.'), manual: no('Too long.', 'Really.') }),
    ]));
    assert.deepEqual(plan.diagnostics, [
      unavailableDiagnostic(
        'The deletion of `old.txt` cannot be delivered. `fileOperations` is `[companion, manual]`, set by `.github/sarif-to-comment.json` on the default branch (`delivery.fileOperations`), and no mechanism it lists is available:\n\n'
        + '- `companion`: The pull request is from a fork.\n'
        + '- `manual`: Too long. Really.',
      ),
    ]);
  });

  test('each source layer is named as §10.1\'s table says', () => {
    const unit = (): DeliveryUnit[] => [editGroup('g', 'The group `g`', [member('m')], { nativeBatch: no('X.'), companion: no('Y.'), manualGroup: no('Z.') })];
    const message = (p: IResolvedDeliveryPolicy): string => blocked(planDelivery(p, unit())).diagnostics[0]?.message ?? '';
    assert.match(message(policy({ caller: { groupedEdits: ['companion'] } })), /`groupedEdits` is `\[companion\]`, set by the caller \(`--grouped-edits`, `delivery\.groupedEdits`\), and/);
    assert.match(message(policy({ caller: { preset: 'companion' } })), /`groupedEdits` is `\[companion\]`, set by the caller's preset `companion` \(`--delivery`, `delivery\.preset`\), and/);
    assert.match(message(policy({ configuration: { groupedEdits: ['manual-group'] } })), /`groupedEdits` is `\[manual-group\]`, set by `\.github\/sarif-to-comment\.json` on the default branch \(`delivery\.groupedEdits`\), and/);
    assert.match(message(policy({ configuration: { preset: 'original-pr' } })), /`groupedEdits` is `\[native-batch, manual-group\]`, set by the preset `original-pr` in `\.github\/sarif-to-comment\.json` on the default branch, and/);
    assert.match(message(policy()), /`groupedEdits` is `\[native-batch\]`, the default, and/);
  });

  test('a fallback is one delivery-fallback warning naming the earlier mechanisms\' obstacles (§10.2)', () => {
    const plan = planned(planDelivery(policy({ caller: { groupedEdits: ['native-batch', 'manual-group', 'companion'] } }), [
      editGroup('g', 'The group `g`', [member('The edit of `a.md` line 1', no('Not inline.'))], { manualGroup: no('The review body would be too long.') }),
    ]));
    assert.deepEqual(plan.deliveries, [{ unitId: 'g', kind: 'edit-group', dimension: 'groupedEdits', mechanism: 'companion' }]);
    assert.deepEqual(plan.diagnostics, [
      fallbackDiagnostic(
        'The group `g` is delivered as `companion`. `groupedEdits` is `[native-batch, manual-group, companion]`, set by the caller (`--grouped-edits`, `delivery.groupedEdits`), and the mechanisms listed before it are unavailable:\n\n'
        + '- `native-batch`: The edit of `a.md` line 1: Not inline.\n'
        + '- `manual-group`: The review body would be too long.',
      ),
    ]);
  });

  test('the default edits list is strict: an edit that cannot be native is blocked, not moved (§5)', () => {
    const plan = blocked(planDelivery(policy(), [edit('e', 'The edit of `a.ts` line 7', no('The lines are not on the new side of the pull request\'s diff.'))]));
    assert.deepEqual(plan.diagnostics, [
      unavailableDiagnostic(
        'The edit of `a.ts` line 7 cannot be delivered. `edits` is `[native]`, the default, and no mechanism it lists is available:\n\n'
        + '- `native`: The lines are not on the new side of the pull request\'s diff.',
      ),
    ]);
  });

  test('a caller\'s review-body fallback for edits is announced (§10.2)', () => {
    const plan = planned(planDelivery(policy({ caller: { edits: ['native', 'review-body'] } }), [
      edit('e', 'The edit of `a.ts` line 7', no('The lines are not on the new side of the pull request\'s diff.')),
    ]));
    assert.deepEqual(plan.deliveries, [{ unitId: 'e', kind: 'edit', dimension: 'edits', mechanism: 'review-body' }]);
    assert.deepEqual(plan.diagnostics, [
      fallbackDiagnostic(
        'The edit of `a.ts` line 7 is delivered as `review-body`. `edits` is `[native, review-body]`, set by the caller (`--edits`, `delivery.edits`), and the mechanisms listed before it are unavailable:\n\n'
        + '- `native`: The lines are not on the new side of the pull request\'s diff.',
      ),
    ]);
  });

  test('an edit delivered by companion is in a companion pull request (§8.2)', () => {
    const plan = planned(planDelivery(policy({ caller: { edits: ['companion'] } }), [edit('e', 'The edit')]));
    assert.deepEqual(plan.deliveries, [{ unitId: 'e', kind: 'edit', dimension: 'edits', mechanism: 'companion' }]);
    assert.deepEqual(plan.companions, [{ sections: ['e'] }]);
  });

  test('the unit\'s location becomes the diagnostic\'s location', () => {
    const unit: DeliveryUnit = { kind: 'edit', id: 'e', description: 'The edit', location: { pointer: '/runs/0/results/3' }, availability: lookup({ native: no('X.'), 'review-body': no('Y.'), companion: no('Z.') }) };
    const [diagnostic] = blocked(planDelivery(policy(), [unit])).diagnostics;
    assert.deepEqual(diagnostic?.location, { pointer: '/runs/0/results/3' });
  });
});

// ---------------------------------------------------------------------------
// §14: the acceptance examples, each expectation written by hand
// ---------------------------------------------------------------------------

describe('acceptance examples (contract §14)', () => {
  test('D-A1 (D48): an explicit companion choice wins over a configured native batch', () => {
    const configuration = readDeliveryConfiguration(file('{"delivery":{"groupedEdits":["native-batch"]}}'));
    assert.equal(configuration.status, 'valid');
    const resolved = policy({ caller: { groupedEdits: ['companion'] }, configuration: configuration.layer });
    assert.deepEqual(resolved.groupedEdits, { value: ['companion'], source: 'caller' });
    const plan = planned(planDelivery(resolved, [editGroup('g', 'The group `g`', [member('a'), member('b')])]));
    assert.deepEqual(plan.deliveries, [{ unitId: 'g', kind: 'edit-group', dimension: 'groupedEdits', mechanism: 'companion' }]);
    assert.deepEqual(plan.diagnostics, []);
  });

  test('D-A2 (D48): presets follow the same precedence, and no preset sets companionBundle', () => {
    assert.deepEqual(policy({ caller: { preset: 'companion' }, configuration: { preset: 'original-pr', companionBundle: 'single' } }), {
      edits: { value: ['companion'], source: 'caller-preset', preset: 'companion' },
      groupedEdits: { value: ['companion'], source: 'caller-preset', preset: 'companion' },
      fileOperations: { value: ['companion'], source: 'caller-preset', preset: 'companion' },
      companionBundle: { value: 'single', source: 'configuration' },
    });
  });

  test('D-A3 (D48): no configuration and an explicit native choice resolve to native, strictly', () => {
    const resolved = policy({ caller: { edits: ['native'] } });
    assert.deepEqual(resolved.edits, { value: ['native'], source: 'caller' });
    assert.deepEqual(planned(planDelivery(resolved, [edit('e', 'The edit')])).deliveries, [{ unitId: 'e', kind: 'edit', dimension: 'edits', mechanism: 'native' }]);
    const plan = blocked(planDelivery(resolved, [edit('e', 'The edit of `a.ts` line 3', no('The lines are not on the new side of the pull request\'s diff.'))]));
    assert.deepEqual(plan.diagnostics, [
      unavailableDiagnostic(
        'The edit of `a.ts` line 3 cannot be delivered. `edits` is `[native]`, set by the caller (`--edits`, `delivery.edits`), and no mechanism it lists is available:\n\n'
        + '- `native`: The lines are not on the new side of the pull request\'s diff.',
      ),
    ]);
  });

  test('D-A4 (D48): nothing set resolves to the documented defaults, and no document gets a companion', () => {
    assert.deepEqual(policy(), {
      edits: { value: ['native'], source: 'default' },
      groupedEdits: { value: ['native-batch'], source: 'default' },
      fileOperations: { value: ['manual'], source: 'default' },
      companionBundle: { value: 'per-unit', source: 'default' },
    });
    const plan = planned(planDelivery(policy(), [
      edit('e', 'e'), editGroup('g', 'g', [member('a'), member('b')]), fileOperation('f', 'f'), fileOperationGroup('h', 'h'),
    ]));
    assert.deepEqual(plan.companions, []);
    // An edit that cannot be a native suggestion is blocked, as it is refused today.
    assert.deepEqual(blocked(planDelivery(policy(), [edit('x', 'The edit of `x.ts` line 1', no('Not inline.'))])).blocked, ['x']);
  });

  test('D-A5 (D49): a group of two eligible edits is one native batch on the original pull request', () => {
    const plan = planned(planDelivery(policy(), [editGroup('g', 'The group `g`', [member('The edit of `a.ts` line 1'), member('The edit of `b.ts` line 2')])]));
    assert.deepEqual(plan.deliveries, [{ unitId: 'g', kind: 'edit-group', dimension: 'groupedEdits', mechanism: 'native-batch' }]);
    assert.deepEqual(plan.diagnostics, []);
  });

  test('D-A6 (D49): one native and one companion is impossible', () => {
    const group = editGroup('g', 'The group `g`', [member('The edit of `a.ts` line 1'), member('The edit of `b.ts` line 40', no('The lines are not on the new side of the pull request\'s diff.'))]);
    const strict = blocked(planDelivery(policy(), [group]));
    assert.deepEqual(strict.diagnostics, [
      unavailableDiagnostic(
        'The group `g` cannot be delivered. `groupedEdits` is `[native-batch]`, the default, and no mechanism it lists is available:\n\n'
        + '- `native-batch`: The edit of `b.ts` line 40: The lines are not on the new side of the pull request\'s diff.',
      ),
    ]);
    const plan = planned(planDelivery(policy({ caller: { groupedEdits: ['native-batch', 'companion'] } }), [group]));
    assert.deepEqual(plan.deliveries, [{ unitId: 'g', kind: 'edit-group', dimension: 'groupedEdits', mechanism: 'companion' }]);
    assert.deepEqual(plan.companions, [{ sections: ['g'] }]);
    assert.deepEqual(plan.diagnostics, [
      fallbackDiagnostic(
        'The group `g` is delivered as `companion`. `groupedEdits` is `[native-batch, companion]`, set by the caller (`--grouped-edits`, `delivery.groupedEdits`), and the mechanisms listed before it are unavailable:\n\n'
        + '- `native-batch`: The edit of `b.ts` line 40: The lines are not on the new side of the pull request\'s diff.',
      ),
    ]);
  });

  test('D-A7 (D51): a helper file and two edits under companion are one companion; an unrelated edit stays native', () => {
    const plan = planned(planDelivery(policy({ caller: { fileOperations: ['companion'] } }), [
      fileOperationGroup('helper', 'The group `helper`'),
      edit('other', 'The edit of `unrelated.ts` line 5'),
    ]));
    assert.deepEqual(plan.deliveries, [
      { unitId: 'helper', kind: 'file-operation-group', dimension: 'fileOperations', mechanism: 'companion' },
      { unitId: 'other', kind: 'edit', dimension: 'edits', mechanism: 'native' },
    ]);
    assert.deepEqual(plan.companions, [{ sections: ['helper'] }]);
  });

  test('D-A8 (D51): the same group under the default manual setting is the mixed manual group, with no companion', () => {
    const plan = planned(planDelivery(policy(), [fileOperationGroup('helper', 'The group `helper`')]));
    assert.deepEqual(plan.deliveries, [{ unitId: 'helper', kind: 'file-operation-group', dimension: 'fileOperations', mechanism: 'manual' }]);
    assert.deepEqual(plan.companions, []);
  });

  test('D-A9 (D55): a strict companion request on a fork is blocked, naming the obstacle', () => {
    const plan = blocked(planDelivery(policy({ caller: { fileOperations: ['companion'] } }), [
      fileOperation('d', 'The deletion of `obsolete.txt`', { companion: no('The pull request\'s head branch is in a fork.') }),
    ]));
    assert.deepEqual(plan.blocked, ['d']);
    assert.deepEqual(plan.diagnostics, [
      unavailableDiagnostic(
        'The deletion of `obsolete.txt` cannot be delivered. `fileOperations` is `[companion]`, set by the caller (`--file-operations`, `delivery.fileOperations`), and no mechanism it lists is available:\n\n'
        + '- `companion`: The pull request\'s head branch is in a fork.',
      ),
    ]);
  });

  test('D-A10: a configured fallback from companion to manual is announced', () => {
    const plan = planned(planDelivery(policy({ configuration: { fileOperations: ['companion', 'manual'] } }), [
      fileOperation('c', 'The creation of `docs/guide.md`', { companion: no('The pull request merges into `release`, which is not the default branch.') }),
    ]));
    assert.deepEqual(plan.deliveries, [{ unitId: 'c', kind: 'file-operation', dimension: 'fileOperations', mechanism: 'manual' }]);
    assert.deepEqual(plan.diagnostics, [
      fallbackDiagnostic(
        'The creation of `docs/guide.md` is delivered as `manual`. `fileOperations` is `[companion, manual]`, set by `.github/sarif-to-comment.json` on the default branch (`delivery.fileOperations`), and the mechanisms listed before it are unavailable:\n\n'
        + '- `companion`: The pull request merges into `release`, which is not the default branch.',
      ),
    ]);
  });

  test('D-A11 (D49): the manual group only when listed, here by the original-pr preset', () => {
    const group = editGroup('g', 'The group `g`', [member('The edit of `a.ts` line 1', no('Not inline.')), member('The edit of `b.ts` line 2')]);
    blocked(planDelivery(policy(), [group]));
    const plan = planned(planDelivery(policy({ caller: { preset: 'original-pr' } }), [group]));
    assert.deepEqual(plan.deliveries, [{ unitId: 'g', kind: 'edit-group', dimension: 'groupedEdits', mechanism: 'manual-group' }]);
    assert.deepEqual(plan.diagnostics, [
      fallbackDiagnostic(
        'The group `g` is delivered as `manual-group`. `groupedEdits` is `[native-batch, manual-group]`, set by the caller\'s preset `original-pr` (`--delivery`, `delivery.preset`), and the mechanisms listed before it are unavailable:\n\n'
        + '- `native-batch`: The edit of `a.ts` line 1: Not inline.',
      ),
    ]);
  });

  test('D-A12 (D52): single bundles two groups and a creation into one companion; per-unit makes three', () => {
    const units = (): DeliveryUnit[] => [
      editGroup('g1', 'The group `one`', [member('a'), member('b')]),
      editGroup('g2', 'The group `two`', [member('c'), member('d')]),
      fileOperation('c', 'The creation of `new.md`'),
    ];
    assert.deepEqual(planned(planDelivery(policy({ caller: { preset: 'companion', companionBundle: 'single' } }), units())).companions, [{ sections: ['g1', 'g2', 'c'] }]);
    assert.deepEqual(planned(planDelivery(policy({ caller: { preset: 'companion' } }), units())).companions, [{ sections: ['g1'] }, { sections: ['g2'] }, { sections: ['c'] }]);
  });

  test('D-A13 (D53): alternatives are in no companion and no section', () => {
    const plan = planned(planDelivery(policy({ caller: { preset: 'companion', companionBundle: 'single' } }), [
      editGroup('g', 'The group `g`', [member('a'), member('b')]),
      alternative('alt-1', 'Alternative 1'),
      alternative('alt-2', 'Alternative 2'),
    ]));
    assert.deepEqual(plan.companions, [{ sections: ['g'] }]);
    assert.deepEqual(plan.alternatives, ['alt-1', 'alt-2']);
    assert.equal(plan.deliveries.some((d) => d.unitId.startsWith('alt')), false);
  });

  test('D-A14: within the caller layer, a specific list wins over the preset', () => {
    const resolved = policy({ caller: { preset: 'companion', fileOperations: ['companion', 'manual'] } });
    assert.deepEqual(resolved.fileOperations, { value: ['companion', 'manual'], source: 'caller' });
    assert.deepEqual(resolved.groupedEdits, { value: ['companion'], source: 'caller-preset', preset: 'companion' });
  });

  test('D-A15: within the configuration, a specific list wins over the preset', () => {
    const resolved = policy({ configuration: { preset: 'companion', groupedEdits: ['native-batch', 'companion'] } });
    assert.deepEqual(resolved.groupedEdits, { value: ['native-batch', 'companion'], source: 'configuration' });
    assert.deepEqual(resolved.fileOperations, { value: ['companion'], source: 'configuration-preset', preset: 'companion' });
  });

  test('D-A16: an invalid configuration blocks with every problem, in file order', () => {
    const read = readDeliveryConfiguration(file('{"delivery":{"edits":["native","native"],"bundle":"single"}}'));
    assert.deepEqual(read, {
      status: 'invalid',
      branch: 'main',
      problems: [
        { pointer: '/delivery/edits/1', detail: 'repeats `native`' },
        { pointer: '/delivery/bundle', detail: 'is not a known setting' },
      ],
    });
    if (read.status !== 'invalid') return;
    assert.deepEqual(deliveryConfigurationDiagnostics(read), [
      configurationDiagnostic('`.github/sarif-to-comment.json` on the default branch `main` cannot be used: `/delivery/edits/1` repeats `native`.'),
      configurationDiagnostic('`.github/sarif-to-comment.json` on the default branch `main` cannot be used: `/delivery/bundle` is not a known setting.'),
    ]);
  });

  test('D-A17: an empty caller list is invalid before anything is read (the usage error and TypeError are the surface\'s)', () => {
    assert.deepEqual(validateDeliveryPolicyLayer({ fileOperations: [] }), {
      status: 'invalid',
      problems: [{ pointer: '/fileOperations', detail: 'must list at least one mechanism' }],
    });
  });

  test('D-A18 (D48): every proposed change, ungrouped edits included, goes to companions', () => {
    const plan = planned(planDelivery(policy({ caller: { preset: 'companion', companionBundle: 'single' } }), [
      edit('e', 'The edit of `a.ts` line 1'),
      editGroup('g', 'The group `g`', [member('m1'), member('m2')]),
      fileOperation('d', 'The deletion of `old.txt`'),
    ]));
    assert.deepEqual(plan.deliveries, [
      { unitId: 'e', kind: 'edit', dimension: 'edits', mechanism: 'companion' },
      { unitId: 'g', kind: 'edit-group', dimension: 'groupedEdits', mechanism: 'companion' },
      { unitId: 'd', kind: 'file-operation', dimension: 'fileOperations', mechanism: 'companion' },
    ]);
    assert.deepEqual(plan.companions, [{ sections: ['e', 'g', 'd'] }]);
    assert.deepEqual(plan.diagnostics, []);
  });

  test('D-A19: the limit blocks per-unit companions, naming the single bundle; single delivers them', () => {
    const units = Array.from({ length: 11 }, (_, i) => edit(`e${String(i)}`, `Edit ${String(i)}`));
    const over = blocked(planDelivery(policy({ caller: { preset: 'companion' } }), units));
    assert.deepEqual(over.blocked, []);
    assert.deepEqual(over.diagnostics, [tooManyDiagnostic(11)]);
    const bundled = planned(planDelivery(policy({ caller: { preset: 'companion', companionBundle: 'single' } }), units));
    assert.deepEqual(bundled.companions, [{ sections: units.map((u) => u.id) }]);
  });

  test('D-A20: companion options without a planned companion are a note naming them', () => {
    const plan = planned(planDelivery(policy(), [edit('e', 'The edit')], { pullRequestLabels: ['team-a'], markSuggestionPullRequestsReady: true }));
    assert.deepEqual(plan.deliveries, [{ unitId: 'e', kind: 'edit', dimension: 'edits', mechanism: 'native' }]);
    assert.deepEqual(plan.diagnostics, [
      optionsUnusedDiagnostic('No companion pull request is planned, so these options have no effect: `--pr-labels` (`pullRequestLabels`), `--mark-suggestion-prs-ready` (`markSuggestionPullRequestsReady`).'),
    ]);
    const companions = planned(planDelivery(policy({ caller: { preset: 'companion' } }), [edit('e', 'The edit')], { pullRequestLabels: ['team-a'], markSuggestionPullRequestsReady: true }));
    assert.deepEqual(companions.diagnostics, []);
  });

  test('D-A21: the configuration is read only when the caller leaves a setting undecided', () => {
    assert.equal(deliveryConfigurationNeeded({ preset: 'companion', companionBundle: 'per-unit' }), false);
    assert.equal(deliveryConfigurationNeeded({ preset: 'companion' }), true);
    assert.equal(deliveryConfigurationNeeded({ preset: 'original-pr' }), true);
    assert.equal(deliveryConfigurationNeeded({ edits: ['native'] }), true);
  });
});

describe('the companion limit (contract §9)', () => {
  const edits = (n: number): DeliveryUnit[] => Array.from({ length: n }, (_, i) => edit(`e${String(i)}`, `Edit ${String(i)}`));

  test('exactly 10 companions are planned', () => {
    assert.equal(planned(planDelivery(policy({ caller: { edits: ['companion'] } }), edits(10))).companions.length, 10);
  });

  test('the limit is reported after every unavailable unit, and counts only delivered units', () => {
    const units = [...edits(11), fileOperation('f', 'The creation of `a.md`', { manual: no('Too long.') })];
    const plan = blocked(planDelivery(policy({ caller: { edits: ['companion'] } }), units));
    assert.deepEqual(plan.blocked, ['f']);
    assert.deepEqual(plan.diagnostics.map((d) => d.code), ['delivery-unavailable', 'too-many-suggestion-prs']);
    assert.deepEqual(plan.diagnostics[1], tooManyDiagnostic(11));
  });

  test('alternatives and non-companion deliveries do not count', () => {
    const plan = planned(planDelivery(policy({ caller: { edits: ['companion', 'native'] } }), [
      ...edits(10),
      edit('n', 'Native', OK, OK, no('No companion for this one.')),
      alternative('a', 'Alternative'),
    ]));
    assert.equal(plan.companions.length, 10);
  });
});

describe('the companion-options-unused note (contract §12)', () => {
  const native = (): DeliveryUnit[] => [edit('e', 'The edit')];
  const LABELS = 'No companion pull request is planned, so these options have no effect: `--pr-labels` (`pullRequestLabels`).';

  test('one option alone is named alone', () => {
    assert.deepEqual(planned(planDelivery(policy(), native(), { pullRequestLabels: ['a', 'b'] })).diagnostics, [optionsUnusedDiagnostic(LABELS)]);
    assert.deepEqual(planned(planDelivery(policy(), native(), { markSuggestionPullRequestsReady: true })).diagnostics, [
      optionsUnusedDiagnostic('No companion pull request is planned, so these options have no effect: `--mark-suggestion-prs-ready` (`markSuggestionPullRequestsReady`).'),
    ]);
  });

  test('options without an effect are not named: no labels, or ready false', () => {
    assert.deepEqual(planned(planDelivery(policy(), native(), { pullRequestLabels: [], markSuggestionPullRequestsReady: false })).diagnostics, []);
    assert.deepEqual(planned(planDelivery(policy(), native(), {})).diagnostics, []);
  });

  test('the note comes after the warnings', () => {
    const plan = planned(planDelivery(policy({ caller: { edits: ['native', 'review-body'] } }), [edit('e', 'The edit', no('X.'))], { pullRequestLabels: ['a'] }));
    assert.deepEqual(plan.diagnostics.map((d) => d.code), ['delivery-fallback', 'companion-options-unused']);
  });

  test('a blocked plan carries no note', () => {
    const plan = blocked(planDelivery(policy(), [edit('e', 'The edit', no('X.'))], { pullRequestLabels: ['a'] }));
    assert.deepEqual(plan.diagnostics.map((d) => d.code), ['delivery-unavailable']);
  });
});

// ---------------------------------------------------------------------------
// Properties of §4, §8, §9 and §10 over generated policies and units
// ---------------------------------------------------------------------------

/** A small deterministic generator (mulberry32), so every run checks the same cases. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error('pick from an empty list');
  return value;
}

/** A non-empty ordered list of distinct values drawn from `vocabulary`. */
function list<T>(random: () => number, vocabulary: readonly T[]): T[] {
  const shuffled = [...vocabulary].sort(() => random() - 0.5);
  return shuffled.slice(0, 1 + Math.floor(random() * shuffled.length));
}

function availability(random: () => number, n: number): MechanismAvailability {
  return random() < 0.6 ? OK : no(`Obstacle ${String(n)}.`);
}

function generatedLayer(random: () => number): IDeliveryPolicyLayer {
  return {
    ...(random() < 0.3 ? { preset: pick(random, DELIVERY_PRESETS) } : {}),
    ...(random() < 0.4 ? { edits: list(random, DELIVERY_MECHANISMS.edits) } : {}),
    ...(random() < 0.4 ? { groupedEdits: list(random, DELIVERY_MECHANISMS.groupedEdits) } : {}),
    ...(random() < 0.4 ? { fileOperations: list(random, DELIVERY_MECHANISMS.fileOperations) } : {}),
    ...(random() < 0.3 ? { companionBundle: pick(random, COMPANION_BUNDLES) } : {}),
  };
}

function generatedUnits(random: () => number): DeliveryUnit[] {
  const units: DeliveryUnit[] = [];
  const count = Math.floor(random() * 7);
  for (let i = 0; i < count; i += 1) {
    const id = `u${String(i)}`;
    const kind = pick(random, ['edit', 'edit-group', 'file-operation', 'file-operation-group', 'alternative'] as const);
    switch (kind) {
      case 'edit':
        units.push(edit(id, `Unit ${id}`, availability(random, 1), availability(random, 2), availability(random, 9)));
        break;
      case 'edit-group': {
        const members = Array.from({ length: 2 + Math.floor(random() * 3) }, (_, m) => member(`Member ${String(m)}`, availability(random, 10 + m)));
        units.push(editGroup(id, `Unit ${id}`, members, { nativeBatch: random() < 0.9 ? OK : no('Group obstacle.'), companion: availability(random, 3), manualGroup: availability(random, 4) }));
        break;
      }
      case 'file-operation':
        units.push(fileOperation(id, `Unit ${id}`, { manual: availability(random, 5), companion: availability(random, 6) }));
        break;
      case 'file-operation-group':
        units.push(fileOperationGroup(id, `Unit ${id}`, { manual: availability(random, 7), companion: availability(random, 8) }));
        break;
      case 'alternative':
        units.push(alternative(id, `Unit ${id}`));
        break;
    }
  }
  return units;
}

/** The dimension governing a unit (§2), or undefined for an alternative. */
function dimensionOf(unit: DeliveryUnit): 'edits' | 'groupedEdits' | 'fileOperations' | undefined {
  switch (unit.kind) {
    case 'edit': return 'edits';
    case 'edit-group': return 'groupedEdits';
    case 'file-operation':
    case 'file-operation-group': return 'fileOperations';
    case 'alternative': return undefined;
  }
}

function isOneOf<T extends string>(value: string, vocabulary: readonly T[]): value is T {
  return vocabulary.some((entry) => entry === value);
}

/** Whether `mechanism` can deliver `unit`, by §8.3 and §8.7: native-batch needs the group and every member. */
function canDeliver(unit: DeliveryUnit, mechanism: string): boolean {
  switch (unit.kind) {
    case 'edit':
      return isOneOf(mechanism, DELIVERY_MECHANISMS.edits) && unit.availability(mechanism).available;
    case 'edit-group':
      if (mechanism === 'native-batch') return unit.availability('native-batch').available && unit.members.every((m) => m.native().available);
      return isOneOf(mechanism, DELIVERY_MECHANISMS.groupedEdits) && unit.availability(mechanism).available;
    case 'file-operation':
    case 'file-operation-group':
      return isOneOf(mechanism, DELIVERY_MECHANISMS.fileOperations) && unit.availability(mechanism).available;
    case 'alternative':
      return false;
  }
}

describe('properties over generated policies and units (contract §4, §8, §9, §10)', () => {
  const random = seeded(20260930);
  const cases = Array.from({ length: 600 }, () => {
    const resolved = policy({ caller: generatedLayer(random), configuration: generatedLayer(random) });
    return { resolved, units: generatedUnits(random) };
  });

  test('the generated cases cover planned and blocked plans, fallbacks, companions and strict lists', () => {
    const plans = cases.map(({ resolved, units }) => planDelivery(resolved, units));
    assert.ok(plans.filter((p) => p.status === 'planned').length > 100);
    assert.ok(plans.filter((p) => p.status === 'blocked').length > 100);
    assert.ok(plans.some((p) => p.diagnostics.some((d) => d.code === 'delivery-fallback')));
    assert.ok(plans.some((p) => p.status === 'planned' && p.companions.length > 1));
  });

  test('a unit is blocked exactly when no mechanism of its list can deliver it (§10.1)', () => {
    for (const { resolved, units } of cases) {
      const plan = planDelivery(resolved, units);
      const expected = units.filter((u) => {
        const dimension = dimensionOf(u);
        return dimension !== undefined && !resolved[dimension].value.some((m) => canDeliver(u, m));
      }).map((u) => u.id);
      if (expected.length === 0) {
        assert.equal(plan.status, 'planned');
      } else {
        assert.deepEqual(blocked(plan).blocked, expected);
        assert.equal(plan.diagnostics.filter((d) => d.code === 'delivery-unavailable').length, expected.length);
      }
    }
  });

  test('every unit has exactly one destination, the first available mechanism of its list; a strict list never substitutes (§4, §8.1)', () => {
    for (const { resolved, units } of cases) {
      const plan = planDelivery(resolved, units);
      if (plan.status !== 'planned') continue;
      const delivered = units.filter((u) => u.kind !== 'alternative');
      assert.deepEqual(plan.deliveries.map((d) => d.unitId), delivered.map((u) => u.id), 'one delivery per unit, in order');
      for (const delivery of plan.deliveries) {
        const unit = units.find((u) => u.id === delivery.unitId);
        assert.ok(unit);
        const dimension = dimensionOf(unit);
        assert.equal(delivery.dimension, dimension);
        if (dimension === undefined) continue;
        const listed: readonly string[] = resolved[dimension].value;
        assert.ok(listed.includes(delivery.mechanism), 'only a listed mechanism is used');
        assert.equal(delivery.mechanism, listed.find((m) => canDeliver(unit, m)), 'the first available one');
        if (listed.length === 1) assert.equal(delivery.mechanism, listed[0], 'a strict list never substitutes');
      }
    }
  });

  test('a group never has more than one destination, and native-batch only with every member eligible (§8.1, §8.3)', () => {
    for (const { resolved, units } of cases) {
      const plan = planDelivery(resolved, units);
      if (plan.status !== 'planned') continue;
      for (const unit of units) {
        if (unit.kind !== 'edit-group' && unit.kind !== 'file-operation-group') continue;
        const destinations: readonly UnitDelivery[] = plan.deliveries.filter((d) => d.unitId === unit.id);
        assert.equal(destinations.length, 1);
        const mechanism: string | undefined = destinations[0]?.mechanism;
        const inCompanions: number = plan.companions.flatMap((c) => c.sections).filter((s) => s === unit.id).length;
        assert.equal(inCompanions, mechanism === 'companion' ? 1 : 0, 'a group is in one companion section or none');
        if (unit.kind === 'edit-group' && mechanism === 'native-batch') {
          assert.ok(unit.members.every((m) => m.native().available), 'no partial native batch');
        }
      }
    }
  });

  test('every fallback is announced, once, and nothing else is (§10.2)', () => {
    for (const { resolved, units } of cases) {
      const plan = planDelivery(resolved, units);
      const fallbacks = plan.diagnostics.filter((d) => d.code === 'delivery-fallback');
      // A blocked plan delivers nothing, so it announces no fallback (§10.1).
      const expected = plan.status === 'blocked' ? [] : units.filter((u) => {
        const dimension = dimensionOf(u);
        if (dimension === undefined) return false;
        const used = resolved[dimension].value.find((m) => canDeliver(u, m));
        return used !== undefined && used !== resolved[dimension].value[0];
      });
      assert.equal(fallbacks.length, expected.length);
      expected.forEach((unit, i) => {
        assert.ok(fallbacks[i]?.message.startsWith(`${unit.description} is delivered as `));
      });
    }
  });

  test('availability is asked only for listed mechanisms, in order, at most once, never after the first available (§8.7)', () => {
    for (const { resolved, units } of cases) {
      const asked = new Map<string, string[]>();
      const record = (id: string, what: string): void => {
        asked.set(id, [...(asked.get(id) ?? []), what]);
      };
      const spied = units.map((unit): DeliveryUnit => {
        switch (unit.kind) {
          case 'edit':
            return { ...unit, availability: (m: EditMechanism) => { record(unit.id, m); return unit.availability(m); } };
          case 'edit-group':
            return {
              ...unit,
              availability: (m: GroupedEditMechanism) => { record(unit.id, m); return unit.availability(m); },
              members: unit.members.map((m, i) => ({ ...m, native: () => { record(unit.id, `member ${String(i)}`); return m.native(); } })),
            };
          case 'file-operation':
          case 'file-operation-group':
            return { ...unit, availability: (m: FileOperationMechanism) => { record(unit.id, m); return unit.availability(m); } };
          case 'alternative':
            return unit;
        }
      });
      planDelivery(resolved, spied);
      for (const unit of units) {
        const dimension = dimensionOf(unit);
        const calls = asked.get(unit.id) ?? [];
        if (dimension === undefined) {
          assert.deepEqual(calls, []);
          continue;
        }
        const listed: readonly string[] = resolved[dimension].value;
        const first = listed.findIndex((m) => canDeliver(unit, m));
        const expected = first === -1 ? listed : listed.slice(0, first + 1);
        assert.deepEqual(calls.filter((c) => !c.startsWith('member ')), expected, unit.id);
        const members = calls.filter((c) => c.startsWith('member '));
        if (unit.kind === 'edit-group' && expected.includes('native-batch')) {
          assert.deepEqual([...members].sort(), unit.members.map((_, i) => `member ${String(i)}`).sort(), 'each member once');
        } else {
          assert.deepEqual(members, [], 'members only for native-batch');
        }
      }
    }
  });

  test('companions hold exactly the companion-delivered units, bundled as companionBundle says, and never an alternative (§8.6, §9)', () => {
    for (const { resolved, units } of cases) {
      const plan = planDelivery(resolved, units);
      if (plan.status !== 'planned') continue;
      const companionUnits = plan.deliveries.filter((d) => d.mechanism === 'companion').map((d) => d.unitId);
      const sections = plan.companions.flatMap((c) => c.sections);
      assert.deepEqual(sections, companionUnits);
      if (resolved.companionBundle.value === 'single') assert.equal(plan.companions.length, companionUnits.length === 0 ? 0 : 1);
      else assert.equal(plan.companions.length, companionUnits.length);
      assert.deepEqual(plan.alternatives, units.filter((u) => u.kind === 'alternative').map((u) => u.id));
      for (const id of plan.alternatives) assert.equal(sections.includes(id), false);
    }
  });

  test('diagnostics are ordered errors, then warnings', () => {
    for (const { resolved, units } of cases) {
      const severities = planDelivery(resolved, units).diagnostics.map((d) => d.severity);
      assert.deepEqual(severities, [...severities].sort((a, b) => (a === b ? 0 : a === 'error' ? -1 : 1)));
    }
  });
});

describe('the recorded form of a resolved policy is checked when it is read back (§13)', () => {
  const recorded = (): Record<string, unknown> => ({ ...asRecord(parseJson(JSON.stringify(resolveDeliveryPolicy({
    caller: { preset: 'companion', fileOperations: ['companion', 'manual'] },
    configuration: { companionBundle: 'single' },
  })))) });

  test('every resolution, as JSON, is a valid record, in the §13 order', () => {
    for (const inputs of [{}, { caller: { preset: 'original-pr' as const } }, { configuration: { preset: 'companion' as const, edits: ['native' as const] } }]) {
      const value: unknown = JSON.parse(JSON.stringify(resolveDeliveryPolicy(inputs)));
      assert.equal(deliveryRecordProblem(value), null);
      assert.equal(isResolvedDeliveryPolicy(value), true);
    }
    assert.equal(deliveryRecordProblem(recorded()), null);
  });

  const broken: readonly (readonly [string, (r: Record<string, unknown>) => unknown, string])[] = [
    ['not an object', () => [], 'the delivery policy is not an object'],
    ['a missing setting', (r) => ({ edits: r['edits'], groupedEdits: r['groupedEdits'], fileOperations: r['fileOperations'] }), 'the delivery policy does not hold exactly its four settings, in order'],
    ['settings out of order', (r) => ({ groupedEdits: r['groupedEdits'], edits: r['edits'], fileOperations: r['fileOperations'], companionBundle: r['companionBundle'] }),
      'the delivery policy does not hold exactly its four settings, in order'],
    ['an unknown source', (r) => ({ ...r, edits: { value: ['native'], source: 'environment' } }), 'the delivery policy\'s edits has an unknown source'],
    ['a preset layer without its preset', (r) => ({ ...r, edits: { value: ['companion'], source: 'caller-preset' } }), 'the delivery policy\'s edits does not hold exactly its fields'],
    ['a preset on a specific layer', (r) => ({ ...r, edits: { value: ['native'], source: 'caller', preset: 'companion' } }), 'the delivery policy\'s edits does not hold exactly its fields'],
    ['an unknown preset', (r) => ({ ...r, edits: { value: ['companion'], source: 'caller-preset', preset: 'all' } }), 'the delivery policy\'s edits names an unknown preset'],
    ['a mechanism of another dimension', (r) => ({ ...r, edits: { value: ['native-batch'], source: 'caller' } }), 'the delivery policy\'s edits is not a list of its mechanisms'],
    ['an empty list', (r) => ({ ...r, fileOperations: { value: [], source: 'caller' } }), 'the delivery policy\'s fileOperations is not a list of its mechanisms'],
    ['a repeated mechanism', (r) => ({ ...r, groupedEdits: { value: ['companion', 'companion'], source: 'caller' } }), 'the delivery policy\'s groupedEdits is not a list of its mechanisms'],
    ['a bundle list', (r) => ({ ...r, companionBundle: { value: ['single'], source: 'configuration' } }), 'the delivery policy\'s companionBundle is not a bundle setting'],
  ];
  for (const [name, change, problem] of broken) {
    test(`refused: ${name}`, () => {
      const value = change(recorded());
      assert.equal(deliveryRecordProblem(value), problem);
      assert.equal(isResolvedDeliveryPolicy(value), false);
    });
  }
});

describe('an obstacle\'s remedy travels with it into the diagnostic (§8.7, §8.9, §10.1, §10.2)', () => {
  /** An unavailable mechanism whose obstacles come with remedies. */
  const fixable = (obstacles: [string, ...string[]], remedies: readonly string[]): MechanismAvailability => ({ available: false, obstacles, remedies });

  test('a blocked unit: the obstacles\' remedies, in obstacle order, each once, then the catalogued remedies', () => {
    const plan = planDelivery(policy({ caller: { edits: ['native', 'review-body', 'companion'] } }), [
      edit('e', 'The edit of `a.md` line 1', fixable(['Not inline.'], ['Remove the fix.']), no('Not yet.'), fixable(['Too big.', 'Rewritten.'], ['Reduce it.', 'Remove the fix.', 'Review again.'])),
    ]);
    assert.equal(plan.status, 'blocked');
    const [blocked] = plan.diagnostics;
    assert.deepEqual(blocked?.remedies, ['Remove the fix.', 'Reduce it.', 'Review again.', ...UNAVAILABLE.remedies]);
  });

  test('without any obstacle remedy, the catalogued remedies alone', () => {
    const plan = planDelivery(policy(), [edit('e', 'The edit of `a.md` line 1', no('Not inline.'))]);
    assert.deepEqual(plan.diagnostics[0]?.remedies, UNAVAILABLE.remedies);
  });

  test('an announced fallback: the earlier mechanisms\' remedies, then the catalogued remedies', () => {
    const plan = planDelivery(policy({ caller: { fileOperations: ['companion', 'manual'] } }), [
      fileOperation('f', 'The creation of `a.md`', { companion: fixable(['Too big.'], ['Reduce it.']) }),
    ]);
    assert.equal(plan.status, 'planned');
    assert.deepEqual(plan.diagnostics[0]?.remedies, ['Reduce it.', ...FALLBACK.remedies]);
  });

  test('a native batch: the group\'s own remedies, then each ineligible member\'s, in order', () => {
    const plan = planDelivery(policy(), [
      editGroup('g', 'The group `g`', [
        member('The edit of `a.md` line 1', fixable(['Fence.'], ['Change the replacement.'])),
        member('The edit of `b.md` line 2', fixable(['Not inline.'], ['Remove the fix.'])),
        member('The edit of `c.md` line 3', fixable(['CR.'], ['Change the replacement.'])),
      ], { nativeBatch: fixable(['Not head.'], ['Review the head.']) }),
    ]);
    assert.deepEqual(plan.diagnostics[0]?.remedies, ['Review the head.', 'Change the replacement.', 'Remove the fix.', ...UNAVAILABLE.remedies]);
  });
});
