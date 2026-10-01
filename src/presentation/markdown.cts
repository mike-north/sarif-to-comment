/**
 * Markdown primitives shared by every review presentation component (private
 * internal module).
 *
 * These are the low-level building blocks that make rendered text say
 * exactly what it means on GitHub: literal plain text, code spans and fenced
 * blocks that no content can close early, and line-range wording. They encode
 * GitHub Flavored Markdown rules only; what a review says, and in which
 * order, is the business of the components (src/presentation/*.cts) and of
 * preparation.
 *
 * The module also reads Markdown back, conservatively (a hand-written
 * profile, not a complete parser): where fences, code spans and indented
 * code are as CommonMark reads them, and where text is concealed — inside a
 * comment, CDATA section, processing instruction or declaration, a tag, a
 * link destination or title, an image description, a link reference
 * definition, or an element GitHub does not display. Preparation uses it to
 * refuse producer Markdown that could open a native suggestion block or leave
 * a fence or raw HTML open; presentation customization uses it to make sure
 * a callback shows every required fragment as itself. Where the profile
 * cannot tell, it errs towards reporting a problem.
 *
 * @see https://spec.commonmark.org/0.31.2/#backslash-escapes
 * @see https://spec.commonmark.org/0.31.2/#code-spans
 * @see https://spec.commonmark.org/0.31.2/#fenced-code-blocks
 * @see https://spec.commonmark.org/0.31.2/#indented-code-blocks
 * @see https://spec.commonmark.org/0.31.2/#block-quotes
 * @see https://spec.commonmark.org/0.31.2/#list-items
 * @see https://spec.commonmark.org/0.31.2/#raw-html
 * @see https://spec.commonmark.org/0.31.2/#link-reference-definitions
 * @see https://github.github.com/gfm/#disallowed-raw-html-extension-
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

// ---------------------------------------------------------------------------
// Reading Markdown structure

/**
 * A stretch of Markdown text with a structural role:
 *   - code, shown literally: 'fence' (from its opening fence marker to the end
 *     of its closing line, or of its last line when its block quote or list
 *     item ends first), 'code-span' (delimiters included) and
 *     'indented-code' (one line's content);
 *   - concealment, not shown as text: 'html-tag' (a whole start or end tag,
 *     attributes included), 'html-comment', 'html-cdata', 'html-instruction',
 *     'html-declaration', 'hidden-element' (an element GitHub does not
 *     display, or one with a `hidden` or `style` attribute, from its start
 *     tag through its end tag), 'link-destination' (the parenthesized
 *     destination and title of an inline link or image),
 *     'image-description' (an image's `![…]`) and
 *     'link-reference-definition' (its whole line).
 * Offsets index the Markdown string; `end` is exclusive.
 */
export interface IMarkdownRegion {
  readonly kind: MarkdownRegionKind;
  readonly start: number;
  readonly end: number;
}

/** The structural roles {@link IMarkdownRegion} distinguishes. */
export type MarkdownRegionKind =
  | 'fence' | 'code-span' | 'indented-code'
  | 'html-tag' | 'html-comment' | 'html-cdata' | 'html-instruction' | 'html-declaration' | 'hidden-element'
  | 'link-destination' | 'image-description' | 'link-reference-definition';

/** Regions that hide what they contain from the rendered text and are not code or tags. */
const CONCEALING_CONSTRUCTS: ReadonlySet<MarkdownRegionKind> = new Set([
  'html-comment', 'html-cdata', 'html-instruction', 'html-declaration', 'link-reference-definition',
]);

/** Elements whose content GitHub does not show as text (removed, or not rendered as text). */
const UNDISPLAYED_ELEMENTS: ReadonlySet<string> = new Set([
  'script', 'style', 'template', 'noscript', 'title', 'head', 'iframe', 'object', 'embed', 'svg', 'math', 'select', 'option', 'textarea', 'xmp', 'noembed', 'noframes',
]);

/** One line of Markdown without its terminator, with its offsets. */
interface ILine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function linesOf(markdown: string): ILine[] {
  const lines: ILine[] = [];
  const terminator = /\r\n|\n|\r/g;
  let start = 0;
  for (let match = terminator.exec(markdown); match; match = terminator.exec(markdown)) {
    lines.push({ text: markdown.slice(start, match.index), start, end: match.index });
    start = match.index + match[0].length;
  }
  lines.push({ text: markdown.slice(start), start, end: markdown.length });
  return lines;
}

/** The width in columns of leading whitespace (a tab advances to the next multiple of four). */
function columnsOf(whitespace: string): number {
  let column = 0;
  for (const c of whitespace) column = c === '\t' ? column + 4 - (column % 4) : column + 1;
  return column;
}

function leadingWhitespace(text: string): string {
  return /^[ \t]*/.exec(text)?.[0] ?? '';
}

/** `text` without its first `columns` columns of indentation (fewer when it has fewer). */
function withoutColumns(text: string, columns: number): string {
  let column = 0;
  let index = 0;
  while (index < text.length && column < columns && (text[index] === ' ' || text[index] === '\t')) {
    column = text[index] === '\t' ? column + 4 - (column % 4) : column + 1;
    index += 1;
  }
  return text.slice(index);
}

/** Up to `max` block quote markers at the start of a line: how many, and how many characters they take. */
function quotePrefix(text: string, max = Number.POSITIVE_INFINITY): { readonly depth: number; readonly length: number } {
  let depth = 0;
  let length = 0;
  while (depth < max) {
    const marker = /^ {0,3}>[ \t]?/.exec(text.slice(length));
    if (!marker) break;
    depth += 1;
    length += marker[0].length;
  }
  return { depth, length };
}

/** A list item marker and the whitespace after it. */
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)[ \t]*/;

/** An opening fence: three or more backticks or tildes, and an info string. */
const OPENING_FENCE = /^(`{3,}|~{3,})(.*)$/;

/**
 * A line, after any block quote markers, that ends a paragraph (so no code
 * span continues across it): an ATX heading, a block quote, an HTML block
 * start (any `<`), a table row, a list item, a fence, a thematic break or a
 * setext underline.
 */
const INTERRUPTING_LINE = /^ {0,3}(?:#|>|<|\||[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$|=+[ \t]*$)/;

/**
 * Whether a line could open a native `suggestion` block, read leniently:
 * after block quote markers, list markers and any indentation, with
 * backticks or tildes of any length, in any fence state.
 */
function opensSuggestion(text: string): boolean {
  let core = text;
  for (let previous: string | undefined; previous !== core;) {
    previous = core;
    core = core.replace(/^[ \t]*(?:>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/, '');
  }
  const fence = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(core);
  return fence !== null && /^suggestion/i.test((fence[2] ?? '').trim());
}

/** A fence being read: its marker, its container, and where it started. */
interface IOpenFence {
  readonly character: string;
  readonly length: number;
  readonly quoteDepth: number;
  readonly contentIndent: number;
  readonly start: number;
  lastEnd: number;
}

/** The block structure of Markdown, as far as code is concerned. */
interface IBlockScan {
  readonly suggestion: boolean;
  readonly unclosed: boolean;
  readonly regions: readonly IMarkdownRegion[];
  /** Indexes of lines that are code (fenced or indented): no code span crosses them. */
  readonly codeLines: ReadonlySet<number>;
  readonly lines: readonly ILine[];
}

/**
 * Fences and indented code as CommonMark reads them: an opening fence has at
 * most three columns of indentation inside its block quotes and list item; a
 * closing fence has at most three, in the same container, uses the opening
 * character, is at least as long and has nothing after it; and a fence ends
 * with its block quote (a line with fewer `>` markers) or list item (a
 * non-blank line indented less than the item's content). A fence still open
 * at the end of the Markdown is unclosed.
 */
function scanBlocks(markdown: string): IBlockScan {
  const lines = linesOf(markdown);
  const regions: IMarkdownRegion[] = [];
  const codeLines = new Set<number>();
  let open: IOpenFence | null = null;
  let suggestion = false;
  let previousBlank = true;
  let previousIndentedCode = false;
  for (const [index, line] of lines.entries()) {
    if (opensSuggestion(line.text)) suggestion = true;
    if (open) {
      const quote = quotePrefix(line.text, open.quoteDepth);
      let rest = line.text.slice(quote.length);
      let ended = quote.depth < open.quoteDepth;
      if (!ended && open.contentIndent > 0 && rest.trim() !== '') {
        if (columnsOf(leadingWhitespace(rest)) < open.contentIndent) ended = true;
        else rest = withoutColumns(rest, open.contentIndent);
      }
      if (!ended) {
        codeLines.add(index);
        const indent = leadingWhitespace(rest);
        const marker = /^(`{3,}|~{3,})[ \t]*$/.exec(rest.slice(indent.length))?.[1];
        if (columnsOf(indent) <= 3 && marker !== undefined && marker[0] === open.character && marker.length >= open.length) {
          regions.push({ kind: 'fence', start: open.start, end: line.end });
          open = null;
        } else {
          open.lastEnd = line.end;
        }
        previousBlank = false;
        previousIndentedCode = false;
        continue;
      }
      regions.push({ kind: 'fence', start: open.start, end: open.lastEnd });
      open = null;
    }
    const quote = quotePrefix(line.text);
    let rest = line.text.slice(quote.length);
    let consumed = quote.length;
    let listIndent = 0;
    for (let item = LIST_MARKER.exec(rest); item && item[0] !== ''; item = LIST_MARKER.exec(rest)) {
      listIndent += columnsOf(item[0]);
      consumed += item[0].length;
      rest = rest.slice(item[0].length);
    }
    const indent = leadingWhitespace(rest);
    const opening = OPENING_FENCE.exec(rest.slice(indent.length));
    const marker = opening?.[1];
    if (columnsOf(indent) <= 3 && marker !== undefined && !(marker.startsWith('`') && (opening?.[2] ?? '').includes('`'))) {
      open = {
        character: marker[0] ?? '`', length: marker.length, quoteDepth: quote.depth, contentIndent: listIndent,
        start: line.start + consumed + indent.length, lastEnd: line.end,
      };
      codeLines.add(index);
      previousBlank = false;
      previousIndentedCode = false;
      continue;
    }
    const blank = rest.trim() === '';
    const indentedCode: boolean = !blank && quote.depth === 0 && listIndent === 0 && columnsOf(indent) >= 4 && (previousBlank || previousIndentedCode);
    if (indentedCode) {
      regions.push({ kind: 'indented-code', start: line.start + consumed + indent.length, end: line.end });
      codeLines.add(index);
    }
    previousBlank = blank;
    previousIndentedCode = indentedCode;
  }
  if (open) regions.push({ kind: 'fence', start: open.start, end: open.lastEnd });
  return { suggestion, unclosed: open !== null, regions, codeLines, lines };
}

/**
 * Code spans as CommonMark reads them, within each run of lines that can
 * form one paragraph: a backtick string preceded by an odd number of
 * backslashes starts with a literal backtick; a span closes at the next
 * backtick string of exactly the same length; and no span continues past a
 * blank line, a code line, a line that interrupts a paragraph, or a deeper
 * block quote. An unmatched backtick string is literal.
 */
function codeSpans(markdown: string, blocks: IBlockScan): IMarkdownRegion[] {
  const runs: ILine[][] = [];
  let current: ILine[] = [];
  let depth = 0;
  for (const [index, line] of blocks.lines.entries()) {
    const quote = quotePrefix(line.text);
    const rest = line.text.slice(quote.length);
    const separator = blocks.codeLines.has(index) || rest.trim() === '';
    if (separator || quote.depth > depth || (current.length > 0 && INTERRUPTING_LINE.test(rest))) {
      if (current.length > 0) runs.push(current);
      current = [];
    }
    depth = quote.depth;
    if (!separator) current.push(line);
  }
  if (current.length > 0) runs.push(current);
  const spans: IMarkdownRegion[] = [];
  for (const run of runs) {
    const first = run[0];
    const last = run[run.length - 1];
    if (first === undefined || last === undefined) continue;
    const text = markdown.slice(first.start, last.end);
    const ticks = /`+/g;
    for (let match = ticks.exec(text); match; match = ticks.exec(text)) {
      const opener = escaped(text, match.index) ? match[0].slice(1) : match[0];
      if (opener === '') continue;
      const openAt = match.index + match[0].length - opener.length;
      const closing = new RegExp(`(?<!\`)\`{${String(opener.length)}}(?!\`)`, 'g');
      closing.lastIndex = match.index + match[0].length;
      const close = closing.exec(text);
      if (!close) continue;
      spans.push({ kind: 'code-span', start: first.start + openAt, end: first.start + close.index + opener.length });
      ticks.lastIndex = close.index + opener.length;
    }
  }
  return spans;
}

/** Fences, indented code and code spans, with the block scan they came from. */
function codeLayout(markdown: string): { readonly blocks: IBlockScan; readonly code: readonly IMarkdownRegion[] } {
  const blocks = scanBlocks(markdown);
  return { blocks, code: [...blocks.regions, ...codeSpans(markdown, blocks)] };
}

/**
 * Markdown with its fenced code and code spans blanked to spaces (line
 * breaks kept, offsets unchanged), since their contents are literal.
 * Indented code is not blanked: reading it as Markdown only finds more.
 */
function outsideCode(markdown: string, code: readonly IMarkdownRegion[]): string {
  const units = markdown.split('');
  for (const region of code) {
    if (region.kind === 'indented-code') continue;
    for (let i = region.start; i < region.end; i += 1) if (units[i] !== '\n' && units[i] !== '\r') units[i] = ' ';
  }
  return units.join('');
}

/**
 * What a conservative fence profile finds wrong with Markdown that other
 * content follows:
 *   - 'suggestion-fence': a line that could open a `suggestion` fence — after
 *     block quote markers, list markers and any indentation, with backticks or
 *     tildes of any length and in any fence state. Only a validated SARIF fix
 *     may create a native suggestion.
 *   - 'unclosed-fence': a fence left open (see scanBlocks for what closes
 *     one). An unclosed fence would swallow everything after it: the
 *     attribution, later findings, a generated suggestion block or a marker.
 */
export function fenceProblem(markdown: string): 'suggestion-fence' | 'unclosed-fence' | null {
  const blocks = scanBlocks(markdown);
  if (blocks.suggestion) return 'suggestion-fence';
  return blocks.unclosed ? 'unclosed-fence' : null;
}

/** HTML constructs: comments, processing instructions, CDATA, declarations and tags. */
const HTML_TOKEN = /<!--|<\?|<!\[CDATA\[|<![A-Za-z]|<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/g;

/** Whether the character at `index` is escaped by an odd number of backslashes. */
function escaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** One HTML construct outside code, and whether it was terminated. */
interface IHtmlToken {
  readonly kind: 'html-tag' | 'html-comment' | 'html-cdata' | 'html-instruction' | 'html-declaration';
  readonly start: number;
  /** Exclusive; the end of the text when unterminated. */
  readonly end: number;
  readonly terminated: boolean;
  /** A tag's lowercase element name. */
  readonly name?: string;
  readonly closing?: boolean;
}

/** HTML tokens of code-blanked text, in order, up to the first unterminated one. */
function htmlTokens(text: string): IHtmlToken[] {
  const tokens: IHtmlToken[] = [];
  const pattern = new RegExp(HTML_TOKEN.source, 'g');
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (escaped(text, match.index)) continue;
    // Groups 1 and 2 participate only in the tag alternative.
    const [opener, slash, name] = match;
    const [kind, terminator]: readonly [IHtmlToken['kind'], string] = opener === '<!--' ? ['html-comment', '-->']
      : opener === '<?' ? ['html-instruction', '?>']
        : opener === '<![CDATA[' ? ['html-cdata', ']]>']
          : name === undefined ? ['html-declaration', '>'] : ['html-tag', '>'];
    const at = text.indexOf(terminator, match.index + opener.length);
    const end = at === -1 ? text.length : at + terminator.length;
    tokens.push({ kind, start: match.index, end, terminated: at !== -1, ...(name === undefined ? {} : { name: name.toLowerCase(), closing: slash === '/' }) });
    if (at === -1) break;
    pattern.lastIndex = end;
  }
  return tokens;
}

/** The opener a construct's refusal names. */
function openerOf(kind: IHtmlToken['kind']): string {
  const openers: Readonly<Record<IHtmlToken['kind'], string>> = {
    'html-comment': '<!--', 'html-instruction': '<?', 'html-cdata': '<![CDATA[', 'html-declaration': '<!', 'html-tag': '<',
  };
  return openers[kind];
}

/** Whether a start tag closes itself (`<br/>`). */
function selfClosing(markdown: string, token: IHtmlToken): boolean {
  return markdown.slice(token.start, token.end - 1).endsWith('/');
}

/**
 * A conservative raw-HTML profile (not an HTML parser): what Markdown leaves
 * open, worded to follow "leaves … open" (for example "a <details>
 * element"), or null. Outside fenced code and code spans (as CommonMark
 * reads them, see codeSpans), every comment, processing instruction, CDATA
 * section, declaration and tag must be terminated, and non-void elements must
 * be closed in order within the same string. Anything left open could hide
 * whatever follows when rendered. Backslash-escaped `<` is literal.
 */
export function unbalancedHtml(markdown: string): string | null {
  const { code } = codeLayout(markdown);
  const stack: string[] = [];
  for (const token of htmlTokens(outsideCode(markdown, code))) {
    if (!token.terminated) {
      return token.name === undefined ? `an HTML ${openerOf(token.kind)} construct` : `a <${token.closing === true ? '/' : ''}${token.name}> tag`;
    }
    if (token.name === undefined) continue;
    if (token.closing === true) {
      if (stack.pop() !== token.name) return `an unmatched </${token.name}> tag`;
    } else if (!VOID_ELEMENTS.has(token.name) && !selfClosing(markdown, token)) {
      stack.push(token.name);
    }
  }
  return stack.length > 0 ? `a <${String(stack[stack.length - 1])}> element` : null;
}

/**
 * Every region of `markdown` (see IMarkdownRegion): code as CommonMark reads
 * it, and, outside code, HTML constructs, elements GitHub does not display
 * or that carry a `hidden` or `style` attribute, inline link and image
 * destinations and titles, image descriptions and link reference definitions.
 */
export function markdownRegions(markdown: string): IMarkdownRegion[] {
  const { blocks, code } = codeLayout(markdown);
  const text = outsideCode(markdown, code);
  const regions: IMarkdownRegion[] = [...code];
  const elements: { readonly name: string; readonly start: number; readonly hides: boolean }[] = [];
  for (const token of htmlTokens(text)) {
    regions.push({ kind: token.kind, start: token.start, end: token.end });
    if (token.name === undefined || !token.terminated) continue;
    if (token.closing === true) {
      const element = elements.pop();
      if (element !== undefined && element.name === token.name && element.hides) regions.push({ kind: 'hidden-element', start: element.start, end: token.end });
    } else if (!VOID_ELEMENTS.has(token.name) && !selfClosing(markdown, token)) {
      const hides = UNDISPLAYED_ELEMENTS.has(token.name) || /\s(?:hidden|style)\b/i.test(markdown.slice(token.start, token.end));
      elements.push({ name: token.name, start: token.start, hides });
    }
  }
  regions.push(...linkRegions(text));
  for (const [index, line] of blocks.lines.entries()) {
    if (blocks.codeLines.has(index)) continue;
    const content = text.slice(line.start, line.end).slice(quotePrefix(line.text).length);
    if (/^ {0,3}\[(?:[^\]\\]|\\.)+\]:/.test(content)) regions.push({ kind: 'link-reference-definition', start: line.start, end: line.end });
  }
  return regions;
}

/** Inline link and image destinations with their titles, and image descriptions, in code-blanked text. */
function linkRegions(text: string): IMarkdownRegion[] {
  const regions: IMarkdownRegion[] = [];
  for (let at = text.indexOf(']('); at !== -1; at = text.indexOf('](', at + 1)) {
    if (escaped(text, at)) continue;
    const end = closingParenthesis(text, at + 1);
    if (end !== -1) regions.push({ kind: 'link-destination', start: at + 1, end: end + 1 });
  }
  for (let at = text.indexOf('!['); at !== -1; at = text.indexOf('![', at + 1)) {
    if (escaped(text, at)) continue;
    const end = closingBracket(text, at + 1);
    if (end !== -1) regions.push({ kind: 'image-description', start: at, end: end + 1 });
  }
  return regions;
}

/** The index of the `]` that closes the `[` at `open`, skipping escapes and stopping at a blank line, or -1. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text.startsWith('\n\n', i)) return -1;
    const c = text[i];
    if (c === '\\') {
      i += 1;
    } else if (c === '[') {
      depth += 1;
    } else if (c === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The index of the `)` that closes the `(` at `open`, skipping quoted titles and escapes, or -1. */
function closingParenthesis(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    if (text.startsWith('\n\n', i)) return -1;
    const c = text[i];
    if (c === '\\') {
      i += 1;
    } else if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The concealing constructs in `markdown` outside code — HTML comments,
 * CDATA sections, processing instructions, declarations and link reference
 * definitions — each with its kind and exact text.
 */
export function concealingConstructs(markdown: string): { readonly kind: MarkdownRegionKind; readonly text: string }[] {
  return markdownRegions(markdown)
    .filter((region) => CONCEALING_CONSTRUCTS.has(region.kind))
    .map((region) => ({ kind: region.kind, text: markdown.slice(region.start, region.end) }));
}

/**
 * Whether `markdown` shows `fragment` as itself somewhere: an occurrence
 * whose surroundings neither conceal it (it lies in no comment, CDATA
 * section, processing instruction, declaration, tag, link destination or
 * title, image description, link reference definition or undisplayed
 * element) nor change its code (no code span, fence or indented code reaches
 * into it from outside, and its own code reads the same in place).
 * Formally: the regions of `markdown` that overlap the occurrence are
 * exactly the fragment's own regions, shifted to it. A fragment that is a
 * URL may also be exactly the destination of an inline link.
 */
export function showsAsItself(markdown: string, fragment: string): boolean {
  if (fragment === '') return true;
  const whole = markdownRegions(markdown);
  const own = markdownRegions(fragment);
  const url = /^https?:\/\/\S+$/.test(fragment);
  for (let at = markdown.indexOf(fragment); at !== -1; at = markdown.indexOf(fragment, at + 1)) {
    const end = at + fragment.length;
    const overlapping = whole.filter((r) => r.start < end && r.end > at);
    const shifted = own.map((r) => ({ kind: r.kind, start: r.start + at, end: r.end + at }));
    const same = overlapping.length === shifted.length
      && overlapping.every((r) => shifted.some((o) => o.kind === r.kind && o.start === r.start && o.end === r.end));
    if (same) return true;
    const asDestination = url && own.length === 0 && overlapping.length === 1 && overlapping[0]?.kind === 'link-destination'
      && markdown[at - 1] === '(' && /^[)\s]/.test(markdown.slice(end, end + 1));
    if (asDestination) return true;
  }
  return false;
}
