'use strict';

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

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** A file problem the user must resolve; the message names the paths. */
class ArtifactError extends Error {}

/**
 * Decoder for UTF-8 text files: `fatal` refuses invalid bytes instead of
 * substituting U+FFFD; the default `ignoreBOM: false` removes a leading BOM.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** Reads a UTF-8 text file; `label` names it in errors (e.g. "message file"). */
function readTextFile(file, label) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new ArtifactError(`cannot read ${label} ${file}: ${err.message}`);
  }
  try {
    return { text: UTF8.decode(bytes), bytes };
  } catch {
    throw new ArtifactError(`${label} ${file} is not valid UTF-8; it must be UTF-8 encoded.`);
  }
}

/** Reads a UTF-8 JSON file: { value, bytes } (the bytes as read, for change detection). */
function readJsonFile(file, label) {
  const { text, bytes } = readTextFile(file, label);
  try {
    return { value: JSON.parse(text), bytes };
  } catch (err) {
    throw new ArtifactError(`${label} ${file} is not valid JSON: ${err.message}`);
  }
}

/** Flushes a directory entry change (best effort where directories cannot be opened). */
function syncDirectory(dir) {
  let fd;
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
function writeTemporarySibling(file, text, mode) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
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
function discard(temporary) {
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
function createExclusive(file, text, hooks = {}) {
  const temporary = writeTemporarySibling(file, text);
  try {
    if (hooks.beforeLink) hooks.beforeLink();
    try {
      fs.linkSync(temporary, file);
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new ArtifactError(`${file} already exists (it may have been created by another program); it was left unchanged.`);
      }
      throw new ArtifactError(`cannot create ${file}: ${err.message}`);
    }
  } finally {
    discard(temporary);
  }
  syncDirectory(path.dirname(file));
}

/** The ownership marker for an artifact: `.<name>.sarif-to-comment-lock` in its directory. */
function ownershipMarkerFor(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.sarif-to-comment-lock`);
}

/**
 * Takes exclusive cooperating-writer ownership of `file` (which need not
 * exist). Returns a release function. Throws ArtifactError if another owner
 * holds it.
 */
function acquireOwnership(file) {
  const marker = ownershipMarkerFor(file);
  const token = `${process.pid} ${new Date().toISOString()} ${crypto.randomUUID()}\n`;
  try {
    fs.writeFileSync(marker, token, { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new ArtifactError(
        `${file} is being written by another sarif-to-comment command (ownership marker ${marker}). ` +
          `Wait for it to finish. If no such command is running, the marker is stale: delete ${marker} and run again.`,
      );
    }
    throw new ArtifactError(`cannot take ownership of ${file} (marker ${marker}): ${err.message}`);
  }
  return function release() {
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
function replaceIfUnchanged(file, expectedBytes, text, hooks = {}) {
  const { mode } = fs.statSync(file);
  const temporary = writeTemporarySibling(file, text, mode & 0o7777);
  try {
    if (hooks.beforeReplace) hooks.beforeReplace();
    let current;
    try {
      current = fs.readFileSync(file);
    } catch (err) {
      throw new ArtifactError(`${file} could not be re-read before replacement (${err.message}); it was not changed.`);
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
function archiveStamp(milliseconds) {
  return new Date(milliseconds).toISOString().replace(/:/g, '-');
}

/**
 * Moves an existing `file` aside under its archive name. Returns
 * { path, from, timeSource: 'birth' | 'modified' }, or null if `file` does not
 * exist. `options.stat` (tests only) replaces fs.statSync.
 */
function archiveExisting(file, { stat = fs.statSync } = {}) {
  let info;
  try {
    info = stat(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new ArtifactError(`cannot examine existing output ${file}: ${err.message}`);
  }
  const birth = Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0;
  const stamp = archiveStamp(birth ? info.birthtimeMs : info.mtimeMs);
  const dir = path.dirname(file);
  const name = path.basename(file);
  for (let n = 1; ; n += 1) {
    const archive = path.join(dir, `${stamp}${n === 1 ? '' : `-${n}`}.old.${name}`);
    try {
      fs.linkSync(file, archive);
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw new ArtifactError(`cannot archive existing output ${file} as ${archive}: ${err.message}`);
    }
    fs.unlinkSync(file);
    syncDirectory(dir);
    return { path: archive, from: file, timeSource: birth ? 'birth' : 'modified' };
  }
}

/** True when two existing paths name the same file (including symbolic and hard links). */
function sameExistingFile(a, b) {
  let sa;
  let sb;
  try {
    sa = fs.statSync(a);
    sb = fs.statSync(b);
  } catch {
    return false;
  }
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

module.exports = {
  ArtifactError,
  readTextFile,
  readJsonFile,
  createExclusive,
  ownershipMarkerFor,
  acquireOwnership,
  replaceIfUnchanged,
  archiveExisting,
  sameExistingFile,
};
