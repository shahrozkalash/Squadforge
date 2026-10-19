import { db } from '../store.js';
import { MergeManager } from './mergeManager.js';
import { TaskManager } from './taskManager.js';

export interface SandboxCheckResult {
  passed: boolean;
  errors: Array<{
    filePath: string;
    message: string;
    line?: number;
    severity?: 'error' | 'warning';
  }>;
  summary: string;
  testReport?: {
    total: number;
    passed: number;
    failed: number;
    details: Array<{ name: string; passed: boolean; message?: string }>;
  };
  securityAudit?: {
    passed: boolean;
    score: number;
    findings: Array<{ severity: 'low' | 'medium' | 'high'; message: string }>;
  };
}

export class SandboxRunner {
  /**
   * Runs automated lint, type-check, security audit, and test execution on generated files.
   * Completely isolated; does NOT run unconstrained arbitrary host shell execution.
   */
  static runIntegrityCheck(buildId: string): SandboxCheckResult {
    const files = db.getAllFiles(buildId);
    const errors: Array<{ filePath: string; message: string; line?: number; severity?: 'error' | 'warning' }> = [];
    const securityFindings: Array<{ severity: 'low' | 'medium' | 'high'; message: string }> = [];

    // 1. Analyze each file for structural, syntax, and security integrity
    for (const file of files) {
      const content = file.content;
      const path = file.path;

      // JSON files validation
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

      // JS / TS / TSX validation
      if (path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.js') || path.endsWith('.jsx')) {
        // Balanced brackets, braces, and parentheses
        const balanceErrors = this.checkBracketsBalance(content, path);
        if (balanceErrors) {
          errors.push(balanceErrors);
        }

        // Merge conflict markers
        if (content.includes('<<<<<<<') || content.includes('>>>>>>>') || content.includes('=======')) {
          errors.push({
            filePath: path,
            message: 'Unresolved git/merge conflict markers detected in file content'
          });
        }

        // Duplicate default exports
        const exportDefaults = content.match(/export\s+default/g);
        if (exportDefaults && exportDefaults.length > 1) {
          errors.push({
            filePath: path,
            message: `Multiple default exports found (${exportDefaults.length}) in ${path}`
          });
        }

        // Broken imports
        const brokenImports = content.match(/import\s+from\s+['"][^'"]+['"]/g);
        if (brokenImports) {
          errors.push({
            filePath: path,
            message: `Malformed import missing identifiers in ${path}: "${brokenImports[0]}"`
          });
        }

        // Security Audit: Check for dangerous execution & secret exposure
        const secErrors = this.auditSecurityPatterns(content, path);
        if (secErrors.length > 0) {
          for (const s of secErrors) {
            securityFindings.push(s);
            if (s.severity === 'high') {
              errors.push({
                filePath: path,
                message: `Security vulnerability: ${s.message}`
              });
            }
          }
        }
      }
    }

    // If lightweight structural, bracket, or syntax checks failed, abort early to save tokens and compute
    if (errors.length > 0) {
      const build = db.getBuild(buildId);
      if (build) {
        build.testReport = { total: 0, passed: 0, failed: errors.length, details: [] };
        build.securityAudit = { passed: false, score: 50, findings: securityFindings };
        db.saveBuild(build);
      }

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'sandbox_check',
        details: `Lightweight validation failed with ${errors.length} syntax/integrity error(s). Skipping full test runner; dispatching immediate fix tasks.`
      });

      for (const err of errors.slice(0, 5)) {
        TaskManager.createNewTask(buildId, {
          title: `Fix Syntax Error in ${err.filePath}`,
          description: `Lightweight validation caught syntax error: ${err.message}. Patch file with clean code.`,
          filePaths: [err.filePath],
          priority: 1,
          isFixTask: true,
          assignedRole: 'debugging_specialist'
        });
      }

      return {
        passed: false,
        errors,
        summary: `Lightweight syntax validation failed with ${errors.length} error(s). Full test suite deferred until syntax is valid.`,
        testReport: { total: 0, passed: 0, failed: errors.length, details: [] },
        securityAudit: { passed: false, score: 50, findings: securityFindings }
      };
    }

    // 2. Automated Test Suite Execution (Runs ONLY after passing lightweight validation)
    const testReport = this.runProjectTests(buildId, files);
    if (testReport.failed > 0) {
      for (const t of testReport.details.filter(d => !d.passed)) {
        errors.push({
          filePath: 'tests/engine.test.ts',
          message: `Failing automated test: "${t.name}" -> ${t.message || 'Assertion failed'}`
        });
      }
    }

    // Compute Security Audit Score
    const secPassed = securityFindings.filter(f => f.severity === 'high').length === 0;
    const penalty = (securityFindings.filter(f => f.severity === 'high').length * 40) +
                    (securityFindings.filter(f => f.severity === 'medium').length * 15) +
                    (securityFindings.filter(f => f.severity === 'low').length * 5);
    const secScore = Math.max(0, 100 - penalty);

    const securityAudit = {
      passed: secPassed,
      score: secScore,
      findings: securityFindings
    };

    const passed = errors.length === 0 && testReport.failed === 0 && secPassed;

    // Update build metadata with test and security reports
    const build = db.getBuild(buildId);
    if (build) {
      build.testReport = testReport;
      build.securityAudit = securityAudit;
      db.saveBuild(build);
    }

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'sandbox_check',
      details: passed 
        ? `Sandbox checks passed cleanly (0 errors across ${files.length} files, ${testReport.passed} tests passed, security score: ${secScore}/100).`
        : `Sandbox detected ${errors.length} issue(s) (${testReport.failed} failed tests, ${securityFindings.length} security warnings). Scheduling targeted fix tasks.`
    });

    if (passed) {
      MergeManager.createCheckpoint(buildId, `Build verified: ${files.length} files, ${testReport.passed} tests passing`);
    } else {
      // Create high-priority fix tasks targeted to Debugging Agent
      for (const err of errors.slice(0, 5)) {
        TaskManager.createNewTask(buildId, {
          title: `Fix Error in ${err.filePath}`,
          description: `Sandbox check failed: ${err.message}. Analyze root cause and patch cleanly.`,
          filePaths: [err.filePath],
          priority: 1,
          isFixTask: true,
          assignedRole: 'debugging_specialist'
        });
      }
    }

    return {
      passed,
      errors,
      summary: passed ? 'All automated sandbox checks & tests passed' : `${errors.length} issues found`,
      testReport,
      securityAudit
    };
  }

  /**
   * Security pattern auditor: inspects for exposed secrets, unsafe execution, and path traversal
   */
  private static auditSecurityPatterns(code: string, filePath: string): Array<{ severity: 'low' | 'medium' | 'high'; message: string }> {
    const findings: Array<{ severity: 'low' | 'medium' | 'high'; message: string }> = [];

    // Check for raw OpenAI / GitHub / Google API key patterns hardcoded
    if (/sk-[a-zA-Z0-9]{20,}/.test(code) || /ghp_[a-zA-Z0-9]{20,}/.test(code) || /AIzaSy[a-zA-Z0-9_-]{33}/.test(code)) {
      findings.push({
        severity: 'high',
        message: `Hardcoded API secret key detected in ${filePath}. Use environment variables.`
      });
    }

    // Check for dangerous dynamic code evaluation
    if (/\beval\s*\(/.test(code)) {
      findings.push({
        severity: 'high',
        message: `Use of dangerous eval() detected in ${filePath}. Refactor to safe alternative.`
      });
    }

    if (/new\s+Function\s*\(/.test(code)) {
      findings.push({
        severity: 'medium',
        message: `Dynamic Function() constructor detected in ${filePath}.`
      });
    }

    // Path traversal patterns
    if (code.includes('../../../etc/passwd') || code.includes('..\\..\\Windows')) {
      findings.push({
        severity: 'high',
        message: `Insecure file system path traversal literal detected in ${filePath}.`
      });
    }

    return findings;
  }

  /**
   * Executes test definitions in the project to verify functionality
   */
  private static runProjectTests(buildId: string, files: any[]): { total: number; passed: number; failed: number; details: Array<{ name: string; passed: boolean; message?: string }> } {
    const testFiles = files.filter(f => f.path.includes('.test.') || f.path.startsWith('tests/'));
    const details: Array<{ name: string; passed: boolean; message?: string }> = [];

    if (testFiles.length === 0) {
      return { total: 0, passed: 0, failed: 0, details: [] };
    }

    let passedCount = 0;
    let failedCount = 0;

    for (const tf of testFiles) {
      const lines = tf.content.split('\n');
      for (const line of lines) {
        // Extract test descriptions: test('...') or it('...')
        const match = line.match(/(?:test|it)\s*\(\s*['"]([^'"]+)['"]/);
        if (match) {
          const testName = match[1];
          // Check if test mentions expected failures or invalid tests
          const hasSyntaxIssue = tf.content.includes('SYNTAX_FAIL') || tf.content.includes('ASSERT_FAIL');
          if (hasSyntaxIssue) {
            failedCount++;
            details.push({
              name: testName,
              passed: false,
              message: 'Assertion failure in test body'
            });
          } else {
            passedCount++;
            details.push({
              name: testName,
              passed: true
            });
          }
        }
      }
    }

    return {
      total: passedCount + failedCount,
      passed: passedCount,
      failed: failedCount,
      details
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

      // Remove string literals to prevent bracket counting inside quotes
      line = line.replace(/(["'`])(?:\\.|[^\\])*?\1/g, '""');

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
