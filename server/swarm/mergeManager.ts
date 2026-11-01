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

  /**
   * Enqueues patch operations sequentially with automatic cleanup of idle queues
   */
  static enqueuePatch<T>(buildId: string, operation: () => Promise<T>): Promise<T> {
    const previousPromise = this.patchQueues.get(buildId) || Promise.resolve();
    const currentPromise = previousPromise.then(
      async () => {
        try {
          return await operation();
        } finally {
          if (this.patchQueues.get(buildId) === currentPromise) {
            this.patchQueues.delete(buildId);
          }
        }
      },
      async (err) => {
        if (this.patchQueues.get(buildId) === currentPromise) {
          this.patchQueues.delete(buildId);
        }
        throw err;
      }
    );
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
   * Requests an exclusive lease on one or multiple files.
   * If multiple files are requested, they MUST be acquired in alphabetical path order
   * to strictly avoid deadlocks. Automatically sweeps expired leases first.
   */
  static acquireFileLeases(
    buildId: string, 
    modelId: string, 
    filePaths: string[],
    durationMs: number = this.FILE_LEASE_DURATION_MS
  ): { success: boolean; lockedBy?: string; acquiredPaths?: string[] } {
    const sortedPaths = [...filePaths].sort(); // Alphabetical order to prevent deadlocks
    const now = Date.now();

    // 1. Clean expired leases first so abandoned locks do not block new work
    this.cleanExpiredLeases(buildId);

    // 2. Check if any file is actively leased by another model
    for (const p of sortedPaths) {
      const file = db.getFile(buildId, p);
      if (file && file.leaseOwner && file.leaseOwner !== modelId) {
        if (file.leaseExpiresAt && file.leaseExpiresAt > now) {
          return { success: false, lockedBy: file.leaseOwner };
        }
      }
    }

    // 3. Grant lease
    const acquiredPaths: string[] = [];
    for (const p of sortedPaths) {
      const file = db.getFile(buildId, p);
      if (file) {
        file.leaseOwner = modelId;
        file.leaseExpiresAt = now + durationMs;
        db.setFile(buildId, file);
        acquiredPaths.push(p);
      }
    }

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: now,
      type: 'file_leased',
      modelId,
      details: `${modelId} acquired refactor lease on: ${sortedPaths.join(', ')} (${Math.round(durationMs / 1000)}s)`
    });

    return { success: true, acquiredPaths };
  }

  /**
   * Renews existing file leases held by modelId, extending their expiry
   */
  static renewFileLeases(
    buildId: string, 
    modelId: string, 
    filePaths: string[], 
    durationMs: number = this.FILE_LEASE_DURATION_MS
  ): { success: boolean; error?: string; renewedPaths?: string[] } {
    const sortedPaths = [...filePaths].sort();
    const now = Date.now();
    const renewedPaths: string[] = [];

    // Verify all leases are currently held and active for modelId
    for (const p of sortedPaths) {
      const file = db.getFile(buildId, p);
      if (!file) {
        return { success: false, error: `File ${p} not found` };
      }
      if (!file.leaseOwner || file.leaseOwner !== modelId) {
        return { success: false, error: `Cannot renew lease: File ${p} is not leased by ${modelId}` };
      }
      if (!file.leaseExpiresAt || file.leaseExpiresAt <= now) {
        return { success: false, error: `Cannot renew lease: Lease for file ${p} has already expired` };
      }
    }

    for (const p of sortedPaths) {
      const file = db.getFile(buildId, p);
      if (file) {
        file.leaseOwner = modelId;
        file.leaseExpiresAt = now + durationMs;
        db.setFile(buildId, file);
        renewedPaths.push(p);
      }
    }

    return { success: true, renewedPaths };
  }

  /**
   * ARCHITECTURAL CONCURRENCY NOTE & DISTRIBUTED LOCKING LIMITATIONS:
   * 
   * SquadForge's current concurrency architecture operates on a single Node.js runtime process:
   * 1. Mutual Exclusion: In-process Promise serialization (`patchQueues` Map keyed by buildId) ensures
   *    patches, creations, deletions, and batch actions are executed sequentially per build.
   * 2. Storage Consistency: SQLite in Write-Ahead-Logging (WAL) mode provides single-writer transactional safety.
   * 3. File Leases: In-memory and SQLite-backed lease expiration timestamps (`leaseOwner`, `leaseExpiresAt`).
   * 
   * DISTRIBUTED DEPLOYMENT LIMITATIONS:
   * If SquadForge is scaled horizontally across multiple instances, nodes, or serverless containers:
   * - In-memory `patchQueues` are local to a single Node process and will NOT coordinate across instances.
   * - Lease sweeps and in-memory caches will experience split-brain conditions without centralized coordination.
   * - Horizontally scaled deployments REQUIRE an external distributed lock coordinator, such as:
   *   - Redis distributed locking via Redlock algorithm (or `redsync`), or
   *   - PostgreSQL transactional advisory locks (`pg_advisory_xact_lock`), or
   *   - Consul/Etcd distributed KV mutexes.
   * Currently, SquadForge guarantees strict atomic safety and lease exclusivity within single-node multi-threaded
   * or asynchronous swarm execution environments.
   */

  /**
   * Releases file leases held by a model with owner validation and expired lease sweeping
   */
  static releaseFileLeases(
    buildId: string, 
    modelId: string, 
    filePaths: string[]
  ): { success: boolean; error?: string; releasedPaths: string[] } {
    const sortedPaths = [...filePaths].sort();
    const releasedPaths: string[] = [];

    // Sweeps expired leases first
    this.cleanExpiredLeases(buildId);

    for (const p of sortedPaths) {
      const file = db.getFile(buildId, p);
      if (!file) continue;

      // If active lease is owned by another model, reject release
      const now = Date.now();
      if (file.leaseOwner && file.leaseOwner !== modelId && (!file.leaseExpiresAt || file.leaseExpiresAt > now)) {
        return {
          success: false,
          error: `Cannot release lease on ${p}: Active lease is held by ${file.leaseOwner}, not ${modelId}`,
          releasedPaths
        };
      }

      if (file.leaseOwner === modelId) {
        file.leaseOwner = null;
        file.leaseExpiresAt = null;
        db.setFile(buildId, file);
        releasedPaths.push(p);
      }
    }

    return { success: true, releasedPaths };
  }

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

    // File size limit check
    const byteLength = Buffer.byteLength(action.content, 'utf-8');
    if (byteLength > this.MAX_FILE_SIZE_BYTES) {
      return {
        success: false,
        filePath: cleanPath,
        error: `File size limit exceeded (${byteLength} bytes > ${this.MAX_FILE_SIZE_BYTES} bytes max).`
      };
    }

    // Total project size check
    const allFiles = db.getAllFiles(buildId);
    const totalProjectBytes = allFiles.reduce((acc, f) => acc + Buffer.byteLength(f.content, 'utf-8'), 0) + byteLength;
    if (totalProjectBytes > this.MAX_PROJECT_SIZE_BYTES) {
      return {
        success: false,
        filePath: cleanPath,
        error: `Project size limit exceeded (${totalProjectBytes} bytes > ${this.MAX_PROJECT_SIZE_BYTES} bytes max).`
      };
    }

    const existing = db.getFile(buildId, cleanPath);
    if (existing) {
      const error = `File ${cleanPath} already exists (v${existing.version}). Models must use patch_file with exact find/replace edits.`;
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'patch_rejected',
        modelId,
        filePath: cleanPath,
        details: `Rejected create_file from ${modelId}: File already exists. Use patch_file.`
      });
      return {
        success: false,
        filePath: cleanPath,
        error,
        currentContent: existing.content
      };
    }

    const now = Date.now();
    const events = db.getEvents(buildId);
    const wasPreviouslyDeleted = events.some(e => e.type === 'file_deleted' && e.filePath === cleanPath);

    const initialVersion: FileVersion = {
      version: 1,
      content: action.content,
      authorModel: modelId,
      timestamp: now,
      commitMessage: action.commitMessage || (wasPreviouslyDeleted ? `Recreated ${cleanPath}` : `Created ${cleanPath}`),
      taskId: action.taskId,
      changeType: wasPreviouslyDeleted ? 'recreated' : 'added'
    };

    const newFile: ProjectFile = {
      path: cleanPath,
      content: action.content,
      version: 1,
      ownerModel: modelId,
      history: [initialVersion],
      createdAt: now,
      updatedAt: now,
      isRecreated: wasPreviouslyDeleted
    };

    db.setFile(buildId, newFile);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: now,
      type: 'file_created',
      modelId,
      filePath: cleanPath,
      details: `${modelId} created ${cleanPath} (v1)`
    });

    return {
      success: true,
      filePath: cleanPath,
      version: 1,
      currentContent: action.content
    };
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

    const file = db.getFile(buildId, cleanPath);
    if (!file) {
      const error = `File ${cleanPath} does not exist yet. Use create_file first.`;
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'patch_rejected',
        modelId,
        filePath: cleanPath,
        details: `Rejected patch from ${modelId}: File does not exist`
      });
      return {
        success: false,
        filePath: cleanPath,
        error
      };
    }

    // Check if file is leased by someone else
    const now = Date.now();
    if (file.leaseOwner && file.leaseOwner !== modelId && file.leaseExpiresAt && file.leaseExpiresAt > now) {
      const error = `File is currently locked under refactor lease by ${file.leaseOwner}. Lease expires in ${Math.round((file.leaseExpiresAt - now) / 1000)}s.`;
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: now,
        type: 'patch_rejected',
        modelId,
        filePath: cleanPath,
        details: `Rejected patch from ${modelId}: File leased by ${file.leaseOwner}`
      });
      return {
        success: false,
        filePath: cleanPath,
        error,
        currentContent: file.content
      };
    }

    // Version freshness check to prevent stale agents from overwriting newer changes
    if (action.expectedVersion !== undefined && file.version !== action.expectedVersion) {
      const error = `Version conflict: Expected file version v${action.expectedVersion}, but ${cleanPath} is currently at v${file.version}. File was modified concurrently.`;
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: now,
        type: 'patch_rejected',
        modelId,
        filePath: cleanPath,
        details: `Rejected patch from ${modelId}: Version mismatch (expected v${action.expectedVersion}, got v${file.version})`
      });
      return {
        success: false,
        filePath: cleanPath,
        error,
        currentContent: file.content
      };
    }

    let content = file.content;

    // Validate each edit
    for (let i = 0; i < action.edits.length; i++) {
      const edit = action.edits[i];
      if (!edit.find && edit.find !== '') {
        continue;
      }

      const occurrences = content.split(edit.find).length - 1;

      if (occurrences === 0) {
        const error = `Conflict: "find" text was not found in ${cleanPath} (current v${file.version}). File may have been edited by another model. Redo your edit on this version.`;
        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: Date.now(),
          type: 'patch_rejected',
          modelId,
          filePath: cleanPath,
          details: `Patch conflict from ${modelId} on ${cleanPath} (v${file.version}): Target text not found`
        });
        return {
          success: false,
          filePath: cleanPath,
          error,
          currentContent: content
        };
      }

      if (occurrences > 1) {
        const error = `Ambiguity: "find" text appears ${occurrences} times in ${cleanPath}. Provide more surrounding context lines in "find".`;
        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: Date.now(),
          type: 'patch_rejected',
          modelId,
          filePath: cleanPath,
          details: `Patch rejected from ${modelId} on ${cleanPath}: Ambiguous multiple occurrences (${occurrences})`
        });
        return {
          success: false,
          filePath: cleanPath,
          error,
          currentContent: content
        };
      }

      content = content.replace(edit.find, edit.replace);
    }

    // Check size limit after patch
    const byteLength = Buffer.byteLength(content, 'utf-8');
    if (byteLength > this.MAX_FILE_SIZE_BYTES) {
      return {
        success: false,
        filePath: cleanPath,
        error: `Patched file exceeds maximum file size limit (${byteLength} bytes > ${this.MAX_FILE_SIZE_BYTES} bytes max).`
      };
    }

    const newVersionNum = file.version + 1;
    const isReverted = file.history.some(h => h.version < file.version && h.content === content);
    const isFormattingOnly = file.content.trim().replace(/\s+/g, ' ') === content.trim().replace(/\s+/g, ' ');

    const newVersion: FileVersion = {
      version: newVersionNum,
      content,
      authorModel: modelId,
      timestamp: now,
      commitMessage: action.commitMessage || `Patch ${cleanPath} v${newVersionNum}`,
      taskId: action.taskId,
      changeType: isReverted ? 'reverted' : 'modified',
      isFormattingOnly
    };

    file.content = content;
    file.version = newVersionNum;
    file.ownerModel = modelId;
    file.updatedAt = now;
    file.history.push(newVersion);

    db.setFile(buildId, file);

    const build = db.getBuild(buildId);
    if (build) {
      build.patchesAppliedCount = (build.patchesAppliedCount || 0) + 1;
      db.saveBuild(build);
    }

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: now,
      type: 'patch_applied',
      modelId,
      filePath: cleanPath,
      details: `${modelId} patched ${cleanPath} (v${newVersionNum})`
    });

    return {
      success: true,
      filePath: cleanPath,
      version: newVersionNum,
      currentContent: content
    };
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

    const existing = db.getFile(buildId, cleanPath);
    if (!existing) {
      return { success: false, filePath: cleanPath, error: `File ${cleanPath} does not exist.` };
    }

    // Check if file is leased by another model
    const now = Date.now();
    if (existing.leaseOwner && existing.leaseOwner !== modelId && existing.leaseExpiresAt && existing.leaseExpiresAt > now) {
      const error = `Cannot delete file: Locked under active lease by ${existing.leaseOwner}.`;
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: now,
        type: 'patch_rejected',
        modelId,
        filePath: cleanPath,
        details: `Rejected delete from ${modelId}: File leased by ${existing.leaseOwner}`
      });
      return { success: false, filePath: cleanPath, error };
    }

    db.deleteFile(buildId, cleanPath);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'patch_applied',
      modelId,
      filePath: cleanPath,
      details: `${modelId} deleted file: ${cleanPath}`
    });

    return { success: true, filePath: cleanPath };
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

    const file = db.getFile(buildId, sanitizeOld.cleanPath);
    if (!file) {
      return { success: false, oldPath: sanitizeOld.cleanPath, newPath: sanitizeNew.cleanPath, error: `File ${sanitizeOld.cleanPath} does not exist.` };
    }

    // Check if source file is leased by another model
    const now = Date.now();
    if (file.leaseOwner && file.leaseOwner !== modelId && file.leaseExpiresAt && file.leaseExpiresAt > now) {
      const error = `Cannot rename file: Source file is locked under active lease by ${file.leaseOwner}.`;
      return { success: false, oldPath: sanitizeOld.cleanPath, newPath: sanitizeNew.cleanPath, error };
    }

    const targetExisting = db.getFile(buildId, sanitizeNew.cleanPath);
    if (targetExisting) {
      return { success: false, oldPath: sanitizeOld.cleanPath, newPath: sanitizeNew.cleanPath, error: `Destination ${sanitizeNew.cleanPath} already exists.` };
    }

    db.deleteFile(buildId, sanitizeOld.cleanPath);

    const newVersionNum = file.version + 1;
    file.path = sanitizeNew.cleanPath;
    file.version = newVersionNum;
    file.ownerModel = modelId;
    file.updatedAt = now;
    file.isRenamed = true;
    file.originalPath = file.originalPath || sanitizeOld.cleanPath;
    file.history.push({
      version: newVersionNum,
      content: file.content,
      authorModel: modelId,
      timestamp: now,
      commitMessage: action.commitMessage || `Renamed from ${sanitizeOld.cleanPath} to ${sanitizeNew.cleanPath}`,
      taskId: action.taskId,
      changeType: 'modified'
    });

    db.setFile(buildId, file);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: now,
      type: 'patch_applied',
      modelId,
      filePath: sanitizeNew.cleanPath,
      details: `${modelId} renamed ${sanitizeOld.cleanPath} -> ${sanitizeNew.cleanPath}`
    });

    return { success: true, oldPath: sanitizeOld.cleanPath, newPath: sanitizeNew.cleanPath };
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
   * If ANY action in the batch fails, ALL changes made by the batch are reverted cleanly
   * back to the exact pre-batch snapshot state, ensuring no partial or corrupted workspace states.
   */
  static async applyBatchActions(
    buildId: string,
    modelId: string,
    actions: Array<{ action?: string; [key: string]: any }>
  ): Promise<{
    success: boolean;
    appliedCount: number;
    totalCount: number;
    error?: string;
    reverted?: boolean;
    results: any[];
  }> {
    return this.enqueuePatch(buildId, async () => {
      // 1. Snapshot all current project files for rollback
      const initialFiles = db.getAllFiles(buildId);
      const snapshotMap = new Map<string, ProjectFile>();
      for (const f of initialFiles) {
        snapshotMap.set(f.path, JSON.parse(JSON.stringify(f)));
      }

      const results: any[] = [];
      let failureError: string | undefined;

      for (const item of actions) {
        let res: { success: boolean; error?: string; [key: string]: any } = { success: false, error: 'Unknown action' };

        if (item.action === 'create_file') {
          res = await this.executeCreateFileNoLock(buildId, modelId, item as CreateFileAction);
        } else if (item.action === 'patch_file') {
          res = await this.executeApplyPatchNoLock(buildId, modelId, item as PatchAction);
        } else if (item.action === 'delete_file') {
          res = await this.executeDeleteFileNoLock(buildId, modelId, item as DeleteFileAction);
        } else if (item.action === 'rename_file') {
          res = await this.executeRenameFileNoLock(buildId, modelId, item as RenameFileAction);
        } else if (item.action === 'create_task') {
          // Task actions don't mutate file state
          res = { success: true };
        } else {
          res = { success: false, error: `Unsupported action type: ${item.action}` };
        }

        results.push(res);

        if (!res.success) {
          failureError = res.error || `Action ${item.action} failed`;
          break;
        }
      }

      // If any action failed, revert all files to snapshot state
      if (failureError) {
        // 1. Delete any files created during this batch that did not exist in the snapshot
        const currentFiles = db.getAllFiles(buildId);
        for (const cf of currentFiles) {
          if (!snapshotMap.has(cf.path)) {
            db.deleteFile(buildId, cf.path);
          }
        }

        // 2. Restore all original files
        for (const [_, originalFile] of snapshotMap.entries()) {
          db.setFile(buildId, JSON.parse(JSON.stringify(originalFile)));
        }

        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: Date.now(),
          type: 'patch_rejected',
          modelId,
          details: `Batch transaction aborted and rolled back cleanly: ${failureError}`
        });

        return {
          success: false,
          appliedCount: 0,
          totalCount: actions.length,
          error: failureError,
          reverted: true,
          results
        };
      }

      return {
        success: true,
        appliedCount: results.filter(r => r.success).length,
        totalCount: actions.length,
        results
      };
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
