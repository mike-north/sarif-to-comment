'use strict';

/**
 * Complete, read-only SARIF inspection (private internal module).
 *
 * Turns any schema-valid SARIF, authored or upstream, into one simplified,
 * JSON-compatible view of its findings and proposed changes, so an agent can
 * see what it holds before publishing (contract §3.3). Human rendering
 * (`renderInspectionText`) is a projection of that same view, never an
 * independent traversal, so human and JSON output cannot disagree.
 *
 * Invariants:
 * - Complete, not a readiness check. Every run, finding, full message, every
 *   location and related location, every included fix (alternatives and
 *   multi-file changes too) and every file proposal appears. That includes
 *   content the publisher would block. Evidence without a named field of its
 *   own is kept verbatim in `otherContent`; counts never stand in for
 *   omitted content.
 *   - This includes log-level content (`log`) and artifact-content metadata
 *     (a preview's `otherContent`).
 *   - Results embedded in inline external properties are shown verbatim
 *     (`externalProperties`), counted separately (`summary.externalFindings`)
 *     and warned about. Declared run associations remain in that content;
 *     inspection does not merge embedded properties into run findings.
 *   - Referenced external property files are never loaded, and a warning
 *     says so.
 * - Only previews shorten. Inserted fix text and proposed file content may
 *   be previewed within line/character limits. Shortening is signalled only
 *   by `state: 'truncated'` and exact counts, never by editing the text.
 *   Messages are never shortened.
 * - Read-only and destination-free. No source, Git, host or file is read.
 *   Provenance is reported as declared facts; with no destination
 *   repository, inspection never judges a source foreign. The input SARIF is
 *   captured and never changed.
 * - Shared interpretation. Paths, rules and messages are read with the same
 *   rules the publisher uses (`sarif-common.cjs`). What cannot be resolved
 *   stays in the view (`path: null`, `resolved: false`) with a warning.
 */

const {
  captureJson, validateSarif, isPlainObject, parseBaseUri, resolveArtifactPath, resolveRule, resolveMessage,
} = require('./sarif-common.cjs');

/** Default preview bounds (contract §3.3); `null` means unlimited. */
const DEFAULT_PREVIEW_LINES = 20;
const DEFAULT_PREVIEW_CHARS = 2000;

/** Identifies the view's schema for consumers. */
const VIEW_FORMAT = 'sarif-to-comment.inspection';
const VIEW_VERSION = 1;

/** Owned file-proposal operations the product recognises (D23); others are shown with a warning. */
const KNOWN_FILE_OPERATIONS = new Set(['create', 'delete', 'edit']);

/** Result properties presented by named view fields; all other result content goes to otherContent. */
const NAMED_RESULT_KEYS = new Set(['ruleId', 'level', 'kind', 'baselineState', 'message', 'locations', 'relatedLocations', 'fixes']);

/** Run properties presented by named view fields; all other run content goes to otherContent. */
const NAMED_RUN_KEYS = new Set(['results', 'columnKind', 'versionControlProvenance']);

/** Region properties presented by named LocationView fields. */
const NAMED_REGION_KEYS = ['startLine', 'endLine', 'startColumn', 'endColumn', 'charOffset', 'charLength'];

function misuse(message) {
  return new TypeError(`Invalid inspectSarif input: ${message}`);
}

/** `value` without the named keys; used to retain unnamed evidence verbatim. */
function without(value, keys) {
  const rest = {};
  for (const [key, item] of Object.entries(value)) if (!keys.has(key)) rest[key] = item;
  return rest;
}

/** Reads a preview bound: a positive integer, null for unlimited, or the default. */
function previewBound(value, name, fallback) {
  if (value === undefined) return fallback;
  if (value === null) return Infinity;
  if (!Number.isInteger(value) || value < 1) throw misuse(`options.${name} must be a positive whole number or null for unlimited`);
  return value;
}

function checkOptions(options) {
  if (options === undefined) return { lines: DEFAULT_PREVIEW_LINES, chars: DEFAULT_PREVIEW_CHARS };
  const given = captureJson(options, 'options');
  if (!isPlainObject(given)) throw misuse('options must be an object');
  for (const key of Object.keys(given)) {
    if (!['previewLines', 'previewChars', 'sourceRootUri'].includes(key)) throw misuse(`options has unknown key ${JSON.stringify(key)}`);
  }
  if (given.sourceRootUri !== undefined) {
    const root = typeof given.sourceRootUri === 'string' ? parseBaseUri(given.sourceRootUri) : null;
    if (!root || root.error || root.root !== 'file:') throw misuse('options.sourceRootUri must be an absolute file: URI ending in "/"');
  }
  return {
    lines: previewBound(given.previewLines, 'previewLines', DEFAULT_PREVIEW_LINES),
    chars: previewBound(given.previewChars, 'previewChars', DEFAULT_PREVIEW_CHARS),
    sourceRootUri: given.sourceRootUri,
  };
}

// ---------------------------------------------------------------------------
// Previews

/**
 * A bounded preview of proposed text.
 *
 * Lines are physical lines; a final line without a newline counts.
 * - The line limit takes whole lines only.
 * - If the kept lines exceed the character limit, the longest run of whole
 *   lines within it is shown.
 * - If even the first line is too long, that line is cut at the character
 *   limit, never inside a surrogate pair.
 *
 * `shownLines` counts lines at least partly shown. The text itself is never
 * annotated.
 */
function previewText(text, limits, state) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let shownLines = Math.min(lines.length, limits.lines);
  let shown = lines.slice(0, shownLines).join('');
  if (shown.length > limits.chars) {
    let whole = '';
    let count = 0;
    while (count < shownLines && whole.length + lines[count].length <= limits.chars) whole += lines[count++];
    if (count > 0) {
      shown = whole;
      shownLines = count;
    } else {
      let cut = limits.chars;
      const code = text.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
      shown = text.slice(0, cut);
      shownLines = shown === '' ? 0 : 1;
    }
  }
  const preview = {
    state: shown === text ? 'complete' : 'truncated',
    text: shown,
    totalLines: lines.length,
    totalChars: text.length,
    shownLines,
    shownChars: shown.length,
  };
  if (preview.state === 'truncated') state.truncatedPreviews += 1;
  return preview;
}

/**
 * The preview of SARIF artifactContent (3.3).
 * - Text is previewed.
 * - Binary-only content is explicitly unavailable, with its decoded size.
 * Everything else the content holds is kept verbatim in `otherContent`:
 * `rendered` forms, `properties`, and a binary alternative when the text is
 * previewed. Only the previewed text itself may shorten.
 */
function previewContent(content, limits, state) {
  if (content === undefined) return previewText('', limits, state);
  let preview;
  let shownKey;
  if (typeof content.text === 'string') {
    preview = previewText(content.text, limits, state);
    shownKey = 'text';
  } else if (typeof content.binary === 'string') {
    preview = { state: 'unavailable', byteLength: Buffer.from(content.binary, 'base64').length };
    shownKey = 'binary';
  } else {
    preview = { state: 'unavailable' };
  }
  const rest = without(content, new Set(shownKey ? [shownKey] : []));
  if (Object.keys(rest).length > 0) preview.otherContent = rest;
  return preview;
}

// ---------------------------------------------------------------------------
// View construction

/** Mutable accumulation for one inspection: warnings and preview counts. */
function newState(limits) {
  return { limits, diagnostics: [], truncatedPreviews: 0 };
}

function warn(state, pointer, message) {
  state.diagnostics.push({ severity: 'warning', message, pointer });
}

/** Message properties presented by named message-view fields; others go to its otherContent. */
const NAMED_MESSAGE_KEYS = new Set(['text', 'markdown', 'id', 'arguments']);

/**
 * A message's content for the view: `{ id?, text?, markdown?, arguments?,
 * resolved, otherContent? }`.
 * - Text and Markdown alternatives are both kept.
 * - `arguments` are kept whenever resolution left them unused (unknown id or
 *   a missing placeholder), so nothing the producer supplied is lost.
 * - Message metadata such as `properties` goes to otherContent.
 * An unresolved message is warned about.
 */
function messageView(message, rule, component, pointer, state) {
  const resolved = resolveMessage(message, rule, component);
  const { missingArgument, ...view } = resolved;
  if (!resolved.resolved && Array.isArray(message.arguments)) view.arguments = message.arguments;
  const rest = without(message, NAMED_MESSAGE_KEYS);
  if (Object.keys(rest).length > 0) view.otherContent = rest;
  if (!resolved.resolved) {
    warn(state, pointer, missingArgument !== undefined
      ? `The message needs argument {${missingArgument}}, which was not supplied; its template is shown unsubstituted.`
      : `Message id \`${message.id}\` is not defined by the rule or its tool component, so its text is unavailable.`);
  }
  return view;
}

/** One resolved path for an artifact reference; an unresolved path is `null` with a warning. */
function pathOf(artifactLocation, run, pointer, state) {
  const resolved = resolveArtifactPath(artifactLocation, run, { sourceRootUri: state.limits.sourceRootUri });
  if (resolved.error) {
    warn(state, pointer, `The artifact reference could not be resolved to a repository path (${resolved.error[0]}): ${resolved.error[1]}`);
  }
  return resolved;
}

/**
 * Whether a message view is fully captured by its plain text string: resolved
 * text with no Markdown, id, arguments or metadata. Only then may a location
 * message or fix description be shown as a string alone. Otherwise the full
 * content object accompanies the string (`messageContent`,
 * `descriptionContent`).
 */
function plainText(message) {
  return message.resolved && Object.keys(message).every((key) => key === 'text' || key === 'resolved');
}

/**
 * A location (SARIF 3.28) as a LocationView.
 *
 * Named fields: path, reference, line/column/offset coordinates, snippet
 * text, message and logical locations. Every other location, physical
 * location and region property is kept under `otherContent`.
 */
function locationView(location, run, finding, pointer, state) {
  const view = {};
  const physical = location.physicalLocation;
  if (physical && physical.artifactLocation) {
    const resolved = pathOf(physical.artifactLocation, run, pointer, state);
    view.path = resolved.path === undefined ? null : resolved.path;
    view.artifactLocation = physical.artifactLocation;
    if (resolved.uri !== undefined) view.uri = resolved.uri;
    if (resolved.uriBaseId !== undefined) view.uriBaseId = resolved.uriBaseId;
  } else {
    view.path = null;
  }
  const region = physical && physical.region;
  const other = {};
  if (region) {
    for (const key of NAMED_REGION_KEYS) if (region[key] !== undefined) view[key] = region[key];
    const regionRest = without(region, new Set(NAMED_REGION_KEYS));
    if (regionRest.snippet && typeof regionRest.snippet.text === 'string' && Object.keys(regionRest.snippet).length === 1) {
      view.snippet = regionRest.snippet.text;
      delete regionRest.snippet;
    }
    if (Object.keys(regionRest).length > 0) other.region = regionRest;
  }
  if (location.message !== undefined) {
    const message = messageView(location.message, finding.rule, finding.component, `${pointer}/message`, state);
    const text = message.text !== undefined ? message.text : message.markdown;
    if (text !== undefined) view.message = text;
    if (!plainText(message)) view.messageContent = message;
  }
  if (location.logicalLocations !== undefined) view.logical = location.logicalLocations;
  if (physical) {
    const physicalRest = without(physical, new Set(['artifactLocation', 'region']));
    if (Object.keys(physicalRest).length > 0) other.physicalLocation = physicalRest;
  }
  const locationRest = without(location, new Set(['physicalLocation', 'message', 'logicalLocations']));
  if (Object.keys(locationRest).length > 0) other.location = locationRest;
  if (Object.keys(other).length > 0) view.otherContent = other;
  return view;
}

/**
 * A SARIF fix (3.55) with every artifact change and replacement. Deleted
 * regions are kept raw; inserted content is previewed.
 */
function fixView(fix, run, finding, pointer, state) {
  const view = { ref: pointer };
  if (fix.description !== undefined) {
    const message = messageView(fix.description, finding.rule, finding.component, `${pointer}/description`, state);
    const text = message.text !== undefined ? message.text : message.markdown;
    if (text !== undefined) view.description = text;
    if (!plainText(message)) view.descriptionContent = message;
  }
  view.changes = fix.artifactChanges.map((change, c) => {
    const changePointer = `${pointer}/artifactChanges/${c}`;
    const resolved = pathOf(change.artifactLocation, run, changePointer, state);
    const changeView = {
      path: resolved.path === undefined ? null : resolved.path,
      uri: resolved.uri !== undefined ? resolved.uri : (change.artifactLocation.uri || ''),
      artifactLocation: change.artifactLocation,
      replacements: change.replacements.map((replacement) => {
        const replacementView = { deletedRegion: replacement.deletedRegion, inserted: previewContent(replacement.insertedContent, state.limits, state) };
        const rest = without(replacement, new Set(['deletedRegion', 'insertedContent']));
        if (Object.keys(rest).length > 0) replacementView.otherContent = rest;
        return replacementView;
      }),
    };
    const rest = without(change, new Set(['artifactLocation', 'replacements']));
    if (Object.keys(rest).length > 0) changeView.otherContent = rest;
    return changeView;
  });
  const rest = without(fix, new Set(['description', 'artifactChanges']));
  if (Object.keys(rest).length > 0) view.otherContent = rest;
  return view;
}

/**
 * The owned whole-file proposals of a result (D23: `properties.sarifToComment
 * .proposedFileChanges`), each with its artifact's path and a content
 * preview. Unknown operations and fields are shown verbatim.
 */
function fileProposalViews(result, run, ref, state) {
  const owned = result.properties && result.properties.sarifToComment;
  if (!isPlainObject(owned) || owned.proposedFileChanges === undefined) return [];
  const base = `${ref}/properties/sarifToComment/proposedFileChanges`;
  if (!Array.isArray(owned.proposedFileChanges)) {
    warn(state, base, 'proposedFileChanges is not a list of operations; it is kept verbatim in the finding\'s other content.');
    return [];
  }
  return owned.proposedFileChanges.map((operation, k) => {
    const pointer = `${base}/${k}`;
    if (!isPlainObject(operation)) {
      warn(state, pointer, 'This proposed file change is not an object; it is shown verbatim.');
      return { ref: pointer, operation: null, path: null, otherContent: { value: operation } };
    }
    const view = { ref: pointer, operation: operation.operation };
    if (typeof operation.operation !== 'string' || !KNOWN_FILE_OPERATIONS.has(operation.operation)) {
      warn(state, pointer, `Unknown proposed file operation ${JSON.stringify(operation.operation)}; it is shown verbatim.`);
    }
    if (operation.artifactIndex !== undefined) view.artifactIndex = operation.artifactIndex;
    const artifact = Number.isInteger(operation.artifactIndex) ? (run.artifacts || [])[operation.artifactIndex] : undefined;
    if (artifact && artifact.location) {
      const resolved = pathOf(artifact.location, run, pointer, state);
      view.path = resolved.path === undefined ? null : resolved.path;
    } else {
      view.path = null;
      warn(state, pointer, 'The proposal names no artifact with a location, so its file is unknown.');
    }
    if (operation.fileMode !== undefined) view.fileMode = operation.fileMode;
    if (artifact && artifact.contents !== undefined) view.content = previewContent(artifact.contents, state.limits, state);
    const rest = without(operation, new Set(['operation', 'artifactIndex', 'fileMode']));
    if (Object.keys(rest).length > 0) view.otherContent = rest;
    return view;
  });
}

/** The declared approval state in an owned property bag, if any (shown as declared, never verified). */
function approvalOf(properties) {
  const owned = properties && properties.sarifToComment;
  return isPlainObject(owned) && typeof owned.approval === 'string' ? owned.approval : undefined;
}

function findingView(result, run, runIndex, resultIndex, state) {
  const ref = `/runs/${runIndex}/results/${resultIndex}`;
  const reference = resolveRule(result, run);
  if (reference.error) warn(state, ref, `The rule reference could not be resolved (${reference.error[0]}): ${reference.error[1]}`);
  const finding = { rule: reference.rule, component: reference.component || run.tool.driver };

  const view = { ref, runIndex, resultIndex };
  const ruleId = result.ruleId !== undefined ? result.ruleId
    : result.rule && result.rule.id !== undefined ? result.rule.id : finding.rule && finding.rule.id;
  if (ruleId !== undefined) view.ruleId = ruleId;
  const level = result.level !== undefined ? result.level
    : finding.rule && finding.rule.defaultConfiguration ? finding.rule.defaultConfiguration.level : undefined;
  if (level !== undefined) view.level = level;
  if (result.kind !== undefined) view.kind = result.kind;
  if (result.baselineState !== undefined) view.baselineState = result.baselineState;
  const approval = approvalOf(result.properties);
  if (approval !== undefined) view.approval = approval;
  view.message = messageView(result.message, finding.rule, finding.component, `${ref}/message`, state);
  view.locations = (result.locations || []).map((l, k) => locationView(l, run, finding, `${ref}/locations/${k}`, state));
  view.relatedLocations = (result.relatedLocations || []).map((l, k) => locationView(l, run, finding, `${ref}/relatedLocations/${k}`, state));
  view.otherContent = without(result, NAMED_RESULT_KEYS);
  view.fixes = (result.fixes || []).map((fix, k) => fixView(fix, run, finding, `${ref}/fixes/${k}`, state));
  view.fileProposals = fileProposalViews(result, run, ref, state);
  return view;
}

/** Log properties presented elsewhere: the format declaration (checked by validation), runs and external properties. */
const NAMED_LOG_KEYS = new Set(['version', '$schema', 'runs', 'inlineExternalProperties']);

/**
 * Log-level evidence (SARIF 3.13) outside runs, such as log `properties`.
 * Returns `{ otherContent }`, or undefined when the log holds none, so an
 * ordinary log's view is unchanged. `version` and `$schema` are the format
 * declaration already checked by schema validation.
 */
function logView(log) {
  const rest = without(log, NAMED_LOG_KEYS);
  return Object.keys(rest).length > 0 ? { otherContent: rest } : undefined;
}

/**
 * Inline external properties (SARIF 3.13.5, 3.15), kept verbatim as
 * `{ ref, results, content }`; `results` counts the results they embed.
 * Embedded results are not merged into run findings. Their full content,
 * including any declared runGuid association, is retained, counted in
 * `summary.externalFindings`, and warned about so nothing implies they are
 * absent. Returns undefined when the log has none.
 */
function externalPropertiesViews(log, state) {
  if (log.inlineExternalProperties === undefined) return undefined;
  return log.inlineExternalProperties.map((content, i) => {
    const ref = `/inlineExternalProperties/${i}`;
    const results = Array.isArray(content.results) ? content.results.length : 0;
    if (results > 0) {
      warn(state, ref, `${results} result(s) embedded in inline external properties are shown verbatim: inspection does not merge `
        + 'embedded external properties into run findings. Any declared runGuid is retained in the verbatim content.');
    }
    return { ref, results, content };
  });
}

function runView(run, index) {
  const { driver } = run.tool;
  const version = driver.version !== undefined ? driver.version : driver.semanticVersion;
  const provenance = run.versionControlProvenance || [];
  const view = {
    index,
    ref: `/runs/${index}`,
    tool: version === undefined ? { name: driver.name } : { name: driver.name, version },
    source: { state: provenance.length > 0 ? 'declared' : 'unbound', provenance },
  };
  if (run.columnKind !== undefined) view.columnKind = run.columnKind;
  const approval = approvalOf(run.properties);
  if (approval !== undefined) view.approval = approval;
  view.otherContent = without(run, NAMED_RUN_KEYS);
  return view;
}

/**
 * Inspects SARIF without changing or judging it (contract §3.3).
 *
 * @param {object} sarif a parsed SARIF log
 * @param {{ previewLines?: number|null, previewChars?: number|null, sourceRootUri?: string }} [options]
 * @returns {{ status: 'inspected', view: object } | { status: 'invalid', problems: object[], markdown: string }}
 * @throws {TypeError} on non-JSON SARIF or malformed options
 */
function inspectSarif(sarif, options) {
  if (sarif === null || typeof sarif !== 'object' || Array.isArray(sarif)) {
    throw misuse('sarif must be a parsed SARIF object, not serialized text');
  }
  const captured = captureJson(sarif, 'sarif');
  const limits = checkOptions(options);
  const invalid = validateSarif(captured);
  if (invalid) return invalid;

  const state = newState(limits);
  const runs = captured.runs.map((run, i) => runView(run, i));
  const findings = [];
  captured.runs.forEach((run, runIndex) => {
    (run.results || []).forEach((result, resultIndex) => findings.push(findingView(result, run, runIndex, resultIndex, state)));
  });
  const count = (key) => findings.reduce((n, f) => n + f[key].length, 0);
  const log = logView(captured);
  const externalProperties = externalPropertiesViews(captured, state);
  captured.runs.forEach((run, i) => {
    if (run.externalPropertyFileReferences !== undefined) {
      warn(state, `/runs/${i}/externalPropertyFileReferences`, 'The run references external property files. Inspection never loads '
        + 'them, so content they hold (possibly results) is not shown; the references themselves are kept in the run\'s other content.');
    }
  });
  const summary = { runs: runs.length, findings: findings.length, fixes: count('fixes'), fileProposals: count('fileProposals'),
    truncatedPreviews: state.truncatedPreviews };
  if (externalProperties) summary.externalFindings = externalProperties.reduce((n, e) => n + e.results, 0);
  const view = { format: VIEW_FORMAT, version: VIEW_VERSION, summary };
  if (log) view.log = log;
  if (externalProperties) view.externalProperties = externalProperties;
  Object.assign(view, { runs, findings, diagnostics: state.diagnostics });
  return { status: 'inspected', view };
}

// ---------------------------------------------------------------------------
// Human rendering (a projection of the view; no independent traversal)
//
// Every piece of evidence in the view appears in the human text; human and
// JSON output differ only in presentation. Named facts are rendered as
// labelled lines. Evidence without a named field of its own (otherContent,
// extra reference or provenance fields, message metadata) is rendered as
// indented JSON under a label. That is the evidence itself, not a key list
// and not a re-dump of the whole SARIF, since named fields are never
// repeated there.

function toolLabel(tool) {
  return tool.version === undefined ? tool.name : `${tool.name} ${tool.version}`;
}

/** A labelled, indented JSON block for evidence with no named rendering. */
function jsonBlock(label, value, indent) {
  const body = JSON.stringify(value, null, 2).split('\n').map((line) => `${indent}  ${line}`);
  return [`${indent}${label}:`, ...body];
}

/** Indents every line of a multi-line text. */
function indentText(text, indent) {
  return text.split('\n').map((line) => `${indent}${line}`);
}

/**
 * The lines for a message view: its text, any distinct Markdown alternative,
 * an unresolved id with its unused arguments, and message metadata.
 */
function messageLines(message, label, indent) {
  const lines = [];
  const text = message.text !== undefined ? message.text : message.markdown;
  if (text !== undefined) {
    lines.push(`${indent}${label}:`, ...indentText(text, indent));
  } else {
    lines.push(`${indent}${label}: (unresolved message id ${JSON.stringify(message.id)})`);
  }
  if (message.markdown !== undefined && message.text !== undefined && message.markdown !== message.text) {
    lines.push(`${indent}${label} (Markdown):`, ...indentText(message.markdown, indent));
  }
  if (message.id !== undefined && text !== undefined) lines.push(`${indent}${label} id: ${JSON.stringify(message.id)}`);
  if (!message.resolved) {
    lines.push(`${indent}${label} is unresolved${message.arguments ? `; arguments supplied: ${JSON.stringify(message.arguments)}` : ''}`);
  }
  if (message.otherContent !== undefined) lines.push(...jsonBlock(`${label} metadata`, message.otherContent, indent));
  return lines;
}

/** Whether an artifact reference says more than its resolved path. */
function referenceAddsDetail(path, artifactLocation) {
  if (!artifactLocation) return false;
  const keys = Object.keys(artifactLocation);
  return !(path !== null && keys.length === 1 && artifactLocation.uri === path);
}

function locationHeading(location) {
  let label = location.path !== null ? location.path : '(unresolved path)';
  if (location.startLine !== undefined) {
    label += `:${location.startLine}`;
    if (location.endLine !== undefined && location.endLine !== location.startLine) label += `-${location.endLine}`;
  }
  if (location.startColumn !== undefined || location.endColumn !== undefined) {
    label += ` (columns ${location.startColumn ?? 1}-${location.endColumn ?? 'end'})`;
  }
  if (location.charOffset !== undefined) label += ` (characters ${location.charOffset}+${location.charLength ?? 0})`;
  if (location.snippet !== undefined) label += ` snippet ${JSON.stringify(location.snippet)}`;
  if (location.message !== undefined && location.messageContent === undefined) label += ` — ${location.message}`;
  return label;
}

/** A logical location with every field: its name, then each remaining property. */
function logicalLabel(logical) {
  const name = logical.fullyQualifiedName || logical.name || logical.decoratedName || '(unnamed)';
  const rest = Object.entries(logical)
    .filter(([key]) => key !== (logical.fullyQualifiedName ? 'fullyQualifiedName' : logical.name ? 'name' : 'decoratedName'))
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return rest.length === 0 ? name : `${name} (${rest.join('; ')})`;
}

function locationLines(location, indent) {
  const lines = [`${indent}${locationHeading(location)}`];
  const inner = `${indent}    `;
  if (referenceAddsDetail(location.path, location.artifactLocation)) {
    lines.push(`${inner}reference: ${JSON.stringify(location.artifactLocation)}`);
  }
  if (location.messageContent !== undefined) lines.push(...messageLines(location.messageContent, 'Location message', inner));
  for (const logical of location.logical || []) lines.push(`${inner}logical: ${logicalLabel(logical)}`);
  if (location.otherContent !== undefined) lines.push(...jsonBlock('Other location evidence', location.otherContent, inner));
  return lines;
}

/** Preview lines, prefixed so they are distinguishable from surrounding text, plus explicit truncation markers. */
function previewLines(preview, indent) {
  const other = preview.otherContent === undefined ? [] : jsonBlock('Other content evidence', preview.otherContent, indent);
  if (preview.state === 'unavailable') {
    return [`${indent}(binary content${preview.byteLength === undefined ? '' : `, ${preview.byteLength} bytes`}, not shown)`, ...other];
  }
  if (preview.totalChars === 0) return [`${indent}(empty)`, ...other];
  const out = preview.text.replace(/\n$/, '').split('\n').map((line) => `${indent}| ${line}`);
  if (preview.state === 'truncated') {
    out.push(preview.shownLines < preview.totalLines
      ? `${indent}(truncated: ${preview.shownLines} of ${preview.totalLines} lines shown)`
      : `${indent}(truncated: ${preview.shownChars} of ${preview.totalChars} characters shown)`);
  }
  return [...out, ...other];
}

function fixLines(fix, k, total) {
  const lines = [`Fix ${k + 1} of ${total} (${fix.ref})${fix.description === undefined || fix.descriptionContent !== undefined ? '' : `: ${fix.description}`}`];
  if (fix.descriptionContent !== undefined) lines.push(...messageLines(fix.descriptionContent, 'Fix description', '  '));
  for (const change of fix.changes) {
    lines.push(`  Change ${change.path !== null ? change.path : '(unresolved path)'}`);
    if (referenceAddsDetail(change.path, change.artifactLocation)) lines.push(`    reference: ${JSON.stringify(change.artifactLocation)}`);
    for (const replacement of change.replacements) {
      lines.push(`    Replace region ${JSON.stringify(replacement.deletedRegion)} with:`);
      lines.push(...previewLines(replacement.inserted, '      '));
      if (replacement.otherContent !== undefined) lines.push(...jsonBlock('Other replacement evidence', replacement.otherContent, '      '));
    }
    if (change.otherContent !== undefined) lines.push(...jsonBlock('Other change evidence', change.otherContent, '    '));
  }
  if (fix.otherContent !== undefined) lines.push(...jsonBlock('Other fix evidence', fix.otherContent, '  '));
  return lines;
}

function proposalLines(proposal) {
  const lines = [`File proposal (${proposal.ref}): ${proposal.operation === null ? '(not an operation)' : proposal.operation} `
    + `${proposal.path !== null ? proposal.path : '(unknown file)'}`
    + `${proposal.artifactIndex === undefined ? '' : ` [artifact ${proposal.artifactIndex}]`}`
    + `${proposal.fileMode === undefined ? '' : ` (mode ${proposal.fileMode})`}`];
  if (proposal.content !== undefined) lines.push(...previewLines(proposal.content, '    '));
  if (proposal.otherContent !== undefined) lines.push(...jsonBlock('Other proposal details', proposal.otherContent, '  '));
  return lines;
}

function runLines(run) {
  const facts = [`source: ${run.source.state}`];
  if (run.columnKind !== undefined) facts.push(`columnKind: ${run.columnKind}`);
  if (run.approval !== undefined) facts.push(`approval: ${run.approval}`);
  const lines = [`Run ${run.index} (${run.ref}): ${toolLabel(run.tool)} (${facts.join('; ')})`];
  for (const entry of run.source.provenance) {
    const plain = Object.keys(entry).every((key) => key === 'repositoryUri' || key === 'revisionId');
    lines.push(plain ? `  declared source: ${entry.repositoryUri}${entry.revisionId ? ` at ${entry.revisionId}` : ''}`
      : `  declared source: ${JSON.stringify(entry)}`);
  }
  if (Object.keys(run.otherContent).length > 0) lines.push(...jsonBlock('Other run content', run.otherContent, '  '));
  return lines;
}

function findingLines(finding, view) {
  const run = view.runs[finding.runIndex];
  const facts = [toolLabel(run.tool)];
  if (finding.ruleId !== undefined) facts.push(`rule ${finding.ruleId}`);
  for (const key of ['level', 'kind', 'baselineState', 'approval']) if (finding[key] !== undefined) facts.push(`${key}: ${finding[key]}`);
  const lines = ['', `Finding ${finding.ref} — ${facts.join(' · ')}`];
  lines.push(...messageLines(finding.message, 'Message', ''));
  lines.push(finding.locations.length === 0 ? 'Location: general' : 'Locations:');
  for (const location of finding.locations) lines.push(...locationLines(location, '  '));
  if (finding.relatedLocations.length > 0) {
    lines.push('Related locations:');
    for (const location of finding.relatedLocations) lines.push(...locationLines(location, '  '));
  }
  finding.fixes.forEach((fix, k) => lines.push(...fixLines(fix, k, finding.fixes.length)));
  for (const proposal of finding.fileProposals) lines.push(...proposalLines(proposal));
  if (Object.keys(finding.otherContent).length > 0) lines.push(...jsonBlock('Other finding evidence', finding.otherContent, ''));
  return lines;
}

/**
 * Renders an inspection view as plain human-readable text: every run with
 * its declared source and other content, and every finding with its full
 * message (and alternatives), locations (or "general"), fixes and proposals.
 * Previews carry explicit truncation markers, and all remaining evidence
 * appears as labelled JSON. No readiness is claimed.
 *
 * @param {object} view the `view` from inspectSarif
 * @returns {string}
 */
function renderInspectionText(view) {
  const { summary } = view;
  const lines = [`SARIF inspection: ${summary.runs} run(s), ${summary.findings} finding(s), ${summary.fixes} fix(es), `
    + `${summary.fileProposals} file proposal(s), ${summary.truncatedPreviews} truncated preview(s)`
    + `${summary.externalFindings === undefined ? '' : `, ${summary.externalFindings} embedded finding(s) in inline external properties (shown verbatim below, not as findings)`}.`];
  if (view.log !== undefined) lines.push(...jsonBlock('Log-level content', view.log.otherContent, ''));
  for (const external of view.externalProperties || []) {
    lines.push(...jsonBlock(`Inline external properties ${external.ref} (${external.results} embedded result(s))`, external.content, ''));
  }
  for (const run of view.runs) lines.push(...runLines(run));
  for (const finding of view.findings) lines.push(...findingLines(finding, view));
  if (view.diagnostics.length > 0) {
    lines.push('', 'Warnings:');
    for (const d of view.diagnostics) lines.push(`  ${d.pointer}: ${d.message}`);
  }
  lines.push('', 'This inspection only describes the SARIF; it does not check whether it can be published.');
  return `${lines.join('\n')}\n`;
}

module.exports = { inspectSarif, renderInspectionText };
