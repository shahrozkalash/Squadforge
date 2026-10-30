import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { ExecutionAdapter } from '../server/swarm/executionAdapter.js';
import { db } from '../server/store.js';

describe('SquadForge File Workspace CRUD, Limits & Versioning', () => {
  const buildId = 'test_file_ops_build';

  beforeEach(() => {
    db.saveBuild({
      id: buildId,
      userId: 'test_file_user',
      idea: 'File Operations Test',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 5,
      maxDurationSeconds: 100,
      patchesAppliedCount: 0
    });
  });

  test('Creates and patches files with incremental version history', async () => {
    const createRes = await MergeManager.createFile(buildId, 'agent_1', {
      action: 'create_file',
      path: 'src/app.ts',
      content: 'export const version = 1;\nexport const name = "app";'
    });

    assert.equal(createRes.success, true);
    assert.equal(createRes.version, 1);

    const patchRes = await MergeManager.applyPatch(buildId, 'agent_2', {
      action: 'patch_file',
      path: 'src/app.ts',
      edits: [{ find: 'version = 1', replace: 'version = 2' }]
    });

    assert.equal(patchRes.success, true);
    assert.equal(patchRes.version, 2);

    const file = db.getFile(buildId, 'src/app.ts');
    assert.ok(file);
    assert.equal(file.version, 2);
    assert.equal(file.history.length, 2);
  });

  test('Path traversal attempts are blocked on create and patch', async () => {
    const res = await MergeManager.createFile(buildId, 'agent_1', {
      action: 'create_file',
      path: '../../etc/passwd',
      content: 'malicious'
    });

    assert.equal(res.success, false);
    assert.ok(res.error?.includes('Invalid file path'));
  });

  test('Enforces maximum file size limit (500 KB)', async () => {
    const hugeContent = 'a'.repeat(600 * 1024); // 600 KB
    const res = await MergeManager.createFile(buildId, 'agent_1', {
      action: 'create_file',
      path: 'src/huge.txt',
      content: hugeContent
    });

    assert.equal(res.success, false);
    assert.ok(res.error?.includes('File size limit exceeded'));
  });

  test('Deletes existing files and emits patch event', async () => {
    await MergeManager.createFile(buildId, 'agent_1', {
      action: 'create_file',
      path: 'src/temp.ts',
      content: 'export const temp = true;'
    });

    assert.ok(db.getFile(buildId, 'src/temp.ts'));

    const delRes = await MergeManager.deleteFile(buildId, 'agent_1', {
      action: 'delete_file',
      path: 'src/temp.ts'
    });

    assert.equal(delRes.success, true);
    assert.equal(db.getFile(buildId, 'src/temp.ts'), undefined);
  });

  test('Renames existing files while preserving content and updating path', async () => {
    await MergeManager.createFile(buildId, 'agent_1', {
      action: 'create_file',
      path: 'src/oldName.ts',
      content: 'export const data = 42;'
    });

    const renameRes = await MergeManager.renameFile(buildId, 'agent_1', {
      action: 'rename_file',
      oldPath: 'src/oldName.ts',
      newPath: 'src/newName.ts'
    });

    assert.equal(renameRes.success, true);
    assert.equal(db.getFile(buildId, 'src/oldName.ts'), undefined);

    const newFile = db.getFile(buildId, 'src/newName.ts');
    assert.ok(newFile);
    assert.equal(newFile.content, 'export const data = 42;');
    assert.equal(newFile.version, 2);
  });

  test('Sanitization prevents Zip Slip attacks and path traversal sequences in export files', () => {
    const maliciousPaths = [
      '../../etc/passwd',
      '..\\..\\windows\\system32\\cmd.exe',
      '../../../app/server.ts',
      '/absolute/path/file.ts',
      'src/../../escaped.ts',
      'folder/\0nullbyte.ts'
    ];

    for (const raw of maliciousPaths) {
      const { valid, cleanPath } = ExecutionAdapter.sanitizeFilePath(raw);
      if (valid) {
        // If considered valid, it MUST NOT contain traversal sequences or leading slashes
        assert.equal(cleanPath.includes('..'), false, `Sanitized path '${cleanPath}' must not contain '..'`);
        assert.equal(cleanPath.startsWith('/'), false, `Sanitized path '${cleanPath}' must not start with '/'`);
        assert.equal(cleanPath.startsWith('\\'), false, `Sanitized path '${cleanPath}' must not start with '\\'`);
      } else {
        assert.equal(valid, false, `Malicious path '${raw}' was correctly rejected`);
      }
    }
  });
});
