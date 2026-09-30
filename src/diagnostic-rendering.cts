/**
 * The human view of diagnostics (docs/diagnostics.md, "--format human"): one
 * block per diagnostic and a closing summary line, for a terminal or a file.
 *
 * Layout never depends on color: the text is laid out and wrapped first, and
 * a style then only decorates fixed tokens (badge, title, code, location,
 * arrow, counts). Whether to use color is decided by {@link shouldUseColor};
 * colors come from chalk, an ES module loaded with `import()` only when color
 * is on (docs/diagnostics.md, "Dependencies").
 */

import { orderDiagnostics } from './diagnostics.cjs';
import type { DiagnosticSeverity, IDiagnostic, IDiagnosticLocation } from './public-types.cjs';

/** How the fixed tokens of a block are decorated. Every function returns its text, decorated. */
export interface IDiagnosticStyle {
  readonly badge: (severity: DiagnosticSeverity, text: string) => string;
  readonly title: (text: string) => string;
  readonly code: (text: string) => string;
  readonly location: (text: string) => string;
  readonly arrow: (text: string) => string;
  readonly count: (severity: DiagnosticSeverity, text: string) => string;
}

const identity = (text: string): string => text;

/** No decoration: plain text without escape sequences. */
export const PLAIN_STYLE: IDiagnosticStyle = Object.freeze({
  badge: (_severity: DiagnosticSeverity, text: string) => text,
  title: identity,
  code: identity,
  location: identity,
  arrow: identity,
  count: (_severity: DiagnosticSeverity, text: string) => text,
});

/**
 * The colored style: red errors, yellow warnings and blue notes, bold
 * titles, dim codes, cyan locations and green arrows. chalk's level is set
 * to basic colors explicitly, because the decision to color was already
 * made; chalk's own detection reads process.argv and ignores NO_COLOR.
 */
export async function loadColorStyle(): Promise<IDiagnosticStyle> {
  const { Chalk } = await import('chalk');
  const chalk = new Chalk({ level: 1 });
  const bySeverity: Readonly<Record<DiagnosticSeverity, (text: string) => string>> = {
    error: (text) => chalk.red(text),
    warning: (text) => chalk.yellow(text),
    note: (text) => chalk.blue(text),
  };
  return {
    badge: (severity, text) => bySeverity[severity](text),
    title: (text) => chalk.bold(text),
    code: (text) => chalk.dim(text),
    location: (text) => chalk.cyan(text),
    arrow: (text) => chalk.green(text),
    count: (severity, text) => bySeverity[severity](text),
  };
}

/** A `--color` value. */
export type ColorChoice = 'auto' | 'always' | 'never';

/**
 * Whether diagnostics are colored (docs/diagnostics.md, "Color"): `--color
 * always|never` first; then `FORCE_COLOR` (`0` or `false` off, any other
 * value, even empty, on), which Node.js also lets override `NO_COLOR`; then
 * a non-empty `NO_COLOR` off; otherwise only on a terminal whose TERM is not
 * `dumb`.
 */
export function shouldUseColor(choice: ColorChoice, env: Readonly<Record<string, string | undefined>>, isTTY: boolean): boolean {
  if (choice === 'always') return true;
  if (choice === 'never') return false;
  const force = env['FORCE_COLOR'];
  if (force !== undefined) return force !== '0' && force !== 'false';
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;
  return isTTY && env['TERM'] !== 'dumb';
}

/** How to render: the style, and the terminal width to wrap to (none: no wrapping). */
export interface IRenderOptions {
  readonly style: IDiagnosticStyle;
  readonly width?: number | undefined;
}

const BADGES: Readonly<Record<DiagnosticSeverity, string>> = { error: '✖ error', warning: '▲ warning', note: 'ℹ note' };
const NOUNS: Readonly<Record<DiagnosticSeverity, string>> = { error: 'error', warning: 'warning', note: 'note' };
const SEVERITIES: readonly DiagnosticSeverity[] = ['error', 'warning', 'note'];
const INDENT = '  ';
const ARROW_INDENT = '    ';

/** Splits text into user-perceived characters (extended grapheme clusters). */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * East Asian Wide and Fullwidth characters (Unicode UAX #11), which a
 * terminal shows in two columns: Hangul Jamo, CJK radicals, punctuation,
 * kana and ideographs, Yi, Hangul syllables, compatibility ideographs,
 * vertical and small forms, fullwidth forms, and the supplementary
 * ideographic planes.
 */
const EAST_ASIAN_WIDE = /[\u{1100}-\u{115F}\u{2E80}-\u{303E}\u{3041}-\u{33FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{A000}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE30}-\u{FE4F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u;

/** An emoji shown as a picture: emoji presentation by default, or requested with VS16. */
const EMOJI = /\p{Emoji_Presentation}|\u{FE0F}/u;

/**
 * The number of terminal columns `text` occupies: each grapheme cluster is
 * two columns when it is wide or an emoji, and one otherwise, so combining
 * marks and emoji modifiers add nothing. (UTF-16 length would count an
 * ideograph as one column and a toned emoji as four.)
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(text)) width += EAST_ASIAN_WIDE.test(segment) || EMOJI.test(segment) ? 2 : 1;
  return width;
}

/**
 * `text` wrapped greedily at spaces so that each line, with `first` or
 * `rest` before it, fits `width` columns, measured by {@link displayWidth}. A word longer than the width is
 * kept whole on its own line. Without a width the text is one line.
 */
function wrap(text: string, first: string, rest: string, width: number | undefined): string[] {
  if (width === undefined) return [`${first}${text}`];
  const words = text.split(' ').filter((word) => word !== '');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const prefix = lines.length === 0 ? first : rest;
    const candidate = current === '' ? word : `${current} ${word}`;
    if (current !== '' && displayWidth(prefix) + displayWidth(candidate) > width) {
      lines.push(`${prefix}${current}`);
      current = word;
    } else {
      current = candidate;
    }
  }
  lines.push(`${lines.length === 0 ? first : rest}${current}`);
  return lines;
}

/**
 * The message's lines, indented: each line of the Markdown is wrapped on its
 * own (keeping its leading spaces as part of the indent), except inside a
 * fenced code block, whose lines are kept whole. Blank lines stay blank.
 */
function messageLines(message: string, width: number | undefined): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const line of message.split(/\r\n|\n|\r/)) {
    const fence = /^\s*(```|~~~)/.test(line);
    if (line.trim() === '') {
      lines.push('');
    } else if (fenced || fence) {
      lines.push(`${INDENT}${line}`);
    } else {
      const lead = /^\s*/.exec(line)?.[0] ?? '';
      const indent = `${INDENT}${lead}`;
      lines.push(...wrap(line.slice(lead.length), indent, indent, width));
    }
    if (fence) fenced = !fenced;
  }
  return lines;
}

/** `path:line` or `path:start-end`, or the path alone. */
function pathText(location: IDiagnosticLocation): string | undefined {
  if (location.path === undefined) return undefined;
  const { startLine, endLine } = location;
  if (startLine === undefined) return location.path;
  return endLine === undefined || endLine === startLine ? `${location.path}:${String(startLine)}` : `${location.path}:${String(startLine)}-${String(endLine)}`;
}

/** The location line's parts: path and lines, pointer (not the whole document's empty pointer), subject. */
function whereParts(diagnostic: IDiagnostic): string[] {
  const location = diagnostic.location ?? {};
  const pointer = location.pointer === undefined || location.pointer === '' ? undefined : location.pointer;
  return [pathText(location), pointer, diagnostic.subject].filter((part): part is string => part !== undefined);
}

/** One diagnostic's block, without a trailing newline. */
function block(diagnostic: IDiagnostic, { style, width }: IRenderOptions): string {
  const header = `${style.badge(diagnostic.severity, BADGES[diagnostic.severity])}  ${style.title(diagnostic.title)}  ${style.code(`[${diagnostic.code}]`)}`;
  const lines = [header];
  const where = whereParts(diagnostic);
  if (where.length > 0) lines.push(`${INDENT}${style.location(where.join(' · '))}`);
  lines.push(...messageLines(diagnostic.message, width));
  for (const remedy of diagnostic.remedies ?? []) {
    const wrapped = wrap(remedy, `${INDENT}→ `, ARROW_INDENT, width);
    lines.push(...wrapped.map((line, i) => (i === 0 ? `${INDENT}${style.arrow('→')}${line.slice(INDENT.length + 1)}` : line)));
  }
  return lines.join('\n');
}

/** "1 error, 2 warnings": each severity present, in order. */
function summary(diagnostics: readonly IDiagnostic[], style: IDiagnosticStyle): string {
  return SEVERITIES.flatMap((severity) => {
    const count = diagnostics.filter((d) => d.severity === severity).length;
    if (count === 0) return [];
    return [style.count(severity, `${String(count)} ${NOUNS[severity]}${count === 1 ? '' : 's'}`)];
  }).join(', ');
}

/**
 * The human view of `diagnostics`: their blocks, ordered errors, warnings,
 * notes and separated by a blank line, then a blank line and the summary,
 * ending in a newline. Nothing at all when there are none.
 */
export function renderDiagnostics(diagnostics: readonly IDiagnostic[], options: IRenderOptions): string {
  if (diagnostics.length === 0) return '';
  const ordered = orderDiagnostics(diagnostics);
  return `${ordered.map((d) => block(d, options)).join('\n\n')}\n\n${summary(ordered, options.style)}\n`;
}
