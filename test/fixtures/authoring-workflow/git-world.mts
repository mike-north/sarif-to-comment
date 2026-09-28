'use strict';

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

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ORACLE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs', 'evidence', 'second-milestone', 'source-oracle.json'), 'utf8'),
);
const UPSTREAM_SARIF_PATH = path.join(ROOT, 'docs', 'evidence', 'second-milestone', 'upstream-input.sarif.json');
const DESTINATION = Object.freeze({ owner: 'octo', repo: 'review-fixture', pullNumber: 31 });
const SENTINEL = 'UNSTAGED SENTINEL';

/** Environment for Git that ignores the developer's configuration. */
function gitEnv(home) {
  return {
    PATH: process.env.PATH,
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
function git(cwd, env, args) {
  const run = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout;
}

/** Lines of `text` with terminators kept (the fake host's snapshot format). */
function physicalLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * A unified-diff hunk removing every line of `before` and adding every line of
 * `after`: a valid, if not minimal, diff of the two snapshots (the oracle's B
 * and H share no line). GitHub's `patch` omits the last newline.
 */
function wholeFilePatch(before, after) {
  const old = physicalLines(before);
  const next = physicalLines(after);
  const body = [`@@ -1,${old.length} +1,${next.length} @@\n`, ...old.map((l) => `-${l}`), ...next.map((l) => `+${l}`)];
  body[body.length - 1] = body[body.length - 1].replace(/\n$/, '');
  return body;
}

/**
 * Creates the repository from `spec` (default: the oracle). Returns
 * { root, dir, env, base, head, file, repository } where `repository` is the
 * fake GitHub repository for the same commits.
 */
function createGitWorld(label = 'git-world', spec = ORACLE, destination = DESTINATION) {
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

  const repository = {
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
function applyReplacements(text, replacements) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineEnd = (line) => (line < lineStarts.length ? lineStarts[line] : text.length);
  const offset = (line, column) => lineStarts[line - 1] + column - 1;
  const spans = replacements.map(({ deletedRegion: r, insertedContent }) => {
    assert.ok(Number.isInteger(r.startLine), 'this oracle only reads line/column regions');
    const endLine = r.endLine ?? r.startLine;
    const start = offset(r.startLine, r.startColumn ?? 1);
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

/** Every replacement of every fix of every result in a SARIF log, for `uri`. */
function replacementsFor(sarif, uri) {
  return sarif.runs.flatMap((run) =>
    (run.results ?? []).flatMap((result) =>
      (result.fixes ?? []).flatMap((fix) =>
        fix.artifactChanges.filter((c) => c.artifactLocation.uri === uri).flatMap((c) => c.replacements),
      ),
    ),
  );
}

/** Replacements with identical effect counted once (several findings may share one). */
function distinctReplacements(replacements) {
  const seen = new Map();
  for (const r of replacements) seen.set(JSON.stringify([r.deletedRegion, r.insertedContent]), r);
  return [...seen.values()];
}

module.exports = {
  ORACLE,
  UPSTREAM_SARIF_PATH,
  DESTINATION,
  SENTINEL,
  createGitWorld,
  applyReplacements,
  replacementsFor,
  distinctReplacements,
  physicalLines,
};
