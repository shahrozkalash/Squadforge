import { db } from '../store.js';
import { MergeManager } from './mergeManager.js';
import { INITIAL_MODEL_REGISTRY } from '../modelRegistry.js';

export interface ConcurrencyTestReport {
  success: boolean;
  testBuildId: string;
  targetFile: string;
  initialVersion: number;
  finalVersion: number;
  totalModels: number;
  allModelsPresent: boolean;
  modelResults: Array<{
    modelId: string;
    modelName: string;
    attempts: number;
    success: boolean;
    appliedVersion?: number;
    editSignature: string;
  }>;
  finalContent: string;
  elapsedMs: number;
  verdict: string;
}

export class ConcurrencyTester {
  /**
   * Simulates 10 models simultaneously patching the exact same file.
   * Confirms that no edit is lost and the final file contains every model's change.
   */
  static async run10ModelConcurrencyTest(): Promise<ConcurrencyTestReport> {
    const startTime = Date.now();
    const testBuildId = `test_build_${Date.now()}`;
    const testFilePath = 'src/concurrency_test_module.ts';

    // 1. Create the initial base file
    const initialContent = `/**
 * SquadForge Concurrency Benchmark
 * Target file for simultaneous 10-model concurrent patching
 */

export interface WorkerContribution {
  model: string;
  status: string;
  timestamp: number;
}

export const registeredWorkers: string[] = [
  // INSERT_WORKER_NAMES_HERE
];

export function executeAllWorkers(): void {
  // WORKER_DISPATCH_HOOKS_HERE
}
`;

    // Initialize build in memory store
    db.saveBuild({
      id: testBuildId,
      userId: 'test_runner',
      idea: '10-Model Concurrency Stress Test',
      status: 'running',
      createdAt: startTime,
      updatedAt: startTime,
      selectedModels: INITIAL_MODEL_REGISTRY.slice(0, 10).map(m => m.id),
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 10,
      maxDurationSeconds: 120,
      patchesAppliedCount: 0
    });

    const createResult = await MergeManager.createFile(testBuildId, 'system', {
      action: 'create_file',
      path: testFilePath,
      content: initialContent,
      commitMessage: 'Initialize concurrency test target file'
    });

    if (!createResult.success) {
      throw new Error(`Failed to create test file: ${createResult.error}`);
    }

    const testModels = INITIAL_MODEL_REGISTRY.slice(0, 10);
    const modelReports: ConcurrencyTestReport['modelResults'] = [];

    // 2. Launch 10 models SIMULTANEOUSLY in parallel with Promise.all
    const workerPromises = testModels.map(async (model) => {
      const editSignature = `WORKER_SLOT_${model.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      let attempts = 0;
      let applied = false;
      let appliedVersion = -1;

      // Retry loop (up to 3 retries per Section 5 spec)
      while (!applied && attempts < 4) {
        attempts++;

        // Read current state of file
        const currentFile = db.getFile(testBuildId, testFilePath);
        if (!currentFile) break;

        // Formulate surgical patch against current file content
        // Model inserts its name into registeredWorkers and its execution hook
        const findAnchor = currentFile.content.includes(editSignature) 
          ? null // already inserted!
          : '// INSERT_WORKER_NAMES_HERE';

        if (!findAnchor) {
          applied = true;
          break;
        }

        const replacement = `  "${model.id}", // Added by ${model.displayName}\n  // INSERT_WORKER_NAMES_HERE`;

        const patchResult = await MergeManager.applyPatch(testBuildId, model.id, {
          action: 'patch_file',
          path: testFilePath,
          edits: [
            {
              find: findAnchor,
              replace: replacement
            }
          ],
          commitMessage: `Concurrent patch by ${model.id} (attempt ${attempts})`
        });

        if (patchResult.success) {
          applied = true;
          appliedVersion = patchResult.version || -1;
        } else {
          // Micro backoff before retry to mimic realistic model turnaround
          await new Promise(r => setTimeout(r, 10 + Math.random() * 20));
        }
      }

      modelReports.push({
        modelId: model.id,
        modelName: model.displayName,
        attempts,
        success: applied,
        appliedVersion,
        editSignature
      });
    });

    await Promise.all(workerPromises);

    // 3. Inspect final file content
    const finalFile = db.getFile(testBuildId, testFilePath);
    const finalContent = finalFile?.content || '';

    // Verify all 10 models are present in the final file
    const missingModels: string[] = [];
    for (const model of testModels) {
      if (!finalContent.includes(`"${model.id}"`)) {
        missingModels.push(model.id);
      }
    }

    const allModelsPresent = missingModels.length === 0;
    const finalVersion = finalFile?.version || 1;
    const elapsedMs = Date.now() - startTime;
    const isSuccess = allModelsPresent && finalVersion >= 11; // 1 initial + 10 patches

    const verdict = isSuccess 
      ? `SUCCESS: All 10 AI models concurrently patched the exact same file in parallel without conflict. Exactly 0 edits lost across ${finalVersion} revisions (${elapsedMs}ms).`
      : `FAILED: Missing edits for models: ${missingModels.join(', ')}`;

    return {
      success: isSuccess,
      testBuildId,
      targetFile: testFilePath,
      initialVersion: 1,
      finalVersion,
      totalModels: testModels.length,
      allModelsPresent,
      modelResults: modelReports,
      finalContent,
      elapsedMs,
      verdict
    };
  }
}
