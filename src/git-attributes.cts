/**
 * Which merge driver Git's `.gitattributes` files assign to a path (private
 * internal module; docs/companion-suggestion-pr-contract.md §2.5.1).
 *
 * Purpose: a `merge` attribute other than the built-in text merge (for
 * example `merge=union`, `-merge`, or the `binary` macro) changes what Git's
 * merge of a file does: `merge=union` turns a conflict into a clean merge
 * that keeps both sides, which can silently bring back content a rewrite
 * removed. The fidelity projection (src/companion-fidelity.cts) only
 * reproduces the text merge, so it must know when another driver applies,
 * and then say it cannot project that file. Reading attributes more loosely
 * than Git does is never safe in either direction: a line Git discards could
 * otherwise hide a driver an earlier line set, so every rule below is Git's.
 *
 * Lines, as attr.c `read_attr_from_buf` and `parse_attr_line` read them:
 *   - The file ends at its first NUL byte; lines end at `\n`, and blanks are
 *     space, tab, `\r` and `\n`. A line that is blank, or whose first
 *     non-blank character is `#`, is skipped; `#` anywhere else is not a
 *     comment.
 *   - A line of 2,048 bytes or more is discarded.
 *   - The pattern is the first word, or a C-style quoted string (`"a b"`,
 *     `"\146"`) when it starts with `"` and unquotes; otherwise the quote is
 *     part of the word.
 *   - A pattern longer than `[attr]` that starts with it, quoted or not,
 *     defines the macro named after it (`[attr]name`); its name must be
 *     valid. Only the root file's definitions count (the last of a name
 *     wins); Git discards such a line anywhere else.
 *   - Each attribute is `name` (set), `-name` (unset), `!name` (unspecified
 *     again) or `name=value`; with a `-` or `!` prefix any `=value` is
 *     ignored. A name is letters, digits, `_`, `.` and `-`, does not start
 *     with `-`, and does not start with the reserved `builtin_`. One invalid
 *     name discards the whole line.
 *   - A negative pattern (`!pattern`) discards the line.
 *
 * Patterns, as gitignore(5) and wildmatch.c (with WM_PATHNAME, case
 * sensitive, as on GitHub's Linux hosts) match them, on UTF-8 bytes:
 *   - A pattern without a slash matches the path's last segment at any depth
 *     below the file's directory; any other pattern (a leading `/` included)
 *     matches the whole path relative to that directory. A pattern ending in
 *     `/` matches only directories, so never a file.
 *   - `*` and `?` never match `/`, and `?` matches one byte; `**` matches
 *     across directories where it stands alone between slashes, or at the
 *     start or the end of the pattern; `\` escapes the next byte.
 *   - A bracket expression matches one byte other than `/`: `!` or `^` first
 *     negates it, a `]` first is a member, `a-z` is a range, `\` escapes,
 *     and `[:alpha:]`-style classes are Git's ASCII ones. A pattern Git
 *     cannot complete (an unclosed bracket, an unknown class, a trailing
 *     `\`) matches nothing.
 *
 * Precedence, as attr.c `fill` resolves it: files from the deepest directory
 * up to the root, each file's lines last to first, each line's attributes
 * last to first, and an attribute keeps the first state found, so later
 * lines and deeper files win. A macro set on a line (`binary`) contributes
 * its own attributes there, which keep their state only where nothing has
 * set them yet; unsetting a macro (`-binary`) contributes nothing. The
 * built-in macro is `[attr]binary -diff -merge -text`.
 *
 * Not read: `$GIT_DIR/info/attributes` and `core.attributesFile`, which live
 * outside the repository's tree.
 *
 * @see https://git-scm.com/docs/gitattributes
 * @see https://git-scm.com/docs/gitignore#_pattern_format
 * @see https://github.com/git/git/blob/master/attr.c
 * @see https://github.com/git/git/blob/master/wildmatch.c
 */

/** An attribute's state on one line: set, unset, unspecified again, or a value. */
type AttributeState = true | false | null | string;

/** One attribute as a line assigns it, and the token as written (for naming it). */
interface IAssignment {
  readonly name: string;
  readonly state: AttributeState;
  readonly written: string;
}

/** One pattern line of an attributes file. */
interface IAttributeLine {
  /** The pattern, unquoted. */
  readonly pattern: string;
  readonly attributes: readonly IAssignment[];
}

/** A parsed attributes file: its pattern lines, and the macros it defines (honored only at the root). */
export interface IAttributesFile {
  readonly lines: readonly IAttributeLine[];
  readonly macros: ReadonlyMap<string, readonly IAssignment[]>;
}

/** The merge driver assigned to a path: Git's text merge, or another driver, named as the attributes wrote what assigned it. */
export type MergeDriver = { readonly kind: 'text' } | { readonly kind: 'other'; readonly attribute: string };

/** Git's built-in macro, which unsets `merge` (attr.c `builtin_attr`). */
const BUILTIN_MACROS: ReadonlyMap<string, readonly IAssignment[]> = new Map([
  ['binary', [{ name: 'diff', state: false, written: '-diff' }, { name: 'merge', state: false, written: '-merge' }, { name: 'text', state: false, written: '-text' }]],
]);

/** attr.c `blank`. */
const BLANK = /[ \t\r\n]/;
/** attr.c `ATTR_MAX_LINE_LENGTH`: a line this long or longer, in bytes, is discarded. */
const MAX_LINE_BYTES = 2048;
/** attr.c `ATTRIBUTE_MACRO_PREFIX`. */
const MACRO_PREFIX = '[attr]';

// Parsing works on "byte strings": each character is one byte (latin1), so
// lengths and wildmatch's byte-wise matching are exact. Text leaves them as
// UTF-8.
const toBytes = (text: string): string => Buffer.from(text, 'utf8').toString('latin1');
const fromBytes = (bytes: string): string => Buffer.from(bytes, 'latin1').toString('utf8');

/** The index of the first blank in `s` at or after `from`, or `s.length`. */
function nextBlank(s: string, from: number): number {
  let i = from;
  while (i < s.length && !BLANK.test(s.charAt(i))) i++;
  return i;
}

/** The index of the first non-blank in `s` at or after `from`, or `s.length`. */
function skipBlanks(s: string, from: number): number {
  let i = from;
  while (i < s.length && BLANK.test(s.charAt(i))) i++;
  return i;
}

/** attr.c `attr_name_valid` and `attr_name_reserved`. */
function validName(name: string): boolean {
  return /^[A-Za-z0-9_.][-A-Za-z0-9_.]*$/.test(name) && !name.startsWith('builtin_');
}

/** attr.c `parse_attr` over a line's attributes: each assignment, or null when a name is invalid (the line is discarded). */
function parseStates(states: string): IAssignment[] | null {
  const assignments: IAssignment[] = [];
  for (let i = skipBlanks(states, 0); i < states.length;) {
    const end = nextBlank(states, i);
    const token = states.slice(i, end);
    const equals = token.indexOf('=');
    const named = equals === -1 ? token : token.slice(0, equals);
    const prefix = named.charAt(0);
    const name = prefix === '-' || prefix === '!' ? named.slice(1) : named;
    if (!validName(name)) return null;
    const state: AttributeState = prefix === '-' ? false : prefix === '!' ? null : equals === -1 ? true : fromBytes(token.slice(equals + 1));
    assignments.push({ name, state, written: fromBytes(token) });
    i = skipBlanks(states, end);
  }
  return assignments;
}

/** The escapes of a C-style quoted string (Git's `unquote_c_style`). */
const C_ESCAPES: Readonly<Record<string, string>> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' };

/**
 * Unquotes the C-style quoted string at the start of the byte string
 * `line`: its bytes and the rest of the line, or null when it is malformed
 * (Git then reads the pattern as unquoted).
 */
function unquote(line: string): { readonly text: string; readonly rest: string } | null {
  let text = '';
  let i = 1;
  while (i < line.length) {
    const c = line.charAt(i);
    if (c === '"') return { text, rest: line.slice(i + 1) };
    if (c !== '\\') {
      text += c;
      i++;
      continue;
    }
    const escape = C_ESCAPES[line.charAt(i + 1)];
    if (escape !== undefined) {
      text += escape;
      i += 2;
    } else if (/^[0-3][0-7]{2}$/.test(line.slice(i + 1, i + 4))) {
      text += String.fromCharCode(Number.parseInt(line.slice(i + 1, i + 4), 8));
      i += 4;
    } else {
      return null;
    }
  }
  return null;
}

/** Parses one `.gitattributes` file, from its bytes or its UTF-8 text. */
export function parseAttributes(content: string | Uint8Array): IAttributesFile {
  const lines: IAttributeLine[] = [];
  const macros = new Map<string, readonly IAssignment[]>();
  let bytes = typeof content === 'string' ? toBytes(content) : Buffer.from(content).toString('latin1');
  const nul = bytes.indexOf('\0');
  if (nul !== -1) bytes = bytes.slice(0, nul);
  for (const line of bytes.split('\n')) {
    const start = skipBlanks(line, 0);
    if (start === line.length || line.charAt(start) === '#') continue;
    if (line.length >= MAX_LINE_BYTES) continue;
    const quoted = line.charAt(start) === '"' ? unquote(line.slice(start)) : null;
    let name: string;
    let states: string;
    if (quoted === null) {
      const end = nextBlank(line, start);
      name = line.slice(start, end);
      states = line.slice(end);
    } else {
      ({ text: name, rest: states } = quoted);
    }
    const attributes = parseStates(states);
    if (name.length > MACRO_PREFIX.length && name.startsWith(MACRO_PREFIX)) {
      const from = skipBlanks(name, MACRO_PREFIX.length);
      const macro = name.slice(from, nextBlank(name, from));
      // A later definition of the same macro wins (attr.c `determine_macros`).
      if (validName(macro) && attributes !== null) macros.set(macro, attributes);
      continue;
    }
    if (attributes === null || name.startsWith('!')) continue;
    lines.push({ pattern: fromBytes(name), attributes });
  }
  return { lines, macros };
}

/** Git's ASCII character classes (git-compat-util.h `sane_ctype`, as wildmatch.c tests them), by name. */
const POSIX_CLASSES: Readonly<Record<string, (byte: number) => boolean>> = {
  alnum: (b) => /[A-Za-z0-9]/.test(String.fromCharCode(b)),
  alpha: (b) => /[A-Za-z]/.test(String.fromCharCode(b)),
  blank: (b) => b === 0x20 || b === 0x09,
  cntrl: (b) => b < 0x20 || b === 0x7f,
  digit: (b) => b >= 0x30 && b <= 0x39,
  graph: (b) => b > 0x20 && b < 0x7f,
  lower: (b) => b >= 0x61 && b <= 0x7a,
  print: (b) => b >= 0x20 && b < 0x7f,
  punct: (b) => b > 0x20 && b < 0x7f && !/[A-Za-z0-9]/.test(String.fromCharCode(b)),
  space: (b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d,
  upper: (b) => b >= 0x41 && b <= 0x5a,
  xdigit: (b) => /[0-9A-Fa-f]/.test(String.fromCharCode(b)),
};

/** A byte as a regular-expression atom. */
const byteAtom = (code: number): string => `\\x${code.toString(16).padStart(2, '0')}`;

/**
 * The bracket expression starting at `glob[start]` (a `[`), as wildmatch.c
 * reads it: the regular expression for the one byte it matches and the index
 * after it, or null when it cannot be completed (the whole pattern then
 * matches nothing).
 */
function bracket(glob: string, start: number): { readonly atom: string; readonly next: number } | null {
  let i = start + 1;
  const negated = glob.charAt(i) === '!' || glob.charAt(i) === '^';
  if (negated) i++;
  const members = new Set<number>();
  /** The previous member, for a range; -1 when there is none. */
  let previous = -1;
  for (let first = true; ; first = false, i++) {
    if (i >= glob.length) return null;
    const c = glob.charCodeAt(i);
    if (!first && c === 0x5d /* ] */) break;
    if (c === 0x5c /* \ */) {
      i++;
      if (i >= glob.length) return null;
      previous = glob.charCodeAt(i);
      members.add(previous);
    } else if (c === 0x2d /* - */ && previous !== -1 && i + 1 < glob.length && glob.charAt(i + 1) !== ']') {
      i++;
      if (glob.charAt(i) === '\\') {
        i++;
        if (i >= glob.length) return null;
      }
      for (let b = previous; b <= glob.charCodeAt(i); b++) members.add(b);
      previous = -1;
    } else if (c === 0x5b /* [ */ && glob.charAt(i + 1) === ':') {
      const close = glob.indexOf(']', i + 2);
      if (close === -1) return null;
      if (close - (i + 2) < 1 || glob.charAt(close - 1) !== ':') {
        // No `:]`: the `[` is an ordinary member.
        members.add(c);
        previous = c;
        continue;
      }
      const test = POSIX_CLASSES[glob.slice(i + 2, close - 1)];
      if (test === undefined) return null;
      for (let b = 0; b < 256; b++) if (test(b)) members.add(b);
      previous = -1;
      i = close;
    } else {
      members.add(c);
      previous = c;
    }
  }
  const set = [...members].sort((a, b) => a - b).map(byteAtom).join('');
  // A class never matches `/` (WM_PATHNAME); an empty one matches nothing, or any byte when negated.
  const atom = negated ? `(?!/)[^${set}]` : set === '' ? '(?!)' : `(?!/)[${set}]`;
  return { atom, next: i + 1 };
}

/** A pattern that matches nothing. */
const NEVER = /(?!)/;

/** A wildmatch pattern (WM_PATHNAME) over a byte string, as a regular expression over a byte string. */
function globToRegExp(glob: string): RegExp {
  if (glob === '**') return /^.*$/s;
  let out = '';
  let i = 0;
  while (i < glob.length) {
    if (i === 0 && glob.startsWith('**/')) {
      out += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob.startsWith('/**/', i)) {
      out += '/(?:.*/)?';
      i += 4;
      continue;
    }
    if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      out += '/.*';
      i += 3;
      continue;
    }
    const c = glob.charAt(i);
    if (c === '*') {
      while (glob.charAt(i) === '*') i++;
      out += '[^/]*';
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if (c === '\\') {
      // A trailing backslash can match nothing.
      if (i + 1 >= glob.length) return NEVER;
      out += byteAtom(glob.charCodeAt(i + 1));
      i += 2;
      continue;
    }
    if (c === '[') {
      const parsed = bracket(glob, i);
      if (parsed === null) return NEVER;
      out += parsed.atom;
      i = parsed.next;
      continue;
    }
    out += byteAtom(glob.charCodeAt(i));
    i++;
  }
  return new RegExp(`^${out}$`, 's');
}

/** Compiled patterns, by pattern (bytes). */
const compiled = new Map<string, RegExp>();

function regExpOf(glob: string): RegExp {
  let found = compiled.get(glob);
  if (found === undefined) {
    found = globToRegExp(glob);
    compiled.set(glob, found);
  }
  return found;
}

/** Whether `pattern`, from the attributes file in directory `dir` ('' for the root), matches the file at `path`. */
export function patternMatches(pattern: string, dir: string, path: string): boolean {
  const relative = dir === '' ? path : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : undefined;
  // A pattern ending in `/` matches only directories, never a file.
  if (relative === undefined || pattern === '' || pattern.endsWith('/')) return false;
  const glob = toBytes(pattern);
  const subject = toBytes(relative);
  if (!glob.includes('/')) {
    const slash = subject.lastIndexOf('/');
    return regExpOf(glob).test(slash === -1 ? subject : subject.slice(slash + 1));
  }
  return regExpOf(glob.startsWith('/') ? glob.slice(1) : glob).test(subject);
}

/** Whether assignments touch `merge`, directly or through a macro they set. */
function touchesMerge(attributes: readonly IAssignment[], macros: ReadonlyMap<string, readonly IAssignment[]>, seen: ReadonlySet<string> = new Set()): boolean {
  return attributes.some(({ name, state }) => {
    if (name === 'merge') return true;
    const macro = macros.get(name);
    return state === true && macro !== undefined && !seen.has(name) && touchesMerge(macro, macros, new Set([...seen, name]));
  });
}

/**
 * Whether an attributes file could assign a merge driver to some path, given
 * the macros any version of the root file defines: it defines a macro that
 * touches `merge`, or a line of it sets `merge` or such a macro.
 */
export function couldAssignMerge(file: IAttributesFile, rootMacros: readonly IAttributesFile['macros'][]): boolean {
  const macros = new Map([...BUILTIN_MACROS, ...rootMacros.flatMap((m) => [...m]), ...file.macros]);
  return [...file.macros.values()].some((m) => touchesMerge(m, macros)) || file.lines.some((line) => touchesMerge(line.attributes, macros));
}

/**
 * The merge driver the attributes files assign to `path`. `files` holds each
 * file by the directory it is in ('' for the root); only directories on the
 * path's way matter.
 */
export function mergeDriverOf(path: string, files: ReadonlyMap<string, IAttributesFile>): MergeDriver {
  const macros = new Map([...BUILTIN_MACROS, ...(files.get('')?.macros ?? [])]);
  /** Each attribute's state once found, and the assignment, as written, that brought `merge`'s. */
  const found = new Map<string, AttributeState>();
  let mergeSource = '';
  /** Records `attributes` (last first) where unset so far; `via` is the macro they come from, if any. */
  const fill = (attributes: readonly IAssignment[], via: string | null): void => {
    for (const { name, state, written } of [...attributes].reverse()) {
      if (found.has(name)) continue;
      found.set(name, state);
      if (name === 'merge') mergeSource = via ?? written;
      const macro = macros.get(name);
      if (state === true && macro !== undefined) fill(macro, via ?? name);
    }
  };
  const dirs = ['', ...path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))];
  for (const dir of dirs.reverse()) {
    const file = files.get(dir);
    if (file === undefined) continue;
    for (const line of [...file.lines].reverse()) if (patternMatches(line.pattern, dir, path)) fill(line.attributes, null);
  }
  const state = found.get('merge') ?? null;
  return state === null || state === true || state === 'text' ? { kind: 'text' } : { kind: 'other', attribute: mergeSource };
}
