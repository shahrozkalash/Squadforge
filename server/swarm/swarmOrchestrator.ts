import { db } from '../store.js';
import { modelRegistry } from '../modelRegistry.js';
import { 
  callUnifiedGateway, 
  parseVerifierResponse, 
  SILENT_WORKER_SYSTEM_PROMPT 
} from '../gateway.js';
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
  private static MAX_VERIFICATION_ATTEMPTS = 3;
  private static MAX_TASK_RETRIES = 3;

  /**
   * Stops an active build swarm immediately
   */
  static stopSwarm(buildId: string): void {
    const control = this.activeSwarms.get(buildId);
    if (control) {
      control.stopRequested = true;
    }

    const build = db.getBuild(buildId);
    if (build && (build.status === 'running' || build.status === 'planning' || build.status === 'verifying')) {
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
    build.maxVerificationAttempts = this.MAX_VERIFICATION_ATTEMPTS;
    build.verificationAttempts = 0;
    db.saveBuild(build);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'build_started',
      details: `SquadForge Swarm initialized for idea: "${build.idea}". Active models: ${build.selectedModels.length}`
    });

    try {
      // 1. INITIAL PLANNER CALL
      const planSuccess = await this.runInitialPlanner(build);
      if (!planSuccess) {
        throw new Error('Initial project planning failed. Could not generate valid task breakdown.');
      }

      // 2. LAUNCH ALL ENABLED MODELS CONCURRENTLY
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
      build.failureReason = err.message || 'Swarm execution failure';
      build.completedAt = Date.now();
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
   * Phase 1: Initial planner call creates initial task board and starter files
   */
  private static async runInitialPlanner(build: Build): Promise<boolean> {
    const plannerPrompt = `PLAN INITIAL PROJECT FOR THIS IDEA: "${build.idea}"
Break this project down into small, modular files (max ~150 lines each).
Output JSON with:
1. "create_file" actions for starter structure (README.md, package.json or core config, domain types, main entry).
2. "create_task" actions for the initial living task board (frontend components, backend services, database schema, tests).

Remember: Output ONLY valid JSON according to schema.`;

    const plannerResult = await callUnifiedGateway({
      modelId: 'gemini',
      prompt: plannerPrompt,
      systemInstruction: SILENT_WORKER_SYSTEM_PROMPT,
      allowFallback: true
    });

    if (!plannerResult.success || !plannerResult.parsedResponse) {
      // If AI planner call failed, log failure and seed structured domain plan directly from idea
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId: build.id,
        timestamp: Date.now(),
        type: 'plan_created',
        details: `Planner AI unavailable (${plannerResult.error || 'no response'}). Initializing architectural task matrix.`
      });
      this.seedFallbackPlan(build);
    } else {
      for (const action of plannerResult.parsedResponse.actions) {
        if (action.action === 'create_file') {
          await MergeManager.createFile(build.id, 'gemini-planner', action);
        } else if (action.action === 'create_task') {
          TaskManager.createNewTask(build.id, {
            title: action.title,
            description: action.description,
            filePaths: action.filePaths,
            priority: action.priority || 3,
            maxRetries: this.MAX_TASK_RETRIES
          });
        }
      }
    }

    // Ensure we have sufficient tasks on board
    const currentTasks = db.getTasks(build.id);
    if (currentTasks.length < 3) {
      this.seedFallbackPlan(build);
    }

    // Ensure README.md exists
    const readme = db.getFile(build.id, 'README.md');
    if (!readme) {
      await MergeManager.createFile(build.id, 'planner', {
        action: 'create_file',
        path: 'README.md',
        content: `# ${build.idea}\n\nBuilt by **SquadForge** multi-AI parallel swarm engineering.\n\n## Overview\nThis software is engineered autonomously by models working in parallel with conflict-free merges.\n`,
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

    return true;
  }

  /**
   * Seeds clean initial plan when AI planner call is unavailable
   */
  private static seedFallbackPlan(build: Build): void {
    TaskManager.createNewTask(build.id, {
      title: 'Architect Domain Data Types & Contracts',
      description: `Define TypeScript types and domain interfaces for: ${build.idea}`,
      filePaths: ['src/types/domain.ts'],
      priority: 2,
      maxRetries: this.MAX_TASK_RETRIES
    });

    TaskManager.createNewTask(build.id, {
      title: 'Develop Core Domain Engine',
      description: `Implement core computational business logic and processors for: ${build.idea}`,
      filePaths: ['src/core/engine.ts'],
      priority: 2,
      maxRetries: this.MAX_TASK_RETRIES
    });

    TaskManager.createNewTask(build.id, {
      title: 'Build UI View Component',
      description: `Implement interactive view rendering for: ${build.idea}`,
      filePaths: ['src/components/MainView.tsx'],
      priority: 3,
      maxRetries: this.MAX_TASK_RETRIES
    });

    TaskManager.createNewTask(build.id, {
      title: 'Implement Data Store & Persistence Service',
      description: 'Implement storage, queries, and state management service',
      filePaths: ['src/services/store.ts'],
      priority: 3,
      maxRetries: this.MAX_TASK_RETRIES
    });

    TaskManager.createNewTask(build.id, {
      title: 'Create Automated Test Suite',
      description: 'Write unit tests validating core functionality and error boundaries',
      filePaths: ['tests/engine.test.ts'],
      priority: 3,
      maxRetries: this.MAX_TASK_RETRIES
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
          lastActionSummary: 'No matching open tasks. Waiting...'
        });

        // Check completion criteria
        const allTasks = db.getTasks(buildId);
        const openOrClaimed = allTasks.filter(t => t.status === 'open' || t.status === 'claimed');

        if (openOrClaimed.length === 0 && allTasks.length > 0) {
          await this.checkProjectCompletion(buildId, control);
          if (control.stopRequested) break;
        }

        // Delay before polling board again
        await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
        continue;
      }

      consecutiveIdleCount = 0;
      db.updateModelRun(buildId, model.id, { 
        status: 'working',
        currentTaskId: task.id,
        lastActionSummary: `Working on: ${task.title}`
      });

      // 2. EXECUTE TASK WORK
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

      await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
    }

    db.updateModelRun(buildId, model.id, { status: 'done', currentTaskId: null });
  }

  /**
   * Executes work on a claimed task, submits patches, handles retries safely
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
    let lastError = '';

    while (!taskDone && attempts < 3) {
      attempts++;

      const res = await callUnifiedGateway({
        modelId: model.id,
        prompt,
        systemInstruction: SILENT_WORKER_SYSTEM_PROMPT,
        allowFallback: true
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

      // If gateway call failed, record failure accurately
      if (!res.success || !res.parsedResponse) {
        lastError = res.error || 'Generation failed: Model produced no valid JSON response';
        db.updateModelRun(buildId, model.id, { 
          status: 'retrying',
          error: lastError,
          lastActionSummary: `Retry ${attempts}/3: ${lastError}`
        });

        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: Date.now(),
          type: 'patch_rejected',
          modelId: model.id,
          taskId: task.id,
          details: `Generation failed for ${model.id} on task "${task.title}": ${lastError}`
        });

        await new Promise(r => setTimeout(r, 400));
        continue;
      }

      const parsed = res.parsedResponse;
      if (!Array.isArray(parsed.actions) || parsed.actions.length === 0) {
        lastError = 'Model returned empty actions array';
        db.updateModelRun(buildId, model.id, { status: 'retrying', error: lastError });
        continue;
      }

      // Apply each action via Merge Manager
      let allActionsSucceeded = true;
      let appliedCount = 0;

      for (const action of parsed.actions) {
        if (action.action === 'create_file') {
          const createRes = await MergeManager.createFile(buildId, model.id, action);
          if (!createRes.success) {
            allActionsSucceeded = false;
            lastError = createRes.error || 'create_file failed';
          } else {
            appliedCount++;
          }
        } else if (action.action === 'patch_file') {
          const patchRes = await MergeManager.applyPatch(buildId, model.id, action);
          if (!patchRes.success) {
            allActionsSucceeded = false;
            lastError = patchRes.error || 'patch_file failed';
            db.updateModelRun(buildId, model.id, {
              patchesRejected: (modelRun?.patchesRejected || 0) + 1,
              status: 'retrying'
            });
          } else {
            appliedCount++;
            db.updateModelRun(buildId, model.id, {
              patchesApplied: (modelRun?.patchesApplied || 0) + 1
            });
          }
        } else if (action.action === 'create_task') {
          TaskManager.createNewTask(buildId, {
            title: action.title,
            description: action.description,
            filePaths: action.filePaths,
            priority: action.priority || 3,
            maxRetries: this.MAX_TASK_RETRIES
          });
        }
      }

      if (allActionsSucceeded && appliedCount > 0) {
        TaskManager.completeTask(buildId, task.id, model.id);
        taskDone = true;
      } else {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    if (!taskDone) {
      TaskManager.releaseTask(buildId, task.id, model.id, lastError || 'Max patch attempts exceeded');
    }
  }

  /**
   * Verifier phase: checks that all tasks are done, sandbox passes, and verifier model approves.
   * Genuinely validates approval status and avoids false completions.
   */
  private static async checkProjectCompletion(buildId: string, control: ActiveSwarmControl): Promise<void> {
    const build = db.getBuild(buildId);
    if (!build || build.status !== 'running') return;

    const tasks = db.getTasks(buildId);

    // 1. Ensure no open or claimed tasks remain
    const incompleteTasks = tasks.filter(t => t.status === 'open' || t.status === 'claimed');
    if (incompleteTasks.length > 0) return;

    // 2. Check if any tasks have failed
    const failedTasks = tasks.filter(t => t.status === 'failed');
    if (failedTasks.length > 0) {
      // Cannot mark completed if tasks failed
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

    // 4. Run automated sandbox verification
    const sandbox = SandboxRunner.runIntegrityCheck(buildId);
    if (!sandbox.passed) {
      // Sandbox failed; errors became fix tasks on the board
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'sandbox_check',
        details: `Integrity check failed with ${sandbox.errors.length} error(s). Workers resuming fix tasks.`
      });
      return;
    }

    // 5. Call Verifier Model
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
      details: `Launching Verifier Model (Attempt ${currentAttempt}/${maxAttempts}) to validate requirements satisfaction.`
    });

    const filesSummary = allFiles.map(f => `- ${f.path} (${f.content.split('\n').length} lines, v${f.version})`).join('\n');

    const verifierPrompt = `VERIFY SOFTWARE COMPLETION
Original User Idea: "${build.idea}"

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
      prompt: verifierPrompt,
      systemInstruction: 'You are an objective software verifier. Validate requirement coverage without bias. Output only JSON.',
      allowFallback: true
    });

    // Safely parse verifier response
    const verifierData = parseVerifierResponse(verifyResult.rawText);

    // If verifier returned malformed JSON or failed
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
        // Return to running state to retry verification
        build.status = 'running';
        db.saveBuild(build);
      }
      return;
    }

    // Inspect genuine approval verdict
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
        TaskManager.createNewTask(buildId, {
          title: `Implement Missing Requirement: ${req.slice(0, 50)}`,
          description: `Verifier indicated requirement is missing or incomplete: ${req}`,
          filePaths: ['src/core/engine.ts'],
          priority: 1,
          isFixTask: true,
          maxRetries: this.MAX_TASK_RETRIES
        });
      }

      // Resume swarm to address missing requirements
      build.status = 'running';
      build.verificationFeedback = summary;
      db.saveBuild(build);
      return;
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

    // Auto-push to GitHub if enabled
    if (build.autoPushGithub) {
      await GitHubService.autoPushProject(buildId, build.userId);
    }
  }
}
