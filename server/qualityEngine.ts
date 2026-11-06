import { HonestVerificationService } from './verificationService.js';
import type { VerificationReport, VerificationVerdict } from './types.js';

export type QualityGateType = 'syntax' | 'types' | 'tests' | 'build' | 'security' | 'coverage';

export interface QualityGateDefinition {
  id: QualityGateType;
  name: string;
  description: string;
  required: boolean;
  threshold?: number;
  severity?: 'error' | 'warning';
}

export interface QualityGateResult {
  id: QualityGateType;
  name: string;
  description: string;
  required: boolean;
  passed: boolean;
  actual?: number;
  threshold?: number;
  evidence: string;
  severity: 'error' | 'warning';
}

export interface QualityPlan {
  summary: string;
  phases: Array<{ name: string; objective: string; checks: string[] }>;
}

export interface QualityRunResult {
  verdict: VerificationVerdict;
  score: number;
  totalGates: number;
  passedGates: number;
  failedGates: number;
  passCount: number;
  ready: boolean;
  gates: QualityGateResult[];
  report: VerificationReport;
  summary: string;
}

export class QualityAssuranceEngine {
  static defaultGates(): QualityGateDefinition[] {
    return [
      { id: 'syntax', name: 'Syntax validation', description: 'Source files must parse without syntax errors.', required: true },
      { id: 'types', name: 'Type checking', description: 'TypeScript should pass without blocking diagnostics.', required: true },
      { id: 'tests', name: 'Test execution', description: 'The project test suite must pass for the build to be considered ready.', required: true },
      { id: 'build', name: 'Production build', description: 'A successful bundle is required before final verification.', required: true },
      { id: 'security', name: 'Security audit', description: 'No high-confidence security findings should remain open.', required: true },
      { id: 'coverage', name: 'Coverage floor', description: 'The project should reach the configured test coverage floor.', required: false, threshold: 80 }
    ];
  }

  static generateTestingPlan(projectIdea: string, projectType?: string): QualityPlan {
    const normalizedType = (projectType || 'software').toLowerCase();
    const phases = [
      {
        name: 'Architecture & requirement review',
        objective: 'Confirm the project shape, runtime constraints, and validation targets before code is accepted.',
        checks: ['Inspect project structure and entry points', 'Verify README and build assumptions', 'Capture environment requirements and test strategy']
      },
      {
        name: 'Unit and API validation',
        objective: 'Exercise the smallest correctness boundaries and API contracts.',
        checks: ['Run targeted unit tests for model, routing, and file logic', 'Verify API responses and edge cases', 'Check rate limits, approvals, and failure paths']
      },
      {
        name: 'Integration and regression protection',
        objective: 'Ensure build, execution, and debugging flows stay consistent when they change.',
        checks: ['Run integration tests for execution and repair flows', 'Verify regression coverage on previously broken scenarios', 'Compare results with the execution sandbox']
      },
      {
        name: 'Quality gate enforcement',
        objective: 'Reject any project that fails syntax, type, test, build, or security gates.',
        checks: ['Block release when checks are below the configured threshold', 'Surface real failures without hiding skipped results', 'Publish the final quality score and evidence summary']
      }
    ];

    return {
      summary: `Testing plan for ${projectIdea || 'the current project'} (${normalizedType}) uses evidence-first validation across unit, integration, API, regression, and release checks.`,
      phases
    };
  }

  static evaluateProjectQuality(buildId: string, overrides: Partial<Record<QualityGateType, Partial<QualityGateDefinition>>> = {}): QualityRunResult {
    const report = HonestVerificationService.evaluateProjectReadiness(buildId);
    const projectFilesExist = report.checks.some((check) => check.category === 'files' && check.name === 'Project Workspace Files' && check.passed);

    const gates = this.defaultGates().map((defaultGate) => {
      const override = overrides[defaultGate.id];
      const resolved = override ? { ...defaultGate, ...override } : defaultGate;
      const gateResult = this.evaluateGate(report, resolved);

      if (!projectFilesExist) {
        return {
          ...gateResult,
          passed: false,
          evidence: 'Project workspace is empty; no source or verification evidence exists yet.'
        };
      }

      return gateResult;
    });

    const passedGates = gates.filter((gate) => gate.passed).length;
    const totalGates = gates.length;
    const failedGates = gates.filter((gate) => !gate.passed).length;
    const score = Math.max(0, Math.min(100, Math.round((passedGates / Math.max(totalGates, 1)) * 100)));
    const ready = projectFilesExist && (report.verdict === 'verified' || report.verdict === 'passed');
    const summary = ready && failedGates === 0
      ? `Project ${buildId} is ready: ${passedGates}/${totalGates} quality gates passed.`
      : `Project ${buildId} is not ready: ${failedGates} gate(s) failed; evidence remains visible in the verification report.`;

    return {
      verdict: report.verdict,
      score,
      totalGates,
      passedGates,
      failedGates,
      passCount: passedGates,
      ready,
      gates,
      report,
      summary
    };
  }

  private static evaluateGate(report: VerificationReport, gate: QualityGateDefinition): QualityGateResult {
    switch (gate.id) {
      case 'syntax': {
        const passed = report.syntaxChecksPassed;
        return {
          id: gate.id,
          name: gate.name,
          description: gate.description,
          required: gate.required,
          passed,
          evidence: passed ? 'All JavaScript and TypeScript files parsed without syntax errors.' : (report.knownDefects.join('; ') || 'Syntax validation failed.'),
          severity: 'error'
        };
      }
      case 'types': {
        const passed = report.typeChecksPassed;
        return {
          id: gate.id,
          name: gate.name,
          description: gate.description,
          required: gate.required,
          passed,
          evidence: passed ? 'TypeScript compiler diagnostics are clean.' : (report.knownDefects.join('; ') || 'Type checking failed.'),
          severity: 'error'
        };
      }
      case 'tests': {
        const passed = report.testExecution.failed === 0 && report.testExecution.total > 0;
        return {
          id: gate.id,
          name: gate.name,
          description: gate.description,
          required: gate.required,
          passed,
          actual: report.testExecution.total,
          threshold: report.testExecution.total > 0 ? report.testExecution.total : undefined,
          evidence: passed ? `${report.testExecution.passed}/${report.testExecution.total} tests passed.` : `${report.testExecution.failed} failing tests remain in the current suite.`,
          severity: 'error'
        };
      }
      case 'build': {
        const passed = report.buildPassed;
        return {
          id: gate.id,
          name: gate.name,
          description: gate.description,
          required: gate.required,
          passed,
          evidence: passed ? 'Build step completed without bundling errors.' : (report.buildOutput || 'Production build failed.'),
          severity: 'error'
        };
      }
      case 'security': {
        const passed = report.securityAuditPassed;
        return {
          id: gate.id,
          name: gate.name,
          description: gate.description,
          required: gate.required,
          passed,
          evidence: passed ? `Security score ${report.securityScore}/100 passed the audit.` : `${report.securityScore}/100 requires review before release.`,
          severity: 'warning'
        };
      }
      case 'coverage': {
        const threshold = gate.threshold ?? 80;
        const actual = report.requirementsCoveragePercent;
        const passed = actual >= threshold;
        return {
          id: gate.id,
          name: gate.name,
          description: gate.description,
          required: gate.required,
          passed,
          actual,
          threshold,
          evidence: passed ? `Coverage exceeds the ${threshold}% requirement (${actual}%).` : `Coverage is ${actual}% and is below the ${threshold}% gate.`,
          severity: 'warning'
        };
      }
      default:
        return {
          id: gate.id,
          name: gate.name,
          description: gate.description,
          required: gate.required,
          passed: false,
          evidence: 'Unknown quality gate result.',
          severity: 'error'
        };
    }
  }
}

export default QualityAssuranceEngine;
