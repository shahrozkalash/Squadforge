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
});
