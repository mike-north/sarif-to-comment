'use strict';
/**
 * Evidence helper, preloaded with NODE_OPTIONS=--require=<this file>: wraps
 * the global fetch and appends one line per request, `METHOD PATH`, to the
 * file named by REQUEST_LOG. Only the method and the URL's path (with a
 * GraphQL query reduced to the first field it asks of the repository or
 * pull request) are recorded: never headers, so never the token. It changes
 * no request and no response.
 */
const fs = require('node:fs');
const file = process.env.REQUEST_LOG;
const original = globalThis.fetch;
if (file && typeof original === 'function') {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    let line = `${init.method || 'GET'} ${url.pathname}`;
    if (url.pathname === '/graphql' && typeof init.body === 'string') {
      const query = JSON.parse(init.body).query || '';
      const field = /pullRequest\(number: \$number\) \{\s*(\w+)/.exec(query) || /repository\([^)]*\) \{\s*(\w+)/.exec(query);
      line += ` (${field ? field[1] : 'query'})`;
    }
    fs.appendFileSync(file, `${line}\n`);
    return original(input, init);
  };
}
