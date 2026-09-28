#!/usr/bin/env node
'use strict';

/**
 * Runs the real CLI (bin/sarif-to-comment.cjs `main`) with the real GitHub
 * client (src/github.cjs); only the client's `fetch` is replaced by the fake
 * HTTP host whose directory is FAKE_HTTP_GITHUB_DIR. Everything from argument
 * parsing down to HTTP request construction and response parsing is the
 * product's own.
 */

const { main } = require('../../../dist/sarif-to-comment.cjs');
const { createGitHubClient } = require('../../../dist/github.cjs');
const { FakeHttpGitHub } = require('./fake-http-github.cjs');

const dir = process.env.FAKE_HTTP_GITHUB_DIR;
if (!dir) {
  process.stderr.write('cli-with-fake-http: FAKE_HTTP_GITHUB_DIR is required\n');
  process.exit(64);
}
const host = new FakeHttpGitHub(dir, process.env.GH_TOKEN || null);

main(
  { argv: process.argv.slice(2), env: process.env, stdout: process.stdout, stderr: process.stderr },
  { createGitHubClient: (options) => createGitHubClient({ ...options, fetch: host.fetch }) },
).then((code) => {
  process.exitCode = code;
});
