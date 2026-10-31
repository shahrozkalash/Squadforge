import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { sanitizeProjectFilePath } from '../server/swarm/previewGenerator.js';
import { ExecutionAdapter } from '../server/swarm/executionAdapter.js';

test('Path Security: sanitizeProjectFilePath test matrix', async (t) => {
  await t.test('rejects Unix absolute paths without silent conversion', () => {
    assert.strictEqual(sanitizeProjectFilePath('/etc/passwd'), null);
    assert.strictEqual(sanitizeProjectFilePath('/app/src/App.tsx'), null);
    assert.strictEqual(sanitizeProjectFilePath('/root/.bashrc'), null);
    assert.strictEqual(sanitizeProjectFilePath('/var/log/syslog'), null);
  });

  await t.test('rejects Windows drive absolute paths without silent conversion', () => {
    assert.strictEqual(sanitizeProjectFilePath('C:/app/src/App.tsx'), null);
    assert.strictEqual(sanitizeProjectFilePath('c:\\Windows\\System32\\cmd.exe'), null);
    assert.strictEqual(sanitizeProjectFilePath('D:/secret.env'), null);
    assert.strictEqual(sanitizeProjectFilePath('e:\\data\\db.sqlite'), null);
  });

  await t.test('rejects UNC paths without silent conversion', () => {
    assert.strictEqual(sanitizeProjectFilePath('//server/share/file.tsx'), null);
    assert.strictEqual(sanitizeProjectFilePath('\\\\server\\share\\file.tsx'), null);
    assert.strictEqual(sanitizeProjectFilePath('//localhost/c$/Windows'), null);
  });

  await t.test('rejects directory traversal sequences', () => {
    assert.strictEqual(sanitizeProjectFilePath('../secret.env'), null);
    assert.strictEqual(sanitizeProjectFilePath('../../etc/passwd'), null);
    assert.strictEqual(sanitizeProjectFilePath('src/../../root.ts'), null);
    assert.strictEqual(sanitizeProjectFilePath('components/../../../escape.js'), null);
    assert.strictEqual(sanitizeProjectFilePath('src/nested/../../..'), null);
  });

  await t.test('rejects null byte injection and malformed inputs', () => {
    assert.strictEqual(sanitizeProjectFilePath('src/\0evil.ts'), null);
    assert.strictEqual(sanitizeProjectFilePath('src/App.tsx\0.png'), null);
    assert.strictEqual(sanitizeProjectFilePath(''), null);
    assert.strictEqual(sanitizeProjectFilePath('   '), null);
    assert.strictEqual(sanitizeProjectFilePath(null as any), null);
    assert.strictEqual(sanitizeProjectFilePath(undefined as any), null);
  });

  await t.test('accepts and normalizes valid relative paths', () => {
    assert.strictEqual(sanitizeProjectFilePath('src/App.tsx'), 'src/App.tsx');
    assert.strictEqual(sanitizeProjectFilePath('src/components/Button.tsx'), 'src/components/Button.tsx');
    assert.strictEqual(sanitizeProjectFilePath('src\\nested\\file.ts'), 'src/nested/file.ts');
    assert.strictEqual(sanitizeProjectFilePath('./src/main.tsx'), 'src/main.tsx');
    assert.strictEqual(sanitizeProjectFilePath('public/index.html'), 'public/index.html');
  });
});

test('Path Security: ExecutionAdapter.sanitizeFilePath test matrix', async (t) => {
  await t.test('rejects Unix absolute paths', () => {
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath('/etc/shadow').valid, false);
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath('/bin/sh').valid, false);
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath('/tmp/arbitrary.txt').valid, false);
    assert.match(ExecutionAdapter.sanitizeFilePath('/etc/shadow').error || '', /Absolute file paths/);
  });

  await t.test('rejects Windows drive absolute paths', () => {
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath('C:\\Windows\\win.ini').valid, false);
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath('D:/passwords.txt').valid, false);
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath('z:\\network\\drive').valid, false);
    assert.match(ExecutionAdapter.sanitizeFilePath('C:/app').error || '', /Windows drive paths/);
  });

  await t.test('rejects UNC paths', () => {
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath('\\\\192.168.1.1\\share\\test').valid, false);
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath('//remote/share/file').valid, false);
    assert.match(ExecutionAdapter.sanitizeFilePath('//remote/share').error || '', /UNC network paths/);
  });

  await t.test('rejects traversal attempts beyond workspace boundary', () => {
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath('../escape.env').valid, false);
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath('subdir/../../escape.env').valid, false);
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath('..').valid, false);
    assert.match(ExecutionAdapter.sanitizeFilePath('../escape.env').error || '', /Directory traversal/);
  });

  await t.test('rejects null bytes and empty paths', () => {
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath('foo\0bar.txt').valid, false);
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath('').valid, false);
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath('   ').valid, false);
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath(null as any).valid, false);
    assert.strictEqual(ExecutionAdapter.sanitizeFilePath(undefined as any).valid, false);
  });

  await t.test('accepts valid relative paths within workspace directory', () => {
    const res1 = ExecutionAdapter.sanitizeFilePath('src/components/Header.tsx');
    assert.strictEqual(res1.valid, true);
    assert.strictEqual(res1.cleanPath, 'src/components/Header.tsx');

    const res2 = ExecutionAdapter.sanitizeFilePath('src\\utils\\helper.ts');
    assert.strictEqual(res2.valid, true);
    assert.strictEqual(res2.cleanPath, 'src/utils/helper.ts');
  });
});
