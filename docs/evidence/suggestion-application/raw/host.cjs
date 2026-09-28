'use strict';

/**
 * Independent host reader and guarded cleanup for the end-to-end evidence.
 *
 * Deliberately shares no code with src/: it reads GitHub with its own fetch
 * calls so readback does not depend on the adapter under test. Output is JSON
 * on stdout and never contains the credential (read from GH_TOKEN).
 *
 *   node host.cjs readback <pr>
 *     pull head/base, every review (all pages), and for each review authored by
 *     the authenticated user: every REST review comment (all pages) and every
 *     GraphQL review thread of the pull request rooted in that review.
 *   node host.cjs delete <pr> <reviewId> <marker>
 *     deletes one review only when it is authored by the authenticated user,
 *     is PENDING, and its body contains <marker> exactly once. Prints the
 *     checked review and the delete status. Never touches anything else.
 */

const OWNER = 'mike-north';
const REPO = 'doc-linter';
const API = 'https://api.github.com';
const token = process.env.GH_TOKEN;
if (!token) throw new Error('GH_TOKEN is required');

async function call(method, url, body) {
  const response = await fetch(url, {
    method,
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sarif-to-comment-e2e-evidence',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, link: response.headers.get('link'), json: text ? JSON.parse(text) : null };
}

async function all(path) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const r = await call('GET', `${API}${path}?per_page=100&page=${page}`);
    if (r.status !== 200) throw new Error(`GET ${path} page ${page}: HTTP ${r.status}`);
    items.push(...r.json);
    if (!r.link || !/rel="next"/.test(r.link)) return items;
  }
}

const THREADS = `query($o:String!,$r:String!,$n:Int!,$a:String){repository(owner:$o,name:$r){pullRequest(number:$n){
  reviewThreads(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{
    path subjectType isOutdated diffSide startDiffSide line startLine originalLine originalStartLine
    comments(first:100){nodes{databaseId body pullRequestReview{databaseId} originalCommit{oid} commit{oid}}}}}}}}`;

async function threads(pr) {
  const nodes = [];
  let after = null;
  for (;;) {
    const r = await call('POST', `${API}/graphql`, { query: THREADS, variables: { o: OWNER, r: REPO, n: pr, a: after } });
    if (r.status !== 200 || r.json.errors) throw new Error(`GraphQL: HTTP ${r.status} ${JSON.stringify(r.json.errors ?? '')}`);
    const t = r.json.data.repository.pullRequest.reviewThreads;
    nodes.push(...t.nodes);
    if (!t.pageInfo.hasNextPage) return nodes;
    after = t.pageInfo.endCursor;
  }
}

async function readback(pr) {
  const me = (await call('GET', `${API}/user`)).json;
  const pull = (await call('GET', `${API}/repos/${OWNER}/${REPO}/pulls/${pr}`)).json;
  const reviews = await all(`/repos/${OWNER}/${REPO}/pulls/${pr}/reviews`);
  const allThreads = await threads(pr);
  const owned = [];
  for (const review of reviews.filter((r) => r.user && r.user.id === me.id)) {
    const comments = await all(`/repos/${OWNER}/${REPO}/pulls/${pr}/reviews/${review.id}/comments`);
    owned.push({
      id: review.id,
      state: review.state,
      commit_id: review.commit_id,
      html_url: review.html_url,
      body: review.body,
      restComments: comments.map((c) => ({
        id: c.id,
        path: c.path,
        position: c.position,
        original_position: c.original_position,
        line: c.line ?? null,
        side: c.side ?? null,
        start_line: c.start_line ?? null,
        original_line: c.original_line ?? null,
        commit_id: c.commit_id,
        original_commit_id: c.original_commit_id,
        body: c.body,
      })),
      threads: allThreads
        .filter((t) => t.comments.nodes[0]?.pullRequestReview?.databaseId === review.id)
        .map((t) => ({
          path: t.path,
          subjectType: t.subjectType,
          isOutdated: t.isOutdated,
          diffSide: t.diffSide,
          startDiffSide: t.startDiffSide,
          line: t.line,
          startLine: t.startLine,
          originalLine: t.originalLine,
          originalStartLine: t.originalStartLine,
          commentIds: t.comments.nodes.map((c) => c.databaseId),
          originalCommit: t.comments.nodes[0].originalCommit?.oid ?? null,
        })),
    });
  }
  return {
    readAt: new Date().toISOString(),
    viewer: { login: me.login, id: me.id },
    pull: { number: pull.number, state: pull.state, head: pull.head.sha, base: pull.base.sha, headRef: pull.head.ref, baseRef: pull.base.ref },
    reviews: reviews.map((r) => ({ id: r.id, userId: r.user?.id, state: r.state, commit_id: r.commit_id })),
    ownedReviews: owned,
  };
}

async function remove(pr, reviewId, marker) {
  const me = (await call('GET', `${API}/user`)).json;
  const r = await call('GET', `${API}/repos/${OWNER}/${REPO}/pulls/${pr}/reviews/${reviewId}`);
  if (r.status !== 200) throw new Error(`review ${reviewId}: HTTP ${r.status}`);
  const review = r.json;
  const occurrences = review.body.split(marker).length - 1;
  const checked = { id: review.id, userId: review.user.id, viewerId: me.id, state: review.state, markerOccurrences: occurrences };
  if (review.user.id !== me.id || review.state !== 'PENDING' || occurrences !== 1) {
    return { checked, deleted: false, reason: 'ownership, state or marker check failed' };
  }
  const d = await call('DELETE', `${API}/repos/${OWNER}/${REPO}/pulls/${pr}/reviews/${reviewId}`);
  return { checked, deleted: d.status === 200, status: d.status };
}

/**
 * Submits one review as COMMENT, for the suggestion-application experiment
 * only (PR 16): the product itself never submits. Same ownership, PENDING and
 * single-marker checks as delete; the body is not changed.
 */
async function submitComment(pr, reviewId, marker) {
  if (pr !== 16) throw new Error('submit is limited to the suggestion-application fixture PR 16');
  const me = (await call('GET', `${API}/user`)).json;
  const review = (await call('GET', `${API}/repos/${OWNER}/${REPO}/pulls/${pr}/reviews/${reviewId}`)).json;
  const occurrences = review.body.split(marker).length - 1;
  const checked = { id: review.id, userId: review.user.id, viewerId: me.id, state: review.state, markerOccurrences: occurrences };
  if (review.user.id !== me.id || review.state !== 'PENDING' || occurrences !== 1) {
    return { checked, submitted: false, reason: 'ownership, state or marker check failed' };
  }
  const s = await call('POST', `${API}/repos/${OWNER}/${REPO}/pulls/${pr}/reviews/${reviewId}/events`, { event: 'COMMENT' });
  return {
    checked,
    submitted: s.status === 200,
    status: s.status,
    after: s.json && { id: s.json.id, state: s.json.state, commit_id: s.json.commit_id, submitted_at: s.json.submitted_at, bodyUnchanged: s.json.body === review.body },
  };
}

(async () => {
  const [command, pr, ...rest] = process.argv.slice(2);
  const result =
    command === 'readback' ? await readback(Number(pr))
    : command === 'delete' ? await remove(Number(pr), Number(rest[0]), rest[1])
    : command === 'submit-comment' ? await submitComment(Number(pr), Number(rest[0]), rest[1])
    : (() => { throw new Error('usage: readback <pr> | delete <pr> <reviewId> <marker>'); })();
  const text = JSON.stringify(result, null, 2);
  if (text.includes(token)) throw new Error('refusing to print output containing the credential');
  process.stdout.write(`${text}\n`);
})().catch((err) => {
  process.stderr.write(`${String(err.message).split(token).join('[redacted]')}\n`);
  process.exitCode = 1;
});
