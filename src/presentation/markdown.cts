/**
 * Markdown primitives shared by every review presentation component (private
 * internal module).
 *
 * These are the low-level building blocks that make rendered text say
 * exactly what it means on GitHub: literal plain text, code spans and fenced
 * blocks that no content can close early, line-range wording, and the
 * conservative scanners that find Markdown able to open a native suggestion
 * block, leave a fence open or leave raw HTML open. They encode GitHub
 * Flavored Markdown rules only; what a review says, and in which order, is
 * the business of the components (src/presentation/*.cts) and of preparation.
 *
 * @see https://spec.commonmark.org/0.31.2/#backslash-escapes
 * @see https://github.github.com/gfm/#fenced-code-blocks
 * @see https://github.github.com/gfm/#code-spans
 * @see https://github.github.com/gfm/#raw-html
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

/** HTML elements that never take a closing tag. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

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
 * so no line of the text can close it (GFM §4.5).
 */
export function fenced(text: string): string {
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** A CommonMark code span whose delimiter is longer than any backtick run inside. */
export function codeSpan(text: string): string {
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

/**
 * What a conservative, hand-written fence profile (not a complete Markdown
 * parser) finds wrong with Markdown that other content follows:
 *   - 'suggestion-fence': a line that could open a `suggestion` fence — after
 *     blockquote markers, list markers and indentation, with backticks or
 *     tildes of any length and in any fence state. Only a validated SARIF fix
 *     may create a native suggestion.
 *   - 'unclosed-fence': a fence left open (a closing fence uses the opening
 *     character, is at least as long and has no info string). An unclosed
 *     fence would swallow everything after it: the attribution, later
 *     findings, a generated suggestion block or a marker.
 */
export function fenceProblem(markdown: string): 'suggestion-fence' | 'unclosed-fence' | null {
  let open: string | null = null;
  for (const line of markdown.split(/\r\n|\n|\r/)) {
    let core = line;
    for (let previous: string | undefined; previous !== core;) {
      previous = core;
      core = core.replace(/^[ \t]*(?:>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/, '');
    }
    const fence = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(core);
    if (!fence) continue;
    const marker = groupOf(fence, 1);
    const rest = groupOf(fence, 2);
    const info = rest.trim();
    if (/^suggestion/i.test(info)) return 'suggestion-fence';
    if (open) {
      if (marker[0] === open[0] && marker.length >= open.length && info === '') open = null;
    } else if (!(marker[0] === '`' && rest.includes('`'))) {
      open = marker;
    }
  }
  return open ? 'unclosed-fence' : null;
}

/**
 * A conservative, hand-written raw-HTML profile (not an HTML parser): what
 * Markdown leaves open, worded to follow "leaves … open" (for example "a
 * <details> element"), or null. Outside fenced code and code spans, every
 * comment, processing instruction, CDATA section, declaration and tag must be
 * terminated, and non-void elements must be closed in order within the same
 * string. Anything left open could hide whatever follows when rendered.
 * Backslash-escaped `<` is literal.
 */
export function unbalancedHtml(markdown: string): string | null {
  const text = markdownOutsideCode(markdown);
  const stack: string[] = [];
  const token = /<!--|<\?|<!\[CDATA\[|<![A-Za-z]|<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/g;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    let backslashes = 0;
    for (let i = match.index - 1; i >= 0 && text[i] === '\\'; i -= 1) backslashes += 1;
    if (backslashes % 2 === 1) continue;
    // Groups 1 and 2 participate only in the tag alternative.
    const [opener, slash, name] = match;
    const terminator = opener === '<!--' ? '-->' : opener === '<?' ? '?>' : opener === '<![CDATA[' ? ']]>' : '>';
    const end = text.indexOf(terminator, match.index + opener.length);
    if (end === -1) return name ? `a <${String(slash)}${name}> tag` : `an HTML ${opener} construct`;
    token.lastIndex = end + terminator.length;
    if (!name) continue;
    const element = name.toLowerCase();
    if (slash) {
      if (stack.pop() !== element) return `an unmatched </${element}> tag`;
    } else if (!VOID_ELEMENTS.has(element) && !text.slice(match.index, end).endsWith('/')) {
      stack.push(element);
    }
  }
  return stack.length > 0 ? `a <${String(stack[stack.length - 1])}> element` : null;
}

/**
 * Markdown with fenced code blocks and code spans blanked out, since their
 * contents are literal. Fence recognition matches {@link fenceProblem}.
 */
function markdownOutsideCode(markdown: string): string {
  const kept: string[] = [];
  let open: string | null = null;
  for (const line of markdown.split(/\r\n|\n|\r/)) {
    let core = line;
    for (let previous: string | undefined; previous !== core;) {
      previous = core;
      core = core.replace(/^[ \t]*(?:>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/, '');
    }
    const fence = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(core);
    if (fence) {
      const marker = groupOf(fence, 1);
      const rest = groupOf(fence, 2);
      if (open) {
        if (marker[0] === open[0] && marker.length >= open.length && rest.trim() === '') open = null;
      } else if (!(marker[0] === '`' && rest.includes('`'))) {
        open = marker;
      }
      continue;
    }
    if (!open) kept.push(line);
  }
  return kept.join('\n').replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ' ');
}

/** A capture group that participates in every match of its expression. */
function groupOf(match: RegExpExecArray, index: number): string {
  const group = match[index];
  if (group === undefined) throw new Error(`Internal error: capture group ${String(index)} did not participate in the match.`);
  return group;
}
