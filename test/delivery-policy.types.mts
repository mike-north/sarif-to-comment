/**
 * Compile-time checks of the delivery policy's types
 * (docs/delivery-policy-contract.md §3, §8.7). This file is type-checked by
 * `pnpm run check:types` and never executed.
 *
 * Each dimension's list holds only its own vocabulary, an unavailable
 * mechanism always carries at least one obstacle, and every unit states the
 * availability of every mechanism of the dimension that governs it.
 */
import type { DeliveryUnit, IDeliveryPolicyLayer, MechanismAvailability } from '../dist/delivery-policy.cjs';

export const layer: IDeliveryPolicyLayer = {
  preset: 'original-pr',
  edits: ['native', 'review-body'],
  groupedEdits: ['native-batch', 'companion', 'manual-group'],
  fileOperations: ['manual', 'companion'],
  companionBundle: 'single',
};

export const editsCompanion: IDeliveryPolicyLayer = { edits: ['companion'] };
// @ts-expect-error -- `manual` belongs to fileOperations, not edits (§3)
export const editsManual: IDeliveryPolicyLayer = { edits: ['manual'] };
// @ts-expect-error -- `manual-group` belongs to groupedEdits, not fileOperations (§3)
export const fileManualGroup: IDeliveryPolicyLayer = { fileOperations: ['manual-group'] };
// @ts-expect-error -- companionBundle is a single value, not a list (§4)
export const bundleList: IDeliveryPolicyLayer = { companionBundle: ['single'] };
// @ts-expect-error -- presets are original-pr and companion (§6)
export const nativePreset: IDeliveryPolicyLayer = { preset: 'native' };

export const unavailable: MechanismAvailability = { available: false, obstacles: ['The pull request is from a fork.'] };
// @ts-expect-error -- an unavailable mechanism names at least one obstacle (§8.7)
export const unexplained: MechanismAvailability = { available: false, obstacles: [] };

export const fileOperation: DeliveryUnit = {
  kind: 'file-operation',
  id: 'f',
  description: 'The creation of `a.md`',
  availability: { manual: { available: true }, companion: unavailable },
};
// @ts-expect-error -- an edit states every edits mechanism's availability, companion included (§3)
export const editWithoutCompanion: DeliveryUnit = { kind: 'edit', id: 'e', description: 'e', availability: { native: unavailable, 'review-body': unavailable } };
// @ts-expect-error -- an edit group states every groupedEdits mechanism's availability
export const partialGroup: DeliveryUnit = { kind: 'edit-group', id: 'g', description: 'g', members: [], availability: { companion: unavailable } };
