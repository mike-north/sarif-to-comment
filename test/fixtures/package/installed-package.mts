/**
 * Builds and installs this package exactly as a consumer receives it, for
 * package, type and documentation tests.
 *
 * `npm pack` produces the distributable tarball; `npm install` puts it,
 * together with tarballs of its runtime dependency closure, into a clean
 * temporary consumer project. The dependency tarballs contain exactly the
 * files the lockfile installed, in npm's `package/` layout, and are built
 * with `tar` rather than `npm pack`: third-party packages are not under test,
 * and asking npm to repack them out of pnpm's virtual store failed on the
 * GitHub-hosted Ubuntu runner (Node 24.21.0, npm 11.19.0: "Exit handler never
 * called!"). The product itself is always packed and installed by real npm. npm runs isolated from the
 * developer's machine (private cache, logs and empty config under a temp
 * directory, offline, no lifecycle scripts), so no registry, network or
 * personal npm configuration is involved and nothing is published.
 *
 * Results are memoized per process: each test file packs and installs once,
 * and a failure is recorded once and reported to every caller. A failed npm
 * command's error includes the tail of npm's own debug log, so a failure on a
 * remote runner names its cause.
 *
 * @see https://docs.npmjs.com/cli/v11/commands/npm-pack
 * @see https://docs.npmjs.com/cli/v11/commands/npm-install
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';

import {
  expectType,
  isArrayOf,
  isOptional,
  isRecordOf,
  isShape,
  isString,
  parseJson,
  readJson,
} from '../../support/runtime-types.mts';
import type { Guard } from '../../support/runtime-types.mts';

/** The parts of a package.json this harness and its callers read; other fields are kept. */
export interface IPackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>> | undefined;
  readonly peerDependencies?: Readonly<Record<string, string>> | undefined;
  readonly [field: string]: unknown;
}

/** The environment npm runs with (see isolatedNpmEnv). */
export type NpmEnv = Record<string, string | undefined>;

/** One file of a packed tarball, as `npm pack --json` lists it. */
export interface INpmPackFile {
  readonly path: string;
  readonly [field: string]: unknown;
}

/** `npm pack --json`'s description of one packed tarball. */
export interface INpmPackResult {
  readonly filename: string;
  readonly files: readonly INpmPackFile[];
  readonly [field: string]: unknown;
}

/** The packed tarball of this checkout. */
export interface IPackedProject {
  readonly error?: undefined;
  /** Scratch directory holding the isolated npm environment and the tarballs. */
  readonly work: string;
  readonly env: NpmEnv;
  readonly packDir: string;
  readonly result: INpmPackResult;
  readonly tarball: string;
}

/** npm could not run at all; nothing else is usable. */
export interface IPackUnavailable {
  readonly error: string;
}

/** A clean consumer project with the packed package installed by npm. */
export interface IInstalledConsumer {
  readonly consumer: string;
  readonly packageDir: string;
  readonly bin: string;
  /** The isolated npm environment. */
  readonly env: NpmEnv;
}

const isPackageManifest: Guard<IPackageManifest> = isShape({
  name: isString,
  version: isString,
  dependencies: isOptional(isRecordOf(isString)),
  peerDependencies: isOptional(isRecordOf(isString)),
});

const isNpmPackOutput: Guard<[INpmPackResult]> = (value: unknown): value is [INpmPackResult] =>
  isArrayOf(isShape({ filename: isString, files: isArrayOf(isShape({ path: isString })) }))(value) &&
  value.length === 1;

export const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const PKG: IPackageManifest = expectType(readJson(path.join(ROOT, 'package.json')), isPackageManifest, 'package.json');

/**
 * Resolves `<name>/package.json` from a given directory. createRequire gives
 * require.resolve's `paths` option, which import.meta.resolve lacks: the
 * dependency walk must resolve each package from its dependent's directory.
 */
const requireFromHere = createRequire(import.meta.url);

/**
 * An npm environment isolated from the developer's machine: a private cache,
 * log directory and empty user/global config under `dir`, offline, no audit,
 * fund or update checks, and no lifecycle scripts.
 */
export function isolatedNpmEnv(dir: string): NpmEnv {
  const userconfig = path.join(dir, 'npmrc');
  const globalconfig = path.join(dir, 'global-npmrc');
  fs.writeFileSync(userconfig, '');
  fs.writeFileSync(globalconfig, '');
  const env: NpmEnv = { PATH: process.env['PATH'], HOME: dir };
  for (const [key, value] of Object.entries({
    cache: path.join(dir, 'cache'),
    logs_dir: path.join(dir, 'logs'),
    userconfig,
    globalconfig,
    offline: 'true',
    audit: 'false',
    fund: 'false',
    update_notifier: 'false',
    ignore_scripts: 'true',
    package_lock: 'false',
  })) {
    env[`npm_config_${key}`] = value;
  }
  return env;
}

/** Runs npm with the isolated environment; returns spawnSync's result. */
export function npm(args: readonly string[], { cwd, env }: { readonly cwd: string; readonly env: NpmEnv }): SpawnSyncReturns<string> {
  return spawnSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
}

/** Lines of npm's debug log kept in a failure message. */
const DEBUG_LOG_TAIL_LINES = 80;

/**
 * An Error describing a failed npm command: its output, and the tail of the
 * debug log npm names ("A complete log of this run can be found in: …"),
 * which records the cause npm's one-line summary omits.
 */
function npmFailure(what: string, run: SpawnSyncReturns<string>): assert.AssertionError {
  const output = `${run.stdout || ''}${run.stderr || ''}`.trim();
  const named = /A complete log of this run can be found in:\s*(\S+)/.exec(output);
  const logFile = named?.[1];
  let debug = '';
  if (logFile !== undefined && fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
    debug = `\n--- npm debug log (${logFile}), last ${String(Math.min(lines.length, DEBUG_LOG_TAIL_LINES))} lines ---\n${lines.slice(-DEBUG_LOG_TAIL_LINES).join('\n')}`;
  }
  const signal = run.signal ? ` (signal ${run.signal})` : '';
  return new assert.AssertionError({ message: `${what} failed (exit ${String(run.status)}${signal}): ${output}${debug}` });
}

/**
 * An npm-format tarball (`package/…`) of the installed dependency in `dir`,
 * written to `destDir`: every installed file (symlinks resolved), excluding a
 * nested node_modules, whose packages are supplied as their own tarballs.
 */
export function dependencyTarball(dir: string, destDir: string): string {
  const manifest = expectType(readJson(path.join(dir, 'package.json')), isPackageManifest, `${dir}/package.json`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-'));
  const packageRoot = path.join(staging, 'package');
  fs.cpSync(dir, packageRoot, {
    recursive: true,
    dereference: true,
    filter: (source) => path.relative(dir, source) !== 'node_modules',
  });
  const tarball = path.join(destDir, `${manifest.name.replace(/^@/, '').replace(/\//g, '-')}-${manifest.version}.tgz`);
  const run = spawnSync('tar', ['-czf', tarball, '-C', staging, 'package'], { encoding: 'utf8' });
  fs.rmSync(staging, { recursive: true, force: true });
  if (run.status !== 0) throw npmFailure(`tar of dependency ${dir}`, run);
  return tarball;
}

/**
 * Directories of every runtime dependency, transitively (dependencies and
 * peer dependencies), as installed for this workspace.
 */
export function runtimeDependencyDirs(): string[] {
  const dirs = new Map<string, string>();
  const visit = (name: string, fromDir: string): void => {
    const manifestPath = requireFromHere.resolve(`${name}/package.json`, { paths: [fromDir] });
    const dir = fs.realpathSync(path.dirname(manifestPath));
    const manifest = expectType(readJson(manifestPath), isPackageManifest, manifestPath);
    const key = `${name}@${manifest.version}`;
    if (dirs.has(key)) return;
    dirs.set(key, dir);
    for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) visit(dep, dir);
  };
  for (const name of Object.keys(PKG.dependencies ?? {})) visit(name, ROOT);
  return [...dirs.values()];
}

let packed: IPackedProject | IPackUnavailable | undefined;
let packFailure: Error | undefined;

/**
 * The packed tarball of this checkout: { work, env, packDir, result, tarball,
 * error }. `error` is set (and nothing else is usable) when npm cannot run at
 * all; a failed `npm pack` throws, and keeps throwing the same error.
 */
export function packProject(): IPackedProject | IPackUnavailable {
  if (packFailure) throw packFailure;
  if (packed) return packed;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sarif-to-comment-pack-'));
  const env = isolatedNpmEnv(work);
  const packDir = path.join(work, 'tarballs');
  fs.mkdirSync(packDir);
  const run = npm(['pack', '--json', '--pack-destination', packDir], { cwd: ROOT, env });
  if (run.error) {
    packed = { error: `npm could not run: ${run.error.message}` };
    return packed;
  }
  if (run.status !== 0) {
    packFailure = npmFailure('npm pack', run);
    throw packFailure;
  }
  const [result] = expectType(parseJson(run.stdout), isNpmPackOutput, 'npm pack --json output for one tarball');
  packed = { work, env, packDir, result, tarball: path.join(packDir, result.filename) };
  return packed;
}

/**
 * The packed tarball, for a test that is skipped when npm cannot run (its
 * `skip` option is `packProject().error || false`): the unavailability is
 * thrown here rather than handled again.
 */
export function requirePackedProject(): IPackedProject {
  const project = packProject();
  if (project.error !== undefined) throw new Error(project.error);
  return project;
}

let installed: IInstalledConsumer | undefined;
let installFailure: unknown;

/**
 * A clean consumer project with the packed package installed by npm:
 * { consumer, packageDir, bin, env } (env is the isolated npm environment).
 * A failure is thrown, and the same error is thrown to every later caller.
 */
export function installIntoConsumer(): IInstalledConsumer {
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- rethrows exactly the value the first install attempt threw
  if (installFailure) throw installFailure;
  if (installed) return installed;
  try {
    installed = install();
    return installed;
  } catch (err) {
    installFailure = err;
    throw err;
  }
}

function install(): IInstalledConsumer {
  const { work, env, tarball } = requirePackedProject();
  const dependencyDir = fs.mkdtempSync(path.join(work, 'dependencies-'));
  const dependencyTarballs = runtimeDependencyDirs().map((dir) => dependencyTarball(dir, dependencyDir));
  const consumer = fs.mkdtempSync(path.join(work, 'consumer-'));
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }, null, 2),
  );
  const run = npm(['install', '--no-save', tarball, ...dependencyTarballs], { cwd: consumer, env });
  if (run.status !== 0) throw npmFailure('npm install', run);
  return {
    consumer,
    packageDir: path.join(consumer, 'node_modules', 'sarif-to-comment'),
    bin: path.join(consumer, 'node_modules', '.bin', 'sarif-to-comment'),
    env,
  };
}
