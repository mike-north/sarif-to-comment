'use strict';

/**
 * Runs one publication or recovery attempt in its own Node process.
 *
 * Restart, crash and concurrency tests need genuinely separate processes: the
 * only things shared between attempts are the on-disk publication state and
 * the on-disk fake remote. Nothing in module variables survives.
 *
 * argv[2] is a JSON object:
 *   { statePath, remoteDir, operation?, user?, input?, barrierPath? }
 * `operation` is 'publish' (default) or 'recover'. `user` overrides the
 * authenticated { id, login }. `input` overrides fixture input fields.
 * `barrierPath`, when given, makes the process wait until that file exists so
 * several children can be released at the same moment.
 *
 * Prints exactly one JSON line to stdout: either { result } (with any `cause`
 * reduced to its message) or { thrown: { name, code, message } }.
 */

const fs = require('node:fs');
const path = require('node:path');

const { publishPreparedReview, recoverPublication } = require('../../../src/publication.cjs');
const { FakeGitHubRemote, DEFAULT_USER } = require('./fake-github.cjs');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'prepared-review.json'), 'utf8'));

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function main() {
  const args = JSON.parse(process.argv[2]);
  if (args.barrierPath) {
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(args.barrierPath)) {
      if (Date.now() > deadline) throw new Error('barrier never released');
      sleepMs(2);
    }
  }
  const remote = new FakeGitHubRemote(args.remoteDir);
  const input = { ...FIXTURE.input, ...(args.input || {}) };
  const common = {
    destination: input.destination,
    reviewedCommit: input.reviewedCommit,
    inputFingerprint: input.inputFingerprint,
    statePath: args.statePath,
    transport: remote.transport({ user: args.user || DEFAULT_USER }),
  };
  try {
    const result =
      args.operation === 'recover'
        ? await recoverPublication(common)
        : await publishPreparedReview({ ...common, preparedReview: input.preparedReview });
    const printable = { ...result };
    if (printable.cause) printable.cause = { message: String(printable.cause.message) };
    process.stdout.write(JSON.stringify({ result: printable }) + '\n');
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ thrown: { name: err.name, code: err.code, message: err.message } }) + '\n',
    );
  }
}

main();
