import { db } from '../store.js';
import { Task, TaskPriority, TaskStatus, ModelStrength } from '../types.js';

export class TaskManager {
  private static LEASE_DURATION_MS = 90 * 1000; // 90 seconds per spec

  /**
   * Sweeps and resets expired task leases back to 'open'
   */
  static cleanExpiredLeases(buildId: string): void {
    const tasks = db.getTasks(buildId);
    const now = Date.now();

    for (const task of tasks) {
      if (task.status === 'claimed' && task.leaseExpiresAt && task.leaseExpiresAt < now) {
        db.updateTask(buildId, task.id, {
          status: 'open',
          claimedBy: null,
          leaseExpiresAt: null
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
   * Atomically claims an open task for a specific model based on its strengths.
   * Atomic lock prevents two models from ever claiming the same task.
   */
  static claimTask(buildId: string, modelId: string, strengths: ModelStrength[]): Task | null {
    this.cleanExpiredLeases(buildId);

    const tasks = db.getTasks(buildId);
    const now = Date.now();

    // 1. Check if there are high-priority Fix tasks first (priority 1)
    const fixTasks = tasks.filter(t => t.status === 'open' && t.priority === 1);
    let chosenTask = fixTasks[0];

    // 2. If no fix tasks, find an open task matching model strengths
    if (!chosenTask) {
      const openTasks = tasks.filter(t => t.status === 'open');

      // Sort by priority (1 is highest)
      openTasks.sort((a, b) => a.priority - b.priority);

      // Score tasks by strength keyword match
      let bestScore = -1;
      let bestMatchingTask: Task | null = null;

      for (const task of openTasks) {
        let score = 0;
        const text = `${task.title} ${task.description} ${task.filePaths.join(' ')}`.toLowerCase();
        
        for (const strength of strengths) {
          if (text.includes(strength.toLowerCase())) {
            score += 2;
          }
        }

        // Higher priority tasks get bonus
        score += (6 - task.priority);

        if (score > bestScore) {
          bestScore = score;
          bestMatchingTask = task;
        }
      }

      chosenTask = bestMatchingTask || openTasks[0];
    }

    // 3. If no open tasks, look for a review opportunity (Section 4 item 6)
    if (!chosenTask) {
      const allFiles = db.getAllFiles(buildId);
      // Find a file authored by someone else that hasn't been reviewed recently
      const candidateFile = allFiles.find(f => f.ownerModel !== modelId && f.history.length < 4);
      if (candidateFile) {
        // Create an automated review task
        const reviewTaskId = `tsk_rev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        chosenTask = {
          id: reviewTaskId,
          buildId,
          title: `Code Review & Verification: ${candidateFile.path}`,
          description: `Inspect ${candidateFile.path} written by ${candidateFile.ownerModel}. Verify types, edge cases, and patch any omissions.`,
          filePaths: [candidateFile.path],
          priority: 4,
          status: 'open',
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
      status: 'claimed',
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
   * Marks a task as successfully done
   */
  static completeTask(buildId: string, taskId: string, modelId: string): void {
    const now = Date.now();
    const task = db.getTask(buildId, taskId);
    if (!task) return;

    db.updateTask(buildId, taskId, {
      status: 'done',
      completedAt: now,
      leaseExpiresAt: null,
      error: undefined
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
      status: 'open',
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
   * Creates a new task (e.g. planner or worker discovered sub-requirements)
   */
  static createNewTask(buildId: string, task: Omit<Task, 'id' | 'buildId' | 'status' | 'claimedBy' | 'leaseExpiresAt' | 'createdAt'>): Task {
    const id = `tsk_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const fullTask: Task = {
      ...task,
      id,
      buildId,
      status: 'open',
      claimedBy: null,
      leaseExpiresAt: null,
      createdAt: Date.now()
    };
    db.addTask(buildId, fullTask);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'task_claimed', // event to notify task board update
      taskId: id,
      details: `New task added to living board: "${fullTask.title}"`
    });

    return fullTask;
  }
}
