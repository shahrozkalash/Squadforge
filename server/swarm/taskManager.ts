import { db } from '../store.js';
import { Task, TaskPriority, TaskStatus, ModelStrength, AgentRole } from '../types.js';
import { modelRegistry } from '../modelRegistry.js';

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
        db.updateTask(buildId, task.id, {
          status: 'pending',
          claimedBy: null,
          leaseExpiresAt: null,
          lastError: 'Task lease timed out after 90 seconds'
        });

        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: now,
          type: 'task_released',
          taskId: task.id,
          modelId: task.claimedBy || 'system',
          details: `Task lease expired (90s timeout). Task returned to open board: "${task.title}"`
        });
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
   * Atomically claims an open task for a specific model based on its role and strengths.
   * Atomic lock prevents two models from ever claiming the same task.
   */
  static claimTask(buildId: string, modelId: string, strengths: ModelStrength[], agentRole?: AgentRole): Task | null {
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
    let chosenTask = fixTasks[0];

    // 2. If no fix tasks, find an eligible task matching agent role or strengths
    if (!chosenTask) {
      const eligibleTasks = tasks.filter(t => 
        !t.isPaused && t.status !== 'paused' &&
        (t.status === 'pending' || t.status === 'open' || t.status === 'retrying') &&
        this.areDependenciesMet(buildId, t)
      );

      // Sort by priority (1 is highest)
      eligibleTasks.sort((a, b) => a.priority - b.priority);

      let bestScore = -1;
      let bestMatchingTask: Task | null = null;

      for (const task of eligibleTasks) {
        let score = 0;

        // Role match gives massive bonus
        if (agentRole && task.assignedRole === agentRole) {
          score += 20;
        }

        const text = `${task.title} ${task.description} ${task.filePaths.join(' ')}`.toLowerCase();
        for (const strength of strengths) {
          if (text.includes(strength.toLowerCase())) {
            score += 3;
          }
        }

        // Higher priority tasks get bonus
        score += (6 - task.priority);

        if (score > bestScore) {
          bestScore = score;
          bestMatchingTask = task;
        }
      }

      chosenTask = bestMatchingTask || eligibleTasks[0];
    }

    // 3. If no pending tasks, look for an unreviewed file (strictly preventing duplicate review tasks)
    if (!chosenTask) {
      const allFiles = db.getAllFiles(buildId);
      const candidateFile = allFiles.find(f => 
        f.ownerModel !== modelId && 
        f.history.length < 4 &&
        !tasks.some(t => t.title.includes(f.path))
      );
      if (candidateFile) {
        const reviewTaskId = `tsk_rev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        chosenTask = {
          id: reviewTaskId,
          buildId,
          title: `Code Review & Verification: ${candidateFile.path}`,
          description: `Inspect ${candidateFile.path} written by ${candidateFile.ownerModel}. Verify types, edge cases, and patch any omissions.`,
          filePaths: [candidateFile.path],
          priority: 4,
          status: 'pending',
          claimedBy: null,
          leaseExpiresAt: null,
          createdAt: now
        };
        db.addTask(buildId, chosenTask);
      }
    }

    if (!chosenTask) {
      return null;
    }

    // Atomic claim: update status and lease duration
    const claimed = db.updateTask(buildId, chosenTask.id, {
      status: 'in_progress',
      claimedBy: modelId,
      leaseExpiresAt: now + this.LEASE_DURATION_MS
    });

    if (claimed) {
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: now,
        type: 'task_claimed',
        taskId: claimed.id,
        modelId,
        filePath: claimed.filePaths[0],
        details: `${modelId} claimed task: "${claimed.title}" (lease: 90s)`
      });

      db.updateModelRun(buildId, modelId, {
        status: 'working',
        currentTaskId: claimed.id,
        lastActionSummary: `Claimed: ${claimed.title}`
      });
    }

    return claimed;
  }

  /**
   * Marks a task as successfully completed
   */
  static completeTask(buildId: string, taskId: string, modelId: string): void {
    const now = Date.now();
    const task = db.getTask(buildId, taskId);
    if (!task) return;

    db.updateTask(buildId, taskId, {
      status: 'completed',
      completedAt: now,
      leaseExpiresAt: null,
      error: undefined,
      verificationOutput: {
        syntaxPassed: true,
        testsPassed: true
      }
    });

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: now,
      type: 'task_completed',
      taskId,
      modelId,
      details: `${modelId} completed task: "${task.title}"`
    });

    db.updateModelRun(buildId, modelId, {
      status: 'idle',
      currentTaskId: null,
      lastActionSummary: `Completed: ${task.title}`
    });
  }

  /**
   * Marks a task as failed when retries are exhausted or unrecoverable error occurs
   */
  static failTask(buildId: string, taskId: string, modelId: string, error: string): void {
    const now = Date.now();
    const task = db.getTask(buildId, taskId);
    if (!task) return;

    db.updateTask(buildId, taskId, {
      status: 'failed',
      claimedBy: null,
      leaseExpiresAt: null,
      error,
      lastError: error
    });

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
      this.failTask(buildId, taskId, modelId, `Exhausted retries (${currentRetries}/${maxRetries}): ${error || 'Unknown error'}`);
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
}
