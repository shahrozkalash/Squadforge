import test, { describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../server.js';
import { db } from '../server/store.js';
import { User, Build } from '../server/types.js';

let serverInstance: any;
let baseUrl = '';

describe('SquadForge Phase 15: Deployment HTTP Routes & Security Integration', () => {
  let testUser: User;
  let otherUser: User;
  let sessionToken: string;
  let otherSessionToken: string;
  let headers: Record<string, string>;
  let otherHeaders: Record<string, string>;
  let testBuild: Build;

  beforeEach(async () => {
    if (!serverInstance) {
      await new Promise<void>((resolve) => {
        serverInstance = app.listen(0, '127.0.0.1', () => {
          const addr = serverInstance.address();
          baseUrl = `http://127.0.0.1:${typeof addr === 'object' ? addr.port : 3000}`;
          resolve();
        });
      });
    }

    const uid = `usr_route_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    testUser = {
      id: uid,
      email: `${uid}@squadforge.test`,
      name: 'Route Test Developer',
      githubConnected: false,
      costLimitPerBuild: 5.0,
      enabledModelIds: ['gemini-2.5-flash'],
      createdAt: Date.now()
    };
    db.saveUser(testUser);

    const otherUid = `usr_other_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    otherUser = {
      id: otherUid,
      email: `${otherUid}@squadforge.test`,
      name: 'Other Developer',
      githubConnected: false,
      costLimitPerBuild: 5.0,
      enabledModelIds: ['gemini-2.5-flash'],
      createdAt: Date.now()
    };
    db.saveUser(otherUser);

    sessionToken = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    db.createSession(testUser.id, sessionToken);

    otherSessionToken = `sess_other_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    db.createSession(otherUser.id, otherSessionToken);

    headers = {
      'Content-Type': 'application/json',
      'Cookie': `squadforge_session=${sessionToken}`
    };

    otherHeaders = {
      'Content-Type': 'application/json',
      'Cookie': `squadforge_session=${otherSessionToken}`
    };

    const bid = `bld_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    testBuild = {
      id: bid,
      userId: testUser.id,
      idea: 'Route Test App',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini-2.5-flash'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 5,
      maxDurationSeconds: 300,
      patchesAppliedCount: 0
    };
    db.saveBuild(testBuild);

    // Seed workspace files
    db.setFile(bid, {
      path: 'index.html',
      content: '<!doctype html><html><head><title>App</title></head><body><h1>Hello Deployed App</h1></body></html>',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: []
    });

    db.setFile(bid, {
      path: 'src/main.tsx',
      content: 'console.log("Deployed App Script");',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: []
    });

    db.setFile(bid, {
      path: 'package.json',
      content: JSON.stringify({ name: 'route-test-app', version: '1.0.0' }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: []
    });
  });

  after(() => {
    if (serverInstance) {
      serverInstance.close();
    }
  });

  test('Route 1: GET /api/deployments/providers lists all supported providers', async () => {
    const res = await fetch(`${baseUrl}/api/deployments/providers`, { headers });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.providers));
    assert.ok(data.providers.length >= 6);
  });

  test('Route 2: GET /api/builds/:id/pre-deploy-validation evaluates project readiness', async () => {
    const res = await fetch(`${baseUrl}/api/builds/${testBuild.id}/pre-deploy-validation`, { headers });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.passed, true);
    assert.ok(data.readinessScore >= 80);
    assert.ok(Array.isArray(data.checks));
  });

  test('Route 3: POST /api/builds/:id/deployments enforces approval gate for production', async () => {
    const res = await fetch(`${baseUrl}/api/builds/${testBuild.id}/deployments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'static_host',
        environment: 'production'
      })
    });

    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.status, 'pending_approval');
    assert.ok(data.approvalRequestId);
    assert.equal(data.deployment.status, 'pending_approval');
  });

  test('Route 4: POST /api/deployments/:id/approve releases held deployment', async () => {
    const initRes = await fetch(`${baseUrl}/api/builds/${testBuild.id}/deployments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'static_host',
        environment: 'production'
      })
    });
    const initData = await initRes.json();
    const deploymentId = initData.deployment.id;

    const approveRes = await fetch(`${baseUrl}/api/deployments/${deploymentId}/approve`, {
      method: 'POST',
      headers
    });
    assert.equal(approveRes.status, 200);
    const approveData = await approveRes.json();
    assert.ok(approveData.message.includes('approved'));

    // Wait for pipeline execution
    await new Promise(r => setTimeout(r, 400));

    const getRes = await fetch(`${baseUrl}/api/deployments/${deploymentId}`, { headers });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.deployment.status, 'active');
    assert.ok(getData.deployment.targetUrl);
  });

  test('Route 5: GET /deployments/:id/ serves static hosted application with SPA fallback', async () => {
    const initRes = await fetch(`${baseUrl}/api/builds/${testBuild.id}/deployments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'static_host',
        environment: 'production',
        skipApprovalGate: true
      })
    });
    const initData = await initRes.json();
    const deploymentId = initData.deployment.id;

    await new Promise(r => setTimeout(r, 400));

    // Request the deployed application index.html
    const appRes = await fetch(`${baseUrl}/deployments/${deploymentId}/`);
    assert.equal(appRes.status, 200);
    const html = await appRes.text();
    assert.ok(html.includes('Hello Deployed App') || html.includes('root'));
  });

  test('Route 6: GET /api/deployments/:id/artifact downloads generated production ZIP bundle', async () => {
    const initRes = await fetch(`${baseUrl}/api/builds/${testBuild.id}/deployments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'static_host',
        environment: 'production',
        skipApprovalGate: true
      })
    });
    const initData = await initRes.json();
    const deploymentId = initData.deployment.id;

    await new Promise(r => setTimeout(r, 400));

    const artifactRes = await fetch(`${baseUrl}/api/deployments/${deploymentId}/artifact`, { headers });
    assert.equal(artifactRes.status, 200);
    assert.equal(artifactRes.headers.get('content-type'), 'application/zip');
    const buffer = await artifactRes.arrayBuffer();
    assert.ok(buffer.byteLength > 100);
  });

  test('Route 7: Secure Deployment Secrets CRUD endpoints', async () => {
    // 1. Create Secret
    const postRes = await fetch(`${baseUrl}/api/builds/${testBuild.id}/deployment-secrets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        key: 'DATABASE_SECRET_KEY',
        value: 'super-sensitive-passphrase-1234',
        environment: 'production'
      })
    });
    assert.equal(postRes.status, 201);
    const postData = await postRes.json();
    assert.equal(postData.secret.key, 'DATABASE_SECRET_KEY');
    assert.ok(postData.secret.maskedValue.includes('••••••••'));

    // 2. List Secrets (Masked)
    const listRes = await fetch(`${baseUrl}/api/builds/${testBuild.id}/deployment-secrets`, { headers });
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    const found = listData.secrets.find((s: any) => s.key === 'DATABASE_SECRET_KEY');
    assert.ok(found);
    assert.ok(found.maskedValue.endsWith('1234'));

    // 3. Delete Secret
    const delRes = await fetch(`${baseUrl}/api/builds/${testBuild.id}/deployment-secrets/${found.id}`, {
      method: 'DELETE',
      headers
    });
    assert.equal(delRes.status, 200);
  });

  test('Route 8: Custom domain configuration & verification endpoints', async () => {
    const initRes = await fetch(`${baseUrl}/api/builds/${testBuild.id}/deployments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'static_host',
        environment: 'production',
        skipApprovalGate: true
      })
    });
    const initData = await initRes.json();
    const deploymentId = initData.deployment.id;

    await new Promise(r => setTimeout(r, 300));

    // Configure domain
    const configRes = await fetch(`${baseUrl}/api/deployments/${deploymentId}/custom-domain`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ domain: 'api.production-domain.org' })
    });
    assert.equal(configRes.status, 200);
    const configData = await configRes.json();
    assert.equal(configData.domain, 'api.production-domain.org');
    assert.ok(configData.dnsRecords.length >= 2);

    // Verify domain
    const verifyRes = await fetch(`${baseUrl}/api/deployments/${deploymentId}/custom-domain/verify`, { headers });
    assert.equal(verifyRes.status, 200);
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.verified, true);
  });

  test('Route 9: Enforces multi-tenant authorization security (rejects other users)', async () => {
    // Attempting to deploy another user's build returns 403 Forbidden
    const unauthRes = await fetch(`${baseUrl}/api/builds/${testBuild.id}/deployments`, {
      method: 'POST',
      headers: otherHeaders,
      body: JSON.stringify({ provider: 'static_host' })
    });
    assert.equal(unauthRes.status, 403);

    // Attempting to list another user's secrets returns 403 Forbidden
    const secretsRes = await fetch(`${baseUrl}/api/builds/${testBuild.id}/deployment-secrets`, {
      headers: otherHeaders
    });
    assert.equal(secretsRes.status, 403);
  });
});
