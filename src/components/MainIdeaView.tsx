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
  CheckSquare, 
  Square,
  ShieldCheck,
  Zap,
  DollarSign
} from 'lucide-react';

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
  const { allModels, startBuild, activeBuild } = useSwarm();
  const { user } = useAuth();

  const [idea, setIdea] = useState('');
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(
    allModels.map(m => m.id)
  );
  const [autoPush, setAutoPush] = useState(true);
  const [costLimit, setCostLimit] = useState(user?.costLimitPerBuild || 5.0);
  const [isLaunching, setIsLaunching] = useState(false);

  // Sync selected models if allModels loads later
  React.useEffect(() => {
    if (selectedModelIds.length === 0 && allModels.length > 0) {
      setSelectedModelIds(allModels.filter(m => m.enabled).map(m => m.id));
    }
  }, [allModels]);

  const toggleModel = (id: string) => {
    if (selectedModelIds.includes(id)) {
      if (selectedModelIds.length > 1) {
        setSelectedModelIds(selectedModelIds.filter(m => m !== id));
      }
    } else {
      setSelectedModelIds([...selectedModelIds, id]);
    }
  };

  const handleSelectAll = () => {
    setSelectedModelIds(allModels.map(m => m.id));
  };

  const handleDeselectAll = () => {
    // Keep at least 2 models
    setSelectedModelIds(allModels.slice(0, 2).map(m => m.id));
  };

  const handleLaunch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idea.trim() || isLaunching) return;

    setIsLaunching(true);
    const buildId = await startBuild(idea.trim(), selectedModelIds, autoPush, costLimit);
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
          10+ AI Models. One Unified Swarm. Zero Chat.
        </h1>
        <p className="text-sm text-neutral-400 max-w-2xl leading-relaxed">
          Provide your software idea. GPT, Codex, Claude, Gemini, Grok, DeepSeek, Nemotron, Llama, Mistral, and Qwen immediately launch together in parallel loops, claiming tasks, submitting verified patches, and running continuous sandbox tests until the project is complete.
        </p>
      </div>

      <form onSubmit={handleLaunch} className="space-y-6">
        {/* Main Idea Input Box */}
        <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4 shadow-xl">
          <div className="flex items-center justify-between">
            <label className="text-sm font-semibold text-neutral-200 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <span>Project Specification & Scope</span>
            </label>
            <span className="text-xs text-neutral-400 font-mono">
              The living planner will partition into ~150-line modular files
            </span>
          </div>

          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="Describe the software you want built in detail (e.g., 'A decentralized distributed key-value cache engine with TTL eviction, atomic CAS transactions, benchmark harness, and WebSocket prober')..."
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

        {/* Model Registry Multi-Select (Config-driven 10+ AI models) */}
        <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-neutral-800 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-neutral-200 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-400" />
                <span>Swarm Composition ({selectedModelIds.length} Models Selected)</span>
              </h2>
              <p className="text-xs text-neutral-400 mt-0.5">
                All selected models start concurrently at the exact same second using Promise.all
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSelectAll}
                className="px-2.5 py-1 text-xs font-mono text-neutral-300 hover:text-white bg-neutral-800 rounded border border-neutral-700"
              >
                Select All
              </button>
              <button
                type="button"
                onClick={handleDeselectAll}
                className="px-2.5 py-1 text-xs font-mono text-neutral-300 hover:text-white bg-neutral-800 rounded border border-neutral-700"
              >
                Reset Min (2)
              </button>
            </div>
          </div>

          {/* Model Selection Grid */}
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

                  <p className="text-xs text-neutral-400 line-clamp-1 mt-2">
                    {model.description}
                  </p>

                  {/* Strengths tags (rendered cleanly without pills per design constitution) */}
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

        {/* Swarm Run Parameters & Safety Controls */}
        <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4">
          <div className="text-xs font-mono uppercase tracking-wider text-neutral-400 flex items-center gap-1.5">
            <Sliders className="w-3.5 h-3.5 text-amber-400" />
            <span>Swarm Parameters & Safety Thresholds</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Auto-Push to GitHub */}
            <div className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg flex items-center justify-between">
              <div>
                <div className="text-xs font-medium text-white flex items-center gap-1.5">
                  <Github className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Auto-Push to GitHub</span>
                </div>
                <div className="text-[11px] text-neutral-400 mt-0.5">
                  Push new repository on verified completion
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
                Swarm halts automatically if spend exceeds budget
              </div>
            </div>

            {/* Task Timeout & Checks */}
            <div className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg space-y-1">
              <div className="text-xs font-medium text-white flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-blue-400" />
                <span>Automated Guardrails</span>
              </div>
              <div className="text-[11px] text-neutral-400 space-y-0.5">
                <div>• 90s atomic claim timeout lease</div>
                <div>• Sandbox build check every 5 patches</div>
                <div>• Sequential conflict-free merge manager</div>
              </div>
            </div>
          </div>
        </div>

        {/* Action Button */}
        <div className="flex items-center justify-between pt-2">
          <div className="text-xs text-neutral-400">
            {selectedModelIds.length} models will be launched concurrently as independent workers
          </div>

          <button
            type="submit"
            disabled={!idea.trim() || isLaunching || selectedModelIds.length === 0}
            className="flex items-center gap-2 px-6 py-3 text-sm font-semibold text-neutral-950 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg shadow-lg hover:shadow-amber-400/20 transition-all font-sans"
          >
            <Play className="w-4 h-4 fill-neutral-950" />
            <span>{isLaunching ? 'Initializing Swarm...' : 'Launch 10-AI Parallel Swarm'}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
