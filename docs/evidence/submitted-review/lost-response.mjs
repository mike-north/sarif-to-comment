// Publishes a submitted review through the installed package, discarding the
// create-review response after GitHub has received the request, so the
// package must rediscover the review by its marker. Uses the package's
// private injection seam only to wrap fetch; everything else is the product.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const dist = path.resolve('consumer/node_modules/sarif-to-comment/dist');
const require = createRequire(path.join(dist, 'index.cjs'));
const { publishSarifReviewWithInternals } = require(path.join(dist, 'publish-sarif-review.cjs'));
const { createGitHubClient } = require(path.join(dist, 'github.cjs'));

const log = [];
const lossyFetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = (init.method || 'GET').toUpperCase();
  const response = await fetch(input, init);
  log.push({ method, path: new URL(url).pathname, status: response.status });
  if (method === 'POST' && /\/pulls\/\d+\/reviews$/.test(new URL(url).pathname)) {
    throw new TypeError('simulated lost response: the create reached GitHub, its answer was discarded');
  }
  return response;
};

const outcome = await publishSarifReviewWithInternals(
  {
    sarif: JSON.parse(readFileSync(process.env.REVIEW_SARIF, 'utf8')),
    destination: { owner: 'mike-north', repo: 'doc-linter', pullNumber: Number(process.env.REVIEW_PULL) },
    reviewedCommit: process.env.REVIEW_COMMIT,
    statePath: process.env.REVIEW_STATE,
    token: process.env.GH_TOKEN,
    options: { submit: true },
  },
  { createGitHubClient: (options) => createGitHubClient({ ...options, fetch: lossyFetch }) },
);
const creates = log.filter((r) => r.method === 'POST' && /\/reviews$/.test(r.path)).length;
process.stdout.write(`${JSON.stringify({ outcome, createRequests: creates, requests: log }, null, 2)}\n`);
