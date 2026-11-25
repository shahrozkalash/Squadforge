import { LocalLLMService } from '../localLLM.js';
import type { Diagnostic } from './buildRunner.js';

/**
 * Phase 22: AI-assisted coding, built on SquadForge's existing
 * systems rather than a new silo:
 * - Code review: deterministic static review (metrics + findings)
 *   that runs anywhere, no model required.
 * - Diagnostic explanation: a knowledge table for common compiler
 *   codes plus the Phase debugging system's philosophy — explain the
 *   error, point at the likely cause, suggest the fix.
 * - Generation: routed through the existing LocalLLMService when a
 *   local model is actually healthy; when none is available the
 *   result says so (`available: false`) instead of fabricating text.
 */

export interface ReviewFinding {
  severity: 'info' | 'warning';
  line: number;
  message: string;
}

export interface CodeReview {
  file: string;
  lines: number;
  findings: ReviewFinding[];
  metrics: { todoCount: number; maxLineLength: number; functionCount: number };
}

export function reviewCode(file: string, content: string): CodeReview {
  const lines = content.split('\n');
  const findings: ReviewFinding[] = [];
  let todoCount = 0;
  let maxLineLength = 0;
  let functionCount = 0;
  lines.forEach((line, i) => {
    maxLineLength = Math.max(maxLineLength, line.length);
    if (/TODO|FIXME|HACK/.test(line)) {
      todoCount++;
      findings.push({ severity: 'info', line: i + 1, message: `Unresolved marker: ${line.trim().slice(0, 80)}` });
    }
    if (line.length > 140) {
      findings.push({ severity: 'warning', line: i + 1, message: `Line is ${line.length} characters — hard to read and review` });
    }
    if (/\b(function\s+\w+|=>\s*\{|def\s+\w+|fun\s+\w+|void\s+\w+\s*\()/.test(line)) functionCount++;
    if (/console\.log\(|print\(/.test(line) && /debug/i.test(line)) {
      findings.push({ severity: 'info', line: i + 1, message: 'Debug print statement — remove before release' });
    }
  });
  if (lines.length > 500) {
    findings.push({ severity: 'warning', line: 1, message: `File is ${lines.length} lines — consider splitting it` });
  }
  return { file, lines: lines.length, findings, metrics: { todoCount, maxLineLength, functionCount } };
}

const EXPLANATIONS: Record<string, { cause: string; fix: string }> = {
  TS2304: { cause: 'A name is used that TypeScript cannot find — usually a missing import, a typo, or a missing type declaration.', fix: 'Check the spelling, import the symbol, or install its @types package.' },
  TS2345: { cause: 'An argument of the wrong type was passed to a function.', fix: 'Compare the parameter type in the signature with the value being passed; convert or widen the type.' },
  TS2307: { cause: 'A module import could not be resolved.', fix: 'Verify the path/package name and that the dependency is installed (npm install).' },
  TS1005: { cause: 'A syntax error — the parser expected a token that is missing.', fix: 'Look at the reported line and the one above it for an unclosed bracket, quote, or missing semicolon/comma.' },
  CS0246: { cause: 'A type or namespace name was not found — usually a missing using directive or assembly reference.', fix: 'Add the using directive or the NuGet/assembly reference for the type.' },
  CS1002: { cause: 'A semicolon is missing.', fix: 'End the statement at the reported position with a semicolon.' },
  CS0103: { cause: 'A name is used that does not exist in the current scope.', fix: 'Check spelling and scope, declare the variable, or qualify the name.' },
  CS0029: { cause: 'An implicit conversion between two types does not exist.', fix: 'Convert explicitly (cast/Parse/ToString) or change the variable type.' }
};

export function explainDiagnostic(diagnostic: Diagnostic): { diagnostic: Diagnostic; explanation: string; suggestedFix: string } {
  const known = EXPLANATIONS[diagnostic.code];
  if (known) {
    return { diagnostic, explanation: known.cause, suggestedFix: known.fix };
  }
  return {
    diagnostic,
    explanation: `Compiler ${diagnostic.code} at ${diagnostic.file}:${diagnostic.line} — ${diagnostic.message}`,
    suggestedFix: 'Read the message at the reported position; it names the construct the compiler rejected. Fix that construct first — later errors often cascade from the first.'
  };
}

export interface GenerationResult {
  available: boolean;
  text?: string;
  reason?: string;
}

export class AiAssistService {
  private readonly llm = LocalLLMService.getInstance();

  /** Generate code through the existing local model service — only when it is genuinely up. */
  public async generate(prompt: string): Promise<GenerationResult> {
    const health = await this.llm.checkHealth().catch(() => null);
    if (!health || !health.connected || !health.selectedModelAvailable) {
      return { available: false, reason: 'No local model is currently available (LocalLLMService health check: not connected / model not present); generation was not attempted and nothing was fabricated.' };
    }
    const result = await this.llm.callLocalModel({ prompt });
    if (!result.success || !result.rawText) {
      return { available: false, reason: 'The local model call did not succeed; no output was fabricated.' };
    }
    return { available: true, text: result.rawText };
  }

  public review(file: string, content: string): CodeReview {
    return reviewCode(file, content);
  }

  public explain(diagnostic: Diagnostic) {
    return explainDiagnostic(diagnostic);
  }
}
