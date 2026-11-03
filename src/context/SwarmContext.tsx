import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { 
  Build, 
  Task, 
  ProjectFile, 
  SwarmEvent, 
  ModelRunStatus, 
  Checkpoint, 
  ModelConfig,
  ConfigStatusResponse,
  TechStackConfig,
  VerificationReport,
  ProjectType,
  CollaborationOverview,
  AgentProfile,
  AgentMessage,
  AgentMessageType,
  AgentRole,
  CodeReview,
  CodeReviewVerdict,
  CodeReviewChecks,
  PatchProposal,
  FileConflict,
  AIChallenge,
  AIChallengeSubject,
  CollaborativeDefect,
  DefectSeverity,
  DefectStatus,
  HumanApprovalRequest,
  SharedKnowledgeItem
} from '../types/index.js';

interface SwarmContextType {
  activeBuild: Build | null;
  tasks: Task[];
  files: ProjectFile[];
  events: SwarmEvent[];
  modelRuns: ModelRunStatus[];
  checkpoints: Checkpoint[];
  allModels: ModelConfig[];
  configStatus: ConfigStatusResponse | null;
  selectedFile: ProjectFile | null;
  verificationReport: VerificationReport | null;
  // Phase 8: Collaboration State & Actions
  collaborationOverview: CollaborationOverview | null;
  agentMessages: AgentMessage[];
  codeReviews: CodeReview[];
  patchProposals: PatchProposal[];
  fileConflicts: FileConflict[];
  aiChallenges: AIChallenge[];
  defects: CollaborativeDefect[];
  approvalRequests: HumanApprovalRequest[];
  knowledgeItems: SharedKnowledgeItem[];
  refreshCollaboration: (buildId?: string) => Promise<void>;
  sendAgentMessage: (params: { senderRole: AgentRole; recipient?: string; messageType: AgentMessageType; content: string; relatedTaskId?: string; relatedFiles?: string[] }) => Promise<boolean>;
  submitReviewVerdict: (reviewId: string, verdict: CodeReviewVerdict, checks?: Partial<CodeReviewChecks>, summary?: string) => Promise<boolean>;
  respondToApproval: (approvalId: string, approved: boolean, notes?: string) => Promise<boolean>;
  resolveFileConflict: (conflictId: string, resolvedContent: string, explanation: string) => Promise<boolean>;
  recordDefect: (params: { title: string; description: string; severity: DefectSeverity; reproductionSteps: string[]; expectedBehavior: string; actualBehavior: string; affectedFiles: string[]; taskId?: string }) => Promise<boolean>;
  startAIChallenge: (params: { subject: AIChallengeSubject; originalProposal: string; proposerRole: AgentRole; challengerRole?: AgentRole; taskId?: string }) => Promise<boolean>;
  delegateTask: (taskId: string, targetRole: AgentRole, rationale?: string) => Promise<boolean>;
  setSelectedFile: (file: ProjectFile | null) => void;
  startBuild: (idea: string, selectedModels: string[], autoPush: boolean, costLimit: number, techStack?: TechStackConfig, projectType?: ProjectType) => Promise<string | null>;
  stopBuild: () => Promise<void>;
  resumeBuild: (buildId?: string) => Promise<boolean>;
  retryFailedTasks: () => Promise<void>;
  pushToGitHub: () => Promise<{ success: boolean; repoUrl?: string; branch?: string; pullRequestUrl?: string; commitSha?: string; error?: string }>;
  rollbackToCheckpoint: (checkpointId: string) => Promise<boolean>;
  rollbackFile: (filePath: string, version: number) => Promise<boolean>;
  exportProjectZip: () => Promise<void>;
  fetchBuildDetails: (buildId: string) => Promise<void>;
  fetchVerificationReport: (buildId?: string) => Promise<VerificationReport | null>;
  runManualVerification: (buildId?: string) => Promise<VerificationReport | null>;
  fetchHandoverGuide: (buildId?: string) => Promise<{ markdown: string; verdict: string } | null>;
  createWorkspaceFile: (path: string, content: string) => Promise<boolean>;
  deleteWorkspaceFile: (path: string) => Promise<boolean>;
  renameWorkspaceFile: (oldPath: string, newPath: string) => Promise<boolean>;
  requestRevision: (buildId: string, prompt: string) => Promise<{ success: boolean; revisionId?: string; error?: string }>;
  refreshModels: () => Promise<void>;
  refreshConfigStatus: () => Promise<void>;
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
  const [configStatus, setConfigStatus] = useState<ConfigStatusResponse | null>(null);
  const [selectedFile, setSelectedFile] = useState<ProjectFile | null>(null);

  // Phase 8 Collaboration States
  const [collaborationOverview, setCollaborationOverview] = useState<CollaborationOverview | null>(null);
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [codeReviews, setCodeReviews] = useState<CodeReview[]>([]);
  const [patchProposals, setPatchProposals] = useState<PatchProposal[]>([]);
  const [fileConflicts, setFileConflicts] = useState<FileConflict[]>([]);
  const [aiChallenges, setAiChallenges] = useState<AIChallenge[]>([]);
  const [defects, setDefects] = useState<CollaborativeDefect[]>([]);
  const [approvalRequests, setApprovalRequests] = useState<HumanApprovalRequest[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<SharedKnowledgeItem[]>([]);

  const eventSourceRef = useRef<EventSource | null>(null);

  const refreshCollaboration = async (targetBuildId?: string) => {
    const id = targetBuildId || activeBuild?.id;
    if (!id) return;

    try {
      const [
        overviewRes,
        messagesRes,
        reviewsRes,
        patchesRes,
        conflictsRes,
        challengesRes,
        defectsRes,
        approvalsRes,
        knowledgeRes
      ] = await Promise.all([
        fetch(`/api/builds/${id}/collaboration/overview`).then(r => r.ok ? r.json() : null),
        fetch(`/api/builds/${id}/collaboration/messages?limit=100`).then(r => r.ok ? r.json() : null),
        fetch(`/api/builds/${id}/collaboration/reviews`).then(r => r.ok ? r.json() : null),
        fetch(`/api/builds/${id}/collaboration/patches`).then(r => r.ok ? r.json() : null),
        fetch(`/api/builds/${id}/collaboration/conflicts`).then(r => r.ok ? r.json() : null),
        fetch(`/api/builds/${id}/collaboration/challenges`).then(r => r.ok ? r.json() : null),
        fetch(`/api/builds/${id}/collaboration/defects`).then(r => r.ok ? r.json() : null),
        fetch(`/api/builds/${id}/collaboration/approvals`).then(r => r.ok ? r.json() : null),
        fetch(`/api/builds/${id}/collaboration/knowledge`).then(r => r.ok ? r.json() : null)
      ]);

      if (overviewRes) setCollaborationOverview(overviewRes);
      if (messagesRes?.messages) setAgentMessages(messagesRes.messages);
      if (reviewsRes?.reviews) setCodeReviews(reviewsRes.reviews);
      if (patchesRes?.patches) setPatchProposals(patchesRes.patches);
      if (conflictsRes?.conflicts) setFileConflicts(conflictsRes.conflicts);
      if (challengesRes?.challenges) setAiChallenges(challengesRes.challenges);
      if (defectsRes?.defects) setDefects(defectsRes.defects);
      if (approvalsRes?.approvals) setApprovalRequests(approvalsRes.approvals);
      if (knowledgeRes?.items) setKnowledgeItems(knowledgeRes.items);
    } catch (err) {
      console.warn('Failed to refresh collaboration data:', err);
    }
  };

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

  // Fetch configuration status
  const refreshConfigStatus = async () => {
    try {
      const res = await fetch('/api/config-status');
      if (res.ok) {
        const data: ConfigStatusResponse = await res.json();
        setConfigStatus(data);
      }
    } catch (err) {
      console.error('Failed to fetch config status:', err);
    }
  };

  // Initial load: models, config status, and most recent build for resumability
  useEffect(() => {
    refreshModels();
    refreshConfigStatus();

    // Fetch existing builds to restore active or latest build
    fetch('/api/builds')
      .then(res => res.json())
      .then(data => {
        if (data.builds && data.builds.length > 0) {
          const activeOrRecent = data.builds.find((b: Build) => 
            b.status === 'running' || b.status === 'planning' || b.status === 'verifying'
          ) || data.builds[0];
          if (activeOrRecent) {
            fetchBuildDetails(activeOrRecent.id);
          }
        }
      })
      .catch(err => console.error('Failed to load recent builds:', err));
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
          setSelectedFile(prev => {
            if (prev) {
              const updated = data.files.find((f: ProjectFile) => f.path === prev.path);
              if (updated) return updated;
            }
            return data.files.find((f: ProjectFile) => f.path === 'README.md') || data.files[0];
          });
        }

        // Fetch collaboration center state
        refreshCollaboration(buildId);
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

    // Phase 8 Collaboration SSE Event Listeners
    sse.addEventListener('agent_message', (e) => {
      try {
        const msg: AgentMessage = JSON.parse(e.data);
        setAgentMessages(prev => [msg, ...prev.filter(m => m.id !== msg.id)]);
      } catch (err) {}
    });

    sse.addEventListener('code_review_updated', (e) => {
      try {
        const review: CodeReview = JSON.parse(e.data);
        setCodeReviews(prev => [review, ...prev.filter(r => r.id !== review.id)]);
      } catch (err) {}
    });

    sse.addEventListener('patch_proposal_updated', (e) => {
      try {
        const patch: PatchProposal = JSON.parse(e.data);
        setPatchProposals(prev => [patch, ...prev.filter(p => p.id !== patch.id)]);
      } catch (err) {}
    });

    sse.addEventListener('file_conflict_updated', (e) => {
      try {
        const conflict: FileConflict = JSON.parse(e.data);
        setFileConflicts(prev => [conflict, ...prev.filter(c => c.id !== conflict.id)]);
      } catch (err) {}
    });

    sse.addEventListener('ai_challenge_updated', (e) => {
      try {
        const challenge: AIChallenge = JSON.parse(e.data);
        setAiChallenges(prev => [challenge, ...prev.filter(c => c.id !== challenge.id)]);
      } catch (err) {}
    });

    sse.addEventListener('defect_updated', (e) => {
      try {
        const defect: CollaborativeDefect = JSON.parse(e.data);
        setDefects(prev => [defect, ...prev.filter(d => d.id !== defect.id)]);
      } catch (err) {}
    });

    sse.addEventListener('approval_request_updated', (e) => {
      try {
        const approval: HumanApprovalRequest = JSON.parse(e.data);
        setApprovalRequests(prev => [approval, ...prev.filter(a => a.id !== approval.id)]);
      } catch (err) {}
    });

    sse.addEventListener('knowledge_item_updated', (e) => {
      try {
        const item: SharedKnowledgeItem = JSON.parse(e.data);
        setKnowledgeItems(prev => [item, ...prev.filter(k => k.id !== item.id)]);
      } catch (err) {}
    });

    // Periodic sync
    const pollInterval = setInterval(() => {
      if (activeBuild?.status === 'running' || activeBuild?.status === 'planning' || activeBuild?.status === 'verifying') {
        fetchBuildDetails(buildId);
        refreshCollaboration(buildId);
      }
    }, 3000);

    return () => {
      clearInterval(pollInterval);
      sse.close();
    };
  }, [activeBuild?.id]);

  const startBuild = async (
    idea: string, 
    selectedModels: string[], 
    autoPush: boolean, 
    costLimit: number,
    techStack?: TechStackConfig,
    projectType?: ProjectType
  ): Promise<string | null> => {
    try {
      const res = await fetch('/api/builds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idea,
          selectedModels,
          autoPushGithub: autoPush,
          costLimit,
          techStack,
          projectType
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

  const requestRevision = async (buildId: string, prompt: string): Promise<{ success: boolean; revisionId?: string; error?: string }> => {
    try {
      const res = await fetch(`/api/builds/${buildId}/revisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        await fetchBuildDetails(buildId);
        return { success: true, revisionId: data.revision?.id };
      }
      return { success: false, error: data.error || 'Failed to submit revision' };
    } catch (err: any) {
      console.error('Error requesting revision:', err);
      return { success: false, error: err.message || 'Network error' };
    }
  };

  const stopBuild = async () => {
    if (!activeBuild) return;
    await fetch(`/api/builds/${activeBuild.id}/stop`, { method: 'POST' });
    await fetchBuildDetails(activeBuild.id);
  };

  const resumeBuild = async (buildId?: string): Promise<boolean> => {
    const targetId = buildId || activeBuild?.id;
    if (!targetId) return false;
    const res = await fetch(`/api/builds/${targetId}/resume`, { method: 'POST' });
    if (res.ok) {
      await fetchBuildDetails(targetId);
      return true;
    }
    return false;
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

  const [verificationReport, setVerificationReport] = useState<VerificationReport | null>(null);

  const fetchVerificationReport = async (buildId?: string): Promise<VerificationReport | null> => {
    const targetId = buildId || activeBuild?.id;
    if (!targetId) return null;
    try {
      const res = await fetch(`/api/builds/${targetId}/verification`);
      if (res.ok) {
        const data = await res.json();
        setVerificationReport(data.report);
        return data.report;
      }
    } catch (err) {
      console.error('Failed to fetch verification report:', err);
    }
    return null;
  };

  const runManualVerification = async (buildId?: string): Promise<VerificationReport | null> => {
    const targetId = buildId || activeBuild?.id;
    if (!targetId) return null;
    try {
      const res = await fetch(`/api/builds/${targetId}/verify`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setVerificationReport(data.report);
        await fetchBuildDetails(targetId);
        return data.report;
      }
    } catch (err) {
      console.error('Failed to trigger manual verification:', err);
    }
    return null;
  };

  const fetchHandoverGuide = async (buildId?: string): Promise<{ markdown: string; verdict: string } | null> => {
    const targetId = buildId || activeBuild?.id;
    if (!targetId) return null;
    try {
      const res = await fetch(`/api/builds/${targetId}/handover`);
      if (res.ok) {
        return await res.json();
      }
    } catch (err) {
      console.error('Failed to fetch handover guide:', err);
    }
    return null;
  };

  const createWorkspaceFile = async (path: string, content: string): Promise<boolean> => {
    if (!activeBuild) return false;
    try {
      const res = await fetch(`/api/builds/${activeBuild.id}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content })
      });
      if (res.ok) {
        await fetchBuildDetails(activeBuild.id);
        return true;
      }
    } catch (err) {
      console.error('Failed to create file:', err);
    }
    return false;
  };

  const deleteWorkspaceFile = async (path: string): Promise<boolean> => {
    if (!activeBuild) return false;
    try {
      const res = await fetch(`/api/builds/${activeBuild.id}/files`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      });
      if (res.ok) {
        await fetchBuildDetails(activeBuild.id);
        return true;
      }
    } catch (err) {
      console.error('Failed to delete file:', err);
    }
    return false;
  };

  const renameWorkspaceFile = async (oldPath: string, newPath: string): Promise<boolean> => {
    if (!activeBuild) return false;
    try {
      const res = await fetch(`/api/builds/${activeBuild.id}/files/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath, newPath })
      });
      if (res.ok) {
        await fetchBuildDetails(activeBuild.id);
        return true;
      }
    } catch (err) {
      console.error('Failed to rename file:', err);
    }
    return false;
  };

  const exportProjectZip = async () => {
    if (!activeBuild) return;
    try {
      // Use direct server-side export endpoint with complete structure and setup instructions
      const res = await fetch(`/api/builds/${activeBuild.id}/export`);
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const sanitizedName = activeBuild.idea.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || 'project';
        a.download = `squadforge-${sanitizedName}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('Failed to export project zip:', err);
    }
  };

  // Phase 8 Collaboration Action Handlers
  const sendAgentMessage = async (params: {
    senderRole: AgentRole;
    recipient?: string;
    messageType: AgentMessageType;
    content: string;
    relatedTaskId?: string;
    relatedFiles?: string[];
  }): Promise<boolean> => {
    if (!activeBuild) return false;
    try {
      const res = await fetch(`/api/builds/${activeBuild.id}/collaboration/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      if (res.ok) {
        await refreshCollaboration(activeBuild.id);
        return true;
      }
    } catch (err) {
      console.error('Failed to send agent message:', err);
    }
    return false;
  };

  const submitReviewVerdict = async (
    reviewId: string,
    verdict: CodeReviewVerdict,
    checks?: Partial<CodeReviewChecks>,
    summary?: string
  ): Promise<boolean> => {
    if (!activeBuild) return false;
    try {
      const res = await fetch(`/api/builds/${activeBuild.id}/collaboration/reviews/${reviewId}/verdict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict, checks, summary })
      });
      if (res.ok) {
        await refreshCollaboration(activeBuild.id);
        return true;
      }
    } catch (err) {
      console.error('Failed to submit review verdict:', err);
    }
    return false;
  };

  const respondToApproval = async (
    approvalId: string,
    approved: boolean,
    notes?: string
  ): Promise<boolean> => {
    if (!activeBuild) return false;
    try {
      const res = await fetch(`/api/builds/${activeBuild.id}/collaboration/approvals/${approvalId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved, notes })
      });
      if (res.ok) {
        await refreshCollaboration(activeBuild.id);
        return true;
      }
    } catch (err) {
      console.error('Failed to respond to approval:', err);
    }
    return false;
  };

  const resolveFileConflict = async (
    conflictId: string,
    resolvedContent: string,
    explanation: string
  ): Promise<boolean> => {
    if (!activeBuild) return false;
    try {
      const res = await fetch(`/api/builds/${activeBuild.id}/collaboration/conflicts/${conflictId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolvedContent, explanation })
      });
      if (res.ok) {
        await refreshCollaboration(activeBuild.id);
        await fetchBuildDetails(activeBuild.id);
        return true;
      }
    } catch (err) {
      console.error('Failed to resolve file conflict:', err);
    }
    return false;
  };

  const recordDefect = async (params: {
    title: string;
    description: string;
    severity: DefectSeverity;
    reproductionSteps: string[];
    expectedBehavior: string;
    actualBehavior: string;
    affectedFiles: string[];
    taskId?: string;
  }): Promise<boolean> => {
    if (!activeBuild) return false;
    try {
      const res = await fetch(`/api/builds/${activeBuild.id}/collaboration/defects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      if (res.ok) {
        await refreshCollaboration(activeBuild.id);
        return true;
      }
    } catch (err) {
      console.error('Failed to record defect:', err);
    }
    return false;
  };

  const startAIChallenge = async (params: {
    subject: AIChallengeSubject;
    originalProposal: string;
    proposerRole: AgentRole;
    challengerRole?: AgentRole;
    taskId?: string;
  }): Promise<boolean> => {
    if (!activeBuild) return false;
    try {
      const res = await fetch(`/api/builds/${activeBuild.id}/collaboration/challenges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      if (res.ok) {
        await refreshCollaboration(activeBuild.id);
        return true;
      }
    } catch (err) {
      console.error('Failed to start AI challenge:', err);
    }
    return false;
  };

  const delegateTask = async (
    taskId: string,
    targetRole: AgentRole,
    rationale?: string
  ): Promise<boolean> => {
    if (!activeBuild) return false;
    try {
      const res = await fetch(`/api/builds/${activeBuild.id}/collaboration/tasks/${taskId}/delegate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetRole, rationale })
      });
      if (res.ok) {
        await refreshCollaboration(activeBuild.id);
        await fetchBuildDetails(activeBuild.id);
        return true;
      }
    } catch (err) {
      console.error('Failed to delegate task:', err);
    }
    return false;
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
      configStatus,
      selectedFile,
      verificationReport,
      collaborationOverview,
      agentMessages,
      codeReviews,
      patchProposals,
      fileConflicts,
      aiChallenges,
      defects,
      approvalRequests,
      knowledgeItems,
      refreshCollaboration,
      sendAgentMessage,
      submitReviewVerdict,
      respondToApproval,
      resolveFileConflict,
      recordDefect,
      startAIChallenge,
      delegateTask,
      setSelectedFile,
      startBuild,
      stopBuild,
      resumeBuild,
      retryFailedTasks,
      pushToGitHub,
      rollbackToCheckpoint,
      rollbackFile,
      exportProjectZip,
      fetchBuildDetails,
      fetchVerificationReport,
      runManualVerification,
      fetchHandoverGuide,
      createWorkspaceFile,
      deleteWorkspaceFile,
      renameWorkspaceFile,
      requestRevision,
      refreshModels,
      refreshConfigStatus
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
