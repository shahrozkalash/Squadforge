import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import { parseSemVer, formatSemVer, compareSemVer, bumpSemVer, stampCsprojVersion, readCsprojVersion } from '../server/release/versioning.js';
import { generateIconIco, validateIco } from '../server/release/iconFactory.js';
import { detectSigningTool, hasAuthenticodeSignature, peCertificateTable, signPeFile } from '../server/release/signing.js';
import { ReleasePackager, installerScripts, type ReleaseMetadata } from '../server/release/packager.js';
import { ReleaseStore } from '../server/release/releaseStore.js';
import { validatePackage } from '../server/release/packageValidator.js';
import { DesktopProjectGenerator } from '../server/desktop/desktopProjectGenerator.js';

const BASE = path.join(process.cwd(), '.tmp_release_tests');

function freshDir(name: string): string {
  const dir = path.join(BASE, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const meta = (version: string, extra: Partial<ReleaseMetadata> = {}): ReleaseMetadata => ({
  appName: 'FitTrack',
  version,
  publisher: 'Sheroz',
  description: 'Fitness tracker',
  channel: 'stable',
  selfContained: false,
  releaseNotes: 'Release notes here.',
  ...extra
});

describe('SquadForge Phase 23: Desktop Release and Distribution Test Suite', () => {
  before(() => fs.mkdirSync(BASE, { recursive: true }));
  after(() => fs.rmSync(BASE, { recursive: true, force: true }));

  describe('1. Versioning', () => {
    test('1.1 Semver parse/compare/bump; csproj stamping', () => {
      assert.equal(formatSemVer(bumpSemVer(parseSemVer('1.2.3'), 'minor')), '1.3.0');
      assert.equal(formatSemVer(bumpSemVer(parseSemVer('1.2.3'), 'major')), '2.0.0');
      assert.ok(compareSemVer(parseSemVer('1.10.0'), parseSemVer('1.9.0')) > 0);
      assert.ok(compareSemVer(parseSemVer('1.0.0'), parseSemVer('1.0.0-beta')) > 0);
      assert.throws(() => parseSemVer('1.2'), /Invalid semantic version/);
      const csproj = '<Project><PropertyGroup><Version>0.1.0</Version></PropertyGroup></Project>';
      assert.equal(readCsprojVersion(stampCsprojVersion(csproj, '2.0.0')), '2.0.0');
      const bare = '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>';
      assert.equal(readCsprojVersion(stampCsprojVersion(bare, '1.0.0')), '1.0.0');
    });
  });

  describe('2. Icons', () => {
    test('2.1 Generated ICO is structurally valid; corrupt data rejected', () => {
      const ico = generateIconIco('FitTrack', 64);
      const check = validateIco(ico);
      assert.equal(check.valid, true, check.error);
      assert.deepEqual(check.sizes, [64]);
      assert.equal(validateIco(Buffer.from('not an icon at all')).valid, false);
      assert.equal(validateIco(ico.subarray(0, 10)).valid, false);
    });
  });

  describe('3. Signing honesty', () => {
    test('3.1 No fabricated signatures: detection, unsigned PE, statuses', async () => {
      const detection = detectSigningTool();
      // This host has no osslsigncode (the NSS signtool does not count).
      assert.equal(detection.tool, null);
      assert.match(detection.detail, /No Authenticode signer/);
      const notRequested = await signPeFile('/nonexistent.exe', undefined, undefined);
      assert.equal(notRequested.status, 'not-requested');
      const unavailable = await signPeFile('/nonexistent.exe', '/tmp/cert.pfx', 'pw');
      assert.equal(unavailable.status, 'unavailable');
    });
  });

  describe('4. Installer scripts', () => {
    test('4.1 Scripts contain real install/uninstall logic and metadata', () => {
      const scripts = installerScripts(meta('1.4.2'));
      assert.match(scripts['install.ps1'], /LOCALAPPDATA/);
      assert.match(scripts['install.ps1'], /Uninstall\\FitTrack/);
      assert.match(scripts['install.ps1'], /DisplayVersion.*1\.4\.2/);
      assert.match(scripts['uninstall.ps1'], /Remove-Item/);
      assert.match(scripts['installer.iss'], /AppVersion=1\.4\.2/);
    });
  });

  describe('5. End-to-end release flow (real publish + package + store)', () => {
    test('5.1 Publish, package, validate, channel, update, rollback', async () => {
      const workspace = freshDir('project');
      const config = DesktopProjectGenerator.getDefaultConfig('FitTrack', 'FitTrack');
      const files = DesktopProjectGenerator.generateProjectFiles(config);
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(workspace, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
      const packager = new ReleasePackager();
      const { publishDir, buildLog } = await packager.publishProject(workspace, meta('1.0.0'));
      assert.match(buildLog, /dotnet publish/);
      assert.ok(fs.existsSync(path.join(publishDir, 'FitTrack.exe')));

      // The published exe is unsigned — the signing check must agree
      const exeBuffer = fs.readFileSync(path.join(publishDir, 'FitTrack.exe'));
      assert.equal(hasAuthenticodeSignature(exeBuffer), false);
      assert.equal(peCertificateTable(exeBuffer)?.size ?? 0, 0);

      const store = new ReleaseStore(freshDir('store'));
      const pkg1 = path.join(workspace, 'FitTrack-1.0.0.zip');
      const result1 = await packager.packageRelease(publishDir, meta('1.0.0'), buildLog, pkg1);
      assert.equal(result1.manifest.signing.status, 'not-requested');
      assert.equal(result1.manifest.exe.pe.isPeFile, true);
      assert.ok(result1.manifest.files.some((f) => f.path === 'FitTrack.exe'));
      assert.ok(result1.manifest.files.some((f) => f.path === 'FitTrack.dll'));
      assert.ok(result1.packageSizeBytes > 10_000, `package suspiciously small: ${result1.packageSizeBytes}`);
      store.publish(result1);

      const validation = await validatePackage(path.join(store.getRelease('FitTrack', '1.0.0')!.dir, 'package.zip'));
      assert.equal(validation.valid, true, JSON.stringify(validation.steps.filter((s) => !s.ok)));
      assert.ok(validation.steps.every((s) => s.ok));

      let feed = store.feed('FitTrack', 'stable');
      assert.equal(feed?.version, '1.0.0');
      assert.equal(feed?.packageSha256, result1.packageSha256);

      // Version 1.1.0 (same publish output, new package + manifest)
      const result2 = await packager.packageRelease(publishDir, meta('1.1.0', { releaseNotes: 'Bug fixes.' }), buildLog, path.join(workspace, 'FitTrack-1.1.0.zip'));
      store.publish(result2);
      assert.deepEqual(store.listVersions('FitTrack'), ['1.0.0', '1.1.0']);
      feed = store.feed('FitTrack', 'stable');
      assert.equal(feed?.version, '1.1.0');
      assert.equal(feed?.releaseNotes, 'Bug fixes.');

      // Rollback returns the channel to 1.0.0; a second rollback is impossible
      const rolled = store.rollback('FitTrack', 'stable');
      assert.equal(rolled.version, '1.0.0');
      assert.equal(store.feed('FitTrack', 'stable')?.version, '1.0.0');
      assert.throws(() => store.rollback('FitTrack', 'stable'), /nothing to roll back/);

      // Build logs and notes are preserved in the store
      const storedDir = store.getRelease('FitTrack', '1.0.0')!.dir;
      assert.match(fs.readFileSync(path.join(storedDir, 'build.log'), 'utf8'), /dotnet publish/);
      assert.match(fs.readFileSync(path.join(storedDir, 'RELEASE_NOTES.md'), 'utf8'), /Release notes here/);
    });

    test('5.2 Packaging refuses a directory without the executable', async () => {
      const empty = freshDir('empty-publish');
      const packager = new ReleasePackager();
      await assert.rejects(() => packager.packageRelease(empty, meta('1.0.0'), 'log', path.join(empty, 'x.zip')), /not found/);
    });
  });

  describe('6. Failure recovery / tamper detection', () => {
    test('6.1 A tampered package fails validation at the hash step', async () => {
      const workspace = freshDir('tamper-project');
      const config = DesktopProjectGenerator.getDefaultConfig('FitTrack', 'FitTrack');
      for (const [rel, content] of Object.entries(DesktopProjectGenerator.generateProjectFiles(config))) {
        const abs = path.join(workspace, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
      const packager = new ReleasePackager();
      const { publishDir, buildLog } = await packager.publishProject(workspace, meta('1.0.0'));
      const good = path.join(workspace, 'good.zip');
      await packager.packageRelease(publishDir, meta('1.0.0'), buildLog, good);
      assert.equal((await validatePackage(good)).valid, true);

      // Tamper: rewrite a packaged file with different bytes
      const zip = await JSZip.loadAsync(fs.readFileSync(good));
      zip.file('app/FitTrack.dll', 'tampered-content');
      const tamperedPath = path.join(workspace, 'tampered.zip');
      fs.writeFileSync(tamperedPath, await zip.generateAsync({ type: 'nodebuffer' }));
      const validation = await validatePackage(tamperedPath);
      assert.equal(validation.valid, false);
      assert.equal(validation.steps.find((s) => s.name === 'file-hashes')?.ok, false);
    });
  });
});
