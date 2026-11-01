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
      const cleanKey = clean.replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/, '');
      importGraph.set(cleanKey, new Set());
      // Also register full clean path for lookup flexibility
      importGraph.set(clean, new Set());

      if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file.path)) {
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

    // Pass 2: Analyze imports, interfaces, incomplete bodies, and env vars via TypeScript AST
    for (const file of files) {
      const cleanSourcePath = file.path.replace(/^\/+/, '');
      if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file.path)) continue;

      const content = file.content;
      const fileDir = file.path.includes('/') 
        ? file.path.substring(0, file.path.lastIndexOf('/')) 
        : '';

      // 1. Scan external browser module dependencies (skip server and test files which legitimately run in Node)
      const isServerOrTestFile = 
        file.path.startsWith('tests/') || 
        file.path.includes('.test.') || 
        file.path.includes('.spec.') || 
        file.path.startsWith('server/') || 
        file.path === 'server.ts';

      if (!isServerOrTestFile) {
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
      }

      // 2. Syntax-aware AST inspection for imports, path aliases, env vars, and contracts
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
          envVarsUsed,
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

      // 3. Incomplete implementation or decorative placeholder detection
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

    // Deduplicate issues by canonical fingerprint
    const seenIssues = new Set<string>();
    const deduplicatedIssues: IntegrationIssue[] = [];
    for (const issue of issues) {
      const key = `${issue.type}::${issue.sourceFile}::${issue.targetFile || ''}::${issue.identifier || ''}::${issue.message}`;
      if (!seenIssues.has(key)) {
        seenIssues.add(key);
        deduplicatedIssues.push(issue);
      }
    }

    return {
      passed: !hasErrors,
      totalImportsAnalyzed: totalImports,
      validImportsCount: validImports,
      issues: deduplicatedIssues,
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
   * Walks the AST of a single source file to validate relative import targets, path aliases (@/*, ~/*),
   * named/default/namespace/type-only bindings, CommonJS requires, dynamic imports,
   * environment variable access without comment false-positives, and function call interfaces.
   */
  private static walkSourceAST(
    sourceFile: ts.SourceFile,
    file: ProjectFile,
    fileDir: string,
    filesByCleanPath: Map<string, ProjectFile>,
    exportsMap: Map<string, ParsedFileExports>,
    importGraph: Map<string, Set<string>>,
    issues: IntegrationIssue[],
    envVarsUsed: Set<string>,
    onImportAnalyzed: () => void,
    onValidImport: () => void
  ): void {
    const cleanSourcePath = file.path.replace(/^\/+/, '');
    const importedFunctions = new Map<string, { targetExports: ParsedFileExports; originalName: string; targetFile: string }>();

    const checkModuleImport = (
      specifier: string,
      nodeText: string,
      importClause?: ts.ImportClause
    ) => {
      const { resolvedPath, isProjectModule } = this.resolveModuleSpecifier(fileDir, specifier, filesByCleanPath);
      if (!isProjectModule) return;

      onImportAnalyzed();
      const targetFile = this.findMatchingFile(resolvedPath, filesByCleanPath);
      const cleanTarget = resolvedPath.replace(/^\/+/, '');
      const targetCanonical = targetFile ? targetFile.path.replace(/^\/+/, '') : cleanTarget;

      if (!importGraph.has(cleanSourcePath)) {
        importGraph.set(cleanSourcePath, new Set());
      }
      importGraph.get(cleanSourcePath)!.add(targetCanonical);

      if (!targetFile) {
        issues.push({
          type: 'missing_imported_file',
          sourceFile: file.path,
          targetFile: resolvedPath,
          identifier: specifier,
          message: `File "${file.path}" imports from "${specifier}", but target file "${resolvedPath}" does not exist.`,
          severity: 'error',
          evidence: `Import statement: ${nodeText}`,
          suggestedCorrection: `Create file "${resolvedPath}" or update import path to match existing files.`
        });
        return;
      }

      onValidImport();
      const cleanTargetKey = targetFile.path.replace(/^\/+/, '');
      const targetExports = exportsMap.get(cleanTargetKey);

      if (targetExports && importClause) {
        // 1. Check default import: import Foo from './target'
        if (importClause.name && !importClause.isTypeOnly) {
          const defaultName = importClause.name.text;
          if (!targetExports.hasDefaultExport && targetExports.namedExports.size > 0) {
            issues.push({
              type: 'invalid_default_import',
              sourceFile: file.path,
              targetFile: targetFile.path,
              identifier: defaultName,
              message: `Module "${targetFile.path}" has no default export, but is imported with default import "${defaultName}".`,
              severity: 'error',
              evidence: `Import: ${nodeText}`,
              suggestedCorrection: `Use named import: import { ${Array.from(targetExports.namedExports).slice(0, 3).join(', ')} } from "${specifier}";`
            });
          }
        }

        // 2. Check named imports: import { a, b } from './target'
        if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
          for (const elem of importClause.namedBindings.elements) {
            if (elem.isTypeOnly) continue; // Skip type-only named import
            const importedIdentifier = (elem.propertyName || elem.name).text;
            const localIdentifier = elem.name.text;

            // Track function signatures for contract checking
            if (targetExports.exportedFunctions.has(importedIdentifier)) {
              importedFunctions.set(localIdentifier, {
                targetExports,
                originalName: importedIdentifier,
                targetFile: targetFile.path
              });
            }

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
    };

    const visit = (node: ts.Node) => {
      // 1. Static ES module import: import { foo } from './foo'
      if (ts.isImportDeclaration(node)) {
        const specifierNode = node.moduleSpecifier;
        if (ts.isStringLiteral(specifierNode)) {
          checkModuleImport(specifierNode.text, node.getText(sourceFile), node.importClause);
        }
      }

      // 2. Static re-export: export { foo } from './foo' or export * from './foo'
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        checkModuleImport(node.moduleSpecifier.text, node.getText(sourceFile));
      }

      // 3. Dynamic import: import('./foo')
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
          checkModuleImport((node.arguments[0] as ts.StringLiteral).text, node.getText(sourceFile));
        }
      }

      // 4. CommonJS require: require('./foo')
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        if (node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
          checkModuleImport((node.arguments[0] as ts.StringLiteral).text, node.getText(sourceFile));
        }
      }

      // 5. AST Environment variable access (accurate, ignores comments and arbitrary strings)
      // a. process.env.NAME
      if (ts.isPropertyAccessExpression(node)) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'process' &&
          node.expression.name.text === 'env'
        ) {
          envVarsUsed.add(node.name.text);
        }
        // b. import.meta.env.NAME
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'env' &&
          node.expression.expression.kind === ts.SyntaxKind.MetaProperty
        ) {
          envVarsUsed.add(node.name.text);
        }
      }

      // c. process.env['NAME'] or import.meta.env['NAME']
      if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'process' &&
          node.expression.name.text === 'env'
        ) {
          envVarsUsed.add(node.argumentExpression.text);
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'env' &&
          node.expression.expression.kind === ts.SyntaxKind.MetaProperty
        ) {
          envVarsUsed.add(node.argumentExpression.text);
        }
      }

      // d. Destructured: const { A, B } = process.env or const { A } = import.meta.env
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
        let isEnvInitializer = false;
        if (
          ts.isPropertyAccessExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === 'process' &&
          node.initializer.name.text === 'env'
        ) {
          isEnvInitializer = true;
        } else if (
          ts.isPropertyAccessExpression(node.initializer) &&
          node.initializer.name.text === 'env' &&
          node.initializer.expression.kind === ts.SyntaxKind.MetaProperty
        ) {
          isEnvInitializer = true;
        }

        if (isEnvInitializer) {
          for (const elem of node.name.elements) {
            const varName = elem.propertyName && ts.isIdentifier(elem.propertyName)
              ? elem.propertyName.text
              : (ts.isIdentifier(elem.name) ? elem.name.text : null);
            if (varName) envVarsUsed.add(varName);
          }
        }
      }

      // 6. Incompatible interface check: imported function called with missing arguments
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const fnInfo = importedFunctions.get(node.expression.text);
        if (fnInfo) {
          const sig = fnInfo.targetExports.exportedFunctions.get(fnInfo.originalName);
          if (sig && node.arguments.length < sig.requiredParamCount) {
            issues.push({
              type: 'incompatible_interface',
              sourceFile: file.path,
              targetFile: fnInfo.targetFile,
              identifier: fnInfo.originalName,
              message: `Function "${fnInfo.originalName}" imported from "${fnInfo.targetFile}" requires ${sig.requiredParamCount} parameter(s), but called with ${node.arguments.length}.`,
              severity: 'error',
              evidence: `Call expression: ${node.getText(sourceFile)}`,
              suggestedCorrection: `Provide all ${sig.requiredParamCount} required arguments to "${fnInfo.originalName}".`
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  /**
   * Resolves module specifier with relative paths and path aliases (@/*, ~/*).
   */
  private static resolveModuleSpecifier(
    fileDir: string, 
    specifier: string, 
    filesByCleanPath: Map<string, ProjectFile>
  ): { resolvedPath: string; isProjectModule: boolean } {
    if (specifier.startsWith('.')) {
      return { resolvedPath: this.resolveRelativePath(fileDir, specifier), isProjectModule: true };
    }
    if (specifier.startsWith('@/')) {
      const stripped = specifier.slice(2);
      const srcCandidate = `src/${stripped}`;
      if (filesByCleanPath.has(srcCandidate) || this.findMatchingFile(srcCandidate, filesByCleanPath)) {
        return { resolvedPath: srcCandidate, isProjectModule: true };
      }
      return { resolvedPath: stripped, isProjectModule: true };
    }
    if (specifier.startsWith('~/')) {
      const stripped = specifier.slice(2);
      const srcCandidate = `src/${stripped}`;
      if (filesByCleanPath.has(srcCandidate) || this.findMatchingFile(srcCandidate, filesByCleanPath)) {
        return { resolvedPath: srcCandidate, isProjectModule: true };
      }
      return { resolvedPath: stripped, isProjectModule: true };
    }
    return { resolvedPath: specifier, isProjectModule: false };
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
   * Detects circular dependency cycles in module import graph using Depth-First Search
   * and deduplicates cycles using canonical rotation.
   */
  private static detectCircularDependencies(graph: Map<string, Set<string>>): string[][] {
    const cycles: string[][] = [];
    const seenCycleKeys = new Set<string>();
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
          const cycleStartIndex = pathStack.indexOf(neighbor);
          if (cycleStartIndex >= 0) {
            const rawCycle = pathStack.slice(cycleStartIndex);
            if (rawCycle.length > 0) {
              // Canonical rotation to deduplicate cycle representations
              let minIdx = 0;
              for (let i = 1; i < rawCycle.length; i++) {
                if (rawCycle[i] < rawCycle[minIdx]) minIdx = i;
              }
              const canonical = [...rawCycle.slice(minIdx), ...rawCycle.slice(0, minIdx)];
              const key = canonical.join(' -> ');
              if (!seenCycleKeys.has(key)) {
                seenCycleKeys.add(key);
                cycles.push([...rawCycle, neighbor]);
              }
            }
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
    const clean = resolvedPath.replace(/^\/+/, '');
    // 1. Direct match
    if (filesMap.has(clean)) return filesMap.get(clean);

    // 2. Strip extension
    const base = clean.replace(/\.(js|mjs|cjs|ts|tsx|jsx)$/, '');
    if (filesMap.has(base)) return filesMap.get(base);

    // 3. Try standard extensions (including ESM .js mapping to .ts)
    const candidates = [
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.jsx`,
      `${base}.mjs`,
      `${base}.cjs`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
      `${base}/index.jsx`
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
