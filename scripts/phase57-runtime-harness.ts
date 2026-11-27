/**
 * Phase 57 runtime harness driver.
 *
 * Regenerates the PixelForge desktop app fresh from the current
 * generator, copies ONLY its UI-independent sources (PixelEngine.cs
 * and ImageDocument.cs — the raw-buffer engine core and document
 * model — plus, since Phase 60, CrashDiagnostics.cs, the generated
 * app's UI-independent crash-report writer) into a throwaway console
 * project together with the checked-in harness program
 * (scripts/phase57-runtime-harness/Program.cs), builds
 * it with the local .NET SDK and runs it. The harness executes real
 * editing workflows against the generated classes on this machine and
 * exits non-zero if any assertion fails.
 *
 * The generated app's GDI boundary (the two .Drawing.cs files) and its
 * WinForms shell are deliberately NOT compiled: System.Drawing.Common
 * and System.Windows.Forms do not execute on Linux .NET 8. That seam
 * is the Phase 57 separation; see PHASE_57_ACCEPTANCE_REPORT.md.
 *
 * Usage: npx tsx scripts/phase57-runtime-harness.ts
 * Requires the .NET SDK (DOTNET_ROOT/PATH honored; falls back to
 * ~/tools/dotnet, this repo's documented local SDK location).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImageProjectGenerator } from '../server/imageEditor/imageProjectGenerator.js';

/** The generated sources the harness compiles: the UI-independent core, nothing else. */
export const PHASE57_CORE_SOURCES = ['PixelEngine.cs', 'ImageDocument.cs'] as const;

/**
 * Phase 60: the generated app's crash-diagnostics writer is
 * UI-independent by design (text formatting + file IO only), so the
 * harness compiles it alongside the Phase 57 core sources and
 * executes it (scenario S15). Listed separately so the Phase 57
 * core-source pin above stays exact.
 */
export const PHASE60_EXTRA_CORE_SOURCES = ['CrashDiagnostics.cs'] as const;

/** The generated sources the harness deliberately excludes, with the reason for each. */
export const PHASE57_EXCLUDED_SOURCES: Record<string, string> = {
  'PixelEngine.Drawing.cs': 'GDI boundary (System.Drawing.Common Bitmap conversions)',
  'ImageDocument.Drawing.cs': 'GDI surface (EditorLayer Bitmap cache, ImageDocument.Flatten)',
  'EditorCanvas.cs': 'WinForms control (System.Windows.Forms)',
  'MainForm.cs': 'WinForms shell (System.Windows.Forms)',
  'Dialogs.cs': 'WinForms dialogs (System.Windows.Forms)',
  'Workspace.cs': 'WinForms-bound shortcut resolver (KeyEventArgs/Keys)',
  'Program.cs': 'WinForms entry point (Application.Run)'
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const harnessProgram = join(repoRoot, 'scripts', 'phase57-runtime-harness', 'Program.cs');

function dotnetEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.DOTNET_ROOT) {
    const localSdk = join(homedir(), 'tools', 'dotnet');
    if (existsSync(join(localSdk, 'dotnet'))) {
      env.DOTNET_ROOT = localSdk;
      env.PATH = `${localSdk}:${env.PATH ?? ''}`;
    }
  }
  return env;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): number {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main(): number {
  const env = dotnetEnv();
  const dotnet = env.DOTNET_ROOT ? join(env.DOTNET_ROOT, 'dotnet') : 'dotnet';

  // 1. Fresh generation — never trust stale output.
  const config = ImageProjectGenerator.getDefaultConfig();
  const files = ImageProjectGenerator.generateProjectFiles(config);
  const srcDir = Object.keys(files).find((p) => p.endsWith('/PixelEngine.cs'));
  if (!srcDir) throw new Error('generation did not emit PixelEngine.cs');
  const srcPrefix = srcDir.slice(0, -'PixelEngine.cs'.length);

  // 2. Stage the harness project in a fresh temp directory.
  const work = join(tmpdir(), 'squadforge-phase57-harness');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  for (const name of PHASE57_CORE_SOURCES) {
    const key = srcPrefix + name;
    const content = files[key];
    if (typeof content !== 'string') throw new Error(`generation did not emit ${key}`);
    const dest = join(work, name);
    writeFileSync(dest, content);
    console.log(`[phase57] core source: ${name} (${statSync(dest).size} bytes, fresh from the generator)`);
  }
  for (const name of PHASE60_EXTRA_CORE_SOURCES) {
    const key = srcPrefix + name;
    const content = files[key];
    if (typeof content !== 'string') throw new Error(`generation did not emit ${key}`);
    const dest = join(work, name);
    writeFileSync(dest, content);
    console.log(`[phase57] core source (Phase 60): ${name} (${statSync(dest).size} bytes, fresh from the generator)`);
  }
  for (const [name, why] of Object.entries(PHASE57_EXCLUDED_SOURCES)) {
    console.log(`[phase57] excluded: ${name} — ${why}`);
  }
  copyFileSync(harnessProgram, join(work, 'Program.cs'));
  writeFileSync(
    join(work, 'Phase57Harness.csproj'),
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup>',
      '    <OutputType>Exe</OutputType>',
      '    <TargetFramework>net8.0</TargetFramework>',
      '    <ImplicitUsings>enable</ImplicitUsings>',
      '    <Nullable>enable</Nullable>',
      '    <AssemblyName>Phase57Harness</AssemblyName>',
      '  </PropertyGroup>',
      '</Project>',
      ''
    ].join('\n')
  );

  // 3. Build, then run. The harness process exit code is the verdict.
  const buildStatus = run(dotnet, ['build', '-c', 'Release', '-o', join(work, 'out'), join(work, 'Phase57Harness.csproj')], work, env);
  if (buildStatus !== 0) {
    console.error(`[phase57] harness build failed (exit ${buildStatus})`);
    return buildStatus;
  }
  console.log('[phase57] harness build succeeded; running workflows…');
  const runStatus = run(dotnet, [join(work, 'out', 'Phase57Harness.dll')], work, env);
  console.log(`[phase57] harness exit code: ${runStatus}`);
  return runStatus;
}

process.exit(main());
