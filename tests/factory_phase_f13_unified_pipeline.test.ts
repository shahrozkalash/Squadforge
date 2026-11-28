/**
 * Factory Phase F13 — Describe → delivered: the unified pipeline.
 *
 * Every test in this suite drives ONE entry point —
 * `deliverFromDescription` (server/factory/unifiedPipeline.ts) —
 * with a plain-language description. The pipeline classifies the
 * description (the platform analyzer), resolves the team from F5
 * data, runs the real swarm build, drives the matching Arc D
 * workflow's environment cycle, applies that category's own gate,
 * and returns one uniform delivery record, persisted on the build
 * as a `factory_delivery` event.
 *
 * The per-category fixture seams are the established F7–F12 ones,
 * shared through tests/factory_fixture_kit.ts (extracted from the
 * phase suites; those suites keep their own copies). The stub
 * transport stands in for the planner/worker models, as in every
 * factory suite since F2: no live model exists in this environment
 * (F1 verdict), and every delivery record says so in its labels.
 * The approval responder below takes the owner's place for these
 * fixture builds, exactly as the F7–F12 approval pumps did.
 *
 * Acceptance shape (roadmap F13): one small real delivery per major
 * category through the single pipeline, each passing its own
 * category gate (tests 1–9); an unclassifiable request and a
 * multimedia request naming no routable editor fail by name at
 * planning (test 10); a missing gate input fails by name at
 * planning (test 11); a delivery whose category gate fails (the
 * photo gate refusing originals that do not match the catalogued
 * SHA-256 — the F8 gate's designed refusal, reachable only at gate
 * time because originals are supplied out-of-band) is recorded as
 * failed, never delivered (test 12).
 *
 * Generated fixture files are this repository's own trusted test
 * content, so the execution adapter may run them on the host.
 */
process.env.SQUADFORGE_TRUSTED_HOST_TESTS = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import {
  deliverFromDescription,
  UnifiedPipelineError,
  type FactoryDeliveryRecord
} from '../server/factory/unifiedPipeline.js';
import * as kit from './factory_fixture_kit.js';

const approveAll = async () => true;

interface ExpectedDelivery {
  category: string;
  workflow: string;
  teamName: string;
  profileId: string;
}

/**
 * The uniform record contract every delivered category must meet:
 * correct classification/team, the category gate passed in full, a
 * real artifact with a SHA-256, no failure reasons, the honest
 * labels present, the swarm build classified identically, and the
 * record persisted on the build (a delivery without a record is a
 * failed test — roadmap F13 criterion 3).
 */
function assertDelivered(record: FactoryDeliveryRecord, expected: ExpectedDelivery): void {
  assert.equal(record.category, expected.category, 'detected category');
  assert.equal(record.workflow, expected.workflow, 'workflow route');
  assert.equal(record.teamName, expected.teamName, 'team from F5 data');
  assert.equal(record.profileId, expected.profileId, 'profile from F5 data');
  assert.equal(record.verifierModelId, 'claude', 'verifier resolves through the registry');
  assert.equal(record.buildStatus, 'completed', 'the swarm build completed');
  assert.equal(record.status, 'delivered');
  assert.equal(record.verified, true, 'the category workflow verdict is verified');
  assert.equal(record.gate.passed, true, `gate "${record.gate.name}" passed`);
  assert.ok(record.gate.checks.length > 0, 'the gate produced checks');
  assert.ok(
    record.gate.checks.every(c => c.passed),
    `every gate check passed; failures: ${JSON.stringify(record.gate.checks.filter(c => !c.passed))}`
  );
  assert.deepEqual(record.failureReasons, [], 'a delivered record carries no failure reasons');
  assert.ok(record.artifact, 'an artifact was exported');
  assert.ok(record.artifact!.sizeBytes > 0, 'the artifact is non-empty');
  assert.match(record.artifact!.sha256 ?? '', /^[0-9a-f]{64}$/, 'the artifact carries its SHA-256');
  for (const label of ['stub-transport', 'fixture-content', 'no-live-model']) {
    assert.ok(record.labels.includes(label), `honest label present: ${label}`);
  }
  const build = db.getBuild(record.projectId) as any;
  assert.equal(build?.projectType, expected.category, 'the swarm build classified the same category');
  const events = db.getEvents(record.projectId).filter(e => e.type === 'factory_delivery');
  assert.equal(events.length, 1, 'the delivery record is persisted on the build');
  const persisted = JSON.parse(events[0].details);
  assert.equal(persisted.id, record.id);
  assert.equal(persisted.status, 'delivered');
  assert.equal(persisted.artifact.sha256, record.artifact!.sha256);
}

test('F13.1 game: a described 2D platformer is delivered through the single pipeline', { timeout: 600_000 }, async t => {
  kit.installFactoryStub(t, kit.gameFixture.plannerActions, kit.gameFixture.contentFor);
  const record = await deliverFromDescription(kit.GAME_DESCRIPTION, { approvalResponder: approveAll });
  assertDelivered(record, {
    category: 'game_application',
    workflow: 'game',
    teamName: 'Game Development Team',
    profileId: 'game_creative_application'
  });
  assert.ok(record.gate.name.includes('playability'), 'the category gate is the playability gate');
  assert.ok(record.labels.includes('platform-generator-content'));
});

test('F13.2 video editor: a described video editor is delivered through the single pipeline', { timeout: 600_000 }, async t => {
  kit.installFactoryStub(t, kit.videoFixture.plannerActions, kit.videoFixture.contentFor);
  const record = await deliverFromDescription(kit.VIDEO_DESCRIPTION, { approvalResponder: approveAll });
  assertDelivered(record, {
    category: 'multimedia_application',
    workflow: 'video-editor',
    teamName: 'Creative Software Team — Multimedia',
    profileId: 'multimedia_application'
  });
  assert.ok(record.gate.name.includes('export verification'), 'the category gate is the export verification');
});

test('F13.3 image editor: a described image editor is delivered through the single pipeline', { timeout: 600_000 }, async t => {
  kit.installFactoryStub(t, kit.imageFixture.plannerActions, kit.imageFixture.contentFor);
  const record = await deliverFromDescription(kit.IMAGE_DESCRIPTION, { approvalResponder: approveAll });
  assertDelivered(record, {
    category: 'multimedia_application',
    workflow: 'image-editor',
    teamName: 'Creative Software Team — Multimedia',
    profileId: 'multimedia_application'
  });
  assert.ok(record.gate.name.includes('project verification'), 'the category gate is the project verification');
});

test('F13.4 photo editor: a described photo editor is delivered through the single pipeline', { timeout: 600_000 }, async t => {
  kit.installFactoryStub(t, kit.photoFixture.plannerActions, kit.photoFixture.contentFor);
  const record = await deliverFromDescription(kit.PHOTO_DESCRIPTION, {
    approvalResponder: approveAll,
    photoSources: kit.photoFixtureSources()
  });
  assertDelivered(record, {
    category: 'multimedia_application',
    workflow: 'photo-editor',
    teamName: 'Creative Software Team — Multimedia',
    profileId: 'multimedia_application'
  });
  assert.ok(record.gate.name.includes('photo delivery verification'), 'the category gate is the photo verification');
  assert.ok(record.labels.includes('originals-supplied-out-of-band'));
});

test('F13.5 web/API: a described REST API is delivered through the single pipeline', { timeout: 600_000 }, async t => {
  kit.installFactoryStub(t, kit.webApiFixture.plannerActions, kit.webApiFixture.contentFor);
  const record = await deliverFromDescription(kit.API_DESCRIPTION, {
    approvalResponder: approveAll,
    webContract: kit.API_CONTRACT
  });
  assertDelivered(record, {
    category: 'api_service',
    workflow: 'web',
    teamName: 'Backend Engineering Team — API Service',
    profileId: 'rest_api_backend'
  });
  assert.ok(record.gate.name.includes('runtime contract probes'), 'the category gate is the runtime gate');
  assert.equal(record.gate.checks.length, 8, 'all 8 declared contract probes ran');
});

test('F13.6 mobile: a described Android app is delivered through the single pipeline', { timeout: 900_000 }, async t => {
  kit.installFactoryStub(t, kit.mobileFixture.plannerActions, kit.mobileFixture.contentFor);
  const record = await deliverFromDescription(kit.MOBILE_DESCRIPTION, {
    approvalResponder: approveAll,
    title: 'ClipForge Mobile (Factory F13)'
  });
  assertDelivered(record, {
    category: 'android_application',
    workflow: 'mobile',
    teamName: 'Mobile Development Team — Android',
    profileId: 'android_mobile_application'
  });
  assert.ok(record.gate.name.includes('Android project gate'), 'the category gate is the Android gate');
  assert.ok(record.labels.includes('no-local-apk'), 'the record states no local APK was built');
  assert.ok(record.labels.includes('apk-is-ci-produced'));
});

test('F13.7 desktop: a described desktop app is delivered through the single pipeline', { timeout: 1_500_000 }, async t => {
  kit.installFactoryStub(t, kit.desktopFixture.plannerActions, kit.desktopFixture.contentFor);
  const record = await deliverFromDescription(kit.DESKTOP_DESCRIPTION, {
    approvalResponder: approveAll,
    title: 'NoteKeeper'
  });
  assertDelivered(record, {
    category: 'desktop_application',
    workflow: 'desktop',
    teamName: 'Desktop Software Team',
    profileId: 'desktop_application'
  });
  assert.ok(record.gate.name.includes('desktop delivery gate'), 'the category gate is the desktop gate');
  assert.ok(record.labels.includes('gui-never-run'));
  assert.ok(
    record.evidence.some(e => e.includes('LaunchCount sequence 1 → 2')),
    `smoke-run persistence is in the evidence: ${JSON.stringify(record.evidence)}`
  );
});

test('F13.8 CLI tool: a described command line tool is delivered through the single pipeline', { timeout: 900_000 }, async t => {
  kit.installFactoryStub(t, kit.cliFixture.plannerActions, kit.cliFixture.contentFor);
  const record = await deliverFromDescription(kit.CLI_DESCRIPTION, {
    approvalResponder: approveAll,
    title: 'logsum'
  });
  assertDelivered(record, {
    category: 'cli_tool',
    workflow: 'cli',
    teamName: 'Developer Tools Team — CLI',
    profileId: 'cli_tool_developer_utility'
  });
  assert.ok(record.gate.name.includes('CLI execution gate'), 'the category gate is the CLI execution gate');
  assert.equal(record.gate.checks.length, 8, 'all 8 execution cases ran');
});

test('F13.9 AI application: a described AI chat app is delivered through the single pipeline', { timeout: 900_000 }, async t => {
  kit.installFactoryStub(t, kit.aiFixture.plannerActions, kit.aiFixture.contentFor);
  const stub = await kit.createAiStubProvider();
  try {
    const record = await deliverFromDescription(kit.AI_DESCRIPTION, {
      approvalResponder: approveAll,
      aiContract: kit.AI_CONTRACT,
      aiStubProvider: stub.provider,
      aiModelIds: ['gpt-4o', 'deepseek']
    });
    assertDelivered(record, {
      category: 'ai_application',
      workflow: 'ai',
      teamName: 'AI Application Team',
      profileId: 'ai_application'
    });
    assert.ok(record.gate.name.includes('AI behaviour gate'), 'the category gate is the AI gate');
    assert.ok(record.labels.includes('real-gateway-code'));
    const roundTrips = record.gate.checks.filter(c => c.name.startsWith('stub round trip:'));
    assert.equal(roundTrips.length, 2, 'both configured models round-tripped');
    assert.ok(roundTrips.every(c => c.passed));
    const upstreamModels = stub.seen.filter(s => s.url === '/v1/chat/completions').map(s => s.model);
    assert.deepEqual(
      [...upstreamModels].sort(),
      ['deepseek/deepseek-chat', 'openai/gpt-4o'],
      'the stub provider saw the two upstream model ids — the model swap is configuration only'
    );
  } finally {
    await stub.close();
  }
});

test('F13.10 unclassifiable and unroutable requests fail by name at planning', { timeout: 60_000 }, async () => {
  await assert.rejects(
    deliverFromDescription('zxqv wobble framis thingamajig splunge'),
    (err: any) => {
      assert.ok(err instanceof UnifiedPipelineError, `named pipeline error, got ${err}`);
      assert.equal(err.code, 'UNSUPPORTED_CATEGORY');
      assert.equal(err.category, 'fullstack', 'the analyzer fallback is named, never guessed into a workflow');
      return true;
    }
  );
  await assert.rejects(
    deliverFromDescription('Build an audio editor with multitrack recording and effects'),
    (err: any) => {
      assert.ok(err instanceof UnifiedPipelineError, `named pipeline error, got ${err}`);
      assert.equal(err.code, 'UNSUPPORTED_CATEGORY');
      assert.equal(err.category, 'multimedia_application');
      assert.match(err.message, /names none of them/, 'the missing editor kind is the stated reason');
      return true;
    }
  );
});

test('F13.11 a missing gate input fails by name at planning', { timeout: 60_000 }, async () => {
  await assert.rejects(
    deliverFromDescription(kit.API_DESCRIPTION, { approvalResponder: approveAll }),
    (err: any) => {
      assert.ok(err instanceof UnifiedPipelineError, `named pipeline error, got ${err}`);
      assert.equal(err.code, 'MISSING_GATE_INPUT');
      assert.match(err.message, /webContract/);
      return true;
    }
  );
  await assert.rejects(
    deliverFromDescription(kit.PHOTO_DESCRIPTION, { approvalResponder: approveAll }),
    (err: any) => {
      assert.ok(err instanceof UnifiedPipelineError, `named pipeline error, got ${err}`);
      assert.equal(err.code, 'MISSING_GATE_INPUT');
      assert.match(err.message, /photoSources/);
      return true;
    }
  );
});

test('F13.12 a gate-failing delivery is recorded as failed, not delivered', { timeout: 600_000 }, async t => {
  // The photo gate's designed refusal (F8): the delivered catalog is
  // genuine and the build completes, but one supplied "original" does
  // not match the SHA-256 the catalog records for it — the gate
  // refuses the delivery. Originals are supplied out-of-band at gate
  // time, so this failure exists only at the category gate, which is
  // exactly the stage this test exercises.
  kit.installFactoryStub(t, kit.photoFixture.plannerActions, kit.photoFixture.contentFor);
  const sources = kit.photoFixtureSources();
  const genuine = sources.get(kit.PHOTO2_NAME)!;
  sources.set(kit.PHOTO2_NAME, Buffer.concat([genuine, Buffer.from([0])]));
  const record = await deliverFromDescription(kit.PHOTO_DESCRIPTION, {
    approvalResponder: approveAll,
    photoSources: sources
  });
  assert.equal(record.buildStatus, 'completed', 'the build itself completed — the category gate is what refused it');
  assert.equal(record.status, 'failed', 'a gate-failing delivery is recorded as failed');
  assert.equal(record.verified, false);
  assert.equal(record.gate.passed, false, 'the photo gate refused the mismatched original');
  assert.ok(
    record.gate.checks.some(c => !c.passed && c.name.includes('original verified by SHA-256')),
    `the refusing check is named in the record: ${JSON.stringify(record.gate.checks)}`
  );
  assert.ok(record.failureReasons.length > 0, 'the failure reasons are recorded');
  assert.ok(
    record.failureReasons.some(r => r.includes('photo verification failed')),
    `the reasons name the gate: ${JSON.stringify(record.failureReasons)}`
  );
  assert.ok(record.artifact, 'the artifact exists — it is the gate, not the export, that refused delivery');
  assert.match(record.artifact!.sha256 ?? '', /^[0-9a-f]{64}$/);
  const events = db.getEvents(record.projectId).filter(e => e.type === 'factory_delivery');
  assert.equal(events.length, 1, 'the failed delivery is persisted too — failed validation stays visible');
  assert.equal(JSON.parse(events[0].details).status, 'failed');
});
