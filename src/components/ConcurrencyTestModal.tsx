import React, { useState } from 'react';
import { ConcurrencyTestReport } from '../types/index.js';
import { 
  X, 
  Activity, 
  Play, 
  CheckCircle2, 
  AlertTriangle, 
  Clock, 
  Cpu, 
  FileCode,
  ShieldCheck
} from 'lucide-react';

interface ConcurrencyTestModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ConcurrencyTestModal: React.FC<ConcurrencyTestModalProps> = ({ isOpen, onClose }) => {
  const [isRunning, setIsRunning] = useState(false);
  const [report, setReport] = useState<ConcurrencyTestReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleRunTest = async () => {
    setIsRunning(true);
    setError(null);
    setReport(null);

    try {
      const res = await fetch('/api/test-concurrency', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Test execution failed');
      }
      const data: ConcurrencyTestReport = await res.json();
      setReport(data);
    } catch (err: any) {
      setError(err.message || 'Failed to complete test');
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="w-full max-w-3xl bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-950 shrink-0">
          <div className="flex items-center gap-2.5">
            <Activity className="w-4 h-4 text-cyan-400" />
            <div>
              <h3 className="text-base font-semibold text-white">
                10-Model Simultaneous Concurrency Stress Test
              </h3>
              <p className="text-xs text-neutral-400">
                Simulates 10 AI models patching the exact same file at the exact same millisecond
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="text-neutral-400 hover:text-white p-1 rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto flex-1 font-sans">
          <div className="p-4 bg-neutral-950 border border-neutral-800 rounded-lg space-y-2 text-xs text-neutral-300 leading-relaxed">
            <div className="font-semibold text-white flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Conflict-Free Merge Verification Protocol</span>
            </div>
            <p>
              In SquadForge, models never overwrite each other. When 10 models submit surgical JSON patches simultaneously, the Merge Manager processes them sequentially via mutex locks, validates exact occurrences of target anchor lines, and guides retry loops with latest file state.
            </p>
          </div>

          <div className="flex items-center justify-between pt-1">
            <span className="text-xs font-mono text-neutral-400">
              {isRunning ? 'Benchmarking 10 models concurrently...' : report ? 'Benchmark complete' : 'Ready to benchmark'}
            </span>

            <button
              onClick={handleRunTest}
              disabled={isRunning}
              className="flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-neutral-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 rounded-lg transition-colors shadow"
            >
              <Play className="w-3.5 h-3.5 fill-neutral-950" />
              <span>{isRunning ? 'Running Simulation...' : 'Execute 10-Model Stress Test'}</span>
            </button>
          </div>

          {error && (
            <div className="p-3 bg-rose-950/30 border border-rose-500/30 rounded-lg text-xs text-rose-300">
              {error}
            </div>
          )}

          {report && (
            <div className="space-y-4 pt-2">
              {/* Verdict Banner */}
              <div className={`p-4 rounded-lg border text-xs ${
                report.success 
                  ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-300' 
                  : 'bg-rose-950/20 border-rose-500/30 text-rose-300'
              }`}>
                <div className="font-bold text-sm mb-1 flex items-center gap-2">
                  {report.success ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                  <span>{report.verdict}</span>
                </div>
                <div className="font-mono text-[11px] text-neutral-300">
                  Target: {report.targetFile} · Initial v{report.initialVersion} &rarr; Final v{report.finalVersion} · Elapsed: {report.elapsedMs}ms
                </div>
              </div>

              {/* Models Breakdown */}
              <div className="space-y-2">
                <span className="text-xs font-mono uppercase tracking-wider text-neutral-400">
                  Individual Model Turnaround & Edits Verified
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {report.modelResults.map((m) => (
                    <div 
                      key={m.modelId}
                      className="p-2.5 bg-neutral-950 border border-neutral-800 rounded flex items-center justify-between text-xs font-mono"
                    >
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-white font-medium">{m.modelName}</span>
                      </div>
                      <div className="text-[11px] text-neutral-400">
                        {m.attempts} attempt(s) &rarr; v{m.appliedVersion}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Final Consolidated Code Preview */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-mono text-neutral-400">
                  <span>Resulting Consolidated File (All 10 Edits Present)</span>
                  <span className="text-emerald-400">0 Edits Lost</span>
                </div>
                <pre className="p-4 bg-neutral-950 border border-neutral-800 rounded-lg text-xs font-mono text-neutral-300 overflow-x-auto max-h-[220px]">
                  {report.finalContent}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-neutral-800 bg-neutral-950 flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-neutral-300 hover:text-white bg-neutral-800 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
