import crypto from 'node:crypto';
import { 
  CodeGenerationRun, 
  GenerationPass, 
  GenerationProfile,
  GenerationProfileType, 
  ProjectFile, 
  ProjectContract, 
  RepairAttemptLog,
  ModelConfig,
  ModelActionResponse,
  ArchitectureDecision,
  EventType
} from '../types.js';
import { db } from '../store.js';
import { modelRegistry } from '../modelRegistry.js';
import { smartRouter } from '../smartRouter.js';
import { callUnifiedGateway } from '../gateway.js';
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
  userId?: string;
  userRequest: string;
  profileId?: GenerationProfileType;
  modelId?: string;
  taskId?: string;
  maxRepairAttempts?: number;
  mockActionResponse?: ModelActionResponse;
  mockAiResponse?: ModelActionResponse;
  approvalGranted?: boolean;
}

export class CodeGenerationEngine {
  private static activeRuns: Map<string, {
    buildId: string;
    isCancelled: boolean;
    cancellationReason?: string;
    cancelledAt?: number;
  }> = new Map();

  /**
   * Immediately cancels an active or queued generation run in-memory and in the database.
   * Stops further model requests and patch applications.
   */
  static cancelRun(runId: string, reason: string = 'Run was cancelled by user'): boolean {
    const active = this.activeRuns.get(runId);
    if (active) {
      active.isCancelled = true;
      active.cancellationReason = reason;
      active.cancelledAt = Date.now();
    }

    const run = db.getGenerationRun(runId);
    if (run && run.status !== 'finalized' && run.status !== 'failed' && run.status !== 'completed_with_warnings') {
      run.status = 'cancelled';
      run.error = reason;
      (run as any).cancellationReason = reason;
      (run as any).cancelledAt = Date.now();
      run.completedAt = Date.now();
      db.saveGenerationRun(run);
      return true;
    }
    return active?.isCancelled ?? false;
  }

  /**
   * Checks if a run has been marked cancelled either in memory or storage.
   */
  static isRunCancelled(runId: string): boolean {
    const active = this.activeRuns.get(runId);
    if (active?.isCancelled) return true;
    const run = db.getGenerationRun(runId);
    return run?.status === 'cancelled';
  }

  /**
   * Returns active, non-finalized generation runs for a build.
   */
  static getActiveRunsForBuild(buildId: string): Array<{ id: string; isCancelled: boolean }> {
    const list: Array<{ id: string; isCancelled: boolean }> = [];
    for (const [id, state] of this.activeRuns.entries()) {
      if (state.buildId === buildId) {
        list.push({ id, isCancelled: state.isCancelled });
      }
    }
    const storedRuns = db.getGenerationRuns(buildId);
    for (const r of storedRuns) {
      if (!list.some(l => l.id === r.id) && r.status !== 'finalized' && r.status !== 'failed' && r.status !== 'cancelled') {
        list.push({ id: r.id, isCancelled: false });
      }
    }
    return list;
  }

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
    const build = db.getBuild(options.buildId);
    if (!build) {
      throw new Error(`Build ${options.buildId} not found`);
    }

    const { 
      buildId, 
      userId = build.userId || 'system', 
      userRequest, 
      taskId, 
      maxRepairAttempts = 3, 
      approvalGranted = false 
    } = options;

    // 1. Select Generation Profile
    const profile = options.profileId 
      ? GenerationProfileRegistry.get(options.profileId)
      : GenerationProfileRegistry.matchProfileForRequest(userRequest, build.projectType);

    // 2. Select AI Model via Registry / Router
    const selectedModel = this.resolveGenerationModel(options.modelId);

    const runId = `codegen_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const startTime = Date.now();

    // Register active run
    this.activeRuns.set(runId, { buildId, isCancelled: false });

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

    // Helper to evaluate and apply cancellation
    const checkCancelled = (currentPassIndex?: number): boolean => {
      const active = this.activeRuns.get(runId);
      const dbRun = db.getGenerationRun(runId);
      if (active?.isCancelled || dbRun?.status === 'cancelled') {
        const reason = active?.cancellationReason || dbRun?.error || 'Run was cancelled by user';
        const timestamp = active?.cancelledAt || dbRun?.completedAt || Date.now();
        runRecord.status = 'cancelled';
        runRecord.error = reason;
        (runRecord as any).cancellationReason = reason;
        (runRecord as any).cancelledAt = timestamp;
        runRecord.completedAt = timestamp;

        if (currentPassIndex !== undefined && passes[currentPassIndex]) {
          passes[currentPassIndex].status = 'failed';
          passes[currentPassIndex].summary = `Cancelled: ${reason}`;
        }

        db.saveGenerationRun(runRecord);
        this.emitEvent(buildId, 'codegen_cancelled', {
          runId,
          reason,
          timestamp,
          filesCreated: runRecord.filesCreated,
          filesModified: runRecord.filesModified
        });
        return true;
      }
      return false;
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
      if (checkCancelled(0)) return runRecord;

      // ==========================================
      // PASS 1: PLANNING & CONTRACT ESTABLISHMENT
      // ==========================================
      passes[0].status = 'in_progress';
      this.emitEvent(buildId, 'codegen_pass_started', { runId, pass: 'planning', passNumber: 1 });
      const pass1Start = Date.now();

      const existingFiles = db.getAllFiles(buildId);
      const mockPaths = (options.mockActionResponse?.actions || options.mockAiResponse?.actions || []).map((a: any) => a.path).filter(Boolean);
      
      // Determine target file paths from profile or requirement hints
      const targetFiles = this.planTargetFiles(userRequest, profile, existingFiles, mockPaths);

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
      if (checkCancelled(1)) return runRecord;
      passes[1].status = 'in_progress';
      this.emitEvent(buildId, 'codegen_pass_started', { runId, pass: 'generation', passNumber: 2 });
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

      const mockResponse = options.mockActionResponse || options.mockAiResponse;
      if (mockResponse && Array.isArray(mockResponse.actions)) {
        actions = mockResponse.actions;
        runRecord.tokenUsage += 350;
        runRecord.cost += 0.001;
      } else {
        if (checkCancelled(1)) return runRecord;
        const genRes = await callUnifiedGateway({
          modelId: selectedModel.id,
          taskComplexity: 'flagship',
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

      // Filter generated file actions
      const fileActions = actions.filter((a: any) => a.action === 'create_file' || a.action === 'patch_file');

      if (fileActions.length === 0) {
        throw new Error('No actionable files: Model produced no file creation or patch actions');
      }

      // SENSITIVE FILE DETECTION BEFORE APPLICATION:
      // Inspect target files before writing to disk or database
      const proposedPaths = fileActions.map((a: any) => a.path);
      const sensitiveFiles = proposedPaths.filter((p: string) => ApprovalGateService.isSensitiveFilePath(p));
      const hasValidApproval = sensitiveFiles.length > 0 && ApprovalGateService.hasApprovedRequestForFiles(buildId, sensitiveFiles);

      if (sensitiveFiles.length > 0 && !hasValidApproval) {
        // Request human approval and hold patch in pending state
        ApprovalGateService.requestApproval(buildId, userId, {
          requestingAgent: selectedModel.id,
          requestingRole: 'security_specialist',
          operationType: 'security_sensitive_change',
          explanation: `Generated code touches sensitive security/auth/env files: ${sensitiveFiles.join(', ')}`,
          affectedFiles: sensitiveFiles,
          proposedChanges: `Proposed code generation touches: ${sensitiveFiles.join(', ')}`,
          riskLevel: 'high'
        });

        passes[1].status = 'failed';
        passes[1].durationMs = Date.now() - pass2Start;
        passes[1].summary = `Sensitive file modification detected (${sensitiveFiles.join(', ')}). Awaiting human approval.`;
        passes[1].diagnostics = sensitiveFiles.map(f => `Pending approval gate: ${f}`);

        runRecord.status = 'pending_approval';
        runRecord.requiresApproval = true;
        runRecord.currentPass = 2;
        runRecord.error = `Human approval required for sensitive files: ${sensitiveFiles.join(', ')}`;
        runRecord.completedAt = Date.now();
        db.saveGenerationRun(runRecord);

        this.emitEvent(buildId, 'codegen_approval_required', {
          runId,
          sensitiveFiles,
          message: 'Generated files require human approval before application'
        });

        return runRecord;
      }

      if (checkCancelled(1)) return runRecord;

      // Apply batch actions atomically
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
      if (checkCancelled(2)) return runRecord;
      passes[2].status = 'in_progress';
      this.emitEvent(buildId, 'codegen_pass_started', { runId, pass: 'integration', passNumber: 3 });
      const pass3Start = Date.now();

      const postGenFiles = db.getAllFiles(buildId);
      const integrationReport = IntegrationAgent.analyzeProjectContracts(postGenFiles);

      if (!integrationReport.passed && integrationReport.issues.length > 0) {
        passes[2].diagnostics = integrationReport.issues.map(i => `[${i.severity.toUpperCase()}] ${i.sourceFile}: ${i.message}`);
        passes[2].status = 'failed';
        passes[2].summary = `Integration discovered ${integrationReport.issues.length} contract or import issues to resolve`;
      } else {
        passes[2].status = 'passed';
        passes[2].summary = `All ${integrationReport.totalImportsAnalyzed} module imports and exports cleanly integrated`;
      }

      passes[2].durationMs = Date.now() - pass3Start;
      runRecord.currentPass = 4;
      runRecord.status = 'validating';
      db.saveGenerationRun(runRecord);

      this.emitEvent(buildId, 'codegen_pass_completed', {
        runId,
        pass: 'integration',
        status: passes[2].status,
        issuesCount: integrationReport.issues.length
      });

      // ==========================================
      // PASS 4: VALIDATION
      // ==========================================
      if (checkCancelled(3)) return runRecord;
      passes[3].status = 'in_progress';
      this.emitEvent(buildId, 'codegen_pass_started', { runId, pass: 'validation', passNumber: 4 });
      const pass4Start = Date.now();

      const currentFiles = db.getAllFiles(buildId);
      const validationSnapshot = AutomaticRepairEngine.evaluateValidationDimensions(currentFiles, establishedContracts);
      const hasErrors = !validationSnapshot.clean;

      runRecord.validationResults = {
        syntaxErrors: validationSnapshot.syntaxErrorsCount,
        typeErrors: validationSnapshot.typeErrorsCount,
        integrationErrors: validationSnapshot.integrationErrorsCount,
        contractErrors: validationSnapshot.contractErrorsCount,
        configErrors: validationSnapshot.configErrorsCount,
        syntaxPassed: validationSnapshot.syntaxPassed,
        typeCheckPassed: validationSnapshot.typeCheckPassed,
        integrationPassed: validationSnapshot.integrationPassed,
        contractPassed: validationSnapshot.contractPassed,
        configPassed: validationSnapshot.configPassed,
        clean: validationSnapshot.clean
      };

      if (hasErrors) {
        passes[3].status = 'failed';
        passes[3].summary = `Validation discovered ${validationSnapshot.diagnostics.length} issues across project files`;
        passes[3].diagnostics = validationSnapshot.diagnostics;
      } else {
        passes[3].status = 'passed';
        passes[3].summary = 'All files passed syntax, TypeScript compilation, and contract validation cleanly';
      }

      passes[3].durationMs = Date.now() - pass4Start;
      runRecord.currentPass = 5;
      runRecord.status = 'repairing';
      db.saveGenerationRun(runRecord);

      this.emitEvent(buildId, 'codegen_pass_completed', {
        runId,
        pass: 'validation',
        status: passes[3].status,
        errorsCount: validationSnapshot.diagnostics.length
      });

      // ==========================================
      // PASS 5: AUTOMATIC REPAIR
      // ==========================================
      if (checkCancelled(4)) return runRecord;
      passes[4].status = 'in_progress';
      this.emitEvent(buildId, 'codegen_pass_started', { runId, pass: 'repair', passNumber: 5 });
      const pass5Start = Date.now();

      let repairFailed = false;

      if (hasErrors) {
        const repairResult = await AutomaticRepairEngine.repairProjectFiles({
          buildId,
          userId,
          model: selectedModel,
          files: currentFiles,
          contracts: establishedContracts,
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
          repairFailed = true;
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

      this.emitEvent(buildId, 'codegen_pass_completed', {
        runId,
        pass: 'repair',
        status: passes[4].status,
        repairedCount: runRecord.repairLogs.length
      });

      // ==========================================
      // PASS 6: FINALIZATION & STRICT COMPLETION VERIFICATION
      // ==========================================
      if (checkCancelled(5)) return runRecord;
      passes[5].status = 'in_progress';
      this.emitEvent(buildId, 'codegen_pass_started', { runId, pass: 'finalization', passNumber: 6 });
      const pass6Start = Date.now();

      // Finalization must strictly revalidate the latest workspace state directly from storage
      const finalWorkspaceFiles = db.getAllFiles(buildId);
      const finalVerification = AutomaticRepairEngine.evaluateValidationDimensions(finalWorkspaceFiles, establishedContracts);

      runRecord.validationResults = {
        syntaxErrors: finalVerification.syntaxErrorsCount,
        typeErrors: finalVerification.typeErrorsCount,
        integrationErrors: finalVerification.integrationErrorsCount,
        contractErrors: finalVerification.contractErrorsCount,
        configErrors: finalVerification.configErrorsCount,
        syntaxPassed: finalVerification.syntaxPassed,
        typeCheckPassed: finalVerification.typeCheckPassed,
        integrationPassed: finalVerification.integrationPassed,
        contractPassed: finalVerification.contractPassed,
        configPassed: finalVerification.configPassed,
        clean: finalVerification.clean
      };

      // STRICT COMPLETION RULES:
      // 1. All five validation dimensions must be satisfied: Syntax, TypeScript, Integration, Contracts, Config
      // 2. A failed repair or unresolved defects must never produce a successful finalized run
      // 3. A failed validation must not be treated as success
      const allFivePassed = 
        finalVerification.syntaxPassed &&
        finalVerification.typeCheckPassed &&
        finalVerification.integrationPassed &&
        finalVerification.contractPassed &&
        finalVerification.configPassed;

      if (repairFailed || !finalVerification.clean || !allFivePassed) {
        passes[5].status = 'failed';
        passes[5].durationMs = Date.now() - pass6Start;
        passes[5].summary = `Finalization rejected: Workspace contains ${finalVerification.diagnostics.length} unresolved defects.`;
        passes[5].diagnostics = finalVerification.diagnostics;

        runRecord.status = 'failed';
        runRecord.error = `Generation failed validation: ${finalVerification.diagnostics[0] || 'Critical unresolved defects in workspace'}`;
        runRecord.completedAt = Date.now();
        db.saveGenerationRun(runRecord);

        this.emitEvent(buildId, 'codegen_failed', {
          runId,
          error: runRecord.error,
          unresolvedCount: finalVerification.diagnostics.length
        });

        return runRecord;
      }

      // Check if warnings exist
      const hasWarnings = finalVerification.configErrorsCount > 0;

      // Record architectural decision in Project Memory
      const adrId = `adr_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const decision: ArchitectureDecision = {
        id: adrId,
        title: `Phase 9 Code Generation: ${profile.displayName}`,
        status: 'accepted',
        context: `User requirement: "${userRequest}"`,
        decision: `Generated ${runRecord.filesCreated.length} files and modified ${runRecord.filesModified.length} files conforming to profile contracts.`,
        rationale: `Synthesized ${establishedContracts.length} initial contracts and verified against AST diagnostics.`,
        affectedFiles: [...runRecord.filesCreated, ...runRecord.filesModified],
        timestamp: Date.now()
      };
      ProjectMemoryService.recordDecision(buildId, userId, decision);

      passes[5].status = 'passed';
      passes[5].durationMs = Date.now() - pass6Start;
      passes[5].summary = hasWarnings 
        ? 'Generation completed with non-fatal configuration warnings.' 
        : 'Generation finalized cleanly. All 6 passes passed and workspace verified.';

      runRecord.status = hasWarnings ? 'completed_with_warnings' : 'finalized';
      runRecord.completedAt = Date.now();
      db.saveGenerationRun(runRecord);

      const finalizedEventType: EventType = hasWarnings ? 'codegen_completed_with_warnings' : 'codegen_finalized';
      this.emitEvent(buildId, finalizedEventType, {
        runId,
        status: runRecord.status,
        filesCreatedCount: runRecord.filesCreated.length,
        filesModifiedCount: runRecord.filesModified.length,
        durationMs: Date.now() - startTime
      });

      return runRecord;
    } catch (err: any) {
      runRecord.status = 'failed';
      runRecord.error = err.message || 'Generation pipeline failed';
      runRecord.completedAt = Date.now();

      // Mark current pass as failed
      const activePassIndex = (runRecord.currentPass || 1) - 1;
      if (passes[activePassIndex]) {
        passes[activePassIndex].status = 'failed';
        passes[activePassIndex].summary = `Aborted due to error: ${runRecord.error}`;
      }

      db.saveGenerationRun(runRecord);

      this.emitEvent(buildId, 'codegen_failed', {
        runId,
        error: runRecord.error
      });

      return runRecord;
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  /**
   * Plans target file paths based on user requirement and profile organization.
   */
  private static planTargetFiles(
    userRequirement: string,
    profile: GenerationProfile,
    existingFiles: ProjectFile[],
    mockPaths?: string[]
  ): string[] {
    if (mockPaths && mockPaths.length > 0) {
      return [...mockPaths];
    }
    const planned = new Set<string>();
    const reqLower = userRequirement.toLowerCase();

    // 1. If explicit paths are mentioned in the requirement (e.g., "in src/components/Hero.tsx")
    const pathRegex = /(?:src|server|tests)\/[a-zA-Z0-9_\-\.\/]+/g;
    const matchedPaths = userRequirement.match(pathRegex);
    if (matchedPaths && matchedPaths.length > 0) {
      matchedPaths.forEach(p => planned.add(p));
      return Array.from(planned);
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
    const advancedModel = enabledModels.find(m => m.capabilityLevel === 'flagship' || (m.capabilityLevel as string) === 'advanced');
    if (advancedModel) return advancedModel;

    return enabledModels[0] || modelRegistry.getAllModels()[0];
  }

  private static emitEvent(buildId: string, type: EventType, details: any): void {
    db.addEvent({
      id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      buildId,
      timestamp: Date.now(),
      type,
      details: typeof details === 'string' ? details : JSON.stringify(details)
    });
  }
}
