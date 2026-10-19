import React from 'react';
import { useSwarm } from '../context/SwarmContext.js';
import { 
  GitMerge, 
  ShieldCheck, 
  RotateCcw, 
  CheckCircle2, 
  AlertTriangle, 
  Clock, 
  FileCode,
  Layers,
  Lock,
  GitBranch
} from 'lucide-react';
import { Checkpoint } from '../types/index.js';

export const MergeHistoryView: React.FC = () => {
  const { checkpoints, events, activeBuild, rollbackToCheckpoint, files } = useSwarm();

  const patchEvents = events.filter(e => 
    e.type === 'patch_applied' || 
    e.type === 'patch_rejected' || 
    e.type === 'file_created' || 
    e.type === 'file_leased' ||
    e.type === 'checkpoint_saved' ||
    e.type === 'checkpoint_reverted'
  );

  const totalPatches = events.filter(e => e.type === 'patch_applied').length;
  const conflictsResolved = events.filter(e => e.type === 'patch_rejected').length;
  const filesCreated = events.filter(e => e.type === 'file_created').length;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      {/* Metrics Banner */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-xl space-y-1">
          <div className="text-xs font-mono text-neutral-400">Patches Applied</div>
          <div className="text-2xl font-bold font-mono text-emerald-400">{totalPatches}</div>
          <div className="text-[11px] text-neutral-500">Conflict-free sequential merges</div>
        </div>

        <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-xl space-y-1">
          <div className="text-xs font-mono text-neutral-400">Conflicts Detected & Redone</div>
          <div className="text-2xl font-bold font-mono text-amber-400">{conflictsResolved}</div>
          <div className="text-[11px] text-neutral-500">Auto-retried on latest file state</div>
        </div>

        <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-xl space-y-1">
          <div className="text-xs font-mono text-neutral-400">Active Files Managed</div>
          <div className="text-2xl font-bold font-mono text-cyan-400">{files.length}</div>
          <div className="text-[11px] text-neutral-500">Modular files (&le;150 lines)</div>
        </div>

        <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-xl space-y-1">
          <div className="text-xs font-mono text-neutral-400">Verified Checkpoints</div>
          <div className="text-2xl font-bold font-mono text-purple-400">{checkpoints.length}</div>
          <div className="text-[11px] text-neutral-500">Sandbox-verified restore points</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Left: Verified Checkpoints & Project Rollback */}
        <div className="p-5 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4 lg:col-span-1 shadow-lg">
          <div className="flex items-center gap-2 border-b border-neutral-800 pb-3">
            <ShieldCheck className="w-4 h-4 text-purple-400" />
            <h3 className="text-sm font-semibold text-white">Project Checkpoints</h3>
          </div>

          <p className="text-xs text-neutral-400 leading-relaxed">
            The Merge Manager creates a verified checkpoint whenever the automated sandbox checks pass (every 5 patches). You can roll back the entire project to any previous verified state.
          </p>

          <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
            {checkpoints.length === 0 ? (
              <div className="text-xs font-mono text-neutral-500 p-4 text-center">
                Checkpoints will be created as patches pass sandbox checks.
              </div>
            ) : (
              checkpoints.slice().reverse().map((chk, idx) => {
                const time = new Date(chk.timestamp).toLocaleTimeString();
                const fileCount = Object.keys(chk.filesSnapshot || {}).length;
                return (
                  <div 
                    key={chk.id}
                    className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-purple-300">
                        Checkpoint #{checkpoints.length - idx}
                      </span>
                      <span className="text-[11px] font-mono text-neutral-500">{time}</span>
                    </div>

                    <div className="text-neutral-300 font-sans text-xs">
                      {chk.description}
                    </div>

                    <div className="flex items-center justify-between pt-1 border-t border-neutral-900 text-[11px] font-mono text-neutral-400">
                      <span>{fileCount} files snapshot</span>
                      <button
                        onClick={() => rollbackToCheckpoint(chk.id)}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded hover:bg-amber-500/20 transition-colors"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>Rollback Project</span>
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right: Merge Activity Stream */}
        <div className="p-5 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4 lg:col-span-2 shadow-lg">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <GitMerge className="w-4 h-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-white">Merge Manager Operation Stream</h3>
            </div>
            <span className="text-xs font-mono text-neutral-400">
              One Sequential Mutex Pipe
            </span>
          </div>

          <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1 font-mono text-xs">
            {patchEvents.length === 0 ? (
              <div className="text-xs font-mono text-neutral-500 p-4 text-center">
                Merge events will appear here as the parallel swarm begins work.
              </div>
            ) : (
              patchEvents.slice().reverse().map(evt => {
                const time = new Date(evt.timestamp).toLocaleTimeString();
                const isConflict = evt.type === 'patch_rejected';
                const isCreated = evt.type === 'file_created';
                const isLeased = evt.type === 'file_leased';

                return (
                  <div
                    key={evt.id}
                    className={`p-3 rounded-lg border text-xs transition-colors ${
                      isConflict 
                        ? 'bg-amber-950/20 border-amber-500/30' 
                        : isCreated 
                        ? 'bg-cyan-950/10 border-cyan-500/20' 
                        : isLeased 
                        ? 'bg-purple-950/20 border-purple-500/30' 
                        : 'bg-neutral-950 border-neutral-800'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px] text-neutral-400">
                      <span className="flex items-center gap-2">
                        <span className="text-neutral-500">{time}</span>
                        {evt.modelId && (
                          <span className="text-amber-300 font-bold">[{evt.modelId}]</span>
                        )}
                        {evt.filePath && (
                          <span className="text-neutral-300 font-semibold">{evt.filePath}</span>
                        )}
                      </span>

                      <span className={`text-[10px] uppercase font-bold ${
                        isConflict ? 'text-amber-400' : isCreated ? 'text-cyan-400' : isLeased ? 'text-purple-400' : 'text-emerald-400'
                      }`}>
                        {evt.type}
                      </span>
                    </div>

                    <p className="mt-1.5 text-neutral-200 text-[11px] leading-relaxed break-words">
                      {evt.details}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
