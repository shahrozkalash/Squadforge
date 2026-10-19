import crypto from 'crypto';
import { ProjectFile, Task, SwarmEvent, TokenEstimationResult } from './types.js';

export class TokenOptimizer {
  private static instance: TokenOptimizer;
  // Cache of file summaries to avoid re-generating summaries for unchanged files
  private fileSummaryCache: Map<string, { hash: string; summary: string }> = new Map();

  private constructor() {}

  static getInstance(): TokenOptimizer {
    if (!TokenOptimizer.instance) {
      TokenOptimizer.instance = new TokenOptimizer();
    }
    return TokenOptimizer.instance;
  }

  /**
   * Fast, reliable token estimation calibrated for mixed code, JSON, and prose.
   * Standard LLM tokenizers (BPE/SentencePiece) average ~3.6-3.8 characters per token on code/JSON.
   */
  estimateTokens(text: string): number {
    if (!text || typeof text !== 'string') return 0;
    const len = text.length;
    if (len === 0) return 0;

    // Fast approximation based on character density and symbol frequency in source code
    const words = text.split(/\s+/).length;
    const symbols = (text.match(/[{}[\]()<>=;:.,!&|+\-*/\\]/g) || []).length;
    
    // Balanced token weight: ~3.7 chars base + symbol adjustment
    const est = Math.ceil((len / 3.7) + (symbols * 0.12) + (words * 0.05));
    return Math.max(1, est);
  }

  /**
   * Checks whether the combined prompt and expected output tokens fit comfortably in the model's context window.
   */
  checkContextWindow(prompt: string, maxOutputTokens: number, contextWindow: number): TokenEstimationResult {
    const inputEst = this.estimateTokens(prompt);
    const totalEst = inputEst + maxOutputTokens;
    const fits = totalEst <= contextWindow;

    return {
      estimatedInputTokens: inputEst,
      estimatedOutputTokens: maxOutputTokens,
      totalEstimatedTokens: totalEst,
      contextWindow,
      fitsWithinContext: fits,
      reason: fits ? undefined : `Estimated total tokens (${totalEst}) exceeds model context window (${contextWindow})`
    };
  }

  /**
   * Generates a deterministic SHA-256 hash of a file's content
   */
  hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  /**
   * Generates a concise structural summary of a source file (exported types, functions, classes, routes)
   * without sending the full implementation body, saving thousands of tokens.
   */
  summarizeFile(file: ProjectFile): string {
    const contentHash = this.hashContent(file.content);
    const cached = this.fileSummaryCache.get(file.path);
    if (cached && cached.hash === contentHash) {
      return cached.summary;
    }

    const lines = file.content.split('\n');
    const outline: string[] = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      // Extract imports and exported signatures
      if (
        trimmed.startsWith('export ') ||
        trimmed.startsWith('interface ') ||
        trimmed.startsWith('type ') ||
        trimmed.startsWith('class ') ||
        trimmed.startsWith('function ') ||
        trimmed.startsWith('const ') && (trimmed.includes('=>') || trimmed.includes(':'))
      ) {
        // Strip deep inline bodies
        const signature = trimmed.split('{')[0].trim();
        outline.push(`  ${signature}`);
      }
    }

    const summaryText = outline.length > 0
      ? `// FILE OUTLINE: ${file.path} (${lines.length} lines, v${file.version})\n${outline.slice(0, 25).join('\n')}`
      : `// FILE: ${file.path} (${lines.length} lines, v${file.version})`;

    this.fileSummaryCache.set(file.path, { hash: contentHash, summary: summaryText });
    return summaryText;
  }

  /**
   * Dynamic Context Selection: Selects ONLY files directly or indirectly relevant to the task,
   * sending full contents for direct targets and concise outlines for referenced dependencies.
   */
  selectRelevantFilesContext(
    targetFilePaths: string[], 
    allFiles: ProjectFile[], 
    maxTokenBudget: number = 2500
  ): string {
    if (allFiles.length === 0) {
      return 'No existing project files yet. You must use "create_file".';
    }

    const normalizedTargets = new Set(targetFilePaths.map(p => p.toLowerCase().trim()));
    const directFiles: ProjectFile[] = [];
    const peripheralFiles: ProjectFile[] = [];

    for (const f of allFiles) {
      if (normalizedTargets.has(f.path.toLowerCase().trim())) {
        directFiles.push(f);
      } else {
        peripheralFiles.push(f);
      }
    }

    const contextBlocks: string[] = [];
    let accumulatedTokens = 0;

    // 1. Full content for directly targeted files
    for (const f of directFiles) {
      const block = `--- FILE (TARGET): ${f.path} (v${f.version}) ---\n${f.content}`;
      const blockTokens = this.estimateTokens(block);
      
      // If a single file is massive, provide the top 120 lines and outline
      if (blockTokens > 1800) {
        const truncatedLines = f.content.split('\n').slice(0, 120).join('\n');
        const truncatedBlock = `--- FILE (TARGET - TRUNCATED): ${f.path} (v${f.version}) ---\n${truncatedLines}\n// ... [remaining ${f.content.split('\n').length - 120} lines omitted for context efficiency]`;
        contextBlocks.push(truncatedBlock);
        accumulatedTokens += this.estimateTokens(truncatedBlock);
      } else {
        contextBlocks.push(block);
        accumulatedTokens += blockTokens;
      }
    }

    // 2. Concise structural outlines for peripheral dependencies (within remaining budget)
    for (const f of peripheralFiles) {
      if (accumulatedTokens >= maxTokenBudget) break;

      // Check if direct files or task targets reference this file's name
      const fileName = f.path.split('/').pop() || f.path;
      const isReferenced = directFiles.some(df => df.content.includes(fileName));

      if (isReferenced || peripheralFiles.length <= 4) {
        const summary = this.summarizeFile(f);
        const summaryTokens = this.estimateTokens(summary);
        if (accumulatedTokens + summaryTokens <= maxTokenBudget) {
          contextBlocks.push(summary);
          accumulatedTokens += summaryTokens;
        }
      }
    }

    return contextBlocks.length > 0 
      ? contextBlocks.join('\n\n')
      : 'Target file does not exist yet. You must use "create_file".';
  }

  /**
   * Compresses event history into a compact high-level summary rather than dumping dozens of raw events
   */
  summarizeSwarmHistory(events: SwarmEvent[], maxEventsToScan: number = 20): string {
    if (!events || events.length === 0) {
      return 'No prior swarm events.';
    }

    const recent = events.slice(-maxEventsToScan);
    const milestones: string[] = [];
    const completedTasks: string[] = [];
    const recentPatches: string[] = [];
    const activeErrors: string[] = [];

    for (const e of recent) {
      if (e.type === 'milestone_reached') {
        milestones.push(e.details);
      } else if (e.type === 'task_completed' && e.details) {
        completedTasks.push(e.details);
      } else if (e.type === 'patch_applied' && e.filePath) {
        recentPatches.push(e.filePath);
      } else if (e.type === 'task_failed' || e.type === 'patch_rejected') {
        activeErrors.push(e.details);
      }
    }

    const lines: string[] = [];
    if (milestones.length > 0) lines.push(`Milestones Reached: ${milestones.slice(-2).join('; ')}`);
    if (completedTasks.length > 0) lines.push(`Recent Tasks Completed: ${completedTasks.slice(-3).join('; ')}`);
    if (recentPatches.length > 0) lines.push(`Recently Modified Files: ${Array.from(new Set(recentPatches)).join(', ')}`);
    if (activeErrors.length > 0) lines.push(`Current Issues to Resolve: ${activeErrors.slice(-2).join('; ')}`);

    return lines.length > 0 ? lines.join('\n') : 'Active development in progress.';
  }

  /**
   * Deduplicates instructions and trims redundant whitespace and repeated patterns
   */
  deduplicatePrompt(systemInstruction: string, prompt: string): { systemInstruction: string; prompt: string } {
    let cleanSys = systemInstruction.trim();
    let cleanPrompt = prompt.trim();

    // If prompt contains identical paragraphs that already appear in systemInstruction, remove them from prompt
    const sysLines = new Set(cleanSys.split('\n').map(l => l.trim()).filter(l => l.length > 30));
    const promptLines = cleanPrompt.split('\n');
    const filteredPromptLines = promptLines.filter(l => !sysLines.has(l.trim()));

    // Collapse multi-blank lines into single blank line
    cleanPrompt = filteredPromptLines.join('\n').replace(/\n{3,}/g, '\n\n');

    return {
      systemInstruction: cleanSys,
      prompt: cleanPrompt
    };
  }

  /**
   * Enforces critical constraint preservation: ensures core instructions, interfaces,
   * security requirements, and format rules are NEVER omitted during prompt compaction.
   */
  preserveCriticalRequirements(prompt: string, criticalRequirements: string[]): string {
    let result = prompt;
    for (const req of criticalRequirements) {
      if (!result.includes(req)) {
        result += `\n\nCRITICAL MANDATORY REQUIREMENT:\n${req}`;
      }
    }
    return result;
  }
}

export const tokenOptimizer = TokenOptimizer.getInstance();
