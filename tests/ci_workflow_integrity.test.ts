import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('SquadForge CI Workflow & Lockfile Integrity', () => {
  const rootDir = process.cwd();

  test('package-lock.json exists, is valid JSON, and specifies lockfileVersion >= 2', () => {
    const lockfilePath = path.join(rootDir, 'package-lock.json');
    assert.ok(fs.existsSync(lockfilePath), 'package-lock.json must exist for npm ci and actions/setup-node caching');

    const lockfileContent = fs.readFileSync(lockfilePath, 'utf-8');
    const lock = JSON.parse(lockfileContent);

    assert.ok(lock.lockfileVersion >= 2, 'lockfileVersion should be >= 2 for npm 7+ compatibility');
    assert.equal(lock.name, 'squadforge');
    assert.ok(lock.packages && lock.packages[''], 'Root package must be defined in lockfile');
  });

  test('Incompatible foreign lockfiles (bun.lock, yarn.lock, pnpm-lock) do not exist in root', () => {
    const forbiddenLockfiles = ['bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml'];
    for (const f of forbiddenLockfiles) {
      const p = path.join(rootDir, f);
      assert.equal(fs.existsSync(p), false, `Forbidden lockfile "${f}" must not exist in repository root`);
    }
  });

  test('CI workflow file exists and defines all required pipeline stages', () => {
    const workflowPath = path.join(rootDir, '.github/workflows/ci.yml');
    assert.ok(fs.existsSync(workflowPath), '.github/workflows/ci.yml must exist');

    const content = fs.readFileSync(workflowPath, 'utf-8');
    assert.match(content, /actions\/checkout@v4/, 'Must use checkout@v4');
    assert.match(content, /actions\/setup-node@v4/, 'Must use setup-node@v4');
    assert.match(content, /cache:\s*['"]?npm['"]?/, 'Must configure npm cache');
    assert.match(content, /npm\s+ci/, 'Must execute npm ci');
    assert.match(content, /npm\s+run\s+lint/, 'Must execute npm run lint');
    assert.match(content, /npm\s+test/, 'Must execute npm test');
    assert.match(content, /npm\s+run\s+build/, 'Must execute npm run build');
  });

  test('.env.example documents all required and optional environment keys without containing secrets', () => {
    const envExamplePath = path.join(rootDir, '.env.example');
    assert.ok(fs.existsSync(envExamplePath), '.env.example must exist');

    const content = fs.readFileSync(envExamplePath, 'utf-8');
    const requiredKeys = ['GEMINI_API_KEY', 'ENCRYPTION_SECRET', 'APP_URL', 'PORT', 'SQLITE_DB_PATH'];
    for (const key of requiredKeys) {
      assert.match(content, new RegExp(key), `.env.example must mention ${key}`);
    }

    // Ensure no actual secrets are leaked in .env.example
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [k, v] = trimmed.split('=');
      if (k === 'PORT' || k === 'NODE_ENV') continue;
      assert.equal((v || '').trim(), '', `Key ${k} in .env.example must not have hardcoded secret value`);
    }
  });
});
