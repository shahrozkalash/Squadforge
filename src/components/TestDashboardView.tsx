import React, { useMemo } from 'react';
import { Activity, CheckCircle2, CircleDashed, ShieldCheck, Gauge, AlertTriangle } from 'lucide-react';
import { useSwarm } from '../context/SwarmContext.js';

interface QualityGateState {
  id: string;
  name: string;
  description: string;
  required: boolean;
  passed: boolean;
  evidence: string;
  severity: 'error' | 'warning';
  actual?: number;
  threshold?: number;
}

const defaultGates: Array<Omit<QualityGateState, 'passed' | 'evidence'>> = [
  { id: 'syntax', name: 'Syntax validation', description: 'Source files must parse without syntax errors.', required: true, severity: 'error' },
  { id: 'types', name: 'Type checking', description: 'TypeScript diagnostics should remain clean.', required: true, severity: 'error' },
  { id: 'tests', name: 'Test execution', description: 'The suite should pass with no unresolved failures.', required: true, severity: 'error' },
  { id: 'build', name: 'Production build', description: 'Bundling must finish successfully.', required: true, severity: 'error' },
  { id: 'security', name: 'Security audit', description: 'No risky findings should remain open.', required: true, severity: 'warning' },
  { id: 'coverage', name: 'Coverage floor', description: 'Target coverage should meet the configured threshold.', required: false, severity: 'warning', threshold: 80 }
];

export const TestDashboardView: React.FC = () => {
  const { activeBuild, verificationReport } = useSwarm();

  const assessment = useMemo(() => {
    const baseReport = verificationReport || { 
      verdict: 'pending',
      syntaxChecksPassed: false,
      typeChecksPassed: false,
      testExecution: { total: 0, passed: 0, failed: 0, skipped: 0, details: [] },
      buildPassed: false,
      securityAuditPassed: false,
      securityScore: 0,
      requirementsCoveragePercent: 0,
      knownDefects: ['No verification has run for this build yet.'],
      buildOutput: 'No build evidence yet.'
    } as any;

    const gates = defaultGates.map((gate) => {
      switch (gate.id) {
        case 'syntax':
          return { ...gate, passed: Boolean(baseReport.syntaxChecksPassed), evidence: baseReport.syntaxChecksPassed ? 'JavaScript and TypeScript parsed cleanly.' : baseReport.knownDefects?.join('; ') || 'Syntax validation failed.' };
        case 'types':
          return { ...gate, passed: Boolean(baseReport.typeChecksPassed), evidence: baseReport.typeChecksPassed ? 'TypeScript compiler diagnostics are clean.' : baseReport.knownDefects?.join('; ') || 'Type checking failed.' };
        case 'tests':
          return { ...gate, passed: Number(baseReport.testExecution?.failed || 0) === 0 && Number(baseReport.testExecution?.total || 0) > 0, actual: Number(baseReport.testExecution?.total || 0), threshold: Number(baseReport.testExecution?.total || 0) > 0 ? Number(baseReport.testExecution?.total || 0) : undefined, evidence: Number(baseReport.testExecution?.failed || 0) === 0 && Number(baseReport.testExecution?.total || 0) > 0 ? `${baseReport.testExecution?.passed || 0}/${baseReport.testExecution?.total || 0} tests passed.` : `${baseReport.testExecution?.failed || 0} failing tests remain.` };
        case 'build':
          return { ...gate, passed: Boolean(baseReport.buildPassed), evidence: baseReport.buildPassed ? 'The production build completed successfully.' : baseReport.buildOutput || 'Build verification failed.' };
        case 'security':
          return { ...gate, passed: Boolean(baseReport.securityAuditPassed), evidence: baseReport.securityAuditPassed ? `Security score ${baseReport.securityScore || 0}/100 passed.` : `${baseReport.securityScore || 0}/100 requires review before release.` };
        case 'coverage':
          return { ...gate, passed: Number(baseReport.requirementsCoveragePercent || 0) >= (gate.threshold ?? 80), actual: Number(baseReport.requirementsCoveragePercent || 0), threshold: gate.threshold ?? 80, evidence: Number(baseReport.requirementsCoveragePercent || 0) >= (gate.threshold ?? 80) ? `Coverage exceeds the ${gate.threshold ?? 80}% target (${baseReport.requirementsCoveragePercent || 0}%).` : `Coverage is ${baseReport.requirementsCoveragePercent || 0}% and is below the target.` };
        default:
          return { ...gate, passed: false, evidence: 'Unknown gate status.' };
      }
    });

    const passedGates = gates.filter((gate) => gate.passed).length;
    const totalGates = gates.length;
    const failedGates = totalGates - passedGates;
    const ready = Boolean(activeBuild?.status === 'completed' || baseReport.verdict === 'verified' || baseReport.verdict === 'passed') && failedGates === 0;

    return {
      verdict: baseReport.verdict || 'pending',
      score: Math.max(0, Math.min(100, Math.round((passedGates / totalGates) * 100))),
      totalGates,
      passedGates,
      failedGates,
      passCount: passedGates,
      ready,
      gates,
      summary: ready ? `Build ${activeBuild?.id || 'current'} passed every gate in the QA dashboard.` : 'Quality gates remain blocked. Fix the visible failures before marking the project ready.',
      report: baseReport
    };
  }, [activeBuild, verificationReport]);

  const overallTone = assessment.ready ? 'text-emerald-300' : 'text-amber-300';

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-amber-400 font-mono">
            <Activity className="w-3.5 h-3.5" />
            Quality assurance
          </div>
          <h2 className="mt-2 text-2xl font-bold text-white">Testing & Quality Dashboard</h2>
          <p className="mt-1 text-sm text-neutral-400">Real validation status, configurable gates, and evidence-based results.</p>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-3 min-w-[220px]">
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">Overall score</div>
          <div className={`mt-2 text-3xl font-bold ${overallTone}`}>{assessment.score}%</div>
          <div className="mt-1 text-xs text-neutral-400">{assessment.summary}</div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Passed" value={`${assessment.passedGates}/${assessment.totalGates}`} icon={<CheckCircle2 className="w-4 h-4 text-emerald-400" />} />
        <StatCard label="Failed" value={`${assessment.failedGates}`} icon={<AlertTriangle className="w-4 h-4 text-rose-400" />} />
        <StatCard label="Coverage" value={`${(assessment.report as any)?.requirementsCoveragePercent ?? 0}%`} icon={<Gauge className="w-4 h-4 text-cyan-400" />} />
        <StatCard label="Security" value={`${(assessment.report as any)?.securityScore ?? 0}/100`} icon={<ShieldCheck className="w-4 h-4 text-violet-400" />} />
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 bg-neutral-950/60">
          <div className="text-sm font-semibold text-white">Quality gates</div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">{assessment.ready ? 'ready' : 'blocked'}</div>
        </div>

        <div className="divide-y divide-neutral-800">
          {assessment.gates.map((gate) => (
            <div key={gate.id} className="px-4 py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2">
              <div className="flex items-start gap-3">
                <div className={`mt-1 rounded-full p-1 ${gate.passed ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
                  {gate.passed ? <CheckCircle2 className="w-4 h-4" /> : <CircleDashed className="w-4 h-4" />}
                </div>
                <div>
                  <div className="font-medium text-white">{gate.name}</div>
                  <div className="text-xs text-neutral-400">{gate.description}</div>
                  <div className="mt-1 text-[11px] text-neutral-500 font-mono">{gate.evidence}</div>
                </div>
              </div>

              <div className="text-right text-xs font-mono">
                <span className={gate.passed ? 'text-emerald-300' : 'text-rose-300'}>{gate.passed ? 'PASS' : 'FAIL'}</span>
                {typeof gate.actual === 'number' && typeof gate.threshold === 'number' && (
                  <div className="mt-1 text-neutral-500">{gate.actual}% / {gate.threshold}%</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

function StatCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-4">
      <div className="flex items-center justify-between text-xs text-neutral-400 uppercase tracking-[0.2em] font-mono">
        <span>{label}</span>
        {icon}
      </div>
      <div className="mt-3 text-2xl font-bold text-white">{value}</div>
    </div>
  );
}

export default TestDashboardView;
