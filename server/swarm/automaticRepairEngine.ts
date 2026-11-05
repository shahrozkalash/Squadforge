import { 
  ProjectFile, 
  AutomaticRepairResult, 
  RepairAttemptLog,
  ModelConfig,
  ProjectContract
} from '../types.js';
import { db } from '../store.js';
import { ExecutionAdapter } from './executionAdapter.js';
import { IntegrationAgent, IntegrationIssue } from './integrationAgent.js';
import { ContractFirstEngine } from './contractFirstEngine.js';
import { CollaborativeDebuggingEngine } from './collaborativeDebuggingEngine.js';
import { MergeManager } from './mergeManager.js';
import { callUnifiedGateway } from '../gateway.js';
import { PromptCompiler } from './promptCompiler.js';
import { GenerationProfileRegistry } from './generationProfiles.js';
import { ProjectContextEngine } from './projectContextEngine.js';
import { ApprovalGateService } from './approvalGateService.js';
import { RepairPatchValidator } from '../debugging/repairPatchValidator.js';
import { runCheckTask } from '../debugging/staticChecks.js';

export interface RepairIssue {
  file: string;
  message: string;
  line?: number;
  kind: 'syntax' | 'type' | 'integration' | 'contract';
  key: string;
}

export interface RepairValidationSnapshot {
  syntaxPassed: boolean;
  typeCheckPassed: boolean;
  integrationPassed: boolean;
  contractPassed: boolean;
  configPassed: boolean;
  clean: boolean;
  issues: RepairIssue[];
  syntaxErrorsCount: number;
  typeErrorsCount: number;
  integrationErrorsCount: number;
  contractErrorsCount: number;
  configErrorsCount: number;
  diagnostics: string[];
}

export class AutomaticRepairEngine {
  private static MAX_REPAIR_ATTEMPTS = 3;

  /**
   * Evaluates all 5 validation dimensions across workspace files:
   * 1. Syntax (esbuild / JSON AST)
   * 2. TypeScript diagnostics (compiler)
   * 3. Import & export integrity
   * 4. Integration contracts
   * 5. Dependency & config integrity
   */
  static evaluateValidationDimensions(
    files: ProjectFile[],
    contracts: ProjectContract[] = []
  ): RepairValidationSnapshot {
    const syntaxErrors = ExecutionAdapter.validateSyntax(files);
    const typeCheck = ExecutionAdapter.validateTypes(files);
    const integration = IntegrationAgent.analyzeProjectContracts(files);
    const contractValidations = ContractFirstEngine.validateFilesAgainstContracts(files, contracts);
    const configErrors = ExecutionAdapter.validateConfigs(files);

    const integrationErrors = integration.issues.filter(i => i.severity === 'error');
    const contractErrors = contractValidations.flatMap(c => c.errors);

    const diagnostics: string[] = [
      ...syntaxErrors.map(e => `[SYNTAX] ${e.filePath}${e.line ? `:${e.line}` : ''}: ${e.message}`),
      ...typeCheck.errors.map(e => `[TYPE ${e.code}] ${e.filePath}${e.line ? `:${e.line}` : ''}: ${e.message}`),
      ...integrationErrors.map(e => `[INTEGRATION] ${e.sourceFile}: ${e.message}`),
      ...contractErrors.map(e => `[CONTRACT] ${e}`),
      ...configErrors.map(e => `[CONFIG] ${e}`)
    ];

    const clean = diagnostics.length === 0;

    const issues: RepairIssue[] = [
      ...syntaxErrors.map(err => ({
        file: err.filePath,
        message: `Syntax error: ${err.message}`,
        line: err.line,
        kind: 'syntax' as const,
        key: `syntax:${err.filePath}:${err.message}`
      })),
      ...typeCheck.errors.map(err => ({
        file: err.filePath,
        message: `Type error [${err.code}]: ${err.message}`,
        line: err.line,
        kind: 'type' as const,
        key: `type:${err.filePath}:${err.code}:${err.message}`
      })),
      ...integrationErrors.map(issue => ({
        file: issue.sourceFile,
        message: `Integration defect: ${issue.message}`,
        kind: 'integration' as const,
        key: `integration:${issue.sourceFile}:${issue.message}`
      })),
      ...contractValidations.flatMap(result => result.errors.map(err => ({
        file: result.contract.filePath,
        message: `Contract defect: ${err}`,
        kind: 'contract' as const,
        key: `contract:${result.contract.filePath}:${err}`
      })))
    ];

    return {
      syntaxPassed: syntaxErrors.length === 0,
      typeCheckPassed: typeCheck.errors.length === 0,
      integrationPassed: integrationErrors.length === 0,
      contractPassed: contractErrors.length === 0,
      configPassed: configErrors.length === 0,
      clean,
      issues,
      syntaxErrorsCount: syntaxErrors.length,
      typeErrorsCount: typeCheck.errors.length,
      integrationErrorsCount: integrationErrors.length,
      contractErrorsCount: contractErrors.length,
      configErrorsCount: configErrors.length,
      diagnostics
    };
  }

  /** The same checks in the check process, so a slow type check does not hold up the server. */
  static checkDimensions(
    files: ProjectFile[],
    contracts: ProjectContract[] = [],
    signal?: AbortSignal
  ): Promise<RepairValidationSnapshot> {
    return runCheckTask<RepairValidationSnapshot>(
      'dimensions',
      files,
      contracts,
      signal
    );
  }

  /**
   * Performs evidence-based automatic repair on generated code with real compiler/AST diagnostics.
   * Validates syntax, TypeScript diagnostics, import/export integrity, integration contracts,
   * and dependency integrity. Re-verifies every patch to prevent false success.
   */
  static async repairProjectFiles(params: {
    buildId: string;
    userId: string;
    model: ModelConfig;
    files: ProjectFile[];
    contracts?: ProjectContract[];
    maxAttempts?: number;
    signal?: AbortSignal;
  }): Promise<AutomaticRepairResult> {
    const { buildId, userId, model, contracts = [], maxAttempts = this.MAX_REPAIR_ATTEMPTS, signal } = params;
    let currentFiles = [...params.files];
    const resolvedDefects: string[] = [];
    const unresolvedDefects: string[] = [];
    const modifiedFiles = new Set<string>();
    let attemptsCount = 0;

    while (attemptsCount < maxAttempts) {
      if (signal?.aborted) break;

      attemptsCount++;

      // 1. Gather Real Evidence across all validation dimensions
      const snapshot = await this.checkDimensions(currentFiles, contracts, signal);

      // If zero defects across all dimensions, return validated success
      if (snapshot.clean) {
        return {
          success: true,
          resolvedDefects,
          unresolvedDefects: [],
          repairAttemptsCount: attemptsCount - 1,
          modifiedFiles: Array.from(modifiedFiles),
          validationEvidence: snapshot
        };
      }

      const activeIssues = snapshot.issues;

      if (activeIssues.length === 0) {
        // Only warnings or configs left
        break;
      }

      // 2. Select highest priority defect to repair
      // Sensitive files are skipped, so they do not use up attempts for ordinary defects
      const isBlocked = (issue: { file: string }) => ApprovalGateService.isSensitiveFilePath(issue.file);
      for (const issue of activeIssues.filter(isBlocked)) {
        unresolvedDefects.push(`Cannot automatically repair sensitive file "${issue.file}" without a new human approval: ${issue.message}`);
      }
      const targetIssue = activeIssues.find(issue => !isBlocked(issue));
      if (!targetIssue) break;
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
        contracts,
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
        userId,
        signal
      });

      if (signal?.aborted) break;

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

      // A repair must never make the project worse, so a copy is checked before the real write
      const dryRun = RepairPatchValidator.normalize(actions);
      const candidate = RepairPatchValidator.applyToCopy(currentFiles, dryRun.actions);
      if (dryRun.rejected.length > 0 || !candidate.files) {
        unresolvedDefects.push(`Repair of ${targetIssue.file} refused before applying: ${dryRun.rejected[0] || candidate.error}`);
        continue;
      }
      const candidateSnapshot = await this.checkDimensions(candidate.files, contracts, signal);
      const withoutLine = (d: string) => d.replace(/:\d+:/, ':');
      const known = new Set(snapshot.diagnostics.map(withoutLine));
      const introduced = candidateSnapshot.diagnostics.filter(d => !known.has(withoutLine(d)));
      if (introduced.length > 0) {
        unresolvedDefects.push(`Repair of ${targetIssue.file} refused before applying, because it adds a defect: ${introduced[0]}`);
        continue;
      }

      const mergeRes = await MergeManager.applyBatchActions(buildId, model.id, actions, { signal });
      if (mergeRes.success) {
        modifiedFiles.add(targetIssue.file);
        // Refresh local currentFiles from db to inspect real modified state
        currentFiles = db.getAllFiles(buildId);

        // STRENGTHENED REPAIR VERIFICATION:
        // Do NOT mark defect resolved merely because patch was applied!
        // Verify against real compiler/integration evidence:
        const postPatchSnapshot = await this.checkDimensions(currentFiles, contracts, signal);
        const defectPersists = postPatchSnapshot.diagnostics.some(d => d.includes(targetIssue.message) || (targetIssue.line && d.includes(`${targetIssue.file}:${targetIssue.line}`)));

        if (!defectPersists) {
          resolvedDefects.push(`${targetIssue.file}: ${targetIssue.message}`);
          CollaborativeDebuggingEngine.recordDefect(buildId, userId, {
            title: `Resolved: ${targetIssue.message.slice(0, 80)}`,
            description: targetIssue.message,
            severity: 'medium',
            reproductionSteps: [`Automated compiler check for ${targetIssue.file}`],
            expectedBehavior: 'Error-free compilation',
            actualBehavior: 'Defect successfully resolved with compiler evidence',
            affectedFiles: [targetIssue.file],
            assignedAgent: 'debugging_specialist',
            authorRole: 'debugging_specialist'
          });
        } else {
          unresolvedDefects.push(`Patch applied to ${targetIssue.file} but defect persisted: ${targetIssue.message}`);
        }
      } else {
        unresolvedDefects.push(`Failed to apply repair patch to ${targetIssue.file}: ${mergeRes.error}`);
      }
    }

    // Final verification after repair loop across ALL dimensions
    const finalSnapshot = await this.checkDimensions(currentFiles, contracts, signal);
    const allClean = finalSnapshot.clean;

    const remainingDefects = allClean 
      ? [] 
      : Array.from(new Set([...unresolvedDefects, ...finalSnapshot.diagnostics]));

    return {
      success: allClean,
      resolvedDefects,
      unresolvedDefects: remainingDefects,
      repairAttemptsCount: attemptsCount,
      modifiedFiles: Array.from(modifiedFiles),
      validationEvidence: finalSnapshot
    };
  }
}
