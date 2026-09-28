/**
 * Real local Git repositories for staged-change extraction tests.
 *
 * A fixture states three independent byte-level snapshots for each path:
 * the reviewed commit, the intended index, and the working tree. They are
 * written with Git plumbing (`hash-object --no-filters`, `update-index`), so
 * the index holds exactly the authored bytes and modes. No clean/smudge
 * filter, end-of-line conversion or working-tree file influences what is
 * staged, and working-tree bytes can deliberately differ from the index.
 *
 * Nothing here computes expected extraction results. Tests state those by
 * hand; this module only builds the repository they describe.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

/** A Git index/tree entry mode this fixture writes. */
export type FixtureMode = '100644' | '100755' | '120000' | '160000';

/**
 * One fixture entry: a string or Buffer is a regular 100644 file; an object
 * gives { bytes, mode } (mode 120000: bytes are the link target) or a gitlink
 * { mode: '160000', commit }.
 */
export type FixtureEntry =
  | string
  | Buffer
  | { readonly mode: '160000'; readonly commit: string }
  | { readonly mode?: Exclude<FixtureMode, '160000'> | undefined; readonly bytes: string | Buffer };

/** Fixture entries by repository path. */
export type FixtureEntries = Readonly<Record<string, FixtureEntry>>;

/** Working-tree file contents by repository path. */
export type FixtureFiles = Readonly<Record<string, string | Buffer>>;

/** Runs git in the repository with `args` and optional stdin; returns stdout bytes. */
export type GitRunner = (args: readonly string[], input?: string | Buffer) => Buffer;

/** Runs git in the repository and returns its stdout as trimmed UTF-8 text. */
export type GitTextRunner = (args: readonly string[], input?: string | Buffer) => string;

/** Repository-scoped plumbing helpers. */
export interface IGitPlumbing {
  readonly git: GitRunner;
  readonly text: GitTextRunner;
}

/** A created fixture repository (see createFixtureRepo). */
export interface IFixtureRepo extends IGitPlumbing {
  readonly dir: string;
  readonly reviewedCommit: string;
  readonly parentCommit: string | undefined;
}

/** What createFixtureRepo builds. */
export interface IFixtureRepoSpec {
  readonly reviewed: FixtureEntries;
  readonly staged: FixtureEntries;
  readonly workTree?: FixtureFiles | undefined;
  readonly before?: FixtureEntries | undefined;
}

/** Stage contents of an unmerged path. */
export interface IConflictStages {
  readonly base: string | Buffer;
  readonly ours: string | Buffer;
  readonly theirs: string | Buffer;
}

/** A normalized entry: blob bytes and mode, or a gitlink's commit. */
type NormalizedEntry =
  | { readonly mode: '160000'; readonly commit: string }
  | { readonly mode: Exclude<FixtureMode, '160000'>; readonly bytes: Buffer };

/** Environment isolating fixture Git from the caller's global and system configuration. */
export function gitEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removes every inherited GIT_* variable by name
    if (key.startsWith('GIT_')) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-09-28T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-09-28T00:00:00Z',
    ...extra,
  };
}

function bytesOf(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
}

/**
 * Repository-scoped plumbing helper. `git(args, input)` returns stdout as a
 * Buffer; `text(args)` returns it trimmed as a string.
 */
function plumbing(dir: string, envExtra?: Readonly<Record<string, string>>): IGitPlumbing {
  const git: GitRunner = (args, input) =>
    execFileSync('git', args, { cwd: dir, env: gitEnv(envExtra), input, maxBuffer: 64 * 1024 * 1024 });
  const text: GitTextRunner = (args, input) => git(args, input).toString('utf8').trim();
  return { git, text };
}

/**
 * Normalizes one fixture entry. A string or Buffer is a regular 100644 file;
 * an object may give { bytes, mode } with mode '100644', '100755', '120000'
 * (bytes are the link target) or '160000' (`commit` names the gitlink).
 */
function entryOf(value: FixtureEntry): NormalizedEntry {
  if (typeof value === 'string' || Buffer.isBuffer(value)) return { mode: '100644', bytes: bytesOf(value) };
  if (value.mode === '160000') return { mode: '160000', commit: value.commit };
  return { mode: value.mode || '100644', bytes: bytesOf(value.bytes) };
}

/** Writes a blob exactly as given and returns its object id. */
function writeBlob(g: IGitPlumbing, bytes: Buffer): string {
  return g.text(['hash-object', '-w', '--no-filters', '--stdin'], bytes);
}

/** Replaces the whole index with the given entries (path -> entry). */
function setIndex(g: IGitPlumbing, entries: FixtureEntries): void {
  g.git(['read-tree', '--empty']);
  const lines: string[] = [];
  for (const [p, value] of Object.entries(entries)) {
    const e = entryOf(value);
    const oid = e.mode === '160000' ? e.commit : writeBlob(g, e.bytes);
    lines.push(`${e.mode} ${oid}\t${p}`);
  }
  if (lines.length > 0) g.git(['update-index', '--add', '--index-info'], `${lines.join('\n')}\n`);
}

export function writeWorkTree(dir: string, files: FixtureFiles): void {
  for (const [p, value] of Object.entries(files)) {
    const target = path.join(dir, p);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytesOf(value));
  }
}

/**
 * Creates a repository with:
 *   reviewed: path -> entry committed as the reviewed commit;
 *   staged:   path -> entry forming the complete intended index;
 *   workTree: path -> bytes written to disk after staging (may diverge);
 *   before:   optional path -> entry committed first (the reviewed commit's parent).
 * Returns { dir, reviewedCommit, parentCommit?, git, text }.
 */
export function createFixtureRepo({ reviewed, staged, workTree = {}, before }: IFixtureRepoSpec): IFixtureRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarif-staged-'));
  const g = plumbing(dir);
  g.git(['init', '-q', '-b', 'main']);
  let parentCommit: string | undefined;
  if (before) {
    setIndex(g, before);
    parentCommit = g.text(['commit-tree', g.text(['write-tree']), '-m', 'before']);
  }
  setIndex(g, reviewed);
  const tree = g.text(['write-tree']);
  const args = ['commit-tree', tree, '-m', 'reviewed'];
  if (parentCommit) args.push('-p', parentCommit);
  const reviewedCommit = g.text(args);
  g.git(['update-ref', 'HEAD', reviewedCommit]);
  setIndex(g, staged);
  writeWorkTree(dir, workTree);
  return { dir, reviewedCommit, parentCommit, ...g };
}

/** Marks an index path intent-to-add (`git add -N`) after writing its working-tree file. */
export function addIntentToAdd(repo: IFixtureRepo, p: string, workTreeBytes: string | Buffer = 'intended later\n'): void {
  writeWorkTree(repo.dir, { [p]: workTreeBytes });
  repo.git(['add', '-N', '--', p]);
}

/** Records an unmerged path with base/ours/theirs stages. */
export function addConflict(repo: IFixtureRepo, p: string, { base, ours, theirs }: IConflictStages): void {
  repo.git(['update-index', '--force-remove', '--', p]);
  const lines = [
    `100644 ${writeBlob(repo, bytesOf(base))} 1\t${p}`,
    `100644 ${writeBlob(repo, bytesOf(ours))} 2\t${p}`,
    `100644 ${writeBlob(repo, bytesOf(theirs))} 3\t${p}`,
  ];
  repo.git(['update-index', '--index-info'], `${lines.join('\n')}\n`);
}

/** Adds a regular index entry whose path bytes are not valid UTF-8. */
export function addRawPathEntry(repo: IFixtureRepo, pathBytes: Buffer, contents: string | Buffer): void {
  const oid = writeBlob(repo, bytesOf(contents));
  const record = Buffer.concat([Buffer.from(`100644 ${oid}\t`), pathBytes, Buffer.from([0])]);
  repo.git(['update-index', '--add', '-z', '--index-info'], record);
}

/**
 * Installs a Git replacement ref (`git replace -f`) so that ordinary Git reads of
 * `original` return `replacement` instead. Used to prove extraction reads the
 * named objects themselves, never replacement content under their identity.
 */
export function replaceObject(repo: IFixtureRepo, original: string, replacement: string): void {
  repo.git(['replace', '-f', original, replacement]);
}

/**
 * Overwrites the loose object file for `oid` with a well-formed object of the
 * same type but different content, simulating a corrupted object store in
 * which Git returns bytes that do not hash to the requested id.
 */
export function corruptLooseObject(repo: IFixtureRepo, oid: string, type: string, bytes: string | Buffer): void {
  const body = bytesOf(bytes);
  const file = path.join(repo.dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, zlib.deflateSync(Buffer.concat([Buffer.from(`${type} ${String(body.length)}\0`), body])));
}

/** Object id of a path at a commit, for replacement and corruption fixtures. */
export function objectAt(repo: IFixtureRepo, commit: string, p: string): string {
  return repo.text(['rev-parse', `${commit}:${p}`]);
}

export function removeFixtureRepo(repo: IFixtureRepo): void {
  fs.rmSync(repo.dir, { recursive: true, force: true });
}
