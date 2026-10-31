import ts from 'typescript';
import { ProjectFile } from '../types.js';
import { db } from '../store.js';
import { TaskManager } from './taskManager.js';
import { ProjectMemoryService } from './projectMemory.js';
import { DependencyResolverService } from './dependencyResolver.js';

export type IntegrationIssueType = 
  | 'missing_imported_file' 
  | 'unexported_identifier' 
  | 'invalid_default_import'
  | 'circular_dependency'
  | 'missing_env_doc' 
  | 'api_route_mismatch'
  | 'conflicting_files'
  | 'architectural_conflict'
  | 'missing_dependency'
  | 'incompatible_interface'
  | 'conflicting_file_ownership'
  | 'incomplete_implementation';

export interface IntegrationIssue {
  type: IntegrationIssueType;
  sourceFile: string;
  targetFile?: string;
  identifier?: string;
  message: string;
  severity: 'error' | 'warning';
  evidence?: string;
  suggestedCorrection?: string;
  affectedFiles?: string[];
}

export interface IntegrationAnalysisReport {
  passed: boolean;
  totalImportsAnalyzed: number;
  validImportsCount: number;
  issues: IntegrationIssue[];
  environmentVarsUsed: string[];
  undocumentedEnvVars: string[];
  circularDependencyChains: string[][];
  evaluatedAt: number;
}

interface ParsedFileExports {
  namedExports: Set<string>;
  hasDefaultExport: boolean;
  exportedFunctions: Map<string, { paramCount: number; requiredParamCount: number }>;
  reExports: Array<{ specifier: string; names?: string[]; isAll: boolean }>;
}

export class IntegrationAgent {
  /**
   * Performs TypeScript AST-aware analysis of contracts, relative imports, exports,
   * circular dependencies, interface compatibility, and incomplete implementations.
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
      // Index without extension for flexible resolution
      filesByCleanPath.set(clean.replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/, ''), f);
    }

    // Pass 1: Parse exports for all TypeScript/JavaScript files using TypeScript compiler API
    const exportsMap = new Map<string, ParsedFileExports>();
    const importGraph = new Map<string, Set<string>>();

    for (const file of files) {
      const clean = file.path.replace(/^\/+/, '');
      importGraph.set(clean, new Set());

      if (/\.(ts|tsx|js|jsx|mjs)$/.test(file.path)) {
        try {
          const parsedExports = this.extractExportsWithAST(file.path, file.content);
          exportsMap.set(clean, parsedExports);
        } catch {
          // Fallback gracefully on parsing failure
        }
      }
    }

    let totalImports = 0;
    let validImports = 0;

    // Pass 2: Analyze imports, interfaces, incomplete bodies, and env vars
    for (const file of files) {
      const cleanSourcePath = file.path.replace(/^\/+/, '');
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(file.path)) continue;

      const content = file.content;
      const fileDir = file.path.includes('/') 
        ? file.path.substring(0, file.path.lastIndexOf('/')) 
        : '';

      // 1. Scan environment variables
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
            evidence: `Import statement: ${imp.type} "${imp.specifier}"`,
            suggestedCorrection: `Install or configure package "${imp.specifier}" in browser registry or mock with local implementation.`
          });
        }
      }

      // 3. Syntax-aware AST inspection for relative imports, exports, and function contracts
      try {
        const sourceFile = ts.createSourceFile(
          file.path,
          content,
          ts.ScriptTarget.Latest,
          true,
          file.path.endsWith('.tsx') || file.path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );

        this.walkSourceAST(
          sourceFile,
          file,
          fileDir,
          filesByCleanPath,
          exportsMap,
          importGraph,
          issues,
          () => { totalImports++; },
          () => { validImports++; }
        );
      } catch (err: any) {
        // If AST parser hits unexpected syntax, record diagnostics
        issues.push({
          type: 'incomplete_implementation',
          sourceFile: file.path,
          message: `AST parsing syntax error in "${file.path}": ${err.message || 'Malformed TypeScript syntax'}`,
          severity: 'error',
          suggestedCorrection: 'Fix syntax error so TypeScript compiler can parse the file.'
        });
      }

      // 4. Incomplete implementation or decorative placeholder detection
      this.detectIncompleteImplementations(file, issues);
    }

    // Pass 3: Detect circular dependencies in import graph
    const circularChains = this.detectCircularDependencies(importGraph);
    for (const cycle of circularChains) {
      issues.push({
        type: 'circular_dependency',
        sourceFile: cycle[0],
        targetFile: cycle[cycle.length - 1],
        affectedFiles: cycle,
        message: `Circular dependency detected: ${cycle.join(' -> ')}`,
        severity: 'warning',
        evidence: `Dependency cycle: ${cycle.join(' -> ')}`,
        suggestedCorrection: `Break circular dependency by extracting shared types/interfaces to a leaf file (e.g. types/index.ts).`
      });
    }

    // Pass 4: Check environment documentation in .env.example
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
          severity: 'warning',
          suggestedCorrection: `Add "${v}=" to .env.example with descriptive comment.`
        });
      }
    }

    // Pass 5: Check conflicting file ownership if active leases exist
    for (const f of files) {
      if (f.leaseOwner && f.leaseExpiresAt && f.leaseExpiresAt > Date.now()) {
        const otherClaimants = files.filter(other => other.path === f.path && other.ownerModel && other.ownerModel !== f.leaseOwner);
        if (otherClaimants.length > 0) {
          issues.push({
            type: 'conflicting_file_ownership',
            sourceFile: f.path,
            message: `File "${f.path}" lease held by ${f.leaseOwner} but modified by concurrent model`,
            severity: 'warning',
            suggestedCorrection: `Wait for exclusive lease to expire or synchronize edits through MergeManager.`
          });
        }
      }
    }

    // Pass 6: Check architectural conflicts in ProjectMemory
    if (buildId) {
      try {
        const build = db.getBuild(buildId);
        if (build?.userId) {
          const decisions = ProjectMemoryService.getDecisions(buildId, build.userId);
          const accepted = decisions.filter(d => d.status === 'accepted');
          for (let idx = 0; idx < accepted.length; idx++) {
            const currentADR = accepted[idx];
            const remaining = accepted.slice(idx + 1);
            const conflict = ProjectMemoryService.detectADRConflicts(currentADR, remaining);
            if (conflict.hasConflict && conflict.conflictingADR) {
              issues.push({
                type: 'architectural_conflict',
                sourceFile: 'ProjectMemory',
                identifier: currentADR.id,
                message: `Architectural contradiction: [${currentADR.id}] "${currentADR.title}" contradicts [${conflict.conflictingADR.id}] "${conflict.conflictingADR.title}": ${conflict.reason}`,
                severity: 'warning',
                evidence: conflict.reason,
                suggestedCorrection: `Supersede or reconsider one of the contradictory decisions using ProjectMemoryService.`
              });
            }
          }
        }
      } catch {
        // Fallback gracefully
      }
    }

    const hasErrors = issues.some(i => i.severity === 'error');

    // Spawn bounded self-repair tasks for error issues if buildId is available
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
      circularDependencyChains: circularChains,
      evaluatedAt: Date.now()
    };
  }

  /**
   * Uses TypeScript compiler AST to extract named exports, default exports, and exported function interfaces.
   */
  private static extractExportsWithAST(filePath: string, content: string): ParsedFileExports {
    const namedExports = new Set<string>();
    let hasDefaultExport = false;
    const exportedFunctions = new Map<string, { paramCount: number; requiredParamCount: number }>();
    const reExports: Array<{ specifier: string; names?: string[]; isAll: boolean }> = [];

    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    const visit = (node: ts.Node) => {
      // 1. Export declarations: export { a, b as c } from './foo' or export { a, b }
      if (ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          if (node.exportClause && ts.isNamedExports(node.exportClause)) {
            const names = node.exportClause.elements.map(e => (e.propertyName || e.name).text);
            names.forEach(n => namedExports.add(n));
            reExports.push({ specifier, names, isAll: false });
          } else {
            reExports.push({ specifier, isAll: true });
          }
        } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          node.exportClause.elements.forEach(e => {
            namedExports.add(e.name.text);
          });
        }
      }

      // 2. Export assignment: export default ...
      if (ts.isExportAssignment(node)) {
        hasDefaultExport = true;
      }

      // 3. Declarations with 'export' or 'export default' modifiers
      const hasExportModifier = (modifiers?: ts.NodeArray<ts.ModifierLike>) =>
        Boolean(modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
      const hasDefaultModifier = (modifiers?: ts.NodeArray<ts.ModifierLike>) =>
        Boolean(modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword));

      if (ts.isFunctionDeclaration(node) && node.name) {
        if (hasExportModifier(node.modifiers)) {
          const name = node.name.text;
          namedExports.add(name);
          if (hasDefaultModifier(node.modifiers)) hasDefaultExport = true;

          const paramCount = node.parameters.length;
          const requiredParamCount = node.parameters.filter(p => !p.questionToken && !p.initializer).length;
          exportedFunctions.set(name, { paramCount, requiredParamCount });
        }
      }

      if (ts.isClassDeclaration(node) && node.name && hasExportModifier(node.modifiers)) {
        namedExports.add(node.name.text);
        if (hasDefaultModifier(node.modifiers)) hasDefaultExport = true;
      }

      if (ts.isInterfaceDeclaration(node) && hasExportModifier(node.modifiers)) {
        namedExports.add(node.name.text);
      }

      if (ts.isTypeAliasDeclaration(node) && hasExportModifier(node.modifiers)) {
        namedExports.add(node.name.text);
      }

      if (ts.isEnumDeclaration(node) && hasExportModifier(node.modifiers)) {
        namedExports.add(node.name.text);
      }

      if (ts.isVariableStatement(node) && hasExportModifier(node.modifiers)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            namedExports.add(decl.name.text);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return {
      namedExports,
      hasDefaultExport,
      exportedFunctions,
      reExports
    };
  }

  /**
   * Walks the AST of a single source file to validate relative import targets,
   * named/default bindings, and interface signatures.
   */
  private static walkSourceAST(
    sourceFile: ts.SourceFile,
    file: ProjectFile,
    fileDir: string,
    filesByCleanPath: Map<string, ProjectFile>,
    exportsMap: Map<string, ParsedFileExports>,
    importGraph: Map<string, Set<string>>,
    issues: IntegrationIssue[],
    onImportAnalyzed: () => void,
    onValidImport: () => void
  ): void {
    const cleanSourcePath = file.path.replace(/^\/+/, '');

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const specifierNode = node.moduleSpecifier;
        if (ts.isStringLiteral(specifierNode)) {
          const specifier = specifierNode.text;

          // Only analyze relative imports
          if (specifier.startsWith('.')) {
            onImportAnalyzed();

            const resolvedPath = this.resolveRelativePath(fileDir, specifier);
            const targetFile = this.findMatchingFile(resolvedPath, filesByCleanPath);
            const cleanTarget = resolvedPath.replace(/^\/+/, '');

            if (importGraph.has(cleanSourcePath)) {
              importGraph.get(cleanSourcePath)!.add(cleanTarget.replace(/\.(tsx|ts|jsx|js|mjs)$/, ''));
            }

            if (!targetFile) {
              issues.push({
                type: 'missing_imported_file',
                sourceFile: file.path,
                targetFile: resolvedPath,
                identifier: specifier,
                message: `File "${file.path}" imports from "${specifier}", but target file "${resolvedPath}" does not exist.`,
                severity: 'error',
                evidence: `Import statement: ${node.getText(sourceFile)}`,
                suggestedCorrection: `Create file "${resolvedPath}" or update import path to match existing files.`
              });
            } else {
              onValidImport();

              const cleanTargetKey = targetFile.path.replace(/^\/+/, '');
              const targetExports = exportsMap.get(cleanTargetKey);

              if (targetExports && node.importClause) {
                // 1. Check default import: import Foo from './target'
                if (node.importClause.name && !node.importClause.isTypeOnly) {
                  const defaultName = node.importClause.name.text;
                  if (!targetExports.hasDefaultExport && targetExports.namedExports.size > 0) {
                    issues.push({
                      type: 'invalid_default_import',
                      sourceFile: file.path,
                      targetFile: targetFile.path,
                      identifier: defaultName,
                      message: `Module "${targetFile.path}" has no default export, but is imported with default import "${defaultName}".`,
                      severity: 'error',
                      evidence: `Import: ${node.getText(sourceFile)}`,
                      suggestedCorrection: `Use named import: import { ${Array.from(targetExports.namedExports).slice(0, 3).join(', ')} } from "${specifier}";`
                    });
                  }
                }

                // 2. Check named imports: import { a, b } from './target'
                if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
                  for (const elem of node.importClause.namedBindings.elements) {
                    if (elem.isTypeOnly) continue; // Skip type-only named import
                    const importedIdentifier = (elem.propertyName || elem.name).text;

                    // Verify if target exports this identifier
                    const isExported = 
                      targetExports.namedExports.has(importedIdentifier) ||
                      targetExports.reExports.some(r => r.isAll || r.names?.includes(importedIdentifier));

                    if (!isExported) {
                      issues.push({
                        type: 'unexported_identifier',
                        sourceFile: file.path,
                        targetFile: targetFile.path,
                        identifier: importedIdentifier,
                        message: `Identifier "${importedIdentifier}" is imported in "${file.path}" but not exported by "${targetFile.path}".`,
                        severity: 'error',
                        evidence: `Import clause: ${elem.getText(sourceFile)}`,
                        suggestedCorrection: `Export "${importedIdentifier}" from "${targetFile.path}", or choose from available exports: [${Array.from(targetExports.namedExports).slice(0, 5).join(', ')}].`
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  /**
   * Detects empty or incomplete placeholder implementations (e.g. empty functions, functions with only TODO).
   */
  private static detectIncompleteImplementations(file: ProjectFile, issues: IntegrationIssue[]): void {
    const content = file.content;
    const trimmed = content.trim();

    // Undersized file check
    if (
      (file.path.endsWith('.tsx') || file.path.endsWith('.ts')) &&
      trimmed.length > 0 && 
      trimmed.length < 35 && 
      !file.path.endsWith('.d.ts')
    ) {
      issues.push({
        type: 'incomplete_implementation',
        sourceFile: file.path,
        message: `File "${file.path}" is an undersized stub (${trimmed.length} characters) that lacks complete logic.`,
        severity: 'warning',
        suggestedCorrection: 'Implement complete functional component or service logic.'
      });
      return;
    }

    // Flag functions that explicitly throw 'TODO' or 'not implemented'
    const todoThrowMatch = content.match(/throw\s+new\s+Error\s*\(\s*['"](?:TODO|Not implemented|Stub|Placeholder)[^'"]*['"]\s*\)/i);
    if (todoThrowMatch) {
      issues.push({
        type: 'incomplete_implementation',
        sourceFile: file.path,
        message: `File "${file.path}" contains an unfulfilled stub: ${todoThrowMatch[0]}`,
        severity: 'warning',
        evidence: todoThrowMatch[0],
        suggestedCorrection: 'Replace throw stub with authentic business logic.'
      });
    }
  }

  /**
   * Detects circular dependency cycles in module import graph using Depth-First Search.
   */
  private static detectCircularDependencies(graph: Map<string, Set<string>>): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const pathStack: string[] = [];

    const dfs = (node: string) => {
      visited.add(node);
      recStack.add(node);
      pathStack.push(node);

      const neighbors = graph.get(node) || new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        } else if (recStack.has(neighbor)) {
          // Cycle found
          const cycleStartIndex = pathStack.indexOf(neighbor);
          if (cycleStartIndex >= 0) {
            const cycle = pathStack.slice(cycleStartIndex).concat(neighbor);
            cycles.push(cycle);
          }
        }
      }

      recStack.delete(node);
      pathStack.pop();
    };

    for (const node of graph.keys()) {
      if (!visited.has(node)) {
        dfs(node);
      }
    }

    return cycles;
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

    // 3. Try standard extensions
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

  /**
   * Spawns bounded repair tasks for critical integration defects.
   * Enforces repair limits and avoids duplicate fix tasks.
   */
  static spawnIntegrationFixTasks(buildId: string, issues: IntegrationIssue[]): void {
    const errorIssues = issues.filter(i => i.severity === 'error');
    const existingTasks = db.getTasks(buildId);
    const build = db.getBuild(buildId);

    for (const issue of errorIssues.slice(0, 3)) {
      const taskTitle = `[Integration Fix] Resolve broken contract: ${issue.identifier || issue.targetFile || issue.sourceFile}`;
      
      // Prevent duplicate active fix tasks
      if (existingTasks.some(t => t.title === taskTitle && t.status !== 'failed')) {
        continue;
      }

      // Check executed repair attempts (failed previous fix tasks)
      const failedAttempts = existingTasks.filter(
        t => t.isFixTask && t.status === 'failed' && (t.title === taskTitle || t.filePaths?.includes(issue.sourceFile))
      ).length;

      if (failedAttempts >= 3) {
        continue;
      }

      // Record defect in ProjectMemory and check repair limit eligibility
      if (build && build.userId) {
        const defectId = ProjectMemoryService.recordDefect(buildId, build.userId, {
          description: issue.message,
          filePaths: [issue.sourceFile, issue.targetFile || ''].filter(Boolean),
          severity: 'high',
          expectedCorrection: issue.suggestedCorrection
        });

        if (defectId) {
          const repairCheck = ProjectMemoryService.canAttemptRepair(buildId, build.userId, defectId);
          if (!repairCheck.allowed || (repairCheck.attempts + failedAttempts) >= 3) {
            // Repair limit reached (default 3), stop looping
            continue;
          }

          const newTask = TaskManager.createNewTask(buildId, {
            title: taskTitle,
            description: `${issue.message}\nSuggested Correction: ${issue.suggestedCorrection || 'Resolve broken import contract'}\nAcceptance Criteria: Ensure "${issue.sourceFile}" imports and contracts resolve cleanly without errors.`,
            filePaths: [issue.sourceFile, issue.targetFile || ''].filter(Boolean),
            priority: 1, // High priority
            assignedRole: 'integration_specialist',
            isFixTask: true,
            maxRetries: 3
          });

          // Schedule without incrementing execution attempt counter
          ProjectMemoryService.scheduleRepairTask(buildId, build.userId, defectId, newTask.id);
        }
      }
    }
  }
}
