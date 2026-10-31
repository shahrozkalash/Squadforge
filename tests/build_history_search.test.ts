import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { 
  filterBuilds, 
  matchesStatus, 
  matchesSearchQuery, 
  getStatusCounts 
} from '../src/utils/buildFilter.js';
import { Build } from '../src/types/index.js';

describe('BuildHistoryView Search and Status Filtering', () => {
  const sampleBuilds: Build[] = [
    {
      id: 'build-101',
      userId: 'user-a',
      idea: 'Real-time Collaborative Whiteboard with CRDTs',
      status: 'completed',
      createdAt: 1700000000000,
      updatedAt: 1700000100000,
      completedAt: 1700000100000,
      selectedModels: ['gemini-2.5-pro'],
      autoPushGithub: true,
      githubRepoUrl: 'https://github.com/acme/whiteboard-app',
      totalTokens: 15000,
      totalCost: 0.045,
      costLimit: 5,
      maxDurationSeconds: 300,
      patchesAppliedCount: 12
    },
    {
      id: 'build-102',
      userId: 'user-a',
      idea: 'E-commerce microservice with Stripe checkout and cart',
      status: 'running',
      createdAt: 1700000200000,
      updatedAt: 1700000250000,
      selectedModels: ['claude-3-5-sonnet'],
      autoPushGithub: false,
      totalTokens: 8000,
      totalCost: 0.024,
      costLimit: 5,
      maxDurationSeconds: 300,
      patchesAppliedCount: 4
    },
    {
      id: 'build-103',
      userId: 'user-b',
      idea: 'AI Meeting Summarizer and Action Item Extractor',
      status: 'failed',
      createdAt: 1700000300000,
      updatedAt: 1700000350000,
      selectedModels: ['gpt-4o'],
      autoPushGithub: false,
      totalTokens: 5000,
      totalCost: 0.015,
      costLimit: 5,
      maxDurationSeconds: 300,
      patchesAppliedCount: 2,
      error: 'Sandbox compilation timeout'
    },
    {
      id: 'build-104',
      userId: 'user-a',
      idea: 'Cryptocurrency portfolio tracker with live WebSockets',
      status: 'stopped',
      createdAt: 1700000400000,
      updatedAt: 1700000420000,
      selectedModels: ['gemini-2.5-flash'],
      autoPushGithub: false,
      totalTokens: 3000,
      totalCost: 0.009,
      costLimit: 5,
      maxDurationSeconds: 300,
      patchesAppliedCount: 1
    },
    {
      id: 'build-105',
      userId: 'user-a',
      idea: 'PostgreSQL Migration tool and schema visualizer',
      status: 'planning',
      createdAt: 1700000500000,
      updatedAt: 1700000510000,
      selectedModels: ['deepseek-r1'],
      autoPushGithub: false,
      totalTokens: 1200,
      totalCost: 0.003,
      costLimit: 5,
      maxDurationSeconds: 300,
      patchesAppliedCount: 0
    },
    {
      id: 'build-106',
      userId: 'user-a',
      idea: 'Static Landing Page for SaaS Marketing',
      status: 'cancelled',
      createdAt: 1700000600000,
      updatedAt: 1700000620000,
      selectedModels: ['gemini-2.5-flash'],
      autoPushGithub: false,
      totalTokens: 1000,
      totalCost: 0.002,
      costLimit: 5,
      maxDurationSeconds: 300,
      patchesAppliedCount: 0
    }
  ];

  test('Returns all builds when no criteria are provided or empty', () => {
    const results = filterBuilds(sampleBuilds, {});
    assert.equal(results.length, 6);

    const emptySearch = filterBuilds(sampleBuilds, { searchQuery: '   ', statusFilter: 'all' });
    assert.equal(emptySearch.length, 6);
  });

  test('Filters builds by project name / idea (case-insensitive)', () => {
    const whiteboardMatch = filterBuilds(sampleBuilds, { searchQuery: 'whiteboard' });
    assert.equal(whiteboardMatch.length, 1);
    assert.equal(whiteboardMatch[0].id, 'build-101');

    const upperCaseSearch = filterBuilds(sampleBuilds, { searchQuery: 'CRDT' });
    assert.equal(upperCaseSearch.length, 1);
    assert.equal(upperCaseSearch[0].id, 'build-101');

    const multiMatch = filterBuilds(sampleBuilds, { searchQuery: 'tool' });
    assert.equal(multiMatch.length, 1);
    assert.equal(multiMatch[0].id, 'build-105');
  });

  test('Filters builds by build ID', () => {
    const idMatch = filterBuilds(sampleBuilds, { searchQuery: 'build-103' });
    assert.equal(idMatch.length, 1);
    assert.equal(idMatch[0].id, 'build-103');
    assert.equal(idMatch[0].status, 'failed');
  });

  test('Filters builds by GitHub repository URL', () => {
    const repoMatch = filterBuilds(sampleBuilds, { searchQuery: 'whiteboard-app' });
    assert.equal(repoMatch.length, 1);
    assert.equal(repoMatch[0].id, 'build-101');
  });

  test('Filters builds by status group: completed', () => {
    const completed = filterBuilds(sampleBuilds, { statusFilter: 'completed' });
    assert.equal(completed.length, 1);
    assert.equal(completed[0].id, 'build-101');
  });

  test('Filters builds by status group: running (includes running and planning)', () => {
    const active = filterBuilds(sampleBuilds, { statusFilter: 'running' });
    assert.equal(active.length, 2);
    const activeIds = active.map(b => b.id);
    assert.ok(activeIds.includes('build-102'));
    assert.ok(activeIds.includes('build-105'));
  });

  test('Filters builds by status group: failed', () => {
    const failed = filterBuilds(sampleBuilds, { statusFilter: 'failed' });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].id, 'build-103');
  });

  test('Filters builds by status group: stopped (includes stopped and cancelled)', () => {
    const stopped = filterBuilds(sampleBuilds, { statusFilter: 'stopped' });
    assert.equal(stopped.length, 2);
    const stoppedIds = stopped.map(b => b.id);
    assert.ok(stoppedIds.includes('build-104'));
    assert.ok(stoppedIds.includes('build-106'));
  });

  test('Combines search query and status filter correctly', () => {
    // Both match whiteboard and completed
    const match = filterBuilds(sampleBuilds, { 
      searchQuery: 'whiteboard', 
      statusFilter: 'completed' 
    });
    assert.equal(match.length, 1);
    assert.equal(match[0].id, 'build-101');

    // Matches whiteboard idea but status does not match
    const noMatch = filterBuilds(sampleBuilds, { 
      searchQuery: 'whiteboard', 
      statusFilter: 'failed' 
    });
    assert.equal(noMatch.length, 0);

    // Matches 'e' in multiple ideas, but status is 'running'
    const runningWithE = filterBuilds(sampleBuilds, {
      searchQuery: 'commerce',
      statusFilter: 'running'
    });
    assert.equal(runningWithE.length, 1);
    assert.equal(runningWithE[0].id, 'build-102');
  });

  test('Calculates status counts accurately', () => {
    const counts = getStatusCounts(sampleBuilds);
    assert.equal(counts.all, 6);
    assert.equal(counts.completed, 1);
    assert.equal(counts.running, 2);
    assert.equal(counts.failed, 1);
    assert.equal(counts.stopped, 2);
  });

  test('Returns empty array when query does not match any project', () => {
    const results = filterBuilds(sampleBuilds, { searchQuery: 'non-existent-xyz-project' });
    assert.equal(results.length, 0);
  });
});
