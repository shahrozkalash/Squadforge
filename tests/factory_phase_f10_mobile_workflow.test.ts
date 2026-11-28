// Factory Phase F10 — the Mobile workflow (Android / iOS).
//
// A described mobile app flows through the factory machinery: the F5
// Mobile Development Team resolved from registry data, a real swarm
// build (stub transport; the delivered content is the platform's own
// generated Android project — the Phase 17/34 ClipForge generator
// output — so every delivered byte is platform-generated and the
// fixture is labelled as such), the F6 environment contract cycle,
// and the F10 mobile gate: structure, manifest, Gradle and resource
// consistency, a genuine Kotlin compile of the project's JVM-pure
// sources, execution of the generated app's own JVM unit tests, and
// the CI build-proof records.
//
// The claim split is asserted, not implied: the gate proves the
// generated project locally; the APK itself is produced by the Phase
// 34 GitHub Actions workflow (the gate verifies that workflow exists
// and still pins its evidence gates). One JVM test is
// environment-limited on this host by evidence — it exercises
// org.json, and the only org.json here is the Android SDK's stub
// android.jar; the real artifact is a declared testImplementation
// that Gradle resolves in CI, where the full 19/19 run is pinned.
// On a host where a real org.json jar is discoverable, the same test
// passes and the counts assert 19/19 instead.
//
// A broken variant (manifest package corrupted so it disagrees with
// the Gradle namespace; a Kotlin syntax error in a JVM-pure source)
// must fail the gate. For iOS, the gate verifies the generated
// FitTrack project with the platform's own validator and records the
// local build as environment-unavailable — no IPA, no signing,
// nothing fabricated. Broken iOS variants (tampered SDKROOT, a
// missing required file) must fail.

process.env.SQUADFORGE_TRUSTED_HOST_TESTS = '1';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';

import { db } from '../server/store.js';
import { smartRouter } from '../server/smartRouter.js';
import { SwarmOrchestrator } from '../server/swarm/swarmOrchestrator.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { CategoryTeamRegistry } from '../server/swarm/categoryTeams.js';
import {
  generateVideoEditorProject,
  getVideoEditorConfig
} from '../server/android/videoEditorGenerator.js';
import { IosProjectGenerator } from '../server/ios/iosProjectGenerator.js';
import { MobileWorkflow } from '../server/android/mobileWorkflow.js';
import { verifyAndroidProject } from '../server/android/mobileProjectGate.js';

const DESCRIPTION =
  'Build an Android app in Kotlin for cutting and arranging short videos on a multitrack timeline, ' +
  'with media import from the photo picker, ExoPlayer preview playback, and MP4 export';

// ---------------------------------------------------------------------------
// The swarm fixture: the platform's generated Android project, written
// by planner-chosen worker roles exactly as the generator produced
// it. The two files that cannot travel through the text file store —
// the binary Gradle wrapper jar and the machine-specific
// local.properties — are the build pipeline's own responsibility (it
// materializes the wrapper jar from its bundled asset and writes
// local.properties itself), so the fixture covers every text file and
// the gate requires exactly that set.
// ---------------------------------------------------------------------------

const GENERATED = generateVideoEditorProject(getVideoEditorConfig()) as Record<string, string>;
const EXCLUDED = new Set(['gradle/wrapper/gradle-wrapper.jar', 'local.properties']);
const FIXTURE: Record<string, string> = {};
for (const [p, c] of Object.entries(GENERATED)) {
  if (!EXCLUDED.has(p)) FIXTURE[p] = c;
}

const TASKS: Array<{ paths: string[]; title: string; description: string; role: string; priority: number }> = [
  {
    title: 'Configure the ClipForge Gradle build',
    description: 'Gradle settings, root and app build scripts, wrapper scripts and properties for the Android project',
    role: 'devops_release_specialist', priority: 3,
    paths: ['settings.gradle.kts', 'build.gradle.kts', 'app/build.gradle.kts', 'gradle.properties', '.gitignore', 'gradlew', 'gradlew.bat', 'app/proguard-rules.pro', 'gradle/wrapper/gradle-wrapper.properties']
  },
  {
    title: 'Create the app entry point, manifest and resources',
    description: 'AndroidManifest, MainActivity, launcher resources, the project item model and the main view model',
    role: 'fullstack_developer', priority: 2,
    paths: [
      'app/src/main/AndroidManifest.xml',
      'app/src/main/java/com/squadforge/clipforge/MainActivity.kt',
      'app/src/main/java/com/squadforge/clipforge/data/model/ProjectItem.kt',
      'app/src/main/java/com/squadforge/clipforge/viewmodel/MainViewModel.kt',
      'app/src/main/res/drawable/ic_launcher_background.xml',
      'app/src/main/res/drawable/ic_launcher_foreground.xml',
      'app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
      'app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml',
      'app/src/main/res/values/colors.xml',
      'app/src/main/res/values/strings.xml',
      'app/src/main/res/values/themes.xml',
      'app/src/main/res/xml/backup_rules.xml',
      'app/src/main/res/xml/data_extraction_rules.xml'
    ]
  },
  {
    title: 'Implement the editor core model and operations',
    description: 'The video project model with JSON round-trip, the editing operations, project persistence and the SquadForge API client',
    role: 'backend_developer', priority: 2,
    paths: [
      'app/src/main/java/com/squadforge/clipforge/editor/EditorModels.kt',
      'app/src/main/java/com/squadforge/clipforge/editor/EditorOps.kt',
      'app/src/main/java/com/squadforge/clipforge/editor/ProjectStore.kt',
      'app/src/main/java/com/squadforge/clipforge/editor/SquadForgeApi.kt'
    ]
  },
  {
    title: 'Implement the export planner, exporter and preview player',
    description: 'The pure-Kotlin export planner, the Media3 Transformer exporter and the ExoPlayer preview player',
    role: 'backend_developer', priority: 2,
    paths: [
      'app/src/main/java/com/squadforge/clipforge/export/ExportPlan.kt',
      'app/src/main/java/com/squadforge/clipforge/export/VideoExporter.kt',
      'app/src/main/java/com/squadforge/clipforge/player/PreviewPlayer.kt'
    ]
  },
  {
    title: 'Build the editor user interface',
    description: 'The Compose editor screen and view model, navigation host, home, details and permissions screens, and the app theme',
    role: 'frontend_developer', priority: 2,
    paths: [
      'app/src/main/java/com/squadforge/clipforge/ui/EditorScreen.kt',
      'app/src/main/java/com/squadforge/clipforge/ui/EditorViewModel.kt',
      'app/src/main/java/com/squadforge/clipforge/ui/screens/MainAppNavHost.kt',
      'app/src/main/java/com/squadforge/clipforge/ui/screens/HomeScreen.kt',
      'app/src/main/java/com/squadforge/clipforge/ui/screens/DetailsScreen.kt',
      'app/src/main/java/com/squadforge/clipforge/ui/screens/PermissionsScreen.kt',
      'app/src/main/java/com/squadforge/clipforge/ui/theme/Color.kt',
      'app/src/main/java/com/squadforge/clipforge/ui/theme/Theme.kt',
      'app/src/main/java/com/squadforge/clipforge/ui/theme/Type.kt'
    ]
  },
  {
    title: 'Write the JVM and instrumented tests and the readme',
    description: 'JUnit tests for the editor operations and the export planner, the template unit test, the on-device export parity test, and the project readme documenting the export behaviour',
    role: 'qa_testing_specialist', priority: 3,
    paths: [
      'app/src/test/java/com/squadforge/clipforge/EditorOpsTest.kt',
      'app/src/test/java/com/squadforge/clipforge/ExportPlannerTest.kt',
      'app/src/test/java/com/squadforge/clipforge/ExampleUnitTest.kt',
      'app/src/androidTest/java/com/squadforge/clipforge/ExampleInstrumentedTest.kt',
      'app/src/androidTest/java/com/squadforge/clipforge/ExportParityTest.kt',
      'VIDEO_EDITOR_README.md'
    ]
  }
];

const PLANNER_ACTIONS = TASKS.map(task => ({
  action: 'create_task',
  title: task.title,
  description: task.description,
  filePaths: task.paths,
  priority: task.priority,
  assignedRole: task.role
}));

let counter = 0;

function makeBuild(description: string): { buildId: string; userId: string } {
  const stamp = Date.now();
  const userId = 'usr_f10_mobile_' + stamp + '_' + ++counter;
  db.createUser({
    id: userId,
    email: userId + '@f10.test',
    name: userId,
    githubConnected: false,
    costLimitPerBuild: 25,
    enabledModelIds: ['gemini', 'claude', 'deepseek'],
    createdAt: stamp
  } as any);
  const buildId = 'bld_f10_mobile_' + stamp + '_' + counter;
  db.saveBuild({
    id: buildId,
    userId,
    idea: description,
    status: 'planning',
    createdAt: stamp,
    updatedAt: stamp,
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

function installStub(t: any, buildId: string): void {
  t.mock.method(smartRouter, 'executeSmartRequest', async (params: any) => {
    const modelId: string = params.requestedModelId || 'unknown';
    const prompt: string = params.prompt || '';
    if (prompt.includes('PROJECT MANAGER & ARCHITECT SPECIFICATION')) {
      return okResult(modelId, { thinking: 'plan', actions: PLANNER_ACTIONS });
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
      const existing = db.getFile(buildId, p);
      if (existing && existing.content !== FIXTURE[p]) {
        return {
          action: 'patch_file',
          path: p,
          edits: [{ find: existing.content, replace: FIXTURE[p] }],
          commitMessage: 'Implement ' + task?.title
        };
      }
      if (existing) return null;
      return { action: 'create_file', path: p, content: FIXTURE[p], commitMessage: 'Implement ' + task?.title };
    }).filter(Boolean);
    return okResult(modelId, { thinking: 'work', actions });
  });
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

async function runAndroidSwarmBuild(t: any): Promise<{ buildId: string; userId: string }> {
  const { buildId, userId } = makeBuild(DESCRIPTION);
  installStub(t, buildId);
  const stopPump = startApprovalPump(buildId, userId);
  try {
    await SwarmOrchestrator.startSwarm(buildId);
  } finally {
    stopPump();
  }

  const build = db.getBuild(buildId);
  const tasks = db.getTasks(buildId);
  const planned = tasks.filter(task => !task.isFixTask);
  const events = db.getEvents(buildId);

  assert.equal(build?.status, 'completed', 'swarm build must complete, got ' + build?.status + ': ' + (build?.error || build?.failureReason || ''));
  assert.equal(build?.projectType, 'android_application', 'the build must be classified by the platform analyzer');
  assert.ok(events.some(e => e.type === 'verifier_approved'), 'the completion verifier must approve before completion');
  for (const e of events.filter(e => e.type === 'sandbox_check')) {
    assert.match(e.details, /passed cleanly/, 'every sandbox integrity check in the run must pass');
  }
  assert.equal(planned.length, TASKS.length, 'expected the planner tasks, got ' + planned.length);
  for (const task of planned) {
    assert.equal(task.status, 'completed', 'task "' + task.title + '" must complete');
  }
  return { buildId, userId };
}

// ---------------------------------------------------------------------------
// (a) Android end-to-end: team → swarm build → contract cycle → gate
// ---------------------------------------------------------------------------

test('Factory F10: an Android app description flows team -> swarm -> contract -> mobile gate to a verified delivery', { timeout: 600_000 }, async (t) => {
  // Step 1 — team resolution from F5 data.
  const plan = MobileWorkflow.plan(DESCRIPTION);
  assert.equal(plan.category, 'android_application');
  assert.equal(plan.teamName, 'Mobile Development Team — Android');
  assert.equal(plan.profileId, 'android_mobile_application');
  assert.equal(plan.resolvedTeam.verifierModelId, 'claude',
    'the mobile team verification chain resolves its verifier through the registry');

  // Step 2 — the real swarm build.
  const { buildId, userId } = await runAndroidSwarmBuild(t);

  // The delivered tree is the platform's generated project, byte for byte.
  const delivered = new Map(db.getAllFiles(buildId).map(f => [f.path, f.content]));
  for (const [p, content] of Object.entries(FIXTURE)) {
    assert.equal(delivered.get(p), content, 'delivered file matches the generator output: ' + p);
  }

  // Steps 3–4 — environment contract cycle + mobile gate.
  const delivery = await MobileWorkflow.runEnvironmentCycle({
    projectId: buildId,
    userId,
    title: 'ClipForge Mobile (Factory F10)'
  });
  assert.equal(delivery.environment, 'web');
  assert.equal(delivery.build.status, 'skipped',
    'the web environment has no bundle entry point for a native Android tree — reported, not hidden');
  assert.equal(delivery.tests.status, 'skipped',
    'the web environment cannot discover Kotlin tests — the mobile gate runs them instead');
  assert.ok(typeof delivery.previewMode === 'string' && delivery.previewMode.length > 0,
    'a preview must be produced with its mode labelled');
  assert.equal(delivery.artifact.kind, 'zip');
  assert.ok(delivery.artifact.sizeBytes > 0, 'the exported artifact must be non-empty');
  assert.match(delivery.artifact.sha256 || '', /^[0-9a-f]{64}$/, 'the exported artifact must carry a SHA-256');
  assert.ok(delivery.artifact.path && fs.existsSync(delivery.artifact.path), 'the exported artifact must exist on disk');
  const artifactBytes = fs.readFileSync(delivery.artifact.path!);
  assert.equal(
    crypto.createHash('sha256').update(artifactBytes).digest('hex'),
    delivery.artifact.sha256,
    'the artifact hash must match the bytes on disk'
  );

  // The mobile gate.
  const gate = delivery.gate;
  assert.equal(gate.passed, true,
    'gate errors: ' + JSON.stringify({
      structure: gate.structureErrors,
      manifest: gate.manifestErrors,
      gradle: gate.gradleErrors,
      resource: gate.resourceErrors,
      kotlin: gate.kotlin.detail
    }));
  assert.equal(gate.packageName, 'com.squadforge.clipforge');
  assert.equal(gate.wrapperAssets.valid, true);
  assert.equal(gate.kotlin.toolchainAvailable, true);
  assert.equal(gate.kotlin.compileOk, true, gate.kotlin.compileErrors.join('\n'));
  assert.ok(gate.kotlin.compiledSources.some(p => p.endsWith('/editor/EditorOps.kt')));
  assert.ok(gate.kotlin.compiledSources.some(p => p.endsWith('/export/ExportPlan.kt')));
  assert.ok(gate.kotlin.excludedSources.some(p => p.endsWith('/MainActivity.kt')),
    'runtime-bound sources are reported as excluded, not silently dropped');
  assert.equal(gate.kotlin.testsFailed, 0, 'no genuine JVM test failures');
  assert.equal(gate.kotlin.testsRun, 19, 'the generated app JVM suite size matches the CI pin');
  if (gate.kotlin.toolchain?.orgJsonJar) {
    assert.equal(gate.kotlin.testsPassed, 19, 'with a real org.json on the host, the full suite passes locally');
    assert.deepEqual(gate.kotlin.environmentLimitedTests, []);
  } else {
    assert.equal(gate.kotlin.testsPassed, 18);
    assert.equal(gate.kotlin.environmentLimitedTests.length, 1);
    assert.match(gate.kotlin.environmentLimitedTests[0], /jsonRoundTripPreservesTheProject/);
    assert.match(gate.kotlin.environmentLimitedTests[0], /org\.json/);
  }

  // The CI build-proof record: named, checkable, and complete.
  assert.equal(gate.ciBuildProof.complete, true,
    'missing CI proof checks: ' + JSON.stringify(gate.ciBuildProof.checks.filter(c => !c.present)));
  assert.ok(gate.ciBuildProof.checks.some(c => /19 JVM tests/.test(c.name) && c.present));
  assert.ok(gate.ciBuildProof.checks.some(c => /apksigner/.test(c.name) && c.present));
  assert.match(gate.ciBuildProof.produces, /GitHub-hosted runner/);

  assert.equal(delivery.verified, true, 'gate passed + real artifact = verified delivery');
});

// ---------------------------------------------------------------------------
// (b) Broken Android variants are refused
// ---------------------------------------------------------------------------

test('Factory F10: a broken Android variant fails the mobile gate', { timeout: 600_000 }, async () => {
  // Variant 1: the manifest package no longer agrees with the Gradle config.
  const manifestBroken: Record<string, string> = { ...GENERATED };
  manifestBroken['app/src/main/AndroidManifest.xml'] = manifestBroken['app/src/main/AndroidManifest.xml']
    .replace('package="com.squadforge.clipforge"', 'package="com.example.broken"');
  const gate1 = await verifyAndroidProject(manifestBroken);
  assert.equal(gate1.passed, false, 'a manifest/Gradle package mismatch must fail the gate');
  assert.ok(gate1.gradleErrors.some(e => /namespace/.test(e) && /com\.example\.broken/.test(e)),
    'the failure names the namespace/package mismatch: ' + JSON.stringify(gate1.gradleErrors));

  // Variant 2: uncompilable Kotlin in a JVM-pure source.
  const kotlinBroken: Record<string, string> = { ...GENERATED };
  const exportPlanPath = 'app/src/main/java/com/squadforge/clipforge/export/ExportPlan.kt';
  kotlinBroken[exportPlanPath] = kotlinBroken[exportPlanPath] + '\nthis is not valid kotlin at all {{{\n';
  const gate2 = await verifyAndroidProject(kotlinBroken);
  assert.equal(gate2.passed, false, 'uncompilable Kotlin must fail the gate');
  assert.equal(gate2.kotlin.compileOk, false);
  assert.ok(gate2.kotlin.compileErrors.some(e => /ExportPlan\.kt/.test(e)),
    'the compile failure names the broken file: ' + JSON.stringify(gate2.kotlin.compileErrors));

  // The delivery verdict refuses the broken gate even with a real artifact.
  const artifact = { path: 'x.zip', kind: 'zip' as const, sizeBytes: 1234, sha256: 'x' } as any;
  assert.equal(MobileWorkflow.verifyDelivery({ artifact, gate: gate1 }), false);
  assert.equal(MobileWorkflow.verifyDelivery({ artifact, gate: gate2 }), false);
});

// ---------------------------------------------------------------------------
// (c) iOS: generated-project verification, honest build status
// ---------------------------------------------------------------------------

test('Factory F10: the iOS gate verifies the generated project and records the honest build status', { timeout: 120_000 }, async () => {
  // Audit finding, pinned: the platform has no iOS category/team —
  // the iOS engine is a standalone generator + validator + macOS
  // pipeline, so the workflow's iOS path is a gate, not a team build.
  assert.equal(
    CategoryTeamRegistry.getAll().some(team => (team.category as string) === 'ios_application'),
    false,
    'no iOS team exists in the F5 registry data'
  );

  const iosConfig = IosProjectGenerator.getDefaultConfig('FitTrack', 'com.squadforge.fittrack');
  const iosFiles = IosProjectGenerator.generateProjectFiles(iosConfig) as Record<string, string>;

  const gate = await MobileWorkflow.verifyIosProject(iosFiles, iosConfig);
  assert.equal(gate.passed, true, 'validation errors: ' + JSON.stringify(gate.validation.errors));
  assert.equal(gate.validation.valid, true);
  assert.deepEqual(gate.validation.errors, []);
  assert.equal(gate.localBuild.status, 'environment-unavailable',
    'no iOS build is possible on this Linux host — recorded, not fabricated');
  assert.match(gate.localBuild.reason || '', /macOS/);
  assert.equal(gate.ciBuildProof.complete, true,
    'missing iOS CI proof checks: ' + JSON.stringify(gate.ciBuildProof.checks.filter(c => !c.present)));
  assert.match(gate.ciBuildProof.produces, /Mach-O/);

  // Broken variant 1: a tampered SDKROOT must fail structural validation.
  const pbxPath = 'FitTrack.xcodeproj/project.pbxproj';
  const tampered: Record<string, string> = { ...iosFiles };
  tampered[pbxPath] = tampered[pbxPath].replaceAll('SDKROOT = iphoneos', 'SDKROOT = macosx');
  const gateTampered = await MobileWorkflow.verifyIosProject(tampered, iosConfig);
  assert.equal(gateTampered.passed, false);
  assert.ok(gateTampered.validation.errors.some(e => /SDKROOT/.test(e)),
    'the failure names the SDKROOT problem: ' + JSON.stringify(gateTampered.validation.errors));

  // Broken variant 2: a missing required SwiftUI view must fail.
  const incomplete: Record<string, string> = { ...iosFiles };
  delete incomplete['FitTrack/ContentView.swift'];
  const gateIncomplete = await MobileWorkflow.verifyIosProject(incomplete, iosConfig);
  assert.equal(gateIncomplete.passed, false);
  assert.ok(gateIncomplete.validation.errors.some(e => /ContentView\.swift/.test(e)),
    'the failure names the missing file: ' + JSON.stringify(gateIncomplete.validation.errors));
});
