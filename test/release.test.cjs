'use strict';

/**
 * Release tests: Changesets versioning, the major-version ceiling, the publish
 * decision, the package boundary, and the GitHub Actions workflows that
 * release through npm trusted publishing.
 *
 * Intended outcomes (README.md "Releasing"):
 * - Versions are produced only by Changesets (`pnpm run release:version`,
 *   which wraps `changeset version`). Routine 0.x patch and minor releases
 *   work; the resulting CHANGELOG entry proves which tool produced a version.
 * - Nothing reaches version 1.0.0 or higher — including 1.x prereleases —
 *   until MAXIMUM_RELEASE_MAJOR is deliberately raised (together with the
 *   test that pins it); a raised ceiling then permits exactly that major.
 * - The release plan is Changesets' own: whenever any changeset file exists
 *   the guard runs the real `changeset version` in a throwaway copy and judges
 *   the version and changelog it produces, so YAML-quoted or otherwise valid
 *   front matter cannot slip past, and unreadable changesets are refused. A requested major is
 *   refused with an explanation, never silently turned into a smaller bump,
 *   and refused before any file is changed. Changesets pre mode is refused.
 * - The publish workflow publishes only when package.json holds a stable,
 *   Changesets-produced version that is not yet on npm; an already-published
 *   version is a no-op, and an unreachable registry is a failure, not
 *   "unpublished". It authenticates only by OIDC, runs the full check, and
 *   publishes exactly the verified tarball.
 * - The first release: npm holds 0.0.0; the repository's pending first-release
 *   changeset turns 0.0.0 into 0.1.0.
 * - The release plan is computed by the real `changeset version` in a
 *   throwaway copy (Changesets 3 `status` only sees changesets added since a
 *   git ref), so what the guard judges is what Changesets would produce.
 *
 * Every guard rule has a negative control next to a positive one, and the
 * real Changesets CLI is exercised in temporary repositories (including a
 * control proving that raw `changeset version` would reach 1.0.0 without the
 * guard). Registry lookups run the real npm CLI against a local fake registry.
 *
 * @see https://changesets.dev/guide/cli
 * @see https://changesets.dev/guide/config
 * @see https://docs.npmjs.com/trusted-publishers/
 * @see https://docs.npmjs.com/cli/v11/commands/npm-view
 * @see https://semver.org/spec/v2.0.0.html
 */

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts', 'release-guard.cjs');
const CHANGESET_BIN = path.join(ROOT, 'node_modules', '.bin', 'changeset');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const guard = require('../scripts/release-guard.cjs');
const MANIFEST_TOOL = path.join(ROOT, 'scripts', 'build-manifest.mts');

const TRUSTED_URL = 'git+https://github.com/mike-north/sarif-to-comment.git';

/** A publishable manifest at `version`; tests break one property at a time. */
function manifest(version = '0.1.0', overrides = {}) {
  return { name: 'sarif-to-comment', version, repository: { type: 'git', url: TRUSTED_URL }, ...overrides };
}

/** A Changesets-produced CHANGELOG whose newest entry is `version`. */
function changelog(version = '0.1.0') {
  return `# sarif-to-comment\n\n## ${version}\n\n### Minor Changes\n\n- abc1234: First release\n\n## 0.0.9\n\n- older\n`;
}

/** Facts for a correct publish of 0.1.0; tests break one fact at a time. */
function publishFacts(overrides = {}) {
  return {
    packageJson: manifest(),
    changelog: changelog(),
    publishedVersions: ['0.0.0'],
    preMode: false,
    npmVersion: '11.5.1',
    nodeVersion: '22.18.0',
    onMain: true,
    ...overrides,
  };
}

/** A release plan in the shape computeReleasePlan returns, releasing sarif-to-comment. */
function plan(type, oldVersion, newVersion) {
  return {
    changesets: [{ id: 'c1', summary: 's', releases: [{ name: 'sarif-to-comment', type }] }],
    releases: [{ name: 'sarif-to-comment', type, oldVersion, newVersion, changesets: ['c1'] }],
  };
}

/** `npm pack --json` result for a correct tarball of `version`. */
function packResult(version = '0.1.0', extra = []) {
  return {
    name: 'sarif-to-comment',
    version,
    filename: `sarif-to-comment-${version}.tgz`,
    files: [
      'package.json',
      'README.md',
      'CHANGELOG.md',
      'dist/sarif-to-comment.cjs',
      'dist/cli.cjs',
      'dist/github.cjs',
      'dist/index.cjs',
      'dist/placement.cjs',
      'dist/prepare-review.cjs',
      'dist/publication.cjs',
      'dist/replacements.cjs',
      'dist/sarif-to-comment.d.ts',
      'vendor/README.md',
      'vendor/sarif-schema-2.1.0.json',
      'docs/getting-started.md',
      'docs/api/index.md',
      'docs/api/sarif-to-comment.md',
      'docs/api/sarif-to-comment.publishsarifreview.md',
      ...extra,
    ].map((p) => ({ path: p })),
  };
}

// ===========================================================================
// Policy
// ===========================================================================

describe('the major-version ceiling is an explicit, reviewed constant', () => {
  test('MAXIMUM_RELEASE_MAJOR is 0: nothing may reach 1.0.0 until it is deliberately raised', () => {
    // Raising the ceiling requires changing both the constant and this test.
    assert.equal(guard.MAXIMUM_RELEASE_MAJOR, 0);
  });

  test('the trusted-publishing repository URL is exact', () => {
    assert.equal(guard.EXPECTED_REPOSITORY_URL, TRUSTED_URL);
  });

  test('publishing needs Node 22.18.0: trusted publishing needs 22.14.0, and the build tooling needs type stripping', () => {
    // The release runs the TypeScript build tooling by Node's native type
    // stripping, which first works without flags in 22.18.0; checking for
    // that version here explains a too-old runner instead of failing later
    // with a syntax error. It is at least npm's trusted-publishing minimum.
    assert.equal(guard.MIN_NODE, '22.18.0');
    assert.equal(guard.MIN_NPM, '11.5.1');
  });
});

describe('release plan (pending changesets) never exceeds the ceiling', () => {
  test('positive controls: routine 0.x minor and patch plans pass', () => {
    assert.deepEqual(guard.checkReleasePlan(plan('minor', '0.0.0', '0.1.0'), { preMode: false }), []);
    assert.deepEqual(guard.checkReleasePlan(plan('patch', '0.1.0', '0.1.1'), { preMode: false }), []);
    assert.deepEqual(guard.checkReleasePlan({ changesets: [], releases: [] }, { preMode: false }), []);
  });

  const refusals = {
    'a requested major (never silently reduced)': [plan('major', '0.1.0', '1.0.0'), /major/],
    'a plan reaching 1.0.0 by any route': [plan('minor', '0.9.0', '1.0.0'), /1\.0\.0/],
    'a 1.x prerelease': [plan('major', '0.1.0', '1.0.0-next.0'), /1\.0\.0-next\.0/],
    'a 0.x prerelease (pre mode is not part of this release path)': [plan('minor', '0.1.0', '0.2.0-next.0'), /prerelease/i],
    'a release of an unknown package': [
      { changesets: [], releases: [{ name: 'other', type: 'patch', oldVersion: '0.0.0', newVersion: '0.0.1', changesets: [] }] },
      /other/,
    ],
  };
  for (const [label, [value, mention]] of Object.entries(refusals)) {
    test(`refuses ${label}`, () => {
      const problems = guard.checkReleasePlan(value, { preMode: false });
      assert.ok(problems.length > 0, `${label} must be refused`);
      assert.ok(problems.some((p) => mention.test(p)), JSON.stringify(problems));
    });
  }

  test('a raised ceiling permits a major to exactly that major and refuses the next', () => {
    assert.deepEqual(guard.checkReleasePlan(plan('major', '0.9.0', '1.0.0'), { preMode: false, ceiling: 1 }), []);
    const refused = guard.checkReleasePlan(plan('major', '1.4.0', '2.0.0'), { preMode: false, ceiling: 1 });
    assert.ok(refused.some((p) => /2\.0\.0 or above/.test(p)), JSON.stringify(refused));
  });

  test('refuses Changesets pre mode', () => {
    const problems = guard.checkReleasePlan(plan('minor', '0.0.0', '0.1.0'), { preMode: true });
    assert.ok(problems.some((p) => /pre mode|pre\.json/i.test(p)), JSON.stringify(problems));
  });

  test('explains how a major is released instead of converting it', () => {
    const [message] = guard.checkReleasePlan(plan('major', '0.1.0', '1.0.0'), { preMode: false });
    assert.match(message, /MAXIMUM_RELEASE_MAJOR/);
    assert.match(message, /minor/, 'it names the alternative the author may choose deliberately');
  });
});

describe('publish decision', () => {
  test('positive control: a new, stable, Changesets-produced 0.x version publishes', () => {
    assert.deepEqual(guard.decidePublish(publishFacts()), { publish: true, problems: [] });
  });

  test('an already-published version is a no-op, not an error', () => {
    const decision = guard.decidePublish(publishFacts({ packageJson: manifest('0.0.0'), publishedVersions: ['0.0.0'] }));
    assert.equal(decision.publish, false);
    assert.deepEqual(decision.problems, []);
  });

  test('a brand-new package (no versions on npm) may publish', () => {
    assert.equal(guard.decidePublish(publishFacts({ publishedVersions: [] })).publish, true);
  });

  const refusals = {
    'version 1.0.0': [{ packageJson: manifest('1.0.0'), changelog: changelog('1.0.0') }, /1\.0\.0/],
    'version 2.3.4': [{ packageJson: manifest('2.3.4'), changelog: changelog('2.3.4') }, /2\.3\.4/],
    'a 1.x prerelease': [{ packageJson: manifest('1.0.0-rc.1'), changelog: changelog('1.0.0-rc.1') }, /1\.0\.0-rc\.1/],
    'a 0.x prerelease': [{ packageJson: manifest('0.2.0-beta.1'), changelog: changelog('0.2.0-beta.1') }, /prerelease/i],
    'a version without a Changesets CHANGELOG entry': [{ changelog: changelog('0.0.9') }, /CHANGELOG/],
    'a missing CHANGELOG': [{ changelog: undefined }, /CHANGELOG/],
    'Changesets pre mode': [{ preMode: true }, /pre mode|pre\.json/i],
    'a private package': [{ packageJson: manifest('0.1.0', { private: true }) }, /private/],
    'another package name': [{ packageJson: manifest('0.1.0', { name: 'sarif-to-comments' }) }, /name/i],
    'a fork repository URL': [
      { packageJson: manifest('0.1.0', { repository: { type: 'git', url: 'git+https://github.com/x/sarif-to-comment.git' } }) },
      /repository/i,
    ],
    'npm older than 11.5.1': [{ npmVersion: '11.5.0' }, /npm.*11\.5\.1/],
    'Node older than 22.18.0': [{ nodeVersion: '22.17.1' }, /Node.*22\.18\.0/],
    'Node older than the trusted-publishing minimum': [{ nodeVersion: '22.13.1' }, /Node.*22\.18\.0/],
    'a commit not on main': [{ onMain: false }, /main/],
  };
  for (const [label, [change, mention]] of Object.entries(refusals)) {
    test(`refuses ${label}`, () => {
      const decision = guard.decidePublish(publishFacts(change));
      assert.equal(decision.publish, false);
      assert.ok(decision.problems.some((p) => mention.test(p)), JSON.stringify(decision.problems));
    });
  }

  test('a version above the ceiling is refused even if npm already has it', () => {
    const decision = guard.decidePublish(
      publishFacts({ packageJson: manifest('1.0.0'), changelog: changelog('1.0.0'), publishedVersions: ['1.0.0'] }),
    );
    assert.ok(decision.problems.length > 0);
  });

  test('a raised ceiling lets exactly that major publish', () => {
    const one = publishFacts({ packageJson: manifest('1.0.0'), changelog: changelog('1.0.0'), ceiling: 1 });
    assert.deepEqual(guard.decidePublish(one), { publish: true, problems: [] });
    const two = publishFacts({ packageJson: manifest('2.0.0'), changelog: changelog('2.0.0'), ceiling: 1 });
    assert.equal(guard.decidePublish(two).publish, false);
  });

  test('versions compare numerically, not as text', () => {
    assert.equal(guard.decidePublish(publishFacts({ npmVersion: '11.10.0', nodeVersion: '24.0.0' })).publish, true);
    assert.equal(guard.decidePublish(publishFacts({ npmVersion: '9.99.99' })).publish, false);
  });
});

describe('the packed tarball is exactly the distribution boundary', () => {
  test('positive control: the intended files pass', () => {
    assert.deepEqual(guard.checkPackedTarball(packResult(), manifest()), []);
  });

  const bad = {
    'a test file': (p) => p.files.push({ path: 'test/publication.test.cjs' }),
    'a log': (p) => p.files.push({ path: 'logs/opus/x.txt' }),
    'agent configuration': (p) => p.files.push({ path: '.claude/settings.json' }),
    'internal design documentation': (p) => p.files.push({ path: 'docs/specification.md' }),
    'the release guard': (p) => p.files.push({ path: 'scripts/release-guard.cjs' }),
    'a pending changeset': (p) => p.files.push({ path: '.changeset/first-release.md' }),
    'the API report': (p) => p.files.push({ path: 'api-report/sarif-to-comment.api.md' }),
    'a nested source directory': (p) => p.files.push({ path: 'src/internal/x.cjs' }),
    'a source module': (p) => p.files.push({ path: 'src/index.cjs' }),
    'a TypeScript source': (p) => p.files.push({ path: 'src/index.cts' }),
    'a nested build directory': (p) => p.files.push({ path: 'dist/internal/x.cjs' }),
    'a per-module declaration': (p) => p.files.push({ path: 'dist/index.d.cts' }),
    'a source map': (p) => p.files.push({ path: 'dist/index.cjs.map' }),
    'TypeScript build info': (p) => p.files.push({ path: 'dist/tsconfig.tsbuildinfo' }),
    'the build-freshness manifest': (p) => p.files.push({ path: 'dist/.build-inputs.json' }),
    'the declaration-only entry output': (p) => p.files.push({ path: 'dist/public-api.cjs' }),
    'the former hand-written declarations path': (p) => p.files.push({ path: 'types/index.d.ts' }),
    'the former executable path': (p) => p.files.push({ path: 'bin/sarif-to-comment.cjs' }),
    'a missing entry point': (p) => (p.files = p.files.filter((f) => f.path !== 'dist/index.cjs')),
    'missing type declarations': (p) => (p.files = p.files.filter((f) => f.path !== 'dist/sarif-to-comment.d.ts')),
    'a missing CLI': (p) => (p.files = p.files.filter((f) => f.path !== 'dist/sarif-to-comment.cjs')),
    'a missing getting-started guide': (p) => (p.files = p.files.filter((f) => f.path !== 'docs/getting-started.md')),
    'missing API reference': (p) => (p.files = p.files.filter((f) => f.path !== 'docs/api/index.md')),
    'a missing CHANGELOG': (p) => (p.files = p.files.filter((f) => f.path !== 'CHANGELOG.md')),
    'a missing vendored schema': (p) => (p.files = p.files.filter((f) => f.path !== 'vendor/sarif-schema-2.1.0.json')),
    'a different version': (p) => (p.version = '0.0.9'),
  };
  test('the boundary admits exactly the flat built runtime, the rolled-up declarations, vendor and docs', () => {
    for (const file of [
      'package.json',
      'README.md',
      'CHANGELOG.md',
      'LICENSE',
      'dist/index.cjs',
      'dist/sarif-to-comment.cjs',
      'dist/publish-sarif-review.cjs',
      'dist/sarif-to-comment.d.ts',
      'vendor/sarif-schema-2.1.0.json',
      'docs/getting-started.md',
      'docs/api/index.md',
    ]) {
      assert.equal(guard.isDistributable(file), true, file);
    }
    for (const file of [
      'src/index.cjs',
      'src/index.cts',
      'dist/internal/x.cjs',
      'dist/index.d.cts',
      'dist/index.d.ts',
      'dist/index.cjs.map',
      'dist/tsconfig.tsbuildinfo',
      'dist/.build-inputs.json',
      'dist/public-api.cjs',
      'dist/index.cts',
      'dist/index.js',
      'types/index.d.ts',
      'bin/sarif-to-comment.cjs',
      'scripts/build.mts',
      'test/x.test.mts',
    ]) {
      assert.equal(guard.isDistributable(file), false, file);
    }
  });

  for (const [label, breakIt] of Object.entries(bad)) {
    test(`refuses a tarball with ${label}`, () => {
      const pack = packResult();
      breakIt(pack);
      assert.ok(guard.checkPackedTarball(pack, manifest()).length > 0, `${label} must be refused`);
    });
  }
});

// ===========================================================================
// Real Changesets tooling
// ===========================================================================

describe('guarded versioning with the real Changesets CLI', () => {
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', NO_COLOR: '1' };

  /**
   * A temporary git repository with this project's Changesets config and a
   * package at `version`. Each changeset is [type, summary] (written with the
   * package name quoted and the type bare, as `changeset add` does) or the
   * complete file text, for front matter written by hand.
   */
  function makeRepository(version, changesets = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-changesets-'));
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...env, HOME: dir } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git('init', '--quiet', '--initial-branch=main');
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest(version), null, 2)}\n`);
    fs.mkdirSync(path.join(dir, '.changeset'));
    fs.copyFileSync(path.join(ROOT, '.changeset', 'config.json'), path.join(dir, '.changeset', 'config.json'));
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# sarif-to-comment\n');
    for (const [id, value] of Object.entries(changesets)) {
      const text = typeof value === 'string' ? value : `---\n"sarif-to-comment": ${value[0]}\n---\n\n${value[1]}\n`;
      fs.writeFileSync(path.join(dir, '.changeset', `${id}.md`), text);
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'init');
    return dir;
  }

  const runGuard = (dir, ...args) =>
    spawnSync(process.execPath, [GUARD, ...args], { cwd: dir, encoding: 'utf8', env: { ...env, HOME: dir }, timeout: 120_000 });
  const version = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

  test('control: raw `changeset version` turns a major changeset on 0.x into 1.0.0', () => {
    const dir = makeRepository('0.1.0', { big: ['major', 'Breaking change'] });
    const raw = spawnSync(CHANGESET_BIN, ['version'], { cwd: dir, encoding: 'utf8', env: { ...env, HOME: dir } });
    assert.equal(raw.status, 0, raw.stderr);
    assert.equal(version(dir), '1.0.0', 'without the guard Changesets would release 1.0.0');
  });

  test('the first release: a minor changeset turns npm’s 0.0.0 into a Changesets-produced 0.1.0', () => {
    const dir = makeRepository('0.0.0', { 'first-release': ['minor', 'First release of the milestone.'] });
    const run = runGuard(dir, 'version');
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.equal(version(dir), '0.1.0');
    const log = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    assert.match(log, /^# sarif-to-comment\n\n## 0\.1\.0\n\n### Minor Changes\n\n- [0-9a-f]{7}: First release of the milestone\.\n/);
    assert.equal(fs.existsSync(path.join(dir, '.changeset', 'first-release.md')), false, 'the changeset is consumed');
  });

  test('a routine patch release: 0.1.0 becomes 0.1.1', () => {
    const dir = makeRepository('0.1.0', { fix: ['patch', 'Fix a thing.'] });
    const run = runGuard(dir, 'version');
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.equal(version(dir), '0.1.1');
    assert.match(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), /## 0\.1\.1\n\n### Patch Changes/);
  });

  test('a major changeset is refused before any file changes; it is not converted', () => {
    const dir = makeRepository('0.1.0', { big: ['major', 'Breaking change'], fix: ['patch', 'Fix'] });
    const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    const run = runGuard(dir, 'version');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /major/);
    assert.match(run.stderr, /1\.0\.0/);
    assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before, 'package.json is untouched');
    assert.equal(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), '# sarif-to-comment\n');
    assert.ok(fs.existsSync(path.join(dir, '.changeset', 'big.md')), 'the major changeset is kept for the author to decide');
  });

  test('pre mode is refused before any file changes', () => {
    const dir = makeRepository('0.1.0', { feat: ['minor', 'Feature'] });
    const pre = spawnSync(CHANGESET_BIN, ['pre', 'enter', 'next'], { cwd: dir, encoding: 'utf8', env: { ...env, HOME: dir } });
    assert.equal(pre.status, 0, pre.stderr);
    const run = runGuard(dir, 'version');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /pre mode|pre\.json/i);
    assert.equal(version(dir), '0.1.0');
  });

  // The plan must follow Changesets' own reading of changeset files. A guard
  // that parsed front matter itself would miss YAML-quoted values Changesets
  // accepts: a quoted "major" would pass `plan` and `version` while
  // `changeset version` produced 1.0.0.
  const quoted = (type, quote = '"') => `---\n"sarif-to-comment": ${quote}${type}${quote}\n---\n\nQuoted ${type}.\n`;

  test('control: Changesets itself accepts a YAML-quoted "major" and would release 1.0.0', () => {
    const dir = makeRepository('0.0.0', { q: quoted('major') });
    const raw = spawnSync(CHANGESET_BIN, ['version'], { cwd: dir, encoding: 'utf8', env: { ...env, HOME: dir } });
    assert.equal(raw.status, 0, raw.stderr);
    assert.equal(version(dir), '1.0.0');
  });

  for (const [label, file] of [
    ['double-quoted "major"', quoted('major')],
    ["single-quoted 'major'", quoted('major', "'")],
    ['quoted package name and quoted major with extra spacing', `---\n'sarif-to-comment' :   "major"\n---\n\nSpaced.\n`],
  ]) {
    test(`a ${label} changeset is refused by plan and version, before any file changes`, () => {
      const dir = makeRepository('0.0.0', { q: file });
      const plan = runGuard(dir, 'plan');
      assert.equal(plan.status, 1, plan.stdout + plan.stderr);
      assert.match(plan.stderr, /major/);
      const run = runGuard(dir, 'version');
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.equal(version(dir), '0.0.0');
      assert.ok(fs.existsSync(path.join(dir, '.changeset', 'q.md')), 'the changeset is left as written');
    });
  }

  test('a quoted "major" mixed with an ordinary minor is still refused', () => {
    const dir = makeRepository('0.1.0', { feat: ['minor', 'Feature'], q: quoted('major') });
    assert.equal(runGuard(dir, 'plan').status, 1);
    assert.equal(runGuard(dir, 'version').status, 1);
    assert.equal(version(dir), '0.1.0');
  });

  for (const [type, from, to] of [['minor', '0.0.0', '0.1.0'], ['patch', '0.1.0', '0.1.1']]) {
    test(`a quoted "${type}" changeset is a real pending release: ${from} becomes ${to}`, () => {
      const dir = makeRepository(from, { q: quoted(type) });
      const plan = runGuard(dir, 'plan');
      assert.equal(plan.status, 0, plan.stderr);
      assert.match(plan.stdout, new RegExp(`${from.replace(/\./g, '\\.')} -> ${to.replace(/\./g, '\\.')}`));
      const run = runGuard(dir, 'version');
      assert.equal(run.status, 0, run.stderr + run.stdout);
      assert.equal(version(dir), to);
    });
  }

  test('an ordinary minor with a quoted patch releases the minor', () => {
    const dir = makeRepository('0.1.0', { feat: ['minor', 'Feature'], q: quoted('patch', "'") });
    assert.equal(runGuard(dir, 'version').status, 0);
    assert.equal(version(dir), '0.2.0');
  });

  test('a changeset file Changesets cannot read is refused, never ignored', () => {
    const dir = makeRepository('0.1.0', { broken: '---\n"sarif-to-comment": enormous\n---\n\nNot a bump type.\n' });
    const plan = runGuard(dir, 'plan');
    assert.equal(plan.status, 1, plan.stdout + plan.stderr);
    assert.equal(runGuard(dir, 'version').status, 1);
    assert.equal(version(dir), '0.1.0');
  });

  for (const [label, file] of [
    ['a "none" changeset', '---\n"sarif-to-comment": none\n---\n\nNo release needed.\n'],
    ['an empty changeset', '---\n---\n\nNo release needed.\n'],
  ]) {
    test(`${label} is allowed, releases nothing, and is consumed by release:version as Changesets does`, () => {
      const dir = makeRepository('0.1.0', { quiet: file });
      const plan = runGuard(dir, 'plan');
      assert.equal(plan.status, 0, plan.stderr);
      assert.match(plan.stdout, /no pending releases/);
      const run = runGuard(dir, 'version');
      assert.equal(run.status, 0, run.stderr + run.stdout);
      assert.equal(version(dir), '0.1.0');
      assert.equal(fs.existsSync(path.join(dir, '.changeset', 'quiet.md')), false, 'Changesets consumed it');
    });
  }

  test('a Changesets that exits 0 without applying a changeset is refused, not trusted', () => {
    // Changesets 3.0.3 always consumes or rejects a changeset; this backstop
    // guards against a different or broken Changesets silently doing nothing.
    const dir = makeRepository('0.1.0', { feat: ['minor', 'Feature'] });
    fs.unlinkSync(path.join(dir, 'node_modules'));
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    const stub = path.join(dir, 'node_modules', '.bin', 'changeset');
    fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const plan = runGuard(dir, 'plan');
    assert.equal(plan.status, 1, plan.stdout + plan.stderr);
    assert.match(plan.stderr, /did not apply/);
    assert.match(plan.stderr, /feat\.md/);
  });

  // The documented deliberate step — raising MAXIMUM_RELEASE_MAJOR — must
  // actually permit that major, and only that one.
  /** The repository with its guard copied in and the ceiling raised to `ceiling`. */
  function withRaisedCeiling(dir, ceiling) {
    const text = fs.readFileSync(GUARD, 'utf8');
    const raised = text.replace('const MAXIMUM_RELEASE_MAJOR = 0;', `const MAXIMUM_RELEASE_MAJOR = ${ceiling};`);
    assert.notEqual(raised, text, 'control: the ceiling constant was found');
    const guardCopy = path.join(dir, 'release-guard.cjs');
    fs.writeFileSync(guardCopy, raised);
    return (...args) =>
      spawnSync(process.execPath, [guardCopy, ...args], { cwd: dir, encoding: 'utf8', env: { ...env, HOME: dir }, timeout: 120_000 });
  }

  test('raising the ceiling to 1 lets a major changeset release exactly 1.0.0', () => {
    const dir = makeRepository('0.4.2', { one: ['major', 'Stable API.'] });
    const guard1 = withRaisedCeiling(dir, 1);
    assert.equal(guard1('plan').status, 0);
    const run = guard1('version');
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.equal(version(dir), '1.0.0');
    assert.match(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), /## 1\.0\.0\n\n### Major Changes/);
    assert.equal(guard1('check-version').status, 0, 'the manual-publish backstop accepts 1.0.0 under the raised ceiling');
  });

  test('a raised ceiling of 1 still refuses 2.0.0, and its message is consistent', () => {
    const dir = makeRepository('1.3.0', { two: ['major', 'Breaking.'] });
    const guard1 = withRaisedCeiling(dir, 1);
    const run = guard1('version');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /1\.3\.0 -> 2\.0\.0/);
    assert.match(run.stderr, /2\.0\.0 or above/);
    assert.equal(version(dir), '1.3.0');
  });

  test('with the default ceiling the refusal names the version it blocks (no contradiction)', () => {
    const dir = makeRepository('0.0.0', { big: ['major', 'Breaking.'] });
    const run = runGuard(dir, 'version');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /0\.0\.0 -> 1\.0\.0/);
    assert.match(run.stderr, /1\.0\.0 or above/);
    assert.doesNotMatch(run.stderr, /2\.0\.0/);
  });

  test('`plan` (the CI check) passes a minor, refuses a major, and changes nothing', () => {
    const ok = makeRepository('0.1.0', { feat: ['minor', 'Feature'] });
    assert.equal(runGuard(ok, 'plan').status, 0);
    assert.equal(version(ok), '0.1.0');
    const bad = makeRepository('0.1.0', { big: ['major', 'Breaking'] });
    const refused = runGuard(bad, 'plan');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /major/);
  });
});

describe('this repository’s own release state', () => {
  test('its pending changesets pass the guard', () => {
    const run = spawnSync(process.execPath, [GUARD, 'plan'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 0, run.stderr + run.stdout);
  });

  test('Changesets is configured for this public package with a real changelog', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, '.changeset', 'config.json'), 'utf8'));
    assert.equal(config.changelog, '@changesets/cli/changelog');
    assert.equal(config.access, 'public');
    assert.equal(config.baseBranch, 'main');
    assert.equal(config.commit, false);
    assert.match(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), /^# sarif-to-comment\n/);
  });

  test('the initial sequence: while package.json is npm’s 0.0.0, the pending plan releases exactly 0.1.0', () => {
    if (PKG.version !== '0.0.0') return; // after the first `release:version`, this sequence is complete
    const { releases } = guard.computeReleasePlan(ROOT);
    assert.deepEqual(
      releases.map((r) => [r.name, r.type, r.oldVersion, r.newVersion]),
      [['sarif-to-comment', 'minor', '0.0.0', '0.1.0']],
    );
  });
});

// ===========================================================================
// Publish preflight against a registry (real npm CLI, local fake registry)
// ===========================================================================

describe('publish preflight (as the workflow runs it)', () => {
  /** Starts a registry that knows `versions` of sarif-to-comment (null: package absent; 'down': 500). */
  async function startRegistry(versions) {
    const server = http.createServer((req, res) => {
      if (versions === 'down') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"unavailable"}');
        return;
      }
      if (versions === null || !req.url.startsWith('/sarif-to-comment')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"Not found"}');
        return;
      }
      const all = Object.fromEntries(versions.map((v) => [v, { name: 'sarif-to-comment', version: v }]));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'sarif-to-comment', 'dist-tags': { latest: versions.at(-1) }, versions: all }));
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    return { server, url: `http://127.0.0.1:${server.address().port}/` };
  }

  /** A temp git repository on main holding a package release at `version`. */
  function makeRelease(version, { changelogVersion = version } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-preflight-'));
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git('init', '--quiet', '--initial-branch=main');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest(version), null, 2));
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog(changelogVersion));
    fs.mkdirSync(path.join(dir, '.changeset'));
    fs.writeFileSync(path.join(dir, '.changeset', 'config.json'), '{}');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'release');
    return { dir, sha: git('rev-parse', 'HEAD') };
  }

  /** Runs `release-guard publish-preflight` asynchronously (the registry lives in this process). */
  /** The real npm executable on this machine's PATH. */
  const REAL_NPM = spawnSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).stdout.trim();

  /**
   * A directory holding an `npm` shim that reports `version` for
   * `npm --version` and runs the real npm for everything else. The preflight's
   * tool-version rule is covered by the decidePublish tests; the shim keeps
   * these registry-behaviour tests independent of the npm bundled with the
   * Node running them (CI's Node 22 job bundles npm 10, which the guard
   * rightly refuses for publishing).
   */
  function npmReporting(version) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-shim-'));
    const shim = path.join(dir, 'npm');
    fs.writeFileSync(shim, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nexec "${REAL_NPM}" "$@"\n`, { mode: 0o755 });
    return dir;
  }

  function preflight(release, registryUrl, { npmVersion = guard.MIN_NPM } = {}) {
    const outputFile = path.join(release.dir, 'github-output');
    fs.writeFileSync(outputFile, '');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-home-'));
    fs.writeFileSync(path.join(work, 'npmrc'), '');
    const env = {
      PATH: `${npmReporting(npmVersion)}${path.delimiter}${process.env.PATH}`,
      HOME: work,
      GITHUB_SHA: release.sha,
      GITHUB_OUTPUT: outputFile,
      npm_config_registry: registryUrl,
      npm_config_cache: path.join(work, 'cache'),
      npm_config_userconfig: path.join(work, 'npmrc'),
      npm_config_update_notifier: 'false',
      npm_config_fetch_retries: '0',
    };
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [GUARD, 'publish-preflight', '--main-ref', 'main'], { cwd: release.dir, env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (status) => resolve({ status, stdout, stderr, output: fs.readFileSync(outputFile, 'utf8') }));
    });
  }

  test('an unpublished, Changesets-produced version is released: publish=true', async () => {
    const registry = await startRegistry(['0.0.0']);
    try {
      const run = await preflight(makeRelease('0.1.0'), registry.url);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.output, /^publish=true$/m);
    } finally {
      registry.server.close();
    }
  });

  test('an already-published version is skipped: publish=false, exit 0', async () => {
    const registry = await startRegistry(['0.0.0']);
    try {
      const run = await preflight(makeRelease('0.0.0', { changelogVersion: '0.0.0' }), registry.url);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.output, /^publish=false$/m);
    } finally {
      registry.server.close();
    }
  });

  test('a package npm has never seen may publish', async () => {
    const registry = await startRegistry(null);
    try {
      const run = await preflight(makeRelease('0.1.0'), registry.url);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.output, /^publish=true$/m);
    } finally {
      registry.server.close();
    }
  });

  test('version 1.0.0 is refused with exit 1 and no publish output', async () => {
    const registry = await startRegistry(['0.0.0']);
    try {
      const run = await preflight(makeRelease('1.0.0'), registry.url);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /1\.0\.0/);
      assert.doesNotMatch(run.output, /publish=true/);
    } finally {
      registry.server.close();
    }
  });

  test('control: the npm reported to the preflight is the one it judges (npm 10 is refused)', async () => {
    const registry = await startRegistry(['0.0.0']);
    try {
      const run = await preflight(makeRelease('0.1.0'), registry.url, { npmVersion: '10.9.4' });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /npm 10\.9\.4 is too old/);
      assert.doesNotMatch(run.output, /publish=true/);
    } finally {
      registry.server.close();
    }
  });

  test('an unreachable registry is a failure, never read as "unpublished"', async () => {
    const registry = await startRegistry('down');
    try {
      const run = await preflight(makeRelease('0.1.0'), registry.url);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /registry/i);
      assert.doesNotMatch(run.output, /publish=true/);
    } finally {
      registry.server.close();
    }
  });
});

describe('guard command line', () => {
  test('verify-pack accepts the intended files and names a leaked one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pack-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest()));
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify([packResult()]));
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify([packResult('0.1.0', ['logs/secret.txt'])]));
    assert.equal(spawnSync(process.execPath, [GUARD, 'verify-pack', 'good.json'], { cwd: dir }).status, 0);
    const bad = spawnSync(process.execPath, [GUARD, 'verify-pack', 'bad.json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /logs\/secret\.txt/);
  });

  /**
   * A minimal project at `version` whose dist/ is a complete, fresh build as
   * the build records it (the build-freshness manifest written last).
   */
  function builtProject(version) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-version-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest(version)));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'index.cjs'), "'use strict';\n");
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'index.cjs'), "'use strict';\n");
    const write = spawnSync(process.execPath, [MANIFEST_TOOL, 'write', dir], { encoding: 'utf8' });
    assert.equal(write.status, 0, write.stderr);
    return dir;
  }

  test('check-version (the manual-publish backstop) refuses 1.0.0 and accepts 0.x', () => {
    for (const [version, status] of [['0.1.0', 0], ['1.0.0', 1], ['1.0.0-rc.0', 1]]) {
      const dir = builtProject(version);
      const run = spawnSync(process.execPath, [GUARD, 'check-version'], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, status, `${version}: ${run.stderr}`);
    }
  });

  test('check-version refuses a missing or stale build, so a manual publish cannot ship outdated dist/', () => {
    const run = (dir) => spawnSync(process.execPath, [GUARD, 'check-version'], { cwd: dir, encoding: 'utf8' });

    const fresh = builtProject('0.1.0');
    assert.equal(run(fresh).status, 0, 'control: a fresh build is accepted');

    const unbuilt = builtProject('0.1.0');
    fs.rmSync(path.join(unbuilt, 'dist'), { recursive: true });
    const missing = run(unbuilt);
    assert.equal(missing.status, 1, 'no build');
    assert.match(missing.stderr, /pnpm run build/);

    const edited = builtProject('0.1.0');
    fs.appendFileSync(path.join(edited, 'src', 'index.cjs'), '// edited after the build\n');
    const stale = run(edited);
    assert.equal(stale.status, 1, 'a source changed after the build');
    assert.match(stale.stderr, /src\/index\.cjs/);
    assert.match(stale.stderr, /pnpm run build/);
  });

  test('an unknown command is a usage error', () => {
    assert.equal(spawnSync(process.execPath, [GUARD, 'publish']).status, 2);
  });
});

// ===========================================================================
// Scripts and workflows
// ===========================================================================

describe('package scripts', () => {
  const scripts = PKG.scripts || {};

  test('versioning goes through the guard; manual directory publishes hit the backstop', () => {
    assert.equal(scripts['release:version'], 'node scripts/release-guard.cjs version');
    assert.equal(scripts.prepublishOnly, 'node scripts/release-guard.cjs check-version');
    assert.equal(scripts['check:release'], 'node scripts/release-guard.cjs plan');
    assert.equal(Object.hasOwn(scripts, 'version'), false, 'no npm `version` lifecycle hook that bypasses Changesets');
  });

  test('no script publishes or runs an unguarded `changeset version`/`changeset publish`', () => {
    for (const [name, command] of Object.entries(scripts)) {
      assert.doesNotMatch(command, /\b(npm|pnpm) publish\b|changeset (publish|version)\b/, `${name}: ${command}`);
    }
  });

  test('check runs the release, API, type, lint and test checks read-only', () => {
    for (const part of ['check:release', 'check:api', 'check:types', 'check:lint']) {
      assert.ok(scripts.check.includes(part), `check must run ${part}`);
    }
    assert.match(scripts.check, /\btest\b/);
    for (const [name, command] of Object.entries(scripts)) {
      if (name === 'check' || name.startsWith('check:')) assert.doesNotMatch(command, /--fix\b|--write\b|--local\b/, name);
    }
  });
});

describe('publish workflow', () => {
  const file = path.join(ROOT, '.github', 'workflows', 'publish.yml');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const config = text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');

  test('exists under the filename npm trusts (publish.yml)', () => {
    assert.ok(text.length > 0);
  });

  test('runs only for main pushes that change package.json (the merged Changesets version)', () => {
    const on = /^on:\n((?: {2}.*\n|\n)+)/m.exec(config);
    assert.ok(on);
    assert.match(on[1], /^ {2}push:\n {4}branches: \[main\]\n {4}paths:\n {6}- package\.json\n/m);
    assert.doesNotMatch(on[1], /tags|pull_request|schedule|workflow_run|release:|workflow_dispatch/);
  });

  test('authenticates by OIDC only, with read-only contents and no npm token', () => {
    assert.match(config, /^permissions:\n {2}contents: read\n {2}id-token: write\n/m);
    assert.doesNotMatch(config, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.|_authToken/);
  });

  test('never overlaps or cancels a release; runs on a GitHub-hosted runner', () => {
    assert.match(config, /^concurrency:\n {2}group: publish\n {2}cancel-in-progress: false\n/m);
    assert.match(config, /runs-on: ubuntu-latest/);
  });

  test('decides first, then builds, checks, packs, verifies and publishes exactly the verified tarball', () => {
    // The build comes after the decision (nothing is built for a no-op run)
    // and before the check, so the check and the tarball both use exactly
    // the dist/ built from this commit. There is no prepack: what is packed
    // is what was checked.
    const order = [
      /fetch-depth: 0/,
      /pnpm install --frozen-lockfile/,
      /id: preflight\n\s+run: node scripts\/release-guard\.cjs publish-preflight/,
      /run: pnpm run build\n/,
      /run: pnpm run check\n/,
      /npm pack --json/,
      /node scripts\/release-guard\.cjs verify-pack/,
      /npm publish "\$\{\{ steps\.pack\.outputs\.tarball \}\}"/,
    ];
    let at = 0;
    for (const step of order) {
      const index = config.slice(at).search(step);
      assert.ok(index >= 0, `missing or out of order: ${step}`);
      at += index;
    }
    assert.equal((config.match(/npm publish/g) || []).length, 1);
    assert.equal((config.match(/pnpm run build/g) || []).length, 1);
    assert.equal(Object.hasOwn(PKG.scripts, 'prepack'), false, 'no prepack rebuilds between check and pack');
    assert.doesNotMatch(config, /changeset publish|changesets\/action/);
  });

  test('every step after the decision runs only when the preflight says publish', () => {
    const steps = config.split(/\n {6}- /).slice(1);
    const decisionAt = steps.findIndex((s) => /id: preflight/.test(s));
    assert.ok(decisionAt >= 0);
    for (const step of steps.slice(decisionAt + 1)) {
      assert.match(step, /if: steps\.preflight\.outputs\.publish == 'true'/, `ungated step: ${step.split('\n')[0]}`);
    }
  });

  test('Node 24 (bundled npm supports trusted publishing); no forced provenance; pinned actions', () => {
    assert.match(config, /node-version: 24/);
    assert.doesNotMatch(config, /--provenance|NPM_CONFIG_PROVENANCE/i);
    for (const ref of [...config.matchAll(/uses: (\S+)/g)].map((m) => m[1])) assert.match(ref, /@[0-9a-f]{40}$/, ref);
  });
});

describe('continuous integration workflow', () => {
  const file = path.join(ROOT, '.github', 'workflows', 'ci.yml');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  test('runs the full check (including the release plan) on main pushes and pull requests, read-only', () => {
    assert.match(text, /^ {2}push:\n {4}branches: \[main\]/m);
    assert.match(text, /^ {2}pull_request:/m);
    assert.match(text, /^permissions:\n {2}contents: read\n/m);
    assert.match(text, /pnpm install --frozen-lockfile/);
    assert.match(text, /pnpm run check/);
    assert.doesNotMatch(text, /npm publish|id-token|changeset publish/);
  });

  test('builds after installing and before checking, since the tests exercise the built dist/', () => {
    let at = 0;
    for (const step of [/run: pnpm install --frozen-lockfile\n/, /run: pnpm run build\n/, /run: pnpm run check\n/]) {
      const index = text.slice(at).search(step);
      assert.ok(index >= 0, `missing or out of order: ${step}`);
      at += index;
    }
  });
});

describe('the pnpm version the workflows install is a usable release', () => {
  // pnpm/action-setup installs exactly the pinned pnpm, and pnpm's installer
  // refuses a release its registry metadata marks as broken
  // (ERR_PNPM_BROKEN_PNPM_RELEASE): pinning pnpm 11.12.0 failed both CI and
  // publishing before any check ran. Registry facts are recorded in
  // test/fixtures/release/pnpm-releases.json (refresh with the commands it
  // lists when changing the pin) so this runs offline.
  const RELEASES = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'release', 'pnpm-releases.json'), 'utf8'));
  const WORKFLOWS = ['ci.yml', 'publish.yml'].map((name) => [
    name,
    fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8'),
  ]);

  /** The pnpm version a workflow passes to pnpm/action-setup. */
  function pinnedPnpm(text) {
    // The `with:` block may carry comment lines before `version:`.
    const match = /uses: pnpm\/action-setup@[0-9a-f]{40}[^\n]*\n\s+with:\n(?:\s*#[^\n]*\n)*\s+version: (\S+)\n/.exec(text);
    return match && match[1];
  }

  /** Why the recorded registry facts make `version` unusable as a pin (empty when usable). */
  function pinProblems(version) {
    const facts = RELEASES.releases[version];
    if (!facts) return [`no registry facts recorded for pnpm ${version}`];
    const problems = [];
    if (facts.pnpmDeprecated) problems.push(`pnpm@${version} is deprecated: ${facts.pnpmDeprecated}`);
    if (!facts.exePublished) problems.push(`@pnpm/exe@${version} is not published`);
    if (facts.exeDeprecated) problems.push(`@pnpm/exe@${version} is deprecated: ${facts.exeDeprecated}`);
    return problems;
  }

  test('control: the pin that broke CI (11.12.0) is recognised as broken', () => {
    assert.match(pinProblems('11.12.0').join(' '), /broken/);
  });

  test('both workflows pin the same exact pnpm version', () => {
    const pins = WORKFLOWS.map(([name, text]) => [name, pinnedPnpm(text)]);
    for (const [name, pin] of pins) assert.match(pin || '', /^\d+\.\d+\.\d+$/, `${name} pins an exact version`);
    assert.equal(new Set(pins.map(([, pin]) => pin)).size, 1, JSON.stringify(pins));
  });

  test('the pinned pnpm is neither broken nor deprecated, for pnpm and @pnpm/exe', () => {
    const pin = pinnedPnpm(WORKFLOWS[0][1]);
    assert.deepEqual(pinProblems(pin), []);
  });

  test('the pinned pnpm supports every Node version the workflows use', () => {
    const pin = pinnedPnpm(WORKFLOWS[0][1]);
    assert.equal(RELEASES.releases[pin].nodeEngine, '>=22.13');
    // CI runs Node 22 and 24 (setup-node resolves the latest release of each
    // major, which satisfies >=22.13); publishing runs Node 24.
    assert.match(WORKFLOWS[0][1], /node: \[22, 24\]/);
    assert.match(WORKFLOWS[1][1], /node-version: 24/);
  });

  test('the pin stays on the major the lockfile was produced and verified with', () => {
    const pin = pinnedPnpm(WORKFLOWS[0][1]);
    assert.equal(pin.split('.')[0], '11');
    assert.match(fs.readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8'), /^lockfileVersion: '9\.0'/);
  });
});

describe('superseded tag-triggered release machinery is gone', () => {
  test('the guard no longer offers the tag preflight', () => {
    assert.equal(guard.checkRelease, undefined);
    const run = spawnSync(process.execPath, [GUARD, 'preflight'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
  });
});
