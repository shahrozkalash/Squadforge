import React, { useCallback, useEffect, useState } from 'react';
import { useSwarm } from '../context/SwarmContext.js';
import { DiagnosticReport, ExecutionSession, RepairLesson, RepairRun, RootCause } from '../types/index.js';
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  History,
  Lightbulb,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Square,
  Wrench,
  XCircle
} from 'lucide-react';

const POLL_MS = 2000;
const WORKING = new Set(['collecting', 'analyzing', 'investigating', 'proposing', 'validating', 'applying', 'verifying']);
const WAITING = new Set(['awaiting_approval', 'awaiting_test_approval']);

/** Words shown for each state. Only "verified" may read as success. */
const STATUS_LABELS: Record<string, string> = {
  collecting: 'Collecting errors',
  analyzing: 'Finding the root cause',
  investigating: 'Agents investigating',
  proposing: 'Writing a patch',
  validating: 'Validating the patch',
  applying: 'Applying the patch',
  verifying: 'Checking the result',
  awaiting_approval: 'Waiting for your approval',
  awaiting_test_approval: 'Waiting for approval to run tests',
  verified: 'Verified',
  applied_unverified: 'Applied, not verified',
  no_action: 'Nothing to repair',
  failed: 'Failed',
  rejected: 'Not approved',
  rolled_back: 'Rolled back',
  cancelled: 'Cancelled'
};

function statusColor(status: string): string {
  if (status === 'verified') return 'text-emerald-300 border-emerald-800 bg-emerald-950/30';
  if (status === 'failed' || status === 'rejected') return 'text-red-300 border-red-900 bg-red-950/30';
  if (status === 'applied_unverified' || WAITING.has(status)) return 'text-amber-300 border-amber-900 bg-amber-950/30';
  return 'text-neutral-300 border-neutral-700 bg-neutral-900';
}

async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

export const DebuggingView: React.FC = () => {
  const { activeBuild } = useSwarm();
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [causes, setCauses] = useState<RootCause[]>([]);
  const [repairs, setRepairs] = useState<RepairRun[]>([]);
  const [lessons, setLessons] = useState<RepairLesson[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const base = activeBuild ? `/api/builds/${activeBuild.id}/debugging` : '';
  const openRepair = repairs.find(run => WORKING.has(run.status) || WAITING.has(run.status));
  const hasOpenRepair = Boolean(openRepair);
  // Repair all starts new runs by itself, and the one needing attention must be the one shown
  const selected = repairs.find(run => run.id === selectedId) ?? openRepair ?? repairs[0];

  const refresh = useCallback(async () => {
    if (!base) return;
    const [history, memory] = await Promise.all([
      request<{ repairs: RepairRun[] }>(`${base}/repairs`),
      request<{ lessons: RepairLesson[] }>(`${base}/lessons`)
    ]);
    setRepairs(history.repairs);
    setLessons(memory.lessons);
  }, [base]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setReport(null);
    setCauses([]);
    setSelectedId(null);
    refresh().catch(err => setError(err.message));
  }, [refresh]);

  useEffect(() => {
    const chainContinues = repairs[0]?.repairAll && repairs[0].status === 'verified' && (repairs[0].chainDepth ?? 0) < 4;
    if (!repairs.some(run => WORKING.has(run.status)) && !chainContinues) return;
    const timer = setInterval(() => refresh().catch(() => undefined), POLL_MS);
    return () => clearInterval(timer);
  }, [repairs, refresh]);

  const analyze = () => act(async () => {
    const result = await request<{ report: DiagnosticReport; rootCauses: RootCause[] }>(`${base}/analyze`, 'POST', {});
    setReport(result.report);
    setCauses(result.rootCauses);
  });

  const startRepair = (options: { rootCauseId?: string; repairAll?: boolean }) => act(async () => {
    const result = await request<{ repair: RepairRun }>(`${base}/repairs`, 'POST', options);
    setSelectedId(options.repairAll ? null : result.repair.id);
  });

  /** Adds real calls to the running app to the analysis. */
  const checkRunningApp = () => act(async () => {
    const { sessions } = await request<{ sessions: ExecutionSession[] }>(`/api/builds/${activeBuild!.id}/execution/sessions`);
    const running = sessions.find(item => item.status === 'running');
    if (!running) throw new Error('Start the project in the Run tab first.');
    const result = await request<{ report: DiagnosticReport; rootCauses: RootCause[] }>(`${base}/analyze`, 'POST', { probeSessionId: running.id });
    setReport(result.report);
    setCauses(result.rootCauses);
  });

  if (!activeBuild) {
    return <p className="p-8 text-sm text-neutral-400">Open a project to debug it.</p>;
  }

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium text-neutral-100 flex items-center gap-2">
            <Bug className="w-5 h-5 text-amber-400" /> Debug project
          </h1>
          <p className="text-sm text-neutral-500 mt-1">
            Repairs are checked before they are applied. Sensitive files and test runs always need your approval.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={checkRunningApp}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md border border-neutral-700 text-neutral-200 hover:bg-neutral-900 disabled:opacity-50"
          >
            Check running app
          </button>
          <button
            onClick={analyze}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md bg-amber-500 text-neutral-950 font-medium disabled:opacity-50 flex items-center gap-1.5"
          >
            <Search className="w-4 h-4" /> {busy ? 'Working…' : 'Analyze project'}
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" className="rounded-md border border-red-900 bg-red-950/30 p-3 text-sm text-red-300">{error}</div>
      )}

      {report && (
        <section aria-label="Analysis" className="rounded-md border border-neutral-800">
          <div className="px-3 py-2 border-b border-neutral-800 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-neutral-200">
              {report.diagnostics.length} problem(s) from {causes.length} root cause(s)
            </h2>
            {causes.length > 1 && (
              <button
                onClick={() => startRepair({ repairAll: true })}
                disabled={busy || hasOpenRepair}
                className="px-2.5 py-1 text-xs rounded-md border border-neutral-700 text-neutral-200 hover:bg-neutral-900 disabled:opacity-40 flex items-center gap-1"
              >
                <Wrench className="w-3.5 h-3.5" /> Repair all
              </button>
            )}
          </div>
          <div className="px-3 py-2 flex flex-wrap gap-2 border-b border-neutral-800">
            {report.checks.map(check => (
              <span
                key={check.name}
                title={check.detail}
                className={`text-xs px-2 py-0.5 rounded border ${
                  check.status === 'passed' ? 'border-emerald-900 text-emerald-300'
                    : check.status === 'failed' ? 'border-red-900 text-red-300'
                      : 'border-neutral-700 text-neutral-400'
                }`}
              >
                {check.name}: {check.status === 'skipped' ? 'not run' : check.status}
              </span>
            ))}
          </div>
          {causes.length === 0 ? (
            <p className="p-3 text-sm text-neutral-400">
              No problems found. Checks marked "not run" were not part of this result.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-800">
              {causes.map(cause => (
                <li key={cause.id} className="p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-neutral-100 break-words">{cause.summary}</p>
                      <p className="text-xs text-neutral-500 mt-1">
                        {cause.confidence} confidence · {cause.leadAgent.replace(/_/g, ' ')}
                        {cause.cascadedFingerprints.length > 0 && ` · explains ${cause.cascadedFingerprints.length} other error(s)`}
                      </p>
                    </div>
                    <button
                      onClick={() => startRepair({ rootCauseId: cause.id })}
                      disabled={busy || hasOpenRepair || !cause.primaryFile}
                      title={cause.primaryFile ? undefined : 'No file could be tied to this problem'}
                      className="px-2.5 py-1 text-xs rounded-md border border-neutral-700 text-neutral-200 hover:bg-neutral-900 disabled:opacity-40 flex items-center gap-1 shrink-0"
                    >
                      <Wrench className="w-3.5 h-3.5" /> Repair
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {report.staleDiagnostics.length > 0 && (
            <p className="px-3 py-2 text-xs text-neutral-500 border-t border-neutral-800">
              {report.staleDiagnostics.length} runtime error(s) came from an older version of the project, so they are not listed above.
            </p>
          )}
        </section>
      )}

      {selected && (
        <RepairDetail
          run={selected}
          busy={busy}
          onCancel={() => act(() => request(`${base}/repairs/${selected.id}/cancel`, 'POST', {}))}
          onRollback={() => act(() => request(`${base}/repairs/${selected.id}/rollback`, 'POST', {}))}
          onVerify={() => act(() => request(`${base}/repairs/${selected.id}/verify`, 'POST', {}))}
        />
      )}

      <section aria-label="Repair history" className="rounded-md border border-neutral-800">
        <h2 className="px-3 py-2 text-sm font-medium text-neutral-200 border-b border-neutral-800 flex items-center gap-2">
          <History className="w-4 h-4" /> Repair history
        </h2>
        {repairs.length === 0 ? (
          <p className="p-3 text-sm text-neutral-500">No repairs yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-800">
            {repairs.map(run => (
              <li key={run.id}>
                <button
                  onClick={() => setSelectedId(run.id)}
                  className="w-full text-left px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-900 flex flex-wrap gap-x-4"
                >
                  <span>{new Date(run.createdAt).toLocaleString()}</span>
                  <span>{STATUS_LABELS[run.status] || run.status}</span>
                  <span>{run.fileChanges.map(change => change.path).join(', ') || 'No files changed'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Project memory" className="rounded-md border border-neutral-800">
        <h2 className="px-3 py-2 text-sm font-medium text-neutral-200 border-b border-neutral-800 flex items-center gap-2">
          <Lightbulb className="w-4 h-4" /> What this project has learned
        </h2>
        {lessons.length === 0 ? (
          <p className="p-3 text-sm text-neutral-500">Nothing yet. Only verified fixes and real failures are remembered.</p>
        ) : (
          <ul className="divide-y divide-neutral-800">
            {lessons.map(lesson => (
              <li key={lesson.id} className="p-3 text-sm text-neutral-300 flex gap-2">
                {lesson.outcome === 'verified'
                  ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" aria-label="Verified fix" />
                  : <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" aria-label="Failed approach" />}
                <div className="min-w-0">
                  <p className="break-words">{lesson.summary}</p>
                  <p className="text-xs text-neutral-500 mt-0.5 break-words">
                    {lesson.evidence}{lesson.timesSeen > 1 ? ` · seen ${lesson.timesSeen} times` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

const RepairDetail: React.FC<{
  run: RepairRun;
  busy: boolean;
  onCancel: () => void;
  onRollback: () => void;
  onVerify: () => void;
}> = ({ run, busy, onCancel, onRollback, onVerify }) => {
  const running = WORKING.has(run.status);
  const open = running || WAITING.has(run.status);
  const canRollBack = run.fileChanges.length > 0 && run.rollback?.state !== 'done' && run.rollback?.state !== 'pending_approval' && !running;
  const tests = run.verification?.tests;

  return (
    <section aria-label="Repair details" className="rounded-md border border-neutral-800 p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-xs px-2 py-0.5 rounded border inline-flex items-center gap-1 ${statusColor(run.status)}`}>
          {running && <RefreshCw className="w-3 h-3 animate-spin" />}
          {STATUS_LABELS[run.status] || run.status}
        </span>
        <div className="flex flex-wrap gap-2">
          {open && (
            <button onClick={onCancel} disabled={busy} className="px-2.5 py-1 text-xs rounded-md border border-neutral-700 text-neutral-200 hover:bg-neutral-900 disabled:opacity-40 flex items-center gap-1">
              <Square className="w-3.5 h-3.5" /> Cancel
            </button>
          )}
          {run.status === 'applied_unverified' && (
            <button onClick={onVerify} disabled={busy} className="px-2.5 py-1 text-xs rounded-md border border-neutral-700 text-neutral-200 hover:bg-neutral-900 disabled:opacity-40 flex items-center gap-1">
              <RefreshCw className="w-3.5 h-3.5" /> Check again
            </button>
          )}
          {canRollBack && (
            <button onClick={onRollback} disabled={busy} className="px-2.5 py-1 text-xs rounded-md border border-neutral-700 text-neutral-200 hover:bg-neutral-900 disabled:opacity-40 flex items-center gap-1">
              <RotateCcw className="w-3.5 h-3.5" /> Roll back
            </button>
          )}
        </div>
      </div>

      {run.outcome && <p className="text-sm text-neutral-200 break-words">{run.outcome}</p>}

      {WAITING.has(run.status) && (
        <p className="text-sm text-amber-200 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0" /> Review this request in the Collaboration tab, under approvals.
        </p>
      )}

      {run.rollback && run.rollback.state !== 'done' && (
        <div className="rounded-md border border-amber-900 bg-amber-950/30 p-2 text-sm text-amber-200">
          <p className="flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {run.rollback.state === 'pending_approval' ? 'The rollback is waiting for your approval.' : 'The rollback did not happen, and your files were left as they are.'}
          </p>
          {run.rollback.conflicts.map(conflict => <p key={conflict} className="text-xs mt-1 break-words">{conflict}</p>)}
        </div>
      )}

      {run.investigation?.supported && (
        <div className="text-sm">
          <p className="text-xs text-neutral-500">{run.investigation.role.replace(/_/g, ' ')} found</p>
          <p className="text-neutral-300 break-words">{run.investigation.hypothesis}</p>
        </div>
      )}

      {tests && (
        <p className="text-sm text-neutral-300 break-words">
          <span className="text-xs text-neutral-500 block">Tests</span>
          {tests.detail}
        </p>
      )}

      {run.verification?.runtime && (
        <p className="text-sm text-neutral-300 break-words">
          <span className="text-xs text-neutral-500 block">Ran again in the sandbox</span>
          {run.verification.runtime.detail}
        </p>
      )}

      {run.rollback?.keptLaterEdits && run.rollback.keptLaterEdits.length > 0 && (
        <p className="text-xs text-neutral-400 break-words">Later edits were kept in {run.rollback.keptLaterEdits.join(', ')}.</p>
      )}

      {run.attempts.length > 0 && (
        <ol className="space-y-1">
          {run.attempts.map(attempt => (
            <li key={attempt.attempt} className="text-xs text-neutral-400 break-words">
              Attempt {attempt.attempt}: {attempt.outcome.replace(/_/g, ' ')}
              {attempt.detail ? ` – ${attempt.detail}` : ''}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
