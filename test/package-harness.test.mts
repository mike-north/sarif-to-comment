/**
 * Tests for the clean-consumer installation harness
 * (test/fixtures/package/installed-package.mts), which the package, type and
 * documentation tests depend on.
 *
 * The harness must install *this package as a consumer receives it*: the
 * product tarball comes from real `npm pack`, and a clean consumer project gets
 * it through real `npm install`. Third-party runtime dependencies are not
 * under test; they are supplied as npm-format tarballs of exactly the files the
 * lockfile installed, without asking npm to repack them from pnpm's virtual
 * store. That repacking failed on the GitHub-hosted Ubuntu runner (Node
 * 24.21.0, npm 11.19.0) with "npm error Exit handler never called!" for
 * node_modules/.pnpm/ajv@8.20.0/node_modules/ajv, failing every installed-
 * package test (logs/opus/setup-ci-failure-02.txt).
 *
 * Each test runs the harness in a child process whose PATH starts with a
 * generated `npm` shim. The shim records every invocation and can fail chosen
 * commands the way the runner did — including writing an npm debug log — while
 * delegating everything else to the real npm.
 *
 * @see https://docs.npmjs.com/cli/v11/commands/npm-pack
 * @see https://docs.npmjs.com/cli/v11/configuring-npm/package-json#files
 * @see https://docs.npmjs.com/cli/v11/using-npm/logging#logs-dir
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { dependencyTarball, runtimeDependencyDirs } from './fixtures/package/installed-package.mts';
import { expectType, isBoolean, isOptional, isShape, isString, parseJson } from './support/runtime-types.mts';

const ROOT = path.resolve(import.meta.dirname, '..');
const HARNESS = path.join(ROOT, 'test', 'fixtures', 'package', 'installed-package.mts');
const REAL_NPM = spawnSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).stdout.trim();
const RUNNER_ERROR = 'npm error Exit handler never called!';
const DEBUG_SENTINEL = 'verbose stack SENTINEL-root-cause-from-npm-debug-log';

/** A generated `npm` shim and the invocations it recorded. */
interface INpmShim {
  readonly dir: string;
  readonly calls: () => string[];
}

/** One attempt of the harness in the child process. */
interface IAttempt {
  readonly ok: boolean;
  readonly packageDir?: string | undefined;
  readonly installed?: boolean | undefined;
  readonly message?: string | undefined;
}

const isAttempt = isShape({
  ok: isBoolean,
  packageDir: isOptional(isString),
  installed: isOptional(isBoolean),
  message: isOptional(isString),
});

/**
 * A directory containing an `npm` shim. `fail` is 'dependency-pack' (fail
 * `npm pack <dir>` for any directory other than this checkout, as the runner
 * did; the `--pack-destination` value is not a pack target) or 'product-pack' (fail `npm pack` of this checkout). Failures write an
 * npm debug log to $npm_config_logs_dir containing DEBUG_SENTINEL and name it
 * on stderr, as npm does. Every invocation is appended to `calls.log`.
 */
function npmShim(fail: 'dependency-pack' | 'product-pack'): INpmShim {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-harness-shim-'));
  const log = path.join(dir, 'calls.log');
  const sh = String.raw;
  const script = sh`#!/bin/sh
printf '%s\n' "$*" >> '${log}'
target=""
if [ "$1" = "pack" ]; then
  skip=no
  for arg in "$@"; do
    if [ "$skip" = yes ]; then skip=no; continue; fi
    if [ "$arg" = "--pack-destination" ]; then skip=yes; continue; fi
    if [ -d "$arg" ] && [ "$(cd "$arg" && pwd -P)" != "$(cd '${ROOT}' && pwd -P)" ]; then target="$arg"; fi
  done
fi
shouldFail=no
if [ '${fail}' = 'dependency-pack' ] && [ -n "$target" ]; then shouldFail=yes; fi
if [ '${fail}' = 'product-pack' ] && [ "$1" = "pack" ] && [ -z "$target" ] && [ "$(pwd -P)" = "$(cd '${ROOT}' && pwd -P)" ]; then shouldFail=yes; fi
if [ "$shouldFail" = yes ]; then
  mkdir -p "$npm_config_logs_dir"
  debug="$npm_config_logs_dir/2026-09-28T05_55_10_886Z-debug-0.log"
  printf '0 verbose cli node npm\n1 ${DEBUG_SENTINEL}\n' > "$debug"
  echo "${RUNNER_ERROR}" >&2
  echo "npm error A complete log of this run can be found in: $debug" >&2
  exit 1
fi
exec '${REAL_NPM}' "$@"
`;
  fs.writeFileSync(path.join(dir, 'npm'), script, { mode: 0o755 });
  return { dir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

/** Runs the harness in a fresh child process with `shim` first on PATH. */
function runHarness(shim: INpmShim, { twice = false } = {}): { first: IAttempt; second?: IAttempt | undefined } {
  const js = String.raw;
  const script = js`
    const fs = require('node:fs');
    const path = require('node:path');
    const harness = require(${JSON.stringify(HARNESS)});
    const attempt = () => {
      try {
        const r = harness.installIntoConsumer();
        return { ok: true, packageDir: r.packageDir, installed: fs.existsSync(path.join(r.packageDir, 'package.json')) };
      } catch (err) {
        return { ok: false, message: String(err && err.message) };
      }
    };
    const first = attempt();
    const second = ${String(twice)} ? attempt() : undefined;
    process.stdout.write(JSON.stringify({ first, second }));
  `;
  const run = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, PATH: `${shim.dir}${path.delimiter}${process.env['PATH'] ?? ''}` },
  });
  assert.equal(run.status, 0, run.stderr);
  return expectType(parseJson(run.stdout), isShape({ first: isAttempt, second: isOptional(isAttempt) }), 'the harness attempts');
}

describe('clean-consumer installation harness', () => {
  test('control: the shim reproduces the runner failure for `npm pack` of an installed dependency', () => {
    const shim = npmShim('dependency-pack');
    // Resolved from this file, inside ROOT, as `require.resolve(…, { paths: [ROOT] })` would.
    const ajv = fs.realpathSync(path.dirname(fileURLToPath(import.meta.resolve('ajv/package.json'))));
    const run = spawnSync('npm', ['pack', '--json', ajv], {
      encoding: 'utf8',
      env: { PATH: `${shim.dir}${path.delimiter}${process.env['PATH'] ?? ''}`, npm_config_logs_dir: path.join(shim.dir, 'logs') },
    });
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes(RUNNER_ERROR));
  });

  test('installs a clean consumer even when npm cannot pack installed third-party dependencies', { timeout: 300_000 }, () => {
    const shim = npmShim('dependency-pack');
    const { first } = runHarness(shim);
    assert.equal(first.ok, true, first.message);
    assert.equal(first.installed, true);
    const calls = shim.calls();
    assert.equal(calls.filter((c) => /^pack /.test(c)).length, 1, `only the product is packed by npm: ${calls.join(' | ')}`);
    assert.equal(calls.filter((c) => /^install /.test(c)).length, 1, 'the consumer is installed by real npm install');
  });

  test('dependency tarballs contain exactly the installed files of each runtime dependency', { timeout: 300_000 }, () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-tarball-'));
    for (const dir of runtimeDependencyDirs()) {
      const tarball = dependencyTarball(dir, out);
      const listed = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
        .stdout.split('\n')
        .filter((entry) => entry && !entry.endsWith('/'))
        .map((entry) => entry.replace(/^package\//, ''))
        .sort();
      const expected: string[] = [];
      const walk = (rel: string): void => {
        for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
          const relPath = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (!(rel === '' && entry.name === 'node_modules')) walk(relPath);
          } else {
            expected.push(relPath);
          }
        }
      };
      walk('');
      assert.deepEqual(listed, expected.sort(), `${dir}: tarball lists exactly the installed files`);
      const packed = spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }).stdout;
      assert.equal(packed, fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), `${dir}: package.json is byte-identical`);
    }
  });

  test('an npm failure reports npm’s own debug log, so a runner failure names its cause', { timeout: 300_000 }, () => {
    const shim = npmShim('product-pack');
    const { first } = runHarness(shim);
    assert.equal(first.ok, false);
    const message = first.message ?? '';
    assert.ok(message.includes(RUNNER_ERROR), message);
    assert.ok(message.includes(DEBUG_SENTINEL), `the debug log is included: ${message}`);
  });

  test('a failed installation is reported to every caller without repeating the npm work', { timeout: 300_000 }, () => {
    const shim = npmShim('product-pack');
    const { first, second } = runHarness(shim, { twice: true });
    assert.equal(first.ok, false);
    assert.equal(second?.ok, false);
    assert.equal(second.message, first.message);
    assert.equal(shim.calls().filter((c) => /^pack /.test(c)).length, 1, 'npm pack ran once');
  });
});
