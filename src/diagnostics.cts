/**
 * Structured diagnostics (docs/diagnostics.md, D45): the one constructor
 * every module uses to report an error, warning or note, the problem shape
 * `problems` arrays carry, and the order outcomes list diagnostics in.
 *
 * A diagnostic's severity, title and default remedies come from its code's
 * catalog entry (src/diagnostic-catalog.cts), so they cannot drift between
 * modules; a caller supplies only the message and what the diagnostic is
 * about. Rendering is elsewhere: Markdown stays with each operation, and the
 * terminal view is src/diagnostic-rendering.cts.
 */

import { DIAGNOSTIC_CATALOG } from './diagnostic-catalog.cjs';
import type { DiagnosticCode } from './diagnostic-catalog.cjs';
import type { DiagnosticSeverity, IDiagnostic, IDiagnosticLocation, IProblem } from './public-types.cjs';

export type { DiagnosticCode } from './diagnostic-catalog.cjs';
export type { DiagnosticSeverity, IDiagnostic, IDiagnosticLocation, IProblem } from './public-types.cjs';

/** A location as a caller gives it: any field may be undefined, meaning absent. */
export interface ILocationInput {
  readonly pointer?: string | undefined;
  readonly path?: string | undefined;
  readonly startLine?: number | undefined;
  readonly endLine?: number | undefined;
}

/** What a diagnostic is about, and remedies that replace the catalog's when a case needs its own. */
export interface IDiagnosticDetails {
  readonly location?: ILocationInput | undefined;
  readonly subject?: string | undefined;
  readonly remedies?: readonly string[] | undefined;
}

/** A location without its absent fields, or undefined when no field is present. */
function locationOf(input: ILocationInput | undefined): IDiagnosticLocation | undefined {
  if (input === undefined) return undefined;
  const location: IDiagnosticLocation = {
    ...(input.pointer === undefined ? {} : { pointer: input.pointer }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
    ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
  };
  return Object.keys(location).length === 0 ? undefined : location;
}

/**
 * A diagnostic of `code` with `message` (Markdown), in the model's key
 * order: severity, code, title, message, then location, subject and remedies
 * when present.
 */
export function createDiagnostic(code: DiagnosticCode, message: string, details: IDiagnosticDetails = {}): IDiagnostic {
  const entry = DIAGNOSTIC_CATALOG[code];
  const location = locationOf(details.location);
  const remedies = details.remedies ?? entry.remedies;
  return {
    severity: entry.severity,
    code,
    title: entry.title,
    message,
    ...(location === undefined ? {} : { location }),
    ...(details.subject === undefined ? {} : { subject: details.subject }),
    ...(remedies.length === 0 ? {} : { remedies: [...remedies] }),
  };
}

/** The flat fields a problem has always carried, in the order the reporting site writes them. */
export type LegacyProblemFields = Readonly<{ message: string; pointer?: string | undefined; path?: string | undefined }>;

/**
 * A problem of `code`: exactly the flat fields the reporting site gives, in
 * its order (as 0.2.x reported them), followed by the diagnostic fields
 * except the message, which is already there. The location is the flat
 * pointer and path unless `details` gives one.
 */
export function createProblem(code: DiagnosticCode, fields: LegacyProblemFields, details: IDiagnosticDetails = {}): IProblem {
  // Spreading the diagnostic after the flat fields keeps their positions
  // (the message is the same value) and appends the diagnostic's own fields.
  return { ...fields, ...createDiagnostic(code, fields.message, { location: { pointer: fields.pointer, path: fields.path }, ...details }) };
}

/** A problem for a diagnostic: its message and flat pointer and path, then the diagnostic fields. */
export function problemOfDiagnostic(diagnostic: IDiagnostic): IProblem {
  const { message, location } = diagnostic;
  const fields: LegacyProblemFields = {
    message,
    ...(location?.pointer === undefined ? {} : { pointer: location.pointer }),
    ...(location?.path === undefined ? {} : { path: location.path }),
  };
  return { ...fields, ...diagnostic };
}

/** The diagnostic a problem (or any diagnostic with extra fields) carries, in the model's key order and without the extra fields. */
export function diagnosticOf(value: IDiagnostic): IDiagnostic {
  return {
    severity: value.severity,
    code: value.code,
    title: value.title,
    message: value.message,
    ...(value.location === undefined ? {} : { location: value.location }),
    ...(value.subject === undefined ? {} : { subject: value.subject }),
    ...(value.remedies === undefined ? {} : { remedies: value.remedies }),
  };
}

/** Rank of each severity in an outcome's list. */
const RANK: Readonly<Record<DiagnosticSeverity, number>> = { error: 0, warning: 1, note: 2 };

/**
 * `diagnostics` ordered errors, then warnings, then notes, each severity in
 * the order found (a stable sort of a copy; the input is not changed).
 */
export function orderDiagnostics<T extends IDiagnostic>(diagnostics: readonly T[]): T[] {
  return [...diagnostics].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** A diagnostic with `replace` applied to its message and remedies (used to redact a credential). */
export function mapDiagnosticText<T extends IDiagnostic>(diagnostic: T, replace: (text: string) => string): T {
  return {
    ...diagnostic,
    message: replace(diagnostic.message),
    ...(diagnostic.remedies === undefined ? {} : { remedies: diagnostic.remedies.map(replace) }),
  };
}
