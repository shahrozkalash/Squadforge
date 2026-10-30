import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { useSwarm } from '../context/SwarmContext.js';
import { 
  Settings as SettingsIcon, 
  Github, 
  Sliders, 
  Cpu, 
  Plus, 
  Check, 
  AlertCircle, 
  DollarSign,
  User as UserIcon,
  Save,
  KeyRound,
  ShieldCheck,
  Info,
  LogOut
} from 'lucide-react';
import { ModelConfig, ModelStrength } from '../types/index.js';

export const SettingsView: React.FC = () => {
  const { user, logout, connectGitHubOAuth, connectGitHubPAT, disconnectGitHub, updateSettings } = useAuth();
  const { allModels, refreshModels, configStatus, refreshConfigStatus } = useSwarm();

  const [costLimit, setCostLimit] = useState(user?.costLimitPerBuild || 5.0);
  const [defaultRepo, setDefaultRepo] = useState(user?.defaultRepo || 'squadforge-output');
  const [patInput, setPatInput] = useState('');
  const [patStatus, setPatStatus] = useState<string | null>(null);
  const [savedSuccess, setSavedSuccess] = useState(false);

  // New Model Registration State (11th model config entry)
  const [isAddingModel, setIsAddingModel] = useState(false);
  const [newModelId, setNewModelId] = useState('');
  const [newModelName, setNewModelName] = useState('');
  const [newProviderModel, setNewProviderModel] = useState('');
  const [newStrengths, setNewStrengths] = useState<ModelStrength[]>(['frontend', 'backend']);
  const [newDescription, setNewDescription] = useState('');

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    await updateSettings({
      costLimitPerBuild: costLimit,
      defaultRepo: defaultRepo.trim()
    });
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  const handleToggleModelEnabled = async (model: ModelConfig) => {
    try {
      await fetch(`/api/models/${model.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !model.enabled })
      });
      await refreshModels();
    } catch (err) {
      console.error('Failed to toggle model:', err);
    }
  };

  const handleConnectPAT = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patInput.trim()) return;
    setPatStatus(null);
    const success = await connectGitHubPAT(patInput.trim());
    if (success) {
      setPatStatus('GitHub connected successfully!');
      setPatInput('');
      await refreshConfigStatus();
    } else {
      setPatStatus('Failed to validate token.');
    }
  };

  const handleRegisterNewModel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newModelId || !newModelName || !newProviderModel) return;

    try {
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: newModelId.toLowerCase().trim(),
          displayName: newModelName.trim(),
          providerModel: newProviderModel.trim(),
          strengths: newStrengths,
          maxTokens: 4096,
          enabled: true,
          badge: newModelId.slice(0, 4).toUpperCase(),
          description: newDescription.trim() || 'Custom registered model',
          avatarColor: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
        })
      });

      if (res.ok) {
        await refreshModels();
        setIsAddingModel(false);
        setNewModelId('');
        setNewModelName('');
        setNewProviderModel('');
        setNewDescription('');
      }
    } catch (err) {
      console.error('Failed to register model:', err);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white font-sans flex items-center gap-2">
          <SettingsIcon className="w-5 h-5 text-amber-400" />
          <span>Platform Settings & Provider Integrations</span>
        </h1>
        <p className="text-xs text-neutral-400 mt-0.5">
          Provider status, GitHub credentials, cost limits, and team model registry configuration.
        </p>
      </div>

      {/* User Account Profile & Session Card */}
      <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4">
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <div className="flex items-center gap-2">
            <UserIcon className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-white">
              {user?.isAnonymous ? 'Workspace Session & Tenant Isolation' : 'Authenticated Profile & Session Security'}
            </h2>
          </div>
          <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">
            {user?.isAnonymous ? 'Public Guest Session' : 'Active Account'}
          </span>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 bg-neutral-950 border border-neutral-800 rounded-lg">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-white">{user?.name || 'Guest Developer'}</span>
              <span className="text-xs font-mono text-neutral-400">
                {user?.isAnonymous ? '(Isolated Anonymous Session)' : `(${user?.email})`}
              </span>
            </div>
            <div className="text-xs text-neutral-500 flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>Isolation: Scoped Browser Session</span>
              <span>•</span>
              <span>Vault: AES-256-GCM Encrypted</span>
              <span>•</span>
              <span>Rate Limits & IDOR Protection Active</span>
            </div>
          </div>

          {!user?.isAnonymous && (
            <button
              type="button"
              onClick={() => logout()}
              className="flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-rose-300 bg-rose-500/10 border border-rose-500/20 hover:bg-rose-500/20 rounded-lg transition-colors whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out of SquadForge</span>
            </button>
          )}
        </div>
      </div>

      {/* Provider Configuration Status Screen (Safe, never displays secret keys) */}
      <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4">
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-white">AI Provider Configuration Status</h2>
          </div>
          <span className="text-xs font-mono text-neutral-400">
            Keys are stored server-side only
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Gemini Status */}
          <div className="p-4 bg-neutral-950 border border-neutral-800 rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white">Google Gemini</span>
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                configStatus?.gemini.configured 
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' 
                  : 'bg-amber-500/20 text-amber-300 border-amber-500/30'
              }`}>
                {configStatus?.gemini.configured ? 'CONFIGURED' : 'NOT DETECTED'}
              </span>
            </div>
            <p className="text-[11px] text-neutral-400 font-mono">
              Model: {configStatus?.gemini.model || 'gemini-3.8-flash'}
            </p>
            <p className="text-[11px] text-neutral-500">
              In AI Studio Build, this key is populated automatically server-side via environment variables.
            </p>
          </div>

          {/* OpenRouter Status */}
          <div className="p-4 bg-neutral-950 border border-neutral-800 rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white">OpenRouter (3P Models)</span>
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                configStatus?.openrouter.configured 
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' 
                  : 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30'
              }`}>
                {configStatus?.openrouter.configured ? 'CONFIGURED' : 'FALLBACK ACTIVE'}
              </span>
            </div>
            <p className="text-[11px] text-neutral-400 font-mono">
              Models: 9 specialized agents
            </p>
            <p className="text-[11px] text-neutral-500">
              When OPENROUTER_API_KEY is unset, third-party models seamlessly route via configured Gemini fallback.
            </p>
          </div>

          {/* GitHub Status */}
          <div className="p-4 bg-neutral-950 border border-neutral-800 rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white">GitHub Integration</span>
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                user?.githubConnected 
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' 
                  : 'bg-neutral-800 text-neutral-400 border-neutral-700'
              }`}>
                {user?.githubConnected ? 'CONNECTED' : 'DISCONNECTED'}
              </span>
            </div>
            <p className="text-[11px] text-neutral-400 font-mono">
              Account: {user?.githubUsername ? `@${user.githubUsername}` : 'None'}
            </p>
            <p className="text-[11px] text-neutral-500">
              Pushes PR to feature/autonomous-development-team branch upon verified project completion.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Account & Safety Limits */}
        <form onSubmit={handleSaveSettings} className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-5">
          <div className="flex items-center gap-2 border-b border-neutral-800 pb-3">
            <UserIcon className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-white">Account & Swarm Budgets</h2>
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-300 mb-1">
              Account Email
            </label>
            <input
              type="text"
              disabled
              value={user?.email || 'builder@squadforge.dev'}
              className="w-full px-3 py-2 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-neutral-400 font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-300 mb-1">
              Default GitHub Repository Name
            </label>
            <input
              type="text"
              value={defaultRepo}
              onChange={(e) => setDefaultRepo(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none focus:border-amber-400"
            />
          </div>

          <div>
            <div className="flex items-center justify-between text-xs font-medium text-neutral-300 mb-1">
              <span>Cost Limit Per Swarm Build</span>
              <span className="font-mono text-amber-400">${costLimit.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="20"
              step="0.5"
              value={costLimit}
              onChange={(e) => setCostLimit(parseFloat(e.target.value))}
              className="w-full accent-amber-400 h-1 bg-neutral-800 rounded-lg cursor-pointer"
            />
            <span className="text-[11px] text-neutral-500">
              Swarm auto-halts if total token consumption crosses this threshold
            </span>
          </div>

          <div className="flex items-center justify-between pt-2">
            {savedSuccess && (
              <span className="text-xs text-emerald-400 flex items-center gap-1 font-mono">
                <Check className="w-3.5 h-3.5" /> Settings saved!
              </span>
            )}
            <div className="ml-auto">
              <button
                type="submit"
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-amber-400 hover:bg-amber-300 text-neutral-950 rounded-lg transition-colors"
              >
                <Save className="w-3.5 h-3.5" />
                <span>Save Changes</span>
              </button>
            </div>
          </div>
        </form>

        {/* GitHub Integration */}
        <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-5">
          <div className="flex items-center gap-2 border-b border-neutral-800 pb-3">
            <Github className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-white">GitHub OAuth & Deployment</h2>
          </div>

          {user?.githubConnected ? (
            <div className="p-4 bg-neutral-950 border border-emerald-500/20 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                    <Github className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-white">
                      Connected to GitHub
                    </div>
                    <div className="text-xs font-mono text-emerald-300">
                      @{user.githubUsername}
                    </div>
                  </div>
                </div>

                <button
                  onClick={disconnectGitHub}
                  className="px-3 py-1.5 text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded hover:bg-rose-500/20 transition-colors"
                >
                  Disconnect
                </button>
              </div>

              <div className="text-[11px] text-neutral-500 leading-relaxed font-mono">
                Pushes to branch "feature/autonomous-development-team" and opens a reviewable Pull Request. Never pushes to main.
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-neutral-400 leading-relaxed">
                Connect your GitHub account to enable automatic branch creation and Pull Requests upon project completion.
              </p>

              <button
                onClick={connectGitHubOAuth}
                className="w-full flex items-center justify-center gap-2 py-2 px-4 text-xs font-medium text-white bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors"
              >
                <Github className="w-4 h-4" />
                <span>Connect with GitHub OAuth</span>
              </button>

              <form onSubmit={handleConnectPAT} className="space-y-2 pt-2 border-t border-neutral-800">
                <label className="block text-xs font-medium text-neutral-300">
                  Or Connect with Personal Access Token (PAT)
                </label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={patInput}
                    onChange={(e) => setPatInput(e.target.value)}
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                    className="flex-1 px-3 py-1.5 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none focus:border-amber-400"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 rounded-lg"
                  >
                    Connect
                  </button>
                </div>
                {patStatus && (
                  <p className={`text-xs ${patStatus.includes('success') ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {patStatus}
                  </p>
                )}
              </form>
            </div>
          )}
        </div>
      </div>

      {/* Model Registry Management & 11th Model Adder */}
      <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-neutral-800 pb-3">
          <div>
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Cpu className="w-4 h-4 text-cyan-400" />
              <span>Multi-Agent Model Registry ({allModels.length} Agents)</span>
            </h2>
            <p className="text-xs text-neutral-400 mt-0.5">
              Config-driven architecture. Each agent has an assigned development role.
            </p>
          </div>

          <button
            onClick={() => setIsAddingModel(!isAddingModel)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-neutral-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add 11th Model Entry</span>
          </button>
        </div>

        {/* Add Model Form */}
        {isAddingModel && (
          <form onSubmit={handleRegisterNewModel} className="p-4 bg-neutral-950 border border-amber-500/30 rounded-xl space-y-4">
            <div className="text-xs font-mono font-bold text-amber-400">
              Register New Model Config Entry
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">Model ID</label>
                <input
                  type="text"
                  placeholder="e.g. command-r"
                  value={newModelId}
                  onChange={(e) => setNewModelId(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs bg-neutral-900 border border-neutral-800 rounded text-white font-mono"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">Display Name</label>
                <input
                  type="text"
                  placeholder="e.g. Cohere Command R+"
                  value={newModelName}
                  onChange={(e) => setNewModelName(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs bg-neutral-900 border border-neutral-800 rounded text-white font-sans"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">Provider String</label>
                <input
                  type="text"
                  placeholder="e.g. cohere/command-r-plus"
                  value={newProviderModel}
                  onChange={(e) => setNewProviderModel(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs bg-neutral-900 border border-neutral-800 rounded text-white font-mono"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">Description</label>
              <input
                type="text"
                placeholder="Specialized model description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                className="w-full px-3 py-1.5 text-xs bg-neutral-900 border border-neutral-800 rounded text-white"
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsAddingModel(false)}
                className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 text-xs font-medium text-neutral-950 bg-amber-400 rounded hover:bg-amber-300"
              >
                Register Model
              </button>
            </div>
          </form>
        )}

        {/* Existing Models Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-neutral-800 text-neutral-400 font-mono text-[11px]">
                <th className="py-2.5 px-3">Agent & Model</th>
                <th className="py-2.5 px-3">Specialized Role</th>
                <th className="py-2.5 px-3">Provider String</th>
                <th className="py-2.5 px-3 text-right">Status Toggle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/60 font-mono">
              {allModels.map(model => (
                <tr key={model.id} className="hover:bg-neutral-950/40">
                  <td className="py-3 px-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${model.avatarColor}`}>
                        {model.badge}
                      </span>
                      <span className="font-sans font-semibold text-white">{model.displayName}</span>
                    </div>
                  </td>
                  <td className="py-3 px-3">
                    <span className="text-purple-300 font-sans">
                      {model.agentRole?.replace('_', ' ') || 'Engineer'}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-neutral-400">{model.providerModel}</td>
                  <td className="py-3 px-3 text-right">
                    <button
                      onClick={() => handleToggleModelEnabled(model)}
                      className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
                        model.enabled 
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' 
                          : 'bg-neutral-800 text-neutral-500 border border-neutral-700'
                      }`}
                    >
                      {model.enabled ? 'ENABLED' : 'DISABLED'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
