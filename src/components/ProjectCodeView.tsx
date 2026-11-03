import React, { useState } from 'react';
import JSZip from 'jszip';
import { useSwarm } from '../context/SwarmContext.js';
import { 
  FileCode, 
  Folder, 
  Copy, 
  Download, 
  Archive, 
  Check, 
  History, 
  GitCommit, 
  Clock,
  Sparkles,
  Layers,
  GitCompare,
  ArrowRight,
  Loader2,
  Eye,
  Monitor,
  Tablet,
  Smartphone,
  RefreshCw,
  BookOpen,
  CheckCircle2,
  AlertCircle,
  Send,
  MessageSquarePlus,
  ShieldCheck,
  ExternalLink,
  FolderArchive
} from 'lucide-react';
import { ProjectFile } from '../types/index.js';
import { AgentDiffViewer } from './AgentDiffViewer.js';
import { ExportZipModal } from './ExportZipModal.js';
import { buildProjectZipBlob } from '../utils/zipExporter.js';

export const ProjectCodeView: React.FC = () => {
  const { 
    activeBuild, 
    files, 
    selectedFile, 
    setSelectedFile, 
    exportProjectZip, 
    rollbackFile,
    requestRevision
  } = useSwarm();

  const [copied, setCopied] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'code' | 'diff' | 'history'>('code');
  
  // Workspace primary view mode
  const [primaryMode, setPrimaryMode] = useState<'code' | 'preview' | 'architecture' | 'revisions'>('code');
  
  // Preview viewport device
  const [previewDevice, setPreviewDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [previewKey, setPreviewKey] = useState(0);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // Natural language revision state
  const [revisionPrompt, setRevisionPrompt] = useState('');
  const [isSubmittingRevision, setIsSubmittingRevision] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [revisionSuccess, setRevisionSuccess] = useState<string | null>(null);

  const currentFile = selectedFile || (files.length > 0 ? files[0] : null);

  const handleCopy = () => {
    if (!currentFile) return;
    navigator.clipboard.writeText(currentFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadSingleFile = () => {
    if (!currentFile) return;
    const blob = new Blob([currentFile.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentFile.path.split('/').pop() || 'file.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      if (document.body.contains(a)) document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 60000);
  };

  const handleDownloadProject = async () => {
    if (!files || files.length === 0 || isDownloading) return;
    setIsDownloading(true);
    setDownloadSuccess(false);

    try {
      const { blob, filename } = await buildProjectZipBlob(activeBuild, files, {
        includeSetupGuide: true,
        includeEnvExample: true,
        includeDockerConfig: true,
        includeGitignore: true,
        includeAdrs: true,
        compressionLevel: 6
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (document.body.contains(a)) document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 60000);

      setDownloadSuccess(true);
      setTimeout(() => setDownloadSuccess(false), 3000);
    } catch (err) {
      console.error('Failed to bundle project files into ZIP:', err);
      // Fallback to server-side export endpoint
      await exportProjectZip();
    } finally {
      setIsDownloading(false);
    }
  };

  if (!files || files.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-20 text-center space-y-5">
        <FileCode className="w-12 h-12 text-neutral-600 mx-auto" />
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-white">No Generated Code Files Yet</h3>
          <p className="text-xs text-neutral-400 max-w-md mx-auto">
            When the autonomous swarm executes a project idea, the generated file workspace will appear here with full diff lineage and local development export.
          </p>
        </div>
        <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-xl max-w-md mx-auto text-xs text-neutral-400 space-y-2 text-left">
          <div className="flex items-center gap-2 text-neutral-200 font-semibold">
            <FolderArchive className="w-4 h-4 text-amber-400" />
            <span>Turnkey Local Development Export</span>
          </div>
          <p className="text-[11px] text-neutral-400 leading-relaxed">
            SquadForge packages all generated frontend, backend, test suites, and Docker files into a single ZIP archive with turnkey local startup commands once tasks complete.
          </p>
        </div>
      </div>
    );
  }

  const getModelBadge = (modelId: string) => {
    if (modelId.includes('gpt')) return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20';
    if (modelId.includes('claude')) return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
    if (modelId.includes('gemini')) return 'bg-blue-500/10 text-blue-300 border-blue-500/20';
    if (modelId.includes('deepseek')) return 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20';
    if (modelId.includes('codex')) return 'bg-teal-500/10 text-teal-300 border-teal-500/20';
    if (modelId.includes('grok')) return 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20';
    if (modelId.includes('llama')) return 'bg-violet-500/10 text-violet-300 border-violet-500/20';
    if (modelId.includes('mistral')) return 'bg-orange-500/10 text-orange-300 border-orange-500/20';
    return 'bg-purple-500/10 text-purple-300 border-purple-500/20';
  };



  const handleSubmitRevision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeBuild || !revisionPrompt.trim() || isSubmittingRevision) return;

    setIsSubmittingRevision(true);
    setRevisionError(null);
    setRevisionSuccess(null);

    const res = await requestRevision(activeBuild.id, revisionPrompt.trim());
    setIsSubmittingRevision(false);

    if (res.success) {
      setRevisionSuccess('Revision request accepted! Swarm agents are creating and executing targeted modification tasks.');
      setRevisionPrompt('');
      setTimeout(() => setRevisionSuccess(null), 5000);
    } else {
      setRevisionError(res.error || 'Failed to submit revision request');
    }
  };

  const adrList = activeBuild?.architectureDecisions || [];
  const reqList = activeBuild?.requirementsChecklist || [];
  const revList = activeBuild?.revisions || [];

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-4">
      {/* Action Header & Primary Mode Switcher */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 bg-neutral-900 border border-neutral-800 rounded-xl">
        <div className="flex items-center gap-3">
          <Folder className="w-5 h-5 text-amber-400" />
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <span>Project Workspace & Architecture</span>
              {activeBuild?.projectType && (
                <span className="text-[10px] font-mono uppercase bg-amber-400/20 text-amber-300 px-2 py-0.5 rounded border border-amber-400/30">
                  {activeBuild.projectType.replace('_', ' ')}
                </span>
              )}
            </h2>
            <p className="text-xs text-neutral-400">
              Autonomous engineering assets, interactive preview, architecture decision records, and natural language revisions
            </p>
          </div>
        </div>

        {/* Primary View Switcher */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex bg-neutral-950 p-1 rounded-lg border border-neutral-800 text-xs">
            <button
              onClick={() => setPrimaryMode('code')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all ${
                primaryMode === 'code'
                  ? 'bg-amber-400 text-neutral-950 font-semibold shadow'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <FileCode className="w-3.5 h-3.5" />
              <span>Files ({files.length})</span>
            </button>

            <button
              onClick={() => setPrimaryMode('preview')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all ${
                primaryMode === 'preview'
                  ? 'bg-amber-400 text-neutral-950 font-semibold shadow'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Live Preview</span>
            </button>

            <button
              onClick={() => setPrimaryMode('architecture')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all ${
                primaryMode === 'architecture'
                  ? 'bg-amber-400 text-neutral-950 font-semibold shadow'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>ADRs & Requirements</span>
            </button>

            <button
              onClick={() => setPrimaryMode('revisions')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all ${
                primaryMode === 'revisions'
                  ? 'bg-amber-400 text-neutral-950 font-semibold shadow'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <MessageSquarePlus className="w-3.5 h-3.5" />
              <span>Revisions {revList.length > 0 && `(${revList.length})`}</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsExportModalOpen(true)}
              disabled={files.length === 0}
              className="flex items-center gap-2 px-3.5 py-1.5 text-xs font-bold rounded-lg bg-amber-400 hover:bg-amber-300 text-neutral-950 shadow-md shadow-amber-500/10 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              title="Configure and export project as ZIP archive for local development"
            >
              <FolderArchive className="w-4 h-4" />
              <span>Export ZIP</span>
              <span className="px-1.5 py-0.2 bg-neutral-950/20 text-neutral-950 text-[10px] font-mono rounded font-bold">
                {files.length}
              </span>
            </button>

            <button
              onClick={handleDownloadProject}
              disabled={isDownloading || files.length === 0}
              className={`p-1.5 text-xs font-medium rounded-lg border transition-all cursor-pointer ${
                downloadSuccess
                  ? 'bg-emerald-500 text-neutral-950 border-emerald-400'
                  : isDownloading
                  ? 'bg-amber-500/30 text-amber-300 border-amber-500/50 cursor-wait'
                  : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white border-neutral-700'
              }`}
              title="Quick download ZIP with turnkey local dev assets"
              aria-label="Quick download ZIP"
            >
              {isDownloading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : downloadSuccess ? (
                <Check className="w-4 h-4 text-emerald-950" />
              ) : (
                <Download className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Primary Mode 1: Code Explorer & Diff */}
      {primaryMode === 'code' && (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-start min-h-[600px]">
          {/* Left: File Tree */}
          <div className="p-3 bg-neutral-900 border border-neutral-800 rounded-xl space-y-2 lg:col-span-1">
            <div className="px-2 py-1 text-xs font-mono uppercase tracking-wider text-neutral-400 border-b border-neutral-800 pb-2 flex items-center justify-between">
              <span>Files</span>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-neutral-400">{files.length} items</span>
                <button
                  onClick={() => setIsExportModalOpen(true)}
                  className="p-1 text-neutral-400 hover:text-amber-400 hover:bg-neutral-800 rounded transition-colors cursor-pointer"
                  title="Export all files as ZIP for local dev"
                  aria-label="Export all files as ZIP"
                >
                  <Archive className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="space-y-1 max-h-[560px] overflow-y-auto">
              {files.map(file => {
                const isSelected = currentFile?.path === file.path;
                return (
                  <button
                    key={file.path}
                    onClick={() => setSelectedFile(file)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono transition-colors flex items-center justify-between group ${
                      isSelected 
                        ? 'bg-neutral-950 text-amber-300 border border-neutral-800' 
                        : 'text-neutral-400 hover:text-white hover:bg-neutral-950/50'
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <FileCode className="w-3.5 h-3.5 shrink-0 text-neutral-400 group-hover:text-amber-400" />
                      <span className="truncate">{file.path}</span>
                    </div>
                    <span className="text-[10px] text-neutral-400 shrink-0 ml-1">
                      v{file.version}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right: Code Viewer, Diff & Attribution */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden lg:col-span-3 flex flex-col">
            {/* File Tab Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-3 border-b border-neutral-800 bg-neutral-950">
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono font-semibold text-white">
                  {currentFile?.path}
                </span>
                <span className="text-xs font-mono text-neutral-400">
                  (v{currentFile?.version})
                </span>
                {currentFile && (
                  <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${getModelBadge(currentFile.ownerModel)}`}>
                    author: {currentFile.ownerModel}
                  </span>
                )}
              </div>

              {/* View Mode Tabs & Actions */}
              <div className="flex items-center gap-2">
                <div className="flex bg-neutral-900 p-0.5 rounded-lg border border-neutral-800 text-xs">
                  <button
                    onClick={() => setActiveTab('code')}
                    className={`px-3 py-1 rounded font-medium transition-colors ${
                      activeTab === 'code' ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    Code
                  </button>
                  <button
                    onClick={() => setActiveTab('diff')}
                    className={`px-3 py-1 rounded font-medium transition-colors flex items-center gap-1 ${
                      activeTab === 'diff' ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    <GitCompare className="w-3 h-3" />
                    <span>Diff</span>
                  </button>
                  <button
                    onClick={() => setActiveTab('history')}
                    className={`px-3 py-1 rounded font-medium transition-colors ${
                      activeTab === 'history' ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    Lineage ({currentFile?.history?.length || 1})
                  </button>
                </div>

                <button
                  onClick={handleCopy}
                  className="p-1.5 text-neutral-400 hover:text-white bg-neutral-900 border border-neutral-800 rounded-lg transition-colors"
                  title="Copy file content"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>

                <button
                  onClick={handleDownloadSingleFile}
                  className="p-1.5 text-neutral-400 hover:text-white bg-neutral-900 border border-neutral-800 rounded-lg transition-colors cursor-pointer"
                  title="Download this file"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Tab Content */}
            {activeTab === 'code' && (
              <div className="p-4 overflow-x-auto font-mono text-xs text-neutral-200 bg-neutral-950/80 min-h-[500px] leading-relaxed">
                <table className="w-full border-collapse">
                  <tbody>
                    {(currentFile?.content || '').split('\n').map((line, idx) => (
                      <tr key={idx} className="hover:bg-neutral-900/50">
                        <td className="w-10 pr-4 text-right text-neutral-600 select-none tabular-nums text-[11px]">
                          {idx + 1}
                        </td>
                        <td className="whitespace-pre">
                          {line || ' '}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'diff' && currentFile && (
              <AgentDiffViewer file={currentFile} />
            )}

            {activeTab === 'history' && (
              <div className="p-4 space-y-3 bg-neutral-950/80 min-h-[500px]">
                <div className="text-xs text-neutral-400 pb-2 border-b border-neutral-800">
                  Complete sequential edit lineage for <span className="font-mono text-white">{currentFile?.path}</span>:
                </div>

                <div className="space-y-3">
                  {currentFile?.history.slice().reverse().map((ver) => {
                    const time = new Date(ver.timestamp).toLocaleTimeString();
                    return (
                      <div 
                        key={ver.version}
                        className="p-3 bg-neutral-900 border border-neutral-800 rounded-lg space-y-2 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-amber-400">v{ver.version}</span>
                            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${getModelBadge(ver.authorModel)}`}>
                              {ver.authorModel}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-neutral-500 font-mono text-[11px]">{time}</span>
                            {ver.version !== currentFile.version && (
                              <button
                                onClick={() => rollbackFile(currentFile.path, ver.version)}
                                className="px-2 py-0.5 text-[11px] font-mono text-amber-300 hover:text-white bg-amber-500/10 border border-amber-500/20 rounded cursor-pointer"
                              >
                                Revert to v{ver.version}
                              </button>
                            )}
                          </div>
                        </div>

                        <p className="text-neutral-300 font-mono text-[11px]">
                          {ver.commitMessage || `Revision ${ver.version}`}
                        </p>

                        <div className="text-[11px] font-mono text-neutral-500">
                          {ver.content.split('\n').length} lines of code
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Primary Mode 2: Interactive Live Preview */}
      {primaryMode === 'preview' && (
        <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4">
          {/* Viewport & Controls Bar */}
          <div className="flex flex-col gap-3 p-3 bg-neutral-950 border border-neutral-800 rounded-lg">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-mono text-neutral-400 mr-1">Viewport:</span>
                <div className="flex bg-neutral-900 p-0.5 rounded-lg border border-neutral-800 text-xs">
                  <button
                    onClick={() => setPreviewDevice('desktop')}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded font-medium transition-colors ${
                      previewDevice === 'desktop' ? 'bg-neutral-800 text-amber-300' : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    <Monitor className="w-3.5 h-3.5" />
                    <span>Desktop (100%)</span>
                  </button>
                  <button
                    onClick={() => setPreviewDevice('tablet')}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded font-medium transition-colors ${
                      previewDevice === 'tablet' ? 'bg-neutral-800 text-amber-300' : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    <Tablet className="w-3.5 h-3.5" />
                    <span>Tablet (768px)</span>
                  </button>
                  <button
                    onClick={() => setPreviewDevice('mobile')}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded font-medium transition-colors ${
                      previewDevice === 'mobile' ? 'bg-neutral-800 text-amber-300' : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    <Smartphone className="w-3.5 h-3.5" />
                    <span>Mobile (375px)</span>
                  </button>
                </div>

                {/* Preview Mode Indicator Pill */}
                {activeBuild?.previewMode === 'real_application' && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 shadow-[0_0_12px_rgba(16,185,129,0.15)]">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                    <span>Real Application (Vite/ESM)</span>
                  </span>
                )}
                {activeBuild?.previewMode === 'static_html' && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-sky-500/10 text-sky-400 border border-sky-500/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-sky-400"></span>
                    <span>Static HTML Render</span>
                  </span>
                )}
                {activeBuild?.previewMode === 'fallback_preview' && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
                    <AlertCircle className="w-3 h-3 text-amber-400 shrink-0" />
                    <span>Fallback Demonstration · Unverified</span>
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {(activeBuild?.previewDiagnostic || (activeBuild?.previewRuntimeErrors && activeBuild.previewRuntimeErrors.length > 0)) && (
                  <button
                    onClick={() => setShowDiagnostics(d => !d)}
                    className={`flex items-center gap-1 px-2.5 py-1 text-xs font-mono rounded border transition-colors ${
                      showDiagnostics
                        ? 'bg-neutral-800 text-amber-300 border-amber-500/40'
                        : 'text-neutral-400 hover:text-neutral-200 bg-neutral-900 border-neutral-800'
                    }`}
                    title="Toggle Preview Diagnostics"
                  >
                    <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
                    <span>Diagnostics</span>
                  </button>
                )}

                <button
                  onClick={() => setPreviewKey(k => k + 1)}
                  className="flex items-center gap-1 px-3 py-1 text-xs font-mono text-neutral-300 hover:text-white bg-neutral-900 hover:bg-neutral-850 border border-neutral-800 rounded transition-colors"
                  title="Reload preview iframe"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Reload</span>
                </button>

                {activeBuild && (
                  <a
                    href={`/api/builds/${activeBuild.id}/preview`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 px-3 py-1 text-xs font-mono text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Open Raw Tab</span>
                  </a>
                )}
              </div>
            </div>

            {/* Expandable Diagnostics Drawer */}
            {showDiagnostics && (
              <div className="p-3 bg-neutral-900 border border-neutral-800 rounded-lg space-y-2 text-xs font-mono">
                <div className="flex items-center justify-between text-neutral-400 pb-1 border-b border-neutral-800">
                  <span className="font-semibold text-neutral-300">Preview Execution Diagnostics</span>
                  <span className="text-[10px] uppercase text-neutral-500">Mode: {activeBuild?.previewMode || 'unknown'}</span>
                </div>
                {activeBuild?.previewDiagnostic && (
                  <div className="text-neutral-300 leading-relaxed whitespace-pre-wrap">
                    {activeBuild.previewDiagnostic}
                  </div>
                )}
                {activeBuild?.previewRuntimeErrors && activeBuild.previewRuntimeErrors.length > 0 && (
                  <div className="p-2 bg-red-950/40 border border-red-900/50 rounded text-red-300 space-y-1">
                    <div className="font-semibold text-red-400">Captured Runtime Exceptions:</div>
                    {activeBuild.previewRuntimeErrors.map((err, idx) => (
                      <div key={idx} className="text-[11px] font-mono whitespace-pre-wrap">
                        {err}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Sandboxed iframe container */}
          <div className="flex justify-center bg-neutral-950 p-4 rounded-xl border border-neutral-800 overflow-x-auto min-h-[640px]">
            <div 
              className={`transition-all duration-300 ease-in-out border border-neutral-800 rounded-lg shadow-2xl overflow-hidden bg-white ${
                previewDevice === 'desktop' 
                  ? 'w-full' 
                  : previewDevice === 'tablet' 
                  ? 'w-[768px]' 
                  : 'w-[375px]'
              }`}
              style={{ minHeight: '620px' }}
            >
              {activeBuild ? (
                <iframe
                  key={previewKey}
                  src={`/api/builds/${activeBuild.id}/preview?v=${previewKey}`}
                  title="SquadForge Application Live Preview"
                  className="w-full h-full border-0 bg-white"
                  style={{ minHeight: '620px' }}
                  sandbox="allow-scripts allow-forms allow-same-origin allow-modals"
                />
              ) : (
                <div className="p-12 text-center text-xs font-mono text-neutral-500">
                  No active build to preview. Launch a project to generate live preview.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Primary Mode 3: Architecture Decision Records (ADRs) & Requirements */}
      {primaryMode === 'architecture' && (
        <div className="space-y-6">
          {/* Architecture Decisions */}
          <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-purple-400" />
                <h3 className="text-sm font-bold text-white">Architecture Decision Records (ADRs)</h3>
              </div>
              <span className="text-xs font-mono text-neutral-400">
                {adrList.length} formal architectural decisions recorded
              </span>
            </div>

            {adrList.length === 0 ? (
              <p className="text-xs text-neutral-400 py-4">No ADRs recorded for this build.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {adrList.map((adr) => {
                  const statusBadge = 
                    adr.status === 'accepted' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                    adr.status === 'proposed' ? 'bg-blue-500/10 text-blue-400 border-blue-500/30' :
                    adr.status === 'rejected' ? 'bg-rose-500/10 text-rose-400 border-rose-500/30' :
                    'bg-amber-500/10 text-amber-400 border-amber-500/30 line-through';

                  return (
                    <div key={adr.id} className="p-4 bg-neutral-950 border border-neutral-800 rounded-lg space-y-3 text-xs flex flex-col justify-between">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-amber-400 font-bold">{adr.id}</span>
                          <span className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase border ${statusBadge}`}>
                            {adr.status}
                          </span>
                        </div>
                        <div className="font-semibold text-white text-sm">{adr.title}</div>
                        {adr.supersedes && (
                          <div className="text-[10px] font-mono text-amber-300">
                            Supersedes: <span className="font-bold">{adr.supersedes}</span>
                          </div>
                        )}
                        {adr.supersededBy && (
                          <div className="text-[10px] font-mono text-neutral-400">
                            Superseded by: <span className="font-bold text-amber-300">{adr.supersededBy}</span>
                          </div>
                        )}
                        <div>
                          <div className="text-[11px] font-mono text-neutral-500 uppercase tracking-wider mb-0.5">Context & Problem</div>
                          <p className="text-neutral-400 leading-relaxed text-[11px]">{adr.context}</p>
                        </div>
                        <div>
                          <div className="text-[11px] font-mono text-neutral-500 uppercase tracking-wider mb-0.5">Proposed Solution & Decision</div>
                          <p className="text-neutral-300 leading-relaxed text-[11px] font-medium">{adr.proposedSolution || adr.decision}</p>
                        </div>
                        {adr.alternativesConsidered && adr.alternativesConsidered.length > 0 && (
                          <div>
                            <div className="text-[11px] font-mono text-neutral-500 uppercase tracking-wider mb-0.5">Alternatives Considered</div>
                            <div className="flex flex-wrap gap-1">
                              {adr.alternativesConsidered.map((alt, i) => (
                                <span key={i} className="px-1.5 py-0.2 bg-neutral-900 border border-neutral-800 rounded text-[10px] text-neutral-300">
                                  {alt}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {((adr.advantages && adr.advantages.length > 0) || (adr.disadvantages && adr.disadvantages.length > 0)) && (
                          <div className="grid grid-cols-2 gap-2 pt-1 border-t border-neutral-800/60">
                            <div>
                              <span className="text-[10px] font-mono text-emerald-400 uppercase font-bold block">Advantages:</span>
                              <ul className="text-[10px] text-neutral-400 list-disc list-inside space-y-0.5 mt-0.5">
                                {(adr.advantages || []).map((adv, i) => (
                                  <li key={i}>{adv}</li>
                                ))}
                              </ul>
                            </div>
                            <div>
                              <span className="text-[10px] font-mono text-rose-400 uppercase font-bold block">Disadvantages:</span>
                              <ul className="text-[10px] text-neutral-400 list-disc list-inside space-y-0.5 mt-0.5">
                                {(adr.disadvantages || []).map((dis, i) => (
                                  <li key={i}>{dis}</li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        )}
                        {adr.consequences && (
                          <div>
                            <div className="text-[11px] font-mono text-neutral-500 uppercase tracking-wider mb-0.5">Consequences</div>
                            <p className="text-neutral-400 leading-relaxed text-[11px]">{adr.consequences}</p>
                          </div>
                        )}
                      </div>
                      {(adr.affectedFiles?.length || adr.affectedModules?.length) ? (
                        <div className="pt-2 border-t border-neutral-800/60 flex flex-wrap gap-1 text-[10px] font-mono text-neutral-400">
                          <span className="text-neutral-500">Affected:</span>
                          {(adr.affectedModules || []).concat(adr.affectedFiles || []).slice(0, 3).map((item, idx) => (
                            <span key={idx} className="px-1 py-0.2 bg-neutral-900 border border-neutral-800 rounded text-neutral-300">
                              {item}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Requirements Checklist */}
          <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <h3 className="text-sm font-bold text-white">Requirements Verification Checklist</h3>
              </div>
              <span className="text-xs font-mono text-neutral-400">
                {reqList.filter(r => r.satisfied || r.status === 'satisfied' || r.status === 'implemented').length} of {reqList.length} criteria satisfied
              </span>
            </div>

            {reqList.length === 0 ? (
              <p className="text-xs text-neutral-400 py-4">No requirements checklist initialized.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {reqList.map((req) => {
                  const isImplemented = req.status === 'implemented' || req.status === 'satisfied' || req.satisfied;
                  const isFailed = req.status === 'failed';
                  const isBlocked = req.status === 'blocked';
                  const isPartial = req.status === 'partially_implemented';

                  return (
                    <div 
                      key={req.id}
                      className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg space-y-2 text-xs"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase bg-neutral-900 text-neutral-400 border border-neutral-800">
                            {req.category}
                          </span>
                          <span className="font-semibold text-neutral-200">
                            {req.title || req.description?.slice(0, 40)}
                          </span>
                        </div>
                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border uppercase shrink-0 ${
                          isImplemented ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' :
                          isPartial ? 'bg-amber-500/10 text-amber-300 border-amber-500/30' :
                          isBlocked ? 'bg-purple-500/10 text-purple-300 border-purple-500/30' :
                          isFailed ? 'bg-rose-500/10 text-rose-300 border-rose-500/30' :
                          'bg-neutral-800 text-neutral-400 border-neutral-700'
                        }`}>
                          {req.status || (req.satisfied ? 'implemented' : 'unmet')}
                        </span>
                      </div>

                      <p className="text-[11px] text-neutral-400 leading-relaxed">
                        {req.description}
                      </p>

                      {req.evidence && (
                        <div className="p-2 bg-neutral-900/60 rounded border border-neutral-800/80 text-[11px] font-mono text-neutral-300 space-y-0.5">
                          <span className="text-[10px] uppercase text-neutral-500 font-bold block">Deterministic Evidence:</span>
                          <span className="text-neutral-300 leading-normal">{req.evidence}</span>
                        </div>
                      )}

                      {req.satisfiedByFiles && req.satisfiedByFiles.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1 text-[10px] font-mono text-neutral-400 pt-1">
                          <span className="text-neutral-500">Files:</span>
                          {req.satisfiedByFiles.map((fp, idx) => (
                            <span key={idx} className="px-1 py-0.2 bg-neutral-900 border border-neutral-800 rounded text-neutral-300">
                              {fp}
                            </span>
                          ))}
                        </div>
                      )}

                      {req.testsExecuted && req.testsExecuted.length > 0 && (
                        <div className="text-[10px] font-mono text-emerald-400/90 pt-0.5">
                          Tests: {req.testsExecuted.join(', ')}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Primary Mode 4: Natural Language Revisions */}
      {primaryMode === 'revisions' && (
        <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-xl space-y-6">
          <div className="space-y-1">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <MessageSquarePlus className="w-4 h-4 text-amber-400" />
              <span>Request Natural Language Modification</span>
            </h3>
            <p className="text-xs text-neutral-400">
              Direct the AI swarm to modify, enhance, or fix existing code files while preserving working architecture.
            </p>
          </div>

          <form onSubmit={handleSubmitRevision} className="space-y-3">
            <textarea
              value={revisionPrompt}
              onChange={(e) => setRevisionPrompt(e.target.value)}
              placeholder="E.g. 'Add a dark mode toggle button to the top navbar with localStorage persistence', or 'Add comprehensive unit tests for the token authentication middleware'..."
              rows={3}
              className="w-full p-3 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-amber-400 font-sans leading-relaxed resize-none"
              required
            />

            {revisionError && (
              <div className="p-2.5 rounded bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{revisionError}</span>
              </div>
            )}

            {revisionSuccess && (
              <div className="p-2.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{revisionSuccess}</span>
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!revisionPrompt.trim() || isSubmittingRevision}
                className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-neutral-950 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg shadow transition-all cursor-pointer"
              >
                {isSubmittingRevision ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Dispatching Agents...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5" />
                    <span>Apply Revision to Project</span>
                  </>
                )}
              </button>
            </div>
          </form>

          {/* Revision History */}
          <div className="space-y-3 pt-3 border-t border-neutral-800">
            <h4 className="text-xs font-mono uppercase tracking-wider text-neutral-400">
              Revision History ({revList.length})
            </h4>

            {revList.length === 0 ? (
              <p className="text-xs text-neutral-500 font-mono py-2">
                No revisions have been requested for this build yet.
              </p>
            ) : (
              <div className="space-y-2">
                {revList.slice().reverse().map((rev) => (
                  <div key={rev.id} className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg space-y-1.5 text-xs">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-amber-400">Rev #{rev.revisionNumber}</span>
                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border uppercase ${
                          rev.status === 'completed'
                            ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                            : rev.status === 'executing'
                            ? 'bg-blue-500/10 text-blue-300 border-blue-500/20'
                            : 'bg-amber-500/10 text-amber-300 border-amber-500/20'
                        }`}>
                          {rev.status}
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-neutral-500">
                        {new Date(rev.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-neutral-200 font-sans text-xs">
                      "{rev.prompt}"
                    </p>
                    <div className="text-[11px] font-mono text-neutral-500">
                      {(rev.tasksGenerated?.length || 1)} targeted task(s) dispatched to swarm
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <ExportZipModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        build={activeBuild}
        files={files}
        onServerExportFallback={exportProjectZip}
      />
    </div>
  );
};
