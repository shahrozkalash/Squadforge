import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
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
} from '../server/pathValidator.js';

test('Path Validator: isPathScopedWithin verification', async (t) => {
  const tmpRoot = path.join(os.tmpdir(), `test_workspace_${Date.now()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });

  t.after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  await t.test('accepts genuine subpaths strictly inside workspace', () => {
    assert.equal(isPathScopedWithin(tmpRoot, 'src/App.tsx'), true);
    assert.equal(isPathScopedWithin(tmpRoot, 'package.json'), true);
    assert.equal(isPathScopedWithin(tmpRoot, 'app/src/main/AndroidManifest.xml'), true);
    assert.equal(isPathScopedWithin(tmpRoot, path.join(tmpRoot, 'src/App.tsx')), true);
  });

  await t.test('strictly rejects directory traversal attempts escaping workspace', () => {
    assert.equal(isPathScopedWithin(tmpRoot, '../outside.txt'), false);
    assert.equal(isPathScopedWithin(tmpRoot, 'src/../../outside.txt'), false);
    assert.equal(isPathScopedWithin(tmpRoot, '..'), false);
    assert.equal(isPathScopedWithin(tmpRoot, '..\\escape.txt'), false);
  });

  await t.test('strictly rejects absolute paths outside workspace', () => {
    assert.equal(isPathScopedWithin(tmpRoot, '/etc/passwd'), false);
    assert.equal(isPathScopedWithin(tmpRoot, '/var/log/syslog'), false);
    assert.equal(isPathScopedWithin(tmpRoot, 'C:\\Windows\\System32'), false);
    assert.equal(isPathScopedWithin(tmpRoot, 'd:/secret.env'), false);
  });

  await t.test('strictly rejects UNC paths', () => {
    assert.equal(isPathScopedWithin(tmpRoot, '//network/share/file.txt'), false);
    assert.equal(isPathScopedWithin(tmpRoot, '\\\\network\\share\\file.txt'), false);
  });

  await t.test('strictly rejects null bytes', () => {
    assert.equal(isPathScopedWithin(tmpRoot, 'src/App\0.tsx'), false);
    assert.equal(isPathScopedWithin(tmpRoot, '\0/etc/passwd'), false);
  });

  await t.test('strictly rejects empty or malformed inputs', () => {
    assert.equal(isPathScopedWithin(tmpRoot, ''), false);
    assert.equal(isPathScopedWithin(tmpRoot, '   '), false);
    assert.equal(isPathScopedWithin(null as any, 'src/App.tsx'), false);
    assert.equal(isPathScopedWithin(tmpRoot, null as any), false);
  });
});

test('Path Validator: sanitizeWorkspacePath & assertSafeWorkspacePath', async (t) => {
  const tmpRoot = path.join(os.tmpdir(), `test_sanitize_${Date.now()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });

  t.after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  await t.test('accepts valid nested paths and normalizes slashes', () => {
    const res = sanitizeWorkspacePath(tmpRoot, 'src\\components\\Header.tsx');
    assert.equal(res.valid, true);
    assert.equal(res.cleanRelativePath, 'src/components/Header.tsx');
    assert.equal(res.absolutePath, path.resolve(tmpRoot, 'src/components/Header.tsx'));

    const direct = assertSafeWorkspacePath(tmpRoot, 'app/src/main/java/Main.kt');
    assert.equal(direct, path.resolve(tmpRoot, 'app/src/main/java/Main.kt'));
  });

  await t.test('rejects Unix absolute paths', () => {
    const res = sanitizeWorkspacePath(tmpRoot, '/etc/shadow');
    assert.equal(res.valid, false);
    assert.match(res.error || '', /Absolute paths forbidden/i);

    assert.throws(() => {
      assertSafeWorkspacePath(tmpRoot, '/etc/passwd');
    }, /Absolute paths forbidden in workspace/i);
  });

  await t.test('rejects Windows drive absolute paths', () => {
    const res = sanitizeWorkspacePath(tmpRoot, 'C:\\Windows\\win.ini');
    assert.equal(res.valid, false);
    assert.match(res.error || '', /Windows drive letters forbidden/i);

    assert.throws(() => {
      assertSafeWorkspacePath(tmpRoot, 'D:/secrets.env');
    }, /Windows drive letters forbidden in workspace/i);
  });

  await t.test('rejects UNC network paths', () => {
    const res = sanitizeWorkspacePath(tmpRoot, '\\\\remote\\share\\exploit');
    assert.equal(res.valid, false);
    assert.match(res.error || '', /UNC network paths forbidden/i);

    assert.throws(() => {
      assertSafeWorkspacePath(tmpRoot, '//remote/share/exploit');
    }, /UNC network paths forbidden in workspace/i);
  });

  await t.test('rejects parent traversal escaping workspace', () => {
    const res1 = sanitizeWorkspacePath(tmpRoot, '../secret.key');
    assert.equal(res1.valid, false);
    assert.match(res1.error || '', /Path traversal escapes workspace/i);

    const res2 = sanitizeWorkspacePath(tmpRoot, 'src/../../secret.key');
    assert.equal(res2.valid, false);
    assert.match(res2.error || '', /Path traversal escapes workspace/i);

    assert.throws(() => {
      assertSafeWorkspacePath(tmpRoot, '..\\secret.key');
    }, /Path traversal escapes workspace/i);
  });

  await t.test('rejects null byte injection', () => {
    const res = sanitizeWorkspacePath(tmpRoot, 'src/App.tsx\0.png');
    assert.equal(res.valid, false);
    assert.match(res.error || '', /Null bytes forbidden/i);

    assert.throws(() => {
      assertSafeWorkspacePath(tmpRoot, 'src/\0exploit.ts');
    }, /Null bytes forbidden in path/i);
  });

  await t.test('rejects symlinks that point outside workspace boundary', () => {
    const outsideTarget = path.join(os.tmpdir(), `test_outside_${Date.now()}`);
    fs.mkdirSync(outsideTarget, { recursive: true });
    const outsideFile = path.join(outsideTarget, 'secret.txt');
    fs.writeFileSync(outsideFile, 'TOP_SECRET');

    const symlinkPath = path.join(tmpRoot, 'leak_symlink');
    try {
      fs.symlinkSync(outsideTarget, symlinkPath, 'dir');

      // The symlink file itself is detected
      const res = sanitizeWorkspacePath(tmpRoot, 'leak_symlink');
      assert.equal(res.valid, false);
      assert.match(res.error || '', /Symbolic links are forbidden|Symlink target escapes/i);

      assert.throws(() => {
        assertSafeWorkspacePath(tmpRoot, 'leak_symlink');
      }, /Symbolic links are forbidden/i);
    } finally {
      try {
        fs.unlinkSync(symlinkPath);
        fs.rmSync(outsideTarget, { recursive: true, force: true });
      } catch {
        // cleanup
      }
    }
  });
});

test('Path Validator: Artifact Scoping (validateArtifactScope & assertScopedArtifactPath)', async (t) => {
  const artifactsBase = path.join(os.tmpdir(), `test_artifacts_${Date.now()}`);
  fs.mkdirSync(artifactsBase, { recursive: true });

  t.after(() => {
    try {
      fs.rmSync(artifactsBase, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  await t.test('correctly scopes legitimate artifacts within build directory', () => {
    const buildId = 'bld_123456';
    const filename = 'fittrack-debug.apk';

    const res = validateArtifactScope(artifactsBase, buildId, filename);
    assert.equal(res.valid, true);
    assert.equal(res.filename, filename);
    assert.equal(res.resolvedPath, path.resolve(artifactsBase, buildId, filename));
    assert.equal(res.relativePath, `${buildId}/${filename}`);

    const safePath = assertScopedArtifactPath(artifactsBase, buildId, filename);
    assert.equal(safePath, path.resolve(artifactsBase, buildId, filename));
  });

  await t.test('rejects path traversal in artifact filename', () => {
    const buildId = 'bld_123456';

    assert.equal(validateArtifactScope(artifactsBase, buildId, '../escape.apk').valid, false);
    assert.equal(validateArtifactScope(artifactsBase, buildId, 'subdir/app.apk').valid, false);
    assert.equal(validateArtifactScope(artifactsBase, buildId, '..\\escape.apk').valid, false);
    assert.equal(validateArtifactScope(artifactsBase, buildId, 'app.apk\0.png').valid, false);

    assert.throws(() => {
      assertScopedArtifactPath(artifactsBase, buildId, '../other_build/target.apk');
    }, /Security Violation/i);
  });

  await t.test('rejects path traversal and invalid characters in scopeId / buildId', () => {
    const filename = 'app-release.aab';

    assert.equal(validateArtifactScope(artifactsBase, '../bld_escape', filename).valid, false);
    assert.equal(validateArtifactScope(artifactsBase, 'bld/nested', filename).valid, false);
    assert.equal(validateArtifactScope(artifactsBase, 'bld\\nested', filename).valid, false);
    assert.equal(validateArtifactScope(artifactsBase, 'bld\0inject', filename).valid, false);

    assert.throws(() => {
      assertScopedArtifactPath(artifactsBase, '../../etc', filename);
    }, /Security Violation/i);
  });

  await t.test('scopeArtifactPath handles both direct and scoped artifact operations', () => {
    // 2-argument usage:
    const res2 = scopeArtifactPath(artifactsBase, 'production-bundle.zip');
    assert.equal(res2.valid, true);
    assert.equal(res2.resolvedPath, path.resolve(artifactsBase, 'production-bundle.zip'));

    // 2-argument traversal attempt:
    const resTraverse = scopeArtifactPath(artifactsBase, '../escape.zip');
    assert.equal(resTraverse.valid, false);
    assert.match(resTraverse.error || '', /escapes base directory|traversal sequence/i);

    // 3-argument usage:
    const res3 = scopeArtifactPath(artifactsBase, 'fittrack-release.aab', 'bld_789');
    assert.equal(res3.valid, true);
    assert.equal(res3.resolvedPath, path.resolve(artifactsBase, 'bld_789', 'fittrack-release.aab'));
  });
});

test('Path Validator: Filename and ID Validation Helpers', async (t) => {
  await t.test('validateArtifactFilename allows legitimate build artifact extensions', () => {
    assert.equal(validateArtifactFilename('app-debug.apk'), true);
    assert.equal(validateArtifactFilename('bundle-release.aab'), true);
    assert.equal(validateArtifactFilename('deployment_bundle.zip'), true);
    assert.equal(validateArtifactFilename('build-log.log'), true);
    assert.equal(validateArtifactFilename('metadata.json'), true);

    // Custom allowed extensions:
    assert.equal(validateArtifactFilename('app.apk', ['apk', 'aab']), true);
    assert.equal(validateArtifactFilename('app.zip', ['apk', 'aab']), false);

    // Traversal and forbidden names:
    assert.equal(validateArtifactFilename('../app.apk'), false);
    assert.equal(validateArtifactFilename('dir/app.apk'), false);
    assert.equal(validateArtifactFilename('malware.exe'), false);
    assert.equal(validateArtifactFilename('exploit.sh'), false);
    assert.equal(validateArtifactFilename(''), false);
  });

  await t.test('validateBuildId strictly rejects traversal and invalid identifiers', () => {
    assert.equal(validateBuildId('bld_1794031283900'), true);
    assert.equal(validateBuildId('build-456_def'), true);

    assert.equal(validateBuildId('../escape'), false);
    assert.equal(validateBuildId('bld/nested'), false);
    assert.equal(validateBuildId('bld\\nested'), false);
    assert.equal(validateBuildId('bld\0inject'), false);
    assert.equal(validateBuildId(''), false);
  });

  await t.test('sanitizeProjectFilePath normalizes valid paths and rejects escapes', () => {
    assert.equal(sanitizeProjectFilePath('src/App.tsx'), 'src/App.tsx');
    assert.equal(sanitizeProjectFilePath('src\\utils\\path.ts'), 'src/utils/path.ts');
    assert.equal(sanitizeProjectFilePath('./src/main.tsx'), 'src/main.tsx');

    assert.equal(sanitizeProjectFilePath('/etc/passwd'), null);
    assert.equal(sanitizeProjectFilePath('C:\\Windows\\System32'), null);
    assert.equal(sanitizeProjectFilePath('../outside.txt'), null);
    assert.equal(sanitizeProjectFilePath('//network/share'), null);
    assert.equal(sanitizeProjectFilePath('src/\0evil.ts'), null);
  });
});
