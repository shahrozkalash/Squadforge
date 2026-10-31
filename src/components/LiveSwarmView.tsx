import React, { useState } from 'react';
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
  ArrowRight,
  Play,
  ShieldAlert,
  ShieldCheck,
  TestTube,
  Check,
  FileCode,
  GitBranch,
  GitPullRequest
} from 'lucide-react';
import { Task, SwarmEvent, ModelRunStatus, ModelConfig, AgentRole } from '../types/index.js';

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
    resumeBuild,
    retryFailedTasks, 
    pushToGitHub 
  } = useSwarm();

  const [isPushing, setIsPushing] = useState(false);
  const [pushStatus, setPushStatus] = useState<string | null>(null);

  if (!activeBuild) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-20 text-center space-y-4">
        <Radio className="w-10 h-10 text-neutral-600 mx-auto" />
        <h3 className="text-lg font-semibold text-white">No Active Swarm Execution</h3>
        <p className="text-xs text-neutral-400">
          Navigate to the Idea Forge tab to define a software specification and launch your autonomous engineering team.
        </p>
      </div>
    );
  }

  // Calculate task counts
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.status === 'completed' || t.status === 'done').length;
  const inProgressTasks = tasks.filter(t => t.status === 'in_progress' || t.status === 'claimed' || t.status === 'testing').length;
  const pendingTasks = tasks.filter(t => t.status === 'pending' || t.status === 'open' || t.status === 'retrying').length;
  const failedTasks = tasks.filter(t => t.status === 'failed').length;
  const pausedTasks = tasks.filter(t => t.status === 'paused' || t.isPaused).length;
  const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const isRunning = activeBuild.status === 'running' || activeBuild.status === 'planning' || activeBuild.status === 'verifying';
  const isStoppedOrFailed = activeBuild.status === 'stopped' || activeBuild.status === 'failed';
  const isComplete = activeBuild.status === 'completed';

  const handleManualPush = async () => {
    setIsPushing(true);
    setPushStatus(null);
    const res = await pushToGitHub();
    setIsPushing(false);
    if (res.success) {
      setPushStatus(`Pushed to ${res.branch || 'feature/autonomous-development-team'}`);
    } else {
      setPushStatus(res.error || 'Push failed');
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      {/* Top Banner: Status, Idea, Controls */}
      <div className="p-5 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4 shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded border uppercase ${
                isComplete
                  ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                  : isStoppedOrFailed
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
              {activeBuild.techStack && (
                <>
                  <span className="text-xs text-neutral-500">·</span>
                  <span className="text-xs font-mono text-purple-400">
                    {activeBuild.techStack.frontend.split(' ')[0]} + {activeBuild.techStack.backend.split(' ')[0]}
                  </span>
                </>
              )}
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
                <span>Pause Swarm</span>
              </button>
            )}

            {isStoppedOrFailed && (
              <button
                onClick={() => resumeBuild()}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/20 transition-colors"
              >
                <Play className="w-3.5 h-3.5 fill-emerald-400" />
                <span>Resume Swarm</span>
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

        {/* GitHub Feature Branch & Pull Request Status */}
        {activeBuild.githubRepoUrl ? (
          <div className="p-3 bg-neutral-950 border border-emerald-500/30 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-emerald-400">
              <GitPullRequest className="w-4 h-4 shrink-0" />
              <span>Branch & Pull Request:</span>
              <a 
                href={activeBuild.pullRequestUrl || activeBuild.githubRepoUrl} 
                target="_blank" 
                rel="noreferrer"
                className="font-mono text-emerald-300 underline hover:text-white flex items-center gap-1 truncate"
              >
                <span>{activeBuild.gitBranch || 'feature/autonomous-development-team'}</span>
                <ExternalLink className="w-3 h-3 shrink-0" />
              </a>
            </div>
            <div className="text-[11px] font-mono text-neutral-400 flex items-center gap-2">
              <span className="text-emerald-400 flex items-center gap-1">
                <Check className="w-3 h-3 stroke-[3]" /> Never pushes to main directly
              </span>
            </div>
          </div>
        ) : isComplete && (
          <div className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg flex items-center justify-between text-xs">
            <span className="text-neutral-400">Project ready to push to GitHub feature branch:</span>
            <button
              onClick={handleManualPush}
              disabled={isPushing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded hover:bg-emerald-500/20 transition-colors"
            >
              <Github className="w-3.5 h-3.5" />
              <span>{isPushing ? 'Pushing...' : 'Create Pull Request'}</span>
            </button>
          </div>
        )}

        {pushStatus && (
          <div className="text-xs font-mono text-amber-300 px-1">
            {pushStatus}
          </div>
        )}

        {/* Progress Bar */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs font-mono text-neutral-400">
            <span className="flex items-center gap-2">
              <span>Milestone & Task Board Completion</span>
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

      {/* Tripartite Verification Status Dashboard */}
      {activeBuild.verificationReport && (
        <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-xl space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-neutral-800">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-white">
                Tripartite Verification Status
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-[10px] font-mono uppercase font-bold px-2 py-0.5 rounded border ${
                activeBuild.verificationReport.verdict === 'verified'
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                  : activeBuild.verificationReport.verdict === 'partially_verified'
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                  : 'bg-rose-500/20 text-rose-300 border-rose-500/30'
              }`}>
                Verdict: {activeBuild.verificationReport.verdict}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* 1. Compilation Status */}
            <div className="p-3 bg-neutral-950 border border-neutral-800/80 rounded-lg space-y-1.5 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="text-neutral-400 font-semibold">1. Compilation</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border uppercase ${
                  (typeof activeBuild.verificationReport.compilationStatus === 'object' 
                    ? activeBuild.verificationReport.compilationStatus.status === 'passed'
                    : activeBuild.verificationReport.compilationStatus === 'passed')
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                    : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                }`}>
                  {typeof activeBuild.verificationReport.compilationStatus === 'object'
                    ? activeBuild.verificationReport.compilationStatus.status || 'passed'
                    : activeBuild.verificationReport.compilationStatus || 'passed'}
                </span>
              </div>
              <p className="text-[11px] text-neutral-400">
                {activeBuild.verificationReport.syntaxChecksPassed 
                  ? 'Syntax and TypeScript AST contracts verified cleanly.'
                  : 'Compilation errors detected in project workspace.'}
              </p>
            </div>

            {/* 2. Runtime Status */}
            <div className="p-3 bg-neutral-950 border border-neutral-800/80 rounded-lg space-y-1.5 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="text-neutral-400 font-semibold">2. Runtime</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border uppercase ${
                  (typeof activeBuild.verificationReport.runtimeStatus === 'object'
                    ? activeBuild.verificationReport.runtimeStatus.status === 'passed'
                    : activeBuild.verificationReport.runtimeStatus === 'passed')
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                    : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                }`}>
                  {typeof activeBuild.verificationReport.runtimeStatus === 'object'
                    ? activeBuild.verificationReport.runtimeStatus.status || 'passed'
                    : activeBuild.verificationReport.runtimeStatus || 'passed'}
                </span>
              </div>
              <p className="text-[11px] text-neutral-400">
                Mode: {activeBuild.verificationReport.previewMode || 'real_application'} · DOM mounted & interactive
              </p>
            </div>

            {/* 3. Functional Status */}
            <div className="p-3 bg-neutral-950 border border-neutral-800/80 rounded-lg space-y-1.5 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="text-neutral-400 font-semibold">3. Functional</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border uppercase ${
                  (typeof activeBuild.verificationReport.functionalStatus === 'object'
                    ? activeBuild.verificationReport.functionalStatus.status === 'passed'
                    : activeBuild.verificationReport.functionalStatus === 'passed')
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                    : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                }`}>
                  {typeof activeBuild.verificationReport.functionalStatus === 'object'
                    ? activeBuild.verificationReport.functionalStatus.status || 'partial'
                    : activeBuild.verificationReport.functionalStatus || 'partial'}
                </span>
              </div>
              <p className="text-[11px] text-neutral-400">
                {typeof activeBuild.verificationReport.functionalStatus === 'object'
                  ? (activeBuild.verificationReport.functionalStatus.details || 'Navigation, forms, responsive UI & API checks')
                  : 'Navigation, forms, responsive layout, API verified.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Test & Security Audit Summary Bar */}
      {(activeBuild.testReport || activeBuild.securityAudit) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Automated Tests Result */}
          <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                <TestTube className="w-4 h-4 text-cyan-400" />
                <span>QA & Automated Test Verification</span>
              </span>
              <span className="text-xs font-mono text-cyan-300">
                {activeBuild.testReport?.passed || 0}/{activeBuild.testReport?.total || 0} Passed
              </span>
            </div>
            <div className="text-[11px] text-neutral-400 font-mono">
              {activeBuild.testReport?.failed === 0 
                ? 'All unit tests and assertion checks passing cleanly.' 
                : `${activeBuild.testReport?.failed} test failure(s) being analyzed by Debugging Agent.`}
            </div>
          </div>

          {/* Security Audit Result */}
          <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>Security Agent Audit</span>
              </span>
              <span className="text-xs font-mono text-emerald-300">
                Score: {activeBuild.securityAudit?.score || 100}/100
              </span>
            </div>
            <div className="text-[11px] text-neutral-400 font-mono">
              {activeBuild.securityAudit?.findings.length === 0
                ? 'No secret exposure or high-severity OWASP vulnerabilities detected.'
                : `${activeBuild.securityAudit?.findings.length} security finding(s) reviewed.`}
            </div>
          </div>
        </div>
      )}

      {/* 10 Specialized AI Agents Dashboard */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-mono text-neutral-400 uppercase tracking-wider">
            <Cpu className="w-3.5 h-3.5 text-cyan-400" />
            <span>Autonomous Development Team ({activeBuild.selectedModels.length} Concurrent Agents)</span>
          </div>
          <span className="text-xs text-neutral-500 font-mono">
            Specialized Roles: PM, Architect, Frontend, Backend, DB, QA, Debug, Sec, Ops, Int
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
              status === 'testing' ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30' :
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
                    <div className="flex items-center gap-1.5 truncate">
                      <span className={`text-[10px] font-mono font-bold px-1.5 py-0.2 rounded border ${config?.avatarColor || 'border-neutral-700 text-neutral-300'}`}>
                        {config?.badge || modelId.slice(0, 3)}
                      </span>
                      <span className="text-xs font-bold text-white font-sans truncate">
                        {config?.displayName || modelId}
                      </span>
                    </div>
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border capitalize ${statusColor}`}>
                      {status}
                    </span>
                  </div>

                  <div className="text-[11px] font-mono text-neutral-400 mt-2 line-clamp-2 h-7">
                    {currentTask ? currentTask.title : (run?.lastActionSummary || 'Ready for next dependency-unlocked task')}
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

      {/* Living Task Board & Activity Stream */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Living Task Board & Milestones */}
        <div className="p-5 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4 shadow-lg">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-semibold text-white">Milestone & Task Tracker</h3>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono text-neutral-400">
              <span className="text-emerald-400">{completedTasks} Done</span>
              <span>·</span>
              <span className="text-amber-400">{inProgressTasks} In Progress</span>
              <span>·</span>
              <span className="text-neutral-300">{pendingTasks} Pending</span>
            </div>
          </div>

          <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
            {tasks.map((task) => {
              const isDone = task.status === 'completed' || task.status === 'done';
              const isInProgress = task.status === 'in_progress' || task.status === 'claimed' || task.status === 'testing';
              const isFix = task.isFixTask;
              const hasDeps = task.dependencies && task.dependencies.length > 0;

              return (
                <div 
                  key={task.id}
                  className={`p-3 rounded-lg border text-xs transition-colors ${
                    isDone 
                      ? 'bg-neutral-950/40 border-neutral-800/60 opacity-60' 
                      : isInProgress 
                      ? 'bg-neutral-950 border-amber-500/30' 
                      : isFix 
                      ? 'bg-rose-950/20 border-rose-500/40' 
                      : 'bg-neutral-950 border-neutral-800 hover:border-neutral-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {isFix && (
                          <span className="text-[10px] font-mono font-bold px-1.5 py-0.2 bg-rose-500/20 text-rose-300 border border-rose-500/30 rounded">
                            FIX TASK (P1)
                          </span>
                        )}
                        {task.assignedRole && (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded">
                            {task.assignedRole.replace('_', ' ')}
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
                        isInProgress ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                        'bg-neutral-800 text-neutral-400 border-neutral-700'
                      }`}>
                        {task.status}
                      </span>
                      {task.claimedBy && (
                        <div className="text-[10px] font-mono text-neutral-400">
                          @{task.claimedBy}
                        </div>
                      )}
                    </div>
                  </div>

                  {hasDeps && (
                    <div className="mt-2 pt-1 border-t border-neutral-800/60 flex items-center gap-1 text-[10px] font-mono text-neutral-500">
                      <span>Depends on: {task.dependencies?.join(', ')}</span>
                    </div>
                  )}

                  {task.filePaths && task.filePaths.length > 0 && (
                    <div className="mt-1 flex items-center gap-1 text-[11px] font-mono text-neutral-400">
                      <span>Files:</span>
                      <span className="text-neutral-300 truncate">{task.filePaths.join(', ')}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Real-Time Activity Stream */}
        <div className="p-5 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4 shadow-lg">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-semibold text-white">Autonomous Event Log</h3>
            </div>
            <span className="text-xs font-mono text-neutral-400">
              {events.length} actions logged
            </span>
          </div>

          <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1 font-mono text-xs">
            {events.slice().reverse().map((evt) => {
              const timeStr = new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              
              const typeIcon = 
                evt.type === 'patch_applied' ? 'text-emerald-400' :
                evt.type === 'patch_rejected' ? 'text-amber-400' :
                evt.type === 'file_created' ? 'text-cyan-400' :
                evt.type === 'sandbox_check' ? 'text-blue-400' :
                evt.type === 'checkpoint_saved' ? 'text-purple-400' :
                evt.type === 'milestone_reached' ? 'text-amber-300 font-bold' :
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
