import { ProjectFile, TestCoverageReport } from '../types.js';

/**
 * Phase 12 — Automated Testing and Quality Assurance.
 *
 * Deterministic, file-level test coverage analysis for a generated project.
 *
 * The architecture blueprint (server/architecture/blueprintGenerator.ts)
 * plans an "Automated Testing & QA Verification Subsystem" with an
 * automated coverage goal of 85%, but until Phase 12 nothing in the
 * codebase measured whether a project's tests actually cover its source
 * files: the verification service reported only pass/fail counts from the
 * test run itself. This analyzer closes that gap statically — it never
 * executes project code and never calls a model.
 *
 * A source file counts as covered when at least one test file either
 *   1. imports/requires it (the import specifier is resolved against the
 *      test file's directory), or
 *   2. is its path pair: `src/foo.ts` ↔ `src/foo.test.ts`, or the mirror
 *      layout `tests/src/foo.test.ts`.
 *
 * Honesty rules, shared with the rest of the verification pipeline:
 * - This is file-level coverage, not line/branch coverage.
 * - A test file that merely shares a name stem in an unrelated directory
 *   does not count as coverage without an import or a path pairing.
 * - Skipped test declarations are counted separately and never inflate
 *   the declared-test total used as evidence.
 */
export class TestCoverageAnalyzer {
  /** Coverage goal from the architecture blueprint's testing strategy. */
  static readonly DEFAULT_GOAL_PERCENT = 85;

  private static readonly CODE_FILE = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i;
  private static readonly TEST_NAME = /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i;

  static isTestFile(filePath: string): boolean {
    const p = filePath.replace(/\\/g, '/');
    if (this.TEST_NAME.test(p)) return true;
    return /(^|\/)(tests?|__tests__)\//.test(p) && this.CODE_FILE.test(p);
  }

  static isTestableSourceFile(filePath: string): boolean {
    const p = filePath.replace(/\\/g, '/');
    if (!this.CODE_FILE.test(p)) return false;
    if (this.isTestFile(p)) return false;
    if (/\.d\.ts$/i.test(p)) return false;
    if (/(^|\/)[^/]*\.config\.(ts|js|mts|cts|mjs|cjs)$/i.test(p)) return false;
    if (p.includes('node_modules/')) return false;
    return true;
  }

  /** Strip a known code extension, e.g. `src/foo.ts` -> `src/foo`. */
  private static stripExtension(filePath: string): string {
    return filePath.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i, '');
  }

  /** Strip `.test`/`.spec` plus extension, e.g. `tests/foo.test.ts` -> `tests/foo`. */
  private static stripTestSuffix(filePath: string): string {
    return filePath.replace(/\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i, '');
  }

  /** Resolve a relative import specifier against the importing file's directory. */
  private static resolveImport(fromPath: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const parts = fromPath.replace(/\\/g, '/').split('/');
    parts.pop(); // drop the file name, keep its directory
    for (const seg of specifier.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return this.stripExtension(parts.join('/'));
  }

  private static importSpecifiers(content: string): string[] {
    const specs: string[] = [];
    const re = /(?:from\s+|require\s*\(\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      specs.push(m[1]);
    }
    return specs;
  }

  private static countDeclaredTests(content: string): { declared: number; skipped: number } {
    const skipped = (content.match(/\b(?:test|it)\.skip\s*\(/g) || []).length;
    const declared = (content.match(/\b(?:test|it)(?:\.skip)?\s*\(\s*['"`]/g) || []).length;
    return { declared, skipped };
  }

  static analyzeProject(
    files: ProjectFile[],
    goalPercent: number = TestCoverageAnalyzer.DEFAULT_GOAL_PERCENT
  ): TestCoverageReport {
    const testFiles = files.filter(f => this.isTestFile(f.path));
    const sourceFiles = files.filter(f => this.isTestableSourceFile(f.path));

    // Pre-compute, per test file, the set of source module paths it imports
    // and its path-pair target.
    const testInfo = testFiles.map(tf => {
      const importedModules = new Set<string>();
      for (const spec of this.importSpecifiers(tf.content)) {
        const resolved = this.resolveImport(tf.path, spec);
        if (resolved) importedModules.add(resolved);
      }
      return {
        path: tf.path.replace(/\\/g, '/'),
        pairTarget: this.stripTestSuffix(tf.path.replace(/\\/g, '/')),
        importedModules
      };
    });

    let declaredTests = 0;
    let skippedTests = 0;
    for (const tf of testFiles) {
      const counts = this.countDeclaredTests(tf.content);
      declaredTests += counts.declared;
      skippedTests += counts.skipped;
    }

    const perFile: TestCoverageReport['perFile'] = [];
    const uncoveredSourceFiles: string[] = [];

    for (const sf of sourceFiles) {
      const cleanPath = sf.path.replace(/\\/g, '/');
      const modulePath = this.stripExtension(cleanPath);
      const coveredBy: string[] = [];

      for (const ti of testInfo) {
        const importsIt = ti.importedModules.has(modulePath);
        // Path pairing: co-located pair (src/foo.test.ts) or the mirror
        // layout where the test tree repeats the source path (tests/src/foo.test.ts).
        const pairIt =
          ti.pairTarget === modulePath ||
          ti.pairTarget === `tests/${modulePath}` ||
          ti.pairTarget === `test/${modulePath}`;
        if (importsIt || pairIt) {
          coveredBy.push(ti.path);
        }
      }

      perFile.push({ path: cleanPath, coveredBy });
      if (coveredBy.length === 0) {
        uncoveredSourceFiles.push(cleanPath);
      }
    }

    const totalSourceFiles = sourceFiles.length;
    const coveredSourceFiles = totalSourceFiles - uncoveredSourceFiles.length;
    const coveragePercent =
      totalSourceFiles > 0 ? Math.round((coveredSourceFiles / totalSourceFiles) * 100) : 0;

    return {
      totalSourceFiles,
      coveredSourceFiles,
      uncoveredSourceFiles,
      coveragePercent,
      goalPercent,
      goalMet: totalSourceFiles > 0 && coveragePercent >= goalPercent,
      testFileCount: testFiles.length,
      declaredTests,
      skippedTests,
      perFile,
      method: 'file_level_static_analysis'
    };
  }
}
