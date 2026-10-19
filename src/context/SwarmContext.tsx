import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { 
  Build, 
  Task, 
  ProjectFile, 
  SwarmEvent, 
  ModelRunStatus, 
  Checkpoint, 
  ModelConfig 
} from '../types/index.js';

interface SwarmContextType {
  activeBuild: Build | null;
  tasks: Task[];
  files: ProjectFile[];
  events: SwarmEvent[];
  modelRuns: ModelRunStatus[];
  checkpoints: Checkpoint[];
  allModels: ModelConfig[];
  selectedFile: ProjectFile | null;
  setSelectedFile: (file: ProjectFile | null) => void;
  startBuild: (idea: string, selectedModels: string[], autoPush: boolean, costLimit: number) => Promise<string | null>;
  stopBuild: () => Promise<void>;
  retryFailedTasks: () => Promise<void>;
  pushToGitHub: () => Promise<{ success: boolean; repoUrl?: string; error?: string }>;
  rollbackToCheckpoint: (checkpointId: string) => Promise<boolean>;
  rollbackFile: (filePath: string, version: number) => Promise<boolean>;
  exportProjectZip: () => Promise<void>;
  fetchBuildDetails: (buildId: string) => Promise<void>;
  refreshModels: () => Promise<void>;
}

const SwarmContext = createContext<SwarmContextType | undefined>(undefined);

export const SwarmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeBuild, setActiveBuild] = useState<Build | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [events, setEvents] = useState<SwarmEvent[]>([]);
  const [modelRuns, setModelRuns] = useState<ModelRunStatus[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [allModels, setAllModels] = useState<ModelConfig[]>([]);
  const [selectedFile, setSelectedFile] = useState<ProjectFile | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);

  // Fetch model registry
  const refreshModels = async () => {
    try {
      const res = await fetch('/api/models');
      if (res.ok) {
        const data = await res.json();
        setAllModels(data.models || []);
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
    }
  };

  useEffect(() => {
    refreshModels();
  }, []);

  // Fetch details of a specific build
  const fetchBuildDetails = async (buildId: string) => {
    try {
      const res = await fetch(`/api/builds/${buildId}`);
      if (res.ok) {
        const data = await res.json();
        setActiveBuild(data.build);
        setTasks(data.tasks || []);
        setFiles(data.files || []);
        setEvents(data.events || []);
        setModelRuns(data.modelRuns || []);
        setCheckpoints(data.checkpoints || []);

        if (data.files && data.files.length > 0) {
          // Keep current selected file updated or select README.md
          setSelectedFile(prev => {
            if (prev) {
              const updated = data.files.find((f: ProjectFile) => f.path === prev.path);
              if (updated) return updated;
            }
            return data.files.find((f: ProjectFile) => f.path === 'README.md') || data.files[0];
          });
        }
      }
    } catch (err) {
      console.error('Failed to fetch build details:', err);
    }
  };

  // Connect Server-Sent Events (SSE) listener when active build exists
  useEffect(() => {
    if (!activeBuild?.id) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    const buildId = activeBuild.id;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const sse = new EventSource(`/api/builds/${buildId}/stream`);
    eventSourceRef.current = sse;

    sse.addEventListener('build_updated', (e) => {
      try {
        const updated = JSON.parse(e.data);
        setActiveBuild(updated);
      } catch (err) {}
    });

    sse.addEventListener('task_added', (e) => {
      try {
        const task: Task = JSON.parse(e.data);
        setTasks(prev => [...prev.filter(t => t.id !== task.id), task]);
      } catch (err) {}
    });

    sse.addEventListener('task_updated', (e) => {
      try {
        const task: Task = JSON.parse(e.data);
        setTasks(prev => prev.map(t => t.id === task.id ? task : t));
      } catch (err) {}
    });

    sse.addEventListener('file_updated', (e) => {
      try {
        const file: ProjectFile = JSON.parse(e.data);
        setFiles(prev => {
          const index = prev.findIndex(f => f.path === file.path);
          if (index === -1) return [...prev, file];
          const next = [...prev];
          next[index] = file;
          return next;
        });

        setSelectedFile(prev => (prev?.path === file.path ? file : prev));
      } catch (err) {}
    });

    sse.addEventListener('event_added', (e) => {
      try {
        const event: SwarmEvent = JSON.parse(e.data);
        setEvents(prev => [...prev, event]);
      } catch (err) {}
    });

    sse.addEventListener('model_run_updated', (e) => {
      try {
        const run: ModelRunStatus = JSON.parse(e.data);
        setModelRuns(prev => {
          const index = prev.findIndex(m => m.modelId === run.modelId);
          if (index === -1) return [...prev, run];
          const next = [...prev];
          next[index] = run;
          return next;
        });
      } catch (err) {}
    });

    sse.addEventListener('checkpoint_saved', (e) => {
      try {
        const chk: Checkpoint = JSON.parse(e.data);
        setCheckpoints(prev => [...prev, chk]);
      } catch (err) {}
    });

    // Also periodic poll every 3s as backup sync
    const pollInterval = setInterval(() => {
      if (activeBuild?.status === 'running' || activeBuild?.status === 'planning' || activeBuild?.status === 'verifying') {
        fetchBuildDetails(buildId);
      }
    }, 3000);

    return () => {
      clearInterval(pollInterval);
      sse.close();
    };
  }, [activeBuild?.id]);

  const startBuild = async (idea: string, selectedModels: string[], autoPush: boolean, costLimit: number): Promise<string | null> => {
    try {
      const res = await fetch('/api/builds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idea,
          selectedModels,
          autoPushGithub: autoPush,
          costLimit
        })
      });

      if (!res.ok) throw new Error('Failed to start build');
      const data = await res.json();
      setActiveBuild(data.build);
      await fetchBuildDetails(data.build.id);
      return data.build.id;
    } catch (err) {
      console.error('Error starting build:', err);
      return null;
    }
  };

  const stopBuild = async () => {
    if (!activeBuild) return;
    await fetch(`/api/builds/${activeBuild.id}/stop`, { method: 'POST' });
    await fetchBuildDetails(activeBuild.id);
  };

  const retryFailedTasks = async () => {
    if (!activeBuild) return;
    await fetch(`/api/builds/${activeBuild.id}/retry-failed`, { method: 'POST' });
    await fetchBuildDetails(activeBuild.id);
  };

  const pushToGitHub = async () => {
    if (!activeBuild) return { success: false, error: 'No active build' };
    const res = await fetch(`/api/builds/${activeBuild.id}/push-github`, { method: 'POST' });
    const data = await res.json();
    await fetchBuildDetails(activeBuild.id);
    return data;
  };

  const rollbackToCheckpoint = async (checkpointId: string): Promise<boolean> => {
    if (!activeBuild) return false;
    const res = await fetch(`/api/builds/${activeBuild.id}/rollback-checkpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkpointId })
    });
    if (res.ok) {
      await fetchBuildDetails(activeBuild.id);
      return true;
    }
    return false;
  };

  const rollbackFile = async (filePath: string, version: number): Promise<boolean> => {
    if (!activeBuild) return false;
    const res = await fetch(`/api/builds/${activeBuild.id}/rollback-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, version })
    });
    if (res.ok) {
      await fetchBuildDetails(activeBuild.id);
      return true;
    }
    return false;
  };

  const exportProjectZip = async () => {
    if (!files || files.length === 0) return;
    const zip = new JSZip();

    for (const file of files) {
      zip.file(file.path, file.content);
    }

    // Include .env.example
    zip.file('.env.example', `# SquadForge Environment\nPORT=3000\nNODE_ENV=production\n`);

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `squadforge-${activeBuild?.idea.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20) || 'project'}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <SwarmContext.Provider value={{
      activeBuild,
      tasks,
      files,
      events,
      modelRuns,
      checkpoints,
      allModels,
      selectedFile,
      setSelectedFile,
      startBuild,
      stopBuild,
      retryFailedTasks,
      pushToGitHub,
      rollbackToCheckpoint,
      rollbackFile,
      exportProjectZip,
      fetchBuildDetails,
      refreshModels
    }}>
      {children}
    </SwarmContext.Provider>
  );
};

export const useSwarm = () => {
  const ctx = useContext(SwarmContext);
  if (!ctx) throw new Error('useSwarm must be used within a SwarmProvider');
  return ctx;
};
