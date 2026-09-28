/**
 * Read-only Git access for staged-change extraction (private module).
 *
 * Responsibility: establish one coherent snapshot of the intended index and
 * read the reviewed commit's tree, blob bytes and line-diff hunks, all by
 * immutable object identity. Nothing here reads working-tree files, runs
 * hooks, filters, textconv, external diff or end-of-line conversion, or
 * writes to the repository.
 *
 * The index snapshot is taken by reading the index file once and parsing
 * it, rather than through `git ls-files`: `ls-files --stage` cannot
 * distinguish an intent-to-add entry from an intentionally staged empty
 * file, and several separate commands could observe different index
 * versions. Git replaces the index atomically (lock file and rename), and
 * the file's trailing checksum is verified, so one read is one snapshot.
 * The index location comes from `git rev-parse --git-path index`, which
 * honors GIT_INDEX_FILE and linked worktrees exactly as Git does.
 *
 * Object identity. Every object is read as the object its id names:
 *   - Replacement refs (`git replace`) are disabled for every invocation
 *     (GIT_NO_REPLACE_OBJECTS), so Git never substitutes another object's
 *     content under a requested id.
 *   - Every commit, tree and blob this module returns is re-hashed
 *     ("<type> <size>\0" + bytes) and must equal its requested id. A mismatch,
 *     for example from a corrupted object store, is an operational error;
 *     substituted bytes are never attributed to the requested source.
 *   - The reviewed tree is walked from verified raw commit and tree objects
 *     rather than through `ls-tree`, so each level's identity is checked.
 *
 * @see https://git-scm.com/docs/index-format
 * @see https://git-scm.com/docs/git#Documentation/git.txt-codeGITNOREPLACEOBJECTScode
 */

import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Object formats this module supports, named as Node's crypto names their hashes. */
export type GitHashAlgorithm = 'sha1' | 'sha256';

/** Git object types this module reads by id. */
export type GitObjectType = 'commit' | 'tree' | 'blob';

/**
 * An opened repository: the working directory Git runs in, the absolute
 * index path, and the object format's hash algorithm and raw id length.
 */
export interface IGitRepository {
  readonly cwd: string;
  readonly indexPath: string;
  readonly hashAlgorithm: GitHashAlgorithm;
  readonly hashBytes: 20 | 32;
}

/**
 * One index entry in index order: its raw path bytes, file mode, object id
 * (lowercase hex), merge stage, and the intent-to-add and skip-worktree flags.
 */
export interface IIndexEntry {
  readonly pathBytes: Buffer;
  readonly mode: number;
  readonly oid: string;
  readonly stage: number;
  readonly intentToAdd: boolean;
  readonly skipWorktree: boolean;
}

/** A strict-extraction refusal found while reading the index (a split index). */
export interface IIndexProblem {
  readonly message: string;
}

/** One parsed index snapshot. */
export interface IIndexSnapshot {
  readonly entries: readonly IIndexEntry[];
  readonly problems: readonly IIndexProblem[];
}

/** One non-tree entry of the reviewed commit's tree, keyed by its latin1 path. */
export interface ITreeEntry {
  readonly pathBytes: Buffer;
  readonly mode: number;
  readonly oid: string;
}

/** One changed-line hunk in Git's unified-diff numbering. */
export interface IDiffHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

/** A finished Git process: its exit code (null when a signal ended it) and captured output. */
interface IGitResult {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

/** Git file modes, as numbers, that extraction distinguishes. */
const MODE = Object.freeze({
  REGULAR: 0o100644,
  EXECUTABLE: 0o100755,
  SYMLINK: 0o120000,
  GITLINK: 0o160000,
  DIRECTORY: 0o040000,
});

/** Index entry flag bits (index-format "flags" and "extended flags"). */
const FLAG_EXTENDED = 0x4000;
const FLAG_STAGE_MASK = 0x3000;
const EXTENDED_SKIP_WORKTREE = 0x4000;
const EXTENDED_INTENT_TO_ADD = 0x2000;

/**
 * The message of a caught value, for an operational error that names it.
 * Node's process and file-system APIs throw Error instances.
 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A value this module has already established is present (a verified object
 * it just read). Reaching the throw means an internal invariant was broken.
 */
function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Internal error: ${what} is missing.`);
  return value;
}

/**
 * Environment for every Git invocation: the caller's environment, so Git
 * honors GIT_INDEX_FILE and GIT_DIR as it normally would, minus variables
 * that could run external programs, with optional locks disabled so no read
 * writes the index, and with replacement refs disabled so every object id
 * denotes that object's own content.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  delete env['GIT_EXTERNAL_DIFF'];
  delete env['GIT_DIFF_OPTS'];
  return env;
}

/**
 * Runs Git in `cwd` and resolves with { code, stdout, stderr } Buffers.
 * Rejects only when Git cannot be started at all.
 */
function runGit(cwd: string, args: readonly string[], input?: string): Promise<IGitResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = childProcess.spawn('git', args, { cwd, env: gitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`Git could not be started (${messageOf(err)}).`, { cause: err }));
      return;
    }
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errOut.push(chunk));
    child.on('error', (err) => { reject(new Error(`Git could not be started (${err.message}).`, { cause: err })); });
    child.on('close', (code) => { resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(errOut) }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Runs Git and returns stdout, rejecting with an operational error on failure. */
async function gitOutput(cwd: string, args: readonly string[], what: string, input?: string): Promise<Buffer> {
  const result = await runGit(cwd, args, input);
  if (result.code !== 0) {
    const detail = result.stderr.toString('utf8').trim();
    throw new Error(`Git could not ${what}${detail ? `: ${detail}` : '.'}`);
  }
  return result.stdout;
}

/**
 * Opens the repository containing `worktree` and verifies the reviewed
 * commit exists locally. Returns { cwd, indexPath, hashAlgorithm, hashBytes }.
 */
async function openRepository(worktree: string, reviewedCommit: string): Promise<IGitRepository> {
  let stat: fs.Stats | null;
  try {
    stat = fs.statSync(worktree);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    throw new Error(`${worktree} is not a directory inside a Git working tree.`);
  }
  const inside = await runGit(worktree, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.toString('utf8').trim() !== 'true') {
    throw new Error(`${worktree} is not inside a Git working tree; pass the checkout whose index holds the intended changes.`);
  }
  const format = (await gitOutput(worktree, ['rev-parse', '--show-object-format'], 'report its object format'))
    .toString('utf8')
    .trim();
  if (format !== 'sha1' && format !== 'sha256') {
    throw new Error(`The repository uses unsupported object format ${format}.`);
  }
  const indexRelative = (await gitOutput(worktree, ['rev-parse', '--git-path', 'index'], 'locate its index'))
    .toString('utf8')
    .replace(/\n$/, '');
  const type = await runGit(worktree, ['cat-file', '-t', reviewedCommit]);
  if (type.code !== 0 || type.stdout.toString('utf8').trim() !== 'commit') {
    throw new Error(
      `The reviewed commit ${reviewedCommit} is not a commit in the local repository at ${worktree}. Fetch it (for example the pull request head) before adding staged changes.`,
    );
  }
  return {
    cwd: worktree,
    indexPath: path.resolve(worktree, indexRelative),
    hashAlgorithm: format === 'sha1' ? 'sha1' : 'sha256',
    hashBytes: format === 'sha1' ? 20 : 32,
  };
}

/**
 * Decodes the index-format v4 variable-length integer at `offset`. A byte
 * past the end of the buffer reads as 0, as its bitwise use would.
 */
function readVarint(buffer: Buffer, offset: number): { readonly value: number; readonly next: number } {
  let byte = buffer[offset] ?? 0;
  let position = offset + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[position] ?? 0;
    position += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next: position };
}

/**
 * Reads and parses the index file once. Returns { entries, problems } where
 * entries are { pathBytes, mode, oid, stage, intentToAdd, skipWorktree } in
 * index order, and problems are strict-extraction refusals (split index).
 * A malformed or torn index is an operational error.
 */
function readIndexSnapshot(repo: IGitRepository): IIndexSnapshot {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(repo.indexPath);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { entries: [], problems: [] };
    throw new Error(`The Git index at ${repo.indexPath} could not be read (${messageOf(err)}).`, { cause: err });
  }
  const corrupt = (why: string): Error => new Error(`The Git index at ${repo.indexPath} could not be parsed (${why}).`);
  const hashBytes = repo.hashBytes;
  if (buffer.length < 12 + hashBytes || buffer.toString('latin1', 0, 4) !== 'DIRC') throw corrupt('bad header');
  const trailer = buffer.subarray(buffer.length - hashBytes);
  if (trailer.some((b) => b !== 0)) {
    const digest = crypto.createHash(repo.hashAlgorithm).update(buffer.subarray(0, buffer.length - hashBytes)).digest();
    if (!digest.equals(trailer)) throw corrupt('checksum mismatch; it may have changed while being read');
  }
  const version = buffer.readUInt32BE(4);
  if (version < 2 || version > 4) throw corrupt(`unsupported version ${String(version)}`);
  const count = buffer.readUInt32BE(8);
  const end = buffer.length - hashBytes;
  const entries: IIndexEntry[] = [];
  let offset = 12;
  let previousName: Buffer = Buffer.alloc(0);
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const fixed = 40 + hashBytes + 2;
    if (start + fixed > end) throw corrupt('truncated entry');
    const mode = buffer.readUInt32BE(start + 24);
    const oid = buffer.subarray(start + 40, start + 40 + hashBytes).toString('hex');
    const flags = buffer.readUInt16BE(start + 40 + hashBytes);
    let position = start + fixed;
    let extended = 0;
    if (flags & FLAG_EXTENDED) {
      if (version < 3) throw corrupt('extended flags in a version 2 index');
      extended = buffer.readUInt16BE(position);
      position += 2;
    }
    let pathBytes: Buffer;
    if (version === 4) {
      const strip = readVarint(buffer, position);
      const nul = buffer.indexOf(0, strip.next);
      if (nul === -1 || nul >= end || strip.value > previousName.length) throw corrupt('bad path compression');
      pathBytes = Buffer.concat([previousName.subarray(0, previousName.length - strip.value), buffer.subarray(strip.next, nul)]);
      offset = nul + 1;
    } else {
      const nul = buffer.indexOf(0, position);
      if (nul === -1 || nul >= end) throw corrupt('unterminated path');
      pathBytes = buffer.subarray(position, nul);
      offset = start + ((position - start + pathBytes.length + 8) & ~7);
    }
    previousName = pathBytes;
    entries.push({
      pathBytes: Buffer.from(pathBytes),
      mode,
      oid,
      stage: (flags & FLAG_STAGE_MASK) >> 12,
      intentToAdd: Boolean(extended & EXTENDED_INTENT_TO_ADD),
      skipWorktree: Boolean(extended & EXTENDED_SKIP_WORKTREE),
    });
  }
  const problems: IIndexProblem[] = [];
  while (offset + 8 <= end) {
    const signature = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32BE(offset + 4);
    if (signature === 'link') {
      problems.push({
        message: 'The index is a split index, whose entries live partly in a shared index file this extraction does not read. Run `git update-index --no-split-index` and retry.',
      });
    } else if (!/^[A-Z]/.test(signature) && signature !== 'sdir') {
      throw corrupt(`unknown required extension ${JSON.stringify(signature)}`);
    }
    offset += 8 + size;
  }
  return { entries, problems };
}

/**
 * Reads objects by id with `cat-file --batch` and verifies each one: the
 * returned type must be `expectedType` and the bytes must hash to the
 * requested id. Returns Map<oid, Buffer>. Any mismatch or missing object is
 * an operational error naming the object, never substituted content.
 */
async function readVerifiedObjects(
  repo: IGitRepository,
  oids: readonly string[],
  expectedType: GitObjectType,
): Promise<Map<string, Buffer>> {
  const objects = new Map<string, Buffer>();
  const unique = [...new Set(oids)];
  if (unique.length === 0) return objects;
  const output = await gitOutput(repo.cwd, ['cat-file', '--batch'], `read ${expectedType} objects`, `${unique.join('\n')}\n`);
  let offset = 0;
  for (const requested of unique) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1) throw new Error(`Git returned no content for object ${requested}.`);
    const [oid, type, size] = output.toString('utf8', offset, newline).split(' ');
    if (oid !== requested || type === 'missing' || size === undefined) {
      throw new Error(`Object ${requested} is not available in the local repository.`);
    }
    if (type !== expectedType) {
      throw new Error(`Object ${requested} is a ${String(type)}, not the expected ${expectedType}.`);
    }
    const start = newline + 1;
    const bytes = Buffer.from(output.subarray(start, start + Number(size)));
    const digest = crypto
      .createHash(repo.hashAlgorithm)
      .update(Buffer.concat([Buffer.from(`${type} ${String(bytes.length)}\0`), bytes]))
      .digest('hex');
    if (digest !== requested) {
      throw new Error(
        `Git returned content for ${expectedType} ${requested} that does not hash to that id; the object store may be corrupted. Run \`git fsck\` and repair the repository, then retry.`,
      );
    }
    objects.set(requested, bytes);
    offset = start + Number(size) + 1;
  }
  return objects;
}

/** The root tree id recorded in a verified raw commit object. */
function commitTreeId(commit: string, bytes: Buffer, hashBytes: number): string {
  const match = /^tree ([0-9a-f]+)\n/.exec(bytes.toString('latin1', 0, 12 + hashBytes * 2));
  const treeId = match?.[1];
  if (treeId === undefined || treeId.length !== hashBytes * 2) throw new Error(`Commit ${commit} does not name a root tree.`);
  return treeId;
}

/**
 * The reviewed commit's complete tree, walked from verified raw commit and
 * tree objects: Map<pathKey, { pathBytes, mode, oid }> for every non-tree
 * entry. Subtrees are read one level at a time.
 */
async function readTree(repo: IGitRepository, commit: string): Promise<Map<string, ITreeEntry>> {
  const commits = await readVerifiedObjects(repo, [commit], 'commit');
  let level: { oid: string; prefix: Buffer }[] = [{ oid: commitTreeId(commit, present(commits.get(commit), `commit ${commit}`), repo.hashBytes), prefix: Buffer.alloc(0) }];
  const tree = new Map<string, ITreeEntry>();
  while (level.length > 0) {
    const trees = await readVerifiedObjects(repo, level.map((t) => t.oid), 'tree');
    const next: typeof level = [];
    for (const { oid, prefix } of level) {
      const bytes = present(trees.get(oid), `tree ${oid}`);
      let offset = 0;
      while (offset < bytes.length) {
        const space = bytes.indexOf(0x20, offset);
        const nul = bytes.indexOf(0, space);
        if (space === -1 || nul === -1 || nul + 1 + repo.hashBytes > bytes.length) throw new Error(`Tree ${oid} is malformed.`);
        const mode = parseInt(bytes.toString('latin1', offset, space), 8);
        const name = bytes.subarray(space + 1, nul);
        const entryOid = bytes.subarray(nul + 1, nul + 1 + repo.hashBytes).toString('hex');
        offset = nul + 1 + repo.hashBytes;
        const pathBytes = Buffer.concat([prefix, name]);
        if (mode === MODE.DIRECTORY) {
          next.push({ oid: entryOid, prefix: Buffer.concat([pathBytes, Buffer.from('/')]) });
        } else {
          // Git reads the historical group-writable mode 100664 as a regular file.
          tree.set(pathBytes.toString('latin1'), { pathBytes, mode: mode === 0o100664 ? MODE.REGULAR : mode, oid: entryOid });
        }
      }
    }
    level = next;
  }
  return tree;
}

/** Sizes of blobs by object id: Map<oid, size>. */
async function blobSizes(repo: IGitRepository, oids: readonly string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (oids.length === 0) return sizes;
  const output = await gitOutput(repo.cwd, ['cat-file', '--batch-check'], 'inspect blobs', `${oids.join('\n')}\n`);
  for (const line of output.toString('utf8').split('\n')) {
    const [oid, type, size] = line.split(' ');
    if (oid && type === 'blob') sizes.set(oid, Number(size));
  }
  return sizes;
}

/** Verified blob bytes by object id: Map<oid, Buffer>. */
async function readBlobs(repo: IGitRepository, oids: readonly string[]): Promise<Map<string, Buffer>> {
  return readVerifiedObjects(repo, oids, 'blob');
}

/**
 * Changed-line hunks between two blobs: [{ oldStart, oldCount, newStart,
 * newCount }] in Git's unified-diff numbering (a zero count's start names
 * the line before the insertion point). Uses Git's Myers algorithm with the
 * indent heuristic disabled and zero context, independent of diff config.
 * Lines are compared with their terminators, so newline changes are edits.
 */
async function diffHunks(repo: IGitRepository, oldOid: string, newOid: string): Promise<IDiffHunk[]> {
  const output = await gitOutput(
    repo.cwd,
    ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--text', '--no-indent-heuristic', '--diff-algorithm=myers', '--unified=0', oldOid, newOid],
    'compare two blobs',
  );
  const hunks: IDiffHunk[] = [];
  for (const line of output.toString('latin1').split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    hunks.push({
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
}

export { MODE, blobSizes, diffHunks, openRepository, readBlobs, readIndexSnapshot, readTree };
