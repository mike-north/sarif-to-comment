/**
 * The fidelity projection of a companion suggestion pull request after a
 * rewritten history (private internal module;
 * docs/companion-suggestion-pr-contract.md §2.5.1, D58, D59).
 *
 * Purpose: a suggestion pull request is always proposed on the reviewed
 * commit R. When R is no longer an ancestor of the pull request's head H,
 * GitHub measures it from the merge base M of H and the proposal commit P,
 * so merging it can bring back content the rewrite removed (GH-14, GH-18),
 * and nothing GitHub shows before a merge says whether it would. This module
 * decides, before the pull request exists, whether merging it into H would
 * apply exactly its own changes: diff(H, merge(H, P)) = diff(R, P).
 *
 * How: over the complete trees of M, R and H (P's is R's with the proposal's
 * changes), every path whose entry P changes relative to M or to R is merged
 * twice with H as one side and P as the other: over M (the merge GitHub would
 * make) and over R (H plus only the proposal's changes, the "target"). Entries
 * are compared by mode, type and object id, absence included, with no rename
 * detection; a regular file both sides changed differently is merged line by
 * line by src/three-way-merge.cts, which follows Git's own merge. Each path is
 * then faithful, conflicting, or unfaithful for a named reason, and the
 * suggestion pull request takes the worst of them (unfaithful over
 * conflicting over faithful). Cases the projection cannot decide are limits,
 * which make it unfaithful too, among them a file whose `.gitattributes` at
 * the head assign a merge driver other than the text merge
 * (src/git-attributes.cts), and a `.gitattributes` file that differs between
 * the commits and could assign one.
 *
 * Boundary: it decides and explains; it never reads GitHub itself (the
 * caller supplies trees and blobs) and never writes anything. Its verdict is a
 * projection, not an observation of GitHub's merge, and callers label it so.
 */

import * as crypto from 'node:crypto';

import { couldAssignMerge, mergeDriverOf, parseAttributes } from './git-attributes.cjs';
import type { IAttributesFile } from './git-attributes.cjs';
import { isBinaryContent, mergeText } from './three-way-merge.cjs';

// ---------------------------------------------------------------------------
// Inputs

/** One entry of a tree: a regular file, symbolic link or submodule (directories are implied by paths). */
export interface IProjectedEntry {
  /** 100644 or 100755 (a regular file), 120000 (a symbolic link) or 160000 (a submodule). */
  readonly mode: string;
  /** The blob of a file or link, or the commit of a submodule. */
  readonly oid: string;
  /** The blob's size in bytes, when the listing gives it. */
  readonly size?: number;
}

/** A commit's whole tree: every non-directory entry by full path; `truncated` when the listing left entries out. */
export interface IProjectionTree {
  readonly truncated: boolean;
  readonly entries: ReadonlyMap<string, IProjectedEntry>;
}

/** Where the projection reads Git objects from (the GitHub client, through the preflight). */
export interface IProjectionSources {
  /** The complete tree of a full commit. */
  tree(commit: string): Promise<IProjectionTree>;
  /** A blob's exact bytes. */
  blob(oid: string): Promise<Uint8Array>;
}

/**
 * What every projection of one publication shares: the reviewed commit, the
 * head it is projected onto, their merge base as GitHub names it (null when
 * it names none), and the object reader.
 */
export interface IProjectionBasis {
  readonly reviewed: string;
  readonly head: string;
  readonly mergeBase: string | null;
  readonly sources: IProjectionSources;
  /** The largest blob the projection reads to merge (the client's source-read limit). */
  readonly maxBlobBytes: number;
}

/** One change of the proposal commit, as it applies to the reviewed commit's tree. */
export type ProjectedChange =
  | { readonly operation: 'create'; readonly path: string; readonly text: string; readonly fileMode: '100644' | '100755' }
  | { readonly operation: 'edit'; readonly path: string; readonly text: string }
  | { readonly operation: 'delete'; readonly path: string };

// ---------------------------------------------------------------------------
// Outputs

/** Why merging the suggestion would not apply exactly its own changes at one path. */
export type UnfaithfulReason =
  /** The merge brings back an entry, a mode or lines the head no longer has (or changes the head otherwise). */
  | 'restores'
  /** The merge deletes a file the head has, beyond the proposal's own changes. */
  | 'removes'
  /** The merge conflicts, and outside its conflicts it would bring back content the head no longer has. */
  | 'restores-beside-conflict'
  /** The merge leaves the head's entry, though the proposal changes it. */
  | 'loses'
  /** The proposal's change cannot be made at the head: the head deleted the file or changed its kind, or its lines conflict there. */
  | 'not-expressible'
  /** The path would be both a file and a directory. */
  | 'file-and-directory';

/** A case the projection cannot decide. */
export type ProjectionLimit =
  | { readonly kind: 'truncated'; readonly commit: string }
  | { readonly kind: 'no-merge-base' }
  | { readonly kind: 'binary'; readonly path: string }
  | { readonly kind: 'symlink'; readonly path: string }
  | { readonly kind: 'submodule'; readonly path: string }
  | { readonly kind: 'kind-change'; readonly path: string }
  | { readonly kind: 'too-large'; readonly path: string }
  /** A blob the projection would have to read is listed without its size, so it cannot be read within the limit. */
  | { readonly kind: 'size-unknown'; readonly path: string }
  /** A `.gitattributes` merge driver other than the text merge applies to the path. */
  | { readonly kind: 'merge-attribute'; readonly path: string; readonly attribute: string }
  /** A `.gitattributes` file differs between the commits, and could assign a merge driver. */
  | { readonly kind: 'attributes-changed'; readonly path: string }
  /** A `.gitattributes` on the path's way at the head is not a regular file, so its attributes cannot be read. */
  | { readonly kind: 'attributes-unreadable'; readonly path: string }
  /** A path added under a directory the other side removed entirely, by a rename or a deletion. */
  | { readonly kind: 'directory-rename'; readonly directory: string };

/** The projection of one suggestion pull request onto the head. */
export type CompanionProjection =
  /** `headUnchanged` when the head already has the suggestion's changes, so the merge changes nothing. */
  | { readonly verdict: 'faithful'; readonly headUnchanged?: true }
  | { readonly verdict: 'conflicts'; readonly conflicts: readonly string[] }
  | {
      readonly verdict: 'unfaithful';
      readonly reasons: readonly { readonly path: string; readonly reason: UnfaithfulReason }[];
      readonly limits: readonly ProjectionLimit[];
    };

// ---------------------------------------------------------------------------
// Entries

/** Git's blob id of exact bytes: SHA-1 over "blob <size>\0" and the bytes. */
export function gitBlobId(bytes: Uint8Array): string {
  return crypto.createHash('sha1').update(`blob ${String(bytes.length)}\0`).update(bytes).digest('hex');
}

type EntryKind = 'file' | 'symlink' | 'submodule';

function kindOf(entry: IProjectedEntry): EntryKind {
  if (entry.mode === '120000') return 'symlink';
  if (entry.mode === '160000') return 'submodule';
  return 'file';
}

/** Whether two entries are the same, absence included. */
function same(a: IProjectedEntry | null, b: IProjectedEntry | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mode === b.mode && a.oid === b.oid;
}

/**
 * One path's three-way merge: decided from entries, needing a line merge of
 * regular files, a conflict of entries (one side deleted or changed the kind,
 * or the modes clash), or a limit.
 */
type EntryMerge =
  | { readonly kind: 'entry'; readonly entry: IProjectedEntry | null }
  | { readonly kind: 'lines'; readonly mode: string; readonly base: IProjectedEntry | null; readonly ours: IProjectedEntry; readonly theirs: IProjectedEntry }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'limit'; readonly limit: ProjectionLimit };

/** Merges one path's entries as Git does (ours = the head, theirs = the proposal or the reviewed commit). */
function mergeEntries(path: string, base: IProjectedEntry | null, ours: IProjectedEntry | null, theirs: IProjectedEntry | null): EntryMerge {
  if (same(ours, theirs)) return { kind: 'entry', entry: ours };
  if (same(base, ours)) return { kind: 'entry', entry: theirs };
  if (same(base, theirs)) return { kind: 'entry', entry: ours };
  // Both sides changed it, differently.
  if (ours === null || theirs === null) return { kind: 'conflict' };
  const kind = kindOf(ours);
  if (kind !== kindOf(theirs) || (base !== null && kindOf(base) !== kind)) return { kind: 'limit', limit: { kind: 'kind-change', path } };
  if (kind === 'symlink') return { kind: 'limit', limit: { kind: 'symlink', path } };
  if (kind === 'submodule') return { kind: 'limit', limit: { kind: 'submodule', path } };
  let mode: string;
  if (ours.mode === theirs.mode) mode = ours.mode;
  else if (base !== null && base.mode === ours.mode) mode = theirs.mode;
  else if (base !== null && base.mode === theirs.mode) mode = ours.mode;
  else return { kind: 'conflict' };
  if (ours.oid === theirs.oid) return { kind: 'entry', entry: { mode, oid: ours.oid } };
  if (base !== null && base.oid === ours.oid) return { kind: 'entry', entry: { mode, oid: theirs.oid } };
  if (base !== null && base.oid === theirs.oid) return { kind: 'entry', entry: { mode, oid: ours.oid } };
  return { kind: 'lines', mode, base, ours, theirs };
}

/** A path's merge once its lines are merged: an entry, a conflict (of entries or of lines), or a limit. */
type ResolvedMerge =
  | { readonly kind: 'entry'; readonly entry: IProjectedEntry | null }
  | { readonly kind: 'conflict'; readonly lines: boolean }
  | { readonly kind: 'limit'; readonly limit: ProjectionLimit };

// ---------------------------------------------------------------------------
// The projection

/** Every ancestor directory of each path ("a/b/c" gives "a" and "a/b"). */
function directoriesOf(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) dirs.add(path.slice(0, slash));
  }
  return dirs;
}

/** The ancestor directories of one path, nearest last. */
function ancestors(path: string): string[] {
  const dirs: string[] = [];
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) dirs.push(path.slice(0, slash));
  return dirs;
}

/** Code-unit order, as Git orders paths it lists. */
function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One projection's state: the trees, the proposal's own bytes, and the blobs read. */
class Projection {
  readonly #basis: IProjectionBasis;
  /** The proposal's created and edited files' exact bytes, by blob id. */
  readonly #local = new Map<string, Uint8Array>();
  readonly limits: ProjectionLimit[] = [];

  constructor(basis: IProjectionBasis) {
    this.#basis = basis;
  }

  /** Records the proposal's own bytes and answers their entry. */
  local(bytes: Uint8Array, mode: string): IProjectedEntry {
    const oid = gitBlobId(bytes);
    this.#local.set(oid, bytes);
    return { mode, oid, size: bytes.length };
  }

  /**
   * The bytes of a `.gitattributes` entry, or the limit that prevents
   * reading it: not a regular file, no listed size, or over the read limit.
   */
  async attributesBytes(path: string, entry: IProjectedEntry): Promise<{ readonly bytes: Uint8Array } | { readonly limit: ProjectionLimit }> {
    if (kindOf(entry) !== 'file') return { limit: { kind: 'attributes-unreadable', path } };
    if (!this.#local.has(entry.oid)) {
      if (entry.size === undefined) return { limit: { kind: 'size-unknown', path } };
      if (entry.size > this.#basis.maxBlobBytes) return { limit: { kind: 'too-large', path } };
    }
    return { bytes: await this.bytes(entry) };
  }

  /** The head's attributes files read so far, by directory ('' for the root). */
  readonly #headAttributes = new Map<string, IAttributesFile | ProjectionLimit>();

  /**
   * The merge driver the head's `.gitattributes` files assign to `path`,
   * reading those on its way (each once), or the limit that prevents
   * knowing it.
   */
  async driverOf(path: string, head: ReadonlyMap<string, IProjectedEntry>): Promise<{ readonly attribute: string | null } | { readonly limit: ProjectionLimit }> {
    const files = new Map<string, IAttributesFile>();
    for (const dir of ['', ...ancestors(path)]) {
      const filePath = dir === '' ? '.gitattributes' : `${dir}/.gitattributes`;
      const entry = head.get(filePath);
      if (entry === undefined) continue;
      let known = this.#headAttributes.get(dir);
      if (known === undefined) {
        const read = await this.attributesBytes(filePath, entry);
        known = 'limit' in read ? read.limit : parseAttributes(read.bytes);
        this.#headAttributes.set(dir, known);
      }
      if ('kind' in known) return { limit: known };
      files.set(dir, known);
    }
    const driver = mergeDriverOf(path, files);
    return { attribute: driver.kind === 'text' ? null : driver.attribute };
  }

  /** A blob's bytes: the proposal's own, or read. */
  async bytes(entry: IProjectedEntry): Promise<Uint8Array> {
    return this.#local.get(entry.oid) ?? this.#basis.sources.blob(entry.oid);
  }

  /**
   * Merges a path's lines, reading its blobs. `favorOurs` keeps the head's
   * text in conflicts, for the probe of what a merge would bring back around
   * a conflict; otherwise a conflict is a conflict.
   */
  async resolve(path: string, merged: EntryMerge, favorOurs: boolean, ours: IProjectedEntry | null): Promise<ResolvedMerge> {
    if (merged.kind === 'entry') return merged;
    if (merged.kind === 'limit') return merged;
    if (merged.kind === 'conflict') return favorOurs ? { kind: 'entry', entry: ours } : { kind: 'conflict', lines: false };
    const sides = [merged.base, merged.ours, merged.theirs];
    const limit = this.#basis.maxBlobBytes;
    const read = sides.filter((e): e is IProjectedEntry => e !== null && !this.#local.has(e.oid));
    if (read.some((e) => e.size === undefined)) return { kind: 'limit', limit: { kind: 'size-unknown', path } };
    if (read.some((e) => e.size !== undefined && e.size > limit)) return { kind: 'limit', limit: { kind: 'too-large', path } };
    const base = merged.base === null ? new Uint8Array(0) : await this.bytes(merged.base);
    const head = await this.bytes(merged.ours);
    const other = await this.bytes(merged.theirs);
    if (isBinaryContent(base) || isBinaryContent(head) || isBinaryContent(other)) return { kind: 'limit', limit: { kind: 'binary', path } };
    const result = mergeText(Buffer.from(base), Buffer.from(head), Buffer.from(other));
    if (result.conflicts > 0 && !favorOurs) return { kind: 'conflict', lines: true };
    return { kind: 'entry', entry: { mode: merged.mode, oid: gitBlobId(result.text) } };
  }
}

/**
 * Projects merging the suggestion pull request whose proposal commit applies
 * `changes` to the reviewed commit onto the head (see the module
 * documentation). Rejects only when a read fails (operational).
 */
export async function projectCompanion(basis: IProjectionBasis, changes: readonly ProjectedChange[]): Promise<CompanionProjection> {
  if (basis.mergeBase === null) return { verdict: 'unfaithful', reasons: [], limits: [{ kind: 'no-merge-base' }] };
  // Read in a fixed order (merge base, reviewed commit, head) so requests are deterministic.
  const commits = [basis.mergeBase, basis.reviewed, basis.head] as const;
  const trees: IProjectionTree[] = [];
  for (const commit of commits) trees.push(await basis.sources.tree(commit));
  const truncated: ProjectionLimit[] = commits.flatMap((commit, i) => (trees[i]?.truncated === true ? [{ kind: 'truncated' as const, commit }] : []));
  if (truncated.length > 0) return { verdict: 'unfaithful', reasons: [], limits: [...new Map(truncated.map((l) => [JSON.stringify(l), l])).values()] };
  const [mTree, rTree, hTree] = trees;
  if (mTree === undefined || rTree === undefined || hTree === undefined) throw new Error('Internal error: a projection tree is missing.');
  const M = mTree.entries;
  const R = rTree.entries;
  const H = hTree.entries;

  const projection = new Projection(basis);
  const P = new Map(R);
  for (const change of changes) {
    if (change.operation === 'delete') {
      P.delete(change.path);
      continue;
    }
    const bytes = Buffer.from(change.text, 'utf8');
    if (change.operation === 'create') {
      P.set(change.path, projection.local(bytes, change.fileMode));
      continue;
    }
    const reviewed = R.get(change.path);
    if (reviewed === undefined || kindOf(reviewed) !== 'file') throw new TypeError(`The proposal edits ${change.path}, which is not a regular file at the reviewed commit.`);
    P.set(change.path, projection.local(bytes, reviewed.mode));
  }

  const entryOf = (tree: ReadonlyMap<string, IProjectedEntry>, path: string): IProjectedEntry | null => tree.get(path) ?? null;
  const paths = [...new Set([...M.keys(), ...R.keys(), ...P.keys()])]
    .filter((path) => !same(entryOf(P, path), entryOf(M, path)) || !same(entryOf(P, path), entryOf(R, path)))
    .sort(byPath);

  // A `.gitattributes` that differs between the commits: which commit's
  // attributes Git's merge reads is not modelled, so a version that could
  // assign a merge driver (or cannot be read) makes the projection
  // undecidable. Whether one could depends on the macros of the root file,
  // so every version of the root file is read too.
  const versions = [M, R, H, P];
  const changedAttributes = [...new Set(versions.flatMap((tree) => [...tree.keys()]))]
    .filter((path) => (path === '.gitattributes' || path.endsWith('/.gitattributes')) && !versions.every((tree) => same(entryOf(tree, path), entryOf(H, path))))
    .sort(byPath);
  if (changedAttributes.length > 0) {
    const parsed = async (path: string, entry: IProjectedEntry | null): Promise<IAttributesFile | null | 'unreadable'> => {
      if (entry === null) return null;
      const read = await projection.attributesBytes(path, entry);
      return 'limit' in read ? 'unreadable' : parseAttributes(read.bytes);
    };
    const rootMacros: IAttributesFile['macros'][] = [];
    let rootUnreadable = false;
    for (const tree of versions) {
      const root = await parsed('.gitattributes', entryOf(tree, '.gitattributes'));
      if (root === 'unreadable') rootUnreadable = true;
      else if (root !== null) rootMacros.push(root.macros);
    }
    for (const path of changedAttributes) {
      let could = rootUnreadable;
      for (const tree of versions) {
        if (could) break;
        const file = await parsed(path, entryOf(tree, path));
        could = file === 'unreadable' || (file !== null && couldAssignMerge(file, rootMacros));
      }
      if (could) projection.limits.push({ kind: 'attributes-changed', path });
    }
  }

  const reasons: { path: string; reason: UnfaithfulReason }[] = [];
  const conflicts: string[] = [];
  let changesHead = false;
  /** Each path's clean result in the merge and in the target, for the file-and-directory check. */
  const mergeResults = new Map<string, IProjectedEntry | null>();
  const targetResults = new Map<string, IProjectedEntry | null>();
  for (const path of paths) {
    const m = entryOf(M, path);
    const r = entryOf(R, path);
    const h = entryOf(H, path);
    const p = entryOf(P, path);
    const targetEntries = mergeEntries(path, r, h, p);
    const mergeEntriesOfPath = mergeEntries(path, m, h, p);
    // Where Git would merge the file's contents, or report a conflict, a merge
    // driver the head's attributes assign decides instead of the text merge.
    if (targetEntries.kind === 'lines' || mergeEntriesOfPath.kind === 'lines' || mergeEntriesOfPath.kind === 'conflict') {
      const driver = await projection.driverOf(path, H);
      if ('limit' in driver) {
        projection.limits.push(driver.limit);
        continue;
      }
      if (driver.attribute !== null) {
        projection.limits.push({ kind: 'merge-attribute', path, attribute: driver.attribute });
        continue;
      }
    }
    const target = await projection.resolve(path, targetEntries, false, h);
    const merge = await projection.resolve(path, mergeEntriesOfPath, false, h);
    if (target.kind === 'limit') {
      projection.limits.push(target.limit);
      continue;
    }
    if (merge.kind === 'limit') {
      projection.limits.push(merge.limit);
      continue;
    }
    if (target.kind === 'conflict' && !target.lines) {
      reasons.push({ path, reason: 'not-expressible' });
      continue;
    }
    if (merge.kind === 'conflict') {
      // Would a merge bring back anything around the conflict? Merge R itself
      // over M, resolving every conflict to the head's side: anything left
      // that is not the head's is content the head no longer has.
      const probe = await projection.resolve(path, mergeEntries(path, m, h, r), true, h);
      if (probe.kind === 'limit') projection.limits.push(probe.limit);
      else if (probe.kind === 'entry' && same(probe.entry, h)) conflicts.push(path);
      else reasons.push({ path, reason: 'restores-beside-conflict' });
      continue;
    }
    if (target.kind === 'conflict') {
      reasons.push({ path, reason: 'not-expressible' });
      continue;
    }
    mergeResults.set(path, merge.entry);
    targetResults.set(path, target.entry);
    if (same(merge.entry, target.entry)) {
      if (!same(merge.entry, h)) changesHead = true;
      continue;
    }
    reasons.push({ path, reason: same(merge.entry, h) ? 'loses' : merge.entry === null ? 'removes' : 'restores' });
  }

  // A path that would be both a file and a directory, in either result.
  const clashes = new Set([...fileDirectoryClashes(H, targetResults), ...fileDirectoryClashes(H, mergeResults)]);
  for (const path of [...clashes].sort(byPath)) {
    if (!reasons.some((r) => r.path === path)) reasons.push({ path, reason: 'file-and-directory' });
  }
  reasons.sort((a, b) => byPath(a.path, b.path));

  // A limit found for several paths (an unreadable attributes file on their way) is stated once.
  const limits = [...new Map([...projection.limits, ...directoryRenameTriggers(M, H, P)].map((l) => [JSON.stringify(l), l])).values()];
  if (reasons.length > 0 || limits.length > 0) return { verdict: 'unfaithful', reasons, limits };
  if (conflicts.length > 0) return { verdict: 'conflicts', conflicts };
  return changesHead ? { verdict: 'faithful' } : { verdict: 'faithful', headUnchanged: true };
}

/**
 * The paths of `results` that would be both a file and a directory once
 * applied over the head's tree: a present result below a path that is a file,
 * or above a path that is one.
 */
function fileDirectoryClashes(head: ReadonlyMap<string, IProjectedEntry>, results: ReadonlyMap<string, IProjectedEntry | null>): string[] {
  if (results.size === 0) return [];
  const tree = new Map(head);
  for (const [path, entry] of results) {
    if (entry === null) tree.delete(path);
    else tree.set(path, entry);
  }
  const dirs = directoriesOf(tree.keys());
  const clashes: string[] = [];
  for (const [path, entry] of results) {
    if (entry === null) continue;
    if (dirs.has(path) || ancestors(path).some((dir) => tree.has(dir))) clashes.push(path);
  }
  return clashes;
}

/**
 * Directory-rename triggers: a path one side added (relative to the merge
 * base) under a directory that exists at the merge base and that the other
 * side removed entirely. Git's directory-rename detection could move such a
 * path, which a projection without rename detection cannot model.
 */
function directoryRenameTriggers(
  M: ReadonlyMap<string, IProjectedEntry>,
  H: ReadonlyMap<string, IProjectedEntry>,
  P: ReadonlyMap<string, IProjectedEntry>,
): ProjectionLimit[] {
  const atBase = directoriesOf(M.keys());
  const triggered = new Set<string>();
  const check = (added: ReadonlyMap<string, IProjectedEntry>, other: ReadonlyMap<string, IProjectedEntry>): void => {
    let otherDirs: Set<string> | undefined;
    for (const path of added.keys()) {
      if (M.has(path)) continue;
      for (const dir of ancestors(path)) {
        if (!atBase.has(dir)) continue;
        otherDirs ??= directoriesOf(other.keys());
        if (!otherDirs.has(dir)) triggered.add(dir);
      }
    }
  };
  check(P, H);
  check(H, P);
  return [...triggered].sort(byPath).map((directory) => ({ kind: 'directory-rename', directory }));
}
