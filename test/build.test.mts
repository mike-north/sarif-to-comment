/**
 * Build tests: dist/ is what the tests exercise and the package ships, so it
 * must be a complete build of exactly the current sources.
 *
 * - The freshness guard (scripts/build-manifest.mts) accepts a fresh build
 *   and refuses, naming the path and `pnpm run build`, every way dist/ can
 *   disagree with its inputs: an edited, added or removed input (sources,
 *   configuration), a missing or unfinished build, and an orphaned, removed
 *   or tampered output.
 * - A build that fails leaves no manifest, so the guard refuses its dist/.
 * - src/ holds TypeScript only: the build refuses any JavaScript module there.
 * - The public declaration file is generated: API Extractor rolls it up from
 *   the declaration entry, and it declares the public signatures only.
 *
 * @see https://nodejs.org/api/typescript.html#type-stripping
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { expectType, isNumber, isRecordOf, isShape, isString, readJson } from './support/runtime-types.mts';

const ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST_TOOL = path.join(ROOT, 'scripts', 'build-manifest.mts');

/** Runs the freshness tool on `dir` (`write` or `verify`). */
function manifestTool(command: 'write' | 'verify', dir: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [MANIFEST_TOOL, command, dir], { encoding: 'utf8' });
}

/** A minimal project whose dist/ is a fresh, complete build as recorded by the build. */
function builtProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-manifest-'));
  const files: Readonly<Record<string, string>> = {
    'package.json': '{"name":"probe","version":"1.0.0"}\n',
    'tsconfig.base.json': '{"compilerOptions":{"strict":true}}\n',
    'src/tsconfig.json': '{"extends":"../tsconfig.base.json"}\n',
    'src/index.cts': 'export = { answer: 42 };\n',
    'src/helper.cts': 'export {};\n',
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
    const manifest = expectType(
      readJson(path.join(dir, 'dist', '.build-inputs.json')),
      isShape({ version: isNumber, inputs: isRecordOf(isString), outputs: isRecordOf(isString) }),
      'a build-freshness manifest',
    );
    assert.equal(manifest.version, 1);
    assert.deepEqual(Object.keys(manifest.inputs), [
      'package.json',
      'src/helper.cts',
      'src/index.cts',
      'src/tsconfig.json',
      'tsconfig.base.json',
    ]);
    assert.deepEqual(Object.keys(manifest.outputs), ['dist/helper.cjs', 'dist/index.cjs', 'dist/sarif-to-comment.d.ts']);
    for (const hash of [...Object.values(manifest.inputs), ...Object.values(manifest.outputs)]) assert.match(hash, /^[0-9a-f]{64}$/);
  });

  const stale: Readonly<Record<string, readonly [(dir: string) => void, RegExp]>> = {
    'an edited source': [(dir) => { fs.appendFileSync(path.join(dir, 'src', 'index.cts'), '// edit\n'); }, /input changed since the build: src\/index\.cts/],
    'an added source': [(dir) => { fs.writeFileSync(path.join(dir, 'src', 'extra.cts'), '\n'); }, /input added since the build: src\/extra\.cts/],
    'a removed source': [(dir) => { fs.rmSync(path.join(dir, 'src', 'helper.cts')); }, /input removed since the build: src\/helper\.cts/],
    'a changed compiler configuration': [
      (dir) => { fs.writeFileSync(path.join(dir, 'tsconfig.base.json'), '{}\n'); },
      /input changed since the build: tsconfig\.base\.json/,
    ],
    'an added compiler configuration': [
      (dir) => { fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}\n'); },
      /input added since the build: tsconfig\.json/,
    ],
    'a changed manifest': [
      (dir) => { fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"probe","version":"1.0.1"}\n'); },
      /input changed since the build: package\.json/,
    ],
    'no build at all': [(dir) => { fs.rmSync(path.join(dir, 'dist'), { recursive: true }); }, /missing or unreadable/],
    'an unfinished build (outputs without a manifest)': [
      (dir) => { fs.rmSync(path.join(dir, 'dist', '.build-inputs.json')); },
      /missing or unreadable/,
    ],
    'an unreadable manifest': [(dir) => { fs.writeFileSync(path.join(dir, 'dist', '.build-inputs.json'), '{"version":1,'); }, /missing or unreadable/],
    'a manifest of another format': [
      (dir) => { fs.writeFileSync(path.join(dir, 'dist', '.build-inputs.json'), '{"version":2,"inputs":{},"outputs":{}}'); },
      /missing or unreadable/,
    ],
    'an orphaned output': [(dir) => { fs.writeFileSync(path.join(dir, 'dist', 'removed-module.cjs'), '\n'); }, /output added since the build: dist\/removed-module\.cjs/],
    'a removed output': [(dir) => { fs.rmSync(path.join(dir, 'dist', 'helper.cjs')); }, /output removed since the build: dist\/helper\.cjs/],
    'a tampered output': [(dir) => { fs.appendFileSync(path.join(dir, 'dist', 'index.cjs'), '// patched\n'); }, /output changed since the build: dist\/index\.cjs/],
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
    const file = path.join(dir, 'src', 'index.cts');
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
    for (const entry of ['package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'tsconfig.json', 'api-extractor.json', 'src', 'scripts']) {
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

  test('refuses any JavaScript module in src/, before building anything', { timeout: 60_000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-javascript-'));
    for (const entry of ['package.json', 'tsconfig.base.json', 'src', 'scripts']) {
      fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    // Every runtime module is TypeScript; a JavaScript file in src/ would be
    // neither compiled nor shipped, so it is refused rather than ignored.
    fs.writeFileSync(path.join(dir, 'src', 'stray-probe.cjs'), "'use strict';\n");
    fs.writeFileSync(path.join(dir, 'src', 'presentation', 'nested-probe.cjs'), "'use strict';\n");
    const build = spawnSync(process.execPath, ['scripts/build.mts'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(build.status, 0);
    assert.match(build.stderr, /stray-probe\.cjs/);
    assert.match(build.stderr, /nested-probe\.cjs/, 'a JavaScript file in src/presentation/ is refused too');
    assert.equal(fs.existsSync(path.join(dir, 'dist')), false, 'nothing was built');
  });
});

describe('the built package', () => {
  test('src/ holds no JavaScript and the hand-written declarations are gone', () => {
    assert.deepEqual(fs.readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.cjs') || f.endsWith('.js')), []);
    assert.equal(fs.existsSync(path.join(ROOT, 'types')), false);
  });

  test('the public declaration file is rolled up from the declaration entry and declares public signatures only', () => {
    const rollup = fs.readFileSync(path.join(ROOT, 'dist', 'sarif-to-comment.d.ts'), 'utf8');
    assert.ok(fs.existsSync(path.join(ROOT, 'dist', 'public-api.d.cts')), 'the compiled declaration entry exists');
    // The private test seam (a second argument) is runtime behavior only.
    assert.match(
      rollup,
      /^export declare function publishSarifReview\(input: IPublishSarifReviewInput\): Promise<PublishSarifReviewOutcome>;$/m,
    );
    assert.doesNotMatch(rollup, /Internals|WithUntypedInput|WithInternals/);
    assert.doesNotMatch(rollup, /^import |require\(|reference types/m);
  });

  test('the executable is a runtime module beside the library it runs', () => {
    const text = fs.readFileSync(path.join(ROOT, 'dist', 'sarif-to-comment.cjs'), 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env node\n'));
    assert.match(text, /require\(['"]\.\/cli\.cjs['"]\)/);
  });
});
