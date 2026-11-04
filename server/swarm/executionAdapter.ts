import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import ts from 'typescript';
import { ProjectFile } from '../types.js';
import { db } from '../store.js';
import { hashWorkspace } from '../execution/workspaceMaterializer.js';

export interface SyntaxErrorDetail {
  filePath: string;
  message: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
}

export interface SecurityFinding {
  severity: 'low' | 'medium' | 'high';
  filePath: string;
  message: string;
  line?: number;
}

export interface TestCaseResult {
  name: string;
  passed: boolean;
  status: 'passed' | 'failed' | 'skipped';
  message?: string;
  durationMs?: number;
}

export interface TestExecutionReport {
  status: 'passed' | 'failed' | 'skipped';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  details: TestCaseResult[];
  stdout?: string;
  stderr?: string;
  executionTimeMs?: number;
  skipReason?: string;
}

export interface BuildValidationReport {
  status: 'passed' | 'failed' | 'skipped';
  passed: boolean;
  output?: string;
  errors: string[];
}

export interface TypeDiagnostic {
  filePath: string;
  line?: number;
  column?: number;
  code: string;
  message: string;
  category: 'error' | 'warning' | 'suggestion' | 'message';
}

export interface TypeCheckReport {
  status: 'passed' | 'failed' | 'skipped' | 'not_run';
  passed: boolean;
  diagnostics: TypeDiagnostic[];
  errors: TypeDiagnostic[];
  warnings: TypeDiagnostic[];
  syntaxErrors?: TypeDiagnostic[];
  configErrors?: TypeDiagnostic[];
  typeErrors?: TypeDiagnostic[];
  missingDependencies?: string[];
  totalChecked: number;
  skipReason?: string;
  durationMs?: number;
  command?: string;
  exitCode?: number;
}

export interface VerificationExecutionResult {
  passed: boolean;
  summary: string;
  syntaxErrors: SyntaxErrorDetail[];
  typeCheckReport: TypeCheckReport;
  securityAudit: {
    passed: boolean;
    score: number;
    findings: SecurityFinding[];
  };
  configErrors: string[];
  testReport: TestExecutionReport;
  buildReport: BuildValidationReport;
  executedAt: number;
}

export class ExecutionAdapter {
  private static MAX_EXECUTION_TIMEOUT_MS = 15000; // 15 seconds execution timeout
  private static MAX_FILE_SIZE_BYTES = 500 * 1024; // 500 KB limit per file
  private static MAX_TOTAL_PROJECT_BYTES = 10 * 1024 * 1024; // 10 MB total project limit

  /**
   * Sanitizes relative file path and protects against path traversal attempts.
   * Strictly rejects absolute Unix paths, Windows drive paths, UNC paths, and null bytes.
   */
  static sanitizeFilePath(rawPath: string): { valid: boolean; cleanPath: string; error?: string } {
    if (!rawPath || typeof rawPath !== 'string') {
      return { valid: false, cleanPath: '', error: 'File path cannot be empty' };
    }

    const trimmed = rawPath.trim();
    if (!trimmed) {
      return { valid: false, cleanPath: '', error: 'File path cannot be empty' };
    }

    if (trimmed.includes('\0')) {
      return { valid: false, cleanPath: '', error: 'Null byte injection detected in file path' };
    }

    // Reject UNC paths (e.g. //server/share or \\server\share)
    if (trimmed.startsWith('//') || trimmed.startsWith('\\\\')) {
      return { valid: false, cleanPath: '', error: 'UNC network paths are forbidden' };
    }

    // Reject absolute Unix paths
    if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
      return { valid: false, cleanPath: '', error: 'Absolute file paths are forbidden' };
    }

    // Reject Windows drive paths (e.g. C:, C:/, C:\, d:\...)
    if (/^[a-zA-Z]:/i.test(trimmed)) {
      return { valid: false, cleanPath: '', error: 'Windows drive paths are forbidden' };
    }

    // Disallow traversal components in normalized path
    const normalized = trimmed.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (segments.some(seg => seg === '..' || seg === '.')) {
      return { valid: false, cleanPath: '', error: 'Directory traversal sequence (..) is prohibited' };
    }

    const cleaned = segments.filter(Boolean).join('/');
    if (!cleaned) {
      return { valid: false, cleanPath: '', error: 'Resolved path is empty' };
    }

    const resolved = path.posix.normalize(cleaned);
    if (resolved.startsWith('..') || resolved.startsWith('/') || resolved === '.') {
      return { valid: false, cleanPath: '', error: 'Path resolved outside project boundary' };
    }

    return { valid: true, cleanPath: cleaned };
  }

  /**
   * Validates syntax of all project files using genuine compilers (esbuild for JS/TS, JSON parser)
   */
  static validateSyntax(files: ProjectFile[]): SyntaxErrorDetail[] {
    const errors: SyntaxErrorDetail[] = [];

    for (const file of files) {
      const { path: filePath, content } = file;

      // 1. JSON files
      if (filePath.endsWith('.json')) {
        try {
          JSON.parse(content);
        } catch (err: any) {
          errors.push({
            filePath,
            message: `Invalid JSON syntax: ${err.message}`,
            severity: 'error'
          });
        }
        continue;
      }

      // 2. JS / TS / TSX / JSX files - real esbuild AST parse
      if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) {
        let loader: 'ts' | 'tsx' | 'js' | 'jsx' = 'ts';
        if (filePath.endsWith('.tsx')) loader = 'tsx';
        else if (filePath.endsWith('.jsx')) loader = 'jsx';
        else if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) loader = 'js';

        try {
          esbuild.transformSync(content, {
            loader,
            target: 'es2022',
            sourcemap: false
          });
        } catch (err: any) {
          if (err.errors && Array.isArray(err.errors)) {
            for (const esbErr of err.errors) {
              errors.push({
                filePath,
                message: esbErr.text || 'Syntax error',
                line: esbErr.location?.line,
                column: esbErr.location?.column,
                severity: 'error'
              });
            }
          } else {
            errors.push({
              filePath,
              message: err.message || 'Syntax parse failed',
              severity: 'error'
            });
          }
        }

        // Bracket & balanced brace check
        const balance = this.checkBracketsBalance(content, filePath);
        if (balance) {
          errors.push({
            filePath,
            message: balance.message,
            line: balance.line,
            severity: 'error'
          });
        }

        // Check for unresolved git merge conflict markers
        if (content.includes('<<<<<<<') || content.includes('>>>>>>>') || content.includes('=======')) {
          errors.push({
            filePath,
            message: 'Unresolved git merge conflict markers detected in source code',
            severity: 'error'
          });
        }

        // Multiple default exports
        const exportDefaults = content.match(/export\s+default/g);
        if (exportDefaults && exportDefaults.length > 1) {
          errors.push({
            filePath,
            message: `Multiple default exports found (${exportDefaults.length}) in ${filePath}`,
            severity: 'error'
          });
        }
      }
    }

    return errors;
  }

  /**
   * Fast brackets and braces balance verification
   */
  private static checkBracketsBalance(code: string, filePath: string): { filePath: string; message: string; line?: number } | null {
    const stack: { char: string; line: number }[] = [];
    const lines = code.split('\n');
    let inBlockComment = false;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      let line = lines[lineIdx];

      // Remove string literals to prevent bracket counting inside quotes
      line = line.replace(/(["'`])(?:\\.|[^\\])*?\1/g, '""');

      const commentIdx = line.indexOf('//');
      if (commentIdx !== -1) {
        line = line.substring(0, commentIdx);
      }

      for (let charIdx = 0; charIdx < line.length; charIdx++) {
        const char = line[charIdx];
        const nextChar = line[charIdx + 1];

        if (char === '/' && nextChar === '*') {
          inBlockComment = true;
          charIdx++;
          continue;
        }
        if (char === '*' && nextChar === '/') {
          inBlockComment = false;
          charIdx++;
          continue;
        }
        if (inBlockComment) continue;

        if (char === '{' || char === '(' || char === '[') {
          stack.push({ char, line: lineIdx + 1 });
        } else if (char === '}' || char === ')' || char === ']') {
          if (stack.length === 0) {
            return {
              filePath,
              message: `Unmatched closing bracket '${char}' at line ${lineIdx + 1}`,
              line: lineIdx + 1
            };
          }
          const last = stack.pop()!;
          const matches = (last.char === '{' && char === '}') ||
                          (last.char === '(' && char === ')') ||
                          (last.char === '[' && char === ']');
          if (!matches) {
            return {
              filePath,
              message: `Mismatched bracket: expected match for '${last.char}' (line ${last.line}), got '${char}' at line ${lineIdx + 1}`,
              line: lineIdx + 1
            };
          }
        }
      }
    }

    if (stack.length > 0) {
      const unclosed = stack[stack.length - 1];
      return {
        filePath,
        message: `Unclosed '${unclosed.char}' opened at line ${unclosed.line}`,
        line: unclosed.line
      };
    }

    return null;
  }

  /**
   * Static security analysis: detects exposed secrets, dangerous execution, and unsafe paths
   */
  static auditSecurity(files: ProjectFile[]): { passed: boolean; score: number; findings: SecurityFinding[] } {
    const findings: SecurityFinding[] = [];

    for (const file of files) {
      const { path: filePath, content } = file;

      // 1. Hardcoded API secrets (OpenAI, GitHub, Anthropic, Google, AWS)
      if (
        /sk-[a-zA-Z0-9]{20,}/.test(content) ||
        /ghp_[a-zA-Z0-9]{20,}/.test(content) ||
        /AIzaSy[a-zA-Z0-9_-]{33}/.test(content) ||
        /AKIA[0-9A-Z]{16}/.test(content)
      ) {
        findings.push({
          severity: 'high',
          filePath,
          message: 'Hardcoded API secret token detected. Use environment variables.'
        });
      }

      // 2. Dangerous eval() and dynamic Function()
      if (/\beval\s*\(/.test(content)) {
        findings.push({
          severity: 'high',
          filePath,
          message: 'Use of dangerous eval() detected. Disallowed in secure software.'
        });
      }

      if (/new\s+Function\s*\(/.test(content)) {
        findings.push({
          severity: 'medium',
          filePath,
          message: 'Dynamic new Function() constructor detected.'
        });
      }

      // 3. Path traversal patterns
      if (content.includes('../../../etc/passwd') || content.includes('..\\..\\Windows')) {
        findings.push({
          severity: 'high',
          filePath,
          message: 'Insecure file system path traversal literal detected.'
        });
      }

      // 4. Insecure command injection vectors in backend files
      if (/(child_process|execSync|spawnSync)\s*\([^)]*req\./.test(content)) {
        findings.push({
          severity: 'high',
          filePath,
          message: 'Unsanitized user request parameter passed directly to process execution.'
        });
      }
    }

    const highCount = findings.filter(f => f.severity === 'high').length;
    const mediumCount = findings.filter(f => f.severity === 'medium').length;
    const lowCount = findings.filter(f => f.severity === 'low').length;

    const penalty = (highCount * 40) + (mediumCount * 15) + (lowCount * 5);
    const score = Math.max(0, 100 - penalty);
    const passed = highCount === 0;

    return { passed, score, findings };
  }

  /**
   * Validates configuration files (package.json, tsconfig.json)
   */
  static validateConfigs(files: ProjectFile[]): string[] {
    const errors: string[] = [];
    const pkgFile = files.find(f => f.path === 'package.json');
    if (pkgFile) {
      try {
        const pkg = JSON.parse(pkgFile.content);
        if (!pkg.name || typeof pkg.name !== 'string') {
          errors.push('package.json missing required "name" field');
        }
      } catch (err: any) {
        errors.push(`Invalid package.json: ${err.message}`);
      }
    }

    const tsconfigFile = files.find(f => f.path === 'tsconfig.json');
    if (tsconfigFile) {
      try {
        JSON.parse(tsconfigFile.content);
      } catch (err: any) {
        errors.push(`Invalid tsconfig.json: ${err.message}`);
      }
    }

    return errors;
  }

  /**
   * Executes automated unit & integration tests in an isolated, scrubbed sandbox workspace.
   * Host environment variables (especially API keys & secrets) are NEVER passed to child process.
   */
  static runIsolatedTests(buildId: string, files: ProjectFile[]): TestExecutionReport {
    const testFiles = files.filter(f => 
      f.path.includes('.test.') || 
      f.path.includes('.spec.') || 
      f.path.startsWith('tests/')
    );

    if (testFiles.length === 0) {
      return {
        status: 'skipped',
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        details: [],
        skipReason: 'No test files (.test.ts or tests/*.ts) defined in project yet'
      };
    }

    // Generated tests are untrusted code, so they only run in the sandbox.
    // Host execution exists solely for this repository's own trusted test fixtures.
    const trustedFixtureRun = process.env.SQUADFORGE_TRUSTED_HOST_TESTS === '1' && process.env.NODE_ENV !== 'production';
    if (!trustedFixtureRun) {
      return this.sandboxTestReport(buildId, files, testFiles.length);
    }

    // Create a temporary workspace for trusted fixtures
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `squadforge_test_${buildId}_`));

    try {
      // Write project files to isolated sandbox
      for (const file of files) {
        const { valid, cleanPath } = this.sanitizeFilePath(file.path);
        if (!valid) continue;

        const target = path.join(tempDir, cleanPath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content, 'utf-8');
      }

      // Check test files actually exist on disk
      const testPathsOnDisk = testFiles
        .map(f => path.join(tempDir, f.path))
        .filter(p => fs.existsSync(p));

      if (testPathsOnDisk.length === 0) {
        return {
          status: 'skipped',
          total: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          details: [],
          skipReason: 'No executable test files found in sandbox workspace'
        };
      }

      // Execute tests via tsx --test or node --test with scrubbed environment
      // CRITICAL SECURITY: Zero application secrets passed to child process
      // Locate tsx executable: prefer local node_modules binary over global npx
      const localBinDir = path.resolve(process.cwd(), 'node_modules/.bin');
      const localTsxPath = path.join(localBinDir, process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
      const hasLocalTsx = fs.existsSync(localTsxPath);

      // Prepend local node_modules/.bin to PATH so local tools take precedence
      const pathSeparator = process.platform === 'win32' ? ';' : ':';
      const augmentedPath = hasLocalTsx 
        ? `${localBinDir}${pathSeparator}${process.env.PATH || ''}` 
        : (process.env.PATH || '');

      const scrubbedEnv: NodeJS.ProcessEnv = {
        PATH: augmentedPath,
        NODE_ENV: 'test',
        HOME: tempDir,
        TEMP: tempDir,
        TMP: tempDir
      };

      const startTime = Date.now();
      const command = hasLocalTsx ? localTsxPath : 'npx';
      const args = hasLocalTsx 
        ? ['--test', ...testFiles.map(f => f.path)]
        : ['--yes', 'tsx', '--test', ...testFiles.map(f => f.path)];

      const runResult = spawnSync(
        command,
        args,
        {
          cwd: tempDir,
          env: scrubbedEnv,
          timeout: this.MAX_EXECUTION_TIMEOUT_MS,
          encoding: 'utf-8',
          maxBuffer: 2 * 1024 * 1024 // 2 MB max output
        }
      );
      const executionTimeMs = Date.now() - startTime;

      const stdout = runResult.stdout || '';
      const stderr = runResult.stderr || '';

      // Parse test results from stdout/stderr
      const testDetails = this.parseTestOutput(stdout, stderr, testFiles);

      const passed = testDetails.filter(t => t.passed).length;
      const failed = testDetails.filter(t => !t.passed && t.status !== 'skipped').length;
      const skipped = testDetails.filter(t => t.status === 'skipped').length;

      let overallStatus: 'passed' | 'failed' | 'skipped';
      if (failed > 0 || runResult.status !== 0) {
        overallStatus = 'failed';
      } else if (passed > 0) {
        overallStatus = 'passed';
      } else if (skipped > 0 || testDetails.length === 0) {
        // Skipped tests are NEVER treated as passed
        overallStatus = 'skipped';
      } else {
        overallStatus = 'failed';
      }

      return {
        status: overallStatus,
        total: passed + failed + skipped,
        passed,
        failed,
        skipped,
        details: testDetails,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 2000),
        executionTimeMs
      };
    } catch (err: any) {
      return {
        status: 'failed',
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        details: [{
          name: 'Sandbox Test Runner Execution',
          passed: false,
          status: 'failed',
          message: err.message || 'Execution error in sandbox'
        }],
        stderr: err.message
      };
    } finally {
      // Clean up temporary workspace safely
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        // Ignored
      }
    }
  }

  /**
   * Parses test output into structured test cases
   */
  /** Reports the sandbox test run for exactly this workspace, or an honest skip. */
  private static sandboxTestReport(buildId: string, files: ProjectFile[], testFileCount: number): TestExecutionReport {
    const run = db.getSandboxTestRun(buildId, hashWorkspace(files));
    if (!run) {
      return {
        status: 'skipped',
        total: 0,
        passed: 0,
        failed: 0,
        skipped: testFileCount,
        details: [],
        skipReason: 'Tests have not run in the sandbox for this version of the project. Generated tests never run on the server.'
      };
    }

    const passed = run.endReason === 'exited' && run.exitCode === 0;
    return {
      status: passed ? 'passed' : 'failed',
      total: 1,
      passed: passed ? 1 : 0,
      failed: passed ? 0 : 1,
      skipped: 0,
      details: [{
        name: 'npm test in sandbox',
        passed,
        status: passed ? 'passed' : 'failed',
        message: `Sandbox run ended with ${run.endReason} (exit code ${run.exitCode})`
      }]
    };
  }

  private static parseTestOutput(stdout: string, stderr: string, testFiles: ProjectFile[]): TestCaseResult[] {
    const results: TestCaseResult[] = [];
    const lines = (stdout + '\n' + stderr).split('\n');

    for (const line of lines) {
      // TAP / node:test format: 'ok 1 - test description' or 'not ok 2 - test description'
      const okMatch = line.match(/^\s*(ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s+(?:skip|todo).*)?$/i);
      if (okMatch) {
        const isOk = okMatch[1].toLowerCase() === 'ok';
        const name = okMatch[2].trim();
        const isSkipped = /#\s*(?:skip|todo)/i.test(line);

        results.push({
          name,
          passed: isOk && !isSkipped,
          status: isSkipped ? 'skipped' : (isOk ? 'passed' : 'failed'),
          message: isOk ? undefined : 'Test assertion failed'
        });
      }
    }

    // Fallback: if TAP parser didn't catch individual tests, extract test('...') declarations
    if (results.length === 0) {
      for (const tf of testFiles) {
        const matches = tf.content.matchAll(/(?:test|it)(?:\.(skip|only))?\s*\(\s*['"]([^'"]+)['"]/g);
        for (const m of matches) {
          const isSkipped = m[1] === 'skip';
          const name = m[2];
          const hasError = stdout.includes(name) && (stdout.includes('fail') || stderr.includes('Error'));
          results.push({
            name,
            passed: !hasError && !isSkipped,
            status: isSkipped ? 'skipped' : (hasError ? 'failed' : 'passed'),
            message: isSkipped ? 'Test marked as skipped' : (hasError ? 'Execution failure reported in test output' : undefined)
          });
        }
      }
    }

    return results;
  }

  /**
   * Runs production build validation by bundling main entry point
   */
  static runProductionBuild(buildId: string, files: ProjectFile[]): BuildValidationReport {
    const entryFile = files.find(f => 
      f.path === 'src/main.tsx' || 
      f.path === 'src/index.ts' || 
      f.path === 'src/core/engine.ts' ||
      f.path === 'server.ts'
    );

    if (!entryFile) {
      return {
        status: 'skipped',
        passed: true,
        errors: [],
        output: 'Skipped: No standard frontend or backend entry point identified.'
      };
    }

    // Build validation using isolated sandbox disk compilation
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `squadforge_build_${buildId}_`));

    try {
      for (const file of files) {
        const { valid, cleanPath } = this.sanitizeFilePath(file.path);
        if (!valid) continue;
        const target = path.join(tempDir, cleanPath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content, 'utf-8');
      }

      const entryDiskPath = path.join(tempDir, entryFile.path);
      const result = esbuild.buildSync({
        entryPoints: [entryDiskPath],
        bundle: true,
        write: false,
        format: 'esm',
        target: 'es2022',
        external: [
          'react', 
          'react-dom', 
          'react-dom/*', 
          'react/*', 
          'lucide-react', 
          'express', 
          'node:*',
          'cors',
          'dotenv',
          'cookie-parser'
        ]
      });

      const passed = result.errors.length === 0;
      return {
        status: passed ? 'passed' : 'failed',
        passed,
        errors: result.errors.map(e => e.text),
        output: passed ? `Bundle compiled cleanly (${(result.outputFiles?.[0]?.contents.length || 0)} bytes).` : undefined
      };
    } catch (err: any) {
      const errors = err.errors ? err.errors.map((e: any) => e.text) : [err.message || 'Build bundle failed'];
      return {
        status: 'failed',
        passed: false,
        errors,
        output: errors.join('\n')
      };
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignored
      }
    }
  }

  /**
   * Performs genuine TypeScript compilation and type checking using project's installed TypeScript compiler.
   * Produces actual compiler diagnostics with file paths, line numbers, TS codes, and readable messages.
   * Strictly distinguishes syntax validation from type validation, and passed vs failed vs skipped states.
   */
  /**
   * Performs genuine, project-aware TypeScript compilation and type checking.
   * Reads and respects generated tsconfig.json (compilerOptions, strict mode, JSX, path aliases, module resolution),
  /**
   * Validates TypeScript types across project files. Alias for runTypeCheck.
   */
  static validateTypes(buildIdOrFiles: string | ProjectFile[], filesMaybe?: ProjectFile[]): TypeCheckReport {
    return this.runTypeCheck(buildIdOrFiles, filesMaybe);
  }

  static runTypeCheck(buildIdOrFiles: string | ProjectFile[], filesMaybe?: ProjectFile[]): TypeCheckReport {
    let buildId: string;
    let files: ProjectFile[];
    if (typeof buildIdOrFiles === 'string') {
      buildId = buildIdOrFiles;
      files = filesMaybe || [];
    } else {
      buildId = 'adhoc';
      files = Array.isArray(buildIdOrFiles) ? buildIdOrFiles : [];
    }

    const startTime = Date.now();

    // Check project size and file size limits
    let totalProjectBytes = 0;
    for (const file of files) {
      const byteLength = Buffer.byteLength(file.content, 'utf-8');
      if (byteLength > this.MAX_FILE_SIZE_BYTES) {
        const sizeErr: TypeDiagnostic = {
          filePath: file.path,
          line: 1,
          column: 1,
          code: 'TS_SIZE_LIMIT',
          message: `File ${file.path} exceeds size limit (${byteLength} bytes > ${this.MAX_FILE_SIZE_BYTES} max)`,
          category: 'error'
        };
        return {
          status: 'failed',
          passed: false,
          diagnostics: [sizeErr],
          errors: [sizeErr],
          warnings: [],
          syntaxErrors: [],
          configErrors: [],
          typeErrors: [sizeErr],
          missingDependencies: [],
          totalChecked: 0,
          durationMs: Date.now() - startTime,
          command: 'tsc --noEmit',
          exitCode: 1
        };
      }
      totalProjectBytes += byteLength;
    }

    if (totalProjectBytes > this.MAX_TOTAL_PROJECT_BYTES) {
      const projSizeErr: TypeDiagnostic = {
        filePath: 'project',
        line: 1,
        column: 1,
        code: 'TS_PROJECT_SIZE_LIMIT',
        message: `Total project size exceeds limit (${totalProjectBytes} bytes > ${this.MAX_TOTAL_PROJECT_BYTES} max)`,
        category: 'error'
      };
      return {
        status: 'failed',
        passed: false,
        diagnostics: [projSizeErr],
        errors: [projSizeErr],
        warnings: [],
        syntaxErrors: [],
        configErrors: [],
        typeErrors: [projSizeErr],
        missingDependencies: [],
        totalChecked: 0,
        durationMs: Date.now() - startTime,
        command: 'tsc --noEmit',
        exitCode: 1
      };
    }

    const tsFiles = files.filter(f => 
      /\.(ts|tsx)$/.test(f.path) && 
      !f.path.endsWith('.d.ts')
    );
    const dtsFiles = files.filter(f => f.path.endsWith('.d.ts'));
    const hasTsConfigFile = files.some(f => f.path === 'tsconfig.json');

    // Projects without TypeScript files and without tsconfig.json
    if (tsFiles.length === 0 && !hasTsConfigFile && dtsFiles.length === 0) {
      return {
        status: 'skipped',
        passed: false,
        diagnostics: [],
        errors: [],
        warnings: [],
        syntaxErrors: [],
        configErrors: [],
        typeErrors: [],
        missingDependencies: [],
        totalChecked: 0,
        skipReason: 'No TypeScript (.ts, .tsx) source files found in workspace',
        command: 'tsc --noEmit'
      };
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `squadforge_typecheck_${buildId}_`));

    try {
      // 1. Write project files to isolated sandbox workspace with path sanitization
      for (const file of files) {
        const { valid, cleanPath } = this.sanitizeFilePath(file.path);
        if (!valid) continue;
        const target = path.join(tempDir, cleanPath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content, 'utf-8');
      }

      // 2. Controlled dependency environment: link host node_modules into sandbox
      try {
        const hostNodeModules = path.resolve(process.cwd(), 'node_modules');
        const sandboxNodeModules = path.join(tempDir, 'node_modules');
        if (fs.existsSync(hostNodeModules) && !fs.existsSync(sandboxNodeModules)) {
          fs.symlinkSync(hostNodeModules, sandboxNodeModules, process.platform === 'win32' ? 'junction' : 'dir');
        }
      } catch {
        // Controlled environment continues without symlink if unsupported
      }

      // 3. Read and validate generated tsconfig.json if present
      let compilerOptions: ts.CompilerOptions;
      let rootFileNames: string[] = [];
      const configErrors: TypeDiagnostic[] = [];

      const tsConfigDiskPath = path.join(tempDir, 'tsconfig.json');
      if (hasTsConfigFile && fs.existsSync(tsConfigDiskPath)) {
        const configFile = ts.readConfigFile(tsConfigDiskPath, ts.sys.readFile);
        if (configFile.error) {
          const cfgErr: TypeDiagnostic = {
            filePath: 'tsconfig.json',
            line: 1,
            column: 1,
            code: `TS${configFile.error.code}`,
            message: ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'),
            category: 'error'
          };
          return {
            status: 'failed',
            passed: false,
            diagnostics: [cfgErr],
            errors: [cfgErr],
            warnings: [],
            syntaxErrors: [],
            configErrors: [cfgErr],
            typeErrors: [],
            missingDependencies: [],
            totalChecked: 0,
            durationMs: Date.now() - startTime,
            command: 'tsc --noEmit',
            exitCode: 1
          };
        }

        // Prevent recursive scanning into node_modules during tsconfig parsing
        const rawConfig = configFile.config || {};
        const existingExclude = Array.isArray(rawConfig.exclude) ? rawConfig.exclude : [];
        const safeExclude = Array.from(new Set([...existingExclude, 'node_modules', 'dist', 'build', '.git']));
        const safeConfig = {
          ...rawConfig,
          exclude: safeExclude
        };

        const parsedConfig = ts.parseJsonConfigFileContent(safeConfig, ts.sys, tempDir);
        if (parsedConfig.errors.length > 0) {
          for (const err of parsedConfig.errors) {
            const isErr = err.category === ts.DiagnosticCategory.Error;
            configErrors.push({
              filePath: err.file ? path.relative(tempDir, err.file.fileName).replace(/\\/g, '/') : 'tsconfig.json',
              line: err.file && err.start !== undefined ? err.file.getLineAndCharacterOfPosition(err.start).line + 1 : 1,
              column: err.file && err.start !== undefined ? err.file.getLineAndCharacterOfPosition(err.start).character + 1 : 1,
              code: `TS${err.code}`,
              message: ts.flattenDiagnosticMessageText(err.messageText, '\n'),
              category: isErr ? 'error' : 'warning'
            });
          }

          const fatalConfigErrors = configErrors.filter(e => e.category === 'error');
          if (fatalConfigErrors.length > 0) {
            return {
              status: 'failed',
              passed: false,
              diagnostics: configErrors,
              errors: fatalConfigErrors,
              warnings: configErrors.filter(e => e.category === 'warning'),
              syntaxErrors: [],
              configErrors: fatalConfigErrors,
              typeErrors: [],
              missingDependencies: [],
              totalChecked: 0,
              durationMs: Date.now() - startTime,
              command: 'tsc --noEmit',
              exitCode: 1
            };
          }
        }

        compilerOptions = {
          skipLibCheck: parsedConfig.options.skipLibCheck !== undefined ? parsedConfig.options.skipLibCheck : true,
          ...parsedConfig.options,
          noEmit: true
        };

        // Ensure baseUrl is resolved relative to tempDir
        if (compilerOptions.paths && !compilerOptions.baseUrl) {
          compilerOptions.baseUrl = tempDir;
        } else if (compilerOptions.baseUrl) {
          compilerOptions.baseUrl = path.resolve(tempDir, compilerOptions.baseUrl);
        }

        if (parsedConfig.fileNames && parsedConfig.fileNames.length > 0) {
          rootFileNames = parsedConfig.fileNames.filter(p => fs.existsSync(p));
        }
      } else {
        // Standard baseline compiler options when tsconfig.json is omitted
        compilerOptions = {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          allowImportingTsExtensions: true,
          jsx: ts.JsxEmit.ReactJSX,
          skipLibCheck: true,
          noEmit: true,
          allowJs: true,
          strict: false,
          baseUrl: tempDir
        };
      }

      // If rootFileNames not determined by tsconfig, collect all source and declaration files
      if (rootFileNames.length === 0) {
        rootFileNames = files
          .filter(f => /\.(ts|tsx|js|jsx|d\.ts)$/.test(f.path))
          .map(f => path.join(tempDir, f.path))
          .filter(p => fs.existsSync(p));
      }

      if (rootFileNames.length === 0) {
        return {
          status: 'skipped',
          passed: false,
          diagnostics: [],
          errors: [],
          warnings: [],
          syntaxErrors: [],
          configErrors: [],
          typeErrors: [],
          missingDependencies: [],
          totalChecked: 0,
          skipReason: 'No resolved TypeScript source files found on disk',
          command: 'tsc --noEmit'
        };
      }

      const host = ts.createCompilerHost(compilerOptions);
      const program = ts.createProgram(rootFileNames, compilerOptions, host);

      // Separate diagnostic categories
      const syntacticDiags = program.getSyntacticDiagnostics();
      const semanticDiags = program.getSemanticDiagnostics();
      const optionsDiags = program.getOptionsDiagnostics();

      const formatDiag = (diag: ts.Diagnostic, categoryOverride?: 'error' | 'warning'): TypeDiagnostic | null => {
        let relPath = 'project';
        let line = 1;
        let column = 1;

        if (diag.file) {
          relPath = path.relative(tempDir, diag.file.fileName).replace(/\\/g, '/');
          // Skip external libs and node_modules unless inside project
          if (relPath.startsWith('..') || relPath.includes('node_modules')) {
            return null;
          }
          const pos = diag.file.getLineAndCharacterOfPosition(diag.start || 0);
          line = pos.line + 1;
          column = pos.character + 1;
        }

        const category = categoryOverride || (diag.category === ts.DiagnosticCategory.Error ? 'error'
          : diag.category === ts.DiagnosticCategory.Warning ? 'warning'
          : diag.category === ts.DiagnosticCategory.Suggestion ? 'suggestion' : 'message');

        return {
          filePath: relPath,
          line,
          column,
          code: `TS${diag.code}`,
          message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
          category
        };
      };

      const syntaxErrors: TypeDiagnostic[] = [];
      for (const d of syntacticDiags) {
        const item = formatDiag(d, 'error');
        if (item) syntaxErrors.push(item);
      }

      const typeErrors: TypeDiagnostic[] = [];
      const warnings: TypeDiagnostic[] = [];
      const missingDependenciesSet = new Set<string>();

      for (const d of semanticDiags) {
        const item = formatDiag(d);
        if (!item) continue;

        // Check for missing module/package imports: TS2307, TS2792, TS7016
        const missingMatch = item.message.match(/(?:Cannot find module|Could not find a declaration file for module)\s+['"]([^'"./][^'"]*)['"]/i);
        if (missingMatch && [2307, 2792, 7016].includes(d.code)) {
          let pkg = missingMatch[1];
          if (pkg.startsWith('@')) {
            const parts = pkg.split('/');
            pkg = parts.slice(0, 2).join('/');
          } else {
            pkg = pkg.split('/')[0];
          }
          missingDependenciesSet.add(pkg);
        }

        if (item.category === 'error') {
          typeErrors.push(item);
        } else if (item.category === 'warning') {
          warnings.push(item);
        }
      }

      for (const d of optionsDiags) {
        const item = formatDiag(d);
        if (!item) continue;
        if (item.category === 'error') {
          configErrors.push(item);
        } else if (item.category === 'warning') {
          warnings.push(item);
        }
      }

      // Explicitly detect 3rd-party dependencies imported in source files that are not declared or installed
      const packageJsonFile = files.find(f => f.path === 'package.json');
      let declaredDeps = new Set<string>();
      if (packageJsonFile) {
        try {
          const pkgObj = JSON.parse(packageJsonFile.content);
          declaredDeps = new Set([
            ...Object.keys(pkgObj.dependencies || {}),
            ...Object.keys(pkgObj.devDependencies || {}),
            ...Object.keys(pkgObj.peerDependencies || {})
          ]);
        } catch {}
      }

      const nodeBuiltins = new Set([
        'fs', 'fs/promises', 'path', 'os', 'crypto', 'http', 'https', 'stream', 'events',
        'util', 'buffer', 'child_process', 'cluster', 'dgram', 'dns', 'net', 'readline',
        'tls', 'url', 'zlib', 'assert', 'assert/strict', 'test', 'node:test', 'node:assert', 'node:assert/strict'
      ]);

      // Collect ambient module declarations from .d.ts files in workspace
      const ambientModules = new Set<string>();
      for (const f of files) {
        if (f.path.endsWith('.d.ts') || f.content.includes('declare module')) {
          const modMatches = f.content.matchAll(/declare\s+module\s+['"]([^'"]+)['"]/g);
          for (const mm of modMatches) {
            ambientModules.add(mm[1]);
          }
        }
      }

      // Helper to check if an import matches tsconfig path aliases
      const isPathAlias = (importStr: string, paths?: ts.MapLike<string[]>): boolean => {
        if (!paths) return false;
        for (const pattern of Object.keys(paths)) {
          const prefix = pattern.replace(/\*.*$/, '');
          if (prefix && importStr.startsWith(prefix)) {
            return true;
          }
          if (pattern === importStr) return true;
        }
        return false;
      };

      for (const file of files) {
        if (!/\.(ts|tsx|js|jsx)$/.test(file.path)) continue;
        const importMatches = file.content.matchAll(/(?:import|from|require)\s*\(?['"]([^'"\r\n]+)['"]\)?/g);
        for (const match of importMatches) {
          const importPath = match[1];
          if (importPath.startsWith('.') || importPath.startsWith('/') || importPath.startsWith('node:')) {
            continue;
          }

          // Skip path aliases defined in tsconfig.json
          if (isPathAlias(importPath, compilerOptions?.paths)) {
            continue;
          }

          // Skip ambient modules declared in project .d.ts files
          if (ambientModules.has(importPath)) {
            continue;
          }

          let pkgName = importPath;
          if (pkgName.startsWith('@')) {
            pkgName = pkgName.split('/').slice(0, 2).join('/');
          } else {
            pkgName = pkgName.split('/')[0];
          }

          if (nodeBuiltins.has(pkgName) || nodeBuiltins.has(importPath)) {
            continue;
          }

          if (ambientModules.has(pkgName) || isPathAlias(pkgName, compilerOptions?.paths)) {
            continue;
          }

          const inSandboxOrHost = fs.existsSync(path.join(tempDir, 'node_modules', pkgName)) ||
                                  fs.existsSync(path.resolve(process.cwd(), 'node_modules', pkgName));

          if (!inSandboxOrHost && !declaredDeps.has(pkgName)) {
            missingDependenciesSet.add(pkgName);
            const alreadyHasError = typeErrors.some(e => e.message.includes(pkgName));
            if (!alreadyHasError) {
              const missingDiag: TypeDiagnostic = {
                filePath: file.path,
                line: 1,
                column: 1,
                code: 'TS2307_MISSING_DEPENDENCY',
                message: `Missing dependency: Cannot find module '${pkgName}' or its corresponding type declarations. Package is imported but not installed or declared in package.json.`,
                category: 'error'
              };
              typeErrors.push(missingDiag);
            }
          }
        }
      }

      const missingDependencies = Array.from(missingDependenciesSet);
      const errors = [...configErrors.filter(c => c.category === 'error'), ...syntaxErrors, ...typeErrors];
      const allDiagnostics = [...configErrors, ...syntaxErrors, ...typeErrors, ...warnings];
      const durationMs = Date.now() - startTime;
      const passed = errors.length === 0 && missingDependencies.length === 0;

      return {
        status: passed ? 'passed' : 'failed',
        passed,
        diagnostics: allDiagnostics,
        errors,
        warnings,
        syntaxErrors,
        configErrors: configErrors.filter(c => c.category === 'error'),
        typeErrors,
        missingDependencies,
        totalChecked: rootFileNames.length,
        durationMs,
        command: 'tsc --noEmit',
        exitCode: passed ? 0 : 1
      };
    } catch (err: any) {
      return {
        status: 'failed',
        passed: false,
        diagnostics: [{
          filePath: 'tsc',
          code: 'TS_EXEC_ERR',
          message: err.message || 'TypeScript compilation execution failure',
          category: 'error'
        }],
        errors: [{
          filePath: 'tsc',
          code: 'TS_EXEC_ERR',
          message: err.message || 'TypeScript compilation execution failure',
          category: 'error'
        }],
        warnings: [],
        syntaxErrors: [],
        configErrors: [],
        typeErrors: [],
        missingDependencies: [],
        totalChecked: tsFiles.length,
        durationMs: Date.now() - startTime,
        command: 'tsc --noEmit',
        exitCode: 1
      };
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }

  /**
   * Executes complete verification suite on a build
   */
  static runCompleteVerification(buildId: string, files: ProjectFile[]): VerificationExecutionResult {
    const executedAt = Date.now();

    // 1. Syntax & language validation (esbuild AST transformation)
    const syntaxErrors = this.validateSyntax(files);

    // 2. Configuration validation
    const configErrors = this.validateConfigs(files);

    // 3. Security audit
    const securityAudit = this.auditSecurity(files);

    // 4. Genuine TypeScript type checking (tsc compiler diagnostics)
    let typeCheckReport: TypeCheckReport;
    if (syntaxErrors.length === 0) {
      typeCheckReport = this.runTypeCheck(buildId, files);
    } else {
      typeCheckReport = {
        status: 'skipped',
        passed: false,
        diagnostics: [],
        errors: [],
        warnings: [],
        totalChecked: 0,
        skipReason: 'Type checking deferred: Syntax errors must be resolved first.',
        command: 'tsc --noEmit'
      };
    }

    // 5. Isolated unit & integration tests
    let testReport: TestExecutionReport;
    if (syntaxErrors.length === 0 && typeCheckReport.errors.length === 0) {
      testReport = this.runIsolatedTests(buildId, files);
    } else {
      testReport = {
        status: 'skipped',
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        details: [],
        skipReason: syntaxErrors.length > 0
          ? 'Tests deferred: Syntax errors must be resolved first.'
          : 'Tests deferred: TypeScript type errors must be resolved first.'
      };
    }

    // 6. Production build validation
    let buildReport: BuildValidationReport;
    if (syntaxErrors.length === 0 && typeCheckReport.errors.length === 0) {
      buildReport = this.runProductionBuild(buildId, files);
    } else {
      buildReport = {
        status: 'skipped',
        passed: false,
        errors: [syntaxErrors.length > 0 
          ? 'Build deferred: Syntax errors must be resolved first.' 
          : 'Build deferred: TypeScript type errors must be resolved first.']
      };
    }

    const hasTsFiles = files.some(f => f.path.endsWith('.ts') || f.path.endsWith('.tsx'));
    const typePassed = hasTsFiles ? (typeCheckReport.status === 'passed') : true;

    const hasTestFiles = files.some(f => 
      f.path.includes('.test.') || 
      f.path.includes('.spec.') || 
      f.path.startsWith('tests/')
    );

    const testPassed = hasTestFiles 
      ? (testReport.status === 'passed' && testReport.passed > 0 && testReport.failed === 0)
      : (testReport.status !== 'failed');

    const buildPassed = (buildReport.status === 'passed' || buildReport.status === 'skipped') && buildReport.passed !== false;

    const passed = syntaxErrors.length === 0 && 
                   typePassed &&
                   securityAudit.passed && 
                   configErrors.length === 0 &&
                   testPassed && 
                   buildPassed;

    const summary = passed
      ? `All verification checks passed (${files.length} files, ${typeCheckReport.totalChecked} TS files checked, ${testReport.passed} tests passed, security score: ${securityAudit.score}/100)`
      : `Verification found issues: ${syntaxErrors.length} syntax error(s), ${typeCheckReport.errors.length} type error(s), ${testReport.failed} failed test(s), ${securityAudit.findings.length} security finding(s)`;

    return {
      passed,
      summary,
      syntaxErrors,
      typeCheckReport,
      securityAudit,
      configErrors,
      testReport,
      buildReport,
      executedAt
    };
  }
}
