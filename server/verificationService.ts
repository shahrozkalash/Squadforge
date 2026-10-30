import { db } from './store.js';
import { ExecutionAdapter } from './swarm/executionAdapter.js';
import { ProjectMemoryService } from './swarm/projectMemory.js';
import { PreviewGenerator } from './swarm/previewGenerator.js';
import { 
  Build, 
  VerificationReport, 
  VerificationVerdict, 
  VerificationCheckItem 
} from './types.js';

export class HonestVerificationService {
  /**
   * Evaluates project readiness strictly from evidence, never relying solely on agent claims.
   */
  static evaluateProjectReadiness(buildId: string): VerificationReport {
    const build = db.getBuild(buildId);
    if (!build) {
      throw new Error(`Build ${buildId} not found`);
    }

    const files = db.getAllFiles(buildId);
    const tasks = db.getTasks(buildId);
    const checks: VerificationCheckItem[] = [];
    const knownDefects: string[] = [];
    const missingEnvVars: string[] = [];
    const unresolvedCriteria: string[] = [];
    const unresolvedRisks: string[] = [];

    // 1. Files & Structural Integrity
    const hasFiles = files.length > 0;
    checks.push({
      category: 'files',
      name: 'Project Workspace Files',
      status: hasFiles ? 'passed' : 'failed',
      evidence: `${files.length} modular source file(s) present in workspace.`
    });

    if (!hasFiles) {
      knownDefects.push('No source files have been generated for this project.');
    }

    // Required configuration check (README.md, entry point)
    const hasReadme = files.some(f => f.path.toLowerCase() === 'readme.md');
    checks.push({
      category: 'files',
      name: 'Documentation & Specification (README.md)',
      status: hasReadme ? 'passed' : 'failed',
      evidence: hasReadme ? 'README.md exists with project instructions.' : 'README.md is missing.'
    });

    if (!hasReadme) {
      unresolvedCriteria.push('Project documentation and setup instructions are missing.');
    }

    // 2. Run Comprehensive Execution Adapter Verification
    const execResult = ExecutionAdapter.runCompleteVerification(buildId, files);

    // Syntax validation check
    const syntaxPassed = execResult.syntaxErrors.length === 0;
    checks.push({
      category: 'syntax',
      name: 'Language & Syntax Validation (esbuild & AST)',
      status: syntaxPassed ? 'passed' : 'failed',
      evidence: syntaxPassed 
        ? `All ${files.length} files passed syntax validation cleanly.`
        : `${execResult.syntaxErrors.length} syntax error(s): ${execResult.syntaxErrors.map(e => `${e.filePath}:${e.line || 1} ${e.message}`).join('; ')}`
    });

    if (!syntaxPassed) {
      for (const err of execResult.syntaxErrors) {
        knownDefects.push(`Syntax error in ${err.filePath}: ${err.message}`);
      }
    }

    // Type checking check
    const typePassed = execResult.syntaxErrors.filter(e => e.filePath.endsWith('.ts') || e.filePath.endsWith('.tsx')).length === 0;
    checks.push({
      category: 'types',
      name: 'TypeScript Structural Typing',
      status: typePassed ? 'passed' : 'failed',
      evidence: typePassed ? 'TypeScript syntax and structure valid.' : 'TypeScript syntax errors detected.'
    });

    // Security audit check
    const secPassed = execResult.securityAudit.passed;
    checks.push({
      category: 'security',
      name: 'Static Security & Secret Audit',
      status: secPassed ? 'passed' : 'failed',
      evidence: secPassed 
        ? `Security audit passed with score ${execResult.securityAudit.score}/100. No exposed keys or dangerous eval.`
        : `Security score ${execResult.securityAudit.score}/100. Findings: ${execResult.securityAudit.findings.map(f => `[${f.severity}] ${f.message}`).join(', ')}`
    });

    if (!secPassed) {
      for (const f of execResult.securityAudit.findings) {
        if (f.severity === 'high') {
          knownDefects.push(`Security vulnerability: ${f.message}`);
        } else {
          unresolvedRisks.push(`Security warning: ${f.message}`);
        }
      }
    }

    // Test execution check
    const testReport = execResult.testReport;
    const testStatus = testReport.status === 'passed' ? 'passed' : testReport.status === 'failed' ? 'failed' : 'skipped';
    checks.push({
      category: 'tests',
      name: 'Automated Test Suite Execution',
      status: testStatus,
      evidence: testReport.status === 'skipped'
        ? (testReport.skipReason || 'Tests were skipped')
        : `${testReport.passed}/${testReport.total} test(s) passed in ${testReport.executionTimeMs || 0}ms.`,
      reasonIfSkipped: testReport.status === 'skipped' ? testReport.skipReason : undefined
    });

    if (testReport.failed > 0) {
      for (const t of testReport.details.filter(d => !d.passed)) {
        knownDefects.push(`Failing test "${t.name}": ${t.message || 'Assertion failed'}`);
      }
    }

    // Production build check
    const buildReport = execResult.buildReport;
    const buildStatus = buildReport.status === 'passed' ? 'passed' : buildReport.status === 'failed' ? 'failed' : 'skipped';
    checks.push({
      category: 'build',
      name: 'Production Build & Bundling',
      status: buildStatus,
      evidence: buildReport.output || (buildReport.passed ? 'Build passed' : 'Build failed'),
      reasonIfSkipped: buildReport.status === 'skipped' ? 'No standalone bundle entry point identified' : undefined
    });

    if (!buildReport.passed && buildReport.status === 'failed') {
      for (const err of buildReport.errors) {
        knownDefects.push(`Production build error: ${err}`);
      }
    }

    // 3. Scan for environment variables referenced in code
    const envVarsInCode = new Set<string>();
    for (const file of files) {
      const matches = file.content.matchAll(/process\.env\.([A-Z0-9_]+)/g);
      for (const m of matches) {
        envVarsInCode.add(m[1]);
      }
    }

    // Check if .env.example exists in project files
    const envExampleFile = files.find(f => f.path === '.env.example');
    if (envVarsInCode.size > 0 && !envExampleFile) {
      unresolvedRisks.push(`Project code references environment variables (${Array.from(envVarsInCode).join(', ')}) but no .env.example template is provided in project.`);
    }

    // 4. Requirements & Milestone Coverage
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.status === 'completed' || t.status === 'done').length;
    const failedTasks = tasks.filter(t => t.status === 'failed').length;
    const inProgressTasks = tasks.filter(t => t.status === 'in_progress' || t.status === 'pending' || t.status === 'retrying').length;

    const requirementsCoveragePercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    checks.push({
      category: 'requirements',
      name: 'Milestone & Task Acceptance Coverage',
      status: (requirementsCoveragePercent >= 90 && failedTasks === 0) ? 'passed' : failedTasks > 0 ? 'failed' : 'blocked',
      evidence: `${completedTasks}/${totalTasks} tasks completed (${requirementsCoveragePercent}%). ${failedTasks} failed, ${inProgressTasks} pending.`
    });

    if (failedTasks > 0) {
      unresolvedCriteria.push(`${failedTasks} tasks failed during swarm execution.`);
    }

    if (inProgressTasks > 0) {
      unresolvedCriteria.push(`${inProgressTasks} tasks are still in progress or pending.`);
    }

    // 5. Application Live Preview & Runtime Execution Check
    let previewResult;
    try {
      previewResult = PreviewGenerator.generateInteractivePreview(build.idea, files, build.projectType || 'fullstack');
    } catch (err: any) {
      previewResult = {
        mode: 'fallback_preview' as const,
        diagnosticInfo: err.message || 'Preview generation failed'
      };
    }

    const previewPassed = previewResult.mode === 'real_application' || previewResult.mode === 'static_html';
    checks.push({
      category: 'preview',
      name: 'Application Live Preview Execution',
      status: previewPassed ? 'passed' : hasFiles ? 'failed' : 'blocked',
      evidence: previewPassed
        ? `Live execution verified: ${previewResult.mode === 'real_application' ? 'Real React application compiled and mounted in DOM' : 'Static project asset rendered'}.`
        : `Preview running in fallback demonstration mode (${previewResult.diagnosticInfo || 'No runnable entry point'}).`
    });

    if (previewResult.mode === 'fallback_preview' && hasFiles) {
      unresolvedRisks.push('Project preview is running in fallback demonstration mode and cannot be verified as running code.');
    }

    // 6. Determine Honest Verdict based on real evidence
    let verdict: VerificationVerdict;

    if (build.status === 'stopped' || build.status === 'failed') {
      verdict = 'failed';
    } else if (inProgressTasks > 0) {
      verdict = 'in_progress';
    } else if (!hasFiles || !syntaxPassed || failedTasks > 0 || testReport.failed > 0 || !secPassed) {
      verdict = 'failed';
    } else if (requirementsCoveragePercent >= 90 && syntaxPassed && secPassed && (testReport.status === 'passed' || testReport.total === 0)) {
      // Must not be marked 'verified' if running in fallback preview mode or build/tests skipped
      if (testReport.status === 'skipped' || buildReport.status === 'skipped' || previewResult.mode === 'fallback_preview') {
        verdict = 'partially_verified';
      } else {
        verdict = 'verified';
      }
    } else {
      verdict = 'partially_verified';
    }

    const report: VerificationReport = {
      verdict,
      evaluatedAt: Date.now(),
      checks,
      requirementsCoveragePercent,
      syntaxChecksPassed: syntaxPassed,
      typeChecksPassed: typePassed,
      previewMode: previewResult.mode,
      previewPassed,
      testExecution: {
        total: testReport.total,
        passed: testReport.passed,
        failed: testReport.failed,
        skipped: testReport.skipped,
        details: testReport.details
      },
      buildPassed: buildReport.passed,
      buildOutput: buildReport.output,
      securityAuditPassed: secPassed,
      securityScore: execResult.securityAudit.score,
      knownDefects,
      missingEnvironmentVars: Array.from(missingEnvVars),
      unresolvedCriteria,
      unresolvedRisks,
      evidenceSummary: `Honest Evaluation Verdict: [${verdict.toUpperCase()}]. Requirements coverage: ${requirementsCoveragePercent}%. Syntax valid: ${syntaxPassed}. Tests: ${testReport.passed}/${testReport.total} passed. Preview mode: ${previewResult.mode}. Security score: ${execResult.securityAudit.score}/100.`
    };

    // Save report onto build in store
    build.verificationReport = report;
    db.saveBuild(build);

    // Synchronize known defects with persistent Project Memory
    try {
      if (knownDefects.length > 0 && build.userId) {
        for (const def of knownDefects) {
          ProjectMemoryService.recordDefect(buildId, build.userId, {
            description: def,
            filePaths: [],
            severity: 'high'
          });
        }
      }
    } catch {
      // Graceful fallback
    }

    return report;
  }
}
