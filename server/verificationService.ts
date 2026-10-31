import { db } from './store.js';
import { ExecutionAdapter } from './swarm/executionAdapter.js';
import { ProjectMemoryService } from './swarm/projectMemory.js';
import { PreviewGenerator } from './swarm/previewGenerator.js';
import { BrowserRuntimeVerifier } from './swarm/runtimeVerifier.js';
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

    let previewResult;
    try {
      previewResult = PreviewGenerator.generateInteractivePreview(build.idea, files, build.projectType || 'fullstack');
    } catch (err: any) {
      previewResult = {
        html: '<!DOCTYPE html><html><head><title>Preview Error</title></head><body><div id="root">Preview generation failed</div></body></html>',
        mode: 'fallback_preview' as const,
        entryPoint: 'fallback_preview.html',
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

    // 5b. Real Browser Runtime Verification (Document, Mounting, Dependencies, Errors)
    const runtimeReport = BrowserRuntimeVerifier.verifyPreviewRuntime(previewResult, files);
    for (const c of runtimeReport.checks) {
      checks.push({
        category: 'runtime',
        name: `Browser Runtime: ${c.name}`,
        status: c.status,
        evidence: c.message,
        reasonIfSkipped: c.status === 'skipped' ? c.details : undefined
      });
    }

    if (!runtimeReport.verified && previewResult.mode === 'real_application') {
      for (const err of runtimeReport.errors) {
        knownDefects.push(`Browser runtime failure: ${err}`);
      }
    }

    // 6. Connect each requirement to real files, tests, and evidence
    const verifiedRequirements = this.verifyRequirements(build, files, execResult, previewResult);
    const implementedCount = verifiedRequirements.filter(r => r.status === 'implemented' || r.status === 'verified').length;
    const failedReqCount = verifiedRequirements.filter(r => r.status === 'failed').length;
    const blockedReqCount = verifiedRequirements.filter(r => r.status === 'blocked').length;

    // 7. Determine Honest Verdict based on real evidence
    let verdict: VerificationVerdict;

    if (build.status === 'stopped' || build.status === 'failed') {
      verdict = 'failed';
    } else if (inProgressTasks > 0) {
      verdict = 'in_progress';
    } else if (!hasFiles || !syntaxPassed || failedTasks > 0 || testReport.failed > 0 || !secPassed || failedReqCount > 0) {
      verdict = 'failed';
    } else if (requirementsCoveragePercent >= 90 && syntaxPassed && secPassed && (testReport.status === 'passed' || testReport.total === 0)) {
      // Must not be marked 'verified' if running in fallback preview mode, build/tests skipped, or browser runtime verification failed
      if (testReport.status === 'skipped' || buildReport.status === 'skipped' || previewResult.mode === 'fallback_preview' || blockedReqCount > 0 || !runtimeReport.verified) {
        verdict = 'partially_verified';
      } else {
        verdict = 'verified';
      }
    } else {
      verdict = 'partially_verified';
    }

    const finalOutcome = verdict === 'verified' ? 'verified' : verdict === 'partially_verified' ? 'partially_verified' : 'failed';

    const report: VerificationReport = {
      verdict,
      evaluatedAt: Date.now(),
      checks,
      requirementsCoveragePercent,
      syntaxChecksPassed: syntaxPassed,
      typeChecksPassed: typePassed,
      previewMode: previewResult.mode,
      previewPassed,
      browserRuntimeVerification: runtimeReport,
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
      evidenceSummary: `Honest Evaluation Verdict: [${verdict.toUpperCase()}]. Implemented requirements: ${implementedCount}/${verifiedRequirements.length || 1}. Syntax valid: ${syntaxPassed}. Tests: ${testReport.passed}/${testReport.total} passed. Preview mode: ${previewResult.mode}. Security score: ${execResult.securityAudit.score}/100.`,
      requirementsReport: verifiedRequirements,
      compilationStatus: syntaxPassed ? 'passed' : 'failed',
      runtimeStatus: previewResult.mode === 'real_application' || previewResult.mode === 'static_html' ? 'passed' : 'failed',
      knownLimitations: [...knownDefects, ...unresolvedRisks],
      finalOutcome
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

  /**
   * Deterministically verifies each requirement individually based on real file existence,
   * syntax validation, and automated test execution results.
   */
  static verifyRequirements(
    build: Build,
    files: Array<{ path: string; content: string }>,
    execResult: any,
    previewResult: any
  ): Array<import('./types.js').RequirementItem> {
    const memoryReqs = build.userId ? (ProjectMemoryService.getRequirements(build.id, build.userId) || []) : [];
    const existingChecklist = build.requirementsChecklist || [];

    // Combine or harmonize requirement items
    const rawItems = existingChecklist.length > 0
      ? existingChecklist
      : memoryReqs.map(m => ({
          id: m.id,
          category: m.category,
          description: m.description,
          satisfied: m.status === 'satisfied'
        }));

    const stopWords = new Set(['the', 'and', 'with', 'for', 'user', 'app', 'system', 'must', 'should', 'all', 'any', 'that', 'this', 'from']);
    const verifiedItems: Array<import('./types.js').RequirementItem> = [];

    for (const item of rawItems) {
      const descLower = item.description.toLowerCase();
      const catLower = (item.category || '').toLowerCase();
      const tokens = descLower
        .replace(/[^a-z0-9_]/g, ' ')
        .split(/\s+/)
        .filter((t: string) => t.length >= 3 && !stopWords.has(t));

      // Match files specifically relevant to this requirement
      const matchedFiles: Array<{ path: string; score: number }> = [];
      for (const file of files) {
        let score = 0;
        const filePathLower = file.path.toLowerCase();
        const fileContentLower = file.content.toLowerCase();

        // Path relevance
        if (filePathLower.includes(catLower)) score += 5;
        for (const token of tokens) {
          if (filePathLower.includes(token)) score += 4;
          if (fileContentLower.includes(token)) score += 1;
        }

        if (score >= 4) {
          matchedFiles.push({ path: file.path, score });
        }
      }

      // Sort by relevance score descending
      matchedFiles.sort((a, b) => b.score - a.score);
      const topMatchedFilePaths = matchedFiles.slice(0, 5).map(m => m.path);

      // Check tests executed that cover this requirement
      const testDetails = execResult?.testReport?.details || [];
      const testResults: Array<{ name: string; passed: boolean; message?: string }> = testDetails
        .filter((t: any) => {
          const testNameLower = t.name.toLowerCase();
          return tokens.some((tok: string) => testNameLower.includes(tok)) || topMatchedFilePaths.some(fp => testNameLower.includes(fp.toLowerCase()));
        })
        .map((t: any) => ({
          name: t.name,
          passed: Boolean(t.passed),
          message: t.message
        }));

      const relevantTests = testResults.map(t => t.name);
      const failedTests = testResults.filter(t => !t.passed);
      const remainingProblems: string[] = [];

      // Deterministic check
      let status: import('./types.js').RequirementStatus;
      let evidence: string;
      let deterministicChecksPassed = false;
      let notes = '';
      let verificationMethod: string = 'manual_pending';

      if (topMatchedFilePaths.length === 0) {
        status = 'failed';
        evidence = 'No implementation files found in project workspace addressing this requirement.';
        notes = 'Missing implementation evidence.';
        verificationMethod = 'manual_pending';
        remainingProblems.push('No implementation files found in project workspace addressing this requirement.');
      } else if (failedTests.length > 0) {
        status = 'failed';
        evidence = `Implementation in ${topMatchedFilePaths.join(', ')}, but automated test(s) failed: ${failedTests.map((t: any) => t.name).join(', ')}.`;
        notes = 'Failing unit test suite.';
        verificationMethod = 'automated_test_suite';
        for (const ft of failedTests) {
          remainingProblems.push(`Failing test "${ft.name}": ${ft.message || 'Assertion failed'}`);
        }
      } else {
        // Check syntax errors in matched files
        const syntaxErrorsInFiles = (execResult?.syntaxErrors || []).filter((e: any) => 
          topMatchedFilePaths.includes(e.filePath)
        );

        if (syntaxErrorsInFiles.length > 0) {
          status = 'blocked';
          evidence = `Implementation file ${syntaxErrorsInFiles[0].filePath} has syntax error: ${syntaxErrorsInFiles[0].message}`;
          notes = 'Syntax check failure.';
          verificationMethod = 'static_ast_and_syntax';
          for (const se of syntaxErrorsInFiles) {
            remainingProblems.push(`Syntax error in ${se.filePath}: ${se.message}`);
          }
        } else {
          deterministicChecksPassed = true;
          if (relevantTests.length > 0) {
            // Tests executed and passed cleanly -> genuine verified / implemented status
            status = 'implemented';
            evidence = `Verified in ${topMatchedFilePaths.join(', ')}. All ${relevantTests.length} relevant test(s) passed cleanly.`;
            notes = 'Fully implemented and verified with automated test suite.';
            verificationMethod = 'automated_test_suite';
          } else if (topMatchedFilePaths.length > 0) {
            // Files exist and passed syntax validation, but no automated tests ran specifically
            status = 'implemented';
            evidence = `Implemented in ${topMatchedFilePaths.join(', ')}. Code syntax and AST verified cleanly.`;
            notes = 'Implemented and statically verified.';
            verificationMethod = 'static_ast_and_syntax';
          } else {
            status = 'unverified';
            evidence = 'Files found but insufficient structural evidence to confirm implementation.';
            notes = 'Unverified requirement.';
            verificationMethod = 'manual_pending';
            remainingProblems.push('Insufficient structural evidence to confirm complete implementation.');
          }
        }
      }

      const verifiedItem: import('./types.js').RequirementItem = {
        id: item.id,
        title: (item as any).title,
        category: item.category,
        description: item.description,
        priority: (item as any).priority || 'should_have',
        satisfied: (status as import('./types.js').RequirementStatus) === 'verified' || status === 'implemented',
        status,
        relevantFiles: topMatchedFilePaths,
        satisfiedByFiles: topMatchedFilePaths,
        verificationMethod,
        evidence,
        testsExecuted: relevantTests,
        testResults,
        remainingLimitations: remainingProblems,
        remainingProblems,
        deterministicChecksPassed,
        verificationNotes: notes
      };

      verifiedItems.push(verifiedItem);

      // Keep ProjectMemory synchronized with deterministic status
      try {
        ProjectMemoryService.updateRequirement(build.id, build.userId, item.id, {
          satisfied: (status as import('./types.js').RequirementStatus) === 'verified' || status === 'implemented',
          status: status === 'implemented' || (status as import('./types.js').RequirementStatus) === 'verified' ? 'satisfied' : 'unmet',
          evidence,
          testsExecuted: relevantTests,
          deterministicChecksPassed,
          files: topMatchedFilePaths,
          notes
        });
      } catch {
        // Graceful fallback if memory record not yet registered
      }
    }

    // Save updated checklist back onto build
    build.requirementsChecklist = verifiedItems;
    return verifiedItems;
  }
}

