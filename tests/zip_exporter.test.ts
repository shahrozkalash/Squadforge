import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { 
  getSanitizedArchiveName, 
  formatBytes, 
  calculateArchiveStats, 
  formatLocalDevCommands, 
  generateGitignore, 
  generateDockerConfig, 
  generateLocalSetupGuide, 
  buildProjectZipBlob 
} from '../src/utils/zipExporter.js';
import { Build, ProjectFile } from '../src/types/index.js';

describe('SquadForge ZIP Archive & Local Development Exporter', () => {
  const sampleFiles: ProjectFile[] = [
    {
      path: 'src/index.ts',
      content: 'console.log("Hello SquadForge");',
      version: 1,
      ownerModel: 'gemini-2.5-pro',
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    {
      path: 'package.json',
      content: JSON.stringify({ name: 'my-demo', scripts: { dev: 'tsx index.ts' } }),
      version: 1,
      ownerModel: 'claude-3-5-sonnet',
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    {
      path: 'src/styles/main.css',
      content: 'body { margin: 0; background: #000; }',
      version: 1,
      ownerModel: 'gemini-2.5-flash',
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    {
      path: 'tests/index.test.ts',
      content: 'import { test } from "node:test";',
      version: 1,
      ownerModel: 'gpt-4o',
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  ];

  const sampleBuild: Build = {
    id: 'build-zip-123',
    userId: 'user-alpha',
    idea: 'Real-Time Multiplayer Chess with Chat',
    status: 'completed',
    selectedModels: ['gemini-2.5-pro', 'claude-3-5-sonnet'],
    autoPushGithub: false,
    costLimit: 10,
    totalTokens: 15400,
    totalCost: 0.045,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxDurationSeconds: 1800,
    patchesAppliedCount: 5,
    projectType: 'fullstack',
    techStack: {
      frontend: 'React 19 + TypeScript',
      backend: 'Express TypeScript Server',
      database: 'SQLite WAL',
      testing: 'Node.js Test Runner',
      security: 'OWASP Defensive Validation'
    },
    architectureDecisions: [
      {
        id: 'ADR-001',
        title: 'Use WebSocket for Live Game State',
        context: 'Need low latency moves',
        decision: 'Use ws package with heartbeat',
        rationale: 'Avoid polling overhead',
        status: 'accepted',
        timestamp: Date.now()
      }
    ],
    requirementsChecklist: [
      {
        id: 'REQ-1',
        title: 'Board Rendering',
        description: 'Interactive SVG chessboard',
        priority: 'must_have',
        satisfied: true,
        status: 'verified'
      }
    ]
  };

  test('getSanitizedArchiveName creates valid, clean filesystem-safe slugs', () => {
    assert.equal(getSanitizedArchiveName('Real-Time Multiplayer Chess!'), 'real-time-multiplayer-chess');
    assert.equal(getSanitizedArchiveName('   My   Awesome App (2026) '), 'my-awesome-app-2026');
    assert.equal(getSanitizedArchiveName(''), 'squadforge-project');
    assert.equal(getSanitizedArchiveName('---special---chars---'), 'special-chars');
  });

  test('formatBytes formats bytes, KB, and MB accurately', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(1572864), '1.50 MB');
  });

  test('calculateArchiveStats calculates file counts, byte sizes, and category distributions', () => {
    const stats = calculateArchiveStats(sampleFiles);
    assert.equal(stats.totalFiles, 4);
    assert.ok(stats.totalBytes > 0);
    assert.equal(stats.hasPackageJson, true);
    assert.equal(stats.hasReadme, false);
    assert.equal(stats.hasEnvExample, false);
    assert.equal(stats.categories.source, 1); // src/index.ts
    assert.equal(stats.categories.config, 1); // package.json
    assert.equal(stats.categories.styles, 1); // main.css
    assert.equal(stats.categories.tests, 1); // tests/index.test.ts
  });

  test('formatLocalDevCommands outputs clear terminal commands with unpack, install, and run steps', () => {
    const commands = formatLocalDevCommands('chess-game.zip', sampleFiles);
    assert.match(commands, /unzip chess-game\.zip -d \.\/chess-game/);
    assert.match(commands, /cp \.env\.example \.env/);
    assert.match(commands, /npm install/);
    assert.match(commands, /npm run dev/);
  });

  test('generateGitignore includes critical node_modules, .env, and build artifacts', () => {
    const gitignore = generateGitignore();
    assert.match(gitignore, /node_modules\//);
    assert.match(gitignore, /\.env/);
    assert.match(gitignore, /dist\//);
    assert.match(gitignore, /\.DS_Store/);
  });

  test('generateDockerConfig produces turnkey Dockerfile and docker-compose.yml', () => {
    const { dockerfile, dockerCompose } = generateDockerConfig(sampleBuild, sampleFiles);
    assert.match(dockerfile, /FROM node:22-alpine/);
    assert.match(dockerfile, /EXPOSE 3000/);
    assert.match(dockerfile, /CMD\s*\[.*npm.*run.*dev.*\]/);
    assert.match(dockerCompose, /services:/);
    assert.match(dockerCompose, /3000:3000/);
  });

  test('generateLocalSetupGuide includes project specifications, steps, and ADRs', () => {
    const guide = generateLocalSetupGuide(sampleBuild, sampleFiles);
    assert.match(guide, /Real-Time Multiplayer Chess with Chat/);
    assert.match(guide, /npm install/);
    assert.match(guide, /npm run dev/);
    assert.match(guide, /docker compose up --build/);
    assert.match(guide, /ADR-001/);
    assert.match(guide, /Use WebSocket for Live Game State/);
    assert.match(guide, /Board Rendering/);
  });

  test('buildProjectZipBlob generates a valid ZIP Blob containing all source files and local dev assets', async () => {
    const result = await buildProjectZipBlob(sampleBuild, sampleFiles, {
      includeSetupGuide: true,
      includeEnvExample: true,
      includeDockerConfig: true,
      includeGitignore: true,
      includeAdrs: true,
    });

    assert.ok(result.blob);
    assert.ok(result.blob.size > 0);
    assert.equal(result.filename, 'real-time-multiplayer-chess-with-chat.zip');
    // 4 sample files + README.md + LOCAL_SETUP.md + .env.example + .gitignore + Dockerfile + docker-compose.yml + ARCHITECTURE.md = 11
    assert.equal(result.fileCount, 11);
  });

  describe('PHASE 3: Path Security, File Integrity & Resource Limits', () => {
    test('Strict path validation rejects traversal, absolute paths, and dangerous Windows formats', async () => {
      const maliciousPaths = [
        '../etc/passwd',
        '../../root/secret.txt',
        'src/../../escape.js',
        'C:\\Windows\\System32\\cmd.exe',
        'D:/secret.env',
        'src\\..\\..\\malicious.ts',
        'foo\0bar.ts',
        '',
        '   ',
        '.',
        './'
      ];

      for (const p of maliciousPaths) {
        const files: ProjectFile[] = [
          {
            path: p,
            content: 'bad content',
            version: 1,
            ownerModel: 'gemini',
            history: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ];

        await assert.rejects(
          async () => {
            await buildProjectZipBlob(sampleBuild, files);
          },
          (err: Error) => {
            assert.match(err.message, /Security rejection|prohibited|empty/i);
            return true;
          },
          `Should reject malicious path: ${p}`
        );
      }
    });

    test('Duplicate and case-colliding file paths are strictly rejected', async () => {
      const duplicateFiles: ProjectFile[] = [
        {
          path: 'src/App.tsx',
          content: 'export const App = () => 1;',
          version: 1,
          ownerModel: 'gemini',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          path: 'src/App.tsx',
          content: 'export const App = () => 2;',
          version: 2,
          ownerModel: 'claude',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      await assert.rejects(
        async () => {
          await buildProjectZipBlob(sampleBuild, duplicateFiles);
        },
        (err: Error) => {
          assert.match(err.message, /duplicate file path/i);
          return true;
        }
      );

      const caseCollisionFiles: ProjectFile[] = [
        {
          path: 'src/App.tsx',
          content: 'export const App = () => 1;',
          version: 1,
          ownerModel: 'gemini',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          path: 'src/app.tsx',
          content: 'export const App = () => 2;',
          version: 2,
          ownerModel: 'claude',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      await assert.rejects(
        async () => {
          await buildProjectZipBlob(sampleBuild, caseCollisionFiles);
        },
        (err: Error) => {
          assert.match(err.message, /case conflict|path collision/i);
          return true;
        }
      );
    });

    test('Enforces individual file size and total archive limits', async () => {
      const oversizedFile: ProjectFile[] = [
        {
          path: 'large_asset.bin',
          content: 'X'.repeat(2000),
          version: 1,
          ownerModel: 'gemini',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      // Test maxFileSizeBytes constraint
      await assert.rejects(
        async () => {
          await buildProjectZipBlob(sampleBuild, oversizedFile, { maxFileSizeBytes: 1000 });
        },
        (err: Error) => {
          assert.match(err.message, /exceeds maximum permitted file size/i);
          return true;
        }
      );

      // Test maxTotalSizeBytes constraint
      await assert.rejects(
        async () => {
          await buildProjectZipBlob(sampleBuild, oversizedFile, { maxTotalSizeBytes: 1500 });
        },
        (err: Error) => {
          assert.match(err.message, /exceeds maximum archive size limit/i);
          return true;
        }
      );
    });

    test('Never silently overwrites user-generated project files', async () => {
      const userCustomFiles: ProjectFile[] = [
        {
          path: 'README.md',
          content: '# Custom User Handwritten Readme\nDo not overwrite me!',
          version: 1,
          ownerModel: 'user',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          path: 'Dockerfile',
          content: '# Custom Production Dockerfile\nFROM debian:bookworm\n',
          version: 1,
          ownerModel: 'user',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      const res = await buildProjectZipBlob(sampleBuild, userCustomFiles, {
        includeSetupGuide: true,
        includeDockerConfig: true
      });

      // Load zip contents to inspect
      const JSZip = (await import('jszip')).default;
      const loaded = await JSZip.loadAsync(res.blob);

      const readmeContent = await loaded.file('README.md')?.async('string');
      assert.equal(readmeContent, '# Custom User Handwritten Readme\nDo not overwrite me!');

      const dockerContent = await loaded.file('Dockerfile')?.async('string');
      assert.equal(dockerContent, '# Custom Production Dockerfile\nFROM debian:bookworm\n');
    });
  });

  describe('PHASE 4: Stack-Aware Local Development Export', () => {
    test('Python FastAPI project gets Python 3.11 Dockerfile and uvicorn CMD (not Node)', async () => {
      const fastApiFiles: ProjectFile[] = [
        {
          path: 'requirements.txt',
          content: 'fastapi==0.110.0\nuvicorn==0.28.0\npydantic==2.6.4\n',
          version: 1,
          ownerModel: 'gemini',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          path: 'main.py',
          content: 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/")\ndef root(): return {"status": "ok"}\n',
          version: 1,
          ownerModel: 'gemini',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      const res = await buildProjectZipBlob(null, fastApiFiles);
      assert.equal(res.stack, 'python-fastapi');

      const JSZip = (await import('jszip')).default;
      const loaded = await JSZip.loadAsync(res.blob);

      const dockerfile = await loaded.file('Dockerfile')?.async('string');
      assert.match(dockerfile!, /FROM python:3\.11-slim/);
      assert.match(dockerfile!, /uvicorn/);
      assert.match(dockerfile!, /main:app/);
      assert.match(dockerfile!, /8000/);
      assert.doesNotMatch(dockerfile!, /node:22/i);
      assert.doesNotMatch(dockerfile!, /npm run dev/i);
    });

    test('Go project gets Go 1.22 Dockerfile with go mod download', async () => {
      const goFiles: ProjectFile[] = [
        {
          path: 'go.mod',
          content: 'module example.com/myapp\n\ngo 1.22\n',
          version: 1,
          ownerModel: 'gemini',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          path: 'main.go',
          content: 'package main\nimport "fmt"\nfunc main() { fmt.Println("hello") }\n',
          version: 1,
          ownerModel: 'gemini',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      const res = await buildProjectZipBlob(null, goFiles);
      assert.equal(res.stack, 'go');

      const JSZip = (await import('jszip')).default;
      const loaded = await JSZip.loadAsync(res.blob);
      const dockerfile = await loaded.file('Dockerfile')?.async('string');
      assert.match(dockerfile!, /FROM golang:1\.22-alpine/);
      assert.match(dockerfile!, /go.*run/);
    });
  });

  describe('PHASE 5: Environment Variable Intelligence & Secret Exclusion', () => {
    test('Excludes raw secret .env and .env.local files from being exported', async () => {
      const filesWithSecrets: ProjectFile[] = [
        {
          path: 'src/index.ts',
          content: 'console.log("app");',
          version: 1,
          ownerModel: 'gemini',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          path: '.env',
          content: 'SUPER_SECRET_KEY=sk-super-secret-1234567890\nPASSWORD=super_secret_pw\n',
          version: 1,
          ownerModel: 'user',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          path: '.env.local',
          content: 'LOCAL_SECRET=secret_token_abc\n',
          version: 1,
          ownerModel: 'user',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      const res = await buildProjectZipBlob(sampleBuild, filesWithSecrets);
      const JSZip = (await import('jszip')).default;
      const loaded = await JSZip.loadAsync(res.blob);

      // Verify that raw .env and .env.local DO NOT exist in the ZIP!
      assert.equal(loaded.file('.env'), null, 'Raw .env file with secrets must never exist in ZIP export');
      assert.equal(loaded.file('.env.local'), null, 'Raw .env.local file with secrets must never exist in ZIP export');

      // But safe .env.example MUST exist
      const envExample = await loaded.file('.env.example')?.async('string');
      assert.ok(envExample);
      assert.doesNotMatch(envExample!, /sk-super-secret-1234567890/);
      assert.doesNotMatch(envExample!, /super_secret_pw/);
    });

    test('Scans source code for referenced variables and creates documented template', async () => {
      const codeFiles: ProjectFile[] = [
        {
          path: 'src/aiService.ts',
          content: 'const key = process.env.GEMINI_API_KEY;\nconst url = process.env.APP_URL;\n',
          version: 1,
          ownerModel: 'gemini',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          path: 'src/server.ts',
          content: 'const port = process.env.PORT || 8080;\nconst secret = process.env.ENCRYPTION_SECRET;\n',
          version: 1,
          ownerModel: 'gemini',
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      const res = await buildProjectZipBlob(sampleBuild, codeFiles);
      const JSZip = (await import('jszip')).default;
      const loaded = await JSZip.loadAsync(res.blob);

      const envExample = await loaded.file('.env.example')?.async('string');
      assert.ok(envExample);
      assert.match(envExample!, /GEMINI_API_KEY=/);
      assert.match(envExample!, /ENCRYPTION_SECRET=/);
      assert.match(envExample!, /PORT=/);
      assert.match(envExample!, /APP_URL=/);
      // Explanations provided
      assert.match(envExample!, /Google Gemini API key/i);
    });
  });
});
