/**
 * The warnings list of an outcome report (private internal module; D45,
 * D60; docs/diagnostics.md "Warnings on every call for a publication").
 *
 * Preparation, assessment and publication explain themselves to the caller
 * in Markdown: the library's `markdown` and the CLI's JSON and TOON
 * `message`. Those reports list diagnostics one per line — code, pointer into
 * the SARIF document when there is one, and message — and a report with
 * warnings ends with them under `**Warnings:**`. A publication reports the
 * same list on its first call and on every later call for its state path
 * (issue #42). This is report presentation for the caller, never part of the
 * review posted to GitHub, and it is not customizable.
 *
 * Rendering:
 *
 *   line     = "- " code span of code [ " at " code span of pointer ] ": " message
 *   warnings = "**Warnings:**\n\n" lines joined by "\n"
 */

import type { IDiagnostic } from '../diagnostics.cjs';
import { codeSpan } from './markdown.cjs';

/** One diagnostic as a report lists it. */
export function renderDiagnosticLine(diagnostic: IDiagnostic): string {
  const pointer = diagnostic.location?.pointer;
  return `- ${codeSpan(diagnostic.code)}${pointer === undefined ? '' : ` at ${codeSpan(pointer)}`}: ${diagnostic.message}`;
}

/** Warnings as the list a report ends with, under `**Warnings:**`. */
export function renderWarningsList(warnings: readonly IDiagnostic[]): string {
  return `**Warnings:**\n\n${warnings.map(renderDiagnosticLine).join('\n')}`;
}
