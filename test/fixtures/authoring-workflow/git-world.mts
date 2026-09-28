/**
 * A real local Git repository built from the parent's independently authored
 * source oracle (docs/evidence/second-milestone/source-oracle.json), plus the
 * fake GitHub repository that serves the same commits.
 *
 * The oracle gives four texts of `fixture/review.txt`:
 *   base (B)         the pull request's base commit
 *   reviewed (H)     the reviewed head commit
 *   staged (T)       what is staged in the index
 *   workingTree (W)  T with its last line replaced by an unstaged sentinel
 * B and H are real commits, T is staged with `git add`, and W is then written
 * to the working tree only, so the index and working tree deliberately differ.
 * Nothing here is derived from product output: the oracle was authored before
 * implementation and the pull request patch is written from B and H directly.
 *
 * `createGitWorld(label, spec)` builds the same kind of repository from any
 * other hand-authored spec of the same shape ({ path, base, reviewed, staged,
 * workingTree }), such as the contract's W1 example used by the documentation
 * tests.
 *
 * Git runs isolated from the developer's configuration (no global or system
 * config, fixed identity and dates), so commit ids are reproducible.
 *
 * @see https://git-scm.com/docs/git-add
 * @see https://git-scm.com/docs/git#Documentation/git.txt-codeGITCONFIGGLOBALcode
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import type { IHttpDestination, IHttpRepository } from '../composition/fake-http-github.mts';
import {
  expectType,
  isArrayOf,
  isNumber,
  isOptional,
  isShape,
  isString,
  readJson,
} from '../../support/runtime-types.mts';
import type { Guard } from '../../support/runtime-types.mts';

/** The four texts of one file a Git world is built from. */
export interface IGitWorldSpec {
  readonly path: string;
  readonly base: string;
  readonly reviewed: string;
  readonly staged: string;
  readonly workingTree: string;
}

/** One finding of the source oracle: its reviewed lines and the replacement it proposes. */
export interface IOracleFinding {
  readonly label: string;
  readonly line: number;
  readonly endLine: number;
  readonly message: string;
  readonly reviewedSource: string;
  readonly replacementLines: readonly string[];
  readonly expectedHostSide: string;
}

/** The source oracle document (docs/evidence/second-milestone/source-oracle.json). */
export interface ISourceOracle extends IGitWorldSpec {
  readonly findings: readonly IOracleFinding[];
}

/** A built Git world (see createGitWorld). */
export interface IGitWorld {
  readonly root: string;
  readonly dir: string;
  readonly env: Record<string, string | undefined>;
  readonly base: string;
  readonly head: string;
  readonly file: string;
  readonly repository: IHttpRepository;
}

/** A SARIF region as this oracle reads it: one-based line/column coordinates. */
export interface ISarifRegion {
  readonly startLine?: number | undefined;
  readonly startColumn?: number | undefined;
  readonly endLine?: number | undefined;
  readonly endColumn?: number | undefined;
}

/** A SARIF replacement: the region to delete and the content to insert. */
export interface ISarifReplacement {
  readonly deletedRegion: ISarifRegion;
  readonly insertedContent?: { readonly text?: string | undefined } | undefined;
}

const isSourceOracle: Guard<ISourceOracle> = isShape({
  path: isString,
  base: isString,
  reviewed: isString,
  staged: isString,
  workingTree: isString,
  findings: isArrayOf(
    isShape({
      label: isString,
      line: isNumber,
      endLine: isNumber,
      message: isString,
      reviewedSource: isString,
      replacementLines: isArrayOf(isString),
      expectedHostSide: isString,
    }),
  ),
});

const isSarifReplacement: Guard<ISarifReplacement> = isShape({
  deletedRegion: isShape({
    startLine: isOptional(isNumber),
    startColumn: isOptional(isNumber),
    endLine: isOptional(isNumber),
    endColumn: isOptional(isNumber),
  }),
  insertedContent: isOptional(isShape({ text: isOptional(isString) })),
});

/** The parts of a SARIF log replacementsFor reads; everything else is ignored. */
const isSarifWithFixes = isShape({
  runs: isArrayOf(
    isShape({
      results: isOptional(
        isArrayOf(
          isShape({
            fixes: isOptional(
              isArrayOf(
                isShape({
                  artifactChanges: isArrayOf(
                    isShape({ artifactLocation: isShape({ uri: isString }), replacements: isArrayOf(isSarifReplacement) }),
                  ),
                }),
              ),
            ),
          }),
        ),
      ),
    }),
  ),
});

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const ORACLE: ISourceOracle = expectType(
  readJson(path.join(ROOT, 'docs', 'evidence', 'second-milestone', 'source-oracle.json')),
  isSourceOracle,
  'the second-milestone source oracle',
);
export const UPSTREAM_SARIF_PATH = path.join(ROOT, 'docs', 'evidence', 'second-milestone', 'upstream-input.sarif.json');
export const DESTINATION: IHttpDestination = Object.freeze({ owner: 'octo', repo: 'review-fixture', pullNumber: 31 });
export const SENTINEL = 'UNSTAGED SENTINEL';

/** Environment for Git that ignores the developer's configuration. */
function gitEnv(home: string): Record<string, string | undefined> {
  return {
    PATH: process.env['PATH'],
    HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, 'empty-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Author',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Author',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-09-28T10:00:00Z',
    GIT_COMMITTER_DATE: '2026-09-28T10:00:00Z',
  };
}

/** Runs git in `cwd`; returns its exact stdout, failing loudly. */
function git(cwd: string, env: Record<string, string | undefined>, args: readonly string[]): string {
  const run = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout;
}

/** Lines of `text` with terminators kept (the fake host's snapshot format). */
export function physicalLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * A unified-diff hunk removing every line of `before` and adding every line of
 * `after`: a valid, if not minimal, diff of the two snapshots (the oracle's B
 * and H share no line). GitHub's `patch` omits the last newline.
 */
function wholeFilePatch(before: string, after: string): string[] {
  const old = physicalLines(before);
  const next = physicalLines(after);
  const body = [`@@ -1,${String(old.length)} +1,${String(next.length)} @@\n`, ...old.map((l) => `-${l}`), ...next.map((l) => `+${l}`)];
  // body is never empty: it starts with the hunk header.
  body[body.length - 1] = (body[body.length - 1] ?? '').replace(/\n$/, '');
  return body;
}

/**
 * Creates the repository from `spec` (default: the oracle). Returns
 * { root, dir, env, base, head, file, repository } where `repository` is the
 * fake GitHub repository for the same commits.
 */
export function createGitWorld(
  label = 'git-world',
  spec: IGitWorldSpec = ORACLE,
  destination: IHttpDestination = DESTINATION,
): IGitWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'empty-gitconfig'), '');
  const env = gitEnv(home);
  const dir = path.join(root, 'repo');
  fs.mkdirSync(dir);
  const file = path.join(dir, ...spec.path.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });

  git(dir, env, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(file, spec.base);
  git(dir, env, ['add', spec.path]);
  git(dir, env, ['commit', '-q', '-m', 'base']);
  const base = git(dir, env, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(file, spec.reviewed);
  git(dir, env, ['add', spec.path]);
  git(dir, env, ['commit', '-q', '-m', 'reviewed']);
  const head = git(dir, env, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(file, spec.staged);
  git(dir, env, ['add', spec.path]);
  fs.writeFileSync(file, spec.workingTree);

  // The world is only useful if the index and working tree really differ.
  assert.equal(git(dir, env, ['show', `:${spec.path}`]), spec.staged);
  assert.equal(fs.readFileSync(file, 'utf8'), spec.workingTree);

  const repository: IHttpRepository = {
    description: 'Fake GitHub view of the local oracle repository (commits are the real local commit ids).',
    destination,
    commits: { base, head },
    snapshots: {
      [base]: { [spec.path]: physicalLines(spec.base) },
      [head]: { [spec.path]: physicalLines(spec.reviewed) },
    },
    pullFiles: [
      {
        filename: spec.path,
        status: 'modified',
        additions: physicalLines(spec.reviewed).length,
        deletions: physicalLines(spec.base).length,
        patch: wholeFilePatch(spec.base, spec.reviewed),
      },
    ],
  };
  return { root, dir, env, base, head, file, repository };
}

/**
 * Applies SARIF replacements to `text` independently of the product: each
 * deletedRegion is converted to UTF-16 offsets from its one-based
 * line/column form (SARIF 2.1.0 §3.30; columnKind utf16CodeUnits; an omitted
 * startColumn is 1, an omitted endLine is startLine, and an omitted endColumn
 * is the end of endLine including its terminator). Replacements are applied
 * from the end so earlier offsets stay valid. Overlaps are refused.
 */
export function applyReplacements(text: string, replacements: readonly ISarifReplacement[]): string {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
  // Past the last line start, a line ends at the end of the text.
  const lineEnd = (line: number): number => lineStarts[line] ?? text.length;
  // A line that does not exist has no offset (NaN, as the index arithmetic gives).
  const offset = (line: number, column: number): number => (lineStarts[line - 1] ?? NaN) + column - 1;
  const spans = replacements.map(({ deletedRegion: r, insertedContent }) => {
    const { startLine } = r;
    assert.ok(startLine !== undefined && Number.isInteger(startLine), 'this oracle only reads line/column regions');
    const endLine = r.endLine ?? startLine;
    const start = offset(startLine, r.startColumn ?? 1);
    const end = r.endColumn === undefined ? lineEnd(endLine) : offset(endLine, r.endColumn);
    return { start, end, text: insertedContent?.text ?? '' };
  });
  spans.sort((a, b) => b.start - a.start);
  let out = text;
  let limit = Infinity;
  for (const span of spans) {
    assert.ok(span.end <= limit, 'replacements overlap');
    out = out.slice(0, span.start) + span.text + out.slice(span.end);
    limit = span.start;
  }
  return out;
}

/**
 * Every replacement of every fix of every result in a SARIF log, for `uri`.
 * The log is checked to have the shape read here (it may come from JSON.parse
 * or from the product).
 */
export function replacementsFor(sarif: unknown, uri: string): ISarifReplacement[] {
  const log = expectType(sarif, isSarifWithFixes, 'a SARIF log with runs[].results[].fixes[].artifactChanges[]');
  return log.runs.flatMap((run) =>
    (run.results ?? []).flatMap((result) =>
      (result.fixes ?? []).flatMap((fix) =>
        fix.artifactChanges.filter((c) => c.artifactLocation.uri === uri).flatMap((c) => c.replacements),
      ),
    ),
  );
}

/** Replacements with identical effect counted once (several findings may share one). */
export function distinctReplacements(replacements: readonly ISarifReplacement[]): ISarifReplacement[] {
  const seen = new Map<string, ISarifReplacement>();
  for (const r of replacements) seen.set(JSON.stringify([r.deletedRegion, r.insertedContent]), r);
  return [...seen.values()];
}
