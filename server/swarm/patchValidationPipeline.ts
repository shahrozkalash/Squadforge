import crypto from 'node:crypto';
import { db, computeContentHash } from '../store.js';
import { MergeManager } from './mergeManager.js';
import { ExecutionAdapter } from './executionAdapter.js';
import { 
  PatchProposal, 
  PatchProposalHunk, 
  FileConflict, 
  AgentRole 
} from '../types.js';

export class PatchValidationPipeline {
  /**
   * Proposes a new code modification patch.
   * Performs structural verification, path security validation, and base version / hash verification.
   */
  static proposePatch(
    buildId: string,
    userId: string,
    params: {
      authorAgent: string;
      authorRole: AgentRole;
      relatedTaskId: string;
      targetFile: string;
      baseFileVersion: number;
      baseContentHash: string;
      proposedChanges: PatchProposalHunk;
      changeExplanation: string;
      expectedBehavior: string;
    }
  ): { success: boolean; patch?: PatchProposal; conflict?: FileConflict; error?: string } {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const errors: string[] = [];
    const patchId = `patch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // 1. Path Security Validation
    const sanitized = ExecutionAdapter.sanitizeFilePath(params.targetFile);
    if (!sanitized.valid) {
      return { success: false, error: `Invalid target path: ${sanitized.error}` };
    }

    // 2. Structural Validation
    if (!params.proposedChanges || !params.proposedChanges.actionType) {
      errors.push('Missing proposedChanges actionType');
    } else {
      const type = params.proposedChanges.actionType;
      if (type === 'patch') {
        if (!params.proposedChanges.find || params.proposedChanges.replace === undefined) {
          errors.push('Patch action requires both find and replace strings');
        }
      } else if (type === 'create') {
        if (!params.proposedChanges.content) {
          errors.push('Create action requires non-empty content');
        }
      }
    }

    // 3. Base Version & Content Hash Verification
    const currentFile = db.getFile(buildId, sanitized.cleanPath);
    let versionCurrent = true;
    let hashMatched = true;

    if (currentFile) {
      const currentHash = currentFile.contentHash || computeContentHash(currentFile.content);
      if (currentFile.version !== params.baseFileVersion) {
        versionCurrent = false;
        errors.push(`Stale base version: target file is at version ${currentFile.version}, patch was authored against version ${params.baseFileVersion}`);
      }
      if (params.baseContentHash && currentHash !== params.baseContentHash) {
        hashMatched = false;
        errors.push(`Content hash mismatch: file content has mutated since patch creation`);
      }
    } else {
      // File does not exist yet
      if (params.proposedChanges.actionType !== 'create') {
        versionCurrent = false;
        errors.push(`Target file "${sanitized.cleanPath}" does not exist, cannot apply patch/delete/rename`);
      }
    }

    const validationResults = {
      syntaxValid: errors.length === 0,
      pathAllowed: sanitized.valid,
      hashMatched,
      versionCurrent,
      errors
    };

    const applicationStatus = errors.length > 0 ? (versionCurrent ? 'rejected' : 'conflict') : 'proposed';

    const patch: PatchProposal = {
      id: patchId,
      buildId,
      authorAgent: params.authorAgent,
      authorRole: params.authorRole,
      relatedTaskId: params.relatedTaskId,
      targetFile: sanitized.cleanPath,
      baseFileVersion: params.baseFileVersion,
      baseContentHash: params.baseContentHash,
      proposedChanges: params.proposedChanges,
      changeExplanation: params.changeExplanation,
      expectedBehavior: params.expectedBehavior,
      validationResults,
      reviewStatus: 'pending',
      applicationStatus,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    db.savePatchProposal(patch);

    // If conflict detected, create FileConflict record immediately to preserve both versions
    let conflictRecord: FileConflict | undefined;
    if (!versionCurrent || !hashMatched) {
      const conflictId = `conf_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      conflictRecord = {
        id: conflictId,
        buildId,
        filePath: sanitized.cleanPath,
        baseVersion: params.baseFileVersion,
        conflictingVersions: currentFile ? [params.baseFileVersion, currentFile.version] : [params.baseFileVersion],
        competingPatches: [
          {
            patchId: patch.id,
            authorAgent: patch.authorAgent,
            authorRole: patch.authorRole,
            proposedHunk: JSON.stringify(params.proposedChanges),
            timestamp: Date.now()
          }
        ],
        reason: `Concurrent modification detected on ${sanitized.cleanPath}. Base version ${params.baseFileVersion} was superseded by version ${currentFile?.version || 0}`,
        overlappingHunks: [
          {
            startLine: 1,
            endLine: 50,
            conflictSummary: `Patch proposed against stale version ${params.baseFileVersion} while file is at ${currentFile?.version || 0}`
          }
        ],
        resolutionStatus: 'open',
        createdAt: Date.now()
      };

      db.saveFileConflict(conflictRecord);

      db.addEvent({
        id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        buildId,
        timestamp: Date.now(),
        type: 'file_conflict_detected',
        modelId: params.authorAgent,
        taskId: params.relatedTaskId,
        filePath: sanitized.cleanPath,
        details: `File conflict detected on "${sanitized.cleanPath}"! Stale version ${params.baseFileVersion} vs active ${currentFile?.version}`
      });
    } else {
      db.addEvent({
        id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        buildId,
        timestamp: Date.now(),
        type: 'patch_proposed',
        modelId: params.authorAgent,
        taskId: params.relatedTaskId,
        filePath: sanitized.cleanPath,
        details: `Patch proposed by ${params.authorRole} on "${sanitized.cleanPath}" (base v${params.baseFileVersion})`
      });
    }

    return {
      success: errors.length === 0,
      patch,
      conflict: conflictRecord,
      error: errors.length > 0 ? errors.join('; ') : undefined
    };
  }

  /**
   * Applies an approved patch proposal using MergeManager's safe sequential pipeline
   */
  static async applyApprovedPatch(
    buildId: string,
    userId: string,
    patchId: string
  ): Promise<{ success: boolean; appliedVersion?: number; error?: string }> {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const patch = db.getPatchProposal(patchId);
    if (!patch || patch.buildId !== buildId) {
      return { success: false, error: `Patch proposal ${patchId} not found in this build` };
    }

    if (patch.applicationStatus === 'applied') {
      return { success: true, appliedVersion: patch.appliedFileVersion };
    }

    if (patch.applicationStatus === 'rejected' || patch.applicationStatus === 'conflict') {
      return { success: false, error: `Cannot apply patch: patch status is ${patch.applicationStatus}` };
    }

    const action = patch.proposedChanges;
    let mergeRes: any;

    if (action.actionType === 'create') {
      mergeRes = await MergeManager.createFile(buildId, patch.authorAgent, {
        action: 'create_file',
        path: patch.targetFile,
        content: action.content || '',
        commitMessage: patch.changeExplanation,
        taskId: patch.relatedTaskId
      });
    } else if (action.actionType === 'patch') {
      mergeRes = await MergeManager.applyPatch(buildId, patch.authorAgent, {
        action: 'patch_file',
        path: patch.targetFile,
        edits: [{ find: action.find || '', replace: action.replace || '' }],
        find: action.find || '',
        replace: action.replace || '',
        commitMessage: patch.changeExplanation,
        taskId: patch.relatedTaskId
      });
    } else if (action.actionType === 'delete') {
      mergeRes = await MergeManager.deleteFile(buildId, patch.authorAgent, {
        action: 'delete_file',
        path: patch.targetFile,
        commitMessage: patch.changeExplanation,
        taskId: patch.relatedTaskId
      });
    } else if (action.actionType === 'rename') {
      mergeRes = await MergeManager.renameFile(buildId, patch.authorAgent, {
        action: 'rename_file',
        oldPath: action.oldPath || patch.targetFile,
        newPath: action.newPath || patch.targetFile,
        commitMessage: patch.changeExplanation,
        taskId: patch.relatedTaskId
      });
    }

    if (mergeRes && mergeRes.success) {
      patch.applicationStatus = 'applied';
      patch.appliedFileVersion = mergeRes.version;
      patch.updatedAt = Date.now();
      db.savePatchProposal(patch);

      // Increment build patch counters
      build.patchesAppliedCount = (build.patchesAppliedCount || 0) + 1;
      db.saveBuild(build);

      return { success: true, appliedVersion: mergeRes.version };
    } else {
      patch.applicationStatus = 'rejected';
      patch.updatedAt = Date.now();
      db.savePatchProposal(patch);
      return { success: false, error: mergeRes?.error || 'Failed to apply patch via MergeManager' };
    }
  }

  /**
   * Resolves a recorded file conflict safely with explicit resolution content
   */
  static async resolveConflict(
    buildId: string,
    userId: string,
    params: {
      conflictId: string;
      resolvedBy: string;
      resolvedContent: string;
      resolutionExplanation: string;
    }
  ): Promise<{ success: boolean; resolvedVersion?: number; error?: string }> {
    const build = db.getBuild(buildId);
    if (!build || build.userId !== userId) {
      return { success: false, error: 'Unauthorized or build not found' };
    }

    const conflict = db.getFileConflict(params.conflictId);
    if (!conflict || conflict.buildId !== buildId) {
      return { success: false, error: `Conflict ${params.conflictId} not found in this build` };
    }

    // Apply resolved content directly through MergeManager atomic batch/file operation
    const targetFile = conflict.filePath;
    const existing = db.getFile(buildId, targetFile);

    let res: any;
    if (existing) {
      // Overwrite/patch with resolved content via atomic patch action
      res = await MergeManager.applyPatch(buildId, params.resolvedBy, {
        action: 'patch_file',
        path: targetFile,
        edits: [{ find: existing.content, replace: params.resolvedContent }],
        find: existing.content,
        replace: params.resolvedContent,
        commitMessage: `Resolved conflict: ${params.resolutionExplanation}`
      });
    } else {
      res = await MergeManager.createFile(buildId, params.resolvedBy, {
        action: 'create_file',
        path: targetFile,
        content: params.resolvedContent,
        commitMessage: `Resolved conflict: ${params.resolutionExplanation}`
      });
    }

    if (res && res.success) {
      conflict.resolutionStatus = 'resolved';
      conflict.resolvedBy = params.resolvedBy;
      conflict.resolvedContent = params.resolvedContent;
      conflict.resolvedVersion = res.version;
      conflict.resolvedAt = Date.now();
      db.saveFileConflict(conflict);

      db.addEvent({
        id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        buildId,
        timestamp: Date.now(),
        type: 'file_conflict_resolved',
        modelId: params.resolvedBy,
        filePath: targetFile,
        details: `File conflict on "${targetFile}" successfully resolved at v${res.version} by ${params.resolvedBy}`
      });

      return { success: true, resolvedVersion: res.version };
    } else {
      return { success: false, error: res?.error || 'Failed to apply resolved content' };
    }
  }
}
