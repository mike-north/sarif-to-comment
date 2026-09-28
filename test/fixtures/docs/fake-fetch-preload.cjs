'use strict';

/**
 * Preloaded (`node --require`) into the getting-started examples when the docs
 * tests run them. It replaces only `globalThis.fetch` with the fake GitHub
 * HTTP host in FAKE_HTTP_GITHUB_DIR (test/fixtures/composition), so the
 * example code runs verbatim against the installed package and its real
 * GitHub client without network access or a real token. The host checks that
 * every request carries `Authorization: Bearer $GH_TOKEN`.
 */

const { FakeHttpGitHub } = require('../composition/fake-http-github.cjs');

if (process.env.FAKE_HTTP_GITHUB_DIR) {
  const host = new FakeHttpGitHub(process.env.FAKE_HTTP_GITHUB_DIR, process.env.GH_TOKEN || null);
  globalThis.fetch = host.fetch;
}
