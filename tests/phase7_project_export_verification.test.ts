import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { 
  buildProjectZipBlob, 
  validateArchivePath, 
  detectProjectStack, 
  extractEnvironmentVariables, 
  generateDockerConfig,
  generateEnvExampleContent
} from '../src/utils/zipExporter.js';
import { Build, ProjectFile } from '../src/types/index.js';

describe('Phase 7 Deep Project Export ZIP Verification Suite', () => {
  const dummyBuild: Build = {
    id: 'build_phase7_export',
    userId: 'user_tester',
    idea: 'Production Multi-Stack Application',
    status: 'completed',
    selectedModels: ['gemini-2.5-pro'],
    autoPushGithub: false,
    costLimit: 5,
    totalTokens: 1000,
    totalCost: 0.01,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxDurationSeconds: 300,
    patchesAppliedCount: 3,
    techStack: {
      frontend: 'React 19 + TypeScript',
      backend: 'Express Node.js',
      database: 'SQLite',
      testing: 'Node.js test runner',
      security: 'Strict'
    }
  };

  test('1. Valid archive structure and exact file contents preservation', async () => {
    const files: ProjectFile[] = [
      {
        path: 'src/main.ts',
        content: 'export const run = () => "squadforge_phase7_test_string";',
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        path: 'public/locales/en.json',
        content: JSON.stringify({ welcome: 'Hello World', count: 42 }),
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        path: 'docs/architecture/overview.md',
        content: '# System Overview\n\n- Component A\n- Component B\n',
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    const { blob, fileCount } = await buildProjectZipBlob(dummyBuild, files, {
      includeSetupGuide: true,
      includeEnvExample: true,
      includeDockerConfig: true,
      includeGitignore: true
    });

    assert.ok(blob, 'Blob must be created');
    assert.ok(fileCount >= 3, 'Must contain all source files plus accessories');

    // Load actual ZIP archive contents
    const zip = await JSZip.loadAsync(blob);

    // Verify exact content of every source file
    const mainContent = await zip.file('src/main.ts')?.async('string');
    assert.equal(mainContent, 'export const run = () => "squadforge_phase7_test_string";');

    const jsonContent = await zip.file('public/locales/en.json')?.async('string');
    assert.deepEqual(JSON.parse(jsonContent!), { welcome: 'Hello World', count: 42 });

    const mdContent = await zip.file('docs/architecture/overview.md')?.async('string');
    assert.equal(mdContent, '# System Overview\n\n- Component A\n- Component B\n');

    // Verify no paths start with leading slashes or contain traversal
    zip.forEach((relativePath) => {
      assert.equal(relativePath.startsWith('/'), false, `ZIP path "${relativePath}" must not start with /`);
      assert.equal(relativePath.includes('..'), false, `ZIP path "${relativePath}" must not contain ..`);
    });
  });

  test('2. Path traversal rejection protects archive extraction', async () => {
    const malicious = [
      '../../../../etc/shadow',
      '../outside.txt',
      'nested/../../escaped.js',
      'C:\\autoexec.bat',
      'D:/secret/file.txt',
      'src\\..\\..\\hacked.ts',
      'foo\0bar.txt',
      '/absolute/path/file.txt'
    ];

    for (const badPath of malicious) {
      const res = validateArchivePath(badPath);
      // Either invalid or sanitized safely without escaping
      if (res.valid) {
        assert.equal(res.normalizedPath.includes('..'), false);
        assert.equal(res.normalizedPath.startsWith('/'), false);
        assert.equal(/^[a-zA-Z]:/.test(res.normalizedPath), false);
      } else {
        assert.ok(res.error, `Path "${badPath}" should produce an error`);
      }
    }
  });

  test('3. Secret exclusion: Real secret environment files are NEVER packed into the ZIP', async () => {
    const filesWithSecrets: ProjectFile[] = [
      {
        path: 'src/config.ts',
        content: 'export const config = {};',
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        path: '.env',
        content: 'SECRET_DB_PASSWORD=ultra_secret_pw_12345\nAWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE\n',
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        path: '.env.production',
        content: 'PROD_TOKEN=prod_token_xyz987\n',
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        path: '.env.local',
        content: 'LOCAL_KEY=local_key_abc\n',
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    const { blob } = await buildProjectZipBlob(dummyBuild, filesWithSecrets);
    const zip = await JSZip.loadAsync(blob);

    // Verify secret files do NOT exist in the ZIP
    assert.equal(zip.file('.env'), null, '.env must not exist in ZIP');
    assert.equal(zip.file('.env.production'), null, '.env.production must not exist in ZIP');
    assert.equal(zip.file('.env.local'), null, '.env.local must not exist in ZIP');

    // Verify that the generated .env.example DOES exist and has NO real secret values
    const exampleContent = await zip.file('.env.example')?.async('string');
    assert.ok(exampleContent, '.env.example must be generated');
    assert.equal(exampleContent!.includes('ultra_secret_pw_12345'), false);
    assert.equal(exampleContent!.includes('AKIAIOSFODNN7EXAMPLE'), false);
    assert.equal(exampleContent!.includes('prod_token_xyz987'), false);
  });

  test('4. Environment variable intelligence scans code and documents variables', async () => {
    const files: ProjectFile[] = [
      {
        path: 'server/api.ts',
        content: `
          const geminiKey = process.env.GEMINI_API_KEY;
          const openRouterKey = process.env.OPENROUTER_API_KEY;
          const port = process.env.PORT || 3000;
          const appUrl = process.env.APP_URL;
        `,
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    const { blob } = await buildProjectZipBlob(dummyBuild, files);
    const zip = await JSZip.loadAsync(blob);

    const envExample = await zip.file('.env.example')?.async('string');
    assert.ok(envExample);
    assert.match(envExample!, /GEMINI_API_KEY=/);
    assert.match(envExample!, /OPENROUTER_API_KEY=/);
    assert.match(envExample!, /PORT=/);
    assert.match(envExample!, /APP_URL=/);
    assert.match(envExample!, /Google Gemini API key/i);
    assert.match(envExample!, /OpenRouter/i);
  });

  test('5. Multi-stack detection and Dockerfile / compose accuracy', async () => {
    // 5A: React + Vite SPA
    const viteFiles: ProjectFile[] = [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'vite-app',
          devDependencies: { vite: '^5.0.0', '@vitejs/plugin-react': '^4.0.0' },
          scripts: { dev: 'vite', build: 'vite build' }
        }),
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        path: 'vite.config.ts',
        content: 'import { defineConfig } from "vite"; export default defineConfig({});',
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    const viteRes = await buildProjectZipBlob(dummyBuild, viteFiles);
    assert.equal(viteRes.stack, 'react-vite');
    const viteZip = await JSZip.loadAsync(viteRes.blob);
    const viteDocker = await viteZip.file('Dockerfile')?.async('string');
    assert.match(viteDocker!, /FROM node:22-alpine/);
    assert.match(viteDocker!, /5173/);

    // 5B: Next.js Fullstack
    const nextFiles: ProjectFile[] = [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'next-app',
          dependencies: { next: '14.2.0', react: '18.2.0' },
          scripts: { dev: 'next dev', build: 'next build' }
        }),
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        path: 'next.config.js',
        content: 'module.exports = {};',
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    const nextRes = await buildProjectZipBlob(dummyBuild, nextFiles);
    assert.equal(nextRes.stack, 'nextjs');
    const nextZip = await JSZip.loadAsync(nextRes.blob);
    const nextDocker = await nextZip.file('Dockerfile')?.async('string');
    assert.match(nextDocker!, /Next\.js/);
    assert.match(nextDocker!, /npm.*run.*dev/);

    // 5C: Python Django
    const djangoFiles: ProjectFile[] = [
      {
        path: 'requirements.txt',
        content: 'Django==5.0.3\npsycopg2-binary==2.9.9\n',
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        path: 'manage.py',
        content: '#!/usr/bin/env python\nimport os\n',
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    const djangoRes = await buildProjectZipBlob(dummyBuild, djangoFiles);
    assert.equal(djangoRes.stack, 'python-django');
    const djangoZip = await JSZip.loadAsync(djangoRes.blob);
    const djangoDocker = await djangoZip.file('Dockerfile')?.async('string');
    assert.match(djangoDocker!, /FROM python:3\.11-slim/);
    assert.match(djangoDocker!, /python.*manage\.py.*runserver/);
    assert.doesNotMatch(djangoDocker!, /node:/i);

    // 5D: Static Web
    const staticFiles: ProjectFile[] = [
      {
        path: 'index.html',
        content: '<!DOCTYPE html><html><body><h1>Portfolio</h1></body></html>',
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        path: 'styles.css',
        content: 'body { font-family: sans-serif; }',
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    const staticRes = await buildProjectZipBlob(dummyBuild, staticFiles);
    assert.equal(staticRes.stack, 'static-web');
    const staticZip = await JSZip.loadAsync(staticRes.blob);
    const staticDocker = await staticZip.file('Dockerfile')?.async('string');
    assert.match(staticDocker!, /FROM nginx:alpine/);
    assert.match(staticDocker!, /usr\/share\/nginx\/html/);
  });

  test('6. Missing package scripts falls back gracefully without inventing commands', () => {
    const noScriptPkg: ProjectFile[] = [
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'bare-pkg', dependencies: { express: '4.19.0' } }),
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    const stack = detectProjectStack(noScriptPkg);
    assert.equal(stack.type, 'node-express');
    assert.equal(stack.devCommand, 'node server.js');
  });

  test('7. Large project handling preserves 50+ nested files efficiently', async () => {
    const largeFileList: ProjectFile[] = [];
    for (let i = 1; i <= 60; i++) {
      largeFileList.push({
        path: `src/modules/module_${i}/service_${i}.ts`,
        content: `export const service_${i} = { id: ${i}, execute: () => "result_${i}" };\n`,
        version: 1,
        ownerModel: 'gemini',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    const { blob, fileCount } = await buildProjectZipBlob(dummyBuild, largeFileList);
    assert.ok(blob.size > 0);
    assert.ok(fileCount >= 60);

    const zip = await JSZip.loadAsync(blob);
    const file37 = await zip.file('src/modules/module_37/service_37.ts')?.async('string');
    assert.match(file37!, /result_37/);
  });
});
