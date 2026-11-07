/**
 * SquadForge Path Validation & Workspace Scoping Security Utility
 *
 * Sanitizes file paths and build artifacts using `path.relative()` to strictly prevent:
 * - Directory traversal attacks (`../`, `..\\`, `foo/../../bar`)
 * - Absolute path injection (POSIX `/etc/...`, Windows `C:\...`)
 * - UNC network share paths (`//server/share`, `\\\\server\\share`)
 * - Null byte injection (`\0`)
 * - Symbolic link escapes out of workspace boundaries
 * - Unscoped build artifact placement or downloads
 */

import path from 'node:path';
import fs from 'node:fs';

export interface PathValidationResult {
  valid: boolean;
  cleanRelativePath: string;
  absolutePath: string;
  error?: string;
}

export interface ArtifactScopeResult {
  valid: boolean;
  resolvedPath?: string;
  relativePath?: string;
  filename?: string;
  error?: string;
}

export interface PathSanitizeOptions {
  checkSymlinks?: boolean;
  allowEmpty?: boolean;
  allowedExtensions?: string[];
}

/**
 * Validates whether a candidate path is safely scoped strictly within a base directory
 * using `path.relative()`.
 * Rejects null bytes, Windows drive paths, UNC paths, and traversal escapes.
 */
export function isPathScopedWithin(baseDir: string, candidatePath: string): boolean {
  if (!baseDir || !candidatePath) return false;
  if (typeof baseDir !== 'string' || typeof candidatePath !== 'string') return false;
  if (candidatePath.includes('\0')) return false;

  const trimmed = candidatePath.trim();
  if (!trimmed) return false;

  // Reject Windows drive paths (e.g. C:, C:/, C:\, d:\...)
  if (/^[a-zA-Z]:/i.test(trimmed)) {
    return false;
  }

  // Reject UNC network paths (e.g. //server/share or \\server\share)
  if (trimmed.startsWith('//') || trimmed.startsWith('\\\\')) {
    return false;
  }

  const absBase = path.resolve(baseDir);
  const absCandidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(absBase, trimmed);

  const rel = path.relative(absBase, absCandidate);
  if (
    !rel ||
    rel === '.' ||
    rel === '..' ||
    rel.startsWith('..') ||
    rel.startsWith('..' + path.sep) ||
    rel.startsWith('../') ||
    rel.startsWith('..\\') ||
    path.isAbsolute(rel)
  ) {
    return false;
  }

  return true;
}

/**
 * Sanitizes a workspace-relative file path against a given workspace root directory.
 * Uses `path.relative()` to verify that the normalized target does not escape the workspace.
 * Strictly rejects absolute paths, Windows drive letters, UNC shares, null bytes, and escaping symlinks.
 */
export function sanitizeWorkspacePath(
  workspaceRoot: string,
  rawPath: string,
  options: PathSanitizeOptions = { checkSymlinks: true }
): PathValidationResult {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    return {
      valid: false,
      cleanRelativePath: '',
      absolutePath: '',
      error: 'Workspace root directory must be a non-empty string'
    };
  }

  if (!rawPath || typeof rawPath !== 'string') {
    return {
      valid: false,
      cleanRelativePath: '',
      absolutePath: '',
      error: 'File path cannot be empty'
    };
  }

  const trimmed = rawPath.trim();
  if (!trimmed) {
    return {
      valid: false,
      cleanRelativePath: '',
      absolutePath: '',
      error: 'File path cannot be empty'
    };
  }

  // 1. Reject null byte injection
  if (trimmed.includes('\0')) {
    return {
      valid: false,
      cleanRelativePath: '',
      absolutePath: '',
      error: `Null bytes forbidden in path: ${trimmed}`
    };
  }

  // 2. Reject UNC network paths (e.g. //server/share or \\server\share)
  if (trimmed.startsWith('//') || trimmed.startsWith('\\\\')) {
    return {
      valid: false,
      cleanRelativePath: '',
      absolutePath: '',
      error: `UNC network paths forbidden in workspace: ${trimmed}`
    };
  }

  // 3. Reject absolute Unix paths
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    return {
      valid: false,
      cleanRelativePath: '',
      absolutePath: '',
      error: `Absolute paths forbidden in workspace: ${trimmed}`
    };
  }

  // 4. Reject Windows drive paths (e.g. C:, C:/, C:\, d:\...)
  if (/^[a-zA-Z]:/i.test(trimmed)) {
    return {
      valid: false,
      cleanRelativePath: '',
      absolutePath: '',
      error: `Windows drive letters forbidden in workspace: ${trimmed}`
    };
  }


  // Disallow explicit traversal segments in path
  const normalizedSlashes = trimmed.replace(/\\/g, '/');
  const segments = normalizedSlashes.split('/');
  if (segments.some(seg => seg === '..')) {
    return {
      valid: false,
      cleanRelativePath: '',
      absolutePath: '',
      error: `Path traversal escapes workspace: ${trimmed}`
    };
  }

  // Normalize workspace root and target with normalized slashes
  const absRoot = path.resolve(workspaceRoot);
  const normalizedTarget = path.posix.normalize(normalizedSlashes);
  const resolvedTarget = path.resolve(absRoot, normalizedTarget);

  // 5. Use path.relative() to verify target does not escape the assigned workspace
  const relFromRoot = path.relative(absRoot, resolvedTarget);

  if (
    !relFromRoot ||
    relFromRoot === '.' ||
    relFromRoot === '..' ||
    relFromRoot.startsWith('..') ||
    relFromRoot.startsWith('..' + path.sep) ||
    relFromRoot.startsWith('../') ||
    relFromRoot.startsWith('..\\') ||
    path.isAbsolute(relFromRoot)
  ) {
    return {
      valid: false,
      cleanRelativePath: '',
      absolutePath: '',
      error: `Path traversal escapes workspace: ${trimmed}`
    };
  }

  // 6. Symlink audit (if target or intermediate directory already exists on disk)
  if (options.checkSymlinks) {
    try {
      if (fs.existsSync(resolvedTarget)) {
        const lstat = fs.lstatSync(resolvedTarget);
        if (lstat.isSymbolicLink()) {
          return {
            valid: false,
            cleanRelativePath: '',
            absolutePath: '',
            error: `Symbolic links are forbidden in workspace: ${trimmed}`
          };
        }
        const real = fs.realpathSync(resolvedTarget);
        const realRel = path.relative(absRoot, real);
        if (
          realRel.startsWith('..') ||
          realRel.startsWith('..' + path.sep) ||
          path.isAbsolute(realRel)
        ) {
          return {
            valid: false,
            cleanRelativePath: '',
            absolutePath: '',
            error: `Symlink target escapes workspace: ${trimmed}`
          };
        }
      }

      // Check intermediate parent directories for escaping symlinks
      let cur = path.dirname(resolvedTarget);
      while (cur.length >= absRoot.length && fs.existsSync(cur)) {
        const dirLstat = fs.lstatSync(cur);
        if (dirLstat.isSymbolicLink()) {
          return {
            valid: false,
            cleanRelativePath: '',
            absolutePath: '',
            error: `Parent directory symlink in path is forbidden: ${trimmed}`
          };
        }
        if (cur === absRoot) break;
        cur = path.dirname(cur);
      }
    } catch {
      // Ignore filesystem inspection errors for files not yet materialized
    }
  }

  const cleanRelativePath = relFromRoot.replace(/\\/g, '/');

  return {
    valid: true,
    cleanRelativePath,
    absolutePath: resolvedTarget
  };
}

/**
 * Strict asserting version of `sanitizeWorkspacePath`.
 * Throws a descriptive Security Violation Error if path validation fails,
 * or returns the verified absolute path.
 */
export function assertSafeWorkspacePath(
  workspaceRoot: string,
  targetPath: string,
  options: PathSanitizeOptions = { checkSymlinks: true }
): string {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new Error('Security Violation: Target path cannot be empty');
  }

  const result = sanitizeWorkspacePath(workspaceRoot, targetPath, options);
  if (!result.valid) {
    throw new Error(`Security Violation: ${result.error || 'Invalid workspace path'}`);
  }
  return result.absolutePath;
}

/**
 * Validates that an artifact filename and scope ID (e.g. buildId, deploymentId) are strictly
 * scoped within the assigned artifacts base directory using `path.relative()`.
 * Prevents traversal across projects/builds or out of the artifact directory.
 */
export function validateArtifactScope(
  artifactsBaseDir: string,
  scopeId: string,
  filename: string
): ArtifactScopeResult {
  if (!artifactsBaseDir || typeof artifactsBaseDir !== 'string') {
    return { valid: false, error: 'Artifacts base directory must be non-empty string' };
  }
  if (!scopeId || typeof scopeId !== 'string' || !scopeId.trim()) {
    return { valid: false, error: 'Scope / Build ID cannot be empty' };
  }
  if (!filename || typeof filename !== 'string' || !filename.trim()) {
    return { valid: false, error: 'Artifact filename cannot be empty' };
  }

  // Reject traversal or separator characters in scopeId
  const cleanScopeId = scopeId.trim();
  if (
    cleanScopeId.includes('/') ||
    cleanScopeId.includes('\\') ||
    cleanScopeId.includes('..') ||
    cleanScopeId.includes('\0') ||
    !/^[a-zA-Z0-9_-]+$/.test(cleanScopeId)
  ) {
    return { valid: false, error: `Invalid scope ID format: ${scopeId}` };
  }

  // Reject traversal or path separators in artifact filename
  const cleanFilename = filename.trim();
  if (
    cleanFilename.includes('/') ||
    cleanFilename.includes('\\') ||
    cleanFilename.includes('..') ||
    cleanFilename.includes('\0')
  ) {
    return { valid: false, error: `Invalid artifact filename: directory separators and traversal forbidden: ${filename}` };
  }

  // Verify filename matches safe artifact patterns
  if (!/^[a-zA-Z0-9_.-]+$/.test(cleanFilename)) {
    return { valid: false, error: `Invalid characters in artifact filename: ${filename}` };
  }

  const absBase = path.resolve(artifactsBaseDir);
  const scopedDir = path.resolve(absBase, cleanScopeId);
  const resolvedArtifact = path.resolve(scopedDir, cleanFilename);

  // Check 1: Artifact must be scoped directly within its scopedDir using path.relative()
  const relFromScoped = path.relative(scopedDir, resolvedArtifact);
  if (
    relFromScoped !== cleanFilename ||
    relFromScoped.startsWith('..') ||
    path.isAbsolute(relFromScoped)
  ) {
    return { valid: false, error: `Artifact escapes assigned scope directory: ${filename}` };
  }

  // Check 2: Artifact must be scoped within artifactsBaseDir using path.relative()
  const relFromBase = path.relative(absBase, resolvedArtifact);
  if (
    relFromBase.startsWith('..') ||
    relFromBase.startsWith('..' + path.sep) ||
    path.isAbsolute(relFromBase) ||
    relFromBase === '..'
  ) {
    return { valid: false, error: `Artifact escapes artifacts base directory: ${filename}` };
  }

  return {
    valid: true,
    resolvedPath: resolvedArtifact,
    relativePath: path.join(cleanScopeId, cleanFilename).replace(/\\/g, '/'),
    filename: cleanFilename
  };
}

/**
 * Strict asserting version of `validateArtifactScope`.
 * Throws a Security Violation Error if the artifact is not safely scoped, or returns the verified absolute path.
 */
export function assertScopedArtifactPath(
  artifactsBaseDir: string,
  scopeId: string,
  filename: string
): string {
  const result = validateArtifactScope(artifactsBaseDir, scopeId, filename);
  if (!result.valid || !result.resolvedPath) {
    throw new Error(`Security Violation: ${result.error || 'Artifact path is not scoped correctly within workspace'}`);
  }
  return result.resolvedPath;
}

/**
 * Scopes a build artifact path (either direct filename or nested relative subpath)
 * within an artifacts root directory using `path.relative()`.
 */
export function scopeArtifactPath(
  artifactsBaseDir: string,
  filenameOrRelative: string,
  scopeId?: string
): ArtifactScopeResult {
  if (scopeId) {
    return validateArtifactScope(artifactsBaseDir, scopeId, filenameOrRelative);
  }

  if (!artifactsBaseDir || typeof artifactsBaseDir !== 'string') {
    return { valid: false, error: 'Artifacts base directory must be non-empty string' };
  }
  if (!filenameOrRelative || typeof filenameOrRelative !== 'string' || !filenameOrRelative.trim()) {
    return { valid: false, error: 'Artifact path cannot be empty' };
  }

  const trimmed = filenameOrRelative.trim();
  if (trimmed.includes('\0')) {
    return { valid: false, error: 'Null byte injection detected in artifact path' };
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/i.test(trimmed)) {
    return { valid: false, error: 'Absolute paths are forbidden in artifact scoping' };
  }

  // Check for traversal segments
  const segments = trimmed.replace(/\\/g, '/').split('/');
  if (segments.some(s => s === '..')) {
    return { valid: false, error: `Directory traversal sequence forbidden in artifact path: ${trimmed}` };
  }

  const absBase = path.resolve(artifactsBaseDir);
  const normalized = path.normalize(trimmed);
  const resolved = path.resolve(absBase, normalized);

  const rel = path.relative(absBase, resolved);
  if (
    !rel ||
    rel === '.' ||
    rel === '..' ||
    rel.startsWith('..') ||
    rel.startsWith('..' + path.sep) ||
    rel.startsWith('../') ||
    rel.startsWith('..\\') ||
    path.isAbsolute(rel)
  ) {
    return { valid: false, error: `Artifact escapes base directory: ${trimmed}` };
  }

  return {
    valid: true,
    resolvedPath: resolved,
    relativePath: rel.replace(/\\/g, '/'),
    filename: path.basename(resolved)
  };
}

/**
 * Validates that an artifact filename matches safe naming conventions and allowed extensions.
 */
export function validateArtifactFilename(filename: string, allowedExtensions?: string[]): boolean {
  if (typeof filename !== 'string' || !filename.trim()) return false;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
    return false;
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) return false;

  if (allowedExtensions && allowedExtensions.length > 0) {
    const extRegex = new RegExp(`\\.(${allowedExtensions.join('|')})$`, 'i');
    return extRegex.test(filename);
  }

  // Default allowed build artifact extensions
  return /\.(apk|aab|zip|tar\.gz|tgz|log|json|bin)$/i.test(filename);
}

/**
 * Validates that an identifier (buildId, deploymentId, projectId) is safe from traversal.
 */
export function validateBuildId(id: string): boolean {
  if (typeof id !== 'string' || !id.trim()) return false;
  if (id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0')) return false;
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

/**
 * Backward-compatible helper for sanitizing relative project paths.
 */
export function sanitizeProjectFilePath(filePath: string): string | null {
  if (!filePath || typeof filePath !== 'string') return null;
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.includes('\0')) return null;

  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    /^[a-zA-Z]:/i.test(trimmed) ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('\\\\')
  ) {
    return null;
  }

  const normalized = trimmed.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') return null;
  }

  const cleaned = segments.filter(s => s && s !== '.').join('/');
  if (!cleaned) return null;

  const resolved = path.posix.normalize(cleaned);
  if (resolved.startsWith('..') || resolved.startsWith('/') || resolved === '.') {
    return null;
  }

  return cleaned;
}
