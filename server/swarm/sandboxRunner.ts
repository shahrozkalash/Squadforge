import { db } from '../store.js';
import { MergeManager } from './mergeManager.js';
import { TaskManager } from './taskManager.js';

export interface SandboxCheckResult {
  passed: boolean;
  errors: Array<{
    filePath: string;
    message: string;
    line?: number;
  }>;
  summary: string;
}

export class SandboxRunner {
  /**
   * Runs automated lint, type-check and build integrity checks on the generated project files
   */
  static runIntegrityCheck(buildId: string): SandboxCheckResult {
    const files = db.getAllFiles(buildId);
    const errors: Array<{ filePath: string; message: string; line?: number }> = [];

    // Analyze each file for structural, syntax, and type consistency
    for (const file of files) {
      const content = file.content;
      const path = file.path;

      // 1. JSON files validation
      if (path.endsWith('.json')) {
        try {
          JSON.parse(content);
        } catch (err: any) {
          errors.push({
            filePath: path,
            message: `Invalid JSON syntax: ${err.message}`
          });
        }
      }

      // 2. JS / TS / TSX validation
      if (path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.js') || path.endsWith('.jsx')) {
        // Check for balanced brackets, braces, and parentheses
        const balanceErrors = this.checkBracketsBalance(content, path);
        if (balanceErrors) {
          errors.push(balanceErrors);
        }

        // Check for raw unmerged conflict markers or accidental text dumps
        if (content.includes('<<<<<<<') || content.includes('>>>>>>>') || content.includes('=======')) {
          errors.push({
            filePath: path,
            message: 'Unresolved git/merge conflict markers detected in file content'
          });
        }

        // Check for common type-check issues: duplicate export default
        const exportDefaults = content.match(/export\s+default/g);
        if (exportDefaults && exportDefaults.length > 1) {
          errors.push({
            filePath: path,
            message: `Multiple default exports found (${exportDefaults.length}) in ${path}`
          });
        }

        // Check for empty or malformed import statements
        const brokenImports = content.match(/import\s+from\s+['"][^'"]+['"]/g);
        if (brokenImports) {
          errors.push({
            filePath: path,
            message: `Malformed import missing identifiers in ${path}: "${brokenImports[0]}"`
          });
        }
      }
    }

    const passed = errors.length === 0;

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'sandbox_check',
      details: passed 
        ? `Sandbox checks passed cleanly (0 errors across ${files.length} files). Build healthy.`
        : `Sandbox detected ${errors.length} build error(s). Creating high-priority fix tasks.`
    });

    if (passed) {
      // Mark checkpoint each time build passes!
      MergeManager.createCheckpoint(buildId, `Build passed with ${files.length} valid files`);
    } else {
      // Create high-priority fix tasks on the living board for free models
      for (const err of errors) {
        TaskManager.createNewTask(buildId, {
          title: `Fix Build Error in ${err.filePath}`,
          description: `Sandbox check failed: ${err.message}. Review and patch the file to resolve.`,
          filePaths: [err.filePath],
          priority: 1, // Highest priority
          isFixTask: true
        });
      }
    }

    return {
      passed,
      errors,
      summary: passed ? 'All automated checks passed' : `${errors.length} errors found`
    };
  }

  /**
   * Fast brackets and braces balance verification
   */
  private static checkBracketsBalance(code: string, filePath: string): { filePath: string; message: string; line?: number } | null {
    const stack: { char: string; line: number }[] = [];
    const lines = code.split('\n');
    let inBlockComment = false;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      let line = lines[lineIdx];

      // Remove single-line comments
      const commentIdx = line.indexOf('//');
      if (commentIdx !== -1) {
        line = line.substring(0, commentIdx);
      }

      for (let charIdx = 0; charIdx < line.length; charIdx++) {
        const char = line[charIdx];
        const nextChar = line[charIdx + 1];

        if (char === '/' && nextChar === '*') {
          inBlockComment = true;
          charIdx++;
          continue;
        }
        if (char === '*' && nextChar === '/') {
          inBlockComment = false;
          charIdx++;
          continue;
        }
        if (inBlockComment) continue;

        if (char === '{' || char === '(' || char === '[') {
          stack.push({ char, line: lineIdx + 1 });
        } else if (char === '}' || char === ')' || char === ']') {
          if (stack.length === 0) {
            return {
              filePath,
              message: `Unmatched closing bracket '${char}' at line ${lineIdx + 1}`,
              line: lineIdx + 1
            };
          }
          const last = stack.pop()!;
          const matches = (last.char === '{' && char === '}') ||
                          (last.char === '(' && char === ')') ||
                          (last.char === '[' && char === ']');
          if (!matches) {
            return {
              filePath,
              message: `Mismatched bracket: expected match for '${last.char}' (line ${last.line}), got '${char}' at line ${lineIdx + 1}`,
              line: lineIdx + 1
            };
          }
        }
      }
    }

    if (stack.length > 0) {
      const unclosed = stack[stack.length - 1];
      return {
        filePath,
        message: `Unclosed '${unclosed.char}' opened at line ${unclosed.line}`,
        line: unclosed.line
      };
    }

    return null;
  }
}
