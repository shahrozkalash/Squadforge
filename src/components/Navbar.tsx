import React from 'react';
import { useAuth } from '../context/AuthContext.js';
import { useSwarm } from '../context/SwarmContext.js';
import { Github, Play, Square, Activity, GitBranch, LogOut } from 'lucide-react';

export type NavTab = 'dashboard' | 'live' | 'architecture' | 'code' | 'merge' | 'builds' | 'usage' | 'settings' | 'test';

interface NavbarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  onOpenAuth?: () => void;
  onOpenTestModal: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onSelectTab,
  onOpenAuth,
  onOpenTestModal
}) => {
  const { user, logout } = useAuth();
  const { activeBuild, stopBuild } = useSwarm();

  const isRunning = activeBuild?.status === 'running' || activeBuild?.status === 'planning' || activeBuild?.status === 'verifying';

  return (
    <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-neutral-800 bg-neutral-950/80 backdrop-blur-md sticky top-0 z-40">
      {/* Zone 1: Single text element wordmark */}
      <div className="flex items-center gap-3 shrink-0">
        <a 
          href="#dashboard" 
          onClick={(e) => { e.preventDefault(); onSelectTab('dashboard'); }}
          className="text-lg font-bold tracking-tight text-white hover:text-amber-400 transition-colors whitespace-nowrap shrink-0"
        >
          SquadForge
        </a>
        <span className="hidden sm:inline-block text-xs font-mono text-neutral-400 border-l border-neutral-800 pl-3">
          10-AI Parallel Swarm
        </span>
      </div>

      {/* Zone 2: clean single-line text navigation links */}
      <nav className="hidden lg:flex items-center gap-6 text-sm font-medium text-neutral-400">
        <button
          onClick={() => onSelectTab('dashboard')}
          className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
            currentTab === 'dashboard' ? 'text-amber-400 border-b border-amber-400 pb-0.5' : ''
          }`}
        >
          Idea Forge
        </button>
        <button
          onClick={() => onSelectTab('live')}
          className={`hover:text-white transition-colors whitespace-nowrap shrink-0 relative ${
            currentTab === 'live' ? 'text-amber-400 border-b border-amber-400 pb-0.5' : ''
          }`}
        >
          Swarm Live
          {isRunning && (
            <span className="inline-block ml-1.5 w-1.5 h-1.5 rounded-full bg-emerald-400" />
          )}
        </button>
        <button
          onClick={() => onSelectTab('architecture')}
          className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
            currentTab === 'architecture' ? 'text-amber-400 border-b border-amber-400 pb-0.5' : ''
          }`}
        >
          Architecture
        </button>
        <button
          onClick={() => onSelectTab('code')}
          className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
            currentTab === 'code' ? 'text-amber-400 border-b border-amber-400 pb-0.5' : ''
          }`}
        >
          Code & Diff
        </button>
        <button
          onClick={() => onSelectTab('merge')}
          className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
            currentTab === 'merge' ? 'text-amber-400 border-b border-amber-400 pb-0.5' : ''
          }`}
        >
          Merge Manager
        </button>
        <button
          onClick={() => onSelectTab('builds')}
          className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
            currentTab === 'builds' ? 'text-amber-400 border-b border-amber-400 pb-0.5' : ''
          }`}
        >
          Build History
        </button>
        <button
          onClick={() => onSelectTab('usage')}
          className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
            currentTab === 'usage' ? 'text-amber-400 border-b border-amber-400 pb-0.5' : ''
          }`}
        >
          Usage & Quotas
        </button>
        <button
          onClick={() => onSelectTab('settings')}
          className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
            currentTab === 'settings' ? 'text-amber-400 border-b border-amber-400 pb-0.5' : ''
          }`}
        >
          Settings
        </button>
      </nav>

      {/* Zone 3: 1 primary action or connection button */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Concurrency Test Trigger Button */}
        <button
          onClick={onOpenTestModal}
          className="hidden md:flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-medium text-neutral-300 bg-neutral-900 border border-neutral-800 rounded-lg hover:border-neutral-700 hover:text-white transition-colors whitespace-nowrap shrink-0"
          title="Simulate 10 models simultaneously editing 1 file"
        >
          <Activity className="w-3.5 h-3.5 text-cyan-400" />
          <span>Stress Test (10x)</span>
        </button>

        {isRunning && (
          <button
            onClick={() => stopBuild()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg hover:bg-rose-500/20 transition-colors whitespace-nowrap shrink-0"
          >
            <Square className="w-3 h-3 fill-rose-400" />
            <span>Stop Swarm</span>
          </button>
        )}

        {user?.githubConnected ? (
          <button
            onClick={() => onSelectTab('settings')}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg hover:bg-emerald-500/20 transition-colors whitespace-nowrap shrink-0"
            title="Connected GitHub repository auto-push ready"
          >
            <Github className="w-3.5 h-3.5" />
            <span className="hidden sm:inline font-mono">@{user.githubUsername || 'connected'}</span>
          </button>
        ) : (
          <button
            onClick={() => onSelectTab('settings')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-neutral-300 bg-neutral-900 border border-neutral-700 rounded-lg hover:text-white hover:border-neutral-600 transition-colors whitespace-nowrap shrink-0"
            title="Configure GitHub repository settings"
          >
            <Github className="w-3.5 h-3.5 text-neutral-400" />
            <span>GitHub Settings</span>
          </button>
        )}

        <div className="flex items-center gap-2 pl-1 border-l border-neutral-800">
          <div className="hidden sm:flex flex-col text-right">
            <span className="text-xs font-semibold text-white leading-tight">
              {user?.name || 'Guest Developer'}
            </span>
            <span className="text-[10px] font-mono text-neutral-400 leading-tight truncate max-w-[130px]">
              {user?.isAnonymous ? 'Public Session' : user?.email}
            </span>
          </div>

          {!user?.isAnonymous && user && (
            <button
              onClick={() => logout()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-neutral-400 bg-neutral-900 border border-neutral-800 rounded-lg hover:text-rose-400 hover:border-rose-500/30 hover:bg-rose-500/10 transition-colors whitespace-nowrap shrink-0"
              title="Log out of SquadForge"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden md:inline">Sign Out</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
