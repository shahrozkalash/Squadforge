import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DesktopProjectGenerator } from '../desktop/desktopProjectGenerator.js';
import { DesktopBuildPipeline } from '../desktop/desktopBuildPipeline.js';
import { ElfInspector } from '../desktop/elfInspector.js';
import { PeInspector } from '../desktop/peInspector.js';
import type { DesktopProjectConfig } from '../desktop/types.js';
import { assertSafeWorkspacePath, sanitizeProjectFilePath } from '../pathSecurity.js';
import {
  EnvironmentBuildResult,
  EnvironmentCapabilities,
  EnvironmentDeploymentValidation,
  EnvironmentDiagnostic,
  EnvironmentExportResult,
  EnvironmentOperationUnsupportedError,
  EnvironmentPreviewResult,
  EnvironmentProjectRef,
  EnvironmentStatus,
  EnvironmentTestResult,
  FactoryEnvironment,
  supportMap
} from './environmentContract.js';

const execFileAsync = promisify(execFile);

export interface DesktopEnvironmentOptions {
  /** Root holding one workspace directory per project. Default: <cwd>/.desktop_projects */
  workspaceRoot?: string;
  /** Where DesktopBuildPipeline harvests artifacts. Default: <cwd>/.desktop_artifacts */
  artifactsRoot?: string;
  /** Target platform for projects opened without an existing manifest. Default: linux (windows on win32 hosts). */
  platform?: 'linux' | 'windows';
}

interface DesktopProjectManifest {
  projectId: string;
  title: string;
  config: DesktopProjectConfig;
  createdAt: number;
}

interface DesktopProjectStatus {
  lastBuildStatus?: string;
  lastTestStatus?: string;
  lastBuildHash?: string;
  lastDiagnostics: EnvironmentDiagnostic[];
  lastArtifacts: { name: string; kind: string; sizeBytes: number; sha256?: string }[];
  events: { type: string; timestamp: number; detail?: string }[];
}

const PREVIEW_UNSUPPORTED_REASON =
  'Native desktop applications render through their own GUI (Avalonia/WinForms); the platform has no desktop preview and this host has no display — the generated GUI has never been run headlessly (Phases 36/57 platform record). The desktop run verification is build + runTests (compile and the apphost --smoke run).';

const REQUEST_DEPLOYMENT_UNSUPPORTED_REASON =
  'Desktop projects are distributed as versioned release packages through the Phase 23 ReleasePackager/ReleaseStore, not through the Phase 15 deployment service, and the release system has no approval-gated deployment request. Use validateDeployment for the desktop deployment dry-run.';

/**
 * The desktop environment adapter: the workspace-backed surface of
 * the Phase 18/36 Desktop Development Engine.
 *
 * The desktop engine has no store-backed project API — the generator
 * produces a files map and `DesktopBuildPipeline` materializes it
 * into an isolated on-disk workspace, compiles it with the real .NET
 * SDK, and harvests format-verified artifacts. This adapter gives
 * that engine the contract's project store (one workspace directory
 * per project, guarded by the same path-security helpers the
 * pipeline uses) and delegates every operation to the engine:
 *   - build     → DesktopBuildPipeline (dotnet restore + build,
 *                 PE/ELF verification of every harvested artifact)
 *   - test cycle→ compile verdict + the generated app's headless
 *                 `--smoke` run (Phase 36), which exercises the app's
 *                 own state store; generated projects ship no unit
 *                 test suite, and none is invented here
 *   - export    → the harvested executable artifact (SHA-256 taken
 *                 from the artifact bytes on disk)
 *   - deploy    → dry-run: generator config validation + artifact
 *                 format re-verification. The Phase 23 packager
 *                 publishes win-x64 only; Linux targets have no
 *                 server-side packaging adapter (Phase 60 used the
 *                 repo's release script) — stated, not papered over
 *   - preview / requestDeployment → named unsupported errors
 */
export class DesktopEnvironmentAdapter implements FactoryEnvironment {
  readonly kind = 'desktop' as const;

  private readonly workspaceRoot: string;
  private readonly artifactsRoot: string;
  private readonly defaultPlatform: 'linux' | 'windows';

  constructor(options: DesktopEnvironmentOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? path.join(process.cwd(), '.desktop_projects');
    this.artifactsRoot = options.artifactsRoot ?? path.join(process.cwd(), '.desktop_artifacts');
    this.defaultPlatform = options.platform ?? (process.platform === 'win32' ? 'windows' : 'linux');
  }

  capabilities(): EnvironmentCapabilities {
    return {
      environment: this.kind,
      operations: supportMap({
        preview: PREVIEW_UNSUPPORTED_REASON,
        requestDeployment: REQUEST_DEPLOYMENT_UNSUPPORTED_REASON
      })
    };
  }

  // -- project store ---------------------------------------------------------

  private projectDir(projectId: string): string {
    return assertSafeWorkspacePath(this.workspaceRoot, projectId);
  }

  private filesDir(projectId: string): string {
    return path.join(this.projectDir(projectId), 'files');
  }

  private manifestPath(projectId: string): string {
    return path.join(this.projectDir(projectId), 'project.json');
  }

  private statusPath(projectId: string): string {
    return path.join(this.projectDir(projectId), 'environment-status.json');
  }

  private requireManifest(projectId: string): DesktopProjectManifest {
    const manifestFile = this.manifestPath(projectId);
    if (!fs.existsSync(manifestFile)) {
      throw new Error(
        `Desktop environment project "${projectId}" has not been opened (no workspace manifest exists). Call openProject first.`
      );
    }
    return JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as DesktopProjectManifest;
  }

  private readStatus(projectId: string): DesktopProjectStatus {
    const statusFile = this.statusPath(projectId);
    if (!fs.existsSync(statusFile)) {
      return { lastDiagnostics: [], lastArtifacts: [], events: [] };
    }
    return JSON.parse(fs.readFileSync(statusFile, 'utf-8')) as DesktopProjectStatus;
  }

  private writeStatus(projectId: string, status: DesktopProjectStatus): void {
    fs.writeFileSync(this.statusPath(projectId), JSON.stringify(status, null, 2), 'utf-8');
  }

  private recordEvent(projectId: string, type: string, detail?: string): void {
    const status = this.readStatus(projectId);
    status.events.push({ type, timestamp: Date.now(), detail });
    this.writeStatus(projectId, status);
  }

  private async writeProjectFile(projectId: string, relPath: string, content: string): Promise<void> {
    const safeRel = sanitizeProjectFilePath(relPath);
    if (!safeRel) {
      throw new Error(`Security Violation: unsafe project file path rejected: ${relPath}`);
    }
    const dest = assertSafeWorkspacePath(this.filesDir(projectId), safeRel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, content, 'utf-8');
  }

  private filesMap(projectId: string): Record<string, string> {
    const root = this.filesDir(projectId);
    const map: Record<string, string> = {};
    if (!fs.existsSync(root)) return map;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else {
          const rel = path.relative(root, abs).split(path.sep).join('/');
          map[rel] = fs.readFileSync(abs, 'utf-8');
        }
      }
    };
    walk(root);
    return map;
  }

  private hashFiles(files: Record<string, string>): string {
    const hash = crypto.createHash('sha256');
    for (const rel of Object.keys(files).sort()) {
      hash.update(rel);
      hash.update('\0');
      hash.update(files[rel]);
      hash.update('\0');
    }
    return hash.digest('hex');
  }

  // -- contract operations ---------------------------------------------------

  async openProject(input: {
    projectId: string;
    title: string;
    files?: { path: string; content: string }[];
  }): Promise<EnvironmentProjectRef> {
    const dir = this.projectDir(input.projectId);
    if (fs.existsSync(this.manifestPath(input.projectId))) {
      const manifest = this.requireManifest(input.projectId);
      return {
        projectId: manifest.projectId,
        environment: this.kind,
        title: manifest.title,
        createdAt: manifest.createdAt
      };
    }

    const assemblyName =
      input.title.replace(/[^A-Za-z0-9_]/g, '').replace(/^[^A-Za-z]+/, '') || 'FactoryApp';
    const config =
      this.defaultPlatform === 'linux'
        ? DesktopProjectGenerator.getLinuxDefaultConfig(input.title, assemblyName)
        : DesktopProjectGenerator.getDefaultConfig(input.title, assemblyName);
    const configErrors = DesktopProjectGenerator.validateConfig(config);
    if (configErrors.length > 0) {
      throw new Error(`Invalid desktop project config for "${input.title}": ${configErrors.join('; ')}`);
    }

    await fsp.mkdir(this.filesDir(input.projectId), { recursive: true });
    const manifest: DesktopProjectManifest = {
      projectId: input.projectId,
      title: input.title,
      config,
      createdAt: Date.now()
    };
    await fsp.writeFile(this.manifestPath(input.projectId), JSON.stringify(manifest, null, 2), 'utf-8');

    const seedFiles =
      input.files ?? Object.entries(DesktopProjectGenerator.generateProjectFiles(config)).map(([p, content]) => ({
        path: p,
        content
      }));
    for (const file of seedFiles) {
      await this.writeProjectFile(input.projectId, file.path, file.content);
    }
    this.writeStatus(input.projectId, { lastDiagnostics: [], lastArtifacts: [], events: [] });
    this.recordEvent(input.projectId, 'project_opened', `${seedFiles.length} files seeded (${config.platform}/${config.uiFramework})`);
    return {
      projectId: input.projectId,
      environment: this.kind,
      title: input.title,
      createdAt: manifest.createdAt
    };
  }

  async writeFile(projectId: string, filePath: string, content: string): Promise<void> {
    this.requireManifest(projectId);
    await this.writeProjectFile(projectId, filePath, content);
    this.recordEvent(projectId, 'file_written', filePath);
  }

  async readFile(projectId: string, filePath: string): Promise<string | null> {
    this.requireManifest(projectId);
    const safeRel = sanitizeProjectFilePath(filePath);
    if (!safeRel) {
      throw new Error(`Security Violation: unsafe project file path rejected: ${filePath}`);
    }
    const dest = assertSafeWorkspacePath(this.filesDir(projectId), safeRel);
    if (!fs.existsSync(dest)) return null;
    return fs.readFileSync(dest, 'utf-8');
  }

  async listFiles(projectId: string): Promise<string[]> {
    this.requireManifest(projectId);
    return Object.keys(this.filesMap(projectId)).sort();
  }

  async build(projectId: string): Promise<EnvironmentBuildResult> {
    const manifest = this.requireManifest(projectId);
    const files = this.filesMap(projectId);
    const started = Date.now();
    const result = await new DesktopBuildPipeline().build(projectId, manifest.config, files, {
      configuration: 'Debug',
      restore: true,
      artifactsRoot: this.artifactsRoot
    });
    const mapped: EnvironmentBuildResult = {
      status: result.status === 'success' ? 'succeeded' : 'failed',
      artifacts: result.artifacts.map(a => ({
        name: a.filename,
        kind: a.kind,
        sizeBytes: a.sizeBytes,
        sha256: a.sha256,
        path: path.join(this.artifactsRoot, projectId, a.filename)
      })),
      diagnostics: result.diagnostics.map(d => ({
        severity: d.severity,
        file: d.file,
        message: d.message
      })),
      error: result.error,
      detail:
        `DesktopBuildPipeline: dotnet restore + build for ${manifest.config.platform}/${manifest.config.uiFramework} (${manifest.config.targetFramework}); ` +
        'every harvested executable was format-verified by the pipeline (PE on Windows, ELF on Linux).',
      durationMs: Date.now() - started
    };
    const status = this.readStatus(projectId);
    status.lastBuildStatus = mapped.status;
    status.lastBuildHash = this.hashFiles(files);
    status.lastDiagnostics = mapped.diagnostics;
    status.lastArtifacts = mapped.artifacts.map(a => ({
      name: a.name,
      kind: a.kind,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256
    }));
    status.events.push({
      type: 'build_finished',
      timestamp: Date.now(),
      detail: `${mapped.status} — ${mapped.artifacts.length} artifact(s)`
    });
    this.writeStatus(projectId, status);
    return mapped;
  }

  /** Builds only when the workspace changed since the last recorded build. */
  private async ensureBuilt(projectId: string): Promise<EnvironmentBuildResult> {
    const status = this.readStatus(projectId);
    const files = this.filesMap(projectId);
    if (status.lastBuildStatus === 'succeeded' && status.lastBuildHash === this.hashFiles(files)) {
      return {
        status: 'succeeded',
        artifacts: status.lastArtifacts.map(a => ({
          name: a.name,
          kind: a.kind,
          sizeBytes: a.sizeBytes,
          sha256: a.sha256,
          path: path.join(this.artifactsRoot, projectId, a.name)
        })),
        diagnostics: status.lastDiagnostics,
        detail: 'Reused the recorded build for the unchanged workspace (file-hash match).',
        durationMs: 0
      };
    }
    return this.build(projectId);
  }

  async runTests(projectId: string): Promise<EnvironmentTestResult> {
    const manifest = this.requireManifest(projectId);
    const finish = (result: EnvironmentTestResult): EnvironmentTestResult => {
      const status = this.readStatus(projectId);
      status.lastTestStatus = result.status;
      status.events.push({
        type: 'tests_finished',
        timestamp: Date.now(),
        detail: `${result.status} (${result.mode})`
      });
      this.writeStatus(projectId, status);
      return result;
    };

    const buildResult = await this.ensureBuilt(projectId);
    if (buildResult.status !== 'succeeded') {
      return finish({
        status: 'failed',
        mode: 'compile_and_smoke',
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        detail: `Compilation failed, so the smoke run was not attempted. ${buildResult.error || ''}`.trim()
      });
    }

    if (manifest.config.platform !== 'linux') {
      return finish({
        status: 'passed',
        mode: 'compile_and_smoke',
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 1,
        detail:
          'Compile check passed. The --smoke runtime check is honestly skipped: a Windows GUI executable cannot run on this host (Phase 57 platform record). Generated desktop projects ship no unit-test suite.'
      });
    }

    // Phase 36's headless run verification: execute the harvested
    // apphost with --smoke; it exercises the app's own state store
    // and prints SMOKE_OK with the persisted launch count.
    const apphostPath = path.join(this.artifactsRoot, projectId, manifest.config.assemblyName);
    if (!fs.existsSync(apphostPath)) {
      return finish({
        status: 'failed',
        mode: 'compile_and_smoke',
        total: 2,
        passed: 1,
        failed: 1,
        skipped: 0,
        detail: `Compile passed but the harvested apphost is missing at ${apphostPath}; the smoke run could not start.`
      });
    }
    const configHome = path.join(this.projectDir(projectId), 'config-home');
    await fsp.mkdir(configHome, { recursive: true });
    try {
      const { stdout } = await execFileAsync(apphostPath, ['--smoke'], {
        env: { ...process.env, XDG_CONFIG_HOME: configHome },
        timeout: 120_000
      });
      const smokeLine = stdout.split('\n').find(line => line.includes('SMOKE_OK')) || '';
      if (!smokeLine) {
        return finish({
          status: 'failed',
          mode: 'compile_and_smoke',
          total: 2,
          passed: 1,
          failed: 1,
          skipped: 0,
          detail: `Apphost ran but did not print SMOKE_OK. Output: ${stdout.slice(0, 400)}`
        });
      }
      const statePath = path.join(configHome, manifest.config.assemblyName, 'state.json');
      let launchCount: number | undefined;
      if (fs.existsSync(statePath)) {
        try {
          launchCount = JSON.parse(fs.readFileSync(statePath, 'utf-8')).LaunchCount;
        } catch {
          launchCount = undefined;
        }
      }
      return finish({
        status: 'passed',
        mode: 'compile_and_smoke',
        total: 2,
        passed: 2,
        failed: 0,
        skipped: 0,
        detail:
          `Compile passed; apphost --smoke printed "${smokeLine.trim()}"` +
          (launchCount !== undefined
            ? ` and the app state store persisted LaunchCount=${launchCount}.`
            : '.') +
          ' Generated desktop projects ship no unit-test suite; compile + smoke is the desktop test cycle.'
      });
    } catch (err: any) {
      return finish({
        status: 'failed',
        mode: 'compile_and_smoke',
        total: 2,
        passed: 1,
        failed: 1,
        skipped: 0,
        detail: `Apphost --smoke run failed: ${(err?.stdout || '').toString().slice(0, 300)} ${(err?.stderr || err?.message || '').toString().slice(0, 300)}`.trim()
      });
    }
  }

  async preview(_projectId: string): Promise<EnvironmentPreviewResult> {
    throw new EnvironmentOperationUnsupportedError(this.kind, 'preview', PREVIEW_UNSUPPORTED_REASON);
  }

  async exportArtifact(projectId: string): Promise<EnvironmentExportResult> {
    const manifest = this.requireManifest(projectId);
    const buildResult = await this.ensureBuilt(projectId);
    if (buildResult.status !== 'succeeded') {
      throw new Error(
        `Desktop project "${projectId}" has no exportable artifact because its build did not succeed: ${buildResult.error || 'build failed'}`
      );
    }
    const executable = buildResult.artifacts.find(a => a.kind === 'exe') ?? buildResult.artifacts[0];
    if (!executable?.path || !fs.existsSync(executable.path)) {
      throw new Error(`Desktop project "${projectId}" build reported success but no artifact file exists on disk.`);
    }
    const bytes = fs.readFileSync(executable.path);
    return {
      artifact: {
        name: executable.name,
        kind: 'executable',
        sizeBytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        path: executable.path
      },
      detail:
        `Harvested ${manifest.config.platform} executable from the DesktopBuildPipeline artifact directory; ` +
        'SHA-256 computed from the artifact bytes on disk.'
    };
  }

  async validateDeployment(projectId: string): Promise<EnvironmentDeploymentValidation> {
    const manifest = this.requireManifest(projectId);
    const defects: string[] = [];
    const configErrors = DesktopProjectGenerator.validateConfig(manifest.config);
    defects.push(...configErrors.map(e => `Config: ${e}`));

    const status = this.readStatus(projectId);
    if (status.lastBuildStatus !== 'succeeded' || status.lastArtifacts.length === 0) {
      defects.push('No successful build has produced artifacts to validate.');
    } else {
      for (const artifact of status.lastArtifacts) {
        const artifactPath = path.join(this.artifactsRoot, projectId, artifact.name);
        if (!fs.existsSync(artifactPath)) {
          defects.push(`Harvested artifact missing from disk: ${artifact.name}`);
          continue;
        }
        const bytes = fs.readFileSync(artifactPath);
        if (artifact.kind === 'exe' && manifest.config.platform === 'linux') {
          const elf = ElfInspector.inspect(bytes);
          if (!elf.isElfFile) defects.push(`Artifact ${artifact.name} failed ELF re-verification: ${elf.errors.join('; ')}`);
        } else if (artifact.name.toLowerCase().endsWith('.exe') || artifact.name.toLowerCase().endsWith('.dll')) {
          const pe = PeInspector.inspect(bytes);
          if (!pe.isPeFile) defects.push(`Artifact ${artifact.name} failed PE re-verification: ${pe.errors.join('; ')}`);
        }
      }
    }

    const packagingNote =
      manifest.config.platform === 'linux'
        ? 'Packaging path: the Phase 23 ReleasePackager publishes win-x64 only, so no server-side packaging adapter exists for this Linux target (Phase 60 packaged the Linux app via scripts/phase60-release.ts).'
        : 'Packaging path: the Phase 23 ReleasePackager (dotnet publish + package + validatePackage) covers Windows targets; this dry-run validated config and artifacts only.';
    return {
      valid: defects.length === 0,
      provider: 'desktop_release',
      defects,
      detail: `Dry-run only: generator config validation + harvested-artifact format re-verification ran; nothing was published. ${packagingNote}`
    };
  }

  async requestDeployment(): Promise<never> {
    throw new EnvironmentOperationUnsupportedError(
      this.kind,
      'requestDeployment',
      REQUEST_DEPLOYMENT_UNSUPPORTED_REASON
    );
  }

  async diagnose(projectId: string): Promise<EnvironmentDiagnostic[]> {
    this.requireManifest(projectId);
    return this.readStatus(projectId).lastDiagnostics;
  }

  async getStatus(projectId: string): Promise<EnvironmentStatus> {
    const manifest = this.requireManifest(projectId);
    const status = this.readStatus(projectId);
    return {
      projectId,
      environment: this.kind,
      title: manifest.title,
      fileCount: Object.keys(this.filesMap(projectId)).length,
      lastBuildStatus: status.lastBuildStatus,
      lastTestStatus: status.lastTestStatus,
      events: status.events.slice(-20),
      detail:
        `Workspace-backed desktop project (${manifest.config.platform}/${manifest.config.uiFramework}, ` +
        `${manifest.config.targetFramework}); artifacts harvested under .desktop_artifacts/${projectId}.`
    };
  }
}
