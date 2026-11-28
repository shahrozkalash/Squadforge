/**
 * Factory Phase F6 — One Environment Contract.
 *
 * Drives ONE lifecycle (open → file round-trip → build → test cycle →
 * preview → export → deploy dry-run → unapproved deploy request →
 * diagnose → status) through the shared FactoryEnvironment interface
 * against both adapters — web (store-backed) and desktop
 * (workspace-backed) — with no category-specific back doors: the
 * driver below calls only contract operations, and an operation an
 * environment cannot perform surfaces as the contract's named
 * EnvironmentOperationUnsupportedError, which the driver records as a
 * first-class outcome.
 *
 * The web fixture files are this repository's own trusted test
 * content, so the platform test gate may execute them on the host
 * (the same seam the F2–F4 suites use). The sandbox-only invariant
 * test removes that seam and proves generated project code is NOT
 * executed on a plain host process by default.
 *
 * The desktop fixture is a genuine generated Avalonia project
 * (DesktopProjectGenerator via the adapter): the build is a real
 * `dotnet build`, the artifacts are ELF-verified, and the test cycle
 * really executes the harvested apphost with --smoke (Phase 36).
 */
process.env.SQUADFORGE_TRUSTED_HOST_TESTS = '1';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import crypto from 'node:crypto';
import { db } from '../server/store.js';
import {
  createEnvironment,
  listEnvironmentKinds,
  ENVIRONMENT_OPERATIONS,
  EnvironmentOperationUnsupportedError
} from '../server/environment/index.js';
import type {
  EnvironmentBuildResult,
  EnvironmentDeploymentRequest,
  EnvironmentDeploymentValidation,
  EnvironmentStatus,
  EnvironmentTestResult,
  FactoryEnvironment
} from '../server/environment/index.js';
import { DesktopProjectGenerator } from '../server/desktop/desktopProjectGenerator.js';
import { executionManager } from '../server/execution/index.js';
import { staticHostRegistry } from '../server/deployment/index.js';
import type { User } from '../server/types.js';

const RUN = crypto.randomBytes(3).toString('hex');
const WEB_USER_ID = `f6_env_user_${RUN}`;
const WEB_PROJECT = `f6web_${RUN}`;
const DESKTOP_PROJECT = `f6desk_${RUN}`;
const HOST_PROJECT = `f6host_${RUN}`;
const MARKER_PATH = path.join(os.tmpdir(), `f6-host-execution-marker-${RUN}.txt`);

const webEnv: FactoryEnvironment = createEnvironment('web', { userId: WEB_USER_ID });
const desktopEnv: FactoryEnvironment = createEnvironment('desktop');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WEB_FILES = [
  {
    path: 'package.json',
    content: JSON.stringify(
      { name: 'f6-fixture-app', version: '1.0.0', private: true, type: 'module', scripts: { test: 'node --test tests/' } },
      null,
      2
    ) + '\n'
  },
  {
    path: 'index.html',
    content:
      '<!doctype html><html><head><title>F6 Fixture App</title></head><body><div id="root"></div></body></html>\n'
  },
  {
    path: 'src/engine.ts',
    content:
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n' +
      'export function mul(a: number, b: number): number {\n  return a * b;\n}\n'
  },
  {
    path: 'src/App.tsx',
    content:
      "import React from 'react';\nimport { add } from './engine';\n" +
      "export default function App() {\n  return React.createElement('div', null, `sum=${add(1, 2)}`);\n}\n"
  },
  {
    path: 'src/main.tsx',
    content: "import React from 'react';\nimport App from './App';\nconsole.log(React, App);\n"
  },
  {
    path: 'tests/engine.test.ts',
    content:
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n" +
      "import { add, mul } from '../src/engine.ts';\n" +
      "test('add works', () => { assert.equal(add(1, 2), 3); });\n" +
      "test('mul works', () => { assert.equal(mul(2, 3), 6); });\n"
  }
];

const WEB_FAILING_TEST =
  "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n" +
  "import { add } from '../src/engine.ts';\n" +
  "test('add works', () => { assert.equal(add(1, 2), 99); });\n";

interface LifecycleFixture {
  title: string;
  files?: { path: string; content: string }[];
  roundTripPath: string;
  roundTripContent: string;
  /** A project file whose corruption must flip the test cycle to failed. */
  breakagePath: string;
  brokenContent: string;
}

interface LifecycleRecord {
  environment: string;
  fileCountAtStatus: number;
  listedCount: number;
  readBack: string | null;
  missingFile: string | null;
  build: EnvironmentBuildResult;
  tests: EnvironmentTestResult;
  previewOutcome: 'produced' | 'unsupported';
  previewMode?: string;
  previewHtmlBytes: number;
  exportName: string;
  exportSize: number;
  exportSha256?: string;
  deployValidation: EnvironmentDeploymentValidation;
  deployRequestOutcome: 'held' | 'unsupported' | 'deployed' | string;
  deployRequest?: EnvironmentDeploymentRequest;
  diagnosticsCount: number;
  status: EnvironmentStatus;
}

/** The one lifecycle driver — contract operations only, both environments. */
async function runLifecycle(
  env: FactoryEnvironment,
  projectId: string,
  fixture: LifecycleFixture
): Promise<LifecycleRecord> {
  const ref = await env.openProject({ projectId, title: fixture.title, files: fixture.files });
  assert.equal(ref.environment, env.kind);
  assert.equal(ref.projectId, projectId);

  await env.writeFile(projectId, fixture.roundTripPath, fixture.roundTripContent);
  const readBack = await env.readFile(projectId, fixture.roundTripPath);
  const listed = await env.listFiles(projectId);
  assert.ok(listed.includes(fixture.roundTripPath), `round-trip file must be listed: ${listed.join(', ')}`);
  const missingFile = await env.readFile(projectId, 'no/such/file.txt');
  assert.equal(missingFile, null);

  const build = await env.build(projectId);
  const tests = await env.runTests(projectId);

  let previewOutcome: 'produced' | 'unsupported' = 'produced';
  let previewMode: string | undefined;
  let previewHtmlBytes = 0;
  try {
    const preview = await env.preview(projectId);
    previewMode = preview.mode;
    previewHtmlBytes = preview.html?.length ?? 0;
  } catch (err) {
    if (err instanceof EnvironmentOperationUnsupportedError) {
      previewOutcome = 'unsupported';
    } else {
      throw err;
    }
  }

  const exported = await env.exportArtifact(projectId);
  const deployValidation = await env.validateDeployment(projectId);

  let deployRequestOutcome: string;
  let deployRequest: EnvironmentDeploymentRequest | undefined;
  try {
    deployRequest = await env.requestDeployment(projectId, { environment: 'production' });
    deployRequestOutcome =
      deployRequest.requiresApproval && deployRequest.status === 'pending_approval'
        ? 'held'
        : deployRequest.status === 'active'
          ? 'deployed'
          : deployRequest.status;
  } catch (err) {
    if (err instanceof EnvironmentOperationUnsupportedError) {
      deployRequestOutcome = 'unsupported';
    } else {
      throw err;
    }
  }

  const diagnostics = await env.diagnose(projectId);
  const status = await env.getStatus(projectId);

  return {
    environment: env.kind,
    fileCountAtStatus: status.fileCount,
    listedCount: listed.length,
    readBack,
    missingFile,
    build,
    tests,
    previewOutcome,
    previewMode,
    previewHtmlBytes,
    exportName: exported.artifact.name,
    exportSize: exported.artifact.sizeBytes,
    exportSha256: exported.artifact.sha256,
    deployValidation,
    deployRequestOutcome,
    deployRequest,
    diagnosticsCount: diagnostics.length,
    status
  };
}

/** Assertions that must hold for the lifecycle in EITHER environment. */
function assertLifecycleCommon(record: LifecycleRecord, fixture: LifecycleFixture): void {
  assert.equal(record.readBack, fixture.roundTripContent, 'file round-trip must be byte-identical');
  assert.equal(record.missingFile, null);
  assert.equal(record.fileCountAtStatus, record.listedCount, 'status file count must match the file listing');
  assert.equal(record.build.status, 'succeeded', `build must succeed: ${record.build.error || record.build.detail}`);
  assert.equal(record.tests.status, 'passed', `test cycle must pass: ${record.tests.detail}`);
  assert.ok(record.tests.total >= 1, 'test cycle must report at least one check');
  assert.ok(record.tests.passed >= 1);
  assert.ok(record.exportSize > 0, 'exported artifact must be a real, non-empty artifact');
  assert.match(record.exportSha256 || '', /^[0-9a-f]{64}$/, 'exported artifact must carry a SHA-256');
  assert.equal(record.deployValidation.valid, true, `deploy dry-run must validate: ${record.deployValidation.defects.join('; ')}`);
  assert.notEqual(
    record.deployRequestOutcome,
    'deployed',
    'an unapproved production deployment request must never deploy'
  );
  assert.equal(record.status.lastBuildStatus, 'succeeded');
  assert.equal(record.status.lastTestStatus, 'passed');
  assert.equal(record.status.title, fixture.title);
}

/** Break → test cycle fails → restore → test cycle passes, through the contract only. */
async function assertBreakAndRecover(
  env: FactoryEnvironment,
  projectId: string,
  fixture: LifecycleFixture
): Promise<void> {
  const original = await env.readFile(projectId, fixture.breakagePath);
  assert.ok(original && original.length > 0, `breakage target must exist: ${fixture.breakagePath}`);
  await env.writeFile(projectId, fixture.breakagePath, fixture.brokenContent);
  const failed = await env.runTests(projectId);
  assert.equal(failed.status, 'failed', `broken project must fail the test cycle: ${failed.detail}`);
  await env.writeFile(projectId, fixture.breakagePath, original);
  const recovered = await env.runTests(projectId);
  assert.equal(recovered.status, 'passed', `restored project must pass again: ${recovered.detail}`);
}

// ---------------------------------------------------------------------------
// Conformance
// ---------------------------------------------------------------------------

describe('F6.1 Contract conformance — one surface, both environments', () => {
  test('both adapters expose exactly the contract operation set (introspected, not type-trusted)', () => {
    assert.deepEqual(listEnvironmentKinds(), ['web', 'desktop']);
    const expected = [...ENVIRONMENT_OPERATIONS].sort();
    for (const kind of listEnvironmentKinds()) {
      const env = createEnvironment(kind, { userId: WEB_USER_ID });
      const exposed = ENVIRONMENT_OPERATIONS.filter(
        op => typeof (env as unknown as Record<string, unknown>)[op] === 'function'
      );
      assert.deepEqual([...exposed].sort(), expected, `${kind} adapter must expose every contract operation`);
      const caps = env.capabilities();
      assert.equal(caps.environment, kind);
      assert.deepEqual(Object.keys(caps.operations).sort(), expected, `${kind} capabilities must cover the whole surface`);
    }
  });

  test('capabilities are honest: web supports the full surface; desktop names its two refusals', () => {
    const webCaps = webEnv.capabilities();
    for (const op of ENVIRONMENT_OPERATIONS) {
      assert.equal(webCaps.operations[op].supported, true, `web must support ${op}`);
    }
    const desktopCaps = desktopEnv.capabilities();
    assert.equal(desktopCaps.operations.preview.supported, false);
    assert.match(desktopCaps.operations.preview.reason || '', /no display|never been run headlessly/i);
    assert.equal(desktopCaps.operations.requestDeployment.supported, false);
    assert.match(desktopCaps.operations.requestDeployment.reason || '', /ReleasePackager/);
    for (const op of ENVIRONMENT_OPERATIONS) {
      if (op === 'preview' || op === 'requestDeployment') continue;
      assert.equal(desktopCaps.operations[op].supported, true, `desktop must support ${op}`);
    }
  });

  test('unsupported operations throw the named error — never a fake success', async () => {
    const isNamedRefusal =
      (operation: string) =>
      (err: unknown): boolean => {
        assert.ok(err instanceof EnvironmentOperationUnsupportedError, `expected the named error, got: ${err}`);
        const named = err as EnvironmentOperationUnsupportedError;
        assert.equal(named.name, 'EnvironmentOperationUnsupportedError');
        assert.equal(named.code, 'ENVIRONMENT_OPERATION_UNSUPPORTED');
        assert.equal(named.environment, 'desktop');
        assert.equal(named.operation, operation);
        assert.ok(named.reason.length > 0);
        return true;
      };
    await assert.rejects(() => desktopEnv.preview(DESKTOP_PROJECT), isNamedRefusal('preview'));
    await assert.rejects(() => desktopEnv.requestDeployment(DESKTOP_PROJECT), isNamedRefusal('requestDeployment'));
  });
});

// ---------------------------------------------------------------------------
// Web lifecycle
// ---------------------------------------------------------------------------

describe('F6.2 Web lifecycle through the one contract', () => {
  const fixture: LifecycleFixture = {
    title: 'F6 Fixture App',
    files: WEB_FILES,
    roundTripPath: 'notes/factory-f6.txt',
    roundTripContent: 'written through the environment contract\n',
    breakagePath: 'tests/engine.test.ts',
    brokenContent: WEB_FAILING_TEST
  };
  let record: LifecycleRecord;

  before(() => {
    const user: User = {
      id: WEB_USER_ID,
      email: `${WEB_USER_ID}@squadforge.test`,
      name: 'F6 Environment User',
      githubConnected: false,
      costLimitPerBuild: 5.0,
      enabledModelIds: [],
      createdAt: Date.now()
    };
    db.saveUser(user);
  });

  test(
    'open → files → build → test → preview → export → deploy dry-run → status, one API',
    { timeout: 300_000 },
    async () => {
      record = await runLifecycle(webEnv, WEB_PROJECT, fixture);
      assertLifecycleCommon(record, fixture);
      // Web-specific outcomes of the same uniform lifecycle:
      assert.equal(record.previewOutcome, 'produced');
      assert.ok(
        ['real_application', 'static_html', 'fallback_preview'].includes(record.previewMode || ''),
        `preview mode must be the generator's own label, got: ${record.previewMode}`
      );
      assert.ok(record.previewHtmlBytes > 0, 'preview must produce real HTML');
      assert.equal(record.deployRequestOutcome, 'held');
      assert.equal(record.tests.mode, 'project_tests');
      assert.equal(record.diagnosticsCount, 0, 'the clean fixture must produce no type diagnostics');
    }
  );

  test('approval gate: the held deployment did not deploy; an approved one does', { timeout: 120_000 }, async () => {
    const heldId = record.deployRequest?.deploymentId;
    assert.ok(heldId, 'the lifecycle must have produced a held deployment');
    assert.equal(db.getDeployment(heldId)?.status, 'pending_approval');
    assert.equal(
      staticHostRegistry.has(heldId),
      false,
      'a production deployment without approval must not reach the hosting adapter'
    );

    const approved = await webEnv.requestDeployment(WEB_PROJECT, {
      environment: 'production',
      approved: true
    });
    assert.equal(approved.status, 'active', `approved deployment must execute: ${approved.detail}`);
    assert.ok(approved.targetUrl?.includes(approved.deploymentId || ''));
    assert.equal(staticHostRegistry.has(approved.deploymentId || ''), true);
  });

  test('test cycle verdict flips with the project files (fail case, then recovery)', { timeout: 300_000 }, async () => {
    await assertBreakAndRecover(webEnv, WEB_PROJECT, fixture);
  });
});

// ---------------------------------------------------------------------------
// Desktop lifecycle
// ---------------------------------------------------------------------------

describe('F6.3 Desktop lifecycle through the one contract', () => {
  const fixture: LifecycleFixture = {
    title: 'F6 Desk App',
    // No files passed: the adapter seeds the project from the
    // platform's own DesktopProjectGenerator, as desktop projects
    // genuinely come into existence.
    files: undefined,
    roundTripPath: 'notes/factory-f6.txt',
    roundTripContent: 'written through the environment contract\n',
    breakagePath: 'src/F6DeskApp/MainWindow.axaml.cs',
    brokenContent: 'this is not valid C# at all {{{\n'
  };
  const hasDotnet = DesktopProjectGenerator.detectDotnet() !== null;
  let record: LifecycleRecord;

  test(
    'open → files → build → test (compile + smoke) → export → deploy dry-run → status, one API',
    { timeout: 900_000 },
    async () => {
      record = await runLifecycle(desktopEnv, DESKTOP_PROJECT, fixture);
      if (!hasDotnet) {
        // Phase 36 pattern: without an SDK the pipeline must fail
        // honestly — and the contract must surface that, not fake it.
        assert.equal(record.build.status, 'failed');
        assert.match(record.build.error || '', /\.NET SDK/);
        return;
      }
      assertLifecycleCommon(record, fixture);
      // Desktop-specific outcomes of the same uniform lifecycle:
      assert.equal(record.previewOutcome, 'unsupported', 'a native GUI has no platform preview');
      assert.equal(record.deployRequestOutcome, 'unsupported');
      assert.equal(record.tests.mode, 'compile_and_smoke');
      assert.match(record.tests.detail, /SMOKE_OK/, 'the smoke run must really have executed the apphost');
      assert.match(record.exportName, /^F6DeskApp/, 'the export must be the harvested apphost');
      assert.ok(record.status.events.length >= 1, 'the workspace status log must record the lifecycle');
      assert.equal(record.deployValidation.provider, 'desktop_release');
      assert.match(record.deployValidation.detail, /win-x64 only/, 'the Linux packaging gap must be stated, not hidden');
    }
  );

  test(
    'test cycle verdict flips with the project files (broken C# fails compile, restore passes)',
    { timeout: 900_000 },
    async () => {
      if (!hasDotnet) return; // covered by the honest-failure path above
      await assertBreakAndRecover(desktopEnv, DESKTOP_PROJECT, fixture);
    }
  );

  after(() => {
    for (const root of ['.desktop_projects', '.desktop_workspaces', '.desktop_artifacts']) {
      fs.rmSync(path.join(process.cwd(), root, DESKTOP_PROJECT), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Sandbox-only invariant (roadmap F6 acceptance criterion 3)
// ---------------------------------------------------------------------------

describe('F6.4 Execution stays sandbox-only', () => {
  test('the configured execution backend refuses host execution here', async () => {
    assert.equal(executionManager.backend.name, 'disabled');
    const caps = await executionManager.backend.capabilities();
    assert.equal(caps.available, false);
    await assert.rejects(
      () => executionManager.backend.startProcess('f6', {} as never, () => undefined),
      /not configured/i
    );
  });

  test(
    'without the trusted-fixture seam, project test code does not run on the host',
    { timeout: 120_000 },
    async () => {
      const markerTest =
        "import { test } from 'node:test';\nimport * as fs from 'fs';\n" +
        `test('side effect', () => { fs.writeFileSync(${JSON.stringify(MARKER_PATH)}, 'executed on host'); });\n`;
      await webEnv.openProject({
        projectId: HOST_PROJECT,
        title: 'F6 Host Invariant Probe',
        files: [
          { path: 'package.json', content: '{"name":"f6-host-probe","private":true,"type":"module"}\n' },
          { path: 'src/main.tsx', content: "console.log('probe');\n" },
          { path: 'tests/marker.test.ts', content: markerTest }
        ]
      });

      const saved = process.env.SQUADFORGE_TRUSTED_HOST_TESTS;
      delete process.env.SQUADFORGE_TRUSTED_HOST_TESTS;
      try {
        const result = await webEnv.runTests(HOST_PROJECT);
        assert.equal(result.status, 'skipped', `expected an honest sandbox skip, got: ${result.status} (${result.detail})`);
        assert.match(result.detail, /sandbox/i);
        assert.equal(
          fs.existsSync(MARKER_PATH),
          false,
          'project test code must never execute on a plain host process by default'
        );
        // Compilation is not execution: the build may bundle the same
        // project, and still nothing runs.
        const build = await webEnv.build(HOST_PROJECT);
        assert.equal(build.status, 'succeeded');
        assert.equal(fs.existsSync(MARKER_PATH), false);
      } finally {
        if (saved !== undefined) process.env.SQUADFORGE_TRUSTED_HOST_TESTS = saved;
        fs.rmSync(MARKER_PATH, { force: true });
      }
    }
  );
});
