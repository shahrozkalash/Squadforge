import React from 'react';
import { useSwarm } from '../context/SwarmContext.js';
import { 
  Square, 
  RotateCcw, 
  Github, 
  ExternalLink, 
  Clock, 
  CheckCircle2, 
  AlertTriangle, 
  Cpu, 
  Layers, 
  Radio, 
  Terminal,
  Activity,
  Zap,
  ArrowRight
} from 'lucide-react';
import { Task, SwarmEvent, ModelRunStatus, ModelConfig } from '../types/index.js';

interface LiveSwarmViewProps {
  onViewCode: () => void;
}

export const LiveSwarmView: React.FC<LiveSwarmViewProps> = ({ onViewCode }) => {
  const { 
    activeBuild, 
    tasks, 
    events, 
    modelRuns, 
    allModels, 
    stopBuild, 
    retryFailedTasks, 
    pushToGitHub 
  } = useSwarm();

  if (!activeBuild) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-20 text-center space-y-4">
        <Radio className="w-10 h-10 text-neutral-600 mx-auto" />
        <h3 className="text-lg font-semibold text-white">No Active Swarm Execution</h3>
        <p className="text-xs text-neutral-400">
          Navigate to the Idea Forge tab to define a software specification and launch all 10 AI models.
        </p>
      </div>
    );
  }

  // Calculate task progress
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.status === 'done').length;
  const claimedTasks = tasks.filter(t => t.status === 'claimed').length;
  const openTasks = tasks.filter(t => t.status === 'open').length;
  const failedTasks = tasks.filter(t => t.status === 'failed').length;
  const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const isRunning = activeBuild.status === 'running' || activeBuild.status === 'planning' || activeBuild.status === 'verifying';

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      {/* Top Banner: Status, Idea, Controls */}
      <div className="p-5 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4 shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded border uppercase ${
                activeBuild.status === 'completed'
                  ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                  : activeBuild.status === 'failed' || activeBuild.status === 'stopped'
                  ? 'bg-rose-500/20 text-rose-400 border-rose-500/30'
                  : 'bg-amber-500/20 text-amber-400 border-amber-500/30 animate-pulse'
              }`}>
                {activeBuild.status}
              </span>
              <span className="text-xs font-mono text-neutral-400">
                ID: {activeBuild.id}
              </span>
              <span className="text-xs text-neutral-500">·</span>
              <span className="text-xs font-mono text-neutral-400">
                Cost: ${(activeBuild.totalCost || 0).toFixed(4)} / ${activeBuild.costLimit.toFixed(2)}
              </span>
            </div>
            <h2 className="text-lg font-bold text-white font-sans line-clamp-2">
              "{activeBuild.idea}"
            </h2>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {isRunning && (
              <button
                onClick={() => stopBuild()}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg hover:bg-rose-500/20 transition-colors"
              >
                <Square className="w-3.5 h-3.5 fill-rose-400" />
                <span>Emergency STOP</span>
              </button>
            )}

            {failedTasks > 0 && (
              <button
                onClick={() => retryFailedTasks()}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg hover:bg-amber-500/20 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Retry Failed ({failedTasks})</span>
              </button>
            )}

            <button
              onClick={onViewCode}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-neutral-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors"
            >
              <span>Explore Code & Diff</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* GitHub Auto-Push Link if complete */}
        {activeBuild.githubRepoUrl && (
          <div className="p-3 bg-neutral-950 border border-emerald-500/30 rounded-lg flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-emerald-400">
              <Github className="w-4 h-4" />
              <span>Project pushed to GitHub:</span>
              <a 
                href={activeBuild.githubRepoUrl} 
                target="_blank" 
                rel="noreferrer"
                className="font-mono text-emerald-300 underline hover:text-white flex items-center gap-1"
              >
                {activeBuild.githubRepoUrl}
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <span className="text-[11px] font-mono text-neutral-400">Auto-push verified</span>
          </div>
        )}

        {/* Progress Bar */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs font-mono text-neutral-400">
            <span className="flex items-center gap-2">
              <span>Task Board Completion</span>
              <span className="text-white font-semibold">({completedTasks}/{totalTasks} Done)</span>
            </span>
            <span className="text-amber-400 font-bold">{progressPercent}%</span>
          </div>
          <div className="w-full h-2 bg-neutral-950 rounded-full overflow-hidden border border-neutral-800">
            <div 
              className="h-full bg-gradient-to-r from-amber-500 to-emerald-400 transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      </div>

      {/* 10+ AI Models Worker Cards Grid */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-mono text-neutral-400 uppercase tracking-wider">
            <Cpu className="w-3.5 h-3.5 text-cyan-400" />
            <span>Active Worker Swarm ({activeBuild.selectedModels.length} Concurrent Models)</span>
          </div>
          <span className="text-xs text-neutral-500 font-mono">
            Autonomous Promise.all workers
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {activeBuild.selectedModels.map(modelId => {
            const config = allModels.find(m => m.id === modelId);
            const run = modelRuns.find(r => r.modelId === modelId);
            const currentTask = tasks.find(t => t.id === run?.currentTaskId);

            const status = run?.status || 'idle';
            const statusColor = 
              status === 'working' || status === 'patching' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
              status === 'claiming' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' :
              status === 'retrying' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30' :
              status === 'done' ? 'bg-blue-500/10 text-blue-400 border-blue-500/30' :
              status === 'failed' ? 'bg-rose-500/10 text-rose-400 border-rose-500/30' :
              'bg-neutral-800/60 text-neutral-400 border-neutral-700/50';

            return (
              <div 
                key={modelId}
                className="p-3.5 bg-neutral-900 border border-neutral-800 rounded-lg flex flex-col justify-between space-y-2 hover:border-neutral-700 transition-colors"
              >
                <div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-bold text-white font-sans truncate">
                      {config?.displayName || modelId}
                    </span>
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border capitalize ${statusColor}`}>
                      {status}
                    </span>
                  </div>

                  <div className="text-[11px] font-mono text-neutral-400 mt-1 line-clamp-2 h-7">
                    {currentTask ? currentTask.title : (run?.lastActionSummary || 'Ready for next task')}
                  </div>
                </div>

                <div className="pt-2 border-t border-neutral-800/80 flex items-center justify-between text-[11px] font-mono text-neutral-400">
                  <span>{run?.patchesApplied || 0} patches</span>
                  <span>${(run?.estimatedCost || 0).toFixed(3)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Living Task Board & Activity Feed (2 Column Split) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Living Task Board */}
        <div className="p-5 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4 shadow-lg">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-semibold text-white">Living Task Board</h3>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono text-neutral-400">
              <span className="text-emerald-400">{completedTasks} Done</span>
              <span>·</span>
              <span className="text-amber-400">{claimedTasks} Claimed</span>
              <span>·</span>
              <span className="text-neutral-300">{openTasks} Open</span>
            </div>
          </div>

          <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
            {tasks.map((task) => {
              const isClaimed = task.status === 'claimed';
              const isDone = task.status === 'done';
              const isFix = task.isFixTask;

              return (
                <div 
                  key={task.id}
                  className={`p-3 rounded-lg border text-xs transition-colors ${
                    isDone 
                      ? 'bg-neutral-950/40 border-neutral-800/60 opacity-60' 
                      : isClaimed 
                      ? 'bg-neutral-950 border-amber-500/30' 
                      : isFix 
                      ? 'bg-rose-950/20 border-rose-500/40' 
                      : 'bg-neutral-950 border-neutral-800 hover:border-neutral-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        {isFix && (
                          <span className="text-[10px] font-mono font-bold px-1.5 py-0.2 bg-rose-500/20 text-rose-300 border border-rose-500/30 rounded">
                            FIX TASK (P1)
                          </span>
                        )}
                        <span className={`font-medium ${isDone ? 'line-through text-neutral-400' : 'text-neutral-200'}`}>
                          {task.title}
                        </span>
                      </div>
                      <p className="text-[11px] text-neutral-400 line-clamp-2">
                        {task.description}
                      </p>
                    </div>

                    <div className="shrink-0 text-right space-y-0.5">
                      <span className={`inline-block text-[10px] font-mono px-1.5 py-0.5 rounded border capitalize ${
                        isDone ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                        isClaimed ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                        'bg-neutral-800 text-neutral-400 border-neutral-700'
                      }`}>
                        {task.status}
                      </span>
                      {task.claimedBy && (
                        <div className="text-[10px] font-mono text-neutral-400">
                          by @{task.claimedBy}
                        </div>
                      )}
                    </div>
                  </div>

                  {task.filePaths && task.filePaths.length > 0 && (
                    <div className="mt-2 pt-1.5 border-t border-neutral-800/60 flex items-center gap-1 text-[11px] font-mono text-neutral-400">
                      <span>Files:</span>
                      <span className="text-neutral-300 truncate">{task.filePaths.join(', ')}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Real-Time Activity Feed */}
        <div className="p-5 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4 shadow-lg">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-semibold text-white">Live Swarm Activity Stream</h3>
            </div>
            <span className="text-xs font-mono text-neutral-400">
              {events.length} actions logged
            </span>
          </div>

          <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1 font-mono text-xs">
            {events.slice().reverse().map((evt) => {
              const timeStr = new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              
              const typeIcon = 
                evt.type === 'patch_applied' ? 'text-emerald-400' :
                evt.type === 'patch_rejected' ? 'text-amber-400' :
                evt.type === 'file_created' ? 'text-cyan-400' :
                evt.type === 'sandbox_check' ? 'text-blue-400' :
                evt.type === 'checkpoint_saved' ? 'text-purple-400' :
                evt.type === 'github_pushed' ? 'text-emerald-300' :
                'text-neutral-400';

              return (
                <div 
                  key={evt.id}
                  className="p-2.5 rounded bg-neutral-950 border border-neutral-800/80 hover:border-neutral-700 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] text-neutral-400">
                    <span className="flex items-center gap-1.5">
                      <span className="text-neutral-400">{timeStr}</span>
                      {evt.modelId && (
                        <span className="text-amber-300 font-semibold">[{evt.modelId}]</span>
                      )}
                    </span>
                    <span className={`text-[10px] uppercase ${typeIcon}`}>{evt.type}</span>
                  </div>
                  <p className="text-neutral-200 mt-1 text-[11px] leading-relaxed break-words">
                    {evt.details}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
