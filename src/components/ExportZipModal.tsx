import React, { useState, useEffect, useRef } from 'react';
import { 
  Archive, 
  Download, 
  X, 
  Check, 
  Copy, 
  Terminal, 
  FileCode, 
  FolderArchive, 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  AlertTriangle,
  Layers, 
  HelpCircle,
  FileCheck,
  Server,
  Settings2
} from 'lucide-react';
import { Build, ProjectFile } from '../types/index.js';
import { 
  calculateArchiveStats, 
  formatLocalDevCommands, 
  getSanitizedArchiveName, 
  buildProjectZipBlob, 
  detectProjectStack,
  LocalDevExportOptions 
} from '../utils/zipExporter.js';

interface ExportZipModalProps {
  isOpen: boolean;
  onClose: () => void;
  build: Build | null;
  files: ProjectFile[];
  onServerExportFallback?: () => Promise<void>;
}

export const ExportZipModal: React.FC<ExportZipModalProps> = ({
  isOpen,
  onClose,
  build,
  files,
  onServerExportFallback
}) => {
  const [archiveSlug, setArchiveSlug] = useState(() => getSanitizedArchiveName(build?.idea));
  const [includeSetupGuide, setIncludeSetupGuide] = useState(true);
  const [includeEnvExample, setIncludeEnvExample] = useState(true);
  const [includeDockerConfig, setIncludeDockerConfig] = useState(true);
  const [includeGitignore, setIncludeGitignore] = useState(true);
  const [includeAdrs, setIncludeAdrs] = useState(true);
  
  const [isExporting, setIsExporting] = useState(false);
  const [exportStep, setExportStep] = useState<string>('');
  const [exportSuccess, setExportSuccess] = useState(false);
  const [exportedFilename, setExportedFilename] = useState('');
  const [copiedCommands, setCopiedCommands] = useState(false);
  const [showManifest, setShowManifest] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const isExportingRef = useRef(false);

  // Reset modal state when changing projects or reopening
  useEffect(() => {
    if (isOpen) {
      setArchiveSlug(getSanitizedArchiveName(build?.idea));
      setIsExporting(false);
      isExportingRef.current = false;
      setExportStep('');
      setExportSuccess(false);
      setExportedFilename('');
      setExportError(null);
      setCopiedCommands(false);
      setShowManifest(false);

      // Focus close button on open
      setTimeout(() => {
        closeButtonRef.current?.focus();
      }, 50);
    }
  }, [build?.id, isOpen]);

  // Support Escape to close and keyboard trap
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isEmptyProject = !files || files.length === 0;
  const stats = calculateArchiveStats(files, build);
  const stackInfo = detectProjectStack(files, build);
  const finalFilename = `${archiveSlug || 'squadforge-project'}.zip`;
  const commands = formatLocalDevCommands(finalFilename, files, stackInfo);

  const handleCopyCommands = async () => {
    try {
      await navigator.clipboard.writeText(commands);
      setCopiedCommands(true);
      setTimeout(() => setCopiedCommands(false), 2000);
    } catch (err) {
      console.warn('Clipboard write failed:', err);
      setExportError('Clipboard access denied or unavailable. Please select and copy the terminal commands manually.');
    }
  };

  const handleDownloadZip = async () => {
    if (isEmptyProject || isExporting || isExportingRef.current) return;

    isExportingRef.current = true;
    setIsExporting(true);
    setExportError(null);
    setExportSuccess(false);
    setExportStep('Validating archive paths and security boundaries...');

    try {
      const options: LocalDevExportOptions = {
        archiveName: archiveSlug,
        includeSetupGuide,
        includeEnvExample,
        includeDockerConfig,
        includeGitignore,
        includeAdrs,
        compressionLevel: 6
      };

      setExportStep('Analyzing tech stack and generating turnkey local files...');
      // Small tick to allow UI rendering
      await new Promise(r => setTimeout(r, 40));

      setExportStep('Packaging project files into compressed ZIP...');
      const { blob, filename } = await buildProjectZipBlob(build, files, options);
      
      setExportStep('Initiating browser download stream...');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();

      // Fix premature object URL revocation: revoke after download has started safely
      setTimeout(() => {
        try {
          if (document.body.contains(a)) {
            document.body.removeChild(a);
          }
          URL.revokeObjectURL(url);
        } catch {}
      }, 60000);

      setExportedFilename(filename);
      setExportSuccess(true);
      setExportStep('');
      setTimeout(() => {
        setExportSuccess(false);
      }, 6000);
    } catch (err: any) {
      console.error('Failed to generate client-side ZIP:', err);
      const initialError = err?.message || 'Client packaging failed';

      if (onServerExportFallback) {
        setExportStep('Attempting server-side fallback export...');
        try {
          await onServerExportFallback();
          setExportSuccess(true);
          setExportedFilename(finalFilename);
          setExportStep('');
        } catch (fallbackErr: any) {
          setExportError(`Export failed: ${fallbackErr?.message || initialError}`);
          setExportStep('');
        }
      } else {
        setExportError(`Packaging failed: ${initialError}`);
        setExportStep('');
      }
    } finally {
      setIsExporting(false);
      isExportingRef.current = false;
    }
  };

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-modal-title"
      onClick={onClose}
    >
      {/* Screen reader live announcements */}
      <div className="sr-only" aria-live="polite">
        {exportStep || (exportSuccess ? `Downloaded ${exportedFilename} successfully` : (exportError || ''))}
      </div>

      <div 
        ref={modalRef}
        tabIndex={-1}
        className="w-full max-w-2xl bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-950">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-400/10 border border-amber-400/30 flex items-center justify-center text-amber-400">
              <FolderArchive className="w-5 h-5" />
            </div>
            <div>
              <h2 id="export-modal-title" className="text-base font-bold text-white flex items-center gap-2">
                Export for Local Development
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-400/20 text-amber-300 border border-amber-400/30 uppercase">
                  {stackInfo.displayName}
                </span>
              </h2>
              <p className="text-xs text-neutral-400">
                Download the complete generated project bundle ready to run on your local machine
              </p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="Close export modal"
            className="p-1.5 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-5 overflow-y-auto">
          {/* Empty Project Warning */}
          {isEmptyProject && (
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-amber-200">No project files available</p>
                <p className="text-neutral-400 mt-0.5">
                  This project has not generated any source files yet. Start the autonomous swarm or write files in the editor before exporting.
                </p>
              </div>
            </div>
          )}

          {/* Project Stats Summary Card */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 bg-neutral-950 rounded-xl border border-neutral-800 text-xs">
            <div>
              <span className="text-[10px] text-neutral-500 uppercase tracking-wider block">Generated Files</span>
              <span className="text-sm font-bold text-white font-mono">{stats.totalFiles} files</span>
            </div>
            <div>
              <span className="text-[10px] text-neutral-500 uppercase tracking-wider block">Unpacked Size</span>
              <span className="text-sm font-bold text-amber-400 font-mono">{stats.formattedSize}</span>
            </div>
            <div>
              <span className="text-[10px] text-neutral-500 uppercase tracking-wider block">Detected Stack</span>
              <span className="text-sm font-bold text-neutral-200 capitalize truncate block">
                {stackInfo.displayName}
              </span>
            </div>
            <div>
              <span className="text-[10px] text-neutral-500 uppercase tracking-wider block">Archive Format</span>
              <span className="text-sm font-bold text-emerald-400 font-mono">.ZIP (DEFLATE)</span>
            </div>
          </div>

          {/* Archive Filename Customizer */}
          <div className="space-y-1.5">
            <label htmlFor="archive-name-input" className="text-xs font-semibold text-neutral-300 flex items-center justify-between">
              <span>Archive Filename</span>
              <span className="text-[11px] text-neutral-500 font-mono">Downloads as {finalFilename}</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                id="archive-name-input"
                type="text"
                value={archiveSlug}
                onChange={(e) => setArchiveSlug(getSanitizedArchiveName(e.target.value))}
                placeholder="squadforge-project"
                disabled={isExporting}
                className="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-xs font-mono text-white placeholder-neutral-600 focus:outline-none focus:border-amber-400 disabled:opacity-50"
              />
              <span className="text-xs font-mono text-neutral-500 shrink-0">.zip</span>
            </div>
          </div>

          {/* Local Development Enhancements Checkboxes */}
          <div className="space-y-2">
            <span className="text-xs font-semibold text-neutral-300 block">
              Local Development Accessories (Included in ZIP)
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <label className="flex items-start gap-2.5 p-2.5 bg-neutral-950/60 border border-neutral-800/80 rounded-lg hover:border-neutral-700 transition-colors cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeSetupGuide}
                  onChange={(e) => setIncludeSetupGuide(e.target.checked)}
                  disabled={isExporting}
                  className="mt-0.5 rounded border-neutral-700 text-amber-500 focus:ring-0 focus:ring-offset-0"
                />
                <div>
                  <span className="font-medium text-neutral-200 block">Local Setup Guide</span>
                  <span className="text-[11px] text-neutral-500 block">
                    Adds <code className="text-neutral-400">LOCAL_SETUP.md</code> with install, run, and test steps
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-2.5 p-2.5 bg-neutral-950/60 border border-neutral-800/80 rounded-lg hover:border-neutral-700 transition-colors cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeEnvExample}
                  onChange={(e) => setIncludeEnvExample(e.target.checked)}
                  disabled={isExporting}
                  className="mt-0.5 rounded border-neutral-700 text-amber-500 focus:ring-0 focus:ring-offset-0"
                />
                <div>
                  <span className="font-medium text-neutral-200 block">Environment Template</span>
                  <span className="text-[11px] text-neutral-500 block">
                    Adds <code className="text-neutral-400">.env.example</code> with intelligent credentials guide
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-2.5 p-2.5 bg-neutral-950/60 border border-neutral-800/80 rounded-lg hover:border-neutral-700 transition-colors cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeDockerConfig}
                  onChange={(e) => setIncludeDockerConfig(e.target.checked)}
                  disabled={isExporting}
                  className="mt-0.5 rounded border-neutral-700 text-amber-500 focus:ring-0 focus:ring-offset-0"
                />
                <div>
                  <span className="font-medium text-neutral-200 block">Containerized Docker Setup</span>
                  <span className="text-[11px] text-neutral-500 block">
                    Adds stack-aware <code className="text-neutral-400">Dockerfile</code> & <code className="text-neutral-400">docker-compose.yml</code>
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-2.5 p-2.5 bg-neutral-950/60 border border-neutral-800/80 rounded-lg hover:border-neutral-700 transition-colors cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeGitignore}
                  onChange={(e) => setIncludeGitignore(e.target.checked)}
                  disabled={isExporting}
                  className="mt-0.5 rounded border-neutral-700 text-amber-500 focus:ring-0 focus:ring-offset-0"
                />
                <div>
                  <span className="font-medium text-neutral-200 block">Git Ignore Configuration</span>
                  <span className="text-[11px] text-neutral-500 block">
                    Adds <code className="text-neutral-400">.gitignore</code> preventing commits of node_modules & secrets
                  </span>
                </div>
              </label>
            </div>
          </div>

          {/* Quick Start Terminal Box */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-neutral-300 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-amber-400" />
                <span>Run Locally in Terminal</span>
              </span>
              <button
                onClick={handleCopyCommands}
                className="text-[11px] font-mono text-neutral-400 hover:text-white flex items-center gap-1 px-2 py-0.5 rounded hover:bg-neutral-800 transition-colors cursor-pointer"
              >
                {copiedCommands ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span className="text-emerald-400 font-semibold">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Copy Commands</span>
                  </>
                )}
              </button>
            </div>
            <pre className="p-3 bg-neutral-950 rounded-xl border border-neutral-800 text-[11px] font-mono text-neutral-300 overflow-x-auto select-all leading-relaxed">
              {commands}
            </pre>
          </div>

          {/* Collapsible File Manifest */}
          <div className="border border-neutral-800 rounded-xl overflow-hidden text-xs">
            <button
              onClick={() => setShowManifest(!showManifest)}
              className="w-full flex items-center justify-between px-3.5 py-2.5 bg-neutral-950 hover:bg-neutral-900 transition-colors text-left cursor-pointer"
            >
              <span className="font-medium text-neutral-300 flex items-center gap-2">
                <FileCode className="w-3.5 h-3.5 text-amber-400" />
                <span>Archive File Manifest ({files.length} source files)</span>
              </span>
              <span className="text-[11px] text-neutral-500">
                {showManifest ? 'Hide files' : 'View included files'}
              </span>
            </button>
            {showManifest && (
              <div className="p-3 bg-neutral-950/70 border-t border-neutral-800 max-h-48 overflow-y-auto space-y-1 font-mono text-[11px]">
                {files.map(f => (
                  <div key={f.path} className="flex items-center justify-between text-neutral-400 hover:text-white py-0.5">
                    <span className="truncate">{f.path.replace(/^\/+/, '')}</span>
                    <span className="text-[10px] text-neutral-600 shrink-0">v{f.version}</span>
                  </div>
                ))}
                {includeSetupGuide && (
                  <div className="flex items-center justify-between text-amber-400/90 py-0.5">
                    <span>LOCAL_SETUP.md (guide)</span>
                    <span className="text-[10px] text-amber-500/80">generated</span>
                  </div>
                )}
                {includeDockerConfig && (
                  <>
                    <div className="flex items-center justify-between text-blue-400/90 py-0.5">
                      <span>Dockerfile ({stackInfo.type})</span>
                      <span className="text-[10px] text-blue-500/80">generated</span>
                    </div>
                    <div className="flex items-center justify-between text-blue-400/90 py-0.5">
                      <span>docker-compose.yml</span>
                      <span className="text-[10px] text-blue-500/80">generated</span>
                    </div>
                  </>
                )}
                {includeGitignore && (
                  <div className="flex items-center justify-between text-neutral-400 py-0.5">
                    <span>.gitignore</span>
                    <span className="text-[10px] text-neutral-500">generated</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Export Progress Bar */}
          {isExporting && exportStep && (
            <div className="p-3 rounded-xl bg-amber-400/10 border border-amber-400/20 text-xs space-y-2">
              <div className="flex items-center gap-2 text-amber-300 font-medium">
                <Loader2 className="w-4 h-4 animate-spin shrink-0 text-amber-400" />
                <span>{exportStep}</span>
              </div>
              <div className="w-full bg-neutral-800 h-1 rounded-full overflow-hidden">
                <div className="bg-amber-400 h-full animate-pulse w-3/4 rounded-full" />
              </div>
            </div>
          )}

          {/* Feedback & Errors */}
          {exportError && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <strong className="block font-semibold">Export Failed</strong>
                <span>{exportError}</span>
              </div>
            </div>
          )}

          {exportSuccess && (
            <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>
                  Downloaded <strong className="font-mono text-white">{exportedFilename || finalFilename}</strong>! Ready for local development.
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-neutral-800 bg-neutral-950">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors cursor-pointer"
          >
            Close
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={handleDownloadZip}
              disabled={isExporting || isEmptyProject}
              className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl shadow-lg transition-all ${
                isEmptyProject
                  ? 'bg-neutral-800 text-neutral-500 cursor-not-allowed shadow-none'
                  : exportSuccess
                  ? 'bg-emerald-500 text-neutral-950 font-extrabold cursor-pointer'
                  : isExporting
                  ? 'bg-amber-500/70 text-neutral-950 cursor-wait'
                  : 'bg-amber-400 hover:bg-amber-300 text-neutral-950 shadow-amber-500/20 cursor-pointer'
              }`}
            >
              {isExporting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Packaging Archive...</span>
                </>
              ) : exportSuccess ? (
                <>
                  <Check className="w-4 h-4" />
                  <span>Downloaded!</span>
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  <span>Download ZIP Archive</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
