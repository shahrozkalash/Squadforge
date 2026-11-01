import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionAdapter } from '../server/swarm/executionAdapter.js';
import { ProjectFile } from '../server/types.js';

describe('SquadForge Isolated Execution Adapter & Verification Subsystem', () => {
  test('Path traversal sanitization rejects dangerous patterns', () => {
    assert.equal(ExecutionAdapter.sanitizeFilePath('../../etc/passwd').valid, false);
    assert.equal(ExecutionAdapter.sanitizeFilePath('../secret.env').valid, false);
    assert.equal(ExecutionAdapter.sanitizeFilePath('foo/../../../bar').valid, false);
    assert.equal(ExecutionAdapter.sanitizeFilePath('valid/path/file.ts\0.exe').valid, false);

    const validResult = ExecutionAdapter.sanitizeFilePath('src/components/Button.tsx');
    assert.equal(validResult.valid, true);
    assert.equal(validResult.cleanPath, 'src/components/Button.tsx');
  });

  test('Validates TypeScript and JavaScript syntax using genuine esbuild compiler', () => {
    const validFiles: ProjectFile[] = [
      {
        path: 'src/math.ts',
        content: 'export function add(a: number, b: number): number { return a + b; }',
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    ];

    const validErrors = ExecutionAdapter.validateSyntax(validFiles);
    assert.equal(validErrors.length, 0, 'Valid TypeScript must produce 0 syntax errors');

    const brokenFiles: ProjectFile[] = [
      {
        path: 'src/broken.ts',
        content: 'function broken() { if (true) { console.log("missing closing brace");',
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    ];

    const brokenErrors = ExecutionAdapter.validateSyntax(brokenFiles);
    assert.ok(brokenErrors.length > 0, 'Syntax error must be detected');
    assert.equal(brokenErrors[0].filePath, 'src/broken.ts');
  });

  test('Detects merge conflict markers in source files', () => {
    const conflictFiles: ProjectFile[] = [
      {
        path: 'src/conflict.ts',
        content: `export const value = 1;
<<<<<<< HEAD
export const branch = 'main';
=======
export const branch = 'feature';
>>>>>>> feature`,
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    ];

    const errors = ExecutionAdapter.validateSyntax(conflictFiles);
    assert.ok(errors.some(e => e.message.includes('conflict markers')));
  });

  test('Security auditor flags exposed secrets, eval, and command injection', () => {
    const secFiles: ProjectFile[] = [
      {
        path: 'src/insecure.ts',
        content: `
          const apiKey = "sk-1234567890abcdef1234567890abcdef";
          const fn = eval("2 + 2");
        `,
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    ];

    const audit = ExecutionAdapter.auditSecurity(secFiles);
    assert.equal(audit.passed, false);
    assert.ok(audit.findings.some(f => f.message.includes('Hardcoded API secret')));
    assert.ok(audit.findings.some(f => f.message.includes('eval()')));
    assert.ok(audit.score < 50);
  });

  test('Validates package.json configuration', () => {
    const invalidPkg: ProjectFile[] = [
      {
        path: 'package.json',
        content: '{ "dependencies": {} }', // missing name
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    ];

    const errors = ExecutionAdapter.validateConfigs(invalidPkg);
    assert.ok(errors.some(e => e.includes('name')));
  });

  test('Complete verification returns structured report with true evidence', () => {
    const files: ProjectFile[] = [
      {
        path: 'src/utils.ts',
        content: 'export const greet = (name: string) => `Hello, ${name}!`;',
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      },
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'my-app', version: '1.0.0' }),
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    ];

    const result = ExecutionAdapter.runCompleteVerification('test_build_ver', files);
    assert.equal(result.passed, true);
    assert.equal(result.syntaxErrors.length, 0);
    assert.equal(result.securityAudit.passed, true);
    assert.ok(result.summary.includes('passed'));
  });

  test('Distinguishes valid syntax from real TypeScript type errors', () => {
    // Valid JS/TS syntax, but illegal TypeScript type assignment
    const typeErrorFiles: ProjectFile[] = [
      {
        path: 'src/badTypes.ts',
        content: 'export const calculate = (val: number): string => { const res: number = "not_a_number"; return String(val); };',
        version: 1,
        history: []
      }
    ];

    // 1. Syntax check passes because AST is syntactically valid TypeScript
    const syntaxErrors = ExecutionAdapter.validateSyntax(typeErrorFiles);
    assert.equal(syntaxErrors.length, 0, 'Syntax validation must pass for syntactically legal code');

    // 2. Real TypeScript compiler check detects genuine TS2322 type error
    const typeReport = ExecutionAdapter.runTypeCheck('test_type_err_build', typeErrorFiles);
    assert.equal(typeReport.status, 'failed', 'Type check status must be failed');
    assert.equal(typeReport.passed, false, 'Type check passed flag must be false');
    assert.ok(typeReport.errors.length > 0, 'Must record diagnostic errors');

    const ts2322 = typeReport.errors.find(e => e.code === 'TS2322');
    assert.ok(ts2322, 'Must capture exact TS2322 diagnostic code');
    assert.equal(ts2322?.filePath, 'src/badTypes.ts');
    assert.ok(ts2322?.line && ts2322.line >= 1);
    assert.ok(ts2322?.message.includes("Type 'string' is not assignable to type 'number'"));
  });

  test('Reports skipped status without falsely claiming passed when no TS files exist', () => {
    const htmlOnlyFiles: ProjectFile[] = [
      {
        path: 'index.html',
        content: '<!DOCTYPE html><html><body><h1>Hello</h1></body></html>',
        version: 1,
        history: []
      }
    ];

    const typeReport = ExecutionAdapter.runTypeCheck('test_no_ts_build', htmlOnlyFiles);
    assert.equal(typeReport.status, 'skipped');
    assert.equal(typeReport.passed, false, 'Never report type checking as passed when it was skipped');
    assert.ok(typeReport.skipReason?.includes('No TypeScript'));
  });

  test('Defers type checking and reports skipped when fatal syntax errors exist', () => {
    const brokenFiles: ProjectFile[] = [
      {
        path: 'src/broken.ts',
        content: 'function syntaxError( { missing closing brace',
        version: 1,
        history: []
      }
    ];

    const result = ExecutionAdapter.runCompleteVerification('test_syntax_block_build', brokenFiles);
    assert.equal(result.passed, false);
    assert.ok(result.syntaxErrors.length > 0);
    assert.equal(result.typeCheckReport.status, 'skipped');
    assert.equal(result.typeCheckReport.passed, false);
    assert.ok(result.typeCheckReport.skipReason?.includes('Syntax errors must be resolved first'));
  });
});
