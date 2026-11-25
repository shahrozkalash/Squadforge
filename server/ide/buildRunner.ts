import * as fs from 'fs';
import * as path from 'path';
import { TerminalService, TerminalRunResult } from './terminalService.js';

/**
 * Phase 22: build & run controls with structured diagnostics.
 * Detects the project kind in the workspace, runs the real toolchain
 * through the secure terminal, and parses compiler output into
 * file/line/column diagnostics (TypeScript and C# formats) so the
 * IDE can show an error list — the debugging workflow builds on the
 * same diagnostic shape the Phase debugging system uses.
 */

export type ProjectKind = 'node' | 'dotnet' | 'python' | 'android' | 'unknown';

export interface Diagnostic {
  severity: 'error' | 'warning';
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

export interface BuildOutcome {
  kind: ProjectKind;
  success: boolean;
  result: TerminalRunResult;
  diagnostics: Diagnostic[];
}

function shallowEntries(root: string, depth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      out.push(entry.name);
      if (entry.isDirectory() && d < depth && !['node_modules', '.git', 'bin', 'obj'].includes(entry.name)) {
        walk(path.join(dir, entry.name), d + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

export function detectProjectKind(workspaceRoot: string): ProjectKind {
  if (fs.existsSync(path.join(workspaceRoot, 'package.json'))) return 'node';
  const entries = shallowEntries(workspaceRoot, 2);
  if (entries.some((e) => e.endsWith('.csproj') || e.endsWith('.sln'))) return 'dotnet';
  if (entries.some((e) => e.endsWith('build.gradle.kts') || e.endsWith('settings.gradle.kts'))) return 'android';
  if (entries.some((e) => e.endsWith('.py')) || fs.existsSync(path.join(workspaceRoot, 'requirements.txt'))) return 'python';
  return 'unknown';
}

const TS_DIAG = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/;
const CS_DIAG = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Z]+\d+):\s*(.+?)(?:\s*\[.*\])?$/;

export function parseDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const m = line.match(TS_DIAG) ?? line.match(CS_DIAG);
    if (!m) continue;
    const key = `${m[1]}:${m[2]}:${m[5]}:${m[6]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push({
      file: m[1].trim(),
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] as 'error' | 'warning',
      code: m[5],
      message: m[6].trim()
    });
  }
  return diagnostics;
}

export class BuildRunner {
  constructor(private readonly terminal: TerminalService) {}

  public async build(): Promise<BuildOutcome> {
    const root = this.terminal.root;
    const kind = detectProjectKind(root);
    let result: TerminalRunResult;
    switch (kind) {
      case 'node': {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        result = pkg.scripts?.build
          ? await this.terminal.run('npm', ['run', 'build'])
          : await this.terminal.run('npx', ['tsc', '--noEmit']);
        break;
      }
      case 'dotnet':
        result = await this.terminal.run('dotnet', ['build']);
        break;
      case 'python':
        result = await this.terminal.run('python3', ['-m', 'compileall', '-q', '.']);
        break;
      case 'android':
        // Gradle execution is the Phase 17 pipeline's job; report honestly.
        throw new Error('Android builds run through the Phase 17 Android engine, not the IDE build runner');
      default:
        throw new Error('No recognizable project in the workspace (looked for package.json, .csproj/.sln, Python sources)');
    }
    const diagnostics = parseDiagnostics(result.stdout + '\n' + result.stderr);
    return { kind, success: result.exitCode === 0, result, diagnostics };
  }

  public async runApp(): Promise<TerminalRunResult> {
    const root = this.terminal.root;
    const kind = detectProjectKind(root);
    switch (kind) {
      case 'node': {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        if (pkg.scripts?.start) return this.terminal.run('npm', ['start'], { timeoutMs: 30_000 });
        const entry = ['src/index.js', 'index.js', 'src/main.js', 'main.js'].find((f) => fs.existsSync(path.join(root, f)));
        if (!entry) throw new Error('No start script or entry file found');
        return this.terminal.run('node', [entry], { timeoutMs: 30_000 });
      }
      case 'dotnet':
        return this.terminal.run('dotnet', ['run'], { timeoutMs: 60_000 });
      case 'python': {
        const entry = ['main.py', 'app.py', 'src/main.py'].find((f) => fs.existsSync(path.join(root, f)));
        if (!entry) throw new Error('No Python entry file (main.py / app.py) found');
        return this.terminal.run('python3', [entry], { timeoutMs: 30_000 });
      }
      default:
        throw new Error(`Cannot run project kind: ${kind}`);
    }
  }
}
