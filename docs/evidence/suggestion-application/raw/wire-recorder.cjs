'use strict';

/**
 * Preload (node -r) that wraps the real global fetch to record every GitHub
 * request the product makes, without altering it. Records method, URL,
 * request JSON body and response status; never records headers, so the
 * credential cannot appear. Appends one JSON line per request to WIRE_LOG.
 *
 * WIRE_LOSE_CREATE=1 turns the first create-review POST into a genuine lost
 * response: the request is really sent and answered by GitHub, then the
 * answer is discarded and the caller receives a network error.
 *
 * WIRE_CRASH_AFTER_CREATE=1 kills the process (SIGKILL) immediately after
 * GitHub answers the create, before the product sees the answer, so only the
 * durable intent written before sending survives for a fresh process.
 */

const fs = require('node:fs');

const log = process.env.WIRE_LOG;
const loseCreate = process.env.WIRE_LOSE_CREATE === '1';
const realFetch = globalThis.fetch;
let lost = false;

globalThis.fetch = async function recordedFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const method = String(init.method ?? 'GET').toUpperCase();
  let body = null;
  if (typeof init.body === 'string') {
    body = JSON.parse(init.body);
    if (body && typeof body.query === 'string') body = { query: '(GraphQL query)', variables: body.variables };
  }
  const entry = { at: new Date().toISOString(), method, url, body };
  const response = await realFetch(input, init);
  entry.status = response.status;
  const isCreate = method === 'POST' && /\/pulls\/\d+\/reviews$/.test(new URL(url).pathname);
  if (isCreate && process.env.WIRE_CRASH_AFTER_CREATE === '1') {
    entry.simulated = 'response received from GitHub, then the process was killed before handling it';
    fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
  if (isCreate && loseCreate && !lost) {
    lost = true;
    entry.simulated = 'response received from GitHub, then discarded as a lost response';
    fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
    throw new TypeError('fetch failed (simulated lost response after GitHub answered)');
  }
  fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
  return response;
};
