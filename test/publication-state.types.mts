/**
 * Compile-time checks of the type a parsed publication state record narrows
 * to (src/publication.cts). This file is type-checked by
 * `pnpm run check:types` and never executed.
 *
 * State validation keeps 0.2.0's handling of historical files: a JSON array
 * whose string form names a phase (['sending'], [['completed']]) is accepted,
 * and only a string phase selects the receipt or rejection branch. The parsed
 * type must therefore admit those array forms, and code may reach receipt or
 * rejection data only through the same strict string comparison the runtime
 * uses; narrowing by excluding the other phase names must not reach it, since
 * a record with an array phase passes every such exclusion.
 *
 * Each `@ts-expect-error` below fails the check if the declared type becomes
 * narrower than what validation accepts.
 */
import type { ParsedStateRecord } from '../dist/publication.cjs';

/** True exactly when `Value` is assignable to the parsed record's phase. */
type PhaseAdmits<Value> = [Value] extends [ParsedStateRecord['phase']] ? true : false;

/** Array forms whose string coercion names a phase are admitted, like the string phases. */
export const admitsCoercedPhases: readonly true[] = [
  true satisfies PhaseAdmits<'sending'>,
  true satisfies PhaseAdmits<'completed'>,
  true satisfies PhaseAdmits<'rejected'>,
  true satisfies PhaseAdmits<readonly ['sending']>,
  true satisfies PhaseAdmits<readonly ['completed']>,
  true satisfies PhaseAdmits<readonly ['rejected']>,
  true satisfies PhaseAdmits<readonly [readonly ['completed']]>,
];

/** Forms validation refuses are not admitted. */
export const refusesOtherPhases: readonly false[] = [
  false satisfies PhaseAdmits<'mystery'>,
  false satisfies PhaseAdmits<readonly ['mystery']>,
  false satisfies PhaseAdmits<readonly ['sending', 'sending']>,
  false satisfies PhaseAdmits<readonly []>,
  false satisfies PhaseAdmits<number>,
];

/** The receipt is reachable after the runtime's strict string comparison. */
export function receiptAfterStrictCheck(record: ParsedStateRecord): number | undefined {
  if (record.phase === 'completed') return record.receipt.reviewId;
  return undefined;
}

/** The refusal is reachable after the runtime's strict string comparison. */
export function rejectionAfterStrictCheck(record: ParsedStateRecord): number | undefined {
  if (record.phase === 'rejected') return record.rejection.status;
  return undefined;
}

/** Excluding the other phase names does not validate a receipt. */
export function receiptByExclusion(record: ParsedStateRecord): unknown {
  if (record.phase !== 'sending' && record.phase !== 'rejected') {
    // @ts-expect-error -- a record whose phase is ['completed'] passes both exclusions with an unvalidated receipt
    return record.receipt.reviewId;
  }
  return undefined;
}

/** Excluding the other phase names does not validate a refusal. */
export function rejectionByExclusion(record: ParsedStateRecord): unknown {
  if (record.phase !== 'sending' && record.phase !== 'completed') {
    // @ts-expect-error -- a record whose phase is ['rejected'] passes both exclusions with an unvalidated refusal
    return record.rejection.status;
  }
  return undefined;
}

/** What remains after the receipt and refusal branches is not necessarily a string 'sending' intent. */
export function remainderIsNotOnlySending(record: ParsedStateRecord): unknown {
  if (record.phase !== 'completed' && record.phase !== 'rejected') {
    // @ts-expect-error -- array-valued phases of every name reach the investigation branch
    const phase: 'sending' = record.phase;
    return phase;
  }
  return undefined;
}

/** Without any phase check, neither a receipt nor a refusal is reachable. */
export function noUncheckedAccess(record: ParsedStateRecord): readonly unknown[] {
  return [
    // @ts-expect-error -- only a 'completed' record is known to hold a receipt
    record.receipt,
    // @ts-expect-error -- only a 'rejected' record is known to hold a refusal
    record.rejection,
  ];
}
