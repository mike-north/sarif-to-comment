/**
 * Contract tests for publishing proposed file creations and deletions in
 * review content (docs/file-operation-publication-contract.md), at the
 * preparation boundary (src/prepare-review.cts).
 *
 * Every expected body is written by hand from the contract's templates: the
 * section headers, the file-details facts, the fence rule and the item
 * layout. None is captured from the implementation. An independent reading
 * of GFM fenced code blocks (firstFencedBlock) checks that each proposal's
 * code block holds exactly the file's content, whatever the content contains.
 *
 * The reviewed repository is an in-memory snapshot. Its source reader
 * behaves like the GitHub client's: it refuses binary and oversized files
 * operationally. Its existence check answers without reading content, as the
 * client's `fileExists` does.
 *
 * @see https://github.github.com/gfm/#fenced-code-blocks
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html
 * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
 * @see https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet
 */

import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { describe, test } from 'node:test';

import { prepareReview } from '../dist/prepare-review.cjs';
import type { IBlockedOutcome, IReadyOutcome, PrepareReviewOutcome } from '../dist/prepare-review.cjs';

const BASE = '1111111111111111111111111111111111111111';
const R = '2222222222222222222222222222222222222222';
const OTHER = '3333333333333333333333333333333333333333';
const SHORT = '2222222';
const SEP = '\n\n---\n\n';
const ATTRIBUTION = '<sub>— T</sub>';

/** Permalink to a file at the reviewed commit (contract §2). */
const permalink = (filePath: string, anchor = ''): string => `https://github.com/acme/widgets/blob/${R}/${filePath}${anchor}`;

/** A reviewed-commit file: text, or a file the source reader refuses as GitHub's client does. */
type SnapshotFile = string | { readonly refuse: 'undecodable-source' | 'source-too-large' };

/** The reviewed snapshot. */
const SNAPSHOT: Readonly<Record<string, SnapshotFile>> = {
  'README.md': '# Widgets\n',
  'obsolete.txt': 'first line\nsecond line\n',
  'src/app.js': 'a\nc\n',
  'assets/logo.png': { refuse: 'undecodable-source' },
  'data/huge.csv': { refuse: 'source-too-large' },
  'odd dir/weird).(x) #1%.txt': 'odd\n',
};
const BASE_SNAPSHOT: Readonly<Record<string, string>> = { 'src/app.js': 'a\nb\n' };

interface IRepositoryReads {
  readonly sourceReads: [string, string][];
  readonly existenceChecks: [string, string][];
  readonly readSource: (commit: string, filePath: string) => Promise<string | null>;
  readonly fileExists: (commit: string, filePath: string) => Promise<boolean>;
}

/** The reviewed repository's two readers, recording every call. */
function repositoryReads(): IRepositoryReads {
  const sourceReads: [string, string][] = [];
  const existenceChecks: [string, string][] = [];
  const snapshotAt = (commit: string): Readonly<Record<string, SnapshotFile>> => {
    if (commit === R) return SNAPSHOT;
    if (commit === BASE) return BASE_SNAPSHOT;
    throw new Error(`unknown commit ${commit}`);
  };
  return {
    sourceReads,
    existenceChecks,
    readSource: (commit, filePath) => {
      sourceReads.push([commit, filePath]);
      const file = snapshotAt(commit)[filePath];
      if (file === undefined) return Promise.resolve(null);
      if (typeof file !== 'string') return Promise.reject(new Error(`${file.refuse}: ${filePath}`));
      return Promise.resolve(file);
    },
    fileExists: (commit, filePath) => {
      existenceChecks.push([commit, filePath]);
      return Promise.resolve(Object.hasOwn(snapshotAt(commit), filePath));
    },
  };
}

const CONTEXT = {
  owner: 'acme',
  repo: 'widgets',
  pullNumber: 7,
  reviewedCommit: R,
  diff: { baseCommit: BASE, headCommit: R, files: [{ path: 'src/app.js', patch: '@@ -1,2 +1,2 @@\n a\n-b\n+c' }] },
};

async function prepare(
  sarif: unknown,
  { reads = repositoryReads(), options, withoutExistenceCheck = false }: {
    reads?: IRepositoryReads; options?: object; withoutExistenceCheck?: boolean;
  } = {},
): Promise<{ outcome: PrepareReviewOutcome; reads: IRepositoryReads }> {
  const input: Record<string, unknown> = { sarif, context: CONTEXT, readSource: reads.readSource };
  if (!withoutExistenceCheck) input['fileExists'] = reads.fileExists;
  if (options !== undefined) input['options'] = options;
  return { outcome: await prepareReview(input), reads };
}

// ---------------------------------------------------------------------------
// SARIF authoring helpers (the D23 representation, contract §4.7)

type Json = Record<string, unknown>;

/** A run bound to the reviewed commit of acme/widgets. */
function run(results: readonly Json[], artifacts: readonly Json[] = [], extras: Json = {}): Json {
  return {
    tool: { driver: { name: 'T' } },
    columnKind: 'utf16CodeUnits',
    versionControlProvenance: [{ repositoryUri: 'https://github.com/acme/widgets', revisionId: R }],
    artifacts,
    results,
    ...extras,
  };
}

const log = (...runs: readonly Json[]): Json => ({ version: '2.1.0', runs });

const created = (uri: string, text: string, extras: Json = {}): Json => ({ location: { uri }, contents: { text }, encoding: 'utf-8', ...extras });
const deleted = (uri: string, extras: Json = {}): Json => ({ location: { uri }, ...extras });

const createOp = (artifactIndex: number, fileMode?: string): Json =>
  fileMode === undefined ? { operation: 'create', artifactIndex } : { operation: 'create', artifactIndex, fileMode };
const deleteOp = (artifactIndex: number): Json => ({ operation: 'delete', artifactIndex });

/** A result carrying file operations, with an optional location on `uri` (and region). */
function carrying(text: string, operations: readonly Json[], uri?: string, region?: Json, extras: Json = {}): Json {
  const result: Json = { message: { text }, properties: { sarifToComment: { proposedFileChanges: operations } }, ...extras };
  if (uri !== undefined) {
    result['locations'] = [{ physicalLocation: { artifactLocation: { uri }, ...(region === undefined ? {} : { region }) } }];
  }
  return result;
}

/** One creation with one finding, the most common shape. */
const oneCreation = (uri: string, text: string, fileMode?: string, artifactExtras: Json = {}): Json =>
  log(run([carrying('Proposed.', [createOp(0, fileMode)])], [created(uri, text, artifactExtras)]));

// ---------------------------------------------------------------------------
// Expected Markdown (contract §2 templates)

/** A creation section: header, facts, optional fenced content, then items. */
function creationSection(filePath: string, facts: string, block: string | null, items: readonly string[]): string {
  const head = `**Proposed new file:** \`${filePath}\`\n\n**File details:** ${facts}`;
  return `${head}${block === null ? '' : `\n\n${block}`}\n\n${items.join(SEP)}`;
}

/** A deletion section: linked header, the not-emptied statement, then items. */
function deletionSection(filePath: string, items: readonly string[]): string {
  return `**Proposed file deletion:** [${filePath} at ${SHORT}](${permalink(filePath)})\n\n`
    + `The whole file is removed; this is not a proposal to empty it.\n\n${items.join(SEP)}`;
}

const item = (message: string): string => `${message}\n\n${ATTRIBUTION}`;

function assertReady(outcome: PrepareReviewOutcome): asserts outcome is IReadyOutcome {
  assert.equal(outcome.status, 'ready', JSON.stringify(outcome, null, 2));
}

function assertBlocked(outcome: PrepareReviewOutcome, code: string, pointer?: string): asserts outcome is IBlockedOutcome {
  assert.equal(outcome.status, 'blocked', JSON.stringify(outcome, null, 2));
  assert.ok(
    outcome.diagnostics.some((d) => d.code === code && (pointer === undefined || d.location?.pointer === pointer)),
    `expected ${code}${pointer === undefined ? '' : ` at ${pointer}`}: ${JSON.stringify(outcome.diagnostics)}`,
  );
  assert.ok(outcome.markdown.includes(code), 'the blocked Markdown names the code');
  assert.ok(!('review' in outcome), 'nothing is prepared for publication');
}

/**
 * An independent reading of GFM: the content of the first fenced code block
 * opened by a backtick fence at the start of a line, closed by the first later
 * line of at least as many backticks (up to three spaces of indentation, then
 * only spaces or tabs). Null when there is none.
 */
function firstFencedBlock(markdown: string): string | null {
  const lines = markdown.split('\n');
  for (const [i, line] of lines.entries()) {
    const open = /^(`{3,})[^`]*$/.exec(line);
    if (!open) continue;
    const width = (open[1] ?? '').length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const close = /^ {0,3}(`+)[ \t]*$/.exec(lines[j] ?? '');
      if (close && (close[1] ?? '').length >= width) return lines.slice(i + 1, j).join('\n');
    }
    return lines.slice(i + 1).join('\n');
  }
  return null;
}

// ---------------------------------------------------------------------------

describe('the four operations stay distinct (R9, D6)', () => {
  test('create-empty: an empty file has no block and says it is empty', async () => {
    const { outcome } = await prepare(oneCreation('empty.txt', ''));
    assertReady(outcome);
    assert.equal(outcome.review.body, creationSection('empty.txt', 'empty file (0 bytes) · mode 100644', null, [item('Proposed.')]));
    assert.deepEqual(outcome.review.comments, []);
  });

  test('delete: the whole file is removed, linked at the reviewed commit, without reading its content', async () => {
    const { outcome, reads } = await prepare(log(run([carrying('Obsolete.', [deleteOp(0)])], [deleted('obsolete.txt')])));
    assertReady(outcome);
    assert.equal(outcome.review.body, deletionSection('obsolete.txt', [item('Obsolete.')]));
    assert.deepEqual(reads.existenceChecks, [[R, 'obsolete.txt']]);
    assert.deepEqual(reads.sourceReads, [], 'a deletion never reads the deleted content');
  });

  test('empty-existing: emptying a file stays an edit, presented as a native suggestion, never a deletion', async () => {
    const sarif = log(run([{
      message: { text: 'Empty it.' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'src/app.js' }, region: { startLine: 1, endLine: 2 } } }],
      fixes: [{ artifactChanges: [{ artifactLocation: { uri: 'src/app.js' }, replacements: [{
        deletedRegion: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 3 }, insertedContent: { text: '' },
      }] }] }],
    }]));
    const { outcome } = await prepare(sarif);
    assertReady(outcome);
    assert.equal(outcome.review.body, '');
    assert.deepEqual(outcome.review.comments, [{
      path: 'src/app.js', side: 'RIGHT', line: 2, startSide: 'RIGHT', startLine: 1,
      body: `${item('Empty it.')}\n\n\`\`\`suggestion\n\`\`\``,
    }]);
  });

  test('text-replace: an ordinary fix is a native suggestion, not a file proposal', async () => {
    const sarif = log(run([{
      message: { text: 'Use d.' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'src/app.js' }, region: { startLine: 2 } } }],
      fixes: [{ artifactChanges: [{ artifactLocation: { uri: 'src/app.js' }, replacements: [{
        deletedRegion: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 }, insertedContent: { text: 'd' },
      }] }] }],
    }]));
    const { outcome } = await prepare(sarif);
    assertReady(outcome);
    assert.equal(outcome.review.body, '');
    assert.deepEqual(outcome.review.comments, [{
      path: 'src/app.js', side: 'RIGHT', line: 2, body: `${item('Use d.')}\n\n\`\`\`suggestion\nd\n\`\`\``,
    }]);
  });

  test('a one-newline file is not the empty file: its block holds one empty line', async () => {
    const { outcome } = await prepare(oneCreation('newline.txt', '\n'));
    assertReady(outcome);
    assert.equal(outcome.review.body, creationSection('newline.txt',
      '1 byte of UTF-8 text · LF line endings · ends with a newline · mode 100644', '```\n\n```', [item('Proposed.')]));
  });

  test('one review can hold a creation, a deletion and ordinary feedback, each once, in SARIF order', async () => {
    const sarif = log(run([
      carrying('Add a guide.', [createOp(0)]),
      { message: { text: 'General note.' } },
      carrying('Remove this.', [deleteOp(1)], 'obsolete.txt'),
    ], [created('docs/guide.md', 'Guide\n'), deleted('obsolete.txt')]));
    const { outcome } = await prepare(sarif);
    assertReady(outcome);
    assert.equal(outcome.review.body, [
      creationSection('docs/guide.md', '6 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644', '```\nGuide\n```', [item('Add a guide.')]),
      item('General note.'),
      deletionSection('obsolete.txt', [item('Remove this.')]),
    ].join(SEP));
    assert.match(outcome.markdown, /0 inline comment\(s\) and 3 general section\(s\)/);
    assert.deepEqual(outcome.evidence.map((e) => [e.pointer, e.treatment, 'bodySectionIndex' in e ? e.bodySectionIndex : null]), [
      ['/runs/0/results/0', 'general', 0],
      ['/runs/0/results/1', 'general', 1],
      ['/runs/0/results/2', 'general', 2],
    ]);
  });
});

describe('creation content and facts (contract §2)', () => {
  test('the documentation example publishes with its line-1 association and a fence longer than its own', async () => {
    // docs/examples/proposed-documentation.sarif.json, bound to the reviewed commit.
    const text = '# New feature\n\nIllustrative documentation content, not documentation for an implemented feature.\n\n```text\nExample usage goes here.\n```\n';
    const sarif = log(run([carrying('This PR needs documentation for its new functionality. Here is a proposed page to add.',
      [createOp(0)], 'docs/new-feature.md', { startLine: 1 }, { kind: 'review', level: 'note' })], [created('docs/new-feature.md', text)]));
    const { outcome, reads } = await prepare(sarif);
    assertReady(outcome);
    assert.equal(outcome.review.body, creationSection('docs/new-feature.md',
      '135 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
      `\`\`\`\`\n${text.slice(0, -1)}\n\`\`\`\``,
      ['**Location:** line 1 of the proposed file\n\n**Level:** note · **Kind:** review\n\n'
        + 'This PR needs documentation for its new functionality. Here is a proposed page to add.\n\n<sub>— T</sub>']));
    assert.deepEqual(reads.sourceReads, [], 'no line of the absent file is read at the reviewed commit');
    assert.deepEqual(reads.existenceChecks, [[R, 'docs/new-feature.md']]);
    assert.ok(!outcome.review.body.includes(`/blob/${R}/docs/new-feature.md`), 'no permalink to a created path');
  });

  test('a multi-line region names its lines of the proposed file', async () => {
    const sarif = log(run([carrying('Lines two and three.', [createOp(0)], 'n.md', { startLine: 2, endLine: 3 })], [created('n.md', 'a\nb\nc\n')]));
    const { outcome } = await prepare(sarif);
    assertReady(outcome);
    assert.equal(outcome.review.body, creationSection('n.md', '6 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
      '```\na\nb\nc\n```', [`**Location:** lines 2-3 of the proposed file\n\n${item('Lines two and three.')}`]));
  });

  const cases: readonly (readonly [label: string, text: string, facts: string, block: string | null])[] = [
    ['no final newline', 'alpha\nbeta', '10 bytes of UTF-8 text · LF line endings · no newline at end of file · mode 100644', '```\nalpha\nbeta\n```'],
    ['a single line without a newline', 'solo', '4 bytes of UTF-8 text · no line breaks · no newline at end of file · mode 100644', '```\nsolo\n```'],
    ['CRLF line endings', 'one\r\ntwo\r\n', '10 bytes of UTF-8 text · CRLF line endings · ends with a newline · mode 100644', '```\none\r\ntwo\n```'],
    ['a byte-order mark', '\uFEFFhello\n', '9 bytes of UTF-8 text · begins with a byte-order mark · LF line endings · ends with a newline · mode 100644', '```\nhello\n```'],
    ['only a byte-order mark', '﻿', '3 bytes of UTF-8 text · begins with a byte-order mark · no content after the byte-order mark · mode 100644', null],
    ['multibyte UTF-8', 'héllo 🎉\n', '12 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644', '```\nhéllo 🎉\n```'],
    ['trailing whitespace and tabs', '\tindented  \n  \n', '15 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644', '```\n\tindented  \n  \n```'],
  ];
  for (const [label, text, facts, block] of cases) {
    test(`facts and block for ${label}`, async () => {
      const { outcome } = await prepare(oneCreation('f.txt', text));
      assertReady(outcome);
      assert.equal(outcome.review.body, creationSection('f.txt', facts, block, [item('Proposed.')]));
    });
  }

  test('an executable file states its mode', async () => {
    const { outcome } = await prepare(oneCreation('tool.sh', '#!/bin/sh\n', '100755'));
    assertReady(outcome);
    assert.equal(outcome.review.body, creationSection('tool.sh',
      '10 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100755 (executable)', '```\n#!/bin/sh\n```', [item('Proposed.')]));
  });

  test('an explicit 100644 mode is the same as an absent one', async () => {
    const [a, b] = await Promise.all([prepare(oneCreation('x.txt', 'x\n', '100644')), prepare(oneCreation('x.txt', 'x\n'))]);
    assertReady(a.outcome);
    assertReady(b.outcome);
    assert.equal(a.outcome.review.body, b.outcome.review.body);
  });

  test('a declared length and a verifiable hash that match the content are accepted', async () => {
    const text = 'verified\n';
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');
    const { outcome } = await prepare(oneCreation('v.txt', text, undefined, { length: 9, hashes: { 'sha-256': sha256 } }));
    assertReady(outcome);
  });
});

describe('literal content: fences, HTML and adversarial text (S1, A19)', () => {
  const adversarial = [
    'Three: ```js',
    '```',
    '````',
    '``````````',
    '~~~',
    '</details>',
    '<script>alert(1)</script>',
    '<!-- unterminated',
    '{{ template }} and {0}',
    '@octocat #1 [x](javascript:alert(1))',
    '**not bold** <img src=x onerror=alert(1)>',
    '```suggestion',
    '',
  ].join('\n');

  test('the block uses a fence one longer than the longest backtick run and holds the content exactly', async () => {
    const { outcome } = await prepare(oneCreation('docs/adversarial.md', adversarial));
    assertReady(outcome);
    const fence = '`'.repeat(11);
    const displayed = adversarial.slice(0, -1);
    assert.equal(outcome.review.body, creationSection('docs/adversarial.md',
      `${String(Buffer.byteLength(adversarial))} bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644`,
      `${fence}\n${displayed}\n${fence}`, [item('Proposed.')]));
    assert.equal(firstFencedBlock(outcome.review.body), displayed);
  });

  for (const [label, text] of [
    ['a run of three backticks', 'a ``` b\n'],
    ['a line of four backticks', '````\n'],
    ['a line of ten backticks', 'x\n``````````\ny\n'],
    ['a tilde fence', '~~~\ncode\n~~~\n'],
    ['backticks at the very end without a newline', 'end ```'],
  ] as const) {
    test(`independent GFM reading recovers the content with ${label}`, async () => {
      const { outcome } = await prepare(oneCreation('c.md', text));
      assertReady(outcome);
      const displayed = text.endsWith('\n') ? text.slice(0, -1) : text;
      assert.equal(firstFencedBlock(outcome.review.body), displayed);
      const run = Math.max(...(text.match(/`+/g) ?? ['']).map((r) => r.length));
      assert.ok(outcome.review.body.includes(`\n${'`'.repeat(Math.max(3, run + 1))}\n`));
    });
  }

  test('negative control: a three-backtick fence around a line of four backticks is closed early', () => {
    assert.equal(firstFencedBlock('```\na\n````\nb\n```'), 'a');
  });
});

describe('two findings on one proposal (R8, R1)', () => {
  test('findings in different runs carrying the same creation share one section; the content appears once', async () => {
    const text = 'shared content\n';
    const sarif = log(
      run([carrying('First reason.', [createOp(0)])], [created('docs/s.md', text)]),
      { ...run([carrying('Second reason.', [createOp(0)])], [created('docs/s.md', text)]), tool: { driver: { name: 'U', version: '2.0' } } },
    );
    const { outcome } = await prepare(sarif);
    assertReady(outcome);
    assert.equal(outcome.review.body, creationSection('docs/s.md',
      '15 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644', '```\nshared content\n```',
      [item('First reason.'), 'Second reason.\n\n<sub>— U 2.0</sub>']));
    assert.equal(outcome.review.body.split('shared content').length, 2, 'the content appears exactly once');
    assert.deepEqual(outcome.evidence.map((e) => ('bodySectionIndex' in e ? e.bodySectionIndex : null)), [0, 0]);
    assert.match(outcome.markdown, /1 general section\(s\)/);
  });

  test('a deletion finding with a region quotes its lines at the reviewed commit; the line does not narrow the deletion (A26)', async () => {
    const sarif = log(run([
      carrying('Whole file is obsolete.', [deleteOp(0)], 'obsolete.txt', { startLine: 2 }),
      carrying('Also no longer used.', [deleteOp(0)]),
    ], [deleted('obsolete.txt')]));
    const { outcome } = await prepare(sarif);
    assertReady(outcome);
    assert.equal(outcome.review.body, deletionSection('obsolete.txt', [
      `**Source:** [obsolete.txt line 2 at ${SHORT}](${permalink('obsolete.txt', '?plain=1#L2')})\n\n\`\`\`\nsecond line\n\`\`\`\n\n${item('Whole file is obsolete.')}`,
      item('Also no longer used.'),
    ]));
    assert.deepEqual(outcome.review.comments, [], 'a deletion finding is never an inline comment');
  });

  test('a body section containing the separator is still counted once', async () => {
    const { outcome } = await prepare(oneCreation('sep.md', 'a\n\n---\n\nb\n'));
    assertReady(outcome);
    assert.match(outcome.markdown, /0 inline comment\(s\) and 1 general section\(s\)/);
  });
});

describe('deletion permalinks for paths with URL- and Markdown-significant characters', () => {
  // Regression: parentheses were left unencoded in the permalink, so an
  // unbalanced `)` ended the Markdown link destination early.
  test('a path with parentheses, a space, # and % links as one GFM link destination', async () => {
    const uri = 'odd%20dir/weird%29.%28x%29%20%231%25.txt';
    const { outcome } = await prepare(log(run([carrying('Remove it.', [deleteOp(0)])], [deleted(uri)])));
    assertReady(outcome);
    const destination = `https://github.com/acme/widgets/blob/${R}/odd%20dir/weird%29.%28x%29%20%231%25.txt`;
    assert.equal(outcome.review.body,
      `**Proposed file deletion:** [odd dir/weird).(x) \\#1%.txt at ${SHORT}](${destination})\n\n`
      + `The whole file is removed; this is not a proposal to empty it.\n\n${item('Remove it.')}`);
    // GFM: a destination not in <...> ends at the first space or unbalanced ')'.
    const link = /\]\(([^\s()]*)\)/.exec(outcome.review.body);
    assert.equal(link?.[1], destination);
  });
});

describe('deletion of files the source reader cannot decode (decision 2)', () => {
  for (const filePath of ['assets/logo.png', 'data/huge.csv']) {
    test(`${filePath} is deleted using only the existence check`, async () => {
      const { outcome, reads } = await prepare(log(run([carrying('Unused.', [deleteOp(0)], filePath)], [deleted(filePath)])));
      assertReady(outcome);
      assert.equal(outcome.review.body, deletionSection(filePath, [item('Unused.')]));
      assert.deepEqual(reads.sourceReads, []);
    });
  }

  test('without an existence check, preparation falls back to the source reader', async () => {
    const { outcome, reads } = await prepare(log(run([carrying('Obsolete.', [deleteOp(0)])], [deleted('obsolete.txt')])), {
      withoutExistenceCheck: true,
    });
    assertReady(outcome);
    assert.deepEqual(reads.sourceReads, [[R, 'obsolete.txt']]);
  });

  test('a failing existence check is operational and propagates unchanged', async () => {
    const reads = repositoryReads();
    const failure = new Error('host unavailable');
    const failing: IRepositoryReads = { ...reads, fileExists: () => Promise.reject(failure) };
    await assert.rejects(prepare(log(run([carrying('x', [deleteOp(0)])], [deleted('obsolete.txt')])), { reads: failing }), (err) => err === failure);
  });
});

describe('whole-review refusals (contract §2 Refusals)', () => {
  const refusedContent: readonly (readonly [string, string])[] = [
    ['a bare CR', 'one\rtwo\n'],
    ['mixed LF and CRLF', 'one\r\ntwo\n'],
    ['a NUL', 'a\u0000b\n'],
    ['a C0 control', 'bell\u0007\n'],
    ['DEL', 'del\u007f\n'],
    ['a C1 control', 'c1\u0085\n'],
    ['a byte-order mark after the start', 'a\uFEFFb\n'],
    ['a bidirectional override', 'abc\u202Edef\n'],
    ['a line separator', 'a\u2028b\n'],
    ['a lone surrogate', 'bad \uD800 text\n'],
    // Every format character (Unicode category Cf) and U+00A0 (contract §2 Refusals).
    ['a zero-width space', 'a\u200Bb\n'],
    ['a word joiner', 'a\u2060b\n'],
    ['a soft hyphen', 'a\u00ADb\n'],
    ['a tag character', 'a\u{E0001}b\n'],
    ['a no-break space', 'a\u00A0b\n'],
  ];
  for (const [label, text] of refusedContent) {
    test(`content with ${label} cannot be shown exactly and blocks`, async () => {
      const { outcome } = await prepare(oneCreation('bad.txt', text));
      assertBlocked(outcome, 'file-operation-content-unrepresentable', '/runs/0/results/0');
    });
  }

  test('binary contents block', async () => {
    const sarif = log(run([carrying('x', [createOp(0)])], [{ location: { uri: 'b.bin' }, contents: { binary: 'AAEC' } }]));
    assertBlocked((await prepare(sarif)).outcome, 'file-operation-binary-unsupported', '/runs/0/results/0');
  });

  test('a non-UTF-8 encoding blocks', async () => {
    assertBlocked((await prepare(oneCreation('l.txt', 'café\n', undefined, { encoding: 'iso-8859-1' }))).outcome,
      'file-operation-encoding-unsupported', '/runs/0/results/0');
  });

  test('a non-UTF-8 run default encoding blocks when the artifact names none', async () => {
    const sarif = log(run([carrying('x', [createOp(0)])], [{ location: { uri: 'l.txt' }, contents: { text: 'x\n' } }], { defaultEncoding: 'utf-16le' }));
    assertBlocked((await prepare(sarif)).outcome, 'file-operation-encoding-unsupported');
  });

  test('a creation without text contents blocks', async () => {
    const sarif = log(run([carrying('x', [createOp(0)])], [{ location: { uri: 'n.txt' } }]));
    assertBlocked((await prepare(sarif)).outcome, 'file-operation-invalid');
  });

  test('a creation over a path that exists at the reviewed commit blocks', async () => {
    assertBlocked((await prepare(oneCreation('README.md', '# Other\n'))).outcome, 'file-operation-target-exists', '/runs/0/results/0');
  });

  test('a deletion of a path absent at the reviewed commit blocks', async () => {
    const sarif = log(run([carrying('x', [deleteOp(0)])], [deleted('missing.txt')]));
    assertBlocked((await prepare(sarif)).outcome, 'file-operation-target-missing', '/runs/0/results/0');
  });

  test('a region past the end of the proposed content blocks (A25)', async () => {
    const sarif = log(run([carrying('x', [createOp(0)], 'n.md', { startLine: 5 })], [created('n.md', 'one\ntwo\n')]));
    assertBlocked((await prepare(sarif)).outcome, 'source-range-invalid', '/runs/0/results/0');
  });

  test('a snippet that is not the proposed text blocks', async () => {
    const sarif = log(run([carrying('x', [createOp(0)], 'n.md', { startLine: 1, snippet: { text: 'nope' } })], [created('n.md', 'one\n')]));
    assertBlocked((await prepare(sarif)).outcome, 'snippet-mismatch', '/runs/0/results/0');
  });

  test('a location on another file blocks', async () => {
    const sarif = log(run([carrying('x', [createOp(0)], 'README.md', { startLine: 1 })], [created('n.md', 'one\n')]));
    assertBlocked((await prepare(sarif)).outcome, 'file-operation-association-unsupported', '/runs/0/results/0');
  });

  test('a result with both a fix and an operation blocks', async () => {
    const sarif = log(run([carrying('x', [deleteOp(0)], undefined, undefined, {
      fixes: [{ artifactChanges: [{ artifactLocation: { uri: 'src/app.js' }, replacements: [{ deletedRegion: { startLine: 2 }, insertedContent: { text: 'd\n' } }] }] }],
    })], [deleted('obsolete.txt')]));
    assertBlocked((await prepare(sarif)).outcome, 'file-operation-conflict', '/runs/0/results/0');
  });

  test('two different proposals for one path block', async () => {
    const sarif = log(run([carrying('x', [createOp(0)]), carrying('y', [createOp(1)])], [created('n.md', 'one\n'), created('n.md', 'two\n')]));
    assertBlocked((await prepare(sarif)).outcome, 'file-operation-conflict', '/runs/0/results/1');
  });

  test('the same content with a different mode is a different proposal and blocks', async () => {
    const sarif = log(run([carrying('x', [createOp(0)]), carrying('y', [createOp(0, '100755')])], [created('n.sh', 'one\n')]));
    assertBlocked((await prepare(sarif)).outcome, 'file-operation-conflict', '/runs/0/results/1');
  });

  test('a fix editing a deleted path blocks', async () => {
    const sarif = log(run([
      carrying('x', [deleteOp(0)]),
      {
        message: { text: 'Use d.' },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'src/app.js' }, region: { startLine: 2 } } }],
        fixes: [{ artifactChanges: [{ artifactLocation: { uri: 'src/app.js' }, replacements: [{
          deletedRegion: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 }, insertedContent: { text: 'd' },
        }] }] }],
      },
    ], [deleted('src/app.js')]));
    assertBlocked((await prepare(sarif)).outcome, 'file-operation-conflict');
  });

  test('more than one operation on one result blocks', async () => {
    const sarif = log(run([carrying('move', [deleteOp(0), createOp(1)])], [deleted('obsolete.txt'), created('moved.txt', 'x\n')]));
    assertBlocked((await prepare(sarif)).outcome, 'file-operation-multiple-unsupported', '/runs/0/results/0');
  });

  test('an edit operation is not published as a file proposal', async () => {
    const sarif = log(run([carrying('x', [{ operation: 'edit', artifactIndex: 0 }])], [deleted('obsolete.txt')]));
    assertBlocked((await prepare(sarif)).outcome, 'file-operation-unsupported', '/runs/0/results/0');
  });

  const invalid: readonly (readonly [string, Json, Json])[] = [
    ['an uninterpreted operation field', { operation: 'create', artifactIndex: 0, overwrite: true }, created('n.md', 'x\n')],
    ['a missing artifact', { operation: 'create', artifactIndex: 4 }, created('n.md', 'x\n')],
    ['a non-integer artifact index', { operation: 'create', artifactIndex: '0' }, created('n.md', 'x\n')],
    ['an unsupported mode', { operation: 'create', artifactIndex: 0, fileMode: '120000' }, created('n.md', 'x\n')],
    ['a mode on a deletion', { operation: 'delete', artifactIndex: 0, fileMode: '100644' }, deleted('obsolete.txt')],
    ['a deletion artifact describing content', { operation: 'delete', artifactIndex: 0 }, deleted('obsolete.txt', { contents: { text: 'first line\n' } })],
    ['a deletion artifact declaring a length', { operation: 'delete', artifactIndex: 0 }, deleted('obsolete.txt', { length: 23 })],
    ['a declared length that is wrong', { operation: 'create', artifactIndex: 0 }, created('n.md', 'x\n', { length: 3 })],
    ['a verifiable hash that is wrong', { operation: 'create', artifactIndex: 0 }, created('n.md', 'x\n', { hashes: { 'sha-256': '00' } })],
  ];
  for (const [label, op, artifact] of invalid) {
    test(`${label} blocks`, async () => {
      assertBlocked((await prepare(log(run([carrying('x', [op])], [artifact])))).outcome, 'file-operation-invalid', '/runs/0/results/0');
    });
  }

  test('a nested artifact blocks', async () => {
    const sarif = log(run([carrying('x', [createOp(1)])], [created('a.zip', 'zip\n'), created('inner.txt', 'x\n', { parentIndex: 0 })]));
    assertBlocked((await prepare(sarif)).outcome, 'nested-artifact-unsupported', '/runs/0/results/0');
  });

  test('a traversal path blocks (A20)', async () => {
    assertBlocked((await prepare(oneCreation('../escape.txt', 'x\n'))).outcome, 'uri-traversal');
  });

  test('an encoded separator blocks (A20)', async () => {
    assertBlocked((await prepare(oneCreation('docs%2Fx.md', 'x\n'))).outcome, 'uri-encoded-separator');
  });

  for (const [label, uri] of [['an encoded newline', 'bad%0Aname.md'], ['leading whitespace', '%20lead.md'], ['a bidirectional override', 'x%E2%80%AE.md']] as const) {
    test(`a path with ${label} cannot be shown exactly and blocks`, async () => {
      assertBlocked((await prepare(oneCreation(uri, 'x\n'))).outcome, 'file-operation-path-unrepresentable');
    });
  }

  test('a run bound to another commit cannot propose a file relative to the reviewed one', async () => {
    const sarif = log(run([carrying('x', [createOp(0)])], [created('n.md', 'x\n')], {
      versionControlProvenance: [{ repositoryUri: 'https://github.com/acme/widgets', revisionId: OTHER }],
    }));
    assertBlocked((await prepare(sarif)).outcome, 'file-operation-source-not-reviewed', '/runs/0/results/0');
  });
});

describe('size limits: whole-review refusal, never truncation', () => {
  /** The body of one creation of `size` letters on one line, from the contract template. */
  const bodyFor = (size: number): string => creationSection('big.txt',
    `${String(size)} bytes of UTF-8 text · no line breaks · no newline at end of file · mode 100644`,
    `\`\`\`\n${'x'.repeat(size)}\n\`\`\``, [item('Big.')]);
  let exact = 59000;
  while (bodyFor(exact).length < 60000) exact += 1;
  assert.equal(bodyFor(exact).length, 60000, 'the template reaches exactly the limit');

  test('a body of exactly 60,000 characters is prepared in full', async () => {
    const sarif = log(run([carrying('Big.', [createOp(0)])], [created('big.txt', 'x'.repeat(exact))]));
    const { outcome } = await prepare(sarif);
    assertReady(outcome);
    assert.equal(outcome.review.body, bodyFor(exact));
  });

  test('one character over blocks the whole review, naming the proposal and its size', async () => {
    const sarif = log(run([carrying('Big.', [createOp(0)])], [created('big.txt', 'x'.repeat(exact + 1))]));
    const { outcome } = await prepare(sarif);
    assertBlocked(outcome, 'body-too-large');
    const diagnostic = outcome.diagnostics.find((d) => d.code === 'body-too-large');
    assert.ok(diagnostic && diagnostic.message.includes('60001') && diagnostic.message.includes('big.txt'), JSON.stringify(diagnostic));
  });

  test('several proposals that together exceed the limit block, listing each', async () => {
    const half = 'y'.repeat(31000);
    const sarif = log(run([carrying('A.', [createOp(0)]), carrying('B.', [createOp(1)])], [created('a.txt', half), created('b.txt', half)]));
    const { outcome } = await prepare(sarif);
    assertBlocked(outcome, 'body-too-large');
    const message = outcome.diagnostics.find((d) => d.code === 'body-too-large')?.message ?? '';
    assert.ok(message.includes('a.txt') && message.includes('b.txt'), message);
  });
});
