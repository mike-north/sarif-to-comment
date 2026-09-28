#!/usr/bin/env node
/**
 * The sarif-to-comment executable. All behavior lives in src/cli.cjs, which
 * documents the commands, the flag-only publisher, output formats and exit
 * statuses; this file only connects it to the process.
 *
 * main({ argv, env, stdout, stderr, stdin?, cwd? }, internals?) -> Promise<exitCode>
 *   Exported for the test wrappers; `internals` is passed through to
 *   publishSarifReview (private test seam). Running this file directly calls
 *   main with the process and sets process.exitCode.
 *
 * `export =` keeps the module shape the executable has always had
 * (`module.exports = { main }`, no `__esModule` marker), and the CLI is
 * loaded with `import x = require()` for the same reason.
 */

import cli = require('./cli.cjs');

const main = cli.main;

if (require.main === module) {
  main({ argv: process.argv.slice(2), env: process.env, stdout: process.stdout, stderr: process.stderr }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`sarif-to-comment: unexpected failure: ${unexpectedFailureText(err)}\n`);
      process.exitCode = 1;
    },
  );
}

/**
 * What the unexpected-failure line shows for a rejection: `err && err.message`
 * (the falsy value itself, else its `message` property; a primitive has none).
 */
function unexpectedFailureText(err: unknown): string {
  if (!err) return String(err);
  const message: unknown = typeof err === 'object' || typeof err === 'function' ? Reflect.get(err, 'message') : undefined;
  return String(message);
}

export = { main };
