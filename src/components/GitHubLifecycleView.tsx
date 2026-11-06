import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { useSwarm } from '../context/SwarmContext.js';
import {
  Github,
  GitBranch,
  GitCommit,
  GitPullRequest,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Download,
  Upload,
  ShieldAlert,
  ShieldCheck,
  FolderGit2,
  Lock,
  Unlock,
  FileCode,
  ArrowRight,
  History,
  Plus,
  ExternalLink,
  ChevronRight,
  GitMerge,
  Eye,
  Check,
  X
} from 'lucide-react';
import {
  GitHubRepoInfo,
  GitHubBranchInfo,
  GitHubCommitInfo,
  GitHubPullRequestInfo,
  GitHubFileDiff,
  GitHubConflictRecord
} from '../types/index.js';

export const GitHubLifecycleView: React.FC = () => {
  const { user, connectGitHubPAT } = useAuth();
  const { activeBuild, fetchBuildDetails } = useSwarm();

  const [activeSubTab, setActiveSubTab] = useState<'repos' | 'branches' | 'diff' | 'pulls' | 'sync' | 'history'>('repos');

  // Connection & User Status
  const [accountStatus, setAccountStatus] = useState<{ connected: boolean; username?: string; name?: string; avatarUrl?: string; publicRepos?: number } | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [patInput, setPatInput] = useState('');
  const [patError, setPatError] = useState<string | null>(null);

  // Repositories
  const [repos, setRepos] = useState<GitHubRepoInfo[]>([]);
  const [repoSearch, setRepoSearch] = useState('');
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [importingRepo, setImportingRepo] = useState(false);
  const [importFeedback, setImportFeedback] = useState<string | null>(null);

  // Branches
  const [branches, setBranches] = useState<GitHubBranchInfo[]>([]);
  const [newBranchName, setNewBranchName] = useState('');
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchFeedback, setBranchFeedback] = useState<string | null>(null);

  // Diffs & Commit
  const [diffFiles, setDiffFiles] = useState<GitHubFileDiff[]>([]);
  const [diffSummary, setDiffSummary] = useState<any>(null);
  const [selectedFileForDiff, setSelectedFileForDiff] = useState<GitHubFileDiff | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [commitFeedback, setCommitFeedback] = useState<string | null>(null);
  const [pendingApprovalReq, setPendingApprovalReq] = useState<any>(null);

  // Pull Requests
  const [pullRequests, setPullRequests] = useState<GitHubPullRequestInfo[]>([]);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [creatingPr, setCreatingPr] = useState(false);
  const [prFeedback, setPrFeedback] = useState<string | null>(null);

  // Sync & Conflicts
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [conflicts, setConflicts] = useState<GitHubConflictRecord[]>([]);
  const [activeConflict, setActiveConflict] = useState<GitHubConflictRecord | null>(null);
  const [manualResolvedContent, setManualResolvedContent] = useState('');

  // Commit History
  const [commits, setCommits] = useState<GitHubCommitInfo[]>([]);
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [selectedCommitDetails, setSelectedCommitDetails] = useState<any>(null);

  const currentBuild = activeBuild;

  // Load account status
  const loadAccountStatus = async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch('/api/github/status');
      if (res.ok) {
        const data = await res.json();
        setAccountStatus(data);
      }
    } catch {
      setAccountStatus(null);
    } finally {
      setLoadingStatus(false);
    }
  };

  // Load repos
  const loadRepos = async () => {
    setLoadingRepos(true);
    try {
      const res = await fetch('/api/github/repos');
      if (res.ok) {
        const data = await res.json();
        setRepos(data.repos || []);
      }
    } catch {
      setRepos([]);
    } finally {
      setLoadingRepos(false);
    }
  };

  // Load project branches
  const loadBranches = async () => {
    if (!currentBuild) return;
    setBranchLoading(true);
    try {
      const res = await fetch(`/api/builds/${currentBuild.id}/github/branches`);
      if (res.ok) {
        const data = await res.json();
        setBranches(data.branches || []);
      }
    } catch {
      setBranches([]);
    } finally {
      setBranchLoading(false);
    }
  };

  // Load diffs
  const loadDiff = async () => {
    if (!currentBuild) return;
    try {
      const res = await fetch(`/api/builds/${currentBuild.id}/github/diff`);
      if (res.ok) {
        const data = await res.json();
        setDiffFiles(data.files || []);
        setDiffSummary(data.summary || null);
        if (data.files && data.files.length > 0) {
          setSelectedFileForDiff(data.files[0]);
        }
      }
    } catch {}
  };

  // Load pull requests
  const loadPullRequests = async () => {
    if (!currentBuild) return;
    try {
      const res = await fetch(`/api/builds/${currentBuild.id}/github/pulls?state=all`);
      if (res.ok) {
        const data = await res.json();
        setPullRequests(data.pulls || []);
      }
    } catch {
      setPullRequests([]);
    }
  };

  // Load conflicts
  const loadConflicts = async () => {
    if (!currentBuild) return;
    try {
      const res = await fetch(`/api/builds/${currentBuild.id}/github/conflicts`);
      if (res.ok) {
        const data = await res.json();
        setConflicts(data.conflicts || []);
        if (data.conflicts && data.conflicts.length > 0) {
          setActiveConflict(data.conflicts[0]);
          setManualResolvedContent(data.conflicts[0].localContent);
        }
      }
    } catch {
      setConflicts([]);
    }
  };

  // Load commits
  const loadCommits = async () => {
    if (!currentBuild) return;
    setLoadingCommits(true);
    try {
      const res = await fetch(`/api/builds/${currentBuild.id}/github/commits`);
      if (res.ok) {
        const data = await res.json();
        setCommits(data.commits || []);
      }
    } catch {
      setCommits([]);
    } finally {
      setLoadingCommits(false);
    }
  };

  useEffect(() => {
    loadAccountStatus();
  }, [user]);

  useEffect(() => {
    if (accountStatus?.connected) {
      loadRepos();
    }
  }, [accountStatus?.connected]);

  useEffect(() => {
    if (currentBuild && accountStatus?.connected) {
      if (activeSubTab === 'branches') loadBranches();
      if (activeSubTab === 'diff') loadDiff();
      if (activeSubTab === 'pulls') loadPullRequests();
      if (activeSubTab === 'sync') loadConflicts();
      if (activeSubTab === 'history') loadCommits();
    }
  }, [activeSubTab, currentBuild?.id]);

  // Handle Connect PAT
  const handleConnectPAT = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patInput.trim()) return;
    setPatError(null);
    const success = await connectGitHubPAT(patInput.trim());
    if (success) {
      setPatInput('');
      await loadAccountStatus();
    } else {
      setPatError('Failed to validate Personal Access Token. Verify repo scopes.');
    }
  };

  // Handle Import Repository
  const handleImportRepo = async (owner: string, repo: string, defaultBranch: string) => {
    setImportingRepo(true);
    setImportFeedback(`Importing ${owner}/${repo}...`);
    try {
      const res = await fetch('/api/github/import-repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner, repo, branch: defaultBranch })
      });
      const data = await res.json();
      if (res.ok) {
        setImportFeedback(`Imported ${data.importedFilesCount} files into project!`);
        await fetchBuildDetails(data.buildId);
        setActiveSubTab('diff');
      } else {
        setImportFeedback(`Import failed: ${data.error}`);
      }
    } catch (err: any) {
      setImportFeedback(`Import error: ${err.message}`);
    } finally {
      setImportingRepo(false);
    }
  };

  // Handle Connect to existing build
  const handleConnectRepo = async (owner: string, repo: string, defaultBranch: string) => {
    if (!currentBuild) return;
    try {
      const res = await fetch(`/api/builds/${currentBuild.id}/github/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner, repo, branch: defaultBranch })
      });
      if (res.ok) {
        await fetchBuildDetails(currentBuild.id);
        setImportFeedback(`Project linked to ${owner}/${repo}`);
      }
    } catch {}
  };

  // Handle Create Branch
  const handleCreateBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentBuild || !newBranchName.trim()) return;
    setBranchFeedback(null);
    try {
      const res = await fetch(`/api/builds/${currentBuild.id}/github/branches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newBranch: newBranchName.trim() })
      });
      const data = await res.json();
      if (res.ok) {
        setNewBranchName('');
        setBranchFeedback(`Branch "${data.branch}" created successfully!`);
        await loadBranches();
        await fetchBuildDetails(currentBuild.id);
      } else {
        setBranchFeedback(`Failed: ${data.error}`);
      }
    } catch (err: any) {
      setBranchFeedback(`Error: ${err.message}`);
    }
  };

  // Handle Switch Branch
  const handleSwitchBranch = async (branchName: string, checkout: boolean) => {
    if (!currentBuild) return;
    try {
      const res = await fetch(`/api/builds/${currentBuild.id}/github/switch-branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: branchName, checkoutFiles: checkout })
      });
      const data = await res.json();
      if (data.hasLocalChanges) {
        setBranchFeedback('Uncommitted local changes detected. Commit or stash your changes before checking out.');
      } else if (res.ok) {
        setBranchFeedback(`Switched to branch "${branchName}"`);
        await fetchBuildDetails(currentBuild.id);
        await loadBranches();
      } else {
        setBranchFeedback(`Failed: ${data.error}`);
      }
    } catch (err: any) {
      setBranchFeedback(`Error: ${err.message}`);
    }
  };

  // Handle Commit Changes
  const handleCommit = async (approvalId?: string) => {
    if (!currentBuild || (!commitMessage.trim() && !approvalId)) return;
    setCommitting(true);
    setCommitFeedback(null);
    try {
      const res = await fetch(`/api/builds/${currentBuild.id}/github/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: commitMessage.trim() || 'Approved sensitive commit',
          approvalRequestId: approvalId
        })
      });
      const data = await res.json();
      if (res.status === 202 && data.requiresApproval) {
        setPendingApprovalReq(data.approvalRequest);
        setCommitFeedback('Human Approval Required: Commit touches sensitive files or default branch.');
      } else if (res.ok && data.success) {
        setCommitFeedback(`Committed commit ${data.commitSha.slice(0, 7)} to branch "${data.branch}"!`);
        setCommitMessage('');
        setPendingApprovalReq(null);
        await loadDiff();
        await fetchBuildDetails(currentBuild.id);
      } else {
        setCommitFeedback(`Commit failed: ${data.error}`);
      }
    } catch (err: any) {
      setCommitFeedback(`Error: ${err.message}`);
    } finally {
      setCommitting(false);
    }
  };

  // Handle Respond to Approval Gate
  const handleApproveCommitGate = async () => {
    if (!currentBuild || !pendingApprovalReq) return;
    try {
      const res = await fetch(`/api/builds/${currentBuild.id}/collaboration/approvals/${pendingApprovalReq.id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', notes: 'Approved via GitHub Lifecycle console' })
      });
      if (res.ok) {
        // Execute commit with approval ID
        await handleCommit(pendingApprovalReq.id);
      }
    } catch (err: any) {
      setCommitFeedback(`Approval response error: ${err.message}`);
    }
  };

  // Handle Create Pull Request
  const handleCreatePullRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentBuild || !prTitle.trim()) return;
    setCreatingPr(true);
    setPrFeedback(null);
    try {
      const res = await fetch(`/api/builds/${currentBuild.id}/github/pulls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: prTitle.trim(), body: prBody.trim() })
      });
      const data = await res.json();
      if (res.ok) {
        setPrTitle('');
        setPrBody('');
        setPrFeedback(`Pull Request #${data.pullRequest.number} opened successfully!`);
        await loadPullRequests();
        await fetchBuildDetails(currentBuild.id);
      } else {
        setPrFeedback(`Failed: ${data.error}`);
      }
    } catch (err: any) {
      setPrFeedback(`Error: ${err.message}`);
    } finally {
      setCreatingPr(false);
    }
  };

  // Handle Merge Pull Request
  const handleMergePullRequest = async (pullNumber: number) => {
    if (!currentBuild) return;
    try {
      const res = await fetch(`/api/builds/${currentBuild.id}/github/pulls/${pullNumber}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mergeMethod: 'merge' })
      });
      const data = await res.json();
      if (res.ok) {
        setPrFeedback(`PR #${pullNumber} merged successfully!`);
        await loadPullRequests();
      } else {
        setPrFeedback(`Merge failed: ${data.error}`);
      }
    } catch (err: any) {
      setPrFeedback(`Error: ${err.message}`);
    }
  };

  // Handle Synchronize Changes
  const handleSync = async () => {
    if (!currentBuild) return;
    setSyncing(true);
    setSyncStatus('Synchronizing with GitHub...');
    try {
      const res = await fetch(`/api/builds/${currentBuild.id}/github/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (data.status === 'conflicts_detected') {
        setSyncStatus(`Conflicts detected on ${data.conflicts?.length || 1} file(s). Manual resolution required.`);
        await loadConflicts();
      } else if (data.status === 'synced') {
        setSyncStatus(`Sync complete! Pulled ${data.syncedFilesCount} file(s).`);
        await loadDiff();
        await fetchBuildDetails(currentBuild.id);
      } else {
        setSyncStatus(data.message || 'Workspace is up-to-date.');
      }
    } catch (err: any) {
      setSyncStatus(`Sync error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  // Handle Resolve Conflict
  const handleResolveConflict = async (resolutionType: 'ours' | 'theirs' | 'manual') => {
    if (!currentBuild || !activeConflict) return;
    try {
      const res = await fetch(`/api/builds/${currentBuild.id}/github/conflicts/${activeConflict.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolutionType,
          resolvedContent: resolutionType === 'manual' ? manualResolvedContent : undefined
        })
      });
      const data = await res.json();
      if (res.ok) {
        await loadConflicts();
        if (data.allResolved) {
          setSyncStatus('All conflicts resolved! Project synchronization complete.');
        }
      }
    } catch {}
  };

  const filteredRepos = repos.filter(r =>
    r.name.toLowerCase().includes(repoSearch.toLowerCase()) ||
    (r.description && r.description.toLowerCase().includes(repoSearch.toLowerCase()))
  );

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      {/* Header & Status Card */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-neutral-950 border border-neutral-800 flex items-center justify-center text-amber-400">
              <Github className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-white font-sans">GitHub Lifecycle & Repository Sync</h1>
                <span className="px-2 py-0.5 text-[11px] font-mono rounded-full bg-neutral-800 text-neutral-400 border border-neutral-700">
                  Phase 14
                </span>
              </div>
              <p className="text-xs text-neutral-400 mt-1">
                Authentic GitHub Git Data API, branch switching, atomic commits, pull requests, and non-destructive sync.
              </p>
            </div>
          </div>

          {/* Account Status Badge */}
          <div className="flex items-center gap-3">
            {accountStatus?.connected ? (
              <div className="flex items-center gap-2.5 px-3.5 py-1.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-xs">
                {accountStatus.avatarUrl && (
                  <img src={accountStatus.avatarUrl} alt="Avatar" className="w-5 h-5 rounded-full" />
                )}
                <span className="font-medium text-emerald-400">@{accountStatus.username}</span>
                <span className="text-neutral-500 font-mono">({accountStatus.publicRepos || 0} repos)</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-amber-400 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  GitHub Not Connected
                </span>
              </div>
            )}
          </div>
        </div>

        {/* If Not Connected: Connect PAT Input */}
        {!accountStatus?.connected && (
          <div className="mt-6 pt-6 border-t border-neutral-800">
            <form onSubmit={handleConnectPAT} className="flex flex-col sm:flex-row gap-3 items-center">
              <input
                type="password"
                placeholder="Paste Personal Access Token (repo, user:email)"
                value={patInput}
                onChange={e => setPatInput(e.target.value)}
                className="flex-1 w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-xs text-neutral-200 placeholder-neutral-500 font-mono focus:outline-none focus:border-amber-400/50"
              />
              <button
                type="submit"
                className="w-full sm:w-auto px-4 py-2 bg-amber-400 hover:bg-amber-300 text-neutral-950 font-semibold text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5 shrink-0"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Connect Token</span>
              </button>
            </form>
            {patError && <p className="text-xs text-rose-400 mt-2 font-mono">{patError}</p>}
          </div>
        )}

        {/* Current Project & Linked Repo Ribbon */}
        {currentBuild && (
          <div className="mt-4 pt-4 border-t border-neutral-800/80 flex flex-wrap items-center justify-between gap-4 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-neutral-500">Active Project:</span>
              <span className="font-semibold text-neutral-200">{currentBuild.idea}</span>
              <span className="font-mono text-neutral-500 text-[11px]">({currentBuild.id})</span>
            </div>

            <div className="flex items-center gap-3">
              {currentBuild.githubRepoUrl ? (
                <div className="flex items-center gap-2">
                  <FolderGit2 className="w-3.5 h-3.5 text-cyan-400" />
                  <a
                    href={currentBuild.githubRepoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-cyan-400 hover:underline font-mono flex items-center gap-1"
                  >
                    <span>{currentBuild.githubOwner}/{currentBuild.githubRepoName || 'repo'}</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                  <span className="text-neutral-600">·</span>
                  <span className="px-2 py-0.5 bg-neutral-950 border border-neutral-800 rounded font-mono text-neutral-300 flex items-center gap-1">
                    <GitBranch className="w-3 h-3 text-amber-400" />
                    <span>{currentBuild.gitBranch || 'main'}</span>
                  </span>
                </div>
              ) : (
                <span className="text-amber-400/80 text-xs">Not linked to GitHub repo yet</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Navigation Sub-Tabs */}
      <div className="flex items-center gap-2 border-b border-neutral-800 pb-2 overflow-x-auto text-xs font-medium">
        <button
          onClick={() => setActiveSubTab('repos')}
          className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            activeSubTab === 'repos' ? 'bg-amber-400 text-neutral-950 font-bold' : 'text-neutral-400 hover:text-white hover:bg-neutral-900'
          }`}
        >
          <FolderGit2 className="w-3.5 h-3.5" />
          <span>Repositories & Import</span>
        </button>
        <button
          onClick={() => setActiveSubTab('branches')}
          className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            activeSubTab === 'branches' ? 'bg-amber-400 text-neutral-950 font-bold' : 'text-neutral-400 hover:text-white hover:bg-neutral-900'
          }`}
        >
          <GitBranch className="w-3.5 h-3.5" />
          <span>Branches</span>
        </button>
        <button
          onClick={() => setActiveSubTab('diff')}
          className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            activeSubTab === 'diff' ? 'bg-amber-400 text-neutral-950 font-bold' : 'text-neutral-400 hover:text-white hover:bg-neutral-900'
          }`}
        >
          <GitCommit className="w-3.5 h-3.5" />
          <span>Changes & Commit</span>
          {diffFiles.length > 0 && (
            <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
              activeSubTab === 'diff' ? 'bg-neutral-950 text-amber-300' : 'bg-amber-400/20 text-amber-300'
            }`}>
              {diffFiles.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveSubTab('pulls')}
          className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            activeSubTab === 'pulls' ? 'bg-amber-400 text-neutral-950 font-bold' : 'text-neutral-400 hover:text-white hover:bg-neutral-900'
          }`}
        >
          <GitPullRequest className="w-3.5 h-3.5" />
          <span>Pull Requests</span>
        </button>
        <button
          onClick={() => setActiveSubTab('sync')}
          className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            activeSubTab === 'sync' ? 'bg-amber-400 text-neutral-950 font-bold' : 'text-neutral-400 hover:text-white hover:bg-neutral-900'
          }`}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Sync & Conflicts</span>
          {conflicts.filter(c => c.status === 'unresolved').length > 0 && (
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-rose-500 text-white">
              {conflicts.filter(c => c.status === 'unresolved').length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveSubTab('history')}
          className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            activeSubTab === 'history' ? 'bg-amber-400 text-neutral-950 font-bold' : 'text-neutral-400 hover:text-white hover:bg-neutral-900'
          }`}
        >
          <History className="w-3.5 h-3.5" />
          <span>Commit History</span>
        </button>
      </div>

      {/* Sub-Tab 1: Repositories & Import */}
      {activeSubTab === 'repos' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
            <input
              type="text"
              placeholder="Search authorized repositories..."
              value={repoSearch}
              onChange={e => setRepoSearch(e.target.value)}
              className="w-full sm:w-80 px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-xs text-neutral-200 placeholder-neutral-500 font-mono focus:outline-none focus:border-amber-400/50"
            />
            <button
              onClick={loadRepos}
              disabled={loadingRepos}
              className="px-3 py-1.5 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 text-xs rounded-lg border border-neutral-800 transition-colors flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingRepos ? 'animate-spin' : ''}`} />
              <span>Refresh Repositories</span>
            </button>
          </div>

          {importFeedback && (
            <div className="p-3 bg-neutral-900 border border-neutral-800 rounded-lg text-xs font-mono text-amber-300">
              {importFeedback}
            </div>
          )}

          {loadingRepos ? (
            <div className="p-12 text-center text-xs text-neutral-500 font-mono">Loading repositories from GitHub API...</div>
          ) : filteredRepos.length === 0 ? (
            <div className="p-12 text-center text-xs text-neutral-500 font-mono">No repositories found. Connect your account in Settings.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredRepos.map(repo => (
                <div key={repo.id} className="p-4 bg-neutral-900 border border-neutral-800 rounded-xl space-y-3 hover:border-neutral-700 transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-white font-mono">{repo.name}</span>
                        {repo.private ? (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-neutral-800 text-neutral-400 border border-neutral-700 flex items-center gap-1">
                            <Lock className="w-2.5 h-2.5" />
                            Private
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-neutral-800 text-neutral-400 border border-neutral-700 flex items-center gap-1">
                            <Unlock className="w-2.5 h-2.5" />
                            Public
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-neutral-400 mt-1 line-clamp-2">
                        {repo.description || 'No description provided.'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-neutral-500 pt-2 border-t border-neutral-800/80">
                    <span className="font-mono">Branch: {repo.defaultBranch}</span>
                    <div className="flex items-center gap-2">
                      {repo.permissions?.push ? (
                        <span className="text-emerald-400 text-[10px]">Read/Write</span>
                      ) : (
                        <span className="text-amber-400 text-[10px]">Read-Only</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-2">
                    <button
                      onClick={() => handleImportRepo(repo.owner, repo.name, repo.defaultBranch)}
                      disabled={importingRepo}
                      className="flex-1 py-1.5 px-3 bg-neutral-950 hover:bg-neutral-800 text-neutral-200 border border-neutral-800 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
                    >
                      <Download className="w-3.5 h-3.5 text-amber-400" />
                      <span>Import as Project</span>
                    </button>
                    {currentBuild && (
                      <button
                        onClick={() => handleConnectRepo(repo.owner, repo.name, repo.defaultBranch)}
                        className="py-1.5 px-3 bg-neutral-950 hover:bg-neutral-800 text-neutral-200 border border-neutral-800 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
                        title="Link current project to this repository"
                      >
                        <FolderGit2 className="w-3.5 h-3.5 text-cyan-400" />
                        <span>Link</span>
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sub-Tab 2: Branches */}
      {activeSubTab === 'branches' && (
        <div className="space-y-6">
          {/* Create Branch Card */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Plus className="w-4 h-4 text-amber-400" />
              <span>Create New Feature Branch</span>
            </h2>
            <form onSubmit={handleCreateBranch} className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                placeholder="e.g. feature/autonomous-auth"
                value={newBranchName}
                onChange={e => setNewBranchName(e.target.value)}
                className="flex-1 px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-xs text-neutral-200 font-mono placeholder-neutral-500 focus:outline-none focus:border-amber-400/50"
              />
              <button
                type="submit"
                disabled={branchLoading || !newBranchName.trim()}
                className="px-4 py-2 bg-amber-400 hover:bg-amber-300 text-neutral-950 font-semibold text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5"
              >
                <GitBranch className="w-3.5 h-3.5" />
                <span>Create & Switch Branch</span>
              </button>
            </form>
            {branchFeedback && <p className="text-xs font-mono text-amber-300">{branchFeedback}</p>}
          </div>

          {/* Branch List */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-neutral-800 flex items-center justify-between">
              <span className="text-xs font-bold text-white font-mono">Remote Repository Branches</span>
              <button
                onClick={loadBranches}
                className="text-xs text-neutral-400 hover:text-white flex items-center gap-1"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${branchLoading ? 'animate-spin' : ''}`} />
                <span>Reload</span>
              </button>
            </div>
            <div className="divide-y divide-neutral-800">
              {branches.map(b => (
                <div key={b.name} className="p-3.5 flex items-center justify-between gap-4 text-xs">
                  <div className="flex items-center gap-2.5">
                    <GitBranch className={`w-4 h-4 ${b.isDefault ? 'text-amber-400' : 'text-neutral-400'}`} />
                    <span className="font-mono font-medium text-neutral-200">{b.name}</span>
                    {b.isDefault && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-400/20 text-amber-300 border border-amber-400/30">
                        Default
                      </span>
                    )}
                    {b.protected && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-neutral-800 text-neutral-400 border border-neutral-700">
                        Protected
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-neutral-500 font-mono text-[11px]">{b.commitSha.slice(0, 7)}</span>
                    {currentBuild?.gitBranch === b.name ? (
                      <span className="px-2.5 py-1 text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded text-[11px] font-mono">
                        Active Branch
                      </span>
                    ) : (
                      <button
                        onClick={() => handleSwitchBranch(b.name, true)}
                        className="px-2.5 py-1 bg-neutral-950 hover:bg-neutral-800 border border-neutral-800 rounded text-neutral-300 hover:text-white text-[11px] transition-colors"
                      >
                        Checkout
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Sub-Tab 3: Changes & Commit */}
      {activeSubTab === 'diff' && (
        <div className="space-y-6">
          {/* Sensitive Alert or Pending Approval Gate */}
          {pendingApprovalReq && (
            <div className="p-4 bg-amber-500/10 border border-amber-500/40 rounded-xl space-y-3">
              <div className="flex items-start gap-3">
                <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h3 className="text-sm font-bold text-amber-300">Human Approval Gate Required</h3>
                  <p className="text-xs text-neutral-300">{pendingApprovalReq.explanation}</p>
                  <p className="text-[11px] font-mono text-neutral-400">
                    Operation: {pendingApprovalReq.operationType} · Risk: {pendingApprovalReq.riskLevel.toUpperCase()}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleApproveCommitGate}
                  disabled={committing}
                  className="px-4 py-1.5 bg-amber-400 hover:bg-amber-300 text-neutral-950 font-bold text-xs rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Authorize & Commit</span>
                </button>
                <button
                  onClick={() => setPendingApprovalReq(null)}
                  className="px-3 py-1.5 bg-neutral-900 hover:bg-neutral-800 text-neutral-400 text-xs rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Commit Box */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <GitCommit className="w-4 h-4 text-amber-400" />
              <span>Commit Changes to GitHub</span>
            </h3>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                placeholder="Commit message (e.g. Implement full-stack connected topology)"
                value={commitMessage}
                onChange={e => setCommitMessage(e.target.value)}
                className="flex-1 px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-xs text-neutral-200 font-mono placeholder-neutral-500 focus:outline-none focus:border-amber-400/50"
              />
              <button
                onClick={() => handleCommit()}
                disabled={committing || diffFiles.length === 0 || !commitMessage.trim()}
                className="px-5 py-2 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-neutral-950 font-semibold text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>{committing ? 'Committing...' : 'Commit to GitHub'}</span>
              </button>
            </div>
            {commitFeedback && (
              <p className="text-xs font-mono text-amber-300">{commitFeedback}</p>
            )}
          </div>

          {/* Diff Viewer Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* File List Column */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden flex flex-col h-[500px]">
              <div className="p-3.5 border-b border-neutral-800 flex items-center justify-between text-xs">
                <span className="font-bold text-white font-mono">Changed Files ({diffFiles.length})</span>
                <button onClick={loadDiff} className="text-neutral-400 hover:text-white">
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="divide-y divide-neutral-800/80 overflow-y-auto flex-1">
                {diffFiles.length === 0 ? (
                  <div className="p-8 text-center text-xs text-neutral-500 font-mono">
                    Working tree clean. No local modifications.
                  </div>
                ) : (
                  diffFiles.map(file => (
                    <button
                      key={file.path}
                      onClick={() => setSelectedFileForDiff(file)}
                      className={`w-full text-left p-3 text-xs transition-colors flex items-center justify-between gap-2 ${
                        selectedFileForDiff?.path === file.path ? 'bg-neutral-800 text-white' : 'text-neutral-300 hover:bg-neutral-800/50'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <FileCode className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                        <span className="truncate font-mono">{file.path}</span>
                        {file.isSensitive && (
                          <span className="px-1 text-[9px] font-bold rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                            SENSITIVE
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 text-[10px] font-mono">
                        {file.additions > 0 && <span className="text-emerald-400">+{file.additions}</span>}
                        {file.deletions > 0 && <span className="text-rose-400">-{file.deletions}</span>}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Diff Content Column */}
            <div className="lg:col-span-2 bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden flex flex-col h-[500px]">
              <div className="p-3.5 border-b border-neutral-800 flex items-center justify-between text-xs">
                <span className="font-mono text-neutral-300 font-semibold truncate">
                  {selectedFileForDiff ? selectedFileForDiff.path : 'Select a file to inspect diff'}
                </span>
                {selectedFileForDiff && (
                  <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                    selectedFileForDiff.status === 'added' ? 'bg-emerald-500/20 text-emerald-300' :
                    selectedFileForDiff.status === 'deleted' ? 'bg-rose-500/20 text-rose-300' :
                    'bg-cyan-500/20 text-cyan-300'
                  }`}>
                    {selectedFileForDiff.status.toUpperCase()}
                  </span>
                )}
              </div>
              <div className="p-4 bg-neutral-950 font-mono text-[11px] overflow-auto flex-1 leading-relaxed">
                {selectedFileForDiff ? (
                  selectedFileForDiff.diffHunks.map((line, idx) => (
                    <div
                      key={idx}
                      className={`px-2 py-0.5 whitespace-pre ${
                        line.startsWith('+') ? 'bg-emerald-950/40 text-emerald-300' :
                        line.startsWith('-') ? 'bg-rose-950/40 text-rose-300' :
                        'text-neutral-400'
                      }`}
                    >
                      {line}
                    </div>
                  ))
                ) : (
                  <div className="p-12 text-center text-neutral-500">No file selected.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sub-Tab 4: Pull Requests */}
      {activeSubTab === 'pulls' && (
        <div className="space-y-6">
          {/* Create PR Card */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Plus className="w-4 h-4 text-amber-400" />
              <span>Open New Pull Request</span>
            </h3>
            <form onSubmit={handleCreatePullRequest} className="space-y-3">
              <input
                type="text"
                placeholder="Pull Request title (e.g. Implement SquadForge Autonomous Architecture)"
                value={prTitle}
                onChange={e => setPrTitle(e.target.value)}
                className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-xs text-neutral-200 font-mono placeholder-neutral-500 focus:outline-none focus:border-amber-400/50"
              />
              <textarea
                placeholder="Pull request body / specification details..."
                value={prBody}
                onChange={e => setPrBody(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-xs text-neutral-200 font-mono placeholder-neutral-500 focus:outline-none focus:border-amber-400/50"
              />
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-mono text-neutral-400">
                  Target: {currentBuild?.gitBranch || 'feature'} ➔ main
                </span>
                <button
                  type="submit"
                  disabled={creatingPr || !prTitle.trim()}
                  className="px-4 py-2 bg-amber-400 hover:bg-amber-300 text-neutral-950 font-semibold text-xs rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <GitPullRequest className="w-3.5 h-3.5" />
                  <span>{creatingPr ? 'Opening PR...' : 'Create Pull Request'}</span>
                </button>
              </div>
            </form>
            {prFeedback && <p className="text-xs font-mono text-amber-300">{prFeedback}</p>}
          </div>

          {/* Pull Request List */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-neutral-800 flex items-center justify-between text-xs">
              <span className="font-bold text-white font-mono">Repository Pull Requests</span>
              <button onClick={loadPullRequests} className="text-neutral-400 hover:text-white">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="divide-y divide-neutral-800">
              {pullRequests.length === 0 ? (
                <div className="p-12 text-center text-xs text-neutral-500 font-mono">No pull requests found.</div>
              ) : (
                pullRequests.map(pr => (
                  <div key={pr.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-neutral-200">#{pr.number} {pr.title}</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                          pr.state === 'open' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-purple-500/20 text-purple-300'
                        }`}>
                          {pr.state.toUpperCase()}
                        </span>
                      </div>
                      <p className="text-neutral-400 text-[11px] font-mono">
                        {pr.headBranch} ➔ {pr.baseBranch} by @{pr.author}
                      </p>
                    </div>

                    <div className="flex items-center gap-3">
                      <a
                        href={pr.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="px-3 py-1.5 bg-neutral-950 hover:bg-neutral-800 border border-neutral-800 rounded text-neutral-300 hover:text-white font-mono text-[11px] flex items-center gap-1"
                      >
                        <span>View on GitHub</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      {pr.state === 'open' && (
                        <button
                          onClick={() => handleMergePullRequest(pr.number)}
                          className="px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 rounded font-semibold text-[11px] flex items-center gap-1"
                        >
                          <GitMerge className="w-3 h-3" />
                          <span>Merge PR</span>
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sub-Tab 5: Sync & Conflict Resolution */}
      {activeSubTab === 'sync' && (
        <div className="space-y-6">
          {/* Sync Trigger Card */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 text-amber-400" />
                  <span>Non-Destructive Remote Synchronization</span>
                </h3>
                <p className="text-xs text-neutral-400 mt-1">
                  Compares local project files against remote branch. Detects conflicts and preserves your work without silent overwrites.
                </p>
              </div>
              <button
                onClick={handleSync}
                disabled={syncing}
                className="px-4 py-2 bg-amber-400 hover:bg-amber-300 text-neutral-950 font-bold text-xs rounded-lg transition-colors flex items-center gap-1.5 shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                <span>{syncing ? 'Syncing...' : 'Sync with Remote'}</span>
              </button>
            </div>
            {syncStatus && (
              <p className="text-xs font-mono text-cyan-300 bg-neutral-950 p-2.5 rounded-lg border border-neutral-800">
                {syncStatus}
              </p>
            )}
          </div>

          {/* Merge Conflicts Section */}
          {conflicts.length > 0 && (
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden space-y-4 p-5">
              <div className="flex items-center gap-2 text-rose-400 font-bold text-sm">
                <AlertTriangle className="w-4 h-4" />
                <span>Active Merge Conflicts ({conflicts.filter(c => c.status === 'unresolved').length} unresolved)</span>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Conflict File List */}
                <div className="bg-neutral-950 border border-neutral-800 rounded-lg divide-y divide-neutral-800">
                  {conflicts.map(c => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setActiveConflict(c);
                        setManualResolvedContent(c.localContent);
                      }}
                      className={`w-full text-left p-3 text-xs flex items-center justify-between ${
                        activeConflict?.id === c.id ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:bg-neutral-900'
                      }`}
                    >
                      <span className="font-mono truncate">{c.filePath}</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                        c.status === 'resolved' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
                      }`}>
                        {c.status.toUpperCase()}
                      </span>
                    </button>
                  ))}
                </div>

                {/* Conflict Resolution Workspace */}
                {activeConflict && (
                  <div className="lg:col-span-2 space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-neutral-200">{activeConflict.filePath}</span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleResolveConflict('ours')}
                          className="px-3 py-1 bg-neutral-950 hover:bg-neutral-800 border border-neutral-700 rounded text-xs text-amber-300 font-semibold"
                        >
                          Accept Local (Ours)
                        </button>
                        <button
                          onClick={() => handleResolveConflict('theirs')}
                          className="px-3 py-1 bg-neutral-950 hover:bg-neutral-800 border border-neutral-700 rounded text-xs text-cyan-300 font-semibold"
                        >
                          Accept Remote (Theirs)
                        </button>
                        <button
                          onClick={() => handleResolveConflict('manual')}
                          className="px-3 py-1 bg-amber-400 hover:bg-amber-300 text-neutral-950 rounded text-xs font-bold"
                        >
                          Apply Manual Merge
                        </button>
                      </div>
                    </div>

                    <textarea
                      value={manualResolvedContent}
                      onChange={e => setManualResolvedContent(e.target.value)}
                      rows={12}
                      className="w-full p-3 bg-neutral-950 border border-neutral-800 rounded-lg text-xs font-mono text-neutral-200 focus:outline-none focus:border-amber-400/50"
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Sub-Tab 6: Commit History */}
      {activeSubTab === 'history' && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-neutral-800 flex items-center justify-between text-xs">
            <span className="font-bold text-white font-mono">Repository Commit History</span>
            <button onClick={loadCommits} className="text-neutral-400 hover:text-white flex items-center gap-1">
              <RefreshCw className={`w-3.5 h-3.5 ${loadingCommits ? 'animate-spin' : ''}`} />
              <span>Reload</span>
            </button>
          </div>
          <div className="divide-y divide-neutral-800">
            {loadingCommits ? (
              <div className="p-12 text-center text-xs text-neutral-500 font-mono">Loading commits from GitHub...</div>
            ) : commits.length === 0 ? (
              <div className="p-12 text-center text-xs text-neutral-500 font-mono">No commits found for branch.</div>
            ) : (
              commits.map(c => (
                <div key={c.sha} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs">
                  <div className="space-y-1">
                    <p className="font-medium text-neutral-200 font-mono">{c.message}</p>
                    <div className="flex items-center gap-2 text-[11px] text-neutral-500">
                      {c.authorAvatarUrl && (
                        <img src={c.authorAvatarUrl} alt="" className="w-4 h-4 rounded-full" />
                      )}
                      <span>{c.authorName}</span>
                      <span>·</span>
                      <span>{new Date(c.date).toLocaleString()}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="px-2 py-1 bg-neutral-950 border border-neutral-800 rounded font-mono text-[11px] text-amber-300">
                      {c.shortSha}
                    </span>
                    <a
                      href={c.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="p-1.5 text-neutral-400 hover:text-white bg-neutral-950 border border-neutral-800 rounded"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
