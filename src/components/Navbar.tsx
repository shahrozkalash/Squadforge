import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { useSwarm } from '../context/SwarmContext.js';
import { Github, Play, Square, Activity, GitBranch, LogOut, Rocket, Menu, X, Smartphone } from 'lucide-react';

export type NavTab = 'execution' | 'debug' | 'dashboard' | 'live' | 'codegen' | 'collaboration' | 'github' | 'deploy' | 'android' | 'architecture' | 'code' | 'merge' | 'builds' | 'usage' | 'settings' | 'test';

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
  const { activeBuild, stopBuild, approvalRequests } = useSwarm();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const isRunning = activeBuild?.status === 'running' || activeBuild?.status === 'planning' || activeBuild?.status === 'verifying';
  const pendingApprovalsCount = approvalRequests?.filter(a => a.status === 'pending').length || 0;

  const navItems: Array<{ id: NavTab; label: string; badge?: number; dot?: boolean; icon?: React.ComponentType<{ className?: string }> }> = [
    { id: 'dashboard', label: 'Idea Forge' },
    { id: 'live', label: 'Swarm Live', dot: isRunning },
    { id: 'codegen', label: 'Code Gen' },
    { id: 'execution', label: 'Run' },
    { id: 'debug', label: 'Debug' },
    { id: 'android', label: 'Android Studio', icon: Smartphone },
    { id: 'collaboration', label: 'Collaboration', badge: pendingApprovalsCount },
    { id: 'github', label: 'GitHub', icon: Github },
    { id: 'deploy', label: 'Deploy', icon: Rocket },
    { id: 'architecture', label: 'Architecture' },
    { id: 'code', label: 'Code & Diff' },
    { id: 'merge', label: 'Merge Manager' },
    { id: 'builds', label: 'Build History' },
    { id: 'usage', label: 'Usage & Quotas' },
    { id: 'settings', label: 'Settings' }
  ];

  return (
    <header className="border-b border-neutral-800 bg-neutral-950/90 backdrop-blur-md sticky top-0 z-40">
      <div className="flex items-center justify-between gap-4 px-6 py-3.5">
        {/* Zone 1: Single text element wordmark + mobile hamburger */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="lg:hidden p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-900 border border-neutral-800 transition-colors"
            aria-label="Toggle navigation menu"
          >
            {isMobileMenuOpen ? <X className="w-4 h-4 text-amber-400" /> : <Menu className="w-4 h-4" />}
          </button>
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
          onClick={() => onSelectTab('codegen')}
          className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
            currentTab === 'codegen' ? 'text-amber-400 border-b border-amber-400 pb-0.5' : ''
          }`}
        >
          Code Gen
        </button>
        <button
          onClick={() => onSelectTab('execution')}
          className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
            currentTab === 'execution' ? 'text-amber-400 border-b border-amber-400 pb-0.5' : ''
          }`}
        >
          Run
        </button>
        <button
          onClick={() => onSelectTab('debug')}
          className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
            currentTab === 'debug' ? 'text-amber-400 border-b border-amber-400 pb-0.5' : ''
          }`}
        >
          Debug
        </button>
        <button
          onClick={() => onSelectTab('collaboration')}
          className={`hover:text-white transition-colors whitespace-nowrap shrink-0 relative flex items-center gap-1.5 ${
            currentTab === 'collaboration' ? 'text-amber-400 border-b border-amber-400 pb-0.5' : ''
          }`}
        >
          <span>Collaboration</span>
          {pendingApprovalsCount > 0 && (
            <span className="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full">
              {pendingApprovalsCount}
            </span>
          )}
        </button>
        <button
          onClick={() => onSelectTab('github')}
          className={`hover:text-white transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
            currentTab === 'github' ? 'text-amber-400 border-b border-amber-400 pb-0.5' : ''
          }`}
        >
          <Github className="w-3.5 h-3.5" />
          <span>GitHub</span>
        </button>
        <button
          onClick={() => onSelectTab('deploy')}
          className={`hover:text-white transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
            currentTab === 'deploy' ? 'text-amber-400 border-b border-amber-400 pb-0.5' : ''
          }`}
        >
          <Rocket className="w-3.5 h-3.5" />
          <span>Deploy</span>
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
      </div>

      {/* Mobile Navigation Drawer */}
      {isMobileMenuOpen && (
        <div className="lg:hidden border-t border-neutral-800/80 bg-neutral-950/95 px-4 py-3 backdrop-blur-md">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = currentTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    onSelectTab(item.id);
                    setIsMobileMenuOpen(false);
                  }}
                  className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                    isActive
                      ? 'bg-amber-400/10 text-amber-400 border border-amber-400/30'
                      : 'text-neutral-400 hover:text-white hover:bg-neutral-900 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
                    <span className="truncate">{item.label}</span>
                  </div>
                  {item.dot && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />}
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full shrink-0">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </header>
  );
};
