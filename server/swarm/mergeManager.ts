import { db } from '../store.js';
import { 
  ProjectFile, 
  FileVersion, 
  PatchAction, 
  CreateFileAction, 
  DeleteFileAction,
  RenameFileAction,
  Checkpoint 
} from '../types.js';
import { ExecutionAdapter } from './executionAdapter.js';
import { ApprovalGateService } from './approvalGateService.js';

export interface PatchResult {
  success: boolean;
  version?: number;
  filePath: string;
  error?: string;
  currentContent?: string;
}

export class MergeManager {
  private static FILE_LEASE_DURATION_MS = 60 * 1000; // 60 seconds per spec
  private static MAX_FILE_SIZE_BYTES = 500 * 1024; // 500 KB limit per file
  private static MAX_PROJECT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB total project limit

  // Sequential mutex queue per build so patches are processed strictly one at a time in order
  private static patchQueues: Map<string, Promise<any>> = new Map();

  // Cache of recently applied patches for duplicate prevention: buildId -> patchSignature -> { timestamp, result }
  private static recentAppliedPatches: Map<string, Map<string, { timestamp: number; result: PatchResult }>> = new Map();

  /**
   * Enqueues patch operations sequentially with automatic cleanup of idle queues.
   * Chaining handles previous failures gracefully so failed operations do not leave permanent locks
   * or corrupt subsequent merges.
   */
  /**
   * Enqueues patch operations sequentially with automatic cleanup of idle queues.
   * Uses both in-memory Promise queue and SQLite database-backed coordination locks
   * to ensure serialized, conflict-free patch application across multiple processes.
   * Never executes a protected operation without acquiring the lock.
   */
  /** Sensitive files in these actions that lack an approval for this exact change. */
  private static approvalGate(buildId: string, modelId: string, actions: Array<{ [key: string]: any }>) {
    // 'user' is the build owner editing through an ownership-checked route
    if (modelId === 'system' || modelId === 'user') return { blocked: [] as string[], consume: () => undefined };

    const fingerprints = ApprovalGateService.fingerprintActions(actions);
    const sensitive = Object.keys(fingerprints).filter(path => ApprovalGateService.isSensitiveFilePath(path));
    const approved = ApprovalGateService.hasApprovedRequestForFiles(buildId, sensitive, fingerprints);
    return {
      blocked: approved ? [] as string[] : sensitive,
      consume: () => ApprovalGateService.consumeApprovedFiles(buildId, sensitive)
    };
  }

  static async enqueuePatch<T>(
    buildId: string, 
    operation: () => Promise<T>,
    timeoutMs: number = 10000,
    lockDurationMs: number = 30000
  ): Promise<T> {
    const previousPromise = this.patchQueues.get(buildId) || Promise.resolve();
    const lockKey = `build_patch_${buildId}`;
    const ownerId = `${process.pid}_${Math.random().toString(36).substring(2, 8)}_${Date.now()}`;

    const executeWithCoordination = async (): Promise<T> => {
      // 1. Acquire database-backed coordination lock with jittered backoff polling up to timeoutMs
      const startTime = Date.now();
      let acquired = false;
      let delayMs = 25;

      while (!acquired && (Date.now() - startTime) < timeoutMs) {
        acquired = db.dbManager.acquireCoordinationLock(lockKey, ownerId, lockDurationMs);
        if (!acquired) {
          // Avoid unnecessary polling and excessive database writes with capped exponential backoff + jitter
          const jitter = Math.floor(Math.random() * 15);
          await new Promise(r => setTimeout(r, delayMs + jitter));
          delayMs = Math.min(150, Math.floor(delayMs * 1.5));
        }
      }

      // CRITICAL: If lock acquisition timed out, NEVER proceed with protected mutation!
      if (!acquired) {
        const elapsed = Date.now() - startTime;
        throw new Error(`Failed to acquire database coordination lock for build ${buildId} within ${elapsed}ms: lock timeout (key: ${lockKey})`);
      }

      // 2. Active lock renewal heartbeat with strict failure detection
      let renewalTimer: NodeJS.Timeout | null = null;
      let lockLost = false;
      let lockLostReason = '';

      const heartbeatInterval = Math.max(500, Math.min(5000, Math.floor(lockDurationMs / 3)));
      const attemptHeartbeat = () => {
        if (lockLost) return;
        try {
          const renewed = db.dbManager.renewCoordinationLock(lockKey, ownerId, lockDurationMs);
          if (!renewed) {
            lockLost = true;
            lockLostReason = `Coordination lock renewal failed: lock ${lockKey} expired or was preempted for owner ${ownerId}`;
            if (renewalTimer) {
              clearInterval(renewalTimer);
              renewalTimer = null;
            }
          }
        } catch (err: any) {
          lockLost = true;
          lockLostReason = `Coordination lock renewal encountered error: ${err?.message || err}`;
          if (renewalTimer) {
            clearInterval(renewalTimer);
            renewalTimer = null;
          }
        }
      };

      if (lockDurationMs >= 1000) {
        renewalTimer = setInterval(attemptHeartbeat, heartbeatInterval);
        renewalTimer.unref();
      }

      try {
        // Pre-operation check: prevent execution if lock was lost or heartbeat failed
        if (lockLost || !db.dbManager.isCoordinationLockHeld(lockKey, ownerId)) {
          throw new Error(`Database coordination lock lost before operation execution for build ${buildId}: ${lockLostReason || 'lock not held'}`);
        }

        const result = await operation();

        // Immediate post-operation check: if heartbeat lost the lock during operation, abort!
        if (lockLost) {
          throw new Error(`Database coordination lock was lost during operation execution for build ${buildId}: ${lockLostReason}`);
        }

        // Database-level check: ensure lock is STILL owned by this ownerId and has not expired
        if (!db.dbManager.isCoordinationLockHeld(lockKey, ownerId)) {
          throw new Error(`Database coordination lock expired or was preempted during operation for build ${buildId}`);
        }

        return result;
      } finally {
        if (renewalTimer) {
          clearInterval(renewalTimer);
          renewalTimer = null;
        }
        if (acquired && !lockLost) {
          // Release lock only when owned by the current process
          db.dbManager.releaseCoordinationLock(lockKey, ownerId);
        }
      }
    };

    const currentPromise = previousPromise
      .then(executeWithCoordination, executeWithCoordination)
      .finally(() => {
        if (this.patchQueues.get(buildId) === currentPromise) {
          this.patchQueues.delete(buildId);
        }
      });

    this.patchQueues.set(buildId, currentPromise);
    return currentPromise;
  }

  /**
   * Sweeps and clears expired file leases across the build
   */
  static cleanExpiredLeases(buildId: string): number {
    const files = db.getAllFiles(buildId);
    const now = Date.now();
    let cleaned = 0;

    for (const f of files) {
      if (f.leaseOwner && f.leaseExpiresAt && f.leaseExpiresAt <= now) {
        f.leaseOwner = null;
        f.leaseExpiresAt = null;
        db.setFile(buildId, f);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Requests an exclusive lease on one or multiple files atomically.
   * If multiple files are requested, they MUST be acquired in alphabetical path order
   * to strictly avoid deadlocks. If ANY requested file cannot be acquired, all temporary
   * acquisitions are completely rolled back and released.
   */
  static acquireFileLeases(
    buildId: string, 
    modelId: string, 
    filePaths: string[],
    durationMs: number = this.FILE_LEASE_DURATION_MS
  ): { success: boolean; lockedBy?: string; acquiredPaths: string[]; error?: string } {
    const res = db.acquireFileLeasesAtomic(buildId, modelId, filePaths, durationMs);
    
    if (res.success && res.acquiredPaths.length > 0) {
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'file_leased',
        modelId,
        details: `${modelId} acquired refactor lease on: ${res.acquiredPaths.join(', ')} (${Math.round(durationMs / 1000)}s)`
      });
    }

    return { 
      success: res.success, 
      lockedBy: res.lockedBy, 
      acquiredPaths: res.acquiredPaths,
      error: res.error 
    };
  }

  /**
   * Renews existing file leases held by modelId, extending their expiry.
   * Validates that modelId holds active leases on all specified files and has not expired.
   * An agent cannot renew another agent's lease or an expired lease.
   */
  static renewFileLeases(
    buildId: string, 
    modelId: string, 
    filePaths: string[], 
    durationMs: number = this.FILE_LEASE_DURATION_MS
  ): { success: boolean; error?: string; renewedPaths: string[] } {
    return db.renewFileLeasesAtomic(buildId, modelId, filePaths, durationMs);
  }

  /**
   * ARCHITECTURAL CONCURRENCY NOTE & DISTRIBUTED LOCKING LIMITATIONS:
   * 
   * SquadForge's current concurrency architecture operates on a single Node.js runtime process:
   * 1. Mutual Exclusion: In-process Promise serialization (`patchQueues` Map keyed by buildId) ensures
   *    patches, creations, deletions, and batch actions are executed sequentially per build.
   * 2. Storage Consistency: SQLite in Write-Ahead-Logging (WAL) mode provides single-writer transactional safety.
   * 3. File Leases: SQLite transaction-backed atomic lease acquisition, renewal, and release.
   * 
   * CRITICAL DISTRIBUTED DEPLOYMENT LIMITATIONS:
   * The current in-memory queue and lease coordination is single-process only. It does NOT claim multi-instance
   * or distributed locking safety. If SquadForge is scaled horizontally across multiple Node.js instances:
   * - In-memory `patchQueues` are local to each process and will not synchronize across instances.
   * - True distributed deployment requires external coordination (e.g., Redis Redlock, Postgres advisory locks).
   */

  /**
   * Releases file leases held by a model with owner validation and atomic database safety.
   * An agent cannot release another agent's lease.
   */
  static releaseFileLeases(
    buildId: string, 
    modelId: string, 
    filePaths: string[]
  ): { success: boolean; error?: string; releasedPaths: string[] } {
    return db.releaseFileLeasesAtomic(buildId, modelId, filePaths);
  }

  /**
   * Internal implementation of createFile without acquiring the queue lock
   */
  /**
   * Internal implementation of createFile without acquiring the queue lock
   */
  private static async executeCreateFileNoLock(
    buildId: string,
    modelId: string,
    action: CreateFileAction
  ): Promise<PatchResult> {
    this.cleanExpiredLeases(buildId);

    // Path traversal security check
    const { valid, cleanPath, error: pathError } = ExecutionAdapter.sanitizeFilePath(action.path);
    if (!valid) {
      return {
        success: false,
        filePath: action.path,
        error: `Invalid file path: ${pathError}`
      };
    }

    const gate = this.approvalGate(buildId, modelId, [{ action: 'create_file', ...action, path: cleanPath }]);
    if (gate.blocked.length > 0) {
      return {
        success: false,
        filePath: cleanPath,
        error: `Human approval required for sensitive file "${cleanPath}". Unapproved sensitive modification rejected.`
      };
    }

    const created = db.createFileAtomic(
      buildId,
      modelId,
      { ...action, path: cleanPath },
      this.MAX_FILE_SIZE_BYTES,
      this.MAX_PROJECT_SIZE_BYTES
    );
    if (created.success) gate.consume();
    return created;
  }

  /**
   * Internal implementation of applyPatch without acquiring queue lock
   */
  private static async executeApplyPatchNoLock(
    buildId: string,
    modelId: string,
    action: PatchAction
  ): Promise<PatchResult> {
    this.cleanExpiredLeases(buildId);

    const { valid, cleanPath, error: pathError } = ExecutionAdapter.sanitizeFilePath(action.path);
    if (!valid) {
      return {
        success: false,
        filePath: action.path,
        error: `Invalid file path: ${pathError}`
      };
    }

    const gate = this.approvalGate(buildId, modelId, [{ action: 'patch_file', ...action, path: cleanPath }]);
    if (gate.blocked.length > 0) {
      return {
        success: false,
        filePath: cleanPath,
        error: `Human approval required for sensitive file "${cleanPath}". Unapproved sensitive modification rejected.`
      };
    }

    const now = Date.now();
    // Duplicate patch prevention (idempotent handling of retried edits)
    const patchSignature = `${modelId}::${cleanPath}::${action.expectedVersion !== undefined ? `v${action.expectedVersion}::` : ''}${JSON.stringify(action.edits)}`;
    let buildPatches = this.recentAppliedPatches.get(buildId);
    if (!buildPatches) {
      buildPatches = new Map();
      this.recentAppliedPatches.set(buildId, buildPatches);
    }
    const recent = buildPatches.get(patchSignature);
    if (recent && (now - recent.timestamp) < 15000 && recent.result.success) {
      return {
        ...recent.result
      };
    }

    const result = db.applyPatchAtomic(
      buildId,
      modelId,
      { ...action, path: cleanPath },
      this.MAX_FILE_SIZE_BYTES
    );

    if (result.success) {
      buildPatches.set(patchSignature, { timestamp: now, result });
      gate.consume();
    }

    return result;
  }

  /**
   * Internal implementation of deleteFile without acquiring queue lock
   */
  private static async executeDeleteFileNoLock(
    buildId: string,
    modelId: string,
    action: DeleteFileAction
  ): Promise<{ success: boolean; filePath: string; error?: string }> {
    this.cleanExpiredLeases(buildId);

    const { valid, cleanPath, error: pathError } = ExecutionAdapter.sanitizeFilePath(action.path);
    if (!valid) {
      return { success: false, filePath: action.path, error: `Invalid file path: ${pathError}` };
    }

    const gate = this.approvalGate(buildId, modelId, [{ action: 'delete_file', path: cleanPath }]);
    if (gate.blocked.length > 0) {
      return {
        success: false,
        filePath: cleanPath,
        error: `Human approval required for sensitive file "${cleanPath}". Unapproved sensitive deletion rejected.`
      };
    }

    const deleted = db.deleteFileAtomic(buildId, modelId, cleanPath);
    if (deleted.success) gate.consume();
    return deleted;
  }

  /**
   * Internal implementation of renameFile without acquiring queue lock
   */
  private static async executeRenameFileNoLock(
    buildId: string,
    modelId: string,
    action: RenameFileAction
  ): Promise<{ success: boolean; oldPath: string; newPath: string; error?: string }> {
    this.cleanExpiredLeases(buildId);

    const sanitizeOld = ExecutionAdapter.sanitizeFilePath(action.oldPath);
    const sanitizeNew = ExecutionAdapter.sanitizeFilePath(action.newPath);

    if (!sanitizeOld.valid) {
      return { success: false, oldPath: action.oldPath, newPath: action.newPath, error: `Invalid source path: ${sanitizeOld.error}` };
    }
    if (!sanitizeNew.valid) {
      return { success: false, oldPath: action.oldPath, newPath: action.newPath, error: `Invalid destination path: ${sanitizeNew.error}` };
    }

    const gate = this.approvalGate(buildId, modelId, [{
      action: 'rename_file',
      oldPath: sanitizeOld.cleanPath,
      newPath: sanitizeNew.cleanPath
    }]);
    if (gate.blocked.length > 0) {
      return {
        success: false,
        oldPath: action.oldPath,
        newPath: action.newPath,
        error: `Human approval required for sensitive file rename (${gate.blocked.join(', ')}). Action rejected without valid approval.`
      };
    }

    const renamed = db.renameFileAtomic(
      buildId,
      modelId,
      sanitizeOld.cleanPath,
      sanitizeNew.cleanPath,
      action.commitMessage,
      action.taskId
    );
    if (renamed.success) gate.consume();
    return renamed;
  }

  /**
   * Creates a new file. Only succeeds if file does not exist.
   * Validates against path traversal and enforces file size limits.
   */
  static async createFile(
    buildId: string, 
    modelId: string, 
    action: CreateFileAction
  ): Promise<PatchResult> {
    return this.enqueuePatch(buildId, async () => {
      return this.executeCreateFileNoLock(buildId, modelId, action);
    });
  }

  /**
   * Applies patch edits against the current file.
   * If the "find" text exists EXACTLY once, apply it and increment version.
   * If not (not found, or ambiguous multiple occurrences), reject and return latest content.
   */
  static async applyPatch(
    buildId: string, 
    modelId: string, 
    action: PatchAction
  ): Promise<PatchResult> {
    return this.enqueuePatch(buildId, async () => {
      return this.executeApplyPatchNoLock(buildId, modelId, action);
    });
  }

  /**
   * Safely deletes a file from the project workspace
   */
  static async deleteFile(
    buildId: string,
    modelId: string,
    action: DeleteFileAction
  ): Promise<{ success: boolean; filePath: string; error?: string }> {
    return this.enqueuePatch(buildId, async () => {
      return this.executeDeleteFileNoLock(buildId, modelId, action);
    });
  }

  /**
   * Safely renames/moves a file within the project workspace
   */
  static async renameFile(
    buildId: string,
    modelId: string,
    action: RenameFileAction
  ): Promise<{ success: boolean; oldPath: string; newPath: string; error?: string }> {
    return this.enqueuePatch(buildId, async () => {
      return this.executeRenameFileNoLock(buildId, modelId, action);
    });
  }

  /**
   * Applies an atomic batch of file actions.
   * Uses SQLite transaction with BEGIN IMMEDIATE and rollback on failure,
   * ensuring no partial or corrupted workspace states.
   */
  static async applyBatchActions(
    buildId: string,
    modelId: string,
    actions: Array<{ action?: string; [key: string]: any }>,
    options: { signal?: AbortSignal } = {}
  ): Promise<{
    success: boolean;
    appliedCount: number;
    totalCount: number;
    error?: string;
    reverted?: boolean;
    cancelled?: boolean;
    results: any[];
  }> {
    return this.enqueuePatch(buildId, async () => {
      // The batch may have waited in the patch queue. The write below is one synchronous
      // transaction, so this check covers every action in the batch.
      if (options.signal?.aborted) {
        return {
          success: false,
          appliedCount: 0,
          totalCount: actions.length,
          error: 'Cancelled before file changes were applied',
          cancelled: true,
          results: []
        };
      }

      this.cleanExpiredLeases(buildId);

      const gate = this.approvalGate(buildId, modelId, actions);
      if (gate.blocked.length > 0) {
        return {
          success: false,
          appliedCount: 0,
          totalCount: actions.length,
          error: `Human approval required for sensitive files: ${gate.blocked.join(', ')}. Action rejected without valid approval.`,
          results: []
        };
      }

      const applied = db.applyBatchActionsAtomic(
        buildId,
        modelId,
        actions,
        this.MAX_FILE_SIZE_BYTES,
        this.MAX_PROJECT_SIZE_BYTES
      );
      if (applied.success) gate.consume();
      return applied;
    });
  }

  /**
   * Creates a verified checkpoint of all files in the build
   */
  static createCheckpoint(buildId: string, description: string): Checkpoint {
    const allFiles = db.getAllFiles(buildId);
    const snapshot: Record<string, string> = {};
    for (const f of allFiles) {
      snapshot[f.path] = f.content;
    }

    const checkpoint: Checkpoint = {
      id: `chk_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      buildId,
      timestamp: Date.now(),
      description,
      filesSnapshot: snapshot,
      patchCount: db.getBuild(buildId)?.patchesAppliedCount || 0
    };

    db.addCheckpoint(checkpoint);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: checkpoint.timestamp,
      type: 'checkpoint_saved',
      details: `Checkpoint saved: "${description}" (${allFiles.length} files verified)`
    });

    return checkpoint;
  }

  /**
   * Reverts the entire project to a specific checkpoint
   */
  static async revertToCheckpoint(buildId: string, checkpointId: string, modelId: string = 'system'): Promise<boolean> {
    return this.enqueuePatch(buildId, async () => {
      const checkpoints = db.getCheckpoints(buildId);
      const target = checkpoints.find(c => c.id === checkpointId);
      if (!target) return false;

      const now = Date.now();
      // Invariant: Reject rollback if any affected file is actively leased by another model
      for (const filePath of Object.keys(target.filesSnapshot)) {
        const lease = db.getFileLease(buildId, filePath);
        if (lease && lease.modelId !== modelId) {
          console.warn(`[ROLLBACK] Cannot revert checkpoint: file "${filePath}" is actively leased by "${lease.modelId}"`);
          return false;
        }
      }

      for (const [filePath, content] of Object.entries(target.filesSnapshot)) {
        let file = db.getFile(buildId, filePath);
        if (file) {
          const nextVer = file.version + 1;
          file.content = content;
          file.version = nextVer;
          file.ownerModel = `rollback(${modelId})`;
          file.updatedAt = now;
          file.history.push({
            version: nextVer,
            content,
            authorModel: `rollback(${modelId})`,
            timestamp: now,
            commitMessage: `Reverted to checkpoint: ${target.description}`
          });
          db.setFile(buildId, file);
        } else {
          const newFile: ProjectFile = {
            path: filePath,
            content,
            version: 1,
            ownerModel: `rollback(${modelId})`,
            history: [{
              version: 1,
              content,
              authorModel: `rollback(${modelId})`,
              timestamp: now,
              commitMessage: `Restored from checkpoint: ${target.description}`
            }],
            createdAt: now,
            updatedAt: now
          };
          db.setFile(buildId, newFile);
        }
      }

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: now,
        type: 'checkpoint_reverted',
        modelId,
        details: `Project rolled back to checkpoint "${target.description}"`
      });

      return true;
    });
  }

  /**
   * Reverts a single file to a specific previous version
   */
  static async revertFileVersion(buildId: string, filePath: string, targetVersion: number, modelId: string = 'user'): Promise<boolean> {
    return this.enqueuePatch(buildId, async () => {
      const file = db.getFile(buildId, filePath);
      if (!file) return false;

      // Invariant: Reject rollback if file is actively leased by another model
      const lease = db.getFileLease(buildId, filePath);
      if (lease && lease.modelId !== modelId) {
        console.warn(`[ROLLBACK] Cannot revert file: "${filePath}" is actively leased by "${lease.modelId}"`);
        return false;
      }

      const historyItem = file.history.find(h => h.version === targetVersion);
      if (!historyItem) return false;

      const now = Date.now();
      const nextVer = file.version + 1;
      file.content = historyItem.content;
      file.version = nextVer;
      file.ownerModel = `revert(${modelId})`;
      file.updatedAt = now;
      file.history.push({
        version: nextVer,
        content: historyItem.content,
        authorModel: `revert(${modelId})`,
        timestamp: now,
        commitMessage: `Reverted ${filePath} to v${targetVersion}`
      });

      db.setFile(buildId, file);

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: now,
        type: 'patch_applied',
        modelId,
        filePath,
        details: `${filePath} reverted to version ${targetVersion} (now v${nextVer})`
      });

      return true;
    });
  }
}
