import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isPathScopedWithin } from '../pathSecurity.js';

/**
 * Phase 22: secure terminal for generated IDE workspaces.
 *
 * Security model (defense in depth, honestly scoped):
 * - Allowlisted executables only (node, npm, npx, dotnet, git,
 *   python3, tsc) — no shell is ever spawned (`shell: false`), so
 *   shell metacharacters in arguments are inert data, not syntax.
 * - The working directory is locked to the workspace root.
 * - Arguments that look like filesystem paths must resolve inside
 *   the workspace (scoped packages `@a/b`, flags and URLs exempt).
 * - Environment is scrubbed to a minimal safe set; timeout and an
 *   output cap bound every run.
 *
 * This is process-level isolation for a single-user dev tool, not a
 * container/VM sandbox — the docs say so plainly.
 */

export const ALLOWED_EXECUTABLES = ['node', 'npm', 'npx', 'dotnet', 'git', 'python3', 'tsc'] as const;

export interface TerminalRunResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface TerminalOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function looksLikePathArg(arg: string): boolean {
  if (arg.startsWith('-')) return false; // flag
  if (arg.includes('://')) return false; // URL
  if (arg.startsWith('@')) return false; // scoped npm package
  return arg.includes('/') || arg.includes('\\') || arg === '..' || arg === '.';
}

export function assertArgsWithinWorkspace(workspaceRoot: string, args: string[]): void {
  for (const raw of args) {
    if (!looksLikePathArg(raw)) continue;
    const candidate = raw.startsWith('file:') ? raw.slice('file:'.length) : raw;
    const resolved = path.resolve(workspaceRoot, candidate);
    // The workspace root itself ('.') is allowed; anything outside is not.
    if (resolved !== workspaceRoot && !isPathScopedWithin(workspaceRoot, resolved)) {
      throw new Error(`Argument path escapes the workspace: ${raw}`);
    }
  }
}

export class TerminalService {
  constructor(private readonly workspaceRoot: string) {
    const resolved = path.resolve(workspaceRoot);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Workspace root does not exist: ${workspaceRoot}`);
    }
    this.workspaceRoot = resolved;
  }

  public get root(): string {
    return this.workspaceRoot;
  }

  public async run(command: string, args: string[] = [], options: TerminalOptions = {}): Promise<TerminalRunResult> {
    const base = path.basename(command);
    if (!(ALLOWED_EXECUTABLES as readonly string[]).includes(base)) {
      throw new Error(`Executable not allowed in the IDE terminal: ${command}. Allowed: ${ALLOWED_EXECUTABLES.join(', ')}`);
    }
    assertArgsWithinWorkspace(this.workspaceRoot, args);
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    const started = Date.now();

    return new Promise((resolve) => {
      const child = spawn(base, args, {
        cwd: this.workspaceRoot,
        shell: false,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          DOTNET_ROOT: process.env.DOTNET_ROOT ?? '',
          DOTNET_CLI_TELEMETRY_OPTOUT: '1',
          DOTNET_NOLOGO: '1',
          CI: '1'
        }
      });
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      const append = (current: string, chunk: Buffer): string => {
        const next = current + chunk.toString();
        if (next.length > maxOutputBytes) {
          truncated = true;
          return next.slice(0, maxOutputBytes);
        }
        return next;
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => (stdout = append(stdout, d)));
      child.stderr?.on('data', (d: Buffer) => (stderr = append(stderr, d)));
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          command: base, args, cwd: this.workspaceRoot, exitCode: -1,
          stdout, stderr: stderr + String(err), timedOut, truncated, durationMs: Date.now() - started
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          command: base, args, cwd: this.workspaceRoot, exitCode: code,
          stdout, stderr, timedOut, truncated, durationMs: Date.now() - started
        });
      });
    });
  }
}
