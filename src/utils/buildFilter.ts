import { Build, BuildStatus } from '../types/index.js';

export type BuildStatusFilter = 
  | 'all' 
  | 'completed' 
  | 'running' 
  | 'failed' 
  | 'stopped';

export interface BuildFilterOptions {
  searchQuery?: string;
  statusFilter?: BuildStatusFilter | BuildStatus;
}

/**
 * Checks whether a build status satisfies the selected status filter.
 * Supports grouped status aliases:
 * - 'running': covers 'running', 'in_progress', 'planning', 'verifying', 'pending'
 * - 'stopped': covers 'stopped', 'cancelled'
 * - 'completed': covers 'completed'
 * - 'failed': covers 'failed'
 */
export function matchesStatus(status: BuildStatus, filter?: BuildStatusFilter | BuildStatus): boolean {
  if (!filter || filter === 'all') return true;
  if (filter === status) return true;
  
  if (filter === 'running') {
    return ['running', 'in_progress', 'planning', 'verifying', 'pending'].includes(status);
  }
  if (filter === 'stopped') {
    return ['stopped', 'cancelled'].includes(status);
  }
  if (filter === 'failed') {
    return status === 'failed';
  }
  if (filter === 'completed') {
    return status === 'completed';
  }

  return false;
}

/**
 * Checks whether a build matches the text search query against its
 * project name/idea, ID, or connected GitHub repository.
 */
export function matchesSearchQuery(build: Build, query?: string): boolean {
  if (!query || !query.trim()) return true;
  const q = query.trim().toLowerCase();
  
  // Search in idea (project name/description)
  if (build.idea && build.idea.toLowerCase().includes(q)) {
    return true;
  }
  
  // Search in build ID
  if (build.id && build.id.toLowerCase().includes(q)) {
    return true;
  }

  // Search in GitHub repository URL or branch
  if (build.githubRepoUrl && build.githubRepoUrl.toLowerCase().includes(q)) {
    return true;
  }
  if (build.gitBranch && build.gitBranch.toLowerCase().includes(q)) {
    return true;
  }

  return false;
}

/**
 * Filters a list of builds by search query and status filter.
 */
export function filterBuilds(builds: Build[], options: BuildFilterOptions): Build[] {
  const { searchQuery, statusFilter = 'all' } = options;
  return builds.filter(build => {
    return matchesStatus(build.status, statusFilter) && matchesSearchQuery(build, searchQuery);
  });
}

/**
 * Computes build counts partitioned across standard status filter options.
 */
export function getStatusCounts(builds: Build[]): Record<BuildStatusFilter, number> {
  return {
    all: builds.length,
    completed: builds.filter(b => matchesStatus(b.status, 'completed')).length,
    running: builds.filter(b => matchesStatus(b.status, 'running')).length,
    failed: builds.filter(b => matchesStatus(b.status, 'failed')).length,
    stopped: builds.filter(b => matchesStatus(b.status, 'stopped')).length,
  };
}
