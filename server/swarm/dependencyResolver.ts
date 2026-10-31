import { ProjectFile } from '../types.js';

export interface BrowserPackageConfig {
  version?: string;
  url?: string;
  allowSubpaths: boolean;
  description?: string;
}

export interface ScannedImport {
  specifier: string;
  sourceFile: string;
  type: 'static_import' | 'dynamic_import' | 're_export' | 'require';
  status: 'allowed' | 'rejected_server' | 'rejected_subpath' | 'rejected_unsupported';
  resolvedUrl?: string;
  diagnostic?: string;
}

export interface DependencyResolutionResult {
  valid: boolean;
  importMap: Record<string, string>;
  externalList: string[];
  unsupportedDependencies: string[];
  diagnostics: string[];
  scannedImports: ScannedImport[];
}

/**
 * Pinned browser package registry with explicit subpath enforcement and version consistency.
 * Pinned versions strictly match package.json where applicable.
 */
export const BROWSER_PACKAGE_REGISTRY: Record<string, BrowserPackageConfig> = {
  'react': {
    version: '19.0.1',
    url: 'https://esm.sh/react@19?dev',
    allowSubpaths: true,
    description: 'Core React library'
  },
  'react-dom': {
    version: '19.0.1',
    url: 'https://esm.sh/react-dom@19?dev',
    allowSubpaths: true,
    description: 'React DOM renderer'
  },
  'react-dom/client': {
    version: '19.0.1',
    url: 'https://esm.sh/react-dom@19/client?dev',
    allowSubpaths: false,
    description: 'React 19 DOM Client root API'
  },
  'react/jsx-runtime': {
    version: '19.0.1',
    url: 'https://esm.sh/react@19/jsx-runtime?dev',
    allowSubpaths: false,
    description: 'React 19 JSX runtime'
  },
  'lucide-react': {
    version: '0.546.0',
    url: 'https://esm.sh/lucide-react@0.546.0?dev',
    allowSubpaths: true,
    description: 'Lucide React icon system'
  },
  'motion': {
    version: '12.23.24',
    url: 'https://esm.sh/motion@12.23.24?dev',
    allowSubpaths: true,
    description: 'Motion animation engine'
  },
  'framer-motion': {
    version: '12.23.24',
    url: 'https://esm.sh/framer-motion@12.23.24?dev',
    allowSubpaths: true,
    description: 'Framer Motion animations'
  },
  'canvas-confetti': {
    version: '1.9.4',
    url: 'https://esm.sh/canvas-confetti?dev',
    allowSubpaths: false,
    description: 'Canvas confetti visual effects'
  },
  'clsx': {
    version: '2.1.1',
    url: 'https://esm.sh/clsx@2.1.1?dev',
    allowSubpaths: false,
    description: 'Conditional className utility'
  },
  'tailwind-merge': {
    version: '3.0.2',
    url: 'https://esm.sh/tailwind-merge@3.0.2?dev',
    allowSubpaths: false,
    description: 'Tailwind class merging utility'
  },
  'date-fns': {
    version: '4.1.0',
    url: 'https://esm.sh/date-fns@4.1.0?dev',
    allowSubpaths: true,
    description: 'Modern date utility library'
  },
  'zustand': {
    version: '5.0.3',
    url: 'https://esm.sh/zustand@5.0.3?dev',
    allowSubpaths: true,
    description: 'Lightweight client state management'
  },
  'axios': {
    version: '1.8.1',
    url: 'https://esm.sh/axios@1.8.1?dev',
    allowSubpaths: false,
    description: 'Promise-based HTTP client'
  },
  '@tanstack/react-query': {
    version: '5.66.0',
    url: 'https://esm.sh/@tanstack/react-query@5.66.0?dev',
    allowSubpaths: true,
    description: 'TanStack asynchronous state management'
  },
  'react-router-dom': {
    version: '7.2.0',
    url: 'https://esm.sh/react-router-dom@7.2.0?dev',
    allowSubpaths: true,
    description: 'Declarative browser routing'
  },
  'react-router': {
    version: '7.2.0',
    url: 'https://esm.sh/react-router@7.2.0?dev',
    allowSubpaths: true,
    description: 'React router core'
  }
};

/**
 * Complete list of Node.js built-ins and server-only dependencies.
 * All node:* prefixed specifiers and bare module names are detected and rejected.
 */
export const FORBIDDEN_SERVER_MODULES = new Set<string>([
  // Node.js built-ins (bare & node: prefix handled dynamically)
  'fs', 'node:fs',
  'path', 'node:path',
  'os', 'node:os',
  'crypto', 'node:crypto',
  'child_process', 'node:child_process',
  'http', 'node:http',
  'https', 'node:https',
  'net', 'node:net',
  'tls', 'node:tls',
  'dgram', 'node:dgram',
  'dns', 'node:dns',
  'readline', 'node:readline',
  'stream', 'node:stream',
  'buffer', 'node:buffer',
  'util', 'node:util',
  'url', 'node:url',
  'vm', 'node:vm',
  'v8', 'node:v8',
  'zlib', 'node:zlib',
  'cluster', 'node:cluster',
  'worker_threads', 'node:worker_threads',
  'perf_hooks', 'node:perf_hooks',
  'async_hooks', 'node:async_hooks',
  'events', 'node:events',
  'process', 'node:process',
  'timers', 'node:timers',
  'inspector', 'node:inspector',
  // Server-side packages
  'express',
  'cookie-parser',
  'nodemailer',
  'dotenv',
  'bcryptjs',
  'bcrypt',
  'sqlite',
  'sqlite3',
  'better-sqlite3',
  'node:sqlite',
  'jsonwebtoken',
  'pg',
  'mysql2',
  'mongoose',
  'mongodb',
  'redis',
  'ioredis',
  '@google/genai'
]);

export class DependencyResolverService {
  private static customAllowedPackages: Map<string, BrowserPackageConfig> = new Map();

  static registerAllowedPackage(name: string, config?: BrowserPackageConfig): void {
    this.customAllowedPackages.set(name, config || { allowSubpaths: true });
  }

  static getCustomAllowedPackage(name: string): BrowserPackageConfig | undefined {
    return this.customAllowedPackages.get(name);
  }

  static resetAllowedPackages(): void {
    this.customAllowedPackages.clear();
  }

  /**
   * Identifies whether a module specifier corresponds to a Node.js built-in or server-side package.
   */
  static isForbiddenServerModule(specifier: string): boolean {
    if (!specifier || typeof specifier !== 'string') return false;
    const clean = specifier.trim().toLowerCase();

    // Check node: scheme
    if (clean.startsWith('node:')) return true;

    // Check direct match
    if (FORBIDDEN_SERVER_MODULES.has(clean)) return true;

    // Check package base name (handles scoped packages and subpaths)
    const base = this.extractBasePackage(clean);
    return FORBIDDEN_SERVER_MODULES.has(base);
  }

  /**
   * Extracts the base package name from a module specifier.
   * Accurately supports scoped packages (@scope/pkg/sub -> @scope/pkg) and standard packages (pkg/sub -> pkg).
   */
  static extractBasePackage(specifier: string): string {
    const trimmed = specifier.trim();
    if (trimmed.startsWith('@')) {
      const parts = trimmed.split('/');
      return parts.slice(0, 2).join('/');
    }
    return trimmed.split('/')[0];
  }

  /**
   * Retrieves effective package version from registry or custom package configurations.
   */
  static getEffectivePackageVersion(packageName: string): string | undefined {
    const config = BROWSER_PACKAGE_REGISTRY[packageName] || this.customAllowedPackages.get(packageName);
    return config?.version;
  }

  /**
   * Resolves a single import specifier against the browser registry with subpath validation.
   */
  static resolveSpecifier(specifier: string): {
    allowed: boolean;
    packageName: string;
    subpath?: string;
    esmUrl?: string;
    diagnostic?: string;
    status: 'allowed' | 'rejected_server' | 'rejected_subpath' | 'rejected_unsupported';
  } {
    if (!specifier || typeof specifier !== 'string') {
      return {
        allowed: false,
        packageName: '',
        status: 'rejected_unsupported',
        diagnostic: 'Empty or non-string module specifier'
      };
    }

    const trimmed = specifier.trim();

    // 1. Detect server-only or Node built-in module
    if (this.isForbiddenServerModule(trimmed)) {
      return {
        allowed: false,
        packageName: trimmed,
        status: 'rejected_server',
        diagnostic: `Server-side Node.js module "${trimmed}" cannot run in browser preview.`
      };
    }

    const basePkg = this.extractBasePackage(trimmed);

    // Look up in registry or custom allowlist
    const regConfig =
      BROWSER_PACKAGE_REGISTRY[trimmed] ||
      BROWSER_PACKAGE_REGISTRY[basePkg] ||
      this.customAllowedPackages.get(trimmed) ||
      this.customAllowedPackages.get(basePkg);

    if (!regConfig) {
      return {
        allowed: false,
        packageName: basePkg,
        status: 'rejected_unsupported',
        diagnostic: `Unsupported browser dependency: "${trimmed}". Package is not in browser allowlist.`
      };
    }

    // 2. Exact package match
    if (trimmed === basePkg || trimmed === 'react-dom/client' || trimmed === 'react/jsx-runtime') {
      const ver = regConfig.version ? `@${regConfig.version}` : '';
      const esmUrl = regConfig.url || `https://esm.sh/${trimmed}${ver}?dev`;
      return {
        allowed: true,
        packageName: basePkg,
        esmUrl,
        status: 'allowed'
      };
    }

    // 3. Subpath import
    const subpath = trimmed.slice(basePkg.length + 1);

    // Check allowSubpaths enforcement
    if (regConfig.allowSubpaths === false) {
      return {
        allowed: false,
        packageName: basePkg,
        subpath,
        status: 'rejected_subpath',
        diagnostic: `Subpaths are not permitted for package "${basePkg}" (attempted "${trimmed}").`
      };
    }

    // Build consistent versioned ESM url
    const ver = regConfig.version ? `@${regConfig.version}` : '';
    const esmUrl = `https://esm.sh/${basePkg}${ver}/${subpath}?dev`;

    return {
      allowed: true,
      packageName: basePkg,
      subpath,
      esmUrl,
      status: 'allowed'
    };
  }

  /**
   * Scans source code for all static imports, dynamic imports, re-exports, and require calls.
   */
  static parseCodeImports(code: string, sourceFile: string = ''): ScannedImport[] {
    const results: ScannedImport[] = [];
    if (!code) return results;

    // Regular expressions for static, re-export, dynamic import, and require
    const staticImportRegex = /(?:^|[;\n])\s*import\s*(?:(?:[\w*\s{},]*)\s*from\s*)?['"]([^'"\n\r]+)['"]/g;
    const reExportRegex = /(?:^|[;\n])\s*export\s*(?:(?:[\w*\s{},]*)\s*from\s*)['"]([^'"\n\r]+)['"]/g;
    const dynamicImportRegex = /\bimport\s*\(\s*['"]([^'"\n\r]+)['"]\s*\)/g;
    const requireRegex = /\brequire\s*\(\s*['"]([^'"\n\r]+)['"]\s*\)/g;

    const testAndCollect = (regex: RegExp, type: ScannedImport['type']) => {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(code)) !== null) {
        const specifier = match[1]?.trim();
        if (specifier) {
          // Skip relative and internal absolute file paths
          if (specifier.startsWith('.') || specifier.startsWith('/')) {
            continue;
          }

          const resolution = this.resolveSpecifier(specifier);
          results.push({
            specifier,
            sourceFile,
            type,
            status: resolution.status,
            resolvedUrl: resolution.esmUrl,
            diagnostic: resolution.diagnostic
          });
        }
      }
    };

    testAndCollect(staticImportRegex, 'static_import');
    testAndCollect(reExportRegex, 're_export');
    testAndCollect(dynamicImportRegex, 'dynamic_import');
    testAndCollect(requireRegex, 'require');

    return results;
  }

  /**
   * Comprehensive dependency resolution across all project files.
   * Produces an accurate import map and returns explicit diagnostics for rejected imports.
   */
  static resolveProjectDependencies(files: ProjectFile[]): DependencyResolutionResult {
    const allScannedImports: ScannedImport[] = [];
    const unsupportedDependencies: string[] = [];
    const diagnostics: string[] = [];

    // Core base import map entries with exact consistent pinned versions
    const importMap: Record<string, string> = {
      'react': BROWSER_PACKAGE_REGISTRY['react'].url!,
      'react-dom': BROWSER_PACKAGE_REGISTRY['react-dom'].url!,
      'react-dom/client': BROWSER_PACKAGE_REGISTRY['react-dom/client'].url!,
      'react/jsx-runtime': BROWSER_PACKAGE_REGISTRY['react/jsx-runtime'].url!,
      'lucide-react': BROWSER_PACKAGE_REGISTRY['lucide-react'].url!,
      'motion': BROWSER_PACKAGE_REGISTRY['motion'].url!,
      'framer-motion': BROWSER_PACKAGE_REGISTRY['framer-motion'].url!
    };

    const externalList = new Set<string>([
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'lucide-react',
      'motion',
      'framer-motion'
    ]);

    for (const file of files) {
      if (!file.path.endsWith('.ts') && !file.path.endsWith('.tsx') && !file.path.endsWith('.js') && !file.path.endsWith('.jsx')) {
        continue;
      }

      const scanned = this.parseCodeImports(file.content, file.path);
      for (const item of scanned) {
        allScannedImports.push(item);

        if (item.status === 'allowed' && item.resolvedUrl) {
          importMap[item.specifier] = item.resolvedUrl;
          externalList.add(item.specifier);

          const basePkg = this.extractBasePackage(item.specifier);
          externalList.add(basePkg);
          if (!importMap[basePkg]) {
            const baseRes = this.resolveSpecifier(basePkg);
            if (baseRes.allowed && baseRes.esmUrl) {
              importMap[basePkg] = baseRes.esmUrl;
            }
          }
        } else {
          const diag = item.diagnostic || `Unsupported dependency "${item.specifier}" in ${file.path}`;
          if (!unsupportedDependencies.includes(diag)) {
            unsupportedDependencies.push(diag);
            diagnostics.push(`${file.path}: ${diag}`);
          }
        }
      }
    }

    return {
      valid: unsupportedDependencies.length === 0,
      importMap,
      externalList: Array.from(externalList),
      unsupportedDependencies,
      diagnostics,
      scannedImports: allScannedImports
    };
  }
}

// Backward-compatible helper functions
export function isForbiddenServerModule(moduleName: string): boolean {
  return DependencyResolverService.isForbiddenServerModule(moduleName);
}

export function getEffectivePackageVersion(packageName: string): string | undefined {
  return DependencyResolverService.getEffectivePackageVersion(packageName);
}

export function resolveAllowedDependency(specifier: string): { packageName: string; subpath?: string; esmUrl: string } | null {
  const res = DependencyResolverService.resolveSpecifier(specifier);
  if (!res.allowed || !res.esmUrl) return null;
  return {
    packageName: res.packageName,
    subpath: res.subpath,
    esmUrl: res.esmUrl
  };
}
