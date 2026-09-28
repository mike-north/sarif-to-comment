/**
 * Builds dist/, the directory the tests exercise and the package ships, and
 * regenerates the API report and reference documentation (`pnpm run build`).
 *
 * Steps, in order:
 *   1. Remove dist/. Neither `tsc -b` nor `tsc -b --clean` deletes the output
 *      of a source that no longer exists, and such an orphan would ship.
 *   2. Compile the TypeScript runtime (src/*.cts -> dist/*.cjs) with `tsc -b src`.
 *   3. Copy, byte for byte, the runtime modules still written in JavaScript
 *      (src/*.cjs -> dist/*.cjs) and the hand-written public declarations
 *      (types/index.d.ts -> dist/sarif-to-comment.d.ts). tsc cannot do this:
 *      with allowJs it reprints JavaScript instead of copying it. This step is
 *      removed once every module is TypeScript and the declarations are
 *      generated.
 *   4. Regenerate the API report and the Markdown reference
 *      (scripts/api-docs.cjs build).
 *   5. Write the build-freshness manifest (scripts/build-manifest.mts) last,
 *      so a build that fails or is interrupted leaves no manifest and the
 *      freshness check refuses its dist/.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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

// A module converted to TypeScript must not also remain as JavaScript: both
// would build to the same dist/<name>.cjs and one would silently win.
const converted = new Set(typescriptModules.map((file) => file.replace(/\.cts$/, '')));
const duplicated = javascriptModules.filter((file) => converted.has(file.replace(/\.cjs$/, '')));
if (duplicated.length > 0) {
  throw new Error(`These modules exist as both .cjs and .cts in src/: ${duplicated.join(', ')}. Delete the .cjs version.`);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

// tsc refuses a project with no inputs, which src/ is until its first module is converted.
if (typescriptModules.length > 0) run([tsc, '-b', 'src']);

for (const file of javascriptModules) copyFileSync(join(src, file), join(dist, file));
const handWrittenDeclarations = join(root, 'types', 'index.d.ts');
if (existsSync(handWrittenDeclarations)) copyFileSync(handWrittenDeclarations, join(dist, 'sarif-to-comment.d.ts'));

run(['scripts/api-docs.cjs', 'build']);

writeManifest(root);
process.stdout.write(`Built dist/ (${String(typescriptModules.length)} compiled, ${String(javascriptModules.length)} copied).\n`);
