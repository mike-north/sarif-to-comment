'use strict';

/**
 * Package acceptance tests: the package a consumer installs is the product.
 *
 * - The manifest names the real entry points (library main/exports and the
 *   CLI bin), keeps publication to the npm registry impossible (private), pins
 *   the supported Node range and lists every runtime dependency the shipped
 *   sources require.
 * - `npm pack` produces exactly the whitelisted distributable files: sources,
 *   CLI, vendored schema and README — never tests, logs, docs, private
 *   evidence or agent configuration.
 * - The packed tarball is really installed with `npm install` into a clean
 *   temporary consumer project, together with locally packed tarballs of its
 *   runtime dependency closure, so no registry or network is needed. The
 *   installed library is used in memory (through an injected GitHub client,
 *   with its own packaged schema) and the installed executable is run.
 * - Scripts follow purpose-based names: `test` runs the suite, `check` and
 *   `check:lint` are read-only (no fixing hidden inside a check).
 *
 * npm runs in an isolated environment (private cache, logs and empty config
 * under a temp directory, offline, no scripts): the developer's ~/.npm and
 * ~/.npmrc are never read or written. Nothing here publishes anything.
 *
 * @see https://docs.npmjs.com/cli/v11/configuring-npm/package-json
 * @see https://docs.npmjs.com/cli/v11/commands/npm-pack
 * @see https://nodejs.org/api/packages.html#package-entry-points
 */

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EXPECTED_FILES_FIELD = ['src/', 'bin/', 'vendor/', 'README.md'];

/** Every non-builtin module the shipped sources require, by package name. */
function requiredPackages() {
  const names = new Set();
  for (const dir of ['src', 'bin']) {
    for (const file of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.cjs'))) {
      const text = fs.readFileSync(path.join(ROOT, dir, file), 'utf8');
      for (const [, spec] of text.matchAll(/require\('([^']+)'\)/g)) {
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        names.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
      }
    }
  }
  return names;
}

describe('manifest', () => {
  test('identity, privacy and module type', () => {
    assert.equal(PKG.name, 'sarif-to-comment');
    assert.equal(PKG.version, '0.1.0');
    assert.equal(PKG.private, true, 'private: true keeps registry publication impossible (deferred)');
    assert.equal(PKG.type, 'commonjs');
  });

  test('library entry points resolve to the real public module', () => {
    assert.equal(PKG.main, './src/index.cjs');
    assert.deepEqual(PKG.exports, { '.': './src/index.cjs', './package.json': './package.json' });
    const resolved = require.resolve(path.join(ROOT, PKG.exports['.']));
    assert.equal(resolved, path.join(ROOT, 'src', 'index.cjs'));
    assert.equal(typeof require(resolved).publishSarifReview, 'function');
  });

  test('the CLI bin points at an executable Node script', () => {
    assert.deepEqual(PKG.bin, { 'sarif-to-comment': './bin/sarif-to-comment.cjs' });
    const text = fs.readFileSync(path.join(ROOT, PKG.bin['sarif-to-comment']), 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env node\n'), 'bin must start with a node shebang');
  });

  test('the supported Node range is declared and satisfied by this runtime', () => {
    assert.deepEqual(PKG.engines, { node: '>=22' });
    assert.ok(Number(process.versions.node.split('.')[0]) >= 22, `running Node ${process.versions.node}`);
  });

  test('the files whitelist is exact', () => {
    const expected = [...EXPECTED_FILES_FIELD];
    for (const license of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      if (fs.existsSync(path.join(ROOT, license))) expected.push(license);
    }
    assert.deepEqual(PKG.files, expected);
  });

  test('every runtime require is a declared dependency', () => {
    const declared = new Set(Object.keys(PKG.dependencies || {}));
    for (const name of requiredPackages()) assert.ok(declared.has(name), `${name} is required at runtime but not a dependency`);
    for (const name of ['ajv', 'ajv-draft-04', 'ajv-formats']) assert.ok(declared.has(name), `${name} must stay a runtime dependency`);
  });

  test('scripts are purpose-named and checks are read-only', () => {
    const scripts = PKG.scripts || {};
    assert.equal(scripts.test, 'node --test test/*.test.cjs');
    assert.match(scripts['check:lint'] || '', /^eslint\b/);
    assert.ok(scripts.check, 'an aggregate read-only check script exists');
    for (const [name, command] of Object.entries(scripts)) {
      if (name === 'check' || name.startsWith('check:')) {
        assert.doesNotMatch(command, /--fix\b|--write\b/, `${name} must not modify files`);
      }
      assert.doesNotMatch(command, /\bnpm publish\b|\bpnpm publish\b/, `${name} must not publish`);
    }
  });
});

/**
 * An npm environment isolated from the developer's machine: a private cache,
 * log directory and empty user/global config under `dir`, offline, no audit,
 * fund or update checks, and no lifecycle scripts. The user's ~/.npm and
 * ~/.npmrc are neither read nor written.
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

/** Runs npm with an isolated environment; returns spawnSync's result. */
function npm(args, { cwd, env }) {
  return spawnSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
}

/**
 * Directories of every runtime dependency, transitively (dependencies and
 * peer dependencies), as installed for this workspace. Packing these gives
 * a consumer install everything it needs without a registry.
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

describe('packed distributable', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sarif-to-comment-pack-'));
  const env = isolatedNpmEnv(work);
  const packDir = path.join(work, 'tarballs');
  fs.mkdirSync(packDir);
  const pack = npm(['pack', '--json', '--pack-destination', packDir], { cwd: ROOT, env });
  const packUnavailable = pack.error ? `npm could not run: ${pack.error.message}` : false;

  function packResult() {
    assert.equal(pack.status, 0, `npm pack failed: ${pack.stderr}`);
    const [result] = JSON.parse(pack.stdout);
    return result;
  }

  test('contains exactly the distributable files', { skip: packUnavailable }, () => {
    const files = packResult().files.map((f) => f.path).sort();
    const allowed = (file) =>
      file === 'package.json' ||
      file === 'README.md' ||
      /^LICENSE(\.md|\.txt)?$/.test(file) ||
      /^src\/[^/]+\.cjs$/.test(file) ||
      file === 'bin/sarif-to-comment.cjs' ||
      /^vendor\/[^/]+$/.test(file);
    assert.deepEqual(files.filter((f) => !allowed(f)), [], 'unexpected files in the package');
    for (const required of [
      'package.json',
      'README.md',
      'bin/sarif-to-comment.cjs',
      'vendor/sarif-schema-2.1.0.json',
      'vendor/README.md',
      ...fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.cjs')).map((f) => `src/${f}`),
    ]) {
      assert.ok(files.includes(required), `${required} is missing from the package`);
    }
  });

  test(
    'npm install of the tarball into a clean consumer: in-memory library use and the installed executable',
    { skip: packUnavailable, timeout: 300_000 },
    () => {
      const product = path.join(packDir, packResult().filename);
      const dependencyTarballs = runtimeDependencyDirs().map((dir) => {
        const packed = npm(['pack', '--json', '--pack-destination', packDir, dir], { cwd: work, env });
        assert.equal(packed.status, 0, `packing dependency ${dir} failed: ${packed.stderr}`);
        return path.join(packDir, JSON.parse(packed.stdout)[0].filename);
      });

      const consumer = path.join(work, 'consumer');
      fs.mkdirSync(consumer);
      fs.writeFileSync(
        path.join(consumer, 'package.json'),
        JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }, null, 2),
      );
      const install = npm(['install', '--no-save', product, ...dependencyTarballs], { cwd: consumer, env });
      assert.equal(install.status, 0, `npm install failed:\n${install.stdout}\n${install.stderr}`);

      const installed = path.join(consumer, 'node_modules', 'sarif-to-comment');
      const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
      assert.equal(manifest.version, PKG.version);
      assert.equal(fs.existsSync(path.join(installed, 'test')), false, 'tests must not be installed');

      const js = String.raw;
      const script = js`
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const { publishSarifReview } = require('sarif-to-comment');
        const resolved = fs.realpathSync(require.resolve('sarif-to-comment'));
        assert.ok(resolved.startsWith(fs.realpathSync(${JSON.stringify(installed)})), 'resolved outside the install: ' + resolved);
        assert.equal(require('sarif-to-comment/package.json').name, 'sarif-to-comment');
        const { FakeGitHubRemote } = require(${JSON.stringify(path.join(ROOT, 'test/fixtures/publication/fake-github.cjs'))});
        const { createFakeClientFactory, REPOSITORY } = require(${JSON.stringify(path.join(ROOT, 'test/fixtures/public-api/fake-adapter.cjs'))});
        const sarif = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(ROOT, 'test/fixtures/public-api/ready.sarif.json'))}, 'utf8'));
        (async () => {
          await assert.rejects(publishSarifReview({}), TypeError);
          const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-world-'));
          const remote = FakeGitHubRemote.create(path.join(root, 'remote'));
          const input = { sarif, destination: REPOSITORY.destination, reviewedCommit: REPOSITORY.commits.head,
            statePath: path.join(root, 'state.json'), token: 'ghp_consumer_smoke_token_value' };
          const outcome = await publishSarifReview(input, { createGitHubClient: createFakeClientFactory(remote.dir) });
          assert.equal(outcome.status, 'published', outcome.markdown);
          assert.equal(remote.calls('createReview').length, 1);
          const again = await publishSarifReview(input, { createGitHubClient: createFakeClientFactory(remote.dir) });
          assert.deepEqual(again.review, outcome.review);
          assert.equal(remote.calls('createReview').length, 1);
          process.stdout.write('consumer-ok ' + outcome.review.url + '\n');
        })().catch((err) => { console.error(err); process.exit(1); });
      `;
      const library = spawnSync(process.execPath, ['-e', script], { cwd: consumer, encoding: 'utf8', timeout: 60_000 });
      assert.equal(library.status, 0, library.stderr);
      assert.match(library.stdout, /^consumer-ok https:\/\/github\.com\/acme\/gizmos\/pull\/7#pullrequestreview-\d+/);

      const bin = path.join(consumer, 'node_modules', '.bin', 'sarif-to-comment');
      assert.ok(fs.existsSync(bin), 'npm must link the installed executable');
      const cleanEnv = { PATH: process.env.PATH };
      const help = spawnSync(bin, ['--help'], { cwd: consumer, encoding: 'utf8', env: cleanEnv });
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /--sarif FILE/);
      const usage = spawnSync(bin, ['--pull', '7'], { cwd: consumer, encoding: 'utf8', env: cleanEnv });
      assert.equal(usage.status, 1);
      assert.match(usage.stderr, /missing required option --sarif/);
      const noToken = spawnSync(
        bin,
        ['--sarif', 'x.sarif', '--repo', 'acme/gizmos', '--pull', '7', '--commit', 'a'.repeat(40), '--state', path.join(consumer, 's.json')],
        { cwd: consumer, encoding: 'utf8', env: cleanEnv },
      );
      assert.equal(noToken.status, 1);
      assert.match(noToken.stderr, /GH_TOKEN/);
    },
  );
});
