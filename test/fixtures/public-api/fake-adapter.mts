/**
 * Test double for the GitHub client the public API uses (src/github.cts
 * `createGitHubClient`), injected through the private internals seam.
 *
 * It follows the adapter's contract shape: createGitHubClient({ token, fetch })
 * returns one client exposing the publication transport methods directly
 * (backed by the file-backed host double in ../publication/fake-github.mts,
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
 *            'historical'             the pull request advanced by an
 *                                     ordinary push: its head is a later
 *                                     commit, and the context's diff is still
 *                                     the reviewed diff, ending at the
 *                                     reviewed commit (docs/specification.md
 *                                     R13.1)
 *            'throw'                  context cannot be fetched
 *            'throw-with-token'       an error whose message quotes the token
 *            'throw-with-token-cause' a clean error whose cause and extra
 *                                     properties carry the token
 *            'wrong-commit'           context for another reviewed commit
 *            'wrong-pull'             context for another pull request
 *            'unauthorized'           GitHub refuses the credential (HTTP 401),
 *                                     as the real client reports it
 *            'source-read-fails'      the context is served, but every source
 *                                     read fails operationally (HTTP 502)
 *   network: 'up' | 'down'   // 'down': every host method throws
 *   user:    { id, login }   // authenticated identity
 *   deliveryConfiguration?: string | 'fail'
 *                            // readDefaultBranchFile's answer for the
 *                            // repository's .github/sarif-to-comment.json
 *                            // on the default branch `main`: absent unless
 *                            // given; a string is the file's text; 'fail'
 *                            // answers HTTP 502 (an operational failure)
 *                            // (docs/delivery-policy-contract.md §11)
 *
 * This is not evidence of real GitHub behavior; real adapter integration is a
 * separate obligation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { GitHubError } from '../../../dist/github.cjs';
import { DEFAULT_USER, FakeGitHubRemote } from '../publication/fake-github.mts';
import type { IFakeTransport, IFakeUser } from '../publication/fake-github.mts';
import {
  expectType,
  isArrayOf,
  isNumber,
  isOneOf,
  isOptional,
  isRecordOf,
  isShape,
  isString,
  readJson,
} from '../../support/runtime-types.mts';
import type { Guard } from '../../support/runtime-types.mts';

/** What fetchContext returns (see the header). */
export type ContextMode =
  | 'ok'
  | 'historical'
  | 'throw'
  | 'throw-with-token'
  | 'throw-with-token-cause'
  | 'wrong-commit'
  | 'wrong-pull'
  | 'unauthorized'
  | 'source-read-fails';

/** Adapter behavior, persisted per remote in adapter-config.json. */
export interface IAdapterConfig {
  readonly context: ContextMode;
  readonly network: 'up' | 'down';
  readonly user: IFakeUser;
  readonly deliveryConfiguration?: string | undefined;
}

/** One changed file of a fixture diff; `patch` is the patch text split into lines (terminators kept). */
export interface IAdapterDiffFile {
  readonly path: string;
  readonly patch: readonly string[];
}

/** A fixture diff between two commits. */
export interface IAdapterDiff {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly files: readonly IAdapterDiffFile[];
}

/** A pull request by owner, repository and number. */
export interface IAdapterDestination {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
}

/** The pull request the adapter serves (repository.json). */
export interface IAdapterRepository {
  readonly description?: string | undefined;
  readonly destination: IAdapterDestination;
  readonly commits: { readonly base: string; readonly head: string; readonly advanced: string };
  /** File text by commit, then by path, split into lines (terminators kept). */
  readonly snapshots: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  readonly diff: IAdapterDiff;
  readonly advancedDiff: IAdapterDiff;
}

/** A diff as the adapter contract returns it: each patch joined into one text. */
export interface ITrustedDiff {
  baseCommit: string;
  headCommit: string;
  files: { path: string; patch: string }[];
}

/** The trusted review context of the adapter contract. Mutable so a mode can falsify one field. */
export interface ITrustedContext {
  owner: string;
  repo: string;
  pullNumber: number;
  reviewedCommit: string;
  pullHead: string;
  currentBaseTip: string;
  diff: ITrustedDiff;
  fileDiagnostics: unknown[];
}

/** trustedContext options. */
export interface ITrustedContextOptions {
  readonly historical?: boolean | undefined;
  readonly oldSourceCommit?: string | undefined;
}

/** fetchContext's request (the adapter contract's). */
export interface IFakeContextRequest {
  readonly destination: IAdapterDestination;
  readonly reviewedCommit: string;
  readonly oldSourceCommit?: string | undefined;
}

/** Exact file text at a commit; null when the file is absent there. */
export type FakeReadSource = (commit: string, filePath: string) => Promise<string | null>;

/** fetchContext's result. */
export interface IFakeFetchedContext {
  readonly context: ITrustedContext;
  readonly readSource: FakeReadSource;
}

/** The fake client: the publication transport methods, fetchContext, and the reads that associate the reviewed commit. */
export interface IFakeGitHubClient {
  readonly getAuthenticatedUser: IFakeTransport['getAuthenticatedUser'];
  readonly createReview: IFakeTransport['createReview'];
  readonly listReviews: IFakeTransport['listReviews'];
  readonly listReviewComments: IFakeTransport['listReviewComments'];
  readonly fetchContext: (request: IFakeContextRequest) => Promise<IFakeFetchedContext>;
  readonly readDefaultBranchFile: (request: { readonly owner: string; readonly repo: string; readonly path: string; readonly branch?: string }) => Promise<IFakeDefaultBranchFile>;
  readonly compareCommits: (request: { readonly owner: string; readonly repo: string; readonly base: string; readonly head: string }) => Promise<'identical' | 'ahead' | 'behind' | 'diverged'>;
  readonly listHeadRefForcePushes: (request: IAdapterDestination) => Promise<{ readonly beforeCommits: readonly (string | null)[]; readonly complete: boolean }>;
}

/** readDefaultBranchFile's answer (the GitHub client's IDefaultBranchFile). */
export interface IFakeDefaultBranchFile {
  readonly branch: string;
  readonly commit: string;
  readonly content: { readonly kind: 'absent' } | { readonly kind: 'file'; readonly bytes: Uint8Array };
}

/** The options the product passes to createGitHubClient. */
export interface IFakeClientOptions {
  readonly token: string;
  readonly fetch?: unknown;
}

/** A createGitHubClient implementation. */
export type FakeClientFactory = (options: IFakeClientOptions) => IFakeGitHubClient;

const isAdapterDestination: Guard<IAdapterDestination> = isShape({ owner: isString, repo: isString, pullNumber: isNumber });

const isAdapterDiff: Guard<IAdapterDiff> = isShape({
  baseCommit: isString,
  headCommit: isString,
  files: isArrayOf(isShape({ path: isString, patch: isArrayOf(isString) })),
});

const isAdapterRepository: Guard<IAdapterRepository> = isShape({
  description: isOptional(isString),
  destination: isAdapterDestination,
  commits: isShape({ base: isString, head: isString, advanced: isString }),
  snapshots: isRecordOf(isRecordOf(isArrayOf(isString))),
  diff: isAdapterDiff,
  advancedDiff: isAdapterDiff,
});

/** A stored adapter-config.json (setAdapterConfig always writes the complete configuration). */
const isStoredAdapterConfig: Guard<IAdapterConfig> = isShape({
  context: isOneOf(
    'ok',
    'historical',
    'throw',
    'throw-with-token',
    'throw-with-token-cause',
    'wrong-commit',
    'wrong-pull',
    'unauthorized',
    'source-read-fails',
  ),
  network: isOneOf('up', 'down'),
  user: isShape({ id: isNumber, login: isOptional(isString) }),
  deliveryConfiguration: isOptional(isString),
});

export const REPOSITORY: IAdapterRepository = expectType(
  readJson(path.join(import.meta.dirname, 'repository.json')),
  isAdapterRepository,
  'the adapter fixture repository',
);
const DEFAULT_ADAPTER_CONFIG: Readonly<IAdapterConfig> = Object.freeze({ context: 'ok', network: 'up', user: DEFAULT_USER });

function configPath(remoteDir: string): string {
  return path.join(remoteDir, 'adapter-config.json');
}

export function readAdapterConfig(remoteDir: string): IAdapterConfig {
  const file = configPath(remoteDir);
  const stored = fs.existsSync(file) ? expectType(readJson(file), isStoredAdapterConfig, `adapter config in ${file}`) : {};
  return { ...DEFAULT_ADAPTER_CONFIG, ...stored };
}

/** Atomically updates this remote's adapter behavior (temp file + rename). */
export function setAdapterConfig(remoteDir: string, patch: Partial<IAdapterConfig>): void {
  const next = { ...readAdapterConfig(remoteDir), ...patch };
  const tmp = path.join(remoteDir, 'tmp', `adapter-config-${String(process.pid)}-${String(Date.now())}.json`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, configPath(remoteDir));
}

function joinedDiff(diff: IAdapterDiff, oldSourceCommit: string | undefined): ITrustedDiff {
  return {
    baseCommit: oldSourceCommit || diff.baseCommit,
    headCommit: diff.headCommit,
    files: diff.files.map((f) => ({ path: f.path, patch: f.patch.join('') })),
  };
}

/**
 * The context the adapter contract describes for the fixture pull request.
 * `historical`: the pull request has advanced past the reviewed commit, so
 * its head is the later commit, while the diff is the reviewed diff, ending
 * at the reviewed commit (docs/specification.md R13.1).
 */
export function trustedContext({ historical = false, oldSourceCommit }: ITrustedContextOptions = {}): ITrustedContext {
  return {
    owner: REPOSITORY.destination.owner,
    repo: REPOSITORY.destination.repo,
    pullNumber: REPOSITORY.destination.pullNumber,
    reviewedCommit: REPOSITORY.commits.head,
    pullHead: historical ? REPOSITORY.commits.advanced : REPOSITORY.commits.head,
    currentBaseTip: REPOSITORY.commits.base,
    diff: joinedDiff(REPOSITORY.diff, oldSourceCommit),
    fileDiagnostics: [],
  };
}

/** Exact file text at a commit, null when absent; unknown commits are operational errors. */
// eslint-disable-next-line @typescript-eslint/require-await -- async by contract: an unknown commit is a rejection, not a synchronous throw
export async function readSource(commit: string, filePath: string): Promise<string | null> {
  const snapshot = REPOSITORY.snapshots[commit];
  if (!snapshot) throw new Error(`fixture has no snapshot for commit ${commit}`);
  const lines = Object.hasOwn(snapshot, filePath) ? snapshot[filePath] : undefined;
  return lines ? lines.join('') : null;
}

function networkError(): Error & { code: string } {
  return Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' });
}

/** Returns a createGitHubClient implementation bound to the remote at `remoteDir`. */
export function createFakeClientFactory(remoteDir: string): FakeClientFactory {
  const remote = new FakeGitHubRemote(remoteDir);
  return function createGitHubClient({ token, fetch }) {
    remote.logCall('adapter:create', { token, fetchProvided: typeof fetch === 'function' });
    const config = readAdapterConfig(remoteDir);
    const transport = remote.transport({ user: config.user });
    /* eslint-disable @typescript-eslint/require-await -- client methods are async by contract: failures, including synchronous throws, reach the caller as rejections */
    /** A transport method during an outage: records the attempt, then fails as DNS resolution would. */
    const unreachable =
      (method: string) =>
      async (): Promise<never> => {
        remote.logCall('adapter:network-attempt', { method });
        throw networkError();
      };
    const down = config.network === 'down';
    return {
      getAuthenticatedUser: down ? unreachable('getAuthenticatedUser') : transport.getAuthenticatedUser,
      createReview: down ? unreachable('createReview') : transport.createReview,
      listReviews: down ? unreachable('listReviews') : transport.listReviews,
      listReviewComments: down ? unreachable('listReviewComments') : transport.listReviewComments,
      readDefaultBranchFile: async (request) => {
        remote.logCall('adapter:readDefaultBranchFile', { path: request.path });
        if (down) {
          remote.logCall('adapter:network-attempt', { method: 'readDefaultBranchFile' });
          throw networkError();
        }
        const configured = config.deliveryConfiguration;
        if (configured === 'fail') {
          throw new GitHubError('http-status', `GitHub answered HTTP 502 (Bad Gateway) reading ${request.path} on the default branch main.`, { status: 502 });
        }
        const content = configured === undefined || request.path !== '.github/sarif-to-comment.json'
          ? { kind: 'absent' as const }
          : { kind: 'file' as const, bytes: new Uint8Array(Buffer.from(configured)) };
        return { branch: 'main', commit: REPOSITORY.commits.base, content };
      },
      // The fixture's commits form one line, base -> head -> advanced, with
      // no force-push: whatever is compared, the earlier commit is an ancestor.
      compareCommits: async (request) => {
        remote.logCall('adapter:compareCommits', request);
        const order = [REPOSITORY.commits.base, REPOSITORY.commits.head, REPOSITORY.commits.advanced];
        const [from, to] = [order.indexOf(request.base), order.indexOf(request.head)];
        if (from === -1 || to === -1) throw new GitHubError('http-status', 'GitHub answered HTTP 404 (Not Found) comparing commits.', { status: 404 });
        return from === to ? 'identical' : from < to ? 'ahead' : 'behind';
      },
      listHeadRefForcePushes: async (request) => {
        remote.logCall('adapter:listHeadRefForcePushes', request);
        return { beforeCommits: [], complete: true };
      },
      fetchContext: async (request) => {
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
          case 'unauthorized':
            throw new GitHubError('http-status', 'GitHub answered HTTP 401 (Bad credentials) for GET /repos/acme/gizmos/pulls/7.', {
              status: 401,
            });
          case 'source-read-fails':
            return {
              context: trustedContext({ oldSourceCommit }),
              readSource: async (commit, filePath) => {
                remote.logCall('adapter:readSource', { commit, path: filePath });
                throw new GitHubError('http-status', `GitHub answered HTTP 502 (Bad Gateway) reading ${filePath} at ${commit}.`, {
                  status: 502,
                });
              },
            };
        }
      },
    };
    /* eslint-enable @typescript-eslint/require-await */
  };
}
