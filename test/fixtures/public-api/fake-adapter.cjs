'use strict';

/**
 * Test double for the GitHub client the public API uses (src/github.cjs
 * `createGitHubClient`), injected through the private internals seam.
 *
 * It follows the adapter's contract shape: createGitHubClient({ token, fetch })
 * returns one client exposing the publication transport methods directly
 * (backed by the file-backed host double in ../publication/fake-github.cjs,
 * whose remote state is independent of local publication state) plus
 * fetchContext({ destination, reviewedCommit, oldSourceCommit? }) returning the
 * trusted review context and snapshot reader for whole-review preparation
 * (from repository.json). Everything is on disk, so the in-process tests and
 * the CLI child-process wrapper observe one shared remote.
 *
 * Every client creation and context fetch is recorded in the host double's
 * call log ('adapter:create', 'adapter:fetchContext'), and a configured network
 * outage records 'adapter:network-attempt' before throwing, so tests can prove
 * what was — and was not — contacted. The harness log records the raw token
 * only to prove which credential the CLI selected; product output and
 * publication state are checked separately and must never contain it.
 *
 * Behavior is configured per remote in adapter-config.json:
 *   context: 'ok'                     the pull head is the reviewed commit
 *            'historical'             the pull request advanced: the current
 *                                     diff ends at a later head
 *            'throw'                  context cannot be fetched
 *            'throw-with-token'       an error whose message quotes the token
 *            'throw-with-token-cause' a clean error whose cause and extra
 *                                     properties carry the token
 *            'wrong-commit'           context for another reviewed commit
 *            'wrong-pull'             context for another pull request
 *   network: 'up' | 'down'   // 'down': every host method throws
 *   user:    { id, login }   // authenticated identity
 *
 * This is not evidence of real GitHub behavior; real adapter integration is a
 * separate obligation.
 */

const fs = require('node:fs');
const path = require('node:path');

const { FakeGitHubRemote, DEFAULT_USER } = require('../publication/fake-github.cjs');

const REPOSITORY = JSON.parse(fs.readFileSync(path.join(__dirname, 'repository.json'), 'utf8'));
const DEFAULT_ADAPTER_CONFIG = Object.freeze({ context: 'ok', network: 'up', user: DEFAULT_USER });
const TRANSPORT_METHODS = ['getAuthenticatedUser', 'createReview', 'listReviews', 'listReviewComments'];

function configPath(remoteDir) {
  return path.join(remoteDir, 'adapter-config.json');
}

function readAdapterConfig(remoteDir) {
  const file = configPath(remoteDir);
  const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return { ...DEFAULT_ADAPTER_CONFIG, ...stored };
}

/** Atomically updates this remote's adapter behavior (temp file + rename). */
function setAdapterConfig(remoteDir, patch) {
  const next = { ...readAdapterConfig(remoteDir), ...patch };
  const tmp = path.join(remoteDir, 'tmp', `adapter-config-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, configPath(remoteDir));
}

function joinedDiff(diff, oldSourceCommit) {
  return {
    baseCommit: oldSourceCommit || diff.baseCommit,
    headCommit: diff.headCommit,
    files: diff.files.map((f) => ({ path: f.path, patch: f.patch.join('') })),
  };
}

/**
 * The context the adapter contract describes for the fixture pull request.
 * `historical`: the pull request has advanced past the reviewed commit; the
 * current diff is retained and ends at the later head.
 */
function trustedContext({ historical = false, oldSourceCommit } = {}) {
  const diff = historical ? REPOSITORY.advancedDiff : REPOSITORY.diff;
  return {
    owner: REPOSITORY.destination.owner,
    repo: REPOSITORY.destination.repo,
    pullNumber: REPOSITORY.destination.pullNumber,
    reviewedCommit: REPOSITORY.commits.head,
    pullHead: diff.headCommit,
    currentBaseTip: REPOSITORY.commits.base,
    diff: joinedDiff(diff, oldSourceCommit),
    fileDiagnostics: [],
  };
}

/** Exact file text at a commit, null when absent; unknown commits are operational errors. */
async function readSource(commit, filePath) {
  const snapshot = REPOSITORY.snapshots[commit];
  if (!snapshot) throw new Error(`fixture has no snapshot for commit ${commit}`);
  return Object.hasOwn(snapshot, filePath) ? snapshot[filePath].join('') : null;
}

function networkError() {
  return Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' });
}

/** Returns a createGitHubClient implementation bound to the remote at `remoteDir`. */
function createFakeClientFactory(remoteDir) {
  const remote = new FakeGitHubRemote(remoteDir);
  return function createGitHubClient({ token, fetch }) {
    remote.logCall('adapter:create', { token, fetchProvided: typeof fetch === 'function' });
    const config = readAdapterConfig(remoteDir);
    const transport = remote.transport({ user: config.user });
    const client = {};
    for (const method of TRANSPORT_METHODS) {
      client[method] =
        config.network === 'down'
          ? async () => {
              remote.logCall('adapter:network-attempt', { method });
              throw networkError();
            }
          : transport[method];
    }
    client.fetchContext = async (request) => {
      remote.logCall('adapter:fetchContext', request);
      if (config.network === 'down') {
        remote.logCall('adapter:network-attempt', { method: 'fetchContext' });
        throw networkError();
      }
      const oldSourceCommit = request.oldSourceCommit;
      switch (config.context) {
        case 'ok':
          return { context: trustedContext({ oldSourceCommit }), readSource };
        case 'historical':
          return { context: trustedContext({ historical: true, oldSourceCommit }), readSource };
        case 'throw':
          throw new Error('pull request head branch no longer exists');
        case 'throw-with-token':
          throw new Error(`GET /repos/acme/gizmos/pulls/7 failed; Authorization: token ${token}`);
        case 'throw-with-token-cause':
          throw Object.assign(new Error('GET /repos/acme/gizmos/pulls/7 failed', { cause: new Error(`bearer ${token}`) }), {
            request: { headers: { authorization: `Bearer ${token}` } },
          });
        case 'wrong-commit': {
          const context = trustedContext({ oldSourceCommit });
          context.reviewedCommit = REPOSITORY.commits.advanced;
          return { context, readSource };
        }
        case 'wrong-pull': {
          const context = trustedContext({ oldSourceCommit });
          context.pullNumber += 1;
          return { context, readSource };
        }
        default:
          throw new Error(`unknown adapter context mode ${config.context}`);
      }
    };
    return client;
  };
}

module.exports = {
  REPOSITORY,
  createFakeClientFactory,
  readAdapterConfig,
  readSource,
  setAdapterConfig,
  trustedContext,
};
