import React, { useState } from 'react';
import { useSwarm } from '../context/SwarmContext.js';
import { useAuth } from '../context/AuthContext.js';
import { 
  Play, 
  Sparkles, 
  Cpu, 
  Github, 
  Sliders, 
  Check, 
  ShieldCheck, 
  Zap, 
  DollarSign,
  Layers,
  Server,
  Database,
  TestTube,
  Shield,
  KeyRound,
  ArrowRight
} from 'lucide-react';
import { TechStackConfig } from '../types/index.js';

interface MainIdeaViewProps {
  onSwarmStarted: () => void;
}

const PRESET_IDEAS = [
  {
    title: 'Distributed Event-Driven Task Queue',
    idea: 'Build a production-grade distributed task queue with priority scheduling, exponential backoff retries, dead-letter queue, worker heartbeats, and REST/WebSocket dashboard in TypeScript.'
  },
  {
    title: 'High-Performance In-Memory Key-Value Cache',
    idea: 'Build a high-concurrency in-memory key-value cache engine supporting TTL expiration, LRU eviction, atomic transactions, snapshot persistence, and benchmark harness.'
  },
  {
    title: 'Real-Time Collaborative Canvas & Whiteboard',
    idea: 'Build a collaborative multi-user whiteboard application with vector path rendering, conflict-free replicated data types (CRDTs), live cursor tracking, and export to SVG.'
  },
  {
    title: 'Autonomous API Security & Rate-Limiter Gateway',
    idea: 'Build an API Gateway microservice with sliding-window rate limiting, token bucket algorithms, JWT signature verification, request sanitization, and Prometheus metrics endpoint.'
  }
];

export const MainIdeaView: React.FC<MainIdeaViewProps> = ({ onSwarmStarted }) => {
  const { allModels, startBuild, configStatus } = useSwarm();
  const { user } = useAuth();

  const [idea, setIdea] = useState('');
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(
    allModels.map(m => m.id)
  );
  const [autoPush, setAutoPush] = useState(true);
  const [costLimit, setCostLimit] = useState(user?.costLimitPerBuild || 5.0);
  const [isLaunching, setIsLaunching] = useState(false);

  // Architecture & Technology Stack selection
  const [showTechStack, setShowTechStack] = useState(false);
  const [techStack, setTechStack] = useState<TechStackConfig>({
    frontend: 'React 19 + TypeScript + Tailwind CSS',
    backend: 'Node.js Express + TypeScript Server API',
    database: 'In-Memory Key-Value & Document Store',
    testing: 'Node.js Native Test Runner (node:test + assert)',
    security: 'OWASP Defensive Validation, Rate Limiter & AES-256'
  });

  React.useEffect(() => {
    if (selectedModelIds.length === 0 && allModels.length > 0) {
      setSelectedModelIds(allModels.filter(m => m.enabled).map(m => m.id));
    }
  }, [allModels]);

  const toggleModel = (id: string) => {
    if (selectedModelIds.includes(id)) {
      if (selectedModelIds.length > 2) {
        setSelectedModelIds(selectedModelIds.filter(m => m !== id));
      }
    } else {
      setSelectedModelIds([...selectedModelIds, id]);
    }
  };

  const handleSelectAll = () => {
    setSelectedModelIds(allModels.map(m => m.id));
  };

  const handleLaunch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idea.trim() || isLaunching) return;

    setIsLaunching(true);
    const buildId = await startBuild(idea.trim(), selectedModelIds, autoPush, costLimit, techStack);
    setIsLaunching(false);
    if (buildId) {
      onSwarmStarted();
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
      {/* Hero Title Section */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-mono text-amber-400">
          <Zap className="w-4 h-4" />
          <span>AUTONOMOUS SOFTWARE ENGINEERING SWARM</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white font-sans">
          10 Specialized AI Agents. One Autonomous Team. Zero Chat.
        </h1>
        <p className="text-sm text-neutral-400 max-w-3xl leading-relaxed">
          Describe the application you want built. SquadForge deploys a full engineering team in parallel: Project Manager, Software Architect, Frontend Dev, Backend Dev, Database Specialist, QA Testing, Debugging, Security, and DevOps agents coordinate autonomously through sequential, conflict-free merges.
        </p>
      </div>

      {/* Provider Status Pill Bar (Safe, never exposes keys) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="p-3 bg-neutral-900 border border-neutral-800 rounded-lg flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${configStatus?.gemini.configured ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            <span className="text-neutral-300">AI Engine</span>
          </div>
          <span className={configStatus?.gemini.configured ? 'text-emerald-400' : 'text-amber-400'}>
            {configStatus?.gemini.configured ? 'Ready' : 'Not Configured'}
          </span>
        </div>

        <div className="p-3 bg-neutral-900 border border-neutral-800 rounded-lg flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${configStatus?.openrouter.configured ? 'bg-emerald-400' : 'bg-cyan-400'}`} />
            <span className="text-neutral-300">OpenRouter (3P)</span>
          </div>
          <span className={configStatus?.openrouter.configured ? 'text-emerald-400' : 'text-cyan-400'}>
            {configStatus?.openrouter.configured ? 'Direct Multi-Model' : 'Smart Gemini Fallback'}
          </span>
        </div>

        <div className="p-3 bg-neutral-900 border border-neutral-800 rounded-lg flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-2">
            <Github className="w-3.5 h-3.5 text-neutral-400" />
            <span className="text-neutral-300">GitHub Branch</span>
          </div>
          <span className="text-neutral-400 truncate max-w-[140px]">
            feature/autonomous-dev
          </span>
        </div>
      </div>

      <form onSubmit={handleLaunch} className="space-y-6">
        {/* Main Idea Input Box */}
        <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4 shadow-xl">
          <div className="flex items-center justify-between">
            <label className="text-sm font-semibold text-neutral-200 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <span>Project Requirements & Specification</span>
            </label>
            <span className="text-xs text-neutral-400 font-mono">
              Natural language prompt &rarr; 4-milestone task breakdown
            </span>
          </div>

          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="Describe the software you want built in detail (e.g. 'A high-performance in-memory key-value cache engine supporting TTL expiration, LRU eviction, atomic transactions, snapshot persistence, and benchmark harness')..."
            rows={4}
            className="w-full p-4 text-sm bg-neutral-950 border border-neutral-800 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-amber-400 font-sans leading-relaxed resize-none"
            required
          />

          {/* Quick Presets */}
          <div className="space-y-2 pt-1">
            <span className="text-xs font-mono text-neutral-400 uppercase tracking-wider">Preset Blueprints</span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {PRESET_IDEAS.map((preset, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setIdea(preset.idea)}
                  className="text-left p-3 rounded-lg bg-neutral-950/70 border border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/40 transition-colors group"
                >
                  <div className="text-xs font-semibold text-neutral-200 group-hover:text-amber-400 transition-colors">
                    {preset.title}
                  </div>
                  <div className="text-xs text-neutral-400 line-clamp-1 mt-0.5">
                    {preset.idea}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Technology Stack Customizer (Collapsible) */}
        <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4 shadow-xl">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-neutral-200 flex items-center gap-2">
                <Layers className="w-4 h-4 text-purple-400" />
                <span>Architecture & Technology Stack</span>
              </h2>
              <p className="text-xs text-neutral-400 mt-0.5">
                Software Architect automatically selects stack; customize components below if desired
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowTechStack(!showTechStack)}
              className="px-2.5 py-1 text-xs font-mono text-neutral-300 hover:text-white bg-neutral-800 rounded border border-neutral-700"
            >
              {showTechStack ? 'Hide Options' : 'Customize Stack'}
            </button>
          </div>

          {showTechStack && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-neutral-800 text-xs">
              <div>
                <label className="block text-neutral-400 mb-1 flex items-center gap-1.5 font-mono">
                  <Server className="w-3.5 h-3.5 text-orange-400" /> Frontend Framework
                </label>
                <input
                  type="text"
                  value={techStack.frontend}
                  onChange={(e) => setTechStack({ ...techStack, frontend: e.target.value })}
                  className="w-full p-2 bg-neutral-950 border border-neutral-800 rounded text-neutral-200 font-mono text-xs"
                />
              </div>

              <div>
                <label className="block text-neutral-400 mb-1 flex items-center gap-1.5 font-mono">
                  <Server className="w-3.5 h-3.5 text-blue-400" /> Backend API Engine
                </label>
                <input
                  type="text"
                  value={techStack.backend}
                  onChange={(e) => setTechStack({ ...techStack, backend: e.target.value })}
                  className="w-full p-2 bg-neutral-950 border border-neutral-800 rounded text-neutral-200 font-mono text-xs"
                />
              </div>

              <div>
                <label className="block text-neutral-400 mb-1 flex items-center gap-1.5 font-mono">
                  <Database className="w-3.5 h-3.5 text-lime-400" /> Database & Storage
                </label>
                <input
                  type="text"
                  value={techStack.database}
                  onChange={(e) => setTechStack({ ...techStack, database: e.target.value })}
                  className="w-full p-2 bg-neutral-950 border border-neutral-800 rounded text-neutral-200 font-mono text-xs"
                />
              </div>

              <div>
                <label className="block text-neutral-400 mb-1 flex items-center gap-1.5 font-mono">
                  <TestTube className="w-3.5 h-3.5 text-cyan-400" /> Testing Framework
                </label>
                <input
                  type="text"
                  value={techStack.testing}
                  onChange={(e) => setTechStack({ ...techStack, testing: e.target.value })}
                  className="w-full p-2 bg-neutral-950 border border-neutral-800 rounded text-neutral-200 font-mono text-xs"
                />
              </div>
            </div>
          )}
        </div>

        {/* Multi-Agent Development Team Selection */}
        <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-neutral-800 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-neutral-200 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-400" />
                <span>Multi-Agent Swarm ({selectedModelIds.length} Specialized Agents)</span>
              </h2>
              <p className="text-xs text-neutral-400 mt-0.5">
                Each agent fulfills a specific engineering role in the development lifecycle
              </p>
            </div>

            <button
              type="button"
              onClick={handleSelectAll}
              className="px-2.5 py-1 text-xs font-mono text-neutral-300 hover:text-white bg-neutral-800 rounded border border-neutral-700"
            >
              Select All 10 Agents
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {allModels.map((model) => {
              const isSelected = selectedModelIds.includes(model.id);
              return (
                <div
                  key={model.id}
                  onClick={() => toggleModel(model.id)}
                  className={`p-3.5 rounded-lg border cursor-pointer transition-all ${
                    isSelected 
                      ? 'bg-neutral-950 border-amber-500/40 shadow-sm' 
                      : 'bg-neutral-950/40 border-neutral-800/80 opacity-60 hover:opacity-90'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-mono font-bold px-1.5 py-0.5 rounded border ${model.avatarColor}`}>
                        {model.badge}
                      </span>
                      <span className="text-xs font-semibold text-white">
                        {model.displayName}
                      </span>
                    </div>

                    <div className={`w-4 h-4 rounded flex items-center justify-center border ${
                      isSelected ? 'bg-amber-400 border-amber-400 text-neutral-950' : 'border-neutral-700'
                    }`}>
                      {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                    </div>
                  </div>

                  <p className="text-xs text-neutral-400 line-clamp-2 mt-2">
                    {model.description}
                  </p>

                  <div className="flex flex-wrap items-center gap-1.5 mt-2.5 text-[11px] font-mono text-neutral-400">
                    {model.strengths.map((str, idx) => (
                      <React.Fragment key={str}>
                        <span>{str}</span>
                        {idx < model.strengths.length - 1 && <span className="text-neutral-600">·</span>}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Safety Thresholds & GitHub Settings */}
        <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4">
          <div className="text-xs font-mono uppercase tracking-wider text-neutral-400 flex items-center gap-1.5">
            <Sliders className="w-3.5 h-3.5 text-amber-400" />
            <span>Deployment Parameters & Guardrails</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Git Feature Branch & PR */}
            <div className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg flex items-center justify-between">
              <div>
                <div className="text-xs font-medium text-white flex items-center gap-1.5">
                  <Github className="w-3.5 h-3.5 text-emerald-400" />
                  <span>GitHub Branch & PR</span>
                </div>
                <div className="text-[11px] text-neutral-400 mt-0.5">
                  Push to feature/autonomous-development-team
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAutoPush(!autoPush)}
                className={`w-10 h-5 rounded-full transition-colors relative ${
                  autoPush ? 'bg-emerald-500' : 'bg-neutral-800'
                }`}
              >
                <div className={`w-3.5 h-3.5 rounded-full bg-white absolute top-0.5 transition-transform ${
                  autoPush ? 'left-5' : 'left-1'
                }`} />
              </button>
            </div>

            {/* Cost Cap Limit */}
            <div className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg space-y-1">
              <div className="flex items-center justify-between text-xs font-medium text-white">
                <span className="flex items-center gap-1">
                  <DollarSign className="w-3.5 h-3.5 text-amber-400" /> Cost Limit Cap
                </span>
                <span className="font-mono text-amber-300">${costLimit.toFixed(2)}</span>
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
              <div className="text-[11px] text-neutral-400">
                Halts swarm if total token spend crosses cap
              </div>
            </div>

            {/* Automated Guardrails */}
            <div className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg space-y-1">
              <div className="text-xs font-medium text-white flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-blue-400" />
                <span>Verification Guardrails</span>
              </div>
              <div className="text-[11px] text-neutral-400 space-y-0.5 font-mono">
                <div>• Dependency-aware task scheduling</div>
                <div>• Automated sandbox & unit test runs</div>
                <div>• Objective Verifier Model approval</div>
              </div>
            </div>
          </div>
        </div>

        {/* Action Button */}
        <div className="flex items-center justify-between pt-2">
          <div className="text-xs text-neutral-400">
            {selectedModelIds.length} agents will coordinate across 4 milestones with sequential merges
          </div>

          <button
            type="submit"
            disabled={!idea.trim() || isLaunching || selectedModelIds.length === 0}
            className="flex items-center gap-2 px-6 py-3 text-sm font-semibold text-neutral-950 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg shadow-lg hover:shadow-amber-400/20 transition-all font-sans"
          >
            <Play className="w-4 h-4 fill-neutral-950" />
            <span>{isLaunching ? 'Initializing Multi-Agent Swarm...' : 'Launch Autonomous Development Team'}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
