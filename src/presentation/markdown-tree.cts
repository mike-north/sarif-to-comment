/**
 * Reading Markdown as GitHub will (private internal module).
 *
 * Producer Markdown in SARIF messages and caller Markdown from presentation
 * callbacks are followed, in every comment and body the tool writes, by
 * content the tool must keep intact and visible: the attribution, later
 * findings, a native suggestion block, a publication or suggestion marker.
 * This module answers, from a conformant CommonMark 0.31 + GFM parse
 * (micromark with its GFM extension, through mdast-util-from-markdown), the
 * questions those guarantees depend on:
 *   - fenceProblem: could the Markdown open a native suggestion block, or
 *     does it leave a fenced code block open, so that what follows becomes
 *     code?
 *   - unbalancedHtml: does it leave raw HTML open — a construct that runs to
 *     the end of the input, an unterminated tag, or an element that is never
 *     closed — so that what follows is hidden or swallowed?
 *   - addedConstruct: does a callback's result add raw HTML or a link
 *     reference definition that the built-in presentation does not contain?
 *   - showsAsItself: is a required fragment shown as itself, rather than
 *     concealed or turned into other code?
 *
 * Whether something "swallows what follows" is decided by parsing the
 * Markdown followed by a blank line and a probe paragraph, exactly the
 * boundary the tool always puts after it: the probe must come out as a
 * top-level paragraph.
 *
 * The parser decides what is code, text, raw HTML, a link, an image or a
 * definition. The hand-written parts are only those a Markdown parser cannot
 * answer: which elements the raw HTML opens and closes (GitHub passes raw
 * HTML through, so element balance is read from the html nodes' text, in
 * document order), and a deliberately lenient suggestion-opener check that
 * refuses any line that could open a `suggestion` fence in any container and
 * any fence state.
 *
 * Known limit: GitHub renders with cmark-gfm, which follows an older
 * CommonMark for some raw-HTML edge cases (for example `<!-->` and `--`
 * inside comments). Where it diverges from micromark, these checks follow
 * micromark; the divergence is recorded for a live check in
 * docs/review-presentation-contract.md §7.
 *
 * The parser packages are ES modules, loaded once with `import()` by
 * {@link loadMarkdownParser}; preparation awaits it before any check, and
 * every check is synchronous afterwards. A check called before loading is an
 * internal error.
 *
 * @see https://spec.commonmark.org/0.31.2/
 * @see https://github.github.com/gfm/
 * @see https://github.com/micromark/micromark
 * @see https://github.com/syntax-tree/mdast
 */

import type { Definition, Html, Nodes, Root } from 'mdast';

/** A parse of Markdown into an mdast tree, with source positions. */
type Parse = (markdown: string) => Root;

/** The loaded parser, once {@link loadMarkdownParser} has run. */
let parser: Parse | undefined;

/**
 * Loads the CommonMark + GFM parser (ES modules) once. Every check in this
 * module needs it; preparation awaits this before preparing anything.
 */
export async function loadMarkdownParser(): Promise<void> {
  if (parser !== undefined) return;
  const [{ fromMarkdown }, { gfmFromMarkdown }, { gfm }] = await Promise.all([
    import('mdast-util-from-markdown'),
    import('mdast-util-gfm'),
    import('micromark-extension-gfm'),
  ]);
  parser = (markdown) => fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

function parse(markdown: string): Root {
  if (parser === undefined) throw new Error('Internal error: the Markdown parser is not loaded; await loadMarkdownParser() first.');
  return parser(markdown);
}

/** A node of a parse with its source span (`end` exclusive) and its ancestors, outermost first. */
interface IPlacedNode {
  readonly node: Nodes;
  readonly start: number;
  readonly end: number;
  readonly ancestors: readonly Nodes[];
}

/** Every node of a tree but the root, in document order, with its span. Nodes without a position are skipped. */
function placedNodes(root: Root): IPlacedNode[] {
  const placed: IPlacedNode[] = [];
  const visit = (node: Nodes, ancestors: readonly Nodes[]): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type !== 'root' && start !== undefined && end !== undefined) placed.push({ node, start, end, ancestors });
    if ('children' in node) for (const child of node.children) visit(child, [...ancestors, node]);
  };
  visit(root, []);
  return placed;
}

// ---------------------------------------------------------------------------
// What follows the Markdown

/** A paragraph no Markdown can contain by accident (private-use delimiters). */
const PROBE = 'sarif-to-comment-probe';

/**
 * What, if anything, would swallow content that follows the Markdown after a
 * blank line: the outermost node (other than the root) that contains the
 * probe, unless the probe is its own top-level paragraph.
 */
function swallower(markdown: string): Nodes | null {
  const probeAt = markdown.length + 2;
  const root = parse(`${markdown}\n\n${PROBE}`);
  const containing = root.children.find((child) => (child.position?.start.offset ?? 0) <= probeAt && probeAt < (child.position?.end.offset ?? 0));
  if (containing === undefined) return null;
  const [only] = containing.type === 'paragraph' ? containing.children : [];
  if (containing.type === 'paragraph' && containing.children.length === 1 && only?.type === 'text' && only.value === PROBE) return null;
  return containing;
}

/**
 * Whether a line could open a native `suggestion` block, read leniently:
 * after block quote markers, list markers and any indentation, with
 * backticks or tildes of any length, in any fence state. Deliberately
 * broader than CommonMark: only a validated SARIF fix may create a native
 * suggestion, so nothing that any renderer could read as one is allowed.
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

/**
 * What a fence check finds wrong with Markdown that other content follows:
 *   - 'suggestion-fence': a line that could open a `suggestion` fence (see
 *     opensSuggestion). Only a validated SARIF fix may create a native
 *     suggestion.
 *   - 'unclosed-fence': content after the Markdown would be code, because a
 *     fenced code block (or another block) runs to the end of the input
 *     without its closing fence. It would swallow the attribution, later
 *     findings, a generated suggestion block or a marker.
 * Raw HTML that swallows what follows is unbalancedHtml's to report.
 */
export function fenceProblem(markdown: string): 'suggestion-fence' | 'unclosed-fence' | null {
  if (markdown.split(/\r\n|\n|\r/).some(opensSuggestion)) return 'suggestion-fence';
  const node = swallower(markdown);
  return node !== null && node.type !== 'html' ? 'unclosed-fence' : null;
}

// ---------------------------------------------------------------------------
// Raw HTML

/** HTML elements that never take a closing tag. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Elements whose content GitHub does not show as text (removed, or not rendered as text). */
const UNDISPLAYED_ELEMENTS: ReadonlySet<string> = new Set([
  'script', 'style', 'template', 'noscript', 'title', 'head', 'iframe', 'object', 'embed', 'svg', 'math', 'select', 'option', 'textarea', 'xmp', 'noembed', 'noframes',
]);

/** One construct in the text of an html node, with its offsets in the Markdown. */
interface IHtmlConstruct {
  readonly kind: 'comment' | 'instruction' | 'cdata' | 'declaration' | 'tag';
  readonly start: number;
  readonly end: number;
  readonly terminated: boolean;
  readonly name?: string;
  readonly closing?: boolean;
  /** Whether the element a start tag opens hides its content: undisplayed, or with a `hidden` or `style` attribute. */
  readonly hides?: boolean;
  /** An `<a>` start tag's `href`, when it has one. */
  readonly href?: string;
}

/** The constructs of one html node's text, in order, up to the first unterminated one. */
function constructsOf(value: string, offset: number): IHtmlConstruct[] {
  const constructs: IHtmlConstruct[] = [];
  const opener = /<!--|<\?|<!\[CDATA\[|<![A-Za-z]|<(\/?)([A-Za-z][A-Za-z0-9-]*)/g;
  for (let match = opener.exec(value); match; match = opener.exec(value)) {
    const [text, slash, name] = match;
    if (name === undefined) {
      // A comment closes at the first "-->", which may overlap its "<!--" (`<!-->`, CommonMark 0.31).
      const [kind, terminator, from]: readonly [IHtmlConstruct['kind'], string, number] = text === '<!--' ? ['comment', '-->', 2]
        : text === '<?' ? ['instruction', '?>', 2] : text === '<![CDATA[' ? ['cdata', ']]>', text.length] : ['declaration', '>', text.length];
      const at = value.indexOf(terminator, match.index + from);
      const end = at === -1 ? value.length : at + terminator.length;
      // GitHub's cmark-gfm follows CommonMark 0.29, under which `<!-->`,
      // `<!--->` and a comment containing `--` or ending in `-` are not
      // comments: the `<!--` is text, and the tags it seems to enclose are
      // raw HTML. Read such a comment both ways: its tags count.
      const inner = kind === 'comment' && at !== -1 ? value.slice(match.index + 4, Math.max(at, match.index + 4)) : '';
      const ambiguous = kind === 'comment' && at !== -1 && (at < match.index + 4 || inner.startsWith('>') || inner.startsWith('->') || inner.includes('--') || inner.endsWith('-'));
      if (ambiguous) {
        opener.lastIndex = match.index + text.length;
        continue;
      }
      constructs.push({ kind, start: offset + match.index, end: offset + end, terminated: at !== -1 });
      if (at === -1) break;
      opener.lastIndex = end;
      continue;
    }
    // A tag ends at the first ">" outside a quoted attribute value.
    let quote: string | null = null;
    let close = -1;
    for (let i = match.index + text.length; i < value.length; i += 1) {
      const c = value[i];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        close = i;
        break;
      }
    }
    const end = close === -1 ? value.length : close + 1;
    const body = value.slice(match.index, end);
    const element = name.toLowerCase();
    const href = element === 'a' ? /[\s/]href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(body) : null;
    const hrefValue = href === null ? undefined : href[1] ?? href[2] ?? href[3];
    constructs.push({
      kind: 'tag', start: offset + match.index, end: offset + end, terminated: close !== -1, name: element, closing: slash === '/',
      hides: UNDISPLAYED_ELEMENTS.has(element) || /[\s/](?:hidden|style)\b/i.test(body), ...(hrefValue === undefined ? {} : { href: hrefValue }),
    });
    if (close === -1) break;
    opener.lastIndex = end;
  }
  return constructs;
}

/** Every html node of a tree, in document order. */
function htmlNodes(root: Root): (IPlacedNode & { readonly node: Html })[] {
  return placedNodes(root).filter((placed): placed is IPlacedNode & { readonly node: Html } => placed.node.type === 'html');
}

/** A span of Markdown that one element covers, from its start tag through its end tag. */
interface IElementSpan {
  readonly start: number;
  readonly end: number;
}

/** What raw HTML does: its first imbalance, the elements that hide their content, and the `<a>` elements with their `href`. */
interface IElementWalk {
  readonly problem: string | null;
  readonly hidden: readonly IElementSpan[];
  readonly anchors: readonly (IElementSpan & { readonly href: string | undefined })[];
}

/**
 * The element balance of a tree's raw HTML, in document order. Only void
 * elements close themselves: as in HTML, a trailing `/>` on any other start
 * tag (`<details/>`) is ignored, and the element stays open.
 */
function elementWalk(root: Root): IElementWalk {
  const stack: { readonly name: string; readonly start: number; readonly hides: boolean; readonly href: string | undefined }[] = [];
  const hidden: IElementSpan[] = [];
  const anchors: (IElementSpan & { readonly href: string | undefined })[] = [];
  for (const { node, start } of htmlNodes(root)) {
    for (const construct of constructsOf(node.value, start)) {
      if (!construct.terminated) {
        return {
          problem: construct.kind === 'tag' ? `a <${construct.closing === true ? '/' : ''}${construct.name ?? ''}> tag` : `an HTML ${OPENERS[construct.kind]} construct`,
          hidden,
          anchors,
        };
      }
      if (construct.kind !== 'tag' || construct.name === undefined) continue;
      if (construct.closing === true) {
        const open = stack.pop();
        if (open?.name !== construct.name) return { problem: `an unmatched </${construct.name}> tag`, hidden, anchors };
        if (open.hides) hidden.push({ start: open.start, end: construct.end });
        if (open.name === 'a') anchors.push({ start: open.start, end: construct.end, href: open.href });
      } else if (!VOID_ELEMENTS.has(construct.name)) {
        stack.push({ name: construct.name, start: construct.start, hides: construct.hides === true, href: construct.href });
      }
    }
  }
  const open = stack[stack.length - 1];
  return { problem: open === undefined ? null : `a <${open.name}> element`, hidden, anchors };
}

/** The opener a refusal names for each non-tag construct. */
const OPENERS: Readonly<Record<Exclude<IHtmlConstruct['kind'], 'tag'>, string>> = {
  comment: '<!--', instruction: '<?', cdata: '<![CDATA[', declaration: '<!',
};

/**
 * What Markdown leaves open in raw HTML, worded to follow "leaves … open"
 * (for example "a <details> element"), or null. Raw HTML is what the parser
 * reads as html nodes — block and inline, in document order; text and code
 * never count. It leaves something open when an HTML block (a comment,
 * `<pre>`, `<script>` and the like) runs to the end of the input, when a
 * construct or tag in it is unterminated, or when a non-void element is not
 * closed, in order, within the same string. Anything left open could hide
 * or swallow what follows when rendered.
 */
export function unbalancedHtml(markdown: string): string | null {
  const node = swallower(markdown);
  if (node !== null && node.type === 'html') {
    const kind = /^<(!--|\?|!\[CDATA\[|!)/.exec(node.value)?.[1];
    if (kind !== undefined) return `an HTML <${kind} construct`;
    return `a <${(/^<([A-Za-z][A-Za-z0-9-]*)/.exec(node.value)?.[1] ?? '').toLowerCase()}> element`;
  }
  return elementWalk(parse(markdown)).problem;
}

// ---------------------------------------------------------------------------
// Presentation callbacks: what a result adds, and what it shows

/** Raw HTML and link reference definitions: constructs a callback may only pass through. */
function passThroughNodes(markdown: string): (IPlacedNode & { readonly node: Html | Definition })[] {
  return placedNodes(parse(markdown))
    .filter((placed): placed is IPlacedNode & { readonly node: Html | Definition } => placed.node.type === 'html' || placed.node.type === 'definition');
}

/**
 * The first raw HTML node or link reference definition in `result` whose
 * exact source text is not also such a node in `builtIn` (the component's
 * built-in Markdown), or undefined. A callback may pass through what the
 * presented content carries, never add its own.
 */
export function addedConstruct(result: string, builtIn: string): { readonly kind: 'html' | 'definition'; readonly text: string } | undefined {
  const carried = new Set(passThroughNodes(builtIn).map(({ start, end }) => builtIn.slice(start, end)));
  for (const { node, start, end } of passThroughNodes(result)) {
    const text = result.slice(start, end);
    if (!carried.has(text)) return { kind: node.type, text };
  }
  return undefined;
}

/** Containers whose content is shown as text, whatever wraps or follows it. */
const SHOWN_CONTAINERS: ReadonlySet<Nodes['type']> = new Set([
  'paragraph', 'heading', 'blockquote', 'list', 'listItem', 'emphasis', 'strong', 'delete', 'table', 'tableRow', 'tableCell', 'footnoteDefinition',
]);

/** The span of a link's text (its children), or null when it has none. */
function linkTextSpan(placed: IPlacedNode, all: readonly IPlacedNode[]): { readonly start: number; readonly end: number } | null {
  const children = all.filter((other) => other.ancestors[other.ancestors.length - 1] === placed.node);
  const first = children[0];
  const last = children[children.length - 1];
  return first === undefined || last === undefined ? null : { start: first.start, end: last.end };
}

/**
 * Whether `markdown` shows `fragment` as itself at some occurrence, read
 * from both parses (the whole Markdown, and the fragment alone):
 *   - every node of the whole that lies within the occurrence is one of the
 *     fragment's own nodes, at the same place and of the same type, so its
 *     own code, links and text read the same in place and nothing new
 *     appears inside it;
 *   - every node that contains the occurrence shows its content: a
 *     paragraph, heading, block quote, list, table, emphasis or the like; a
 *     text node, when the fragment alone is plain text; or a link, when the
 *     occurrence is in the link's text — except that a fragment that is a
 *     URL may not be the text of a link to somewhere else — or when the
 *     fragment is a URL and exactly the link's destination. Code, inline
 *     code, raw HTML, an image (its description or source), a definition or
 *     any other node containing it conceals it;
 *   - a node that crosses the occurrence's boundary is a shown container or
 *     text;
 *   - no element that hides its content (undisplayed, or with a `hidden` or
 *     `style` attribute) reaches into the occurrence from outside;
 *   - a fragment that is a URL is in no raw-HTML `<a>` whose `href` is
 *     something else (a link that goes elsewhere);
 *   - no `$` outside the occurrence, in a paragraph, heading or table cell
 *     that holds part of it, could make it GitHub math, which renders TeX and
 *     can hide text (`\phantom{}`); `$` in code does not count.
 */
export function showsAsItself(markdown: string, fragment: string): boolean {
  if (fragment === '') return true;
  const whole = parse(markdown);
  const wholeNodes = placedNodes(whole);
  const { hidden: hiddenSpans, anchors } = elementWalk(whole);
  const ownNodes = placedNodes(parse(fragment));
  const plainText = ownNodes.length === 2 && ownNodes.every((own) => (own.node.type === 'paragraph' || own.node.type === 'text') && own.start === 0 && own.end === fragment.length);
  const url = /^https?:\/\/\S+$/.test(fragment);
  for (let at = markdown.indexOf(fragment); at !== -1; at = markdown.indexOf(fragment, at + 1)) {
    const end = at + fragment.length;
    const shown = wholeNodes.every((placed) => {
      if (placed.end <= at || placed.start >= end) return true;
      if (at <= placed.start && placed.end <= end) {
        return ownNodes.some((own) => own.node.type === placed.node.type && own.start + at === placed.start && own.end + at === placed.end);
      }
      const contains = placed.start <= at && end <= placed.end;
      const { type } = placed.node;
      if (!contains) return SHOWN_CONTAINERS.has(type) || type === 'text';
      if (SHOWN_CONTAINERS.has(type)) return true;
      if (type === 'text') return plainText;
      if (placed.node.type === 'link' || placed.node.type === 'linkReference') {
        const text = linkTextSpan(placed, wholeNodes);
        const inText = text !== null && text.start <= at && end <= text.end;
        const destination = placed.node.type === 'link' ? placed.node.url : undefined;
        if (inText) return !url || destination === fragment;
        return url && destination === fragment;
      }
      return false;
    });
    const unhidden = hiddenSpans.every((span) => span.end <= at || span.start >= end || (at <= span.start && span.end <= end));
    const notElsewhere = !url || anchors.every((anchor) => anchor.end <= at || anchor.start >= end || anchor.href === fragment);
    if (shown && unhidden && notElsewhere && !mayBeMath(markdown, wholeNodes, at, end)) return true;
  }
  return false;
}

/** Blocks whose inline content GitHub may read as `$…$` math. */
const MATH_BLOCKS: ReadonlySet<Nodes['type']> = new Set(['paragraph', 'heading', 'tableCell']);

/**
 * Whether GitHub could read part of the occurrence [at, end) as math: some
 * paragraph, heading or table cell that holds part of it has an unescaped
 * `$` outside the occurrence and outside code. GitHub renders `$…$` and
 * `$$…$$` as TeX, which can hide text; the parser does not model it, so any
 * such `$` counts.
 */
function mayBeMath(markdown: string, nodes: readonly IPlacedNode[], at: number, end: number): boolean {
  return nodes.some((block) => {
    if (!MATH_BLOCKS.has(block.node.type) || block.end <= at || block.start >= end) return false;
    const code = nodes.filter((n) => n.node.type === 'inlineCode' && n.start >= block.start && n.end <= block.end);
    for (let i = block.start; i < block.end; i += 1) {
      if (markdown[i] !== '$' || (i >= at && i < end)) continue;
      if (code.some((span) => span.start <= i && i < span.end)) continue;
      let backslashes = 0;
      for (let j = i - 1; j >= block.start && markdown[j] === '\\'; j -= 1) backslashes += 1;
      if (backslashes % 2 === 0) return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Composed text: the checkpoint after every comment and body is composed

/** What a composed comment or body must end with, as the core built it. */
export interface IComposedExpectation {
  /** The exact native suggestion block the core appended, when there is one. */
  readonly suggestionBlock?: string;
  /** The exact marker the core appends last, when there is one. */
  readonly marker?: string;
}

/**
 * Why a fully composed comment or body is not what the core built, worded to
 * follow "leaves" or "has", or null. Whatever producer content and callbacks
 * contributed, the composed text must:
 *   - leave no raw HTML open (unbalancedHtml) and swallow nothing after it;
 *   - contain exactly the suggestion blocks the core built — at most its
 *     own one, as a `suggestion` code node, intact, as the text's last node
 *     (or the last before its marker). Code the core shows literally (a
 *     proposed file's content) may contain such lines: they are code, not
 *     suggestion blocks;
 *   - end with its marker as its own final html node.
 */
export function composedProblem(text: string, expected: IComposedExpectation): string | null {
  const html = unbalancedHtml(text);
  if (html !== null) return `leaves ${html} open`;
  if (swallower(text) !== null) return 'leaves a code fence open';
  const { suggestionBlock, marker } = expected;
  const root = parse(text);
  const suggestions = placedNodes(root).filter((placed) => placed.node.type === 'code' && /^suggestion/i.test(placed.node.lang ?? '')).length;
  if (suggestions !== (suggestionBlock === undefined ? 0 : 1)) {
    return `has ${String(suggestions)} suggestion block${suggestions === 1 ? '' : 's'}, not the ${suggestionBlock === undefined ? 'none' : 'one'} the core built`;
  }
  const blocks = root.children;
  const last = blocks[blocks.length - 1];
  const sourceOf = (node: Nodes | undefined): string | undefined =>
    node?.position?.start.offset === undefined || node.position.end.offset === undefined ? undefined : text.slice(node.position.start.offset, node.position.end.offset);
  let beforeMarker = last;
  if (marker !== undefined) {
    if (last?.type !== 'html' || sourceOf(last) !== marker || !text.endsWith(marker)) return 'has its marker no longer as its own final node';
    beforeMarker = blocks[blocks.length - 2];
  }
  if (suggestionBlock !== undefined) {
    if (beforeMarker?.type !== 'code' || beforeMarker.lang !== 'suggestion' || sourceOf(beforeMarker) !== suggestionBlock) {
      return 'has its suggestion block no longer intact as its final block';
    }
  }
  return null;
}
