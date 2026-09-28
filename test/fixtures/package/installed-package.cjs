'use strict';

/**
 * Builds and installs this package exactly as a consumer receives it, for
 * package, type and documentation tests.
 *
 * `npm pack` produces the distributable tarball; `npm install` puts it,
 * together with locally packed tarballs of its runtime dependency closure,
 * into a clean temporary consumer project. npm runs isolated from the
 * developer's machine (private cache, logs and empty config under a temp
 * directory, offline, no lifecycle scripts), so no registry, network or
 * personal npm configuration is involved and nothing is published.
 *
 * Results are memoized per process: each test file packs and installs once.
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

/**
 * The packed tarball of this checkout: { work, env, packDir, result, tarball,
 * error }. `error` is set (and nothing else is usable) when npm cannot run.
 */
function packProject() {
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
  assert.equal(run.status, 0, `npm pack failed: ${run.stderr}`);
  const [result] = JSON.parse(run.stdout);
  packed = { work, env, packDir, result, tarball: path.join(packDir, result.filename) };
  return packed;
}

let installed;

/**
 * A clean consumer project with the packed package installed by npm:
 * { consumer, packageDir, bin, env } (env is the isolated npm environment).
 */
function installIntoConsumer() {
  if (installed) return installed;
  const { work, env, packDir, tarball } = packProject();
  const dependencyTarballs = runtimeDependencyDirs().map((dir) => {
    const run = npm(['pack', '--json', '--pack-destination', packDir, dir], { cwd: work, env });
    assert.equal(run.status, 0, `packing dependency ${dir} failed: ${run.stderr}`);
    return path.join(packDir, JSON.parse(run.stdout)[0].filename);
  });
  const consumer = fs.mkdtempSync(path.join(work, 'consumer-'));
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }, null, 2),
  );
  const install = npm(['install', '--no-save', tarball, ...dependencyTarballs], { cwd: consumer, env });
  assert.equal(install.status, 0, `npm install failed:\n${install.stdout}\n${install.stderr}`);
  installed = {
    consumer,
    packageDir: path.join(consumer, 'node_modules', 'sarif-to-comment'),
    bin: path.join(consumer, 'node_modules', '.bin', 'sarif-to-comment'),
    env,
  };
  return installed;
}

module.exports = { ROOT, PKG, isolatedNpmEnv, npm, packProject, installIntoConsumer };
