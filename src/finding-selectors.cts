/**
 * Finding selectors (private internal module).
 *
 * A selector names one finding of one specific document, so that a
 * destructive edit can refuse to act on a document that has changed since
 * the caller looked at it. Inspection produces selectors; removal checks
 * them. Contract: docs/finding-removal-contract.md §2.
 *
 * A selector is `<ref>@<digest>`: the finding's JSON Pointer
 * (`/runs/i/results/j`) and a digest of the whole document. The digest is
 * taken over the parsed JSON with object keys sorted, so formatting and key
 * order do not matter but any change of value does. Binding to the whole
 * document, not just the finding, is deliberate: identical findings are
 * common, and after one of them is removed another identical one can occupy
 * its old position. A selector therefore goes stale on every change, and the
 * caller inspects again.
 *
 * Boundaries: no persistent identity is written into SARIF, and callers treat
 * selectors as opaque; only this module knows the digest's derivation.
 */

import * as crypto from 'node:crypto';

import { canonicalJson } from './sarif-common.cjs';
import type { JsonValue } from './sarif-common.cjs';

/** Hexadecimal characters kept from the SHA-256 digest: 64 bits, ample to tell accidental edits apart. */
const DIGEST_LENGTH = 16;

/** `<ref>@<digest>` with canonical (no leading zero) run and result indexes. */
const SELECTOR_PATTERN = /^\/runs\/(0|[1-9][0-9]*)\/results\/(0|[1-9][0-9]*)@([0-9a-f]{16})$/;

/** A selector taken apart: the finding's position and the digest of the document it was taken from. */
export interface IParsedSelector {
  /** The finding's JSON Pointer, `/runs/i/results/j`. */
  readonly ref: string;
  /** Index of the finding's run. */
  readonly runIndex: number;
  /** Index of the finding in its run's results. */
  readonly resultIndex: number;
  /** Digest of the whole document the selector was taken from. */
  readonly digest: string;
}

/**
 * The digest of a captured document, as embedded in its selectors.
 *
 * @param captured - the document as captureJson returned it
 */
export function documentDigest(captured: JsonValue): string {
  return crypto.createHash('sha256').update(canonicalJson(captured)).digest('hex').slice(0, DIGEST_LENGTH);
}

/** The selector of the finding at `ref` in the document with `digest`. */
export function findingSelector(ref: string, digest: string): string {
  return `${ref}@${digest}`;
}

/**
 * A selector taken apart, or null when `value` is not a string of the
 * selector form (a bare pointer, a message or anything else a caller might
 * guess).
 */
export function parseFindingSelector(value: unknown): IParsedSelector | null {
  if (typeof value !== 'string') return null;
  const match = SELECTOR_PATTERN.exec(value);
  const [, run, result, digest] = match ?? [];
  if (run === undefined || result === undefined || digest === undefined) return null;
  const runIndex = Number(run);
  const resultIndex = Number(result);
  if (!Number.isSafeInteger(runIndex) || !Number.isSafeInteger(resultIndex)) return null;
  return { ref: `/runs/${run}/results/${result}`, runIndex, resultIndex, digest };
}
