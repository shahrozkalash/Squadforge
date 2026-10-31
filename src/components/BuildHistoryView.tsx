import React, { useState, useEffect, useMemo } from 'react';
import { Build, BuildStatus } from '../types/index.js';
import { 
  History, 
  ExternalLink, 
  ArrowRight,
  Github,
  Search,
  X,
  Filter,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  PlayCircle,
  StopCircle
} from 'lucide-react';
import { 
  BuildStatusFilter, 
  filterBuilds, 
  getStatusCounts 
} from '../utils/buildFilter.js';

interface BuildHistoryViewProps {
  onSelectBuild: (buildId: string) => void;
}

export const BuildHistoryView: React.FC<BuildHistoryViewProps> = ({ onSelectBuild }) => {
  const [builds, setBuilds] = useState<Build[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<BuildStatusFilter>('all');

  const fetchBuilds = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/builds');
      if (res.ok) {
        const data = await res.json();
        setBuilds(data.builds || []);
      }
    } catch (err) {
      console.error('Failed to fetch build history:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBuilds();
  }, []);

  const counts = useMemo(() => getStatusCounts(builds), [builds]);

  const filteredBuilds = useMemo(() => {
    return filterBuilds(builds, { searchQuery, statusFilter });
  }, [builds, searchQuery, statusFilter]);

  const hasActiveFilters = searchQuery.trim() !== '' || statusFilter !== 'all';

  const resetFilters = () => {
    setSearchQuery('');
    setStatusFilter('all');
  };

  const getStatusBadgeStyle = (status: BuildStatus) => {
    switch (status) {
      case 'completed':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      case 'failed':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
      case 'stopped':
      case 'cancelled':
        return 'bg-neutral-800 text-neutral-400 border-neutral-700';
      case 'running':
      case 'in_progress':
      case 'planning':
      case 'verifying':
      case 'pending':
      default:
        return 'bg-amber-500/10 text-amber-400 border-amber-500/20 animate-pulse';
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white font-sans flex items-center gap-2">
            <History className="w-5 h-5 text-amber-400" />
            <span>Swarm Build History</span>
          </h2>
          <p className="text-xs text-neutral-400 mt-0.5">
            Past multi-model autonomous software engineering runs
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchBuilds}
            aria-label="Refresh build history"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono text-neutral-300 hover:text-white bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 hover:border-neutral-700 rounded-lg transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Filter and Search Controls Bar */}
      <div className="p-4 bg-neutral-900/90 border border-neutral-800/80 rounded-xl space-y-3.5">
          <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
            {/* Search Input */}
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-500">
                <Search className="w-4 h-4" />
              </div>
              <input
                id="build-search-input"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by project name, idea, or build ID..."
                aria-label="Search builds by project name or status"
                className="w-full pl-9 pr-9 py-2 text-xs font-mono bg-neutral-950 border border-neutral-800 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-amber-500/70 focus:ring-1 focus:ring-amber-500/30 transition-all"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search query"
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-neutral-400 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Status Dropdown Filter for quick selection or mobile */}
            <div className="flex items-center gap-2">
              <label htmlFor="build-status-select" className="text-xs text-neutral-400 font-mono flex items-center gap-1 shrink-0">
                <Filter className="w-3.5 h-3.5 text-amber-400" />
                <span className="hidden sm:inline">Status:</span>
              </label>
              <select
                id="build-status-select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as BuildStatusFilter)}
                aria-label="Filter builds by status"
                className="px-3 py-2 text-xs font-mono bg-neutral-950 border border-neutral-800 rounded-lg text-neutral-200 focus:outline-none focus:border-amber-500/70 focus:ring-1 focus:ring-amber-500/30 cursor-pointer"
              >
                <option value="all">All Statuses ({counts.all})</option>
                <option value="completed">Completed ({counts.completed})</option>
                <option value="running">Running / Active ({counts.running})</option>
                <option value="failed">Failed ({counts.failed})</option>
                <option value="stopped">Stopped / Cancelled ({counts.stopped})</option>
              </select>
            </div>
          </div>

          {/* Quick Filter Pill Buttons */}
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-neutral-800/60 text-xs">
            <span className="text-[11px] font-mono text-neutral-500 mr-1">Quick Filter:</span>
            
            <button
              type="button"
              onClick={() => setStatusFilter('all')}
              className={`px-2.5 py-1 rounded-md font-mono text-xs transition-colors flex items-center gap-1.5 ${
                statusFilter === 'all'
                  ? 'bg-neutral-800 text-white font-medium border border-neutral-700'
                  : 'bg-neutral-950/60 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/50 border border-neutral-800/60'
              }`}
            >
              <span>All</span>
              <span className="text-[10px] opacity-70">({counts.all})</span>
            </button>

            <button
              type="button"
              onClick={() => setStatusFilter('completed')}
              className={`px-2.5 py-1 rounded-md font-mono text-xs transition-colors flex items-center gap-1.5 ${
                statusFilter === 'completed'
                  ? 'bg-emerald-500/15 text-emerald-300 font-medium border border-emerald-500/30'
                  : 'bg-neutral-950/60 text-neutral-400 hover:text-emerald-300 hover:bg-neutral-800/50 border border-neutral-800/60'
              }`}
            >
              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
              <span>Completed</span>
              <span className="text-[10px] opacity-70">({counts.completed})</span>
            </button>

            <button
              type="button"
              onClick={() => setStatusFilter('running')}
              className={`px-2.5 py-1 rounded-md font-mono text-xs transition-colors flex items-center gap-1.5 ${
                statusFilter === 'running'
                  ? 'bg-amber-500/15 text-amber-300 font-medium border border-amber-500/30'
                  : 'bg-neutral-950/60 text-neutral-400 hover:text-amber-300 hover:bg-neutral-800/50 border border-neutral-800/60'
              }`}
            >
              <PlayCircle className="w-3 h-3 text-amber-400" />
              <span>Running</span>
              <span className="text-[10px] opacity-70">({counts.running})</span>
            </button>

            <button
              type="button"
              onClick={() => setStatusFilter('failed')}
              className={`px-2.5 py-1 rounded-md font-mono text-xs transition-colors flex items-center gap-1.5 ${
                statusFilter === 'failed'
                  ? 'bg-rose-500/15 text-rose-300 font-medium border border-rose-500/30'
                  : 'bg-neutral-950/60 text-neutral-400 hover:text-rose-300 hover:bg-neutral-800/50 border border-neutral-800/60'
              }`}
            >
              <AlertTriangle className="w-3 h-3 text-rose-400" />
              <span>Failed</span>
              <span className="text-[10px] opacity-70">({counts.failed})</span>
            </button>

            <button
              type="button"
              onClick={() => setStatusFilter('stopped')}
              className={`px-2.5 py-1 rounded-md font-mono text-xs transition-colors flex items-center gap-1.5 ${
                statusFilter === 'stopped'
                  ? 'bg-neutral-800 text-neutral-200 font-medium border border-neutral-600'
                  : 'bg-neutral-950/60 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/50 border border-neutral-800/60'
              }`}
            >
              <StopCircle className="w-3 h-3 text-neutral-400" />
              <span>Stopped</span>
              <span className="text-[10px] opacity-70">({counts.stopped})</span>
            </button>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="ml-auto text-xs text-amber-400 hover:text-amber-300 hover:underline flex items-center gap-1"
              >
                <X className="w-3 h-3" />
                <span>Reset Filters</span>
              </button>
            )}
          </div>
        </div>

      {/* Filter Stats Bar */}
      {builds.length > 0 && hasActiveFilters && (
        <div className="flex items-center justify-between px-1 text-xs font-mono text-neutral-400">
          <div>
            Showing <span className="text-white font-semibold">{filteredBuilds.length}</span> of{' '}
            <span className="text-neutral-300">{builds.length}</span> builds
            {searchQuery && (
              <span>
                {' '}matching "<span className="text-amber-300">{searchQuery}</span>"
              </span>
            )}
            {statusFilter !== 'all' && (
              <span>
                {' '}with status <span className="text-amber-300 capitalize">{statusFilter}</span>
              </span>
            )}
          </div>
          <button
            onClick={resetFilters}
            className="text-xs text-neutral-400 hover:text-white underline cursor-pointer"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Builds List or Empty States */}
      {loading ? (
        <div className="p-12 text-center text-xs text-neutral-500 font-mono">
          Loading past builds...
        </div>
      ) : builds.length === 0 ? (
        <div className="p-12 bg-neutral-900 border border-neutral-800 rounded-xl text-center space-y-2">
          <p className="text-sm text-neutral-300">No past swarm builds recorded yet.</p>
          <p className="text-xs text-neutral-500">
            Launch your first build in the Idea Forge tab to see it archived here.
          </p>
        </div>
      ) : filteredBuilds.length === 0 ? (
        <div className="p-12 bg-neutral-900/60 border border-dashed border-neutral-800 rounded-xl text-center space-y-3">
          <div className="w-10 h-10 rounded-full bg-neutral-800/80 mx-auto flex items-center justify-center text-neutral-400">
            <Search className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-neutral-200">No matching builds found</p>
            <p className="text-xs text-neutral-500 max-w-md mx-auto">
              No builds matched your search for "{searchQuery}" and status filter "{statusFilter}".
            </p>
          </div>
          <button
            onClick={resetFilters}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-400 bg-amber-400/10 hover:bg-amber-400/20 border border-amber-400/30 rounded-lg transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Search & Filters</span>
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredBuilds.map((build) => {
            const dateStr = new Date(build.createdAt).toLocaleString();
            const durationSec = build.completedAt 
              ? Math.round((build.completedAt - build.createdAt) / 1000)
              : Math.round((Date.now() - build.createdAt) / 1000);

            const badgeStyle = getStatusBadgeStyle(build.status);

            return (
              <div
                key={build.id}
                className="p-5 bg-neutral-900 border border-neutral-800 rounded-xl hover:border-neutral-700 transition-colors space-y-3 shadow-md"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border uppercase ${badgeStyle}`}>
                      {build.status}
                    </span>
                    <span className="text-xs font-mono text-neutral-400">{dateStr}</span>
                    <span className="text-neutral-600">·</span>
                    <span className="text-xs font-mono text-neutral-400">{durationSec}s run</span>
                    <span className="text-neutral-600">·</span>
                    <span className="text-[10px] font-mono text-neutral-500" title={`Build ID: ${build.id}`}>
                      #{build.id.slice(0, 8)}
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-neutral-400">
                      Cost: ${(build.totalCost || 0).toFixed(4)}
                    </span>
                    <button
                      onClick={() => onSelectBuild(build.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-neutral-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors cursor-pointer"
                    >
                      <span>Load Workspace</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="text-sm font-semibold text-white">
                  "{build.idea}"
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-neutral-800/80 text-xs font-mono text-neutral-400">
                  <div className="flex items-center gap-2">
                    <span>{build.selectedModels?.length || 10} Models</span>
                    <span>·</span>
                    <span>{build.patchesAppliedCount || 0} Patches</span>
                  </div>

                  {build.githubRepoUrl && (
                    <a
                      href={build.githubRepoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-400 hover:text-emerald-300 flex items-center gap-1.5"
                    >
                      <Github className="w-3.5 h-3.5" />
                      <span>{build.githubRepoUrl.split('/').slice(-2).join('/')}</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
