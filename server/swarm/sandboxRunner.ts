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
   * The test file a failing-test error is attributed to: the legacy
   * 'tests/engine.test.ts' when the tree actually contains it, otherwise
   * the first test file present (the adapter runs every test file in the
   * tree, using the same predicate as ExecutionAdapter.runIsolatedTests).
   */
  private static failingTestFilePath(files: Array<{ path: string }>): string {
    const testFiles = files
      .map(f => f.path)
      .filter(p => p.includes('.test.') || p.includes('.spec.') || p.startsWith('tests/'));
    if (testFiles.includes('tests/engine.test.ts')) return 'tests/engine.test.ts';
    return testFiles[0] || 'tests/engine.test.ts';
  }

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

    // Add TypeScript compiler errors. The type check is part of this
    // gate (see the class documentation above), but its report was never
    // consumed here: when type errors exist the adapter defers the test
    // run (failed === 0), so a project with compiler-broken code passed
    // this check and could be marked complete while the platform's own
    // HonestVerificationService reported the same tree as failed
    // (Factory Phase F4 probe: TS2322 in a generated file, build
    // completed). Type errors now fail the sandbox like syntax errors,
    // and the fix task targets the file carrying the diagnostic.
    for (const typeErr of execResult.typeCheckReport.errors) {
      // TS18003 ("No inputs were found in config file") is not a defect
      // in any file: it states the program is empty, which is the normal
      // mid-build stage before the first TypeScript file lands (and, on
      // a finished tree, means there is nothing to type-check — the
      // honest verdict treats a no-TypeScript project the same way, as
      // skipped rather than failed). A fix task cannot repair it, so it
      // does not gate; every real diagnostic (TS2322, TS2307, ...) does.
      if (typeErr.code === 'TS18003') continue;
      errors.push({
        filePath: typeErr.filePath,
        message: `TypeScript error [${typeErr.code}]: ${typeErr.message}`,
        line: typeErr.line,
        severity: 'error'
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

    // Add failing test assertions as errors. The adapter's report names
    // tests, not the files they live in, so failures are attributed to
    // the test file(s) actually present in the tree. This previously
    // hardcoded 'tests/engine.test.ts': in projects whose tests live at
    // any other path, every repair task targeted a file that does not
    // exist, the real failing test was never repaired, and the build
    // hung instead of completing or failing (Factory Phase F4 probe).
    if (execResult.testReport.failed > 0) {
      const failingFilePath = this.failingTestFilePath(files);
      for (const t of execResult.testReport.details.filter(d => !d.passed && d.status !== 'skipped')) {
        errors.push({
          filePath: failingFilePath,
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
      // Create targeted, high-priority surgical fix tasks for Debugging Specialist.
      // Identical errors (same file, same message — e.g. a crashed test
      // file the runner reports once in its output and once in its
      // recap) get one task, not duplicates racing to patch the same file.
      const spawnedKeys = new Set<string>();
      let spawned = 0;
      for (const err of errors) {
        if (spawned >= 5) break;
        const key = `${err.filePath}::${err.message}`;
        if (spawnedKeys.has(key)) continue;
        spawnedKeys.add(key);
        spawned++;
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
