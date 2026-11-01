import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionAdapter } from '../server/swarm/executionAdapter.js';
import { ProjectFile } from '../server/types.js';

describe('Project-Aware TypeScript Compiler Verification (Phase 2 & 7)', () => {
  test('1. Strict type errors are captured with exact line and column diagnostics', async () => {
    const files: ProjectFile[] = [
      {
        path: 'tsconfig.json',
        content: JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            noImplicitAny: true,
            strictNullChecks: true
          }
        }),
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      },
      {
        path: 'src/app.ts',
        content: `
          export function greet(name: string): string {
            let count: number = "not-a-number";
            return name + count;
          }
        `,
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    ];

    const report = await ExecutionAdapter.runTypeCheck(files);
    assert.equal(report.passed, false);
    assert.equal(report.status, 'failed');
    assert.ok(report.errors.length > 0);
    assert.ok(report.typeErrors.length > 0);
    
    // Check diagnostic details
    const typeErr = report.typeErrors[0];
    assert.ok(typeErr.code.startsWith('TS'));
    assert.ok(typeErr.message.includes("Type 'string' is not assignable to type 'number'"));
    assert.equal(typeErr.filePath, 'src/app.ts');
    assert.ok(typeErr.line > 0);
  });

  test('2. Valid React and TSX projects pass type checking cleanly', async () => {
    const files: ProjectFile[] = [
      {
        path: 'tsconfig.json',
        content: JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            jsx: 'react-jsx',
            strict: true
          }
        }),
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      },
      {
        path: 'src/components/Card.tsx',
        content: `
          import React from 'react';

          interface CardProps {
            title: string;
            count?: number;
          }

          export const Card: React.FC<CardProps> = ({ title, count = 0 }) => {
            return (
              <div className="card">
                <h2>{title}</h2>
                <span>{count}</span>
              </div>
            );
          };
        `,
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    ];

    const report = await ExecutionAdapter.runTypeCheck(files);
    assert.equal(report.passed, true);
    assert.equal(report.status, 'passed');
    assert.equal(report.errors.length, 0);
    assert.equal(report.typeErrors.length, 0);
    assert.equal(report.syntaxErrors.length, 0);
    assert.equal(report.configErrors.length, 0);
  });

  test('3. Missing relative imports are identified as diagnostic errors', async () => {
    const files: ProjectFile[] = [
      {
        path: 'tsconfig.json',
        content: JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true
          }
        }),
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      },
      {
        path: 'src/main.ts',
        content: `
          import { NonExistentService } from './services/missing.js';
          export const s = new NonExistentService();
        `,
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    ];

    const report = await ExecutionAdapter.runTypeCheck(files);
    assert.equal(report.passed, false);
    assert.equal(report.status, 'failed');
    assert.ok(report.errors.some(e => e.message.includes('Cannot find module')));
  });

  test('4. Controlled package imports resolve from host dependency environment', async () => {
    const files: ProjectFile[] = [
      {
        path: 'tsconfig.json',
        content: JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true
          }
        }),
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      },
      {
        path: 'src/server.ts',
        content: `
          import express, { Request, Response } from 'express';
          const app = express();
          app.get('/health', (req: Request, res: Response) => {
            res.json({ ok: true });
          });
          export { app };
        `,
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    ];

    const report = await ExecutionAdapter.runTypeCheck(files);
    assert.equal(report.passed, true);
    assert.equal(report.status, 'passed');
    assert.equal(report.errors.length, 0);
  });

  test('5. tsconfig path aliases (@/* -> src/*) are properly respected', async () => {
    const files: ProjectFile[] = [
      {
        path: 'tsconfig.json',
        content: JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            baseUrl: '.',
            paths: {
              '@/*': ['src/*']
            },
            strict: true
          }
        }),
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      },
      {
        path: 'src/utils/math.ts',
        content: 'export const double = (n: number): number => n * 2;'
      },
      {
        path: 'src/index.ts',
        content: `
          import { double } from '@/utils/math.js';
          export const result: number = double(21);
        `
      }
    ].map(f => ({
      ...f,
      version: 1,
      ownerModel: 'test',
      history: [],
      createdAt: 1000,
      updatedAt: 1000
    }));

    const report = await ExecutionAdapter.runTypeCheck(files);
    assert.equal(report.passed, true);
    assert.equal(report.status, 'passed');
    assert.equal(report.errors.length, 0);
  });

  test('6. Invalid tsconfig files report configuration errors without crashing', async () => {
    const files: ProjectFile[] = [
      {
        path: 'tsconfig.json',
        content: '{ "compilerOptions": { "strict": true, unquoted_bad_json } }',
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      },
      {
        path: 'src/index.ts',
        content: 'export const a: number = 10;',
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    ];

    const report = await ExecutionAdapter.runTypeCheck(files);
    assert.equal(report.passed, false);
    assert.equal(report.status, 'failed');
    assert.ok(report.configErrors.length > 0);
    assert.ok(report.configErrors.some(e => e.filePath === 'tsconfig.json'));
  });

  test('7. Projects without TypeScript report status as skipped and passed as false', async () => {
    const files: ProjectFile[] = [
      {
        path: 'src/script.js',
        content: 'function hello() { return "world"; }',
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      },
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'js-project' }),
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    ];

    const report = await ExecutionAdapter.runTypeCheck(files);
    assert.equal(report.passed, false, 'Never report a skipped check as passed');
    assert.equal(report.status, 'skipped');
    assert.ok(report.skipReason?.includes('No TypeScript'));
    assert.equal(report.errors.length, 0);
  });

  test('8. Declaration files (.d.ts) are recognized and resolve ambient types', async () => {
    const files: ProjectFile[] = [
      {
        path: 'tsconfig.json',
        content: JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true
          }
        }),
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      },
      {
        path: 'src/types/custom.d.ts',
        content: `
          declare module 'custom-virtual-sdk' {
            export function authenticateUser(token: string): boolean;
          }
        `,
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      },
      {
        path: 'src/auth.ts',
        content: `
          import { authenticateUser } from 'custom-virtual-sdk';
          export const isValid: boolean = authenticateUser('secret-token');
        `,
        version: 1,
        ownerModel: 'test',
        history: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    ];

    const report = await ExecutionAdapter.runTypeCheck(files);
    assert.equal(report.passed, true);
    assert.equal(report.status, 'passed');
    assert.equal(report.errors.length, 0);
  });
});
