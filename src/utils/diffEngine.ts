/**
 * diffEngine.ts
 * High-performance, pure Myers/LCS diff computation and line-level multi-agent
 * attribution engine for SquadForge.
 */

import { FileHistory } from '../types/index.js';

export type DiffLineType = 'unchanged' | 'added' | 'deleted' | 'modified';

export interface DiffLine {
  id: string;
  type: DiffLineType;
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
  oldContent?: string;
  author?: string;
  commitMessage?: string;
  version?: number;
  timestamp?: number;
}

export interface SplitDiffRow {
  id: string;
  left?: {
    lineNumber: number;
    content: string;
    type: 'unchanged' | 'deleted' | 'modified';
  };
  right?: {
    lineNumber: number;
    content: string;
    type: 'unchanged' | 'added' | 'modified';
    author?: string;
    commitMessage?: string;
    version?: number;
    timestamp?: number;
  };
}

export interface AgentDiffStat {
  agent: string;
  additions: number;
  deletions: number;
  modifications: number;
  totalChanges: number;
  percentage: number;
}

export interface DiffResult {
  lines: DiffLine[];
  splitRows: SplitDiffRow[];
  summary: {
    additions: number;
    deletions: number;
    modifications: number;
    unchanged: number;
    totalChanges: number;
    agentStats: AgentDiffStat[];
  };
}

export interface LineBlame {
  lineNumber: number;
  content: string;
  version: number;
  author: string;
  commitMessage?: string;
  timestamp: number;
}

/**
 * Computes Longest Common Subsequence (LCS) matrix for two line arrays.
 */
export function computeLCS(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (a[i] === b[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  return dp;
}

/**
 * Computes line-level blame tracking across all historical revisions of a file.
 * Traces each final line to the specific historical agent and version that introduced or edited it.
 */
export function computeHistoricalBlame(history: FileHistory[], upToVersion?: number): LineBlame[] {
  if (!history || history.length === 0) return [];

  const sortedHistory = [...history].sort((a, b) => a.version - b.version);
  const targetHistory = upToVersion != null
    ? sortedHistory.filter(h => h.version <= upToVersion)
    : sortedHistory;

  if (targetHistory.length === 0) return [];

  // Initialize with first version
  const first = targetHistory[0];
  const firstLines = first.content.split('\n');
  let currentBlame: LineBlame[] = firstLines.map((content: string, idx: number) => ({
    lineNumber: idx + 1,
    content,
    version: first.version,
    author: first.authorModel || 'initial_agent',
    commitMessage: first.commitMessage,
    timestamp: first.timestamp || Date.now(),
  }));

  // Step through each revision and propagate blame
  for (let step = 1; step < targetHistory.length; step++) {
    const rev = targetHistory[step];
    const prevLines = currentBlame.map(b => b.content);
    const nextLines = rev.content.split('\n');

    const dp = computeLCS(prevLines, nextLines);
    let i = prevLines.length;
    let j = nextLines.length;

    const newBlameReversed: LineBlame[] = [];

    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && prevLines[i - 1] === nextLines[j - 1]) {
        // Unchanged line keeps previous blame
        const prev = currentBlame[i - 1];
        newBlameReversed.push({
          lineNumber: j,
          content: nextLines[j - 1],
          version: prev.version,
          author: prev.author,
          commitMessage: prev.commitMessage,
          timestamp: prev.timestamp,
        });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        // Added line attributed to current revision's author
        newBlameReversed.push({
          lineNumber: j,
          content: nextLines[j - 1],
          version: rev.version,
          author: rev.authorModel || 'unknown_agent',
          commitMessage: rev.commitMessage,
          timestamp: rev.timestamp || Date.now(),
        });
        j--;
      } else if (i > 0) {
        // Line was deleted from prev, skip
        i--;
      }
    }

    currentBlame = newBlameReversed.reverse();
    // Correct 1-indexed line numbers
    currentBlame.forEach((b, idx) => {
      b.lineNumber = idx + 1;
    });
  }

  return currentBlame;
}

/**
 * Computes an interactive diff comparing two texts, attributing changes to agents.
 * Can use historical blame to attribute target lines to the exact agent that wrote them.
 */
export function computeAgentDiff(
  oldContent: string,
  newContent: string,
  options?: {
    oldVersion?: number;
    newVersion?: number;
    defaultTargetAgent?: string;
    defaultOldAgent?: string;
    commitMessage?: string;
    timestamp?: number;
    blameMap?: LineBlame[];
  }
): DiffResult {
  const oldLines = oldContent ? oldContent.split('\n') : [];
  const newLines = newContent ? newContent.split('\n') : [];

  const dp = computeLCS(oldLines, newLines);
  let i = oldLines.length;
  let j = newLines.length;

  type RawHunk = 
    | { type: 'unchanged'; oldLine: number; newLine: number; text: string }
    | { type: 'delete'; oldLine: number; text: string }
    | { type: 'add'; newLine: number; text: string };

  const rawHunks: RawHunk[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      rawHunks.push({
        type: 'unchanged',
        oldLine: i,
        newLine: j,
        text: oldLines[i - 1],
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawHunks.push({
        type: 'add',
        newLine: j,
        text: newLines[j - 1],
      });
      j--;
    } else if (i > 0) {
      rawHunks.push({
        type: 'delete',
        oldLine: i,
        text: oldLines[i - 1],
      });
      i--;
    }
  }

  rawHunks.reverse();

  // Create blame lookup map by 1-indexed line number in newContent
  const blameLookup = new Map<number, LineBlame>();
  if (options?.blameMap) {
    for (const b of options.blameMap) {
      blameLookup.set(b.lineNumber, b);
    }
  }

  const unifiedLines: DiffLine[] = [];
  const splitRows: SplitDiffRow[] = [];

  let additions = 0;
  let deletions = 0;
  let modifications = 0;
  let unchanged = 0;
  const agentChangeMap = new Map<string, { additions: number; deletions: number; modifications: number }>();

  const trackAgentChange = (agent: string, type: 'add' | 'delete' | 'modify') => {
    const key = agent || 'swarm_agent';
    const entry = agentChangeMap.get(key) || { additions: 0, deletions: 0, modifications: 0 };
    if (type === 'add') entry.additions++;
    else if (type === 'delete') entry.deletions++;
    else if (type === 'modify') entry.modifications++;
    agentChangeMap.set(key, entry);
  };

  // Convert raw hunks into paired modified blocks or add/delete lines
  let idx = 0;
  let lineKey = 0;

  while (idx < rawHunks.length) {
    const current = rawHunks[idx];

    if (current.type === 'unchanged') {
      unchanged++;
      const blame = blameLookup.get(current.newLine);
      const rowId = `row-${lineKey++}`;

      unifiedLines.push({
        id: `u-${rowId}`,
        type: 'unchanged',
        oldLineNumber: current.oldLine,
        newLineNumber: current.newLine,
        content: current.text,
        author: blame?.author || options?.defaultTargetAgent,
        version: blame?.version ?? options?.newVersion,
        commitMessage: blame?.commitMessage ?? options?.commitMessage,
        timestamp: blame?.timestamp ?? options?.timestamp,
      });

      splitRows.push({
        id: `s-${rowId}`,
        left: {
          lineNumber: current.oldLine,
          content: current.text,
          type: 'unchanged',
        },
        right: {
          lineNumber: current.newLine,
          content: current.text,
          type: 'unchanged',
          author: blame?.author || options?.defaultTargetAgent,
          version: blame?.version ?? options?.newVersion,
          commitMessage: blame?.commitMessage ?? options?.commitMessage,
          timestamp: blame?.timestamp ?? options?.timestamp,
        },
      });

      idx++;
    } else {
      // Gather consecutive deletions and additions
      const delGroup: Extract<RawHunk, { type: 'delete' }>[] = [];
      const addGroup: Extract<RawHunk, { type: 'add' }>[] = [];

      while (idx < rawHunks.length && rawHunks[idx].type !== 'unchanged') {
        const item = rawHunks[idx];
        if (item.type === 'delete') delGroup.push(item);
        else if (item.type === 'add') addGroup.push(item);
        idx++;
      }

      // Check if this is a 1-to-1 modification or block modification
      const maxPair = Math.max(delGroup.length, addGroup.length);

      for (let p = 0; p < maxPair; p++) {
        const del = delGroup[p];
        const add = addGroup[p];
        const rowId = `mod-${lineKey++}`;

        if (del && add) {
          // Paired modification
          modifications++;
          const blame = blameLookup.get(add.newLine);
          const author = blame?.author || options?.defaultTargetAgent || 'swarm_agent';
          trackAgentChange(author, 'modify');

          // In unified view, we show delete then add (standard git diff style)
          unifiedLines.push({
            id: `u-del-${rowId}`,
            type: 'deleted',
            oldLineNumber: del.oldLine,
            content: del.text,
            author: options?.defaultOldAgent,
            version: options?.oldVersion,
          });

          unifiedLines.push({
            id: `u-add-${rowId}`,
            type: 'added',
            newLineNumber: add.newLine,
            content: add.text,
            oldContent: del.text,
            author,
            version: blame?.version ?? options?.newVersion,
            commitMessage: blame?.commitMessage ?? options?.commitMessage,
            timestamp: blame?.timestamp ?? options?.timestamp,
          });

          splitRows.push({
            id: `s-${rowId}`,
            left: {
              lineNumber: del.oldLine,
              content: del.text,
              type: 'modified',
            },
            right: {
              lineNumber: add.newLine,
              content: add.text,
              type: 'modified',
              author,
              version: blame?.version ?? options?.newVersion,
              commitMessage: blame?.commitMessage ?? options?.commitMessage,
              timestamp: blame?.timestamp ?? options?.timestamp,
            },
          });
        } else if (del) {
          // Pure deletion
          deletions++;
          const author = options?.defaultOldAgent || options?.defaultTargetAgent || 'swarm_agent';
          trackAgentChange(author, 'delete');

          unifiedLines.push({
            id: `u-${rowId}`,
            type: 'deleted',
            oldLineNumber: del.oldLine,
            content: del.text,
            author: options?.defaultOldAgent,
            version: options?.oldVersion,
          });

          splitRows.push({
            id: `s-${rowId}`,
            left: {
              lineNumber: del.oldLine,
              content: del.text,
              type: 'deleted',
            },
            right: undefined,
          });
        } else if (add) {
          // Pure addition
          additions++;
          const blame = blameLookup.get(add.newLine);
          const author = blame?.author || options?.defaultTargetAgent || 'swarm_agent';
          trackAgentChange(author, 'add');

          unifiedLines.push({
            id: `u-${rowId}`,
            type: 'added',
            newLineNumber: add.newLine,
            content: add.text,
            author,
            version: blame?.version ?? options?.newVersion,
            commitMessage: blame?.commitMessage ?? options?.commitMessage,
            timestamp: blame?.timestamp ?? options?.timestamp,
          });

          splitRows.push({
            id: `s-${rowId}`,
            left: undefined,
            right: {
              lineNumber: add.newLine,
              content: add.text,
              type: 'added',
              author,
              version: blame?.version ?? options?.newVersion,
              commitMessage: blame?.commitMessage ?? options?.commitMessage,
              timestamp: blame?.timestamp ?? options?.timestamp,
            },
          });
        }
      }
    }
  }

  const totalChanges = additions + deletions + modifications;

  const agentStats: AgentDiffStat[] = Array.from(agentChangeMap.entries()).map(([agent, stats]) => {
    const changes = stats.additions + stats.deletions + stats.modifications;
    return {
      agent,
      additions: stats.additions,
      deletions: stats.deletions,
      modifications: stats.modifications,
      totalChanges: changes,
      percentage: totalChanges > 0 ? Math.round((changes / totalChanges) * 100) : 0,
    };
  }).sort((a, b) => b.totalChanges - a.totalChanges);

  return {
    lines: unifiedLines,
    splitRows,
    summary: {
      additions,
      deletions,
      modifications,
      unchanged,
      totalChanges,
      agentStats,
    },
  };
}

/**
 * Maps an agent or model identifier to a standardized UI display role, avatar, and color theme.
 */
export function getAgentMeta(agentName?: string): {
  displayName: string;
  badgeClass: string;
  borderClass: string;
  bgGlowClass: string;
  roleIcon: string;
} {
  const name = (agentName || 'Swarm Agent').toLowerCase();

  if (name.includes('architect') || name.includes('gpt-4.5') || name.includes('o1')) {
    return {
      displayName: agentName || 'Software Architect',
      badgeClass: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
      borderClass: 'border-l-purple-500',
      bgGlowClass: 'bg-purple-500/5',
      roleIcon: '📐',
    };
  }

  if (name.includes('frontend') || name.includes('claude')) {
    return {
      displayName: agentName || 'Frontend Developer',
      badgeClass: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
      borderClass: 'border-l-amber-500',
      bgGlowClass: 'bg-amber-500/5',
      roleIcon: '🎨',
    };
  }

  if (name.includes('backend') || name.includes('gpt-4o') || name.includes('codex')) {
    return {
      displayName: agentName || 'Backend Developer',
      badgeClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      borderClass: 'border-l-emerald-500',
      bgGlowClass: 'bg-emerald-500/5',
      roleIcon: '⚡',
    };
  }

  if (name.includes('qa') || name.includes('test') || name.includes('verifier')) {
    return {
      displayName: agentName || 'QA & Test Engineer',
      badgeClass: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
      borderClass: 'border-l-teal-500',
      bgGlowClass: 'bg-teal-500/5',
      roleIcon: '🧪',
    };
  }

  if (name.includes('security') || name.includes('audit')) {
    return {
      displayName: agentName || 'Security Auditor',
      badgeClass: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
      borderClass: 'border-l-rose-500',
      bgGlowClass: 'bg-rose-500/5',
      roleIcon: '🛡️',
    };
  }

  if (name.includes('gemini')) {
    return {
      displayName: agentName || 'Gemini 2.5',
      badgeClass: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
      borderClass: 'border-l-blue-500',
      bgGlowClass: 'bg-blue-500/5',
      roleIcon: '✨',
    };
  }

  if (name.includes('deepseek')) {
    return {
      displayName: agentName || 'DeepSeek Engine',
      badgeClass: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
      borderClass: 'border-l-cyan-500',
      bgGlowClass: 'bg-cyan-500/5',
      roleIcon: '🧠',
    };
  }

  return {
    displayName: agentName || 'Swarm Engineer',
    badgeClass: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
    borderClass: 'border-l-indigo-500',
    bgGlowClass: 'bg-indigo-500/5',
    roleIcon: '🤖',
  };
}
