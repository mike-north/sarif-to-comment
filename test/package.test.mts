/**
 * Package acceptance tests: the package a consumer installs is the product.
 *
 * - The manifest names the real entry points (library main/exports with its
 *   type declarations, and the CLI bin), is publishable with repository
 *   metadata that exactly names the trusted-publishing repository, keeps the
 *   version below 1.0.0, pins the supported Node range and lists every runtime
 *   dependency the shipped sources require. (Changesets, the release guard
 *   and the workflows are covered by test/release.test.mts; documentation by
 *   test/docs.test.mts.)
 * - `npm pack` produces exactly the intended distribution: runtime sources,
 *   CLI, type declarations, vendored schema, README, CHANGELOG, the
 *   getting-started guide and the generated API reference — never tests,
 *   logs, internal design docs, release tooling, pending changesets, private
 *   evidence or agent configuration.
 * - The tarball is really installed with `npm install` into a clean consumer
 *   (test/fixtures/package/installed-package.mts). The installed library is
 *   used in memory, the installed executable is run, and the installed type
 *   declarations are compiled against CommonJS and ES module consumers,
 *   including calls the types must reject.
 *
 * Nothing here publishes anything.
 *
 * @see https://docs.npmjs.com/cli/v11/configuring-npm/package-json
 * @see https://docs.npmjs.com/cli/v11/commands/npm-pack
 * @see https://nodejs.org/api/packages.html#package-entry-points
 * @see https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-exports
 */

import { AssertionError } from 'node:assert';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { UPSTREAM_SARIF_PATH, createGitWorld } from './fixtures/authoring-workflow/git-world.mts';
import { PKG, ROOT, installIntoConsumer, installedManifestPath, npm, packProject, requirePackedProject } from './fixtures/package/installed-package.mts';
import {
  asRecord,
  asString,
  expectType,
  isArrayOf,
  isOptional,
  isRecordOf,
  isShape,
  isString,
  isUnknown,
  parseJson,
  readJson,
} from './support/runtime-types.mts';

/**
 * CommonJS `require` from this checkout: the built package is CommonJS, and
 * the entry-point test loads it exactly as a CommonJS consumer does.
 * require.resolve's `paths` option also resolves the runtime dependencies
 * from the project root.
 */
const require = createRequire(import.meta.url);

/** package.json `scripts`. */
const SCRIPTS = expectType(PKG['scripts'] ?? {}, isRecordOf(isString), 'package.json scripts');

/** `value`, which the assertions before it establish is present; fails naming `what` otherwise. */
function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new AssertionError({ message: `expected ${what}`, actual: value, operator: 'present' });
  return value;
}

/**
 * The package.json `files` whitelist: the intended distribution boundary.
 * dist/ is build output; the negations keep build by-products out of the
 * package: per-module declarations (only the rolled-up public declaration
 * ships), TypeScript build info, the build-freshness manifest, and the runtime
 * output of the declaration-only entry and of the type-only public types
 * module (neither has runtime content).
 */
const EXPECTED_FILES_FIELD = [
  'dist/',
  '!dist/*.d.cts',
  '!dist/*.tsbuildinfo',
  '!dist/.build-inputs.json',
  '!dist/public-api.cjs',
  '!dist/public-types.cjs',
  'vendor/',
  'docs/getting-started.md',
  'docs/diagnostics.md',
  'docs/diagnostic.v1.schema.json',
  'docs/api/',
  'CHANGELOG.md',
  'README.md',
];

/** Compiled outputs that exist in dist/ but carry no runtime content, so never ship. */
const NON_RUNTIME_OUTPUTS: readonly string[] = ['dist/public-api.cjs', 'dist/public-types.cjs'];

/** Whether a packed path is inside the intended distribution boundary. */
function distributable(file: string): boolean {
  return (
    file === 'package.json' ||
    file === 'README.md' ||
    file === 'CHANGELOG.md' ||
    /^LICENSE(\.md|\.txt)?$/.test(file) ||
    (/^dist\/[^/]+\.cjs$/.test(file) && !NON_RUNTIME_OUTPUTS.includes(file)) ||
    file === 'dist/sarif-to-comment.d.ts' ||
    /^vendor\/[^/]+$/.test(file) ||
    file === 'docs/getting-started.md' ||
    file === 'docs/diagnostics.md' ||
    file === 'docs/diagnostic.v1.schema.json' ||
    /^docs\/api\/[^/]+\.md$/.test(file)
  );
}

/** The shipped runtime files: every dist/*.cjs the package includes. */
function shippedRuntimeFiles(): string[] {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) return [];
  return fs
    .readdirSync(dist)
    .filter((f) => f.endsWith('.cjs'))
    .map((f) => `dist/${f}`)
    .filter((f) => !NON_RUNTIME_OUTPUTS.includes(f))
    .sort();
}

/**
 * Every non-builtin package the shipped runtime loads, by package name:
 * each `require()` and each dynamic `import()` (ES-module-only dependencies
 * are loaded with `import()`). Quote-agnostic, because compiled output uses
 * double quotes where the hand-written sources used single quotes; a scan
 * matching one style only would silently come back empty.
 */
function requiredPackages(): Set<string> {
  const names = new Set<string>();
  for (const file of shippedRuntimeFiles()) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const [, , spec = ''] of text.matchAll(/\b(?:require|import)\(\s*(['"`])([^'"`]+)\1\s*\)/g)) {
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      names.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec));
    }
  }
  return names;
}

/**
 * The packages a consumer must receive for `required` to load: each required
 * package plus the peer dependencies it declares (ajv-draft-04 builds on a
 * consumer-supplied `ajv`), read from the installed manifests.
 */
function runtimeDependencyClosure(required: ReadonlySet<string>): string[] {
  const names = new Set(required);
  for (const name of required) {
    const manifest = expectType(
      readJson(installedManifestPath(name, ROOT)),
      isShape({ peerDependencies: isOptional(isRecordOf(isString)) }),
      `${name}/package.json`,
    );
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) names.add(peer);
  }
  return [...names].sort();
}

describe('manifest', () => {
  test('identity, publishability and module type', () => {
    assert.equal(PKG.name, 'sarif-to-comment');
    assert.match(PKG.version, /^0\.\d+\.\d+$/, 'a stable 0.x version (the release guard enforces the ceiling)');
    assert.equal(Object.hasOwn(PKG, 'private'), false, 'the package is released to npm through trusted publishing');
    assert.deepEqual(PKG['publishConfig'], { access: 'public', registry: 'https://registry.npmjs.org/' });
    assert.equal(PKG['type'], 'commonjs');
  });

  test('the npm description names the optional authoring and inspection as well as publication', () => {
    // The registry listing is how users discover the package; it must not describe only publication.
    const description = asString(PKG['description'], 'the package description');
    assert.match(description, /\bwrite\b/i, 'optional authoring');
    assert.match(description, /\binspect\b/i, 'inspection');
    assert.match(description, /draft pull request review/, 'publication as one draft review');
    assert.match(description, /never-duplicating/, 'durable delivery');
  });

  test('repository metadata names exactly the trusted-publishing repository', () => {
    // npm trusted publishing requires repository.url to match the GitHub
    // repository the OIDC token names (https://docs.npmjs.com/trusted-publishers/).
    assert.deepEqual(PKG['repository'], { type: 'git', url: 'git+https://github.com/mike-north/sarif-to-comment.git' });
    assert.equal(PKG['homepage'], 'https://github.com/mike-north/sarif-to-comment#readme');
    assert.deepEqual(PKG['bugs'], { url: 'https://github.com/mike-north/sarif-to-comment/issues' });
  });

  test('library entry points resolve to the built public module and its rolled-up declarations', () => {
    assert.equal(PKG['main'], './dist/index.cjs');
    assert.equal(PKG['types'], './dist/sarif-to-comment.d.ts');
    assert.deepEqual(PKG['exports'], {
      '.': { types: './dist/sarif-to-comment.d.ts', default: './dist/index.cjs' },
      './package.json': './package.json',
    });
    const exportsField = expectType(PKG['exports'], isShape({ '.': isShape({ default: isString }) }), 'package.json exports');
    const resolved = require.resolve(path.join(ROOT, exportsField['.'].default));
    assert.equal(resolved, path.join(ROOT, 'dist', 'index.cjs'));
    const declarations = fs.readFileSync(path.join(ROOT, asString(PKG['types'], 'package.json types')), 'utf8');
    const declared = [...declarations.matchAll(/^export declare function (\w+)\(/gm)].map((m) => m[1] ?? '');
    assert.deepEqual(declared.sort(), [
      'addSarifComment',
      'addStagedChangesToSarif',
      'closeSuggestionPullRequests',
      'createSarifDocument',
      'groupSarifFixes',
      'inspectSarif',
      'publishSarifReview',
      'removeSarifComment',
      'ungroupSarifFixes',
      'validateSarifReview',
    ]);
    const loaded: unknown = require(resolved);
    assert.deepEqual(Object.keys(asRecord(loaded, 'the module.exports object')).sort(), declared, 'the runtime exports exactly the declared API');
  });

  test('the CLI bin points at an executable Node script', () => {
    // Written in npm's normalized form (no leading "./"), so publishing does not
    // rewrite the manifest or warn that the entry was "invalid and removed".
    assert.deepEqual(PKG['bin'], { 'sarif-to-comment': 'dist/sarif-to-comment.cjs' });
    const bin = expectType(PKG['bin'], isShape({ 'sarif-to-comment': isString }), 'package.json bin');
    const text = fs.readFileSync(path.join(ROOT, bin['sarif-to-comment']), 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env node\n'), 'bin must start with a node shebang');
  });

  test('the supported Node range is declared and satisfied by this runtime', () => {
    assert.deepEqual(PKG['engines'], { node: '>=22' });
    assert.ok(Number(process.versions.node.split('.')[0]) >= 22, `running Node ${process.versions.node}`);
  });

  test('development requires Node 22.18.0 or later without narrowing what consumers may run', () => {
    // The build and test tooling runs TypeScript through Node's native type
    // stripping, which first works without flags or warnings in 22.18.0 (22.17
    // cannot load it at all). devEngines applies only to commands run in this
    // checkout, where npm and pnpm refuse an older Node; the installed package
    // keeps `engines: >=22` because its compiled JavaScript needs no stripping.
    assert.deepEqual(PKG['devEngines'], { runtime: { name: 'node', version: '>=22.18.0', onFail: 'error' } });
    assert.deepEqual(PKG['engines'], { node: '>=22' }, 'the consumer range is unchanged');
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    assert.ok(major > 22 || (major === 22 && minor >= 18), `developing on Node ${process.versions.node}`);
  });

  test('the files whitelist is exactly the intended boundary', () => {
    const expected = [...EXPECTED_FILES_FIELD];
    for (const license of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      if (fs.existsSync(path.join(ROOT, license))) expected.push(license);
    }
    assert.deepEqual(PKG['files'], expected);
  });

  test('the declared dependencies are exactly what the shipped runtime requires; tooling stays a dev dependency', () => {
    const declared = Object.keys(PKG.dependencies ?? {}).sort();
    const required = requiredPackages();
    assert.ok(shippedRuntimeFiles().length > 0, 'the scan covers the built runtime (run `pnpm run build`)');
    assert.ok(required.size > 0, 'the scan finds runtime requires; an empty scan would prove nothing');
    // Both directions: an undeclared require breaks consumers, and a declared
    // dependency nothing needs is installed by every consumer for no reason.
    assert.deepEqual(runtimeDependencyClosure(required), declared);
    assert.deepEqual(declared, ['@toon-format/toon', 'ajv', 'ajv-draft-04', 'ajv-formats', 'chalk']);
    for (const tool of ['@changesets/cli', '@microsoft/api-extractor', '@microsoft/api-documenter', 'typescript']) {
      assert.ok(Object.hasOwn(asRecord(PKG['devDependencies'], 'package.json devDependencies'), tool), `${tool} is a dev dependency`);
    }
  });

  test('scripts are purpose-named and checks are read-only', () => {
    const scripts = SCRIPTS;
    // The suite exercises the built dist/, so it first refuses a missing or stale build.
    assert.equal(scripts['test'], 'npm run check:build && node --test "test/**/*.test.mts"');
    assert.equal(scripts['check:build'], 'node scripts/build-manifest.mts verify');
    assert.match(scripts['check:lint'] || '', /^eslint\b/);
    assert.ok(scripts['check'], 'an aggregate read-only check script exists');
    assert.equal(scripts['build'], 'node scripts/build.mts', 'build compiles dist/ and regenerates the API report and reference documentation');
    for (const [name, command] of Object.entries(scripts)) {
      if (name === 'check' || name.startsWith('check:')) {
        assert.doesNotMatch(command, /--fix\b|--write\b|--local\b/, `${name} must not modify files`);
      }
      assert.doesNotMatch(command, /\bnpm publish\b|\bpnpm publish\b/, `${name} must not publish`);
    }
  });
});

describe('packed distributable', () => {
  const packed = packProject();
  const skip = packed.error || false;

  test('contains exactly the intended distribution', { skip }, () => {
    const files = requirePackedProject().result.files.map((f) => f.path).sort();
    assert.deepEqual(files.filter((f) => !distributable(f)), [], 'unexpected files in the package');
    const apiPages = fs.readdirSync(path.join(ROOT, 'docs', 'api')).map((f) => `docs/api/${f}`);
    // Every runtime module in src/ ships as dist/<name>.cjs. The module list
    // comes from the sources (transitional .cjs and TypeScript .cts alike), so
    // a build that silently drops a module fails here.
    const runtimeModules = fs
      .readdirSync(path.join(ROOT, 'src'))
      .filter((f) => /\.c[jt]s$/.test(f) && !f.endsWith('.d.cts'))
      .map((f) => `dist/${f.replace(/\.c[jt]s$/, '.cjs')}`)
      .filter((f) => !NON_RUNTIME_OUTPUTS.includes(f))
      .sort();
    assert.ok(runtimeModules.length >= 14, `every runtime module is found (${String(runtimeModules.length)})`);
    for (const required of [
      'package.json',
      'README.md',
      'CHANGELOG.md',
      'dist/sarif-to-comment.cjs',
      'dist/index.cjs',
      'dist/sarif-to-comment.d.ts',
      'vendor/sarif-schema-2.1.0.json',
      'vendor/README.md',
      'docs/getting-started.md',
      'docs/diagnostics.md',
      'docs/diagnostic.v1.schema.json',
      ...apiPages,
      ...runtimeModules,
    ]) {
      assert.ok(files.includes(required), `${required} is missing from the package`);
    }
    assert.deepEqual(
      files.filter((f) => f.startsWith('dist/') && f.endsWith('.cjs')),
      runtimeModules,
      'every shipped runtime file comes from a runtime source module',
    );
    assert.ok(apiPages.length >= 3, 'the generated API reference has pages');
  });

  test('the release guard accepts a real pack of this checkout, as the publish workflow verifies it', { skip }, () => {
    // publish.yml refuses to publish unless `release-guard.mts verify-pack`
    // accepts npm's own pack listing. Synthetic pack results cannot notice a
    // `files` entry the guard's boundary was never taught, so the real
    // listing goes through the real command line here.
    const { work, env } = requirePackedProject();
    const pack = npm(['pack', '--dry-run', '--json'], { cwd: ROOT, env });
    assert.equal(pack.status, 0, pack.stderr);
    const packJson = path.join(fs.mkdtempSync(path.join(work, 'verify-pack-')), 'pack.json');
    fs.writeFileSync(packJson, pack.stdout);
    const verify = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release-guard.mts'), 'verify-pack', packJson], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(verify.status, 0, `verify-pack refused the real tarball:\n${verify.stderr}${verify.stdout}`);
    assert.match(verify.stdout, new RegExp(`^Verified sarif-to-comment-${PKG.version.replaceAll('.', '\\.')}\\.tgz: \\d+ files`));
  });

  test('the files negations keep build by-products out of a packed dist/', { skip }, () => {
    // The checkout's dist/ need not hold every by-product at any given time,
    // so the boundary is proven on a scratch package that holds all of them.
    const { work, env } = requirePackedProject();
    const dir = fs.mkdtempSync(path.join(work, 'negations-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'negations', version: '1.0.0', files: PKG['files'] }));
    fs.mkdirSync(path.join(dir, 'dist'));
    for (const file of [
      'index.cjs',
      'index.d.cts',
      'public-api.cjs',
      'public-api.d.cts',
      'public-types.cjs',
      'public-types.d.cts',
      'sarif-to-comment.d.ts',
      'tsconfig.tsbuildinfo',
      '.build-inputs.json',
    ]) {
      fs.writeFileSync(path.join(dir, 'dist', file), '\n');
    }
    const run = npm(['pack', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(run.status, 0, run.stderr);
    const [pack] = expectType(
      parseJson(run.stdout),
      isArrayOf(isShape({ files: isArrayOf(isShape({ path: isString })) })),
      'npm pack --json output',
    );
    const files = present(pack, 'the packed tarball').files.map((f) => f.path).filter((f) => f.startsWith('dist/')).sort();
    assert.deepEqual(files, ['dist/index.cjs', 'dist/sarif-to-comment.d.ts']);
  });

  // npm normalizes manifests when publishing a directory and warns about every
  // rewrite (for example a "./"-prefixed bin path is reported as "invalid and
  // removed"). The release publishes the verified tarball, but the manifest
  // must also be clean for a directory publish so no form of publishing
  // rewrites what consumers receive.
  for (const [form, args, cwd] of [
    ['the verified tarball', () => ['publish', '--dry-run', requirePackedProject().tarball], () => requirePackedProject().work],
    ['the package directory', () => ['publish', '--dry-run'], () => ROOT],
  ] as const) {
    test(`npm publish --dry-run of ${form} needs no manifest auto-correction`, { skip }, () => {
      const dryRun = npm(args(), { cwd: cwd(), env: requirePackedProject().env });
      assert.equal(dryRun.status, 0, dryRun.stderr);
      const output = dryRun.stdout + dryRun.stderr;
      assert.doesNotMatch(output, /auto-corrected|errors corrected|was invalid/, 'npm would rewrite the published manifest');
      assert.ok(output.includes(`sarif-to-comment@${PKG.version}`), output);
    });
  }
});

describe('installed package', () => {
  const skip = packProject().error || false;

  test('in-memory library use and the installed executable', { skip, timeout: 300_000 }, () => {
    const { consumer, packageDir, bin } = installIntoConsumer();
    const manifest = asRecord(readJson(path.join(packageDir, 'package.json')), 'the installed package.json');
    assert.equal(manifest['version'], PKG.version);
    assert.equal(fs.existsSync(path.join(packageDir, 'test')), false, 'tests must not be installed');

    const js = String.raw;
    const script = js`
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const { publishSarifReview } = require('sarif-to-comment');
      const resolved = fs.realpathSync(require.resolve('sarif-to-comment'));
      assert.ok(resolved.startsWith(fs.realpathSync(${JSON.stringify(packageDir)})), 'resolved outside the install: ' + resolved);
      assert.equal(require('sarif-to-comment/package.json').name, 'sarif-to-comment');
      const { FakeGitHubRemote } = require(${JSON.stringify(path.join(ROOT, 'test/fixtures/publication/fake-github.mts'))});
      const { createFakeClientFactory, REPOSITORY } = require(${JSON.stringify(path.join(ROOT, 'test/fixtures/public-api/fake-adapter.mts'))});
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

    assert.ok(fs.existsSync(bin), 'npm must link the installed executable');
    const cleanEnv = { PATH: process.env['PATH'] };
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
  });

  /**
   * Type-checks consumer sources against the installed package with the
   * project's TypeScript. `expectErrors` lines must each fail to compile (they
   * carry `@ts-expect-error`, which itself errors if the line compiles).
   */
  function typecheck(
    consumer: string,
    files: Readonly<Record<string, string>>,
    compilerOptions: Readonly<Record<string, unknown>>,
  ): SpawnSyncReturns<string> {
    const dir = fs.mkdtempSync(path.join(consumer, 'types-'));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, exactOptionalPropertyTypes: true, types: [], ...compilerOptions },
        files: Object.keys(files),
      }),
    );
    return spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', dir], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120_000,
    });
  }

  /** Identity tag for embedded TypeScript (escapes such as \n are interpreted). */
  const ts = (strings: TemplateStringsArray, ...values: readonly string[]): string =>
    strings.reduce((out, part, i) => out + part + (i < values.length ? (values[i] ?? '') : ''), '');
  const usage = ts`
    const outcome = await publishSarifReview({
      sarif: { version: '2.1.0', runs: [] },
      destination: { owner: 'acme', repo: 'widgets', pullNumber: 42 },
      reviewedCommit: 'c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de',
      statePath: '/tmp/state.json',
      token: 'token',
      sourceRootUri: 'file:///work/widgets/',
      options: { ignoreApprovalHold: true },
    });
    const text: string = outcome.markdown;
    switch (outcome.status) {
      case 'published': { const url: string = outcome.review.url; const id: number = outcome.review.id; const p: string = outcome.statePath; void url; void id; void p; break; }
      case 'uncertain': case 'rejected': { const p: string = outcome.statePath; void p; break; }
      case 'blocked': { break; }
      default: { const never: never = outcome; void never; }
    }
    // @ts-expect-error destination.pullNumber must be a number
    void publishSarifReview({ sarif: {}, destination: { owner: 'a', repo: 'b', pullNumber: '1' }, reviewedCommit: 'x', statePath: '/s', token: 't' });
    // @ts-expect-error token is required
    void publishSarifReview({ sarif: {}, destination: { owner: 'a', repo: 'b', pullNumber: 1 }, reviewedCommit: 'x', statePath: '/s' });
    // @ts-expect-error unknown options are rejected
    void publishSarifReview({ sarif: {}, destination: { owner: 'a', repo: 'b', pullNumber: 1 }, reviewedCommit: 'x', statePath: '/s', token: 't', options: { force: true } });
    // @ts-expect-error a blocked outcome has no review
    if (outcome.status === 'blocked') void outcome.review;
    void text;
  `;

  test('the installed declarations type a CommonJS consumer (and reject misuse)', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const run = typecheck(
      consumer,
      {
        'consumer.cts': ts`import sarifToComment = require('sarif-to-comment');
          const { publishSarifReview } = sarifToComment;
          import type { IPublishSarifReviewInput, PublishSarifReviewOutcome } from 'sarif-to-comment';
          export async function main(): Promise<void> { ${usage} }
          const input: IPublishSarifReviewInput | undefined = undefined; void input;
          const o: PublishSarifReviewOutcome | undefined = undefined; void o;`,
      },
      { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022' },
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });

  test('the installed declarations type an ES module consumer', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const run = typecheck(
      consumer,
      { 'consumer.mts': ts`import { publishSarifReview } from 'sarif-to-comment';\n${usage}\nexport {};` },
      { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022' },
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });

  /** Typed use of the authoring, inspection and staged-change operations, with misuse that must not compile. */
  const workflow = ts`
    let sarif: ISarifLog = createSarifDocument({ tool: { name: 'Review agent', version: '1.0.0' }, source: { owner: 'acme', repo: 'widgets', commit: 'c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de' } });
    const added: AddSarifCommentOutcome = addSarifComment(sarif, { file: 'src/a.js', line: 2, endLine: 3, message: 'm', messageFormat: 'markdown', level: 'note', run: { toolName: 'Reviewer' } });
    if (added.status === 'added') { sarif = added.sarif; const ref: string = added.finding.ref; void ref; }
    else { const problems: readonly IProblem[] = added.problems; void problems; }
    const inspected = inspectSarif(sarif, { previewLines: null, previewChars: 100 });
    if (inspected.status === 'inspected') {
      const view: ISarifInspection = inspected.view;
      for (const finding of view.findings) {
        const text: string | undefined = finding.message.text;
        const where: string | null | undefined = finding.locations[0]?.path;
        const preview: 'complete' | 'truncated' | 'unavailable' | undefined = finding.fixes[0]?.changes[0]?.replacements[0]?.inserted.state;
        void text; void where; void preview;
      }
    }
    const staged: AddStagedChangesOutcome = await addStagedChangesToSarif({ sarif, worktree: '/work/widgets', reviewedCommit: 'c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de', repository: { owner: 'acme', repo: 'widgets' } });
    switch (staged.status) {
      case 'added': { const changes: readonly IStagedChangeReceipt[] = staged.receipt.changes; const run: number | null = staged.receipt.addedRun; void changes; void run; break; }
      case 'invalid': case 'failed': { const m: string = staged.markdown; void m; break; }
      default: { const never: never = staged; void never; }
    }
    // @ts-expect-error line must be a number
    void addSarifComment(sarif, { file: 'a', line: '2', message: 'm' });
    // @ts-expect-error the message is required
    void addSarifComment(sarif, { file: 'a', line: 2 });
    // @ts-expect-error levels are SARIF levels
    void addSarifComment(sarif, { file: 'a', line: 2, message: 'm', level: 'fatal' });
    // @ts-expect-error the repository is required
    void addStagedChangesToSarif({ sarif, worktree: '/w', reviewedCommit: 'c' });
    // @ts-expect-error a failed extraction has no SARIF
    if (staged.status === 'failed') void staged.sarif;
  `;

  test('the installed declarations type the authoring, inspection and staged-change operations', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const imports = ts`import { createSarifDocument, addSarifComment, inspectSarif, addStagedChangesToSarif } from 'sarif-to-comment';
      import type { ISarifLog, AddSarifCommentOutcome, IProblem, ISarifInspection, AddStagedChangesOutcome, IStagedChangeReceipt } from 'sarif-to-comment';`;
    const esm = typecheck(
      consumer,
      { 'workflow.mts': `${imports}
export async function main(): Promise<void> { ${workflow} }` },
      { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022' },
    );
    assert.equal(esm.status, 0, esm.stdout + esm.stderr);
    const cjs = typecheck(
      consumer,
      {
        'workflow.cts': ts`import sarifToComment = require('sarif-to-comment');
          const { createSarifDocument, addSarifComment, inspectSarif, addStagedChangesToSarif } = sarifToComment;
          import type { ISarifLog, AddSarifCommentOutcome, IProblem, ISarifInspection, AddStagedChangesOutcome, IStagedChangeReceipt } from 'sarif-to-comment';
          export async function main(): Promise<void> { ${workflow} }`,
      },
      { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022' },
    );
    assert.equal(cjs.status, 0, cjs.stdout + cjs.stderr);
  });

  test('the declarations describe every field the installed runtime actually returns', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    // Real outcomes from the installed library: rich upstream inspection, authoring, and staged
    // extraction in real Git repositories (added, failed and invalid).
    const added = createGitWorld('types-drift-added');
    const moded = createGitWorld('types-drift-mode');
    // A pure insertion before a reviewed line and an end-of-file append: their receipts mark `insertion`.
    const inserted = createGitWorld('types-drift-insertion', {
      path: 'src/list.txt',
      base: 'zero\n',
      reviewed: 'one\ntwo\nthree\n',
      staged: 'one\ntwo\ninserted\nthree\nfour\n',
      workingTree: 'one\ntwo\ninserted\nthree\nfour\n',
    });
    fs.chmodSync(moded.file, 0o755);
    assert.equal(spawnSync('git', ['add', '--', '.'], { cwd: moded.dir, env: moded.env }).status, 0);
    const js = String.raw;
    const script = js`
      const fs = require('node:fs');
      const lib = require('sarif-to-comment');
      const rich = JSON.parse(fs.readFileSync(process.env.RICH, 'utf8'));
      const logEvidence = JSON.parse(fs.readFileSync(process.env.LOG_EVIDENCE, 'utf8'));
      const upstream = JSON.parse(fs.readFileSync(process.env.UPSTREAM, 'utf8'));
      const notSarif = { version: '2.1.0', runs: [{}] };
      const repository = { owner: 'octo', repo: 'review-fixture' };
      (async () => {
        const doc = lib.createSarifDocument({ tool: { name: 'Review agent' } });
        const out = {
          log: doc,
          commentAdded: lib.addSarifComment(doc, { file: 'a.txt', line: 1, endLine: 2, message: 'm', messageFormat: 'markdown', level: 'note', ruleId: 'R' }),
          commentInvalid: lib.addSarifComment(notSarif, { file: 'a.txt', line: 1, message: 'm' }),
          commentRemoved: (() => {
            const upstreamView = lib.inspectSarif(rich).view;
            return lib.removeSarifComment(rich, upstreamView.findings[4].selector);
          })(),
          commentStale: lib.removeSarifComment(doc, '/runs/0/results/0@0123456789abcdef'),
          commentRemoveInvalid: lib.removeSarifComment(notSarif, '/runs/0/results/0@0123456789abcdef'),
          inspected: lib.inspectSarif(rich, { previewLines: 1 }),
          inspectedUpstream: lib.inspectSarif(upstream),
          inspectInvalid: lib.inspectSarif(notSarif),
          inspectedLogEvidence: lib.inspectSarif(logEvidence, { previewLines: 1 }),
          stagedAdded: await lib.addStagedChangesToSarif({ sarif: upstream, worktree: process.env.ADDED, reviewedCommit: process.env.ADDED_HEAD, repository }),
          stagedFailed: await lib.addStagedChangesToSarif({ sarif: upstream, worktree: process.env.MODED, reviewedCommit: process.env.MODED_HEAD, repository }),
          stagedInvalid: await lib.addStagedChangesToSarif({ sarif: notSarif, worktree: process.env.ADDED, reviewedCommit: process.env.ADDED_HEAD, repository }),
          stagedInsertion: await lib.addStagedChangesToSarif({ sarif: lib.createSarifDocument(), worktree: process.env.INSERTED, reviewedCommit: process.env.INSERTED_HEAD, repository }),
        };
        process.stdout.write(JSON.stringify(out));
      })().catch((err) => { console.error(err); process.exit(1); });
    `;
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: consumer,
      encoding: 'utf8',
      env: {
        ...added.env,
        RICH: path.join(ROOT, 'test', 'fixtures', 'sarif-inspection', 'upstream.sarif.json'),
        LOG_EVIDENCE: path.join(ROOT, 'test', 'fixtures', 'sarif-inspection', 'log-evidence.sarif.json'),
        INSERTED: inserted.dir,
        INSERTED_HEAD: inserted.head,
        UPSTREAM: UPSTREAM_SARIF_PATH,
        ADDED: added.dir,
        ADDED_HEAD: added.head,
        MODED: moded.dir,
        MODED_HEAD: moded.head,
      },
      timeout: 120_000,
    });
    assert.equal(run.status, 0, run.stderr);
    const outcomes = asRecord(parseJson(run.stdout), 'the installed outcomes');
    const status = (key: string): unknown => expectType(outcomes[key], isShape({ status: isUnknown }), `the ${key} outcome`).status;
    assert.deepEqual(
      [status('commentAdded'), status('commentInvalid'), status('commentRemoved'), status('commentStale'), status('commentRemoveInvalid'),
        status('inspected'), status('inspectInvalid'), status('stagedAdded'), status('stagedFailed'), status('stagedInvalid')],
      ['added', 'invalid', 'removed', 'stale', 'invalid', 'inspected', 'invalid', 'added', 'failed', 'invalid'],
      'each declared outcome variant is exercised',
    );
    // The evidence-bearing optional fields really occur, so the literal checks below cover them.
    const logView = expectType(
      outcomes['inspectedLogEvidence'],
      isShape({ view: isShape({ log: isUnknown, externalProperties: isUnknown, summary: isShape({ externalFindings: isUnknown }) }) }),
      'the log-evidence inspection',
    ).view;
    assert.ok(logView.log && logView.externalProperties && logView.summary.externalFindings !== undefined, 'log and external evidence present');
    assert.ok(JSON.stringify(logView).includes('"otherContent":{"properties":{"rationale"'), 'a preview carries otherContent');
    const insertion = expectType(outcomes['stagedInsertion'], isShape({ status: isUnknown, markdown: isOptional(isString) }), 'the insertion outcome');
    assert.equal(insertion.status, 'added', insertion.markdown);
    const { receipt } = expectType(
      insertion,
      isShape({ receipt: isShape({ changes: isArrayOf(isShape({ replacements: isArrayOf(isShape({ insertion: isUnknown })) })) }) }),
      'an insertion receipt',
    );
    assert.ok(present(receipt.changes[0], 'a receipt change').replacements.every((r) => r.insertion === true), 'insertion receipts');
    const typed: Readonly<Record<string, string>> = {
      log: 'ISarifLog',
      commentAdded: 'AddSarifCommentOutcome',
      commentInvalid: 'AddSarifCommentOutcome',
      commentRemoved: 'RemoveSarifCommentOutcome',
      commentStale: 'RemoveSarifCommentOutcome',
      commentRemoveInvalid: 'RemoveSarifCommentOutcome',
      inspected: 'InspectSarifOutcome',
      inspectedUpstream: 'InspectSarifOutcome',
      inspectInvalid: 'InspectSarifOutcome',
      inspectedLogEvidence: 'InspectSarifOutcome',
      stagedInsertion: 'AddStagedChangesOutcome',
      stagedAdded: 'AddStagedChangesOutcome',
      stagedFailed: 'AddStagedChangesOutcome',
      stagedInvalid: 'AddStagedChangesOutcome',
    };
    // Object literals get excess-property checks: a field the runtime returns but the
    // declarations lack is a compile error, as is a wrongly typed or missing field.
    const source = [
      `import type { ${[...new Set(Object.values(typed))].join(', ')} } from 'sarif-to-comment';`,
      ...Object.entries(typed).map(([key, type]) => `export const ${key}: ${type} = ${JSON.stringify(outcomes[key])};`),
    ].join('\n');
    const check = typecheck(consumer, { 'drift.mts': source }, { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
  });

  test('the installed runtime exports exactly the declared functions', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const probe = spawnSync(
      process.execPath,
      ['-e', "const m = require('sarif-to-comment'); process.stdout.write(JSON.stringify(Object.keys(m).sort().map((k) => [k, typeof m[k]])))"],
      { cwd: consumer, encoding: 'utf8' },
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), [
      ['addSarifComment', 'function'],
      ['addStagedChangesToSarif', 'function'],
      ['closeSuggestionPullRequests', 'function'],
      ['createSarifDocument', 'function'],
      ['groupSarifFixes', 'function'],
      ['inspectSarif', 'function'],
      ['publishSarifReview', 'function'],
      ['removeSarifComment', 'function'],
      ['ungroupSarifFixes', 'function'],
      ['validateSarifReview', 'function'],
    ]);
  });

  test('CommonJS and ES module consumers see the same ten functions with no __esModule marker', { skip, timeout: 300_000 }, () => {
    // Interop shape of 0.2.0 (plain `module.exports = { ... }`): require()
    // yields the functions in the documented order (src/index.cjs module
    // doc); import() yields a namespace whose default export is that very
    // object and whose named exports are exactly those functions. No
    // __esModule marker exists, so bundlers and esModuleInterop consumers keep
    // treating the package as plain CommonJS. Node 24 additionally exposes a
    // 'module.exports' namespace key (Node 22 does not); it is the same object.
    const { consumer } = installIntoConsumer();
    // 0.2.0's five in their shipped order; later additions are appended, so that order is kept.
    const names = ['createSarifDocument', 'addSarifComment', 'inspectSarif', 'addStagedChangesToSarif', 'publishSarifReview', 'removeSarifComment', 'validateSarifReview', 'closeSuggestionPullRequests', 'groupSarifFixes', 'ungroupSarifFixes'];
    fs.writeFileSync(
      path.join(consumer, 'interop-probe.mjs'),
      [
        "import { createRequire } from 'node:module';",
        "import * as ns from 'sarif-to-comment';",
        'const required = createRequire(import.meta.url)(\'sarif-to-comment\');',
        'const dynamic = await import(\'sarif-to-comment\');',
        'process.stdout.write(JSON.stringify({',
        '  requireKeys: Object.keys(required),',
        '  requireEsModule: Object.hasOwn(required, \'__esModule\'),',
        '  namespaceKeys: Object.keys(ns),',
        '  namespaceEsModule: \'__esModule\' in ns,',
        '  defaultIsRequire: ns.default === required,',
        '  dynamicIsStatic: dynamic === ns,',
        '  moduleExportsIsRequire: !(\'module.exports\' in ns) || ns[\'module.exports\'] === required,',
        '  namedAreRequire: Object.keys(required).every((k) => ns[k] === required[k]),',
        '}));',
      ].join('\n'),
    );
    const probe = spawnSync(process.execPath, ['interop-probe.mjs'], { cwd: consumer, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stderr, '', 'no interop warning');
    const seen = expectType(
      parseJson(probe.stdout),
      isShape({
        requireKeys: isUnknown,
        requireEsModule: isUnknown,
        namespaceKeys: isArrayOf(isString),
        namespaceEsModule: isUnknown,
        defaultIsRequire: isUnknown,
        dynamicIsStatic: isUnknown,
        moduleExportsIsRequire: isUnknown,
        namedAreRequire: isUnknown,
      }),
      'the interop probe report',
    );
    assert.deepEqual(seen.requireKeys, names, 'require() keys in documented order');
    assert.equal(seen.requireEsModule, false, 'require() result carries no __esModule marker');
    assert.equal(seen.namespaceEsModule, false, 'the ES namespace has no __esModule key');
    assert.deepEqual(
      seen.namespaceKeys.filter((k) => k !== 'default' && k !== 'module.exports'),
      [...names].sort(),
      'named exports are exactly the ten functions',
    );
    assert.ok(seen.namespaceKeys.includes('default'));
    assert.equal(seen.defaultIsRequire, true, 'the default export is the require() object itself');
    assert.equal(seen.dynamicIsStatic, true);
    assert.equal(seen.moduleExportsIsRequire, true);
    assert.equal(seen.namedAreRequire, true);

    const cjs = spawnSync(process.execPath, ['-e', "process.stdout.write(String(require('sarif-to-comment').__esModule))"], {
      cwd: consumer,
      encoding: 'utf8',
    });
    assert.equal(cjs.status, 0, cjs.stderr);
    assert.equal(cjs.stdout, 'undefined');
  });

  test('the installed validateSarifReview returns exactly its declared outcomes, and its declarations reject misuse', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const js = String.raw;
    const script = js`
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const { validateSarifReview } = require('sarif-to-comment');
      const { FakeGitHubRemote } = require(${JSON.stringify(path.join(ROOT, 'test/fixtures/publication/fake-github.mts'))});
      const { createFakeClientFactory, setAdapterConfig, REPOSITORY } = require(${JSON.stringify(path.join(ROOT, 'test/fixtures/public-api/fake-adapter.mts'))});
      const load = (name) => JSON.parse(fs.readFileSync(path.join(${JSON.stringify(path.join(ROOT, 'test/fixtures/public-api'))}, name), 'utf8'));
      const assess = async (sarif, context) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-validate-'));
        const remote = FakeGitHubRemote.create(path.join(root, 'remote'));
        if (context) setAdapterConfig(remote.dir, { context });
        const input = { sarif, destination: REPOSITORY.destination, reviewedCommit: REPOSITORY.commits.head, token: 'ghp_consumer_validate_token' };
        return validateSarifReview(input, { createGitHubClient: createFakeClientFactory(remote.dir) });
      };
      (async () => {
        process.stdout.write(JSON.stringify({
          ready: await assess(load('ready.sarif.json')),
          blocked: await assess(load('held.sarif.json')),
          incomplete: await assess(load('ready.sarif.json'), 'unauthorized'),
        }));
      })().catch((err) => { console.error(err); process.exit(1); });
    `;
    const run = spawnSync(process.execPath, ['-e', script], { cwd: consumer, encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 0, run.stderr);
    const outcomes = asRecord(parseJson(run.stdout), 'the installed assessment outcomes');
    for (const status of ['ready', 'blocked', 'incomplete']) {
      assert.equal(expectType(outcomes[status], isShape({ status: isUnknown }), `the ${status} outcome`).status, status);
    }
    // Object literals get excess-property checks: a runtime field the declarations lack is a compile error.
    const source = [
      "import { validateSarifReview } from 'sarif-to-comment';",
      "import type { ValidateSarifReviewOutcome, IValidateSarifReviewInput } from 'sarif-to-comment';",
      ...['ready', 'blocked', 'incomplete'].map((key) => `export const ${key}: ValidateSarifReviewOutcome = ${JSON.stringify(outcomes[key])};`),
      ts`export async function use(input: IValidateSarifReviewInput): Promise<string> {
        const outcome = await validateSarifReview(input);
        switch (outcome.status) {
          case 'ready': return outcome.markdown;
          case 'blocked': return outcome.problems.map((p) => p.message + (p.pointer ?? '')).join(outcome.markdown);
          case 'incomplete': return outcome.markdown;
          default: { const never: never = outcome; return never; }
        }
      }
      const base = { sarif: {}, destination: { owner: 'a', repo: 'b', pullNumber: 1 }, reviewedCommit: 'x', token: 't' };
      // @ts-expect-error assessment takes no state path
      void validateSarifReview({ ...base, statePath: '/s' } satisfies IValidateSarifReviewInput);
      // @ts-expect-error token is required
      void validateSarifReview({ sarif: {}, destination: { owner: 'a', repo: 'b', pullNumber: 1 }, reviewedCommit: 'x' });
      // @ts-expect-error a ready outcome has no problems
      void ((o: ValidateSarifReviewOutcome) => o.status === 'ready' && o.problems);`,
    ].join('\n');
    const check = typecheck(consumer, { 'validate.mts': source }, { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
  });

  test('control: the type checker does reject a genuine misuse', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const run = typecheck(
      consumer,
      { 'bad.mts': ts`import { publishSarifReview } from 'sarif-to-comment';\nvoid publishSarifReview({ sarif: {} });\nexport {};` },
      { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022' },
    );
    assert.notEqual(run.status, 0, 'a missing destination must be a type error');
    assert.match(run.stdout, /destination/);
  });
});
