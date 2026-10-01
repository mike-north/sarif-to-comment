/**
 * Shared, pure SARIF interpretation for authoring, inspection and staged
 * incorporation (private internal module).
 *
 * Authoring (`sarif-authoring.cjs`), inspection (`sarif-inspection.cjs`) and
 * staged extraction all read SARIF the same way the shipped publisher does.
 * This module is that one shared reading: capture, schema validation,
 * repository paths and URIs, repository identity, rule and message
 * resolution.
 *
 * Boundaries:
 * - It performs no I/O and holds no state, and never mutates its arguments.
 * - It reproduces the publisher's semantics (`src/index.cts` capture;
 *   `src/prepare-review.cts` schema, URI, identity and message rules) without
 *   importing or changing the publisher. The publisher is out of this
 *   increment's scope.
 * - Equivalence is enforced by behavioural parity tests in
 *   `test/sarif-common.test.mts`, run against the unchanged publisher.
 *   Change both sides together.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type AjvDraft04Module = require('ajv-draft-04');
import type AjvFormatsModule = require('ajv-formats');
import type { ErrorObject, SchemaObject, ValidateFunction } from 'ajv';

import { createProblem, diagnosticOf } from './diagnostics.cjs';
import type { IDiagnostic, IProblem } from './diagnostics.cjs';
import { GITHUB_HOST } from './github-urls.cjs';

/**
 * The vendored SARIF 2.1.0 schema. JSON data, so it is `unknown` until
 * {@link isSchemaObject} confirms it is the object ajv compiles.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the vendored JSON schema is data outside the compiled program; require() resolves it one directory above the compiled module, exactly as before
const SARIF_SCHEMA: unknown = require('../vendor/sarif-schema-2.1.0.json');

// ---------------------------------------------------------------------------
// Domain types

/** A JSON scalar: what JSON represents besides arrays and objects. */
export type JsonPrimitive = string | number | boolean | null;

/**
 * A value restricted to what JSON represents faithfully, as {@link captureJson}
 * produces it: plain objects, dense arrays, strings, finite numbers (never -0),
 * booleans and null.
 */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | IJsonObject;

/** A plain JSON object with enumerable, string-keyed data properties. */
export interface IJsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * An object whose prototype is `Object.prototype` or null (see
 * {@link isPlainObject}). Its string-keyed properties are not yet examined, so
 * each reads as `unknown`.
 */
export interface IPlainObject {
  readonly [key: string]: unknown;
}

/** A GitHub repository named by owner and repository name. */
export interface IRepositoryIdentity {
  /** Account or organization that owns the repository. */
  readonly owner: string;
  /** Repository name. */
  readonly repo: string;
}

/** One schema violation found by {@link validateSarif}: a `sarif-schema-invalid` problem. */
export interface ISchemaProblem extends IProblem {
  /** What is wrong, as Markdown. */
  readonly message: string;
  /** JSON Pointer of the offending value; '' is the document root. */
  readonly pointer: string;
}

/**
 * The contract's refusal of a document that does not conform to the SARIF
 * 2.1.0 schema (contract §1.4). Nothing in it was interpreted.
 */
export interface ISarifSchemaRefusal {
  /** Discriminant: the SARIF input was refused. */
  readonly status: 'invalid';
  /** One problem per distinct schema error. */
  readonly problems: readonly ISchemaProblem[];
  /** The same problems as a Markdown explanation. */
  readonly markdown: string;
  /** The same problems as diagnostics. */
  readonly diagnostics: readonly IDiagnostic[];
}

// The SARIF types below describe only the parts of a schema-valid SARIF
// 2.1.0 document this module reads. They are views, not a SARIF model: every
// other property is simply not described, and optional properties follow the
// schema's optionality.

/** SARIF artifactLocation (3.4): a URI reference, a base id, or an artifact index. */
export interface ISarifArtifactLocation {
  readonly uri?: string;
  readonly uriBaseId?: string;
  readonly index?: number;
}

/** SARIF artifact (3.24), as read for index lookups. */
export interface ISarifArtifact {
  readonly location?: ISarifArtifactLocation;
  readonly parentIndex?: number;
}

/** SARIF versionControlDetails (3.23), as read for repository roots. */
export interface ISarifVersionControlDetails {
  readonly repositoryUri: string;
  readonly mappedTo?: ISarifArtifactLocation;
}

/** SARIF multiformatMessageString (3.12): a message template. */
export interface ISarifMultiformatMessageString {
  readonly text?: string;
  readonly markdown?: string;
}

/** SARIF message (3.11): direct text/markdown, or a message string id, with arguments. */
export interface ISarifMessage {
  readonly text?: string;
  readonly markdown?: string;
  readonly id?: string;
  readonly arguments?: readonly string[];
}

/** SARIF reportingDescriptor (3.49), as read for rules. */
export interface ISarifReportingDescriptor {
  readonly id: string;
  readonly messageStrings?: Readonly<Record<string, ISarifMultiformatMessageString>>;
}

/** SARIF toolComponent (3.19): the driver or an extension. */
export interface ISarifToolComponent {
  readonly name: string;
  readonly guid?: string;
  readonly rules?: readonly ISarifReportingDescriptor[];
  readonly globalMessageStrings?: Readonly<Record<string, ISarifMultiformatMessageString>>;
}

/** SARIF tool (3.18). */
export interface ISarifTool {
  readonly driver: ISarifToolComponent;
  readonly extensions?: readonly ISarifToolComponent[];
}

/** SARIF toolComponentReference (3.54). */
export interface ISarifToolComponentReference {
  readonly index?: number;
  readonly guid?: string;
  readonly name?: string;
}

/** SARIF reportingDescriptorReference (3.52), as `result.rule`. */
export interface ISarifReportingDescriptorReference {
  readonly id?: string;
  readonly index?: number;
  readonly toolComponent?: ISarifToolComponentReference;
}

/** SARIF result (3.27), as read for rule resolution. */
export interface ISarifResult {
  readonly ruleId?: string;
  readonly ruleIndex?: number;
  readonly rule?: ISarifReportingDescriptorReference;
}

/** SARIF run (3.14), as read for locations, rules and messages. */
export interface ISarifRun {
  readonly tool: ISarifTool;
  readonly artifacts?: readonly ISarifArtifact[];
  readonly originalUriBaseIds?: Readonly<Record<string, ISarifArtifactLocation>>;
  readonly versionControlProvenance?: readonly ISarifVersionControlDetails[];
}

/** Why an artifact location could not be resolved to a repository path. */
export type ArtifactPathErrorCode =
  | 'artifact-index-invalid'
  | 'nested-artifact-unsupported'
  | 'artifact-index-conflict'
  | 'uri-invalid'
  | 'uri-traversal'
  | 'uri-encoded-separator'
  | 'uri-scheme-unsupported'
  | 'uri-base-invalid'
  | 'uri-base-unresolved'
  | 'uri-outside-repository';

/** Why a result's rule or tool component could not be resolved. */
export type RuleErrorCode = 'rule-component-unresolved' | 'rule-reference-conflict' | 'rule-reference-invalid';

/** A failed resolution: `error` is `[code, message]`, the message a sentence. */
export interface IResolutionFailure<Code extends string> {
  readonly error: readonly [code: Code, message: string];
}

/**
 * A parsed URI reference: decoded path segments under `root`, which is
 * "file:" for an absolute file: URI or "base:ID" for an abstract named base.
 * `error` is never present; it lets `if (x.error)` separate outcomes.
 */
export interface IRootedReference {
  readonly error?: never;
  readonly root: string;
  readonly segments: readonly string[];
}

/**
 * A parsed relative reference. `root` is an own property whose value is
 * undefined (not an omitted key).
 */
export interface IRelativeReference {
  readonly error?: never;
  readonly root: undefined;
  readonly segments: readonly string[];
}

/** The outcome of parsing a URI reference or a base URI. */
export type ParsedReference = IRootedReference | IRelativeReference | IResolutionFailure<ArtifactPathErrorCode>;

/** A resolved or unresolved base: a rooted location, or why there is none. */
type ResolvedBase = IRootedReference | IResolutionFailure<ArtifactPathErrorCode>;

/** The effective reference an artifact-path outcome describes, after any index lookup. */
export interface IEffectiveReference {
  readonly uri?: string;
  readonly uriBaseId?: string;
}

/** A location resolved to a normalized repository-relative path. */
export interface IResolvedArtifactPath extends IEffectiveReference {
  readonly error?: never;
  readonly path: string;
}

/** A location that names no repository path, and why. */
export interface IUnresolvedArtifactPath extends IEffectiveReference, IResolutionFailure<ArtifactPathErrorCode> {}

/** The outcome of {@link resolveArtifactPath}. */
export type ArtifactPathResolution = IResolvedArtifactPath | IUnresolvedArtifactPath;

/** Options of {@link resolveArtifactPath}: the known repository roots. */
export interface IArtifactPathOptions {
  /** The producer's source root; a value that is not a base URI names no root. */
  readonly sourceRootUri?: unknown;
  /** The destination repository; without it, every provenance root counts. */
  readonly repository?: IRepositoryIdentity | undefined;
}

/** A result's rule (when it names one) and the tool component that defines it. */
export interface IResolvedRule {
  readonly error?: never;
  readonly rule?: ISarifReportingDescriptor;
  readonly component: ISarifToolComponent;
}

/** The outcome of {@link resolveRule}. */
export type RuleResolution = IResolvedRule | IResolutionFailure<RuleErrorCode>;

/**
 * A message's content as data (see {@link resolveMessage}). `id` is an own
 * property whenever the message was looked up by id, even when its value is
 * undefined.
 */
export interface IResolvedMessage {
  readonly id?: string | undefined;
  readonly text?: string;
  readonly markdown?: string;
  /** False when the id is unknown or an argument is missing. */
  readonly resolved: boolean;
  /** The first placeholder number with no argument. */
  readonly missingArgument?: number;
}

/** The outcome of placeholder substitution in one template. */
interface ISubstitution {
  readonly text: string;
  readonly missing?: number;
}

// ---------------------------------------------------------------------------
// Constants

/** A full, canonical Git object name; abbreviations are never prefix-matched. */
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** GitHub account names: alphanumerics and single interior hyphens. */
export const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** GitHub repository names: letters, digits, '.', '_' and '-' (never '.' or '..'). */
export const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Nesting bound for captured JSON, so hostile depth fails as input, not a stack overflow. */
const MAX_JSON_DEPTH = 512;

/** Control and invisible formatting characters a suggestion group name may not contain (the publisher's rule). */
const INVISIBLE_IN_GROUP = /[\u0000-\u001F\u007F-\u009F\uFEFF\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/;

/** A UTF-16 surrogate without its pair: not valid Unicode text. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Longest suggestion group name, in UTF-16 code units. */
const MAX_GROUP_NAME = 100;

// ---------------------------------------------------------------------------
// Capture

export function isPlainObject(value: unknown): value is IPlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function refused(message: string): TypeError {
  return new TypeError(`Invalid input: ${message}`);
}

/** An own data property's value, refusing accessors (whose getters are never run). */
function dataValue(object: object, key: string, where: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw refused(`${where} is an accessor property; only plain JSON data is accepted`);
  return descriptor.value;
}

/**
 * A deep copy of `value`, restricted to what JSON represents faithfully:
 * - plain objects with enumerable string-keyed data properties;
 * - dense arrays;
 * - strings, finite numbers (not -0), booleans and null.
 *
 * Anything else is refused with a TypeError naming the offending path under
 * `label`, never dropped or coerced: cycles, accessors (whose getters never
 * run), symbols, undefined, functions, BigInt, class instances and holes.
 *
 * Taken synchronously, before any await, a capture fixes what an operation
 * sees. Later changes to the caller's value cannot alter it, and the result
 * shares no objects with the input. This is the publisher's capture
 * discipline (`src/index.cts`), with a neutral message prefix.
 */
export function captureJson(value: unknown, label: string, ancestors: Set<object> = new Set(), depth = 0): JsonValue {
  const where = label;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw refused(`${where} is not a finite JSON number`);
    return value;
  }
  if (typeof value !== 'object') throw refused(`${where} is a ${typeof value}, which JSON cannot represent`);
  if (depth > MAX_JSON_DEPTH) throw refused(`${where} is nested more than ${String(MAX_JSON_DEPTH)} levels deep`);
  if (ancestors.has(value)) throw refused(`${where} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw refused(`${where} is not a plain array`);
      const keys = Reflect.ownKeys(value);
      const length = dataValue(value, 'length', `${where}.length`);
      // An array's own `length` is always a number; the typeof test only
      // lets the comparison below be typed.
      if (typeof length !== 'number' || keys.length !== length + 1) throw refused(`${where} has holes or extra properties`);
      const copy = new Array<JsonValue>(length);
      for (let i = 0; i < length; i += 1) {
        if (!Object.hasOwn(value, i)) throw refused(`${where}[${String(i)}] is a hole`);
        copy[i] = captureJson(dataValue(value, String(i), `${where}[${String(i)}]`), `${where}[${String(i)}]`, ancestors, depth + 1);
      }
      return copy;
    }
    if (!isPlainObject(value)) throw refused(`${where} is not a plain JSON object`);
    const copy: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') throw refused(`${where} has a symbol-keyed property`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      // A key reported by Reflect.ownKeys always has a descriptor.
      if (!descriptor?.enumerable) throw refused(`${where}.${key} is not enumerable`);
      const item = captureJson(dataValue(value, key, `${where}.${key}`), `${where}.${key}`, ancestors, depth + 1);
      Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

// ---------------------------------------------------------------------------
// Schema validation

/**
 * A CommonJS module as `require()` returns it when the package exposes its
 * main value directly and also as `default`: either may be the one to use.
 */
type CommonJsModule<T> = T & { readonly default?: T };

/** The ajv-draft-04 constructor. */
type AjvDraft04 = typeof AjvDraft04Module.default;

/** The ajv-formats plugin. */
type AddFormats = typeof AjvFormatsModule.default;

/** Whether the vendored schema is an object, the only kind of schema ajv compiles here. */
function isSchemaObject(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

let schemaValidator: ValidateFunction | undefined;

/**
 * The compiled official SARIF 2.1.0 errata01 schema (draft-04), with string
 * formats enforced and every error reported. This is the publisher's
 * configuration.
 */
function sarifValidator(): ValidateFunction {
  if (!schemaValidator) {
    // ajv loads lazily, on the first validation, so modules that never
    // validate never pay its cost. Only its types are imported statically.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- require() is untyped; ajv-draft-04's CommonJS export is the Ajv class, also exposed as `default` (the declarations imported type-only above)
    const AjvDraft04: CommonJsModule<AjvDraft04> = require('ajv-draft-04');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- require() is untyped; ajv-formats' CommonJS export is the formats plugin, also exposed as `default` (the declarations imported type-only above)
    const formats: CommonJsModule<AddFormats> = require('ajv-formats');
    const Ajv = AjvDraft04.default || AjvDraft04;
    const addFormats = formats.default || formats;
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    if (!isSchemaObject(SARIF_SCHEMA)) throw new TypeError('The vendored SARIF schema is not a JSON object.');
    schemaValidator = ajv.compile(SARIF_SCHEMA);
  }
  return schemaValidator;
}

/** A Markdown code span that stays literal whatever backticks the text holds. */
function codeSpan(text: string): string {
  let fence = '`';
  while (text.includes(fence)) fence += '`';
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * The parts of an ajv error this module reads. `params` is read defensively,
 * as if it could be absent. `additionalProperty` is the name of the property
 * an `additionalProperties` error refuses: ajv's own declarations
 * (`AdditionalPropertiesError`) type it as a string, and no other error
 * reports it.
 */
interface IAjvErrorView {
  readonly instancePath: string;
  readonly message?: string;
  readonly params?: { readonly additionalProperty?: string } | undefined;
}

/** An ajv error as {@link IAjvErrorView}: the same object, viewed through the fields read here. */
function errorView(error: ErrorObject): IAjvErrorView {
  return error;
}

/**
 * Structural validation of a captured SARIF value.
 *
 * Returns null when the value conforms to the schema. Otherwise returns the
 * contract's refusal, `{ status: 'invalid', problems, markdown }`:
 * - one problem per schema error, `{ message, pointer }`;
 * - `pointer` is the JSON Pointer of the offending value ('' is the document
 *   root);
 * - `message` is Markdown.
 *
 * Structure is checked before any interpretation. An invalid document is
 * never read best-effort (contract §1.4).
 */
export function validateSarif(captured: unknown): ISarifSchemaRefusal | null {
  const validate = sarifValidator();
  if (validate(captured)) return null;
  const seen = new Set<string>();
  const problems: ISchemaProblem[] = [];
  for (const error of (validate.errors || []).map(errorView)) {
    const pointer = error.instancePath || '';
    const detail = error.params && error.params.additionalProperty !== undefined
      ? `${String(error.message)} (${codeSpan(error.params.additionalProperty)})` : error.message;
    const message = `${pointer === '' ? 'The document' : codeSpan(pointer)} ${String(detail)}.`;
    if (seen.has(message)) continue;
    seen.add(message);
    problems.push({ ...createProblem('sarif-schema-invalid', { message, pointer }), pointer });
  }
  const markdown = `**Invalid SARIF:** the document does not conform to the SARIF 2.1.0 schema, so it was not interpreted.\n\n${
    problems.map((p) => `- ${p.message}`).join('\n')}`;
  return { status: 'invalid', problems, markdown, diagnostics: problems.map(diagnosticOf) };
}

// ---------------------------------------------------------------------------
// Repository paths, identity and version

/**
 * Whether `value` is a normalized repository-relative path. That means:
 * - `/`-separated, with no leading slash;
 * - no empty, `.` or `..` segment;
 * - no backslash and no NUL.
 *
 * Spaces and non-ASCII characters are ordinary path characters.
 */
export function isNormalizedRepositoryPath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * The SARIF `artifactLocation.uri` for a normalized repository path. Each
 * segment is percent-encoded as UTF-8 (RFC 3986), so reserved characters such
 * as `#`, `?`, `%` and a leading `c:` cannot change the reference's meaning.
 * The publisher's decoder recovers exactly the original path.
 */
export function encodeRepositoryPath(repositoryPath: string): string {
  return repositoryPath.split('/').map(encodeURIComponent).join('/');
}

/**
 * Whether a provenance `repositoryUri` names the GitHub repository
 * `{ owner, repo }`. Matching is case-insensitive. Accepted forms are the
 * https, http, ssh and git URIs, with an optional `.git` suffix. These are the
 * publisher's identity rules.
 */
export function namesRepository(uri: string, { owner, repo }: IRepositoryIdentity): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || url.hostname.toLowerCase() !== GITHUB_HOST) return false;
  const parts = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  return parts.length === 2 && parts[0]?.toLowerCase() === owner.toLowerCase() && parts[1]?.toLowerCase() === repo.toLowerCase();
}

/**
 * Whether `value` can name a suggestion group
 * (`properties.sarifToComment.suggestionGroup`): 1-100 UTF-16 code units of
 * valid Unicode, with no control or invisible formatting character and no
 * leading or trailing whitespace, so the name can be shown exactly in a pull
 * request title (docs/companion-suggestion-pr-contract.md §2.3). Publication
 * and grouping both use this one rule.
 */
export function isSuggestionGroupName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_GROUP_NAME && !INVISIBLE_IN_GROUP.test(value)
    && !LONE_SURROGATE.test(value) && !/^\s|\s$/.test(value);
}

/**
 * JSON text of `value` with every object's keys in sorted order, so equal
 * values have equal text whatever their key order or formatting.
 *
 * @param value - a captured JSON value
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const members = Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
  return `{${members.join(',')}}`;
}

/**
 * This package's version, read from package.json at runtime so attribution
 * never drifts from the installed release.
 *
 * The manifest is the package's own, one directory above this module, and
 * always has a string version; anything else is a broken installation.
 */
export function packageVersion(): string {
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  if (!isPlainObject(manifest) || typeof manifest['version'] !== 'string') {
    throw new TypeError('This package\'s package.json has no version.');
  }
  return manifest['version'];
}

// ---------------------------------------------------------------------------
// Artifact locations and URIs (RFC 3986 references; SARIF 3.4, 3.10, 3.14.14)

/**
 * Resolves an artifactLocation (directly, or through `run.artifacts` by
 * index) to a normalized repository-relative path. This is the publisher's
 * rule set, applied to one run.
 *
 * Returns on success `{ path, uri, uriBaseId? }`; on failure
 * `{ error: [code, message], uri?, uriBaseId? }`. `uri` and `uriBaseId`
 * describe the effective reference, after any index lookup.
 *
 * Accepted references:
 * - relative references;
 * - uriBaseId chains through `originalUriBaseIds`;
 * - absolute file: URIs, but only under a known repository root.
 *
 * Known repository roots:
 * - `options.sourceRootUri`, when given;
 * - provenance `mappedTo` locations. With `options.repository` given, only
 *   entries naming that repository count (the publisher's rule). Without it
 *   (inspection has no destination), every declared entry counts.
 *
 * Failure codes: artifact-index-invalid, nested-artifact-unsupported,
 * artifact-index-conflict, uri-invalid, uri-traversal, uri-encoded-separator,
 * uri-scheme-unsupported, uri-base-invalid, uri-base-unresolved,
 * uri-outside-repository.
 *
 * Interpretation only: nothing a URI names is ever read.
 */
export function resolveArtifactPath(
  artifactLocation: ISarifArtifactLocation,
  run: ISarifRun,
  options: IArtifactPathOptions = {},
): ArtifactPathResolution {
  let effective = artifactLocation;
  if (artifactLocation.index !== undefined) {
    const artifact = (run.artifacts || [])[artifactLocation.index];
    if (!artifact || !artifact.location) {
      return describe(artifactLocation, { error: ['artifact-index-invalid', `Artifact index ${String(artifactLocation.index)} names no artifact location.`] });
    }
    if (artifact.parentIndex !== undefined) {
      return describe(artifact.location, { error: ['nested-artifact-unsupported', 'Artifacts nested inside other artifacts are not supported.'] });
    }
    if (artifactLocation.uri !== undefined && (artifactLocation.uri !== artifact.location.uri
      || artifactLocation.uriBaseId !== artifact.location.uriBaseId)) {
      return describe(artifactLocation, { error: ['artifact-index-conflict',
        `The location names ${JSON.stringify(artifactLocation.uri)} but artifact ${String(artifactLocation.index)} is ${JSON.stringify(artifact.location.uri)}.`] });
    }
    effective = artifact.location;
  }
  if (typeof effective.uri !== 'string') return describe(effective, { error: ['uri-invalid', 'The artifact location has no URI.'] });

  const reference = parseReference(effective.uri);
  if (reference.error) return describe(effective, reference);
  let located: IRootedReference;
  if (reference.root !== undefined) {
    located = reference;
  } else if (effective.uriBaseId !== undefined) {
    const base = resolveBase(effective.uriBaseId, run, new Set());
    if (base.error) return describe(effective, base);
    located = { root: base.root, segments: [...base.segments, ...reference.segments] };
  } else {
    return describe(effective, finishPath(reference.segments));
  }
  for (const root of repositoryRoots(run, options)) {
    if (root.root === located.root && root.segments.every((s, i) => located.segments[i] === s)) {
      return describe(effective, finishPath(located.segments.slice(root.segments.length)));
    }
  }
  return describe(effective, located.root.startsWith('base:')
    ? { error: ['uri-base-unresolved', `URI base ${located.root.slice(5)} is not a known repository root.`] }
    : { error: ['uri-outside-repository', `${effective.uri} is not inside a known repository root.`] });
}

/** A path outcome before the effective reference is attached. */
type PathOutcome = { readonly path: string } | IResolutionFailure<ArtifactPathErrorCode>;

/**
 * Attaches the effective reference to a resolution outcome.
 *
 * The outcome's own keys come first, then `uri` (only when it is a string),
 * then `uriBaseId` (only when present); absent ones are omitted, not
 * undefined.
 */
function describe(reference: ISarifArtifactLocation, outcome: PathOutcome): ArtifactPathResolution {
  return {
    ...outcome,
    ...(typeof reference.uri === 'string' ? { uri: reference.uri } : {}),
    ...(reference.uriBaseId !== undefined ? { uriBaseId: reference.uriBaseId } : {}),
  };
}

/** The repository roots a run's locations may resolve under (see resolveArtifactPath). */
function repositoryRoots(
  run: ISarifRun,
  { sourceRootUri, repository }: IArtifactPathOptions = {},
): (IRootedReference | IRelativeReference)[] {
  // A relative source root is kept, as before; its undefined root matches no location.
  const roots: (IRootedReference | IRelativeReference)[] = [];
  if (sourceRootUri !== undefined) {
    const root = parseBaseUri(sourceRootUri);
    if (!root.error) roots.push(root);
  }
  for (const entry of run.versionControlProvenance || []) {
    if (entry.mappedTo === undefined) continue;
    if (repository && !namesRepository(entry.repositoryUri, repository)) continue;
    const root = resolveBaseLocation(entry.mappedTo, run);
    if (!root.error) roots.push(root);
  }
  return roots;
}

function finishPath(segments: readonly string[]): PathOutcome {
  if (segments.length === 0) return { error: ['uri-invalid', 'The URI names the repository root, not a file.'] };
  return { path: segments.join('/') };
}

/**
 * Resolves a uriBaseId to `{ root, segments }`.
 * - A base with no URI value is an abstract named root ("base:ID"). It is
 *   meaningful only when provenance maps it to the repository.
 * - Chains are followed. Cycles and invalid bases are errors.
 */
function resolveBase(id: string, run: ISarifRun, visited: Set<string>): ResolvedBase {
  if (visited.has(id)) return { error: ['uri-base-unresolved', `URI base ${id} refers to itself in a cycle.`] };
  visited.add(id);
  const entry = (run.originalUriBaseIds || {})[id];
  if (!entry || entry.uri === undefined) {
    if (entry && entry.uriBaseId !== undefined) return resolveBase(entry.uriBaseId, run, visited);
    return { root: `base:${id}`, segments: [] };
  }
  const base = parseBaseUri(entry.uri);
  if (base.error) return base;
  if (base.root !== undefined) return base;
  if (entry.uriBaseId === undefined) {
    return { error: ['uri-base-invalid', `URI base ${id} is relative but names no base of its own.`] };
  }
  const parent = resolveBase(entry.uriBaseId, run, visited);
  if (parent.error) return parent;
  return { root: parent.root, segments: [...parent.segments, ...base.segments] };
}

/** Resolves a provenance mappedTo artifactLocation to a repository root. */
function resolveBaseLocation(location: ISarifArtifactLocation, run: ISarifRun): ResolvedBase {
  if (location.uri === undefined) {
    return location.uriBaseId === undefined
      ? { error: ['uri-invalid', 'mappedTo names neither a URI nor a URI base.'] }
      : resolveBase(location.uriBaseId, run, new Set());
  }
  const base = parseBaseUri(location.uri);
  if (base.error || base.root !== undefined) return base;
  if (location.uriBaseId === undefined) return { error: ['uri-base-invalid', 'A relative mappedTo URI needs a URI base.'] };
  const parent = resolveBase(location.uriBaseId, run, new Set());
  if (parent.error) return parent;
  return { root: parent.root, segments: [...parent.segments, ...base.segments] };
}

/** Parses a base URI, which must end in "/". */
export function parseBaseUri(uri: unknown): ParsedReference {
  if (typeof uri !== 'string' || !uri.endsWith('/')) {
    return { error: ['uri-base-invalid', `Base URI ${JSON.stringify(uri)} must end with "/".`] };
  }
  return parseReference(uri.slice(0, -1) || '.', { base: true });
}

/**
 * Parses a URI reference into decoded path segments.
 * - Relative references have an undefined root.
 * - Absolute file: URIs have root "file:".
 *
 * These are errors: other schemes, queries, fragments, absolute-path
 * references, empty or dot segments, encoded separators and invalid
 * percent-encoding.
 */
function parseReference(uri: string, { base = false }: { readonly base?: boolean } = {}): ParsedReference {
  if (uri === '') return { error: ['uri-invalid', 'The URI is empty.'] };
  if (/[\\\u0000-\u001f\u007f]/.test(uri)) return { error: ['uri-invalid', `${JSON.stringify(uri)} contains a backslash or control character.`] };
  if (/[?#]/.test(uri)) return { error: ['uri-invalid', `${JSON.stringify(uri)} has a query or fragment.`] };
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri);
  let root: string | undefined;
  let rest = uri;
  if (scheme) {
    const [prefix, name] = scheme;
    if (name?.toLowerCase() !== 'file') {
      return { error: ['uri-scheme-unsupported', `URI scheme ${String(name)} is not supported; only repository paths and file: URIs are.`] };
    }
    const hierarchical = uri.slice(prefix.length);
    if (!hierarchical.startsWith('//')) return { error: ['uri-invalid', `${uri} is not a hierarchical file: URI.`] };
    const slash = hierarchical.indexOf('/', 2);
    const authority = slash === -1 ? hierarchical.slice(2) : hierarchical.slice(2, slash);
    if (authority !== '' && authority.toLowerCase() !== 'localhost') {
      return { error: ['uri-invalid', `file: URI authority ${authority} is not supported.`] };
    }
    root = 'file:';
    rest = slash === -1 ? '' : hierarchical.slice(slash + 1);
    if (rest === '') return { root, segments: [] };
  } else if (uri.startsWith('/')) {
    return { error: ['uri-invalid', `${uri} is an absolute-path reference with no defined repository root.`] };
  }
  if (base && rest === '.') return { root, segments: [] };
  const segments: string[] = [];
  for (const raw of rest.split('/')) {
    if (raw === '') return { error: ['uri-invalid', `${uri} has an empty path segment.`] };
    const decoded = percentDecode(raw);
    if (decoded === null) return { error: ['uri-invalid', `${uri} has invalid percent-encoding.`] };
    if (decoded === '.' || decoded === '..') return { error: ['uri-traversal', `${uri} contains a dot segment.`] };
    if (/[/\\]/.test(decoded)) return { error: ['uri-encoded-separator', `${uri} encodes a path separator.`] };
    if (decoded.includes('\0')) return { error: ['uri-invalid', `${uri} encodes a NUL character.`] };
    segments.push(decoded);
  }
  return { root, segments };
}

/** Decodes %XX sequences as UTF-8; null when malformed. */
function percentDecode(segment: string): string | null {
  if (!segment.includes('%')) return segment;
  if (/%(?![0-9A-Fa-f]{2})/.test(segment)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < segment.length;) {
    if (segment[i] === '%') {
      bytes.push(parseInt(segment.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      // i is always inside the string, so codePointAt never yields undefined;
      // NaN would reproduce fromCodePoint(undefined)'s RangeError if it did.
      const character = String.fromCodePoint(segment.codePointAt(i) ?? Number.NaN);
      bytes.push(...Buffer.from(character, 'utf8'));
      i += character.length;
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rules and messages (SARIF 3.11, 3.27.5-3.27.7, 3.52, 3.54)

/**
 * The rule a result names and the tool component that defines it.
 * - Without `result.rule.toolComponent`, the component is the driver.
 * - With it, `ruleIndex`/`ruleId` are read within the referenced component.
 *
 * Returns `{ rule?, component }`, or `{ error: [code, message] }` when the
 * component or the identifiers cannot be resolved consistently. This mirrors
 * the publisher, which blocks those cases; there is no fallback to the
 * driver. Codes: rule-component-unresolved, rule-reference-conflict,
 * rule-reference-invalid.
 */
export function resolveRule(result: ISarifResult, run: ISarifRun): RuleResolution {
  const driver = run.tool.driver;
  const reference: ISarifReportingDescriptorReference = result.rule || {};
  let component: ISarifToolComponent | undefined = driver;
  if (reference.toolComponent !== undefined) {
    component = resolveComponent(reference.toolComponent, run);
    if (!component) {
      return { error: ['rule-component-unresolved', `The rule's toolComponent ${JSON.stringify(reference.toolComponent)} names no single component of the tool.`] };
    }
  }
  if (result.ruleId !== undefined && reference.id !== undefined && result.ruleId !== reference.id) {
    return { error: ['rule-reference-conflict', `ruleId ${result.ruleId} differs from rule.id ${reference.id}.`] };
  }
  if (result.ruleIndex !== undefined && reference.index !== undefined && result.ruleIndex !== reference.index) {
    return { error: ['rule-reference-conflict', `ruleIndex ${String(result.ruleIndex)} differs from rule.index ${String(reference.index)}.`] };
  }
  const rules = component.rules || [];
  const index = result.ruleIndex !== undefined ? result.ruleIndex : reference.index;
  const id = result.ruleId !== undefined ? result.ruleId : reference.id;
  const matchesId = (rule: ISarifReportingDescriptor): boolean => rule.id === id || (typeof id === 'string' && id.startsWith(`${rule.id}/`));
  if (index !== undefined && index >= 0) {
    const rule = rules[index];
    if (!rule) return { error: ['rule-reference-invalid', `Rule index ${String(index)} names no rule of component ${component.name}.`] };
    if (id !== undefined && !matchesId(rule)) {
      return { error: ['rule-reference-conflict', `Rule index ${String(index)} names rule ${rule.id}, but the rule id is ${id}.`] };
    }
    return { rule, component };
  }
  if (id === undefined) return { component };
  const rule = rules.find((r) => r.id === id) || rules.find(matchesId);
  return rule ? { rule, component } : { component };
}

/**
 * The single tool component a toolComponentReference names.
 * - `index` selects from tool.extensions.
 * - `guid` and `name` match the driver or any extension.
 *
 * Every stated property must agree. Zero or several matches is unresolved
 * (undefined).
 */
function resolveComponent(reference: ISarifToolComponentReference, run: ISarifRun): ISarifToolComponent | undefined {
  const extensions = run.tool.extensions || [];
  let candidates = [run.tool.driver, ...extensions];
  if (reference.index !== undefined) {
    const extension = extensions[reference.index];
    candidates = extension ? [extension] : [];
  }
  const { guid, name } = reference;
  if (guid !== undefined) {
    candidates = candidates.filter((c) => typeof c.guid === 'string' && c.guid.toLowerCase() === guid.toLowerCase());
  }
  if (name !== undefined) candidates = candidates.filter((c) => c.name === name);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * SARIF 3.11.5 placeholder substitution: `{n}` takes argument n, and `{{`/`}}`
 * are literal braces. Arguments are inserted raw.
 *
 * Returns `{ text, missing? }`. `missing` is the first placeholder number
 * with no argument; that placeholder is kept verbatim.
 */
function substitute(template: string, args: readonly string[]): ISubstitution {
  let missing: number | undefined;
  const text = template.replace(/\{\{|\}\}|\{(\d+)\}/g, (match: string, n: string | undefined) => {
    if (match === '{{') return '{';
    if (match === '}}') return '}';
    if (Number(n) >= args.length) {
      if (missing === undefined) missing = Number(n);
      return match;
    }
    return String(args[Number(n)]);
  });
  return missing === undefined ? { text } : { text, missing };
}

/**
 * A message's content as data, resolved as the publisher resolves it but not
 * rendered or escaped:
 * - direct `text`/`markdown` are used as given;
 * - `message.id` resolves through the rule's messageStrings, then the defining
 *   component's globalMessageStrings (the driver when `component` is absent);
 * - `arguments` are substituted into direct and resolved strings alike.
 *
 * Returns `{ id?, text?, markdown?, resolved, missingArgument? }`.
 * - An unknown id gives `{ id, resolved: false }`.
 * - A missing argument keeps the template, and gives `resolved: false` with
 *   the placeholder number.
 */
export function resolveMessage(
  message: ISarifMessage,
  rule: ISarifReportingDescriptor | undefined,
  component: ISarifToolComponent | undefined,
): IResolvedMessage {
  const view: { id?: string | undefined; text?: string; markdown?: string } = {};
  let template: ISarifMultiformatMessageString | undefined = message;
  if (message.text === undefined && message.markdown === undefined) {
    view.id = message.id;
    // A property key is its string form, so an absent id looks up "undefined".
    const key = String(message.id);
    const fromRule = rule && rule.messageStrings && rule.messageStrings[key];
    const global = component && component.globalMessageStrings && component.globalMessageStrings[key];
    template = fromRule || global;
    if (!template) return { ...view, resolved: false };
  } else if (message.id !== undefined) {
    view.id = message.id;
  }
  const args = message.arguments || [];
  let missing: number | undefined;
  for (const key of ['text', 'markdown'] as const) {
    const source = template[key];
    if (typeof source !== 'string') continue;
    const substituted = substitute(source, args);
    view[key] = substituted.text;
    if (substituted.missing !== undefined && missing === undefined) missing = substituted.missing;
  }
  return missing === undefined ? { ...view, resolved: true } : { ...view, resolved: false, missingArgument: missing };
}
