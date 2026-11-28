/**
 * Factory Phase F13 — the unified describe → delivered pipeline.
 *
 * One entry point, `deliverFromDescription`, takes a plain-language
 * description and runs the whole Factory chain for it:
 *
 *   description
 *     → classification (the platform's existing analyzer —
 *       SoftwareRequirementsAnalyzer.detectCategory, the same call
 *       the F5 team registry makes)
 *     → route (this module's only decision: which Arc D workflow
 *       serves the detected category — a category with no Arc D
 *       workflow fails by name, it is never guessed into another
 *       category's workflow)
 *     → team + profile (F5 data, via the workflow's own plan())
 *     → swarm build (the real SwarmOrchestrator chain, driven by
 *       this pipeline: it creates the build, answers approval
 *       requests only through the caller's responder, and waits for
 *       the chain to finish)
 *     → the category workflow's F6 environment cycle
 *     → the category's own verification gate (composed here from
 *       the workflow's gate report — no gate logic is reimplemented)
 *     → one uniform FactoryDeliveryRecord, persisted on the build
 *       as a `factory_delivery` event and returned to the caller.
 *
 * Honesty rules held by this facade:
 *  - Unclassifiable or unrouted input fails at planning with a named
 *    UnifiedPipelineError, before any build exists — no partial fake
 *    delivery (roadmap F13 criterion 2).
 *  - Gate inputs a workflow cannot run without (a web/AI contract,
 *    photo originals) are required up front and fail by name at
 *    planning, not midway through a build.
 *  - A build or gate failure RETURNS a record with status 'failed'
 *    and the reasons named — failed validation stays visible
 *    (invariant 5); it is never dressed up as a delivery.
 *  - Every record carries honest labels: the model calls behind a
 *    build are served by whatever transport the caller's environment
 *    provides (in this environment: a stub transport — no live
 *    provider exists, F1 verdict), and delivered trees come from the
 *    category's established fixture seam unless a live path exists.
 *
 * This module is a dispatcher/facade. It contains no category logic:
 * classification is the analyzer's, teams are F5 data, building is
 * the swarm's, cycles and gates are the Arc D workflows' (F7–F12).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { db } from '../store.js';
import type { CanonicalProjectType } from '../types.js';
import { SoftwareRequirementsAnalyzer } from '../architecture/requirementsAnalyzer.js';
import { SwarmOrchestrator } from '../swarm/swarmOrchestrator.js';
import { ApprovalGateService } from '../swarm/approvalGateService.js';
import { GameWorkflow } from '../gameEngine/gameWorkflow.js';
import { VideoEditorWorkflow } from '../videoEditor/videoWorkflow.js';
import { ImageEditorWorkflow } from '../imageEditor/imageWorkflow.js';
import { PhotoEditorWorkflow } from '../imageEditor/photoWorkflow.js';
import { WebWorkflow } from '../application/webWorkflow.js';
import type { WebAppContract } from '../application/webRuntimeProbe.js';
import { MobileWorkflow } from '../android/mobileWorkflow.js';
import { DesktopWorkflow } from '../desktop/desktopWorkflow.js';
import { CliToolWorkflow } from '../ide/cliWorkflow.js';
import { AiWorkflow, platformGatewayModulePath } from '../application/aiWorkflow.js';
import type { AiAppContract, AiStubProvider } from '../application/aiAppGate.js';
import type { EnvironmentArtifact } from '../environment/index.js';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** The Arc D workflows this pipeline can route to. */
export type FactoryWorkflowRoute =
  | 'game'
  | 'video-editor'
  | 'image-editor'
  | 'photo-editor'
  | 'web'
  | 'mobile'
  | 'desktop'
  | 'cli'
  | 'ai';

export interface FactoryGateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface FactoryArtifactReference {
  name: string;
  kind: string;
  sizeBytes: number;
  sha256?: string;
  path?: string;
}

/**
 * The one uniform delivery record every route returns. A delivery
 * without this record does not exist as far as the factory is
 * concerned (roadmap F13 criterion 3): the record is persisted on
 * the build as a `factory_delivery` event before it is returned.
 */
export interface FactoryDeliveryRecord {
  id: string;
  description: string;
  /** The canonical category the analyzer detected. */
  category: string;
  /** The Arc D workflow that served the request. */
  workflow: FactoryWorkflowRoute;
  teamName: string;
  profileId: string;
  verifierModelId: string;
  /** The swarm build this delivery ran as (the project id). */
  projectId: string;
  buildStatus: string;
  environment: string;
  gate: {
    /** The category gate's name (playability, runtime probes, …). */
    name: string;
    passed: boolean;
    checks: FactoryGateCheck[];
  };
  artifact: FactoryArtifactReference | null;
  /** The category workflow's own delivery verdict. */
  verified: boolean;
  status: 'delivered' | 'failed';
  failureReasons: string[];
  /** Human-readable evidence lines: what was run, what passed. */
  evidence: string[];
  /** Honest labels (stub transport, fixture content, per-category). */
  labels: string[];
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

export type UnifiedPipelineErrorCode = 'UNSUPPORTED_CATEGORY' | 'MISSING_GATE_INPUT';

/** A planning-stage refusal, named — never a guessed category. */
export class UnifiedPipelineError extends Error {
  readonly code: UnifiedPipelineErrorCode;
  readonly category?: string;

  constructor(code: UnifiedPipelineErrorCode, message: string, category?: string) {
    super(message);
    this.name = 'UnifiedPipelineError';
    this.code = code;
    this.category = category;
  }
}

export interface UnifiedPipelineOptions {
  /** Existing platform user to own the build; created when omitted. */
  userId?: string;
  /**
   * Project title passed to the category workflow. For the desktop
   * route this is functional — the app name the delivered project
   * was generated for (the F6 desktop adapter derives its config
   * from it). Defaults to the description.
   */
  title?: string;
  /** Worker models for the swarm build. Defaults to the proven set. */
  selectedModels?: string[];
  /**
   * Approval responder for the swarm's approval gate (invariant 1:
   * approval must be real). The pipeline never approves on its own:
   * without a responder, held tasks stay held and the build ends on
   * its own terms. A test harness passes an approve responder and
   * thereby takes the owner's place for its fixture builds, exactly
   * as the F7–F12 suites' approval pumps did.
   */
  approvalResponder?: (request: { id: string }) => boolean | Promise<boolean>;
  /** Scratch root for the video package dir and desktop roots. */
  scratchRoot?: string;
  /** Required for the web route: the app's declared route contract. */
  webContract?: WebAppContract;
  /** Required for the AI route: the app's declared probe contract. */
  aiContract?: AiAppContract;
  /** The AI route's stub provider (Phase 33 seam), when used. */
  aiStubProvider?: AiStubProvider;
  /** The AI route's round-trip model ids, when stub runs are used. */
  aiModelIds?: string[];
  /**
   * Required for the photo route: the catalogued originals' bytes,
   * keyed by file name. Originals are never in the delivered tree;
   * the caller supplies them out-of-band and the gate verifies them
   * by SHA-256.
   */
  photoSources?: Map<string, Buffer>;
}

// ---------------------------------------------------------------------------
// Routing — the facade's only decision
// ---------------------------------------------------------------------------

const MULTIMEDIA_ROUTES: Array<{ kind: string; route: FactoryWorkflowRoute; pattern: RegExp }> = [
  { kind: 'photo editor', route: 'photo-editor', pattern: /\bphoto\b/ },
  { kind: 'video editor', route: 'video-editor', pattern: /\bvideo\b/ },
  { kind: 'image editor', route: 'image-editor', pattern: /\bimage\b/ }
];

function routeForCategory(category: CanonicalProjectType, description: string): FactoryWorkflowRoute {
  switch (category) {
    case 'game_application':
      return 'game';
    case 'multimedia_application': {
      const text = description.toLowerCase();
      for (const candidate of MULTIMEDIA_ROUTES) {
        if (candidate.pattern.test(text)) return candidate.route;
      }
      throw new UnifiedPipelineError(
        'UNSUPPORTED_CATEGORY',
        `Category 'multimedia_application' has three Arc D workflows (video, image, photo editors), ` +
          `but the description names none of them — no editor kind can be routed honestly. ` +
          `Description: "${description}"`,
        category
      );
    }
    case 'saas':
    case 'api_service':
    case 'web_application':
      return 'web';
    case 'android_application':
    case 'cross_platform_mobile':
      return 'mobile';
    case 'desktop_application':
    case 'cross_platform_desktop':
    case 'windows_application':
      return 'desktop';
    case 'cli_tool':
      return 'cli';
    case 'ai_application':
      return 'ai';
    default:
      throw new UnifiedPipelineError(
        'UNSUPPORTED_CATEGORY',
        `Category '${category}' has no Arc D category workflow in the factory — ` +
          `the unified pipeline cannot deliver it and will not guess another category. ` +
          `Routed categories: game_application, multimedia_application (video/image/photo editors), ` +
          `saas, api_service, web_application, android_application, cross_platform_mobile, ` +
          `desktop_application, cross_platform_desktop, windows_application, cli_tool, ai_application. ` +
          `Description: "${description}"`,
        category
      );
  }
}

function requireGateInputs(route: FactoryWorkflowRoute, options: UnifiedPipelineOptions): void {
  if (route === 'web' && !options.webContract) {
    throw new UnifiedPipelineError(
      'MISSING_GATE_INPUT',
      'The web route requires options.webContract (the application\'s declared route contract) — ' +
        'the F9 runtime gate probes a running app against its contract, and the pipeline will not invent one.'
    );
  }
  if (route === 'ai' && !options.aiContract) {
    throw new UnifiedPipelineError(
      'MISSING_GATE_INPUT',
      'The AI route requires options.aiContract (the application\'s declared probe contract) — ' +
        'the F12 gate probes the app\'s surface and AI endpoint against it, and the pipeline will not invent one.'
    );
  }
  if (route === 'photo-editor' && !options.photoSources) {
    throw new UnifiedPipelineError(
      'MISSING_GATE_INPUT',
      'The photo route requires options.photoSources (the catalogued originals\' bytes, keyed by file name) — ' +
        'originals are never stored in the delivered tree, and the F8 photo gate verifies them by SHA-256.'
    );
  }
}

function planFor(route: FactoryWorkflowRoute, description: string) {
  switch (route) {
    case 'game':
      return GameWorkflow.plan(description);
    case 'video-editor':
      return VideoEditorWorkflow.plan(description);
    case 'image-editor':
      return ImageEditorWorkflow.plan(description);
    case 'photo-editor':
      return PhotoEditorWorkflow.plan(description);
    case 'web':
      return WebWorkflow.plan(description);
    case 'mobile':
      return MobileWorkflow.plan(description);
    case 'desktop':
      return DesktopWorkflow.plan(description);
    case 'cli':
      return CliToolWorkflow.plan(description);
    case 'ai':
      return AiWorkflow.plan(description);
  }
}

// ---------------------------------------------------------------------------
// The swarm build step (owned by the pipeline, driven by the caller)
// ---------------------------------------------------------------------------

let pipelineCounter = 0;

async function runSwarmBuild(
  description: string,
  options: UnifiedPipelineOptions
): Promise<{ buildId: string; userId: string }> {
  const stamp = `${Date.now()}_${++pipelineCounter}`;
  const selectedModels = options.selectedModels ?? ['gemini', 'claude', 'deepseek'];
  const userId = options.userId ?? `usr_factory_${stamp}`;
  if (!db.getUser(userId)) {
    db.createUser({
      id: userId,
      email: `${userId}@factory.local`,
      name: userId,
      githubConnected: false,
      costLimitPerBuild: 25,
      enabledModelIds: selectedModels,
      createdAt: Date.now()
    } as any);
  }

  const buildId = `bld_factory_${stamp}`;
  db.saveBuild({
    id: buildId,
    userId,
    idea: description,
    status: 'planning',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selectedModels,
    autoPushGithub: false,
    totalTokens: 0,
    totalCost: 0,
    costLimit: 25,
    maxDurationSeconds: 600,
    patchesAppliedCount: 0
  } as any);

  let stopPump: () => void = () => {};
  if (options.approvalResponder) {
    const responder = options.approvalResponder;
    const timer = setInterval(async () => {
      try {
        for (const req of db.getApprovalRequests(buildId, 'pending')) {
          const approved = await responder(req);
          const decided = ApprovalGateService.respondToApproval(buildId, userId, {
            requestId: req.id,
            approved
          });
          if (decided.success && decided.request) {
            await SwarmOrchestrator.resolveHeldTask(decided.request);
          }
        }
      } catch {
        // The pump must never take the pipeline down with it.
      }
    }, 150);
    stopPump = () => clearInterval(timer);
  }

  try {
    await SwarmOrchestrator.startSwarm(buildId);
  } finally {
    stopPump();
  }
  return { buildId, userId };
}

// ---------------------------------------------------------------------------
// Gate composition — each route's checks come from its own gate report
// ---------------------------------------------------------------------------

interface ComposedGate {
  environment: string;
  gateName: string;
  gatePassed: boolean;
  checks: FactoryGateCheck[];
  artifact: EnvironmentArtifact | null;
  verified: boolean;
  evidence: string[];
  labels: string[];
  failureReasons: string[];
}

function artifactRef(artifact: EnvironmentArtifact | null): FactoryArtifactReference | null {
  if (!artifact) return null;
  return {
    name: artifact.name,
    kind: artifact.kind,
    sizeBytes: artifact.sizeBytes,
    ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    ...(artifact.path ? { path: artifact.path } : {})
  };
}

function artifactEvidence(artifact: EnvironmentArtifact | null): string {
  if (!artifact) return 'artifact: none exported';
  return (
    `artifact: ${artifact.name} (${artifact.kind}, ${artifact.sizeBytes} bytes` +
    `${artifact.sha256 ? `, sha256 ${artifact.sha256}` : ', no sha256 reported'}${artifact.path ? `, at ${artifact.path}` : ''})`
  );
}

function testsEvidence(label: string, tests: { status: string; passed: number; total: number; failed: number; mode: string }): string {
  return `${label}: ${tests.status} (${tests.passed}/${tests.total} passed, ${tests.failed} failed, mode ${tests.mode})`;
}

function writePackageFiles(files: Array<{ path: string; content: string }>, dir: string): void {
  for (const file of files) {
    const target = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf-8');
  }
}

async function composeGate(
  route: FactoryWorkflowRoute,
  input: { buildId: string; userId: string; title: string; scratchRoot: string },
  options: UnifiedPipelineOptions
): Promise<ComposedGate> {
  const { buildId, userId, title } = input;
  switch (route) {
    case 'game': {
      const delivery = await GameWorkflow.runEnvironmentCycle({ projectId: buildId, userId, title });
      const failureReasons: string[] = [];
      if (delivery.tests.status !== 'passed' || delivery.tests.failed > 0) {
        failureReasons.push(`environment test cycle did not pass: ${delivery.tests.detail}`);
      }
      if (delivery.artifact.sizeBytes <= 0) failureReasons.push('the exported artifact is empty');
      for (const check of delivery.playability.checks.filter(c => !c.passed)) {
        failureReasons.push(`playability check failed — ${check.name}: ${check.detail}`);
      }
      for (const err of delivery.playability.runtimeErrors) {
        failureReasons.push(`playability runtime error: ${err}`);
      }
      return {
        environment: delivery.environment,
        gateName: 'playability (headless execution of the delivered game)',
        gatePassed: delivery.playability.playable,
        checks: delivery.playability.checks.map(c => ({ name: c.name, passed: c.passed, detail: c.detail })),
        artifact: delivery.artifact,
        verified: delivery.verified,
        evidence: [
          testsEvidence('environment tests', delivery.tests),
          `playability: ${delivery.playability.stepsSimulated} steps simulated, playable=${delivery.playability.playable}` +
            (delivery.playability.finalState
              ? `, final state ${delivery.playability.finalState.state}, score ${delivery.playability.finalState.score}, coins ${delivery.playability.finalState.coins}`
              : ''),
          artifactEvidence(delivery.artifact)
        ],
        labels: ['platform-generator-content'],
        failureReasons
      };
    }

    case 'video-editor': {
      const cycle = await VideoEditorWorkflow.runEnvironmentCycle({ projectId: buildId, userId, title });
      const packageDir = path.join(input.scratchRoot, 'video-package');
      writePackageFiles(cycle.files, packageDir);
      const verification = await VideoEditorWorkflow.verifyExport(packageDir);
      const failureReasons: string[] = [];
      if (cycle.tests.status !== 'passed' || cycle.tests.failed > 0) {
        failureReasons.push(`environment test cycle did not pass: ${cycle.tests.detail}`);
      }
      if (cycle.artifact.sizeBytes <= 0) failureReasons.push('the exported artifact is empty');
      for (const check of verification.checks.filter(c => !c.passed)) {
        failureReasons.push(`export verification failed — ${check.name}: ${check.detail}`);
      }
      const verified =
        cycle.tests.status === 'passed' &&
        cycle.tests.failed === 0 &&
        cycle.artifact.sizeBytes > 0 &&
        verification.verified;
      return {
        environment: cycle.environment,
        gateName: 'video export verification (genuine ffmpeg render, ffprobe + decoded frames + audio RMS)',
        gatePassed: verification.verified,
        checks: verification.checks.map(c => ({ name: c.name, passed: c.passed, detail: c.detail })),
        artifact: cycle.artifact,
        verified,
        evidence: [
          testsEvidence('environment tests', cycle.tests),
          `export render: expected duration ${verification.expectedDurationSec ?? 'n/a'}s, probed ${verification.probedDurationSec ?? 'n/a'}s` +
            (verification.exportPath ? `, rendered at ${verification.exportPath}` : ''),
          artifactEvidence(cycle.artifact)
        ],
        labels: ['fixture-media'],
        failureReasons
      };
    }

    case 'image-editor': {
      const cycle = await ImageEditorWorkflow.runEnvironmentCycle({ projectId: buildId, userId, title });
      const projectFile = cycle.files.find(f => f.path === 'project/image-project.json');
      const failureReasons: string[] = [];
      let checks: FactoryGateCheck[];
      let gatePassed = false;
      let compositeNote = '';
      if (!projectFile) {
        checks = [
          {
            name: 'delivered project present',
            passed: false,
            detail: 'project/image-project.json is missing from the delivered tree'
          }
        ];
        failureReasons.push('the delivered tree has no project/image-project.json to verify');
      } else {
        const { verification } = ImageEditorWorkflow.verifyProject(JSON.parse(projectFile.content));
        checks = verification.checks.map(c => ({ name: c.name, passed: c.passed, detail: c.detail }));
        gatePassed = verification.verified;
        compositeNote = verification.compositeSha256
          ? `project composite sha256 ${verification.compositeSha256}` +
            (verification.chainedCompositeSha256 ? `, after the workflow operation chain ${verification.chainedCompositeSha256}` : '')
          : 'no composite hash reported';
        for (const check of verification.checks.filter(c => !c.passed)) {
          failureReasons.push(`project verification failed — ${check.name}: ${check.detail}`);
        }
      }
      if (cycle.tests.status !== 'passed' || cycle.tests.failed > 0) {
        failureReasons.push(`environment test cycle did not pass: ${cycle.tests.detail}`);
      }
      if (cycle.artifact.sizeBytes <= 0) failureReasons.push('the exported artifact is empty');
      const verified =
        cycle.tests.status === 'passed' && cycle.tests.failed === 0 && cycle.artifact.sizeBytes > 0 && gatePassed;
      return {
        environment: cycle.environment,
        gateName: 'image project verification (engine round trip + operation chain, pixel-exact)',
        gatePassed,
        checks,
        artifact: cycle.artifact,
        verified,
        evidence: [testsEvidence('environment tests', cycle.tests), compositeNote, artifactEvidence(cycle.artifact)],
        labels: [],
        failureReasons
      };
    }

    case 'photo-editor': {
      const cycle = await PhotoEditorWorkflow.runEnvironmentCycle({ projectId: buildId, userId, title });
      const projectFile = cycle.files.find(f => f.path === 'photo-project.json');
      const failureReasons: string[] = [];
      let checks: FactoryGateCheck[];
      let gatePassed = false;
      const photoEvidence: string[] = [];
      if (!projectFile) {
        checks = [
          {
            name: 'delivered catalog present',
            passed: false,
            detail: 'photo-project.json is missing from the delivered tree'
          }
        ];
        failureReasons.push('the delivered tree has no photo-project.json to verify');
      } else {
        const verification = PhotoEditorWorkflow.verifyDelivery({
          deliveredProject: JSON.parse(projectFile.content),
          sources: options.photoSources!
        });
        checks = verification.checks.map(c => ({ name: c.name, passed: c.passed, detail: c.detail }));
        gatePassed = verification.verified;
        for (const photo of verification.photos) {
          photoEvidence.push(
            `photo ${photo.fileName}: original sha256 unchanged (${photo.sourceSha256Before.slice(0, 12)}…), ` +
              `mean luminance ${photo.meanLuminanceBefore.toFixed(1)} → ${photo.meanLuminanceAfter.toFixed(1)} after develop` +
              (photo.exportedByteSize ? `, batch export ${photo.exportedByteSize} bytes` : '')
          );
        }
        for (const check of verification.checks.filter(c => !c.passed)) {
          failureReasons.push(`photo verification failed — ${check.name}: ${check.detail}`);
        }
      }
      if (cycle.tests.status !== 'passed' || cycle.tests.failed > 0) {
        failureReasons.push(`environment test cycle did not pass: ${cycle.tests.detail}`);
      }
      if (cycle.artifact.sizeBytes <= 0) failureReasons.push('the exported artifact is empty');
      const verified =
        cycle.tests.status === 'passed' && cycle.tests.failed === 0 && cycle.artifact.sizeBytes > 0 && gatePassed;
      return {
        environment: cycle.environment,
        gateName: 'photo delivery verification (originals by SHA-256, develop + batch export, originals untouched)',
        gatePassed,
        checks,
        artifact: cycle.artifact,
        verified,
        evidence: [testsEvidence('environment tests', cycle.tests), ...photoEvidence, artifactEvidence(cycle.artifact)],
        labels: ['originals-supplied-out-of-band'],
        failureReasons
      };
    }

    case 'web': {
      const delivery = await WebWorkflow.runEnvironmentCycle({
        projectId: buildId,
        userId,
        title,
        contract: options.webContract!
      });
      const failureReasons: string[] = [];
      if (delivery.tests.status !== 'passed' || delivery.tests.failed > 0) {
        failureReasons.push(`environment test cycle did not pass: ${delivery.tests.detail}`);
      }
      if (delivery.artifact.sizeBytes <= 0) failureReasons.push('the exported artifact is empty');
      for (const probe of delivery.runtime.probes.filter(p => !p.passed)) {
        failureReasons.push(`runtime probe failed — ${probe.name}: ${probe.detail}`);
      }
      for (const err of delivery.runtime.errors) {
        failureReasons.push(`runtime gate error: ${err}`);
      }
      return {
        environment: delivery.environment,
        gateName: 'runtime contract probes (the delivered app, started and probed over real HTTP)',
        gatePassed: delivery.runtime.passed,
        checks: delivery.runtime.probes.map(p => ({ name: p.name, passed: p.passed, detail: p.detail })),
        artifact: delivery.artifact,
        verified: delivery.verified,
        evidence: [
          testsEvidence('environment tests', delivery.tests),
          `runtime gate: app started=${delivery.runtime.started}` +
            (delivery.runtime.entryPoint ? `, entry ${delivery.runtime.entryPoint}` : '') +
            `, ${delivery.runtime.probes.filter(p => p.passed).length}/${delivery.runtime.probes.length} probes passed`,
          artifactEvidence(delivery.artifact)
        ],
        labels: ['loopback-runtime-gate'],
        failureReasons
      };
    }

    case 'mobile': {
      const delivery = await MobileWorkflow.runEnvironmentCycle({ projectId: buildId, userId, title });
      const gate = delivery.gate;
      const errorCheck = (name: string, errors: string[]): FactoryGateCheck => ({
        name,
        passed: errors.length === 0,
        detail: errors.length === 0 ? 'no errors' : errors.join('; ')
      });
      const checks: FactoryGateCheck[] = [
        errorCheck('project structure', gate.structureErrors),
        errorCheck('Android manifest', gate.manifestErrors),
        errorCheck('Gradle configuration', gate.gradleErrors),
        errorCheck('resources', gate.resourceErrors),
        {
          name: 'gradle wrapper assets',
          passed: gate.wrapperAssets.valid,
          detail: gate.wrapperAssets.valid ? 'wrapper assets valid' : gate.wrapperAssets.errors.join('; ')
        },
        {
          name: 'Kotlin compile (JVM-pure sources)',
          passed: gate.kotlin.compileOk,
          detail: gate.kotlin.detail
        },
        {
          name: 'JVM tests executed',
          passed: gate.kotlin.testsFailed === 0 && gate.kotlin.testsRun > 0,
          detail:
            `${gate.kotlin.testsPassed}/${gate.kotlin.testsRun} passed, ${gate.kotlin.testsFailed} failed` +
            (gate.kotlin.environmentLimitedTests.length > 0
              ? `; environment-limited (not counted as passes): ${gate.kotlin.environmentLimitedTests.join(', ')}`
              : '')
        },
        {
          name: 'CI build-proof records',
          passed: gate.ciBuildProof.complete,
          detail: gate.ciBuildProof.complete
            ? `CI produces what this host cannot: ${gate.ciBuildProof.produces}`
            : `incomplete — ${gate.ciBuildProof.checks.filter(c => !c.present).map(c => c.name).join(', ')}`
        }
      ];
      const failureReasons: string[] = [];
      for (const check of checks.filter(c => !c.passed)) {
        failureReasons.push(`mobile gate failed — ${check.name}: ${check.detail}`);
      }
      if (delivery.artifact.sizeBytes <= 0) failureReasons.push('the exported artifact is empty');
      return {
        environment: delivery.environment,
        gateName: 'Android project gate (structure/manifest/Gradle/resources, Kotlin compile, JVM tests, CI build proof)',
        gatePassed: gate.passed,
        checks,
        artifact: delivery.artifact,
        verified: delivery.verified,
        evidence: [
          `android package: ${gate.packageName}`,
          `kotlin: ${gate.kotlin.compiledSources.length} sources compiled, ${gate.kotlin.excludedSources.length} runtime-bound sources excluded by name`,
          testsEvidence('environment tests (reported, not the verdict — the web environment cannot run Kotlin tests)', delivery.tests),
          artifactEvidence(delivery.artifact)
        ],
        labels: ['no-local-apk', 'apk-is-ci-produced'],
        failureReasons
      };
    }

    case 'desktop': {
      const delivery = await DesktopWorkflow.runEnvironmentCycle({
        buildId,
        title,
        workspaceRoot: path.join(input.scratchRoot, 'desktop-workspaces'),
        artifactsRoot: path.join(input.scratchRoot, 'desktop-artifacts'),
        windowsScratchRoot: path.join(input.scratchRoot, 'desktop-windows')
      });
      const failureReasons: string[] = [];
      for (const check of delivery.gate.checks.filter(c => !c.ok)) {
        failureReasons.push(`desktop gate failed — ${check.name}: ${check.detail}`);
      }
      return {
        environment: delivery.environment,
        gateName: 'desktop delivery gate (genuine build, persistent smoke runs, ELF artifact, Windows package + tamper check)',
        gatePassed: delivery.gate.passed,
        checks: delivery.gate.checks.map(c => ({ name: c.name, passed: c.ok, detail: c.detail })),
        artifact: delivery.artifact,
        verified: delivery.verified,
        evidence: [
          `desktop build: ${delivery.build.status}`,
          `smoke runs: ${delivery.smokeRuns.length}, persisted LaunchCount sequence ${delivery.launchCounts.join(' → ') || 'none'}`,
          artifactEvidence(delivery.artifact)
        ],
        labels: ['gui-never-run', 'windows-package-verified-only'],
        failureReasons
      };
    }

    case 'cli': {
      const delivery = await CliToolWorkflow.runEnvironmentCycle({ projectId: buildId, userId, title });
      const failureReasons: string[] = [];
      for (const gateCase of delivery.gate.cases.filter(c => !c.ok)) {
        failureReasons.push(`CLI gate case failed — ${gateCase.name}: ${gateCase.detail}`);
      }
      if (delivery.artifact.sizeBytes <= 0) failureReasons.push('the exported artifact is empty');
      return {
        environment: delivery.environment,
        gateName: 'CLI execution gate (the delivered tool, genuinely executed)',
        gatePassed: delivery.gate.passed,
        checks: delivery.gate.cases.map(c => ({
          name: c.name,
          passed: c.ok,
          detail: c.detail + (c.exitCode !== undefined ? ` (exit ${c.exitCode})` : '')
        })),
        artifact: delivery.artifact,
        verified: delivery.verified,
        evidence: [
          `tool: ${delivery.gate.toolName} (entry ${delivery.gate.entryPoint})`,
          testsEvidence('environment tests', delivery.tests),
          artifactEvidence(delivery.artifact)
        ],
        labels: [],
        failureReasons
      };
    }

    case 'ai': {
      const delivery = await AiWorkflow.runEnvironmentCycle({
        projectId: buildId,
        userId,
        title,
        contract: options.aiContract!,
        stubProvider: options.aiStubProvider,
        modelIds: options.aiModelIds,
        gatewayModulePath: platformGatewayModulePath()
      });
      const aiGate = delivery.aiGate;
      const checks: FactoryGateCheck[] = [
        ...aiGate.noProviderRun.probes.map(p => ({ name: `surface probe: ${p.name}`, passed: p.passed, detail: p.detail })),
        {
          name: 'no-provider honesty (named error, no fabricated answer)',
          passed: aiGate.noProvider.passed,
          detail: aiGate.noProvider.detail
        },
        ...aiGate.stubRuns.map(run => ({
          name: `stub round trip: ${run.modelId}`,
          passed: run.passed,
          detail: run.detail
        }))
      ];
      const failureReasons: string[] = [];
      if (delivery.tests.status !== 'passed' || delivery.tests.failed > 0) {
        failureReasons.push(`environment test cycle did not pass: ${delivery.tests.detail}`);
      }
      if (delivery.artifact.sizeBytes <= 0) failureReasons.push('the exported artifact is empty');
      for (const check of checks.filter(c => !c.passed)) {
        failureReasons.push(`AI gate failed — ${check.name}: ${check.detail}`);
      }
      for (const err of aiGate.errors) {
        failureReasons.push(`AI gate error: ${err}`);
      }
      return {
        environment: delivery.environment,
        gateName: 'AI behaviour gate (surface probes, no-provider honesty, stub-provider round trips through the real gateway)',
        gatePassed: aiGate.passed,
        checks,
        artifact: delivery.artifact,
        verified: delivery.verified,
        evidence: [
          testsEvidence('environment tests', delivery.tests),
          `no-provider run: chat answered status ${aiGate.noProvider.status ?? 'n/a'} with error code ${aiGate.noProvider.errorCode ?? 'n/a'}, fabricated answer: ${aiGate.noProvider.fabricatedAnswer}`,
          ...aiGate.stubRuns.map(
            run =>
              `stub round trip ${run.modelId}: ${run.passed ? 'passed' : 'FAILED'} (upstream model ${run.actualModelUsed ?? 'n/a'} via ${run.providerUsed ?? 'n/a'})`
          ),
          artifactEvidence(delivery.artifact)
        ],
        labels: ['real-gateway-code', 'stub-provider-round-trips'],
        failureReasons
      };
    }
  }
}

// ---------------------------------------------------------------------------
// The single entry point
// ---------------------------------------------------------------------------

const BASE_LABELS = [
  'stub-transport',
  'fixture-content',
  'no-live-model'
];

/**
 * Describe → delivered. Classifies the description, routes it to the
 * matching Arc D workflow, plans with the F5 team data, builds with
 * the real swarm chain, runs the category's environment cycle and
 * gate, and returns (and persists) the uniform delivery record.
 *
 * Planning failures (unclassifiable/unrouted category, missing gate
 * input) throw UnifiedPipelineError before any build exists. Build
 * and gate failures return a record with status 'failed'.
 */
export async function deliverFromDescription(
  description: string,
  options: UnifiedPipelineOptions = {}
): Promise<FactoryDeliveryRecord> {
  const startedAt = Date.now();

  // 1–2. Classify + route (throws, named, before anything is built).
  const category = SoftwareRequirementsAnalyzer.detectCategory((description || '').toLowerCase());
  const route = routeForCategory(category, description);

  // 3. Gate inputs are planning inputs (throws, named).
  requireGateInputs(route, options);

  // 4. Team + profile from F5 data, via the workflow's own plan().
  const plan = planFor(route, description);

  // 5. The swarm build, driven by this pipeline.
  const { buildId, userId } = await runSwarmBuild(description, options);
  const build = db.getBuild(buildId);
  const buildStatus = build?.status ?? 'unknown';
  const title = options.title ?? description;
  const scratchRoot =
    options.scratchRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'factory-pipeline-'));

  const evidence: string[] = [
    `classification: '${category}' → workflow '${route}'`,
    `team: ${plan.teamName} (profile ${plan.profileId}, verifier model ${plan.resolvedTeam.verifierModelId})`,
    `swarm build ${buildId}: status ${buildStatus}`
  ];
  const labels: string[] = [...BASE_LABELS];

  let composed: ComposedGate;
  if (buildStatus !== 'completed') {
    const reason =
      build?.failureReason || build?.error || `swarm build ended with status '${buildStatus}'`;
    composed = {
      environment: 'none',
      gateName: 'not run — the swarm build did not complete',
      gatePassed: false,
      checks: [],
      artifact: null,
      verified: false,
      evidence: [],
      labels: [],
      failureReasons: [`swarm build did not complete: ${reason}`]
    };
  } else {
    try {
      composed = await composeGate(route, { buildId, userId, title, scratchRoot }, options);
    } catch (err: any) {
      composed = {
        environment: 'unknown',
        gateName: 'not completed — the category cycle threw',
        gatePassed: false,
        checks: [],
        artifact: null,
        verified: false,
        evidence: [],
        labels: [],
        failureReasons: [`category cycle failed: ${err?.message || String(err)}`]
      };
    }
  }

  evidence.push(...composed.evidence);
  labels.push(...composed.labels);
  const failureReasons = [...composed.failureReasons];
  if (composed.gatePassed && !composed.verified && failureReasons.length === 0) {
    failureReasons.push('the category gate passed but the workflow delivery verdict was not verified');
  }
  const status: FactoryDeliveryRecord['status'] =
    composed.verified && composed.gatePassed ? 'delivered' : 'failed';
  if (status === 'failed' && failureReasons.length === 0) {
    failureReasons.push('delivery not verified (no specific reason recorded by the workflow)');
  }

  const finishedAt = Date.now();
  const record: FactoryDeliveryRecord = {
    id: `dlv_${buildId}`,
    description,
    category,
    workflow: route,
    teamName: plan.teamName,
    profileId: String(plan.profileId),
    verifierModelId: plan.resolvedTeam.verifierModelId,
    projectId: buildId,
    buildStatus,
    environment: composed.environment,
    gate: { name: composed.gateName, passed: composed.gatePassed, checks: composed.checks },
    artifact: artifactRef(composed.artifact),
    verified: composed.verified,
    status,
    failureReasons,
    evidence,
    labels,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt
  };

  // The record is part of the delivery: persisted on the build
  // before it is returned (criterion 3).
  db.addEvent({
    id: `evt_${record.id}`,
    buildId,
    timestamp: finishedAt,
    type: 'factory_delivery',
    details: JSON.stringify(record)
  });

  return record;
}
