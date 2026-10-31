/**
 * diffEngine.ts
 * High-performance, pure Myers/LCS diff computation, line-level multi-agent
 * attribution, formatting-only detection, overlapping edit detection, and
 * revision timeline engine for SquadForge.
 */

import { FileHistory } from '../types/index.js';

export type DiffLineType = 'unchanged' | 'added' | 'deleted' | 'modified' | 'reverted' | 'merged';

export interface DiffLine {
  id: string;
  type: DiffLineType;
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
  oldContent?: string;
  author?: string;
  authorModel?: string;
  taskId?: string;
  commitMessage?: string;
  version?: number;
  timestamp?: number;
  isFormattingOnly?: boolean;
  changeCategory?: 'added' | 'removed' | 'modified' | 'reverted' | 'merged';
  overlappingAgents?: string[];
}

export interface SplitDiffRow {
  id: string;
  left?: {
    lineNumber: number;
    content: string;
    type: 'unchanged' | 'deleted' | 'modified' | 'reverted';
    isFormattingOnly?: boolean;
    taskId?: string;
  };
  right?: {
    lineNumber: number;
    content: string;
    type: 'unchanged' | 'added' | 'modified' | 'reverted' | 'merged';
    author?: string;
    commitMessage?: string;
    version?: number;
    timestamp?: number;
    isFormattingOnly?: boolean;
    taskId?: string;
  };
}

export interface AgentDiffStat {
  agent: string;
  additions: number;
  deletions: number;
  modifications: number;
  totalChanges: number;
  percentage: number;
  formattingOnlyCount?: number;
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
    formattingOnlyChanges: number;
    isCompletelyFormattingOnly: boolean;
    agentStats: AgentDiffStat[];
  };
}

export interface LineBlame {
  lineNumber: number;
  content: string;
  version: number;
  author: string;
  taskId?: string;
  commitMessage?: string;
  timestamp: number;
  isReverted?: boolean;
  revisionHistory?: Array<{
    version: number;
    author: string;
    taskId?: string;
    timestamp: number;
    action: 'created' | 'modified' | 'reverted';
  }>;
}

export interface OverlappingEdit {
  startLine: number;
  endLine: number;
  content: string;
  agentsInvolved: string[];
  versionsInvolved: number[];
  tasksInvolved: string[];
  isReverted: boolean;
  summary: string;
}

export interface FileRevisionTimelineEntry {
  version: number;
  timestamp: number;
  author: string;
  taskId?: string;
  commitMessage?: string;
  changeType: 'added' | 'removed' | 'modified' | 'reverted' | 'merged';
  isFormattingOnly: boolean;
  additions: number;
  deletions: number;
  modifications: number;
  isRenamed?: boolean;
  originalPath?: string;
  isDeleted?: boolean;
  isRecreated?: boolean;
  overlappingAgents?: string[];
}

export interface FileLifecycleAudit {
  path: string;
  isRenamed: boolean;
  originalPath?: string;
  isDeleted: boolean;
  isRecreated: boolean;
  versionCount: number;
  lifecycleStatus: 'created' | 'renamed' | 'deleted' | 'recreated' | 'active';
  authors: string[];
}

/**
 * Normalizes a line of code for semantic comparison:
 * strips leading/trailing whitespace, collapses internal whitespace,
 * normalizes single/double quotes, and strips optional trailing semicolons/commas.
 */
export function normalizeCodeForComparison(line: string): string {
  if (!line) return '';
  return line
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/["']/g, "'")
    .replace(/;+$/, '')
    .replace(/,+$/, '');
}

/**
 * Distinguishes semantic code changes from formatting-only changes (whitespace, indentation, quotes, semicolons).
 */
export function isFormattingOnlyChange(oldStr: string, newStr: string): boolean {
  if (oldStr === newStr) return true;
  return normalizeCodeForComparison(oldStr) === normalizeCodeForComparison(newStr);
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
 * Checks whether line content matches an ancestor version (prior to the immediate predecessor),
 * indicating a reverted code change.
 */
function findAncestorMatchVersion(line: string, sortedAncestors: FileHistory[], currentVersion: number): number | null {
  for (const ancestor of sortedAncestors) {
    if (ancestor.version < currentVersion - 1) {
      const ancestorLines = ancestor.content.split('\n');
      if (ancestorLines.includes(line)) {
        return ancestor.version;
      }
    }
  }
  return null;
}

/**
 * Computes line-level blame tracking across all historical revisions of a file.
 * Traces each final line to the specific historical agent, task, and version that introduced or edited it.
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
    taskId: first.taskId,
    commitMessage: first.commitMessage,
    timestamp: first.timestamp || Date.now(),
    revisionHistory: [{
      version: first.version,
      author: first.authorModel || 'initial_agent',
      taskId: first.taskId,
      timestamp: first.timestamp || Date.now(),
      action: 'created'
    }]
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
          taskId: prev.taskId,
          commitMessage: prev.commitMessage,
          timestamp: prev.timestamp,
          isReverted: prev.isReverted,
          revisionHistory: prev.revisionHistory ? [...prev.revisionHistory] : []
        });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        // Added or modified line attributed to current revision's author
        const addedContent = nextLines[j - 1];
        const ancestorMatch = findAncestorMatchVersion(addedContent, sortedHistory.slice(0, step), rev.version);
        const isReverted = ancestorMatch !== null;

        newBlameReversed.push({
          lineNumber: j,
          content: addedContent,
          version: rev.version,
          author: rev.authorModel || 'unknown_agent',
          taskId: rev.taskId,
          commitMessage: rev.commitMessage,
          timestamp: rev.timestamp || Date.now(),
          isReverted,
          revisionHistory: [{
            version: rev.version,
            author: rev.authorModel || 'unknown_agent',
            taskId: rev.taskId,
            timestamp: rev.timestamp || Date.now(),
            action: isReverted ? 'reverted' : 'modified'
          }]
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
 * Detects overlapping edits where multiple agents have touched or modified the same file ranges across history.
 */
export function detectOverlappingEdits(history: FileHistory[]): OverlappingEdit[] {
  if (!history || history.length < 2) return [];

  const sortedHistory = [...history].sort((a, b) => a.version - b.version);
  const overlappingEdits: OverlappingEdit[] = [];
  const lineAuthorsMap = new Map<number, Set<string>>();
  const lineVersionsMap = new Map<number, Set<number>>();
  const lineTasksMap = new Map<number, Set<string>>();
  const lineContentMap = new Map<number, string>();

  // Walk through each version to track line presence
  for (const ver of sortedHistory) {
    const lines = ver.content.split('\n');
    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      lineContentMap.set(lineNum, line);

      if (!lineAuthorsMap.has(lineNum)) lineAuthorsMap.set(lineNum, new Set());
      if (!lineVersionsMap.has(lineNum)) lineVersionsMap.set(lineNum, new Set());
      if (!lineTasksMap.has(lineNum)) lineTasksMap.set(lineNum, new Set());

      if (ver.authorModel) lineAuthorsMap.get(lineNum)!.add(ver.authorModel);
      lineVersionsMap.get(lineNum)!.add(ver.version);
      if (ver.taskId) lineTasksMap.get(lineNum)!.add(ver.taskId);
    });
  }

  // Detect consecutive blocks touched by 2+ different authors
  let blockStart: number | null = null;
  let currentAuthors = new Set<string>();
  let currentVersions = new Set<number>();
  let currentTasks = new Set<string>();
  let blockContent: string[] = [];

  const totalLines = Math.max(...Array.from(lineContentMap.keys()), 0);

  for (let l = 1; l <= totalLines; l++) {
    const authors = lineAuthorsMap.get(l);
    if (authors && authors.size >= 2) {
      if (blockStart === null) {
        blockStart = l;
        currentAuthors = new Set(authors);
        currentVersions = new Set(lineVersionsMap.get(l) || []);
        currentTasks = new Set(lineTasksMap.get(l) || []);
        blockContent = [lineContentMap.get(l) || ''];
      } else {
        authors.forEach(a => currentAuthors.add(a));
        (lineVersionsMap.get(l) || []).forEach(v => currentVersions.add(v));
        (lineTasksMap.get(l) || []).forEach(t => currentTasks.add(t));
        blockContent.push(lineContentMap.get(l) || '');
      }
    } else {
      if (blockStart !== null) {
        overlappingEdits.push({
          startLine: blockStart,
          endLine: l - 1,
          content: blockContent.join('\n'),
          agentsInvolved: Array.from(currentAuthors),
          versionsInvolved: Array.from(currentVersions).sort((a, b) => a - b),
          tasksInvolved: Array.from(currentTasks),
          isReverted: false,
          summary: `Lines ${blockStart}-${l - 1} jointly modified by ${Array.from(currentAuthors).join(', ')} across ${currentVersions.size} revisions`
        });
        blockStart = null;
        currentAuthors = new Set();
        currentVersions = new Set();
        currentTasks = new Set();
        blockContent = [];
      }
    }
  }

  if (blockStart !== null) {
    overlappingEdits.push({
      startLine: blockStart,
      endLine: totalLines,
      content: blockContent.join('\n'),
      agentsInvolved: Array.from(currentAuthors),
      versionsInvolved: Array.from(currentVersions).sort((a, b) => a - b),
      tasksInvolved: Array.from(currentTasks),
      isReverted: false,
      summary: `Lines ${blockStart}-${totalLines} jointly modified by ${Array.from(currentAuthors).join(', ')}`
    });
  }

  return overlappingEdits;
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
    taskId?: string;
    blameMap?: LineBlame[];
    history?: FileHistory[];
    isMerged?: boolean;
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
  let formattingOnlyCount = 0;
  const agentChangeMap = new Map<string, { additions: number; deletions: number; modifications: number; formattingOnly: number }>();

  const trackAgentChange = (agent: string, type: 'add' | 'delete' | 'modify', isFmt: boolean = false) => {
    const key = agent || 'swarm_agent';
    const entry = agentChangeMap.get(key) || { additions: 0, deletions: 0, modifications: 0, formattingOnly: 0 };
    if (type === 'add') entry.additions++;
    else if (type === 'delete') entry.deletions++;
    else if (type === 'modify') entry.modifications++;
    if (isFmt) entry.formattingOnly++;
    agentChangeMap.set(key, entry);
  };

  // Helper to test if added content is a reverted change from an older version
  const checkReverted = (text: string): boolean => {
    if (!options?.history || options.history.length < 2) return false;
    const curVer = options.newVersion || 999;
    for (const h of options.history) {
      if (h.version < curVer - 1 && h.content.split('\n').includes(text)) {
        return true;
      }
    }
    return false;
  };

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
        authorModel: blame?.author || options?.defaultTargetAgent,
        taskId: blame?.taskId || options?.taskId,
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
          taskId: blame?.taskId || options?.taskId,
        },
        right: {
          lineNumber: current.newLine,
          content: current.text,
          type: 'unchanged',
          author: blame?.author || options?.defaultTargetAgent,
          version: blame?.version ?? options?.newVersion,
          commitMessage: blame?.commitMessage ?? options?.commitMessage,
          timestamp: blame?.timestamp ?? options?.timestamp,
          taskId: blame?.taskId || options?.taskId,
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
          const isFmt = isFormattingOnlyChange(del.text, add.text);
          const isRev = checkReverted(add.text);
          const changeType: DiffLineType = isRev ? 'reverted' : options?.isMerged ? 'merged' : 'modified';

          if (isFmt) formattingOnlyCount++;
          trackAgentChange(author, 'modify', isFmt);

          unifiedLines.push({
            id: `u-del-${rowId}`,
            type: 'deleted',
            oldLineNumber: del.oldLine,
            content: del.text,
            author: options?.defaultOldAgent,
            version: options?.oldVersion,
            isFormattingOnly: isFmt,
            changeCategory: 'removed',
            taskId: options?.taskId,
          });

          unifiedLines.push({
            id: `u-add-${rowId}`,
            type: 'added',
            newLineNumber: add.newLine,
            content: add.text,
            oldContent: del.text,
            author,
            authorModel: author,
            taskId: blame?.taskId || options?.taskId,
            version: blame?.version ?? options?.newVersion,
            commitMessage: blame?.commitMessage ?? options?.commitMessage,
            timestamp: blame?.timestamp ?? options?.timestamp,
            isFormattingOnly: isFmt,
            changeCategory: isRev ? 'reverted' : options?.isMerged ? 'merged' : 'modified',
          });

          splitRows.push({
            id: `s-${rowId}`,
            left: {
              lineNumber: del.oldLine,
              content: del.text,
              type: 'modified',
              isFormattingOnly: isFmt,
              taskId: options?.taskId,
            },
            right: {
              lineNumber: add.newLine,
              content: add.text,
              type: 'modified',
              author,
              version: blame?.version ?? options?.newVersion,
              commitMessage: blame?.commitMessage ?? options?.commitMessage,
              timestamp: blame?.timestamp ?? options?.timestamp,
              isFormattingOnly: isFmt,
              taskId: blame?.taskId || options?.taskId,
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
            changeCategory: 'removed',
            taskId: options?.taskId,
          });

          splitRows.push({
            id: `s-${rowId}`,
            left: {
              lineNumber: del.oldLine,
              content: del.text,
              type: 'deleted',
              taskId: options?.taskId,
            },
            right: undefined,
          });
        } else if (add) {
          // Pure addition
          additions++;
          const blame = blameLookup.get(add.newLine);
          const author = blame?.author || options?.defaultTargetAgent || 'swarm_agent';
          const isRev = checkReverted(add.text);
          const changeType: DiffLineType = isRev ? 'reverted' : options?.isMerged ? 'merged' : 'added';

          trackAgentChange(author, 'add');

          unifiedLines.push({
            id: `u-${rowId}`,
            type: changeType,
            newLineNumber: add.newLine,
            content: add.text,
            author,
            authorModel: author,
            taskId: blame?.taskId || options?.taskId,
            version: blame?.version ?? options?.newVersion,
            commitMessage: blame?.commitMessage ?? options?.commitMessage,
            timestamp: blame?.timestamp ?? options?.timestamp,
            changeCategory: isRev ? 'reverted' : options?.isMerged ? 'merged' : 'added',
          });

          splitRows.push({
            id: `s-${rowId}`,
            left: undefined,
            right: {
              lineNumber: add.newLine,
              content: add.text,
              type: changeType,
              author,
              version: blame?.version ?? options?.newVersion,
              commitMessage: blame?.commitMessage ?? options?.commitMessage,
              timestamp: blame?.timestamp ?? options?.timestamp,
              taskId: blame?.taskId || options?.taskId,
            },
          });
        }
      }
    }
  }

  const totalChanges = additions + deletions + modifications;
  const isCompletelyFormattingOnly = totalChanges > 0 && modifications > 0 && additions === 0 && deletions === 0 && formattingOnlyCount === modifications;

  const agentStats: AgentDiffStat[] = Array.from(agentChangeMap.entries()).map(([agent, stats]) => {
    const changes = stats.additions + stats.deletions + stats.modifications;
    return {
      agent,
      additions: stats.additions,
      deletions: stats.deletions,
      modifications: stats.modifications,
      totalChanges: changes,
      percentage: totalChanges > 0 ? Math.round((changes / totalChanges) * 100) : 0,
      formattingOnlyCount: stats.formattingOnly,
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
      formattingOnlyChanges: formattingOnlyCount,
      isCompletelyFormattingOnly,
      agentStats,
    },
  };
}

/**
 * Computes a comprehensive revision timeline across all versions of a file,
 * identifying changes, commit author, task IDs, and overlapping edits.
 */
export function computeFileRevisionTimeline(
  history: FileHistory[],
  fileMeta?: {
    isRenamed?: boolean;
    originalPath?: string;
    isDeleted?: boolean;
    isRecreated?: boolean;
  }
): FileRevisionTimelineEntry[] {
  if (!history || history.length === 0) return [];

  const sorted = [...history].sort((a, b) => a.version - b.version);
  const timeline: FileRevisionTimelineEntry[] = [];

  for (let idx = 0; idx < sorted.length; idx++) {
    const current = sorted[idx];
    const prev = idx > 0 ? sorted[idx - 1] : null;

    if (!prev) {
      // Version 1 creation
      const lines = current.content.split('\n');
      timeline.push({
        version: current.version,
        timestamp: current.timestamp || Date.now(),
        author: current.authorModel || 'initial_agent',
        taskId: current.taskId,
        commitMessage: current.commitMessage || 'Initial file creation',
        changeType: fileMeta?.isRecreated ? 'added' : 'added',
        isFormattingOnly: false,
        additions: lines.length,
        deletions: 0,
        modifications: 0,
        isRenamed: fileMeta?.isRenamed,
        originalPath: fileMeta?.originalPath,
        isDeleted: fileMeta?.isDeleted,
        isRecreated: fileMeta?.isRecreated
      });
    } else {
      const diff = computeAgentDiff(prev.content, current.content, {
        oldVersion: prev.version,
        newVersion: current.version,
        defaultTargetAgent: current.authorModel,
        history: sorted.slice(0, idx + 1),
        taskId: current.taskId
      });

      const isRev = diff.lines.some(l => l.type === 'reverted');
      const changeType = isRev ? 'reverted' : diff.summary.modifications > 0 ? 'modified' : 'added';

      timeline.push({
        version: current.version,
        timestamp: current.timestamp || Date.now(),
        author: current.authorModel || 'swarm_agent',
        taskId: current.taskId,
        commitMessage: current.commitMessage || `Revision v${current.version}`,
        changeType,
        isFormattingOnly: diff.summary.isCompletelyFormattingOnly,
        additions: diff.summary.additions,
        deletions: diff.summary.deletions,
        modifications: diff.summary.modifications,
        isRenamed: fileMeta?.isRenamed,
        originalPath: fileMeta?.originalPath,
        isDeleted: fileMeta?.isDeleted,
        isRecreated: fileMeta?.isRecreated
      });
    }
  }

  return timeline;
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
