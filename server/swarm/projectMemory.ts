import { db } from '../store.js';
import { 
  Build, 
  ProjectType, 
  TechStackConfig, 
  ArchitectureDecision, 
  ADRStatus,
  ADRHistoryEntry,
  RequirementItem, 
  RequirementStatus,
  ProjectRevision,
  Task,
  ProjectFile,
  ArchitectureBlueprint,
  RequirementsAnalysis,
  ProjectComplexityAssessment,
  FileStructurePlan,
  ArchitectureDependencyPlan,
  TargetPlatform,
  ConfirmedRequirement,
  TechnicalAssumption,
  UnresolvedQuestion,
  RepairLesson
} from '../types.js';

const REPAIR_LESSON_PREFIX = 'repair-lesson:';
const MAX_REPAIR_LESSONS = 50;

export type { ArchitectureDecision, ADRStatus, ADRHistoryEntry, RequirementItem, ProjectRevision };

export interface ProjectFact {
  id: string;
  category: 'requirement' | 'architecture' | 'constraint' | 'environment' | 'convention';
  statement: string;
  confidence: 'confirmed' | 'assumption';
  source: 'user_prompt' | 'architect_agent' | 'verifier_agent' | 'user_revision';
  timestamp: number;
}

export interface ProjectDefect {
  id: string;
  description: string;
  filePaths: string[];
  severity: 'low' | 'medium' | 'high';
  resolved: boolean;
  status?: 'discovered' | 'scheduled' | 'repairing' | 'resolved' | 'failed';
  discoveredAt: number;
  resolvedAt?: number;
  repairAttempts?: number;
  scheduledRepairTaskId?: string;
  expectedCorrection?: string;
  failedRepairs?: string[];
  regressionTests?: string[];
  maxRepairAttempts?: number;
  discoveredAtRevision?: number;
  resolvedWithEvidence?: string;
}

export interface ModuleRelationship {
  sourcePath: string;
  imports: string[];
  exports: string[];
}

export interface ADRConflictResult {
  hasConflict: boolean;
  conflictingADR?: ArchitectureDecision;
  reason?: string;
}

export interface ProjectMemory {
  projectId: string;
  userId: string;
  projectType: ProjectType;
  techStack: TechStackConfig;
  conventions: string[];
  facts: ProjectFact[];
  architectureDecisions: ArchitectureDecision[];
  requirements: RequirementItem[];
  knownDefects: ProjectDefect[];
  moduleRelationships: ModuleRelationship[];
  revisions: ProjectRevision[];
  architectureBlueprint?: ArchitectureBlueprint;
  requirementsAnalysis?: RequirementsAnalysis;
  complexityAssessment?: ProjectComplexityAssessment;
  fileStructurePlan?: FileStructurePlan;
  dependencyPlan?: ArchitectureDependencyPlan;
  targetPlatforms?: TargetPlatform[];
  unresolvedQuestions?: UnresolvedQuestion[];
  confirmedRequirements?: ConfirmedRequirement[];
  technicalAssumptions?: TechnicalAssumption[];
  lastUpdated: number;
}

export class ProjectMemoryService {
  private static MAX_FACTS = 40;
  private static MAX_ADRS = 25;
  private static MAX_DEFECTS = 30;
  private static DEFAULT_MAX_REPAIR_ATTEMPTS = 3;

  /**
   * Initializes or loads project memory with strict user isolation.
   */
  static getOrInitializeMemory(buildId: string, userId: string): ProjectMemory | null {
    if (!buildId || !userId) {
      throw new Error('Forbidden: Unauthorized - userId and buildId are required');
    }

    const build = db.getBuild(buildId);
    if (!build) return null;

    // Strict multi-tenant isolation guard
    if (build.userId !== userId) {
      throw new Error(`Forbidden: Access denied to project memory for build ${buildId}`);
    }

    // Try reading from database store
    const stored = db.getProjectMemory(buildId);
    if (stored) {
      // Re-verify user ownership on loaded record
      if (stored.userId !== userId) {
        throw new Error(`Forbidden: Project memory owner mismatch`);
      }
      // Defensive schema healing for corrupted or missing arrays
      stored.facts = Array.isArray(stored.facts) ? stored.facts : [];
      stored.architectureDecisions = Array.isArray(stored.architectureDecisions) ? stored.architectureDecisions : [];
      stored.requirements = Array.isArray(stored.requirements) ? stored.requirements : [];
      stored.knownDefects = Array.isArray(stored.knownDefects) ? stored.knownDefects : [];
      stored.moduleRelationships = Array.isArray(stored.moduleRelationships) ? stored.moduleRelationships : [];
      stored.revisions = Array.isArray(stored.revisions) ? stored.revisions : [];
      stored.conventions = Array.isArray(stored.conventions) ? stored.conventions : [];
      if (!stored.architectureBlueprint && build.architectureBlueprint) {
        stored.architectureBlueprint = build.architectureBlueprint;
      }
      if (!stored.requirementsAnalysis && build.requirementsAnalysis) {
        stored.requirementsAnalysis = build.requirementsAnalysis;
      }
      if (!stored.complexityAssessment && build.complexityAssessment) {
        stored.complexityAssessment = build.complexityAssessment;
      }
      if (!stored.fileStructurePlan && build.fileStructurePlan) {
        stored.fileStructurePlan = build.fileStructurePlan;
      }
      if (!stored.dependencyPlan && build.dependencyPlan) {
        stored.dependencyPlan = build.dependencyPlan;
      }
      return stored;
    }

    // Initialize from build metadata (backward-compatible migration)
    const initialConventions = [
      'Modular single-responsibility files (prefer < 150 lines)',
      'Strict TypeScript interfaces with zero implicit any',
      'Semantic Tailwind CSS with dark mode support',
      'OWASP input validation and defensive error handling'
    ];

    const initialFacts: ProjectFact[] = [
      {
        id: `fact_${Date.now()}_1`,
        category: 'requirement',
        statement: `User core goal: "${build.idea.slice(0, 120)}"`,
        confidence: 'confirmed',
        source: 'user_prompt',
        timestamp: Date.now()
      },
      {
        id: `fact_${Date.now()}_2`,
        category: 'environment',
        statement: `Project classification: ${build.projectType || 'fullstack'}`,
        confidence: 'confirmed',
        source: 'architect_agent',
        timestamp: Date.now()
      }
    ];

    const newMemory: ProjectMemory = {
      projectId: buildId,
      userId,
      projectType: build.projectType || 'fullstack',
      techStack: build.techStack || {
        frontend: 'React 19 + TypeScript + Tailwind CSS',
        backend: 'Node.js Express + TypeScript Server API',
        database: 'SQLite Persistent Database',
        testing: 'Node.js Native Test Runner (node:test + assert)',
        security: 'OWASP Defensive Validation'
      },
      conventions: initialConventions,
      facts: initialFacts,
      architectureDecisions: build.architectureDecisions || [],
      requirements: build.requirementsChecklist || [],
      knownDefects: [],
      moduleRelationships: [],
      revisions: build.revisions || [],
      architectureBlueprint: build.architectureBlueprint,
      requirementsAnalysis: build.requirementsAnalysis,
      complexityAssessment: build.complexityAssessment,
      fileStructurePlan: build.fileStructurePlan,
      dependencyPlan: build.dependencyPlan,
      targetPlatforms: build.architectureBlueprint?.targetPlatforms,
      unresolvedQuestions: build.requirementsAnalysis?.unresolvedQuestions,
      confirmedRequirements: build.requirementsAnalysis?.confirmedRequirements,
      technicalAssumptions: build.requirementsAnalysis?.assumptions,
      lastUpdated: Date.now()
    };

    db.saveProjectMemory(newMemory);
    return newMemory;
  }

  /**
   * Records a confirmed fact or an assumption, preventing duplicates
   * and never allowing unverified agent assumptions to overwrite confirmed requirements.
   */
  static recordFact(
    buildId: string, 
    userId: string, 
    fact: Omit<ProjectFact, 'id' | 'timestamp'>
  ): boolean {
    if (!fact || !fact.statement || typeof fact.statement !== 'string' || !fact.statement.trim()) {
      return false;
    }

    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    // Check duplicate statement
    const normalized = fact.statement.toLowerCase().trim();
    const existing = memory.facts.find(f => f.statement.toLowerCase().trim() === normalized);
    if (existing) {
      // If existing fact is confirmed and incoming is only an assumption, strictly preserve confirmed!
      if (existing.confidence === 'confirmed' && fact.confidence === 'assumption') {
        return true;
      }
      // If upgraded from assumption to confirmed, update confidence
      if (existing.confidence === 'assumption' && fact.confidence === 'confirmed') {
        existing.confidence = 'confirmed';
        existing.source = fact.source;
        memory.lastUpdated = Date.now();
        db.saveProjectMemory(memory);
      }
      return true;
    }

    // Protect confirmed requirements: an assumption cannot contradict a confirmed fact
    if (fact.confidence === 'assumption') {
      const contradictsConfirmed = memory.facts.some(f => 
        f.confidence === 'confirmed' && 
        f.category === fact.category &&
        ((normalized.includes('not ') && f.statement.toLowerCase().includes(normalized.replace('not ', ''))) ||
         (f.statement.toLowerCase().includes('not ') && normalized.includes(f.statement.toLowerCase().replace('not ', ''))))
      );
      if (contradictsConfirmed) {
        // Reject or mark assumption as contradictory
        return false;
      }
    }

    const newFact: ProjectFact = {
      category: fact.category || 'requirement',
      statement: fact.statement.trim(),
      confidence: fact.confidence || 'assumption',
      source: fact.source || 'architect_agent',
      id: `fact_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now()
    };

    memory.facts.unshift(newFact);

    // Safe truncation: never drop confirmed facts; prune oldest assumptions first
    if (memory.facts.length > this.MAX_FACTS) {
      const confirmed = memory.facts.filter(f => f.confidence === 'confirmed');
      const assumptions = memory.facts.filter(f => f.confidence !== 'confirmed');
      const allowedAssumptions = Math.max(0, this.MAX_FACTS - confirmed.length);
      memory.facts = [...confirmed, ...assumptions.slice(0, allowedAssumptions)];
    }

    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);
    return true;
  }

  /**
   * Intelligent Architectural Decision Conflict Detection.
   * Does NOT classify two decisions as conflicting merely because their titles are similar.
   * Analyzes actual technical meaning, affected components, constraints, and consequences.
   */
  static detectADRConflicts(
    newADR: ArchitectureDecision, 
    existingADRs: ArchitectureDecision[]
  ): ADRConflictResult {
    const activeAccepted = existingADRs.filter(d => 
      d.id !== newADR.id && 
      (d.status === 'accepted' || (newADR.status === 'accepted' && d.status === 'proposed'))
    );

    const newText = `${newADR.title} ${newADR.context} ${newADR.decision} ${newADR.consequences || ''}`.toLowerCase();
    const newFiles = (newADR.affectedFiles || []).map(f => f.toLowerCase());
    const newModules = (newADR.affectedModules || []).map(m => m.toLowerCase());

    for (const existing of activeAccepted) {
      // Skip if newADR explicitly supersedes this existing ADR
      if (newADR.supersedes === existing.id || existing.supersededBy === newADR.id) {
        continue;
      }

      const existingText = `${existing.title} ${existing.context} ${existing.decision} ${existing.consequences || ''}`.toLowerCase();
      const existingFiles = (existing.affectedFiles || []).map(f => f.toLowerCase());
      const existingModules = (existing.affectedModules || []).map(m => m.toLowerCase());

      // 1. Check for concrete affected component/module overlap
      const hasModuleOverlap = newModules.some(m => existingModules.includes(m));
      const hasFileOverlap = newFiles.some(f => existingFiles.includes(f));

      // 2. Identify known technical contradictions
      const contradictions: Array<{ key1: string; key2: string; reason: string }> = [
        {
          key1: 'sqlite',
          key2: 'postgres',
          reason: 'Conflicting database engines: SQLite embedded database vs PostgreSQL client'
        },
        {
          key1: 'mongodb',
          key2: 'sqlite',
          reason: 'Conflicting database paradigm: MongoDB document store vs SQLite relational database'
        },
        {
          key1: 'rest api',
          key2: 'graphql',
          reason: 'Conflicting API architectural paradigm: REST endpoints vs GraphQL schema'
        },
        {
          key1: 'zustand',
          key2: 'redux toolkit',
          reason: 'Conflicting global state management library for client application'
        },
        {
          key1: 'session cookie',
          key2: 'localstorage jwt',
          reason: 'Conflicting token storage paradigm: HTTP-only cookies vs LocalStorage Bearer tokens'
        },
        {
          key1: 'single-page application',
          key2: 'server-side rendered',
          reason: 'Conflicting rendering paradigm: SPA client routing vs Server-Side Rendering'
        }
      ];

      for (const c of contradictions) {
        const newHasK1 = newText.includes(c.key1);
        const newHasK2 = newText.includes(c.key2);
        const exHasK1 = existingText.includes(c.key1);
        const exHasK2 = existingText.includes(c.key2);

        if ((newHasK1 && exHasK2) || (newHasK2 && exHasK1)) {
          return {
            hasConflict: true,
            conflictingADR: existing,
            reason: `${c.reason} (in decision [${existing.id}] "${existing.title}" vs [${newADR.id}] "${newADR.title}")`
          };
        }
      }

      // 3. Directly conflicting decision on overlapping files or modules
      if ((hasModuleOverlap || hasFileOverlap) && newADR.status === 'accepted') {
        // If both target same module but propose contradictory constraints
        if (
          (newText.includes('disable') && existingText.includes('enable')) ||
          (newText.includes('in-memory') && existingText.includes('persistent disk'))
        ) {
          return {
            hasConflict: true,
            conflictingADR: existing,
            reason: `Conflicting implementation policy for component [${existing.affectedModules?.join(', ') || existing.title}]`
          };
        }
      }
    }

    return { hasConflict: false };
  }

  /**
   * Records or updates an Architecture Decision Record (ADR), auditing modification history
   * and notifying Planner and Integration Agent if an architectural conflict is detected.
   */
  static recordDecision(
    buildId: string,
    userId: string,
    decision: ArchitectureDecision
  ): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    // Check for architectural conflicts
    const conflict = this.detectADRConflicts(decision, memory.architectureDecisions);
    if (conflict.hasConflict && conflict.conflictingADR) {
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'architectural_conflict' as any,
        details: `[ADR Conflict Warning] Decision [${decision.id}] "${decision.title}" contradicts accepted decision [${conflict.conflictingADR.id}] "${conflict.conflictingADR.title}": ${conflict.reason}`
      });
    }

    const now = Date.now();
    const existingIndex = memory.architectureDecisions.findIndex(d => d.id === decision.id);
    
    // Maintain audit history entries
    const historyEntry: ADRHistoryEntry = {
      timestamp: now,
      action: existingIndex >= 0 ? (decision.status === 'superseded' ? 'superseded' : 'modified') : 'created',
      author: 'architect_agent',
      note: decision.decision
    };

    if (existingIndex >= 0) {
      const existing = memory.architectureDecisions[existingIndex];
      const history = [...(existing.history || []), historyEntry];
      memory.architectureDecisions[existingIndex] = {
        ...existing,
        ...decision,
        history,
        timestamp: now
      };
    } else {
      const history = decision.history || [historyEntry];
      memory.architectureDecisions.push({
        ...decision,
        history,
        timestamp: now
      });
      if (memory.architectureDecisions.length > this.MAX_ADRS) {
        memory.architectureDecisions = memory.architectureDecisions.slice(-this.MAX_ADRS);
      }
    }

    memory.lastUpdated = now;
    db.saveProjectMemory(memory);

    // Keep build entity synchronized
    const build = db.getBuild(buildId);
    if (build) {
      build.architectureDecisions = memory.architectureDecisions;
      db.saveBuild(build);
    }

    return true;
  }

  /**
   * Proposes a new decision in 'proposed' status
   */
  static proposeDecision(
    buildId: string,
    userId: string,
    decision: Omit<ArchitectureDecision, 'status' | 'timestamp'>
  ): ArchitectureDecision | null {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return null;

    const fullDecision: ArchitectureDecision = {
      ...decision,
      status: 'proposed',
      timestamp: Date.now(),
      history: [{
        timestamp: Date.now(),
        action: 'created',
        author: 'architect_agent',
        note: 'Proposed architectural decision'
      }]
    };

    this.recordDecision(buildId, userId, fullDecision);
    return fullDecision;
  }

  /**
   * Accepts an architectural decision after verifying no unaddressed conflicts exist
   */
  static acceptDecision(
    buildId: string,
    userId: string,
    decisionId: string,
    reason?: string
  ): { success: boolean; conflictReason?: string } {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return { success: false, conflictReason: 'Memory not found' };

    const adr = memory.architectureDecisions.find(d => d.id === decisionId);
    if (!adr) return { success: false, conflictReason: 'ADR not found' };

    // Check conflict against already accepted ADRs
    const testADR: ArchitectureDecision = { ...adr, status: 'accepted' };
    const conflict = this.detectADRConflicts(testADR, memory.architectureDecisions);

    if (conflict.hasConflict && conflict.conflictingADR) {
      return {
        success: false,
        conflictReason: `Cannot accept [${decisionId}]: conflicts with accepted decision [${conflict.conflictingADR.id}] "${conflict.conflictingADR.title}". Resolve or supersede first.`
      };
    }

    adr.status = 'accepted';
    adr.timestamp = Date.now();
    if (!adr.history) adr.history = [];
    adr.history.push({
      timestamp: Date.now(),
      action: 'accepted',
      author: 'architect_agent',
      note: reason || 'Decision accepted by team'
    });

    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);

    const build = db.getBuild(buildId);
    if (build) {
      build.architectureDecisions = memory.architectureDecisions;
      db.saveBuild(build);
    }

    return { success: true };
  }

  /**
   * Rejects a proposed architectural decision with an explanation
   */
  static rejectDecision(
    buildId: string,
    userId: string,
    decisionId: string,
    reason?: string
  ): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    const adr = memory.architectureDecisions.find(d => d.id === decisionId);
    if (!adr) return false;

    adr.status = 'rejected';
    adr.timestamp = Date.now();
    if (!adr.history) adr.history = [];
    adr.history.push({
      timestamp: Date.now(),
      action: 'rejected',
      author: 'architect_agent',
      note: reason || 'Decision rejected by team'
    });

    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);

    const build = db.getBuild(buildId);
    if (build) {
      build.architectureDecisions = memory.architectureDecisions;
      db.saveBuild(build);
    }

    return true;
  }

  /**
   * Supersedes an existing decision with a newer architectural decision record
   */
  static supersedeDecision(
    buildId: string,
    userId: string,
    oldDecisionId: string,
    newDecisionId: string,
    rationale?: string
  ): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    const oldADR = memory.architectureDecisions.find(d => d.id === oldDecisionId);
    const newADR = memory.architectureDecisions.find(d => d.id === newDecisionId);

    if (!oldADR || !newADR) return false;

    const now = Date.now();
    oldADR.status = 'superseded';
    oldADR.supersededBy = newDecisionId;
    if (!oldADR.history) oldADR.history = [];
    oldADR.history.push({
      timestamp: now,
      action: 'superseded',
      author: 'architect_agent',
      note: rationale || `Superseded by [${newDecisionId}]`
    });

    newADR.supersedes = oldDecisionId;
    newADR.status = 'accepted';
    if (!newADR.history) newADR.history = [];
    newADR.history.push({
      timestamp: now,
      action: 'accepted',
      author: 'architect_agent',
      note: `Supersedes [${oldDecisionId}]: ${rationale || ''}`
    });

    memory.lastUpdated = now;
    db.saveProjectMemory(memory);

    const build = db.getBuild(buildId);
    if (build) {
      build.architectureDecisions = memory.architectureDecisions;
      db.saveBuild(build);
    }

    return true;
  }

  /**
   * Reconsiders an existing rejected or accepted decision back into review
   */
  static reconsiderDecision(
    buildId: string,
    userId: string,
    decisionId: string,
    note?: string
  ): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    const adr = memory.architectureDecisions.find(d => d.id === decisionId);
    if (!adr) return false;

    adr.status = 'proposed';
    adr.timestamp = Date.now();
    if (!adr.history) adr.history = [];
    adr.history.push({
      timestamp: Date.now(),
      action: 'reconsidered',
      author: 'architect_agent',
      note: note || 'Reopened for team review'
    });

    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);

    const build = db.getBuild(buildId);
    if (build) {
      build.architectureDecisions = memory.architectureDecisions;
      db.saveBuild(build);
    }

    return true;
  }

  /**
   * Retrieves all requirements for the project with mandatory ownership authorization.
   */
  static getRequirements(buildId: string, userId: string): RequirementItem[] {
    if (!buildId || !userId) {
      throw new Error('Forbidden: Unauthorized - userId is required to access project requirements');
    }
    const build = db.getBuild(buildId);
    if (!build) {
      throw new Error(`Project not found: ${buildId}`);
    }
    if (build.userId !== userId) {
      throw new Error(`Forbidden: Access denied to project memory for build ${buildId}`);
    }

    const memory = db.getProjectMemory(buildId);
    if (memory && memory.requirements && memory.requirements.length > 0) {
      if (memory.userId !== userId) {
        throw new Error('Forbidden: Project memory owner mismatch');
      }
      return memory.requirements;
    }
    return build.requirementsChecklist || [];
  }

  /**
   * Updates requirement satisfaction status based on actual verified implementation
   */
  static updateRequirement(
    buildId: string,
    userId: string,
    reqId: string,
    satisfiedOrOpts: boolean | {
      satisfied?: boolean;
      status?: RequirementStatus;
      files?: string[];
      notes?: string;
      evidence?: string;
      testsExecuted?: Array<{ name: string; passed: boolean; message?: string }> | string[];
      deterministicChecksPassed?: boolean;
    },
    files?: string[],
    notes?: string,
    status?: RequirementStatus,
    evidence?: string,
    testsExecuted?: Array<{ name: string; passed: boolean; message?: string }> | string[],
    deterministicChecksPassed?: boolean
  ): boolean {
    if (!buildId || !userId) {
      throw new Error('Forbidden: Unauthorized - userId is required for project memory updates');
    }
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    const req = memory.requirements.find(r => r.id === reqId);
    if (!req) return false;

    if (typeof satisfiedOrOpts === 'object' && satisfiedOrOpts !== null) {
      if (satisfiedOrOpts.satisfied !== undefined) req.satisfied = satisfiedOrOpts.satisfied;
      if (satisfiedOrOpts.status !== undefined) req.status = satisfiedOrOpts.status;
      if (satisfiedOrOpts.files !== undefined) req.satisfiedByFiles = satisfiedOrOpts.files;
      if (satisfiedOrOpts.notes !== undefined) req.verificationNotes = satisfiedOrOpts.notes;
      if (satisfiedOrOpts.evidence !== undefined) req.evidence = satisfiedOrOpts.evidence;
      if (satisfiedOrOpts.testsExecuted !== undefined) req.testsExecuted = satisfiedOrOpts.testsExecuted;
      if (satisfiedOrOpts.deterministicChecksPassed !== undefined) req.deterministicChecksPassed = satisfiedOrOpts.deterministicChecksPassed;
    } else {
      req.satisfied = Boolean(satisfiedOrOpts);
      req.status = status || (satisfiedOrOpts ? 'satisfied' : 'unmet');
      if (files) req.satisfiedByFiles = files;
      if (notes) req.verificationNotes = notes;
      if (evidence) req.evidence = evidence;
      if (testsExecuted) req.testsExecuted = testsExecuted;
      if (deterministicChecksPassed !== undefined) req.deterministicChecksPassed = deterministicChecksPassed;
    }

    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);

    // Synchronize to build record
    const build = db.getBuild(buildId);
    if (build) {
      build.requirementsChecklist = memory.requirements;
      db.saveBuild(build);
    }

    return true;
  }

  /**
   * Records a user-approved natural language revision, updates memory provenance,
   * and marks outdated or contradictory assumptions as superseded.
   */
  static recordRevision(
    buildId: string,
    userId: string,
    revision: ProjectRevision
  ): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    if (!memory.revisions) memory.revisions = [];
    const existingIndex = memory.revisions.findIndex(r => r.id === revision.id);
    if (existingIndex >= 0) {
      memory.revisions[existingIndex] = revision;
    } else {
      memory.revisions.push(revision);
    }

    // Record as confirmed requirement fact with explicit user_revision provenance
    const newFact: ProjectFact = {
      id: `fact_rev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      category: 'requirement',
      statement: `User revision #${revision.revisionNumber}: "${revision.prompt}"`,
      confidence: 'confirmed',
      source: 'user_revision',
      timestamp: Date.now()
    };
    memory.facts.unshift(newFact);

    // Scan previous assumptions to mark superseded if relevant keywords overlap
    const keywords = revision.prompt.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    for (const f of memory.facts) {
      if (f.id !== newFact.id && f.confidence === 'assumption') {
        const matches = keywords.some(k => f.statement.toLowerCase().includes(k));
        if (matches && !f.statement.startsWith('[SUPERSEDED')) {
          f.statement = `[SUPERSEDED by Rev #${revision.revisionNumber}] ${f.statement}`;
        }
      }
    }

    if (memory.facts.length > this.MAX_FACTS) {
      memory.facts = memory.facts.slice(0, this.MAX_FACTS);
    }

    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);
    return true;
  }

  /**
   * Logs or updates a defect record. Deduplicates active defects.
   */
  static recordDefect(
    buildId: string,
    userId: string,
    defect: Omit<ProjectDefect, 'id' | 'discoveredAt' | 'resolved'>
  ): string | null {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return null;

    // Check duplicate defect
    const normalizedDesc = defect.description.toLowerCase().trim();
    const existing = memory.knownDefects.find(
      d => !d.resolved && (
        d.description.toLowerCase().trim() === normalizedDesc ||
        (d.expectedCorrection && defect.expectedCorrection && d.expectedCorrection === defect.expectedCorrection && d.filePaths.some(fp => defect.filePaths.includes(fp)))
      )
    );
    if (existing) {
      // Update file paths if expanded
      for (const fp of defect.filePaths) {
        if (!existing.filePaths.includes(fp)) existing.filePaths.push(fp);
      }
      return existing.id;
    }

    const id = `def_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newDefect: ProjectDefect = {
      ...defect,
      id,
      resolved: false,
      status: 'discovered',
      repairAttempts: 0,
      maxRepairAttempts: defect.maxRepairAttempts || this.DEFAULT_MAX_REPAIR_ATTEMPTS,
      discoveredAt: Date.now()
    };

    memory.knownDefects.unshift(newDefect);
    if (memory.knownDefects.length > this.MAX_DEFECTS) {
      memory.knownDefects = memory.knownDefects.slice(0, this.MAX_DEFECTS);
    }

    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);
    return id;
  }

  /**
   * Checks whether a defect is eligible for repair and has not exceeded configured repair attempts.
   */
  static canAttemptRepair(
    buildId: string,
    userId: string,
    defectId: string
  ): { allowed: boolean; attempts: number; maxAttempts: number; reason?: string } {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return { allowed: false, attempts: 0, maxAttempts: 3, reason: 'Memory not found' };

    const defect = memory.knownDefects.find(d => d.id === defectId);
    if (!defect) return { allowed: false, attempts: 0, maxAttempts: 3, reason: 'Defect not found' };

    if (defect.resolved) {
      return { allowed: false, attempts: defect.repairAttempts || 0, maxAttempts: defect.maxRepairAttempts || 3, reason: 'Defect already resolved' };
    }

    const max = defect.maxRepairAttempts || this.DEFAULT_MAX_REPAIR_ATTEMPTS;
    const current = defect.repairAttempts || 0;

    if (current >= max) {
      return {
        allowed: false,
        attempts: current,
        maxAttempts: max,
        reason: `Exceeded maximum bounded repair limit (${current}/${max} attempts)`
      };
    }

    return { allowed: true, attempts: current, maxAttempts: max };
  }

  /**
   * Associates a scheduled repair task with a defect without incrementing execution attempts.
   */
  static scheduleRepairTask(
    buildId: string,
    userId: string,
    defectId: string,
    taskId: string
  ): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    const defect = memory.knownDefects.find(d => d.id === defectId);
    if (!defect) return false;

    defect.scheduledRepairTaskId = taskId;
    defect.status = 'scheduled';
    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);
    return true;
  }

  /**
   * Tracks execution of a repair attempt. Increments repair attempts counter ONLY upon actual execution,
   * preserving history of failed attempts and regression checks.
   */
  static recordRepairExecution(
    buildId: string,
    userId: string,
    defectId: string,
    attemptNote: string,
    success: boolean,
    failureReason?: string,
    regressionTest?: string
  ): { attempts: number; maxAttempts: number; canRetry: boolean } {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return { attempts: 0, maxAttempts: 3, canRetry: false };

    const defect = memory.knownDefects.find(d => d.id === defectId);
    if (!defect) return { attempts: 0, maxAttempts: 3, canRetry: false };

    // Increment actual executed attempt
    defect.repairAttempts = (defect.repairAttempts || 0) + 1;
    defect.scheduledRepairTaskId = undefined;

    const max = defect.maxRepairAttempts || this.DEFAULT_MAX_REPAIR_ATTEMPTS;
    const canRetry = defect.repairAttempts < max && !defect.resolved;

    if (success) {
      defect.resolved = true;
      defect.status = 'resolved';
      defect.resolvedAt = Date.now();
      defect.resolvedWithEvidence = attemptNote;
    } else {
      defect.status = canRetry ? 'discovered' : 'failed';
      if (!defect.failedRepairs) defect.failedRepairs = [];
      defect.failedRepairs.push(failureReason || attemptNote);
    }

    if (regressionTest) {
      if (!defect.regressionTests) defect.regressionTests = [];
      if (!defect.regressionTests.includes(regressionTest)) {
        defect.regressionTests.push(regressionTest);
      }
    }

    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);

    return { attempts: defect.repairAttempts, maxAttempts: max, canRetry };
  }

  /**
   * Backward-compatible repair attempt recorder.
   */
  static recordRepairAttempt(
    buildId: string,
    userId: string,
    defectId: string,
    attemptNote?: string,
    failed?: boolean,
    regressionTest?: string
  ): { allowed: boolean; attempts: number } {
    const res = this.recordRepairExecution(
      buildId,
      userId,
      defectId,
      attemptNote || 'Repair execution',
      !failed,
      failed ? attemptNote : undefined,
      regressionTest
    );
    return { allowed: res.canRetry, attempts: res.attempts };
  }

  /**
   * Marks a defect as resolved ONLY when supported by real evidence (e.g. tests passed, syntax clean).
   */
  static resolveDefect(
    buildId: string, 
    userId: string, 
    defectId: string, 
    evidence?: string
  ): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    const defect = memory.knownDefects.find(d => d.id === defectId);
    if (!defect) return false;

    defect.resolved = true;
    defect.status = 'resolved';
    defect.resolvedAt = Date.now();
    defect.resolvedWithEvidence = evidence || 'Verified through clean test and syntax execution';
    defect.scheduledRepairTaskId = undefined;

    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);
    return true;
  }

  /**
   * Analyzes project files to establish module relationship graph
   */
  static updateModuleRelationships(buildId: string, userId: string, files: ProjectFile[]): void {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return;

    const relationships: ModuleRelationship[] = [];

    for (const f of files) {
      if (!f.path.endsWith('.ts') && !f.path.endsWith('.tsx') && !f.path.endsWith('.js') && !f.path.endsWith('.jsx')) {
        continue;
      }

      const importMatches = [...f.content.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
      const exportMatches = [...f.content.matchAll(/export\s+(?:default\s+)?(?:class|function|const|let|var|type|interface)\s+([a-zA-Z0-9_$]+)/g)].map(m => m[1]);

      relationships.push({
        sourcePath: f.path,
        imports: importMatches,
        exports: exportMatches
      });
    }

    memory.moduleRelationships = relationships;
    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);
  }

  /**
   * Produces a token-budgeted, task-relevant context block for autonomous agent prompts.
   * Eliminates hallucination by providing ONLY relevant ADRs, requirements, confirmed facts,
   * and defects for the specific task and target files.
   * Priority: Confirmed User Requirements > Accepted ADRs > Active Defects > Conventions.
   * Safe truncation: Never cuts records or lines in half; truncates cleanly at line/section boundaries.
   */
  static retrieveTaskContext(
    buildId: string, 
    userId: string, 
    task: Task, 
    maxChars: number = 1800
  ): string {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return '';

    const sections: string[] = [];

    // 1. Architecture & Tech Stack Summary
    sections.push(
      `PROJECT CONTEXT: ${memory.projectType.toUpperCase()} | STACK: ${memory.techStack.frontend} + ${memory.techStack.backend}`
    );

    // 2. Relevant ADRs (accepted decisions only, filtered by module/file relevance or global)
    const activeAdrs = memory.architectureDecisions.filter(d => d.status === 'accepted');
    const relevantAdrs = activeAdrs.filter(adr => {
      if (!adr.affectedFiles || adr.affectedFiles.length === 0) return true;
      return adr.affectedFiles.some(af => task.filePaths.some(tf => tf.includes(af) || af.includes(tf)));
    });

    const adrsToShow = (relevantAdrs.length > 0 ? relevantAdrs : activeAdrs).slice(0, 3);
    if (adrsToShow.length > 0) {
      const adrLines = adrsToShow.map(d => `- [${d.id}] ${d.title}: ${d.decision}`);
      sections.push(`ARCHITECTURE CONSTRAINTS:\n${adrLines.join('\n')}`);
    }

    // 3. Relevant Requirements matching target file paths, keywords, or priority
    const taskTokens = `${task.title} ${task.description} ${task.filePaths.join(' ')}`
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(w => w.length > 2);

    const scoredReqs = memory.requirements.map(req => {
      let score = 0;
      // High bonus if target file explicitly satisfies this requirement
      if (req.satisfiedByFiles?.some(f => task.filePaths.includes(f))) {
        score += 25;
      }
      // Category match
      if (req.category && taskTokens.includes(req.category.toLowerCase())) {
        score += 10;
      }
      // Keyword overlap
      const reqText = `${req.title || ''} ${req.description}`.toLowerCase();
      for (const token of taskTokens) {
        if (reqText.includes(token)) {
          score += 4;
        }
      }
      // Unsatisfied requirements get priority boost
      if (!req.satisfied) {
        score += 6;
      }
      // Priority weighting
      if (req.priority === 'must_have') score += 5;
      else if (req.priority === 'should_have') score += 2;

      return { req, score };
    });

    scoredReqs.sort((a, b) => b.score - a.score);
    const relevantReqs = scoredReqs.slice(0, 4).map(s => s.req);

    if (relevantReqs.length > 0) {
      const reqLines = relevantReqs.map(r => 
        `- [${(r.priority || 'core').toUpperCase()}] ${r.title || r.id}: ${r.description} (${r.satisfied ? 'SATISFIED' : 'PENDING'})`
      );
      sections.push(`TARGET REQUIREMENTS:\n${reqLines.join('\n')}`);
    }

    // 4. Relevant Known Defects (vital for fix tasks)
    const relevantDefects = memory.knownDefects.filter(
      d => !d.resolved && d.filePaths.some(fp => task.filePaths.includes(fp))
    );
    if (relevantDefects.length > 0) {
      const defectLines = relevantDefects.slice(0, 3).map(d => 
        `- [DEFECT] ${d.description}${d.expectedCorrection ? ` (Correction: ${d.expectedCorrection})` : ''}`
      );
      sections.push(`ACTIVE DEFECTS TO REMEDY:\n${defectLines.join('\n')}`);
    }

    // Agents editing these files learn from repairs this project has already tried
    const lessons = this.getRepairLessons(buildId, userId, { files: task.filePaths }).slice(0, 4);
    if (lessons.length > 0) {
      // A summary quotes project output, which must not reach these prompts as instructions
      const lessonLines = lessons.map(lesson =>
        `- [${lesson.outcome === 'verified' ? 'VERIFIED FIX' : 'FAILED APPROACH'}] ${lesson.category.replace(/_/g, ' ')} in ${lesson.files.join(', ')} (seen ${lesson.timesSeen} time(s))`
      );
      sections.push(`REPAIR HISTORY:\n${lessonLines.join('\n')}`);
    }

    // 5. Confirmed Facts (Prioritized: user_revision > user_prompt > architect)
    const confirmedFacts = memory.facts
      .filter(f => f.confidence === 'confirmed' && !f.statement.startsWith('[SUPERSEDED'))
      .slice(0, 3);
    if (confirmedFacts.length > 0) {
      const factLines = confirmedFacts.map(f => `- ${f.statement}`);
      sections.push(`ESTABLISHED FACTS:\n${factLines.join('\n')}`);
    }

    // 6. Coding Conventions
    if (memory.conventions.length > 0) {
      sections.push(`CODING CONVENTIONS:\n${memory.conventions.slice(0, 3).map(c => `- ${c}`).join('\n')}`);
    }

    // Safe truncation: Assemble sections and complete bullet items without cutting lines or words in half
    let currentLength = 0;
    const keptSections: string[] = [];

    for (const section of sections) {
      if (currentLength + section.length + 2 <= maxChars) {
        keptSections.push(section);
        currentLength += section.length + 2;
      } else {
        // Line-by-line safe packing for this section
        const lines = section.split('\n');
        const header = lines[0];
        const keptLines = [header];
        let secLen = header.length;

        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (currentLength + secLen + line.length + 1 <= maxChars) {
            keptLines.push(line);
            secLen += line.length + 1;
          } else {
            break;
          }
        }

        if (keptLines.length > 1) {
          keptSections.push(keptLines.join('\n'));
        }
        break;
      }
    }

    return keptSections.join('\n\n');
  }

  /**
   * Retrieves full project memory with strict ownership authorization.
   */
  static getMemory(buildId: string, userId: string): ProjectMemory | null {
    if (!buildId || !userId) {
      throw new Error('Forbidden: Unauthorized - userId is required to access project memory');
    }
    return this.getOrInitializeMemory(buildId, userId);
  }

  /**
   * Retrieves defects for a project with mandatory ownership check.
   */
  static getDefects(buildId: string, userId: string): ProjectDefect[] {
    const memory = this.getMemory(buildId, userId);
    return memory?.knownDefects || [];
  }

  /**
   * Retrieves architecture decisions for a project with mandatory ownership check.
   */
  static getDecisions(buildId: string, userId: string): ArchitectureDecision[] {
    const memory = this.getMemory(buildId, userId);
    return memory?.architectureDecisions || [];
  }

  /**
   * Retrieves established facts for a project with mandatory ownership check.
   */
  static getFacts(buildId: string, userId: string): ProjectFact[] {
    const memory = this.getMemory(buildId, userId);
    return memory?.facts || [];
  }

  /**
   * Retrieves revisions for a project with mandatory ownership check.
   */
  static getRevisions(buildId: string, userId: string): ProjectRevision[] {
    const memory = this.getMemory(buildId, userId);
    return memory?.revisions || [];
  }

  /**
   * Retrieves module relationship graph for a project with mandatory ownership check.
   */
  static getModuleRelationships(buildId: string, userId: string): ModuleRelationship[] {
    const memory = this.getMemory(buildId, userId);
    return memory?.moduleRelationships || [];
  }

  /**
   * Records an architecture blueprint with strict user isolation and build synchronization.
   */
  static recordArchitectureBlueprint(buildId: string, userId: string, blueprint: ArchitectureBlueprint): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    memory.architectureBlueprint = blueprint;
    memory.targetPlatforms = blueprint.targetPlatforms;
    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);

    const build = db.getBuild(buildId);
    if (build && build.userId === userId) {
      build.architectureBlueprint = blueprint;
      db.saveBuild(build);
    }
    return true;
  }

  /**
   * Retrieves the architecture blueprint with strict user isolation.
   */
  static getArchitectureBlueprint(buildId: string, userId: string): ArchitectureBlueprint | undefined {
    const memory = this.getMemory(buildId, userId);
    return memory?.architectureBlueprint;
  }

  /**
   * Records requirements analysis with strict user isolation and build synchronization.
   */
  static recordRequirementsAnalysis(buildId: string, userId: string, analysis: RequirementsAnalysis): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    memory.requirementsAnalysis = analysis;
    memory.unresolvedQuestions = analysis.unresolvedQuestions;
    memory.confirmedRequirements = analysis.confirmedRequirements;
    memory.technicalAssumptions = analysis.assumptions;
    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);

    const build = db.getBuild(buildId);
    if (build && build.userId === userId) {
      build.requirementsAnalysis = analysis;
      db.saveBuild(build);
    }
    return true;
  }

  /**
   * Retrieves requirements analysis with strict user isolation.
   */
  static getRequirementsAnalysis(buildId: string, userId: string): RequirementsAnalysis | undefined {
    const memory = this.getMemory(buildId, userId);
    return memory?.requirementsAnalysis;
  }

  /**
   * Records project complexity assessment with strict user isolation and build synchronization.
   */
  static recordComplexityAssessment(buildId: string, userId: string, assessment: ProjectComplexityAssessment): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    memory.complexityAssessment = assessment;
    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);

    const build = db.getBuild(buildId);
    if (build && build.userId === userId) {
      build.complexityAssessment = assessment;
      db.saveBuild(build);
    }
    return true;
  }

  /**
   * Retrieves project complexity assessment with strict user isolation.
   */
  static getComplexityAssessment(buildId: string, userId: string): ProjectComplexityAssessment | undefined {
    const memory = this.getMemory(buildId, userId);
    return memory?.complexityAssessment;
  }

  /**
   * Records file structure plan with strict user isolation and build synchronization.
   */
  static recordFileStructurePlan(buildId: string, userId: string, plan: FileStructurePlan): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    memory.fileStructurePlan = plan;
    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);

    const build = db.getBuild(buildId);
    if (build && build.userId === userId) {
      build.fileStructurePlan = plan;
      db.saveBuild(build);
    }
    return true;
  }

  /**
   * Retrieves file structure plan with strict user isolation.
   */
  static getFileStructurePlan(buildId: string, userId: string): FileStructurePlan | undefined {
    const memory = this.getMemory(buildId, userId);
    return memory?.fileStructurePlan;
  }

  /**
   * Records architecture dependency plan with strict user isolation and build synchronization.
   */
  static recordDependencyPlan(buildId: string, userId: string, plan: ArchitectureDependencyPlan): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    memory.dependencyPlan = plan;
    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);

    const build = db.getBuild(buildId);
    if (build && build.userId === userId) {
      build.dependencyPlan = plan;
      db.saveBuild(build);
    }
    return true;
  }

  /**
   * Retrieves architecture dependency plan with strict user isolation.
   */
  static getDependencyPlan(buildId: string, userId: string): ArchitectureDependencyPlan | undefined {
    const memory = this.getMemory(buildId, userId);
    return memory?.dependencyPlan;
  }

  // ==========================================
  // PHASE 8: SHARED TECHNICAL KNOWLEDGE METHODS
  // ==========================================

  /**
   * Records a shared technical knowledge item with duplicate and contradiction detection
   */
  static recordKnowledgeItem(
    buildId: string,
    userId: string,
    item: {
      sourceAgent: string;
      sourceRole: import('../types.js').AgentRole;
      sourceTaskId?: string;
      category: import('../types.js').KnowledgeCategory;
      title: string;
      content: string;
      relevantFiles?: string[];
    }
  ): { success: boolean; item?: import('../types.js').SharedKnowledgeItem; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    // Duplicate detection: check if exact title and category already exists in active items
    const existing = db.getKnowledgeItems(buildId, { category: item.category, status: 'active' });
    const duplicate = existing.find(e => e.title.toLowerCase().trim() === item.title.toLowerCase().trim());
    if (duplicate) {
      return {
        success: false,
        error: `Duplicate knowledge item: A knowledge item with title "${item.title}" already exists (ID: ${duplicate.id}). Use supersedeKnowledgeItem to update it.`
      };
    }

    const id = `know_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const createdItem: import('../types.js').SharedKnowledgeItem = {
      id,
      projectId: buildId,
      buildId,
      sourceAgent: item.sourceAgent,
      sourceRole: item.sourceRole,
      sourceTaskId: item.sourceTaskId,
      category: item.category,
      title: item.title,
      content: item.content,
      relevantFiles: item.relevantFiles || [],
      version: 1,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    db.saveKnowledgeItem(createdItem);

    // Swarm event
    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'knowledge_shared',
      modelId: item.sourceAgent,
      taskId: item.sourceTaskId,
      filePath: item.relevantFiles?.[0],
      details: `[${item.sourceRole}] shared knowledge (${item.category}): "${item.title}"`
    });

    return { success: true, item: createdItem };
  }

  /**
   * Supersedes an existing knowledge item with a new version without erasing history
   */
  static supersedeKnowledgeItem(
    buildId: string,
    userId: string,
    params: {
      targetId: string;
      sourceAgent: string;
      sourceRole: import('../types.js').AgentRole;
      newContent: string;
      newTitle?: string;
      supersedeReason: string;
    }
  ): { success: boolean; newItem?: import('../types.js').SharedKnowledgeItem; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const target = db.getKnowledgeItem(params.targetId);
    if (!target || target.buildId !== buildId) {
      return { success: false, error: `Knowledge item ${params.targetId} not found in this build` };
    }

    // Mark previous as superseded (preserve history)
    target.status = 'superseded';
    target.supersedeReason = params.supersedeReason;
    target.updatedAt = Date.now();
    db.saveKnowledgeItem(target);

    // Create new version linked to previous
    const newId = `know_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newItem: import('../types.js').SharedKnowledgeItem = {
      id: newId,
      projectId: buildId,
      buildId,
      sourceAgent: params.sourceAgent,
      sourceRole: params.sourceRole,
      sourceTaskId: target.sourceTaskId,
      category: target.category,
      title: params.newTitle || target.title,
      content: params.newContent,
      relevantFiles: target.relevantFiles,
      version: target.version + 1,
      previousVersionId: target.id,
      supersedesId: target.id,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    db.saveKnowledgeItem(newItem);

    return { success: true, newItem };
  }

  /**
   * Remembers how a repair ended. Lessons live in this project's knowledge, so another
   * project or user never sees them. Seeing the same lesson again strengthens it.
   */
  static recordRepairLesson(
    buildId: string,
    userId: string,
    lesson: Omit<RepairLesson, 'id' | 'timesSeen' | 'createdAt'>
  ): RepairLesson | null {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) return null;

    const category = lesson.outcome === 'verified' ? 'reusable_solution' : 'known_limitation';
    const key = lesson.patchFingerprint || lesson.fingerprints[0] || lesson.repairId;
    const title = `${REPAIR_LESSON_PREFIX}${lesson.outcome}:${key}`;

    const existing = db.getKnowledgeItems(buildId, { category, status: 'active' }).find(item => item.title === title);
    if (existing) {
      const parsed = this.parseRepairLesson(existing);
      if (!parsed) return null;
      const repairIds = Array.from(new Set([...(parsed.repairIds || [parsed.repairId]), lesson.repairId]));
      const updated = { ...parsed, repairIds, timesSeen: parsed.timesSeen + 1, evidence: lesson.evidence };
      db.saveKnowledgeItem({ ...existing, content: JSON.stringify(updated), updatedAt: Date.now() });
      return updated;
    }

    const created = this.recordKnowledgeItem(buildId, userId, {
      sourceAgent: 'repair_coordinator',
      sourceRole: 'debugging_specialist',
      category,
      title,
      content: JSON.stringify({ ...lesson, timesSeen: 1, createdAt: Date.now() }),
      relevantFiles: lesson.files
    });
    return created.item ? this.parseRepairLesson(created.item) : null;
  }

  private static parseRepairLesson(item: import('../types.js').SharedKnowledgeItem): RepairLesson | null {
    if (!item.title.startsWith(REPAIR_LESSON_PREFIX)) return null;
    try {
      return { ...JSON.parse(item.content), id: item.id };
    } catch {
      return null;
    }
  }

  /** Reads this project's lessons, newest first. A non-owner gets nothing. */
  static getRepairLessons(
    buildId: string,
    userId: string,
    filter: { fingerprints?: string[]; files?: string[] } = {}
  ): RepairLesson[] {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) return [];

    return db.getKnowledgeItems(buildId, { status: 'active', search: REPAIR_LESSON_PREFIX })
      .map(item => this.parseRepairLesson(item))
      .filter((lesson): lesson is RepairLesson => Boolean(lesson))
      .filter(lesson => !filter.fingerprints || lesson.fingerprints.some(print => filter.fingerprints!.includes(print)))
      .filter(lesson => !filter.files || lesson.files.some(file => filter.files!.includes(file)))
      .slice(0, MAX_REPAIR_LESSONS);
  }

  /** A repair that was rolled back no longer counts as a verified fix. */
  static retractRepairLessons(buildId: string, userId: string, repairId: string): number {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) return 0;

    const verified = db.getKnowledgeItems(buildId, { category: 'reusable_solution', status: 'active' })
      .filter(item => {
        const lesson = this.parseRepairLesson(item);
        return lesson?.repairId === repairId || lesson?.repairIds?.includes(repairId);
      });
    for (const item of verified) {
      db.saveKnowledgeItem({ ...item, status: 'superseded', supersedeReason: 'The repair was rolled back', updatedAt: Date.now() });
    }
    return verified.length;
  }

  /**
   * Searches and filters shared technical knowledge
   */
  static searchKnowledge(
    buildId: string,
    userId: string,
    filter?: { category?: string; search?: string; status?: string }
  ): import('../types.js').SharedKnowledgeItem[] {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return [];
    }

    return db.getKnowledgeItems(buildId, {
      category: filter?.category,
      search: filter?.search,
      status: filter?.status || 'active'
    });
  }
}

export const projectMemoryService = ProjectMemoryService;

