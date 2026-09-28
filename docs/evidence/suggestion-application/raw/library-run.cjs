'use strict';

/**
 * Calls the public library (require('sarif-to-comment') resolves to
 * src/index.cjs via package.json "main") exactly as a SARIF-producing project
 * would: SARIF in memory, real GitHub client, no test seams.
 *
 *   node library-run.cjs <pr> <reviewedCommit> <statePath> [oldSourceCommit]
 *
 * Prints the public outcome as JSON (the credential never appears).
 */

const fs = require('node:fs');
const path = require('node:path');
const { publishSarifReview } = require('../../../src/index.cjs');

(async () => {
  const [pr, reviewedCommit, statePath, oldSourceCommit] = process.argv.slice(2);
  const token = process.env.GH_TOKEN;
  const sarif = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.E2E_SARIF || 'fixture.sarif.json'), 'utf8'));
  const input = {
    sarif,
    destination: { owner: 'mike-north', repo: 'doc-linter', pullNumber: Number(pr) },
    reviewedCommit,
    statePath: path.resolve(statePath),
    token,
  };
  if (oldSourceCommit) input.oldSourceCommit = oldSourceCommit;
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = { startedAt, outcome: await publishSarifReview(input) };
  } catch (err) {
    result = { startedAt, thrown: { name: err.name, code: err.code, message: err.message } };
  }
  const text = JSON.stringify(result, null, 2);
  if (text.includes(token)) throw new Error('credential in output');
  process.stdout.write(`${text}\n`);
})();
