import React, { useState, useEffect } from 'react';
import { useSwarm } from '../context/SwarmContext.js';
import { Build } from '../types/index.js';
import { 
  History, 
  ExternalLink, 
  Clock, 
  DollarSign, 
  CheckCircle2, 
  Square, 
  AlertTriangle,
  ArrowRight,
  Github
} from 'lucide-react';

interface BuildHistoryViewProps {
  onSelectBuild: (buildId: string) => void;
}

export const BuildHistoryView: React.FC<BuildHistoryViewProps> = ({ onSelectBuild }) => {
  const [builds, setBuilds] = useState<Build[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchBuilds = async () => {
    try {
      const res = await fetch('/api/builds');
      if (res.ok) {
        const data = await res.json();
        setBuilds(data.builds || []);
      }
    } catch (err) {
      console.error('Failed to fetch build history:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBuilds();
  }, []);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white font-sans flex items-center gap-2">
            <History className="w-5 h-5 text-amber-400" />
            <span>Swarm Build History</span>
          </h2>
          <p className="text-xs text-neutral-400 mt-0.5">
            Past multi-model autonomous software engineering runs
          </p>
        </div>
        <button
          onClick={fetchBuilds}
          className="px-3 py-1.5 text-xs font-mono text-neutral-300 hover:text-white bg-neutral-900 border border-neutral-800 rounded-lg"
        >
          Refresh History
        </button>
      </div>

      {loading ? (
        <div className="p-12 text-center text-xs text-neutral-500 font-mono">
          Loading past builds...
        </div>
      ) : builds.length === 0 ? (
        <div className="p-12 bg-neutral-900 border border-neutral-800 rounded-xl text-center space-y-2">
          <p className="text-sm text-neutral-300">No past swarm builds recorded yet.</p>
          <p className="text-xs text-neutral-500">
            Launch your first build in the Idea Forge tab to see it archived here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {builds.map((build) => {
            const dateStr = new Date(build.createdAt).toLocaleString();
            const durationSec = build.completedAt 
              ? Math.round((build.completedAt - build.createdAt) / 1000)
              : Math.round((Date.now() - build.createdAt) / 1000);

            const isCompleted = build.status === 'completed';
            const isStopped = build.status === 'stopped' || build.status === 'failed';

            return (
              <div
                key={build.id}
                className="p-5 bg-neutral-900 border border-neutral-800 rounded-xl hover:border-neutral-700 transition-colors space-y-3 shadow-md"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border uppercase ${
                      isCompleted 
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                        : isStopped 
                        ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' 
                        : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                    }`}>
                      {build.status}
                    </span>
                    <span className="text-xs font-mono text-neutral-400">{dateStr}</span>
                    <span className="text-neutral-600">·</span>
                    <span className="text-xs font-mono text-neutral-400">{durationSec}s run</span>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-neutral-400">
                      Cost: ${(build.totalCost || 0).toFixed(4)}
                    </span>
                    <button
                      onClick={() => onSelectBuild(build.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-neutral-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors"
                    >
                      <span>Load Workspace</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="text-sm font-semibold text-white">
                  "{build.idea}"
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-neutral-800/80 text-xs font-mono text-neutral-400">
                  <div className="flex items-center gap-2">
                    <span>{build.selectedModels?.length || 10} Models</span>
                    <span>·</span>
                    <span>{build.patchesAppliedCount || 0} Patches</span>
                  </div>

                  {build.githubRepoUrl && (
                    <a
                      href={build.githubRepoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-400 hover:text-emerald-300 flex items-center gap-1.5"
                    >
                      <Github className="w-3.5 h-3.5" />
                      <span>{build.githubRepoUrl.split('/').slice(-2).join('/')}</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
