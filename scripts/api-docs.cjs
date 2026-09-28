#!/usr/bin/env node
'use strict';

/**
 * Generates, and checks the freshness of, the API report and the Markdown API
 * reference.
 *
 * Pipeline (https://api-extractor.com/pages/setup/generating_docs/):
 *   1. API Extractor analyses the hand-authored public declarations
 *      (types/index.d.ts, configured in api-extractor.json), writes the API
 *      report (api-report/sarif-to-comment.api.md, committed for review) and
 *      the doc model (temp/sarif-to-comment.api.json).
 *   2. API Documenter renders the doc model as navigable Markdown in
 *      docs/api/ (committed and packaged). API Documenter replaces its output
 *      folder, so docs/api/ holds generated pages only.
 *
 * Commands:
 *   build  regenerate in place (`pnpm run build`); commit the result.
 *   check  regenerate in a throwaway copy of the inputs and compare with the
 *          committed report and pages (`pnpm run check:api`). Read-only: the
 *          checkout is never modified. Exit 1 lists every stale or missing
 *          file; a failure of either tool is also exit 1.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Files and folders the generators read or write, relative to the project.
 * types/ holds both the declarations and the tsconfig API Extractor compiles
 * them with (api-extractor.json); the root tsconfig.json is how API Extractor
 * locates the project folder.
 */
const INPUTS = ['package.json', 'api-extractor.json', 'tsconfig.json', 'types'];
const REPORT = path.join('api-report', 'sarif-to-comment.api.md');
const DOCS = path.join('docs', 'api');

/** Runs a tool from the project's node_modules/.bin, failing loudly. */
function tool(projectDir, name, args) {
  const run = spawnSync(path.join(projectDir, 'node_modules', '.bin', name), args, { cwd: projectDir, encoding: 'utf8' });
  if (run.status !== 0) {
    process.stderr.write(`${name} ${args.join(' ')} failed (exit ${run.status}):\n${run.stdout}${run.stderr}`);
    process.exit(1);
  }
}

/** Regenerates the report and the Markdown reference inside `projectDir`. */
function generate(projectDir) {
  fs.mkdirSync(path.join(projectDir, 'api-report'), { recursive: true });
  // --local accepts report changes (writing the new report) instead of failing,
  // so that `check` can report every difference itself.
  tool(projectDir, 'api-extractor', ['run', '--local']);
  tool(projectDir, 'api-documenter', ['markdown', '--input-folder', 'temp', '--output-folder', DOCS]);
}

/** Relative paths and contents of every file under `dir` (empty when missing). */
function snapshot(dir) {
  const files = new Map();
  if (!fs.existsSync(dir)) return files;
  for (const name of fs.readdirSync(dir)) files.set(name, fs.readFileSync(path.join(dir, name), 'utf8'));
  return files;
}

function check(projectDir) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'api-docs-check-'));
  try {
    for (const entry of INPUTS) fs.cpSync(path.join(projectDir, entry), path.join(sandbox, entry), { recursive: true });
    fs.symlinkSync(fs.realpathSync(path.join(projectDir, 'node_modules')), path.join(sandbox, 'node_modules'), 'dir');
    generate(sandbox);

    const stale = [];
    const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);
    if (read(path.join(projectDir, REPORT)) !== read(path.join(sandbox, REPORT))) stale.push(REPORT);
    const committed = snapshot(path.join(projectDir, DOCS));
    const fresh = snapshot(path.join(sandbox, DOCS));
    for (const [name, text] of fresh) {
      if (committed.get(name) !== text) stale.push(path.join(DOCS, name));
    }
    for (const name of committed.keys()) if (!fresh.has(name)) stale.push(`${path.join(DOCS, name)} (no longer generated)`);

    if (stale.length > 0) {
      process.stderr.write(
        `The API report or reference docs are out of date with types/index.d.ts:\n${stale.map((f) => `  - ${f}`).join('\n')}\nRun \`pnpm run build\` and commit the result.\n`,
      );
      return 1;
    }
    process.stdout.write(`API report and ${fresh.size} reference pages are up to date.\n`);
    return 0;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

const [command] = process.argv.slice(2);
if (command === 'build') {
  generate(process.cwd());
  process.stdout.write(`Regenerated ${REPORT} and ${DOCS}/. Commit both.\n`);
} else if (command === 'check') {
  process.exitCode = check(process.cwd());
} else {
  process.stderr.write('Usage: api-docs.cjs build | check\n');
  process.exitCode = 2;
}
