import { 
  ProjectFile, 
  AutomaticRepairResult, 
  RepairAttemptLog,
  ModelConfig 
} from '../types.js';
import { db } from '../store.js';
import { ExecutionAdapter } from './executionAdapter.js';
import { IntegrationAgent, IntegrationIssue } from './integrationAgent.js';
import { CollaborativeDebuggingEngine } from './collaborativeDebuggingEngine.js';
import { MergeManager } from './mergeManager.js';
import { callUnifiedGateway, SILENT_WORKER_SYSTEM_PROMPT } from '../gateway.js';
import { PromptCompiler } from './promptCompiler.js';
import { GenerationProfileRegistry } from './generationProfiles.js';
import { ProjectContextEngine } from './projectContextEngine.js';

export class AutomaticRepairEngine {
  private static MAX_REPAIR_ATTEMPTS = 3;

  /**
   * Performs evidence-based automatic repair on generated code with real compiler/AST diagnostics.
   * Retries within configurable limit and reports unresolved errors honestly.
   */
  static async repairProjectFiles(params: {
    buildId: string;
    userId: string;
    model: ModelConfig;
    files: ProjectFile[];
    maxAttempts?: number;
  }): Promise<AutomaticRepairResult> {
    const { buildId, userId, model, maxAttempts = this.MAX_REPAIR_ATTEMPTS } = params;
    let currentFiles = [...params.files];
    const resolvedDefects: string[] = [];
    const unresolvedDefects: string[] = [];
    const modifiedFiles = new Set<string>();
    let attemptsCount = 0;

    while (attemptsCount < maxAttempts) {
      attemptsCount++;

      // 1. Gather Real Evidence: Check syntax & types via ExecutionAdapter
      const syntaxErrors = ExecutionAdapter.validateSyntax(currentFiles);
      const typeCheck = ExecutionAdapter.validateTypes(currentFiles);
      const integration = IntegrationAgent.analyzeProjectContracts(currentFiles);

      const activeIssues: Array<{ file: string; message: string; line?: number; kind: 'syntax' | 'type' | 'integration' }> = [];

      for (const err of syntaxErrors) {
        activeIssues.push({
          file: err.filePath,
          message: `Syntax error: ${err.message}`,
          line: err.line,
          kind: 'syntax'
        });
      }

      for (const err of typeCheck.errors) {
        activeIssues.push({
          file: err.filePath,
          message: `Type error [${err.code}]: ${err.message}`,
          line: err.line,
          kind: 'type'
        });
      }

      for (const issue of integration.issues) {
        if (issue.severity === 'error') {
          activeIssues.push({
            file: issue.sourceFile,
            message: `Integration defect: ${issue.message}`,
            kind: 'integration'
          });
        }
      }

      // If zero defects, we have validated evidence of cleanliness!
      if (activeIssues.length === 0) {
        return {
          success: true,
          resolvedDefects,
          unresolvedDefects: [],
          repairAttemptsCount: attemptsCount - 1, // Prior attempt or initial was clean
          modifiedFiles: Array.from(modifiedFiles),
          validationEvidence: {
            syntaxPassed: true,
            typeCheckPassed: true,
            integrationPassed: true
          }
        };
      }

      // 2. Select highest priority defect to repair
      const targetIssue = activeIssues[0];
      const targetFile = currentFiles.find(f => f.path === targetIssue.file);

      if (!targetFile) {
        unresolvedDefects.push(`Target file "${targetIssue.file}" not found in workspace: ${targetIssue.message}`);
        break;
      }

      // 3. Formulate targeted repair prompt using PromptCompiler
      const profile = GenerationProfileRegistry.get('website_and_web_app');
      const context = ProjectContextEngine.buildProjectContext(targetIssue.message, currentFiles, [targetIssue.file], 2000);

      const compiledPrompt = PromptCompiler.compileGenerationPrompt({
        userRequirement: `Fix defect in ${targetIssue.file}`,
        profile,
        context,
        contracts: [],
        targetFiles: [targetIssue.file],
        passName: 'repair',
        agentRole: 'debugging_specialist',
        diagnosticEvidence: `FILE: ${targetIssue.file}\nLINE: ${targetIssue.line || 'N/A'}\nERROR: ${targetIssue.message}`
      });

      // 4. Request surgical repair from model gateway
      const gatewayRes = await callUnifiedGateway({
        modelId: model.id,
        taskComplexity: 'standard',
        prompt: compiledPrompt.userPrompt,
        systemInstruction: compiledPrompt.systemPrompt,
        allowFallback: true,
        buildId,
        userId
      });

      if (!gatewayRes.success || !gatewayRes.parsedResponse || !Array.isArray(gatewayRes.parsedResponse.actions)) {
        unresolvedDefects.push(`Repair model produced invalid response for ${targetIssue.file}: ${gatewayRes.error || 'Empty actions'}`);
        continue;
      }

      // 5. Apply the repair actions via MergeManager
      const actions = gatewayRes.parsedResponse.actions.filter((a: any) => a.path === targetIssue.file);
      if (actions.length === 0) {
        unresolvedDefects.push(`Model returned no actions addressing ${targetIssue.file}`);
        continue;
      }

      const mergeRes = await MergeManager.applyBatchActions(buildId, model.id, actions);
      if (mergeRes.success) {
        resolvedDefects.push(`${targetIssue.file}: ${targetIssue.message}`);
        modifiedFiles.add(targetIssue.file);
        // Refresh local currentFiles from db
        currentFiles = db.getAllFiles(buildId);

        // Record defect resolution in collaborative debugging engine if tracked
        CollaborativeDebuggingEngine.recordDefect(buildId, userId, {
          title: `Resolved: ${targetIssue.message.slice(0, 80)}`,
          description: targetIssue.message,
          severity: 'medium',
          identifiedByAgent: 'automatic_repair_engine',
          identifiedByRole: 'debugging_specialist',
          affectedFiles: [targetIssue.file],
          symptoms: [targetIssue.message]
        });
      } else {
        unresolvedDefects.push(`Failed to apply repair patch to ${targetIssue.file}: ${mergeRes.error}`);
      }
    }

    // Final verification after loop
    const finalSyntax = ExecutionAdapter.validateSyntax(currentFiles);
    const finalTypes = ExecutionAdapter.validateTypes(currentFiles);
    const allClean = finalSyntax.length === 0 && finalTypes.errors.length === 0;

    return {
      success: allClean,
      resolvedDefects,
      unresolvedDefects: allClean ? [] : unresolvedDefects,
      repairAttemptsCount: attemptsCount,
      modifiedFiles: Array.from(modifiedFiles),
      validationEvidence: {
        syntaxErrorsCount: finalSyntax.length,
        typeErrorsCount: finalTypes.errors.length,
        clean: allClean
      }
    };
  }
}
