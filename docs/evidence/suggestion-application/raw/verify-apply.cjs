'use strict';

/**
 * Verifies one independent readback (host.cjs) of a PR #16 review against the
 * hand-authored expectations in docs/evidence/suggestion-application and the
 * exact create request the product saved in its publication state.
 *
 *   node verify-apply.cjs <readback.json> <reviewId> <statePath> <crlf|suggestions> [PENDING|COMMENTED]
 *
 * Byte-exact checks: the read-back body equals the saved request body, and
 * every read-back comment body equals its saved request comment body.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [readbackFile, reviewIdArg, statePath, mode, wantState = 'PENDING'] = process.argv.slice(2);
const readback = JSON.parse(fs.readFileSync(readbackFile, 'utf8'));
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const expected = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../docs/evidence/suggestion-application/expected.json'), 'utf8'),
);
const sarif = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../docs/evidence/suggestion-application', expected[mode === 'crlf' ? 'crlfGeneral' : 'suggestions'].sarif), 'utf8'),
);
const messageOf = new Map(sarif.runs[0].results.map((r) => [r.ruleId, r.message.text]));

let failures = 0;
function check(ok, label) {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n`);
  if (!ok) failures += 1;
}

const review = readback.ownedReviews.find((r) => r.id === Number(reviewIdArg));
check(review !== undefined, `review ${reviewIdArg} is readable and authored by ${readback.viewer.login}`);
if (!review) process.exit(1);
check(review.state === wantState, `review state is ${wantState} (${review.state})`);
check(review.commit_id === expected.commits.head, 'review commit is the pinned head');
check(state.receipt?.reviewId === review.id, 'publication state receipt names this review');
check(review.body === state.request.body, 'read-back body equals the saved create request body byte for byte');
check(review.body.endsWith(state.marker) && review.body.split(state.marker).length === 2, 'body ends with its single marker');

if (mode === 'crlf') {
  const e = expected.crlfGeneral;
  check(review.restComments.length === 0 && review.threads.length === 0, 'no inline comments');
  for (const s of e.bodyMustContain) check(review.body.includes(s), `body contains ${JSON.stringify(s)}`);
  check(review.body.includes('\r'), 'body retains raw CR characters');
} else {
  const e = expected.suggestions;
  check(review.body === `\n\n${state.marker}`, 'inline-only body is exactly "\\n\\n" + marker');
  check(review.restComments.length === e.inline.length && review.threads.length === e.inline.length, `${e.inline.length} REST comments and ${e.inline.length} threads`);
  for (const x of e.inline) {
    const src = execFileSync('git', ['show', `${expected.commits.head}:${x.path}`], {
      env: { ...process.env, GIT_DIR: '/tmp/sarif-e2e/repo/.git' },
      encoding: 'utf8',
    })
      .split('\n')
      .slice((x.startLine ?? x.line) - 1, x.line)
      .join('\n');
    check(src === x.sourceText, `${x.rule} authored source text matches git show`);
    const thread = review.threads.find(
      (t) =>
        t.path === x.path &&
        t.diffSide === x.side &&
        t.originalLine === x.line &&
        (x.startLine ? t.originalStartLine === x.startLine && t.startDiffSide === x.side : t.originalStartLine === null),
    );
    check(thread !== undefined && thread.originalCommit === expected.commits.head && thread.subjectType === 'LINE', `${x.rule} thread anchored at ${x.side} ${x.startLine ? `${x.startLine}-` : ''}${x.line}`);
    const rest = thread && review.restComments.find((c) => c.id === thread.commentIds[0]);
    const body = rest ? rest.body : '';
    check(body.includes(messageOf.get(x.rule)), `${x.rule} comment carries its message`);
    const fence = `\`\`\`suggestion\n${x.suggestion}\`\`\``;
    check(body.includes(fence) && (body.match(/```suggestion\n/g) ?? []).length === 1, `${x.rule} carries exactly the suggestion ${JSON.stringify(x.suggestion)}`);
    const saved = state.request.comments.find((c) => c.path === x.path);
    check(saved !== undefined && saved.body === body, `${x.rule} read-back comment body equals the saved request comment body byte for byte`);
  }
}

process.stdout.write(`${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
