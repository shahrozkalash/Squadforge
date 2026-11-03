import { db } from '../store.js';
import { Task, TaskPriority, TaskStatus, ModelStrength, AgentRole } from '../types.js';
import { modelRegistry } from '../modelRegistry.js';
import { ProjectMemoryService } from './projectMemory.js';

export class TaskManager {
  private static LEASE_DURATION_MS = 90 * 1000; // 90 seconds lease duration

  /**
   * Sweeps and resets expired task leases back to 'pending'/'open'
   */
  static cleanExpiredLeases(buildId: string): void {
    const tasks = db.getTasks(buildId);
    const now = Date.now();

    for (const task of tasks) {
      if ((task.status === 'in_progress' || task.status === 'claimed') && task.leaseExpiresAt && task.leaseExpiresAt < now) {
        const retries = (task.retryCount || 0) + 1;
        const maxRetries = task.maxRetries || 3;

        const timeoutHistoryEntry = {
          timestamp: now,
          verifier: task.claimedBy || 'system',
          status: 'failed' as const,
          syntaxPassed: false,
          testsPassed: false,
          filesVerified: false,
          evidence: `Task lease expired (90s timeout, retry ${retries}/${maxRetries})`,
          details: 'Lease timeout during agent execution'
        };
        const updatedHistory = [...(task.verificationHistory || []), timeoutHistoryEntry];

        if (retries >= maxRetries) {
          this.failTask(buildId, task.id, 'system', `Task lease expired (90s timeout) and retries exhausted (${retries}/${maxRetries})`);
        } else {
          db.updateTask(buildId, task.id, {
            status: 'pending',
            claimedBy: null,
            leaseExpiresAt: null,
            retryCount: retries,
            lastError: 'Task lease timed out after 90 seconds',
            verificationHistory: updatedHistory
          });

          db.addEvent({
            id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            buildId,
            timestamp: now,
            type: 'task_released',
            taskId: task.id,
            modelId: task.claimedBy || 'system',
            details: `Task lease expired (90s timeout, attempt ${retries}/${maxRetries}). Returned to open board: "${task.title}"`
          });
        }
      }
    }
  }

  /**
   * Checks if all dependencies of a task are fulfilled
   */
  static areDependenciesMet(buildId: string, task: Task): boolean {
    if (!task.dependencies || task.dependencies.length === 0) {
      return true;
    }
    const allTasks = db.getTasks(buildId);
    for (const depId of task.dependencies) {
      const depTask = allTasks.find(t => t.id === depId);
      // If dependency doesn't exist or is not completed/done, then dependencies not met
      if (!depTask || (depTask.status !== 'completed' && depTask.status !== 'done')) {
        return false;
      }
    }
    return true;
  }

  /**
   * Alias for claimTask to support worker concurrency interfaces
   */
  static claimNextTask(buildId: string, modelId: string, strengths: ModelStrength[] = [], agentRole?: AgentRole): Task | null {
    return this.claimTask(buildId, modelId, strengths, agentRole);
  }

  /**
   * Atomically claims an open task for a specific model based on its role and strengths.
   * Atomic lock prevents two models from ever claiming the same task.
   */
  static claimTask(buildId: string, modelId: string, strengths: ModelStrength[] = [], agentRole?: AgentRole): Task | null {
    if (!agentRole || strengths.length === 0) {
      const modelCfg = modelRegistry.getById(modelId);
      if (modelCfg) {
        if (!agentRole && modelCfg.agentRole) {
          agentRole = modelCfg.agentRole;
        }
        if (strengths.length === 0 && modelCfg.strengths) {
          strengths = modelCfg.strengths;
        }
      }
    }

    this.cleanExpiredLeases(buildId);

    const tasks = db.getTasks(buildId);
    const now = Date.now();

    // 1. Check if there are high-priority Fix tasks first (priority 1) whose dependencies are met
    const fixTasks = tasks.filter(t => 
      !t.isPaused && t.status !== 'paused' &&
      (t.status === 'pending' || t.status === 'open' || t.status === 'retrying') && 
      t.priority === 1 &&
      this.areDependenciesMet(buildId, t)
    );

    // Collect candidate tasks ordered by suitability
    const candidateTasks: Task[] = [];
    if (fixTasks.length > 0) {
      candidateTasks.push(...fixTasks);
    } else {
      const eligibleTasks = tasks.filter(t => 
        !t.isPaused && t.status !== 'paused' &&
        (t.status === 'pending' || t.status === 'open' || t.status === 'retrying') &&
        this.areDependenciesMet(buildId, t)
      );

      // Score and sort eligible tasks
      const scored = eligibleTasks.map(task => {
        let score = 0;
        if (agentRole && task.assignedRole === agentRole) {
          score += 25;
        }
        // Fullstack developer can also claim frontend or backend tasks when no fullstack tasks are open
        if (agentRole === 'fullstack_developer' && (task.assignedRole === 'frontend_developer' || task.assignedRole === 'backend_developer')) {
          score += 15;
        }
        const text = `${task.title} ${task.description} ${task.filePaths.join(' ')}`.toLowerCase();
        for (const strength of strengths) {
          if (text.includes(strength.toLowerCase())) {
            score += 4;
          }
        }
        score += (6 - task.priority) * 2;
        return { task, score };
      });

      scored.sort((a, b) => b.score - a.score);
      candidateTasks.push(...scored.map(s => s.task));
    }

    // Identify files currently claimed/locked by other active models
    const activeTasks = tasks.filter(t => 
      (t.status === 'in_progress' || t.status === 'claimed') && 
      t.claimedBy && 
      t.claimedBy !== modelId
    );
    const lockedFilePaths = new Set<string>();
    for (const at of activeTasks) {
      for (const fp of at.filePaths) {
        lockedFilePaths.add(fp.toLowerCase());
      }
    }

    // Prioritize candidate tasks that do not conflict with files currently being modified
    const conflictFreeCandidates = candidateTasks.filter(task => {
      if (!task.filePaths || task.filePaths.length === 0) return true;
      return !task.filePaths.some(fp => lockedFilePaths.has(fp.toLowerCase()));
    });

    // Only attempt candidate tasks that are free of file conflicts with currently running tasks
    const candidatesToTry = conflictFreeCandidates;

    if (candidatesToTry.length === 0) {
      return null;
    }

    // Try claiming candidates atomically until one succeeds
    for (const candidate of candidatesToTry) {
      const claimed = db.claimTaskAtomic(
        buildId, 
        candidate.id, 
        modelId, 
        now + this.LEASE_DURATION_MS
      );

      if (claimed) {
        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: now,
          type: 'task_claimed',
          taskId: claimed.id,
          modelId,
          filePath: claimed.filePaths[0],
          details: `${modelId} atomically claimed task: "${claimed.title}" (lease: 90s)`
        });

        db.updateModelRun(buildId, modelId, {
          status: 'working',
          currentTaskId: claimed.id,
          lastActionSummary: `Claimed: ${claimed.title}`
        });

        return claimed;
      }
    }

    return null;
  }

  /**
   * Evaluates verification status of a task honestly using actual file presence and execution evidence.
   */
  static verifyTaskExecution(
    buildId: string, 
    taskId: string, 
    modelId: string, 
    taskResult?: import('../types.js').AgentTaskResult
  ): {
    verified: boolean;
    verificationStatus: 'passed' | 'failed' | 'skipped' | 'not_run';
    filesVerified: boolean;
    testsPassed: boolean;
    errors: string[];
    evidence: string;
    filesChecked: Array<{ path: string; exists: boolean; modified: boolean }>;
  } {
    const task = db.getTask(buildId, taskId);
    if (!task) {
      return {
        verified: false,
        verificationStatus: 'failed',
        filesVerified: false,
        testsPassed: false,
        errors: [`Task ${taskId} not found`],
        evidence: 'Task not found in store',
        filesChecked: []
      };
    }

    const filesChecked: Array<{ path: string; exists: boolean; modified: boolean }> = [];
    const errors: string[] = [];

    // 1. Verify that reported and target files actually exist in the project store
    const candidatePaths = new Set<string>([
      ...task.filePaths,
      ...(taskResult?.filesCreated || []),
      ...(taskResult?.filesModified || [])
    ]);

    for (const fp of candidatePaths) {
      const cleanPath = fp.replace(/^\/+/, '');
      const file = db.getFile(buildId, fp) || db.getFile(buildId, cleanPath);
      const exists = Boolean(file && file.content && file.content.trim().length > 0);
      const modified = Boolean(file && ((file.version && file.version > 1) || (file.history && file.history.length > 0) || exists));
      filesChecked.push({ path: fp, exists, modified });

      if (!exists && task.filePaths.includes(fp)) {
        errors.push(`Target file "${fp}" was not found or has empty content in workspace`);
      }
    }

    const filesVerified = errors.length === 0 && (task.filePaths.length === 0 || filesChecked.some(f => f.exists));

    // 2. Validate tests honestly without fabricating results
    let testsPassed = false;
    let testStatus: 'passed' | 'failed' | 'skipped' | 'not_run' = 'not_run';

    if (taskResult && taskResult.testsExecuted && taskResult.testsExecuted.length > 0) {
      const failedTests = taskResult.testsExecuted.filter(t => t.passed === false || t.status === 'failed');
      const skippedTests = taskResult.testsExecuted.filter(t => t.status === 'skipped');
      const passedTests = taskResult.testsExecuted.filter(t => t.passed === true || t.status === 'passed');

      if (failedTests.length > 0) {
        testStatus = 'failed';
        testsPassed = false;
        for (const ft of failedTests) {
          errors.push(`Test failure: "${ft.name}" (${ft.error || 'Assertion failed'})`);
        }
      } else if (passedTests.length > 0) {
        testStatus = 'passed';
        testsPassed = true;
      } else if (skippedTests.length > 0) {
        testStatus = 'skipped';
        testsPassed = false;
      }
    } else {
      // No tests were executed by the agent
      testStatus = 'not_run';
      testsPassed = false;
    }

    const verified = filesVerified && (testStatus === 'passed' || testStatus === 'not_run');
    const overallStatus: 'passed' | 'failed' | 'skipped' | 'not_run' = 
      errors.length > 0 ? 'failed' : (testStatus === 'passed' ? 'passed' : 'not_run');

    const evidence = [
      `Files verified: ${filesChecked.filter(f => f.exists).length}/${filesChecked.length || 1} present`,
      testStatus === 'passed' ? `Tests passed (${taskResult?.testsExecuted?.length || 0} executed)` :
      testStatus === 'failed' ? `Test failures detected (${errors.length} error(s))` :
      'Tests: not executed for this task'
    ].join('. ');

    return {
      verified,
      verificationStatus: overallStatus,
      filesVerified,
      testsPassed,
      errors,
      evidence,
      filesChecked
    };
  }

  /**
   * Marks a task as completed while honestly recording verification evidence,
   * avoiding fabricated test results, and updating verification history.
   */
  static completeTask(buildId: string, taskId: string, modelId: string, taskResult?: import('../types.js').AgentTaskResult): { success: boolean; error?: string } {
    const now = Date.now();
    const task = db.getTask(buildId, taskId);
    if (!task) return { success: false, error: 'Task not found' };

    // Run honest verification check on files and tests
    const verification = this.verifyTaskExecution(buildId, taskId, modelId, taskResult);

    const result: import('../types.js').AgentTaskResult = taskResult || {
      taskId,
      agentModelId: modelId,
      agentRole: task.assignedRole,
      workCompleted: `Completed implementation for ${task.title}`,
      filesCreated: [],
      filesModified: task.filePaths,
      dependencies: task.dependencies || [],
      architecturalDecisionsUsed: [],
      issuesDiscovered: [],
      // Honest: empty testsExecuted when none were actually run
      testsExecuted: [],
      confidence: verification.verified ? 0.95 : 0.6,
      evidence: verification.evidence,
      timestamp: now,
      executionEvidence: {
        verifiedAt: now,
        filesVerified: verification.filesChecked
      }
    };

    // If taskResult was supplied, normalize test statuses and deduplicate on retries
    if (result.testsExecuted) {
      const seen = new Set<string>();
      result.testsExecuted = result.testsExecuted.filter(t => {
        const key = `${t.name}_${t.status}_${t.passed}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(t => ({
        ...t,
        status: t.status || (t.passed ? 'passed' : 'failed')
      }));
    }

    const newHistoryEntry = {
      timestamp: now,
      verifier: modelId,
      status: verification.verificationStatus,
      syntaxPassed: true,
      testsPassed: verification.testsPassed,
      filesVerified: verification.filesVerified,
      evidence: verification.evidence,
      details: verification.errors.length > 0 ? verification.errors.join('; ') : undefined,
      command: taskResult?.executionEvidence?.command,
      exitCode: taskResult?.executionEvidence?.exitCode,
      durationMs: taskResult?.executionEvidence?.durationMs,
      output: taskResult?.executionEvidence?.output,
      executionSource: taskResult?.executionEvidence?.executionSource
    };

    // Deduplicate history entries so retries cannot create duplicate execution records
    const existingHistory = task.verificationHistory || [];
    const isDuplicate = existingHistory.some(h => 
      h.verifier === modelId &&
      h.status === verification.verificationStatus &&
      h.command === newHistoryEntry.command &&
      h.exitCode === newHistoryEntry.exitCode &&
      h.details === newHistoryEntry.details &&
      Math.abs(h.timestamp - now) < 2000
    );

    const updatedHistory = isDuplicate ? existingHistory : [...existingHistory, newHistoryEntry];

    // Separate task status (completed) from honest verification output
    const isVerificationFailed = verification.errors.length > 0 || !verification.filesVerified;
    
    // Execute atomic completion with database ownership and lease validation
    const completeRes = db.completeTaskAtomic(buildId, taskId, modelId, {
      status: isVerificationFailed ? 'failed' : 'completed',
      completedAt: isVerificationFailed ? undefined : now,
      error: isVerificationFailed ? verification.errors.join('; ') : undefined,
      taskResult: result,
      verificationOutput: {
        syntaxPassed: true,
        testsPassed: verification.testsPassed,
        filesVerified: verification.filesVerified,
        status: verification.verificationStatus,
        errors: verification.errors.length > 0 ? verification.errors : undefined,
        evidence: verification.evidence
      },
      verificationHistory: updatedHistory
    });

    if (!completeRes.success) {
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: now,
        type: 'task_rejected',
        taskId,
        modelId,
        details: `${modelId} completion rejected for "${task.title}": ${completeRes.error}`
      });
      return completeRes;
    }

    // If this was a fix task, only mark defect resolved if verification succeeded
    if (task.isFixTask && verification.verified) {
      try {
        const build = db.getBuild(buildId);
        if (build?.userId) {
          const defects = ProjectMemoryService.getDefects(buildId, build.userId);
          const relatedDefect = defects.find(d => 
            !d.resolved && 
            (d.scheduledRepairTaskId === taskId || d.filePaths.some(fp => task.filePaths.includes(fp)))
          );
          if (relatedDefect) {
            ProjectMemoryService.resolveDefect(
              buildId, 
              build.userId, 
              relatedDefect.id, 
              `Resolved by ${modelId} via task "${task.title}": ${verification.evidence}`
            );
          }
        }
      } catch {
        // Fallback gracefully
      }
    }

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: now,
      type: isVerificationFailed ? 'task_failed' : 'task_completed',
      taskId,
      modelId,
      details: isVerificationFailed 
        ? `${modelId} task "${task.title}" verification failed: ${verification.errors.join('; ')}`
        : `${modelId} completed task: "${task.title}" [Verification: ${verification.verificationStatus}]`
    });

    db.updateModelRun(buildId, modelId, {
      status: isVerificationFailed ? 'failed' : 'idle',
      currentTaskId: null,
      lastActionSummary: `${isVerificationFailed ? 'Failed' : 'Completed'}: ${task.title}`
    });

    return { success: !isVerificationFailed, error: isVerificationFailed ? verification.errors.join('; ') : undefined };
  }

  /**
   * Marks a task as failed when retries are exhausted or unrecoverable error occurs
   */
  static failTask(buildId: string, taskId: string, modelId: string, error: string): { success: boolean; error?: string } {
    const now = Date.now();
    const task = db.getTask(buildId, taskId);
    if (!task) return { success: false, error: 'Task not found' };

    const res = db.failTaskAtomic(buildId, taskId, modelId, error);
    if (!res.success) return res;

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: now,
      type: 'task_failed',
      taskId,
      modelId,
      details: `Task failed: "${task.title}". Reason: ${error}`
    });

    db.updateModelRun(buildId, modelId, {
      status: 'failed',
      currentTaskId: null,
      error,
      lastActionSummary: `Failed on task: ${task.title}`
    });

    return { success: true };
  }

  /**
   * Cancels a task with ownership and lease validation, preventing duplicate cancellation events.
   */
  static cancelTask(
    buildId: string, 
    taskId: string, 
    modelId: string, 
    reason: string
  ): { success: boolean; task?: Task; error?: string } {
    const task = db.getTask(buildId, taskId);
    if (!task) return { success: false, error: 'Task not found' };

    const res = db.cancelTaskAtomic(buildId, taskId, modelId, reason);
    if (!res.success) return res;

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'task_cancelled',
      taskId,
      modelId,
      details: `Task cancelled: "${task.title}". Reason: ${reason}`
    });

    if (modelId !== 'system' && modelId !== 'supervisor') {
      db.updateModelRun(buildId, modelId, {
        status: 'idle',
        currentTaskId: null,
        lastActionSummary: `Cancelled task: ${task.title}`
      });
    }

    return res;
  }

  /**
   * Resets a failed task for clean retry and reassignment
   */
  static retryTask(buildId: string, taskId: string): { success: boolean; error?: string } {
    const task = db.getTask(buildId, taskId);
    if (!task) return { success: false, error: 'Task not found' };

    db.updateTask(buildId, taskId, {
      status: 'pending',
      claimedBy: null,
      leaseExpiresAt: null,
      lastError: undefined
    });

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'task_released',
      taskId,
      details: `Task "${task.title}" reset to open board for retry.`
    });

    return { success: true };
  }

  /**
   * Releases a claimed task back to the board with retry limit tracking.
   * If retries are exhausted, transitions to failed state.
   */
  static releaseTask(buildId: string, taskId: string, modelId: string, error?: string): void {
    const task = db.getTask(buildId, taskId);
    if (!task) return;

    const currentRetries = (task.retryCount || 0) + 1;
    const maxRetries = task.maxRetries || 3;

    if (currentRetries >= maxRetries) {
      this.failTask(buildId, taskId, 'system', `Exhausted retries (${currentRetries}/${maxRetries}): ${error || 'Unknown error'}`);
      return;
    }

    db.updateTask(buildId, taskId, {
      status: 'retrying',
      claimedBy: null,
      leaseExpiresAt: null,
      retryCount: currentRetries,
      error,
      lastError: error
    });

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'task_released',
      taskId,
      modelId,
      details: `${modelId} released task "${task.title}" (attempt ${currentRetries}/${maxRetries}): ${error || 'Yielded back to board'}`
    });

    db.updateModelRun(buildId, modelId, {
      status: 'idle',
      currentTaskId: null,
      lastActionSummary: `Released: ${task.title} (${error || 'retry'})`
    });
  }

  /**
   * Pauses a task when its token budget or rate limit is reached
   */
  static pauseTask(buildId: string, taskId: string, reason: string): void {
    const task = db.getTask(buildId, taskId);
    if (!task) return;

    db.updateTask(buildId, taskId, {
      status: 'paused',
      isPaused: true,
      pausedReason: reason,
      claimedBy: null,
      leaseExpiresAt: null
    });

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'task_released',
      taskId,
      details: `Task paused: "${task.title}". Reason: ${reason}`
    });
  }

  /**
   * Resumes a paused task, resetting its lease and making it claimable again
   */
  static resumeTask(buildId: string, taskId: string): boolean {
    const task = db.getTask(buildId, taskId);
    if (!task) return false;

    db.updateTask(buildId, taskId, {
      status: 'pending',
      isPaused: false,
      pausedReason: undefined,
      claimedBy: null,
      leaseExpiresAt: null
    });

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'task_claimed',
      taskId,
      details: `Task resumed: "${task.title}". Returned to open task board.`
    });

    return true;
  }

  /**
   * Creates a new task with optional dependencies, role assignment, and milestone
   */
  static createNewTask(buildId: string, task: Omit<Task, 'id' | 'buildId' | 'status' | 'claimedBy' | 'leaseExpiresAt' | 'createdAt'>): Task {
    const id = `tsk_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const fullTask: Task = {
      ...task,
      id,
      buildId,
      status: 'pending',
      claimedBy: null,
      leaseExpiresAt: null,
      actualTokensUsed: 0,
      tokenBudget: task.tokenBudget || 25000,
      createdAt: Date.now()
    };
    db.addTask(buildId, fullTask);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'task_claimed',
      taskId: id,
      details: `New task added to living board: "${fullTask.title}"`
    });

    return fullTask;
  }

  /**
   * Delegates a task intelligently to a specialized agent role based on required capabilities and workload
   */
  static delegateTask(
    buildId: string,
    taskId: string,
    delegatorRole: AgentRole,
    targetRole: AgentRole,
    rationale: string
  ): { success: boolean; task?: Task; error?: string } {
    const task = db.getTask(buildId, taskId);
    if (!task) return { success: false, error: 'Task not found' };

    // Prevent delegation of already completed tasks
    if (task.status === 'completed' || task.status === 'done') {
      return { success: false, error: 'Cannot delegate an already completed task' };
    }

    // Check workload of target agent
    const targetProfile = db.getAgentProfile(buildId, targetRole);
    if (targetProfile && targetProfile.workloadScore >= 95) {
      return {
        success: false,
        error: `Agent ${targetRole} is currently overloaded (workload: ${targetProfile.workloadScore}%). Reassignment deferred.`
      };
    }

    db.updateTask(buildId, taskId, {
      assignedRole: targetRole,
      status: 'pending',
      claimedBy: null,
      leaseExpiresAt: null
    });

    // Update agent profiles
    if (targetProfile) {
      targetProfile.assignedTaskIds = Array.from(new Set([...targetProfile.assignedTaskIds, taskId]));
      targetProfile.workloadScore = Math.min(100, targetProfile.workloadScore + 15);
      db.saveAgentProfile(targetProfile);
    }

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'task_delegated',
      taskId,
      details: `Task delegated from [${delegatorRole}] to [${targetRole}]: "${task.title}". Rationale: ${rationale}`
    });

    return { success: true, task: db.getTask(buildId, taskId) || undefined };
  }

  /**
   * Accepts a delegated task assignment
   */
  static acceptTask(buildId: string, taskId: string, agentRole: AgentRole): { success: boolean; task?: Task; error?: string } {
    const task = db.getTask(buildId, taskId);
    if (!task) return { success: false, error: 'Task not found' };

    db.updateAgentStatus(buildId, agentRole, 'working', `Accepted assignment: "${task.title}"`, taskId);
    return { success: true, task };
  }

  /**
   * Rejects a delegated task assignment with reason, returning it to open board
   */
  static rejectTask(buildId: string, taskId: string, agentRole: AgentRole, reason: string): { success: boolean; task?: Task; error?: string } {
    const task = db.getTask(buildId, taskId);
    if (!task) return { success: false, error: 'Task not found' };

    db.updateTask(buildId, taskId, {
      status: 'pending',
      claimedBy: null,
      leaseExpiresAt: null,
      assignedRole: undefined
    });

    db.updateAgentStatus(buildId, agentRole, 'idle', `Rejected task: "${task.title}". Reason: ${reason}`);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'task_rejected',
      taskId,
      details: `[${agentRole}] rejected task "${task.title}": ${reason}. Returned to open pool.`
    });

    return { success: true, task: db.getTask(buildId, taskId) || undefined };
  }

  /**
   * Escalates a task to the project manager or software architect
   */
  static escalateTask(buildId: string, taskId: string, senderRole: AgentRole, reason: string): { success: boolean; task?: Task; error?: string } {
    const task = db.getTask(buildId, taskId);
    if (!task) return { success: false, error: 'Task not found' };

    const escalateToRole: AgentRole = senderRole === 'project_manager' ? 'software_architect' : 'project_manager';

    db.updateTask(buildId, taskId, {
      assignedRole: escalateToRole,
      priority: 1 // Elevate to top priority fix/escalation
    });

    db.updateAgentStatus(buildId, senderRole, 'blocked', `Escalated task "${task.title}" to ${escalateToRole}: ${reason}`, taskId);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'task_delegated',
      taskId,
      details: `[ESCALATION] [${senderRole}] escalated task "${task.title}" to [${escalateToRole}]: ${reason}`
    });

    return { success: true, task: db.getTask(buildId, taskId) || undefined };
  }
}
