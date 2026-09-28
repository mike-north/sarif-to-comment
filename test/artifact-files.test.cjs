'use strict';

/**
 * Tests for the CLI's artifact file handling (src/artifact-files.cjs): the
 * guarantees behind the command receipts that child-process tests cannot
 * provoke deterministically. The races are simulated through the module's
 * documented observation hooks and an injected `stat`.
 *
 * - Output preservation (contract §6.4, D10): an existing output is archived
 *   as `<UTC stamp>.old.<name>`, stamped with its birth time or, when the
 *   platform reports none, its modification time; collisions take `-2`, `-3`,
 *   …; an archive never overwrites anything.
 * - Exclusive creation: a new file appears whole or not at all, and an output
 *   that reappears concurrently is left alone.
 * - In-place replacement (§3.2): cooperating writers are excluded by an
 *   ownership marker that is never taken over; content observed to change
 *   before replacement is not overwritten; the file mode survives.
 *
 * @see https://nodejs.org/api/fs.html#stat-time-values (birthtime reporting)
 * @see https://pubs.opengroup.org/onlinepubs/9799919799/functions/link.html (EEXIST)
 * @see https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html
 */

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const files = require('../dist/artifact-files.cjs');

const tempDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-files-')));

/** A stat whose birth time is unavailable (as some platforms report), with a fixed mtime. */
const MTIME = Date.parse('2026-09-28T10:15:00.123Z');
const noBirthStat = (file) => {
  const real = fs.statSync(file);
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { birthtimeMs: 0, mtimeMs: MTIME });
};
const BIRTH = Date.parse('2026-01-02T03:04:05.006Z');
const birthStat = (file) => {
  const real = fs.statSync(file);
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { birthtimeMs: BIRTH, mtimeMs: MTIME });
};

describe('archiving an existing output', () => {
  test('nothing to archive returns null and creates nothing', () => {
    const dir = tempDir();
    assert.equal(files.archiveExisting(path.join(dir, 'out.sarif')), null);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('birth time names the archive when the platform reports it', () => {
    const dir = tempDir();
    const out = path.join(dir, 'out.sarif');
    fs.writeFileSync(out, 'old');
    const archived = files.archiveExisting(out, { stat: birthStat });
    const expected = path.join(dir, '2026-01-02T03-04-05.006Z.old.out.sarif');
    assert.deepEqual(archived, { path: expected, from: out, timeSource: 'birth' });
    assert.equal(fs.readFileSync(expected, 'utf8'), 'old');
    assert.equal(fs.existsSync(out), false);
  });

  test('without a birth time the modification time is used and said so', () => {
    const dir = tempDir();
    const out = path.join(dir, 'out.sarif');
    fs.writeFileSync(out, 'old');
    const archived = files.archiveExisting(out, { stat: noBirthStat });
    assert.deepEqual(archived, { path: path.join(dir, '2026-09-28T10-15-00.123Z.old.out.sarif'), from: out, timeSource: 'modified' });
  });

  test('collisions take -2, -3, … and never overwrite an existing archive', () => {
    const dir = tempDir();
    const out = path.join(dir, 'out.sarif');
    fs.writeFileSync(path.join(dir, '2026-09-28T10-15-00.123Z.old.out.sarif'), 'first');
    fs.writeFileSync(path.join(dir, '2026-09-28T10-15-00.123Z-2.old.out.sarif'), 'second');
    fs.writeFileSync(out, 'third');
    const archived = files.archiveExisting(out, { stat: noBirthStat });
    assert.equal(archived.path, path.join(dir, '2026-09-28T10-15-00.123Z-3.old.out.sarif'));
    assert.equal(fs.readFileSync(path.join(dir, '2026-09-28T10-15-00.123Z.old.out.sarif'), 'utf8'), 'first');
    assert.equal(fs.readFileSync(path.join(dir, '2026-09-28T10-15-00.123Z-2.old.out.sarif'), 'utf8'), 'second');
    assert.equal(fs.readFileSync(archived.path, 'utf8'), 'third');
  });
});

describe('exclusive creation', () => {
  test('creates the file whole and leaves no temporary file', () => {
    const dir = tempDir();
    const out = path.join(dir, 'new.sarif');
    files.createExclusive(out, '{"a":1}\n');
    assert.equal(fs.readFileSync(out, 'utf8'), '{"a":1}\n');
    assert.deepEqual(fs.readdirSync(dir), ['new.sarif']);
  });

  test('an output that reappeared concurrently is left alone', () => {
    const dir = tempDir();
    const out = path.join(dir, 'new.sarif');
    const hooks = { beforeLink: () => fs.writeFileSync(out, 'concurrent writer') };
    assert.throws(() => files.createExclusive(out, 'ours', hooks), (err) => {
      assert.ok(err instanceof files.ArtifactError);
      assert.ok(err.message.includes(out));
      return true;
    });
    assert.equal(fs.readFileSync(out, 'utf8'), 'concurrent writer');
    assert.deepEqual(fs.readdirSync(dir), ['new.sarif'], 'the temporary file is removed');
  });
});

describe('ownership and in-place replacement', () => {
  test('a second owner is refused and the first owner\'s marker is never taken over', () => {
    const dir = tempDir();
    const file = path.join(dir, 'review.sarif');
    fs.writeFileSync(file, 'x');
    const release = files.acquireOwnership(file);
    const marker = files.ownershipMarkerFor(file);
    assert.equal(marker, path.join(dir, '.review.sarif.sarif-to-comment-lock'));
    assert.throws(() => files.acquireOwnership(file), (err) => err instanceof files.ArtifactError && err.message.includes(marker));
    assert.ok(fs.existsSync(marker));
    release();
    assert.equal(fs.existsSync(marker), false);
    files.acquireOwnership(file)();
  });

  test('replacement refuses content that changed after it was read', () => {
    const dir = tempDir();
    const file = path.join(dir, 'review.sarif');
    fs.writeFileSync(file, 'original');
    const read = fs.readFileSync(file);
    const hooks = { beforeReplace: () => fs.writeFileSync(file, 'external edit') };
    assert.throws(() => files.replaceIfUnchanged(file, read, 'ours', hooks), (err) => {
      assert.ok(err instanceof files.ArtifactError);
      assert.match(err.message, /changed/);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), 'external edit');
    assert.deepEqual(fs.readdirSync(dir), ['review.sarif']);
  });

  test('replacement keeps the file mode and leaves no temporary file', () => {
    const dir = tempDir();
    const file = path.join(dir, 'review.sarif');
    fs.writeFileSync(file, 'original');
    fs.chmodSync(file, 0o640);
    files.replaceIfUnchanged(file, fs.readFileSync(file), 'replacement');
    assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(dir), ['review.sarif']);
  });
});

describe('reading SARIF files', () => {
  test('strict UTF-8 with an optional byte-order mark', () => {
    const dir = tempDir();
    const file = path.join(dir, 'bom.sarif');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"version":"2.1.0"}')]));
    assert.deepEqual(files.readJsonFile(file, 'SARIF file'), { value: { version: '2.1.0' }, bytes: fs.readFileSync(file) });
    fs.writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.throws(() => files.readJsonFile(file, 'SARIF file'), /not valid UTF-8/);
    fs.writeFileSync(file, '{ nope');
    assert.throws(() => files.readJsonFile(file, 'SARIF file'), /not valid JSON/);
  });
});

describe('ArtifactError runtime shape', () => {
  test('a file problem is an ArtifactError with only the standard Error properties', () => {
    // Characterization of 0.2.0: the class declares no fields and no name of
    // its own, so it adds no own enumerable property and reports the
    // inherited name "Error". The CLI branches on instanceof and shows only
    // the message; a language conversion must not add fields or rename it.
    const missing = path.join(tempDir(), 'absent.sarif');
    assert.throws(() => files.readTextFile(missing, 'SARIF file'), (err) => {
      assert.ok(err instanceof files.ArtifactError);
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'Error');
      assert.equal(Object.hasOwn(err, 'name'), false);
      assert.deepEqual(Object.keys(err), []);
      assert.equal(Object.hasOwn(err, 'cause'), false);
      assert.ok(err.message.startsWith(`cannot read SARIF file ${missing}: `), err.message);
      return true;
    });
  });
});
