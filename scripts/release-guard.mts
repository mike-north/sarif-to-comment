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
 * change to this file (and to test/release.test.mts, which pins it), and it is
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
 *                        the distribution boundary (isDistributable, which
 *                        mirrors package.json `files`), contains every
 *                        REQUIRED_FILES entry, and is named and versioned as
 *                        package.json says.
 *   check-version        prepublishOnly backstop for a manual directory
 *                        publish: package.json is stable, under the ceiling
 *                        and publishable, and dist/ is a complete build of
 *                        the current sources (scripts/build-manifest.mts), so
 *                        a missing or stale build is never published.
 *
 * Node version: this file is TypeScript that Node runs by type stripping,
 * which works without flags from 22.18.0. An older Node cannot load it at
 * all (22.6-22.17 refuse the .mts file unless started with
 * --experimental-strip-types), so no rule here can explain that case: in
 * this checkout package.json devEngines (runtime node >=22.18.0, onFail
 * error) makes npm and pnpm refuse the older Node first, and publish.yml runs
 * Node 24. Wherever the guard does run on an older Node (22.6-22.17 with the
 * flag), publish-preflight refuses it with its own explanation (MIN_NODE),
 * and the entry-point check below deliberately avoids import.meta.main,
 * which those versions lack and which would make the guard exit silently.
 *
 * @see https://changesets.dev/guide/cli
 * @see https://docs.npmjs.com/trusted-publishers/
 * @see https://semver.org/spec/v2.0.0.html
 */

import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns, StdioOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The package.json fields the guard judges. Every field is `unknown` because
 * the manifest is read from disk and each rule checks what it relies on;
 * other fields are kept.
 */
export interface IPackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly private?: unknown;
  readonly repository?: unknown;
  readonly [field: string]: unknown;
}

/** One package release in a Changesets release plan. */
export interface IPlannedRelease {
  readonly name: string;
  readonly type: string;
  readonly oldVersion: string;
  readonly newVersion: string;
}

/** A Changesets release plan (see computeReleasePlan). */
export interface IReleasePlan {
  readonly changesets?: readonly unknown[] | undefined;
  readonly releases: readonly IPlannedRelease[];
}

/** The plan computeReleasePlan returns: pending changeset names and the release they produce. */
export interface IComputedReleasePlan extends IReleasePlan {
  readonly changesets: string[];
  readonly releases: IPlannedRelease[];
}

/** Facts decidePublish judges (the command line gathers them). */
export interface IPublishFacts {
  readonly packageJson: IPackageManifest;
  readonly changelog?: string | undefined;
  readonly publishedVersions: readonly string[];
  readonly preMode: boolean;
  readonly npmVersion?: string | undefined;
  readonly nodeVersion?: string | undefined;
  readonly onMain: boolean;
  readonly ceiling?: number | undefined;
}

/** The publish decision: publish is true only when there are no problems. */
export interface IPublishDecision {
  readonly publish: boolean;
  readonly problems: string[];
}

/** A plain JSON object (not null, not an array). */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The highest major version this project may release. 0 means every release
 * stays below 1.0.0. Raise it only as a deliberate decision to ship 1.0.
 */
export const MAXIMUM_RELEASE_MAJOR = 0;

/** The package this repository releases. */
const PACKAGE_NAME = 'sarif-to-comment';

/** repository.url must equal this exactly for npm to accept the OIDC identity. */
export const EXPECTED_REPOSITORY_URL = 'git+https://github.com/mike-north/sarif-to-comment.git';

/** Minimum npm version npm documents for trusted publishing. */
export const MIN_NPM = '11.5.1';

/**
 * Minimum Node version for a release. Trusted publishing needs 22.14.0, but
 * the release also runs the TypeScript build tooling (scripts/*.mts) through
 * Node's native type stripping, which first works without flags or warnings
 * in 22.18.0; requiring it here explains a too-old runner up front instead of
 * letting the build fail on syntax. Consumers of the package are unaffected
 * (package.json engines stays >=22).
 */
export const MIN_NODE = '22.18.0';

/** The build-freshness checker (scripts/build-manifest.mts). */
const BUILD_MANIFEST_TOOL = path.join(import.meta.dirname, 'build-manifest.mts');

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
const NON_RUNTIME_OUTPUTS: readonly string[] = ['dist/public-api.cjs', 'dist/public-types.cjs'];

/**
 * Whether a packed path is inside the distribution boundary: the built
 * runtime (flat dist/*.cjs, including the executable), the rolled-up public
 * declarations, vendored schema, README, CHANGELOG, an optional LICENSE, the
 * getting-started guide, the diagnostics catalog (docs/diagnostics.md) and
 * the JSON Schema of the diagnostic shape it documents
 * (docs/diagnostic.v1.schema.json), and the generated API reference.
 * Sources, nested build directories, per-module declarations, source maps,
 * build info, the build-freshness manifest and every other docs/ file are
 * outside it.
 *
 * This mirrors the package.json `files` whitelist: a file added there must be
 * added here too, or publish.yml's `verify-pack` refuses the release
 * (test/package.test.mts verifies a real pack of the checkout this way).
 */
export function isDistributable(file: string): boolean {
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

/**
 * Files every release must contain for the library, types, CLI and docs to
 * work, including the diagnostics catalog and its JSON Schema, which the
 * README links on unpkg.
 */
export const REQUIRED_FILES: readonly string[] = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'dist/sarif-to-comment.cjs',
  'dist/index.cjs',
  'dist/sarif-to-comment.d.ts',
  'vendor/sarif-schema-2.1.0.json',
  'docs/getting-started.md',
  'docs/diagnostics.md',
  'docs/diagnostic.v1.schema.json',
  'docs/api/index.md',
];

// ---------------------------------------------------------------------------
// Version rules
// ---------------------------------------------------------------------------

/** Numeric [major, minor, patch] of a version like "v22.14.0" or "11.5.1", or null. */
function versionParts(version: string | undefined): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `version` is at least `minimum`, comparing numerically. */
function atLeast(version: string | undefined, minimum: string): boolean {
  const have = versionParts(version);
  const need = versionParts(minimum);
  if (!have || !need) return false;
  for (const i of [0, 1, 2] as const) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

/** The deliberate step that permits a higher major, named in every refusal. */
const RAISE_INSTRUCTIONS =
  'until MAXIMUM_RELEASE_MAJOR in scripts/release-guard.mts (and the test in test/release.test.mts that pins it) is deliberately raised';

/**
 * Why `version` may not be released under this policy (empty when it may):
 * it must be a stable semantic version whose major is at most `ceiling`.
 */
function versionProblems(version: unknown, what: string, ceiling: number = MAXIMUM_RELEASE_MAJOR): string[] {
  const text = typeof version === 'string' ? version : '';
  const match = ANY_SEMVER.exec(text);
  if (!match) return [`${what} ${JSON.stringify(version)} is not a semantic version.`];
  const problems: string[] = [];
  if (Number(match[1]) > ceiling) {
    const blocked = String(ceiling + 1);
    problems.push(`${what} ${text} is ${blocked}.0.0 or higher; releases at ${blocked}.0.0 or above are blocked ${RAISE_INSTRUCTIONS}.`);
  }
  if (!STABLE_SEMVER.test(text)) {
    problems.push(`${what} ${text} is a prerelease or has build metadata; only stable versions are released.`);
  }
  return problems;
}

/** Why the manifest cannot be published by the trusted publisher (empty when it can). */
function manifestProblems(packageJson: IPackageManifest): string[] {
  const problems: string[] = [];
  if (packageJson.private === true) problems.push('package.json is private: true, so it cannot be published.');
  if (packageJson.name !== PACKAGE_NAME) {
    problems.push(`package.json name must be ${PACKAGE_NAME}, not ${JSON.stringify(packageJson.name)}.`);
  }
  const repository = packageJson.repository;
  // An array is an object too: like any value without a matching url it is refused.
  if (typeof repository !== 'object' || repository === null || Reflect.get(repository, 'url') !== EXPECTED_REPOSITORY_URL) {
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
 * @param plan - the releases the pending changesets produce
 * @param state - pre mode, and `ceiling` (defaults to MAXIMUM_RELEASE_MAJOR)
 * @returns every reason, empty when the plan may be versioned
 */
export function checkReleasePlan(
  plan: IReleasePlan,
  { preMode, ceiling = MAXIMUM_RELEASE_MAJOR }: { readonly preMode: boolean; readonly ceiling?: number | undefined },
): string[] {
  const problems: string[] = [];
  if (preMode) {
    problems.push(
      `Changesets pre mode is active (${PRE_MODE_FILE}); prereleases are not part of this release path. Run \`changeset pre exit\`.`,
    );
  }
  for (const release of plan.releases) {
    if (release.name !== PACKAGE_NAME) {
      problems.push(`The release plan includes ${release.name}, which this repository does not release.`);
      continue;
    }
    const aboveCeiling = (versionParts(release.newVersion) ?? [Infinity])[0] > ceiling;
    if (release.type === 'major' && aboveCeiling) {
      problems.push(
        `A pending changeset requests a major release of ${PACKAGE_NAME} (${release.oldVersion} -> ${release.newVersion}). ` +
          `Releases at ${String(ceiling + 1)}.0.0 or above are blocked ${RAISE_INSTRUCTIONS}. ` +
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
 * @param facts - what the command line gathered (`ceiling` defaults to MAXIMUM_RELEASE_MAJOR)
 */
export function decidePublish(facts: IPublishFacts): IPublishDecision {
  const { packageJson, changelog, publishedVersions, preMode, npmVersion, nodeVersion, onMain } = facts;
  const version = packageJson.version;
  const ceiling = versionProblems(version, 'package.json version', facts.ceiling ?? MAXIMUM_RELEASE_MAJOR);
  if (typeof version === 'string' && publishedVersions.includes(version)) return { publish: false, problems: ceiling };

  const problems = [...ceiling, ...manifestProblems(packageJson)];
  const newest = /^## (\S+)\s*$/m.exec(changelog ?? '');
  if (!newest || newest[1] !== version) {
    problems.push(
      `CHANGELOG.md's newest entry is ${newest?.[1] ?? 'missing'}, not ${String(version)}; versions are produced by \`pnpm run release:version\` (Changesets).`,
    );
  }
  if (preMode) problems.push(`Changesets pre mode is active (${PRE_MODE_FILE}); prereleases are not published.`);
  if (!atLeast(npmVersion, MIN_NPM)) problems.push(`npm ${String(npmVersion)} is too old; trusted publishing needs npm >= ${MIN_NPM}.`);
  if (!atLeast(nodeVersion, MIN_NODE)) {
    problems.push(`Node ${String(nodeVersion)} is too old; releasing needs Node >= ${MIN_NODE} (the build tooling runs TypeScript by type stripping).`);
  }
  if (!onMain) problems.push('The commit is not on main; only commits on main are released.');
  return { publish: problems.length === 0, problems };
}

/**
 * Every reason a packed tarball is not exactly the intended distribution.
 *
 * @param pack - one `npm pack --json` entry ({ name, version, files: [{ path }] }), as read
 * @param packageJson - the manifest being released
 */
export function checkPackedTarball(pack: unknown, packageJson: IPackageManifest): string[] {
  const files = packedPaths(pack);
  if (!isRecord(pack) || files === undefined) return ['The pack result lists no files.'];
  const problems: string[] = [];
  if (pack['name'] !== packageJson.name) problems.push(`The tarball is named ${String(pack['name'])}, not ${String(packageJson.name)}.`);
  if (pack['version'] !== packageJson.version) {
    problems.push(`The tarball is version ${String(pack['version'])}, not ${String(packageJson.version)}.`);
  }
  for (const file of files) {
    if (typeof file !== 'string' || !isDistributable(file)) {
      problems.push(`The tarball contains ${String(file)}, which is outside the distribution boundary.`);
    }
  }
  for (const file of REQUIRED_FILES) {
    if (!files.includes(file)) problems.push(`The tarball is missing ${file}.`);
  }
  return problems;
}

/** The `path` of every file a pack result lists (a non-string where one is missing), or undefined when it lists none. */
function packedPaths(pack: unknown): unknown[] | undefined {
  if (!isRecord(pack)) return undefined;
  const files: unknown = pack['files'];
  if (!Array.isArray(files)) return undefined;
  return files.map((f: unknown) => (isRecord(f) ? f['path'] : undefined));
}

// ---------------------------------------------------------------------------
// Facts from the working directory, git, Changesets and npm
// ---------------------------------------------------------------------------

/** A refusal carrying every reason, reported as a list; never an internal failure. */
class RefusedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string | readonly string[]) {
    const list = typeof problems === 'string' ? [problems] : [...problems];
    super(list.join(' '));
    this.problems = list;
  }
}

/** Parses JSON text; the result is `unknown` until narrowed. */
function parseJson(text: string): unknown {
  // JSON.parse is typed `any`; binding it to `unknown` forces narrowing.
  const value: unknown = JSON.parse(text);
  return value;
}

/** The package.json in `dir`; a manifest that is not a JSON object is refused. */
function readManifest(dir = process.cwd()): IPackageManifest {
  const manifest = parseJson(fs.readFileSync(path.resolve(dir, 'package.json'), 'utf8'));
  if (!isRecord(manifest)) throw new RefusedError(`${path.join(dir, 'package.json')} is not a JSON object.`);
  return manifest;
}

function readOptional(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

/** The Changesets CLI installed in `projectDir`. */
function changeset(
  args: readonly string[],
  { projectDir = process.cwd(), ...options }: { readonly projectDir?: string; readonly stdio?: StdioOptions } = {},
): SpawnSyncReturns<string> {
  const bin = path.join(projectDir, 'node_modules', '.bin', 'changeset');
  return spawnSync(bin, args, { cwd: projectDir, encoding: 'utf8', ...options });
}

/** Names (without .md) of the pending changeset files in `dir`. */
function changesetFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => f.replace(/\.md$/, ''));
}

/** Changesets' changelog section headings, strongest first. */
const CHANGE_SECTIONS: readonly (readonly [type: string, heading: string])[] = [
  ['major', '### Major Changes'],
  ['minor', '### Minor Changes'],
  ['patch', '### Patch Changes'],
];

/**
 * The bump Changesets applied, read from the changelog entry it wrote for
 * `newVersion` (its "### Major/Minor/Patch Changes" sections).
 */
function appliedBump(changelog: string | undefined, newVersion: string): string | undefined {
  const escaped = newVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = new RegExp(`^## ${escaped}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(changelog ?? '');
  const body = entry?.[1] ?? '';
  const found = CHANGE_SECTIONS.find(([, heading]) => body.includes(heading));
  return found?.[0];
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
 * @returns the pending changeset names and the release they produce
 */
export function computeReleasePlan(projectDir: string = process.cwd()): IComputedReleasePlan {
  const changesets = changesetFiles(path.join(projectDir, '.changeset'));
  const packageJson = readManifest(projectDir);
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
      throw new RefusedError(
        `\`changeset version\` could not read the pending changesets (exit ${String(run.status)}): ${(run.stderr || run.stdout || '').trim()}`,
      );
    }
    const unconsumed = changesetFiles(path.join(sandbox, '.changeset')).filter((id) => changesets.includes(id));
    if (unconsumed.length > 0) {
      throw new RefusedError(
        `Changesets did not apply the pending changeset(s) ${unconsumed.map((id) => `.changeset/${id}.md`).join(', ')}; fix or remove them.`,
      );
    }
    const newVersion = readManifest(sandbox).version;
    if (newVersion === packageJson.version) return { changesets, releases: [] };
    if (typeof newVersion !== 'string') {
      throw new RefusedError(`Changesets left ${String(packageJson.name)} without a version; the release plan cannot be judged.`);
    }
    const type = appliedBump(readOptional(path.join(sandbox, 'CHANGELOG.md')), newVersion);
    if (!type) {
      throw new RefusedError(
        `Changesets versioned ${String(packageJson.name)} ${newVersion} without a changelog entry; the release plan cannot be judged.`,
      );
    }
    return {
      changesets,
      releases: [{ name: String(packageJson.name), type, oldVersion: String(packageJson.version), newVersion }],
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

/** Versions of this package on the configured registry; [] when npm has never seen it. */
function publishedVersions(name: string): string[] {
  const run = spawnSync('npm', ['view', name, 'versions', '--json'], { encoding: 'utf8' });
  let parsed: unknown;
  try {
    parsed = parseJson(run.stdout || 'null');
  } catch {
    parsed = null;
  }
  if (run.status === 0) {
    // Only strings can equal a version, so dropping anything else changes no decision.
    if (Array.isArray(parsed)) return parsed.filter((v: unknown): v is string => typeof v === 'string');
    if (typeof parsed === 'string') return [parsed];
    return [];
  }
  const error: unknown = isRecord(parsed) ? parsed['error'] : undefined;
  const errorCode: unknown = isRecord(error) ? error['code'] : undefined;
  const code = typeof errorCode === 'string' ? errorCode : '';
  if (code === 'E404' || /\bE404\b/.test(run.stderr || '')) return [];
  throw new RefusedError(
    `The npm registry could not be queried for ${name} (${code || `exit ${String(run.status)}`}); whether this version is already published is unknown.`,
  );
}

/** Whether `sha` is a commit reachable from `mainRef`; unknown commits are not. */
function isOnMain(sha: string | undefined, mainRef: string): boolean {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return false;
  return spawnSync('git', ['merge-base', '--is-ancestor', sha, mainRef]).status === 0;
}

/**
 * Why dist/ in `projectDir` is not a complete build of its current sources
 * (empty when it is), as scripts/build-manifest.mts judges it.
 */
function buildProblems(projectDir: string = process.cwd()): string[] {
  const run = spawnSync(process.execPath, [BUILD_MANIFEST_TOOL, 'verify', projectDir], { encoding: 'utf8' });
  if (run.status === 0) return [];
  const detail = `${run.stderr || ''}${run.stdout || ''}`.trim() || `exit ${String(run.status)}`;
  return [`dist/ is not a fresh build; run \`pnpm run build\` before publishing. ${detail}`];
}

function npmVersion(): string | undefined {
  const run = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function refuse(problems: readonly string[]): number {
  process.stderr.write(`Release refused:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  return 1;
}

/** Refuses (throws) unless the pending plan is within policy; returns the plan. */
function requireAllowedPlan(): IComputedReleasePlan {
  const plan = computeReleasePlan();
  const problems = checkReleasePlan(plan, { preMode: fs.existsSync(PRE_MODE_FILE) });
  if (problems.length > 0) throw new RefusedError(problems);
  return plan;
}

/** The command-line commands; each returns the exit code or throws a RefusedError. */
const COMMANDS: Readonly<Record<string, (args: readonly string[]) => number>> = {
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
    if (run.status !== 0) throw new RefusedError([`\`changeset version\` failed (exit ${String(run.status)}).`]);
    const packageJson = readManifest();
    const problems = versionProblems(packageJson.version, 'The new package.json version');
    if (problems.length > 0) {
      throw new RefusedError([...problems, 'Discard the changes `changeset version` made before committing.']);
    }
    process.stdout.write(
      plan.releases.length > 0
        ? `Versioned ${String(packageJson.name)} ${String(packageJson.version)}. Review, commit and merge to main to release it.\n`
        : `Applied changesets that request no release; ${String(packageJson.name)} stays ${String(packageJson.version)}. Commit the result.\n`,
    );
    return 0;
  },

  'publish-preflight'(args) {
    let mainRef = 'origin/main';
    const [flag, ref] = args;
    if (args.length === 2 && flag === '--main-ref' && ref !== undefined) mainRef = ref;
    else if (args.length !== 0) return usage();
    const packageJson = readManifest();
    const decision = decidePublish({
      packageJson,
      changelog: readOptional('CHANGELOG.md'),
      publishedVersions: publishedVersions(String(packageJson.name)),
      preMode: fs.existsSync(PRE_MODE_FILE),
      npmVersion: npmVersion(),
      nodeVersion: process.version,
      onMain: isOnMain(process.env['GITHUB_SHA'], mainRef),
    });
    if (decision.problems.length > 0) throw new RefusedError(decision.problems);
    const githubOutput = process.env['GITHUB_OUTPUT'];
    if (githubOutput) fs.appendFileSync(githubOutput, `publish=${String(decision.publish)}\n`);
    const id = `${String(packageJson.name)}@${String(packageJson.version)}`;
    process.stdout.write(
      decision.publish ? `${id} is not on npm yet and may be published.\n` : `${id} is already on npm; nothing to publish.\n`,
    );
    return 0;
  },

  'verify-pack'(args) {
    const [packJson] = args;
    if (args.length !== 1 || packJson === undefined) return usage();
    const parsed = parseJson(fs.readFileSync(packJson, 'utf8'));
    const pack: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
    const problems = checkPackedTarball(pack, readManifest());
    if (problems.length > 0) throw new RefusedError(problems);
    const filename: unknown = isRecord(pack) ? pack['filename'] : undefined;
    const count = String(packedPaths(pack)?.length ?? 0);
    process.stdout.write(`Verified ${String(filename)}: ${count} files, all inside the distribution boundary.\n`);
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

function usage(): number {
  process.stderr.write(
    'Usage: release-guard.mts plan | version | publish-preflight [--main-ref REF] | verify-pack PACK_JSON | check-version\n',
  );
  return 2;
}

function main(argv: readonly string[]): number {
  const [command, ...args] = argv;
  const handler = command !== undefined && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (handler === undefined) return usage();
  try {
    return handler(args);
  } catch (err) {
    if (err instanceof RefusedError) return refuse(err.problems);
    throw err;
  }
}

/**
 * Whether Node was started with this file (the command line), not loaded by
 * a test. Compared by real path, because import.meta.main is missing on the
 * older Node versions whose refusal this guard must still explain.
 */
function isCommandLine(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

if (isCommandLine()) process.exitCode = main(process.argv.slice(2));
