import { ProjectFile } from '../types.js';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'pip';

export interface ProjectDependencyPlan {
  ecosystem: 'node' | 'python' | 'none';
  packageManager: PackageManager | null;
  supported: boolean;
  hasLockfile: boolean;
  hasDependencies: boolean;
  scripts: Record<string, string>;
  reason?: string;
}

/** Scripts a user may run. A project cannot add to this list. */
export const RUNNABLE_SCRIPTS = ['dev', 'start', 'build', 'test', 'preview'] as const;

function fileAt(files: ProjectFile[], path: string): ProjectFile | undefined {
  return files.find(file => file.path === path);
}

export function planDependencies(files: ProjectFile[]): ProjectDependencyPlan {
  const manifest = fileAt(files, 'package.json');

  if (!manifest) {
    const isPython = Boolean(fileAt(files, 'requirements.txt') || fileAt(files, 'pyproject.toml'));
    return {
      ecosystem: isPython ? 'python' : 'none',
      packageManager: isPython ? 'pip' : null,
      supported: !isPython,
      hasLockfile: false,
      hasDependencies: isPython,
      scripts: {},
      reason: isPython ? 'Python projects are detected but not supported yet.' : undefined
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(manifest.content);
  } catch {
    return {
      ecosystem: 'node',
      packageManager: 'npm',
      supported: false,
      hasLockfile: false,
      hasDependencies: false,
      scripts: {},
      reason: 'package.json is not valid JSON.'
    };
  }

  const scripts = parsed && typeof parsed.scripts === 'object' && parsed.scripts ? parsed.scripts : {};
  const hasDependencies = ['dependencies', 'devDependencies', 'optionalDependencies']
    .some(key => Object.keys(parsed?.[key] || {}).length > 0);

  for (const [lockfile, manager] of [['yarn.lock', 'yarn'], ['pnpm-lock.yaml', 'pnpm']] as const) {
    if (fileAt(files, lockfile)) {
      return {
        ecosystem: 'node',
        packageManager: manager,
        supported: false,
        hasLockfile: true,
        hasDependencies,
        scripts,
        reason: `${manager} projects are detected but not supported yet. Installing with npm would ignore ${lockfile}.`
      };
    }
  }

  return {
    ecosystem: 'node',
    packageManager: 'npm',
    supported: true,
    hasLockfile: Boolean(fileAt(files, 'package-lock.json')),
    hasDependencies,
    scripts
  };
}

/**
 * Builds the install command. Lifecycle scripts stay off unless explicitly approved,
 * because they would run package code during the only phase with network access.
 */
export function buildInstallCommand(
  plan: ProjectDependencyPlan,
  options: { registryUrl: string; allowScripts: boolean }
): string[] {
  return [
    'npm',
    plan.hasLockfile ? 'ci' : 'install',
    ...(options.allowScripts ? [] : ['--ignore-scripts']),
    '--no-audit',
    '--no-fund',
    '--cache',
    '/cache/npm',
    '--registry',
    options.registryUrl
  ];
}

/** Script name of a scoped test run. It never counts as a run of the whole test suite. */
export const AFFECTED_TEST_SCRIPT = 'test:affected';

/**
 * Arguments that limit a test script to some files, or null when that cannot be done safely.
 * A compound script would pass them to its last command, so it runs in full instead.
 */
export function affectedTestArgs(definition: string, testFiles: string[]): string[] | null {
  if (testFiles.length === 0 || /[;&|]/.test(definition)) return null;
  if (!testFiles.every(file => /^[\w][\w./-]*$/.test(file))) return null;
  // A helper holds no tests, and some runners fail on that, so the whole suite runs instead
  if (!testFiles.every(file => /\.(?:test|spec)\./.test(file))) return null;
  if (/\bvitest\b/.test(definition)) return ['--run', ...testFiles];
  if (/\bjest\b/.test(definition)) return ['--runTestsByPath', ...testFiles];
  return null;
}

/** Finds packages a project failed to load, from real process output. */
export function detectMissingModules(output: string): string[] {
  const missing = new Set<string>();
  const patterns = [
    /Cannot find (?:module|package) '([^']+)'/g,
    /Failed to resolve import "([^"]+)"/g,
    /Could not resolve "([^"]+)"/g
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const name = match[1];
      if (name.startsWith('.') || name.startsWith('/') || name.startsWith('node:')) continue;
      missing.add(name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]);
    }
  }
  return Array.from(missing).sort();
}
