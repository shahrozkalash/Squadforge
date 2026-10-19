import React, { useState } from 'react';
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
  User, 
  Clock,
  Sparkles,
  Layers
} from 'lucide-react';
import { ProjectFile } from '../types/index.js';

export const ProjectCodeView: React.FC = () => {
  const { files, selectedFile, setSelectedFile, exportProjectZip, activeBuild, rollbackFile } = useSwarm();
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'code' | 'history' | 'diff'>('code');

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
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!files || files.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-20 text-center space-y-4">
        <FileCode className="w-10 h-10 text-neutral-600 mx-auto" />
        <h3 className="text-lg font-semibold text-white">No Generated Code Files Yet</h3>
        <p className="text-xs text-neutral-400">
          When the 10-model swarm executes an idea, the living file tree will populate here in real time.
        </p>
      </div>
    );
  }

  // Model color badge mapping
  const getModelBadge = (modelId: string) => {
    if (modelId.includes('gpt')) return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20';
    if (modelId.includes('claude')) return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
    if (modelId.includes('gemini')) return 'bg-blue-500/10 text-blue-300 border-blue-500/20';
    if (modelId.includes('deepseek')) return 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20';
    if (modelId.includes('codex')) return 'bg-teal-500/10 text-teal-300 border-teal-500/20';
    if (modelId.includes('grok')) return 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20';
    return 'bg-purple-500/10 text-purple-300 border-purple-500/20';
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-4">
      {/* Action Header: Export ZIP, File counts */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 bg-neutral-900 border border-neutral-800 rounded-xl">
        <div className="flex items-center gap-3">
          <Folder className="w-5 h-5 text-amber-400" />
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <span>Project Workspace Repository</span>
              <span className="text-xs font-mono font-normal text-neutral-400">
                ({files.length} modular files)
              </span>
            </h2>
            <p className="text-xs text-neutral-400">
              Each file created & patched through conflict-free Merge Manager with complete version history
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={exportProjectZip}
            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-neutral-950 bg-amber-400 hover:bg-amber-300 rounded-lg shadow transition-colors"
          >
            <Archive className="w-4 h-4" />
            <span>Export Project ZIP</span>
          </button>
        </div>
      </div>

      {/* Main Workspace (Left: File Explorer, Right: Code Viewer & Diff) */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-start min-h-[600px]">
        {/* Left: File Tree */}
        <div className="p-3 bg-neutral-900 border border-neutral-800 rounded-xl space-y-2 lg:col-span-1">
          <div className="px-2 py-1 text-xs font-mono uppercase tracking-wider text-neutral-400 border-b border-neutral-800 pb-2 flex items-center justify-between">
            <span>Files</span>
            <span className="text-[11px] text-neutral-400">{files.length} items</span>
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

        {/* Right: Code Viewer & Attribution */}
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
                  latest: {currentFile.ownerModel}
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
                  onClick={() => setActiveTab('history')}
                  className={`px-3 py-1 rounded font-medium transition-colors ${
                    activeTab === 'history' ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white'
                  }`}
                >
                  Who Wrote What ({currentFile?.history?.length || 1})
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
                className="p-1.5 text-neutral-400 hover:text-white bg-neutral-900 border border-neutral-800 rounded-lg transition-colors"
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
                              className="px-2 py-0.5 text-[11px] font-mono text-amber-300 hover:text-white bg-amber-500/10 border border-amber-500/20 rounded"
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
    </div>
  );
};
