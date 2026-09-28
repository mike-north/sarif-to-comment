'use strict';

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

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * An npm environment isolated from the developer's machine: a private cache,
 * log directory and empty user/global config under `dir`, offline, no audit,
 * fund or update checks, and no lifecycle scripts.
 */
function isolatedNpmEnv(dir) {
  const userconfig = path.join(dir, 'npmrc');
  const globalconfig = path.join(dir, 'global-npmrc');
  fs.writeFileSync(userconfig, '');
  fs.writeFileSync(globalconfig, '');
  const env = { PATH: process.env.PATH, HOME: dir };
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
function npm(args, { cwd, env }) {
  return spawnSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
}

/** Lines of npm's debug log kept in a failure message. */
const DEBUG_LOG_TAIL_LINES = 80;

/**
 * An Error describing a failed npm command: its output, and the tail of the
 * debug log npm names ("A complete log of this run can be found in: …"),
 * which records the cause npm's one-line summary omits.
 */
function npmFailure(what, run) {
  const output = `${run.stdout || ''}${run.stderr || ''}`.trim();
  const named = /A complete log of this run can be found in:\s*(\S+)/.exec(output);
  let debug = '';
  if (named && fs.existsSync(named[1])) {
    const lines = fs.readFileSync(named[1], 'utf8').trimEnd().split('\n');
    debug = `\n--- npm debug log (${named[1]}), last ${Math.min(lines.length, DEBUG_LOG_TAIL_LINES)} lines ---\n${lines.slice(-DEBUG_LOG_TAIL_LINES).join('\n')}`;
  }
  const signal = run.signal ? ` (signal ${run.signal})` : '';
  return new assert.AssertionError({ message: `${what} failed (exit ${run.status}${signal}): ${output}${debug}` });
}

/**
 * An npm-format tarball (`package/…`) of the installed dependency in `dir`,
 * written to `destDir`: every installed file (symlinks resolved), excluding a
 * nested node_modules, whose packages are supplied as their own tarballs.
 */
function dependencyTarball(dir, destDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
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
function runtimeDependencyDirs() {
  const dirs = new Map();
  const visit = (name, fromDir) => {
    const manifestPath = require.resolve(`${name}/package.json`, { paths: [fromDir] });
    const dir = fs.realpathSync(path.dirname(manifestPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const key = `${name}@${manifest.version}`;
    if (dirs.has(key)) return;
    dirs.set(key, dir);
    for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) visit(dep, dir);
  };
  for (const name of Object.keys(PKG.dependencies)) visit(name, ROOT);
  return [...dirs.values()];
}

let packed;
let packFailure;

/**
 * The packed tarball of this checkout: { work, env, packDir, result, tarball,
 * error }. `error` is set (and nothing else is usable) when npm cannot run at
 * all; a failed `npm pack` throws, and keeps throwing the same error.
 */
function packProject() {
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
  const [result] = JSON.parse(run.stdout);
  packed = { work, env, packDir, result, tarball: path.join(packDir, result.filename) };
  return packed;
}

let installed;
let installFailure;

/**
 * A clean consumer project with the packed package installed by npm:
 * { consumer, packageDir, bin, env } (env is the isolated npm environment).
 * A failure is thrown, and the same error is thrown to every later caller.
 */
function installIntoConsumer() {
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

function install() {
  const { work, env, tarball } = packProject();
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

module.exports = {
  ROOT,
  PKG,
  isolatedNpmEnv,
  npm,
  packProject,
  installIntoConsumer,
  runtimeDependencyDirs,
  dependencyTarball,
};
