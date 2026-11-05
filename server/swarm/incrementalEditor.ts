import crypto from 'node:crypto';
import { ProjectFile, IncrementalFileEdit, FileConflict } from '../types.js';
import { db, computeContentHash } from '../store.js';
import { MergeManager } from './mergeManager.js';
import { PatchValidationPipeline } from './patchValidationPipeline.js';
import { ApprovalGateService } from './approvalGateService.js';

export interface IncrementalEditResult {
  success: boolean;
  filePath: string;
  previousVersion: number;
  newVersion?: number;
  appliedContent?: string;
  changeSummary: string;
  conflict?: FileConflict;
  error?: string;
}

export class IncrementalEditor {
  /**
   * Applies an incremental edit safely with base version check, content hash verification,
   * conflict detection, and atomic rollback on syntax/merge failure.
   */
  static async applyIncrementalEdit(
    buildId: string,
    authorAgent: string,
    edit: IncrementalFileEdit
  ): Promise<IncrementalEditResult> {
    const existingFile = db.getFile(buildId, edit.filePath);
    const previousVersion = existingFile?.version || 0;

    // 0. Sensitive file gate: detect sensitive changes before applying them
    if (ApprovalGateService.isSensitiveFilePath(edit.filePath)) {
      // The same action MergeManager will check below
      const current = existingFile?.content ?? '';
      const gateAction = edit.action === 'create'
        ? { action: 'create_file', path: edit.filePath, content: edit.replacementContent }
        : {
            action: 'patch_file',
            path: edit.filePath,
            edits: [{ find: edit.findSnippet || current, replace: edit.replacementContent }],
            find: edit.findSnippet || current,
            replace: edit.replacementContent
          };
      const fingerprints = ApprovalGateService.fingerprintActions([gateAction]);
      const isApproved = ApprovalGateService.hasApprovedRequestForFiles(buildId, Object.keys(fingerprints), fingerprints);
      if (!isApproved) {
        const build = db.getBuild(buildId);
        if (build?.userId) {
          ApprovalGateService.requestForActions(buildId, build.userId, { agent: authorAgent, actions: [gateAction] });
        }
        return {
          success: false,
          filePath: edit.filePath,
          previousVersion,
          changeSummary: 'Pending human approval: Sensitive file change must be approved before application',
          error: `Human approval required for sensitive file "${edit.filePath}". Request created and pending.`
        };
      }
    }

    // 1. Check for stale patch / base version mismatch
    if (existingFile && edit.expectedBaseVersion !== undefined) {
      if (existingFile.version !== edit.expectedBaseVersion) {
        return {
          success: false,
          filePath: edit.filePath,
          previousVersion,
          changeSummary: 'Stale patch rejected: File version has changed since patch formulation',
          error: `Stale patch: expected version ${edit.expectedBaseVersion}, but current is ${existingFile.version}`
        };
      }
    }

    // 2. Check for content hash mismatch
    if (existingFile && edit.expectedContentHash) {
      const currentHash = existingFile.contentHash || computeContentHash(existingFile.content);
      if (currentHash !== edit.expectedContentHash) {
        return {
          success: false,
          filePath: edit.filePath,
          previousVersion,
          changeSummary: 'Hash conflict: Target file content hash has drifted',
          error: `Content hash mismatch on ${edit.filePath}`
        };
      }
    }

    // 3. Handle File Creation
    if (edit.action === 'create') {
      if (existingFile) {
        return {
          success: false,
          filePath: edit.filePath,
          previousVersion,
          changeSummary: 'File already exists: Cannot execute create action on existing file',
          error: `File ${edit.filePath} already exists at v${existingFile.version}`
        };
      }
      const createRes = await MergeManager.createFile(buildId, authorAgent, {
        action: 'create_file',
        path: edit.filePath,
        content: edit.replacementContent,
        commitMessage: edit.explanation || `Create ${edit.filePath}`
      });

      if (!createRes.success) {
        return {
          success: false,
          filePath: edit.filePath,
          previousVersion: 0,
          changeSummary: 'Failed to create file',
          error: createRes.error
        };
      }

      return {
        success: true,
        filePath: edit.filePath,
        previousVersion: 0,
        newVersion: createRes.version,
        appliedContent: edit.replacementContent,
        changeSummary: `Created new file ${edit.filePath} (v${createRes.version})`
      };
    }

    // 4. Targeted Patch / Snippet Replacement
    if (!existingFile) {
      return {
        success: false,
        filePath: edit.filePath,
        previousVersion: 0,
        changeSummary: 'Target file does not exist, cannot apply patch',
        error: `File ${edit.filePath} does not exist in workspace`
      };
    }

    const currentContent = existingFile.content;
    let newContent: string;

    if (edit.findSnippet) {
      if (!currentContent.includes(edit.findSnippet)) {
        return {
          success: false,
          filePath: edit.filePath,
          previousVersion,
          changeSummary: 'Target snippet not found in current file content',
          error: `Find snippet was not located in ${edit.filePath}`
        };
      }
      newContent = currentContent.replace(edit.findSnippet, () => edit.replacementContent);
    } else {
      newContent = edit.replacementContent;
    }

    // 5. Apply patch via MergeManager
    const patchRes = await MergeManager.applyPatch(buildId, authorAgent, {
      action: 'patch_file',
      path: edit.filePath,
      edits: edit.findSnippet ? [{ find: edit.findSnippet, replace: edit.replacementContent }] : [{ find: currentContent, replace: newContent }],
      find: edit.findSnippet || currentContent,
      replace: edit.findSnippet ? edit.replacementContent : newContent,
      expectedVersion: edit.expectedBaseVersion,
      expectedContentHash: edit.expectedContentHash,
      commitMessage: edit.explanation || `Incremental update to ${edit.filePath}`
    });

    if (!patchRes.success) {
      return {
        success: false,
        filePath: edit.filePath,
        previousVersion,
        changeSummary: 'MergeManager rejected patch',
        error: patchRes.error
      };
    }

    return {
      success: true,
      filePath: edit.filePath,
      previousVersion,
      newVersion: patchRes.version,
      appliedContent: newContent,
      changeSummary: `Safely patched ${edit.filePath} (v${previousVersion} -> v${patchRes.version})`
    };
  }

  /**
   * Generates a surgical find/replace edit for an isolated function or component without rewriting the entire file.
   */
  static formulateFunctionUpdate(
    filePath: string,
    currentFileContent: string,
    targetFunctionName: string,
    newFunctionBody: string,
    fileVersion: number
  ): IncrementalFileEdit | null {
    // Locate the target function using regex
    const funcRegex = new RegExp(`(?:export\\s+)?(?:function|const)\\s+${targetFunctionName}\\b[\\s\\S]*?\\n(?=(?:export\\s+)?(?:function|const|class|type|interface)|$)`, 'm');
    const match = currentFileContent.match(funcRegex);

    if (!match || !match[0]) {
      return null;
    }

    const findSnippet = match[0].trim();
    return {
      filePath,
      action: 'patch',
      targetSymbol: targetFunctionName,
      findSnippet,
      replacementContent: newFunctionBody.trim(),
      expectedBaseVersion: fileVersion,
      expectedContentHash: computeContentHash(currentFileContent),
      explanation: `Update function ${targetFunctionName} in ${filePath}`
    };
  }
}
