/**
 * User acceptance of diagnostics through the *installed* package (the
 * tarball `npm pack` produces, installed into a clean consumer by
 * test/fixtures/package/installed-package.mts): the linked
 * `sarif-to-comment` executable in each format, and library consumers in
 * CommonJS and ES module form (docs/diagnostics.md).
 *
 * The consumer receives chalk and @toon-format/toon only as the package's
 * declared dependencies, so these runs also prove that the ES-module-only
 * dependencies load through `import()` from the CommonJS package. Expected
 * output is the documented example, byte for byte.
 *
 * @see https://toonformat.dev
 * @see https://docs.npmjs.com/cli/v11/configuring-npm/package-json#files
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';

import { decode } from '@toon-format/toon';

import { installIntoConsumer, packProject } from './fixtures/package/installed-package.mts';
import { DIAGNOSTICS_DOC, assertDiagnostics } from './support/diagnostics.mts';
import { asRecord, parseJson } from './support/runtime-types.mts';

/** A document whose only result has no message, as in the documented examples. */
const BROKEN = { version: '2.1.0', runs: [{ tool: { driver: { name: 'demo' } }, results: [{ ruleId: 'x' }] }] };
const ESC = '\u001b';

/** The fenced block after `<!-- diagnostics-example: name -->` in docs/diagnostics.md, with a final newline. */
function documented(name: string): string {
  const match = new RegExp(`<!-- diagnostics-example: ${name} -->\\n\`\`\`\\w+\\n([\\s\\S]*?)\\n\`\`\``).exec(DIAGNOSTICS_DOC);
  assert.ok(match, `docs/diagnostics.md has the ${name} example`);
  return `${match[1] ?? ''}\n`;
}

describe('the installed package renders diagnostics in every format', () => {
  const skip = packProject().error || false;

  test('CLI: human, json and toon for the documented inspection, with the documented bytes', { skip, timeout: 300_000 }, () => {
    const { consumer, bin } = installIntoConsumer();
    fs.writeFileSync(path.join(consumer, 'broken.sarif.json'), `${JSON.stringify(BROKEN, null, 2)}\n`);
    const cli = (args: readonly string[], env: Readonly<Record<string, string>> = {}): SpawnSyncReturns<string> =>
      spawnSync(bin, ['inspect', '--sarif', 'broken.sarif.json', ...args], { cwd: consumer, env: { PATH: process.env['PATH'], ...env }, encoding: 'utf8', timeout: 120_000 });

    const json = cli(['--format', 'json']);
    assert.equal(json.status, 2, json.stderr);
    assert.equal(json.stdout, documented('json'));
    assert.equal(json.stderr, '');

    const toon = cli(['--format', 'toon']);
    assert.equal(toon.status, 2, toon.stderr);
    assert.equal(toon.stdout, documented('toon'));
    assert.deepEqual(decode(toon.stdout), parseJson(json.stdout), 'TOON decodes to the JSON document');

    const human = cli([]);
    assert.equal(human.status, 2);
    assert.equal(human.stdout, '');
    assert.equal(human.stderr, documented('human'));

    const colored = cli(['--color', 'always']);
    assert.equal(colored.status, 2);
    assert.ok(colored.stderr.includes(`${ESC}[31m✖ error`), 'chalk loads from the installed dependencies and colors the badge red');
    assert.equal(colored.stderr.replace(/\u001b\[[0-9;]*m/g, ''), human.stderr);
    assert.equal(cli([], { NO_COLOR: '1', FORCE_COLOR: '1' }).stderr, colored.stderr, 'FORCE_COLOR overrides NO_COLOR');
  });

  test('library: CommonJS and ES module consumers read the same diagnostics', { skip, timeout: 300_000 }, () => {
    const { consumer } = installIntoConsumer();
    const sarif = JSON.stringify(BROKEN);
    fs.writeFileSync(path.join(consumer, 'diagnostics.cjs'),
      `const { inspectSarif } = require('sarif-to-comment');\nprocess.stdout.write(JSON.stringify(inspectSarif(${sarif}).diagnostics));\n`);
    fs.writeFileSync(path.join(consumer, 'diagnostics.mjs'),
      `import { inspectSarif } from 'sarif-to-comment';\nprocess.stdout.write(JSON.stringify(inspectSarif(${sarif}).diagnostics));\n`);
    const outputs = ['diagnostics.cjs', 'diagnostics.mjs'].map((script) => {
      const result = spawnSync(process.execPath, [script], { cwd: consumer, encoding: 'utf8', timeout: 120_000 });
      assert.equal(result.status, 0, result.stderr);
      return parseJson(result.stdout);
    });
    const [cjs, esm] = outputs;
    assert.deepEqual(cjs, esm);
    assertDiagnostics(cjs, [{ code: 'sarif-schema-invalid', location: { pointer: '/runs/0/results/0' }, message: /required property 'message'/ }]);
    const doc = asRecord(parseJson(documented('json')));
    assert.deepEqual(cjs, doc['diagnostics'], 'the library and the CLI report the same diagnostics');
  });

  test('the catalog and the version 1 schema ship with the package', { skip, timeout: 300_000 }, () => {
    const { packageDir } = installIntoConsumer();
    const schema = asRecord(parseJson(fs.readFileSync(path.join(packageDir, 'docs', 'diagnostic.v1.schema.json'), 'utf8')));
    assert.equal(schema['$id'], 'https://unpkg.com/sarif-to-comment/docs/diagnostic.v1.schema.json');
    assert.ok(fs.readFileSync(path.join(packageDir, 'docs', 'diagnostics.md'), 'utf8').includes('## Code catalog'));
  });
});
