import { db } from '../store.js';
import { MergeManager } from './mergeManager.js';
import { TaskManager } from './taskManager.js';
import { ExecutionAdapter } from './executionAdapter.js';
import { HonestVerificationService } from '../verificationService.js';

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
   * Runs automated lint, type-check, and security audit on generated files.
   * Generated tests do not run here. Their results come from the Docker execution sandbox.
   */
  static runIntegrityCheck(buildId: string): SandboxCheckResult {
    const files = db.getAllFiles(buildId);

    // Run complete execution adapter verification
    const execResult = ExecutionAdapter.runCompleteVerification(buildId, files);

    const errors: Array<{ filePath: string; message: string; line?: number; severity?: 'error' | 'warning' }> = [];

    // Add syntax errors
    for (const synErr of execResult.syntaxErrors) {
      errors.push({
        filePath: synErr.filePath,
        message: synErr.message,
        line: synErr.line,
        severity: synErr.severity
      });
    }

    // Add high severity security findings as errors
    for (const secFinding of execResult.securityAudit.findings) {
      if (secFinding.severity === 'high') {
        errors.push({
          filePath: secFinding.filePath,
          message: `Security vulnerability: ${secFinding.message}`,
          line: secFinding.line,
          severity: 'error'
        });
      }
    }

    // Add failing test assertions as errors
    if (execResult.testReport.failed > 0) {
      for (const t of execResult.testReport.details.filter(d => !d.passed && d.status !== 'skipped')) {
        errors.push({
          filePath: 'tests/engine.test.ts',
          message: `Failing automated test: "${t.name}" -> ${t.message || 'Assertion failed'}`,
          severity: 'error'
        });
      }
    }

    const testReport = {
      total: execResult.testReport.total,
      passed: execResult.testReport.passed,
      failed: execResult.testReport.failed,
      details: execResult.testReport.details.map(d => ({
        name: d.name,
        passed: d.passed,
        message: d.message
      }))
    };

    const securityAudit = {
      passed: execResult.securityAudit.passed,
      score: execResult.securityAudit.score,
      findings: execResult.securityAudit.findings
    };

    const passed = errors.length === 0 && execResult.securityAudit.passed && execResult.testReport.failed === 0;

    // Update build metadata
    const build = db.getBuild(buildId);
    if (build) {
      build.testReport = testReport;
      build.securityAudit = securityAudit;
      db.saveBuild(build);
    }

    // Emit event
    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'sandbox_check',
      details: passed
        ? `Sandbox execution passed cleanly (0 errors across ${files.length} files, ${testReport.passed} tests passed, security score: ${securityAudit.score}/100).`
        : `Sandbox detected ${errors.length} issue(s) (${testReport.failed} failed tests, ${securityAudit.findings.length} security warnings). Scheduling targeted fix tasks.`
    });

    if (passed) {
      MergeManager.createCheckpoint(buildId, `Build verified: ${files.length} files, ${testReport.passed} tests passing`);
      // Update honest completion evaluation
      try {
        HonestVerificationService.evaluateProjectReadiness(buildId);
      } catch (err) {
        // Ignored
      }
    } else {
      // Create targeted, high-priority surgical fix tasks for Debugging Specialist
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
}
