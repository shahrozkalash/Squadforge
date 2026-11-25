import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { DesktopProjectGenerator } from '../server/desktop/desktopProjectGenerator.js';
import { DesktopBuildPipeline } from '../server/desktop/desktopBuildPipeline.js';
import { PeInspector } from '../server/desktop/peInspector.js';
import {
  assertSafeWorkspacePath,
  sanitizeProjectFilePath
} from '../server/desktop/index.js';

function minimalPeBuffer(subsystem: number = 2): Buffer {
  const peOffset = 0x80;
  const buf = Buffer.alloc(1024, 0);
  buf[0] = 0x4d; // M
  buf[1] = 0x5a; // Z
  buf.writeUInt32LE(peOffset, 0x3c);
  buf[peOffset] = 0x50; // P
  buf[peOffset + 1] = 0x45; // E
  const coff = peOffset + 4;
  buf.writeUInt16LE(0x8664, coff); // x64
  buf.writeUInt16LE(6, coff + 2); // sections
  buf.writeUInt16LE(0xf0, coff + 16); // optional header size (PE32+)
  buf.writeUInt16LE(0x20b, coff + 20); // PE32+ magic
  buf.writeUInt16LE(subsystem, coff + 20 + 68);
  return buf;
}

describe('SquadForge Phase 18: Desktop Development Engine Test Suite', () => {
  const config = DesktopProjectGenerator.getDefaultConfig('FitTrack', 'FitTrack');
  const files = DesktopProjectGenerator.generateProjectFiles(config);

  describe('1. Windows Project Generation', () => {
    test('1.1 Generates a complete Visual Studio solution structure', () => {
      for (const expected of [
        'FitTrack.sln',
        'src/FitTrack/FitTrack.csproj',
        'src/FitTrack/Program.cs',
        'src/FitTrack/MainForm.cs',
        'src/FitTrack/MainForm.Designer.cs',
        'src/FitTrack/app.manifest',
        'Directory.Build.props',
        'build.ps1',
        'build.sh',
        'README.md',
        '.gitignore'
      ]) {
        assert.ok(files[expected], `missing generated file: ${expected}`);
        assert.ok(files[expected].length > 0, `empty generated file: ${expected}`);
      }
    });

    test('1.2 csproj targets real Windows desktop stack (net8.0-windows, WinForms, win-x64)', () => {
      const csproj = files['src/FitTrack/FitTrack.csproj'];
      assert.match(csproj, /<TargetFramework>net8\.0-windows<\/TargetFramework>/);
      assert.match(csproj, /<UseWindowsForms>true<\/UseWindowsForms>/);
      assert.match(csproj, /<OutputType>WinExe<\/OutputType>/);
      assert.match(csproj, /<RuntimeIdentifier>win-x64<\/RuntimeIdentifier>/);
      assert.match(csproj, /<EnableWindowsTargeting>true<\/EnableWindowsTargeting>/);
    });

    test('1.3 Generated C# is a real application, not a mockup', () => {
      assert.match(files['src/FitTrack/Program.cs'], /\[STAThread\]/);
      assert.match(files['src/FitTrack/Program.cs'], /Application\.Run\(new MainForm\(\)\)/);
      // Real behavior: persistent state via JSON file I/O
      assert.match(files['src/FitTrack/MainForm.cs'], /JsonSerializer\.Serialize/);
      assert.match(files['src/FitTrack/MainForm.cs'], /SpecialFolder\.ApplicationData/);
      assert.match(files['src/FitTrack/MainForm.Designer.cs'], /saveButton\.Click \+= OnSaveClicked/);
    });

    test('1.4 App manifest defaults to asInvoker and honors requireAdministrator', () => {
      assert.match(files['src/FitTrack/app.manifest'], /level="asInvoker"/);
      const adminFiles = DesktopProjectGenerator.generateProjectFiles({
        ...config,
        requireAdministrator: true
      });
      assert.match(adminFiles['src/FitTrack/app.manifest'], /level="requireAdministrator"/);
    });
  });

  describe('2. Config Validation & Honest Platform Scope', () => {
    test('2.1 Default config validates clean', () => {
      assert.deepEqual(DesktopProjectGenerator.validateConfig(config), []);
    });

    test('2.2 Invalid assembly names are rejected', () => {
      const errors = DesktopProjectGenerator.validateConfig({ ...config, assemblyName: '9bad name!' });
      assert.ok(errors.some((e) => e.includes('assemblyName')));
      assert.throws(
        () => DesktopProjectGenerator.generateProjectFiles({ ...config, assemblyName: 'bad-name' }),
        /Invalid desktop project config/
      );
    });

    test('2.3 Linux/macOS are rejected honestly until their generators land', () => {
      for (const platform of ['linux', 'macos'] as const) {
        const errors = DesktopProjectGenerator.validateConfig({ ...config, platform });
        assert.ok(errors.some((e) => e.includes('not yet supported')), `expected honest rejection for ${platform}`);
      }
    });
  });

  describe('3. Workspace Isolation & Path Security', () => {
    test('3.1 Traversal paths cannot escape the workspace', () => {
      const base = path.join(process.cwd(), '.desktop_workspaces');
      assert.throws(() => assertSafeWorkspacePath(base, '../escape.txt'), /Security Violation/);
      assert.throws(() => assertSafeWorkspacePath(base, '/etc/passwd'), /Security Violation/);
      const inside = assertSafeWorkspacePath(base, 'build1/src/App/Program.cs');
      assert.ok(inside.startsWith(base));
    });

    test('3.2 sanitizeProjectFilePath rejects traversal segments outright', () => {
      const cleaned = sanitizeProjectFilePath('src/../../evil.cs');
      assert.ok(cleaned === null || !cleaned.includes('..'), `expected rejection or neutralization, got: ${cleaned}`);
      assert.equal(sanitizeProjectFilePath('src/App/Program.cs'), 'src/App/Program.cs');
    });
  });

  describe('4. PE Inspection (genuine format validation)', () => {
    test('4.1 Parses a structurally valid PE header', () => {
      const report = PeInspector.inspect(minimalPeBuffer(2));
      assert.equal(report.isPeFile, true);
      assert.equal(report.machine, 'x64 (AMD64)');
      assert.equal(report.subsystem, 'Windows GUI');
      assert.equal(report.isGuiApp, true);
      assert.equal(report.sections, 6);
    });

    test('4.2 Rejects non-PE data instead of waving it through', () => {
      assert.equal(PeInspector.inspect(Buffer.from('this is not an executable')).isPeFile, false);
      assert.equal(PeInspector.inspect(Buffer.alloc(10)).isPeFile, false);
      const mzOnly = Buffer.alloc(128, 0);
      mzOnly[0] = 0x4d;
      mzOnly[1] = 0x5a;
      mzOnly.writeUInt32LE(0x40, 0x3c); // PE sig missing at 0x40
      assert.equal(PeInspector.inspect(mzOnly).isPeFile, false);
    });
  });

  describe('5. Toolchain Detection & Genuine Build', () => {
    test('5.1 detectDotnet never fabricates a path', () => {
      const found = DesktopProjectGenerator.detectDotnet();
      if (found) assert.ok(fs.existsSync(found), 'reported dotnet path must exist');
    });

    test('5.2 Genuine build produces a PE-verified .exe, or fails honestly without an SDK', { timeout: 600_000 }, async () => {
      const dotnet = DesktopProjectGenerator.detectDotnet();
      const pipeline = new DesktopBuildPipeline();
      const result = await pipeline.build('phase18test', config, files, {
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
      const exe = result.artifacts.find((a) => a.kind === 'exe');
      assert.ok(exe, 'expected an .exe artifact');
      assert.ok(exe!.sizeBytes > 50_000, 'apphost exe should be a real binary, not a stub');
      const buf = fs.readFileSync(
        path.join(process.cwd(), '.desktop_artifacts', 'phase18test', exe!.filename)
      );
      const pe = PeInspector.inspect(buf);
      assert.equal(pe.isPeFile, true);
      assert.equal(pe.isGuiApp, true);
    });

    test('5.3 Broken C# source fails honestly with compiler diagnostics', { timeout: 600_000 }, async () => {
      const dotnet = DesktopProjectGenerator.detectDotnet();
      if (!dotnet) return; // covered by 5.2's honest-failure path
      const broken = { ...files };
      broken['src/FitTrack/MainForm.cs'] = 'this is not valid C# at all {{{';
      const pipeline = new DesktopBuildPipeline();
      const result = await pipeline.build('phase18broken', config, broken, {
        configuration: 'Debug',
        restore: false
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.artifacts.length, 0);
      assert.ok((result.error || '').length > 0);
    });
  });
});
