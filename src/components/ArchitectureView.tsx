import React, { useState, useEffect } from 'react';
import { useSwarm } from '../context/SwarmContext.js';
import { 
  ArchitectureBlueprint, 
  RequirementsAnalysis, 
  ProjectComplexityAssessment, 
  FileStructurePlan, 
  ArchitectureDependencyPlan,
  TechStackConfig
} from '../types/index.js';
import { 
  Layers, 
  Cpu, 
  ShieldAlert, 
  Box, 
  CheckCircle2, 
  HelpCircle, 
  AlertTriangle, 
  Workflow, 
  Terminal, 
  Monitor, 
  Smartphone, 
  Globe, 
  FolderTree, 
  Package, 
  Flame, 
  Search,
  Sparkles,
  ArrowRight
} from 'lucide-react';

export const ArchitectureView: React.FC = () => {
  const { activeBuild } = useSwarm();

  const [loading, setLoading] = useState(false);
  const [architectureData, setArchitectureData] = useState<{
    blueprint?: ArchitectureBlueprint;
    requirementsAnalysis?: RequirementsAnalysis;
    complexityAssessment?: ProjectComplexityAssessment;
    fileStructurePlan?: FileStructurePlan;
    dependencyPlan?: ArchitectureDependencyPlan;
    techStack?: TechStackConfig;
    projectType?: string;
  } | null>(null);

  // Standalone Architecture Playground Analyzer
  const [testPrompt, setTestPrompt] = useState('');
  const [analyzingPrompt, setAnalyzingPrompt] = useState(false);
  const [playgroundResult, setPlaygroundResult] = useState<any>(null);

  useEffect(() => {
    if (activeBuild?.id) {
      loadArchitecture(activeBuild.id);
    }
  }, [activeBuild?.id]);

  const loadArchitecture = async (buildId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/builds/${buildId}/architecture`);
      if (res.ok) {
        const data = await res.json();
        setArchitectureData(data);
      }
    } catch (err) {
      console.error('Failed to load architecture data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAnalyzeCustomIdea = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testPrompt.trim()) return;

    setAnalyzingPrompt(true);
    try {
      const res = await fetch('/api/architecture/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idea: testPrompt.trim() })
      });
      if (res.ok) {
        const data = await res.json();
        setPlaygroundResult(data);
      }
    } catch (err) {
      console.error('Failed to analyze idea:', err);
    } finally {
      setAnalyzingPrompt(false);
    }
  };

  const blueprint = architectureData?.blueprint || activeBuild?.architectureBlueprint;
  const analysis = architectureData?.requirementsAnalysis || activeBuild?.requirementsAnalysis;
  const complexity = architectureData?.complexityAssessment || activeBuild?.complexityAssessment;
  const filePlan = architectureData?.fileStructurePlan || activeBuild?.fileStructurePlan;
  const depPlan = architectureData?.dependencyPlan || activeBuild?.dependencyPlan;
  const techStack = architectureData?.techStack || activeBuild?.techStack;
  const projectType = architectureData?.projectType || activeBuild?.projectType || 'fullstack';

  const getPlatformIcon = (platform: string) => {
    switch (platform) {
      case 'windows':
      case 'macos':
      case 'linux':
        return <Monitor className="w-3.5 h-3.5 text-blue-400" />;
      case 'android':
      case 'ios':
        return <Smartphone className="w-3.5 h-3.5 text-emerald-400" />;
      case 'cli':
        return <Terminal className="w-3.5 h-3.5 text-amber-400" />;
      case 'web':
      default:
        return <Globe className="w-3.5 h-3.5 text-purple-400" />;
    }
  };

  const getComplexityBadgeColor = (level?: string) => {
    switch (level) {
      case 'small':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
      case 'medium':
        return 'bg-blue-500/10 text-blue-400 border-blue-500/30';
      case 'large':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      case 'very_large':
        return 'bg-orange-500/10 text-orange-400 border-orange-500/30';
      case 'enterprise_scale':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/30';
      default:
        return 'bg-neutral-800 text-neutral-300 border-neutral-700';
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8 font-sans">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pb-6 border-b border-neutral-800">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-400/10 border border-amber-400/30 flex items-center justify-center text-amber-400">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight">
                Universal Software Architecture Engine
              </h1>
              <p className="text-xs text-neutral-400 mt-0.5 font-mono">
                Platform Classification · Stack Selection · Architecture Blueprint · Subsystems
              </p>
            </div>
          </div>
        </div>

        {/* Project Type & Complexity Badges */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="px-3 py-1.5 rounded-lg bg-neutral-900 border border-neutral-800 text-xs font-mono text-neutral-300 flex items-center gap-2">
            <Box className="w-3.5 h-3.5 text-amber-400" />
            <span>Category:</span>
            <span className="font-semibold text-white uppercase">{projectType.replace(/_/g, ' ')}</span>
          </div>

          {complexity?.level && (
            <div className={`px-3 py-1.5 rounded-lg border text-xs font-mono font-semibold flex items-center gap-1.5 ${getComplexityBadgeColor(complexity.level)}`}>
              <Cpu className="w-3.5 h-3.5" />
              <span>{complexity.level.toUpperCase().replace(/_/g, ' ')}</span>
              <span>({complexity.score}/100)</span>
            </div>
          )}
        </div>
      </div>

      {/* Target Platforms & System Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Card 1: Platforms & Purpose */}
        <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono uppercase tracking-wider text-neutral-400">Target Platforms</span>
            <Globe className="w-4 h-4 text-neutral-500" />
          </div>
          <div className="flex flex-wrap gap-2">
            {(analysis?.targetPlatforms || blueprint?.targetPlatforms || ['web']).map((p) => (
              <span key={p} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-neutral-950 border border-neutral-800 text-xs font-mono text-neutral-200">
                {getPlatformIcon(p)}
                <span className="capitalize">{p}</span>
              </span>
            ))}
          </div>
          <div className="pt-2 border-t border-neutral-800/60">
            <span className="text-xs font-mono text-neutral-400">Project Purpose:</span>
            <p className="text-xs text-neutral-300 mt-1 line-clamp-3">
              {analysis?.mainPurpose || blueprint?.projectSummary || activeBuild?.idea || 'No active project selected'}
            </p>
          </div>
        </div>

        {/* Card 2: Selected Tech Stack */}
        <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-5 space-y-4 md:col-span-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono uppercase tracking-wider text-neutral-400">Selected Technology Stack</span>
            <Cpu className="w-4 h-4 text-amber-400" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="bg-neutral-950 p-2.5 rounded-lg border border-neutral-800/80">
              <span className="text-[10px] font-mono uppercase text-neutral-400 block mb-0.5">Frontend / UI Framework</span>
              <span className="text-neutral-200 font-medium">{techStack?.frontend || 'N/A'}</span>
            </div>
            <div className="bg-neutral-950 p-2.5 rounded-lg border border-neutral-800/80">
              <span className="text-[10px] font-mono uppercase text-neutral-400 block mb-0.5">Backend / Runtime</span>
              <span className="text-neutral-200 font-medium">{techStack?.backend || 'N/A'}</span>
            </div>
            <div className="bg-neutral-950 p-2.5 rounded-lg border border-neutral-800/80">
              <span className="text-[10px] font-mono uppercase text-neutral-400 block mb-0.5">Data Storage Layer</span>
              <span className="text-neutral-200 font-medium">{techStack?.database || 'Embedded / In-Memory'}</span>
            </div>
            <div className="bg-neutral-950 p-2.5 rounded-lg border border-neutral-800/80">
              <span className="text-[10px] font-mono uppercase text-neutral-400 block mb-0.5">Testing & Verification</span>
              <span className="text-neutral-200 font-medium">{techStack?.testing || 'Native Automated Test Runner'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Architecture Blueprint & Subsystems */}
      <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-6 space-y-6">
        <div className="flex items-center justify-between border-b border-neutral-800 pb-4">
          <div className="flex items-center gap-2.5">
            <Workflow className="w-5 h-5 text-amber-400" />
            <h2 className="text-base font-bold text-white">Subsystems & Architectural Modules</h2>
          </div>
          <span className="text-xs font-mono text-neutral-400">
            {blueprint?.moduleStructure?.length || 0} Modules Defined
          </span>
        </div>

        {blueprint?.moduleStructure && blueprint.moduleStructure.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {blueprint.moduleStructure.map((mod) => (
              <div key={mod.id} className="bg-neutral-950 border border-neutral-800/80 rounded-xl p-4 flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-semibold text-neutral-100">{mod.name}</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-400/10 text-amber-300 border border-amber-400/20">
                      {mod.layer}
                    </span>
                  </div>
                  <p className="text-xs text-neutral-400">{mod.description}</p>
                </div>

                <div className="space-y-2 pt-2 border-t border-neutral-900 text-xs">
                  <div>
                    <span className="text-[10px] font-mono text-neutral-400 uppercase block mb-1">Responsibilities:</span>
                    <ul className="space-y-1">
                      {mod.responsibilities.map((r, i) => (
                        <li key={i} className="text-neutral-300 text-[11px] flex items-start gap-1.5">
                          <span className="text-amber-400 font-mono">›</span>
                          <span>{r}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {mod.files && mod.files.length > 0 && (
                    <div className="pt-1">
                      <span className="text-[10px] font-mono text-neutral-400 uppercase block mb-1">Associated Files:</span>
                      <div className="flex flex-wrap gap-1">
                        {mod.files.map((f, i) => (
                          <span key={i} className="text-[10px] font-mono bg-neutral-900 px-1.5 py-0.5 rounded text-neutral-300 border border-neutral-800">
                            {f}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-10 text-neutral-500 font-mono text-xs">
            No architecture blueprint generated yet. Start a build to analyze requirements and generate modules.
          </div>
        )}
      </div>

      {/* Confirmed Requirements vs Unresolved Questions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Confirmed User Requirements */}
        <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <h3 className="text-sm font-bold text-white">Confirmed Requirements</h3>
            </div>
            <span className="text-xs font-mono text-emerald-400">
              {analysis?.confirmedRequirements?.length || 0} Confirmed
            </span>
          </div>

          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {analysis?.confirmedRequirements && analysis.confirmedRequirements.length > 0 ? (
              analysis.confirmedRequirements.map((req) => (
                <div key={req.id} className="p-2.5 rounded-lg bg-neutral-950 border border-neutral-800/80 text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono text-emerald-400 uppercase">{req.category}</span>
                    <span className="text-[10px] font-mono text-neutral-400 uppercase">{req.priority}</span>
                  </div>
                  <p className="text-neutral-200">{req.statement}</p>
                </div>
              ))
            ) : (
              <p className="text-xs text-neutral-400 font-mono py-4 text-center">No confirmed requirements extracted.</p>
            )}
          </div>
        </div>

        {/* Unresolved Questions & Missing Info */}
        <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <HelpCircle className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-bold text-white">Unresolved Questions & Assumptions</h3>
            </div>
            <span className="text-xs font-mono text-amber-400">
              {analysis?.unresolvedQuestions?.length || 0} Questions
            </span>
          </div>

          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {analysis?.unresolvedQuestions && analysis.unresolvedQuestions.length > 0 ? (
              analysis.unresolvedQuestions.map((q) => (
                <div key={q.id} className="p-2.5 rounded-lg bg-neutral-950 border border-amber-500/20 text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono text-amber-400 uppercase font-semibold">{q.category}</span>
                  </div>
                  <p className="text-neutral-200 font-medium">{q.question}</p>
                  <p className="text-[11px] text-neutral-400"><strong>Impact:</strong> {q.impact}</p>
                  {q.suggestedResolution && (
                    <p className="text-[11px] text-amber-300/80"><strong>Resolution:</strong> {q.suggestedResolution}</p>
                  )}
                </div>
              ))
            ) : (
              <div className="py-4 text-center text-xs text-neutral-400 font-mono">
                No unresolved questions identified. Requirements appear clear.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Adaptive File Structure & Dependencies */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* File Structure Plan */}
        <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <FolderTree className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-bold text-white">Planned File Hierarchy</h3>
            </div>
            <span className="text-xs font-mono text-neutral-400">
              {filePlan?.rootDirectories?.length || 0} Root Dirs
            </span>
          </div>

          <div className="space-y-2 max-h-72 overflow-y-auto pr-1 text-xs font-mono">
            {filePlan?.rootDirectories && filePlan.rootDirectories.length > 0 ? (
              filePlan.rootDirectories.map((dir, i) => (
                <div key={i} className="p-2 rounded-lg bg-neutral-950 border border-neutral-800/80">
                  <div className="text-amber-400 font-bold">{dir.path}/</div>
                  <div className="text-neutral-400 text-[11px] font-sans mt-0.5">{dir.purpose}</div>
                </div>
              ))
            ) : (
              <div className="text-center py-4 text-neutral-400">File structure plan pending.</div>
            )}
          </div>
        </div>

        {/* Architecture Dependencies & Prerequisites */}
        <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <Package className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-bold text-white">Dependencies & Prerequisites</h3>
            </div>
            <span className="text-xs font-mono text-neutral-400">
              {depPlan?.requiredDependencies?.length || 0} Core Deps
            </span>
          </div>

          <div className="space-y-2 max-h-72 overflow-y-auto pr-1 text-xs">
            {depPlan?.missingRuntimeRequirements && depPlan.missingRuntimeRequirements.length > 0 && (
              <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">
                <span className="font-semibold block text-[11px] uppercase tracking-wider mb-1">Host Tooling Prerequisites:</span>
                <ul className="space-y-0.5 list-disc list-inside text-[11px]">
                  {depPlan.missingRuntimeRequirements.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            {depPlan?.requiredDependencies && depPlan.requiredDependencies.length > 0 ? (
              depPlan.requiredDependencies.map((dep, i) => (
                <div key={i} className="p-2 rounded-lg bg-neutral-950 border border-neutral-800/80 flex items-center justify-between">
                  <div>
                    <span className="font-mono font-semibold text-neutral-200">{dep.name}</span>
                    {dep.version && <span className="ml-2 font-mono text-[10px] text-neutral-400">{dep.version}</span>}
                    <p className="text-[11px] text-neutral-400 mt-0.5">{dep.purpose}</p>
                  </div>
                  <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                    dep.verifiedInEnvironment ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-neutral-800 text-neutral-400'
                  }`}>
                    {dep.verifiedInEnvironment ? 'Verified' : 'External'}
                  </span>
                </div>
              ))
            ) : (
              <div className="text-center py-4 text-neutral-400 font-mono">Dependency plan pending.</div>
            )}
          </div>
        </div>
      </div>

      {/* Interactive Architecture Playground */}
      <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-amber-400" />
          <h2 className="text-base font-bold text-white">Live Software Architecture Playground</h2>
        </div>
        <p className="text-xs text-neutral-400">
          Test any software idea (Windows desktop app, 3D modeling tool, Android app, CLI utility, REST API, or multimedia editor) to inspect how the Universal Architecture Engine categorizes, selects technology stacks, and identifies constraints without building.
        </p>

        <form onSubmit={handleAnalyzeCustomIdea} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={testPrompt}
            onChange={(e) => setTestPrompt(e.target.value)}
            placeholder="e.g. A Windows desktop application for editing photos with GPU filters and batch export"
            className="flex-1 bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-xs text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-amber-400 font-sans"
          />
          <button
            type="submit"
            disabled={analyzingPrompt || !testPrompt.trim()}
            className="px-5 py-2.5 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-neutral-950 font-semibold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            {analyzingPrompt ? 'Analyzing...' : 'Analyze Architecture'}
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </form>

        {playgroundResult && (
          <div className="p-4 bg-neutral-950 rounded-xl border border-neutral-800 space-y-4 mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800/80 pb-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-neutral-400">Detected Category:</span>
                <span className="px-2 py-0.5 rounded bg-amber-400/10 text-amber-300 font-mono font-bold text-xs">
                  {playgroundResult.analysis?.applicationCategory}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-neutral-400">Complexity:</span>
                <span className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${getComplexityBadgeColor(playgroundResult.complexity?.level)}`}>
                  {playgroundResult.complexity?.level?.toUpperCase()} ({playgroundResult.complexity?.score}/100)
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="p-3 bg-neutral-900/60 rounded-lg border border-neutral-800/80 space-y-2">
                <span className="font-semibold text-emerald-400 font-mono block">Recommended Stack</span>
                <div className="font-bold text-white">{playgroundResult.stack?.recommendedStack?.name}</div>
                <p className="text-neutral-400">{playgroundResult.stack?.explanation}</p>
              </div>
              <div className="p-3 bg-neutral-900/60 rounded-lg border border-neutral-800/80 space-y-2">
                <span className="font-semibold text-blue-400 font-mono block">Alternative Stack</span>
                <div className="font-bold text-white">{playgroundResult.stack?.alternativeStack?.name}</div>
                <div className="text-neutral-400 text-[11px]">
                  <strong>Languages:</strong> {playgroundResult.stack?.alternativeStack?.primaryLanguage}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
