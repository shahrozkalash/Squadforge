import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TestCoverageAnalyzer } from '../server/testing/testCoverageAnalyzer.js';
import { ExecutionAdapter } from '../server/swarm/executionAdapter.js';
import { HonestVerificationService } from '../server/verificationService.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { db } from '../server/store.js';

const file = (path: string, content: string) => ({ path, content }) as any;

describe('Phase 12: file-level test coverage analysis', () => {
  test('a source file imported by a test file counts as covered; an unimported one does not', () => {
    const report = TestCoverageAnalyzer.analyzeProject([
      file('src/engine.ts', 'export const run = () => 1;'),
      file('src/util.ts', 'export const help = () => 2;'),
      file('tests/engine.test.ts', `
        import { test } from 'node:test';
        import { run } from '../src/engine';
        test('engine runs', () => { run(); });
      `)
    ]);

    assert.equal(report.totalSourceFiles, 2);
    assert.equal(report.coveredSourceFiles, 1);
    assert.deepEqual(report.uncoveredSourceFiles, ['src/util.ts']);
    assert.equal(report.coveragePercent, 50);
    assert.equal(report.goalPercent, 85);
    assert.equal(report.goalMet, false);
    assert.equal(report.testFileCount, 1);
    assert.equal(report.declaredTests, 1);
    assert.equal(report.skippedTests, 0);
    assert.equal(report.method, 'file_level_static_analysis');
  });

  test('path pairing covers co-located and mirrored test files', () => {
    const report = TestCoverageAnalyzer.analyzeProject([
      file('src/foo.ts', 'export const foo = 1;'),
      file('src/foo.test.ts', `test('foo works', () => {});`),
      file('src/bar.ts', 'export const bar = 1;'),
      file('tests/src/bar.test.ts', `test('bar works', () => {});`)
    ]);

    assert.equal(report.coveredSourceFiles, 2);
    assert.equal(report.coveragePercent, 100);
    assert.equal(report.goalMet, true);
  });

  test('a same-stem test in an unrelated directory does not inflate coverage without an import or pairing', () => {
    const report = TestCoverageAnalyzer.analyzeProject([
      file('src/engine.ts', 'export const run = () => 1;'),
      file('tests/other.test.ts', `
        import { other } from './other';
        test('engine is mentioned in this test name only', () => { other(); });
      `),
      file('tests/other.ts', 'export const other = () => 0;')
    ]);

    assert.equal(report.coveredSourceFiles, 0);
    assert.deepEqual(report.uncoveredSourceFiles, ['src/engine.ts']);
  });

  test('test files, type declarations, and config files are not testable source files', () => {
    const report = TestCoverageAnalyzer.analyzeProject([
      file('src/index.ts', 'export const main = () => 0;'),
      file('src/types.d.ts', 'export type X = number;'),
      file('vite.config.ts', 'export default {};'),
      file('tests/index.test.ts', `import { main } from '../src/index'; test('main', () => { main(); });`),
      file('README.md', '# docs')
    ]);

    assert.equal(report.totalSourceFiles, 1);
    assert.equal(report.coveredSourceFiles, 1);
  });

  test('skipped declarations are counted separately from executed evidence', () => {
    const report = TestCoverageAnalyzer.analyzeProject([
      file('src/a.ts', 'export const a = 1;'),
      file('tests/a.test.ts', `
        import { a } from '../src/a';
        test('a works', () => { a; });
        test.skip('a edge case not yet written', () => {});
      `)
    ]);

    assert.equal(report.declaredTests, 2);
    assert.equal(report.skippedTests, 1);
  });

  test('a caller-supplied goal replaces the 85 percent blueprint default', () => {
    const files = [
      file('src/a.ts', 'export const a = 1;'),
      file('src/b.ts', 'export const b = 1;'),
      file('tests/a.test.ts', `import { a } from '../src/a'; test('a', () => {});`)
    ];
    assert.equal(TestCoverageAnalyzer.analyzeProject(files, 50).goalMet, true);
    assert.equal(TestCoverageAnalyzer.analyzeProject(files).goalMet, false);
  });

  test('an empty project reports zero coverage and does not meet the goal', () => {
    const report = TestCoverageAnalyzer.analyzeProject([]);
    assert.equal(report.totalSourceFiles, 0);
    assert.equal(report.coveragePercent, 0);
    assert.equal(report.goalMet, false);
  });
});

describe('Phase 12: test-output parsing never invents a pass', () => {
  const parse = (ExecutionAdapter as any).parseTestOutput.bind(ExecutionAdapter);

  test('a declared test with no mention in the output is skipped, not passed', () => {
    const results = parse('', '', [
      file('tests/ghost.test.ts', `test('never ran', () => {});`)
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0].passed, false);
    assert.equal(results[0].status, 'skipped');
    assert.match(results[0].message, /No execution evidence/);
  });

  test('a declared test named in clean output still counts as passed by the fallback', () => {
    const results = parse('running never ran ... done', '', [
      file('tests/ghost.test.ts', `test('never ran', () => {});`)
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'passed');
    assert.equal(results[0].passed, true);
  });

  test('TAP output takes precedence over the declaration fallback', () => {
    const results = parse('not ok 1 - real failure\n', '', [
      file('tests/ghost.test.ts', `test('real failure', () => {});`)
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'failed');
    assert.equal(results[0].passed, false);
  });
});

describe('Phase 12: verification report carries coverage evidence', () => {
  const saveBuild = (id: string) => db.saveBuild({
    id,
    userId: 'phase12_user',
    idea: 'Phase 12 Coverage Fixture',
    status: 'completed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selectedModels: ['gemini'],
    autoPushGithub: false,
    totalTokens: 100,
    totalCost: 0.01,
    costLimit: 5,
    maxDurationSeconds: 60,
    patchesAppliedCount: 1
  } as any);

  test('a fully covered project reports goal-met coverage in its verification report', async () => {
    const buildId = 'phase12_covered_build';
    saveBuild(buildId);
    await MergeManager.createFile(buildId, 'agent_dev', {
      action: 'create_file',
      path: 'src/index.ts',
      content: 'export const run = () => true;'
    });
    await MergeManager.createFile(buildId, 'agent_qa', {
      action: 'create_file',
      path: 'tests/index.test.ts',
      content: `import { run } from '../src/index';\ntest('run works', () => { run(); });`
    });

    const report = HonestVerificationService.evaluateProjectReadiness(buildId);
    assert.ok(report.testCoverage, 'report must carry testCoverage');
    assert.equal(report.testCoverage!.totalSourceFiles, 1);
    assert.equal(report.testCoverage!.coveredSourceFiles, 1);
    assert.equal(report.testCoverage!.coveragePercent, 100);
    assert.equal(report.testCoverage!.goalMet, true);

    const check = report.checks.find(c => c.name === 'Automated Test Coverage (file-level)');
    assert.ok(check, 'coverage check item must exist');
    assert.equal(check!.status, 'passed');
    assert.equal(check!.passed, true);
  });

  test('an untested project reports blocked coverage and an unresolved risk, not a silent pass', async () => {
    const buildId = 'phase12_untested_build';
    saveBuild(buildId);
    await MergeManager.createFile(buildId, 'agent_dev', {
      action: 'create_file',
      path: 'src/index.ts',
      content: 'export const run = () => true;'
    });

    const report = HonestVerificationService.evaluateProjectReadiness(buildId);
    assert.ok(report.testCoverage);
    assert.equal(report.testCoverage!.coveragePercent, 0);
    assert.equal(report.testCoverage!.goalMet, false);
    assert.deepEqual(report.testCoverage!.uncoveredSourceFiles, ['src/index.ts']);

    const check = report.checks.find(c => c.name === 'Automated Test Coverage (file-level)');
    assert.ok(check);
    assert.equal(check!.status, 'blocked');
    assert.equal(check!.passed, false);
    assert.ok(report.unresolvedRisks.some(r => r.includes('below the 85% goal') && r.includes('src/index.ts')));
  });
});
