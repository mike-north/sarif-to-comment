'use strict';

/**
 * Package acceptance tests: the package a consumer installs is the product.
 *
 * - The manifest names the real entry points (library main/exports with its
 *   type declarations, and the CLI bin), is publishable with repository
 *   metadata that exactly names the trusted-publishing repository, keeps the
 *   version below 1.0.0, pins the supported Node range and lists every runtime
 *   dependency the shipped sources require. (Changesets, the release guard
 *   and the workflows are covered by test/release.test.cjs; documentation by
 *   test/docs.test.cjs.)
 * - `npm pack` produces exactly the intended distribution: runtime sources,
 *   CLI, type declarations, vendored schema, README, CHANGELOG, the
 *   getting-started guide and the generated API reference — never tests,
 *   logs, internal design docs, release tooling, pending changesets, private
 *   evidence or agent configuration.
 * - The tarball is really installed with `npm install` into a clean consumer
 *   (test/fixtures/package/installed-package.cjs). The installed library is
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

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ROOT, PKG, npm, packProject, installIntoConsumer } = require('./fixtures/package/installed-package.cjs');

/** The package.json `files` whitelist: the intended distribution boundary. */
const EXPECTED_FILES_FIELD = [
  'src/',
  'bin/',
  'types/',
  'vendor/',
  'docs/getting-started.md',
  'docs/api/',
  'CHANGELOG.md',
  'README.md',
];

/** Whether a packed path is inside the intended distribution boundary. */
function distributable(file) {
  return (
    file === 'package.json' ||
    file === 'README.md' ||
    file === 'CHANGELOG.md' ||
    /^LICENSE(\.md|\.txt)?$/.test(file) ||
    /^src\/[^/]+\.cjs$/.test(file) ||
    file === 'bin/sarif-to-comment.cjs' ||
    file === 'types/index.d.ts' ||
    /^vendor\/[^/]+$/.test(file) ||
    file === 'docs/getting-started.md' ||
    /^docs\/api\/[^/]+\.md$/.test(file)
  );
}

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
  test('identity, publishability and module type', () => {
    assert.equal(PKG.name, 'sarif-to-comment');
    assert.match(PKG.version, /^0\.\d+\.\d+$/, 'a stable 0.x version (the release guard enforces the ceiling)');
    assert.equal(Object.hasOwn(PKG, 'private'), false, 'the package is released to npm through trusted publishing');
    assert.deepEqual(PKG.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org/' });
    assert.equal(PKG.type, 'commonjs');
  });

  test('repository metadata names exactly the trusted-publishing repository', () => {
    // npm trusted publishing requires repository.url to match the GitHub
    // repository the OIDC token names (https://docs.npmjs.com/trusted-publishers/).
    assert.deepEqual(PKG.repository, { type: 'git', url: 'git+https://github.com/mike-north/sarif-to-comment.git' });
    assert.equal(PKG.homepage, 'https://github.com/mike-north/sarif-to-comment#readme');
    assert.deepEqual(PKG.bugs, { url: 'https://github.com/mike-north/sarif-to-comment/issues' });
  });

  test('library entry points resolve to the real public module and its declarations', () => {
    assert.equal(PKG.main, './src/index.cjs');
    assert.equal(PKG.types, './types/index.d.ts');
    assert.deepEqual(PKG.exports, {
      '.': { types: './types/index.d.ts', default: './src/index.cjs' },
      './package.json': './package.json',
    });
    const resolved = require.resolve(path.join(ROOT, PKG.exports['.'].default));
    assert.equal(resolved, path.join(ROOT, 'src', 'index.cjs'));
    assert.deepEqual(Object.keys(require(resolved)), ['publishSarifReview'], 'the runtime exports exactly the declared API');
  });

  test('the CLI bin points at an executable Node script', () => {
    // Written in npm's normalized form (no leading "./"), so publishing does not
    // rewrite the manifest or warn that the entry was "invalid and removed".
    assert.deepEqual(PKG.bin, { 'sarif-to-comment': 'bin/sarif-to-comment.cjs' });
    const text = fs.readFileSync(path.join(ROOT, PKG.bin['sarif-to-comment']), 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env node\n'), 'bin must start with a node shebang');
  });

  test('the supported Node range is declared and satisfied by this runtime', () => {
    assert.deepEqual(PKG.engines, { node: '>=22' });
    assert.ok(Number(process.versions.node.split('.')[0]) >= 22, `running Node ${process.versions.node}`);
  });

  test('the files whitelist is exactly the intended boundary', () => {
    const expected = [...EXPECTED_FILES_FIELD];
    for (const license of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      if (fs.existsSync(path.join(ROOT, license))) expected.push(license);
    }
    assert.deepEqual(PKG.files, expected);
  });

  test('every runtime require is a declared dependency; tooling stays a dev dependency', () => {
    const declared = new Set(Object.keys(PKG.dependencies || {}));
    for (const name of requiredPackages()) assert.ok(declared.has(name), `${name} is required at runtime but not a dependency`);
    assert.deepEqual([...declared].sort(), ['ajv', 'ajv-draft-04', 'ajv-formats']);
    for (const tool of ['@changesets/cli', '@microsoft/api-extractor', '@microsoft/api-documenter', 'typescript']) {
      assert.ok(Object.hasOwn(PKG.devDependencies, tool), `${tool} is a dev dependency`);
    }
  });

  test('scripts are purpose-named and checks are read-only', () => {
    const scripts = PKG.scripts || {};
    assert.equal(scripts.test, 'node --test test/*.test.cjs');
    assert.match(scripts['check:lint'] || '', /^eslint\b/);
    assert.ok(scripts.check, 'an aggregate read-only check script exists');
    assert.ok(scripts.build, 'build regenerates the API report and reference documentation');
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
    const files = packed.result.files.map((f) => f.path).sort();
    assert.deepEqual(files.filter((f) => !distributable(f)), [], 'unexpected files in the package');
    const apiPages = fs.readdirSync(path.join(ROOT, 'docs', 'api')).map((f) => `docs/api/${f}`);
    for (const required of [
      'package.json',
      'README.md',
      'CHANGELOG.md',
      'bin/sarif-to-comment.cjs',
      'types/index.d.ts',
      'vendor/sarif-schema-2.1.0.json',
      'vendor/README.md',
      'docs/getting-started.md',
      ...apiPages,
      ...fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.cjs')).map((f) => `src/${f}`),
    ]) {
      assert.ok(files.includes(required), `${required} is missing from the package`);
    }
    assert.ok(apiPages.length >= 3, 'the generated API reference has pages');
  });

  // npm normalizes manifests when publishing a directory and warns about every
  // rewrite (for example a "./"-prefixed bin path is reported as "invalid and
  // removed"). The release publishes the verified tarball, but the manifest
  // must also be clean for a directory publish so no form of publishing
  // rewrites what consumers receive.
  for (const [form, args, cwd] of [
    ['the verified tarball', () => ['publish', '--dry-run', packed.tarball], () => packed.work],
    ['the package directory', () => ['publish', '--dry-run'], () => ROOT],
  ]) {
    test(`npm publish --dry-run of ${form} needs no manifest auto-correction`, { skip }, () => {
      const dryRun = npm(args(), { cwd: cwd(), env: packed.env });
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
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    assert.equal(manifest.version, PKG.version);
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
  });

  /**
   * Type-checks consumer sources against the installed package with the
   * project's TypeScript. `expectErrors` lines must each fail to compile (they
   * carry `@ts-expect-error`, which itself errors if the line compiles).
   */
  function typecheck(consumer, files, compilerOptions) {
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
  const ts = (strings, ...values) => strings.reduce((out, part, i) => out + part + (i < values.length ? values[i] : ''), '');
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
