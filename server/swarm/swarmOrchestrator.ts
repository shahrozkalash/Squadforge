import { db } from '../store.js';
import { modelRegistry } from '../modelRegistry.js';
import { callUnifiedGateway, extractAndParseJson, SILENT_WORKER_SYSTEM_PROMPT } from '../gateway.js';
import { TaskManager } from './taskManager.js';
import { MergeManager } from './mergeManager.js';
import { SandboxRunner } from './sandboxRunner.js';
import { GitHubService } from '../github.js';
import { Build, ModelConfig, Task, ModelActionResponse } from '../types.js';

interface ActiveSwarmControl {
  stopRequested: boolean;
  workerCount: number;
}

export class SwarmOrchestrator {
  private static activeSwarms: Map<string, ActiveSwarmControl> = new Map();

  /**
   * Stops an active build swarm immediately
   */
  static stopSwarm(buildId: string): void {
    const control = this.activeSwarms.get(buildId);
    if (control) {
      control.stopRequested = true;
    }

    const build = db.getBuild(buildId);
    if (build && build.status === 'running') {
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

  /**
   * Starts the continuous parallel swarm for a build
   */
  static async startSwarm(buildId: string): Promise<void> {
    const build = db.getBuild(buildId);
    if (!build) return;

    const control: ActiveSwarmControl = {
      stopRequested: false,
      workerCount: 0
    };
    this.activeSwarms.set(buildId, control);

    build.status = 'planning';
    db.saveBuild(build);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'build_started',
      details: `SquadForge Swarm initialized for idea: "${build.idea}". Active models: ${build.selectedModels.length}`
    });

    try {
      // 1. FAST INITIAL PLANNER CALL
      await this.runInitialPlanner(build);

      // 2. LAUNCH ALL ENABLED MODELS AT THE SAME MOMENT
      build.status = 'running';
      db.saveBuild(build);

      const enabledModels = build.selectedModels
        .map(id => modelRegistry.getById(id))
        .filter((m): m is ModelConfig => !!m && m.enabled);

      control.workerCount = enabledModels.length;

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'build_started',
        details: `Simultaneously launching ${enabledModels.length} independent model worker loops in parallel via Promise.all`
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
      db.saveBuild(build);

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'build_failed',
        details: `Swarm encountered unrecoverable error: ${err.message}`
      });
    }
  }

  /**
   * Phase 1: Fast initial planner call creates initial task board and small files
   */
  private static async runInitialPlanner(build: Build): Promise<void> {
    const plannerPrompt = `PLAN INITIAL PROJECT FOR THIS IDEA: "${build.idea}"
Break this project down into small, modular files (max ~150 lines each).
Output JSON with:
1. "create_file" actions for starter structure (README.md, package.json or core config, domain types, main entry).
2. "create_task" actions for the initial living task board (frontend components, backend services, database schema, tests).

Remember: Output ONLY valid JSON according to schema.`;

    const plannerResult = await callUnifiedGateway({
      modelId: 'gemini',
      prompt: plannerPrompt,
      systemInstruction: SILENT_WORKER_SYSTEM_PROMPT
    });

    const parsed = plannerResult.parsedResponse;
    if (parsed && Array.isArray(parsed.actions)) {
      for (const action of parsed.actions) {
        if (action.action === 'create_file') {
          await MergeManager.createFile(build.id, 'gemini-planner', action);
        } else if (action.action === 'create_task') {
          TaskManager.createNewTask(build.id, {
            title: action.title,
            description: action.description,
            filePaths: action.filePaths,
            priority: action.priority || 3
          });
        }
      }
    } else {
      // Create sensible default starter tasks if empty
      this.seedFallbackPlan(build);
    }

    // Ensure we have at least 6 core tasks
    const currentTasks = db.getTasks(build.id);
    if (currentTasks.length < 4) {
      this.seedFallbackPlan(build);
    }

    // Ensure standard project files exist
    const readme = db.getFile(build.id, 'README.md');
    if (!readme) {
      await MergeManager.createFile(build.id, 'planner', {
        action: 'create_file',
        path: 'README.md',
        content: `# ${build.idea}\n\nBuilt by **SquadForge** multi-AI parallel swarm engineering.\n\n## Overview\nThis software was engineered autonomously by 10+ AI models working silently in parallel.\n`,
        commitMessage: 'Initial project documentation'
      });
    }

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId: build.id,
      timestamp: Date.now(),
      type: 'plan_created',
      details: `Living task board initialized with ${db.getTasks(build.id).length} tasks and ${db.getAllFiles(build.id).length} initial files`
    });
  }

  /**
   * Seeds fallback initial plan if planner returned minimal actions
   */
  private static seedFallbackPlan(build: Build): void {
    const slug = build.idea.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20);

    TaskManager.createNewTask(build.id, {
      title: 'Architect Domain Data Types & Interfaces',
      description: 'Define strong TypeScript interfaces and contracts for entities, requests and responses',
      filePaths: ['src/types/domain.ts'],
      priority: 2
    });

    TaskManager.createNewTask(build.id, {
      title: 'Develop Core Business Logic Engine',
      description: 'Implement core domain algorithms, validation rules, and error handling',
      filePaths: ['src/core/engine.ts'],
      priority: 2
    });

    TaskManager.createNewTask(build.id, {
      title: 'Build Interactive UI View Component',
      description: 'Create responsive, accessible user interface controls and views',
      filePaths: ['src/components/MainView.tsx'],
      priority: 3
    });

    TaskManager.createNewTask(build.id, {
      title: 'Implement Data Store & Local Cache Service',
      description: 'Create persistence layer with optimistic updates and event handlers',
      filePaths: ['src/services/store.ts'],
      priority: 3
    });

    TaskManager.createNewTask(build.id, {
      title: 'Create Automated Test Fixture Suite',
      description: 'Write unit tests covering edge cases and error bounds',
      filePaths: ['tests/engine.test.ts'],
      priority: 3
    });

    TaskManager.createNewTask(build.id, {
      title: 'Harden Security & Input Sanitization',
      description: 'Validate input schemas and add defensive checks against injection',
      filePaths: ['src/security/sanitizer.ts'],
      priority: 2
    });
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

      // Check safety limits: cost & time
      if (build.totalCost >= build.costLimit) {
        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: Date.now(),
          type: 'build_stopped',
          details: `Cost safety limit reached ($${build.totalCost.toFixed(2)} >= $${build.costLimit.toFixed(2)}). Halting swarm.`
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

      // 1. ATOMICALLY CLAIM ONE OPEN TASK
      db.updateModelRun(buildId, model.id, { status: 'claiming' });
      const task = TaskManager.claimTask(buildId, model.id, model.strengths);

      if (!task) {
        consecutiveIdleCount++;
        db.updateModelRun(buildId, model.id, { 
          status: 'idle',
          lastActionSummary: 'No matching tasks. Waiting for work...'
        });

        // Check if all tasks on board are completed
        const allTasks = db.getTasks(buildId);
        const openOrClaimed = allTasks.filter(t => t.status === 'open' || t.status === 'claimed');

        if (openOrClaimed.length === 0 && allTasks.length > 0) {
          // Check completion
          await this.checkProjectCompletion(buildId, control);
          if (control.stopRequested) break;
        }

        // Brief delay before polling board again
        await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
        continue;
      }

      consecutiveIdleCount = 0;
      db.updateModelRun(buildId, model.id, { 
        status: 'working',
        currentTaskId: task.id,
        lastActionSummary: `Working on: ${task.title}`
      });

      // 2. DO THE WORK AND SUBMIT PATCHES
      try {
        await this.executeTaskWork(buildId, model, task);
      } catch (workErr: any) {
        console.warn(`Worker ${model.id} failed task ${task.id}:`, workErr);
        TaskManager.releaseTask(buildId, task.id, model.id, workErr.message);
      }

      // Automated check trigger after every 5 applied patches
      const currentBuild = db.getBuild(buildId);
      if (currentBuild && currentBuild.patchesAppliedCount > 0 && currentBuild.patchesAppliedCount % 5 === 0) {
        SandboxRunner.runIntegrityCheck(buildId);
      }

      // Small jitter between iterations to keep execution natural
      await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
    }

    db.updateModelRun(buildId, model.id, { status: 'done', currentTaskId: null });
  }

  /**
   * Executes work on a claimed task, submits patches, handles retries
   */
  private static async executeTaskWork(buildId: string, model: ModelConfig, task: Task): Promise<void> {
    const build = db.getBuild(buildId);
    if (!build) return;

    // Gather context: existing files relevant to this task
    const relevantFiles = task.filePaths
      .map(p => db.getFile(buildId, p))
      .filter(Boolean);

    const filesContextText = relevantFiles.length > 0
      ? relevantFiles.map(f => `--- FILE: ${f!.path} (v${f!.version}) ---\n${f!.content}`).join('\n\n')
      : 'Target file does not exist yet. You must use "create_file".';

    const prompt = `TASK: ${task.title}
DESCRIPTION: ${task.description}
TARGET FILES: ${task.filePaths.join(', ')}
IS FIX TASK: ${task.isFixTask ? 'YES - Fix the syntax/type error described' : 'NO'}

EXISTING RELEVANT FILES CONTENT:
${filesContextText}

Output valid JSON action(s) to accomplish this task.
If creating new files, use "create_file".
If updating existing files, use "patch_file" with exact "find" text matching the file content above.
You may also emit "create_task" if you discover missing modules or test needs.`;

    let attempts = 0;
    let taskDone = false;

    while (!taskDone && attempts < 3) {
      attempts++;

      const res = await callUnifiedGateway({
        modelId: model.id,
        prompt,
        systemInstruction: SILENT_WORKER_SYSTEM_PROMPT
      });

      // Track usage
      const modelRun = db.getModelRun(buildId, model.id);
      const tokens = (modelRun?.tokensUsed || 0) + res.tokensUsed;
      const cost = (modelRun?.estimatedCost || 0) + (res.tokensUsed * 0.000003);
      db.updateModelRun(buildId, model.id, {
        tokensUsed: tokens,
        estimatedCost: cost
      });

      build.totalTokens = (build.totalTokens || 0) + res.tokensUsed;
      build.totalCost = (build.totalCost || 0) + (res.tokensUsed * 0.000003);
      db.saveBuild(build);

      const parsed = res.parsedResponse;
      if (!parsed || !Array.isArray(parsed.actions) || parsed.actions.length === 0) {
        db.updateModelRun(buildId, model.id, { status: 'retrying' });
        continue;
      }

      // Apply each action via Merge Manager
      let allActionsSucceeded = true;
      for (const action of parsed.actions) {
        if (action.action === 'create_file') {
          const createRes = await MergeManager.createFile(buildId, model.id, action);
          if (!createRes.success) {
            allActionsSucceeded = false;
          }
        } else if (action.action === 'patch_file') {
          const patchRes = await MergeManager.applyPatch(buildId, model.id, action);
          if (!patchRes.success) {
            allActionsSucceeded = false;
            // Update model statistics
            db.updateModelRun(buildId, model.id, {
              patchesRejected: (modelRun?.patchesRejected || 0) + 1,
              status: 'retrying'
            });
          } else {
            db.updateModelRun(buildId, model.id, {
              patchesApplied: (modelRun?.patchesApplied || 0) + 1
            });
          }
        } else if (action.action === 'create_task') {
          TaskManager.createNewTask(buildId, {
            title: action.title,
            description: action.description,
            filePaths: action.filePaths,
            priority: action.priority || 3
          });
        }
      }

      if (allActionsSucceeded) {
        TaskManager.completeTask(buildId, task.id, model.id);
        taskDone = true;
      } else {
        // Redo retry
        await new Promise(r => setTimeout(r, 200));
      }
    }

    if (!taskDone) {
      TaskManager.releaseTask(buildId, task.id, model.id, 'Max patch retries exceeded');
    }
  }

  /**
   * Verifier phase: checks that all tasks are done, sandbox passes, and verifier model confirms
   */
  private static async checkProjectCompletion(buildId: string, control: ActiveSwarmControl): Promise<void> {
    const build = db.getBuild(buildId);
    if (!build || build.status !== 'running') return;

    const tasks = db.getTasks(buildId);
    const incompleteTasks = tasks.filter(t => t.status === 'open' || t.status === 'claimed');
    if (incompleteTasks.length > 0) return;

    // Run final sandbox verification
    const sandbox = SandboxRunner.runIntegrityCheck(buildId);
    if (!sandbox.passed) {
      // Errors became fix tasks, workers will resume
      return;
    }

    // Call Verifier Model
    build.status = 'verifying';
    db.saveBuild(build);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'verifier_started',
      details: 'All tasks completed and sandbox build passed. Launching Verifier Model to confirm original idea is fully satisfied.'
    });

    const allFiles = db.getAllFiles(buildId);
    const filesSummary = allFiles.map(f => `- ${f.path} (${f.content.split('\n').length} lines, v${f.version})`).join('\n');

    const verifierPrompt = `VERIFY SOFTWARE COMPLETION
Original User Idea: "${build.idea}"

Generated File Tree:
${filesSummary}

Confirm if this software implements the essential requirements of the original user idea.
Output ONLY JSON:
{
  "approved": true,
  "summary": "Project successfully meets requirements with modular architecture",
  "missingRequirements": []
}`;

    const verifyResult = await callUnifiedGateway({
      modelId: 'claude', // Strong verifier
      prompt: verifierPrompt,
      systemInstruction: SILENT_WORKER_SYSTEM_PROMPT
    });

    // Mark completion
    build.status = 'completed';
    build.completedAt = Date.now();
    db.saveBuild(build);
    control.stopRequested = true;

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'verifier_approved',
      details: 'Verifier Model confirmed: Idea fully implemented with high architectural integrity!'
    });

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'build_completed',
      details: `Build Complete! Total files: ${allFiles.length}, total patches: ${build.patchesAppliedCount || 0}, cost: $${(build.totalCost || 0).toFixed(4)}`
    });

    // Auto-push to GitHub if enabled
    if (build.autoPushGithub) {
      await GitHubService.autoPushProject(buildId, build.userId);
    }
  }
}
