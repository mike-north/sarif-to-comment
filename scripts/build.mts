/**
 * Builds dist/, the directory the tests exercise and the package ships, and
 * regenerates the public declarations, the API report and the reference
 * documentation (`pnpm run build`).
 *
 * Steps, in order:
 *   1. Refuse JavaScript in src/: every runtime module is TypeScript (.cts),
 *      and a stray .cjs there would neither be compiled nor shipped.
 *   2. Remove dist/. Neither `tsc -b` nor `tsc -b --clean` deletes the output
 *      of a source that no longer exists, and such an orphan would ship.
 *   3. Compile the TypeScript runtime (src/*.cts -> dist/*.cjs, with
 *      per-module declarations dist/*.d.cts) with `tsc -b src`.
 *   4. Roll up the public declarations from the declaration entry
 *      (dist/public-api.d.cts -> dist/sarif-to-comment.d.ts) and regenerate
 *      the API report and the Markdown reference (scripts/api-docs.mts build).
 *   5. Write the build-freshness manifest (scripts/build-manifest.mts) last,
 *      so a build that fails or is interrupted leaves no manifest and the
 *      freshness check refuses its dist/.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeManifest } from './build-manifest.mts';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

function run(args: readonly string[]): void {
  execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
}

const sources = readdirSync(src);
const typescriptModules = sources.filter((file) => file.endsWith('.cts') && !file.endsWith('.d.cts'));
const javascriptModules = sources.filter((file) => file.endsWith('.cjs'));

if (javascriptModules.length > 0) {
  throw new Error(
    `src/ must hold TypeScript modules only; convert or remove these JavaScript files: ${javascriptModules.join(', ')}.`,
  );
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

run([tsc, '-b', 'src']);
run(['scripts/api-docs.mts', 'build']);

writeManifest(root);
process.stdout.write(`Built dist/ (${String(typescriptModules.length)} modules compiled, declarations rolled up).\n`);
