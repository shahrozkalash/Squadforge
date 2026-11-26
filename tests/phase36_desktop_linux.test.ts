import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DesktopProjectGenerator, AVALONIA_VERSION } from '../server/desktop/desktopProjectGenerator.js';
import { DesktopBuildPipeline } from '../server/desktop/desktopBuildPipeline.js';
import { ElfInspector } from '../server/desktop/elfInspector.js';
import {
  isValidDesktopArtifactFilename,
  storeDesktopArtifactBuffer,
  getDesktopArtifactBuffer
} from '../server/desktop/desktopRoutes.js';
import type { DesktopProjectConfig } from '../server/desktop/types.js';

const execFileAsync = promisify(execFile);

function minimalElfBuffer(objectType: number = 3, machine: number = 0x3e): Buffer {
  const buf = Buffer.alloc(128, 0);
  buf[0] = 0x7f; // DEL
  buf[1] = 0x45; // E
  buf[2] = 0x4c; // L
  buf[3] = 0x46; // F
  buf[4] = 2; // 64-bit
  buf[5] = 1; // little-endian
  buf[6] = 1; // current version
  buf.writeUInt16LE(objectType, 16);
  buf.writeUInt16LE(machine, 18);
  return buf;
}

describe('SquadForge Phase 36: Desktop Development Engine — Linux Target', () => {
  const config: DesktopProjectConfig = DesktopProjectGenerator.getLinuxDefaultConfig(
    'FitTrack Linux',
    'FitTrackLinux'
  );
  const files = DesktopProjectGenerator.generateProjectFiles(config);
  const root = 'src/FitTrackLinux';

  describe('1. Linux config validation', () => {
    test('1.1 The Linux default config validates clean', () => {
      assert.deepEqual(DesktopProjectGenerator.validateConfig(config), []);
      assert.equal(config.platform, 'linux');
      assert.equal(config.uiFramework, 'avalonia');
      assert.equal(config.targetFramework, 'net8.0');
    });

    test('1.2 Windows-only frameworks and TFM are rejected for Linux', () => {
      const winforms = DesktopProjectGenerator.validateConfig({ ...config, uiFramework: 'winforms' });
      assert.ok(winforms.some((e) => e.includes('avalonia')), winforms.join('; '));
      const winTfm = DesktopProjectGenerator.validateConfig({ ...config, targetFramework: 'net8.0-windows' });
      assert.ok(winTfm.some((e) => e.includes('net8.0')), winTfm.join('; '));
    });

    test('1.3 requireAdministrator is rejected for Linux instead of being faked', () => {
      const errors = DesktopProjectGenerator.validateConfig({ ...config, requireAdministrator: true });
      assert.ok(errors.some((e) => e.includes('requireAdministrator')), errors.join('; '));
    });

    test('1.4 macOS remains honestly unsupported', () => {
      const errors = DesktopProjectGenerator.validateConfig({ ...config, platform: 'macos' });
      assert.ok(errors.some((e) => e.includes('not yet supported')), errors.join('; '));
      assert.throws(
        () => DesktopProjectGenerator.generateProjectFiles({ ...config, platform: 'macos' }),
        /Invalid desktop project config/
      );
    });
  });

  describe('2. Linux project generation', () => {
    test('2.1 Generates a complete Avalonia project structure', () => {
      for (const expected of [
        'FitTrackLinux.sln',
        `${root}/FitTrackLinux.csproj`,
        `${root}/Program.cs`,
        `${root}/App.axaml`,
        `${root}/App.axaml.cs`,
        `${root}/MainWindow.axaml`,
        `${root}/MainWindow.axaml.cs`,
        `${root}/AppState.cs`,
        `${root}/FitTrackLinux.desktop`,
        'Directory.Build.props',
        'build.sh',
        'README.md',
        '.gitignore'
      ]) {
        assert.ok(files[expected], `missing generated file: ${expected}`);
        assert.ok(files[expected].length > 0, `empty generated file: ${expected}`);
      }
      // Windows-only files must not leak into a Linux project.
      assert.ok(!files[`${root}/app.manifest`], 'app.manifest is a Windows artifact');
      assert.ok(!files[`${root}/MainForm.cs`], 'WinForms sources must not be generated for Linux');
      assert.ok(!files['build.ps1'], 'build.ps1 is a Windows artifact');
    });

    test('2.2 csproj targets the real Linux desktop stack', () => {
      const csproj = files[`${root}/FitTrackLinux.csproj`];
      assert.match(csproj, /<TargetFramework>net8\.0<\/TargetFramework>/);
      assert.match(csproj, /<RuntimeIdentifier>linux-x64<\/RuntimeIdentifier>/);
      assert.match(csproj, /<OutputType>WinExe<\/OutputType>/);
      for (const pkg of ['Avalonia', 'Avalonia.Desktop', 'Avalonia.Themes.Fluent', 'Avalonia.Fonts.Inter']) {
        assert.ok(
          csproj.includes(`<PackageReference Include="${pkg}" Version="${AVALONIA_VERSION}" />`),
          `missing pinned package reference: ${pkg}`
        );
      }
      assert.ok(!csproj.includes('UseWindowsForms'), 'WinForms must not be referenced');
      assert.ok(!csproj.includes('EnableWindowsTargeting'), 'Windows targeting must not be enabled');
    });

    test('2.3 Generated C# is a real application, not a mockup', () => {
      const program = files[`${root}/Program.cs`];
      assert.match(program, /BuildAvaloniaApp\(\)\.StartWithClassicDesktopLifetime\(args\)/);
      assert.match(program, /--smoke/);
      assert.match(program, /SMOKE_OK/);
      const window = files[`${root}/MainWindow.axaml.cs`];
      assert.match(window, /AppStateStore/);
      assert.match(window, /LaunchCount\+\+/);
      assert.match(window, /OnSaveClicked/);
      const state = files[`${root}/AppState.cs`];
      assert.match(state, /JsonSerializer\.Serialize/);
      assert.match(state, /SpecialFolder\.ApplicationData/);
      const axaml = files[`${root}/MainWindow.axaml`];
      assert.match(axaml, /x:Name="MessageBox"/);
      assert.match(axaml, /x:Name="SaveButton"/);
      assert.match(axaml, /x:Name="StatusLabel"/);
      // The code-behind looks up exactly the names the XAML declares.
      for (const name of ['MessageBox', 'SaveButton', 'StatusLabel']) {
        assert.ok(window.includes(`FindControl`), 'code-behind must bind controls');
        assert.ok(window.includes(`"${name}"`), `code-behind must look up ${name}`);
      }
    });

    test('2.4 The freedesktop entry points at the apphost', () => {
      const entry = files[`${root}/FitTrackLinux.desktop`];
      assert.match(entry, /\[Desktop Entry\]/);
      assert.match(entry, /Exec=FitTrackLinux/);
      assert.match(entry, /Type=Application/);
    });
  });

  describe('3. ELF inspection (genuine format validation)', () => {
    test('3.1 Parses a structurally valid 64-bit ELF header', () => {
      const report = ElfInspector.inspect(minimalElfBuffer(3, 0x3e));
      assert.equal(report.isElfFile, true);
      assert.equal(report.elfClass, '64-bit');
      assert.equal(report.endianness, 'little-endian');
      assert.equal(report.machine, 'x86-64');
      assert.match(report.objectType || '', /DYN/);
    });

    test('3.2 Rejects non-ELF data instead of waving it through', () => {
      assert.equal(ElfInspector.inspect(Buffer.from('this is not an executable')).isElfFile, false);
      assert.equal(ElfInspector.inspect(Buffer.alloc(10)).isElfFile, false);
      // A Windows PE buffer is not an ELF file.
      const mz = Buffer.alloc(128, 0);
      mz[0] = 0x4d;
      mz[1] = 0x5a;
      assert.equal(ElfInspector.inspect(mz).isElfFile, false);
    });

    test('3.3 Rejects a non-executable ELF object type', () => {
      const core = ElfInspector.inspect(minimalElfBuffer(4, 0x3e)); // ET_CORE
      assert.equal(core.isElfFile, false);
      assert.ok(core.errors.some((e) => e.includes('not an executable')));
    });
  });

  describe('4. Desktop artifact filenames (route layer)', () => {
    test('4.1 The shapes the engine emits are accepted', () => {
      assert.equal(isValidDesktopArtifactFilename('FitTrack.exe'), true);
      assert.equal(isValidDesktopArtifactFilename('FitTrack.dll'), true);
      assert.equal(isValidDesktopArtifactFilename('FitTrackLinux'), true);
      assert.equal(isValidDesktopArtifactFilename('FitTrackLinux.deps.json'), true);
      assert.equal(isValidDesktopArtifactFilename('FitTrackLinux.runtimeconfig.json'), true);
      assert.equal(isValidDesktopArtifactFilename('random.json'), false);
    });

    test('4.2 Traversal and foreign shapes stay rejected', () => {
      assert.equal(isValidDesktopArtifactFilename('../FitTrack'), false);
      assert.equal(isValidDesktopArtifactFilename('FitTrack/exe'), false);
      assert.equal(isValidDesktopArtifactFilename('FitTrack.zip'), false);
      assert.equal(isValidDesktopArtifactFilename('.hidden'), false);
      assert.equal(isValidDesktopArtifactFilename(''), false);
    });

    test('4.3 Artifact buffers round-trip for exe and apphost names', () => {
      const exeBuf = Buffer.from('pe-bytes');
      storeDesktopArtifactBuffer('phase36names', 'FitTrack.exe', exeBuf);
      assert.deepEqual(getDesktopArtifactBuffer('phase36names', 'FitTrack.exe'), exeBuf);
      const elfBuf = minimalElfBuffer();
      storeDesktopArtifactBuffer('phase36names', 'FitTrackLinux', elfBuf);
      assert.deepEqual(getDesktopArtifactBuffer('phase36names', 'FitTrackLinux'), elfBuf);
      assert.throws(
        () => storeDesktopArtifactBuffer('phase36names', '../evil', exeBuf),
        /Security Violation/
      );
    });
  });

  describe('5. Toolchain detection & genuine build', () => {
    test('5.1 Genuine Linux build produces an ELF-verified apphost, or fails honestly without an SDK', { timeout: 600_000 }, async () => {
      const dotnet = DesktopProjectGenerator.detectDotnet();
      const pipeline = new DesktopBuildPipeline();
      const result = await pipeline.build('phase36test', config, files, {
        configuration: 'Debug',
        restore: true
      });
      if (!dotnet) {
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /\.NET SDK/);
        assert.equal(result.artifacts.length, 0);
        return;
      }
      assert.equal(result.status, 'success', result.error || 'build failed');
      assert.equal(result.platform, 'linux');
      const apphost = result.artifacts.find((a) => a.kind === 'exe');
      assert.ok(apphost, 'expected an executable artifact');
      assert.equal(apphost!.filename, 'FitTrackLinux', 'the Linux executable is the extensionless apphost');
      assert.ok(apphost!.sizeBytes > 50_000, 'apphost should be a real binary, not a stub');
      const artifactPath = path.join(process.cwd(), '.desktop_artifacts', 'phase36test', apphost!.filename);
      const elf = ElfInspector.inspect(fs.readFileSync(artifactPath));
      assert.equal(elf.isElfFile, true);
      assert.equal(elf.elfClass, '64-bit');
      assert.equal(elf.machine, 'x86-64');
      // The framework-dependent apphost needs its manifests beside
      // it to start; both must be harvested with the binary.
      for (const manifest of ['FitTrackLinux.deps.json', 'FitTrackLinux.runtimeconfig.json']) {
        const entry = result.artifacts.find((a) => a.filename === manifest);
        assert.ok(entry, `expected harvested manifest: ${manifest}`);
        assert.ok(
          fs.existsSync(path.join(process.cwd(), '.desktop_artifacts', 'phase36test', manifest)),
          `manifest missing from artifacts dir: ${manifest}`
        );
      }
      // The harvested artifact keeps its executable bit.
      assert.ok((fs.statSync(artifactPath).mode & 0o111) !== 0, 'apphost artifact must be executable');
    });

    test('5.2 The built apphost genuinely runs: --smoke exercises the state store', { timeout: 600_000 }, async () => {
      const dotnet = DesktopProjectGenerator.detectDotnet();
      if (!dotnet) return; // covered by 5.1's honest-failure path
      const artifactPath = path.join(process.cwd(), '.desktop_artifacts', 'phase36test', 'FitTrackLinux');
      if (!fs.existsSync(artifactPath)) {
        // Build it here if 5.1 did not leave one (test isolation).
        const pipeline = new DesktopBuildPipeline();
        const result = await pipeline.build('phase36test', config, files, {
          configuration: 'Debug',
          restore: true
        });
        assert.equal(result.status, 'success', result.error || 'build failed');
      }
      const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'phase36-smoke-'));
      const env = { ...process.env, XDG_CONFIG_HOME: configHome };
      try {
        const first = await execFileAsync(artifactPath, ['--smoke'], { env, timeout: 60_000 });
        assert.match(first.stdout, /SMOKE_OK FitTrackLinux launches=1/);
        const statePath = path.join(configHome, 'FitTrackLinux', 'state.json');
        assert.ok(fs.existsSync(statePath), 'smoke run must write the state file');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.LaunchCount, 1);
        const second = await execFileAsync(artifactPath, ['--smoke'], { env, timeout: 60_000 });
        assert.match(second.stdout, /SMOKE_OK FitTrackLinux launches=2/);
        const state2 = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state2.LaunchCount, 2, 'launch count must persist across runs');
      } finally {
        fs.rmSync(configHome, { recursive: true, force: true });
      }
    });

    test('5.3 Broken C# source fails honestly with compiler diagnostics', { timeout: 600_000 }, async () => {
      const dotnet = DesktopProjectGenerator.detectDotnet();
      if (!dotnet) return; // covered by 5.1's honest-failure path
      const broken = { ...files };
      broken[`${root}/MainWindow.axaml.cs`] = 'this is not valid C# at all {{{';
      const pipeline = new DesktopBuildPipeline();
      const result = await pipeline.build('phase36broken', config, broken, {
        configuration: 'Debug',
        restore: true
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.artifacts.length, 0);
      assert.ok((result.error || '').length > 0);
      assert.ok(result.diagnostics.length > 0, 'compiler diagnostics must be surfaced, not swallowed');
    });
  });
});
