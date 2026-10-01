/**
 * Markdown primitives shared by every review presentation component (private
 * internal module).
 *
 * These are the low-level building blocks that make rendered text say
 * exactly what it means on GitHub: literal plain text, code spans and fenced
 * blocks that no content can close early, and line-range wording. They encode
 * GitHub Flavored Markdown rules only; what a review says, and in which
 * order, is the business of the components (src/presentation/*.cts) and of
 * preparation. Reading Markdown back is src/presentation/markdown-tree.cts.
 *
 * @see https://spec.commonmark.org/0.31.2/#backslash-escapes
 * @see https://github.github.com/gfm/#fenced-code-blocks
 * @see https://github.github.com/gfm/#code-spans
 */

/** Separator between findings that share a comment or section, and between general body sections. */
export const SEPARATOR = '\n\n---\n\n';

/**
 * A GitHub-style @mention in plain text: a user or org/team handle not
 * preceded by a word character (so email addresses are excluded).
 */
const MENTION = /(?<![A-Za-z0-9_`])(@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?)/;

/** Characters that CommonMark/GFM may interpret anywhere in a line of plain text. */
const INLINE_MARKDOWN = /[\\`*_[\]<>#!|~{}&]/g;

/** "line N" or "lines N-M": whole lines of one file, as every presentation names them. */
export function lineSpan(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${String(startLine)}` : `lines ${String(startLine)}-${String(endLine)}`;
}

/**
 * Plain text rendered literally: Markdown-significant characters are
 * backslash-escaped, line-start block markers neutralized, line breaks kept
 * as hard breaks and blank-line paragraph breaks kept.
 */
export function escapePlain(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '').split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.split('\n').map(escapeLine).join('\\\n'))
    .join('\n\n');
}

/**
 * Plain text embedded within a rendered line (never at a line start), so only
 * inline Markdown syntax needs escaping.
 */
export function escapePlainInline(text: unknown): string {
  return escapeInline(String(text).replace(/\r?\n/g, ' '));
}

function escapeLine(line: string): string {
  return escapeInline(line)
    .replace(/^(\s*)([-+=])/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])/, '$1\\$2');
}

/**
 * Escapes inline Markdown syntax in plain text and renders plain-text
 * @mentions as code spans: the characters stay exact, but plain text never
 * turns into a notification when a person later submits the draft. (Host
 * mention handling inside code spans is not live-verified.)
 */
function escapeInline(text: string): string {
  return text.split(MENTION).map((part, i) => (i % 2 === 1 ? codeSpan(part) : part.replace(INLINE_MARKDOWN, '\\$&'))).join('');
}

/**
 * A fenced code block showing `text` literally: its backtick fence is one
 * longer than the longest backtick run inside, and never shorter than three,
 * so no line of the text can close it (GFM §4.5). `info`, when given, is the
 * fence's info string (a language name such as `diff`).
 */
export function fenced(text: string, info = ''): string {
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

/**
 * A CommonMark code span whose delimiter is longer than any backtick run
 * inside. Line breaks become spaces, as a code span renders them anyway, so
 * a value with line breaks (a rule id, a ref name) can never end the
 * paragraph the span is in and start a block of its own.
 */
export function codeSpan(value: string): string {
  const text = value.replace(/\r\n|\r|\n/g, ' ');
  const fence = '`'.repeat(longestRun(text, '`') + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function longestRun(text: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const c of text) {
    current = c === character ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

/** "U+XXXX" for a character, as diagnostics and visible escapes name it. */
export function codePointName(character: string): string {
  return `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * A character a reader cannot see as itself: a format character (Unicode
 * category Cf, which includes the bidirectional controls that reorder text,
 * inside code spans too) or U+00A0 — except a zero-width joiner between two
 * pictographs (after an optional variation selector), which joins an emoji
 * sequence.
 */
const UNSEEN = /(?<!\p{Extended_Pictographic}️?)‍|‍(?!\p{Extended_Pictographic})|(?!‍)[\p{Cf} ]/gu;

/**
 * Host text shown with every character a reader could not see replaced by a
 * visible escape, `{U+XXXX}`: nothing is dropped, and nothing can reorder or
 * hide what follows it. A zero-width joiner inside an emoji sequence is kept.
 */
export function visibleText(text: string): string {
  return text.replace(UNSEEN, (character) => `{${codePointName(character)}}`);
}

/**
 * Characters a rendered code block does not show as themselves: C0 controls
 * other than tab, LF and CR; DEL and C1 controls; every format character
 * (Unicode category Cf: a byte-order mark, the bidirectional marks,
 * embeddings, overrides and isolates, which reorder text invisibly,
 * zero-width spaces and joiners, the word joiner, the soft hyphen, tag
 * characters, …); U+00A0, which renders as an ordinary space; and the line
 * and paragraph separators. The one rule for every block of content: a
 * proposed file, an alternative and an edit made by hand refuse such a
 * character (docs/delivery-policy-contract.md §8.10), and a suggestion pull
 * request's own diff writes it as a visible escape (visibleCodeLine).
 */
export const UNSHOWN_IN_CODE_BLOCK = /[\p{Cf}\u00A0\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/u;

/**
 * What visibleCodeLine escapes: UNSHOWN_IN_CODE_BLOCK, a carriage return
 * (inside a line it does not end one), an unpaired surrogate (not text), and
 * a `{` that begins text reading as an escape.
 */
const ESCAPED_IN_CODE_LINE = new RegExp(`${UNSHOWN_IN_CODE_BLOCK.source}|\\r|[\\uD800-\\uDFFF]|\\{(?=U\\+[0-9A-F]{4,6}\\})`, 'gu');

/**
 * One line of content for a code block whose bytes are carried elsewhere
 * exactly (a suggestion pull request's commit), with every character the
 * block would not show as itself written as a visible escape, `{U+XXXX}`.
 * A `{` that begins literal text of that form is written `{U+007B}`, so
 * every escape in the result stands for exactly one character and the line
 * maps back to its characters without ambiguity. Unlike visibleText, a
 * zero-width joiner in an emoji sequence is escaped too: this is content,
 * where exactness outranks how a title reads.
 */
export function visibleCodeLine(line: string): string {
  return line.replace(ESCAPED_IN_CODE_LINE, (character) => `{${codePointName(character)}}`);
}
