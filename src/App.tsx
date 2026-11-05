import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.js';
import { SwarmProvider, useSwarm } from './context/SwarmContext.js';
import { Navbar, NavTab } from './components/Navbar.js';
import { MainIdeaView } from './components/MainIdeaView.js';
import { LiveSwarmView } from './components/LiveSwarmView.js';
import { ProjectCodeView } from './components/ProjectCodeView.js';
import { MergeHistoryView } from './components/MergeHistoryView.js';
import { BuildHistoryView } from './components/BuildHistoryView.js';
import { ArchitectureView } from './components/ArchitectureView.js';
import { CollaborationView } from './components/CollaborationView.js';
import { CodeGenerationView } from './components/CodeGenerationView.js';
import { ExecutionView } from './components/ExecutionView.js';
import { DebuggingView } from './components/DebuggingView.js';
import { SettingsView } from './components/SettingsView.js';
import { UsageDashboardView } from './components/UsageDashboardView.js';
import { AuthModal } from './components/AuthModal.js';
import { ConcurrencyTestModal } from './components/ConcurrencyTestModal.js';
import { AuthPage } from './components/AuthPage.js';
import { Cpu } from 'lucide-react';

function DashboardContent() {
  const [currentTab, setCurrentTab] = useState<NavTab>('dashboard');
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isTestOpen, setIsTestOpen] = useState(false);

  const { activeBuild, fetchBuildDetails } = useSwarm();

  const handleSelectBuild = async (buildId: string) => {
    await fetchBuildDetails(buildId);
    setCurrentTab('code');
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans selection:bg-amber-500/20 selection:text-amber-200">
      {/* Universal Top Bar */}
      <Navbar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        onOpenAuth={() => setIsAuthOpen(true)}
        onOpenTestModal={() => setIsTestOpen(true)}
      />

      {/* Main Content Area */}
      <main className="flex-1">
        {currentTab === 'dashboard' && (
          <MainIdeaView onSwarmStarted={() => setCurrentTab('live')} />
        )}

        {currentTab === 'live' && (
          <LiveSwarmView onViewCode={() => setCurrentTab('code')} />
        )}

        {currentTab === 'codegen' && (
          <CodeGenerationView />
        )}

        {currentTab === 'execution' && (
          <ExecutionView />
        )}

        {currentTab === 'debug' && (
          <DebuggingView />
        )}

        {currentTab === 'collaboration' && (
          <CollaborationView />
        )}

        {currentTab === 'architecture' && (
          <ArchitectureView />
        )}

        {currentTab === 'code' && (
          <ProjectCodeView />
        )}

        {currentTab === 'merge' && (
          <MergeHistoryView />
        )}

        {currentTab === 'builds' && (
          <BuildHistoryView onSelectBuild={handleSelectBuild} />
        )}

        {currentTab === 'usage' && (
          <UsageDashboardView />
        )}

        {currentTab === 'settings' && (
          <SettingsView />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-neutral-800/80 bg-neutral-950 py-6 px-6 text-xs text-neutral-500 flex flex-col sm:flex-row items-center justify-between gap-4 font-mono">
        <div className="flex items-center gap-2">
          <span className="font-bold text-neutral-300">SquadForge</span>
          <span>·</span>
          <span>Multi-AI Autonomous Software Engineering Swarm</span>
        </div>
        <div>
          <span>Conflict-Free Sequential Merge Architecture</span>
        </div>
      </footer>

      {/* Modals */}
      <AuthModal 
        isOpen={isAuthOpen} 
        onClose={() => setIsAuthOpen(false)} 
      />

      <ConcurrencyTestModal 
        isOpen={isTestOpen} 
        onClose={() => setIsTestOpen(false)} 
      />
    </div>
  );
}

function AppRoot() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center p-6 text-neutral-400 font-sans">
        <div className="w-14 h-14 rounded-2xl bg-amber-400/10 border border-amber-400/30 flex items-center justify-center text-amber-400 mb-4 animate-pulse">
          <Cpu className="w-7 h-7" />
        </div>
        <p className="text-sm font-semibold text-neutral-200">Loading SquadForge Workspace...</p>
        <p className="text-xs text-neutral-500 font-mono mt-1">Multi-AI Parallel Swarm Engineering</p>
      </div>
    );
  }

  return (
    <SwarmProvider>
      <DashboardContent />
    </SwarmProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoot />
    </AuthProvider>
  );
}
