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
 * and then say it cannot project that file.
 *
 * What is followed, from gitattributes(5):
 *   - Each line is a pattern and attributes, separated by whitespace; blank
 *     lines and lines starting with `#` are ignored. An attribute is set
 *     (`merge`), unset (`-merge`), unspecified again (`!merge`) or given a
 *     value (`merge=union`).
 *   - A pattern without a slash matches the path's last segment at any depth
 *     below the file's directory; any other pattern (a leading `/` included)
 *     matches the whole path relative to that directory. `*` and `?` never
 *     match `/`; `**` matches across directories where it stands alone
 *     between slashes, or at the start or the end of the pattern. A pattern
 *     ending in `/` matches a directory, never a file, so it is ignored.
 *     Negative patterns (`!pattern`) are not allowed in attributes files and
 *     are ignored, as Git ignores them.
 *   - A pattern may be quoted C-style (`"a b"`, `"\146"`); it is unquoted
 *     before matching, and a leading `\!` is a literal `!`.
 *   - As Git's attr.c `fill` does: files from the deepest directory up to
 *     the root, each file's lines last to first, each line's attributes last
 *     to first, and an attribute keeps the first state found, so later lines
 *     and deeper files win. A macro set on a line (`binary`) contributes its
 *     own attributes there, which keep their state only where nothing has
 *     set them yet; unsetting a macro (`-binary`) contributes nothing.
 *   - Macros are the built-in `[attr]binary -diff -merge -text` and those
 *     the root file defines with `[attr]` (its last definition of a name
 *     wins); Git ignores `[attr]` lines in other directories.
 *
 * Not read: `$GIT_DIR/info/attributes` and `core.attributesFile`, which live
 * outside the repository's tree. POSIX bracket classes (`[[:alpha:]]`) are
 * not interpreted.
 *
 * @see https://git-scm.com/docs/gitattributes
 * @see https://git-scm.com/docs/gitignore#_pattern_format
 */

/** An attribute's state on one line: set, unset, unspecified again, or a value. */
type AttributeState = true | false | null | string;

/** One attribute as a line writes it. */
type Assignment = readonly [name: string, state: AttributeState];

/** One line of an attributes file. */
interface IAttributeLine {
  /** The pattern, unquoted. */
  readonly pattern: string;
  readonly attributes: readonly Assignment[];
}

/** A parsed attributes file: its pattern lines, and the macros it defines (honored only at the root). */
export interface IAttributesFile {
  readonly lines: readonly IAttributeLine[];
  readonly macros: ReadonlyMap<string, readonly Assignment[]>;
}

/** The merge driver assigned to a path: Git's text merge, or another driver, named as the attributes wrote what assigned it. */
export type MergeDriver = { readonly kind: 'text' } | { readonly kind: 'other'; readonly attribute: string };

/** Git's built-in macro, which unsets `merge` (attr.c `builtin_attr`). */
const BUILTIN_MACROS: ReadonlyMap<string, readonly Assignment[]> = new Map([
  ['binary', [['diff', false], ['merge', false], ['text', false]]],
]);

function parseAttribute(token: string): Assignment {
  if (token.startsWith('-')) return [token.slice(1), false];
  if (token.startsWith('!')) return [token.slice(1), null];
  const equals = token.indexOf('=');
  return equals === -1 ? [token, true] : [token.slice(0, equals), token.slice(equals + 1)];
}

/** The escapes of a C-style quoted string (Git's `unquote_c_style`). */
const C_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };

/**
 * Unquotes the C-style quoted string at the start of `line`: its text and
 * the rest of the line, or null when it is malformed (Git then reads the
 * pattern as unquoted).
 */
function unquote(line: string): { readonly text: string; readonly rest: string } | null {
  const bytes: number[] = [];
  let i = 1;
  while (i < line.length) {
    const c = line.charAt(i);
    if (c === '"') return { text: Buffer.from(bytes).toString('utf8'), rest: line.slice(i + 1) };
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      i += c.length;
      continue;
    }
    const next = line.charAt(i + 1);
    const escape = C_ESCAPES[next];
    if (escape !== undefined) {
      bytes.push(escape);
      i += 2;
    } else if (/^[0-3][0-7]{2}$/.test(line.slice(i + 1, i + 4))) {
      bytes.push(Number.parseInt(line.slice(i + 1, i + 4), 8));
      i += 4;
    } else {
      return null;
    }
  }
  return null;
}

/** Parses the text of one `.gitattributes` file. */
export function parseAttributes(text: string): IAttributesFile {
  const lines: IAttributeLine[] = [];
  const macros = new Map<string, readonly Assignment[]>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').replace(/^[ \t]+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const quoted = line.startsWith('"') ? unquote(line) : null;
    let pattern: string;
    let rest: string;
    if (quoted === null) {
      const space = line.search(/[ \t]/);
      pattern = space === -1 ? line : line.slice(0, space);
      rest = space === -1 ? '' : line.slice(space);
    } else {
      ({ text: pattern, rest } = quoted);
    }
    const attributes = rest.split(/[ \t]+/).filter((t) => t !== '').map(parseAttribute);
    if (quoted === null && pattern.startsWith('[attr]')) {
      // A later definition of the same macro wins (attr.c `determine_macros`).
      macros.set(pattern.slice('[attr]'.length), attributes);
      continue;
    }
    // Negative patterns are not allowed in attributes files; Git ignores the line. `\!` is a literal `!`.
    if (pattern.startsWith('!')) continue;
    lines.push({ pattern: pattern.startsWith('\\!') ? pattern.slice(1) : pattern, attributes });
  }
  return { lines, macros };
}

/** A gitignore-style glob (Git's wildmatch with WM_PATHNAME) as a regular expression over a slash-separated path. */
function globToRegExp(glob: string): RegExp {
  if (glob === '**') return /^.*$/s;
  let out = '';
  let i = 0;
  const special = /[.*+?^${}()|[\]\\/]/;
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
    if (c === '\\' && i + 1 < glob.length) {
      const next = glob.charAt(i + 1);
      out += special.test(next) ? `\\${next}` : next;
      i += 2;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      if (glob.charAt(j) === '!' || glob.charAt(j) === '^') j++;
      if (glob.charAt(j) === ']') j++;
      while (j < glob.length && glob.charAt(j) !== ']') j++;
      if (j < glob.length) {
        let body = glob.slice(i + 1, j);
        if (body.startsWith('!') || body.startsWith('^')) body = `^${body.slice(1)}`;
        out += `(?!/)[${body.replace(/\\/g, '\\\\')}]`;
        i = j + 1;
        continue;
      }
    }
    out += special.test(c) ? `\\${c}` : c;
    i++;
  }
  return new RegExp(`^${out}$`, 's');
}

/** Whether `pattern`, from the attributes file in directory `dir` ('' for the root), matches the file at `path`. */
export function patternMatches(pattern: string, dir: string, path: string): boolean {
  const relative = dir === '' ? path : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : undefined;
  // A pattern ending in `/` matches only directories, never a file.
  if (relative === undefined || pattern === '' || pattern.endsWith('/')) return false;
  if (!pattern.includes('/')) {
    const slash = relative.lastIndexOf('/');
    return globToRegExp(pattern).test(slash === -1 ? relative : relative.slice(slash + 1));
  }
  return globToRegExp(pattern.startsWith('/') ? pattern.slice(1) : pattern).test(relative);
}

/** The macros in effect: the built-in one, overridden by the root file's. */
function macrosOf(root: IAttributesFile | undefined): ReadonlyMap<string, readonly Assignment[]> {
  return new Map([...BUILTIN_MACROS, ...(root?.macros ?? [])]);
}

/** Whether assignments touch `merge`, directly or through a macro they set. */
function touchesMerge(attributes: readonly Assignment[], macros: ReadonlyMap<string, readonly Assignment[]>, seen: ReadonlySet<string> = new Set()): boolean {
  return attributes.some(([name, state]) => {
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
export function couldAssignMerge(file: IAttributesFile, rootMacros: readonly ReadonlyMap<string, readonly Assignment[]>[]): boolean {
  const macros = new Map([...BUILTIN_MACROS, ...rootMacros.flatMap((m) => [...m]), ...file.macros]);
  return [...file.macros.values()].some((m) => touchesMerge(m, macros)) || file.lines.some((line) => touchesMerge(line.attributes, macros));
}

/** How an assignment reads in an attributes file. */
function written([name, state]: Assignment): string {
  return state === true ? name : state === false ? `-${name}` : state === null ? `!${name}` : `${name}=${state}`;
}

/**
 * The merge driver the attributes files assign to `path`. `files` holds each
 * file by the directory it is in ('' for the root); only directories on the
 * path's way matter.
 */
export function mergeDriverOf(path: string, files: ReadonlyMap<string, IAttributesFile>): MergeDriver {
  const macros = macrosOf(files.get(''));
  /** Each attribute's state once found, and the assignment, as written, that brought `merge`'s. */
  const found = new Map<string, AttributeState>();
  let mergeSource = '';
  /** Records `attributes` (last first) where unset so far; `via` is the macro they come from, if any. */
  const fill = (attributes: readonly Assignment[], via: string | null): void => {
    for (const assignment of [...attributes].reverse()) {
      const [name, state] = assignment;
      if (found.has(name)) continue;
      found.set(name, state);
      if (name === 'merge') mergeSource = via ?? written(assignment);
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
