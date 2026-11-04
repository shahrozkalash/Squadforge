import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSwarm } from '../context/SwarmContext.js';
import {
  DependencyInstallRecord,
  ExecutionLogEntry,
  ExecutionSession,
  HumanApprovalRequest
} from '../types/index.js';
import {
  AlertTriangle,
  Box,
  ExternalLink,
  Globe,
  History,
  Package,
  Play,
  RefreshCw,
  ShieldAlert,
  Square,
  Terminal,
  Trash2
} from 'lucide-react';

interface Capabilities {
  capabilities: { available: boolean; backend: string; reason?: string; runtime?: string };
  previewsEnabled: boolean;
  project: {
    ecosystem: string;
    packageManager: string | null;
    supported: boolean;
    hasLockfile: boolean;
    hasDependencies: boolean;
    scripts: Record<string, string>;
    reason?: string;
  };
}

interface Usage {
  memoryBytes: number;
  memoryLimitBytes: number;
  cpuPercent: number;
  pids: number;
  workspaceBytes: number;
}

const RUNNABLE_SCRIPTS = ['dev', 'start', 'build', 'test', 'preview'];
const BUSY_STATES = new Set(['creating', 'installing', 'starting', 'running', 'stopping']);
const POLL_MS = 1500;

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

export const ExecutionView: React.FC = () => {
  const { activeBuild } = useSwarm();
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [sessions, setSessions] = useState<ExecutionSession[]>([]);
  const [session, setSession] = useState<ExecutionSession | null>(null);
  const [installs, setInstalls] = useState<DependencyInstallRecord[]>([]);
  const [logs, setLogs] = useState<ExecutionLogEntry[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [approval, setApproval] = useState<HumanApprovalRequest | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastLogId = useRef(0);
  const logEnd = useRef<HTMLDivElement | null>(null);

  const root = activeBuild ? `/api/builds/${activeBuild.id}/execution` : null;
  const sessionId = session?.id;

  const refreshSessions = useCallback(async () => {
    if (!root) return;
    const { sessions: list } = await request<{ sessions: ExecutionSession[] }>(`${root}/sessions`);
    setSessions(list);
    setSession(current => {
      if (current) return list.find(item => item.id === current.id) || current;
      return list.find(item => item.status !== 'destroyed' && item.status !== 'failed') || null;
    });
  }, [root]);

  useEffect(() => {
    setSession(null);
    setLogs([]);
    setApproval(null);
    setPreviewUrl(null);
    setPreviewId(null);
    lastLogId.current = 0;
    if (!root) return;
    request<Capabilities>(`${root}/capabilities`).then(setCapabilities).catch(err => setError(err.message));
    refreshSessions().catch(err => setError(err.message));
  }, [root, refreshSessions]);

  useEffect(() => {
    if (!root || !sessionId) return;
    lastLogId.current = 0;
    setLogs([]);

    const poll = async () => {
      const [details, { logs: added }, { usage: current }] = await Promise.all([
        request<{ session: ExecutionSession; installs: DependencyInstallRecord[] }>(`${root}/sessions/${sessionId}`),
        request<{ logs: ExecutionLogEntry[] }>(`${root}/sessions/${sessionId}/logs?after=${lastLogId.current}`),
        request<{ usage: Usage | null }>(`${root}/sessions/${sessionId}/usage`)
      ]);
      setSession(details.session);
      setInstalls(details.installs);
      setUsage(current);
      if (added.length > 0) {
        lastLogId.current = added[added.length - 1].id;
        setLogs(existing => [...existing, ...added]);
      }
      if (details.session.status !== 'running') {
        setPreviewUrl(null);
        setPreviewId(null);
      }
    };

    poll().catch(err => setError(err.message));
    const timer = setInterval(() => poll().catch(() => undefined), POLL_MS);
    return () => clearInterval(timer);
  }, [root, sessionId]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [logs.length]);

  const run = async (name: string, action: () => Promise<void>) => {
    setPendingAction(name);
    setError(null);
    try {
      await action();
      await refreshSessions();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPendingAction(null);
    }
  };

  const applyResult = (result: any) => {
    if (result.approvalRequired) setApproval(result.approvalRequired);
    else if (result.id) setSession(result);
  };

  const createSession = () => run('create', async () => {
    applyResult(await request(`${root}/sessions`, 'POST'));
  });

  const install = (allowScripts = false) => run('install', async () => {
    applyResult(await request(`${root}/sessions/${sessionId}/dependencies`, 'POST', { allowScripts }));
  });

  const startScript = (script: string) => run(`start:${script}`, async () => {
    applyResult(await request(`${root}/sessions/${sessionId}/start`, 'POST', { script }));
  });

  const stop = () => run('stop', async () => {
    applyResult(await request(`${root}/sessions/${sessionId}/stop`, 'POST'));
  });

  const restart = () => run('restart', async () => {
    setPreviewUrl(null);
    setPreviewId(null);
    applyResult(await request(`${root}/sessions/${sessionId}/restart`, 'POST'));
  });

  const destroy = () => run('destroy', async () => {
    await request(`${root}/sessions/${sessionId}`, 'DELETE');
    setSession(null);
    setPreviewUrl(null);
    setPreviewId(null);
  });

  const openPreview = () => run('preview', async () => {
    const result = await request<{ previewId: string; url: string }>(`${root}/sessions/${sessionId}/preview`, 'POST');
    setPreviewId(result.previewId);
    setPreviewUrl(result.url);
  });

  const reloadPreview = () => run('reload', async () => {
    const result = await request<{ url: string }>(`${root}/previews/${previewId}/link`, 'POST');
    setPreviewUrl(result.url);
  });

  const closePreview = () => run('close-preview', async () => {
    await request(`${root}/previews/${previewId}`, 'DELETE');
    setPreviewUrl(null);
    setPreviewId(null);
  });

  const decide = (approved: boolean) => run('approval', async () => {
    await request(
      `/api/builds/${activeBuild!.id}/collaboration/approvals/${approval!.id}/respond`,
      'POST',
      { approved }
    );
    setApproval(null);
  });

  if (!activeBuild) {
    return <div className="p-8 text-neutral-400">Select a project to run it.</div>;
  }

  const available = capabilities?.capabilities.available;
  const busy = session ? BUSY_STATES.has(session.status) : false;
  const ready = session?.status === 'ready';
  const running = session?.status === 'running';
  const scripts = RUNNABLE_SCRIPTS.filter(name => capabilities?.project.scripts[name]);
  const button = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-neutral-700 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <Box className="w-5 h-5 text-amber-400" /> Run project
          </h1>
          <p className="text-sm text-neutral-400">
            {available
              ? `Sandbox: ${capabilities?.capabilities.backend} (${capabilities?.capabilities.runtime})`
              : capabilities?.capabilities.reason || 'Checking the execution environment…'}
          </p>
        </div>
        {session && (
          <span className="text-sm px-2.5 py-1 rounded-full border border-neutral-700 text-neutral-200">
            {session.status}
          </span>
        )}
      </header>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {capabilities && !capabilities.project.supported && capabilities.project.reason && (
        <div className="rounded-md border border-amber-900 bg-amber-950/30 p-3 text-sm text-amber-200">
          {capabilities.project.reason}
        </div>
      )}

      {approval && (
        <section className="rounded-md border border-amber-800 bg-amber-950/30 p-4 space-y-3">
          <h2 className="text-sm font-medium text-amber-200 flex items-center gap-2">
            <ShieldAlert className="w-4 h-4" /> Your approval is needed
          </h2>
          <p className="text-sm text-neutral-200">{approval.explanation}</p>
          <p className="text-xs text-neutral-400">
            This covers the current version of the project only. If the code changes, you will be asked again.
          </p>
          <div className="flex gap-2">
            <button className={button} disabled={pendingAction !== null} onClick={() => decide(true)}>Approve</button>
            <button className={button} disabled={pendingAction !== null} onClick={() => decide(false)}>Reject</button>
          </div>
        </section>
      )}

      <section className="flex flex-wrap items-center gap-2">
        {(!session || session.status === 'destroyed' || session.status === 'failed') && (
          <button className={button} disabled={!available || pendingAction !== null} onClick={createSession}>
            <Box className="w-4 h-4" /> Create environment
          </button>
        )}
        {session && (
          <>
            <button
              className={button}
              disabled={!ready || !capabilities?.project.hasDependencies || pendingAction !== null}
              onClick={() => install()}
            >
              <Package className="w-4 h-4" /> Install dependencies
            </button>
            {scripts.map(script => (
              <button key={script} className={button} disabled={!ready || pendingAction !== null} onClick={() => startScript(script)}>
                <Play className="w-4 h-4" /> {script}
              </button>
            ))}
            <button className={button} disabled={!busy || pendingAction !== null} onClick={stop}>
              <Square className="w-4 h-4" /> Stop
            </button>
            <button className={button} disabled={!session.script || session.status === 'destroyed' || pendingAction !== null} onClick={restart}>
              <RefreshCw className="w-4 h-4" /> Restart
            </button>
            <button className={button} disabled={!running || !capabilities?.previewsEnabled || pendingAction !== null} onClick={openPreview}>
              <Globe className="w-4 h-4" /> Open preview
            </button>
            <button className={button} disabled={session.status === 'destroyed' || pendingAction !== null} onClick={destroy}>
              <Trash2 className="w-4 h-4" /> Delete environment
            </button>
          </>
        )}
      </section>

      {session && (
        <section className="grid grid-cols-2 lg:grid-cols-5 gap-3 text-sm">
          <Stat label="Dependencies" value={session.dependencyStatus.replace('_', ' ')} />
          <Stat label="Last result" value={session.endReason ? `${session.endReason} (${session.exitCode ?? '–'})` : 'None yet'} />
          <Stat label="Memory" value={usage ? `${megabytes(usage.memoryBytes)} of ${megabytes(usage.memoryLimitBytes)}` : 'Not running'} />
          <Stat label="CPU" value={usage ? `${usage.cpuPercent.toFixed(1)}%` : 'Not running'} />
          <Stat label="Workspace" value={usage ? megabytes(usage.workspaceBytes) : 'Not running'} />
        </section>
      )}

      {session?.failureReason && (
        <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">{session.failureReason}</div>
      )}

      {session && session.missingDependencies.length > 0 && (
        <div className="rounded-md border border-amber-900 bg-amber-950/30 p-3 text-sm text-amber-200">
          Missing packages: {session.missingDependencies.join(', ')}
        </div>
      )}

      {session && installs.length > 0 && installs[0].error && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">
          <span>{installs[0].error}</span>
          <button className={button} disabled={!ready || pendingAction !== null} onClick={() => install(true)}>
            Retry with install scripts
          </button>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <section className="rounded-md border border-neutral-800 bg-black flex flex-col h-[28rem]">
          <h2 className="px-3 py-2 border-b border-neutral-800 text-sm text-neutral-300 flex items-center gap-2">
            <Terminal className="w-4 h-4" /> Output
          </h2>
          <div className="flex-1 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap break-words">
            {logs.length === 0 && <span className="text-neutral-600">No output yet.</span>}
            {logs.map(entry => (
              <span
                key={entry.id}
                className={entry.stream === 'stderr' ? 'text-red-300' : entry.stream === 'system' ? 'text-amber-300' : 'text-neutral-200'}
              >
                {entry.text}
              </span>
            ))}
            <div ref={logEnd} />
          </div>
        </section>

        <section className="rounded-md border border-neutral-800 flex flex-col h-[28rem]">
          <div className="px-3 py-2 border-b border-neutral-800 text-sm text-neutral-300 flex items-center justify-between gap-2">
            <span className="flex items-center gap-2"><Globe className="w-4 h-4" /> Preview</span>
            {previewUrl && (
              <span className="flex gap-2">
                <button className={button} disabled={pendingAction !== null} onClick={reloadPreview}>
                  <RefreshCw className="w-3 h-3" /> Reload
                </button>
                <button className={button} disabled={pendingAction !== null} onClick={closePreview}>Close</button>
              </span>
            )}
          </div>
          {previewUrl ? (
            <iframe title="Project preview" src={previewUrl} className="flex-1 w-full bg-white" sandbox="allow-scripts allow-forms allow-same-origin allow-modals" />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-neutral-500 p-4 text-center">
              {capabilities?.previewsEnabled
                ? 'Start a development server, then open the preview.'
                : 'Previews need a dedicated preview domain on this server.'}
            </div>
          )}
        </section>
      </div>

      <section className="rounded-md border border-neutral-800">
        <h2 className="px-3 py-2 border-b border-neutral-800 text-sm text-neutral-300 flex items-center gap-2">
          <History className="w-4 h-4" /> History
        </h2>
        {sessions.length === 0 ? (
          <p className="p-3 text-sm text-neutral-500">No runs yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-800">
            {sessions.map(item => (
              <li key={item.id}>
                <button
                  className="w-full text-left px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-900 flex flex-wrap gap-x-4"
                  onClick={() => setSession(item)}
                >
                  <span>{new Date(item.createdAt).toLocaleString()}</span>
                  <span>{item.status}</span>
                  <span>{item.script || 'No script run'}</span>
                  <span>{item.endReason ? `${item.endReason} (${item.exitCode ?? '–'})` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-md border border-neutral-800 p-3">
    <div className="text-xs text-neutral-500">{label}</div>
    <div className="text-neutral-100 mt-0.5">{value}</div>
  </div>
);
