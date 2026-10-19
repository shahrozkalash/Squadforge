import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import { ProjectFile } from '../types.js';

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

export interface VerificationExecutionResult {
  passed: boolean;
  summary: string;
  syntaxErrors: SyntaxErrorDetail[];
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
  private static MAX_EXECUTION_TIMEOUT_MS = 6000; // 6 seconds execution timeout
  private static MAX_FILE_SIZE_BYTES = 500 * 1024; // 500 KB limit per file
  private static MAX_TOTAL_PROJECT_BYTES = 10 * 1024 * 1024; // 10 MB total project limit

  /**
   * Sanitizes relative file path and protects against path traversal attempts
   */
  static sanitizeFilePath(rawPath: string): { valid: boolean; cleanPath: string; error?: string } {
    if (!rawPath || typeof rawPath !== 'string') {
      return { valid: false, cleanPath: '', error: 'File path cannot be empty' };
    }

    if (rawPath.includes('\0')) {
      return { valid: false, cleanPath: '', error: 'Null byte injection detected in file path' };
    }

    // Strip leading slashes and drive letters
    let cleaned = rawPath.replace(/^([a-zA-Z]:)?[\\/]+/, '').replace(/\\/g, '/');

    // Disallow traversal components
    const segments = cleaned.split('/');
    if (segments.some(seg => seg === '..' || seg === '.')) {
      return { valid: false, cleanPath: '', error: 'Directory traversal sequence (..) is prohibited' };
    }

    cleaned = segments.filter(Boolean).join('/');
    if (!cleaned) {
      return { valid: false, cleanPath: '', error: 'Resolved path is empty' };
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

    // Create isolated temporary workspace
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
      const scrubbedEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH || '',
        NODE_ENV: 'test',
        HOME: tempDir,
        TEMP: tempDir,
        TMP: tempDir
      };

      const startTime = Date.now();
      const runResult = spawnSync(
        'npx',
        ['tsx', '--test', ...testFiles.map(f => f.path)],
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

      const overallStatus = runResult.status === 0 && failed === 0 ? 'passed' : 'failed';

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
  private static parseTestOutput(stdout: string, stderr: string, testFiles: ProjectFile[]): TestCaseResult[] {
    const results: TestCaseResult[] = [];
    const lines = (stdout + '\n' + stderr).split('\n');

    for (const line of lines) {
      // TAP / node:test format: 'ok 1 - test description' or 'not ok 2 - test description'
      const okMatch = line.match(/^\s*(ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s+skip)?$/i);
      if (okMatch) {
        const isOk = okMatch[1].toLowerCase() === 'ok';
        const name = okMatch[2].trim();
        const isSkipped = line.includes('# skip');

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
        const matches = tf.content.matchAll(/(?:test|it)\s*\(\s*['"]([^'"]+)['"]/g);
        for (const m of matches) {
          const name = m[1];
          const hasError = stdout.includes(name) && (stdout.includes('fail') || stderr.includes('Error'));
          results.push({
            name,
            passed: !hasError,
            status: hasError ? 'failed' : 'passed',
            message: hasError ? 'Execution failure reported in test output' : undefined
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

    // Virtual build using esbuild with plugin resolving from memory files
    const fileMap = new Map<string, string>();
    for (const f of files) {
      fileMap.set(f.path, f.content);
    }

    try {
      const memoryPlugin: esbuild.Plugin = {
        name: 'memory-virtual-fs',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            if (args.kind === 'entry-point') {
              return { path: args.path, namespace: 'mem-fs' };
            }
            // Resolve relative imports
            let resolved = path.join(path.dirname(args.importer), args.path).replace(/\\/g, '/');
            if (!resolved.startsWith('src/') && !resolved.startsWith('tests/')) {
              resolved = resolved.replace(/^\.?\/?/, '');
            }

            const candidates = [
              resolved,
              `${resolved}.ts`,
              `${resolved}.tsx`,
              `${resolved}.js`,
              `${resolved}/index.ts`,
              `${resolved}/index.tsx`
            ];

            for (const cand of candidates) {
              if (fileMap.has(cand)) {
                return { path: cand, namespace: 'mem-fs' };
              }
            }

            // Treat external packages as external
            return { path: args.path, external: true };
          });

          build.onLoad({ filter: /.*/, namespace: 'mem-fs' }, args => {
            const content = fileMap.get(args.path);
            if (content !== undefined) {
              const ext = path.extname(args.path).slice(1);
              const loader = (ext === 'tsx' || ext === 'jsx' || ext === 'ts' || ext === 'js') ? ext : 'ts';
              return { contents: content, loader };
            }
            return { errors: [{ text: `File not found in project workspace: ${args.path}` }] };
          });
        }
      };

      const result = esbuild.buildSync({
        entryPoints: [entryFile.path],
        plugins: [memoryPlugin],
        bundle: true,
        write: false,
        target: 'es2022'
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
    }
  }

  /**
   * Executes complete verification suite on a build
   */
  static runCompleteVerification(buildId: string, files: ProjectFile[]): VerificationExecutionResult {
    const executedAt = Date.now();

    // 1. Syntax & language validation
    const syntaxErrors = this.validateSyntax(files);

    // 2. Configuration validation
    const configErrors = this.validateConfigs(files);

    // 3. Security audit
    const securityAudit = this.auditSecurity(files);

    // 4. Isolated unit & integration tests
    let testReport: TestExecutionReport;
    if (syntaxErrors.length === 0) {
      testReport = this.runIsolatedTests(buildId, files);
    } else {
      testReport = {
        status: 'skipped',
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        details: [],
        skipReason: 'Tests deferred: Syntax errors must be resolved first.'
      };
    }

    // 5. Production build validation
    let buildReport: BuildValidationReport;
    if (syntaxErrors.length === 0) {
      buildReport = this.runProductionBuild(buildId, files);
    } else {
      buildReport = {
        status: 'skipped',
        passed: false,
        errors: ['Build deferred: Syntax errors must be resolved first.']
      };
    }

    const passed = syntaxErrors.length === 0 && 
                   securityAudit.passed && 
                   configErrors.length === 0 &&
                   testReport.status !== 'failed' && 
                   (buildReport.status === 'passed' || buildReport.status === 'skipped');

    const summary = passed
      ? `All verification checks passed (${files.length} files, ${testReport.passed} tests passed, security score: ${securityAudit.score}/100)`
      : `Verification found issues: ${syntaxErrors.length} syntax error(s), ${testReport.failed} failed test(s), ${securityAudit.findings.length} security finding(s)`;

    return {
      passed,
      summary,
      syntaxErrors,
      securityAudit,
      configErrors,
      testReport,
      buildReport,
      executedAt
    };
  }
}
