import * as fs from 'fs';
import * as path from 'path';
import { TerminalService } from './terminalService.js';

/**
 * Phase 22: dependency & package management. npm operations are real
 * (`npm install` inside the workspace through the secure terminal);
 * .NET uses `dotnet add package` (real NuGet restore). Listing reads
 * the project's own manifest — never a fabricated registry view.
 */

export interface PackageInfo {
  name: string;
  version: string;
  kind: 'dependency' | 'devDependency' | 'nuget';
}

export class PackageService {
  constructor(private readonly terminal: TerminalService) {}

  public listPackages(): PackageInfo[] {
    const root = this.terminal.root;
    const out: PackageInfo[] = [];
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        out.push({ name, version: String(version), kind: 'dependency' });
      }
      for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
        out.push({ name, version: String(version), kind: 'devDependency' });
      }
    }
    // NuGet references from the first .csproj found
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !['node_modules', '.git', 'bin', 'obj'].includes(entry.name)) {
          stack.push(path.join(dir, entry.name));
        } else if (entry.name.endsWith('.csproj')) {
          const xml = fs.readFileSync(path.join(dir, entry.name), 'utf8');
          for (const m of xml.matchAll(/<PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)"/g)) {
            out.push({ name: m[1], version: m[2], kind: 'nuget' });
          }
        }
      }
    }
    return out;
  }

  public async addNpmPackage(name: string, dev: boolean = false): Promise<void> {
    const args = ['install', dev ? '--save-dev' : '--save', name];
    const result = await this.terminal.run('npm', args, { timeoutMs: 300_000 });
    if (result.exitCode !== 0) {
      throw new Error(`npm install ${name} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ')}`);
    }
  }

  public async addNuGetPackage(csprojRelPath: string, name: string): Promise<void> {
    const result = await this.terminal.run('dotnet', ['add', csprojRelPath, 'package', name], { timeoutMs: 300_000 });
    if (result.exitCode !== 0) {
      throw new Error(`dotnet add package ${name} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ')}`);
    }
  }
}
