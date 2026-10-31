import { ProjectFile } from '../types.js';
import { db } from '../store.js';
import { TaskManager } from './taskManager.js';
import { ProjectMemoryService } from './projectMemory.js';
import { DependencyResolverService } from './dependencyResolver.js';

export interface IntegrationIssue {
  type: 
    | 'missing_imported_file' 
    | 'unexported_identifier' 
    | 'missing_env_doc' 
    | 'api_route_mismatch'
    | 'conflicting_files'
    | 'architectural_conflict'
    | 'missing_dependency'
    | 'incomplete_implementation';
  sourceFile: string;
  targetFile?: string;
  identifier?: string;
  message: string;
  severity: 'error' | 'warning';
  evidence?: string;
}

export interface IntegrationAnalysisReport {
  passed: boolean;
  totalImportsAnalyzed: number;
  validImportsCount: number;
  issues: IntegrationIssue[];
  environmentVarsUsed: string[];
  undocumentedEnvVars: string[];
  evaluatedAt: number;
}

export class IntegrationAgent {
  /**
   * Analyzes cross-module contracts, relative imports, missing files, external dependencies,
   * architectural decisions, and incomplete implementations.
   */
  static analyzeProjectContracts(buildIdOrFiles: string | ProjectFile[]): IntegrationAnalysisReport {
    const files = typeof buildIdOrFiles === 'string' ? db.getAllFiles(buildIdOrFiles) : buildIdOrFiles;
    const buildId = typeof buildIdOrFiles === 'string' ? buildIdOrFiles : undefined;
    const issues: IntegrationIssue[] = [];
    const envVarsUsed = new Set<string>();

    const filesByCleanPath = new Map<string, ProjectFile>();
    for (const f of files) {
      const clean = f.path.replace(/^\/+/, '');
      filesByCleanPath.set(clean, f);
      // Also index with and without common extensions
      filesByCleanPath.set(clean.replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/, ''), f);
    }

    let totalImports = 0;
    let validImports = 0;

    for (const file of files) {
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(file.path)) continue;

      const content = file.content;
      const fileDir = file.path.includes('/') 
        ? file.path.substring(0, file.path.lastIndexOf('/')) 
        : '';

      // 1. Scan for environment variables
      const envMatches = content.match(/process\.env\.([A-Z0-9_]+)/g);
      if (envMatches) {
        for (const m of envMatches) {
          const varName = m.replace('process.env.', '');
          envVarsUsed.add(varName);
        }
      }

      // 2. Scan external browser module dependencies
      const scannedImports = DependencyResolverService.parseCodeImports(content, file.path);
      for (const imp of scannedImports) {
        if (imp.status !== 'allowed') {
          issues.push({
            type: 'missing_dependency',
            sourceFile: file.path,
            identifier: imp.specifier,
            message: imp.diagnostic || `File "${file.path}" requires unsupported or unresolvable dependency "${imp.specifier}".`,
            severity: 'error',
            evidence: `Import statement: ${imp.type} "${imp.specifier}"`
          });
        }
      }

      // 3. Scan ES relative imports: import ... from './...'
      const importRegex = /(?:import\s+(?:(?:{[^}]+})|(?:[\w\s,*]+))\s+from\s+['"]([^'"]+)['"])|(?:import\s+['"]([^'"]+)['"])/g;
      let match;

      while ((match = importRegex.exec(content)) !== null) {
        const importSpecifier = match[1] || match[2];
        if (!importSpecifier) continue;

        // Only analyze relative imports
        if (!importSpecifier.startsWith('.')) continue;

        totalImports++;

        // Resolve path relative to current file directory
        const resolvedPath = this.resolveRelativePath(fileDir, importSpecifier);
        
        // Check if resolved file exists
        const exists = this.findMatchingFile(resolvedPath, filesByCleanPath);

        if (!exists) {
          issues.push({
            type: 'missing_imported_file',
            sourceFile: file.path,
            targetFile: resolvedPath,
            message: `File "${file.path}" imports from "${importSpecifier}", but target file "${resolvedPath}" does not exist in the project.`,
            severity: 'error'
          });
        } else {
          validImports++;

          // Check named exports if explicit named imports are used: import { A, B } from './...'
          const namedImportMatch = match[0].match(/import\s+{([^}]+)}\s+from/);
          if (namedImportMatch && namedImportMatch[1]) {
            const importedNames = namedImportMatch[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
            const targetContent = exists.content;

            for (const name of importedNames) {
              if (name === 'type' || !name) continue;
              // Check if target file exports this name
              const exportRegex = new RegExp(`export\\s+(?:const|let|var|function|class|interface|type|enum)\\s+${name}\\b|export\\s*{[^}]*\\b${name}\\b[^}]*}`, 'm');
              if (!exportRegex.test(targetContent) && !targetContent.includes(`export default ${name}`)) {
                issues.push({
                  type: 'unexported_identifier',
                  sourceFile: file.path,
                  targetFile: exists.path,
                  identifier: name,
                  message: `Identifier "${name}" is imported in "${file.path}" but not exported by "${exists.path}".`,
                  severity: 'error'
                });
              }
            }
          }
        }
      }

      // 4. Incomplete implementation or decorative placeholder stub detection
      if (file.path.endsWith('.tsx') || file.path.endsWith('.ts')) {
        const trimmed = content.trim();
        if (
          trimmed.length > 0 && 
          trimmed.length < 35 && 
          !file.path.includes('.d.ts')
        ) {
          issues.push({
            type: 'incomplete_implementation',
            sourceFile: file.path,
            message: `File "${file.path}" contains an undersized implementation (${trimmed.length} characters) that may be incomplete.`,
            severity: 'warning'
          });
        }
      }
    }

    // 5. Check environment documentation in .env.example
    const envExampleFile = files.find(f => f.path === '.env.example');
    const envExampleContent = envExampleFile ? envExampleFile.content : '';
    const undocumentedEnvVars: string[] = [];

    for (const v of envVarsUsed) {
      if (v === 'NODE_ENV' || v === 'PORT') continue;
      if (!envExampleContent.includes(v)) {
        undocumentedEnvVars.push(v);
        issues.push({
          type: 'missing_env_doc',
          sourceFile: '.env.example',
          identifier: v,
          message: `Environment variable "${v}" is referenced in source code but missing from .env.example template.`,
          severity: 'warning'
        });
      }
    }

    // 6. Check for architectural conflicts in ProjectMemory if buildId is available
    if (buildId) {
      try {
        const build = db.getBuild(buildId);
        if (build?.userId) {
          const decisions = ProjectMemoryService.getDecisions(buildId, build.userId);
          const accepted = decisions.filter(d => d.status === 'accepted');
          const titleMap = new Map<string, string>();
          for (const d of accepted) {
            const key = d.title.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (titleMap.has(key)) {
              issues.push({
                type: 'architectural_conflict',
                sourceFile: 'ProjectMemory',
                identifier: d.id,
                message: `Architectural disagreement or duplicate decision: "${d.title}" conflicts with previously accepted decision "${titleMap.get(key)}".`,
                severity: 'warning',
                evidence: d.decision
              });
            } else {
              titleMap.set(key, d.title);
            }
          }
        }
      } catch {
        // Fallback gracefully
      }
    }

    const hasErrors = issues.some(i => i.severity === 'error');

    // If critical integration defects exist, automatically spawn integration fix tasks
    if (hasErrors && buildId) {
      this.spawnIntegrationFixTasks(buildId, issues);
    }

    return {
      passed: !hasErrors,
      totalImportsAnalyzed: totalImports,
      validImportsCount: validImports,
      issues,
      environmentVarsUsed: Array.from(envVarsUsed),
      undocumentedEnvVars,
      evaluatedAt: Date.now()
    };
  }

  private static resolveRelativePath(fileDir: string, specifier: string): string {
    const parts = (fileDir ? fileDir.split('/') : []).concat(specifier.split('/'));
    const stack: string[] = [];

    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(part);
      }
    }

    return stack.join('/');
  }

  private static findMatchingFile(resolvedPath: string, filesMap: Map<string, ProjectFile>): ProjectFile | undefined {
    // 1. Direct match
    if (filesMap.has(resolvedPath)) return filesMap.get(resolvedPath);

    // 2. Strip extension
    const base = resolvedPath.replace(/\.(js|mjs|cjs|ts|tsx|jsx)$/, '');
    if (filesMap.has(base)) return filesMap.get(base);

    // 3. Try extensions
    const candidates = [
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.jsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`
    ];

    for (const c of candidates) {
      if (filesMap.has(c)) return filesMap.get(c);
    }

    return undefined;
  }

  static spawnIntegrationFixTasks(buildId: string, issues: IntegrationIssue[]): void {
    const errorIssues = issues.filter(i => i.severity === 'error');
    const existingTasks = db.getTasks(buildId);
    const build = db.getBuild(buildId);

    for (const issue of errorIssues.slice(0, 3)) {
      const taskTitle = `[Integration Fix] Resolve broken contract: ${issue.identifier || issue.targetFile || issue.sourceFile}`;
      // Prevent duplicate fix tasks
      if (existingTasks.some(t => t.title === taskTitle && t.status !== 'failed')) {
        continue;
      }

      // Check bounded repair limits in ProjectMemoryService
      if (build) {
        const defectId = ProjectMemoryService.recordDefect(buildId, build.userId, {
          description: issue.message,
          filePaths: [issue.sourceFile, issue.targetFile || ''].filter(Boolean),
          severity: 'high'
        });

        if (defectId) {
          const memory = ProjectMemoryService.getOrInitializeMemory(buildId, build.userId);
          const defect = memory?.knownDefects.find(d => d.id === defectId);
          if (defect && (defect.repairAttempts || 0) >= 3) {
            // Reached maximum bounded self-repair attempts (3 max) to avoid endless loops
            continue;
          }
          ProjectMemoryService.recordRepairAttempt(buildId, build.userId, defectId, `Spawned integration fix task for ${issue.type}`);
        }
      }

      TaskManager.createNewTask(buildId, {
        title: taskTitle,
        description: `${issue.message}\nAcceptance Criteria: Ensure "${issue.sourceFile}" imports and contracts resolve without errors.`,
        filePaths: [issue.sourceFile, issue.targetFile || ''].filter(Boolean),
        priority: 1, // High priority
        assignedRole: 'integration_specialist',
        isFixTask: true,
        maxRetries: 3
      });
    }
  }
}
