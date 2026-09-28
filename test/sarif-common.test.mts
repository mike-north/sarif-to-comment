/**
 * Contract tests for the shared SARIF interpretation boundary
 * (src/sarif-cts), consumed by authoring, inspection and staged
 * extraction.
 *
 * - captureJson must follow the publisher's no-getter capture discipline.
 * - validateSarif must accept and refuse exactly what the publisher's schema
 *   check does.
 * - resolveArtifactPath and resolveMessage must interpret SARIF exactly as the
 *   publisher does.
 *
 * Parity is checked behaviourally against the unchanged publisher
 * (src/prepare-review.cts), never by sharing its code.
 *
 * @see docs/second-milestone-contract-proposal.md §1, §3.3, §9
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 * @see https://www.rfc-editor.org/rfc/rfc3986
 */

import { describe, test } from 'node:test';
import { AssertionError } from 'node:assert';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import {
  captureJson,
  encodeRepositoryPath,
  isNormalizedRepositoryPath,
  namesRepository,
  packageVersion,
  resolveArtifactPath,
  resolveMessage,
  resolveRule,
  validateSarif,
} from '../dist/sarif-common.cjs';
import type {
  IArtifactPathOptions,
  IResolvedRule,
  ISarifArtifactLocation,
  ISarifMessage,
  ISarifResult,
  ISarifRun,
  RuleResolution,
} from '../dist/sarif-common.cjs';
import { prepareReview } from '../dist/prepare-review.cjs';
import { asArray, asRecord, readJson } from './support/runtime-types.mts';

const HEAD = 'c0dec0dec0dec0dec0dec0dec0dec0dec0dec0de';
const BASE = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e';

/** A publisher context with no diff: every located result becomes general feedback. */
const publisherContext = (extra: Readonly<Record<string, unknown>> = {}) => ({
  owner: 'acme', repo: 'widgets', pullNumber: 1, reviewedCommit: HEAD,
  diff: { baseCommit: BASE, headCommit: HEAD, files: [] }, ...extra,
});

/** `value[key]` of a plain object, whatever variant of an outcome union it is. */
const prop = (value: object, key: string): unknown => asRecord(value)[key];

/** The resolved rule of a resolution that must succeed (an AssertionError naming the failure otherwise). */
function resolvedRule(resolution: RuleResolution): IResolvedRule {
  if (resolution.error) throw new AssertionError({ message: `rule unresolved: ${resolution.error.join(': ')}` });
  return resolution;
}

/** A snapshot reader that knows every requested path, recording each read. */
function anyFileReader() {
  const calls: [string, string][] = [];
  return { calls, readSource: (commit: string, path: string) => { calls.push([commit, path]); return Promise.resolve('line one\nline two\n'); } };
}

const minimal = (results: readonly unknown[] = [], run: Readonly<Record<string, unknown>> = {}) => ({ version: '2.1.0', runs: [{ tool: { driver: { name: 'T' } }, ...run, results }] });

describe('captureJson: the publisher\'s capture discipline', () => {
  test('returns a deep copy that shares no objects with its input', () => {
    const input = { a: [{ b: 1 }, 'x', null, true], c: { d: 'e' } };
    const copy = captureJson(input, 'sarif');
    assert.deepStrictEqual(copy, input);
    assert.notEqual(copy, input);
    const copied = asRecord(copy);
    assert.notEqual(copied['a'], input.a);
    assert.notEqual(asArray(copied['a'])[0], input.a[0]);
    assert.notEqual(copied['c'], input.c);
  });

  test('refuses an accessor property without ever running its getter', () => {
    let ran = false;
    const input = { runs: [] };
    Object.defineProperty(input, 'version', { enumerable: true, get() { ran = true; return '2.1.0'; } });
    assert.throws(() => captureJson(input, 'sarif'), (e) => e instanceof TypeError && /sarif\.version/.test(e.message));
    assert.equal(ran, false);
  });

  const refusals = {
    cycle: () => { const o: Record<string, unknown> = {}; o['self'] = o; return o; },
    undefinedValue: () => ({ a: undefined }),
    functionValue: () => ({ a() {} }),
    nan: () => ({ a: Number.NaN }),
    negativeZero: () => ({ a: -0 }),
    bigint: () => ({ a: 1n }),
    classInstance: () => ({ a: new Date(0) }),
    hole: () => ({ a: [1, , 3] }), // the array hole is the input under test
    symbolKey: () => ({ [Symbol('s')]: 1 }),
    nonEnumerable: () => Object.defineProperty({}, 'hidden', { value: 1, enumerable: false }),
    tooDeep: () => { let v: unknown = 'leaf'; for (let i = 0; i < 600; i += 1) v = [v]; return v; },
  };
  for (const [name, make] of Object.entries(refusals)) {
    test(`refuses non-JSON input (${name}) with a TypeError naming the label`, () => {
      assert.throws(() => captureJson(make(), 'myLabel'), (e) => e instanceof TypeError && e.message.includes('myLabel'));
    });
  }
});

describe('validateSarif: the vendored SARIF 2.1.0 errata01 schema, formats enforced', () => {
  test('returns null for a schema-valid log', () => {
    assert.equal(validateSarif(minimal()), null);
  });

  test('refuses an invalid log as { status: "invalid", problems, markdown } with pointers', () => {
    const outcome = validateSarif(minimal([{ locations: [] }]));
    assert.equal(outcome?.status, 'invalid');
    assert.deepStrictEqual(Object.keys(outcome).sort(), ['markdown', 'problems', 'status']);
    assert.ok(outcome.problems.length > 0);
    for (const problem of outcome.problems) {
      assert.equal(typeof problem.message, 'string');
      assert.ok(problem.message.length > 0);
    }
    assert.ok(outcome.problems.some((p) => p.pointer === '/runs/0/results/0'), JSON.stringify(outcome.problems));
    assert.ok(outcome.markdown.includes('/runs/0/results/0'));
  });

  test('enforces string formats (a URI reference with a space is invalid)', () => {
    const sarif = minimal([{ message: { text: 'x' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'a b.js' } } }] }]);
    assert.equal(validateSarif(sarif)?.status, 'invalid');
  });

  test('does not modify the value it validates', () => {
    const sarif = minimal([{ message: { text: 'x' } }]);
    const before = JSON.stringify(sarif);
    validateSarif(sarif);
    assert.equal(JSON.stringify(sarif), before);
  });

  const parityCases = {
    valid: minimal([{ message: { text: 'x' } }]),
    missingMessage: minimal([{ ruleId: 'R' }]),
    wrongVersion: { version: '2.0.0', runs: [] },
    uriWithSpace: minimal([{ message: { text: 'x' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'a b' } } }] }]),
    duplicateFixes: minimal([{ message: { text: 'x' }, fixes: [{ artifactChanges: [] }, { artifactChanges: [] }] }]),
    badLevel: minimal([{ message: { text: 'x' }, level: 'fatal' }]),
    badGuid: minimal([], { tool: { driver: { name: 'T', guid: 'not-a-guid' } } }),
  };
  for (const [name, sarif] of Object.entries(parityCases)) {
    test(`agrees with the publisher's schema verdict: ${name}`, async () => {
      const ours = validateSarif(sarif) === null;
      const outcome = await prepareReview({ sarif, context: publisherContext(), readSource: anyFileReader().readSource });
      const publisherSchemaValid = !(outcome.status === 'blocked' && outcome.diagnostics.some((d) => d.code === 'sarif-schema-invalid'));
      assert.equal(ours, publisherSchemaValid);
    });
  }
});

describe('repository paths', () => {
  test('normalized repository-relative paths are recognised', () => {
    for (const p of ['a.js', 'src/a.js', 'docs/guide notes/Überblick.md', 'a#b?%.txt']) {
      assert.equal(isNormalizedRepositoryPath(p), true, p);
    }
    for (const p of ['', '/a.js', 'a//b', 'a/./b', 'a/../b', '.', '..', 'a/', 'a\\b', 'a\0b', 42]) {
      assert.equal(isNormalizedRepositoryPath(p), false, JSON.stringify(p));
    }
  });

  test('encodeRepositoryPath percent-encodes each segment (RFC 3986) and keeps separators', () => {
    assert.equal(encodeRepositoryPath('src/app.js'), 'src/app.js');
    assert.equal(encodeRepositoryPath('docs/guide notes/Überblick.md'), 'docs/guide%20notes/%C3%9Cberblick.md');
    assert.equal(encodeRepositoryPath('a#b?%.txt'), 'a%23b%3F%25.txt');
    assert.equal(encodeRepositoryPath('c:d/e.js'), 'c%3Ad/e.js');
  });
});

/** A SARIF artifactLocation (3.4) with its description, which resolution never reads. */
type DescribedLocation = ISarifArtifactLocation & { readonly description?: { readonly text: string } };

describe('resolveArtifactPath: the publisher\'s URI, index and base rules', () => {
  const run: ISarifRun & { readonly originalUriBaseIds: Readonly<Record<string, DescribedLocation>>; readonly results: [] } = {
    tool: { driver: { name: 'T' } },
    originalUriBaseIds: {
      ROOT: { uri: 'file:///work/widgets/' },
      SRC: { uri: 'src/', uriBaseId: 'ROOT' },
      ABSTRACT: { description: { text: 'repo root' } },
    },
    artifacts: [{ location: { uri: 'src/app.js' } }, { location: { uri: 'inner.js' }, parentIndex: 0 }],
    versionControlProvenance: [
      { repositoryUri: 'https://github.com/acme/widgets', mappedTo: { uriBaseId: 'ABSTRACT' } },
      { repositoryUri: 'https://github.com/other/thing', mappedTo: { uri: 'file:///other/' } },
    ],
    results: [],
  };
  const resolve = (artifactLocation: ISarifArtifactLocation, options?: IArtifactPathOptions) => resolveArtifactPath(artifactLocation, run, options);

  test('relative, percent-encoded, indexed and chained references resolve', () => {
    assert.equal(prop(resolve({ uri: 'src/app.js' }), 'path'), 'src/app.js');
    assert.equal(prop(resolve({ uri: 'docs/guide%20notes/%C3%9Cberblick.md' }), 'path'), 'docs/guide notes/Überblick.md');
    assert.equal(prop(resolve({ index: 0 }), 'path'), 'src/app.js');
    assert.equal(prop(resolve({ uri: 'app.js', uriBaseId: 'SRC' }, { sourceRootUri: 'file:///work/widgets/' }), 'path'), 'src/app.js');
    assert.equal(prop(resolve({ uri: 'file:///work/widgets/lib/x.js' }, { sourceRootUri: 'file:///work/widgets/' }), 'path'), 'lib/x.js');
  });

  test('success reports the effective uri and base alongside the path', () => {
    assert.deepStrictEqual(resolve({ index: 0 }), { path: 'src/app.js', uri: 'src/app.js' });
    assert.deepStrictEqual(resolve({ uri: 'app.js', uriBaseId: 'SRC' }, { sourceRootUri: 'file:///work/widgets/' }),
      { path: 'src/app.js', uri: 'app.js', uriBaseId: 'SRC' });
  });

  test('a mappedTo root counts only for the given repository when one is given', () => {
    assert.equal(prop(resolve({ uri: 'x.js', uriBaseId: 'ABSTRACT' }, { repository: { owner: 'Acme', repo: 'Widgets' } }), 'path'), 'x.js');
    assert.deepStrictEqual(resolve({ uri: 'file:///other/y.js' }, { repository: { owner: 'acme', repo: 'widgets' } }).error?.[0],
      'uri-outside-repository');
  });

  test('without a repository, every declared mappedTo root counts (inspection has no destination)', () => {
    assert.equal(prop(resolve({ uri: 'x.js', uriBaseId: 'ABSTRACT' }), 'path'), 'x.js');
    assert.equal(prop(resolve({ uri: 'file:///other/y.js' }), 'path'), 'y.js');
  });

  const failures: [ISarifArtifactLocation, string][] = [
    [{ index: 5 }, 'artifact-index-invalid'],
    [{ index: 1 }, 'nested-artifact-unsupported'],
    [{ index: 0, uri: 'src/other.js' }, 'artifact-index-conflict'],
    [{ uri: 'src/../app.js' }, 'uri-traversal'],
    [{ uri: 'src%2Fapp.js' }, 'uri-encoded-separator'],
    [{ uri: 'https://example.com/a.js' }, 'uri-scheme-unsupported'],
    [{ uri: '/abs.js' }, 'uri-invalid'],
    [{ uri: 'a.js', uriBaseId: 'NOPE' }, 'uri-base-unresolved'],
    [{ uri: 'file:///elsewhere/x.js' }, 'uri-outside-repository'],
  ];
  for (const [location, code] of failures) {
    test(`${JSON.stringify(location)} fails with ${code}`, () => {
      const outcome = resolve(location, { repository: { owner: 'acme', repo: 'widgets' } });
      assert.equal(prop(outcome, 'path'), undefined);
      assert.equal(outcome.error?.[0], code);
      assert.equal(typeof outcome.error[1], 'string');
    });
  }

  // Behavioural parity: the publisher either resolves the same path (reading
  // exactly it) or blocks; ours must resolve that same path or fail.
  const parity: [ISarifArtifactLocation, string?][] = [
    [{ uri: 'src/app.js' }],
    [{ uri: 'docs/guide%20notes/%C3%9Cberblick.md' }],
    [{ uri: 'app.js', uriBaseId: 'SRC' }, 'file:///work/widgets/'],
    [{ uri: 'file:///work/widgets/lib/x.js' }, 'file:///work/widgets/'],
    [{ uri: 'x.js', uriBaseId: 'ABSTRACT' }],
    [{ uri: 'file:///other/y.js' }],
    [{ uri: 'src/../app.js' }],
    [{ uri: 'a.js', uriBaseId: 'NOPE' }],
    [{ index: 0 }],
    [{ index: 1 }],
  ];
  for (const [artifactLocation, sourceRootUri] of parity) {
    test(`agrees with the publisher: ${JSON.stringify(artifactLocation)}${sourceRootUri ? ' with a source root' : ''}`, async () => {
      const sarif = { version: '2.1.0', runs: [{ ...run, results: [{ message: { text: 'x' }, locations: [{ physicalLocation: { artifactLocation, region: { startLine: 1 } } }] }] }] };
      const reader = anyFileReader();
      const context = publisherContext(sourceRootUri ? { sourceRootUri } : {});
      const outcome = await prepareReview({ sarif, context, readSource: reader.readSource });
      const ours = resolveArtifactPath(artifactLocation, run, { sourceRootUri, repository: { owner: 'acme', repo: 'widgets' } });
      if (outcome.status === 'ready') {
        assert.deepStrictEqual(reader.calls, [[HEAD, prop(ours, 'path')]]);
      } else {
        assert.equal(prop(ours, 'path'), undefined, JSON.stringify(outcome.diagnostics));
        assert.deepStrictEqual(reader.calls, []);
      }
    });
  }
});

describe('resolveRule and resolveMessage: the publisher\'s message rules, without Markdown escaping', () => {
  const tool = {
    driver: { name: 'D', globalMessageStrings: { g: { text: 'Global {0}' } },
      rules: [{ id: 'R1', messageStrings: { m: { text: 'Value {{x}} is {0}', markdown: 'Value **{0}**' } } }] },
    extensions: [{ name: 'E', globalMessageStrings: { g: { text: 'Ext global {0}' } }, rules: [{ id: 'X1', messageStrings: { m: { text: 'Ext {0}' } } }] }],
  };
  const run = { tool, results: [] };
  const message = (result: ISarifResult & { message: ISarifMessage }) => {
    const resolution = resolveRule(result, run);
    const { rule, component } = resolution.error ? { rule: undefined, component: undefined } : resolution;
    return resolveMessage(result.message, rule, component);
  };

  test('direct text and markdown are returned with arguments substituted', () => {
    assert.deepStrictEqual(message({ message: { text: 'Var {0} {{lit}}', arguments: ['p'] } }), { text: 'Var p {lit}', resolved: true });
    assert.deepStrictEqual(message({ message: { text: 't', markdown: 'm {0}', arguments: ['*'] } }), { text: 't', markdown: 'm *', resolved: true });
  });

  test('message ids resolve through the rule, then its component\'s globals', () => {
    assert.deepStrictEqual(message({ ruleId: 'R1', message: { id: 'm', arguments: ['5'] } }),
      { id: 'm', text: 'Value {x} is 5', markdown: 'Value **5**', resolved: true });
    assert.deepStrictEqual(message({ message: { id: 'g', arguments: ['z'] } }), { id: 'g', text: 'Global z', resolved: true });
    assert.deepStrictEqual(message({ rule: { id: 'X1', toolComponent: { index: 0 } }, message: { id: 'm', arguments: ['q'] } }),
      { id: 'm', text: 'Ext q', resolved: true });
    assert.deepStrictEqual(message({ rule: { id: 'X1', toolComponent: { index: 0 } }, message: { id: 'g', arguments: ['w'] } }),
      { id: 'g', text: 'Ext global w', resolved: true });
  });

  test('an unknown id is unresolved and keeps its id', () => {
    assert.deepStrictEqual(message({ message: { id: 'nope' } }), { id: 'nope', resolved: false });
  });

  test('a missing argument is reported and the template is kept verbatim', () => {
    assert.deepStrictEqual(message({ message: { text: 'Needs {1}', arguments: ['a'] } }),
      { text: 'Needs {1}', resolved: false, missingArgument: 1 });
  });

  test('resolveRule reports the defining component and refuses an unresolvable one', () => {
    assert.equal(resolvedRule(resolveRule({ rule: { id: 'X1', toolComponent: { index: 0 } } }, run)).component.name, 'E');
    assert.equal(resolvedRule(resolveRule({ ruleId: 'R1' }, run)).rule?.id, 'R1');
    assert.equal(resolveRule({ rule: { id: 'X1', toolComponent: { index: 9 } } }, run).error?.[0], 'rule-component-unresolved');
  });
});

describe('namesRepository and packageVersion', () => {
  test('GitHub identity is case-insensitive across accepted URI forms', () => {
    const acme = { owner: 'acme', repo: 'widgets' };
    for (const uri of ['https://github.com/acme/widgets', 'https://github.com/Acme/Widgets.git', 'ssh://git@github.com/acme/widgets.git', 'git://github.com/acme/widgets']) {
      assert.equal(namesRepository(uri, acme), true, uri);
    }
    for (const uri of ['https://gitlab.com/acme/widgets', 'https://github.com/acme/other', 'not a uri']) {
      assert.equal(namesRepository(uri, acme), false, uri);
    }
  });

  test('packageVersion is read from package.json, not hard-coded', () => {
    assert.equal(packageVersion(), asRecord(readJson(path.join(import.meta.dirname, '..', 'package.json')))['version']);
  });
});
