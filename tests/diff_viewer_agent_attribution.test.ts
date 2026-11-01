import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  computeLCS,
  computeMyersDiff,
  computeHistoricalBlame,
  computeAgentDiff,
  getAgentMeta,
} from '../src/utils/diffEngine.js';
import { FileHistory } from '../src/types/index.js';

describe('Diff Engine & Agent Attribution', () => {
  it('computes Longest Common Subsequence matrix correctly', () => {
    const a = ['line1', 'line2', 'line3'];
    const b = ['line1', 'lineX', 'line3'];
    const dp = computeLCS(a, b);
    assert.strictEqual(dp[3][3], 2, 'LCS of length 2 (line1 and line3 match)');
  });

  it('accurately computes line-by-line historical blame across multi-agent revisions', () => {
    const history: FileHistory[] = [
      {
        version: 1,
        content: 'import React from "react";\nconst App = () => {\n  return <div>Hello</div>;\n};\nexport default App;',
        timestamp: 1000,
        authorModel: 'software_architect',
        commitMessage: 'Initial scaffolding',
      },
      {
        version: 2,
        content: 'import React from "react";\nconst App = () => {\n  const [count, setCount] = React.useState(0);\n  return <button onClick={() => setCount(c => c + 1)}>Count: {count}</button>;\n};\nexport default App;',
        timestamp: 2000,
        authorModel: 'frontend_developer',
        commitMessage: 'Add interactive state and counter button',
      },
      {
        version: 3,
        content: 'import React from "react";\nconst App = () => {\n  const [count, setCount] = React.useState(0);\n  // Verified no overflow\n  return <button onClick={() => setCount(c => c + 1)}>Count: {count}</button>;\n};\nexport default App;',
        timestamp: 3000,
        authorModel: 'qa_engineer',
        commitMessage: 'Add verification safety comment',
      },
    ];

    const blame = computeHistoricalBlame(history);
    assert.strictEqual(blame.length, 7, 'Total 7 lines in version 3');

    // Line 1: 'import React from "react";' -> authored by software_architect in v1
    assert.strictEqual(blame[0].content, 'import React from "react";');
    assert.strictEqual(blame[0].author, 'software_architect');
    assert.strictEqual(blame[0].version, 1);

    // Line 3: '  const [count, setCount] = React.useState(0);' -> authored by frontend_developer in v2
    assert.strictEqual(blame[2].content, '  const [count, setCount] = React.useState(0);');
    assert.strictEqual(blame[2].author, 'frontend_developer');
    assert.strictEqual(blame[2].version, 2);

    // Line 4: '  // Verified no overflow' -> authored by qa_engineer in v3
    assert.strictEqual(blame[3].content, '  // Verified no overflow');
    assert.strictEqual(blame[3].author, 'qa_engineer');
    assert.strictEqual(blame[3].version, 3);

    // Last Line: 'export default App;' -> authored by software_architect in v1
    assert.strictEqual(blame[6].content, 'export default App;');
    assert.strictEqual(blame[6].author, 'software_architect');
    assert.strictEqual(blame[6].version, 1);
  });

  it('computes unified diff with proper line numbers and agent attribution', () => {
    const oldText = 'function test() {\n  return 1;\n}';
    const newText = 'function test() {\n  const x = 2;\n  return x;\n}';

    const result = computeAgentDiff(oldText, newText, {
      oldVersion: 1,
      newVersion: 2,
      defaultTargetAgent: 'gpt-4o',
      defaultOldAgent: 'claude-3-7-sonnet',
    });

    assert.ok(result.lines.length >= 4, 'Diff contains all lines');
    assert.strictEqual(result.summary.unchanged >= 2, true);
    assert.strictEqual(result.summary.totalChanges >= 2, true);

    const addedLine = result.lines.find(l => l.type === 'added' && l.content === '  const x = 2;');
    assert.ok(addedLine, 'Found added const line');
    assert.strictEqual(addedLine?.author, 'gpt-4o');
    assert.strictEqual(addedLine?.version, 2);

    // Agent stats
    const gptStat = result.summary.agentStats.find(s => s.agent === 'gpt-4o');
    assert.ok(gptStat, 'Agent stats include gpt-4o');
    assert.ok(gptStat!.totalChanges > 0, 'Agent has recorded changes');
  });

  it('computes split rows for side-by-side comparison', () => {
    const oldText = 'alpha\nbeta\ngamma';
    const newText = 'alpha\nBETA_MODIFIED\ngamma\ndelta';

    const result = computeAgentDiff(oldText, newText, {
      defaultTargetAgent: 'deepseek-coder',
    });

    assert.ok(result.splitRows.length >= 3);
    // Find modified row
    const modRow = result.splitRows.find(r => r.left?.type === 'modified' && r.right?.type === 'modified');
    assert.ok(modRow, 'Found split modified row');
    assert.strictEqual(modRow?.left?.content, 'beta');
    assert.strictEqual(modRow?.right?.content, 'BETA_MODIFIED');
    assert.strictEqual(modRow?.right?.author, 'deepseek-coder');

    // Find pure addition row
    const addRow = result.splitRows.find(r => !r.left && r.right?.type === 'added');
    assert.ok(addRow, 'Found split addition row');
    assert.strictEqual(addRow?.right?.content, 'delta');
  });

  it('handles empty baseline diff (initial creation of file)', () => {
    const newText = 'console.log("hello world");';
    const result = computeAgentDiff('', newText, {
      newVersion: 1,
      defaultTargetAgent: 'software_architect',
    });

    assert.strictEqual(result.summary.additions, 1);
    assert.strictEqual(result.summary.deletions, 0);
    assert.strictEqual(result.lines[0].type, 'added');
    assert.strictEqual(result.lines[0].author, 'software_architect');
  });

  it('provides appropriate metadata for agent roles and models', () => {
    const archMeta = getAgentMeta('software_architect');
    assert.ok(archMeta.displayName.includes('Architect') || archMeta.roleIcon === '📐');

    const frontMeta = getAgentMeta('claude-3-7-sonnet');
    assert.ok(frontMeta.badgeClass.includes('amber'));

    const backMeta = getAgentMeta('gpt-4o');
    assert.ok(backMeta.badgeClass.includes('emerald'));

    const qaMeta = getAgentMeta('qa_engineer');
    assert.ok(qaMeta.badgeClass.includes('teal'));
  });

  it('property-based reconstruction invariants: additions + unchanged = new, deletions + unchanged = old', () => {
    const testCases: Array<{ name: string; oldText: string; newText: string }> = [
      { name: 'empty to non-empty', oldText: '', newText: 'line1\nline2\nline3' },
      { name: 'non-empty to empty', oldText: 'line1\nline2\nline3', newText: '' },
      { name: 'both empty', oldText: '', newText: '' },
      { name: 'identical content', oldText: 'a\nb\nc', newText: 'a\nb\nc' },
      { name: 'insertions at beginning', oldText: 'b\nc', newText: 'a\nb\nc' },
      { name: 'insertions at end', oldText: 'a\nb', newText: 'a\nb\nc' },
      { name: 'repeated identical lines', oldText: 'repeat\nrepeat\nrepeat\nfoo', newText: 'repeat\nbar\nrepeat\nrepeat' },
      { name: 'multiline replacement', oldText: 'function oldFn() {\n  return 1;\n}', newText: 'function newFn() {\n  const x = 2;\n  return x * 2;\n}' }
    ];

    // Add 20 randomized test cases
    const vocabulary = ['apple', 'banana', 'cherry', 'date', 'elderberry', 'fig', 'grape', 'const x = 1;', '{', '}', ''];
    for (let seed = 0; seed < 20; seed++) {
      const oldLen = (seed * 3) % 15;
      const newLen = (seed * 5 + 2) % 18;
      const oldLines: string[] = [];
      const newLines: string[] = [];
      for (let i = 0; i < oldLen; i++) {
        oldLines.push(vocabulary[(seed + i * 2) % vocabulary.length]);
      }
      for (let j = 0; j < newLen; j++) {
        newLines.push(vocabulary[(seed * 3 + j) % vocabulary.length]);
      }
      testCases.push({
        name: `randomized_seed_${seed}`,
        oldText: oldLines.join('\n'),
        newText: newLines.join('\n')
      });
    }

    for (const tc of testCases) {
      const oldLines = tc.oldText ? tc.oldText.split('\n') : [];
      const newLines = tc.newText ? tc.newText.split('\n') : [];

      const rawHunks = computeMyersDiff(oldLines, newLines);

      // Invariant 1: unchanged + add reconstructs new file in exact order
      const reconstructedNew = rawHunks
        .filter(h => h.type === 'unchanged' || h.type === 'add')
        .map(h => h.text);
      assert.deepStrictEqual(
        reconstructedNew,
        newLines,
        `Reconstructed new file does not match target in test case "${tc.name}"`
      );

      // Invariant 2: unchanged + delete reconstructs old file in exact order
      const reconstructedOld = rawHunks
        .filter(h => h.type === 'unchanged' || h.type === 'delete')
        .map(h => h.text);
      assert.deepStrictEqual(
        reconstructedOld,
        oldLines,
        `Reconstructed old file does not match baseline in test case "${tc.name}"`
      );

      // Invariant 3: Line numbers remain valid positive integers
      for (const h of rawHunks) {
        if (h.type === 'unchanged' || h.type === 'delete') {
          assert.ok(h.oldLine >= 1 && h.oldLine <= oldLines.length, `oldLine ${h.oldLine} out of bounds in "${tc.name}"`);
        }
        if (h.type === 'unchanged' || h.type === 'add') {
          assert.ok(h.newLine >= 1 && h.newLine <= newLines.length, `newLine ${h.newLine} out of bounds in "${tc.name}"`);
        }
      }
    }
  });

  it('handles empty files, trailing newlines, and exact boundary insertions/deletions', () => {
    // 1. Both empty
    const emptyDiff = computeMyersDiff('', '');
    assert.strictEqual(emptyDiff.length, 0);

    // 2. Old empty, new has content
    const addDiff = computeMyersDiff('', 'line1\nline2');
    assert.strictEqual(addDiff.length, 2);
    assert.strictEqual(addDiff[0].type, 'add');
    assert.strictEqual(addDiff[1].type, 'add');

    // 3. Old has content, new empty
    const delDiff = computeMyersDiff('line1\nline2', '');
    assert.strictEqual(delDiff.length, 2);
    assert.strictEqual(delDiff[0].type, 'delete');
    assert.strictEqual(delDiff[1].type, 'delete');

    // 4. Trailing newline differences
    const withTrailing = 'alpha\nbeta\n';
    const withoutTrailing = 'alpha\nbeta';
    const trailingDiff = computeMyersDiff(withTrailing, withoutTrailing);
    assert.ok(trailingDiff.length >= 2);
    const lastHunk = trailingDiff[trailingDiff.length - 1];
    assert.strictEqual(lastHunk.type, 'delete');
    assert.strictEqual(lastHunk.text, '');

    // 5. Boundary insertions at line 1 and last line
    const base = 'line2\nline3';
    const boundaryAdd = 'line1\nline2\nline3\nline4';
    const bDiff = computeMyersDiff(base, boundaryAdd);
    assert.strictEqual(bDiff[0].type, 'add');
    assert.strictEqual(bDiff[0].text, 'line1');
    assert.strictEqual(bDiff[bDiff.length - 1].type, 'add');
    assert.strictEqual(bDiff[bDiff.length - 1].text, 'line4');
  });

  it('normalizes Windows CRLF and Unicode line breaks without treating them as content edits', () => {
    const windowsText = 'const x = 1;\r\nconst y = 2;\r\n';
    const linuxText = 'const x = 1;\nconst y = 2;\n';
    const diff = computeMyersDiff(windowsText, linuxText);
    // After normalization, all lines match
    assert.ok(diff.every(h => h.type === 'unchanged'), 'Windows vs Linux line endings should normalize to unchanged');
  });

  it('correctly handles repeated identical lines without confusion', () => {
    const oldCode = ['}', '}', '}', 'return null;', '}', '}'];
    const newCode = ['}', '}', 'const active = true;', '}', 'return null;', '}', '}'];
    const hunks = computeMyersDiff(oldCode, newCode);
    const added = hunks.find(h => h.type === 'add');
    assert.ok(added);
    assert.strictEqual(added?.text, 'const active = true;');
  });

  it('generates unique and deterministic line IDs for all lines in diff', () => {
    const oldText = 'alpha\nbeta\nbeta\ngamma';
    const newText = 'alpha\nbeta_modified\nbeta\ngamma\ndelta';
    const diff = computeAgentDiff(oldText, newText);

    const lineIds = diff.lines.map(l => l.lineId);
    const uniqueIds = new Set(lineIds);
    assert.strictEqual(uniqueIds.size, lineIds.length, 'Every lineId in diff must be strictly unique');

    // Run again to verify determinism
    const diff2 = computeAgentDiff(oldText, newText);
    const lineIds2 = diff2.lines.map(l => l.lineId);
    assert.deepStrictEqual(lineIds, lineIds2, 'lineIds must be stable and deterministic');
  });

  it('differentiates comment-only changes from semantic code changes', () => {
    const oldCode = 'const val = calculate(); // calculate total items';
    const newCode = 'const val = calculate(); // calculate all items';
    const result = computeAgentDiff(oldCode, newCode);

    assert.strictEqual(result.summary.commentOnlyChanges >= 1, true);
    const modifiedLine = result.lines.find(l => l.type === 'added');
    assert.strictEqual(modifiedLine?.isCommentOnly, true);
  });

  it('verifies lossless reconstruction of old and new files from diffLines and hunks', () => {
    const original = 'import React from "react";\n\nexport function Component() {\n  const [count, setCount] = React.useState(0);\n  return <button>Click {count}</button>;\n}';
    const modified = 'import React from "react";\nimport { useState } from "react";\n\nexport function Component() {\n  const [count, setCount] = useState(0);\n  const [title] = useState("Counter");\n  return <div><h1>{title}</h1><button>Click {count}</button></div>;\n}';

    const result = computeAgentDiff(original, modified);
    
    // Test reconstruction
    const reconstructedOld = result.lines
      .filter(l => l.type === 'unchanged' || l.type === 'deleted')
      .map(l => l.content)
      .join('\n');
    assert.strictEqual(reconstructedOld, original, 'Old file reconstructed from diffLines must match original');

    const reconstructedNew = result.lines
      .filter(l => l.type === 'unchanged' || l.type === 'added' || l.type === 'reverted' || l.type === 'merged')
      .map(l => l.content)
      .join('\n');
    assert.strictEqual(reconstructedNew, modified, 'New file reconstructed from diffLines must match modified');
  });

  it('computeLCS is backward compatible and throws explicit error for excessive matrices', () => {
    // Normal input works
    const matrix = computeLCS(['a', 'b'], ['a', 'c']);
    assert.strictEqual(matrix[2][2], 1);

    // Oversized input throws explicit error instead of silent truncation or memory crash
    const hugeA = new Array(6000).fill('line');
    const hugeB = new Array(6000).fill('line');
    // 6001 * 6001 = 36,012,001 > 25,000,000 limit
    assert.throws(
      () => computeLCS(hugeA, hugeB),
      /exceeds safe memory limit/
    );
  });
});
