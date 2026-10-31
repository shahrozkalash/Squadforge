import React, { useState, useMemo } from 'react';
import {
  GitCompare,
  Columns2,
  Rows,
  Filter,
  Clock,
  GitCommit,
  Check,
  Search,
  ChevronDown,
  ChevronUp,
  Layers,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import { ProjectFile } from '../types/index.js';
import {
  computeAgentDiff,
  computeHistoricalBlame,
  getAgentMeta,
  DiffLine,
  SplitDiffRow,
} from '../utils/diffEngine.js';

interface AgentDiffViewerProps {
  file: ProjectFile;
  className?: string;
}

export const AgentDiffViewer: React.FC<AgentDiffViewerProps> = ({ file, className = '' }) => {
  // Sort history chronologically (v1, v2, v3...)
  const history = useMemo(() => {
    if (!file.history || file.history.length === 0) {
      // Fallback synthetic history for v1 if none present
      return [{
        version: file.version || 1,
        content: file.content || '',
        timestamp: file.updatedAt || file.createdAt || Date.now(),
        authorModel: file.ownerModel || 'software_architect',
        commitMessage: 'Initial file creation',
      }];
    }
    return [...file.history].sort((a, b) => a.version - b.version);
  }, [file]);

  const maxVersion = history[history.length - 1]?.version || file.version || 1;

  // View state
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split');
  const [baseVersion, setBaseVersion] = useState<number>(() => {
    if (history.length >= 2) {
      return history[history.length - 2].version;
    }
    // If only 1 version, base is 0 (empty initial file)
    return 0;
  });
  const [targetVersion, setTargetVersion] = useState<number>(() => maxVersion);
  const [selectedAgentFilter, setSelectedAgentFilter] = useState<string | null>(null);
  const [hideUnchanged, setHideUnchanged] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);

  // Compute text contents for base and target
  const baseContent = useMemo(() => {
    if (baseVersion === 0) return '';
    const found = history.find(h => h.version === baseVersion);
    return found ? found.content : '';
  }, [history, baseVersion]);

  const targetRevision = useMemo(() => {
    return history.find(h => h.version === targetVersion) || history[history.length - 1];
  }, [history, targetVersion]);

  const targetContent = targetRevision?.content ?? file.content ?? '';

  // Calculate historical blame up to target version
  const blameMap = useMemo(() => {
    return computeHistoricalBlame(history, targetVersion);
  }, [history, targetVersion]);

  // Compute Diff & Line-by-Line Agent Attribution
  const diffResult = useMemo(() => {
    const baseRev = history.find(h => h.version === baseVersion);
    return computeAgentDiff(baseContent, targetContent, {
      oldVersion: baseVersion,
      newVersion: targetVersion,
      defaultTargetAgent: targetRevision?.authorModel || file.ownerModel,
      defaultOldAgent: baseRev?.authorModel || file.ownerModel,
      commitMessage: targetRevision?.commitMessage,
      timestamp: targetRevision?.timestamp,
      blameMap,
    });
  }, [baseContent, targetContent, baseVersion, targetVersion, targetRevision, file.ownerModel, history, blameMap]);

  // Filtered lines for Unified mode
  const filteredUnifiedLines = useMemo(() => {
    return diffResult.lines.filter(line => {
      // Unchanged filter
      if (hideUnchanged && line.type === 'unchanged') return false;

      // Search filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesContent = line.content.toLowerCase().includes(q);
        const matchesAuthor = line.author?.toLowerCase().includes(q);
        if (!matchesContent && !matchesAuthor) return false;
      }

      return true;
    });
  }, [diffResult.lines, hideUnchanged, searchQuery]);

  // Filtered rows for Split mode
  const filteredSplitRows = useMemo(() => {
    return diffResult.splitRows.filter(row => {
      const isUnchanged = row.left?.type === 'unchanged' && row.right?.type === 'unchanged';
      if (hideUnchanged && isUnchanged) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const leftMatch = row.left?.content.toLowerCase().includes(q);
        const rightMatch = row.right?.content.toLowerCase().includes(q);
        const authorMatch = row.right?.author?.toLowerCase().includes(q);
        if (!leftMatch && !rightMatch && !authorMatch) return false;
      }

      return true;
    });
  }, [diffResult.splitRows, hideUnchanged, searchQuery]);

  // Quick preset handlers
  const handleSetPrevToCurrent = () => {
    if (history.length >= 2) {
      setBaseVersion(history[history.length - 2].version);
      setTargetVersion(history[history.length - 1].version);
    } else {
      setBaseVersion(0);
      setTargetVersion(maxVersion);
    }
  };

  const handleSetInitialToLatest = () => {
    setBaseVersion(history[0].version);
    setTargetVersion(maxVersion);
  };

  const handleSetFullCreation = () => {
    setBaseVersion(0);
    setTargetVersion(maxVersion);
  };

  return (
    <div className={`flex flex-col bg-neutral-950 border border-neutral-800 rounded-xl overflow-hidden text-xs font-mono ${className}`}>
      {/* 1. Header Toolbar: Mode selector, version dropdowns & quick presets */}
      <div className="flex flex-col gap-3 p-3.5 bg-neutral-900 border-b border-neutral-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left: Version Selectors */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-neutral-400 font-medium flex items-center gap-1.5">
              <GitCompare className="w-4 h-4 text-amber-400" />
              <span>Diff Range:</span>
            </span>

            {/* Baseline Version */}
            <div className="flex items-center gap-1 bg-neutral-950 border border-neutral-800 px-2 py-1 rounded-lg">
              <span className="text-[10px] text-neutral-400 uppercase tracking-wide">Base:</span>
              <select
                value={baseVersion}
                onChange={e => setBaseVersion(Number(e.target.value))}
                className="bg-transparent text-rose-300 font-bold focus:outline-none cursor-pointer"
              >
                <option value={0} className="bg-neutral-900 text-neutral-300">
                  v0 (Empty Initial)
                </option>
                {history.map(h => (
                  <option key={h.version} value={h.version} className="bg-neutral-900 text-neutral-200">
                    v{h.version} ({h.authorModel})
                  </option>
                ))}
              </select>
            </div>

            <ArrowRight className="w-3.5 h-3.5 text-neutral-600 shrink-0" />

            {/* Target Version */}
            <div className="flex items-center gap-1 bg-neutral-950 border border-neutral-800 px-2 py-1 rounded-lg">
              <span className="text-[10px] text-neutral-400 uppercase tracking-wide">Target:</span>
              <select
                value={targetVersion}
                onChange={e => setTargetVersion(Number(e.target.value))}
                className="bg-transparent text-emerald-300 font-bold focus:outline-none cursor-pointer"
              >
                {history.map(h => (
                  <option key={h.version} value={h.version} className="bg-neutral-900 text-neutral-200">
                    v{h.version} {h.version === maxVersion ? '(Latest)' : ''} ({h.authorModel})
                  </option>
                ))}
              </select>
            </div>

            {/* Quick Presets */}
            <div className="hidden sm:flex items-center gap-1 text-[11px] ml-1">
              {history.length >= 2 && (
                <button
                  onClick={handleSetPrevToCurrent}
                  className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white rounded transition-colors"
                  title="Compare previous iteration with current version"
                >
                  Prev vs Current
                </button>
              )}
              {history.length > 2 && (
                <button
                  onClick={handleSetInitialToLatest}
                  className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white rounded transition-colors"
                  title="Compare v1 with latest version"
                >
                  v1 vs Latest
                </button>
              )}
              <button
                onClick={handleSetFullCreation}
                className="px-2 py-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white rounded transition-colors"
                title="View full initial creation diff from blank file"
              >
                Full Creation
              </button>
            </div>
          </div>

          {/* Right: View Mode Toggle (Unified / Split) */}
          <div className="flex items-center gap-2">
            <div className="flex items-center bg-neutral-950 p-1 rounded-lg border border-neutral-800">
              <button
                onClick={() => setViewMode('split')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded font-medium transition-all ${
                  viewMode === 'split'
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow-sm'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Side-by-side split comparison"
              >
                <Columns2 className="w-3.5 h-3.5" />
                <span>Split</span>
              </button>
              <button
                onClick={() => setViewMode('unified')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded font-medium transition-all ${
                  viewMode === 'unified'
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow-sm'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Single column unified comparison"
              >
                <Rows className="w-3.5 h-3.5" />
                <span>Unified</span>
              </button>
            </div>
          </div>
        </div>

        {/* 2. Secondary Filter Bar: Agent attribution chips, changes-only toggle, and search */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-neutral-800/80 text-[11px]">
          {/* Agent Filters */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-neutral-400 flex items-center gap-1 mr-1">
              <Filter className="w-3 h-3 text-neutral-400" />
              <span>Agents:</span>
            </span>

            <button
              onClick={() => setSelectedAgentFilter(null)}
              className={`px-2 py-0.5 rounded-full border transition-all ${
                selectedAgentFilter === null
                  ? 'bg-neutral-800 text-white border-neutral-600 font-semibold'
                  : 'bg-neutral-950 text-neutral-400 border-neutral-800 hover:border-neutral-700'
              }`}
            >
              All Agents
            </button>

            {diffResult.summary.agentStats.map(stat => {
              const meta = getAgentMeta(stat.agent);
              const isSelected = selectedAgentFilter === stat.agent;
              return (
                <button
                  key={stat.agent}
                  onClick={() => setSelectedAgentFilter(isSelected ? null : stat.agent)}
                  className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border transition-all ${
                    isSelected
                      ? `${meta.badgeClass} ring-1 ring-amber-400 font-semibold`
                      : 'bg-neutral-950 text-neutral-300 border-neutral-800 hover:border-neutral-700'
                  }`}
                  title={`${stat.agent}: ${stat.additions} additions, ${stat.modifications} modifications, ${stat.deletions} deletions`}
                >
                  <span>{meta.roleIcon}</span>
                  <span className="truncate max-w-[120px]">{meta.displayName}</span>
                  <span className="text-[10px] px-1 rounded bg-neutral-900 border border-neutral-800 text-neutral-400">
                    +{stat.additions + stat.modifications}
                  </span>
                </button>
              );
            })}

            {diffResult.summary.agentStats.length === 0 && (
              <span className="text-neutral-400 italic">No modifications detected</span>
            )}
          </div>

          {/* Right Controls: Changes Only & Search */}
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 cursor-pointer text-neutral-400 hover:text-white select-none">
              <input
                type="checkbox"
                checked={hideUnchanged}
                onChange={e => setHideUnchanged(e.target.checked)}
                className="rounded border-neutral-700 text-amber-500 focus:ring-0 cursor-pointer"
              />
              <span>Changes only</span>
            </label>

            <div className="relative flex items-center">
              <Search className="w-3 h-3 text-neutral-400 absolute left-2 pointer-events-none" />
              <input
                type="text"
                placeholder="Filter lines..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="bg-neutral-950 border border-neutral-800 rounded-lg pl-6 pr-2 py-0.5 text-neutral-200 placeholder-neutral-400 focus:outline-none focus:border-amber-500/50 w-32 sm:w-40"
              />
            </div>
          </div>
        </div>

        {/* 3. Commit Context Note & Summary Stats */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 bg-neutral-950/70 border border-neutral-800/60 rounded-lg text-[11px]">
          <div className="flex items-center gap-2 truncate">
            <GitCommit className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
            <span className="text-neutral-400 shrink-0">v{targetVersion} commit:</span>
            <span className="text-neutral-200 truncate font-medium">
              {targetRevision?.commitMessage || `Revision ${targetVersion} changes`}
            </span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <span className="text-emerald-400 font-bold">+{diffResult.summary.additions}</span>
            <span className="text-amber-400 font-bold">~{diffResult.summary.modifications}</span>
            <span className="text-rose-400 font-bold">-{diffResult.summary.deletions}</span>
            <span className="text-neutral-400">
              ({diffResult.summary.totalChanges} changed / {diffResult.summary.unchanged} unchanged)
            </span>
          </div>
        </div>
      </div>

      {/* 4. Diff View Body */}
      <div className="overflow-x-auto min-h-[500px] max-h-[750px] overflow-y-auto bg-neutral-950 p-2">
        {viewMode === 'unified' ? (
          /* UNIFIED DIFF VIEW */
          <div className="w-full">
            {filteredUnifiedLines.length === 0 ? (
              <div className="py-16 text-center text-neutral-400 space-y-2">
                <Sparkles className="w-8 h-8 mx-auto text-neutral-400" />
                <p>No lines match the active filter criteria or no differences found.</p>
              </div>
            ) : (
              <table className="w-full border-collapse font-mono">
                <tbody>
                  {filteredUnifiedLines.map(line => {
                    const isHighlighted = selectedAgentFilter
                      ? line.author?.toLowerCase().includes(selectedAgentFilter.toLowerCase())
                      : false;
                    const isDimmed = selectedAgentFilter && !isHighlighted;
                    const agentMeta = getAgentMeta(line.author);

                    const lineBg =
                      line.type === 'added'
                        ? 'bg-emerald-950/30 text-emerald-200'
                        : line.type === 'deleted'
                        ? 'bg-rose-950/30 text-rose-200'
                        : isHighlighted
                        ? `${agentMeta.bgGlowClass} text-neutral-100`
                        : 'text-neutral-300 hover:bg-neutral-900/40';

                    return (
                      <tr
                        key={line.id}
                        className={`group border-b border-neutral-900/40 transition-colors ${lineBg} ${
                          isDimmed ? 'opacity-30' : 'opacity-100'
                        } ${isHighlighted ? `border-l-2 ${agentMeta.borderClass}` : ''}`}
                      >
                        {/* Old line number */}
                        <td className="w-10 px-2 py-0.5 text-right text-neutral-400 select-none text-[11px] font-mono">
                          {line.oldLineNumber || ''}
                        </td>

                        {/* New line number */}
                        <td className="w-10 px-2 py-0.5 text-right text-neutral-400 select-none text-[11px] font-mono border-r border-neutral-900">
                          {line.newLineNumber || ''}
                        </td>

                        {/* Symbol */}
                        <td className="w-6 px-1.5 py-0.5 text-center font-bold select-none text-[12px]">
                          {line.type === 'added' ? (
                            <span className="text-emerald-400">+</span>
                          ) : line.type === 'deleted' ? (
                            <span className="text-rose-400">-</span>
                          ) : (
                            <span className="text-neutral-400"> </span>
                          )}
                        </td>

                        {/* Code Content */}
                        <td className="py-0.5 px-2 whitespace-pre leading-5 font-mono">
                          {line.content || ' '}
                        </td>

                        {/* Agent Attribution Gutter Badge */}
                        <td className="w-48 px-2 py-0.5 text-right select-none">
                          {line.author && (line.type === 'added' || isHighlighted) && (
                            <div className="inline-flex items-center gap-1.5 relative">
                              <button
                                onClick={() => setActiveTooltip(activeTooltip === line.id ? null : line.id)}
                                className={`text-[10px] px-1.5 py-0.5 rounded border inline-flex items-center gap-1 cursor-pointer transition-colors ${agentMeta.badgeClass}`}
                                title={`Authored by ${line.author} in v${line.version || targetVersion}`}
                              >
                                <span>{agentMeta.roleIcon}</span>
                                <span className="truncate max-w-[85px]">{agentMeta.displayName}</span>
                                <span className="opacity-70">v{line.version || targetVersion}</span>
                              </button>

                              {/* Interactive Details Tooltip */}
                              {activeTooltip === line.id && (
                                <div className="absolute right-0 bottom-6 z-30 w-64 p-2.5 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl text-left text-neutral-300 space-y-1.5">
                                  <div className="flex items-center justify-between text-[10px] font-bold border-b border-neutral-800 pb-1">
                                    <span className="text-amber-400">Agent Attribution</span>
                                    <span className="text-neutral-400">v{line.version || targetVersion}</span>
                                  </div>
                                  <div className="text-[11px]">
                                    <div className="font-semibold text-white">{line.author}</div>
                                    <div className="text-neutral-400 mt-0.5">
                                      {line.commitMessage || 'Automated swarm code revision'}
                                    </div>
                                  </div>
                                  {line.timestamp && (
                                    <div className="text-[10px] text-neutral-400 flex items-center gap-1">
                                      <Clock className="w-3 h-3" />
                                      {new Date(line.timestamp).toLocaleTimeString()}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          /* SPLIT (SIDE-BY-SIDE) DIFF VIEW */
          <div className="w-full">
            {filteredSplitRows.length === 0 ? (
              <div className="py-16 text-center text-neutral-400 space-y-2">
                <Sparkles className="w-8 h-8 mx-auto text-neutral-400" />
                <p>No lines match the active filter criteria or no differences found.</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 divide-x divide-neutral-800 font-mono">
                {/* Column Headers */}
                <div className="px-3 py-1.5 bg-neutral-900/80 border-b border-neutral-800 text-[11px] font-semibold text-neutral-400 flex items-center justify-between">
                  <span>Baseline (v{baseVersion === 0 ? '0: empty' : baseVersion})</span>
                  <span className="text-neutral-400">Original State</span>
                </div>
                <div className="px-3 py-1.5 bg-neutral-900/80 border-b border-neutral-800 text-[11px] font-semibold text-neutral-400 flex items-center justify-between">
                  <span>Target (v{targetVersion})</span>
                  <span className="text-amber-400/80">Swarm Agent Mod</span>
                </div>

                {/* Rows */}
                {filteredSplitRows.map(row => {
                  const rightAgent = row.right?.author;
                  const isHighlighted = selectedAgentFilter
                    ? rightAgent?.toLowerCase().includes(selectedAgentFilter.toLowerCase())
                    : false;
                  const isDimmed = selectedAgentFilter && !isHighlighted;
                  const rightMeta = getAgentMeta(rightAgent);

                  // Left column style
                  const leftBg =
                    row.left?.type === 'deleted'
                      ? 'bg-rose-950/30 text-rose-200'
                      : row.left?.type === 'modified'
                      ? 'bg-amber-950/20 text-neutral-300'
                      : 'text-neutral-400 hover:bg-neutral-900/40';

                  // Right column style
                  const rightBg =
                    row.right?.type === 'added'
                      ? 'bg-emerald-950/30 text-emerald-200'
                      : row.right?.type === 'modified'
                      ? 'bg-amber-950/25 text-amber-200'
                      : isHighlighted
                      ? `${rightMeta.bgGlowClass} text-neutral-100`
                      : 'text-neutral-300 hover:bg-neutral-900/40';

                  return (
                    <React.Fragment key={row.id}>
                      {/* Left Pane (Base) */}
                      <div
                        className={`flex items-start border-b border-neutral-900/40 py-0.5 px-2 transition-colors ${leftBg} ${
                          isDimmed ? 'opacity-30' : 'opacity-100'
                        }`}
                      >
                        <span className="w-8 shrink-0 text-right pr-2 text-neutral-400 select-none text-[11px]">
                          {row.left?.lineNumber || ''}
                        </span>
                        <span className="w-4 shrink-0 text-center select-none font-bold">
                          {row.left?.type === 'deleted' ? '-' : row.left?.type === 'modified' ? '~' : ''}
                        </span>
                        <span className="whitespace-pre overflow-x-hidden leading-5">
                          {row.left?.content || ' '}
                        </span>
                      </div>

                      {/* Right Pane (Target with Agent attribution) */}
                      <div
                        className={`flex items-start justify-between border-b border-neutral-900/40 py-0.5 px-2 transition-colors ${rightBg} ${
                          isDimmed ? 'opacity-30' : 'opacity-100'
                        } ${isHighlighted ? `border-l-2 ${rightMeta.borderClass}` : ''}`}
                      >
                        <div className="flex items-start overflow-x-hidden">
                          <span className="w-8 shrink-0 text-right pr-2 text-neutral-400 select-none text-[11px]">
                            {row.right?.lineNumber || ''}
                          </span>
                          <span className="w-4 shrink-0 text-center select-none font-bold">
                            {row.right?.type === 'added' ? '+' : row.right?.type === 'modified' ? '~' : ''}
                          </span>
                          <span className="whitespace-pre overflow-x-hidden leading-5">
                            {row.right?.content || ' '}
                          </span>
                        </div>

                        {/* Attribution badge for added/modified lines */}
                        {row.right && (row.right.type === 'added' || row.right.type === 'modified' || isHighlighted) && (
                          <div className="shrink-0 ml-2 relative">
                            <button
                              onClick={() => setActiveTooltip(activeTooltip === row.id ? null : row.id)}
                              className={`text-[10px] px-1.5 py-0.5 rounded border inline-flex items-center gap-1 cursor-pointer transition-colors ${rightMeta.badgeClass}`}
                              title={`${rightAgent} (v${row.right.version || targetVersion})`}
                            >
                              <span>{rightMeta.roleIcon}</span>
                              <span className="truncate max-w-[75px]">{rightMeta.displayName}</span>
                            </button>

                            {/* Interactive Tooltip */}
                            {activeTooltip === row.id && (
                              <div className="absolute right-0 bottom-6 z-30 w-64 p-2.5 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl text-left text-neutral-300 space-y-1.5">
                                <div className="flex items-center justify-between text-[10px] font-bold border-b border-neutral-800 pb-1">
                                  <span className="text-amber-400">Agent Modification</span>
                                  <span className="text-neutral-400">v{row.right.version || targetVersion}</span>
                                </div>
                                <div className="text-[11px]">
                                  <div className="font-semibold text-white">{row.right.author}</div>
                                  <div className="text-neutral-400 mt-0.5">
                                    {row.right.commitMessage || targetRevision?.commitMessage || 'Targeted build iteration'}
                                  </div>
                                </div>
                                {row.right.timestamp && (
                                  <div className="text-[10px] text-neutral-400 flex items-center gap-1">
                                    <Clock className="w-3 h-3" />
                                    {new Date(row.right.timestamp).toLocaleTimeString()}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 5. Footer: Legend and Agent Attribution Breakdown Bar */}
      <div className="p-3 bg-neutral-900 border-t border-neutral-800 flex flex-wrap items-center justify-between gap-3 text-[11px] text-neutral-400">
        <div className="flex items-center gap-3">
          <span className="text-neutral-400 font-medium">Legend:</span>
          <span className="inline-flex items-center gap-1 text-emerald-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span> Added
          </span>
          <span className="inline-flex items-center gap-1 text-amber-300">
            <span className="w-2 h-2 rounded-full bg-amber-400"></span> Modified
          </span>
          <span className="inline-flex items-center gap-1 text-rose-300">
            <span className="w-2 h-2 rounded-full bg-rose-400"></span> Deleted
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span>Click any agent chip or line badge to inspect author commit details</span>
        </div>
      </div>
    </div>
  );
};
