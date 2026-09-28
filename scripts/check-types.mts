/**
 * Type-checks every TypeScript project without emitting anything, and the
 * shipped public declarations as a consumer compiles them
 * (`pnpm run check:types`, read-only).
 *
 * Each project is checked on its own with `tsc --noEmit -p`: a solution-wide
 * `tsc -b` would write build info into test/ and scripts/, and the runtime
 * project's real output is produced only by `pnpm run build`. Every check
 * runs even after one fails, so a single run reports everything.
 *
 * tsc refuses a project with no inputs. A project whose directory holds no
 * file of its source kind yet (test/ before its first .mts) is therefore
 * reported as skipped; once such a file exists the project is checked, so a
 * misconfigured include cannot silently pass.
 *
 * The rolled-up public declarations (dist/sarif-to-comment.d.ts, built by
 * `pnpm run build`) are compiled alone in a temporary directory that has no
 * node_modules, with `types: []` and the strict consumer flags. A consumer
 * without Node's types must be able to compile them, and API Extractor never
 * writes a `/// <reference types>` line, so searching the file for one
 * proves nothing: only this isolated compile catches a Node type (or any
 * other ambient or package type) leaking into the public API.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A project directory and the extension of its sources. */
interface IProject {
  readonly dir: string;
  readonly extension: string;
}

const PROJECTS: readonly IProject[] = [
  { dir: 'src', extension: '.cts' },
  { dir: 'test', extension: '.mts' },
  { dir: 'scripts', extension: '.mts' },
];

const root = fileURLToPath(new URL('..', import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

function hasSources({ dir, extension }: IProject): boolean {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).some(
    (file) => file.endsWith(extension) && !file.endsWith(`.d${extension}`) && !file.startsWith('node_modules'),
  );
}

let failed = 0;
for (const project of PROJECTS) {
  if (!existsSync(join(root, project.dir))) continue;
  if (!hasSources(project)) {
    process.stdout.write(`${project.dir}: skipped, no ${project.extension} sources yet\n`);
    continue;
  }
  const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', project.dir], { cwd: root, stdio: 'inherit' });
  if (result.status === 0) {
    process.stdout.write(`${project.dir}: types check\n`);
  } else {
    process.stdout.write(`${project.dir}: type errors (tsc exit ${String(result.status)})\n`);
    failed += 1;
  }
}
/** Compiler options of a strict consumer with no ambient types at all. */
const CONSUMER_OPTIONS = {
  target: 'es2022',
  lib: ['es2022'],
  module: 'nodenext',
  moduleResolution: 'nodenext',
  strict: true,
  exactOptionalPropertyTypes: true,
  noEmit: true,
  types: [],
};

/** Compiles the rolled-up public declarations alone, as a consumer with `types: []` would. */
function checkRollup(): boolean {
  const rollup = join(root, 'dist', 'sarif-to-comment.d.ts');
  if (!existsSync(rollup)) {
    process.stdout.write('dist/sarif-to-comment.d.ts: missing; run `pnpm run build` first\n');
    return false;
  }
  const isolated = mkdtempSync(join(tmpdir(), 'rollup-check-'));
  try {
    copyFileSync(rollup, join(isolated, 'sarif-to-comment.d.ts'));
    writeFileSync(
      join(isolated, 'tsconfig.json'),
      `${JSON.stringify({ compilerOptions: CONSUMER_OPTIONS, files: ['sarif-to-comment.d.ts'] }, null, 2)}\n`,
    );
    const result = spawnSync(process.execPath, [tsc, '-p', isolated], { cwd: isolated, stdio: 'inherit' });
    return result.status === 0;
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}

if (checkRollup()) {
  process.stdout.write('dist/sarif-to-comment.d.ts: compiles alone with types: []\n');
} else {
  process.stdout.write('dist/sarif-to-comment.d.ts: does not compile alone with types: []\n');
  failed += 1;
}

process.exitCode = failed === 0 ? 0 : 1;
