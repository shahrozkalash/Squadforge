import React, { useState, useEffect } from 'react';
import { useSwarm } from '../context/SwarmContext.js';
import { 
  GenerationProfile, 
  GenerationProfileType, 
  CodeGenerationRun,
  ProjectContext,
  ProjectContract
} from '../types/index.js';
import { 
  Play, 
  CheckCircle2, 
  AlertCircle, 
  Clock, 
  Code2, 
  FileCode, 
  Cpu, 
  Layers, 
  ShieldAlert, 
  Wrench, 
  History, 
  Eye, 
  Sparkles, 
  ExternalLink,
  ChevronRight,
  Info,
  RefreshCw,
  XCircle,
  ShieldCheck,
  AlertTriangle
} from 'lucide-react';

export const CodeGenerationView: React.FC = () => {
  const { activeBuild, allModels } = useSwarm();
  const [profiles, setProfiles] = useState<GenerationProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<GenerationProfileType>('website_and_web_app');
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [userPrompt, setUserPrompt] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [activeRun, setActiveRun] = useState<CodeGenerationRun | null>(null);
  const [historyRuns, setHistoryRuns] = useState<CodeGenerationRun[]>([]);
  const [previewContext, setPreviewContext] = useState<{
    profile: GenerationProfile;
    context: ProjectContext;
    synthesizedContracts: ProjectContract[];
  } | null>(null);
  const [activeTab, setActiveTab] = useState<'passes' | 'files' | 'contracts' | 'repairs' | 'history'>('passes');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Fetch profiles on mount
  useEffect(() => {
    fetch('/api/codegen/profiles')
      .then(res => res.json())
      .then(data => {
        if (data.profiles && Array.isArray(data.profiles)) {
          setProfiles(data.profiles);
        }
      })
      .catch(err => console.error('Failed to load profiles:', err));
  }, []);

  // Fetch history runs for active build
  const loadHistory = () => {
    if (!activeBuild?.id) return;
    fetch(`/api/builds/${activeBuild.id}/codegen/runs`)
      .then(res => res.json())
      .then(data => {
        if (data.runs && Array.isArray(data.runs)) {
          setHistoryRuns(data.runs);
          if (!activeRun && data.runs.length > 0) {
            setActiveRun(data.runs[0]);
          }
        }
      })
      .catch(err => console.error('Failed to load codegen history:', err));
  };

  useEffect(() => {
    loadHistory();
  }, [activeBuild?.id]);

  // Real-time polling while generation pipeline is in flight
  useEffect(() => {
    if (!activeBuild?.id || !activeRun?.id) return;

    const inProgressStatuses = ['planning', 'generating', 'integrating', 'validating', 'repairing', 'finalizing'];
    const shouldPoll = isGenerating || inProgressStatuses.includes(activeRun.status);

    if (!shouldPoll) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/builds/${activeBuild.id}/codegen/runs/${activeRun.id}`);
        if (res.ok) {
          const data = await res.json();
          if (data.run) {
            setActiveRun(data.run);
            if (['finalized', 'completed_with_warnings', 'failed', 'cancelled', 'pending_approval'].includes(data.run.status)) {
              setIsGenerating(false);
              loadHistory();
            }
          }
        }
      } catch (err) {
        console.warn('Generation live polling error:', err);
      }
    }, 1200);

    return () => clearInterval(interval);
  }, [activeBuild?.id, activeRun?.id, activeRun?.status, isGenerating]);

  const handlePreviewContext = async () => {
    if (!activeBuild?.id) return;
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/builds/${activeBuild.id}/codegen/preview-context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userRequest: userPrompt.trim() || activeBuild.idea,
          profileId: selectedProfileId
        })
      });
      const data = await res.json();
      if (res.ok) {
        setPreviewContext(data);
      } else {
        setErrorMessage(data.error || 'Failed to preview context');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Network error while contacting server');
    }
  };

  const handleTriggerGeneration = async () => {
    if (!activeBuild?.id) return;
    if (!userPrompt.trim()) {
      setErrorMessage('Please enter an implementation requirement or feature description.');
      return;
    }

    setIsGenerating(true);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/builds/${activeBuild.id}/codegen/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userRequest: userPrompt.trim(),
          profileId: selectedProfileId,
          modelId: selectedModelId || undefined
        })
      });

      const data = await res.json();
      if (res.ok && data.run) {
        setActiveRun(data.run);
        loadHistory();
        if (data.run.status === 'failed') {
          setErrorMessage(data.run.error || 'Generation failed validation checks');
        }
      } else {
        setErrorMessage(data.error || 'Generation pipeline failed to start');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Generation failed due to network error');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCancelRun = async () => {
    if (!activeBuild?.id || !activeRun?.id) return;
    try {
      const res = await fetch(`/api/builds/${activeBuild.id}/codegen/runs/${activeRun.id}/cancel`, {
        method: 'POST'
      });
      const data = await res.json();
      if (data.run) {
        setActiveRun(data.run);
        setIsGenerating(false);
        loadHistory();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to cancel generation run');
    }
  };

  const selectedProfile = profiles.find(p => p.id === selectedProfileId) || profiles[0];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 font-sans">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-neutral-800 pb-6">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="p-2 rounded-lg bg-amber-400/10 text-amber-400 border border-amber-400/20">
              <Sparkles className="w-5 h-5" />
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-white">Intelligent Code Generation Engine</h1>
            <span className="px-2 py-0.5 text-xs font-mono font-semibold bg-amber-400/10 text-amber-300 border border-amber-400/30 rounded-full">
              Phase 9
            </span>
          </div>
          <p className="text-sm text-neutral-400 mt-1.5">
            Multi-pass contract-first code generation with AST context discovery, strict validation gates, and evidence-based automatic repair.
          </p>
        </div>

        {activeBuild && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={loadHistory}
              title="Refresh generation history"
              className="p-2 bg-neutral-900 border border-neutral-800 rounded-md text-neutral-400 hover:text-neutral-200 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <div className="text-xs font-mono bg-neutral-900 border border-neutral-800 px-3 py-2 rounded-md flex items-center gap-2 text-neutral-400">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>Project: <strong className="text-neutral-200">{activeBuild.idea.slice(0, 28)}...</strong></span>
            </div>
          </div>
        )}
      </div>

      {/* Main Grid: Workbench Left, Run Monitor Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Input Form & Configuration (5 cols) */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-neutral-900/70 border border-neutral-800 rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-300 flex items-center gap-2 font-mono">
              <Code2 className="w-4 h-4 text-amber-400" />
              Feature Requirement
            </h2>

            <div>
              <label className="block text-xs font-medium text-neutral-400 mb-1.5">
                What code should be generated or modified?
              </label>
              <textarea
                value={userPrompt}
                onChange={(e) => setUserPrompt(e.target.value)}
                rows={4}
                placeholder="e.g. Implement an interactive pricing calculator with annual discount toggle, currency formatting, and responsive breakdown cards in src/components/PricingCalculator.tsx"
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-3 text-sm text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-amber-400 font-mono resize-none transition-colors"
              />
            </div>

            {/* Quick Prompt Templates */}
            <div>
              <span className="text-[11px] font-mono text-neutral-500 uppercase tracking-wider block mb-1.5">Quick Templates:</span>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setUserPrompt('Implement responsive User Profile Settings with avatar upload preview and form validation in src/components/UserProfile.tsx')}
                  className="px-2 py-1 text-xs bg-neutral-800/80 hover:bg-neutral-800 text-neutral-300 rounded border border-neutral-700/60 transition-colors"
                >
                  User Profile
                </button>
                <button
                  type="button"
                  onClick={() => setUserPrompt('Build Product Reviews & Star Rating component with filter by rating and verified badge in src/components/ProductReviews.tsx')}
                  className="px-2 py-1 text-xs bg-neutral-800/80 hover:bg-neutral-800 text-neutral-300 rounded border border-neutral-700/60 transition-colors"
                >
                  Product Reviews
                </button>
                <button
                  type="button"
                  onClick={() => setUserPrompt('Implement REST API endpoint for subscription billing webhook verification and transaction logging in server/routes/billing.ts')}
                  className="px-2 py-1 text-xs bg-neutral-800/80 hover:bg-neutral-800 text-neutral-300 rounded border border-neutral-700/60 transition-colors"
                >
                  Billing Webhook API
                </button>
              </div>
            </div>

            {/* Profile Selection */}
            <div>
              <label className="block text-xs font-medium text-neutral-400 mb-1.5">
                Specialized Generation Profile
              </label>
              <select
                value={selectedProfileId}
                onChange={(e) => setSelectedProfileId(e.target.value as GenerationProfileType)}
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2.5 text-sm text-neutral-100 focus:outline-none focus:border-amber-400 font-sans"
              >
                {profiles.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.displayName} ({p.category})
                  </option>
                ))}
              </select>
            </div>

            {/* Profile Details Card */}
            {selectedProfile && (
              <div className="p-3.5 rounded-lg bg-neutral-950/80 border border-neutral-800/90 space-y-2 text-xs">
                <div className="flex items-center justify-between text-neutral-300 font-medium">
                  <span>Architecture: {selectedProfile.category}</span>
                  <span className="font-mono text-[10px] text-amber-400/90">{selectedProfile.platformConstraints.recommendedPackaging}</span>
                </div>
                <p className="text-neutral-400 leading-relaxed">
                  {selectedProfile.description}
                </p>
                {selectedProfile.platformConstraints.limitationNotice && (
                  <div className="p-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-300 flex items-start gap-2 mt-2">
                    <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
                    <span className="text-[11px]">{selectedProfile.platformConstraints.limitationNotice}</span>
                  </div>
                )}
              </div>
            )}

            {/* Model Selection */}
            <div>
              <label className="block text-xs font-medium text-neutral-400 mb-1.5">
                AI Engineering Model
              </label>
              <select
                value={selectedModelId}
                onChange={(e) => setSelectedModelId(e.target.value)}
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2.5 text-sm text-neutral-100 focus:outline-none focus:border-amber-400 font-sans"
              >
                <option value="">Auto-Route via SmartRouter (Recommended)</option>
                {allModels && allModels.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.displayName} ({m.badge})
                  </option>
                ))}
              </select>
            </div>

            {errorMessage && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-300 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handlePreviewContext}
                className="flex-1 py-2.5 px-3 rounded-lg border border-neutral-700 bg-neutral-800 hover:bg-neutral-750 text-neutral-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
              >
                <Eye className="w-4 h-4 text-neutral-400" />
                Preview Context
              </button>

              <button
                type="button"
                disabled={isGenerating || !activeBuild}
                onClick={handleTriggerGeneration}
                className="flex-1 py-2.5 px-4 rounded-lg bg-amber-400 hover:bg-amber-300 text-neutral-950 text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-md shadow-amber-400/10"
              >
                {isGenerating ? (
                  <>
                    <span className="w-3.5 h-3.5 border-2 border-neutral-950 border-t-transparent rounded-full animate-spin" />
                    Executing 6 Passes...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 fill-current" />
                    Generate Code
                  </>
                )}
              </button>

              {isGenerating && (
                <button
                  type="button"
                  onClick={handleCancelRun}
                  title="Cancel active run"
                  className="py-2.5 px-3 rounded-lg border border-rose-800/60 bg-rose-950/30 text-rose-300 hover:bg-rose-900/40 text-xs font-semibold flex items-center gap-1 transition-colors"
                >
                  <XCircle className="w-4 h-4" />
                  Cancel
                </button>
              )}
            </div>
          </div>

          {/* Context Preview Drawer if opened */}
          {previewContext && (
            <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between border-b border-neutral-800 pb-2">
                <span className="text-xs font-bold font-mono text-neutral-300">DISCOVERED CONTEXT & CONTRACTS</span>
                <span className="text-[10px] font-mono text-amber-400">~{previewContext.context.tokenUsageEstimate} tokens</span>
              </div>
              
              <div className="text-xs space-y-2">
                <div>
                  <span className="text-neutral-400 font-mono text-[11px] block">Relevant Files Ranked:</span>
                  <div className="mt-1 space-y-1">
                    {previewContext.context.relevantFiles.slice(0, 4).map(f => (
                      <div key={f.path} className="px-2 py-1 bg-neutral-950 rounded text-neutral-300 font-mono flex items-center justify-between text-[11px]">
                        <span>{f.path}</span>
                        <span className="text-neutral-500">score: {f.priority}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {previewContext.synthesizedContracts.length > 0 && (
                  <div className="pt-2">
                    <span className="text-neutral-400 font-mono text-[11px] block">Synthesized Initial Contracts:</span>
                    <div className="mt-1 space-y-1">
                      {previewContext.synthesizedContracts.map(c => (
                        <div key={c.id} className="p-1.5 bg-neutral-950 rounded border border-neutral-800/80 font-mono text-[11px] text-amber-300">
                          <strong>{c.name}</strong> ({c.type})
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Execution Monitor & Results (7 cols) */}
        <div className="lg:col-span-7 space-y-6">
          {activeRun ? (
            <div className="bg-neutral-900/70 border border-neutral-800 rounded-xl p-6 space-y-6">
              {/* Run Status Header */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-neutral-800 pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-white text-base">Generation Run #{activeRun.id.slice(-6)}</h3>
                    <span className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold uppercase ${
                      activeRun.status === 'finalized' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' :
                      activeRun.status === 'completed_with_warnings' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' :
                      activeRun.status === 'pending_approval' ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 animate-pulse' :
                      activeRun.status === 'failed' ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40' :
                      activeRun.status === 'cancelled' ? 'bg-neutral-800 text-neutral-400 border border-neutral-700' :
                      'bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse'
                    }`}>
                      {activeRun.status}
                    </span>
                  </div>
                  <p className="text-xs text-neutral-400 mt-1 font-mono">
                    Requirement: "{activeRun.userRequest}"
                  </p>
                </div>

                <div className="flex items-center gap-3 text-xs font-mono text-neutral-400">
                  <span>Tokens: <strong className="text-neutral-200">{activeRun.tokenUsage}</strong></span>
                  <span>·</span>
                  <span>Cost: <strong className="text-neutral-200">${activeRun.cost.toFixed(4)}</strong></span>
                </div>
              </div>

              {/* Status Warning Banner if Failed or Pending Approval */}
              {activeRun.status === 'failed' && (
                <div className="p-4 bg-rose-950/40 border border-rose-800/60 rounded-lg space-y-2">
                  <div className="flex items-center gap-2 text-rose-400 font-bold text-xs uppercase font-mono">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>Generation Run Failed</span>
                  </div>
                  <p className="text-xs text-rose-200/90 leading-relaxed">
                    {activeRun.error || 'The code generation pipeline failed verification. Unresolved compiler or contract defects were detected.'}
                  </p>
                </div>
              )}

              {activeRun.status === 'pending_approval' && (
                <div className="p-4 bg-purple-950/40 border border-purple-800/60 rounded-lg space-y-2">
                  <div className="flex items-center gap-2 text-purple-400 font-bold text-xs uppercase font-mono">
                    <ShieldAlert className="w-4 h-4 shrink-0" />
                    <span>Human Approval Gate Required</span>
                  </div>
                  <p className="text-xs text-purple-200/90 leading-relaxed">
                    The generated patches modify sensitive security, crypto, auth, or environment files. Patches remain safely pending until reviewed and approved by human operator.
                  </p>
                </div>
              )}

              {/* Sub-Tabs */}
              <div className="flex items-center gap-2 border-b border-neutral-800 pb-2 text-xs font-mono overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setActiveTab('passes')}
                  className={`px-3 py-1.5 rounded transition-colors shrink-0 ${activeTab === 'passes' ? 'bg-amber-400/20 text-amber-300 font-bold border border-amber-400/30' : 'text-neutral-400 hover:text-neutral-200'}`}
                >
                  6-Pass Pipeline ({activeRun.passes.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('files')}
                  className={`px-3 py-1.5 rounded transition-colors shrink-0 ${activeTab === 'files' ? 'bg-amber-400/20 text-amber-300 font-bold border border-amber-400/30' : 'text-neutral-400 hover:text-neutral-200'}`}
                >
                  Files ({activeRun.filesCreated.length + activeRun.filesModified.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('contracts')}
                  className={`px-3 py-1.5 rounded transition-colors shrink-0 ${activeTab === 'contracts' ? 'bg-amber-400/20 text-amber-300 font-bold border border-amber-400/30' : 'text-neutral-400 hover:text-neutral-200'}`}
                >
                  Contracts ({activeRun.contractsEstablished.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('repairs')}
                  className={`px-3 py-1.5 rounded transition-colors shrink-0 ${activeTab === 'repairs' ? 'bg-amber-400/20 text-amber-300 font-bold border border-amber-400/30' : 'text-neutral-400 hover:text-neutral-200'}`}
                >
                  Repair Logs ({activeRun.repairLogs.length})
                </button>
              </div>

              {/* Tab 1: 6-Pass Pipeline Stepper */}
              {activeTab === 'passes' && (
                <div className="space-y-3">
                  {activeRun.passes.map((pass) => (
                    <div 
                      key={pass.passNumber}
                      className={`p-3.5 rounded-lg border flex items-start justify-between gap-4 transition-all ${
                        pass.status === 'passed' ? 'bg-emerald-950/20 border-emerald-800/40 text-neutral-200' :
                        pass.status === 'in_progress' ? 'bg-amber-950/20 border-amber-700/50 text-amber-200 shadow-sm' :
                        pass.status === 'failed' ? 'bg-rose-950/20 border-rose-800/40 text-rose-200' :
                        'bg-neutral-950/40 border-neutral-800/60 text-neutral-500'
                      }`}
                    >
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className="mt-0.5 shrink-0">
                          {pass.status === 'passed' && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                          {pass.status === 'in_progress' && <span className="w-3.5 h-3.5 rounded-full border-2 border-amber-400 border-t-transparent animate-spin inline-block" />}
                          {pass.status === 'failed' && <AlertCircle className="w-4 h-4 text-rose-400" />}
                          {pass.status === 'pending' && <Clock className="w-4 h-4 text-neutral-600" />}
                          {pass.status === 'skipped' && <span className="text-[10px] font-mono text-neutral-500 font-bold">SKIP</span>}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono font-bold uppercase tracking-wider text-neutral-300">
                              Pass {pass.passNumber}: {pass.passName}
                            </span>
                            <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded uppercase ${
                              pass.status === 'passed' ? 'text-emerald-400 bg-emerald-950/40' :
                              pass.status === 'failed' ? 'text-rose-400 bg-rose-950/40' :
                              pass.status === 'in_progress' ? 'text-amber-400 bg-amber-950/40' :
                              'text-neutral-500'
                            }`}>
                              {pass.status}
                            </span>
                            {pass.durationMs !== undefined && (
                              <span className="text-[10px] font-mono text-neutral-500">({pass.durationMs}ms)</span>
                            )}
                          </div>
                          <p className="text-xs text-neutral-400 mt-0.5 leading-relaxed">
                            {pass.summary}
                          </p>

                          {pass.diagnostics && pass.diagnostics.length > 0 && (
                            <div className="mt-2 p-2 bg-neutral-950 rounded border border-neutral-800 text-[11px] font-mono text-neutral-400 space-y-1">
                              {pass.diagnostics.slice(0, 4).map((d, i) => (
                                <div key={i} className="truncate text-rose-300/90">{d}</div>
                              ))}
                              {pass.diagnostics.length > 4 && (
                                <div className="text-[10px] text-neutral-500">+{pass.diagnostics.length - 4} additional diagnostics</div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Tab 2: Files Created & Modified */}
              {activeTab === 'files' && (
                <div className="space-y-4">
                  <div>
                    <h4 className="text-xs font-mono font-bold text-neutral-400 mb-2">FILES CREATED ({activeRun.filesCreated.length})</h4>
                    {activeRun.filesCreated.length === 0 ? (
                      <p className="text-xs text-neutral-600 font-mono">None created</p>
                    ) : (
                      <div className="space-y-1.5">
                        {activeRun.filesCreated.map(f => (
                          <div key={f} className="p-2.5 bg-neutral-950 border border-neutral-800 rounded flex items-center justify-between text-xs font-mono">
                            <span className="text-emerald-400 flex items-center gap-2 truncate">
                              <FileCode className="w-3.5 h-3.5 shrink-0" />
                              <span className="truncate">{f}</span>
                            </span>
                            <span className="text-[10px] bg-emerald-500/10 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/20 shrink-0">NEW</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <h4 className="text-xs font-mono font-bold text-neutral-400 mb-2">FILES MODIFIED ({activeRun.filesModified.length})</h4>
                    {activeRun.filesModified.length === 0 ? (
                      <p className="text-xs text-neutral-600 font-mono">None modified</p>
                    ) : (
                      <div className="space-y-1.5">
                        {activeRun.filesModified.map(f => (
                          <div key={f} className="p-2.5 bg-neutral-950 border border-neutral-800 rounded flex items-center justify-between text-xs font-mono">
                            <span className="text-amber-400 flex items-center gap-2 truncate">
                              <FileCode className="w-3.5 h-3.5 shrink-0" />
                              <span className="truncate">{f}</span>
                            </span>
                            <span className="text-[10px] bg-amber-500/10 text-amber-300 px-2 py-0.5 rounded border border-amber-500/20 shrink-0">PATCHED</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Tab 3: Contracts */}
              {activeTab === 'contracts' && (
                <div className="space-y-3">
                  {activeRun.contractsEstablished.length === 0 ? (
                    <p className="text-xs text-neutral-500 font-mono">No initial contracts recorded for this run.</p>
                  ) : (
                    activeRun.contractsEstablished.map(c => (
                      <div key={c.id} className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold font-mono text-amber-300">{c.name}</span>
                          <span className="text-[10px] font-mono text-neutral-500 uppercase">{c.type}</span>
                        </div>
                        <pre className="p-2 bg-neutral-900/80 rounded text-[11px] font-mono text-neutral-300 overflow-x-auto">
                          {c.signature}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Tab 4: Automatic Repairs */}
              {activeTab === 'repairs' && (
                <div className="space-y-3">
                  {activeRun.repairLogs.length === 0 ? (
                    <div className="p-4 bg-neutral-950 rounded border border-neutral-800 text-center text-xs text-neutral-500 font-mono">
                      No repair attempts were required. The generated code passed initial validation cleanly.
                    </div>
                  ) : (
                    activeRun.repairLogs.map((log, idx) => (
                      <div key={idx} className="p-3 bg-neutral-950 border border-neutral-800 rounded text-xs space-y-1">
                        <div className="flex items-center justify-between font-mono text-[11px]">
                          <span className="text-neutral-300 font-semibold">{log.file}</span>
                          <span className="text-emerald-400 font-bold uppercase">{log.outcome}</span>
                        </div>
                        <p className="text-neutral-400 text-xs">{log.defect}</p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="h-full min-h-[380px] bg-neutral-900/40 border border-neutral-800 rounded-xl flex flex-col items-center justify-center p-8 text-center text-neutral-500">
              <Cpu className="w-12 h-12 text-neutral-700 mb-3" />
              <h3 className="text-base font-bold text-neutral-300 mb-1">Intelligent Code Generation Workbench</h3>
              <p className="text-xs max-w-sm text-neutral-500 leading-relaxed">
                Enter your requirement on the left and trigger the multi-pass pipeline to generate real, complete, contract-verified software files.
              </p>
            </div>
          )}

          {/* Past Runs History List */}
          {historyRuns.length > 1 && (
            <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-5 space-y-3">
              <h4 className="text-xs font-bold uppercase font-mono tracking-wider text-neutral-400 flex items-center gap-2">
                <History className="w-3.5 h-3.5" />
                Previous Generation Runs ({historyRuns.length})
              </h4>
              <div className="space-y-2">
                {historyRuns.slice(1, 5).map(run => (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => setActiveRun(run)}
                    className="w-full text-left p-3 rounded-lg bg-neutral-950 border border-neutral-800 hover:border-neutral-700 transition-colors flex items-center justify-between text-xs"
                  >
                    <div>
                      <div className="font-mono text-neutral-200 truncate max-w-md">"{run.userRequest}"</div>
                      <div className="text-[10px] text-neutral-500 mt-0.5 font-mono">
                        {new Date(run.createdAt).toLocaleTimeString()} · {run.filesCreated.length} files created · {run.repairAttempts} repairs
                      </div>
                    </div>
                    <span className={`text-[10px] font-mono uppercase font-bold ${
                      run.status === 'finalized' ? 'text-emerald-400' :
                      run.status === 'completed_with_warnings' ? 'text-amber-400' :
                      run.status === 'failed' ? 'text-rose-400' :
                      'text-neutral-400'
                    }`}>
                      {run.status}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
