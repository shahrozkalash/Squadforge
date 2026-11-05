import { db } from '../store.js';
import { modelRegistry, AGENT_SPECS } from '../modelRegistry.js';
import { 
  callUnifiedGateway, 
  parseVerifierResponse, 
  SILENT_WORKER_SYSTEM_PROMPT 
} from '../gateway.js';
import { TaskManager } from './taskManager.js';
import { MergeManager } from './mergeManager.js';
import { SandboxRunner } from './sandboxRunner.js';
import { GitHubService } from '../github.js';
import { tokenOptimizer } from '../tokenOptimizer.js';
import { PreviewGenerator } from './previewGenerator.js';
import { IntegrationAgent } from './integrationAgent.js';
import { ProjectMemoryService } from './projectMemory.js';
import { HonestVerificationService } from '../verificationService.js';
import { SoftwareRequirementsAnalyzer } from '../architecture/requirementsAnalyzer.js';
import { IntelligentStackSelector } from '../architecture/stackSelector.js';
import { UniversalArchitectureBlueprintGenerator } from '../architecture/blueprintGenerator.js';
import { ProjectComplexityEstimator } from '../architecture/complexityEstimator.js';
import { AdaptiveFileStructurePlanner } from '../architecture/fileStructurePlanner.js';
import { ArchitectureDependencyPlanner } from '../architecture/architectureDependencyPlanner.js';
import { CollaborationManager } from './collaborationManager.js';
import { CodeReviewEngine } from './codeReviewEngine.js';
import { PatchValidationPipeline } from './patchValidationPipeline.js';
import { AIChallengeEngine } from './aiChallengeEngine.js';
import { CollaborativeDebuggingEngine } from './collaborativeDebuggingEngine.js';
import { ApprovalGateService } from './approvalGateService.js';
import { SharedWorkspaceService } from './sharedWorkspaceService.js';
import { CodeGenerationEngine } from './codeGenerationEngine.js';
import { ProjectContextEngine } from './projectContextEngine.js';
import { ContractFirstEngine } from './contractFirstEngine.js';
import { 
  Build, 
  ModelConfig, 
  Task, 
  ModelActionResponse, 
  AgentRole,
  TechStackConfig,
  Milestone,
  ArchitectureDecision,
  RequirementItem,
  ProjectRevision,
  ProjectType,
  CanonicalProjectType,
  normalizeProjectType,
  PatchProposalHunk,
  HumanApprovalRequest
} from '../types.js';

interface ActiveSwarmControl {
  stopRequested: boolean;
  workerCount: number;
  abortController: AbortController;
}

export class SwarmOrchestrator {
  private static activeSwarms: Map<string, ActiveSwarmControl> = new Map();
  private static readonly AWAITING_APPROVAL = 'Waiting for owner approval of sensitive files';
  private static MAX_VERIFICATION_ATTEMPTS = 3;
  private static MAX_TASK_RETRIES = 3;

  /**
   * Stops an active build swarm gracefully
   */
  static stopSwarm(buildId: string): void {
    const control = this.activeSwarms.get(buildId);
    if (control) {
      control.stopRequested = true;
      control.abortController.abort(new Error('Build stopped by user'));
    }
    ApprovalGateService.cancelTaskRequests(buildId);

    const build = db.getBuild(buildId);
    if (build && (build.status === 'running' || build.status === 'planning' || build.status === 'verifying' || build.status === 'in_progress')) {
      build.status = 'stopped';
      build.completedAt = Date.now();
      db.saveBuild(build);

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'build_stopped',
        details: 'Build halted manually by user STOP request'
      });
    }
  }

  /** Records applied file changes, so the patch history shows every change that landed. */
  private static recordAppliedPatches(buildId: string, agent: string, role: AgentRole, task: Task, actions: any[]): void {
    for (const fa of actions) {
      const targetPath = ('path' in fa && typeof fa.path === 'string') 
        ? fa.path 
        : ('newPath' in fa ? (fa as any).newPath : '');
      if (!targetPath) continue;

      const fileNow = db.getFile(buildId, targetPath);
      if (fileNow) {
        let proposedChanges: PatchProposalHunk = { actionType: 'patch' };
        if (fa.action === 'create_file') {
          proposedChanges = { actionType: 'create', content: (fa as any).content || '' };
        } else if (fa.action === 'patch_file') {
          const firstEdit = (fa as any).edits?.[0];
          proposedChanges = {
            actionType: 'patch',
            find: firstEdit?.find || (fa as any).find || '',
            replace: firstEdit?.replace || (fa as any).replace || ''
          };
        } else if (fa.action === 'delete_file') {
          proposedChanges = { actionType: 'delete' };
        } else if (fa.action === 'rename_file') {
          proposedChanges = {
            actionType: 'rename',
            oldPath: (fa as any).oldPath,
            newPath: (fa as any).newPath
          };
        }

        db.savePatchProposal({
          id: `patch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          buildId,
          authorAgent: agent,
          authorRole: role,
          relatedTaskId: task.id,
          targetFile: targetPath,
          baseFileVersion: Math.max(1, (fileNow.version || 1) - 1),
          baseContentHash: fileNow.contentHash || '',
          proposedChanges,
          changeExplanation: fa.commitMessage || `Implementation for ${task.title}`,
          expectedBehavior: task.description,
          validationResults: { syntaxValid: true, pathAllowed: true, hashMatched: true, versionCurrent: true, errors: [] },
          reviewStatus: 'approved',
          applicationStatus: 'applied',
          appliedFileVersion: fileNow.version,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      }
    }
  }

  /**
   * Finishes a task that was waiting on the owner. An approval applies the reviewed change,
   * and anything else fails the task, so the build reports what really happened.
   */
  static async resolveHeldTask(request: HumanApprovalRequest): Promise<void> {
    const { buildId, taskId } = request;
    const task = taskId ? db.getTask(buildId, taskId) : undefined;
    if (!task || task.pausedReason !== this.AWAITING_APPROVAL) return;

    const paused = { isPaused: false, pausedReason: undefined };
    const proposed = request.proposedActions || [];
    const fileActions = proposed.filter(action => action.action !== 'create_task');
    let failure: string | undefined = request.status === 'approved' ? undefined : `Sensitive change ${request.status} by the owner`;
    if (request.status === 'approved') {
      try {
        const applied = await MergeManager.applyBatchActions(buildId, request.requestingAgent, fileActions);
        if (!applied.success) failure = `Approved changes could not be applied: ${applied.error}`;
      } catch (err: any) {
        failure = `Approved changes could not be applied: ${err.message}`;
      }
    }

    if (failure) {
      db.updateTask(buildId, task.id, { ...paused, status: 'failed', error: failure });
    } else {
      this.recordAppliedPatches(buildId, request.requestingAgent, request.requestingRole, task, fileActions);
      for (const action of proposed.filter(a => a.action === 'create_task')) {
        TaskManager.createNewTask(buildId, {
          title: action.title,
          description: action.description,
          filePaths: action.filePaths,
          dependencies: action.dependencies,
          assignedRole: action.assignedRole,
          priority: action.priority || 3,
          maxRetries: this.MAX_TASK_RETRIES
        });
      }

      // The same completion check as any other task, which needs the task to be claimed
      db.updateTask(buildId, task.id, {
        ...paused,
        status: 'in_progress',
        claimedBy: request.requestingAgent,
        leaseExpiresAt: Date.now() + 90 * 1000
      });
      const completed = TaskManager.completeTask(buildId, task.id, request.requestingAgent);
      if (!completed.success) failure = completed.error || 'Task verification failed';
    }

    const build = db.getBuild(buildId);
    if (build?.status !== 'running') return;

    // Dependents of a failed task can never start, so the build would wait forever
    if (failure && db.getTasks(buildId).some(t => t.dependencies?.includes(task.id))) {
      build.status = 'failed';
      build.completedAt = Date.now();
      build.failureReason = `Task "${task.title}" failed: ${failure}`;
      build.error = build.failureReason;
      db.saveBuild(build);
      const control = this.activeSwarms.get(buildId);
      if (control) control.stopRequested = true;
      return;
    }

    // Workers may have finished while the task waited
    if (!this.activeSwarms.has(buildId)) await this.resumeSwarm(buildId);
  }

  /**
   * Resumes an existing or stopped build from its saved state
   */
  static async resumeSwarm(buildId: string): Promise<boolean> {
    const build = db.getBuild(buildId);
    if (!build) return false;

    if (this.activeSwarms.has(buildId)) {
      return true; // Already running
    }

    // Stop withdraws waiting requests, so those tasks go back on the board
    const waiting = new Set(db.getApprovalRequests(buildId, 'pending').map(r => r.taskId));
    for (const task of db.getTasks(buildId)) {
      if (task.pausedReason === this.AWAITING_APPROVAL && !waiting.has(task.id)) {
        TaskManager.resumeTask(buildId, task.id);
      }
    }

    build.status = 'running';
    db.saveBuild(build);

    const control: ActiveSwarmControl = {
      stopRequested: false,
      workerCount: 0,
      abortController: new AbortController()
    };
    this.activeSwarms.set(buildId, control);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'build_started',
      details: `Resumed autonomous development swarm for build ${buildId}`
    });

    const enabledModels = build.selectedModels
      .map(id => modelRegistry.getById(id))
      .filter((m): m is ModelConfig => !!m && m.enabled);

    control.workerCount = enabledModels.length;

    // Launch worker loops concurrently
    const workerPromises = enabledModels.map(model => 
      this.runModelWorkerLoop(buildId, model, control)
    );

    Promise.all(workerPromises).finally(() => {
      this.activeSwarms.delete(buildId);
    });

    return true;
  }

  /**
   * Starts the continuous parallel swarm for a build
   */
  static async startSwarm(buildId: string): Promise<void> {
    const build = db.getBuild(buildId);
    if (!build) return;

    const control: ActiveSwarmControl = {
      stopRequested: false,
      workerCount: 0,
      abortController: new AbortController()
    };
    this.activeSwarms.set(buildId, control);

    build.status = 'planning';
    build.maxVerificationAttempts = this.MAX_VERIFICATION_ATTEMPTS;
    build.verificationAttempts = 0;
    db.saveBuild(build);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'build_started',
      details: `Autonomous Development Swarm initialized for: "${build.idea}". Active models: ${build.selectedModels.length}`
    });

    try {
      // Initialize Phase 8 collaborative agent profiles
      CollaborationManager.initializeBuildAgents(buildId, build.selectedModels);

      // 1. INITIAL PROJECT MANAGER & ARCHITECT SPECIFICATION
      const planSuccess = await this.runInitialPlanner(build);
      if (!planSuccess) {
        throw new Error('Initial project planning failed. Could not establish specification.');
      }

      // 2. LAUNCH SPECIALIZED AGENT WORKERS CONCURRENTLY
      build.status = 'running';
      db.saveBuild(build);

      const enabledModels = build.selectedModels
        .map(id => modelRegistry.getById(id))
        .filter((m): m is ModelConfig => !!m && m.enabled);

      if (enabledModels.length === 0) {
        throw new Error('No enabled models available to run swarm.');
      }

      control.workerCount = enabledModels.length;

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'build_started',
        details: `Simultaneously launching ${enabledModels.length} specialized agent loops (PM, Architect, Frontend, Backend, DB, QA, Security, Debugging, DevOps)`
      });

      // Launch all models concurrently with Promise.all
      const workerPromises = enabledModels.map(model => 
        this.runModelWorkerLoop(buildId, model, control)
      );

      // Await all workers
      await Promise.all(workerPromises);

      // Swarm finished or stopped
      this.activeSwarms.delete(buildId);

    } catch (err: any) {
      console.error(`Swarm execution failed for build ${buildId}:`, err);
      build.status = 'failed';
      build.error = err.message || 'Swarm execution failure';
      build.failureReason = err.message || 'Swarm execution failure';
      build.completedAt = Date.now();
      db.saveBuild(build);

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'build_failed',
        details: `Swarm encountered error: ${err.message}`
      });
    }
  }

  /** Writes the planner's files. The planner has no task of its own, so sensitive ones wait on a new one. */
  private static async applyPlannedFiles(build: Build, actions: any[], milestone: string): Promise<void> {
    const { ready, held } = ApprovalGateService.splitSensitiveActions(build.id, actions.filter(a => a.action === 'create_file'));
    for (const action of ready) {
      await MergeManager.createFile(build.id, 'software_architect', action as any);
    }
    if (held.length === 0) return;

    const holder = TaskManager.createNewTask(build.id, {
      title: 'Apply sensitive files from the plan',
      description: 'Applies the sensitive files the planner proposed, once the owner approves them.',
      filePaths: held.map(action => ApprovalGateService.normalizePath(action.path)),
      priority: 1,
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'software_architect',
      milestone
    });
    build.milestones?.[0]?.taskIds.push(holder.id);
    // Model run and event records need a real model id, not a role
    ApprovalGateService.requestForActions(build.id, build.userId, {
      agent: build.selectedModels[0] || 'gemini',
      actions: held,
      taskId: holder.id
    });
    TaskManager.pauseTask(build.id, holder.id, this.AWAITING_APPROVAL);
  }

  /**
   * Phase 1: Universal Software Architecture Engine establishes requirements analysis, 
   * technology selection, architecture blueprint, complexity assessment, and dependency planning.
   */
  private static async runInitialPlanner(build: Build): Promise<boolean> {
    // 1. Requirements Analysis
    const reqAnalysis = SoftwareRequirementsAnalyzer.analyze(build.idea, build.projectType);
    build.requirementsAnalysis = reqAnalysis;
    build.projectType = reqAnalysis.applicationCategory;

    // 2. Intelligent Stack Selection (respects existing stack if established)
    const stackSelection = IntelligentStackSelector.selectStack(reqAnalysis, build.techStack);
    const rec = stackSelection.recommendedStack;
    const techStack: TechStackConfig = {
      frontend: rec.frontend || rec.uiFramework || rec.desktopFramework || 'N/A',
      backend: rec.backend || rec.runtime || 'N/A',
      database: rec.database || 'Embedded / In-Memory State',
      testing: rec.testing || 'Native Automated Test Runner',
      security: 'OWASP Defensive Validation, Rate Limiter & Safe Boundaries'
    };
    build.techStack = techStack;

    // 3. Universal Architecture Blueprint Generation
    const blueprint = UniversalArchitectureBlueprintGenerator.generate(reqAnalysis, stackSelection);
    build.architectureBlueprint = blueprint;

    // 4. Complexity & Resource Estimation
    const complexity = ProjectComplexityEstimator.assess(reqAnalysis, stackSelection);
    build.complexityAssessment = complexity;

    // 5. Adaptive File Structure Planning
    const fileStructurePlan = AdaptiveFileStructurePlanner.planStructure(
      reqAnalysis.applicationCategory,
      reqAnalysis.targetPlatforms,
      rec
    );
    build.fileStructurePlan = fileStructurePlan;

    // 6. Architecture-Level Dependency Planning
    const dependencyPlan = ArchitectureDependencyPlanner.planDependencies(
      reqAnalysis.applicationCategory,
      reqAnalysis.targetPlatforms,
      rec,
      build.idea
    );
    build.dependencyPlan = dependencyPlan;

    // 7. Architecture Decision Records (ADRs)
    build.architectureDecisions = this.generateArchitectureDecisions(build.idea, build.projectType);

    // 8. Project Requirements Checklist
    build.requirementsChecklist = this.generateRequirementsChecklist(build.idea, build.projectType, reqAnalysis);

    // 9. Persistent Project Memory Synchronization with strict user isolation
    ProjectMemoryService.getOrInitializeMemory(build.id, build.userId);
    ProjectMemoryService.recordRequirementsAnalysis(build.id, build.userId, reqAnalysis);
    ProjectMemoryService.recordArchitectureBlueprint(build.id, build.userId, blueprint);
    ProjectMemoryService.recordComplexityAssessment(build.id, build.userId, complexity);
    ProjectMemoryService.recordFileStructurePlan(build.id, build.userId, fileStructurePlan);
    ProjectMemoryService.recordDependencyPlan(build.id, build.userId, dependencyPlan);

    // 10. Project Manager creates milestone breakdown
    const m1Id = 'ms_1_foundation';
    const m2Id = 'ms_2_core';
    const m3Id = 'ms_3_qa_security';
    const m4Id = 'ms_4_release';

    build.milestones = [
      {
        id: m1Id,
        title: 'Milestone 1: Architecture & Foundation',
        description: 'Define contracts, domain interfaces, and project configuration',
        status: 'in_progress',
        taskIds: []
      },
      {
        id: m2Id,
        title: 'Milestone 2: Core Implementation',
        description: 'Implement core modules, state management, and user interfaces',
        status: 'pending',
        taskIds: []
      },
      {
        id: m3Id,
        title: 'Milestone 3: QA, Verification & Security',
        description: 'Create automated test suites and audit for security vulnerabilities',
        status: 'pending',
        taskIds: []
      },
      {
        id: m4Id,
        title: 'Milestone 4: DevOps & Release',
        description: 'Prepare Docker container, CI workflows, and documentation',
        status: 'pending',
        taskIds: []
      }
    ];

    const plannerPrompt = `PROJECT MANAGER & ARCHITECT SPECIFICATION:
Original Requirements: "${build.idea}"
Project Type: ${build.projectType}
Target Platforms: ${reqAnalysis.targetPlatforms.join(', ')}
Estimated Complexity: ${complexity.level} (Score: ${complexity.score}/100)
Selected Tech Stack:
- Frontend: ${techStack.frontend}
- Backend: ${techStack.backend}
- Database: ${techStack.database}
- Testing: ${techStack.testing}
- Security: ${techStack.security}

Architecture Decisions (ADRs):
${build.architectureDecisions.map(a => `- ${a.title}: ${a.decision}`).join('\n')}

Key Modules:
${blueprint.moduleStructure.map(m => `- ${m.name}: ${m.description}`).join('\n')}

Create the starter file tree and dependency-aware tasks.
Available Agent Roles: software_architect, backend_developer, frontend_developer, fullstack_developer, database_specialist, qa_testing_specialist, security_specialist, devops_release_specialist, debugging_specialist.
Assign fullstack_developer when a task bridges both frontend views and backend integration/state orchestration.
Output ONLY JSON matching this structure:
{
  "actions": [
    {
      "action": "create_file",
      "path": "src/types/domain.ts",
      "content": "...complete domain types...",
      "commitMessage": "Architect domain contracts and types"
    },
    {
      "action": "create_task",
      "title": "Architect Domain Data Types & Contracts",
      "description": "Establish TypeScript interfaces for domain models and data transfer objects",
      "filePaths": ["src/types/domain.ts"],
      "priority": 2,
      "assignedRole": "software_architect"
    }
  ]
}`;

    const plannerResult = await callUnifiedGateway({
      modelId: 'gemini',
      prompt: plannerPrompt,
      systemInstruction: SILENT_WORKER_SYSTEM_PROMPT,
      allowFallback: true,
      signal: this.activeSwarms.get(build.id)?.abortController.signal
    });

    if (plannerResult.success && plannerResult.parsedResponse) {
      await this.applyPlannedFiles(build, plannerResult.parsedResponse.actions, m1Id);

      for (const action of plannerResult.parsedResponse.actions) {
        if (action.action === 'create_task') {
          const t = TaskManager.createNewTask(build.id, {
            title: action.title,
            description: action.description,
            filePaths: action.filePaths,
            priority: action.priority || 3,
            maxRetries: this.MAX_TASK_RETRIES,
            assignedRole: action.assignedRole,
            milestone: m1Id
          });
          build.milestones[0].taskIds.push(t.id);
        }
      }
    }

    // Seed structured dependency-aware tasks if needed
    const currentTasks = db.getTasks(build.id).filter(t => t.pausedReason !== this.AWAITING_APPROVAL);
    if (currentTasks.length < 4) {
      this.seedMilestoneTasks(build, m1Id, m2Id, m3Id, m4Id);
    }

    // Ensure README.md exists with comprehensive architecture summary
    const readme = db.getFile(build.id, 'README.md');
    if (!readme) {
      const adrList = (build.architectureDecisions || [])
        .map(a => `### ${a.title}\n**Decision:** ${a.decision}\n**Rationale:** ${a.rationale}`)
        .join('\n\n');

      const modulesList = blueprint.moduleStructure
        .map(m => `- **${m.name}**: ${m.description}`)
        .join('\n');

      await MergeManager.createFile(build.id, 'project_manager', {
        action: 'create_file',
        path: 'README.md',
        content: `# ${build.idea}\n\nBuilt by **SquadForge Universal Software Architecture Engine**.\n\n## Project Classification\n- **Category:** \`${build.projectType}\`\n- **Target Platforms:** ${reqAnalysis.targetPlatforms.join(', ')}\n- **Complexity Level:** ${complexity.level.toUpperCase()} (Score: ${complexity.score}/100)\n\n## Technology Stack\n- **Frontend / UI:** ${techStack.frontend}\n- **Backend / Runtime:** ${techStack.backend}\n- **Data Storage:** ${techStack.database}\n- **Testing Suite:** ${techStack.testing}\n\n## Subsystems & Architecture Modules\n${modulesList}\n\n## Architecture Decision Records (ADRs)\n${adrList}\n\n## Running the Project\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`,
        commitMessage: 'Project documentation, architecture blueprint & specification'
      });
    }

    db.saveBuild(build);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId: build.id,
      timestamp: Date.now(),
      type: 'plan_created',
      details: `Universal architecture blueprint established (${build.projectType}, ${complexity.level}) across 4 milestones (${db.getTasks(build.id).length} dependent tasks, ${build.architectureDecisions?.length || 0} ADRs, ${blueprint.moduleStructure.length} modules)`
    });

    return true;
  }

  /**
   * Strongly typed, extensible project type detection.
   * Backward-compatible with legacy project types and safe fallback for custom types.
   */
  static detectProjectType(idea: string, currentType?: ProjectType): ProjectType {
    const lower = idea.toLowerCase();
    if (lower.includes('saas') && (lower.includes('dashboard') || lower.includes('metrics'))) {
      return 'saas_dashboard';
    }
    if (lower.includes('internal') && (lower.includes('tool') || lower.includes('admin') || lower.includes('console'))) {
      return 'internal_tool';
    }
    if (lower.includes('blog') && (lower.includes('content') || lower.includes('publication') || lower.includes('articles'))) {
      return 'blog_content';
    }
    return SoftwareRequirementsAnalyzer.detectCategory(lower, currentType);
  }

  /**
   * Helper to select tech stack tuned to project type using intelligent registry.
   */
  static selectOptimalTechStack(type: ProjectType): TechStackConfig {
    const canonical = normalizeProjectType(type);
    const analysis = SoftwareRequirementsAnalyzer.analyze(`Project classification: ${canonical}`, canonical);
    const stackResult = IntelligentStackSelector.selectStack(analysis);
    const rec = stackResult.recommendedStack;
    return {
      frontend: rec.frontend || rec.uiFramework || rec.desktopFramework || 'N/A',
      backend: rec.backend || rec.runtime || 'N/A',
      database: rec.database || 'In-Memory Key-Value & Document Store',
      testing: rec.testing || 'Node.js Native Test Runner (node:test + assert)',
      security: 'OWASP Defensive Validation, Rate Limiter & AES-256'
    };
  }

  /**
   * Helper to generate Architecture Decision Records (ADRs)
   */
  static generateArchitectureDecisions(idea: string, type: ProjectType): ArchitectureDecision[] {
    const now = Date.now();
    return [
      {
        id: `ADR-001`,
        title: `ADR-001: Modular Component Architecture for ${type.replace(/_/g, ' ')}`,
        status: 'accepted',
        context: `The project "${idea.slice(0, 50)}" requires clean separation of concerns, responsive design, and rapid iteration.`,
        decision: `Implement small, single-responsibility files (under ~150 lines) with strictly typed props and TypeScript contracts.`,
        rationale: `Prevents merge collisions across autonomous swarm agents and facilitates isolated automated testing.`,
        consequences: `Improves maintainability and makes independent file verification fast and conflict-free.`,
        timestamp: now
      },
      {
        id: `ADR-002`,
        title: `ADR-002: Tailwind CSS Utility-First Styling & Dark Mode`,
        status: 'accepted',
        context: `Ensures cohesive typography, responsive breakpoints (mobile, tablet, desktop), and accessibility.`,
        decision: `Use semantic Tailwind utility classes with neutral dark mode palette and accent branding.`,
        rationale: `Zero runtime CSS-in-JS overhead, predictable responsive behavior, and instant preview rendering.`,
        consequences: `Provides seamless responsive scaling across desktop, tablet, and mobile device frames.`,
        timestamp: now
      },
      {
        id: `ADR-003`,
        title: `ADR-003: Defensive Input Validation & Error Handling`,
        status: 'accepted',
        context: `Untrusted inputs, network timeouts, or malformed states must never crash the UI or server process.`,
        decision: `Guard all user inputs, parameters, and API endpoints with defensive schema sanitization and structured fallback states.`,
        rationale: `Satisfies OWASP security posture and prevents runtime exceptions across browsers.`,
        consequences: `Guarantees rock-solid uptime and graceful user-facing error feedback.`,
        timestamp: now
      }
    ];
  }

  /**
   * Helper to generate Requirements Checklist from confirmed requirements or category template
   */
  static generateRequirementsChecklist(idea: string, type: ProjectType, analysis?: any): RequirementItem[] {
    if (analysis && Array.isArray(analysis.confirmedRequirements) && analysis.confirmedRequirements.length > 0) {
      return analysis.confirmedRequirements.map((req: any, index: number) => ({
        id: req.id || `req_${index + 1}`,
        title: req.statement.slice(0, 40),
        category: req.category || 'functional',
        description: req.statement,
        priority: req.priority || 'must_have',
        satisfied: false,
        status: 'pending' as const
      }));
    }

    const canonical = normalizeProjectType(type);
    if (canonical === 'landing_page') {
      return [
        { id: 'req_1', title: 'Hero Section', category: 'frontend', description: 'Responsive Hero Banner with CTA action and value proposition', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_2', title: 'Feature Grid', category: 'frontend', description: 'Feature showcase grid with icons and benefits', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_3', title: 'Pricing Tiers', category: 'frontend', description: 'Multi-tier pricing comparison table with feature breakdown', priority: 'should_have', satisfied: false, status: 'pending' },
        { id: 'req_4', title: 'FAQ Section', category: 'frontend', description: 'Interactive FAQ accordion with expandable answers', priority: 'should_have', satisfied: false, status: 'pending' },
        { id: 'req_5', title: 'Lead Capture', category: 'security', description: 'Validated lead capture / contact form with error handling', priority: 'must_have', satisfied: false, status: 'pending' }
      ];
    }
    if (canonical === 'saas') {
      return [
        { id: 'req_1', title: 'Sidebar Navigation', category: 'frontend', description: 'Responsive sidebar navigation with view routing', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_2', title: 'KPI Metrics', category: 'frontend', description: 'KPI summary metrics cards with real-time indicators', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_3', title: 'Data Table', category: 'core', description: 'Data table with search, sorting, and pagination controls', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_4', title: 'Telemetry & Logs', category: 'backend', description: 'Activity audit log or performance telemetry chart', priority: 'should_have', satisfied: false, status: 'pending' },
        { id: 'req_5', title: 'Settings & Security', category: 'security', description: 'Configuration settings modal with form validation', priority: 'nice_to_have', satisfied: false, status: 'pending' }
      ];
    }
    if (canonical === 'ecommerce') {
      return [
        { id: 'req_1', title: 'Product Catalog', category: 'frontend', description: 'Product catalog grid with category filters and search', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_2', title: 'Product Details', category: 'core', description: 'Product detail view with specifications and stock status', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_3', title: 'Cart Drawer', category: 'frontend', description: 'Interactive shopping cart drawer with quantity adjustments', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_4', title: 'Checkout & Validation', category: 'security', description: 'Checkout modal with shipping and payment calculation validation', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_5', title: 'Store Test Suite', category: 'testing', description: 'Automated unit tests validating cart total and price calculations', priority: 'must_have', satisfied: false, status: 'pending' }
      ];
    }
    if (canonical === 'portfolio') {
      return [
        { id: 'req_1', title: 'Bio Banner', category: 'frontend', description: 'Professional biography banner with skills overview', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_2', title: 'Project Showcase', category: 'frontend', description: 'Interactive project portfolio gallery with modal previews', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_3', title: 'Skills Matrix', category: 'core', description: 'Technical skills matrix categorized by frontend/backend/DevOps', priority: 'should_have', satisfied: false, status: 'pending' },
        { id: 'req_4', title: 'Contact & Inquiries', category: 'security', description: 'Inquiry contact form with submission feedback', priority: 'must_have', satisfied: false, status: 'pending' }
      ];
    }
    return [
      { id: 'req_1', title: 'Domain Contracts', category: 'core', description: 'Domain contracts and data transfer objects', priority: 'must_have', satisfied: false, status: 'pending' },
      { id: 'req_2', title: 'Business Logic', category: 'backend', description: 'Core business logic engine with clean function interfaces', priority: 'must_have', satisfied: false, status: 'pending' },
      { id: 'req_3', title: 'Data Persistence', category: 'backend', description: 'Data storage service with transactional consistency', priority: 'must_have', satisfied: false, status: 'pending' },
      { id: 'req_4', title: 'UI Components', category: 'frontend', description: 'Responsive user interface component with loading and error states', priority: 'must_have', satisfied: false, status: 'pending' },
      { id: 'req_5', title: 'Automated Tests', category: 'testing', description: 'Automated test suite validating assertions and edge cases', priority: 'must_have', satisfied: false, status: 'pending' },
      { id: 'req_6', title: 'Security & DevOps', category: 'security', description: 'Security hardening, defensive validation, and deployment container', priority: 'should_have', satisfied: false, status: 'pending' }
    ];
  }

  /**
   * Seeds dependency-aware tasks across milestones tailored to project type
   */
  private static seedMilestoneTasks(build: Build, m1: string, m2: string, m3: string, m4: string): void {
    const type = build.projectType || 'fullstack';

    if (type === 'landing_page') {
      const task1 = TaskManager.createNewTask(build.id, {
        title: 'Architect Landing Page Section Hierarchy & Schema',
        description: `Design modular component contracts for: ${build.idea}`,
        filePaths: ['src/types/landing.ts'],
        priority: 2,
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'software_architect',
        milestone: m1
      });

      const task2 = TaskManager.createNewTask(build.id, {
        title: 'Build Hero Section & Navigation Bar',
        description: 'Implement responsive hero banner with value proposition and primary CTA',
        filePaths: ['src/components/Hero.tsx'],
        priority: 2,
        dependencies: [task1.id],
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'frontend_developer',
        milestone: m2
      });

      const task3 = TaskManager.createNewTask(build.id, {
        title: 'Build Feature Grid & Benefits Showcase',
        description: 'Implement interactive feature grid with icons, badges, and responsive columns',
        filePaths: ['src/components/Features.tsx'],
        priority: 3,
        dependencies: [task1.id],
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'frontend_developer',
        milestone: m2
      });

      const task4 = TaskManager.createNewTask(build.id, {
        title: 'Build Pricing Comparison & FAQ Accordion',
        description: 'Implement multi-tier pricing table with billing toggle and expandable FAQ accordion',
        filePaths: ['src/components/Pricing.tsx', 'src/components/FAQ.tsx'],
        priority: 3,
        dependencies: [task1.id],
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'frontend_developer',
        milestone: m2
      });

      const taskEntry = TaskManager.createNewTask(build.id, {
        title: 'Integrate Landing Application Entry Point & Responsive Layout',
        description: 'Unify Hero, Features, Pricing, and Contact form into runnable root src/App.tsx with responsive navigation',
        filePaths: ['src/App.tsx'],
        priority: 2,
        dependencies: [task2.id, task3.id, task4.id],
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'frontend_developer',
        milestone: m2
      });

      const task5 = TaskManager.createNewTask(build.id, {
        title: 'Automated Responsive Test Suite & Accessibility Verification',
        description: 'Verify accessibility attributes, component props, and responsive viewport sizing',
        filePaths: ['tests/landing.test.ts'],
        priority: 3,
        dependencies: [task2.id, task3.id],
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'qa_testing_specialist',
        milestone: m3
      });

      const task6 = TaskManager.createNewTask(build.id, {
        title: 'Lead Capture Form Sanitization & Security Validation',
        description: 'Implement input validation for contact inquiries and secure submission handling',
        filePaths: ['src/components/ContactForm.tsx'],
        priority: 3,
        dependencies: [task2.id],
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'security_specialist',
        milestone: m3
      });

      TaskManager.createNewTask(build.id, {
        title: 'Prepare Dockerfile & GitHub Actions CI Workflow',
        description: 'Create multi-stage Dockerfile and GitHub Actions workflow',
        filePaths: ['Dockerfile', '.github/workflows/ci.yml'],
        priority: 4,
        dependencies: [task5.id],
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'devops_release_specialist',
        milestone: m4
      });

      if (build.milestones) {
        build.milestones[0].taskIds.push(task1.id);
        build.milestones[1].taskIds.push(task2.id, task3.id, task4.id, taskEntry.id);
        build.milestones[2].taskIds.push(task5.id, task6.id);
      }
      return;
    }

    // Default Fullstack / SaaS
    const task1 = TaskManager.createNewTask(build.id, {
      title: 'Architect Domain Data Types & Contracts',
      description: `Define TypeScript types and domain interfaces for: ${build.idea}`,
      filePaths: ['src/types/domain.ts'],
      priority: 2,
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'software_architect',
      milestone: m1
    });

    const task2 = TaskManager.createNewTask(build.id, {
      title: 'Develop Backend Core Engine & APIs',
      description: `Implement core computational business logic and processors for: ${build.idea}`,
      filePaths: ['src/core/engine.ts'],
      priority: 2,
      dependencies: [task1.id],
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'backend_developer',
      milestone: m2
    });

    const task3 = TaskManager.createNewTask(build.id, {
      title: 'Implement Database Store & Persistence',
      description: 'Implement transactional storage, queries, and entity relations',
      filePaths: ['src/services/store.ts'],
      priority: 3,
      dependencies: [task1.id],
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'database_specialist',
      milestone: m2
    });

    const task4 = TaskManager.createNewTask(build.id, {
      title: 'Build Frontend User Interface View',
      description: `Implement responsive view components with loading/error states for: ${build.idea}`,
      filePaths: ['src/components/MainView.tsx'],
      priority: 3,
      dependencies: [task1.id],
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'frontend_developer',
      milestone: m2
    });

    const taskEntry = TaskManager.createNewTask(build.id, {
      title: 'Integrate Fullstack Application Entry Point & Interactive View State',
      description: `Unify backend engine, client state store, and UI components into interactive runnable root src/App.tsx for: ${build.idea}`,
      filePaths: ['src/App.tsx'],
      priority: 2,
      dependencies: [task1.id, task4.id],
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'fullstack_developer',
      milestone: m2
    });

    const task5 = TaskManager.createNewTask(build.id, {
      title: 'Create Automated Test Suite & Assertions',
      description: 'Write unit tests validating core functionality, edge cases, and error boundaries',
      filePaths: ['tests/engine.test.ts'],
      priority: 3,
      dependencies: [task2.id, task3.id],
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'qa_testing_specialist',
      milestone: m3
    });

    const task6 = TaskManager.createNewTask(build.id, {
      title: 'Security Hardening & Input Sanitization',
      description: 'Implement input validation guards, secret safety checks, and secure headers',
      filePaths: ['src/core/security.ts'],
      priority: 3,
      dependencies: [task2.id],
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'security_specialist',
      milestone: m3
    });

    TaskManager.createNewTask(build.id, {
      title: 'Prepare Dockerfile & GitHub Actions CI Workflow',
      description: 'Create multi-stage Dockerfile and GitHub Actions workflow for automated testing and builds',
      filePaths: ['Dockerfile', '.github/workflows/ci.yml'],
      priority: 4,
      dependencies: [task5.id],
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'devops_release_specialist',
      milestone: m4
    });

    if (build.milestones) {
      build.milestones[0].taskIds.push(task1.id);
      build.milestones[1].taskIds.push(task2.id, task3.id, task4.id, taskEntry.id);
      build.milestones[2].taskIds.push(task5.id, task6.id);
    }
  }

  /**
   * INDEPENDENT MODEL WORKER LOOP
   * Each model loops continuously in parallel until project completes
   */
  private static async runModelWorkerLoop(
    buildId: string, 
    model: ModelConfig, 
    control: ActiveSwarmControl
  ): Promise<void> {
    const startTime = Date.now();
    let consecutiveIdleCount = 0;

    while (!control.stopRequested) {
      const build = db.getBuild(buildId);
      if (!build || build.status !== 'running') break;

      // Check warning threshold: 80% of budget or tokens
      const tokenCeiling = build.tokenBudget || 100000;
      const isNearCostCeiling = build.totalCost >= build.costLimit * 0.8;
      const isNearTokenCeiling = (build.totalTokens || 0) >= tokenCeiling * 0.8;

      if ((isNearCostCeiling || isNearTokenCeiling) && !build.budgetWarningEmitted) {
        build.budgetWarningEmitted = true;
        db.saveBuild(build);
        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: Date.now(),
          type: 'budget_warning',
          details: `Warning threshold reached: 80% of configured budget consumed ($${build.totalCost.toFixed(3)}/$${build.costLimit.toFixed(2)}, ${build.totalTokens}/${tokenCeiling} tokens). Run can be resumed or budget expanded from Usage Dashboard.`
        });
      }

      // Check safety limits: cost, token budget, & time
      if (build.totalCost >= build.costLimit || ((build.totalTokens || 0) >= tokenCeiling && build.tokenBudget)) {
        const reason = build.totalCost >= build.costLimit 
          ? `Cost safety limit reached ($${build.totalCost.toFixed(2)} >= $${build.costLimit.toFixed(2)}).`
          : `Token budget limit reached (${build.totalTokens} >= ${tokenCeiling} tokens).`;

        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: Date.now(),
          type: 'build_stopped',
          details: `${reason} Halting swarm. Increase budget in Usage Dashboard to resume.`
        });
        control.stopRequested = true;
        break;
      }

      if ((Date.now() - startTime) / 1000 > build.maxDurationSeconds) {
        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: Date.now(),
          type: 'build_stopped',
          details: `Time limit exceeded (${build.maxDurationSeconds}s). Halting swarm.`
        });
        control.stopRequested = true;
        break;
      }

      // 1. ATOMICALLY CLAIM ONE OPEN TASK WITH FULFILLED DEPENDENCIES
      db.updateModelRun(buildId, model.id, { status: 'claiming', role: model.agentRole });
      const task = TaskManager.claimTask(buildId, model.id, model.strengths, model.agentRole);

      if (!task) {
        consecutiveIdleCount++;
        db.updateModelRun(buildId, model.id, { 
          status: 'idle',
          lastActionSummary: 'Waiting for dependent tasks or open board items...'
        });

        // Check completion criteria
        const allTasks = db.getTasks(buildId);
        const incomplete = allTasks.filter(t => t.status === 'pending' || t.status === 'in_progress' || t.status === 'open' || t.status === 'claimed' || t.status === 'retrying');

        if (incomplete.length === 0 && allTasks.length > 0) {
          await this.checkProjectCompletion(buildId, control);
          if (control.stopRequested) break;
        }

        // Delay before polling board again
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 800));
        continue;
      }

      consecutiveIdleCount = 0;
      db.updateModelRun(buildId, model.id, { 
        status: 'working',
        currentTaskId: task.id,
        lastActionSummary: `[${model.agentRole || 'agent'}] Working: ${task.title}`
      });

      // 2. EXECUTE TASK WORK
      try {
        await this.executeTaskWork(buildId, model, task);
      } catch (workErr: any) {
        console.warn(`Worker ${model.id} failed task ${task.id}:`, workErr);
        TaskManager.releaseTask(buildId, task.id, model.id, workErr.message);
      }

      // Update milestone progress
      this.updateMilestoneStatuses(buildId);

      // Automated check trigger after every 5 applied patches
      const currentBuild = db.getBuild(buildId);
      if (currentBuild && currentBuild.patchesAppliedCount > 0 && currentBuild.patchesAppliedCount % 5 === 0) {
        SandboxRunner.runIntegrityCheck(buildId);
      }

      await new Promise(r => setTimeout(r, 250 + Math.random() * 300));
    }

    db.updateModelRun(buildId, model.id, { status: 'done', currentTaskId: null });
  }

  /**
   * Updates milestone completion status dynamically
   */
  private static updateMilestoneStatuses(buildId: string): void {
    const build = db.getBuild(buildId);
    if (!build || !build.milestones) return;

    const allTasks = db.getTasks(buildId);
    let changed = false;

    for (const ms of build.milestones) {
      const msTasks = allTasks.filter(t => ms.taskIds.includes(t.id));
      if (msTasks.length === 0) continue;

      const allDone = msTasks.every(t => t.status === 'completed' || t.status === 'done');
      const anyWorking = msTasks.some(t => t.status === 'in_progress' || t.status === 'testing' || t.status === 'retrying');

      if (allDone && ms.status !== 'completed') {
        ms.status = 'completed';
        changed = true;
        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: Date.now(),
          type: 'milestone_reached',
          details: `Milestone completed: "${ms.title}"`
        });
      } else if (anyWorking && ms.status === 'pending') {
        ms.status = 'in_progress';
        changed = true;
      }
    }

    if (changed) {
      db.saveBuild(build);
    }
  }

  /**
   * Executes work on a claimed task, submits patches, handles retries safely
   */
  private static async executeTaskWork(buildId: string, model: ModelConfig, task: Task): Promise<void> {
    const build = db.getBuild(buildId);
    if (!build) return;

    // Check per-task token budget to prevent runaways
    const taskBudget = task.tokenBudget || 25000;
    if ((task.actualTokensUsed || 0) >= taskBudget) {
      TaskManager.pauseTask(buildId, task.id, `Task token budget reached (${task.actualTokensUsed}/${taskBudget} tokens)`);
      return;
    }

    // Dynamic Context Selection: Selects ONLY target files and outline dependencies
    const allProjectFiles = db.getAllFiles(buildId);
    const filesContextText = tokenOptimizer.selectRelevantFilesContext(
      task.filePaths,
      allProjectFiles,
      2800
    );

    // Compact summary of recent team achievements to prevent repeating work
    const teamProgressSummary = tokenOptimizer.summarizeSwarmHistory(db.getEvents(buildId), 12);

    // Project Intelligence & Memory Context (ADRs, requirements, confirmed facts, active defects)
    const memoryContext = ProjectMemoryService.retrieveTaskContext(buildId, build.userId, task, 1600);

    const roleSpec = model.agentRole ? AGENT_SPECS[model.agentRole] : undefined;
    const roleInstruction = roleSpec ? `YOUR SPECIALIZED ROLE: ${roleSpec.title}\nResponsibilities: ${roleSpec.responsibilities.join('; ')}` : '';

    const prompt = `${roleInstruction}
TASK: ${task.title}
DESCRIPTION: ${task.description}
TARGET FILES: ${task.filePaths.join(', ')}
IS FIX TASK: ${task.isFixTask ? 'YES - Analyze the error and generate exact surgical find/replace fix' : 'NO'}

${memoryContext ? memoryContext + '\n' : ''}
TEAM PROGRESS CONTEXT:
${teamProgressSummary}

RELEVANT SOURCE CODE CONTEXT:
${filesContextText}

Output valid JSON action(s) to accomplish this task.
If creating new files, use "create_file" with complete pristine code.
If updating existing files, use "patch_file" with exact "find" text matching the file content above.
Never write placeholder comments. Implement functional code.`;

    let attempts = 0;
    let taskDone = false;
    let lastError = '';

    const swarmControl = this.activeSwarms.get(buildId);
    const signal = swarmControl?.abortController.signal;

    while (!taskDone && attempts < 3 && !signal?.aborted) {
      attempts++;

      const res = await callUnifiedGateway({
        modelId: model.id,
        task,
        taskComplexity: task.complexity || (task.isFixTask ? 'flagship' : 'standard'),
        prompt,
        systemInstruction: SILENT_WORKER_SYSTEM_PROMPT,
        allowFallback: true,
        buildId,
        userId: build.userId,
        signal
      });

      // Track usage on model and task
      const modelRun = db.getModelRun(buildId, model.id);
      const tokens = (modelRun?.tokensUsed || 0) + res.tokensUsed;
      const cost = (modelRun?.estimatedCost || 0) + (res.estimatedCost || (res.tokensUsed * 0.000003));
      db.updateModelRun(buildId, model.id, {
        tokensUsed: tokens,
        estimatedCost: cost
      });

      // Update build tokens and costs
      build.totalTokens = (build.totalTokens || 0) + res.tokensUsed;
      build.totalCost = (build.totalCost || 0) + (res.estimatedCost || (res.tokensUsed * 0.000003));
      db.saveBuild(build);

      // Update task token usage
      task.actualTokensUsed = (task.actualTokensUsed || 0) + res.tokensUsed;
      task.estimatedCost = (task.estimatedCost || 0) + (res.estimatedCost || (res.tokensUsed * 0.000003));
      db.updateTask(buildId, task.id, {
        actualTokensUsed: task.actualTokensUsed,
        estimatedCost: task.estimatedCost
      });

      // A response that arrives after Stop must not change the project
      if (signal?.aborted) {
        lastError = 'Build stopped by user';
        break;
      }

      if (!res.success || !res.parsedResponse) {
        lastError = res.error || 'Generation failed: Model produced no valid JSON response';
        db.updateModelRun(buildId, model.id, { 
          status: 'retrying',
          error: lastError,
          lastActionSummary: `Retry ${attempts}/3: ${lastError}`
        });

        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      const parsed = res.parsedResponse;
      if (!Array.isArray(parsed.actions) || parsed.actions.length === 0) {
        lastError = 'Model returned empty actions array';
        db.updateModelRun(buildId, model.id, { status: 'retrying', error: lastError });
        continue;
      }

      // Partition file actions from metadata/task creation actions
      const fileActions = parsed.actions.filter(a => a.action !== 'create_task');
      const taskActions = parsed.actions.filter(a => a.action === 'create_task');

      let allActionsSucceeded = false;
      let appliedCount = 0;

      if (fileActions.length > 0) {
        // Execute all file operations atomically with complete rollback on partial failure
        // Sensitive files wait for the owner, and the rest of the work carries on
        const { ready, held } = ApprovalGateService.splitSensitiveActions(buildId, fileActions);

        // A worker that outlasted its lease must not pause a task another worker now holds
        if (held.length > 0 && !TaskManager.holdsClaim(buildId, task)) return;

        const batchRes = ready.length > 0
          ? await MergeManager.applyBatchActions(buildId, model.id, ready, { signal })
          : { success: true, appliedCount: 0, error: undefined };

        // The task is not finished until the owner decides, so it must not retry or complete
        if (batchRes.success && held.length > 0) {
          if (!TaskManager.holdsClaim(buildId, task)) return;
          this.recordAppliedPatches(buildId, model.id, model.agentRole || 'fullstack_developer', task, ready);
          ApprovalGateService.requestForActions(buildId, build.userId, {
            agent: model.id,
            actions: held,
            taskId: task.id,
            followUpTasks: taskActions
          });
          TaskManager.pauseTask(buildId, task.id, this.AWAITING_APPROVAL);
          return;
        }

        if (batchRes.success) {
          allActionsSucceeded = true;
          appliedCount = batchRes.appliedCount;
          db.updateModelRun(buildId, model.id, {
            patchesApplied: (modelRun?.patchesApplied || 0) + appliedCount
          });

          // Once file changes succeed, process any accompanying task creation actions
          for (const action of taskActions) {
            TaskManager.createNewTask(buildId, {
              title: action.title,
              description: action.description,
              filePaths: action.filePaths,
              dependencies: action.dependencies,
              assignedRole: action.assignedRole,
              priority: action.priority || 3,
              maxRetries: this.MAX_TASK_RETRIES
            });
          }
        } else {
          allActionsSucceeded = false;
          lastError = batchRes.error || 'Batch file operations failed and were reverted';
          db.updateModelRun(buildId, model.id, {
            patchesRejected: (modelRun?.patchesRejected || 0) + 1,
            status: 'retrying'
          });
        }
      } else if (taskActions.length > 0) {
        // Only task actions present
        for (const action of taskActions) {
          TaskManager.createNewTask(buildId, {
            title: action.title,
            description: action.description,
            filePaths: action.filePaths,
            dependencies: action.dependencies,
            assignedRole: action.assignedRole,
            priority: action.priority || 3,
            maxRetries: this.MAX_TASK_RETRIES
          });
        }
        allActionsSucceeded = true;
        appliedCount = taskActions.length;
      } else {
        lastError = 'No valid actions found in model response';
      }

      if (allActionsSucceeded && appliedCount > 0) {
        TaskManager.completeTask(buildId, task.id, model.id);
        taskDone = true;

        // Phase 8: Record applied patch proposals and broadcast progress message
        try {
          this.recordAppliedPatches(buildId, model.id, model.agentRole || 'fullstack_developer', task, fileActions);

          CollaborationManager.sendMessage(buildId, build.userId, {
            sender: model.id,
            senderRole: model.agentRole || 'fullstack_developer',
            messageType: 'progress_report',
            content: `Completed implementation for task "${task.title}": applied ${appliedCount} file modification(s).`,
            relatedTaskId: task.id,
            relatedFiles: task.filePaths
          });
        } catch {
          // Non-blocking collaboration record
        }

        // Synchronize Project Memory: update module graph & resolve defects if fix task
        try {
          const filesNow = db.getAllFiles(buildId);
          ProjectMemoryService.updateModuleRelationships(buildId, build.userId, filesNow);

          if (task.isFixTask) {
            const memory = ProjectMemoryService.getOrInitializeMemory(buildId, build.userId);
            if (memory) {
              const matchingDefects = memory.knownDefects.filter(
                d => !d.resolved && d.filePaths.some(fp => task.filePaths.includes(fp))
              );
              for (const md of matchingDefects) {
                ProjectMemoryService.resolveDefect(buildId, build.userId, md.id);
              }
            }
          }
        } catch (e) {
          // Graceful handling of memory synchronization
        }
      } else {
        // Detect unproductive loop if attempts exhausted and zero edits succeeded
        if (attempts >= 3 && appliedCount === 0 && (task.retryCount || 0) >= 2) {
          TaskManager.pauseTask(buildId, task.id, `Unproductive agent loop: repeated patch rejections on ${task.filePaths.join(', ')} (${lastError})`);
          return;
        }
        await new Promise(r => setTimeout(r, 200));
      }
    }

    if (!taskDone) {
      TaskManager.releaseTask(buildId, task.id, model.id, lastError || 'Max patch attempts exceeded');
    }
  }

  /**
   * Verifier phase: checks that all tasks are done, sandbox passes, and verifier model approves.
   */
  private static async checkProjectCompletion(buildId: string, control: ActiveSwarmControl): Promise<void> {
    const build = db.getBuild(buildId);
    if (!build || build.status !== 'running') return;

    const tasks = db.getTasks(buildId);

    // 1. Ensure no pending or in_progress tasks remain
    const incompleteTasks = tasks.filter(t => 
      t.status === 'pending' || 
      t.status === 'in_progress' || 
      t.status === 'open' || 
      t.status === 'claimed' || 
      t.status === 'retrying'
    );
    if (incompleteTasks.length > 0) return;

    // Check if any tasks are paused (e.g. token budget limit or rate limit)
    const pausedTasks = tasks.filter(t => t.status === 'paused' || t.isPaused);
    if (pausedTasks.length > 0) {
      return; // Do not complete project while tasks are paused
    }

    // 2. Check if any tasks failed
    const failedTasks = tasks.filter(t => t.status === 'failed');
    if (failedTasks.length > 0) {
      build.status = 'failed';
      build.completedAt = Date.now();
      build.failureReason = `${failedTasks.length} task(s) failed during execution: ${failedTasks.map(t => t.title).join(', ')}`;
      build.error = build.failureReason;
      db.saveBuild(build);
      control.stopRequested = true;

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'build_failed',
        details: `Build cannot complete: ${build.failureReason}`
      });
      return;
    }

    // 3. Ensure at least one file exists
    const allFiles = db.getAllFiles(buildId);
    if (allFiles.length === 0) {
      build.status = 'failed';
      build.completedAt = Date.now();
      build.failureReason = 'No files were generated for this project.';
      db.saveBuild(build);
      control.stopRequested = true;
      return;
    }

    // 4. Run automated sandbox & test verification
    const sandbox = SandboxRunner.runIntegrityCheck(buildId);
    if (!sandbox.passed) {
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'sandbox_check',
        details: `Integrity check failed with ${sandbox.errors.length} issue(s). Debugging Agent resuming fix tasks.`
      });
      return;
    }

    // 5. Call Objective Verifier Model (Flagship reasoning task)
    build.status = 'verifying';
    build.verificationAttempts = (build.verificationAttempts || 0) + 1;
    const currentAttempt = build.verificationAttempts;
    const maxAttempts = build.maxVerificationAttempts || this.MAX_VERIFICATION_ATTEMPTS;
    db.saveBuild(build);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'verifier_started',
      details: `Launching Verifier Model (Attempt ${currentAttempt}/${maxAttempts}) to evaluate requirements satisfaction.`
    });

    const filesSummary = allFiles.map(f => `- ${f.path} (${f.content.split('\n').length} lines, v${f.version})`).join('\n');

    const verifierPrompt = `VERIFY SOFTWARE COMPLETION
Original User Specification: "${build.idea}"

Generated File Tree:
${filesSummary}

Review whether this software genuinely implements the requirements of the original user idea.
Output ONLY JSON in this exact schema:
{
  "approved": true or false,
  "summary": "Specific evaluation explanation",
  "missingRequirements": ["item 1", "item 2"]
}`;

    const verifyResult = await callUnifiedGateway({
      modelId: 'claude',
      taskComplexity: 'flagship',
      prompt: verifierPrompt,
      systemInstruction: 'You are an objective software verifier. Validate requirement coverage without bias. Output only JSON.',
      allowFallback: true,
      buildId: build.id,
      userId: build.userId,
      signal: this.activeSwarms.get(build.id)?.abortController.signal
    });

    const verifierData = parseVerifierResponse(verifyResult.rawText);

    if (!verifyResult.success || !verifierData) {
      const parseError = verifyResult.error || 'Verifier response was malformed or missing boolean approved field.';
      
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'verifier_rejected',
        details: `Verification attempt ${currentAttempt}/${maxAttempts} failed: ${parseError}`
      });

      if (currentAttempt >= maxAttempts) {
        build.status = 'failed';
        build.completedAt = Date.now();
        build.failureReason = `Verification failed: Unable to obtain valid verification verdict after ${maxAttempts} attempts.`;
        build.error = build.failureReason;
        db.saveBuild(build);
        control.stopRequested = true;
      } else {
        build.status = 'running';
        db.saveBuild(build);
      }
      return;
    }

    if (!verifierData.approved) {
      const missing = verifierData.missingRequirements || [];
      const summary = verifierData.summary || 'Requirements incomplete';

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'verifier_rejected',
        details: `Verification rejected: ${summary}. Missing: ${missing.join(', ') || 'unspecified'}`
      });

      if (currentAttempt >= maxAttempts) {
        build.status = 'failed';
        build.completedAt = Date.now();
        build.failureReason = `Verification rejected after ${maxAttempts} attempts: ${summary}`;
        build.error = build.failureReason;
        build.verificationFeedback = summary;
        db.saveBuild(build);
        control.stopRequested = true;
        return;
      }

      // Create new targeted tasks for missing requirements
      for (const req of missing) {
        const targetFile = allFiles.find(f => f.path.endsWith('.tsx') || f.path.endsWith('.ts'))?.path || 'src/App.tsx';
        if (build.userId) {
          ProjectMemoryService.recordDefect(buildId, build.userId, {
            description: `Missing requirement: ${req}`,
            filePaths: [targetFile],
            severity: 'high'
          });
        }
        TaskManager.createNewTask(buildId, {
          title: `Implement Missing Requirement: ${req.slice(0, 50)}`,
          description: `Verifier indicated requirement is missing or incomplete: ${req}\nAcceptance Criteria: Implement functional code fulfilling "${req}" in ${targetFile}.`,
          filePaths: [targetFile],
          priority: 1,
          isFixTask: true,
          assignedRole: 'debugging_specialist',
          maxRetries: this.MAX_TASK_RETRIES
        });
      }

      build.status = 'running';
      build.verificationFeedback = summary;
      db.saveBuild(build);
      return;
    }

    // 6. Cross-Module Contract & Integration Validation
    const integrationReport = IntegrationAgent.analyzeProjectContracts(buildId);
    if (!integrationReport.passed) {
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'patch_rejected',
        details: `Integration Specialist identified ${integrationReport.issues.length} cross-module import or contract issue(s). Spawning integration repair tasks.`
      });
      build.status = 'running';
      db.saveBuild(build);
      return;
    }

    // 7. Deterministic Verification & Requirements Evidence Evaluation
    const verificationReport = HonestVerificationService.evaluateProjectReadiness(buildId);

    // Reject completion if critical requirements failed or are blocked
    const reqList: RequirementItem[] = Array.isArray(verificationReport.requirementsReport)
      ? verificationReport.requirementsReport
      : (verificationReport.requirementsReport?.items || []);
    const failedRequirements = reqList.filter((r: RequirementItem) => 
      r.status === 'failed' || r.status === 'blocked'
    );

    if (failedRequirements.length > 0) {
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'verifier_rejected',
        details: `Completion rejected: ${failedRequirements.length} requirement(s) failed deterministic verification.`
      });

      if (currentAttempt >= maxAttempts) {
        build.status = 'failed';
        build.completedAt = Date.now();
        build.failureReason = `Verification failed: ${failedRequirements.length} requirement(s) failed verification: ${failedRequirements.map((r: RequirementItem) => r.description.slice(0, 40)).join('; ')}`;
        build.error = build.failureReason;
        db.saveBuild(build);
        control.stopRequested = true;
        return;
      }

      // Spawn targeted fix tasks for failed requirements
      for (const req of failedRequirements) {
        const targetFiles = req.relevantFiles && req.relevantFiles.length > 0
          ? req.relevantFiles
          : (req.satisfiedByFiles && req.satisfiedByFiles.length > 0 ? req.satisfiedByFiles : ['src/App.tsx']);

        if (build.userId) {
          const defectId = ProjectMemoryService.recordDefect(buildId, build.userId, {
            description: `Verification defect: ${req.description}`,
            filePaths: targetFiles,
            severity: 'high'
          });
          if (defectId) {
            ProjectMemoryService.recordRepairAttempt(buildId, build.userId, defectId, 'Spawned deterministic repair task');
          }
        }

        TaskManager.createNewTask(buildId, {
          title: `Fix Requirement: ${req.description.slice(0, 50)}`,
          description: `Deterministic verification failed for: ${req.description}.\nEvidence: ${req.evidence || 'Missing'}\nAcceptance Criteria: Resolve syntax/test defects and verify requirement satisfaction in ${targetFiles.join(', ')}.`,
          filePaths: targetFiles,
          priority: 1,
          isFixTask: true,
          assignedRole: 'debugging_specialist',
          maxRetries: this.MAX_TASK_RETRIES
        });
      }

      build.status = 'running';
      db.saveBuild(build);
      return;
    }

    // 8. Generate Interactive Live Preview Document & persist preview metadata
    try {
      const preview = PreviewGenerator.generateInteractivePreview(build.idea, allFiles, build.projectType || 'fullstack');
      build.livePreviewHtml = preview.html;
      build.previewMode = preview.mode;
      build.previewDiagnostic = preview.diagnosticInfo;
      build.previewRuntimeErrors = preview.runtimeErrors;
      build.previewEntryPoint = preview.entryPoint;
    } catch (prevErr: any) {
      console.warn('Failed to compile preview bundle:', prevErr);
      build.previewMode = 'fallback_preview';
      build.previewDiagnostic = prevErr?.message || 'Preview generation failed';
    }

    // GENUINE SUCCESSFUL APPROVAL
    build.status = 'completed';
    build.completedAt = Date.now();
    build.verificationFeedback = verifierData.summary;
    db.saveBuild(build);
    control.stopRequested = true;

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'verifier_approved',
      details: `Verifier Model approved: "${verifierData.summary}"`
    });

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'build_completed',
      details: `Build Complete! Total files: ${allFiles.length}, total patches: ${build.patchesAppliedCount || 0}, cost: $${(build.totalCost || 0).toFixed(4)}`
    });

    // Auto-push to GitHub feature branch feature/autonomous-development-team if enabled
    if (build.autoPushGithub) {
      await GitHubService.autoPushProject(buildId, build.userId);
    }
  }

  /**
   * Applies a natural language revision to an existing build without rebuilding from scratch
   */
  static async applyRevision(
    buildIdOrBuild: string | Build, 
    revisionPrompt: string
  ): Promise<{ success: boolean; revisionId: string; revision?: ProjectRevision; error?: string }> {
    const build = typeof buildIdOrBuild === 'string' ? db.getBuild(buildIdOrBuild) : buildIdOrBuild;
    if (!build) return { success: false, revisionId: '', error: 'Build not found' };
    const buildId = build.id;

    const cleanPrompt = revisionPrompt.trim();
    if (!cleanPrompt) return { success: false, revisionId: '', error: 'Revision prompt cannot be empty' };

    const revId = `rev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const revisionNumber = (build.revisions?.length || 0) + 1;
    const revision: ProjectRevision = {
      id: revId,
      revisionNumber,
      prompt: cleanPrompt,
      createdAt: Date.now(),
      status: 'in_progress',
      summary: `Revision: "${cleanPrompt.slice(0, 50)}"`,
      tasksGenerated: []
    };

    if (!build.revisions) build.revisions = [];
    build.revisions.push(revision);

    const files = db.getAllFiles(buildId);
    const targetFile = files.find(f => f.path.endsWith('.tsx') || f.path.endsWith('.ts'))?.path || 'src/components/MainView.tsx';

    const revisionTask = TaskManager.createNewTask(buildId, {
      title: `[Revision #${revisionNumber}] ${cleanPrompt.slice(0, 50)}`,
      description: `User requested targeted code modification: ${cleanPrompt}`,
      filePaths: [targetFile],
      priority: 1,
      isFixTask: true,
      assignedRole: 'frontend_developer',
      maxRetries: 3
    });

    revision.tasksGenerated = [revisionTask.id];

    // Synchronize into persistent project memory
    try {
      ProjectMemoryService.recordRevision(buildId, build.userId, revision);
    } catch (err) {
      console.warn(`Failed to synchronize revision into ProjectMemory:`, err);
    }

    build.status = 'running';
    db.saveBuild(build);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'build_started',
      details: `Natural language revision queued: "${cleanPrompt}" (Task: ${revisionTask.title})`
    });

    // Start worker loop if not already running
    if (!this.activeSwarms.has(buildId)) {
      const control: ActiveSwarmControl = {
        stopRequested: false,
        workerCount: 0,
        abortController: new AbortController()
      };
      this.activeSwarms.set(buildId, control);

      const enabledModels = build.selectedModels
        .map(id => modelRegistry.getById(id))
        .filter((m): m is ModelConfig => !!m && m.enabled);

      control.workerCount = enabledModels.length;
      const workerPromises = enabledModels.map(model => 
        this.runModelWorkerLoop(buildId, model, control)
      );

      Promise.all(workerPromises).finally(() => {
        this.activeSwarms.delete(buildId);
        const b = db.getBuild(buildId);
        if (b) {
          const rev = b.revisions?.find(r => r.id === revId);
          if (rev) {
            rev.status = b.status === 'completed' ? 'completed' : 'failed';
            db.saveBuild(b);
          }
        }
      });
    }

    return { success: true, revisionId: revId, revision };
  }
}

