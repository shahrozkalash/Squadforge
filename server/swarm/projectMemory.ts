import { db } from '../store.js';
import { 
  Build, 
  ProjectType, 
  TechStackConfig, 
  ArchitectureDecision, 
  RequirementItem, 
  ProjectRevision,
  Task,
  ProjectFile
} from '../types.js';

export type { ArchitectureDecision, RequirementItem, ProjectRevision };

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
  discoveredAt: number;
  resolvedAt?: number;
}

export interface ModuleRelationship {
  sourcePath: string;
  imports: string[];
  exports: string[];
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
  lastUpdated: number;
}

export class ProjectMemoryService {
  private static MAX_FACTS = 40;
  private static MAX_ADRS = 15;
  private static MAX_DEFECTS = 30;

  /**
   * Initializes or loads project memory with strict user isolation.
   */
  static getOrInitializeMemory(buildId: string, userId: string): ProjectMemory | null {
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
      lastUpdated: Date.now()
    };

    db.saveProjectMemory(newMemory);
    return newMemory;
  }

  /**
   * Records a confirmed fact or an assumption, preventing duplicates
   */
  static recordFact(
    buildId: string, 
    userId: string, 
    fact: Omit<ProjectFact, 'id' | 'timestamp'>
  ): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    // Check duplicate statement
    const normalized = fact.statement.toLowerCase().trim();
    const existing = memory.facts.find(f => f.statement.toLowerCase().trim() === normalized);
    if (existing) {
      // If upgraded from assumption to confirmed, update confidence
      if (existing.confidence === 'assumption' && fact.confidence === 'confirmed') {
        existing.confidence = 'confirmed';
        existing.source = fact.source;
        memory.lastUpdated = Date.now();
        db.saveProjectMemory(memory);
      }
      return true;
    }

    const newFact: ProjectFact = {
      ...fact,
      id: `fact_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now()
    };

    memory.facts.unshift(newFact);
    if (memory.facts.length > this.MAX_FACTS) {
      memory.facts = memory.facts.slice(0, this.MAX_FACTS);
    }

    memory.lastUpdated = Date.now();
    db.saveProjectMemory(memory);
    return true;
  }

  /**
   * Records or supersedes an Architecture Decision Record (ADR)
   */
  static recordDecision(
    buildId: string,
    userId: string,
    decision: ArchitectureDecision
  ): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    const existingIndex = memory.architectureDecisions.findIndex(d => d.id === decision.id);
    if (existingIndex >= 0) {
      memory.architectureDecisions[existingIndex] = {
        ...decision,
        timestamp: Date.now()
      };
    } else {
      memory.architectureDecisions.push({
        ...decision,
        timestamp: Date.now()
      });
      if (memory.architectureDecisions.length > this.MAX_ADRS) {
        memory.architectureDecisions = memory.architectureDecisions.slice(-this.MAX_ADRS);
      }
    }

    memory.lastUpdated = Date.now();
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
   * Updates requirement satisfaction status based on actual verified implementation
   */
  static updateRequirement(
    buildId: string,
    userId: string,
    reqId: string,
    satisfied: boolean,
    files?: string[],
    notes?: string
  ): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    const req = memory.requirements.find(r => r.id === reqId);
    if (!req) return false;

    req.satisfied = satisfied;
    req.status = satisfied ? 'satisfied' : 'pending';
    if (files) req.satisfiedByFiles = files;
    if (notes) req.verificationNotes = notes;

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
   * Logs a known defect identified by the verification service
   */
  static recordDefect(
    buildId: string,
    userId: string,
    defect: Omit<ProjectDefect, 'id' | 'discoveredAt' | 'resolved'>
  ): string | null {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return null;

    // Check duplicate defect
    const existing = memory.knownDefects.find(
      d => !d.resolved && d.description.toLowerCase().trim() === defect.description.toLowerCase().trim()
    );
    if (existing) return existing.id;

    const id = `def_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newDefect: ProjectDefect = {
      ...defect,
      id,
      resolved: false,
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
   * Marks a defect as resolved with timestamp
   */
  static resolveDefect(buildId: string, userId: string, defectId: string): boolean {
    const memory = this.getOrInitializeMemory(buildId, userId);
    if (!memory) return false;

    const defect = memory.knownDefects.find(d => d.id === defectId);
    if (!defect) return false;

    defect.resolved = true;
    defect.resolvedAt = Date.now();

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

    // 2. Relevant ADRs (accepted decisions only)
    const activeAdrs = memory.architectureDecisions.filter(d => d.status === 'accepted');
    if (activeAdrs.length > 0) {
      const adrLines = activeAdrs.slice(0, 3).map(d => `- [${d.id}] ${d.title}: ${d.decision}`);
      sections.push(`ARCHITECTURE CONSTRAINTS:\n${adrLines.join('\n')}`);
    }

    // 3. Relevant Requirements matching target file paths or category
    const relevantReqs = memory.requirements.filter(r => {
      if (r.satisfied && !task.isFixTask) return false;
      if (r.satisfiedByFiles?.some(f => task.filePaths.includes(f))) return true;
      if (task.filePaths.some(p => p.toLowerCase().includes(r.category || ''))) return true;
      return true;
    }).slice(0, 4);

    if (relevantReqs.length > 0) {
      const reqLines = relevantReqs.map(r => 
        `- [${r.priority.toUpperCase()}] ${r.title || r.id}: ${r.description} (${r.satisfied ? 'SATISFIED' : 'PENDING'})`
      );
      sections.push(`TARGET REQUIREMENTS:\n${reqLines.join('\n')}`);
    }

    // 4. Relevant Known Defects (vital for fix tasks)
    const relevantDefects = memory.knownDefects.filter(
      d => !d.resolved && d.filePaths.some(fp => task.filePaths.includes(fp))
    );
    if (relevantDefects.length > 0) {
      const defectLines = relevantDefects.slice(0, 3).map(d => `- [DEFECT] ${d.description}`);
      sections.push(`ACTIVE DEFECTS TO REMEDY:\n${defectLines.join('\n')}`);
    }

    // 5. Confirmed Facts
    const confirmedFacts = memory.facts.filter(f => f.confidence === 'confirmed').slice(0, 3);
    if (confirmedFacts.length > 0) {
      const factLines = confirmedFacts.map(f => `- ${f.statement}`);
      sections.push(`ESTABLISHED FACTS:\n${factLines.join('\n')}`);
    }

    // 6. Coding Conventions
    if (memory.conventions.length > 0) {
      sections.push(`CODING CONVENTIONS:\n${memory.conventions.slice(0, 3).map(c => `- ${c}`).join('\n')}`);
    }

    const fullContext = sections.join('\n\n');
    if (fullContext.length <= maxChars) {
      return fullContext;
    }
    return fullContext.slice(0, maxChars) + '\n...[truncated for token limit]';
  }
}
