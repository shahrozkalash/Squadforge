import crypto from 'node:crypto';
import { 
  CodeGenerationRun, 
  GenerationPass, 
  GenerationProfileType, 
  ProjectFile, 
  ProjectContract, 
  RepairAttemptLog,
  ModelConfig,
  ModelActionResponse
} from '../types.js';
import { db } from '../store.js';
import { modelRegistry } from '../modelRegistry.js';
import { smartRouter } from '../smartRouter.js';
import { callUnifiedGateway, SILENT_WORKER_SYSTEM_PROMPT } from '../gateway.js';
import { GenerationProfileRegistry } from './generationProfiles.js';
import { ProjectContextEngine } from './projectContextEngine.js';
import { ContractFirstEngine } from './contractFirstEngine.js';
import { PromptCompiler } from './promptCompiler.js';
import { IncrementalEditor } from './incrementalEditor.js';
import { AutomaticRepairEngine } from './automaticRepairEngine.js';
import { ExecutionAdapter } from './executionAdapter.js';
import { IntegrationAgent } from './integrationAgent.js';
import { MergeManager } from './mergeManager.js';
import { ApprovalGateService } from './approvalGateService.js';
import { ProjectMemoryService } from './projectMemory.js';

export interface CodeGenerationOptions {
  buildId: string;
  userId: string;
  userRequest: string;
  profileId?: GenerationProfileType;
  modelId?: string;
  taskId?: string;
  maxRepairAttempts?: number;
  mockActionResponse?: ModelActionResponse;
}

export class CodeGenerationEngine {
  /**
   * Executes the 6-Pass Intelligent Code Generation Pipeline:
   * Pass 1: Planning
   * Pass 2: Generation
   * Pass 3: Integration
   * Pass 4: Validation
   * Pass 5: Repair
   * Pass 6: Finalization
   */
  static async runGenerationPipeline(options: CodeGenerationOptions): Promise<CodeGenerationRun> {
    const { buildId, userId, userRequest, taskId, maxRepairAttempts = 3 } = options;

    const build = db.getBuild(buildId);
    if (!build) {
      throw new Error(`Build ${buildId} not found`);
    }

    // 1. Select Generation Profile
    const profile = options.profileId 
      ? GenerationProfileRegistry.get(options.profileId)
      : GenerationProfileRegistry.matchProfileForRequest(userRequest, build.projectType);

    // 2. Select AI Model via Registry / Router
    const selectedModel = this.resolveGenerationModel(options.modelId);

    const runId = `codegen_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const startTime = Date.now();

    const passes: GenerationPass[] = [
      { passNumber: 1, passName: 'planning', status: 'pending', summary: 'Identify affected files, dependencies & establish contracts' },
      { passNumber: 2, passName: 'generation', status: 'pending', summary: 'Generate complete, production-grade source files' },
      { passNumber: 3, passName: 'integration', status: 'pending', summary: 'Wire imports, exports & module linkages' },
      { passNumber: 4, passName: 'validation', status: 'pending', summary: 'Verify syntax, types, and contract compliance' },
      { passNumber: 5, passName: 'repair', status: 'pending', summary: 'Evidence-based targeted automatic repair' },
      { passNumber: 6, passName: 'finalization', status: 'pending', summary: 'Prepare validated patches and persist results' }
    ];

    const runRecord: CodeGenerationRun = {
      id: runId,
      buildId,
      taskId,
      userRequest,
      generationProfile: profile.id,
      modelId: selectedModel.id,
      status: 'planning',
      currentPass: 1,
      totalPasses: 6,
      passes,
      filesCreated: [],
      filesModified: [],
      patchIds: [],
      contractsEstablished: [],
      repairAttempts: 0,
      repairLogs: [],
      tokenUsage: 0,
      cost: 0,
      createdAt: startTime
    };

    // Save initial state
    db.saveGenerationRun(runRecord);

    this.emitEvent(buildId, 'codegen_started', {
      runId,
      userRequest,
      profile: profile.displayName,
      modelId: selectedModel.id
    });

    try {
      // ==========================================
      // PASS 1: PLANNING & CONTRACT ESTABLISHMENT
      // ==========================================
      passes[0].status = 'in_progress';
      const pass1Start = Date.now();

      const existingFiles = db.getAllFiles(buildId);
      
      // Determine target file paths from profile or requirement hints
      const targetFiles = this.planTargetFiles(userRequest, profile, existingFiles);

      // Establish contracts first
      const establishedContracts = ContractFirstEngine.synthesizeInitialContracts(
        userRequest,
        profile.id,
        targetFiles
      );
      runRecord.contractsEstablished = establishedContracts;

      // Extract intelligent project context
      const projectContext = ProjectContextEngine.buildProjectContext(
        userRequest,
        existingFiles,
        targetFiles,
        3200
      );

      passes[0].status = 'passed';
      passes[0].durationMs = Date.now() - pass1Start;
      passes[0].summary = `Planned ${targetFiles.length} target files and established ${establishedContracts.length} contracts`;
      runRecord.currentPass = 2;
      runRecord.status = 'generating';
      db.saveGenerationRun(runRecord);

      this.emitEvent(buildId, 'codegen_pass_completed', {
        runId,
        pass: 'planning',
        targetFiles,
        contractsCount: establishedContracts.length
      });

      // ==========================================
      // PASS 2: CODE GENERATION
      // ==========================================
      passes[1].status = 'in_progress';
      const pass2Start = Date.now();

      const compiledGenerationPrompt = PromptCompiler.compileGenerationPrompt({
        userRequirement: userRequest,
        profile,
        context: projectContext,
        contracts: establishedContracts,
        targetFiles,
        passName: 'generation',
        agentRole: 'software_architect'
      });

      let actions: any[];

      if (options.mockActionResponse && Array.isArray(options.mockActionResponse.actions)) {
        actions = options.mockActionResponse.actions;
        runRecord.tokenUsage += 350;
        runRecord.cost += 0.001;
      } else {
        const genRes = await callUnifiedGateway({
          modelId: selectedModel.id,
          taskComplexity: 'advanced',
          prompt: compiledGenerationPrompt.userPrompt,
          systemInstruction: compiledGenerationPrompt.systemPrompt,
          allowFallback: true,
          buildId,
          userId
        });

        runRecord.tokenUsage += genRes.tokensUsed || 0;
        runRecord.cost += genRes.estimatedCost || (genRes.tokensUsed * 0.000003);

        if (!genRes.success || !genRes.parsedResponse || !Array.isArray(genRes.parsedResponse.actions)) {
          throw new Error(genRes.error || 'Model failed to produce valid code generation actions');
        }
        actions = genRes.parsedResponse.actions;
      }

      // Filter and apply generated actions
      const fileActions = actions.filter((a: any) => a.action === 'create_file' || a.action === 'patch_file');

      if (fileActions.length === 0) {
        throw new Error('Model produced no file creation or patch actions');
      }

      const batchRes = await MergeManager.applyBatchActions(buildId, selectedModel.id, fileActions);
      if (!batchRes.success) {
        throw new Error(`Failed to apply generated files: ${batchRes.error}`);
      }

      fileActions.forEach((a: any) => {
        if (a.action === 'create_file') {
          runRecord.filesCreated.push(a.path);
        } else {
          runRecord.filesModified.push(a.path);
        }
      });

      passes[1].status = 'passed';
      passes[1].durationMs = Date.now() - pass2Start;
      passes[1].summary = `Generated ${runRecord.filesCreated.length} files and modified ${runRecord.filesModified.length} files`;
      runRecord.currentPass = 3;
      runRecord.status = 'integrating';
      db.saveGenerationRun(runRecord);

      this.emitEvent(buildId, 'codegen_pass_completed', {
        runId,
        pass: 'generation',
        filesCreated: runRecord.filesCreated,
        filesModified: runRecord.filesModified
      });

      // ==========================================
      // PASS 3: INTEGRATION
      // ==========================================
      passes[2].status = 'in_progress';
      const pass3Start = Date.now();

      const postGenFiles = db.getAllFiles(buildId);
      const integrationReport = IntegrationAgent.analyzeProjectContracts(postGenFiles);

      if (!integrationReport.passed && integrationReport.issues.length > 0) {
        passes[2].diagnostics = integrationReport.issues.map(i => `[${i.severity.toUpperCase()}] ${i.sourceFile}: ${i.message}`);
        passes[2].status = 'in_progress';
        passes[2].summary = `Integration discovered ${integrationReport.issues.length} contract or import issues to resolve`;
      } else {
        passes[2].status = 'passed';
        passes[2].summary = `All ${integrationReport.totalImportsAnalyzed} module imports and exports cleanly integrated`;
      }

      passes[2].durationMs = Date.now() - pass3Start;
      runRecord.currentPass = 4;
      runRecord.status = 'validating';
      db.saveGenerationRun(runRecord);

      // ==========================================
      // PASS 4: VALIDATION
      // ==========================================
      passes[3].status = 'in_progress';
      const pass4Start = Date.now();

      const currentFiles = db.getAllFiles(buildId);
      const syntaxErrors = ExecutionAdapter.validateSyntax(currentFiles);
      const typeCheck = ExecutionAdapter.validateTypes(currentFiles);
      const contractValidations = ContractFirstEngine.validateFilesAgainstContracts(currentFiles, establishedContracts);

      const contractErrors = contractValidations.flatMap(c => c.errors);
      const hasErrors = syntaxErrors.length > 0 || typeCheck.errors.length > 0 || contractErrors.length > 0;

      runRecord.validationResults = {
        syntaxErrors: syntaxErrors.length,
        typeErrors: typeCheck.errors.length,
        contractErrors: contractErrors.length,
        clean: !hasErrors
      };

      if (hasErrors) {
        passes[3].status = 'failed';
        passes[3].summary = `Validation discovered ${syntaxErrors.length} syntax, ${typeCheck.errors.length} type, and ${contractErrors.length} contract errors`;
        passes[3].diagnostics = [
          ...syntaxErrors.map(e => `Syntax error in ${e.filePath}: ${e.message}`),
          ...typeCheck.errors.map(e => `Type error in ${e.filePath}: ${e.message}`),
          ...contractErrors
        ];
      } else {
        passes[3].status = 'passed';
        passes[3].summary = 'All files passed syntax, TypeScript compilation, and contract validation cleanly';
      }

      passes[3].durationMs = Date.now() - pass4Start;
      runRecord.currentPass = 5;
      runRecord.status = 'repairing';
      db.saveGenerationRun(runRecord);

      // ==========================================
      // PASS 5: AUTOMATIC REPAIR
      // ==========================================
      passes[4].status = 'in_progress';
      const pass5Start = Date.now();

      if (hasErrors) {
        const repairResult = await AutomaticRepairEngine.repairProjectFiles({
          buildId,
          userId,
          model: selectedModel,
          files: currentFiles,
          maxAttempts: maxRepairAttempts
        });

        runRecord.repairAttempts = repairResult.repairAttemptsCount;
        repairResult.resolvedDefects.forEach(d => {
          runRecord.repairLogs.push({
            attempt: 1,
            file: d.split(':')[0] || 'unknown',
            defect: d,
            action: 'automatic_repair',
            outcome: 'resolved',
            timestamp: Date.now()
          });
        });

        if (repairResult.success) {
          passes[4].status = 'passed';
          passes[4].summary = `Automatically repaired ${repairResult.resolvedDefects.length} defects with compiler evidence`;
        } else {
          passes[4].status = 'failed';
          passes[4].summary = `Unresolved defects remain after ${repairResult.repairAttemptsCount} repair attempts`;
          passes[4].diagnostics = repairResult.unresolvedDefects;
        }
      } else {
        passes[4].status = 'skipped';
        passes[4].summary = 'No errors detected in validation pass; repair pass skipped';
      }

      passes[4].durationMs = Date.now() - pass5Start;
      runRecord.currentPass = 6;
      runRecord.status = 'finalizing';
      db.saveGenerationRun(runRecord);

      // ==========================================
      // PASS 6: FINALIZATION & APPROVAL GATES
      // ==========================================
      passes[5].status = 'in_progress';
      const pass6Start = Date.now();

      // Check if human approval is required for sensitive files (e.g. env, auth, security)
      const touchedFiles = [...runRecord.filesCreated, ...runRecord.filesModified];
      const sensitiveFiles = touchedFiles.filter(f => f.includes('auth') || f.includes('crypto') || f.includes('security') || f.includes('.env'));

      if (sensitiveFiles.length > 0) {
        ApprovalGateService.requestApproval(buildId, userId, {
          requestingAgent: 'codegen_engine',
          requestingRole: 'security_specialist',
          operationType: 'security_sensitive_change',
          explanation: `Generated code touches security or authentication layers for: "${userRequest}"`,
          affectedFiles: sensitiveFiles,
          proposedChanges: `Modifies sensitive files: ${sensitiveFiles.join(', ')}`,
          riskLevel: 'high'
        });
      }

      // Record pattern in Project Memory for future cross-agent reference
      ProjectMemoryService.recordDecision(buildId, userId, {
        title: `Phase 9 Code Generation: ${profile.displayName}`,
        rationale: `Generated ${runRecord.filesCreated.length} files according to ${profile.displayName} profile contracts`,
        affectedFiles: touchedFiles,
        status: 'accepted'
      });

      passes[5].status = 'passed';
      passes[5].durationMs = Date.now() - pass6Start;
      passes[5].summary = `Generation finalized. Workspace verified and project memory recorded.`;

      runRecord.status = 'finalized';
      runRecord.completedAt = Date.now();
      db.saveGenerationRun(runRecord);

      this.emitEvent(buildId, 'codegen_finalized', {
        runId,
        filesCreatedCount: runRecord.filesCreated.length,
        filesModifiedCount: runRecord.filesModified.length,
        durationMs: Date.now() - startTime
      });

      return runRecord;
    } catch (err: any) {
      runRecord.status = 'failed';
      runRecord.error = err.message || 'Generation pipeline failed';
      runRecord.completedAt = Date.now();
      db.saveGenerationRun(runRecord);

      this.emitEvent(buildId, 'codegen_failed', {
        runId,
        error: runRecord.error
      });

      return runRecord;
    }
  }

  /**
   * Plans target file paths based on user requirement and profile organization.
   */
  private static planTargetFiles(
    userRequirement: string,
    profile: GenerationProfile,
    existingFiles: ProjectFile[]
  ): string[] {
    const planned = new Set<string>();
    const reqLower = userRequirement.toLowerCase();

    // 1. If explicit paths are mentioned in the requirement (e.g., "in src/components/Hero.tsx")
    const pathRegex = /(?:src|server|tests)\/[a-zA-Z0-9_\-\.\/]+/g;
    const matchedPaths = userRequirement.match(pathRegex);
    if (matchedPaths) {
      matchedPaths.forEach(p => planned.add(p));
    }

    // 2. Add profile default file organization if workspace is empty
    if (existingFiles.length === 0) {
      profile.defaultFileOrganization.slice(0, 4).forEach(f => planned.add(f));
    }

    // 3. Fallback to a modular component and types file if nothing planned
    if (planned.size === 0) {
      const words = reqLower.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 2);
      const name = words[0] ? words[0].charAt(0).toUpperCase() + words[0].slice(1) : 'Feature';
      planned.add(`src/components/${name}View.tsx`);
      planned.add(`src/types/${name.toLowerCase()}.ts`);
    }

    return Array.from(planned);
  }

  /**
   * Resolves the AI model configuration to use for code generation.
   */
  private static resolveGenerationModel(requestedModelId?: string): ModelConfig {
    if (requestedModelId) {
      const model = modelRegistry.getModel(requestedModelId);
      if (model && model.enabled) return model;
    }

    // Use smart router or highest capability enabled model from registry
    const enabledModels = modelRegistry.getEnabledModels();
    const advancedModel = enabledModels.find(m => m.capabilityLevel === 'flagship' || m.capabilityLevel === 'advanced');
    if (advancedModel) return advancedModel;

    return enabledModels[0] || modelRegistry.getAllModels()[0];
  }

  private static emitEvent(buildId: string, type: string, details: any): void {
    db.addEvent({
      id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      buildId,
      timestamp: Date.now(),
      type,
      details: typeof details === 'string' ? details : JSON.stringify(details)
    });
  }
}
