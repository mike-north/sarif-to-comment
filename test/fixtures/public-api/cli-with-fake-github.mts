#!/usr/bin/env node
/**
 * Executable wrapper that runs the real CLI entry point (dist/sarif-to-comment.cjs
 * `main`) with a fake createGitHubClient injected through the private internals
 * seam. Argument parsing, file reading, token selection, the library call,
 * Markdown output and exit status all come from the real CLI; only the GitHub
 * boundary is replaced. The fake remote directory is named by the
 * FAKE_GITHUB_DIR environment variable, which the CLI itself ignores.
 */

import { main } from '../../../dist/sarif-to-comment.cjs';
import { createFakeClientFactory } from './fake-adapter.mts';

const remoteDir = process.env['FAKE_GITHUB_DIR'];
if (!remoteDir) {
  process.stderr.write('cli-with-fake-github: FAKE_GITHUB_DIR is required\n');
  process.exit(64);
}

void main(
  { argv: process.argv.slice(2), env: process.env, stdout: process.stdout, stderr: process.stderr },
  { createGitHubClient: createFakeClientFactory(remoteDir) },
).then((code) => {
  process.exitCode = code;
});
