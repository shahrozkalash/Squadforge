/**
 * Factory Phase F8 — Creative editors workflow (video / image / photo).
 *
 * Each creative-editor category flows through the factory machinery
 * as one workflow:
 *
 *   description → F5 team by data (plan)
 *               → swarm build (the real SwarmOrchestrator chain over
 *                 a stub transport, the F2–F4/F7 seam; the tree is the
 *                 editor project package)
 *               → F6 environment cycle (contract operations only)
 *               → category verification:
 *                   video — the delivered editor project is rendered
 *                           by the platform's genuine ffmpeg exporter;
 *                           the MP4 is proven by ffprobe, decoded
 *                           frames and audio RMS (Phase 37 style)
 *                   image — the delivered project is loaded by the
 *                           real engine, round-tripped losslessly,
 *                           and an operation chain is pixel-verified
 *                   photo — the delivered catalog is verified against
 *                           the real originals by SHA-256, developed
 *                           by the F8 develop engine, batch-exported,
 *                           and the originals proven untouched
 *
 * The stub is a transport fixture: it stands in for the planner and
 * worker models. The planner's response is the platform's real
 * create_task mechanism, and the worker responses write fixture
 * packages whose core data is produced by the platform's own engines
 * (the video project by the timeline API, the image project by the
 * image engine, the photo catalog by the F8 photo engine) — so the
 * trees the chain verifies and the workflows consume are genuine
 * engine data. The editor applications themselves are the platform's
 * own generator output (ClipForge / PixelForge), asserted as file
 * sets. No live model exists in this environment (F1 verdict); this
 * suite proves the workflow machinery and labels fixture content as
 * fixture content.
 *
 * Generated fixture files are this repository's own trusted test
 * content, so the execution adapter may run them on the host.
 */
process.env.SQUADFORGE_TRUSTED_HOST_TESTS = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { db } from '../server/store.js';
import { smartRouter } from '../server/smartRouter.js';
import { SwarmOrchestrator } from '../server/swarm/swarmOrchestrator.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
// Video editor engine + workflow
import { createProject, addClip, addTransition, serializeVideoProject } from '../server/videoEditor/timeline.js';
import { addTextElement } from '../server/videoEditor/editingOps.js';
import { VideoEditorWorkflow } from '../server/videoEditor/videoWorkflow.js';
import type { MediaAsset } from '../server/videoEditor/types.js';
// Image engine + workflows
import {
  createProject as createImageProject,
  addLayer,
  fillRect,
  serializeProject
} from '../server/imageEditor/imageCore.js';
import { importImage } from '../server/imageEditor/imageCodec.js';
import { ImageEditorWorkflow } from '../server/imageEditor/imageWorkflow.js';
import { PhotoEditorWorkflow, meanChannels, meanLuminance } from '../server/imageEditor/photoWorkflow.js';
import {
  createPhotoProject,
  deserializePhotoProject,
  developPhoto,
  exportDevelopedPhoto,
  importPhoto,
  serializePhotoProject,
  setPhotoFlag,
  setPhotoRating,
  sha256Hex,
  updatePhotoDevelop
} from '../server/imageEditor/photoProject.js';
import { applyDevelopSettings, resolveDevelopSettings } from '../server/imageEditor/photoDevelop.js';

// ---------------------------------------------------------------------------
// Shared swarm scaffolding (F7 pattern)
// ---------------------------------------------------------------------------
let counter = 0;

function makeBuild(idea: string): { buildId: string; userId: string } {
  const userId = `usr_f8_${Date.now()}_${++counter}`;
  db.createUser({
    id: userId,
    email: `${userId}@f8.test`,
    name: userId,
    githubConnected: false,
    costLimitPerBuild: 25,
    enabledModelIds: ['gemini', 'claude', 'deepseek'],
    createdAt: Date.now()
  } as any);

  const buildId = `bld_f8_${Date.now()}_${++counter}`;
  db.saveBuild({
    id: buildId,
    userId,
    idea,
    status: 'planning',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selectedModels: ['gemini', 'claude', 'deepseek'],
    autoPushGithub: false,
    totalTokens: 0,
    totalCost: 0,
    costLimit: 25,
    maxDurationSeconds: 600,
    patchesAppliedCount: 0
  } as any);
  return { buildId, userId };
}

function startApprovalPump(buildId: string, userId: string): () => void {
  const timer = setInterval(async () => {
    try {
      for (const req of db.getApprovalRequests(buildId, 'pending')) {
        const decided = ApprovalGateService.respondToApproval(buildId, userId, { requestId: req.id, approved: true });
        if (decided.success && decided.request) {
          await SwarmOrchestrator.resolveHeldTask(decided.request);
        }
      }
    } catch {
      // The pump must never take the test down with it.
    }
  }, 150);
  return () => clearInterval(timer);
}

function okResult(modelId: string, parsedResponse: any, rawText = ''): any {
  return {
    success: true,
    rawText,
    parsedResponse,
    tokensUsed: 10,
    modelId,
    actualModelUsed: modelId,
    providerUsed: 'stub-transport',
    isFallback: false,
    latencyMs: 1
  };
}

function installStub(
  t: any,
  plannerActions: any[],
  contentFor: (filePath: string) => string
): void {
  t.mock.method(smartRouter, 'executeSmartRequest', async (params: any) => {
    const modelId: string = params.requestedModelId || 'unknown';
    const prompt: string = params.prompt || '';

    if (prompt.includes('PROJECT MANAGER & ARCHITECT SPECIFICATION')) {
      return okResult(modelId, { thinking: 'plan', actions: plannerActions });
    }
    if (prompt.includes('VERIFY SOFTWARE COMPLETION')) {
      return okResult(modelId, null, JSON.stringify({
        approved: true,
        summary: 'All requirements verified against specification',
        missingRequirements: []
      }));
    }

    const task = params.task;
    const actions = (task?.filePaths || []).map((p: string) => {
      // A competent model patches a file that already exists (the
      // platform's own MergeManager demands exactly that — e.g. the
      // README the orchestrator seeds at plan time). Converging on
      // the fixture content keeps parallel workers from colliding.
      const existing = db.getFile(params.buildId, p);
      if (existing) {
        return { action: 'patch_file', path: p, edits: [{ find: existing.content, replace: contentFor(p) }], commitMessage: `Implement ${task?.title}` };
      }
      return { action: 'create_file', path: p, content: contentFor(p), commitMessage: `Implement ${task?.title}` };
    });
    return okResult(modelId, { thinking: 'work', actions });
  });
}

/** Runs one swarm build over the stub and asserts the chain's gates. */
async function runSwarmBuild(
  t: any,
  idea: string,
  plannerActions: any[],
  contentFor: (filePath: string) => string,
  expectedFiles: string[]
): Promise<{ buildId: string; userId: string }> {
  const { buildId, userId } = makeBuild(idea);
  installStub(t, plannerActions, contentFor);
  const stopPump = startApprovalPump(buildId, userId);
  try {
    await SwarmOrchestrator.startSwarm(buildId);
  } finally {
    stopPump();
  }

  const build = db.getBuild(buildId);
  const tasks = db.getTasks(buildId);
  const planned = tasks.filter((task) => !task.isFixTask);
  const events = db.getEvents(buildId);

  assert.equal(build?.status, 'completed', `swarm build must complete, got ${build?.status}: ${build?.error || build?.failureReason || ''}`);
  assert.equal(build?.projectType, 'multimedia_application', 'the build must be classified as a multimedia (creative editor) application');
  assert.ok(events.some((e) => e.type === 'verifier_approved'), 'the completion verifier must approve before completion');
  for (const e of events.filter((e) => e.type === 'sandbox_check')) {
    assert.match(e.details, /passed cleanly/, 'every sandbox integrity check in the run must pass');
  }
  assert.ok(planned.length >= 4, `expected the planner's package tasks, got ${planned.length}`);
  for (const task of planned) {
    assert.equal(task.status, 'completed', `task "${task.title}" must complete`);
  }
  for (const filePath of expectedFiles) {
    assert.ok(db.getFile(buildId, filePath), `the built tree must contain ${filePath}`);
  }
  return { buildId, userId };
}

/** Asserts the shared F6 contract-cycle outcomes for a built package. */
function assertCycle(cycle: { build: any; tests: any; previewMode: string; artifact: any }, label: string): void {
  assert.equal(
    cycle.build.status,
    'skipped',
    `${label}: a data package has no bundle entry point, so the web build validation must honestly skip, got ${cycle.build.status}: ${cycle.build.detail}`
  );
  assert.equal(cycle.tests.status, 'passed', `${label}: the contract test cycle must pass: ${cycle.tests.detail}`);
  assert.equal(cycle.tests.failed, 0);
  assert.ok(cycle.tests.passed >= 3, `${label}: the package's own tests must run and pass, got ${cycle.tests.passed}`);
  assert.ok(typeof cycle.previewMode === 'string' && cycle.previewMode.length > 0, `${label}: a preview must be produced with its mode labelled`);
  assert.equal(cycle.artifact.kind, 'zip');
  assert.ok(cycle.artifact.sizeBytes > 0, `${label}: the exported artifact must be non-empty`);
  assert.match(cycle.artifact.sha256 || '', /^[0-9a-f]{64}$/, `${label}: the exported artifact must carry a SHA-256`);
  assert.ok(cycle.artifact.path && fs.existsSync(cycle.artifact.path), `${label}: the exported artifact must exist on disk`);
  const artifactBytes = fs.readFileSync(cycle.artifact.path!);
  assert.equal(
    crypto.createHash('sha256').update(artifactBytes).digest('hex'),
    cycle.artifact.sha256,
    `${label}: the artifact hash must match the bytes on disk`
  );
}

/** Writes contract-read files into an on-disk package directory. */
function writePackage(files: Array<{ path: string; content: string }>, dir: string): void {
  for (const file of files) {
    const target = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf-8');
  }
}

const PACKAGE_JSON = (name: string, description: string) =>
  JSON.stringify(
    { name, version: '1.0.0', private: true, description, scripts: { test: 'node --test tests/' } },
    null,
    2
  ) + '\n';

const TSCONFIG =
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        types: ['node']
      },
      include: ['tests']
    },
    null,
    2
  ) + '\n';

// ---------------------------------------------------------------------------
// VIDEO package fixture — the editor project is built with the real
// timeline API; the app manifest comes from the real generator.
// ---------------------------------------------------------------------------
const VIDEO_DESCRIPTION =
  'Build a video editor app with a multitrack timeline, crossfades, titles and MP4 export';

function buildVideoProjectJson(): string {
  const assets = new Map<string, MediaAsset>();
  assets.set('media-red', {
    id: 'media-red',
    path: 'media/clip-red.mp4',
    durationSec: 2,
    hasVideo: true,
    hasAudio: true,
    width: 320,
    height: 240,
    fps: 30,
    kind: 'video'
  });
  assets.set('media-blue', {
    id: 'media-blue',
    path: 'media/clip-blue.mp4',
    durationSec: 2,
    hasVideo: true,
    hasAudio: true,
    width: 320,
    height: 240,
    fps: 30,
    kind: 'video'
  });
  const project = createProject('F8 Demo Edit', 320, 240, 30);
  const base = project.tracks[0];
  const clip1 = addClip(project, assets, base.id, { mediaId: 'media-red', trackStart: 0, sourceIn: 0, sourceOut: 2 });
  addClip(project, assets, base.id, { mediaId: 'media-blue', trackStart: 2, sourceIn: 0, sourceOut: 2 });
  addTransition(project, clip1.id, 0.5, 'crossfade');
  addTextElement(project, {
    text: 'F8 STUDIO',
    trackStart: 0,
    durationSec: 2,
    x: 110,
    y: 16,
    fontSize: 28,
    color: '#FFFFFF'
  });
  return JSON.stringify(serializeVideoProject(project, assets), null, 2) + '\n';
}

const VIDEO_MEDIA_MANIFEST = {
  files: [
    {
      path: 'media/clip-red.mp4',
      ffmpegArgs: [
        '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=2:r=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:d=2:sample_rate=44100',
        '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'
      ]
    },
    {
      path: 'media/clip-blue.mp4',
      ffmpegArgs: [
        '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2:r=30',
        '-f', 'lavfi', '-i', 'sine=frequency=880:d=2:sample_rate=44100',
        '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'
      ]
    }
  ]
};

let videoProjectJsonCache: string | null = null;
function videoProjectJson(): string {
  if (!videoProjectJsonCache) videoProjectJsonCache = buildVideoProjectJson();
  return videoProjectJsonCache;
}

let videoAppManifestCache: string | null = null;
function videoAppManifest(): string {
  if (!videoAppManifestCache) {
    const files = Object.keys(VideoEditorWorkflow.generateEditorApp('ClipForge')).sort();
    videoAppManifestCache = JSON.stringify({ app: 'ClipForge', generator: 'VideoProjectGenerator', files }, null, 2) + '\n';
  }
  return videoAppManifestCache;
}

const VIDEO_TEST_TS = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import * as fs from 'node:fs';",
  '',
  "const readJson = (rel: string): any => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf-8'));",
  "const project = readJson('../project/video-project.json');",
  "const manifest = readJson('../media/media-manifest.json');",
  "const appManifest = readJson('../app/app-manifest.json');",
  '',
  "test('the editor project is a serialized SquadForge video project with the demo edit', () => {",
  "  assert.equal(project.format, 'squadforge-video-project');",
  '  const clips = project.project.tracks.flatMap((t: any) => t.clips);',
  '  assert.equal(clips.length, 2);',
  '  assert.equal(project.project.transitions.length, 1);',
  "  assert.equal(project.project.transitions[0].type, 'crossfade');",
  '  assert.equal(project.project.texts.length, 1);',
  "  assert.equal(project.project.texts[0].text, 'F8 STUDIO');",
  '});',
  '',
  "test('timeline math: two 2s clips with a 0.5s crossfade last 3.5s', () => {",
  '  let end = 0;',
  '  for (const track of project.project.tracks) {',
  '    for (const clip of track.clips) end = Math.max(end, clip.trackStart + (clip.sourceOut - clip.sourceIn));',
  '  }',
  '  const transitionsTotal = project.project.transitions.reduce((sum: number, t: any) => sum + t.durationSec, 0);',
  '  assert.equal(end - transitionsTotal, 3.5);',
  '});',
  '',
  "test('the media manifest covers every media path the project references', () => {",
  '  const manifestPaths = new Set(manifest.files.map((f: any) => f.path));',
  '  assert.equal(manifest.files.length, 2);',
  '  for (const media of project.media) assert.ok(manifestPaths.has(media.path), media.path);',
  '});',
  '',
  "test('the app manifest lists the generated ClipForge editor application', () => {",
  "  assert.equal(appManifest.app, 'ClipForge');",
  "  assert.ok(appManifest.files.includes('ClipForge.sln'));",
  "  assert.ok(appManifest.files.includes('src/ClipForge/Program.cs'));",
  "  assert.ok(appManifest.files.includes('src/ClipForge/VideoDocument.cs'));",
  "  assert.ok(appManifest.files.includes('src/ClipForge/MainForm.cs'));",
  '});',
  ''
].join('\n');

const VIDEO_README = [
  '# F8 Video Editor Project Package',
  '',
  'The deliverable of the SquadForge video-editor workflow: an editor',
  'project package for the platform video editor, plus the manifest of',
  'the generated ClipForge-class editor application (app/app-manifest.json).',
  '',
  '## Contents',
  '- `project/video-project.json` — the editor project: a two-clip',
  '  timeline with a crossfade and a burned-in title, serialized by the',
  '  platform timeline model.',
  '- `media/media-manifest.json` — the fixture media the project edits,',
  '  with the ffmpeg recipes that materialize them.',
  '- `tests/editor.test.ts` — the package verification tests.',
  '',
  '## Data export/import functionality',
  'The editor project is data. Import deserializes the JSON project',
  'through the platform timeline model, validating every clip against',
  'its media; export renders the same data to MP4 through the platform',
  'ffmpeg exporter, and the rendered file is verified by ffprobe, by',
  'decoded-frame pixel checks, and by audio level measurement.',
  ''
].join('\n');

function videoContentFor(filePath: string): string {
  if (filePath === 'package.json') return PACKAGE_JSON('f8-video-editor-project', 'F8 video editor project package.');
  if (filePath === 'tsconfig.json') return TSCONFIG;
  if (filePath === 'README.md') return VIDEO_README;
  if (filePath === 'project/video-project.json') return videoProjectJson();
  if (filePath === 'media/media-manifest.json') return JSON.stringify(VIDEO_MEDIA_MANIFEST, null, 2) + '\n';
  if (filePath === 'app/app-manifest.json') return videoAppManifest();
  if (filePath === 'tests/editor.test.ts') return VIDEO_TEST_TS;
  return `// ${filePath}\n`;
}

const VIDEO_PLANNER_ACTIONS = [
  {
    action: 'create_task',
    title: 'Author the editor project timeline data',
    description: 'The serialized video project: two clips, a crossfade, and a burned-in title, built on the timeline model',
    filePaths: ['project/video-project.json'],
    priority: 2,
    assignedRole: 'fullstack_developer'
  },
  {
    action: 'create_task',
    title: 'Declare the project media manifest',
    description: 'The fixture media the project edits, with the ffmpeg recipes that materialize them',
    filePaths: ['media/media-manifest.json'],
    priority: 2,
    assignedRole: 'backend_developer'
  },
  {
    action: 'create_task',
    title: 'Record the generated editor application manifest',
    description: 'The ClipForge-class editor application file set produced by the platform generator, plus package config and documentation',
    filePaths: ['app/app-manifest.json', 'package.json', 'tsconfig.json', 'README.md'],
    priority: 3,
    assignedRole: 'devops_release_specialist'
  },
  {
    action: 'create_task',
    title: 'Write package verification tests',
    description: 'Node tests validating the editor project data, the timeline math, the media manifest and the app manifest',
    filePaths: ['tests/editor.test.ts'],
    priority: 3,
    assignedRole: 'qa_testing_specialist'
  }
];

// ---------------------------------------------------------------------------
// IMAGE package fixture — the editor project is built with the real
// image engine; the app manifest comes from the real generator.
// ---------------------------------------------------------------------------
const IMAGE_DESCRIPTION =
  'Build an image editor app with layers, masks, filters and project export';

function buildImageProjectJson(): string {
  const project = createImageProject(64, 48);
  const base = project.layers[0];
  base.name = 'Base';
  fillRect(project, base.id, { x: 0, y: 0, width: 64, height: 48 }, { r: 200, g: 100, b: 50, a: 255 });
  const accent = addLayer(project, 'Accent');
  fillRect(project, accent.id, { x: 0, y: 0, width: 16, height: 48 }, { r: 10, g: 20, b: 30, a: 255 });
  return JSON.stringify(serializeProject(project), null, 2) + '\n';
}

let imageProjectJsonCache: string | null = null;
function imageProjectJson(): string {
  if (!imageProjectJsonCache) imageProjectJsonCache = buildImageProjectJson();
  return imageProjectJsonCache;
}

let imageAppManifestCache: string | null = null;
function imageAppManifest(): string {
  if (!imageAppManifestCache) {
    const files = Object.keys(ImageEditorWorkflow.generateEditorApp('PixelForge')).sort();
    imageAppManifestCache = JSON.stringify({ app: 'PixelForge', generator: 'ImageProjectGenerator', files }, null, 2) + '\n';
  }
  return imageAppManifestCache;
}

const IMAGE_TEST_TS = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import * as fs from 'node:fs';",
  '',
  "const readJson = (rel: string): any => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf-8'));",
  "const project = readJson('../project/image-project.json');",
  "const appManifest = readJson('../app/app-manifest.json');",
  '',
  "test('the editor project is a serialized image project with the fixture layers', () => {",
  '  assert.equal(project.width, 64);',
  '  assert.equal(project.height, 48);',
  '  assert.equal(project.layers.length, 2);',
  "  assert.deepEqual(project.layers.map((l: any) => l.name), ['Base', 'Accent']);",
  '});',
  '',
  "test('every layer carries real pixel data', () => {",
  '  for (const layer of project.layers) {',
  "    assert.equal(typeof layer.pixelsBase64, 'string');",
  '    assert.ok(layer.pixelsBase64.length > 100);',
  '  }',
  '});',
  '',
  "test('the app manifest lists the generated PixelForge editor application', () => {",
  "  assert.equal(appManifest.app, 'PixelForge');",
  "  assert.ok(appManifest.files.includes('PixelForge.sln'));",
  "  assert.ok(appManifest.files.includes('src/PixelForge/Program.cs'));",
  "  assert.ok(appManifest.files.includes('src/PixelForge/PixelEngine.cs'));",
  "  assert.ok(appManifest.files.includes('src/PixelForge/ImageDocument.cs'));",
  "  assert.ok(appManifest.files.includes('src/PixelForge/MainForm.cs'));",
  '});',
  ''
].join('\n');

const IMAGE_README = [
  '# F8 Image Editor Project Package',
  '',
  'The deliverable of the SquadForge image-editor workflow: an editor',
  'project package for the platform image editor, plus the manifest of',
  'the generated PixelForge-class editor application (app/app-manifest.json).',
  '',
  '## Contents',
  '- `project/image-project.json` — the layered editor project (Base and',
  '  Accent layers with real pixel data), serialized by the image engine.',
  '- `tests/editor.test.ts` — the package verification tests.',
  '',
  '## Data export/import functionality',
  'The editor project is data. Import deserializes the JSON project',
  'through the image engine, restoring every layer and its pixels;',
  'export renders the composited data to PNG, JPEG, BMP or TIFF through',
  'the engine codecs. A serialize → deserialize → composite round trip',
  'is byte-identical, which the workflow verification proves.',
  ''
].join('\n');

function imageContentFor(filePath: string): string {
  if (filePath === 'package.json') return PACKAGE_JSON('f8-image-editor-project', 'F8 image editor project package.');
  if (filePath === 'tsconfig.json') return TSCONFIG;
  if (filePath === 'README.md') return IMAGE_README;
  if (filePath === 'project/image-project.json') return imageProjectJson();
  if (filePath === 'app/app-manifest.json') return imageAppManifest();
  if (filePath === 'tests/editor.test.ts') return IMAGE_TEST_TS;
  return `// ${filePath}\n`;
}

const IMAGE_PLANNER_ACTIONS = [
  {
    action: 'create_task',
    title: 'Author the layered editor project',
    description: 'The serialized image project: a Base layer and an Accent layer with real pixel data, built on the image engine',
    filePaths: ['project/image-project.json'],
    priority: 2,
    assignedRole: 'fullstack_developer'
  },
  {
    action: 'create_task',
    title: 'Record the generated editor application manifest',
    description: 'The PixelForge-class editor application file set produced by the platform generator',
    filePaths: ['app/app-manifest.json'],
    priority: 3,
    assignedRole: 'devops_release_specialist'
  },
  {
    action: 'create_task',
    title: 'Configure and document the package',
    description: 'package.json, tsconfig.json and the package README',
    filePaths: ['package.json', 'tsconfig.json', 'README.md'],
    priority: 3,
    assignedRole: 'devops_release_specialist'
  },
  {
    action: 'create_task',
    title: 'Write package verification tests',
    description: 'Node tests validating the editor project data and the app manifest',
    filePaths: ['tests/editor.test.ts'],
    priority: 3,
    assignedRole: 'qa_testing_specialist'
  }
];

// ---------------------------------------------------------------------------
// PHOTO package fixture — real JPEG originals are materialized with
// ffmpeg lavfi; the catalog is built by importing those exact bytes
// through the F8 photo engine, so its hashes are genuine.
// ---------------------------------------------------------------------------
const PHOTO_DESCRIPTION =
  'Build a photo editor app with a photo catalog, non-destructive develop settings and batch export';

const PHOTO1_NAME = 'gradient-scene.jpg';
const PHOTO2_NAME = 'testsrc2-scene.jpg';

let photoFixtureCache: { p1: Buffer; p2: Buffer } | null = null;
function photoFixtures(): { p1: Buffer; p2: Buffer } {
  if (photoFixtureCache) return photoFixtureCache;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f8-photo-fixtures-'));
  const out1 = path.join(dir, PHOTO1_NAME);
  const out2 = path.join(dir, PHOTO2_NAME);
  // Photo 1 is a smooth gradient scene built with geq expressions
  // (r/g/b ramps peaking at 180, so highlights keep headroom): its
  // mid-tones respond measurably to exposure and white balance
  // (probed on the exact bytes: +1 EV & temperature +40 lift mean
  // luminance ×1.85). The lavfi `gradients` source was rejected as a
  // fixture — two invocations produce different bytes even with a
  // pinned seed, so its develop ratios are not reproducible.
  // Photo 2 is the saturated testsrc2 scene: right for the
  // desaturation/shadows proofs. The saturated scene was measured
  // nearly exposure-blind (×1.05 — its primaries are already
  // clipped), which is why the roles are assigned this way.
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', "nullsrc=s=320x240,geq=r='X*180/W':g='Y*180/H':b='(W-X)*180/W'", '-frames:v', '1', '-q:v', '3', out1], { stdio: 'pipe' });
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1:r=1', '-frames:v', '1', '-q:v', '3', out2], { stdio: 'pipe' });
  photoFixtureCache = { p1: fs.readFileSync(out1), p2: fs.readFileSync(out2) };
  return photoFixtureCache;
}

let photoProjectJsonCache: string | null = null;
function photoProjectJson(): string {
  if (photoProjectJsonCache) return photoProjectJsonCache;
  const { p1, p2 } = photoFixtures();
  const project = createPhotoProject('F8 Field Shoot');
  const e1 = importPhoto(project, PHOTO1_NAME, p1);
  const e2 = importPhoto(project, PHOTO2_NAME, p2);
  updatePhotoDevelop(project, e1.id, { exposure: 1, temperature: 40 });
  updatePhotoDevelop(project, e2.id, { saturation: -100, shadows: 50 });
  setPhotoRating(project, e1.id, 5);
  setPhotoFlag(project, e1.id, 'pick');
  photoProjectJsonCache = JSON.stringify(serializePhotoProject(project), null, 2) + '\n';
  return photoProjectJsonCache;
}

const PHOTO_TEST_TS = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import * as fs from 'node:fs';",
  '',
  "const catalog = JSON.parse(fs.readFileSync(new URL('../photo-project.json', import.meta.url), 'utf-8'));",
  '',
  "test('the catalog is a SquadForge photo project with both photos', () => {",
  "  assert.equal(catalog.format, 'squadforge-photo-project');",
  '  assert.equal(catalog.photos.length, 2);',
  '  for (const photo of catalog.photos) {',
  "    assert.match(photo.sha256, /^[0-9a-f]{64}$/);",
  "    assert.equal(photo.format, 'jpeg');",
  '    assert.equal(photo.width, 320);',
  '    assert.equal(photo.height, 240);',
  '  }',
  '});',
  '',
  "test('develop settings are catalogued as data', () => {",
  "  const p1 = catalog.photos.find((p: any) => p.fileName === 'gradient-scene.jpg');",
  "  const p2 = catalog.photos.find((p: any) => p.fileName === 'testsrc2-scene.jpg');",
  '  assert.equal(p1.develop.exposure, 1);',
  '  assert.equal(p1.develop.temperature, 40);',
  '  assert.equal(p2.develop.saturation, -100);',
  '  assert.equal(p2.develop.shadows, 50);',
  '});',
  '',
  "test('organize data is catalogued', () => {",
  "  const p1 = catalog.photos.find((p: any) => p.fileName === 'gradient-scene.jpg');",
  '  assert.equal(p1.rating, 5);',
  "  assert.equal(p1.flag, 'pick');",
  '});',
  ''
].join('\n');

const PHOTO_README = [
  '# F8 Photo Editor Project Package',
  '',
  'The deliverable of the SquadForge photo-editor workflow: a photo',
  'project package for the platform photo editor (catalog +',
  'non-destructive develop + batch export, built on the image engine).',
  '',
  '## Contents',
  '- `photo-project.json` — the photo catalog: each original recorded',
  '  by name, format, dimensions and SHA-256, with its develop',
  '  settings and organize data (rating, flag) held as data.',
  '- `tests/editor.test.ts` — the package verification tests.',
  '',
  '## Data export/import functionality',
  'The catalog is data. Import records a photo by decoding it with the',
  'engine codecs (PNG, JPEG, BMP, TIFF — camera RAW is refused by',
  'name) and hashing the original bytes; the originals themselves are',
  'never stored or modified. Export develops each photo from its',
  'catalogued settings and batch-exports the results as JPEG or PNG.',
  'Developing is non-destructive: the settings are data, the original',
  'bytes are re-verified by SHA-256 before every develop, and they',
  'are byte-identical after every export.',
  ''
].join('\n');

function photoContentFor(filePath: string): string {
  if (filePath === 'package.json') return PACKAGE_JSON('f8-photo-editor-project', 'F8 photo editor project package.');
  if (filePath === 'tsconfig.json') return TSCONFIG;
  if (filePath === 'README.md') return PHOTO_README;
  if (filePath === 'photo-project.json') return photoProjectJson();
  if (filePath === 'tests/editor.test.ts') return PHOTO_TEST_TS;
  return `// ${filePath}\n`;
}

const PHOTO_PLANNER_ACTIONS = [
  {
    action: 'create_task',
    title: 'Build the photo catalog with develop settings',
    description: 'The photo project: two catalogued originals with develop settings and organize data, recorded by the photo engine',
    filePaths: ['photo-project.json'],
    priority: 2,
    assignedRole: 'fullstack_developer'
  },
  {
    action: 'create_task',
    title: 'Configure the photo project package',
    description: 'package.json and tsconfig.json for the photo project package',
    filePaths: ['package.json', 'tsconfig.json'],
    priority: 3,
    assignedRole: 'devops_release_specialist'
  },
  {
    action: 'create_task',
    title: 'Document the photo project package',
    description: 'The package README: catalog, develop and batch-export documentation',
    filePaths: ['README.md'],
    priority: 3,
    assignedRole: 'fullstack_developer'
  },
  {
    action: 'create_task',
    title: 'Write package verification tests',
    description: 'Node tests validating the catalog, its develop settings as data, and its organize data',
    filePaths: ['tests/editor.test.ts'],
    priority: 3,
    assignedRole: 'qa_testing_specialist'
  }
];

// ---------------------------------------------------------------------------
// (a) VIDEO: described editor → team → swarm build → contract cycle →
//     genuine ffmpeg export, proven by probe + frames + audio RMS
// ---------------------------------------------------------------------------
test('F8 video workflow: described video editor flows team → swarm build → contract cycle → verified ffmpeg export', { timeout: 300_000 }, async (t) => {
  // Step 1 — team resolution from F5 data.
  const plan = VideoEditorWorkflow.plan(VIDEO_DESCRIPTION);
  assert.equal(plan.category, 'multimedia_application');
  assert.equal(plan.teamName, 'Creative Software Team — Multimedia');
  assert.equal(plan.profileId, 'multimedia_application');
  assert.ok(plan.resolvedTeam.members.length >= 5, 'the creative team must have members');
  for (const member of plan.resolvedTeam.members) {
    assert.ok(member.modelId, `team member role ${member.role} must resolve to a registered model`);
  }
  assert.equal(plan.resolvedTeam.verifierModelId, 'claude', 'the creative team verification chain resolves its verifier through the registry');

  // The described editor variant generates the ClipForge-class app.
  const appFiles = VideoEditorWorkflow.generateEditorApp('ClipForge');
  for (const expected of ['ClipForge.sln', 'src/ClipForge/Program.cs', 'src/ClipForge/VideoDocument.cs', 'src/ClipForge/MainForm.cs']) {
    assert.ok(appFiles[expected], `the generated editor app must contain ${expected}`);
  }
  assert.deepEqual(
    JSON.parse(videoAppManifest()).files,
    Object.keys(appFiles).sort(),
    'the package app manifest must be the generator output file set'
  );

  // Step 2 — swarm build through the F4 gates.
  const { buildId, userId } = await runSwarmBuild(t, VIDEO_DESCRIPTION, VIDEO_PLANNER_ACTIONS, videoContentFor, [
    'project/video-project.json',
    'media/media-manifest.json',
    'app/app-manifest.json',
    'package.json',
    'tsconfig.json',
    'README.md',
    'tests/editor.test.ts'
  ]);
  assert.equal(
    db.getFile(buildId, 'project/video-project.json')!.content,
    videoProjectJson(),
    'the delivered editor project must be the engine-built fixture byte-for-byte'
  );

  // Step 3 — environment cycle through the F6 contract.
  const cycle = await VideoEditorWorkflow.runEnvironmentCycle({ projectId: buildId, userId, title: VIDEO_DESCRIPTION });
  assertCycle(cycle, 'video');

  // Step 4 — category verification: the delivered project renders
  // through the platform's genuine exporter and the MP4 is proven.
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f8-video-package-'));
  writePackage(cycle.files, packageDir);
  const verification = await VideoEditorWorkflow.verifyExport(packageDir);
  for (const checkResult of verification.checks) {
    assert.ok(checkResult.passed, `video export check "${checkResult.name}" must pass: ${checkResult.detail}`);
  }
  assert.equal(verification.verified, true, 'the video delivery must verify');
  assert.equal(verification.expectedDurationSec, 3.5, 'the timeline duration must be 3.5s (two 2s clips, 0.5s crossfade)');
  assert.ok(
    Math.abs((verification.probedDurationSec ?? 0) - 3.5) <= 0.35,
    `the probed export duration must match the timeline, got ${verification.probedDurationSec}`
  );
  assert.ok(verification.exportPath && fs.existsSync(verification.exportPath), 'the rendered MP4 must exist on disk');
});

// ---------------------------------------------------------------------------
// (b) IMAGE: described editor → team → swarm build → contract cycle →
//     engine verification with pixel-exact assertions
// ---------------------------------------------------------------------------
test('F8 image workflow: described image editor flows team → swarm build → contract cycle → pixel-verified engine delivery', { timeout: 300_000 }, async (t) => {
  // Step 1 — team resolution from F5 data.
  const plan = ImageEditorWorkflow.plan(IMAGE_DESCRIPTION);
  assert.equal(plan.category, 'multimedia_application');
  assert.equal(plan.teamName, 'Creative Software Team — Multimedia');
  assert.equal(plan.profileId, 'multimedia_application');
  for (const member of plan.resolvedTeam.members) {
    assert.ok(member.modelId, `team member role ${member.role} must resolve to a registered model`);
  }

  // The described editor variant generates the PixelForge-class app.
  const appFiles = ImageEditorWorkflow.generateEditorApp('PixelForge');
  for (const expected of [
    'PixelForge.sln',
    'src/PixelForge/Program.cs',
    'src/PixelForge/PixelEngine.cs',
    'src/PixelForge/ImageDocument.cs',
    'src/PixelForge/MainForm.cs'
  ]) {
    assert.ok(appFiles[expected], `the generated editor app must contain ${expected}`);
  }
  assert.deepEqual(
    JSON.parse(imageAppManifest()).files,
    Object.keys(appFiles).sort(),
    'the package app manifest must be the generator output file set'
  );

  // Step 2 — swarm build through the F4 gates.
  const { buildId, userId } = await runSwarmBuild(t, IMAGE_DESCRIPTION, IMAGE_PLANNER_ACTIONS, imageContentFor, [
    'project/image-project.json',
    'app/app-manifest.json',
    'package.json',
    'tsconfig.json',
    'README.md',
    'tests/editor.test.ts'
  ]);
  assert.equal(
    db.getFile(buildId, 'project/image-project.json')!.content,
    imageProjectJson(),
    'the delivered editor project must be the engine-built fixture byte-for-byte'
  );

  // Step 3 — environment cycle through the F6 contract.
  const cycle = await ImageEditorWorkflow.runEnvironmentCycle({ projectId: buildId, userId, title: IMAGE_DESCRIPTION });
  assertCycle(cycle, 'image');

  // Step 4 — category verification on the delivered project data.
  const deliveredFile = cycle.files.find((f) => f.path === 'project/image-project.json');
  assert.ok(deliveredFile, 'the contract cycle must read back the delivered editor project');
  const { verification, before, after } = ImageEditorWorkflow.verifyProject(JSON.parse(deliveredFile.content));
  for (const checkResult of verification.checks) {
    assert.ok(checkResult.passed, `image project check "${checkResult.name}" must pass: ${checkResult.detail}`);
  }
  assert.equal(verification.verified, true, 'the image delivery must verify');
  assert.ok(before && after, 'the verification must produce before/after composites');

  // Pixel evidence on the delivered composite: the Accent layer's
  // band covers the left 16 px; the Base layer shows elsewhere.
  assert.deepEqual(ImageEditorWorkflow.pixel(before!, 8, 24), { r: 10, g: 20, b: 30, a: 255 }, 'accent band pixel before the chain');
  assert.deepEqual(ImageEditorWorkflow.pixel(before!, 40, 24), { r: 200, g: 100, b: 50, a: 255 }, 'base pixel before the chain');

  // After the workflow chain (brightness +20 at contrast 0, then
  // saturation ×1.5 on the Base layer only), the base pixel is the
  // hand-computed result of the engine's documented math:
  //   brightness: (200,100,50) + 20 = (220,120,70)
  //   saturation 0.5: gray = 0.299·220 + 0.587·120 + 0.114·70 = 144.2
  //     r = 144.2 + (220−144.2)·1.5 = 257.9 → 255 (clamped)
  //     g = 144.2 + (120−144.2)·1.5 = 107.9 → 108
  //     b = 144.2 + (70−144.2)·1.5  = 32.9  → 33
  assert.deepEqual(ImageEditorWorkflow.pixel(after!, 40, 24), { r: 255, g: 108, b: 33, a: 255 }, 'base pixel after the chain must equal the hand-computed engine result');
  assert.deepEqual(ImageEditorWorkflow.pixel(after!, 8, 24), { r: 10, g: 20, b: 30, a: 255 }, 'the Accent layer is not a chain target and must be unchanged');
});

// ---------------------------------------------------------------------------
// (c) PHOTO: described editor → team → swarm build → contract cycle →
//     catalog/develop/batch verification with pixel evidence, plus the
//     develop-settings data round-trip
// ---------------------------------------------------------------------------
test('F8 photo workflow: described photo editor flows team → swarm build → contract cycle → verified develop delivery', { timeout: 300_000 }, async (t) => {
  // Step 1 — team resolution from F5 data.
  const plan = PhotoEditorWorkflow.plan(PHOTO_DESCRIPTION);
  assert.equal(plan.category, 'multimedia_application');
  assert.equal(plan.teamName, 'Creative Software Team — Multimedia');
  assert.equal(plan.profileId, 'multimedia_application');
  for (const member of plan.resolvedTeam.members) {
    assert.ok(member.modelId, `team member role ${member.role} must resolve to a registered model`);
  }

  // Step 2 — swarm build through the F4 gates.
  const { buildId, userId } = await runSwarmBuild(t, PHOTO_DESCRIPTION, PHOTO_PLANNER_ACTIONS, photoContentFor, [
    'photo-project.json',
    'package.json',
    'tsconfig.json',
    'README.md',
    'tests/editor.test.ts'
  ]);
  assert.equal(
    db.getFile(buildId, 'photo-project.json')!.content,
    photoProjectJson(),
    'the delivered catalog must be the engine-built fixture byte-for-byte'
  );

  // Step 3 — environment cycle through the F6 contract.
  const cycle = await PhotoEditorWorkflow.runEnvironmentCycle({ projectId: buildId, userId, title: PHOTO_DESCRIPTION });
  assertCycle(cycle, 'photo');

  // Step 4 — delivery verification against the real originals.
  const { p1, p2 } = photoFixtures();
  const sources = new Map<string, Buffer>([
    [PHOTO1_NAME, p1],
    [PHOTO2_NAME, p2]
  ]);
  const deliveredFile = cycle.files.find((f) => f.path === 'photo-project.json');
  assert.ok(deliveredFile, 'the contract cycle must read back the delivered catalog');
  const verification = PhotoEditorWorkflow.verifyDelivery({
    deliveredProject: JSON.parse(deliveredFile.content),
    sources
  });
  for (const checkResult of verification.checks) {
    assert.ok(checkResult.passed, `photo delivery check "${checkResult.name}" must pass: ${checkResult.detail}`);
  }
  assert.equal(verification.verified, true, 'the photo delivery must verify');
  assert.equal(verification.photos.length, 2, 'both photos must be developed and exported');

  // Pixel evidence from the delivery report: photo 1's +1 EV exposure
  // brightens it materially.
  const photo1Report = verification.photos.find((p) => p.fileName === PHOTO1_NAME)!;
  assert.ok(
    photo1Report.meanLuminanceAfter > photo1Report.meanLuminanceBefore * 1.3,
    `+1 EV must brighten: mean luminance ${photo1Report.meanLuminanceBefore.toFixed(1)} → ${photo1Report.meanLuminanceAfter.toFixed(1)}`
  );
  assert.equal(photo1Report.sourceSha256Before, photo1Report.sourceSha256After, 'the original must be untouched by the delivery');

  // Directional develop evidence on the delivered catalog itself.
  const project = deserializePhotoProject(JSON.parse(deliveredFile.content));
  const entry1 = project.photos.find((p) => p.fileName === PHOTO1_NAME)!;
  const entry2 = project.photos.find((p) => p.fileName === PHOTO2_NAME)!;

  const original1 = importImage(p1);
  // White balance is evidenced in isolation (temperature only): in the
  // combined catalog settings the +1 EV exposure clips the warmed red
  // channel harder than blue, which compresses the ratio — the honest
  // measurement of the WB stage alone is a ×1.27 R/B shift (probed).
  const wbBefore = meanChannels(original1);
  const wbAfter = meanChannels(applyDevelopSettings(original1, { temperature: 40 }));
  assert.ok(
    wbAfter.r / wbAfter.b > (wbBefore.r / wbBefore.b) * 1.1,
    `temperature +40 must warm the balance: R/B ${((wbBefore.r / wbBefore.b) || 0).toFixed(3)} → ${(wbAfter.r / wbAfter.b).toFixed(3)}`
  );

  // Photo 2: saturation −100 makes every pixel gray (channel spread
  // ≤ 1), and shadows +50 lifts its mean luminance.
  const developed2 = developPhoto(project, entry2.id, p2);
  let maxSpread = 0;
  for (let i = 0; i < developed2.data.length; i += 4) {
    const spread = Math.max(developed2.data[i], developed2.data[i + 1], developed2.data[i + 2]) -
      Math.min(developed2.data[i], developed2.data[i + 1], developed2.data[i + 2]);
    if (spread > maxSpread) maxSpread = spread;
  }
  assert.ok(maxSpread <= 1, `saturation −100 must desaturate fully: max channel spread ${maxSpread}`);
  assert.ok(
    meanLuminance(developed2) > meanLuminance(importImage(p2)),
    'shadows +50 must lift the mean luminance of the test-pattern photo (probed 123.4 → 138.2)'
  );

  // Settings round-trip as data: editing the settings changes the
  // developed output; restoring them reproduces it byte-for-byte;
  // the original never changes.
  const out1 = exportDevelopedPhoto(project, entry1.id, p1, 'png');
  updatePhotoDevelop(project, entry1.id, { exposure: 0 });
  const out2 = exportDevelopedPhoto(project, entry1.id, p1, 'png');
  assert.ok(!out1.equals(out2), 'editing develop settings as data must change the developed output');
  updatePhotoDevelop(project, entry1.id, { exposure: 1 });
  const out3 = exportDevelopedPhoto(project, entry1.id, p1, 'png');
  assert.ok(out3.equals(out1), 'restoring the settings must reproduce the developed output byte-for-byte');
  assert.equal(sha256Hex(p1), entry1.sha256, 'the original bytes must still hash to the catalogued SHA-256');
});

// ---------------------------------------------------------------------------
// (d) NEGATIVES: corrupt deliverables fail their category verification,
//     and the photo engine refuses what it cannot honestly do
// ---------------------------------------------------------------------------
test('F8 negatives: corrupt video package and tampered photo original are refused; RAW and bad settings are refused by name', { timeout: 180_000 }, async () => {
  // Video: the project references media the manifest does not carry.
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f8-video-corrupt-'));
  fs.mkdirSync(path.join(packageDir, 'project'), { recursive: true });
  fs.mkdirSync(path.join(packageDir, 'media'), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'project', 'video-project.json'),
    videoProjectJson().replaceAll('media/clip-red.mp4', 'media/clip-green.mp4')
  );
  fs.writeFileSync(path.join(packageDir, 'media', 'media-manifest.json'), JSON.stringify(VIDEO_MEDIA_MANIFEST, null, 2));
  const videoVerification = await VideoEditorWorkflow.verifyExport(packageDir);
  assert.equal(videoVerification.verified, false, 'a project referencing undeclared media must not verify');
  const mediaCheck = videoVerification.checks.find((c) => c.name.includes('media'));
  assert.ok(mediaCheck && !mediaCheck.passed, 'the media check must be the failing one');
  assert.match(mediaCheck!.detail, /clip-green\.mp4/, 'the failure must name the undeclared media');

  // Photo: one flipped byte in an original breaks its catalog hash.
  const { p1, p2 } = photoFixtures();
  const tampered = Buffer.from(p1);
  tampered[tampered.length - 10] = tampered[tampered.length - 10] ^ 0xff;
  const photoVerification = PhotoEditorWorkflow.verifyDelivery({
    deliveredProject: JSON.parse(photoProjectJson()),
    sources: new Map<string, Buffer>([
      [PHOTO1_NAME, tampered],
      [PHOTO2_NAME, p2]
    ])
  });
  assert.equal(photoVerification.verified, false, 'a tampered original must not verify');
  const hashCheck = photoVerification.checks.find((c) => c.name === `original verified by SHA-256: ${PHOTO1_NAME}`);
  assert.ok(hashCheck && !hashCheck.passed, 'the SHA-256 check for the tampered photo must fail');

  // The photo engine refuses RAW by name and validates settings.
  assert.throws(
    () => importPhoto(createPhotoProject('RAW test'), 'IMG_0001.nef', p1),
    /RAW camera files are not supported/,
    'a RAW file name must be refused with the honest reason'
  );
  assert.throws(() => resolveDevelopSettings({ exposure: 99 }), /"exposure" must be in the range/, 'out-of-range exposure must be refused');
  assert.throws(
    () => resolveDevelopSettings({ hsl: { red: { hue: 45 } } }),
    /"hsl\.red\.hue" must be in the range/,
    'out-of-range HSL hue shift must be refused'
  );
  assert.throws(
    () => resolveDevelopSettings({ sharpen: 3 } as any),
    /Unknown develop setting: "sharpen"/,
    'an unknown setting must be refused by name'
  );

  // The image gate refuses a project the engine cannot load.
  const badImage = ImageEditorWorkflow.verifyProject({ format: 'nope', layers: [] });
  assert.equal(badImage.verification.verified, false, 'a malformed image project must not verify');
  assert.ok(badImage.verification.checks.some((c) => !c.passed), 'the refusal must be a named failed check');
});
