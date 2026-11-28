import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import type {
  DesktopArtifact,
  DesktopBuildLogEntry,
  DesktopBuildOptions,
  DesktopBuildResult,
  DesktopDiagnostic,
  DesktopProjectConfig
} from './types.js';
import { DesktopProjectGenerator } from './desktopProjectGenerator.js';
import { PeInspector } from './peInspector.js';
import { ElfInspector } from './elfInspector.js';
import { assertSafeWorkspacePath, sanitizeProjectFilePath } from '../pathSecurity.js';

/**
 * Phase 18: real desktop build pipeline.
 *
 * Writes the generated project into an isolated, path-validated
 * workspace, restores dependencies with `dotnet restore` (NuGet),
 * compiles with `dotnet build`, harvests the produced executables,
 * and verifies each one by parsing its real format headers — PE
 * for Windows .exe files (Phase 18), ELF for the extensionless
 * Linux apphost (Phase 36). Nothing here fabricates artifacts: if
 * the .NET SDK is missing or compilation fails, the result is an
 * honest failure with the real compiler output attached.
 */
export class DesktopBuildPipeline {
  private logs: DesktopBuildLogEntry[] = [];
  private diagnostics: DesktopDiagnostic[] = [];

  private log(level: DesktopBuildLogEntry['level'], step: string, message: string): void {
    const entry = { timestamp: Date.now(), level, step, message };
    this.logs.push(entry);
    const prefix = level === 'ERROR' ? '❌' : level === 'WARN' ? '⚠️' : 'ℹ️';
    console.log(`[DesktopBuild] ${prefix} [${step}] ${message}`);
  }

  private run(
    cmd: string,
    args: string[],
    cwd: string,
    step: string,
    timeoutMs: number = 600_000
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd, shell: false, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        stderr += `\nTimed out after ${timeoutMs}ms`;
      }, timeoutMs);
      child.stdout?.on('data', (d) => (stdout += d.toString()));
      child.stderr?.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + String(err) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        for (const line of (stdout + '\n' + stderr).split('\n')) {
          const m = line.match(/(.+?)\((\d+),\d+\):\s*(error|warning)\s+([A-Z]+\d+):\s*(.+)/);
          if (m) {
            this.diagnostics.push({
              severity: m[3] === 'error' ? 'error' : 'warning',
              file: path.basename(m[1]),
              message: `${m[4]}: ${m[5].trim()}`
            });
          }
        }
        this.log(code === 0 ? 'INFO' : 'ERROR', step, `${cmd} ${args.join(' ')} exited ${code}`);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  public async build(
    buildId: string,
    config: DesktopProjectConfig,
    files: Record<string, string>,
    options: DesktopBuildOptions = { configuration: 'Debug', restore: true }
  ): Promise<DesktopBuildResult> {
    const started = Date.now();
    this.logs = [];
    this.diagnostics = [];
    const result: DesktopBuildResult = {
      id: `desktop_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      buildId,
      timestamp: started,
      status: 'failed',
      configuration: options.configuration,
      platform: config.platform,
      logs: this.logs,
      diagnostics: this.diagnostics,
      artifacts: [],
      durationMs: 0
    };

    try {
      const configErrors = DesktopProjectGenerator.validateConfig(config);
      if (configErrors.length > 0) {
        throw new Error(`Invalid desktop project config: ${configErrors.join('; ')}`);
      }

      const dotnet = DesktopProjectGenerator.detectDotnet();
      if (!dotnet) {
        result.error =
          'No .NET SDK found on this host (looked in DOTNET_ROOT, PATH, and standard install locations). ' +
          'Install the .NET 8 SDK to run genuine desktop builds; nothing was compiled.';
        this.log('ERROR', 'toolchain', result.error);
        return result;
      }
      const sdks = DesktopProjectGenerator.listSdks(dotnet);
      if (!sdks.some((v) => parseInt(v.split('.')[0], 10) >= 8)) {
        result.error = `Found dotnet at ${dotnet} but no .NET 8+ SDK (installed: ${sdks.join(', ') || 'none'}).`;
        this.log('ERROR', 'toolchain', result.error);
        return result;
      }
      this.log('INFO', 'toolchain', `dotnet SDK ${sdks.join(', ')} at ${dotnet}`);

      const baseWorkDir = path.join(process.cwd(), '.desktop_workspaces');
      await fsp.mkdir(baseWorkDir, { recursive: true });
      const workspace = assertSafeWorkspacePath(baseWorkDir, buildId);
      await fsp.rm(workspace, { recursive: true, force: true });
      await fsp.mkdir(workspace, { recursive: true });
      this.log('INFO', 'workspace', `Isolated workspace: ${workspace}`);

      for (const [rel, content] of Object.entries(files)) {
        const safeRel = sanitizeProjectFilePath(rel);
        if (!safeRel) throw new Error(`Security Violation: unsafe project file path rejected: ${rel}`);
        const dest = assertSafeWorkspacePath(workspace, safeRel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, content, 'utf-8');
      }
      this.log('INFO', 'workspace', `Wrote ${Object.keys(files).length} project files`);

      const csprojRel = `src/${config.assemblyName}/${config.assemblyName}.csproj`;
      const csprojPath = path.join(workspace, csprojRel);
      if (!fs.existsSync(csprojPath)) throw new Error(`Generated project file missing: ${csprojRel}`);

      if (options.restore) {
        const restore = await this.run(dotnet, ['restore', csprojRel], workspace, 'restore');
        if (restore.code !== 0) {
          result.error = `dotnet restore failed (exit ${restore.code}): ${(restore.stderr || restore.stdout).slice(-1200)}`;
          return result;
        }
      }

      const build = await this.run(
        dotnet,
        ['build', csprojRel, '-c', options.configuration, '--no-restore'],
        workspace,
        'build'
      );
      if (build.code !== 0) {
        result.error = `dotnet build failed (exit ${build.code}): ${(build.stderr || build.stdout).slice(-1200)}`;
        return result;
      }

      const rid = config.platform === 'linux' ? 'linux-x64' : 'win-x64';
      const outDir = path.join(
        workspace,
        'src',
        config.assemblyName,
        'bin',
        options.configuration,
        config.targetFramework,
        rid
      );
      if (!fs.existsSync(outDir)) throw new Error(`Build output directory not found: ${outDir}`);

      const artifactsDir = path.join(options.artifactsRoot ?? path.join(process.cwd(), '.desktop_artifacts'), buildId);
      await fsp.mkdir(artifactsDir, { recursive: true });
      const harvested: DesktopArtifact[] = [];
      for (const name of await fsp.readdir(outDir)) {
        const ext = path.extname(name).toLowerCase();
        // Linux builds produce an extensionless ELF apphost named
        // exactly after the assembly; Windows builds produce .exe.
        const isLinuxApphost = config.platform === 'linux' && name === config.assemblyName;
        // The apphost is framework-dependent: without its deps and
        // runtimeconfig manifests beside it, it cannot start at all.
        // Harvest both so the Linux artifact set is a runnable app
        // folder, not a lone binary that errors on launch.
        const isLinuxManifest =
          config.platform === 'linux' &&
          (name === `${config.assemblyName}.deps.json` ||
            name === `${config.assemblyName}.runtimeconfig.json`);
        if (ext !== '.exe' && ext !== '.dll' && !isLinuxApphost && !isLinuxManifest) continue;
        const buf = await fsp.readFile(path.join(outDir, name));
        if (ext === '.exe') {
          const pe = PeInspector.inspect(buf);
          if (!pe.isPeFile) {
            this.log('ERROR', 'verify', `${name} failed PE validation: ${pe.errors.join('; ')}`);
            result.error = `Artifact ${name} is not a valid Windows PE executable: ${pe.errors.join('; ')}`;
            return result;
          }
          this.log('INFO', 'verify', `${name}: genuine PE (${pe.machine}, ${pe.subsystem}, ${pe.sections} sections)`);
        }
        if (isLinuxApphost) {
          const elf = ElfInspector.inspect(buf);
          if (!elf.isElfFile) {
            this.log('ERROR', 'verify', `${name} failed ELF validation: ${elf.errors.join('; ')}`);
            result.error = `Artifact ${name} is not a valid Linux ELF executable: ${elf.errors.join('; ')}`;
            return result;
          }
          this.log('INFO', 'verify', `${name}: genuine ELF (${elf.elfClass}, ${elf.endianness}, ${elf.machine}, ${elf.objectType})`);
        }
        const artifactPath = path.join(artifactsDir, name);
        await fsp.writeFile(artifactPath, buf);
        // Preserve the mode the toolchain set: both apphosts are
        // executables, and a plain write would strip the executable
        // bit, leaving a harvested Linux artifact that cannot run.
        const srcStat = await fsp.stat(path.join(outDir, name));
        await fsp.chmod(artifactPath, srcStat.mode & 0o777);
        harvested.push({
          filename: name,
          kind: ext === '.exe' || isLinuxApphost ? 'exe' : isLinuxManifest ? 'other' : 'dll',
          sizeBytes: buf.length,
          sha256: crypto.createHash('sha256').update(buf).digest('hex')
        });
      }
      if (!harvested.some((a) => a.kind === 'exe')) {
        result.error = 'Build reported success but produced no executable artifact; refusing to claim success.';
        this.log('ERROR', 'verify', result.error);
        return result;
      }
      result.artifacts = harvested;
      result.status = 'success';
      this.log('INFO', 'complete', `Desktop build succeeded: ${harvested.map((a) => a.filename).join(', ')}`);
      return result;
    } catch (err: any) {
      result.error = err?.message || 'Desktop build failed';
      this.log('ERROR', 'pipeline', result.error);
      return result;
    } finally {
      result.durationMs = Date.now() - started;
    }
  }
}
