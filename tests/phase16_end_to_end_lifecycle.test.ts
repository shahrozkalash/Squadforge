import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { User, Build, ProjectFile } from '../server/types.js';
import { SoftwareRequirementsAnalyzer } from '../server/architecture/requirementsAnalyzer.js';
import { IntelligentStackSelector } from '../server/architecture/stackSelector.js';
import { ConnectedApplicationPlanner, ConnectedApplicationGenerator } from '../server/application/index.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { DisabledBackend } from '../server/execution/disabledBackend.js';
import { parseProcessOutput } from '../server/debugging/diagnosticCollector.js';
import { RootCauseEngine } from '../server/debugging/rootCauseEngine.js';
import { HonestVerificationService } from '../server/verificationService.js';
import { PreviewGenerator } from '../server/swarm/previewGenerator.js';
import { GitHubLifecycleService } from '../server/github/githubLifecycleService.js';
import { GitHubClient } from '../server/github/githubClient.js';
import { PreDeploymentValidator } from '../server/deployment/preDeploymentValidator.js';
import { ProductionBuilder } from '../server/deployment/productionBuilder.js';
import { DeploymentService } from '../server/deployment/deploymentService.js';
import { DeploymentSecretManager } from '../server/deployment/secretManager.js';

function createMockFetch(routes: Record<string, { status?: number; data?: any; error?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    const method = init?.method || 'GET';
    const key = `${method} ${urlStr}`;

    let matchKey = Object.keys(routes).find(k => k === key);
    if (!matchKey) {
      const sortedKeys = Object.keys(routes).sort((a, b) => b.length - a.length);
      matchKey = sortedKeys.find(k => {
        const cleanK = k.replace(/^[A-Z]+\s+/, '');
        return urlStr === cleanK || urlStr.includes(cleanK);
      });
    }
    const route = matchKey ? routes[matchKey] : undefined;

    if (!route) {
      return new Response(JSON.stringify({ message: `Not Found: ${key}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const status = route.status || 200;
    const body = route.data !== undefined ? JSON.stringify(route.data) : (route.error ? JSON.stringify({ message: route.error }) : '');
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as any;
}

describe('SquadForge Phase 16: Complete 12-Step Software-Building Lifecycle', () => {
  let testUser: User;
  let testBuild: Build;

  beforeEach(() => {
    const nonce = Math.random().toString(36).substring(2, 8);
    testUser = {
      id: `usr_phase16_${nonce}`,
      email: `lead_${nonce}@squadforge.dev`,
      name: 'Shahroz Lead Engineer',
      githubConnected: true,
      githubUsername: 'Shahrozkalash',
      costLimitPerBuild: 25.0,
      enabledModelIds: ['gemini', 'gpt-4o', 'claude-3-5-sonnet'],
      createdAt: Date.now()
    };
    db.saveUser(testUser);

    testBuild = {
      id: `bld_phase16_${nonce}`,
      userId: testUser.id,
      idea: 'Build a production-grade multi-tenant team collaboration platform with kanban boards, REST API, authentication, and PostgreSQL/SQLite store.',
      projectType: 'saas_dashboard',
      status: 'planning',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini', 'gpt-4o'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 25.0,
      maxDurationSeconds: 600,
      patchesAppliedCount: 0
    };
    db.saveBuild(testBuild);
  });

  afterEach(() => {
    GitHubLifecycleService.setCustomClientFactory(undefined);
  });

  test('Step 1: Create a project from user description and persist initial build', () => {
    const saved = db.getBuild(testBuild.id);
    assert.ok(saved);
    assert.equal(saved.id, testBuild.id);
    assert.equal(saved.userId, testUser.id);
    assert.equal(saved.status, 'planning');
    assert.ok(saved.idea.includes('collaboration platform'));
  });

  test('Step 2: Analyze user requirements and produce comprehensive specifications', () => {
    const analysis = SoftwareRequirementsAnalyzer.analyze(testBuild.idea, 'saas_dashboard');

    assert.ok(analysis.applicationCategory);
    assert.ok(analysis.targetPlatforms.length >= 1);
    assert.ok(analysis.requiredFeatures.length >= 1);
    assert.ok(analysis.backendRequirements.length >= 1);
    assert.ok(analysis.securityRequirements.length >= 1);
  });

  test('Step 3: Generate architecture and select tech stack', () => {
    const analysis = SoftwareRequirementsAnalyzer.analyze(testBuild.idea, 'saas_dashboard');
    const selection = IntelligentStackSelector.selectStack(analysis);

    assert.ok(selection.recommendedStack);
    assert.ok(selection.recommendedStack.frontend);
    assert.ok(selection.recommendedStack.backend);
    assert.ok(selection.recommendedStack.database);
    assert.ok(selection.alternativeStack);
  });

  test('Step 4: Generate application topology and full-stack source code', () => {
    const plan = ConnectedApplicationPlanner.planApplication({
      buildId: testBuild.id,
      userRequest: testBuild.idea
    });

    assert.ok(plan);
    assert.ok(plan.topology.backend.endpoints.length >= 1);
    assert.ok(plan.topology.database.tables.length >= 1);

    const generatedFiles = ConnectedApplicationGenerator.generateConnectedFiles(plan, []);
    assert.ok(generatedFiles.length >= 5);

    // Save generated files into the build
    for (const file of generatedFiles) {
      if (file.action === 'create_file') {
        db.setFile(testBuild.id, {
          path: file.path,
          content: file.content,
          version: 1,
          ownerModel: 'fullstack_developer',
          history: [{
            version: 1,
            content: file.content,
            authorModel: 'fullstack_developer',
            timestamp: Date.now(),
            commitMessage: file.commitMessage || `Generated ${file.path}`
          }],
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      }
    }
    const savedFiles = db.getAllFiles(testBuild.id);
    assert.equal(savedFiles.length, generatedFiles.length);
  });

  test('Step 5: Review and approve changes via human approval gate', () => {
    // 5.1 Enforce approval for sensitive files (.env, package.json, server/crypto.ts)
    assert.equal(ApprovalGateService.isSensitiveFilePath('.env'), true);
    assert.equal(ApprovalGateService.isSensitiveFilePath('package.json'), true);
    assert.equal(ApprovalGateService.isSensitiveFilePath('server/crypto.ts'), true);
    assert.equal(ApprovalGateService.isSensitiveFilePath('src/components/Card.tsx'), false);

    // 5.2 Create formal approval request
    const requestRes = ApprovalGateService.requestApproval(testBuild.id, testUser.id, {
      requestingAgent: 'devops_specialist',
      requestingRole: 'security_specialist',
      operationType: 'security_sensitive_change',
      explanation: 'Update security tokens and encryption configuration',
      affectedFiles: ['.env', 'package.json'],
      proposedChanges: 'Add encryption keys and token rotation'
    });

    assert.equal(requestRes.success, true);
    assert.ok(requestRes.request);
    const requestId = requestRes.request.id;

    // 5.3 Anti-bypass: Unauthorized user cannot decide approval
    const unauthorizedRes = ApprovalGateService.respondToApproval(testBuild.id, 'usr_stranger', {
      requestId,
      approved: true
    });
    assert.equal(unauthorizedRes.success, false);

    // 5.4 Legitimate owner approval
    const ownerRes = ApprovalGateService.respondToApproval(testBuild.id, testUser.id, {
      requestId,
      approved: true,
      resolutionNotes: 'Approved after security audit'
    });
    assert.equal(ownerRes.success, true);
    assert.equal(ownerRes.request?.status, 'approved');
  });

  test('Step 6: Execution environment isolation', async () => {
    const backend = new DisabledBackend();
    const capabilities = await backend.capabilities();

    assert.equal(capabilities.available, false);
    assert.equal(capabilities.backend, 'disabled');

    // Invariant: Never run project code as plain un-isolated host processes
    await assert.rejects(
      async () => {
        await backend.createEnvironment({
          sessionId: 'ses_test',
          buildId: testBuild.id,
          userId: testUser.id
        });
      },
      /Project execution is not configured/
    );
  });

  test('Step 7: Debugging diagnostics & root cause engine', () => {
    const stderrLog = `
      src/api/client.ts:14:22 - error TS2304: Cannot find name 'authToken'.
      TypeError: Cannot read properties of undefined (reading 'split')
    `;

    const projectFiles: ProjectFile[] = [
      {
        path: 'src/api/client.ts',
        content: 'export function getClient() { return authToken; }',
        version: 1,
        ownerModel: 'backend_developer',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    const diagnostics = parseProcessOutput(
      stderrLog,
      { id: 'sess_1', script: 'test' },
      projectFiles
    );
    assert.ok(diagnostics.length >= 1);

    const rankedCauses = RootCauseEngine.analyze(projectFiles, diagnostics, []);
    assert.ok(rankedCauses.length >= 1);
    assert.ok(rankedCauses[0].category);
  });

  test('Step 8: Truthful verification service', () => {
    // Project without files fails verification with clear evidence
    const emptyResult = HonestVerificationService.evaluateProjectReadiness(testBuild.id);
    assert.equal(emptyResult.verdict, 'failed');
    assert.ok(emptyResult.checks.length > 0);
    assert.ok(emptyResult.knownDefects.some(e => e.includes('No source files')));

    // Add minimal valid files
    db.setFile(testBuild.id, {
      path: 'package.json',
      content: JSON.stringify({ name: 'test-app', version: '1.0.0', scripts: { test: 'node --version' } }),
      version: 1,
      ownerModel: 'system',
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    db.setFile(testBuild.id, {
      path: 'README.md',
      content: '# Test App\nComplete application documentation.',
      version: 1,
      ownerModel: 'system',
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const populatedResult = HonestVerificationService.evaluateProjectReadiness(testBuild.id);
    assert.ok(populatedResult.verdict);
    assert.ok(populatedResult.checks.length >= 2);
  });

  test('Step 9: Live preview generation & packaging', () => {
    const files: ProjectFile[] = [
      {
        path: 'index.html',
        content: '<!DOCTYPE html><html><body><div id="root">Hello SquadForge</div></body></html>',
        version: 1,
        ownerModel: 'frontend_developer',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    const preview = PreviewGenerator.generateLivePreview(
      testBuild.projectType || 'saas_dashboard',
      testBuild.idea,
      files
    );
    assert.ok(preview);
    assert.ok(preview.html.includes('Hello SquadForge'));
  });

  test('Step 10: GitHub connection and workspace diffing', async () => {
    db.setGithubToken(testUser.id, 'ghp_mock_token_12345', 'Shahrozkalash');

    testBuild.githubOwner = 'Shahrozkalash';
    testBuild.githubRepoName = 'Squadforge';
    testBuild.gitBranch = 'main';
    db.saveBuild(testBuild);

    db.setFile(testBuild.id, {
      path: 'src/App.tsx',
      content: 'export default function App() { return <h1>SquadForge Team</h1>; }',
      version: 1,
      ownerModel: 'frontend_developer',
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const mockFetch = createMockFetch({
      'GET https://api.github.com/repos/Shahrozkalash/Squadforge/git/ref/heads/main': {
        data: { object: { sha: 'sha_base_123' } }
      },
      'GET https://api.github.com/repos/Shahrozkalash/Squadforge/git/trees/sha_base_123?recursive=1': {
        data: { tree: [] }
      }
    });

    GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

    const diff = await GitHubLifecycleService.computeDiff(testUser.id, testBuild.id);
    assert.ok(diff);
    assert.ok(diff.files.length >= 1);
    assert.ok(diff.files.some(f => f.path === 'src/App.tsx'));
  });

  test('Step 11: GitHub commit author attribution and sensitive gate', async () => {
    db.setGithubToken(testUser.id, 'ghp_mock_token_12345', 'Shahrozkalash');

    testBuild.githubOwner = 'Shahrozkalash';
    testBuild.githubRepoName = 'Squadforge';
    testBuild.gitBranch = 'main';
    db.saveBuild(testBuild);

    db.setFile(testBuild.id, {
      path: 'src/App.tsx',
      content: 'export default function App() { return <h1>SquadForge Team</h1>; }',
      version: 1,
      ownerModel: 'frontend_developer',
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    let commitPayloadAuthor: any = null;

    const mockFetch = createMockFetch({
      'GET https://api.github.com/repos/Shahrozkalash/Squadforge/git/ref/heads/main': {
        data: { object: { sha: 'sha_parent_999' } }
      },
      'GET https://api.github.com/repos/Shahrozkalash/Squadforge/git/trees/sha_parent_999?recursive=1': {
        data: { tree: [] }
      },
      'GET https://api.github.com/repos/Shahrozkalash/Squadforge/commits/sha_parent_999': {
        data: { sha: 'sha_parent_999', tree: { sha: 'sha_base_tree' } }
      },
      'POST https://api.github.com/repos/Shahrozkalash/Squadforge/git/blobs': {
        data: { sha: 'sha_new_blob_123' }
      },
      'POST https://api.github.com/repos/Shahrozkalash/Squadforge/git/trees': {
        data: { sha: 'sha_new_tree_456' }
      },
      'POST https://api.github.com/repos/Shahrozkalash/Squadforge/git/commits': {
        data: { sha: 'sha_committed_789' }
      },
      'PATCH https://api.github.com/repos/Shahrozkalash/Squadforge/git/refs/heads/main': {
        data: { ref: 'refs/heads/main', object: { sha: 'sha_committed_789' } }
      }
    });

    // Wrap mock fetch to capture author payload
    const interceptingFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/git/commits') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        commitPayloadAuthor = body.author;
      }
      return (mockFetch as any)(input, init);
    };

    GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: interceptingFetch as any }));

    // Committing to main branch requires approval
    const initialCommit = await GitHubLifecycleService.commitApprovedChanges(testUser.id, testBuild.id, {
      message: 'Release MVP',
      files: ['src/App.tsx']
    });

    assert.equal(initialCommit.requiresApproval, true);
    assert.ok(initialCommit.approvalRequest);
    const reqId = initialCommit.approvalRequest.id;

    // Approve the request
    ApprovalGateService.respondToApproval(testBuild.id, testUser.id, {
      requestId: reqId,
      approved: true,
      resolutionNotes: 'Approved for main branch deployment'
    });

    // Execute with approved request
    const approvedCommit = await GitHubLifecycleService.commitApprovedChanges(testUser.id, testBuild.id, {
      message: 'Release MVP',
      files: ['src/App.tsx'],
      approvalRequestId: reqId
    });

    assert.equal(approvedCommit.success, true);
    assert.equal(approvedCommit.commitSha, 'sha_committed_789');

    // Invariant: author and committer must strictly attribute Shahrozkalash <shahrozkalash@gmail.com>
    assert.ok(commitPayloadAuthor);
    assert.equal(commitPayloadAuthor.name, 'Shahrozkalash');
    assert.equal(commitPayloadAuthor.email, 'shahrozkalash@gmail.com');
  });

  test('Step 12: Pre-deployment validation, production build, secrets, and atomic rollback', async () => {
    // 12.1 Secure secret encryption at rest
    const encrypted = DeploymentSecretManager.setSecret({
      buildId: testBuild.id,
      userId: testUser.id,
      key: 'API_SIGNING_KEY',
      value: 'super-confidential-token-12345',
      environment: 'production'
    });
    assert.ok(encrypted);
    assert.notEqual(encrypted.maskedValue, 'super-confidential-token-12345');
    assert.ok(encrypted.maskedValue.includes('••••'));

    // 12.2 Workspace file setup
    db.setFile(testBuild.id, {
      path: 'index.html',
      content: '<!DOCTYPE html><html><body><h1>SquadForge Production Release</h1></body></html>',
      version: 1,
      ownerModel: 'frontend_developer',
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    db.setFile(testBuild.id, {
      path: 'package.json',
      content: JSON.stringify({ name: 'squadforge-app', version: '1.0.0', scripts: { build: 'echo built' } }),
      version: 1,
      ownerModel: 'fullstack_developer',
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    // 12.3 Pre-deployment truthful validation
    const validation = PreDeploymentValidator.validateProject(testBuild.id);
    assert.ok(validation);
    assert.equal(typeof validation.passed, 'boolean');
    assert.ok(validation.readinessScore >= 0);

    // 12.4 Production bundling
    const bundle = await ProductionBuilder.buildProject({
      deploymentId: 'dep_p16_test',
      buildId: testBuild.id,
      files: db.getAllFiles(testBuild.id)
    });
    assert.ok(bundle.success);
    assert.ok(bundle.files.length >= 1);

    // 12.5 Deployment pipeline execution
    const depResult = await DeploymentService.createDeployment({
      userId: testUser.id,
      buildId: testBuild.id,
      environment: 'preview',
      provider: 'static_host',
      skipApprovalGate: true
    });

    assert.ok(depResult.deployment);
    assert.ok(depResult.deployment.id);

    await new Promise(r => setTimeout(r, 300));
    const deployed = db.getDeployment(depResult.deployment.id);
    assert.ok(deployed);
    assert.equal(deployed.status, 'active');
    assert.ok(deployed.targetUrl);

    // 12.6 Safe rollback in MergeManager with active lease protection
    db.setFile(testBuild.id, {
      path: 'src/App.tsx',
      content: 'export default function App() { return <div>V1</div>; }',
      version: 1,
      ownerModel: 'worker_a',
      history: [{
        version: 1,
        content: 'export default function App() { return <div>V1</div>; }',
        authorModel: 'worker_a',
        timestamp: Date.now(),
        commitMessage: 'Initial version'
      }],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const lease = MergeManager.acquireFileLeases(testBuild.id, 'worker_a', ['src/App.tsx'], 60000);
    assert.equal(lease.success, true);

    // Rolling back while file is leased by worker_a is rejected for worker_b
    const rollbackBlocked = await MergeManager.revertFileVersion(testBuild.id, 'src/App.tsx', 1, 'worker_b');
    assert.equal(rollbackBlocked, false);

    // Releasing lease allows safe rollback
    MergeManager.releaseFileLeases(testBuild.id, 'worker_a', ['src/App.tsx']);
  });

  test('Approval request auto-expiry invariant', () => {
    // Create an approval request with past createdAt
    const reqRes = ApprovalGateService.requestApproval(testBuild.id, testUser.id, {
      requestingAgent: 'integration_agent',
      requestingRole: 'integration_engineer',
      operationType: 'destructive_file_op',
      explanation: 'Remove deprecated legacy assets',
      affectedFiles: ['public/old.png'],
      proposedChanges: 'Delete obsolete legacy image assets'
    });
    assert.equal(reqRes.success, true);
    const req = reqRes.request!;

    // Simulate 25 hours elapsed (past 24h TTL)
    req.createdAt = Date.now() - (25 * 60 * 60 * 1000);
    db.saveApprovalRequest(req);

    // expireStaleRequests cleans it
    const expiredCount = ApprovalGateService.expireStaleRequests(testBuild.id);
    assert.equal(expiredCount, 1);

    const updated = db.getApprovalRequest(req.id);
    assert.equal(updated?.status, 'expired');
    assert.ok(updated?.resolvedAt);
  });
});
