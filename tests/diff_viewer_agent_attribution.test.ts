import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  computeLCS,
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
});
