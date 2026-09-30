/**
 * The rules of the tool-neutral suggestion pull request convention that
 * publication and cleanup share (private internal module;
 * docs/suggestion-pr-convention.md). The marker has its own module
 * (src/suggestion-marker.cts).
 *
 * Pure: nothing here reads GitHub. The transport reads the repository
 * configuration's bytes from the default branch (src/github.cts
 * readDefaultBranchFile); this module decides what they mean.
 *
 * ---------------------------------------------------------------------------
 * DEFAULT_SUGGESTION_PR_LABEL          'suggestion-pr' (§3)
 * SUGGESTION_PR_CONFIGURATION_PATH     '.github/suggestion-prs.json' (§4)
 * suggestionPrBranch(pull, id)         'suggestion-pr/<pull>/<id>' (§5)
 * isLabelName(value), LABEL_RULE       a label name under the convention (§3)
 * resolveCanonicalLabel({ branch, content })
 *     -> { status: 'resolved', label, source: 'default' | 'repository', branch }
 *      | { status: 'invalid', branch, detail }
 *   Exactly the table of §4: absent or no `label` is the default; a valid
 *   `label` is used; anything else is invalid, with a detail naming the
 *   file's problem ("its `label` is empty"). A failed read never reaches
 *   this function: the transport's error is operational.
 * uniqueLabels(labels) -> the labels without later case-insensitive repeats,
 *   keeping the first spelling.
 * combineLabels(canonical, extras) -> the labels a suggestion carries: the
 *   canonical label first, then each extra label not already present,
 *   compared case-insensitively, keeping the first spelling.
 * configurationProblem(repository, branch, detail) -> the sentence naming
 *   the file and its problem, which publication and cleanup complete.
 * labelSourceText(source, branch) -> how a Markdown line names where the
 *   canonical label came from.
 */

/** The canonical label when the repository names none (convention §3). */
export const DEFAULT_SUGGESTION_PR_LABEL = 'suggestion-pr';

/** The optional, read-only repository configuration, read from the default branch (convention §4). */
export const SUGGESTION_PR_CONFIGURATION_PATH = '.github/suggestion-prs.json';

/** The first segment of every suggestion branch (convention §5). */
const BRANCH_PREFIX = 'suggestion-pr';

/** A configuration larger than this is not a label configuration (the source-read limit). */
export const MAX_CONFIGURATION_BYTES = 1_000_000;

/** Characters a label name may not hold: controls and invisible formatting characters. */
const INVISIBLE_IN_LABEL = /[\u0000-\u001F\u007F-\u009F\uFEFF\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/;

/**
 * Whether `value` is a label name under the convention: 1-50 UTF-16 code
 * units, none invisible, not whitespace-padded, and no comma. GitHub's label
 * filter reads a comma as a list of labels, so cleanup could never select a
 * label containing one (docs/suggestion-cleanup-contract.md §2.2).
 */
export function isLabelName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 50 &&
    !INVISIBLE_IN_LABEL.test(value) &&
    !/^\s|\s$/.test(value) &&
    !value.includes(',')
  );
}

/** What a valid label name is, for refusals naming the field or flag that gave one. */
export const LABEL_RULE = '1-50 characters without commas, control or invisible formatting characters or surrounding whitespace';

/** A suggestion's branch: `suggestion-pr/<original pull number>/<id>`. */
export function suggestionPrBranch(pullNumber: number, id: string): string {
  return `${BRANCH_PREFIX}/${String(pullNumber)}/${id}`;
}

/** What is at the configuration path on the default branch, as the transport read it. */
export type RepositoryFileContent =
  | { readonly kind: 'absent' }
  | { readonly kind: 'not-a-file'; readonly entry: string }
  | { readonly kind: 'too-large'; readonly size: number }
  | { readonly kind: 'file'; readonly bytes: Uint8Array };

/** The configuration read from a default branch. */
export interface IDefaultBranchConfiguration {
  /** The default branch's name. */
  readonly branch: string;
  readonly content: RepositoryFileContent;
}

/** Where a canonical label came from. */
export type LabelSource = 'default' | 'repository';

/** The canonical label (convention §4), or why the configuration is invalid. */
export type CanonicalLabelResolution =
  | { readonly status: 'resolved'; readonly label: string; readonly source: LabelSource; readonly branch: string }
  | { readonly status: 'invalid'; readonly branch: string; readonly detail: string };

/** Whether a parsed JSON value is an object (not null, not an array). */
function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Why a string `label` is not a label name, or null when it is one. */
function labelProblem(label: string): string | null {
  if (label === '') return 'its `label` is empty';
  if (label.includes(',')) return 'its `label` contains a comma, which GitHub\'s label filter reads as a list of labels';
  if (!isLabelName(label)) return `its \`label\` is not a label name (${LABEL_RULE})`;
  return null;
}

/** The canonical label from what the default branch holds (see the module documentation). */
export function resolveCanonicalLabel(configuration: IDefaultBranchConfiguration): CanonicalLabelResolution {
  const { branch, content } = configuration;
  const invalid = (detail: string): CanonicalLabelResolution => ({ status: 'invalid', branch, detail });
  const fallback: CanonicalLabelResolution = { status: 'resolved', label: DEFAULT_SUGGESTION_PR_LABEL, source: 'default', branch };
  switch (content.kind) {
    case 'absent':
      return fallback;
    case 'not-a-file':
      return invalid(`it is ${content.entry}, not a file`);
    case 'too-large':
      return invalid(`it is larger than ${String(MAX_CONFIGURATION_BYTES)} bytes`);
    case 'file':
      break;
  }
  let text: string;
  try {
    // A leading byte-order mark is allowed and not part of the JSON.
    text = new TextDecoder('utf-8', { fatal: true }).decode(content.bytes);
  } catch {
    return invalid('it is not UTF-8 text');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid('it is not valid JSON');
  }
  if (!isJsonObject(parsed)) return invalid('it is not a JSON object');
  // Other members are ignored, so later versions of the convention can add them.
  if (!Object.hasOwn(parsed, 'label')) return fallback;
  const label = parsed['label'];
  if (typeof label !== 'string') return invalid('its `label` is not a string');
  const problem = labelProblem(label);
  if (problem !== null) return invalid(problem);
  return { status: 'resolved', label, source: 'repository', branch };
}

/** `labels` without later case-insensitive repeats, keeping the first spelling of each. */
export function uniqueLabels(labels: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(label);
  }
  return unique;
}

/** The labels a suggestion carries: the canonical label, then the extras not already present (case-insensitively). */
export function combineLabels(canonical: string, extras: readonly string[]): string[] {
  return uniqueLabels([canonical, ...extras]);
}

/** A code span of plain text (no backticks can occur in the names this module formats). */
function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

/** The sentence naming an invalid configuration: its file, branch, repository and problem. */
export function configurationProblem(repository: string, branch: string, detail: string): string {
  return `The suggestion pull request configuration ${code(SUGGESTION_PR_CONFIGURATION_PATH)} on the default branch ${code(branch)} of ${repository} is invalid: ${detail}.`;
}

/** How a Markdown line names where the canonical label came from. */
export function labelSourceText(source: LabelSource, branch: string): string {
  return source === 'default'
    ? 'the default suggestion label'
    : `the suggestion label set in ${code(SUGGESTION_PR_CONFIGURATION_PATH)} on ${code(branch)}`;
}
