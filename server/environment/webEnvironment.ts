import * as path from 'path';
import { db } from '../store.js';
import type { Build, ProjectFile } from '../types.js';
import { ExecutionAdapter } from '../swarm/executionAdapter.js';
import { PreviewGenerator } from '../swarm/previewGenerator.js';
import {
  DeploymentService,
  PreDeploymentValidator,
  ProductionBuilder
} from '../deployment/index.js';
import type { DeploymentProviderType } from '../deployment/types.js';
import {
  EnvironmentBuildResult,
  EnvironmentCapabilities,
  EnvironmentDeploymentRequest,
  EnvironmentDeploymentValidation,
  EnvironmentDiagnostic,
  EnvironmentExportResult,
  EnvironmentPreviewResult,
  EnvironmentProjectRef,
  EnvironmentStatus,
  EnvironmentTestResult,
  FactoryEnvironment,
  supportMap
} from './environmentContract.js';

export interface WebEnvironmentOptions {
  /** The platform user who owns the environment's projects. */
  userId: string;
}

/**
 * The web environment adapter: the platform's store-backed surface.
 *
 * Every operation delegates to the subsystem that already implements
 * it — no reimplementation:
 *   - project files      → `db` (server/store.ts), the platform store
 *   - build              → ExecutionAdapter.runProductionBuild (esbuild
 *                          bundle validation over the stored files)
 *   - test cycle         → ExecutionAdapter.runIsolatedTests (the
 *                          platform test gate: a recorded sandbox test
 *                          run, or this repository's own trusted
 *                          fixtures; an honest skip otherwise)
 *   - preview            → PreviewGenerator.generateInteractivePreview
 *   - export artifact    → ProductionBuilder.buildProject (the real
 *                          production ZIP + SHA-256)
 *   - deploy             → PreDeploymentValidator + DeploymentService
 *                          (six Phase 15 adapters, production approval
 *                          gate enforced by the service itself)
 *   - diagnose           → ExecutionAdapter.runTypeCheck
 *   - status / events    → the build record + db.getEvents
 */
export class WebEnvironmentAdapter implements FactoryEnvironment {
  readonly kind = 'web' as const;

  private readonly lastBuild = new Map<string, EnvironmentBuildResult>();
  private readonly lastTest = new Map<string, EnvironmentTestResult>();

  constructor(private readonly options: WebEnvironmentOptions) {}

  capabilities(): EnvironmentCapabilities {
    return { environment: this.kind, operations: supportMap({}) };
  }

  private requireBuild(projectId: string): Build {
    const build = db.getBuild(projectId);
    if (!build) {
      throw new Error(
        `Web environment project "${projectId}" has not been opened (no build record exists). Call openProject first.`
      );
    }
    return build;
  }

  /** Copies — db.getAllFiles returns live objects (see AGENTS.md fragile areas). */
  private filesOf(projectId: string): ProjectFile[] {
    return db.getAllFiles(projectId).map(f => ({ ...f }));
  }

  async openProject(input: {
    projectId: string;
    title: string;
    files?: { path: string; content: string }[];
  }): Promise<EnvironmentProjectRef> {
    const existing = db.getBuild(input.projectId);
    if (existing) {
      return {
        projectId: existing.id,
        environment: this.kind,
        title: existing.idea,
        createdAt: existing.createdAt
      };
    }
    const now = Date.now();
    const build: Build = {
      id: input.projectId,
      userId: this.options.userId,
      idea: input.title,
      status: 'planning',
      createdAt: now,
      updatedAt: now,
      selectedModels: [],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 5,
      maxDurationSeconds: 3600,
      patchesAppliedCount: 0
    };
    db.saveBuild(build);
    for (const file of input.files ?? []) {
      db.setFile(input.projectId, {
        path: file.path,
        content: file.content,
        version: 1,
        createdAt: now,
        updatedAt: now,
        history: []
      });
    }
    return { projectId: input.projectId, environment: this.kind, title: input.title, createdAt: now };
  }

  async writeFile(projectId: string, filePath: string, content: string): Promise<void> {
    this.requireBuild(projectId);
    const existing = db.getFile(projectId, filePath);
    const now = Date.now();
    db.setFile(projectId, {
      path: filePath,
      content,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      history: existing?.history ? [...existing.history] : []
    });
  }

  async readFile(projectId: string, filePath: string): Promise<string | null> {
    this.requireBuild(projectId);
    const file = db.getFile(projectId, filePath);
    return file ? file.content : null;
  }

  async listFiles(projectId: string): Promise<string[]> {
    this.requireBuild(projectId);
    return db.getAllFiles(projectId).map(f => f.path).sort();
  }

  async build(projectId: string): Promise<EnvironmentBuildResult> {
    this.requireBuild(projectId);
    const started = Date.now();
    const report = ExecutionAdapter.runProductionBuild(projectId, this.filesOf(projectId));
    const diagnostics: EnvironmentDiagnostic[] = (report.locations ?? []).map(loc => ({
      severity: 'error' as const,
      file: loc.filePath,
      message: loc.message
    }));
    if (diagnostics.length === 0) {
      for (const message of report.errors) {
        diagnostics.push({ severity: 'error', message });
      }
    }
    const result: EnvironmentBuildResult = {
      status: report.status === 'passed' ? 'succeeded' : report.status === 'failed' ? 'failed' : 'skipped',
      artifacts: [],
      diagnostics,
      error: report.status === 'failed' ? report.errors.join('; ') : undefined,
      detail:
        report.output ||
        'Production build validation via ExecutionAdapter (esbuild bundle check). The deployable artifact is produced by exportArtifact.',
      durationMs: Date.now() - started
    };
    this.lastBuild.set(projectId, result);
    return result;
  }

  async runTests(projectId: string): Promise<EnvironmentTestResult> {
    this.requireBuild(projectId);
    const report = ExecutionAdapter.runIsolatedTests(projectId, this.filesOf(projectId));
    const fromSandbox = report.details.some(d => d.name === 'npm test in sandbox');
    const failing = report.details.filter(d => !d.passed && d.status !== 'skipped');
    const result: EnvironmentTestResult = {
      status: report.status,
      mode: fromSandbox ? 'sandbox_test_run' : 'project_tests',
      total: report.total,
      passed: report.passed,
      failed: report.failed,
      skipped: report.skipped,
      detail:
        report.skipReason ||
        (failing.length > 0
          ? failing.map(d => `${d.name}: ${d.message || 'failed'}`).join('; ')
          : `${report.passed}/${report.total} project tests passed through the platform test gate.`)
    };
    this.lastTest.set(projectId, result);
    return result;
  }

  async preview(projectId: string): Promise<EnvironmentPreviewResult> {
    const build = this.requireBuild(projectId);
    const files = this.filesOf(projectId);
    const preview = PreviewGenerator.generateInteractivePreview(build.idea, files, 'fullstack');
    return {
      mode: preview.mode,
      html: preview.html,
      title: preview.title,
      detail:
        preview.diagnosticInfo ||
        `Preview generated by PreviewGenerator in "${preview.mode}" mode from ${files.length} project files. The mode is the generator's own label: "fallback_preview" means real compilation was unavailable and the preview is a labelled fallback, not the running app.`
    };
  }

  async exportArtifact(projectId: string): Promise<EnvironmentExportResult> {
    this.requireBuild(projectId);
    const result = await ProductionBuilder.buildProject({
      deploymentId: `env_export_${projectId}`,
      buildId: projectId,
      files: this.filesOf(projectId)
    });
    if (!result.success || !result.artifactPath) {
      throw new Error(
        `Production build for project "${projectId}" did not produce an artifact: ${result.error || 'unknown error'}`
      );
    }
    return {
      artifact: {
        name: path.basename(result.artifactPath),
        kind: 'zip',
        sizeBytes: result.totalSize,
        sha256: result.artifactHash,
        path: result.artifactPath
      },
      detail: `Production artifact built by ProductionBuilder from ${result.fileCount} files (entry point: ${result.entryPoint}).`
    };
  }

  async validateDeployment(
    projectId: string,
    options?: { provider?: string }
  ): Promise<EnvironmentDeploymentValidation> {
    this.requireBuild(projectId);
    const provider = options?.provider ?? 'static_host';
    const validation = PreDeploymentValidator.validateProject(projectId);
    const adapter = DeploymentService.getAdapter(provider as DeploymentProviderType);
    const credentials = await adapter.validateCredentials({});
    return {
      valid: validation.passed && credentials.valid,
      provider,
      readinessScore: validation.readinessScore,
      defects: [...validation.defects, ...validation.missingSecrets.map(s => `Missing secret: ${s}`)],
      credentialValid: credentials.valid,
      credentialError: credentials.error,
      detail:
        'Dry-run only: PreDeploymentValidator checks + adapter credential validation ran; no deployment was created and no adapter deploy() was called.'
    };
  }

  async requestDeployment(
    projectId: string,
    options?: {
      provider?: string;
      environment?: 'production' | 'preview';
      approved?: boolean;
    }
  ): Promise<EnvironmentDeploymentRequest> {
    this.requireBuild(projectId);
    const provider = (options?.provider ?? 'static_host') as DeploymentProviderType;
    const environment = options?.environment ?? 'production';
    const created = await DeploymentService.createDeployment({
      userId: this.options.userId,
      buildId: projectId,
      provider,
      environment
    });

    if (created.requiresApproval && !options?.approved) {
      return {
        deploymentId: created.deployment.id,
        status: created.deployment.status,
        requiresApproval: true,
        detail:
          'Held by the production approval gate (DeploymentService + ApprovalGateService). The deployment was not executed and nothing was deployed.'
      };
    }

    if (created.requiresApproval && options?.approved) {
      await DeploymentService.approveDeployment(created.deployment.id, this.options.userId);
    }

    // The pipeline executes asynchronously after approval (or
    // immediately for non-gated environments); poll the record the
    // same way the Phase 15 suites observe it.
    let record = db.getDeployment(created.deployment.id);
    const deadline = Date.now() + 10_000;
    while (record && (record.status === 'building' || record.status === 'pending_approval') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
      record = db.getDeployment(created.deployment.id);
    }
    return {
      deploymentId: created.deployment.id,
      status: record?.status ?? created.deployment.status,
      requiresApproval: created.requiresApproval,
      targetUrl: record?.targetUrl,
      detail: created.requiresApproval
        ? 'Approved by the caller; the DeploymentService pipeline executed against the selected adapter.'
        : 'No approval gate applied to this environment; the DeploymentService pipeline executed against the selected adapter.'
    };
  }

  async diagnose(projectId: string): Promise<EnvironmentDiagnostic[]> {
    this.requireBuild(projectId);
    const report = ExecutionAdapter.runTypeCheck(projectId, this.filesOf(projectId));
    if (report.status === 'skipped') return [];
    return report.diagnostics.map(d => ({
      severity: (d.category === 'error' ? 'error' : d.category === 'warning' ? 'warning' : 'info') as
        | 'error'
        | 'warning'
        | 'info',
      file: d.filePath,
      message: `${d.code}: ${d.message} (${d.line}:${d.column})`
    }));
  }

  async getStatus(projectId: string): Promise<EnvironmentStatus> {
    const build = this.requireBuild(projectId);
    const events = db.getEvents(projectId).slice(-20).map(e => ({
      type: String(e.type),
      timestamp: e.timestamp,
      detail: e.details
    }));
    return {
      projectId,
      environment: this.kind,
      title: build.idea,
      fileCount: db.getAllFiles(projectId).length,
      lastBuildStatus: this.lastBuild.get(projectId)?.status,
      lastTestStatus: this.lastTest.get(projectId)?.status,
      events,
      detail: `Platform build record status: ${build.status}.`
    };
  }
}
