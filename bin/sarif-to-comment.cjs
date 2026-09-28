#!/usr/bin/env node
'use strict';

/**
 * The sarif-to-comment executable. All behavior lives in src/cli.cjs, which
 * documents the commands, the flag-only publisher, output formats and exit
 * statuses; this file only connects it to the process.
 *
 * main({ argv, env, stdout, stderr, stdin?, cwd? }, internals?) -> Promise<exitCode>
 *   Exported for the test wrappers; `internals` is passed through to
 *   publishSarifReview (private test seam). Running this file directly calls
 *   main with the process and sets process.exitCode.
 */

const { main } = require('../src/cli.cjs');

if (require.main === module) {
  main({ argv: process.argv.slice(2), env: process.env, stdout: process.stdout, stderr: process.stderr }).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`sarif-to-comment: unexpected failure: ${err && err.message}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = { main };
