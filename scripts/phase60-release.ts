/**
 * Phase 60 release driver.
 *
 * Produces the versioned release packages for the graphics-editor
 * roadmap's final phase, from the project's own build machinery —
 * nothing is hand-assembled:
 *
 *   1. Windows: PixelForge (the WinForms graphics editor) is
 *      generated fresh via ImageProjectGenerator and built in
 *      Release configuration through DesktopBuildPipeline
 *      (PE-verified by the pipeline). The package folder is the
 *      build's real output directory (exe, dll, deps.json,
 *      runtimeconfig.json — the full framework-dependent runnable
 *      set; .pdb debug symbols are the only exclusion), plus a
 *      package README, the release notes, and a SHA256SUMS file
 *      computed over the folder's contents. Zipped as
 *      PixelForge-<version>-win-x64.zip.
 *   2. Linux: the Phase 36 Avalonia app (DesktopProjectGenerator's
 *      Linux target) is generated and built the same way
 *      (ELF-verified apphost). Packaged as
 *      SquadForgeApp-<version>-linux-x64.tar.gz.
 *   3. Installation verification (Linux, the platform that can
 *      execute here): the .tar.gz is extracted into a FRESH empty
 *      directory and the apphost is run twice with --smoke against
 *      a fresh config home; the launch count must persist (1, then
 *      2). The Windows package cannot execute on this host (no
 *      Windows, no Microsoft.WindowsDesktop.App for Linux — the
 *      Phase 57 platform record); its verification is the manifest
 *      diff against the build output performed during packaging.
 *
 * Packages land in ~/workspace/squadforge-audit/release/phase60/
 * (outside the repo snapshot). Usage:
 *   npx tsx scripts/phase60-release.ts
 * Requires the .NET 8 SDK (DOTNET_ROOT/PATH honored; falls back to
 * ~/tools/dotnet, this repo's documented local SDK location).
 */
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopBuildPipeline } from '../server/desktop/desktopBuildPipeline.js';
import { DesktopProjectGenerator } from '../server/desktop/desktopProjectGenerator.js';
import { ElfInspector } from '../server/desktop/elfInspector.js';
import { PeInspector } from '../server/desktop/peInspector.js';
import type { DesktopProjectConfig } from '../server/desktop/types.js';
import { ImageProjectGenerator } from '../server/imageEditor/imageProjectGenerator.js';

/** The single version string for this release, applied everywhere. */
export const RELEASE_VERSION = '1.0.0';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = path.resolve(repoRoot, '..', 'release', 'phase60');
const releaseNotesSource = path.join(repoRoot, 'GRAPHICS_EDITOR_RELEASE_NOTES.md');

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function sha256File(p: string): Promise<string> {
  return sha256(await fsp.readFile(p));
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf-8' });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Copies the real build output (minus .pdb symbols) into the package folder; returns the payload file names. */
async function packageBuildOutput(outDir: string, pkgDir: string): Promise<string[]> {
  const names = (await fsp.readdir(outDir)).filter((n) => !n.toLowerCase().endsWith('.pdb')).sort();
  for (const name of names) {
    const src = path.join(outDir, name);
    const dest = path.join(pkgDir, name);
    await fsp.copyFile(src, dest);
    const srcStat = await fsp.stat(src);
    await fsp.chmod(dest, srcStat.mode & 0o777);
    // Manifest diff, enforced at packaging time: the packaged file
    // must be byte-identical to the build output it came from.
    if ((await sha256File(src)) !== (await sha256File(dest))) {
      throw new Error(`packaging corrupted ${name}: package copy differs from build output`);
    }
  }
  return names;
}

/** Writes SHA256SUMS over every file currently in the package folder; returns the summed names. */
async function writeSha256Sums(pkgDir: string): Promise<string[]> {
  const names = (await fsp.readdir(pkgDir)).filter((n) => n !== 'SHA256SUMS').sort();
  const lines: string[] = [];
  for (const name of names) {
    lines.push(`${await sha256File(path.join(pkgDir, name))}  ${name}`);
  }
  await fsp.writeFile(path.join(pkgDir, 'SHA256SUMS'), lines.join('\n') + '\n');
  return names;
}

function reportArtifact(kind: string, p: string): void {
  const st = fs.statSync(p);
  console.log(`RELEASE_ARTIFACT ${kind} ${path.basename(p)} size=${st.size} sha256=${sha256(fs.readFileSync(p))}`);
}

async function main(): Promise<number> {
  // The pipeline resolves its workspaces from the process cwd and
  // the SDK from DOTNET_ROOT/PATH — pin both to this repo's setup.
  process.chdir(repoRoot);
  if (!process.env.DOTNET_ROOT) {
    const localSdk = path.join(os.homedir(), 'tools', 'dotnet');
    if (fs.existsSync(path.join(localSdk, 'dotnet'))) {
      process.env.DOTNET_ROOT = localSdk;
      process.env.PATH = `${localSdk}:${process.env.PATH ?? ''}`;
    }
  }
  const dotnet = DesktopProjectGenerator.detectDotnet();
  if (!dotnet) throw new Error('No .NET SDK found; cannot produce genuine release builds.');
  const dotnetRoot = path.dirname(dotnet);
  console.log(`[phase60] dotnet: ${dotnet}`);
  console.log(`[phase60] release version: ${RELEASE_VERSION}`);
  console.log(`[phase60] release folder: ${releaseRoot}`);
  await fsp.rm(releaseRoot, { recursive: true, force: true });
  await fsp.mkdir(releaseRoot, { recursive: true });

  const pipeline = new DesktopBuildPipeline();

  // ---------------------------------------------------------- Windows
  const winConfig: DesktopProjectConfig = {
    ...ImageProjectGenerator.getDefaultConfig('PixelForge'),
    version: RELEASE_VERSION
  };
  const winFiles = ImageProjectGenerator.generateProjectFiles(winConfig);
  const winResult = await pipeline.build('phase60-win', winConfig, winFiles, {
    configuration: 'Release',
    restore: true
  });
  if (winResult.status !== 'success') throw new Error(`Windows Release build failed: ${winResult.error}`);
  console.log(`[phase60] Windows Release build: success (${winResult.artifacts.map((a) => `${a.filename} ${a.sizeBytes}B`).join(', ')})`);

  const winOutDir = path.join(
    repoRoot, '.desktop_workspaces', 'phase60-win', 'src', winConfig.assemblyName,
    'bin', 'Release', winConfig.targetFramework, 'win-x64'
  );
  const winPkgName = `PixelForge-${RELEASE_VERSION}-win-x64`;
  const winPkgDir = path.join(releaseRoot, winPkgName);
  await fsp.mkdir(winPkgDir, { recursive: true });
  const winPayload = await packageBuildOutput(winOutDir, winPkgDir);
  for (const required of ['PixelForge.exe', 'PixelForge.dll', 'PixelForge.deps.json', 'PixelForge.runtimeconfig.json']) {
    if (!winPayload.includes(required)) throw new Error(`Windows package is missing ${required} — the apphost cannot start without it`);
  }
  for (const exeOrDll of ['PixelForge.exe', 'PixelForge.dll']) {
    const pe = PeInspector.inspect(await fsp.readFile(path.join(winPkgDir, exeOrDll)));
    if (!pe.isPeFile) throw new Error(`${exeOrDll} failed PE verification in the package: ${pe.errors.join('; ')}`);
    console.log(`[phase60] ${exeOrDll}: genuine PE (${pe.machine}, ${pe.subsystem}, ${pe.sections} sections)`);
  }
  await fsp.writeFile(
    path.join(winPkgDir, 'README.txt'),
    [
      `PixelForge ${RELEASE_VERSION} — Windows x64`,
      '',
      'Requirements: 64-bit Windows 10 or 11 and the .NET 8 Desktop Runtime',
      '(free from Microsoft). This is a framework-dependent package: the',
      'runtime is not bundled.',
      '',
      'Run: PixelForge.exe',
      '',
      'Crash reports: if an unhandled error occurs, a plain-text report is',
      'written to a "crashes" folder next to PixelForge.exe and the error',
      'message names the file. See GRAPHICS_EDITOR_RELEASE_NOTES.md.',
      '',
      'Verify: SHA256SUMS lists the SHA-256 of every file in this folder.',
      'This build is unsigned; Windows SmartScreen may warn on first run.',
      ''
    ].join('\r\n')
  );
  await fsp.copyFile(releaseNotesSource, path.join(winPkgDir, 'GRAPHICS_EDITOR_RELEASE_NOTES.md'));
  const winSummed = await writeSha256Sums(winPkgDir);
  console.log(`[phase60] Windows package: ${winPkgName} (${winSummed.length} files summed, payload: ${winPayload.join(', ')})`);
  const winZip = run('zip', ['-r', '-q', `${winPkgName}.zip`, winPkgName], releaseRoot);
  if (winZip.status !== 0) throw new Error('zip of the Windows package failed');
  reportArtifact('windows-folder-exe', path.join(winPkgDir, 'PixelForge.exe'));
  reportArtifact('windows-folder-dll', path.join(winPkgDir, 'PixelForge.dll'));
  reportArtifact('windows-zip', path.join(releaseRoot, `${winPkgName}.zip`));

  // ---------------------------------------------------------- Linux
  const linuxConfig: DesktopProjectConfig = {
    ...DesktopProjectGenerator.getLinuxDefaultConfig(),
    version: RELEASE_VERSION
  };
  const linuxFiles = DesktopProjectGenerator.generateProjectFiles(linuxConfig);
  const linuxResult = await pipeline.build('phase60-linux', linuxConfig, linuxFiles, {
    configuration: 'Release',
    restore: true
  });
  if (linuxResult.status !== 'success') throw new Error(`Linux Release build failed: ${linuxResult.error}`);
  console.log(`[phase60] Linux Release build: success (${linuxResult.artifacts.map((a) => `${a.filename} ${a.sizeBytes}B`).join(', ')})`);

  const linuxOutDir = path.join(
    repoRoot, '.desktop_workspaces', 'phase60-linux', 'src', linuxConfig.assemblyName,
    'bin', 'Release', linuxConfig.targetFramework, 'linux-x64'
  );
  const linuxPkgName = `${linuxConfig.assemblyName}-${RELEASE_VERSION}-linux-x64`;
  const linuxPkgDir = path.join(releaseRoot, linuxPkgName);
  await fsp.mkdir(linuxPkgDir, { recursive: true });
  const linuxPayload = await packageBuildOutput(linuxOutDir, linuxPkgDir);
  for (const required of [linuxConfig.assemblyName, `${linuxConfig.assemblyName}.deps.json`, `${linuxConfig.assemblyName}.runtimeconfig.json`]) {
    if (!linuxPayload.includes(required)) throw new Error(`Linux package is missing ${required} — the apphost cannot start without it`);
  }
  const apphostPath = path.join(linuxPkgDir, linuxConfig.assemblyName);
  const elf = ElfInspector.inspect(await fsp.readFile(apphostPath));
  if (!elf.isElfFile) throw new Error(`Linux apphost failed ELF verification in the package: ${elf.errors.join('; ')}`);
  if ((fs.statSync(apphostPath).mode & 0o111) === 0) throw new Error('Linux apphost lost its executable bit in packaging');
  console.log(`[phase60] ${linuxConfig.assemblyName}: genuine ELF (${elf.elfClass}, ${elf.endianness}, ${elf.machine}, ${elf.objectType}), executable bit set`);
  await fsp.writeFile(
    path.join(linuxPkgDir, 'README.txt'),
    [
      `${linuxConfig.assemblyName} ${RELEASE_VERSION} — Linux x64`,
      '',
      'The SquadForge Desktop Development Engine\'s Linux application',
      '(Avalonia UI). This is NOT the PixelForge image editor — see',
      'GRAPHICS_EDITOR_RELEASE_NOTES.md for what each package is.',
      '',
      'Requirements: 64-bit Linux and the .NET 8 Runtime (free from',
      'Microsoft). This is a framework-dependent package: the runtime',
      'is not bundled.',
      '',
      `Run: ./${linuxConfig.assemblyName} (needs a display for the window)`,
      `Headless check: ./${linuxConfig.assemblyName} --smoke`,
      `State is stored as JSON in ~/.config/${linuxConfig.assemblyName}/state.json.`,
      '',
      'Verify: SHA256SUMS lists the SHA-256 of every file in this folder.',
      ''
    ].join('\n')
  );
  await fsp.copyFile(releaseNotesSource, path.join(linuxPkgDir, 'GRAPHICS_EDITOR_RELEASE_NOTES.md'));
  const linuxSummed = await writeSha256Sums(linuxPkgDir);
  console.log(`[phase60] Linux package: ${linuxPkgName} (${linuxSummed.length} files summed, ${linuxPayload.length} payload files)`);
  const tar = run('tar', ['-czf', `${linuxPkgName}.tar.gz`, '-C', releaseRoot, linuxPkgName], releaseRoot);
  if (tar.status !== 0) throw new Error('tar.gz of the Linux package failed');
  reportArtifact('linux-folder-apphost', apphostPath);
  reportArtifact('linux-tarball', path.join(releaseRoot, `${linuxPkgName}.tar.gz`));

  // ---------------------------------------------------------- Linux installation verification
  const installRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'phase60-install-'));
  try {
    // --no-same-owner: a normal user extracting a release tarball
    // keeps their own ownership; it also keeps this sandbox (whose
    // build files are root-owned) from failing on chown.
    const untar = run('tar', ['--no-same-owner', '-xzf', path.join(releaseRoot, `${linuxPkgName}.tar.gz`), '-C', installRoot], installRoot);
    if (untar.status !== 0) throw new Error(`extracting the Linux package into a fresh directory failed: ${untar.stderr.trim()}`);
    const installedApp = path.join(installRoot, linuxPkgName, linuxConfig.assemblyName);
    if (!fs.existsSync(installedApp)) throw new Error('extracted package has no apphost');
    const configHome = path.join(installRoot, 'config-home');
    // The config home must exist before the run (as it does on any
    // real user machine): .NET's GetFolderPath(ApplicationData)
    // returns an empty path for a nonexistent XDG_CONFIG_HOME, and
    // the app would fall back to a CWD-relative state path.
    await fsp.mkdir(configHome, { recursive: true });
    const smokeEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: configHome, DOTNET_ROOT: dotnetRoot };
    const run1 = run(installedApp, ['--smoke'], installRoot, smokeEnv);
    console.log(`INSTALL_SMOKE run1 (exit ${run1.status}): ${run1.stdout.trim()}`);
    if (run1.status !== 0 || !new RegExp(`SMOKE_OK ${linuxConfig.assemblyName} launches=1`).test(run1.stdout)) {
      throw new Error('first --smoke run of the extracted package did not report launches=1');
    }
    const run2 = run(installedApp, ['--smoke'], installRoot, smokeEnv);
    console.log(`INSTALL_SMOKE run2 (exit ${run2.status}): ${run2.stdout.trim()}`);
    if (run2.status !== 0 || !new RegExp(`SMOKE_OK ${linuxConfig.assemblyName} launches=2`).test(run2.stdout)) {
      throw new Error('second --smoke run of the extracted package did not report launches=2 (state did not persist)');
    }
    const state = JSON.parse(fs.readFileSync(path.join(configHome, linuxConfig.assemblyName, 'state.json'), 'utf-8'));
    if (state.LaunchCount !== 2) throw new Error(`persisted state LaunchCount is ${state.LaunchCount}, expected 2`);
    console.log('[phase60] Linux installation verification: extracted package starts, state persists across runs (LaunchCount 1 → 2)');
  } finally {
    await fsp.rm(installRoot, { recursive: true, force: true });
  }

  console.log('PHASE60_RELEASE_OK');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[phase60] release failed: ${err?.message || err}`);
      process.exit(1);
    }
  );
}
