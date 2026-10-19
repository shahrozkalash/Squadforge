import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { X, Github, Check, AlertCircle, Key, LogIn, Lock } from 'lucide-react';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose }) => {
  const { user, login, logout, connectGitHubOAuth, connectGitHubPAT, disconnectGitHub } = useAuth();
  const [email, setEmail] = useState(user?.email || 'architect@squadforge.dev');
  const [name, setName] = useState(user?.name || 'Lead Architect');
  const [patInput, setPatInput] = useState('');
  const [patStatus, setPatStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    await login(email, name);
    setIsSubmitting(false);
  };

  const handleConnectPAT = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patInput.trim()) return;
    setIsSubmitting(true);
    setPatStatus(null);
    const success = await connectGitHubPAT(patInput.trim());
    if (success) {
      setPatStatus('Connected successfully!');
      setPatInput('');
    } else {
      setPatStatus('Failed to validate token. Ensure scope "repo" is granted.');
    }
    setIsSubmitting(false);
  };

  const handleUseDemoGitHub = async () => {
    setIsSubmitting(true);
    await connectGitHubPAT('ghp_demo_valid_token_squadforge_2026', 'squadforge-demo-dev');
    setIsSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="w-full max-w-lg bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-950">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-amber-400" />
            <h3 className="text-base font-semibold text-white">SquadForge Authentication & GitHub Onboarding</h3>
          </div>
          <button 
            onClick={onClose}
            className="text-neutral-400 hover:text-white p-1 rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6 max-h-[85vh] overflow-y-auto">
          {/* Section 1: User Account */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono uppercase tracking-wider text-neutral-400">01. Account Credentials</span>
              {user && (
                <span className="text-xs font-medium text-emerald-400 flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" /> Authenticated
                </span>
              )}
            </div>

            <form onSubmit={handleLogin} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">Email Address</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-neutral-950 border border-neutral-800 rounded-lg text-white focus:outline-none focus:border-amber-400 font-sans"
                  placeholder="you@company.com"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">Display Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-neutral-950 border border-neutral-800 rounded-lg text-white focus:outline-none focus:border-amber-400 font-sans"
                  placeholder="Lead Engineer"
                  required
                />
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 py-2 px-4 text-xs font-medium bg-amber-400 text-neutral-950 rounded-lg hover:bg-amber-300 transition-colors"
                >
                  Save / Switch Account
                </button>
                <button
                  type="button"
                  onClick={() => {
                    login('demo-evaluator@squadforge.dev', 'Evaluator User');
                  }}
                  className="py-2 px-3 text-xs font-medium bg-neutral-800 text-neutral-300 border border-neutral-700 rounded-lg hover:bg-neutral-700 transition-colors"
                >
                  Quick Demo User
                </button>
              </div>
            </form>
          </div>

          <div className="border-t border-neutral-800" />

          {/* Section 2: GitHub OAuth Onboarding (Mandatory Step per brief) */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono uppercase tracking-wider text-neutral-400">02. Required GitHub Connection</span>
              {user?.githubConnected ? (
                <span className="text-xs font-mono text-emerald-400 flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" /> @{user.githubUsername}
                </span>
              ) : (
                <span className="text-xs font-mono text-amber-400 flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5" /> Required for Auto-Push
                </span>
              )}
            </div>

            <p className="text-xs text-neutral-400 leading-relaxed">
              SquadForge automatically provisions repositories and pushes commits when the 10-model swarm completes software builds.
            </p>

            {user?.githubConnected ? (
              <div className="p-4 bg-neutral-950 border border-emerald-500/20 rounded-lg flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center border border-emerald-500/30">
                    <Github className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-white flex items-center gap-2">
                      <span>Connected as</span>
                      <span className="font-mono text-emerald-300">@{user.githubUsername}</span>
                    </div>
                    <span className="text-xs text-neutral-400">Token encrypted at rest (AES-256-GCM)</span>
                  </div>
                </div>
                <button
                  onClick={disconnectGitHub}
                  className="px-3 py-1.5 text-xs font-medium text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-md hover:bg-rose-500/20 transition-colors"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {/* 1. Official GitHub OAuth Popup */}
                <button
                  type="button"
                  onClick={connectGitHubOAuth}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-medium bg-neutral-800 hover:bg-neutral-700 text-white border border-neutral-700 rounded-lg transition-colors"
                >
                  <Github className="w-4 h-4" />
                  <span>Connect via GitHub OAuth (Popup)</span>
                </button>

                {/* 2. Direct PAT or Demo connect option */}
                <form onSubmit={handleConnectPAT} className="space-y-2 pt-2">
                  <label className="block text-xs font-medium text-neutral-300">
                    Or Connect using Personal Access Token (PAT)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={patInput}
                      onChange={(e) => setPatInput(e.target.value)}
                      placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                      className="flex-1 px-3 py-2 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-white font-mono focus:outline-none focus:border-amber-400"
                    />
                    <button
                      type="submit"
                      disabled={isSubmitting || !patInput}
                      className="px-3 py-2 text-xs font-medium bg-neutral-800 text-neutral-200 border border-neutral-700 rounded-lg hover:bg-neutral-700 disabled:opacity-50"
                    >
                      Connect PAT
                    </button>
                  </div>
                  {patStatus && (
                    <p className={`text-xs ${patStatus.includes('success') ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {patStatus}
                    </p>
                  )}
                </form>

                <div className="pt-2">
                  <button
                    type="button"
                    onClick={handleUseDemoGitHub}
                    className="w-full py-2 text-xs font-mono text-cyan-400 bg-cyan-950/30 border border-cyan-800/40 rounded-lg hover:bg-cyan-900/40 transition-colors"
                  >
                    1-Click Connect Demo GitHub Account (@squadforge-demo-dev)
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="px-6 py-3 border-t border-neutral-800 bg-neutral-950 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-neutral-300 hover:text-white bg-neutral-800 rounded-lg transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
