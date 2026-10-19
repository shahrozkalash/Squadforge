import React, { useState, useEffect } from 'react';
import { 
  SwarmUsageStats, 
  UsageLogEntry, 
  LocalLLMConfig, 
  LocalLLMHealthResult 
} from '../types/index.js';
import { useSwarm } from '../context/SwarmContext.js';
import { 
  Activity, 
  Zap, 
  Database, 
  ShieldAlert, 
  Cpu, 
  RefreshCw, 
  Play, 
  Pause, 
  AlertTriangle, 
  CheckCircle2, 
  Clock, 
  DollarSign, 
  Sliders, 
  Server, 
  ArrowRight,
  TrendingDown,
  Layers,
  Search,
  RotateCcw
} from 'lucide-react';

export const UsageDashboardView: React.FC = () => {
  const { activeBuild } = useSwarm();
  const [stats, setStats] = useState<SwarmUsageStats | null>(null);
  const [logs, setLogs] = useState<UsageLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [logFilter, setLogFilter] = useState<'all' | 'fallback' | 'error'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  
  // Local LLM configuration state
  const [localConfig, setLocalConfig] = useState<LocalLLMConfig>({
    enabled: false,
    endpointUrl: 'http://localhost:11434/v1',
    modelName: 'llama3.2',
    timeoutMs: 15000,
    contextWindow: 32768,
    status: 'untested'
  });
  const [testingLocal, setTestingLocal] = useState(false);
  const [localTestResult, setLocalTestResult] = useState<LocalLLMHealthResult | null>(null);

  // Budget configuration state
  const [costLimitInput, setCostLimitInput] = useState<number>(activeBuild?.costLimit || 5.0);
  const [tokenBudgetInput, setTokenBudgetInput] = useState<number>(activeBuild?.tokenBudget || 100000);
  const [budgetSuccessMsg, setBudgetSuccessMsg] = useState('');

  const fetchDashboardData = async () => {
    try {
      const buildQuery = activeBuild?.id ? `?buildId=${activeBuild.id}` : '';
      const [statsRes, logsRes, localRes] = await Promise.all([
        fetch(`/api/usage/stats${buildQuery}`),
        fetch(`/api/usage/logs${buildQuery}&limit=150`),
        fetch('/api/local-llm/status')
      ]);

      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setStats(statsData);
      }
      if (logsRes.ok) {
        const logsData = await logsRes.json();
        setLogs(logsData.logs || []);
      }
      if (localRes.ok) {
        const localData = await localRes.json();
        if (localData.config) {
          setLocalConfig(localData.config);
        }
      }
    } catch (err) {
      console.error('Failed to fetch usage dashboard data:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 5000);
    return () => clearInterval(interval);
  }, [activeBuild?.id]);

  useEffect(() => {
    if (activeBuild) {
      setCostLimitInput(activeBuild.costLimit || 5.0);
      setTokenBudgetInput(activeBuild.tokenBudget || 100000);
    }
  }, [activeBuild?.id, activeBuild?.costLimit, activeBuild?.tokenBudget]);

  const handleTestLocalLLM = async () => {
    setTestingLocal(true);
    setLocalTestResult(null);
    try {
      const res = await fetch('/api/local-llm/test', { method: 'POST' });
      const data: LocalLLMHealthResult = await res.json();
      setLocalTestResult(data);
      fetchDashboardData();
    } catch (err: any) {
      setLocalTestResult({
        connected: false,
        endpointUrl: localConfig.endpointUrl,
        availableModels: [],
        selectedModelAvailable: false,
        latencyMs: 0,
        error: err.message || 'Connection error'
      });
    } finally {
      setTestingLocal(false);
    }
  };

  const handleSaveLocalConfig = async () => {
    try {
      const res = await fetch('/api/local-llm/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localConfig)
      });
      if (res.ok) {
        const data = await res.json();
        setLocalConfig(data.config);
        fetchDashboardData();
      }
    } catch (err) {
      console.error('Failed to update local LLM config:', err);
    }
  };

  const handleResetCooldown = async (provider: string) => {
    try {
      await fetch(`/api/quota/reset/${provider}`, { method: 'POST' });
      fetchDashboardData();
    } catch (err) {
      console.error(`Failed to reset cooldown for ${provider}:`, err);
    }
  };

  const handleClearCache = async () => {
    try {
      await fetch('/api/cache/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buildId: activeBuild?.id })
      });
      fetchDashboardData();
    } catch (err) {
      console.error('Failed to clear cache:', err);
    }
  };

  const handleResumeTask = async (taskId: string) => {
    if (!activeBuild?.id) return;
    try {
      await fetch(`/api/tasks/${taskId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buildId: activeBuild.id })
      });
      fetchDashboardData();
    } catch (err) {
      console.error('Failed to resume task:', err);
    }
  };

  const handlePauseTask = async (taskId: string) => {
    if (!activeBuild?.id) return;
    try {
      await fetch(`/api/tasks/${taskId}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buildId: activeBuild.id, reason: 'Manually paused by operator' })
      });
      fetchDashboardData();
    } catch (err) {
      console.error('Failed to pause task:', err);
    }
  };

  const handleSaveBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeBuild?.id) return;
    try {
      const res = await fetch(`/api/builds/${activeBuild.id}/budget`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          costLimit: Number(costLimitInput),
          tokenBudget: Number(tokenBudgetInput)
        })
      });
      if (res.ok) {
        setBudgetSuccessMsg('Budget updated successfully.');
        setTimeout(() => setBudgetSuccessMsg(''), 3000);
        fetchDashboardData();
      }
    } catch (err) {
      console.error('Failed to save budget:', err);
    }
  };

  // Filter logs
  const filteredLogs = logs.filter(log => {
    if (logFilter === 'fallback' && !log.isFallback) return false;
    if (logFilter === 'error' && log.success) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const match = 
        log.taskTitle?.toLowerCase().includes(q) ||
        log.requestedModelId?.toLowerCase().includes(q) ||
        log.actualModelUsed?.toLowerCase().includes(q) ||
        log.provider?.toLowerCase().includes(q) ||
        log.fallbackReason?.toLowerCase().includes(q);
      if (!match) return false;
    }
    return true;
  });

  const cacheHitRate = stats?.cacheStats 
    ? ((stats.cacheStats.hits / Math.max(1, stats.cacheStats.hits + stats.cacheStats.misses)) * 100).toFixed(1)
    : '0.0';

  if (loading && !stats) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh] text-neutral-400 font-mono text-sm">
        <RefreshCw className="w-5 h-5 animate-spin mr-2 text-amber-400" />
        Loading token optimization & quota intelligence...
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-8 font-sans">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-800/80 pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2.5">
              <Zap className="w-6 h-6 text-amber-400" />
              Token Optimization & Quota Intelligence
            </h1>
            <span className="px-2 py-0.5 rounded text-xs font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
              Active Optimization
            </span>
          </div>
          <p className="text-xs text-neutral-400 mt-1 font-mono">
            Smart multi-provider routing, dynamic context compression, safe result caching & quota management
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => { setRefreshing(true); fetchDashboardData(); }}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-300 text-xs font-medium hover:bg-neutral-800 hover:text-white transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin text-amber-400' : ''}`} />
            Refresh
          </button>
          <button
            onClick={handleClearCache}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-300 text-xs font-medium hover:border-rose-500/40 hover:text-rose-300 transition-colors"
            title="Purge cached summaries and deterministic analysis"
          >
            <RotateCcw className="w-3.5 h-3.5 text-neutral-400" />
            Purge Cache
          </button>
        </div>
      </div>

      {/* Top Stat Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Metric 1: Tokens */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5 backdrop-blur-sm">
          <div className="flex items-center justify-between text-neutral-400 text-xs font-mono mb-2">
            <span>TOTAL TOKENS</span>
            <Activity className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold text-white tracking-tight">
            {(stats?.totalActualTokens || 0).toLocaleString()}
          </div>
          <div className="mt-2 text-xs text-neutral-500 flex items-center justify-between font-mono">
            <span>Est: {(stats?.totalEstimatedTokens || 0).toLocaleString()}</span>
            <span className="text-emerald-400 font-semibold">
              Saved: {(stats?.cacheStats?.tokensSaved || 0).toLocaleString()}
            </span>
          </div>
        </div>

        {/* Metric 2: Cost (Distinguishing Billed vs Estimated) */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5 backdrop-blur-sm">
          <div className="flex items-center justify-between text-neutral-400 text-xs font-mono mb-2">
            <span>COST METRICS</span>
            <DollarSign className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-white tracking-tight flex items-baseline gap-2">
            <span>${(stats?.totalBilledCost || 0).toFixed(4)}</span>
            <span className="text-xs font-normal text-neutral-500 font-mono">(Billed)</span>
          </div>
          <div className="mt-2 text-xs text-neutral-500 flex items-center justify-between font-mono">
            <span>Est: ${(stats?.totalEstimatedCost || 0).toFixed(4)}</span>
            <span className="text-emerald-400">
              Saved: ${(stats?.cacheStats?.estimatedCostSaved || 0).toFixed(4)}
            </span>
          </div>
        </div>

        {/* Metric 3: Cache Hit Rate */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5 backdrop-blur-sm">
          <div className="flex items-center justify-between text-neutral-400 text-xs font-mono mb-2">
            <span>CACHE HIT RATE</span>
            <Database className="w-4 h-4 text-blue-400" />
          </div>
          <div className="text-2xl font-bold text-blue-400 tracking-tight">
            {cacheHitRate}%
          </div>
          <div className="mt-2 text-xs text-neutral-500 flex items-center justify-between font-mono">
            <span>{stats?.cacheStats?.hits || 0} hits</span>
            <span>{stats?.cacheStats?.misses || 0} misses</span>
            <span>{stats?.cacheStats?.entriesCount || 0} active</span>
          </div>
        </div>

        {/* Metric 4: Request Success Rate */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5 backdrop-blur-sm">
          <div className="flex items-center justify-between text-neutral-400 text-xs font-mono mb-2">
            <span>TOTAL CALLS</span>
            <Layers className="w-4 h-4 text-violet-400" />
          </div>
          <div className="text-2xl font-bold text-white tracking-tight">
            {(stats?.totalRequests || 0).toLocaleString()}
          </div>
          <div className="mt-2 text-xs text-neutral-500 flex items-center justify-between font-mono">
            <span className="text-emerald-400">{stats?.successfulRequests || 0} succeeded</span>
            <span className="text-rose-400">{stats?.failedRequests || 0} failed</span>
          </div>
        </div>
      </div>

      {/* Provider Quota & Health Grid */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Server className="w-4 h-4 text-amber-400" />
            Configured AI Providers & Quota Status
          </h2>
          <span className="text-xs text-neutral-500 font-mono">Real-time circuit breaker & rate limits</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Object.entries(stats?.activeQuotas || {}).map(([key, quota]) => {
            const isHealthy = quota.status === 'healthy';
            const isRateLimited = quota.status === 'rate_limited';
            const isCooldown = quota.status === 'cooldown';
            const isExhausted = quota.status === 'quota_exhausted';
            const isAuthError = quota.status === 'auth_error';

            return (
              <div 
                key={key}
                className={`rounded-xl border p-5 transition-all ${
                  isHealthy 
                    ? 'border-neutral-800 bg-neutral-900/40' 
                    : isRateLimited || isCooldown
                    ? 'border-amber-500/40 bg-amber-500/5'
                    : 'border-rose-500/40 bg-rose-500/5'
                }`}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white uppercase tracking-wider text-sm font-mono">
                      {quota.provider}
                    </span>
                    {quota.modelId && (
                      <span className="text-xs font-mono text-neutral-500">
                        ({quota.modelId})
                      </span>
                    )}
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[11px] font-mono font-medium flex items-center gap-1 ${
                    isHealthy 
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                      : isRateLimited 
                      ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                      : isCooldown
                      ? 'bg-blue-500/10 text-blue-400 border border-blue-500/30'
                      : 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                  }`}>
                    {isHealthy && <CheckCircle2 className="w-3 h-3" />}
                    {isRateLimited && <AlertTriangle className="w-3 h-3" />}
                    {isCooldown && <Clock className="w-3 h-3" />}
                    {isExhausted && <ShieldAlert className="w-3 h-3" />}
                    {quota.status.toUpperCase()}
                  </span>
                </div>

                <div className="space-y-2 text-xs font-mono text-neutral-400">
                  <div className="flex justify-between">
                    <span>Requests:</span>
                    <span className="text-neutral-200">{quota.totalRequests} ({quota.successfulRequests} ok, {quota.failedRequests} err)</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Rate Limit Source:</span>
                    <span className="text-neutral-300">
                      {quota.isEstimated ? 'Local Backoff Estimate' : 'Provider Reported Header'}
                    </span>
                  </div>
                  {quota.retryAfterSeconds && (
                    <div className="flex justify-between text-amber-400">
                      <span>Cooldown Remaining:</span>
                      <span className="font-semibold">{quota.retryAfterSeconds}s</span>
                    </div>
                  )}
                  {quota.reportedRemaining !== undefined && (
                    <div className="flex justify-between">
                      <span>Reported Remaining:</span>
                      <span className="text-neutral-200">{quota.reportedRemaining}</span>
                    </div>
                  )}
                  {quota.lastError && (
                    <div className="mt-2 text-[11px] text-rose-400/90 truncate bg-rose-500/10 p-1.5 rounded border border-rose-500/20">
                      {quota.lastError}
                    </div>
                  )}
                </div>

                {!isHealthy && (
                  <div className="mt-4 pt-3 border-t border-neutral-800 flex justify-end">
                    <button
                      onClick={() => handleResetCooldown(quota.provider)}
                      className="text-xs font-mono text-amber-400 hover:text-amber-300 flex items-center gap-1 transition-colors"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Reset Cooldown
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Local LLM Integration Panel */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-neutral-800 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Cpu className="w-5 h-5 text-purple-400" />
              <h2 className="text-base font-bold text-white">Local Inference Engine (Ollama / Local OpenAI Endpoint)</h2>
              <span className={`px-2 py-0.5 rounded text-[11px] font-mono ${
                localConfig.status === 'connected'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                  : localConfig.status === 'disconnected'
                  ? 'bg-neutral-800 text-neutral-400'
                  : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
              }`}>
                {localConfig.status.toUpperCase()}
              </span>
            </div>
            <p className="text-xs text-neutral-400 mt-1 font-mono">
              Optional zero-cost local execution. No token limits or cloud API fees.
            </p>
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer">
            <span className="text-xs font-mono text-neutral-300">Enable Local Inference</span>
            <input
              type="checkbox"
              checked={localConfig.enabled}
              onChange={(e) => setLocalConfig({ ...localConfig, enabled: e.target.checked })}
              className="w-4 h-4 rounded border-neutral-700 bg-neutral-800 text-amber-500 focus:ring-0"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-mono text-neutral-400 mb-1.5">Local Endpoint URL</label>
            <input
              type="text"
              value={localConfig.endpointUrl}
              onChange={(e) => setLocalConfig({ ...localConfig, endpointUrl: e.target.value })}
              placeholder="http://localhost:11434/v1"
              className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-xs font-mono text-neutral-200 focus:outline-none focus:border-purple-500/50"
            />
          </div>

          <div>
            <label className="block text-xs font-mono text-neutral-400 mb-1.5">Model Identifier</label>
            <input
              type="text"
              value={localConfig.modelName}
              onChange={(e) => setLocalConfig({ ...localConfig, modelName: e.target.value })}
              placeholder="llama3.2, mistral, qwen2.5-coder"
              className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-xs font-mono text-neutral-200 focus:outline-none focus:border-purple-500/50"
            />
          </div>

          <div className="flex items-end gap-2">
            <button
              onClick={handleTestLocalLLM}
              disabled={testingLocal}
              className="flex-1 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg text-xs font-medium font-mono flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${testingLocal ? 'animate-spin text-purple-400' : ''}`} />
              Test Connection
            </button>
            <button
              onClick={handleSaveLocalConfig}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-medium font-mono transition-colors"
            >
              Save Settings
            </button>
          </div>
        </div>

        {/* Live Test Feedback */}
        {localTestResult && (
          <div className={`p-3.5 rounded-lg border text-xs font-mono ${
            localTestResult.connected 
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' 
              : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
          }`}>
            <div className="flex items-center gap-2 font-bold mb-1">
              {localTestResult.connected ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <AlertTriangle className="w-4 h-4 text-rose-400" />}
              {localTestResult.connected 
                ? `Connection Successful (${localTestResult.latencyMs}ms)` 
                : 'Connection Failed'}
            </div>
            {localTestResult.connected ? (
              <p className="text-[11px] text-emerald-400/80">
                Available models found on local host: {localTestResult.availableModels.join(', ') || 'None reported'}.
                {localTestResult.selectedModelAvailable 
                  ? ` Model "${localConfig.modelName}" is ready for local inference.`
                  : ` Model "${localConfig.modelName}" was not found in local models list.`}
              </p>
            ) : (
              <p className="text-[11px] text-rose-400/80">
                {localTestResult.error || 'Could not connect to local endpoint. Ensure Ollama or local LLM server is running.'}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Task Budgets & Paused Tasks Alert */}
      {activeBuild && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-neutral-800 pb-3">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Sliders className="w-4 h-4 text-amber-400" />
                Active Project Budget Limits & Controls
              </h2>
              <p className="text-xs text-neutral-400 font-mono">
                Project: {activeBuild.idea.slice(0, 50)}...
              </p>
            </div>
            {budgetSuccessMsg && (
              <span className="text-xs text-emerald-400 font-mono flex items-center gap-1 animate-pulse">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {budgetSuccessMsg}
              </span>
            )}
          </div>

          <form onSubmit={handleSaveBudget} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-mono text-neutral-400 mb-1.5">Cost Ceiling ($ USD)</label>
              <input
                type="number"
                step="0.5"
                min="0.5"
                max="100"
                value={costLimitInput}
                onChange={(e) => setCostLimitInput(parseFloat(e.target.value) || 1)}
                className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-xs font-mono text-neutral-200"
              />
            </div>

            <div>
              <label className="block text-xs font-mono text-neutral-400 mb-1.5">Max Token Ceiling</label>
              <input
                type="number"
                step="5000"
                min="10000"
                max="1000000"
                value={tokenBudgetInput}
                onChange={(e) => setTokenBudgetInput(parseInt(e.target.value, 10) || 50000)}
                className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-xs font-mono text-neutral-200"
              />
            </div>

            <div className="flex items-end">
              <button
                type="submit"
                className="w-full py-2 bg-amber-500 hover:bg-amber-400 text-neutral-950 font-bold rounded-lg text-xs font-mono transition-colors"
              >
                Update Budget Limits
              </button>
            </div>
          </form>

          {/* Task Status Table */}
          {stats?.taskStats && stats.taskStats.length > 0 && (
            <div className="mt-4 pt-4 border-t border-neutral-800">
              <h3 className="text-xs font-mono font-bold text-neutral-300 uppercase tracking-wider mb-2">
                Task Token & Execution Breakdown
              </h3>
              <div className="divide-y divide-neutral-800/60 max-h-56 overflow-y-auto">
                {stats.taskStats.map((task) => (
                  <div key={task.taskId} className="py-2.5 flex items-center justify-between text-xs font-mono">
                    <div className="flex items-center gap-2.5 min-w-0 pr-4">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                        task.isPaused 
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          : task.status === 'completed'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-neutral-800 text-neutral-400'
                      }`}>
                        {task.isPaused ? 'PAUSED' : task.status.toUpperCase()}
                      </span>
                      <span className="text-neutral-200 truncate font-sans font-medium">{task.taskTitle}</span>
                      {task.pausedReason && (
                        <span className="text-[11px] text-amber-400 truncate max-w-xs">({task.pausedReason})</span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                      <span className="text-neutral-400">{task.tokensUsed.toLocaleString()} tokens</span>
                      <span className="text-neutral-300 font-semibold">${task.cost.toFixed(4)}</span>
                      {task.isPaused ? (
                        <button
                          onClick={() => handleResumeTask(task.taskId)}
                          className="px-2 py-1 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 border border-amber-500/30 text-[11px] flex items-center gap-1"
                        >
                          <Play className="w-3 h-3" />
                          Resume
                        </button>
                      ) : (
                        <button
                          onClick={() => handlePauseTask(task.taskId)}
                          disabled={task.status === 'completed'}
                          className="px-2 py-1 rounded bg-neutral-800 text-neutral-400 hover:text-white text-[11px] flex items-center gap-1 disabled:opacity-30"
                        >
                          <Pause className="w-3 h-3" />
                          Pause
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Model Routing & Fallback Audit Trail Table */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-neutral-800 pb-4">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Layers className="w-4 h-4 text-amber-400" />
              Model Routing & Fallback Audit Trail
            </h2>
            <p className="text-xs text-neutral-400 font-mono">
              Complete transparent log of requested models vs actual models executed
            </p>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-neutral-500 absolute left-2.5 top-2.5" />
              <input
                type="text"
                placeholder="Search logs..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 pr-3 py-1.5 bg-neutral-950 border border-neutral-800 rounded-lg text-xs font-mono text-neutral-200 focus:outline-none focus:border-amber-500/50 w-44"
              />
            </div>
            <div className="flex border border-neutral-800 rounded-lg p-0.5 bg-neutral-950 text-xs font-mono">
              <button
                onClick={() => setLogFilter('all')}
                className={`px-2.5 py-1 rounded ${logFilter === 'all' ? 'bg-neutral-800 text-white font-medium' : 'text-neutral-400 hover:text-white'}`}
              >
                All
              </button>
              <button
                onClick={() => setLogFilter('fallback')}
                className={`px-2.5 py-1 rounded ${logFilter === 'fallback' ? 'bg-neutral-800 text-amber-400 font-medium' : 'text-neutral-400 hover:text-white'}`}
              >
                Fallbacks
              </button>
              <button
                onClick={() => setLogFilter('error')}
                className={`px-2.5 py-1 rounded ${logFilter === 'error' ? 'bg-neutral-800 text-rose-400 font-medium' : 'text-neutral-400 hover:text-white'}`}
              >
                Errors
              </button>
            </div>
          </div>
        </div>

        {/* Audit Log Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead>
              <tr className="border-b border-neutral-800 text-neutral-500 uppercase tracking-wider">
                <th className="py-2.5 px-3">Time</th>
                <th className="py-2.5 px-3">Task / Goal</th>
                <th className="py-2.5 px-3">Requested</th>
                <th className="py-2.5 px-3">Actual Executed</th>
                <th className="py-2.5 px-3">Provider</th>
                <th className="py-2.5 px-3">Tokens</th>
                <th className="py-2.5 px-3">Cost</th>
                <th className="py-2.5 px-3">Latency</th>
                <th className="py-2.5 px-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/60">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-neutral-500">
                    No matching routing events found.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-neutral-800/30 transition-colors">
                    <td className="py-2.5 px-3 text-neutral-400 whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="py-2.5 px-3 text-neutral-200 max-w-xs truncate font-sans">
                      {log.taskTitle || 'Ad-hoc swarm reasoning'}
                    </td>
                    <td className="py-2.5 px-3 text-neutral-400">
                      {log.requestedModelId}
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-1.5">
                        <span className={`font-semibold ${log.isFallback ? 'text-amber-400' : 'text-neutral-200'}`}>
                          {log.actualModelUsed}
                        </span>
                        {log.isFallback && (
                          <span 
                            title={log.fallbackReason}
                            className="px-1.5 py-0.2 rounded text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/30"
                          >
                            Fallback
                          </span>
                        )}
                        {log.isCached && (
                          <span className="px-1.5 py-0.2 rounded text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/30">
                            Cached
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 uppercase text-neutral-400">
                      {log.provider}
                    </td>
                    <td className="py-2.5 px-3 text-neutral-300">
                      {log.totalTokens.toLocaleString()}
                    </td>
                    <td className="py-2.5 px-3 text-neutral-300">
                      ${log.estimatedCost.toFixed(5)}
                    </td>
                    <td className="py-2.5 px-3 text-neutral-500">
                      {log.latencyMs}ms
                    </td>
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      {log.success ? (
                        <span className="text-emerald-400 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Success
                        </span>
                      ) : (
                        <span 
                          title={log.error} 
                          className="text-rose-400 flex items-center gap-1 cursor-help"
                        >
                          <AlertTriangle className="w-3 h-3" /> {log.errorCode || 'Error'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
