import * as fs from 'fs';
import * as path from 'path';
import { sanitizeWorkspacePath } from '../pathSecurity.js';

/**
 * Phase 22: file explorer / project navigation service for an IDE
 * workspace. Every path is sanitized through the shared SquadForge
 * path-security layer (traversal, absolute paths and null bytes are
 * rejected before touching disk).
 */

export interface FileTreeNode {
  name: string;
  path: string; // workspace-relative, posix separators
  kind: 'file' | 'directory';
  sizeBytes?: number;
  children?: FileTreeNode[];
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', '.ide_artifacts']);
const MAX_TREE_DEPTH = 8;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class WorkspaceFiles {
  constructor(private readonly workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    fs.mkdirSync(this.workspaceRoot, { recursive: true });
  }

  public get root(): string {
    return this.workspaceRoot;
  }

  private resolve(relPath: string): string {
    const result = sanitizeWorkspacePath(this.workspaceRoot, relPath, { checkSymlinks: false });
    if (!result.valid) throw new Error(`Unsafe workspace path: ${relPath} (${result.error ?? 'rejected'})`);
    return result.absolutePath;
  }

  private toRel(abs: string): string {
    return path.relative(this.workspaceRoot, abs).split(path.sep).join('/');
  }

  public tree(): FileTreeNode {
    const walk = (abs: string, depth: number): FileTreeNode => {
      const stat = fs.statSync(abs);
      const node: FileTreeNode = {
        name: path.basename(abs) || this.workspaceRoot,
        path: this.toRel(abs),
        kind: stat.isDirectory() ? 'directory' : 'file'
      };
      if (stat.isFile()) node.sizeBytes = stat.size;
      if (stat.isDirectory() && depth < MAX_TREE_DEPTH) {
        node.children = fs
          .readdirSync(abs)
          .filter((name) => !SKIP_DIRS.has(name))
          .sort((a, b) => a.localeCompare(b))
          .map((name) => walk(path.join(abs, name), depth + 1));
      }
      return node;
    };
    return walk(this.workspaceRoot, 0);
  }

  public listFiles(): string[] {
    const out: string[] = [];
    const walk = (abs: string, depth: number): void => {
      if (depth > MAX_TREE_DEPTH) return;
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(abs, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else out.push(this.toRel(full));
      }
    };
    walk(this.workspaceRoot, 0);
    return out.sort();
  }

  public readFile(relPath: string): string {
    const abs = this.resolve(relPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`File not found: ${relPath}`);
    if (fs.statSync(abs).size > MAX_FILE_BYTES) throw new Error(`File too large to edit: ${relPath}`);
    return fs.readFileSync(abs, 'utf8');
  }

  public writeFile(relPath: string, content: string): void {
    const abs = this.resolve(relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  public createFile(relPath: string, content: string = ''): void {
    const abs = this.resolve(relPath);
    if (fs.existsSync(abs)) throw new Error(`File already exists: ${relPath}`);
    this.writeFile(relPath, content);
  }

  public deletePath(relPath: string): void {
    const abs = this.resolve(relPath);
    if (abs === this.workspaceRoot) throw new Error('Cannot delete the workspace root');
    if (!fs.existsSync(abs)) throw new Error(`Path not found: ${relPath}`);
    fs.rmSync(abs, { recursive: true, force: true });
  }

  public renamePath(fromRel: string, toRel: string): void {
    const from = this.resolve(fromRel);
    const to = this.resolve(toRel);
    if (!fs.existsSync(from)) throw new Error(`Path not found: ${fromRel}`);
    if (fs.existsSync(to)) throw new Error(`Target already exists: ${toRel}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }

  public writeProjectFiles(files: Record<string, string>): void {
    for (const [relPath, content] of Object.entries(files)) {
      this.writeFile(relPath, content);
    }
  }
}
