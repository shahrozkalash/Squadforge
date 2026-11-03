import { db, computeContentHash } from '../store.js';
import { ProjectMemoryService } from './projectMemory.js';
import { 
  ProjectFile, 
  Task, 
  AgentRole,
  CodeReview,
  PatchProposal,
  CollaborativeDefect,
  SharedKnowledgeItem 
} from '../types.js';

export interface VersionAwareFileContext {
  path: string;
  currentVersion: number;
  contentHash: string;
  isDeleted: boolean;
  contentPreview: string;
  leaseOwner: string | null;
  historyLength: number;
}

export interface AgentWorkspaceContext {
  projectId: string;
  buildIdea: string;
  projectType: string;
  targetPlatforms: string[];
  currentTask: {
    id: string;
    title: string;
    description: string;
    assignedRole?: AgentRole;
    filePaths: string[];
    priority: number;
    dependencies: string[];
  };
  targetFiles: VersionAwareFileContext[];
  relevantADRs: Array<{ id: string; title: string; decision: string; status: string }>;
  relatedDefects: Array<{ id: string; title: string; severity: string; status: string; affectedFiles: string[] }>;
  pendingReviews: Array<{ id: string; taskTitle?: string; verdict: string; status: string; changedFiles: string[] }>;
  activePatches: Array<{ id: string; targetFile: string; applicationStatus: string; reviewStatus: string }>;
  knowledgeItems: Array<{ id: string; category: string; title: string; content: string }>;
  versionIntegrity: {
    allFilesCurrent: boolean;
    staleFilesDetected: string[];
  };
}

export class SharedWorkspaceService {
  /**
   * Retrieves bounded, version-aware project context tailored specifically to the requesting agent and task.
   * Never leaks complete unbounded history or another tenant's files.
   */
  static getAgentWorkspaceContext(
    buildId: string, 
    userId: string, 
    taskId: string, 
    agentRole: AgentRole,
    assumedBaseVersions?: Record<string, number>
  ): { success: boolean; context?: AgentWorkspaceContext; error?: string } {
    const build = db.getBuild(buildId);
    if (!build) {
      return { success: false, error: 'Build not found' };
    }
    // Strict multi-tenant isolation guard
    if (build.userId !== userId) {
      return { success: false, error: 'Forbidden: Access denied to private project workspace' };
    }

    const task = db.getTask(buildId, taskId);
    if (!task) {
      return { success: false, error: `Task ${taskId} not found in workspace` };
    }

    // 1. Gather target file contexts with hashes and versions
    const allFiles = db.getAllFiles(buildId);
    const targetFiles: VersionAwareFileContext[] = [];
    const staleFilesDetected: string[] = [];

    for (const fp of task.filePaths) {
      const file = allFiles.find(f => f.path.toLowerCase() === fp.toLowerCase());
      if (file) {
        const hash = file.contentHash || computeContentHash(file.content);
        targetFiles.push({
          path: file.path,
          currentVersion: file.version,
          contentHash: hash,
          isDeleted: Boolean(file.isDeleted),
          contentPreview: file.content ? file.content.slice(0, 1500) : '',
          leaseOwner: file.leaseOwner || null,
          historyLength: file.history ? file.history.length : 0
        });

        // Check if agent's assumed base version is stale
        if (assumedBaseVersions && assumedBaseVersions[file.path] !== undefined) {
          if (assumedBaseVersions[file.path] !== file.version) {
            staleFilesDetected.push(file.path);
          }
        }
      } else {
        // File to be created
        targetFiles.push({
          path: fp,
          currentVersion: 0,
          contentHash: computeContentHash(''),
          isDeleted: false,
          contentPreview: '(File does not yet exist - scheduled for creation)',
          leaseOwner: null,
          historyLength: 0
        });
      }
    }

    // 2. Retrieve relevant ADRs from project memory
    const memory = ProjectMemoryService.getOrInitializeMemory(buildId, userId);
    const relevantADRs = (memory?.architectureDecisions || []).slice(0, 5).map(a => ({
      id: a.id,
      title: a.title,
      decision: a.decision,
      status: a.status
    }));

    // 3. Retrieve relevant defects targeting these files
    const allDefects = db.getDefects(buildId);
    const relatedDefects = allDefects
      .filter(d => d.status !== 'resolved' && d.affectedFiles.some(af => task.filePaths.includes(af)))
      .slice(0, 5)
      .map(d => ({
        id: d.id,
        title: d.title,
        severity: d.severity,
        status: d.status,
        affectedFiles: d.affectedFiles
      }));

    // 4. Retrieve pending reviews on this task or files
    const { reviews } = db.getCodeReviews(buildId, { taskId });
    const pendingReviews = reviews.map(r => ({
      id: r.id,
      verdict: r.verdict,
      status: r.status,
      changedFiles: r.changedFiles
    }));

    // 5. Retrieve proposed patches for target files
    const allPatches = db.getPatchProposals(buildId);
    const activePatches = allPatches
      .filter(p => task.filePaths.includes(p.targetFile))
      .slice(0, 5)
      .map(p => ({
        id: p.id,
        targetFile: p.targetFile,
        applicationStatus: p.applicationStatus,
        reviewStatus: p.reviewStatus
      }));

    // 6. Relevant shared knowledge
    const knowledgeItems = db.getKnowledgeItems(buildId, { status: 'active' })
      .filter(k => k.relevantFiles.length === 0 || k.relevantFiles.some(rf => task.filePaths.includes(rf)))
      .slice(0, 6)
      .map(k => ({
        id: k.id,
        category: k.category,
        title: k.title,
        content: k.content.slice(0, 300)
      }));

    const context: AgentWorkspaceContext = {
      projectId: buildId,
      buildIdea: build.idea,
      projectType: build.projectType || 'fullstack',
      targetPlatforms: memory?.targetPlatforms || ['web'],
      currentTask: {
        id: task.id,
        title: task.title,
        description: task.description,
        assignedRole: task.assignedRole,
        filePaths: task.filePaths,
        priority: task.priority,
        dependencies: task.dependencies || []
      },
      targetFiles,
      relevantADRs,
      relatedDefects,
      pendingReviews,
      activePatches,
      knowledgeItems,
      versionIntegrity: {
        allFilesCurrent: staleFilesDetected.length === 0,
        staleFilesDetected
      }
    };

    return { success: true, context };
  }

  /**
   * Verifies that a base version of a file is still current before patch or review application
   */
  static verifyFileVersionCurrent(buildId: string, filePath: string, expectedVersion: number): {
    current: boolean;
    actualVersion: number;
    currentHash: string;
  } {
    const file = db.getFile(buildId, filePath);
    if (!file) {
      return {
        current: expectedVersion === 0,
        actualVersion: 0,
        currentHash: computeContentHash('')
      };
    }

    const currentHash = file.contentHash || computeContentHash(file.content);
    return {
      current: file.version === expectedVersion,
      actualVersion: file.version,
      currentHash
    };
  }
}
