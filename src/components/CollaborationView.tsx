import React, { useState, useMemo } from 'react';
import { useSwarm } from '../context/SwarmContext.js';
import { 
  AgentRole, 
  AgentMessageType, 
  CodeReviewVerdict, 
  CodeReviewChecks, 
  DefectSeverity, 
  AIChallengeSubject,
  ApprovalStatus
} from '../types/index.js';
import {
  Users,
  MessageSquare,
  FileCheck2,
  GitPullRequest,
  Swords,
  Bug,
  GitCompare,
  ShieldAlert,
  Clock,
  Search,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Send,
  Plus,
  RefreshCw,
  FileCode,
  Check,
  X,
  ExternalLink,
  ChevronRight,
  ShieldCheck,
  Terminal,
  Zap
} from 'lucide-react';

type CenterTab = 
  | 'agents' 
  | 'messages' 
  | 'reviews' 
  | 'patches' 
  | 'challenges' 
  | 'defects' 
  | 'conflicts' 
  | 'approvals' 
  | 'timeline';

const ALL_ROLES: AgentRole[] = [
  'software_architect',
  'project_manager',
  'frontend_developer',
  'backend_developer',
  'database_engineer',
  'security_specialist',
  'ui_ux_designer',
  'debugging_specialist',
  'qa_engineer',
  'integration_engineer',
  'performance_engineer',
  'documentation_engineer'
];

const MESSAGE_TYPES: AgentMessageType[] = [
  'task_assignment',
  'task_update',
  'progress_report',
  'implementation_proposal',
  'review_request',
  'review_response',
  'code_comment',
  'bug_report',
  'debugging_request',
  'architecture_question',
  'architecture_proposal',
  'architecture_decision',
  'patch_proposal',
  'patch_update',
  'test_report',
  'conflict_report',
  'approval_request',
  'approval_response',
  'knowledge_share'
];

export const CollaborationView: React.FC = () => {
  const {
    activeBuild,
    collaborationOverview,
    agentMessages,
    codeReviews,
    patchProposals,
    fileConflicts,
    aiChallenges,
    defects,
    approvalRequests,
    events,
    tasks,
    refreshCollaboration,
    sendAgentMessage,
    submitReviewVerdict,
    respondToApproval,
    resolveFileConflict,
    recordDefect,
    startAIChallenge,
    delegateTask
  } = useSwarm();

  const [activeCenter, setActiveCenter] = useState<CenterTab>('agents');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Filters & Search State
  const [messageSearch, setMessageSearch] = useState('');
  const [selectedRoleFilter, setSelectedRoleFilter] = useState<string>('all');
  const [selectedTypeFilter, setSelectedTypeFilter] = useState<string>('all');

  // Modals & Forms
  const [showComposeMessage, setShowComposeMessage] = useState(false);
  const [newMessageRole, setNewMessageRole] = useState<AgentRole>('project_manager');
  const [newMessageType, setNewMessageType] = useState<AgentMessageType>('progress_report');
  const [newMessageRecipient, setNewMessageRecipient] = useState<string>('');
  const [newMessageContent, setNewMessageContent] = useState<string>('');

  // Review Verdict Modal
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [reviewVerdict, setReviewVerdict] = useState<CodeReviewVerdict>('approved');
  const [reviewSummary, setReviewSummary] = useState('');

  // Conflict Resolution Modal
  const [selectedConflictId, setSelectedConflictId] = useState<string | null>(null);
  const [conflictResolvedContent, setConflictResolvedContent] = useState('');
  const [conflictExplanation, setConflictExplanation] = useState('');

  // New Defect Modal
  const [showNewDefect, setShowNewDefect] = useState(false);
  const [defectTitle, setDefectTitle] = useState('');
  const [defectDesc, setDefectDesc] = useState('');
  const [defectSeverity, setDefectSeverity] = useState<DefectSeverity>('medium');
  const [defectSteps, setDefectSteps] = useState('');
  const [defectExpected, setDefectExpected] = useState('');
  const [defectActual, setDefectActual] = useState('');
  const [defectFiles, setDefectFiles] = useState('');

  // New Challenge Modal
  const [showNewChallenge, setShowNewChallenge] = useState(false);
  const [challengeSubject, setChallengeSubject] = useState<AIChallengeSubject>('architecture');
  const [challengeProposal, setChallengeProposal] = useState('');
  const [challengeProposer, setChallengeProposer] = useState<AgentRole>('software_architect');
  const [challengeChallenger, setChallengeChallenger] = useState<AgentRole>('security_specialist');

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refreshCollaboration();
    setIsRefreshing(false);
  };

  const pendingApprovalsCount = useMemo(() => 
    approvalRequests.filter(a => a.status === 'pending').length, 
    [approvalRequests]
  );

  const pendingReviewsCount = useMemo(() => 
    codeReviews.filter(r => r.verdict === 'pending' || r.verdict === 'changes_requested').length, 
    [codeReviews]
  );

  const openDefectsCount = useMemo(() => 
    defects.filter(d => d.status === 'open' || d.status === 'investigating').length, 
    [defects]
  );

  const unresolvedConflictsCount = useMemo(() => 
    fileConflicts.filter(c => c.status === 'detected' || c.status === 'resolving').length, 
    [fileConflicts]
  );

  const filteredMessages = useMemo(() => {
    return agentMessages.filter(msg => {
      const matchSearch = !messageSearch || 
        msg.content.toLowerCase().includes(messageSearch.toLowerCase()) ||
        msg.senderRole.toLowerCase().includes(messageSearch.toLowerCase()) ||
        msg.messageType.toLowerCase().includes(messageSearch.toLowerCase());
      const matchRole = selectedRoleFilter === 'all' || msg.senderRole === selectedRoleFilter;
      const matchType = selectedTypeFilter === 'all' || msg.messageType === selectedTypeFilter;
      return matchSearch && matchRole && matchType;
    });
  }, [agentMessages, messageSearch, selectedRoleFilter, selectedTypeFilter]);

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'software_architect': return 'bg-purple-500/10 text-purple-400 border-purple-500/30';
      case 'project_manager': return 'bg-sky-500/10 text-sky-400 border-sky-500/30';
      case 'frontend_developer': return 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30';
      case 'backend_developer': return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
      case 'database_engineer': return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      case 'security_specialist': return 'bg-rose-500/10 text-rose-400 border-rose-500/30';
      case 'ui_ux_designer': return 'bg-pink-500/10 text-pink-400 border-pink-500/30';
      case 'debugging_specialist': return 'bg-red-500/10 text-red-400 border-red-500/30';
      case 'qa_engineer': return 'bg-teal-500/10 text-teal-400 border-teal-500/30';
      case 'integration_engineer': return 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30';
      case 'performance_engineer': return 'bg-orange-500/10 text-orange-400 border-orange-500/30';
      case 'documentation_engineer': return 'bg-blue-500/10 text-blue-400 border-blue-500/30';
      default: return 'bg-neutral-800 text-neutral-300 border-neutral-700';
    }
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'idle': return 'bg-neutral-800 text-neutral-400 border-neutral-700';
      case 'assigned': return 'bg-blue-500/10 text-blue-400 border-blue-500/30';
      case 'analyzing': return 'bg-purple-500/10 text-purple-400 border-purple-500/30';
      case 'working': return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 animate-pulse';
      case 'awaiting_review': return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      case 'revising': return 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30';
      case 'blocked': return 'bg-rose-500/10 text-rose-400 border-rose-500/30';
      case 'awaiting_approval': return 'bg-amber-500/10 text-amber-400 border-amber-500/30 font-semibold';
      case 'completed': return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
      case 'failed': return 'bg-red-500/10 text-red-400 border-red-500/30';
      default: return 'bg-neutral-800 text-neutral-400 border-neutral-700';
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-65px)] bg-neutral-950 text-neutral-100 overflow-hidden">
      {/* Top Bar: Overview metrics & actions */}
      <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-3 border-b border-neutral-800/80 bg-neutral-900/60 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-white tracking-tight flex items-center gap-2">
              Collaborative Swarm Engineering Center
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                Phase 8
              </span>
            </h1>
            <p className="text-xs text-neutral-400">
              {activeBuild ? `Build #${activeBuild.id.slice(0, 8)}: ${activeBuild.idea}` : 'No active build selected'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-neutral-300 bg-neutral-900 border border-neutral-800 rounded-lg hover:text-white hover:border-neutral-700 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-amber-400' : ''}`} />
            <span>Sync</span>
          </button>
        </div>
      </div>

      {/* Navigation Tabs for the 9 Collaboration Centers */}
      <div className="flex items-center gap-1 px-6 border-b border-neutral-800/80 bg-neutral-950 overflow-x-auto scrollbar-thin shrink-0">
        <button
          onClick={() => setActiveCenter('agents')}
          className={`flex items-center gap-2 px-3.5 py-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 ${
            activeCenter === 'agents' 
              ? 'border-amber-400 text-amber-300' 
              : 'border-transparent text-neutral-400 hover:text-neutral-200'
          }`}
        >
          <Users className="w-4 h-4" />
          <span>Agent Squad ({collaborationOverview?.agentProfiles?.length || 12})</span>
        </button>

        <button
          onClick={() => setActiveCenter('messages')}
          className={`flex items-center gap-2 px-3.5 py-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 ${
            activeCenter === 'messages' 
              ? 'border-amber-400 text-amber-300' 
              : 'border-transparent text-neutral-400 hover:text-neutral-200'
          }`}
        >
          <MessageSquare className="w-4 h-4" />
          <span>Communication ({agentMessages.length})</span>
        </button>

        <button
          onClick={() => setActiveCenter('reviews')}
          className={`flex items-center gap-2 px-3.5 py-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 relative ${
            activeCenter === 'reviews' 
              ? 'border-amber-400 text-amber-300' 
              : 'border-transparent text-neutral-400 hover:text-neutral-200'
          }`}
        >
          <FileCheck2 className="w-4 h-4" />
          <span>Code Reviews</span>
          {pendingReviewsCount > 0 && (
            <span className="px-1.5 py-0.2 text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full">
              {pendingReviewsCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveCenter('patches')}
          className={`flex items-center gap-2 px-3.5 py-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 ${
            activeCenter === 'patches' 
              ? 'border-amber-400 text-amber-300' 
              : 'border-transparent text-neutral-400 hover:text-neutral-200'
          }`}
        >
          <GitPullRequest className="w-4 h-4" />
          <span>Patch Exchange ({patchProposals.length})</span>
        </button>

        <button
          onClick={() => setActiveCenter('challenges')}
          className={`flex items-center gap-2 px-3.5 py-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 ${
            activeCenter === 'challenges' 
              ? 'border-amber-400 text-amber-300' 
              : 'border-transparent text-neutral-400 hover:text-neutral-200'
          }`}
        >
          <Swords className="w-4 h-4" />
          <span>AI Challenge ({aiChallenges.length})</span>
        </button>

        <button
          onClick={() => setActiveCenter('defects')}
          className={`flex items-center gap-2 px-3.5 py-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 relative ${
            activeCenter === 'defects' 
              ? 'border-amber-400 text-amber-300' 
              : 'border-transparent text-neutral-400 hover:text-neutral-200'
          }`}
        >
          <Bug className="w-4 h-4" />
          <span>Debugging & Defects</span>
          {openDefectsCount > 0 && (
            <span className="px-1.5 py-0.2 text-[10px] font-mono font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40 rounded-full">
              {openDefectsCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveCenter('conflicts')}
          className={`flex items-center gap-2 px-3.5 py-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 relative ${
            activeCenter === 'conflicts' 
              ? 'border-amber-400 text-amber-300' 
              : 'border-transparent text-neutral-400 hover:text-neutral-200'
          }`}
        >
          <GitCompare className="w-4 h-4" />
          <span>Conflict Center</span>
          {unresolvedConflictsCount > 0 && (
            <span className="px-1.5 py-0.2 text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full">
              {unresolvedConflictsCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveCenter('approvals')}
          className={`flex items-center gap-2 px-3.5 py-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 relative ${
            activeCenter === 'approvals' 
              ? 'border-amber-400 text-amber-300' 
              : 'border-transparent text-neutral-400 hover:text-neutral-200'
          }`}
        >
          <ShieldAlert className="w-4 h-4" />
          <span>Human Approvals</span>
          {pendingApprovalsCount > 0 && (
            <span className="px-1.5 py-0.2 text-[10px] font-mono font-bold bg-red-500/20 text-red-300 border border-red-500/40 rounded-full animate-bounce">
              {pendingApprovalsCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveCenter('timeline')}
          className={`flex items-center gap-2 px-3.5 py-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 ${
            activeCenter === 'timeline' 
              ? 'border-amber-400 text-amber-300' 
              : 'border-transparent text-neutral-400 hover:text-neutral-200'
          }`}
        >
          <Clock className="w-4 h-4" />
          <span>Activity Timeline</span>
        </button>
      </div>

      {/* Main Workspace Body */}
      <div className="flex-1 overflow-y-auto p-6">
        {!activeBuild && (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 text-neutral-500">
            <Users className="w-12 h-12 stroke-[1.5] text-neutral-600 mb-3" />
            <h3 className="text-sm font-semibold text-neutral-300">No Active Swarm Session</h3>
            <p className="text-xs max-w-sm mt-1 text-neutral-500">
              Start a project in the Idea Forge or select an existing build to inspect collaborative agents in real time.
            </p>
          </div>
        )}

        {activeBuild && (
          <>
            {/* 1. AGENTS OVERVIEW CENTER */}
            {activeCenter === 'agents' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-white">Specialized AI Engineering Squad</h2>
                    <p className="text-xs text-neutral-400">12 verified agents working in autonomous coordination</p>
                  </div>
                  <div className="text-xs font-mono text-neutral-400">
                    Active: {collaborationOverview?.agentProfiles?.filter(p => p.status === 'working').length || 0} / 12
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {(collaborationOverview?.agentProfiles && collaborationOverview.agentProfiles.length > 0 
                    ? collaborationOverview.agentProfiles 
                    : ALL_ROLES.map(role => ({
                        id: `agent-${role}`,
                        buildId: activeBuild.id,
                        role,
                        modelId: 'assigned',
                        status: 'idle' as const,
                        capabilities: ['autonomous_code', 'review', 'verify'],
                        assignedTaskIds: [],
                        workload: 0,
                        updatedAt: Date.now()
                      }))
                  ).map(profile => (
                    <div 
                      key={profile.role} 
                      className="p-4 rounded-xl border border-neutral-800 bg-neutral-900/60 hover:border-neutral-700 transition-all flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <span className={`px-2 py-0.5 text-xs font-mono font-medium rounded border ${getRoleBadgeColor(profile.role)}`}>
                            {profile.role.replace(/_/g, ' ')}
                          </span>
                          <span className={`px-2 py-0.5 text-[10px] font-mono font-semibold rounded border uppercase ${getStatusBadgeColor(profile.status)}`}>
                            {profile.status.replace(/_/g, ' ')}
                          </span>
                        </div>

                        <div className="text-xs text-neutral-400 mb-3 space-y-1">
                          <div className="flex items-center justify-between font-mono text-[11px]">
                            <span className="text-neutral-500">Model:</span>
                            <span className="text-neutral-300">{profile.modelId || 'auto-assigned'}</span>
                          </div>
                          <div className="flex items-center justify-between font-mono text-[11px]">
                            <span className="text-neutral-500">Tasks Assigned:</span>
                            <span className="text-neutral-300">{profile.assignedTaskIds?.length || 0}</span>
                          </div>
                        </div>

                        <div className="mb-3">
                          <div className="flex justify-between text-[10px] font-mono text-neutral-500 mb-1">
                            <span>Workload</span>
                            <span>{Math.round(profile.workload * 100)}%</span>
                          </div>
                          <div className="h-1.5 w-full bg-neutral-800 rounded-full overflow-hidden">
                            <div 
                              className={`h-full ${profile.workload > 0.8 ? 'bg-rose-500' : profile.workload > 0.4 ? 'bg-amber-400' : 'bg-emerald-500'}`}
                              style={{ width: `${Math.min(100, Math.round(profile.workload * 100))}%` }}
                            />
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-1">
                          {profile.capabilities?.slice(0, 3).map((cap, idx) => (
                            <span key={idx} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-neutral-800/80 text-neutral-400">
                              {cap}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 2. COMMUNICATION CENTER */}
            {activeCenter === 'messages' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[280px]">
                    <div className="relative flex-1 min-w-[180px]">
                      <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
                      <input 
                        type="text" 
                        placeholder="Search communication messages..." 
                        value={messageSearch}
                        onChange={e => setMessageSearch(e.target.value)}
                        className="w-full pl-9 pr-3 py-1.5 text-xs bg-neutral-900 border border-neutral-800 rounded-lg text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-amber-500/50"
                      />
                    </div>
                    <select
                      value={selectedRoleFilter}
                      onChange={e => setSelectedRoleFilter(e.target.value)}
                      className="px-2.5 py-1.5 text-xs bg-neutral-900 border border-neutral-800 rounded-lg text-neutral-300 focus:outline-none"
                    >
                      <option value="all">All Roles</option>
                      {ALL_ROLES.map(role => (
                        <option key={role} value={role}>{role.replace(/_/g, ' ')}</option>
                      ))}
                    </select>
                    <select
                      value={selectedTypeFilter}
                      onChange={e => setSelectedTypeFilter(e.target.value)}
                      className="px-2.5 py-1.5 text-xs bg-neutral-900 border border-neutral-800 rounded-lg text-neutral-300 focus:outline-none"
                    >
                      <option value="all">All Message Types</option>
                      {MESSAGE_TYPES.map(type => (
                        <option key={type} value={type}>{type.replace(/_/g, ' ')}</option>
                      ))}
                    </select>
                  </div>

                  <button
                    onClick={() => setShowComposeMessage(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg hover:bg-amber-500/20 transition-colors"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Broadcast Message</span>
                  </button>
                </div>

                {/* Message Feed */}
                <div className="space-y-3">
                  {filteredMessages.length === 0 ? (
                    <div className="text-center py-12 border border-dashed border-neutral-800 rounded-xl">
                      <MessageSquare className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
                      <p className="text-xs text-neutral-400">No agent messages matching filter</p>
                    </div>
                  ) : (
                    filteredMessages.map(msg => (
                      <div 
                        key={msg.id} 
                        className="p-4 rounded-xl border border-neutral-800 bg-neutral-900/50 hover:bg-neutral-900/80 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`px-2 py-0.5 text-xs font-mono font-medium rounded border ${getRoleBadgeColor(msg.senderRole)}`}>
                              {msg.senderRole.replace(/_/g, ' ')}
                            </span>
                            <span className="text-neutral-500 text-xs">→</span>
                            <span className="text-xs font-mono text-neutral-400">
                              {msg.recipient ? msg.recipient.replace(/_/g, ' ') : 'All Agents'}
                            </span>
                            <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-neutral-800 text-neutral-300 border border-neutral-700">
                              {msg.messageType.replace(/_/g, ' ')}
                            </span>
                          </div>
                          <span className="text-[11px] font-mono text-neutral-500">
                            {new Date(msg.timestamp).toLocaleTimeString()}
                          </span>
                        </div>

                        <div className="text-xs text-neutral-200 leading-relaxed font-sans whitespace-pre-wrap">
                          {msg.content}
                        </div>

                        {msg.relatedFiles && msg.relatedFiles.length > 0 && (
                          <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
                            <span className="text-[10px] text-neutral-500 font-mono">Files:</span>
                            {msg.relatedFiles.map((file, idx) => (
                              <span key={idx} className="text-[10px] font-mono px-2 py-0.5 rounded bg-neutral-800 text-neutral-400 border border-neutral-700">
                                {file}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* 3. CODE REVIEW CENTER */}
            {activeCenter === 'reviews' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-white">Peer Code Review Pipeline</h2>
                    <p className="text-xs text-neutral-400">12 rigorous engineering quality checks enforced before code integration</p>
                  </div>
                </div>

                <div className="space-y-4">
                  {codeReviews.length === 0 ? (
                    <div className="text-center py-12 border border-dashed border-neutral-800 rounded-xl">
                      <FileCheck2 className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
                      <p className="text-xs text-neutral-400">No code reviews requested yet</p>
                    </div>
                  ) : (
                    codeReviews.map(review => (
                      <div 
                        key={review.id} 
                        className="p-5 rounded-xl border border-neutral-800 bg-neutral-900/60 space-y-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-mono text-neutral-400">
                              Author: <span className="text-neutral-200 font-semibold">{review.authorRole}</span>
                            </span>
                            <span className="text-neutral-500 text-xs">·</span>
                            <span className="text-xs font-mono text-neutral-400">
                              Reviewer: <span className="text-neutral-200 font-semibold">{review.reviewerRole}</span>
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`px-2.5 py-0.5 text-xs font-mono font-semibold rounded border uppercase ${
                              review.verdict === 'approved' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                              review.verdict === 'approved_with_suggestions' ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30' :
                              review.verdict === 'changes_requested' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' :
                              review.verdict === 'rejected' ? 'bg-rose-500/10 text-rose-400 border-rose-500/30' :
                              'bg-neutral-800 text-neutral-400 border-neutral-700'
                            }`}>
                              {review.verdict.replace(/_/g, ' ')}
                            </span>
                            {review.verdict === 'pending' && (
                              <button
                                onClick={() => setSelectedReviewId(review.id)}
                                className="px-2.5 py-1 text-xs font-medium text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg hover:bg-amber-500/20"
                              >
                                Submit Verdict
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="text-xs text-neutral-300 bg-neutral-950/60 p-3 rounded-lg border border-neutral-800/80">
                          <div className="font-semibold text-neutral-200 mb-1">Explanation:</div>
                          {review.explanation}
                        </div>

                        {/* 12 Review Checks Grid */}
                        <div>
                          <h4 className="text-[11px] font-mono text-neutral-400 uppercase tracking-wider mb-2">Automated Quality Checks</h4>
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                            {Object.entries(review.checks).map(([checkName, passed]) => (
                              <div 
                                key={checkName} 
                                className={`flex items-center justify-between px-2.5 py-1.5 rounded border text-[11px] font-mono ${
                                  passed ? 'bg-emerald-950/30 border-emerald-800/50 text-emerald-300' : 'bg-neutral-900 border-neutral-800 text-neutral-400'
                                }`}
                              >
                                <span className="truncate">{checkName.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                                {passed ? <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 ml-1" /> : <X className="w-3.5 h-3.5 text-neutral-500 shrink-0 ml-1" />}
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Line Comments */}
                        {review.comments && review.comments.length > 0 && (
                          <div className="space-y-2">
                            <h4 className="text-[11px] font-mono text-neutral-400 uppercase tracking-wider">Line-Level Comments ({review.comments.length})</h4>
                            {review.comments.map(c => (
                              <div key={c.id} className="p-2.5 rounded bg-neutral-950 border border-neutral-800 text-xs space-y-1">
                                <div className="flex items-center justify-between text-[11px] font-mono">
                                  <span className="text-amber-400">{c.filePath}:{c.startLine}-{c.endLine}</span>
                                  <span className={`px-1.5 py-0.2 rounded text-[10px] font-semibold uppercase ${
                                    c.severity === 'critical' ? 'bg-rose-500/20 text-rose-300' : 'bg-neutral-800 text-neutral-400'
                                  }`}>
                                    {c.severity}
                                  </span>
                                </div>
                                <div className="text-neutral-300">{c.explanation}</div>
                                {c.suggestedCorrection && (
                                  <div className="font-mono text-[11px] bg-neutral-900 p-2 rounded text-emerald-300 border border-neutral-800">
                                    Suggested: {c.suggestedCorrection}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* 4. PATCH EXCHANGE CENTER */}
            {activeCenter === 'patches' && (
              <div className="space-y-4">
                <div>
                  <h2 className="text-sm font-semibold text-white">Patch Proposal & Integration Pipeline</h2>
                  <p className="text-xs text-neutral-400">Atomic, version-verified code diffs applied through the safe sequential MergeManager</p>
                </div>

                <div className="space-y-4">
                  {patchProposals.length === 0 ? (
                    <div className="text-center py-12 border border-dashed border-neutral-800 rounded-xl">
                      <GitPullRequest className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
                      <p className="text-xs text-neutral-400">No patch proposals generated yet</p>
                    </div>
                  ) : (
                    patchProposals.map(patch => (
                      <div key={patch.id} className="p-4 rounded-xl border border-neutral-800 bg-neutral-900/60 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono font-bold text-amber-400">{patch.targetFile}</span>
                            <span className="text-[11px] font-mono text-neutral-500">base v{patch.baseFileVersion}</span>
                            <span className={`px-2 py-0.5 text-[10px] font-mono rounded border uppercase ${
                              patch.validationStatus === 'valid' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                              patch.validationStatus === 'conflict' ? 'bg-rose-500/10 text-rose-400 border-rose-500/30' :
                              'bg-neutral-800 text-neutral-400 border-neutral-700'
                            }`}>
                              {patch.validationStatus}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`px-2 py-0.5 text-[10px] font-mono rounded border uppercase ${
                              patch.applicationStatus === 'applied' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' :
                              'bg-neutral-800 text-neutral-400 border-neutral-700'
                            }`}>
                              {patch.applicationStatus}
                            </span>
                            {patch.applicationStatus === 'pending' && (
                              <button
                                onClick={async () => {
                                  await fetch(`/api/builds/${activeBuild.id}/collaboration/patches/${patch.id}/apply`, { method: 'POST' });
                                  await refreshCollaboration();
                                }}
                                className="px-2.5 py-1 text-xs font-medium text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/20"
                              >
                                Apply Patch
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="text-xs text-neutral-300">
                          {patch.changeExplanation}
                        </div>

                        {/* Hunks */}
                        <div className="space-y-2">
                          {patch.hunks.map((hunk, idx) => (
                            <div key={idx} className="font-mono text-[11px] rounded bg-neutral-950 p-2.5 border border-neutral-800/80">
                              <div className="text-neutral-500 text-[10px] mb-1">
                                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                              </div>
                              <pre className="text-neutral-300 whitespace-pre-wrap">{hunk.content}</pre>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* 5. AI CHALLENGE MODE CENTER */}
            {activeCenter === 'challenges' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-white">AI Challenge Mode</h2>
                    <p className="text-xs text-neutral-400">Multi-round dialectic debates (max 3 rounds) to surface edge cases before adoption</p>
                  </div>
                  <button
                    onClick={() => setShowNewChallenge(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg hover:bg-amber-500/20 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Initiate Challenge</span>
                  </button>
                </div>

                <div className="space-y-4">
                  {aiChallenges.length === 0 ? (
                    <div className="text-center py-12 border border-dashed border-neutral-800 rounded-xl">
                      <Swords className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
                      <p className="text-xs text-neutral-400">No AI challenges initiated yet</p>
                    </div>
                  ) : (
                    aiChallenges.map(challenge => (
                      <div key={challenge.id} className="p-4 rounded-xl border border-neutral-800 bg-neutral-900/60 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 text-xs font-mono font-semibold rounded bg-amber-500/10 text-amber-300 border border-amber-500/30 uppercase">
                              {challenge.subject}
                            </span>
                            <span className="text-xs text-neutral-400">Round {challenge.roundsCount} / 3</span>
                          </div>
                          <span className={`px-2 py-0.5 text-[10px] font-mono rounded border uppercase ${
                            challenge.outcome === 'accepted' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                            challenge.outcome === 'rejected' ? 'bg-rose-500/10 text-rose-400 border-rose-500/30' :
                            'bg-neutral-800 text-neutral-400 border-neutral-700'
                          }`}>
                            {challenge.outcome}
                          </span>
                        </div>

                        <div className="text-xs text-neutral-300 bg-neutral-950 p-3 rounded border border-neutral-800">
                          <div className="text-neutral-500 font-mono text-[10px] mb-1">PROPOSAL ({challenge.proposerRole}):</div>
                          {challenge.originalProposal}
                        </div>

                        {/* Arguments Feed */}
                        {challenge.arguments && challenge.arguments.length > 0 && (
                          <div className="space-y-2">
                            <h4 className="text-[11px] font-mono text-neutral-400 uppercase tracking-wider">Dialectic Arguments</h4>
                            {challenge.arguments.map(arg => (
                              <div key={arg.id} className="p-2.5 rounded bg-neutral-950 border border-neutral-800 text-xs">
                                <div className="flex items-center justify-between text-[10px] font-mono mb-1">
                                  <span className="text-amber-400">{arg.agentRole} (Round {arg.round})</span>
                                  <span className="text-neutral-500">{arg.argumentType}</span>
                                </div>
                                <p className="text-neutral-300">{arg.argument}</p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* 6. DEBUGGING & DEFECTS CENTER */}
            {activeCenter === 'defects' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-white">Collaborative Defect Tracking</h2>
                    <p className="text-xs text-neutral-400">Evidence-verified bug resolution: defects cannot be marked resolved without test proof</p>
                  </div>
                  <button
                    onClick={() => setShowNewDefect(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg hover:bg-rose-500/20 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Report Defect</span>
                  </button>
                </div>

                <div className="space-y-4">
                  {defects.length === 0 ? (
                    <div className="text-center py-12 border border-dashed border-neutral-800 rounded-xl">
                      <Bug className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
                      <p className="text-xs text-neutral-400">No defects reported in this build</p>
                    </div>
                  ) : (
                    defects.map(defect => (
                      <div key={defect.id} className="p-4 rounded-xl border border-neutral-800 bg-neutral-900/60 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className={`px-2 py-0.5 text-xs font-mono font-semibold rounded uppercase ${
                              defect.severity === 'critical' ? 'bg-red-500/20 text-red-300 border border-red-500/40' :
                              defect.severity === 'high' ? 'bg-orange-500/20 text-orange-300 border border-orange-500/40' :
                              'bg-neutral-800 text-neutral-400 border border-neutral-700'
                            }`}>
                              {defect.severity}
                            </span>
                            <span className="text-xs font-semibold text-white">{defect.title}</span>
                          </div>
                          <span className={`px-2 py-0.5 text-[10px] font-mono rounded border uppercase ${
                            defect.status === 'resolved' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                            'bg-neutral-800 text-neutral-400 border-neutral-700'
                          }`}>
                            {defect.status}
                          </span>
                        </div>

                        <p className="text-xs text-neutral-300">{defect.description}</p>

                        {defect.rootCause && (
                          <div className="text-xs bg-neutral-950 p-2.5 rounded border border-neutral-800 text-neutral-300">
                            <span className="text-neutral-500 font-mono text-[10px] block mb-1">IDENTIFIED ROOT CAUSE:</span>
                            {defect.rootCause}
                          </div>
                        )}

                        {defect.verificationEvidence && (
                          <div className="text-xs bg-emerald-950/20 p-2.5 rounded border border-emerald-800/40 text-emerald-300 font-mono">
                            <span className="text-emerald-500 text-[10px] block mb-1">VERIFICATION EVIDENCE:</span>
                            {defect.verificationEvidence}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* 7. CONFLICT RESOLUTION CENTER */}
            {activeCenter === 'conflicts' && (
              <div className="space-y-4">
                <div>
                  <h2 className="text-sm font-semibold text-white">File Conflict Coordination</h2>
                  <p className="text-xs text-neutral-400">Concurrent file collision detection with overlapping hunk diffs and safe resolution pipeline</p>
                </div>

                <div className="space-y-4">
                  {fileConflicts.length === 0 ? (
                    <div className="text-center py-12 border border-dashed border-neutral-800 rounded-xl">
                      <GitCompare className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
                      <p className="text-xs text-neutral-400">No active file conflicts detected</p>
                    </div>
                  ) : (
                    fileConflicts.map(conflict => (
                      <div key={conflict.id} className="p-4 rounded-xl border border-neutral-800 bg-neutral-900/60 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono font-bold text-amber-400">{conflict.targetFile}</span>
                            <span className="text-[11px] font-mono text-neutral-500">base v{conflict.baseFileVersion}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`px-2 py-0.5 text-[10px] font-mono rounded border uppercase ${
                              conflict.status === 'resolved' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                              'bg-amber-500/10 text-amber-400 border-amber-500/30'
                            }`}>
                              {conflict.status}
                            </span>
                            {conflict.status !== 'resolved' && (
                              <button
                                onClick={() => {
                                  setSelectedConflictId(conflict.id);
                                  setConflictResolvedContent('');
                                  setConflictExplanation('');
                                }}
                                className="px-2.5 py-1 text-xs font-medium text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg hover:bg-amber-500/20"
                              >
                                Resolve Conflict
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="text-xs text-neutral-300">
                          Overlapping lines: {conflict.overlappingHunks.map(h => `${h.startLine}-${h.endLine}`).join(', ')}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* 8. HUMAN APPROVALS CENTER */}
            {activeCenter === 'approvals' && (
              <div className="space-y-4">
                <div>
                  <h2 className="text-sm font-semibold text-white">Human-In-The-Loop Approval Gates</h2>
                  <p className="text-xs text-neutral-400">Strict safety boundary: agents are prohibited from self-approving high-impact actions</p>
                </div>

                <div className="space-y-4">
                  {approvalRequests.length === 0 ? (
                    <div className="text-center py-12 border border-dashed border-neutral-800 rounded-xl">
                      <ShieldCheck className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
                      <p className="text-xs text-neutral-400">No pending human approval requests</p>
                    </div>
                  ) : (
                    approvalRequests.map(req => (
                      <div key={req.id} className="p-4 rounded-xl border border-neutral-800 bg-neutral-900/60 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className={`px-2 py-0.5 text-xs font-mono font-semibold rounded uppercase ${
                              req.riskLevel === 'critical' ? 'bg-red-500/20 text-red-300 border border-red-500/40' :
                              req.riskLevel === 'high' ? 'bg-orange-500/20 text-orange-300 border border-orange-500/40' :
                              'bg-neutral-800 text-neutral-400 border border-neutral-700'
                            }`}>
                              {req.riskLevel}
                            </span>
                            <span className="text-xs font-mono text-neutral-300 font-semibold">{req.operationType.replace(/_/g, ' ')}</span>
                          </div>
                          <span className={`px-2 py-0.5 text-[10px] font-mono rounded border uppercase ${
                            req.status === 'approved' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                            req.status === 'rejected' ? 'bg-rose-500/10 text-rose-400 border-rose-500/30' :
                            'bg-amber-500/10 text-amber-300 border-amber-500/30 animate-pulse'
                          }`}>
                            {req.status}
                          </span>
                        </div>

                        <div className="text-xs text-neutral-300">
                          <span className="text-neutral-500 font-mono text-[10px] block mb-1">REQUESTED BY: {req.requestedByRole}</span>
                          {req.rationale}
                        </div>

                        {req.status === 'pending' && (
                          <div className="flex items-center gap-2 pt-2 border-t border-neutral-800">
                            <button
                              onClick={() => respondToApproval(req.id, true, 'Approved by human reviewer')}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/20"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>Authorize Operation</span>
                            </button>
                            <button
                              onClick={() => respondToApproval(req.id, false, 'Rejected by human reviewer')}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg hover:bg-rose-500/20"
                            >
                              <X className="w-3.5 h-3.5" />
                              <span>Deny Operation</span>
                            </button>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* 9. ACTIVITY TIMELINE */}
            {activeCenter === 'timeline' && (
              <div className="space-y-4">
                <div>
                  <h2 className="text-sm font-semibold text-white">Unified Swarm Event Stream</h2>
                  <p className="text-xs text-neutral-400">Live, persistent audit trail of every agent action, code review, patch and approval</p>
                </div>

                <div className="space-y-2">
                  {events.length === 0 ? (
                    <div className="text-center py-12 border border-dashed border-neutral-800 rounded-xl">
                      <Clock className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
                      <p className="text-xs text-neutral-400">No events recorded yet</p>
                    </div>
                  ) : (
                    events.slice(-50).reverse().map(ev => (
                      <div key={ev.id} className="p-3 rounded-lg border border-neutral-800 bg-neutral-900/40 text-xs flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-[10px] text-neutral-500">
                            {new Date(ev.timestamp).toLocaleTimeString()}
                          </span>
                          <span className="px-2 py-0.5 rounded bg-neutral-800 text-neutral-300 font-mono text-[10px] border border-neutral-700">
                            {ev.type}
                          </span>
                          <span className="text-neutral-300">{ev.message}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* MODAL: Compose Message */}
      {showComposeMessage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Broadcast Agent Message</h3>
              <button onClick={() => setShowComposeMessage(false)} className="text-neutral-500 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-[11px] font-mono text-neutral-400 block mb-1">Sender Role</label>
                <select 
                  value={newMessageRole} 
                  onChange={e => setNewMessageRole(e.target.value as AgentRole)}
                  className="w-full px-3 py-1.5 text-xs bg-neutral-950 border border-neutral-800 rounded text-neutral-200"
                >
                  {ALL_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>

              <div>
                <label className="text-[11px] font-mono text-neutral-400 block mb-1">Message Type</label>
                <select 
                  value={newMessageType} 
                  onChange={e => setNewMessageType(e.target.value as AgentMessageType)}
                  className="w-full px-3 py-1.5 text-xs bg-neutral-950 border border-neutral-800 rounded text-neutral-200"
                >
                  {MESSAGE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              <div>
                <label className="text-[11px] font-mono text-neutral-400 block mb-1">Content</label>
                <textarea 
                  rows={4}
                  value={newMessageContent}
                  onChange={e => setNewMessageContent(e.target.value)}
                  placeholder="Type message content..."
                  className="w-full px-3 py-2 text-xs bg-neutral-950 border border-neutral-800 rounded text-neutral-200 focus:outline-none focus:border-amber-500/50"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-neutral-800">
              <button 
                onClick={() => setShowComposeMessage(false)}
                className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white"
              >
                Cancel
              </button>
              <button 
                onClick={async () => {
                  if (!newMessageContent.trim()) return;
                  await sendAgentMessage({
                    senderRole: newMessageRole,
                    recipient: newMessageRecipient || undefined,
                    messageType: newMessageType,
                    content: newMessageContent
                  });
                  setNewMessageContent('');
                  setShowComposeMessage(false);
                }}
                className="px-3 py-1.5 text-xs font-semibold text-neutral-950 bg-amber-400 hover:bg-amber-300 rounded"
              >
                Send Message
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Review Verdict */}
      {selectedReviewId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-4 shadow-2xl">
            <h3 className="text-sm font-semibold text-white">Submit Code Review Verdict</h3>
            <div>
              <label className="text-[11px] font-mono text-neutral-400 block mb-1">Verdict</label>
              <select 
                value={reviewVerdict} 
                onChange={e => setReviewVerdict(e.target.value as CodeReviewVerdict)}
                className="w-full px-3 py-1.5 text-xs bg-neutral-950 border border-neutral-800 rounded text-neutral-200"
              >
                <option value="approved">Approved</option>
                <option value="approved_with_suggestions">Approved with Suggestions</option>
                <option value="changes_requested">Changes Requested</option>
                <option value="rejected">Rejected</option>
                <option value="blocked">Blocked</option>
              </select>
            </div>

            <div>
              <label className="text-[11px] font-mono text-neutral-400 block mb-1">Summary Rationale</label>
              <textarea 
                rows={3}
                value={reviewSummary}
                onChange={e => setReviewSummary(e.target.value)}
                placeholder="Review rationale and suggestions..."
                className="w-full px-3 py-2 text-xs bg-neutral-950 border border-neutral-800 rounded text-neutral-200"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-neutral-800">
              <button onClick={() => setSelectedReviewId(null)} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white">
                Cancel
              </button>
              <button 
                onClick={async () => {
                  await submitReviewVerdict(selectedReviewId, reviewVerdict, {}, reviewSummary);
                  setSelectedReviewId(null);
                }}
                className="px-3 py-1.5 text-xs font-semibold text-neutral-950 bg-amber-400 hover:bg-amber-300 rounded"
              >
                Submit Verdict
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Resolve Conflict */}
      {selectedConflictId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-4 shadow-2xl">
            <h3 className="text-sm font-semibold text-white">Resolve File Collision</h3>
            <div>
              <label className="text-[11px] font-mono text-neutral-400 block mb-1">Resolved File Content</label>
              <textarea 
                rows={6}
                value={conflictResolvedContent}
                onChange={e => setConflictResolvedContent(e.target.value)}
                placeholder="Paste final resolved content..."
                className="w-full px-3 py-2 text-xs font-mono bg-neutral-950 border border-neutral-800 rounded text-neutral-200"
              />
            </div>
            <div>
              <label className="text-[11px] font-mono text-neutral-400 block mb-1">Resolution Explanation</label>
              <input 
                type="text"
                value={conflictExplanation}
                onChange={e => setConflictExplanation(e.target.value)}
                placeholder="Explanation of resolution..."
                className="w-full px-3 py-1.5 text-xs bg-neutral-950 border border-neutral-800 rounded text-neutral-200"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-neutral-800">
              <button onClick={() => setSelectedConflictId(null)} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white">
                Cancel
              </button>
              <button 
                onClick={async () => {
                  if (!conflictResolvedContent.trim()) return;
                  await resolveFileConflict(selectedConflictId, conflictResolvedContent, conflictExplanation);
                  setSelectedConflictId(null);
                }}
                className="px-3 py-1.5 text-xs font-semibold text-neutral-950 bg-amber-400 hover:bg-amber-300 rounded"
              >
                Apply Resolved Merge
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Report Defect */}
      {showNewDefect && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-3 shadow-2xl">
            <h3 className="text-sm font-semibold text-white">Report New Defect</h3>
            <input 
              type="text"
              value={defectTitle}
              onChange={e => setDefectTitle(e.target.value)}
              placeholder="Defect Title"
              className="w-full px-3 py-1.5 text-xs bg-neutral-950 border border-neutral-800 rounded text-neutral-200"
            />
            <textarea 
              rows={2}
              value={defectDesc}
              onChange={e => setDefectDesc(e.target.value)}
              placeholder="Description"
              className="w-full px-3 py-1.5 text-xs bg-neutral-950 border border-neutral-800 rounded text-neutral-200"
            />
            <div className="flex justify-end gap-2 pt-2 border-t border-neutral-800">
              <button onClick={() => setShowNewDefect(false)} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white">
                Cancel
              </button>
              <button 
                onClick={async () => {
                  if (!defectTitle.trim()) return;
                  await recordDefect({
                    title: defectTitle,
                    description: defectDesc,
                    severity: defectSeverity,
                    reproductionSteps: [defectSteps || 'Run verification'],
                    expectedBehavior: defectExpected || 'Pass checks',
                    actualBehavior: defectActual || 'Encountered defect',
                    affectedFiles: defectFiles ? [defectFiles] : []
                  });
                  setShowNewDefect(false);
                }}
                className="px-3 py-1.5 text-xs font-semibold text-neutral-950 bg-amber-400 hover:bg-amber-300 rounded"
              >
                Record Defect
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Initiate Challenge */}
      {showNewChallenge && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-3 shadow-2xl">
            <h3 className="text-sm font-semibold text-white">Initiate Dialectic Challenge</h3>
            <div>
              <label className="text-[11px] font-mono text-neutral-400 block mb-1">Subject</label>
              <select 
                value={challengeSubject} 
                onChange={e => setChallengeSubject(e.target.value as AIChallengeSubject)}
                className="w-full px-3 py-1.5 text-xs bg-neutral-950 border border-neutral-800 rounded text-neutral-200"
              >
                {['architecture', 'database_design', 'api_contracts', 'security', 'performance', 'algorithms', 'dependencies', 'implementation_strategy', 'testing_strategy', 'maintainability'].map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-mono text-neutral-400 block mb-1">Original Proposal</label>
              <textarea 
                rows={3}
                value={challengeProposal}
                onChange={e => setChallengeProposal(e.target.value)}
                placeholder="State the technical proposal to challenge..."
                className="w-full px-3 py-1.5 text-xs bg-neutral-950 border border-neutral-800 rounded text-neutral-200"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-neutral-800">
              <button onClick={() => setShowNewChallenge(false)} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white">
                Cancel
              </button>
              <button 
                onClick={async () => {
                  if (!challengeProposal.trim()) return;
                  await startAIChallenge({
                    subject: challengeSubject,
                    originalProposal: challengeProposal,
                    proposerRole: challengeProposer,
                    challengerRole: challengeChallenger
                  });
                  setShowNewChallenge(false);
                }}
                className="px-3 py-1.5 text-xs font-semibold text-neutral-950 bg-amber-400 hover:bg-amber-300 rounded"
              >
                Start Challenge
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
