import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DesktopProjectGenerator } from '../server/desktop/desktopProjectGenerator.js';
import { ElfInspector } from '../server/desktop/elfInspector.js';
import { PeInspector } from '../server/desktop/peInspector.js';
import { ImageProjectGenerator } from '../server/imageEditor/imageProjectGenerator.js';
import { RELEASE_VERSION } from '../scripts/phase60-release.js';

/**
 * Phase 60: Desktop Release and Quality Assurance.
 *
 * These tests pin the release deliverables produced by
 * scripts/phase60-release.ts: the single release version applied
 * through the generator (csproj + crash-report stamps), the crash
 * diagnostics the generated app ships (UI-independent writer,
 * wired in Program.Main), the harness scenario that executes the
 * writer, the release notes' required content, and the produced
 * packages under ~/workspace/squadforge-audit/release/phase60/
 * (required files present, SHA256SUMS verifying against the files
 * on disk, archives listing the payload). The packages are local
 * release outputs, not repo content, so tests 60.9/60.10 skip with
 * an explicit reason in a checkout where the release was never
 * built (e.g. CI) and verify fully wherever the packages exist —
 * the same gating pattern as this repo's Docker and live-provider
 * suites. Runtime evidence lives
 * in the harness (S15) and the release driver's install smoke;
 * these tests keep all of it from silently rotting.
 */

const repoRoot = resolve(import.meta.dirname, '..');
const releaseRoot = resolve(repoRoot, '..', 'release', 'phase60');

const config = ImageProjectGenerator.getDefaultConfig('PixelForge');
const files = ImageProjectGenerator.generateProjectFiles(config);
const program = files['src/PixelForge/Program.cs'];
const crash = files['src/PixelForge/CrashDiagnostics.cs'];
const csproj = files['src/PixelForge/PixelForge.csproj'];

/** Strip C# comments so absence assertions judge code, not prose (same helper as the Phase 57 suite). */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

function sha256File(p: string): string {
  return crypto.createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** Verifies a package folder's SHA256SUMS against the files on disk; returns the summed names. */
function verifySha256Sums(pkgDir: string): string[] {
  const sumsPath = join(pkgDir, 'SHA256SUMS');
  assert.ok(existsSync(sumsPath), `SHA256SUMS present in ${pkgDir}`);
  const lines = readFileSync(sumsPath, 'utf8').trim().split('\n');
  const names: string[] = [];
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{64})  (.+)$/);
    assert.ok(m, `SHA256SUMS line is well-formed: ${line}`);
    const [, hash, name] = m!;
    const p = join(pkgDir, name);
    assert.ok(existsSync(p), `summed file exists: ${name}`);
    assert.equal(sha256File(p), hash, `SHA-256 of ${name} matches SHA256SUMS`);
    names.push(name);
  }
  return names;
}

describe('Phase 60 — one release version, applied through the generator', () => {
  test('60.1 the release version is 1.0.0 and the generated project carries it', () => {
    assert.equal(RELEASE_VERSION, '1.0.0');
    assert.equal(config.version, RELEASE_VERSION, 'the default config version is the release version');
    assert.match(csproj, new RegExp(`<Version>${RELEASE_VERSION.replace(/\./g, '\\.')}</Version>`));
    assert.match(crash, new RegExp(`public const string AppVersion = "${RELEASE_VERSION.replace(/\./g, '\\.')}";`));
    assert.match(crash, /public const string AppName = "PixelForge";/);
  });

  test('60.2 the version knob is the config, not a hardcoded string', () => {
    const custom = { ...config, version: '2.3.4' };
    const customFiles = ImageProjectGenerator.generateProjectFiles(custom);
    assert.match(customFiles['src/PixelForge/PixelForge.csproj'], /<Version>2\.3\.4<\/Version>/);
    assert.match(customFiles['src/PixelForge/CrashDiagnostics.cs'], /public const string AppVersion = "2\.3\.4";/);
  });
});

describe('Phase 60 — crash diagnostics in the generated app', () => {
  test('60.3 CrashDiagnostics.cs is emitted and stays UI-independent (the Phase 57 seam)', () => {
    assert.ok(crash, 'generator emits CrashDiagnostics.cs');
    const code = codeOnly(crash);
    assert.doesNotMatch(code, /System\.Windows\.Forms/);
    assert.doesNotMatch(code, /System\.Drawing/);
    assert.doesNotMatch(code, /\bBitmap\b/);
    assert.doesNotMatch(code, /MessageBox/);
    assert.match(crash, /public static string BuildReport\(Exception exception, string context, DateTimeOffset timestamp\)/);
    assert.match(crash, /public static string WriteReport\(Exception exception, string context, string directory\)/);
    assert.match(crash, /public static string\? TryWriteReport\(Exception exception, string context\)/);
    assert.match(crash, /DefaultReportDirectory => Path\.Combine\(AppContext\.BaseDirectory, "crashes"\)/);
    assert.match(crash, /RuntimeInformation\.OSDescription/);
    assert.match(crash, /RuntimeInformation\.FrameworkDescription/);
  });

  test('60.4 Program.Main wires the handlers and tells the user where the report went', () => {
    assert.match(program, /Application\.SetUnhandledExceptionMode\(UnhandledExceptionMode\.CatchException\)/);
    assert.match(program, /Application\.ThreadException \+=/);
    assert.match(program, /AppDomain\.CurrentDomain\.UnhandledException \+=/);
    const writes = program.match(/CrashDiagnostics\.TryWriteReport/g) ?? [];
    assert.equal(writes.length, 2, 'both handlers route through the never-throws writer');
    assert.match(program, /MessageBox\.Show\(/);
    assert.match(program, /reportPath/);
    assert.match(program, /hit an unexpected error\. A crash report was written to:/);
    assert.match(program, /Application\.Run\(new MainForm\(\)\)/);
  });

  test('60.5 the generated README documents the crash reports', () => {
    const readme = files['README.md'];
    assert.match(readme, /Crash reports \(Phase 60\)/);
    assert.match(readme, /`crashes` folder next to the executable/);
  });

  test('60.6 the runtime harness compiles and executes the crash writer (S15)', () => {
    const driver = readFileSync(join(repoRoot, 'scripts', 'phase57-runtime-harness.ts'), 'utf8');
    assert.match(driver, /PHASE60_EXTRA_CORE_SOURCES = \['CrashDiagnostics\.cs'\]/);
    const harnessProgram = readFileSync(join(repoRoot, 'scripts', 'phase57-runtime-harness', 'Program.cs'), 'utf8');
    assert.match(harnessProgram, /Scenario\("S15 crash diagnostics: report writer executes and records the exception"/);
    assert.match(harnessProgram, /CrashDiagnostics\.WriteReport/);
    assert.match(harnessProgram, /CrashDiagnostics\.TryWriteReport/);
  });
});

describe('Phase 60 — release notes', () => {
  const notesPath = join(repoRoot, 'GRAPHICS_EDITOR_RELEASE_NOTES.md');

  test('60.7 the release notes exist and describe both packages honestly', () => {
    assert.ok(existsSync(notesPath), 'GRAPHICS_EDITOR_RELEASE_NOTES.md is in the repo root');
    const notes = readFileSync(notesPath, 'utf8');
    assert.match(notes, /Version 1\.0\.0/);
    assert.match(notes, /PixelForge 1\.0\.0 for Windows/);
    assert.match(notes, /SquadForgeApp 1\.0\.0 for Linux/);
    assert.match(notes, /This package is not the image editor/);
    assert.match(notes, /\.NET 8 Desktop Runtime/);
    assert.match(notes, /\.NET 8 Runtime/);
  });

  test('60.8 the release notes state the format levels, crash reports and limitations', () => {
    const notes = readFileSync(notesPath, 'utf8');
    assert.match(notes, /progressive/);
    assert.match(notes, /Refused by name/);
    assert.match(notes, /BigTIFF/);
    assert.match(notes, /`crashes` folder/);
    assert.match(notes, /No GPU acceleration exists/);
    assert.match(notes, /has never been run on a Windows machine/);
  });
});

describe('Phase 60 — the produced release packages', () => {
  const winPkg = join(releaseRoot, `PixelForge-${RELEASE_VERSION}-win-x64`);
  const linuxPkg = join(releaseRoot, `SquadForgeApp-${RELEASE_VERSION}-linux-x64`);

  test('60.9 the Windows package is complete and its sums verify', (t) => {
    if (!existsSync(winPkg)) {
      t.skip('Windows release package not present in this checkout (release outputs live outside the repo) — run scripts/phase60-release.ts; this test verifies fully wherever the package exists');
      return;
    }
    const summed = verifySha256Sums(winPkg);
    for (const required of [
      'PixelForge.exe',
      'PixelForge.dll',
      'PixelForge.deps.json',
      'PixelForge.runtimeconfig.json',
      'README.txt',
      'GRAPHICS_EDITOR_RELEASE_NOTES.md'
    ]) {
      assert.ok(summed.includes(required), `Windows package contains ${required}`);
    }
    for (const bin of ['PixelForge.exe', 'PixelForge.dll']) {
      const pe = PeInspector.inspect(readFileSync(join(winPkg, bin)));
      assert.equal(pe.isPeFile, true, `${bin} is a genuine PE`);
    }
    const zipPath = join(releaseRoot, `PixelForge-${RELEASE_VERSION}-win-x64.zip`);
    assert.ok(existsSync(zipPath), 'Windows zip exists');
    const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
    for (const required of ['PixelForge.exe', 'PixelForge.dll', 'PixelForge.deps.json', 'PixelForge.runtimeconfig.json', 'SHA256SUMS']) {
      assert.ok(listing.includes(required), `zip contains ${required}`);
    }
  });

  test('60.10 the Linux package is complete, ELF-verified, executable, and its sums verify', (t) => {
    if (!existsSync(linuxPkg)) {
      t.skip('Linux release package not present in this checkout (release outputs live outside the repo) — run scripts/phase60-release.ts; this test verifies fully wherever the package exists');
      return;
    }
    const summed = verifySha256Sums(linuxPkg);
    for (const required of ['SquadForgeApp', 'SquadForgeApp.dll', 'SquadForgeApp.deps.json', 'SquadForgeApp.runtimeconfig.json', 'README.txt', 'GRAPHICS_EDITOR_RELEASE_NOTES.md']) {
      assert.ok(summed.includes(required), `Linux package contains ${required}`);
    }
    const apphost = join(linuxPkg, 'SquadForgeApp');
    const elf = ElfInspector.inspect(readFileSync(apphost));
    assert.equal(elf.isElfFile, true, 'apphost is a genuine ELF');
    assert.equal(elf.machine, 'x86-64');
    assert.ok((statSync(apphost).mode & 0o111) !== 0, 'apphost keeps its executable bit');
    const tarPath = join(releaseRoot, `SquadForgeApp-${RELEASE_VERSION}-linux-x64.tar.gz`);
    assert.ok(existsSync(tarPath), 'Linux tarball exists');
    const listing = execFileSync('tar', ['-tzf', tarPath], { encoding: 'utf8' });
    for (const required of ['SquadForgeApp', 'SquadForgeApp.runtimeconfig.json', 'SHA256SUMS']) {
      assert.ok(listing.includes(required), `tarball contains ${required}`);
    }
  });

  test('60.11 the Linux generator config carries the same release version', () => {
    const linuxConfig = DesktopProjectGenerator.getLinuxDefaultConfig();
    assert.equal(linuxConfig.version, RELEASE_VERSION);
    const linuxFiles = DesktopProjectGenerator.generateProjectFiles(linuxConfig);
    assert.match(linuxFiles['src/SquadForgeApp/SquadForgeApp.csproj'], new RegExp(`<Version>${RELEASE_VERSION.replace(/\./g, '\\.')}</Version>`));
  });
});
