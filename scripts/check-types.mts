/**
 * Type-checks every TypeScript project without emitting anything
 * (`pnpm run check:types`, read-only).
 *
 * Each project is checked on its own with `tsc --noEmit -p`: a solution-wide
 * `tsc -b` would write build info into test/ and scripts/, and the runtime
 * project's real output is produced only by `pnpm run build`. Every project
 * is checked even after one fails, so a single run reports everything.
 *
 * tsc refuses a project with no inputs. A project whose directory holds no
 * file of its source kind yet (src/ before its first .cts, test/ before its
 * first .mts) is therefore reported as skipped; once such a file exists the
 * project is checked, so a misconfigured include cannot silently pass.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A project directory and the extension of its sources (undefined: always has inputs). */
interface IProject {
  readonly dir: string;
  readonly extension: string | undefined;
}

const PROJECTS: readonly IProject[] = [
  // The hand-written public declarations, checked as a consumer compiles them;
  // removed with types/ once the declarations are generated.
  { dir: 'types', extension: undefined },
  { dir: 'src', extension: '.cts' },
  { dir: 'test', extension: '.mts' },
  { dir: 'scripts', extension: '.mts' },
];

const root = fileURLToPath(new URL('..', import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

function hasSources({ dir, extension }: IProject): boolean {
  if (extension === undefined) return true;
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).some(
    (file) => file.endsWith(extension) && !file.endsWith(`.d${extension}`) && !file.startsWith('node_modules'),
  );
}

let failed = 0;
for (const project of PROJECTS) {
  if (!existsSync(join(root, project.dir))) continue;
  if (!hasSources(project)) {
    process.stdout.write(`${project.dir}: skipped, no ${String(project.extension)} sources yet\n`);
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
process.exitCode = failed === 0 ? 0 : 1;
