'use strict';

/**
 * Build tests: dist/ is what the tests exercise and the package ships, so it
 * must be a complete build of exactly the current sources.
 *
 * - The freshness guard (scripts/build-manifest.mts) accepts a fresh build
 *   and refuses, naming the path and `pnpm run build`, every way dist/ can
 *   disagree with its inputs: an edited, added or removed input (sources,
 *   hand-written declarations, configuration), a missing or unfinished build,
 *   and an orphaned, removed or tampered output.
 * - A build that fails leaves no manifest, so the guard refuses its dist/.
 * - While runtime modules are still JavaScript, dist/ holds byte-identical
 *   copies of them and of the hand-written declarations; these checks follow
 *   the sources and fall away as modules are converted.
 *
 * @see https://nodejs.org/api/typescript.html#type-stripping
 */

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_TOOL = path.join(ROOT, 'scripts', 'build-manifest.mts');

/** Runs the freshness tool on `dir` (`write` or `verify`). */
function manifestTool(command, dir) {
  return spawnSync(process.execPath, [MANIFEST_TOOL, command, dir], { encoding: 'utf8' });
}

/** A minimal project whose dist/ is a fresh, complete build as recorded by the build. */
function builtProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-manifest-'));
  const files = {
    'package.json': '{"name":"probe","version":"1.0.0"}\n',
    'tsconfig.base.json': '{"compilerOptions":{"strict":true}}\n',
    'src/tsconfig.json': '{"extends":"../tsconfig.base.json"}\n',
    'src/index.cjs': "'use strict';\nmodule.exports = { answer: 42 };\n",
    'src/helper.cjs': "'use strict';\n",
    'types/index.d.ts': 'export declare const answer: number;\n',
    'dist/index.cjs': "'use strict';\nmodule.exports = { answer: 42 };\n",
    'dist/helper.cjs': "'use strict';\n",
    'dist/sarif-to-comment.d.ts': 'export declare const answer: number;\n',
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  const write = manifestTool('write', dir);
  assert.equal(write.status, 0, write.stderr);
  return dir;
}

describe('the build-freshness guard', () => {
  test('accepts a fresh, complete build', () => {
    const run = manifestTool('verify', builtProject());
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
  });

  test('the manifest records every input and output by content hash, sorted', () => {
    const dir = builtProject();
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'dist', '.build-inputs.json'), 'utf8'));
    assert.equal(manifest.version, 1);
    assert.deepEqual(Object.keys(manifest.inputs), [
      'package.json',
      'src/helper.cjs',
      'src/index.cjs',
      'src/tsconfig.json',
      'tsconfig.base.json',
      'types/index.d.ts',
    ]);
    assert.deepEqual(Object.keys(manifest.outputs), ['dist/helper.cjs', 'dist/index.cjs', 'dist/sarif-to-comment.d.ts']);
    for (const hash of [...Object.values(manifest.inputs), ...Object.values(manifest.outputs)]) assert.match(hash, /^[0-9a-f]{64}$/);
  });

  const stale = {
    'an edited source': [(dir) => fs.appendFileSync(path.join(dir, 'src', 'index.cjs'), '// edit\n'), /input changed since the build: src\/index\.cjs/],
    'an added source': [(dir) => fs.writeFileSync(path.join(dir, 'src', 'extra.cjs'), '\n'), /input added since the build: src\/extra\.cjs/],
    'a removed source': [(dir) => fs.rmSync(path.join(dir, 'src', 'helper.cjs')), /input removed since the build: src\/helper\.cjs/],
    'edited hand-written declarations': [
      (dir) => fs.appendFileSync(path.join(dir, 'types', 'index.d.ts'), '\n'),
      /input changed since the build: types\/index\.d\.ts/,
    ],
    'a changed compiler configuration': [
      (dir) => fs.writeFileSync(path.join(dir, 'tsconfig.base.json'), '{}\n'),
      /input changed since the build: tsconfig\.base\.json/,
    ],
    'an added compiler configuration': [
      (dir) => fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}\n'),
      /input added since the build: tsconfig\.json/,
    ],
    'a changed manifest': [
      (dir) => fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"probe","version":"1.0.1"}\n'),
      /input changed since the build: package\.json/,
    ],
    'no build at all': [(dir) => fs.rmSync(path.join(dir, 'dist'), { recursive: true }), /missing or unreadable/],
    'an unfinished build (outputs without a manifest)': [
      (dir) => fs.rmSync(path.join(dir, 'dist', '.build-inputs.json')),
      /missing or unreadable/,
    ],
    'an unreadable manifest': [(dir) => fs.writeFileSync(path.join(dir, 'dist', '.build-inputs.json'), '{"version":1,'), /missing or unreadable/],
    'a manifest of another format': [
      (dir) => fs.writeFileSync(path.join(dir, 'dist', '.build-inputs.json'), '{"version":2,"inputs":{},"outputs":{}}'),
      /missing or unreadable/,
    ],
    'an orphaned output': [(dir) => fs.writeFileSync(path.join(dir, 'dist', 'removed-module.cjs'), '\n'), /output added since the build: dist\/removed-module\.cjs/],
    'a removed output': [(dir) => fs.rmSync(path.join(dir, 'dist', 'helper.cjs')), /output removed since the build: dist\/helper\.cjs/],
    'a tampered output': [(dir) => fs.appendFileSync(path.join(dir, 'dist', 'index.cjs'), '// patched\n'), /output changed since the build: dist\/index\.cjs/],
  };
  for (const [label, [change, reason]] of Object.entries(stale)) {
    test(`refuses ${label}, naming the cause and the fix`, () => {
      const dir = builtProject();
      change(dir);
      const run = manifestTool('verify', dir);
      assert.equal(run.status, 1, run.stderr);
      assert.match(run.stderr, reason);
      assert.match(run.stderr, /run `pnpm run build`/);
    });
  }

  test('a change restored to the recorded content is fresh again (content, not timestamps)', () => {
    const dir = builtProject();
    const file = path.join(dir, 'src', 'index.cjs');
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, 'changed\n');
    assert.equal(manifestTool('verify', dir).status, 1);
    fs.writeFileSync(file, original);
    const later = new Date(Date.UTC(2031, 0, 1));
    fs.utimesSync(file, later, later);
    assert.equal(manifestTool('verify', dir).status, 0);
  });

  test('an unknown command is a usage error', () => {
    const run = spawnSync(process.execPath, [MANIFEST_TOOL, 'refresh'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /Usage/);
  });

  test('this checkout is fresh: the tests run against a build of the current sources', () => {
    const run = spawnSync(process.execPath, [MANIFEST_TOOL, 'verify'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  });
});

describe('the build', () => {
  test('a build that fails leaves no manifest, so its dist/ is refused', { timeout: 240_000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-failure-'));
    for (const entry of ['package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'tsconfig.json', 'api-extractor.json', 'src', 'types', 'scripts']) {
      fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    // A module that does not type-check stops the compile step.
    fs.writeFileSync(path.join(dir, 'src', 'build-probe.cts'), 'export const broken: number = "not a number";\n');
    const build = spawnSync(process.execPath, ['scripts/build.mts'], { cwd: dir, encoding: 'utf8', timeout: 200_000 });
    assert.notEqual(build.status, 0, 'the build must fail');
    assert.match(build.stdout + build.stderr, /TS2322/);
    assert.equal(fs.existsSync(path.join(dir, 'dist', '.build-inputs.json')), false, 'no manifest after a failed build');
    const verify = manifestTool('verify', dir);
    assert.equal(verify.status, 1);
    assert.match(verify.stderr, /pnpm run build/);
  });

  test('refuses a module that exists both as JavaScript and as TypeScript', { timeout: 60_000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-duplicate-'));
    for (const entry of ['package.json', 'tsconfig.base.json', 'src', 'scripts']) {
      fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    // A synthetic module name keeps this independent of which real modules are
    // still JavaScript: the rule is about any name present in both languages.
    fs.writeFileSync(path.join(dir, 'src', 'duplicate-probe.cjs'), "'use strict';\n");
    fs.writeFileSync(path.join(dir, 'src', 'duplicate-probe.cts'), 'export {};\n');
    const build = spawnSync(process.execPath, ['scripts/build.mts'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(build.status, 0);
    assert.match(build.stderr, /duplicate-probe\.cjs/);
    assert.equal(fs.existsSync(path.join(dir, 'dist')), false, 'nothing was built');
  });
});

describe('transitional JavaScript modules ship unchanged', () => {
  // Until a module is converted to TypeScript, the build copies it byte for
  // byte; the only intended change from the released package is the path.
  const javascript = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.cjs'));

  test('every src/*.cjs is byte-identical in dist/', () => {
    for (const file of javascript) {
      assert.ok(
        fs.readFileSync(path.join(ROOT, 'dist', file)).equals(fs.readFileSync(path.join(ROOT, 'src', file))),
        `dist/${file} differs from src/${file}`,
      );
    }
  });

  test('the hand-written declarations are shipped as the public declaration file while they exist', () => {
    const handWritten = path.join(ROOT, 'types', 'index.d.ts');
    if (!fs.existsSync(handWritten)) return;
    assert.ok(fs.readFileSync(path.join(ROOT, 'dist', 'sarif-to-comment.d.ts')).equals(fs.readFileSync(handWritten)));
  });

  test('the executable is a runtime module beside the library it runs', () => {
    const text = fs.readFileSync(path.join(ROOT, 'dist', 'sarif-to-comment.cjs'), 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env node\n'));
    assert.match(text, /require\(['"]\.\/cli\.cjs['"]\)/);
  });
});
