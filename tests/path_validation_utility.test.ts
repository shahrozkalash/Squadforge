import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  isPathScopedWithin,
  sanitizeWorkspacePath,
  assertSafeWorkspacePath,
  validateArtifactScope,
  assertScopedArtifactPath,
  scopeArtifactPath,
  validateArtifactFilename,
  validateBuildId,
  sanitizeProjectFilePath
} from '../server/pathSecurity.js';
import {
  storeArtifactBuffer,
  getArtifactBuffer
} from '../server/android/androidRoutes.js';

test('Path Validation Utility - isPathScopedWithin', async (t) => {
  const baseDir = path.resolve('/tmp/squadforge_test_base');

  await t.test('accepts direct and nested child paths', () => {
    assert.strictEqual(isPathScopedWithin(baseDir, path.join(baseDir, 'file.txt')), true);
    assert.strictEqual(isPathScopedWithin(baseDir, path.join(baseDir, 'sub', 'dir', 'file.txt')), true);
    assert.strictEqual(isPathScopedWithin(baseDir, 'relative/file.txt'), true);
  });

  await t.test('rejects paths escaping baseDir via traversal', () => {
    assert.strictEqual(isPathScopedWithin(baseDir, path.join(baseDir, '..', 'escape.txt')), false);
    assert.strictEqual(isPathScopedWithin(baseDir, '../escape.txt'), false);
    assert.strictEqual(isPathScopedWithin(baseDir, 'sub/../../escape.txt'), false);
  });

  await t.test('rejects null bytes, Windows drives, UNC paths, and empty inputs', () => {
    assert.strictEqual(isPathScopedWithin(baseDir, 'sub/\0bad.txt'), false);
    assert.strictEqual(isPathScopedWithin(baseDir, 'C:\\Windows\\file.txt'), false);
    assert.strictEqual(isPathScopedWithin(baseDir, '//server/share/file.txt'), false);
    assert.strictEqual(isPathScopedWithin('', 'file.txt'), false);
    assert.strictEqual(isPathScopedWithin(baseDir, ''), false);
  });
});

test('Path Validation Utility - sanitizeWorkspacePath', async (t) => {
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_workspace_'));

  try {
    // Populate some workspace directories and files
    fs.mkdirSync(path.join(tmpWorkspace, 'app', 'src', 'main'), { recursive: true });
    fs.writeFileSync(path.join(tmpWorkspace, 'app', 'src', 'main', 'AndroidManifest.xml'), '<manifest/>');
    fs.writeFileSync(path.join(tmpWorkspace, 'build.gradle.kts'), '// build');

    await t.test('allows valid relative workspace paths and returns clean relative path', () => {
      const res1 = sanitizeWorkspacePath(tmpWorkspace, 'app/src/main/AndroidManifest.xml');
      assert.strictEqual(res1.valid, true);
      assert.strictEqual(res1.cleanRelativePath, 'app/src/main/AndroidManifest.xml');
      assert.strictEqual(res1.absolutePath, path.join(tmpWorkspace, 'app/src/main/AndroidManifest.xml'));

      const res2 = sanitizeWorkspacePath(tmpWorkspace, 'build.gradle.kts');
      assert.strictEqual(res2.valid, true);
      assert.strictEqual(res2.cleanRelativePath, 'build.gradle.kts');
    });

    await t.test('rejects absolute Unix paths', () => {
      const res = sanitizeWorkspacePath(tmpWorkspace, '/etc/passwd');
      assert.strictEqual(res.valid, false);
      assert.match(res.error || '', /Absolute paths forbidden in workspace/);
    });

    await t.test('rejects Windows drive letters', () => {
      const res1 = sanitizeWorkspacePath(tmpWorkspace, 'C:\\Windows\\System32');
      assert.strictEqual(res1.valid, false);
      assert.match(res1.error || '', /Windows drive letters forbidden/);

      const res2 = sanitizeWorkspacePath(tmpWorkspace, 'D:/app/file.kt');
      assert.strictEqual(res2.valid, false);
      assert.match(res2.error || '', /Windows drive letters forbidden/);
    });

    await t.test('rejects UNC network paths', () => {
      const res1 = sanitizeWorkspacePath(tmpWorkspace, '//server/share/file');
      assert.strictEqual(res1.valid, false);
      assert.match(res1.error || '', /UNC network paths forbidden/);

      const res2 = sanitizeWorkspacePath(tmpWorkspace, '\\\\server\\share\\file');
      assert.strictEqual(res2.valid, false);
      assert.match(res2.error || '', /UNC network paths forbidden/);
    });

    await t.test('rejects null byte injection', () => {
      const res = sanitizeWorkspacePath(tmpWorkspace, 'app/main\0.kt');
      assert.strictEqual(res.valid, false);
      assert.match(res.error || '', /Null bytes forbidden/);
    });

    await t.test('rejects directory traversal sequences', () => {
      const res1 = sanitizeWorkspacePath(tmpWorkspace, '../outside.txt');
      assert.strictEqual(res1.valid, false);
      assert.match(res1.error || '', /Path traversal escapes workspace/);

      const res2 = sanitizeWorkspacePath(tmpWorkspace, 'app/../../outside.txt');
      assert.strictEqual(res2.valid, false);
      assert.match(res2.error || '', /Path traversal escapes workspace/);

      const res3 = sanitizeWorkspacePath(tmpWorkspace, '..\\outside.txt');
      assert.strictEqual(res3.valid, false);
      assert.match(res3.error || '', /Path traversal escapes workspace/);
    });

    await t.test('rejects symlinks that point outside the workspace', () => {
      const outsideTarget = path.join(os.tmpdir(), 'sq_outside_target.txt');
      fs.writeFileSync(outsideTarget, 'classified');

      const symlinkPath = path.join(tmpWorkspace, 'bad_link.txt');
      try {
        fs.symlinkSync(outsideTarget, symlinkPath);
        const res = sanitizeWorkspacePath(tmpWorkspace, 'bad_link.txt');
        assert.strictEqual(res.valid, false);
        assert.match(res.error || '', /Symbolic links are forbidden in workspace|Symlink target escapes workspace/);
      } finally {
        if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
        if (fs.existsSync(outsideTarget)) fs.unlinkSync(outsideTarget);
      }
    });

    await t.test('assertSafeWorkspacePath throws Security Violation for invalid paths', () => {
      assert.throws(
        () => assertSafeWorkspacePath(tmpWorkspace, '/etc/shadow'),
        /Security Violation.*Absolute paths forbidden/
      );
      assert.throws(
        () => assertSafeWorkspacePath(tmpWorkspace, '../escape.txt'),
        /Security Violation.*Path traversal escapes workspace/
      );
      assert.throws(
        () => assertSafeWorkspacePath(tmpWorkspace, 'app\0foo'),
        /Security Violation.*Null bytes forbidden/
      );

      // Succeeded call returns verified absolute path
      const validAbs = assertSafeWorkspacePath(tmpWorkspace, 'build.gradle.kts');
      assert.strictEqual(validAbs, path.join(tmpWorkspace, 'build.gradle.kts'));
    });
  } finally {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
});

test('Path Validation Utility - validateArtifactScope & assertScopedArtifactPath', async (t) => {
  const artifactsBase = path.resolve('/tmp/squadforge_artifacts_root');

  await t.test('allows valid scopeId and filename inside artifacts base', () => {
    const res = validateArtifactScope(artifactsBase, 'build_123', 'app-release.apk');
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.resolvedPath, path.join(artifactsBase, 'build_123', 'app-release.apk'));
    assert.strictEqual(res.relativePath, 'build_123/app-release.apk');

    const asserted = assertScopedArtifactPath(artifactsBase, 'build_123', 'app-release.apk');
    assert.strictEqual(asserted, path.join(artifactsBase, 'build_123', 'app-release.apk'));
  });

  await t.test('rejects directory traversal in scopeId', () => {
    const res1 = validateArtifactScope(artifactsBase, '../escaped_build', 'app.apk');
    assert.strictEqual(res1.valid, false);
    assert.match(res1.error || '', /Invalid scope ID format/);

    const res2 = validateArtifactScope(artifactsBase, 'build/nested', 'app.apk');
    assert.strictEqual(res2.valid, false);
    assert.match(res2.error || '', /Invalid scope ID format/);

    assert.throws(
      () => assertScopedArtifactPath(artifactsBase, '..\\other_build', 'app.apk'),
      /Security Violation.*Invalid scope ID format/
    );
  });

  await t.test('rejects path separators and directory traversal in artifact filename', () => {
    const res1 = validateArtifactScope(artifactsBase, 'build_123', '../../etc/passwd');
    assert.strictEqual(res1.valid, false);
    assert.match(res1.error || '', /Invalid artifact filename/);

    const res2 = validateArtifactScope(artifactsBase, 'build_123', 'subdir/app.apk');
    assert.strictEqual(res2.valid, false);
    assert.match(res2.error || '', /Invalid artifact filename/);

    const res3 = validateArtifactScope(artifactsBase, 'build_123', 'subdir\\app.apk');
    assert.strictEqual(res3.valid, false);
    assert.match(res3.error || '', /Invalid artifact filename/);

    assert.throws(
      () => assertScopedArtifactPath(artifactsBase, 'build_123', '../escape.apk'),
      /Security Violation.*Invalid artifact filename/
    );
  });

  await t.test('rejects empty or whitespace inputs', () => {
    assert.strictEqual(validateArtifactScope('', 'build_1', 'app.apk').valid, false);
    assert.strictEqual(validateArtifactScope(artifactsBase, '', 'app.apk').valid, false);
    assert.strictEqual(validateArtifactScope(artifactsBase, 'build_1', '').valid, false);
  });
});

test('Path Validation Utility - scopeArtifactPath & sanitizeProjectFilePath', async (t) => {
  const artifactsBase = path.resolve('/tmp/squadforge_artifacts_root');

  await t.test('scopeArtifactPath safely handles direct filenames and subpaths', () => {
    const direct = scopeArtifactPath(artifactsBase, 'build-123.zip');
    assert.strictEqual(direct.valid, true);
    assert.strictEqual(direct.relativePath, 'build-123.zip');

    const withScope = scopeArtifactPath(artifactsBase, 'app.apk', 'build_456');
    assert.strictEqual(withScope.valid, true);
    assert.strictEqual(withScope.relativePath, 'build_456/app.apk');

    const invalid = scopeArtifactPath(artifactsBase, '../escape.zip');
    assert.strictEqual(invalid.valid, false);
  });

  await t.test('sanitizeProjectFilePath normalizes safe paths and rejects dangerous paths', () => {
    assert.strictEqual(sanitizeProjectFilePath('src/index.ts'), 'src/index.ts');
    assert.strictEqual(sanitizeProjectFilePath('app/src/main/res/values/strings.xml'), 'app/src/main/res/values/strings.xml');
    assert.strictEqual(sanitizeProjectFilePath('/etc/passwd'), null);
    assert.strictEqual(sanitizeProjectFilePath('C:\\Windows\\system.ini'), null);
    assert.strictEqual(sanitizeProjectFilePath('../escaped.ts'), null);
    assert.strictEqual(sanitizeProjectFilePath('src/../../escaped.ts'), null);
    assert.strictEqual(sanitizeProjectFilePath('src/foo\0.ts'), null);
  });
});

test('Artifact Storage Integration - storeArtifactBuffer & getArtifactBuffer security', async (t) => {
  const testBuildId = `test_build_${Date.now()}`;
  const validApk = 'app-release.apk';
  const testPayload = Buffer.from('FAKE_SECURE_TEST_PAYLOAD');

  await t.test('stores and retrieves safely scoped artifact', () => {
    storeArtifactBuffer(testBuildId, validApk, testPayload);
    const retrieved = getArtifactBuffer(testBuildId, validApk);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.toString(), 'FAKE_SECURE_TEST_PAYLOAD');
  });

  await t.test('rejects traversal attempts during store and retrieve', () => {
    assert.throws(
      () => storeArtifactBuffer('../bad_build', 'app.apk', testPayload),
      /Security Violation/
    );

    assert.throws(
      () => storeArtifactBuffer(testBuildId, '../../evil.apk', testPayload),
      /Security Violation/
    );

    assert.strictEqual(getArtifactBuffer('../bad_build', 'app.apk'), undefined);
    assert.strictEqual(getArtifactBuffer(testBuildId, '../../evil.apk'), undefined);
  });

  await t.test('filename and buildId format validators reject injections', () => {
    assert.strictEqual(validateArtifactFilename('valid-1.0.0.apk'), true);
    assert.strictEqual(validateArtifactFilename('valid_release.aab'), true);
    assert.strictEqual(validateArtifactFilename('../escape.apk'), false);
    assert.strictEqual(validateArtifactFilename('escape/sub.apk'), false);
    assert.strictEqual(validateArtifactFilename('escape.sh'), false);
    assert.strictEqual(validateArtifactFilename('escape.apk\0.png'), false);

    assert.strictEqual(validateBuildId('build-123_abc'), true);
    assert.strictEqual(validateBuildId('../build'), false);
    assert.strictEqual(validateBuildId('build/123'), false);
    assert.strictEqual(validateBuildId('build\0'), false);
  });
});
