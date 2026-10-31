/**
 * diffEngine.ts
 * High-performance Myers diff computation, adaptive file-size algorithm selection,
 * memory-protected execution, syntax-aware formatting-only comparison, line-level
 * multi-agent attribution, genuine revert tracking, overlapping edit detection,
 * and revision timeline engine for SquadForge.
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
    formattingOnlyCount: number;
    isCompletelyFormattingOnly: boolean;
    agentStats: AgentDiffStat[];
  };
  overlappingEdits?: OverlappingEdit[];
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

export type DiffHunkRaw =
  | { type: 'unchanged'; oldLine: number; newLine: number; text: string }
  | { type: 'delete'; oldLine: number; text: string }
  | { type: 'add'; newLine: number; text: string };

// ---------------------------------------------------------------------------
// 1. Syntax-Aware Tokenization & Formatting Detection
// ---------------------------------------------------------------------------

/**
 * Normalizes a line of code for semantic comparison:
 * Tokenizes the code while strictly preserving string and template literal contents.
 * Normalizes surrounding whitespace and optional trailing statement semicolons.
 */
export function normalizeCodeForComparison(line: string): string {
  if (!line || !line.trim()) return '';

  try {
    const tokens: string[] = [];
    const regex = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|===|!==|<=|>=|=>|\+\+|--|&&|\|\||\?\?|\+=|-=|\*=|\/=|[\w$]+|[^\s\w$])/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(line)) !== null) {
      const raw = match[0];
      if (raw.startsWith('//')) {
        tokens.push(`__CMT__${raw.slice(2).trim().replace(/\s+/g, ' ')}`);
      } else if (raw.startsWith('/*')) {
        tokens.push(`__CMT__${raw.slice(2, -2).trim().replace(/\s+/g, ' ')}`);
      } else if (raw.startsWith('"') || raw.startsWith("'")) {
        // Content inside string without outer quotes
        tokens.push(`__STR__${raw.slice(1, -1)}`);
      } else if (raw.startsWith('`')) {
        tokens.push(`__TMPL__${raw.slice(1, -1)}`);
      } else if (raw !== ';') {
        tokens.push(raw);
      }
    }

    return tokens.join(' ');
  } catch {
    // Fallback safe normalization
    return line
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/;+$/, '');
  }
}

/**
 * Distinguishes semantic code changes from formatting-only changes.
 * Preserves exact contents of string literals, template literals, and operators.
 * Accurately detects whitespace, indentation, quote swaps (where contents match),
 * and optional semicolons.
 */
export function isFormattingOnlyChange(oldStr: string, newStr: string): boolean {
  if (oldStr === newStr) return true;

  const oldTrimmed = oldStr.trim();
  const newTrimmed = newStr.trim();

  // If both empty or whitespace-only
  if (!oldTrimmed && !newTrimmed) return true;
  if (!oldTrimmed || !newTrimmed) return false;

  // Exact comparison after token-level normalization
  return normalizeCodeForComparison(oldStr) === normalizeCodeForComparison(newStr);
}

// ---------------------------------------------------------------------------
// 2. Memory-Efficient Myers Diff Algorithm with Adaptive Selection
// ---------------------------------------------------------------------------

/**
 * Computes Longest Common Subsequence (LCS) matrix for two line arrays.
 * Retained for backwards compatibility, with memory protection on huge line counts.
 */
export function computeLCS(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;

  // Protect against massive memory allocations on unbounded matrices
  if (m * n > 4000000) {
    const dp: number[][] = Array.from({ length: 2 }, () => new Array(n + 1).fill(0));
    let prev = 0;
    let curr = 1;
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        if (a[i] === b[j]) {
          dp[curr][j + 1] = dp[prev][j] + 1;
        } else {
          dp[curr][j + 1] = Math.max(dp[prev][j + 1], dp[curr][j]);
        }
      }
      prev = curr;
      curr = 1 - curr;
    }
    // Return a dummy matrix where dp[m][n] has the length
    const resultMatrix = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    resultMatrix[m][n] = dp[prev][n];
    return resultMatrix;
  }

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
 * Computes difference using Myers diff algorithm with adaptive selection:
 * - Prefix & suffix line trimming (eliminates 90%+ of work on typical file edits)
 * - Fast path for identical sequences
 * - Memory-efficient O(ND) Myers algorithm
 * - Bounded search for very large files to prevent catastrophic memory usage
 */
export function computeMyersDiff(a: string[], b: string[]): DiffHunkRaw[] {
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) {
    return b.map((text, idx) => ({ type: 'add', newLine: idx + 1, text }));
  }
  if (m === 0) {
    return a.map((text, idx) => ({ type: 'delete', oldLine: idx + 1, text }));
  }

  // 1. Common prefix trimming
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) {
    prefix++;
  }

  // 2. Common suffix trimming
  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    a[n - 1 - suffix] === b[m - 1 - suffix]
  ) {
    suffix++;
  }

  const prefixHunks: DiffHunkRaw[] = [];
  for (let i = 0; i < prefix; i++) {
    prefixHunks.push({
      type: 'unchanged',
      oldLine: i + 1,
      newLine: i + 1,
      text: a[i],
    });
  }

  const suffixHunks: DiffHunkRaw[] = [];
  for (let i = 0; i < suffix; i++) {
    const aIdx = n - suffix + i;
    const bIdx = m - suffix + i;
    suffixHunks.push({
      type: 'unchanged',
      oldLine: aIdx + 1,
      newLine: bIdx + 1,
      text: a[aIdx],
    });
  }

  const midA = a.slice(prefix, n - suffix);
  const midB = b.slice(prefix, m - suffix);
  const midN = midA.length;
  const midM = midB.length;
  let midHunks: DiffHunkRaw[] = [];

  if (midN === 0) {
    for (let j = 0; j < midM; j++) {
      midHunks.push({
        type: 'add',
        newLine: prefix + j + 1,
        text: midB[j],
      });
    }
  } else if (midM === 0) {
    for (let i = 0; i < midN; i++) {
      midHunks.push({
        type: 'delete',
        oldLine: prefix + i + 1,
        text: midA[i],
      });
    }
  } else {
    // Myers O(ND) algorithm with memory protection
    const max = midN + midM;
    const effectiveMax = Math.min(max, 10000);
    const v = new Int32Array(2 * effectiveMax + 1);
    const offset = effectiveMax;
    v[offset + 1] = 0;
    const trace: Int32Array[] = [];
    let reached = false;
    let finalD = 0;

    for (let d = 0; d <= effectiveMax; d++) {
      trace.push(new Int32Array(v));
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]))
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
        let y = x - k;

        while (x < midN && y < midM && midA[x] === midB[y]) {
          x++;
          y++;
        }

        v[offset + k] = x;
        if (x >= midN && y >= midM) {
          reached = true;
          finalD = d;
          break;
        }
      }
      if (reached) break;
    }

    if (!reached) {
      // Bounded fallback: delete all old lines in block, then add all new lines
      for (let i = 0; i < midN; i++) {
        midHunks.push({ type: 'delete', text: midA[i], oldLine: prefix + i + 1 });
      }
      for (let j = 0; j < midM; j++) {
        midHunks.push({ type: 'add', text: midB[j], newLine: prefix + j + 1 });
      }
    } else {
      const script: DiffHunkRaw[] = [];
      let curX = midN;
      let curY = midM;

      for (let step = finalD; step > 0; step--) {
        const vPrev = trace[step];
        const k = curX - curY;
        const prevK = (k === -step || (k !== step && vPrev[offset + k - 1] < vPrev[offset + k + 1]))
          ? k + 1
          : k - 1;
        const prevX = vPrev[offset + prevK];
        const prevY = prevX - prevK;

        while (curX > prevX && curY > prevY && curX > 0 && curY > 0 && midA[curX - 1] === midB[curY - 1]) {
          script.push({
            type: 'unchanged',
            text: midA[curX - 1],
            oldLine: prefix + curX,
            newLine: prefix + curY,
          });
          curX--;
          curY--;
        }

        if (curX === prevX) {
          script.push({
            type: 'add',
            text: midB[curY - 1],
            newLine: prefix + curY,
          });
          curY--;
        } else if (curY === prevY) {
          script.push({
            type: 'delete',
            text: midA[curX - 1],
            oldLine: prefix + curX,
          });
          curX--;
        }
      }

      while (curX > 0 && curY > 0) {
        script.push({
          type: 'unchanged',
          text: midA[curX - 1],
          oldLine: prefix + curX,
          newLine: prefix + curY,
        });
        curX--;
        curY--;
      }

      midHunks = script.reverse();
    }
  }

  return [...prefixHunks, ...midHunks, ...suffixHunks];
}

// ---------------------------------------------------------------------------
// 3. Genuine Revert Detection with Context
// ---------------------------------------------------------------------------

/**
 * Checks whether line content is trivial/structural (blank, single bracket, etc.).
 * Trivial lines must NEVER be classified as reverted changes.
 */
function isTrivialLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^[{}[\]();,]+$/.test(trimmed)) return true;
  if (['export default', 'export default App;', 'import React from "react";', "import React from 'react';"].includes(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Checks whether a line represents a genuine historical revert.
 * A revert requires:
 * 1. The line is not trivial syntax/whitespace.
 * 2. The line was present in an ancestor version (v < curVer - 1).
 * 3. The line was modified or deleted in an intervening version.
 * 4. The line is now restored back to the ancestor state.
 */
export function checkGenuineRevert(
  addedText: string,
  history: FileHistory[] | undefined,
  currentVersion: number
): boolean {
  if (!history || history.length < 2) return false;
  if (isTrivialLine(addedText)) return false;

  const sorted = [...history].sort((a, b) => a.version - b.version);
  const curIdx = sorted.findIndex(h => h.version === currentVersion);
  const searchLimit = curIdx !== -1 ? curIdx : sorted.length;

  for (let a = 0; a < searchLimit - 1; a++) {
    const ancestor = sorted[a];
    const ancestorLines = ancestor.content.split('\n');
    if (ancestorLines.includes(addedText)) {
      // Check that at least one intervening version removed or changed this line
      let wasAbsentOrChanged = false;
      for (let inter = a + 1; inter < searchLimit; inter++) {
        const interLines = sorted[inter].content.split('\n');
        if (!interLines.includes(addedText)) {
          wasAbsentOrChanged = true;
          break;
        }
      }
      if (wasAbsentOrChanged) {
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// 4. Historical Blame Tracking
// ---------------------------------------------------------------------------

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
      action: 'created',
    }],
  }));

  // Step through each revision and propagate blame using fast Myers diff
  for (let step = 1; step < targetHistory.length; step++) {
    const rev = targetHistory[step];
    const prevLines = currentBlame.map(b => b.content);
    const nextLines = rev.content.split('\n');

    const hunks = computeMyersDiff(prevLines, nextLines);
    const newBlame: LineBlame[] = [];

    for (const hunk of hunks) {
      if (hunk.type === 'unchanged' && hunk.oldLine) {
        const prev = currentBlame[hunk.oldLine - 1];
        newBlame.push({
          lineNumber: hunk.newLine || newBlame.length + 1,
          content: hunk.text,
          version: prev?.version ?? rev.version,
          author: prev?.author || rev.authorModel || 'unknown_agent',
          taskId: prev?.taskId || rev.taskId,
          commitMessage: prev?.commitMessage || rev.commitMessage,
          timestamp: prev?.timestamp || rev.timestamp || Date.now(),
          isReverted: prev?.isReverted,
          revisionHistory: prev?.revisionHistory ? [...prev.revisionHistory] : [],
        });
      } else if (hunk.type === 'add' && hunk.newLine) {
        const isReverted = checkGenuineRevert(hunk.text, sortedHistory.slice(0, step + 1), rev.version);
        newBlame.push({
          lineNumber: hunk.newLine,
          content: hunk.text,
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
            action: isReverted ? 'reverted' : 'modified',
          }],
        });
      }
      // deletes are dropped from active line blame
    }

    currentBlame = newBlame;
    currentBlame.forEach((b, idx) => {
      b.lineNumber = idx + 1;
    });
  }

  return currentBlame;
}

// ---------------------------------------------------------------------------
// 5. Overlapping Edit Detection
// ---------------------------------------------------------------------------

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
          summary: `Lines ${blockStart}-${l - 1} jointly modified by ${Array.from(currentAuthors).join(', ')} across ${currentVersions.size} revisions`,
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
      summary: `Lines ${blockStart}-${totalLines} jointly modified by ${Array.from(currentAuthors).join(', ')}`,
    });
  }

  return overlappingEdits;
}

// ---------------------------------------------------------------------------
// 6. Agent Diff Computation (Unified & Split Views)
// ---------------------------------------------------------------------------

function hashLine(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Computes an interactive diff comparing two texts, attributing changes to agents.
 * Uses adaptive Myers diff, accurate formatting-only comparison, and genuine revert checks.
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

  const rawHunks = computeMyersDiff(oldLines, newLines);

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

  let idx = 0;
  let lineKey = 0;

  while (idx < rawHunks.length) {
    const current = rawHunks[idx];

    if (current.type === 'unchanged') {
      unchanged++;
      const blame = current.newLine ? blameLookup.get(current.newLine) : undefined;
      const rowId = `row-${lineKey++}-${hashLine(current.text)}`;

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
          lineNumber: current.oldLine || 0,
          content: current.text,
          type: 'unchanged',
          taskId: blame?.taskId || options?.taskId,
        },
        right: {
          lineNumber: current.newLine || 0,
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
      const delGroup: Array<Extract<DiffHunkRaw, { type: 'delete' }>> = [];
      const addGroup: Array<Extract<DiffHunkRaw, { type: 'add' }>> = [];

      while (idx < rawHunks.length && rawHunks[idx].type !== 'unchanged') {
        const item = rawHunks[idx];
        if (item.type === 'delete') delGroup.push(item);
        else if (item.type === 'add') addGroup.push(item);
        idx++;
      }

      const maxPair = Math.max(delGroup.length, addGroup.length);

      for (let p = 0; p < maxPair; p++) {
        const del = delGroup[p];
        const add = addGroup[p];
        const rowId = `mod-${lineKey++}-${del ? hashLine(del.text) : ''}-${add ? hashLine(add.text) : ''}`;

        if (del && add) {
          // Paired modification
          modifications++;
          const blame = add.newLine ? blameLookup.get(add.newLine) : undefined;
          const author = blame?.author || options?.defaultTargetAgent || 'swarm_agent';
          const isFmt = isFormattingOnlyChange(del.text, add.text);
          const isRev = checkGenuineRevert(add.text, options?.history, options?.newVersion ?? 999);
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
              lineNumber: del.oldLine || 0,
              content: del.text,
              type: 'modified',
              isFormattingOnly: isFmt,
              taskId: options?.taskId,
            },
            right: {
              lineNumber: add.newLine || 0,
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
              lineNumber: del.oldLine || 0,
              content: del.text,
              type: 'deleted',
              taskId: options?.taskId,
            },
            right: undefined,
          });
        } else if (add) {
          // Pure addition
          additions++;
          const blame = add.newLine ? blameLookup.get(add.newLine) : undefined;
          const author = blame?.author || options?.defaultTargetAgent || 'swarm_agent';
          const isRev = checkGenuineRevert(add.text, options?.history, options?.newVersion ?? 999);
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
              lineNumber: add.newLine || 0,
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

  const overlappingEdits = options?.history && options.history.length > 1
    ? detectOverlappingEdits(options.history)
    : [];

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
      formattingOnlyCount,
      isCompletelyFormattingOnly,
      agentStats,
    },
    overlappingEdits,
  };
}

// ---------------------------------------------------------------------------
// 7. File Revision Timeline
// ---------------------------------------------------------------------------

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
        isRecreated: fileMeta?.isRecreated,
      });
    } else {
      const diff = computeAgentDiff(prev.content, current.content, {
        oldVersion: prev.version,
        newVersion: current.version,
        defaultTargetAgent: current.authorModel,
        history: sorted.slice(0, idx + 1),
        taskId: current.taskId,
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
        isRecreated: fileMeta?.isRecreated,
      });
    }
  }

  return timeline;
}

// ---------------------------------------------------------------------------
// 8. Agent UI Metadata & Theming
// ---------------------------------------------------------------------------

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
