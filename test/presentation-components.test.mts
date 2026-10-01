/**
 * Unit tests for the review presentation components (src/presentation/*.cts):
 * each component in isolation, on edge cases the whole-review tests reach
 * only indirectly.
 *
 * Expected Markdown is written by hand from the contracts:
 * docs/review-presentation-contract.md (findings, attribution, alternatives,
 * finding sections and the warnings list),
 * docs/file-operation-publication-contract.md §2 (additions, deletions and
 * file details), docs/companion-suggestion-pr-contract.md §2.11 (companion
 * change lists, references, descriptions, the projection section and
 * lifecycle notes) and the
 * alternatives grammar of issue #30; docs/diagnostics.md for the warnings
 * list of an outcome report; docs/delivery-policy-contract.md §8.8, §8.10
 * and §9 (a native batch's guidance and note, a replacement and a group made
 * by hand, and a companion bundle).
 *
 * @see ../docs/review-presentation-contract.md
 * @see ../docs/file-operation-publication-contract.md
 * @see ../docs/delivery-policy-contract.md
 * @see ../docs/companion-suggestion-pr-contract.md
 * @see ../docs/diagnostics.md
 * @see https://github.com/mike-north/sarif-to-comment/issues/30
 * @see https://spec.commonmark.org/0.31.2/#code-spans
 * @see https://github.github.com/gfm/#fenced-code-blocks
 * @see https://spec.commonmark.org/0.31.2/#list-items
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { renderAlternativeChanges, renderAlternatives } from '../dist/presentation/alternatives.cjs';
import type { IAlternative, IAlternativeChange } from '../dist/presentation/alternatives.cjs';
import { renderAttribution } from '../dist/presentation/attribution.cjs';
import { mergeSentence, reappliedParagraph, renderCompanionChange } from '../dist/presentation/companion-changes.cjs';
import { renderCompanionBundleDescription, renderCompanionDescription } from '../dist/presentation/companion-description.cjs';
import { renderCompanionProjection } from '../dist/presentation/companion-projection.cjs';
import type { ICompanionProjectionView } from '../dist/presentation/companion-projection.cjs';
import { renderBundledCompanionReference, renderCompanionReference } from '../dist/presentation/companion-reference.cjs';
import { fileDetails, proposedContentBlock, renderFileAddition, renderProposedFileFinding } from '../dist/presentation/file-addition.cjs';
import { renderFileDeletion } from '../dist/presentation/file-deletion.cjs';
import { renderFinding, renderFindingSection } from '../dist/presentation/finding.cjs';
import { renderLifecycleNote } from '../dist/presentation/lifecycle-note.cjs';
import { renderGroupLabel } from '../dist/presentation/group-label.cjs';
import { manualEditBlock, manualEditDetails, manualEditLocation, renderManualEdit, renderManualReplacement } from '../dist/presentation/manual-edit.cjs';
import { renderManualGroup, renderManualGroupGuidance, renderManualGroupPartLabel } from '../dist/presentation/manual-group.cjs';
import { renderNativeBatchGuidance, renderNativeBatchMemberNote } from '../dist/presentation/native-batch.cjs';
import { renderDiagnosticLine, renderWarningsList } from '../dist/presentation/warnings-list.cjs';
import { codeSpan, escapePlain, escapePlainInline, fenced, lineSpan } from '../dist/presentation/markdown.cjs';
import { fenceProblem, loadMarkdownParser, unbalancedHtml } from '../dist/presentation/markdown-tree.cjs';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

const C = '2222222222222222222222222222222222222222';

await loadMarkdownParser();

describe('Markdown primitives', () => {
  test('a code span is delimited by one more backtick than its longest run, padded when it starts or ends with one', () => {
    assert.equal(codeSpan('a.js'), '`a.js`');
    assert.equal(codeSpan('a`b'), '``a`b``');
    assert.equal(codeSpan('`x``'), '``` `x`` ```');
    assert.equal(codeSpan('a\nb\r\nc\rd'), '`a b c d`', 'line breaks become spaces, as a code span renders them');
  });

  test('a fence is at least three backticks and one longer than the longest run inside', () => {
    assert.equal(fenced('x'), '```\nx\n```');
    assert.equal(fenced('````'), '`````\n````\n`````');
  });

  test('plain text is escaped to render literally and mentions become code spans', () => {
    assert.equal(escapePlainInline('a_b *c* @octocat'), 'a\\_b \\*c\\* `@octocat`');
    assert.equal(escapePlain('- item\n1. one'), '\\- item\\\n1\\. one');
  });

  test('line spans', () => {
    assert.equal(lineSpan(4, 4), 'line 4');
    assert.equal(lineSpan(4, 6), 'lines 4-6');
  });

  test('the fence scanner finds suggestion openers and unclosed fences, and accepts balanced fences', () => {
    assert.equal(fenceProblem('```js\nx\n```'), null);
    assert.equal(fenceProblem('> ~~~ suggestion'), 'suggestion-fence');
    assert.equal(fenceProblem('````\nx\n```'), 'unclosed-fence');
  });

  test('the HTML scanner finds what is left open, outside code', () => {
    assert.equal(unbalancedHtml('<details><summary>s</summary>x</details>'), null);
    assert.equal(unbalancedHtml('`<details>` and\n```\n<!--\n```'), null);
    assert.equal(unbalancedHtml('<!-- open'), 'an HTML <!-- construct');
    assert.equal(unbalancedHtml('<details>x'), 'a <details> element');
    assert.equal(unbalancedHtml('</b>'), 'an unmatched </b> tag');
  });
});

describe('attribution', () => {
  test('tool alone, with version, extension component and rule', () => {
    assert.equal(renderAttribution({ tool: 'T' }), 'T');
    assert.equal(renderAttribution({ tool: 'Lint', version: '1.2', component: { name: 'pack', version: '0.4' }, ruleId: 'no-x' }), 'Lint 1.2 · pack 0.4 · rule `no-x`');
    assert.equal(renderAttribution({ tool: 'Lint', component: { name: 'pack' } }), 'Lint · pack');
  });

  test('names and versions are shown literally', () => {
    assert.equal(renderAttribution({ tool: 'my_tool *x*', version: '<1>', ruleId: 'a`b' }), 'my\\_tool \\*x\\* \\<1\\> · rule ``a`b``');
  });
});

describe('finding and finding section', () => {
  const base = { classification: undefined, message: 'M.', locationMessage: undefined, fixDescription: undefined, alternatives: undefined, attribution: 'T' };

  test('only the message and attribution', () => {
    assert.equal(renderFinding(base), 'M.\n\n<sub>— T</sub>');
  });

  test('every part in order: status, message, location message, fix, alternatives, attribution', () => {
    assert.equal(renderFinding({
      ...base,
      classification: { kind: 'fail', baselineState: 'new' },
      locationMessage: 'Here.',
      fixDescription: 'Do it.',
      alternatives: '**Alternatives to consider:**\n\n(1) X',
    }), '**Kind:** fail · **Baseline:** new\n\nM.\n\n**At this location:** Here.\n\n**Fix:** Do it.\n\n**Alternatives to consider:**\n\n(1) X\n\n<sub>— T</sub>');
  });

  test('a section without a source is the finding alone; a whole-file source links without a quote', () => {
    assert.equal(renderFindingSection('F', undefined), 'F');
    assert.equal(renderFindingSection('F', { path: 'a_b.md', commit: C, url: 'U' }), '**Source:** [a\\_b.md at 2222222](U)\n\nF');
  });

  test('a line-range source links its lines and quotes them in a fence longer than any run inside', () => {
    assert.equal(renderFindingSection('F', { path: 'a.md', commit: C, url: 'U', lines: { startLine: 2, endLine: 3, text: '```\nx' } }),
      '**Source:** [a.md lines 2-3 at 2222222](U)\n\n````\n```\nx\n````\n\nF');
  });
});

describe('alternatives', () => {
  const change = (overrides: Partial<IAlternativeChange> = {}): IAlternativeChange => ({
    path: 'a.js', startLine: 2, endLine: 2, replacementText: 'x\n', shownText: 'x', crlf: false, ...overrides,
  });

  test('none: no alternatives section at all', () => {
    assert.equal(renderAlternatives([], 'a.js'), undefined);
  });

  test('a deletion on the first fix\'s file, and on another file', () => {
    const deletion: IAlternative = { description: undefined, changes: [change({ replacementText: '', shownText: '' })] };
    assert.equal(renderAlternativeChanges(deletion, 'a.js'), 'Delete line 2.');
    assert.equal(renderAlternativeChanges(deletion, undefined), 'Delete line 2 of `a.js`.');
  });

  test('a CRLF replacement states its line endings beside the block', () => {
    assert.equal(renderAlternativeChanges({ description: undefined, changes: [change({ startLine: 1, endLine: 2, crlf: true, shownText: 'x\ny' })] }, 'a.js'),
      'Replace lines 1-2 with (CRLF line endings):\n\n```\nx\ny\n```');
  });

  test('several changes of one file "make N changes together"; numbering and descriptions follow the producer\'s order', () => {
    const several: IAlternative = { description: 'Both.', changes: [change({ startLine: 1, endLine: 1 }), change({ startLine: 5, endLine: 5, replacementText: '', shownText: '' })] };
    assert.equal(renderAlternatives([{ description: undefined, changes: [change()] }, several], 'a.js'), [
      '**Alternatives to consider:**',
      '',
      '(1) Replace line 2 with:',
      '',
      '```',
      'x',
      '```',
      '',
      '(2) Both.',
      '',
      'Makes 2 changes together:',
      '',
      '`a.js` — replace line 1 with:',
      '',
      '```',
      'x',
      '```',
      '',
      '`a.js` — delete line 5.',
    ].join('\n'));
  });
});

describe('file addition and deletion', () => {
  test('file details state what the block cannot show (contract §2 "Content and facts")', () => {
    assert.equal(fileDetails('', '100644'), 'empty file (0 bytes) · mode 100644');
    assert.equal(fileDetails('﻿', '100644'), '3 bytes of UTF-8 text · begins with a byte-order mark · no content after the byte-order mark · mode 100644');
    assert.equal(fileDetails('a\r\nb\r\n', '100755'), '6 bytes of UTF-8 text · CRLF line endings · ends with a newline · mode 100755 (executable)');
    assert.equal(fileDetails('x', '100644'), '1 byte of UTF-8 text · no line breaks · no newline at end of file · mode 100644');
  });

  test('the content block drops a leading byte-order mark and exactly one final terminator, and is absent without content', () => {
    assert.equal(proposedContentBlock(''), undefined);
    assert.equal(proposedContentBlock('﻿'), undefined);
    assert.equal(proposedContentBlock('\n'), '```\n\n```', 'a file of one newline shows one empty line');
    assert.equal(proposedContentBlock('﻿a\n\n'), '```\na\n\n```');
  });

  test('an addition section, with a located and an unlocated finding', () => {
    const findings = [renderProposedFileFinding({ startLine: 1, endLine: 2 }, 'A'), renderProposedFileFinding(null, 'B')].join('\n\n---\n\n');
    assert.equal(renderFileAddition({ path: 'n.md', text: 'x\n', fileMode: '100644' }, findings), [
      '**Proposed new file:** `n.md`',
      '',
      '**File details:** 2 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644',
      '',
      '```',
      'x',
      '```',
      '',
      '**Location:** lines 1-2 of the proposed file',
      '',
      'A',
      '',
      '---',
      '',
      'B',
    ].join('\n'));
  });

  test('a deletion section shows its path literally and links the exact file', () => {
    assert.equal(renderFileDeletion({ path: 'old_[x].txt', commit: C, url: 'U' }, 'F'),
      '**Proposed file deletion:** [old\\_\\[x\\].txt at 2222222](U)\n\nThe whole file is removed; this is not a proposal to empty it.\n\nF');
  });
});

describe('companion pieces', () => {
  const target = { pullNumber: 7, reviewedCommit: C, headRef: 'feature/x', ready: false } as const;
  const content = { changeCount: 2, changeLines: '- one\n- two', items: 'ITEMS' };

  test('change lines for an edit, a creation and a deletion (contract §2.11)', () => {
    assert.equal(renderCompanionChange({ kind: 'edit', path: 'a b.js', startLine: 2, endLine: 4, commit: C, url: 'U' }), '- Edited [a b.js lines 2-4 at 2222222](U)');
    assert.equal(renderCompanionChange({ kind: 'create', path: 'n.md', text: 'x\n', fileMode: '100644' }),
      '- New file `n.md`: 2 bytes of UTF-8 text · LF line endings · ends with a newline · mode 100644');
    assert.equal(renderCompanionChange({ kind: 'delete', path: 'o.txt', commit: C, url: 'U' }), '- Deleted file [o.txt at 2222222](U): the whole file is removed');
  });

  test('the merge sentence counts changes, and the re-applied paragraph appears only for a version-2 plan that re-applied', () => {
    assert.equal(mergeSentence(1, 'it', 'main'), 'Merging it into `main` applies this change:');
    assert.equal(mergeSentence(3, 'it', 'main'), 'Merging it into `main` applies these 3 changes together:');
    assert.equal(reappliedParagraph(target, 'that commit'), '');
    assert.equal(reappliedParagraph({ pullNumber: 7, reappliedOnto: 'H' }, 'that commit'),
      'The history of #7 was rewritten after that commit, so this change is re-applied onto commit H, the head of #7 when it was proposed, where everything it changes is still exactly as reviewed.\n\n');
  });

  test('the companion reference in the review body; a version-2 plan\'s keeps the paragraph it was planned with', () => {
    assert.equal(renderCompanionReference(content, { number: 12, url: 'U' }, target),
      '**Suggestion pull request:** [#12](U)\n\nMerging it into `feature/x` applies these 2 changes together:\n\n- one\n- two\n\nITEMS');
    assert.equal(renderCompanionReference(content, { number: 12, url: 'U' }, { ...target, reappliedOnto: 'H' }),
      '**Suggestion pull request:** [#12](U)\n\nThe history of #7 was rewritten after the reviewed commit, so this change is re-applied onto commit H, the head of #7 when it was proposed, '
      + 'where everything it changes is still exactly as reviewed.\n\nMerging it into `feature/x` applies these 2 changes together:\n\n- one\n- two\n\nITEMS');
  });

  test('the companion description places the supplied lifecycle note and ends with the supplied marker verbatim; it never re-applies', () => {
    assert.equal(renderCompanionDescription(content, { ...target, reappliedOnto: 'H' }, 'NOTE', '<!-- m -->'), [
      `Suggested in a review of #7 at commit ${C}.`,
      '',
      'Merging this pull request into `feature/x` applies these 2 changes together:',
      '',
      '- one',
      '- two',
      '',
      'NOTE',
      '',
      '---',
      '',
      'ITEMS',
      '',
      '<!-- m -->',
    ].join('\n'));
  });

  test('lifecycle notes, draft and ready (contract §2.11)', () => {
    assert.equal(renderLifecycleNote(target),
      '**How this suggestion is accepted:** it is a draft pull request into `feature/x`, the branch of #7. A draft cannot be merged: someone with write access first marks it ready for review. The author of #7 then decides whether to merge it, and #7 carries the change to its base. Once #7 is merged or closed, this pull request can be closed.');
    assert.equal(renderLifecycleNote({ ...target, ready: true }),
      '**How this suggestion is accepted:** it is a pull request into `feature/x`, the branch of #7. The author of #7 decides whether to merge it, and #7 carries the change to its base. Once #7 is merged or closed, this pull request can be closed.');
  });
});

describe('companion bundles (delivery policy §9; companion contract §2.11)', () => {
  const target = { pullNumber: 7, reviewedCommit: C, headRef: 'feature/x', ready: false } as const;
  const group = { changeCount: 2, changeLines: '- one\n- two', items: 'GROUP' };
  const single = { changeCount: 1, changeLines: '- three', items: 'EDIT' };

  test('a bundle of one proposal is described and referenced exactly as a companion of its own', () => {
    assert.equal(renderCompanionBundleDescription([group], target, 'NOTE', '<!-- m -->'), renderCompanionDescription(group, target, 'NOTE', '<!-- m -->'));
    assert.equal(renderBundledCompanionReference(group, { number: 12, url: 'U' }, target, 1, 1), renderCompanionReference(group, { number: 12, url: 'U' }, target));
  });

  test('a bundle of several proposals: one section each, under a sentence that claims no dependency, then the marker', () => {
    assert.equal(renderCompanionBundleDescription([group, single], target, 'NOTE', '<!-- m -->'), [
      `Suggested in a review of #7 at commit ${C}.`,
      '',
      'This pull request bundles 2 proposals, each in its own section below. Merging it into `feature/x` applies all of them; bundling them does not mean they depend on one another.',
      '',
      'NOTE',
      '',
      '---',
      '',
      '**Proposal 1 of 2:** these 2 changes together:',
      '',
      '- one',
      '- two',
      '',
      'GROUP',
      '',
      '---',
      '',
      '**Proposal 2 of 2:** this change:',
      '',
      '- three',
      '',
      'EDIT',
      '',
      '<!-- m -->',
    ].join('\n'));
  });

  test('a projected bundle states its projection once, after the reference', () => {
    const view: ICompanionProjectionView = { head: 'H', verdict: 'faithful', conflicts: [], files: [] };
    assert.ok(renderCompanionBundleDescription([group, single], target, 'NOTE', 'M', view).startsWith(
      `Suggested in a review of #7 at commit ${C}.\n\n${renderCompanionProjection(view, target)}\n\nThis pull request bundles 2 proposals`));
  });

  test('each proposal of a bundle keeps its own section of the review, naming which proposal it is', () => {
    assert.equal(renderBundledCompanionReference(single, { number: 12, url: 'U' }, target, 2, 2),
      '**Suggestion pull request:** [#12](U), proposal 2 of 2\n\nMerging it into `feature/x` applies this change, with the 1 other proposal it bundles:\n\n- three\n\nEDIT');
    assert.equal(renderBundledCompanionReference(group, { number: 12, url: 'U' }, target, 1, 3),
      '**Suggestion pull request:** [#12](U), proposal 1 of 3\n\nMerging it into `feature/x` applies these 2 changes together, with the 2 other proposals it bundles:\n\n- one\n- two\n\nGROUP');
  });
});

describe('the projection section of a companion\'s description (companion contract §2.5.1, §2.11)', () => {
  const target = { pullNumber: 7, reviewedCommit: C, headRef: 'feature/x', ready: false } as const;
  const LEAD = `**The reviewed commit is not part of the branch of #7:** the branch was rewritten after commit ${C} (its head was H when this was proposed). `
    + 'GitHub shows this pull request\'s changes from an older merge base, so they also list changes of the reviewed commit itself. '
    + 'Projected onto that head before this pull request was created, merging it ';
  const hunk = { oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: [
    { text: ' b', noNewline: false }, { text: '-c', noNewline: false }, { text: '+C', noNewline: false }, { text: ' d', noNewline: false },
  ] };

  test('faithful, with its own changes shown as a unified diff', () => {
    assert.equal(renderCompanionProjection({ head: 'H', verdict: 'faithful', conflicts: [], files: [{ path: 'f.md', hunks: [hunk] }] }, target),
      `${LEAD}applies only its own changes, which are these:\n\n\`\`\`diff\n--- a/f.md\n+++ b/f.md\n@@ -2,3 +2,3 @@\n b\n-c\n+C\n d\n\`\`\``);
  });

  test('conflicting in several paths; whole-file changes only, so the changes are listed below', () => {
    assert.equal(renderCompanionProjection({ head: 'H', verdict: 'conflicts', conflicts: ['a', 'b', 'c'], files: [] }, target),
      `${LEAD}conflicts in \`a\`, \`b\` and \`c\`; its own changes are listed below.`);
    assert.equal(renderCompanionProjection({ head: 'H', verdict: 'faithful', conflicts: [], files: [] }, target), `${LEAD}applies only its own changes, which are listed below.`);
  });

  test('faithful where the head already has its own changes: merging it changes nothing', () => {
    assert.equal(renderCompanionProjection({ head: 'H', verdict: 'faithful', alreadyAtHead: true, conflicts: [], files: [{ path: 'f.md', hunks: [hunk] }] }, target),
      `${LEAD}changes nothing, because the head already has its own changes, which are these:\n\n\`\`\`diff\n--- a/f.md\n+++ b/f.md\n@@ -2,3 +2,3 @@\n b\n-c\n+C\n d\n\`\`\``);
    assert.equal(renderCompanionProjection({ head: 'H', verdict: 'faithful', alreadyAtHead: true, conflicts: [], files: [] }, target),
      `${LEAD}changes nothing, because the head already has its own changes, which are listed below.`);
  });

  test('a range of one line has no count, a line without a final newline is marked, and a carriage return before a newline is not shown', () => {
    const lines = [{ text: '-x\r', noNewline: false }, { text: '+y', noNewline: true }];
    assert.equal(renderCompanionProjection({ head: 'H', verdict: 'faithful', conflicts: [], files: [{ path: 'f', hunks: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1, lines }] }] }, target),
      `${LEAD}applies only its own changes, which are these:\n\n\`\`\`diff\n--- a/f\n+++ b/f\n@@ -4 +4 @@\n-x\n+y\n\\ No newline at end of file\n\`\`\``);
  });

  test('the fence is longer than any backtick run in the changes, so nothing can close it early', () => {
    const lines = [{ text: '+````', noNewline: false }];
    const text = renderCompanionProjection({ head: 'H', verdict: 'faithful', conflicts: [], files: [{ path: 'f', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines }] }] }, target);
    assert.ok(text.endsWith('\n\n`````diff\n--- a/f\n+++ b/f\n@@ -0,0 +1 @@\n+````\n`````'), text);
  });

  // §2.11: the diff does not show a carriage return that ends a line, so a hunk whose lines change their line
  // endings states it in its header, in the words of delivery policy §8.10's details: the old side's style, then the new.
  const oneHunk = (lines: readonly { text: string; noNewline: boolean }[], oldLines = 1, newLines = 1): ICompanionProjectionView =>
    ({ head: 'H', verdict: 'faithful', conflicts: [], files: [{ path: 'f', hunks: [{ oldStart: 4, oldLines, newStart: 4, newLines, lines }] }] });
  const diffOf = (text: string): string => text.slice(text.indexOf('```diff\n') + '```diff\n'.length, text.lastIndexOf('\n```'));

  test('regression: a change of line endings only (CRLF to LF) is stated on its hunk, not shown as two identical lines', () => {
    const text = renderCompanionProjection(oneHunk([{ text: '-x\r', noNewline: false }, { text: '+x', noNewline: false }]), target);
    assert.equal(diffOf(text), '--- a/f\n+++ b/f\n@@ -4 +4 @@ CRLF line endings become LF line endings\n-x\n+x');
  });

  test('LF to CRLF is stated the other way round', () => {
    const text = renderCompanionProjection(oneHunk([{ text: '-x', noNewline: false }, { text: '+x\r', noNewline: false }]), target);
    assert.equal(diffOf(text), '--- a/f\n+++ b/f\n@@ -4 +4 @@ LF line endings become CRLF line endings\n-x\n+x');
  });

  test('context lines count for both sides: LF lines added among CRLF lines make the new side mixed', () => {
    const lines = [{ text: ' a\r', noNewline: false }, { text: '+b', noNewline: false }, { text: ' c\r', noNewline: false }];
    const text = renderCompanionProjection(oneHunk(lines, 2, 3), target);
    assert.equal(diffOf(text), '--- a/f\n+++ b/f\n@@ -4,2 +4,3 @@ CRLF line endings become mixed CRLF and LF line endings\n a\n+b\n c');
  });

  test('a hunk whose line endings do not change has no note, CRLF or LF', () => {
    const crlf = renderCompanionProjection(oneHunk([{ text: '-x\r', noNewline: false }, { text: '+y\r', noNewline: false }]), target);
    assert.equal(diffOf(crlf), '--- a/f\n+++ b/f\n@@ -4 +4 @@\n-x\n+y');
    const lf = renderCompanionProjection(oneHunk([{ text: '-x', noNewline: false }, { text: '+y', noNewline: false }]), target);
    assert.equal(diffOf(lf), '--- a/f\n+++ b/f\n@@ -4 +4 @@\n-x\n+y');
  });

  test('a last line without a newline has no line ending: it does not count, and a carriage return there is content, shown visibly', () => {
    const text = renderCompanionProjection(oneHunk([{ text: '-x\r', noNewline: true }, { text: '+x', noNewline: true }]), target);
    assert.equal(diffOf(text), '--- a/f\n+++ b/f\n@@ -4 +4 @@\n-x{U+000D}\n\\ No newline at end of file\n+x\n\\ No newline at end of file');
  });

  // §2.11 and delivery policy §8.10: a code block does not show these characters as themselves, so the diff writes each as a visible escape.
  const NOTE = 'In this diff, each `{U+XXXX}` stands for the character with that code point, written visibly; this pull request\'s commit has the exact bytes.';

  test('regression: a character a code block does not show is written as a visible escape, and a note says so; the diff never carries it raw', () => {
    const lines = [
      { text: ' a\u00A0b', noNewline: false },          // U+00A0, which renders as a space
      { text: '-c\u200Bd', noNewline: false },          // a zero-width space (Cf)
      { text: '+c\u200Dd\u202E', noNewline: false },    // a zero-width joiner and a bidirectional override (Cf)
      { text: '+\u00ADe\u2028f\uFEFF', noNewline: false }, // a soft hyphen (Cf), a line separator, a byte-order mark (Cf)
      { text: '+g\u0007h\u007Fi\u0085', noNewline: false }, // a C0 control, DEL and a C1 control
      { text: '+bare\rcr\r', noNewline: false },        // a carriage return inside the line is shown; the one ending it is not
    ];
    const text = renderCompanionProjection({ head: 'H', verdict: 'faithful', conflicts: [], files: [{ path: 'f', hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 5, lines }] }] }, target);
    assert.equal(text, `${LEAD}applies only its own changes, which are these:\n\n${[
      // The last added line ends with CRLF among LF lines, so the hunk states its line endings.
      '```diff', '--- a/f', '+++ b/f', '@@ -1,2 +1,5 @@ LF line endings become mixed CRLF and LF line endings',
      ' a{U+00A0}b',
      '-c{U+200B}d',
      '+c{U+200D}d{U+202E}',
      '+{U+00AD}e{U+2028}f{U+FEFF}',
      '+g{U+0007}h{U+007F}i{U+0085}',
      '+bare{U+000D}cr',
      '```',
    ].join('\n')}\n\n${NOTE}`);
    assert.doesNotMatch(text, /[\p{Cf}\u00A0\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/u, 'no unshown character reaches the description');
  });

  test('a zero-width joiner inside an emoji sequence is escaped too: the diff shows content, not a title', () => {
    const lines = [{ text: '+\u{1F469}\u200D\u{1F4BB}', noNewline: false }];
    const text = renderCompanionProjection({ head: 'H', verdict: 'faithful', conflicts: [], files: [{ path: 'f', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines }] }] }, target);
    assert.ok(text.endsWith('\n+\u{1F469}{U+200D}\u{1F4BB}\n```\n\n' + NOTE), text);
  });

  test('literal text that reads as an escape has its brace escaped, so every `{U+XXXX}` in the diff stands for one character', () => {
    const lines = [{ text: '+{U+0041} {U+1F600} {u+0041} {U+41} {x}', noNewline: false }];
    const text = renderCompanionProjection({ head: 'H', verdict: 'faithful', conflicts: [], files: [{ path: 'f', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines }] }] }, target);
    assert.ok(text.endsWith('\n+{U+007B}U+0041} {U+007B}U+1F600} {u+0041} {U+41} {x}\n```\n\n' + NOTE), text);
  });

  test('a path in the diff\'s file headers is escaped by the same rule', () => {
    const lines = [{ text: '+x', noNewline: false }];
    const text = renderCompanionProjection({ head: 'H', verdict: 'faithful', conflicts: [], files: [{ path: 'a\u200Bb.md', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines }] }] }, target);
    assert.ok(text.endsWith('\n--- a/a{U+200B}b.md\n+++ b/a{U+200B}b.md\n@@ -0,0 +1 @@\n+x\n```\n\n' + NOTE), text);
  });

  test('a diff with nothing to escape has no note; tabs and trailing spaces are shown as themselves', () => {
    const lines = [{ text: '+\tindented  ', noNewline: false }];
    const text = renderCompanionProjection({ head: 'H', verdict: 'faithful', conflicts: [], files: [{ path: 'f', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines }] }] }, target);
    assert.ok(text.endsWith('\n+\tindented  \n```'), text);
  });
});

describe('a native batch (delivery policy §8.8)', () => {
  const RETRY = { kind: 'group', name: 'retry' } as const;
  const FIX = { kind: 'fix', changeCount: 2 } as const;

  test('the guidance lists every change by path and line, in order', () => {
    assert.equal(renderNativeBatchGuidance(RETRY, [{ path: 'src/a.ts', startLine: 2, endLine: 2 }, { path: 'docs/b.md', startLine: 4, endLine: 6 }]), [
      '**Suggestion group `retry`:** apply these 2 suggestions together, in one commit: add each of them to one batch of suggestions on the pull request, then commit the batch. Nothing checks that they are applied together.',
      '',
      '- `src/a.ts` line 2',
      '- `docs/b.md` lines 4-6',
    ].join('\n'));
  });

  test('the member note points to the guidance; a group name with backticks stays one code span', () => {
    assert.equal(renderNativeBatchMemberNote(RETRY),
      '**Suggestion group `retry`:** apply this suggestion together with the group\'s other suggestions, listed in the review body.');
    assert.ok(renderNativeBatchMemberNote({ kind: 'group', name: 'a`b' }).startsWith('**Suggestion group ``a`b``:**'));
  });

  test('a fix with several changes in no group is labelled by its change count, and its note names the fix', () => {
    assert.equal(renderGroupLabel(FIX), 'Fix with 2 changes');
    assert.equal(renderGroupLabel(RETRY), 'Suggestion group `retry`');
    assert.equal(renderNativeBatchGuidance(FIX, [{ path: 'README.md', startLine: 2, endLine: 2 }, { path: 'README.md', startLine: 3, endLine: 3 }]), [
      '**Fix with 2 changes:** apply these 2 suggestions together, in one commit: add each of them to one batch of suggestions on the pull request, then commit the batch. Nothing checks that they are applied together.',
      '',
      '- `README.md` line 2',
      '- `README.md` line 3',
    ].join('\n'));
    assert.equal(renderNativeBatchMemberNote(FIX),
      '**Fix with 2 changes:** apply this suggestion together with the fix\'s other suggestions, listed in the review body.');
  });
});

describe('a replacement made by hand (delivery policy §8.10)', () => {
  const url = (anchor: string): string => `https://github.com/acme/widgets/blob/${C}/README.md${anchor}`;
  const line2 = { path: 'README.md', startLine: 2, endLine: 2, commit: C, url: url('?plain=1#L2') };

  test('a one-line replacement links the replaced line at the reviewed commit and shows the new line in a block', () => {
    const edit = { ...line2, replacement: { shownText: 'The widget client.', crlf: false, finalNewline: true } };
    assert.equal(manualEditLocation(edit), `[README.md line 2 at 2222222](${url('?plain=1#L2')})`);
    assert.equal(manualEditBlock(edit), '```\nThe widget client.\n```');
    assert.equal(manualEditDetails(edit), undefined, 'LF lines ending with a newline need no details');
    assert.equal(renderManualReplacement(edit), `replace [README.md line 2 at 2222222](${url('?plain=1#L2')}) with:\n\n\`\`\`\nThe widget client.\n\`\`\``);
  });

  test('CRLF line endings and a missing final newline are stated beside the block, in that order', () => {
    const edit = { ...line2, startLine: 2, endLine: 3, url: url('?plain=1#L2-L3'), replacement: { shownText: 'x\ny', crlf: true, finalNewline: false } };
    assert.equal(manualEditDetails(edit), 'CRLF line endings, no newline at end of file');
    assert.equal(renderManualReplacement(edit),
      `replace [README.md lines 2-3 at 2222222](${url('?plain=1#L2-L3')}) with (CRLF line endings, no newline at end of file):\n\n\`\`\`\nx\ny\n\`\`\``);
    assert.equal(manualEditDetails({ ...edit, replacement: { shownText: 'x', crlf: false, finalNewline: false } }), 'no newline at end of file');
    assert.equal(manualEditDetails({ ...edit, replacement: { shownText: 'x', crlf: true, finalNewline: true } }), 'CRLF line endings');
  });

  test('removed lines have no block: "delete … ."', () => {
    const edit = { ...line2, endLine: 3, url: url('?plain=1#L2-L3'), replacement: undefined };
    assert.equal(manualEditBlock(edit), undefined);
    assert.equal(manualEditDetails(edit), undefined);
    assert.equal(renderManualReplacement(edit), `delete [README.md lines 2-3 at 2222222](${url('?plain=1#L2-L3')}).`);
  });

  test('a replacement of one empty line is a block holding one empty line, distinct from deleting it', () => {
    const edit = { ...line2, replacement: { shownText: '', crlf: false, finalNewline: true } };
    assert.equal(manualEditBlock(edit), '```\n\n```');
  });

  test('the fence is one backtick longer than any run inside, so no line of the replacement can close it', () => {
    const edit = { ...line2, replacement: { shownText: 'Use ```` here\n```', crlf: false, finalNewline: true } };
    assert.equal(manualEditBlock(edit), '`````\nUse ```` here\n```\n`````');
  });

  test('the path in the link text is literal: Markdown characters are escaped', () => {
    const edit = { ...line2, path: 'docs/_a_*b*.md', url: 'U', replacement: undefined };
    assert.equal(manualEditLocation(edit), '[docs/\\_a\\_\\*b\\*.md line 2 at 2222222](U)');
  });

  test('the manual edit section says it is made by hand, then the replacement, then its findings', () => {
    const edit = { ...line2, replacement: { shownText: 'The widget client.', crlf: false, finalNewline: true } };
    assert.equal(renderManualEdit(edit, 'FINDINGS'),
      `**Proposed edit, to make by hand:** replace [README.md line 2 at 2222222](${url('?plain=1#L2')}) with:\n\n\`\`\`\nThe widget client.\n\`\`\`\n\nFINDINGS`);
    assert.equal(fenceProblem(renderManualEdit(edit, 'FINDINGS')), null, 'never a suggestion block, and nothing left open');
  });
});

describe('a group made by hand (delivery policy §8.10)', () => {
  const PAIR = { kind: 'group', name: 'pair' } as const;
  const members = [
    { kind: 'edit', path: 'README.md', startLine: 2, endLine: 2 },
    { kind: 'create', path: 'src/helper.ts' },
    { kind: 'delete', path: 'obsolete.txt' },
    { kind: 'edit', path: 'notes.txt', startLine: 4, endLine: 6 },
  ] as const;
  const GUIDANCE = [
    '**Suggestion group `pair`:** apply these 4 changes together, by hand, in one commit: make every change below in a local copy of the pull request\'s branch, then commit them together. They are not offered as suggestions, and nothing checks that they are applied together.',
    '',
    '- `README.md` line 2',
    '- `src/helper.ts`: new file',
    '- `obsolete.txt`: file deletion',
    '- `notes.txt` lines 4-6',
  ].join('\n');

  test('the guidance names every change by path (and line, for an edit), in order, and claims no enforcement', () => {
    assert.equal(renderManualGroupGuidance(PAIR, members), GUIDANCE);
    assert.doesNotMatch(GUIDANCE, /enforc|GitHub applies|batch/i);
  });

  test('each change is labelled with the group and its place', () => {
    assert.equal(renderManualGroupPartLabel(PAIR, 2, 4), '**Suggestion group `pair` — change 2 of 4**');
    assert.equal(renderManualGroupPartLabel({ kind: 'fix', changeCount: 2 }, 1, 2), '**Fix with 2 changes — change 1 of 2**');
  });

  test('the section is the guidance, then each labelled change, separated as body sections are', () => {
    const fix = { kind: 'fix', changeCount: 2 } as const;
    const two = [{ kind: 'edit', path: 'a.md', startLine: 1, endLine: 1 }, { kind: 'edit', path: 'a.md', startLine: 3, endLine: 3 }] as const;
    assert.equal(renderManualGroup(fix, two.map((member, i) => ({ member, part: `PART ${String(i + 1)}` }))), [
      '**Fix with 2 changes:** apply these 2 changes together, by hand, in one commit: make every change below in a local copy of the pull request\'s branch, then commit them together. They are not offered as suggestions, and nothing checks that they are applied together.',
      '',
      '- `a.md` line 1',
      '- `a.md` line 3',
      '',
      '---',
      '',
      '**Fix with 2 changes — change 1 of 2**',
      '',
      'PART 1',
      '',
      '---',
      '',
      '**Fix with 2 changes — change 2 of 2**',
      '',
      'PART 2',
    ].join('\n'));
  });
});

describe('the warnings list of an outcome report (docs/diagnostics.md)', () => {
  const warning = (code: string, message: string, pointer?: string) => ({
    code, severity: 'warning' as const, title: 'T', message, remedies: [], ...(pointer === undefined ? {} : { location: { pointer } }),
  });

  test('a diagnostic line names its code, its pointer when it has one, and its message', () => {
    assert.equal(renderDiagnosticLine(warning('taxa-uninterpreted', 'M.', '/runs/0/results/1')), '- `taxa-uninterpreted` at `/runs/0/results/1`: M.');
    assert.equal(renderDiagnosticLine(warning('delivery-unconfirmed', 'M.')), '- `delivery-unconfirmed`: M.');
  });

  test('the list is headed **Warnings:** and keeps the order given', () => {
    assert.equal(renderWarningsList([warning('a-code', 'First.', '/x'), warning('b-code', 'Second.')]),
      '**Warnings:**\n\n- `a-code` at `/x`: First.\n- `b-code`: Second.');
  });
  // Review presentation contract §6: every line of a message after its first is indented two spaces, the content
  // column of "- ", so it continues the list item (CommonMark §5.2); blank lines stay empty. The text is unchanged.
  const OBSTACLES = 'The group `g` cannot be delivered:\n\n- `native-batch`: The edit of `README.md` line 5.\n- `companion`: Not yet supported.';

  test('regression: a message with its own list stays inside its diagnostic\'s item, indented two spaces', () => {
    assert.equal(renderDiagnosticLine(warning('delivery-unavailable', OBSTACLES, '/runs/0/results/7')), [
      '- `delivery-unavailable` at `/runs/0/results/7`: The group `g` cannot be delivered:',
      '',
      '  - `native-batch`: The edit of `README.md` line 5.',
      '  - `companion`: Not yet supported.',
    ].join('\n'));
  });

  test('every continuation line is indented, a fenced block included, and blank lines carry no spaces', () => {
    assert.equal(renderDiagnosticLine(warning('c', 'One\ntwo\n\n```\ncode\n```')), '- `c`: One\n  two\n\n  ```\n  code\n  ```');
  });

  test('regression: as CommonMark reads it, each message\'s list nests under its own item, and the items stay siblings', () => {
    const tree = fromMarkdown(renderWarningsList([warning('a-code', OBSTACLES, '/x'), warning('b-code', 'Second.')]), {
      extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()],
    });
    const lists = tree.children.filter((node) => node.type === 'list');
    assert.equal(lists.length, 1, 'one list of diagnostics; no sibling list after it');
    const [list] = lists;
    assert.ok(list?.type === 'list');
    assert.equal(list.children.length, 2, 'two diagnostics, nothing more at their level');
    const nested = list.children[0]?.children.filter((node) => node.type === 'list') ?? [];
    assert.equal(nested.length, 1, 'the obstacles are a list inside the first diagnostic\'s item');
    assert.equal(nested[0]?.type === 'list' ? nested[0].children.length : 0, 2);
  });
});
