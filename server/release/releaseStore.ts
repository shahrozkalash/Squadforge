import * as fs from 'fs';
import * as path from 'path';
import type { PackageResult, ReleaseManifest } from './packager.js';
import { compareSemVer, parseSemVer } from './versioning.js';

/**
 * Phase 23: the release store — versioned artifacts, channels and
 * rollback. Layout:
 *   <root>/<app>/versions/<version>/ (package.zip, manifest.json,
 *     RELEASE_NOTES.md, build.log)
 *   <root>/<app>/channels/<channel>.json (pointer to current version)
 * Publishing moves the channel pointer; rollback moves it back to
 * the highest earlier version that still exists in the store. The
 * update feed is derived from the pointer + manifest, never edited
 * by hand, so it cannot drift from the artifacts.
 */

export interface StoredRelease {
  version: string;
  dir: string;
  manifest: ReleaseManifest;
  packageSha256: string;
  packageSizeBytes: number;
}

export interface UpdateFeed {
  appName: string;
  channel: string;
  version: string;
  publishedAt: string;
  packageSizeBytes: number;
  packageSha256: string;
  releaseNotes: string;
  signingStatus: string;
}

export class ReleaseStore {
  constructor(private readonly root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  private appDir(appName: string): string {
    const safe = appName.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!safe) throw new Error('Invalid app name');
    return path.join(this.root, safe);
  }

  private versionDir(appName: string, version: string): string {
    parseSemVer(version);
    return path.join(this.appDir(appName), 'versions', version);
  }

  private channelPath(appName: string, channel: string): string {
    const safe = channel.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) throw new Error('Invalid channel name');
    return path.join(this.appDir(appName), 'channels', `${safe}.json`);
  }

  public publish(result: PackageResult): StoredRelease {
    const { manifest } = result;
    const dir = this.versionDir(manifest.appName, manifest.releaseVersion);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(result.packagePath, path.join(dir, 'package.zip'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(dir, 'RELEASE_NOTES.md'), `# ${manifest.appName} ${manifest.releaseVersion}\n\n${manifest.releaseNotes}\n`);
    fs.writeFileSync(path.join(dir, 'build.log'), result.buildLog);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ sha256: result.packageSha256, sizeBytes: result.packageSizeBytes }, null, 2)
    );
    // Move the channel pointer
    const pointerPath = this.channelPath(manifest.appName, manifest.channel);
    fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
    fs.writeFileSync(pointerPath, JSON.stringify({ version: manifest.releaseVersion, updatedAt: new Date().toISOString() }, null, 2));
    return this.getRelease(manifest.appName, manifest.releaseVersion)!;
  }

  public getRelease(appName: string, version: string): StoredRelease | null {
    const dir = this.versionDir(appName, version);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return {
      version,
      dir,
      manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
      packageSha256: meta.sha256,
      packageSizeBytes: meta.sizeBytes
    };
  }

  public listVersions(appName: string): string[] {
    const versionsRoot = path.join(this.appDir(appName), 'versions');
    if (!fs.existsSync(versionsRoot)) return [];
    return fs
      .readdirSync(versionsRoot)
      .filter((v) => {
        try { parseSemVer(v); return true; } catch { return false; }
      })
      .sort((a, b) => compareSemVer(parseSemVer(a), parseSemVer(b)));
  }

  public channelVersion(appName: string, channel: string): string | null {
    const pointerPath = this.channelPath(appName, channel);
    if (!fs.existsSync(pointerPath)) return null;
    return JSON.parse(fs.readFileSync(pointerPath, 'utf8')).version as string;
  }

  /** Move the channel back to the highest stored version below the current one. */
  public rollback(appName: string, channel: string): StoredRelease {
    const current = this.channelVersion(appName, channel);
    if (!current) throw new Error(`Channel ${channel} has no current release for ${appName}`);
    const earlier = this.listVersions(appName).filter(
      (v) => compareSemVer(parseSemVer(v), parseSemVer(current)) < 0
    );
    if (earlier.length === 0) throw new Error(`No earlier version stored for ${appName} — nothing to roll back to`);
    const target = earlier[earlier.length - 1];
    const pointerPath = this.channelPath(appName, channel);
    fs.writeFileSync(pointerPath, JSON.stringify({ version: target, updatedAt: new Date().toISOString(), rolledBackFrom: current }, null, 2));
    return this.getRelease(appName, target)!;
  }

  public feed(appName: string, channel: string): UpdateFeed | null {
    const version = this.channelVersion(appName, channel);
    if (!version) return null;
    const release = this.getRelease(appName, version);
    if (!release) return null;
    return {
      appName,
      channel,
      version,
      publishedAt: release.manifest.createdAt,
      packageSizeBytes: release.packageSizeBytes,
      packageSha256: release.packageSha256,
      releaseNotes: release.manifest.releaseNotes,
      signingStatus: release.manifest.signing.status
    };
  }
}
