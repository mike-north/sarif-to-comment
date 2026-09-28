'use strict';

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
 * - It reproduces the publisher's semantics (`src/index.cjs` capture;
 *   `src/prepare-review.cjs` schema, URI, identity and message rules) without
 *   importing or changing the publisher. The publisher is out of this
 *   increment's scope.
 * - Equivalence is enforced by behavioural parity tests in
 *   `test/sarif-common.test.cjs`, run against the unchanged publisher.
 *   Change both sides together.
 */

const fs = require('node:fs');
const path = require('node:path');
const SARIF_SCHEMA = require('../vendor/sarif-schema-2.1.0.json');

/** A full, canonical Git object name; abbreviations are never prefix-matched. */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** GitHub account names: alphanumerics and single interior hyphens. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** GitHub repository names: letters, digits, '.', '_' and '-' (never '.' or '..'). */
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Nesting bound for captured JSON, so hostile depth fails as input, not a stack overflow. */
const MAX_JSON_DEPTH = 512;

/** GitHub web host used for repository identity. */
const GITHUB_HOST = 'github.com';

// ---------------------------------------------------------------------------
// Capture

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function refused(message) {
  return new TypeError(`Invalid input: ${message}`);
}

/** An own data property's value, refusing accessors (whose getters are never run). */
function dataValue(object, key, where) {
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
 * discipline (`src/index.cjs`), with a neutral message prefix.
 */
function captureJson(value, label, ancestors = new Set(), depth = 0) {
  const where = label;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw refused(`${where} is not a finite JSON number`);
    return value;
  }
  if (typeof value !== 'object') throw refused(`${where} is a ${typeof value}, which JSON cannot represent`);
  if (depth > MAX_JSON_DEPTH) throw refused(`${where} is nested more than ${MAX_JSON_DEPTH} levels deep`);
  if (ancestors.has(value)) throw refused(`${where} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw refused(`${where} is not a plain array`);
      const keys = Reflect.ownKeys(value);
      const length = dataValue(value, 'length', `${where}.length`);
      if (keys.length !== length + 1) throw refused(`${where} has holes or extra properties`);
      const copy = new Array(length);
      for (let i = 0; i < length; i += 1) {
        if (!Object.hasOwn(value, i)) throw refused(`${where}[${i}] is a hole`);
        copy[i] = captureJson(dataValue(value, String(i), `${where}[${i}]`), `${where}[${i}]`, ancestors, depth + 1);
      }
      return copy;
    }
    if (!isPlainObject(value)) throw refused(`${where} is not a plain JSON object`);
    const copy = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') throw refused(`${where} has a symbol-keyed property`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable) throw refused(`${where}.${key} is not enumerable`);
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

let schemaValidator;

/**
 * The compiled official SARIF 2.1.0 errata01 schema (draft-04), with string
 * formats enforced and every error reported. This is the publisher's
 * configuration.
 */
function sarifValidator() {
  if (!schemaValidator) {
    const AjvDraft04 = require('ajv-draft-04');
    const formats = require('ajv-formats');
    const Ajv = AjvDraft04.default || AjvDraft04;
    const addFormats = formats.default || formats;
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    schemaValidator = ajv.compile(SARIF_SCHEMA);
  }
  return schemaValidator;
}

/** A Markdown code span that stays literal whatever backticks the text holds. */
function codeSpan(text) {
  let fence = '`';
  while (text.includes(fence)) fence += '`';
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
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
function validateSarif(captured) {
  const validate = sarifValidator();
  if (validate(captured)) return null;
  const seen = new Set();
  const problems = [];
  for (const error of validate.errors || []) {
    const pointer = error.instancePath || '';
    const detail = error.params && error.params.additionalProperty !== undefined
      ? `${error.message} (${codeSpan(error.params.additionalProperty)})` : error.message;
    const message = `${pointer === '' ? 'The document' : codeSpan(pointer)} ${detail}.`;
    if (seen.has(message)) continue;
    seen.add(message);
    problems.push({ message, pointer });
  }
  const markdown = `**Invalid SARIF:** the document does not conform to the SARIF 2.1.0 schema, so it was not interpreted.\n\n${
    problems.map((p) => `- ${p.message}`).join('\n')}`;
  return { status: 'invalid', problems, markdown };
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
function isNormalizedRepositoryPath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * The SARIF `artifactLocation.uri` for a normalized repository path. Each
 * segment is percent-encoded as UTF-8 (RFC 3986), so reserved characters such
 * as `#`, `?`, `%` and a leading `c:` cannot change the reference's meaning.
 * The publisher's decoder recovers exactly the original path.
 */
function encodeRepositoryPath(repositoryPath) {
  return repositoryPath.split('/').map(encodeURIComponent).join('/');
}

/**
 * Whether a provenance `repositoryUri` names the GitHub repository
 * `{ owner, repo }`. Matching is case-insensitive. Accepted forms are the
 * https, http, ssh and git URIs, with an optional `.git` suffix. These are the
 * publisher's identity rules.
 */
function namesRepository(uri, { owner, repo }) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || url.hostname.toLowerCase() !== GITHUB_HOST) return false;
  const parts = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  return parts.length === 2 && parts[0].toLowerCase() === owner.toLowerCase() && parts[1].toLowerCase() === repo.toLowerCase();
}

/**
 * This package's version, read from package.json at runtime so attribution
 * never drifts from the installed release.
 */
function packageVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  return manifest.version;
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
function resolveArtifactPath(artifactLocation, run, options = {}) {
  let effective = artifactLocation;
  if (artifactLocation.index !== undefined) {
    const artifact = (run.artifacts || [])[artifactLocation.index];
    if (!artifact || !artifact.location) {
      return describe(artifactLocation, { error: ['artifact-index-invalid', `Artifact index ${artifactLocation.index} names no artifact location.`] });
    }
    if (artifact.parentIndex !== undefined) {
      return describe(artifact.location, { error: ['nested-artifact-unsupported', 'Artifacts nested inside other artifacts are not supported.'] });
    }
    if (artifactLocation.uri !== undefined && (artifactLocation.uri !== artifact.location.uri
      || artifactLocation.uriBaseId !== artifact.location.uriBaseId)) {
      return describe(artifactLocation, { error: ['artifact-index-conflict',
        `The location names ${JSON.stringify(artifactLocation.uri)} but artifact ${artifactLocation.index} is ${JSON.stringify(artifact.location.uri)}.`] });
    }
    effective = artifact.location;
  }
  if (typeof effective.uri !== 'string') return describe(effective, { error: ['uri-invalid', 'The artifact location has no URI.'] });

  const reference = parseReference(effective.uri);
  if (reference.error) return describe(effective, reference);
  let located;
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

/** Attaches the effective reference to a resolution outcome. */
function describe(reference, outcome) {
  const described = { ...outcome };
  if (typeof reference.uri === 'string') described.uri = reference.uri;
  if (reference.uriBaseId !== undefined) described.uriBaseId = reference.uriBaseId;
  return described;
}

/** The repository roots a run's locations may resolve under (see resolveArtifactPath). */
function repositoryRoots(run, { sourceRootUri, repository } = {}) {
  const roots = [];
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

function finishPath(segments) {
  if (segments.length === 0) return { error: ['uri-invalid', 'The URI names the repository root, not a file.'] };
  return { path: segments.join('/') };
}

/**
 * Resolves a uriBaseId to `{ root, segments }`.
 * - A base with no URI value is an abstract named root ("base:ID"). It is
 *   meaningful only when provenance maps it to the repository.
 * - Chains are followed. Cycles and invalid bases are errors.
 */
function resolveBase(id, run, visited) {
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
function resolveBaseLocation(location, run) {
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
function parseBaseUri(uri) {
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
function parseReference(uri, { base = false } = {}) {
  if (uri === '') return { error: ['uri-invalid', 'The URI is empty.'] };
  if (/[\\\u0000-\u001f\u007f]/.test(uri)) return { error: ['uri-invalid', `${JSON.stringify(uri)} contains a backslash or control character.`] };
  if (/[?#]/.test(uri)) return { error: ['uri-invalid', `${JSON.stringify(uri)} has a query or fragment.`] };
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri);
  let root;
  let rest = uri;
  if (scheme) {
    if (scheme[1].toLowerCase() !== 'file') {
      return { error: ['uri-scheme-unsupported', `URI scheme ${scheme[1]} is not supported; only repository paths and file: URIs are.`] };
    }
    const hierarchical = uri.slice(scheme[0].length);
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
  const segments = [];
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
function percentDecode(segment) {
  if (!segment.includes('%')) return segment;
  if (/%(?![0-9A-Fa-f]{2})/.test(segment)) return null;
  const bytes = [];
  for (let i = 0; i < segment.length;) {
    if (segment[i] === '%') {
      bytes.push(parseInt(segment.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      const character = String.fromCodePoint(segment.codePointAt(i));
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
function resolveRule(result, run) {
  const driver = run.tool.driver;
  const reference = result.rule || {};
  let component = driver;
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
    return { error: ['rule-reference-conflict', `ruleIndex ${result.ruleIndex} differs from rule.index ${reference.index}.`] };
  }
  const rules = component.rules || [];
  const index = result.ruleIndex !== undefined ? result.ruleIndex : reference.index;
  const id = result.ruleId !== undefined ? result.ruleId : reference.id;
  const matchesId = (rule) => rule.id === id || (typeof id === 'string' && id.startsWith(`${rule.id}/`));
  if (index !== undefined && index >= 0) {
    const rule = rules[index];
    if (!rule) return { error: ['rule-reference-invalid', `Rule index ${index} names no rule of component ${component.name}.`] };
    if (id !== undefined && !matchesId(rule)) {
      return { error: ['rule-reference-conflict', `Rule index ${index} names rule ${rule.id}, but the rule id is ${id}.`] };
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
function resolveComponent(reference, run) {
  const extensions = run.tool.extensions || [];
  let candidates = [run.tool.driver, ...extensions];
  if (reference.index !== undefined) candidates = extensions[reference.index] ? [extensions[reference.index]] : [];
  if (reference.guid !== undefined) {
    candidates = candidates.filter((c) => typeof c.guid === 'string' && c.guid.toLowerCase() === reference.guid.toLowerCase());
  }
  if (reference.name !== undefined) candidates = candidates.filter((c) => c.name === reference.name);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * SARIF 3.11.5 placeholder substitution: `{n}` takes argument n, and `{{`/`}}`
 * are literal braces. Arguments are inserted raw.
 *
 * Returns `{ text, missing? }`. `missing` is the first placeholder number
 * with no argument; that placeholder is kept verbatim.
 */
function substitute(template, args) {
  let missing;
  const text = template.replace(/\{\{|\}\}|\{(\d+)\}/g, (match, n) => {
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
function resolveMessage(message, rule, component) {
  const view = {};
  let template = message;
  if (message.text === undefined && message.markdown === undefined) {
    view.id = message.id;
    const fromRule = rule && rule.messageStrings && rule.messageStrings[message.id];
    const global = component && component.globalMessageStrings && component.globalMessageStrings[message.id];
    template = fromRule || global;
    if (!template) return { ...view, resolved: false };
  } else if (message.id !== undefined) {
    view.id = message.id;
  }
  const args = message.arguments || [];
  let missing;
  for (const key of ['text', 'markdown']) {
    if (typeof template[key] !== 'string') continue;
    const substituted = substitute(template[key], args);
    view[key] = substituted.text;
    if (substituted.missing !== undefined && missing === undefined) missing = substituted.missing;
  }
  return missing === undefined ? { ...view, resolved: true } : { ...view, resolved: false, missingArgument: missing };
}

module.exports = {
  COMMIT_PATTERN,
  OWNER_PATTERN,
  REPO_PATTERN,
  captureJson,
  validateSarif,
  isPlainObject,
  isNormalizedRepositoryPath,
  encodeRepositoryPath,
  namesRepository,
  packageVersion,
  parseBaseUri,
  resolveArtifactPath,
  resolveRule,
  resolveMessage,
};
