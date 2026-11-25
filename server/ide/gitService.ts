import { TerminalService } from './terminalService.js';

/**
 * Phase 22: Git integration over the secure terminal — every call is
 * a real `git` invocation inside the workspace (init, status, add,
 * commit, log, diff, branches). No network operations are exposed.
 */

export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
}

export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export class GitService {
  constructor(private readonly terminal: TerminalService) {}

  private async git(args: string[]): Promise<string> {
    const result = await this.terminal.run('git', args);
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().split('\n')[0]}`);
    }
    return result.stdout;
  }

  public async isRepository(): Promise<boolean> {
    const result = await this.terminal.run('git', ['rev-parse', '--is-inside-work-tree']);
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  public async init(): Promise<void> {
    await this.git(['init', '-b', 'main']);
  }

  public async status(): Promise<GitFileStatus[]> {
    const out = await this.git(['status', '--porcelain']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => ({ index: line[0], worktree: line[1], path: line.slice(3).trim() }));
  }

  public async add(paths: string[]): Promise<void> {
    await this.git(['add', '--', ...paths]);
  }

  public async commit(message: string, authorName: string = 'SquadForge IDE', authorEmail: string = 'ide@squadforge.local'): Promise<string> {
    await this.git([
      '-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`,
      'commit', '-m', message
    ]);
    return (await this.git(['rev-parse', 'HEAD'])).trim();
  }

  public async log(maxCount: number = 20): Promise<GitCommit[]> {
    const out = await this.git(['log', `--max-count=${maxCount}`, '--pretty=format:%H%x1f%an%x1f%ad%x1f%s', '--date=iso']);
    if (!out.trim()) return [];
    return out.split('\n').map((line) => {
      const [hash, author, date, subject] = line.split('\x1f');
      return { hash, author, date, subject };
    });
  }

  public async diff(staged: boolean = false): Promise<string> {
    return this.git(staged ? ['diff', '--cached'] : ['diff']);
  }

  public async branches(): Promise<string[]> {
    const out = await this.git(['branch', '--format=%(refname:short)']);
    return out.split('\n').filter(Boolean);
  }

  public async currentBranch(): Promise<string> {
    return (await this.git(['branch', '--show-current'])).trim();
  }
}
