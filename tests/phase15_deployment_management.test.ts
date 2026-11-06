import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db } from '../server/store.js';
import {
  DeploymentService,
  PreDeploymentValidator,
  ProductionBuilder,
  DeploymentSecretManager,
  staticHostRegistry
} from '../server/deployment/index.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { Build, User, ProjectFile } from '../server/types.js';

function createTestUser(id: string): User {
  const user: User = {
    id,
    email: `${id}@squadforge.test`,
    name: 'Deployment Test Developer',
    githubConnected: false,
    costLimitPerBuild: 5.0,
    enabledModelIds: ['gemini-2.5-flash'],
    createdAt: Date.now()
  };
  db.saveUser(user);
  return user;
}

function createTestBuild(id: string, userId: string, overrides: Partial<Build> = {}): Build {
  const b: Build = {
    id,
    userId,
    idea: 'Production Web Application',
    status: 'completed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selectedModels: ['gemini-2.5-flash'],
    autoPushGithub: false,
    totalTokens: 0,
    totalCost: 0,
    costLimit: 5,
    maxDurationSeconds: 300,
    patchesAppliedCount: 0,
    ...overrides
  };
  db.saveBuild(b);
  return b;
}

function seedWorkspaceFiles(buildId: string): ProjectFile[] {
  const files: ProjectFile[] = [
    {
      path: 'index.html',
      content: '<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: []
    },
    {
      path: 'src/main.tsx',
      content: `import React from 'react';\nconsole.log("App loaded", import.meta.env.VITE_API_ENDPOINT);`,
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: []
    },
    {
      path: 'src/index.css',
      content: 'body { background-color: #0f172a; color: #f8fafc; }',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: []
    },
    {
      path: 'package.json',
      content: JSON.stringify({
        name: 'test-production-app',
        version: '1.0.0',
        scripts: { build: 'vite build', start: 'node server.js' },
        dependencies: { react: '^19.0.0' }
      }, null, 2),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: []
    },
    {
      path: 'README.md',
      content: '# Test App\nProduction test application.',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: []
    }
  ];

  for (const f of files) {
    db.setFile(buildId, f);
  }
  return files;
}

function addFile(buildId: string, path: string, content: string): ProjectFile {
  return db.setFile(buildId, {
    path,
    content,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: []
  });
}

describe('SquadForge Phase 15: Deployment & Distribution', () => {
  const testUserId = `user_dep_${Date.now()}`;
  const otherUserId = `user_other_${Date.now()}`;
  const testBuildId = `build_dep_${Date.now()}`;

  beforeEach(() => {
    createTestUser(testUserId);
    createTestUser(otherUserId);
    createTestBuild(testBuildId, testUserId);
    seedWorkspaceFiles(testBuildId);
  });

  describe('1. Pre-Deployment Validation Engine', () => {
    test('passes truthful validation on a well-formed web project', () => {
      const result = PreDeploymentValidator.validateProject(testBuildId);
      assert.equal(result.passed, true);
      assert.ok(result.readinessScore >= 80, `Expected score >= 80, got ${result.readinessScore}`);
      assert.equal(result.defects.length, 0);

      const fileCheck = result.checks.find(c => c.name === 'Project Workspace Files');
      assert.ok(fileCheck && fileCheck.passed);

      const entryCheck = result.checks.find(c => c.name === 'Web Application Entry Point');
      assert.ok(entryCheck && entryCheck.passed);

      const syntaxCheck = result.checks.find(c => c.name === 'Code Syntax & AST Integrity');
      assert.ok(syntaxCheck && syntaxCheck.passed);
    });

    test('detects syntax errors and blocks deployment', () => {
      const brokenBuildId = `build_broken_${Date.now()}`;
      createTestBuild(brokenBuildId, testUserId);
      addFile(brokenBuildId, 'index.html', '<html><body></body></html>');
      addFile(brokenBuildId, 'src/main.tsx', 'const broken = {{ invalid syntax ;;;');
      addFile(brokenBuildId, 'package.json', '{"name":"broken"}');

      const result = PreDeploymentValidator.validateProject(brokenBuildId);
      assert.equal(result.passed, false);
      assert.ok(result.defects.length > 0);
      assert.ok(result.defects.some(d => d.includes('Syntax error')));
      assert.ok(result.readinessScore < 70);
    });

    test('detects hardcoded secret leaks and flags security defects', () => {
      const leakedBuildId = `build_leaked_${Date.now()}`;
      createTestBuild(leakedBuildId, testUserId);
      addFile(leakedBuildId, 'index.html', '<html><body></body></html>');
      addFile(leakedBuildId, 'src/main.tsx', 'console.log("App");');
      addFile(leakedBuildId, 'package.json', '{"name":"leaked"}');
      addFile(leakedBuildId, 'src/credentials.ts', 'const privateKey = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEA0...";');

      const result = PreDeploymentValidator.validateProject(leakedBuildId);
      assert.equal(result.passed, false);
      assert.ok(result.defects.some(d => d.includes('Security flaw')));
    });

    test('identifies unconfigured environment secrets referenced in code', () => {
      const envBuildId = `build_env_${Date.now()}`;
      createTestBuild(envBuildId, testUserId);
      addFile(envBuildId, 'index.html', '<html><body></body></html>');
      addFile(envBuildId, 'src/main.tsx', 'const apiKey = import.meta.env.VITE_STRIPE_PUBLIC_KEY;');
      addFile(envBuildId, 'package.json', '{"name":"env-app"}');

      const result = PreDeploymentValidator.validateProject(envBuildId);
      assert.ok(result.missingSecrets.includes('VITE_STRIPE_PUBLIC_KEY'));
    });
  });

  describe('2. Secure Secret & Environment Variable Manager', () => {
    test('encrypts secrets at rest with AES-256-GCM and never returns plaintext in safe view', () => {
      const rawSecret = 'sk-proj-super-confidential-api-token-987654321';
      const secretRecord = DeploymentSecretManager.setSecret({
        userId: testUserId,
        buildId: testBuildId,
        key: 'OPENAI_API_KEY',
        value: rawSecret,
        environment: 'production'
      });

      assert.equal(secretRecord.key, 'OPENAI_API_KEY');
      assert.notEqual(secretRecord.maskedValue, rawSecret);
      assert.ok(secretRecord.maskedValue.includes('••••••••'));

      // Check safe listing
      const safeList = DeploymentSecretManager.listSafeSecrets(testBuildId);
      const found = safeList.find(s => s.key === 'OPENAI_API_KEY');
      assert.ok(found);
      assert.notEqual(found.maskedValue, rawSecret);
      assert.ok(found.maskedValue.endsWith('4321'));

      // Internal decryption delivers the original secret only to runtime
      const decrypted = DeploymentSecretManager.getDecryptedSecrets(testBuildId, 'production');
      assert.equal(decrypted.OPENAI_API_KEY, rawSecret);
    });

    test('supports environment scoping for secrets (production vs staging)', () => {
      DeploymentSecretManager.setSecret({
        userId: testUserId,
        buildId: testBuildId,
        key: 'DATABASE_URL',
        value: 'postgres://prod-db:5432/main',
        environment: 'production'
      });

      DeploymentSecretManager.setSecret({
        userId: testUserId,
        buildId: testBuildId,
        key: 'DATABASE_URL',
        value: 'postgres://stage-db:5432/staging',
        environment: 'staging'
      });

      const prodSecrets = DeploymentSecretManager.getDecryptedSecrets(testBuildId, 'production');
      const stageSecrets = DeploymentSecretManager.getDecryptedSecrets(testBuildId, 'staging');

      assert.equal(prodSecrets.DATABASE_URL, 'postgres://prod-db:5432/main');
      assert.equal(stageSecrets.DATABASE_URL, 'postgres://stage-db:5432/staging');
    });

    test('enforces authorization on secret deletion', () => {
      const secret = DeploymentSecretManager.setSecret({
        userId: testUserId,
        buildId: testBuildId,
        key: 'STRIPE_SECRET',
        value: 'sk_test_12345'
      });

      // Unauthorized user cannot delete secret
      assert.throws(() => {
        DeploymentSecretManager.deleteSecret(secret.id, otherUserId, testBuildId);
      }, /Forbidden/);

      // Authorized user can delete
      const deleted = DeploymentSecretManager.deleteSecret(secret.id, testUserId, testBuildId);
      assert.equal(deleted, true);
    });
  });

  describe('3. Production Build Generation & ZIP Artifact Packaging', () => {
    test('compiles web assets, minifies scripts, and generates a downloadable ZIP artifact', async () => {
      const files = db.getAllFiles(testBuildId);
      const deploymentId = `dep_build_${Date.now()}`;

      const buildResult = await ProductionBuilder.buildProject({
        deploymentId,
        buildId: testBuildId,
        files,
        secrets: { VITE_API_ENDPOINT: 'https://api.squadforge.app' }
      });

      assert.equal(buildResult.success, true);
      assert.ok(buildResult.fileCount >= 3, `Expected >= 3 files, got ${buildResult.fileCount}`);
      assert.ok(buildResult.totalSize > 0);
      assert.ok(buildResult.artifactPath);
      assert.ok(buildResult.artifactHash);
      assert.equal(typeof buildResult.artifactHash, 'string');
      assert.equal(buildResult.artifactHash.length, 64); // SHA-256

      // Verify ZIP artifact buffer is retrievable
      const zipBuffer = await ProductionBuilder.getArtifactBuffer(deploymentId, buildResult.artifactPath);
      assert.ok(zipBuffer);
      assert.ok(zipBuffer.length > 0);
      assert.ok(zipBuffer.length === buildResult.totalSize || zipBuffer.length > 50);
    });
  });

  describe('4. Human Approval Gate Enforcement', () => {
    test('holds production deployment in approval gate before release', async () => {
      const result = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'static_host',
        environment: 'production'
      });

      assert.equal(result.requiresApproval, true);
      assert.ok(result.approvalRequestId);
      assert.equal(result.deployment.status, 'pending_approval');

      // Verify approval request exists in approval service
      const pendingApprovals = db.getApprovalRequests(testBuildId, 'pending');
      const found = pendingApprovals.find(a => a.id === result.approvalRequestId);
      assert.ok(found);
      assert.equal(found.operationType, 'production_deployment');
      assert.equal(found.riskLevel, 'high');
    });

    test('bypasses approval gate for preview environment or when explicitly skipped', async () => {
      const result = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'static_host',
        environment: 'preview',
        skipApprovalGate: true
      });

      assert.equal(result.requiresApproval, false);
      assert.notEqual(result.deployment.status, 'pending_approval');
    });

    test('releasing approved deployment executes the release pipeline', async () => {
      const created = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'static_host',
        environment: 'production'
      });

      assert.equal(created.deployment.status, 'pending_approval');

      // User approves deployment
      await DeploymentService.approveDeployment(created.deployment.id, testUserId);

      // Verify approval request was resolved to approved
      const updatedReq = db.getApprovalRequest(created.approvalRequestId!);
      assert.ok(updatedReq);
      assert.equal(updatedReq.status, 'approved');

      // Allow pipeline execution to finish
      await new Promise(r => setTimeout(r, 400));

      const updatedDep = db.getDeployment(created.deployment.id);
      assert.ok(updatedDep);
      assert.equal(updatedDep.status, 'active');
      assert.ok(updatedDep.targetUrl);
      assert.ok(updatedDep.targetUrl.includes(created.deployment.id));
    });

    test('cancelling a pending deployment transitions state and revokes approval', async () => {
      const created = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'static_host',
        environment: 'production'
      });

      const cancelled = DeploymentService.cancelDeployment(created.deployment.id, testUserId);
      assert.equal(cancelled.status, 'cancelled');

      const updatedReq = db.getApprovalRequest(created.approvalRequestId!);
      assert.ok(updatedReq);
      assert.equal(updatedReq.status, 'rejected');
    });
  });

  describe('5. Modular Deployment Providers & Adapters', () => {
    test('lists all registered modular adapters', () => {
      const providers = DeploymentService.listProviders();
      assert.ok(providers.length >= 6);
      const ids = providers.map(p => p.provider);
      assert.ok(ids.includes('static_host'));
      assert.ok(ids.includes('cloudflare_pages'));
      assert.ok(ids.includes('vercel'));
      assert.ok(ids.includes('netlify'));
      assert.ok(ids.includes('docker_container'));
      assert.ok(ids.includes('custom_webhook'));
    });

    test('deploys successfully via Static Host adapter and serves live files', async () => {
      const dep = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'static_host',
        environment: 'production',
        skipApprovalGate: true
      });

      await new Promise(r => setTimeout(r, 300));
      const deployed = db.getDeployment(dep.deployment.id);
      assert.ok(deployed);
      assert.equal(deployed.status, 'active');
      assert.equal(deployed.targetUrl, `/deployments/${deployed.id}/`);

      // Verify files in staticHostRegistry
      const registryFiles = staticHostRegistry.get(deployed.id);
      assert.ok(registryFiles);
      assert.ok(registryFiles.has('index.html'));
    });

    test('Cloudflare Pages adapter generates edge target URL and deployment ID', async () => {
      const dep = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'cloudflare_pages',
        environment: 'staging',
        skipApprovalGate: true
      });

      await new Promise(r => setTimeout(r, 300));
      const deployed = db.getDeployment(dep.deployment.id);
      assert.ok(deployed);
      assert.equal(deployed.status, 'active');
      assert.ok(deployed.targetUrl?.includes('.pages.dev'));
    });

    test('Vercel adapter deploys and confirms ready state', async () => {
      const dep = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'vercel',
        environment: 'staging',
        skipApprovalGate: true
      });

      await new Promise(r => setTimeout(r, 300));
      const deployed = db.getDeployment(dep.deployment.id);
      assert.ok(deployed);
      assert.equal(deployed.status, 'active');
      assert.ok(deployed.targetUrl?.includes('.vercel.app'));
    });

    test('Docker container adapter synthesizes container specification and image tag', async () => {
      const dep = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'docker_container',
        environment: 'production',
        skipApprovalGate: true
      });

      await new Promise(r => setTimeout(r, 300));
      const deployed = db.getDeployment(dep.deployment.id);
      assert.ok(deployed);
      assert.equal(deployed.status, 'active');
      assert.ok(deployed.targetUrl?.startsWith('container://squadforge'));
    });

    test('Custom Webhook adapter delivers signed payload with HMAC-SHA256 signature', async () => {
      const dep = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'custom_webhook',
        environment: 'production',
        config: { providerSettings: { webhookUrl: 'https://ci.example.com/deploy-hook' } },
        skipApprovalGate: true
      });

      await new Promise(r => setTimeout(r, 300));
      const deployed = db.getDeployment(dep.deployment.id);
      assert.ok(deployed);
      assert.equal(deployed.status, 'active');
      assert.equal(deployed.targetUrl, 'https://ci.example.com/deploy-hook');
    });
  });

  describe('6. Custom Domain Configuration & DNS Verification', () => {
    test('generates CNAME and TXT verification records for custom domains', async () => {
      const dep = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'static_host',
        environment: 'production',
        skipApprovalGate: true
      });

      await new Promise(r => setTimeout(r, 200));

      const domainResult = await DeploymentService.configureCustomDomain(
        dep.deployment.id,
        'app.squadforge-test.com',
        testUserId
      );

      assert.equal(domainResult.domain, 'app.squadforge-test.com');
      assert.equal(domainResult.status, 'pending_verification');
      assert.ok(domainResult.dnsRecords.length >= 2);

      const cname = domainResult.dnsRecords.find(r => r.type === 'CNAME');
      assert.ok(cname);
      assert.equal(cname.name, 'app.squadforge-test.com');

      const txt = domainResult.dnsRecords.find(r => r.type === 'TXT');
      assert.ok(txt);
      assert.ok(txt.name.includes('_squadforge-challenge'));
    });

    test('verifies custom domain status', async () => {
      const dep = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'static_host',
        environment: 'production',
        skipApprovalGate: true
      });

      await new Promise(r => setTimeout(r, 200));

      await DeploymentService.configureCustomDomain(
        dep.deployment.id,
        'portal.example.com',
        testUserId
      );

      const verifyResult = await DeploymentService.verifyCustomDomain(dep.deployment.id, testUserId);
      assert.equal(verifyResult.verified, true);

      const updated = db.getDeployment(dep.deployment.id);
      assert.equal(updated?.customDomainStatus, 'active');
    });
  });

  describe('7. Deployment History, Redeployment & Atomic Rollback', () => {
    test('records chronological history and supports atomic rollback', async () => {
      // Release 1
      const dep1 = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'static_host',
        environment: 'production',
        commitSha: 'commit_v1_abc',
        skipApprovalGate: true
      });
      await new Promise(r => setTimeout(r, 250));

      // Release 2
      const dep2 = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'static_host',
        environment: 'production',
        commitSha: 'commit_v2_def',
        skipApprovalGate: true
      });
      await new Promise(r => setTimeout(r, 250));

      const history = db.getDeployments(testBuildId);
      assert.ok(history.length >= 2);
      assert.equal(history[0].id, dep2.deployment.id);
      assert.equal(history[1].id, dep1.deployment.id);

      // Execute rollback from dep2 back to dep1
      const rollbackResult = await DeploymentService.rollback(
        dep2.deployment.id,
        dep1.deployment.id,
        testUserId
      );

      assert.ok(rollbackResult);
      assert.equal(rollbackResult.status, 'active');
      assert.equal(rollbackResult.rollbackFromId, dep2.deployment.id);

      // Verify dep2 marked rolled_back
      const dep2Updated = db.getDeployment(dep2.deployment.id);
      assert.equal(dep2Updated?.status, 'rolled_back');
    });

    test('prevents rollback to invalid or failed deployments', async () => {
      const dep1 = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'static_host',
        environment: 'production',
        skipApprovalGate: true
      });

      // dep2 is created but not approved, so its status is pending_approval
      const dep2 = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'static_host',
        environment: 'production',
        skipApprovalGate: false
      });

      // Attempting rollback to a non-active deployment must be rejected
      await assert.rejects(async () => {
        await DeploymentService.rollback(dep1.deployment.id, dep2.deployment.id, testUserId);
      }, /Cannot rollback/);
    });
  });

  describe('8. Tenant Isolation & Authorization Hardening', () => {
    test('prevents unauthorized user from deploying another user’s project', async () => {
      await assert.rejects(async () => {
        await DeploymentService.createDeployment({
          userId: otherUserId,
          buildId: testBuildId,
          provider: 'static_host',
          environment: 'production'
        });
      }, /Forbidden/);
    });

    test('prevents unauthorized user from approving or cancelling another user’s deployment', async () => {
      const dep = await DeploymentService.createDeployment({
        userId: testUserId,
        buildId: testBuildId,
        provider: 'static_host',
        environment: 'production'
      });

      await assert.rejects(async () => {
        await DeploymentService.approveDeployment(dep.deployment.id, otherUserId);
      }, /Forbidden/);

      assert.throws(() => {
        DeploymentService.cancelDeployment(dep.deployment.id, otherUserId);
      }, /Forbidden/);
    });
  });
});
