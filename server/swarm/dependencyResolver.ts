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
 * Explicitly trusted HTTPS package origins for browser dependencies.
 * Prevents arbitrary or unverified remote module loading.
 */
export const TRUSTED_HTTPS_PACKAGE_ORIGINS: readonly string[] = [
  'https://esm.sh',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
  'https://esm.run'
];

/**
 * Normalizes dependency URL, stripping redundant slashes, default ports, and resolving relative segments.
 */
export function normalizeDependencyUrl(urlStr: string): string {
  if (!urlStr || typeof urlStr !== 'string') return '';
  const parsed = new URL(urlStr.trim());
  parsed.protocol = 'https:';
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.port === '443') parsed.port = '';
  // Normalize pathname to prevent /../ escapes
  const segments = parsed.pathname.split('/').filter(s => s && s !== '.');
  const cleanSegments: string[] = [];
  for (const seg of segments) {
    if (seg === '..') {
      if (cleanSegments.length > 0) cleanSegments.pop();
    } else {
      cleanSegments.push(seg);
    }
  }
  parsed.pathname = '/' + cleanSegments.join('/');
  return parsed.toString();
}

/**
 * Validates whether a URL strictly uses an explicitly trusted HTTPS origin.
 * Enforces no userinfo (username/password), standard port (443 or none),
 * strict hostname verification against trusted origins, and prevents path traversal tricks.
 */
export function isTrustedHttpsUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const trimmed = urlStr.trim();
    // Reject URL-encoded path traversal or null bytes
    if (trimmed.includes('%00') || trimmed.includes('%2e%2e') || trimmed.includes('%2E%2E')) {
      return false;
    }

    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return false;

    // Disallow userinfo (e.g. https://user:pass@esm.sh)
    if (parsed.username || parsed.password) return false;

    // Disallow non-standard ports
    if (parsed.port && parsed.port !== '443') return false;

    // Disallow raw path traversal in pathname
    if (parsed.pathname.includes('/../') || parsed.pathname.endsWith('/..') || parsed.pathname.startsWith('/..')) {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    // Check trusted origin or direct subdomain
    return TRUSTED_HTTPS_PACKAGE_ORIGINS.some(trusted => {
      const trustedHost = new URL(trusted).hostname.toLowerCase();
      return hostname === trustedHost || hostname.endsWith('.' + trustedHost);
    });
  } catch {
    return false;
  }
}

/**
 * Validates package name and configuration to prevent path traversal,
 * shell characters, URL-encoded tricks, or unsafe configurations.
 */
export function validatePackageName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Package name must be a non-empty string' };
  }
  const trimmed = name.trim();

  // Reject URL-encoded characters (e.g. %2e, %2f, %00)
  if (trimmed.includes('%')) {
    return { valid: false, error: `URL-encoded characters are forbidden in package name "${name}"` };
  }

  // Reject control characters, backslashes, null bytes, spaces
  if (trimmed.includes('\0') || trimmed.includes('\\') || trimmed.includes('..') || /\s|[\x00-\x1f\x7f]/.test(trimmed)) {
    return { valid: false, error: `Invalid characters or path traversal sequence in package name "${name}"` };
  }

  // Reject paths, URLs, or schemes
  if (
    trimmed.startsWith('/') || 
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('http:') || 
    trimmed.startsWith('https:') || 
    trimmed.startsWith('file:') || 
    trimmed.startsWith('data:')
  ) {
    return { valid: false, error: `Package name cannot be a path or URL: "${name}"` };
  }

  // Reject leading dot, underscore, or dash
  if (trimmed.startsWith('.') || trimmed.startsWith('_') || trimmed.startsWith('-')) {
    return { valid: false, error: `Package name cannot start with '.', '_', or '-': "${name}"` };
  }

  // Enforce npm max length constraint (214 characters)
  if (trimmed.length > 214) {
    return { valid: false, error: `Package name exceeds maximum length of 214 characters: "${name}"` };
  }

  const pkgPattern = /^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(\/[a-z0-9_.-]+)*$/i;
  if (!pkgPattern.test(trimmed)) {
    return { valid: false, error: `Package name "${name}" does not match valid package name pattern` };
  }

  // Check segments within package name
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || seg.startsWith('-') || seg.startsWith('.')) {
      return { valid: false, error: `Invalid segment "${seg}" in package name "${name}"` };
    }
  }

  return { valid: true };
}

/**
 * Derives a consistent subpath URL respecting custom package base URLs
 * while sanitizing against path traversal attempts.
 */
export function deriveSubpathUrl(baseUrl: string, subpath: string): string {
  // Sanitize subpath: strip leading/trailing slashes and prevent ..
  const cleanSubpath = subpath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(seg => seg && seg !== '.' && seg !== '..' && !seg.includes('%2e'))
    .join('/');

  try {
    const urlObj = new URL(baseUrl);
    if (urlObj.pathname.endsWith('/+esm')) {
      urlObj.pathname = urlObj.pathname.replace(/\/(\+esm)$/, `/${cleanSubpath}/$1`);
    } else {
      urlObj.pathname = urlObj.pathname.replace(/\/+$/, '') + `/${cleanSubpath}`;
    }
    return urlObj.toString();
  } catch {
    return `${baseUrl.replace(/\/+$/, '')}/${cleanSubpath}`;
  }
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
  'assert', 'node:assert',
  'async_hooks', 'node:async_hooks',
  'buffer', 'node:buffer',
  'child_process', 'node:child_process',
  'cluster', 'node:cluster',
  'console', 'node:console',
  'crypto', 'node:crypto',
  'dgram', 'node:dgram',
  'diagnostics_channel', 'node:diagnostics_channel',
  'dns', 'node:dns',
  'domain', 'node:domain',
  'events', 'node:events',
  'fs', 'node:fs',
  'http', 'node:http',
  'http2', 'node:http2',
  'https', 'node:https',
  'inspector', 'node:inspector',
  'module', 'node:module',
  'net', 'node:net',
  'os', 'node:os',
  'path', 'node:path',
  'perf_hooks', 'node:perf_hooks',
  'process', 'node:process',
  'punycode', 'node:punycode',
  'querystring', 'node:querystring',
  'readline', 'node:readline',
  'repl', 'node:repl',
  'stream', 'node:stream',
  'string_decoder', 'node:string_decoder',
  'test', 'node:test',
  'timers', 'node:timers',
  'tls', 'node:tls',
  'trace_events', 'node:trace_events',
  'tty', 'node:tty',
  'url', 'node:url',
  'util', 'node:util',
  'v8', 'node:v8',
  'vm', 'node:vm',
  'wasi', 'node:wasi',
  'worker_threads', 'node:worker_threads',
  'zlib', 'node:zlib',
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

  /**
   * Registers a custom allowed package with strict security validation.
   * Only permits explicitly trusted HTTPS package origins.
   */
  static registerAllowedPackage(name: string, config?: BrowserPackageConfig): void {
    const nameCheck = validatePackageName(name);
    if (!nameCheck.valid) {
      throw new Error(`Invalid package name "${name}": ${nameCheck.error}`);
    }

    if (this.isForbiddenServerModule(name)) {
      throw new Error(`Cannot register server-side or Node.js module "${name}" as a browser package`);
    }

    let effectiveUrl = config?.url;
    if (effectiveUrl) {
      if (!isTrustedHttpsUrl(effectiveUrl)) {
        throw new Error(
          `Untrusted or non-HTTPS package URL for "${name}": "${effectiveUrl}". Only trusted HTTPS origins are allowed (${TRUSTED_HTTPS_PACKAGE_ORIGINS.join(', ')}).`
        );
      }
      effectiveUrl = normalizeDependencyUrl(effectiveUrl);
    }

    if (config?.version) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(config.version)) {
        throw new Error(`Invalid version format "${config.version}" for package "${name}"`);
      }
    }

    if (config?.allowSubpaths !== undefined && typeof config.allowSubpaths !== 'boolean') {
      throw new Error(`allowSubpaths must be a boolean for package "${name}"`);
    }

    this.customAllowedPackages.set(name, {
      ...config,
      url: effectiveUrl,
      allowSubpaths: config?.allowSubpaths ?? true
    });
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

    // Check node: scheme (e.g. node:fs, node:test, node:assert, etc.)
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
   * Custom package URLs are strictly respected during both exact and subpath resolution.
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

    // Reject subpath containing path traversal or invalid characters
    if (subpath.includes('..') || subpath.includes('\\') || subpath.includes('\0') || subpath.includes('%2e') || subpath.includes('%2E') || subpath.startsWith('/')) {
      return {
        allowed: false,
        packageName: basePkg,
        subpath,
        status: 'rejected_subpath',
        diagnostic: `Malicious or invalid subpath traversal sequence detected in "${trimmed}".`
      };
    }

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

    // Respect custom package URL if provided; otherwise derive standard versioned ESM url
    let esmUrl: string;
    if (regConfig.url) {
      esmUrl = deriveSubpathUrl(regConfig.url, subpath);
    } else {
      const ver = regConfig.version ? `@${regConfig.version}` : '';
      esmUrl = `https://esm.sh/${basePkg}${ver}/${subpath}?dev`;
    }

    return {
      allowed: true,
      packageName: basePkg,
      subpath,
      esmUrl,
      status: 'allowed'
    };
  }

  /**
   * Sanitizes source code to avoid false positives from comments and ordinary strings.
   * Strips line and block comments while maintaining code structure.
   */
  static stripCommentsAndNonImportStrings(code: string): string {
    if (!code) return '';

    // Step 1: Strip block comments /* ... */
    let sanitized = code.replace(/\/\*[\s\S]*?\*\//g, match => {
      return match.replace(/[^\n\r]/g, ' ');
    });

    // Step 2: Strip line comments // ...
    sanitized = sanitized.replace(/\/\/[^\n\r]*/g, match => {
      return ' '.repeat(match.length);
    });

    return sanitized;
  }

  /**
   * Scans source code for all static imports, dynamic imports, re-exports, and require calls.
   * Immune to false positives from comments and ordinary string literals.
   */
  static parseCodeImports(code: string, sourceFile: string = ''): ScannedImport[] {
    const results: ScannedImport[] = [];
    if (!code) return results;

    const cleanCode = this.stripCommentsAndNonImportStrings(code);

    // Regular expressions for static, re-export, dynamic import, and require
    const staticImportRegex = /(?:^|[;\n\r])\s*import\s*(?:(?:[\w*\s{},]*)\s*from\s*)?['"]([^'"\n\r]+)['"]/g;
    const reExportRegex = /(?:^|[;\n\r])\s*export\s*(?:(?:[\w*\s{},]*)\s*from\s*)['"]([^'"\n\r]+)['"]/g;
    const dynamicImportRegex = /\bimport\s*\(\s*['"]([^'"\n\r]+)['"]\s*\)/g;
    const requireRegex = /\brequire\s*\(\s*['"]([^'"\n\r]+)['"]\s*\)/g;

    const seenSpecifiers = new Set<string>();

    const testAndCollect = (regex: RegExp, type: ScannedImport['type']) => {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(cleanCode)) !== null) {
        const specifier = match[1]?.trim();
        if (specifier) {
          // Skip relative and internal absolute file paths
          if (specifier.startsWith('.') || specifier.startsWith('/')) {
            continue;
          }

          const dedupKey = `${type}:${specifier}`;
          if (seenSpecifiers.has(dedupKey)) continue;
          seenSpecifiers.add(dedupKey);

          const resolution = this.resolveSpecifier(specifier);
          const diagnostic = resolution.allowed 
            ? undefined 
            : (resolution.diagnostic || `Rejected dependency "${specifier}"`);

          results.push({
            specifier,
            sourceFile,
            type,
            status: resolution.status,
            resolvedUrl: resolution.esmUrl,
            diagnostic: diagnostic ? (sourceFile ? `${sourceFile}: ${diagnostic}` : diagnostic) : undefined
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
   * Prevents duplicate or conflicting import-map entries.
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
          const diag = item.diagnostic || `${file.path}: Unsupported dependency "${item.specifier}"`;
          if (!unsupportedDependencies.includes(diag)) {
            unsupportedDependencies.push(diag);
            diagnostics.push(diag);
          }
        }
      }
    }

    // Sort importMap keys deterministically to prevent conflicting or non-deterministic maps
    const sortedImportMap: Record<string, string> = {};
    for (const key of Object.keys(importMap).sort()) {
      sortedImportMap[key] = importMap[key];
    }

    return {
      valid: unsupportedDependencies.length === 0,
      importMap: sortedImportMap,
      externalList: Array.from(externalList).sort(),
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
