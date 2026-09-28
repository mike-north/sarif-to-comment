/**
 * Preloaded (`node --require`) into the getting-started examples when the docs
 * tests run them. It replaces only `globalThis.fetch` with the fake GitHub
 * HTTP host in FAKE_HTTP_GITHUB_DIR (test/fixtures/composition), so the
 * example code runs verbatim against the installed package and its real
 * GitHub client without network access or a real token. The host checks that
 * every request carries `Authorization: Bearer $GH_TOKEN`.
 *
 * This is an ES module: `--require` loads it synchronously through
 * require(esm) with type stripping (Node >= 22.18), so fetch is replaced
 * before the example's own code runs. It has no top-level await, which
 * require(esm) would refuse.
 */

import { FakeHttpGitHub } from '../composition/fake-http-github.mts';

const dir = process.env['FAKE_HTTP_GITHUB_DIR'];
if (dir) {
  const host = new FakeHttpGitHub(dir, process.env['GH_TOKEN'] || null);
  globalThis.fetch = host.fetch;
}
