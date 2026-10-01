/**
 * The GitHub client's companion suggestion pull request transport
 * (src/github.cts, docs/companion-suggestion-pr-contract.md §2.6–§2.10) at the
 * HTTP boundary: exact request bodies and query strings, the verification
 * reads of a created proposal commit, answer classification (which refusals
 * are definitive), and input refused before any request.
 *
 * Every answer is scripted per request; an unscripted request fails the test.
 * Expected bodies are written by hand from the GitHub REST documentation.
 *
 * @see https://docs.github.com/en/rest/git/blobs#create-a-blob
 * @see https://docs.github.com/en/rest/git/trees#create-a-tree
 * @see https://docs.github.com/en/rest/git/commits#create-a-commit
 * @see https://docs.github.com/en/rest/git/refs
 * @see https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request
 * @see https://docs.github.com/en/rest/pulls/pulls#list-pull-requests
 * @see https://docs.github.com/en/rest/issues/labels
 * @see https://docs.github.com/en/rest/repos/repos#get-a-repository
 * @see https://docs.github.com/en/rest/git/blobs#get-a-blob
 * @see https://docs.github.com/en/rest/git/trees#get-a-tree
 */

import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { describe, test } from 'node:test';

import { GitHubError, createGitHubClient } from '../dist/github.cjs';
import type { IGitHubClient } from '../dist/github.cjs';
import { asRecord, parseJson } from './support/runtime-types.mts';

const API = 'https://api.github.com';
const TOKEN = 'ghp_SUGGESTION_TRANSPORT_0123456789';
const REPO = `${API}/repos/octo/widgets`;
const PARENT = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
const ROOT = '1111111111111111111111111111111111111111';
const SRC = '2222222222222222222222222222222222222222';
const TREE = '3333333333333333333333333333333333333333';
const COMMIT = '4444444444444444444444444444444444444444';
const NEW_ROOT_SRC = '5555555555555555555555555555555555555555';
const OLD_BLOB = '6666666666666666666666666666666666666666';

interface ISent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

type Answer = () => Response;

/** A scripted host: each `METHOD url` answers from its queue, in order. */
class Script {
  readonly sent: ISent[] = [];
  private readonly answers = new Map<string, Answer[]>();

  on(method: string, url: string, ...answers: Answer[]): this {
    this.answers.set(`${method} ${url}`, [...(this.answers.get(`${method} ${url}`) ?? []), ...answers]);
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- fetch is async by contract
  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init.method ?? 'GET';
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${TOKEN}`);
    this.sent.push({ method, url, body: typeof init.body === 'string' ? parseJson(init.body) : undefined });
    const queue = this.answers.get(`${method} ${url}`);
    const next = queue?.shift();
    if (next === undefined) throw new assert.AssertionError({ message: `unscripted request ${method} ${url}` });
    return next();
  };

  client(): IGitHubClient {
    return createGitHubClient({ token: TOKEN, fetch: this.fetch });
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Answer =>
  () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function blobId(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${String(bytes.length)}\0`), bytes])).digest('hex');
}

const CLIENT_TEXT = 'export const retry = 1;\n';
const TEST_TEXT = "test('retry', () => {});\n";

/** The parent commit's trees: src/client.ts (100644) and obsolete.txt. */
function parentTrees(script: Script): Script {
  return script
    .on('GET', `${REPO}/git/commits/${PARENT}`, json({ sha: PARENT, tree: { sha: ROOT } }))
    .on('GET', `${REPO}/git/trees/${ROOT}`, json({
      sha: ROOT,
      truncated: false,
      tree: [
        { path: 'src', mode: '040000', type: 'tree', sha: SRC },
        { path: 'obsolete.txt', mode: '100644', type: 'blob', sha: OLD_BLOB, size: 3 },
      ],
    }))
    .on('GET', `${REPO}/git/trees/${SRC}`, json({ sha: SRC, truncated: false, tree: [{ path: 'client.ts', mode: '100755', type: 'blob', sha: OLD_BLOB, size: 3 }] }));
}

/** The created commit's trees, as a faithful host answers them. */
function createdTrees(script: Script, parents: readonly string[] = [PARENT]): Script {
  return script
    .on('GET', `${REPO}/git/commits/${COMMIT}`, json({ sha: COMMIT, tree: { sha: TREE }, parents: parents.map((sha) => ({ sha })) }))
    .on('GET', `${REPO}/git/trees/${TREE}`, json({
      sha: TREE,
      truncated: false,
      tree: [
        { path: 'src', mode: '040000', type: 'tree', sha: NEW_ROOT_SRC },
        { path: 'test.ts', mode: '100644', type: 'blob', sha: blobId(TEST_TEXT), size: 25 },
      ],
    }))
    .on('GET', `${REPO}/git/trees/${NEW_ROOT_SRC}`, json({
      sha: NEW_ROOT_SRC, truncated: false, tree: [{ path: 'client.ts', mode: '100755', type: 'blob', sha: blobId(CLIENT_TEXT), size: 24 }],
    }));
}

const CHANGES = [
  { operation: 'edit', path: 'src/client.ts', text: CLIENT_TEXT },
  { operation: 'create', path: 'test.ts', text: TEST_TEXT, fileMode: '100644' },
  { operation: 'delete', path: 'obsolete.txt' },
] as const;

function commitScript(): Script {
  return createdTrees(parentTrees(new Script()))
    .on('POST', `${REPO}/git/blobs`, json({ sha: blobId(CLIENT_TEXT) }, 201), json({ sha: blobId(TEST_TEXT) }, 201))
    .on('POST', `${REPO}/git/trees`, json({ sha: TREE }, 201))
    .on('POST', `${REPO}/git/commits`, json({ sha: COMMIT }, 201));
}

async function rejectsWith(promise: Promise<unknown>, code: string, hostRejected?: boolean): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof GitHubError, String(err));
    assert.equal(err.code, code);
    if (hostRejected !== undefined) assert.equal(err.hostRejected, hostRejected);
    return true;
  });
}

describe('createProposalCommit', () => {
  test('sends exact blobs, a tree on the parent\'s tree and a one-parent commit, then verifies them', async () => {
    const script = commitScript();
    const result = await script.client().createProposalCommit({ owner: 'octo', repo: 'widgets', parent: PARENT, message: 'Suggestion', changes: CHANGES });
    assert.deepEqual(result, { commit: COMMIT });
    const writes = script.sent.filter((r) => r.method === 'POST');
    assert.deepEqual(writes, [
      { method: 'POST', url: `${REPO}/git/blobs`, body: { content: Buffer.from(CLIENT_TEXT).toString('base64'), encoding: 'base64' } },
      { method: 'POST', url: `${REPO}/git/blobs`, body: { content: Buffer.from(TEST_TEXT).toString('base64'), encoding: 'base64' } },
      {
        method: 'POST',
        url: `${REPO}/git/trees`,
        body: {
          base_tree: ROOT,
          tree: [
            { path: 'src/client.ts', mode: '100755', type: 'blob', sha: blobId(CLIENT_TEXT) },
            { path: 'test.ts', mode: '100644', type: 'blob', sha: blobId(TEST_TEXT) },
            { path: 'obsolete.txt', mode: '100644', type: 'blob', sha: null },
          ],
        },
      },
      { method: 'POST', url: `${REPO}/git/commits`, body: { message: 'Suggestion', tree: TREE, parents: [PARENT] } },
    ]);
  });

  test('a blob id other than the one computed from the proposed bytes is refused', async () => {
    const script = parentTrees(new Script()).on('POST', `${REPO}/git/blobs`, json({ sha: OLD_BLOB }, 201));
    await rejectsWith(script.client().createProposalCommit({ owner: 'octo', repo: 'widgets', parent: PARENT, message: 'm', changes: CHANGES }), 'blob-integrity');
  });

  test('a created commit with another parent is refused', async () => {
    const script = createdTrees(parentTrees(new Script()), [OLD_BLOB])
      .on('POST', `${REPO}/git/blobs`, json({ sha: blobId(CLIENT_TEXT) }, 201), json({ sha: blobId(TEST_TEXT) }, 201))
      .on('POST', `${REPO}/git/trees`, json({ sha: TREE }, 201))
      .on('POST', `${REPO}/git/commits`, json({ sha: COMMIT }, 201));
    await rejectsWith(script.client().createProposalCommit({ owner: 'octo', repo: 'widgets', parent: PARENT, message: 'm', changes: CHANGES }), 'blob-integrity');
  });

  test('a created tree that still holds a deleted file is refused', async () => {
    const script = parentTrees(new Script())
      .on('GET', `${REPO}/git/commits/${COMMIT}`, json({ sha: COMMIT, tree: { sha: TREE }, parents: [{ sha: PARENT }] }))
      .on('GET', `${REPO}/git/trees/${TREE}`, json({ sha: TREE, truncated: false, tree: [{ path: 'obsolete.txt', mode: '100644', type: 'blob', sha: OLD_BLOB }] }))
      .on('POST', `${REPO}/git/trees`, json({ sha: TREE }, 201))
      .on('POST', `${REPO}/git/commits`, json({ sha: COMMIT }, 201));
    await rejectsWith(
      script.client().createProposalCommit({ owner: 'octo', repo: 'widgets', parent: PARENT, message: 'm', changes: [{ operation: 'delete', path: 'obsolete.txt' }] }),
      'blob-integrity',
    );
  });

  test('creating a path that exists, or editing one that does not, is refused before any write', async () => {
    const script = parentTrees(new Script());
    const c = script.client();
    await rejectsWith(c.createProposalCommit({
      owner: 'octo', repo: 'widgets', parent: PARENT, message: 'm', changes: [{ operation: 'create', path: 'obsolete.txt', text: 'x', fileMode: '100644' }],
    }), 'source-inconsistent');
    await rejectsWith(c.createProposalCommit({
      owner: 'octo', repo: 'widgets', parent: PARENT, message: 'm', changes: [{ operation: 'edit', path: 'missing.txt', text: 'x' }],
    }), 'source-inconsistent');
    assert.equal(script.sent.some((r) => r.method === 'POST'), false);
  });

  test('a write failure is never classified as a definitive refusal', async () => {
    const script = parentTrees(new Script()).on('POST', `${REPO}/git/blobs`, json({ message: 'Forbidden' }, 403));
    await rejectsWith(script.client().createProposalCommit({ owner: 'octo', repo: 'widgets', parent: PARENT, message: 'm', changes: CHANGES }), 'http-status', false);
  });

  test('malformed changes are refused before any request', async () => {
    const script = new Script();
    const c = script.client();
    const invalid: readonly unknown[] = [
      [],
      [{ operation: 'edit', path: '../x', text: '' }],
      [{ operation: 'create', path: 'a', text: '', fileMode: '120000' }],
      [{ operation: 'rename', path: 'a' }],
      [{ operation: 'delete', path: 'a' }, { operation: 'delete', path: 'a' }],
    ];
    for (const changes of invalid) {
      await assert.rejects(async () => {
        const pending: unknown = Reflect.apply(c.createProposalCommit, undefined, [{ owner: 'octo', repo: 'widgets', parent: PARENT, message: 'm', changes }]);
        await pending;
      }, TypeError);
    }
    assert.deepEqual(script.sent, []);
  });
});

describe('branches', () => {
  const BRANCH = 'suggestion-pr/7/0f0e0d0c-0b0a-4908-8706-050403020100';
  const REF_URL = `${REPO}/git/ref/heads/suggestion-pr/7/0f0e0d0c-0b0a-4908-8706-050403020100`;

  test('getBranch reads one reference: its commit, or null for 404', async () => {
    const script = new Script()
      .on('GET', REF_URL, json({ ref: `refs/heads/${BRANCH}`, object: { sha: COMMIT, type: 'commit' } }), json({ message: 'Not Found' }, 404));
    const c = script.client();
    assert.equal(await c.getBranch({ owner: 'octo', repo: 'widgets', branch: BRANCH }), COMMIT);
    assert.equal(await c.getBranch({ owner: 'octo', repo: 'widgets', branch: BRANCH }), null);
  });

  test('getBranch refuses an answer for another reference, and a server error is not absence', async () => {
    const script = new Script()
      .on('GET', REF_URL, json({ ref: 'refs/heads/other', object: { sha: COMMIT } }), json({ message: 'Server Error' }, 502));
    const c = script.client();
    await rejectsWith(c.getBranch({ owner: 'octo', repo: 'widgets', branch: BRANCH }), 'malformed-response');
    await rejectsWith(c.getBranch({ owner: 'octo', repo: 'widgets', branch: BRANCH }), 'http-status');
  });

  test('createBranch posts the reference once; 422 is a definitive refusal, 502 is not', async () => {
    const script = new Script().on('POST', `${REPO}/git/refs`, json({ ref: `refs/heads/${BRANCH}` }, 201), json({ message: 'Reference already exists' }, 422), json({}, 502));
    const c = script.client();
    await c.createBranch({ owner: 'octo', repo: 'widgets', branch: BRANCH, commit: COMMIT });
    assert.deepEqual(script.sent[0]?.body, { ref: `refs/heads/${BRANCH}`, sha: COMMIT });
    await rejectsWith(c.createBranch({ owner: 'octo', repo: 'widgets', branch: BRANCH, commit: COMMIT }), 'http-status', true);
    await rejectsWith(c.createBranch({ owner: 'octo', repo: 'widgets', branch: BRANCH, commit: COMMIT }), 'http-status', false);
  });
});

describe('pull requests and labels', () => {
  const BRANCH = 'suggestion-pr/7/abc';
  const LIST = `${REPO}/pulls?head=octo%3Asuggestion-pr%2F7%2Fabc&state=all&per_page=100&page=`;

  test('createPullRequest creates a draft or a ready pull request, as asked; its refusals are definitive', async () => {
    const created = json({ number: 101, html_url: 'https://github.com/octo/widgets/pull/101' }, 201);
    const script = new Script().on('POST', `${REPO}/pulls`, created, created, json({ message: 'Validation Failed' }, 422));
    const c = script.client();
    const request = { owner: 'octo', repo: 'widgets', title: 'Suggestion for #7: x', head: BRANCH, base: 'feature', body: 'Suggested…', draft: true };
    assert.deepEqual(await c.createPullRequest(request), { number: 101, htmlUrl: 'https://github.com/octo/widgets/pull/101' });
    assert.deepEqual(script.sent[0]?.body, { title: 'Suggestion for #7: x', head: BRANCH, base: 'feature', body: 'Suggested…', draft: true });
    await c.createPullRequest({ ...request, draft: false });
    assert.deepEqual(script.sent[1]?.body, { title: 'Suggestion for #7: x', head: BRANCH, base: 'feature', body: 'Suggested…', draft: false });
    await rejectsWith(c.createPullRequest(request), 'http-status', true);
  });

  test('createPullRequest refuses a missing or non-boolean draft before any request', async () => {
    const script = new Script();
    const c = script.client();
    const request = { owner: 'octo', repo: 'widgets', title: 't', head: BRANCH, base: 'feature', body: 'b' };
    for (const draft of [undefined, 'true', 1]) {
      await assert.rejects(async () => {
        const pending: unknown = Reflect.apply(c.createPullRequest, undefined, [{ ...request, draft }]);
        await pending;
      }, TypeError);
    }
    assert.deepEqual(script.sent, []);
  });

  test('listBranchPullRequests filters by head and state on every page, and refuses a link that drops the filter', async () => {
    const pr = (number: number): unknown => ({
      number, html_url: `https://github.com/octo/widgets/pull/${String(number)}`, body: 'b', user: { id: 1 },
      head: { ref: BRANCH, repo: { full_name: 'octo/widgets' } }, base: { ref: 'feature' },
    });
    const script = new Script()
      .on('GET', `${LIST}1`, json([pr(101)], 200, { link: `<${LIST}2>; rel="next"` }))
      .on('GET', `${LIST}2`, json([pr(102)]));
    const listed = await script.client().listBranchPullRequests({ owner: 'octo', repo: 'widgets', branch: BRANCH });
    assert.deepEqual(listed.map((p) => [p.number, p.headRef, p.baseRef, p.authorId, p.headRepository]), [
      [101, BRANCH, 'feature', 1, 'octo/widgets'],
      [102, BRANCH, 'feature', 1, 'octo/widgets'],
    ]);
    const unsafe = new Script().on('GET', `${LIST}1`, json([], 200, { link: `<${REPO}/pulls?state=all&per_page=100&page=2>; rel="next"` }));
    await rejectsWith(unsafe.client().listBranchPullRequests({ owner: 'octo', repo: 'widgets', branch: BRANCH }), 'unsafe-link');
  });

  test('addLabels sends every label in one request; listLabels reads every name', async () => {
    const script = new Script()
      .on('POST', `${REPO}/issues/101/labels`, json([{ name: 'suggestion-pr' }, { name: 'team-a' }]), json({ message: 'Not Found' }, 404))
      .on('GET', `${REPO}/issues/101/labels?per_page=100&page=1`, json([{ name: 'bug' }, { name: 'suggestion-pr' }]));
    const c = script.client();
    await c.addLabels({ owner: 'octo', repo: 'widgets', number: 101, labels: ['suggestion-pr', 'team-a'] });
    assert.deepEqual(script.sent[0]?.body, { labels: ['suggestion-pr', 'team-a'] });
    await rejectsWith(c.addLabels({ owner: 'octo', repo: 'widgets', number: 101, labels: ['suggestion-pr'] }), 'http-status', true);
    assert.deepEqual(await c.listLabels({ owner: 'octo', repo: 'widgets', number: 101 }), ['bug', 'suggestion-pr']);
  });

  test('addLabels refuses an empty list or an empty name before any request', async () => {
    const script = new Script();
    const c = script.client();
    for (const labels of [[], [''], 'suggestion-pr']) {
      await assert.rejects(async () => {
        const pending: unknown = Reflect.apply(c.addLabels, undefined, [{ owner: 'octo', repo: 'widgets', number: 101, labels }]);
        await pending;
      }, TypeError);
    }
    assert.deepEqual(script.sent, []);
  });

  test('findLabel reads the label by its encoded name, answers GitHub\'s own name, and null for 404', async () => {
    const script = new Script()
      .on('GET', `${REPO}/labels/proposed%20change`, json({ name: 'Proposed Change' }), json({ message: 'Not Found' }, 404));
    const c = script.client();
    assert.equal(await c.findLabel({ owner: 'octo', repo: 'widgets', name: 'proposed change' }), 'Proposed Change');
    assert.equal(await c.findLabel({ owner: 'octo', repo: 'widgets', name: 'proposed change' }), null);
  });
});

describe('readSuggestionTarget', () => {
  const pull = (head: unknown): Answer => json({ head, base: { sha: PARENT, ref: 'main', repo: { full_name: 'octo/widgets' } } });
  const repository = json({ default_branch: 'main', permissions: { push: true } });

  test('reads the head and base branches, both repositories, the default branch and push permission', async () => {
    const script = new Script().on('GET', `${REPO}/pulls/7`, pull({ sha: PARENT, ref: 'feature', repo: { full_name: 'fork/widgets' } })).on('GET', REPO, repository);
    assert.deepEqual(await script.client().readSuggestionTarget({ owner: 'octo', repo: 'widgets', pullNumber: 7 }), {
      headSha: PARENT, headRef: 'feature', headRepository: 'fork/widgets', baseRef: 'main', baseRepository: 'octo/widgets', defaultBranch: 'main', canPush: true,
    });
  });

  test('a missing base branch is malformed', async () => {
    const script = new Script()
      .on('GET', `${REPO}/pulls/7`, json({ head: { sha: PARENT, ref: 'feature', repo: { full_name: 'octo/widgets' } }, base: { sha: PARENT, repo: { full_name: 'octo/widgets' } } }))
      .on('GET', REPO, repository);
    await rejectsWith(script.client().readSuggestionTarget({ owner: 'octo', repo: 'widgets', pullNumber: 7 }), 'malformed-response');
  });

  test('a deleted head repository reads as null; a missing head branch is malformed', async () => {
    const deleted = new Script().on('GET', `${REPO}/pulls/7`, pull({ sha: PARENT, ref: 'feature', repo: null })).on('GET', REPO, json({ default_branch: 'main' }));
    const target = await deleted.client().readSuggestionTarget({ owner: 'octo', repo: 'widgets', pullNumber: 7 });
    assert.equal(target.headRepository, null);
    assert.equal(target.canPush, false, 'no permissions object means no known push permission');
    const missing = new Script().on('GET', `${REPO}/pulls/7`, pull({ sha: PARENT, repo: { full_name: 'octo/widgets' } })).on('GET', REPO, repository);
    await rejectsWith(missing.client().readSuggestionTarget({ owner: 'octo', repo: 'widgets', pullNumber: 7 }), 'malformed-response');
  });

  test('its reads never write', async () => {
    const script = new Script().on('GET', `${REPO}/pulls/7`, pull({ sha: PARENT, ref: 'feature', repo: { full_name: 'octo/widgets' } })).on('GET', REPO, repository);
    await script.client().readSuggestionTarget({ owner: 'octo', repo: 'widgets', pullNumber: 7 });
    assert.deepEqual(script.sent.map((r) => r.method), ['GET', 'GET']);
    assert.equal(asRecord(script.sent[0] ?? {})['body'], undefined);
  });
});

/**
 * Ancestry (docs/companion-suggestion-pr-contract.md §2.5; issue #28): GitHub's
 * three-dot comparison of the reviewed commit with the pull request's head.
 * Its `status` is `identical`, `ahead` (the base is an ancestor of the head),
 * `behind` (the head is an ancestor of the base) or `diverged`, and its merge
 * base must agree with what the status claims.
 *
 * @see https://docs.github.com/en/rest/commits/commits#compare-two-commits
 */
describe('compareCommits (issue #28)', () => {
  const REVIEWED = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
  const HEAD = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
  const OTHER = '0000000000000000000000000000000000000c0c';
  const url = `${REPO}/compare/${REVIEWED}...${HEAD}`;
  const request = { owner: 'octo', repo: 'widgets', base: REVIEWED, head: HEAD };
  const answer = (status: unknown, mergeBase: unknown): Answer => json({ status, ahead_by: 1, behind_by: 0, merge_base_commit: { sha: mergeBase } });

  for (const [status, mergeBase] of [['ahead', REVIEWED], ['identical', REVIEWED], ['behind', HEAD], ['diverged', OTHER]] as const) {
    test(`answers ${status} from one read of the three-dot comparison`, async () => {
      const script = new Script().on('GET', url, answer(status, mergeBase));
      assert.equal(await script.client().compareCommits(request), status);
      assert.deepEqual(script.sent.map((r) => `${r.method} ${r.url}`), [`GET ${url}`]);
    });
  }

  test('an unknown status is malformed, never guessed', async () => {
    for (const status of ['unrelated', 'AHEAD', null, 3]) {
      await rejectsWith(new Script().on('GET', url, answer(status, REVIEWED)).client().compareCommits(request), 'malformed-response');
    }
  });

  test('a merge base that contradicts the status is malformed: ahead and identical name the base, behind the head', async () => {
    for (const [status, mergeBase] of [['ahead', OTHER], ['identical', HEAD], ['behind', REVIEWED], ['ahead', undefined]] as const) {
      await rejectsWith(new Script().on('GET', url, answer(status, mergeBase)).client().compareCommits(request), 'malformed-response');
    }
  });

  test('a refused read is an operational failure, never a verdict', async () => {
    await rejectsWith(new Script().on('GET', url, json({ message: 'Not Found' }, 404)).client().compareCommits(request), 'http-status', false);
    await rejectsWith(new Script().on('GET', url, json({ message: 'Server Error' }, 502)).client().compareCommits(request), 'http-status', false);
  });

  test('refuses malformed commits or names before any request', async () => {
    const script = new Script();
    const c = script.client();
    await assert.rejects(c.compareCommits({ ...request, base: REVIEWED.slice(0, 7) }), TypeError);
    await assert.rejects(c.compareCommits({ ...request, head: HEAD.toUpperCase() }), TypeError);
    await assert.rejects(c.compareCommits({ ...request, owner: 'octo/x' }), TypeError);
    assert.deepEqual(script.sent, []);
  });
});

/**
 * The reads of the companion fidelity projection
 * (docs/companion-suggestion-pr-contract.md §2.5.1): the comparison with its
 * merge base, shared with compareCommits; a commit's whole tree, read
 * recursively; a blob's verified bytes; and a pull request's `mergeable`.
 *
 * @see https://docs.github.com/en/rest/commits/commits#compare-two-commits
 * @see https://docs.github.com/en/rest/git/trees#get-a-tree
 * @see https://docs.github.com/en/rest/git/blobs#get-a-blob
 * @see https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 */
describe('the projection\'s reads: readComparison, readTreeRecursive, readBlobBytes, readPullMergeability', () => {
  const REVIEWED = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
  const HEAD = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
  const BASE = '0000000000000000000000000000000000000c0c';
  const compareUrl = `${REPO}/compare/${REVIEWED}...${HEAD}`;
  const request = { owner: 'octo', repo: 'widgets', base: REVIEWED, head: HEAD };

  test('readComparison answers the status and the merge base GitHub names, sharing one read with compareCommits', async () => {
    const script = new Script().on('GET', compareUrl, json({ status: 'diverged', merge_base_commit: { sha: BASE } }));
    const c = script.client();
    assert.deepEqual(await c.readComparison(request), { status: 'diverged', mergeBase: BASE });
    assert.equal(await c.compareCommits(request), 'diverged');
    assert.deepEqual(await c.readComparison(request), { status: 'diverged', mergeBase: BASE });
    assert.deepEqual(script.sent.map((r) => `${r.method} ${r.url}`), [`GET ${compareUrl}`], 'one read of the comparison per client');
  });

  test('readComparison: no merge base is null; a malformed one, or one contradicting the status, is malformed; a failed read is asked again', async () => {
    assert.deepEqual(await new Script().on('GET', compareUrl, json({ status: 'diverged' })).client().readComparison(request), { status: 'diverged', mergeBase: null });
    await rejectsWith(new Script().on('GET', compareUrl, json({ status: 'diverged', merge_base_commit: { sha: 'abc' } })).client().readComparison(request), 'malformed-response');
    await rejectsWith(new Script().on('GET', compareUrl, json({ status: 'ahead', merge_base_commit: { sha: BASE } })).client().readComparison(request), 'malformed-response');
    const retried = new Script().on('GET', compareUrl, json({ message: 'Server Error' }, 502), json({ status: 'ahead', merge_base_commit: { sha: REVIEWED } }));
    const c = retried.client();
    await rejectsWith(c.readComparison(request), 'http-status');
    assert.deepEqual(await c.readComparison(request), { status: 'ahead', mergeBase: REVIEWED });
  });

  const RECURSIVE = `${REPO}/git/trees/${ROOT}?recursive=1`;
  const listing = [
    { path: 'src', mode: '040000', type: 'tree', sha: SRC },
    { path: 'src/client.ts', mode: '100755', type: 'blob', sha: OLD_BLOB, size: 3 },
    { path: 'link', mode: '120000', type: 'blob', sha: OLD_BLOB, size: 3 },
    { path: 'vendor/lib', mode: '160000', type: 'commit', sha: COMMIT },
  ];

  test('readTreeRecursive reads the commit\'s root tree once, recursively, with every entry by full path', async () => {
    const script = new Script()
      .on('GET', `${REPO}/git/commits/${PARENT}`, json({ sha: PARENT, tree: { sha: ROOT } }))
      .on('GET', RECURSIVE, json({ sha: ROOT, truncated: false, tree: listing }));
    const c = script.client();
    const tree = await c.readTreeRecursive({ owner: 'octo', repo: 'widgets', commit: PARENT });
    assert.deepEqual(tree, { truncated: false, entries: listing });
    assert.deepEqual(await c.readTreeRecursive({ owner: 'octo', repo: 'widgets', commit: PARENT }), tree);
    assert.equal(script.sent.length, 2, 'the commit and the tree, each read once');
  });

  test('readTreeRecursive passes GitHub\'s truncated flag on, never treating a truncated listing as complete', async () => {
    const script = new Script()
      .on('GET', `${REPO}/git/commits/${PARENT}`, json({ sha: PARENT, tree: { sha: ROOT } }))
      .on('GET', RECURSIVE, json({ sha: ROOT, truncated: true, tree: listing.slice(0, 1) }));
    assert.equal((await script.client().readTreeRecursive({ owner: 'octo', repo: 'widgets', commit: PARENT })).truncated, true);
  });

  for (const [what, tree] of [
    ['an unknown mode', [{ path: 'a', mode: '100600', type: 'blob', sha: OLD_BLOB }]],
    ['a mode of another type', [{ path: 'a', mode: '160000', type: 'blob', sha: OLD_BLOB }]],
    ['a path listed twice', [{ path: 'a', mode: '100644', type: 'blob', sha: OLD_BLOB }, { path: 'a', mode: '100644', type: 'blob', sha: OLD_BLOB }]],
    ['a dot-dot segment', [{ path: 'a/../b', mode: '100644', type: 'blob', sha: OLD_BLOB }]],
    ['a leading slash', [{ path: '/a', mode: '100644', type: 'blob', sha: OLD_BLOB }]],
    ['a malformed id', [{ path: 'a', mode: '100644', type: 'blob', sha: 'xyz' }]],
  ] as const) {
    test(`readTreeRecursive refuses a listing with ${what} as malformed`, async () => {
      const script = new Script()
        .on('GET', `${REPO}/git/commits/${PARENT}`, json({ sha: PARENT, tree: { sha: ROOT } }))
        .on('GET', RECURSIVE, json({ sha: ROOT, truncated: false, tree }));
      await rejectsWith(script.client().readTreeRecursive({ owner: 'octo', repo: 'widgets', commit: PARENT }), 'malformed-response');
    });
  }

  test('readTreeRecursive refuses an answer for another tree', async () => {
    const script = new Script()
      .on('GET', `${REPO}/git/commits/${PARENT}`, json({ sha: PARENT, tree: { sha: ROOT } }))
      .on('GET', RECURSIVE, json({ sha: SRC, truncated: false, tree: listing }));
    await rejectsWith(script.client().readTreeRecursive({ owner: 'octo', repo: 'widgets', commit: PARENT }), 'blob-integrity');
  });

  const TEXT = 'line one\nline two\n';
  const BLOB = blobId(TEXT);
  const blobAnswer = (text: string, sha = BLOB): Answer => json({ sha, encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text) });

  test('readBlobBytes answers the exact bytes, verified against the blob id, and reads each blob once', async () => {
    const script = new Script().on('GET', `${REPO}/git/blobs/${BLOB}`, blobAnswer(TEXT));
    const c = script.client();
    assert.equal(Buffer.from(await c.readBlobBytes({ owner: 'octo', repo: 'widgets', blob: BLOB })).toString('utf8'), TEXT);
    assert.equal(Buffer.from(await c.readBlobBytes({ owner: 'octo', repo: 'widgets', blob: BLOB })).toString('utf8'), TEXT);
    assert.equal(script.sent.length, 1);
  });

  test('readBlobBytes refuses bytes that do not hash to the requested id, and a blob over the read limit', async () => {
    await rejectsWith(new Script().on('GET', `${REPO}/git/blobs/${BLOB}`, blobAnswer('other\n')).client().readBlobBytes({ owner: 'octo', repo: 'widgets', blob: BLOB }), 'blob-integrity');
    const big = 'x'.repeat(2000);
    const limited = new Script().on('GET', `${REPO}/git/blobs/${blobId(big)}`, blobAnswer(big, blobId(big)));
    const c = createGitHubClient({ token: TOKEN, fetch: limited.fetch, limits: { maxSourceBytes: 1000 } });
    await rejectsWith(c.readBlobBytes({ owner: 'octo', repo: 'widgets', blob: blobId(big) }), 'source-too-large');
  });

  test('readPullMergeability answers GitHub\'s mergeable: true, false, or null while it computes it', async () => {
    const url = `${REPO}/pulls/101`;
    for (const mergeable of [true, false, null]) {
      const script = new Script().on('GET', url, json({ number: 101, mergeable }));
      assert.deepEqual(await script.client().readPullMergeability({ owner: 'octo', repo: 'widgets', pullNumber: 101 }), { mergeable });
    }
    await rejectsWith(new Script().on('GET', url, json({ number: 101, mergeable: 'yes' })).client().readPullMergeability({ owner: 'octo', repo: 'widgets', pullNumber: 101 }), 'malformed-response');
    await rejectsWith(new Script().on('GET', url, json({ number: 102, mergeable: true })).client().readPullMergeability({ owner: 'octo', repo: 'widgets', pullNumber: 101 }), 'malformed-response');
  });

  test('refuses malformed input before any request', async () => {
    const script = new Script();
    const c = script.client();
    await assert.rejects(c.readComparison({ ...request, base: REVIEWED.slice(0, 7) }), TypeError);
    await assert.rejects(c.readTreeRecursive({ owner: 'octo', repo: 'widgets', commit: 'HEAD' }), TypeError);
    await assert.rejects(c.readBlobBytes({ owner: 'octo/x', repo: 'widgets', blob: BLOB }), TypeError);
    await assert.rejects(c.readPullMergeability({ owner: 'octo', repo: 'widgets', pullNumber: 0 }), TypeError);
    assert.deepEqual(script.sent, []);
  });
});

describe('readDefaultBranchFile (docs/suggestion-pr-convention.md §4)', () => {
  const DEFAULT_HEAD = '7777777777777777777777777777777777777777';
  const DEFAULT_ROOT = '8888888888888888888888888888888888888888';
  const GITHUB_DIR = '9999999999999999999999999999999999999999';
  const CONFIG_TEXT = '{ "label": "proposal" }\n';
  const request = { owner: 'octo', repo: 'widgets', path: '.github/suggestion-prs.json' };

  /** The default branch `trunk` at DEFAULT_HEAD, whose .github holds `entry` under the configuration's name. */
  function defaultBranch(script: Script, entry: Record<string, unknown> | null): Script {
    return script
      .on('GET', REPO, json({ default_branch: 'trunk', permissions: { push: true } }))
      .on('GET', `${REPO}/git/ref/heads/trunk`, json({ ref: 'refs/heads/trunk', object: { sha: DEFAULT_HEAD, type: 'commit' } }))
      .on('GET', `${REPO}/git/commits/${DEFAULT_HEAD}`, json({ sha: DEFAULT_HEAD, tree: { sha: DEFAULT_ROOT } }))
      .on('GET', `${REPO}/git/trees/${DEFAULT_ROOT}`, json({ sha: DEFAULT_ROOT, truncated: false, tree: [{ path: '.github', mode: '040000', type: 'tree', sha: GITHUB_DIR }] }))
      .on('GET', `${REPO}/git/trees/${GITHUB_DIR}`, json({ sha: GITHUB_DIR, truncated: false, tree: entry === null ? [] : [{ path: 'suggestion-prs.json', ...entry }] }));
  }

  test('reads the file at the default branch\'s current commit through Git objects, as exact bytes', async () => {
    const sha = blobId(CONFIG_TEXT);
    const script = defaultBranch(new Script(), { mode: '100644', type: 'blob', sha, size: 24 })
      .on('GET', `${REPO}/git/blobs/${sha}`, json({ sha, encoding: 'base64', content: Buffer.from(CONFIG_TEXT).toString('base64'), size: 24 }));
    const read = await script.client().readDefaultBranchFile(request);
    assert.equal(read.branch, 'trunk');
    assert.equal(read.commit, DEFAULT_HEAD);
    assert.equal(read.content.kind, 'file');
    assert.equal(Buffer.from(read.content.bytes).toString('utf8'), CONFIG_TEXT);
    assert.equal(script.sent.some((r) => r.url.includes('/contents/')), false, 'never the Contents API');
    assert.deepEqual([...new Set(script.sent.map((r) => r.method))], ['GET']);
  });

  test('bytes that are not UTF-8 are returned as they are, for the convention to judge', async () => {
    const raw = Buffer.from([0x7b, 0xff, 0x7d]);
    const sha = crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob 3\0'), raw])).digest('hex');
    const script = defaultBranch(new Script(), { mode: '100644', type: 'blob', sha, size: 3 })
      .on('GET', `${REPO}/git/blobs/${sha}`, json({ sha, encoding: 'base64', content: raw.toString('base64'), size: 3 }));
    const read = await script.client().readDefaultBranchFile(request);
    assert.deepEqual(read.content.kind === 'file' ? [...read.content.bytes] : null, [0x7b, 0xff, 0x7d]);
  });

  test('given the default branch already known, the repository is not read again', async () => {
    const script = new Script()
      .on('GET', `${REPO}/git/ref/heads/trunk`, json({ ref: 'refs/heads/trunk', object: { sha: DEFAULT_HEAD, type: 'commit' } }))
      .on('GET', `${REPO}/git/commits/${DEFAULT_HEAD}`, json({ sha: DEFAULT_HEAD, tree: { sha: DEFAULT_ROOT } }))
      .on('GET', `${REPO}/git/trees/${DEFAULT_ROOT}`, json({ sha: DEFAULT_ROOT, truncated: false, tree: [] }));
    const read = await script.client().readDefaultBranchFile({ ...request, branch: 'trunk' });
    assert.deepEqual(read, { branch: 'trunk', commit: DEFAULT_HEAD, content: { kind: 'absent' } });
    assert.deepEqual(script.sent.map((r) => r.url), [
      `${REPO}/git/ref/heads/trunk`, `${REPO}/git/commits/${DEFAULT_HEAD}`, `${REPO}/git/trees/${DEFAULT_ROOT}`,
    ]);
  });

  test('a client reads the repository once: the suggestion pull requests\' target reuses the configuration read\'s answer', async () => {
    const script = defaultBranch(new Script(), null)
      .on('GET', `${REPO}/pulls/7`, json({ head: { sha: PARENT, ref: 'feature', repo: { full_name: 'octo/widgets' } }, base: { sha: PARENT, ref: 'trunk', repo: { full_name: 'octo/widgets' } } }));
    const c = script.client();
    await c.readDefaultBranchFile(request);
    const target = await c.readSuggestionTarget({ owner: 'octo', repo: 'widgets', pullNumber: 7 });
    assert.equal(target.defaultBranch, 'trunk');
    assert.equal(target.canPush, true);
    assert.equal(script.sent.filter((r) => r.url === REPO).length, 1);
  });

  test('a failed repository read is not reused: the next read asks again', async () => {
    const script = defaultBranch(new Script().on('GET', REPO, json({ message: 'Server Error' }, 502)), null);
    const c = script.client();
    await rejectsWith(c.readDefaultBranchFile(request), 'http-status');
    assert.equal((await c.readDefaultBranchFile(request)).branch, 'trunk');
    assert.equal(script.sent.filter((r) => r.url === REPO).length, 2);
  });

  test('absent: a complete listing without the name', async () => {
    const read = await defaultBranch(new Script(), null).client().readDefaultBranchFile(request);
    assert.deepEqual(read, { branch: 'trunk', commit: DEFAULT_HEAD, content: { kind: 'absent' } });
  });

  test('absent: no .github directory at all', async () => {
    const script = new Script()
      .on('GET', REPO, json({ default_branch: 'trunk' }))
      .on('GET', `${REPO}/git/ref/heads/trunk`, json({ ref: 'refs/heads/trunk', object: { sha: DEFAULT_HEAD, type: 'commit' } }))
      .on('GET', `${REPO}/git/commits/${DEFAULT_HEAD}`, json({ sha: DEFAULT_HEAD, tree: { sha: DEFAULT_ROOT } }))
      .on('GET', `${REPO}/git/trees/${DEFAULT_ROOT}`, json({ sha: DEFAULT_ROOT, truncated: false, tree: [] }));
    assert.deepEqual((await script.client().readDefaultBranchFile(request)).content, { kind: 'absent' });
  });

  const notFiles: readonly (readonly [string, Record<string, unknown>])[] = [
    ['a directory', { mode: '040000', type: 'tree', sha: OLD_BLOB }],
    ['a symbolic link', { mode: '120000', type: 'blob', sha: OLD_BLOB, size: 5 }],
    ['a submodule', { mode: '160000', type: 'commit', sha: OLD_BLOB }],
  ];
  for (const [entry, treeEntry] of notFiles) {
    test(`${entry} at the path is not a file, and is never followed`, async () => {
      const script = defaultBranch(new Script(), treeEntry);
      assert.deepEqual((await script.client().readDefaultBranchFile(request)).content, { kind: 'not-a-file', entry, path: '.github/suggestion-prs.json' });
    });
  }

  test('a symbolic link above the path is not followed either, and is named where it is', async () => {
    const script = new Script()
      .on('GET', REPO, json({ default_branch: 'trunk' }))
      .on('GET', `${REPO}/git/ref/heads/trunk`, json({ ref: 'refs/heads/trunk', object: { sha: DEFAULT_HEAD, type: 'commit' } }))
      .on('GET', `${REPO}/git/commits/${DEFAULT_HEAD}`, json({ sha: DEFAULT_HEAD, tree: { sha: DEFAULT_ROOT } }))
      .on('GET', `${REPO}/git/trees/${DEFAULT_ROOT}`, json({ sha: DEFAULT_ROOT, truncated: false, tree: [{ path: '.github', mode: '120000', type: 'blob', sha: OLD_BLOB, size: 7 }] }));
    assert.deepEqual((await script.client().readDefaultBranchFile(request)).content, { kind: 'not-a-file', entry: 'a symbolic link', path: '.github' });
  });

  test('a file over the source limit is too large, and its blob is never downloaded', async () => {
    const script = defaultBranch(new Script(), { mode: '100644', type: 'blob', sha: OLD_BLOB, size: 1_000_001 });
    assert.deepEqual((await script.client().readDefaultBranchFile(request)).content, { kind: 'too-large', size: 1_000_001 });
    assert.equal(script.sent.some((r) => r.url.includes('/git/blobs/')), false);
  });

  test('a failed read is an error, never absence: the repository, the reference, a tree or the blob', async () => {
    await rejectsWith(new Script().on('GET', REPO, json({ message: 'Server Error' }, 502)).client().readDefaultBranchFile(request), 'http-status');
    const forbidden = new Script()
      .on('GET', REPO, json({ default_branch: 'trunk' }))
      .on('GET', `${REPO}/git/ref/heads/trunk`, json({ message: 'Resource not accessible' }, 403));
    await rejectsWith(forbidden.client().readDefaultBranchFile(request), 'http-status');
    const missingRef = new Script()
      .on('GET', REPO, json({ default_branch: 'trunk' }))
      .on('GET', `${REPO}/git/ref/heads/trunk`, json({ message: 'Not Found' }, 404));
    await rejectsWith(missingRef.client().readDefaultBranchFile(request), 'malformed-response');
    const tree = new Script()
      .on('GET', REPO, json({ default_branch: 'trunk' }))
      .on('GET', `${REPO}/git/ref/heads/trunk`, json({ ref: 'refs/heads/trunk', object: { sha: DEFAULT_HEAD, type: 'commit' } }))
      .on('GET', `${REPO}/git/commits/${DEFAULT_HEAD}`, json({ sha: DEFAULT_HEAD, tree: { sha: DEFAULT_ROOT } }))
      .on('GET', `${REPO}/git/trees/${DEFAULT_ROOT}`, json({ message: 'Server Error' }, 500));
    await rejectsWith(tree.client().readDefaultBranchFile(request), 'http-status');
    const sha = blobId(CONFIG_TEXT);
    const blob = defaultBranch(new Script(), { mode: '100644', type: 'blob', sha, size: 24 })
      .on('GET', `${REPO}/git/blobs/${sha}`, json({ sha, encoding: 'base64', content: Buffer.from('tampered text!!!!!!!!!!\n').toString('base64'), size: 24 }));
    await rejectsWith(blob.client().readDefaultBranchFile(request), 'blob-integrity');
  });

  test('its input is checked before any request', async () => {
    const script = new Script();
    const c = script.client();
    for (const bad of [{ ...request, owner: 'bad owner' }, { ...request, path: '/abs' }, { ...request, path: '../x' }, { ...request, branch: '' }, { ...request, branch: 7 }]) {
      await assert.rejects(async () => {
        const pending: unknown = Reflect.apply(c.readDefaultBranchFile, undefined, [bad]);
        await pending;
      }, TypeError);
    }
    assert.deepEqual(script.sent, []);
  });
});
