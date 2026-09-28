#!/usr/bin/env node
'use strict';

/**
 * Release guard: Changesets versioning with a hard major-version ceiling, and
 * the publish decision for npm trusted publishing.
 *
 * Releases of sarif-to-comment are versioned only by Changesets and published
 * only by .github/workflows/publish.yml. This guard sits at every point where
 * a version could be created or published and refuses anything that would
 * take the package to MAXIMUM_RELEASE_MAJOR + 1 (currently 1.0.0) or higher —
 * including prereleases such as 1.0.0-rc.0. A major bump that would cross the
 * ceiling is refused with an explanation and left as written; it is never
 * converted to a smaller bump. Raising the ceiling is a deliberate, reviewed
 * change to this file (and to test/release.test.cjs, which pins it), and it is
 * sufficient: a major changeset then releases exactly the permitted major.
 * The plan is always Changesets' own result (see computeReleasePlan); this
 * guard never interprets changeset front matter itself.
 *
 * Commands (exit 0 allowed, 1 refused with reasons on stderr, 2 usage):
 *   plan                 CI check (`pnpm run check:release`): the pending
 *                        changesets' release plan (computed by running the
 *                        real `changeset version` in a throwaway copy) stays
 *                        under the ceiling and Changesets pre mode is off.
 *                        Changes nothing in the project.
 *   version              `pnpm run release:version`: `plan`, then
 *                        `changeset version`, then re-checks the result.
 *                        Nothing is modified when the plan is refused.
 *   publish-preflight [--main-ref REF]
 *                        publish.yml: decides whether package.json's version
 *                        must be published. Already on npm: no-op
 *                        (publish=false). Otherwise it must be stable, under
 *                        the ceiling, produced by Changesets (newest CHANGELOG
 *                        entry), outside pre mode, publishable with the exact
 *                        repository URL, run with npm >= 11.5.1 and Node >=
 *                        22.18.0 (see MIN_NODE), from a commit on main
 *                        (default origin/main). Writes publish=true or
 *                        publish=false to $GITHUB_OUTPUT. An unreachable
 *                        registry is a failure, never "unpublished".
 *   verify-pack PACK_JSON
 *                        publish.yml: the `npm pack --json` result is exactly
 *                        the distribution boundary, named and versioned as
 *                        package.json says.
 *   check-version        prepublishOnly backstop for a manual directory
 *                        publish: package.json is stable, under the ceiling
 *                        and publishable, and dist/ is a complete build of
 *                        the current sources (scripts/build-manifest.mts), so
 *                        a missing or stale build is never published.
 *
 * @see https://changesets.dev/guide/cli
 * @see https://docs.npmjs.com/trusted-publishers/
 * @see https://semver.org/spec/v2.0.0.html
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * The highest major version this project may release. 0 means every release
 * stays below 1.0.0. Raise it only as a deliberate decision to ship 1.0.
 */
const MAXIMUM_RELEASE_MAJOR = 0;

/** The package this repository releases. */
const PACKAGE_NAME = 'sarif-to-comment';

/** repository.url must equal this exactly for npm to accept the OIDC identity. */
const EXPECTED_REPOSITORY_URL = 'git+https://github.com/mike-north/sarif-to-comment.git';

/** Minimum npm version npm documents for trusted publishing. */
const MIN_NPM = '11.5.1';

/**
 * Minimum Node version for a release. Trusted publishing needs 22.14.0, but
 * the release also runs the TypeScript build tooling (scripts/*.mts) through
 * Node's native type stripping, which first works without flags or warnings
 * in 22.18.0; requiring it here explains a too-old runner up front instead of
 * letting the build fail on syntax. Consumers of the package are unaffected
 * (package.json engines stays >=22).
 */
const MIN_NODE = '22.18.0';

/** The build-freshness checker (scripts/build-manifest.mts). */
const BUILD_MANIFEST_TOOL = path.join(__dirname, 'build-manifest.mts');

/** A stable semantic version: MAJOR.MINOR.PATCH without prerelease or build. */
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Any semantic version (prerelease and build allowed); captures the major. */
const ANY_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Where Changesets keeps its pre-mode state. */
const PRE_MODE_FILE = path.join('.changeset', 'pre.json');

/**
 * Built files in dist/ that carry no runtime content and never ship: the
 * runtime output of the declaration-only public API entry and of the
 * type-only public types module.
 */
const NON_RUNTIME_OUTPUTS = ['dist/public-api.cjs', 'dist/public-types.cjs'];

/**
 * Whether a packed path is inside the distribution boundary: the built
 * runtime (flat dist/*.cjs, including the executable), the rolled-up public
 * declarations, vendored schema, README, CHANGELOG, an optional LICENSE, the
 * getting-started guide and the generated API reference. Sources, nested
 * build directories, per-module declarations, source maps, build info and
 * the build-freshness manifest are outside it.
 */
function isDistributable(file) {
  return (
    file === 'package.json' ||
    file === 'README.md' ||
    file === 'CHANGELOG.md' ||
    /^LICENSE(\.md|\.txt)?$/.test(file) ||
    (/^dist\/[^/]+\.cjs$/.test(file) && !NON_RUNTIME_OUTPUTS.includes(file)) ||
    file === 'dist/sarif-to-comment.d.ts' ||
    /^vendor\/[^/]+$/.test(file) ||
    file === 'docs/getting-started.md' ||
    /^docs\/api\/[^/]+\.md$/.test(file)
  );
}

/** Files every release must contain for the library, types, CLI and docs to work. */
const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'dist/sarif-to-comment.cjs',
  'dist/index.cjs',
  'dist/sarif-to-comment.d.ts',
  'vendor/sarif-schema-2.1.0.json',
  'docs/getting-started.md',
  'docs/api/index.md',
];

// ---------------------------------------------------------------------------
// Version rules
// ---------------------------------------------------------------------------

/** Numeric [major, minor, patch] of a version like "v22.14.0" or "11.5.1", or null. */
function versionParts(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  return match ? match.slice(1, 4).map(Number) : null;
}

/** Whether `version` is at least `minimum`, comparing numerically. */
function atLeast(version, minimum) {
  const have = versionParts(version);
  const need = versionParts(minimum);
  if (!have) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

/** The deliberate step that permits a higher major, named in every refusal. */
const RAISE_INSTRUCTIONS =
  'until MAXIMUM_RELEASE_MAJOR in scripts/release-guard.cjs (and the test in test/release.test.cjs that pins it) is deliberately raised';

/**
 * Why `version` may not be released under this policy (empty when it may):
 * it must be a stable semantic version whose major is at most `ceiling`.
 */
function versionProblems(version, what, ceiling = MAXIMUM_RELEASE_MAJOR) {
  const text = String(version ?? '');
  const match = ANY_SEMVER.exec(text);
  if (!match) return [`${what} ${JSON.stringify(version)} is not a semantic version.`];
  const problems = [];
  if (Number(match[1]) > ceiling) {
    problems.push(`${what} ${text} is ${ceiling + 1}.0.0 or higher; releases at ${ceiling + 1}.0.0 or above are blocked ${RAISE_INSTRUCTIONS}.`);
  }
  if (!STABLE_SEMVER.test(text)) {
    problems.push(`${what} ${text} is a prerelease or has build metadata; only stable versions are released.`);
  }
  return problems;
}

/** Why the manifest cannot be published by the trusted publisher (empty when it can). */
function manifestProblems(packageJson) {
  const problems = [];
  if (packageJson.private === true) problems.push('package.json is private: true, so it cannot be published.');
  if (packageJson.name !== PACKAGE_NAME) {
    problems.push(`package.json name must be ${PACKAGE_NAME}, not ${JSON.stringify(packageJson.name)}.`);
  }
  const repository = packageJson.repository;
  if (typeof repository !== 'object' || repository === null || repository.url !== EXPECTED_REPOSITORY_URL) {
    problems.push(
      `package.json repository.url must be exactly ${EXPECTED_REPOSITORY_URL} (npm trusted publishing requires it); found ${JSON.stringify(repository)}.`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Checks (pure; the command line gathers the facts)
// ---------------------------------------------------------------------------

/**
 * Every reason a Changesets release plan may not be versioned (empty when it
 * may). `plan` is the result of computeReleasePlan: the version and change
 * type Changesets itself produces when `changeset version` is rehearsed in a
 * throwaway copy of the project.
 *
 * A major release is judged by where it lands, not refused by type: it is
 * allowed exactly when its new version's major is within the ceiling, so
 * raising MAXIMUM_RELEASE_MAJOR is sufficient (and the only step) to permit it.
 *
 * @param {{ releases: {name: string, type: string, oldVersion: string, newVersion: string}[] }} plan
 * @param {{ preMode: boolean, ceiling?: number }} state (`ceiling` defaults to MAXIMUM_RELEASE_MAJOR)
 * @returns {string[]}
 */
function checkReleasePlan(plan, { preMode, ceiling = MAXIMUM_RELEASE_MAJOR }) {
  const problems = [];
  if (preMode) {
    problems.push(
      `Changesets pre mode is active (${PRE_MODE_FILE}); prereleases are not part of this release path. Run \`changeset pre exit\`.`,
    );
  }
  for (const release of (plan && plan.releases) || []) {
    if (release.name !== PACKAGE_NAME) {
      problems.push(`The release plan includes ${release.name}, which this repository does not release.`);
      continue;
    }
    const aboveCeiling = (versionParts(release.newVersion) || [Infinity])[0] > ceiling;
    if (release.type === 'major' && aboveCeiling) {
      problems.push(
        `A pending changeset requests a major release of ${PACKAGE_NAME} (${release.oldVersion} -> ${release.newVersion}). ` +
          `Releases at ${ceiling + 1}.0.0 or above are blocked ${RAISE_INSTRUCTIONS}. ` +
          'The changeset is left exactly as written and is not converted; if this change should not start a new major version, change it to "minor" yourself.',
      );
      continue;
    }
    problems.push(...versionProblems(release.newVersion, `The planned version of ${PACKAGE_NAME}`, ceiling));
  }
  return problems;
}

/**
 * Whether package.json's version must be published, and every reason it may
 * not be (publish is true only when there are none). A version already on npm
 * is a no-op, but a version above the ceiling is always reported.
 *
 * @param {{ packageJson: object, changelog?: string, publishedVersions: string[],
 *           preMode: boolean, npmVersion?: string, nodeVersion?: string, onMain: boolean,
 *           ceiling?: number }} facts (`ceiling` defaults to MAXIMUM_RELEASE_MAJOR)
 * @returns {{ publish: boolean, problems: string[] }}
 */
function decidePublish(facts) {
  const { packageJson, changelog, publishedVersions, preMode, npmVersion, nodeVersion, onMain } = facts;
  const version = packageJson.version;
  const ceiling = versionProblems(version, 'package.json version', facts.ceiling ?? MAXIMUM_RELEASE_MAJOR);
  if (publishedVersions.includes(version)) return { publish: false, problems: ceiling };

  const problems = [...ceiling, ...manifestProblems(packageJson)];
  const newest = /^## (\S+)\s*$/m.exec(changelog ?? '');
  if (!newest || newest[1] !== version) {
    problems.push(
      `CHANGELOG.md's newest entry is ${newest ? newest[1] : 'missing'}, not ${version}; versions are produced by \`pnpm run release:version\` (Changesets).`,
    );
  }
  if (preMode) problems.push(`Changesets pre mode is active (${PRE_MODE_FILE}); prereleases are not published.`);
  if (!atLeast(npmVersion, MIN_NPM)) problems.push(`npm ${npmVersion} is too old; trusted publishing needs npm >= ${MIN_NPM}.`);
  if (!atLeast(nodeVersion, MIN_NODE)) {
    problems.push(`Node ${nodeVersion} is too old; releasing needs Node >= ${MIN_NODE} (the build tooling runs TypeScript by type stripping).`);
  }
  if (!onMain) problems.push('The commit is not on main; only commits on main are released.');
  return { publish: problems.length === 0, problems };
}

/**
 * Every reason a packed tarball is not exactly the intended distribution.
 *
 * @param {{ name: string, version: string, files: {path: string}[] }} pack one `npm pack --json` entry
 * @param {object} packageJson the manifest being released
 * @returns {string[]}
 */
function checkPackedTarball(pack, packageJson) {
  if (!pack || !Array.isArray(pack.files)) return ['The pack result lists no files.'];
  const problems = [];
  if (pack.name !== packageJson.name) problems.push(`The tarball is named ${pack.name}, not ${packageJson.name}.`);
  if (pack.version !== packageJson.version) problems.push(`The tarball is version ${pack.version}, not ${packageJson.version}.`);
  const files = pack.files.map((f) => f.path);
  for (const file of files) {
    if (!isDistributable(file)) problems.push(`The tarball contains ${file}, which is outside the distribution boundary.`);
  }
  for (const file of REQUIRED_FILES) {
    if (!files.includes(file)) problems.push(`The tarball is missing ${file}.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Facts from the working directory, git, Changesets and npm
// ---------------------------------------------------------------------------

/** A refusal carrying every reason, reported as a list; never an internal failure. */
class RefusedError extends Error {
  constructor(problems) {
    const list = [].concat(problems);
    super(list.join(' '));
    this.problems = list;
  }
}

function readManifest() {
  return JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
}

function readOptional(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

/** The Changesets CLI installed in `projectDir`. */
function changeset(args, { projectDir = process.cwd(), ...options } = {}) {
  const bin = path.join(projectDir, 'node_modules', '.bin', 'changeset');
  return spawnSync(bin, args, { cwd: projectDir, encoding: 'utf8', ...options });
}

/** Names (without .md) of the pending changeset files in `dir`. */
function changesetFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => f.replace(/\.md$/, ''));
}

/** Changesets' changelog section headings, strongest first. */
const CHANGE_SECTIONS = [
  ['major', '### Major Changes'],
  ['minor', '### Minor Changes'],
  ['patch', '### Patch Changes'],
];

/**
 * The bump Changesets applied, read from the changelog entry it wrote for
 * `newVersion` (its "### Major/Minor/Patch Changes" sections).
 */
function appliedBump(changelog, newVersion) {
  const escaped = newVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = new RegExp(`^## ${escaped}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(changelog || '');
  const body = entry ? entry[1] : '';
  const found = CHANGE_SECTIONS.find(([, heading]) => body.includes(heading));
  return found ? found[0] : undefined;
}

/**
 * The release plan of the pending changesets, as Changesets itself reads
 * them. Whenever any changeset file exists, the real `changeset version` runs
 * in a throwaway directory holding copies of package.json, CHANGELOG.md and
 * .changeset/ (node_modules linked); the plan is the version it writes and
 * the change type of the changelog entry it writes. Changeset front matter is
 * never interpreted by this guard, so any YAML Changesets accepts (quoted
 * values, spacing, ordering) is judged by its actual effect. A changeset that
 * Changesets rejects, or leaves unconsumed, is refused rather than ignored.
 * (`changeset status` is not used: in Changesets 3 it reports only
 * changesets added since a git ref, so on main it cannot see pending ones.)
 *
 * @returns {{ changesets: string[], releases: {name: string, type: string, oldVersion: string, newVersion: string}[] }}
 */
function computeReleasePlan(projectDir = process.cwd()) {
  const changesets = changesetFiles(path.join(projectDir, '.changeset'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  if (changesets.length === 0) return { changesets, releases: [] };

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-'));
  try {
    fs.copyFileSync(path.join(projectDir, 'package.json'), path.join(sandbox, 'package.json'));
    if (fs.existsSync(path.join(projectDir, 'CHANGELOG.md'))) {
      fs.copyFileSync(path.join(projectDir, 'CHANGELOG.md'), path.join(sandbox, 'CHANGELOG.md'));
    }
    fs.cpSync(path.join(projectDir, '.changeset'), path.join(sandbox, '.changeset'), { recursive: true });
    fs.symlinkSync(fs.realpathSync(path.join(projectDir, 'node_modules')), path.join(sandbox, 'node_modules'), 'dir');
    const run = changeset(['version'], { projectDir: sandbox });
    if (run.status !== 0) {
      throw new RefusedError(`\`changeset version\` could not read the pending changesets (exit ${run.status}): ${(run.stderr || run.stdout || '').trim()}`);
    }
    const unconsumed = changesetFiles(path.join(sandbox, '.changeset')).filter((id) => changesets.includes(id));
    if (unconsumed.length > 0) {
      throw new RefusedError(
        `Changesets did not apply the pending changeset(s) ${unconsumed.map((id) => `.changeset/${id}.md`).join(', ')}; fix or remove them.`,
      );
    }
    const newVersion = JSON.parse(fs.readFileSync(path.join(sandbox, 'package.json'), 'utf8')).version;
    if (newVersion === packageJson.version) return { changesets, releases: [] };
    const type = appliedBump(readOptional(path.join(sandbox, 'CHANGELOG.md')), newVersion);
    if (!type) {
      throw new RefusedError(`Changesets versioned ${packageJson.name} ${newVersion} without a changelog entry; the release plan cannot be judged.`);
    }
    return { changesets, releases: [{ name: packageJson.name, type, oldVersion: packageJson.version, newVersion }] };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

/** Versions of this package on the configured registry; [] when npm has never seen it. */
function publishedVersions(name) {
  const run = spawnSync('npm', ['view', name, 'versions', '--json'], { encoding: 'utf8' });
  let parsed;
  try {
    parsed = JSON.parse(run.stdout || 'null');
  } catch {
    parsed = null;
  }
  if (run.status === 0) {
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return [parsed];
    return [];
  }
  const code = (parsed && parsed.error && parsed.error.code) || '';
  if (code === 'E404' || /\bE404\b/.test(run.stderr || '')) return [];
  throw new RefusedError(
    `The npm registry could not be queried for ${name} (${code || `exit ${run.status}`}); whether this version is already published is unknown.`,
  );
}

/** Whether `sha` is a commit reachable from `mainRef`; unknown commits are not. */
function isOnMain(sha, mainRef) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return false;
  return spawnSync('git', ['merge-base', '--is-ancestor', sha, mainRef]).status === 0;
}

/**
 * Why dist/ in `projectDir` is not a complete build of its current sources
 * (empty when it is), as scripts/build-manifest.mts judges it.
 */
function buildProblems(projectDir = process.cwd()) {
  const run = spawnSync(process.execPath, [BUILD_MANIFEST_TOOL, 'verify', projectDir], { encoding: 'utf8' });
  if (run.status === 0) return [];
  const detail = `${run.stderr || ''}${run.stdout || ''}`.trim() || `exit ${run.status}`;
  return [`dist/ is not a fresh build; run \`pnpm run build\` before publishing. ${detail}`];
}

function npmVersion() {
  const run = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function refuse(problems) {
  process.stderr.write(`Release refused:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  return 1;
}

/** Refuses (throws) unless the pending plan is within policy; returns the plan. */
function requireAllowedPlan() {
  const plan = computeReleasePlan();
  const problems = checkReleasePlan(plan, { preMode: fs.existsSync(PRE_MODE_FILE) });
  if (problems.length > 0) throw new RefusedError(problems);
  return plan;
}

const COMMANDS = {
  plan() {
    const plan = requireAllowedPlan();
    const summary = plan.releases.map((r) => `${r.name} ${r.oldVersion} -> ${r.newVersion} (${r.type})`).join(', ');
    process.stdout.write(`Release plan allowed: ${summary || 'no pending releases'}.\n`);
    return 0;
  },

  version() {
    const plan = requireAllowedPlan();
    // Any pending changeset is applied, as `changeset version` would: one that
    // requests no release ("none" or empty) is consumed without a new version.
    if (plan.changesets.length === 0) {
      process.stdout.write('No pending changesets; nothing to version.\n');
      return 0;
    }
    const run = changeset(['version'], { stdio: 'inherit' });
    if (run.status !== 0) throw new RefusedError([`\`changeset version\` failed (exit ${run.status}).`]);
    const packageJson = readManifest();
    const problems = versionProblems(packageJson.version, 'The new package.json version');
    if (problems.length > 0) {
      throw new RefusedError([...problems, 'Discard the changes `changeset version` made before committing.']);
    }
    process.stdout.write(
      plan.releases.length > 0
        ? `Versioned ${packageJson.name} ${packageJson.version}. Review, commit and merge to main to release it.\n`
        : `Applied changesets that request no release; ${packageJson.name} stays ${packageJson.version}. Commit the result.\n`,
    );
    return 0;
  },

  'publish-preflight'(args) {
    let mainRef = 'origin/main';
    if (args.length === 2 && args[0] === '--main-ref') mainRef = args[1];
    else if (args.length !== 0) return usage();
    const packageJson = readManifest();
    const decision = decidePublish({
      packageJson,
      changelog: readOptional('CHANGELOG.md'),
      publishedVersions: publishedVersions(packageJson.name),
      preMode: fs.existsSync(PRE_MODE_FILE),
      npmVersion: npmVersion(),
      nodeVersion: process.version,
      onMain: isOnMain(process.env.GITHUB_SHA, mainRef),
    });
    if (decision.problems.length > 0) throw new RefusedError(decision.problems);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `publish=${decision.publish}\n`);
    process.stdout.write(
      decision.publish
        ? `${packageJson.name}@${packageJson.version} is not on npm yet and may be published.\n`
        : `${packageJson.name}@${packageJson.version} is already on npm; nothing to publish.\n`,
    );
    return 0;
  },

  'verify-pack'(args) {
    if (args.length !== 1) return usage();
    const [pack] = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    const problems = checkPackedTarball(pack, readManifest());
    if (problems.length > 0) throw new RefusedError(problems);
    process.stdout.write(`Verified ${pack.filename}: ${pack.files.length} files, all inside the distribution boundary.\n`);
    return 0;
  },

  'check-version'() {
    const packageJson = readManifest();
    const problems = [
      ...versionProblems(packageJson.version, 'package.json version'),
      ...manifestProblems(packageJson),
      ...buildProblems(),
    ];
    if (problems.length > 0) throw new RefusedError(problems);
    return 0;
  },
};

function usage() {
  process.stderr.write(
    'Usage: release-guard.cjs plan | version | publish-preflight [--main-ref REF] | verify-pack PACK_JSON | check-version\n',
  );
  return 2;
}

function main(argv) {
  const [command, ...args] = argv;
  if (!Object.hasOwn(COMMANDS, command)) return usage();
  try {
    return COMMANDS[command](args);
  } catch (err) {
    if (err instanceof RefusedError) return refuse(err.problems);
    throw err;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  checkReleasePlan,
  computeReleasePlan,
  decidePublish,
  checkPackedTarball,
  isDistributable,
  REQUIRED_FILES,
  MAXIMUM_RELEASE_MAJOR,
  EXPECTED_REPOSITORY_URL,
  MIN_NPM,
  MIN_NODE,
};
