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

import * as fs from 'node:fs';
import * as path from 'node:path';

import { publishPreparedReview, recoverPublication } from '../../../dist/publication.cjs';
import { FakeGitHubRemote, DEFAULT_USER } from './fake-github.mts';
import type { IFakeUser } from './fake-github.mts';
import {
  expectType,
  isNumber,
  isOptional,
  isRecord,
  isShape,
  isString,
  parseJson,
  readJson,
} from '../../support/runtime-types.mts';
import type { Guard, UnknownRecord } from '../../support/runtime-types.mts';

/** The JSON object in argv[2] (see the header). */
export interface IChildPublishArgs {
  readonly statePath: string;
  readonly remoteDir: string;
  readonly operation?: string | undefined;
  readonly user?: IFakeUser | undefined;
  readonly input?: UnknownRecord | undefined;
  readonly barrierPath?: string | undefined;
}

const isChildPublishArgs: Guard<IChildPublishArgs> = isShape({
  statePath: isString,
  remoteDir: isString,
  operation: isOptional(isString),
  user: isOptional(isShape({ id: isNumber, login: isOptional(isString) })),
  input: isOptional(isRecord),
  barrierPath: isOptional(isString),
});

/**
 * prepared-review.json. Only `input` is read here, and its fields are passed
 * to the product unchecked (tests may override them with invalid values).
 */
const FIXTURE = expectType(
  readJson(path.join(import.meta.dirname, 'prepared-review.json')),
  isShape({ input: isRecord }),
  'the prepared-review fixture',
);

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The property `key` of a thrown value, or undefined when it has none (as a property read would give). */
function propertyOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

async function main(): Promise<void> {
  const args = expectType(parseJson(process.argv[2] ?? ''), isChildPublishArgs, 'the child-publish arguments (argv[2])');
  if (args.barrierPath) {
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(args.barrierPath)) {
      if (Date.now() > deadline) throw new Error('barrier never released');
      sleepMs(2);
    }
  }
  const remote = new FakeGitHubRemote(args.remoteDir);
  const input: UnknownRecord = { ...FIXTURE.input, ...(args.input || {}) };
  const common = {
    destination: input['destination'],
    reviewedCommit: input['reviewedCommit'],
    inputFingerprint: input['inputFingerprint'],
    statePath: args.statePath,
    transport: remote.transport({ user: args.user || DEFAULT_USER }),
  };
  try {
    const result =
      args.operation === 'recover'
        ? await recoverPublication(common)
        : await publishPreparedReview({ ...common, preparedReview: input['preparedReview'] });
    const printable: UnknownRecord = { ...result };
    if (printable['cause']) printable['cause'] = { message: String(propertyOf(printable['cause'], 'message')) };
    process.stdout.write(JSON.stringify({ result: printable }) + '\n');
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ thrown: { name: propertyOf(err, 'name'), code: propertyOf(err, 'code'), message: propertyOf(err, 'message') } }) +
        '\n',
    );
  }
}

void main();
