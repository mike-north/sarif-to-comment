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
const { UPSTREAM_SARIF_PATH, createGitWorld } = require('./fixtures/authoring-workflow/git-world.cjs');

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

  test('the npm description names the optional authoring and inspection as well as publication', () => {
    // The registry listing is how users discover the package; it must not describe only publication.
    assert.match(PKG.description, /\bwrite\b/i, 'optional authoring');
    assert.match(PKG.description, /\binspect\b/i, 'inspection');
    assert.match(PKG.description, /draft pull request review/, 'publication as one draft review');
    assert.match(PKG.description, /never-duplicating/, 'durable delivery');
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
    const declared = [...fs.readFileSync(path.join(ROOT, PKG.types), 'utf8').matchAll(/^export declare function (\w+)\(/gm)].map((m) => m[1]);
    assert.deepEqual(declared.sort(), ['addSarifComment', 'addStagedChangesToSarif', 'createSarifDocument', 'inspectSarif', 'publishSarifReview']);
    assert.deepEqual(Object.keys(require(resolved)).sort(), declared, 'the runtime exports exactly the declared API');
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
    const outcomes = JSON.parse(run.stdout);
    assert.deepEqual(
      [outcomes.commentAdded.status, outcomes.commentInvalid.status, outcomes.inspected.status, outcomes.inspectInvalid.status,
        outcomes.stagedAdded.status, outcomes.stagedFailed.status, outcomes.stagedInvalid.status],
      ['added', 'invalid', 'inspected', 'invalid', 'added', 'failed', 'invalid'],
      'each declared outcome variant is exercised',
    );
    // The evidence-bearing optional fields really occur, so the literal checks below cover them.
    const logView = outcomes.inspectedLogEvidence.view;
    assert.ok(logView.log && logView.externalProperties && logView.summary.externalFindings !== undefined, 'log and external evidence present');
    assert.ok(JSON.stringify(logView).includes('"otherContent":{"properties":{"rationale"'), 'a preview carries otherContent');
    assert.equal(outcomes.stagedInsertion.status, 'added', outcomes.stagedInsertion.markdown);
    assert.ok(outcomes.stagedInsertion.receipt.changes[0].replacements.every((r) => r.insertion === true), 'insertion receipts');
    const typed = {
      log: 'ISarifLog',
      commentAdded: 'AddSarifCommentOutcome',
      commentInvalid: 'AddSarifCommentOutcome',
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
      ['createSarifDocument', 'function'],
      ['inspectSarif', 'function'],
      ['publishSarifReview', 'function'],
    ]);
  });

  test('CommonJS and ES module consumers see the same five functions with no __esModule marker', { skip, timeout: 300_000 }, () => {
    // Interop shape of 0.2.0 (plain `module.exports = { ... }`): require()
    // yields the five functions in the documented order (src/index.cjs module
    // doc); import() yields a namespace whose default export is that very
    // object and whose named exports are exactly those functions. No
    // __esModule marker exists, so bundlers and esModuleInterop consumers keep
    // treating the package as plain CommonJS. Node 24 additionally exposes a
    // 'module.exports' namespace key (Node 22 does not); it is the same object.
    const { consumer } = installIntoConsumer();
    const names = ['createSarifDocument', 'addSarifComment', 'inspectSarif', 'addStagedChangesToSarif', 'publishSarifReview'];
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
    const seen = JSON.parse(probe.stdout);
    assert.deepEqual(seen.requireKeys, names, 'require() keys in documented order');
    assert.equal(seen.requireEsModule, false, 'require() result carries no __esModule marker');
    assert.equal(seen.namespaceEsModule, false, 'the ES namespace has no __esModule key');
    assert.deepEqual(
      seen.namespaceKeys.filter((k) => k !== 'default' && k !== 'module.exports'),
      [...names].sort(),
      'named exports are exactly the five functions',
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
