import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionAdapter } from '../server/swarm/executionAdapter.js';
import { ProjectFile } from '../server/types.js';

describe('Phase 3: Project-Aware TypeScript Verification', () => {
  // Helper to make mock ProjectFile items
  const makeFile = (filePath: string, content: string): ProjectFile => ({
    path: filePath,
    content,
    version: 1,
    ownerModel: 'test-agent',
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  test('1. Valid TypeScript project: passes type checking cleanly', async () => {
    const files = [
      makeFile('tsconfig.json', JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true
        }
      })),
      makeFile('src/math.ts', `
        export function add(a: number, b: number): number {
          return a + b;
        }
      `),
      makeFile('src/index.ts', `
        import { add } from './math.js';
        export const total: number = add(10, 20);
      `)
    ];

    const report = ExecutionAdapter.runTypeCheck(files);
    assert.strictEqual(report.status, 'passed');
    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.errors.length, 0);
    assert.strictEqual(report.typeErrors?.length, 0);
    assert.strictEqual(report.syntaxErrors?.length, 0);
  });

  test('2. Invalid TypeScript types: reports structured type diagnostic', async () => {
    const files = [
      makeFile('tsconfig.json', JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true }
      })),
      makeFile('src/bad_type.ts', `
        const num: number = "this is a string";
        export { num };
      `)
    ];

    const report = ExecutionAdapter.runTypeCheck(files);
    assert.strictEqual(report.status, 'failed');
    assert.strictEqual(report.passed, false);
    assert.ok(report.errors.length > 0);
    assert.ok(report.typeErrors && report.typeErrors.length > 0);

    const err = report.typeErrors![0];
    assert.strictEqual(err.filePath, 'src/bad_type.ts');
    assert.ok(err.line && err.line > 0);
    assert.ok(err.column && err.column > 0);
    assert.ok(err.code.startsWith('TS'));
    assert.ok(err.message.includes("Type 'string' is not assignable to type 'number'"));
  });

  test('3. Syntax errors: reports syntax error diagnostics', async () => {
    const files = [
      makeFile('tsconfig.json', JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' }
      })),
      makeFile('src/broken_syntax.ts', `
        export const badFunc = ( {
          return 42;
      `)
    ];

    const report = ExecutionAdapter.runTypeCheck(files);
    assert.strictEqual(report.status, 'failed');
    assert.strictEqual(report.passed, false);
    assert.ok(report.syntaxErrors && report.syntaxErrors.length > 0);
    assert.strictEqual(report.syntaxErrors![0].filePath, 'src/broken_syntax.ts');
  });

  test('4. Valid path aliases: resolves baseUrl and paths mapping cleanly', async () => {
    const files = [
      makeFile('tsconfig.json', JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          baseUrl: '.',
          paths: {
            '@components/*': ['src/components/*']
          },
          strict: true
        }
      })),
      makeFile('src/components/Button.ts', `
        export interface ButtonConfig { label: string; onClick: () => void; }
        export const createButton = (cfg: ButtonConfig) => cfg.label;
      `),
      makeFile('src/index.ts', `
        import { createButton } from '@components/Button.js';
        export const btn = createButton({ label: 'Submit', onClick: () => {} });
      `)
    ];

    const report = ExecutionAdapter.runTypeCheck(files);
    assert.strictEqual(report.status, 'passed');
    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.errors.length, 0);
  });

  test('5. Invalid path aliases: detects missing alias target', async () => {
    const files = [
      makeFile('tsconfig.json', JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          baseUrl: '.',
          paths: {
            '@components/*': ['src/components/*']
          }
        }
      })),
      makeFile('src/index.ts', `
        import { NonExistent } from '@components/DoesNotExist.js';
        export const val = NonExistent;
      `)
    ];

    const report = ExecutionAdapter.runTypeCheck(files);
    assert.strictEqual(report.status, 'failed');
    assert.strictEqual(report.passed, false);
    assert.ok(report.errors.some(e => e.message.includes('Cannot find module')));
  });

  test('6. Missing package imports: detects TS2307 and populates missingDependencies', async () => {
    const files = [
      makeFile('tsconfig.json', JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' }
      })),
      makeFile('src/client.ts', `
        import axios from 'non-existent-axios-package-12345';
        export const fetcher = axios;
      `)
    ];

    const report = ExecutionAdapter.runTypeCheck(files);
    assert.strictEqual(report.status, 'failed');
    assert.strictEqual(report.passed, false);
    assert.ok(report.missingDependencies && report.missingDependencies.length > 0);
    assert.ok(report.missingDependencies!.includes('non-existent-axios-package-12345'));
  });

  test('7. JSX and TSX: type checks React JSX syntax properly', async () => {
    const files = [
      makeFile('tsconfig.json', JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          jsx: 'react-jsx',
          strict: true
        }
      })),
      makeFile('src/App.tsx', `
        import React from 'react';

        interface HeaderProps {
          title: string;
        }

        export const Header: React.FC<HeaderProps> = ({ title }) => {
          return <h1>{title}</h1>;
        };
      `)
    ];

    const report = ExecutionAdapter.runTypeCheck(files);
    assert.strictEqual(report.status, 'passed');
    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.errors.length, 0);
  });

  test('8. Strict compiler options: enforces strictNullChecks and noImplicitAny', async () => {
    const files = [
      makeFile('tsconfig.json', JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noImplicitAny: true
        }
      })),
      makeFile('src/implicit.ts', `
        export function processItem(item) {
          return item;
        }
      `)
    ];

    const report = ExecutionAdapter.runTypeCheck(files);
    assert.strictEqual(report.status, 'failed');
    assert.strictEqual(report.passed, false);
    assert.ok(report.errors.some(e => e.message.includes('implicitly has an \'any\' type')));
  });

  test('9. Declaration files (.d.ts): recognizes ambient declarations', async () => {
    const files = [
      makeFile('tsconfig.json', JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true }
      })),
      makeFile('src/types/globals.d.ts', `
        declare interface CustomConfig {
          env: string;
          debug: boolean;
        }
      `),
      makeFile('src/config.ts', `
        export const appConfig: CustomConfig = {
          env: 'production',
          debug: false
        };
      `)
    ];

    const report = ExecutionAdapter.runTypeCheck(files);
    assert.strictEqual(report.status, 'passed');
    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.errors.length, 0);
  });

  test('10. Mixed JavaScript and TypeScript: allowJs compiles without errors', async () => {
    const files = [
      makeFile('tsconfig.json', JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          allowJs: true,
          strict: false
        }
      })),
      makeFile('src/helper.js', `
        export function multiply(a, b) {
          return a * b;
        }
      `),
      makeFile('src/main.ts', `
        import { multiply } from './helper.js';
        export const product = multiply(6, 7);
      `)
    ];

    const report = ExecutionAdapter.runTypeCheck(files);
    assert.strictEqual(report.status, 'passed');
    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.errors.length, 0);
  });

  test('11. Invalid tsconfig: handles malformed JSON with configErrors', async () => {
    const files = [
      makeFile('tsconfig.json', '{ "compilerOptions": { bad_json: true, } }'),
      makeFile('src/app.ts', 'export const a: number = 1;')
    ];

    const report = ExecutionAdapter.runTypeCheck(files);
    assert.strictEqual(report.status, 'failed');
    assert.strictEqual(report.passed, false);
    assert.ok(report.configErrors && report.configErrors.length > 0);
    assert.strictEqual(report.configErrors![0].filePath, 'tsconfig.json');
  });

  test('12. No TypeScript source files: returns skipped with passed: false', async () => {
    const files = [
      makeFile('README.md', '# Documentation only'),
      makeFile('index.html', '<!DOCTYPE html><html><body>Test</body></html>')
    ];

    const report = ExecutionAdapter.runTypeCheck(files);
    assert.strictEqual(report.status, 'skipped');
    assert.strictEqual(report.passed, false, 'Skipped check must report passed as false');
    assert.ok(report.skipReason?.includes('No TypeScript'));
    assert.strictEqual(report.errors.length, 0);
  });

  test('13. Compiler timeout or file size execution safety: enforces size limit gracefully', async () => {
    // Generate file that exceeds MAX_FILE_SIZE_BYTES (500 KB)
    const largeContent = 'const x = 1;\n'.repeat(40000); // ~520 KB
    const files = [
      makeFile('src/giant.ts', largeContent)
    ];

    const report = ExecutionAdapter.runTypeCheck(files);
    assert.strictEqual(report.status, 'failed');
    assert.strictEqual(report.passed, false);
    assert.ok(report.errors.some(e => e.code === 'TS_SIZE_LIMIT'));
  });

  test('14. Temporary workspace cleanup: removes temp directory after check', async () => {
    const buildId = `cleanup_test_${Date.now()}`;
    const files = [
      makeFile('src/clean.ts', 'export const ok = true;')
    ];

    const beforeTempDirs = fs.readdirSync(os.tmpdir()).filter(d => d.includes(buildId));
    assert.strictEqual(beforeTempDirs.length, 0);

    const report = ExecutionAdapter.runTypeCheck(buildId, files);
    assert.strictEqual(report.status, 'passed');

    // Confirm sandbox temp dir was cleaned up
    const afterTempDirs = fs.readdirSync(os.tmpdir()).filter(d => d.includes(buildId));
    assert.strictEqual(afterTempDirs.length, 0, 'Temporary sandbox directory must be completely removed');
  });
});
