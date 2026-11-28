/**
 * Factory Phase F6 — One Environment Contract.
 *
 * A single API surface for the environment operations every category
 * workflow needs — open a project, move files in and out, build, run
 * the test cycle, preview, export an artifact, validate/request a
 * deployment, diagnose, and read status — with one adapter per
 * environment the platform actually has:
 *
 *   - `web`     — the store-backed platform environment (build records
 *                 and files in `server/store.ts`, the Phase 10/32
 *                 execution subsystem, the swarm verification adapter,
 *                 the Phase 15 deployment service).
 *   - `desktop` — the workspace-backed desktop engine environment
 *                 (Phase 18/36: generated project materialized into an
 *                 on-disk workspace, built by `DesktopBuildPipeline`,
 *                 artifacts harvested to `.desktop_artifacts/`).
 *
 * The shape deliberately mirrors the codebase's existing abstraction
 * precedent, `ExecutionBackend` (server/execution/executionBackend.ts):
 * a plain interface, result records instead of thrown strings, and
 * implementations that refuse honestly rather than fabricate success.
 *
 * Honesty rules, enforced by the adapters and pinned by
 * tests/factory_phase_f6_environment_contract.test.ts:
 *   - Every adapter exposes exactly the operations in
 *     ENVIRONMENT_OPERATIONS — the surface is identical; per-operation
 *     *support* is reported by `capabilities()` and may differ.
 *   - An operation an environment cannot perform throws
 *     `EnvironmentOperationUnsupportedError` (a named, coded error).
 *     It never returns a fake success.
 *   - Project code execution stays inside the platform's existing
 *     execution paths. This contract adds no host-process execution
 *     path for project code.
 */

export type EnvironmentKind = 'web' | 'desktop';

/** The complete operation set every environment adapter exposes. */
export const ENVIRONMENT_OPERATIONS = [
  'openProject',
  'writeFile',
  'readFile',
  'listFiles',
  'build',
  'runTests',
  'preview',
  'exportArtifact',
  'validateDeployment',
  'requestDeployment',
  'diagnose',
  'getStatus'
] as const;

export type EnvironmentOperation = (typeof ENVIRONMENT_OPERATIONS)[number];

/**
 * Named refusal for an operation an environment genuinely cannot
 * perform (e.g. previewing a native desktop GUI headlessly). Carries
 * the environment, the operation, and the reason as data so callers
 * and tests can assert on them instead of matching message text.
 */
export class EnvironmentOperationUnsupportedError extends Error {
  readonly name = 'EnvironmentOperationUnsupportedError';
  readonly code = 'ENVIRONMENT_OPERATION_UNSUPPORTED';

  constructor(
    readonly environment: EnvironmentKind,
    readonly operation: EnvironmentOperation,
    readonly reason: string
  ) {
    super(`Operation "${operation}" is not supported in the ${environment} environment: ${reason}`);
    Object.setPrototypeOf(this, EnvironmentOperationUnsupportedError.prototype);
  }
}

export interface EnvironmentFileInput {
  path: string;
  content: string;
}

export interface EnvironmentProjectRef {
  projectId: string;
  environment: EnvironmentKind;
  title: string;
  createdAt: number;
}

export interface EnvironmentDiagnostic {
  severity: 'error' | 'warning' | 'info';
  file?: string;
  message: string;
}

export interface EnvironmentArtifact {
  name: string;
  kind: string;
  sizeBytes: number;
  sha256?: string;
  /** On-disk location when the artifact is a real file. */
  path?: string;
}

export interface EnvironmentBuildResult {
  status: 'succeeded' | 'failed' | 'skipped';
  artifacts: EnvironmentArtifact[];
  diagnostics: EnvironmentDiagnostic[];
  error?: string;
  /** What actually ran, in the environment's own terms. */
  detail: string;
  durationMs: number;
}

export interface EnvironmentTestResult {
  status: 'passed' | 'failed' | 'skipped';
  /** Which verification actually ran (adapters state this honestly). */
  mode: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  detail: string;
}

export interface EnvironmentPreviewResult {
  /** The preview mechanism that produced the result (generator-labelled). */
  mode: string;
  html?: string;
  title?: string;
  detail: string;
}

export interface EnvironmentExportResult {
  artifact: EnvironmentArtifact;
  detail: string;
}

export interface EnvironmentDeploymentValidation {
  valid: boolean;
  provider: string;
  readinessScore?: number;
  defects: string[];
  credentialValid?: boolean;
  credentialError?: string;
  artifactHash?: string;
  detail: string;
}

export interface EnvironmentDeploymentRequest {
  deploymentId?: string;
  /** The deployment record's status, or 'unsupported' is never used —
   *  unsupported environments throw instead of returning a status. */
  status: string;
  requiresApproval: boolean;
  targetUrl?: string;
  detail: string;
}

export interface EnvironmentStatusEvent {
  type: string;
  timestamp: number;
  detail?: string;
}

export interface EnvironmentStatus {
  projectId: string;
  environment: EnvironmentKind;
  title: string;
  fileCount: number;
  lastBuildStatus?: string;
  lastTestStatus?: string;
  events: EnvironmentStatusEvent[];
  detail: string;
}

export interface EnvironmentOperationSupport {
  supported: boolean;
  reason?: string;
}

export interface EnvironmentCapabilities {
  environment: EnvironmentKind;
  operations: Record<EnvironmentOperation, EnvironmentOperationSupport>;
}

/**
 * The one environment contract. A category workflow is written against
 * this interface once and runs in either environment; where an
 * environment cannot perform an operation, the call throws
 * EnvironmentOperationUnsupportedError rather than pretending.
 */
export interface FactoryEnvironment {
  readonly kind: EnvironmentKind;

  capabilities(): EnvironmentCapabilities;

  /** Creates the project if absent, otherwise opens the existing one. */
  openProject(input: {
    projectId: string;
    title: string;
    files?: EnvironmentFileInput[];
  }): Promise<EnvironmentProjectRef>;

  writeFile(projectId: string, path: string, content: string): Promise<void>;

  /** File content, or null when the project has no such file. */
  readFile(projectId: string, path: string): Promise<string | null>;

  listFiles(projectId: string): Promise<string[]>;

  build(projectId: string): Promise<EnvironmentBuildResult>;

  runTests(projectId: string): Promise<EnvironmentTestResult>;

  preview(projectId: string): Promise<EnvironmentPreviewResult>;

  exportArtifact(projectId: string): Promise<EnvironmentExportResult>;

  /** Validated dry-run: checks a deployment without performing one. */
  validateDeployment(
    projectId: string,
    options?: { provider?: string }
  ): Promise<EnvironmentDeploymentValidation>;

  /**
   * Requests a real deployment through the environment's deployment
   * system. Production requests without approval must not deploy.
   */
  requestDeployment(
    projectId: string,
    options?: {
      provider?: string;
      environment?: 'production' | 'preview';
      approved?: boolean;
    }
  ): Promise<EnvironmentDeploymentRequest>;

  diagnose(projectId: string): Promise<EnvironmentDiagnostic[]>;

  getStatus(projectId: string): Promise<EnvironmentStatus>;
}

/** Builds the support map for an adapter from its unsupported set. */
export function supportMap(
  unsupported: Partial<Record<EnvironmentOperation, string>>
): Record<EnvironmentOperation, EnvironmentOperationSupport> {
  const operations = {} as Record<EnvironmentOperation, EnvironmentOperationSupport>;
  for (const operation of ENVIRONMENT_OPERATIONS) {
    const reason = unsupported[operation];
    operations[operation] = reason ? { supported: false, reason } : { supported: true };
  }
  return operations;
}
