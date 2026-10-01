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
 * change lists, references, descriptions and lifecycle notes) and the
 * alternatives grammar of issue #30; docs/diagnostics.md for the warnings
 * list of an outcome report.
 *
 * @see ../docs/review-presentation-contract.md
 * @see ../docs/file-operation-publication-contract.md
 * @see ../docs/companion-suggestion-pr-contract.md
 * @see ../docs/diagnostics.md
 * @see https://github.com/mike-north/sarif-to-comment/issues/30
 * @see https://spec.commonmark.org/0.31.2/#code-spans
 * @see https://github.github.com/gfm/#fenced-code-blocks
 */

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { renderAlternativeChanges, renderAlternatives } from '../dist/presentation/alternatives.cjs';
import type { IAlternative, IAlternativeChange } from '../dist/presentation/alternatives.cjs';
import { renderAttribution } from '../dist/presentation/attribution.cjs';
import { mergeSentence, reappliedParagraph, renderCompanionChange } from '../dist/presentation/companion-changes.cjs';
import { renderCompanionDescription } from '../dist/presentation/companion-description.cjs';
import { renderCompanionReference } from '../dist/presentation/companion-reference.cjs';
import { fileDetails, proposedContentBlock, renderFileAddition, renderProposedFileFinding } from '../dist/presentation/file-addition.cjs';
import { renderFileDeletion } from '../dist/presentation/file-deletion.cjs';
import { renderFinding, renderFindingSection } from '../dist/presentation/finding.cjs';
import { renderLifecycleNote } from '../dist/presentation/lifecycle-note.cjs';
import { renderDiagnosticLine, renderWarningsList } from '../dist/presentation/warnings-list.cjs';
import { codeSpan, escapePlain, escapePlainInline, fenced, lineSpan } from '../dist/presentation/markdown.cjs';
import { fenceProblem, loadMarkdownParser, unbalancedHtml } from '../dist/presentation/markdown-tree.cjs';

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

  test('the merge sentence counts changes, and the re-applied paragraph appears only when re-applied', () => {
    assert.equal(mergeSentence(1, 'it', 'main'), 'Merging it into `main` applies this change:');
    assert.equal(mergeSentence(3, 'it', 'main'), 'Merging it into `main` applies these 3 changes together:');
    assert.equal(reappliedParagraph(target, 'that commit'), '');
    assert.equal(reappliedParagraph({ pullNumber: 7, reappliedOnto: 'H' }, 'that commit'),
      'The history of #7 was rewritten after that commit, so this change is re-applied onto commit H, the head of #7 when it was proposed, where everything it changes is still exactly as reviewed.\n\n');
  });

  test('the companion reference in the review body', () => {
    assert.equal(renderCompanionReference(content, { number: 12, url: 'U' }, target),
      '**Suggestion pull request:** [#12](U)\n\nMerging it into `feature/x` applies these 2 changes together:\n\n- one\n- two\n\nITEMS');
  });

  test('the companion description places the supplied lifecycle note and ends with the supplied marker verbatim', () => {
    assert.equal(renderCompanionDescription(content, { ...target, reappliedOnto: 'H' }, 'NOTE', '<!-- m -->'), [
      `Suggested in a review of #7 at commit ${C}.`,
      '',
      'The history of #7 was rewritten after that commit, so this change is re-applied onto commit H, the head of #7 when it was proposed, where everything it changes is still exactly as reviewed.',
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
});
