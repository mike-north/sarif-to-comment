/**
 * File handling for the CLI's local SARIF artifacts. The library never touches
 * files; the command-line interface uses this module so that every receipt it
 * prints describes what actually happened on disk.
 *
 * Responsibilities and guarantees:
 *   - Reading: SARIF and message files are strict UTF-8 (a leading byte-order
 *     mark is an encoding signature and is removed); undecodable bytes are
 *     refused rather than replaced, so nothing is silently altered.
 *   - Exclusive creation (`createExclusive`): the content is written and
 *     flushed to a temporary sibling, then hard-linked to the destination,
 *     which fails if the destination exists. A file therefore appears whole or
 *     not at all, and an output that reappeared concurrently is never
 *     overwritten.
 *   - Ownership (`acquireOwnership`): cooperating sarif-to-comment commands
 *     editing or producing the same artifact exclude each other with an
 *     exclusively created marker file, `.<name>.sarif-to-comment-lock`, beside
 *     the artifact. A marker that already exists is reported, never taken over:
 *     only a person can know that its owner is gone. The owner removes it when
 *     it finishes, whatever the outcome.
 *   - In-place replacement (`replaceIfUnchanged`): the new content is written
 *     to a temporary sibling with the original mode; immediately before the
 *     atomic rename the file is re-read and compared with the bytes the edit
 *     was computed from, and an observed external change is refused. This is
 *     not a filesystem compare-and-swap: a non-cooperating writer acting
 *     between that check and the rename is outside the guarantee.
 *   - Output preservation (`archiveExisting`): an existing output is moved
 *     aside as `<YYYY-MM-DDTHH-mm-ss.SSSZ>.old.<name>` in its directory, the
 *     stamp being the file's birth time in UTC (or its modification time when
 *     the platform reports no birth time), with `-2`, `-3`, … appended to the
 *     stamp on collision. The archive is an exclusive hard link followed by
 *     removal of the original name, so it never overwrites anything.
 *
 * Failures a user must act on are `ArtifactError`s with actionable messages
 * that name the paths involved.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A file problem the user must resolve; the message names the paths. */
export class ArtifactError extends Error {}

/** A UTF-8 text file as read: its decoded text and the exact bytes (for change detection). */
export interface ITextFile {
  /** The decoded content, without a leading byte-order mark. */
  readonly text: string;
  /** The bytes as read from disk. */
  readonly bytes: Buffer;
}

/** A UTF-8 JSON file as read: the parsed value (not yet validated) and the exact bytes. */
export interface IJsonFile {
  /** The parsed JSON; `unknown` until the caller captures and validates it. */
  readonly value: unknown;
  /** The bytes as read from disk. */
  readonly bytes: Buffer;
}

/** Test-only hook of {@link createExclusive}; not part of any supported contract. */
export interface ICreateExclusiveHooks {
  /** Runs after the temporary file is complete, before it is linked into place. */
  readonly beforeLink?: () => void;
}

/** Test-only hook of {@link replaceIfUnchanged}; not part of any supported contract. */
export interface IReplaceIfUnchangedHooks {
  /** Runs after the temporary file is complete, before the re-read and rename. */
  readonly beforeReplace?: () => void;
}

/** The stat times {@link archiveExisting} reads to stamp an archive name. */
export interface IArchiveStat {
  /** Birth time in milliseconds; 0 or non-finite when the platform reports none. */
  readonly birthtimeMs: number;
  /** Modification time in milliseconds. */
  readonly mtimeMs: number;
}

/** Options of {@link archiveExisting}. `stat` is a test-only replacement for fs.statSync. */
export interface IArchiveOptions {
  readonly stat?: (file: string) => IArchiveStat;
}

/** Which stat time named an archive. */
export type ArchiveTimeSource = 'birth' | 'modified';

/** Where {@link archiveExisting} moved an existing output. */
export interface IArchivedOutput {
  /** The archive's path. */
  readonly path: string;
  /** The output's original path. */
  readonly from: string;
  /** The stat time the archive name records. */
  readonly timeSource: ArchiveTimeSource;
}

/** Removes the ownership marker {@link acquireOwnership} created, if it is still ours. */
export type ReleaseOwnership = () => void;

/**
 * A caught failure's `message`, read as a template would read `err.message`.
 * Node's file-system calls throw Errors (SystemError), so this is their
 * message; a value without one reads as "undefined".
 */
function messageOf(err: unknown): string {
  return String(typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined);
}

/** A caught failure's Node error `code` (such as `EEXIST`), or undefined when it has none. */
function codeOf(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
}

/**
 * Decoder for UTF-8 text files: `fatal` refuses invalid bytes instead of
 * substituting U+FFFD; the default `ignoreBOM: false` removes a leading BOM.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** Reads a UTF-8 text file; `label` names it in errors (e.g. "message file"). */
export function readTextFile(file: string, label: string): ITextFile {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new ArtifactError(`cannot read ${label} ${file}: ${messageOf(err)}`);
  }
  try {
    return { text: UTF8.decode(bytes), bytes };
  } catch {
    throw new ArtifactError(`${label} ${file} is not valid UTF-8; it must be UTF-8 encoded.`);
  }
}

/** Reads a UTF-8 JSON file: { value, bytes } (the bytes as read, for change detection). */
export function readJsonFile(file: string, label: string): IJsonFile {
  const { text, bytes } = readTextFile(file, label);
  try {
    const value: unknown = JSON.parse(text);
    return { value, bytes };
  } catch (err) {
    throw new ArtifactError(`${label} ${file} is not valid JSON: ${messageOf(err)}`);
  }
}

/** Flushes a directory entry change (best effort where directories cannot be opened). */
function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Some platforms do not allow fsync on a directory; the rename/link itself is still atomic.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Writes and flushes `text` to a new uniquely named temporary sibling of `file`. */
function writeTemporarySibling(file: string, text: string, mode?: number): string {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${String(process.pid)}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', mode ?? 0o666);
  try {
    fs.writeFileSync(fd, text);
    if (mode !== undefined) fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return temporary;
}

/** Removes a temporary file if it is still present. */
function discard(temporary: string): void {
  try {
    fs.unlinkSync(temporary);
  } catch {
    // Already gone.
  }
}

/**
 * Creates `file` with `text` only if it does not exist. `hooks.beforeLink`
 * (tests only) runs after the temporary file is complete.
 */
export function createExclusive(file: string, text: string, hooks: ICreateExclusiveHooks = {}): void {
  const temporary = writeTemporarySibling(file, text);
  try {
    if (hooks.beforeLink) hooks.beforeLink();
    try {
      fs.linkSync(temporary, file);
    } catch (err) {
      if (codeOf(err) === 'EEXIST') {
        throw new ArtifactError(`${file} already exists (it may have been created by another program); it was left unchanged.`);
      }
      throw new ArtifactError(`cannot create ${file}: ${messageOf(err)}`);
    }
  } finally {
    discard(temporary);
  }
  syncDirectory(path.dirname(file));
}

/** The ownership marker for an artifact: `.<name>.sarif-to-comment-lock` in its directory. */
export function ownershipMarkerFor(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.sarif-to-comment-lock`);
}

/**
 * Takes exclusive cooperating-writer ownership of `file` (which need not
 * exist). Returns a release function. Throws ArtifactError if another owner
 * holds it.
 */
export function acquireOwnership(file: string): ReleaseOwnership {
  const marker = ownershipMarkerFor(file);
  const token = `${String(process.pid)} ${new Date().toISOString()} ${crypto.randomUUID()}\n`;
  try {
    fs.writeFileSync(marker, token, { flag: 'wx' });
  } catch (err) {
    if (codeOf(err) === 'EEXIST') {
      throw new ArtifactError(
        `${file} is being written by another sarif-to-comment command (ownership marker ${marker}). ` +
          `Wait for it to finish. If no such command is running, the marker is stale: delete ${marker} and run again.`,
      );
    }
    throw new ArtifactError(`cannot take ownership of ${file} (marker ${marker}): ${messageOf(err)}`);
  }
  return function release(): void {
    // Remove only our own marker: never delete one another process created.
    try {
      if (fs.readFileSync(marker, 'utf8') === token) fs.unlinkSync(marker);
    } catch {
      // Already removed.
    }
  };
}

/**
 * Atomically replaces `file` with `text`, provided its content still equals
 * `expectedBytes` immediately before the rename. `hooks.beforeReplace` (tests
 * only) runs after the temporary file is complete.
 */
export function replaceIfUnchanged(file: string, expectedBytes: Uint8Array, text: string, hooks: IReplaceIfUnchangedHooks = {}): void {
  const { mode } = fs.statSync(file);
  const temporary = writeTemporarySibling(file, text, mode & 0o7777);
  try {
    if (hooks.beforeReplace) hooks.beforeReplace();
    let current: Buffer;
    try {
      current = fs.readFileSync(file);
    } catch (err) {
      throw new ArtifactError(`${file} could not be re-read before replacement (${messageOf(err)}); it was not changed.`);
    }
    if (!current.equals(expectedBytes)) {
      throw new ArtifactError(`${file} changed while this command was running; it was not overwritten. Run the command again.`);
    }
    fs.renameSync(temporary, file);
  } finally {
    discard(temporary);
  }
  syncDirectory(path.dirname(file));
}

/** A stat time as the archive stamp, `YYYY-MM-DDTHH-mm-ss.SSSZ` (colons are not portable in names). */
function archiveStamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(/:/g, '-');
}

/**
 * Moves an existing `file` aside under its archive name. Returns
 * { path, from, timeSource: 'birth' | 'modified' }, or null if `file` does not
 * exist. `options.stat` (tests only) replaces fs.statSync.
 */
export function archiveExisting(file: string, { stat = fs.statSync }: IArchiveOptions = {}): IArchivedOutput | null {
  let info: IArchiveStat;
  try {
    info = stat(file);
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return null;
    throw new ArtifactError(`cannot examine existing output ${file}: ${messageOf(err)}`);
  }
  const birth = Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0;
  const stamp = archiveStamp(birth ? info.birthtimeMs : info.mtimeMs);
  const dir = path.dirname(file);
  const name = path.basename(file);
  for (let n = 1; ; n += 1) {
    const archive = path.join(dir, `${stamp}${n === 1 ? '' : `-${String(n)}`}.old.${name}`);
    try {
      fs.linkSync(file, archive);
    } catch (err) {
      if (codeOf(err) === 'EEXIST') continue;
      throw new ArtifactError(`cannot archive existing output ${file} as ${archive}: ${messageOf(err)}`);
    }
    fs.unlinkSync(file);
    syncDirectory(dir);
    return { path: archive, from: file, timeSource: birth ? 'birth' : 'modified' };
  }
}

/** True when two existing paths name the same file (including symbolic and hard links). */
export function sameExistingFile(a: string, b: string): boolean {
  let sa: fs.Stats;
  let sb: fs.Stats;
  try {
    sa = fs.statSync(a);
    sb = fs.statSync(b);
  } catch {
    return false;
  }
  return sa.dev === sb.dev && sa.ino === sb.ino;
}
