/**
 * Build-freshness manifest: proves that dist/ is a complete build of exactly
 * the current inputs.
 *
 * Tests exercise, and releases ship, the built dist/ rather than the
 * sources, so a stale or partial dist/ would make every later check judge the
 * wrong code. After a complete build, `write` records the sha256 of every
 * build input and of every file the build produced. `verify` recomputes both
 * sets and reports every added, removed or changed path, so it detects an
 * edited, added or deleted source or configuration file, an orphaned or
 * tampered output, and a build that never finished (the manifest is written
 * last, so an interrupted build has none). Content hashes are compared, not
 * modification times, which a checkout or copy can reorder.
 *
 * Usage: node scripts/build-manifest.mts write|verify [projectRoot]
 *   write   record the manifest for the dist/ that was just built
 *   verify  exit 0 when dist/ is fresh; otherwise exit 1 and list the reasons
 *           (`pnpm run check:build`, before the tests, and the release guard's
 *           check-version backstop)
 * projectRoot defaults to this repository.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_NAME = '.build-inputs.json';

/** Directories whose every file is a build input. */
const INPUT_DIRS: readonly string[] = ['src'];

/** Individual files that shape the build: configuration, the resolved toolchain and the build scripts themselves. */
const INPUT_FILES: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.base.json',
  'tsconfig.json',
  'api-extractor.json',
  'scripts/build.mts',
  'scripts/build-manifest.mts',
  'scripts/api-docs.cjs',
];

/** The recorded state of one complete build. */
export interface IBuildManifest {
  readonly version: 1;
  readonly inputs: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/** Project-relative POSIX paths of every file under `dir` (none when it is missing). */
function filesUnder(root: string, dir: string): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => toPosix(relative(root, join(entry.parentPath, entry.name))));
}

function hashAll(root: string, paths: readonly string[]): Record<string, string> {
  const sorted = [...new Set(paths)].sort();
  return Object.fromEntries(sorted.map((path) => [path, sha256(join(root, path))]));
}

/** The manifest the current inputs and the current dist/ would have. */
export function computeManifest(root: string): IBuildManifest {
  const inputs = [
    ...INPUT_DIRS.flatMap((dir) => filesUnder(root, dir)),
    ...INPUT_FILES.filter((file) => existsSync(join(root, file))),
  ];
  const outputs = filesUnder(root, 'dist').filter((path) => path !== `dist/${MANIFEST_NAME}`);
  return { version: 1, inputs: hashAll(root, inputs), outputs: hashAll(root, outputs) };
}

function differences(
  label: string,
  recorded: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  for (const [path, hash] of Object.entries(current)) {
    const was = recorded[path];
    if (was === undefined) problems.push(`${label} added since the build: ${path}`);
    else if (was !== hash) problems.push(`${label} changed since the build: ${path}`);
  }
  for (const path of Object.keys(recorded)) {
    if (current[path] === undefined) problems.push(`${label} removed since the build: ${path}`);
  }
  return problems;
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

/** The recorded manifest, or undefined when it is missing, unreadable or not a manifest. */
function readManifest(path: string): IBuildManifest | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1) return undefined;
  if (!('inputs' in parsed) || !('outputs' in parsed)) return undefined;
  const { inputs, outputs } = parsed;
  if (!isRecordOfStrings(inputs) || !isRecordOfStrings(outputs)) return undefined;
  return { version: 1, inputs, outputs };
}

/** Why dist/ is not a fresh, complete build of the current inputs (empty when it is). */
export function staleReasons(root: string): string[] {
  const recorded = readManifest(join(root, 'dist', MANIFEST_NAME));
  if (recorded === undefined) return [`dist/${MANIFEST_NAME} is missing or unreadable, so no complete build exists`];
  const current = computeManifest(root);
  return [...differences('input', recorded.inputs, current.inputs), ...differences('output', recorded.outputs, current.outputs)];
}

/** Records the manifest of the build that just completed in `root`/dist. */
export function writeManifest(root: string): void {
  writeFileSync(join(root, 'dist', MANIFEST_NAME), `${JSON.stringify(computeManifest(root), null, 2)}\n`);
}

function run(argv: readonly string[]): number {
  const [command, rootArg] = argv;
  const root = rootArg ?? fileURLToPath(new URL('..', import.meta.url));
  if (command === 'write' && argv.length <= 2) {
    writeManifest(root);
    return 0;
  }
  if (command === 'verify' && argv.length <= 2) {
    const reasons = staleReasons(root);
    if (reasons.length === 0) return 0;
    process.stderr.write(
      `dist/ is not a fresh build of the current sources; run \`pnpm run build\`.\n${reasons.map((r) => `  - ${r}`).join('\n')}\n`,
    );
    return 1;
  }
  process.stderr.write('Usage: build-manifest.mts write|verify [projectRoot]\n');
  return 2;
}

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2));
}
